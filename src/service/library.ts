import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, rmdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Transform, type PassThrough } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { constants as zlib } from 'node:zlib';
import pg from 'pg';
import { ZipFile } from 'yazl';
import type { FastifyBaseLogger } from 'fastify';
import type { ArchiveName, ArchiveProgress, CompressionProgress, PackCandidate, PackExistingResult, PackProgress, Plan, PublishInput, Settings, Template, TemplateDetail } from '../contracts';
import { archiveNames } from '../contracts';
import { nativePath, renderSequencePaths, scanSources, sequencesFor, textureSequenceArchives } from './scanner';
import { restoreDatabaseBackup } from './restore';

const schema = `
  CREATE TABLE IF NOT EXISTS vfx_library (
    singleton boolean PRIMARY KEY DEFAULT TRUE CHECK (singleton), id uuid NOT NULL
  );
  CREATE TABLE IF NOT EXISTS vfx_templates (
    id uuid PRIMARY KEY, version uuid UNIQUE NOT NULL, title text NOT NULL,
    preview text NOT NULL, manifest jsonb NOT NULL, sequences jsonb NOT NULL,
    bytes bigint NOT NULL, files integer NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE TABLE IF NOT EXISTS vfx_tags (key text PRIMARY KEY, name text NOT NULL);
  ALTER TABLE vfx_templates ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
  ALTER TABLE vfx_templates ADD COLUMN IF NOT EXISTS description text NOT NULL DEFAULT '';
  CREATE TABLE IF NOT EXISTS vfx_template_tags (
    template_id uuid REFERENCES vfx_templates(id) ON DELETE CASCADE,
    tag_key text REFERENCES vfx_tags(key), PRIMARY KEY (template_id, tag_key)
  );
  CREATE INDEX IF NOT EXISTS vfx_template_tags_key_idx ON vfx_template_tags(tag_key, template_id);
`;

const tagKey = (name: string) => name.normalize('NFKC').trim().toLowerCase();
const errorFields = (error: unknown) => {
  const value = error as NodeJS.ErrnoException;
  return {errorCode: value.code ?? 'operation_failed', errorMessage: value.message};
};

class DatabaseSetupError extends Error {
  constructor(message: string, readonly code: string, cause: unknown) { super(message,{cause}); }
}

function setupError(error: unknown, database: string, creating = false): Error {
  if (error instanceof DatabaseSetupError) return error;
  const code = (error as NodeJS.ErrnoException).code;
  const messages: Record<string, string> = {
    '3D000': `数据库「${database}」不存在。请选择已有的专用库，或使用有建库权限的账号初始化。`,
    '28P01': 'PostgreSQL 账号或密码错误，请检查后重试。',
    '28000': 'PostgreSQL 拒绝此账号或连接方式，请检查账号和服务器访问配置。',
    '42501': creating
      ? `当前账号没有创建数据库「${database}」的权限。请使用有建库权限的账号，或先由管理员创建专用库并授权。`
      : `当前账号没有在数据库「${database}」中建立应用表的权限，请检查数据库授权。`,
    'ECONNREFUSED': '无法连接 PostgreSQL，请确认服务已启动并检查主机和端口。',
    'ETIMEDOUT': '连接 PostgreSQL 超时，请检查主机和端口。',
    'ENOTFOUND': '无法找到 PostgreSQL 主机，请检查主机名称。',
  };
  if (code && (messages[code] || /^[0-9A-Z]{5}$/.test(code))) {
    return new DatabaseSetupError(messages[code] ?? `PostgreSQL 初始化失败（${code}）。请查看运行日志。`,code,error);
  }
  return error instanceof Error ? error : new Error('无法初始化模板库');
}

async function createDatabase(config: pg.ClientConfig, database: string, log: FastifyBaseLogger) {
  if (!/^[a-zA-Z_][a-zA-Z_0-9]{0,62}$/.test(database)) throw new Error('数据库名只能使用字母、数字和下划线，且须以字母或下划线开头');
  const maintenance = new pg.Client({...config, database:'postgres'});
  try {
    await maintenance.connect();
    await maintenance.query(`CREATE DATABASE "${database}" WITH TEMPLATE template0 ENCODING 'UTF8'`);
    log.info({module:'database',database},'database.created');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== '42P04') throw setupError(error,database,true);
  } finally {
    await maintenance.end();
  }
}

