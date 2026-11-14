'use strict';
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { Worker, isMainThread, parentPort, workerData } = require('node:worker_threads');
const { EventEmitter } = require('node:events');
const { dayBounds } = require('./day');

const hash = (value) => crypto.createHash('sha256').update(value).digest('hex');
const retryable = (warnings = []) => warnings.some((warning) => /read_failed|unreadable_file|missing_file|zstd_not_supported/.test(typeof warning === 'string' ? warning : warning.code));
// the cache is split into small shard files by the first hex digits of the
// file key, so a scan only rewrites the shards whose entries changed.
const SHARD_FILE = /^([0-9a-f]{3}|misc)\.json$/;
const shardOf = (key) => /^[0-9a-f]{3}/.test(key) ? key.slice(0, 3) : 'misc';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function writeAtomic(file, text) {
  const temporary = `${file}.${process.pid}.tmp`;
  try {
    const handle = await fs.open(temporary, 'w');
    // flushed before the rename, so a power cut leaves the old file or the
    // whole new one, never a blank one.
    try { await handle.writeFile(text); await handle.sync(); } finally { await handle.close(); }
    // windows can refuse a rename onto a file a virus scanner or another
    // reader still holds for a moment.
    for (let attempt = 0; ; attempt++) {
      try { await fs.rename(temporary, file); break; }
      catch (error) {
        if (attempt === 3 || !['EPERM', 'EBUSY', 'EACCES'].includes(error.code)) throw error;
        await sleep(25 * (attempt + 1));
      }
    }
  } catch (error) { await fs.rm(temporary, { force: true }).catch(() => {}); throw error; }
}
// reads one cache file. undefined: it is not there. null: it is there but
// damaged. throws when it exists and still cannot be read after a few tries,
// which the callers treat as "do not write over this".
async function readCache(file) {
  for (let attempt = 0; ; attempt++) {
    try {
      const value = JSON.parse(await fs.readFile(file, 'utf8'));
      return value && typeof value === 'object' ? value : null;
    } catch (error) {
      if (error.code === 'ENOENT') return undefined;
      if (error instanceof SyntaxError || error.code === 'ERR_STRING_TOO_LONG') return null;
      if (attempt === 2) throw error;
      await sleep(50 * (attempt + 1));
    }
  }
}
const numericFields = ['input', 'uncachedInput', 'output', 'cachedInput', 'cacheWrite', 'cacheWriteTotal', 'cacheWrite5m', 'cacheWrite1h', 'cacheWrite30m', 'cacheWrite12h', 'cacheWriteUnknown', 'total', 'contextTokens'];
function mergeRecord(a, b) {
  if (b.provider === 'claude' || a?.provider === 'claude') return require('./history-claude').mergeRecord(a, b);
  if (!a) return { ...b };
  const merged = { ...a, ...b };
  for (const field of numericFields) if (Number.isFinite(a[field]) || Number.isFinite(b[field])) merged[field] = Math.max(a[field] || 0, b[field] || 0);
  if (a.model && !b.model) merged.model = a.model;
  return merged;
}
function summarizeHistory(files, estimateRecord, updatedAt = Date.now()) {
  const { day, start, end } = dayBounds(updatedAt);
  const unique = new Map(), firstSeen = new Map(), messageScopes = new Set(), aliases = new Set();
  const providers = Object.fromEntries(['codex', 'claude'].map((provider) => [provider, { total: 0, input: 0, output: 0, cachedInput: 0, costUSD: 0, pricedTokens: 0, unpricedTokens: 0, requests: 0, today: { day, total: 0, costUSD: 0, pricedTokens: 0, unpricedTokens: 0, requests: 0 }, incomplete: false, inferred: false, warnings: [], models: Object.create(null) }]));
  for (const file of Object.values(files)) {
    const group = providers[file.provider];
    if (!group) continue;
    if (file.coverage?.incomplete) group.incomplete = true;
    for (const warning of file.warnings || []) {
      const code = typeof warning === 'string' ? warning.split(':')[0] : warning.code;
      if (code === 'history_read_failed' || code === 'history_discovery_failed') group.incomplete = true;
      if (code && !group.warnings.includes(code)) group.warnings.push(code);
    }
    for (const record of file.records || []) {
      if (!record.key || !providers[record.provider]) continue;
      const key = `${record.provider}:${record.key}`;
      unique.set(key, mergeRecord(unique.get(key), record));
      // a fork or subagent log replays its parent's rows with a new timestamp,
      // so the earliest copy says when the tokens were really spent.
      if (record.timestamp > 0) firstSeen.set(key, Math.min(firstSeen.get(key) ?? Infinity, record.timestamp));
      for (const alias of record.aliases || []) {
        if (typeof alias === 'string' && alias !== record.key) aliases.add(`${record.provider}:${alias}`);
      }
      if (record.usageSource === 'message' && record.scopeKey) messageScopes.add(record.scopeKey);
    }
  }
  for (const record of unique.values()) {
    if (aliases.has(`${record.provider}:${record.key}`)) continue;
    for (const alias of record.aliases || []) {
      const equivalent = unique.get(`${record.provider}:${alias}`);
      if (!record.model && equivalent?.model) record.model = equivalent.model;
      if (!record.serviceTier && equivalent?.serviceTier) record.serviceTier = equivalent.serviceTier;
    }
    if (record.usageSource === 'checkpoint' && messageScopes.has(record.scopeKey)) continue;
    const group = providers[record.provider];
    const estimate = estimateRecord(record);
    for (const field of ['total', 'input', 'output', 'cachedInput']) group[field] += Math.max(0, record[field] || 0);
    group.costUSD += estimate.costUSD || 0;
    group.pricedTokens += estimate.pricedTokens || 0;
    group.unpricedTokens += estimate.unpricedTokens || 0;
    group.requests++;
    // a checkpoint is one cumulative total for a whole session, so its
    // timestamp cannot say which day the tokens belong to: lifetime only.
    const spentAt = record.usageSource === 'checkpoint' ? NaN : firstSeen.get(`${record.provider}:${record.key}`);
    if (spentAt >= start && spentAt < end) {
      const today = group.today;
      today.total += Math.max(0, record.total || 0); today.costUSD += estimate.costUSD || 0;
      today.pricedTokens += estimate.pricedTokens || 0; today.unpricedTokens += estimate.unpricedTokens || 0; today.requests++;
    }
    if (record.completeness === 'partial' || record.modelConflict) group.incomplete = true;
    if (record.completeness === 'inferred' || record.usageSource === 'checkpoint') group.inferred = true;
    const model = record.model || 'unknown';
    const row = group.models[model] ||= { total: 0, costUSD: 0, unpricedTokens: 0 };
    row.total += record.total || 0; row.costUSD += estimate.costUSD || 0; row.unpricedTokens += estimate.unpricedTokens || 0;
  }
  for (const group of Object.values(providers)) {
    if (group.total && !group.pricedTokens) group.costUSD = null;
    if (group.today.total && !group.today.pricedTokens) group.today.costUSD = null;
  }
  return { ready: true, updatedAt, basis: 'retained local history; current standard api rates', providers };
}

