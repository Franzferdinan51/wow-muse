// Unit tests for the WoW-Muse provider registry (bridge/providers.js),
// the pure output parsers (bridge/output.js), and the advisory SystemOne
// routing (bridge/systemone.js).
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');

const Providers = require('../bridge/providers');
const Output = require('../bridge/output');
const SystemOne = require('../bridge/systemone');

// ---------------------------------------------------------------- registry

test('registry lists all fifteen backends', () => {
  const ids = Providers.list().map(p => p.id).sort();
  assert.deepEqual(ids, ['claude', 'codex', 'gemini', 'grok', 'grok-local', 'harness',
    'hermes', 'lmstudio', 'mcode', 'muse', 'muse-http', 'opencode', 'openai-compat',
    'openclaw', 'zcode'].sort());
});

test('get() returns null for unknown providers', () => {
  assert.equal(Providers.get('nope'), null);
});

test('default is muse; missing muse CLI fails loudly instead of silently switching backends', () => {
  const saved = process.env.PATH;
  process.env.PATH = '/nonexistent-dir-for-wow-muse-test';
  try {
    const r = Providers.resolveId({});
    assert.equal(r.id, 'muse');
    assert.match(r.note, /muse CLI not found/);
    assert.match(r.note, /pick another provider id/);
    // An explicit provider.path suppresses the missing-CLI note.
    const withPath = Providers.resolveId({ provider: { id: 'muse', path: 'C:\\tools\\muse.exe' } });
    assert.equal(withPath.id, 'muse');
    assert.equal(withPath.note, null);
    // Legacy claudePath keeps the claude provider with no provider block.
    const legacy = Providers.resolveId({ claudePath: '/tmp/claude' });
    assert.equal(legacy.id, 'claude');
    assert.equal(legacy.note, null);
    // Unknown ids are reported so the caller can fail loudly.
    const unknown = Providers.resolveId({ provider: { id: 'nope' } });
    assert.equal(unknown.id, 'nope');
    assert.match(unknown.note, /unknown provider/);
  } finally {
    process.env.PATH = saved;
  }
});

// ------------------------------------------------------- argument construction

test('claude provider preserves the original stream-json invocation', () => {
  const p = Providers.get('claude');
  const args = p.buildArgs({
    text: 'hi', systemPrompt: 'SYS', resume: 'sess1', model: 'm1',
    allowedTools: ['WebSearch'], permissionMode: 'acceptEdits', cfg: {},
  });
  assert.deepEqual(args, ['-p', '--output-format', 'stream-json', '--verbose',
    '--permission-mode', 'acceptEdits', '--allowedTools', 'WebSearch',
    '--model', 'm1', '--resume', 'sess1', '--append-system-prompt', 'SYS']);
  // prompt goes over stdin
  assert.equal(p.promptVia, 'stdin');
  assert.equal(p.outputMode, 'stream-json');
  assert.equal(p.supportsResume, true);
});

test('claude provider honors legacy claudePath', () => {
  const p = Providers.get('claude');
  assert.equal(p.command({ claudePath: '/tmp/claude' }), '/tmp/claude');
});

test('muse provider uses a prompt file and JSONL output', () => {
  const p = Providers.get('muse');
  assert.equal(p.promptVia, 'promptFile');
  assert.equal(p.outputMode, 'jsonl-text');
  const args = p.buildArgs({
    text: 'hi', systemPrompt: 'SYS', resume: '', model: 'mm',
    promptFile: '/tmp/p.txt', permissionMode: 'acceptEdits', cfg: {},
  });
  assert.deepEqual(args, ['exec', '--json', '--yolo', '--user-input-auto-resolve',
    '--prompt-file', '/tmp/p.txt', '--model', 'mm']);
  assert.equal(p.supportsResume, false);
});

test('grok-local provider uses -p with plain output and resume/rules', () => {
  const p = Providers.get('grok-local');
  assert.equal(p.promptVia, 'arg');
  assert.equal(p.outputMode, 'text');
  assert.equal(p.supportsResume, true);
  const args = p.buildArgs({
    text: 'hi', systemPrompt: 'SYS', resume: 'abc', model: 'x',
    allowedTools: ['Edit'], permissionMode: 'acceptEdits', cfg: {},
  });
  assert.deepEqual(args, ['-p', 'hi', '--output-format', 'plain',
    '--allow', 'Edit', '--model', 'x', '--resume', 'abc', '--rules', 'SYS']);
});

