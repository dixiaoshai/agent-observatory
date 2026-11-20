"""Consume versioned, metadata-only archive exports without opening source logs."""
import hashlib
import json
import math
import sqlite3
from datetime import datetime, timezone

from .codex import FIELDS, summarize_events, timestamp, usage_total
from .usage import quarantine_request_totals

_COMMON = {'turn_id', 'root_turn_id', 'model'}
_FIELDS = {
    'session.started': {'cwd', 'parent_session_id', 'forked_from_session_id', 'created_at', 'cli_version', 'title'},
    'session.auth': {'account_scoped'},
    'session.title': {'title'},
    'turn.context': set(), 'turn.started': set(), 'turn.completed': set(), 'turn.interrupted': set(),
    'message.user': {'title'}, 'message.assistant': set(), 'reasoning.summary': {'available'},
    'tool.called': {'call_id', 'name', 'input_bytes'},
    'tool.returned': {'call_id', 'output_bytes', 'status'},
    'usage.snapshot': {'cumulative', 'last_usage', 'rate_limit_only', 'cost_usd', 'cost_source',
                       'usage_basis', 'request_id', 'request_id_source'},
    'context.compacted': set(), 'source.unknown': set(), 'session.deleted': set(),
}
_ENVELOPE = {'schema_version', 'event_id', 'archive_seq', 'runtime', 'instance_id', 'session_id',
             'session_key', 'project_id', 'kind', 'occurred_at', 'observed_at', 'native_type',
             'source', 'data', 'body', 'raw'}
_HEX = set('0123456789abcdef')
_RUNTIMES = {'codex', 'pi', 'dsh'}
_COST_SOURCES = {'provider', 'model_rates'}
# ECMAScript WhiteSpace + LineTerminator, matching the producer's String.trim().
# Python's default strip() additionally removes U+0085 but omits U+FEFF.
_JS_WHITESPACE = ('\t\n\v\f\r \u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005'
                  '\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff')


def _canonical(value):
    return json.dumps(value, ensure_ascii=False, separators=(',', ':'), sort_keys=True)


def _digest(value):
    return hashlib.sha256(_canonical(value).encode()).hexdigest()


def _id(value):
    return isinstance(value, str) and len(value) == 64 and all(c in _HEX for c in value)


def _integer(value):
    return type(value) is int and 0 <= value <= 9007199254740991


def _project_scope(allowed_project_ids):
    """Normalize the optional consumption scope; ``None`` means the full archive."""
    if allowed_project_ids is None:
        return None
    if isinstance(allowed_project_ids, str) or not isinstance(allowed_project_ids, (list, tuple, set, frozenset)):
        raise ValueError('allowed_project_ids must be a collection of project ids')
    scope = set()
    for project_id in allowed_project_ids:
        if not isinstance(project_id, str) or not project_id:
            raise ValueError('allowed_project_ids must contain non-empty project ids')
        scope.add(project_id)
    if not scope:
        raise ValueError('allowed_project_ids must not be empty')
    return scope


