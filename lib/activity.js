'use strict';

// These labels are the only action text that can leave the local readers.
const ACTION_LABELS = Object.freeze({
  thinking: 'thinking', editing: 'editing files', reading: 'reading files',
  searching: 'searching code', testing: 'running tests', terminal: 'running a command',
  browsing: 'browsing the web', reviewing: 'reviewing changes',
  waiting: 'waiting for you', done: 'finished', idle: 'idle', working: 'working',
});
const HOLD_MS = 8000;
const PRIORITY = { waiting: 100, testing: 90, editing: 80, reviewing: 70,
  searching: 60, browsing: 50, reading: 40, terminal: 30, working: 1 };

function selectAction(actions) {
  return actions.reduce((best, action) => (PRIORITY[action] || 0) > (PRIORITY[best] || 0) ? action : best, 'working');
}

function argumentsObject(input) {
  if (input && typeof input === 'object') return input;
  if (typeof input !== 'string' || input.length > 65536) return null;
  try { const value = JSON.parse(input); return value && typeof value === 'object' ? value : null; }
  catch { return null; }
}

function shellSegments(source) {
  const parts = [];
  let quote = '', start = 0;
  for (let i = 0; i < source.length; i++) {
    const c = source[i];
    if (c === '`' || (c === '\\' && quote !== "'")) { i++; continue; }
    if (quote) { if (c === quote) quote = ''; continue; }
    if (c === '"' || c === "'") { quote = c; continue; }
    if (c === ';' || c === '\n' || c === '|' || (c === '&' && source[i + 1] === '&')) {
      parts.push(source.slice(start, i));
      if (source[i + 1] === c) i++;
      start = i + 1;
    }
  }
  parts.push(source.slice(start));
  return parts;
}

