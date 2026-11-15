'use strict';

// chunky pixel scenes for the discord card. every scene is painted onto a small
// grid of art pixels and then blown up, so edges stay hard at any size.
const FRAMES = 16;      // every motion repeats within 16 frames
const SIZE = 256;

class Grid {
  constructor(width, height, fill = null) {
    this.width = width; this.height = height;
    this.rows = Array.from({ length: height }, () => new Array(width).fill(fill));
  }
  set(x, y, color) {
    if (color && x >= 0 && y >= 0 && x < this.width && y < this.height) this.rows[y][x] = color;
  }
  rect(x, y, width, height, color) {
    for (let row = y; row < y + height; row++) for (let column = x; column < x + width; column++) this.set(column, row, color);
  }
  // sprite: array of strings, palette: { char: color }. chars missing from the palette are see-through.
  put(sprite, x, y, palette) {
    sprite.forEach((line, row) => {
      for (let column = 0; column < line.length; column++) this.set(x + column, y + row, palette[line[column]]);
    });
  }
  origin(unit, size = SIZE) {
    return { left: Math.floor((size - this.width * unit) / 2), top: Math.floor((size - this.height * unit) / 2) };
  }
  svg(unit, background, backdrop = '', size = SIZE) {
    const { left, top } = this.origin(unit, size);
    let out = '';
    for (let y = 0; y < this.height; y++) {
      for (let x = 0; x < this.width;) {
        const color = this.rows[y][x];
        let end = x + 1;
        while (end < this.width && this.rows[y][end] === color) end++;
        if (color) out += `<rect x="${left + x * unit}" y="${top + y * unit}" width="${(end - x) * unit}" height="${unit}" fill="${color}"/>`;
        x = end;
      }
    }
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges"><rect width="${size}" height="${size}" fill="${background}"/>${backdrop}${out}</svg>`;
  }
}

const GLYPHS = {
  z: ['###', '..#', '.#.', '#..', '###'],
  '?': ['##.', '..#', '.#.', '...', '.#.'],
};

// a speech or thought bubble whose tail points down at the speaker.
function bubble(grid, x, y, width, height, fill, thought = false, shortTail = false) {
  grid.rect(x + 1, y, width - 2, height, fill);
  grid.rect(x, y + 1, width, height - 2, fill);
  if (thought) {
    grid.rect(x + 1, y + height + 1, 2, 2, fill);
  } else {
    grid.rect(x + 1, y + height, 2, 1, fill);
    if (!shortTail) grid.set(x + 1, y + height + 1, fill);
  }
}

// little four point sparkle that grows and pops.
function spark(grid, x, y, step, color) {
  if (step === 0) grid.set(x, y, color);
  else if (step === 1) { grid.set(x, y, color); grid.set(x - 1, y, color); grid.set(x + 1, y, color); grid.set(x, y - 1, color); grid.set(x, y + 1, color); }
  else if (step === 2) { grid.set(x - 1, y, color); grid.set(x + 1, y, color); grid.set(x, y - 1, color); grid.set(x, y + 1, color); }
}

// ---- the cast ----------------------------------------------------------
// each one paints itself with its feet on the bottom row of its box and
// returns how far it is off the ground, so the shadow can react.
const step2 = frame => Math.floor(frame / 2) % 2;
const HOP = [0, 1, 2, 3, 3, 2, 1, 0];

// clawd, the claude code mascot, redrawn from the terminal welcome art.
function clawd(grid, x, y, state, frame) {
  const body = '#d77757', eye = '#24120c';
  const asleep = state === 'idle';
  const squat = state === 'thinking' && frame % 16 >= 8 ? 1 : 0;
  const top = y + (asleep ? 2 : squat);
  const breath = asleep && frame % 16 >= 8 ? 1 : 0;
  grid.rect(x + 2, top + breath, 12, 8 - breath, body);
  const step = step2(frame);
  let leftArm = top + 4, rightArm = top + 4;
  if (state === 'working') { if (step) leftArm--; else rightArm--; }
  if (state === 'waiting') rightArm = top + (step ? 1 : 2);
  grid.rect(x, leftArm, 2, 2, body);
  grid.rect(x + 14, rightArm, 2, 2, body);
  if (!asleep) [3, 5, 10, 12].forEach((column, index) => {
    const lifted = state === 'working' && index % 2 === step;
    grid.rect(x + column, top + 8, 1, 2 - squat - (lifted ? 1 : 0), body);
  });
  if (asleep) { grid.rect(x + 4, top + 3, 2, 1, eye); grid.rect(x + 10, top + 3, 2, 1, eye); }
  else if (state !== 'thinking' && frame % 16 === 15) { grid.set(x + 4, top + 3, eye); grid.set(x + 11, top + 3, eye); }
  else {
    const row = top + (state === 'thinking' ? 1 : 2);
    grid.rect(x + 4, row, 1, 2, eye); grid.rect(x + 11, row, 1, 2, eye);
  }
  return 0;
}