test('zcode provider maps the permission mode to a zcode mode', () => {
  const p = Providers.get('zcode');
  assert.equal(p.outputMode, 'text');
  assert.equal(p.supportsResume, true);
  assert.equal(Providers.zcodeMode('plan'), 'plan');
  assert.equal(Providers.zcodeMode('bypassPermissions'), 'yolo');
  assert.equal(Providers.zcodeMode('acceptEdits'), 'edit');
  assert.equal(Providers.zcodeMode('whatever'), 'build');
  const args = p.buildArgs({
    text: 'hi', systemPrompt: '', resume: '', model: '',
    allowedTools: [], permissionMode: 'plan', cfg: {},
  });
  assert.deepEqual(args, ['-p', 'hi', '--mode', 'plan']);
});

test('harness provider runs one-shot with --print', () => {
  const p = Providers.get('harness');
  assert.equal(p.outputMode, 'text');
  assert.equal(p.supportsResume, false);
  const args = p.buildArgs({
    text: 'hi', systemPrompt: '', resume: '', model: 'hm',
    allowedTools: [], permissionMode: 'acceptEdits',
    cfg: { provider: { harnessProvider: 'hp' } },
  });
  assert.deepEqual(args, ['run', 'hi', '--print', '--provider', 'hp', '--model', 'hm']);
});

test('grok provider uses the official Grok Build CLI headless flags', () => {
  const p = Providers.get('grok');
  assert.equal(p.promptVia, 'arg');
  assert.equal(p.outputMode, 'text');
  assert.equal(p.supportsResume, true);
  const args = p.buildArgs({
    text: 'hi', systemPrompt: 'SYS', resume: 'abc', model: '',
    allowedTools: ['Edit'], permissionMode: 'acceptEdits', cwd: '/w', cfg: {},
  });
  assert.deepEqual(args, ['-p', 'hi', '--output-format', 'plain',
    '--allow', 'Edit', '-r', 'abc', '--rules', 'SYS', '--cwd', '/w']);
  // no model flag is passed (this build has no --model)
  const bare = p.buildArgs({ text: 'hi', cfg: {} });
  assert.deepEqual(bare, ['-p', 'hi', '--output-format', 'plain']);
});

test('hermes provider uses -z one-shot with optional --resume', () => {
  const p = Providers.get('hermes');
  assert.equal(p.promptVia, 'arg');
  assert.equal(p.outputMode, 'text');
  assert.equal(p.supportsResume, true);
  assert.equal(p.usageFileFlag, '--usage-file');
  assert.equal(p.parseUsageReport({ session_id: 'h1' }).sessionId, 'h1');
  assert.equal(p.parseUsageReport({}).sessionId, null);
  assert.deepEqual(p.buildArgs({ text: 'hi', resume: 'h1', cfg: {} }),
    ['--resume', 'h1', '-z', 'hi']);
  assert.deepEqual(p.buildArgs({ text: 'hi', cfg: {} }), ['-z', 'hi']);
});

test('openclaw provider uses agent --local -m with optional session/model', () => {
  const p = Providers.get('openclaw');
  assert.equal(p.promptVia, 'arg');
  assert.equal(p.outputMode, 'text');
  assert.equal(p.supportsResume, true);
  assert.deepEqual(p.buildArgs({ text: 'hi', resume: 's1', model: 'mm', cfg: {} }),
    ['agent', '--local', '-m', 'hi', '--session-id', 's1', '--model', 'mm']);
  assert.deepEqual(p.buildArgs({ text: 'hi', cfg: {} }),
    ['agent', '--local', '-m', 'hi']);
});

test('codex provider uses exec --json, resume via exec resume', () => {
  const p = Providers.get('codex');
  assert.equal(p.promptVia, 'arg');
  assert.equal(p.outputMode, 'codex-json');
  assert.equal(p.supportsResume, true);
  assert.deepEqual(p.buildArgs({ text: 'hi', cfg: {} }), ['exec', '--json', 'hi']);
  assert.deepEqual(p.buildArgs({ text: 'hi', resume: 't1', cfg: {} }),
    ['exec', 'resume', '--json', 't1', 'hi']);
});

