// ============================================================
// test/indiaAgent.test.ts — v10.3 NSE SUPERINTELLIGENCE AUTO-AGENT
// ------------------------------------------------------------
// The India twin of test/agent.test.ts. Covers: config clamps, LIVE
// start arming (typed phrase + India risk settings + Dhan), the
// 3-trade daily quota + cross-agent accounting hygiene, cooldown,
// daily-loss stand-down, capital-based sizing, the NSE clock gates
// (entry window 09:30–15:00, EOD square-off 15:15, closed market),
// time-exit, trend-flip, AI-score + quorum gates, PRO partial-TP
// legs (T1/T2 + BE-lock) and the status payload shape.
// ============================================================
import { describe, it, expect, beforeEach, vi } from 'vitest';

// ---- controllable clock / market / price state ----
let _nseOpen = true;       // default: NSE open (weekday 09:15–15:30)
let _istMin = 10 * 60;     // default: 10:00 IST (inside the 09:30–15:00 entry window)
let _ltp = {};            // symbol → ltp for the partial-TP manager

// v10.17 CALENDAR DETERMINISM: eventGuard consults REAL event dates
// (FOMC / RBI / CPI windows). On those days the x0.5 sizing haircut or
// the T-30m entry blackout silently halved sized trades or blocked
// entries — these suites passed at authoring time and failed ONLY
// around FOMC/CPI. Neutral guard: the sizing/mandate/entry math under
// test is calendar-independent.
vi.mock('../server/ai/eventGuard.js', () => ({
  eventGuardCheck: () => ({ action: 'allow' }),
}));

vi.mock('../server/ai/data.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    isNseOpen: () => _nseOpen,
    fetchTVIndiaBatch: async (syms) => Object.fromEntries((syms || []).map(s => [s, { ltp: _ltp[s] ?? null }])),
  };
});

let _dhanConnected = false;
vi.mock('../server/ai/dhan.js', () => ({
  dhanConnected: () => _dhanConnected,
  dhanPlaceOrder: vi.fn(async () => ({ orderId: 'test-order-1' })),
  dhanCancelOrder: vi.fn(async () => ({ ok: true })),
}));

// signals.js mocked: the board the agent scans
const mockGetSignals = vi.fn();
const mockGetDeepSignal = vi.fn();
vi.mock('../server/ai/signals.js', () => ({
  getSignals: (...a) => mockGetSignals(...a),
  getDeepSignal: (...a) => mockGetDeepSignal(...a),
}));

// indiaOrders mocked at the agent boundary — the gauntlet itself has
// its own suite (aiOrders). istHM is controllable for the clock tests.
const mockExecuteIndia = vi.fn();
const mockCloseIndia = vi.fn();
vi.mock('../server/ai/indiaOrders.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    istHM: () => _istMin,
    executeIndiaSignal: (...a) => mockExecuteIndia(...a),
    closeIndiaPosition: (...a) => mockCloseIndia(...a),
  };
});

import {
  loadIndiaAgentConfig, updateIndiaAgentConfig, indiaAgentStart, indiaAgentStop,
  indiaAgentTick, indiaAgentStatus, indiaSizingPreview, __resetIndiaAgentForTests,
  INDIA_AGENT_DEFAULTS,
} from '../server/ai/indiaAgent.js';
import { __resetForTests, __setJournalForTests, loadJournal, todayIST, __setConfigForTests } from '../server/ai/coindcxOrders.js';

// ---------------- fixtures ----------------
const STRONG_IND = {
  symbol: 'RELIANCE', market: 'INDIA', side: 'LONG', grade: 'STRONG',
  confidence: 86, agreement: 0.82, executable: true, ltp: 2500,
  voters: 8, totalModels: 11, // full-committee quorum (thin-committee tested separately)
  plan: { entry: 2500, stopLoss: 2425, target1: 2575, target2: 2650, riskPct: 3, rewardRisk: 2 },
  superIntel: { aiScore: 78 },
};
const INDIA_BOARD = {
  ok: true, market: 'INDIA', signals: [STRONG_IND], models: [],
  breadth: { bull: 1, bear: 0, flat: 0, avgConf: 80 }, generatedAt: Date.now(),
};

