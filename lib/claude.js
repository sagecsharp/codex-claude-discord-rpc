'use strict';

/**
 * Everything read from ~/.claude: live sessions, their transcripts, and the
 * model catalog. Read-only - nothing is ever written there.
 *
 * Session files (sessions/<pid>.json) are maintained by Claude Code itself and
 * carry the authoritative live state:
 *
 *   status          "busy" | "idle"            set as turns start and end
 *   waitingFor      "dialog open" | "input needed" | "sandbox request" | ...
 *                   present only while a prompt is blocked on the user
 *   statusUpdatedAt ms timestamp of the last status change
 *   procStart       process creation time (a Windows FILETIME on win32), which
 *                   lets us reject a stale file whose pid has been reused
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const CLAUDE_DIR = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
const SESSIONS_DIR = path.join(CLAUDE_DIR, 'sessions');
const PROJECTS_DIR = path.join(CLAUDE_DIR, 'projects');
const CATALOG_DIR = path.join(CLAUDE_DIR, 'cache', 'model-catalog');

// ---------------------------------------------------------------- liveness

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

/**
 * pid reuse guard. A session file outlives a crashed Claude, and Windows hands
 * its pid to the next process, so "pid is alive" alone can resurrect a dead
 * session forever. Claude records the process creation FILETIME as procStart;
 * we compare it to the real one, once per pid, asynchronously.
 */
const verified = new Map(); // `${pid}:${procStart}` -> true | false
const pending = new Set();
let onVerified = () => {};

function verifyProcStart(pid, procStart) {
  if (process.platform !== 'win32' || !procStart) return true;
  const key = `${pid}:${procStart}`;
  if (verified.has(key)) return verified.get(key);
  if (!pending.has(key)) {
    pending.add(key);
    queueVerify();
  }
  return true; // optimistic until the check lands
}

let verifyTimer = null;
function queueVerify() {
  if (verifyTimer) return;
  verifyTimer = setTimeout(() => {
    verifyTimer = null;
    const batch = [...pending];
    pending.clear();
    const pids = [...new Set(batch.map((k) => k.split(':')[0]))].join(',');
    const ps =
      `Get-Process -Id ${pids} -ErrorAction SilentlyContinue | ` +
      `ForEach-Object { "$($_.Id) $($_.StartTime.ToFileTimeUtc())" }`;
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', ps],
      { windowsHide: true, timeout: 15000 },
      (err, stdout) => {
        if (err && !stdout) {
          // Can't tell - treat as genuine rather than hide a real session.
          for (const k of batch) verified.set(k, true);
          return;
        }
        const real = new Map(
          String(stdout)
            .trim()
            .split(/\r?\n/)
            .filter(Boolean)
            .map((l) => l.trim().split(/\s+/))
        );
        let changed = false;
        for (const k of batch) {
          const [pid, start] = k.split(':');
          const ok = real.get(pid) === start;
          verified.set(k, ok);
          if (!ok) changed = true;
        }
        if (changed) onVerified();
      }
    );
  }, 50);
}

// ---------------------------------------------------------------- sessions

/** Live sessions, straight from Claude's own session files. */
function liveSessions() {
  let files;
  try {
    files = fs.readdirSync(SESSIONS_DIR).filter((f) => f.endsWith('.json'));
  } catch {
    return [];
  }
  const out = [];
  for (const f of files) {
    let s;
    try {
      s = JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, f), 'utf8'));
    } catch {
      continue; // mid-write; next tick will see it
    }
    if (!s.pid || !s.sessionId || !pidAlive(s.pid)) continue;
    if (!verifyProcStart(s.pid, s.procStart)) continue;
    out.push(s);
  }
  return out;
}

/** projects/<cwd with every non-alphanumeric as "-">/<sessionId>.jsonl */
const transcriptPaths = new Map();

function transcriptPath(session) {
  const hit = transcriptPaths.get(session.sessionId);
  if (hit && fs.existsSync(hit)) return hit;

  const guess = session.cwd
    ? path.join(PROJECTS_DIR, session.cwd.replace(/[^a-zA-Z0-9]/g, '-'), `${session.sessionId}.jsonl`)
    : null;
  if (guess && fs.existsSync(guess)) {
    transcriptPaths.set(session.sessionId, guess);
    return guess;
  }
  let dirs = [];
  try {
    dirs = fs.readdirSync(PROJECTS_DIR);
  } catch {
    return null;
  }
  for (const d of dirs) {
    const p = path.join(PROJECTS_DIR, d, `${session.sessionId}.jsonl`);
    if (fs.existsSync(p)) {
      transcriptPaths.set(session.sessionId, p);
      return p;
    }
  }
  return null;
}

// ---------------------------------------------------------------- model catalog

/**
 * cache/model-catalog/*.json is the same catalog Claude's model picker uses:
 * display names ("Opus 5.5") and context windows. Reading it means new models
 * show up correctly without this daemon shipping a hardcoded table.
 */
let catalog = { mtime: 0, models: new Map() };

function loadCatalog() {
  let newest = null;
  try {
    for (const f of fs.readdirSync(CATALOG_DIR)) {
      if (!f.endsWith('.json') || f === 'published-floor.json') continue;
      const p = path.join(CATALOG_DIR, f);
      const m = fs.statSync(p).mtimeMs;
      if (!newest || m > newest.m) newest = { p, m };
    }
  } catch {
    return catalog.models;
  }
  if (!newest || newest.m === catalog.mtime) return catalog.models;
  const models = new Map();
  try {
    const j = JSON.parse(fs.readFileSync(newest.p, 'utf8'));
    const list = (j.catalog && j.catalog.config && j.catalog.config.models) || [];
    for (const m of list) {
      if (!m || !m.id) continue;
      models.set(m.id, {
        name: m.name || null,
        contextWindow: (m.runtime && m.runtime.max_input_tokens) || null,
      });
    }
  } catch {
    return catalog.models;
  }
  catalog = { mtime: newest.m, models };
  return models;
}

function modelInfo(id) {
  if (!id) return { name: null, contextWindow: null };
  const models = loadCatalog();
  const bare = id.replace(/\[.*\]$/, '').replace(/-\d{8}$/, '');
  const hit = models.get(id) || models.get(bare);
  if (hit) return hit;
  // "claude-opus-4-5" -> "Opus 4.5"
  const m = /^claude-([a-z]+)-(\d+)(?:-(\d+))?/.exec(bare);
  const name = m
    ? `${m[1][0].toUpperCase()}${m[1].slice(1)} ${m[2]}${m[3] ? '.' + m[3] : ''}`
    : bare.replace(/^claude-/, '');
  return { name, contextWindow: null };
}

module.exports = {
  CLAUDE_DIR,
  SESSIONS_DIR,
  PROJECTS_DIR,
  liveSessions,
  transcriptPath,
  modelInfo,
  set onVerified(fn) {
    onVerified = fn;
  },
};