export async function openLibrary(settings: Settings, log: FastifyBaseLogger, initializeMissing = false) {
  if (!path.isAbsolute(settings.root) || path.parse(settings.root).root === path.normalize(settings.root)) throw new Error('请选择专用的素材库目录');
  const config: pg.ClientConfig = {
    host: settings.host, port: settings.port, database: settings.database,
    user: settings.user, password: settings.password, connectionTimeoutMillis: 4500, client_encoding:'UTF8',
  };
  const pool = new pg.Pool(config);
  pool.on('error', error => log.error({module: 'database', ...errorFields(error)}, 'database.connection_lost'));
  let root = settings.root;
  let client: pg.PoolClient;
  try {
    try {
      client = await pool.connect();
    } catch (error) {
      if (!initializeMissing || (error as NodeJS.ErrnoException).code !== '3D000') throw error;
      const entries = await readdir(root).catch(error => {
        if (error.code === 'ENOENT') return [];
        throw error;
      });
      if (entries.some(entry => entry !== 'desktop.ini')) {
        throw new Error('所选素材目录已有内容，但对应的数据库不存在。请连接原数据库或选择空目录创建模板库。');
      }
      await createDatabase(config,settings.database,log);
      client = await pool.connect();
    }
  } catch (error) {
    await pool.end();
    throw setupError(error,settings.database);
  }
  let locked = false;
  const bindingLock = "hashtextextended('vfx_library.initialize',0)";
  try {
    await client.query('SELECT pg_advisory_lock('+bindingLock+')');
    locked = true;
    await mkdir(root, {recursive: true});
    root = await realpath(root);
    const marker = path.join(root, '.vfx-library');
    const pendingMarker = path.join(root, '.vfx-library-pending');
    const stagedMarker = path.join(root, '.vfx-library-marker');
    const directoryId = await readFile(marker, 'utf8').then(value => value.trim()).catch(error => {
      if (error.code === 'ENOENT') return undefined;
      throw error;
    });
    const connection = {host:settings.host.toLowerCase(),port:settings.port,database:settings.database};
    let pendingId: string | undefined;
    if (!directoryId) {
      const pending = await readFile(pendingMarker,'utf8').then(value=>JSON.parse(value) as {
        id:string;host:string;port:number;database:string;
      }).catch(error=>{
        if (error.code==='ENOENT') return undefined;
        throw error;
      });
      if (pending) {
        if (!importVersion.test('.import-'+pending.id+'.json') ||
          pending.host!==connection.host || pending.port!==connection.port || pending.database!==connection.database) {
          throw new Error('素材库初始化尚未完成，请使用原数据库连接重试');
        }
        pendingId = pending.id;
      }
      const allowed = pendingId ? ['desktop.ini','.vfx-library-pending','.vfx-library-marker','staging','templates'] : ['desktop.ini'];
      if ((await readdir(root)).some(name=>!allowed.includes(name))) {
        throw new Error('请选择空目录，或选择已经与此数据库绑定的模板库');
      }
      if (pendingId) {
        const created = await Promise.all(['staging','templates'].map(name=>readdir(path.join(root,name)).catch(error=>{
          if (error.code==='ENOENT') return [];
          throw error;
        })));
        if (created.some(entries=>entries.length)) throw new Error('未完成初始化的素材库目录含有文件，请检查目录');
      }
    }
    await client.query('BEGIN');
    await client.query(schema);
    let id: string = (await client.query('SELECT id FROM vfx_library')).rows[0]?.id;
    if (directoryId && !id) throw new Error('所选数据库没有此素材库的绑定记录，请连接原数据库');
    if (id && id !== (directoryId ?? pendingId)) throw new Error('数据库与素材库目录不匹配，请使用对应的原目录');
    if (!id) {
      id = pendingId ?? randomUUID();
      if (!pendingId) await writeFile(pendingMarker,JSON.stringify({...connection,id}),{flag:'wx',flush:true});
      await client.query('INSERT INTO vfx_library(id) VALUES($1)', [id]);
    }
    await Promise.all(['staging', 'templates'].map(name => mkdir(path.join(root, name), {recursive: true})));
    await client.query('COMMIT');
    if (!directoryId) {
      await writeFile(stagedMarker,id+'\n',{flush:true});
      await rename(stagedMarker,marker);
      await rm(pendingMarker,{force:true}).catch(error=>log.warn(errorFields(error),'library.pending_cleanup_failed'));
    }
    log.info({module: 'database', database: settings.database, libraryId: id}, 'library.opened');
    const library = new Library(pool,root,id,log);
    await library.recoverImports();
    return library;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    void pool.end();
    throw setupError(error,settings.database);
  } finally {
    const unlocked = !locked || await client.query('SELECT pg_advisory_unlock('+bindingLock+')').then(()=>true,()=>false);
    client.release(!unlocked);
  }
}

async function setTags(client: pg.PoolClient, id: string, names: string[]) {
  const values = new Map(names.map(name => [tagKey(name), name.trim()]).filter(([key]) => key).map(([key,name]) => [key,name] as const));
  await client.query('DELETE FROM vfx_template_tags WHERE template_id=$1', [id]);
  for (const [key, name] of values) {
    await client.query('INSERT INTO vfx_tags(key,name) VALUES($1,$2) ON CONFLICT DO NOTHING', [key, name]);
    await client.query('INSERT INTO vfx_template_tags(template_id,tag_key) VALUES($1,$2)', [id,key]);
  }
}

const selectSummary = `
  SELECT t.id,t.version,t.title,t.preview,t.files,t.bytes,t.created_at AS "publishedAt",
  ARRAY(SELECT g.name FROM vfx_template_tags tt JOIN vfx_tags g ON g.key=tt.tag_key
    WHERE tt.template_id=t.id ORDER BY g.name) AS tags
`;

const importVersion = /^\.import-([a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})\.json$/u;
const lockKey = 'hashtextextended($1,0)';

type LegacyArchive = Pick<TemplateDetail,'id'|'version'|'title'|'manifest'|'sequences'> & {trashed:boolean};

