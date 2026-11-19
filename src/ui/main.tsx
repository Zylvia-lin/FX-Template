import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { ArchiveProgress, CatalogFilters, DesktopApi, Plan, Settings, Template, TemplateDetail } from '../contracts';
import './style.css';

declare global { interface Window {vfx: DesktopApi;} }
declare const __APP_RELEASE__: {version:string;author:string;copyright:string};
const api = window.vfx;
const defaults: Settings = {root:'',host:'127.0.0.1',port:5432,database:'vfx_templates_dev',user:'postgres',password:'',backupDirectory:'',backupTime:'03:00',backupRetention:14};
const bytes = (n:number) => n >= 1073741824 ? `${(n/1073741824).toFixed(2)} GB` : n >= 1048576 ? `${(n/1048576).toFixed(1)} MB` : `${(n/1024).toFixed(1)} KB`;
const maxCardZoom = 8;
const publicationTime = new Intl.DateTimeFormat('zh-CN',{dateStyle:'medium',timeStyle:'medium'});
const tagKey = (value:string) => value.normalize('NFKC').trim().toLowerCase();

function mergeTags(tags:string[],draft:string) {
  const next = new Map(tags.map(tag=>[tagKey(tag),tag]));
  for (const raw of draft.split(/[,，、\n]/)) {
    const label = raw.trim();
    const key = tagKey(label);
    if (key && !next.has(key)) next.set(key,label);
  }
  return [...next.values()];
}

function TagField({tags,draft,disabled,onTags,onDraft}:{
  tags:string[];draft:string;disabled:boolean;
  onTags:(tags:string[],submitted?:boolean)=>void;onDraft:(draft:string)=>void;
}) {
  const id = useId();
  const field = useRef<HTMLInputElement>(null);
  return <div className="tag-field">
    <label htmlFor={id}>标签</label>
    <div className="tag-input">
      {tags.map(tag=><span className="tag-chip" key={tagKey(tag)}>
        <span>{tag}</span>
        <button type="button" disabled={disabled} aria-label={`移除标签 ${tag}`} onClick={()=>{
          onTags(tags.filter(value=>value!==tag));
          field.current?.focus();
        }}>×</button>
      </span>)}
      <input id={id} ref={field} value={draft} readOnly={disabled} placeholder="输入标签后按回车" onChange={event=>onDraft(event.target.value)}
        onKeyDown={event=>{
          if (event.key!=='Enter' || event.nativeEvent.isComposing || event.keyCode===229) return;
          event.preventDefault();
          if (!disabled) onTags(mergeTags(tags,draft),true);
        }}/>
    </div>
  </div>;
}
const errorText = (error:unknown) => (error instanceof Error ? error.message : String(error)).replace(/^Error invoking remote method .*?: Error: /,'');

function useBanner() {
  const [message,setMessage] = useState<{text:string}>();
  const show = useCallback((text:string)=>setMessage(text?{text}:undefined),[]);
  useEffect(()=>{
    if (!message) return;
    const timeout = setTimeout(()=>setMessage(current=>current===message?undefined:current),10_000);
    return ()=>clearTimeout(timeout);
  },[message]);
  return [message?.text??'',show] as const;
}

