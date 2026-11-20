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

## Observed usage, costs and coverage in query results

The custom JSON v1 input above is unchanged: it accepts turn/session facts, not
request records or recorded costs. Native Codex cumulative snapshots retain
source-aware delta, replay, reset and fork-baseline handling. Neither input
proves a complete inventory of API requests.

Trace pi/dsh inputs preserve per-call field presence in `usage_records` (event ID,
source reference, record identity, timestamp, model, sparse `usage`, recorded cost
and its basis). These IDs identify source observations, not provider request IDs.
The adapter's synthetic `cumulative` values cannot recover missing fields.
A settled assistant record with no usage produces an empty observation; explicit
zero remains zero. Compaction usage is a separate observation, not an inferred
assistant request. Duplicate archive pages do not add the same fact twice.

- `token_total` and each token category are complete **over observed records**
  only when every relevant observation supplies that field. `token_known` and
  `usage_known` retain known subtotals even inside a partial turn. Missing fields
  stay null, including when a later request reports a value or explicit zero.
- `recorded_cost_usd` is complete only over attributable observed records with
  costs on every record; `recorded_cost_known_usd` is their known subtotal.
  If any recorded cost exists, `estimated_cost` / `estimated_cost_known` retain
  that recorded basis: missing charges are never filled using today's rate table.
  `api_estimated_cost` / `api_estimated_cost_known` separately expose the current
  API-equivalent estimate. If no recorded costs exist, the legacy `estimated_cost`
  fields use this estimate. `provider` and harness `model_rates` remain distinct
  provenance; neither is promised to be a complete account bill.
- `request_coverage` on turns with observations, sessions, summaries, model/date
  groups and detail sessions has `scope=observed_usage_records`, counts observed
  records with/without usage/cost and per-field presence. `total_requests`,
  `usage_ratio` and `cost_ratio` are **null** for all current inputs. Do not use
  assistant-message counts, token snapshots or `cost_samples / turns` as request
  coverage. `unresolved_turns` includes missing or quarantined observations;
  `attribution_uncertain_turns` flags possibly overlapping fork observations.
- Unknown fork timing prevents complete costs and blocks deduplicated aggregation;
  only labelled observed subtotals remain. The dashboard distinguishes these
  from known attributable totals, and always labels actual request coverage unknown.

### Existing archives and upgrades

The pi/dsh usage metadata is a v1 field extension, **not** compatible with old
strict consumers. Upgrade Stats, Journal and Knowledge before producing it;
old consumers reject the page without advancing their cursors. Invalid metadata
still rolls back the complete page and cursor.

New Stats accepts old v1 events, but old/mixed pi/dsh records lacking the new
metadata (or a settled assistant without its matching new snapshot) are
quarantined: their complete totals and API estimates stay unknown, with only
available observed subtotals retained. Reading an old Stats projection applies
the same restriction without rewriting the stored database. Lost field presence
cannot be recovered from old synthetic counters.

For historical recovery, explicitly create **a new Trace archive and new consumer
databases** from authorized sources. Simply importing the same source again does
not upgrade old normalized rows: Trace's unchanged `record_hash` fast path skips
them. No automatic migration, source rebinding, production recollection or change
feed revision fix is performed by this feature. See the
[Trace usage contract](../../agent-trace/docs/protocol.md#normalized-kinds-and-allowlisted-data).

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
