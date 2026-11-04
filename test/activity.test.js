'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { ACTION_LABELS, classifyTool, commandAction, isAsyncQuestion } = require('../lib/activity');

test('classifies familiar tool names using static safe labels', () => {
  const cases = [['functions.apply_patch', 'editing'], ['Edit', 'editing'], ['Read', 'reading'],
    ['mcp__files__read_file', 'reading'], ['Grep', 'searching'], ['Glob', 'searching'],
    ['WebSearch', 'browsing'], ['web__run', 'browsing'], ['AskUserQuestion', 'waiting'],
    ['functions.request_user_input_async', 'waiting'], ['private-custom-tool', 'working']];
  for (const [name, expected] of cases) {
    const action = classifyTool(name, { file_path: '/private/secret.txt', prompt: 'private prompt' });
    assert.equal(action, expected, name);
    assert.ok(!ACTION_LABELS[action].includes('private'));
  }
});

test('whitelisted shell commands distinguish tests, review, search, read, and unknown work', () => {
  const cases = [['npm test -- --runInBand', 'testing'], ['pnpm run test:unit', 'testing'],
    ['pytest tests/private.py', 'testing'], ['python -m pytest', 'testing'], ['dotnet test', 'testing'],
    ['cargo test --workspace', 'testing'], ['node --test test/private.test.js', 'testing'],
    ['git diff --check', 'reviewing'], ['git -C "/private project" status --short', 'reviewing'],
    ['Get-Content private.txt', 'reading'], ['rg "secret" private/', 'searching'],
    ['cd private; npm test', 'testing'], ['echo npm test', 'terminal'], ['echo "private; npm test"', 'terminal'], ['npm testimony', 'terminal'],
    ['private-build --secret', 'terminal']];
  for (const [cmd, expected] of cases) assert.equal(classifyTool('tools.exec_command', { cmd }), expected, cmd);
  assert.equal(commandAction(['/bin/bash', '-lc', 'cargo test']), 'testing');
});

test('orchestration inspects literal tool calls without evaluating code or its strings', () => {
  const source = 'globalThis.__rpcShouldNeverRun = true; await tools.exec_command({cmd: "npm test -- private"});';
  assert.equal(classifyTool('functions.exec', source), 'testing');
  assert.equal(globalThis.__rpcShouldNeverRun, undefined);
  assert.equal(classifyTool('functions.exec', { code: 'await tools.apply_patch("private patch");' }), 'editing');
  assert.equal(classifyTool('functions.exec', JSON.stringify({ code: 'await tools.exec_command({cmd: "git diff"});' })), 'reviewing');
  assert.equal(classifyTool('functions.exec', 'text("await tools.apply_patch(secret)"); // tools.exec_command({cmd:"npm test"})'), 'working');
  assert.equal(classifyTool('functions.exec', 'await tools.exec_command({cmd: `npm ${privateValue}`});'), 'terminal');
  assert.equal(classifyTool('functions.exec', 'await tools.exec_command({ cmd: privateVariable, hint: \'{cmd:"npm test"}\' });'), 'terminal');
  assert.equal(isAsyncQuestion('functions.exec', 'await tools.request_user_input_async({questions: []})'), true);
  assert.equal(isAsyncQuestion('functions.exec', 'text("tools.request_user_input_async()");'), false);
});
