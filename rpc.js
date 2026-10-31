#!/usr/bin/env node
'use strict';

/**
 * Claude -> Discord Rich Presence, starring Clawd.
 *
 * Mirrors what Claude is doing into your Discord profile, using the state
 * Claude Code itself publishes in ~/.claude/sessions (busy / idle / blocked on
 * you) plus an incremental read of the session transcript for the details.
 *
 * Zero dependencies. Node 18+.
 *
 *   node rpc.js              run the daemon (one instance; a second exits)
 *   node rpc.js --status     print the card it would show right now, then exit
 *   node rpc.js --once       connect, push one update, exit
 *   node rpc.js --stop       stop a running daemon (clears the presence)
 *   node rpc.js --log        log to rpc.log (rotated) instead of stdout
 */

const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');

const claude = require('./lib/claude');
const { Transcript } = require('./lib/transcript');
const presence = require('./lib/presence');
const { DiscordIPC } = require('./lib/discord');
const { Stats } = require('./lib/stats');
const update = require('./lib/update');
const procs = require('./lib/procs');
const blocklist = require('./lib/blocklist');
const { spawn } = require('child_process');

const argv = process.argv.slice(2);
const flag = (f) => argv.includes(f);

// ---------------------------------------------------------------- config

const DEFAULTS = {
  clientId: '',
  // How much leaves your machine:
  //   "full"    session title, file names, commands
  //   "project" project folder name and a generic verb ("Writing code")
  //   "minimal" just "Working with Claude"
  privacy: 'full',
  // Folder-name globs that always get "minimal", whatever privacy says.
  hideProjects: [],
  showWhenIdle: true,
  // 3 = "Watching". Discord shows only one type-0 ("Playing") activity per
  // user, so a game or the Unity editor would silently hide a "Playing" card.
  activityType: 3,
  // Which line names you in the member list: null = app name, 1 = state,
  // 2 = details. Leave null unless you want the session title up there.
  statusDisplay: null,
  // "smart": this turn's time while working, time blocked while waiting on
  // you, session time otherwise. "session": always since the session opened.
  timer: 'smart',
  // Keep showing the last tool this long after it returns (no flicker).
  toolDwellSeconds: 12,
  // After a turn ends, show "Done" this long before dozing off.
  doneSeconds: 300,
  // While dozing, rotate lifetime stats through the card. Remove entries to
  // hide them (e.g. "cost"); [] turns rotation off.
  idleStats: ['session', 'lifetime', 'churn', 'cost', 'week', 'hotspot', 'models', 'alltime', 'cache', 'streak'],
  idleRotateSeconds: 15,
  statsRefreshMinutes: 10,
  // The API-equivalent cost at the front of the card, at all times: "both"
  // (today and all-time), "today", "all", or false to keep it private.
  showCost: 'both',
  // Installs made by install.ps1 update themselves from GitHub (git checkouts
  // never do). Checked a minute after start, then every updateCheckHours.
  // Evil Clawd cracking encryption while IDA Pro is open, or while Claude is
  // using an IDA MCP server.
  idaEvil: true,
  autoUpdate: true,
  updateCheckHours: 6,
  // While idle Clawd plays like a pet: one of these vignettes, reshuffled
  // every petMinutes. Remove any you don't want.
  pets: ['credits', 'bug', 'cursor', 'nap'],
  petMinutes: 3,
  // Animated Clawd: the URL where assets/clawd/*.gif are hosted. Empty falls
  // back to the static Discord art-asset keys in `assets`.
  images: { baseUrl: '', version: '' },
  assets: { largeImage: 'claude', smallImageBusy: 'busy', smallImageIdle: 'idle' },
  buttons: [],
  // Add a "View on GitHub" button when the project has a github.com origin.
  // Off by default: it would publish private repo URLs too.
  githubButton: false,
  pollIntervalMs: 2000,
  switchGraceMs: 15000,
};