function legacyArchives(manifest:TemplateDetail['manifest']) {
  const renderPaths = renderSequencePaths(manifest);
  const occupied = new Set<string>();
  for (const entry of manifest) {
    for (let name=entry.path.toLowerCase();name!=='.'&&name!=='/';name=path.posix.dirname(name)) occupied.add(name);
  }
  const archives = new Map<ArchiveName,TemplateDetail['manifest']>(archiveNames.flatMap(name=>{
    const entries = manifest.filter(entry=>name==='render.zip' ? renderPaths.has(entry.path) : /\.abc$/iu.test(entry.path));
    return entries.length ? [[name,entries] as const] : [];
  }));
  for (const [name,entries] of textureSequenceArchives(manifest)) archives.set(name,entries);
  for (const name of archives.keys()) {
    if (occupied.has(name.toLowerCase())) archives.delete(name);
  }
  return archives;
}

function verifyStream(entry:TemplateDetail['manifest'][number], onBytes?:(count:number)=>void) {
  const hash = createHash('sha256');
  let bytes = 0;
  return new Transform({
    transform(chunk,_encoding,callback) {
      hash.update(chunk);
      bytes += chunk.length;
      onBytes?.(chunk.length);
      callback(null,chunk);
    },
    flush(callback) {
      callback(bytes===entry.bytes && hash.digest('hex')===entry.sha256 ? undefined
        : new Error(`素材校验失败：${entry.path}`));
    },
  });
}

async function packArchive(directory:string, destination:string, entries:TemplateDetail['manifest'], onBytes?:(count:number)=>void) {
  await mkdir(path.dirname(destination),{recursive:true});
  const archive = new ZipFile();
  const output = archive.outputStream as PassThrough;
  archive.on('error',error=>output.destroy(error));
  const hash = createHash('sha256');
  let bytes = 0;
  const checksum = new Transform({transform(chunk,_encoding,callback) {
    hash.update(chunk);
    bytes += chunk.length;
    callback(null,chunk);
  }});
  const abort = new AbortController();
  for (const entry of entries) {
    const source = nativePath(directory,entry.path);
    archive.addReadStreamLazy(entry.path,{size:entry.bytes,compressionLevel:zlib.Z_BEST_COMPRESSION},callback=>{
      const verified = verifyStream(entry,onBytes);
      callback(null,verified);
      void pipeline(createReadStream(source),verified,{signal:abort.signal}).catch(error=>{
        if (!abort.signal.aborted) output.destroy(error);
      });
    });
  }
  const writing = pipeline(output,checksum,createWriteStream(destination,{flags:'wx'}));
  archive.end({forceZip64Format:true,comment:''});
  try { await writing; }
  finally { abort.abort(); }
  return {bytes,sha256:hash.digest('hex')};
}

async function packArchives(archives:Map<ArchiveName,TemplateDetail['manifest']>, source:(name:ArchiveName)=>string,
  project:string, manifest:TemplateDetail['manifest'], progress:(value:CompressionProgress)=>void) {
  let totalBytes = 0;
  for (const entries of archives.values()) for (const entry of entries) totalBytes += entry.bytes;
  let bytesRead = 0;
  let remaining = archives.size;
  let lastUpdate = -Infinity;
  const report = (archive:ArchiveName,complete = false) => {
    const now = performance.now();
    if (!complete && now-lastUpdate<1000) return;
    lastUpdate = now;
    progress({archive,bytesRead,totalBytes,complete});
  };
  for (const [name,entries] of archives) {
    report(name);
    const archive = await packArchive(source(name),nativePath(project,name),entries,count=>{
      bytesRead += count;
      report(name);
    });
    manifest.push({path:name,kind:'other',...archive,entries});
    if (--remaining===0) report(name,true);
  }
}

function containsDirectory(parent:string, child:string) {
  const relative = path.relative(parent,child);
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..'+path.sep));
}

export class Library {
  private plans = new Map<string, Plan>();
  private publishing = new Set<string>();
  private publishTail = Promise.resolve();

  constructor(private pool: pg.Pool, private directory: string, readonly id: string, private log: FastifyBaseLogger) {}

  get root() { return this.directory; }

  close() { return this.pool.end(); }

  restoreDatabase(file:string) { return restoreDatabaseBackup(this.pool,this.root,file,this.log); }

