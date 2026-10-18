// ============================================================
// server/ai/mcpAudit.js — A5 MCP TOOL GOVERNANCE
// ------------------------------------------------------------
// v13.2 (accuracy plan A5): "Rate-limit + audit-log every MCP tool
// call, especially placeOrder."
//
// One shared wrapper for EVERY desk-agent tool call (crypto agent,
// intraday ProTrader agent, and any future desk):
//
//   const result = await withMcpAudit('crypto', name, args,
//     () => executeCryptoTool(name, args, deps));
//
//   • RATE-LIMIT — a per-desk rolling-minute cap (default 60/min,
//     env AI_MCP_RATE_PER_MIN). A runaway LLM loop (the v11.4 bug
//     where tool rounds silently died, or a future regression) can
//     no longer hammer the live stack with unbounded tool calls.
//     Over-limit calls get a structured { error: 'rate-limited' }
//     answer the model can READ and adapt to.
//   • AUDIT — a bounded ring buffer of the last N calls (tool, arg
//     digest, ok/error, duration). placeOrder-class tools (anything
//     that can move money — currently only the Telegram /trade
//     approval path, but the net is cast for future order tools)
//     are flagged in the view. Exposed via GET /api/ai/mcp-audit.
//
// Purity: never throws, never blocks longer than a Map iteration.
// ============================================================

const RING_MAX = 300;
const _ring = [];               // newest last
const _perDeskMinute = new Map(); // desk → [timestamps]
const RATE_PER_MIN = Number(process.env.AI_MCP_RATE_PER_MIN) > 0
  ? Number(process.env.AI_MCP_RATE_PER_MIN) : 60;

/** Tools that can move money — flagged in every audit view. */
const ORDER_CLASS = new Set(['place_order', 'placeOrder', 'execute_trade', 'trade']);

function _nowSec() { return Math.floor(Date.now() / 1000); }

function _rateCheck(desk) {
  const now = _nowSec();
  let stamps = _perDeskMinute.get(desk);
  if (!stamps) { stamps = []; _perDeskMinute.set(desk, stamps); }
  // drop entries older than 60s
  while (stamps.length && now - stamps[0] >= 60) stamps.shift();
  if (stamps.length >= RATE_PER_MIN) return false;
  stamps.push(now);
  return true;
}

/** Small arg digest for the audit trail — values truncated, never raw
 *  (an order tool's args could carry sensitive sizing; keep it short). */
function _digest(args) {
  try {
    const keys = Object.keys(args || {});
    if (keys.length === 0) return {};
    const out = {};
    for (const k of keys.slice(0, 4)) {
      const v = String(args[k] ?? '');
      out[k] = v.length > 40 ? `${v.slice(0, 37)}...` : v;
    }
    return out;
  } catch { return {}; }
}

/**
 * Wrap ONE tool call with rate-limit + audit. NEVER throws.
 * @returns the tool's own return value, or { error: 'rate-limited', ... }
 *          when the per-desk minute cap is hit.
 */
export async function withMcpAudit(desk, name, args, fn) {
  const t0 = Date.now();
  const tool = String(name || 'unknown');
  const d = String(desk || 'unknown');
  if (!_rateCheck(d)) {
    _ring.push({ desk: d, tool, args: _digest(args), ok: false, error: 'rate-limited', ms: 0, ts: t0, orderClass: ORDER_CLASS.has(tool) });
    if (_ring.length > RING_MAX) _ring.splice(0, _ring.length - RING_MAX);
    return { error: 'rate-limited', hint: `Too many tool calls this minute (cap ${RATE_PER_MIN}/min). Reply from the context you already have.` };
  }
  let out;
  let failed = false;
  try {
    out = await fn();
  } catch (e) {
    failed = true;
    out = { error: String(e?.message || e).slice(0, 200) };
  }
  const ms = Date.now() - t0;
  const errOut = out && typeof out === 'object' && out.error ? String(out.error).slice(0, 200) : null;
  _ring.push({ desk: d, tool, args: _digest(args), ok: !failed && !errOut, error: failed ? String(out?.error) : errOut, ms, ts: t0, orderClass: ORDER_CLASS.has(tool) });
  if (_ring.length > RING_MAX) _ring.splice(0, _ring.length - RING_MAX);
  return out;
}

/** GET /api/ai/mcp-audit view — bounded, newest first. */
export function mcpAuditView() {
  const calls = [..._ring].reverse().slice(0, 120);
  const byTool = {};
  for (const c of _ring) {
    const k = `${c.desk}:${c.tool}`;
    byTool[k] = byTool[k] || { calls: 0, errors: 0, avgMs: 0, orderClass: c.orderClass };
    byTool[k].calls += 1;
    if (!c.ok) byTool[k].errors += 1;
    byTool[k].avgMs = Math.round(((byTool[k].avgMs * (byTool[k].calls - 1)) + c.ms) / byTool[k].calls);
  }
  return {
    ok: true,
    ratePerMin: RATE_PER_MIN,
    ringSize: _ring.length,
    recent: calls,
    byTool,
  };
}

export function __resetMcpAuditForTests() {
  _ring.length = 0;
  _perDeskMinute.clear();
}

export const __testables = { _digest, _rateCheck, ORDER_CLASS };
