'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const MAX_LINE_BYTES = 16 * 1024 * 1024;
const COUNTERS = ['uncachedInput', 'output', 'cachedInput', 'cacheWriteTotal', 'cacheWrite5m', 'cacheWrite1h'];
const number = (value) => Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
const identifier = (value) => typeof value === 'string' && /^[a-z0-9._:+/-]{1,200}$/i.test(value) ? value : null;
function timestamp(value) {
  const numeric = typeof value === 'number' || (typeof value === 'string' && /^\d+(?:\.\d+)?$/.test(value));
  const parsed = numeric ? Number(value) : typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(numeric && parsed < 1e11 ? parsed * 1000 : parsed) : 0;
}

function normalize(record) {
  for (const field of COUNTERS) record[field] = number(record[field]);
  record.cacheWriteTotal = Math.max(record.cacheWriteTotal, record.cacheWrite5m + record.cacheWrite1h);
  record.cacheWriteUnknown = Math.max(0, record.cacheWriteTotal - record.cacheWrite5m - record.cacheWrite1h);
  record.input = record.uncachedInput + record.cachedInput + record.cacheWriteTotal;
  record.total = record.input + record.output;
  if (record.usageSource === 'message') record.contextTokens = record.input;
  return record;
}

/** Merge multiple streaming blocks/copies of the same message, not requests. */
function mergeRecord(previous, next) {
  if (!previous) return normalize({ ...next });
  const result = { ...previous };
  for (const field of COUNTERS) result[field] = Math.max(number(previous[field]), number(next[field]));
  result.timestamp = Math.max(previous.timestamp || 0, next.timestamp || 0);
  if (!result.model && next.model) result.model = next.model;
  if (previous.model && next.model && previous.model !== next.model) result.modelConflict = true;
  if (previous.modelConflict || next.modelConflict) result.modelConflict = true;
  if (result.modelConflict) result.model = null;
  if ((next.timestamp || 0) >= (previous.timestamp || 0)) {
    if (next.serviceTier) result.serviceTier = next.serviceTier;
    if (next.speed) result.speed = next.speed;
  }
  return normalize(result);
}

function usageRecord(usage, identity, camelCase = false) {
  const record = {
    ...identity, provider: 'claude',
    uncachedInput: number(usage[camelCase ? 'inputTokens' : 'input_tokens']),
    output: number(usage[camelCase ? 'outputTokens' : 'output_tokens']),
    cachedInput: number(usage[camelCase ? 'cacheReadInputTokens' : 'cache_read_input_tokens']),
    cacheWriteTotal: number(usage[camelCase ? 'cacheCreationInputTokens' : 'cache_creation_input_tokens']),
    cacheWrite5m: camelCase ? 0 : number(usage.cache_creation?.ephemeral_5m_input_tokens),
    cacheWrite1h: camelCase ? 0 : number(usage.cache_creation?.ephemeral_1h_input_tokens),
  };
  const tier = identifier(usage.service_tier || usage.serviceTier);
  const speed = identifier(usage.speed);
  if (tier) record.serviceTier = tier.toLowerCase();
  if (speed) record.speed = speed.toLowerCase();
  return normalize(record);
}

/** Enumerate all local project transcripts, including nested subagent logs. */
async function discoverFiles(root = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude')) {
  const pending = [path.join(root, 'projects')], files = [];
  while (pending.length) {
    const directory = pending.pop();
    let entries;
    try { entries = await fs.promises.readdir(directory, { withFileTypes: true }); }
    catch (error) { if (error.code === 'ENOENT' || error.code === 'ENOTDIR') continue; throw error; }
    for (const entry of entries) {
      const target = path.join(directory, entry.name);
      // Do not follow symlinks outside the transcript tree or into cycles.
      if (entry.isDirectory()) pending.push(target);
      else if (entry.isFile() && /\.jsonl$/i.test(entry.name)) files.push(target);
    }
  }
  return files.sort();
}

