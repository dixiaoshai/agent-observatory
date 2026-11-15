// Preloaded into every installer CLI test process. A regression in a consent
// or dry-run guard must never invoke real launchctl, plutil, mv, or sleep.
import childProcess from 'node:child_process';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
childProcess.spawnSync = () => { throw new Error('Test blocked all installer subprocesses'); };
for (const method of ['appendFileSync', 'chmodSync', 'mkdirSync', 'mkdtempSync', 'rmSync', 'writeFileSync']) {
  fs[method] = () => { throw new Error(`Test blocked filesystem mutation: ${method}`); };
}
globalThis.fetch = () => { throw new Error('Test blocked network access'); };
syncBuiltinESMExports();
