# wow-muse

<p align="center">
  <img src="docs/screenshot.jpg" alt="The WoW Muse chat window open in Goldshire, with a message on its way to the agent" width="900">
</p>

Chat with your local AI agent from inside **World of Warcraft: Forever** — send a task, go back to questing, get pinged in-game when the answer lands. No alt-tabbing, no `/reload` per message.

- Multiple chats, each its own persistent agent session (like separate terminals), running in parallel
- Live progress while the agent works: action count, elapsed time, the files it's editing and commands it's running
- Replies echoed into the game chat; `/r` replies to the agent when it was the last to message you
- The agent knows your character, level, zone, talents and professions (optional), and you can shift-click items, spells and quests into a message
- An **Allow & retry** button when the agent needs a command outside your allowlist
- A status light for the bridge, automatic retries, and recovery of your chats if the beta client wipes addon data

Nothing here injects code, reads game memory, or generates input. The addon uses documented addon APIs only; the companion reads your screen and writes ordinary files.

## How it works, in one paragraph

WoW addons are sandboxed: no network, no file reads at runtime. Two doors remain. **Out:** the addon draws your message as a strip of colored 4-pixel squares in the top-left corner of the screen; the bridge screen-captures that corner four times a second and decodes it. **In:** a load-on-demand addon reads its files from disk at the moment it is loaded, so the bridge writes the reply into a pool of 200 pre-made slot addons and the game loads a fresh one from a timer. Cheap "is it ready yet" checks ride on a third trick: an empty `.wav` won't play and a valid one will. Details in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Requirements

