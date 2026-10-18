// ============================================================
// test/nearMissAutoTrade.test.ts — v10.8 NEAR-MISS AUTO-TRADE
// + WINNER EXTENSION regression suite.
//
// LOCKED HERE:
//   • the gate: score inside the gap BELOW the bar + high conf +
//     full quorum + STRONG/ACTION grade + executable plan
//   • full qualifiers ALWAYS take priority over near-misses
//   • per-day near-miss budget (journal NEAR_MISS markers)
//   • config OFF / maxPerDay 0 → the exact old skip behavior
//   • winner-extension window math + eligibility rules
//   • the _tick integration: a near-miss signal actually ENTERS,
//     gets journal-tagged, and telegram carries the NEAR-MISS tag
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
    // v11.8.2 flake killer: getPositionsWithPnl prices FUTURES positions
    // through the REAL feed (8s timeout) — same live-network hazard the
    // depth/correlation mocks below remove. Empty rows = prices unknown,
    // the honest degrade the code already handles.
    fetchFuturesPrices: vi.fn(async () => []),
  };
});

const mockGetSignals = vi.fn();
vi.mock('../server/ai/signals.js', () => ({
  getSignals: (...a) => mockGetSignals(...a),
  getFreshFuturesSignalForExec: vi.fn(async () => null),
  getFreshSignalForExec: vi.fn(async () => null),
  getFreshGlobalSignalForExec: vi.fn(async () => null),
}));

// v11.8.2 FLAKE KILLER: readDepth does REAL CoinDCX→Binance fetches on
// the entry path (6s chain). Under a slow sandbox route the tick blows
// the 5s vitest budget, and the still-running zombie holds the agent's
// single-flight guard (`_ticking`) so every later test's agentTick
// no-ops — the "expected 1 times, got 0 times" cascade seen in 2 of 4
// full-suite runs. The depth layer has its own suites; here it degrades
// instantly (null → single-order honest path).
vi.mock('../server/ai/orderFlowDepth.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, readDepth: vi.fn(async () => null) };
});
// Same hazard class: pairCorrelation does 2 REAL Yahoo fetches when
// open positions exist (TIME-EXIT / TREND-FLIP fixtures). null =
// "unknown → allow", the guard's own documented contract.
vi.mock('../server/ai/correlation.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, pairCorrelation: vi.fn(async () => null) };
});

let _connected = false;
function mockConnected() { return _connected; }

import {
  agentTick, agentStart, updateAgentConfig, __resetAgentForTests, __setAgentStateForTests,
  AGENT_DEFAULTS, nearMissEntryGate, effectiveScoreBar, nearMissEntriesToday,
  effectiveHoldWindowMin, extensionEligible, loadAgentConfig,
} from '../server/ai/agent.js';
import { __resetForTests, __setJournalForTests, loadJournal, todayIST, __setConfigForTests } from '../server/ai/coindcxOrders.js';
import { saveJSON, loadJSON as loadJSONOrig } from '../server/lib/store.js';

// ---------------- fixtures ----------------
const BASE_CFG = { ...AGENT_DEFAULTS }; // v10.16: minAiScore 75, quorumPenalty 5 (proportional cap)

const nearMissSignal = (over = {}) => ({
  symbol: 'SOL', market: 'FUTURES', pair: 'B-SOL_USDT', side: 'LONG', grade: 'ACTION',
  confidence: 78, agreement: 0.7, executable: true, ltp: 142,
  voters: 8, totalModels: 11,
  superIntel: { aiScore: 68 }, // bar 75 → gap 7 ≤ 10
  plan: { entry: 142, stopLoss: 138, target1: 146, target2: 150, risk: 4, riskPct: 2.8, rewardRisk: 2 },
  ...over,
});
const fullQualSignal = nearMissSignal({
  symbol: 'BTC', pair: 'B-BTC_USDT', grade: 'STRONG', confidence: 86, agreement: 0.82,
  superIntel: { aiScore: 82 }, // ≥ 75 → fully qualifies
  plan: { entry: 50000, stopLoss: 48400, target1: 51600, target2: 53200, risk: 1600, riskPct: 3.2, rewardRisk: 2 },
});

const board = (signals) => ({
  ok: true, market: 'FUTURES', signals, models: [],
  breadth: { bull: signals.length, bear: 0, flat: 0, avgConf: 70 }, generatedAt: Date.now(),
});