def _validate_event(event, after, end):
    if not isinstance(event, dict) or set(event) != _ENVELOPE or event['schema_version'] != 1:
        raise ValueError('invalid archive event envelope')
    if event['body'] is not None or event['raw'] is not None:
        raise ValueError('metadata events must not contain body or raw content')
    if not _id(event['event_id']) or not _integer(event['archive_seq']) or not after < event['archive_seq'] <= end:
        raise ValueError('invalid event identity or sequence')
    for key in ('runtime', 'instance_id', 'session_id', 'project_id', 'kind', 'native_type'):
        if not isinstance(event[key], str) or not event[key] or len(event[key]) > 1000:
            raise ValueError('invalid archive event field: ' + key)
    key = json.dumps([event['runtime'], event['instance_id'], event['session_id']], ensure_ascii=False, separators=(',', ':'))
    if event['session_key'] != key:
        raise ValueError('invalid session key')
    source = event['source']
    if event['kind'] == 'session.deleted':
        if source is not None or event['data'] != {}:
            raise ValueError('deletion source must be null and metadata must be empty')
    elif (not isinstance(source, dict) or set(source) - {'series'} != {'path', 'line', 'record_hash'}
          or not isinstance(source['path'], str) or not _integer(source['line']) or source['line'] < 1
          or not _id(source['record_hash'])):
        raise ValueError('invalid source reference')
    if event['kind'] == 'session.auth' and event['runtime'] != 'codex':
        raise ValueError('session.auth is codex-only')
    # Rollouts folded into a shared session carry their own first identity so
    # two files do not collide on (session, line). The field is optional and is
    # part of the identifier only when present.
    series = source.get('series') if isinstance(source, dict) and event['kind'] != 'session.deleted' else None
    if series is not None and (not isinstance(series, str) or not series or len(series) > 1000
                               or series == event['session_id']):
        raise ValueError('invalid source series')
    if event['runtime'] == 'codex':
        native_identity = [event['runtime'], event['instance_id'], event['session_id']]
        if series is not None:
            native_identity.append(series)
        if event['kind'] == 'session.deleted':
            native_identity.append('deleted')
        elif event['kind'] == 'session.auth':
            # session.auth shares the session_meta source line with
            # session.started, so its discriminator follows the line.
            native_identity.extend([source['line'], 'session.auth'])
        else:
            native_identity.append(source['line'])
        native_json = json.dumps(native_identity, ensure_ascii=False, separators=(',', ':'))
        if hashlib.sha256(native_json.encode('utf-8')).hexdigest() != event['event_id']:
            raise ValueError('invalid Codex event ID')
    for name in ('occurred_at', 'observed_at'):
        if event[name] is not None and timestamp(event[name]) is None:
            raise ValueError('invalid timestamp')
    if event['observed_at'] is None:
        raise ValueError('observation timestamp is required')
    data = event['data']
    allowed = _COMMON | _FIELDS.get(event['kind'], set())
    if not isinstance(data, dict) or set(data) - allowed:
        raise ValueError('unsupported metadata fields')
    request_fields = {'usage_basis', 'request_id', 'request_id_source'}
    if request_fields & set(data):
        if not request_fields <= set(data) or data['usage_basis'] != 'request':
            raise ValueError('invalid request usage metadata')
        identity_source = data['request_id_source']
        allowed_sources = {'pi': {'pi_entry', 'source_record'}, 'dsh': {'dsh_record'}}
        if not isinstance(identity_source, str) or identity_source not in allowed_sources.get(event['runtime'], set()):
            raise ValueError('invalid request identity source')
        request_id = data['request_id']
        if request_id is None:
            if identity_source != 'source_record':
                raise ValueError('missing request record identity')
        elif (not isinstance(request_id, str) or not request_id or request_id.strip(_JS_WHITESPACE) != request_id
              or len(request_id.encode('utf-16-le', errors='surrogatepass')) > 8192
              or any(ord(c) < 32 or ord(c) == 127 for c in request_id)):
            raise ValueError('invalid request record identity')
    for name, value in data.items():
        if name in ('cumulative', 'last_usage'):
            if not isinstance(value, dict) or set(value) - set(FIELDS) or any(not _integer(v) for v in value.values()):
                raise ValueError('invalid usage')
        elif name in ('input_bytes', 'output_bytes'):
            if value is not None and not _integer(value):
                raise ValueError('invalid byte count')
        elif name == 'cost_usd':
            if (value is not None and (type(value) not in (int, float) or not math.isfinite(value) or value < 0)):
                raise ValueError('invalid cost')
        elif name == 'cost_source':
            if value is not None and value not in _COST_SOURCES:
                raise ValueError('invalid cost source')
        elif name in ('available', 'rate_limit_only'):
            if value is not None and type(value) is not bool:
                raise ValueError('invalid boolean')
        elif name == 'account_scoped':
            # The producer only emits this event for a verified account scope;
            # a false or non-boolean flag is not a valid "unknown" encoding.
            if value is not True:
                raise ValueError('invalid account scope flag')
        elif value is not None and (not isinstance(value, str) or len(value) > (80 if name == 'title' else 4096)):
            raise ValueError('invalid metadata value: ' + name)
    if event['kind'] == 'session.auth' and data.get('account_scoped') is not True:
        raise ValueError('session.auth requires account scope evidence')
    if isinstance(data.get('title'), str) and ('\n' in data['title'] or '\r' in data['title']):
        raise ValueError('title must be one line')
    if event['kind'] == 'tool.returned' and data.get('status') not in (None, 'result_observed'):
        raise ValueError('invalid tool status')
    return key


