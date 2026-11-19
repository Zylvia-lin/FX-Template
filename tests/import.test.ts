import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import pg from 'pg';
import { scanSources, nativePath } from '../src/service/scanner';
import { createServer } from '../src/service/server';
import type { ArchiveProgress, Plan, Settings, Template } from '../src/contracts';

async function fixture() {
  const base = await mkdtemp(path.join(tmpdir(),'vfx-test-'));
  const source = path.join(base,'样本 project');
  for (const name of ['abc','backup','render','tex','hda','houdini/render/trail','houdini/geo','houdini/review','hdr','add_file/sub']) {
    await mkdir(path.join(source,name),{recursive:true});
  }
  for (const name of [
    'shot_efx_v01.hip','shot_efx_v01.nk','shot_efx_v01.nk~','shot_efx_ck_v001.mov','shot_ANI_ck.mov',
    'abc/fx.abc','abc/model.fbx','backup/old.hip','render/fx.1001.exr','render/fx.1003.exr',
    'tex/map.1001.exr','tex/map.1002.exr','hda/template.hda',
    'houdini/render/trail/trail.0000.exr','houdini/render/trail/trail.0100.exr',
    'houdini/render/trail/extras.0010.exr','houdini/render/trail/extras.0020.exr',
    'houdini/geo/sim.bgeo.sc','houdini/review/reference.mov','hdr/sky.hdr',
    'abc/sim.0001.bgeo.sc','abc/sim.0002.bgeo.sc','abc/standalone.bgeo','abc/plain.0001.sc',
    'add_file/sub/notes.txt','add_file/sub/reference.abc',
  ]) await writeFile(path.join(source,name),`fixture ${name}`);
  return {base,source,root:path.join(base,'library')};
}

test('按项目组织混合素材，选择预览并区分 UDIM 与帧序列',async () => {
  const {source,root} = await fixture();
  const plan = await scanSources([source],root);
  assert.equal(plan.preview,'shot_efx_ck_v001.mov');
  assert.deepEqual(plan.sequences.find(sequence=>sequence.path==='render/fx.%04d.exr'),
    {path:'render/fx.%04d.exr',first:1001,last:1003,count:2,missing:1});
  const trail = plan.rows.filter(row=>row.label.startsWith('houdini/render/trail/'));
  assert.equal(trail.length,1);
  assert.equal(trail[0].label,'houdini/render/trail/');
  assert.equal(trail[0].archiveLabel,'render/trail/');
  assert.equal(trail[0].paths.length,4);
  assert.equal(plan.rows.find(row=>row.label==='abc/')?.paths.length,3);
  assert.ok(!plan.rows.some(row=>row.label.endsWith('.sc')));
  for (const cache of ['houdini/geo/sim.bgeo.sc','abc/sim.0001.bgeo.sc','abc/sim.0002.bgeo.sc','abc/standalone.bgeo','abc/plain.0001.sc']) {
    assert.equal(plan.files.find(file=>file.path===cache)?.keep,false);
  }
  assert.equal(plan.rows.find(row=>row.label==='add_file/')?.paths.length,2);
  assert.equal(plan.files.find(file=>file.path==='add_file/sub/reference.abc')?.keep,false);
  assert.equal(plan.files.find(file=>file.path==='add_file/sub/reference.abc')?.archivePath,'add_file/sub/reference.abc');
  assert.equal(plan.files.find(file=>file.path==='houdini/geo/sim.bgeo.sc')?.archivePath,'geo/sim.bgeo.sc');
  assert.equal(plan.rows.find(row=>row.label==='houdini/geo/')?.archiveLabel,'geo/');
  assert.equal(plan.files.find(file=>file.path==='abc/sim.0001.bgeo.sc')?.archivePath,'geo/sim.0001.bgeo.sc');
  assert.equal(plan.files.find(x=>x.path==='abc/model.fbx')?.kind,'cache');
  assert.equal(plan.files.find(x=>x.path==='hda/template.hda')?.kind,'hda');
  assert.equal(plan.files.find(x=>x.path==='backup/old.hip')?.keep,false);
  assert.equal(plan.files.find(x=>x.path==='shot_efx_v01.nk~')?.keep,false);
  assert.equal((await scanSources([path.join(source,'shot_ANI_ck.mov')],root)).preview,'shot_ANI_ck.mov');
  await assert.rejects(scanSources([path.dirname(root)],root),/归档库/);
  for (const invalid of ['../bad','.git/../bad','a\\..\\b','foo/C:stream','aux.txt','name.']) {
    assert.throws(()=>nativePath(root,invalid),/路径/);
  }
});

