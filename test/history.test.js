'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { HistoryScanner, summarizeHistory, mergeRecord } = require('../lib/history');
const estimate = (record) => ({ costUSD: record.model ? record.total / 1000 : null, pricedTokens: record.model ? record.total : 0, unpricedTokens: record.model ? 0 : record.total });
const record = (extra = {}) => ({ key: 'response1', provider: 'codex', model: 'known', input: 80, output: 20, total: 100, ...extra });
const sha = (value) => require('node:crypto').createHash('sha256').update(value).digest('hex');
const shardName = (file) => `${sha(`codex:${file}`).slice(0, 3)}.json`;
const cacheFiles = async (scanner) => (await fs.readdir(scanner.cacheDir).catch(() => [])).sort();

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
  const file = path.join(root, 'session.jsonl'), cacheDir = path.join(root, 'cache', 'history');
  await fs.writeFile(file, 'first');
  let reads = 0, present = true;
  const parsers = { codex: {
    discoverFiles: async () => present ? [file] : [],
    parseFile: async () => { reads++; return { records: [record({ key: reads > 1 ? 'response2' : 'response1' })] }; },
  } };
  const options = { roots: { codex: root, claude: false }, parsers, cacheDir, estimateRecord: estimate };
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
  const names = await cacheFiles(next);
  assert.deepEqual(names, ['index.json', shardName(file)].sort());
  for (const name of names) {
    const contents = await fs.readFile(path.join(next.cacheDir, name), 'utf8');
    assert.ok(!contents.includes(file));
    assert.ok(!contents.includes('session.jsonl'));
    assert.ok(!contents.includes('first'));
  }
  const reopened = new HistoryScanner(options);
  await reopened.initialize();
  assert.equal(reopened.cachedSummary().providers.codex.total, 200);
  assert.equal(reopened.dirty.size, 0);
});

test('a scan that changes nothing writes nothing, and a change rewrites only its own shard', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dual-history-shards-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const files = Array.from({ length: 6 }, (_, i) => path.join(root, `session-${i}.jsonl`));
  for (const file of files) await fs.writeFile(file, 'first');
  const reads = new Map();
  const parsers = { codex: {
    discoverFiles: async () => files,
    parseFile: async (file) => { reads.set(file, (reads.get(file) || 0) + 1); return { records: [record({ key: `${path.basename(file)}:${reads.get(file)}` })] }; },
  } };
  const scanner = new HistoryScanner({ roots: { codex: root, claude: false }, parsers, cacheDir: path.join(root, 'cache', 'history'), estimateRecord: estimate });
  await scanner.initialize();
  assert.equal((await scanner.scan()).providers.codex.total, 600);
  assert.deepEqual(await cacheFiles(scanner), [...new Set(['index.json', ...files.map(shardName)])].sort());
  await fs.rm(scanner.cacheDir, { recursive: true });
  assert.equal((await scanner.scan()).providers.codex.total, 600);
  assert.deepEqual(await cacheFiles(scanner), []);
  await fs.appendFile(files[0], 'second');
  assert.equal((await scanner.scan()).providers.codex.total, 700);
  // the index is from today already, so only the shard is written.
  assert.deepEqual(await cacheFiles(scanner), [shardName(files[0])]);
  const shard = JSON.parse(await fs.readFile(path.join(scanner.cacheDir, shardName(files[0])), 'utf8'));
  assert.equal(shard[sha(`codex:${files[0]}`)].records.length, 2);
  for (const key of Object.keys(shard)) assert.equal(`${key.slice(0, 3)}.json`, shardName(files[0]));
});

test('a parse that keeps failing the same way does not dirty the cache again', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dual-history-shards-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'session.jsonl');
  await fs.writeFile(file, 'first');
  let reads = 0;
  const parsers = { codex: { discoverFiles: async () => [file], parseFile: async () => { reads++; return { records: [record()], warnings: ['read_failed'] }; } } };
  const scanner = new HistoryScanner({ roots: { codex: root, claude: false }, parsers, cacheDir: path.join(root, 'cache', 'history'), estimateRecord: estimate });
  await scanner.initialize();
  await scanner.scan();
  await fs.rm(scanner.cacheDir, { recursive: true });
  await scanner.scan();
  assert.equal(reads, 2);
  assert.deepEqual(await cacheFiles(scanner), []);
});

