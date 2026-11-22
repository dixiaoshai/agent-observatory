import test from 'node:test';
import assert from 'node:assert/strict';
import { pageFromHash, pageHref } from '../src/lib/pageRoute.ts';

test('each dashboard page has a distinct URL fragment that resolves back to it', () => {
  assert.deepEqual(pageHref, {
    overview: '#/overview',
    sessions: '#/sessions',
    source: '#/source',
  });
  for (const [page, href] of Object.entries(pageHref)) {
    assert.equal(pageFromHash(new URL(href, 'http://127.0.0.1:8765/').hash), page);
  }
});

test('an empty or unrecognized URL fragment defaults to overview', () => {
  for (const hash of ['', '#/', '#/missing', '#/sessions/extra', '#/source?x=1']) {
    assert.equal(pageFromHash(hash), 'overview');
  }
});
