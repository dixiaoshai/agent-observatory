"""Optional, read-only DSH workspace labels for local archive sessions.

Trace project IDs remain independent of these presentation labels.  The
workspace storage is an optional host-side index, not an archive data source.
"""
import json
import os
from pathlib import Path


_MAX_STORAGE_BYTES = 8 * 1024 * 1024
_MAX_TEXT = 4096


def _text(value):
    return isinstance(value, str) and bool(value.strip()) and len(value) <= _MAX_TEXT


def read_workspace_metadata(home):
    """Read the current DSH workspace index, returning unambiguous titles only.

    Unsupported versions, partially written indexes and malformed records are
    treated as unavailable.  Never read a path obtained from this index.
    """
    try:
        path = Path(home) / 'storages' / 'workspace.json'
        with path.open('rb') as stream:
            raw = stream.read(_MAX_STORAGE_BYTES + 1)
        if len(raw) > _MAX_STORAGE_BYTES:
            return {}
        document = json.loads(raw.decode('utf-8'))
        if not isinstance(document, dict):
            return {}
        unit, state, tables = document.get('unit'), document.get('global'), document.get('tables')
        if (not isinstance(unit, dict) or unit.get('name') != 'workspace'
                or type(unit.get('version')) is not int or unit['version'] != 2
                or not isinstance(state, dict) or state.get('initialized') is not True
                or state.get('pendingMutation') is not None or not isinstance(tables, dict)):
            return {}
        ids, workspaces = state.get('workspaceIds'), tables.get('workspaces')
        if (not isinstance(ids, list) or not isinstance(workspaces, dict)
                or any(not _text(identity) for identity in ids) or len(set(ids)) != len(ids)):
            return {}
        result, ambiguous = {}, set()
        for identity in ids:
            workspace = workspaces.get(identity)
            if not isinstance(workspace, dict):
                return {}
            title, sessions = workspace.get('title'), workspace.get('sessionIds')
            if not _text(title) or not isinstance(sessions, list) or any(not _text(s) for s in sessions):
                return {}
            for session in set(sessions):
                if session in result:
                    ambiguous.add(session)
                else:
                    result[session] = title.strip()
        for session in ambiguous:
            result.pop(session, None)
        return result
    except (OSError, ValueError, TypeError, UnicodeError, RecursionError):
        return {}


def archived_workspace_name(session, home, load_metadata):
    """Return a local DSH session's label without opening its archived source.

    A lexical containment check is intentional: source paths are untrusted
    archive metadata and must never be resolved or opened on the local host.
    """
    if not isinstance(session, dict) or session.get('source') != 'dsh' or session.get('instance') != 'local':
        return None
    identity, source = session.get('native_id'), session.get('source_path')
    if not _text(identity) or not isinstance(source, str) or not os.path.isabs(source) or '\x00' in source:
        return None
    try:
        root = os.fspath(home)
        if not isinstance(root, str) or not os.path.isabs(root) or '\x00' in root:
            return None
        root = os.path.normpath(os.path.join(root, 'sessions'))
        source = os.path.normpath(source)
        if source == root or os.path.commonpath((root, source)) != root:
            return None
        metadata = load_metadata()
        name = metadata.get(identity) if isinstance(metadata, dict) else None
        return name.strip() if _text(name) else None
    except (OSError, ValueError, TypeError):
        return None