test('the old single-file cache is imported once, left in place, and then ignored', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dual-history-legacy-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const legacyCacheFile = path.join(root, 'cache', 'lifetime-v1.json');
  const parsers = { codex: { discoverFiles: async () => [], parseFile: async () => ({ records: [] }) } };
  const options = { roots: { codex: root, claude: false }, parsers, cacheDir: path.join(root, 'cache', 'lifetime-v2'), legacyCacheFile, estimateRecord: estimate };
  const gone = sha('codex:a log that no longer exists');
  const legacy = JSON.stringify({ version: 1, scope: new HistoryScanner(options).scope, scannedAt: Date.now(), files: { [gone]: { provider: 'codex', signature: 'old', records: [record({ timestamp: Date.now() })] } } });
  await fs.mkdir(path.dirname(legacyCacheFile), { recursive: true });
  await fs.writeFile(legacyCacheFile, legacy);
  const first = new HistoryScanner(options);
  await first.initialize();
  assert.equal(first.cachedSummary().providers.codex.total, 100);
  assert.equal(first.cachedSummary().providers.codex.today.total, 100);
  assert.deepEqual(await cacheFiles(first), []);
  assert.equal((await first.scan()).providers.codex.total, 100);
  assert.deepEqual(await cacheFiles(first), ['index.json', `${gone.slice(0, 3)}.json`].sort());
  assert.equal(await fs.readFile(legacyCacheFile, 'utf8'), legacy);
  // an import that died before its index was written picks up where it stopped:
  // shards already on disk are kept, the old file fills in the rest.
  const other = sha('codex:another log that no longer exists');
  const twoLogs = JSON.stringify({ ...JSON.parse(legacy), files: { ...JSON.parse(legacy).files, [other]: { provider: 'codex', signature: 'old', records: [record({ key: 'response2' })] } } });
  await fs.writeFile(legacyCacheFile, twoLogs);
  await fs.rm(path.join(first.cacheDir, 'index.json'));
  const retried = new HistoryScanner(options);
  await retried.initialize();
  assert.equal(retried.cachedSummary().providers.codex.total, 200);
  assert.deepEqual([...retried.dirty], [other.slice(0, 3)]);
  await retried.scan();
  assert.deepEqual(await cacheFiles(retried), [...new Set(['index.json', `${gone.slice(0, 3)}.json`, `${other.slice(0, 3)}.json`])].sort());
  // a damaged shard is refilled from the old file while that is still there.
  await fs.writeFile(path.join(first.cacheDir, `${gone.slice(0, 3)}.json`), '\0\0\0\0');
  const refilled = new HistoryScanner(options);
  await refilled.initialize();
  assert.equal(refilled.cachedSummary().providers.codex.total, 200);
  await refilled.scan();
  assert.equal(Object.hasOwn(JSON.parse(await fs.readFile(path.join(first.cacheDir, `${gone.slice(0, 3)}.json`), 'utf8')), gone), true);
  // once the shards are complete the old file no longer matters.
  await fs.writeFile(legacyCacheFile, JSON.stringify({ ...JSON.parse(legacy), files: {} }));
  const next = new HistoryScanner(options);
  await next.initialize();
  assert.equal(next.cachedSummary().providers.codex.total, 200);
  assert.equal(next.dirty.size, 0);
  const elsewhere = new HistoryScanner({ ...options, roots: { codex: path.join(root, 'elsewhere'), claude: false } });
  await elsewhere.initialize();
  assert.notEqual(elsewhere.cacheDir, next.cacheDir);
  assert.equal(elsewhere.cachedSummary().providers.codex.total, 0);
});