test('gemini provider uses stream-json and does not resume', () => {
  const p = Providers.get('gemini');
  assert.equal(p.promptVia, 'arg');
  assert.equal(p.outputMode, 'gemini-json');
  assert.equal(p.supportsResume, false);
  assert.deepEqual(p.buildArgs({ text: 'hi', cfg: {} }),
    ['--output-format', 'stream-json', '-p', 'hi']);
});

test('opencode provider uses run --format json with optional session/model', () => {
  const p = Providers.get('opencode');
  assert.equal(p.promptVia, 'arg');
  assert.equal(p.outputMode, 'opencode-json');
  assert.equal(p.supportsResume, true);
  assert.deepEqual(p.buildArgs({ text: 'hi', resume: 's1', model: 'mm', cfg: {} }),
    ['run', '--session', 's1', '--model', 'mm', '--format', 'json', 'hi']);
  assert.deepEqual(p.buildArgs({ text: 'hi', cfg: {} }),
    ['run', '--format', 'json', 'hi']);
});

test('mcode provider uses exec --output-format stream-json with optional session', () => {
  const p = Providers.get('mcode');
  assert.equal(p.promptVia, 'arg');
  assert.equal(p.outputMode, 'mcode-json');
  assert.equal(p.supportsResume, true);
  assert.deepEqual(p.buildArgs({ text: 'hi', resume: 's1', cfg: {} }),
    ['exec', '--session', 's1', '--output-format', 'stream-json', 'hi']);
  assert.deepEqual(p.buildArgs({ text: 'hi', cfg: {} }),
    ['exec', '--output-format', 'stream-json', 'hi']);
});

test('no provider hard-codes a model id', () => {
  for (const p of Providers.list()) {
    const full = Providers.get(p.id);
    if (full.kind === 'http') {
      assert.equal(full.endpoint({}).model, '', `${p.id} endpoint has a built-in model`);
      continue;
    }
    const args = full.buildArgs({
      text: 'hi', systemPrompt: '', resume: '', model: '',
      allowedTools: [], permissionMode: 'acceptEdits', promptFile: '/tmp/p.txt', cfg: {},
    });
    assert.ok(!args.includes('--model'), `${p.id} injects --model without config`);
  }
});

test('lmstudio preset points at the local server', () => {
  const ep = Providers.get('lmstudio').endpoint({});
  assert.equal(ep.baseUrl, 'http://127.0.0.1:1234');
});

test('openai-compat endpoint comes from config', () => {
  const ep = Providers.get('openai-compat').endpoint({
    provider: { http: { baseUrl: 'https://example.com', apiKey: 'k', model: 'm', timeoutMs: 5000 } },
  });
  assert.deepEqual(ep, { baseUrl: 'https://example.com', apiKey: 'k', model: 'm', timeoutMs: 5000 });
});

// ------------------------------------------------------------ output parsers

test('parseClaudeEvent: assistant text and tool_use become progress', () => {
  const o = Output.parseClaudeEvent({
    type: 'assistant',
    message: { content: [
      { type: 'text', text: '  hello   world  ' },
      { type: 'tool_use', name: 'Bash', input: { command: 'ls' } },
    ] },
  });
  assert.equal(o.result, null);
  assert.equal(o.progress.length, 2);
  assert.equal(o.progress[0], 'hello world');
  assert.match(o.progress[1], /\$ ls/);
});

test('parseClaudeEvent: result with permission denials', () => {
  const o = Output.parseClaudeEvent({
    type: 'result', is_error: false, result: 'done',
    session_id: 's1',
    permission_denials: [{ tool_name: 'Bash', tool_input: { command: 'rm -rf /' } }],
  });
  assert.equal(o.sessionId, 's1');
  assert.equal(o.result, 'done');
  assert.equal(o.isError, false);
  assert.equal(o.denied.length, 1);
  assert.equal(o.denials.length, 1);
});

test('parseClaudeEvent: ignores junk', () => {
  assert.deepEqual(Output.parseClaudeEvent(null).progress, []);
  assert.equal(Output.parseClaudeEvent({ type: 'ping' }).result, null);
});

test('parseMuseEvent: extracts text defensively', () => {
  const o = Output.parseMuseEvent({
    type: 'message', session_id: 'm1',
    message: { content: [{ type: 'text', text: 'hello' }] },
    delta: ' world',
  });
  assert.equal(o.sessionId, 'm1');
  assert.equal(o.text, 'hello world');
  assert.equal(o.result, null);
});

