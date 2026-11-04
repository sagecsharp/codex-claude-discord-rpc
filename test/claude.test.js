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

test('claude tool actions are specific, safe, and held through brief thinking transitions', (t) => {
  let now = NOW;
  const f = fixture(t, { now: () => now }); f.meta();
  f.log([assistant('m1', {}, { content: [{ type: 'tool_use', id: 'read-1', name: 'Read', input: { file_path: '/private/secret.txt' } }] })]);
  const first = f.reader.read()[0];
  assert.equal(first.action, 'reading');
  assert.equal(first.actionLabel, 'reading files');
  f.log([{ type: 'user', timestamp: new Date(NOW).toISOString(), message: { content: [{ type: 'tool_result', tool_use_id: 'read-1', content: 'private contents' }] } }], 'session-1', true);
  const held = f.reader.read()[0];
  assert.equal(held.action, 'reading');
  assert.equal(held.actionAt, first.actionAt);
  assert.ok(!JSON.stringify(held).includes('private'));
  now += 8000;
  assert.equal(f.reader.read()[0].action, 'thinking');
  f.log([{ ...assistant('m2', {}, { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'dotnet test private.sln' } }] }), timestamp: new Date(now).toISOString() }], 'session-1', true);
  assert.equal(f.reader.read()[0].action, 'testing');
});

test('claude waits for the matching answer and marks completed work finished', (t) => {
  const f = fixture(t); f.meta();
  f.log([assistant('m1', {}, { content: [{ type: 'tool_use', id: 'ask-1', name: 'AskUserQuestion', input: { question: 'private question' } }] })]);
  assert.equal(f.reader.read()[0].action, 'waiting');
  f.log([{ type: 'user', timestamp: new Date(NOW).toISOString(), message: { content: [{ type: 'tool_result', tool_use_id: 'unrelated' }] } }], 'session-1', true);
  assert.equal(f.reader.read()[0].action, 'waiting');
  f.log([{ type: 'user', timestamp: new Date(NOW).toISOString(), message: { content: [{ type: 'tool_result', tool_use_id: 'ask-1', content: 'private answer' }] } }], 'session-1', true);
  assert.equal(f.reader.read()[0].action, 'thinking');
  f.log([{ ...assistant('m2', {}, { stop_reason: 'end_turn', content: [{ type: 'text', text: 'private answer' }] }), timestamp: new Date(NOW).toISOString() }], 'session-1', true);
  f.meta('session-1', { status: 'idle', updatedAt: NOW });
  assert.equal(f.reader.read()[0].action, 'done');
});

test('metadata waiting and idle states override old action details', (t) => {
  const f = fixture(t); f.meta('session-1', { status: 'waiting' });
  f.log([assistant('m1', {}, { content: [{ type: 'tool_use', name: 'Edit', input: { file_path: '/private/file' } }] })]);
  assert.equal(f.reader.read()[0].action, 'waiting');
  f.meta('session-1', { status: 'idle' });
  assert.equal(f.reader.read()[0].action, 'idle');
});

test('saved custom conversation titles override generated summaries and update on rename', (t) => {
  let now = NOW;
  const f = fixture(t, { now: () => now }); f.meta('session-1', { name: 'generated metadata title', nameSource: 'auto' });
  f.log([
    { type: 'summary', summary: 'generated transcript title' },
    { type: 'custom-title', customTitle: '  original\nconversation\u0000 title  ', sessionId: 'session-1' },
    assistant('m1', {}),
  ]);
  assert.equal(f.reader.read()[0].conversationTitle, 'original conversation title');
  now += 100;
  f.log([{ type: 'custom-title', customTitle: 'renamed conversation', sessionId: 'session-1' },
    { type: 'summary', summary: 'new generated title' }], 'session-1', true);
  assert.equal(f.reader.read()[0].conversationTitle, 'renamed conversation');
});

test('saved user metadata names and later transcript renames use the newer explicit title', (t) => {
  let now = NOW;
  const f = fixture(t, { now: () => now });
  f.meta('session-1', { name: 'current saved name', nameSource: 'user', nameSince: NOW - 500, statusUpdatedAt: NOW - 1000 });
  f.log([{ type: 'custom-title', customTitle: 'old transcript name' }, assistant('m1', {})]);
  assert.equal(f.reader.read()[0].conversationTitle, 'current saved name');
  now += 100;
  f.log([{ type: 'custom-title', customTitle: 'new transcript name' }], 'session-1', true);
  assert.equal(f.reader.read()[0].conversationTitle, 'new transcript name');
  now += 100;
  f.meta('session-1', { name: 'newest saved name', nameSource: 'user', nameSince: now, statusUpdatedAt: NOW - 1000 });
  assert.equal(f.reader.read()[0].conversationTitle, 'newest saved name');
});

