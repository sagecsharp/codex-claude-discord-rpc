#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { Resvg } = require('@resvg/resvg-js');
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
<text x="62" y="222" font-size="15" fill="#8e9a93">distinct motion. quiet confidence. a clear signal of what you’re working on.</text>
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
<text x="173" y="674" font-size="14" fill="#d7e1d9" font-weight="600">codex + claude</text><text x="173" y="699" font-size="12" fill="#86978a">both working · session usage</text>
<text x="1113" y="675" font-size="12" text-anchor="end" fill="#b1c0b5">working / thinking / waiting / idle</text><text x="1113" y="699" font-size="11" text-anchor="end" fill="#718275">256 × 256 · 20 fps · animated gif + static png</text>
<text x="62" y="770" font-size="10" fill="#586b5c">independent integration. not affiliated with openai or anthropic.</text><text x="1138" y="770" text-anchor="end" font-size="10" fill="#586b5c">open preview.html to see the motion</text>
</g></svg>`;
fs.writeFileSync(path.join(target, 'overview.png'), new Resvg(svg).render().asPng());
console.log('overview.png: 1200 × 800');
