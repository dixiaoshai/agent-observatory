"""Source-recorded costs and current API equivalents, never account billing."""
import math
from decimal import Decimal

from .usage import aggregate_request_coverage


PRICING = {
    'currency': 'USD',
    'checked_at': '2026-11-08',
    'source_url': 'https://developers.openai.com/api/docs/pricing?latest-pricing-expanded=true',
    'basis': '当前 API Standard 短上下文价格',
    'assumptions': [
        '按当前单价估算历史 Token 的 API 等价费用，不是实际账单或订阅扣费。',
        '按 Standard 短上下文费率估算；轮次聚合无法还原逐请求长上下文加价或实际服务等级。',
        '未记录缓存写入时按无单独计费写入估算；已记录写入但缺少 TTL 时无法估算。',
        '普通输入 = 输入 − 缓存输入；推理已包含在输出中，不再相加。不含工具等附加费。',
        '无匹配公开单价或缺少有效分类用量时保留未知；覆盖不完整时仅展示已知小计。',
        '父子按各会话新增用量合计；分叉历史基线无法确认时保留未知。',
    ],
    # USD per million tokens. Exact model IDs only: no guessed family aliases.
    'models': {
        'gpt-6-astra': {'input': 10, 'cached_input': 1, 'output': 50},
        'gpt-6.1-sol': {'input': 2, 'cached_input': .10, 'output': 10},
        'gpt-6.1-terra': {'input': 1, 'cached_input': .05, 'output': 5},
        'gpt-6-luna': {'input': .10, 'cached_input': .01, 'output': .50},
    },
}


def _amount(value):
    # Keep sub-cent values; round only floating-point transport noise.
    return float(round(value, 12))


def estimate_turn(turn):
    """Enrich a copy at query time, so price changes do not require reimports."""
    if turn.get('request_facts_unavailable') or turn.get('recorded_cost_incomplete'):
        known = turn.get('recorded_cost_known_usd')
        return dict(turn, estimated_cost=None, estimated_cost_known=known,
                    estimated_cost_reason=('累计快照不能证明请求级记录费用完整性'
                                           if turn.get('recorded_cost_incomplete') else
                                           '旧投影缺少可靠逐调用事实，须在新库重建'),
                    cost_breakdown=None, cost_basis='recorded' if known is not None else None,
                    cost_source=turn.get('recorded_cost_source'),
                    request_coverage=aggregate_request_coverage([turn]))
    if turn.get('usage_records'):
        return _estimate_records(turn)
    result = dict(turn, estimated_cost=None, estimated_cost_reason=None, cost_breakdown=None,
                  cost_basis=None, cost_source=None)

    def unavailable(reason):
        result['estimated_cost_reason'] = reason
        return result

    # A harness-recorded request cost (e.g. pi) is authoritative for that turn:
    # it already reflects the rate table and provider-reported charges in effect
    # when the request was made. Never re-estimate it from today's PRICING.
    recorded = turn.get('recorded_cost_usd')
    if recorded is not None:
        if type(recorded) in (int, float) and math.isfinite(recorded) and recorded >= 0:
            result['estimated_cost'] = _amount(recorded)
            result['cost_basis'] = 'recorded'
            result['cost_source'] = turn.get('recorded_cost_source')
            return result
        return unavailable('记录成本无效')

    rates = PRICING['models'].get(turn.get('model'))
    if rates is None:
        return unavailable('模型没有匹配的公开单价')
    fields = [turn.get(k) for k in ('input_tokens', 'cached_input_tokens', 'output_tokens')]
    if any(type(v) is not int or v < 0 for v in fields):
        return unavailable('缺少有效的输入、缓存输入或输出用量')
    inp, cached, output = fields
    if cached > inp:
        return unavailable('缓存输入大于输入用量，分类不一致')
    total = turn.get('token_total')
    if total is not None and (type(total) is not int or total != inp + output):
        return unavailable('Token 总量与输入、输出分类不一致')
    writes = turn.get('cache_write_input_tokens')
    if turn.get('cache_write_observed'):
        return unavailable('已观察到缓存写入，但缺少写入 TTL，无法匹配费率')
    if writes is not None:
        if type(writes) is not int or writes < 0:
            return unavailable('缓存写入用量无效')
        if writes > 0:
            return unavailable('已记录缓存写入，但缺少写入 TTL，无法匹配费率')
    counts = {'input': inp - cached, 'cached_input': cached, 'output': output}
    amounts = {key: Decimal(counts[key]) * Decimal(str(rates[key])) / 1000000 for key in counts}
    result['estimated_cost'] = _amount(sum(amounts.values()))
    result['cost_breakdown'] = {key: _amount(value) for key, value in amounts.items()}
    result['cost_basis'] = 'estimated'
    result['cost_source'] = 'model_rates'
    return result