// the codex pet from the codex app: a cloud head with a terminal for a face.
const CODEX_HEAD = [
  '.....####......',
  '..########.##..',
  '.#############.',
  '.##ddddddddd##.',
  '###ddddddddd###',
  '###ddddddddd###',
  '###ddddddddd###',
  '.##ddddddddd##.',
  '.#############.',
  '..###########..',
];
const CODEX_FACES = {
  prompt: ['.........', '.c.......', '..c......', '.c..ccc..', '.........'],
  cursorOff: ['.........', '.c.......', '..c......', '.c.......', '.........'],
  up: ['..c...c..', '..c...c..', '.........', '.........', '.........'],
  asleep: ['.........', '.........', '.c.c.c.c.', '..c...c..', '.........'],
  blink: ['.........', '.........', '.cc...cc.', '.........', '.........'],
};
function codexPet(grid, x, y, state, frame) {
  const blue = '#5f83f7', limb = '#4466dc', screen = '#141b45', glow = '#8fe9ff', lid = '#2b3a82';
  const palette = { '#': blue, d: screen, c: glow };
  const slow = frame % 16 >= 8 ? 1 : 0;
  const nod = state === 'idle' || state === 'thinking' ? slow : state === 'working' ? (frame % 8 >= 4 ? 1 : 0) : 0;
  const torso = y + 10;
  grid.rect(x + 5, torso, 5, 3, blue);
  grid.set(x + 6, torso + 1, glow); grid.set(x + 8, torso + 1, glow);
  grid.rect(x + 5, torso + 3, 2, 1, limb); grid.rect(x + 8, torso + 3, 2, 1, limb);
  grid.rect(x + 3, torso, 2, 1, limb);
  if (state === 'waiting') {
    const up = step2(frame);
    grid.rect(x + 10, torso, 2, 1, limb);
    grid.rect(x + 12, torso - 1 - up, 1, 2, limb);
  } else grid.rect(x + 10, torso, 2, 1, limb);
  grid.put(CODEX_HEAD, x, y + nod, palette);
  const face = state === 'idle' ? 'asleep' : state === 'thinking' ? 'up'
    : state === 'waiting' && frame % 16 === 15 ? 'blink' : frame % 8 < 4 ? 'prompt' : 'cursorOff';
  grid.put(CODEX_FACES[face], x + 3, y + nod + 3, palette);
  if (state === 'working') {
    grid.rect(x + 8, torso, 7, 4, lid);
    grid.rect(x + 8, torso, 7, 1, '#4458b8');
    const tap = step2(frame);
    grid.set(x + 10, torso + 1, glow); grid.set(x + 11, torso + 2, glow); grid.set(x + 10, torso + 3, glow);
    if (tap) grid.set(x + 13, torso + 3, glow);
  }
  return 0;
}

