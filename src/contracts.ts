export type FileKind = 'houdini' | 'nuke' | 'cache' | 'image' | 'texture' | 'hda' | 'movie' | 'other';
export const archiveNames = ['render.zip','abc.zip'] as const;
export type ArchiveName = `${string}.zip`;

export interface SourceFile {
  path: string;
  sourcePath: string;
  archivePath: string;
  customDirectory?: string;
  archiveZip?: ArchiveName;
  bytes: number;
  modified: number;
  kind: FileKind;
  keep: boolean;
  reason: string;
}

export function archiveSizes(files: SourceFile[]) {
  const sizes = new Map<ArchiveName,number>();
  for (const {archiveZip,bytes} of files) {
    if (archiveZip) sizes.set(archiveZip,(sizes.get(archiveZip)??0)+bytes);
  }
  return sizes;
}

export interface Sequence {
  path: string;
  first: number;
  last: number;
  count: number;
  missing: number;
}

export interface ImportRow {
  label: string;
  archiveLabel: string;
  paths: string[];
  bytes: number;
  reason: string;
}

export interface Plan {
  id: string;
  root: string;
  sources: string[];
  scanRoots: string[];
  title: string;
  preview?: string;
  files: SourceFile[];
  sequences: Sequence[];
  rows: ImportRow[];
}

export interface Settings {
  root: string;
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
  backupDirectory: string;
  backupTime: string;
  backupRetention: number;
}

export interface Template {
  id: string;
  version: string;
  title: string;
  tags: string[];
  preview: string;
  files: number;
  bytes: number;
  publishedAt: string;
}

interface ArchivedFile {
  path: string;
  sourcePath?: string;
  bytes: number;
  sha256: string;
  kind: FileKind;
}

export interface TemplateDetail extends Template {
  description: string;
  manifest: Array<ArchivedFile & {entries?: ArchivedFile[]}>;
  sequences: Sequence[];
}

export interface PublishInput {
  id: string;
  title: string;
  tags: string[];
  preview: string;
  paths: string[];
  archives?: ArchiveName[];
}

export interface BackupResult {
  file: string;
  bytes: number;
  sha256: string;
}

export interface RestoreResult {
  imported: number;
  skipped: number;
  unavailable: number;
}

export interface PackExistingResult {
  packed: number;
  skipped: number;
  failed: Array<{id:string;title:string;message:string}>;
}

export interface PackCandidate {
  id:string;
  title:string;
  trashed:boolean;
  archives:Array<{name:ArchiveName;files:number;bytes:number}>;
}

export interface ArchiveProgress {
  id: string;
  stage: 'copy' | 'pack' | 'register';
  completed: number;
  total: number;
  bytesCopied: number;
  totalBytes: number;
  elapsedMs: number;
  currentFile?: {path: string; bytesCopied: number; totalBytes: number};
}

export interface PackProgress {
  type: 'pack-existing';
  total:number;
  packed:number;
  skipped:number;
  failed:number;
  current?: {
    title:string;
    stage:ArchiveProgress['stage'];
    archive?:ArchiveName;
    bytesRead:number;
    totalBytes:number;
  };
}

export type DesktopProgress = ArchiveProgress | PackProgress;

export interface CatalogFilters {
  mode: 'all' | 'any';
  tags: string[];
}

export interface DesktopApi {
  status(): Promise<{ configured: boolean; settings?: Omit<Settings, 'password'>; logPath: string; warning?: string }>;
  loadCatalogFilters(): Promise<CatalogFilters>;
  saveCatalogFilters(filters: CatalogFilters): Promise<void>;
  configure(settings: Settings): Promise<void>;
  migrateStorage(root: string): Promise<void>;
  packCandidates(): Promise<PackCandidate[]>;
  packExisting(ids:string[]): Promise<PackExistingResult>;
  pickDirectory(): Promise<string | undefined>;
  pickDirectories(): Promise<string[]>;
  pickSource(): Promise<string[]>;
  scan(paths: string[], previousPlanId?: string): Promise<Plan>;
  publish(input: PublishInput): Promise<Template>;
  list(input: {search: string; tags: string[]; mode: 'all' | 'any'; trashed?: boolean; page?: number}): Promise<{items: Template[]; tags: string[]; hasNext: boolean}>;
  detail(id: string): Promise<TemplateDetail>;
  updateTags(id: string, tags: string[]): Promise<void>;
  updateDescription(id: string, description: string): Promise<void>;
  trash(id: string): Promise<void>;
  restore(id: string): Promise<void>;
  backup(): Promise<BackupResult>;
  restoreDatabase(): Promise<RestoreResult | undefined>;
  export(id: string, mode: 'slim' | 'full'): Promise<string | undefined>;
  openTemplateDirectory(id: string): Promise<void>;
  openLogs(): Promise<void>;
  onProgress(listener: (event: DesktopProgress) => void): () => void;
  pathsForDrop(files: File[]): string[];
}
