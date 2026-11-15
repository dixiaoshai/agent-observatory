# Offline activity sources

## Try the bundled synthetic example safely

The npm package includes `examples/custom-config.json` and `examples/custom-activity.json`. First copy **both** files from the installed package's `examples/` into a user-writable directory (the following assumes a local npm installation):

```sh
mkdir -p ./journal-demo
cp ./node_modules/agent-journal/examples/custom-{config,activity}.json ./journal-demo/
./node_modules/.bin/agent-journal import --config ./journal-demo/custom-config.json --file ./journal-demo/custom-activity.json
./node_modules/.bin/agent-journal dream --config ./journal-demo/custom-config.json --date 2026-01-01 --no-sync --no-model
```

The configuration resolves paths relative to its own directory, so output is written under `journal-demo/.agent-journal/`, **not** into `node_modules`. In a source checkout, copy the same two files from the module's `examples/` directory and use its built `dist/cli.js` in place of the installed binary. This imports local JSON and renders a deterministic daily note without a Trace process, token, network, or model. The existing configuration still requires syntactically valid `trace_url` and `token_env` fields even offline; their values are not used for import. Include `demo` in configured projects to use this example.

Only the source checkout contains `scripts/install-macos-service.ts`; it is not part of the npm distribution. Its install and uninstall operations require explicit `--apply` after reviewing `--dry-run`; they are never needed for the offline example.

The JSON object has a stable, nonempty `source` identity and an `activities` array. Each activity has a unique stable `id`, configured `project`, `session`, UTC `at` timestamp with milliseconds (e.g. `2026-01-01T10:00:00.000Z`), `kind` (`user`, `assistant`, or `final`), and nonempty `text`. Session IDs must not span projects. All fields are required; unknown fields are rejected. Text is capped at 100,000 characters and the existing journal compaction truncates stored text to 8,000 characters. Timestamps serve as both occurrence and observation times.

Supply the **complete append-only snapshot** every time. Preserve all prior entries exactly and in the same order, including IDs; append new entries at the end. Replaying unchanged entries is a no-op; duplicates, modified/reordered entries, shorter snapshots, and different source identities are rejected. Imports commit one entry at a time, so a failed import can leave a committed prefix; rerun the same snapshot to resume. One database binds to one custom source or one Trace archive, never both. Use a separate database for each source and do not reuse an identity for a different dataset. Deletion markers and richer tool/usage events are not supported by this minimal format.

Programmatic consumers can call `parseActivitySnapshot` and `importActivitySnapshot` from the package entry point. `SyncOptions.client` is a structural Trace protocol client, intended for Trace-compatible transports; custom activities do not need that HTTP envelope.
