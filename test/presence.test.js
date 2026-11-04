'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { DEFAULTS } = require('../lib/config');
const { buildActivity, summarize, asset } = require('../lib/dual-presence');

const NOW = Date.parse('2026-11-03T20:00:00Z');
function config(overrides = {}) {
  return { ...DEFAULTS, showWhenIdle: false, ...overrides, providers: { ...DEFAULTS.providers, ...overrides.providers },
    images: { ...DEFAULTS.images, baseUrl: 'https://example.com/assets', ...overrides.images } };
}
function session(provider, extra = {}) {
  return { provider, sessionId: provider, status: 'working', updatedAt: NOW - 1000, startedAt: NOW - 30000,
    tokens: { total: 1234 }, hasUsage: true, model: `${provider}-model`, ...extra };
}

test('active provider takes the large image while both usage totals remain visible', () => {
  const result = buildActivity([session('codex'), session('claude', { status: 'idle', tokens: { total: 5600 } })], config(), NOW);
  assert.match(result.assets.large_image, /codex-working\.gif/);
  assert.match(result.assets.small_image, /action-working\.gif/);
  assert.match(result.state, /codex 1\.2k/);
  assert.match(result.state, /claude 5\.6k/);
  assert.match(result.details, /codex: working · claude: idle/);
});

test('disabled providers are excluded from images and totals', () => {
  const result = buildActivity([session('codex'), session('claude')], config({ providers: { claude: false } }), NOW);
  assert.match(result.details, /^codex: working/);
  assert.doesNotMatch(result.state, /claude/);
  assert.match(result.assets.small_image, /action-working\.gif/);
});

test('each provider status maps to a matching asset', () => {
  for (const provider of ['codex', 'claude']) for (const status of ['working', 'thinking', 'waiting', 'idle']) {
    const result = buildActivity([session(provider, { status })], config({ showWhenIdle: true }), NOW);
    assert.equal(result.assets.large_image, `https://example.com/assets/${status === 'idle' ? 'both' : provider}-${status}.gif?v=1`);
    assert.equal(Boolean(result.timestamps), status !== 'idle');
  }
});

test('parallel providers use stable split art and the earliest start in every display mode', () => {
  const sessions = [session('codex', { startedAt: NOW - 90000 }), session('claude', { status: 'thinking', startedAt: NOW - 30000 })];
  for (const displayMode of ['auto', 'combined', 'rotate']) {
    const cfg = config({ displayMode });
    const first = buildActivity(sessions, cfg, NOW);
    const second = buildActivity(sessions, cfg, NOW + 20000);
    assert.match(first.assets.large_image, /split-working-thinking\.gif/);
    assert.equal(first.assets.large_image, second.assets.large_image);
    assert.match(first.state, /codex 1\.2k · claude 1\.2k/);
    assert.equal(first.state, second.state);
    assert.deepEqual(first.timestamps, { start: NOW - 90000 });
    assert.deepEqual(first.timestamps, second.timestamps);
  }
});

test('all nine active status pairs use codex-left claude-right split variants', () => {
  for (const codexStatus of ['working', 'thinking', 'waiting']) {
    for (const claudeStatus of ['working', 'thinking', 'waiting']) {
      const sessions = [session('claude', { status: claudeStatus }), session('codex', { status: codexStatus })];
      const result = buildActivity(sessions, config(), NOW);
      assert.match(result.assets.large_image, new RegExp(`split-${codexStatus}-${claudeStatus}\\.gif`));
      assert.match(result.assets.large_text, /codex: .+ \| claude: .+/);
    }
  }
  const absent = buildActivity([], config({ showWhenIdle: true }), NOW);
  assert.match(absent.assets.large_image, /both-idle\.gif/);
});

