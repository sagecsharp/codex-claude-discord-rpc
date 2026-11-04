'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { setTimeout: delay } = require('node:timers/promises');
const { DiscordIPC } = require('../lib/discord');

function frame(op, value) {
  const payload = Buffer.from(JSON.stringify(value));
  const header = Buffer.alloc(8);
  header.writeUInt32LE(op, 0);
  header.writeUInt32LE(payload.length, 4);
  return Buffer.concat([header, payload]);
}

class Socket extends EventEmitter {
  constructor() { super(); this.writes = []; this.destroyed = false; this.ended = false; }
  write(data) { this.writes.push(data); return true; }
  destroy() { this.destroyed = true; }
  end() { this.ended = true; }
  messages() { return this.writes.map((buffer) => ({ op: buffer.readUInt32LE(0), ...JSON.parse(buffer.subarray(8).toString()) })); }
}

function fixture(t, options = {}) {
  const socket = new Socket();
  const logs = [];
  const ipc = new DiscordIPC('123456789', (message) => logs.push(message), {
    createConnection: () => socket, ...options,
  });
  ipc.connect();
  socket.emit('connect');
  t.after(() => ipc.close());
  function ready() { socket.emit('data', frame(1, { cmd: 'DISPATCH', evt: 'READY', data: {} })); }
  function ack(message) { socket.emit('data', frame(1, { cmd: 'SET_ACTIVITY', nonce: message.nonce, data: { ok: true } })); }
  return { ipc, socket, logs, ready, ack };
}

test('handshake supports fragmented headers and coalesced messages', (t) => {
  const f = fixture(t); let readyCount = 0;
  f.ipc.onReady = () => readyCount++;
  assert.deepEqual(f.socket.messages()[0], { op: 0, v: 1, client_id: '123456789' });
  const input = Buffer.concat([frame(1, { evt: 'READY', data: {} }), frame(3, { nonce: 'ping' })]);
  f.socket.emit('data', input.subarray(0, 3));
  f.socket.emit('data', input.subarray(3, 11));
  assert.equal(f.ipc.ready, false);
  f.socket.emit('data', input.subarray(11));
  assert.equal(f.ipc.ready, true);
  assert.equal(readyCount, 1);
  assert.equal(f.ipc.handshakeTimer, null);
  assert.deepEqual(f.socket.messages().at(-1), { op: 4, nonce: 'ping' });
});

test('onActivity fires only on a matching acknowledgement, once per command', (t) => {
  const f = fixture(t); f.ready(); const calls = [];
  f.ipc.onActivity = (data, activity) => calls.push({ data, activity });
  f.ipc.setActivity({ details: 'working' });
  const sent = f.socket.messages().at(-1);
  assert.equal(f.ipc.shown, undefined);
  assert.equal(calls.length, 0);
  f.socket.emit('data', frame(1, { cmd: 'SET_ACTIVITY', nonce: 'wrong', data: {} }));
  assert.equal(calls.length, 0);
  f.ack(sent); f.ack(sent);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], { data: { ok: true }, activity: { details: 'working' } });
  assert.equal(f.ipc.shown, JSON.stringify({ details: 'working' }));
});

test('pending and acknowledged identical activities are not sent twice', (t) => {
  const f = fixture(t); f.ready();
  f.ipc.setActivity({ details: 'working' });
  const sent = f.socket.messages().at(-1);
  f.ipc.setActivity({ details: 'working' });
  assert.equal(f.socket.messages().filter((message) => message.cmd === 'SET_ACTIVITY').length, 1);
  f.ack(sent);
  f.ipc.setActivity({ details: 'working' });
  assert.equal(f.socket.messages().filter((message) => message.cmd === 'SET_ACTIVITY').length, 1);
});

test('out of order acknowledgements do not restore older accepted state', (t) => {
  const f = fixture(t); f.ready();
  f.ipc.setActivity({ details: 'first' }); const first = f.socket.messages().at(-1);
  f.ipc.setActivity({ details: 'second' }); const second = f.socket.messages().at(-1);
  f.ack(second); f.ack(first);
  assert.equal(f.ipc.shown, JSON.stringify({ details: 'second' }));
});

