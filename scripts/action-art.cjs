'use strict';

// small pixel badges. discord crops these to a circle about 32px wide, so each
// icon lives in the middle 12 x 12 of a 16 x 16 grid and keeps its corners empty.
const { Grid, GLYPHS, PAPER } = require('./pixel-art.cjs');

const ACTIONS = ['working', 'thinking', 'editing', 'reading', 'searching', 'testing', 'terminal', 'browsing', 'reviewing', 'waiting', 'done', 'idle'];
const COLORS = {
  working: '#ffb86b', thinking: '#c8b9f2', editing: '#ffd166', reading: '#a9d6ee',
  searching: '#8fe9ff', testing: '#9be28a', terminal: '#c9ced8', browsing: '#7fb4ff',
  reviewing: '#f2a7c8', waiting: '#efc18c', done: '#8fe6a8', idle: '#b7b3d9',
};
const BADGE_FRAMES = 16;

function mix(a, b, amount) {
  const channel = (hex, index) => parseInt(hex.slice(1 + index * 2, 3 + index * 2), 16);
  return `#${[0, 1, 2].map(index => Math.round(channel(a, index) * (1 - amount) + channel(b, index) * amount).toString(16).padStart(2, '0')).join('')}`;
}

// each icon returns { sprite, x, y } or a list of them for the given frame.
const ICONS = {
  working(frame) {
    const flash = frame % 8 >= 4;
    const bolt = [
      '....#####.',
      '...#####..',
      '..#####...',
      '.########.',
      '....####..',
      '...####...',
      '..####....',
      '.###......',
      '.#........',
    ];
    return [{ sprite: bolt, x: 1, y: flash ? 1 : 2 }, { sprite: ['y'], x: flash ? 0 : 1, y: flash ? 2 : 4 }, { sprite: ['y'], x: flash ? 11 : 10, y: flash ? 9 : 7 }];
  },
  thinking(frame) {
    const dots = Math.min(3, Math.floor(frame / 4) % 4 + 1);
    const cloud = [
      '..########..',
      '.##########.',
      '############',
      '############',
      '############',
      '.##########.',
      '..########..',
      '..##........',
      '.#..........',
    ];
    const row = ['k', 'k', 'k'].map((dot, index) => (index < dots ? dot : '.')).join('..');
    return [{ sprite: cloud, x: 0, y: 1 }, { sprite: [row, row], x: 2, y: 3 }];
  },
  editing(frame) {
    const step = frame % 8 >= 4 ? 1 : 0;
    const pencil = [
      '.......##.',
      '......####',
      '.....####.',
      '....####..',
      '...####...',
      '..####....',
      '.w###.....',
      'www#......',
      'kww.......',
    ];
    const line = ['o'.repeat(3 + (Math.floor(frame / 2) % 8))];
    return [{ sprite: line, x: 1, y: 11 }, { sprite: pencil, x: 1 + step, y: 1 - step }];
  },
  reading(frame) {
    const lines = Math.floor(frame / 4) % 4;
    const text = shown => (shown ? 'kk' : 'ww');
    return [{ x: 1, y: 2, sprite: [
      '.###..###.',
      `#kkw##w${text(lines >= 2)}#`,
      '#www##www#',
      `#${text(lines >= 1)}w##w${text(lines >= 3)}#`,
      '#www##www#',
      `#${text(lines >= 1)}w##w${text(lines >= 3)}#`,
      '#www##www#',
      '.########.',
    ] }];
  },
  searching(frame) {
    const [dx, dy] = [[0, 0], [1, 0], [1, 1], [0, 1]][Math.floor(frame / 4) % 4];
    return [{ x: dx, y: dy, sprite: [
      '...####.....',
      '..#gggg#....',
      '.#gwgggg#...',
      '.#wggggg#...',
      '.#gggggg#...',
      '.#gggggg#...',
      '..#gggg#....',
      '...#####....',
      '.......##...',
      '........##..',
      '.........#..',
    ] }];
  },
  testing(frame) {
    const pop = Math.floor(frame / 4) % 2;
    return [{ x: 1, y: 0, sprite: [
      pop ? '....w.....' : '..........',
      pop ? '..........' : '.....w....',
      '...####...',
      '....##....',
      '....##....',
      '...#..#...',
      '...#..#...',
      pop ? '..#gwgg#..' : '..#gggg#..',
      pop ? '.#gggggg#.' : '.#ggggwg#.',
      pop ? '.#ggggwg#.' : '.#gwgggg#.',
      '.########.',
    ] }];
  },
  terminal(frame) {
    const cursor = frame % 8 < 4 ? 'www' : 'kkk';
    return [{ x: 1, y: 2, sprite: [
      '.########.',
      '#oooooooo#',
      '#kkkkkkkk#',
      '#kwkkkkkk#',
      '#kkwkkkkk#',
      `#kwk${cursor}kk#`,
      '#kkkkkkkk#',
      '.########.',
    ] }];
  },
  browsing(frame) {
    const turn = Math.floor(frame / 4) % 2;
    return [{ x: 1, y: 1, sprite: turn ? [
      '...####...',
      '..#l####..',
      '.#lll###l.',
      '.#ll###ll.',
      '##l####lll',
      '#######ll#',
      '####l###l#',
      '.##lll###.',
      '..#ll###..',
      '...####...',
    ] : [
      '...####...',
      '..###l##..',
      '.###lll##.',
      '.###ll###.',
      'l####l####',
      'll########',
      'l#####l###',
      '.####lll#.',
      '..###ll#..',
      '...####...',
    ] }];
  },
  reviewing(frame) {
    if (frame === 15) return [{ x: 0, y: 5, sprite: ['.##########.', '..########..'] }];
    const look = [0, 0, 1, 1, 0, 0, -1, -1][Math.floor(frame / 2) % 8];
    const eye = [
      '...######...',
      '..#wwwwww#..',
      '.#wwwwwwww#.',
      '#wwwwwwwwww#',
      '.#wwwwwwww#.',
      '..#wwwwww#..',
      '...######...',
    ];
    return [{ sprite: eye, x: 0, y: 2 }, { sprite: ['.kk.', 'kkkk', '.kk.'], x: 4 + look, y: 4 }];
  },
  waiting(frame) {
    const stage = Math.floor(frame / 4) % 4;
    const top = [['ssss', 'ssss', 'ss'], ['....', 'ssss', 'ss'], ['....', '....', 'ss'], ['....', '....', '..']][stage];
    const bottom = [['..', '....', '....'], ['..', '....', 'ssss'], ['..', '.ss.', 'ssss'], ['ss', 'ssss', 'ssss']][stage];
    return [{ x: 2, y: 1, sprite: [
      '########',
      `.#${top[0]}#.`,
      `.#${top[1]}#.`,
      `..#${top[2]}#..`,
      stage < 3 ? '...ss...' : '...##...',
      `..#${bottom[0]}#..`,
      `.#${bottom[1]}#.`,
      `.#${bottom[2]}#.`,
      '########',
    ] }];
  },
  done(frame) {
    const twinkle = Math.floor(frame / 4) % 2;
    const check = [
      '.........#',
      '........##',
      '.......###',
      '#.....###.',
      '##...###..',
      '###.###...',
      '.#####....',
      '..###.....',
      '...#......',
    ];
    return [{ sprite: check, x: 1, y: 2 }, { sprite: twinkle ? ['y'] : ['.y.', 'y.y', '.y.'], x: twinkle ? 3 : 2, y: twinkle ? 2 : 1 }];
  },
  idle(frame) {
    const count = Math.floor(frame / 4) % 4;
    const moon = [
      '...####...',
      '..###.....',
      '.###......',
      '.###......',
      '.###......',
      '.####....#',
      '..########',
      '...######.',
    ];
    const parts = [{ sprite: moon, x: 0, y: 3 }];
    if (count >= 1) parts.push({ sprite: GLYPHS.z.map(row => row.replaceAll('#', 'w')), x: 8, y: count >= 3 ? 0 : 1 });
    return parts;
  },
};

function drawBadge(action, progress) {
  const name = Object.hasOwn(ICONS, action) ? action : 'working';
  const color = COLORS[name];
  const background = mix(color, '#0b0b12', .8);
  const palette = {
    '#': color, o: mix(color, background, .45), g: mix(color, background, .6), k: background,
    w: PAPER, y: '#ffe08a', s: '#ffd98a', l: '#8fe6a8',
  };
  const grid = new Grid(16, 16);
  const frame = Math.floor(progress * BADGE_FRAMES) % BADGE_FRAMES;
  for (const part of ICONS[name](frame)) grid.put(part.sprite, 2 + part.x, 2 + part.y, palette);
  return grid.svg(8, background, '', 128);
}

module.exports = { ACTIONS, COLORS, BADGE_FRAMES, drawBadge };
