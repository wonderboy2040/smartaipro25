// ============================================================
// test/v101AgentAccuracy.test.ts — Track-B ACCURACY UPGRADE
// ------------------------------------------------------------
// Pins the 4 agent-specific accuracy improvements:
//   B1 quorum-aware minAiScore (thin committees need MORE conviction)
//   B2 ATR-adaptive dynamic time-exit windows
//   B3 rolling win-rate self-downgrade (LIVE → paper, soft)
//   B4 correlation guard on concurrent positions
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
  coindcxConnected: () => true,
  coindcxStatus: () => ({ connected: true }),
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
    // orderFlowDepth mock below removes. Empty rows = prices unknown,
    // the honest degrade the code already handles.
    fetchFuturesPrices: vi.fn(async () => []),
  };
});

const mockGetSignals = vi.fn();
vi.mock('../server/ai/signals.js', () => ({
  getSignals: (...a) => mockGetSignals(...a),
  getFreshFuturesSignalForExec: vi.fn(async () => null),
  getFreshSignalForExec: vi.fn(async () => null),
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

// B4: correlation fetch fully mocked (network has no place here)
const mockPairCorrelation = vi.fn();
vi.mock('../server/ai/correlation.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    pairCorrelation: (...a) => mockPairCorrelation(...a),
  };
});

import {
  loadAgentConfig, updateAgentConfig, agentStart, agentTick, agentStatus,
  __resetAgentForTests, __setAgentStateForTests, dynamicMaxHoldMin,
  recentAgentTrades, rollingAgentWinRate, AGENT_DEFAULTS,
} from '../server/ai/agent.js';
import { __resetForTests, __setJournalForTests, loadJournal, todayIST, __setConfigForTests } from '../server/ai/coindcxOrders.js';
import { saveJSON, loadJSON as loadJSONOrig } from '../server/lib/store.js';

const WALLET = {
  equityINR: 26000, usdInr: 84, deployableFuturesUSDT: 200, deployableSpotINR: 8000, fetchedAt: Date.now(),
};

const mkSignal = (over = {}) => ({
  symbol: 'BTC', market: 'FUTURES', pair: 'B-BTC_USDT', side: 'LONG', grade: 'STRONG',
  confidence: 86, agreement: 0.82, executable: true, ltp: 50000, voters: 8, totalModels: 11,
  superIntel: { aiScore: 78 },
  plan: { entry: 50000, stopLoss: 48400, target1: 51600, target2: 53200, risk: 1600, riskPct: 3.2, rewardRisk: 2, atrUsed: 500 },
  ...over,
});
const boardOf = (...signals) => ({ ok: true, market: 'FUTURES', signals });

let _origCreds;

beforeEach(() => {
  __resetForTests();
  __resetAgentForTests();
  _origCreds = JSON.parse(JSON.stringify(loadJSONOrig('mcp-coindcx.json') || {}));
  saveJSON('mcp-coindcx.json', { apiKey: 'test-key', secret: 'test-secret', connectedAt: Date.now() });
  mockPrivate.mockReset();
  mockWalletSnapshot.mockReset().mockResolvedValue(WALLET);
  mockExecuteFutures.mockReset().mockResolvedValue({
    ok: true, mode: 'paper', filled: { qty: 0.006, price: 50000, leverage: 3, marginUSDT: 100 },
  });
  mockCloseFutures.mockReset().mockResolvedValue({ ok: true, position: { pnlINR: 50 } });
  mockGetSignals.mockReset().mockResolvedValue(boardOf(mkSignal()));
  mockPairCorrelation.mockReset().mockResolvedValue(null); // default: unknown → allow
});

afterEach(() => {
  saveJSON('mcp-coindcx.json', _origCreds && _origCreds.apiKey != null ? _origCreds : { apiKey: null, secret: null });
});

// ============================================================
// B2 — dynamicMaxHoldMin (pure)
// ============================================================
describe('B2 dynamicMaxHoldMin', () => {
  it('fast mover (ATR% ≥ 2.5) exits at HALF the base window', () => {
    expect(dynamicMaxHoldMin({ maxHoldMin: 90 }, 3)).toBe(45);
    expect(dynamicMaxHoldMin({ maxHoldMin: 90 }, 5)).toBe(45);
  });
  it('slow mover (ATR% ≤ 0.8) gets a THIRD longer, floored at 120', () => {
    expect(dynamicMaxHoldMin({ maxHoldMin: 90 }, 0.5)).toBe(120);
    expect(dynamicMaxHoldMin({ maxHoldMin: 120 }, 0.6)).toBe(160);
  });
  it('mid volatility keeps the base window', () => {
    expect(dynamicMaxHoldMin({ maxHoldMin: 90 }, 1.5)).toBe(90);
  });
  it('no ATR data → base window (honest default, no guess)', () => {
    expect(dynamicMaxHoldMin({ maxHoldMin: 90 }, null)).toBe(90);
    expect(dynamicMaxHoldMin({ maxHoldMin: 90 }, NaN)).toBe(90);
    expect(dynamicMaxHoldMin({ maxHoldMin: 90 }, 0)).toBe(90); // 0 is not a volatility
    expect(dynamicMaxHoldMin({}, null)).toBe(90); // missing base defaults 90
  });
  it('window clamps to [15, 240] — no absurd 5-minute or day-long exits', () => {
    expect(dynamicMaxHoldMin({ maxHoldMin: 20 }, 3)).toBe(15);
    expect(dynamicMaxHoldMin({ maxHoldMin: 200 }, 0.5)).toBe(240);
  });

  it('time-exit honors the per-position window: fast mover cut at 50m (base 90m)', async () => {
    await agentStart({ mode: 'paper' });
    __setConfigForTests({ dailyMaxTrades: 50, dailyMaxLossINR: 1_000_000, maxRiskPct: 5, maxOrderINR: 1_000_000, maxOpenPositions: 50 });
    const j = loadJournal();
    j.positions.push({
      id: 'fast1', pair: 'B-BTC_USDT', market: 'FUTURES', side: 'LONG', mode: 'paper',
      source: 'agent', status: 'OPEN', qty: 0.01, entryPrice: 50000,
      openedAt: Date.now() - 50 * 60_000, // 50m — past the 45m fast window, under the 90m base
    });
    __setJournalForTests(j);
    __setAgentStateForTests({
      entryMeta: { 'B-BTC_USDT': { atrPct: 3.2, at: Date.now() } }, // fast mover recorded at entry
      runningSince: Date.now(), lastScanAt: Date.now(), scans: 1, lastEntryAt: null, lastEntryPair: null, lastWallet: null, pausedToday: null, lastSkip: null, alerted: {}, winRateDowngraded: null, log: [],
    });
    mockGetSignals.mockResolvedValue({ ok: true, market: 'FUTURES', signals: [] }); // no fresh candidates needed
    await agentTick({}, vi.fn());
    expect(mockCloseFutures).toHaveBeenCalledWith('fast1');
  });

  it('slow mover is NOT cut at 50m (its window is 120m)', async () => {
    await agentStart({ mode: 'paper' });
    __setConfigForTests({ dailyMaxTrades: 50, dailyMaxLossINR: 1_000_000, maxRiskPct: 5, maxOrderINR: 1_000_000, maxOpenPositions: 50 });
    const j = loadJournal();
    j.positions.push({
      id: 'slow1', pair: 'B-BTC_USDT', market: 'FUTURES', side: 'LONG', mode: 'paper',
      source: 'agent', status: 'OPEN', qty: 0.01, entryPrice: 50000,
      openedAt: Date.now() - 50 * 60_000, // 50m — under the 120m slow window
    });
    __setJournalForTests(j);
    __setAgentStateForTests({
      entryMeta: { 'B-BTC_USDT': { atrPct: 0.5, at: Date.now() } },
      runningSince: Date.now(), lastScanAt: Date.now(), scans: 1, lastEntryAt: null, lastEntryPair: null, lastWallet: null, pausedToday: null, lastSkip: null, alerted: {}, winRateDowngraded: null, log: [],
    });
    mockGetSignals.mockResolvedValue({ ok: true, market: 'FUTURES', signals: [] });
    await agentTick({}, vi.fn());
    expect(mockCloseFutures).not.toHaveBeenCalled();
  });

  it('entry records the ATR% in state and the status exposes the window override', async () => {
    await agentStart({ mode: 'paper' });
    __setConfigForTests({ dailyMaxTrades: 50, dailyMaxLossINR: 1_000_000, maxRiskPct: 5, maxOrderINR: 1_000_000, maxOpenPositions: 50 });
    await agentTick({}, vi.fn()); // fires the BTC entry (atr 500/50000 = 1% → mid → base window)
    expect(mockExecuteFutures).toHaveBeenCalledTimes(1);
    const st = await agentStatus(null);
    expect(st.accuracy.dynamicTimeExit).toBe(true);
    expect(Array.isArray(st.accuracy.openWindowOverrides)).toBe(true);
    const rec = st.accuracy.openWindowOverrides.find(o => o.pair === 'B-BTC_USDT');
    expect(rec).toBeTruthy();
    expect(rec.atrPct).toBeGreaterThan(0);
    expect(rec.windowMin).toBeGreaterThan(0);
  });

  it('dynamicTimeExit=false restores the fixed window for everyone (tick level)', async () => {
    updateAgentConfig({ dynamicTimeExit: false });
    await agentStart({ mode: 'paper' });
    __setConfigForTests({ dailyMaxTrades: 50, dailyMaxLossINR: 1_000_000, maxRiskPct: 5, maxOrderINR: 1_000_000, maxOpenPositions: 50 });
    const j = loadJournal();
    j.positions.push({
      id: 'fast2', pair: 'B-BTC_USDT', market: 'FUTURES', side: 'LONG', mode: 'paper',
      source: 'agent', status: 'OPEN', qty: 0.01, entryPrice: 50000,
      openedAt: Date.now() - 50 * 60_000, // 50m — would die at the 45m fast window
    });
    __setJournalForTests(j);
    __setAgentStateForTests({
      entryMeta: { 'B-BTC_USDT': { atrPct: 3.2, at: Date.now() } },
      runningSince: Date.now(), lastScanAt: Date.now(), scans: 1, lastEntryAt: null, lastEntryPair: null, lastWallet: null, pausedToday: null, lastSkip: null, alerted: {}, winRateDowngraded: null, log: [],
    });
    mockGetSignals.mockResolvedValue({ ok: true, market: 'FUTURES', signals: [] });
    await agentTick({}, vi.fn());
    expect(mockCloseFutures).not.toHaveBeenCalled(); // 50m < 90m base — toggle works
    const st = await agentStatus(null);
    expect(st.accuracy.dynamicTimeExit).toBe(false);
  });
});

// ============================================================
// B1 — quorum-aware entry threshold
// ============================================================
describe('B1 quorum-aware minAiScore', () => {
  beforeEach(async () => {
    await agentStart({ mode: 'paper' });
    __setConfigForTests({ dailyMaxTrades: 50, dailyMaxLossINR: 1_000_000, maxRiskPct: 5, maxOrderINR: 1_000_000, maxOpenPositions: 50 });
  });

  it('FULL committee (voters 8) at AI 78 ≥ 75 → entry fires', async () => {
    mockGetSignals.mockResolvedValue(boardOf(mkSignal({ voters: 8 })));
    await agentTick({}, vi.fn());
    expect(mockExecuteFutures).toHaveBeenCalledTimes(1);
  });

  it('THIN committee (voters 3) at AI 76 needs 75+3=78 (v10.16 proportional) → NO entry', async () => {
    // v10.16: the bar is +1.5/voter below 5 (3 voters → +3 = 78), not flat
    // +10. Path B deliberately closed here (ACTION grade) to isolate the
    // AI-score bar; near-miss is also closed by quorum honesty (voters < 5).
    mockGetSignals.mockResolvedValue(boardOf(mkSignal({ voters: 3, superIntel: { aiScore: 76 }, grade: 'ACTION', confidence: 70, agreement: 0.9 })));
    await agentTick({}, vi.fn());
    expect(mockExecuteFutures).not.toHaveBeenCalled();
  });

  it('v10.16 no-cliff: voters 3 at AI 78 = exactly the 78 bar → entry fires (the flat +10 cliff is gone)', async () => {
    // a 3-voter committee (one honest abstain) no longer faces 85 —
    // 75 + min(5, (5−3)×1.5) = 78, and 78 ≥ 78 qualifies (Path B closed
    // so this proves the AI-score path itself).
    mockGetSignals.mockResolvedValue(boardOf(mkSignal({ voters: 3, superIntel: { aiScore: 78 }, grade: 'ACTION', confidence: 70, agreement: 0.9 })));
    await agentTick({}, vi.fn());
    expect(mockExecuteFutures).toHaveBeenCalledTimes(1);
  });

  it('thin committee at AI 88 (≥ the 78 bar) still enters — the bar is higher, not a wall', async () => {
    mockGetSignals.mockResolvedValue(boardOf(mkSignal({ voters: 3, superIntel: { aiScore: 88 } })));
    await agentTick({}, vi.fn());
    expect(mockExecuteFutures).toHaveBeenCalledTimes(1);
  });

  it('legacy STRONG bar is unchanged (still a valid path)', async () => {
    mockGetSignals.mockResolvedValue(boardOf(mkSignal({
      voters: 3, superIntel: { aiScore: 0 }, // AI path blocked (thin)…
      grade: 'STRONG', executable: true, confidence: 86, agreement: 0.82, // …STRONG path open
    })));
    await agentTick({}, vi.fn());
    expect(mockExecuteFutures).toHaveBeenCalledTimes(1);
  });

  it('status exposes the quorum-aware bars for the panel', async () => {
    const st = await agentStatus(null);
    expect(st.accuracy.quorumAwareEntry).toBe(true);
    expect(st.accuracy.effectiveMinAiScore).toBe(AGENT_DEFAULTS.minAiScore);
    // v10.16: worst-case thin bar (voters ≤ 1) = 75 + cap 5 = 80 (was flat +10 = 85)
    expect(st.accuracy.thinCommitteeMinAiScore).toBe(80);
  });
});

// ============================================================
// B3 — rolling win-rate self-downgrade
// ============================================================
describe('B3 rolling win-rate self-downgrade', () => {
  beforeEach(async () => {
    __setConfigForTests({ dailyMaxTrades: 50, dailyMaxLossINR: 1_000_000, maxRiskPct: 5, maxOrderINR: 1_000_000, maxOpenPositions: 50 });
  });

  const journalWithClosedAgentTrades = (wins, total) => {
    const j = loadJournal();
    for (let i = 0; i < total; i++) {
      j.positions.push({
        id: `cl${i}`, pair: `B-C${i}_USDT`, market: 'FUTURES', side: 'LONG', mode: 'live',
        source: 'agent', status: 'CLOSED', closedAt: Date.now() - i * 3600_000,
        pnlINR: i < wins ? 100 : -80, bookedPnlINR: 0,
      });
    }
    return j;
  };

  it('rollingAgentWinRate counts TOTAL pnl (booked legs included) and refuses <N samples', () => {
    expect(rollingAgentWinRate(journalWithClosedAgentTrades(0, 5), 10)).toBeNull(); // 5 < 10 → noise discipline
    expect(rollingAgentWinRate(journalWithClosedAgentTrades(3, 10), 10)).toBe(30);
    const withBooked = loadJournal();
    withBooked.positions.push({ id: 'b1', source: 'agent', status: 'CLOSED', closedAt: Date.now(), pnlINR: -20, bookedPnlINR: 60 });
    // single trade with booked legs is a WIN by total — but N=1 sample still null
    expect(rollingAgentWinRate(withBooked, 1)).toBe(100);
  });

  it('LIVE agent with last-10 win-rate 30% < 35% floor → self-downgrades to PAPER + Telegram alert', async () => {
    __setConfigForTests({ mode: 'live', allowAuto: true, dailyMaxTrades: 50, dailyMaxLossINR: 1_000_000, maxRiskPct: 5, maxOrderINR: 1_000_000, maxOpenPositions: 50 });
    await agentStart({ mode: 'live', liveConfirmPhrase: 'LIVE' });
    __setJournalForTests(journalWithClosedAgentTrades(3, 10)); // 30% < 35%
    const telegram = vi.fn();
    await agentTick({}, telegram);
    expect(loadAgentConfig().mode).toBe('paper'); // downgraded!
    expect(telegram).toHaveBeenCalledWith(expect.stringMatching(/self-downgrade/i));
    const st = await agentStatus(null);
    expect(st.accuracy.winRateDowngraded).toBeTruthy();
    expect(st.accuracy.rollingWinRate).toBe(30);
    // the blocker strip tells the user why
    expect(st.blockers.some(b => b.key === 'win_rate_downgrade')).toBe(true);
  });

  it('healthy win-rate (50%) does NOT downgrade', async () => {
    __setConfigForTests({ mode: 'live', allowAuto: true, dailyMaxTrades: 50, dailyMaxLossINR: 1_000_000, maxRiskPct: 5, maxOrderINR: 1_000_000, maxOpenPositions: 50 });
    await agentStart({ mode: 'live', liveConfirmPhrase: 'LIVE' });
    __setJournalForTests(journalWithClosedAgentTrades(5, 10)); // 50% ≥ 35%
    await agentTick({}, vi.fn());
    expect(loadAgentConfig().mode).toBe('live'); // untouched
  });

  it('PAPER agent never triggers the downgrade (riskless already)', async () => {
    await agentStart({ mode: 'paper' });
    __setJournalForTests(journalWithClosedAgentTrades(0, 10)); // 0%!
    await agentTick({}, vi.fn());
    expect(loadAgentConfig().mode).toBe('paper');
    const st = await agentStatus(null);
    expect(st.accuracy.winRateDowngraded).toBeNull();
  });
});

// ============================================================
// B4 — correlation guard on concurrent positions
// ============================================================
describe('B4 correlation guard', () => {
  beforeEach(async () => {
    await agentStart({ mode: 'paper' });
    __setConfigForTests({ dailyMaxTrades: 50, dailyMaxLossINR: 1_000_000, maxRiskPct: 5, maxOrderINR: 1_000_000, maxOpenPositions: 50 });
  });

  const journalWithOpenPosition = (pair) => {
    const j = loadJournal();
    j.positions.push({
      id: 'op1', pair, market: 'FUTURES', side: 'LONG', mode: 'paper',
      source: 'agent', status: 'OPEN', qty: 0.01, entryPrice: 100, openedAt: Date.now(),
    });
    return j;
  };

  it('candidate |r|>0.7 with an open position → skipped, next candidate tried', async () => {
    __setJournalForTests(journalWithOpenPosition('B-BTC_USDT'));
    mockGetSignals.mockResolvedValue(boardOf(
      mkSignal({ symbol: 'ETH', pair: 'B-ETH_USDT', plan: { ...mkSignal().plan, atrUsed: 400 } }),
      mkSignal({ symbol: 'SOL', pair: 'B-SOL_USDT', plan: { ...mkSignal().plan, atrUsed: 700 } }),
    ));
    mockPairCorrelation.mockImplementation(async (a, b) => (a === 'ETH' && b === 'BTC' ? 0.86 : null));
    await agentTick({}, vi.fn());
    // ETH blocked; SOL entered
    expect(mockExecuteFutures).toHaveBeenCalledTimes(1);
    expect(mockExecuteFutures.mock.calls[0][0].symbol).toBe('SOL');
  });

  it('ALL candidates correlated → the cycle is skipped with an honest reason', async () => {
    __setJournalForTests(journalWithOpenPosition('B-BTC_USDT'));
    mockGetSignals.mockResolvedValue(boardOf(mkSignal({ symbol: 'ETH', pair: 'B-ETH_USDT' })));
    mockPairCorrelation.mockResolvedValue(0.8);
    await agentTick({}, vi.fn());
    expect(mockExecuteFutures).not.toHaveBeenCalled();
    const st = await agentStatus(null);
    expect(st.state.lastSkip?.key).toBe('correlation');
  });

  it('unknown correlation (feed down) → allow — a missing number is not a 0', async () => {
    __setJournalForTests(journalWithOpenPosition('B-BTC_USDT'));
    mockGetSignals.mockResolvedValue(boardOf(mkSignal({ symbol: 'ETH', pair: 'B-ETH_USDT' })));
    mockPairCorrelation.mockResolvedValue(null); // feed down
    await agentTick({}, vi.fn());
    expect(mockExecuteFutures).toHaveBeenCalledTimes(1);
  });

  it('guard OFF via config → entry proceeds without the correlation read', async () => {
    updateAgentConfig({ correlationGuard: false });
    __setJournalForTests(journalWithOpenPosition('B-BTC_USDT'));
    mockGetSignals.mockResolvedValue(boardOf(mkSignal({ symbol: 'ETH', pair: 'B-ETH_USDT' })));
    mockPairCorrelation.mockResolvedValue(0.9); // would block
    await agentTick({}, vi.fn());
    expect(mockExecuteFutures).toHaveBeenCalledTimes(1);
    expect(mockPairCorrelation).not.toHaveBeenCalled();
  });

  it('status exposes the guard state', async () => {
    const st = await agentStatus(null);
    expect(st.accuracy.correlationGuard).toBe(true);
  });
});
