'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { CodexReader } = require('../lib/codex');

function fixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dual-presence-codex-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'rollout-example.jsonl');
  let now = Date.parse('2026-11-04T03:00:00Z');
  const reader = new CodexReader({ root, now: () => now, discoveryIntervalMs: 0, ...options });
  const append = (type, payload, delta = 0) => {
    now += delta;
    fs.appendFileSync(file, `${JSON.stringify({ timestamp: new Date(now).toISOString(), type, payload })}\n`);
  };
  const advance = ms => { now += ms; };
  return { file, reader, append, advance };
}

test('reads metadata, turn lifecycle and cumulative usage without double counting', t => {
  const f = fixture(t);
  f.append('session_meta', { id: 'session-1', cwd: 'c:/project', base_instructions: 'private' });
  f.append('turn_context', { model: 'example-model', cwd: 'c:/project' });
  f.append('event_msg', { type: 'task_started' });
  f.append('event_msg', { type: 'token_count', info: { total_token_usage: {
    input_tokens: 100, output_tokens: 20, cached_input_tokens: 70, total_tokens: 120,
  } } }, 1);
  const [first] = f.reader.read();
  assert.equal(first.status, 'thinking');
  assert.equal(first.sessionId, 'session-1');
  assert.equal(first.model, 'example-model');
  assert.equal(first.cwd, 'c:/project');
  assert.deepEqual(first.tokens, { input: 100, output: 20, total: 120, cachedInput: 70 });
  assert.deepEqual(f.reader.read()[0].tokens, first.tokens);
  assert.ok(!JSON.stringify(first).includes('private'));
  f.append('event_msg', { type: 'task_complete', last_agent_message: 'private answer' }, 1);
  assert.equal(f.reader.read()[0].status, 'idle');
});

test('tracks tools and approval waits but expires quiet active sessions', t => {
  const f = fixture(t, { staleMs: 1000 });
  f.append('event_msg', { type: 'task_started' });
  f.append('response_item', { type: 'function_call', name: 'tools.exec', arguments: 'private' }, 1);
  assert.equal(f.reader.read()[0].status, 'working');
  f.append('response_item', { type: 'function_call', name: 'functions.request_user_input', arguments: 'private' }, 1);
  assert.equal(f.reader.read()[0].status, 'waiting');
  f.append('response_item', { type: 'function_call_output', output: 'private' }, 1);
  assert.equal(f.reader.read()[0].status, 'thinking');
  f.advance(1001);
  assert.equal(f.reader.read()[0].status, 'idle');
  assert.equal(f.reader.read()[0].stale, true);
});

test('buffers incomplete UTF-8 records until a complete newline arrives', t => {
  const f = fixture(t);
  f.append('session_meta', { id: 'unicode-session', cwd: 'c:/项目' });
  f.append('event_msg', { type: 'task_started' });
  const record = Buffer.from(`${JSON.stringify({ timestamp: '2026-11-04T03:00:00Z', type: 'turn_context', payload: { model: '模型' } })}\n`);
  const split = record.indexOf(Buffer.from('模')) + 1;
  fs.appendFileSync(f.file, record.subarray(0, split));
  assert.equal(f.reader.read()[0].model, null);
  fs.appendFileSync(f.file, record.subarray(split));
  assert.equal(f.reader.read()[0].model, '模型');
  assert.equal(f.reader.read()[0].cwd, 'c:/项目');
});

test('recovers from malformed rows and file truncation', t => {
  const f = fixture(t);
  f.append('event_msg', { type: 'task_started' });
  fs.appendFileSync(f.file, 'not json\n');
  f.append('response_item', { type: 'custom_tool_call', name: 'apply_patch' }, 1);
  assert.equal(f.reader.read()[0].status, 'working');
  fs.writeFileSync(f.file, '');
  f.append('session_meta', { id: 'replacement' }, 1);
  f.append('event_msg', { type: 'task_complete' }, 1);
  assert.equal(f.reader.read()[0].sessionId, 'replacement');
  assert.equal(f.reader.read()[0].status, 'idle');
  assert.equal(f.reader.read()[0].tokens.total, 0);
});

test('reads metadata at the head and latest state at the tail of large logs', t => {
  const f = fixture(t, { initialHeadBytes: 300, initialTailBytes: 450 });
  f.append('session_meta', { id: 'large-session', cwd: 'c:/project' });
  f.append('turn_context', { model: 'test-model' });
  for (let n = 0; n < 100; n++) f.append('response_item', { type: 'message', content: 'x'.repeat(100) });
  f.append('event_msg', { type: 'task_started' }, 1);
  f.append('token_usage_record', { thread_token_usage: { input_tokens: 240, output_tokens: 60, total_tokens: 300 } }, 1);
  const [state] = f.reader.read();
  assert.equal(state.sessionId, 'large-session');
  assert.equal(state.model, 'test-model');
  assert.equal(state.status, 'thinking');
  assert.equal(state.tokens.total, 300);
  assert.equal(state.hasUsage, true);
});

test('does not reactivate a completed turn on later usage metadata', t => {
  const f = fixture(t);
  f.append('event_msg', { type: 'task_started' });
  f.append('event_msg', { type: 'turn_aborted' }, 1);
  f.append('event_msg', { type: 'token_count', info: { total_token_usage: { input_tokens: 8, output_tokens: 2 } } }, 1);
  assert.equal(f.reader.read()[0].status, 'idle');
  assert.equal(f.reader.read()[0].tokens.total, 10);
});

