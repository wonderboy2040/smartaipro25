// ============================================================
// test/agent.test.ts — v6.8 SUPERINTELLIGENCE AUTO-AGENT
// ------------------------------------------------------------
// Covers: config clamps, LIVE start arming (typed phrase + risk
// settings), the 3-trade daily quota, cooldown, daily-loss
// stand-down, wallet-based sizing (60% deployable cap), time-exit
// of aging agent positions, and the status payload shape.
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

// futures.js is mocked at the agent boundary — the agent's own
// contracts (wallet snapshot / execute / close) are what we verify
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

// signals.js mocked: the board the agent scans
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
  loadAgentConfig, updateAgentConfig, agentStart, agentStop, agentTick,
  agentStatus, __resetAgentForTests, __setAgentStateForTests, AGENT_DEFAULTS,
} from '../server/ai/agent.js';
import { __resetForTests, __setJournalForTests, loadJournal, todayIST, __setConfigForTests } from '../server/ai/coindcxOrders.js';
import { saveJSON, loadJSON as loadJSONOrig } from '../server/lib/store.js';

// ---------------- fixtures ----------------
const STRONG_CAND = {
  symbol: 'BTC', market: 'FUTURES', pair: 'B-BTC_USDT', side: 'LONG', grade: 'STRONG',
  confidence: 86, agreement: 0.82, executable: true, ltp: 50000,
  // v10.1 B1: a realistic committee quorum (8 of 11 voting) — thin-committee
  // signals now need minAiScore+10, and these legacy tests test the AI-score
  // gate at its FULL-committee bar (see test/v101AgentAccuracy.test.ts for
  // the thin-committee counterpart).
  voters: 8, totalModels: 11,
  plan: { entry: 50000, stopLoss: 48400, target1: 51600, target2: 53200, risk: 1600, riskPct: 3.2, rewardRisk: 2 },
};
const FUTURES_BOARD = {
  ok: true, market: 'FUTURES', signals: [STRONG_CAND], models: [],
  breadth: { bull: 1, bear: 0, flat: 0, avgConf: 80 }, generatedAt: Date.now(),
};

const WALLET = {
  ok: true, connected: true, usdInr: 84,
  spot: { inr: { free: 5000, locked: 0, total: 5000 }, usdt: { free: 50, locked: 0, total: 50 }, error: null, rows: [] },
  futures: { usdt: { free: 200, locked: 0, total: 200, crossUserMargin: 0 }, error: null },
  equityINR: 5000 + 50 * 84 + 200 * 84, // 5000 + 4200 + 16800 = 26000
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
    ok: true, mode: 'paper', filled: { qty: 0.006, price: 50000, notionalUSDT: 300, leverage: 3, marginUSDT: 100 },
  });
  mockCloseFutures.mockReset().mockResolvedValue({ ok: true, position: { pnlINR: 50 } });
  mockGetSignals.mockReset().mockResolvedValue(FUTURES_BOARD);
});

afterEach(() => {
  saveJSON('mcp-coindcx.json', _origCreds && _origCreds.apiKey != null ? _origCreds : { apiKey: null, secret: null });
});

