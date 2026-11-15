import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { configSummary, loadConfig, tokenFromEnv } from '../src/config.ts';
import { JournalError } from '../src/errors.ts';
import { tempDirectory, TOKEN_ENV } from './helpers.ts';

function writeJson(directory: string, value: unknown): string {
  const file = path.join(directory, 'config.json');
  writeFileSync(file, JSON.stringify(value));
  return file;
}

function valid(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema_version: 1,
    trace_url: 'http://127.0.0.1:18767',
    token_env: 'JOURNAL_TEST_TOKEN',
    projects: ['fixture'],
    ...overrides,
  };
}

test('loads a minimal config and resolves default paths against the config directory', () => {
  const directory = tempDirectory();
  const config = loadConfig(writeJson(directory, valid()));
  assert.equal(config.timezone, 'Asia/Shanghai');
  assert.equal(config.database, path.join(directory, '.agent-journal/journal.sqlite'));
  assert.equal(config.outputDirectory, path.join(directory, 'daily'));
  assert.equal(config.pageSize, 500);
  assert.deepEqual(config.finalize, { graceHours: 6, maxDaysPerRun: 7, lateObservedHours: 36 });
  assert.equal(config.model, null);
});

test('the checked-in example config is valid and does not expose a token', () => {
  const config = loadConfig(path.resolve(import.meta.dirname, '../agent-journal.example.json'));
  const summary = configSummary(config);
  assert.equal(summary.token_env, 'AGENT_TRACE_JOURNAL_TOKEN');
  assert.equal('api_key' in summary, false);
  assert.equal(JSON.stringify(summary).includes('secret'), false);
});

test('unknown fields and bad values are rejected', () => {
  const directory = tempDirectory();
  assert.throws(() => loadConfig(writeJson(directory, { ...valid(), unexpected: true })), (error: unknown) => error instanceof JournalError && error.code === 'INVALID_CONFIG');
  assert.throws(() => loadConfig(writeJson(directory, valid({ schema_version: 2 }))), /schema_version/);
  assert.throws(() => loadConfig(writeJson(directory, valid({ projects: [] }))), /projects/);
  assert.throws(() => loadConfig(writeJson(directory, valid({ projects: ['fixture', 'fixture'] }))), /duplicate/);
  assert.throws(() => loadConfig(writeJson(directory, valid({ token_env: 'lowercase' }))), /token_env/);
  assert.throws(() => loadConfig(writeJson(directory, valid({ timezone: 'Mars/Olympus' }))), /time zone/);
});

test('trace_url must be a loopback http origin with an explicit port', () => {
  for (const traceUrl of [
    'https://127.0.0.1:18767',
    'http://example.com:18767',
    'http://127.0.0.1:18767/path',
    'http://127.0.0.1:18767?x=1',
    'http://user:pass@127.0.0.1:18767',
    'http://127.0.0.1',
  ]) {
    const directory = tempDirectory();
    assert.throws(() => loadConfig(writeJson(directory, valid({ trace_url: traceUrl }))), JournalError, traceUrl);
  }
});

test('model config is strict', () => {
  const directory = tempDirectory();
  const base = { provider: 'openai-compatible', base_url: 'https://api.example.com/v1', model: 'm', api_key_env: 'JOURNAL_KEY' };
  const config = loadConfig(writeJson(directory, valid({ model: base })));
  assert.equal(config.model?.baseUrl, 'https://api.example.com/v1');
  assert.throws(() => loadConfig(writeJson(directory, valid({ model: { ...base, provider: 'other' } }))), /provider/);
  assert.throws(() => loadConfig(writeJson(directory, valid({ model: { ...base, api_key_env: 'bad' } }))), /api_key_env/);
  assert.throws(() => loadConfig(writeJson(directory, valid({ model: { ...base, unknown: 1 } }))), /unknown/);
});

test('token is read only from the configured environment variable', () => {
  const directory = tempDirectory();
  const config = loadConfig(writeJson(directory, valid()));
  assert.equal(tokenFromEnv(config, { [TOKEN_ENV]: 'abc' }), 'abc');
  assert.throws(() => tokenFromEnv(config, {}), (error: unknown) => error instanceof JournalError && error.code === 'TOKEN_MISSING');
  assert.throws(() => tokenFromEnv(config, { [TOKEN_ENV]: ' abc ' }), /whitespace/);
});