const DEPS = { KEYS: {}, OPENAI_COMPAT: {} };

// an open india-agent paper position (journal shape from executeIndiaSignal)
function agentPosition(over = {}) {
  return {
    id: 'pos-1', pair: 'RELIANCE', symbol: 'RELIANCE', side: 'LONG', mode: 'paper', market: 'INDIA',
    source: 'india-agent', qty: 2, originalQty: 2, exitStage: 'ENTRY',
    entryPrice: 2500, notionalINR: 5000, sl: 2425, tp: 2575, tp2: 2650,
    initialRisk: 75, peakPrice: 2500, openedAt: Date.now(), status: 'OPEN',
    ...over,
  };
}

beforeEach(() => {
  __resetForTests();
  __resetIndiaAgentForTests();
  _nseOpen = true;
  _istMin = 10 * 60; // 10:00 IST
  _ltp = {};
  _dhanConnected = false;
  mockGetSignals.mockReset().mockResolvedValue(INDIA_BOARD);
  mockGetDeepSignal.mockReset().mockResolvedValue({ ok: true, signal: STRONG_IND });
  mockExecuteIndia.mockReset().mockResolvedValue({
    ok: true, mode: 'paper', filled: { qty: 2, price: 2500, notionalINR: 5000 },
  });
  mockCloseIndia.mockReset().mockImplementation(async (id, opts = {}) => {
    // honest partial vs full shape (the real contract)
    if (opts.qty != null && opts.qty < 2) {
      return { ok: true, partial: true, position: agentPosition({ qty: 2 - opts.qty, ...{ ...(opts._state || {}) } }), leg: { qty: opts.qty, price: _ltp.RELIANCE ?? 2600, pnlINR: (opts.qty * 100) } };
    }
    return { ok: true, position: agentPosition({ status: 'CLOSED', ...{ ...(opts._state || {}) } }) };
  });
});

// ============================================================
// config
// ============================================================
describe('india agent config', () => {
  it('defaults are the USER SPEC: 3 trades/day, paper, capital-risk sizing, NSE discipline', () => {
    const cfg = loadIndiaAgentConfig();
    expect(cfg.maxTradesPerDay).toBe(3);
    expect(cfg.mode).toBe('paper');
    expect(cfg.enabled).toBe(false);
    expect(cfg.riskPerTradePct).toBe(1.5);
    expect(cfg.cooldownMin).toBe(20);
    expect(cfg.dailyLossCapPct).toBe(3);
    expect(cfg.minAiScore).toBe(75);
    expect(cfg.minConfidence).toBe(60); // v10.16 S3 parity (was 80)
    expect(cfg.quorumPenalty).toBe(5); // v10.16 S3: proportional-penalty cap
    expect(cfg.thresholdProfile).toBe('proportional');
    expect(cfg.equityINR).toBe(10_000);
  });

  it('clamps every numeric field into its safe range', () => {
    const cfg = updateIndiaAgentConfig({
      maxTradesPerDay: 100, minAiScore: 99, minConfidence: 99, riskPerTradePct: 500,
      equityINR: -5000, cooldownMin: -5, dailyLossCapPct: 0.01, maxHoldMin: 5000,
    });
    expect(cfg.maxTradesPerDay).toBe(20);
    expect(cfg.minAiScore).toBe(95);
    expect(cfg.minConfidence).toBe(95);
    expect(cfg.riskPerTradePct).toBe(10);
    expect(cfg.equityINR).toBe(100);
    expect(cfg.cooldownMin).toBe(1);
    expect(cfg.dailyLossCapPct).toBe(0.5);
    expect(cfg.maxHoldMin).toBe(330); // NSE session ceiling — intraday stays intraday
  });

  it('keeps the T1+T2 split honest (≤90, runner ≥10)', () => {
    const cfg = updateIndiaAgentConfig({ tp1ClosePct: 80, tp2ClosePct: 80 });
    expect(cfg.tp1ClosePct + cfg.tp2ClosePct).toBeLessThanOrEqual(90);
    expect(cfg.runnerPct).toBeGreaterThanOrEqual(10);
  });

  it('config endpoint knob discipline: mode NEVER changes via update (start/stop own it)', () => {
    const cfg = updateIndiaAgentConfig({ mode: 'live', enabled: true });
    expect(cfg.mode).toBe('paper');
    expect(cfg.enabled).toBe(false);
  });
});

