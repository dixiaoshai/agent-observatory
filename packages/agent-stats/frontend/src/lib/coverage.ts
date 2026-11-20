import type { Metric, RequestCoverage, Turn } from '../types';
import { formatCost, formatNumber } from './format.ts';

export function subtotal(
  complete: Metric,
  known: Metric | undefined,
  format: (n: Metric) => string,
) {
  const value = complete ?? known ?? null;
  return `${format(value)}${complete == null && value != null ? ' · 已知小计' : ''}`;
}

export function turnTokens(turn: Turn) {
  return subtotal(turn.token_total, turn.token_known, formatNumber);
}

export function turnCost(turn: Turn) {
  return subtotal(turn.estimated_cost, turn.estimated_cost_known, formatCost);
}

export function coverageText(coverage?: RequestCoverage) {
  const scope = '请求总数/覆盖未知；用量观测记录不代表完整请求全集';
  if (!coverage) return scope;
  const uncertain = coverage.attribution_uncertain_turns
    ? ` · 归属不确定 ${coverage.attribution_uncertain_turns} 轮，观测小计可能重叠`
    : '';
  return `${scope} · 用量观测记录 ${coverage.observed_records} 条 · 缺用量 ${coverage.unknown_usage_records} 条 · 缺记录费用 ${coverage.unknown_cost_records} 条 · 观测不完整或不可用 ${coverage.unresolved_turns} 轮${uncertain}`;
}
