// ============================================================
// server/mcp/agents/registry.js — v11.0 PHASE 1 · AGENT REGISTRY
// ------------------------------------------------------------
// Single source of truth for the 10-agent MCP Data Agent Mesh:
//   • agent CARDS (id, name, capabilities, auth, rate budget, note)
//   • capability index (whichAgentsNeed('crypto.ohlcv'))
//   • per-agent HEALTH with 3-fail circuit breaker + 10-min backoff
//     half-open probes (the proven cryptoStream/binanceFutWs pattern)
//   • per-agent token-bucket rate budgets (free-tier etiquette)
//
// An "MCP agent" here is a standardized CONTRACT, not a religion
// about transport: remote JSON-RPC MCP servers (INDMoney/Tapetide
// pattern), in-process libraries, and thin REST adapters all honour
// the same card — exactly what the v11.0 plan specified ("protocol
// flexible, interface strict").
//
// PURE module: importing performs ZERO network calls. Agents
// register their cards; fetchers run only when mesh.js invokes them.
// ============================================================

// ---------------- cache tiers (honesty-tagged freshness) ----------------
export const CAP_TIERS = {
  hot: Number(process.env.AI_MCP_MESH_CACHE_HOT_SEC || 30) * 1000,   // live quotes
  warm: 5 * 60_000,   // OHLCV, sentiment, funding
  cold: 60 * 60_000,  // fundamentals, alt-data
};

export const MESH_TIMEOUT_MS = Math.max(2000, Number(process.env.AI_MCP_MESH_TIMEOUT_MS || 8000));

// ---------------- breaker states ----------------
const BREAKER_FAILS = 3;                // consecutive fails → open
const BREAKER_BACKOFF_MS = 10 * 60_000; // 10-min half-open probe window

const _agents = new Map();   // id → full agent object (with fetcher fns)
const _health = new Map();   // id → { fails, openedAt, backoffMs, probes, lastOk, lastFail, lastErr, halfOpen }
const _buckets = new Map();  // id → { day, usedToday, minuteStart, usedMinute }

const num = (v) => Number.isFinite(Number(v)) ? Number(v) : null;
const now = () => Date.now();

function healthOf(id) {
  let h = _health.get(id);
  if (!h) {
    h = { fails: 0, openedAt: 0, backoffMs: BREAKER_BACKOFF_MS, probes: 0, lastOk: 0, lastFail: 0, lastErr: null, halfOpen: false };
    _health.set(id, h);
  }
  return h;
}

// ---------------- card validation + registration ----------------
const VALID_TIERS = new Set(Object.keys(CAP_TIERS));

/**
 * Register an agent card. Throws on invalid shape (fail-fast at boot,
 * never at request time). Idempotent (re-register replaces).
 *
 * Card shape:
 *   {
 *     id: 'alphavantage',            // stable key
 *     name: 'Alpha Vantage MCP',     // display
 *     kind: 'rest'|'remote-mcp'|'wrap'|'inprocess',
 *     envKey: 'ALPHAVANTAGE_API_KEY',// '' = no auth needed
 *     authRequired: true,            // false → works without key
 *     priority: 10,                  // lower = preferred provider per cap
 *     budget: { perDay: 20, perMinute: 0 },
 *     note: 'honest one-liner for the UI',
 *     caps: {                        // capability → fetcher
 *       'stocks.quote': { tier: 'cold', cost: 1, fn: async (args) => data|null },
 *     },
 *   }
 */
export function registerAgent(card) {
  if (!card || typeof card !== 'object') throw new Error('agent card must be an object');
  if (!card.id || typeof card.id !== 'string') throw new Error('agent card needs id');
  if (!card.caps || typeof card.caps !== 'object' || Object.keys(card.caps).length === 0) {
    throw new Error(`agent ${card.id} needs at least one capability`);
  }
  for (const [cap, def] of Object.entries(card.caps)) {
    if (!def || typeof def.fn !== 'function') throw new Error(`agent ${card.id} cap ${cap}: fn required`);
    const tier = def.tier || 'warm';
    if (!VALID_TIERS.has(tier)) throw new Error(`agent ${card.id} cap ${cap}: unknown tier ${tier}`);
    if (def.cost != null && !(num(def.cost) >= 0)) throw new Error(`agent ${card.id} cap ${cap}: bad cost`);
  }
  _agents.set(card.id, {
    id: card.id,
    name: card.name || card.id,
    kind: card.kind || 'rest',
    envKey: card.envKey || '',
    authRequired: card.authRequired !== false,
    priority: num(card.priority) ?? 50,
    budget: {
      perDay: Math.max(0, num(card.budget?.perDay) ?? 0),      // 0 = no daily cap
      perMinute: Math.max(0, num(card.budget?.perMinute) ?? 0), // 0 = no minute cap
    },
    note: card.note || '',
    caps: card.caps,
  });
  return card.id;
}

export function getAgent(id) { return _agents.get(id) || null; }

/** Public card view (no fns) — what /api/mcp/agents serves. */
export function allCards() {
  return [..._agents.values()].map(a => ({
    id: a.id, name: a.name, kind: a.kind,
    capabilities: Object.entries(a.caps).map(([cap, def]) => ({ cap, tier: def.tier || 'warm' })),
    envKey: a.envKey || null,
    authRequired: a.authRequired,
    authed: hasAuth(a),
    priority: a.priority,
    budget: { ...a.budget },
    note: a.note,
    health: agentHealth(a.id),
    budgetUsed: budgetView(a.id),
  }));
}

/** Auth/routing truth: an agent routes when it can serve honestly.
 *  authRequired:false → keyless-capable (routes regardless; an optional
 *  demo key only improves rate limits). authRequired:true → the env
 *  key must be present, else the agent is honestly ABSENT. */