def _observation(event):
    kind, data = event['kind'], event['data']
    clean = {name: data.get(name) for name in _COMMON}
    mapping = {
        'session.title': ('session/title', None),
        'turn.context': ('turn_context', None), 'turn.started': ('event_msg', 'task_started'),
        'turn.completed': ('event_msg', 'task_complete'), 'turn.interrupted': ('event_msg', 'turn_aborted'),
        'usage.snapshot': ('event_msg', 'token_count'), 'message.user': ('event_msg', 'user_message'),
        'tool.called': ('response_item', 'function_call'), 'tool.returned': ('response_item', 'function_call_output'),
        'reasoning.summary': ('response_item', 'reasoning'),
        'message.assistant': ('response_item', 'message'),
    }
    native, subtype = mapping.get(kind, ('archive_unknown', None))
    clean['type'] = subtype
    if kind == 'message.user':
        clean['prompt_title'] = data.get('title')
    if kind == 'message.assistant':
        clean['assistant_message'] = True
    if kind in ('tool.called', 'tool.returned'):
        clean.update({name: data.get(name) for name in ('call_id', 'name', 'input_bytes', 'output_bytes')})
    if kind == 'usage.snapshot':
        clean.update(cumulative=usage_total(data.get('cumulative')), last_usage=usage_total(data.get('last_usage')),
                     rate_limit_only=data.get('rate_limit_only', False),
                     cost_usd=data.get('cost_usd'), cost_source=data.get('cost_source'),
                     usage_basis=data.get('usage_basis'), request_id=data.get('request_id'),
                     request_id_source=data.get('request_id_source'),
                     event_id=event['event_id'], source=dict(event['source']))
    return (timestamp(event['occurred_at']), event['source']['line'], native, clean)


def _source_group(event):
    """One source rollout: its folded-file series when present, else its path."""
    source = event.get('source') or {}
    return source.get('series') or source.get('path') or ''


def _rollout_result(events):
    """Summarize one rollout file the way the direct reader does.

    Several rollouts can belong to one session identity (resumed or subagent
    logs). Direct imports keep the highest ``(revision_at, event_count)`` file
    instead of merging their cumulative snapshots, so the archive projection
    must make the same choice. Returns ``(rank, result)`` or ``None``.
    """
    start = next((e for e in events if e['kind'] == 'session.started'), None)
    if not start:
        return None
    data = start['data']
    meta = {'id': start['session_id'], 'cwd': data.get('cwd'), 'timestamp': data.get('created_at'),
            'parent_id': data.get('parent_session_id'), 'forked_from_id': data.get('forked_from_session_id'),
            'cli_version': data.get('cli_version'), 'recorded_at': timestamp(start['occurred_at'])}
    observations = [_observation(e) for e in events if e['kind'] not in ('session.deleted', 'session.auth')]
    result, _ = summarize_events(observations, meta, instance=start['instance_id'], runtime=start['runtime'])
    if not result:
        return None
    # The account-scope signal belongs to the rollout file it was recorded in.
    # Only the winning rollout proves it for the session; absence stays unknown.
    if any(e['kind'] == 'session.auth' and e['data'].get('account_scoped') is True for e in events):
        result['account_scoped'] = True
    if start['runtime'] in ('pi', 'dsh'):
        # Old producers dropped wholly missing usage and zero-filled cache
        # components. Absence of the new metadata cannot be repaired by reading
        # synthetic cumulative counters. Also quarantine a mixed old/new file.
        snapshots = [e for e in events if e['kind'] == 'usage.snapshot']
        paired = {(e['source']['line'], e['source']['record_hash']) for e in snapshots
                  if e['data'].get('usage_basis') == 'request'}
        incomplete = (any(e['data'].get('usage_basis') != 'request' for e in snapshots)
                      or any((e['source']['line'], e['source']['record_hash']) not in paired
                             for e in events if e['kind'] == 'message.assistant'))
        if incomplete:
            result['warnings'].append('旧或混合 pi/dsh 归档缺少可靠逐调用事实，仅展示观测小计；请在新归档和新消费者库重建。')
            for turn in result['turns']:
                quarantine_request_totals(turn)
    revision_at = max((e['occurred_at'] for e in events if e['occurred_at']), default='')
    # Rank by source-record count like the direct reader; the additive
    # session.auth event shares a source line and must not change revision ties.
    record_count = sum(1 for e in events if e['kind'] != 'session.auth')
    return (revision_at, record_count), (result, start)


def _display_title(events, fallback):
    """Newest explicit title revision, or the first-observation snapshot.

    ``session.started`` only carries the title observed when Trace first read
    the source. A harness such as dsh can revise the display name later, so every
    revision is archived as a separate ``session.title`` event. Empty or missing
    revisions are unknown, not a reason to erase a known name.
    """
    latest = None
    for event in events:
        if event['kind'] != 'session.title':
            continue
        value = event.get('data', {}).get('title')
        if not isinstance(value, str) or not value:
            continue
        key = (event.get('occurred_at') or '', event['source']['line'])
        if latest is None or key > latest[0]:
            latest = (key, value)
    return latest[1] if latest else fallback