// ============================================================
// start / stop
// ============================================================
describe('indiaAgentStart / indiaAgentStop', () => {
  it('LIVE start REQUIRES the typed phrase', async () => {
    await expect(indiaAgentStart({ mode: 'live' })).rejects.toThrow(/liveConfirmPhrase="LIVE"/i);
  });

  it('LIVE start requires Dhan connected', async () => {
    _dhanConnected = false;
    await expect(indiaAgentStart({ mode: 'live', liveConfirmPhrase: 'LIVE' })).rejects.toThrow(/Dhan not connected/i);
  });

  it('LIVE start requires India risk arming (indiaMode live)', async () => {
    _dhanConnected = true;
    await expect(indiaAgentStart({ mode: 'live', liveConfirmPhrase: 'LIVE' })).rejects.toThrow(/India LIVE arming/i);
  });

  it('LIVE start succeeds with phrase + Dhan + India arming', async () => {
    _dhanConnected = true;
    __setConfigForTests({ indiaMode: 'live' });
    const r = await indiaAgentStart({ mode: 'live', liveConfirmPhrase: 'LIVE' });
    expect(r.ok).toBe(true);
    expect(r.config.mode).toBe('live');
    expect(r.config.enabled).toBe(true);
  });

  it('PAPER start needs nothing and enables the agent', async () => {
    const r = await indiaAgentStart({ mode: 'paper' });
    expect(r.ok).toBe(true);
    expect(r.config.mode).toBe('paper');
    expect(loadIndiaAgentConfig().enabled).toBe(true);
  });

  it('stop disables but keeps the config', async () => {
    await indiaAgentStart({ mode: 'paper' });
    const r = indiaAgentStop({ reason: 'test' });
    expect(r.ok).toBe(true);
    const cfg = loadIndiaAgentConfig();
    expect(cfg.enabled).toBe(false);
    expect(cfg.mode).toBe('paper');
  });
});

