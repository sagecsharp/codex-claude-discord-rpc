'use strict';

/**
 * Turns live sessions into a Discord activity.
 *
 *   pick()     which session to show
 *   resolve()  what that session is doing, as one of the Clawd scenes
 *   build()    the activity payload, with privacy applied and every string
 *              scrubbed of paths and account names
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { modelInfo } = require('./claude');

// ---------------------------------------------------------------- tool -> english

const base = (p) => (p ? String(p).split(/[\\/]/).pop() : 'a file');

function short(s, n = 40) {
  if (!s) return '';
  s = String(s).replace(/\s+/g, ' ').trim();
  return s.length <= n ? s : s.slice(0, n - 1) + '…';
}

const TOOL_VERBS = {
  Read: (i) => `Reading ${base(i.file_path)}`,
  Edit: (i) => `Editing ${base(i.file_path)}`,
  MultiEdit: (i) => `Editing ${base(i.file_path)}`,
  Write: (i) => `Writing ${base(i.file_path)}`,
  NotebookEdit: (i) => `Editing ${base(i.notebook_path)}`,
  Bash: (i) => `Running: ${short(i.description || i.command)}`,
  PowerShell: (i) => `Running: ${short(i.description || i.command)}`,
  Grep: (i) => `Searching for "${short(i.pattern, 28)}"`,
  Glob: (i) => `Looking for ${short(i.pattern, 28)}`,
  Agent: (i) => `Agent: ${short(i.description, 32)}`,
  Task: (i) => `Agent: ${short(i.description, 32)}`,
  Skill: (i) => `Using /${short(i.skill, 32)}`,
  Workflow: () => 'Orchestrating a workflow',
  WebSearch: (i) => `Searching the web: ${short(i.query, 28)}`,
  WebFetch: () => 'Reading a web page',
  Artifact: () => 'Publishing an artifact',
  TodoWrite: () => 'Planning',
  TaskCreate: () => 'Planning',
  TaskUpdate: () => 'Updating the plan',
  ExitPlanMode: () => 'Finishing a plan',
  EnterPlanMode: () => 'Planning',
  SendUserFile: () => 'Sending a file',
  AskUserQuestion: () => 'Asking you a question',
  LSP: () => 'Reading code',
};

const MCP_LABELS = {
  Claude_Browser: 'Driving the browser',
  'claude-in-chrome': 'Driving Chrome',
  'computer-use': 'Using the desktop',
  'ui-dom-mcp': 'Inspecting the system',
  terminal: 'Reading the terminal',
  unityMCP: 'Working in Unity',
  'unity-editor-mcp': 'Working in Unity',
  blockbench: 'Modelling in Blockbench',
};

/** IDA Pro MCP servers: ida-pro, ida-pro-gui, plugin_ida-pro_idalib, ... */
const isIdaTool = (name) => /^mcp__(plugin_)?ida[-_]/i.test(name || '');

// What Claude is doing in IDA, by tool (decompile is by far the most common).
const IDA_VERBS = [
  [/decompile/, 'Decompiling'],
  [/disasm|insn|basic_blocks|define_code/, 'Disassembling'],
  [/xref|callee|callgraph|trace_data_flow/, 'Tracing xrefs'],
  [/^find|search/, 'Searching the binary'],
  [/get_bytes|get_int|get_string|read_struct|get_global/, 'Reading memory'],
  [/patch/, 'Patching the binary'],
  [/rename|set_type|set_comments|declare|append_comments|enum_upsert|type_apply/, 'Annotating'],
];

function describeIda(name) {
  const tool = name.split('__').pop();
  const hit = IDA_VERBS.find(([re]) => re.test(tool));
  return `${hit ? hit[1] : 'Reversing'} in IDA Pro`;
}

function describeTool(t) {
  if (!t) return null;
  if (TOOL_VERBS[t.name]) return TOOL_VERBS[t.name](t.input || {});
  if (isIdaTool(t.name)) return describeIda(t.name);
  if (t.name && t.name.startsWith('mcp__')) {
    const server = t.name.split('__')[1] || 'a tool';
    return MCP_LABELS[server] || `Using ${short(server.replace(/[-_]/g, ' '), 28)}`;
  }
  return `Using ${short(t.name, 28)}`;
}

