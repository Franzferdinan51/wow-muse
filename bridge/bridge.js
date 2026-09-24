#!/usr/bin/env node
'use strict';
// WoW Muse bridge: the half of WoWMuse that lives outside the game.
//
//   OUT  capture.ps1 screen-captures the addon's pixel strip -> one or more
//        {session, chat, id, cwd, flags, text} records per frame
//        (fallback: the game's SavedVariables file, written on /reload)
//   RUN  an agent backend headless in the chat's folder, streaming progress.
//        Each chat is its own agent session; up to maxParallel run at once.
//        Backends are pluggable (bridge/providers.js): Meta Muse, grok-local,
//        ZCode, the Custom-Code-Harness `ch` CLI, Claude Code, or any
//        OpenAI-compatible HTTP endpoint (LM Studio preset included).
//        SystemOne can route each task to a tier first (bridge/systemone.js).
//   IN   we write the latest reply/status of every chat into every
//        WoWMuse_S### slot addon (the game loads a fresh one from a timer),
//        flip a signal .wav per message, and also write Inbox.lua for the
//        reload path.
//
// Zero npm dependencies. Run with npm start or `node bridge.js`.
//   --once            handle one pending SavedVariables prompt and exit
//   --inject "text"   pretend the strip said this and exit when done
//   --project <dir>   default folder for chats that haven't picked one
//
// Like an agent CLI itself, the bridge works in the folder it was started from:
// `cd my-project && wow-muse` makes my-project the default for every chat
// that hasn't chosen its own with /wow-muse cd. Started from inside this repo (npm
// start), it falls back to defaultCwd in config.json.

const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');
const { spawn } = require('child_process');
const P = require('./protocol'); // the pure protocol code, unit-tested in tests/bridge_test.js
const Providers = require('./providers'); // agent backend registry
const SystemOne = require('./systemone'); // advisory task routing (fail-open)
const Output = require('./output'); // pure backend output parsers

const HERE = __dirname;
const CONFIG_FILE = path.join(HERE, 'config.json');
const STATE_FILE = path.join(HERE, 'state.json');
const LOG_FILE = path.join(HERE, 'bridge.log');

const argv = process.argv.slice(2);
if (argv.includes('--help') || argv.includes('-h')) {
  console.log('wow-muse [--project <dir>] [--once] [--inject "text"]\n\n' +
    'Runs the WoW Muse bridge. Chats without a folder of their own work in <dir>,\n' +
    'or in the folder you started it from, or in defaultCwd from bridge/config.json.');
  process.exit(0);
}
let cfg;
try { cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); }
catch (e) {
  console.error(`Cannot read ${CONFIG_FILE} (${e.message}).\nRun "node setup.js" in the wow-muse folder first.`);
  process.exit(2); // the supervisor doesn't restart on 2
}
const once = argv.includes('--once');
const injectIdx = argv.indexOf('--inject');
const inject = injectIdx >= 0 ? argv[injectIdx + 1] : null;
const exitWhenIdle = once || inject !== null;

// Default folder: --project, else the folder we were started from (unless that is
// this repo, i.e. npm start), else the configured one.
const REPO = path.dirname(HERE);
function insideRepo(dir) {
  const rel = path.relative(REPO, dir);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}
const projectIdx = argv.indexOf('--project');
// WOW_CLAUDE_PROJECT is honored as a legacy alias for WOW_MUSE_PROJECT.
const projectEnv = process.env.WOW_MUSE_PROJECT || process.env.WOW_CLAUDE_PROJECT;
const DEFAULT_CWD = path.resolve(
  projectIdx >= 0 && argv[projectIdx + 1] ? argv[projectIdx + 1]
    : projectEnv ? projectEnv
    : !insideRepo(process.cwd()) ? process.cwd()
    : cfg.defaultCwd || process.cwd());
const DEFAULT_CWD_SOURCE = projectIdx >= 0 ? '--project' : projectEnv ? 'WOW_MUSE_PROJECT'
  : !insideRepo(process.cwd()) ? 'started here' : 'config.json';

const resolveCwd = raw => P.resolveCwd(raw, DEFAULT_CWD);
const { sameFolder } = P;
// Subfolders of the default folder, for the "folder not found" hint.
function siblingFolders() {
  try {
    return fs.readdirSync(DEFAULT_CWD, { withFileTypes: true })
      .filter(d => d.isDirectory() && !d.name.startsWith('.') && d.name !== 'node_modules')
      .map(d => d.name).sort().slice(0, 30);
  } catch { return []; }
}

