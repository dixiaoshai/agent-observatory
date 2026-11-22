"""DSH workspace labels are presentation metadata, not Trace project IDs."""
import hashlib
import json
import tempfile
import unittest
from pathlib import Path

from agent_stats.archive import import_batch
from agent_stats.core import Store


def event(seq, sid, cwd, *, project='home', runtime='dsh', instance='local'):
    key = json.dumps([runtime, instance, sid], separators=(',', ':'))
    identity = json.dumps([runtime, instance, sid, seq], separators=(',', ':'))
    return {
        'schema_version': 1,
        'event_id': hashlib.sha256(identity.encode()).hexdigest(),
        'archive_seq': seq,
        'runtime': runtime,
        'instance_id': instance,
        'session_id': sid,
        'session_key': key,
        'project_id': project,
        'kind': 'session.started',
        'occurred_at': '2026-01-01T10:00:00Z',
        'observed_at': '2026-01-01T10:01:00Z',
        'native_type': 'session',
        'source': {'path': '/synthetic/session.jsonl', 'line': seq,
                   'record_hash': format(seq, '064x')},
        'data': {'cwd': cwd, 'created_at': '2026-01-01T10:00:00Z'},
        'body': None,
        'raw': None,
    }


def page(rows):
    return {'schema_version': 1, 'archive_id': 'synthetic-archive', 'view': 'metadata',
            'after_cursor': 0, 'next_cursor': len(rows), 'has_more': False, 'events': rows}


class DshWorkspaceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.dsh_home = self.root / 'dsh'
        self.dsh_home.mkdir()
        self.store = Store(self.root / 'stats.sqlite3', dsh_home=self.dsh_home,
                           codex_home=self.root / 'codex')

    def test_missing_index_falls_back_to_cwd_without_mutating_history(self):
        rows = [event(1, 'with-cwd', '/synthetic/personal_agent', project='home'),
                event(2, 'without-cwd', None, project='unscoped')]
        import_batch(self.store, page(rows))
        before = dict(self.store.db.execute('SELECT key,body FROM sessions'))
        sessions = {s['native_id']: s for s in self.store.query()['sessions']}
        self.assertEqual(sessions['with-cwd']['project'], '/synthetic/personal_agent')
        self.assertEqual(sessions['with-cwd']['project_name'], 'personal_agent')
        self.assertIsNone(sessions['without-cwd']['project_name'])
        self.assertEqual(self.store.detail(sessions['with-cwd']['id'])['session']['project_name'], 'personal_agent')
        self.assertIsNone(self.store.detail(sessions['without-cwd']['id'])['session']['project_name'])
        self.assertEqual(before, dict(self.store.db.execute('SELECT key,body FROM sessions')))

    def write_index(self, workspaces, **global_fields):
        storage = self.dsh_home / 'storages'
        storage.mkdir(exist_ok=True)
        document = {
            'unit': {'name': 'workspace', 'version': 2},
            'global': {'initialized': True, 'workspaceIds': list(workspaces),
                       'archivedSessionIds': [], 'pinnedSessionIds': [], **global_fields},
            'tables': {'workspaces': workspaces},
        }
        (storage / 'workspace.json').write_text(json.dumps(document), encoding='utf-8')

    def workspace(self, title, sessions, path='/synthetic/unrelated'):
        return {'path': path, 'title': title, 'sessionIds': sessions,
                'createdAt': '2026-01-01T00:00:00Z', 'updatedAt': '2026-01-01T00:00:00Z'}

    def local_event(self, seq, sid, cwd, **kwargs):
        row = event(seq, sid, cwd, **kwargs)
        # Deliberately do not create a session log: metadata lookup must not open it.
        row['source']['path'] = str(self.dsh_home / 'sessions' / sid / 'session.jsonl')
        return row

    def test_native_session_id_and_rename_are_reflected_without_reimport(self):
        self.write_index({'workspace-id': self.workspace('自定义名称', ['session-a'])})
        import_batch(self.store, page([self.local_event(1, 'session-a', '/synthetic/personal_agent')]))
        before = dict(self.store.db.execute('SELECT key,body FROM sessions'))
        session = self.store.query()['sessions'][0]
        self.assertEqual(session['project'], '/synthetic/personal_agent')
        self.assertEqual(session['project_name'], '自定义名称')
        self.assertEqual(self.store.detail(session['id'])['session']['project_name'], '自定义名称')
        self.write_index({'workspace-id': self.workspace('重命名后', ['session-a'])})
        self.assertEqual(self.store.query()['sessions'][0]['project_name'], '重命名后')
        self.assertEqual(self.store.detail(session['id'])['session']['project_name'], '重命名后')
        self.assertEqual(before, dict(self.store.db.execute('SELECT key,body FROM sessions')))

    def test_untrusted_or_ambiguous_sessions_use_cwd_not_native_index(self):
        self.write_index({'one': self.workspace('一', ['remote', 'outside', 'ambiguous', 'prefix']),
                          'two': self.workspace('二', ['ambiguous'])})
        prefix = self.local_event(5, 'prefix', '/synthetic/prefix-cwd')
        prefix['source']['path'] = str(self.dsh_home / 'sessions-other' / 'session.jsonl')
        rows = [self.local_event(1, 'remote', '/synthetic/remote-cwd', instance='remote'),
                event(2, 'outside', '/synthetic/outside-cwd'),
                self.local_event(3, 'ambiguous', '/synthetic/ambiguous-cwd'),
                self.local_event(4, 'unlisted', '/synthetic/unlisted-cwd'), prefix]
        import_batch(self.store, page(rows))
        sessions = {s['native_id']: s for s in self.store.query()['sessions']}
        for identity, label in [('remote', 'remote-cwd'), ('outside', 'outside-cwd'),
                                ('ambiguous', 'ambiguous-cwd'), ('unlisted', 'unlisted-cwd'),
                                ('prefix', 'prefix-cwd')]:
            with self.subTest(identity=identity):
                self.assertEqual(sessions[identity]['project_name'], label)
                self.assertEqual(self.store.detail(sessions[identity]['id'])['session']['project_name'], label)

    def test_invalid_or_partial_index_fails_closed_to_cwd(self):
        index = self.dsh_home / 'storages' / 'workspace.json'
        self.write_index({'one': self.workspace('索引名称', ['session-a'])})
        import_batch(self.store, page([self.local_event(1, 'session-a', '/synthetic/expected')]))
        session = self.store.query()['sessions'][0]
        self.assertEqual(session['project_name'], '索引名称')
        original = json.loads(index.read_text(encoding='utf-8'))
        for content in ('{', json.dumps({**original, 'unit': {'name': 'workspace', 'version': 999}}),
                        json.dumps({**original, 'global': {**original['global'], 'pendingMutation': {}}})):
            with self.subTest(content=content):
                index.write_text(content, encoding='utf-8')
                self.assertEqual(self.store.query()['sessions'][0]['project_name'], 'expected')
                self.assertEqual(self.store.detail(session['id'])['session']['project_name'], 'expected')

    def test_pi_archive_uses_cwd_not_trace_project_label(self):
        import_batch(self.store, page([event(1, 'pi-session', '/synthetic/pi-workspace',
                                             project='unscoped', runtime='pi')]))
        session = self.store.query()['sessions'][0]
        self.assertEqual(session['project'], '/synthetic/pi-workspace')
        self.assertEqual(session['project_name'], 'pi-workspace')
        self.assertEqual(self.store.detail(session['id'])['session']['project_name'], 'pi-workspace')

    def test_codex_archive_without_native_metadata_uses_cwd(self):
        rows = [event(1, 'codex-session', '/synthetic/code', project='named-project', runtime='codex')]
        import_batch(self.store, page(rows))
        session = self.store.query()['sessions'][0]
        self.assertEqual(session['project_name'], 'code')
        self.assertEqual(self.store.detail(session['id'])['session']['project_name'], 'code')

    def test_native_lookup_is_disabled_by_default(self):
        self.write_index({'workspace-id': self.workspace('本机名称', ['session-a'])})
        import_batch(self.store, page([self.local_event(1, 'session-a', '/synthetic/fallback')]))
        default_store = Store(self.store.path)
        self.addCleanup(default_store.db.close)
        self.assertEqual(self.store.query()['sessions'][0]['project_name'], '本机名称')
        self.assertEqual(default_store.query()['sessions'][0]['project_name'], 'fallback')

    def test_legacy_labels_and_invalid_cwd(self):
        rows = [event(1, 'legacy', '/synthetic/actual'), event(2, 'invalid', 'relative/path')]
        import_batch(self.store, page(rows))
        for key, body in self.store.db.execute('SELECT key,body FROM sessions').fetchall():
            session = json.loads(body)
            session['project_name'] = 'home'
            self.store.db.execute('UPDATE sessions SET body=? WHERE key=?', (json.dumps(session), key))
        self.store.db.commit()
        names = {s['native_id']: s['project_name'] for s in self.store.query()['sessions']}
        self.assertEqual(names, {'legacy': 'actual', 'invalid': '未知工作区'})

    def test_trace_authorization_is_still_by_archived_project_id(self):
        rows = [event(1, 'allowed', '/synthetic/alpha', project='home'),
                event(2, 'denied', '/synthetic/beta', project='unscoped')]
        import_batch(self.store, page(rows), allowed_project_ids=('home',))
        result = self.store.query()
        self.assertEqual([s['native_id'] for s in result['sessions']], ['allowed'])
        self.assertEqual(result['sessions'][0]['project_name'], 'alpha')
        self.assertEqual(result['sessions'][0]['project'], '/synthetic/alpha')
        self.assertEqual(self.store.query({'project': '/synthetic/alpha'})['summary']['sessions'], 1)
        self.assertEqual(self.store.query({'project': 'home'})['summary']['sessions'], 0)


if __name__ == '__main__':
    unittest.main()
