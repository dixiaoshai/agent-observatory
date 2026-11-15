import { randomUUID } from 'node:crypto';
import { chunkText, contentHash, AgentKnowledgeError } from '../core/index.js';
import type { AccessScope, KnowledgeRecord, SourceDefinition, SourceState } from '../core/index.js';
import type { LexicalSearchIndex, Repositories, SourceScanner, SyncResult, UnitOfWork } from './ports.js';

export interface ApplicationConfig {
  owner_id: string;
  allowed_project_ids: string[];
  sources: SourceDefinition[];
}

export class AgentKnowledge {
  constructor(
    private readonly config: ApplicationConfig,
    private readonly repositories: Repositories,
    private readonly uow: UnitOfWork,
    private readonly index: LexicalSearchIndex,
    private readonly scanner: SourceScanner,
  ) {}

  private source(id: string): SourceDefinition {
    const source = this.config.sources.find((item) => item.id === id);
    if (!source || !this.config.allowed_project_ids.includes(source.project_id)) {
      throw new AgentKnowledgeError('NOT_FOUND', 'Source not found in the configured scope');
    }
    return source;
  }

  private scope(projectId?: string): AccessScope {
    if (projectId !== undefined && !this.config.allowed_project_ids.includes(projectId)) {
      throw new AgentKnowledgeError('FORBIDDEN', 'Project is outside the configured scope');
    }
    const projects = projectId === undefined ? this.config.allowed_project_ids : [projectId];
    return {
      owner_id: this.config.owner_id,
      project_ids: projects,
      source_ids: this.config.sources.filter((source) => projects.includes(source.project_id)).map((source) => source.id),
    };
  }

  private checkBinding(state: SourceState | null, source: SourceDefinition): void {
    if (state && (state.owner_id !== this.config.owner_id || (!state.deleted && (state.root !== source.root || state.project_id !== source.project_id)))) {
      throw new AgentKnowledgeError('SOURCE_CHANGED', 'Source binding changed; delete the old source before reusing its ID');
    }
  }

  async sync(sourceId: string, requestKey: string): Promise<SyncResult> {
    if (!requestKey.trim() || requestKey.length > 256) throw new AgentKnowledgeError('INVALID_INPUT', 'A request key of 1–256 characters is required');
    const source = this.source(sourceId);
    const fingerprint = contentHash(JSON.stringify({ source, owner_id: this.config.owner_id }));
    const replay = await this.repositories.audit.getRequest(requestKey);
    if (replay) {
      if (replay.fingerprint !== fingerprint) throw new AgentKnowledgeError('IDEMPOTENCY_CONFLICT', 'Request key was used for a different source configuration');
      return replay.result;
    }
    const previous = await this.repositories.sources.get(sourceId);
    this.checkBinding(previous, source);
    // File and Git I/O stays outside the transaction. A failed scan cannot remove old data.
    const scan = await this.scanner.scan(source);
    return this.uow.run(async ({ sources, records, audit }) => {
      const replay = await audit.getRequest(requestKey);
      if (replay) {
        if (replay.fingerprint !== fingerprint) throw new AgentKnowledgeError('IDEMPOTENCY_CONFLICT', 'Request key conflict');
        return replay.result;
      }
      const now = new Date().toISOString();
      const state: SourceState = {
        id: source.id, root: source.root, project_id: source.project_id,
        owner_id: this.config.owner_id, revision: (previous?.revision ?? 0) + 1, updated_at: now,
      };
      await sources.save(state, previous?.revision ?? null);
      const old = new Map((await sources.listFiles(sourceId)).map((file) => [file.path, file]));
      const result: SyncResult = { source_id: sourceId, revision: state.revision, added: 0, updated: 0, deleted: 0, unchanged: 0, skipped: scan.skipped };
      for (const file of scan.files) {
        const prior = old.get(file.path);
        old.delete(file.path);
        if (prior?.content_hash === file.content_hash && prior.git_commit === file.git_commit) {
          result.unchanged++;
          continue;
        }
        if (prior) result.updated++; else result.added++;
        await records.supersedeFile(sourceId, file.path, now);
        const version = { ...file, id: randomUUID(), source_id: sourceId, created_at: now };
        await sources.replaceFile(version);
        for (const chunk of chunkText(file.content)) {
          const record: KnowledgeRecord = {
            id: randomUUID(), schema_version: 1, kind: 'knowledge', content: chunk.content,
            source_refs: [{ source_id: sourceId, source_version_id: version.id, path: file.path,
              start_line: chunk.start_line, end_line: chunk.end_line, content_hash: file.content_hash, git_commit: file.git_commit }],
            created_at: now, updated_at: now, status: 'active', scope: 'project', owner_id: state.owner_id,
            project_id: source.project_id, team_id: null, org_id: null, generated: false,
          };
          await records.insert(record);
        }
      }
      for (const file of old.values()) {
        await records.supersedeFile(sourceId, file.path, now);
        await sources.removeFile(sourceId, file.path);
        result.deleted++;
      }
      await audit.append('sync_source', sourceId, result);
      await audit.saveRequest(requestKey, fingerprint, result);
      return result;
    });
  }

