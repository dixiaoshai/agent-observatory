# Standalone sources and adapters

Local document indexing does not require Trace. Configure source directories and run `sync`, `search`, and `read` as described in [running.md](running.md#同步读取和删除). The default CLI uses the built-in filesystem scanner. Paths in configuration are resolved relative to the config file, and source projects must be allowed. The scanner checks roots, avoids symlinks, and applies sensitive-name, ignore, extension and size rules; see the running guide for details.

## Programmatic scanner

The package entry exports `openApplication(configPath, { scanner })`, `AgentKnowledge`, its application configuration and storage/scanner ports, `scanSource`, `SqliteStore`, core types and `contentHash`. The optional scanner defaults to `scanSource`, preserving existing callers.

### Installed package (no source checkout)

After installing the package in a writable project, run the included synthetic example directly. It uses the package's already-built JavaScript and creates and removes its own temporary database:

```sh
node node_modules/agent-knowledge/examples/memory-scanner.mjs
```

For the included filesystem demo, copy the configuration **and** synthetic documents into your own writable directory. The database and source root resolve relative to that copied config; never point writable state into `node_modules`:

```sh
mkdir -p ./knowledge-demo
cp node_modules/agent-knowledge/agent-knowledge.example.json ./knowledge-demo/config.json
cp -R node_modules/agent-knowledge/fixtures ./knowledge-demo/fixtures
./node_modules/.bin/agent-knowledge sync --source demo --config ./knowledge-demo/config.json
./node_modules/.bin/agent-knowledge search --query "刷新令牌" --project demo --config ./knowledge-demo/config.json
```

To use your own documents, edit the copied config's `sources[].root`, `project_id`, and `allowed_project_ids`; the root is relative to the config and must already exist. Copying the config alone without the fixture folder requires changing its root first.

### Source checkout

From this package's source directory, install the development dependencies and build before running the same example:

```sh
npm ci
npm run build
node examples/memory-scanner.mjs
```

Source tests use module-local synthetic archive pages; full Trace producer-to-Knowledge integration is separately covered by the monorepo's `verify:consumers` / `verify:follow` commands.

It uses no Trace service or archive envelope. A `SourceScanner` receives a configured `SourceDefinition` and returns a complete snapshot: `files` with source-relative `path`, UTF-8 `content`, SHA-256 `content_hash`, and `git_commit` (or `null`), plus `skipped` entries. Use stable unique paths and hashes matching the content. Missing files are treated as deleted on sync; scan failures should throw rather than return incomplete snapshots. Search and read rescan for freshness, so the scanner must return current snapshots consistently. Use a new request key for each new sync; replaying a key returns the original result.

A custom scanner is **trusted application code**, not a sandbox: it is responsible for its own input authorization and filesystem safety. The built-in scanner's root, symlink, ignore and sensitive-file checks are not automatically applied to custom scanners. A filesystem adapter must enforce the configured source root and equivalent security rules itself; this API does not grant permission to read arbitrary paths. Application source/project/owner checks and existing source binding checks still apply. Configuration and the local database are within the local user's trust boundary, not multi-user authentication.

`FollowSource` only abstracts transport for the existing Trace v1 content follow protocol; it does not make follow a generic source protocol. The standalone scanner interface is separate from follow.
