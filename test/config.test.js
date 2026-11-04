'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadConfig } = require('../lib/config');
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dual-config-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
test('config layers preserve nested defaults and command line overrides environment', (t) => {
  const root = fixture(t);
  fs.writeFileSync(path.join(root, 'config.example.json'), JSON.stringify({ clientId: '123456789012345678', images: { baseUrl: 'https://example.com/assets' } }));
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({ images: { animated: false }, providers: { claude: false } }));
  const cfg = loadConfig(root, ['--client-id=333456789012345678'], { DUAL_RPC_CLIENT_ID: '223456789012345678' });
  assert.equal(cfg.clientId, '333456789012345678');
  assert.equal(cfg.images.baseUrl, 'https://example.com/assets');
  assert.equal(cfg.images.animated, false);
  assert.equal(cfg.providers.codex, true);
  assert.equal(cfg.providers.claude, false);
});
test('malformed config fails visibly without silently switching privacy', (t) => {
  const root = fixture(t), file = path.join(root, 'config.json');
  for (const value of [null, [], { images: [] }, { providers: null }, { showTokens: 'false' }, { showConversationTitle: 'false' }, { privacy: 'full' }, { pollIntervalMs: 0 }]) {
    fs.writeFileSync(file, JSON.stringify(value));
    assert.throws(() => loadConfig(root, [], {}));
  }
});
test('image credentials and query strings cannot leak through the asset url', (t) => {
  const root = fixture(t);
  for (const url of ['file:///secret.png', 'https://user:password@example.com', 'https://example.com?token=secret']) {
    fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({ images: { baseUrl: url } }));
    assert.throws(() => loadConfig(root, [], {}));
  }
});
