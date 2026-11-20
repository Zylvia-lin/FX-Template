import assert from 'node:assert/strict';
import { test } from 'node:test';
import Fastify from 'fastify';
import { createWebServer } from '../src/service/web';

const id = '12345678-1234-1234-1234-123456789012';
const template = '/api/templates/'+id;
const authorization = 'Basic '+Buffer.from('vfx:test-password').toString('base64');
const headers = {authorization,'x-vfx-web':'1'};

test('Web 入口认证并限制管理操作、请求来源和回收站查询',async t=>{
  const backend = Fastify();
  backend.post('/library',async request=>{
    assert.equal(request.headers.authorization,'Bearer local-service');
    assert.deepEqual(request.body,{search:'烟雾',tags:[],mode:'any',page:0});
    return {items:[],tags:[],hasNext:false};
  });
  const origin = await backend.listen({host:'127.0.0.1',port:0});
  const web = createWebServer({
    origin,token:'local-service',password:'test-password',uiDirectory:'',configured:()=>true,
  });
  t.after(async()=>{await web.close();await backend.close();});

  assert.equal((await web.inject('/api/status')).statusCode,401);
  assert.deepEqual((await web.inject({url:'/api/status',headers})).json(),{configured:true});
  assert.equal((await web.inject({method:'PUT',url:template+'/tags',headers:{authorization},payload:{tags:[]}})).statusCode,403);
  assert.equal((await web.inject({method:'PUT',url:'/api/templates/%2e%2e/tags',headers,payload:{tags:[]}})).statusCode,404);
  assert.equal((await web.inject({method:'PUT',url:'/api/templates/invalid/tags',headers,payload:{tags:[]}})).statusCode,400);
  for (const [method,url] of [
    ['POST','/api/publish'],['POST','/publish'],['POST','/api/scan'],['DELETE',template],
    ['POST',template+'/restore'],['GET','/api/settings'],['PUT','/api/settings'],
    ['POST','/api/backup'],['GET','/api/logs'],['GET','/api/tools/compress-storage'],
  ] as const) {
    assert.equal((await web.inject({method,url,headers})).statusCode,404,`${method} ${url}`);
  }
  const response = await web.inject({method:'POST',url:'/api/library',headers,
    payload:{search:'烟雾',tags:[],mode:'any',page:0,trashed:true}});
  assert.equal(response.statusCode,200);
  assert.deepEqual(response.json(),{items:[],tags:[],hasNext:false});
});

test('Web 端可保存元数据，返回归档路径，并流式转发预览与下载',async t=>{
  const backend = Fastify();
  let tags:string[] = [];
  let description = '';
  const archived = {path:'project.hip',sourcePath:'D:/private/project.hip',bytes:3,sha256:'test',kind:'houdini'};
  backend.get('/templates/:id',async()=>({tags,description,manifest:[archived,{...archived,path:'render.zip',entries:[archived]}]}));
  backend.put<{Body:{tags:string[]}}>('/templates/:id/tags',async request=>{
    tags = request.body.tags;
    return {ok:true};
  });
  backend.put<{Body:{description:string}}>('/templates/:id/description',async request=>{
    description = request.body.description;
    return {ok:true};
  });
  backend.get('/templates/:id/preview',async (request,reply)=>{
    assert.equal(request.headers.range,'bytes=1-2');
    return reply.code(206).header('content-range','bytes 1-2/3').type('video/quicktime').send(Buffer.from('bc'));
  });
  backend.get<{Querystring:{mode:string}}>('/templates/:id/package',async (request,reply)=>
    reply.type('application/zip').send(Buffer.from(request.query.mode)));
  const origin = await backend.listen({host:'127.0.0.1',port:0});
  const web = createWebServer({
    origin,token:'local-service',password:'test-password',uiDirectory:'',configured:()=>true,
  });
  t.after(async()=>{await web.close();await backend.close();});

  for (const [field,payload] of [['tags',{tags:['烟雾']}],['description',{description:'飘散'}]] as const) {
    const response = await web.inject({method:'PUT',url:template+'/'+field,headers,payload});
    assert.deepEqual(response.json(),{ok:true});
  }
  const {sourcePath,...file} = archived;
  const detail = await web.inject({url:template,headers});
  assert.deepEqual(detail.json(),{tags:['烟雾'],description:'飘散',
    manifest:[file,{...file,path:'render.zip',entries:[file]}]});

  const preview = await web.inject({url:template+'/preview',headers:{authorization,range:'bytes=1-2'}});
  assert.equal(preview.statusCode,206);
  assert.equal(preview.headers['content-range'],'bytes 1-2/3');
  assert.equal(preview.body,'bc');
  for (const mode of ['slim','full']) {
    const download = await web.inject({url:template+'/package?mode='+mode,headers});
    assert.equal(download.statusCode,200,download.body);
    assert.equal(download.headers['content-disposition'],`attachment; filename="template-${id}-${mode}.zip"`);
    assert.equal(download.body,mode);
  }
});