const SLOTS = cfg.slots || 200;
const MAX_PARALLEL = cfg.maxParallel || 3;
const cap = Object.assign({ enabled: true, processName: 'WowB', cellPx: 4, cellsPerRow: 200, maxRows: 48, intervalMs: 250 }, cfg.capture || {});

let state = readJson(STATE_FILE, { lastId: 0, sessions: {}, handled: {} });
if (!state.handled) state.handled = {};
if (!state.sessions) state.sessions = {};
// Older versions stored handled[session] as "highest id so far"; expand to a map.
for (const [k, v] of Object.entries(state.handled)) {
  if (typeof v === 'number') {
    const m = {};
    for (let i = 1; i <= v; i++) m[i] = 1;
    state.handled[k] = m;
  }
}

// Bridge-side transcripts. The beta client sometimes wipes addon saved data; since
// every prompt and reply passes through here, this copy lets the addon recover.
const TRANSCRIPT_FILE = path.join(HERE, 'transcripts.json');
let transcripts = readJson(TRANSCRIPT_FILE, { chats: {}, tokens: {} });
if (!transcripts.chats) transcripts.chats = {};
if (!transcripts.tokens) transcripts.tokens = {};
if (P.pruneStale(state, transcripts)) { saveState(); saveTranscripts(); }
let pendingRestore = null;

function saveTranscripts() {
  try { fs.writeFileSync(TRANSCRIPT_FILE, JSON.stringify(transcripts)); } catch (e) { log('could not save transcripts:', e.message); }
}

// Chats the player deleted in game while a run for them was still going: the
// run's late progress and reply must not recreate the transcript.
const forgotten = new Set();

function noteMessage(job, role, text) {
  if (!job.chat) return;
  if (role === 'user') forgotten.delete(job.chat);
  else if (forgotten.has(job.chat)) return;
  const c = transcripts.chats[job.chat] = transcripts.chats[job.chat] || { id: job.chat, name: '', cwd: job.cwd, messages: [] };
  if (job.name) c.name = job.name;
  if (job.cwd) c.cwd = job.cwd;
  c.messages.push({ role, text: String(text ?? '').slice(0, 4000), id: job.id, t: Math.floor(Date.now() / 1000) });
  while (c.messages.length > 200) c.messages.shift();
  c.updated = Date.now();
  saveTranscripts();
}

// First message from an addon session token we haven't seen: its saved data is
// fresh (or reset), so offer everything we know once, in the next publish.
function maybeOfferRestore(job) {
  if (!job.session || transcripts.tokens[job.session]) return;
  transcripts.tokens[job.session] = Date.now();
  const chats = Object.values(transcripts.chats)
    .filter(c => c.id !== job.chat && c.messages.length)
    .sort((a, b) => (b.updated || 0) - (a.updated || 0))
    .slice(0, 16)
    .map(c => ({ id: c.id, name: c.name, cwd: c.cwd, messages: c.messages.slice(-40).map(m => ({ ...m, text: m.text.slice(0, 2000) })) }));
  saveTranscripts();
  if (chats.length) {
    pendingRestore = { token: job.session, chats };
    log(`new addon session ${job.session}: offering ${chats.length} chat(s) to restore`);
  }
}

// The player deleted a chat in game. Drop everything we keep for it, so the next
// restore doesn't bring it back and its id can't resume the old agent session.
function forgetChat(job) {
  if (!job.chat) return;
  const had = !!transcripts.chats[job.chat];
  delete transcripts.chats[job.chat];
  forgotten.add(job.chat);
  delete state.sessions[sessKey(job)];
  delete state.sessions[chatKey(job)];
  if (state.sessionCwd) delete state.sessionCwd[sessKey(job)];
  if (pendingRestore) pendingRestore.chats = pendingRestore.chats.filter(c => c.id !== job.chat);
  saveTranscripts();
  log(`#${job.id}${job.session ? '@' + job.session : ''} forgot chat ${job.chat}${had ? '' : ' (nothing stored)'}`);
}

let lastMtime = 0;
const running = new Map(); // chatKey -> { job, child }
const queued = new Map();  // chatKey -> job waiting for that chat (or for a free parallel slot)
const live = new Map();    // chatKey -> latest record shown to the game
let lastPublish = 0;
let publishTimer = null;

