import test from 'node:test';
import assert from 'node:assert/strict';
import { coverageText, turnCost, turnTokens } from '../src/lib/coverage.ts';

const coverage = {
  scope: 'observed_usage_records',
  total_requests: null,
  usage_ratio: null,
  cost_ratio: null,
  observed_records: 2,
  records_with_usage: 1,
  unknown_usage_records: 1,
  records_with_cost: 1,
  unknown_cost_records: 1,
  unresolved_turns: 0,
  fields: {},
};

test('partial observed records retain subtotals and unknown request coverage', () => {
  const turn = {
    estimated_cost: null,
    estimated_cost_known: 0.02,
    token_total: null,
    token_known: 100,
    request_coverage: coverage,
  };
  assert.match(turnCost(turn), /0\.02.*已知小计/);
  assert.match(turnTokens(turn), /100.*已知小计/);
  assert.match(coverageText(coverage), /请求总数\/覆盖未知/);
  assert.match(coverageText(coverage), /观测记录 2 条 · 缺用量 1 条 · 缺记录费用 1 条/);
});

test('quarantined records and uncertain attribution are labelled without claiming absence', () => {
  const text = coverageText({ ...coverage, unresolved_turns: 1, attribution_uncertain_turns: 1 });
  assert.match(text, /用量观测记录 2 条/);
  assert.match(text, /观测不完整或不可用 1 轮/);
  assert.match(text, /归属不确定 1 轮，观测小计可能重叠/);
  assert.doesNotMatch(text, /无观测记录/);
});

test('zero and old API values survive without coverage', () => {
  assert.match(turnCost({ estimated_cost: null, estimated_cost_known: 0 }), /0.*已知小计/);
  assert.match(turnTokens({ token_total: null, token_known: 0 }), /0.*已知小计/);
  assert.doesNotMatch(turnCost({ estimated_cost: 0 }), /小计/);
  assert.equal(turnTokens({ token_total: 0 }), '0');
  assert.match(coverageText(), /请求总数\/覆盖未知/);
});