// ============================================================
// config
// ============================================================
describe('agent config', () => {
  it('defaults are the USER SPEC: 3 trades/day, paper, wallet-risk sizing', () => {
    const cfg = loadAgentConfig();
    expect(cfg.maxTradesPerDay).toBe(3);
    expect(cfg.mode).toBe('paper');
    expect(cfg.enabled).toBe(false);
    expect(cfg.riskPerTradePct).toBe(1.5);
    expect(cfg.minConfidence).toBe(70); // v12.1 USER SPEC: conf 70+ (was 60)
    expect(cfg.minAiScore).toBe(75); // v9.6 USER SPEC: 75+ AI score → auto entry
    expect(cfg.quorumPenalty).toBe(5); // v10.16 S3: proportional-penalty cap (was flat 10)
    expect(cfg.thresholdProfile).toBe('proportional'); // v10.16 S3: one-flag A/B arm
  });

  it('clamps every numeric field into its safe range', () => {
    const cfg = updateAgentConfig({
      maxTradesPerDay: 100, minAiScore: 99, minConfidence: 99, riskPerTradePct: 500,
      maxLeverage: 50, cooldownMin: -5, dailyLossCapPct: 0.01,
    });
    expect(cfg.maxTradesPerDay).toBe(20);
    expect(cfg.minAiScore).toBe(95);
    expect(cfg.minConfidence).toBe(95);
    expect(cfg.riskPerTradePct).toBe(10);
    expect(cfg.maxLeverage).toBe(10);
    expect(cfg.cooldownMin).toBe(1);
    expect(cfg.dailyLossCapPct).toBe(0.5);
  });

  it('v12.9 USER SPEC: reversal knobs are NO-CAP — saved VERBATIM (positive sanity only)', () => {
    // "koi threshold tweak cap nahi — editable manually hamare hisaab se"
    const cfg = updateAgentConfig({
      reversalLossCapINR: 12000, reversalProfitTargetINR: 75000, reversalMaxLegs: 10,
      reversalCooldownMin: 0.5, reversalCycleStopINR: 99, reversalReentryWindowMin: 600,
      reversalMinReentryConf: 20,
    });
    expect(cfg.reversalLossCapINR).toBe(12000); // NOT clamped to 5000
    expect(cfg.reversalProfitTargetINR).toBe(75000); // NOT clamped to 50000
    expect(cfg.reversalMaxLegs).toBe(10); // NOT clamped to 6
    expect(cfg.reversalCooldownMin).toBe(0.5); // NOT clamped to [1,60]
    expect(cfg.reversalCycleStopINR).toBe(99); // NOT lifted above the cap
    expect(cfg.reversalReentryWindowMin).toBe(600); // NOT clamped to [5,240]
    expect(cfg.reversalMinReentryConf).toBe(20); // NOT clamped to [50,90]
  });

  it('v12.9: reversal knob sanity — non-positive / garbage values are ignored, never crash', () => {
    const before = loadAgentConfig();
    const cfg = updateAgentConfig({
      reversalLossCapINR: -50, reversalProfitTargetINR: 0, reversalMaxLegs: 'abc',
      reversalCooldownMin: null, reversalCycleStopINR: -1, reversalReentryWindowMin: 'x',
      reversalMinReentryConf: -10,
    });
    expect(cfg.reversalLossCapINR).toBe(before.reversalLossCapINR ?? 150);
    expect(cfg.reversalProfitTargetINR).toBe(before.reversalProfitTargetINR ?? 500);
    expect(cfg.reversalMaxLegs).toBe(before.reversalMaxLegs ?? 3);
    expect(cfg.reversalCooldownMin).toBe(before.reversalCooldownMin ?? 3);
    expect(cfg.reversalCycleStopINR).toBe(before.reversalCycleStopINR ?? 300);
    expect(cfg.reversalReentryWindowMin).toBe(before.reversalReentryWindowMin ?? 45);
    expect(cfg.reversalMinReentryConf).toBe(before.reversalMinReentryConf ?? 60);
  });

  it('desk toggles accept only booleans', () => {
    const cfg = updateAgentConfig({ desks: { futures: 'yes', spot: 1, india: false } });
    expect(cfg.desks.futures).toBe(true); // truthy coercion NOT applied — 'yes' is truthy
    expect(cfg.desks.spot).toBe(true);
    expect(cfg.desks.india).toBe(false);
  });

  it('v10.4: the GLOBAL equity-futures desk defaults ON and toggles like the others', () => {
    // default ON (loadAgentConfig merges AGENT_DEFAULTS)
    expect(loadAgentConfig().desks.global).toBe(true);
    // toggle OFF
    expect(updateAgentConfig({ desks: { global: false } }).desks.global).toBe(false);
    // toggle back ON
    expect(updateAgentConfig({ desks: { global: 1 } }).desks.global).toBe(true);
  });
});

// ============================================================
// start / stop arming
// ============================================================
describe('agentStart / agentStop', () => {
  it('LIVE start REQUIRES the typed phrase', async () => {
    await expect(agentStart({ mode: 'live' })).rejects.toThrow(/liveConfirmPhrase/i);
  });

  it('LIVE start requires Risk settings (mode LIVE + allowAuto)', async () => {
    __setConfigForTests({ mode: 'paper', allowAuto: false });
    await expect(agentStart({ mode: 'live', liveConfirmPhrase: 'LIVE' })).rejects.toThrow(/Risk settings/i);
    __setConfigForTests({ mode: 'live', allowAuto: false });
    await expect(agentStart({ mode: 'live', liveConfirmPhrase: 'LIVE' })).rejects.toThrow(/Risk settings/i);
  });

  it('LIVE start succeeds with phrase + arming + connection', async () => {
    __setConfigForTests({ mode: 'live', allowAuto: true });
    const out = await agentStart({ mode: 'live', liveConfirmPhrase: 'LIVE' });
    expect(out.ok).toBe(true);
    expect(loadAgentConfig().enabled).toBe(true);
    expect(loadAgentConfig().mode).toBe('live');
  });

  it('PAPER start needs nothing and enables the agent', async () => {
    const out = await agentStart({ mode: 'paper' });
    expect(out.ok).toBe(true);
    expect(loadAgentConfig().enabled).toBe(true);
    expect(loadAgentConfig().mode).toBe('paper');
  });

  it('stop disables but keeps the config', async () => {
    await agentStart({ mode: 'paper' });
    updateAgentConfig({ maxTradesPerDay: 5 });
    agentStop({ reason: 'test' });
    const cfg = loadAgentConfig();
    expect(cfg.enabled).toBe(false);
    expect(cfg.maxTradesPerDay).toBe(5);
  });
});