  async migrateStorage(requested:string, saveRoot:(root:string)=>Promise<void>) {
    const root = path.normalize(requested);
    if (!path.isAbsolute(root) || path.parse(root).root === root) throw new Error('请选择专用的素材库目录');
    const parent = await realpath(path.dirname(root)).catch(error=>{
      if (error.code === 'ENOENT') throw new Error('找不到新目录的上级目录，请检查存储盘是否已连接');
      throw error;
    });
    const target = path.join(parent,path.basename(root));
    const info = await lstat(target).catch(error=>{
      if (error.code === 'ENOENT') return undefined;
      throw error;
    });
    const resolvedTarget = info ? await realpath(target) : target;
    if (containsDirectory(this.root,resolvedTarget) || containsDirectory(resolvedTarget,this.root)) {
      throw new Error('新目录不能与当前素材库相同，也不能互相包含');
    }
    if (info && (!info.isDirectory() || (await readdir(target)).length)) throw new Error('请选择空目录或尚未创建的目录');

    const temporary = await mkdtemp(path.join(parent,'.vfx-migration-'));
    const copy = path.join(temporary,'library');
    const log = this.log.child({module:'migration',source:this.root,target});
    let removedEmpty = false;
    let promoted = false;
    log.info('storage.migration_started');
    try {
      await cp(this.root,copy,{recursive:true,force:false,errorOnExist:true,filter:async source=>{
        const entry = await lstat(source);
        if (!entry.isDirectory() && !entry.isFile()) throw new Error(`素材库含有链接或特殊文件：${path.relative(this.root,source)}`);
        return true;
      }});
      const marker = await readFile(path.join(copy,'.vfx-library'),'utf8');
      if (marker.trim() !== this.id) throw new Error('复制后的素材库与数据库不匹配');
      const {rows} = await this.pool.query<Pick<TemplateDetail,'id'|'version'|'manifest'>>('SELECT id,version,manifest FROM vfx_templates');
      for (const template of rows) {
        const project = path.join(copy,'templates',template.id,template.version,'project');
        for (const file of template.manifest) {
          const hash = createHash('sha256');
          for await (const chunk of createReadStream(nativePath(project,file.path))) hash.update(chunk);
          if (hash.digest('hex') !== file.sha256) throw new Error(`复制后的素材校验失败：${file.path}`);
        }
      }

      if (info) {
        await rmdir(target);
        removedEmpty = true;
      }
      await rename(copy,target);
      promoted = true;
      await saveRoot(root);
      this.directory = target;
      this.plans.clear();
      log.info('storage.migration_completed');
    } catch (error) {
      log.warn(errorFields(error),'storage.migration_failed');
      if (promoted) {
        await rename(target,copy).then(()=>{promoted=false;},cleanupError=>{
          log.warn(errorFields(cleanupError),'storage.migration_rollback_failed');
        });
      }
      if (removedEmpty && !promoted) {
        await mkdir(target).catch(cleanupError=>log.warn(errorFields(cleanupError),'storage.migration_restore_directory_failed'));
      }
      throw error;
    } finally {
      await rm(temporary,{recursive:true,force:true}).catch(error=>log.warn(errorFields(error),'storage.migration_cleanup_failed'));
    }
  }

  async recoverImports() {
    const staging = path.join(this.root,'staging');
    for (const name of await readdir(staging)) {
      const match = importVersion.exec(name);
      if (match) await this.reconcileImport(match[1],path.join(staging,name));
    }
  }

  private async reconcileImport(version: string, intent: string, waitForLock = false) {
    let client: pg.PoolClient | undefined;
    try {
      client = await this.pool.connect();
      if (waitForLock) await client.query(`SELECT pg_advisory_lock(${lockKey})`,[version]);
      else {
        const {rows:[{locked}]} = await client.query(`SELECT pg_try_advisory_lock(${lockKey}) AS locked`,[version]);
        if (!locked) return;
      }
      const {templateId,taskId} = JSON.parse(await readFile(intent,'utf8')) as {templateId:string;taskId:string};
      if (!importVersion.test(`.import-${templateId}.json`)) throw new Error('归档清理记录的模板 ID 无效');
      const {rowCount} = await client.query('SELECT 1 FROM vfx_templates WHERE id=$1 AND version=$2',[templateId,version]);
      const target = path.join(this.root,'templates',templateId,version);
      if (rowCount) await stat(target);
      else if (waitForLock) await rm(target,{recursive:true,force:true});
      else {
        // A restored database may predate an archive that has already been published.
        const archived = await lstat(target).catch(error => {
          if (error.code !== 'ENOENT') throw error;
        });
        if (archived) {
          this.log.warn({module:'import',taskId,templateId,version},'import.unregistered_archive_preserved');
          return;
        }
      }
      await rm(path.join(this.root,'staging',version),{recursive:true,force:true});
      await rm(intent,{force:true});
      this.log.info({module:'import',taskId,templateId,version,registered:Boolean(rowCount)},'import.reconciled');
      return Boolean(rowCount);
    } catch (error) {
      this.log.warn({module:'import',version,...errorFields(error)},'import.recovery_deferred');
    } finally { client?.release(true); }
  }

  async scan(inputs: string[], previousPlanId?: string) {
    const start = performance.now();
    if (previousPlanId && this.publishing.has(previousPlanId)) throw new Error('此导入清单已提交发布');
    const previous = previousPlanId ? this.plans.get(previousPlanId) : undefined;
    if (previousPlanId && !previous) throw new Error('导入清单已经失效，请重新扫描');
    const sources = previous ? [...new Set([...previous.sources,...inputs])] : inputs;
    const plan = await scanSources(sources,this.root,previous?.scanRoots);
    if (previous) this.plans.delete(previous.id);
    if (this.plans.size >= 8) {
      for (const id of this.plans.keys()) {
        if (!this.publishing.has(id)) {this.plans.delete(id);break;}
      }
    }
    this.plans.set(plan.id, plan);
    this.log.info({module:'import', taskId: plan.id, sourceCount: inputs.length, files: plan.files.length,
      selectedFiles: plan.files.filter(file => file.keep).length, sequences: plan.sequences.length,
      bytes: plan.files.reduce((sum, file) => sum + file.bytes, 0), elapsedMs: Math.round(performance.now()-start)}, 'import.scan_completed');
    return plan;
  }

