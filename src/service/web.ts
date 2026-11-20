import { createHash, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import type { ReadableStream } from 'node:stream/web';
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import type { DesktopApi, TemplateDetail } from '../contracts';

type TemplateParams = {id:string};
const templateId = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const digest = (value:string) => createHash('sha256').update(value).digest();
const templateRoute = (id:string) => '/templates/'+encodeURIComponent(id);

export function createWebServer(options:{
  origin:string; token:string; password:string; uiDirectory:string; configured:()=>boolean;
}) {
  const app = Fastify({bodyLimit:256*1024});
  const authorization = digest('Basic '+Buffer.from('vfx:'+options.password).toString('base64'));
  app.addHook('onRequest',async (request,reply)=>{
    void reply.header('cache-control','no-store').header('x-content-type-options','nosniff')
      .header('content-security-policy',"frame-ancestors 'none'");
    if (!timingSafeEqual(digest(request.headers.authorization??''),authorization)) {
      return reply.header('www-authenticate','Basic realm="VFX Template Library", charset="UTF-8"')
        .code(401).send({message:'请登录模板库'});
    }
    if ((request.method==='POST'||request.method==='PUT') && request.headers['x-vfx-web']!=='1') {
      return reply.code(403).send({message:'请求来源无效'});
    }
  });
  app.addHook('preValidation',async (request,reply)=>{
    if (request.routeOptions.url?.startsWith('/api/templates/') && !templateId.test((request.params as TemplateParams).id)) {
      return reply.code(400).send({message:'模板编号无效'});
    }
  });
  app.setErrorHandler((error:Error & {statusCode?:number},_request,reply)=>{
    const status = error.statusCode && error.statusCode<500 ? error.statusCode : 502;
    void reply.code(status).send({message:status===502?'模板库暂时无法处理请求':'请求内容无效'});
  });

  const forward = async (request:FastifyRequest,reply:FastifyReply,route:string,body?:unknown)=>{
    const abort = new AbortController();
    reply.raw.once('close',()=>{
      if (!reply.raw.writableFinished) abort.abort();
    });
    const response = await fetch(options.origin+route,{
      method:request.method,
      redirect:'error',
      signal:abort.signal,
      headers:{
        authorization:'Bearer '+options.token,
        ...(body===undefined?{}:{'content-type':'application/json'}),
        ...(request.headers.range ? {range:request.headers.range} : {}),
      },
      body:body===undefined ? undefined : JSON.stringify(body),
    });
    if (!response.ok && response.status!==416) {
      await response.body?.cancel();
      const status = response.status>=500 ? 502 : response.status;
      void reply.code(status).send({message:status===400?'操作未完成，请检查输入或刷新模板列表':'模板库请求失败'});
      return;
    }
    return response;
  };
  const send = async (request:FastifyRequest,reply:FastifyReply,route:string,body?:unknown,filename?:string)=>{
    const response = await forward(request,reply,route,body);
    if (!response) return reply;
    for (const name of ['accept-ranges','content-range','content-length','content-type']) {
      const value = response.headers.get(name);
      if (value) void reply.header(name,value);
    }
    if (filename && response.ok) void reply.header('content-disposition',`attachment; filename="${filename}"`);
    return reply.code(response.status).send(response.body ?
      Readable.fromWeb(response.body as ReadableStream<Uint8Array>) : undefined);
  };

  app.get('/',async (_request,reply)=>
    reply.type('text/html; charset=utf-8').send(await readFile(path.join(options.uiDirectory,'index.html'))));
  app.get<{Params:{file:string}}>('/assets/:file',async (request,reply)=>{
    const {file} = request.params;
    if (!/^[a-zA-Z0-9_-]+\.(?:js|css)$/.test(file)) return reply.code(404).send();
    const content = await readFile(path.join(options.uiDirectory,'assets',file)).catch((error:NodeJS.ErrnoException)=>{
      if (error.code!=='ENOENT') throw error;
    });
    if (!content) return reply.code(404).send();
    return reply.type(file.endsWith('.js')?'text/javascript':'text/css').send(content);
  });
  app.get('/api/status',async ()=>({configured:options.configured()}));
  app.post<{Body:Parameters<DesktopApi['list']>[0]}>('/api/library',async (request,reply)=>{
    const {search,tags,mode,page} = request.body??{};
    return send(request,reply,'/library',{search,tags,mode,page});
  });
  app.get<{Params:TemplateParams}>('/api/templates/:id',async (request,reply)=>{
    const response = await forward(request,reply,templateRoute(request.params.id));
    if (!response) return reply;
    const detail = await response.json() as TemplateDetail;
    detail.manifest = detail.manifest.map(({path,bytes,sha256,kind,entries})=>({
      path,bytes,sha256,kind,
      entries:entries?.map(({path,bytes,sha256,kind})=>({path,bytes,sha256,kind})),
    }));
    return detail;
  });
  app.put<{Params:TemplateParams;Body:{tags:string[]}}>('/api/templates/:id/tags',async (request,reply)=>
    send(request,reply,templateRoute(request.params.id)+'/tags',request.body));
  app.put<{Params:TemplateParams;Body:{description:string}}>('/api/templates/:id/description',async (request,reply)=>
    send(request,reply,templateRoute(request.params.id)+'/description',request.body));
  app.get<{Params:TemplateParams}>('/api/templates/:id/preview',{exposeHeadRoute:false},async (request,reply)=>
    send(request,reply,templateRoute(request.params.id)+'/preview'));
  app.get<{Params:TemplateParams;Querystring:{mode?:string}}>('/api/templates/:id/package',{exposeHeadRoute:false},async (request,reply)=>{
    const {id} = request.params;
    const {mode} = request.query;
    if (mode!=='slim'&&mode!=='full') {
      return reply.code(400).send({message:'导出类型无效'});
    }
    return send(request,reply,templateRoute(id)+'/package?mode='+mode,undefined,`template-${id}-${mode}.zip`);
  });
  return app;
}