test('missing directories and removed files are harmless', t => {
  const f = fixture(t);
  assert.deepEqual(f.reader.read(), []);
  f.append('event_msg', { type: 'task_started' });
  assert.equal(f.reader.read().length, 1);
  fs.unlinkSync(f.file);
  assert.deepEqual(f.reader.read(), []);
  const missing = new CodexReader({ root: path.join(path.dirname(f.file), 'absent') });
  assert.deepEqual(missing.read(), []);
});

test('old history expires and returns when the same session becomes active again', t => {
  const f = fixture(t, { staleMs: 1000, idleRetentionMs: 3000 });
  f.append('event_msg', { type: 'task_started' });
  assert.equal(f.reader.read().length, 1);
  f.advance(1001);
  assert.equal(f.reader.read()[0].status, 'idle');
  f.advance(2000);
  assert.deepEqual(f.reader.read(), []);
  f.append('event_msg', { type: 'task_started' });
  assert.equal(f.reader.read()[0].status, 'thinking');
});

test('normalizes task start timestamps from Unix seconds, milliseconds, and ISO', t => {
  const f = fixture(t);
  const expected = Date.parse('2026-11-04T02:59:00Z');
  for (const value of [expected / 1000, String(expected / 1000), expected, new Date(expected).toISOString()]) {
    f.append('event_msg', { type: 'task_started', started_at: value }, 1);
    assert.equal(f.reader.read()[0].startedAt, expected);
  }
});

test('invalid start timestamps fall back to the event, future events do not show', t => {
  const f = fixture(t);
  f.append('event_msg', { type: 'task_started', started_at: null });
  let state = f.reader.read()[0];
  assert.equal(state.startedAt, state.updatedAt);
  fs.appendFileSync(f.file, JSON.stringify({ timestamp: '2100-01-01T00:00:00Z', type: 'event_msg', payload: { type: 'task_started' } }) + '\n');
  assert.deepEqual(f.reader.read(), []);
});

test('action labels identify orchestration work and retain it briefly after tool output', t => {
  const f = fixture(t);
  f.append('event_msg', { type: 'task_started' });
  f.append('response_item', { type: 'custom_tool_call', name: 'functions.exec', call_id: 'tests-1', input: 'await tools.exec_command({cmd: "npm test -- private-tests"});' }, 1);
  let state = f.reader.read()[0];
  assert.equal(state.action, 'testing');
  assert.equal(state.actionLabel, 'running tests');
  const started = state.actionAt;
  f.append('response_item', { type: 'custom_tool_call_output', call_id: 'tests-1', output: 'private result' }, 1);
  f.append('response_item', { type: 'reasoning', summary: 'private reasoning' }, 1);
  state = f.reader.read()[0];
  assert.equal(state.action, 'testing');
  assert.equal(state.actionAt, started);
  assert.ok(!JSON.stringify(state).includes('private'));
  f.advance(8000);
  assert.equal(f.reader.read()[0].action, 'thinking');
  f.append('response_item', { type: 'custom_tool_call', name: 'apply_patch', input: 'private patch' }, 1);
  assert.equal(f.reader.read()[0].action, 'editing');
  f.append('event_msg', { type: 'task_complete' }, 1);
  assert.equal(f.reader.read()[0].action, 'done');
  f.advance(120001);
  assert.equal(f.reader.read()[0].action, 'idle');
});

test('asynchronous questions survive their acknowledgement until the user responds', t => {
  const f = fixture(t);
  f.append('response_item', { type: 'function_call', name: 'functions.request_user_input_async', call_id: 'question-1', arguments: '{}' });
  f.append('response_item', { type: 'function_call_output', call_id: 'question-1', output: '{"accepted":true}' }, 1);
  f.append('response_item', { type: 'reasoning' }, 1);
  assert.equal(f.reader.read()[0].action, 'waiting');
  assert.equal(f.reader.read()[0].status, 'waiting');
  f.append('event_msg', { type: 'user_message', message: 'private response' }, 1);
  assert.equal(f.reader.read()[0].action, 'thinking');
});

test('synchronous questions wait for matching tool results and meaningful tools replace actions immediately', t => {
  const f = fixture(t);
  f.append('response_item', { type: 'function_call', name: 'functions.request_user_input', call_id: 'question-1', arguments: '{}' });
  f.append('response_item', { type: 'function_call_output', call_id: 'unrelated', output: 'private' }, 1);
  assert.equal(f.reader.read()[0].action, 'waiting');
  f.append('response_item', { type: 'function_call_output', call_id: 'question-1', output: 'private answer' }, 1);
  assert.equal(f.reader.read()[0].action, 'thinking');
  f.append('response_item', { type: 'function_call', name: 'tools.exec_command', arguments: JSON.stringify({ cmd: 'Get-Content private.txt' }) }, 1);
  assert.equal(f.reader.read()[0].action, 'reading');
  f.append('response_item', { type: 'function_call', name: 'tools.exec_command', arguments: JSON.stringify({ cmd: 'git diff --check' }) }, 1);
  assert.equal(f.reader.read()[0].action, 'reviewing');
});
