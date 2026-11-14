'use strict';
const { ACTION_LABELS } = require('./activity');
const { localDay } = require('./day');
const STATES = new Set(['working', 'thinking', 'waiting', 'idle']);
const PROVIDERS = ['codex', 'claude', 'opencode'];
const MODEL_KINDS = new Set(['glm', 'deepseek']);
const ORDER = { working: 3, thinking: 3, waiting: 2, idle: 1 };
const count = (value) => {
  const n = Number.isFinite(value) ? Math.max(0, value) : 0;
  if (n >= 1e9) return `${+(n / 1e9).toFixed(1)}b`;
  if (n >= 1e6) return `${+(n / 1e6).toFixed(1)}m`;
  if (n >= 1e3) return `${+(n / 1e3).toFixed(1)}k`;
  return String(Math.round(n));
};
const short = (s, n = 128) => String(s || '').replace(/[\x00-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);
const safeCut = (text, limit) => {
  const cut = text.slice(0, Math.max(0, limit));
  return /[\uD800-\uDBFF]$/.test(cut) ? cut.slice(0, -1) : cut;
};
function money(value) {
  if (value >= 99.995) return `$${value.toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
  if (value > 0 && value < 0.01) return '<$0.01';
  return `$${value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
const FAMILY = 'fable|mythos|opus|sonnet|haiku';
function prettyModel(model, provider) {
  const raw = short(model, 40);
  if (provider !== 'claude' && !/^claude-/i.test(raw)) return raw;
  let id = raw.toLowerCase().replace(/^claude-/, '').replace(/\[[^\]]*\]$/, '').replace(/-\d{8}$/, '');
  id = id.replace(new RegExp(`^(${FAMILY})-(\\d+)-(\\d+)$`), '$1 $2.$3').replace(new RegExp(`^(${FAMILY})-(\\d+)$`), '$1 $2')
    .replace(new RegExp(`^(\\d+)-(\\d+)-(${FAMILY})$`), '$3 $1.$2');
  return short(id, 40);
}
// a '+' means a real share of the tokens (over 0.1%) could not be priced. a few
// stray unpriced tokens in billions would otherwise pin the mark on forever.
const plus = (usage) => usage.unpricedTokens > (usage.total || 0) * 0.001 ? '+' : '';
// one provider's cost text: all-time total, then today when the summary has a today bucket.
function costText(usage, now) {
  const parts = [`~${money(usage.costUSD)}${plus(usage)} total`];
  if (usage.today && typeof usage.today === 'object') {
    const t = usage.today.day === localDay(now) ? usage.today : { costUSD: 0, unpricedTokens: 0 };
    parts.push(t.costUSD === null ? 'today unpriced' : `~${money(t.costUSD || 0)}${plus(t)} today`);
  }
  return parts.join(' · ');
}
const savedTitle = (value) => typeof value === 'string'
  ? value.replace(/[\p{Cc}\p{Cf}]/gu, ' ').replace(/[\uD800-\uDFFF]/gu, '').replace(/\s+/gu, ' ').trim()
  : '';
function titledDescription(parts, separator, titleLimit = 75) {
  const labelsLength = parts.reduce((sum, part) => sum + part.label.length, 0) + separator.length * (parts.length - 1);
  const titled = parts.filter((part) => part.title);
  let available = Math.max(0, 128 - labelsLength - titled.length * 3);
  const budgets = parts.map(() => 0);
  const needs = parts.map((part) => Math.min(part.title.length, titleLimit));
  // Reserve both action labels first, then share title space fairly. A short
  // title gives its unused space to the other provider's title.
  while (available > 0 && budgets.some((budget, i) => budget < needs[i])) {
    for (let i = 0; i < parts.length && available > 0; i++) {
      if (budgets[i] < needs[i]) { budgets[i]++; available--; }
    }
  }
  return parts.map((part, i) => {
    if (!part.title || !budgets[i]) return part.label;
    const title = part.title.length > budgets[i]
      ? `${safeCut(part.title, budgets[i] - 1).trimEnd()}…` : part.title;
    return `${part.label} · ${title}`;
  }).join(separator);
}
const stateOf = (s) => s.stale || !STATES.has(s.status) ? 'idle' : s.status;
function actionOf(s) {
  const status = stateOf(s);
  if (s.stale) return 'idle';
  if (status === 'waiting') return 'waiting';
  if (status === 'idle') return s.action === 'done' ? 'done' : 'idle';
  return Object.hasOwn(ACTION_LABELS, s.action) ? s.action : status === 'thinking' ? 'thinking' : 'working';
}
function epoch(value) {
  const numeric = typeof value === 'number' || (typeof value === 'string' && /^\d+(?:\.\d+)?$/.test(value));
  const number = numeric ? Number(value) : typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isFinite(number) && number > 0 ? Math.floor(numeric && number < 1e11 ? number * 1000 : number) : 0;
}
function summarize(sessions, now, retention = 600000, staleMs = 120000) {
  const unique = new Map();
  for (const input of sessions) {
    if (!input || !PROVIDERS.includes(input.provider)) continue;
    const updatedAt = epoch(input.updatedAt);
    if (!updatedAt || now - updatedAt > retention || updatedAt > now + 60000) continue;
    const s = { ...input, updatedAt, startedAt: epoch(input.startedAt), stale: input.stale || now - updatedAt > staleMs };
    const key = `${s.provider}:${s.sessionId}`;
    if (!unique.has(key) || unique.get(key).updatedAt < s.updatedAt) unique.set(key, s);
  }
  return PROVIDERS.map((provider) => {
    const rows = [...unique.values()].filter((s) => s.provider === provider)
      .sort((a, b) => ORDER[stateOf(b)] - ORDER[stateOf(a)] || b.updatedAt - a.updatedAt);
    if (!rows.length) return null;
    const chosen = rows[0];
    const hasUsage = (s) => Number.isFinite(s.tokens?.total) && s.tokens.total >= 0 &&
      (s.hasUsage === true || s.usageComplete === true || s.tokens.total > 0);
    return { provider, chosen, status: stateOf(chosen), action: actionOf(chosen), count: rows.length,
      total: rows.reduce((sum, s) => sum + (hasUsage(s) ? s.tokens.total : 0), 0),
      hasUsage: rows.some(hasUsage),
      partial: rows.some((s) => !hasUsage(s) || s.usageComplete === false || s.hasUsage === false),
      startedAt: chosen.startedAt || chosen.updatedAt };
  }).filter(Boolean);
}
function hidden(cwd, cfg) {
  return (cfg.hideProjects || []).some((glob) => {
    const re = new RegExp(`^${glob.split('*').map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`, 'i');
    return String(cwd || '').split(/[\\/]/).some((segment) => re.test(segment));
  });
}
function asset(name, cfg) {
  if (cfg.images.portal) return name.replace(/-/g, '_');
  if (!cfg.images.baseUrl) return null;
  const extension = cfg.images.animated === false ? 'png' : 'gif';
  return `${cfg.images.baseUrl}/${name}.${extension}${cfg.images.version ? `?v=${encodeURIComponent(cfg.images.version)}` : ''}`;
}
function idleActivity(cfg, history, now = Date.now()) {
  const enabled = PROVIDERS.filter((provider) => cfg.providers[provider] !== false);
  if (!enabled.length) return null;
  const ready = history?.ready;
  const withHistory = enabled.filter((provider) => ready && history.providers?.[provider] &&
    Number.isFinite(history.providers[provider].total));
  const lifetime = withHistory.length ? withHistory : enabled.filter((provider) => provider !== 'opencode');
  const pinned = cfg.alwaysShowCost || [];
  const ordered = [...lifetime.filter((p) => pinned.includes(p)).sort((a, b) => pinned.indexOf(a) - pinned.indexOf(b)), ...lifetime.filter((p) => !pinned.includes(p))];
  const totals = ready ? ordered.map((provider) => {
    const usage = history.providers[provider];
    const total = usage?.total || 0;
    const unit = total >= 1e9 ? 1e8 : total >= 1e6 ? 1e5 : total >= 1e3 ? 100 : 1;
    return `${provider} ${usage?.incomplete ? '≥' : ''}${count(usage?.incomplete ? Math.floor(total / unit) * unit : total)}`;
  }).join(' · ') : '';
  const costs = ready ? ordered.map((provider) => {
    const usage = history.providers?.[provider];
    return Number.isFinite(usage?.costUSD) ? `${provider} ${costText(usage, now)}` : `${provider} unpriced`;
  }).join(' | ') : '';
  // an opencode-only setup has no lifetime providers, so there is nothing to total or price.
  const showLifetime = cfg.showTokens && ready && ordered.length > 0;
  const details = showLifetime ? `all-time tokens · ${totals}` : `${(lifetime.length ? lifetime : enabled).join(' + ')} · idle`;
  const progress = history?.progress ? ` · ${history.progress.completed}/${history.progress.total} logs` : '';
  const state = history?.error ? 'local history unavailable' : !ready ? `counting local history${progress}` : showLifetime ? costs : 'ready when you are';
  const activity = { name: 'codex + claude', type: cfg.activityType, status_display_type: 2, details: short(details), state: short(state) };
  const idleLogo = lifetime.length ? lifetime : enabled;
  const image = asset(`${idleLogo.length === 1 ? idleLogo[0] : 'both'}-idle`, cfg);
  if (image) activity.assets = { large_image: image, large_text: showLifetime
    ? 'all-time locally recorded tokens · estimated at current standard api rates · not a bill'
    : 'ready when you are' };
  if (cfg.buttons?.length) activity.buttons = cfg.buttons;
  return activity;
}
function buildActivity(sessions, cfg, now = Date.now(), history) {
  const groups = summarize(sessions.filter((s) => s && cfg.providers[s.provider] !== false), now, cfg.idleRetentionMs, cfg.staleMs);
  const active = groups.filter((g) => g.status !== 'idle');
  const parallel = active.length === 2 && active.some((g) => g.provider === 'codex') && active.some((g) => g.provider === 'claude');
  const live = groups.filter((g) => g.status !== 'idle' || (g.action === 'done' && now - epoch(g.chosen.actionAt || g.chosen.updatedAt) <= cfg.doneSeconds * 1000));
  if (!live.length) return cfg.showWhenIdle ? idleActivity(cfg, history, now) : null;
  const candidates = cfg.displayMode === 'rotate' ? groups : active.length ? active : live;
  const rotating = cfg.displayMode === 'combined'
    ? [...candidates].sort((a, b) => ORDER[b.status] - ORDER[a.status] || b.chosen.updatedAt - a.chosen.updatedAt)[0]
    : candidates[Math.floor(now / (cfg.rotateSeconds * 1000)) % candidates.length];
  // OpenCode carries the model badge, so keep it on the main logo while it is
  // active instead of rotating or splitting it away behind another assistant.
  const primary = active.find((g) => g.provider === 'opencode') || rotating;
  const others = groups.filter((g) => g.provider !== primary.provider);
  const dual = groups.length === 2;
  const describe = (g) => `${g.provider}: ${ACTION_LABELS[g.action]}`;
  const titleOf = (g) => cfg.showConversationTitle === true && g.status !== 'idle' ? savedTitle(g.chosen.conversationTitle) : '';
  const descriptions = groups.map((g) => ({ label: describe(g), title: titleOf(g) }));
  const hasTitle = descriptions.some((part) => part.title);
  let details = hasTitle ? titledDescription(descriptions, ' | ') : groups.map(describe).join(' · ');
  const amount = (g) => {
    // A rounded-up lower bound would overstate observed usage.
    const bounded = g.partial && g.total >= 1000
      ? Math.floor(g.total / (g.total >= 1e6 ? 1e5 : 100)) * (g.total >= 1e6 ? 1e5 : 100)
      : g.partial ? Math.floor(g.total) : g.total;
    return `${g.partial ? '≥' : ''}${count(bounded)}`;
  };
  const usage = (g) => g.hasUsage ? `${g.provider} ${amount(g)}` : `${g.provider} pending`;
  const sessionCount = groups.reduce((sum, g) => sum + g.count, 0);
  const usageGroups = groups.filter((g) => g.hasUsage);
  // a provider on the card shows its cost even at zero. one that is only
  // pinned needs real history, or a codex-only user gets a claude $0.00 line.
  const onCard = new Set(groups.map((g) => g.provider));
  const hasCost = (p) => cfg.providers[p] !== false && Number.isFinite(history?.providers?.[p]?.total) && Number.isFinite(history.providers[p].costUSD) &&
    (onCard.has(p) || history.providers[p].total > 0);
  const costProviders = cfg.showTokens && history?.ready
    ? [...new Set([...(cfg.alwaysShowCost || []), ...groups.map((g) => g.provider)])].filter(hasCost) : [];
  const tokenText = usageGroups.length ? `${usageGroups.map(usage).join(' · ')} tokens` : '';
  let state;
  if (!cfg.showTokens) state = `${sessionCount} recent session${sessionCount === 1 ? '' : 's'}`;
  else if (costProviders.length === 1 && groups.length === 1 && groups[0].provider === costProviders[0]) {
    state = costText(history.providers[costProviders[0]], now);
    if (usageGroups.length) state += ` · ${amount(groups[0])} tokens`;
  } else if (costProviders.length) {
    state = costProviders.map((p) => `${p} ${costText(history.providers[p], now)}`).join(' | ');
    if (tokenText && `${state} | ${tokenText}`.length <= 128) state += ` | ${tokenText}`;
  } else state = tokenText || (groups.every((g) => g.provider === 'opencode')
    ? `opencode · ${short(primary.chosen.model, 40) || ACTION_LABELS[primary.action]}`
    : `${groups.map((g) => g.provider).join(' + ')} usage pending`);
  if (!dual || primary.provider === 'opencode') {
    const model = prettyModel(primary.chosen.model, primary.provider);
    if (model) details += ` · ${model}`;
  }
  if (cfg.privacy === 'project' && !hidden(primary.chosen.cwd, cfg)) {
    const folder = short(String(primary.chosen.cwd || '').split(/[\\/]/).filter(Boolean).pop(), 32);
    if (folder) details += ` · ${folder}`;
  }
  const pair = groups.length === 2 && groups.some((g) => g.provider === 'codex') && groups.some((g) => g.provider === 'claude');
  const combined = pair && cfg.displayMode === 'combined';
  const combinedStatus = ['working', 'thinking', 'waiting', 'idle'].find((status) => groups.some((g) => g.status === status));
  const art = parallel
    ? `split-${active.find((g) => g.provider === 'codex').status}-${active.find((g) => g.provider === 'claude').status}`
    : primary.provider === 'opencode' && MODEL_KINDS.has(primary.chosen.modelKind)
      ? `${primary.chosen.modelKind}-${primary.status}`
      : combined ? `both-${combinedStatus}` : `${primary.provider}-${primary.status}`;
  const activity = { name: 'codex + claude', type: cfg.activityType, status_display_type: 2, details: hasTitle ? safeCut(details, 128) : short(details), state: short(state) };
  if (parallel) activity.timestamps = { start: Math.floor(Math.min(now, ...active.map((g) => g.startedAt))) };
  else if (primary.status !== 'idle') activity.timestamps = { start: Math.floor(Math.min(now, primary.startedAt)) };
  const large = asset(art, cfg), small = asset(`action-${primary.action}`, cfg);
  const hoverParts = parallel || combined || groups.length > 2 ? descriptions : [{ label: describe(primary), title: titleOf(primary) }];
  if (large) activity.assets = {
    large_image: large,
    large_text: hoverParts.some((part) => part.title) ? titledDescription(hoverParts, ' | ', 128)
      : short(hoverParts.length > 1 ? groups.map(describe).join(' | ') : `${describe(primary)} · ${primary.count} recent session${primary.count === 1 ? '' : 's'}`),
    ...(small ? { small_image: small, small_text: short(`${describe(primary)}${others.length ? ` | ${others.map(describe).join(' | ')}` : ''}`) } : {}),
  };
  if (cfg.buttons?.length) activity.buttons = cfg.buttons;
  return activity;
}
module.exports = { buildActivity, idleActivity, summarize, asset, count, prettyModel, money };
