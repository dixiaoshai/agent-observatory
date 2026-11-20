"""Source-recorded costs and current API equivalents, never account billing."""
import math
from datetime import datetime, timezone
from decimal import Decimal

from .usage import aggregate_request_coverage


PRICING = {
    'currency': 'USD',
    'checked_at': '2026-11-20',
    'sources': [
        {'label': 'OpenAI 官方价格',
         'url': 'https://developers.openai.com/api/docs/pricing?latest-pricing-expanded=true'},
        {'label': 'DeepSeek 官方价格',
         'url': 'https://api-docs.deepseek.com/quick_start/pricing/'},
    ],
    'basis': '当前公开 API 列表价估算（OpenAI Standard 短上下文；DeepSeek peak 时段）',
    'assumptions': [
        '按当前公开单价估算历史 Token 的 API 等价费用，不是实际账单或订阅扣费。',
        'OpenAI 模型按 Standard 短上下文费率；轮次聚合无法还原逐请求长上下文加价或实际服务等级。',
        'DeepSeek 模型按请求时间套用 peak / off-peak 价：UTC 周一至周五 01:00–04:00、06:00–10:00 为 peak，'
        '其余时段（含周末）为 off-peak 半价；中国法定节假日未还原，缺少请求时间时按 peak 价上限估算。',
        'DeepSeek 的缓存命中价对应缓存输入、未命中价对应普通输入；未记录缓存写入时按无单独计费写入估算，'
        '已记录写入但缺少 TTL 时无法估算。',
        '普通输入 = 输入 − 缓存输入；推理已包含在输出中，不再相加。不含工具等附加费。',
        '无匹配公开单价或缺少有效分类用量时保留未知；覆盖不完整时仅展示已知小计。',
        'codex-auto-review 没有公开列表价；仅当来源明确标记会话为账号范围（account_scoped=true）且轮次开始时间不早于 '
        '2026-10-06T00:00:00Z 时按免费规则估算（费用 0），其他情况保持未知。该标记来自 Codex 的 creator_account_id，'
        'Codex 对 Agent 身份 / PAT 也可能记录该字段，日志无法区分登录方式；缺少标记表示登录方式未知，不按 API Key 处理。',
        '父子按各会话新增用量合计；分叉历史基线无法确认时保留未知。',
    ],
    # USD per million tokens. Exact model IDs only: no guessed family aliases.
    # DeepSeek entries list the peak rate; off_peak is applied per request time.
    'models': {
        'gpt-6.2-astra': {'input': 8, 'cached_input': .40, 'output': 40},
        'gpt-6.2-sol': {'input': 2, 'cached_input': .10, 'output': 10},
        'gpt-6-astra': {'input': 10, 'cached_input': 1, 'output': 50},
        'gpt-6.1-sol': {'input': 2, 'cached_input': .10, 'output': 10},
        'gpt-6.1-terra': {'input': 1, 'cached_input': .05, 'output': 5},
        'gpt-6-luna': {'input': .10, 'cached_input': .01, 'output': .50},
        'gpt-5.6-sol': {'input': 4, 'cached_input': .40, 'output': 20,
                        'note': '2026-11-30 前促销价'},
        'gpt-5.6-terra': {'input': 2, 'cached_input': .20, 'output': 12},
        'gpt-5.6-luna': {'input': .20, 'cached_input': .02, 'output': 1.20},
        'gpt-5.5': {'input': 5, 'cached_input': .50, 'output': 30, 'note': '低于 272K 上下文的短上下文价'},
        'gpt-5.4': {'input': 2.5, 'cached_input': .25, 'output': 15, 'note': '低于 272K 上下文的短上下文价'},
        'deepseek-flash': {
            'input': .30, 'cached_input': .006, 'output': 1.20,
            'off_peak': {'input': .15, 'cached_input': .003, 'output': .60},
            'note': 'peak 价；off-peak 半价',
        },
        # Official legacy name, still accepted by the provider and billed at the Flash rate.
        'deepseek-v4-flash': {
            'input': .30, 'cached_input': .006, 'output': 1.20,
            'off_peak': {'input': .15, 'cached_input': .003, 'output': .60},
            'note': '旧名；按 deepseek-flash 计价',
        },
        'deepseek-v4-pro': {
            'input': 1.32, 'cached_input': .044, 'output': 3.96,
            'off_peak': {'input': .66, 'cached_input': .022, 'output': 1.98},
            'note': 'peak 价；off-peak 半价',
        },
    },
}


def _amount(value):
    # Keep sub-cent values; round only floating-point transport noise.
    return float(round(value, 12))


def _time(value):
    if not isinstance(value, str):
        return None
    try:
        parsed = datetime.fromisoformat(value.replace('Z', '+00:00'))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        return None
    return parsed.astimezone(timezone.utc)


def _is_off_peak(value):
    """DeepSeek peak window; unknown or missing time keeps the peak (upper bound) rate."""
    moment = _time(value)
    if moment is None:
        return False
    if moment.weekday() >= 5:
        return True
    minutes = moment.hour * 60 + moment.minute
    return not (60 <= minutes < 240 or 360 <= minutes < 600)


def _rates(model, at):
    entry = PRICING['models'].get(model)
    if entry is None:
        return None
    off_peak = entry.get('off_peak')
    if off_peak is not None and _is_off_peak(at):
        return off_peak
    return {key: entry[key] for key in ('input', 'cached_input', 'output')}


def _is_free_waived(turn):
    """Codex auto-review is free for account-scoped sign-ins from the fixed date.

    The archived ``account_scoped`` signal only proves that the source recorded a
    creator account id: Codex also records it for agent identity / PAT use, so it
    cannot confirm a ChatGPT sign-in. Only this narrow, dated rule is waived and
    every other auto-review turn stays unknown.
    """
    if turn.get('model') != 'codex-auto-review' or turn.get('account_scoped') is not True:
        return False
    started = _time(turn.get('started_at'))
    return started is not None and started >= datetime(2026, 10, 6, tzinfo=timezone.utc)


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

    if _is_free_waived(turn):
        result['estimated_cost'] = 0
        result['cost_basis'] = 'free'
        result['cost_source'] = 'free_waiver'
        return result

    rates = _rates(turn.get('model'), turn.get('at') or turn.get('started_at'))
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
        facts = dict(record['usage'], model=record['model'], at=record.get('timestamp'))
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
