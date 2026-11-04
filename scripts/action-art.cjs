'use strict';

// Original, deliberately bold symbols. These are read at 24–32px in Discord.
const ACTIONS = ['working', 'thinking', 'editing', 'reading', 'searching', 'testing', 'terminal', 'browsing', 'reviewing', 'waiting', 'done', 'idle'];
const COLORS = {
  working: '#a4e7d5', thinking: '#c8b9f2', editing: '#9fe0c1', reading: '#a9d6ee',
  searching: '#a7dcf4', testing: '#b1e29d', terminal: '#b2c7ec', browsing: '#b8baf0',
  reviewing: '#e6cc9a', waiting: '#efc18c', done: '#9fe0b6', idle: '#a3ada8',
};
const n = value => Number(value.toFixed(3));
const TAU = Math.PI * 2;

function icon(action, progress = 0) {
  const wave = Math.sin(progress * TAU);
  switch (action) {
    case 'thinking':
      return [38, 64, 90].map((x, i) => `<circle cx="${x}" cy="${n(65 - 4 * Math.sin(progress * TAU - i * .7))}" r="8" stroke="none" fill="currentColor" opacity="${n(.55 + .45 * (Math.sin(progress * TAU - i * .7) + 1) / 2)}"/>`).join('');
    case 'editing':
      return `<g transform="translate(${n(wave * 2)} ${n(-wave * 2)})"><path d="m39 81 8-23 35-35 21 21-35 35-23 8Z"/><path d="m74 31 21 21M47 58l21 21"/></g><path d="M31 99h64" stroke-width="6" opacity=".6"/>`;
    case 'reading':
      return '<path d="M64 36c-13-9-25-10-40-5v60c15-5 27-4 40 5 13-9 25-10 40-5V31c-15-5-27-4-40 5v60"/><path d="M36 48h15M36 63h15M78 48h14M78 63h14" stroke-width="5" opacity=".6"/>';
    case 'searching':
      return `<g transform="translate(${n(wave * 3)} ${n(Math.cos(progress * TAU) * 2)})"><circle cx="55" cy="54" r="26"/><path d="m75 75 25 25" stroke-width="11"/></g>`;
    case 'testing':
      return '<path d="M37 27h59v76H32V27Z"/><path d="m42 48 6 6 11-13m-17 37 6 6 11-13M71 49h12M71 79h12" stroke-width="6"/>';
    case 'terminal':
      return `<rect x="23" y="30" width="82" height="70" rx="11"/><path d="m39 49 16 15-16 15"/><path d="M68 80h17" opacity="${n(.62 + .38 * (wave + 1) / 2)}"/>`;
    case 'browsing':
      return '<circle cx="64" cy="64" r="39"/><ellipse cx="64" cy="64" rx="17" ry="39" stroke-width="5"/><path d="M27 64h74M35 41h58M35 87h58" stroke-width="5"/>';
    case 'reviewing':
      return '<path d="M34 23h45l18 18v64H34Z"/><path d="M77 25v20h18M46 59h17M54.5 50.5v17M46 86h17M78 59h7M78 86h7" stroke-width="6"/>';
    case 'waiting':
      return '<rect x="36" y="30" width="18" height="68" rx="5" fill="currentColor" stroke="none"/><rect x="74" y="30" width="18" height="68" rx="5" fill="currentColor" stroke="none"/>';
    case 'done':
      return '<circle cx="64" cy="64" r="40" stroke-width="6" opacity=".45"/><path d="m39 65 17 17 35-38" stroke-width="11"/>';
    case 'idle':
      return '<path d="M77 24a41 41 0 1 0 28 56A40 40 0 0 1 77 24Z"/>';
    default:
      return `<g transform="rotate(${n(progress * 360)} 64 64)"><path d="m55 22-3 12-10 5-12-3-10 18 9 9v11l-9 9 10 18 12-3 10 5 3 12h20l3-12 10-5 12 3 10-18-9-9V63l9-9-10-18-12 3-10-5-3-12Z" transform="translate(0 -4) scale(1 .95)" stroke-width="7"/><circle cx="65" cy="64" r="15" stroke-width="7"/></g>`;
  }
}

function drawBadge(action, progress) {
  const color = COLORS[action] || COLORS.working;
  const pulse = .10 + (Math.sin(progress * TAU) + 1) * .025;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128" viewBox="0 0 128 128">
    <rect width="128" height="128" rx="32" fill="#111718"/>
    <circle cx="64" cy="64" r="60" fill="${color}" fill-opacity="${n(pulse)}" stroke="${color}" stroke-opacity=".32" stroke-width="2"/>
    <g fill="none" stroke="${color}" color="${color}" stroke-width="8" stroke-linecap="round" stroke-linejoin="round">${icon(action, progress)}</g>
  </svg>`;
}

module.exports = { ACTIONS, COLORS, icon, drawBadge };
