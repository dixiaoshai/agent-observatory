import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { rankDocuments, tokenize } from '../src/retrieval/index.js';

test('tokenizes Chinese and common code identifiers', () => {
  const terms = tokenize('用户登录 revokeSession verify_password_hash HTTPServer get用户配置');
  for (const term of ['用户', '户登', '登录', 'revokesession', 'revoke', 'session',
    'verify_password_hash', 'verify', 'password', 'hash', 'http', 'server', 'get', '配置']) {
    assert.ok(terms.includes(term), `missing ${term}`);
  }
});

test('finds the labeled sources for Chinese and code questions', async () => {
  const root = path.resolve('fixtures');
  const documents = [];
  for (const directory of ['knowledge', 'code']) {
    for (const file of await readdir(path.join(root, directory))) {
      const name = `${directory}/${file}`;
      documents.push({ id: name, path: name, content: await readFile(path.join(root, name), 'utf8') });
    }
  }
  const questions = JSON.parse(await readFile(path.join(root, 'questions.json'), 'utf8')) as Array<{query: string; path: string}>;
  let hits = 0;
  for (const { query, path: expected } of questions) {
    const results = rankDocuments(query, documents, 5);
    if (results.some((result) => result.id === expected)) hits++;
    else console.log(`miss: ${query} expected ${expected}`);
  }
  assert.equal(questions.length, 10);
  assert.ok(hits >= 8, `${hits}/10 sources were found in the top five`);
  assert.deepEqual(rankDocuments('量子猫跃迁振荡器', documents, 5), []);
});

test('filters empty queries and validates bounds; ties are deterministic', () => {
  const documents = [
    { id: 'b', path: 'b.txt', content: 'distinctive' },
    { id: 'a', path: 'a.txt', content: 'distinctive' },
  ];
  assert.deepEqual(rankDocuments('  ', documents, 5), []);
  assert.deepEqual(rankDocuments('the', documents, 5), []);
  assert.deepEqual(rankDocuments('distinctive', documents, 5).map(({ id }) => id), ['a', 'b']);
  assert.throws(() => rankDocuments('x'.repeat(4097), documents, 5), RangeError);
  for (const limit of [0, -1, 1.5, 101, NaN]) {
    assert.throws(() => rankDocuments('x', documents, limit), RangeError);
  }
});