function loadConfig() {
  // Layered: built-in defaults < config.example.json (shipped, so updates to
  // the hosted art reach everyone) < config.json (yours, overrides only).
  const read = (name) => {
    try {
      // Allow // comments so the files can document themselves.
      return JSON.parse(fs.readFileSync(path.join(__dirname, name), 'utf8').replace(/^\s*\/\/.*$/gm, ''));
    } catch (err) {
      if (err.code !== 'ENOENT') die(`${name} is not valid JSON: ${err.message}`);
      return {};
    }
  };
  const layers = [DEFAULTS, read('config.example.json'), read('config.json')];
  const cfg = Object.assign({}, ...layers);
  for (const k of ['images', 'assets']) cfg[k] = Object.assign({}, ...layers.map((l) => l[k] || {}));
  cfg.clientId = String(cfg.clientId || process.env.CLAUDE_RPC_CLIENT_ID || '').trim();
  for (const arg of argv) {
    const m = /^--([a-z-]+)=(.*)$/.exec(arg);
    if (!m) continue;
    if (m[1] === 'privacy') cfg.privacy = m[2];
    else if (m[1] === 'client-id') cfg.clientId = m[2];
    else if (m[1] === 'image-base') cfg.images.baseUrl = m[2];
  }
  if (!['full', 'project', 'minimal'].includes(cfg.privacy)) {
    die(`privacy must be "full", "project" or "minimal" (got "${cfg.privacy}")`);
  }
  return cfg;
}

// ---------------------------------------------------------------- logging

const LOG_FILE = path.join(__dirname, 'rpc.log');
const LOG_MAX = 1024 * 1024;
let logSize = -1;

function log(...a) {
  const line = `[claude-rpc] ${new Date().toTimeString().slice(0, 8)} ${a.join(' ')}`;
  if (!flag('--log')) return console.log(line);
  try {
    if (logSize < 0) logSize = fs.existsSync(LOG_FILE) ? fs.statSync(LOG_FILE).size : 0;
    if (logSize > LOG_MAX) {
      fs.renameSync(LOG_FILE, LOG_FILE + '.1');
      logSize = 0;
    }
    fs.appendFileSync(LOG_FILE, line + '\n');
    logSize += line.length + 1;
  } catch {}
}

function die(msg) {
  console.error(`[claude-rpc] ${msg}`);
  process.exit(1);
}

// ---------------------------------------------------------------- state

const CFG = loadConfig();
const transcripts = new Map();
let currentId = null;
// Lifetime stats: last known numbers load from cache instantly; scans run in a worker.
const stats = new Stats(claude.PROJECTS_DIR, log);

/** Read everything and decide what the card should say. */
function snapshot() {
  const live = claude.liveSessions();
  const liveIds = new Set(live.map((s) => s.sessionId));
  for (const id of transcripts.keys()) if (!liveIds.has(id)) transcripts.delete(id);

  for (const s of live) {
    let t = transcripts.get(s.sessionId);
    if (!t) {
      const p = claude.transcriptPath(s);
      if (p) transcripts.set(s.sessionId, (t = new Transcript(p)));
    }
    if (t) t.update();
    s.t = t;
  }
  const chosen = presence.pick(live, currentId, CFG.switchGraceMs);
  currentId = chosen ? chosen.sessionId : null;
  const env = { ida: CFG.idaEvil !== false && procs.idaRunning() };
  return { activity: presence.build(live, chosen, CFG, Date.now(), stats.summary, env), chosen, live };
}

const strip = (a) => {
  if (!a) return a;
  const { _scene, _summary, _art, ...clean } = a;
  return clean;
};

// ---------------------------------------------------------------- --status

function printCard(a) {
  if (!a) return console.log('(presence would be cleared: no live session and showWhenIdle is false)');
  const kinds = { 0: 'Playing', 2: 'Listening to', 3: 'Watching', 5: 'Competing in' };
  const el = a.timestamps ? fmtElapsed(Date.now() - a.timestamps.start) + ' elapsed' : '';
  const art = (a.assets && a.assets.large_image) || '(app icon)';
  const rows = [
    `${kinds[a.type] || 'Playing'} <app name>`,
    `  ${a.details}`,
    `  ${a.state}`,
    el && `  ${el}`,
    '',
    `  scene     ${a._scene}  (art: ${a._art})`,
    `  image     ${art}`,
    a.assets && a.assets.large_text && `  hover     ${a.assets.large_text}`,
    a.assets && a.assets.small_text && `  badge     ${a.assets.small_text}`,
    a.buttons && `  buttons   ${a.buttons.map((b) => b.label).join(', ')}`,
  ].filter((r) => r !== undefined && r !== null && r !== false);
  console.log(rows.join('\n'));
}