// deepseek's whale. the logo is already a creature, so it gets to swim.
const WHALE = [
  '..########.......',
  '.###########..##.',
  '##############...',
  '##############...',
  '##############...',
  '.############....',
  '..##########.....',
];
function whale(grid, x, y, state, frame) {
  const blue = '#4d6bfe', eye = '#071433', spray = '#bcd0ff';
  const asleep = state === 'idle';
  const lift = asleep ? (frame % 16 >= 8 ? 1 : 0) : state === 'working' ? step2(frame) + 1 : (frame % 8 >= 4 ? 2 : 1);
  const top = y + 2 - lift;
  grid.put(WHALE, x, top, { '#': blue });
  const flap = state === 'working' ? step2(frame) : frame % 16 >= 8 ? 1 : 0;
  grid.put(flap ? ['#..#', '####', '.##.'] : ['....', '#..#', '####'], x + 13, top - 2, { '#': blue });
  if (asleep || (state === 'waiting' && frame % 16 === 15)) grid.rect(x + 2, top + 3, 2, 1, eye);
  else grid.rect(x + 2, top + 2, 1, 2, eye);
  grid.rect(x, top + 5, 1, 1, '#08263f');
  if (state === 'working') {
    const puff = Math.floor(frame / 2) % 4;
    if (puff === 0) grid.set(x + 6, top - 1, spray);
    if (puff === 1) grid.rect(x + 6, top - 2, 1, 2, spray);
    if (puff === 2) { grid.set(x + 6, top - 2, spray); grid.set(x + 5, top - 3, spray); grid.set(x + 7, top - 3, spray); }
    if (puff === 3) { grid.set(x + 4, top - 3, spray); grid.set(x + 8, top - 3, spray); grid.set(x + 4, top - 2, spray); grid.set(x + 8, top - 2, spray); }
  }
  return lift;
}

// opencode and glm have no mascot, so their own blocky marks do the hopping.
function mark(sprite, palette, sleepy) {
  return (grid, x, y, state, frame) => {
    const lift = state === 'working' ? HOP[frame % 8]
      : state === 'waiting' ? (frame % 16 < 8 && HOP[frame % 8] > 1 ? 1 : 0)
        : state === 'thinking' ? (frame % 16 >= 8 ? 1 : 0) : 0;
    grid.put(sprite, x, y - lift, state === 'idle' ? { ...palette, ...sleepy } : palette);
    return lift;
  };
}
const OPENCODE_MARK = [
  '##########', '##########',
  '##......##', '##......##', '##......##',
  '##ssssss##', '##ssssss##', '##ssssss##', '##ssssss##', '##ssssss##', '##ssssss##',
  '##########', '##########',
];
const GLM_MARK = [
  '.###########.',
  '#############',
  '#############',
  '###wwwwwww###',
  '########ww###',
  '#######ww####',
  '######ww#####',
  '#####ww######',
  '####ww#######',
  '###wwwwwww###',
  '#############',
  '#############',
  '.###########.',
];

const CAST = {
  claude: { width: 16, height: 10, paint: clawd, bubble: 11,
    theme: { background: '#3a1d14', glow: '#4b2619', floor: '#2a140d', shadow: '#1d0d08', accent: '#ffc9a8' } },
  codex: { width: 15, height: 14, paint: codexPet, bubble: 10,
    theme: { background: '#1a1b3d', glow: '#242654', floor: '#12132c', shadow: '#0b0c1f', accent: '#8fe9ff' } },
  deepseek: { width: 17, height: 9, paint: whale, bubble: 2, floats: true,
    theme: { background: '#08263f', glow: '#0c3252', floor: '#061b2e', shadow: '#03111e', accent: '#bcd0ff' } },
  opencode: { width: 10, height: 13, paint: mark(OPENCODE_MARK, { '#': '#eeeeee', s: '#4b4b4b' }, { '#': '#aeaeae' }), bubble: 7,
    theme: { background: '#25252b', glow: '#313139', floor: '#1a1a1f', shadow: '#101013', accent: '#ffd98a' } },
  glm: { width: 13, height: 13, paint: mark(GLM_MARK, { '#': '#0f0f14', w: '#ffffff' }, { w: '#b9b3d6' }), bubble: 10,
    theme: { background: '#3b2a8c', glow: '#4937a6', floor: '#2a1d68', shadow: '#1b1247', accent: '#d7cfff' } },
};