// ---------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

function saveState() {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function log(...parts) {
  const line = `[${new Date().toISOString()}] ${parts.join(' ')}`;
  console.log(line);
  try { fs.appendFileSync(LOG_FILE, line + '\n'); } catch {}
}

const { pad3, chatKey, sessKey, luaStr, SILENT_WAV, jobsFromStrip, ruleFor, describeToolUse } = P;
const slotNumber = id => P.slotNumber(id, SLOTS);
const alreadyHandled = job => P.alreadyHandled(state, job);
const markHandled = job => P.markHandled(state, job);

function atomicWrite(file, content) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, file);
}

// Resolve the active provider for this run: SystemOne's advisory routing first
// (router decision), then the tier map / config, then explicit user config.
// The default provider is 'muse'. If its CLI isn't installed, the run fails
// loudly with setup guidance — the bridge never silently switches backends.
let providerFallbackNote = null;
function resolveProviderId() {
  const { id, note } = Providers.resolveId(cfg);
  if (note && note !== providerFallbackNote) { providerFallbackNote = note; log('provider:', note); }
  return id;
}

function providerModel(routed) {
  // Selection order: router decision -> config -> explicit user config.
  if (routed && routed.model) return routed.model;
  const p = cfg.provider || {};
  return p.model || cfg.model || '';
}

// ---------------------------------------------------------------------------
// What the game reads
// ---------------------------------------------------------------------------

// Slot file / Inbox.lua body: see protocol.luaTable.
function slotFile(globalName, records) {
  return P.luaTable(globalName, records, { cwd: DEFAULT_CWD, restore: pendingRestore });
}

function addonInstalled() {
  return fs.existsSync(path.join(cfg.addonDir, 'WoWMuse', 'WoWMuse.toc'));
}

function slotsInstalled() {
  return fs.existsSync(path.join(cfg.addonDir, 'WoWMuse_S001', 'Inbox.lua'));
}

// The game will load *some* unused slot next, so every slot gets the full picture.
// A missing addon folder (not installed yet, or the game folder moved) must not
// take the bridge down: capture and agent runs keep working, and the game just
// won't see replies until `node setup.js` has run and WoW was restarted.
let warnedNoAddon = false;
function publishNow() {
  lastPublish = Date.now();
  const records = [...live.values()].slice(-30);
  try {
    atomicWrite(cfg.inboxFile, slotFile('WoWMuse_Inbox', records));
  } catch (e) {
    if (!warnedNoAddon) {
      warnedNoAddon = true;
      log(`publish: cannot write ${cfg.inboxFile} (${e.code || e.message}); addon not installed? run: node setup.js, then restart WoW`);
    }
    return;
  }
  if (!slotsInstalled()) return;
  const body = slotFile('WoWMuse_SlotData', records);
  for (let i = 1; i <= SLOTS; i++) {
    try { atomicWrite(path.join(cfg.addonDir, 'WoWMuse_S' + pad3(i), 'Inbox.lua'), body); } catch {}
  }
  // The restore bundle is large; it rides along once and is then dropped.
  // (The game keeps loading fresh slots until it has read one carrying it.)
  if (pendingRestore) { pendingRestore.published = (pendingRestore.published || 0) + 1; if (pendingRestore.published >= 3) pendingRestore = null; }
}

// Final results publish immediately; progress is throttled. `key` is the chat
// (record.session is the agent's session id, a different thing).
function publish(key, record, urgent) {
  live.set(key, record);
  if (urgent) { if (publishTimer) { clearTimeout(publishTimer); publishTimer = null; } publishNow(); return; }
  const wait = (cfg.progressWriteMs || 3000) - (Date.now() - lastPublish);
  if (wait <= 0) publishNow();
  else if (!publishTimer) publishTimer = setTimeout(() => { publishTimer = null; publishNow(); }, wait);
}

function signal(kind, id, on) {
  const file = path.join(cfg.addonDir, 'WoWMuse', kind, pad3(slotNumber(id)) + '.wav');
  try { atomicWrite(file, on ? SILENT_WAV : Buffer.alloc(0)); } catch {}
}

