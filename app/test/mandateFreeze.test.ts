// ============================================================
// test/mandateFreeze.test.ts — v10.8 PRO #4 BOUNDED-AUTONOMY
// MANDATE (Vibe-Trading port) regression suite.
//
// LOCKED HERE:
//   • freezeMandate captures every risk cap, deep-frozen (immutable)
//   • mandateEffectiveCfg: mid-session LOOSENING clamps to the
//     frozen value; TIGHTENING passes through; equality untouched
//   • every cap's "tighter" direction is correct (more trades =
//     looser, lower loss-cap trigger = stricter, etc.)
//   • agentStart journals the MANDATE audit entry; agentStop
//     releases the mandate; a fresh start re-freezes current values
//   • the self-downgrade path saves from USER config (never
//     persists clamped caps over the user's own settings)
// Same mock scaffolding as test/agent.test.ts.
// ============================================================
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const mockPrivate = vi.fn();
// v10.17 CALENDAR DETERMINISM: eventGuard consults REAL event dates
// (FOMC / RBI / CPI windows). On those days the x0.5 sizing haircut or
// the T-30m entry blackout silently halved sized trades or blocked
// entries — these suites passed at authoring time and failed ONLY
// around FOMC/CPI. Neutral guard: the sizing/mandate/entry math under
// test is calendar-independent.
vi.mock('../server/ai/eventGuard.js', () => ({
  eventGuardCheck: () => ({ action: 'allow' }),
}));

vi.mock('../server/mcp/coindcx.js', () => ({
  coindcxPrivate: (...args) => mockPrivate(...args),
  coindcxConnected: () => mockConnected(),
  coindcxStatus: () => ({ connected: mockConnected() }),
}));
vi.mock('../server/cryptoStream.js', () => ({
  fetchCoinDcxTickers: vi.fn(async () => []),
}));

const mockWalletSnapshot = vi.fn();
const mockExecuteFutures = vi.fn();
const mockCloseFutures = vi.fn();
vi.mock('../server/ai/futures.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    walletSnapshot: (...a) => mockWalletSnapshot(...a),
    executeFuturesSignal: (...a) => mockExecuteFutures(...a),
    closeFuturesPosition: (...a) => mockCloseFutures(...a),
    fetchUsdInr: vi.fn(async () => 84),
  };
});

const mockGetSignals = vi.fn();
vi.mock('../server/ai/signals.js', () => ({
  getSignals: (...a) => mockGetSignals(...a),
  getFreshFuturesSignalForExec: vi.fn(async () => null),
  getFreshSignalForExec: vi.fn(async () => null),
  getFreshGlobalSignalForExec: vi.fn(async () => null),
}));

let _connected = false;
function mockConnected() { return _connected; }

import {
  agentStart, agentStop, agentTick, agentStatus, __resetAgentForTests, __setAgentStateForTests,
  AGENT_DEFAULTS, MANDATE_CAPS, freezeMandate, mandateEffectiveCfg, updateAgentConfig,
} from '../server/ai/agent.js';
import { __resetForTests, loadJournal, __setConfigForTests } from '../server/ai/coindcxOrders.js';
import { saveJSON, loadJSON as loadJSONOrig } from '../server/lib/store.js';

let _origCreds = null;

beforeEach(() => {
  __resetForTests();
  __resetAgentForTests();
  _connected = true;
  _origCreds = JSON.parse(JSON.stringify(loadJSONOrig('mcp-coindcx.json') || {}));
  saveJSON('mcp-coindcx.json', { apiKey: 'test-key', secret: 'test-secret', connectedAt: Date.now() });
  mockPrivate.mockReset();
  mockWalletSnapshot.mockReset().mockResolvedValue({
    ok: true, connected: true, usdInr: 84, equityINR: 26000,
    deployableFuturesUSDT: 200, deployableSpotINR: 5000, fetchedAt: Date.now(),
  });
  mockExecuteFutures.mockReset().mockResolvedValue({ ok: true, mode: 'paper', filled: { qty: 0.01, price: 100, leverage: 3, marginUSDT: 10 } });
  mockCloseFutures.mockReset().mockResolvedValue({ ok: true, position: { pnlINR: 0 } });
  mockGetSignals.mockReset().mockResolvedValue({ ok: true, market: 'FUTURES', signals: [], models: [] });
});

