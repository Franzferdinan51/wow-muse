# Configuration reference

Everything the bridge reads: `bridge/config.json`, command-line flags, environment variables, and the files it writes next to itself. `node setup.js` writes a working `config.json` from `bridge/config.example.json`; this page explains each key so you can tune it by hand.

The bridge reads `config.json` once at start. Restart it after editing, except for `allowedTools`, which the **Allow & retry** button updates live.

## Paths

| Key | Default (from `config.example.json`) | Meaning |
|---|---|---|
| `addonDir` | `…\World of Warcraft\_classic_beta_\Interface\AddOns` | The game's AddOns folder. The bridge writes the slot addons, `Inbox.lua` and every signal file under it. `setup.js` fills this in from the client it finds. |
| `inboxFile` | `<addonDir>\WoWMuse\Inbox.lua` | The file the game reads on `/reload` (fallback path). Normally derived from `addonDir`; only change it if you moved the addon. |
| `savedVariablesFile` | `…\WTF\Account\<account>\SavedVariables\WoWMuse.lua` | The addon's saved data. The bridge polls it for the reload-path outbox. `setup.js` picks the first account under `WTF\Account`; pass `--account <name>` to choose another. |
| `defaultCwd` | `C:\path\to\your\project` | Folder for chats that have not chosen one with `/wow-muse cd`, when the bridge is started from inside this repo (`npm start`). See [Which folder the agent works in](#which-folder-the-agent-works-in). |
| `claudePath` | `""` | **Legacy.** Full path to the `claude` executable; setting it without a `provider` block selects the `claude` provider. Prefer `provider.path` below. |
| `provider` | see below | Which agent backend runs each turn. `id` picks the provider (default `muse`; if the backend's executable is missing the run fails loudly with setup guidance — no silent backend switching), `path` overrides its executable, `model` is passed where the CLI supports it, `harnessProvider` selects the Custom-Code-Harness provider for `ch`, and `http` configures the HTTP providers (`baseUrl`, `apiKey`, `model`, `timeoutMs`). The `claude` provider is legacy — only used when explicitly selected or via the legacy `claudePath` key. Full table in the README's [Backends](../README.md#backends) section. |

## Running the agent

| Key | Default | Meaning |
|---|---|---|
| `permissionMode` | `"acceptEdits"` | Passed to the agent CLI (`--permission-mode` for Claude Code; mapped to ZCode's `--mode`). `acceptEdits` auto-approves file edits inside the working folder; `bypassPermissions` approves everything; `default` denies anything not in `allowedTools`. |
| `allowedTools` | git, npm, npx, node, python, pip, pytest, ls, dir, WebSearch, WebFetch | Rules passed to the agent CLI (`--allowedTools` for Claude Code, `--allow` for grok-local). `Bash(git:*)` allows any command starting with `git`. The **Allow & retry** button in game appends rules here permanently. |
| `model` | `""` | Passed to the agent CLI (`--model`) or the HTTP body when non-empty. Empty uses the backend's default. No model IDs are built in. |
| `gameContext` | `true` | Put the character/zone context the addon sends into the agent's system prompt (Claude: `--append-system-prompt`; others: prepended to the prompt or sent as the system message). `false` ignores it, for a bridge only ever used on unrelated projects. The addon has its own switch, `/wow-muse context off`, which also clears what the bridge holds. |
| `primerFile` | `"docs/WOW-ADDON-PRIMER.md"` | A markdown file appended to the system prompt together with the game context, whatever folder the chat works in: how to write addons and macros for this client. Relative to the wow-muse folder, or absolute. Re-read on every run, so edits count at once. `""` sends none. Off whenever the context is off. |
| `maxParallel` | `3` | How many chats may run at the same time. Further messages queue per chat. |
| `timeoutMs` | `1800000` (30 min) | An agent run longer than this is killed and reported as an error in game. |
| `progressWriteMs` | `3000` | Minimum gap between progress writes to the slot files. Final replies are written immediately. |
| `pollMs` | `750` | How often the bridge checks the SavedVariables file for a reload-path message. |

## SystemOne routing (optional)

| Key | Default | Meaning |
|---|---|---|
| `systemone.enabled` | `false` | Ask the local SystemOne router shim which tier each task belongs to, and map the tier to a provider via `tierMap`. Advisory and fail-open: timeouts, errors and unmapped tiers silently use the configured provider. The router is only consulted during an active turn and is never asked to load, unload or switch models. |
| `systemone.host` / `systemone.port` | `127.0.0.1` / `8765` | Where the router shim listens (`POST /v1/systemone/route`). |
| `systemone.timeoutMs` | `3000` | Give up on the router after this long and continue without it. |
| `systemone.tierMap` | `{}` | Maps router tiers to `{ "provider": "<id>", "model": "<optional>" }`, e.g. `"economy": { "provider": "lmstudio" }`. |

## Screen capture

Keys under `capture`:

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `true` | Run `capture.ps1`. With `false` only the reload path works (`/wow-muse mode reload` in game). |
| `processName` | `"WowB"` | The game executable without `.exe`. `setup.js` sets it from the `Wow*.exe` it finds in the client folder. |
| `cellPx` | `4` | Pixel size of one strip cell. Must match `CELL` in `addon/WoWMuse/Codec.lua`. |
| `cellsPerRow` | `200` | Cells per strip row. Must match the addon. |
| `maxRows` | `48` | Maximum strip rows captured. Must match the addon. |
| `intervalMs` | `250` | Capture period. Lower is more responsive and costs a little more CPU. |

The capture region is `cellsPerRow × cellPx` by `maxRows × cellPx` pixels (800 × 192 by default) at the top-left of the game's client area.

## Slot pool and signal files

These sizes are baked into the files `install-slots.js` creates, and the addon has matching constants at the top of `addon/WoWMuse/WoWMuse.lua` (`SLOT_COUNT`, `ACT_MAX`, `PRESENCE_MAX`). Change all three places together, re-run `node bridge/install-slots.js`, and restart the game.

| Key | Default | Meaning |
|---|---|---|
| `slots` | `200` | Reply-slot addons `WoWMuse_S001` … `WoWMuse_S200`. Each slot can be loaded once per UI session; `/reload` frees them all. |
| `actMax` | `60` | Heartbeat files per message (`act/NNN/01..60.wav`). One flips per agent action. |
| `presenceMax` | `2000` | Presence files (`presence/0001..2000.wav`). One flips per `presenceIntervalMs`. |
| `presenceIntervalMs` | `30000` | How often the bridge flips a presence file so the in-game light stays green. |
| `tocInterface` | `"16001"` | `## Interface:` version written into every slot addon's `.toc`. Bump it when the client's TOC version changes. |

## Command line

`wow-muse` (after `npm link`) and `node bridge/bridge.js` take the same flags. `npm start` runs `bridge/supervisor.js`, which restarts the bridge on crash and passes flags through.

| Flag | Meaning |
|---|---|
| `--project <dir>` | Default working folder for this run. Overrides everything else. |
| `--once` | Handle one pending reload-path message and exit. |
| `--inject "<text>"` | Pretend the strip said this, run the agent, publish the result, exit. Handy for checking a setup without the game. |
| `--help`, `-h` | Print usage. |

Exit codes: `0` normal, `1` the injected or one-shot job failed, `2` config missing or unreadable. The supervisor only restarts on codes other than `0` and `2`.

## Environment

| Variable | Meaning |
|---|---|
| `WOW_MUSE_PROJECT` | Default working folder, below `--project` and above the start folder in precedence. `WOW_CLAUDE_PROJECT` is honored as a legacy alias. |
| `CLAUDECODE` | Removed from the child's environment so a bridge started from inside a Claude Code session can still launch agent CLIs. |

## Which folder the agent works in

Each chat can pick its own folder with `/wow-muse cd` or **Folder...** in the menu that opens when you right-click the chat in the left panel. Chats that have not are given the bridge's default folder, chosen in this order:

1. `--project <dir>`
2. `WOW_MUSE_PROJECT`
3. The folder the bridge was started from, unless that is inside this repo
4. `defaultCwd` in `config.json`
5. The current folder

A relative `/wow-muse cd` path is resolved against that default. `~` expands to your home folder. Agent CLIs keep sessions per folder, so a chat that changes folder starts a fresh session there.

## Files the bridge writes next to itself

All of these are gitignored.

| File | Contents |
|---|---|
| `bridge/config.json` | Your configuration. |
| `bridge/state.json` | Agent session ids per chat (for providers that support resume), the folder each session ran in, handled message ids per addon session token, the presence counter, and the latest game context the addon sent (`context`). Delete it to forget all sessions. |
| `bridge/transcripts.json` | The last 200 messages of every chat, so the addon can recover its chats after the client wipes saved data. |
| `bridge/bridge.log` | Everything printed to the console, with timestamps. Grows without bound; delete it whenever you like. |

## `setup.js` flags

| Flag | Meaning |
|---|---|
| `--wow "<client folder>"` | The folder containing `Wow*.exe` and `Interface\`, when auto-detection fails. |
| `--project "<dir>"` | Written to `defaultCwd`. Defaults to the folder you ran setup from. |
| `--account <name>` | Which `WTF\Account\<name>` to use when there are several. |

Re-running `setup.js` re-copies the addon (except `Inbox.lua`, which the bridge owns once running), keeps an existing `config.json`, and only creates slot and signal files that are missing.
