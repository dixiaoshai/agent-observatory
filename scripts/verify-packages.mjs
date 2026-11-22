#!/usr/bin/env node
/** Verify only installed artifacts at runtime. Workspace reads end after staging. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFileSync, cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const cleanEnv = { ...process.env, PYTHONDONTWRITEBYTECODE: '1' };
for (const key of ['NODE_PATH', 'PYTHONPATH', 'PYTHONHOME']) delete cleanEnv[key];
const run = (exe, args, cwd, extra = {}) => execFileSync(exe, args, {
  cwd, encoding: 'utf8', env: { ...cleanEnv, ...extra }, maxBuffer: 8 * 1024 * 1024,
});
execFileSync(process.execPath, [path.join(root, 'scripts/pack-modules.mjs')], { cwd: root, stdio: 'inherit' });
const temporary = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'agent-observatory-packages-')));
const cache = path.join(root, '.cache/npm');
const results = {};
try {
  const staged = path.join(temporary, 'artifacts');
  mkdirSync(staged);
  const artifacts = new Map();
  for (const name of ['agent-trace', 'agent-journal', 'agent-knowledge']) {
    const version = JSON.parse(readFileSync(path.join(root, 'packages', name, 'package.json'), 'utf8')).version;
    const filename = `${name}-${version}.tgz`;
    const destination = path.join(staged, filename);
    copyFileSync(path.join(root, 'artifacts', filename), destination);
    artifacts.set(name, destination);
  }
  const statsVersion = readFileSync(path.join(root, 'packages/agent-stats/setup.cfg'), 'utf8').match(/^version\s*=\s*(\S+)\s*$/m)?.[1];
  assert(statsVersion);
  const wheel = path.join(staged, `agent_stats-${statsVersion}-py3-none-any.whl`);
  copyFileSync(path.join(root, 'artifacts', path.basename(wheel)), wheel);
  // From here onward: artifacts, installed package files, and writable temp data
  // only. Never read examples, fixtures, executable code or config from root.
  for (const name of ['agent-trace', 'agent-journal', 'agent-knowledge']) {
    const dir = path.join(temporary, name);
    mkdirSync(dir);
    const artifact = artifacts.get(name);
    const listing = run('tar', ['-tzf', artifact], dir).trim().split('\n');
    assert(listing.includes('package/dist/index.js'));
    assert(listing.includes('package/dist/index.d.ts'));
    assert(!listing.some(p => /(?:^|\/)(?:node_modules|\.git|\.agent-journal|\.knowrelay)(?:\/|$)|\.(?:sqlite3?|pem|key)$/.test(p)));
    // Cache-first so repeated runs are fast, but allow registry fallback: `npm ci`
    // caches tarballs, not the packuments needed to resolve a tarball's deps.
    run('npm', ['install', artifact, '--ignore-scripts', '--prefer-offline', '--no-audit', '--no-fund', '--package-lock=false', '--cache', cache], dir);
    const installed = path.join(dir, 'node_modules', name);
    const manifest = JSON.parse(readFileSync(path.join(installed, 'package.json'), 'utf8'));
    for (const other of ['agent-trace', 'agent-journal', 'agent-knowledge']) {
      if (other !== name) assert(!existsSync(path.join(dir, 'node_modules', other)), `${name} installed sibling ${other}`);
    }
    const api = run(process.execPath, ['--input-type=module', '-e', `import * as api from '${name}'; if (!Object.keys(api).length) throw Error('empty API'); console.log(Object.keys(api).join(','));`], dir).trim();
    const cli = path.join(installed, manifest.bin[name]);
    assert.match(run(process.execPath, [cli, 'help'], dir), /Usage:/);
    const user = path.join(dir, 'user-data');
    mkdirSync(user);
    if (name === 'agent-trace') {
      const demo = path.join(installed, 'fixtures/codex/demo.jsonl');
      assert(existsSync(demo));
      const db = path.join(user, 'trace.sqlite');
      run(process.execPath, [cli, 'ingest', '--source', demo, '--instance', 'distribution-test', '--project', 'demo', '--db', db], user);
      assert(JSON.parse(run(process.execPath, [cli, 'status', '--db', db], user)).events > 0);
    }
    if (name === 'agent-journal') {
      const config = JSON.parse(readFileSync(path.join(installed, 'examples/custom-config.json'), 'utf8'));
      config.database = './journal.sqlite';
      config.output_directory = './daily';
      writeFileSync(path.join(user, 'config.json'), JSON.stringify(config));
      copyFileSync(path.join(installed, 'examples/custom-activity.json'), path.join(user, 'activity.json'));
      const offlineEnv = { [config.token_env]: '' };
      const imported = JSON.parse(run(process.execPath, [cli, 'import', '--config', 'config.json', '--file', 'activity.json'], user, offlineEnv));
      assert(imported.imported > 0);
      const report = JSON.parse(run(process.execPath, [cli, 'dream', '--config', 'config.json', '--date', '2026-01-01', '--no-sync', '--no-model'], user, offlineEnv));
      assert(report.events > 0);
      assert(existsSync(path.join(user, 'daily/2026-01-01.md')));
    }
    if (name === 'agent-knowledge') {
      // Run the exact example shipped in the tarball, without import rewriting.
      assert.match(run(process.execPath, [path.join(installed, 'examples/memory-scanner.mjs')], user), /blueheron/);
      copyFileSync(path.join(installed, 'agent-knowledge.example.json'), path.join(user, 'knowledge.json'));
      cpSync(path.join(installed, 'fixtures'), path.join(user, 'fixtures'), { recursive: true });
      run(process.execPath, [cli, 'sync', '--source', 'demo', '--config', 'knowledge.json'], user);
      const search = JSON.parse(run(process.execPath, [cli, 'search', '--query', '缓存', '--project', 'demo', '--config', 'knowledge.json'], user));
      assert(search.results.length > 0);
    }
    results[name] = { installed_alone: true, artifact_examples_only: true, api, cli_help: true };
  }
  const dir = path.join(temporary, 'agent-stats');
  mkdirSync(dir);
  const site = path.join(dir, 'site');
  run('python3', ['-m', 'pip', 'install', '--no-cache-dir', '--no-deps', '--no-compile', '--target', site, wheel], dir);
  const env = { PYTHONPATH: site };
  // This CLI extracts the packaged resource. No workspace data is read.
  const consoleEntry = path.join(site, 'bin/agent-stats');
  run('python3', [consoleEntry, 'example', '--output', 'custom.json'], dir, env);
  assert(!existsSync(path.join(dir, '.agent-stats')), 'example extraction must not open a database');
  const python = `import json, pathlib, re\nfrom agent_stats.core import Store\nfrom agent_stats.sources import import_document\nimport agent_stats\np=pathlib.Path(agent_stats.__file__).resolve().parent\nassert p.is_relative_to(pathlib.Path(${JSON.stringify(site)}))\nhtml=(p/'static/index.html').read_text()\nfor asset in re.findall(r'(?:src|href)="([^\"]+\\.(?:js|css))"',html):\n assert (p/'static'/asset.lstrip('/')).is_file(), asset\ndoc=json.loads(pathlib.Path('custom.json').read_text())\ns=Store('custom.sqlite')\nassert import_document(s,doc)['imported']==1\nassert import_document(s,doc)['skipped']==1\nassert s.query()['summary']['token_total']==150\nassert s.detail(s.query()['sessions'][0]['id'])['turns'][0]['evidence']==[]\ns.db.close()\nprint('standalone-stats-ok')`;
  assert.match(run('python3', ['-c', python], dir, env), /standalone-stats-ok/);
  assert.match(run('python3', [consoleEntry, '--help'], dir, env), /usage:/i);
  results['agent-stats'] = { installed_alone: true, packaged_example_cli: true, custom_import: true, static_assets: true };

  // Exercise the opt-in bridge only after both independent-install assertions.
  // Both the executable and Python modules are the isolated installed artifacts;
  // the source, config and databases below exist only in this temporary directory.
  const knowledgeBin = path.join(temporary, 'agent-knowledge/node_modules/.bin/agent-knowledge');
  assert(existsSync(knowledgeBin), 'installed Knowledge executable missing');
  const integration = `
import hashlib, json, pathlib, subprocess, sys, threading
from urllib.error import HTTPError
from urllib.request import Request, urlopen
from agent_stats.knowledge import KnowledgeReader
from agent_stats.server import make_server

root = pathlib.Path.cwd()
binpath = pathlib.Path(sys.argv[1])
source = root / 'synthetic-knowledge'
source.mkdir()
file = source / 'note.md'
original = '# Packaged integration\\nSynthetic cobalt narwhal evidence.\\n'
file.write_text(original, encoding='utf-8')
config = root / 'synthetic-knowledge.json'
config.write_text(json.dumps({
    'schema_version': 1, 'database': 'synthetic-knowledge.sqlite',
    'allowed_project_ids': ['package-demo'],
    'sources': [{'id': 'package-source', 'root': str(source), 'project_id': 'package-demo'}],
}), encoding='utf-8')
def sync():
    subprocess.run([str(binpath), 'sync', '--source=package-source', '--config=' + str(config)],
                   check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=20)
sync()
server = make_server(None, [], 0, archive_only=True, knowledge_reader=KnowledgeReader(config, binpath))
thread = threading.Thread(target=server.serve_forever, daemon=True)
thread.start()
try:
    base = 'http://127.0.0.1:%s' % server.server_port
    def post(operation, payload):
        request = Request(base + '/api/knowledge/' + operation,
                          data=json.dumps(payload).encode(), headers={'Content-Type': 'application/json'})
        try:
            response = urlopen(request, timeout=15)
        except HTTPError as exc:
            response = exc
        with response:
            return response.status, json.load(response)
    def search():
        status, body = post('search', {'query': 'cobalt narwhal', 'project': 'package-demo'})
        assert status == 200, (status, body)
        return body['results']
    results = search()
    assert len(results) == 1, results
    hit = results[0]
    assert (hit['project_id'], hit['source_id'], hit['path'], hit['start_line'], hit['end_line'], hit['content']) == (
        'package-demo', 'package-source', 'note.md', 1, 2, original), hit
    assert 'owner_id' not in hit and 'content_hash' not in hit, hit
    identity = hit['id']
    status, body = post('read', {'id': identity, 'project': 'package-demo'})
    assert status == 200, (status, body)
    record = body['record']
    for key, value in hit.items():
        assert record[key] == value, (key, record, hit)
    assert record['content_hash'] == hashlib.sha256(original.encode()).hexdigest(), record
    assert record['source_version_id'] and record['git_commit'] is None, record
    assert 'owner_id' not in record, record
    assert post('read', {'id': identity, 'project': 'outside-scope'})[0] == 403
    assert post('search', {'query': 'cobalt narwhal', 'project': 'outside-scope'})[0] == 403
    file.write_text('Synthetic cobalt narwhal changed.\\n', encoding='utf-8')
    assert post('read', {'id': identity, 'project': 'package-demo'})[0] == 404
    assert search() == []
    sync()
    changed = search()
    assert len(changed) == 1, changed
    new_id = changed[0]['id']
    file.unlink()
    assert post('read', {'id': new_id, 'project': 'package-demo'})[0] == 404
    assert search() == []
    print('installed-knowledge-bridge-ok')
finally:
    server.shutdown()
    thread.join(timeout=5)
    server.server_close()
    assert not thread.is_alive(), 'temporary HTTP server did not stop'
`;
  assert.match(run('python3', ['-c', integration, knowledgeBin], dir, env), /installed-knowledge-bridge-ok/);
  results['agent-stats'].knowledge_bridge = { packaged_cli: true, verified_source: true, stale_and_scope: true };
  console.log(JSON.stringify({ passed: true, source_tree_inputs_after_staging: false, modules: results }, null, 2));
} finally {
  const resolved = realpathSync(temporary);
  assert.equal(resolved, temporary);
  assert.equal(path.dirname(resolved), realpathSync(os.tmpdir()));
  assert(path.basename(resolved).startsWith('agent-observatory-packages-'));
  rmSync(resolved, { recursive: true, force: true });
}
