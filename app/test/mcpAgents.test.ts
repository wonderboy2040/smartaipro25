// ============================================================
// test/mcpAgents.test.ts — v11.0 PHASE 1 · AGENT REGISTRY
// ------------------------------------------------------------
// Locks the registry contract: card validation, capability routing,
// auth gating, breaker semantics (3-fail → open → half-open probe →
// recovery / exponential backoff), token-bucket budgets, and the
// 10-agent mesh inventory itself.
// ============================================================
import { describe, it, expect, beforeEach, vi } from 'vitest';

// Hermetic store (the near-miss/gate files never touch disk).
const _disk = vi.hoisted(() => new Map());
vi.mock('../server/lib/store.js', () => ({
  loadJSON: (f, d) => (_disk.has(f) ? _disk.get(f) : d),
  saveJSON: (f, v) => { _disk.set(f, v); },
}));
vi.mock('../server/mcp/durable.js', () => ({
  durablePut: vi.fn(),
  durableStatus: () => ({}),
}));

// Import the mesh (registers all 10 agents) — network-free at import.
import * as mesh from '../server/mcp/mesh.js';
import {
  registerAgent, getAgent, allCards, whichAgentsNeed, hasAuth,
  noteSuccess, noteFailure, agentHealth, budgetAllows, budgetCommit, budgetView,
  __resetRegistryForTests, __testables,
} from '../server/mcp/agents/registry.js';

// A controllable probe agent for breaker/budget tests.
function probeAgent(id = 'probe') {
  return {
    id, name: 'Probe', kind: 'rest', envKey: 'PROBE_KEY', authRequired: true, priority: 10,
    budget: { perDay: 2, perMinute: 10 },
    caps: { 'test.cap': { tier: 'hot', cost: 1, fn: async () => ({ ok: true }) } },
  };
}

describe('v11.0 MCP mesh — the 10-agent inventory', () => {
  it('registers exactly the 10 researched agents with the planned capabilities', () => {
    const status = mesh.meshStatus();
    expect(status.agentCount).toBe(10);
    const ids = status.agents.map(a => a.id).sort();
    expect(ids).toEqual(['alpaca', 'alphavantage', 'ccxt', 'coinapi', 'coingecko', 'finnhub', 'massive', 'quiver', 'tradingcentral', 'tradingview'].sort());
    const caps = new Set(status.agents.flatMap(a => a.capabilities.map(c => c.cap)));
    for (const cap of ['stocks.quote', 'crypto.ohlcv', 'crypto.funding', 'crypto.price', 'news.sentiment', 'altdata.congress', 'quotes.yahoo']) {
      expect(caps.has(cap)).toBe(true);
    }
  });

  it('keyless agents (ccxt/tradingview/coingecko-public) route without any env keys', () => {
    const saved = { ...process.env };
    for (const k of ['ALPHAVANTAGE_API_KEY', 'COINGECKO_API_KEY', 'TRADINGCENTRAL_API_KEY', 'QUIVER_API_KEY', 'MASSIVE_API_KEY', 'COINAPI_API_KEY', 'FINNHUB_API_KEY', 'ALPACA_API_KEY', 'ALPACA_API_SECRET']) delete process.env[k];
    expect(whichAgentsNeed('crypto.ohlcv').map(a => a.id)).toEqual(['ccxt']);
    expect(whichAgentsNeed('stocks.tvscan').map(a => a.id)).toEqual(['tradingview']);
    expect(whichAgentsNeed('crypto.price').map(a => a.id)).toEqual(['coingecko']);
    Object.assign(process.env, saved);
  });

  it('every card exposes an honesty note + health state in the status view', () => {
    for (const a of mesh.meshStatus().agents) {
      expect(typeof a.note).toBe('string');
      expect(a.note.length).toBeGreaterThan(10);
      expect(['closed', 'open', 'half-open']).toContain(a.health.state);
    }
  });
});