// Heartbeat: act/NNN/kk.wav flips valid for the k-th action of message NNN. The
// game polls the next one for free, so it can show "12 actions, last one 5 s ago"
// without spending a reply slot.
const ACT_MAX = cfg.actMax || 60;
function actFile(id, k) {
  return path.join(cfg.addonDir, 'WoWMuse', 'act', pad3(slotNumber(id)), String(k).padStart(2, '0') + '.wav');
}
function resetBeats(id) {
  for (let k = 1; k <= ACT_MAX; k++) { try { atomicWrite(actFile(id, k), Buffer.alloc(0)); } catch {} }
}
function beat(job) {
  job.beats = (job.beats || 0) + 1;
  if (job.beats > ACT_MAX) return;
  try { atomicWrite(actFile(job.id, job.beats), SILENT_WAV); } catch {}
}

// Presence: every 30 s flip the next presence/NNNN.wav valid so the game can tell
// the bridge is alive without spending a slot. The counter persists across
// restarts so a filename is never reused while the game is still running; the
// files just ahead of the counter are kept empty so the game can't run ahead.
const PRESENCE_MAX = cfg.presenceMax || 2000;
function presenceFile(k) {
  return path.join(cfg.addonDir, 'WoWMuse', 'presence', String(k).padStart(4, '0') + '.wav');
}
function presenceBeat() {
  if (!fs.existsSync(path.join(cfg.addonDir, 'WoWMuse', 'presence'))) return;
  state.presence = ((state.presence || 0) % PRESENCE_MAX) + 1;
  const k = state.presence;
  try { atomicWrite(presenceFile(k), SILENT_WAV); } catch {}
  for (let j = 1; j <= 50; j++) {
    const n = ((k - 1 + j) % PRESENCE_MAX) + 1;
    try { atomicWrite(presenceFile(n), Buffer.alloc(0)); } catch {}
  }
  saveState();
}

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

// The reload path: the addon writes its outbox into SavedVariables on /reload.
function readOutbox() {
  let src;
  try { src = fs.readFileSync(cfg.savedVariablesFile, 'utf8'); } catch { return null; }
  return P.parseOutbox(src);
}

// The addon sends the player's in-game context (character, location, ...) with
// its hello and again whenever it changes; an empty one means "context off".
// It is kept in state.json so a restarted bridge still has it, and goes into
// The agent's system prompt on every run (see protocol.systemPrompt).
function setContext(job) {
  const text = String(job.ctx || '').replace(/\r/g, '').trim().slice(0, 2000);
  const prev = (state.context && state.context.text) || '';
  if (text === prev) return;
  state.context = text ? { text, at: Date.now(), session: job.session || '' } : null;
  saveState();
  const who = (text.split('\n').find(l => /^Character:/i.test(l)) || text.split('\n')[0] || '').slice(0, 100);
  log(`#${job.id}${job.session ? '@' + job.session : ''} game context ${text ? 'updated: ' + who : 'cleared'}`);
}

function gameContext() {
  if (cfg.gameContext === false) return '';
  return (state.context && state.context.text) || '';
}

// The addon/macro primer that goes into the system prompt with the context.
// Read on every run so edits count without a restart; "" in the config turns
// it off. Relative paths are taken from the repo (docs/WOW-ADDON-PRIMER.md).
const PRIMER_FILE = cfg.primerFile === undefined ? 'docs/WOW-ADDON-PRIMER.md' : cfg.primerFile;
let warnedNoPrimer = false;
function primer() {
  if (!PRIMER_FILE) return '';
  const file = path.resolve(REPO, PRIMER_FILE);
  try { return fs.readFileSync(file, 'utf8'); } catch (e) {
    if (!warnedNoPrimer) { warnedNoPrimer = true; log(`primer: cannot read ${file} (${e.code || e.message}); running without it`); }
    return '';
  }
}

// Persist newly allowed rules so they stick across bridge restarts.
function allowRules(rules) {
  const current = new Set(cfg.allowedTools || []);
  const added = rules.filter(r => r && !current.has(r));
  if (!added.length) return [];
  cfg.allowedTools = [...current, ...added];
  try {
    const onDisk = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    onDisk.allowedTools = cfg.allowedTools;
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(onDisk, null, 2) + '\n');
  } catch (e) { log('could not save config.json:', e.message); }
  return added;
}

// ---------------------------------------------------------------------------
// Running the agent
// ---------------------------------------------------------------------------

