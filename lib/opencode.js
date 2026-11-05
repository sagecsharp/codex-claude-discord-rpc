'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { StringDecoder } = require('node:string_decoder');
const { classifyTool, commandAction, newAction, observeAction, actionSnapshot } = require('./activity');

// OpenCode keeps a single append-only log per data directory. Only key/value
// metadata is retained here: prompts, file contents, and command output are
// never read into a presence payload.
const CHUNK_BYTES = 64 * 1024;
const MAX_LINE_BYTES = 512 * 1024;
const EMPTY_TOKENS = Object.freeze({ input: 0, output: 0, total: 0, cachedInput: 0 });

function defaultRoot(env = process.env) {
  if (env.OPENCODE_DATA_DIR) return env.OPENCODE_DATA_DIR;
  if (env.XDG_DATA_HOME) return path.join(env.XDG_DATA_HOME, 'opencode');
  return path.join(os.homedir(), '.local', 'share', 'opencode');
}

function parseFields(line) {
  const fields = Object.create(null);
  const length = line.length;
  let index = 0;
  while (index < length) {
    while (index < length && line[index] === ' ') index++;
    if (index >= length) break;
    const keyStart = index;
    while (index < length && line[index] !== '=' && line[index] !== ' ') index++;
    if (index >= length || line[index] !== '=') {
      while (index < length && line[index] !== ' ') index++;
      continue;
    }
    const key = line.slice(keyStart, index);
    index++;
    let value;
    if (line[index] === '"') {
      index++;
      let buffer = '';
      while (index < length) {
        const character = line[index];
        if (character === '\\' && index + 1 < length) {
          const next = line[index + 1];
          if (next === '"' || next === '\\') { buffer += next; index += 2; continue; }
          buffer += character; index++; continue;
        }
        if (character === '"') { index++; break; }
        buffer += character; index++;
      }
      value = buffer;
    } else {
      const valueStart = index;
      while (index < length && line[index] !== ' ') index++;
      value = line.slice(valueStart, index);
    }
    if (fields[key] === undefined) fields[key] = value;
  }
  return fields;
}

function modelKind(provider, model) {
  const text = `${provider || ''} ${model || ''}`.toLowerCase();
  if (/glm|chatglm|zai|zhipu/.test(text)) return 'glm';
  if (/deepseek/.test(text)) return 'deepseek';
  return 'opencode';
}

function permissionAction(permission, pattern) {
  const name = String(permission || '').toLowerCase();
  if (name === 'bash' || name === 'shell' || name === 'powershell') return commandAction(pattern || '');
  return classifyTool(name, { cmd: pattern });
}

function sessionIdOf(fields, message) {
  if (typeof fields['session.id'] === 'string' && fields['session.id'].startsWith('ses_')) return fields['session.id'];
  if (message === 'created' && typeof fields.id === 'string' && fields.id.startsWith('ses_')) return fields.id;
  return '';
}

class OpencodeReader {
  constructor(options = {}) {
    this.root = options.root || defaultRoot();
    this.file = options.file || path.join(this.root, 'log', 'opencode.log');
    this.now = typeof options.now === 'function' ? options.now : Date.now;
    this.staleMs = options.staleMs ?? 120000;
    this.retentionMs = options.retentionMs ?? 600000;
    this.maxSessions = options.maxSessions ?? 8;
    this.initialBytes = options.initialBytes ?? 512 * 1024;
    this.identity = null;
    this.offset = 0;
    this.mtimeMs = 0;
    this.pending = '';
    this.skipLine = false;
    this.decoder = new StringDecoder('utf8');
    this.sessions = new Map();
    this.runSession = new Map();
  }

  _reset(stat) {
    this.identity = `${stat.dev}:${stat.ino}`;
    this.mtimeMs = stat.mtimeMs;
    const tail = Math.min(stat.size, this.initialBytes);
    this.offset = stat.size - tail;
    this.pending = '';
    this.skipLine = this.offset > 0;
    this.decoder = new StringDecoder('utf8');
  }

  _session(id) {
    let session = this.sessions.get(id);
    if (!session) {
      session = {
        sessionId: id, cwd: null, model: null, provider: null,
        status: 'idle', updatedAt: 0, startedAt: 0, createdAt: 0, action: newAction(),
      };
      this.sessions.set(id, session);
    }
    return session;
  }