test('parseMuseEvent: string result is the final answer', () => {
  const o = Output.parseMuseEvent({ result: 'final answer' });
  assert.equal(o.result, 'final answer');
});

test('parseMuseEvent: ignores junk', () => {
  assert.equal(Output.parseMuseEvent(null).text, '');
  assert.equal(Output.parseMuseEvent('nope').result, null);
});

// -------------------------------------- headless harness JSONL parsers

test('codex parser: session, text, progress, terminal', () => {
  const push = Output.createCodexParser();
  let o = push({ type: 'thread.started', thread_id: 't-1' });
  assert.equal(o.sessionId, 't-1');
  assert.equal(o.text, '');
  o = push({ type: 'item.completed', item: { type: 'agent_message', text: 'hello' } });
  assert.equal(o.text, 'hello');
  assert.equal(o.done, false);
  o = push({ type: 'item.completed', item: { type: 'command_execution', command: 'ls', status: 'success' } });
  assert.deepEqual(o.progress, ['ran: ls']);
  o = push({ type: 'turn.completed' });
  assert.equal(o.done, true);
  assert.equal(o.result, null);
  assert.equal(o.isError, false);
});

test('codex parser: failed turn is a fatal error', () => {
  const push = Output.createCodexParser();
  const o = push({ type: 'turn.failed', message: 'boom' });
  assert.equal(o.done, true);
  assert.equal(o.isError, true);
  assert.equal(o.result, 'boom');
});

test('codex parser: ignores junk', () => {
  const push = Output.createCodexParser();
  assert.deepEqual(push(null).progress, []);
  assert.deepEqual(push('nope').progress, []);
  assert.deepEqual(push({ type: 'turn.started' }).progress, []);
});

test('gemini parser: init session, assistant text, result terminal', () => {
  const push = Output.createGeminiParser();
  let o = push({ type: 'init', session_id: 'g-1' });
  assert.equal(o.sessionId, 'g-1');
  o = push({ type: 'message', role: 'assistant', content: 'hi there' });
  assert.equal(o.text, 'hi there');
  o = push({ type: 'tool_use', tool_name: 'read' });
  assert.deepEqual(o.progress, ['tool: read']);
  o = push({ type: 'error', severity: 'warning', message: 'slow' });
  assert.equal(o.done, false); // warnings are non-fatal
  assert.ok(o.progress[0].includes('warning'));
  o = push({ type: 'result', status: 'success', stats: { input_tokens: 3, output_tokens: 4 } });
  assert.equal(o.done, true);
  assert.equal(o.isError, false);
  assert.equal(o.result, null);
});

test('gemini parser: error result is fatal', () => {
  const push = Output.createGeminiParser();
  const o = push({ type: 'result', status: 'error', error: { message: 'quota' } });
  assert.equal(o.done, true);
  assert.equal(o.isError, true);
  assert.equal(o.result, 'quota');
});

test('opencode parser: session, text, tool, error', () => {
  const push = Output.createOpencodeParser();
  let o = push({ type: 'step_start', sessionID: 'o-1', timestamp: 1 });
  assert.equal(o.sessionId, 'o-1');
  o = push({ type: 'text', sessionID: 'o-1', part: { text: 'part one' } });
  assert.equal(o.text, 'part one');
  assert.equal(o.done, false); // no terminal marker; process exit ends the run
  o = push({ type: 'tool_use', sessionID: 'o-1', part: { tool: 'bash' } });
  assert.deepEqual(o.progress, ['tool: bash']);
  o = push({ type: 'error', sessionID: 'o-1', error: { message: 'bad' } });
  assert.equal(o.done, true);
  assert.equal(o.isError, true);
  assert.equal(o.result, 'bad');
});

test('mcode parser: deltas stream, completed dedups, terminal', () => {
  const push = Output.createMcodeParser();
  let o = push({ type: 'session.started', sessionId: 'm-1' });
  assert.equal(o.sessionId, 'm-1');
  o = push({ type: 'item.updated', item: { id: 'i1', type: 'agent_message', contentDelta: 'hel' } });
  assert.equal(o.text, 'hel');
  o = push({ type: 'item.updated', item: { id: 'i1', type: 'agent_message', contentDelta: 'lo' } });
  assert.equal(o.text, 'lo');
  // item.completed repeats the streamed text: only the unseen suffix is emitted
  o = push({ type: 'item.completed', item: { id: 'i1', type: 'agent_message', content: 'hello!' } });
  assert.equal(o.text, '!');
  o = push({ type: 'exec.completed', result: { status: 'succeeded', output: 'hello! and more' } });
  assert.equal(o.done, true);
  assert.equal(o.isError, false);
  assert.equal(o.text, ' and more'); // unseen suffix beyond streamed text
});