/** Parse a whole transcript with bounded line buffers; no prompt text is retained. */
async function parseFile(file) {
  const messages = new Map(), checkpoints = new Map(), warningCounts = new Map();
  let parsedBytes = 0, assistantRows = 0, duplicateRows = 0, lastTimestamp = 0;
  let knownSessionId = null;
  const fileId = identifier(path.basename(file, path.extname(file)));
  const fileAgent = fileId?.startsWith('agent-') ? fileId.slice(6) : null;
  const warn = (code, count = 1) => warningCounts.set(code, (warningCounts.get(code) || 0) + count);
  function scope(row) {
    const sessionId = identifier(row.sessionId || row.session_id) || knownSessionId || (!fileAgent ? fileId : null);
    const agentId = identifier(row.agentId || row.agent_id) || fileAgent;
    return { sessionId, agentId, scopeKey: sessionId ? `claude:session:${sessionId}:${agentId || 'main'}` : null };
  }
  function consume(line, final = false) {
    let row;
    try { row = JSON.parse(line.replace(/^\uFEFF/, '')); }
    catch { if (line.trim()) warn(final ? 'incomplete_final_row' : 'malformed_rows'); return; }
    if (!row || typeof row !== 'object' || Array.isArray(row)) return;
    knownSessionId = identifier(row.sessionId || row.session_id) || knownSessionId;
    const at = timestamp(row.timestamp);
    lastTimestamp = Math.max(lastTimestamp, at);
    if (row.type === 'cost-state') {
      if (!row.modelUsage || typeof row.modelUsage !== 'object' || Array.isArray(row.modelUsage)) {
        warn('checkpoint_without_model_breakdown'); return;
      }
      const identity = scope(row);
      // Filename-only checkpoints cannot be deduplicated safely after a copy
      // or rename, so require a session id from the transcript itself.
      if (!identity.scopeKey || !knownSessionId) { warn('checkpoint_without_session_id'); return; }
      for (const [model, usage] of Object.entries(row.modelUsage)) {
        if (!usage || typeof usage !== 'object' || !identifier(model)) continue;
        const key = `${identity.scopeKey}:checkpoint:${model}`;
        const record = usageRecord(usage, { ...identity, key, model, usageSource: 'checkpoint', timestamp: at || lastTimestamp }, true);
        checkpoints.set(key, mergeRecord(checkpoints.get(key), record));
      }
      return;
    }
    if (row.type !== 'assistant' || !row.message || typeof row.message !== 'object') return;
    const message = row.message;
    if (!message.usage || typeof message.usage !== 'object' || Array.isArray(message.usage) || message.model === '<synthetic>') return;
    assistantRows++;
    const counters = ['input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens'];
    if (counters.some((key) => Object.hasOwn(message.usage, key) &&
      (!Number.isFinite(message.usage[key]) || message.usage[key] < 0))) warn('invalid_token_counters');
    const messageId = identifier(message.id), requestId = identifier(row.requestId || row.request_id);
    if (!messageId && !requestId) { warn('usage_without_stable_id'); return; }
    const key = messageId ? `claude:message:${messageId}` : `claude:request:${requestId}`;
    const model = identifier(message.model);
    const record = usageRecord(message.usage, {
      ...scope(row), key, model, usageSource: 'message', timestamp: at,
      ...(messageId ? { messageId } : {}), ...(requestId ? { requestId } : {}),
    });
    if (!model) warn('usage_without_model');
    if (messages.has(key)) duplicateRows++;
    messages.set(key, mergeRecord(messages.get(key), record));
  }

  let pending = [], pendingLength = 0, skipping = false;
  try {
    for await (const chunk of fs.createReadStream(file, { highWaterMark: 64 * 1024 })) {
      parsedBytes += chunk.length;
      let start = 0;
      while (start < chunk.length) {
        const newline = chunk.indexOf(10, start);
        const end = newline < 0 ? chunk.length : newline;
        const part = chunk.subarray(start, end);
        if (!skipping) {
          if (pendingLength + part.length > MAX_LINE_BYTES) {
            pending = []; pendingLength = 0; skipping = true; warn('oversized_rows');
          } else if (newline >= 0) {
            // Assemble each record once. Repeatedly copying the growing prefix
            // makes large image/tool records quadratic in the record length.
            const line = pendingLength ? Buffer.concat([...pending, part], pendingLength + part.length) : part;
            consume(line.toString('utf8'));
            pending = []; pendingLength = 0;
          } else if (part.length) {
            pending.push(part);
            pendingLength += part.length;
          }
        }
        if (newline >= 0) { skipping = false; start = newline + 1; }
        else break;
      }
    }
    if (pendingLength && !skipping) consume(Buffer.concat(pending, pendingLength).toString('utf8'), true);
  } catch (error) { warn(error.code === 'ENOENT' ? 'missing_file' : 'unreadable_file'); }

  let records = [...messages.values()];
  let source = records.length ? 'messages' : 'none';
  if (!records.length && checkpoints.size) {
    records = [...checkpoints.values()];
    source = 'checkpoint';
    warn('checkpoint_only_usage');
  } else if (records.length && checkpoints.size) {
    const observed = new Map();
    for (const record of records) {
      const key = `${record.scopeKey}:checkpoint:${record.model}`;
      observed.set(key, (observed.get(key) || 0) + record.total);
    }
    for (const record of checkpoints.values()) {
      if (record.total > (observed.get(record.key) || 0)) warn('checkpoint_exceeds_observed_messages');
    }
  }
  const unknownCache = records.filter((record) => record.cacheWriteUnknown > 0).length;
  const missingModel = records.filter((record) => !record.model).length;
  if (unknownCache) warn('unknown_cache_write_ttl', unknownCache);
  const conflicts = records.filter((record) => record.modelConflict).length;
  if (conflicts) warn('conflicting_message_models', conflicts);
  const warnings = [...warningCounts].map(([code, count]) => ({ code, count }));
  const incomplete = warnings.some(({ code }) => !['unknown_cache_write_ttl', 'usage_without_model', 'checkpoint_without_model_breakdown'].includes(code)) ||
    (!records.length && warningCounts.has('checkpoint_without_model_breakdown'));
  return {
    records, warnings,
    coverage: { source, incomplete, parsedBytes, assistantRows, uniqueMessages: messages.size,
      duplicateRows, unknownCacheWriteRecords: unknownCache, missingModelRecords: missingModel },
  };
}

module.exports = { discoverFiles, parseFile, mergeRecord };