function fmtElapsed(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const p = (n) => String(n).padStart(2, '0');
  return s >= 3600 ? `${Math.floor(s / 3600)}:${p(Math.floor(s / 60) % 60)}:${p(s % 60)}` : `${p(Math.floor(s / 60))}:${p(s % 60)}`;
}

if (flag('--status')) {
  const { activity, live } = snapshot();
  if (flag('--json')) console.log(JSON.stringify(strip(activity), null, 2));
  else {
    printCard(activity);
    console.log(`\n  ${live.length} live session${live.length === 1 ? '' : 's'}:`);
    for (const s of live) {
      const st = presence.resolve(s, CFG, Date.now());
      console.log(`  ${s.sessionId === currentId ? '>' : ' '} ${st.scene.padEnd(10)} ${(s.name || (s.t && s.t.title) || s.sessionId).slice(0, 44)}`);
    }
    if (stats.summary) {
      const ctx = { privacy: CFG.privacy, title: 'this session', project: 'this project', model: 'Opus 5.5', hidden: presence.hiddenPath(CFG), frames: CFG.idleStats };
      const frames = presence.statFrames(stats.summary, ctx, Date.now());
      console.log(`\n  idle rotation (every ${CFG.idleRotateSeconds}s):`);
      for (const f of frames) console.log(`    ${presence.scrub(f.details).padEnd(36)} ${presence.scrub(f.state)}`);
    } else console.log('\n  idle rotation: no stats yet (the daemon builds them on first run)');
  }
  process.exit(0);
}

// ---------------------------------------------------------------- single instance

/**
 * A named pipe doubles as the instance lock and a control channel: a second
 * daemon finds it taken and exits, and `--stop` sends "stop" down it.
 */
const CONTROL =
  process.platform === 'win32'
    ? `\\\\.\\pipe\\claude-discord-rpc-${os.userInfo().username.replace(/\W/g, '')}`
    : path.join(os.tmpdir(), `claude-discord-rpc-${process.getuid ? process.getuid() : 'u'}.sock`);

if (flag('--stop')) {
  const c = net.createConnection(CONTROL);
  c.on('error', () => {
    console.log('not running');
    process.exit(0);
  });
  c.on('connect', () => c.end('stop\n'));
  c.on('close', () => {
    console.log('stopped');
    process.exit(0);
  });
  return;
}

if (!CFG.clientId) {
  die(
    'no clientId. Create an app at https://discord.com/developers/applications,\n' +
      '           copy its Application ID into config.json, then run again.'
  );
}

let ipc;
let shuttingDown = false;

function shutdown(why) {
  if (shuttingDown) return;
  shuttingDown = true;
  log(`${why}, clearing presence`);
  try {
    ipc && ipc.close();
  } catch {}
  setTimeout(() => process.exit(0), 300);
}

const control = net.createServer((conn) => {
  conn.on('data', (d) => {
    if (String(d).trim() === 'stop') {
      conn.end();
      shutdown('stop requested');
    }
  });
  conn.on('error', () => {});
});

// After a self-update the old daemon is still letting go of the pipe when we
// start, so the successor retries for a few seconds instead of bowing out.
let lockTries = flag('--after-update') ? 20 : 0;

control.on('error', (err) => {
  if (err.code !== 'EADDRINUSE') die(`control socket: ${err.message}`);
  // Stale unix socket from a crash? Probe it before giving up.
  const probe = net.createConnection(CONTROL);
  probe.on('connect', () => {
    probe.end();
    if (lockTries-- > 0) return setTimeout(() => control.listen(CONTROL, start), 500);
    log('already running - exiting (use --stop to stop it)');
    process.exit(0);
  });
  probe.on('error', () => {
    if (process.platform !== 'win32') {
      try {
        fs.unlinkSync(CONTROL);
      } catch {}
      control.listen(CONTROL, start);
    } else if (lockTries-- > 0) setTimeout(() => control.listen(CONTROL, start), 500);
    else die('control pipe is busy');
  });
});
control.listen(CONTROL, start);

