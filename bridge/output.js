'use strict';
// Pure output parsers for the agent backends (see bridge/providers.js).
// Side-effect free so tests can exercise them directly; bridge.js wires them
// into the live run loop.

const { ruleFor, describeToolUse } = require('./protocol');

// Claude Code stream-json event -> normalized outcome. Always returns an
// object; empty fields mean "nothing interesting in this event".
//   { sessionId, progress[], result, isError, denied[], denials[] }
function parseClaudeEvent(ev) {
  const out = { sessionId: null, progress: [], result: null, isError: false, denied: [], denials: [] };
  if (!ev || typeof ev !== 'object') return out;
  if (ev.session_id) out.sessionId = ev.session_id;
  if (ev.type === 'assistant' && ev.message && Array.isArray(ev.message.content)) {
    for (const block of ev.message.content) {
      if (block.type === 'tool_use') out.progress.push(describeToolUse(block));
      else if (block.type === 'text' && block.text && block.text.trim()) {
        const s = block.text.trim().replace(/\s+/g, ' ');
        out.progress.push(s.length > 140 ? s.slice(0, 140) + '...' : s);
      }
    }
  } else if (ev.type === 'result') {
    out.isError = !!ev.is_error;
    out.result = typeof ev.result === 'string' ? ev.result : JSON.stringify(ev.result ?? '', null, 2);
    const denials = Array.isArray(ev.permission_denials) ? ev.permission_denials : [];
    out.denials = denials;
    out.denied = [...new Set(denials.map(ruleFor))];
  }
  return out;
}

// Muse CLI JSONL event -> { sessionId, result, text }. The exact schema is
// versioned, so text is extracted defensively: any string-valued text/delta
// field, best-effort. A string `result` field is the final answer.
function parseMuseEvent(ev) {
  const out = { sessionId: null, result: null, text: '' };
  if (!ev || typeof ev !== 'object') return out;
  if (ev.session_id) out.sessionId = ev.session_id;
  if (typeof ev.result === 'string' && ev.result) { out.result = ev.result; return out; }
  const texts = [];
  const walk = (v) => {
    if (Array.isArray(v)) { v.forEach(walk); return; }
    if (v && typeof v === 'object') {
      for (const [k, val] of Object.entries(v)) {
        if ((k === 'text' || k === 'delta') && typeof val === 'string' && val) texts.push(val);
        else walk(val);
      }
    }
  };
  walk(ev);
  out.text = texts.join('');
  return out;
}

module.exports = { parseClaudeEvent, parseMuseEvent };

// ---------------------------------------------------------------------------
// Headless harness JSONL parsers (codex / gemini / opencode / mcode).
//
// Invocation shapes and event vocabularies follow ZCode's headless harness
// driver table (packages/shared/src/harness-drivers.ts) — see NOTICE.md.
// Each factory returns a per-run push(ev) -> normalized outcome:
//   { sessionId, progress[], text, result, isError, done }
// `text` is a delta for the bridge to accumulate; `result` is the final
// answer (non-null when the terminal record arrived); `done` marks a
// terminal event. Parsers are defensive: unknown lines/shapes are skipped,
// never thrown.
// ---------------------------------------------------------------------------

function newOutcome() {
  return { sessionId: null, progress: [], text: '', result: null, isError: false, done: false };
}

function asStr(v) {
  return typeof v === 'string' && v.length ? v : null;
}

function asRec(v) {
  return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
}

// Longest suffix of `summary` not already covered by `streamed` (dedup for
// CLIs that repeat streamed text in their terminal record).
function unseenSuffix(streamed, summary) {
  if (!summary) return null;
  if (!streamed) return summary;
  if (summary === streamed) return null;
  if (summary.startsWith(streamed)) return summary.slice(streamed.length) || null;
  return summary;
}

