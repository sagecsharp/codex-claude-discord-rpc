# codex + claude for discord

both assistants, one discord presence. local activity and token usage with distinct, smooth logo animations.

![codex and claude motion preview](assets/overview.png)

fork of [telljoe/claude-discord-rpc-dist](https://github.com/telljoe/claude-discord-rpc-dist). the original license is preserved. this fork does not update itself from the original repository.

## run

requires node.js 20+ and the discord desktop app. no npm install, api key, or bot token is needed to run.

```powershell
git clone https://github.com/sagecsharp/codex-claude-discord-rpc.git
cd codex-claude-discord-rpc
node rpc.js
```

the default configuration retains the upstream public discord application id and uses this fork's hosted animations. `name` is set to `codex + claude`; the exact display still depends on your discord client. to use your own discord application or change preferences, run `node scripts/setup.js`.

to install in your user account and start at login:

```powershell
powershell -ExecutionPolicy Bypass -File .\install.ps1
```

the installer copies this local checkout to `%LOCALAPPDATA%\CodexClaudeRPC`. it preserves your config on upgrades. `-NoAutostart` skips the login shortcut; `-NoStart` skips starting it. the original clawd install is separate: stop it before running both with the same discord application id.

## what it shows

- plain-language actions such as `codex: running tests` and `claude: editing files`.
- both token totals on the same card when both have recent sessions.
- a white chatgpt knot with a mint orbit; a coral claude sun with a warm pulse.
- four animations for each provider, plus four paired-logo animations. each is a seamless four-second, 20 fps loop.
- distinct action badges for editing, reading, searching, testing, terminal commands, browsing, reviewing, thinking, waiting, finished, idle, and other work.
- an elapsed timer and an optional project folder name.

`auto` follows the active provider and alternates the main logo every 20 seconds when both are active. the small badge shows the current action: a pencil for edits, a magnifier for searches, a checklist for tests, and a pause icon when waiting for you. `combined` keeps both logos in one image. `rotate` also gives recent idle providers a turn as the main logo. text keeps both providers' actions and usage visible in every mode. the discord member list uses the action line too.

action text comes from a fixed vocabulary. raw commands, prompts, and tool inputs never appear on discord. fast tool results keep their action visible for up to eight seconds to avoid flicker. a finished action stays visible for `doneSeconds` (20 seconds by default), then the usual idle preference applies.

there is no text baked into the images. the artwork contains only logos, motion, and action pictograms on pure black; labels stay in discord's normal text fields. glow is confined to the logos, with crisp unlit action icons and orbit lines.

open [the interactive animation preview](assets/preview.html) from your local checkout to compare states and pause motion. github displays the html source; download or clone first.

## settings

optional `config.json` overrides [config.example.json](config.example.json). it is ignored by git. for example:

```json
{
  "displayMode": "combined",
  "privacy": "minimal",
  "showTokens": true,
  "showWhenIdle": false,
  "images": { "animated": true }
}
```

- `privacy`: `minimal` shows provider, state, model, and optional usage. `project` also shows the current folder's name. prompt text, commands, file contents, and full paths are never published. `hideProjects` accepts folder globs such as `client-*`.
- `providers`: set `codex` or `claude` to false to hide that provider.
- `showTokens`: false removes token counts. `showWhenIdle`: true retains idle cards; false clears the presence when nothing is active.
- `images.baseUrl`: public https directory containing the bundled gifs. `images.animated: false` selects png stills. for developer portal uploads, use the png files, name keys like `codex_working`, and set `images.portal: true`.
- `codexRoot`: custom sessions directory (default `$CODEX_HOME/sessions` or `~/.codex/sessions`). `claudeRoot`: custom claude home (default `$CLAUDE_CONFIG_DIR` or `~/.claude`).

discord supports animated images through public external urls. uploaded portal assets are static. see [discord's rich presence documentation](https://docs.discord.com/developers/discord-social-sdk/development-guides/setting-rich-presence#uploading-assets).

## usage and activity limits

usage is the sum of token counters from the recent local sessions being tracked, including cached input. it is not your subscription allowance, account-wide billing, lifetime usage, or a cost estimate. `usage pending` means the local log has no counter yet; `≥` marks incomplete counters from a bounded transcript read. background and child sessions can be included when their logs are present. inherited history in forked sessions can overlap, so totals are not a billing ledger.

codex activity is inferred from local rollout events. claude uses local session metadata and transcripts, with a process-liveness check when a pid is available. no browser chat sessions are read. cloud-only sessions and compressed/archived codex logs are not tracked. local formats can change between app versions.

silent sessions become idle after `staleMs` (two minutes by default), including long-running tasks with no log events. sessions leave the card after `idleRetentionMs` (ten minutes). bounded reads keep large histories responsive. these limits are configurable.

## preview, test, stop

```powershell
node rpc.js --status --json
node rpc.js --demo --status
node --test
node rpc.js --stop
```

`--status` never connects to discord. `--demo` uses synthetic activity; combine it with `--status` for a local preview. `--once` publishes one real snapshot, waits for discord to acknowledge it, then clears and exits. `--log` writes a rotating local log.

to remove login startup, run the installed `install-autostart.ps1 -Remove`. stop the daemon before deleting its install folder. this does not remove the original clawd installation.

## developing the animations

runtime has no external dependencies. only regenerating assets requires development packages:

```powershell
npm ci
npm run assets
```

source vectors and their attribution are in [assets/credits.txt](assets/credits.txt). the logos identify the products; this project is not affiliated with openai or anthropic. see [license](LICENSE) and [notice](NOTICE).
