import { readFileSync } from 'node:fs';
import path from 'node:path';
import { JournalError } from './errors.ts';
import { localDayWindow } from './day.ts';

const CONFIG_KEYS = new Set([
  'schema_version', 'timezone', 'database', 'trace_url', 'token_env', 'output_directory',
  'projects', 'page_size', 'finalize', 'budget', 'model',
]);
const ENV_NAME = /^[A-Z][A-Z0-9_]*$/;
const PROJECT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;
const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost']);
const MAX_CONFIG_BYTES = 1024 * 1024;

export interface ModelConfig {
  provider: 'openai-compatible';
  baseUrl: string;
  model: string;
  apiKeyEnv: string;
  timeoutSeconds: number;
  maxOutputTokens: number;
}

export interface FinalizeConfig {
  graceHours: number;
  maxDaysPerRun: number;
  lateObservedHours: number;
}

export interface BudgetConfig {
  maxInputTokensPerDay: number;
  maxOutputTokensPerDay: number;
}

export interface JournalConfig {
  configPath: string;
  schemaVersion: 1;
  timezone: string;
  database: string;
  traceUrl: string;
  tokenEnv: string;
  outputDirectory: string;
  projects: string[];
  pageSize: number;
  finalize: FinalizeConfig;
  budget: BudgetConfig;
  model: ModelConfig | null;
}

function invalid(field: string, message: string): never {
  throw new JournalError('INVALID_CONFIG', 'config', field ? `config.${field}: ${message}` : `config: ${message}`);
}

function object(value: unknown, field: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) invalid(field, 'must be an object');
  return value as Record<string, unknown>;
}

function unknownKeys(value: Record<string, unknown>, allowed: Set<string>, field: string): void {
  for (const key of Object.keys(value)) if (!allowed.has(key)) invalid(field ? `${field}.${key}` : key, 'unknown field');
}

function text(value: unknown, field: string, max = 4096): string {
  if (typeof value !== 'string' || !value || value.length > max || value.trim() !== value) {
    invalid(field, 'must be a non-empty trimmed string');
  }
  return value;
}

function integer(value: unknown, field: string, low: number, high: number, fallback?: number): number {
  if (value === undefined && fallback !== undefined) return fallback;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < low || value > high) {
    invalid(field, `must be an integer ${low}..${high}`);
  }
  return value;
}

function loopbackUrl(value: unknown): string {
  const raw = text(value, 'trace_url');
  let url: URL;
  try { url = new URL(raw); } catch { invalid('trace_url', 'must be a valid URL'); }
  if (url.protocol !== 'http:') invalid('trace_url', 'must use http');
  if (url.username || url.password) invalid('trace_url', 'must not contain credentials');
  if (url.pathname !== '/') invalid('trace_url', 'must not contain a path');
  if (url.search || url.hash) invalid('trace_url', 'must not contain a query or fragment');
  if (!LOOPBACK.has(url.hostname)) invalid('trace_url', 'host must be 127.0.0.1, ::1 or localhost');
  if (!url.port) invalid('trace_url', 'must include the port agent-trace listens on');
  const host = url.hostname.includes(':') ? `[${url.hostname}]` : url.hostname;
  return `http://${host}:${url.port}`;
}

function httpUrl(value: unknown, field: string): string {
  const raw = text(value, field);
  let url: URL;
  try { url = new URL(raw); } catch { invalid(field, 'must be a valid URL'); }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') invalid(field, 'must use http or https');
  if (url.username || url.password) invalid(field, 'must not contain credentials');
  return raw.replace(/\/+$/, '');
}

function loadModel(value: unknown): ModelConfig | null {
  if (value === undefined || value === null) return null;
  const model = object(value, 'model');
  unknownKeys(model, new Set(['provider', 'base_url', 'model', 'api_key_env', 'timeout_seconds', 'max_output_tokens']), 'model');
  if (model.provider !== 'openai-compatible') invalid('model.provider', 'must be openai-compatible');
  const apiKeyEnv = text(model.api_key_env, 'model.api_key_env');
  if (!ENV_NAME.test(apiKeyEnv)) invalid('model.api_key_env', 'must be an environment variable name');
  return {
    provider: 'openai-compatible',
    baseUrl: httpUrl(model.base_url, 'model.base_url'),
    model: text(model.model, 'model.model', 200),
    apiKeyEnv,
    timeoutSeconds: integer(model.timeout_seconds, 'model.timeout_seconds', 1, 600, 60),
    maxOutputTokens: integer(model.max_output_tokens, 'model.max_output_tokens', 1, 65536, 4000),
  };
}