afterEach(() => {
  saveJSON('mcp-coindcx.json', _origCreds && _origCreds.apiKey != null ? _origCreds : { apiKey: null, secret: null });
});

// ---------------- pure freeze/clamp ----------------
describe('freezeMandate — the immutable session contract', () => {
  it('captures every risk cap with the config values', () => {
    const m = freezeMandate({ ...AGENT_DEFAULTS, mode: 'paper' }, 'paper');
    expect(Object.keys(m.caps).sort()).toEqual(Object.keys(MANDATE_CAPS).sort());
    expect(m.mode).toBe('paper');
    expect(m.caps.maxTradesPerDay).toBe(AGENT_DEFAULTS.maxTradesPerDay);
    expect(m.caps.riskPerTradePct).toBe(AGENT_DEFAULTS.riskPerTradePct);
    expect(Number.isFinite(m.frozenAt)).toBe(true);
  });

  it('the frozen object is DEEP-FROZEN — mutation attempts throw or are ignored', () => {
    const m = freezeMandate({ ...AGENT_DEFAULTS }, 'live');
    expect(Object.isFrozen(m)).toBe(true);
    expect(Object.isFrozen(m.caps)).toBe(true);
    expect(() => { 'use strict'; m.caps.riskPerTradePct = 99; }).toThrow();
    expect(m.caps.riskPerTradePct).toBe(AGENT_DEFAULTS.riskPerTradePct);
  });
});

describe('mandateEffectiveCfg — mid-session only STRICTER', () => {
  const mandate = { frozenAt: 1, mode: 'paper', caps: { ...AGENT_DEFAULTS } };

  it('LOOSENING is clamped back to the frozen value for every cap', () => {
    const looser = mandateEffectiveCfg({
      ...AGENT_DEFAULTS,
      maxTradesPerDay: 10,        // was 3
      riskPerTradePct: 8,         // was 1.5
      maxLeverage: 9,             // was 3
      dailyLossCapPct: 25,        // was 3 (later stand-down = looser)
      minEquityINR: 0,            // was 300 (no floor = looser)
      cooldownMin: 1,             // was 20
      maxHoldMin: 480,             // was 90
      minAiScore: 55,             // was 75
      minConfidence: 55,          // was 70 (v12.1 user spec)
      minAgreement: 0.5,          // was 0.65 (v10.16 S3)
      minRollingWinRate: 10,      // was 35
      quorumPenalty: 0,           // was 5 (v10.16: proportional cap)
    }, mandate);
    expect(looser.clamped.sort()).toEqual(Object.keys(MANDATE_CAPS).sort());
    expect(looser.cfg.maxTradesPerDay).toBe(3);
    expect(looser.cfg.riskPerTradePct).toBe(1.5);
    expect(looser.cfg.maxLeverage).toBe(3);
    expect(looser.cfg.dailyLossCapPct).toBe(3);
    expect(looser.cfg.minEquityINR).toBe(300);
    expect(looser.cfg.cooldownMin).toBe(20);
    expect(looser.cfg.maxHoldMin).toBe(90);
    expect(looser.cfg.minAiScore).toBe(75);
    expect(looser.cfg.minConfidence).toBe(70);
    expect(looser.cfg.minAgreement).toBe(0.65);
    expect(looser.cfg.minRollingWinRate).toBe(35);
    expect(looser.cfg.quorumPenalty).toBe(5);
  });

  it('TIGHTENING passes through untouched', () => {
    const tighter = mandateEffectiveCfg({
      ...AGENT_DEFAULTS,
      maxTradesPerDay: 1, riskPerTradePct: 0.5, maxLeverage: 1, dailyLossCapPct: 1,
      minEquityINR: 1000, cooldownMin: 60, maxHoldMin: 30, minAiScore: 85,
    }, mandate);
    expect(tighter.clamped).toEqual([]);
    expect(tighter.cfg.maxTradesPerDay).toBe(1);
    expect(tighter.cfg.riskPerTradePct).toBe(0.5);
    expect(tighter.cfg.minAiScore).toBe(85);
  });

  it('identical values → no clamping, config untouched', () => {
    const same = mandateEffectiveCfg({ ...AGENT_DEFAULTS }, mandate);
    expect(same.clamped).toEqual([]);
  });

  it('no mandate → passthrough (stopped agent honors config freely)', () => {
    const out = mandateEffectiveCfg({ ...AGENT_DEFAULTS, riskPerTradePct: 9 }, null);
    expect(out.cfg.riskPerTradePct).toBe(9);
    expect(out.clamped).toEqual([]);
  });
});

