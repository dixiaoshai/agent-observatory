import assert from 'node:assert/strict';

export function assertNodeTestsComplete(output, name) {
  const counts = [...output.matchAll(/(?:ℹ|#)\s+tests\s+(\d+)/g)];
  const skipped = [...output.matchAll(/(?:ℹ|#)\s+skipped\s+(\d+)/g)];
  assert(counts.some(match => Number(match[1]) > 0), `${name}: no executed Node tests`);
  assert(skipped.length > 0, `${name}: no Node skip summary`);
  assert(skipped.every(match => Number(match[1]) === 0), `${name}: skipped tests in isolated checkout`);
}

export function assertPythonTestsComplete(output, name) {
  const count = output.match(/\bRan (\d+) tests?\b/);
  assert(count && Number(count[1]) > 0, `${name}: no executed Python tests`);
  assert(/^OK(?:\s|$)/m.test(output), `${name}: missing successful Python summary`);
  const skipped = [...output.matchAll(/\bskipped=(\d+)\b/g)];
  assert(skipped.every(match => Number(match[1]) === 0), `${name}: skipped Python tests in isolated checkout`);
}