- Windows, NTFS
- World of Warcraft: Forever (tested on 1.60.1.69913, TOC 16001), **windowed or borderless** — exclusive fullscreen blocks screen capture
- [Node.js](https://nodejs.org) 22.2 or newer
- An agent backend: [Meta Muse](https://developer.meta.com/ai/resources/blog/build-with-muse-code/) (`muse`), `grok-local`, `zcode-local`, the Custom-Code-Harness `ch`, Claude Code (`claude`), or any OpenAI-compatible HTTP endpoint ([LM Studio](https://lmstudio.ai) works out of the box). See [Backends](#backends)

## Install

Step-by-step for a fresh machine, with troubleshooting: [docs/INSTALL-WINDOWS.md](docs/INSTALL-WINDOWS.md). The short version:

```powershell
git clone https://github.com/Franzferdinan51/wow-muse
cd wow-muse
node setup.js --project "C:\path\to\the\project\you\want\to\work\on"
```

`setup.js` finds the client (pass `--wow "<client folder>"` if it can't), copies the addon into `Interface\AddOns\WoWMuse`, writes `bridge/config.json`, and generates the slot pool and signal files (≈15,000 tiny files; that's normal — the client only discovers addon files at launch, so they have to exist up front).

Then **fully quit and relaunch WoW**, enable *WoW Muse* on the AddOns screen, and start the bridge:

```
npm start               # in the current terminal (or: bridge\start.ps1)
bridge\start-window.cmd # double-click version: opens its own window
```

It restarts itself if it ever crashes. Ctrl+C (or closing the window) stops it.

### `wow-muse`: start it from the project folder

Like an agent CLI itself, the bridge works in the folder you start it from. Install the command once:

```powershell
npm link          # in the wow-muse folder; makes `wow-muse` available everywhere
```

Then, from any project:

```powershell
cd C:\path\to\realms
wow-muse
```

Every chat that hasn't picked its own folder now works in `realms`, and the panel's cwd line shows it. `wow-muse --project <dir>` names the folder explicitly; `npm start` inside this repo falls back to `defaultCwd` in the config. Only one bridge can run at a time (two would fight over the screen and the slot files), so this sets the default folder rather than giving you one bridge per project.

## Use

In game: `/wow-muse` opens the window. Until the bridge has answered, a **Connect** button sits where Send would be: start the bridge, click it, and the light turns green (a message typed before that stays in the box). Then click the input box, type, Enter. The reply arrives with the whisper sound; the window's light shows the bridge state (green/yellow/red, hover for details), and **Reconnect** shows up if the bridge goes quiet.

Right-clicking a chat in the left panel opens a small menu with **Rename...** and **Folder...** (right-click again to close it); the trash can on the row deletes the chat after an OK/Cancel confirm. **Folder...** sets the folder this chat's agent works in (same as `/wow-muse cd` below); each chat keeps its own, so you can have chats on different projects side by side.

| Command | What it does |
|---|---|
| `/wow-muse` | toggle the window; the minimize button (top right) or Esc collapses it to a small bar, click the bar to expand |
| `/ai <text>` | send from the normal chat box (`/wow-muse <text>` is the same) |
| `/r <text>` | replies to the agent when it was the last to message you; otherwise the normal whisper reply |
| `/wow-muse new [name]` | new chat = new agent session. Unnamed chats take their title from your first message |
| `/wow-muse chat <n\|name>` | switch chats (or click the left panel; right-click a row for Rename and Folder, its trash can deletes it) |
| `/wow-muse cd <folder>` | folder this chat's agent works in (**Folder...** after right-clicking the chat opens the same thing as a dialog). Relative to the bridge's folder (`/wow-muse cd realms`, `/wow-muse cd ../other`), `~` works, a full path too; `/wow-muse cd` alone goes back to the bridge's default. A chat that changes folder starts a fresh agent session there |
| `/wow-muse reset` | wipe this chat's agent memory, keep the transcript |
| `/wow-muse context [on\|off]` | show what the agent is told about your character and location, or turn it on/off |
| `/wow-muse rename`, `/wow-muse delete`, `/wow-muse clear` | manage the current chat |
| `/wow-muse echo full\|short\|off\|<chars>` | how much of each reply to print into the game chat (default 4000 chars) |
| `/wow-muse longchat on` | let the game chat box take 4000 characters, for long `/ai` messages |
| `/wow-muse bind <key>` | hotkey: checks for a reply while waiting, otherwise toggles the window |
| `/wow-muse cancel` | stop waiting on this chat's reply |
| `/wow-muse resend` | show the strip again if the bridge missed it |
| `/wow-muse reload` | reload the UI now (also frees the slot pool) |
| `/wow-muse mode reload` | fallback transport that costs a `/reload` per step, if pixels or slots can't work |
| `/wow-muse diag`, `/wow-muse slots` | transport diagnostics |
| `/wow-muse help` | the full list |

Click any message, or `/wow-muse copy` for the last reply, to open it in a selectable box for Ctrl+C.

### Your agent knows where you are

The addon tells the agent which game and client you are on, your character (name, realm, level, race, class, faction, guild), where you are (zone, subzone and the map coordinates the minimap shows), your money, talents and professions. A few lines, sent with the addon's hello and again whenever they change, and put into the agent's system prompt by the bridge, so you can ask "what should I be doing at my level around here?" or "write me a macro for my class" without explaining yourself first. It is only a hint: for a chat about an unrelated project it changes nothing. `/wow-muse context` shows exactly what is sent; `/wow-muse context off` stops sending it (the bridge forgets it too), and `"gameContext": false` in `bridge/config.json` turns it off for good.

Along with it, every run gets [docs/WOW-ADDON-PRIMER.md](docs/WOW-ADDON-PRIMER.md): a short reference on writing addons and macros for this client (TOC layout, sandbox rules, common frames and events, where to verify an API), so "write me an addon that..." works from any folder, not just this repo. Edit the file to suit your setup; the bridge re-reads it on every run. `"primerFile": ""` in the config drops it, and `/wow-muse context off` turns it off together with the character context.

### Link items, spells and quests

Click the input box, then **shift-click** an item in your bags, a spell in the spellbook, a quest in the log, or a link in the chat: it lands in your message the way it would in the game chat. When you send, each link becomes `[Name]` in the text and its tooltip (an item's stats, a spell's description) is attached below, so the agent sees what you see when hovering it. This works from the game chat box too (`/ai is this an upgrade? [Fine Longsword]`). Without a box focused, shift-click keeps its normal meaning.

### Permissions

The agent runs headless, so it can't ask you to approve a tool. `permissionMode` in `bridge/config.json` is `acceptEdits` by default (file edits inside the project are auto-approved) and `allowedTools` lists the commands it may run. Anything else is denied, and the reply grows an **Allow WebSearch, Bash(cargo:*) & retry** button: click it, the rules are added to your config permanently, and the agent resumes where it stopped. The rule is a prefix (`Bash(rm:*)` allows any `rm`), so read the button before clicking. `bypassPermissions` gives full autonomy; you decide.

## Configuration (`bridge/config.json`)

The keys you are most likely to touch. Every key, flag and environment variable is in [docs/CONFIGURATION.md](docs/CONFIGURATION.md).

| Key | Meaning |
|---|---|
| `defaultCwd` | folder for chats that haven't been given one with `/wow-muse cd` |
| `maxParallel` | how many chats may run at once (default 3) |
| `permissionMode`, `allowedTools`, `model` | passed to the agent CLI (or the HTTP body) |
| `gameContext` | `false` never tells the agent about your character, whatever the addon sends (default `true`) |
| `primerFile` | the addon/macro primer appended with the context (default `docs/WOW-ADDON-PRIMER.md`; `""` = none) |
| `capture.processName` | the game exe without `.exe` (`WowB` for Forever); set by `setup.js` |
| `slots`, `actMax`, `presenceMax` | pool sizes; must match the constants at the top of `WoWMuse.lua` if you change them |
| `timeoutMs` | kill a run that takes longer than this (default 30 min) |

## Backends

The bridge doesn't care which agent does the work — it speaks to a provider, and the provider runs the CLI (or HTTP endpoint) of your choice. Pick one in `bridge/config.json`:

```json
"provider": {
  "id": "muse",
  "path": "",
  "model": "",
  "http": { "baseUrl": "", "apiKey": "", "model": "", "timeoutMs": 120000 }
}
```

| `id` | What it runs | Notes |
|---|---|---|
| `muse` | Meta Muse CLI (`muse exec --json ...`) | Default. Prompt goes through a temp file; JSONL output is parsed best-effort. Needs `muse login` or `META_API_KEY`. |
| `grok-local` | `grok-local -p` | Plain-text one-shot; supports `--resume`, `--model`, `--allow`, `--rules`. |
| `grok` | `grok -p` (official Grok Build CLI) | **Calls xAI's cloud**, unlike `grok-local` (local LM Studio). Needs the CLI's OAuth login; supports `--resume`, `--rules`, `--allow`. |
| `zcode` | `zcode-local -p` | Plain-text one-shot; the bridge's `permissionMode` maps to `--mode build\|edit\|plan\|yolo`. Supports `--resume`. |
| `harness` | `ch run <prompt> --print` | Custom-Code-Harness one-shot; optional `harnessProvider` selects its provider. |
| `hermes` | `hermes -z` | Hermes agent one-shot, plain text; the session id is recovered from `--usage-file` so `--resume` keeps working. Experimental — a live smoke test needs a model loaded and none was available during testing. |
| `openclaw` | `openclaw agent --local -m` | OpenClaw one-shot against the local model; supports `--session-id` resume. Verified live on Windows (`openclaw agent --local -m "Reply with exactly: OK"` → `OK`); on the Mac it may need its plugin issues resolved first (a stale discord plugin blocked the CLI there). |
| `codex` | `codex exec --json` | OpenAI Codex CLI; JSONL events are parsed (session, text, progress, errors). Supports `exec resume --json`. |
| `gemini` | `gemini --output-format stream-json -p` | Google Gemini CLI; stream-json events are parsed. No resume (the CLI's `--resume` targets the latest/latest-index session only). |
| `opencode` | `opencode run --format json` | OpenCode one-shot; JSON events are parsed. Supports `--session` resume. |
| `mcode` | `mcode exec --output-format stream-json` | MiniMax Code; stream-json events are parsed. Supports `--session` resume. |
| `lmstudio` | `POST http://127.0.0.1:1234/v1/chat/completions` | LM Studio preset; set `provider.model` to the loaded model. |
| `muse-http` | your Muse-compatible OpenAI endpoint | Set `provider.http.baseUrl` (+ `apiKey`, `model`); nothing is assumed about the URL. |
| `openai-compat` | any OpenAI-compatible endpoint | Same as `muse-http` without the Muse branding. |
| `claude` | `claude -p --output-format stream-json` | **Legacy.** The original backend — only runs when explicitly selected (or via a legacy `claudePath` config). |

`path` overrides the executable that is launched (for the CLI providers); `model` is passed through where the CLI supports it. No model IDs are built in — the model always comes from your config or from the router below.

If the selected backend's executable isn't installed, the run fails loudly with setup guidance (which backends are available and how to point at yours) — the bridge never silently switches you to a different backend. A legacy `claudePath` config still selects the `claude` provider for old installs.

### SystemOne routing (optional)

If you run the [SystemOne](https://github.com/Franzferdinan51/SystemOne) router shim (`POST /v1/systemone/route`), the bridge can ask it which tier each task belongs to and map the tier to a provider — cheapest-sufficient backend per task, decided in ~100 ms. It is advisory and fail-open: the shim is only consulted during an active turn, and any error, timeout (default 3 s) or unmapped tier silently falls back to the configured provider. The router never loads, unloads or switches models; it only recommends, and the recommendation flows router → tier map → your config.

```json
"systemone": {
  "enabled": true,
  "host": "127.0.0.1",
  "port": 8765,
  "timeoutMs": 3000,
  "tierMap": {
    "economy":  { "provider": "lmstudio" },
    "balanced": { "provider": "grok-local" },
    "heavy":    { "provider": "muse" }
  }
}
```

## Troubleshooting

- **Connect says "No answer from the bridge" / light stays red** — is the bridge running? Is the game window on screen and not minimized? Exclusive fullscreen blocks capture. `bridge.log` shows `strip #N` when a message is decoded and `strip seen but rejected: ...` when one is misread.
- **Reply never appears but `bridge.log` says `done`** — `/wow-muse slots`; if the pool is empty, `/wow-muse reload` frees it and picks the reply up via the fallback path.
- **"Reply slots not installed"** — `node bridge/install-slots.js`, then restart WoW.
- **Chats vanished after a reload** — the beta client sometimes wipes addon saved data. The bridge keeps `transcripts.json` and sends your chats back automatically on the next message.
- **`/wow-muse diag` says the sound channel is unusable** — the cheap readiness checks and heartbeat are off; everything still works through slot polls, just with coarser progress. If it says a valid file reports as unplayable, WoW hasn't been restarted since the files were created.

## Documentation

- [docs/INSTALL-WINDOWS.md](docs/INSTALL-WINDOWS.md): step-by-step install on a fresh machine, with troubleshooting
- [docs/CONFIGURATION.md](docs/CONFIGURATION.md): every config key, command-line flag and environment variable
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): how the pixel strip, slot pool and signal files work, and why
- [CONTRIBUTING.md](CONTRIBUTING.md): repo layout, running the tests, conventions
- [CHANGELOG.md](CHANGELOG.md): release notes

## Development

```
npm install
npm test          # everything except the live test; CI runs it on Windows (.github/workflows/test.yml)
npm run test:live # runs the bridge in a sandbox with a real agent call
```

Layout: `addon/WoWMuse` is the addon, `bridge/` the companion (`bridge.js` does I/O and processes, `protocol.js` is the pure part), `docs/` the design and reference, `tests/` the checks. After editing the addon, copy it into the game folder (`node setup.js` does that too) and `/reload`. What each test covers, and the conventions for changes, are in [CONTRIBUTING.md](CONTRIBUTING.md).

## Credits

- [chelinho139](https://github.com/chelinho139), the original **WoW Claude** author — this project began as a fork/evolution of WoW Claude. See [NOTICE.md](NOTICE.md).
- [ZCode](https://github.com/Franzferdinan51/ZCode) — the headless invocation shapes and event vocabularies for the `codex`, `gemini`, `opencode`, `mcode` and `hermes` backends follow ZCode's harness driver table (`packages/shared/src/harness-drivers.ts`).
- [0xInuarashi's wow-forever-codex](https://github.com/0xinuarashi/wow-forever-codex) measured the client's file-loading rules on a live Forever build (files must exist at launch; a not-yet-loaded file is read fresh on first use) and pioneered the pixel-out channel for Codex, with a font-metrics return channel. This project uses the same rules with load-on-demand addons instead of fonts.
- [Gethe/wow-ui-source](https://github.com/Gethe/wow-ui-source) — Blizzard's UI code, `forever` branch, used to verify every API this addon calls.

## License

MIT — see [LICENSE](LICENSE).