// ============================================================
// tick — entries, quota, gates
// ============================================================
describe('indiaAgentTick — entries + gates', () => {
  it('AUTO-ENTRY: a qualifying INDIA signal fires the gauntlet with capital sizing + agent source', async () => {
    await indiaAgentStart({ mode: 'paper' });
    await indiaAgentTick(DEPS, undefined);
    expect(mockExecuteIndia).toHaveBeenCalledTimes(1);
    const arg = mockExecuteIndia.mock.calls[0][0];
    expect(arg.symbol).toBe('RELIANCE');
    expect(arg.side).toBe('LONG');
    expect(arg.source).toBe('india-agent'); // cross-agent hygiene marker
    expect(arg.mode).toBe('paper');
    // sizing: min(venue ₹5000, risk 1.5% of ₹10k → ₹150/3% → ₹5000, 60% capital) = ₹5000
    expect(arg.qtyINR).toBe(5000);
    expect(typeof arg.getFreshIndiaSignal).toBe('function');
  });

  it('QUOTA: exactly 3 trades — the 4th never fires (execute NOT called)', async () => {
    await indiaAgentStart({ mode: 'paper' });
    __setJournalForTests({
      entries: Array.from({ length: 3 }, (_, i) => ({
        id: `e${i}`, ts: Date.now(), day: todayIST(), kind: 'ORDER', pair: 'RELIANCE', symbol: 'RELIANCE',
        market: 'INDIA', side: 'LONG', mode: 'paper', source: 'india-agent', status: 'FILLED',
      })),
      positions: [],
    });
    await indiaAgentTick(DEPS, undefined);
    expect(mockExecuteIndia).not.toHaveBeenCalled();
  });

  it('CROSS-AGENT HYGIENE: manual India trades + crypto agent trades do NOT consume the India agent quota', async () => {
    await indiaAgentStart({ mode: 'paper' });
    __setJournalForTests({
      entries: [
        { id: 'm1', ts: Date.now(), day: todayIST(), kind: 'ORDER', pair: 'TCS', symbol: 'TCS', market: 'INDIA', side: 'LONG', mode: 'paper', source: 'manual', status: 'FILLED' },
        { id: 'c1', ts: Date.now(), day: todayIST(), kind: 'ORDER', pair: 'B-BTC_USDT', symbol: 'BTC', market: 'FUTURES', side: 'LONG', mode: 'paper', source: 'agent', status: 'FILLED' },
      ],
      positions: [],
    });
    await indiaAgentTick(DEPS, undefined);
    expect(mockExecuteIndia).toHaveBeenCalledTimes(1);
  });

  it('COOLDOWN: no second entry within cooldown minutes of the last one', async () => {
    await indiaAgentStart({ mode: 'paper' });
    const st = loadJournal();
    // simulate an entry 5 minutes ago (cooldown 20m)
    const { __setIndiaAgentStateForTests } = await import('../server/ai/indiaAgent.js');
    __setIndiaAgentStateForTests({ lastEntryAt: Date.now() - 5 * 60_000 });
    await indiaAgentTick(DEPS, undefined);
    expect(mockExecuteIndia).not.toHaveBeenCalled();
  });

  it('LOSS CAP: agent-sourced losses ≥ dailyLossCapPct% of capital → stand-down for the day', async () => {
    await indiaAgentStart({ mode: 'paper' });
    __setJournalForTests({
      entries: [
        { id: 't1', ts: Date.now(), day: todayIST(), kind: 'ORDER', pair: 'RELIANCE', symbol: 'RELIANCE', market: 'INDIA', side: 'LONG', mode: 'paper', source: 'india-agent', status: 'FILLED' },
        { id: 'c1', ts: Date.now(), day: todayIST(), kind: 'CLOSE', pair: 'RELIANCE', symbol: 'RELIANCE', market: 'INDIA', mode: 'paper', source: 'india-agent', pnlINR: -400 },
      ],
      positions: [],
    });
    await indiaAgentTick(DEPS, undefined);
    expect(mockExecuteIndia).not.toHaveBeenCalled();
    const st = await indiaAgentStatus(DEPS);
    expect(st.today.paused).toMatchObject({ day: todayIST() });
    expect(st.today.paused.reason).toMatch(/daily loss cap/i);
  });

  it('KILL SWITCH: the agent stands down instantly', async () => {
    __setConfigForTests({ killSwitch: true });
    await indiaAgentStart({ mode: 'paper' });
    await indiaAgentTick(DEPS, undefined);
    expect(mockExecuteIndia).not.toHaveBeenCalled();
  });

  it('AI-SCORE GATE: a 76-AI-score ACTION signal (68% conf, not executable) STILL fires the entry', async () => {
    await indiaAgentStart({ mode: 'paper' });
    mockGetSignals.mockResolvedValue({
      ok: true, market: 'INDIA', signals: [{
        ...STRONG_IND, grade: 'ACTION', confidence: 68, agreement: 0.6, executable: false,
        superIntel: { aiScore: 76 },
      }], models: [], generatedAt: Date.now(),
    });
    await indiaAgentTick(DEPS, undefined);
    expect(mockExecuteIndia).toHaveBeenCalledTimes(1);
  });

  it('AI-SCORE GATE below bar: 70 AI score + 68% conf ACTION → no entry', async () => {
    await indiaAgentStart({ mode: 'paper' });
    mockGetSignals.mockResolvedValue({
      ok: true, market: 'INDIA', signals: [{
        ...STRONG_IND, grade: 'ACTION', confidence: 68, agreement: 0.6, executable: false,
        superIntel: { aiScore: 70 },
      }], models: [], generatedAt: Date.now(),
    });
    await indiaAgentTick(DEPS, undefined);
    expect(mockExecuteIndia).not.toHaveBeenCalled();
  });

  it('QUORUM PENALTY: a thin committee (2 voters) needs minAiScore + 10 to fire', async () => {
    await indiaAgentStart({ mode: 'paper' });
    // 78 AI score, only 2 voters, NOT STRONG-committee qualifying → needs 85 → blocked
    mockGetSignals.mockResolvedValue({
      ok: true, market: 'INDIA', signals: [{
        ...STRONG_IND, grade: 'ACTION', confidence: 68, agreement: 0.6, executable: false,
        voters: 2, totalModels: 11,
      }], models: [], generatedAt: Date.now(),
    });
    await indiaAgentTick(DEPS, undefined);
    expect(mockExecuteIndia).not.toHaveBeenCalled();
    // 86 AI score with 2 voters → clears the 85 bar → fires
    mockGetSignals.mockResolvedValue({
      ok: true, market: 'INDIA', signals: [{
        ...STRONG_IND, grade: 'ACTION', confidence: 68, agreement: 0.6, executable: false,
        voters: 2, totalModels: 11, superIntel: { aiScore: 86 },
      }], models: [], generatedAt: Date.now(),
    });
    await indiaAgentTick(DEPS, undefined);
    expect(mockExecuteIndia).toHaveBeenCalledTimes(1);
  });

  it('one-per-symbol parity: an existing OPEN India position on the candidate blocks entry', async () => {
    await indiaAgentStart({ mode: 'paper' });
    __setJournalForTests({
      entries: [],
      positions: [agentPosition({ source: 'manual' })], // even a MANUAL one blocks
    });
    await indiaAgentTick(DEPS, undefined);
    expect(mockExecuteIndia).not.toHaveBeenCalled();
  });

  it('risk-cap filter: a plan risking more than venue maxRiskPct is skipped', async () => {
    __setConfigForTests({ maxRiskPct: 3 });
    await indiaAgentStart({ mode: 'paper' });
    mockGetSignals.mockResolvedValue({
      ok: true, market: 'INDIA', signals: [{ ...STRONG_IND, plan: { ...STRONG_IND.plan, riskPct: 7 } }], models: [], generatedAt: Date.now(),
    });
    await indiaAgentTick(DEPS, undefined);
    expect(mockExecuteIndia).not.toHaveBeenCalled();
  });
});

