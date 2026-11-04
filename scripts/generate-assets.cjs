#!/usr/bin/env node
'use strict';

// Original animation, with unchanged brand silhouettes from pinned Simple Icons.
// Development only: npm install --save-dev @resvg/resvg-js gifenc
const fs = require('node:fs');
const path = require('node:path');
const { Resvg } = require('@resvg/resvg-js');
const { GIFEncoder, quantize, applyPalette } = require('gifenc');

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
const logo = (provider, x = 128, y = 128, size = 108) => `<g transform="translate(${x - size / 2} ${y - size / 2}) scale(${size / 24})"><path d="${paths[provider === 'codex' ? 'chatgpt' : 'claude']}" fill="${provider === 'codex' ? '#f5f6f6' : '#da947b'}"/></g>`;

function draw(provider, state, progress) {
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
  if (state === 'waiting') {
    for (let i = 0; i < 3; i++) {
      const opacity = .22 + .55 * (Math.sin(phase - i * .65) + 1) / 2;
      movement += `<circle cx="${120 + i * 8}" cy="207" r="1.7" fill="${accent}" opacity="${n(opacity)}"/>`;
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 256 256">
    <defs>
      <radialGradient id="ambient"><stop offset="0" stop-color="${accent}" stop-opacity="${n((quiet ? .045 : .065) + pulse * .025)}"/><stop offset="1" stop-color="${accent}" stop-opacity="0"/></radialGradient>
      <radialGradient id="surface"><stop offset="0" stop-color="#1b2023"/><stop offset="1" stop-color="#111416"/></radialGradient>
    </defs>
    <rect width="256" height="256" rx="32" fill="#111416"/>
    <circle cx="128" cy="128" r="126" fill="url(#surface)"/>
    <circle cx="128" cy="128" r="118" fill="url(#ambient)"/>
    ${movement}
    ${logo(provider, 128, 128, isCodex ? 110 : 111)}
  </svg>`;
}

function drawBoth(progress, state) {
  const pulse = (Math.sin(progress * TAU) + 1) / 2;
  const quiet = state === 'idle' || state === 'waiting';
  const angle = quiet ? -90 : progress * 360 - 90;
  const sweep = state === 'working' ? 87 : 42;
  const opacity = quiet ? .12 + pulse * .16 : .8;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 256 256">
    <defs><radialGradient id="warm"><stop stop-color="#dda086" stop-opacity=".10"/><stop offset="1" stop-color="#dda086" stop-opacity="0"/></radialGradient><radialGradient id="cool"><stop stop-color="#a4e7d5" stop-opacity=".10"/><stop offset="1" stop-color="#a4e7d5" stop-opacity="0"/></radialGradient></defs>
    <rect width="256" height="256" rx="32" fill="#111416"/>
    <circle cx="78" cy="128" r="89" fill="url(#cool)"/><circle cx="178" cy="128" r="89" fill="url(#warm)"/>
    <g transform="translate(-50 0)">${circle(48, '#a4e7d5', .15)}${arc(48, angle, sweep, '#a4e7d5', opacity, 1.3)}</g>
    <g transform="translate(50 0)">${circle(48, '#dda086', .15)}${arc(48, -angle, sweep, '#dda086', quiet ? opacity : .5 + pulse * .3, 1.3)}</g>
    ${logo('codex', 78, 128, 62)}${logo('claude', 178, 128, 62)}
    <circle cx="${state === 'waiting' ? 120 : 123}" cy="210" r="1.5" fill="#a4e7d5" opacity="${n(.4 + pulse * .4)}"/><circle cx="${state === 'waiting' ? 136 : 133}" cy="210" r="1.5" fill="#dda086" opacity="${n(.8 - pulse * .4)}"/>${state === 'waiting' ? `<circle cx="128" cy="210" r="1.5" fill="#d8ded8" opacity="${n(.3 + pulse * .3)}"/>` : ''}
  </svg>`;
}

function build(name, drawing) {
  const frames = [];
  for (let index = 0; index < FRAMES; index++) {
    const rendered = new Resvg(drawing(index / FRAMES), { font: { loadSystemFonts: false } }).render();
    if (index === 0) fs.writeFileSync(path.join(target, `${name}.png`), rendered.asPng());
    frames.push(rendered.pixels);
  }
  // One palette per loop keeps gradients and static logo edges from flickering.
  const samples = Buffer.concat([frames[0], frames[20], frames[40], frames[60]]);
  const palette = quantize(samples, 256, { format: 'rgb565' });
  const gif = GIFEncoder();
  frames.forEach((rgba, index) => gif.writeFrame(applyPalette(rgba, palette), WIDTH, WIDTH, {
    ...(index === 0 ? { palette } : {}), delay: DELAY, repeat: 0, dispose: 1,
  }));
  gif.finish();
  const bytes = gif.bytes();
  fs.writeFileSync(path.join(target, `${name}.gif`), bytes);
  console.log(`${name}: ${FRAMES} frames, ${FRAMES * DELAY}ms, ${(bytes.length / 1024).toFixed(0)}kb`);
}

for (const provider of ['codex', 'claude']) {
  for (const state of ['working', 'thinking', 'waiting', 'idle']) build(`${provider}-${state}`, time => draw(provider, state, time));
}
for (const state of ['working', 'thinking', 'waiting', 'idle']) build(`both-${state}`, time => drawBoth(time, state));
fs.writeFileSync(path.join(target, 'manifest.json'), JSON.stringify({
  version: 1, width: WIDTH, height: WIDTH, frames: FRAMES, frameDurationMs: DELAY,
  loopDurationMs: FRAMES * DELAY, animatedFormat: 'gif', staticFormat: 'png',
  providers: ['codex', 'claude'], states: ['working', 'thinking', 'waiting', 'idle'],
  combined: 'both-working', combinedStates: ['working', 'thinking', 'waiting', 'idle'], sourceVersion: 'simple-icons@14.15.0',
}, null, 2) + '\n');
require('./generate-overview.cjs');
