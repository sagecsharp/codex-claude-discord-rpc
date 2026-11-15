#!/usr/bin/env node
'use strict';

// pixel art for the discord card. development only: npm ci, then npm run assets.
const fs = require('node:fs');
const path = require('node:path');
const { Resvg } = require('@resvg/resvg-js');
const { GIFEncoder, quantize, applyPalette } = require('gifenc');
const { FRAMES, SIZE, solo, pair } = require('./pixel-art.cjs');
const { ACTIONS, BADGE_FRAMES, drawBadge } = require('./action-art.cjs');

const target = path.resolve(__dirname, '../assets');
const DELAY = 120;         // gif stores hundredths of a second, so keep this a multiple of 10
const STILL = 10;          // the frame the png shows: every bubble and z is on screen in it
const BADGE_STILL = 9;
const STATES = ['working', 'thinking', 'waiting', 'idle'];
const SPLIT_STATES = ['working', 'thinking', 'waiting'];

function build(name, drawing, { width = SIZE, count = FRAMES, still = STILL } = {}) {
  const frames = [];
  for (let index = 0; index < count; index++) {
    const rendered = new Resvg(drawing(index), { font: { loadSystemFonts: false } }).render();
    if (index === still) fs.writeFileSync(path.join(target, `${name}.png`), rendered.asPng());
    frames.push(rendered.pixels);
  }
  // the art is flat color, so the palette is simply every color that appears.
  const seen = new Map();
  for (const rgba of frames) {
    for (let offset = 0; offset < rgba.length; offset += 4) {
      const key = rgba[offset] << 16 | rgba[offset + 1] << 8 | rgba[offset + 2];
      if (!seen.has(key)) seen.set(key, seen.size);
    }
  }
  const exact = seen.size <= 256;
  const palette = exact ? [...seen.keys()].map(key => [key >> 16, key >> 8 & 255, key & 255])
    : quantize(Buffer.concat(frames), 256, { format: 'rgb565' });
  const gif = GIFEncoder();
  frames.forEach((rgba, index) => {
    let indexed;
    if (exact) {
      indexed = new Uint8Array(rgba.length / 4);
      for (let pixel = 0; pixel < indexed.length; pixel++) {
        const offset = pixel * 4;
        indexed[pixel] = seen.get(rgba[offset] << 16 | rgba[offset + 1] << 8 | rgba[offset + 2]);
      }
    } else indexed = applyPalette(rgba, palette);
    gif.writeFrame(indexed, width, width, { ...(index === 0 ? { palette } : {}), delay: DELAY, repeat: 0, dispose: 1 });
  });
  gif.finish();
  const bytes = gif.bytes();
  fs.writeFileSync(path.join(target, `${name}.gif`), bytes);
  console.log(`${name}: ${count} frames, ${count * DELAY}ms, ${seen.size} colors, ${(bytes.length / 1024).toFixed(0)}kb`);
}

for (const kind of ['codex', 'claude', 'opencode', 'glm', 'deepseek']) {
  for (const state of STATES) build(`${kind}-${state}`, frame => solo(kind, state, frame));
}
for (const state of STATES) build(`both-${state}`, frame => pair(state, state, frame));
for (const codexState of SPLIT_STATES) {
  for (const claudeState of SPLIT_STATES) build(`split-${codexState}-${claudeState}`, frame => pair(codexState, claudeState, frame));
}
for (const action of ACTIONS) {
  build(`action-${action}`, frame => drawBadge(action, frame / BADGE_FRAMES), { width: 128, count: BADGE_FRAMES, still: BADGE_STILL });
}
fs.writeFileSync(path.join(target, 'manifest.json'), JSON.stringify({
  version: 3, style: 'pixel art', width: SIZE, height: SIZE, frames: FRAMES, frameDurationMs: DELAY,
  loopDurationMs: FRAMES * DELAY, animatedFormat: 'gif', staticFormat: 'png', opaque: true,
  providers: ['codex', 'claude', 'opencode'], states: STATES,
  characters: { claude: 'clawd', codex: 'codex pet', deepseek: 'whale', opencode: 'opencode mark', glm: 'z.ai mark' },
  combined: 'both-working', combinedStates: STATES,
  modelArt: { provider: 'opencode', models: ['glm', 'deepseek'], pattern: '{model}-{state}', defaultPattern: 'opencode-{state}' },
  actionBadges: { width: 128, height: 128, frames: BADGE_FRAMES, frameDurationMs: DELAY, loopDurationMs: BADGE_FRAMES * DELAY, actions: ACTIONS },
  split: { pattern: 'split-{codexState}-{claudeState}', left: 'codex', right: 'claude', states: SPLIT_STATES, width: SIZE, height: SIZE, frames: FRAMES, frameDurationMs: DELAY, loopDurationMs: FRAMES * DELAY },
}, null, 2) + '\n');
if (!process.argv.includes('--assets-only')) require('./generate-overview.cjs');