test('split art is not selected for idle stale finished or disabled providers', () => {
  for (const inactive of [
    { status: 'idle' },
    { stale: true },
    { updatedAt: NOW - 121000 },
    { status: 'idle', action: 'done', actionAt: NOW - 1000 },
  ]) {
    for (const activeProvider of ['codex', 'claude']) {
      const other = activeProvider === 'codex' ? 'claude' : 'codex';
      const sessions = [session(activeProvider), session(other, inactive)];
      for (const at of [NOW, NOW + 10000]) {
        const result = buildActivity(sessions, config(), at);
        assert.match(result.assets.large_image, new RegExp(`${activeProvider}-working\\.gif`));
        assert.doesNotMatch(result.assets.large_image, /split-/);
      }
    }
  }
  for (const disabled of ['codex', 'claude']) {
    const result = buildActivity([session('codex'), session('claude')], config({ providers: { [disabled]: false } }), NOW);
    assert.doesNotMatch(result.assets.large_image, /split-/);
    assert.doesNotMatch(result.details, new RegExp(disabled));
  }
});

test('parallel art preserves static and portal fallbacks with both action labels', () => {
  const sessions = [session('codex', { action: 'testing' }), session('claude', { status: 'waiting' })];
  const still = buildActivity(sessions, config({ images: { animated: false } }), NOW);
  assert.match(still.assets.large_image, /split-working-waiting\.png/);
  assert.equal(still.assets.large_text, 'codex: running tests | claude: waiting for you');
  const portal = buildActivity(sessions, config({ images: { portal: true } }), NOW);
  assert.equal(portal.assets.large_image, 'split_working_waiting');
});

test('minimal privacy excludes cwd, titles, prompts, files, and tool arguments', () => {
  const result = buildActivity([session('codex', {
    cwd: 'c:/secret/client-project', title: 'private title', prompt: 'private prompt',
    file: 'credentials.txt', toolArguments: 'private args',
  })], config(), NOW);
  for (const value of ['secret', 'client-project', 'private title', 'private prompt', 'credentials.txt', 'private args']) {
    assert.ok(!JSON.stringify(result).includes(value));
  }
});

test('project privacy includes only the basename and hideProjects masks matches', () => {
  const sessions = [session('claude', { cwd: 'c:\\private\\client-project' })];
  const visible = buildActivity(sessions, config({ privacy: 'project' }), NOW);
  assert.match(visible.details, /client-project$/);
  assert.doesNotMatch(visible.details, /private/);
  const hidden = buildActivity(sessions, config({ privacy: 'project', hideProjects: ['client-*'] }), NOW);
  assert.doesNotMatch(hidden.details, /client-project/);
});

test('stale activity cannot remain busy and expired history disappears', () => {
  const sessions = [session('codex', { updatedAt: NOW - 121000 })];
  assert.equal(buildActivity(sessions, config(), NOW), null);
  const idle = buildActivity(sessions, config({ showWhenIdle: true }), NOW);
  assert.match(idle.details, /idle/);
  assert.equal(idle.timestamps, undefined);
  assert.deepEqual(summarize([session('codex', { updatedAt: NOW - 600001 })], NOW), []);
  assert.equal(buildActivity([], config(), NOW), null);
});

test('unknown usage is pending rather than zero; partial totals stay lower bounds', () => {
  const unknown = session('codex', { tokens: { total: 0 }, hasUsage: false });
  const pending = buildActivity([unknown], config(), NOW);
  assert.equal(pending.state, 'codex usage pending');
  assert.doesNotMatch(pending.state, /codex [≥]?0/);
  const partial = buildActivity([session('claude', { tokens: { total: 1255 }, usageComplete: false })], config(), NOW);
  assert.match(partial.state, /claude ≥1\.2k/);
  const zero = buildActivity([session('codex', { tokens: { total: 0 }, hasUsage: true })], config(), NOW);
  assert.match(zero.state, /codex 0 tokens/);
});

test('duplicate sessions use the latest snapshot without double counting', () => {
  const older = session('codex', { updatedAt: NOW - 5000, tokens: { total: 100 } });
  const newer = session('codex', { tokens: { total: 200 } });
  const other = session('codex', { sessionId: 'second', tokens: { total: 300 } });
  const [group] = summarize([older, newer, other], NOW);
  assert.equal(group.total, 500);
  assert.equal(group.count, 2);
});

