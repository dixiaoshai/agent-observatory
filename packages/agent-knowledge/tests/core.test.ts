import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chunkText } from '../src/core/index.js';

test('chunk references preserve CRLF, blank lines and every source line across overlaps', () => {
  const lines = Array.from({ length: 135 }, (_, index) => index % 7 ? `第${index + 1}行\r\n` : '\r\n');
  lines[134] = '末行没有换行';
  const content = lines.join('');
  const chunks = chunkText(content);
  assert.ok(chunks.length > 1);
  const covered = new Set<number>();
  for (const chunk of chunks) {
    assert.equal(chunk.content, lines.slice(chunk.start_line - 1, chunk.end_line).join(''));
    assert.ok(chunk.end_line - chunk.start_line < 60);
    for (let line = chunk.start_line; line <= chunk.end_line; line++) covered.add(line);
  }
  assert.equal(covered.size, 135);
  assert.deepEqual(chunkText(''), []);
  assert.deepEqual(chunkText('\n'), [{ content: '\n', start_line: 1, end_line: 1 }]);
});