def _sum_amount(values):
    return _amount(sum((Decimal(str(v)) for v in values), Decimal(0))) if values else None


def _estimate_records(turn):
    """Do not fill a hole in recorded charges with today's API-equivalent price."""
    records = turn['usage_records']
    estimates = []
    for record in records:
        facts = dict(record['usage'], model=record['model'])
        facts['token_total'] = facts.pop('total_tokens', None)
        estimates.append(estimate_turn(facts))
    api_values = [r['estimated_cost'] for r in estimates if r['estimated_cost'] is not None]
    api_known = _sum_amount(api_values)
    api_complete = api_known if len(api_values) == len(records) else None
    recorded = [r['cost_usd'] for r in records if r['cost_usd'] is not None]
    if recorded:
        known = _sum_amount(recorded)
        complete = known if len(recorded) == len(records) else None
        basis, source = 'recorded', turn.get('recorded_cost_source')
        breakdown = None
        reason = None if complete is not None else '部分用量观测记录缺少记录费用；仅展示已知小计'
    else:
        known, complete = api_known, api_complete
        basis, source = ('estimated', 'model_rates') if known is not None else (None, None)
        breakdown = ({key: _sum_amount([r['cost_breakdown'][key] for r in estimates])
                      for key in ('input', 'cached_input', 'output')}
                     if complete is not None else None)
        reason = None if complete is not None else '部分用量观测记录缺少可估算分类或单价'
    if turn.get('usage_attribution_uncertain'):
        complete = api_complete = None
        breakdown = None
        reason = '分叉继承归属不确定；仅为可能重叠的观测小计'
    return dict(turn, estimated_cost=complete, estimated_cost_known=known,
                estimated_cost_reason=reason, cost_breakdown=breakdown,
                cost_basis=basis, cost_source=source,
                api_estimated_cost=api_complete, api_estimated_cost_known=api_known,
                request_coverage=aggregate_request_coverage([turn]))


def aggregate_cost(turns, blocked=False):
    blocked = blocked or any(t.get('usage_attribution_uncertain') for t in turns)
    values = [t['estimated_cost'] for t in turns if t.get('estimated_cost') is not None]
    subtotals = [t.get('estimated_cost_known', t.get('estimated_cost')) for t in turns]
    known = _sum_amount([v for v in subtotals if v is not None])
    bases = {t.get('cost_basis') for t in turns
             if t.get('estimated_cost_known', t.get('estimated_cost')) is not None}
    basis = next(iter(bases)) if len(bases) == 1 else ('mixed' if bases else None)
    recorded = [t['estimated_cost'] for t in turns if t.get('cost_basis') == 'recorded'
                and t.get('estimated_cost') is not None]
    recorded_subtotals = [t.get('estimated_cost_known', t.get('estimated_cost')) for t in turns
                          if t.get('cost_basis') == 'recorded']
    recorded_known = _sum_amount([v for v in recorded_subtotals if v is not None])
    return {
        'request_coverage': aggregate_request_coverage(turns),
        'estimated_cost': known if values and len(values) == len(turns) and not blocked else None,
        'estimated_cost_known': None if blocked else known,
        'observed_estimated_cost_known': known,
        'cost_samples': len(values),
        'cost_basis': basis,
        'recorded_cost': recorded_known if recorded and len(recorded) == len(turns) and not blocked else None,
        'recorded_cost_known': None if blocked else recorded_known,
        'recorded_cost_samples': len(recorded),
    }