test('timestamps are integer milliseconds, normalized and clamped to the present', () => {
  for (const start of [(NOW - 30000) / 1000, NOW - 30000, new Date(NOW - 30000).toISOString()]) {
    const result = buildActivity([session('codex', { startedAt: start })], config(), NOW);
    assert.deepEqual(result.timestamps, { start: NOW - 30000 });
  }
  const futureStart = buildActivity([session('codex', { startedAt: NOW + 1000 })], config(), NOW);
  assert.equal(futureStart.timestamps.start, NOW);
  assert.deepEqual(summarize([session('codex', { updatedAt: NOW + 60001 })], NOW), []);
});

test('static assets, portal keys, text only and hidden token totals remain usable', () => {
  assert.equal(asset('claude-thinking', config({ images: { animated: false } })), 'https://example.com/assets/claude-thinking.png?v=1');
  assert.equal(asset('codex-working', config({ images: { portal: true } })), 'codex_working');
  const result = buildActivity([session('codex')], config({ images: { baseUrl: '' }, showTokens: false }), NOW);
  assert.equal(result.assets, undefined);
  assert.equal(result.state, '1 recent session');
});

test('specific actions lead the card and select a matching visual badge', () => {
  const result = buildActivity([session('codex', { action: 'testing' }), session('claude', { action: 'editing' })], config(), NOW);
  assert.equal(result.details, 'codex: running tests · claude: editing files');
  assert.equal(result.status_display_type, 2);
  assert.match(result.assets.small_image, /action-(?:testing|editing)\.gif/);
  assert.match(result.state, /codex 1\.2k · claude 1\.2k/);
});

test('untrusted action labels and stale actions cannot leak or mislead', () => {
  const unknown = buildActivity([session('codex', { action: 'private command', actionLabel: 'secret prompt' })], config(), NOW);
  assert.match(unknown.details, /codex: working/);
  assert.doesNotMatch(JSON.stringify(unknown), /private command|secret prompt/);
  const stale = buildActivity([session('codex', { action: 'testing', stale: true })], config({ showWhenIdle: true }), NOW);
  assert.match(stale.details, /idle/);
  assert.match(stale.assets.large_image, /both-idle/);
  assert.equal(stale.assets.small_image, undefined);
});

test('finished remains visible briefly before clearing the presence', () => {
  const completed = session('codex', { action: 'done', status: 'idle', actionAt: NOW - 1000 });
  const result = buildActivity([completed], config(), NOW);
  assert.match(result.details, /codex: finished/);
  assert.match(result.assets.small_image, /action-done/);
  assert.equal(result.timestamps, undefined);
  assert.equal(buildActivity([completed], config(), NOW + 21000), null);
});

test('idle shows lifetime totals and prices for both providers using paired logos', () => {
  const history = { ready: true, providers: {
    codex: { total: 28400000, costUSD: 51.38, unpricedTokens: 0 },
    claude: { total: 16700000, costUSD: 79.24, unpricedTokens: 0 },
  } };
  const cfg = config({ showWhenIdle: true });
  const idle = buildActivity([session('codex', { status: 'idle' })], cfg, NOW, history);
  assert.equal(idle.details, 'all-time tokens · codex 28.4m · claude 16.7m');
  assert.equal(idle.state, 'api est. · codex $51.38 · claude $79.24');
  assert.match(idle.assets.large_image, /both-idle/);
  assert.equal(idle.assets.small_image, undefined);
  assert.equal(idle.timestamps, undefined);
  assert.doesNotMatch(idle.details, /1\.2k/);
  history.providers.codex.unpricedTokens = 10;
  history.providers.claude.costUSD = null;
  const partial = buildActivity([], cfg, NOW, history);
  assert.equal(partial.state, 'api est. · codex $51.38 + unpriced · claude unpriced');
  assert.equal(buildActivity([], cfg, NOW).state, 'counting local history');
  assert.equal(buildActivity([], config({ showWhenIdle: true, showTokens: false }), NOW, history).state, 'ready when you are');
  assert.doesNotMatch(buildActivity([], config({ showWhenIdle: true, providers: { claude: false } }), NOW, history).details, /claude/);
});

test('idle is enabled by default and completed actions transition to all-time totals', () => {
  assert.equal(DEFAULTS.showWhenIdle, true);
  const result = buildActivity([session('codex', { status: 'idle', action: 'done', actionAt: NOW - 30000 })], config({ showWhenIdle: true }), NOW);
  assert.equal(result.state, 'counting local history');
});
