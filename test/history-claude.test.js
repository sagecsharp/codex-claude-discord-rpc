'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { discoverFiles, parseFile, mergeRecord } = require('../lib/history-claude');
const AT = Date.parse('2026-11-03T20:00:00Z');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'history-claude-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  function write(name, rows, finalNewline = true) {
    const file = path.join(root, 'projects', 'sample', name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, rows.map((row) => typeof row === 'string' ? row : JSON.stringify(row)).join('\n') + (finalNewline ? '\n' : ''));
    return file;
  }
  return { root, write };
}
function assistant(id, usage, extra = {}) {
  return { type: 'assistant', sessionId: 'session-1', timestamp: new Date(AT).toISOString(),
    message: { id, model: 'claude-test', content: [{ type: 'text', text: 'private prompt and reply' }], usage }, ...extra };
}

test('discovers historical project logs and nested subagents, without reading other files', async (t) => {
  const f = fixture(t);
  const main = f.write('old-session.jsonl', []), agent = f.write('old-session/subagents/agent-abc.jsonl', []);
  f.write('ignore.json', []);
  fs.writeFileSync(path.join(f.root, 'credentials.json'), 'private');
  assert.deepEqual(await discoverFiles(f.root), [main, agent].sort());
  assert.deepEqual(await discoverFiles(path.join(f.root, 'missing')), []);
});

test('deduplicates streaming blocks and includes both cache write lifetimes in total input', async (t) => {
  const f = fixture(t);
  const file = f.write('session-1.jsonl', [
    assistant('msg-1', { input_tokens: 10, output_tokens: 2, cache_read_input_tokens: 50, cache_creation_input_tokens: 20 }),
    assistant('msg-1', { input_tokens: 10, output_tokens: 12, cache_read_input_tokens: 50, cache_creation_input_tokens: 20,
      cache_creation: { ephemeral_5m_input_tokens: 15, ephemeral_1h_input_tokens: 5 }, service_tier: 'standard', speed: 'fast' }),
  ]);
  const result = await parseFile(file);
  assert.equal(result.records.length, 1);
  const record = result.records[0];
  assert.equal(record.input, 80);
  assert.equal(record.uncachedInput, 10);
  assert.equal(record.output, 12);
  assert.equal(record.cachedInput, 50);
  assert.equal(record.cacheWrite5m, 15);
  assert.equal(record.cacheWrite1h, 5);
  assert.equal(record.cacheWriteUnknown, 0);
  assert.equal(record.total, 92);
  assert.equal(record.contextTokens, 80);
  assert.equal(record.timestamp, AT);
  assert.equal(record.serviceTier, 'standard');
  assert.equal(record.speed, 'fast');
  assert.equal(result.coverage.duplicateRows, 1);
  assert.ok(!JSON.stringify(result).includes('private'));
});

test('message keys deduplicate copied transcripts, while independent subagents are retained', async (t) => {
  const f = fixture(t), row = assistant('msg-shared', { input_tokens: 12, output_tokens: 3 });
  const a = await parseFile(f.write('session-1.jsonl', [row]));
  const b = await parseFile(f.write('renamed-copy.jsonl', [row, assistant('msg-agent', { input_tokens: 5, output_tokens: 2 }, { isSidechain: true, agentId: 'agent-abc' })]));
  assert.equal(a.records[0].key, b.records[0].key);
  assert.equal(a.records[0].scopeKey, b.records[0].scopeKey);
  assert.equal(b.records.length, 2);
  assert.equal(b.records[1].agentId, 'agent-abc');
  assert.equal(b.records[1].total, 7);
});

test('unknown cache TTL stays unknown and later copies can resolve it without double counting', async (t) => {
  const f = fixture(t);
  const a = (await parseFile(f.write('a.jsonl', [assistant('msg-1', { input_tokens: 10, cache_creation_input_tokens: 100 })]))).records[0];
  const b = (await parseFile(f.write('b.jsonl', [assistant('msg-1', { input_tokens: 10, cache_creation_input_tokens: 100, cache_creation: { ephemeral_5m_input_tokens: 100 } })]))).records[0];
  assert.equal(a.cacheWriteUnknown, 100);
  const merged = mergeRecord(a, b);
  assert.equal(merged.cacheWriteUnknown, 0);
  assert.equal(merged.input, 110);
  assert.equal(merged.cacheWrite5m, 100);
});

test('uses per-model cumulative checkpoints only when no per-message usage is available', async (t) => {
  const f = fixture(t);
  const checkpoint = { type: 'cost-state', sessionId: 'session-1', modelUsage: {
    'claude-test': { inputTokens: 100, outputTokens: 20, cacheReadInputTokens: 30, cacheCreationInputTokens: 10 },
  } };
  const fallback = await parseFile(f.write('fallback.jsonl', [checkpoint, checkpoint]));
  assert.equal(fallback.records.length, 1);
  assert.equal(fallback.records[0].total, 160);
  assert.equal(fallback.records[0].usageSource, 'checkpoint');
  assert.equal(fallback.records[0].contextTokens, undefined);
  assert.equal(fallback.coverage.incomplete, true);
  const normal = await parseFile(f.write('normal.jsonl', [assistant('msg-1', { input_tokens: 100, output_tokens: 20 }), checkpoint]));
  assert.equal(normal.records.length, 1);
  assert.equal(normal.records[0].total, 120);
  assert.equal(normal.records[0].usageSource, 'message');
  assert.ok(normal.warnings.some(({ code }) => code === 'checkpoint_exceeds_observed_messages'));
});

