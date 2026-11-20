"""Behavioral coverage for the shared metadata archive consumer."""
import hashlib
import json
import subprocess
import sys
from pathlib import Path
import tempfile
import unittest

from agent_stats.archive import _rollout_result, import_batch
from agent_stats.core import Store


def record(seq, kind, data=None, sid='synthetic', project='demo'):
    key = json.dumps(['codex', 'local', sid], separators=(',', ':'))
    native = json.dumps(['codex', 'local', sid, 'deleted' if kind == 'session.deleted' else seq], ensure_ascii=False, separators=(',', ':'))
    return {'schema_version': 1, 'event_id': hashlib.sha256(native.encode('utf-8')).hexdigest(), 'archive_seq': seq,
            'runtime': 'codex', 'instance_id': 'local', 'session_id': sid, 'session_key': key,
            'project_id': project, 'kind': kind, 'occurred_at': '2026-01-01T10:00:%02dZ' % seq,
            'observed_at': '2026-01-01T10:01:00Z', 'native_type': kind,
            'source': None if kind == 'session.deleted' else {'path': '/demo/rollout.jsonl', 'line': seq, 'record_hash': format(seq + 30, '064x')},
            'data': data or {}, 'body': None, 'raw': None}


def page(start, end, events):
    return {'schema_version': 1, 'archive_id': 'archive-demo', 'view': 'metadata', 'after_cursor': start,
            'next_cursor': end, 'has_more': False, 'events': events}


def auth_record(seq, started_seq=1, data=None, sid='synthetic'):
    """Account-scope evidence sharing the session_meta line with session.started."""
    event = record(seq, 'session.auth', data if data is not None else
                   {'turn_id': None, 'root_turn_id': None, 'model': None, 'account_scoped': True}, sid)
    event['source']['line'] = started_seq
    native = json.dumps(['codex', 'local', sid, started_seq, 'session.auth'],
                        ensure_ascii=False, separators=(',', ':'))
    event['event_id'] = hashlib.sha256(native.encode('utf-8')).hexdigest()
    return event


class ArchiveTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.store = Store(self.root / 'stats.sqlite3')
        self.rows = [
            record(1, 'session.started', {'cwd': '/demo', 'created_at': '2026-01-01T10:00:00Z'}),
            record(2, 'turn.started', {'turn_id': 'turn'}),
            record(3, 'turn.context', {'turn_id': 'turn', 'model': 'demo'}),
            record(4, 'usage.snapshot', {'turn_id': 'turn', 'cumulative': {'input_tokens': 100, 'output_tokens': 20, 'total_tokens': 120},
                                         'last_usage': {'input_tokens': 100, 'output_tokens': 20, 'total_tokens': 120}}),
            record(5, 'tool.called', {'turn_id': 'turn', 'call_id': 'call', 'name': 'shell', 'input_bytes': 50}),
            record(6, 'tool.returned', {'turn_id': 'turn', 'call_id': 'call', 'output_bytes': 12, 'status': 'result_observed'}),
            record(7, 'turn.completed', {'turn_id': 'turn'}),
        ]

    def test_revision_replacement_removal_scope_and_replay(self):
        import_batch(self.store, page(0, 7, self.rows), allowed_project_ids=('demo',))
        replacement = dict(self.rows[3])
        replacement['archive_seq'] = 9
        replacement['data'] = {'turn_id': 'turn', 'cumulative': {'total_tokens': 50},
                               'last_usage': {'total_tokens': 50}}
        revised = page(7, 9, [replacement])
        revised['removed_events'] = [{'archive_seq': 8, 'removed_seq': 4}]
        import_batch(self.store, revised, allowed_project_ids=('demo',))
        self.assertEqual(self.store.query()['summary']['token_total'], 50)
        self.assertTrue(import_batch(self.store, revised, allowed_project_ids=('demo',))['replayed'])
        removal = page(9, 11, [])
        removal['removed_events'] = [{'archive_seq': 10, 'removed_seq': 9},
                                     {'archive_seq': 11, 'removed_seq': 1}]
        import_batch(self.store, removal, allowed_project_ids=('demo',))
        self.assertEqual(self.store.query()['summary']['sessions'], 0)
        missing = page(11, 12, [])
        missing['removed_events'] = [{'archive_seq': 12, 'removed_seq': 8 + 3}]
        import_batch(self.store, missing, allowed_project_ids=('demo',))
        self.assertEqual(self.store.db.execute('SELECT cursor FROM archive_cursors').fetchone()[0], 12)

    def test_removal_of_out_of_scope_row_is_a_noop(self):
        outside = record(1, 'session.started', {'cwd': '/other'}, 'outside', project='other')
        import_batch(self.store, page(0, 1, [outside]), allowed_project_ids=('demo',))
        removal = page(1, 2, [])
        removal['removed_events'] = [{'archive_seq': 2, 'removed_seq': 1}]
        import_batch(self.store, removal, allowed_project_ids=('demo',))
        self.assertEqual(self.store.db.execute('SELECT COUNT(*) FROM archive_events').fetchone()[0], 0)
        self.assertEqual(self.store.db.execute('SELECT cursor FROM archive_cursors').fetchone()[0], 2)

    def test_invalid_markers_and_conflict_roll_back(self):
        import_batch(self.store, page(0, 7, self.rows))
        for markers in ([{'archive_seq': 8, 'removed_seq': 8}],
                        [{'archive_seq': 8, 'removed_seq': True}],
                        [{'archive_seq': 8, 'removed_seq': 1}, {'archive_seq': 9, 'removed_seq': 1}],
                        [{'archive_seq': 9, 'removed_seq': 1}, {'archive_seq': 8, 'removed_seq': 2}]):
            bad = page(7, 9, [])
            bad['removed_events'] = markers
            with self.assertRaises(ValueError):
                import_batch(self.store, bad)
        bad = page(7, 9, [dict(self.rows[2], archive_seq=9)])
        bad['removed_events'] = [{'archive_seq': 8, 'removed_seq': 4}]
        with self.assertRaises(ValueError):
            import_batch(self.store, bad)
        self.assertEqual(self.store.query()['summary']['token_total'], 120)
        self.assertEqual(self.store.db.execute('SELECT cursor FROM archive_cursors').fetchone()[0], 7)

    def test_usage_matches_direct_source_and_replay(self):
        source = self.root / 'rollout.jsonl'
        native = [
            {'type': 'session_meta', 'payload': {'id': 'synthetic', 'cwd': '/demo', 'timestamp': '2026-01-01T10:00:00Z'}},
            {'type': 'event_msg', 'payload': {'type': 'task_started', 'turn_id': 'turn'}},
            {'type': 'turn_context', 'payload': {'turn_id': 'turn', 'model': 'demo'}},
            {'type': 'event_msg', 'payload': {'type': 'token_count', 'turn_id': 'turn', 'info': {'total_token_usage': {'input_tokens': 100, 'output_tokens': 20, 'total_tokens': 120}, 'last_token_usage': {'input_tokens': 100, 'output_tokens': 20, 'total_tokens': 120}}}},
            {'type': 'response_item', 'payload': {'type': 'function_call', 'turn_id': 'turn', 'name': 'shell', 'call_id': 'call', 'arguments': 'X' * 50}},
            {'type': 'response_item', 'payload': {'type': 'function_call_output', 'turn_id': 'turn', 'call_id': 'call', 'output': 'X' * 12}},
            {'type': 'event_msg', 'payload': {'type': 'task_complete', 'turn_id': 'turn'}},
        ]
        for i, row in enumerate(native, 1):
            row['timestamp'] = '2026-01-01T10:00:%02dZ' % i
        source.write_text(''.join(json.dumps(x) + '\n' for x in native))
        self.store.import_paths([source])
        expected = self.store.query()['summary']
        batch = page(0, 7, self.rows)
        self.assertEqual(import_batch(self.store, batch)['cursor'], 7)
        actual = self.store.query()['summary']
        self.assertEqual(actual['sessions'], 1)
        self.assertEqual(actual['token_total'], expected['token_total'])
        self.assertEqual(actual['tool_calls'], expected['tool_calls'])
        self.assertTrue(import_batch(self.store, batch)['replayed'])
        self.assertEqual(self.store.query()['summary']['token_total'], 120)

    def test_privacy_gap_and_conflict_are_atomic(self):
        import_batch(self.store, page(0, 3, self.rows[:3]))
        bad = record(4, 'message.user', {'title': 'safe'})
        bad['body'] = {'text': 'SECRET_SENTINEL'}
        with self.assertRaises(ValueError):
            import_batch(self.store, page(3, 4, [bad]))
        self.assertNotIn(b'SECRET_SENTINEL', (self.root / 'stats.sqlite3').read_bytes())
        with self.assertRaises(ValueError):
            import_batch(self.store, page(4, 7, self.rows[4:]))
        conflict = page(0, 3, self.rows[:3]); conflict['events'][2]['data']['model'] = 'other'
        with self.assertRaises(ValueError):
            import_batch(self.store, conflict)
        self.assertEqual(self.store.db.execute('SELECT cursor FROM archive_cursors').fetchone()[0], 3)

    def test_deletion_and_resurrection(self):
        import_batch(self.store, page(0, 7, self.rows))
        tombstone = record(8, 'session.deleted')
        import_batch(self.store, page(7, 8, [tombstone]))
        self.assertEqual(self.store.query()['summary']['sessions'], 0)
        with self.assertRaises(ValueError):
            import_batch(self.store, page(8, 9, [record(9, 'session.started')]))
        self.assertEqual(self.store.db.execute('SELECT cursor FROM archive_cursors').fetchone()[0], 8)

    def test_direct_source_cannot_restore_deleted_archive_session(self):
        source = self.root / 'rollout.jsonl'
        native = [
            {'timestamp': '2026-01-01T10:00:01Z', 'type': 'session_meta',
             'payload': {'id': 'synthetic', 'cwd': '/demo'}},
            {'timestamp': '2026-01-01T10:00:02Z', 'type': 'event_msg',
             'payload': {'type': 'task_started', 'turn_id': 'turn'}},
        ]
        source.write_text(''.join(json.dumps(row) + '\n' for row in native), encoding='utf-8')
        import_batch(self.store, page(0, 7, self.rows))
        # The same source cannot replace the owned archive projection either.
        report = self.store.import_paths([source])
        self.assertEqual(report['skipped'], 1)
        self.assertFalse(report['errors'])
        self.assertEqual(self.store.query()['summary']['token_total'], 120)
        import_batch(self.store, page(7, 8, [record(8, 'session.deleted')]))
        report = self.store.import_paths([source])
        self.assertEqual(report['scanned'], 1)
        self.assertEqual(report['skipped'], 1)
        self.assertFalse(report['errors'])
        self.assertEqual(self.store.query()['summary']['sessions'], 0)
        self.assertEqual(Store(self.root / 'stats.sqlite3').query()['summary']['sessions'], 0)

    def test_cli_import_archive_summary_and_replay(self):
        batch_file = self.root / 'batch.json'
        batch_file.write_text(json.dumps(page(0, 7, self.rows)), encoding='utf-8')
        db_file = self.root / 'cli.sqlite3'
        base = [sys.executable, '-m', 'agent_stats', '--db', str(db_file)]
        def run(*args):
            result = subprocess.run(base + list(args), capture_output=True, text=True, check=True)
            return json.loads(result.stdout)
        first = run('import-archive', '--input', str(batch_file))
        self.assertEqual(first['cursor'], 7)
        self.assertFalse(first['replayed'])
        self.assertEqual(run('summary')['summary']['token_total'], 120)
        second = run('import-archive', '--input', str(batch_file))
        self.assertTrue(second['replayed'])
        self.assertEqual(second['imported'], 0)
        summary = run('summary')['summary']
        self.assertEqual(summary['sessions'], 1)
        self.assertEqual(summary['token_total'], 120)
        self.assertEqual(summary['tool_calls'], 1)

    def test_archive_ownership_conflict_is_atomic(self):
        import_batch(self.store, page(0, 3, self.rows[:3]))
        competing = page(0, 1, [self.rows[0]])
        competing['archive_id'] = 'another-archive'
        with self.assertRaises(ValueError):
            import_batch(self.store, competing)
        self.assertIsNone(self.store.db.execute('SELECT cursor FROM archive_cursors WHERE archive_id=?', ('another-archive',)).fetchone())
        self.assertEqual(self.store.query()['summary']['sessions'], 1)

    def test_metadata_allowlist_and_resume(self):
        import_batch(self.store, page(0, 3, self.rows[:3]))
        bad = record(4, 'source.unknown', {'content': 'SECRET_SENTINEL'})
        with self.assertRaises(ValueError):
            import_batch(self.store, page(3, 4, [bad]))
        import_batch(self.store, page(3, 7, self.rows[3:]))
        self.assertEqual(self.store.query()['summary']['token_total'], 120)

    def test_project_scope_skips_out_of_scope_events(self):
        usage = {'turn_id': 'turn', 'cumulative': {'input_tokens': 100, 'output_tokens': 20, 'total_tokens': 120},
                 'last_usage': {'input_tokens': 100, 'output_tokens': 20, 'total_tokens': 120}}
        in_scope = [
            record(1, 'session.started', {'cwd': '/demo', 'created_at': '2026-01-01T10:00:00Z'}, 'demo-session'),
            record(2, 'turn.started', {'turn_id': 'turn'}, 'demo-session'),
            record(3, 'usage.snapshot', usage, 'demo-session'),
            record(4, 'turn.completed', {'turn_id': 'turn'}, 'demo-session'),
        ]
        outside = [
            record(5, 'session.started', {'cwd': '/other', 'created_at': '2026-01-01T10:00:00Z'}, 'other-session', project='other'),
            record(6, 'turn.started', {'turn_id': 'turn'}, 'other-session', project='other'),
            record(7, 'turn.completed', {'turn_id': 'turn'}, 'other-session', project='other'),
        ]
        mixed = in_scope + outside
        result = import_batch(self.store, page(0, 7, mixed), allowed_project_ids=('demo',))
        # The cursor advances over the whole page even though only in-scope
        # events are stored.
        self.assertEqual((result['cursor'], result['imported'], result['replayed']), (7, 4, False))
        self.assertEqual(self.store.db.execute('SELECT cursor FROM archive_cursors').fetchone()[0], 7)
        self.assertEqual(self.store.query()['summary']['sessions'], 1)
        self.assertEqual(self.store.query()['summary']['token_total'], 120)
        self.assertEqual(self.store.db.execute('SELECT project_id FROM archive_sessions').fetchall(), [('demo',)])
        self.assertEqual(self.store.db.execute('SELECT COUNT(*) FROM archive_events').fetchone()[0], 4)

        # Out-of-scope deletions are skipped too, without creating a tombstone.
        deletion = record(8, 'session.deleted', sid='other-session', project='other')
        result = import_batch(self.store, page(7, 8, [deletion]), allowed_project_ids=['demo'])
        self.assertEqual((result['cursor'], result['imported']), (8, 0))
        self.assertIsNone(self.store.db.execute('SELECT 1 FROM archive_deleted').fetchone())

        # The fingerprint covers the complete batch, so replaying a filtered
        # page is still idempotent and does not move the cursor backwards.
        replay = import_batch(self.store, page(0, 7, mixed), allowed_project_ids=('demo',))
        self.assertTrue(replay['replayed'])
        self.assertEqual((replay['cursor'], replay['imported']), (8, 0))
        self.assertEqual(self.store.query()['summary']['sessions'], 1)
        self.assertEqual(self.store.db.execute('SELECT COUNT(*) FROM archive_events').fetchone()[0], 4)

        # Page validation still covers every event, including out-of-scope ones.
        bad = record(9, 'turn.started', {'turn_id': 'turn'}, 'other-session', project='other')
        bad['body'] = {'text': 'SECRET_SENTINEL'}
        with self.assertRaises(ValueError):
            import_batch(self.store, page(8, 9, [bad]), allowed_project_ids=('demo',))
        self.assertEqual(self.store.db.execute('SELECT cursor FROM archive_cursors').fetchone()[0], 8)
        self.assertNotIn(b'SECRET_SENTINEL', (self.root / 'stats.sqlite3').read_bytes())
        # An empty or non-string scope is a caller error, not "consume nothing".
        for bad_scope in ('demo', [], ['demo', '']):
            with self.subTest(scope=bad_scope):
                with self.assertRaises(ValueError):
                    import_batch(self.store, page(8, 9, [record(9, 'turn.started', {'turn_id': 'turn'})]),
                                 allowed_project_ids=bad_scope)


    def test_session_title_is_kept_and_bounded(self):
        titled = json.loads(json.dumps(self.rows))
        titled[0]['data']['title'] = '共享会话名称'
        import_batch(self.store, page(0, 7, titled))
        self.assertEqual(self.store.query()['sessions'][0]['title'], '共享会话名称')

        bad = record(8, 'session.started', {'cwd': '/other', 'title': 'two\nlines'}, sid='other')
        with self.assertRaises(ValueError):
            import_batch(self.store, page(7, 8, [bad]))
        self.assertEqual(self.store.db.execute('SELECT cursor FROM archive_cursors').fetchone()[0], 7)

        too_long = record(8, 'session.started', {'cwd': '/other', 'title': 'x' * 81}, sid='other')
        with self.assertRaises(ValueError):
            import_batch(self.store, page(7, 8, [too_long]))

    def test_missing_title_stays_unknown(self):
        import_batch(self.store, page(0, 7, self.rows))
        self.assertIsNone(self.store.query()['sessions'][0]['title'])

    def test_title_revisions_override_the_first_snapshot(self):
        titled = json.loads(json.dumps(self.rows))
        titled[0]['data']['title'] = '首次采集名称'
        import_batch(self.store, page(0, 7, titled))
        self.assertEqual(self.store.query()['sessions'][0]['title'], '首次采集名称')

        # A later page can carry only the revised display name.
        update = record(20, 'session.title', {'title': '模型生成名称'})
        update['occurred_at'] = '2026-01-02T09:00:00Z'
        import_batch(self.store, page(7, 21, [update]))
        self.assertEqual(self.store.query()['sessions'][0]['title'], '模型生成名称')

        # An older revision that arrives late must not replace the newer name.
        older = record(22, 'session.title', {'title': '旧名称'})
        older['occurred_at'] = '2026-01-01T09:00:00Z'
        import_batch(self.store, page(21, 23, [older]))
        self.assertEqual(self.store.query()['sessions'][0]['title'], '模型生成名称')

        # An empty revision is unknown and never erases a known name.
        blank = record(24, 'session.title', {'title': '   '})
        import_batch(self.store, page(23, 25, [blank]))
        self.assertEqual(self.store.query()['sessions'][0]['title'], '模型生成名称')

    def test_session_title_revision_is_typed_and_bounded(self):
        bad = record(8, 'session.title', {'title': 'two\nlines'})
        with self.assertRaises(ValueError):
            import_batch(self.store, page(0, 8, self.rows + [bad]))
        too_long = record(8, 'session.title', {'title': 'x' * 81})
        with self.assertRaises(ValueError):
            import_batch(self.store, page(0, 8, self.rows + [too_long]))
        extra = record(8, 'session.title', {'title': 'ok', 'cwd': '/demo'})
        with self.assertRaises(ValueError):
            import_batch(self.store, page(0, 8, self.rows + [extra]))
        self.assertEqual(self.store.db.execute('SELECT count(*) FROM sessions').fetchone()[0], 0)


    def _import_auto_review(self, occurred, with_auth=True, store=None):
        store = store or self.store
        rows = [record(1, 'session.started', {'cwd': '/demo', 'created_at': occurred})]
        if with_auth:
            rows.append(auth_record(2))
        rows.extend([
            record(3, 'turn.started', {'turn_id': 'review'}),
            record(4, 'turn.context', {'turn_id': 'review', 'model': 'codex-auto-review'}),
            record(5, 'usage.snapshot', {'turn_id': 'review',
                                         'cumulative': {'input_tokens': 100, 'output_tokens': 20, 'total_tokens': 120},
                                         'last_usage': {'input_tokens': 100, 'output_tokens': 20, 'total_tokens': 120}}),
            record(6, 'turn.completed', {'turn_id': 'review'}),
        ])
        for row in rows:
            row['occurred_at'] = occurred
        import_batch(store, page(0, 6, rows))
        return store

    def test_session_auth_marks_account_scope_and_waives_auto_review_cost(self):
        self._import_auto_review('2026-11-01T10:00:00Z')
        result = self.store.query()
        # session.auth is metadata only: it neither creates nor joins a turn.
        self.assertEqual(result['summary']['turns'], 1)
        session = result['sessions'][0]
        turn = result['turns'][0]
        self.assertEqual(turn['model'], 'codex-auto-review')
        self.assertIs(turn['account_scoped'], True)
        self.assertEqual(turn['estimated_cost'], 0)
        self.assertEqual(turn['cost_basis'], 'free')
        self.assertEqual(turn['cost_source'], 'free_waiver')
        self.assertIsNone(turn['cost_breakdown'])
        self.assertEqual(result['summary']['estimated_cost'], 0)
        self.assertEqual(result['summary']['estimated_cost_known'], 0)
        self.assertEqual(result['summary']['cost_basis'], 'free')
        detail = self.store.detail(session['id'])
        self.assertIs(detail['session']['account_scoped'], True)
        self.assertIs(detail['turns'][0]['account_scoped'], True)

    def test_session_auth_does_not_change_rollout_revision_rank(self):
        start = record(1, 'session.started', {'cwd': '/demo', 'created_at': '2026-01-01T10:00:00Z'})
        context = record(2, 'turn.context', {'turn_id': 'turn', 'model': 'demo'})
        auth = auth_record(2)
        auth['occurred_at'] = start['occurred_at']
        # The additive evidence shares the session_meta source line; the rollout
        # rank must still count source records, not normalized events.
        with_auth = _rollout_result([start, auth, context])
        without_auth = _rollout_result([start, context])
        self.assertIsNotNone(with_auth)
        self.assertEqual(with_auth[0], without_auth[0])

    def test_session_auth_removal_clears_account_scope(self):
        self._import_auto_review('2026-11-01T10:00:00Z')
        session = self.store.query()['sessions'][0]
        self.assertIs(self.store.detail(session['id'])['session']['account_scoped'], True)
        removal = page(6, 7, [])
        removal['removed_events'] = [{'archive_seq': 7, 'removed_seq': 2}]
        import_batch(self.store, removal)
        self.assertNotIn('account_scoped', self.store.detail(session['id'])['session'])
        self.assertIsNone(self.store.query()['turns'][0]['estimated_cost'])

    def test_session_auth_waiver_cutoff_and_absence_stay_unknown(self):
        for label, occurred, with_auth in (('pre-cutoff', '2026-10-05T23:59:59Z', True),
                                           ('no-auth', '2026-11-01T10:00:00Z', False)):
            with self.subTest(label=label):
                store = Store(self.root / (label + '.sqlite3'))
                self.addCleanup(store.db.close)
                self._import_auto_review(occurred, with_auth=with_auth, store=store)
                turn = store.query()['turns'][0]
                self.assertIsNone(turn['estimated_cost'])
                self.assertIsNone(turn['cost_basis'])
                self.assertIsNone(turn['cost_source'])
                self.assertTrue(turn['estimated_cost_reason'])
                if with_auth:
                    self.assertIs(turn['account_scoped'], True)
                else:
                    # Absence stays unknown; it is never encoded as API-key or false.
                    self.assertNotIn('account_scoped', turn)

    def test_session_auth_identity_flag_and_runtime_are_validated(self):
        started = record(1, 'session.started', {'cwd': '/demo', 'created_at': '2026-11-01T10:00:00Z'})
        import_batch(self.store, page(0, 1, [started]))
        # A shared source line still needs the trailing identity discriminator.
        undiscriminated = record(2, 'session.auth', {'account_scoped': True})
        undiscriminated['source']['line'] = 1
        with self.assertRaises(ValueError):
            import_batch(self.store, page(1, 2, [undiscriminated]))
        # A false flag is not a valid "unknown" encoding.
        with self.assertRaises(ValueError):
            import_batch(self.store, page(1, 2, [auth_record(2, data={'account_scoped': False})]))
        # The kind is Codex-only.
        foreign = auth_record(2)
        foreign['runtime'] = 'pi'
        foreign['session_key'] = json.dumps(['pi', 'local', 'synthetic'], separators=(',', ':'))
        with self.assertRaises(ValueError):
            import_batch(self.store, page(1, 2, [started, foreign]))
        self.assertEqual(self.store.db.execute('SELECT cursor FROM archive_cursors').fetchone()[0], 1)

    def test_session_auth_identity_includes_folded_series(self):
        started = record(1, 'session.started', {'cwd': '/demo', 'created_at': '2026-11-01T10:00:00Z'})
        folded = record(2, 'session.auth', {'turn_id': None, 'root_turn_id': None, 'model': None,
                                            'account_scoped': True})
        folded['source'] = {'path': '/demo/folded.jsonl', 'line': 1,
                            'record_hash': format(42, '064x'), 'series': 'folded-identity'}
        native = json.dumps(['codex', 'local', 'synthetic', 'folded-identity', 1, 'session.auth'],
                            ensure_ascii=False, separators=(',', ':'))
        folded['event_id'] = hashlib.sha256(native.encode('utf-8')).hexdigest()
        import_batch(self.store, page(0, 2, [started, folded]))
        self.assertEqual(self.store.db.execute('SELECT cursor FROM archive_cursors').fetchone()[0], 2)
        # The folded rollout has no session_meta of its own, so it proves no scope.
        session = self.store.query()['sessions'][0]
        self.assertNotIn('account_scoped', self.store.detail(session['id'])['session'])

    def test_session_auth_is_taken_from_the_winning_rollout_only(self):
        def rollout_event(seq, kind, data, series, occurred, line=None, sid='synthetic'):
            row = record(seq, kind, data, sid)
            row['occurred_at'] = occurred
            row['source'] = {'path': '/demo/%s.jsonl' % series, 'line': line or seq,
                             'record_hash': format(seq + 200, '064x'), 'series': series}
            parts = ['codex', 'local', sid, series, row['source']['line']]
            if kind == 'session.auth':
                parts.append('session.auth')
            native_id = json.dumps(parts, ensure_ascii=False, separators=(',', ':'))
            row['event_id'] = hashlib.sha256(native_id.encode('utf-8')).hexdigest()
            return row

        older = [
            rollout_event(1, 'session.started', {'cwd': '/demo', 'created_at': '2026-01-01T10:00:00Z'},
                          'old', '2026-01-01T10:00:00Z'),
            rollout_event(2, 'session.auth', {'turn_id': None, 'root_turn_id': None,
                                              'model': None, 'account_scoped': True},
                          'old', '2026-01-01T10:00:01Z', line=1),
        ]
        # The older, account-scoped rollout loses to the newer revision.
        newer = [
            rollout_event(3, 'session.started', {'cwd': '/demo', 'created_at': '2026-01-01T10:00:00Z'},
                          'new', '2026-11-01T10:00:00Z'),
            rollout_event(4, 'turn.started', {'turn_id': 'review'}, 'new', '2026-11-01T10:00:01Z'),
            rollout_event(5, 'turn.context', {'turn_id': 'review', 'model': 'codex-auto-review'},
                          'new', '2026-11-01T10:00:02Z'),
            rollout_event(6, 'turn.completed', {'turn_id': 'review'}, 'new', '2026-11-01T10:00:03Z'),
        ]
        import_batch(self.store, page(0, 2, older))
        import_batch(self.store, page(2, 7, newer))
        session = self.store.query()['sessions'][0]
        self.assertNotIn('account_scoped', self.store.detail(session['id'])['session'])
        self.assertIsNone(self.store.query()['turns'][0]['estimated_cost'])

        # Auth evidence arriving for the winning rollout applies to the session.
        extra = rollout_event(8, 'session.auth', {'turn_id': None, 'root_turn_id': None,
                                                  'model': None, 'account_scoped': True},
                              'new', '2026-11-02T10:00:00Z', line=3)
        import_batch(self.store, page(7, 9, [extra]))
        self.assertIs(self.store.detail(session['id'])['session']['account_scoped'], True)
        self.assertEqual(self.store.query()['turns'][0]['estimated_cost'], 0)

    def test_folded_source_series_is_part_of_the_identifier(self):
        start = record(1, 'session.started', {'cwd': '/demo', 'created_at': '2026-01-01T10:00:00Z'})
        folded = record(2, 'turn.started', {'turn_id': 'turn'})
        folded['source']['series'] = 'child-identity'
        native = json.dumps(['codex', 'local', 'synthetic', 'child-identity', 2],
                            ensure_ascii=False, separators=(',', ':'))
        folded['event_id'] = hashlib.sha256(native.encode('utf-8')).hexdigest()
        import_batch(self.store, page(0, 2, [start, folded]))
        self.assertEqual(self.store.db.execute('SELECT cursor FROM archive_cursors').fetchone()[0], 2)

        bad = record(3, 'turn.started', {'turn_id': 'turn'})
        bad['source']['series'] = 'synthetic'
        with self.assertRaises(ValueError):
            import_batch(self.store, page(2, 3, [bad]))
        empty = record(3, 'turn.started', {'turn_id': 'turn'})
        empty['source']['series'] = ''
        with self.assertRaises(ValueError):
            import_batch(self.store, page(2, 3, [empty]))
        self.assertEqual(self.store.db.execute('SELECT cursor FROM archive_cursors').fetchone()[0], 2)

    def test_archive_rebuild_keeps_the_same_revision_as_direct_import(self):
        def event(seq, kind, data, series, occurred, path, sid='shared-session'):
            row = record(seq, kind, data, sid)
            row['occurred_at'] = occurred
            row['source'] = {'path': path, 'line': seq, 'record_hash': format(seq + 70, '064x'), 'series': series}
            native = json.dumps(['codex', 'local', sid, series, seq], ensure_ascii=False, separators=(',', ':'))
            row['event_id'] = hashlib.sha256(native.encode('utf-8')).hexdigest()
            return row

        def usage(cumulative, last):
            return {'turn_id': last, 'cumulative': {k: v for k, v in cumulative.items()},
                    'last_usage': dict(last_usage)}

        # Two rollouts of one session: the shorter one ends first, the longer
        # one has a later revision and an extra turn.
        short = [
            event(1, 'session.started', {'cwd': '/demo', 'created_at': '2026-01-01T10:00:00Z'}, 'short-file', '2026-01-01T10:00:00Z', '/demo/short.jsonl'),
            event(2, 'turn.started', {'turn_id': 't1'}, 'short-file', '2026-01-01T10:00:01Z', '/demo/short.jsonl'),
            event(3, 'turn.context', {'turn_id': 't1', 'model': 'demo'}, 'short-file', '2026-01-01T10:00:02Z', '/demo/short.jsonl'),
            event(4, 'usage.snapshot', {'turn_id': 't1', 'cumulative': {'input_tokens': 100, 'output_tokens': 20, 'total_tokens': 120},
                                        'last_usage': {'input_tokens': 100, 'output_tokens': 20, 'total_tokens': 120}},
                  'short-file', '2026-01-01T10:00:03Z', '/demo/short.jsonl'),
            event(5, 'turn.completed', {'turn_id': 't1'}, 'short-file', '2026-01-01T10:00:04Z', '/demo/short.jsonl'),
        ]
        long = [
            event(1, 'session.started', {'cwd': '/demo', 'created_at': '2026-01-01T10:00:00Z'}, 'long-file', '2026-01-01T10:00:00Z', '/demo/long.jsonl'),
            event(2, 'turn.started', {'turn_id': 't1'}, 'long-file', '2026-01-01T10:00:01Z', '/demo/long.jsonl'),
            event(3, 'turn.context', {'turn_id': 't1', 'model': 'demo'}, 'long-file', '2026-01-01T10:00:02Z', '/demo/long.jsonl'),
            event(4, 'usage.snapshot', {'turn_id': 't1', 'cumulative': {'input_tokens': 100, 'output_tokens': 20, 'total_tokens': 120},
                                        'last_usage': {'input_tokens': 100, 'output_tokens': 20, 'total_tokens': 120}},
                  'long-file', '2026-01-01T10:00:03Z', '/demo/long.jsonl'),
            event(5, 'turn.completed', {'turn_id': 't1'}, 'long-file', '2026-01-01T10:00:04Z', '/demo/long.jsonl'),
            event(6, 'turn.started', {'turn_id': 't2'}, 'long-file', '2026-01-01T10:05:00Z', '/demo/long.jsonl'),
            event(7, 'turn.context', {'turn_id': 't2', 'model': 'demo'}, 'long-file', '2026-01-01T10:05:01Z', '/demo/long.jsonl'),
            event(8, 'usage.snapshot', {'turn_id': 't2', 'cumulative': {'input_tokens': 150, 'output_tokens': 20, 'total_tokens': 170},
                                        'last_usage': {'input_tokens': 50, 'output_tokens': 0, 'total_tokens': 50}},
                  'long-file', '2026-01-01T10:05:02Z', '/demo/long.jsonl'),
            event(9, 'turn.completed', {'turn_id': 't2'}, 'long-file', '2026-01-01T10:05:03Z', '/demo/long.jsonl'),
        ]
        for index, row in enumerate(long, start=6):
            row['archive_seq'] = index
            row['source']['line'] = index
            native_id = json.dumps(['codex', 'local', 'shared-session', 'long-file', index],
                                   ensure_ascii=False, separators=(',', ':'))
            row['event_id'] = hashlib.sha256(native_id.encode('utf-8')).hexdigest()
        import_batch(self.store, page(0, 5, short))
        import_batch(self.store, page(5, 14, long))

        native = [
            {'type': 'session_meta', 'payload': {'id': 'shared-session', 'cwd': '/demo', 'timestamp': '2026-01-01T10:00:00Z'}},
            {'type': 'event_msg', 'payload': {'type': 'task_started', 'turn_id': 't1'}},
            {'type': 'turn_context', 'payload': {'turn_id': 't1', 'model': 'demo'}},
            {'type': 'event_msg', 'payload': {'type': 'token_count', 'turn_id': 't1', 'info': {'total_token_usage': {'input_tokens': 100, 'output_tokens': 20, 'total_tokens': 120}, 'last_token_usage': {'input_tokens': 100, 'output_tokens': 20, 'total_tokens': 120}}}},
            {'type': 'event_msg', 'payload': {'type': 'task_complete', 'turn_id': 't1'}},
            {'type': 'event_msg', 'payload': {'type': 'task_started', 'turn_id': 't2'}},
            {'type': 'turn_context', 'payload': {'turn_id': 't2', 'model': 'demo'}},
            {'type': 'event_msg', 'payload': {'type': 'token_count', 'turn_id': 't2', 'info': {'total_token_usage': {'input_tokens': 150, 'output_tokens': 20, 'total_tokens': 170}, 'last_token_usage': {'input_tokens': 50, 'output_tokens': 0, 'total_tokens': 50}}}},
            {'type': 'event_msg', 'payload': {'type': 'task_complete', 'turn_id': 't2'}},
        ]
        for index, row in enumerate(native, 1):
            row['timestamp'] = '2026-01-01T10:0%d:0%dZ' % (index, index)
        source = self.root / 'long.jsonl'
        source.write_text(''.join(json.dumps(row) + '\n' for row in native), encoding='utf-8')
        direct = Store(self.root / 'direct.sqlite3')
        self.addCleanup(direct.db.close)
        direct.import_paths([source])
        expected = direct.query()['summary']
        actual = self.store.query()['summary']
        self.assertEqual(expected['token_total'], 170)
        self.assertEqual(actual['token_total'], expected['token_total'])
        self.assertEqual(actual['token_known'], expected['token_known'])
        self.assertEqual(actual['turns'], expected['turns'])
        self.assertEqual(self.store.query()['sessions'][0]['turns'], 2)
