'use strict';

/**
 * Is IDA Pro open? Answered from the process list, refreshed asynchronously
 * at most every 30s so a slow `tasklist` never stalls the card.
 *
 * Matches the IDA GUI and text-mode binaries across versions: ida / idat
 * (9.x), ida64 / idat64 / idaq64 / idaw (older). The idalib MCP server
 * (idalib-mcp.exe) doesn't count - it's not IDA, and Claude calling it is
 * detected from the transcript instead.
 */

const path = require('path');
const { execFile } = require('child_process');

const IDA = /^(ida|ida64|idat|idat64|idaq|idaq64|idaw|idaw64)(\.exe)?$/i;
const MAX_AGE_MS = 30000;

let running = false;
let checkedAt = 0;
let pending = false;

function refresh() {
  pending = true;
  checkedAt = Date.now();
  const [cmd, args] = process.platform === 'win32' ? ['tasklist', ['/FO', 'CSV', '/NH']] : ['ps', ['-A', '-o', 'comm=']];
  execFile(cmd, args, { windowsHide: true, timeout: 10000, maxBuffer: 16 << 20 }, (err, out) => {
    pending = false;
    if (err) return;
    const names =
      process.platform === 'win32'
        ? String(out)
            .split(/\r?\n/)
            .map((l) => (/^"([^"]+)"/.exec(l) || [])[1])
        : String(out)
            .split('\n')
            .map((l) => path.basename(l.trim()));
    running = names.some((n) => n && IDA.test(n));
  });
}

/** Last known answer; kicks off a refresh when it's stale. */
function idaRunning() {
  if (!pending && Date.now() - checkedAt > MAX_AGE_MS) refresh();
  return running;
}

module.exports = { idaRunning, IDA };
