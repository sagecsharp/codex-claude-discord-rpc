'use strict';

/**
 * Maintainer blocklist: Discord accounts this tool won't show a presence for.
 *
 * blocklist.json lives in the repo; every install downloads it and compares it
 * with the Discord account it's connected as. Nothing is sent anywhere - the
 * list comes down, the comparison happens locally. Entries are Discord user
 * IDs (stable) or usernames (can change). If the list can't be fetched the
 * last known answer stands, and with none, nobody is blocked: a network blip
 * never turns anyone off.
 */

const { get } = require('./update');

const URL = 'https://raw.githubusercontent.com/telljoe/claude-discord-rpc-dist/main/blocklist.json';

let entries = null; // Set of lowercase ids/usernames, once fetched

async function refresh() {
  try {
    const j = JSON.parse((await get(URL)).toString());
    const list = Array.isArray(j.users) ? j.users : [];
    entries = new Set(list.map((e) => String(e).trim().toLowerCase()).filter(Boolean));
  } catch {
    /* keep the last known list */
  }
  return entries;
}

/** Is this Discord user on the list? Matches id, username or display name. */
function isBlocked(user) {
  if (!entries || !entries.size || !user) return false;
  return [user.id, user.username, user.global_name].some((v) => v && entries.has(String(v).toLowerCase()));
}

module.exports = { refresh, isBlocked };