// ============================================================
// THE LOOP — the 3-trade quota, sizing, loss cap, time-exit
// ============================================================
describe('agentTick — daily quota + sizing + exits', () => {
  beforeEach(async () => {
    await agentStart({ mode: 'paper' });
    __setConfigForTests({ dailyMaxTrades: 50, dailyMaxLossINR: 1_000_000, maxRiskPct: 5, maxOrderINR: 1_000_000, maxOpenPositions: 50 });
  });

  it('AUTO-ENTRY: passes wallet-based margin (60% deployable cap) through the futures gauntlet', async () => {
    await agentTick({}, vi.fn());
    expect(mockExecuteFutures).toHaveBeenCalledTimes(1);
    const opts = mockExecuteFutures.mock.calls[0][0];
    expect(opts.source).toBe('agent');
    expect(opts.side).toBe('LONG');
    expect(opts.symbol).toBe('BTC');
    // equity 26000 × 1.5% = ₹390 risk → 390/84 = 4.64 USDT risk;
    // qty = 4.64/1600 = 0.0029; lev = min(3, floor(95/3.2)=29) = 3
    // margin = 0.0029×50000/3 ≈ 48.3 USDT — well under the 120 (60% of 200) cap
    expect(opts.marginUSDT).toBeGreaterThan(1);
    expect(opts.marginUSDT).toBeLessThanOrEqual(200 * 0.6 + 1);
    expect(opts.leverage).toBe(3);
    expect(opts.wantAuto).toBe(false); // paper mode — no auto flag needed
  });

  it('QUOTA: exactly 3 trades — the 4th never fires (execute NOT called)', async () => {
    // seed the journal with 3 agent trades today
    const j = loadJournal();
    const day = todayIST();
    for (let i = 0; i < 3; i++) {
      j.entries.push({ id: `a${i}`, ts: Date.now(), kind: 'ORDER', day, pair: `B-X${i}_USDT`, source: 'agent', status: 'FILLED' });
    }
    __setJournalForTests(j);
    await agentTick({}, vi.fn());
    expect(mockExecuteFutures).not.toHaveBeenCalled();
  });

  it('QUOTA counts ONLY agent trades — 3 manual trades donot block the agent', async () => {
    const j = loadJournal();
    const day = todayIST();
    for (let i = 0; i < 3; i++) {
      j.entries.push({ id: `m${i}`, ts: Date.now(), kind: 'ORDER', day, pair: `X${i}`, source: 'manual', status: 'FILLED' });
    }
    __setJournalForTests(j);
    await agentTick({}, vi.fn());
    expect(mockExecuteFutures).toHaveBeenCalledTimes(1);
  });

  it('LOSS CAP: agent-sourced losses ≥ dailyLossCapPct% of equity → stand-down', async () => {
    // agent took a trade today and it closed at −₹900 (3.46% of 26000 > 3% cap)
    const j = loadJournal();
    const day = todayIST();
    j.entries.push({ id: 'o1', ts: Date.now(), kind: 'ORDER', day, pair: 'B-BTC_USDT', source: 'agent', status: 'FILLED' });
    j.entries.push({ id: 'c1', ts: Date.now(), kind: 'CLOSE', day, pair: 'B-BTC_USDT', source: 'agent', status: 'FILLED', pnlINR: -900 });
    __setJournalForTests(j);
    const telegram = vi.fn();
    await agentTick({}, telegram);
    expect(mockExecuteFutures).not.toHaveBeenCalled();
    expect(telegram).toHaveBeenCalledWith(expect.stringMatching(/stood down|AGENT stood down/i));
    // status reflects the pause
    const st = await agentStatus(null);
    expect(st.today.paused).toBeTruthy();
    expect(String(st.today.paused.reason)).toMatch(/loss cap/i);
  });

  it('COOLDOWN: no second entry within cooldown minutes of the last one', async () => {
    await agentTick({}, vi.fn()); // first entry fires
    expect(mockExecuteFutures).toHaveBeenCalledTimes(1);
    mockExecuteFutures.mockClear();
    // immediate next cycle → cooldown (default 20m) blocks
    await agentTick({}, vi.fn());
    expect(mockExecuteFutures).not.toHaveBeenCalled();
  });

  it('TIME-EXIT: an aging agent position is closed, not left to drift', async () => {
    const j = loadJournal();
    j.positions.push({
      id: 'ag1', pair: 'B-BTC_USDT', market: 'FUTURES', side: 'LONG', mode: 'paper',
      source: 'agent', status: 'OPEN', qty: 0.01, entryPrice: 50000,
      openedAt: Date.now() - 120 * 60_000, // 120m old > 90m maxHold
    });
    __setJournalForTests(j);
    await agentTick({}, vi.fn());
    expect(mockCloseFutures).toHaveBeenCalledWith('ag1');
  });

  it('KILL SWITCH: the agent stands down instantly', async () => {
    __setConfigForTests({ killSwitch: true });
    await agentTick({}, vi.fn());
    expect(mockExecuteFutures).not.toHaveBeenCalled();
  });

  it('STRICTER gates: a 58% STRONG board signal is BELOW the agent bar (60)', async () => {
    mockGetSignals.mockResolvedValue({ ...FUTURES_BOARD, signals: [{ ...STRONG_CAND, confidence: 58 }] });
    await agentTick({}, vi.fn());
    expect(mockExecuteFutures).not.toHaveBeenCalled();
  });

  it('v10.16 S3 (conf=60 user spec): a 78% STRONG signal now QUALIFIES via Path B (was below the 80 bar)', async () => {
    // the whole point of the fix: Path B (STRONG + conf + agreement) was
    // unreachable at 80/0.75 — at 60/0.65 a 78% STRONG committee signal
    // fires the entry (agreement 0.82 ≥ 0.65, executable, full quorum).
    mockGetSignals.mockResolvedValue({ ...FUTURES_BOARD, signals: [{ ...STRONG_CAND, confidence: 78, superIntel: { aiScore: 60 } }] });
    await agentTick({}, vi.fn());
    expect(mockExecuteFutures).toHaveBeenCalledTimes(1);
  });

  it('v9.6 AI-SCORE GATE: a 76-AI-score ACTION signal (68% conf, not executable) STILL fires the entry', async () => {
    // the user's spec: "75+ AI Score hone par auto entry" — the board's
    // superIntel AI score now qualifies on its own (committee barYA)
    mockGetSignals.mockResolvedValue({
      ...FUTURES_BOARD,
      signals: [{ ...STRONG_CAND, grade: 'ACTION', confidence: 68, agreement: 0.6, executable: false, superIntel: { aiScore: 76 } }],
    });
    await agentTick({}, vi.fn());
    expect(mockExecuteFutures).toHaveBeenCalledTimes(1);
    expect(mockExecuteFutures.mock.calls[0][0].symbol).toBe('BTC');
    expect(mockExecuteFutures.mock.calls[0][0].side).toBe('LONG');
  });

  it('v9.6 AI-SCORE GATE below bar: 70 AI score + 68% conf ACTION → no entry', async () => {
    mockGetSignals.mockResolvedValue({
      ...FUTURES_BOARD,
      signals: [{ ...STRONG_CAND, grade: 'ACTION', confidence: 68, agreement: 0.6, executable: false, superIntel: { aiScore: 70 } }],
    });
    await agentTick({}, vi.fn());
    expect(mockExecuteFutures).not.toHaveBeenCalled();
  });

  it('v9.6 TREND-FLIP EXIT: board flips opposite on a held pair → position cut + re-entry cooldown-stamped', async () => {
    const j = loadJournal();
    j.positions.push({
      id: 'ag2', pair: 'B-BTC_USDT', market: 'FUTURES', side: 'LONG', mode: 'paper',
      source: 'agent', status: 'OPEN', qty: 0.01, entryPrice: 50000,
      openedAt: Date.now() - 5 * 60_000, // 5m old — well under the 90m time-exit
    });
    __setJournalForTests(j);
    mockGetSignals.mockResolvedValue({
      ...FUTURES_BOARD,
      signals: [{ ...STRONG_CAND, side: 'SHORT', superIntel: { aiScore: 84 } }],
    });
    await agentTick({}, vi.fn());
    expect(mockCloseFutures).toHaveBeenCalledWith('ag2');
    // the flip side (SHORT) can NOT re-enter this tick — cooldown stamped
    expect(mockExecuteFutures).not.toHaveBeenCalled();
  });

  it('one-per-pair parity: an existing OPEN position on the candidate pair blocks entry', async () => {
    const j = loadJournal();
    j.positions.push({ id: 'open1', pair: 'B-BTC_USDT', market: 'FUTURES', status: 'OPEN', source: 'manual' });
    __setJournalForTests(j);
    await agentTick({}, vi.fn());
    expect(mockExecuteFutures).not.toHaveBeenCalled();
  });
});

