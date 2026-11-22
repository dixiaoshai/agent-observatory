import test from 'node:test';
import assert from 'node:assert/strict';
import { getKnowledgeStatus, readKnowledge, searchKnowledge } from '../src/lib/api.ts';

test('Knowledge requests use the status and search contract', async (t) => {
  const original = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  const calls = [];
  globalThis.fetch = async (...args) => {
    calls.push(args);
    return new Response(JSON.stringify(calls.length === 1 ? { enabled: true } : { results: [] }));
  };
  const controller = new AbortController();
  assert.deepEqual(await getKnowledgeStatus(controller.signal), { enabled: true });
  assert.deepEqual(await searchKnowledge('hello', undefined, controller.signal), { results: [] });
  await searchKnowledge('hello', 'project', controller.signal);
  assert.equal(calls[0][0], '/api/knowledge/status');
  assert.equal(calls[0][1].signal, controller.signal);
  assert.equal(calls[1][0], '/api/knowledge/search');
  assert.equal(calls[1][1].method, 'POST');
  assert.deepEqual(JSON.parse(calls[1][1].body), { query: 'hello' });
  assert.deepEqual(JSON.parse(calls[2][1].body), { query: 'hello', project: 'project' });
});

test('Knowledge read sends the record and project with abort support', async (t) => {
  const original = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  const record = {
    id: 'record', project_id: 'project', source_id: 'docs', path: 'doc.md',
    start_line: 1, end_line: 2, content: 'literal', source_version_id: 'version',
    content_hash: 'hash', git_commit: null,
  };
  const controller = new AbortController();
  let call;
  globalThis.fetch = async (...args) => {
    call = args;
    return new Response(JSON.stringify({ record }));
  };
  assert.deepEqual(await readKnowledge('record', 'project', controller.signal), { record });
  assert.equal(call[0], '/api/knowledge/read');
  assert.equal(call[1].method, 'POST');
  assert.equal(call[1].signal, controller.signal);
  assert.deepEqual(JSON.parse(call[1].body), { id: 'record', project: 'project' });
});

test('Knowledge errors expose generic backend JSON errors', async (t) => {
  const original = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ error: 'unavailable' }), { status: 503 });
  await assert.rejects(searchKnowledge('hello'), /unavailable/);
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ error: '来源已失效或删除，请重新搜索' }), { status: 404 });
  await assert.rejects(readKnowledge('record', 'project'), /来源已失效或删除，请重新搜索/);
});