/** privacy "project": keep the verb, drop file names, commands and queries. */
function genericize(label) {
  if (!label) return label;
  if (/^Reading (code|a web page)/.test(label)) return label;
  if (/^Reading /.test(label)) return 'Reading code';
  if (/^(Editing|Writing) /.test(label)) return 'Writing code';
  if (/^Running: /.test(label)) return 'Running a command';
  if (/^(Searching for|Looking for)/.test(label)) return 'Searching the codebase';
  if (/^Agent: /.test(label)) return 'Running an agent';
  if (/^Searching the web/.test(label)) return 'Researching';
  if (/^Using \//.test(label)) return 'Running a skill';
  if (/ in IDA Pro$/.test(label)) return 'Reverse engineering';
  return label;
}

const WAITING_LABELS = {
  'dialog open': 'Needs your approval',
  'input needed': 'Needs your input',
  'sandbox request': 'Needs sandbox approval',
  'goal proposal': 'Proposing a goal',
};

// ---------------------------------------------------------------- picking

const PRIORITY = { waiting: 3, busy: 2, idle: 1 };

function priority(s) {
  const p = s.waitingFor ? PRIORITY.waiting : s.status === 'busy' ? PRIORITY.busy : PRIORITY.idle;
  // Background jobs (kind != interactive) only win when nothing else is going.
  return s.kind && s.kind !== 'interactive' ? p - 0.5 : p;
}

const recency = (s) => Math.max(s.statusUpdatedAt || 0, (s.t && s.t.lastEventAt) || 0);

/**
 * Show the session that most needs showing: blocked on you > working > idle,
 * then most recently active. The current pick is sticky at equal priority so
 * two busy sessions don't ping-pong every tick.
 */
function pick(sessions, currentId, graceMs) {
  if (!sessions.length) return null;
  const ranked = [...sessions].sort((a, b) => priority(b) - priority(a) || recency(b) - recency(a));
  const best = ranked[0];
  const cur = sessions.find((s) => s.sessionId === currentId);
  if (cur && cur !== best && priority(cur) >= priority(best) && recency(best) - recency(cur) < graceMs) {
    return cur;
  }
  return best;
}

// ---------------------------------------------------------------- state

/**
 * One of the Clawd scenes, with the line of text that goes with it:
 *   waiting | agents | compacting | working | thinking | done | sleeping | fresh
 */
function resolve(s, cfg, now) {
  const t = s.t;
  const since = (ms) => (ms ? now - ms : Infinity);

  if (s.waitingFor) {
    const asking = t && t.running.some((x) => x.name === 'AskUserQuestion');
    return {
      scene: 'waiting',
      label: asking ? 'Asking you a question' : WAITING_LABELS[s.waitingFor] || 'Waiting on you',
      timer: s.statusUpdatedAt,
    };
  }

  if (s.status === 'busy') {
    const turn = (t && t.turnStartAt) || s.statusUpdatedAt;
    const mi = modelInfo(t && t.model);
    if (t && t.turnCommand === '/compact') {
      return { scene: 'compacting', label: 'Compacting context', timer: turn };
    }
    // Auto-compaction writes nothing until it finishes, so a silent busy
    // session with a nearly full context window is almost certainly compacting.
    if (
      t &&
      mi.contextWindow &&
      t.contextTokens / mi.contextWindow > 0.9 &&
      since(t.lastEventAt) > 15000 &&
      t.running.length === 0
    ) {
      return { scene: 'compacting', label: 'Compacting context', timer: turn };
    }
    const agents = t ? t.agentsRunning : 0;
    if (agents > 1) return { scene: 'agents', label: `Running ${agents} agents`, timer: turn };
    if (agents === 1) {
      const a = t.running.find((x) => x.name === 'Agent' || x.name === 'Task');
      return { scene: 'agents', label: describeTool(a), timer: turn };
    }
    const tool = t && (t.running[t.running.length - 1] || null);
    if (tool) return { scene: 'working', label: describeTool(tool), timer: turn };
    // Hold the last tool on screen for a moment after it returns, so a quick
    // read/think/edit loop shows the work instead of flickering "Thinking".
    if (t && t.lastTool && since(t.lastTool.at) < cfg.toolDwellSeconds * 1000 && t.lastTool.at >= turn) {
      return { scene: 'working', label: describeTool(t.lastTool), timer: turn };
    }
    const writing = t && t.lastAssistant && t.lastAssistant.kind === 'text';
    return { scene: 'thinking', label: writing ? 'Writing a response' : 'Thinking', timer: turn };
  }

  // Idle: the turn ended and Claude is waiting for the next prompt.
  if (!t || !t.turnStartAt) return { scene: 'fresh', label: 'Just getting started', timer: s.startedAt };
  if (since(s.statusUpdatedAt) < cfg.doneSeconds * 1000) {
    return { scene: 'done', label: 'Done · your move', timer: s.statusUpdatedAt };
  }
  return { scene: 'sleeping', label: 'Idle', timer: s.startedAt };
}

// ---------------------------------------------------------------- redaction

/**
 * Anything that reaches Discord is public. Absolute paths carry the account
 * name (C:\Users\<real name>\...), and commands, search patterns and titles can
 * all contain one, so every outgoing string is scrubbed - in every privacy mode.
 */
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const REDACTIONS = (() => {
  const home = os.homedir();
  const names = new Set();
  for (const n of [os.userInfo().username, process.env.USERNAME, process.env.USER, path.basename(home)]) {
    if (!n) continue;
    names.add(n);
    // "First Last" also leaks as just "First" or "Last".
    for (const part of n.split(/[\s._-]+/)) if (part.length >= 3) names.add(part);
  }
  return [
    ...[home, home.replace(/\\/g, '/')].map((h) => [new RegExp(escapeRe(h), 'gi'), '~']),
    // Anyone else's profile dir, and any path that survived the line above.
    [/(?:[A-Za-z]:)?[\\/](?:Users|home)[\\/][^\\/"'`]+/gi, '~'],
    // Whatever drive or UNC path is left shrinks to its last segment.
    [/(?:\b[A-Za-z]:|\\\\[^\\/\s]+)[\\/](?:[^\\/\s"'`]+[\\/])*([^\\/\s"'`]*)/g, '$1'],
    ...[...names]
      .sort((a, b) => b.length - a.length)
      .map((n) => [new RegExp(`\\b${escapeRe(n)}\\b`, 'gi'), '•••']),
  ];
})();

function scrub(s) {
  for (const [re, to] of REDACTIONS) s = s.replace(re, to);
  return s;
}

/** Discord rejects <2 chars and truncates >128. Every outgoing string passes here. */
function clamp(s, fallback) {
  s = scrub(s == null ? '' : String(s)).trim();
  if (s.length < 2) s = fallback;
  return s.length > 128 ? s.slice(0, 127) + '…' : s;
}

// ---------------------------------------------------------------- formatting

const fmtTokens = (n) =>
  n >= 1e6 ? `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n);

const join = (...parts) => parts.filter(Boolean).join('  ·  ');

function globToRe(g) {
  return new RegExp(`^${g.split('*').map(escapeRe).join('.*')}$`, 'i');
}

/** True for paths inside a folder matched by hideProjects. */
function hiddenPath(cfg) {
  const res = (cfg.hideProjects || []).map(globToRe);
  return (p) => res.length > 0 && String(p).split(/[\\/]/).some((seg) => res.some((re) => re.test(seg)));
}

/** github.com URL for cwd's origin remote, read straight from .git/config. */
function githubUrl(cwd) {
  for (let dir = cwd; dir && dir !== path.dirname(dir); dir = path.dirname(dir)) {
    let cfg;
    try {
      cfg = fs.readFileSync(path.join(dir, '.git', 'config'), 'utf8');
    } catch {
      continue;
    }
    const m = /\[remote "origin"\][^[]*?url\s*=\s*(\S+)/.exec(cfg);
    if (!m) return null;
    const gh = /github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?$/.exec(m[1]);
    return gh ? `https://github.com/${gh[1]}/${gh[2]}` : null;
  }
  return null;
}

// ---------------------------------------------------------------- idle stat frames

const fmtCount = (n) => {
  const a = Math.abs(n);
  const f = (v, s) => `${v >= 100 ? Math.round(v) : v >= 10 ? v.toFixed(1).replace(/\.0$/, '') : v.toFixed(2).replace(/\.?0+$/, '')}${s}`;
  return a >= 1e9 ? f(n / 1e9, 'B') : a >= 1e6 ? f(n / 1e6, 'M') : a >= 1e3 ? f(n / 1e3, 'k') : String(Math.round(n));
};
const fmtMin = (m) => (m < 60 ? `${m}m` : m < 600 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${Math.round(m / 60)}h`);
const fmtUsd = (v) => (v >= 1000 ? `$${fmtCount(v)}` : `$${v.toFixed(2)}`);
const fmtAgo = (ms) => {
  const m = Math.floor(ms / 60000);
  return m < 60 ? `${m}m` : m < 1440 ? `${Math.floor(m / 60)}h` : `${Math.floor(m / 1440)}d`;
};

const ALL_FRAMES = ['session', 'lifetime', 'churn', 'cost', 'week', 'hotspot', 'models', 'alltime', 'cache', 'streak'];

/**
 * Lifetime-stats frames the idle card rotates through. Each returns null when
 * it has nothing worth saying, and is skipped.
 */
function statFrames(sum, ctx, now) {
  const F = {
    session: () =>
      ctx.privacy !== 'minimal' && {
        details: `Idle in ${ctx.privacy === 'full' ? ctx.title || ctx.project : ctx.project}`,
        state: [ctx.model, sum.todayMin ? `${fmtMin(sum.todayMin)} today` : null].filter(Boolean).join(' · '),
      },
    lifetime: () =>
      sum.totalTokens && {
        details: `Lifetime · ${fmtCount(sum.totalTokens)} tokens`,
        state: `${fmtCount(sum.toolCalls)} tool calls · ${fmtCount(sum.files)} files`,
      },
    churn: () => {
      if (!sum.added) return null;
      const net = sum.added - sum.removed;
      return {
        details: `Code churn · ${fmtCount(sum.added)} added`,
        state: [`${net >= 0 ? '+' : '−'}${fmtCount(Math.abs(net))} net`, sum.topLang].filter(Boolean).join(' · '),
      };
    },
    cost: () =>
      sum.costAll >= 0.01 && {
        details: `Cost · ${fmtUsd(sum.costToday)} today`,
        state: `${fmtUsd(sum.costAll)} all-time`,
      },
    week: () =>
      sum.weekMin && {
        details: `Past 7 days · ${fmtMin(sum.weekMin)}`,
        state: `${fmtCount(sum.weekPrompts)} prompts · ${fmtCount(sum.weekTokens)} tokens`,
      },
    hotspot: () => {
      if (ctx.privacy !== 'full') return null;
      const h = sum.hotspots.find((x) => !ctx.hidden(x.file));
      return (
        h &&
        h.edits > 1 && {
          details: `Hotspot · ${base(h.file)}`,
          state: `${fmtCount(h.edits)} edits · ${fmtAgo(now - h.lastAt)} since last edit`,
        }
      );
    },
    models: () => {
      const parts = sum.models.filter((m) => m.share >= 0.01).map((m) => `${m.name} ${Math.round(m.share * 100)}%`);
      return parts.length > 1 && { details: 'Model split', state: parts.join(' · ') };
    },
    alltime: () =>
      sum.allMin && {
        details: `${fmtMin(sum.allMin)} on Claude all-time`,
        state: `${fmtCount(sum.sessions)} sessions · ${fmtCount(sum.prompts)} prompts`,
      },
    cache: () =>
      sum.freshTokens && {
        details: `${fmtCount(sum.freshTokens)} fresh tokens`,
        state: `${sum.cachePct >= 99.95 ? '100' : sum.cachePct.toFixed(1)}% from cache`,
      },
    streak: () =>
      sum.streak >= 2 && {
        details: `Streak · ${sum.streak} days`,
        state: `Longest · ${sum.longestStreak} days`,
      },
  };
  return (ctx.frames || ALL_FRAMES).map((k) => F[k] && F[k]()).filter(Boolean);
}

/** The frame for right now, if the idle card should rotate. */
function rotation(stats, cfg, ctx, now) {
  if (!stats || !Array.isArray(cfg.idleStats) || !cfg.idleStats.length) return null;
  // With the cost always on the card, its own frame would just repeat it.
  const keys = costTag(cfg, stats) ? cfg.idleStats.filter((k) => k !== 'cost') : cfg.idleStats;
  const frames = statFrames(stats, { ...ctx, frames: keys }, now);
  if (!frames.length) return null;
  return frames[Math.floor(now / (cfg.idleRotateSeconds * 1000)) % frames.length];
}

/**
 * showCost: the money, on the card at all times, from the lifetime stats.
 * "both" (default) today and all-time, "today", "all", or false to leave it
 * to the idle rotation.
 */
function costTag(cfg, stats) {
  if (!cfg.showCost || !stats) return null;
  const today = `${fmtUsd(stats.costToday)} today`;
  const all = `${fmtUsd(stats.costAll)} all-time`;
  return cfg.showCost === 'today' ? today : cfg.showCost === 'all' ? all : join(today, all);
}

// ---------------------------------------------------------------- payload

const BADGE_FOR = {
  waiting: 'waiting',
  agents: 'agents',
  compacting: 'working',
  working: 'working',
  thinking: 'thinking',
  done: 'done',
  sleeping: 'sleeping',
  fresh: 'done',
};

// ---------------------------------------------------------------- art selection

const BUSY_SCENES = new Set(['working', 'thinking', 'agents']);
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
const PETS = ['credits', 'bug', 'cursor', 'nap'];

/**
 * Reasoning tier for the busy art: "ultra" while ultracode is on for the
 * session, or this turn used the keyword or sent out a workflow; otherwise the
 * effort of the latest API call.
 */
function tierOf(t) {
  if (!t) return 'high';
  if (t.ultracodeOn || t.turnUltra) return 'ultra';
  return EFFORTS.includes(t.effort) ? t.effort : 'high';
}

/**
 * Which pet vignette plays right now. Slots of petMinutes each; within every
 * run of N slots the pets come up in a shuffled order, so none repeats
 * back-to-back inside a cycle and the pick is stable for the whole slot.
 */
function petFor(cfg, now) {
  const list = Array.isArray(cfg.pets) && cfg.pets.length ? cfg.pets : PETS;
  const n = list.length;
  const slot = Math.floor(now / ((cfg.petMinutes || 3) * 60000));
  const cycle = Math.floor(slot / n);
  const order = shuffled(list, cycle);
  // Never repeat across a cycle boundary either.
  if (n > 1 && order[0] === shuffled(list, cycle - 1)[n - 1]) [order[0], order[1]] = [order[1], order[0]];
  return order[slot % n];
}

/** Deterministic shuffle of `list` for a given cycle (integer hash keys). */
function shuffled(list, cycle) {
  const mix = (x) => {
    x = Math.imul(x ^ (x >>> 16), 0x7feb352d);
    x = Math.imul(x ^ (x >>> 15), 0x846ca68b);
    return (x ^ (x >>> 16)) >>> 0;
  };
  return list
    .map((p, i) => [p, mix(cycle * 64 + i + 1)])
    .sort((a, b) => a[1] - b[1])
    .map((e) => e[0]);
}

/** { gif, still } names for a scene: the animated file and its portal still. */
function artFor(scene, tier, cfg, now) {
  if (BUSY_SCENES.has(scene)) return { gif: tier === 'high' ? scene : `${scene}-${tier}`, still: scene };
  if (scene === 'sleeping' || scene === 'idle') {
    const pet = petFor(cfg, now);
    return { gif: `pet-${pet}`, still: scene === 'idle' ? 'idle' : 'sleeping' };
  }
  if (scene === 'fresh') return { gif: 'idle', still: 'idle' };
  return { gif: scene, still: scene };
}

/**
 * @returns activity payload, or null to clear the presence. `_scene` and
 * `_summary` are for logging and are stripped before sending.
 */
function build(sessions, chosen, cfg, now = Date.now(), stats = null, env = {}) {
  if (!chosen) {
    if (!cfg.showWhenIdle) return null;
    const a = { type: cfg.activityType, details: 'Claude', state: 'No session open', _scene: 'idle' };
    const frame = rotation(stats, cfg, { privacy: cfg.privacy, project: 'Claude', hidden: hiddenPath(cfg) }, now);
    if (frame && frame.details.startsWith('Idle in')) frame.details = 'Claude';
    if (frame) Object.assign(a, { details: clamp(frame.details, 'Claude'), state: clamp(frame.state, 'Idle') });
    if (costTag(cfg, stats)) a.state = clamp(join(costTag(cfg, stats), frame ? frame.state : a.state), 'Idle');
    const large = imageRef(cfg, artFor('idle', 'high', cfg, now), 'large');
    if (large) a.assets = { large_image: large, large_text: 'Claude' };
    a._art = artFor('idle', 'high', cfg, now).gif;
    a._summary = 'no live sessions';
    return a;
  }

  const s = chosen;
  const t = s.t;
  const st = resolve(s, cfg, now);
  const atHome = s.cwd && path.resolve(s.cwd).toLowerCase() === os.homedir().toLowerCase();
  const project = !s.cwd ? 'a project' : atHome ? 'home' : path.basename(s.cwd);

  let privacy = cfg.privacy;
  if (privacy !== 'minimal' && (cfg.hideProjects || []).some((g) => globToRe(g).test(project))) {
    privacy = 'minimal';
  }

  const mi = modelInfo(t && t.model);
  const ctxPct = mi.contextWindow && t && t.contextTokens ? Math.round((t.contextTokens / mi.contextWindow) * 100) : null;
  const churn = t && (t.added || t.removed) ? `+${t.added} −${t.removed}` : null;
  const others = sessions.filter((x) => x !== s);
  const othersBusy = others.filter((x) => x.status === 'busy' || x.waitingFor).length;
  const title = s.name || (t && t.title);

  let details;
  let state;
  if (privacy === 'minimal') {
    details = 'Working with Claude';
    state = { waiting: 'Waiting on me', done: 'Taking a break', sleeping: 'Idle', fresh: 'Starting up' }[st.scene] || 'Working';
  } else if (privacy === 'project') {
    details = `In ${project}`;
    state = join(genericize(st.label), churn);
  } else {
    details = title || `Session in ${project}`;
    state = join(st.label, churn);
  }

  // Dozing: rotate through lifetime stats instead of a static "Idle".
  if (st.scene === 'sleeping') {
    const frame = rotation(stats, cfg, { privacy, title, project, model: mi.name, hidden: hiddenPath(cfg) }, now);
    if (frame) ({ details, state } = frame);
  }

  // Money first: Discord truncates the end of a long line, never the start.
  const money = costTag(cfg, stats);
  if (money) state = join(money, state);

  const activity = {
    type: cfg.activityType,
    details: clamp(details, 'Claude'),
    state: clamp(state, 'Working'),
  };

  const tier = tierOf(t);
  const busyArt = BUSY_SCENES.has(st.scene);
  // Evil mode: busy while IDA Pro is open, or while Claude itself is in IDA.
  const inIda =
    t &&
    (t.running.some((x) => isIdaTool(x.name)) ||
      (t.lastTool && isIdaTool(t.lastTool.name) && now - t.lastTool.at < cfg.toolDwellSeconds * 1000));
  const evil = cfg.idaEvil !== false && busyArt && (env.ida || inIda);
  const effortLabel = !t ? null : tier === 'ultra' ? 'ultracode' : t.effort ? `${t.effort} effort` : null;

  // Hover text on the big image: model, effort, context, output. Hidden in minimal.
  const largeText =
    privacy === 'minimal'
      ? 'Claude'
      : join(
          mi.name,
          evil ? 'IDA Pro' : null,
          effortLabel,
          ctxPct != null ? `${ctxPct}% context` : null,
          t && t.outputTokens ? `${fmtTokens(t.outputTokens)} tokens out` : null
        );
  const smallText = join(
    evil
      ? 'Cracking it open'
      : busyArt && tier === 'ultra'
      ? 'Ascended'
      : { waiting: 'Waiting on you', agents: 'Agents running', compacting: 'Compacting', working: 'Working', thinking: 'Thinking', done: 'Done', sleeping: 'Idle', fresh: 'Ready' }[st.scene],
    privacy === 'full' && others.length ? `${others.length + 1} sessions${othersBusy ? `, ${othersBusy} more busy` : ''}` : null
  );

  // Discord rejects the whole activity if a *_text is sent without its image.
  const assets = {};
  const art = evil ? { gif: 'hacking', still: 'hacking' } : artFor(st.scene, tier, cfg, now);
  const badgeName = evil ? 'hacking' : busyArt && tier === 'ultra' ? 'ultra' : BADGE_FOR[st.scene];
  const large = imageRef(cfg, art, 'large');
  const small = imageRef(cfg, { gif: badgeName, still: badgeName }, 'small');
  if (large) {
    assets.large_image = large;
    assets.large_text = clamp(largeText, 'Claude');
  }
  if (small) {
    assets.small_image = small;
    assets.small_text = clamp(smallText, 'Claude');
  }
  if (Object.keys(assets).length) activity.assets = assets;

  const start = cfg.timer === 'session' ? s.startedAt : st.timer;
  if (start) activity.timestamps = { start: Math.floor(start) };

  const buttons = (Array.isArray(cfg.buttons) ? cfg.buttons : []).filter((b) => b && b.label && b.url);
  if (cfg.githubButton && privacy === 'full' && s.cwd && buttons.length < 2) {
    const url = githubUrl(s.cwd);
    if (url) buttons.push({ label: 'View on GitHub', url });
  }
  if (buttons.length) activity.buttons = buttons.slice(0, 2).map((b) => ({ label: short(b.label, 32), url: b.url }));

  if (cfg.statusDisplay != null) activity.status_display_type = cfg.statusDisplay;

  activity._scene = st.scene;
  activity._art = art.gif;
  activity._summary = `${sessions.length} live · ${st.scene}`;
  return activity;
}

/**
 * Image for a scene, from the best source configured:
 *   images.baseUrl   animated Clawd GIFs served from that URL (tiers, pets)
 *   images.portal    static Clawd stills uploaded as Discord art assets
 *                    (assets/clawd/portal/*.png - keys clawd_<scene>, badge_<state>)
 *   assets           the plain legacy keys
 */
function imageRef(cfg, art, size) {
  const im = cfg.images || {};
  if (im.baseUrl) {
    const file = size === 'small' ? `badge-${art.gif}` : art.gif;
    const v = im.version ? `?v=${encodeURIComponent(im.version)}` : '';
    return `${im.baseUrl.replace(/\/+$/, '')}/${file}.gif${v}`;
  }
  if (im.portal) return size === 'small' ? `badge_${art.still}` : `clawd_${art.still}`;
  const a = cfg.assets || {};
  if (size === 'large') return a.largeImage || null;
  const busy = ['working', 'thinking', 'agents', 'waiting', 'ultra'].includes(art.still);
  return (busy ? a.smallImageBusy : a.smallImageIdle) || null;
}

module.exports = { isIdaTool, describeIda, pick, resolve, build, describeTool, scrub, githubUrl, statFrames, hiddenPath, tierOf, petFor, ALL_FRAMES };
