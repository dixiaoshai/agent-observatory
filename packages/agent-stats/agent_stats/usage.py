"""Source-backed cache observations; unknown categories are never zero-filled."""


USAGE_FIELDS = ('input_tokens', 'cached_input_tokens', 'cache_write_input_tokens',
                'output_tokens', 'reasoning_output_tokens', 'total_tokens')


def summarize_records(turn):
    """Sum only present per-call facts; never recover gaps from synthetic counters."""
    records = turn['usage_records']
    known = {}
    for field in USAGE_FIELDS:
        values = [r['usage'][field] for r in records if field in r['usage']]
        known[field] = sum(values) if values else None
        turn['token_total' if field == 'total_tokens' else field] = (
            sum(values) if records and len(values) == len(records) else None)
    turn['usage_known'] = known
    turn['token_known'] = known['total_tokens']
    costs = [r['cost_usd'] for r in records if r['cost_usd'] is not None]
    turn['recorded_cost_known_usd'] = sum(costs) if costs else None
    turn['recorded_cost_usd'] = sum(costs) if records and len(costs) == len(records) else None
    sources = {r['cost_source'] for r in records if r['cost_usd'] is not None and r['cost_source']}
    turn['recorded_cost_source'] = (next(iter(sources)) if len(sources) == 1
                                    else ('mixed' if sources else None))
    turn['cache_write_observed'] = (known['cache_write_input_tokens'] or 0) > 0


def quarantine_request_totals(turn):
    """Legacy normalization lost presence; retain only clearly labelled subtotals."""
    turn['request_facts_unavailable'] = True
    turn['token_known'] = turn.get('token_known', turn.get('token_total'))
    turn['recorded_cost_known_usd'] = turn.get('recorded_cost_known_usd', turn.get('recorded_cost_usd'))
    turn['recorded_cost_usd'] = None
    for field in USAGE_FIELDS:
        turn['token_total' if field == 'total_tokens' else field] = None


def aggregate_request_coverage(turns):
    """Coverage of observed source records is not coverage of actual API calls.

    None of the supported inputs proves an exhaustive request inventory. Native
    Codex counters/custom turn facts must not be counted as request identities.
    """
    records = [r for t in turns for r in t.get('usage_records', [])]
    with_usage = sum(bool(r['usage']) for r in records)
    with_cost = sum(r['cost_usd'] is not None for r in records)
    return {
        'scope': 'observed_usage_records',
        'total_requests': None, 'usage_ratio': None, 'cost_ratio': None,
        'observed_records': len(records),
        'records_with_usage': with_usage, 'unknown_usage_records': len(records) - with_usage,
        'records_with_cost': with_cost, 'unknown_cost_records': len(records) - with_cost,
        'unresolved_turns': sum(not t.get('usage_records') or bool(t.get('request_facts_unavailable')) for t in turns),
        'attribution_uncertain_turns': sum(bool(t.get('usage_attribution_uncertain')) for t in turns),
        'fields': {field: {
            'known_records': sum(field in r['usage'] for r in records),
            'unknown_records': sum(field not in r['usage'] for r in records),
        } for field in USAGE_FIELDS},
    }


def _count(value):
    return type(value) is int and value >= 0


def aggregate_cache(turns, blocked=False):
    """Use paired input/cache samples for both quantities and their token ratio.

    Cache reads are a subset of input, never an additional token category.
    When accounting is unresolved the caller must label observed subtotals and
    the observed input ratio as potentially overlapping.
    """
    paired = [(t.get('input_tokens'), t.get('cached_input_tokens'))
              if not t.get('request_facts_unavailable') else (None, None) for t in turns]
    valid = [(inp, cached) for inp, cached in paired
             if _count(inp) and _count(cached) and cached <= inp]
    writes = [t['cache_write_input_tokens'] for t in turns
              if _count(t.get('cache_write_input_tokens'))]
    inputs = sum(inp for inp, _ in valid) if valid else None
    cached = sum(value for _, value in valid) if valid else None
    return {
        'cached_input_known': cached,
        'uncached_input_known': inputs - cached if valid else None,
        'input_known': inputs,
        'hit_rate': cached / inputs if inputs else None,
        'samples': len(valid),
        'turns': len(turns),
        'complete': bool(turns) and len(valid) == len(turns),
        'aggregation_blocked': blocked,
        'cache_write_known': sum(writes) if writes else None,
        'cache_write_samples': len(writes),
    }