  async scanPreview(id: string, relative: string) {
    const movie = this.plans.get(id)?.files.find(file => file.path === relative && file.kind === 'movie');
    if (!movie) throw new Error('未找到导入预览');
    const file = await realpath(movie.sourcePath);
    const info = await lstat(movie.sourcePath);
    if (path.relative(movie.sourcePath,file) || !info.isFile() ||
      info.size !== movie.bytes || info.mtimeMs !== movie.modified) throw new Error('源文件已修改，请重新扫描');
    return {file,bytes:info.size};
  }

  async publish(input: PublishInput, progress: (event: ArchiveProgress) => void): Promise<Template> {
    const plan = this.plans.get(input.id);
    if (!plan) throw new Error('导入清单已经失效，请重新扫描');
    if (this.publishing.has(input.id)) throw new Error('此导入清单正在发布');
    this.publishing.add(input.id);
    const result = this.publishTail.then(()=>this.publishPlan(plan,input,progress));
    this.publishTail = result.then(()=>undefined,()=>undefined);
    try { return await result; }
    finally { this.publishing.delete(input.id); }
  }

  private async publishPlan(plan:Plan,input:PublishInput,progress:(event:ArchiveProgress)=>void):Promise<Template> {
    const paths = new Set(input.paths);
    const files = plan.files.filter(item => paths.has(item.path));
    if (paths.size !== files.length) throw new Error('选择中有未经扫描的路径');
    if (!files.some(item => item.kind === 'houdini' || item.kind === 'nuke')) throw new Error('请选择至少一个 Houdini 或 Nuke 工程');
    const preview = files.find(item => item.kind === 'movie' && item.path === input.preview);
    if (!preview) throw new Error('请选择要归档的主预览 MOV');
    const destinations = new Map<string,string>();
    const packed = new Map<ArchiveName,TemplateDetail['manifest']>();
    const enabled = input.archives && new Set(input.archives);
    const textureSources = new Map<ArchiveName,string>();
    for (const {archiveZip,kind,sourcePath} of files) {
      if (!archiveZip || enabled && !enabled.has(archiveZip)) continue;
      if (kind==='texture') {
        const directory = path.dirname(sourcePath);
        const previous = textureSources.get(archiveZip);
        if (previous && previous!==directory) throw new Error(`不同贴图目录将生成同名压缩包：${archiveZip}`);
        textureSources.set(archiveZip,directory);
      }
      if (!packed.has(archiveZip)) {
        const key = archiveZip.toLowerCase();
        if (destinations.has(key)) throw new Error(`压缩包归档路径重复：${archiveZip}`);
        packed.set(archiveZip,[]);
        destinations.set(key,`自动生成的 ${archiveZip}`);
      }
    }
    for (const file of files) {
      const key = file.archivePath.toLowerCase();
      const conflict = destinations.get(key);
      if (conflict) {
        this.log.warn({module:'import',taskId:input.id,sources:[conflict,file.path],archivePath:file.archivePath},'import.archive_path_conflict');
        throw new Error(`「${conflict}」和「${file.path}」的归档路径相同，请取消勾选其中一项或调整源文件名。`);
      }
      destinations.set(key,file.path);
    }
    for (const name of packed.keys()) {
      for (let directory=path.posix.dirname(name);directory!=='.';directory=path.posix.dirname(directory)) {
        if (destinations.has(directory.toLowerCase())) throw new Error(`压缩包归档目录与文件重名：${directory}`);
      }
    }
    for (const file of files) {
      for (let directory=path.posix.dirname(file.archivePath);directory!=='.';directory=path.posix.dirname(directory)) {
        if (destinations.has(directory.toLowerCase())) {
          this.log.warn({module:'import',taskId:input.id,source:file.path,archivePath:directory},'import.archive_directory_conflict');
          throw new Error(`归档目录「${directory}」与所选文件重名，请调整勾选项。`);
        }
      }
    }
    const started = performance.now();
    const templateId = randomUUID();
    const version = randomUUID();
    const work = path.join(this.root, 'staging', version);
    const project = path.join(work,'project');
    const packStaging = path.join(work,'pack-input');
    const intent = path.join(this.root,'staging',`.import-${version}.json`);
    const target = path.join(this.root, 'templates', templateId, version);
    const manifest: TemplateDetail['manifest'] = [];
    const logger = this.log.child({module: 'import', taskId: input.id, templateId, version});
    const totalBytes = files.reduce((sum,file)=>sum+file.bytes,0);
    let stage: ArchiveProgress['stage'] = 'copy';
    let currentFile: ArchiveProgress['currentFile'];
    let compression: CompressionProgress | undefined;
    let bytesCopied = 0;
    let completed = 0;
    let lastUpdate = -Infinity;
    let moved = false;
    let intentWritten = false;
    let result: Template | undefined;
    let client: pg.PoolClient | undefined;
    const onDatabaseError = (error:Error) => logger.warn(errorFields(error),'import.database_connection_lost');
    const reportProgress = (force = false) => {
      const now = performance.now();
      if (!force && now-lastUpdate < 200) return;
      lastUpdate = now;
      progress({id:input.id,stage,completed,total:files.length,bytesCopied,totalBytes,
        elapsedMs:Math.round(now-started),currentFile:currentFile && {...currentFile},compression});
    };
    logger.info({files:files.length,totalBytes,relocatedFiles:files.filter(file=>file.path!==file.archivePath).length},'import.publish_started');
    try {
      client = await this.pool.connect();
      client.on('error',onDatabaseError);
      await client.query(`SELECT pg_advisory_lock(${lockKey})`,[version]);
      await writeFile(intent,JSON.stringify({templateId,taskId:input.id}),{flag:'wx',flush:true});
      intentWritten = true;
      await mkdir(work, {recursive:true});
      for (const file of files) {
        const current = {path:file.path,bytesCopied:0,totalBytes:file.bytes};
        currentFile = current;
        reportProgress();
        const source = file.sourcePath;
        const archiveName = file.archiveZip;
        const archive = archiveName && packed.get(archiveName);
        const destination = nativePath(archive ? nativePath(packStaging,archiveName) : project,file.archivePath);
        const resolved = await realpath(source);
        if (path.relative(source, resolved) !== '') throw new Error('源路径已改动，请重新扫描');
        const before = await lstat(source);
        if (!before.isFile() || before.size !== file.bytes || before.mtimeMs !== file.modified) throw new Error('源文件已修改，请重新扫描');
        const hash = createHash('sha256');
        let bytes = 0;
        const hashStream = new Transform({transform(chunk, _encoding, callback) {
          hash.update(chunk);
          bytes += chunk.length;
          current.bytesCopied = bytes;
          bytesCopied += chunk.length;
          reportProgress();
          callback(null, chunk);
        }});
        await mkdir(path.dirname(destination), {recursive:true});
        await pipeline(createReadStream(source), hashStream, createWriteStream(destination, {flags:'wx'}));
        const after = await lstat(source);
        if (after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs || bytes !== before.size) throw new Error('复制过程中源文件发生变化');
        const entries = archive || manifest;
        entries.push({path:file.archivePath,...(file.archivePath!==file.path ? {sourcePath:file.path} : {}),bytes,kind:file.kind,sha256:hash.digest('hex')});
        completed++;
        if (completed % 100 === 0 || completed === files.length) {
          logger.info({completed,total:files.length,bytesCopied,totalBytes}, 'import.copy_progress');
        }
      }
      currentFile = undefined;
      const sequences = sequencesFor(files.filter(file=>file.kind!=='texture' || file.archiveZip)
        .map(file=>({path:file.archivePath,kind:file.kind})));
      if (packed.size) {
        stage = 'pack';
        await packArchives(packed,name=>nativePath(packStaging,name),project,manifest,value=>{
          compression = value;
          reportProgress(true);
        });
        await rm(packStaging,{recursive:true});
      }
      const archivedBytes = manifest.reduce((total,entry)=>total+entry.bytes,0);
      stage = 'register';
      compression = undefined;
      reportProgress(true);
      await mkdir(path.dirname(target), {recursive:true});
      await rename(work, target);
      moved = true;
      await client.query('BEGIN');
      await client.query('INSERT INTO vfx_templates(id,version,title,preview,manifest,sequences,bytes,files) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
        [templateId,version,input.title.trim(),preview.archivePath,JSON.stringify(manifest),JSON.stringify(sequences),archivedBytes,manifest.length]);
      await setTags(client, templateId, input.tags);
      const {rows:[summary]} = await client.query<Template>(`${selectSummary} FROM vfx_templates t WHERE t.id=$1`,[templateId]);
      result = {...summary,bytes:archivedBytes};
      await client.query('COMMIT');
      this.plans.delete(input.id);
      await rm(intent,{force:true}).catch(error=>logger.warn(errorFields(error),'import.intent_cleanup_failed'));
      logger.info({files:files.length,bytes:bytesCopied,elapsedMs:Math.round(performance.now()-started)}, 'import.published');
      return result;
    } catch (error) {
      logger.error({stage,file:currentFile?.path,bytesCopied,totalBytes,elapsedMs:Math.round(performance.now()-started),...errorFields(error)},'import.publish_failed');
      if (client) {
        if (moved) await client.query('ROLLBACK').catch(() => undefined);
        client.off('error',onDatabaseError);
        client.release(true);
        client = undefined;
      }
      if (intentWritten && moved) {
        const registered = await this.reconcileImport(version,intent,true);
        if (result && registered !== false) {
          this.plans.delete(input.id);
          if (registered) return result;
          throw new Error('无法确认发布结果。请先检查模板库和运行日志，再决定是否重新导入。',{cause:error});
        }
      } else if (intentWritten) {
        try {
          await rm(work,{recursive:true,force:true});
          await rm(intent,{force:true});
        } catch (cleanupError) { logger.warn(errorFields(cleanupError),'import.cleanup_failed'); }
      }
      throw error;
    } finally {
      if (client) {
        const unlocked = await client.query(`SELECT pg_advisory_unlock(${lockKey})`,[version]).then(()=>true,()=>false);
        client.off('error',onDatabaseError);
        client.release(!unlocked);
      }
    }
  }

