'use strict';

/**
 * Minimal Discord RPC client over the desktop app's local IPC socket, plus a
 * rate limiter that respects SET_ACTIVITY's 5-per-20s budget while always
 * delivering the latest state (never a stale queued one).
 */

const net = require('net');
const path = require('path');
const crypto = require('crypto');

const OP = { HANDSHAKE: 0, FRAME: 1, CLOSE: 2, PING: 3, PONG: 4 };
const RATE = { count: 5, windowMs: 20000 };
const MAX_FRAME_BYTES = 1024 * 1024;

function pipePath(i) {
  if (process.platform === 'win32') return `\\\\.\\pipe\\discord-ipc-${i}`;
  const dir = process.env.XDG_RUNTIME_DIR || process.env.TMPDIR || process.env.TMP || '/tmp';
  return path.join(dir, `discord-ipc-${i}`);
}

class DiscordIPC {
  constructor(clientId, log, options = {}) {
    this.clientId = clientId;
    this.log = log || (() => {});
    this.sock = null;
    this.ready = false;
    this.buf = Buffer.alloc(0);
    this.user = null;
    this.onReady = () => {};
    this.onClose = () => {};
    this.onActivity = () => {};
    this.onReject = () => {};

    this.createConnection = options.createConnection || net.createConnection;
    this.now = options.now || Date.now;
    this.connectTimeoutMs = options.connectTimeoutMs ?? 1500;
    this.handshakeTimeoutMs = options.handshakeTimeoutMs ?? 5000;
    this.connectTimer = null;
    this.handshakeTimer = null;
    this.pendingSocket = null;
    this.connecting = false;
    this.generation = 0;
    this.pending = new Map();
    this.sequence = 0;
    this.acceptedSequence = 0;
    this.lastSentKey = undefined;
    this.rejectedKey = undefined;

    this.sent = []; //    send timestamps inside the rate window
    this.want = undefined; // latest activity we want shown (null = clear)
    this.shown = undefined; // JSON of what Discord last accepted from us
    this.flushTimer = null;
  }

  connect(index = 0) {
    if (this.sock || this.connecting) return;
    this.connecting = true;
    this._connect(index, ++this.generation);
  }

  _connect(index, generation) {
    if (generation !== this.generation) return;
    if (index > 9) {
      this.connecting = false;
      this.onClose(new Error('no Discord IPC socket found (is the Discord desktop app running?)'));
      return;
    }
    let sock;
    try { sock = this.createConnection(pipePath(index)); }
    catch { return this._connect(index + 1, generation); }
    this.pendingSocket = sock;
    let settled = false;
    const clean = () => {
      clearTimeout(this.connectTimer);
      this.connectTimer = null;
      sock.removeListener('error', failed);
      sock.removeListener('close', failed);
      sock.removeListener('connect', connected);
    };
    const failed = () => {
      if (settled || generation !== this.generation) return;
      settled = true;
      clean();
      this.pendingSocket = null;
      sock.on('error', () => {});
      sock.destroy();
      this._connect(index + 1, generation);
    };
    const connected = () => {
      if (settled || generation !== this.generation) return;
      settled = true;
      clean();
      this.pendingSocket = null;
      this.connecting = false;
      this.sock = sock;
      this.ready = false;
      this.buf = Buffer.alloc(0);
      sock.on('data', (d) => { if (this.sock === sock) this._onData(d); });
      sock.on('error', (e) => { if (this.sock === sock) this._down(e); });
      sock.on('close', () => { if (this.sock === sock) this._down(new Error('Discord closed the connection')); });
      this.handshakeTimer = setTimeout(() => {
        if (this.sock === sock && !this.ready) this._down(new Error('Discord handshake timed out'));
      }, this.handshakeTimeoutMs);
      this.handshakeTimer.unref?.();
      this._write(OP.HANDSHAKE, { v: 1, client_id: this.clientId });
    };
    sock.once('error', failed);
    sock.once('close', failed);
    sock.once('connect', connected);
    this.connectTimer = setTimeout(failed, this.connectTimeoutMs);
    this.connectTimer.unref?.();
  }

  _down(err) {
    if (!this.sock) return;
    this.sock.removeAllListeners();
    this.sock.on('error', () => {});
    this.sock.destroy();
    this.sock = null;
    this.ready = false;
    this.user = null;
    this.buf = Buffer.alloc(0);
    this.shown = undefined;
    this.lastSentKey = undefined;
    this.rejectedKey = undefined;
    this.pending.clear();
    clearTimeout(this.handshakeTimer);
    this.handshakeTimer = null;
    clearTimeout(this.flushTimer);
    this.flushTimer = null;
    this.onClose(err);
  }

  _write(op, data) {
    if (!this.sock || this.sock.destroyed) return false;
    const payload = Buffer.from(JSON.stringify(data), 'utf8');
    const header = Buffer.alloc(8);
    header.writeInt32LE(op, 0);
    header.writeInt32LE(payload.length, 4);
    try { this.sock.write(Buffer.concat([header, payload])); return true; }
    catch (error) { this._down(error); return false; }
  }

