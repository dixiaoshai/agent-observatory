import { createHash } from 'node:crypto';

export interface SourceDefinition {
  id: string;
  root: string;
  project_id: string;
  include_extensions?: string[];
  max_file_bytes?: number;
}

export interface SourceState {
  id: string;
  root: string;
  project_id: string;
  owner_id: string;
  revision: number;
  updated_at: string;
  deleted?: boolean;
}

export interface SourceRef {
  source_id: string;
  source_version_id: string;
  path: string;
  start_line: number;
  end_line: number;
  content_hash: string;
  git_commit: string | null;
}

export interface KnowledgeRecord {
  id: string;
  schema_version: 1;
  kind: 'knowledge';
  content: string;
  source_refs: [SourceRef];
  created_at: string;
  updated_at: string;
  status: 'active' | 'superseded';
  scope: 'project';
  owner_id: string;
  project_id: string;
  team_id: null;
  org_id: null;
  generated: false;
}

export interface FileVersion {
  id: string;
  source_id: string;
  path: string;
  content_hash: string;
  git_commit: string | null;
  content: string;
  created_at: string;
}

export interface AccessScope {
  owner_id: string;
  project_ids: readonly string[];
  source_ids: readonly string[];
}

export class AgentKnowledgeError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'AgentKnowledgeError';
  }
}

export function contentHash(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

/** Preserve original line endings and one-based source line ranges. */
export function chunkText(content: string): Array<{ content: string; start_line: number; end_line: number }> {
  if (!content.length) return [];
  const lines = content.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  const chunks: Array<{ content: string; start_line: number; end_line: number }> = [];
  for (let start = 0; start < lines.length;) {
    let end = start;
    let size = 0;
    while (end < lines.length && end - start < 60) {
      const length = lines[end]!.length;
      if (end > start && size + length > 8000) break;
      size += length;
      end++;
    }
    chunks.push({ content: lines.slice(start, end).join(''), start_line: start + 1, end_line: end });
    if (end === lines.length) break;
    start = Math.max(start + 1, end - 10);
  }
  return chunks;
}

export { AgentKnowledgeError as KnowRelayError };