// Codex: `codex exec --json <prompt>` (resume: `codex exec resume --json <id>`).
// Shapes: thread.started, turn.started/completed/failed, item.started/updated/
// completed. Text comes from item.completed agent_message items; the terminal
// marker is turn.completed.
function createCodexParser() {
  let sawSession = false;
  return (ev) => {
    const out = newOutcome();
    if (!asRec(ev)) return out;
    if (!sawSession && asStr(ev.thread_id)) { sawSession = true; out.sessionId = ev.thread_id; }
    const type = asStr(ev.type);
    if (type === 'turn.completed') { out.done = true; return out; }
    if (type === 'turn.failed') {
      out.result = asStr(ev.message) || asStr(ev.error) || 'harness turn failed';
      out.isError = true; out.done = true;
      return out;
    }
    if (type === 'item.completed') {
      const item = asRec(ev.item);
      if (!item) return out;
      const itemType = asStr(item.type);
      if (itemType === 'agent_message') {
        const t = asStr(item.text);
        if (t) out.text = t;
      } else if (itemType === 'reasoning') {
        const t = asStr(item.text);
        if (t) out.progress.push('thinking: ' + t.slice(0, 140));
      } else if (itemType === 'command_execution') {
        out.progress.push('ran: ' + (asStr(item.command) || asStr(item.aggregated_output) || 'shell'));
      } else if (itemType === 'file_change') {
        out.progress.push('edited: ' + (asStr(item.path) || 'files'));
      } else if (itemType === 'mcp_tool_call') {
        out.progress.push('mcp tool: ' + (asStr(item.name) || asStr(item.server) || 'mcp tool'));
      } else if (itemType === 'web_search') {
        out.progress.push('web search: ' + (asStr(item.query) || 'web'));
      } else if (itemType === 'error') {
        out.progress.push('note: ' + (asStr(item.message) || 'harness reported an error item'));
      }
    }
    return out;
  };
}

// Gemini: `gemini --output-format stream-json -p <prompt>`.
// Shapes: init/message/tool_use/tool_result/error/result. Assistant message
// events carry the text; the terminal marker is the result event.
function createGeminiParser() {
  let sawSession = false;
  return (ev) => {
    const out = newOutcome();
    if (!asRec(ev)) return out;
    if (!sawSession && asStr(ev.session_id)) { sawSession = true; out.sessionId = ev.session_id; }
    const type = asStr(ev.type);
    if (type === 'message') {
      if (ev.role === 'assistant') {
        const c = asStr(ev.content);
        if (c) out.text = c;
      }
    } else if (type === 'tool_use') {
      out.progress.push('tool: ' + (asStr(ev.tool_name) || 'tool'));
    } else if (type === 'tool_result') {
      const output = asStr(ev.output);
      out.progress.push('tool result (' + (asStr(ev.status) || 'done') + ')' + (output ? ': ' + output.slice(0, 140) : ''));
    } else if (type === 'error') {
      const message = asStr(ev.message) || 'harness error';
      // Non-fatal in the driver table: surface and keep going.
      out.progress.push((ev.severity === 'warning' ? 'warning: ' : 'error: ') + message);
    } else if (type === 'result') {
      if (ev.status === 'error') {
        const detail = asRec(ev.error);
        out.result = (detail && asStr(detail.message)) || 'harness run failed';
        out.isError = true;
      }
      out.done = true;
    }
    return out;
  };
}

