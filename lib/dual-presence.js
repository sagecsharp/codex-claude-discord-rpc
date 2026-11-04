'use strict';
const STATES = new Set(['working', 'thinking', 'waiting', 'idle']);
const ORDER = { working: 3, thinking: 3, waiting: 2, idle: 1 };
const count = (value) => {
  const n = Number.isFinite(value) ? Math.max(0, value) : 0;
  if (n >= 1e6) return `${+(n / 1e6).toFixed(1)}m`;
  if (n >= 1e3) return `${+(n / 1e3).toFixed(1)}k`;
  return String(Math.round(n));
};
const short = (s, n = 128) => String(s || '').replace(/[\x00-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);
const stateOf = (s) => s.stale || !STATES.has(s.status) ? 'idle' : s.status;
function epoch(value) {
  const numeric = typeof value === 'number' || (typeof value === 'string' && /^\d+(?:\.\d+)?$/.test(value));
  const number = numeric ? Number(value) : typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isFinite(number) && number > 0 ? Math.floor(numeric && number < 1e11 ? number * 1000 : number) : 0;
}
function summarize(sessions, now, retention = 600000, staleMs = 120000) {
  const unique = new Map();
  for (const input of sessions) {
    if (!input || !['codex', 'claude'].includes(input.provider)) continue;
    const updatedAt = epoch(input.updatedAt);
    if (!updatedAt || now - updatedAt > retention || updatedAt > now + 60000) continue;
    const s = { ...input, updatedAt, startedAt: epoch(input.startedAt), stale: input.stale || now - updatedAt > staleMs };
    const key = `${s.provider}:${s.sessionId}`;
    if (!unique.has(key) || unique.get(key).updatedAt < s.updatedAt) unique.set(key, s);
  }
  return ['codex', 'claude'].map((provider) => {
    const rows = [...unique.values()].filter((s) => s.provider === provider)
      .sort((a, b) => ORDER[stateOf(b)] - ORDER[stateOf(a)] || b.updatedAt - a.updatedAt);
    if (!rows.length) return null;
    const chosen = rows[0];
    const hasUsage = (s) => Number.isFinite(s.tokens?.total) && s.tokens.total >= 0 &&
      (s.hasUsage === true || s.usageComplete === true || s.tokens.total > 0);
    return { provider, chosen, status: stateOf(chosen), count: rows.length,
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
function buildActivity(sessions, cfg, now = Date.now()) {
  const groups = summarize(sessions.filter((s) => s && cfg.providers[s.provider] !== false), now, cfg.idleRetentionMs, cfg.staleMs);
  const live = groups.filter((g) => g.status !== 'idle');
  if (!live.length && !cfg.showWhenIdle) return null;
  const candidates = cfg.displayMode === 'rotate' ? groups : live.length ? live : groups;
  if (!candidates.length) {
    const image = asset('both-idle', cfg);
    return { name: 'codex + claude', type: cfg.activityType, details: 'codex + claude', state: 'no recent activity', ...(image ? { assets: { large_image: image, large_text: 'ready when you are' } } : {}) };
  }
  const primary = cfg.displayMode === 'combined'
    ? [...candidates].sort((a, b) => ORDER[b.status] - ORDER[a.status] || b.chosen.updatedAt - a.chosen.updatedAt)[0]
    : candidates[Math.floor(now / (cfg.rotateSeconds * 1000)) % candidates.length];
  const secondary = groups.find((g) => g.provider !== primary.provider);
  const dual = groups.length === 2;
  let details = dual ? `codex: ${groups[0].status} · claude: ${groups[1].status}` : `${primary.provider} · ${primary.status}`;
  const usage = (g) => {
    if (!g.hasUsage) return `${g.provider} pending`;
    // A rounded-up lower bound would overstate observed usage.
    const bounded = g.partial && g.total >= 1000
      ? Math.floor(g.total / (g.total >= 1e6 ? 1e5 : 100)) * (g.total >= 1e6 ? 1e5 : 100)
      : g.partial ? Math.floor(g.total) : g.total;
    return `${g.provider} ${g.partial ? '≥' : ''}${count(bounded)}`;
  };
  const sessionCount = groups.reduce((sum, g) => sum + g.count, 0);
  const state = cfg.showTokens
    ? groups.some((g) => g.hasUsage) ? `${groups.map(usage).join(' · ')} tokens (recent sessions)` : `${groups.map((g) => g.provider).join(' + ')} usage pending`
    : `${sessionCount} recent session${sessionCount === 1 ? '' : 's'}`;
  if (!dual) {
    const model = short(primary.chosen.model, 40);
    if (model) details = `${primary.provider} · ${primary.status} · ${model}`;
  }
  if (cfg.privacy === 'project' && !hidden(primary.chosen.cwd, cfg)) {
    const folder = short(String(primary.chosen.cwd || '').split(/[\\/]/).filter(Boolean).pop(), 32);
    if (folder) details += ` · ${folder}`;
  }
  const combined = dual && cfg.displayMode === 'combined';
  const combinedStatus = ['working', 'thinking', 'waiting', 'idle'].find((status) => groups.some((g) => g.status === status));
  const art = combined ? `both-${combinedStatus}` : `${primary.provider}-${primary.status}`;
  const activity = { name: 'codex + claude', type: cfg.activityType, details: short(details), state: short(state) };
  if (primary.status !== 'idle') activity.timestamps = { start: Math.floor(Math.min(now, primary.startedAt)) };
  const large = asset(art, cfg), small = secondary && asset(`${secondary.provider}-${secondary.status}`, cfg);
  if (large) activity.assets = {
    large_image: large,
    large_text: short(combined ? groups.map((g) => `${g.provider} · ${g.status}`).join(' | ') : `${primary.provider} · ${primary.status} · ${primary.count} recent session${primary.count === 1 ? '' : 's'}`),
    ...(small ? { small_image: small, small_text: short(`${secondary.provider} · ${secondary.status}${cfg.showTokens ? ` · ${usage(secondary)} tokens` : ''}`) } : {}),
  };
  if (cfg.buttons?.length) activity.buttons = cfg.buttons;
  return activity;
}
module.exports = { buildActivity, summarize, asset, count };
