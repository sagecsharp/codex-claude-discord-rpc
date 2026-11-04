'use strict';
const fs = require('node:fs');
const path = require('node:path');
const DEFAULTS = {
  clientId: '', privacy: 'minimal', hideProjects: [], displayMode: 'auto',
  providers: { codex: true, claude: true }, showTokens: true, showWhenIdle: true, showConversationTitle: false,
  images: { baseUrl: '', animated: true, portal: false, version: '1' },
  activityType: 3, rotateSeconds: 20, pollIntervalMs: 2000,
  staleMs: 120000, idleRetentionMs: 600000, doneSeconds: 20, buttons: [],
};
function read(file) {
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '').replace(/^\s*\/\/.*$/gm, ''));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('expected a json object');
    for (const key of ['images', 'providers']) {
      if (key in value && (!value[key] || typeof value[key] !== 'object' || Array.isArray(value[key]))) throw new Error(`${key} must be an object`);
    }
    return value;
  }
  catch (err) { if (err.code === 'ENOENT') return {}; throw new Error(`invalid configuration in ${path.basename(file)}: ${err.message}`); }
}
function loadConfig(root, args = [], env = process.env) {
  const option = (name) => args.find((x) => x.startsWith(`--${name}=`))?.slice(name.length + 3);
  const layers = [DEFAULTS, read(path.join(root, 'config.example.json')), read(option('config') || path.join(root, 'config.json'))];
  const cfg = Object.assign({}, ...layers);
  for (const key of ['providers', 'images']) cfg[key] = Object.assign({}, ...layers.map((x) => x[key] || {}));
  cfg.clientId = String(option('client-id') ?? env.DUAL_RPC_CLIENT_ID ?? cfg.clientId).trim();
  cfg.images.baseUrl = option('image-base') ?? cfg.images.baseUrl;
  if (!['minimal', 'project'].includes(cfg.privacy)) throw new Error('privacy must be minimal or project');
  if (!['auto', 'combined', 'rotate'].includes(cfg.displayMode)) throw new Error('displayMode must be auto, combined or rotate');
  for (const value of [cfg.showTokens, cfg.showWhenIdle, cfg.showConversationTitle, cfg.providers.codex, cfg.providers.claude, cfg.images.animated, cfg.images.portal]) {
    if (typeof value !== 'boolean') throw new Error('provider, image, and display switches must be true or false');
  }
  if (![0, 2, 3, 5].includes(cfg.activityType)) throw new Error('unsupported activityType');
  for (const key of ['rotateSeconds', 'pollIntervalMs', 'staleMs', 'idleRetentionMs']) {
    if (!Number.isFinite(cfg[key]) || cfg[key] <= 0) throw new Error(`${key} must be a positive number`);
  }
  cfg.rotateSeconds = Math.max(15, cfg.rotateSeconds);
  cfg.pollIntervalMs = Math.max(1000, cfg.pollIntervalMs);
  cfg.idleRetentionMs = Math.max(cfg.staleMs, cfg.idleRetentionMs);
  if (!Number.isFinite(cfg.doneSeconds) || cfg.doneSeconds < 0) throw new Error('doneSeconds must be zero or positive');
  if (cfg.images.baseUrl) {
    let url;
    try { url = new URL(cfg.images.baseUrl); } catch { throw new Error('images.baseUrl must be a public https url'); }
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error('images.baseUrl must be an https directory url without credentials, query or fragment');
    cfg.images.baseUrl = url.href.replace(/\/$/, '');
  }
  if (!Array.isArray(cfg.hideProjects) || !cfg.hideProjects.every((x) => typeof x === 'string')) throw new Error('hideProjects must be an array of folder globs');
  if (!Array.isArray(cfg.buttons) || cfg.buttons.length > 2) throw new Error('buttons must contain at most two items');
  for (const button of cfg.buttons) {
    if (typeof button.label !== 'string' || button.label.length < 1 || button.label.length > 32 || typeof button.url !== 'string' || button.url.length > 512 || !/^https:\/\//.test(button.url)) throw new Error('each button needs a 1-32 character label and an https url');
  }
  return cfg;
}
module.exports = { DEFAULTS, loadConfig };
