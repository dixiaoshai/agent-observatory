# Custom session sources

Agent Stats can import your own normalized usage without Agent Trace or Codex.
Install the Python package, then run:

```sh
agent-stats example --output ./custom-source.json
agent-stats --db ./stats.sqlite3 import-json --input ./custom-source.json
agent-stats --db ./stats.sqlite3 summary
agent-stats --db ./stats.sqlite3 serve --archive-only --no-content
```

`example` exports the bundled synthetic JSON to a new file without opening a database; it refuses to overwrite an existing file. The source-tree copy in `docs/custom-source.example.json` is checked against the packaged resource by tests. `--archive-only` prevents the dashboard from
reading local Codex logs. The existing `import` and `import-archive` commands
remain Codex and Trace-specific respectively.

## JSON v1

The root object has exactly `version` (integer 1), `source` and `instance`
(nonempty strings), and `sessions` (array). Each session requires a nonempty
string `id` and a `turns` array; optional fields are `started_at`, `project`,
`title`, and `status`. Each turn requires a nonempty string `id`; optional
fields are `started_at`, `model`, `token_total`, `input_tokens`,
`cached_input_tokens`, `output_tokens`, and `tools` (array of tool names).
Optional fields may be null except `tools`. Timestamps must include a timezone.
Token counts are nonnegative integers (at most 2^53-1); cached input cannot
exceed input, and when all three are supplied total must equal input plus
output. Missing counts remain unknown, not zero. Unsupported fields are
rejected. Do not put prompts or secrets in these metadata fields: they are
stored in the database and exposed by the dashboard.

Identities are scoped by (`source`, `instance`, session `id`) and turn `id`
within the session. Choose stable IDs. Importing an identical snapshot skips
it; changed snapshots replace the complete session, and omitted sessions are
not deleted. Duplicate IDs in a batch are rejected. The entire batch validates
before writing and database failures roll back the batch. Custom identities are
separate from native Codex/Trace identities. Independent providers must choose
distinct source/instance namespaces. Imports assume usage is per-session, not
inherited from another session; adapt overlapping source usage before import.

## Python provider API

```python
from agent_stats.core import Store
from agent_stats.sources import NormalizedSession, import_source

class MyProvider:
    source = "my-agent"
    instance = "laptop"

    def sessions(self) -> list[NormalizedSession]:
        return [{"id": "s1", "turns": [{"id": "t1", "token_total": 42}]}]

store = Store("./stats.sqlite3")
report = import_source(store, MyProvider())
print(report, store.query()["summary"])
```

`SourceProvider` is a structural typed protocol; `NormalizedSession` and
`NormalizedTurn` describe input records. Alternatively call
`import_sessions(store, source, instance, sessions)` with an iterable, or
`import_document(store, document)` with the JSON object. All use the same
validation and return `scanned`, `imported`, and `skipped`. Invalid data raises
`ValueError`; provider iteration errors propagate before any import writes.
The caller owns the Store connection and transaction. Savepoint behavior joins
an existing transaction, so its caller must commit or roll it back.
