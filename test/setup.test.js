'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { validateClientId, validateImageBaseUrl, createConfig, checkConfiguration, main } = require('../scripts/setup');

test('application id validation accepts snowflakes and rejects tokens or invalid ids', () => {
  assert.equal(validateClientId(' 123456789012345678 '), '123456789012345678');
  for (const invalid of ['', '123', '012345678901234567', '99999999999999999999', 'bot-token']) assert.throws(() => validateClientId(invalid));
});

test('animated images require public https urls and tolerate a missing host', () => {
  assert.equal(validateImageBaseUrl(''), '');
  assert.equal(validateImageBaseUrl('https://example.com/assets/'), 'https://example.com/assets');
  for (const invalid of ['http://example.com/assets', 'https://localhost/assets', 'https://127.0.0.1/assets',
    'https://192.168.0.2/assets', 'https://user:password@example.com', 'https://example.com?token=secret', 'file:///c:/assets']) {
    assert.throws(() => validateImageBaseUrl(invalid));
  }
});

test('configuration defaults to minimal privacy and preserves unrelated settings', () => {
  const result = createConfig({ clientId: '123456789012345678', baseUrl: '' }, {
    customSetting: 42, images: { version: '3' }, showTokens: false,
  });
  assert.equal(result.privacy, 'minimal');
  assert.equal(result.displayMode, 'auto');
  assert.equal(result.showWhenIdle, false);
  assert.equal(result.showTokens, false);
  assert.equal(result.images.animated, true);
  assert.equal(result.images.version, '3');
  assert.equal(result.customSetting, 42);
  const hosted = createConfig({ clientId: '123456789012345678', baseUrl: 'https://example.com/assets' }, { images: { portal: true } });
  assert.equal(hosted.images.portal, false);
});

test('wizard writes config atomically and preserves existing valid choices', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dual-presence-setup-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const configPath = path.join(directory, 'config.json');
  const answers = ['123456789012345678', 'https://example.com/assets', 'project', 'rotate'];
  await main({ configPath, ask: async () => answers.shift(), log() {} });
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  assert.equal(config.privacy, 'project');
  assert.equal(config.displayMode, 'rotate');
  assert.equal(config.images.baseUrl, 'https://example.com/assets');
  await main({ configPath, ask: async () => '', log() {} });
  assert.deepEqual(JSON.parse(fs.readFileSync(configPath, 'utf8')), config);
  assert.deepEqual(fs.readdirSync(directory), ['config.json']);
});

test('wizard does not replace malformed existing configuration', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dual-presence-setup-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const configPath = path.join(directory, 'config.json');
  fs.writeFileSync(configPath, 'keep this invalid data');
  await assert.rejects(main({ configPath, ask: async () => '', log() {} }), /invalid configuration/);
  assert.equal(fs.readFileSync(configPath, 'utf8'), 'keep this invalid data');
});

test('bundled defaults run without config.json and become wizard defaults', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dual-presence-defaults-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const configPath = path.join(directory, 'config.json');
  fs.writeFileSync(path.join(directory, 'config.example.json'), JSON.stringify({
    clientId: '1538695178880159908', privacy: 'minimal',
    images: { baseUrl: 'https://example.com/assets', animated: true, version: '4' },
  }));
  assert.equal(checkConfiguration({ configPath, env: {} }), true);
  assert.equal(fs.existsSync(configPath), false);
  await main({ configPath, env: {}, ask: async () => '', log() {} });
  const saved = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  assert.equal(saved.clientId, '1538695178880159908');
  assert.equal(saved.images.baseUrl, 'https://example.com/assets');
  assert.equal(saved.images.version, '4');
});

test('effective checks honor local overrides and distinguish missing from invalid ids', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dual-presence-config-check-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const configPath = path.join(directory, 'config.json');
  assert.equal(checkConfiguration({ configPath, env: {} }), false);
  fs.writeFileSync(path.join(directory, 'config.example.json'), '{"clientId":"1538695178880159908"}');
  fs.writeFileSync(configPath, '{"clientId":""}');
  assert.equal(checkConfiguration({ configPath, env: {} }), false);
  fs.writeFileSync(configPath, '{"clientId":"invalid"}');
  assert.throws(() => checkConfiguration({ configPath, env: {} }), /application id/);
  fs.writeFileSync(configPath, '{"clientId":"123456789012345678"}');
  assert.equal(checkConfiguration({ configPath, env: {} }), true);
});
