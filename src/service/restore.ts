import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdtemp, readFile, realpath, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import type { FastifyBaseLogger } from 'fastify';
import type pg from 'pg';
import type { TemplateDetail } from '../contracts';
import { runPgTool } from './backup';
import { nativePath } from './scanner';

const tables = {
  vfx_templates:['id','version','title','preview','manifest','sequences','bytes','files','created_at'],
  vfx_tags:['key','name'],
  vfx_template_tags:['template_id','tag_key'],
} as const;
type Table = keyof typeof tables;
type CopyRow = Record<string,string | null>;
const uuid = /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/u;
const digest = /^[a-f\d]{64}$/u;
const malformed = () => new Error('备份中的模板库数据格式无效');
const escapes:Record<string,string> = {'\\':'\\',b:'\b',f:'\f',n:'\n',r:'\r',t:'\t',v:'\v'};

function decode(value:string) {
  if (value === '\\N') return null;
  return value.replace(/\\(.)/gu,(_match,key:string)=>{
    if (!Object.hasOwn(escapes,key)) throw malformed();
    return escapes[key];
  });
}

async function readTables(file:string) {
  const data:Record<Table,CopyRow[]> = {vfx_templates:[],vfx_tags:[],vfx_template_tags:[]};
  const seen = new Set<Table>();
  let section:{table:Table;columns:string[]} | undefined;
  const stream = createReadStream(file,{encoding:'utf8'});
  const lines = createInterface({input:stream,crlfDelay:Infinity});
  try {
    // Read data rows only. The SQL emitted by pg_restore is never executed.
    for await (const line of lines) {
      if (section) {
        if (line === '\\.') {
          section = undefined;
          continue;
        }
        const values = line.split('\t');
        if (values.length !== section.columns.length) throw malformed();
        data[section.table].push(Object.fromEntries(section.columns.map((column,index)=>[column,decode(values[index])])));
        continue;
      }
      const header = /^COPY (?:[a-z_][\w$]*|"(?:[^"]|"")+")\.(vfx_\w+) \(([a-z0-9_, ]+)\) FROM stdin;$/u.exec(line);
      if (!header || !Object.hasOwn(tables,header[1])) continue;
      const table = header[1] as Table;
      const columns = header[2].split(', ');
      if (seen.has(table) || new Set(columns).size !== columns.length ||
        !tables[table].every(column=>columns.includes(column))) throw malformed();
      section = {table,columns};
      seen.add(table);
    }
  } finally {
    lines.close();
    stream.destroy();
  }
  if (section || seen.size !== Object.keys(tables).length) throw malformed();
  return data;
}

async function sha256(file:string) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

function readManifest(row:CopyRow):TemplateDetail['manifest'] {
  if (!row.id || !uuid.test(row.id) || !row.version || !uuid.test(row.version)) throw malformed();
  const manifest = JSON.parse(row.manifest ?? 'null') as TemplateDetail['manifest'];
  if (!Array.isArray(manifest) || manifest.length !== Number(row.files) ||
    !manifest.every(file=>file && typeof file.path === 'string' && Number.isSafeInteger(file.bytes) && file.bytes >= 0 &&
      typeof file.sha256 === 'string' && digest.test(file.sha256)) ||
    !manifest.some(file=>file.path===row.preview&&file.kind==='movie')) throw malformed();
  return manifest;
}

async function assetsReady(root:string,row:CopyRow,manifest:TemplateDetail['manifest']) {
  const project = path.join(root,'templates',row.id!,row.version!,'project');
  try {
    for (const entry of manifest) {
      const file = nativePath(project,entry.path);
      const info = await stat(file);
      if (!info.isFile() || info.size !== entry.bytes || path.relative(file,await realpath(file)) !== '' ||
        await sha256(file) !== entry.sha256) return false;
    }
    return true;
  } catch (error) {
    if (['ENOENT','ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) return false;
    throw error;
  }
}

export async function restoreDatabaseBackup(pool:pg.Pool,root:string,file:string,log:FastifyBaseLogger) {
  if (!path.isAbsolute(file) || path.extname(file).toLowerCase() !== '.dump') throw new Error('请选择应用生成的 .dump 数据库备份');
  const checksum = await readFile(file.slice(0,-5)+'.sha256','utf8').catch(error=>{
    if (error.code === 'ENOENT') return undefined;
    throw error;
  });
  if (checksum !== undefined && (!digest.test(checksum.trim()) || await sha256(file) !== checksum.trim())) {
    throw new Error('数据库备份校验失败，请确认文件已复制完整');
  }
  const temporary = await mkdtemp(path.join(tmpdir(),'vfx-restore-'));
  try {
    const extracted = path.join(temporary,'data.sql');
    await runPgTool('pg_restore',['--data-only',...Object.keys(tables).flatMap(table=>['--table',table]),'--file',extracted,'--',file]);
    const data = await readTables(extracted);
    const ids = data.vfx_templates.map(row=>row.id);
    if (ids.some(id=>!id||!uuid.test(id)) || new Set(ids).size !== ids.length) throw malformed();
    const existing = new Set((await pool.query<{id:string}>('SELECT id FROM vfx_templates WHERE id=ANY($1::uuid[])',[ids])).rows.map(row=>row.id));
    let unavailable = 0;
    const candidates = [];
    for (const row of data.vfx_templates) {
      if (existing.has(row.id!)) continue;
      const manifest = readManifest(row);
      if (await assetsReady(root,row,manifest)) {
        candidates.push({...row,manifest,sequences:JSON.parse(row.sequences ?? 'null')});
      } else unavailable++;
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const {rows:inserted} = await client.query<{id:string}>(`
        INSERT INTO vfx_templates(id,version,title,preview,manifest,sequences,bytes,files,created_at,deleted_at)
        SELECT id,version,title,preview,manifest,sequences,bytes,files,created_at,deleted_at
        FROM jsonb_populate_recordset(NULL::vfx_templates,$1::jsonb)
        ON CONFLICT (id) DO NOTHING RETURNING id
      `,[JSON.stringify(candidates)]);
      const insertedIds = new Set(inserted.map(row=>row.id));
      const links = data.vfx_template_tags.filter(row=>row.template_id && insertedIds.has(row.template_id));
      const keys = new Set(links.map(row=>row.tag_key));
      const tags = data.vfx_tags.filter(row=>keys.has(row.key));
      await client.query(`INSERT INTO vfx_tags(key,name)
        SELECT key,name FROM jsonb_populate_recordset(NULL::vfx_tags,$1::jsonb)
        ON CONFLICT (key) DO NOTHING`,[JSON.stringify(tags)]);
      await client.query(`INSERT INTO vfx_template_tags(template_id,tag_key)
        SELECT template_id,tag_key FROM jsonb_populate_recordset(NULL::vfx_template_tags,$1::jsonb)
        ON CONFLICT DO NOTHING`,[JSON.stringify(links)]);
      await client.query('COMMIT');
      const result = {imported:inserted.length,skipped:ids.length-inserted.length-unavailable,unavailable};
      log.info({module:'restore',...result},'database.restore_completed');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(()=>undefined);
      throw error;
    } finally {
      client.release();
    }
  } finally {
    await rm(temporary,{recursive:true,force:true}).catch(error=>log.warn({err:error,module:'restore'},'database.restore_cleanup_failed'));
  }
}
