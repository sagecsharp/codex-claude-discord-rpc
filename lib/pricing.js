'use strict';

/**
 * Per-model token pricing, as Claude Code itself computes cost.
 *
 * Claude Code bakes a model catalog into its binary ("the source of truth for
 * per-model provider IDs and metadata") with named pricing tiers, $ per million
 * tokens:  { input, output, cache_write_5m, cache_write_1h, cache_read,
 * web_search (per request), long_prompt? }.  SNAPSHOT below is that catalog as
 * of Claude Code 2.1.309; fromBinary() re-extracts it from the installed Claude
 * so models released later are priced correctly without a code change.
 *
 * Cost is API-equivalent: what the tokens would cost on the API. On a Pro/Max
 * subscription that's a measure of value, not a bill.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const T = (input, output, w5, w1h, read, long) => ({
  input,
  output,
  cache_write_5m: w5,
  cache_write_1h: w1h,
  cache_read: read,
  web_search: 0.01,
  ...(long && { long_prompt: long }),
});

const SNAPSHOT = {
  tiers: {
    tier_2_10: T(2, 10, 2.5, 4, 0.2),
    tier_2_10_cache_read_0_10: T(2, 10, 2.5, 4, 0.1),
    tier_3_15: T(3, 15, 3.75, 6, 0.3),
    tier_5_25: T(5, 25, 6.25, 10, 0.5),
    tier_15_75: T(15, 75, 18.75, 30, 1.5),
    tier_10_50: T(10, 50, 12.5, 20, 1),
    tier_10_50_cache_read_0_25: T(10, 50, 12.5, 20, 0.25),
    tier_4_20_cache_read_0_20: T(4, 20, 5, 8, 0.2),
    haiku_35: T(0.8, 4, 1, 1.6, 0.08),
    haiku_45: T(1, 5, 1.25, 2, 0.1),
    haiku_55: T(0.1, 0.5, 0.125, 0.2, 0.01, {
      above_prompt_tokens: 1e5,
      input: 0.5,
      output: 2.5,
      cache_write_5m: 0.625,
      cache_write_1h: 1,
      cache_read: 0.05,
    }),
  },
  models: {
    'claude-3-5-haiku': ['Haiku 3.5', 'haiku_35'],
    'claude-haiku-4-5': ['Haiku 4.5', 'haiku_45'],
    'claude-haiku-5-5': ['Haiku 5.5', 'haiku_55'],
    'claude-3-5-sonnet': ['Sonnet 3.5', 'tier_3_15'],
    'claude-3-7-sonnet': ['Sonnet 3.7', 'tier_3_15'],
    'claude-sonnet-4-0': ['Sonnet 4', 'tier_3_15'],
    'claude-sonnet-4-5': ['Sonnet 4.5', 'tier_3_15'],
    'claude-sonnet-4-6': ['Sonnet 4.6', 'tier_3_15'],
    'claude-sonnet-5': ['Sonnet 5', 'tier_2_10'],
    'claude-sonnet-5-5': ['Sonnet 5.5', 'tier_2_10_cache_read_0_10'],
    'claude-opus-4-0': ['Opus 4', 'tier_15_75'],
    'claude-opus-4-1': ['Opus 4.1', 'tier_15_75'],
    'claude-opus-4-5': ['Opus 4.5', 'tier_5_25'],
    'claude-opus-4-6': ['Opus 4.6', 'tier_5_25'],
    'claude-opus-4-7': ['Opus 4.7', 'tier_5_25'],
    'claude-opus-4-8': ['Opus 4.8', 'tier_5_25'],
    'claude-opus-5': ['Opus 5', 'tier_5_25'],
    'claude-opus-5-5': ['Opus 5.5', 'tier_4_20_cache_read_0_20'],
    'claude-fable-5': ['Fable 5', 'tier_10_50'],
    'claude-fable-5-1': ['Fable 5.1', 'tier_10_50_cache_read_0_25'],
  },
};

// Claude's fallback for a model it has no price for ($5 / $25).
const FALLBACK_TIER = 'tier_5_25';
const US_INFERENCE_MULTIPLIER = 1.1;

// ---------------------------------------------------------------- binary extraction

/** Installed Claude Code binaries, newest first. */
function claudeBinaries() {
  const home = os.homedir();
  const found = [];
  const add = (p) => {
    try {
      const st = fs.statSync(p);
      if (st.isFile()) found.push({ path: p, mtime: st.mtimeMs, size: st.size });
    } catch {}
  };
  const exe = process.platform === 'win32' ? 'claude.exe' : 'claude';
  // Claude Desktop ships its own copy: <appdata>/Claude/claude-code/<ver>/<hash>/claude(.exe)
  const desktop =
    process.platform === 'win32'
      ? path.join(process.env.APPDATA || '', 'Claude', 'claude-code')
      : process.platform === 'darwin'
        ? path.join(home, 'Library', 'Application Support', 'Claude', 'claude-code')
        : path.join(home, '.config', 'Claude', 'claude-code');
  try {
    for (const ver of fs.readdirSync(desktop)) {
      const vdir = path.join(desktop, ver);
      try {
        for (const h of fs.readdirSync(vdir)) add(path.join(vdir, h, exe));
      } catch {}
    }
  } catch {}
  add(path.join(home, '.local', 'bin', exe));
  add(path.join(home, '.claude', 'local', exe));
  return found.sort((a, b) => b.mtime - a.mtime);
}