// ============================================================
// tick — the NSE clock gates (the India-specific discipline)
// ============================================================
describe('indiaAgentTick — NSE clock discipline', () => {
  it('NSE CLOSED: weekend/evening → agent idle, no scan-driven entry', async () => {
    await indiaAgentStart({ mode: 'paper' });
    _nseOpen = false;
    await indiaAgentTick(DEPS, undefined);
    expect(mockExecuteIndia).not.toHaveBeenCalled();
    const st = await indiaAgentStatus(DEPS);
    expect(st.blockers.some(b => b.key === 'nse_closed')).toBe(true);
  });

  it('ENTRY WINDOW: 09:20 (before the opening-chop gate) → no entry even though NSE is open', async () => {
    await indiaAgentStart({ mode: 'paper' });
    _istMin = 9 * 60 + 20; // 09:20
    await indiaAgentTick(DEPS, undefined);
    expect(mockExecuteIndia).not.toHaveBeenCalled();
  });

  it('ENTRY WINDOW: 15:05 (late-entry gate) → no entry, square-off 15:15 ahead', async () => {
    await indiaAgentStart({ mode: 'paper' });
    _istMin = 15 * 60 + 5;
    await indiaAgentTick(DEPS, undefined);
    expect(mockExecuteIndia).not.toHaveBeenCalled();
  });

  it('EOD SQUARE-OFF (15:16): open agent positions force-closed + no entries', async () => {
    await indiaAgentStart({ mode: 'paper' });
    _istMin = 15 * 60 + 16;
    _nseOpen = true; // 15:16 is still inside isNseOpen's 09:15–15:30 window
    __setJournalForTests({ entries: [], positions: [agentPosition()] });
    await indiaAgentTick(DEPS, undefined);
    expect(mockCloseIndia).toHaveBeenCalledTimes(1);
    expect(String(mockCloseIndia.mock.calls[0][1]?.reason || '')).toMatch(/EOD-SQUARE-OFF/i);
    expect(mockExecuteIndia).not.toHaveBeenCalled();
  });
});