// OpenCode: `opencode run [--session <id>] --format json <prompt>`.
// Shapes: text/reasoning/tool_use/error over a {type, timestamp, sessionID}
// envelope. There is no terminal marker — the run ends when the process
// exits, so the bridge falls back to the accumulated text on close.
function createOpencodeParser() {
  let sawSession = false;
  return (ev) => {
    const out = newOutcome();
    if (!asRec(ev)) return out;
    if (!sawSession && asStr(ev.sessionID)) { sawSession = true; out.sessionId = ev.sessionID; }
    const type = asStr(ev.type);
    const part = asRec(ev.part);
    if (type === 'text') {
      const t = part && asStr(part.text);
      if (t) out.text = t;
    } else if (type === 'reasoning') {
      const t = part && (asStr(part.text) || asStr(part.reasoning));
      if (t) out.progress.push('thinking: ' + t.slice(0, 140));
    } else if (type === 'tool_use') {
      const name = part ? (asStr(part.tool) || asStr(part.name) || asStr(part.type) || 'tool') : 'tool';
      out.progress.push('tool: ' + name);
    } else if (type === 'error') {
      const detail = asRec(ev.error);
      out.result = (detail && (asStr(detail.message) || asStr(detail.data))) || 'harness run failed';
      out.isError = true; out.done = true;
    }
    return out;
  };
}

// MiniMax Code: `mcode exec [--session <id>] --output-format stream-json <prompt>`.
// Shapes: exec.started/session.started/turn.started, item.started/item.updated
// with {id, type, contentDelta} deltas, item.completed with full content,
// turn.completed/failed, terminal exec.completed carrying exec.result.
// Deltas stream first; item.completed/exec.result only contribute the
// verified unseen suffix.
function createMcodeParser() {
  let sawSession = false;
  let streamedText = '';
  const streamedByItem = new Map();
  return (ev) => {
    const out = newOutcome();
    if (!asRec(ev)) return out;
    if (!sawSession && asStr(ev.sessionId)) { sawSession = true; out.sessionId = ev.sessionId; }
    const type = asStr(ev.type);
    if (type === 'item.started' || type === 'item.updated') {
      const item = asRec(ev.item);
      const itemType = item && asStr(item.type);
      const delta = item && asStr(item.contentDelta);
      if (item && itemType && delta) {
        const itemId = asStr(item.id) || (itemType + ':unkeyed');
        if (itemType === 'agent_message') {
          streamedByItem.set(itemId, (streamedByItem.get(itemId) || '') + delta);
          streamedText += delta;
          out.text = delta;
        } else if (itemType === 'reasoning') {
          out.progress.push(delta.slice(0, 140));
        }
      }
      return out;
    }
    if (type === 'item.completed') {
      const item = asRec(ev.item);
      const itemType = item && asStr(item.type);
      if (item && itemType) {
        const itemId = asStr(item.id) || (itemType + ':unkeyed');
        if (itemType === 'agent_message') {
          const unseen = unseenSuffix(streamedByItem.get(itemId) || '', asStr(item.content));
          if (unseen) {
            streamedByItem.set(itemId, (streamedByItem.get(itemId) || '') + unseen);
            streamedText += unseen;
            out.text = unseen;
          }
        } else if (itemType === 'reasoning') {
          const c = asStr(item.content);
          if (c) out.progress.push(c.slice(0, 140));
        } else {
          const summary = asStr(item.content) || asStr(item.title);
          if (summary) out.progress.push(itemType + ': ' + summary.slice(0, 140));
        }
      }
      return out;
    }
    if (type === 'turn.failed') {
      const detail = asRec(ev.error);
      out.result = (detail && asStr(detail.message)) || 'harness turn failed';
      out.isError = true; out.done = true;
      return out;
    }
    if (type === 'turn.completed' || type === 'exec.completed' || type === 'exec.result') {
      const result = type === 'exec.completed' ? asRec(ev.result)
        : type === 'exec.result' ? ev : null;
      if (result) {
        if (asStr(result.status) && result.status !== 'succeeded') {
          const detail = asRec(result.error);
          out.result = (detail && asStr(detail.message)) || 'harness run failed';
          out.isError = true; out.done = true;
          return out;
        }
        const unseen = unseenSuffix(streamedText, asStr(result.output));
        if (unseen) { streamedText += unseen; out.text = unseen; }
      }
      out.done = true;
      return out;
    }
    return out;
  };
}

module.exports = {
  parseClaudeEvent, parseMuseEvent,
  createCodexParser, createGeminiParser, createOpencodeParser, createMcodeParser,
};
