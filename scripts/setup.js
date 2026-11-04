#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline/promises');
const { loadConfig } = require('../lib/config');

function validateClientId(value) {
  const id = String(value ?? '').trim();
  if (!/^[1-9]\d{16,19}$/.test(id) || BigInt(id) > 18446744073709551615n) {
    throw new Error('enter the application id from the discord developer portal (17 to 20 digits)');
  }
  return id;
}

function validateImageBaseUrl(value) {
  const text = String(value ?? '').trim();
  if (!text) return '';
  let url;
  try { url = new URL(text); } catch { throw new Error('enter a public https url, or leave this empty'); }
  const host = url.hostname.toLowerCase();
  const privateHost = !host.includes('.') || host === 'localhost' || host.endsWith('.localhost') ||
    host.endsWith('.local') || /^(127|10|0)\./.test(host) || /^192\.168\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host) || /^169\.254\./.test(host);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || privateHost) {
    throw new Error('use a public https asset-folder url without credentials, query parameters, or a fragment');
  }
  return url.href.replace(/\/+$/, '');
}

function createConfig(answers, existing = {}) {
  if (!existing || typeof existing !== 'object' || Array.isArray(existing)) throw new Error('config must be a json object');
  const privacy = answers.privacy || 'minimal';
  const displayMode = answers.displayMode || 'auto';
  const baseUrl = validateImageBaseUrl(answers.baseUrl);
  if (!['minimal', 'project'].includes(privacy)) throw new Error('privacy must be minimal or project');
  if (!['auto', 'combined', 'rotate'].includes(displayMode)) throw new Error('display mode must be auto, combined, or rotate');
  return {
    showWhenIdle: true, showTokens: true, rotateSeconds: 20, pollIntervalMs: 2000,
    staleMs: 120000, idleRetentionMs: 600000, ...existing,
    clientId: validateClientId(answers.clientId), privacy, displayMode,
    images: { ...(existing.images || {}), baseUrl, animated: true, ...(baseUrl ? { portal: false } : {}) },
  };
}

function effectiveConfig(options = {}) {
  const configPath = options.configPath || path.join(__dirname, '..', 'config.json');
  return loadConfig(path.dirname(configPath), [`--config=${configPath}`], options.env || process.env);
}

function checkConfiguration(options = {}) {
  const config = effectiveConfig(options);
  if (!config.clientId) return false;
  validateClientId(config.clientId);
  return true;
}

async function main(options = {}) {
  const configPath = options.configPath || path.join(__dirname, '..', 'config.json');
  const log = options.log || console.log;
  const existing = effectiveConfig(options);
  const terminal = options.ask ? null : readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = options.ask || (question => terminal.question(question));
  const prompt = async (question, fallback, validate) => {
    for (;;) {
      const input = String(await ask(`${question}${fallback ? ` [${fallback}]` : ''}: `)).trim();
      const value = input || fallback || '';
      try { return validate(value); } catch (error) { log(error.message); }
    }
  };
  try {
    log('press enter to keep the bundled application id and hosted animations.');
    log('optionally use your own application from https://discord.com/developers/applications to change its display name. no bot token is needed.');
    const clientId = await prompt('application id (optional override)', existing.clientId || '', validateClientId);
    log('keep the bundled asset url, use your own public https asset folder, or type none to disable image urls.');
    const baseUrl = await prompt('asset folder url', existing.images?.baseUrl || '', value => validateImageBaseUrl(value === 'none' ? '' : value));
    const privacy = await prompt('privacy: minimal or project', ['minimal', 'project'].includes(existing.privacy) ? existing.privacy : 'minimal', value => {
      if (!['minimal', 'project'].includes(value)) throw new Error('choose minimal or project');
      return value;
    });
    const displayMode = await prompt('display: auto, combined, or rotate', ['auto', 'combined', 'rotate'].includes(existing.displayMode) ? existing.displayMode : 'auto', value => {
      if (!['auto', 'combined', 'rotate'].includes(value)) throw new Error('choose auto, combined, or rotate');
      return value;
    });
    const config = createConfig({ clientId, baseUrl, privacy, displayMode }, existing);
    const temporary = `${configPath}.${process.pid}.tmp`;
    let createdTemporary = false;
    try {
      fs.writeFileSync(temporary, `${JSON.stringify(config, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
      createdTemporary = true;
      fs.renameSync(temporary, configPath);
    } finally {
      if (createdTemporary && fs.existsSync(temporary)) fs.unlinkSync(temporary);
    }
    log('saved config.json. start discord desktop, then run node rpc.js');
    if (!baseUrl) log('logos need an asset url or matching art assets in your discord application.');
    return config;
  } finally { terminal?.close(); }
}

if (require.main === module) {
  if (process.argv.includes('--check')) {
    try { process.exitCode = checkConfiguration() ? 0 : 2; }
    catch (error) { console.error(error.message); process.exitCode = 1; }
  } else main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
module.exports = { validateClientId, validateImageBaseUrl, createConfig, effectiveConfig, checkConfiguration, main };
