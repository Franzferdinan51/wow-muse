'use strict';
// Advisory SystemOne routing for the WoW-Muse bridge.
//
// Before a run, the bridge can ask the local SystemOne shim
// (POST /v1/systemone/route) which tier a task belongs to, then map that tier
// to a provider/model through cfg.systemone.tierMap.
//
// This is advisory and fail-open: the shim only answers during an active turn,
// and any error or timeout (default 3 s) returns null, in which case the bridge
// silently uses its configured provider. The router never loads models; the
// selected provider's own backend does the work.
//
// Selection order: router decision -> registry/config (tierMap) -> explicit
// user config. No model IDs are hard-coded: every model comes from the router
// response or from config.

const http = require('http');

function postJson(host, port, path, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    const data = Buffer.from(JSON.stringify(body), 'utf8');
    const req = http.request({
      host, port, path, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': data.length },
    }, res => {
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', c => { raw += c; });
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(`HTTP ${res.statusCode}`));
          return;
        }
        try { resolve(JSON.parse(raw)); }
        catch (e) { reject(new Error('bad JSON from router: ' + e.message)); }
      });
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => { req.destroy(new Error('router timeout')); });
    req.end(data);
  });
}

// Returns { provider, model } | null. Never throws.
async function routeTask(taskText, sysCfg, log) {
  if (!sysCfg || sysCfg.enabled !== true) return null;
  const host = sysCfg.host || '127.0.0.1';
  const port = sysCfg.port || 8765;
  const timeoutMs = sysCfg.timeoutMs || 3000;
  const say = msg => { try { if (typeof log === 'function') log(msg); } catch {} };
  try {
    const res = await postJson(host, port, '/v1/systemone/route',
      { task: String(taskText || '').slice(0, 2000) }, timeoutMs);
    const tier = res && res.route && res.route.tier;
    if (!tier) { say('systemone: no tier in router response; using configured provider'); return null; }
    const mapped = (sysCfg.tierMap || {})[tier];
    if (!mapped || !mapped.provider) {
      say(`systemone: tier '${tier}' has no tierMap entry; using configured provider`);
      return null;
    }
    say(`systemone: tier '${tier}' -> provider '${mapped.provider}'` +
      (mapped.model ? ` model '${mapped.model}'` : '') +
      (res.route.confidence != null ? ` (confidence ${res.route.confidence})` : ''));
    return { provider: mapped.provider, model: mapped.model || null };
  } catch (e) {
    say(`systemone: router unavailable (${e.message}); using configured provider`);
    return null;
  }
}

module.exports = { routeTask };