// ============================================================
// tick — exits
// ============================================================
describe('indiaAgentTick — exits', () => {
  it('TIME-EXIT: an aging agent position is closed, not left to drift', async () => {
    await indiaAgentStart({ mode: 'paper' });
    __setJournalForTests({
      entries: [],
      positions: [agentPosition({ openedAt: Date.now() - 120 * 60_000 })], // 120m old > 90m window
    });
    await indiaAgentTick(DEPS, undefined);
    expect(mockCloseIndia).toHaveBeenCalledTimes(1);
    expect(String(mockCloseIndia.mock.calls[0][1]?.reason || '')).toMatch(/TIME-EXIT/i);
    expect(mockExecuteIndia).not.toHaveBeenCalled(); // quota not needed — exits first
  });

  it('TREND-FLIP: board flips opposite on a held symbol → position cut + cooldown stamped', async () => {
    await indiaAgentStart({ mode: 'paper' });
    __setJournalForTests({ entries: [], positions: [agentPosition()] });
    mockGetSignals.mockResolvedValue({
      ok: true, market: 'INDIA', signals: [{
        ...STRONG_IND, side: 'SHORT', // qualifying OPPOSITE signal on RELIANCE
      }], models: [], generatedAt: Date.now(),
    });
    await indiaAgentTick(DEPS, undefined);
    const flipCall = mockCloseIndia.mock.calls.find(c => /TREND-FLIP/i.test(String(c[1]?.reason || '')));
    expect(flipCall).toBeTruthy();
    expect(mockExecuteIndia).not.toHaveBeenCalled(); // cooldown stamped by the flip
  });

  it('T1 PARTIAL: price at target1 → 40% leg booked (partial close), position survives for the runner', async () => {
    await indiaAgentStart({ mode: 'paper' });
    const pos = agentPosition({ qty: 10, originalQty: 10 });
    __setJournalForTests({ entries: [], positions: [pos] });
    _ltp = { RELIANCE: 2600 }; // >= tp 2575
    await indiaAgentTick(DEPS, undefined);
    const t1Call = mockCloseIndia.mock.calls.find(c => /T1 PARTIAL/i.test(String(c[1]?.reason || '')));
    expect(t1Call).toBeTruthy();
    expect(t1Call[1].qty).toBe(4); // 40% of original 10
  });

  it('T2 PARTIAL: only fires after T1 booked (tp1Hit) — never before', async () => {
    await indiaAgentStart({ mode: 'paper' });
    const pos = agentPosition({ qty: 10, originalQty: 10, tp1Hit: true, exitStage: 'T1_HIT' });
    __setJournalForTests({ entries: [], positions: [pos] });
    _ltp = { RELIANCE: 2700 }; // >= tp2 2650
    await indiaAgentTick(DEPS, undefined);
    const t2Call = mockCloseIndia.mock.calls.find(c => /T2 PARTIAL/i.test(String(c[1]?.reason || '')));
    expect(t2Call).toBeTruthy();
    expect(t2Call[1].qty).toBe(4); // 40% of original 10
  });

  it('T2 skipped when T1 has NOT booked (no jumping tiers)', async () => {
    await indiaAgentStart({ mode: 'paper' });
    const pos = agentPosition({ qty: 10, originalQty: 10 }); // tp1Hit not set
    __setJournalForTests({ entries: [], positions: [pos] });
    _ltp = { RELIANCE: 2700 };
    await indiaAgentTick(DEPS, undefined);
    const t2Call = mockCloseIndia.mock.calls.find(c => /T2 PARTIAL/i.test(String(c[1]?.reason || '')));
    expect(t2Call).toBeFalsy();
    // T1 fires instead (price above both)
    const t1Call = mockCloseIndia.mock.calls.find(c => /T1 PARTIAL/i.test(String(c[1]?.reason || '')));
    expect(t1Call).toBeTruthy();
  });
});