test('only explicit saved title fields are accepted, never prompts or agent nicknames', (t) => {
  const f = fixture(t); f.meta('session-1', { firstPrompt: 'private prompt', name: 'prompt-derived private name', nameSource: 'first_prompt' });
  f.log([
    { type: 'user', timestamp: new Date(NOW - 1000).toISOString(), message: { content: 'private user message' } },
    { type: 'agent-name', agentName: 'agent nickname' },
    { type: 'custom-title', customTitle: { content: 'invalid title' } },
    { type: 'summary', summary: ['invalid summary'] },
  ]);
  assert.equal(f.reader.read()[0].conversationTitle, null);
  f.log([{ type: 'summary', summary: 'saved generated conversation title' }], 'session-1', true);
  assert.equal(f.reader.read()[0].conversationTitle, 'saved generated conversation title');
});

test('foreign, sidechain, malformed, and empty titles cannot replace the main conversation name', (t) => {
  const f = fixture(t); f.meta();
  f.log([
    { type: 'custom-title', customTitle: 'main title' }, assistant('m1', {}),
    { type: 'custom-title', customTitle: 'other conversation', sessionId: 'other-session' },
    { type: 'custom-title', customTitle: 'sidechain title', isSidechain: true },
    { type: 'custom-title', customTitle: 'agent title', agentId: 'agent-1' },
    { type: 'custom-title', customTitle: '  ' }, '{broken title json',
  ]);
  assert.equal(f.reader.read()[0].conversationTitle, 'main title');
});

test('bounded head title scan preserves a leading title when usage loads from the tail', (t) => {
  const f = fixture(t, { maxReadBytes: 1024, titleHeadBytes: 512 });
  const file = f.log(['\uFEFF' + JSON.stringify({ type: 'custom-title', customTitle: 'title near the beginning' }),
    JSON.stringify({ type: 'irrelevant', text: 'x'.repeat(20000) }), assistant('m1', {})]);
  const originalRead = fs.readSync;
  let bytes = 0;
  fs.readSync = function (...args) { const count = originalRead.apply(this, args); bytes += count; return count; };
  let state;
  try { state = f.reader._readLog(file); } finally { fs.readSync = originalRead; }
  assert.equal(state.customTitle, 'title near the beginning');
  assert.ok(bytes <= 1536, `read ${bytes} bytes rather than a bounded head and tail`);
  assert.equal(f.reader.read()[0].conversationTitle, 'title near the beginning');
  f.log([JSON.stringify({ type: 'irrelevant', text: 'x'.repeat(20000) }), assistant('m2', {})], 'session-1', true);
  assert.equal(f.reader.read()[0].conversationTitle, 'title near the beginning');
});

test('title-only transcript changes do not revive old activity or change the session timer', (t) => {
  const f = fixture(t, { staleMs: 1000, retentionMs: 5000 });
  f.log([
    { type: 'custom-title', customTitle: 'title timestamp', timestamp: new Date(NOW - 86400000).toISOString() },
    { ...assistant('m1', {}), timestamp: new Date(NOW - 100).toISOString() },
  ]);
  assert.equal(f.reader.read()[0].startedAt, NOW - 100);
  const old = fixture(t, { staleMs: 1000, retentionMs: 5000 });
  old.log([{ ...assistant('old', {}), timestamp: new Date(NOW - 10000).toISOString() }]);
  assert.deepEqual(old.reader.read(), []);
  old.log([{ type: 'custom-title', customTitle: 'fresh rename of old conversation', timestamp: new Date(NOW).toISOString() }], 'session-1', true);
  assert.deepEqual(old.reader.read(), []);
  old.meta('session-1', { name: 'fresh name', nameSource: 'user', nameSince: NOW, updatedAt: NOW, statusUpdatedAt: NOW - 10000 });
  assert.deepEqual(old.reader.read(), []);
});

test('saved titles are bounded without splitting unicode characters', (t) => {
  const f = fixture(t); f.meta();
  f.log([{ type: 'custom-title', customTitle: '界'.repeat(300) }, assistant('m1', {})]);
  assert.equal(f.reader.read()[0].conversationTitle, '界'.repeat(256));
});

test('ordinary metadata heartbeats keep unchanged busy sessions active', (t) => {
  const f = fixture(t, { staleMs: 1000, retentionMs: 5000 });
  f.meta('session-1', { name: 'saved conversation', nameSource: 'user', nameSince: NOW - 20000,
    updatedAt: NOW, statusUpdatedAt: NOW - 10000, status: 'busy' });
  assert.equal(f.reader.read()[0].status, 'working');
  assert.equal(f.reader.read()[0].updatedAt, NOW);
  f.meta('session-1', { name: 'renamed old conversation', nameSource: 'user', nameSince: NOW,
    updatedAt: NOW, statusUpdatedAt: NOW - 10000, status: 'busy' });
  assert.deepEqual(f.reader.read(), []);
});
