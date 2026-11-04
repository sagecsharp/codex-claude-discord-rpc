'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { discoverFiles, parseFile } = require('../lib/history-codex');

const timestamp = '2026-11-04T03:00:00Z';
const row = (type, payload, extra = {}) => ({ timestamp, type, payload, ...extra });
const usage = (input, output, cached = 0, write = 0) => ({
  input_tokens: input, output_tokens: output, cached_input_tokens: cached,
  cache_write_input_tokens: write, total_tokens: input + output,
});
const meta = (id = 'session', extra = {}) => row('session_meta', { id, ...extra });
const context = (turn = 'turn', model = 'model-a') => row('turn_context', { turn_id: turn, model });
const count = (total, last, extra = {}) => row('event_msg', {
  type: 'token_count', info: { total_token_usage: total, last_token_usage: last },
}, extra);
const request = (id, total, last, turn = 'turn') => row('token_usage_record', {
  response_id: id, turn_id: turn, usage: last, thread_token_usage: total,
});

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'history-codex-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const write = (name, rows) => {
    const file = path.join(directory, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    let data = Buffer.from(`${rows.map(item => typeof item === 'string' ? item : JSON.stringify(item)).join('\n')}\n`);
    if (name.endsWith('.zst')) data = zlib.zstdCompressSync(data);
    fs.writeFileSync(file, data);
    return file;
  };
  return { directory, write };
}

test('discovers session and archived JSONL history without reading unrelated files', async t => {
  const f = fixture(t);
  f.write('sessions/2026/11/03/one.jsonl', [meta()]);
  f.write('archived_sessions/two.jsonl', [meta()]);
  f.write('auth.json', ['not history']);
  f.write('sessions/ignored.txt', ['not history']);
  const files = await discoverFiles(f.directory);
  assert.equal(files.length, 2);
  assert.ok(files.every(file => typeof file.path === 'string' && file.size > 0 && file.mtimeMs > 0));
});

test('uses per-call records once and assigns the model used by each turn', async t => {
  const f = fixture(t);
  const a = usage(100, 20, 60, 10), b = usage(200, 40, 160), total = usage(300, 60, 220, 10);
  const file = f.write('modern.jsonl', [meta(), context('turn-a', 'model-a'), request('response-a', a, a, 'turn-a'),
    count(a, a), count(a, a), context('turn-b', 'model-b'), request('response-b', total, b, 'turn-b'), count(total, b)]);
  const result = await parseFile(file);
  assert.equal(result.records.length, 2);
  assert.deepEqual(result.records.map(r => r.model), ['model-a', 'model-b']);
  assert.deepEqual(result.records.map(r => r.total), [120, 240]);
  assert.deepEqual(result.records.map(r => r.contextTokens), [100, 200]);
  assert.equal(result.records[0].cacheWriteUnknown, 10);
  assert.equal(result.records[0].uncachedInput, 30);
  assert.ok(result.records.every(r => r.completeness === 'complete'));
});

test('deduplicates repeated responses even when a later log repeats their usage', async t => {
  const f = fixture(t);
  const a = usage(10, 2, 5);
  const file = f.write('repeated.jsonl', [meta(), context(), request('response-1', a, a), request('response-1', a, a)]);
  const result = await parseFile(file);
  assert.equal(result.records.length, 1);
  assert.equal(result.records[0].key, 'codex:response:response-1');
});

test('explicit records without response ids remain countable and suppress their legacy snapshots', async t => {
  const f = fixture(t);
  const a = usage(100, 10, 80);
  const result = await parseFile(f.write('without-id.jsonl', [meta(), context(), request(undefined, a, a), count(a, a)]));
  assert.equal(result.records.length, 1);
  assert.equal(result.records[0].total, 110);
  assert.ok(result.warnings.some(w => w.startsWith('request_without_response_id')));
});

test('explicit requests without paired token events advance the cumulative baseline', async t => {
  const f = fixture(t);
  const a = usage(100, 10, 80), b = usage(250, 30, 180), last = usage(150, 20, 100);
  const result = await parseFile(f.write('unpaired.jsonl', [meta(), context(), request('unpaired', a, a), count(b, last)]));
  assert.equal(result.records.length, 2);
  assert.equal(result.records.reduce((sum, r) => sum + r.total, 0), 280);
});

test('legacy cumulative snapshots become per-request deltas without repeat inflation', async t => {
  const f = fixture(t);
  const a = usage(100, 10, 80), b = usage(250, 30, 180), last = usage(150, 20, 100);
  const file = f.write('legacy.jsonl', [meta(), context(), count(a, a), count(a, a), count(b, last), count(b, last)]);
  const result = await parseFile(file);
  assert.deepEqual(result.records.map(r => r.total), [110, 170]);
  assert.deepEqual(result.records.map(r => r.contextTokens), [100, 150]);
  assert.ok(result.records.every(r => r.completeness === 'inferred'));
});

test('inherited legacy events retain keys when forks rewrite timestamps and ordinals', async t => {
  const f = fixture(t);
  const a = usage(100, 10, 80);
  const original = f.write('parent.jsonl', [meta('parent'), context('original-turn'), count(a, a, { ordinal: 20 })]);
  const fork = f.write('fork.jsonl', [meta('child', { forked_from_id: 'parent' }), context('original-turn'),
    count(a, a, { ordinal: 5, timestamp: '2026-11-04T08:00:00Z' })]);
  const parentResult = await parseFile(original), childResult = await parseFile(fork);
  assert.equal(parentResult.records.length, 1);
  assert.equal(childResult.records.length, 1);
  assert.equal(parentResult.records[0].key, childResult.records[0].key);
  assert.equal(new Map([...parentResult.records, ...childResult.records].map(r => [r.key, r])).size, 1);
});

