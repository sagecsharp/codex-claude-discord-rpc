'use strict';

/**
 * Lifetime stats across every transcript in ~/.claude/projects: tokens, cost,
 * active time, prompts, tool calls, churn, languages, hotspot files, models.
 *
 * Scans run in a worker thread so the daemon never stalls, and are incremental:
 * each file resumes from the byte offset it was last read to, persisted in
 * cache/stats.json. The first run over a large history takes a while; after
 * that a refresh reads only what was appended. Because the totals live in our
 * cache, they also survive Claude deleting old transcripts (it does after 30
 * days by default).
 *
 * Active time is a per-day bitmap of minutes, unioned across sessions: three
 * windows open in parallel count once. Events in one session closer than five
 * minutes apart are treated as continuous work.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');

const CACHE_DIR = path.join(__dirname, '..', 'cache');
const CACHE = path.join(CACHE_DIR, 'stats.json');
const VERSION = 1;
const GAP_MS = 5 * 60 * 1000;
const CHUNK = 16 * 1024 * 1024;

// ---------------------------------------------------------------- helpers

const dayKey = (ms) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const minuteOfDay = (ms) => {
  const d = new Date(ms);
  return d.getHours() * 60 + d.getMinutes();
};

const LANGS = {
  js: 'JavaScript', mjs: 'JavaScript', cjs: 'JavaScript', jsx: 'JavaScript',
  ts: 'TypeScript', tsx: 'TypeScript', py: 'Python', rb: 'Ruby', go: 'Go', rs: 'Rust',
  java: 'Java', kt: 'Kotlin', swift: 'Swift', c: 'C', h: 'C', cpp: 'C++', cc: 'C++', hpp: 'C++',
  cs: 'C#', php: 'PHP', lua: 'Lua', sh: 'Shell', bash: 'Shell', ps1: 'PowerShell',
  html: 'HTML', css: 'CSS', scss: 'CSS', vue: 'Vue', svelte: 'Svelte', sql: 'SQL',
  md: 'Markdown', json: 'JSON', yml: 'YAML', yaml: 'YAML', toml: 'TOML', xml: 'XML',
  shader: 'ShaderLab', hlsl: 'HLSL', glsl: 'GLSL', compute: 'HLSL', gd: 'GDScript', dart: 'Dart',
  zig: 'Zig', ex: 'Elixir', hs: 'Haskell', scala: 'Scala', r: 'R', m: 'Objective-C', vbs: 'VBScript',
};
// Data and docs are churn, but "top language" should name code.
const NOT_CODE = new Set(['Markdown', 'JSON', 'YAML', 'TOML', 'XML']);

const langOf = (file) => LANGS[(path.extname(file).slice(1) || '').toLowerCase()] || null;

/**
 * Lines added/removed by one Edit/Write tool result (shared with the live
 * reader). Edits carry a structuredPatch of unified-diff hunks; new files come
 * with an empty patch and the body in `content`, so they are counted apart -
 * otherwise writing a 600-line file would score +0.
 */
function churnOf(res) {
  if (!res || typeof res !== 'object') return null;
  if (res.type === 'create' && typeof res.content === 'string') {
    const body = res.content.replace(/\n+$/, '');
    return { file: res.filePath, added: body.length ? body.split('\n').length : 0, removed: 0 };
  }
  if (!Array.isArray(res.structuredPatch)) return null;
  let added = 0;
  let removed = 0;
  for (const hunk of res.structuredPatch) {
    for (const l of hunk.lines || []) {
      if (l[0] === '+') added++;
      else if (l[0] === '-') removed++;
    }
  }
  return { file: res.filePath, added, removed };
}

// ---------------------------------------------------------------- store

function emptyStore() {
  return {
    v: VERSION,
    files: {}, // path -> { o: offset, last: ms, ids: { msgId: [tokens, cost, output] } }
    pricing: null, // { key, table } extracted from the Claude binary
    totals: { input: 0, output: 0, read: 0, write: 0, cost: 0, toolCalls: 0, prompts: 0, sessions: 0, added: 0, removed: 0 },
    days: {}, // date -> { m: base64 minute bitmap, prompts, tokens, cost, toolCalls }
    models: {}, // id -> { tokens, cost }
    hot: {}, // file -> [edits, lastAt]
    langs: {}, // language -> lines added
  };
}

