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

function pipePath(i) {
  if (process.platform === 'win32') return `\\\\.\\pipe\\discord-ipc-${i}`;
  const dir = process.env.XDG_RUNTIME_DIR || process.env.TMPDIR || process.env.TMP || '/tmp';
  return path.join(dir, `discord-ipc-${i}`);
}

class DiscordIPC {
  constructor(clientId, log) {
    this.clientId = clientId;
    this.log = log || (() => {});
    this.sock = null;
    this.ready = false;
    this.buf = Buffer.alloc(0);
    this.user = null;
    this.onReady = () => {};
    this.onClose = () => {};

    this.sent = []; //    send timestamps inside the rate window
    this.want = undefined; // latest activity we want shown (null = clear)
    this.shown = undefined; // JSON of what Discord last accepted from us
    this.flushTimer = null;
  }

  connect(index = 0) {
    if (index > 9) {
      this.onClose(new Error('no Discord IPC socket found (is the Discord desktop app running?)'));
      return;
    }
    const sock = net.createConnection(pipePath(index));
    sock.once('error', () => {
      sock.destroy();
      this.connect(index + 1);
    });
    sock.once('connect', () => {
      sock.removeAllListeners('error');
      this.sock = sock;
      this.buf = Buffer.alloc(0);
      sock.on('data', (d) => this._onData(d));
      sock.on('error', (e) => this._down(e));
      sock.on('close', () => this._down(new Error('Discord closed the connection')));
      this._write(OP.HANDSHAKE, { v: 1, client_id: this.clientId });
    });
  }

  _down(err) {
    if (!this.sock) return;
    this.sock.removeAllListeners();
    this.sock.destroy();
    this.sock = null;
    this.ready = false;
    this.shown = undefined;
    clearTimeout(this.flushTimer);
    this.flushTimer = null;
    this.onClose(err);
  }

  _write(op, data) {
    if (!this.sock) return;
    const payload = Buffer.from(JSON.stringify(data), 'utf8');
    const header = Buffer.alloc(8);
    header.writeInt32LE(op, 0);
    header.writeInt32LE(payload.length, 4);
    this.sock.write(Buffer.concat([header, payload]));
  }

  _onData(chunk) {
    this.buf = Buffer.concat([this.buf, chunk]);
    while (this.buf.length >= 8) {
      const op = this.buf.readInt32LE(0);
      const len = this.buf.readInt32LE(4);
      if (this.buf.length < 8 + len) break;
      let msg = {};
      try {
        msg = JSON.parse(this.buf.toString('utf8', 8, 8 + len));
      } catch {}
      this.buf = this.buf.subarray(8 + len);

      if (op === OP.PING) this._write(OP.PONG, msg);
      else if (op === OP.CLOSE) return this._down(new Error(msg.message || 'Discord sent CLOSE'));
      else if (op === OP.FRAME) this._frame(msg);
    }
  }

  _frame(msg) {
    if (msg.evt === 'READY') {
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
      if (!this.ready) return this._down(new Error(`Discord error ${d.code}: ${d.message}`));
      this.log(`Discord rejected the activity (${d.code}): ${d.message}`);
      this.shown = undefined;
    }
  }

  /** Ask for `activity` to be shown (null clears). Sends now or when the budget allows. */
  setActivity(activity) {
    this.want = activity;
    this._flush();
  }

  _flush() {
    if (!this.ready || this.want === undefined) return;
    const key = JSON.stringify(this.want);
    if (key === this.shown) return;

    const now = Date.now();
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
    this.sent.push(now);
    this.shown = key;
    this._write(OP.FRAME, {
      cmd: 'SET_ACTIVITY',
      args: { pid: process.pid, activity: this.want || undefined },
      nonce: crypto.randomUUID(),
    });
  }

  close() {
    if (!this.sock) return;
    // Bypass the limiter: this is the last thing we'll ever send.
    this._write(OP.FRAME, { cmd: 'SET_ACTIVITY', args: { pid: process.pid }, nonce: crypto.randomUUID() });
    const s = this.sock;
    this.sock = null;
    s.end();
    setTimeout(() => s.destroy(), 200);
  }
}

module.exports = { DiscordIPC };
