import { randomUUID } from 'node:crypto';
import { lstat, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import type { ArchiveName, FileKind, ImportRow, Plan, Sequence, SourceFile } from '../contracts';

export const nativePath = (root: string, relative: string) => {
  if (!relative || relative.split('/').some(part =>
    !part || part === '.' || part === '..' || /[\\:\x00-\x1f<>?"|*]|[. ]$/.test(part) ||
    /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(part))) {
    throw new Error('发现不兼容的项目相对路径');
  }
  return path.join(root, ...relative.split('/'));
};

export function classify(relative: string): Pick<SourceFile, 'kind' | 'keep' | 'reason'> {
  const lower = relative.toLowerCase();
  const ext = path.extname(lower);
  const parts = lower.split('/');
  if (/\.(hip|hiplc|hipnc)$/.test(lower)) return {kind: 'houdini', keep: true, reason: 'Houdini 工程'};
  if (ext === '.nk') return {kind: 'nuke', keep: true, reason: 'Nuke 工程'};
  if (/\.(abc|fbx|geo|bgeo|sc|vdb|usd|usda|usdc)$/.test(lower)) {
    if (geoDirectory(relative)||ext==='.geo'||ext==='.bgeo') return {kind:'cache',keep:false,reason:'geo 缓存 · 默认排除'};
    if (ext==='.sc') return {kind:'cache',keep:false,reason:'Houdini .sc 缓存 · 默认排除'};
    return {kind:'cache',keep:true,reason:'几何或缓存'};
  }
  if (/\.(hda|hdalc|hdanc|otl)$/.test(lower)) return {kind: 'hda', keep: true, reason: 'Houdini 资产库'};
  if (ext === '.mov') return {kind: 'movie', keep: true, reason: 'MOV 预览候选'};
  if (/\.(hdr|rat|tx|tex)$/.test(lower)) return {kind: 'texture', keep: true, reason: '贴图或 HDRI 候选'};
  const image = /\.(exr|png|jpg|jpeg|tiff?|tga|dpx|webp)$/.test(lower);
  if (image || /\.(dds|psd|bmp|gif)$/.test(lower)) {
    const imageFolder = parts.slice(0,-1).reverse().map(part=>destinations.get(part))
      .find(folder=>folder==='render'||folder==='tex'||folder==='hdr');
    if (imageFolder==='tex'||imageFolder==='hdr') return {kind: 'texture', keep: true, reason: '贴图或 HDRI 候选'};
    if (image) return {kind: 'image', keep: true, reason: '图像或渲染帧'};
  }
  if (lower.endsWith('~') || ['thumbs.db', 'desktop.ini', '.ds_store'].includes(parts.at(-1)!) ||
      ['.log', '.tmp', '.bak'].includes(ext)) return {kind: 'other', keep: false, reason: '临时文件或编辑器备份'};
  return {kind: 'other', keep: false, reason: '用途待确认'};
}

const ignored = new Set(['.git', '.svn', 'node_modules']);
const backup = new Set(['backup', 'backups', 'autosave', 'autosaves']);
const isEntry = (kind: FileKind) => kind === 'houdini' || kind === 'nuke';

const destinations = new Map([
  ['abc','abc'], ['geo','abc'], ['cache','abc'], ['caches','abc'],
  ['tex','tex'], ['texture','tex'], ['textures','tex'], ['hdr','hdr'], ['hdri','hdr'],
  ['hda','hda'], ['otl','hda'], ['otls','hda'],
  ['render','render'], ['renders','render'], ['sequence','render'], ['sequences','render'], ['exr','render'],
]);
const wrappers = new Set(['houdini','nuke']);

function geoDirectory(relative: string) {
  const parts = relative.split('/');
  const index = parts.slice(0,-1).findIndex(part=>part.toLowerCase()==='geo');
  return index>=0 ? parts.slice(0,index+1).join('/') : undefined;
}

function archiveLocation(relative: string, kind: FileKind, inSequence: boolean) {
  const parts = relative.split('/');
  const directories = parts.slice(0,-1).map(part=>part.toLowerCase());
  let index = 0;
  while (wrappers.has(directories[index])) index++;
  const name = parts.at(-1)!;
  if (kind==='cache' && /\.sc$/i.test(name)) {
    const cacheRoot = directories.findIndex(part=>destinations.get(part)==='abc');
    return {archivePath:['geo',...parts.slice(cacheRoot>=0?cacheRoot+1:index)].join('/')};
  }
  const optional = directories.findIndex(part=>part==='add_file'||backup.has(part));
  if (optional>=0) return {archivePath:relative,customDirectory:parts.slice(0,optional+1).join('/')};
  if (isEntry(kind)||kind==='movie') return {archivePath:name};

  const category = kind==='cache' ? 'abc' : kind==='hda' ? 'hda'
    : kind==='texture' ? (/\.hdr$/i.test(name)||directories.some(part=>destinations.get(part)==='hdr') ? 'hdr' : 'tex')
    : kind==='image' && (inSequence||/\.exr$/i.test(name)||directories.some(part=>destinations.get(part)==='render')) ? 'render'
    : undefined;
  const anchor = category ? directories.findIndex(part=>destinations.get(part)===category) : -1;
  if (category) return {archivePath:[category,...parts.slice(anchor>=0?anchor+1:index)].join('/')};
  return {archivePath:relative,customDirectory:directories.length>index?parts.slice(0,index+1).join('/'):undefined};
}

function framePattern(filename: string) {
  const name = path.posix.basename(filename);
  const match = /^(.*?)(\d+)(\.(?:(?:geo|bgeo|vdb)\.sc|[^./]+))$/iu.exec(name);
  if (!match) return undefined;
  const [, prefix, digits, suffix] = match;
  if (digits.length>9 || /(?:^|[._-])(?:v|ver|version)$/i.test(prefix)) return undefined;
  return {pattern:filename.slice(0,-name.length)+`${prefix}%0${digits.length}d${suffix}`,frame:Number(digits)};
}

function sequenceGroups<T extends {path:string;kind:FileKind}>(files: T[], kind:FileKind='image') {
  const groups = new Map<string, {files:T[];frames:Set<number>}>();
  for (const file of files) {
    if (file.kind !== kind) continue;
    const frame = framePattern(file.path);
    if (!frame) continue;
    let group = groups.get(frame.pattern);
    if (!group) {
      group = {files:[],frames:new Set()};
      groups.set(frame.pattern,group);
    }
    group.files.push(file);
    group.frames.add(frame.frame);
  }
  return [...groups].flatMap(([path, {files,frames}]) => {
    if (frames.size < 2) return [];
    let first = Infinity;
    let last = -Infinity;
    for (const frame of frames) {
      first = Math.min(first, frame);
      last = Math.max(last, frame);
    }
    return [{files,frames,summary:{path,first,last,count:frames.size,missing:last-first+1-frames.size}}];
  });
}

function textureSequenceGroups<T extends {path:string;kind:FileKind}>(files:T[]) {
  const textures = new Map<string,number>();
  for (const file of files) {
    if (file.kind!=='texture') continue;
    const directory = path.posix.dirname(file.path);
    textures.set(directory,(textures.get(directory)??0)+1);
  }
  return sequenceGroups(files,'texture').filter(({summary,files:members,frames})=>{
    const directory = path.posix.dirname(summary.path);
    if (members.length!==textures.get(directory) || summary.count<5 || /(?:^|[._-])udim(?:[._-]|$)/iu.test(path.posix.basename(summary.path))) return false;
    const numbers = [...frames].sort((a,b)=>a-b);
    let consecutive = 1;
    return numbers.some((frame,index)=>{
      consecutive = index>0 && frame===numbers[index-1]+1 ? consecutive+1 : 1;
      return consecutive>=5;
    });
  });
}

export function textureSequenceArchives<T extends {path:string;kind:FileKind}>(files:T[]) {
  return new Map<ArchiveName,T[]>(textureSequenceGroups(files).flatMap(({summary,files:frames})=>{
    const directory = path.posix.dirname(summary.path);
    return directory==='.' ? [] : [[`${directory}.zip`,frames] as const];
  }));
}

export function sequencesFor(files: Array<{path: string; kind: FileKind}>): Sequence[] {
  return [...sequenceGroups(files),...textureSequenceGroups(files)].map(group=>group.summary);
}

export function renderSequencePaths(files: Array<{path: string; kind: FileKind}>) {
  return new Set(sequenceGroups(files.filter(file=>file.path.startsWith('render/')))
    .flatMap(group=>group.files.map(file=>file.path)));
}

function importRows(files: SourceFile[]) {
  const rows = new Map<string,ImportRow>();
  for (const file of files) {
    const geo = file.kind==='cache' ? geoDirectory(file.path) : undefined;
    const numbered = (file.kind==='image'||file.kind==='cache') && framePattern(file.path);
    const sequenceTexture = file.kind==='texture' && file.archiveZip;
    const directory = file.customDirectory ?? geo ?? (numbered || sequenceTexture ? path.posix.dirname(file.path) : undefined);
    if (directory) {
      const key = (file.customDirectory?'custom:':'directory:')+directory;
      const label = directory==='.' && sequenceTexture ? path.basename(path.dirname(file.sourcePath))+'/' : directory+'/';
      const nested = geo && !file.customDirectory
        ? file.path.split('/').length - geo.split('/').length
        : 1;
      const archiveLabel = file.customDirectory ? label : (file.archivePath.split('/').slice(0,-nested).join('/')||'.')+'/';
      const reason = file.customDirectory ? '自定义目录 · 原样归档'
        : geo ? 'geo 缓存 · 默认排除' : sequenceTexture ? '序列贴图' : '序列目录';
      let row = rows.get(key);
      if (!row) {
        row = {label,archiveLabel,bytes:0,paths:[],reason};
        rows.set(key,row);
      }
      if (row.archiveLabel!==archiveLabel) row.archiveLabel = label;
      row.paths.push(file.path);
      row.bytes += file.bytes;
    } else rows.set('file:'+file.path,{label:file.path,archiveLabel:file.archivePath,paths:[file.path],bytes:file.bytes,reason:file.reason});
  }
  return {rows:[...rows.values()].sort((a,b)=>a.label.localeCompare(b.label,'zh-CN',{numeric:true})),
    sequences:sequencesFor(files.filter(file=>!file.customDirectory))};
}

export async function scanSources(inputs: string[], restrictedRoot: string, previousRoots: string[] = []): Promise<Plan> {
  if (!inputs.length || inputs.length>100 || inputs.some(input=>!path.isAbsolute(input))) throw new Error('请选择要导入的目录或文件，最多 100 个来源');
  const sources = await Promise.all(inputs.map(async input => {
    const stat = await lstat(input);
    if (!stat.isDirectory()&&!stat.isFile()) throw new Error('请直接选择原目录或原文件');
    return {file: await realpath(input), directory: stat.isDirectory()};
  }));
  const within = (p: string) => !p || (!path.isAbsolute(p) && p !== '..' && !p.startsWith(`..${path.sep}`));
  const parents = new Set(sources.map(source=>source.directory?source.file:path.dirname(source.file)));
  const singleRoot = parents.size===1 ? [...parents][0] : undefined;
  const recursive = [...new Set([...previousRoots,...(singleRoot ? [singleRoot] : sources.filter(source=>source.directory).map(source=>source.file))])];
  const roots = recursive.filter(directory=>!recursive.some(other=>directory!==other&&within(path.relative(other,directory))));
  if (sources.some(source=>within(path.relative(restrictedRoot,source.file))) ||
      roots.some(root=>root===path.parse(root).root||within(path.relative(root,restrictedRoot)))) {
    throw new Error('请选择独立的项目目录，扫描范围不能包含归档库');
  }

  const scanned: Array<Omit<SourceFile,'archivePath'|'customDirectory'>&{rulePath:string;prefix:string}> = [];
  const seen = new Set<string>();
  const usedLabels = new Set<string>();
  const labels = new Map<string,string>();
  function rootLabel(root:string) {
    const existing = labels.get(root);
    if (existing) return existing;
    const base = path.basename(root)||'根目录';
    let label = base;
    for (let suffix=2;usedLabels.has(label.toLowerCase());suffix++) label = `${base}-${suffix}`;
    labels.set(root,label);
    usedLabels.add(label.toLowerCase());
    return label;
  }
  async function scanFile(root:string,relative:string) {
    const sourcePath = nativePath(root,relative);
    if (seen.has(sourcePath)) return;
    const stat = await lstat(sourcePath);
    if (!stat.isFile()) return;
    seen.add(sourcePath);
    const prefix = singleRoot?'':rootLabel(root)+'/';
    const location = path.basename(root);
    const categoryRoot = destinations.has(location.toLowerCase())||backup.has(location.toLowerCase())||location.toLowerCase()==='add_file';
    const rootParts = root.split(path.sep);
    const textureRoot = rootParts.findLastIndex(part=>destinations.get(part.toLowerCase())==='tex');
    const rulePath = (categoryRoot ? location+'/' : textureRoot>=0 ? rootParts.slice(textureRoot).join('/')+'/' : prefix)+relative;
    scanned.push({path:prefix+relative,sourcePath,prefix,rulePath,bytes:stat.size,modified:stat.mtimeMs,...classify(rulePath)});
  }
  async function visit(root:string,directory:string,prefix:string):Promise<void> {
    for (const entry of await readdir(directory, {withFileTypes: true})) {
      if (entry.isSymbolicLink()) continue;
      const relative = prefix + entry.name;
      if (entry.isDirectory()) {
        if (!ignored.has(entry.name.toLowerCase())) await visit(root,nativePath(root,relative),relative+'/');
      } else if (entry.isFile()) await scanFile(root,relative);
    }
  }
  for (const root of roots) await visit(root,root,'');
  for (const source of sources) {
    if (!source.directory&&!seen.has(source.file)) await scanFile(path.dirname(source.file),path.basename(source.file));
  }
  const selectedFiles = new Set(sources.filter(source=>!source.directory).map(source=>source.file));
  const frames = new Set(sequenceGroups(scanned).flatMap(group=>group.files.map(file=>file.path)));
  const textureFrames = new Set(textureSequenceGroups(scanned).flatMap(group=>group.files.map(file=>file.path)));
  const files: SourceFile[] = scanned.map(({rulePath,prefix,...file})=>{
    const renderFrame = frames.has(file.path);
    const {archivePath,customDirectory} = archiveLocation(rulePath,file.kind,renderFrame);
    const archiveZip:ArchiveName|undefined = /\.abc$/iu.test(file.path) ? 'abc.zip'
      : renderFrame && !customDirectory ? 'render.zip'
      : textureFrames.has(file.path) && !customDirectory ? `${path.posix.dirname(archivePath)}.zip` : undefined;
    const explicitlyChosen = selectedFiles.has(file.sourcePath)&&(file.keep||file.reason==='用途待确认');
    if (!customDirectory) return {...file,archivePath,archiveZip,keep:file.keep||explicitlyChosen};
    const displayDirectory = prefix+customDirectory.split('/').slice(prefix?1:0).join('/');
    return {...file,archivePath,archiveZip,customDirectory:displayDirectory.replace(/\/$/,''),keep:explicitlyChosen,reason:'自定义目录，可勾选原样归档'};
  });
  files.sort((a, b) => a.path.localeCompare(b.path, 'zh-CN', {numeric: true}));
  const movies = files.filter(file => file.kind === 'movie' && (file.keep || selectedFiles.has(file.sourcePath)));
  const stem = (file: string) => path.basename(file, path.extname(file)).replace(/(?:[_-](?:ck|v\d+))+$/i, '').toLowerCase();
  const entries = files.filter(file=>isEntry(file.kind)&&(file.keep||selectedFiles.has(file.sourcePath)));
  const draggedMovie = movies.find(file=>selectedFiles.has(file.sourcePath));
  const movieNames = new Set(movies.map(file=>stem(file.path)));
  const entry = entries.find(file=>selectedFiles.has(file.sourcePath)) ??
    (draggedMovie && entries.find(file=>stem(file.path)===stem(draggedMovie.path))) ??
    entries.find(file=>movieNames.has(stem(file.path))) ?? entries[0];
  const preview = draggedMovie ??
    movies.find(file => entry && stem(file.path) === stem(entry.path)) ?? movies[0];
  if (preview) preview.keep = true;
  for (const file of movies) {
    if (file === preview || selectedFiles.has(file.sourcePath)) continue;
    file.keep = false;
    file.reason = '其他 MOV，可作为参考一并归档';
  }
  const selectedSources = [...new Set(sources.map(source=>source.file))];
  const root = singleRoot??`${selectedSources.length} 个导入来源`;
  return {id:randomUUID(),root,sources:selectedSources,scanRoots:roots,
    title:entry?path.basename(entry.path,path.extname(entry.path)):path.basename(singleRoot??selectedSources[0]),
    preview:preview?.path,files,...importRows(files)};
}
