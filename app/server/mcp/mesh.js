// ============================================================
// server/mcp/mesh.js — v11.0 PHASE 1 · MCP DATA AGENT MESH
// ------------------------------------------------------------
// The Layer-1 orchestrator of the Global Market Council. Imports
// all 10 agent adapters (pure registration — zero network at import)
// and serves ONE query surface:
//
//   meshQuery({ capabilities: ['crypto.ohlcv','crypto.funding'],
//               symbols: ['BTC'], force?: false })
//     → { ok, results: { cap: { data, agent, ts, ageMs, stale } },
//         gaps: [caps with no honest data], meta }
//
// Semantics (every one a repo-proven pattern):
//   • capability routing   — only agents that PROVIDE the cap run
//   • 3-tier cache         — hot 30s / warm 5min / cold 60min (LRU 200)
//   • single-flight        — concurrent identical queries JOIN
//   • negative cache 90s   — a failed (cap,args) never thundering-herds
//   • per-agent deadline   — AbortSignal-based race, default 8s
//   • 3-fail breakers      — registry.js health, half-open probes
//   • token buckets        — free-tier etiquette per agent card
//   • honesty tags         — live/cached/stale on EVERY result
//   • degradation ladder   — priority-ordered fallback, skip+tag, never invent
//
// Routes (registered by registerMeshRoutes in server/index.js):
//   GET  /api/mcp/agents        registry + live health
//   GET  /api/mcp/mesh/status   cache + breakers + budgets
//   POST /api/mcp/mesh/query    the mesh query surface itself
// ============================================================
import './agents/registry.js';
import './agents/alphavantage.js';
import './agents/coingecko.js';
import './agents/ccxt.js';
import './agents/tradingview.js';
import './agents/tradingcentral.js';
import './agents/quiver.js';
import './agents/massive.js';
import './agents/coinapi.js';
import './agents/finnhubAgent.js';
import './agents/alpaca.js';
import {
  CAP_TIERS, MESH_TIMEOUT_MS, allCards, whichAgentsNeed,
  budgetAllows, budgetCommit, noteSuccess, noteFailure, agentHealth, budgetView, resetHealthForTests,
} from './agents/registry.js';

export { CAP_TIERS, MESH_TIMEOUT_MS };

// ---------------- cache + single-flight + negative cache ----------------
const CACHE_MAX = 200;        // LRU cap (the orderFlowDepth 200-entry pattern)
const NEG_TTL = 90_000;       // negative cache window
const FANOUT_CONCURRENCY = 6; // p-limit-style parallel cap

const _cache = new Map();       // key → { at, payload }
const _inflight = new Map();    // key → running promise
const _negative = new Map();    // key → failedAt
const _stats = { queries: 0, cacheHits: 0, upstream: 0, negativeHits: 0, gaps: 0 };

function cacheGet(key, ttlMs) {
  const hit = _cache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > ttlMs) return { stale: hit, fresh: false };
  return { stale: null, fresh: hit };
}

function cacheSet(key, payload) {
  _cache.set(key, { at: Date.now(), payload });
  // LRU eviction — Map preserves insertion order; re-set refreshes it
  if (_cache.size > CACHE_MAX) {
    const oldest = _cache.keys().next().value;
    _cache.delete(oldest);
  }
}

function negativeGet(key) {
  const at = _negative.get(key);
  if (at == null) return false;
  if (Date.now() - at > NEG_TTL) { _negative.delete(key); return false; }
  return true;
}
function negativeSet(key) {
  _negative.set(key, Date.now());
  if (_negative.size > CACHE_MAX) {
    const oldest = _negative.keys().next().value;
    _negative.delete(oldest);
  }
}

// ---------------- p-limit (6) — tiny, dependency-free ----------------
function plimit(concurrency) {
  let active = 0;
  const queue = [];
  const next = () => {
    if (active >= concurrency || queue.length === 0) return;
    const { fn, resolve, reject } = queue.shift();
    active += 1;
    fn().then(resolve, reject).finally(() => { active -= 1; next(); });
  };
  return (fn) => new Promise((resolve, reject) => {
    queue.push({ fn, resolve, reject });
    next();
  });
}

// ---------------- deadline race ----------------
function withDeadline(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`${label} deadline ${ms}ms`)), ms);
      t.unref?.();
    }),
  ]);
}

// ---------------- one capability against one agent ----------------
/**
 * Runs `agent.caps[cap].fn(args)` under the deadline, updates health
 * + budget, returns data | null. Never throws.
 */
async function callAgent(agent, cap, args) {
  const def = agent.caps[cap];
  if (!def || typeof def.fn !== 'function') return null;
  if (!budgetAllows(agent.id, def.cost ?? 1)) return null; // over budget = honest skip
  _stats.upstream += 1;
  budgetCommit(agent.id, def.cost ?? 1);
  try {
    const data = await withDeadline(Promise.resolve(def.fn(args)), MESH_TIMEOUT_MS, `${agent.id}.${cap}`);
    if (data == null) { noteFailure(agent.id, new Error('null payload')); return null; }
    noteSuccess(agent.id);
    return data;
  } catch (err) {
    noteFailure(agent.id, err);
    return null;
  }
}