test('a lost or unreadable index never lets the old file replace newer shards', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dual-history-legacy-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const legacyCacheFile = path.join(root, 'cache', 'lifetime-v1.json');
  const parsers = { codex: { discoverFiles: async () => [], parseFile: async () => ({ records: [] }) } };
  const options = { roots: { codex: root, claude: false }, parsers, cacheDir: path.join(root, 'cache', 'lifetime-v2'), legacyCacheFile, estimateRecord: estimate };
  const gone = sha('codex:a log that no longer exists');
  await fs.mkdir(path.dirname(legacyCacheFile), { recursive: true });
  await fs.writeFile(legacyCacheFile, JSON.stringify({ version: 1, scope: new HistoryScanner(options).scope, scannedAt: Date.now(), files: { [gone]: { provider: 'codex', signature: 'old', records: [record()] } } }));
  const first = new HistoryScanner(options);
  await first.initialize();
  await first.scan();
  // the log grew after the import and was deleted later: only the shard knows.
  const shard = path.join(first.cacheDir, `${gone.slice(0, 3)}.json`), index = path.join(first.cacheDir, 'index.json');
  const grown = JSON.stringify({ [gone]: { provider: 'codex', signature: 'newer', records: [record({ total: 500 })] } });
  await fs.writeFile(shard, grown);
  const goodIndex = await fs.readFile(index, 'utf8');
  const readFile = fs.readFile;
  const faults = {
    'zero filled': async () => fs.writeFile(index, '\0'.repeat(goodIndex.length)),
    'empty': async () => fs.writeFile(index, ''),
    'deleted': async () => fs.rm(index),
    'busy': async () => t.mock.method(fs, 'readFile', async (file, ...rest) => {
      if (String(file) === index) throw Object.assign(new Error('busy'), { code: 'EBUSY' });
      return readFile.call(fs, file, ...rest);
    }),
  };
  for (const [name, fault] of Object.entries(faults)) {
    await fs.writeFile(index, goodIndex);
    const mock = await fault();
    const scanner = new HistoryScanner(options);
    await scanner.initialize();
    mock?.mock?.restore();
    assert.equal(scanner.cachedSummary().providers.codex.total, 500, name);
    assert.equal(scanner.dirty.size, 0, name);
    assert.equal((await scanner.scan()).providers.codex.total, 500, name);
    assert.equal(await fs.readFile(shard, 'utf8'), grown, name);
    assert.equal(JSON.parse(await fs.readFile(index, 'utf8')).version, 2, name);
    const healthy = new HistoryScanner(options);
    await healthy.initialize();
    assert.equal(healthy.cachedSummary().providers.codex.total, 500, name);
  }
  // same without the old file: the shards are still loaded.
  await fs.rm(legacyCacheFile);
  await fs.rm(index);
  const alone = new HistoryScanner(options);
  await alone.initialize();
  assert.equal(alone.cachedSummary().providers.codex.total, 500);
  // and a folder that cannot be listed is left exactly as it is.
  const readdir = fs.readdir;
  const blind = t.mock.method(fs, 'readdir', async (dir, ...rest) => {
    if (String(dir) === first.cacheDir) throw Object.assign(new Error('denied'), { code: 'EACCES' });
    return readdir.call(fs, dir, ...rest);
  });
  const locked = new HistoryScanner(options);
  await locked.initialize();
  assert.equal((await locked.scan()).providers.codex.total, 0);
  blind.mock.restore();
  assert.deepEqual(await cacheFiles(locked), [`${gone.slice(0, 3)}.json`]);
  assert.equal(await fs.readFile(shard, 'utf8'), grown);
  // once it can be listed again the same process loads it, no restart needed.
  assert.equal((await locked.scan()).providers.codex.total, 500);
  assert.deepEqual(await cacheFiles(locked), ['index.json', `${gone.slice(0, 3)}.json`].sort());
  assert.equal(await fs.readFile(shard, 'utf8'), grown);
});

test('an old file that cannot be read at import time is imported once it can be', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dual-history-legacy-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'session.jsonl'), legacyCacheFile = path.join(root, 'cache', 'lifetime-v1.json');
  await fs.writeFile(file, 'first');
  const parsers = { codex: { discoverFiles: async () => [file], parseFile: async () => ({ records: [record({ key: 'live' })] }) } };
  const options = { roots: { codex: root, claude: false }, parsers, cacheDir: path.join(root, 'cache', 'lifetime-v2'), legacyCacheFile, estimateRecord: estimate };
  const gone = sha('codex:a log that no longer exists');
  await fs.mkdir(path.dirname(legacyCacheFile), { recursive: true });
  await fs.writeFile(legacyCacheFile, JSON.stringify({ version: 1, scope: new HistoryScanner(options).scope, scannedAt: Date.now(), files: { [gone]: { provider: 'codex', signature: 'old', records: [record()] } } }));
  const readFile = fs.readFile;
  const busy = t.mock.method(fs, 'readFile', async (target, ...rest) => {
    if (String(target) === legacyCacheFile) throw Object.assign(new Error('busy'), { code: 'EBUSY' });
    return readFile.call(fs, target, ...rest);
  });
  const blocked = new HistoryScanner(options);
  await blocked.initialize();
  // still busy: nothing is saved, or the import would count as finished.
  assert.equal((await blocked.scan()).providers.codex.total, 100);
  assert.deepEqual(await cacheFiles(blocked), []);
  // a start that happens in between must not finish the import either.
  const between = new HistoryScanner(options);
  await between.initialize();
  assert.equal(between.readOnly, true);
  busy.mock.restore();
  // readable again: the same process imports it on a later scan.
  assert.equal((await blocked.scan()).providers.codex.total, 200);
  assert.equal(blocked.readOnly, false);
  assert.deepEqual(await cacheFiles(blocked), [...new Set(['index.json', shardName(file), `${gone.slice(0, 3)}.json`])].sort());
  const reopened = new HistoryScanner(options);
  await reopened.initialize();
  assert.equal(reopened.cachedSummary().providers.codex.total, 200);
  assert.equal(reopened.dirty.size, 0);
});