test('两套独立数据库通过备份双向合并新 ID，缺少素材可重试', {skip:!process.env.VFX_TEST_PG_PORT}, async t=>{
  const {base,source} = await fixture();
  const port = Number(process.env.VFX_TEST_PG_PORT);
  const admin = new pg.Client({host:'127.0.0.1',port,user:'vfx_test',database:'postgres'});
  await admin.connect();
  const token = 'restore-test';
  const names = ['a','b'].map(name=>`vfx_merge_${name}_${randomUUID().replaceAll('-','')}`);
  const devices = names.map((database,index)=>{
    const root = path.join(base,`library-${index}`);
    const settings = {root,database,host:'127.0.0.1',port,user:'vfx_test',password:'',
      backupDirectory:path.join(base,`backup-${index}`),backupTime:'',backupRetention:2};
    const service = createServer({token,logPath:path.join(base,`restore-${index}.log`),
      loadSettings:async()=>undefined,saveSettings:async()=>undefined,progress:()=>undefined});
    const request = (method:'GET'|'PUT'|'POST'|'DELETE',url:string,payload?:object,extraHeaders?:object) =>
      service.app.inject({method,url,payload,headers:{authorization:`Bearer ${token}`,...extraHeaders}});
    return {root,settings,service,request};
  });
  t.after(async()=>{
    try {
      for (const device of devices) await device.service.app.close();
      for (const database of names) await admin.query(`DROP DATABASE IF EXISTS ${database}`);
    } finally { await admin.end(); }
  });
  const [a,b] = devices;
  for (const device of devices) {
    await device.service.initialize();
    const configured = await device.request('PUT','/settings',device.settings);
    assert.equal(configured.statusCode,200,configured.body);
  }
  const publish = async (device:typeof a,title:string,tags:string[]) => {
    const plan = (await device.request('POST','/scan',{paths:[source]})).json<Plan>();
    const result = await device.request('POST','/publish',{id:plan.id,title,tags,preview:plan.preview,
      paths:plan.files.filter(file=>file.keep).map(file=>file.path)});
    assert.equal(result.statusCode,200,result.body);
    return result.json<Template>();
  };
  const backup = async (device:typeof a) => {
    const result = await device.request('POST','/backup');
    assert.equal(result.statusCode,200,result.body);
    return result.json().file as string;
  };
  const restore = async (device:typeof a,file:string) => {
    const result = await device.request('POST','/backup/restore',{file});
    assert.equal(result.statusCode,200,result.body);
    return result.json().result;
  };
  const copyTemplate = async (from:typeof a,to:typeof a,id:string) =>
    cp(path.join(from.root,'templates',id),path.join(to.root,'templates',id),{recursive:true});

  const first = await publish(a,'设备 A\t归档\\样本\n第二行',['A 标签']);
  const recycled = await publish(a,'设备 A 回收站',['回收站标签']);
  assert.equal((await a.request('DELETE',`/templates/${recycled.id}`)).statusCode,200);
  const second = await publish(b,'设备 B 归档',['B 标签']);
  const fromA = await backup(a);
  const invalidFile = path.join(base,'invalid.dump');
  await cp(fromA,invalidFile);
  await writeFile(invalidFile.slice(0,-5)+'.sha256','0'.repeat(64));
  assert.match((await b.request('POST','/backup/restore',{file:invalidFile})).json().message,/备份校验失败/);
  assert.deepEqual(await restore(b,fromA),{imported:0,skipped:0,unavailable:2});

  await copyTemplate(a,b,first.id);
  const firstPreview = path.join(b.root,'templates',first.id,first.version,'project',first.preview);
  const original = await readFile(firstPreview);
  await writeFile(firstPreview,Buffer.alloc(original.length));
  assert.deepEqual(await restore(b,fromA),{imported:0,skipped:0,unavailable:2});
  await writeFile(firstPreview,original);
  assert.deepEqual(await restore(b,fromA),{imported:1,skipped:0,unavailable:1});
  const detail = (await b.request('GET',`/templates/${first.id}`)).json<Template>();
  assert.equal(detail.title,first.title);
  assert.deepEqual(detail.tags,first.tags);
  assert.equal(detail.version,first.version);
  assert.equal((await b.request('GET',`/templates/${first.id}/preview`,undefined,{range:'bytes=0-6'})).body,'fixture');

  assert.equal((await b.request('PUT',`/templates/${first.id}/tags`,{tags:['本机标签']})).statusCode,200);
  await copyTemplate(a,b,recycled.id);
  assert.deepEqual(await restore(b,fromA),{imported:1,skipped:1,unavailable:0});
  assert.deepEqual((await b.request('GET',`/templates/${first.id}`)).json<Template>().tags,['本机标签']);
  assert.deepEqual((await b.request('POST','/library',{search:'',tags:[],mode:'all',trashed:true})).json().items.map((item:Template)=>item.id),[recycled.id]);

  await copyTemplate(b,a,second.id);
  assert.deepEqual(await restore(a,await backup(b)),{imported:1,skipped:2,unavailable:0});
  assert.deepEqual((await a.request('GET',`/templates/${second.id}`)).json<Template>().tags,second.tags);
  assert.deepEqual((await a.request('GET',`/templates/${first.id}`)).json<Template>().tags,first.tags);
  assert.notDeepEqual(await readFile(path.join(a.root,'.vfx-library')),await readFile(path.join(b.root,'.vfx-library')));
});

