'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { CodexTitleIndex } = require('../lib/codex-titles');

function fixture(t, options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-titles-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'session_index.jsonl');
  return { file, index: new CodexTitleIndex({ file, ...options }) };
}

test('title index reads a bounded tail and ignores a cut-off first record', t => {
  const { file, index } = fixture(t, { maxBytes: 200 });
  const old = JSON.stringify({ id: 'old', thread_name: 'x'.repeat(500) });
  const latest = JSON.stringify({ id: 'new', thread_name: 'latest saved title' });
  fs.writeFileSync(file, old + '\n' + latest + '\n');
  index.refresh(10000);
  assert.equal(index.get('old'), null);
  assert.equal(index.get('new'), 'latest saved title');
});

test('a completed partial append is loaded on the next metadata check', t => {
  const { file, index } = fixture(t);
  fs.writeFileSync(file, '{"id":"thread","thread_name":"title');
  index.refresh(10000);
  assert.equal(index.get('thread'), null);
  fs.appendFileSync(file, '"}\n');
  index.refresh(15000);
  assert.equal(index.get('thread'), 'title');
});

test('same-length title rewrites and index replacement invalidate the cache', t => {
  const { file, index } = fixture(t);
  fs.writeFileSync(file, '{"id":"thread","thread_name":"first"}\n');
  index.refresh(10000);
  assert.equal(index.get('thread'), 'first');
  fs.writeFileSync(file, '{"id":"thread","thread_name":"other"}\n');
  fs.utimesSync(file, new Date(20000), new Date(20000));
  index.refresh(15000);
  assert.equal(index.get('thread'), 'other');
  fs.unlinkSync(file);
  fs.writeFileSync(file, '{"id":"thread","thread_name":"third"}\n');
  index.refresh(20000);
  assert.equal(index.get('thread'), 'third');
});

test('title text and index entry count remain bounded', t => {
  const { file, index } = fixture(t, { maxEntries: 2 });
  fs.writeFileSync(file, ['one', 'two', 'three'].map(id => JSON.stringify({ id, thread_name: 'x'.repeat(2000) })).join('\n'));
  index.refresh(10000);
  assert.equal(index.get('one'), null);
  assert.equal(index.get('two').length, 512);
  assert.equal(index.get('three').length, 512);
});
