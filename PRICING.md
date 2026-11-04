# api-equivalent estimates

the estimator applies public token rates checked on **2026-11-03** to recorded
usage. this is an estimate of equivalent api token cost, not an actual bill,
subscription spend, remaining allowance, or historical invoice reconstruction.
rates are pinned in `lib/pricing-rates.json`; the daemon makes no pricing api
calls and uses no paid api calls to calculate them.

`estimateRecord(record)` returns `costUSD`, `pricedTokens`, `unpricedTokens`,
`pricingDate`, and `assumptions`. when a record is only partly priceable,
`costUSD` is the known subtotal and `unpricedTokens` identifies the missing
coverage. when nothing can be priced, `costUSD` is `null`. empty usage costs zero.
display the unpriced flag alongside partial totals; never treat it as free usage.

## input contract

- `input` is total input **including** cache reads and every cache-write category.
  the estimator subtracts those categories before charging uncached input.
- `output` already includes any reasoning output tokens. do not add reasoning
  tokens a second time.
- cache categories are `cachedInput`, `cacheWrite5m`, `cacheWrite1h`,
  `cacheWrite30m`, `cacheWrite12h`, and `cacheWriteUnknown`. missing write ttl is
  unpriced, not guessed. use the categories actually recorded by the provider.
- optional `total` must include input and output. any additional unattributed
  tokens remain unpriced. corrupt or contradictory counts are not priced.
- `contextTokens` must be one request's full prompt size, including cache reads
  and writes. it must never be a cumulative session total. missing context size
  uses short-context rates and returns `short_context_assumed` where relevant.

## model and tier coverage

the exact supported identifiers and rates are the keys in
`lib/pricing-rates.json`. coverage includes the documented gpt-6, gpt-6.1 and
gpt-5.6 models; selected older gpt models; the five individually verified
gpt-5/gpt-5.1/gpt-5.2/gpt-5.3 codex variants; and claude models listed in the
current official price page. only explicitly verified dated aliases resolve.
unknown models, including internal ids such as `codex-auto-review`, remain
unpriced. no nearest-model or name-prefix substitution is used.

standard rates are the default. explicit supported `serviceTier` values use
the published tier: `fast`, `ultrafast`, `batch`, or `flex`. openai's former
`priority` name resolves to `fast`. claude's `speed: "fast"` overrides a generic
standard service tier when fast pricing is verified for that model. missing
or unverified tier metadata returns an explicit standard-rate assumption.

long-context price changes apply to the full request, only when explicit
`contextTokens` exceeds the documented threshold. gpt models with two context
tiers use 272,000 tokens. claude haiku 5.5 uses 100,000 tokens. claude 4.6 and
later models other than haiku 5.5 use standard rates across their context window.
an unlisted tier/context combination remains unpriced.

costs exclude regional/data-residency premiums, private discounts, taxes,
tool-call fees, storage, containers, and other non-token charges. current rates
may differ from the rates in effect when an old session ran. gpt-5.6 sol pricing
is promotional at the time these rates were checked; review it after the
provider's stated november 21, 2026 minimum promotional period.

## official sources

- [openai api pricing](https://developers.openai.com/api/docs/pricing), including
  its [complete pricing data](https://developers.openai.com/api/docs/pricing.md):
  standard, fast, ultrafast, batch and flex rates; modern cache-write rates;
  long-context thresholds; priority naming; promotional and regional notes.
- individual legacy codex model price cards:
  [gpt-5.3-codex](https://developers.openai.com/api/docs/models/gpt-5.3-codex),
  [gpt-5.2-codex](https://developers.openai.com/api/docs/models/gpt-5.2-codex),
  [gpt-5.1-codex](https://developers.openai.com/api/docs/models/gpt-5.1-codex),
  [gpt-5.1-codex-max](https://developers.openai.com/api/docs/models/gpt-5.1-codex-max),
  [gpt-5-codex](https://developers.openai.com/api/docs/models/gpt-5-codex).
- [claude pricing](https://platform.claude.com/docs/en/about-claude/pricing):
  per-model input/output/cache rates, fast-mode multipliers, batch discounts,
  and haiku 5.5's request-length threshold.
- [claude model ids](https://platform.claude.com/docs/en/about-claude/models/model-ids-and-versions):
  the two explicitly supported dated aliases, and the distinction between
  pinned model versions and earlier convenience aliases.

to update prices, verify the official pages, update the rate data and
`verifiedAt`, and run `node --test test/pricing.test.js`.