def _rebuild(db, archive_id, session_key):
    rows = db.execute('SELECT body FROM archive_events WHERE archive_id=? AND session_key=? ORDER BY seq',
                      (archive_id, session_key)).fetchall()
    events = [json.loads(row[0]) for row in rows]
    groups = {}
    for event in events:
        groups.setdefault(_source_group(event), []).append(event)
    chosen = None
    for group in groups.values():
        candidate = _rollout_result(group)
        if candidate is not None and (chosen is None or candidate[0] > chosen[0]):
            chosen = candidate
    if chosen is None:
        db.execute('DELETE FROM sessions WHERE key=?', (session_key,))
        return
    result, start = chosen[1]
    result['native_id'], result['id'] = result['id'], session_key
    for field in ('parent_id', 'forked_from_id'):
        if result.get(field):
            result[field] = json.dumps([start['runtime'], start['instance_id'], result[field]], ensure_ascii=False, separators=(',', ':'))
    for turn in result['turns']:
        turn['native_id'], turn['id'] = turn['id'], json.dumps([session_key, turn['id']], ensure_ascii=False, separators=(',', ':'))
    result['project_name'] = start['project_id']
    result['title'] = _display_title(events, start['data'].get('title'))
    result['source_path'] = start['source']['path']
    result['received_at'] = datetime.now(timezone.utc).isoformat()
    db.execute('INSERT OR REPLACE INTO sessions VALUES(?,?,?)', (session_key, 0, json.dumps(result, ensure_ascii=False)))


