'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { classifyTool, selectAction, newAction, observeAction, observeResult, actionSnapshot } = require('./activity');

const finite = (value) => Number.isFinite(Number(value)) && Number(value) >= 0 ? Number(value) : 0;
const timestamp = (value) => typeof value === 'number' ? value : Date.parse(value) || 0;
const emptyTokens = () => ({ input: 0, output: 0, total: 0, cachedInput: 0 });

function alive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
}

function entries(dir) {
  try { return fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
}

function stat(file) {
  try { return fs.statSync(file); } catch { return null; }
}

function usageTokens(usage, camelCase = false) {
  const rawInput = finite(usage[camelCase ? 'inputTokens' : 'input_tokens']);
  const cachedInput = finite(usage[camelCase ? 'cacheReadInputTokens' : 'cache_read_input_tokens']);
  const createdInput = finite(usage[camelCase ? 'cacheCreationInputTokens' : 'cache_creation_input_tokens']);
  const output = finite(usage[camelCase ? 'outputTokens' : 'output_tokens']);
  const input = rawInput + cachedInput + createdInput;
  return { input, output, total: input + output, cachedInput };
}

function addTokens(target, value) {
  for (const key of Object.keys(target)) target[key] += value[key];
}

/** Read only metadata and token counters from local Claude Code session logs.
 * root is the .claude directory, not its projects or sessions subdirectory.
 * No message text, commands, filenames, or credentials are returned.
 */
class ClaudeReader {
  constructor(options = {}) {
    this.root = options.root || process.env.CLAUDE_CONFIG_DIR || path.join(options.home || os.homedir(), '.claude');
    this.now = typeof options.now === 'function' ? options.now : () => options.now ?? Date.now();
    this.staleMs = options.staleMs ?? options.idleAfterMs ?? 120000;
    this.retentionMs = options.idleRetentionMs ?? options.retentionMs ?? Math.max(this.staleMs, 600000);
    this.maxSessions = options.maxSessions ?? 32;
    this.maxReadBytes = Math.max(1024, options.maxReadBytes ?? 4 * 1024 * 1024);
    this.processAlive = options.processAlive || alive;
    this.cache = new Map();
  }

  _logs() {
    const logs = new Map();
    const projects = path.join(this.root, 'projects');
    for (const dir of entries(projects)) {
      if (!dir.isDirectory()) continue;
      const project = path.join(projects, dir.name);
      for (const entry of entries(project)) {
        if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
        const file = path.join(project, entry.name);
        const info = stat(file);
        if (!info) continue;
        const id = entry.name.slice(0, -6);
        const previous = logs.get(id);
        if (!previous || info.mtimeMs > previous.mtimeMs) logs.set(id, { file, mtimeMs: info.mtimeMs });
      }
    }
    return logs;
  }

  _metadata() {
    const dir = path.join(this.root, 'sessions');
    const candidates = entries(dir)
      .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
      .map((entry) => ({ file: path.join(dir, entry.name), info: stat(path.join(dir, entry.name)) }))
      .filter(({ info }) => info && info.size <= 65536)
      .sort((a, b) => b.info.mtimeMs - a.info.mtimeMs)
      .slice(0, this.maxSessions * 4);
    const result = [];
    for (const { file, info } of candidates) {
      try {
        const data = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (typeof data.sessionId !== 'string' || !/^[\w-]{1,150}$/.test(data.sessionId)) continue;
        result.push({ ...data, fileMtime: info.mtimeMs });
      } catch { /* A concurrent metadata write is retried next scan. */ }
    }
    return result;
  }

  _newLog(info, offset = 0) {
    return {
      offset, ino: info.ino, mtimeMs: info.mtimeMs, pending: '', skipLine: offset > 0,
      updatedAt: 0, startedAt: 0, status: 'idle', model: null, cwd: null,
      action: newAction(),
      tokens: emptyTokens(), usageComplete: offset === 0, messages: new Map(),
    };
  }

  _event(state, event) {
    const time = timestamp(event.timestamp);
    // Sidechain/subagent records are not the activity of the main session.
    if (event.isSidechain) return;
    if (typeof event.cwd === 'string') state.cwd = event.cwd;
    if (time && !state.startedAt) state.startedAt = time;
    if (event.type === 'cost-state' && event.modelUsage && typeof event.modelUsage === 'object') {
      const total = emptyTokens();
      for (const usage of Object.values(event.modelUsage)) {
        if (usage && typeof usage === 'object') addTokens(total, usageTokens(usage, true));
      }
      state.tokens = total;
      state.usageComplete = true;
      return;
    }
    if (event.type === 'user') {
      state.updatedAt = Math.max(state.updatedAt, time);
      state.status = 'thinking';
      const results = Array.isArray(event.message?.content) ? event.message.content.filter((part) => part.type === 'tool_result') : [];
      if (results.length) for (const result of results) observeResult(state.action, time, result.tool_use_id);
      else observeAction(state.action, 'thinking', time, { force: true, releaseWaiting: true });
      return;
    }
    if (event.type !== 'assistant' || !event.message) return;
    const message = event.message;
    state.updatedAt = Math.max(state.updatedAt, time);
    if (typeof message.model === 'string' && message.model !== '<synthetic>') state.model = message.model;
    const types = Array.isArray(message.content) ? message.content.map((part) => part.type) : [];
    state.status = message.stop_reason === 'end_turn' || message.stop_reason === 'stop_sequence'
      ? 'idle' : types.includes('tool_use') ? 'working' : types.includes('thinking') ? 'thinking' : 'working';
    if (state.status === 'idle') observeAction(state.action, 'done', time);
    else if (types.includes('tool_use')) {
      const tools = message.content.filter((part) => part.type === 'tool_use');
      const action = selectAction(tools.map((tool) => classifyTool(tool.name, tool.input)));
      const waitingTool = tools.find((tool) => classifyTool(tool.name, tool.input) === 'waiting');
      observeAction(state.action, action, time, { callId: waitingTool?.id });
      if (action === 'waiting') state.status = 'waiting';
    } else observeAction(state.action, 'thinking', time);
    if (!message.usage || typeof message.usage !== 'object') return;
    const key = message.id || event.requestId || event.uuid;
    // Unkeyed usage cannot be reliably deduplicated; omit it instead of inflating totals.
    if (typeof key !== 'string') { state.usageComplete = false; return; }
    const current = usageTokens(message.usage);
    const previous = state.messages.get(key) || emptyTokens();
    const next = emptyTokens();
    for (const field of Object.keys(next)) {
      next[field] = Math.max(current[field], previous[field]);
      state.tokens[field] += next[field] - previous[field];
    }
    state.tokens.total = state.tokens.input + state.tokens.output;
    state.messages.set(key, next);
  }

  _readLog(file) {
    const info = stat(file);
    if (!info || !info.isFile()) { this.cache.delete(file); return null; }
    let state = this.cache.get(file);
    if (!state || state.ino !== info.ino || info.size < state.offset || (info.size === state.offset && info.mtimeMs !== state.mtimeMs)) {
      state = this._newLog(info, Math.max(0, info.size - this.maxReadBytes));
      this.cache.set(file, state);
    }
    if (info.size - state.offset > this.maxReadBytes) {
      // A large append is bootstrapped from its tail. A cumulative cost-state
      // restores exact counts; otherwise usageComplete makes truncation explicit.
      state = this._newLog(info, info.size - this.maxReadBytes);
      this.cache.set(file, state);
    }
    const length = info.size - state.offset;
    if (length) {
      let fd;
      try {
        fd = fs.openSync(file, 'r');
        const buffer = Buffer.allocUnsafe(length);
        const count = fs.readSync(fd, buffer, 0, length, state.offset);
        state.offset += count;
        const lines = (state.pending + buffer.subarray(0, count).toString('utf8')).split('\n');
        state.pending = lines.pop();
        if (state.skipLine && lines.length) { lines.shift(); state.skipLine = false; }
        for (const line of lines) {
          try { this._event(state, JSON.parse(line)); } catch { /* Ignore malformed complete lines. */ }
        }
        // Do not retain an unbounded unterminated row.
        if (state.pending.length > this.maxReadBytes) { state.pending = ''; state.skipLine = true; state.usageComplete = false; }
      } catch { return state; } finally { if (fd !== undefined) fs.closeSync(fd); }
    }
    state.mtimeMs = info.mtimeMs;
    return state;
  }

  read() {
    const now = this.now();
    const logs = this._logs();
    const uniqueMetadata = new Map();
    for (const meta of this._metadata()) {
      const previous = uniqueMetadata.get(meta.sessionId);
      if (!previous || timestamp(meta.updatedAt) > timestamp(previous.updatedAt)) uniqueMetadata.set(meta.sessionId, meta);
    }
    const metadata = [...uniqueMetadata.values()];
    const known = new Set(metadata.map((session) => session.sessionId));
    const candidates = [];
    for (const meta of metadata) {
      if (Number.isSafeInteger(meta.pid) && !this.processAlive(meta.pid)) continue;
      const log = logs.get(meta.sessionId);
      const update = Math.max(timestamp(meta.updatedAt), timestamp(meta.statusUpdatedAt), log?.mtimeMs || 0);
      if (!update || now - update > this.retentionMs || update > now + 60000) continue;
      candidates.push({ id: meta.sessionId, meta, log, update });
    }
    for (const [id, log] of logs) {
      if (!known.has(id) && now - log.mtimeMs <= this.staleMs && log.mtimeMs <= now + 60000) {
        candidates.push({ id, log, update: log.mtimeMs });
      }
    }
    candidates.sort((a, b) => b.update - a.update);
    const snapshots = [];
    const keep = new Set();
    for (const candidate of candidates.slice(0, this.maxSessions)) {
      const { id, meta, log } = candidate;
      const state = log ? this._readLog(log.file) : null;
      if (log) keep.add(log.file);
      const updatedAt = Math.max(timestamp(meta?.updatedAt), timestamp(meta?.statusUpdatedAt), state?.updatedAt || 0);
      if (!updatedAt || now - updatedAt > this.retentionMs || updatedAt > now + 60000) continue;
      let status = state?.status || 'idle';
      const explicit = String(meta?.status || '').toLowerCase();
      if (['idle', 'done', 'stopped'].includes(explicit)) status = 'idle';
      else if (['waiting', 'blocked', 'blocked_on_user', 'waiting_for_input', 'needs_input'].includes(explicit)) status = 'waiting';
      else if (['busy', 'working', 'running'].includes(explicit) && status === 'idle') status = 'working';
      if (!['idle', 'done', 'stopped'].includes(explicit) && state?.action.waitingFor) status = 'waiting';
      if (now - updatedAt > this.staleMs) status = 'idle';
      snapshots.push({
        provider: 'claude', sessionId: id, model: state?.model || null,
        cwd: typeof meta?.cwd === 'string' ? meta.cwd : state?.cwd || null,
        status, updatedAt, stale: now - updatedAt > this.staleMs,
        ...actionSnapshot(state?.action, now, status, now - updatedAt > this.staleMs, timestamp(meta?.statusUpdatedAt) || updatedAt),
        startedAt: timestamp(meta?.startedAt) || state?.startedAt || updatedAt,
        tokens: state ? { ...state.tokens } : emptyTokens(),
        usageComplete: state?.usageComplete ?? false,
      });
    }
    for (const file of this.cache.keys()) if (!keep.has(file)) this.cache.delete(file);
    return snapshots;
  }

  scan() { return this.read(); }
}

module.exports = { ClaudeReader };