test('a shard whose write fails stays dirty, holds the index back, and is retried', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dual-history-shards-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'session.jsonl'), legacyCacheFile = path.join(root, 'cache', 'lifetime-v1.json');
  let present = false, reads = 0;
  const parsers = { codex: { discoverFiles: async () => present ? [file] : [], parseFile: async () => ({ records: [record({ key: `live${++reads}` })] }) } };
  const options = { roots: { codex: root, claude: false }, parsers, cacheDir: path.join(root, 'cache', 'lifetime-v2'), legacyCacheFile, estimateRecord: estimate };
  const gone = sha('codex:a log that no longer exists'), goneShard = `${gone.slice(0, 3)}.json`;
  await fs.mkdir(path.dirname(legacyCacheFile), { recursive: true });
  await fs.writeFile(legacyCacheFile, JSON.stringify({ version: 1, scope: new HistoryScanner(options).scope, scannedAt: Date.now(), files: { [gone]: { provider: 'codex', signature: 'old', records: [record()] } } }));
  const rename = fs.rename;
  let failing = goneShard;
  const denied = t.mock.method(fs, 'rename', async (from, to) => {
    if (path.basename(String(to)) === failing) throw Object.assign(new Error('denied'), { code: 'EPERM' });
    return rename.call(fs, from, to);
  });
  // first save: the import must not be marked finished while a shard is missing.
  const scanner = new HistoryScanner(options);
  await scanner.initialize();
  await scanner.scan();
  assert.deepEqual(await cacheFiles(scanner), []);
  assert.deepEqual([...scanner.dirty], [goneShard.slice(0, 3)]);
  const again = new HistoryScanner(options);
  await again.initialize();
  assert.equal(again.cachedSummary().providers.codex.total, 100);
  failing = null;
  await scanner.scan();
  assert.deepEqual(await cacheFiles(scanner), ['index.json', goneShard].sort());
  assert.equal(scanner.dirty.size, 0);
  // later saves: the old shard stays whole until the new one can replace it.
  await fs.writeFile(file, 'first');
  present = true;
  await scanner.scan();
  const liveShard = shardName(file), before = await fs.readFile(path.join(scanner.cacheDir, liveShard), 'utf8');
  await fs.appendFile(file, 'second');
  failing = liveShard;
  assert.equal((await scanner.scan()).providers.codex.total, 300);
  assert.equal(await fs.readFile(path.join(scanner.cacheDir, liveShard), 'utf8'), before);
  assert.deepEqual(await cacheFiles(scanner), [...new Set(['index.json', goneShard, liveShard])].sort());
  assert.deepEqual([...scanner.dirty], [liveShard.slice(0, 3)]);
  failing = null;
  await scanner.scan();
  denied.mock.restore();
  assert.equal(scanner.dirty.size, 0);
  const reopened = new HistoryScanner(options);
  await reopened.initialize();
  assert.equal(reopened.cachedSummary().providers.codex.total, 300);
});

test('an emptied shard is removed and entries filed under the wrong shard are ignored', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dual-history-shards-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  let broken = true;
  const parsers = { codex: { discoverFiles: async () => { if (broken) throw new Error('no'); return []; }, parseFile: async () => ({ records: [] }) } };
  const options = { roots: { codex: root, claude: false }, parsers, cacheDir: path.join(root, 'cache', 'history'), estimateRecord: estimate };
  const scanner = new HistoryScanner(options);
  await scanner.initialize();
  await scanner.scan();
  assert.deepEqual(await cacheFiles(scanner), ['index.json', 'misc.json']);
  broken = false;
  await scanner.scan();
  assert.deepEqual(await cacheFiles(scanner), ['index.json']);
  await fs.writeFile(path.join(scanner.cacheDir, '000.json'), JSON.stringify({ [`fff${'0'.repeat(61)}`]: { provider: 'codex', records: [record()] } }));
  const reopened = new HistoryScanner(options);
  await reopened.initialize();
  assert.equal(reopened.cachedSummary().providers.codex.total, 0);
});