test('从非标准目录递归识别工程、预览、缓存和渲染序列',async () => {
  const base = await mkdtemp(path.join(tmpdir(),'vfx-layout-'));
  const source = path.join(base,'素材');
  const contents = [
    'work/嵌套/FengFu.HIP','video/预览/FengFu_ck_v001.mov','image/蓝图/参考.png',
    'EFXSCN/制作/另一个.hip','EFXNUK/合成/FengFu.nk','EFXACH/相机/camera.abc',
    'EFXSQC/beauty/fire0101.exr','EFXSQC/beauty/fire0103.exr',
    'EFXQTM/archive_card.txt','work/lookdev/tex/paint.1001.exr','work/lookdev/tex/paint.1002.exr',
    'work/Tools/noise.hda','work/天空/sky.hdr','work/backup/old.hip',
    'add_file/外部参考/layout.abc',
  ];
  for (const file of contents) {
    const full = path.join(source,file);
    await mkdir(path.dirname(full),{recursive:true});
    await writeFile(full,'test');
  }
  const plan = await scanSources([source],path.join(base,'library'));
  const found = new Map(plan.files.map(file=>[file.path,file]));
  assert.equal(plan.preview,'video/预览/FengFu_ck_v001.mov');
  for (const [original,archive,kind] of [
    ['work/嵌套/FengFu.HIP','FengFu.HIP','houdini'],['EFXNUK/合成/FengFu.nk','FengFu.nk','nuke'],
    ['video/预览/FengFu_ck_v001.mov','FengFu_ck_v001.mov','movie'],
    ['EFXACH/相机/camera.abc','abc/EFXACH/相机/camera.abc','cache'],
    ['EFXSQC/beauty/fire0101.exr','render/EFXSQC/beauty/fire0101.exr','image'],
    ['work/lookdev/tex/paint.1001.exr','tex/paint.1001.exr','texture'],
    ['work/Tools/noise.hda','hda/work/Tools/noise.hda','hda'],['work/天空/sky.hdr','hdr/work/天空/sky.hdr','texture'],
  ]) {
    const result = found.get(original);
    assert.ok(result?.keep,original);
    assert.equal(result.kind,kind);
    assert.equal(result.archivePath,archive);
    assert.equal(result.customDirectory,undefined);
  }
  assert.deepEqual(plan.sequences,[{path:'EFXSQC/beauty/fire%04d.exr',first:101,last:103,count:2,missing:1}]);
  assert.ok(plan.rows.some(row=>row.label==='EFXSQC/beauty/'&&row.paths.length===2));
  for (const file of ['image/蓝图/参考.png','EFXQTM/archive_card.txt','work/backup/old.hip','add_file/外部参考/layout.abc']) {
    assert.equal(found.get(file)?.keep,false);
    assert.equal(found.get(file)?.archivePath,file);
  }
});

