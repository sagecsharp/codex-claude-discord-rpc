'use strict';

/**
 * Incremental reader for one session transcript (projects/<slug>/<id>.jsonl).
 *
 * Each update() parses only the bytes appended since the last call, folding
 * them into running state: what tool is in flight, subagents, the current
 * turn, model and context use, and lines added/removed. A 50 MB transcript is
 * read once at startup and never again.
 */

const fs = require('fs');
const { churnOf } = require('./stats');

const CHUNK = 8 * 1024 * 1024;

// Cheap substring gate before JSON.parse. Transcripts are dominated by huge
// api-request / attachment lines we never need, and the type tag of a record
// is always an unescaped `"type":"..."` while nested strings are escaped.
const WANTED = [
  '"type":"assistant"',
  '"type":"user"',
  '"type":"custom-title"',
  '"type":"ai-title"',
  '"subtype":"compact_boundary"',
  '"type":"api-request"', // not -blob / -shape: the closing quote rules those out
  // Claude marks ultracode in the transcript with attachment records.
  '"ultra_effort_enter"',
  '"ultra_effort_exit"',
  '"workflow_keyword_request"',
];

// Every API call logs its params; output_config.effort is the reasoning level
// the request was made at. Read with a regex - no need to parse the record.
const EFFORT_RE = /"output_config":\{[^{}]*?"effort":"(\w+)"/;

const AGENT_TOOLS = new Set(['Agent', 'Task']);

class Transcript {
  constructor(file) {
    this.file = file;
    this.offset = 0;
    this.partial = Buffer.alloc(0);

    this.customTitle = null;
    this.aiTitle = null;
    this.model = null;
    this.contextTokens = 0;
    this.outputTokens = 0;
    this.added = 0;
    this.removed = 0;
    this.files = new Set();
    this.prompts = 0;
    this.toolCalls = 0;
    this.gitBranch = null;

    this.inflight = new Map(); // tool_use_id -> { name, input, at, sidechain }
    this.lastTool = null; //      { name, input, at, sidechain }
    this.lastAssistant = null; // { kind: 'text'|'thinking'|'tool', stop, at }
    this.turnStartAt = 0;
    this.turnCommand = null; // "/compact" etc. when the turn was a slash command
    this.effort = null; //      reasoning effort of the latest API call: low..max
    this.ultracodeOn = false; // /effort ultracode is on for the session (latest enter/exit marker)
    this.turnUltra = false; //  this turn used the ultracode keyword, or launched a Workflow
    this.lastCompactAt = 0;
    this.lastEventAt = 0;

    this._seenMsg = new Map(); // message.id -> highest output_tokens seen
  }

  get title() {
    return this.customTitle || this.aiTitle;
  }

  /** Main-chain tools still running. */
  get running() {
    return [...this.inflight.values()].filter((t) => !t.sidechain);
  }

  get agentsRunning() {
    return this.running.filter((t) => AGENT_TOOLS.has(t.name)).length;
  }

  update() {
    let size;
    try {
      size = fs.statSync(this.file).size;
    } catch {
      return false;
    }
    if (size < this.offset) {
      // Rewritten underneath us: start over.
      Object.assign(this, new Transcript(this.file));
    }
    if (size === this.offset) return false;

    let fd;
    try {
      fd = fs.openSync(this.file, 'r');
      while (this.offset < size) {
        const len = Math.min(CHUNK, size - this.offset);
        const buf = Buffer.alloc(len);
        const n = fs.readSync(fd, buf, 0, len, this.offset);
        if (n <= 0) break;
        this.offset += n;
        this._consume(buf.subarray(0, n));
      }
    } catch {
      /* transient (file locked mid-write) - next tick resumes from offset */
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
    }
    return true;
  }

  _consume(buf) {
    // Split on raw newline bytes so a multi-byte UTF-8 char cut by the chunk
    // boundary is reassembled before decoding.
    let data = this.partial.length ? Buffer.concat([this.partial, buf]) : buf;
    let start = 0;
    for (let i = data.indexOf(10); i !== -1; i = data.indexOf(10, start)) {
      this._line(data.toString('utf8', start, i));
      start = i + 1;
    }
    this.partial = Buffer.from(data.subarray(start));
  }

  _line(line) {
    if (line.length < 2 || line[0] !== '{') return;
    if (!WANTED.some((w) => line.includes(w)) && !line.includes('"toolUseResult"')) return;
    if (line.includes('"type":"api-request"')) {
      const e = EFFORT_RE.exec(line);
      if (e) this.effort = e[1];
      return;
    }
    let r;
    try {
      r = JSON.parse(line);
    } catch {
      return;
    }
    const at = r.timestamp ? Date.parse(r.timestamp) || 0 : 0;
    if (at > this.lastEventAt) this.lastEventAt = at;
    if (r.gitBranch) this.gitBranch = r.gitBranch;

    switch (r.type) {
      case 'custom-title':
        if (r.customTitle) this.customTitle = r.customTitle;
        return;
      case 'ai-title':
        if (r.aiTitle) this.aiTitle = r.aiTitle;
        return;
      case 'attachment': {
        const a = r.attachment && r.attachment.type;
        if (a === 'ultra_effort_enter') this.ultracodeOn = true;
        else if (a === 'ultra_effort_exit') this.ultracodeOn = false;
        else if (a === 'workflow_keyword_request') this.turnUltra = true;
        return;
      }
      case 'system':
        if (r.subtype === 'compact_boundary') this.lastCompactAt = at;
        return;
      case 'assistant':
        return this._assistant(r, at);
      case 'user':
        return this._user(r, at);
    }
  }

  _assistant(r, at) {
    const m = r.message;
    if (!m) return;
    const side = !!r.isSidechain;

    // Streaming writes one record per content block, all sharing message.id,
    // each with usage *as of that block* - output_tokens only reaches its
    // final value on the last one. Count each message at its highest.
    if (m.id && m.usage) {
      const u = m.usage;
      const out = u.output_tokens || 0;
      const prev = this._seenMsg.get(m.id) || 0;
      if (out > prev) this.outputTokens += out - prev;
      this._seenMsg.set(m.id, Math.max(out, prev));
      if (!side) {
        this.contextTokens =
          (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
      }
    }
    if (!side && m.model && m.model !== '<synthetic>') this.model = m.model;

    for (const b of Array.isArray(m.content) ? m.content : []) {
      if (b.type === 'tool_use') {
        const t = { name: b.name, input: b.input || {}, at, sidechain: side };
        this.inflight.set(b.id, t);
        this.toolCalls++;
        if (!side) this.lastTool = t;
        if (!side && b.name === 'Workflow') this.turnUltra = true; // the agent army is out
        if (!side) this.lastAssistant = { kind: 'tool', stop: m.stop_reason, at };
      } else if (!side && b.type === 'text' && b.text && b.text.trim()) {
        this.lastAssistant = { kind: 'text', stop: m.stop_reason, at };
      } else if (!side && b.type === 'thinking') {
        this.lastAssistant = { kind: 'thinking', stop: m.stop_reason, at };
      }
    }
  }

  _user(r, at) {
    const m = r.message || {};
    const blocks = Array.isArray(m.content) ? m.content : [];
    let isResult = false;
    for (const b of blocks) {
      if (b.type === 'tool_result') {
        isResult = true;
        this.inflight.delete(b.tool_use_id);
      }
    }
    if (r.toolUseResult && typeof r.toolUseResult === 'object') this._churn(r.toolUseResult);
    if (isResult || r.isMeta || r.isSidechain) return;

    if (r.isCompactSummary) {
      this.lastCompactAt = at;
      return;
    }
    const text = typeof m.content === 'string' ? m.content : (blocks.find((b) => b.type === 'text') || {}).text;
    if (!text) return;

    // A new turn. Anything left "in flight" from the last one was interrupted.
    this.inflight.clear();
    this.turnStartAt = at;
    this.lastAssistant = null;
    const cmd = /<command-name>(\/[^<]+)<\/command-name>/.exec(text);
    this.turnCommand = cmd ? cmd[1].trim() : null;
    this.turnUltra = /\bultracode\b/i.test(text);
    if (!cmd) this.prompts++;
  }

  _churn(res) {
    const c = churnOf(res);
    if (!c) return;
    if (c.file) this.files.add(c.file);
    this.added += c.added;
    this.removed += c.removed;
  }
}

module.exports = { Transcript };