test('separate turns with identical first-call usage have distinct event keys', async t => {
  const f = fixture(t);
  const a = usage(100, 10, 80);
  const first = await parseFile(f.write('one.jsonl', [meta('one'), context('turn-one'), count(a, a)]));
  const second = await parseFile(f.write('two.jsonl', [meta('two'), context('turn-two'), count(a, a)]));
  assert.notEqual(first.records[0].key, second.records[0].key);
});

test('fork baseline estimates are excluded while new requests remain countable', async t => {
  const f = fixture(t);
  const baseline = usage(10000, 1000, 8000), last = usage(100, 10, 80), total = usage(10100, 1010, 8080);
  const file = f.write('baseline.jsonl', [meta('child', { forked_from_id: 'parent' }),
    count(baseline, { input_tokens: 0, output_tokens: 0, total_tokens: 8000 }),
    context('child-turn'), count(total, last)]);
  const result = await parseFile(file);
  assert.equal(result.records.length, 1);
  assert.equal(result.records[0].total, 110);
  assert.ok(result.warnings.some(w => w.startsWith('inherited_usage_baseline')));
  assert.equal(result.coverage.incomplete, false);
});

test('unattributed cumulative gaps remain unpriced rather than inheriting a later model', async t => {
  const f = fixture(t);
  const file = f.write('gap.jsonl', [meta(), context('turn', 'latest-model'),
    count(usage(1000, 100, 800), usage(100, 10, 80))]);
  const result = await parseFile(file);
  const gap = result.records.find(r => r.key.endsWith(':gap'));
  assert.equal(gap.total, 990);
  assert.equal(gap.model, null);
  assert.equal(gap.completeness, 'inferred');
  assert.equal(gap.pricingIncomplete, true);
  assert.equal(gap.contextTokens, undefined);
  assert.equal(result.records.find(r => !r.key.endsWith(':gap')).contextTokens, 100);
});

test('recovers around malformed or oversized lines in available history formats', async t => {
  const f = fixture(t);
  const a = usage(100, 10, 80);
  const rows = [meta(), context(), 'malformed-json', 'x'.repeat(5000), count(a, a)];
  const file = f.write(typeof zlib.zstdCompressSync === 'function' ? 'compressed.jsonl.zst' : 'plain.jsonl', rows);
  const result = await parseFile(file, { maxLineBytes: 1000 });
  assert.equal(result.records.length, 1);
  assert.equal(result.records[0].total, 110);
  assert.ok(result.warnings.some(w => w.startsWith('malformed_json')));
  assert.ok(result.warnings.some(w => w.startsWith('oversized_line')));
});

test('unsupported zstd runtimes report incomplete coverage explicitly', { skip: typeof zlib.createZstdDecompress === 'function' }, async t => {
  const f = fixture(t);
  const result = await parseFile(path.join(f.directory, 'unsupported.jsonl.zst'));
  assert.deepEqual(result.records, []);
  assert.ok(result.warnings.some(w => w.startsWith('zstd_not_supported')));
  assert.equal(result.coverage.incomplete, true);
});

test('a partial trailing row and a missing file yield warnings without losing earlier records', async t => {
  const f = fixture(t);
  const a = usage(100, 10, 80);
  const file = f.write('partial.jsonl', [meta(), context(), count(a, a)]);
  fs.appendFileSync(file, '{"type":');
  const result = await parseFile(file);
  assert.equal(result.records.length, 1);
  assert.ok(result.warnings.some(w => w.startsWith('malformed_json')));
  const missing = await parseFile(path.join(f.directory, 'missing.jsonl'));
  assert.deepEqual(missing.records, []);
  assert.ok(missing.warnings.some(w => w.startsWith('history_read_failed')));
});

test('unknown models mark pricing unavailable without making exact token counters incomplete', async t => {
  const f = fixture(t);
  const a = usage(100, 10, 80);
  const result = await parseFile(f.write('unknown.jsonl', [meta(), row('event_msg', { type: 'task_started', turn_id: 'unknown' }), count(a, a)]));
  assert.equal(result.records[0].model, null);
  assert.equal(result.records[0].completeness, 'inferred');
  assert.equal(result.records[0].pricingIncomplete, true);
  assert.equal(result.coverage.incomplete, false);
  assert.ok(result.warnings.some(w => w.startsWith('usage_without_model')));
});

test('large irrelevant payloads and context-only estimates do not reduce usage coverage', async t => {
  const f = fixture(t);
  const a = usage(100, 10, 80);
  const file = f.write('irrelevant.jsonl', [meta(), context(),
    row('response_item', { type: 'message', content: 'x'.repeat(10000) }),
    count({ input_tokens: 0, output_tokens: 0, total_tokens: 20000 }, { total_tokens: 20000 }), count(a, a)]);
  const result = await parseFile(file, { maxLineBytes: 1000 });
  assert.equal(result.records.length, 1);
  assert.equal(result.coverage.incomplete, false);
  assert.deepEqual(result.warnings, []);
});

test('history aggregation suppresses cross-file legacy aliases of explicit requests', async t => {
  const { summarizeHistory } = require('../lib/history');
  const f = fixture(t);
  const a = usage(100, 10, 80);
  const old = await parseFile(f.write('old.jsonl', [meta(), context(), count(a, a)]));
  const modern = await parseFile(f.write('new.jsonl', [meta(), context(), request('response-alias', a, a)]));
  assert.equal(modern.records[0].aliases[0], old.records[0].key);
  const summary = summarizeHistory({ old: { provider: 'codex', ...old }, modern: { provider: 'codex', ...modern } },
    record => ({ costUSD: 0, pricedTokens: record.total, unpricedTokens: 0 }));
  assert.equal(summary.providers.codex.total, 110);
  assert.equal(summary.providers.codex.requests, 1);
});