const WALLET = {
  ok: true, connected: true, usdInr: 84,
  spot: { inr: { free: 5000, locked: 0, total: 5000 }, usdt: { free: 50, locked: 0, total: 50 }, error: null, rows: [] },
  futures: { usdt: { free: 200, locked: 0, total: 200, crossUserMargin: 0 }, error: null },
  equityINR: 26000,
  deployableFuturesUSDT: 200,
  deployableSpotINR: 5000,
  fetchedAt: Date.now(),
};

let _origCreds = null;

beforeEach(() => {
  __resetForTests();
  __resetAgentForTests();
  _connected = true;
  _origCreds = JSON.parse(JSON.stringify(loadJSONOrig('mcp-coindcx.json') || {}));
  saveJSON('mcp-coindcx.json', { apiKey: 'test-key', secret: 'test-secret', connectedAt: Date.now() });
  mockPrivate.mockReset();
  mockWalletSnapshot.mockReset().mockResolvedValue(WALLET);
  mockExecuteFutures.mockReset().mockResolvedValue({
    ok: true, mode: 'paper', filled: { qty: 1.1, price: 142, notionalUSDT: 156, leverage: 3, marginUSDT: 52 },
    position: { id: 'p1' },
  });
  mockCloseFutures.mockReset().mockResolvedValue({ ok: true, position: { pnlINR: 12 } });
  mockGetSignals.mockReset();
});

afterEach(() => {
  saveJSON('mcp-coindcx.json', _origCreds && _origCreds.apiKey != null ? _origCreds : { apiKey: null, secret: null });
});

// ---------------- pure gate ----------------
describe('nearMissEntryGate — the qualification math', () => {
  it('a signal inside the gap, high conf, full quorum → qualifies with exact numbers', () => {
    const g = nearMissEntryGate(BASE_CFG, nearMissSignal());
    expect(g).toBeTruthy();
    expect(g.aiScore).toBe(68);
    expect(g.needScore).toBe(75);
    expect(g.confidence).toBe(78);
    expect(g.voters).toBe(8);
  });

  it('a signal AT/over the bar is NOT a near-miss (it already qualifies)', () => {
    expect(nearMissEntryGate(BASE_CFG, nearMissSignal({ superIntel: { aiScore: 75 } }))).toBeNull();
    expect(nearMissEntryGate(BASE_CFG, nearMissSignal({ superIntel: { aiScore: 80 } }))).toBeNull();
  });

  it('too far below the bar → null (gap discipline)', () => {
    expect(nearMissEntryGate(BASE_CFG, nearMissSignal({ superIntel: { aiScore: 64 } }))).toBeNull(); // gap 11 > 10
    expect(nearMissEntryGate(BASE_CFG, nearMissSignal({ superIntel: { aiScore: 65 } }))).toBeTruthy(); // gap exactly 10
  });

  it('low confidence → null (high-conf is the user spec)', () => {
    expect(nearMissEntryGate(BASE_CFG, nearMissSignal({ confidence: 69 }))).toBeNull();
    expect(nearMissEntryGate(BASE_CFG, nearMissSignal({ confidence: 70 }))).toBeTruthy();
  });

  it('thin committee (<5 voters) → null (quorum honesty beats near-miss)', () => {
    expect(nearMissEntryGate(BASE_CFG, nearMissSignal({ voters: 4 }))).toBeNull();
  });

  it('thin committees see a PROPORTIONALLY higher bar (v10.16: +1.5/voter, capped +5 — no cliff)', () => {
    const s3 = nearMissSignal({ voters: 3, superIntel: { aiScore: 74 } });
    expect(effectiveScoreBar(BASE_CFG, s3)).toBe(78); // 75 + min(5, (5−3)×1.5) = 75 + 3
    expect(nearMissEntryGate(BASE_CFG, s3)).toBeNull(); // voters < 5 → quorum honesty beats near-miss
    const s4 = nearMissSignal({ voters: 4, superIntel: { aiScore: 74 } });
    expect(effectiveScoreBar(BASE_CFG, s4)).toBe(76.5); // 75 + 1.5
    const s1 = nearMissSignal({ voters: 1, superIntel: { aiScore: 74 } });
    expect(effectiveScoreBar(BASE_CFG, s1)).toBe(80); // 75 + min(5, 6) = 75 + 5 (cap)
    const s0 = nearMissSignal({ voters: 0 });
    expect(effectiveScoreBar(BASE_CFG, s0)).toBe(80); // 75 + 5
  });

  it("thresholdProfile 'flat' restores the legacy flat +quorumPenalty arm (A/B)", () => {
    const s = nearMissSignal({ voters: 3, superIntel: { aiScore: 74 } });
    expect(effectiveScoreBar({ ...BASE_CFG, thresholdProfile: 'flat', quorumPenalty: 10 }, s)).toBe(85); // legacy 75+10
  });

  it('full quorum (≥5 voters) → the base bar, no penalty', () => {
    expect(effectiveScoreBar(BASE_CFG, nearMissSignal({ voters: 5 }))).toBe(75);
    expect(effectiveScoreBar(BASE_CFG, nearMissSignal({ voters: 8 }))).toBe(75);
  });

  it('WATCH grade / non-executable / planless → null', () => {
    expect(nearMissEntryGate(BASE_CFG, nearMissSignal({ grade: 'WATCH' }))).toBeNull();
    expect(nearMissEntryGate(BASE_CFG, nearMissSignal({ executable: false }))).toBeNull();
    expect(nearMissEntryGate(BASE_CFG, nearMissSignal({ plan: null }))).toBeNull();
  });

  it('config OFF or maxPerDay 0 → the gate is sealed', () => {
    expect(nearMissEntryGate({ ...BASE_CFG, nearMissAutoTrade: false }, nearMissSignal())).toBeNull();
    expect(nearMissEntryGate({ ...BASE_CFG, nearMissMaxPerDay: 0 }, nearMissSignal())).toBeNull();
  });

  it('the gap window is config-tunable', () => {
    expect(nearMissEntryGate({ ...BASE_CFG, nearMissScoreGap: 3 }, nearMissSignal())).toBeNull();
    expect(nearMissEntryGate({ ...BASE_CFG, nearMissScoreGap: 20 }, nearMissSignal({ superIntel: { aiScore: 60 } }))).toBeTruthy();
  });
});

