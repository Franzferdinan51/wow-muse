'use strict';
// Provider registry for the WoW-Muse bridge.
//
// A provider describes how to run one chat turn against an agent backend:
// which executable (or HTTP endpoint) to call, how the prompt is delivered,
// which argv to build, whether sessions can resume, and how to read the result.
//
// Built-in providers:
//   muse           Meta's Muse Code CLI (`muse exec --json --yolo --prompt-file ...`)
//   grok-local     Grok CLI (`grok-local -p <prompt> ...`)
//   zcode          ZCode local CLI (`zcode -p <prompt> --mode ...`)
//   harness        Custom-Code-Harness `ch` CLI (`ch run --print <prompt>`)
//   claude         Anthropic's Claude Code CLI (the original backend)
//   lmstudio       Local LM Studio, OpenAI-compatible HTTP preset (127.0.0.1:1234)
//   openai-compat  Any OpenAI-compatible HTTP endpoint (baseUrl/apiKey/model from config)
//
// No model IDs are hard-coded here: models always come from the router's
// decision, the registry/config, or explicit user config, in that order.

const fs = require('fs');
const os = require('os');
const path = require('path');

function homeBin() {
  return path.join(os.homedir(), '.local', 'bin');
}

// Scan PATH (plus extra dirs) for an executable, honoring PATHEXT on Windows.
function findBinary(name, extraDirs) {
  const dirs = [];
  if (Array.isArray(extraDirs)) dirs.push(...extraDirs);
  try { dirs.push(...String(process.env.PATH || '').split(path.delimiter)); } catch {}
  const exts = process.platform === 'win32' && process.env.PATHEXT
    ? process.env.PATHEXT.split(';').map(e => e.toLowerCase())
    : [''];
  const seen = new Set();
  for (const d of dirs) {
    if (!d || seen.has(d)) continue;
    seen.add(d);
    for (const ext of new Set(['', ...exts])) {
      const p = path.join(d, name + ext);
      try { if (fs.statSync(p).isFile()) return p; } catch {}
    }
  }
  return null;
}

function localBinFind(name) {
  return findBinary(name, [homeBin()]);
}

// Map the bridge's permission-mode vocabulary onto zcode's --mode flag.
function zcodeMode(permissionMode) {
  switch (permissionMode) {
    case 'acceptEdits': return 'edit';
    case 'bypassPermissions': return 'yolo';
    case 'plan': return 'plan';
    default: return 'build';
  }
}

// Shared endpoint reader for the generic HTTP providers: everything comes
// from provider.http in config; nothing is assumed.
function httpEndpoint(cfg) {
  const p = (cfg && cfg.provider) || {};
  const h = p.http || {};
  return {
    baseUrl: h.baseUrl || '',
    apiKey: h.apiKey || '',
    model: h.model || p.model || cfg.model || '',
    timeoutMs: h.timeoutMs || 120000,
  };
}

