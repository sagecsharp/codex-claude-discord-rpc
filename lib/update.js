'use strict';

/**
 * Self-update, so a fix pushed to GitHub reaches every install - not just
 * whoever remembers to re-run the installer.
 *
 * The daemon compares its VERSION file with the one on the main branch. When
 * GitHub's is newer it downloads the branch tarball, unpacks it in memory
 * (a minimal tar reader - no dependencies), and writes the files over the
 * install. config.json, the stats cache and logs aren't in the repo, so
 * they're never touched. The caller then restarts onto the new code.
 *
 * Git checkouts are skipped: developers update with git, and an updater
 * writing over a working tree would fight them.
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const zlib = require('zlib');

const REPO = 'telljoe/claude-discord-rpc-dist';
const BRANCH = 'main';
const ROOT = path.join(__dirname, '..');
// Local state that must survive an update.
const KEEP = new Set(['config.json', 'cache', 'rpc.log', 'rpc.log.1', 'rpc.v1.log', '.git']);

function localVersion() {
  try {
    return fs.readFileSync(path.join(ROOT, 'VERSION'), 'utf8').trim();
  } catch {
    return '0.0.0';
  }
}

/** a > b for dotted numeric versions. */
function newer(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
  }
  return false;
}

function get(url, redirects = 5) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'user-agent': 'claude-discord-rpc-updater' } }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && redirects > 0) {
        res.resume();
        resolve(get(new URL(res.headers.location, url).toString(), redirects - 1));
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`HTTP ${res.statusCode} for ${url}`));
        return;
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    });
    req.setTimeout(30000, () => req.destroy(new Error(`timed out fetching ${url}`)));
    req.on('error', reject);
  });
}

/**
 * Regular files from a tar archive, with GitHub's top-level "<repo>-<branch>/"
 * folder stripped. Handles ustar prefixes and pax long-path headers.
 */
function untar(buf) {
  const files = [];
  const str = (o, n) => buf.toString('utf8', o, o + n).replace(/\0.*$/s, '');
  let longName = null;
  for (let off = 0; off + 512 <= buf.length; ) {
    if (buf[off] === 0) break; // end-of-archive blocks
    const size = parseInt(str(off + 124, 12).trim() || '0', 8);
    const type = String.fromCharCode(buf[off + 156] || 48);
    let name = str(off, 100);
    const prefix = str(off + 345, 155);
    if (prefix) name = `${prefix}/${name}`;
    const body = buf.subarray(off + 512, off + 512 + size);
    off += 512 + Math.ceil(size / 512) * 512;

    if (type === 'x') {
      const m = /\d+ path=([^\n]+)\n/.exec(body.toString('utf8'));
      longName = m ? m[1] : null;
      continue;
    }
    if (type === 'g') continue; // global pax header (GitHub puts the commit id here)
    if (longName) {
      name = longName;
      longName = null;
    }
    if (type !== '0' && type !== '\0') continue; // directories, links: skip
    const rel = name.split('/').slice(1).join('/');
    if (rel) files.push({ name: rel, data: Buffer.from(body) });
  }
  return files;
}

/**
 * Updates the install if GitHub has a newer version.
 * @returns the new version string, or null when already current / skipped.
 */
async function check() {
  if (fs.existsSync(path.join(ROOT, '.git'))) return null;
  const local = localVersion();
  const remote = (await get(`https://raw.githubusercontent.com/${REPO}/${BRANCH}/VERSION`)).toString().trim();
  if (!/^\d+(\.\d+)*$/.test(remote) || !newer(remote, local)) return null;

  const files = untar(zlib.gunzipSync(await get(`https://codeload.github.com/${REPO}/tar.gz/refs/heads/${BRANCH}`)));
  const ver = files.find((f) => f.name === 'VERSION');
  const got = ver && ver.data.toString().trim();
  // Refuse anything that doesn't look like a complete, newer release.
  if (!got || !newer(got, local) || !files.some((f) => f.name === 'rpc.js')) {
    throw new Error('downloaded archive is incomplete; skipping update');
  }

  // VERSION goes last: if anything fails midway, the install still reports
  // the old version and the next check retries.
  files.sort((a, b) => (a.name === 'VERSION') - (b.name === 'VERSION'));
  for (const f of files) {
    if (KEEP.has(f.name.split('/')[0])) continue;
    const dest = path.resolve(ROOT, f.name);
    if (!dest.startsWith(path.resolve(ROOT) + path.sep)) continue; // no escaping the install dir
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const tmp = `${dest}.update-tmp`;
    fs.writeFileSync(tmp, f.data);
    fs.renameSync(tmp, dest);
  }
  return got;
}

module.exports = { check, get, localVersion, newer, untar };
