'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const zlib = require('node:zlib');

const FIELDS = ['input', 'output', 'cachedInput', 'cacheWrite'];
const hash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const signature = usage => FIELDS.map(field => usage[field]).join(':');
const equal = (a, b) => a && b && signature(a) === signature(b);
const RELEVANT_TYPES = new Set(['session_meta', 'turn_context', 'token_usage_record', 'event_msg']);
function prefixedType(buffer) {
  const prefix = buffer.subarray(0, 4096).toString('utf8');
  return prefix.match(/^\s*\{\s*(?:"(?:timestamp|ordinal)"\s*:\s*(?:"(?:[^"\\]|\\.)*"|\d+)\s*,\s*)*"type"\s*:\s*"([^"\\]+)"/)?.[1];
}

// Codex input already includes cached tokens; output includes reasoning tokens.
function normalizeUsage(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const keys = ['input_tokens', 'output_tokens', 'cached_input_tokens', 'cache_write_input_tokens'];
  if (keys.some(key => raw[key] !== undefined && (!Number.isFinite(raw[key]) || raw[key] < 0))) return null;
  const input = raw.input_tokens || 0, output = raw.output_tokens || 0;
  if (!input && !output) return null; // token-count estimates can contain only a context-size total.
  if (raw.total_tokens !== undefined && raw.total_tokens !== input + output) return null;
  const cachedInput = raw.cached_input_tokens || 0, cacheWrite = raw.cache_write_input_tokens || 0;
  if (cachedInput + cacheWrite > input) return null;
  return { input, output, cachedInput, cacheWrite, total: input + output };
}

function difference(a, b) {
  const result = {};
  for (const field of FIELDS) {
    result[field] = a[field] - b[field];
    if (result[field] < 0) return null;
  }
  result.total = result.input + result.output;
  if (result.cachedInput + result.cacheWrite > result.input) return null;
  return result;
}

async function discoverFiles(root = process.env.CODEX_HOME || path.join(os.homedir(), '.codex')) {
  if (root && typeof root === 'object') root = root.root || process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
  const result = [];
  async function walk(directory) {
    let entries;
    try { entries = await fs.promises.readdir(directory, { withFileTypes: true }); }
    catch (error) { if (['ENOENT', 'ENOTDIR'].includes(error.code)) return; throw error; }
    for (const entry of entries) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(file);
      else if (entry.isFile() && /\.jsonl(?:\.zst)?$/.test(entry.name)) {
        try {
          const stat = await fs.promises.stat(file);
          result.push({ path: file, size: stat.size, mtimeMs: stat.mtimeMs });
        } catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
    }
  }
  await walk(path.join(root, 'sessions'));
  await walk(path.join(root, 'archived_sessions'));
  return result.sort((a, b) => a.path.localeCompare(b.path));
}

class HistoryParser {
  constructor(file) {
    this.sessionId = path.basename(file).replace(/\.jsonl(?:\.zst)?$/, '');
    this.forked = false;
    this.turnId = null;
    this.model = null;
    this.serviceTier = null;
    this.models = new Map();
    this.records = new Map();
    this.explicitAliases = new Set();
    this.previous = null;
    this.warnings = new Map();
  }

  warn(code) { this.warnings.set(code, (this.warnings.get(code) || 0) + 1); }

  legacyKey(turnId, usage) {
    return `codex:legacy:${hash([turnId || `session:${this.sessionId}`, signature(usage)])}`;
  }

  makeRecord(key, usage, row, options = {}) {
    if (!usage || usage.total <= 0) return;
    const turnId = options.turnId || this.turnId;
    const model = options.unknownModel ? null : options.model ||
      (turnId && this.models.get(turnId)?.model) || (turnId === this.turnId ? this.model : null);
    const record = {
      key, provider: 'codex', model: model || null,
      input: usage.input, output: usage.output, cachedInput: usage.cachedInput,
      cacheWrite: usage.cacheWrite, cacheWriteUnknown: usage.cacheWrite,
      uncachedInput: usage.input - usage.cachedInput - usage.cacheWrite,
      total: usage.total,
      timestamp: Number.isFinite(Date.parse(row.timestamp)) ? Date.parse(row.timestamp) : null,
      completeness: options.completeness || 'inferred',
      _turnId: turnId, _unknownModel: options.unknownModel || false,
    };
    if (options.perCall) record.contextTokens = usage.input;
    const tier = options.serviceTier || this.models.get(turnId)?.serviceTier || this.serviceTier;
    if (tier) record.serviceTier = tier;
    if (options.alias) record.aliases = [options.alias];
    const existing = this.records.get(key);
    if (!existing || record.total > existing.total || (!existing.model && record.model)) this.records.set(key, record);
  }

  legacy(row, totalRaw, lastRaw, suppliedTurnId) {
    const total = normalizeUsage(totalRaw);
    if (!total) {
      if (totalRaw && (totalRaw.input_tokens || totalRaw.output_tokens)) this.warn('invalid_cumulative_usage');
      return;
    }
    const previous = this.previous;
    this.previous = total;
    if (equal(previous, total)) return;
    const turnId = suppliedTurnId || this.turnId;
    const last = normalizeUsage(lastRaw);
    if (this.forked && !turnId) {
      this.warn(last ? 'fork_usage_without_turn_id' : 'inherited_usage_baseline');
      return;
    }
    const key = this.legacyKey(turnId, total);
    if (this.records.has(key)) return;
    const delta = previous ? difference(total, previous) : total;
    if (!delta) {
      this.warn('cumulative_usage_reset');
      if (last) this.makeRecord(`${key}:reset:${hash(row.timestamp)}`, last, row,
        { turnId, perCall: true, completeness: 'partial' });
      return;
    }
    if (!previous && this.forked && !last) { this.warn('inherited_usage_baseline'); return; }
    if (last && equal(delta, last)) {
      this.makeRecord(key, last, row, { turnId, perCall: true });
      return;
    }
    if (last) {
      const gap = difference(delta, last);
      if (gap) {
        this.makeRecord(key, last, row, { turnId, perCall: true });
        if (gap.total > 0) {
          if (!previous && this.forked) this.warn('inherited_usage_baseline');
          else {
            this.warn('usage_gap_without_model');
            this.makeRecord(`${key}:gap`, gap, row, { turnId, unknownModel: true });
          }
        }
        return;
      }
    }
    this.warn('usage_delta_without_request');
    this.makeRecord(key, delta, row, { turnId, unknownModel: true });
  }

  accept(row) {
    if (!row || typeof row !== 'object' || !row.payload || typeof row.payload !== 'object') return;
    const payload = row.payload;
    if (row.type === 'session_meta') {
      this.sessionId = payload.id || payload.session_id || this.sessionId;
      this.forked = !!(payload.forked_from_id || payload.parent_thread_id || payload.thread_source === 'subagent');
    } else if (row.type === 'turn_context') {
      if (typeof payload.turn_id === 'string') this.turnId = payload.turn_id;
      this.model = typeof payload.model === 'string' ? payload.model : null;
      this.serviceTier = typeof payload.service_tier === 'string' ? payload.service_tier : null;
      if (this.turnId) this.models.set(this.turnId, { model: this.model, serviceTier: this.serviceTier });
    } else if (row.type === 'event_msg' && payload.type === 'task_started') {
      if (typeof payload.turn_id === 'string' && this.turnId !== payload.turn_id) {
        this.turnId = payload.turn_id;
        this.model = this.models.get(this.turnId)?.model || null;
        this.serviceTier = this.models.get(this.turnId)?.serviceTier || null;
      }
    } else if (row.type === 'token_usage_record') {
      const usage = normalizeUsage(payload.usage);
      const total = normalizeUsage(payload.thread_token_usage);
      const turnId = typeof payload.turn_id === 'string' ? payload.turn_id : this.turnId;
      if (!usage) {
        if (payload.usage && (payload.usage.input_tokens || payload.usage.output_tokens)) this.warn('invalid_request_usage');
        return;
      }
      const alias = total ? this.legacyKey(turnId, total) : null;
      const responseId = payload.response_id || payload.request_id;
      const key = responseId ? `codex:response:${responseId}` :
        `codex:request:${hash([turnId || payload.thread_id || this.sessionId,
          total ? signature(total) : row.timestamp, signature(usage)])}`;
      if (!responseId) this.warn('request_without_response_id');
      if (alias) this.explicitAliases.add(alias);
      this.makeRecord(key, usage, row, {
        turnId, model: payload.model, serviceTier: payload.service_tier,
        perCall: true, completeness: 'complete', alias,
      });
      if (total) this.previous = total;
    } else if (row.type === 'event_msg' && payload.type === 'token_count') {
      this.legacy(row, payload.info?.total_token_usage, payload.info?.last_token_usage);
    }
  }

  finish() {
    const records = [];
    for (const [key, record] of this.records) {
      if (key.startsWith('codex:legacy:') && this.explicitAliases.has(key)) continue;
      if (!record.model && !record._unknownModel && record._turnId) record.model = this.models.get(record._turnId)?.model || null;
      if (!record.model) { record.pricingIncomplete = true; this.warn('usage_without_model'); }
      delete record._turnId;
      delete record._unknownModel;
      records.push(record);
    }
    const incompleteCodes = new Set(['zstd_not_supported', 'malformed_json', 'oversized_line',
      'compressed_history_read_failed', 'history_read_failed', 'invalid_cumulative_usage',
      'invalid_request_usage', 'fork_usage_without_turn_id', 'cumulative_usage_reset']);
    return { records, warnings: [...this.warnings].map(([code, count]) => `${code}:${count}`),
      coverage: { incomplete: [...this.warnings.keys()].some(code => incompleteCodes.has(code)) } };
  }
}

async function parseFile(file, options = {}) {
  if (file && typeof file === 'object') file = file.path;
  const parser = new HistoryParser(file);
  const maxLineBytes = options.maxLineBytes || 8 * 1024 * 1024;
  if (file.endsWith('.zst') && typeof zlib.createZstdDecompress !== 'function') {
    parser.warn('zstd_not_supported');
    return parser.finish();
  }
  const source = fs.createReadStream(file, { highWaterMark: 64 * 1024 });
  const stream = file.endsWith('.zst') ? source.pipe(zlib.createZstdDecompress({ chunkSize: 64 * 1024 })) : source;
  if (stream !== source) source.on('error', error => stream.destroy(error));
  let parts = [], pendingBytes = 0, skipping = false, ignoring = false;
  function line(buffer) {
    if (!buffer.length) return;
    // Standard rollouts put timestamp/ordinal/type before the payload. Avoid
    // parsing large message or image payloads when this prefix is unambiguous.
    const type = prefixedType(buffer);
    if (type && !RELEVANT_TYPES.has(type)) return;
    try { parser.accept(JSON.parse(buffer.toString('utf8'))); }
    catch { parser.warn('malformed_json'); }
  }
  function collect(segment) {
    if (skipping || ignoring || !segment.length) return;
    if (pendingBytes < 4096) {
      const prefix = pendingBytes ? Buffer.concat([...parts, segment.subarray(0, 4096 - pendingBytes)],
        Math.min(4096, pendingBytes + segment.length)) : segment;
      const type = prefixedType(prefix);
      if (type && !RELEVANT_TYPES.has(type)) { ignoring = true; parts = []; pendingBytes = 0; return; }
    }
    if (pendingBytes + segment.length > maxLineBytes) {
      skipping = true; parts = []; pendingBytes = 0; parser.warn('oversized_line');
    } else { parts.push(segment); pendingBytes += segment.length; }
  }
  function flush() {
    if (!skipping && !ignoring && pendingBytes) line(parts.length === 1 ? parts[0] : Buffer.concat(parts, pendingBytes));
    parts = []; pendingBytes = 0; skipping = false; ignoring = false;
  }
  try {
    for await (const chunk of stream) {
      let start = 0;
      for (let end = chunk.indexOf(10); end !== -1; end = chunk.indexOf(10, start)) {
        collect(chunk.subarray(start, end));
        flush();
        start = end + 1;
      }
      collect(chunk.subarray(start));
    }
    // A valid final JSON object is usable even before its trailing newline lands.
    flush();
  } catch (error) {
    parser.warn(file.endsWith('.zst') ? 'compressed_history_read_failed' : 'history_read_failed');
  } finally {
    source.destroy();
    if (stream !== source) stream.destroy();
  }
  return parser.finish();
}

module.exports = { discoverFiles, parseFile, normalizeUsage };
