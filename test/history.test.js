'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { HistoryScanner, summarizeHistory, mergeRecord } = require('../lib/history');
const estimate = (record) => ({ costUSD: record.model ? record.total / 1000 : null, pricedTokens: record.model ? record.total : 0, unpricedTokens: record.model ? 0 : record.total });
const record = (extra = {}) => ({ key: 'response1', provider: 'codex', model: 'known', input: 80, output: 20, total: 100, ...extra });

test('global history de-duplicates copied requests and retains partial pricing coverage', () => {
  const result = summarizeHistory({
    a: { provider: 'codex', records: [record()] },
    b: { provider: 'codex', records: [record(), record({ key: 'response2', model: null })] },
  }, estimate);
  assert.equal(result.providers.codex.total, 200);
  assert.equal(result.providers.codex.requests, 2);
  assert.equal(result.providers.codex.costUSD, 0.1);
  assert.equal(result.providers.codex.unpricedTokens, 100);
});

test('unknown model names cannot alter object prototypes', () => {
  const stats = summarizeHistory({ a: { provider: 'codex', records: [record({ model: '__proto__' })] } }, estimate);
  assert.equal(stats.providers.codex.models.__proto__.total, 100);
  assert.equal(Object.prototype.total, undefined);
});

test('claude copies resolve cache TTL and checkpoint copies do not add to message totals', () => {
  const a = record({ provider: 'claude', usageSource: 'message', scopeKey: 'session1', uncachedInput: 10, cachedInput: 30, cacheWriteTotal: 40, cacheWriteUnknown: 40 });
  const b = { ...a, cacheWrite5m: 40, cacheWriteUnknown: 0 };
  const merged = mergeRecord(a, b);
  assert.equal(merged.cacheWriteUnknown, 0);
  assert.equal(merged.input, 80);
  const stats = summarizeHistory({
    a: { provider: 'claude', records: [a, b] },
    b: { provider: 'claude', records: [record({ provider: 'claude', key: 'checkpoint', usageSource: 'checkpoint', scopeKey: 'session1' })] },
  }, estimate);
  assert.equal(stats.providers.claude.total, 100);
});

test('cache avoids rereads, indexes appended usage, and retains known totals when logs disappear', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dual-history-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'session.jsonl'), cacheFile = path.join(root, 'cache', 'history.json');
  await fs.writeFile(file, 'first');
  let reads = 0, present = true;
  const parsers = { codex: {
    discoverFiles: async () => present ? [file] : [],
    parseFile: async () => { reads++; return { records: [record({ key: reads > 1 ? 'response2' : 'response1' })] }; },
  } };
  const options = { roots: { codex: root, claude: false }, parsers, cacheFile, estimateRecord: estimate };
  const first = new HistoryScanner(options);
  await first.initialize();
  assert.equal((await first.scan()).providers.codex.total, 100);
  const next = new HistoryScanner(options);
  await next.initialize();
  assert.equal((await next.scan()).providers.codex.total, 100);
  assert.equal(reads, 1);
  await fs.appendFile(file, 'second');
  assert.equal((await next.scan()).providers.codex.total, 200);
  present = false;
  assert.equal((await next.scan()).providers.codex.total, 200);
  const contents = await fs.readFile(cacheFile, 'utf8');
  assert.ok(!contents.includes(file));
  assert.ok(!contents.includes('first'));
});

test('failed parser reads are retried without requiring the source file to change', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dual-history-retry-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'session.jsonl');
  await fs.writeFile(file, 'unchanged');
  let reads = 0;
  const scanner = new HistoryScanner({ roots: { codex: root, claude: false }, estimateRecord: estimate,
    parsers: { codex: { discoverFiles: async () => [file], parseFile: async () => ++reads === 1
      ? { records: [], warnings: ['zstd_not_supported:1'], coverage: { incomplete: true } }
      : { records: [record()] } } } });
  await scanner.initialize();
  assert.equal((await scanner.scan()).providers.codex.total, 0);
  assert.equal((await scanner.scan()).providers.codex.total, 100);
  assert.equal(reads, 2);
});