function submit(job) {
  if (alreadyHandled(job)) return;
  if (job.ctx !== undefined) setContext(job);
  if (job.forget) {
    // A deleted chat: forget it and ack. No agent run.
    markHandled(job);
    forgetChat(job);
    saveState();
    signal('ack', job.id, true);
    return;
  }
  if (job.hello) {
    // The addon announcing itself: ack, offer a restore if its data is fresh,
    // and refresh the slots so it can read our clock. No agent run.
    markHandled(job);
    saveState();
    signal('ack', job.id, true);
    maybeOfferRestore(job);
    publishNow();
    log(`hello from session ${job.session}${pendingRestore ? ' (restore offered)' : ''}`);
    return;
  }
  const key = chatKey(job);
  const cur = running.get(key);
  if (cur && cur.job.id === job.id) return;
  const q = queued.get(key);
  if (q && q.id === job.id) return;
  if (cur || running.size >= MAX_PARALLEL) {
    queued.set(key, job);
    log(`#${job.id}${job.session ? '@' + job.session : ''} queued (${cur ? 'chat busy' : running.size + ' running'})`);
    return;
  }
  runJob(job);
}

function drainQueue() {
  for (const [key, job] of queued) {
    if (running.size >= MAX_PARALLEL) break;
    if (running.has(key)) continue;
    queued.delete(key);
    runJob(job);
  }
}