// ---------------- winner extension math ----------------
describe('winner extension — window + eligibility', () => {
  it('each extension adds extendPct% of the base window', () => {
    expect(effectiveHoldWindowMin(90, 0, 50)).toBe(90);
    expect(effectiveHoldWindowMin(90, 1, 50)).toBe(135);
    expect(effectiveHoldWindowMin(90, 2, 50)).toBe(180);
    expect(effectiveHoldWindowMin(60, 1, 100)).toBe(120);
  });

  it('only winners with room and no opposite signal extend', () => {
    const base = { enabled: true, extensions: 0, maxExtensions: 2, source: 'agent' };
    expect(extensionEligible({ ...base, pnlPct: 1.4, oppositeQualifying: false })).toBe(true);
    expect(extensionEligible({ ...base, pnlPct: -0.2, oppositeQualifying: false })).toBe(false); // loser
    expect(extensionEligible({ ...base, pnlPct: 0, oppositeQualifying: false })).toBe(false);     // flat
    expect(extensionEligible({ ...base, pnlPct: 5, oppositeQualifying: true })).toBe(false);      // flip beats extension
    expect(extensionEligible({ ...base, extensions: 2, pnlPct: 5, oppositeQualifying: false })).toBe(false); // budget spent
    expect(extensionEligible({ ...base, pnlPct: 5, oppositeQualifying: false, enabled: false })).toBe(false);
    expect(extensionEligible({ ...base, pnlPct: 5, oppositeQualifying: false, source: 'manual' })).toBe(false);
    expect(extensionEligible({ ...base, pnlPct: null, oppositeQualifying: false })).toBe(false);  // unknown pnl = no extension
  });
});

