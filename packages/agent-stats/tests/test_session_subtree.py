"""Sessions with sub-agents expose the whole session tree as a subtree rollup."""
import json
import tempfile
import unittest
from pathlib import Path

from agent_stats.core import Store


def turn(identity, inp, cached, output, model='gpt-6.1-sol', tools=0):
    return {'id': identity, 'started_at': '2026-11-08T10:00:00Z', 'model': model,
            'input_tokens': inp, 'cached_input_tokens': cached, 'output_tokens': output,
            'token_total': inp + output,
            'tools': [{'call_id': identity + '-tool-%d' % i, 'name': 'exec_command'}
                      for i in range(tools)]}


class SessionSubtreeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.store = Store(Path(self.temp.name) / 'stats.sqlite3')
        self.addCleanup(self.store.db.close)

    def insert(self, data):
        self.store.db.execute('INSERT INTO sessions VALUES(?,?,?)',
                              (data['id'], 0, json.dumps(data)))
        self.store.db.commit()

    def facts(self, identity, **kwargs):
        return {'id': identity, 'native_id': identity, 'source': 'codex',
                'instance': 'test', 'project': '/project', **kwargs}

    def test_parent_row_rolls_up_descendant_sessions(self):
        parent = self.facts('parent', usage_accounting='per_session',
                            turns=[turn('p', 1000000, 900000, 100000, tools=2)])
        child = self.facts('child', usage_accounting='per_session', parent_id='parent',
                           turns=[turn('c', 500000, 400000, 50000, tools=3)])
        grandchild = self.facts('grandchild', usage_accounting='per_session', parent_id='child',
                                turns=[turn('g', 250000, 200000, 25000, tools=1)])
        for data in (parent, child, grandchild):
            self.insert(data)
        result = self.store.query()
        summary = result['summary']
        sessions = {session['id']: session for session in result['sessions']}
        self.assertFalse(summary['aggregation_blocked'])

        # A session's own fields still describe that session only.
        self.assertEqual(sessions['parent']['turns'], 1)
        self.assertEqual(sessions['parent']['token_known'], 1100000)
        self.assertNotEqual(sessions['parent']['estimated_cost_known'],
                            summary['estimated_cost_known'])

        # The parent row rolls up every descendant session.
        subtree = sessions['parent']['subtree']
        self.assertEqual(subtree['sessions'], 3)
        self.assertEqual(subtree['turns'], 3)
        self.assertEqual(subtree['tools'], 6)
        self.assertEqual(subtree['token_total'], summary['token_total'])
        self.assertEqual(subtree['token_known'], summary['token_known'])
        self.assertEqual(subtree['token_samples'], summary['token_samples'])
        self.assertEqual(subtree['estimated_cost'], summary['estimated_cost'])
        self.assertEqual(subtree['estimated_cost_known'], summary['estimated_cost_known'])
        self.assertEqual(subtree['cost_samples'], summary['cost_samples'])
        self.assertEqual(subtree['cost_basis'], summary['cost_basis'])
        self.assertEqual(subtree['cache_usage'], summary['cache_usage'])
        self.assertEqual(subtree['request_coverage']['observed_records'],
                         summary['request_coverage']['observed_records'])
        self.assertFalse(subtree['aggregation_blocked'])

        # The middle session nests the same way, while a leaf keeps the plain
        # session payload (the UI falls back to the session's own aggregates).
        self.assertEqual(sessions['child']['subtree']['turns'], 2)
        self.assertNotIn('subtree', sessions['grandchild'])
        self.assertEqual(sessions['grandchild']['token_known'], 275000)

        # Root session rows partition the current scope, so their totals sum
        # to the page summary without double counting.
        roots = [session for session in result['sessions'] if not session.get('parent_id')]
        self.assertEqual(sum(session['subtree']['token_known'] for session in roots),
                         summary['token_known'])
        self.assertAlmostEqual(
            sum(session['subtree']['estimated_cost_known'] for session in roots),
            summary['estimated_cost_known'], places=9)

    def test_subtree_only_covers_the_current_filter_scope(self):
        parent = self.facts('parent', usage_accounting='per_session',
                            turns=[turn('p', 1000, 500, 100)])
        child = self.facts('child', usage_accounting='per_session', parent_id='parent',
                           turns=[turn('c', 2000, 1000, 200, model='gpt-6-luna')])
        for data in (parent, child):
            self.insert(data)
        scoped = self.store.query({'model': 'gpt-6.1-sol'})
        self.assertFalse(scoped['summary']['aggregation_blocked'])
        self.assertEqual(len(scoped['sessions']), 1)
        only = scoped['sessions'][0]
        self.assertEqual(only['id'], 'parent')
        # The child is outside this scope, so the parent row is a leaf here and
        # needs no rollup; its own aggregates already match the scope summary.
        self.assertNotIn('subtree', only)
        self.assertEqual(only['token_total'], scoped['summary']['token_total'])
        self.assertEqual(only['estimated_cost_known'], scoped['summary']['estimated_cost_known'])

    def test_unverified_parent_child_accounting_withholds_combined_total(self):
        parent = self.facts('parent', usage_accounting='per_session',
                            turns=[turn('p', 1000, 500, 100)])
        child = self.facts('child', parent_id='parent',
                           turns=[turn('c', 2000, 1000, 200)])
        for data in (parent, child):
            self.insert(data)
        result = self.store.query()
        self.assertTrue(result['summary']['aggregation_blocked'])
        sessions = {session['id']: session for session in result['sessions']}
        subtree = sessions['parent']['subtree']
        self.assertTrue(subtree['aggregation_blocked'])
        self.assertIsNone(subtree['token_total'])
        self.assertIsNone(subtree['token_known'])
        self.assertIsNone(subtree['estimated_cost'])
        self.assertIsNone(subtree['estimated_cost_known'])
        self.assertEqual(subtree['observed_token_known'], 3300)
        self.assertAlmostEqual(subtree['observed_estimated_cost_known'], 0.00615, places=9)
        self.assertTrue(subtree['cache_usage']['aggregation_blocked'])
        # The child leaf keeps its own session totals; no combined total exists.
        self.assertNotIn('subtree', sessions['child'])
        self.assertEqual(sessions['child']['token_total'], 2200)

    def test_legacy_import_blocks_only_its_own_subtree(self):
        legacy = self.facts('legacy', source_path='/synthetic/old.jsonl',
                            turns=[turn('old', 100, 50, 10)])
        legacy_child = self.facts('legacy-child', usage_accounting='per_session',
                                  parent_id='legacy', turns=[turn('old-c', 200, 100, 20)])
        normal = self.facts('normal', usage_accounting='per_session',
                            turns=[turn('new', 300, 150, 30)])
        normal_child = self.facts('normal-child', usage_accounting='per_session',
                                  parent_id='normal', turns=[turn('new-c', 400, 200, 40)])
        for data in (legacy, legacy_child, normal, normal_child):
            self.insert(data)
        result = self.store.query()
        self.assertTrue(result['summary']['aggregation_blocked'])
        sessions = {session['id']: session for session in result['sessions']}
        self.assertTrue(sessions['legacy']['subtree']['aggregation_blocked'])
        self.assertIsNone(sessions['legacy']['subtree']['estimated_cost'])
        self.assertEqual(sessions['legacy']['subtree']['observed_token_known'], 330)
        self.assertFalse(sessions['normal']['subtree']['aggregation_blocked'])
        self.assertEqual(sessions['normal']['subtree']['token_total'], 770)


if __name__ == '__main__':
    unittest.main()