test('a corrupt shard is rebuilt, and one that cannot be read is never written over', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dual-history-shards-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const a = path.join(root, 'a.jsonl');
  let b = path.join(root, 'b.jsonl');
  for (let i = 0; shardName(b) === shardName(a); i++) b = path.join(root, `b${i}.jsonl`);
  for (const file of [a, b]) await fs.writeFile(file, 'first');
  const parsers = { codex: { discoverFiles: async () => [a, b], parseFile: async (file) => ({ records: [record({ key: path.basename(file) })] }) } };
  const options = { roots: { codex: root, claude: false }, parsers, cacheDir: path.join(root, 'cache', 'history'), estimateRecord: estimate };
  const first = new HistoryScanner(options);
  await first.initialize();
  await first.scan();
  const shardA = path.join(first.cacheDir, shardName(a));
  await fs.writeFile(shardA, '{"cut off');
  const rebuilt = new HistoryScanner(options);
  await rebuilt.initialize();
  assert.equal(rebuilt.cachedSummary().providers.codex.total, 100);
  assert.equal((await rebuilt.scan()).providers.codex.total, 200);
  // add counters for a log that is gone, then make the shard unreadable for one start.
  const gone = `${shardName(a).slice(0, 3)}${'f'.repeat(61)}`;
  const kept = JSON.stringify({ ...JSON.parse(await fs.readFile(shardA, 'utf8')), [gone]: { provider: 'codex', signature: 'old', records: [record({ key: 'gone' })] } });
  await fs.writeFile(shardA, kept);
  const readFile = fs.readFile;
  const busy = t.mock.method(fs, 'readFile', async (file, ...rest) => {
    if (String(file) === shardA) throw Object.assign(new Error('busy'), { code: 'EBUSY' });
    return readFile.call(fs, file, ...rest);
  });
  const blocked = new HistoryScanner(options);
  await blocked.initialize();
  assert.deepEqual([...blocked.unreadable], [shardName(a).slice(0, 3)]);
  // still busy during a scan: the log is reparsed in memory, the file is left alone.
  assert.equal((await blocked.scan()).providers.codex.total, 200);
  assert.equal(await readFile.call(fs, shardA, 'utf8'), kept);
  assert.deepEqual([...blocked.dirty], [shardName(a).slice(0, 3)]);
  busy.mock.restore();
  // readable again: what is on disk goes underneath memory and the shard is saved.
  assert.equal((await blocked.scan()).providers.codex.total, 300);
  assert.equal(blocked.unreadable.size, 0);
  assert.equal(blocked.dirty.size, 0);
  assert.deepEqual(Object.keys(JSON.parse(await fs.readFile(shardA, 'utf8'))).sort(), [sha(`codex:${a}`), gone].sort());
  const healthy = new HistoryScanner(options);
  await healthy.initialize();
  assert.equal(healthy.cachedSummary().providers.codex.total, 300);
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

const { localDay, dayBounds } = require('../lib/day');
const now = new Date(2026, 10, 14, 15, 30).getTime();
const { start: dayStart, end: dayEnd } = dayBounds(now);
const todayOf = (files, provider = 'codex') => summarizeHistory(files, estimate, now).providers[provider].today;

test('today bucket counts only records inside the local calendar day (start inclusive, end exclusive)', () => {
  const noon = new Date(2026, 10, 14, 12, 0).getTime();
  const files = { a: { provider: 'codex', records: [
    record({ key: 'noon', timestamp: noon }),
    record({ key: 'yesterday', timestamp: dayStart - 1 }),
    record({ key: 'midnight', timestamp: dayStart }),
    record({ key: 'tomorrow', timestamp: dayEnd }),
  ] } };
  const result = summarizeHistory(files, estimate, now);
  assert.equal(result.providers.codex.today.requests, 2);
  assert.equal(result.providers.codex.today.total, 200);
  assert.equal(result.providers.codex.today.costUSD, 0.2);
  assert.equal(result.providers.codex.today.pricedTokens, 200);
  assert.equal(result.providers.codex.total, 400);
  assert.equal(result.providers.codex.today.day, localDay(now));
});

test('records without a usable timestamp count toward lifetime but never today', () => {
  const stats = summarizeHistory({ a: { provider: 'codex', records: [
    record({ key: 'n', timestamp: null }), record({ key: 'z', timestamp: 0 }), record({ key: 'm' }),
  ] } }, estimate, now).providers.codex;
  assert.equal(stats.total, 300);
  assert.equal(stats.today.total, 0);
  assert.equal(stats.today.requests, 0);
  assert.equal(stats.today.costUSD, 0);
});

test('today cost is null when all of todays tokens are unpriced, zero when nothing happened today', () => {
  const files = {
    a: { provider: 'codex', records: [record({ key: 'u', model: null, timestamp: now - 1000 })] },
    b: { provider: 'claude', records: [record({ provider: 'claude', key: 'old', timestamp: dayStart - 5000 })] },
  };
  assert.equal(todayOf(files, 'codex').costUSD, null);
  assert.equal(todayOf(files, 'codex').unpricedTokens, 100);
  assert.equal(todayOf(files, 'claude').costUSD, 0);
  assert.equal(todayOf(files, 'claude').total, 0);
});

test('checkpoint records superseded by messages are not counted today and providers bucket independently', () => {
  const files = {
    a: { provider: 'claude', records: [record({ provider: 'claude', key: 'msg', usageSource: 'message', scopeKey: 's1', uncachedInput: 10, cachedInput: 30, cacheWriteTotal: 40, cacheWriteUnknown: 40, timestamp: now - 1000 })] },
    b: { provider: 'claude', records: [record({ provider: 'claude', key: 'cp', usageSource: 'checkpoint', scopeKey: 's1', uncachedInput: 10, cachedInput: 30, cacheWriteTotal: 40, cacheWriteUnknown: 40, timestamp: now - 2000 })] },
    c: { provider: 'codex', records: [record({ key: 'cx', total: 50, timestamp: now - 3000 })] },
  };
  assert.equal(todayOf(files, 'claude').total, 100);
  assert.equal(todayOf(files, 'claude').requests, 1);
  assert.equal(todayOf(files, 'codex').total, 50);
  assert.equal(todayOf(files, 'codex').requests, 1);
});

test('day helpers format local days with padding and bound the day', () => {
  const ms = new Date(2026, 0, 5, 9, 3).getTime();
  assert.equal(localDay(ms), '2026-01-05');
  const { day, start, end } = dayBounds(ms);
  assert.equal(day, '2026-01-05');
  assert.ok(start <= ms && ms < end);
  assert.ok(Math.abs(end - start - 86400000) <= 3600000);
});

test('usage replayed by a fork counts on the day of its earliest copy', () => {
  const old = dayStart - 3 * 86400000;
  const parent = { provider: 'codex', records: [record({ key: 'k1', timestamp: old }), record({ key: 'k2', timestamp: old + 1000 })] };
  const fork = { provider: 'codex', records: [record({ key: 'k1', timestamp: now - 1000 }), record({ key: 'k2', timestamp: now - 1000 }), record({ key: 'k3', timestamp: now - 500 })] };
  for (const files of [{ a: parent, b: fork }, { a: fork, b: parent }]) {
    const stats = summarizeHistory(files, estimate, now).providers.codex;
    assert.equal(stats.requests, 3);
    assert.equal(stats.total, 300);
    assert.equal(stats.today.requests, 1);
    assert.equal(stats.today.total, 100);
    assert.equal(stats.today.costUSD, 0.1);
  }
  const copiedToday = { a: { provider: 'codex', records: [record({ key: 'k1', timestamp: now - 9000 })] }, b: { provider: 'codex', records: [record({ key: 'k1', timestamp: now - 1000 })] } };
  assert.equal(todayOf(copiedToday).requests, 1);
});

test('a checkpoint-only session counts toward lifetime but not today', () => {
  const files = { a: { provider: 'claude', records: [record({ provider: 'claude', key: 'cp', usageSource: 'checkpoint', scopeKey: 'lonely', uncachedInput: 10, cachedInput: 30, cacheWriteTotal: 40, cacheWriteUnknown: 40, timestamp: now - 1000 })] } };
  const stats = summarizeHistory(files, estimate, now).providers.claude;
  assert.equal(stats.total, 100);
  assert.equal(stats.requests, 1);
  assert.equal(stats.today.total, 0);
  assert.equal(stats.today.requests, 0);
  assert.equal(stats.today.costUSD, 0);
});

test('a cache written before today leaves the today bucket out until a scan runs', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dual-history-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'session.jsonl');
  await fs.writeFile(file, 'first');
  const parsers = { codex: { discoverFiles: async () => [file], parseFile: async () => ({ records: [record({ timestamp: Date.now() })] }) } };
  const options = { roots: { codex: root, claude: false }, parsers, cacheDir: path.join(root, 'cache', 'history'), estimateRecord: estimate };
  const first = new HistoryScanner(options);
  await first.initialize();
  assert.equal(first.cachedSummary().providers.codex.today, undefined);
  assert.equal(typeof (await first.scan()).providers.codex.today, 'object');
  assert.equal(typeof first.cachedSummary().providers.codex.today, 'object');
  const sameDay = new HistoryScanner(options);
  await sameDay.initialize();
  assert.equal(typeof sameDay.cachedSummary().providers.codex.today, 'object');
  assert.equal(sameDay.cachedSummary().providers.codex.total, 100);
  const index = path.join(first.cacheDir, 'index.json');
  const cache = JSON.parse(await fs.readFile(index, 'utf8'));
  for (const scannedAt of [dayBounds(Date.now()).start - 1, undefined]) {
    await fs.writeFile(index, JSON.stringify({ ...cache, scannedAt }));
    const stale = new HistoryScanner(options);
    await stale.initialize();
    const summary = stale.cachedSummary();
    assert.equal(summary.providers.codex.today, undefined);
    assert.equal(summary.providers.claude.today, undefined);
    assert.equal(summary.providers.codex.total, 100);
  }
});

