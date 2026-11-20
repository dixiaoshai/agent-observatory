"""Synthetic request records: sparse fields/costs are never complete turn totals."""
import copy
import hashlib
import json
import unittest
import tempfile
from pathlib import Path

from agent_stats.archive import import_batch
from agent_stats.core import Store
from test_pi_archive import record, page, usage


class RequestCoverageTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.store = Store(Path(self.temp.name) / 'stats.sqlite3')
        self.addCleanup(self.store.db.close)

    def rows(self, runtime='pi', second=None, costs=(0.02, None)):
        first = {'input_tokens': 100, 'cached_input_tokens': 20,
                 'output_tokens': 10, 'total_tokens': 110}
        second = second if second is not None else {'input_tokens': 50, 'output_tokens': 5, 'total_tokens': 55}
        rows = [record(1, 'session.started', {'created_at': '2026-01-01T10:00:00Z'}, runtime=runtime),
                record(2, 'turn.started', {'turn_id': 'u'}, runtime=runtime)]
        cumulative = {}
        for seq, fields, cost in ((3, first, costs[0]), (4, second, costs[1])):
            for key, value in fields.items():
                cumulative[key] = cumulative.get(key, 0) + value
            data = usage('u', dict(cumulative), fields, model='gpt-6.1-sol', cost=cost)
            data.update(usage_basis='request', request_id=str(seq),
                        request_id_source='pi_entry' if runtime == 'pi' else 'dsh_record')
            rows.append(record(seq, 'usage.snapshot', data, runtime=runtime))
        return rows

    def assert_partial(self, runtime):
        rows = self.rows(runtime)
        import_batch(self.store, page(0, 4, rows))
        result = self.store.query()
        turn, summary = result['turns'][0], result['summary']
        self.assertIsNone(turn['recorded_cost_usd'])
        self.assertEqual(turn['recorded_cost_known_usd'], 0.02)
        self.assertIsNone(turn['estimated_cost'])
        self.assertEqual(turn['estimated_cost_known'], 0.02)
        self.assertIsNone(turn['cached_input_tokens'])
        self.assertEqual(turn['usage_known']['cached_input_tokens'], 20)
        self.assertEqual(turn['token_total'], 165)
        self.assertIsNone(summary['recorded_cost'])
        self.assertEqual(summary['recorded_cost_known'], 0.02)
        self.assertIsNone(summary['estimated_cost'])
        self.assertEqual(summary['estimated_cost_known'], 0.02)
        coverage = summary['request_coverage']
        self.assertIsNone(coverage['total_requests'])
        self.assertIsNone(coverage['cost_ratio'])
        self.assertEqual(coverage['observed_records'], 2)
        self.assertEqual(coverage['unknown_cost_records'], 1)
        self.assertEqual(coverage['fields']['cached_input_tokens']['unknown_records'], 1)

    def test_pi_partial_recorded_cost_and_cache_missing_are_not_complete(self):
        self.assert_partial('pi')

    def test_dsh_partial_recorded_cost_and_cache_missing_are_not_complete(self):
        self.assert_partial('dsh')

    def test_explicit_zero_empty_usage_and_identical_cumulative_are_distinct(self):
        rows = self.rows(second={}, costs=(0, 0.03))
        import_batch(self.store, page(0, 4, rows))
        result = self.store.query()
        turn = result['turns'][0]
        self.assertEqual(len(turn['usage_records']), 2)
        self.assertEqual(turn['estimated_cost'], 0.03)
        self.assertIsNone(turn['token_total'])
        self.assertEqual(result['summary']['token_known'], 110)
        self.assertEqual(result['summary']['request_coverage']['unknown_usage_records'], 1)
        import_batch(self.store, page(0, 4, rows))
        self.assertEqual(self.store.query()['summary']['estimated_cost'], 0.03)

    def test_no_recorded_cost_keeps_api_equivalent_separate(self):
        fields = {'input_tokens': 10, 'cached_input_tokens': 0, 'output_tokens': 0, 'total_tokens': 10}
        rows = self.rows(second=fields, costs=(None, None))
        import_batch(self.store, page(0, 4, rows))
        turn = self.store.query()['turns'][0]
        self.assertIsNone(turn['recorded_cost_usd'])
        self.assertIsNone(turn['recorded_cost_known_usd'])
        self.assertEqual(turn['cost_basis'], 'estimated')
        self.assertIsNotNone(turn['api_estimated_cost'])
        self.assertEqual(turn['api_estimated_cost'], turn['estimated_cost'])
        self.assertIsNone(self.store.query()['summary']['recorded_cost_known'])

    def test_legacy_runtime_last_usage_is_not_synthetic_delta(self):
        rows = self.rows()
        for row in rows[2:]:
            for key in ('usage_basis', 'request_id', 'request_id_source'):
                row['data'].pop(key)
        import_batch(self.store, page(0, 4, rows))
        turn = self.store.query()['turns'][0]
        self.assertIsNone(turn['cached_input_tokens'])
        self.assertEqual(turn['usage_records'][0]['event_id'], rows[2]['event_id'])
        self.assertIsNone(turn['usage_records'][0]['request_id'])

    def test_request_metadata_rejects_invalid_combinations_atomically(self):
        rows = self.rows()
        for patch in ({'usage_basis': 'cumulative'}, {'request_id_source': 'dsh_record'},
                      {'request_id': None}, {'request_id': ''}, {'request_id': 1},
                      {'request_id_source': []}, {'request_id': ' entry '},
                      {'request_id': 'x\x7f'}, {'request_id': '😀' * 2049},
                      {'request_id': '\ufeffentry'}, {'request_id': 'entry\ufeff'}):
            broken = copy.deepcopy(rows)
            broken[-1]['data'].update(patch)
            with self.subTest(patch=patch), self.assertRaises(ValueError):
                import_batch(self.store, page(0, 4, broken))
            self.assertEqual(self.store.query()['summary']['sessions'], 0)
        broken = copy.deepcopy(rows)
        del broken[-1]['data']['request_id']
        with self.assertRaises(ValueError):
            import_batch(self.store, page(0, 4, broken))

    def test_request_identity_matches_javascript_trim_for_unicode_whitespace(self):
        rows = self.rows()
        rows[2]['data']['request_id'] = '\u0085entry'
        rows[3]['data']['request_id'] = 'entry\u0085'
        import_batch(self.store, page(0, 4, rows))
        facts = self.store.query()['turns'][0]['usage_records']
        self.assertEqual([r['request_id'] for r in facts], ['\u0085entry', 'entry\u0085'])

    def test_missing_then_recovered_field_remains_partial_but_zero_is_known(self):
        rows = self.rows(second={'cached_input_tokens': 0, 'total_tokens': 0}, costs=(None, None))
        # Missing cache in the first record cannot be reconstructed from the
        # second cumulative counter or its explicit zero.
        del rows[2]['data']['last_usage']['cached_input_tokens']
        import_batch(self.store, page(0, 4, rows))
        turn = self.store.query()['turns'][0]
        self.assertIsNone(turn['cached_input_tokens'])
        self.assertEqual(turn['usage_known']['cached_input_tokens'], 0)
        self.assertEqual(turn['request_coverage']['fields']['cached_input_tokens']['unknown_records'], 1)

    def test_recorded_partial_is_not_filled_with_api_estimate(self):
        fields = {'input_tokens': 10, 'cached_input_tokens': 0, 'output_tokens': 0, 'total_tokens': 10}
        rows = self.rows(second=fields)
        import_batch(self.store, page(0, 4, rows))
        turn = self.store.query()['turns'][0]
        self.assertIsNone(turn['estimated_cost'])
        self.assertEqual(turn['estimated_cost_known'], 0.02)
        self.assertIsNotNone(turn['api_estimated_cost'])
        self.assertNotEqual(turn['api_estimated_cost'], 0.02)

    def test_fork_unknown_times_never_produces_complete_cost(self):
        rows = self.rows(second={}, costs=(0.02, None))
        rows[0]['data']['forked_from_session_id'] = 'parent'
        rows[-1]['occurred_at'] = None
        import_batch(self.store, page(0, 4, rows))
        result = self.store.query()
        turn = result['turns'][0]
        self.assertIsNone(turn['token_total'])
        self.assertIsNone(turn['estimated_cost'])
        self.assertEqual(turn['estimated_cost_known'], 0.02)
        self.assertIsNone(turn['api_estimated_cost'])
        self.assertTrue(turn['usage_attribution_uncertain'])
        self.assertIsNone(turn['recorded_cost_usd'])
        self.assertTrue(result['summary']['aggregation_blocked'])
        self.assertIsNone(result['summary']['recorded_cost_known'])
        self.assertEqual(result['summary']['observed_estimated_cost_known'], 0.02)
        detail = self.store.detail(result['sessions'][0]['id'])
        self.assertIsNone(detail['session']['estimated_cost'])

    def test_fork_missing_creation_time_blocks_complete_recorded_cost_and_parent_sum(self):
        fields = {'input_tokens': 10, 'cached_input_tokens': 0, 'output_tokens': 0, 'total_tokens': 10}
        rows = self.rows(second=fields, costs=(0.02, 0.03))
        rows[0]['data'].update(forked_from_session_id='parent', created_at=None)
        rows[0]['occurred_at'] = None
        import_batch(self.store, page(0, 4, rows))
        result = self.store.query()
        turn = result['turns'][0]
        self.assertIsNone(turn['recorded_cost_usd'])
        self.assertEqual(turn['recorded_cost_known_usd'], 0.05)
        self.assertTrue(result['summary']['aggregation_blocked'])
        self.assertIsNone(result['summary']['estimated_cost_known'])
        self.assertEqual(result['summary']['observed_estimated_cost_known'], 0.05)
        self.assertEqual(result['summary']['request_coverage']['attribution_uncertain_turns'], 1)
        detail = self.store.detail(result['sessions'][0]['id'])
        self.assertIsNone(detail['session']['recorded_cost'])
        self.assertIsNone(detail['session']['recorded_cost_known'])
        # The fork relation is distinct from parent_id; showing its source
        # session must not turn the overlapping observed subtotal into a total.
        parent_id = json.dumps(['pi', 'local', 'parent'], separators=(',', ':'))
        parent = {'id': parent_id, 'source': 'pi', 'instance': 'local',
                  'usage_accounting': 'per_session', 'usage_projection_version': 2,
                  'turns': [{'id': 'p', 'model': 'unknown', 'token_total': 110,
                             'recorded_cost_usd': 0.01, 'tools': []}]}
        self.store.db.execute('INSERT INTO sessions VALUES(?,?,?)', (parent_id, 0, json.dumps(parent)))
        self.store.db.commit()
        combined = self.store.query()['summary']
        self.assertTrue(combined['aggregation_blocked'])
        self.assertIsNone(combined['recorded_cost'])
        self.assertEqual(combined['observed_estimated_cost_known'], 0.06)

    def test_legacy_missing_usage_is_quarantined_not_upgraded_to_complete(self):
        rows = self.rows(costs=(0.02, 0.03))
        for row in rows[2:]:
            for key in ('usage_basis', 'request_id', 'request_id_source'):
                row['data'].pop(key)
        # Old adapter: missing cacheRead was encoded as input + zero, and a
        # whole assistant response with no usage was omitted from usage events.
        rows.append(record(5, 'message.assistant', {'turn_id': 'u'}))
        import_batch(self.store, page(0, 5, rows))
        result = self.store.query()
        turn = result['turns'][0]
        self.assertTrue(turn['request_facts_unavailable'])
        self.assertIsNone(turn['token_total'])
        self.assertIsNone(turn['estimated_cost'])
        self.assertIsNone(turn['input_tokens'])
        self.assertEqual(turn['estimated_cost_known'], 0.05)
        self.assertTrue(result['warnings'])
        self.assertFalse(result['summary']['cache_usage']['complete'])

    def test_old_persisted_projection_is_read_only_quarantined(self):
        old = {'id': 'old', 'source': 'pi', 'instance': 'local', 'source_path': '/synthetic/old.jsonl',
               'usage_accounting': 'per_session', 'turns': [{
                   'id': 'u', 'model': 'gpt-6.1-sol', 'token_total': 110,
                   'input_tokens': 100, 'cached_input_tokens': 20, 'output_tokens': 10,
                   'recorded_cost_usd': 0.02, 'recorded_cost_source': 'provider', 'tools': []}]}
        body = json.dumps(old)
        self.store.db.execute('INSERT INTO sessions VALUES(?,?,?)', ('old', 0, body))
        self.store.db.commit()
        result = self.store.query()
        self.assertIsNone(result['summary']['token_total'])
        self.assertEqual(result['summary']['token_known'], 110)
        self.assertIsNone(result['summary']['estimated_cost'])
        self.assertEqual(result['summary']['estimated_cost_known'], 0.02)
        self.assertEqual(self.store.db.execute('SELECT body FROM sessions').fetchone()[0], body)

    def test_native_codex_snapshot_cost_is_only_a_known_subtotal(self):
        rows = self.rows(costs=(0.02, None))
        for row in rows:
            row['runtime'] = 'codex'
            row['session_key'] = json.dumps(['codex', 'local', row['session_id']], separators=(',', ':'))
            identity = ['codex', 'local', row['session_id'], row['source']['line']]
            row['event_id'] = hashlib.sha256(json.dumps(identity, separators=(',', ':')).encode()).hexdigest()
            for key in ('usage_basis', 'request_id', 'request_id_source'):
                row['data'].pop(key, None)
        import_batch(self.store, page(0, 4, rows))
        result = self.store.query()
        self.assertEqual(result['summary']['token_total'], 165)
        self.assertIsNone(result['summary']['recorded_cost'])
        self.assertIsNone(result['summary']['estimated_cost'])
        self.assertEqual(result['summary']['estimated_cost_known'], 0.02)
        self.assertIsNone(result['summary']['request_coverage']['total_requests'])


if __name__ == '__main__':
    unittest.main()
