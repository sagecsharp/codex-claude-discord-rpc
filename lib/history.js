'use strict';
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { Worker, isMainThread, parentPort, workerData } = require('node:worker_threads');
const { EventEmitter } = require('node:events');

const hash = (value) => crypto.createHash('sha256').update(value).digest('hex');
const retryable = (warnings = []) => warnings.some((warning) => /read_failed|unreadable_file|missing_file|zstd_not_supported/.test(typeof warning === 'string' ? warning : warning.code));
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
  const unique = new Map(), messageScopes = new Set(), aliases = new Set();
  const providers = Object.fromEntries(['codex', 'claude'].map((provider) => [provider, { total: 0, input: 0, output: 0, cachedInput: 0, costUSD: 0, pricedTokens: 0, unpricedTokens: 0, requests: 0, incomplete: false, inferred: false, warnings: [], models: Object.create(null) }]));
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
    if (record.completeness === 'partial' || record.modelConflict) group.incomplete = true;
    if (record.completeness === 'inferred' || record.usageSource === 'checkpoint') group.inferred = true;
    const model = record.model || 'unknown';
    const row = group.models[model] ||= { total: 0, costUSD: 0, unpricedTokens: 0 };
    row.total += record.total || 0; row.costUSD += estimate.costUSD || 0; row.unpricedTokens += estimate.unpricedTokens || 0;
  }
  for (const group of Object.values(providers)) if (group.total && !group.pricedTokens) group.costUSD = null;
  return { ready: true, updatedAt, basis: 'retained local history; current standard api rates', providers };
}

class HistoryScanner {
  constructor(options = {}) {
    const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
    this.roots = options.roots || { codex: codexHome, claude: process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude') };
    this.cacheFile = options.cacheFile;
    this.parsers = options.parsers;
    this.estimateRecord = options.estimateRecord;
    this.onProgress = options.onProgress || (() => {});
    this.parserVersions = {};
    this.files = {};
    this.scope = hash(JSON.stringify(this.roots));
  }
  async initialize() {
    for (const provider of ['codex', 'claude']) this.parserVersions[provider] = hash(await fs.readFile(path.join(__dirname, `history-${provider}.js`)));
    if (!this.cacheFile) return;
    try {
      const cache = JSON.parse(await fs.readFile(this.cacheFile, 'utf8'));
      if (cache.version === 1 && cache.scope === this.scope && cache.files && typeof cache.files === 'object') this.files = cache.files;
    } catch { /* missing/corrupt caches are rebuilt from local history */ }
  }
  summary() { return summarizeHistory(this.files, this.estimateRecord); }
  async scan() {
    const jobs = [];
    for (const provider of ['codex', 'claude']) {
      if (this.roots[provider] === false) continue;
      let discovered;
      try { discovered = await this.parsers[provider].discoverFiles(this.roots[provider]); }
      catch { this.files[`discovery:${provider}`] = { provider, records: [], warnings: ['history_discovery_failed'] }; continue; }
      delete this.files[`discovery:${provider}`];
      for (const entry of discovered) jobs.push({ provider, file: typeof entry === 'string' ? entry : entry.path });
    }
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
          this.files[key] = { provider, signature: retry ? null : signature, parserVersion: this.parserVersions[provider], records: [...records.values()], warnings: parsed.warnings || [], coverage: parsed.coverage };
        } catch {
          this.files[key] = { ...this.files[key], signature: null, provider, warnings: ['history_read_failed'] };
        } finally {
          completed++;
          if (Date.now() - lastProgress > 2000) { this.onProgress({ completed, total: jobs.length }); lastProgress = Date.now(); }
        }
      }
    };
    await Promise.all([work(), work()]);
    if (this.cacheFile) {
      try {
        await fs.mkdir(path.dirname(this.cacheFile), { recursive: true });
        const temporary = `${this.cacheFile}.${process.pid}.tmp`;
        await fs.writeFile(temporary, JSON.stringify({ version: 1, scope: this.scope, files: this.files }));
        await fs.rename(temporary, this.cacheFile);
      } catch { /* display still works if the optional local cache cannot be saved */ }
    }
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
      parentPort.postMessage(Object.keys(scanner.files).length ? { ...scanner.summary(), scanned: true } : { ready: false, providers: {}, scanned: true });
      return;
    }
    if (Object.keys(scanner.files).length) parentPort.postMessage({ ...scanner.summary(), scanning: true });
    const scan = async () => parentPort.postMessage({ ...await scanner.scan(), scanned: true, pricingDate: PRICING_DATE, pricingSources: SOURCES });
    await scan();
    if (!workerData.once) {
      let scanning = false;
      setInterval(async () => { if (scanning) return; scanning = true; try { await scan(); } finally { scanning = false; } }, workerData.refreshMs || 60000);
    }
  })().catch(() => { parentPort.postMessage({ ready: false, error: 'history unavailable', providers: {} }); });
}
module.exports = { LifetimeHistory, HistoryScanner, summarizeHistory, mergeRecord };