function loadStore() {
  try {
    const s = JSON.parse(fs.readFileSync(CACHE, 'utf8'));
    if (s.v === VERSION) return s;
  } catch {}
  return emptyStore();
}

function saveStore(store) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  const tmp = `${CACHE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(store));
  fs.renameSync(tmp, CACHE);
}

// ---------------------------------------------------------------- scanning (worker)

const NEEDLES = ['"type":"assistant"', '"type":"user"', '"toolUseResult"'].map((s) => Buffer.from(s));

function listTranscripts(root) {
  const out = [];
  let slugs = [];
  try {
    slugs = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const slug of slugs) {
    if (!slug.isDirectory()) continue;
    const dir = path.join(root, slug.name);
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (e.isFile() && e.name.endsWith('.jsonl')) out.push({ path: path.join(dir, e.name), main: true });
      // Everything under <sessionId>/ is agent work: subagents/*.jsonl, and
      // workflow agents nested deeper at subagents/workflows/wf_*/*.jsonl.
      else if (e.isDirectory()) walk(path.join(dir, e.name), out, 0);
    }
  }
  return out;
}

function walk(dir, out, depth) {
  if (depth > 6) return;
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out, depth + 1);
    else if (e.isFile() && e.name.endsWith('.jsonl')) out.push({ path: p, main: false });
  }
}

class Scanner {
  constructor(store, pricing) {
    this.s = store;
    this.pricing = pricing;
    this.bitmaps = new Map(); // date -> Uint8Array(180), flushed into days[].m
  }

  day(ms) {
    const k = dayKey(ms);
    return this.s.days[k] || (this.s.days[k] = { m: '', prompts: 0, tokens: 0, cost: 0, toolCalls: 0 });
  }

  markMinute(ms) {
    const k = dayKey(ms);
    let bm = this.bitmaps.get(k);
    if (!bm) {
      const d = this.day(ms);
      bm = d.m ? new Uint8Array(Buffer.from(d.m, 'base64')) : new Uint8Array(180);
      this.bitmaps.set(k, bm);
    }
    const m = minuteOfDay(ms);
    bm[m >> 3] |= 1 << (m & 7);
  }

  flushBitmaps() {
    for (const [k, bm] of this.bitmaps) this.s.days[k].m = Buffer.from(bm).toString('base64');
  }

  scanFile(f) {
    let size;
    try {
      size = fs.statSync(f.path).size;
    } catch {
      return;
    }
    let st = this.s.files[f.path];
    if (!st) {
      st = this.s.files[f.path] = { o: 0, last: 0, ids: {} };
      if (f.main && size > 0) this.s.totals.sessions++;
    }
    // A shrunk file was rewritten; re-reading it would double count, so skip
    // what's there and pick up appends from here on.
    if (size < st.o) st.o = size;
    if (size === st.o) return;

    const fd = fs.openSync(f.path, 'r');
    try {
      let carry = Buffer.alloc(0);
      while (st.o + carry.length < size) {
        const pos = st.o + carry.length;
        const len = Math.min(CHUNK, size - pos);
        const buf = Buffer.alloc(len);
        const n = fs.readSync(fd, buf, 0, len, pos);
        if (n <= 0) break;
        const data = carry.length ? Buffer.concat([carry, buf.subarray(0, n)]) : buf.subarray(0, n);
        let start = 0;
        for (let i = data.indexOf(10); i !== -1; i = data.indexOf(10, start)) {
          const line = data.subarray(start, i);
          // Gate on raw bytes: most lines are huge request blobs we never decode.
          if (line.length > 1 && NEEDLES.some((nd) => line.indexOf(nd) !== -1)) this.line(f, st, line.toString('utf8'));
          start = i + 1;
        }
        st.o += start;
        carry = Buffer.from(data.subarray(start));
        if (start === 0 && carry.length > 256 * 1024 * 1024) break; // pathological line
      }
    } finally {
      fs.closeSync(fd);
    }
  }

  line(f, st, text) {
    let r;
    try {
      r = JSON.parse(text);
    } catch {
      return;
    }
    const at = r.timestamp ? Date.parse(r.timestamp) || 0 : 0;
    if (f.main && at && (r.type === 'assistant' || r.type === 'user')) {
      this.markMinute(at);
      if (st.last && at > st.last && at - st.last < GAP_MS) {
        for (let t = st.last + 60000; t < at; t += 60000) this.markMinute(t);
      }
      if (at > st.last) st.last = at;
    }

    if (r.type === 'assistant' && r.message) this.assistant(st, r, at);
    else if (r.type === 'user') this.user(f, r, at);
  }

  assistant(st, r, at) {
    const m = r.message;
    const T = this.s.totals;
    for (const b of Array.isArray(m.content) ? m.content : []) {
      if (b.type === 'tool_use') {
        T.toolCalls++;
        if (at) this.day(at).toolCalls++;
      }
    }
    const u = m.usage;
    if (!u || !m.id || m.model === '<synthetic>') return;

    // Each content block re-logs the message's usage as of that block; only
    // the last carries the final output_tokens. Count the growth each time.
    const tokens =
      (u.input_tokens || 0) + (u.output_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
    const cost = this.pricing.cost(m.model, u);
    const prev = st.ids[m.id];
    let dTokens = tokens;
    let dCost = cost;
    let dOut = u.output_tokens || 0;
    if (prev) {
      if (tokens <= prev[0]) return;
      dTokens = tokens - prev[0];
      dCost = cost - prev[1];
      dOut = (u.output_tokens || 0) - prev[2];
    } else {
      T.input += u.input_tokens || 0;
      T.read += u.cache_read_input_tokens || 0;
      T.write += u.cache_creation_input_tokens || 0;
    }
    st.ids[m.id] = [tokens, cost, u.output_tokens || 0];
    // Copies of one message are adjacent; keep only the recent ids.
    const keys = Object.keys(st.ids);
    if (keys.length > 8) for (const k of keys.slice(0, keys.length - 8)) delete st.ids[k];

    T.output += dOut;
    T.cost += dCost;
    const mod = this.s.models[m.model] || (this.s.models[m.model] = { tokens: 0, cost: 0 });
    mod.tokens += dTokens;
    mod.cost += dCost;
    if (at) {
      const d = this.day(at);
      d.tokens += dTokens;
      d.cost += dCost;
    }
  }

  user(f, r, at) {
    const c = churnOf(r.toolUseResult);
    if (c && c.file) {
      const T = this.s.totals;
      T.added += c.added;
      T.removed += c.removed;
      const h = this.s.hot[c.file] || (this.s.hot[c.file] = [0, 0]);
      h[0]++;
      if (at > h[1]) h[1] = at;
      const lang = langOf(c.file);
      if (lang && c.added) this.s.langs[lang] = (this.s.langs[lang] || 0) + c.added;
    }
    if (!f.main || r.isMeta || r.isSidechain || r.isCompactSummary || !r.message) return;
    const m = r.message;
    const blocks = Array.isArray(m.content) ? m.content : [];
    if (blocks.some((b) => b.type === 'tool_result')) return;
    const text = typeof m.content === 'string' ? m.content : (blocks.find((b) => b.type === 'text') || {}).text;
    if (!text || /<command-name>/.test(text)) return;
    this.s.totals.prompts++;
    if (at) this.day(at).prompts++;
  }
}

// ---------------------------------------------------------------- summary

function popcount(b64) {
  if (!b64) return 0;
  let n = 0;
  for (const byte of Buffer.from(b64, 'base64')) for (let v = byte; v; v &= v - 1) n++;
  return n;
}

/** The compact numbers the presence frames need. */
function summarize(store, pricing, now = Date.now()) {
  const T = store.totals;
  const today = dayKey(now);
  const days = store.days;
  const activeMin = (k) => (days[k] ? popcount(days[k].m) : 0);

  let weekMin = 0;
  let weekPrompts = 0;
  let weekTokens = 0;
  for (let i = 0; i < 7; i++) {
    const k = dayKey(now - i * 864e5);
    weekMin += activeMin(k);
    if (days[k]) {
      weekPrompts += days[k].prompts;
      weekTokens += days[k].tokens;
    }
  }
  let allMin = 0;
  for (const k of Object.keys(days)) allMin += activeMin(k);

  // Streaks: consecutive days with any active time.
  const active = new Set(Object.keys(days).filter((k) => activeMin(k) > 0));
  let streak = 0;
  for (let i = active.has(today) ? 0 : 1; active.has(dayKey(now - i * 864e5)); i++) streak++;
  let longest = 0;
  for (const k of active) {
    const prev = dayKey(Date.parse(`${k}T12:00:00`) - 864e5);
    if (active.has(prev)) continue;
    let n = 0;
    for (let t = Date.parse(`${k}T12:00:00`); active.has(dayKey(t)); t += 864e5) n++;
    longest = Math.max(longest, n);
  }

  const totalTokens = T.input + T.output + T.read + T.write;
  const models = Object.entries(store.models)
    .map(([id, m]) => ({ id, name: pricing.model(id).name, tokens: m.tokens }))
    .sort((a, b) => b.tokens - a.tokens);
  const modelTotal = models.reduce((a, m) => a + m.tokens, 0) || 1;

  const langs = Object.entries(store.langs).sort((a, b) => b[1] - a[1]);
  const topLang = (langs.find(([l]) => !NOT_CODE.has(l)) || langs[0] || [null])[0];

  const hotspots = Object.entries(store.hot)
    .sort((a, b) => b[1][0] - a[1][0])
    .slice(0, 12)
    .map(([file, [edits, lastAt]]) => ({ file, edits, lastAt }));

  return {
    at: now,
    totalTokens,
    freshTokens: T.input + T.write,
    cachePct: totalTokens ? (T.read / (T.input + T.read + T.write || 1)) * 100 : 0,
    outputTokens: T.output,
    toolCalls: T.toolCalls,
    files: Object.keys(store.hot).length,
    added: T.added,
    removed: T.removed,
    topLang,
    costAll: T.cost,
    costToday: (days[today] && days[today].cost) || 0,
    todayMin: activeMin(today),
    todayPrompts: (days[today] && days[today].prompts) || 0,
    weekMin,
    weekPrompts,
    weekTokens,
    allMin,
    sessions: T.sessions,
    prompts: T.prompts,
    streak,
    longestStreak: longest,
    models: models.slice(0, 4).map((m) => ({ name: m.name || m.id.replace(/^claude-/, ''), share: m.tokens / modelTotal })),
    hotspots,
  };
}

// ---------------------------------------------------------------- worker entry

function runScan(projectsDir) {
  const { Pricing } = require('./pricing');
  const store = loadStore();
  const found = Pricing.fromBinary(store.pricing);
  if (found.key && found.table) store.pricing = { key: found.key, table: found.table };
  const scanner = new Scanner(store, found.pricing);

  const started = Date.now();
  let lastSave = started;
  const files = listTranscripts(projectsDir);
  for (const f of files) {
    try {
      scanner.scanFile(f);
    } catch {}
    if (Date.now() - lastSave > 20000) {
      // Checkpoint, so an interrupted first scan resumes instead of restarting.
      scanner.flushBitmaps();
      saveStore(store);
      lastSave = Date.now();
    }
  }
  scanner.flushBitmaps();
  saveStore(store);
  return { summary: summarize(store, found.pricing), files: files.length, ms: Date.now() - started };
}

if (!isMainThread && workerData && workerData.statsWorker) {
  try {
    parentPort.postMessage({ ok: true, ...runScan(workerData.projectsDir) });
  } catch (err) {
    parentPort.postMessage({ ok: false, error: err.stack || err.message });
  }
}

// ---------------------------------------------------------------- main-thread API

class Stats {
  constructor(projectsDir, log = () => {}) {
    this.projectsDir = projectsDir;
    this.log = log;
    this.summary = null;
    this.running = false;
    // Show the last known numbers immediately, before the first scan lands.
    try {
      const { Pricing } = require('./pricing');
      const store = loadStore();
      if (store.totals.sessions) this.summary = summarize(store, new Pricing(store.pricing ? store.pricing.table : undefined));
    } catch {}
  }

  refresh() {
    if (this.running) return;
    this.running = true;
    const w = new Worker(__filename, { workerData: { statsWorker: true, projectsDir: this.projectsDir } });
    w.once('message', (msg) => {
      if (msg.ok) {
        this.summary = msg.summary;
        if (msg.ms > 3000) this.log(`stats: scanned ${msg.files} transcripts in ${(msg.ms / 1000).toFixed(1)}s`);
      } else this.log(`stats scan failed: ${msg.error}`);
    });
    w.once('error', (err) => this.log(`stats worker crashed: ${err.message}`));
    w.once('exit', () => {
      this.running = false;
    });
  }
}

module.exports = { Stats, summarize, churnOf, runScan, langOf };