function loadProjects(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0) invalid('projects', 'must be a non-empty array');
  const projects: string[] = [];
  for (const [index, entry] of value.entries()) {
    const project = text(entry, `projects[${index}]`, 200);
    if (!PROJECT_ID.test(project)) invalid(`projects[${index}]`, 'must contain only letters, digits, dot, underscore or dash');
    if (projects.includes(project)) invalid('projects', `duplicate project ${project}`);
    projects.push(project);
  }
  return projects;
}

/** Load and strictly validate a journal configuration file. */
export function loadConfig(configPath: string): JournalConfig {
  const absolutePath = path.resolve(configPath);
  let raw: string;
  try {
    raw = readFileSync(absolutePath, 'utf8');
  } catch (error) {
    throw new JournalError('INVALID_CONFIG', 'config', `Cannot read configuration ${absolutePath}: ${(error as Error).message}`);
  }
  if (Buffer.byteLength(raw) > MAX_CONFIG_BYTES) invalid('', 'configuration file is too large');
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { invalid('', 'configuration is not valid JSON'); }
  const config = object(parsed, '');
  unknownKeys(config, CONFIG_KEYS, '');
  if (config.schema_version !== 1) invalid('schema_version', 'must be 1');

  const directory = path.dirname(absolutePath);
  const timezone = config.timezone === undefined ? 'Asia/Shanghai' : text(config.timezone, 'timezone', 64);
  try { localDayWindow('2026-11-15', timezone); } catch { invalid('timezone', `invalid time zone ${timezone}`); }

  const finalizeRaw = config.finalize === undefined ? {} : object(config.finalize, 'finalize');
  unknownKeys(finalizeRaw, new Set(['grace_hours', 'max_days_per_run', 'late_observed_hours']), 'finalize');
  const budgetRaw = config.budget === undefined ? {} : object(config.budget, 'budget');
  unknownKeys(budgetRaw, new Set(['max_input_tokens_per_day', 'max_output_tokens_per_day']), 'budget');

  const database = path.resolve(directory, config.database === undefined ? './.agent-journal/journal.sqlite' : text(config.database, 'database', 4096));
  const outputDirectory = path.resolve(directory, config.output_directory === undefined ? './daily' : text(config.output_directory, 'output_directory', 4096));
  const tokenEnv = text(config.token_env, 'token_env');
  if (!ENV_NAME.test(tokenEnv)) invalid('token_env', 'must be an environment variable name');

  return {
    configPath: absolutePath,
    schemaVersion: 1,
    timezone,
    database,
    traceUrl: loopbackUrl(config.trace_url),
    tokenEnv,
    outputDirectory,
    projects: loadProjects(config.projects),
    pageSize: integer(config.page_size, 'page_size', 1, 1000, 500),
    finalize: {
      graceHours: integer(finalizeRaw.grace_hours, 'finalize.grace_hours', 0, 72, 6),
      maxDaysPerRun: integer(finalizeRaw.max_days_per_run, 'finalize.max_days_per_run', 1, 30, 7),
      lateObservedHours: integer(finalizeRaw.late_observed_hours, 'finalize.late_observed_hours', 1, 720, 36),
    },
    budget: {
      maxInputTokensPerDay: integer(budgetRaw.max_input_tokens_per_day, 'budget.max_input_tokens_per_day', 1_000, 2_000_000, 120_000),
      maxOutputTokensPerDay: integer(budgetRaw.max_output_tokens_per_day, 'budget.max_output_tokens_per_day', 100, 200_000, 10_000),
    },
    model: loadModel(config.model),
  };
}

/** Safe projection for `config-check`; never includes the token. */
export function configSummary(config: JournalConfig): Record<string, unknown> {
  return {
    config: config.configPath,
    timezone: config.timezone,
    database: config.database,
    trace_url: config.traceUrl,
    token_env: config.tokenEnv,
    output_directory: config.outputDirectory,
    projects: config.projects,
    page_size: config.pageSize,
    finalize: config.finalize,
    budget: config.budget,
    model: config.model ? { provider: config.model.provider, base_url: config.model.baseUrl, model: config.model.model, api_key_env: config.model.apiKeyEnv } : null,
  };
}

export function tokenFromEnv(config: JournalConfig, env: NodeJS.ProcessEnv = process.env): string {
  const token = env[config.tokenEnv];
  if (typeof token !== 'string' || !token.trim()) {
    throw new JournalError('TOKEN_MISSING', 'config', `Environment variable ${config.tokenEnv} is missing or empty`);
  }
  if (token.trim() !== token) throw new JournalError('TOKEN_MISSING', 'config', `Environment variable ${config.tokenEnv} has surrounding whitespace`);
  return token;
}
