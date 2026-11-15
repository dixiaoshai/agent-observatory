/** Public standalone knowledge application and adapter contracts. */
export { openApplication, loadConfig, localOwnerId, evidenceDatabasePath } from './bootstrap.js';
export type { Config } from './bootstrap.js';
export { AgentKnowledge, KnowRelay } from './application/index.js';
export type { ApplicationConfig } from './application/index.js';
export type { SourceScanner, SourceRepository, RecordRepository, AuditRepository, Repositories, UnitOfWork, LexicalSearchIndex, SyncResult } from './application/ports.js';
export { AgentKnowledgeError, KnowRelayError, contentHash, chunkText } from './core/index.js';
export type { SourceDefinition, SourceState, SourceRef, KnowledgeRecord, FileVersion, AccessScope } from './core/index.js';
export { scanSource } from './ingestion/index.js';
export type { SourceConfig, ScannedFile, ScanResult } from './ingestion/index.js';
export { SqliteStore } from './storage/index.js';
export type { FollowSource } from './follow/worker.js';
