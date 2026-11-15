import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { FollowError } from './errors.js';

/**
 * Strict follow configuration. Relative paths resolve against this file, never
 * against the process cwd. The plaintext token is read only from the named
 * environment variable; the file stores no credential.
 */
export const FOLLOW_CONFIG_VERSION = 1;
export const DEFAULT_PAGE_SIZE = 200;
export const DEFAULT_IDLE_SECONDS = 15;
export const DEFAULT_TIMEOUT_SECONDS = 20;
export const DEFAULT_MAX_BACKOFF_SECONDS = 300;
const MAX_CONFIG_BYTES = 1024 * 1024;
const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost']);
const TOKEN_ENV = /^[A-Z][A-Z0-9_]*$/;
const KEYS = new Set([
  'schema_version', 'trace_url', 'token_env', 'config',
  'page_size', 'idle_seconds', 'request_timeout_seconds', 'max_backoff_seconds',
]);

export interface FollowConfig {
  path: string;
  /** Normalized `http://host:port` loopback origin. */
  traceUrl: string;
  tokenEnv: string;
  /** Existing agent-knowledge configuration; database and project scope come from it. */
  knowledgeConfig: string;
  pageSize: number;
  idleSeconds: number;
  requestTimeoutSeconds: number;
  maxBackoffSeconds: number;
}

function invalid(field: string, message: string): never {
  throw new FollowError('INVALID_CONFIG', 'permanent', field ? `config.${field}: ${message}` : `config: ${message}`);
}

function integer(value: unknown, field: string, low: number, high: number): number {
  if (!Number.isSafeInteger(value) || Number(value) < low || Number(value) > high) {
    invalid(field, `must be an integer ${low}..${high}`);
  }
  return Number(value);
}

export function parseTraceUrl(value: unknown): string {
  if (typeof value !== 'string' || !value || value.length > 4096) invalid('trace_url', 'must be a non-empty string');
  let url: URL;
  try { url = new URL(value); } catch { invalid('trace_url', 'must be a valid URL'); }
  if (url.protocol !== 'http:') invalid('trace_url', 'must use http');
  if (url.username || url.password) invalid('trace_url', 'must not contain credentials');
  if (url.pathname !== '/' ) invalid('trace_url', 'must not contain a path');
  if (url.search || url.hash) invalid('trace_url', 'must not contain a query or fragment');
  if (!LOOPBACK.has(url.hostname)) invalid('trace_url', 'host must be 127.0.0.1, ::1 or localhost');
  if (!url.port) invalid('trace_url', 'must include the port agent-trace listens on');
  const host = url.hostname.includes(':') ? `[${url.hostname}]` : url.hostname;
  return `http://${host}:${url.port}`;
}

export function loadFollowConfig(filename: string): FollowConfig {
  const configPath = path.resolve(filename);
  let stat;
  try { stat = statSync(configPath); } catch { invalid('', `cannot read ${configPath}`); }
  if (!stat.isFile()) invalid('', `${configPath} is not a regular file`);
  if (stat.size > MAX_CONFIG_BYTES) invalid('', `file exceeds ${MAX_CONFIG_BYTES} bytes`);
  let raw: unknown;
  try { raw = JSON.parse(readFileSync(configPath, 'utf8')); } catch (error) {
    invalid('', `invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) invalid('', 'top level must be a JSON object');
  const object = raw as Record<string, unknown>;
  for (const key of Object.keys(object)) if (!KEYS.has(key)) invalid('', `unknown field "${key}"`);
  if (object.schema_version !== FOLLOW_CONFIG_VERSION) invalid('schema_version', `must be ${FOLLOW_CONFIG_VERSION}`);
  for (const field of ['trace_url', 'token_env', 'config']) {
    if (!(field in object)) invalid(field, 'is required');
  }
  const traceUrl = parseTraceUrl(object.trace_url);
  if (typeof object.token_env !== 'string' || !TOKEN_ENV.test(object.token_env)) {
    invalid('token_env', 'must be an environment variable name such as AGENT_TRACE_KNOWLEDGE_TOKEN');
  }
  const target = object.config;
  if (typeof target !== 'string' || !target || target.length > 4096 || /[\x00-\x1f]/.test(target)) {
    invalid('config', 'must be a non-empty bounded path');
  }
  if (target.startsWith('~')) invalid('config', 'must not use ~; use an absolute path or a path relative to the follow configuration');

  const idleSeconds = object.idle_seconds === undefined
    ? DEFAULT_IDLE_SECONDS
    : integer(object.idle_seconds, 'idle_seconds', 1, 3600);
  const pageSize = object.page_size === undefined
    ? DEFAULT_PAGE_SIZE
    : integer(object.page_size, 'page_size', 1, 1000);
  const requestTimeoutSeconds = object.request_timeout_seconds === undefined
    ? DEFAULT_TIMEOUT_SECONDS
    : integer(object.request_timeout_seconds, 'request_timeout_seconds', 1, 120);
  const maxBackoffSeconds = object.max_backoff_seconds === undefined
    ? DEFAULT_MAX_BACKOFF_SECONDS
    : integer(object.max_backoff_seconds, 'max_backoff_seconds', idleSeconds, 3600);

  return {
    path: configPath,
    traceUrl,
    tokenEnv: object.token_env,
    knowledgeConfig: path.isAbsolute(target) ? path.normalize(target) : path.resolve(path.dirname(configPath), target),
    pageSize,
    idleSeconds,
    requestTimeoutSeconds,
    maxBackoffSeconds,
  };
}

export function readToken(config: FollowConfig, env: NodeJS.ProcessEnv = process.env): string {
  const value = env[config.tokenEnv];
  if (typeof value !== 'string' || !value || value !== value.trim()) {
    throw new FollowError('TOKEN_MISSING', 'permanent', `environment variable ${config.tokenEnv} must hold the bearer token`);
  }
  return value;
}
