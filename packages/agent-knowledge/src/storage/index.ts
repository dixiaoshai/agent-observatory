import { mkdirSync, chmodSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { AgentKnowledgeError } from '../core/index.js';
import type { AccessScope, FileVersion, KnowledgeRecord, SourceState } from '../core/index.js';
import type { LexicalSearchIndex, Repositories, SyncResult, UnitOfWork } from '../application/ports.js';
import { rankDocuments } from '../retrieval/index.js';

type Row = Record<string, unknown>;
function payload<T>(row: Row | undefined): T | null {
  return row ? JSON.parse(row.payload as string) as T : null;
}

function scopeSql(scope: AccessScope): { sql: string; args: string[] } {
  if (!scope.project_ids.length || !scope.source_ids.length) return { sql: '0', args: [] };
  return {
    sql: `r.owner_id = ? AND r.project_id IN (${scope.project_ids.map(() => '?').join(',')})
      AND r.source_id IN (${scope.source_ids.map(() => '?').join(',')})`,
    args: [scope.owner_id, ...scope.project_ids, ...scope.source_ids],
  };
}

/** All driver-specific code stays here. Public reads and transactions share a queue. */
export class SqliteStore {
  private readonly db: DatabaseSync;
  private tail: Promise<unknown> = Promise.resolve();
  readonly repositories: Repositories;
  readonly uow: UnitOfWork;
  readonly index: LexicalSearchIndex;

  constructor(databasePath: string) {
    if (databasePath !== ':memory:') mkdirSync(path.dirname(databasePath), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(databasePath);
    try {
      if (databasePath !== ':memory:') chmodSync(databasePath, 0o600);
      this.db.exec('PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA secure_delete = ON;');
      this.migrate();
    } catch (error) {
      this.db.close();
      throw error;
    }
    const raw = this.rawRepositories();
    // Transaction callbacks receive the unwrapped repositories so they do not deadlock the queue.
    const wrap = <T extends object>(repository: T): T => Object.fromEntries(
      Object.entries(repository).map(([name, method]) => [name, (...args: unknown[]) => this.serial(() => method(...args))]),
    ) as T;
    this.repositories = { sources: wrap(raw.sources), records: wrap(raw.records), audit: wrap(raw.audit) };
    this.uow = { run: <T>(work: (repositories: Repositories) => Promise<T>) => this.serial(() => this.transaction(() => work(raw))) };
    this.index = {
      search: (query, scope, limit) => this.serial(async () => {
        const filter = scopeSql(scope);
        const rows = this.db.prepare(`SELECT d.record_id AS id, d.content, d.path
          FROM search_documents d JOIN records r ON r.id = d.record_id
          JOIN sources s ON s.id = r.source_id JOIN file_versions f ON f.id = r.file_version_id
          WHERE r.status = 'active' AND s.deleted = 0 AND f.current = 1 AND ${filter.sql}`).all(...filter.args);
        return rankDocuments(query, rows.map((row) => ({ id: row.id as string, content: row.content as string, path: row.path as string })), limit);
      }),
      rebuild: () => this.serial(() => this.transaction(async () => {
        this.db.exec(`DELETE FROM search_documents;
          INSERT INTO search_documents(record_id, content, path)
          SELECT r.id, json_extract(r.payload, '$.content'), r.path FROM records r
          JOIN sources s ON s.id = r.source_id JOIN file_versions f ON f.id = r.file_version_id
          WHERE r.status = 'active' AND s.deleted = 0 AND f.current = 1;`);
        return this.db.prepare('SELECT count(*) AS n FROM search_documents').get()!.n as number;
      })),
    };
  }

  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation, operation);
    this.tail = result.catch(() => undefined);
    return result;
  }

  private async transaction<T>(work: () => Promise<T>): Promise<T> {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = await work();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  private migrate(): void {
    const version = this.db.prepare('PRAGMA user_version').get()!.user_version as number;
    if (version > 1) throw new AgentKnowledgeError('SCHEMA_VERSION', 'Database schema is newer than this application');
    if (version === 1) return;
    this.db.exec(`BEGIN IMMEDIATE;
      CREATE TABLE IF NOT EXISTS sources (
        id TEXT PRIMARY KEY, revision INTEGER NOT NULL, deleted INTEGER NOT NULL DEFAULT 0,
        payload TEXT NOT NULL CHECK(json_valid(payload))
      );
      CREATE TABLE IF NOT EXISTS file_versions (
        id TEXT PRIMARY KEY, source_id TEXT NOT NULL REFERENCES sources(id), path TEXT NOT NULL,
        current INTEGER NOT NULL, payload TEXT NOT NULL CHECK(json_valid(payload))
      );
      CREATE UNIQUE INDEX IF NOT EXISTS current_file ON file_versions(source_id,path) WHERE current = 1;
      CREATE TABLE IF NOT EXISTS records (
        id TEXT PRIMARY KEY, source_id TEXT NOT NULL REFERENCES sources(id),
        file_version_id TEXT NOT NULL REFERENCES file_versions(id), path TEXT NOT NULL,
        owner_id TEXT NOT NULL, project_id TEXT NOT NULL, status TEXT NOT NULL,
        payload TEXT NOT NULL CHECK(json_valid(payload))
      );
      CREATE INDEX IF NOT EXISTS active_scope ON records(owner_id, project_id, source_id, status);
      CREATE INDEX IF NOT EXISTS records_file ON records(source_id,path);
      CREATE TABLE IF NOT EXISTS search_documents (
        record_id TEXT PRIMARY KEY REFERENCES records(id) ON DELETE CASCADE, content TEXT NOT NULL, path TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS audit (
        id INTEGER PRIMARY KEY, source_id TEXT NOT NULL, operation TEXT NOT NULL, at TEXT NOT NULL, detail TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS requests (
        key TEXT PRIMARY KEY, source_id TEXT NOT NULL, fingerprint TEXT NOT NULL, result TEXT NOT NULL
      );
      PRAGMA user_version = 1;
      COMMIT;`);
  }

  private rawRepositories(): Repositories {
    return {
      sources: {
        get: async (id) => payload<SourceState>(this.db.prepare('SELECT payload FROM sources WHERE id = ?').get(id)),
        listFiles: async (sourceId) => this.db.prepare('SELECT payload FROM file_versions WHERE source_id = ? AND current = 1 ORDER BY path').all(sourceId).map((row) => payload<FileVersion>(row)!),
        save: async (source, expectedRevision) => {
          const existing = this.db.prepare('SELECT revision FROM sources WHERE id = ?').get(source.id);
          if ((existing?.revision ?? null) !== expectedRevision) throw new AgentKnowledgeError('VERSION_CONFLICT', 'Source changed during scanning; retry with a new request key');
          if (source.revision !== (expectedRevision ?? 0) + 1) throw new AgentKnowledgeError('VERSION_CONFLICT', 'Source revision must advance by one');
          this.db.prepare(`INSERT INTO sources(id, revision, deleted, payload) VALUES (?, ?, 0, ?)
            ON CONFLICT(id) DO UPDATE SET revision = excluded.revision, deleted = 0, payload = excluded.payload`)
            .run(source.id, source.revision, JSON.stringify({ ...source, deleted: false }));
        },
        replaceFile: async (file) => {
          this.db.prepare('UPDATE file_versions SET current = 0 WHERE source_id = ? AND path = ?').run(file.source_id, file.path);
          this.db.prepare('INSERT INTO file_versions(id,source_id,path,current,payload) VALUES (?,?,?,1,?)').run(file.id, file.source_id, file.path, JSON.stringify(file));
        },
        removeFile: async (sourceId, filePath) => {
          this.db.prepare('UPDATE file_versions SET current = 0 WHERE source_id = ? AND path = ?').run(sourceId, filePath);
        },
        delete: async (id) => {
          this.db.prepare('DELETE FROM file_versions WHERE source_id = ?').run(id);
          this.db.prepare('DELETE FROM requests WHERE source_id = ?').run(id);
          // Keep a metadata-only tombstone and monotonic revision to reject scans started before deletion.
          this.db.prepare(`UPDATE sources SET deleted = 1, revision = revision + 1,
            payload = json_set(payload, '$.deleted', json('true'), '$.revision', revision + 1) WHERE id = ?`).run(id);
        },
      },
      records: {
        getActive: async (id, scope) => {
          const filter = scopeSql(scope);
          return payload<KnowledgeRecord>(this.db.prepare(`SELECT r.payload FROM records r
            JOIN sources s ON s.id = r.source_id JOIN file_versions f ON f.id = r.file_version_id
            WHERE r.id = ? AND r.status = 'active' AND s.deleted = 0 AND f.current = 1 AND ${filter.sql}`).get(id, ...filter.args));
        },
        insert: async (record) => {
          const ref = record.source_refs[0];
          this.db.prepare(`INSERT INTO records(id,source_id,file_version_id,path,owner_id,project_id,status,payload) VALUES (?,?,?,?,?,?,?,?)`)
            .run(record.id, ref.source_id, ref.source_version_id, ref.path, record.owner_id, record.project_id, record.status, JSON.stringify(record));
          if (record.status === 'active') this.db.prepare('INSERT INTO search_documents(record_id,content,path) VALUES (?,?,?)').run(record.id, record.content, ref.path);
        },
        supersedeFile: async (sourceId, filePath, at) => {
          this.db.prepare('DELETE FROM search_documents WHERE record_id IN (SELECT id FROM records WHERE source_id = ? AND path = ?)').run(sourceId, filePath);
          this.db.prepare(`UPDATE records SET status = 'superseded', payload = json_set(payload, '$.status', 'superseded', '$.updated_at', ?)
            WHERE source_id = ? AND path = ? AND status = 'active'`).run(at, sourceId, filePath);
        },
        deleteSource: async (sourceId) => { this.db.prepare('DELETE FROM records WHERE source_id = ?').run(sourceId); },
      },
      audit: {
        append: async (operation, sourceId, detail) => {
          this.db.prepare('INSERT INTO audit(source_id,operation,at,detail) VALUES (?,?,?,?)').run(sourceId, operation, new Date().toISOString(), JSON.stringify(detail));
        },
        getRequest: async (key) => {
          const row = this.db.prepare('SELECT fingerprint,result FROM requests WHERE key = ?').get(key);
          return row ? { fingerprint: row.fingerprint as string, result: JSON.parse(row.result as string) as SyncResult } : null;
        },
        saveRequest: async (key, fingerprint, result) => {
          this.db.prepare('INSERT INTO requests(key,source_id,fingerprint,result) VALUES (?,?,?,?)').run(key, result.source_id, fingerprint, JSON.stringify(result));
        },
      },
    };
  }

  close(): void { this.db.close(); }
}
