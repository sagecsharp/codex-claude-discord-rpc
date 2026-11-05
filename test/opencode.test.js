'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { OpencodeReader, parseFields, modelKind } = require('../lib/opencode');

const T = Date.parse('2026-11-05T20:00:00Z');
const line = (at, rest) => `timestamp=${new Date(at).toISOString()} ${rest}\n`;

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-reader-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'log'), { recursive: true });
  return root;
}

function write(root, at, rest) {
  fs.appendFileSync(path.join(root, 'log', 'opencode.log'), line(at, rest));
}

test('key/value parsing keeps quoted values with escaped quotes', () => {
  const fields = parseFields('timestamp=2026-11-05T20:00:00.000Z message=evaluated permission=bash pattern="python \\"a b.py\\" 2>&1" action.permission=*');
  assert.equal(fields.message, 'evaluated');
  assert.equal(fields.permission, 'bash');
  assert.equal(fields.pattern, 'python "a b.py" 2>&1');
  assert.equal(fields['action.permission'], '*');
});

test('model kinds map glm and deepseek from provider or model ids', () => {
  assert.equal(modelKind('zai-coding-plan', 'glm-5.3'), 'glm');
  assert.equal(modelKind('zhipu', 'glm-4'), 'glm');
  assert.equal(modelKind('deepseek', 'deepseek-flash'), 'deepseek');
  assert.equal(modelKind('opencode', 'deepseek-v4.1-flash-free'), 'deepseek');
  assert.equal(modelKind('openai', 'gpt-6-astra'), 'opencode');
});

test('opencode activity is read incrementally without exposing prompt text', (t) => {
  const root = fixture(t);
  let now = T;
  const reader = new OpencodeReader({ root, now: () => now, initialBytes: 1024 * 1024 });
  write(root, T, 'message=created id=ses_test title="Private Prompt" directory="C:\\\\work\\\\app"');
  assert.deepEqual(reader.read(), []);

  write(root, T + 1000, 'run=r1 message=loop session.id=ses_test step=1');
  write(root, T + 1000, 'run=r1 message=stream providerID=deepseek modelID=deepseek-flash session.id=ses_test agent=build mode=primary');
  now = T + 1500;
  let [snapshot] = reader.read();
  assert.equal(snapshot.provider, 'opencode');
  assert.equal(snapshot.sessionId, 'ses_test');
  assert.equal(snapshot.status, 'thinking');
  assert.equal(snapshot.model, 'deepseek-flash');
  assert.equal(snapshot.modelKind, 'deepseek');
  assert.equal(snapshot.cwd, 'C:\\work\\app');
  assert.equal(snapshot.hasUsage, false);
  assert.equal(JSON.stringify(snapshot).includes('Private Prompt'), false);

  write(root, T + 2000, 'run=r1 message=evaluated permission=bash pattern="npm test" action.permission=bash action.action=allow action.pattern=*');
  now = T + 2500;
  [snapshot] = reader.read();
  assert.equal(snapshot.status, 'working');
  assert.equal(snapshot.action, 'testing');

  write(root, T + 3000, 'run=r1 message=asking id=per_1 permission=external_directory patterns="[]"');
  now = T + 3500;
  [snapshot] = reader.read();
  assert.equal(snapshot.status, 'waiting');
  assert.equal(snapshot.action, 'waiting');

  write(root, T + 4000, 'run=r1 message=replied requestID=que_1 answers="[[\\"yes\\"]]"');
  write(root, T + 4000, 'run=r1 message=stream providerID=zai-coding-plan modelID=glm-5.3 session.id=ses_test agent=build mode=primary');
  now = T + 4500;
  [snapshot] = reader.read();
  assert.equal(snapshot.status, 'thinking');
  assert.equal(snapshot.action, 'thinking');
  assert.equal(snapshot.modelKind, 'glm');

  write(root, T + 5000, 'run=r1 message="exiting loop" session.id=ses_test');
  now = T + 5500;
  [snapshot] = reader.read();
  assert.equal(snapshot.status, 'idle');
  assert.equal(snapshot.action, 'done');
});

test('stale sessions become idle and expired sessions disappear', (t) => {
  const root = fixture(t);
  let now = T;
  const reader = new OpencodeReader({ root, now: () => now, staleMs: 120000, retentionMs: 600000 });
  write(root, T, 'message=created id=ses_stale directory="C:\\\\work"');
  write(root, T, 'message=stream providerID=deepseek modelID=deepseek-flash session.id=ses_stale');
  now = T + 121000;
  const [stale] = reader.read();
  assert.equal(stale.status, 'idle');
  assert.equal(stale.stale, true);
  assert.equal(stale.action, 'idle');
  now = T + 600001;
  assert.deepEqual(reader.read(), []);
});

test('a truncated or replaced log starts a fresh read', (t) => {
  const root = fixture(t);
  let now = T;
  const file = path.join(root, 'log', 'opencode.log');
  fs.writeFileSync(file, line(T, 'message=created id=ses_old directory="C:\\\\old"'));
  fs.appendFileSync(file, line(T, 'message=stream providerID=deepseek modelID=deepseek-flash session.id=ses_old'));
  const reader = new OpencodeReader({ root, now: () => now, initialBytes: 1024 * 1024 });
  assert.equal(reader.read()[0].sessionId, 'ses_old');
  fs.writeFileSync(file, line(T + 1000, 'message=created id=ses_new directory="C:\\\\new"'));
  now = T + 1500;
  assert.equal(reader.read()[0].sessionId, 'ses_old');
  fs.appendFileSync(file, line(T + 2000, 'message=stream providerID=zai-coding-plan modelID=glm-5.3 session.id=ses_new'));
  now = T + 2500;
  const snapshots = reader.read();
  assert.equal(snapshots.length, 2);
  assert.equal(snapshots[0].sessionId, 'ses_new');
  assert.equal(snapshots[0].modelKind, 'glm');
});