async function runJob(job) {
  const key = chatKey(job);
  const cwd = resolveCwd(job.cwd);
  job.cwd = cwd;
  const tag = `#${job.id}${job.session ? '@' + job.session : ''}`;
  signal('sig', job.id, false);
  resetBeats(job.id);
  signal('ack', job.id, true);
  if (!fs.existsSync(cwd)) {
    log(`${tag} cwd does not exist: ${cwd}`);
    const sibs = siblingFolders();
    finish(job, 'error', `Folder does not exist: ${cwd}\n` +
      `Paths are relative to ${DEFAULT_CWD}.` +
      (sibs.length ? `\nFolders there: ${sibs.join(', ')}` : '') +
      `\nUse /wow-muse cd <folder> to pick one, or /wow-muse cd alone for the default.`);
    return;
  }
  const skey = sessKey(job);
  if (job.newSession) { delete state.sessions[skey]; delete state.sessions[key]; }
  // Agent CLIs keep sessions per project folder, so a session can't follow a chat
  // into another folder: start fresh there.
  const prevCwd = state.sessionCwd && state.sessionCwd[skey];
  if (prevCwd && !sameFolder(prevCwd, cwd) && state.sessions[skey]) {
    log(`${tag} folder changed (${prevCwd} -> ${cwd}): new session`);
    delete state.sessions[skey]; delete state.sessions[key];
  }
  if (Array.isArray(job.allow) && job.allow.length) {
    const added = allowRules(job.allow);
    log(`${tag} allowed: ${job.allow.join(', ')}${added.length ? '' : ' (already allowed)'}`);
  }
  maybeOfferRestore(job);
  noteMessage(job, 'user', job.text);

  // Reserve the chat slot before the (async) routing call so a second submit
  // for the same chat can't slip in while we wait.
  running.set(key, { job, child: null });

  // Provider selection: SystemOne advisory routing, then config, then explicit.
  const routed = await SystemOne.routeTask(job.text, cfg.systemone, log);
  const providerId = (routed && routed.provider) || resolveProviderId();
  const prov = Providers.get(providerId);
  if (!prov) {
    running.delete(key);
    finish(job, 'error', `Unknown provider '${providerId}'. Known: ${Providers.list().map(p => p.id).join(', ')}.`);
    return;
  }
  const model = providerModel(routed);
  const sys = P.systemPrompt(gameContext(), primer());
  const resume = (prov.supportsResume && (state.sessions[skey] || state.sessions[key])) || '';

  // HTTP providers (LM Studio, generic OpenAI-compatible) don't spawn a process.
  if (prov.kind === 'http') {
    runHttpJob(job, prov, { key, tag, cwd, model, sys });
    return;
  }

  // Some CLIs take the prompt as a file (muse CLI); write it now, delete on close.
  let promptFile = null;
  if (prov.promptVia === 'promptFile') {
    promptFile = path.join(os.tmpdir(), `wow-muse-prompt-${job.id}-${Date.now()}.txt`);
    fs.writeFileSync(promptFile, (sys ? sys + '\n\n' : '') + job.text, 'utf8');
  }

  const args = prov.buildArgs({
    text: job.text, systemPrompt: sys, resume, model,
    allowedTools: cfg.allowedTools, permissionMode: cfg.permissionMode || 'acceptEdits',
    promptFile, cwd, cfg,
  });

  const env = { ...process.env, ...(prov.extraEnv ? prov.extraEnv(cfg) : {}) };
  delete env.CLAUDECODE;

  log(`${tag} (${job.via}) [${prov.id}] starting in ${cwd}${resume ? ' (resume ' + String(resume).slice(0, 8) + ')' : ' (new session)'}${sys ? ' [game context]' : ''}${model ? ` [model ${model}]` : ''}${running.size ? ' [' + running.size + ' running]' : ''}`);
  const child = spawn(prov.command(cfg), args, { cwd, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  running.set(key, { job, child });
  publish(key, { chat: job.chat, id: job.id, status: 'working', text: resume ? 'thinking...' : 'starting a new session...', cwd, session: resume }, true);
  if (prov.promptVia === 'stdin') child.stdin.end(job.text);
  else child.stdin.end();

  const progress = [];
  let sessionId = resume || '';
  let resultText = null;
  let isError = false;
  let denied = [];
  let stderr = '';
  let buffer = '';
  let outText = '';   // outputMode 'text'
  let museText = '';  // outputMode 'jsonl-text'
  let lastChunk = '';

  const pushProgress = (line) => {
    progress.push(line);
    while (progress.length > 10) progress.shift();
    beat(job);
    publish(key, { chat: job.chat, id: job.id, status: 'working', text: progress.join('\n'), cwd, session: sessionId }, false);
  };
  // Long thinking stretches produce no tool events; keep the heartbeat alive anyway.
  const keepalive = setInterval(() => beat(job), 45000);

  // stream-json: Claude Code's event protocol (unchanged from the original bridge).
  const handleEvent = (ev) => {
    const o = Output.parseClaudeEvent(ev);
    if (o.sessionId) sessionId = o.sessionId;
    for (const line of o.progress) pushProgress(line);
    if (o.result !== null) {
      isError = o.isError;
      resultText = o.result;
      denied = o.denied;
      if (o.denials.length) {
        const list = o.denials.map(d => d.tool_name + (d.tool_input && d.tool_input.command ? ': ' + d.tool_input.command : '')).join('\n  ');
        resultText += `\n\n[bridge] ${prov.label} needed ${o.denials.length} action(s) that aren't allowed yet:\n  ${list}\nUse the Allow button below to permit them and let it continue.`;
      }
    }
  };

  // jsonl-text: the muse CLI's JSONL event stream (see output.parseMuseEvent).
  const feedJsonl = (line) => {
    let ev;
    try { ev = JSON.parse(line); } catch { return; }
    const o = Output.parseMuseEvent(ev);
    if (o.sessionId) sessionId = o.sessionId;
    if (o.result !== null) { resultText = o.result; return; }
    if (o.text && o.text !== lastChunk) {
      lastChunk = o.text;
      museText += o.text;
      const snippet = o.text.replace(/\s+/g, ' ');
      pushProgress(snippet.length > 140 ? snippet.slice(0, 140) + '...' : snippet);
    }
  };

  // text: plain stdout accumulation (grok-local, zcode, harness).
  const feedText = (line) => {
    outText += line + '\n';
    if (line) pushProgress(line.length > 140 ? line.slice(0, 140) + '...' : line);
  };

  const feedLine = prov.outputMode === 'stream-json'
    ? (line) => { try { handleEvent(JSON.parse(line)); } catch {} }
    : prov.outputMode === 'jsonl-text' ? feedJsonl : feedText;

  child.stdout.on('data', (chunk) => {
    buffer += chunk.toString('utf8');
    let nl;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      feedLine(line);
    }
  });
  child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });

  const timer = setTimeout(() => {
    log(`${tag} timed out after ${cfg.timeoutMs} ms, killing`);
    child.kill();
  }, cfg.timeoutMs || 1800000);

  child.on('error', (err) => {
    clearTimeout(timer);
    clearInterval(keepalive);
    if (promptFile) { try { fs.unlinkSync(promptFile); } catch {} }
    finish(job, 'error', `Could not start ${prov.label} (${prov.command(cfg)}): ${err.message}\nSet provider.path in config.json.`);
  });

  child.on('close', (code) => {
    clearTimeout(timer);
    clearInterval(keepalive);
    if (promptFile) { try { fs.unlinkSync(promptFile); } catch {} }
    if (buffer.trim()) feedLine(buffer.trim());
    if (prov.outputMode === 'text' && resultText === null) resultText = outText.trim() || null;
    if (prov.outputMode === 'jsonl-text' && resultText === null) resultText = museText.trim() || null;
    if (sessionId && prov.supportsResume) { state.sessions[skey] = sessionId; (state.sessionCwd = state.sessionCwd || {})[skey] = cwd; }
    if (resultText !== null && !isError) finish(job, 'done', resultText, sessionId, denied);
    else if (resultText !== null) finish(job, 'error', resultText, sessionId, denied);
    else finish(job, 'error', `${prov.label} exited with code ${code} and no result.\n${stderr.trim().slice(-1500)}`, sessionId);
  });
}

