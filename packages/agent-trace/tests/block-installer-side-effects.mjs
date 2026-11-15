// A real installer CLI regression must never reach child processes, writes, or network.
import childProcess from 'node:child_process';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
for (const method of ['spawnSync', 'execFileSync', 'execSync', 'spawn', 'execFile', 'exec', 'fork']) {
  childProcess[method] = () => { throw new Error(`Test blocked subprocess: ${method}`); };
}
for (const method of ['appendFileSync', 'chmodSync', 'mkdirSync', 'mkdtempSync', 'rmSync', 'writeFileSync', 'renameSync', 'unlinkSync']) {
  fs[method] = () => { throw new Error(`Test blocked filesystem mutation: ${method}`); };
}
globalThis.fetch = () => { throw new Error('Test blocked network access'); };
syncBuiltinESMExports();