const NEEDLE = Buffer.from('schema_version:1,pricing_tiers:');

/** Find and parse the baked model catalog inside a Claude binary. */
function extract(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const CH = 32 << 20;
    for (let off = 0; off < size; off += CH - NEEDLE.length) {
      const len = Math.min(CH, size - off);
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, off);
      const i = buf.indexOf(NEEDLE);
      if (i === -1) continue;
      const out = Buffer.alloc(Math.min(120000, size - off - i));
      fs.readSync(fd, out, 0, out.length, off + i);
      return parse(out.toString('latin1'));
    }
  } finally {
    fs.closeSync(fd);
  }
  return null;
}

function parse(text) {
  const num = '([\\d.e+-]+)';
  const tierRe = new RegExp(
    `(\\w+):\\{input:${num},output:${num},cache_write_5m:${num},cache_write_1h:${num},cache_read:${num},web_search:${num}` +
      `(?:,long_prompt:\\{above_prompt_tokens:${num},input:${num},output:${num},cache_write_5m:${num},cache_write_1h:${num},cache_read:${num}\\})?\\}`,
    'g'
  );
  const modelsAt = text.indexOf('models:[');
  if (modelsAt === -1) return null;

  const tiers = {};
  for (let m; (m = tierRe.exec(text.slice(0, modelsAt))); ) {
    const n = m.slice(2).map(Number);
    tiers[m[1]] = T(n[0], n[1], n[2], n[3], n[4]);
    tiers[m[1]].web_search = n[5];
    if (m[8]) {
      tiers[m[1]].long_prompt = {
        above_prompt_tokens: n[6],
        input: n[7],
        output: n[8],
        cache_write_5m: n[9],
        cache_write_1h: n[10],
        cache_read: n[11],
      };
    }
  }
  const models = {};
  // One block per model, so a field never bleeds into its neighbour. Blocks
  // past the end of the array don't start with a claude- id and are skipped.
  for (const block of text.slice(modelsAt).split('{id:"').slice(1)) {
    const id = /^(claude-[\w.-]+)",family:/.exec(block);
    const name = /display_name:"([^"]+)"/.exec(block);
    const tier = /pricing:"(\w+)"/.exec(block);
    if (id && tier && tiers[tier[1]]) models[id[1]] = [name ? name[1] : id[1], tier[1]];
  }
  return Object.keys(tiers).length && Object.keys(models).length ? { tiers, models } : null;
}

// ---------------------------------------------------------------- lookup + cost

class Pricing {
  constructor(table = SNAPSHOT) {
    this.table = table;
    this.cache = new Map();
  }

  /** Re-read the catalog from the newest installed Claude, if it parses. */
  static fromBinary(known) {
    for (const bin of claudeBinaries()) {
      const key = `${bin.path}|${bin.size}|${bin.mtime}`;
      if (known && known.key === key) return { pricing: new Pricing(known.table), key, table: known.table };
      try {
        const table = extract(bin.path);
        if (table) return { pricing: new Pricing(table), key, table };
      } catch {}
    }
    return { pricing: new Pricing(SNAPSHOT), key: null, table: null };
  }

  /** "claude-opus-5-5", "claude-haiku-4-5-20251001", "claude-opus-5-5[1m]" -> catalog entry. */
  model(id) {
    if (this.cache.has(id)) return this.cache.get(id);
    const bare = String(id || '').replace(/\[.*\]$/, '').replace(/-\d{8}$/, '');
    const models = this.table.models;
    let key = models[bare] ? bare : null;
    if (!key) {
      // Longest catalog id the model id starts with.
      for (const k of Object.keys(models)) if (bare.startsWith(k) && (!key || k.length > key.length)) key = k;
    }
    const entry = key
      ? { id: key, name: models[key][0], tier: this.table.tiers[models[key][1]] }
      : { id: bare, name: null, tier: this.table.tiers[FALLBACK_TIER] || SNAPSHOT.tiers[FALLBACK_TIER] };
    this.cache.set(id, entry);
    return entry;
  }

  /** USD for one assistant message's usage block. */
  cost(modelId, u) {
    let p = this.model(modelId).tier;
    const input = u.input_tokens || 0;
    const read = u.cache_read_input_tokens || 0;
    const write = u.cache_creation_input_tokens || 0;
    if (p.long_prompt && input + read + write > p.long_prompt.above_prompt_tokens) {
      p = { ...p, ...p.long_prompt };
    }
    const w1h = Math.min((u.cache_creation && u.cache_creation.ephemeral_1h_input_tokens) || 0, write);
    const searches = (u.server_tool_use && u.server_tool_use.web_search_requests) || 0;
    const usd =
      (input * p.input +
        (u.output_tokens || 0) * p.output +
        read * p.cache_read +
        w1h * p.cache_write_1h +
        (write - w1h) * p.cache_write_5m) /
        1e6 +
      searches * (p.web_search || 0.01);
    return u.inference_geo === 'us' ? usd * US_INFERENCE_MULTIPLIER : usd;
  }
}

module.exports = { Pricing, SNAPSHOT, extract, claudeBinaries };
