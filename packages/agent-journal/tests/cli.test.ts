import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { configFor } from './helpers.ts';

const ROOT = path.resolve(import.meta.dirname, '..');

function run(args: string[], env: NodeJS.ProcessEnv) {
  return spawnSync(process.execPath, ['src/cli.ts', ...args], { cwd: ROOT, env, encoding: 'utf8' });
}

test('offline import and dream work without credentials', () => {
  const config = configFor('http://127.0.0.1:9', { projects: ['demo'] });
  const env = { ...process.env };
  delete env[config.tokenEnv];
  const imported = run(['import', '--config', config.configPath, '--file', 'examples/custom-activity.json'], env);
  assert.equal(imported.status, 0, imported.stderr);
  assert.equal(JSON.parse(imported.stdout).imported, 2);
  const dream = run(['dream', '--config', config.configPath, '--date', '2026-01-01', '--no-sync', '--no-model'], env);
  assert.equal(dream.status, 0, dream.stderr);
});

test('config-check reports the model key without exposing it', () => {
  const config = configFor('http://127.0.0.1:9', {
    projects: ['fixture'],
    model: {
      provider: 'openai-compatible', base_url: 'https://api.deepseek.com/v1', model: 'deepseek-flash',
      api_key_env: 'JOURNAL_ABSENT_KEY', timeout_seconds: 10, max_output_tokens: 100,
    },
  });
  const env = { ...process.env };
  delete env.JOURNAL_ABSENT_KEY;
  const result = run(['config-check', '--config', config.configPath], env);
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout) as Record<string, unknown>;
  assert.equal(output.model_key_present, false);
  assert.equal(JSON.stringify(output).includes('sk-'), false);
});

test('verify-model fails clearly without the configured key', () => {
  const config = configFor('http://127.0.0.1:9', {
    projects: ['fixture'],
    model: {
      provider: 'openai-compatible', base_url: 'https://api.deepseek.com/v1', model: 'deepseek-flash',
      api_key_env: 'JOURNAL_ABSENT_KEY', timeout_seconds: 10, max_output_tokens: 100,
    },
  });
  const env = { ...process.env };
  delete env.JOURNAL_ABSENT_KEY;
  const result = run(['verify-model', '--config', config.configPath], env);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /MODEL_KEY_MISSING/);
});
