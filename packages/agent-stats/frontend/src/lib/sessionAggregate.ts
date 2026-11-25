import type { CacheUsage, Metric, RequestCoverage, Session } from '../types';

/**
 * Session-table fields shared by a session and its subtree aggregate, so one set
 * of helpers can render both regardless of backend version.
 */
export type SessionAggregate = {
  turns: number;
  tools: number;
  token_total: Metric;
  token_known: Metric;
  token_samples: number;
  cache_usage: CacheUsage;
  estimated_cost: Metric;
  estimated_cost_known: Metric;
  cost_samples: number;
  cost_basis?: Session['cost_basis'];
  request_coverage?: RequestCoverage;
  observed_token_total?: Metric;
  observed_token_known?: Metric;
  observed_estimated_cost_known?: Metric;
  aggregation_blocked?: boolean;
};

/**
 * Whole-subtree totals when the backend sends them; older backends only carry
 * the session's own aggregates, so fall back to the session itself.
 */
export function sessionAggregate(session: Session): SessionAggregate {
  return session.subtree ?? session;
}

/**
 * Token known subtotal. Blocked aggregation means parent/child usage may
 * overlap, so only the observed (un-deduplicated) subtotal is available.
 */
export function aggregateTokenKnown(aggregate: SessionAggregate): Metric {
  return aggregate.aggregation_blocked
    ? (aggregate.observed_token_known ?? null)
    : aggregate.token_known;
}

/** Cost known subtotal, mirroring `aggregateTokenKnown`. */
export function aggregateCostKnown(aggregate: SessionAggregate): Metric {
  return aggregate.aggregation_blocked
    ? (aggregate.observed_estimated_cost_known ?? null)
    : aggregate.estimated_cost_known;
}

/** Complete cost total only when aggregation is not blocked. */
export function aggregateCostComplete(aggregate: SessionAggregate): Metric {
  return aggregate.aggregation_blocked ? null : aggregate.estimated_cost;
}

/** Sort key: complete total first, then known subtotals, unknown last. */
export function aggregateTokenSortValue(aggregate: SessionAggregate): number {
  return aggregate.token_total ?? aggregate.token_known ?? aggregate.observed_token_known ?? -1;
}