  private async findTemplates(search: string, wanted: string[], mode: 'all' | 'any', trashed: boolean, limit: number, offset: number) {
    const tags = [...new Set(wanted.map(tagKey).filter(Boolean))];
    const started = performance.now();
    const {rows} = await this.pool.query(`${selectSummary} FROM vfx_templates t
      WHERE (t.deleted_at IS NOT NULL) = $4::boolean
      AND ($1 = '' OR position(lower($1) in lower(t.title)) > 0 OR EXISTS (
        SELECT 1 FROM vfx_template_tags tt JOIN vfx_tags g ON g.key=tt.tag_key
        WHERE tt.template_id=t.id AND (position(lower($1) in lower(g.name)) > 0 OR position($5 in g.key) > 0)
      ))
      AND (cardinality($2::text[]) = 0 OR
        (SELECT count(*) FROM vfx_template_tags tt WHERE tt.template_id=t.id AND tt.tag_key=ANY($2::text[])) >=
          CASE WHEN $3='all' THEN cardinality($2::text[]) ELSE 1 END)
      ORDER BY COALESCE(t.deleted_at,t.created_at) DESC,t.id DESC LIMIT $6 OFFSET $7`,
      [search.trim(),tags,mode,trashed,tagKey(search),limit,offset]);
    this.log.info({module:'search',filters:tags.length,mode,trashed,matches:rows.length,elapsedMs:Math.round(performance.now()-started)},'templates.listed');
    return rows.map(row=>({...row,bytes:Number(row.bytes)})) as Template[];
  }

