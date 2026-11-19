import { app, BrowserWindow, dialog, ipcMain, Menu, protocol, safeStorage, shell, Tray } from 'electron';
import { createWriteStream, mkdirSync } from 'node:fs';
import { mkdir, readFile, rename, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { Readable } from 'node:stream';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import type { CatalogFilters, DesktopApi, PublishInput, Settings, Template } from '../contracts';
import { createServer } from '../service/server';
import { createCatalogFilterStore, writeJson } from './preferences';

protocol.registerSchemesAsPrivileged([{scheme:'vfx-media',privileges:{standard:true,secure:true,stream:true}}]);

const directory = path.dirname(fileURLToPath(import.meta.url));
const token = randomUUID()+randomUUID();
let tray: Tray | undefined;
const userData = process.env.VFX_USER_DATA ? path.resolve(process.env.VFX_USER_DATA)
  : path.join(app.getPath('appData'),'vfx-template-library');
mkdirSync(userData,{recursive:true});
app.setPath('userData',userData);
if (process.platform==='win32') app.setAppUserModelId('com.zylvia.vfx-template-library');

async function start() {
  const statePath = app.getPath('userData');
  const logDirectory = path.join(statePath,'logs');
  const logPath = path.join(logDirectory,`application-${new Date().toISOString().slice(0,10)}.jsonl`);
  const settingsFile = path.join(statePath,'settings.json');
  const catalogFile = path.join(statePath,'fx-agent-catalog.json');
  const catalogToken = randomUUID()+randomUUID();
  const catalogFilters = createCatalogFilterStore(path.join(statePath,'catalog-filters.json'));
  await mkdir(logDirectory,{recursive:true});
  let window: BrowserWindow | undefined;
  const service = createServer({
    token,logPath,catalogToken,
    async loadSettings() {
      try {
        const config = JSON.parse(await readFile(settingsFile,'utf8')) as Settings;
        const password = config.password ? (await safeStorage.decryptStringAsync(Buffer.from(config.password,'base64'))).result : '';
        return {...config,password};
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
        throw error;
      }
    },
    async saveSettings(settings) {
      if (settings.password && !(await safeStorage.isAsyncEncryptionAvailable())) throw new Error('Windows 凭据加密不可用，无法保存数据库密码');
      const password = settings.password ? (await safeStorage.encryptStringAsync(settings.password)).toString('base64') : '';
      await writeJson(settingsFile,{...settings,password});
    },
    progress: event => { if (window && !window.isDestroyed()) window.webContents.send('progress',event); },
  });
  const origin = await service.app.listen({host:'127.0.0.1',port:0});
  await service.initialize();
  await writeJson(catalogFile,{port:Number(new URL(origin).port),token:catalogToken}).catch(error=>{
    service.app.log.warn({module:'fx-agent',errorCode:(error as NodeJS.ErrnoException).code},'catalog.connection_file_write_failed');
  });
  service.app.log.info({module:'desktop',version:app.getVersion()},'desktop.started');
  const abort = new AbortController();
  const access = async (route: string,method='GET',body?:unknown, signal: AbortSignal = abort.signal) => {
    const response = await fetch(origin+route,{
      method,signal,headers:{authorization:`Bearer ${token}`,...(body !== undefined ? {'content-type':'application/json'} : {})},
      ...(body !== undefined ? {body:JSON.stringify(body)} : {}),
    });
    if (!response.ok) {
      const error = await response.json().catch(() => null) as {message?:string} | null;
      throw new Error(error?.message ?? `请求失败（${response.status}）`);
    }
    return response;
  };
  const json = async (route:string,method?:string,body?:unknown) => (await access(route,method,body)).json();
  protocol.handle('vfx-media', async request => {
    const url = new URL(request.url);
    const id = url.pathname.slice(1);
    if (!/^[0-9a-f-]{36}$/.test(id)) return new Response(null,{status:404});
    const source = url.searchParams.get('path');
    const route = url.hostname === 'preview' ? '/templates/'+id+'/preview'
      : url.hostname === 'scan-preview' && source ? '/scan/'+id+'/preview?'+new URLSearchParams({path:source})
      : undefined;
    if (!route) return new Response(null,{status:404});
    const range = request.headers.get('range');
    try {
      const response = await fetch(origin+route,{
        signal:AbortSignal.any([request.signal,abort.signal]),
        headers:{authorization:`Bearer ${token}`,...(range ? {range} : {})},
      });
      const headers = new Headers(response.headers);
      for (const name of ['connection','keep-alive','transfer-encoding']) headers.delete(name);
      return new Response(response.body,{status:response.status,headers});
    } catch (error) {
      if (!request.signal.aborted) service.app.log.warn({module:'preview',templateId:id,errorMessage:(error as Error).message},'preview.failed');
      return new Response(null,{status:502});
    }
  });
  const handle = (name:string, fn:(...args:any[])=>unknown) => {
    ipcMain.handle(name,async (event,...args) => {
      if (!window || event.sender !== window.webContents || event.senderFrame?.parent) throw new Error('无权调用桌面接口');
      return fn(...args);
    });
  };
  handle('status',() => json('/settings'));
  handle('catalog-filters-load',async()=>{
    try { return await catalogFilters.load(); }
    catch (error) {
      service.app.log.warn({err:error,module:'settings'},'catalog.filters_read_failed');
      throw new Error('无法读取上次的标签筛选配置');
    }
  });
  handle('catalog-filters-save',async (filters:CatalogFilters)=>{
    try {
      await catalogFilters.save(filters);
      service.app.log.info({module:'settings',mode:filters.mode,tags:filters.tags.length},'catalog.filters_saved');
    } catch (error) {
      service.app.log.warn({err:error,module:'settings'},'catalog.filters_write_failed');
      throw new Error('无法保存标签筛选配置');
    }
  });
  handle('configure',async (input:Settings) => {
    try {
      await json('/settings','PUT',input);
      return {ok:true};
    } catch (error) {
      return {ok:false,message:(error as Error).message};
    }
  });
  let libraryMaintenance:Promise<unknown> | undefined;
  const maintenance = async (url:string,payload:object) => {
    if (libraryMaintenance) return {ok:false,message:'素材库维护操作正在运行'};
    // Library maintenance can take longer than the HTTP header timeout.
    libraryMaintenance = service.app.inject({
      method:'POST',url,headers:{authorization:`Bearer ${token}`},payload,
    }).then(response=>response.json());
    try { return await libraryMaintenance; }
    finally { libraryMaintenance = undefined; }
  };
  handle('migrate-storage',(root:string)=>maintenance('/settings/migrate-storage',{root}));
  handle('restore-database',async ()=>{
    const {filePaths:[file]} = await dialog.showOpenDialog(window!,{
      title:'选择要增量恢复的数据库备份',properties:['openFile'],
      filters:[{name:'特效模板库数据库备份',extensions:['dump']}],
    });
    if (file) return maintenance('/backup/restore',{file});
  });
  handle('directory',async () => (await dialog.showOpenDialog(window!,{properties:['openDirectory','createDirectory']})).filePaths[0]);
  handle('import-directories',async () => (await dialog.showOpenDialog(window!,{
    properties:['openDirectory','multiSelections'],
  })).filePaths);
  handle('source',async () => (await dialog.showOpenDialog(window!,{
    properties:['openFile','multiSelections'],
  })).filePaths);
  handle('scan',(paths:string[],previousPlanId?:string) => json('/scan','POST',{paths,previousPlanId}));
  const pendingPublishes = new Set<Promise<unknown>>();
  let waitingToQuit = false;
  handle('publish',async (input:PublishInput) => {
    if (waitingToQuit) return {ok:false,message:'应用将在入库队列完成后退出'};
    // Archiving may outlast HTTP header timeouts. This service already runs in the desktop process.
    const pending = service.app.inject({
      method:'POST',url:'/publish',headers:{authorization:`Bearer ${token}`},payload:input,
    });
    pendingPublishes.add(pending);
    try {
      const response = await pending;
      const result = response.json();
      return response.statusCode < 400
        ? {ok:true,template:result as Template}
        : {ok:false,message:result.message ?? `归档失败（${response.statusCode}）`};
    } finally { pendingPublishes.delete(pending); }
  });
  handle('list',(input:Parameters<DesktopApi['list']>[0]) => json('/library','POST',input));
  handle('detail',(id:string) => json(`/templates/${encodeURIComponent(id)}`));
  handle('pack-candidates',() => json('/tools/compress-storage'));
  handle('pack-existing',async (ids:string[])=>{
    const response = await service.app.inject({
      method:'POST',url:'/tools/compress-storage',headers:{authorization:`Bearer ${token}`},payload:{ids},
    });
    const result = response.json();
    if (response.statusCode>=400) throw new Error(result.message ?? '压缩存储库失败');
    return result;
  });
  handle('tags',(id:string,tags:string[]) => json(`/templates/${encodeURIComponent(id)}/tags`,'PUT',{tags}));
  handle('description',(id:string,description:string) => json(`/templates/${encodeURIComponent(id)}/description`,'PUT',{description}));
  handle('trash',(id:string) => json(`/templates/${encodeURIComponent(id)}`,'DELETE'));
  handle('restore',(id:string) => json(`/templates/${encodeURIComponent(id)}/restore`,'POST'));
  handle('backup',() => json('/backup','POST'));
  handle('logs',async () => {
    const error = await shell.openPath(logDirectory);
    if (error) throw new Error(error);
  });
  handle('template-directory',async (id:string) => {
    const {directory} = await json(`/templates/${encodeURIComponent(id)}/directory`) as {directory:string};
    const error = await shell.openPath(directory);
    if (error) {
      service.app.log.warn({module:'desktop',templateId:id,errorMessage:error},'template.directory_open_failed');
      throw new Error('无法打开模板目录，请检查路径和权限');
    }
    service.app.log.info({module:'desktop',templateId:id},'template.directory_opened');
  });
  handle('export',async (id:string,mode:'slim'|'full') => {
    const template = await json(`/templates/${encodeURIComponent(id)}`) as Template;
    const title = template.title.replace(/[<>:"/\\|?*\x00-\x1F]/g,'_').slice(0,70);
    const selection = await dialog.showSaveDialog(window!,{
      defaultPath:`${title}-${template.id.slice(0,8)}-${mode==='slim'?'精简':'完整'}.zip`,
      filters:[{name:'模板包',extensions:['zip']}],
    });
    if (!selection.filePath) return undefined;
    const temporary = selection.filePath+`.${randomUUID()}.partial`;
    const started = performance.now();
    const log = service.app.log.child({module:'desktop-export',taskId:randomUUID(),templateId:id,mode});
    try {
      const response = await access(`/templates/${encodeURIComponent(id)}/package?mode=${encodeURIComponent(mode)}`);
      if (!response.body) throw new Error('导出没有返回数据');
      await pipeline(Readable.fromWeb(response.body as unknown as NodeReadableStream),createWriteStream(temporary,{flags:'wx'}));
      await rename(temporary,selection.filePath);
      log.info({elapsedMs:Math.round(performance.now()-started)},'export.saved');
      return selection.filePath;
    } catch (error) {
      log.error({err:error,elapsedMs:Math.round(performance.now()-started)},'export.save_failed');
      await rm(temporary,{force:true}).catch(() => undefined);
      throw error;
    }
  });

  window = new BrowserWindow({
    title:'特效模板库',width:1340,height:860,minWidth:880,minHeight:640,backgroundColor:'#15181a',
    webPreferences:{preload:path.join(directory,'preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true},
  });
  window.setMenuBarVisibility(false);
  window.webContents.setWindowOpenHandler(() => ({action:'deny'}));
  window.webContents.on('will-navigate',event => event.preventDefault());
  window.webContents.on('render-process-gone',(_event,details) => service.app.log.error({module:'desktop',details},'desktop.renderer_exited'));
  await window.loadFile(path.join(directory,'ui','index.html'));
  service.app.log.info({module:'desktop'},'desktop.window_loaded');
  let quitting = false;
  if (process.platform === 'win32') {
    try {
      tray = new Tray(await app.getFileIcon(process.execPath,{size:'small'}));
      tray.setToolTip('特效模板库');
      tray.setContextMenu(Menu.buildFromTemplate([
        {label:'打开特效模板库',click:()=>window?.show()},
        {label:'退出',click:()=>app.quit()},
      ]));
      tray.on('double-click',()=>window?.show());
      window.on('close',event => {
        if (quitting) return;
        event.preventDefault();
        window?.hide();
        service.app.log.info({module:'desktop'},'desktop.hidden_in_tray');
      });
    } catch (error) {
      service.app.log.warn({module:'desktop',err:error},'desktop.tray_unavailable');
    }
  }
  app.on('second-instance',()=>{window?.show();window?.focus();});
  app.on('before-quit',event => {
    const pending = pendingPublishes.size ? Promise.allSettled(pendingPublishes)
      : libraryMaintenance ?? catalogFilters.pendingWrite();
    if (pending) {
      event.preventDefault();
      if (!waitingToQuit) {
        waitingToQuit = true;
        void pending.finally(()=>{
          waitingToQuit = false;
          app.quit();
        }).catch(()=>undefined);
      }
      return;
    }
    quitting = true;
    tray?.destroy();
    abort.abort();
    void service.app.close().catch(() => undefined);
  });
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.whenReady().then(start).catch(error => {
    dialog.showErrorBox('特效模板库启动失败',(error as Error).message);
    app.quit();
  });
  app.on('window-all-closed',() => app.quit());
}
