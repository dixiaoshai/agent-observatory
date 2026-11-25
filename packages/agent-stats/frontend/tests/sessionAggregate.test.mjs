import test from 'node:test';
import assert from 'node:assert/strict';
import {
  aggregateCostComplete,
  aggregateCostKnown,
  aggregateTokenKnown,
  aggregateTokenSortValue,
  sessionAggregate,
} from '../src/lib/sessionAggregate.ts';

const cache = (overrides = {}) => ({
  cached_input_known: 30,
  uncached_input_known: 70,
  input_known: 100,
  hit_rate: 0.3,
  samples: 1,
  turns: 1,
  complete: true,
  aggregation_blocked: false,
  cache_write_known: null,
  cache_write_samples: 0,
  ...overrides,
});

const session = (overrides = {}) => ({
  id: 'session',
  title: null,
  project: null,
  model: 'model',
  started_at: null,
  status: 'completed',
  token_total: 100,
  token_known: 90,
  token_samples: 1,
  cache_usage: cache(),
  estimated_cost: 0.5,
  estimated_cost_known: 0.4,
  cost_samples: 1,
  turns: 2,
  tools: 3,
  parent_id: null,
  source: 'pi',
  instance: 'default',
  ...overrides,
});

const subtree = (overrides = {}) => ({
  turns: 5,
  tools: 7,
  token_total: 500,
  token_known: 450,
  token_samples: 5,
  cache_usage: cache({ cached_input_known: 200, samples: 5, turns: 5 }),
  estimated_cost: 2.5,
  estimated_cost_known: 2,
  cost_samples: 5,
  aggregation_blocked: false,
  ...overrides,
});

test('falls back to the session own aggregates when subtree is absent', () => {
  const own = session();
  const aggregate = sessionAggregate(own);
  assert.equal(aggregate, own);
  assert.equal(aggregate.turns, 2);
  assert.equal(aggregate.tools, 3);
  assert.equal(aggregate.cache_usage.cached_input_known, 30);
  assert.equal(aggregateTokenKnown(aggregate), 90);
  assert.equal(aggregateCostKnown(aggregate), 0.4);
  assert.equal(aggregateCostComplete(aggregate), 0.5);
  assert.equal(aggregateTokenSortValue(aggregate), 100);
});

test('uses the subtree totals when the backend sends them', () => {
  const aggregate = sessionAggregate(session({ subtree: subtree() }));
  assert.equal(aggregate.turns, 5);
  assert.equal(aggregate.tools, 7);
  assert.equal(aggregate.cache_usage.cached_input_known, 200);
  assert.equal(aggregateTokenKnown(aggregate), 450);
  assert.equal(aggregateCostKnown(aggregate), 2);
  assert.equal(aggregateCostComplete(aggregate), 2.5);
  assert.equal(aggregateTokenSortValue(aggregate), 500);
});

test('selects the observed subtotals when aggregation is blocked', () => {
  const aggregate = sessionAggregate(
    session({
      subtree: subtree({
        aggregation_blocked: true,
        token_total: null,
        token_known: null,
        observed_token_total: 900,
        observed_token_known: 850,
        estimated_cost: null,
        estimated_cost_known: null,
        observed_estimated_cost_known: 2.2,
        cache_usage: cache({ aggregation_blocked: true, complete: false }),
      }),
    }),
  );
  assert.equal(aggregateTokenKnown(aggregate), 850);
  assert.equal(aggregateCostKnown(aggregate), 2.2);
  assert.equal(aggregateCostComplete(aggregate), null);
});

test('keeps blocked observed subtotals unknown when the backend omits them', () => {
  const aggregate = sessionAggregate(
    session({
      subtree: subtree({
        aggregation_blocked: true,
        token_total: null,
        token_known: null,
        estimated_cost: null,
        estimated_cost_known: null,
      }),
    }),
  );
  assert.equal(aggregateTokenKnown(aggregate), null);
  assert.equal(aggregateCostKnown(aggregate), null);
  assert.equal(aggregateCostComplete(aggregate), null);
});

test('returns null for the complete cost when blocked even if a total is present', () => {
  const aggregate = sessionAggregate(
    session({ subtree: subtree({ aggregation_blocked: true, observed_estimated_cost_known: 2.2 }) }),
  );
  assert.equal(aggregateCostComplete(aggregate), null);
});

test('keeps the known cost subtotal when the unblocked total is incomplete', () => {
  const aggregate = sessionAggregate(
    session({ subtree: subtree({ estimated_cost: null, estimated_cost_known: 2 }) }),
  );
  assert.equal(aggregateCostKnown(aggregate), 2);
  assert.equal(aggregateCostComplete(aggregate), null);
});

test('orders token sort values by total, then known, then observed subtotal', () => {
  assert.equal(
    aggregateTokenSortValue({ token_total: 0, token_known: 10, observed_token_known: 20 }),
    0,
  );
  assert.equal(
    aggregateTokenSortValue({ token_total: null, token_known: 10, observed_token_known: 20 }),
    10,
  );
  assert.equal(
    aggregateTokenSortValue({ token_total: null, token_known: null, observed_token_known: 20 }),
    20,
  );
  assert.equal(aggregateTokenSortValue({ token_total: null, token_known: null }), -1);
});