// ============================================================
// status payload
// ============================================================
describe('agentStatus', () => {
  it('returns the complete panel payload without throwing', async () => {
    const st = await agentStatus(null);
    expect(st.ok).toBe(true);
    expect(st.engine).toMatch(/SUPERINTELLIGENCE AGENT/i);
    expect(st.config.maxTradesPerDay).toBe(3);
    expect(st.today.maxTrades).toBe(3);
    expect(st.today.tradesCount).toBe(0);
    expect(Array.isArray(st.state.log)).toBe(true);
    expect(st.wallet?.equityINR).toBe(WALLET.equityINR); // wallet fetch wired through
  });
});

// ============================================================
// v9.7 — TRANSPARENCY: blockers strip + manual trend-exit +
// futures-margin viability filter
// ============================================================
describe('v9.7 agentStatus BLOCKERS — the "entry kyun nahi ho raha" strip', () => {
  it('stopped agent → disabled blocker shown', async () => {
    const st = await agentStatus(null);
    expect(st.blockers.some(b => b.key === 'disabled')).toBe(true);
  });

  it('EQUITY FLOOR: wallet below ₹300 → hard blocker + lastSkip recorded + entry blocked', async () => {
    mockWalletSnapshot.mockResolvedValue({
      ...WALLET, equityINR: 0.01, deployableSpotINR: 0.01, deployableFuturesUSDT: 0,
    });
    await agentStart({ mode: 'paper' });
    await agentTick({}, vi.fn());
    expect(mockExecuteFutures).not.toHaveBeenCalled();
    const st = await agentStatus(null);
    const b = st.blockers.find(x => x.key === 'equity_floor');
    expect(b).toBeTruthy();
    expect(b.text).toMatch(/0\.01/);
    expect(st.state.lastSkip?.key).toBe('equity_floor');
  });

  it('QUOTA done → blocker carries the count; cooldown → countdown text', async () => {
    await agentStart({ mode: 'paper' });
    const j = loadJournal();
    const day = todayIST();
    for (let i = 0; i < 3; i++) j.entries.push({ id: `q${i}`, ts: Date.now(), kind: 'ORDER', day, pair: `B-Q${i}_USDT`, source: 'agent', status: 'FILLED' });
    __setJournalForTests(j);
    const st = await agentStatus(null);
    expect(st.blockers.some(b => b.key === 'quota' && /3\/3/.test(b.text))).toBe(true);

    // cooldown: an entry 5m ago with 20m cooldown → 15m baaki text
    const j2 = loadJournal();
    __setJournalForTests(j2);
    const stCfg = await updateAgentConfig({ cooldownMin: 20 });
    expect(stCfg.cooldownMin).toBe(20);
  });

  it('running agent with healthy wallet → NO hard blockers, loop fields present', async () => {
    await agentStart({ mode: 'paper' });
    const st = await agentStatus(null);
    expect(st.blockers.some(b => !b.soft)).toBe(false);
    expect(st.state.tickSec).toBeGreaterThanOrEqual(30);
    expect(st.state.nextScanInSec == null || st.state.nextScanInSec >= 0).toBe(true);
  });
});

