'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { estimateRecord, resolveModel, PRICING_DATE } = require('../lib/pricing');
const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-10, `${actual} != ${expected}`);

test('prices inclusive input once, including separate modern OpenAI cache writes', () => {
  const result = estimateRecord({ provider: 'codex', model: 'gpt-6-astra', input: 1_000_000, cachedInput: 500_000, cacheWrite30m: 100_000, cacheWrite12h: 100_000, output: 100_000, contextTokens: 100_000, serviceTier: 'standard' });
  near(result.costUSD, 12.25); // 3 uncached + .5 read + 1.25 30m + 2.5 12h + 5 output.
  assert.equal(result.pricedTokens, 1_100_000);
  assert.equal(result.unpricedTokens, 0);
});

test('uses exact rates for gpt-6.1 sol and terra, never a family-wide cached rate', () => {
  near(estimateRecord({ model: 'gpt-6.1-sol', input: 1_000_000, cachedInput: 1_000_000 }).costUSD, .1);
  near(estimateRecord({ model: 'gpt-6.1-terra', input: 1_000_000, cachedInput: 1_000_000 }).costUSD, .05);
  near(estimateRecord({ model: 'gpt-6-sol', input: 1_000_000, cachedInput: 1_000_000 }).costUSD, .2);
});

test('large cumulative usage does not accidentally trigger long-context pricing', () => {
  const result = estimateRecord({ model: 'gpt-5.6-sol', input: 2_000_000, output: 100_000 });
  near(result.costUSD, 10);
  assert.equal(result.context, 'short');
  assert.ok(result.assumptions.includes('short_context_assumed'));
});

test('applies long-context rates to the full request strictly above 272k', () => {
  const request = { model: 'gpt-6-astra', input: 300_000, output: 10_000, contextTokens: 272_000 };
  near(estimateRecord(request).costUSD, 3.5);
  near(estimateRecord({ ...request, contextTokens: 272_001 }).costUSD, 6.75);
});

test('honors known fast, priority, ultrafast, flex and batch rates', () => {
  const request = { model: 'gpt-6-astra', input: 100_000, output: 10_000, contextTokens: 100_000 };
  near(estimateRecord({ ...request, serviceTier: 'fast' }).costUSD, 3);
  near(estimateRecord({ ...request, serviceTier: 'priority' }).costUSD, 3);
  near(estimateRecord({ ...request, serviceTier: 'ultrafast' }).costUSD, 9);
  near(estimateRecord({ ...request, serviceTier: 'flex' }).costUSD, .75);
  near(estimateRecord({ ...request, serviceTier: 'batch' }).costUSD, .75);
  near(estimateRecord({ model: 'gpt-5.5', input: 100_000, output: 10_000, contextTokens: 100_000, serviceTier: 'fast' }).costUSD, 2);
});

test('unknown public tier is explicitly a standard-rate assumption', () => {
  const result = estimateRecord({ model: 'gpt-6.1-terra', input: 1_000_000, serviceTier: 'ultrafast' });
  near(result.costUSD, 1);
  assert.ok(result.assumptions.includes('unverified_tier_standard_assumed'));
});

test('prices Claude cached input and each write TTL separately', () => {
  const result = estimateRecord({ provider: 'claude', model: 'claude-opus-5-5', input: 1_000_000, cachedInput: 500_000, cacheWrite5m: 100_000, cacheWrite1h: 100_000, output: 100_000, serviceTier: 'standard' });
  near(result.costUSD, 4.6); // 1.2 uncached + .1 read + .5 5m + .8 1h + 2 output.
  assert.equal(result.pricedTokens, 1_100_000);
  assert.equal(result.unpricedTokens, 0);
});

test('Claude fast speed overrides generic standard service tier', () => {
  const request = { model: 'claude-opus-5-5', input: 100_000, output: 10_000, serviceTier: 'standard', speed: 'fast' };
  near(estimateRecord(request).costUSD, 1.2);
  assert.equal(estimateRecord(request).tier, 'fast');
});

test('Haiku 5.5 uses its 100k request threshold, other current Claude models do not', () => {
  const request = { model: 'claude-haiku-5-5', input: 100_001, cachedInput: 50_000, output: 10_000 };
  near(estimateRecord({ ...request, contextTokens: 100_000 }).costUSD, .0105001);
  near(estimateRecord({ ...request, contextTokens: 100_001 }).costUSD, .0525005);
  near(estimateRecord({ model: 'claude-opus-4-6', input: 900_000, output: 10_000, contextTokens: 900_000 }).costUSD, 4.75);
});

test('unknown write TTL remains unpriced while all known categories are priced', () => {
  const result = estimateRecord({ model: 'claude-sonnet-5-5', input: 1_000, cachedInput: 400, cacheWriteUnknown: 100, output: 100 });
  near(result.costUSD, .00204);
  assert.equal(result.pricedTokens, 1_000);
  assert.equal(result.unpricedTokens, 100);
  assert.match(result.reason, /cacheWriteUnknown/);
});

test('unsupported cache categories are not silently charged as uncached input', () => {
  const result = estimateRecord({ model: 'gpt-5.3-codex', input: 1_000, cacheWrite30m: 500, output: 100 });
  near(result.costUSD, .002275);
  assert.equal(result.unpricedTokens, 500);
});

test('unknown models and provider mismatches remain completely unpriced', () => {
  for (const model of ['codex-auto-review', 'gpt-6.2-sol', 'gpt-6-astra-something', 'claude-opus-99']) {
    assert.deepEqual(estimateRecord({ model, input: 100, output: 10 }).costUSD, null);
    assert.equal(estimateRecord({ model, input: 100, output: 10 }).unpricedTokens, 110);
  }
  assert.equal(estimateRecord({ provider: 'claude', model: 'gpt-6-astra', input: 100 }).reason, 'unknown_model');
});

test('only explicitly verified dated aliases resolve', () => {
  assert.equal(resolveModel('claude-sonnet-4-5-20250929').canonical, 'claude-sonnet-4-5');
  assert.equal(resolveModel('claude-sonnet-4-5-20990101'), null);
});

test('a total without breakdown and any excess total remain unpriced', () => {
  assert.equal(estimateRecord({ model: 'gpt-6-astra', total: 100 }).costUSD, null);
  const result = estimateRecord({ model: 'gpt-6-astra', input: 100, output: 10, total: 125 });
  assert.equal(result.pricedTokens, 110);
  assert.equal(result.unpricedTokens, 15);
});

test('rejects corrupt counts and inconsistent cache subsets', () => {
  for (const counts of [{ input: -1 }, { input: NaN }, { input: Infinity }, { input: '100' }, { input: 100, cachedInput: 101 }, { input: 100, output: 10, total: 100 }]) {
    assert.equal(estimateRecord({ model: 'gpt-6-astra', ...counts }).reason, 'invalid_token_counts');
  }
});

test('does not invent rates for an unlisted long-context fast tier', () => {
  const result = estimateRecord({ model: 'gpt-5.5', input: 300_000, contextTokens: 300_000, serviceTier: 'fast' });
  assert.equal(result.costUSD, null);
  assert.equal(result.unpricedTokens, 300_000);
  assert.equal(result.reason, 'unverified_context_tier');
});

test('zero usage is zero and results identify the pinned pricing date', () => {
  assert.equal(estimateRecord({}).costUSD, 0);
  assert.equal(estimateRecord({}).unpricedTokens, 0);
  assert.equal(PRICING_DATE, '2026-11-03');
});
