"""Cost equivalents: cache categories, missing data, scope, and parent overlap."""
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from agent_stats.core import Store
from agent_stats.pricing import PRICING, aggregate_cost, estimate_turn


def turn(**overrides):
    return {
        'id': 'turn-a', 'model': 'gpt-6.1-sol', 'input_tokens': 1000000,
        'cached_input_tokens': 900000, 'output_tokens': 100000,
        'reasoning_output_tokens': 70000, 'token_total': 1100000,
        'cache_write_input_tokens': None, 'tools': [],
        'started_at': '2026-11-08T01:00:00Z', **overrides,
    }


class PricingTests(unittest.TestCase):
    def test_cached_input_and_reasoning_are_not_double_charged(self):
        original = turn()
        result = estimate_turn(original)
        self.assertEqual(result['estimated_cost'], 1.29)
        self.assertEqual(result['cost_breakdown'], {'input': .2, 'cached_input': .09, 'output': 1})
        self.assertNotIn('estimated_cost', original)

    def test_unknown_models_and_incomplete_or_inconsistent_categories(self):
        cases = [
            {'model': 'codex-auto-review'}, {'model': 'gpt-6.1-sol-other'},
            {'model': '混合模型'}, {'cached_input_tokens': None},
            {'input_tokens': None}, {'output_tokens': -1}, {'input_tokens': True},
            {'cached_input_tokens': 1000001}, {'token_total': 100},
            {'cache_write_input_tokens': 10}, {'cache_write_input_tokens': -1},
        ]
        for overrides in cases:
            with self.subTest(overrides=overrides):
                result = estimate_turn(turn(**overrides))
                self.assertIsNone(result['estimated_cost'])
                self.assertIsNone(result['cost_breakdown'])
                self.assertTrue(result['estimated_cost_reason'])

    def test_zero_and_small_values_remain_known(self):
        result = estimate_turn(turn(input_tokens=0, cached_input_tokens=0, output_tokens=0,
                                    token_total=0, cache_write_input_tokens=0))
        self.assertEqual(result['estimated_cost'], 0)
        self.assertIsNone(result['estimated_cost_reason'])
        tiny = estimate_turn(turn(model='gpt-6-luna', input_tokens=1,
                                  cached_input_tokens=1, output_tokens=0, token_total=1))
        self.assertEqual(tiny['estimated_cost'], .00000001)

    def test_pricing_table_shape_and_sources(self):
        required = {'input', 'cached_input', 'output'}
        for model, rates in PRICING['models'].items():
            with self.subTest(model=model):
                self.assertEqual(set(rates) - {'note', 'off_peak'}, required)
                self.assertTrue(all(type(rates[key]) in (int, float) and rates[key] >= 0
                                    for key in required))
                if 'off_peak' in rates:
                    self.assertEqual(set(rates['off_peak']), required)
        labels = [source['label'] for source in PRICING['sources']]
        self.assertIn('OpenAI 官方价格', labels)
        self.assertIn('DeepSeek 官方价格', labels)

    def test_added_openai_models_use_verified_standard_rates(self):
        cases = {
            'gpt-6.2-astra': 5.16,
            'gpt-6.2-sol': 1.29,
            'gpt-5.6-sol': 2.76,
            'gpt-5.6-terra': 1.58,
            'gpt-5.6-luna': .158,
            'gpt-5.5': 3.95,
            'gpt-5.4': 1.975,
        }
        for model, expected in cases.items():
            with self.subTest(model=model):
                result = estimate_turn(turn(model=model))
                self.assertAlmostEqual(result['estimated_cost'], expected)
                self.assertEqual(result['cost_basis'], 'estimated')
                self.assertEqual(result['cost_source'], 'model_rates')

    def test_deepseek_peak_and_off_peak_rates(self):
        peak = turn(model='deepseek-flash', input_tokens=1000000, cached_input_tokens=0,
                    output_tokens=1000000, token_total=2000000,
                    started_at='2026-11-20T02:30:00Z')
        self.assertAlmostEqual(estimate_turn(peak)['estimated_cost'], 1.5)
        # Off-peak is half price: weekday outside the two UTC peak windows and all weekend.
        for at in ('2026-11-20T12:00:00Z', '2026-11-21T02:30:00Z'):
            with self.subTest(at=at):
                off = dict(peak, started_at=at)
                self.assertAlmostEqual(estimate_turn(off)['estimated_cost'], .75)
        # No usable request time keeps the peak rate as an upper bound.
        unknown_time = dict(peak, started_at=None)
        self.assertAlmostEqual(estimate_turn(unknown_time)['estimated_cost'], 1.5)
        legacy = estimate_turn(dict(peak, model='deepseek-v4-flash'))
        self.assertAlmostEqual(legacy['estimated_cost'], 1.5)
        pro = estimate_turn(dict(peak, model='deepseek-v4-pro'))
        self.assertAlmostEqual(pro['estimated_cost'], 1.32 + 3.96)

    def test_deepseek_record_times_select_the_tier_per_request(self):
        def record(at):
            return {'usage': {'input_tokens': 1000000, 'cached_input_tokens': 0,
                              'output_tokens': 0, 'total_tokens': 1000000},
                    'model': 'deepseek-flash', 'cost_usd': None, 'cost_source': None,
                    'timestamp': at}
        merged = estimate_turn(turn(model='deepseek-flash', started_at=None,
                                    usage_records=[record('2026-11-20T02:30:00Z'),
                                                   record('2026-11-20T12:00:00Z')]))
        self.assertAlmostEqual(merged['estimated_cost'], .45)
        self.assertAlmostEqual(merged['estimated_cost_known'], .45)
        self.assertEqual(merged['cost_basis'], 'estimated')
        self.assertEqual(merged['cost_source'], 'model_rates')

    def test_codex_auto_review_free_waiver_is_account_scoped_and_dated(self):
        waived = turn(model='codex-auto-review', account_scoped=True,
                      started_at='2026-10-06T00:00:00Z')
        result = estimate_turn(waived)
        self.assertEqual(result['estimated_cost'], 0)
        self.assertEqual(result['cost_basis'], 'free')
        self.assertEqual(result['cost_source'], 'free_waiver')
        self.assertIsNone(result['cost_breakdown'])
        self.assertIsNone(result['estimated_cost_reason'])
        # The cutoff is an instant, not a lexical prefix: an offset time for the
        # same moment and a later fractional timestamp are both waived.
        for at in ('2026-10-06T08:00:00+08:00', '2026-10-06T00:00:00.500000Z',
                   '2026-11-20T01:00:00Z'):
            with self.subTest(at=at):
                self.assertEqual(estimate_turn(dict(waived, started_at=at))['estimated_cost'], 0)
        # Free regardless of token coverage: the waiver itself is the evidence.
        no_usage = estimate_turn(dict(waived, input_tokens=None, cached_input_tokens=None,
                                      output_tokens=None, token_total=None))
        self.assertEqual(no_usage['estimated_cost'], 0)
        self.assertEqual(no_usage['cost_basis'], 'free')
        summary = aggregate_cost([result])
        self.assertEqual(summary['estimated_cost'], 0)
        self.assertEqual(summary['estimated_cost_known'], 0)
        self.assertEqual(summary['cost_basis'], 'free')
        self.assertEqual(summary['cost_samples'], 1)

        unknown = [{'started_at': '2026-10-05T23:59:59.999999Z'},
                   {'started_at': '2026-10-05T23:59:59Z'}, {'started_at': None},
                   {'account_scoped': None}, {'account_scoped': False},
                   {'account_scoped': 'true'}]
        for overrides in unknown:
            with self.subTest(overrides=overrides):
                result = estimate_turn(dict(waived, **overrides))
                self.assertIsNone(result['estimated_cost'])
                self.assertIsNone(result['cost_basis'])
                self.assertIsNone(result['cost_source'])
                self.assertTrue(result['estimated_cost_reason'])
        # The waiver is scoped to the auto-review model only.
        priced = estimate_turn(dict(waived, model='gpt-6.1-sol'))
        self.assertAlmostEqual(priced['estimated_cost'], 1.29)
        self.assertEqual(priced['cost_basis'], 'estimated')

    def test_aggregate_distinguishes_unknown_partial_and_observed(self):
        known, missing = estimate_turn(turn()), estimate_turn(turn(model='unknown'))
        complete = aggregate_cost([known])
        self.assertEqual(complete['estimated_cost'], 1.29)
        partial = aggregate_cost([known, missing])
        self.assertIsNone(partial['estimated_cost'])
        self.assertEqual(partial['estimated_cost_known'], 1.29)
        self.assertEqual(partial['cost_samples'], 1)
        for rows in ([], [missing]):
            self.assertIsNone(aggregate_cost(rows)['estimated_cost_known'])
        blocked = aggregate_cost([known], blocked=True)
        self.assertIsNone(blocked['estimated_cost'])
        self.assertIsNone(blocked['estimated_cost_known'])
        self.assertEqual(blocked['observed_estimated_cost_known'], 1.29)

    def test_store_estimates_each_model_and_respects_detail_filters(self):
        with tempfile.TemporaryDirectory() as directory:
            store = Store(Path(directory) / 'stats.sqlite3')
            self.addCleanup(store.db.close)
            second = turn(id='turn-b', model='gpt-6-luna', started_at='2026-11-09T01:00:00Z')
            facts = {'id': 'parent', 'native_id': 'parent', 'source': 'codex', 'instance': 'test',
                     'project': '/synthetic', 'turns': [turn(), second]}
            child = {**facts, 'id': 'child', 'parent_id': 'parent', 'turns': [turn()]}
            for data in (facts, child):
                store.db.execute('INSERT INTO sessions VALUES(?,?,?)', (data['id'], 0, json.dumps(data)))
            store.db.commit()
            all_data = store.query()
            self.assertTrue(all_data['summary']['aggregation_blocked'])
            self.assertIsNone(all_data['summary']['cost'])  # Actual billing remains unknown.
            self.assertIsNone(all_data['summary']['estimated_cost_known'])
            self.assertEqual(all_data['summary']['observed_estimated_cost_known'], 2.649)
            self.assertEqual(all_data['summary']['cost_samples'], 3)
            filters = {'start': '2026-11-09T00:00:00Z'}
            scoped = store.query(filters)
            self.assertFalse(scoped['summary']['aggregation_blocked'])
            self.assertEqual(scoped['summary']['estimated_cost'], .069)
            self.assertEqual(scoped['sessions'][0]['estimated_cost'], .069)
            self.assertEqual(scoped['groups'][0]['estimated_cost'], .069)
            self.assertEqual(scoped['trend'][0]['estimated_cost'], .069)
            detail = store.detail('parent', filters)
            self.assertEqual(len(detail['turns']), 1)
            self.assertEqual(detail['turns'][0]['estimated_cost'], .069)
            self.assertEqual(detail['session']['estimated_cost'], .069)
            # Rates apply at query time, independent of persisted usage revisions.
            with patch.dict(PRICING['models'], {'gpt-6-luna': {'input': 1, 'cached_input': .1, 'output': 5}}):
                self.assertEqual(store.query(filters)['summary']['estimated_cost'], .69)
            stored = store.db.execute('SELECT body FROM sessions WHERE key=?', ('parent',)).fetchone()[0]
            self.assertNotIn('estimated_cost', stored)

    def test_missing_later_write_snapshot_keeps_positive_write_evidence(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / 'rollout.jsonl'
            rows = [
                {'type': 'session_meta', 'payload': {'id': 'writes'}},
                {'type': 'turn_context', 'payload': {'turn_id': 'turn-a', 'model': 'gpt-6.1-sol'}},
            ]
            for values in (
                {'input_tokens': 100, 'cached_input_tokens': 0, 'output_tokens': 10,
                 'total_tokens': 110, 'cache_write_input_tokens': 50},
                {'input_tokens': 200, 'cached_input_tokens': 0, 'output_tokens': 20,
                 'total_tokens': 220},
            ):
                rows.append({'type': 'event_msg', 'payload': {
                    'type': 'token_count', 'info': {'total_token_usage': values}}})
            for n, row in enumerate(rows):
                row['timestamp'] = '2026-11-08T00:00:0%dZ' % n
            source.write_text(''.join(json.dumps(row) + '\n' for row in rows))
            store = Store(root / 'stats.sqlite3')
            self.addCleanup(store.db.close)
            store.import_paths([source])
            result = store.query()
            parsed = result['turns'][0]
            self.assertIsNone(parsed['cache_write_input_tokens'])
            self.assertTrue(parsed['cache_write_observed'])
            self.assertIsNone(parsed['estimated_cost'])
            self.assertIn('TTL', parsed['estimated_cost_reason'])
            self.assertEqual(result['summary']['cost_samples'], 0)


if __name__ == '__main__':
    unittest.main()