describe('v11.0 agent registry — card contract', () => {
  beforeEach(() => { __resetRegistryForTests(); process.env.PROBE_KEY = 'k'; });

  it('registers a valid card and serves the public view (no fns)', () => {
    registerAgent(probeAgent());
    const a = getAgent('probe');
    expect(a).toBeTruthy();
    expect(a.caps['test.cap'].tier).toBe('hot');
    const cards = allCards();
    const card = cards.find(c => c.id === 'probe');
    expect(card.capabilities).toEqual([{ cap: 'test.cap', tier: 'hot' }]);
    expect(card.envKey).toBe('PROBE_KEY');
    expect(JSON.stringify(card)).not.toContain('"fn"'); // fns never serialized
  });

  it('rejects malformed cards fail-fast (id / caps / fn / tier)', () => {
    expect(() => registerAgent(null)).toThrow();
    expect(() => registerAgent({ caps: {} })).toThrow();
    expect(() => registerAgent({ id: 'x', caps: { a: { fn: 5 } } })).toThrow();
    expect(() => registerAgent({ id: 'x', caps: { a: { tier: 'bogus', fn: async () => 1 } } })).toThrow();
  });

  it('auth gate: no key → whichAgentsNeed excludes; key present → included', () => {
    registerAgent(probeAgent());
    delete process.env.PROBE_KEY;
    expect(whichAgentsNeed('test.cap')).toHaveLength(0);
    process.env.PROBE_KEY = 'k';
    expect(whichAgentsNeed('test.cap').map(a => a.id)).toEqual(['probe']);
    expect(hasAuth(getAgent('probe'))).toBe(true);
  });

  it('priority ordering: lower priority first, stable within', () => {
    registerAgent({ ...probeAgent('a'), priority: 20 });
    registerAgent({ ...probeAgent('b'), priority: 5 });
    expect(whichAgentsNeed('test.cap').map(a => a.id)).toEqual(['b', 'a']);
  });
});

describe('v11.0 agent registry — breaker semantics', () => {
  beforeEach(() => { __resetRegistryForTests(); process.env.PROBE_KEY = 'k'; });

  it('3 consecutive failures open the breaker; routing skips the agent', () => {
    registerAgent(probeAgent());
    noteFailure('probe'); noteFailure('probe');
    expect(agentHealth('probe').state).toBe('closed');
    noteFailure('probe');
    expect(agentHealth('probe').state).toBe('open');
    expect(whichAgentsNeed('test.cap')).toHaveLength(0);
  });

  it('half-open after the backoff window; success closes + resets backoff', () => {
    registerAgent(probeAgent());
    for (let i = 0; i < 3; i++) noteFailure('probe');
    expect(agentHealth('probe').state).toBe('open');
    // time-travel past the 10-min backoff
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 11 * 60_000);
    expect(agentHealth('probe').state).toBe('half-open');
    expect(whichAgentsNeed('test.cap')).toHaveLength(1); // probe allowed
    noteSuccess('probe');
    expect(agentHealth('probe').state).toBe('closed');
    vi.useRealTimers();
  });

  it('repeated opens grow the backoff exponentially (flap protection, cap 80min)', () => {
    registerAgent(probeAgent());
    const h = __testables.healthOf;
    for (let cycle = 0; cycle < 3; cycle++) {
      for (let i = 0; i < 3; i++) noteFailure('probe');
      expect(h('probe').openedAt).toBeGreaterThan(0);
      vi.useFakeTimers();
      vi.setSystemTime(Date.now() + h('probe').backoffMs + 1000);
      vi.useRealTimers();
    }
    expect(__testables.healthOf('probe').backoffMs).toBeGreaterThanOrEqual(__testables.BREAKER_BACKOFF_MS);
    expect(__testables.healthOf('probe').backoffMs).toBeLessThanOrEqual(__testables.BREAKER_BACKOFF_MS * 8);
  });

  it('mixed fails with successes in between never open (consecutive rule)', () => {
    registerAgent(probeAgent());
    noteFailure('probe'); noteSuccess('probe'); noteFailure('probe'); noteSuccess('probe'); noteFailure('probe');
    expect(agentHealth('probe').state).toBe('closed');
  });
});

describe('v11.0 agent registry — token-bucket budgets', () => {
  beforeEach(() => { __resetRegistryForTests(); process.env.PROBE_KEY = 'k'; });

  it('daily budget: allows up to cap, then blocks (day-rollover resets)', () => {
    registerAgent(probeAgent()); // perDay 2
    expect(budgetAllows('probe')).toBe(true);
    budgetCommit('probe');
    expect(budgetAllows('probe')).toBe(true);
    budgetCommit('probe');
    expect(budgetAllows('probe')).toBe(false); // 3rd call blocked
    expect(budgetView('probe').usedToday).toBe(2);
  });

  it('per-minute budget rolls over after 60s', () => {
    registerAgent({ ...probeAgent('probe-min'), budget: { perDay: 0, perMinute: 1 } });
    budgetCommit('probe-min');
    expect(budgetAllows('probe-min')).toBe(false);
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 61_000);
    expect(budgetAllows('probe-min')).toBe(true);
    vi.useRealTimers();
  });
});
