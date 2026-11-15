#!/usr/bin/env node
'use strict';
// the two readme posters, built from the generated pngs.
const fs = require('node:fs');
const path = require('node:path');
const { Resvg } = require('@resvg/resvg-js');
const { ACTIONS, COLORS } = require('./action-art.cjs');
const target = path.resolve(__dirname, '../assets');
const img = name => `data:image/png;base64,${fs.readFileSync(path.join(target, `${name}.png`)).toString('base64')}`;
const FONT = 'Cascadia Mono, Consolas, Courier New, monospace';
let clips = 0;
// a picture with rounded corners, the way discord shows it.
function tile(name, x, y, size, radius = size / 8) {
  const id = `clip${clips++}`;
  return `<clipPath id="${id}"><rect x="${x}" y="${y}" width="${size}" height="${size}" rx="${radius}"/></clipPath>
    <image clip-path="url(#${id})" href="${img(name)}" x="${x}" y="${y}" width="${size}" height="${size}"/>`;
}
const text = (x, y, size, fill, value, anchor = 'start') => `<text x="${x}" y="${y}" font-size="${size}" fill="${fill}" text-anchor="${anchor}">${value}</text>`;

const big = [
  ['codex-working', 'codex pet', 'typing away'],
  ['claude-waiting', 'clawd', 'waiting for you'],
  ['split-thinking-working', 'both at once', 'each does its own thing'],
  ['deepseek-idle', 'deepseek whale', 'asleep'],
];
const poster = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="800" viewBox="0 0 1200 800">
<rect width="1200" height="800" fill="#1e1f22"/>
<g font-family="${FONT}">
${text(40, 78, 38, '#f2f3f5', 'your coding ais, hanging out in discord')}
${text(40, 116, 18, '#b5bac1', 'codex, claude and opencode (with glm or deepseek). little pixel guys that show what each one is up to.')}
${big.map(([name, title, caption], index) => {
    const x = 40 + index * 288;
    return `${tile(name, x, 160, 256)}${text(x + 128, 452, 18, '#f2f3f5', title, 'middle')}${text(x + 128, 478, 14, '#949ba4', caption, 'middle')}`;
  }).join('')}
<rect x="40" y="520" width="548" height="208" rx="18" fill="#2b2d31"/>
${text(64, 556, 13, '#949ba4', 'opencode shows the model it is using')}
${tile('glm-working', 64, 576, 128)}${tile('opencode-thinking', 208, 576, 128)}${tile('deepseek-working', 352, 576, 128)}
${text(504, 630, 14, '#b5bac1', 'glm')}${text(504, 654, 14, '#b5bac1', 'opencode')}${text(504, 678, 14, '#b5bac1', 'deepseek')}
<rect x="612" y="520" width="548" height="208" rx="18" fill="#2b2d31"/>
${text(636, 556, 13, '#949ba4', 'what it looks like on your profile')}
${tile('claude-working', 636, 576, 128)}
<circle cx="752" cy="692" r="26" fill="#2b2d31"/>${tile('action-editing', 730, 670, 44, 22)}
${text(796, 606, 18, '#f2f3f5', 'codex + claude')}
${text(796, 636, 14, '#dbdee1', 'claude: editing files · fable 5.2')}
${text(796, 662, 14, '#dbdee1', '~$36,313 total · ~$413 today')}
${text(796, 688, 14, '#949ba4', '12:34 elapsed')}
${text(40, 772, 12, '#80848e', 'fan made. not affiliated with openai, anthropic, opencode, deepseek or z.ai. example numbers.')}
${text(1160, 772, 12, '#80848e', 'open assets/preview.html to see them move', 'end')}
</g></svg>`;
fs.writeFileSync(path.join(target, 'overview-pixel.png'), new Resvg(poster).render().asPng());
console.log('overview-pixel.png: 1200 × 800');

const cards = ACTIONS.map((action, index) => {
  const x = 40 + (index % 6) * 190;
  const y = 130 + Math.floor(index / 6) * 250;
  return `<rect x="${x}" y="${y}" width="170" height="226" rx="16" fill="#2b2d31"/>
    ${tile(`action-${action}`, x + 21, y + 20, 128, 64)}
    ${text(x + 85, y + 178, 15, COLORS[action], action, 'middle')}
    ${tile(`action-${action}`, x + 69, y + 188, 32, 16)}`;
}).join('');
const badges = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="680" viewBox="0 0 1200 680">
<rect width="1200" height="680" fill="#1e1f22"/>
<g font-family="${FONT}">
${text(40, 66, 34, '#f2f3f5', 'the little badge says what it is doing')}
${text(40, 98, 16, '#b5bac1', 'big on top, actual discord size underneath.')}
${cards}
${text(40, 656, 12, '#80848e', 'animated gif + still png for each. no text inside the images.')}
</g></svg>`;
fs.writeFileSync(path.join(target, 'actions-overview.png'), new Resvg(badges).render().asPng());
console.log('actions-overview.png: 1200 × 680');
