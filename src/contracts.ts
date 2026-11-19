export type FileKind = 'houdini' | 'nuke' | 'cache' | 'image' | 'texture' | 'hda' | 'movie' | 'other';

export interface SourceFile {
  path: string;
  sourcePath: string;
  archivePath: string;
  customDirectory?: string;
  bytes: number;
  modified: number;
  kind: FileKind;
  keep: boolean;
  reason: string;
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

export interface TemplateDetail extends Template {
  manifest: Array<{path: string; sourcePath?: string; bytes: number; sha256: string; kind: FileKind}>;
  sequences: Sequence[];
}

export interface PublishInput {
  id: string;
  title: string;
  tags: string[];
  preview: string;
  paths: string[];
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

export interface ArchiveProgress {
  id: string;
  stage: 'copy' | 'register';
  completed: number;
  total: number;
  bytesCopied: number;
  totalBytes: number;
  elapsedMs: number;
  currentFile?: {path: string; bytesCopied: number; totalBytes: number};
}

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
  pickDirectory(): Promise<string | undefined>;
  pickDirectories(): Promise<string[]>;
  pickSource(): Promise<string[]>;
  scan(paths: string[], previousPlanId?: string): Promise<Plan>;
  publish(input: PublishInput): Promise<Template>;
  list(input: {search: string; tags: string[]; mode: 'all' | 'any'; trashed?: boolean; page?: number}): Promise<{items: Template[]; tags: string[]; hasNext: boolean}>;
  detail(id: string): Promise<TemplateDetail>;
  updateTags(id: string, tags: string[]): Promise<void>;
  trash(id: string): Promise<void>;
  restore(id: string): Promise<void>;
  backup(): Promise<BackupResult>;
  restoreDatabase(): Promise<RestoreResult | undefined>;
  export(id: string, mode: 'slim' | 'full'): Promise<string | undefined>;
  openTemplateDirectory(id: string): Promise<void>;
  openLogs(): Promise<void>;
  onProgress(listener: (event: ArchiveProgress) => void): () => void;
  pathsForDrop(files: File[]): string[];
}
