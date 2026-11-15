import assert from 'node:assert/strict';
import test from 'node:test';
import { assertNodeTestsComplete, assertPythonTestsComplete } from '../test-summary.mjs';

test('Node source verification rejects skipped or empty suites', () => {
  assertNodeTestsComplete('# tests 5\n# skipped 0\n', 'node');
  assertNodeTestsComplete('ℹ tests 5\nℹ skipped 0\n', 'node');
  assert.throws(() => assertNodeTestsComplete('# tests 5\n# skipped 1\n', 'node'));
  assert.throws(() => assertNodeTestsComplete('# tests 0\n# skipped 0\n', 'node'));
  assert.throws(() => assertNodeTestsComplete('npm success', 'node'));
});

test('Python source verification inspects stderr summary and rejects skips', () => {
  assertPythonTestsComplete('Ran 5 tests in 0.1s\n\nOK\n', 'python');
  assert.throws(() => assertPythonTestsComplete('Ran 5 tests in 0.1s\n\nOK (skipped=1)\n', 'python'));
  assert.throws(() => assertPythonTestsComplete('Ran 0 tests in 0.1s\n\nOK\n', 'python'));
  assert.throws(() => assertPythonTestsComplete('Ran 5 tests in 0.1s\n\nFAILED\n', 'python'));
});