test('rejected activity is observable without logging private payload or looping', (t) => {
  const f = fixture(t); f.ready(); let rejected;
  f.ipc.onReject = (error, activity) => { rejected = { error, activity }; };
  f.ipc.setActivity({ details: 'private project' });
  const sent = f.socket.messages().at(-1);
  f.socket.emit('data', frame(1, { cmd: 'SET_ACTIVITY', evt: 'ERROR', nonce: sent.nonce, data: { code: 4000, message: 'private project secret' } }));
  assert.equal(rejected.error.code, 4000);
  assert.deepEqual(rejected.activity, { details: 'private project' });
  assert.ok(f.logs.every((line) => !line.includes('private')));
  f.ipc.setActivity({ details: 'private project' });
  assert.equal(f.socket.messages().filter((message) => message.cmd === 'SET_ACTIVITY').length, 1);
  assert.equal(f.ipc.ready, true);
});

test('five per twenty seconds limit keeps only the latest waiting activity', (t) => {
  let now = 50000;
  const f = fixture(t, { now: () => now }); f.ready();
  for (let i = 0; i < 8; i++) f.ipc.setActivity({ details: `activity ${i}` });
  assert.equal(f.socket.messages().filter((message) => message.cmd === 'SET_ACTIVITY').length, 5);
  assert.ok(f.ipc.flushTimer);
  now += 20001;
  clearTimeout(f.ipc.flushTimer); f.ipc.flushTimer = null;
  f.ipc._flush();
  const messages = f.socket.messages().filter((message) => message.cmd === 'SET_ACTIVITY');
  assert.equal(messages.length, 6);
  assert.equal(messages.at(-1).args.activity.details, 'activity 7');
});

for (const invalid of ['oversize', 'negative', 'json', 'null', 'opcode']) {
  test(`invalid ${invalid} frame closes once`, (t) => {
    const f = fixture(t); let closed = 0;
    f.ipc.onClose = () => closed++;
    let input;
    if (invalid === 'null') input = frame(1, null);
    else if (invalid === 'opcode') input = frame(99, {});
    else {
      input = Buffer.alloc(9); input.writeUInt32LE(1, 0);
      input.writeUInt32LE(invalid === 'oversize' ? 1024 * 1024 + 1 : invalid === 'negative' ? 0xffffffff : 1, 4);
      input[8] = 120;
    }
    f.socket.emit('data', input);
    f.socket.emit('error', new Error('late error'));
    f.socket.emit('close');
    assert.equal(closed, 1);
    assert.equal(f.ipc.ready, false);
    assert.equal(f.ipc.sock, null);
    assert.equal(f.ipc.handshakeTimer, null);
  });
}

test('handshake timeout reports a closed connection and permits reconnect', async (t) => {
  const f = fixture(t, { handshakeTimeoutMs: 10 }); const failures = [];
  f.ipc.onClose = (error) => failures.push(error.message);
  await delay(25);
  assert.deepEqual(failures, ['Discord handshake timed out']);
  assert.equal(f.ipc.sock, null);
  assert.equal(f.ipc.ready, false);
});

test('socket search retries failures but reports the exhausted scan only once', () => {
  const sockets = []; let closed = 0;
  const ipc = new DiscordIPC('123', null, { createConnection: () => { const socket = new Socket(); sockets.push(socket); return socket; } });
  ipc.onClose = () => closed++;
  ipc.connect();
  for (let i = 0; i < 10; i++) { sockets[i].emit('error', new Error('not found')); sockets[i].emit('close'); }
  assert.equal(sockets.length, 10);
  assert.equal(closed, 1);
  assert.equal(ipc.connecting, false);
  ipc.close();
});

test('close cancels connection attempts and delayed rate-limit flushes', async (t) => {
  const f = fixture(t); f.ready(); let closed = 0;
  f.ipc.onClose = () => closed++;
  for (let i = 0; i < 6; i++) f.ipc.setActivity({ details: `activity ${i}` });
  assert.ok(f.ipc.flushTimer);
  f.ipc.close();
  const count = f.socket.writes.length;
  assert.equal(f.ipc.ready, false);
  assert.equal(f.ipc.flushTimer, null);
  assert.equal(f.ipc.handshakeTimer, null);
  assert.equal(f.ipc.pending.size, 0);
  assert.equal(f.socket.ended, true);
  f.socket.emit('close');
  await delay(5);
  assert.equal(f.socket.writes.length, count);
  assert.equal(closed, 0);

  const pending = new Socket(); let attempts = 0;
  const ipc = new DiscordIPC('123', null, { connectTimeoutMs: 5, createConnection: () => { attempts++; return pending; } });
  ipc.connect(); ipc.close();
  await delay(15);
  assert.equal(attempts, 1);
  assert.equal(pending.destroyed, true);
});