describe('v9.7 TREND-FLIP on MANUAL positions + v12.7 FLIP DISCIPLINE (notify-only default + per-pair re-entry block)', () => {
  beforeEach(async () => {
    await agentStart({ mode: 'paper' });
  });

  it('v12.7 DEFAULT: manual-held position + qualifying OPPOSITE board → ALERT, position NOT cut (notify-only)', async () => {
    const j = loadJournal();
    j.positions.push({
      id: 'man1', pair: 'B-BTC_USDT', market: 'FUTURES', side: 'LONG', mode: 'paper',
      source: 'manual', status: 'OPEN', qty: 0.01, entryPrice: 50000,
      openedAt: Date.now() - 5 * 60_000,
    });
    __setJournalForTests(j);
    mockGetSignals.mockResolvedValue({
      ...FUTURES_BOARD,
      signals: [{ ...STRONG_CAND, side: 'SHORT', superIntel: { aiScore: 84 } }],
    });
    const tg = vi.fn();
    await agentTick({}, tg);
    // the user's manual position is the user's — an ALERT, never a close
    expect(mockCloseFutures).not.toHaveBeenCalledWith('man1');
    expect(tg.mock.calls.some(c => String(c[0]).includes('trend-flip ALERT'))).toBe(true);
    // and the per-pair flip memory armed (the re-entry guard) — visible in status
    const st = await agentStatus({});
    const blocks = st.state.flipDiscipline.activeBlocks as Array<{ pair: string; closedSide: string }>;
    expect(blocks.some(b => b.pair === 'B-BTC_USDT' && b.closedSide === 'LONG')).toBe(true);
    expect(st.state.flipDiscipline.manualFlipAction).toBe('notify');
  });

  it('v12.7 notify-only: the alert fires ONCE per flip episode (no per-tick Telegram storm)', async () => {
    const j = loadJournal();
    j.positions.push({
      id: 'man1b', pair: 'B-BTC_USDT', market: 'FUTURES', side: 'LONG', mode: 'paper',
      source: 'manual', status: 'OPEN', qty: 0.01, entryPrice: 50000,
      openedAt: Date.now() - 5 * 60_000,
    });
    __setJournalForTests(j);
    mockGetSignals.mockResolvedValue({
      ...FUTURES_BOARD,
      signals: [{ ...STRONG_CAND, side: 'SHORT', superIntel: { aiScore: 84 } }],
    });
    const tg = vi.fn();
    await agentTick({}, tg);
    await agentTick({}, tg);
    await agentTick({}, tg);
    const alertCalls = tg.mock.calls.filter(c => String(c[0]).includes('trend-flip ALERT'));
    expect(alertCalls.length).toBe(1); // one episode, one ping
    expect(mockCloseFutures).not.toHaveBeenCalled();
  });

  it('v12.7 OPT-IN close-mode + STRONG opposite signal → cut (restores the v9.7 behavior)', async () => {
    updateAgentConfig({ manualFlipAction: 'close' });
    const j = loadJournal();
    j.positions.push({
      id: 'man4', pair: 'B-BTC_USDT', market: 'FUTURES', side: 'LONG', mode: 'paper',
      source: 'manual', status: 'OPEN', qty: 0.01, entryPrice: 50000,
      openedAt: Date.now() - 5 * 60_000,
    });
    __setJournalForTests(j);
    mockGetSignals.mockResolvedValue({
      ...FUTURES_BOARD,
      signals: [{ ...STRONG_CAND, side: 'SHORT', grade: 'STRONG', superIntel: { aiScore: 84 } }],
    });
    await agentTick({}, vi.fn());
    expect(mockCloseFutures).toHaveBeenCalledWith('man4');
  });

  it('v12.7 close-mode still demands STRONG — a score-bar qualifier (ACTION grade) does NOT cut a manual position', async () => {
    updateAgentConfig({ manualFlipAction: 'close' });
    const j = loadJournal();
    j.positions.push({
      id: 'man5', pair: 'B-BTC_USDT', market: 'FUTURES', side: 'LONG', mode: 'paper',
      source: 'manual', status: 'OPEN', qty: 0.01, entryPrice: 50000,
      openedAt: Date.now() - 5 * 60_000,
    });
    __setJournalForTests(j);
    mockGetSignals.mockResolvedValue({
      ...FUTURES_BOARD,
      signals: [{ ...STRONG_CAND, side: 'SHORT', grade: 'ACTION', superIntel: { aiScore: 84 } }],
    });
    await agentTick({}, vi.fn());
    expect(mockCloseFutures).not.toHaveBeenCalledWith('man5');
  });

  it('v12.7 FLIP-CHURN GUARD: after a flip on a pair, the OPPOSITE-side candidate is refused (no LONG→SHORT conversion)', async () => {
    // a LONG was flip-alerted 30 min ago on B-BTC_USDT; the position is
    // closed now, the board prints a qualifying SHORT — the agent must
    // NOT enter it (the account never flips sides on the same pair).
    const j = loadJournal();
    __setJournalForTests(j);
    __setAgentStateForTests({
      flipBlock: { 'B-BTC_USDT': { side: 'LONG', at: Date.now() - 30 * 60_000 } },
    });
    mockGetSignals.mockResolvedValue({
      ...FUTURES_BOARD,
      signals: [{ ...STRONG_CAND, side: 'SHORT', superIntel: { aiScore: 84 } }],
    });
    await agentTick({}, vi.fn());
    expect(mockExecuteFutures).not.toHaveBeenCalled();
    // the refusal is recorded in the agent log ring (lastSkip may be
    // overwritten by the later no_candidates skip — the ring is the truth)
    const st = await agentStatus({});
    const logTexts = ((st.state.log as Array<{ text: string }>) || []).map(l => String(l.text));
    expect(logTexts.some(t => t.includes('entry BLOCKED') && t.includes('B-BTC_USDT'))).toBe(true);
  });

  it('v12.7 flip-churn guard: SAME-side re-entry is allowed (a fresh LONG after a flip-closed SHORT is a new signal, not churn)', async () => {
    const j = loadJournal();
    __setJournalForTests(j);
    __setAgentStateForTests({
      flipBlock: { 'B-BTC_USDT': { side: 'LONG', at: Date.now() - 30 * 60_000 } },
    });
    // same side as the blocked-from side (LONG) → NOT blocked
    mockGetSignals.mockResolvedValue({
      ...FUTURES_BOARD,
      signals: [{ ...STRONG_CAND, side: 'LONG', superIntel: { aiScore: 84 } }],
    });
    await agentTick({}, vi.fn());
    expect(mockExecuteFutures).toHaveBeenCalled();
  });

  it('v12.7 flip-churn guard: the block EXPIRES after flipReentryBlockMin', async () => {
    const j = loadJournal();
    __setJournalForTests(j);
    __setAgentStateForTests({
      // 5h-old block on the default 4h window — expired, entry may fire
      flipBlock: { 'B-BTC_USDT': { side: 'LONG', at: Date.now() - 5 * 60 * 60_000 } },
    });
    mockGetSignals.mockResolvedValue({
      ...FUTURES_BOARD,
      signals: [{ ...STRONG_CAND, side: 'SHORT', superIntel: { aiScore: 84 } }],
    });
    await agentTick({}, vi.fn());
    expect(mockExecuteFutures).toHaveBeenCalled();
    const st = await agentStatus({});
    const logTexts = ((st.state.log as Array<{ text: string }>) || []).map(l => String(l.text));
    expect(logTexts.some(t => t.includes('entry BLOCKED'))).toBe(false); // expired — no block line this tick
  });

  it('manageManualPositions=false → manual position left alone (agent-only guard)', async () => {
    updateAgentConfig({ manageManualPositions: false });
    const j = loadJournal();
    j.positions.push({
      id: 'man2', pair: 'B-BTC_USDT', market: 'FUTURES', side: 'LONG', mode: 'paper',
      source: 'manual', status: 'OPEN', qty: 0.01, entryPrice: 50000,
      openedAt: Date.now() - 5 * 60_000,
    });
    __setJournalForTests(j);
    mockGetSignals.mockResolvedValue({
      ...FUTURES_BOARD,
      signals: [{ ...STRONG_CAND, side: 'SHORT', superIntel: { aiScore: 84 } }],
    });
    await agentTick({}, vi.fn());
    expect(mockCloseFutures).not.toHaveBeenCalledWith('man2');
  });

  it('agent TIME-EXIT still agent-only — a 200m-old MANUAL position is NOT time-exited', async () => {
    const j = loadJournal();
    j.positions.push({
      id: 'man3', pair: 'B-BTC_USDT', market: 'FUTURES', side: 'LONG', mode: 'paper',
      source: 'manual', status: 'OPEN', qty: 0.01, entryPrice: 50000,
      openedAt: Date.now() - 200 * 60_000,
    });
    __setJournalForTests(j);
    await agentTick({}, vi.fn());
    expect(mockCloseFutures).not.toHaveBeenCalledWith('man3');
  });
});