export function hasAuth(agent) {
  if (!agent) return false;
  if (agent.authRequired === false) return true;
  if (!agent.envKey) return false;
  return String(process.env[agent.envKey] || '').trim().length > 0;
}

/**
 * Capability routing: agents that (a) provide the capability,
 * (b) pass auth, (c) breaker not open — ordered by priority
 * (lower first, then registration order for stability).
 * BREAKER-HALF-OPEN agents are included (the probe IS the call).
 */
export function whichAgentsNeed(cap) {
  const out = [];
  for (const a of _agents.values()) {
    if (!a.caps[cap]) continue;
    if (!hasAuth(a)) continue;
    const h = healthOf(a.id);
    if (h.openedAt > 0) {
      const elapsed = now() - h.openedAt;
      if (elapsed < h.backoffMs) continue;     // OPEN — blocked
      h.halfOpen = true;                        // half-open: the next call IS the probe
    }
    out.push(a);
  }
  out.sort((a, b) => (a.priority - b.priority) || (a.id < b.id ? -1 : 1));
  return out;
}

// ---------------- breaker semantics ----------------
export function noteSuccess(id) {
  const h = healthOf(id);
  h.fails = 0;
  h.openedAt = 0;
  h.halfOpen = false;
  // exponential backoff RESET on a clean recovery (flap protection off)
  h.backoffMs = BREAKER_BACKOFF_MS;
  h.lastOk = now();
}

export function noteFailure(id, err) {
  const h = healthOf(id);
  h.fails += 1;
  h.lastFail = now();
  h.lastErr = err ? String(err?.message || err).slice(0, 200) : null;
  if (h.halfOpen || h.fails >= BREAKER_FAILS) {
    h.openedAt = now();
    h.fails = 0;
    h.halfOpen = false;
    h.probes += 1;
    // exponential backoff on REPEATED open (health flap): 10 → 20 → 40 → 80 min cap
    h.backoffMs = Math.min(BREAKER_BACKOFF_MS * 8, BREAKER_BACKOFF_MS * Math.pow(2, Math.min(3, h.probes - 1)));
  }
}

export function agentHealth(id) {
  const h = healthOf(id);
  const state = h.openedAt === 0 ? 'closed'
    : (now() - h.openedAt < h.backoffMs ? 'open' : 'half-open');
  return {
    state,
    consecutiveFails: h.fails,
    lastOkAt: h.lastOk || null,
    lastFailAt: h.lastFail || null,
    lastError: h.lastErr || null,
    breakerProbes: h.probes,
    backoffMs: state === 'open' ? h.backoffMs : null,
  };
}

// ---------------- token-bucket budgets ----------------
/**
 * True when one more call of `cost` fits BOTH the daily and the
 * per-minute budget (0 = unlimited for that axis). Pure check —
 * mesh.js commits via budgetCommit() only on REAL dispatch.
 */
export function budgetAllows(id, cost = 1) {
  const a = _agents.get(id);
  if (!a) return false;
  const t = now();
  let b = _buckets.get(id);
  const today = new Date(t).toISOString().slice(0, 10);
  if (!b || b.day !== today) {
    b = { day: today, usedToday: 0, minuteStart: t, usedMinute: 0 };
    _buckets.set(id, b);
  }
  if (b.minuteStart == null || t - b.minuteStart >= 60_000) {
    b.minuteStart = t;
    b.usedMinute = 0;
  }
  const c = Math.max(1, num(cost) ?? 1);
  if (a.budget.perDay > 0 && b.usedToday + c > a.budget.perDay) return false;
  if (a.budget.perMinute > 0 && b.usedMinute + c > a.budget.perMinute) return false;
  return true;
}

export function budgetCommit(id, cost = 1) {
  const a = _agents.get(id);
  if (!a) return;
  const t = now();
  const today = new Date(t).toISOString().slice(0, 10);
  let b = _buckets.get(id);
  if (!b || b.day !== today) {
    b = { day: today, usedToday: 0, minuteStart: t, usedMinute: 0 };
    _buckets.set(id, b);
  }
  if (t - b.minuteStart >= 60_000) {
    b.minuteStart = t;
    b.usedMinute = 0;
  }
  const c = Math.max(1, num(cost) ?? 1);
  b.usedToday += c;
  b.usedMinute += c;
}

export function budgetView(id) {
  const a = _agents.get(id);
  const b = _buckets.get(id);
  return {
    perDay: a?.budget.perDay ?? 0,
    usedToday: b?.usedToday ?? 0,
    perMinute: a?.budget.perMinute ?? 0,
    usedMinute: b?.usedMinute ?? 0,
  };
}

// ---------------- shared fetch helper (deadline + honesty) ----------------
/**
 * Uniform JSON GET with a hard deadline (AbortSignal.timeout) — the
 * v10.18 audit's #1 lesson (timeout-less fetch = handler hang). Never
 * throws; returns null on any failure so agents stay honest-skip.
 */
export async function fetchJSON(url, { timeoutMs = MESH_TIMEOUT_MS, headers = {} } = {}) {
  try {
    const r = await fetch(url, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: { Accept: 'application/json', ...headers },
    });
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; }
}

// ---------------- test hooks ----------------
export function __resetRegistryForTests() {
  _agents.clear();
  _health.clear();
  _buckets.clear();
}

/** Test hook: clear health/budgets but KEEP the registered agents
 *  (the mesh suite needs the 10 real cards fresh between tests). */
export function resetHealthForTests() {
  _health.clear();
  _buckets.clear();
}

export const __testables = { BREAKER_FAILS, BREAKER_BACKOFF_MS, healthOf };