// HTTP providers: POST /v1/chat/completions (OpenAI-compatible). Used by the
// lmstudio preset and any configured openai-compat endpoint. No sessions.
function runHttpJob(job, prov, ctx) {
  const { key, tag, cwd, model, sys } = ctx;
  const ep = prov.endpoint(cfg);
  if (!ep.baseUrl) {
    running.delete(key);
    finish(job, 'error', `HTTP provider '${prov.id}' needs provider.http.baseUrl in config.json.`);
    return;
  }
  if (!ep.model) {
    running.delete(key);
    finish(job, 'error', `HTTP provider '${prov.id}' needs a model: set provider.model or provider.http.model in config.json (no model IDs are built in).`);
    return;
  }
  const base = String(ep.baseUrl).replace(/\/+$/, '');
  const url = new URL(base + '/v1/chat/completions');
  const httpMod = url.protocol === 'https:' ? require('https') : require('http');
  const body = Buffer.from(JSON.stringify({
    model: ep.model,
    messages: [...(sys ? [{ role: 'system', content: sys }] : []),
      { role: 'user', content: job.text }],
    stream: false,
  }), 'utf8');
  log(`${tag} (${job.via}) [${prov.id}] POST ${base} model=${ep.model}`);
  publish(key, { chat: job.chat, id: job.id, status: 'working', text: 'thinking...', cwd, session: '' }, true);
  const beatTimer = setInterval(() => beat(job), 45000);
  const timeoutMs = ep.timeoutMs || 120000;
  const req = httpMod.request(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': body.length,
      ...(ep.apiKey ? { Authorization: 'Bearer ' + ep.apiKey } : {}),
    },
  }, res => {
    let raw = '';
    res.setEncoding('utf8');
    res.on('data', c => { raw += c; });
    res.on('end', () => {
      clearInterval(beatTimer);
      running.delete(key);
      if (res.statusCode < 200 || res.statusCode >= 300) {
        finish(job, 'error', `${prov.label} HTTP ${res.statusCode}: ${raw.slice(0, 1500)}`);
        return;
      }
      try {
        const data = JSON.parse(raw);
        const content = data.choices && data.choices[0] && data.choices[0].message
          && data.choices[0].message.content;
        if (typeof content === 'string' && content.trim()) finish(job, 'done', content, '', []);
        else finish(job, 'error', `${prov.label}: empty reply.\n${raw.slice(0, 1500)}`, '');
      } catch (e) {
        finish(job, 'error', `${prov.label}: bad JSON (${e.message}).\n${raw.slice(0, 1500)}`, '');
      }
    });
  });
  req.on('error', e => {
    clearInterval(beatTimer);
    running.delete(key);
    finish(job, 'error', `${prov.label}: request failed (${e.message}). Is the endpoint up at ${base}?`, '');
  });
  req.setTimeout(timeoutMs, () => req.destroy(new Error('timeout')));
  req.end(body);
}

function finish(job, status, text, session, denied) {
  if (job.finished) return; // spawn failures fire both 'error' and 'close'
  job.finished = true;
  running.delete(chatKey(job));
  markHandled(job);
  saveState();
  noteMessage(job, status === 'done' ? 'muse' : 'system', status === 'done' ? text : 'Bridge error: ' + text);
  publish(chatKey(job), { chat: job.chat, id: job.id, status, text, cwd: job.cwd, session, denied }, true);
  signal('sig', job.id, true);
  log(`#${job.id}${job.session ? '@' + job.session : ''} ${status} (${text.length} chars)`);
  drainQueue();
  if (exitWhenIdle && running.size === 0) process.exit(status === 'done' ? 0 : 1);
}