class HistoryScanner {
  constructor(options = {}) {
    const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
    this.roots = options.roots || { codex: codexHome, claude: process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude') };
    this.parsers = options.parsers;
    this.estimateRecord = options.estimateRecord;
    this.onProgress = options.onProgress || (() => {});
    this.parserVersions = {};
    this.files = {};
    this.scope = hash(JSON.stringify(this.roots));
    // one folder per set of roots, so pointing the app at other roots for a
    // while cannot overwrite the history kept for these ones.
    this.cacheDir = options.cacheDir ? path.join(options.cacheDir, this.scope.slice(0, 16)) : null;
    this.legacyCacheFile = options.legacyCacheFile;
    this.dirty = new Set();
    this.unreadable = new Set();
    this.reloads = 0;
  }
  async initialize() {
    for (const provider of ['codex', 'claude']) this.parserVersions[provider] = hash(await fs.readFile(path.join(__dirname, `history-${provider}.js`)));
    if (this.cacheDir && await this.loadShards()) return;
    await this.loadLegacy();
  }
  // true when the folder holds a complete cache. false means the old single
  // file still has to be looked at: a first run, an import that never
  // finished, a lost index or a damaged shard. shards are loaded either way,
  // because they are never older than what the old file holds.
  async loadShards() {
    let names;
    try { names = (await fs.readdir(this.cacheDir)).sort(); }
    catch (error) {
      // a folder that is there but cannot be listed is not saved over blind.
      if (error.code !== 'ENOENT') this.readOnly = true;
      return false;
    }
    let index = null, complete = true;
    try { index = await readCache(path.join(this.cacheDir, 'index.json')); } catch { /* same as a lost index */ }
    if (index?.version === 2 && index.scope === this.scope) {
      this.scannedAt = Number.isFinite(index.scannedAt) ? index.scannedAt : 0;
      this.indexDay = dayBounds(this.scannedAt).day;
    } else complete = false;
    const shards = names.filter((name) => SHARD_FILE.test(name));
    const loaded = new Array(shards.length);
    let cursor = 0;
    const read = async () => {
      while (cursor < shards.length) {
        const i = cursor++;
        try {
          loaded[i] = await readCache(path.join(this.cacheDir, shards[i]));
          // a damaged shard is refilled from the old file if that is still
          // around, and from local history otherwise, then written again.
          if (loaded[i] === null) { complete = false; this.dirty.add(shards[i].slice(0, -5)); }
        } catch {
          // it exists but cannot be read right now. it may hold counters for
          // logs that are gone, so it is not written over until a later scan
          // manages to read it.
          this.unreadable.add(shards[i].slice(0, -5));
        }
      }
    };
    await Promise.all(Array.from({ length: 16 }, read));
    for (let i = 0; i < shards.length; i++) {
      for (const [key, entry] of Object.entries(loaded[i] || {})) {
        if (entry && typeof entry === 'object' && `${shardOf(key)}.json` === shards[i]) this.files[key] = entry;
      }
    }
    // temp files left by a process that died mid-save.
    const stale = Date.now() - 3600000;
    for (const name of names) {
      if (!name.endsWith('.tmp')) continue;
      const file = path.join(this.cacheDir, name);
      try { if ((await fs.stat(file)).mtimeMs < stale) await fs.rm(file, { force: true }); } catch { /* best effort */ }
    }
    return complete;
  }
  // the single-file cache older versions wrote. it is left where it is and
  // only fills in entries the shards do not have: all of them on the first
  // run, the missing ones after an interrupted import or a damaged shard.
  async loadLegacy(rebuilt = new Set()) {
    if (!this.legacyCacheFile) return;
    let cache;
    try { cache = await readCache(this.legacyCacheFile); }
    catch {
      // it is there but cannot be read right now. saving without it would
      // mark the import as finished, so this run keeps everything in memory.
      this.readOnly = true;
      return;
    }
    if (cache?.version !== 1 || cache.scope !== this.scope || !cache.files || typeof cache.files !== 'object') return;
    for (const [key, entry] of Object.entries(cache.files)) {
      const shard = shardOf(key);
      // an unreadable shard is merged from its own file by a later scan.
      if (!entry || typeof entry !== 'object' || this.unreadable.has(shard)) continue;
      if (!Object.hasOwn(this.files, key)) this.files[key] = entry;
      // memory only has what a scan could reparse for this shard, so the old
      // copy goes underneath. anywhere else the entry came from a shard on
      // disk, which is never older than the old file.
      else if (rebuilt.has(shard)) this.under(key, entry);
      else continue;
      this.dirty.add(shard);
    }
    if (!(this.scannedAt > 0)) this.scannedAt = Number.isFinite(cache.scannedAt) ? cache.scannedAt : 0;
  }
  // a shard that was busy at startup is read again before each scan. what is
  // on disk goes underneath whatever scans have put in memory since.
  async retryUnreadable() {
    const damaged = new Set();
    for (const shard of [...this.unreadable]) {
      let disk;
      try { disk = await readCache(path.join(this.cacheDir, `${shard}.json`)); } catch { continue; }
      if (disk === null) damaged.add(shard);
      for (const [key, entry] of Object.entries(disk || {})) {
        if (entry && typeof entry === 'object' && shardOf(key) === shard) this.under(key, entry);
      }
      this.unreadable.delete(shard);
      this.dirty.add(shard);
    }
    // one that turned out to be damaged gets what the old file still has.
    if (damaged.size) await this.loadLegacy(damaged);
  }
  // puts an older copy of an entry underneath the one in memory, keeping the
  // records the newer one no longer has.
  under(key, entry) {
    const mine = this.files[key];
    // nothing in memory, or only the stub a failed read leaves behind.
    if (!mine?.parserVersion) { this.files[key] = mine ? { ...entry, signature: null, warnings: mine.warnings } : entry; return; }
    // the same rule a scan uses for records an older parser produced.
    if (entry.parserVersion !== mine.parserVersion) return;
    const records = new Map();
    for (const record of [...entry.records || [], ...mine.records || []]) records.set(record.key, mergeRecord(records.get(record.key), record));
    this.files[key] = { ...mine, records: [...records.values()] };
  }
  // read-only means the load at startup could not see everything. nothing is
  // saved in that state, so loading again from scratch is what a restart does.
  async reload() {
    const kept = { files: this.files, dirty: this.dirty, unreadable: this.unreadable, scannedAt: this.scannedAt, indexDay: this.indexDay };
    Object.assign(this, { files: {}, dirty: new Set(), unreadable: new Set(), scannedAt: undefined, indexDay: undefined, readOnly: false });
    if (!(this.cacheDir && await this.loadShards())) await this.loadLegacy();
    // still failing: carry on with what memory had.
    if (this.readOnly) Object.assign(this, kept);
  }
  put(key, entry) {
    if (JSON.stringify(this.files[key]) === JSON.stringify(entry)) return;
    this.files[key] = entry;
    this.dirty.add(shardOf(key));
  }
  drop(key) {
    if (!Object.hasOwn(this.files, key)) return;
    delete this.files[key];
    this.dirty.add(shardOf(key));
  }
  async save(scannedAt) {
    if (!this.cacheDir || this.readOnly) return;
    const day = dayBounds(scannedAt).day;
    const writable = [...this.dirty].filter((shard) => !this.unreadable.has(shard));
    // nothing to write and the index already says today: no disk writes at all.
    if (!writable.length && this.indexDay === day) return;
    try {
      await fs.mkdir(this.cacheDir, { recursive: true });
      const groups = new Map(writable.map((shard) => [shard, {}]));
      for (const key of Object.keys(this.files)) {
        const group = groups.get(shardOf(key));
        if (group) group[key] = this.files[key];
      }
      for (const [shard, entries] of groups) {
        const file = path.join(this.cacheDir, `${shard}.json`);
        try {
          if (Object.keys(entries).length) await writeAtomic(file, JSON.stringify(entries));
          else await fs.rm(file, { force: true });
          this.dirty.delete(shard);
        } catch { /* stays dirty and is retried by the next scan */ }
      }
      // the index only says "the import is finished" and which day the cache
      // is from, so it is written once a day, after every shard got to disk.
      if (this.indexDay !== day && [...this.dirty].every((shard) => this.unreadable.has(shard))) {
        await writeAtomic(path.join(this.cacheDir, 'index.json'), JSON.stringify({ version: 2, scope: this.scope, scannedAt }));
        this.indexDay = day;
      }
    } catch { /* display still works if the optional local cache cannot be saved */ }
  }
  summary() { return summarizeHistory(this.files, this.estimateRecord); }
  // before the first scan the records are only as new as the cache. if that
  // was written before today's local midnight, its empty today bucket would
  // read as "nothing spent today", so leave the bucket out until a scan runs.
  cachedSummary() {
    const summary = this.summary();
    if (!(this.scannedAt >= dayBounds(summary.updatedAt).start)) for (const group of Object.values(summary.providers)) delete group.today;
    return summary;
  }
  async scan() {
    // tried again on scans 1, 2, 4, 8 and so on, so a cache that stays
    // unreadable does not cost a full reload every minute.
    if (this.readOnly && (++this.reloads & (this.reloads - 1)) === 0) await this.reload();
    if (this.unreadable.size) await this.retryUnreadable();
    const jobs = [];
    for (const provider of ['codex', 'claude']) {
      if (this.roots[provider] === false) continue;
      let discovered;
      try { discovered = await this.parsers[provider].discoverFiles(this.roots[provider]); }
      catch { this.put(`discovery:${provider}`, { provider, records: [], warnings: ['history_discovery_failed'] }); continue; }
      this.drop(`discovery:${provider}`);
      for (const entry of discovered) jobs.push({ provider, file: typeof entry === 'string' ? entry : entry.path });
    }
    // the start time, so a scan that straddles midnight counts as yesterday's.
    const startedAt = Date.now();
    let cursor = 0, completed = 0, lastProgress = 0;
    const work = async () => {
      while (cursor < jobs.length) {
        const { provider, file } = jobs[cursor++];
        const key = hash(`${provider}:${file}`);
        try {
          const stat = await fs.stat(file);
          const signature = `${this.parserVersions[provider]}:${stat.size}:${stat.mtimeMs}`;
          if (this.files[key]?.signature === signature && !retryable(this.files[key]?.warnings)) continue;
          const parsed = await this.parsers[provider].parseFile(file);
          const records = new Map();
          const previousRecords = this.files[key]?.parserVersion === this.parserVersions[provider] ? this.files[key].records || [] : [];
          for (const record of [...previousRecords, ...parsed.records || []]) records.set(record.key, mergeRecord(records.get(record.key), record));
          const retry = retryable(parsed.warnings);
          this.put(key, { provider, signature: retry ? null : signature, parserVersion: this.parserVersions[provider], records: [...records.values()], warnings: parsed.warnings || [], coverage: parsed.coverage });
        } catch {
          this.put(key, { ...this.files[key], signature: null, provider, warnings: ['history_read_failed'] });
        } finally {
          completed++;
          if (Date.now() - lastProgress > 2000) { this.onProgress({ completed, total: jobs.length }); lastProgress = Date.now(); }
        }
      }
    };
    await Promise.all([work(), work()]);
    this.scannedAt = startedAt;
    await this.save(startedAt);
    return this.summary();
  }
}

class LifetimeHistory extends EventEmitter {
  constructor(options = {}) { super(); this.options = options; this.value = { ready: false, providers: {} }; }
  start(once = false, cacheOnly = false) {
    if (this.worker) return;
    this.worker = new Worker(__filename, { workerData: { ...this.options, once, cacheOnly } });
    this.worker.on('message', (message) => { this.value = { ...this.value, ...message }; this.emit('update', this.value); });
    this.worker.on('error', () => { this.value = { ...this.value, error: 'history unavailable' }; this.emit('update', this.value); });
    this.worker.on('exit', (code) => { if (code && !this.stopped) { this.value = { ...this.value, error: 'history unavailable' }; this.emit('update', this.value); } });
  }
  async readOnce(cacheOnly = false) {
    return new Promise((resolve, reject) => {
      const receive = (value) => {
        if (value.error) { this.off('update', receive); reject(new Error(value.error)); }
        else if (value.scanned) { this.off('update', receive); resolve(value); }
      };
      this.on('update', receive); this.start(true, cacheOnly);
    });
  }
  close() { this.stopped = true; return this.worker?.terminate(); }
}

if (!isMainThread) {
  (async () => {
    const { estimateRecord, PRICING_DATE, SOURCES } = require('./pricing');
    const scanner = new HistoryScanner({ ...workerData, estimateRecord, onProgress: (progress) => parentPort.postMessage({ progress }), parsers: { codex: require('./history-codex'), claude: require('./history-claude') } });
    await scanner.initialize();
    if (workerData.cacheOnly) {
      parentPort.postMessage(Object.keys(scanner.files).length ? { ...scanner.cachedSummary(), scanned: true } : { ready: false, providers: {}, scanned: true });
      return;
    }
    if (Object.keys(scanner.files).length) parentPort.postMessage({ ...scanner.cachedSummary(), scanning: true });
    const scan = async () => parentPort.postMessage({ ...await scanner.scan(), scanned: true, pricingDate: PRICING_DATE, pricingSources: SOURCES });
    await scan();
    if (!workerData.once) {
      let scanning = false;
      setInterval(async () => { if (scanning) return; scanning = true; try { await scan(); } finally { scanning = false; } }, workerData.refreshMs || 60000);
    }
  })().catch(() => { parentPort.postMessage({ ready: false, error: 'history unavailable', providers: {} }); });
}
module.exports = { LifetimeHistory, HistoryScanner, summarizeHistory, mergeRecord };