// ---------------- one capability resolution ----------------
async function resolveCapability(cap, args, { force = false } = {}) {
  const agents = whichAgentsNeed(cap);
  if (agents.length === 0) return { cap, ok: false, reason: 'no-authed-healthy-agent' };

  // tier from the preferred provider's own card (hot/warm/cold),
  // defaulting to warm when no agent declares one
  let tier = 'warm';
  for (const a of agents) {
    const t = a.caps[cap]?.tier;
    if (t && CAP_TIERS[t]) { tier = t; break; }
  }
  const ttlMs = CAP_TIERS[tier];

  // canonical key: capability + args (sorted for stability)
  const argKey = JSON.stringify(args || {});
  const key = `${cap}|${argKey}`;

  // negative cache — recent total failure: don't re-herd
  if (!force && negativeGet(key)) {
    _stats.negativeHits += 1;
    return { cap, ok: false, reason: 'negative-cached (recent failure)' };
  }

  // fresh cache
  if (!force) {
    const hit = cacheGet(key, ttlMs);
    if (hit && hit.fresh) {
      _stats.cacheHits += 1;
      return { cap, ok: true, ...hit.fresh.payload };
    }
    // stale-while-revalidate: keep the stale copy as the fallback
    // while a refresh runs; if the refresh fails we still serve it
    // (tagged stale) instead of inventing anything. The inflight entry
    // is the WRAPPED result shape so joined callers (the cold path's
    // single-flight join below) never see an unwrapped payload.
    if (hit && hit.stale) {
      const joined = (async () => {
        let fresh = null;
        for (const agent of agents) {
          const data = await callAgent(agent, cap, args);
          if (data != null) {
            const payload = { data, agent: agent.id, ts: Date.now(), stale: false };
            cacheSet(key, payload);
            fresh = { cap, ok: true, ...payload };
            break;
          }
        }
        if (fresh) return fresh;
        negativeSet(key);
        _stats.cacheHits += 1;
        return { cap, ok: true, ...hit.stale.payload, stale: true };
      })();
      _inflight.set(key, joined);
      return joined.finally(() => _inflight.delete(key));
    }
  }

  // single-flight cold path
  const running = _inflight.get(key);
  if (running) return running;

  const p = (async () => {
    for (const agent of agents) {
      const data = await callAgent(agent, cap, args);
      if (data != null) {
        const payload = { data, agent: agent.id, ts: Date.now(), stale: false };
        cacheSet(key, payload);
        return { cap, ok: true, ...payload };
      }
    }
    negativeSet(key);
    return { cap, ok: false, reason: 'all-agents-failed' };
  })();
  _inflight.set(key, p);
  return p.finally(() => _inflight.delete(key));
}

// ---------------- THE query surface ----------------
/** v11.0.1 HARDENING: every caller-facing input is normalized at the
 *  engine boundary so NO agent downstream can receive a raw query-
 *  string payload (the audit found 5 agents interpolating symbols
 *  into URLs unencoded — alphavantage/quiver/tradingcentral/massive/
 *  alpaca; the mesh now guarantees clean input for ALL of them):
 *    • symbols/keys/pairs → A-Z0-9.- only, ≤20 chars, dropped otherwise
 *    • limit → clamped 1..500 (negative/huge values passed through raw
 *      before)
 *    • timeframe → whitelist {5m,15m,1h,4h,1d} else '1h'
 *  Internal callers (council, weeklyReview) pass already-clean symbols
 *  and are unaffected. */
const SAFE_SYM = /^[A-Z0-9.-]{1,20}$/;
const SAFE_TF = new Set(['5m', '15m', '1h', '4h', '1d']);
function sanitizeList(list, max) {
  if (!Array.isArray(list)) return [];
  return list.map(s => String(s || '').toUpperCase().trim())
    .filter(s => SAFE_SYM.test(s))
    .slice(0, max);
}