/** Hand over to a fresh process running the just-installed code. */
function restartAfterUpdate(version) {
  shuttingDown = true;
  log(`updated to ${version} - restarting`);
  control.close();
  try {
    ipc && ipc.close();
  } catch {}
  const args = [path.join(__dirname, 'rpc.js'), ...argv.filter((a) => a !== '--after-update'), '--after-update'];
  spawn(process.execPath, args, { cwd: __dirname, detached: true, stdio: 'ignore', windowsHide: true }).unref();
  setTimeout(() => process.exit(0), 300);
}

async function checkForUpdate() {
  if (shuttingDown) return;
  try {
    const v = await update.check();
    if (v) restartAfterUpdate(v);
  } catch (err) {
    log(`update check failed: ${err.message}`);
  }
}

// ---------------------------------------------------------------- daemon

function start() {
  ipc = new DiscordIPC(CFG.clientId, log);
  let backoff = 2000;
  let lastLine = '';

  const push = () => {
    if (shuttingDown) return;
    // On the maintainer's blocklist: show nothing, keep checking.
    if (blocklist.isBlocked(ipc.user)) {
      const line = `disabled for ${ipc.user.username} by the project's blocklist - presence cleared`;
      if (line !== lastLine) {
        lastLine = line;
        log(line);
      }
      ipc.setActivity(null);
      return;
    }
    let snap;
    try {
      snap = snapshot();
    } catch (err) {
      log(`could not read session state: ${err.stack || err.message}`);
      return;
    }
    const a = snap.activity;
    const line = a ? `${a._art.padEnd(18)} ${a.details} | ${a.state}` : 'presence cleared';
    if (line !== lastLine) {
      lastLine = line;
      log(line);
    }
    ipc.setActivity(strip(a));
    watchTranscript(snap.chosen);
  };

  // Event-driven: react to session-file and transcript writes within ~150ms,
  // with a slow poll underneath for time-based changes (done -> idle, etc.).
  let debounce = null;
  const soon = () => {
    clearTimeout(debounce);
    debounce = setTimeout(push, 150);
  };
  try {
    fs.watch(claude.SESSIONS_DIR, soon).on('error', () => {});
  } catch {}

  let watched = null;
  let watcher = null;
  function watchTranscript(s) {
    const file = s && s.t && s.t.file;
    if (file === watched) return;
    if (watcher) watcher.close();
    watcher = null;
    watched = file;
    if (!file) return;
    try {
      watcher = fs.watch(file, soon);
      watcher.on('error', () => {});
    } catch {}
  }

  claude.onVerified = soon;
  setInterval(push, CFG.pollIntervalMs);

  if (Array.isArray(CFG.idleStats) && CFG.idleStats.length) {
    stats.refresh();
    // A cost on the card at all times should be close to live: rescan every minute.
    const every = CFG.showCost ? Math.min(CFG.statsRefreshMinutes, 1) : CFG.statsRefreshMinutes;
    setInterval(() => stats.refresh(), every * 60000);
  }

  blocklist.refresh().then(push);
  setInterval(() => blocklist.refresh().then(push), 30 * 60000);

  if (CFG.autoUpdate) {
    setTimeout(checkForUpdate, 60000);
    setInterval(checkForUpdate, CFG.updateCheckHours * 3600000);
  }

  ipc.onReady = (data) => {
    log(`connected to Discord as ${(data.user && data.user.username) || 'unknown'}`);
    backoff = 2000;
    lastLine = '';
    push();
    if (flag('--once')) setTimeout(() => shutdown('--once done'), 1500);
  };
  ipc.onClose = (err) => {
    if (shuttingDown) return;
    log(`disconnected: ${err.message} - retrying in ${Math.round(backoff / 1000)}s`);
    setTimeout(() => ipc.connect(0), backoff);
    backoff = Math.min(backoff * 2, 60000);
  };

  log(`v${update.localVersion()} watching ${claude.CLAUDE_DIR} (privacy=${CFG.privacy}, art=${CFG.images.baseUrl ? 'animated' : 'static'})`);
  ipc.connect(0);
}

for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => shutdown(sig));
process.on('uncaughtException', (err) => {
  log(`crashed: ${err.stack || err.message}`);
  shutdown('crash');
});