test('aggregate checkpoint without model breakdown does not invent model token counts', async (t) => {
  const f = fixture(t);
  const result = await parseFile(f.write('aggregate.jsonl', [{ type: 'cost-state', sessionId: 'session-1', totalCostUSD: 500 }]));
  assert.deepEqual(result.records, []);
  assert.ok(result.warnings.some(({ code }) => code === 'checkpoint_without_model_breakdown'));
  assert.equal(result.coverage.incomplete, true);
});

test('malformed, oversized, and partial rows preserve subsequent valid usage', async (t) => {
  const f = fixture(t);
  const file = f.write('broken.jsonl', ['malformed private text', 'x'.repeat(16 * 1024 * 1024 + 1),
    assistant('msg-1', { input_tokens: 5, output_tokens: 2 }), '{"type":"assistant"'], false);
  const result = await parseFile(file);
  assert.equal(result.records.length, 1);
  assert.equal(result.records[0].total, 7);
  assert.deepEqual(result.warnings.map(({ code }) => code).sort(), ['incomplete_final_row', 'malformed_rows', 'oversized_rows']);
  assert.equal(result.coverage.incomplete, true);
  assert.ok(!JSON.stringify(result).includes('private'));
});

test('a complete final row without a newline is parsed and request ids provide a stable fallback', async (t) => {
  const f = fixture(t);
  const row = assistant(undefined, { input_tokens: 5 }, { requestId: 'request-1' });
  const result = await parseFile(f.write('request.jsonl', [row, row], false));
  assert.equal(result.records.length, 1);
  assert.equal(result.records[0].key, 'claude:request:request-1');
  assert.equal(result.records[0].total, 5);
  assert.deepEqual(result.warnings, []);
});

test('unkeyed usage is omitted, unknown models remain unpriced, and synthetic messages are ignored', async (t) => {
  const f = fixture(t);
  const row = assistant('msg-unknown', { input_tokens: 5 }); delete row.message.model;
  const synthetic = assistant('msg-synthetic', { input_tokens: 999 }); synthetic.message.model = '<synthetic>';
  const result = await parseFile(f.write('unknown.jsonl', [assistant(undefined, { input_tokens: 500 }), row, synthetic]));
  assert.equal(result.records.length, 1);
  assert.equal(result.records[0].model, null);
  assert.equal(result.records[0].total, 5);
  assert.equal(result.coverage.incomplete, true);
  assert.ok(result.warnings.some(({ code }) => code === 'usage_without_stable_id'));
});

test('missing file returns an explicit coverage warning without leaking its path', async (t) => {
  const f = fixture(t);
  const result = await parseFile(path.join(f.root, 'private-missing.jsonl'));
  assert.deepEqual(result.records, []);
  assert.deepEqual(result.warnings, [{ code: 'missing_file', count: 1 }]);
  assert.equal(result.coverage.incomplete, true);
  assert.ok(!JSON.stringify(result).includes('private'));
});

test('a sidechain record does not misattribute a later main-session checkpoint', async (t) => {
  const f = fixture(t);
  const result = await parseFile(f.write('session-1.jsonl', [
    { type: 'agent-name', sessionId: 'session-1', agentId: 'child-1' },
    { type: 'cost-state', sessionId: 'session-1', modelUsage: { 'claude-test': { inputTokens: 5, outputTokens: 2 } } },
  ]));
  assert.equal(result.records[0].scopeKey, 'claude:session:session-1:main');
});

test('invalid token counters are reported without introducing negative totals', async (t) => {
  const f = fixture(t);
  const result = await parseFile(f.write('invalid.jsonl', [assistant('msg-1', { input_tokens: -5, output_tokens: 3 })]));
  assert.equal(result.records[0].total, 3);
  assert.equal(result.coverage.incomplete, true);
  assert.ok(result.warnings.some(({ code }) => code === 'invalid_token_counters'));
});

test('cross-file model conflicts keep tokens but never silently choose a priceable model', async (t) => {
  const f = fixture(t), first = assistant('msg-1', { input_tokens: 100, output_tokens: 10 });
  const second = assistant('msg-1', { input_tokens: 100, output_tokens: 20 });
  second.message.model = 'claude-other';
  const a = (await parseFile(f.write('a.jsonl', [first]))).records[0];
  const b = (await parseFile(f.write('b.jsonl', [second]))).records[0];
  const merged = mergeRecord(a, b);
  assert.equal(merged.model, null);
  assert.equal(merged.modelConflict, true);
  assert.equal(merged.total, 120);
  assert.equal(mergeRecord(merged, a).model, null);
});

test('checkpoints without transcript session ids are not double-counted through filenames', async (t) => {
  const f = fixture(t);
  const checkpoint = { type: 'cost-state', modelUsage: { 'claude-test': { inputTokens: 10 } } };
  const result = await parseFile(f.write('renamed-copy.jsonl', [checkpoint]));
  assert.deepEqual(result.records, []);
  assert.ok(result.warnings.some(({ code }) => code === 'checkpoint_without_session_id'));
});