const noLogs = { codex: { discoverFiles: async () => [], parseFile: async () => ({ records: [] }) } };
const withOldFile = async (t, parsers = noLogs) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dual-history-extra-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const legacyCacheFile = path.join(root, 'cache', 'lifetime-v1.json');
  const options = { roots: { codex: root, claude: false }, parsers, cacheDir: path.join(root, 'cache', 'lifetime-v2'), legacyCacheFile, estimateRecord: estimate };
  await fs.mkdir(path.dirname(legacyCacheFile), { recursive: true });
  return { root, options, legacyCacheFile, scope: new HistoryScanner(options).scope };
};
const busyOn = (t, target, times = Infinity) => {
  const readFile = fs.readFile;
  let left = times;
  return t.mock.method(fs, 'readFile', async (file, ...rest) => {
    if (String(file) === target && left-- > 0) throw Object.assign(new Error('busy'), { code: 'EBUSY' });
    return readFile.call(fs, file, ...rest);
  });
};
const goneLog = sha('codex:a log that no longer exists');

test('with a lost index and a busy shard, the old file does not get underneath a newer shard entry', async (t) => {
  const { options, legacyCacheFile, scope } = await withOldFile(t);
  await fs.writeFile(legacyCacheFile, JSON.stringify({ version: 1, scope, files: { [goneLog]: { provider: 'codex', signature: 'old', parserVersion: 'parser-at-import', records: [record()] } } }));
  const first = new HistoryScanner(options);
  await first.initialize();
  await first.scan();
  const shard = path.join(first.cacheDir, `${goneLog.slice(0, 3)}.json`);
  // the log grew under a newer parser after the import and was deleted later.
  await fs.writeFile(shard, JSON.stringify({ [goneLog]: { provider: 'codex', signature: 'newer', parserVersion: 'parser-after-update', records: [record({ total: 500 })] } }));
  await fs.rm(path.join(first.cacheDir, 'index.json'));
  const busy = busyOn(t, shard);
  const scanner = new HistoryScanner(options);
  await scanner.initialize();
  assert.deepEqual([...scanner.unreadable], [goneLog.slice(0, 3)]);
  busy.mock.restore();
  assert.equal((await scanner.scan()).providers.codex.total, 500);
  assert.equal(JSON.parse(await fs.readFile(shard, 'utf8'))[goneLog].records[0].total, 500);
});

