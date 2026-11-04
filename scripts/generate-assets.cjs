#!/usr/bin/env node
'use strict';

// Original animation, with unchanged brand silhouettes from pinned Simple Icons.
// Development only: npm install --save-dev @resvg/resvg-js gifenc
const fs = require('node:fs');
const path = require('node:path');
const { Resvg } = require('@resvg/resvg-js');
const { GIFEncoder, quantize, applyPalette } = require('gifenc');
const { ACTIONS, drawBadge } = require('./action-art.cjs');

const target = path.resolve(__dirname, '../assets');
const WIDTH = 256;
const FRAMES = 80;
const DELAY = 50;
const TAU = Math.PI * 2;
const paths = Object.fromEntries(['chatgpt', 'claude'].map(name => {
  const source = fs.readFileSync(path.join(target, 'source', `${name}.svg`), 'utf8');
  return [name, source.match(/<path d="([^"]+)"/)[1]];
}));

const n = value => Number(value.toFixed(3));
const circle = (radius, color, opacity, width = 1) => `<circle cx="128" cy="128" r="${radius}" fill="none" stroke="${color}" stroke-opacity="${n(opacity)}" stroke-width="${width}"/>`;
const arc = (radius, start, length, color, opacity = 1, width = 1.7) => {
  const radians = start * Math.PI / 180;
  const end = (start + length) * Math.PI / 180;
  return `<path d="M${n(128 + radius * Math.cos(radians))} ${n(128 + radius * Math.sin(radians))} A${radius} ${radius} 0 ${length > 180 ? 1 : 0} 1 ${n(128 + radius * Math.cos(end))} ${n(128 + radius * Math.sin(end))}" fill="none" stroke="${color}" stroke-opacity="${n(opacity)}" stroke-width="${width}" stroke-linecap="round"/>`;
};
const logoGlow = '<defs><filter id="logo-glow" filterUnits="userSpaceOnUse" x="0" y="0" width="256" height="256" color-interpolation-filters="sRGB"><feGaussianBlur stdDeviation="1.2"/></filter></defs>';
const logo = (provider, x = 128, y = 128, size = 108) => {
  const mark = `<g transform="translate(${x - size / 2} ${y - size / 2}) scale(${size / 24})"><path d="${paths[provider === 'codex' ? 'chatgpt' : 'claude']}" fill="${provider === 'codex' ? '#f5f6f6' : '#da947b'}"/></g>`;
  // Blur the outer, untransformed group so the glow stays 1.2 output pixels.
  return `<g filter="url(#logo-glow)" opacity=".25">${mark}</g>${mark}`;
};

