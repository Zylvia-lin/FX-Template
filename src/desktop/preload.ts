import { contextBridge, ipcRenderer, webUtils } from 'electron';
import type { DesktopApi, RestoreResult, Template } from '../contracts';

const api: DesktopApi = {
  status: () => ipcRenderer.invoke('status'),
  loadCatalogFilters: () => ipcRenderer.invoke('catalog-filters-load'),
  saveCatalogFilters: filters => ipcRenderer.invoke('catalog-filters-save',filters),
  async configure(settings) {
    const result = await ipcRenderer.invoke('configure',settings) as {ok:boolean;message?:string};
    if (!result.ok) throw new Error(result.message ?? '无法保存数据库配置');
  },
  async migrateStorage(root) {
    const result = await ipcRenderer.invoke('migrate-storage',root) as {ok:boolean;message?:string};
    if (!result.ok) throw new Error(result.message ?? '无法迁移素材库');
  },
  pickDirectory: () => ipcRenderer.invoke('directory'),
  pickDirectories: () => ipcRenderer.invoke('import-directories'),
  pickSource: () => ipcRenderer.invoke('source'),
  scan: (paths,previousPlanId) => ipcRenderer.invoke('scan',paths,previousPlanId),
  async publish(input) {
    const result = await ipcRenderer.invoke('publish',input) as
      {ok:true;template:Template} | {ok:false;message:string};
    if (!result.ok) throw new Error(result.message);
    return result.template;
  },
  list: input => ipcRenderer.invoke('list',input),
  detail: id => ipcRenderer.invoke('detail',id),
  updateTags: (id,tags) => ipcRenderer.invoke('tags',id,tags),
  updateDescription: (id,description) => ipcRenderer.invoke('description',id,description),
  trash: id => ipcRenderer.invoke('trash',id),
  restore: id => ipcRenderer.invoke('restore',id),
  backup: () => ipcRenderer.invoke('backup'),
  async restoreDatabase() {
    const response = await ipcRenderer.invoke('restore-database') as
      {ok:true;result:RestoreResult} | {ok:false;message:string} | undefined;
    if (!response) return;
    if (!response.ok) throw new Error(response.message ?? '无法恢复数据库备份');
    return response.result;
  },
  export: (id,mode) => ipcRenderer.invoke('export',id,mode),
  openTemplateDirectory: id => ipcRenderer.invoke('template-directory',id),
  openLogs: () => ipcRenderer.invoke('logs'),
  onProgress(listener) {
    const handle = (_event: unknown, payload: Parameters<typeof listener>[0]) => listener(payload);
    ipcRenderer.on('progress',handle);
    return () => ipcRenderer.removeListener('progress',handle);
  },
  pathsForDrop: files => files.map(file => webUtils.getPathForFile(file)).filter(Boolean),
};

contextBridge.exposeInMainWorld('vfx',api);