// ============================================================
// sizing preview (pure)
// ============================================================
describe('indiaSizingPreview', () => {
  it('sizes whole shares from the capital: risk budget → notional, venue-capped', () => {
    const p = indiaSizingPreview({
      cfg: { ...INDIA_AGENT_DEFAULTS, equityINR: 20_000, riskPerTradePct: 1.5 },
      plan: { entry: 500, stopLoss: 480, riskPct: 4 },
      trading: { indiaMaxOrderINR: 5000 },
    });
    // riskINR = 300; budget = min(5000, 300/4*100=7500, 60% of 20k=12000) = 5000 → 10 shares
    expect(p.desk).toBe('INDIA');
    expect(p.riskINR).toBe(300);
    expect(p.budgetINR).toBe(5000);
    expect(p.qty).toBe(10);
    expect(p.note).toMatch(/₹300 risk/);
  });

  it('no plan → honest wait note, no fake numbers', () => {
    const p = indiaSizingPreview({ cfg: INDIA_AGENT_DEFAULTS, plan: null, trading: {} });
    expect(p.desk).toBeNull();
    expect(p.note).toMatch(/intezaar/i);
  });
});

// ============================================================
// status payload (the panel's single call)
// ============================================================
describe('indiaAgentStatus', () => {
  it('returns the complete panel payload without throwing', async () => {
    await indiaAgentStart({ mode: 'paper' });
    const st = await indiaAgentStatus(DEPS);
    expect(st.ok).toBe(true);
    expect(st.engine).toMatch(/NSE SUPERINTELLIGENCE/i);
    expect(st.market).toMatchObject({ nseOpen: true, entryWindowOpen: true, squareOffNow: false });
    expect(st.state.running).toBe(true);
    expect(st.state.tickSec).toBe(30);
    expect(Array.isArray(st.state.log)).toBe(true);
    expect(st.today.maxTrades).toBe(3);
    expect(Array.isArray(st.openPositions)).toBe(true);
    expect(Array.isArray(st.picks)).toBe(true);
    expect(Array.isArray(st.blockers)).toBe(true);
    expect(st.accuracy.quorumAwareEntry).toBe(true);
  });

  it('stopped agent → disabled blocker shown; NSE closed → market blocker', async () => {
    _nseOpen = false;
    const st = await indiaAgentStatus(DEPS);
    expect(st.blockers.some(b => b.key === 'disabled')).toBe(true);
    expect(st.market.nseOpen).toBe(false);
  });

  it('quota done → blocker carries the count', async () => {
    await indiaAgentStart({ mode: 'paper' });
    __setJournalForTests({
      entries: Array.from({ length: 3 }, (_, i) => ({
        id: `q${i}`, ts: Date.now(), day: todayIST(), kind: 'ORDER', pair: 'RELIANCE', symbol: 'RELIANCE',
        market: 'INDIA', side: 'LONG', mode: 'paper', source: 'india-agent', status: 'FILLED',
      })),
      positions: [],
    });
    const st = await indiaAgentStatus(DEPS);
    expect(st.today.tradesCount).toBe(3);
    const b = st.blockers.find(x => x.key === 'quota');
    expect(b).toBeTruthy();
    expect(b.text).toMatch(/3\/3/);
  });

  it('running agent inside the window with healthy capital → NO hard blockers', async () => {
    await indiaAgentStart({ mode: 'paper' });
    const st = await indiaAgentStatus(DEPS);
    const hard = st.blockers.filter(b => !b.soft);
    expect(hard.length).toBe(0);
  });
});