// ---------------- integration ----------------
describe('agentTick — near-miss auto-entry integration', () => {
  beforeEach(async () => {
    await agentStart({ mode: 'paper' });
    __setConfigForTests({ dailyMaxTrades: 50, dailyMaxLossINR: 1_000_000, maxRiskPct: 5, maxOrderINR: 1_000_000, maxOpenPositions: 50 });
  });

  it('no full qualifier + best near-miss → the agent ENTERS and journal-tags NEAR_MISS', async () => {
    mockGetSignals.mockResolvedValue(board([nearMissSignal()]));
    const telegram = vi.fn();
    await agentTick({}, telegram);
    expect(mockExecuteFutures).toHaveBeenCalledTimes(1);
    expect(mockExecuteFutures.mock.calls[0][0].symbol).toBe('SOL');
    expect(mockExecuteFutures.mock.calls[0][0].source).toBe('agent');
    // journal audit marker landed
    const j = loadJournal();
    const nm = j.entries.filter(e => e.kind === 'NEAR_MISS' && e.source === 'agent');
    expect(nm.length).toBe(1);
    expect(nm[0].symbol).toBe('SOL');
    expect(nm[0].aiScore).toBe(68);
    expect(nm[0].needScore).toBe(75);
    // telegram carries the NEAR-MISS tag
    expect(telegram).toHaveBeenCalledWith(expect.stringMatching(/NEAR-MISS/));
    // near-miss entries consume the SAME daily quota (they are real entries)
    expect(nearMissEntriesToday(j).length).toBe(1);
  });

  it('a full qualifier ALWAYS takes priority — near-miss never preempts it', async () => {
    mockGetSignals.mockResolvedValue(board([nearMissSignal(), fullQualSignal]));
    await agentTick({}, vi.fn());
    expect(mockExecuteFutures).toHaveBeenCalledTimes(1);
    expect(mockExecuteFutures.mock.calls[0][0].symbol).toBe('BTC'); // the 82-score qualifier
    expect(loadJournal().entries.filter(e => e.kind === 'NEAR_MISS')).toHaveLength(0);
  });

  it('per-day near-miss budget: 1/day default — a second near-miss cycle skips', async () => {
    mockGetSignals.mockResolvedValue(board([nearMissSignal()]));
    await agentTick({}, vi.fn());
    expect(mockExecuteFutures).toHaveBeenCalledTimes(1);
    // simulate the cooldown passing + quota reset for the next cycle
    __setAgentStateForTests({ ...loadStateFix(), lastEntryAt: Date.now() - 60 * 60_000, runningSince: Date.now() });
    mockExecuteFutures.mockClear();
    await agentTick({}, vi.fn());
    expect(mockExecuteFutures).not.toHaveBeenCalled(); // budget 1/1 used
    const j = loadJournal();
    expect(nearMissEntriesToday(j).length).toBe(1); // still exactly one marker
  });

  it('near-miss OFF → the exact legacy skip (no entry, diagnostics still recorded)', async () => {
    updateAgentConfig({ nearMissAutoTrade: false });
    mockGetSignals.mockResolvedValue(board([nearMissSignal()]));
    await agentTick({}, vi.fn());
    expect(mockExecuteFutures).not.toHaveBeenCalled();
    expect(loadJournal().entries.filter(e => e.kind === 'NEAR_MISS')).toHaveLength(0);
  });

  it('a near-miss that fails the risk cap or one-per-pair is skipped like any candidate', async () => {
    const j = loadJournal();
    j.positions.push({ id: 'x1', pair: 'B-SOL_USDT', market: 'FUTURES', side: 'LONG', status: 'OPEN', source: 'manual', openedAt: Date.now() });
    __setJournalForTests(j);
    mockGetSignals.mockResolvedValue(board([nearMissSignal()]));
    await agentTick({}, vi.fn());
    expect(mockExecuteFutures).not.toHaveBeenCalled(); // already positioned on SOL
  });

  it('config knobs round-trip through updateAgentConfig with clamps', () => {
    const cfg = updateAgentConfig({ nearMissScoreGap: 99, nearMissMinConfidence: 40, nearMissMaxPerDay: 2, winnerExtendPct: 30, winnerExtendMax: 1 });
    expect(cfg.nearMissScoreGap).toBe(20);  // clamped to max
    expect(cfg.nearMissMinConfidence).toBe(55);
    expect(cfg.nearMissMaxPerDay).toBe(2);
    expect(cfg.winnerExtendPct).toBe(30);
    expect(cfg.winnerExtendMax).toBe(1);
    const off = updateAgentConfig({ nearMissAutoTrade: false, winnerExtendEnabled: false });
    expect(off.nearMissAutoTrade).toBe(false);
    expect(off.winnerExtendEnabled).toBe(false);
    expect(loadAgentConfig().nearMissAutoTrade).toBe(false);
  });
});

// helper: preserve the reset agent config/state across the setState call
function loadStateFix() {
  // __setAgentStateForTests replaces state; rebuild a minimal running state
  return {
    runningSince: Date.now(), lastScanAt: null, scans: 0,
    lastEntryAt: null, lastEntryPair: null, lastWallet: null,
    pausedToday: null, lastSkip: null, alerted: {}, entryMeta: {},
    winRateDowngraded: null, lastNearMisses: [], futuresMarginAlerted: false,
    mandate: null, log: [],
  };
}
