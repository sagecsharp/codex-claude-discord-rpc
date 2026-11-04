#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { Resvg } = require('@resvg/resvg-js');
const { ACTIONS, COLORS } = require('./action-art.cjs');
const target = path.resolve(__dirname, '../assets');
const img = name => `data:image/png;base64,${fs.readFileSync(path.join(target, `${name}.png`)).toString('base64')}`;
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="800" viewBox="0 0 1200 800">
<defs><radialGradient id="wash"><stop stop-color="#18231f"/><stop offset="1" stop-color="#0c0f10"/></radialGradient></defs>
<rect width="1200" height="800" fill="#0c0f10"/>
<rect width="1200" height="800" fill="url(#wash)" opacity=".4"/>
<g font-family="Segoe UI, Arial, sans-serif">
<g fill="#a9b6af"><rect x="62" y="48" width="3" height="10" rx="1.5"/><rect x="69" y="42" width="3" height="22" rx="1.5"/><rect x="76" y="47" width="3" height="14" rx="1.5"/><rect x="83" y="52" width="3" height="7" rx="1.5"/></g>
<text x="103" y="58" font-size="17" fill="#e7ece8" font-weight="600">dual presence</text>
<text x="1138" y="57" text-anchor="end" font-size="12" fill="#738078" letter-spacing="1.4">motion study / 01</text>
<text x="62" y="127" font-size="11" fill="#96a39b" letter-spacing="2">codex + claude for discord</text>
<text x="58" y="188" font-size="50" fill="#f0f3f0" letter-spacing="-2.4">two minds. <tspan fill="#8a9890">one presence.</tspan></text>
<text x="62" y="222" font-size="15" fill="#8e9a93">recognizable logos. simple action icons. no text inside the discord images.</text>
<rect x="62" y="266" width="532" height="354" rx="18" fill="#111416" stroke="#29302c"/>
<rect x="610" y="266" width="528" height="354" rx="18" fill="#111416" stroke="#29302c"/>
<text x="87" y="302" font-size="15" fill="#e1e7e2">codex</text><text x="569" y="301" font-size="10" text-anchor="end" fill="#6f7d74" letter-spacing="1">01 / orbit</text>
<text x="635" y="302" font-size="15" fill="#e1e7e2">claude</text><text x="1113" y="301" font-size="10" text-anchor="end" fill="#6f7d74" letter-spacing="1">02 / radiance</text>
<image href="${img('codex-working')}" x="212" y="317" width="232" height="232"/>
<image href="${img('claude-working')}" x="758" y="317" width="232" height="232"/>
<path d="M87 563H569M635 563H1113" stroke="#29302c"/>
<circle cx="91" cy="591" r="3" fill="#a4e7d5"/><text x="104" y="596" font-size="12" fill="#aebbb2">steady mint orbit</text><text x="569" y="595" text-anchor="end" font-size="10" fill="#758278">4.0s / seamless loop</text>
<circle cx="639" cy="591" r="3" fill="#dda086"/><text x="652" y="596" font-size="12" fill="#aebbb2">warm traveling radiance</text><text x="1113" y="595" text-anchor="end" font-size="10" fill="#758278">4.0s / seamless loop</text>
<rect x="62" y="638" width="1076" height="100" rx="14" fill="#101414" stroke="#252d28"/>
<image href="${img('both-working')}" x="82" y="652" width="72" height="72"/>
<circle cx="150" cy="719" r="19" fill="#101414"/><image href="${img('action-editing')}" x="134" y="703" width="32" height="32"/>
<text x="183" y="674" font-size="14" fill="#d7e1d9" font-weight="600">codex + claude</text><text x="183" y="699" font-size="12" fill="#86978a">editing code · session usage</text>
<text x="1113" y="675" font-size="12" text-anchor="end" fill="#b1c0b5">working / thinking / waiting / idle</text><text x="1113" y="699" font-size="11" text-anchor="end" fill="#718275">256 × 256 · 20 fps · animated gif + static png</text>
<text x="62" y="770" font-size="10" fill="#586b5c">independent integration. not affiliated with openai or anthropic.</text><text x="1138" y="770" text-anchor="end" font-size="10" fill="#586b5c">open preview.html to see the motion</text>
</g></svg>`;
fs.writeFileSync(path.join(target, 'overview.png'), new Resvg(svg).render().asPng());
console.log('overview.png: 1200 × 800');

const cards = ACTIONS.map((action, index) => {
  const x = 50 + (index % 6) * 184;
  const y = 390 + Math.floor(index / 6) * 187;
  return `<rect x="${x}" y="${y}" width="168" height="170" rx="15" fill="#111819" stroke="#29332e"/>
    <image href="${img(`action-${action}`)}" x="${x + 52}" y="${y + 17}" width="64" height="64"/>
    <text x="${x + 84}" y="${y + 106}" text-anchor="middle" font-size="13" fill="${COLORS[action]}">${action}</text>
    <image href="${img(`action-${action}`)}" x="${x + 68}" y="${y + 121}" width="32" height="32"/>`;
}).join('');
const actionOverview = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="820" viewBox="0 0 1200 820">
  <rect width="1200" height="820" fill="#0c1110"/>
  <g font-family="Segoe UI, Arial, sans-serif">
  <text x="50" y="50" font-size="14" fill="#b5c5b8">dual presence / action study</text>
  <text x="50" y="112" font-size="47" fill="#eef3ed" letter-spacing="-1.8">see what it’s doing.</text>
  <text x="50" y="148" font-size="15" fill="#8fa292">logos and pictograms only. action wording stays in the discord text fields.</text>
  <rect x="50" y="185" width="1104" height="158" rx="18" fill="#121a17" stroke="#2d3c31"/>
  <image href="${img('both-working')}" x="74" y="208" width="112" height="112"/>
  <circle cx="183" cy="309" r="25" fill="#121a17"/><image href="${img('action-editing')}" x="162" y="288" width="42" height="42"/>
  <text x="228" y="227" font-size="11" fill="#7d9582" letter-spacing="1">discord presence</text>
  <text x="228" y="260" font-size="21" fill="#e4eee2" font-weight="600">codex + claude</text>
  <text x="228" y="289" font-size="17" fill="#a8dbb8">editing code</text>
  <text x="228" y="316" font-size="12" fill="#7f9985">codex 12.4k · claude 8.2k tokens · example data</text>
  <text x="877" y="227" font-size="11" fill="#7d9582" letter-spacing="1">actual 32px size</text>
  ${['editing', 'searching', 'terminal', 'waiting'].map((action, index) => `<image href="${img(`action-${action}`)}" x="${877 + index * 51}" y="247" width="32" height="32"/>`).join('')}
  <text x="877" y="311" font-size="12" fill="#7f9985">color + shape, never color alone</text>
  ${cards}
  <text x="50" y="790" font-size="11" fill="#66856e">animated badges · bold original pictograms · gif + png · reduced-motion fallback</text>
  <text x="1154" y="790" text-anchor="end" font-size="11" fill="#66856e">open preview.html to try each action</text>
  </g>
</svg>`;
fs.writeFileSync(path.join(target, 'actions-overview.png'), new Resvg(actionOverview).render().asPng());
console.log('actions-overview.png: 1200 × 820');
