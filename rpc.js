#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { loadConfig } = require('./lib/config');
const { CodexReader } = require('./lib/codex');
const { ClaudeReader } = require('./lib/claude-reader');
const { OpencodeReader } = require('./lib/opencode');
const { buildActivity } = require('./lib/dual-presence');
const { DiscordIPC } = require('./lib/discord');
const { LifetimeHistory } = require('./lib/history');
const argv = process.argv.slice(2);
const has = (flag) => argv.includes(flag);
const controlPath = process.platform === 'win32'
  ? `\\\\.\\pipe\\codex-claude-rpc-${os.userInfo().username.replace(/\W/g, '')}`
  : path.join(os.tmpdir(), `codex-claude-rpc-${process.getuid?.() ?? 'user'}.sock`);

function log(message) {
  const line = `[dual-rpc] ${new Date().toISOString()} ${message}`;
  if (!has('--log')) return console.log(line);
  const file = path.join(__dirname, 'rpc.log');
  try {
    if (fs.existsSync(file) && fs.statSync(file).size > 1024 * 1024) {
      fs.rmSync(`${file}.1`, { force: true }); fs.renameSync(file, `${file}.1`);
    }
    fs.appendFileSync(file, `${line}\n`);
  } catch { /* logging must not take down presence */ }
}