function App() {
  const [status,setStatus] = useState<Awaited<ReturnType<DesktopApi['status']>>>();
  const [panel,setPanel] = useState<'library'|'settings'|'trash'>('library');
  const [items,setItems] = useState<Template[]>([]);
  const [trashPage,setTrashPage] = useState(0);
  const [trashHasNext,setTrashHasNext] = useState(false);
  const [trashLoading,setTrashLoading] = useState(false);
  const [cardZoom,setCardZoom] = useState(0);
  const [available,setAvailable] = useState<string[]>([]);
  const [activeTags,setActiveTags] = useState<string[]>([]);
  const [mode,setMode] = useState<'all'|'any'>('any');
  const filterSnapshot = useRef<string|undefined>(undefined);
  const [search,setSearch] = useState('');
  const [selected,setSelected] = useState<TemplateDetail>();
  const pendingMetadata = useRef<Promise<unknown>>(Promise.resolve());
  const [plan,setPlan] = useState<Plan>();
  const [busy,setBusy] = useState('');
  const [error,setError] = useBanner();
  const [notice,setNotice] = useBanner();
  const [revision,setRevision] = useState(0);
  const [dragging,setDragging] = useState(false);
  const [progress,setProgress] = useState<ArchiveProgress>();
  const changeCardZoom = useCallback((step:number)=>{
    setCardZoom(previous=>Math.min(maxCardZoom,Math.max(0,previous+step)));
  },[]);

  useEffect(() => {
    if (!api) { setError('请通过 Windows 桌面程序启动模板库'); return; }
    const filters = api.loadCatalogFilters().catch(err=>{
      setError(errorText(err));
      return {mode:'any',tags:[]} satisfies CatalogFilters;
    });
    Promise.all([api.status(),filters]).then(([current,saved])=>{
      filterSnapshot.current = JSON.stringify(saved);
      setMode(saved.mode);setActiveTags(saved.tags);setStatus(current);
    }).catch(err=>setError(errorText(err)));
    return api.onProgress(setProgress);
  },[]);
  useEffect(()=>{
    if (!status?.configured) return;
    const filters = {mode,tags:activeTags};
    const snapshot = JSON.stringify(filters);
    if (filterSnapshot.current===snapshot) return;
    filterSnapshot.current = snapshot;
    void api.saveCatalogFilters(filters).catch(err=>{
      if (filterSnapshot.current===snapshot) {
        filterSnapshot.current = undefined;
        setError(errorText(err));
      }
    });
  },[mode,activeTags,status?.configured,setError]);
  const trashOpen = panel==='trash';
  useEffect(()=>{
    if (!status?.configured) return;
    let obsolete = false;
    const timeout = setTimeout(()=>void api.list({search:trashOpen?'':search,tags:trashOpen?[]:activeTags,mode,
      trashed:trashOpen,page:trashOpen?trashPage:undefined}).then(result=>{
      if (obsolete) return;
      if (trashOpen) {
        if (!result.items.length && trashPage>0) {setTrashPage(trashPage-1);return;}
        setTrashHasNext(result.hasNext);
        setTrashLoading(false);
      }
      setItems(result.items);setAvailable(result.tags);
      const availableTags = new Set(result.tags);
      setActiveTags(previous=>{
        const remaining = previous.filter(tag=>availableTags.has(tag));
        return remaining.length===previous.length ? previous : remaining;
      });
    }).catch(err=>{
      if (obsolete) return;
      if (trashOpen) setTrashLoading(false);
      setError(errorText(err));
    }),150);
    return ()=>{obsolete=true;clearTimeout(timeout);};
  },[search,activeTags,mode,trashOpen,trashPage,status?.configured,revision]);

  async function action(label:string, callback:()=>Promise<void>) {
    setBusy(label);setError('');setNotice('');
    try {await callback();}
    catch (err) {setError(errorText(err));}
    finally {setBusy('');setProgress(undefined);}
  }
  function saveMetadata(label:string, update:()=>Promise<void>) {
    const save = pendingMetadata.current.then(async()=>{
      try {
        await update();
        return true;
      } catch (err) {
        setError(`${label}保存失败 · ${errorText(err)}`);
        return false;
      }
    });
    pendingMetadata.current = save;
    return save;
  }
  const open = (id:string) => action('正在打开模板',async()=>{
    await pendingMetadata.current;
    setSelected(await api.detail(id));
  });
  const importPaths = (getPaths:()=>Promise<string[]>,append=false) => action('正在扫描项目',async()=>{
    const paths = await getPaths();
    if (!paths.length) return;
    setSelected(undefined);
    setPlan(await api.scan(paths,append?plan?.id:undefined));
  });
  const folders = () => importPaths(()=>api.pickDirectories());
  const save = (settings:Settings) => action('正在检查目录和数据库',async()=>{
    await api.configure(settings);
    setStatus(await api.status());setPanel('library');setNotice('配置已保存');
  });
  const migrateStorage = (root:string) => action('正在复制并校验素材库，请保持应用运行',async()=>{
    await api.migrateStorage(root);
    setStatus(await api.status());
    setSelected(undefined);
    setNotice('素材库已切换到新目录');
  });
  const backup = () => action('正在备份数据库',async()=>{
    const result = await api.backup();
    setNotice(`数据库备份完成 · ${bytes(result.bytes)} · ${result.file}`);
  });
  const restoreDatabase = () => action('正在选择备份或增量恢复，请保持应用运行',async()=>{
    const result = await api.restoreDatabase();
    if (!result) return;
    setRevision(value=>value+1);
    setNotice(`数据库恢复完成 · 新增 ${result.imported} · 已有 ID ${result.skipped} · 素材未就绪 ${result.unavailable}` +
      (result.unavailable ? '。将对应素材拷贝到当前库后，可再次恢复。' : ''));
  });
  const restore = (id:string) => action('正在恢复模板',async()=>{
    await api.restore(id);
    setTrashLoading(true);
    setItems(list=>list.filter(item=>item.id!==id));
    setRevision(value=>value+1);setNotice('模板已恢复');
  });
  const openTrashPage = (page:number) => {
    setItems([]);setTrashHasNext(false);setTrashLoading(true);setTrashPage(page);
  };
  const settingsOpen = Boolean(status && (!status.configured || panel==='settings'));
  return <div className="shell" onDragOver={event=>{
    if (status?.configured && !settingsOpen && !trashOpen && !busy && event.dataTransfer.types.includes('Files')) {
      event.preventDefault();setDragging(true);
    }
  }} onDrop={event=>{
    event.preventDefault();setDragging(false);
    if(status?.configured&&!settingsOpen&&!trashOpen&&!busy) {
      const paths = api.pathsForDrop(Array.from(event.dataTransfer.files));
      void importPaths(async()=>paths,Boolean(plan));
    }
  }}>
    <aside className="rail">
      <div className="brand"><span className="brand-mark">✦</span><strong>特效模板库</strong></div>
      <div className="rail-label">工作区</div>
      <button className={settingsOpen||trashOpen?'nav':'nav current'} onClick={()=>{if(trashOpen)setItems([]);setPanel('library');setPlan(undefined);}} disabled={Boolean(busy)||!status?.configured}>▦ <span>全部模板</span></button>
      <button className={trashOpen?'nav current':'nav'} onClick={()=>{
        if(!trashOpen)openTrashPage(0);
        setPanel('trash');setPlan(undefined);setSelected(undefined);
      }} disabled={Boolean(busy)||!status?.configured}>⌫ <span>回收站</span></button>
      <button className={settingsOpen?'nav current':'nav'} onClick={()=>{setPanel('settings');setPlan(undefined);}} disabled={Boolean(busy)||!status}>⚙ <span>库设置</span></button>
      <div className="rail-label tag-heading">标签</div>
      {available.map(tag=><button className={`nav tag ${activeTags.includes(tag)?'chosen':''}`} key={tag} onClick={()=>{
        if(trashOpen)setItems([]);
        setPanel('library');setPlan(undefined);
        setActiveTags(list=>list.includes(tag)?list.filter(item=>item!==tag):[...list,tag]);
      }} disabled={Boolean(busy)}># <span>{tag}</span></button>)}
      <div className="spacer"/>
      <button className="nav" disabled={!status||Boolean(busy)} onClick={()=>void action('正在打开日志',()=>api.openLogs())}>≡ <span>运行日志</span></button>
      <div className="connection"><span className={status?.configured?'online':''}/>{status?.configured?'本地库已连接':'本地库未连接'}</div>
    </aside>
    <main className="main">
      <header><div className="title">{settingsOpen?'库设置':plan?'导入预检':trashOpen?'回收站':'全部模板'}</div>
        {!settingsOpen&&!trashOpen&&!plan&&status?.configured&&<div className="toolbar">
          <input className="search" type="search" aria-label="搜索模板名称或标签" placeholder="搜索模板名称或标签" maxLength={100} value={search} onChange={event=>setSearch(event.target.value)}/>
          <button disabled={Boolean(busy)} onClick={()=>void importPaths(()=>api.pickSource())}>选择文件</button>
          <button className="primary" disabled={Boolean(busy)} onClick={()=>void folders()}>＋ 导入目录</button>
        </div>}
      </header>
      {error&&<div role="alert" className="banner error">{error}<button onClick={()=>setError('')} aria-label="关闭错误">×</button></div>}
      {notice&&<div role="status" className="banner">{notice}<button onClick={()=>setNotice('')} aria-label="关闭提示">×</button></div>}
      {busy&&(progress && plan?.id===progress.id
        ? <ArchiveStatus progress={progress}/>
        : <div className="busy" role="status">{busy}</div>)}
      {settingsOpen&&<SettingsView key={String(status?.configured)} initial={{...defaults,...status?.settings}} warning={status?.warning}
        working={Boolean(busy)} connected={Boolean(status?.configured)} save={save} backup={backup}
        migrate={migrateStorage} restoreDatabase={restoreDatabase}/>}
      {!settingsOpen&&plan&&<ImportView plan={plan} working={Boolean(busy)} close={()=>setPlan(undefined)}
        addFolders={()=>void importPaths(()=>api.pickDirectories(),true)}
        addFiles={()=>void importPaths(()=>api.pickSource(),true)}
        publish={(title,tags,preview,paths)=>void action('正在归档模板',async()=>{
        const template=await api.publish({id:plan.id,title,tags,preview,paths});
        setPlan(undefined);setSearch('');setRevision(value=>value+1);
        setSelected(await api.detail(template.id));
        setNotice('模板已入库');
      })}/>}
      {trashOpen&&status?.configured&&<section className="content trash-list">
        {(trashPage>0||trashHasNext)&&<div className="toolbar pagination">
          <button disabled={Boolean(busy)||trashLoading||trashPage===0} onClick={()=>openTrashPage(trashPage-1)}>上一页</button>
          <span>第 {trashPage+1} 页</span>
          <button disabled={Boolean(busy)||trashLoading||!trashHasNext} onClick={()=>openTrashPage(trashPage+1)}>下一页</button>
        </div>}
        {trashLoading?<p role="status">正在加载回收站…</p>:items.length===0?<div className="empty"><h2>回收站为空</h2></div>:items.map(item=><div key={item.id} className="trash-row">
          <div><strong>{item.title}</strong><p className="muted">{item.files} 个文件 · {bytes(item.bytes)}</p></div>
          <button disabled={Boolean(busy)} onClick={()=>void restore(item.id)}>恢复</button>
        </div>)}
      </section>}
      {!settingsOpen&&!trashOpen&&!plan&&status?.configured&&<div className="body">
        <section className="catalog">
          <div className="library-head"><span>{items.length} 个模板</span>
            {activeTags.length>0&&<div className="filter">
              <label className="sr" htmlFor="mode">标签匹配模式</label>
              <select id="mode" value={mode} onChange={e=>setMode(e.target.value==='all'?'all':'any')}><option value="any">匹配任一标签</option><option value="all">匹配全部标签</option></select>
              <button onClick={()=>setActiveTags([])}>清除筛选</button></div>}
          </div>
          {items.length===0?<div className="empty"><div className="empty-mark">▦</div><h2>{search||activeTags.length?'没有匹配的模板':'导入你的第一套特效模板'}</h2>
            <p>{search||activeTags.length?'试试更改搜索词或标签。':'把项目目录、HIP、NK 或 MOV 拖到这里。'}</p>
            {!search&&!activeTags.length&&<button className="primary" disabled={Boolean(busy)} onClick={()=>void folders()}>选择项目目录</button>}
          </div>:<TemplateGrid items={items} selected={selected?.id} disabled={Boolean(busy)}
            zoom={cardZoom} onZoom={changeCardZoom} open={id=>void open(id)}/>}
        </section>
        {selected&&<Detail key={selected.id} item={selected} working={Boolean(busy)} close={()=>setSelected(undefined)}
          openDirectory={()=>void action('正在打开模板目录',()=>api.openTemplateDirectory(selected.id))}
          setTags={tags=>saveMetadata('标签',async()=>{
            await api.updateTags(selected.id,tags);
            setRevision(value=>value+1);
            const stored = await api.detail(selected.id);
            setSelected(current=>current?.id===stored.id ? {...current,tags:stored.tags} : current);
          })}
          setDescription={description=>saveMetadata('描述',async()=>{
            await api.updateDescription(selected.id,description);
            setSelected(current=>current?.id===selected.id ? {...current,description} : current);
          })}
          exportPackage={mode=>void action('正在保存模板包',async()=>{
            const file=await api.export(selected.id,mode);
            if(file)setNotice(`模板包已保存 · ${file}`);
          })}
          moveToTrash={()=>void action('正在移入回收站',async()=>{
            await pendingMetadata.current;
            await api.trash(selected.id);
            setItems(list=>list.filter(item=>item.id!==selected.id));setSelected(undefined);
            setRevision(value=>value+1);setNotice('模板已移入回收站');
          })}/>}
      </div>}
      {!status&&!error&&<div className="empty" role="status">正在启动模板库…</div>}
    </main>
    {dragging&&<div className="drop-layer" onDragLeave={()=>setDragging(false)}><div>{plan?'释放以添加到本次导入':'释放以扫描项目'}</div></div>}
  </div>;
}

function TemplateGrid({items,selected,disabled,zoom,onZoom,open}:{
  items:Template[];selected?:string;disabled:boolean;zoom:number;
  onZoom:(step:number)=>void;open:(id:string)=>void;
}) {
  const grid = useRef<HTMLDivElement>(null);
  const [gridSize,setGridSize] = useState<{width:number;compactWidth:number}>();
  const [visibility,setVisibility] = useState<{items:Template[];ids:Set<string>}>();
  const [foreground,setForeground] = useState(()=>!document.hidden);
  useEffect(()=>{
    const sync = () => setForeground(!document.hidden);
    document.addEventListener('visibilitychange',sync);
    return ()=>document.removeEventListener('visibilitychange',sync);
  },[]);
  useEffect(()=>{
    const element = grid.current;
    const catalog = element?.closest<HTMLElement>('.catalog');
    if (!element||!catalog) return;
    const style = getComputedStyle(element);
    const minimum = parseFloat(style.getPropertyValue('--compact-card-width'));
    const gap = parseFloat(style.columnGap);
    const observer = new ResizeObserver(([entry])=>{
      const width = entry.contentRect.width;
      const columns = Math.max(1,Math.floor((width+gap)/(minimum+gap)));
      setGridSize({width,compactWidth:(width-gap*(columns-1))/columns});
    });
    const wheel = (event:WheelEvent) => {
      if (!event.ctrlKey||!event.deltaY) return;
      event.preventDefault();
      onZoom(event.deltaY<0 ? 1 : -1);
    };
    observer.observe(element);
    catalog.addEventListener('wheel',wheel,{passive:false});
    return ()=>{
      observer.disconnect();
      catalog.removeEventListener('wheel',wheel);
    };
  },[onZoom]);
  useEffect(()=>{
    const element = grid.current;
    if (!element) return;
    const observer = new IntersectionObserver(entries=>{
      setVisibility(previous=>{
        const next = new Set(previous?.items===items ? previous.ids : []);
        for (const entry of entries) {
          const id = entry.target.getAttribute('data-template-id');
          if (!id) continue;
          if (entry.isIntersecting && entry.intersectionRatio>=0.15) next.add(id);
          else next.delete(id);
        }
        return {items,ids:next};
      });
    },{root:element.closest('.catalog'),threshold:0.15});
    for (const card of element.children) observer.observe(card);
    return ()=>observer.disconnect();
  },[items]);
  const width = gridSize && gridSize.compactWidth+(gridSize.width-gridSize.compactWidth)*zoom/maxCardZoom;
  const columns = zoom===maxCardZoom ? 'minmax(0, 1fr)'
    : zoom>0 && width ? `repeat(auto-fill, ${width}px)` : undefined;
  return <div className="grid" ref={grid} style={{gridTemplateColumns:columns}}>
    {items.map(item=><button className={`card ${selected===item.id?'selected':''}`} data-template-id={item.id}
      key={item.id} onClick={()=>open(item.id)} disabled={disabled}>
      <div className="tile">
        {foreground&&visibility?.items===items&&visibility.ids.has(item.id)&&<TemplateVideo id={item.id}/>}
      </div>
      <div className="card-info"><strong>{item.title}</strong><span>{item.tags.slice(0,4).join(' · ')||`${item.files} 个文件`}</span></div>
    </button>)}
  </div>;
}

function TemplateVideo({id,controls=false,onError}:{id:string;controls?:boolean;onError?:()=>void}) {
  const player = useRef<HTMLVideoElement>(null);
  useEffect(()=>{
    const video = player.current;
    return ()=>{
      if (!video) return;
      video.pause();
      video.removeAttribute('src');
      video.load();
    };
  },[]);
  return <video ref={player} className={controls?'preview':undefined} aria-hidden={controls?undefined:true}
    aria-label={controls?'模板视频预览':undefined} controls={controls} autoPlay muted loop={!controls} playsInline
    src={`vfx-media://preview/${id}`} onError={onError}/>;
}

function ArchiveStatus({progress}: {progress:ArchiveProgress}) {
  const {stage,completed,total,bytesCopied,totalBytes,elapsedMs,currentFile} = progress;
  const percent = Math.min(100,Math.floor(100*(totalBytes ? bytesCopied/totalBytes : completed/total)));
  const amount = (value:number) => value ? bytes(value) : '0 B';
  return <section className="busy archive-progress" aria-label="归档进度">
    <div className="archive-progress-heading">
      <strong>{stage==='copy'?'正在复制并校验文件':'正在登记模板'}</strong>
      <span>{stage==='copy'?`${percent}%`:'文件已复制'}</span>
    </div>
    <progress aria-label="文件复制进度" value={percent} max={100}/>
    <p>已完成 {completed} / {total} 个文件 · {amount(bytesCopied)} / {amount(totalBytes)}
      {stage==='copy' && elapsedMs>=1000 && bytesCopied>0 && ` · 平均 ${bytes(bytesCopied*1000/elapsedMs)}/s`}
    </p>
    {currentFile&&<p className="archive-current" title={currentFile.path}>正在处理 {currentFile.path} · {amount(currentFile.bytesCopied)} / {amount(currentFile.totalBytes)}</p>}
  </section>;
}

function SettingsView({initial,working,connected,warning,save,backup,migrate,restoreDatabase}:{
  initial:Settings;working:boolean;connected:boolean;warning?:string;save:(value:Settings)=>void;backup:()=>void;
  migrate:(root:string)=>void;
  restoreDatabase:()=>void;
}) {
  const [settings,setSettings] = useState(initial);
  const [folderError,setFolderError] = useState('');
  const [destination,setDestination] = useState<{source:string;root:string}>();
  const migrationRoot = destination?.source===initial.root ? destination.root : undefined;
  const update = <K extends keyof Settings>(key:K,value:Settings[K])=>setSettings(old=>({...old,[key]:value}));
  async function choose(key:'root'|'backupDirectory'|'migration') {
    setFolderError('');
    try {
      const value = await api.pickDirectory();
      if (!value) return;
      if (key==='migration') setDestination({source:initial.root,root:value});
      else update(key,value);
    }
    catch(error){setFolderError(errorText(error));}
  }
  return <form className="settings content" onSubmit={event=>{
    event.preventDefault();
    if (!working) save({...settings,root:connected?initial.root:settings.root});
  }}>
    {!connected&&<><h1>连接你的本地模板库</h1><p className="muted">选择素材目录和 PostgreSQL 专用库。如果库还未创建，有建库权限的账号可以直接初始化。</p></>}
    {warning&&<p role="alert" className="warning">{warning}</p>}
    {folderError&&<p role="alert" className="warning">{folderError}</p>}
    <section><h2>素材存储</h2><label htmlFor="root">库目录</label><div className="field-row">
      <input id="root" required value={connected?initial.root:settings.root} onChange={e=>update('root',e.target.value)} readOnly={connected} placeholder="例如 D:\特效模板库"/>
      <button type="button" disabled={working} onClick={()=>void choose(connected?'migration':'root')}>{connected?'修改存储路径':'选择目录'}</button></div>
      {migrationRoot&&<>
        <p>新目录 <strong>{migrationRoot}</strong></p>
        <p className="muted">请选择空目录。校验完成后将切换素材库，原文件会保留。迁移前请退出使用原库的其他客户端。</p>
        <div className="toolbar">
          <button className="primary" type="button" disabled={working} onClick={()=>migrate(migrationRoot)}>复制并切换</button>
          <button type="button" disabled={working} onClick={()=>setDestination(undefined)}>取消</button>
        </div>
      </>}
    </section>
    <section><h2>PostgreSQL</h2><div className="form-grid">
      <label>主机<input required readOnly={connected} value={settings.host} onChange={e=>update('host',e.target.value)}/></label>
      <label>端口<input required readOnly={connected} type="number" min="1" max="65535" value={settings.port} onChange={e=>update('port',Number(e.target.value))}/></label>
      <label>数据库<input required readOnly={connected} value={settings.database} onChange={e=>update('database',e.target.value)}/></label>
      <label>账号<input required readOnly={connected} value={settings.user} onChange={e=>update('user',e.target.value)}/></label>
      <label>密码<input type="password" value={settings.password} placeholder={connected?'留空保留已保存密码':''} onChange={e=>update('password',e.target.value)} /></label>
    </div></section>
    <section><h2>数据库备份</h2><label htmlFor="backup-dir">备份目录</label><div className="field-row">
      <input id="backup-dir" value={settings.backupDirectory} onChange={e=>update('backupDirectory',e.target.value)} placeholder="可选"/>
      <button type="button" disabled={working} onClick={()=>void choose('backupDirectory')}>选择目录</button></div>
      <div className="form-grid">
        <label>每天执行时间<input type="time" value={settings.backupTime} onChange={e=>update('backupTime',e.target.value)}/></label>
        <label>保留份数<input required type="number" min="1" max="365" value={settings.backupRetention} onChange={e=>update('backupRetention',Number(e.target.value))}/></label>
      </div>
      {connected&&<>
        <p className="muted">增量恢复只导入新 ID。请先将对应素材复制到当前库的 templates 目录。</p>
        <button type="button" disabled={working} onClick={restoreDatabase}>从备份增量恢复</button>
      </>}
    </section>
    <div className="toolbar"><button className="primary" type="submit" disabled={working}>{connected?'保存设置':'连接并初始化'}</button>
      {connected&&<button type="button" disabled={working||!initial.backupDirectory} onClick={backup}>立即备份</button>}</div>
    <section>
      <h2>关于特效模板库</h2>
      <p>版本 {__APP_RELEASE__.version} · 作者 {__APP_RELEASE__.author}</p>
      <p className="muted">{__APP_RELEASE__.copyright}</p>
    </section>
  </form>;
}

function ImportView({plan,working,close,addFolders,addFiles,publish}:{
  plan:Plan;working:boolean;close:()=>void;addFolders:()=>void;addFiles:()=>void;
  publish:(title:string,tags:string[],preview:string,paths:string[])=>void;
}) {
  const previousPlan = useRef(plan);
  const [title,setTitle] = useState(plan.title);
  const [tags,setTags] = useState<string[]>([]);
  const [tagDraft,setTagDraft] = useState('');
  const [preview,setPreview] = useState(plan.preview??'');
  const [selected,setSelected] = useState(new Set(plan.files.filter(file=>file.keep).map(file=>file.path)));
  const [filter,setFilter] = useState('');
  const [page,setPage] = useState(0);
  useEffect(()=>{
    const previous = previousPlan.current;
    if (previous===plan) return;
    previousPlan.current = plan;
    setTitle(current=>current===previous.title ? plan.title : current);
    setPreview(current=>{
      const source = previous.files.find(file=>file.path===current)?.sourcePath;
      return plan.files.find(file=>file.sourcePath===source)?.path ?? plan.preview ?? '';
    });
    setSelected(current=>{
      const previousSelections = new Map(previous.files.map(file=>[file.sourcePath,current.has(file.path)]));
      return new Set(plan.files.filter(file=>previousSelections.get(file.sourcePath)??file.keep).map(file=>file.path));
    });
    setPage(0);
  },[plan]);
  const search = filter.trim().toLowerCase();
  const visible = search ? plan.rows.filter(row=>row.label.toLowerCase().includes(search) ||
    row.archiveLabel.toLowerCase().includes(search) || row.paths.some(file=>file.toLowerCase().includes(search))) : plan.rows;
  const chosen = plan.files.filter(file=>selected.has(file.path));
  return <form className="import" onSubmit={event=>{
    event.preventDefault();
    if (working || !selected.has(preview)) return;
    const next = mergeTags(tags,tagDraft);
    setTags(next);setTagDraft('');
    publish(title,next,preview,[...selected]);
  }}>
    <div className="content import-scroll">
      <div className="import-sources">
        {plan.sources.length>1?<details className="muted path">
          <summary>已选择 {plan.sources.length} 个来源</summary>
          <ul>{plan.sources.map(source=><li key={source}>{source}</li>)}</ul>
        </details>:<p className="muted path">{plan.root}</p>}
        <div className="toolbar">
          <button type="button" disabled={working} onClick={addFolders}>添加目录</button>
          <button type="button" disabled={working} onClick={addFiles}>添加文件</button>
        </div>
      </div>
      <div className="form-grid">
        <label>模板名称<input required maxLength={100} value={title} onChange={e=>setTitle(e.target.value)}/></label>
        <TagField tags={tags} draft={tagDraft} disabled={working} onTags={(next,submitted)=>{
          setTags(next);
          if (submitted) setTagDraft('');
        }} onDraft={setTagDraft}/>
        <label>主预览 MOV<select required value={preview} onChange={e=>{
          setPreview(e.target.value);setSelected(old=>new Set([...old,e.target.value]));
        }}><option value="">请选择</option>{plan.files.filter(file=>file.kind==='movie').map(file=><option key={file.path}>{file.path}</option>)}</select></label>
      </div>
      <div className="library-head"><span>保留 {selected.size} / {plan.files.length} 个文件 · {bytes(chosen.reduce((sum,file)=>sum+file.bytes,0))} · {plan.sequences.length} 组候选序列</span>
        <input type="search" placeholder="筛选相对路径" aria-label="筛选相对路径" value={filter} onChange={e=>{setFilter(e.target.value);setPage(0);}}/></div>
      <div className="file-list">
        {visible.slice(page*100,page*100+100).map(row=>{
          const all = row.paths.every(file=>selected.has(file));
          const some = !all && row.paths.some(file=>selected.has(file));
          return <label className="file-row" key={row.paths[0]}>
            <input type="checkbox" checked={all} disabled={working} ref={input=>{if(input) input.indeterminate=some;}} onChange={event=>{
              const checked=event.target.checked;
              setSelected(old=>{
                const next = new Set(old);
                for (const file of row.paths) {
                  if (checked) next.add(file);
                  else next.delete(file);
                }
                return next;
              });
            }}/>
            <span className="file-location">
              <span title={row.label}>{row.label}</span>
              {row.archiveLabel!==row.label&&<small title={row.archiveLabel}>归档到 {row.archiveLabel}</small>}
            </span>
            <small>{row.reason}</small><small>{bytes(row.bytes)}</small>
          </label>;
        })}
      </div>
      {visible.length>100&&<div className="toolbar pagination"><button type="button" disabled={page===0} onClick={()=>setPage(page-1)}>上一页</button>
        <span>{page+1} / {Math.ceil(visible.length/100)}</span><button type="button" disabled={(page+1)*100>=visible.length} onClick={()=>setPage(page+1)}>下一页</button></div>}
    </div>
    <footer className="import-actions">
      <p className="muted">按整组序列或自定义目录勾选。{chosen.some(file=>file.archivePath!==file.path)&&'整理后的路径有变化，请在 Houdini 或 Nuke 检查并重连相关引用。'}</p>
      <div className="toolbar"><button type="button" disabled={working} onClick={close}>取消</button><button type="submit" className="primary" disabled={working||!selected.has(preview)}>发布模板</button></div>
    </footer>
  </form>;
}

function Detail({item,working,close,setTags,setDescription,exportPackage,moveToTrash,openDirectory}:{
  item:TemplateDetail;working:boolean;close:()=>void;setTags:(tags:string[])=>Promise<boolean>;
  setDescription:(description:string)=>Promise<boolean>;
  exportPackage:(mode:'slim'|'full')=>void;moveToTrash:()=>void;openDirectory:()=>void;
}) {
  const descriptionId = useId();
  const [tagDraft,setTagDraft] = useState('');
  const [descriptionDraft,setDescriptionDraft] = useState(item.description);
  const [savingTags,setSavingTags] = useState(false);
  const [savingDescription,setSavingDescription] = useState(false);
  const [mediaError,setMediaError] = useState(false);
  const [confirmTrash,setConfirmTrash] = useState(false);

  async function updateTags(tags:string[],submitted?:boolean) {
    if (tags.length===item.tags.length) {
      if (submitted) setTagDraft('');
      return;
    }
    setSavingTags(true);
    const saved = await setTags(tags);
    if (saved && submitted) setTagDraft('');
    setSavingTags(false);
  }

  async function updateDescription() {
    if (savingDescription || descriptionDraft===item.description) return;
    setSavingDescription(true);
    await setDescription(descriptionDraft);
    setSavingDescription(false);
  }

  return <aside className="detail">
    <div className="detail-head"><h2>{item.title}</h2><button onClick={close} aria-label="关闭模板详情">×</button></div>
    <TemplateVideo id={item.id} controls onError={()=>setMediaError(true)}/>
    {mediaError&&<p className="warning">当前桌面播放器无法预览此 MOV，可通过模板包打开原文件。</p>}
    <div className="detail-fields">
      <TagField tags={item.tags} draft={tagDraft} disabled={working||savingTags}
        onTags={(tags,submitted)=>void updateTags(tags,submitted)} onDraft={setTagDraft}/>
      <label className="description-field" htmlFor={descriptionId}>描述
        <textarea id={descriptionId} rows={4} value={descriptionDraft} readOnly={working||savingDescription}
          placeholder="输入描述，Shift + Enter 换行" onChange={event=>setDescriptionDraft(event.target.value)}
          onBlur={()=>void updateDescription()} onKeyDown={event=>{
            if (event.key!=='Enter'||event.shiftKey||event.nativeEvent.isComposing||event.keyCode===229) return;
            event.preventDefault();
            event.currentTarget.blur();
          }}/>
      </label>
    </div>
    <div className="toolbar detail-actions">
      <button disabled={working} onClick={openDirectory}>打开模板目录</button>
      <button disabled={working} onClick={()=>exportPackage('slim')}>导出精简包</button>
      <button className="primary" disabled={working} onClick={()=>exportPackage('full')}>导出完整模板</button>
    </div>
    <dl className="detail-meta">
      <div><dt>发布时间</dt><dd><time dateTime={item.publishedAt}>{publicationTime.format(new Date(item.publishedAt))}</time></dd></div>
      <div><dt>文件数量</dt><dd>{item.files} 个</dd></div>
      <div><dt>总大小</dt><dd>{bytes(item.bytes)}</dd></div>
    </dl>
    {confirmTrash?<section className="trash-action">
      <p>将「{item.title}」移入回收站？之后可以恢复。</p>
      <div className="toolbar">
        <button disabled={working} onClick={()=>setConfirmTrash(false)}>取消</button>
        <button className="danger" disabled={working} onClick={moveToTrash}>确认移入</button>
      </div>
    </section>:<button className="danger trash-action" disabled={working} onClick={()=>setConfirmTrash(true)}>移入回收站</button>}
  </aside>;
}

createRoot(document.getElementById('root')!).render(<App/>);
