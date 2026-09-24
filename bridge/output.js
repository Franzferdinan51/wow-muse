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