test('an old file written for other roots is not imported', async (t) => {
  const { options, legacyCacheFile } = await withOldFile(t);
  await fs.writeFile(legacyCacheFile, JSON.stringify({ version: 1, scope: 'f'.repeat(64), files: { [goneLog]: { provider: 'codex', signature: 'old', records: [record()] } } }));
  const scanner = new HistoryScanner(options);
  await scanner.initialize();
  assert.equal((await scanner.scan()).providers.codex.total, 0);
  assert.deepEqual(await cacheFiles(scanner), ['index.json']);
});

test('once the import is finished the old file is not even opened', async (t) => {
  const { options, legacyCacheFile, scope } = await withOldFile(t);
  await fs.writeFile(legacyCacheFile, JSON.stringify({ version: 1, scope, files: { [goneLog]: { provider: 'codex', signature: 'old', records: [record()] } } }));
  const first = new HistoryScanner(options);
  await first.initialize();
  await first.scan();
  await fs.writeFile(legacyCacheFile, JSON.stringify({ version: 1, scope, files: { [sha('codex:only in the old file')]: { provider: 'codex', signature: 'old', records: [record({ key: 'extra' })] } } }));
  const readFile = fs.readFile;
  let opened = 0;
  const spy = t.mock.method(fs, 'readFile', async (file, ...rest) => { if (String(file) === legacyCacheFile) opened++; return readFile.call(fs, file, ...rest); });
  const next = new HistoryScanner(options);
  await next.initialize();
  spy.mock.restore();
  assert.equal(opened, 0);
  assert.equal(next.cachedSummary().providers.codex.total, 100);
});

test('a shard that was busy at startup keeps records the live log no longer has', async (t) => {
  let file;
  const parsers = { codex: { discoverFiles: async () => [file], parseFile: async () => ({ records: [record({ key: 'still in the log' })] }) } };
  const { root, options } = await withOldFile(t, parsers);
  file = path.join(root, 'session.jsonl');
  await fs.writeFile(file, 'first');
  const first = new HistoryScanner(options);
  await first.initialize();
  await first.scan();
  const key = sha(`codex:${file}`), shard = path.join(first.cacheDir, shardName(file));
  const disk = JSON.parse(await fs.readFile(shard, 'utf8'));
  disk[key].records.push(record({ key: 'compacted away' }));
  await fs.writeFile(shard, JSON.stringify(disk));
  await fs.appendFile(file, 'second');
  const busy = busyOn(t, shard);
  const scanner = new HistoryScanner(options);
  await scanner.initialize();
  assert.equal((await scanner.scan()).providers.codex.total, 100);
  busy.mock.restore();
  assert.equal((await scanner.scan()).providers.codex.total, 200);
  assert.equal(JSON.parse(await fs.readFile(shard, 'utf8'))[key].records.length, 2);
});

test('a shard that was busy at startup and turns out damaged is refilled from the old file', async (t) => {
  const { options, legacyCacheFile, scope } = await withOldFile(t);
  await fs.writeFile(legacyCacheFile, JSON.stringify({ version: 1, scope, files: { [goneLog]: { provider: 'codex', signature: 'old', records: [record()] } } }));
  const first = new HistoryScanner(options);
  await first.initialize();
  await first.scan();
  const shard = path.join(first.cacheDir, `${goneLog.slice(0, 3)}.json`);
  await fs.writeFile(shard, '\0\0\0\0');
  const busy = busyOn(t, shard);
  const scanner = new HistoryScanner(options);
  await scanner.initialize();
  assert.deepEqual([...scanner.unreadable], [goneLog.slice(0, 3)]);
  busy.mock.restore();
  assert.equal((await scanner.scan()).providers.codex.total, 100);
  assert.equal(Object.hasOwn(JSON.parse(await fs.readFile(shard, 'utf8')), goneLog), true);
});

