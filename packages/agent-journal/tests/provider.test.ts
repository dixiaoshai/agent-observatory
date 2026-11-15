import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createOpenAiCompatibleProvider } from '../src/provider.ts';
import { JournalError } from '../src/errors.ts';
import type { ModelConfig } from '../src/config.ts';

interface MockResponse { status: number; body: string; contentType?: string }

async function withServer(
  responder: (request: { body: string; headers: Record<string, unknown> }) => MockResponse,
  run: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    const outgoing = responder({ body: Buffer.concat(chunks).toString('utf8'), headers: request.headers as Record<string, unknown> });
    response.writeHead(outgoing.status, { 'content-type': outgoing.contentType ?? 'application/json' });
    response.end(outgoing.body);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  try {
    await run(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

function model(baseUrl: string): ModelConfig {
  return {
    provider: 'openai-compatible',
    baseUrl,
    model: 'test-model',
    apiKeyEnv: 'JOURNAL_TEST_KEY',
    timeoutSeconds: 5,
    maxOutputTokens: 1_000,
  };
}

test('provider sends an OpenAI-compatible request and parses usage', async () => {
  let capturedBody: Record<string, unknown> | null = null;
  let capturedAuthorization: unknown = null;
  await withServer((request) => {
    capturedBody = JSON.parse(request.body);
    capturedAuthorization = request.headers.authorization;
    return {
      status: 200,
      body: JSON.stringify({
        model: 'test-model',
        choices: [{ message: { content: '{"ok":true}' } }],
        usage: { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16 },
      }),
    };
  }, async (baseUrl) => {
    const provider = createOpenAiCompatibleProvider(model(baseUrl), { env: { JOURNAL_TEST_KEY: 'secret-key' } });
    const result = await provider.complete([{ role: 'user', content: 'hello' }], { maxOutputTokens: 100 });
    assert.equal(result.content, '{"ok":true}');
    assert.deepEqual(result.usage, { input_tokens: 12, output_tokens: 4, total_tokens: 16 });
    assert.equal(capturedAuthorization, 'Bearer secret-key');
    assert.equal(capturedBody?.model, 'test-model');
    assert.equal(capturedBody?.max_tokens, 100);
  });
});

test('provider maps HTTP failures to journal errors', async () => {
  await withServer(() => ({ status: 401, body: JSON.stringify({ error: { message: 'bad key' } }) }), async (baseUrl) => {
    const provider = createOpenAiCompatibleProvider(model(baseUrl), { env: { JOURNAL_TEST_KEY: 'secret-key' } });
    await assert.rejects(() => provider.complete([{ role: 'user', content: 'hello' }], { maxOutputTokens: 10 }),
      (error: unknown) => error instanceof JournalError && error.code === 'MODEL_UNAUTHORIZED' && error.klass === 'permanent');
  });
});

test('provider accepts content parts and explains an empty text response', async () => {
  await withServer(() => ({
    status: 200,
    body: JSON.stringify({
      model: 'test-model',
      choices: [{ message: { content: [{ type: 'text', text: '{"ok":true}' }] }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
    }),
  }), async (baseUrl) => {
    const provider = createOpenAiCompatibleProvider(model(baseUrl), { env: { JOURNAL_TEST_KEY: 'secret-key' } });
    const result = await provider.complete([{ role: 'user', content: 'hi' }], { maxOutputTokens: 10 });
    assert.equal(result.content, '{"ok":true}');
  });

  await withServer(() => ({
    status: 200,
    body: JSON.stringify({
      model: 'test-model',
      choices: [{ message: { content: '', reasoning_content: 'thinking only' }, finish_reason: 'length' }],
      usage: { prompt_tokens: 1, completion_tokens: 32, total_tokens: 33 },
    }),
  }), async (baseUrl) => {
    const provider = createOpenAiCompatibleProvider(model(baseUrl), { env: { JOURNAL_TEST_KEY: 'secret-key' } });
    await assert.rejects(() => provider.complete([{ role: 'user', content: 'hi' }], { maxOutputTokens: 32 }),
      (error: unknown) => error instanceof JournalError
        && error.code === 'MODEL_OUTPUT'
        && /finish_reason=length/.test(error.message)
        && /reasoning_content/.test(error.message));
  });
});

test('provider rejects malformed responses and a missing key', async () => {
  await withServer(() => ({ status: 200, body: 'not-json' }), async (baseUrl) => {
    const provider = createOpenAiCompatibleProvider(model(baseUrl), { env: { JOURNAL_TEST_KEY: 'secret-key' } });
    await assert.rejects(() => provider.complete([{ role: 'user', content: 'hello' }], { maxOutputTokens: 10 }),
      (error: unknown) => error instanceof JournalError && error.code === 'MODEL_OUTPUT');
  });
  assert.throws(() => createOpenAiCompatibleProvider(model('http://127.0.0.1:1'), { env: {} }),
    (error: unknown) => error instanceof JournalError && error.code === 'MODEL_KEY_MISSING');
});
