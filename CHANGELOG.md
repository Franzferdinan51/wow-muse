# Changelog

All notable changes to this project are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- Pluggable agent backends (`bridge/providers.js`): the bridge now runs **Meta Muse** (`muse exec --json …`, default), **grok-local**, **ZCode** (`zcode-local -p`), the **Custom-Code-Harness** `ch` CLI, **Claude Code** (backward-compatible), **LM Studio** (`http://127.0.0.1:1234` preset), a generic **Muse-compatible HTTP** provider, and any **OpenAI-compatible HTTP** endpoint. Pick with `provider.id` in `config.json`; `provider.path` overrides the executable and `provider.http` configures the HTTP providers.
- Optional, advisory **SystemOne routing**: when `systemone.enabled` is true, each turn asks the local router shim (`POST /v1/systemone/route`) for a tier and maps it through `systemone.tierMap` to a provider/model. Fail-open — timeouts, errors and unmapped tiers silently use the configured provider — and the router is never asked to load, unload or switch models.
- Pure output parsers (`bridge/output.js`) for Claude's stream-json events and the Muse CLI's JSONL events, covered by `tests/providers_test.js` (provider arg construction, muse→claude fallback, no hard-coded model IDs, SystemOne success/timeout/error fail-open).
- Old installs keep their chats: the addon adopts `WoWClaudeDB` into `WoWMuseDB` on first login, and the bridge honors `claudePath` and `WOW_CLAUDE_PROJECT` as legacy aliases.

### Changed

- Renamed **WoW Claude** to **WoW Muse** everywhere: addon folder `WoWMuse`, slash commands `/wow-muse` and `/muse` (`/wow-claude` kept as a deprecated alias), package/bin `wow-muse`, in-game `[Muse · name]` headers, `|Hmuse:…|` links, and transcript role `muse`.
- The agent is told which game and client you are on, your character (name, realm, level, race, class, faction, guild), zone and map coordinates, money, talents and professions. The addon sends these few lines with its hello and again when they change (a `c` flag and an extra field in the strip record), the bridge keeps the latest in `state.json` and passes it to every run\u2019s system prompt. `/wow-muse context` shows it, `/wow-muse context off` stops it (and clears the bridge's copy), `"gameContext": false` in `config.json` disables it on the bridge side.
- `docs/WOW-ADDON-PRIMER.md`, a short reference on writing addons and macros for the Forever client, goes into the system prompt with the game context on every run, whatever folder the chat works in. `primerFile` in `config.json` points elsewhere or (`""`) drops it; edits are picked up without a restart.
- Shift-click an item, spell, quest or name while the addon's input box has focus to link it into the message, as in the game chat (hooked on `ChatFrameUtil.InsertLink`, the modern chat code the Forever client runs; the old `ChatEdit_InsertLink` global is used only where that is missing). On send, each link becomes `[Name]` in the text and its tooltip is appended in a "Linked from the game" block, so the agent can read an item's stats or a spell's description. Links typed in the game chat (`/ai … [item]`) get the same treatment.

### Changed

- Rename and Folder moved off the bottom row into a small menu that opens when you right-click a chat in the left panel.
- Each chat row has a trash can that deletes the chat after an OK/Cancel confirm; `/wow-muse delete` still deletes without asking.
- Send sits at the right end of the input box instead of at the left of the bottom row.
- The bridge no longer exits when the addon folder is missing from `Interface\AddOns`; it logs one warning and the banner shows `addon : NOT INSTALLED`.

### Fixed

- Deleting a chat in game now tells the bridge to forget its transcript and agent session (a `d` strip record), so a later restore no longer brings the chat back. Deletions made while the bridge was away are resent with the next hello.
- On clients where the sound-file self-test fails (an empty `.wav` reports as playable), the addon can't hear the bridge's 30-second presence beats, and the status light went yellow 90 s after every reply, so each new message needed a Reconnect click and burned a slot. In that mode the light now allows for the 10-minute idle slot poll (green up to 12 min without news, "down" after 22), so it stays green while the bridge is running.
- A message sent while the light is not green is now sent automatically once the bridge answers the reconnect, instead of waiting for a second click on Send.

## [0.3.0] - 2026-09-22

First public release.

### Added

- In-game chat window (`/wow-muse`) with multiple chats, each backed by its own persistent Claude Code session, running in parallel up to `maxParallel`.
- Outbound transport: messages drawn as a pixel strip in the top-left corner and decoded by a PowerShell screen capture.
- Inbound transport: a pool of 200 load-on-demand slot addons the bridge writes replies into, plus `Inbox.lua` for the `/reload` fallback.
- Empty-wav signal files for acknowledgements, reply readiness, per-action heartbeats, and a 30-second presence beat that drives the status light.
- Live progress in the working bubble: action count, elapsed time, and the files and commands Claude is touching.
- Replies echoed into the game chat; `/r` replies to Claude when it was the last to message you; `/ai <text>` sends from the chat box.
- **Allow & retry** button when Claude is denied a tool, which appends the rule to `allowedTools` and resumes.
- Per-chat working folder (`/wow-muse cd`, **Folder** button) resolved against the bridge's default folder.
- Bridge-side transcripts and automatic restore of chats after the client wipes addon saved data.
- `wow-muse` command (`npm link`) that uses the folder it is started from as the default project.
- `setup.js` installer: finds the client, copies the addon, writes `config.json`, builds the slot pool.
- Test suite: addon in a Lua VM with a stub client, protocol unit tests, slot-file round trip, codec-to-decoder round trip, and a live inject test.

[Unreleased]: https://github.com/chelinho139/wow-muse/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/chelinho139/wow-muse/releases/tag/v0.3.0