  async searchPublished(search: string, limit: number, offset: number) {
    const items = await this.findTemplates(search,[],'any',false,limit+1,offset);
    return {
      source:'vfx-template-library',
      items:items.slice(0,limit).map(({id,title,tags,files,bytes,publishedAt})=>({id,title,tags,files,bytes,publishedAt})),
      nextOffset:items.length>limit ? offset+limit : null,
    };
  }

  async catalogReady() {
    return this.pool.query('SELECT 1').then(()=>true,()=>false);
  }

  async list(search: string, wanted: string[], mode: 'all' | 'any', trashed = false, page = 0) {
    const pageSize = 500;
    const items = await this.findTemplates(search,wanted,mode,trashed,pageSize+1,page*pageSize);
    const available = await this.pool.query(`
      SELECT g.name FROM vfx_tags g
      WHERE EXISTS (
        SELECT 1 FROM vfx_template_tags tt JOIN vfx_templates t ON t.id=tt.template_id
        WHERE tt.tag_key=g.key AND t.deleted_at IS NULL
      )
      ORDER BY g.name
    `);
    return {items:items.slice(0,pageSize),tags:available.rows.map(row=>row.name as string),hasNext:items.length>pageSize};
  }

  async detail(id: string): Promise<TemplateDetail> {
    const {rows} = await this.pool.query(`${selectSummary},t.description,t.manifest,t.sequences FROM vfx_templates t WHERE t.id=$1 AND t.deleted_at IS NULL`, [id]);
    if (!rows[0]) throw new Error('未找到模板');
    return {...rows[0],bytes:Number(rows[0].bytes)};
  }

  private async legacyTemplates(ids?:string[]) {
    const {rows} = await this.pool.query<LegacyArchive>(`SELECT id,version,title,manifest,sequences,
      deleted_at IS NOT NULL AS trashed FROM vfx_templates
      WHERE ($1::uuid[] IS NULL OR id=ANY($1::uuid[])) ORDER BY created_at DESC,id`,[ids??null]);
    return rows;
  }

  async packCandidates(): Promise<PackCandidate[]> {
    return (await this.legacyTemplates()).flatMap(({id,title,trashed,manifest})=>{
      const archives = Array.from(legacyArchives(manifest),([name,entries])=>({
        name,files:entries.length,bytes:entries.reduce((total,entry)=>total+entry.bytes,0),
      }));
      return archives.length ? [{id,title,trashed,archives}] : [];
    });
  }

  async packExisting(ids:string[], progress:(event:PackProgress)=>void): Promise<PackExistingResult> {
    progress({type:'pack-existing',total:ids.length,packed:0,skipped:0,failed:0});
    const templates = await this.legacyTemplates(ids);
    const result:PackExistingResult = {packed:0,skipped:ids.length-templates.length,failed:[]};
    const report = (current?:PackProgress['current'])=>progress({
      type:'pack-existing',total:ids.length,packed:result.packed,skipped:result.skipped,failed:result.failed.length,current,
    });
    for (const template of templates) {
      const archives = legacyArchives(template.manifest);
      if (!archives.size) {result.skipped++;report();continue;}
      try {
        await this.packLegacyTemplate(template,archives,report);
        result.packed++;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.log.warn({templateId:template.id,...errorFields(error)},'archive.repack_failed');
        result.failed.push({id:template.id,title:template.title,message});
      }
      report();
    }
    if (!templates.length) report();
    return result;
  }