function commandAction(value) {
  if (Array.isArray(value)) {
    // local_shell_call uses argv; shell wrappers put the actual command last.
    const argv = value.filter((part) => typeof part === 'string');
    const shell = /(?:^|[\\/])(?:bash|sh|zsh|powershell|pwsh|cmd)(?:\.exe)?$/i.test(argv[0] || '');
    value = shell && argv.length > 2 ? argv.at(-1) : argv.join(' ');
  }
  if (typeof value !== 'string') return 'terminal';
  const actions = [];
  for (const part of shellSegments(value.slice(0, 16384))) {
    const command = part.trim().replace(/^&\s*/, '');
    if (/^(?:(?:npm|pnpm|yarn|bun)(?:\.cmd)?\s+(?:run\s+)?test(?::[\w:-]+)?|(?:npx\s+)?(?:vitest|jest|mocha|pytest)|python(?:3)?(?:\.exe)?\s+-m\s+pytest|dotnet\s+test|cargo\s+test|go\s+test|node(?:\.exe)?\s+--test)(?:\s|$)/i.test(command)) actions.push('testing');
    else if (/^git(?:\.exe)?(?:\s+-C\s+(?:"[^"]*"|'[^']*'|\S+))?\s+(?:diff|show|status|log)(?:\s|$)/i.test(command)) actions.push('reviewing');
    else if (/^(?:rg|grep|findstr|select-string)(?:\.exe)?(?:\s|$)/i.test(command)) actions.push('searching');
    else if (/^(?:cat|head|tail|type|ls|dir|get-content|get-childitem)(?:\.exe)?(?:\s|$)/i.test(command)) actions.push('reading');
    else if (/^(?:set-content|add-content|out-file|apply_patch)(?:\s|$)/i.test(command)) actions.push('editing');
    else if (/^(?:curl|wget|invoke-webrequest|invoke-restmethod)(?:\.exe)?(?:\s|$)/i.test(command)) actions.push('browsing');
    else if (command) actions.push('terminal');
  }
  return selectAction(actions.length ? actions : ['terminal']);
}

// Mask strings and comments before looking for literal tool calls. This is a
// bounded syntax scan, not an evaluator; mentioned examples cannot become actions.
function maskLiterals(source) {
  let result = '', quote = '', comment = '';
  for (let i = 0; i < source.length; i++) {
    const c = source[i], next = source[i + 1];
    if (comment === '//') { if (c === '\n') comment = ''; result += c === '\n' ? '\n' : ' '; continue; }
    if (comment === '/*') { result += ' '; if (c === '*' && next === '/') { result += ' '; i++; comment = ''; } continue; }
    if (quote) {
      result += ' ';
      if (c === '\\') { if (i + 1 < source.length) { result += ' '; i++; } }
      else if (c === quote) quote = '';
      continue;
    }
    if (c === '/' && (next === '/' || next === '*')) { comment = c + next; result += '  '; i++; }
    else if (c === '"' || c === "'" || c === '`') { quote = c; result += ' '; }
    else result += c;
  }
  return result;
}

function literalCommand(source) {
  const masked = maskLiterals(source);
  const matches = source.matchAll(/(?:^|[{,])\s*(?:cmd|command|"cmd"|"command"|'cmd'|'command')\s*:\s*("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`)/g);
  for (const match of matches) {
    if (masked[match.index + match[0].indexOf(':')] !== ':') continue;
    const literal = match[1];
    if (literal[0] === '"') { try { return JSON.parse(literal); } catch { return undefined; } }
    if (literal[0] === '`' && literal.includes('${')) return undefined;
    return literal.slice(1, -1).replace(/\\n/g, '\n').replace(/\\r/g, '\r').replace(/\\(['"`\\])/g, '$1');
  }
  return undefined;
}

function orchestrationAction(input) {
  const args = argumentsObject(input);
  const source = typeof input === 'string' && !args ? input : args?.code;
  if (typeof source !== 'string') return 'working';
  const bounded = source.slice(0, 65536), masked = maskLiterals(bounded), actions = [];
  const calls = /\b(?:tools|functions)\.([a-zA-Z_][\w.]*)\s*\(/g;
  for (let match; (match = calls.exec(masked));) {
    let end = calls.lastIndex, depth = 1;
    const start = end;
    while (end < masked.length && end - start < 8192 && depth) {
      if (masked[end] === '(') depth++;
      else if (masked[end] === ')') depth--;
      end++;
    }
    const name = match[1];
    if (/^(?:exec|wait)$/.test(name)) continue;
    const command = literalCommand(bounded.slice(start, end));
    actions.push(classifyTool(name, command === undefined ? null : { cmd: command }));
  }
  return selectAction(actions);
}

function classifyTool(name, input) {
  const full = String(name || '').slice(0, 200).toLowerCase();
  const tool = full.split(/\.|__/).at(-1);
  const args = argumentsObject(input);
  if (['request_user_input', 'request_user_input_async', 'askuserquestion', 'ask_user_question'].includes(tool)) return 'waiting';
  if (['apply_patch', 'applypatch', 'edit', 'multiedit', 'write', 'notebookedit', 'write_file', 'edit_file', 'replace_text'].includes(tool)) return 'editing';
  if (['read', 'read_file', 'read_multiple_files', 'list_directory', 'ls', 'view_image'].includes(tool)) return 'reading';
  if (['grep', 'glob', 'search_files', 'find_in_files', 'search_code', 'codesearch'].includes(tool)) return 'searching';
  if (['websearch', 'webfetch', 'search_query', 'image_query', 'browse', 'open_url'].includes(tool) || /(?:^|[._])web(?:[._]|$)/.test(full)) return 'browsing';
  if (['run_tests', 'test'].includes(tool)) return 'testing';
  if (['code_review', 'review_changes'].includes(tool)) return 'reviewing';
  if (['bash', 'powershell', 'exec_command', 'shell', 'local_shell_call', 'shell_command'].includes(tool)) {
    return commandAction(args?.cmd ?? args?.command ?? args?.action?.command ?? input);
  }
  if (tool === 'exec') return args?.cmd || args?.command ? commandAction(args.cmd ?? args.command) : orchestrationAction(input);
  return 'working';
}

function isAsyncQuestion(name, input) {
  if (/request_user_input_async$/i.test(String(name || ''))) return true;
  if (!/(?:^|\.)exec$/i.test(String(name || ''))) return false;
  const args = argumentsObject(input);
  const code = typeof input === 'string' && !args ? input : args?.code;
  return typeof code === 'string' && /\b(?:tools|functions)\.request_user_input_async\s*\(/.test(maskLiterals(code.slice(0, 65536)));
}

function newAction() {
  return { action: 'idle', actionAt: 0, lastEventAt: 0, pendingThinkingAt: 0, waitingFor: null, waitForUser: false };
}

function observeAction(state, action, at, options = {}) {
  if (!Object.hasOwn(ACTION_LABELS, action) || !Number.isFinite(at) || at < state.lastEventAt) return;
  state.lastEventAt = at;
  if (action === 'thinking' && state.waitingFor && !options.releaseWaiting) return;
  if (action !== 'thinking' || options.releaseWaiting) {
    state.waitingFor = action === 'waiting' ? options.callId || true : null;
    state.waitForUser = action === 'waiting' && !!options.waitForUser;
  }
  if (action === 'thinking' && !options.force && !['thinking', 'waiting', 'idle', 'done'].includes(state.action) && at - state.actionAt < HOLD_MS) {
    state.pendingThinkingAt = at;
    return;
  }
  if (state.action !== action || action !== 'thinking') state.actionAt = at;
  state.action = action;
  state.pendingThinkingAt = 0;
}

function observeResult(state, at, callId) {
  if (state.waitingFor && (state.waitForUser || (callId && typeof state.waitingFor === 'string' && callId !== state.waitingFor))) return;
  observeAction(state, 'thinking', at, { releaseWaiting: true, force: !!state.waitingFor });
}

function actionSnapshot(state, now, status, stale = false, fallbackAt = 0) {
  let action = state?.action || 'idle', actionAt = state?.actionAt || fallbackAt;
  if (stale) action = 'idle';
  else if (status === 'idle') action = action === 'done' ? 'done' : 'idle';
  else if (status === 'waiting' || state?.waitingFor) { action = 'waiting'; if (state?.action !== 'waiting') actionAt = fallbackAt; }
  else if (['idle', 'done'].includes(action)) { action = status === 'thinking' ? 'thinking' : 'working'; actionAt = fallbackAt; }
  else if (state.pendingThinkingAt && now - state.actionAt >= HOLD_MS) { action = 'thinking'; actionAt = state.pendingThinkingAt; }
  return { action, actionLabel: ACTION_LABELS[action], actionAt };
}

module.exports = { ACTION_LABELS, HOLD_MS, classifyTool, isAsyncQuestion, commandAction, selectAction, newAction, observeAction, observeResult, actionSnapshot };
