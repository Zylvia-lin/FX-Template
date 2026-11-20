import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { Transform, type PassThrough } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import Fastify, { LogController, type FastifyReply } from 'fastify';
import { ZipFile } from 'yazl';
import type { DesktopProgress, PublishInput, Settings } from '../contracts';
import { openLibrary, type Library } from './library';
import { Backups } from './backup';

const uuid = {type:'string',pattern:'^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$'};
const shortString = {type:'string',minLength:1,maxLength:100};
const tags = {type:'array',maxItems:100,items:shortString};
const invalidBackupDirectory = (directory:string) => Boolean(directory) && !path.isAbsolute(directory);
const backupDirectoryError = '请选择绝对路径的备份目录';
const catalogRoute = '/integrations/fx-agent/templates';
const catalogStatusRoute = '/integrations/fx-agent/status';
const idParams = {type:'object',required:['id'],properties:{id:uuid}};
const allRequired = (properties:Record<string,unknown>) => ({
  type:'object',required:Object.keys(properties),properties,additionalProperties:false,
});

export function createServer(options: {
  token:string; logPath:string; catalogToken?:string;
  loadSettings:()=>Promise<Settings | undefined>;
  saveSettings:(s:Settings)=>Promise<void>;
  progress:(event:DesktopProgress)=>void;
}) {
  const app = Fastify({
    logger:{file:options.logPath,redact:['req.headers.authorization','password','*.password']},
    logController:new LogController({disableRequestLogging:true}), genReqId:() => randomUUID(),bodyLimit:16*1024*1024,
  });
  let settings: Settings | undefined;
  let library: Library | undefined;
  let backups: Backups | undefined;
  let warning: string | undefined;
  let configuring = false;
  let reconnecting = false;
  let migrating = false;
  let importing = 0;
  app.addHook('onRequest',async (request,reply) => {
    const authorization = request.headers.authorization;
    const route = request.routeOptions.url;
    const catalogRead = request.method === 'GET' && (route === catalogRoute || route === catalogStatusRoute) &&
      options.catalogToken && authorization === `Bearer ${options.catalogToken}`;
    if (authorization !== `Bearer ${options.token}` && !catalogRead) {
      await reply.code(401).send({message:'未授权的本机请求'});
    }
  });
  app.addHook('onResponse',async (request,reply) => {
    if (request.routeOptions.url?.endsWith('/preview') && reply.statusCode < 400) return;
    request.log.info({module:'http',route:request.routeOptions.url,method:request.method,status:reply.statusCode,
      elapsedMs:Math.round(reply.elapsedTime)},'request.completed');
  });
  app.setErrorHandler((error: Error & { statusCode?: number; code?: string },request,reply) => {
    if (request.routeOptions.url === '/settings' && request.method === 'PUT') {
      request.log.error({module:'settings',errorCode:error.code ?? 'configuration_failed'},'settings.update_failed');
    } else request.log.error({module:'http',errorCode:error.code ?? 'operation_failed',errorMessage:error.message},'request.failed');
    void reply.code(error.statusCode ?? 400).send({message:error.message});
  });

  const active = () => {
    if (!library) throw new Error('请先配置素材库和数据库');
    return library;
  };
  const updateBackup = () => {
    if (backups) backups.configure(settings!);
    else {
      backups = new Backups(settings!,active().id,app.log);
      backups.start();
    }
  };
  app.get('/settings',async () => {
    const publicSettings = settings ? {...settings,password:undefined} : undefined;
    return {configured:Boolean(library),settings:publicSettings,logPath:options.logPath,warning};
  });
  app.put<{Body:Settings}>('/settings',{schema:{body:allRequired({
    root:shortStringWithPath(), host:shortString,port:{type:'integer',minimum:1,maximum:65535},
    database:{type:'string',pattern:'^[a-zA-Z_][a-zA-Z_0-9]{0,62}$'},user:shortString,
    password:{type:'string',maxLength:1000},backupDirectory:{type:'string',maxLength:1024},
    backupTime:{type:'string',pattern:'^(?:[01][0-9]|2[0-3]):[0-5][0-9]$|^$'},
    backupRetention:{type:'integer',minimum:1,maximum:365},
  })}},async request => {
    if (configuring) throw new Error('已有配置更新正在运行');
    configuring = true;
    const proposed = request.body;
    const next = {...proposed,password:proposed.password || settings?.password || ''};
    let opened: Library | undefined;
    try {
      if (invalidBackupDirectory(next.backupDirectory)) throw new Error(backupDirectoryError);
      if (library && settings && ['root','host','port','database','user'].some(key => next[key as keyof Settings] !== settings![key as keyof Settings])) {
        throw new Error('已配置的库需通过迁移流程更换连接或目录');
      }
      if (!library || next.password !== settings?.password) {
        if (importing) throw new Error('请等待模板扫描和入库队列完成后再更新数据库连接');
        reconnecting = true;
        opened = await openLibrary(next,app.log,!library);
      }
      await options.saveSettings(next);
      const old = library;
      if (opened) library = opened;
      settings = next;
      warning = undefined;
      updateBackup();
      if (opened && old) void old.close().catch(err => app.log.warn({err},'database.close_failed'));
      request.log.info({module:'settings',scheduled:Boolean(next.backupTime && next.backupDirectory)},'settings.saved');
      return {ok:true};
    } catch (error) {
      if (opened && opened !== library) await opened.close();
      throw error;
    } finally { configuring = reconnecting = false; }
  });
  app.post<{Body:{root:string}}>('/settings/migrate-storage',{
    schema:{body:allRequired({root:shortStringWithPath()})},
  },async request => {
    const current = active();
    if (configuring) throw new Error('已有配置更新正在运行');
    if (importing) throw new Error('请等待模板扫描或入库完成后再迁移素材库');
    configuring = migrating = true;
    backups?.stop();
    try {
      await backups?.waitForCurrent();
      await current.migrateStorage(request.body.root,async root=>{
        const next = {...settings!,root};
        await options.saveSettings(next);
        settings = next;
      });
      return {ok:true};
    } finally {
      configuring = migrating = false;
      backups?.start();
    }
  });
  app.post<{Body:{paths:string[];previousPlanId?:string}}>('/scan',{schema:{body:{
    type:'object',required:['paths'],additionalProperties:false,
    properties:{paths:{type:'array',minItems:1,maxItems:100,items:shortStringWithPath()},previousPlanId:uuid},
  }}},async request => {
    if (migrating) throw new Error('素材库正在迁移，请稍后再扫描');
    if (reconnecting) throw new Error('数据库连接正在更新，请稍后再扫描');
    importing++;
    try { return await active().scan(request.body.paths,request.body.previousPlanId); }
    finally { importing--; }
  });
  app.get('/tools/compress-storage',async()=>active().packCandidates());
  app.post<{Body:{ids:string[]}}>('/tools/compress-storage',{
    schema:{body:allRequired({ids:{type:'array',minItems:1,uniqueItems:true,items:uuid}})},
  },async request=>{
    const current = active();
    if (configuring || importing) throw new Error('请等待库维护或模板入库完成');
    configuring = migrating = true;
    backups?.stop();
    try {
      await backups?.waitForCurrent();
      return await current.packExisting(request.body.ids,options.progress);
    } finally {
      configuring = migrating = false;
      backups?.start();
    }
  });
  app.post<{Body:PublishInput}>('/publish',{schema:{body:{
    type:'object',required:['id','title','tags','preview','paths'],additionalProperties:false,
    properties:{id:uuid,title:shortString,tags,preview:shortStringWithPath(),
      paths:{type:'array',minItems:1,maxItems:200000,items:shortStringWithPath()},
      archives:{type:'array',uniqueItems:true,items:{...shortStringWithPath(),pattern:'\\.zip$'}}},
  }}},async request => {
    if (migrating) throw new Error('素材库正在迁移，请稍后再入库');
    if (reconnecting) throw new Error('数据库连接正在更新，请稍后再入库');
    if (!request.body.title.trim()) throw new Error('请输入模板名称');
    importing++;
    try { return await active().publish(request.body,options.progress); }
    finally { importing--; }
  });
  app.post<{Body:{search:string;tags:string[];mode:'all'|'any';trashed?:boolean;page?:number}}>('/library',{schema:{body:{
    type:'object',required:['search','tags','mode'],additionalProperties:false,
    properties:{search:{type:'string',maxLength:100},tags,mode:{enum:['all','any']},trashed:{type:'boolean'},
      page:{type:'integer',minimum:0,maximum:2147483647}},
  }}},async request => active().list(request.body.search,request.body.tags,request.body.mode,request.body.trashed,request.body.page));
  app.get(catalogStatusRoute,async (_request,reply) => {
    void reply.header('cache-control','no-store');
    return {source:'vfx-template-library',ready:library ? await library.catalogReady() : false};
  });
  app.get<{Querystring:{query?:string;offset?:number;limit?:number}}>(catalogRoute,{schema:{querystring:{
    type:'object',additionalProperties:false,
    properties:{query:{type:'string',maxLength:100},offset:{type:'integer',minimum:0,maximum:2147483647},
      limit:{type:'integer',minimum:1,maximum:25}},
  }}},async (request,reply) => {
    const {query='',offset=0,limit=10} = request.query;
    void reply.header('cache-control','no-store');
    return active().searchPublished(query,limit,offset);
  });
  app.get<{Params:{id:string}}>('/templates/:id',{schema:{params:idParams}},async request => active().detail(request.params.id));
  app.get<{Params:{id:string}}>('/templates/:id/directory',{schema:{params:idParams}},async request => {
    const library = active();
    const directory = library.projectDirectory(await library.detail(request.params.id));
    const info = await stat(directory).catch(error=>{
      if (error.code==='ENOENT') throw new Error('找不到归档目录，请检查素材库所在磁盘');
      throw error;
    });
    if (!info.isDirectory()) throw new Error('归档路径不是有效目录');
    return {directory};
  });
  app.put<{Params:{id:string};Body:{tags:string[]}}>('/templates/:id/tags',{schema:{params:idParams,body:allRequired({tags})}},async request => {
    await active().updateTags(request.params.id,request.body.tags);
    return {ok:true};
  });
  app.put<{Params:{id:string};Body:{description:string}}>('/templates/:id/description',{
    schema:{params:idParams,body:allRequired({description:{type:'string'}})},
  },async request => {
    await active().updateDescription(request.params.id,request.body.description);
    return {ok:true};
  });
  app.delete<{Params:{id:string}}>('/templates/:id',{schema:{params:idParams}},async request => {
    await active().setTrashed(request.params.id,true);
    return {ok:true};
  });
  app.post<{Params:{id:string}}>('/templates/:id/restore',{schema:{params:idParams}},async request => {
    await active().setTrashed(request.params.id,false);
    return {ok:true};
  });
  app.post('/backup',async () => {
    if (migrating) throw new Error('素材库正在迁移，请稍后再备份');
    active();
    if (!backups) throw new Error(backupDirectoryError);
    return backups.create();
  });
  app.post<{Body:{file:string}}>('/backup/restore',{
    schema:{body:allRequired({file:shortStringWithPath()})},
  },async request=>{
    const current = active();
    if (configuring) throw new Error('请等待配置更新或恢复完成');
    configuring = true;
    try { return {ok:true,result:await current.restoreDatabase(request.body.file)}; }
    finally { configuring = false; }
  });
  const sendPreview = (reply: FastifyReply, range: string | undefined, {file,bytes}: {file:string;bytes:number}) => {
    void reply.type('video/quicktime').header('accept-ranges','bytes');
    if (range) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(range);
      const start = match?.[1] ? Number(match[1]) : Math.max(0,bytes-Number(match?.[2]));
      const end = match?.[1] && match[2] ? Math.min(bytes-1,Number(match[2])) : bytes-1;
      if (!match || !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || (!match[1] && !match[2])) {
        return reply.code(416).header('content-range',`bytes */${bytes}`).send();
      }
      return reply.code(206).header('content-range',`bytes ${start}-${end}/${bytes}`).header('content-length',end-start+1)
        .send(createReadStream(file,{start,end}));
    }
    return reply.header('content-length',bytes).send(createReadStream(file));
  };
  app.get<{Params:{id:string}}>('/templates/:id/preview',{schema:{params:idParams}},async (request,reply) => {
    return sendPreview(reply,request.headers.range,await active().preview(request.params.id));
  });
  app.get<{Params:{id:string};Querystring:{path:string}}>('/scan/:id/preview',{
    schema:{params:idParams,querystring:allRequired({path:shortStringWithPath()})},
  },async (request,reply) => {
    return sendPreview(reply,request.headers.range,await active().scanPreview(request.params.id,request.query.path));
  });

  app.get<{Params:{id:string};Querystring:{mode:'slim'|'full'}}>('/templates/:id/package',{
    schema:{params:idParams,querystring:allRequired({mode:{enum:['slim','full']}})},
  },async (request,reply) => {
    const instance = active();
    const template = await instance.detail(request.params.id);
    const {mode} = request.query;
    const files = template.manifest.filter(file => mode === 'full' || file.path === template.preview || ['houdini','nuke'].includes(file.kind));
    for (const file of files) {
      if ((await stat(instance.filePath(template,file.path))).size !== file.bytes) throw new Error(`归档文件大小不符：${file.path}`);
    }
    const archive = new ZipFile();
    const log = request.log.child({module:'export',templateId:template.id,version:template.version,mode});
    const started = performance.now();
    const abort = new AbortController();
    let failed = false;
    log.info({files:files.length},'export.started');
    archive.on('error',error => {
      failed = true;
      log.error({err:error},'export.archive_failed');
      abort.abort();
      (archive.outputStream as PassThrough).destroy(error);
    });
    reply.raw.once('finish',() => {
      if (!failed) log.info({files:files.length,elapsedMs:Math.round(performance.now()-started)},'export.archive_completed');
    });
    reply.raw.once('close',() => {
      if (!reply.raw.writableFinished) {
        abort.abort();
        if (!failed) log.warn('export.connection_closed');
      }
    });
    archive.addBuffer(Buffer.from(JSON.stringify({formatVersion:1,mode,template,included:files.map(file=>file.path)},null,2)),'manifest.json');
    for (const file of files) {
      archive.addReadStreamLazy(`project/${file.path}`,{compress:false,size:file.bytes},callback => {
        const hash = createHash('sha256');
        const verified = new Transform({
          transform(chunk,_encoding,next) { hash.update(chunk); next(null,chunk); },
          flush(next) {
            next(hash.digest('hex') === file.sha256 ? undefined : new Error(`归档文件校验失败：${file.path}`));
          },
        });
        callback(null,verified);
        void pipeline(createReadStream(instance.filePath(template,file.path)),verified,{signal:abort.signal}).catch(error => {
          if (!abort.signal.aborted) archive.emit('error',error);
        });
      });
    }
    archive.end({forceZip64Format:true,comment:''});
    return reply.type('application/zip').send(archive.outputStream);
  });

  app.addHook('onClose',async () => {
    backups?.stop();
    await library?.close();
  });

  return {app,configured:()=>Boolean(library),async initialize() {
    try {
      settings = await options.loadSettings();
      if (settings) {
        library = await openLibrary(settings,app.log);
        if (invalidBackupDirectory(settings.backupDirectory)) {
          warning = '已暂停数据库备份。请在库设置中选择绝对路径的备份目录。';
          app.log.warn({module:'backup'},'backup.invalid_directory');
        } else updateBackup();
      }
    } catch (error) {
      warning = '无法打开已保存的库，请检查数据库连接和素材目录。';
      app.log.error({module:'startup',errorCode:(error as NodeJS.ErrnoException).code ?? 'startup_failed'},'library.start_failed');
    }
  }};
}

function shortStringWithPath() { return {type:'string',minLength:1,maxLength:1024}; }