const PROVIDERS = {
  muse: {
    id: 'muse',
    label: "Meta Muse",
    kind: 'cli',
    promptVia: 'promptFile', // bridge writes the prompt to a temp file; see buildArgs
    supportsResume: false, // no documented headless resume flag; each turn starts fresh
    outputMode: 'jsonl-text',
    command: cfg => (cfg.provider && cfg.provider.path) || localBinFind('muse') || 'muse',
    buildArgs: ({ model, promptFile }) => {
      const args = ['exec', '--json', '--yolo', '--user-input-auto-resolve', '--prompt-file', promptFile];
      if (model) args.push('--model', model);
      return args;
    },
    // Keep the launcher from swapping its own binary mid-run.
    extraEnv: () => ({ MUSE_NO_AUTO_UPDATE: '1' }),
  },

  'grok-local': {
    id: 'grok-local',
    label: 'grok-local',
    kind: 'cli',
    promptVia: 'arg',
    supportsResume: true,
    outputMode: 'text',
    command: cfg => (cfg.provider && cfg.provider.path) || localBinFind('grok-local') || 'grok-local',
    buildArgs: ({ text, systemPrompt, resume, model, allowedTools }) => {
      const args = ['-p', text, '--output-format', 'plain'];
      for (const r of allowedTools || []) args.push('--allow', r);
      if (model) args.push('--model', model);
      if (resume) args.push('--resume', resume);
      if (systemPrompt) args.push('--rules', systemPrompt);
      return args;
    },
  },

  zcode: {
    id: 'zcode',
    label: 'ZCode',
    kind: 'cli',
    promptVia: 'arg',
    supportsResume: true, // --resume <sess_...> ; best-effort across versions
    outputMode: 'text',
    command: cfg => (cfg.provider && cfg.provider.path)
      || localBinFind('zcode-local') || localBinFind('zcode') || 'zcode',
    buildArgs: ({ text, resume, permissionMode }) => {
      // zcode takes --disallowed-tools, not an allowlist, so allowedTools do not
      // translate; tool policy stays in zcode's own settings. Model selection
      // likewise stays in zcode's config (no --model passed here).
      const args = ['-p', text, '--mode', zcodeMode(permissionMode)];
      if (resume) args.push('--resume', resume);
      return args;
    },
  },

  harness: {
    id: 'harness',
    label: 'Custom-Code-Harness (ch)',
    kind: 'cli',
    promptVia: 'arg',
    supportsResume: false, // `ch run` is one-shot; no session resume on this path
    outputMode: 'text',
    command: cfg => (cfg.provider && cfg.provider.path) || localBinFind('ch') || 'ch',
    buildArgs: ({ text, model, cwd, cfg }) => {
      const args = ['run', text, '--print'];
      if (cwd) args.push('--cwd', cwd);
      const hp = cfg.provider && cfg.provider.harnessProvider;
      if (hp) args.push('--provider', hp);
      if (model) args.push('--model', model);
      return args;
    },
  },

  claude: {
    id: 'claude',
    label: 'Claude Code',
    kind: 'cli',
    promptVia: 'stdin',
    supportsResume: true,
    outputMode: 'stream-json',
    command: cfg => (cfg.provider && cfg.provider.path) || cfg.claudePath /* legacy */
      || localBinFind('claude') || 'claude',
    buildArgs: ({ systemPrompt, resume, model, allowedTools, permissionMode }) => {
      const args = ['-p', '--output-format', 'stream-json', '--verbose',
        '--permission-mode', permissionMode || 'acceptEdits'];
      if (Array.isArray(allowedTools) && allowedTools.length) args.push('--allowedTools', ...allowedTools);
      if (model) args.push('--model', model);
      if (resume) args.push('--resume', resume);
      if (systemPrompt) args.push('--append-system-prompt', systemPrompt);
      return args;
    },
  },

  lmstudio: {
    id: 'lmstudio',
    label: 'LM Studio (local)',
    kind: 'http',
    supportsResume: false,
    endpoint: cfg => ({
      baseUrl: 'http://127.0.0.1:1234',
      apiKey: '',
      model: (cfg.provider && cfg.provider.model) || cfg.model || '',
    }),
  },

  'muse-http': {
    id: 'muse-http',
    label: 'Meta Muse (HTTP)',
    kind: 'http',
    promptVia: 'http', // POST /v1/chat/completions; bridge.runHttpJob handles it
    supportsResume: false,
    outputMode: 'http',
    // A Muse-compatible OpenAI endpoint, supplied entirely by config
    // (provider.http.baseUrl / apiKey / model). No endpoint URL is assumed.
    endpoint: cfg => httpEndpoint(cfg),
  },

  'openai-compat': {
    id: 'openai-compat',
    label: 'OpenAI-compatible HTTP',
    kind: 'http',
    promptVia: 'http',
    supportsResume: false,
    outputMode: 'http',
    endpoint: cfg => httpEndpoint(cfg),
  },
};

function get(id) {
  return PROVIDERS[id] || null;
}

function list() {
  return Object.values(PROVIDERS).map(p => ({ id: p.id, label: p.label, kind: p.kind }));
}

// Resolve the effective provider id from config.
// Default is 'muse'; a legacy claudePath with no provider block keeps the old
// 'claude' behavior. When nothing was configured explicitly and the muse CLI
// can't be found, fall back to 'claude' with a note (old installs keep working).
// An explicit or routed choice is honored as-is; unknown ids return the id with
// a note so the caller can fail loudly.
function resolveId(cfg) {
  cfg = cfg || {};
  const p = cfg.provider || {};
  const explicit = !!p.id;
  const id = p.id || (cfg.claudePath ? 'claude' : 'muse');
  if (!PROVIDERS[id]) return { id, note: `unknown provider '${id}'` };
  if (id === 'muse' && !explicit && !p.path && !localBinFind('muse')) {
    return { id: 'claude', note: 'muse CLI not found; falling back to claude (set provider.path or install the muse CLI)' };
  }
  return { id, note: null };
}

module.exports = { get, list, resolveId, findBinary, zcodeMode };
