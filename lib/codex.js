'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { classifyTool, isAsyncQuestion, newAction, observeAction, observeResult, actionSnapshot } = require('./activity');

// Local rollout files are an implementation detail of Codex, not a stable API.
// Only metadata and usage counters are retained; message/tool contents are ignored.
const CHUNK_BYTES = 64 * 1024;
const MAX_LINE_BYTES = 8 * 1024 * 1024;
const EMPTY_TOKENS = { input: 0, output: 0, total: 0, cachedInput: 0 };

function milliseconds(value, fallback) {
  const numeric = typeof value === 'number' || (typeof value === 'string' && /^\d+(?:\.\d+)?$/.test(value));
  const n = numeric ? Number(value) : typeof value === 'string' ? Date.parse(value) : NaN;
  if (!Number.isFinite(n) || n <= 0) return fallback;
  // task_started.started_at may be Unix seconds, while rollout timestamps are ISO.
  return Math.floor(numeric && n < 1e11 ? n * 1000 : n);
}

function normalizeTokens(value) {
  if (!value || typeof value !== 'object') return null;
  const number = (key) => Number.isFinite(value[key]) && value[key] >= 0 ? value[key] : 0;
  const input = number('input_tokens');
  const output = number('output_tokens');
  return { input, output, total: number('total_tokens') || input + output,
    cachedInput: number('cached_input_tokens') };
}

function newEntry(file, stat) {
  return {
    file, identity: `${stat.dev}:${stat.ino}`, offset: 0, pending: Buffer.alloc(0),
    skippingLine: false, mtimeMs: stat.mtimeMs,
    action: newAction(),
    snapshot: {
      provider: 'codex', sessionId: path.basename(file, '.jsonl'), model: null,
      cwd: null, status: 'idle', updatedAt: 0, startedAt: null,
      tokens: { ...EMPTY_TOKENS }, hasUsage: false, source: 'local-session',
    },
  };
}

function applyRecord(entry, record) {
  if (!record || typeof record !== 'object') return;
  const data = record.payload;
  if (!data || typeof data !== 'object') return;
  const state = entry.snapshot;
  const at = milliseconds(record.timestamp, entry.mtimeMs);

  if (record.type === 'session_meta') {
    if (typeof data.id === 'string') state.sessionId = data.id;
    else if (typeof data.session_id === 'string') state.sessionId = data.session_id;
    if (typeof data.cwd === 'string') state.cwd = data.cwd;
    return;
  }
  if (record.type === 'turn_context') {
    if (typeof data.model === 'string') state.model = data.model;
    if (typeof data.cwd === 'string') state.cwd = data.cwd;
    return;
  }
  if (record.type === 'token_usage_record') {
    const usage = normalizeTokens(data.thread_token_usage);
    if (usage) { state.tokens = usage; state.hasUsage = true; }
    state.updatedAt = Math.max(state.updatedAt, at);
    return;
  }
  if (record.type === 'event_msg' && data.type === 'token_count') {
    const usage = normalizeTokens(data.info?.total_token_usage);
    if (usage) { state.tokens = usage; state.hasUsage = true; }
    state.updatedAt = Math.max(state.updatedAt, at);
    return;
  }

  // Metadata changes and usage updates never imply a new turn by themselves.
  let status;
  if (record.type === 'event_msg') {
    if (data.type === 'task_started') {
      status = 'thinking';
      observeAction(entry.action, 'thinking', at, { force: true, releaseWaiting: true });
      if (at >= state.updatedAt) state.startedAt = milliseconds(data.started_at, at);
    } else if (['task_complete', 'turn_complete', 'turn_aborted', 'session_shutdown'].includes(data.type)) {
      status = 'idle';
      observeAction(entry.action, ['task_complete', 'turn_complete'].includes(data.type) ? 'done' : 'idle', at);
    } else if (['exec_approval_request', 'apply_patch_approval_request', 'request_user_input'].includes(data.type)) {
      status = 'waiting';
      observeAction(entry.action, 'waiting', at, { callId: data.call_id });
    } else if (data.type === 'user_message') {
      status = 'thinking';
      observeAction(entry.action, 'thinking', at, { force: true, releaseWaiting: true });
    } else if (data.type === 'agent_reasoning') {
      status = 'thinking';
      observeAction(entry.action, 'thinking', at);
    }
  } else if (record.type === 'response_item') {
    if (['function_call', 'custom_tool_call', 'local_shell_call'].includes(data.type)) {
      const action = classifyTool(data.name || data.type, data.arguments ?? data.input ?? data);
      status = action === 'waiting' ? 'waiting' : 'working';
      observeAction(entry.action, action, at, { callId: data.call_id, waitForUser: isAsyncQuestion(data.name, data.arguments ?? data.input) });
    } else if (['function_call_output', 'custom_tool_call_output'].includes(data.type)) {
      status = 'thinking';
      observeResult(entry.action, at, data.call_id);
    } else if (data.type === 'reasoning') {
      status = 'thinking';
      observeAction(entry.action, 'thinking', at);
    } else if (data.type === 'message' && data.role === 'user') {
      status = 'thinking';
      observeAction(entry.action, 'thinking', at, { force: true, releaseWaiting: true });
    } else if (data.type === 'message' && data.role === 'assistant' &&
      (data.phase === 'final_answer' || data.channel === 'final')) {
      status = 'idle';
      observeAction(entry.action, 'done', at);
    }
  }
  if (status && at >= state.updatedAt) {
    state.status = status;
    state.updatedAt = at;
  }
}