// ---------------- integration ----------------
describe('agentStart/Stop — the mandate lifecycle', () => {
  it('START freezes the mandate + journals the MANDATE audit entry', async () => {
    await agentStart({ mode: 'paper' });
    const j = loadJournal();
    const entries = j.entries.filter(e => e.kind === 'MANDATE' && e.source === 'agent');
    expect(entries.length).toBe(1);
    expect(entries[0].caps.riskPerTradePct).toBe(AGENT_DEFAULTS.riskPerTradePct);
    expect(String(entries[0].text)).toMatch(/MANDATE FROZEN/);
    // status exposes it
    const st = await agentStatus(null);
    expect(st.accuracy.mandate).toBeTruthy();
    expect(st.accuracy.mandate.caps.maxTradesPerDay).toBe(3);
  });

  it('STOP releases the mandate (status shows null); next START re-freezes current values', async () => {
    await agentStart({ mode: 'paper' });
    agentStop({ reason: 'test' });
    let st = await agentStatus(null);
    expect(st.accuracy.mandate).toBeNull();
    // user changes config while stopped…
    updateAgentConfig({ riskPerTradePct: 4, maxTradesPerDay: 6 });
    await agentStart({ mode: 'paper' });
    st = await agentStatus(null);
    expect(st.accuracy.mandate.caps.riskPerTradePct).toBe(4); // fresh freeze of CURRENT config
    expect(st.accuracy.mandate.caps.maxTradesPerDay).toBe(6);
  });

  it('a mid-session loosening is CLAMPED on the tick (log + effective behavior)', async () => {
    await agentStart({ mode: 'paper' }); // freezes risk 1.5%, trades 3
    // a qualifying candidate so the sizing line actually logs
    mockGetSignals.mockResolvedValue({
      ok: true, market: 'FUTURES', models: [],
      signals: [{
        symbol: 'BTC', market: 'FUTURES', side: 'LONG', grade: 'STRONG',
        confidence: 86, agreement: 0.82, executable: true, ltp: 50000,
        voters: 8, totalModels: 11, superIntel: { aiScore: 82 },
        plan: { entry: 50000, stopLoss: 48400, target1: 51600, target2: 53200, risk: 1600, riskPct: 3.2, rewardRisk: 2 },
      }],
    });
    // mid-session the config is loosened directly on disk
    updateAgentConfig({ riskPerTradePct: 9, maxLeverage: 10 });
    __setConfigForTests({ dailyMaxTrades: 50, dailyMaxLossINR: 1_000_000, maxRiskPct: 5, maxOrderINR: 1_000_000, maxOpenPositions: 50 });
    await agentTick({}, vi.fn());
    // the SIZING line in the agent log must use the CLAMPED risk (1.5% of 26000 = 390), not 9% (2340)
    const st = await agentStatus(null);
    const sizingLine = (st.state.log || []).map(l => l.text).find(t => /^SIZING /.test(String(t)));
    expect(sizingLine).toBeTruthy();
    expect(String(sizingLine)).toContain('₹390'); // 1.5% — mandate held
    // and the user's saved config is NOT overwritten by the clamp
    expect(Number(st.config.riskPerTradePct)).toBe(9);
  });
});