const PAPER = '#fff7ec';
// what floats over a character's head for each state.
function mood(grid, state, frame, x, top, min, max, theme) {
  const clamp = (value, width) => Math.max(min, Math.min(max - width, value));
  if (state === 'thinking') {
    const left = clamp(x, 7), y = Math.max(1, top - 8);
    bubble(grid, left, y, 7, 5, PAPER, true);
    const dots = Math.floor(frame / 4) % 4;
    for (let dot = 0; dot < Math.min(3, dots + 1); dot++) grid.set(left + 1 + dot * 2, y + 2, theme.background);
  } else if (state === 'waiting') {
    const hop = frame % 16 < 2 ? 1 : 0;
    const wanted = top - 9 - hop, left = clamp(x, 5), y = Math.max(1, wanted);
    bubble(grid, left, y, 5, 7, PAPER, false, wanted < 1);
    if (frame % 16 < 12) grid.put(GLYPHS['?'], left + 1, y + 1, { '#': theme.background });
  } else if (state === 'idle') {
    const count = Math.floor(frame / 4) % 4;
    // two of the same z, the second one higher and further along. a smaller z stops reading as a z.
    const left = clamp(x, 7);
    if (count >= 1) grid.put(GLYPHS.z, left, top - 6, { '#': theme.accent });
    if (count >= 2) grid.put(GLYPHS.z, left + 4, Math.max(1, top - 11), { '#': theme.accent });
  }
}

function sparks(grid, frame, left, right, top, bottom, color, min, max) {
  const keep = value => Math.max(min + 1, Math.min(max - 2, value));
  const spots = [[keep(left - 2), top + 1], [keep(right + 2), top + 3], [keep(left - 1), bottom - 4], [keep(right + 1), top - 2]];
  spots.forEach(([x, y], index) => spark(grid, x, y, (Math.floor(frame / 2) + index * 2) % 8, color));
}

// one character on its own strip of floor, between columns min and max.
function stage(grid, kind, state, frame, min, max, floorRow) {
  const actor = CAST[kind], theme = actor.theme;
  grid.rect(min, 0, max - min, floorRow, theme.background);
  grid.rect(min, floorRow, max - min, grid.height - floorRow, theme.floor);
  const x = min + Math.floor((max - min - actor.width) / 2);
  const y = floorRow - actor.height;
  // a few fixed specks so the wall is not one flat color.
  for (let speck = 0, seed = kind.length * 7 + 3; speck < 9; speck++) {
    seed = (seed * 73 + 41) % 997;
    grid.set(min + 1 + seed % (max - min - 2), 1 + (seed * 7) % (floorRow - 3), theme.glow);
  }
  const lift = actor.paint(new Grid(grid.width, grid.height), x, y, state, frame);
  const inset = Math.min(4, 1 + lift);
  grid.rect(x + inset, floorRow, actor.width - inset * 2, 1, theme.shadow);
  actor.paint(grid, x, y, state, frame);
  const top = y - lift - (actor.floats ? 2 : 0) + (kind === 'claude' && state === 'idle' ? 2 : 0);
  if (state === 'working') sparks(grid, frame, x, x + actor.width - 1, y - 2, floorRow, theme.accent, min, max);
  else mood(grid, state, frame, x + actor.bubble, top, min + 1, max - 1, theme);
}

function solo(kind, state, frame) {
  const theme = CAST[kind].theme, floorRow = 23;
  const grid = new Grid(CAST[kind].width % 2 ? 25 : 26, 25);
  stage(grid, kind, state, frame, 0, grid.width, floorRow);
  const y = grid.origin(10).top + floorRow * 10;
  return grid.svg(10, theme.background, `<rect y="${y}" width="${SIZE}" height="${SIZE - y}" fill="${theme.floor}"/>`);
}

// codex on the left, claude on the right, each on its own color and in its own state.
function pair(codexState, claudeState, frame) {
  const grid = new Grid(36, 36), floorRow = 30;
  stage(grid, 'codex', codexState, frame, 0, 18, floorRow);
  stage(grid, 'claude', claudeState, (frame + 3) % FRAMES, 18, 36, floorRow);
  const y = grid.origin(7).top + floorRow * 7;
  const half = (x, theme) => `<rect x="${x}" width="128" height="${SIZE}" fill="${theme.background}"/><rect x="${x}" y="${y}" width="128" height="${SIZE - y}" fill="${theme.floor}"/>`;
  return grid.svg(7, '#000000', half(0, CAST.codex.theme) + half(128, CAST.claude.theme));
}

module.exports = { FRAMES, SIZE, PAPER, Grid, GLYPHS, CAST, solo, pair };