function consume(entry, buffer) {
  let data = entry.pending.length ? Buffer.concat([entry.pending, buffer]) : buffer;
  entry.pending = Buffer.alloc(0);
  let start = 0;
  for (let end = data.indexOf(10); end !== -1; end = data.indexOf(10, start)) {
    if (!entry.skippingLine && end - start <= MAX_LINE_BYTES) {
      try { applyRecord(entry, JSON.parse(data.toString('utf8', start, end))); } catch { /* partial/corrupt record */ }
    }
    entry.skippingLine = false;
    start = end + 1;
  }
  if (data.length - start > MAX_LINE_BYTES) entry.skippingLine = true;
  if (!entry.skippingLine) entry.pending = Buffer.from(data.subarray(start));
}

function readRange(fd, entry, start, end) {
  let offset = start;
  const buffer = Buffer.allocUnsafe(CHUNK_BYTES);
  while (offset < end) {
    const read = fs.readSync(fd, buffer, 0, Math.min(buffer.length, end - offset), offset);
    if (!read) break;
    consume(entry, buffer.subarray(0, read));
    offset += read;
  }
  return offset;
}

class CodexReader {
  constructor(options = {}) {
    this.root = options.root || path.join(options.home || process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'sessions');
    this.now = typeof options.now === 'function' ? options.now : Date.now;
    this.staleMs = options.staleMs ?? 120000;
    this.idleRetentionMs = options.idleRetentionMs ?? 600000;
    this.maxSessions = options.maxSessions ?? 32;
    this.discoveryIntervalMs = options.discoveryIntervalMs ?? 10000;
    this.initialHeadBytes = options.initialHeadBytes ?? 512 * 1024;
    this.initialTailBytes = options.initialTailBytes ?? 2 * 1024 * 1024;
    this.entries = new Map();
    this.files = [];
    this.lastDiscovery = -Infinity;
  }

  discover() {
    const found = [];
    let visitedFiles = 0;
    let visitedEntries = 0;
    const walk = (directory, depth) => {
      if (depth > 4 || visitedFiles >= 4096 || visitedEntries >= 8192) return;
      let names;
      try { names = fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => b.name.localeCompare(a.name)); }
      catch { return; }
      for (const name of names) {
        if (visitedFiles >= 4096 || visitedEntries >= 8192) break;
        visitedEntries++;
        const file = path.join(directory, name.name);
        if (name.isDirectory()) walk(file, depth + 1);
        else if (name.isFile() && name.name.endsWith('.jsonl')) {
          visitedFiles++;
          try { const stat = fs.statSync(file); found.push({ file, mtimeMs: stat.mtimeMs }); } catch { /* removed */ }
        }
      }
    };
    walk(this.root, 0);
    this.files = found.sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, this.maxSessions).map(item => item.file);
    const keep = new Set(this.files);
    for (const file of this.entries.keys()) if (!keep.has(file)) this.entries.delete(file);
  }

  read() {
    const now = this.now();
    if (now - this.lastDiscovery >= this.discoveryIntervalMs) {
      this.discover();
      this.lastDiscovery = now;
    }
    const snapshots = [];
    for (const file of this.files) {
      let fd;
      try {
        const stat = fs.statSync(file);
        let entry = this.entries.get(file);
        const identity = `${stat.dev}:${stat.ino}`;
        if (!entry || entry.identity !== identity || stat.size < entry.offset ||
          (stat.size === entry.offset && stat.mtimeMs !== entry.mtimeMs)) {
          entry = newEntry(file, stat);
          this.entries.set(file, entry);
        }
        entry.mtimeMs = stat.mtimeMs;
        if (stat.size > entry.offset) {
          fd = fs.openSync(file, 'r');
          if (entry.offset === 0 && stat.size > this.initialHeadBytes + this.initialTailBytes) {
            readRange(fd, entry, 0, this.initialHeadBytes);
            entry.pending = Buffer.alloc(0);
            const tailStart = stat.size - this.initialTailBytes;
            const previous = Buffer.alloc(1);
            fs.readSync(fd, previous, 0, 1, tailStart - 1);
            entry.skippingLine = previous[0] !== 10;
            entry.offset = readRange(fd, entry, tailStart, stat.size);
          } else {
            entry.offset = readRange(fd, entry, entry.offset, stat.size);
          }
        }
        const state = entry.snapshot;
        const stale = !state.updatedAt || now - state.updatedAt > this.staleMs;
        if (!state.updatedAt || now - state.updatedAt > this.idleRetentionMs || state.updatedAt > now + 60000) continue;
        const status = stale ? 'idle' : entry.action.waitingFor ? 'waiting' : state.status;
        snapshots.push({ ...state, tokens: { ...state.tokens }, stale, status,
          ...actionSnapshot(entry.action, now, status, stale, state.updatedAt) });
      } catch { /* missing, locked, or unreadable files are retried next poll */ }
      finally { if (fd !== undefined) fs.closeSync(fd); }
    }
    return snapshots.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  scan() { return this.read(); }
}

module.exports = { CodexReader, normalizeTokens };