test('a damaged shard found after scans already ran still gets the old file underneath', async (t) => {
  let file;
  const parsers = { codex: { discoverFiles: async () => [file], parseFile: async () => ({ records: [record({ key: 'still in the log' })] }) } };
  const { root, options, legacyCacheFile, scope } = await withOldFile(t, parsers);
  file = path.join(root, 'session.jsonl');
  await fs.writeFile(file, 'first');
  const probe = new HistoryScanner(options);
  await probe.initialize();
  const key = sha(`codex:${file}`);
  await fs.writeFile(legacyCacheFile, JSON.stringify({ version: 1, scope, files: { [key]: { provider: 'codex', signature: 'old', parserVersion: probe.parserVersions.codex, records: [record({ key: 'compacted away' })] } } }));
  const first = new HistoryScanner(options);
  await first.initialize();
  assert.equal((await first.scan()).providers.codex.total, 200);
  const shard = path.join(first.cacheDir, shardName(file));
  await fs.writeFile(shard, '\0\0\0\0');
  const busy = busyOn(t, shard);
  const scanner = new HistoryScanner(options);
  await scanner.initialize();
  // the log is reparsed while the shard is still busy, so memory has only what the log holds.
  assert.equal((await scanner.scan()).providers.codex.total, 100);
  busy.mock.restore();
  assert.equal((await scanner.scan()).providers.codex.total, 200);
  assert.equal(JSON.parse(await fs.readFile(shard, 'utf8'))[key].records.length, 2);
});

test('the index is written again on a new local day, even when no shard changed', async (t) => {
  const { options } = await withOldFile(t);
  const day = 86400000, start = new Date(2026, 10, 14, 12, 0).getTime();
  t.mock.timers.enable({ apis: ['Date'], now: start });
  const scanner = new HistoryScanner(options);
  await scanner.initialize();
  await scanner.scan();
  const index = path.join(scanner.cacheDir, 'index.json');
  assert.equal(JSON.parse(await fs.readFile(index, 'utf8')).scannedAt, start);
  t.mock.timers.setTime(start + 3600000);
  await scanner.scan();
  assert.equal(JSON.parse(await fs.readFile(index, 'utf8')).scannedAt, start);
  t.mock.timers.setTime(start + day);
  await scanner.scan();
  assert.equal(JSON.parse(await fs.readFile(index, 'utf8')).scannedAt, start + day);
  const reopened = new HistoryScanner(options);
  await reopened.initialize();
  t.mock.timers.setTime(start + 2 * day);
  await reopened.scan();
  assert.equal(JSON.parse(await fs.readFile(index, 'utf8')).scannedAt, start + 2 * day);
});

test('a shard that is busy for one read is still loaded', async (t) => {
  const { options, legacyCacheFile, scope } = await withOldFile(t);
  await fs.writeFile(legacyCacheFile, JSON.stringify({ version: 1, scope, files: { [goneLog]: { provider: 'codex', signature: 'old', records: [record()] } } }));
  const first = new HistoryScanner(options);
  await first.initialize();
  await first.scan();
  await fs.rm(legacyCacheFile);
  const busy = busyOn(t, path.join(first.cacheDir, `${goneLog.slice(0, 3)}.json`), 1);
  const scanner = new HistoryScanner(options);
  await scanner.initialize();
  busy.mock.restore();
  assert.equal(scanner.unreadable.size, 0);
  assert.equal(scanner.cachedSummary().providers.codex.total, 100);
});

test('the worker passes the cache folder and the old file on to its scanner', async (t) => {
  const { LifetimeHistory } = require('../lib/history');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dual-history-worker-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const roots = { codex: path.join(root, 'codex'), claude: path.join(root, 'claude') };
  const cacheDir = path.join(root, 'cache', 'lifetime-v2'), legacyCacheFile = path.join(root, 'cache', 'lifetime-v1.json');
  const scope = new HistoryScanner({ roots }).scope;
  await fs.mkdir(path.dirname(legacyCacheFile), { recursive: true });
  await fs.writeFile(legacyCacheFile, JSON.stringify({ version: 1, scope, scannedAt: Date.now(), files: { [goneLog]: { provider: 'codex', signature: 'old', records: [record({ model: 'gpt-5' })] } } }));
  const history = new LifetimeHistory({ roots, cacheDir, legacyCacheFile });
  const value = await history.readOnce();
  await history.close();
  assert.equal(value.providers.codex.total, 100);
  assert.deepEqual((await fs.readdir(path.join(cacheDir, scope.slice(0, 16)))).sort(), ['index.json', `${goneLog.slice(0, 3)}.json`].sort());
});