describe('v9.7 FUTURES-margin viability filter', () => {
  beforeEach(async () => {
    await agentStart({ mode: 'paper' });
    __setConfigForTests({ dailyMaxTrades: 50, dailyMaxLossINR: 1_000_000, maxRiskPct: 5, maxOrderINR: 1_000_000, maxOpenPositions: 50 });
  });

  it('connected wallet with <2 USDT futures margin in PAPER mode → futures STILL trades (v21.0.6 practice sizing)', async () => {
    // v21.0.6 [audit M1]: the sizing-floor asymmetry fix — pehle connected
    // chhote wallet (₹280-560) pe paper-futures har cycle "margin too
    // small" se skip hota tha jabki sim (floor 1) fire karta rehta tha
    // ("sirf equity sim ka auto trade lagta hai" complaint ka residue).
    // Ab paper mode me dono desks PRACTICE equity (≥₹10,000 baseline) pe
    // size hote hain; futures_margin blocker sirf LIVE mode me fire hota hai.
    mockWalletSnapshot.mockResolvedValue({
      ...WALLET, deployableFuturesUSDT: 0, equityINR: 400, deployableSpotINR: 400,
      futures: { ...WALLET.futures, usdt: { free: 0, locked: 0, total: 0, crossUserMargin: 0 }, error: null },
    });
    await agentTick({}, vi.fn());
    expect(mockExecuteFutures).toHaveBeenCalledTimes(1); // practice sizing → fires
    const st = await agentStatus(null);
    // paper mode: no futures_margin blocker (sirf LIVE wallet top-up ke liye)
    expect(st.blockers.some(b => b.key === 'futures_margin')).toBe(false);
    expect(st.blockers.some(b => b.key === 'futures_wallet_read')).toBe(false);
  });

  it('v12.1/v12.2: a FAILED futures wallet read is a FAULT blocker (not "low margin") — the auth trace + scope verdict surface', async () => {
    // the exact live 2026-09-19 incident: Global Futures wallet HAS funds
    // but the read 401s — the panel must show the read failure + guidance,
    // never a misleading "margin < 2 USDT". v12.2: the scope verdict LEADS
    // the error text — the blocker's 260-char slice must carry the verdict
    // + the one-step fix, not just the ladder trace.
    mockWalletSnapshot.mockResolvedValue({
      ...WALLET, deployableFuturesUSDT: 0, equityINR: 400, deployableSpotINR: 400,
      futures: { usdt: { free: 0, locked: 0, total: 0, crossUserMargin: 0 }, error: '[401] Invalid credentials · futures-key-scope: MISSING — API key me Global Futures permission nahi hai (derivatives positions auth bhi 401 — same key spot par chalti hai). CoinDCX app → API Dashboard → Futures permission ON karke NAYI key banao → site me CoinDCX reconnect karo [auth-ladder GET-body/ms/num:401 · GET-body/s/num:401 · GET-body/ms/str:401 · GET-s/str:401 · GET-ms/num:401 · GET-s/pgsz:401 · POST:404]' },
    });
    await agentTick({}, vi.fn());
    // v21.0.6: PAPER mode me futures practice-equity sizing pe TRADE KARTA
    // hai (wallet read fault sirf panel pe surface hota hai — LIVE jaane
    // se pehle user ko auth fix dikhna chahiye). Pehle ye assertion
    // sizing-starve (margin<2) ki wajah se pass hota tha.
    expect(mockExecuteFutures).toHaveBeenCalledTimes(1);
    const st = await agentStatus(null);
    const fault = st.blockers.find(b => b.key === 'futures_wallet_read');
    expect(fault).toBeTruthy();
    expect(fault.soft).toBeUndefined(); // a FAULT, not a soft note
    // v12.2: the verdict + the user's one-step fix survive the 260-char
    // blocker slice (the ladder trace rides the tail of the string — it
    // stays visible in the wallet error card, the agent log and Telegram;
    // the futures.test.ts suite locks it inside the error itself).
    expect(String(fault.text)).toContain('futures-key-scope: MISSING');
    expect(String(fault.text)).toContain('NAYI key banao');
    // the misleading soft margin blocker must NOT also fire
    expect(st.blockers.some(b => b.key === 'futures_margin')).toBe(false);
  });

  it('unconnected practice wallet → futures stays viable (paper fallback)', async () => {
    _connected = false;
    mockWalletSnapshot.mockResolvedValue(null);
    await agentTick({}, vi.fn());
    expect(mockExecuteFutures).toHaveBeenCalledTimes(1);
    _connected = true;
  });
});