test('mcode parser: failed turn is fatal', () => {
  const push = Output.createMcodeParser();
  const o = push({ type: 'turn.failed', error: { message: 'crashed' } });
  assert.equal(o.done, true);
  assert.equal(o.isError, true);
  assert.equal(o.result, 'crashed');
});

test('mcode parser: failed exec result is fatal', () => {
  const push = Output.createMcodeParser();
  const o = push({ type: 'exec.completed', result: { status: 'failed', error: { message: 'rc=1' } } });
  assert.equal(o.done, true);
  assert.equal(o.isError, true);
  assert.equal(o.result, 'rc=1');
});

// ------------------------------------------------------- systemone routing

function startRouter(handler) {
  const srv = http.createServer(handler);
  return new Promise(resolve => srv.listen(0, '127.0.0.1', () => resolve(srv)));
}

test('systemone: tier maps to provider/model', async () => {
  const srv = await startRouter((req, res) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      assert.match(body, /"task"/);
      res.end(JSON.stringify({ route: { tier: 'economy', model_id: 'whatever', confidence: 0.9 } }));
    });
  });
  try {
    const r = await SystemOne.routeTask('sort this', {
      enabled: true, host: '127.0.0.1', port: srv.address().port, timeoutMs: 2000,
      tierMap: { economy: { provider: 'lmstudio', model: 'test-model' } },
    }, () => {});
    assert.deepEqual(r, { provider: 'lmstudio', model: 'test-model' });
  } finally { srv.close(); }
});

test('systemone: disabled router returns null without a request', async () => {
  const r = await SystemOne.routeTask('x', { enabled: false }, () => { throw new Error('should not log'); });
  assert.equal(r, null);
});

test('systemone: unmapped tier returns null', async () => {
  const srv = await startRouter((req, res) => res.end(JSON.stringify({ route: { tier: 'ultra' } })));
  const logged = [];
  try {
    const r = await SystemOne.routeTask('x', {
      enabled: true, host: '127.0.0.1', port: srv.address().port, timeoutMs: 2000, tierMap: {},
    }, m => logged.push(m));
    assert.equal(r, null);
    assert.ok(logged.some(m => /no tierMap entry/.test(m)));
  } finally { srv.close(); }
});

test('systemone: http 500 is fail-open', async () => {
  const srv = await startRouter((req, res) => { res.statusCode = 500; res.end('boom'); });
  const logged = [];
  try {
    const r = await SystemOne.routeTask('x', {
      enabled: true, host: '127.0.0.1', port: srv.address().port, timeoutMs: 2000, tierMap: {},
    }, m => logged.push(m));
    assert.equal(r, null);
    assert.ok(logged.some(m => /unavailable/.test(m)));
  } finally { srv.close(); }
});

test('systemone: timeout is fail-open', async () => {
  const srv = await startRouter(() => { /* never responds */ });
  try {
    const r = await SystemOne.routeTask('x', {
      enabled: true, host: '127.0.0.1', port: srv.address().port, timeoutMs: 200, tierMap: {},
    }, () => {});
    assert.equal(r, null);
  } finally { srv.close(); }
});

test('systemone: connection refused is fail-open', async () => {
  const r = await SystemOne.routeTask('x', {
    enabled: true, host: '127.0.0.1', port: 1, timeoutMs: 1000, tierMap: {},
  }, () => {});
  assert.equal(r, null);
});

test('systemone: never asks the router to load or switch models', async () => {
  const seen = [];
  const srv = await startRouter((req, res) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => { seen.push(body); res.end(JSON.stringify({ route: { tier: 'economy' } })); });
  });
  try {
    await SystemOne.routeTask('x', {
      enabled: true, host: '127.0.0.1', port: srv.address().port, timeoutMs: 2000,
      tierMap: { economy: { provider: 'lmstudio' } },
    }, () => {});
    assert.equal(seen.length, 1);
    assert.ok(!/load|switch|unload|evict/i.test(seen[0]), 'router request must not mention model management');
    assert.match(seen[0], /"task":"x"/);
  } finally { srv.close(); }
});
