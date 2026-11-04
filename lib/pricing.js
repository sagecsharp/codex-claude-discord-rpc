'use strict';

const data = require('./pricing-rates.json');
const PRICING_DATE = data.verifiedAt;
const MILLION = 1_000_000;
const COUNT_FIELDS = ['input', 'output', 'cachedInput', 'cacheWrite5m', 'cacheWrite1h', 'cacheWrite30m', 'cacheWrite12h', 'cacheWriteUnknown'];
const CACHE_FIELDS = COUNT_FIELDS.slice(2);
const validCount = value => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const providerName = value => ({ openai: 'codex', anthropic: 'claude' }[value] || value);

function resolveModel(model, provider) {
  const requested = typeof model === 'string' ? model.trim().toLowerCase() : '';
  const canonical = data.aliases[requested] || requested;
  const found = Object.hasOwn(data.models, canonical) ? data.models[canonical] : null;
  if (!found || (provider && providerName(provider) !== found.provider)) return null;
  return { canonical, ...found };
}

function tierFor(record, model, assumptions) {
  let tier = typeof record.serviceTier === 'string' ? record.serviceTier.toLowerCase().trim() : '';
  const speed = typeof record.speed === 'string' ? record.speed.toLowerCase().trim() : '';
  if ((!tier || ['standard', 'default', 'auto'].includes(tier)) && speed && speed !== 'standard') tier = speed;
  if (model.provider === 'codex' && tier === 'priority') tier = 'fast';
  if (!tier || tier === 'auto') assumptions.push('standard_tier_assumed');
  if (!tier || ['standard', 'default', 'auto'].includes(tier)) return 'standard';
  if (Object.hasOwn(model.rates, tier)) return tier;
  // A log's internal tier is not necessarily a public API billing tier.
  assumptions.push('unverified_tier_standard_assumed');
  return 'standard';
}

/**
 * Current public API-equivalent token estimate, never an actual bill.
 * `input` INCLUDES cache reads and all cache writes. `contextTokens` is the
 * prompt size of this one request; it must never be a cumulative token count.
 * A partial result's costUSD is only the priced-token subtotal. Unknown model,
 * token category, or write TTL stays unpriced rather than borrowing a rate.
 */
function estimateRecord(record = {}) {
  if (!record || typeof record !== 'object') record = {};
  const counts = {};
  let invalid = false;
  for (const field of COUNT_FIELDS) {
    const value = record[field];
    if (value !== undefined && value !== null && !validCount(value)) invalid = true;
    counts[field] = validCount(value) ? value : 0;
  }
  if (record.total !== undefined && record.total !== null && !validCount(record.total)) invalid = true;
  const cacheTotal = CACHE_FIELDS.reduce((sum, field) => sum + counts[field], 0);
  const breakdownTotal = counts.input + counts.output;
  const total = Math.max(validCount(record.total) ? record.total : 0, breakdownTotal, cacheTotal + counts.output);
  const base = { costUSD: null, pricedTokens: 0, unpricedTokens: total, pricingDate: PRICING_DATE, assumptions: [] };
  if (invalid || !Number.isSafeInteger(total) || cacheTotal > counts.input || (validCount(record.total) && record.total < breakdownTotal)) {
    return { ...base, reason: 'invalid_token_counts' };
  }
  if (total === 0) return { ...base, costUSD: 0, unpricedTokens: 0 };
  const model = resolveModel(record.model, record.provider);
  if (!model) return { ...base, reason: 'unknown_model' };
  const assumptions = base.assumptions;
  const tier = tierFor(record, model, assumptions);
  let context = 'short';
  if (model.contextThreshold) {
    if (validCount(record.contextTokens)) {
      if (record.contextTokens > model.contextThreshold) context = 'long';
    } else assumptions.push('short_context_assumed');
  }
  const rates = model.rates[tier]?.[context];
  if (!rates) return { ...base, reason: 'unverified_context_tier', model: model.canonical, tier };
  const categories = { input: counts.input - cacheTotal, output: counts.output };
  for (const field of CACHE_FIELDS) categories[field] = counts[field];
  let subtotal = 0;
  let pricedTokens = 0;
  const missing = [];
  for (const [field, tokens] of Object.entries(categories)) {
    if (!tokens) continue;
    const price = rates[field];
    if (typeof price !== 'number' || !Number.isFinite(price) || price < 0) {
      missing.push(field);
      continue;
    }
    subtotal += tokens * price;
    pricedTokens += tokens;
  }
  const unpricedTokens = total - pricedTokens;
  if (total > breakdownTotal) missing.push('unclassifiedTokens');
  return {
    ...base,
    costUSD: pricedTokens ? subtotal / MILLION : null,
    pricedTokens,
    unpricedTokens,
    model: model.canonical,
    tier,
    context,
    source: data.sources[model.source],
    ...(missing.length ? { reason: `unpriced_categories:${missing.join(',')}` } : {}),
  };
}

module.exports = {
  estimateRecord,
  resolveModel,
  PRICING_DATE,
  SOURCES: Object.freeze({ ...data.sources }),
  KNOWN_MODELS: Object.freeze(Object.keys(data.models)),
};