// ---------------------------------------------------------------------------
// Input loops
// ---------------------------------------------------------------------------

function pollSavedVariables() {
  let st;
  try { st = fs.statSync(cfg.savedVariablesFile); } catch { return; }
  if (st.mtimeMs === lastMtime) return;
  lastMtime = st.mtimeMs;
  const job = readOutbox();
  if (job) submit(job);
}

function startCapture() {
  const script = path.join(HERE, 'capture.ps1');
  const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script,
    '-Cell', String(cap.cellPx), '-Cells', String(cap.cellsPerRow), '-MaxRows', String(cap.maxRows),
    '-IntervalMs', String(cap.intervalMs), '-ProcessName', cap.processName];
  const ps = spawn('powershell.exe', args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const rl = readline.createInterface({ input: ps.stdout });
  rl.on('line', (line) => {
    let ev;
    try { ev = JSON.parse(line); } catch { return; }
    if (ev.info) { log('capture:', ev.info); return; }
    if (ev.warn) { log('capture:', ev.warn); return; }
    if (ev.error) { log('capture error:', ev.error); return; }
    if (typeof ev.id === 'number') {
      const jobs = jobsFromStrip(ev.id, ev.text);
      log(`strip #${ev.id}: ${jobs.length} message(s)`);
      for (const job of jobs) submit(job);
    }
  });
  ps.stderr.on('data', (d) => log('capture stderr:', String(d).trim().slice(0, 300)));
  ps.on('close', (code) => {
    log(`capture exited (${code}); restarting in 5 s`);
    setTimeout(startCapture, 5000);
  });
}

function banner() {
  console.log('WoW Muse bridge');
  console.log(`  folder   : ${DEFAULT_CWD}  (${DEFAULT_CWD_SOURCE}; chats can override with /wow-muse cd)`);
  console.log(`  addons   : ${cfg.addonDir}`);
  console.log(`  addon    : ${addonInstalled() ? 'installed' : 'NOT INSTALLED - run: node setup.js, then restart WoW'}`);
  console.log(`  slots    : ${slotsInstalled() ? SLOTS + ' installed' : 'NOT INSTALLED - run: node setup.js (or node bridge/install-slots.js), then restart WoW'}`);
  console.log(`  capture  : ${cap.enabled ? 'on (' + cap.processName + ', ' + cap.cellsPerRow + 'x' + cap.maxRows + ' cells of ' + cap.cellPx + 'px)' : 'off'}`);
  console.log(`  parallel : up to ${MAX_PARALLEL} chats at once`);
  console.log(`  fallback : ${cfg.savedVariablesFile}`);
  console.log(`  provider : ${resolveProviderId()}${providerModel(null) ? ' (' + providerModel(null) + ')' : ''}`);
  console.log(`  mode     : ${cfg.permissionMode}, ${(cfg.allowedTools || []).length} allowed tool rules`);
  console.log(`  sessions : ${Object.keys(state.sessions).length} saved`);
  const ctx = gameContext();
  console.log(`  context  : ${cfg.gameContext === false ? 'off (gameContext in config.json)' : ctx ? (ctx.split('\n').find(l => /^Character:/i.test(l)) || ctx.split('\n')[0]).slice(0, 100) : 'none yet (the addon sends it with its hello; /wow-muse context in game)'}`);
  console.log(`  primer   : ${!PRIMER_FILE ? 'off (primerFile in config.json)' : primer() ? path.resolve(REPO, PRIMER_FILE) + ' (' + primer().length + ' chars, with the context)' : 'NOT FOUND: ' + path.resolve(REPO, PRIMER_FILE)}`);
  console.log('Leave this window open while you play. Ctrl+C to stop.\n');
}

banner();
if (inject !== null) {
  submit({ id: state.lastId + 1, session: '', chat: '', text: inject, cwd: '', newSession: false, via: 'inject' });
} else {
  pollSavedVariables();
  if (once) {
    if (running.size === 0) { console.log('nothing pending'); process.exit(0); }
  } else {
    setInterval(pollSavedVariables, cfg.pollMs || 750);
    presenceBeat();
    setInterval(presenceBeat, cfg.presenceIntervalMs || 30000);
    if (cap.enabled) startCapture();
  }
}
