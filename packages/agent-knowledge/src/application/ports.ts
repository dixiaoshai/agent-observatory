import type { AccessScope, FileVersion, KnowledgeRecord, SourceDefinition, SourceState } from '../core/index.js';

export interface SourceRepository {
  get(id: string): Promise<SourceState | null>;
  listFiles(sourceId: string): Promise<FileVersion[]>;
  save(source: SourceState, expectedRevision: number | null): Promise<void>;
  replaceFile(file: FileVersion): Promise<void>;
  removeFile(sourceId: string, path: string): Promise<void>;
  delete(id: string): Promise<void>;
}

export interface RecordRepository {
  getActive(id: string, scope: AccessScope): Promise<KnowledgeRecord | null>;
  insert(record: KnowledgeRecord): Promise<void>;
  supersedeFile(sourceId: string, path: string, at: string): Promise<void>;
  deleteSource(sourceId: string): Promise<void>;
}

export interface SyncResult {
  source_id: string;
  revision: number;
  added: number;
  updated: number;
  deleted: number;
  unchanged: number;
  skipped: Array<{ path: string; reason: string }>;
}

export interface AuditRepository {
  append(operation: string, sourceId: string, detail: object): Promise<void>;
  getRequest(key: string): Promise<{ fingerprint: string; result: SyncResult } | null>;
  saveRequest(key: string, fingerprint: string, result: SyncResult): Promise<void>;
}

export interface Repositories {
  sources: SourceRepository;
  records: RecordRepository;
  audit: AuditRepository;
}

export interface UnitOfWork {
  run<T>(work: (repositories: Repositories) => Promise<T>): Promise<T>;
}

export interface LexicalSearchIndex {
  search(query: string, scope: AccessScope, limit: number): Promise<Array<{ id: string; score: number }>>;
  rebuild(): Promise<number>;
}

export interface SourceScanner {
  scan(source: SourceDefinition): Promise<{
    files: Array<{ path: string; content: string; content_hash: string; git_commit: string | null }>;
    skipped: Array<{ path: string; reason: string }>;
  }>;
}