  _apply(fields, at) {
    if (!at) return;
    const message = fields.message || '';
    const run = fields.run || '';
    let sessionId = sessionIdOf(fields, message);
    if (sessionId && run) this.runSession.set(run, sessionId);
    if (!sessionId && run) sessionId = this.runSession.get(run) || '';
    if (!sessionId) return;
    const session = this._session(sessionId);
    if (!session.createdAt) session.createdAt = at;
    if (!session.startedAt) session.startedAt = at;

    if (message === 'created') {
      if (typeof fields.directory === 'string') session.cwd = fields.directory;
      return;
    }
    if (message === 'stream') {
      if (typeof fields.modelID === 'string') session.model = fields.modelID;
      if (typeof fields.providerID === 'string') session.provider = fields.providerID;
      session.status = 'thinking';
      session.updatedAt = Math.max(session.updatedAt, at);
      observeAction(session.action, 'thinking', at, { releaseWaiting: true });
      return;
    }
    if (message === 'process' || message === 'loop' || message === 'replied') {
      session.status = 'thinking';
      session.updatedAt = Math.max(session.updatedAt, at);
      observeAction(session.action, 'thinking', at, { force: message === 'replied', releaseWaiting: true });
      return;
    }
    if (message === 'asking') {
      session.status = 'waiting';
      session.updatedAt = Math.max(session.updatedAt, at);
      observeAction(session.action, 'waiting', at);
      return;
    }
    if (message === 'cancel') {
      session.status = 'idle';
      session.updatedAt = Math.max(session.updatedAt, at);
      observeAction(session.action, 'idle', at);
      return;
    }
    if (message === 'exiting loop') {
      session.status = 'idle';
      session.updatedAt = Math.max(session.updatedAt, at);
      observeAction(session.action, 'done', at);
      return;
    }
    if (message === 'stream error') {
      session.status = 'idle';
      session.updatedAt = Math.max(session.updatedAt, at);
      observeAction(session.action, 'idle', at);
      return;
    }
    if (message === 'evaluated') {
      const action = permissionAction(fields.permission, fields.pattern);
      session.status = action === 'waiting' ? 'waiting' : 'working';
      session.updatedAt = Math.max(session.updatedAt, at);
      observeAction(session.action, action, at);
      return;
    }
    if (message === 'formatting') {
      session.status = 'working';
      session.updatedAt = Math.max(session.updatedAt, at);
      observeAction(session.action, 'editing', at);
    }
  }

  _consume(text) {
    let data = this.pending + text;
    this.pending = '';
    let start = 0;
    for (let end = data.indexOf('\n'); end !== -1; end = data.indexOf('\n', start)) {
      const line = data.slice(start, end);
      if (!this.skipLine && line.length <= MAX_LINE_BYTES) {
        try {
          const fields = parseFields(line);
          this._apply(fields, Date.parse(fields.timestamp));
        } catch { /* partial or malformed records are ignored */ }
      }
      this.skipLine = false;
      start = end + 1;
    }
    if (data.length - start > MAX_LINE_BYTES) { this.skipLine = true; return; }
    this.pending = data.slice(start);
  }

  read() {
    const now = this.now();
    let descriptor;
    try {
      const stat = fs.statSync(this.file);
      const identity = `${stat.dev}:${stat.ino}`;
      if (!this.identity || this.identity !== identity || stat.size < this.offset ||
        (stat.size === this.offset && stat.mtimeMs !== this.mtimeMs)) this._reset(stat);
      if (stat.size > this.offset) {
        descriptor = fs.openSync(this.file, 'r');
        const buffer = Buffer.allocUnsafe(CHUNK_BYTES);
        while (this.offset < stat.size) {
          const count = fs.readSync(descriptor, buffer, 0, Math.min(buffer.length, stat.size - this.offset), this.offset);
          if (!count) break;
          this.offset += count;
          this._consume(this.decoder.write(buffer.subarray(0, count)));
        }
      }
    } catch { /* no log yet, or the file was replaced mid-read */ }
    finally { if (descriptor !== undefined) fs.closeSync(descriptor); }

    const snapshots = [];
    for (const session of this.sessions.values()) {
      const updatedAt = session.updatedAt;
      if (!updatedAt || now - updatedAt > this.retentionMs || updatedAt > now + 60000) continue;
      const stale = now - updatedAt > this.staleMs;
      const status = stale ? 'idle' : session.status;
      snapshots.push({
        provider: 'opencode', sessionId: session.sessionId, model: session.model,
        modelKind: modelKind(session.provider, session.model), cwd: session.cwd,
        status, updatedAt, stale, startedAt: session.startedAt || updatedAt,
        ...actionSnapshot(session.action, now, status, stale, updatedAt),
        tokens: { ...EMPTY_TOKENS }, hasUsage: false,
      });
    }
    for (const [id, session] of this.sessions) {
      const lastSeen = session.updatedAt || session.createdAt;
      if (lastSeen && now - lastSeen > this.retentionMs * 2) {
        this.sessions.delete(id);
        for (const [run, target] of this.runSession) if (target === id) this.runSession.delete(run);
      }
    }
    return snapshots.sort((a, b) => b.updatedAt - a.updatedAt).slice(0, this.maxSessions);
  }

  scan() { return this.read(); }
}

module.exports = { OpencodeReader, parseFields, modelKind, defaultRoot };