  _onData(chunk) {
    this.buf = Buffer.concat([this.buf, chunk]);
    while (this.buf.length >= 8) {
      const op = this.buf.readUInt32LE(0);
      const len = this.buf.readUInt32LE(4);
      if (op > OP.PONG || len > MAX_FRAME_BYTES) return this._down(new Error('invalid Discord IPC frame'));
      if (this.buf.length < 8 + len) break;
      let msg = {};
      try {
        msg = JSON.parse(this.buf.toString('utf8', 8, 8 + len));
      } catch { return this._down(new Error('invalid Discord IPC JSON')); }
      this.buf = this.buf.subarray(8 + len);

      if (op === OP.FRAME && (!msg || typeof msg !== 'object' || Array.isArray(msg))) {
        return this._down(new Error('invalid Discord IPC message'));
      }

      if (op === OP.PING) this._write(OP.PONG, msg);
      else if (op === OP.CLOSE) return this._down(new Error('Discord sent CLOSE'));
      else if (op === OP.FRAME) this._frame(msg);
      if (!this.sock) return;
    }
  }

  _frame(msg) {
    if (msg.evt === 'READY') {
      if (this.ready) return;
      clearTimeout(this.handshakeTimer);
      this.handshakeTimer = null;
      this.ready = true;
      this.user = msg.data && msg.data.user;
      this.onReady(msg.data || {});
      this._flush();
      return;
    }
    if (msg.evt === 'ERROR') {
      const d = msg.data || {};
      // Before READY an error means the handshake failed (bad client id).
      // After it, it's one rejected command: report it, keep the connection.
      if (!this.ready) return this._down(new Error(`Discord handshake error (${d.code || 'unknown'})`));
      const pending = this.pending.get(msg.nonce);
      if (!pending) return;
      this.pending.delete(msg.nonce);
      this._pendingKey();
      this.rejectedKey = pending.key;
      const error = new Error(`Discord rejected the activity (${d.code || 'unknown'})`);
      error.code = d.code;
      this.log(error.message);
      this.onReject(error, pending.activity);
      return;
    }
    if (msg.cmd === 'SET_ACTIVITY' && !msg.evt && this.pending.has(msg.nonce)) {
      const pending = this.pending.get(msg.nonce);
      this.pending.delete(msg.nonce);
      this._pendingKey();
      if (pending.sequence > this.acceptedSequence) {
        this.shown = pending.key;
        this.acceptedSequence = pending.sequence;
      }
      this.onActivity(msg.data || {}, pending.activity);
      this._flush();
    }
  }

  _pendingKey() {
    const latest = [...this.pending.values()].at(-1);
    this.lastSentKey = latest?.key;
  }

  /** Ask for `activity` to be shown (null clears). Sends now or when the budget allows. */
  setActivity(activity) {
    if (JSON.stringify(activity) !== this.rejectedKey) this.rejectedKey = undefined;
    this.want = activity;
    this._flush();
  }

  _flush() {
    if (!this.ready || this.want === undefined) return;
    const key = JSON.stringify(this.want);
    if (key === this.shown || key === this.lastSentKey || key === this.rejectedKey) return;

    const now = this.now();
    this.sent = this.sent.filter((t) => now - t < RATE.windowMs);
    if (this.sent.length >= RATE.count) {
      if (!this.flushTimer) {
        const wait = RATE.windowMs - (now - this.sent[0]) + 50;
        this.flushTimer = setTimeout(() => {
          this.flushTimer = null;
          this._flush();
        }, wait);
      }
      return;
    }
    const nonce = crypto.randomUUID();
    this.pending.set(nonce, { key, activity: this.want, sequence: ++this.sequence });
    // Bound memory even when a broken client never acknowledges commands.
    if (this.pending.size > 32) this.pending.delete(this.pending.keys().next().value);
    this.lastSentKey = key;
    if (this._write(OP.FRAME, {
      cmd: 'SET_ACTIVITY',
      args: { pid: process.pid, activity: this.want || undefined },
      nonce,
    })) this.sent.push(now);
  }

  close() {
    ++this.generation;
    this.connecting = false;
    clearTimeout(this.connectTimer);
    this.connectTimer = null;
    clearTimeout(this.handshakeTimer);
    this.handshakeTimer = null;
    clearTimeout(this.flushTimer);
    this.flushTimer = null;
    if (this.pendingSocket) {
      this.pendingSocket.removeAllListeners();
      this.pendingSocket.on('error', () => {});
      this.pendingSocket.destroy();
      this.pendingSocket = null;
    }
    // Bypass the limiter: this is the last thing we'll ever send.
    if (this.ready) this._write(OP.FRAME, { cmd: 'SET_ACTIVITY', args: { pid: process.pid }, nonce: crypto.randomUUID() });
    const s = this.sock;
    this.sock = null;
    this.ready = false;
    this.user = null;
    this.buf = Buffer.alloc(0);
    this.pending.clear();
    this.shown = undefined;
    this.lastSentKey = undefined;
    this.rejectedKey = undefined;
    this.want = undefined;
    if (!s) return;
    s.removeAllListeners();
    s.on('error', () => {});
    s.end();
    const timer = setTimeout(() => s.destroy(), 200);
    timer.unref?.();
  }
}

module.exports = { DiscordIPC };