  /** Validate current source snapshots once per source per request; never return stale text. */
  private async freshness(records: KnowledgeRecord[]): Promise<Set<string>> {
    const valid = new Set<string>();
    for (const sourceId of new Set(records.map((record) => record.source_refs[0].source_id))) {
      const source = this.source(sourceId);
      this.checkBinding(await this.repositories.sources.get(sourceId), source);
      try {
        const files = new Map((await this.scanner.scan(source)).files.map((file) => [file.path, file]));
        for (const record of records) {
          const ref = record.source_refs[0];
          if (ref.source_id === sourceId && files.get(ref.path)?.content_hash === ref.content_hash) valid.add(record.id);
        }
      } catch {
        // Missing/unreadable roots fail closed; callers can sync to see the exact I/O error.
      }
    }
    return valid;
  }

  async search(query: string, projectId?: string, limit = 5): Promise<Array<{ record: KnowledgeRecord; score: number }>> {
    if (typeof query !== 'string' || query.length > 4096 || !query.trim()) throw new AgentKnowledgeError('INVALID_INPUT', 'query must contain 1–4096 characters');
    if (!Number.isInteger(limit) || limit < 1 || limit > 20) throw new AgentKnowledgeError('INVALID_INPUT', 'limit must be between 1 and 20');
    const scope = this.scope(projectId);
    const hits = await this.index.search(query, scope, 100);
    const records = (await Promise.all(hits.map((hit) => this.repositories.records.getActive(hit.id, scope)))).filter((record): record is KnowledgeRecord => record !== null);
    const valid = await this.freshness(records);
    // A CLI process may update/delete a source while the filesystem scan is in flight.
    const current = await Promise.all(records.filter((record) => valid.has(record.id)).map((record) => this.repositories.records.getActive(record.id, scope)));
    return current.filter((record): record is KnowledgeRecord => record !== null).slice(0, limit)
      .map((record) => ({ record, score: hits.find((hit) => hit.id === record.id)!.score }));
  }

  async read(id: string, projectId?: string): Promise<KnowledgeRecord> {
    const scope = this.scope(projectId);
    const record = await this.repositories.records.getActive(id, scope);
    if (!record || !(await this.freshness([record])).has(id)) {
      throw new AgentKnowledgeError('NOT_FOUND', 'Record is unavailable in the current scope or source version; sync the source and search again');
    }
    const current = await this.repositories.records.getActive(id, scope);
    if (!current) throw new AgentKnowledgeError('NOT_FOUND', 'Record was updated or deleted while being read; search again');
    return current;
  }

  async deleteSource(sourceId: string): Promise<void> {
    const source = this.source(sourceId);
    await this.uow.run(async ({ sources, records, audit }) => {
      const existing = await sources.get(sourceId);
      this.checkBinding(existing, source);
      if (!existing) {
        // Reserve the ID even if its very first scan has not reached the database yet.
        await sources.save({ id: source.id, root: source.root, project_id: source.project_id,
          owner_id: this.config.owner_id, revision: 1, updated_at: new Date().toISOString() }, null);
      }
      await records.deleteSource(sourceId);
      await sources.delete(sourceId);
      await audit.append('delete_source', sourceId, {});
    });
  }

  async rebuildIndex(): Promise<number> { return this.index.rebuild(); }
}

export { AgentKnowledge as KnowRelay };