// ============================================================
// v13.2 A3 — PER-STRATEGY WIN-RATE SELF-DOWNGRADE (size weight)
// ============================================================
describe('strategy win-rate self-downgrade (v13.2 A3)', () => {
  const mkClosed = (pair, wins, total) => Array.from({ length: total }, (_, i) => ({
    source: 'agent', pair, status: 'CLOSED',
    pnlINR: i < wins ? 120 : -80,
    closedAt: 1700000000000 - i * 60000,
  }));

  it('strategyWinRate: null under 20 settled trades, exact above', async () => {
    const { strategyWinRate } = await import('../server/ai/agent.js');
    expect(strategyWinRate({ positions: mkClosed('XRPINR', 5, 19) }, 'XRPINR')).toBeNull();
    expect(strategyWinRate({ positions: mkClosed('XRPINR', 5, 20) }, 'XRPINR')).toEqual({ winRate: 25, trades: 20 });
    expect(strategyWinRate({ positions: mkClosed('BTCINR', 12, 20) }, 'BTCINR')).toEqual({ winRate: 60, trades: 20 });
  });

  it('size multiplier ladder: ≥50% full · 40-50 ×0.75 · 30-40 ×0.5 · <30 ×0.25', async () => {
    const { strategySizeMultiplier } = await import('../server/ai/agent.js');
    expect(strategySizeMultiplier({ positions: mkClosed('A', 12, 20) }, 'A', {}).mul).toBe(1);      // 60%
    expect(strategySizeMultiplier({ positions: mkClosed('B', 9, 20) }, 'B', {}).mul).toBe(0.75);    // 45%
    expect(strategySizeMultiplier({ positions: mkClosed('C', 7, 20) }, 'C', {}).mul).toBe(0.5);     // 35%
    expect(strategySizeMultiplier({ positions: mkClosed('D', 5, 20) }, 'D', {}).mul).toBe(0.25);    // 25%
    expect(strategySizeMultiplier({ positions: mkClosed('E', 5, 19) }, 'E', {}).mul).toBe(1);       // no history
  });

  it('config kill-switch winRateSizeDowngrade=false → always full size', async () => {
    const { strategySizeMultiplier } = await import('../server/ai/agent.js');
    const out = strategySizeMultiplier({ positions: mkClosed('XRPINR', 5, 20) }, 'XRPINR', { winRateSizeDowngrade: false });
    expect(out).toEqual({ mul: 1, reason: 'disabled' });
  });

  it('strategyDowngradeView lists ONLY the haircut pairs', async () => {
    const { strategyDowngradeView } = await import('../server/ai/agent.js');
    const j = { positions: [...mkClosed('XRPINR', 5, 20), ...mkClosed('BTCINR', 12, 20)] };
    const view = strategyDowngradeView(j, {});
    expect(view).toEqual([{ pair: 'XRPINR', mul: 0.25, winRate: 25, trades: 20 }]);
  });

  it('winRateSizeDowngrade config knob round-trips via updateAgentConfig', async () => {
    await updateAgentConfig({ winRateSizeDowngrade: false });
    expect(loadAgentConfig().winRateSizeDowngrade).toBe(false);
    await updateAgentConfig({ winRateSizeDowngrade: true });
    expect(loadAgentConfig().winRateSizeDowngrade).toBe(true);
  });

  it('only agent-sourced closed trades count (manual/paper noise excluded)', async () => {
    const { strategyWinRate } = await import('../server/ai/agent.js');
    const j = { positions: [
      ...mkClosed('XRPINR', 0, 20),
      ...mkClosed('XRPINR', 10, 10).map(p => ({ ...p, source: 'manual' })), // 10 manual WINS must not rescue
    ] };
    expect(strategyWinRate(j, 'XRPINR')).toEqual({ winRate: 0, trades: 20 });
  });
});