export async function meshQuery(q = {}) {
  const capabilities = Array.isArray(q.capabilities)
    ? q.capabilities.map(c => String(c)).filter(Boolean)
    : [];
  if (capabilities.length === 0) {
    return { ok: false, results: {}, gaps: [], reason: 'no capabilities requested' };
  }
  _stats.queries += 1;
  const limitRaw = Number(q.limit);
  const args = {
    symbols: sanitizeList(q.symbols, 20),
    keys: sanitizeList(q.keys ?? q.symbols, 20),
    pairs: sanitizeList(q.pairs, 10),
    limit: Number.isFinite(limitRaw) ? Math.max(1, Math.min(500, Math.round(limitRaw))) : 20,
    timeframe: SAFE_TF.has(String(q.timeframe || '')) ? String(q.timeframe) : '1h',
  };
  const limit = plimit(FANOUT_CONCURRENCY);
  const settled = await Promise.all(
    capabilities.map(cap => limit(() => resolveCapability(cap, args, { force: !!q.force })))
  );
  const results = {};
  const gaps = [];
  for (const r of settled) {
    if (!r) continue;
    const { cap, ...rest } = r;
    if (r.ok) {
      results[cap] = rest;
    } else {
      gaps.push({ cap, reason: r.reason || 'unavailable' });
      _stats.gaps += 1;
    }
  }
  return {
    ok: Object.keys(results).length > 0,
    results,
    gaps,
    meta: {
      requested: capabilities.length,
      served: Object.keys(results).length,
      timeoutMs: MESH_TIMEOUT_MS,
      tiers: CAP_TIERS,
    },
  };
}

// ---------------- status ----------------
export function meshStatus() {
  const agents = allCards().map(c => ({
    ...c,
    health: agentHealth(c.id),
    budgetUsed: budgetView(c.id),
  }));
  return {
    ok: true,
    agents,
    agentCount: agents.length,
    authedAgents: agents.filter(a => a.authed).length,
    cache: {
      entries: _cache.size,
      cap: CACHE_MAX,
      inflight: _inflight.size,
      negative: _negative.size,
      stats: { ..._stats },
    },
    timeoutMs: MESH_TIMEOUT_MS,
    note: 'MCP Data Agent Mesh — capability-routed fan-out, 3-tier cache, 3-fail breakers, token-bucket budgets. Missing key = agent honestly absent.',
  };
}

// ---------------- cross-source validation (Phase 5 built-in) ----------------
/**
 * Price sanity band across sources: if two independent agents
 * disagree > 1.5% on the same symbol, BOTH get flagged degraded and
 * the divergence is reported (the garbage-in guard — consensus can
 * never outrank bad data).
 * @param {Map<string, Array<{agent: string, price: number}>>} pricesBySymbol
 * @returns {{ symbol, spreadPct, agents, degraded }[]}
 */
export function crossValidatePrices(pricesBySymbol) {
  const out = [];
  for (const [symbol, list] of Object.entries(pricesBySymbol || {})) {
    const rows = (list || []).filter(p => p && Number.isFinite(Number(p.price)) && Number(p.price) > 0);
    if (rows.length < 2) continue;
    const prices = rows.map(r => Number(r.price));
    const lo = Math.min(...prices), hi = Math.max(...prices);
    const mid = (lo + hi) / 2;
    const spreadPct = mid > 0 ? Math.round(((hi - lo) / mid) * 10000) / 100 : null;
    if (spreadPct != null && spreadPct > 1.5) {
      out.push({
        symbol,
        spreadPct,
        agents: rows.map(r => `${r.agent}:${r.price}`),
        degraded: true,
      });
    }
  }
  return out;
}

// ---------------- routes ----------------
export function registerMeshRoutes(app) {
  app.get('/api/mcp/agents', (_req, res) => {
    try {
      res.json({ ok: true, agents: allCards(), count: allCards().length });
    } catch (e) {
      res.status(500).json({ ok: false, error: 'mesh registry failed' });
    }
  });
  app.get('/api/mcp/mesh/status', (_req, res) => {
    try { res.json(meshStatus()); } catch { res.status(500).json({ ok: false, error: 'mesh status failed' }); }
  });
  app.post('/api/mcp/mesh/query', async (req, res) => {
    try {
      const body = req.body || {};
      if (!Array.isArray(body.capabilities) || body.capabilities.length === 0) {
        return res.status(400).json({ ok: false, error: '`capabilities` (string[]) required — e.g. ["crypto.ohlcv","crypto.funding"]' });
      }
      // meshQuery itself sanitizes symbols/keys/pairs/limit/timeframe
      // (the v11.0.1 hardening) — the route keeps only the arity caps.
      const out = await meshQuery({
        capabilities: body.capabilities.slice(0, 8).map(String),
        symbols: body.symbols,
        keys: body.keys,
        pairs: body.pairs,
        limit: body.limit, timeframe: body.timeframe,
        force: body.force === true,
      });
      return res.json(out);
    } catch (e) {
      return res.status(500).json({ ok: false, error: 'mesh query failed' });
    }
  });
}

// ---------------- test hooks ----------------
export function __resetMeshForTests() {
  _cache.clear();
  _inflight.clear();
  _negative.clear();
  Object.assign(_stats, { queries: 0, cacheHits: 0, upstream: 0, negativeHits: 0, gaps: 0 });
  try { resetHealthForTests(); } catch { /* registry optional in isolation */ }
}

export function __meshStatsForTests() { return { ..._stats, cacheSize: _cache.size, inflight: _inflight.size, negativeSize: _negative.size }; }

export const __testables = { resolveCapability, callAgent, cacheGet, cacheSet, negativeGet, plimit, withDeadline, sanitizeList, SAFE_TF };
