'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { DEFAULTS } = require('../lib/config');
const { buildActivity, summarize, asset } = require('../lib/dual-presence');

const NOW = Date.parse('2026-11-03T20:00:00Z');
function config(overrides = {}) {
  return { ...DEFAULTS, ...overrides, providers: { ...DEFAULTS.providers, ...overrides.providers },
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
    assert.equal(result.assets.large_image, `https://example.com/assets/${provider}-${status}.gif?v=1`);
    assert.equal(Boolean(result.timestamps), status !== 'idle');
  }
});

test('combined mode uses dual art and rotate mode alternates providers', () => {
  const sessions = [session('codex'), session('claude', { status: 'thinking' })];
  const combined = buildActivity(sessions, config({ displayMode: 'combined' }), NOW);
  assert.match(combined.assets.large_image, /both-working\.gif/);
  const first = buildActivity(sessions, config({ displayMode: 'rotate' }), NOW);
  const second = buildActivity(sessions, config({ displayMode: 'rotate' }), NOW + 20000);
  assert.notEqual(first.assets.large_image, second.assets.large_image);
  assert.match(first.state, /codex 1\.2k · claude 1\.2k/);
  assert.equal(first.state, second.state);
});

test('combined art follows activity and does not rotate its timer every twenty seconds', () => {
  for (const status of ['working', 'thinking', 'waiting', 'idle']) {
    const sessions = [session('codex', { status }), session('claude', { status })];
    const cfg = config({ displayMode: 'combined', showWhenIdle: true });
    const first = buildActivity(sessions, cfg, NOW);
    const second = buildActivity(sessions, cfg, NOW + 20000);
    assert.match(first.assets.large_image, new RegExp(`both-${status}\\.gif`));
    assert.deepEqual(first.timestamps, second.timestamps);
  }
  const absent = buildActivity([], config({ showWhenIdle: true }), NOW);
  assert.match(absent.assets.large_image, /both-idle\.gif/);
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
  assert.match(stale.details, /codex: idle/);
  assert.match(stale.assets.small_image, /action-idle/);
});

test('finished remains visible briefly before clearing the presence', () => {
  const completed = session('codex', { action: 'done', status: 'idle', actionAt: NOW - 1000 });
  const result = buildActivity([completed], config(), NOW);
  assert.match(result.details, /codex: finished/);
  assert.match(result.assets.small_image, /action-done/);
  assert.equal(result.timestamps, undefined);
  assert.equal(buildActivity([completed], config(), NOW + 21000), null);
});