async function main() {
  if (has('--help')) {
    console.log('codex + claude discord presence\n\nnode scripts/setup.js         configure discord and image hosting\nnode rpc.js                  run\nnode rpc.js --status --json   preview locally\nnode rpc.js --idle --status   preview lifetime totals\nnode rpc.js --stats           local lifetime usage and pricing coverage\nnode rpc.js --demo --status   sample data preview\nnode rpc.js --once            verify one update, clear and exit\nnode rpc.js --stop            stop this fork\n\noptions: --client-id=ID --image-base=https://.../assets --config=FILE');
    return;
  }
  if (has('--stop')) {
    const sock = net.createConnection(controlPath);
    sock.setTimeout(3000, () => sock.destroy());
    sock.on('connect', () => sock.end('stop\n'));
    sock.on('data', () => {});
    sock.on('error', () => console.log('not running'));
    sock.on('close', () => process.exit(0));
    return;
  }
  const cfg = loadConfig(__dirname, argv);
  if (has('--idle') && !has('--status') && !has('--once')) throw new Error('--idle requires --status or --once');
  const history = new LifetimeHistory({ cacheFile: path.join(__dirname, 'cache', 'lifetime-v1.json'), roots: {
    codex: cfg.providers.codex ? cfg.codexHistoryRoot || (cfg.codexRoot ? path.dirname(cfg.codexRoot) : process.env.CODEX_HOME || path.join(os.homedir(), '.codex')) : false,
    claude: cfg.providers.claude ? cfg.claudeRoot || process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude') : false,
  } });
  if (has('--demo')) history.value = { ready: true, providers: {
    codex: { total: 28400000, costUSD: 51.38, unpricedTokens: 0 },
    claude: { total: 16700000, costUSD: 79.24, unpricedTokens: 0 },
  } };
  else if (has('--stats') || has('--idle')) history.value = await history.readOnce();
  else if (has('--status')) history.value = await history.readOnce(true);
  if (has('--stats')) { console.log(JSON.stringify(history.value, null, 2)); return; }
  const codex = new CodexReader({ root: cfg.codexRoot || undefined, staleMs: cfg.staleMs, idleRetentionMs: cfg.idleRetentionMs });
  const claude = new ClaudeReader({ root: cfg.claudeRoot || undefined, staleMs: cfg.staleMs, retentionMs: cfg.idleRetentionMs });
  const opencode = new OpencodeReader({ root: cfg.opencodeRoot || undefined, staleMs: cfg.staleMs, retentionMs: cfg.idleRetentionMs });
  const demoStart = Date.now();
  const snapshot = () => {
    const now = Date.now();
    const sessions = has('--demo') ? [
      { provider: 'codex', sessionId: 'demo-codex', conversationTitle: 'build a dashboard', model: 'codex', status: 'working', action: 'testing', updatedAt: now, startedAt: demoStart - 240000, tokens: { total: 28400 }, hasUsage: true },
      { provider: 'claude', sessionId: 'demo-claude', conversationTitle: 'polish the settings', model: 'claude', status: 'working', action: 'editing', updatedAt: now, startedAt: demoStart - 360000, tokens: { total: 16700 }, usageComplete: true },
      { provider: 'opencode', sessionId: 'demo-opencode', conversationTitle: 'wire up the login', model: 'deepseek-flash', modelKind: 'deepseek', status: 'working', action: 'searching', updatedAt: now, startedAt: demoStart - 120000, tokens: { total: 0 }, hasUsage: false },
    ] : [...(cfg.providers.codex ? codex.read() : []), ...(cfg.providers.claude ? claude.read() : []), ...(cfg.providers.opencode ? opencode.read() : [])];
    return buildActivity(has('--idle') ? [] : sessions, cfg, now, history.value);
  };
  if (has('--status')) {
    const activity = snapshot();
    if (has('--json')) console.log(JSON.stringify(activity, null, 2));
    else console.log(activity ? `${activity.details}\n${activity.state}\nimage: ${activity.assets?.large_image || 'configure images.baseUrl for animated logos'}` : 'no recent sessions; discord presence would be cleared');
    return;
  }
  if (!/^\d{17,20}$/.test(cfg.clientId)) throw new Error('run node scripts/setup.js and enter your discord application id first');
  let closing = false, ipc, poll, retry, onceTimeout;
  const server = net.createServer((sock) => {
    sock.setTimeout(2000, () => sock.destroy());
    let command = '';
    sock.on('data', (chunk) => {
      command += chunk.toString();
      if (command.length > 32) return sock.destroy();
      if (command.trim() === 'stop') { sock.end('stopped\n'); shutdown(0); }
    });
    sock.on('error', () => {});
  });
  function shutdown(code) {
    if (closing) return;
    closing = true;
    clearInterval(poll); clearTimeout(retry); clearTimeout(onceTimeout);
    server.close(); ipc?.close(); history.close();
    setTimeout(() => process.exit(code), 300);
  }
  function start() {
    if (!has('--demo') && !has('--idle')) history.start();
    ipc = new DiscordIPC(cfg.clientId, log);
    let delay = 2000, last = '', accepted = false;
    const publish = () => {
      if (closing) return;
      try {
        const activity = snapshot();
        const summary = activity ? `${activity.details} | ${activity.state}` : 'presence cleared';
        if (summary !== last) { log(summary); last = summary; }
        ipc.setActivity(activity);
      } catch (err) { log(`could not read activity: ${err.message}`); }
    };
    ipc.onReady = () => { delay = 2000; log('connected to discord'); publish(); };
    ipc.onClose = (err) => {
      if (closing) return;
      accepted = false;
      log(`${err.message}; retrying in ${delay / 1000}s`);
      clearTimeout(retry); retry = setTimeout(() => ipc.connect(), delay);
      delay = Math.min(60000, delay * 2);
    };
    ipc.onActivity = () => {
      if (!accepted) { accepted = true; log('discord accepted the presence'); }
      if (has('--once')) { log('clearing preview'); shutdown(0); }
    };
    ipc.onReject = (err) => { if (has('--once')) { log(`discord rejected the activity: ${err.message}`); shutdown(1); } };
    poll = setInterval(publish, cfg.pollIntervalMs);
    if (has('--once')) onceTimeout = setTimeout(() => { log('no accepted update within 20 seconds'); shutdown(1); }, 20000);
    if (!cfg.images.baseUrl && !cfg.images.portal) log('text only: configure images.baseUrl for animated logos');
    log('watching codex + claude + opencode; local session metadata only');
    ipc.connect();
  }
  server.on('error', (err) => {
    if (err.code !== 'EADDRINUSE') { log(err.message); return shutdown(1); }
    const probe = net.createConnection(controlPath);
    probe.setTimeout(2000, () => { probe.destroy(); shutdown(1); });
    probe.on('connect', () => { probe.end(); log('already running; use --stop first'); shutdown(has('--once') ? 1 : 0); });
    probe.on('error', () => {
      if (process.platform !== 'win32') { fs.rmSync(controlPath, { force: true }); server.listen(controlPath, start); }
      else { log('control pipe is busy'); shutdown(1); }
    });
  });
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => shutdown(0));
  server.listen(controlPath, start);
}
main().catch((err) => { console.error(`[dual-rpc] ${err.message}`); process.exitCode = 1; });