test('分散在多个目录的工程、序列和单文件可组合成同一预检',async () => {
  const base = await mkdtemp(path.join(tmpdir(),'vfx-multiple-'));
  const work = path.join(base,'project','work');
  const render = path.join(base,'separate','render');
  const video = path.join(base,'video');
  for (const directory of [work,render,video]) await mkdir(directory,{recursive:true});
  for (const name of ['fire.hip','fire.nk']) await writeFile(path.join(work,name),'工程');
  for (const name of ['fire.0101.exr','fire.0102.exr']) await writeFile(path.join(render,name),'序列帧');
  await writeFile(path.join(video,'fire.mov'),'已选视频');
  await writeFile(path.join(video,'other.mov'),'未选择的视频');
  const plan = await scanSources([work,render,path.join(work,'fire.hip'),path.join(video,'fire.mov')],path.join(base,'library'));
  assert.equal(plan.sources.length,4);
  assert.equal(plan.title,'fire');
  assert.equal(plan.preview,'video/fire.mov');
  assert.deepEqual(plan.files.map(file=>file.archivePath).sort(),['fire.hip','fire.mov','fire.nk','render/fire.0101.exr','render/fire.0102.exr']);
  assert.ok(plan.rows.some(row=>row.label==='render/'&&row.paths.length===2));
  assert.equal(plan.files.find(file=>file.path==='video/fire.mov')?.sourcePath,await realpath(path.join(video,'fire.mov')));
});