def import_batch(store, batch, allowed_project_ids=None):
    """Apply exactly one metadata page and cursor in one transaction.

    ``allowed_project_ids`` narrows consumption to the project ids in that
    collection; ``None`` (the default) consumes the whole archive. Every event
    is still validated as part of the page, but events outside the scope are
    skipped inside the transaction: they write no ``archive_events``, create no
    ``archive_sessions`` row and their deletions are skipped, while the cursor
    advances as usual. The page fingerprint is computed over the complete batch,
    so replaying a filtered page stays idempotent.
    """
    keys = {'schema_version', 'archive_id', 'view', 'after_cursor', 'next_cursor', 'has_more', 'events'}
    if isinstance(batch, dict) and 'removed_events' in batch:
        keys.add('removed_events')
    if (not isinstance(batch, dict) or set(batch) != keys or batch['schema_version'] != 1
            or batch['view'] != 'metadata' or not isinstance(batch['archive_id'], str) or not batch['archive_id']
            or not _integer(batch['after_cursor']) or not _integer(batch['next_cursor'])
            or batch['next_cursor'] < batch['after_cursor'] or type(batch['has_more']) is not bool
            or not isinstance(batch['events'], list)):
        raise ValueError('invalid archive batch')
    after, end, archive_id = batch['after_cursor'], batch['next_cursor'], batch['archive_id']
    previous = after
    for event in batch['events']:
        _validate_event(event, after, end)
        if event['runtime'] not in _RUNTIMES:
            raise ValueError('unsupported runtime')
        if event['archive_seq'] <= previous:
            raise ValueError('events must be ordered')
        previous = event['archive_seq']
    markers = batch.get('removed_events', [])
    if not isinstance(markers, list):
        raise ValueError('invalid removal markers')
    previous = after
    targets = set()
    event_seqs = {event['archive_seq'] for event in batch['events']}
    for marker in markers:
        if (not isinstance(marker, dict) or set(marker) != {'archive_seq', 'removed_seq'}
                or not _integer(marker['archive_seq']) or not _integer(marker['removed_seq'])
                or not 0 < marker['removed_seq'] < marker['archive_seq']
                or not previous < marker['archive_seq'] <= end
                or marker['archive_seq'] in event_seqs or marker['removed_seq'] in targets):
            raise ValueError('invalid removal marker')
        previous = marker['archive_seq']
        targets.add(marker['removed_seq'])
    if targets.intersection(marker['archive_seq'] for marker in markers):
        raise ValueError('removal target is a marker sequence')
    if batch['has_more'] and end == after:
        raise ValueError('non-advancing page')
    scope = _project_scope(allowed_project_ids)
    fingerprint = _digest(batch)
    db = store.db
    db.execute('BEGIN IMMEDIATE')
    try:
        db.execute('CREATE TABLE IF NOT EXISTS archive_events (archive_id TEXT NOT NULL, seq INTEGER NOT NULL, event_id TEXT NOT NULL, session_key TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY(archive_id,seq), UNIQUE(archive_id,event_id))')
        db.execute('CREATE TABLE IF NOT EXISTS archive_cursors (archive_id TEXT PRIMARY KEY, cursor INTEGER NOT NULL)')
        db.execute('CREATE TABLE IF NOT EXISTS archive_pages (archive_id TEXT NOT NULL, after_cursor INTEGER NOT NULL, next_cursor INTEGER NOT NULL, fingerprint TEXT NOT NULL, PRIMARY KEY(archive_id,after_cursor,next_cursor))')
        db.execute('CREATE TABLE IF NOT EXISTS archive_deleted (archive_id TEXT NOT NULL, session_key TEXT NOT NULL, PRIMARY KEY(archive_id,session_key))')
        db.execute('CREATE TABLE IF NOT EXISTS archive_sessions (session_key TEXT PRIMARY KEY, archive_id TEXT NOT NULL, project_id TEXT NOT NULL)')
        # Offline imports share this cursor and must not bypass a follower's
        # durable revision negotiation by advancing with a legacy page.
        state_columns = {row[1] for row in db.execute('PRAGMA table_info(follow_state)')}
        if ('event_removals' in state_columns and 'removed_events' not in batch
                and db.execute('SELECT 1 FROM follow_state WHERE archive_id=? AND event_removals=1',
                               (archive_id,)).fetchone()):
            raise ValueError('revision-enabled archive requires removal markers')
        row = db.execute('SELECT cursor FROM archive_cursors WHERE archive_id=?', (archive_id,)).fetchone()
        cursor = row[0] if row else 0
        if after != cursor:
            page = db.execute('SELECT fingerprint FROM archive_pages WHERE archive_id=? AND after_cursor=? AND next_cursor=?', (archive_id, after, end)).fetchone()
            if end <= cursor and page and page[0] == fingerprint:
                db.commit()
                return {'archive_id': archive_id, 'cursor': cursor, 'imported': 0, 'replayed': True}
            raise ValueError('archive cursor gap, overlapping page or conflicting replay')
        affected = set()
        imported = 0
        entries = [(event['archive_seq'], False, event) for event in batch['events']]
        entries += [(marker['archive_seq'], True, marker) for marker in markers]
        for _, is_marker, event in sorted(entries, key=lambda item: item[0]):
            if is_marker:
                row = db.execute('SELECT session_key FROM archive_events WHERE archive_id=? AND seq=?',
                                 (archive_id, event['removed_seq'])).fetchone()
                if row:
                    db.execute('DELETE FROM archive_events WHERE archive_id=? AND seq=?',
                               (archive_id, event['removed_seq']))
                    affected.add(row[0])
                continue
            key = event['session_key']
            if scope is not None and event['project_id'] not in scope:
                # Out-of-scope data belongs to another consumer's scope; skipping it
                # is not an error and must not block the cursor. The event was
                # validated above, so a malformed page still fails atomically.
                continue
            imported += 1
            owner = db.execute('SELECT archive_id,project_id FROM archive_sessions WHERE session_key=?', (key,)).fetchone()
            if owner and owner != (archive_id, event['project_id']):
                raise ValueError('session already belongs to another archive or project')
            db.execute('INSERT OR IGNORE INTO archive_sessions VALUES(?,?,?)', (key, archive_id, event['project_id']))
            if event['kind'] == 'session.deleted':
                if db.execute('SELECT 1 FROM archive_deleted WHERE archive_id=? AND session_key=?', (archive_id, key)).fetchone():
                    raise ValueError('duplicate deletion event')
                db.execute('DELETE FROM archive_events WHERE archive_id=? AND session_key=?', (archive_id, key))
                db.execute('INSERT OR IGNORE INTO archive_deleted VALUES(?,?)', (archive_id, key))
                db.execute('DELETE FROM sessions WHERE key=?', (key,))
                affected.discard(key)
                continue
            if db.execute('SELECT 1 FROM archive_deleted WHERE archive_id=? AND session_key=?', (archive_id, key)).fetchone():
                raise ValueError('deleted session cannot be resurrected')
            try:
                db.execute('INSERT INTO archive_events VALUES(?,?,?,?,?)',
                           (archive_id, event['archive_seq'], event['event_id'], key, _canonical(event)))
            except sqlite3.IntegrityError as exc:
                raise ValueError('conflicting archive event identity or sequence') from exc
            affected.add(key)
        for key in affected:
            _rebuild(db, archive_id, key)
        db.execute('INSERT OR REPLACE INTO archive_cursors VALUES(?,?)', (archive_id, end))
        db.execute('INSERT OR REPLACE INTO archive_pages VALUES(?,?,?,?)', (archive_id, after, end, fingerprint))
        db.commit()
        return {'archive_id': archive_id, 'cursor': end, 'imported': imported, 'replayed': False}
    except Exception:
        db.rollback()
        raise