function draw(provider, state, progress, options = {}) {
  const phase = TAU * progress;
  const pulse = (Math.sin(phase - Math.PI / 2) + 1) / 2;
  const isCodex = provider === 'codex';
  const accent = isCodex ? '#a4e7d5' : '#dda086';
  const angle = progress * 360 - 90;
  const quiet = state === 'idle' || state === 'waiting';
  let movement = circle(94, accent, quiet ? .1 : .18, .75);
  if (isCodex) {
    if (state === 'working' || state === 'thinking') {
      const sweep = state === 'working' ? 118 : 58;
      movement += arc(94, angle, sweep, accent, .87);
      movement += arc(94, angle + 180, sweep * .48, '#d1ece7', .3, .8);
      movement += arc(102, -angle + 120, 35, accent, .16, .7);
      const tip = (angle + sweep) * Math.PI / 180;
      movement += `<circle cx="${n(128 + 94 * Math.cos(tip))}" cy="${n(128 + 94 * Math.sin(tip))}" r="2.2" fill="#e0fff8"/>`;
    } else {
      movement += arc(94, -115, 50, accent, .22 + pulse * .24, 1.2);
    }
  } else {
    const count = 36;
    for (let i = 0; i < count; i++) {
      const a = TAU * i / count;
      const wave = (Math.cos(a - phase) + 1) / 2;
      const opacity = quiet ? .04 + pulse * .09 : .045 + Math.pow(wave, 5) * .58;
      const r = 91;
      const outer = r + (state === 'working' ? 7 : 4.5);
      movement += `<path d="M${n(128 + r * Math.cos(a))} ${n(128 + r * Math.sin(a))} L${n(128 + outer * Math.cos(a))} ${n(128 + outer * Math.sin(a))}" stroke="${accent}" stroke-opacity="${n(opacity)}" stroke-width="1.5" stroke-linecap="round"/>`;
    }
    movement += circle(101 + pulse * 2, accent, (quiet ? .025 : .07) + pulse * .06, .6);
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 256 256">
    ${logoGlow}
    <rect width="256" height="256" fill="#000000"/>
    ${movement}
    ${logo(provider, 128, 128, options.logoSize ?? (isCodex ? 110 : 111))}
  </svg>`;
}

function drawBoth(progress, state) {
  const pulse = (Math.sin(progress * TAU) + 1) / 2;
  const quiet = state === 'idle' || state === 'waiting';
  const angle = quiet ? -90 : progress * 360 - 90;
  const sweep = state === 'working' ? 87 : 42;
  const opacity = quiet ? .12 + pulse * .16 : .8;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 256 256">
    ${logoGlow}
    <rect width="256" height="256" fill="#000000"/>
    <g transform="translate(-50 0)">${circle(48, '#a4e7d5', .15)}${arc(48, angle, sweep, '#a4e7d5', opacity, 1.3)}</g>
    <g transform="translate(50 0)">${circle(48, '#dda086', .15)}${arc(48, -angle, sweep, '#dda086', quiet ? opacity : .5 + pulse * .3, 1.3)}</g>
    ${logo('codex', 78, 128, 62)}${logo('claude', 178, 128, 62)}
  </svg>`;
}

function drawSplit(codexState, claudeState, progress) {
  // Both marks share one center and size. Clipping happens after each mark's
  // tight edge glow, so neither half nor its light spills across the seam.
  const left = draw('codex', codexState, progress, { logoSize: 136 })
    .replaceAll('logo-glow', 'codex-split-glow');
  const right = draw('claude', claudeState, (1.25 - progress) % 1, { logoSize: 136 })
    .replaceAll('logo-glow', 'claude-split-glow');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 256 256">
    <defs>
      <clipPath id="split-left"><rect x="0" y="0" width="127" height="256"/></clipPath>
      <clipPath id="split-right"><rect x="129" y="0" width="127" height="256"/></clipPath>
    </defs>
    <rect width="256" height="256" fill="#000000"/>
    <g clip-path="url(#split-left)">${left}</g>
    <g clip-path="url(#split-right)">${right}</g>
  </svg>`;
}

function build(name, drawing, { width = WIDTH, count = FRAMES, delay = DELAY } = {}) {
  const frames = [];
  for (let index = 0; index < count; index++) {
    const rendered = new Resvg(drawing(index / count), { font: { loadSystemFonts: false } }).render();
    if (index === 0) fs.writeFileSync(path.join(target, `${name}.png`), rendered.asPng());
    frames.push(rendered.pixels);
  }
  // One palette per loop keeps static edges from flickering. Reserve exact black
  // so quantization cannot turn untouched background into a near-black tint.
  const samples = Buffer.concat([0, 1, 2, 3].map(quarter => frames[Math.floor(count * quarter / 4)]));
  const palette = [[0, 0, 0], ...quantize(samples, 255, { format: 'rgb565' }).filter(color => color.some(channel => channel !== 0))];
  const gif = GIFEncoder();
  frames.forEach((rgba, index) => {
    const indexed = applyPalette(rgba, palette);
    for (let pixel = 0; pixel < indexed.length; pixel++) {
      const offset = pixel * 4;
      if (rgba[offset] === 0 && rgba[offset + 1] === 0 && rgba[offset + 2] === 0) indexed[pixel] = 0;
    }
    gif.writeFrame(indexed, width, width, {
      ...(index === 0 ? { palette } : {}), delay, repeat: 0, dispose: 1,
    });
  });
  gif.finish();
  const bytes = gif.bytes();
  fs.writeFileSync(path.join(target, `${name}.gif`), bytes);
  console.log(`${name}: ${count} frames, ${count * delay}ms, ${(bytes.length / 1024).toFixed(0)}kb`);
}

const splitOnly = process.argv.includes('--split-only');
const splitStates = ['working', 'thinking', 'waiting'];
if (!splitOnly) {
  for (const provider of ['codex', 'claude']) {
    for (const state of ['working', 'thinking', 'waiting', 'idle']) build(`${provider}-${state}`, time => draw(provider, state, time));
  }
  for (const state of ['working', 'thinking', 'waiting', 'idle']) build(`both-${state}`, time => drawBoth(time, state));
  for (const action of ACTIONS) build(`action-${action}`, time => drawBadge(action, time), { width: 128, count: 48 });
}
for (const codexState of splitStates) {
  for (const claudeState of splitStates) build(`split-${codexState}-${claudeState}`, time => drawSplit(codexState, claudeState, time));
}
fs.writeFileSync(path.join(target, 'manifest.json'), JSON.stringify({
  version: 2, width: WIDTH, height: WIDTH, frames: FRAMES, frameDurationMs: DELAY,
  loopDurationMs: FRAMES * DELAY, animatedFormat: 'gif', staticFormat: 'png',
  background: '#000000', opaque: true,
  providers: ['codex', 'claude'], states: ['working', 'thinking', 'waiting', 'idle'],
  combined: 'both-working', combinedStates: ['working', 'thinking', 'waiting', 'idle'], sourceVersion: 'simple-icons@14.15.0',
  actionBadges: { width: 128, height: 128, frames: 48, frameDurationMs: DELAY, loopDurationMs: 2400, actions: ACTIONS },
  split: { pattern: 'split-{codexState}-{claudeState}', axis: 'vertical', left: 'codex', right: 'claude', states: splitStates, width: WIDTH, height: WIDTH, frames: FRAMES, frameDurationMs: DELAY, loopDurationMs: FRAMES * DELAY },
}, null, 2) + '\n');
if (!splitOnly && !process.argv.includes('--assets-only')) require('./generate-overview.cjs');
