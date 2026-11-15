"""Public adapter API for importing provider-neutral session facts.

Providers must supply stable native session and turn IDs; imports replace complete
session snapshots, never individual turns. See docs/SOURCES.md.
"""
import json
from typing import Iterable, Optional, Protocol, TypedDict

from .codex import timestamp
from .core import Store


class TurnRequired(TypedDict):
    id: str


class NormalizedTurn(TurnRequired, total=False):
    started_at: Optional[str]
    model: Optional[str]
    token_total: Optional[int]
    input_tokens: Optional[int]
    cached_input_tokens: Optional[int]
    output_tokens: Optional[int]
    tools: list[str]


class SessionRequired(TypedDict):
    id: str
    turns: list[NormalizedTurn]


class NormalizedSession(SessionRequired, total=False):
    started_at: Optional[str]
    project: Optional[str]
    title: Optional[str]
    status: Optional[str]


class SourceProvider(Protocol):
    source: str
    instance: str

    def sessions(self) -> Iterable[NormalizedSession]: ...


def _text(value, name, required=False):
    if value is None and not required:
        return None
    if not isinstance(value, str) or not value.strip() or len(value) > 4096:
        raise ValueError('invalid ' + name)
    return value


def _time(value, name):
    if value is None:
        return None
    result = timestamp(value)
    if result is None:
        raise ValueError('invalid timezone-aware timestamp: ' + name)
    return result


def _key(parts):
    return json.dumps(parts, ensure_ascii=False, separators=(',', ':'))


def _normalize(source, instance, session):
    if not isinstance(session, dict) or set(session) - {'id', 'turns', 'started_at', 'project', 'title', 'status'}:
        raise ValueError('invalid session fields')
    native = _text(session.get('id'), 'session id', True)
    key = _key(['custom', source, instance, native])
    turns = session.get('turns')
    if not isinstance(turns, list):
        raise ValueError('session turns must be a list')
    result = {'id': key, 'native_id': native, 'source': source, 'instance': instance,
              'started_at': _time(session.get('started_at'), 'session started_at'),
              'project': _text(session.get('project'), 'project'),
              'title': _text(session.get('title'), 'title'),
              'status': _text(session.get('status'), 'status'),
              'usage_accounting': 'per_session', 'warnings': [], 'turns': []}
    seen = set()
    for turn in turns:
        if not isinstance(turn, dict) or set(turn) - {'id', 'started_at', 'model', 'token_total', 'input_tokens', 'cached_input_tokens', 'output_tokens', 'tools'}:
            raise ValueError('invalid turn fields')
        tid = _text(turn.get('id'), 'turn id', True)
        if tid in seen:
            raise ValueError('duplicate turn id')
        seen.add(tid)
        row = {'id': _key([key, tid]), 'native_id': tid,
               'started_at': _time(turn.get('started_at'), 'turn started_at'),
               'ended_at': None, 'status': 'unknown', 'attribution': 'provider',
               'evidence': [], 'reasoning_output_tokens': None,
               'model': _text(turn.get('model'), 'model')}
        for field in ('token_total', 'input_tokens', 'cached_input_tokens', 'output_tokens'):
            value = turn.get(field)
            if value is not None and (type(value) is not int or not 0 <= value <= 9007199254740991):
                raise ValueError('invalid ' + field)
            row[field] = value
        if row['cached_input_tokens'] is not None and row['input_tokens'] is not None and row['cached_input_tokens'] > row['input_tokens']:
            raise ValueError('cached input exceeds input')
        if all(row[k] is not None for k in ('token_total', 'input_tokens', 'output_tokens')) and row['token_total'] != row['input_tokens'] + row['output_tokens']:
            raise ValueError('token total does not match input plus output')
        tools = turn.get('tools', [])
        if not isinstance(tools, list):
            raise ValueError('tools must be a list of names')
        row['tools'] = [{'name': _text(name, 'tool name', True),
                         'call_id': _key([key, tid, index]), 'status': 'unknown',
                         'input_bytes': None, 'output_bytes': None, 'line': None,
                         'started_at': None, 'ended_at': None, 'attribution': 'provider'}
                        for index, name in enumerate(tools)]
        result['turns'].append(row)
    return result


def import_sessions(store: Store, source: str, instance: str,
                    sessions: Iterable[NormalizedSession]) -> dict:
    """Atomically validate and replace a batch of full session snapshots.

    Reimporting an identical snapshot is skipped. A changed snapshot with the
    same identity replaces the previous one; absent sessions are not deleted.
    """
    _text(source, 'source', True)
    _text(instance, 'instance', True)
    if isinstance(sessions, (str, bytes, dict)):
        raise ValueError('sessions must be an iterable of sessions')
    rows = []
    seen = set()
    for session in sessions:
        row = _normalize(source, instance, session)
        if row['id'] in seen:
            raise ValueError('duplicate session id')
        seen.add(row['id'])
        rows.append(row)
    imported = skipped = 0
    # A savepoint rolls back the entire batch even inside a caller transaction.
    store.db.execute('SAVEPOINT custom_import')
    try:
        for row in rows:
            body = json.dumps(row, ensure_ascii=False, sort_keys=True, separators=(',', ':'))
            old = store.db.execute('SELECT body FROM sessions WHERE key=?', (row['id'],)).fetchone()
            if old and old[0] == body:
                skipped += 1
                continue
            store.db.execute('INSERT OR REPLACE INTO sessions VALUES(?,?,?)', (row['id'], 0, body))
            imported += 1
        store.db.execute('RELEASE SAVEPOINT custom_import')
    except BaseException:
        store.db.execute('ROLLBACK TO SAVEPOINT custom_import')
        store.db.execute('RELEASE SAVEPOINT custom_import')
        raise
    return {'scanned': len(rows), 'imported': imported, 'skipped': skipped}


def import_source(store: Store, provider: SourceProvider) -> dict:
    """Import one provider's session snapshots atomically."""
    return import_sessions(store, provider.source, provider.instance, provider.sessions())


def import_document(store: Store, document: dict) -> dict:
    """Import a version 1 JSON document using the same validation as providers."""
    if not isinstance(document, dict) or set(document) != {'version', 'source', 'instance', 'sessions'} or type(document['version']) is not int or document['version'] != 1 or not isinstance(document['sessions'], list):
        raise ValueError('invalid custom source document')
    return import_sessions(store, document['source'], document['instance'], document['sessions'])
