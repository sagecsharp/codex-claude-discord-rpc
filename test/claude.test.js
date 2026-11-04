'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ClaudeReader } = require('../lib/claude-reader');

const NOW = Date.parse('2026-11-03T20:00:00Z');
function fixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-presence-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const sessions = path.join(root, 'sessions');
  const projects = path.join(root, 'projects', 'sample-project');
  fs.mkdirSync(sessions, { recursive: true });
  fs.mkdirSync(projects, { recursive: true });
  const reader = new ClaudeReader({ root, now: () => NOW, processAlive: () => true, ...options });
  function meta(id = 'session-1', data = {}) {
    fs.writeFileSync(path.join(sessions, id + '.json'), JSON.stringify({ sessionId: id, pid: 123, status: 'busy', updatedAt: NOW - 1000, startedAt: NOW - 30000, cwd: '/sample/project', ...data }));
  }
  function log(rows, id = 'session-1', append = false, newline = true) {
    const file = path.join(projects, id + '.jsonl');
    const data = rows.map((row) => typeof row === 'string' ? row : JSON.stringify(row)).join('\n') + (newline ? '\n' : '');
    if (append) fs.appendFileSync(file, data); else fs.writeFileSync(file, data);
    fs.utimesSync(file, new Date(NOW), new Date(NOW));
    return file;
  }
  return { root, sessions, projects, reader, meta, log };
}

function assistant(id, usage, extra = {}) {
  return { type: 'assistant', timestamp: new Date(NOW - 1000).toISOString(), message: { id, model: 'claude-test', content: [{ type: 'thinking', thinking: 'private content' }], usage, ...extra } };
}

test('deduplicates assistant blocks and counts cached tokens as an input subset', (t) => {
  const f = fixture(t); f.meta();
  f.log([
    assistant('m1', { input_tokens: 10, output_tokens: 2, cache_read_input_tokens: 30, cache_creation_input_tokens: 5 }),
    assistant('m1', { input_tokens: 10, output_tokens: 8, cache_read_input_tokens: 30, cache_creation_input_tokens: 5 }),
  ]);
  const [snapshot] = f.reader.read();
  assert.deepEqual(snapshot.tokens, { input: 45, output: 8, total: 53, cachedInput: 30 });
  assert.equal(snapshot.status, 'thinking');
  assert.equal(snapshot.model, 'claude-test');
  assert.equal(snapshot.usageComplete, true);
  assert.ok(!JSON.stringify(snapshot).includes('private content'));
  assert.deepEqual(f.reader.scan(), [snapshot]);
});

test('incrementally appends usage without recounting previous messages', (t) => {
  const f = fixture(t); f.meta(); f.log([assistant('m1', { input_tokens: 10, output_tokens: 2 })]);
  f.reader.read();
  f.log([assistant('m2', { input_tokens: 12, output_tokens: 3 }, { content: [{ type: 'tool_use' }] })], 'session-1', true);
  const [snapshot] = f.reader.read();
  assert.equal(snapshot.tokens.total, 27);
  assert.equal(snapshot.status, 'working');
});

test('partial writes are consumed only once completed', (t) => {
  const f = fixture(t); f.meta();
  const row = JSON.stringify(assistant('m1', { input_tokens: 10, output_tokens: 2 }));
  f.log([row.slice(0, 60)], 'session-1', false, false);
  assert.equal(f.reader.read()[0].tokens.total, 0);
  f.log([row.slice(60)], 'session-1', true);
  assert.equal(f.reader.read()[0].tokens.total, 12);
});

test('cost-state restores complete cumulative counters after a bounded tail read', (t) => {
  const f = fixture(t, { maxReadBytes: 1024 }); f.meta();
  f.log(['x'.repeat(2000), assistant('m1', { input_tokens: 5, output_tokens: 2 }), {
    type: 'cost-state', modelUsage: { 'claude-test': { inputTokens: 100, outputTokens: 20, cacheReadInputTokens: 30, cacheCreationInputTokens: 10 } },
  }]);
  const [snapshot] = f.reader.read();
  assert.deepEqual(snapshot.tokens, { input: 140, output: 20, total: 160, cachedInput: 30 });
  assert.equal(snapshot.usageComplete, true);
});

test('repeated message after cumulative checkpoint adds only its new output', (t) => {
  const f = fixture(t); f.meta();
  f.log([assistant('m1', { input_tokens: 10, output_tokens: 2 }), {
    type: 'cost-state', modelUsage: { model: { inputTokens: 100, outputTokens: 20 } },
  }]);
  f.reader.read();
  f.log([assistant('m1', { input_tokens: 10, output_tokens: 5 })], 'session-1', true);
  assert.deepEqual(f.reader.read()[0].tokens, { input: 100, output: 23, total: 123, cachedInput: 0 });
});

test('dead processes cannot reappear through the transcript fallback', (t) => {
  const f = fixture(t, { processAlive: () => false }); f.meta();
  f.log([assistant('m1', { input_tokens: 1 })]);
  assert.deepEqual(f.reader.read(), []);
});

test('stale sessions turn idle then disappear after retention', (t) => {
  let now = NOW;
  const f = fixture(t, { now: () => now, staleMs: 1000, retentionMs: 5000 });
  f.meta('session-1', { updatedAt: NOW });
  assert.equal(f.reader.read()[0].status, 'working');
  now += 1500;
  assert.equal(f.reader.read()[0].status, 'idle');
  now += 5000;
  assert.deepEqual(f.reader.read(), []);
});

test('metadata waiting and idle override assistant status', (t) => {
  const f = fixture(t); f.meta('session-1', { status: 'waiting' });
  f.log([assistant('m1', { input_tokens: 1 })]);
  assert.equal(f.reader.read()[0].status, 'waiting');
  f.meta('session-1', { status: 'idle' });
  assert.equal(f.reader.read()[0].status, 'idle');
});

test('works without metadata using recent transcript events', (t) => {
  const f = fixture(t);
  f.log([assistant('m1', { input_tokens: 2, output_tokens: 1 }, { stop_reason: 'end_turn' })]);
  assert.equal(f.reader.read()[0].status, 'idle');
});

test('a truncated transcript resets previously accumulated usage', (t) => {
  const f = fixture(t); f.meta();
  f.log([assistant('long-message-id', { input_tokens: 100, output_tokens: 30 })]);
  assert.equal(f.reader.read()[0].tokens.total, 130);
  f.log([assistant('m', { input_tokens: 2, output_tokens: 1 })]);
  assert.equal(f.reader.read()[0].tokens.total, 3);
});

test('ignores bad metadata, malformed rows, sidechains, and disappearing files', (t) => {
  const f = fixture(t); f.meta();
  fs.writeFileSync(path.join(f.sessions, 'broken.json'), '{');
  const file = f.log(['bad json', { ...assistant('side', { input_tokens: 100 }), isSidechain: true }, assistant('main', { input_tokens: 2 })]);
  assert.equal(f.reader.read()[0].tokens.input, 2);
  fs.unlinkSync(file);
  assert.equal(f.reader.read()[0].tokens.total, 0);
});

test('multiple sessions remain separate and obey maxSessions', (t) => {
  const f = fixture(t, { maxSessions: 1 });
  f.meta('a', { updatedAt: NOW - 2000 }); f.meta('b', { updatedAt: NOW - 1000 });
  assert.deepEqual(f.reader.read().map((snapshot) => snapshot.sessionId), ['b']);
});

test('missing Claude installation returns an empty list', (t) => {
  const f = fixture(t);
  assert.deepEqual(new ClaudeReader({ root: path.join(f.root, 'not-installed') }).read(), []);
});