  private async packLegacyTemplate(template:LegacyArchive, archives:ReturnType<typeof legacyArchives>,
    progress:(current:NonNullable<PackProgress['current']>)=>void) {
    const {id,version:previousVersion} = template;
    const version = randomUUID();
    const intent = path.join(this.root,'staging',`.import-${version}.json`);
    const staging = path.join(this.root,'staging',version);
    const project = path.join(staging,'project');
    const source = this.projectDirectory(template);
    const target = path.join(this.root,'templates',id,version);
    const included = new Set(Array.from(archives.values()).flatMap(entries=>entries.map(entry=>entry.path)));
    const manifest = template.manifest.filter(entry=>!included.has(entry.path));
    const totalBytes = template.manifest.reduce((total,entry)=>total+entry.bytes,0);
    let bytesRead = 0;
    let stage:ArchiveProgress['stage'] = 'copy';
    let compression:CompressionProgress|undefined;
    let lastUpdate = -Infinity;
    const report = () => {
      lastUpdate = performance.now();
      progress({title:template.title,stage,compression,bytesRead,totalBytes});
    };
    const onBytes = (count:number) => {
      bytesRead += count;
      if (performance.now()-lastUpdate>=300) report();
    };
    report();
    let client:pg.PoolClient|undefined = await this.pool.connect();
    let moved = false;
    let intentWritten = false;
    const connectionLost = (error:Error)=>this.log.warn({templateId:id,...errorFields(error)},'archive.database_connection_lost');
    client.on('error',connectionLost);
    try {
      await client.query(`SELECT pg_advisory_lock(${lockKey})`,[version]);
      await writeFile(intent,JSON.stringify({templateId:id,taskId:version}),{flag:'wx',flush:true});
      intentWritten = true;
      await mkdir(project,{recursive:true});
      for (const entry of manifest) {
        const destination = nativePath(project,entry.path);
        await mkdir(path.dirname(destination),{recursive:true});
        await pipeline(createReadStream(nativePath(source,entry.path)),verifyStream(entry,onBytes),
          createWriteStream(destination,{flags:'wx'}));
      }
      stage = 'pack';
      const copiedBytes = bytesRead;
      await packArchives(archives,()=>source,project,manifest,value=>{
        compression = value;
        bytesRead = copiedBytes+value.bytesRead;
        report();
      });
      stage = 'register';
      compression = undefined;
      report();
      const knownSequences = new Set(template.sequences.map(sequence=>sequence.path));
      const detected = sequencesFor([...archives.values()].flat())
        .filter(sequence=>!knownSequences.has(sequence.path));
      await writeFile(path.join(staging,'.pack-origin.json'),JSON.stringify({
        version:previousVersion,manifest:template.manifest,sequences:template.sequences,
      }),{flag:'wx',flush:true});
      await rename(staging,target);
      moved = true;
      const updated = await client.query(`UPDATE vfx_templates SET version=$3,manifest=$4,bytes=$5,files=$6,sequences=$7
        WHERE id=$1 AND version=$2`,[id,previousVersion,version,JSON.stringify(manifest),
        manifest.reduce((total,file)=>total+file.bytes,0),manifest.length,JSON.stringify([...template.sequences,...detected])]);
      if (!updated.rowCount) throw new Error('模板版本已变化，请重新扫描');
      await rm(intent,{force:true}).catch(error=>this.log.warn(errorFields(error),'archive.repack_intent_cleanup_failed'));
      this.log.info({templateId:id,previousVersion,version},'archive.repacked');
    } catch (error) {
      client?.off('error',connectionLost);
      client?.release(true);
      client = undefined;
      if (moved) {
        if (await this.reconcileImport(version,intent,true)) return;
      } else if (intentWritten) {
        try {
          await rm(staging,{recursive:true,force:true});
          await rm(intent,{force:true});
        } catch (cleanup) { this.log.warn(errorFields(cleanup),'archive.repack_cleanup_failed'); }
      }
      throw error;
    } finally {
      client?.off('error',connectionLost);
      client?.release(true);
    }
  }

  async updateTags(id: string, names: string[]) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const exists = await client.query('SELECT id FROM vfx_templates WHERE id=$1 AND deleted_at IS NULL FOR UPDATE', [id]);
      if (!exists.rowCount) throw new Error('未找到模板');
      await setTags(client,id,names);
      await client.query('COMMIT');
      this.log.info({module:'tags',templateId:id,count:names.length},'tags.updated');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally { client.release(); }
  }

  async updateDescription(id: string, description: string) {
    const result = await this.pool.query(
      'UPDATE vfx_templates SET description=$2 WHERE id=$1 AND deleted_at IS NULL',[id,description]);
    if (!result.rowCount) throw new Error('未找到模板');
  }

  async setTrashed(id: string, trashed: boolean) {
    const result = await this.pool.query(`UPDATE vfx_templates
      SET deleted_at=CASE WHEN $2::boolean THEN now() ELSE NULL END
      WHERE id=$1 AND (deleted_at IS NULL)=$2::boolean`,[id,trashed]);
    if (!result.rowCount) throw new Error(trashed ? '未找到可删除的模板' : '未找到可恢复的模板');
    this.log.info({module:'templates',templateId:id},trashed?'templates.trashed':'templates.restored');
  }

  projectDirectory(template: Pick<Template,'id'|'version'>) {
    return path.join(this.root,'templates',template.id,template.version,'project');
  }

  filePath(template: Pick<Template,'id'|'version'>, relative: string) {
    return nativePath(this.projectDirectory(template),relative);
  }

  async preview(id: string) {
    const {rows:[template]} = await this.pool.query<Pick<Template,'id'|'version'|'preview'>>(
      'SELECT id,version,preview FROM vfx_templates WHERE id=$1 AND deleted_at IS NULL',[id]);
    if (!template) throw new Error('未找到模板');
    const file = this.filePath(template,template.preview);
    return {file,bytes:(await stat(file)).size};
  }
}