test('PostgreSQL 导入、同名隔离、标签、范围预览、打包与数据库备份', {skip:!process.env.VFX_TEST_PG_PORT}, async t => {
  const port = Number(process.env.VFX_TEST_PG_PORT);
  const {base,source,root} = await fixture();
  const database = `vfx_test_${randomUUID().replaceAll('-','')}`;
  const wrongDatabase = database + '_wrong';
  const restrictedRole = database + '_app';
  const pgClient = new pg.Client({host:'127.0.0.1',port,user:'vfx_test',database:'postgres'});
  let server:ReturnType<typeof createServer> | undefined;
  let roleCreated = false;
  t.after(async()=>{
    try {
      await server?.app.close();
      if (roleCreated) {
        await pgClient.query(`DROP DATABASE IF EXISTS ${wrongDatabase}`);
        await pgClient.query(`DROP DATABASE IF EXISTS ${database}`);
        await pgClient.query(`DROP ROLE ${restrictedRole}`);
      }
    } finally { await pgClient.end(); }
  });
  await pgClient.connect();
  await pgClient.query(`CREATE ROLE ${restrictedRole} LOGIN NOCREATEDB`);
  roleCreated = true;
  const settings = {root,host:'127.0.0.1',port,database,user:'vfx_test',password:'credential-not-for-logs',
    backupDirectory:path.join(base,'backups'),backupTime:'',backupRetention:2};
  const token = 'test-token';
  let stored:Settings|undefined;
  const progress:ArchiveProgress[] = [];
  const logPath = path.join(base,'operations.jsonl');
  const catalogToken = 'catalog-test';
  const service = server = createServer({token,logPath,catalogToken,loadSettings:async()=>stored,saveSettings:async s=>{stored=s;},progress:event=>progress.push(event)});
  await service.initialize();
  const request = (method:'GET'|'POST'|'PUT'|'DELETE',url:string,payload?:object,headers?:object) =>
    service.app.inject({method,url,payload,headers:{authorization:`Bearer ${token}`,...headers}});
  const catalog = (url:string,method:'GET'|'DELETE' = 'GET') =>
    service.app.inject({method,url,headers:{authorization:`Bearer ${catalogToken}`}});
  const catalogStatus = '/integrations/fx-agent/status';
  const catalogSearch = '/integrations/fx-agent/templates';
  assert.equal((await service.app.inject('/settings')).statusCode,401);
  assert.equal((await service.app.inject(catalogStatus)).statusCode,401);
  assert.deepEqual((await catalog(catalogStatus)).json(),{source:'vfx-template-library',ready:false});
  const restricted = await request('PUT','/settings',{...settings,user:restrictedRole});
  assert.equal(restricted.statusCode,400);
  assert.match(restricted.json().message,/没有创建数据库.*的权限/);
  const occupied = await request('PUT','/settings',{...settings,root:source});
  assert.equal(occupied.statusCode,400);
  assert.match(occupied.json().message,/素材目录已有内容/);
  assert.equal((await pgClient.query('SELECT 1 FROM pg_database WHERE datname=$1',[database])).rowCount,0);
  const response = await request('PUT','/settings',settings);
  assert.equal(response.statusCode,200,response.body);
  assert.equal((await catalog(catalogStatus)).json().ready,true);
  const relativeBackup = await request('PUT','/settings',{...settings,backupDirectory:'relative-backups'});
  assert.equal(relativeBackup.statusCode,400);
  assert.equal(stored?.backupDirectory,settings.backupDirectory);
  assert.equal((await pgClient.query('SELECT pg_encoding_to_char(encoding) AS encoding FROM pg_database WHERE datname=$1',[database])).rows[0]?.encoding,'UTF8');
  assert.equal(Object.hasOwn((await request('GET','/settings')).json().settings,'password'),false);
  const ids:string[] = [];
  let publishedVersion = '';
  const extraDirectory = path.join(base,'external');
  await mkdir(extraDirectory);
  const extraCache = path.join(extraDirectory,'external.abc');
  await writeFile(extraCache,'separate cache');
  const single = (await request('POST','/scan',{paths:[path.join(source,'shot_efx_v01.hip')]})).json<Plan>();
  const appended = await request('POST','/scan',{paths:[extraCache],previousPlanId:single.id});
  assert.equal(appended.statusCode,200,appended.body);
  const combined = appended.json<Plan>();
  assert.ok(combined.preview);
  assert.deepEqual(new Set(combined.files.map(file=>file.sourcePath)),
    new Set([...single.files.map(file=>file.sourcePath),await realpath(extraCache)]));
  for (const tags of [['写实','烟尘'],['写实','火焰']]) {
    const scanned = await request('POST','/scan',{paths:ids.length?[source,extraCache]:[source]});
    assert.equal(scanned.statusCode,200,scanned.body);
    const plan = scanned.json();
    const paths = plan.files.filter((file:{keep:boolean;path:string})=>file.keep||file.path.startsWith('add_file/')||file.path==='houdini/geo/sim.bgeo.sc').map((file:{path:string})=>file.path);
    const result = await request('POST','/publish',{id:plan.id,title:'同名',tags,preview:plan.preview,paths});
    assert.equal(result.statusCode,200,result.body);
    const updates = progress.filter(event=>event.id===plan.id);
    assert.equal(updates[0].stage,'copy');
    assert.ok(updates[0].currentFile?.path);
    const last = updates.at(-1)!;
    assert.equal(last.stage,'register');
    assert.equal(last.completed,paths.length);
    assert.equal(last.bytesCopied,last.totalBytes);
    if (!ids.length) publishedVersion = result.json().version;
    else {
      const {id,version} = result.json();
      assert.equal(await readFile(path.join(root,'templates',id,version,'project','abc/external/external.abc'),'utf8'),'separate cache');
    }
    ids.push(result.json().id);
  }
  assert.notEqual(ids[0],ids[1]);
  const found = await catalog(catalogSearch+'?query='+encodeURIComponent('烟尘'));
  assert.equal(found.statusCode,200,found.body);
  const published = found.json();
  assert.equal(published.source,'vfx-template-library');
  assert.deepEqual(published.items.map((item:Template)=>item.id),[ids[0]]);
  assert.deepEqual(Object.keys(published.items[0]).sort(),['bytes','files','id','publishedAt','tags','title']);
  assert.equal(published.nextOffset,null);
  const page = (await catalog(catalogSearch+'?limit=1')).json();
  assert.equal(page.nextOffset,1);
  const nextPage = (await catalog(catalogSearch+'?limit=1&offset='+page.nextOffset)).json();
  assert.notEqual(nextPage.items[0].id,page.items[0].id);
  assert.equal(nextPage.nextOffset,null);
  assert.equal((await catalog('/settings')).statusCode,401);
  assert.equal((await catalog(`/templates/${ids[0]}`,'DELETE')).statusCode,401);
  const project = path.join(root,'templates',ids[0],publishedVersion,'project');
  const directory = await request('GET',`/templates/${ids[0]}/directory`);
  assert.equal(directory.statusCode,200,directory.body);
  assert.equal(directory.json().directory,await realpath(project));
  assert.equal(await readFile(path.join(project,'render/trail/trail.0000.exr'),'utf8'),'fixture houdini/render/trail/trail.0000.exr');
  assert.equal(await readFile(path.join(project,'geo/sim.bgeo.sc'),'utf8'),'fixture houdini/geo/sim.bgeo.sc');
  await assert.rejects(readFile(path.join(project,'geo/sim.0001.bgeo.sc')),{code:'ENOENT'});
  assert.equal(await readFile(path.join(project,'add_file/sub/reference.abc'),'utf8'),'fixture add_file/sub/reference.abc');
  assert.equal(await readFile(path.join(project,'hdr/sky.hdr'),'utf8'),'fixture hdr/sky.hdr');
  await assert.rejects(readFile(path.join(project,'houdini/render/trail/trail.0000.exr')), {code:'ENOENT'});
  const detail = (await request('GET',`/templates/${ids[0]}`)).json();
  assert.equal(new Date(detail.publishedAt).toISOString(),detail.publishedAt);
  assert.ok(detail.manifest.some((file:{path:string;sourcePath?:string})=>file.path==='render/trail/trail.0000.exr'&&file.sourcePath==='houdini/render/trail/trail.0000.exr'));
  assert.ok(detail.sequences.some((sequence:{path:string})=>sequence.path==='render/trail/trail.%04d.exr'));
  const list = await request('POST','/library',{search:'同名',tags:['写实','烟尘'],mode:'all'});
  assert.equal(list.statusCode,200,list.body);
  assert.deepEqual(list.json().items.map((item:{id:string})=>item.id),[ids[0]]);
  assert.equal((await request('POST','/library',{search:'同名',tags:['烟尘','火焰'],mode:'any'})).json().items.length,2);
  const search = (text:string)=>request('POST','/library',{search:text,tags:[],mode:'any'});
  assert.equal((await search('同')).json().items.length,2);
  assert.deepEqual((await search('烟')).json().items.map((item:{id:string})=>item.id),[ids[0]]);
  assert.equal((await search('写')).json().items.length,2);
  assert.equal((await search('没有这项')).json().items.length,0);
  const preview = await request('GET',`/templates/${ids[0]}/preview`,undefined,{range:'bytes=0-6'});
  assert.equal(preview.statusCode,206,preview.body);
  assert.equal(preview.body,'fixture');
  const slim = await request('GET',`/templates/${ids[0]}/package?mode=slim`);
  assert.equal(slim.statusCode,200,slim.body.slice(0,100));
  assert.equal(slim.rawPayload.subarray(0,2).toString(),'PK');
  assert.ok(slim.rawPayload.includes(Buffer.from('project/shot_efx_v01.hip')));
  assert.ok(!slim.rawPayload.includes(Buffer.from('project/render/fx.1001.exr')));
  const full = await request('GET',`/templates/${ids[0]}/package?mode=full`);
  assert.equal(full.statusCode,200);
  assert.ok(full.rawPayload.includes(Buffer.from('project/render/fx.1001.exr')));
  assert.ok(full.rawPayload.includes(Buffer.from('project/render/trail/trail.0000.exr')));
  assert.ok(full.rawPayload.includes(Buffer.from('project/add_file/sub/reference.abc')));
  await writeFile(path.join(source,'houdini/geo/fx.abc'),'相同归档路径');
  const conflictingPlan = (await request('POST','/scan',{paths:[source]})).json();
  const conflict = await request('POST','/publish',{
    id:conflictingPlan.id,title:'冲突测试',tags:[],preview:conflictingPlan.preview,
    paths:conflictingPlan.files.filter((file:{keep:boolean;path:string})=>file.keep||file.path==='houdini/geo/fx.abc').map((file:{path:string})=>file.path),
  });
  assert.equal(conflict.statusCode,400);
  assert.match(conflict.json().message,/归档路径相同/);
  assert.equal((await request('PUT',`/templates/${ids[0]}/tags`,{tags:['重新分类']})).statusCode,200);
  const updated = {search:'',tags:['重新分类'],mode:'all'};
  const afterEdit = (await request('POST','/library',updated)).json();
  assert.equal(afterEdit.items[0].id,ids[0]);
  assert.ok(afterEdit.tags.includes('重新分类'));
  assert.ok(afterEdit.tags.includes('写实'));
  assert.ok(!afterEdit.tags.includes('烟尘'));
  assert.equal((await search('烟')).json().items.length,0);
  assert.equal((await request('DELETE',`/templates/${ids[0]}`)).statusCode,200);
  assert.deepEqual((await catalog(catalogSearch+'?query='+encodeURIComponent('重新分类'))).json().items,[]);
  const afterTrash = (await request('POST','/library',updated)).json();
  assert.equal(afterTrash.items.length,0);
  assert.ok(!afterTrash.tags.includes('重新分类'));
  assert.equal((await request('POST','/library',{...updated,trashed:true})).json().items[0].id,ids[0]);
  assert.equal((await request('POST',`/templates/${ids[0]}/restore`)).statusCode,200);
  assert.equal((await request('POST','/library',updated)).json().items[0].id,ids[0]);
  assert.equal((await request('GET',`/templates/${ids[0]}/preview`,undefined,{range:'bytes=0-6'})).body,'fixture');
  const dataClient = new pg.Client({host:'127.0.0.1',port,user:'vfx_test',database});
  await dataClient.connect();
  try {
    await dataClient.query("ALTER TABLE vfx_templates ADD CHECK (title <> '模拟登记失败')");
    await dataClient.query(`INSERT INTO vfx_templates(id,version,title,preview,manifest,sequences,bytes,files,deleted_at)
      SELECT gen_random_uuid(),gen_random_uuid(),'回收站测试 '||n,'preview.mov','[]','[]',1,1,now()
      FROM generate_series(1,501) AS n`);
  } finally { await dataClient.end(); }
  const trashQuery = {search:'',tags:[],mode:'any',trashed:true};
  const page0 = (await request('POST','/library',trashQuery)).json<{items:Template[];hasNext:boolean}>();
  const page1 = (await request('POST','/library',{...trashQuery,page:1})).json<typeof page0>();
  assert.equal(page0.items.length,500);
  assert.equal(page0.hasNext,true);
  assert.equal(page1.items.length,1);
  assert.equal(page1.hasNext,false);
  assert.ok(!page0.items.some(item=>item.id===page1.items[0].id));
  assert.equal((await request('POST',`/templates/${page1.items[0].id}/restore`)).statusCode,200);
  assert.equal((await request('POST','/library',trashQuery)).json<typeof page0>().hasNext,false);
  const failedPlan = (await request('POST','/scan',{paths:[source]})).json();
  const publishInput = {
    id:failedPlan.id,title:'模拟登记失败',tags:['不可见'],preview:failedPlan.preview,
    paths:failedPlan.files.filter((file:{keep:boolean;path:string})=>file.keep && file.path!=='houdini/geo/fx.abc').map((file:{path:string})=>file.path),
  };
  const rejected = await request('POST','/publish',publishInput);
  assert.equal(rejected.statusCode,400);
  assert.equal((await request('POST','/library',{search:'模拟登记失败',tags:[],mode:'all'})).json().items.length,0);
  assert.deepEqual(await readdir(path.join(root,'staging')),[]);
  for (const entry of await readdir(path.join(root,'templates'))) {
    if (!ids.includes(entry)) assert.deepEqual(await readdir(path.join(root,'templates',entry)),[]);
  }
  const retry = await request('POST','/publish',{...publishInput,title:'登记重试'});
  assert.equal(retry.statusCode,200,retry.body);
  assert.equal((await request('POST','/publish',{...publishInput,title:'登记重试'})).statusCode,400);
  const backup = await request('POST','/backup');
  assert.equal(backup.statusCode,200,backup.body);
  assert.equal((await readFile(backup.json().file)).subarray(0,5).toString(),'PGDMP');
  const unregisteredId = randomUUID();
  const unregisteredVersion = randomUUID();
  const stagedVersion = randomUUID();
  const staged = path.join(root,'staging',stagedVersion);
  const unregistered = path.join(root,'templates',unregisteredId,unregisteredVersion);
  for (const dir of [staged,unregistered]) {
    await mkdir(dir,{recursive:true});
    await writeFile(path.join(dir,'partial.abc'),'unfinished file');
  }
  for (const [templateId,version] of [[ids[0],publishedVersion],[unregisteredId,unregisteredVersion],[randomUUID(),stagedVersion]]) {
    await writeFile(path.join(root,'staging',`.import-${version}.json`),JSON.stringify({templateId,taskId:randomUUID()}));
  }
  await service.app.close();
  await pgClient.query(`CREATE DATABASE ${wrongDatabase}`);
  const wrongServer = createServer({token,logPath,loadSettings:async()=>undefined,saveSettings:async()=>undefined,progress:()=>undefined});
  try {
    const wrong = await wrongServer.app.inject({method:'PUT',url:'/settings',payload:{...settings,database:wrongDatabase},
      headers:{authorization:`Bearer ${token}`}});
    assert.equal(wrong.statusCode,400,wrong.body);
    assert.match(wrong.json().message,/没有此素材库的绑定记录/);
    assert.equal(await readFile(path.join(project,'geo/sim.bgeo.sc'),'utf8'),'fixture houdini/geo/sim.bgeo.sc');
    assert.ok((await readdir(path.join(root,'staging'))).includes(`.import-${publishedVersion}.json`));
  } finally { await wrongServer.app.close(); }
  server = createServer({token,logPath,loadSettings:async()=>({...settings,backupDirectory:'relative-backups'}),
    saveSettings:async()=>undefined,progress:()=>undefined});
  await server.initialize();
  const auth = {authorization:`Bearer ${token}`};
  const reopened = (await server.app.inject({url:'/settings',headers:auth})).json();
  assert.equal(reopened.configured,true);
  assert.match(reopened.warning,/已暂停数据库备份/);
  assert.equal((await server.app.inject({method:'POST',url:'/backup',headers:auth})).statusCode,400);
  assert.deepEqual(await readdir(path.join(root,'staging')),[`.import-${unregisteredVersion}.json`]);
  assert.equal(await readFile(path.join(unregistered,'partial.abc'),'utf8'),'unfinished file');
  assert.equal(await readFile(path.join(project,'geo/sim.bgeo.sc'),'utf8'),'fixture houdini/geo/sim.bgeo.sc');
  await server.app.close();

  let failSave = true;
  server = createServer({token,logPath,loadSettings:async()=>stored,saveSettings:async value=>{
    if (failSave) throw new Error('模拟设置写入失败');
    stored = value;
  },progress:()=>undefined});
  await server.initialize();
  const migrate = (root:string) => server!.app.inject({method:'POST',url:'/settings/migrate-storage',headers:auth,payload:{root}});
  assert.match((await migrate(path.join(root,'nested'))).json().message,/互相包含/);
  assert.match((await migrate(source)).json().message,/请选择空目录/);
  const destination = path.join(base,'新素材库');
  await mkdir(destination);
  const original = path.join(project,'geo/sim.bgeo.sc');
  const originalData = await readFile(original);
  await writeFile(original,Buffer.alloc(originalData.length));
  assert.match((await migrate(destination)).json().message,/素材校验失败/);
  await writeFile(original,originalData);
  assert.match((await migrate(destination)).json().message,/模拟设置写入失败/);
  assert.deepEqual(await readdir(destination),[]);
  assert.equal(stored?.root,root);
  assert.equal(path.relative(project,(await server.app.inject({url:`/templates/${ids[0]}/directory`,headers:auth})).json().directory),'');

  failSave = false;
  const migrated = await migrate(destination);
  assert.equal(migrated.statusCode,200,migrated.body);
  assert.deepEqual(stored,{...settings,root:destination});
  assert.deepEqual(await readFile(path.join(destination,'.vfx-library')),await readFile(path.join(root,'.vfx-library')));
  assert.deepEqual(await readFile(original),originalData);
  const movedProject = path.join(destination,path.relative(root,project));
  assert.deepEqual(await readFile(path.join(movedProject,'geo/sim.bgeo.sc')),originalData);
  assert.equal(path.relative(movedProject,(await server.app.inject({url:`/templates/${ids[0]}/directory`,headers:auth})).json().directory),'');
  assert.equal((await server.app.inject({url:`/templates/${ids[0]}/preview`,headers:{...auth,range:'bytes=0-6'}})).body,'fixture');
  await server.app.close();
  server = createServer({token,logPath,loadSettings:async()=>stored,saveSettings:async()=>undefined,progress:()=>undefined});
  await server.initialize();
  assert.equal((await server.app.inject({url:'/settings',headers:auth})).json().settings.root,destination);
  assert.equal(path.relative(movedProject,(await server.app.inject({url:`/templates/${ids[0]}/directory`,headers:auth})).json().directory),'');
  const planAfterMigration = (await server.app.inject({method:'POST',url:'/scan',headers:auth,payload:{paths:[source]}})).json<Plan>();
  const publishedAfterMigration = await server.app.inject({method:'POST',url:'/publish',headers:auth,
    payload:{...publishInput,id:planAfterMigration.id,title:'迁移后入库'}});
  assert.equal(publishedAfterMigration.statusCode,200,publishedAfterMigration.body);
  const publishedId = publishedAfterMigration.json<Template>().id;
  assert.ok((await readdir(path.join(destination,'templates'))).includes(publishedId));
  assert.ok(!(await readdir(path.join(root,'templates'))).includes(publishedId));

  const log = await readFile(logPath,'utf8');
  assert.match(log,/database\.created/);
  assert.match(log,/"errorCode":"42501"/);
  assert.match(log,/import\.published/);
  assert.match(log,/templates\.trashed/);
  assert.match(log,/templates\.restored/);
  assert.match(log,/import\.reconciled/);
  assert.match(log,/backup\.completed/);
  assert.doesNotMatch(log,/credential-not-for-logs|test-token/);
});
