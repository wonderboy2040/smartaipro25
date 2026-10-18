// ============================================================
// test/v115ManualTrackerResilience.test.ts — v11.5 MANUAL TRACKER
// ------------------------------------------------------------
// THE INCIDENT (CoinDCX tab): the Manual Trade Tracker showed
// "⏸ STALE — conviction data missing" + "tracker fetch fail" while
// upstream data sources (CoinDCX futures API, TradingView) were
// temporarily down — because every failed deep re-vote WIPED the
// conviction to UNKNOWN, and one slow deep call could hang the whole
// /api/manual-trades response.
//
// THE FIX locked here:
//   1. GAUNTLET WIRING — executeSignal passes {mode} into
//      getFreshSignal so the board fallback (v115ExecFallback suite)
//      engages for paper/notify only; a paper trade also EXECUTES on
//      a board-aged signal (the Bug 2 end-to-end lock).
//   2. MONITOR PRESERVATION — a failed/thrown deep re-vote KEEPS the
//      last-known conviction (original `at` stamp, state intact);
//      UNKNOWN only when the trade never had a successful vote.
//   3. ROUTE FALLBACK — lastKnownConvictionForView serves the last
//      real vote (never UNKNOWN/absent ones) so the banner stays
//      THESIS_INTACT/WEAKENING instead of a dead STALE bar.
//
// Hermetic: v67-gauntlet's scaffolding (mcp/coindcx + cryptoStream
// mocked, SMARTAI_DATA_DIR off-tree) + manualTrades' liveFeed tick
// store mock.
// ============================================================
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

process.env.SMARTAI_DATA_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '../.test-data-v115mt');

// ---- controllable live tick store (ltpForManualTrade reads this) ----
const _ticks = vi.hoisted(() => new Map());
vi.mock('../server/liveFeed.js', () => ({
  getTick: (k) => _ticks.get(k) || null,
}));
// ---- no backup IO (manualTrades + paperTrading chain) ----
vi.mock('../server/intraday/backup.js', () => ({
  scheduleBackup: vi.fn(),
  restoreBackup: vi.fn(async () => null),
  backupConfigured: vi.fn(() => false),
}));
// ---- v67 scaffolding: the live-order path is mocked, spot LTP 100 ----
const mockPrivate = vi.fn();
vi.mock('../server/mcp/coindcx.js', () => ({
  coindcxPrivate: (...args) => mockPrivate(...args),
  coindcxConnected: () => true,
  coindcxStatus: () => ({ connected: true }),
}));
vi.mock('../server/cryptoStream.js', () => ({
  fetchCoinDcxTickers: vi.fn(async () => [{ market: 'BTCINR', last_price: '100' }]),
}));

const {
  executeSignal, __resetForTests, __setJournalForTests, __setConfigForTests,
} = await import('../server/ai/coindcxOrders.js');
const {
  recordManualTrade, manualTradeView, lastKnownConvictionForView,
  manualMonitorStatus, startManualTradeMonitor, stopManualTradeMonitor,
  __resetManualStoreForTests, __monitorTickForTests, __monitorStateForTests,
} = await import('../server/ai/manualTrades.js');

// v67's STRONG card — a gate-passing fresh ensemble signal
const STRONG = (symbol = 'BTC', side = 'LONG') => ({
  symbol, market: 'CRYPTO', side, grade: 'STRONG',
  confidence: 82, agreement: 0.78, generatedAt: Date.now(),
  ltp: 100, plan: {
    entry: 100, stopLoss: 96.8, target1: 103.2, target2: 106.4,
    risk: 3.2, riskPct: 3.2, rewardRisk: 2, atrUsed: 2, planStyle: 'atr-based',
  },
  votes: [
    { id: 'trend', name: 'TrendMatrix', weight: 1.4, dir: 1, conf: 80, reasons: [] },
    { id: 'smc', name: 'SmartMoneyICT', weight: 1.1, dir: 1, conf: 60, reasons: [] },
  ],
  summary: 'x',
});

const SIGNAL_SNAPSHOT = {
  symbol: 'RELIANCE', market: 'INDIA', side: 'LONG', grade: 'STRONG',
  confidence: 82, agreement: 0.78, voters: 9,
  regime: 'REGIME ALIGNED',
  superIntel: { aiScore: 84 },
  plan: { entry: 1235, stopLoss: 1210, target1: 1260, target2: 1290, riskPct: 0.8, atr: 9.5 },
  votes: [
    { id: 'trend', name: 'TrendMatrix', dir: 1, conf: 88 },
    { id: 'momentum', name: 'MomentumX', dir: 1, conf: 74 },
  ],
  summary: '9-model committee LONG',
};

beforeEach(() => {
  __resetForTests();
  __setJournalForTests({ entries: [], positions: [] });
  __setConfigForTests({ mode: 'paper', dailyMaxTrades: 50, maxOpenPositions: 5 });
  mockPrivate.mockReset();
  mockPrivate.mockResolvedValue({ orders: [{ id: 'oid-1' }] });
  _ticks.clear();
  __resetManualStoreForTests();
  stopManualTradeMonitor();
  __monitorStateForTests().alerts.clear();
});

// ============================================================
// 1) THE GAUNTLET WIRING — mode flows into getFreshSignal
// ============================================================
describe('v11.5 gauntlet wiring — executeSignal passes {mode} to the fresh-signal source', () => {
  it('PAPER: getFreshSignal receives (pair, {mode:"paper"}) — the board fallback can engage', async () => {
    const getFreshSignal = vi.fn(async () => STRONG());
    const out = await executeSignal({ symbol: 'BTC', side: 'LONG', mode: 'paper', getFreshSignal, source: 'test' });
    expect(getFreshSignal).toHaveBeenCalledWith('BTCINR', { mode: 'paper' });
    expect(out.ok).toBe(true);
  });

  it('LIVE: getFreshSignal receives (pair, {mode:"live"}) — the board fallback stays OFF', async () => {
    __setConfigForTests({ mode: 'live', dailyMaxTrades: 50, maxOpenPositions: 5 });
    const getFreshSignal = vi.fn(async () => STRONG());
    await executeSignal({ symbol: 'BTC', side: 'LONG', mode: 'live', getFreshSignal, source: 'test' });
    expect(getFreshSignal).toHaveBeenCalledWith('BTCINR', { mode: 'live' });
  });

  it('THE BUG 2 END-TO-END LOCK: a paper trade EXECUTES on a board-aged signal (deep path down)', async () => {
    // exactly what _boardFallbackForExec returns: a 9-minute-old STRONG
    // board row, provenance-stamped — gate 5 must accept it in paper mode
    const boardAged = {
      ...STRONG(),
      generatedAt: Date.now() - 9 * 60_000,
      __execSource: 'board',
      __signalAgeMs: 9 * 60_000,
    };
    const out = await executeSignal({
      symbol: 'BTC', side: 'LONG', mode: 'paper',
      getFreshSignal: async () => boardAged, source: 'test',
    });
    expect(out.ok).toBe(true); // was: "No fresh ensemble signal available for this pair"
    expect(out.position?.mode || out.entry?.mode || 'paper').toBeTruthy();
  });

  it('LIVE still rejects a board-aged signal (10-min paper window > 90s live window)', async () => {
    __setConfigForTests({ mode: 'live', dailyMaxTrades: 50, maxOpenPositions: 5 });
    const boardAged = {
      ...STRONG(),
      generatedAt: Date.now() - 9 * 60_000,
      __execSource: 'board',
      __signalAgeMs: 9 * 60_000,
    };
    const out = await executeSignal({
      symbol: 'BTC', side: 'LONG', mode: 'live',
      getFreshSignal: async () => boardAged, source: 'test',
    });
    expect(out.ok).toBe(false);
    expect(String(out.error || '')).toContain('stale');
  });
});

// ============================================================
// 2) THE MONITOR — conviction preserved on transient deep failures
// ============================================================
describe('v11.5 monitor — last-known conviction PRESERVED when the deep path fails', () => {
  it('ok:false deep after a successful vote keeps state + the ORIGINAL at stamp', async () => {
    const { trade } = recordManualTrade({
      market: 'INDIA', symbol: 'RELIANCE', side: 'LONG',
      entryPrice: 1235, qty: 10, signal: SIGNAL_SNAPSHOT,
    });
    _ticks.set('IN_RELIANCE', { price: 1240 });
    let fail = false;
    const getDeepSignal = vi.fn(async () => (
      fail
        ? { ok: false, reason: 'No data for RELIANCE on INDIA' }
        : { ok: true, signal: { side: 'LONG', grade: 'STRONG', voters: 9, superIntel: { aiScore: 86 } } }
    ));
    startManualTradeMonitor({
      getDeepSignal,
      depsForSignals: () => ({}),
      send: vi.fn(async () => ({ ok: true })),
      fetchIndiaQuotes: vi.fn(),
      fetchIndexSpot: vi.fn(),
      usdInrOf: async () => 84,
    });
    // tick 1 — healthy vote (entry 84 → current 86, same side → HOLDING)
    await __monitorTickForTests();
    expect(trade.__conviction.state).toBe('HOLDING');
    expect(trade.__conviction.currentScore).toBe(86);
    const at0 = trade.__conviction.at;
    expect(at0).toBeGreaterThan(0);

    // tick 2 — upstream dies. OLD behavior: UNKNOWN wipe (STALE bar).
    fail = true;
    trade.__convictionAt = 0; // bypass the 30s throttle for the test
    await __monitorTickForTests();
    expect(trade.__conviction.state).toBe('HOLDING');  // PRESERVED
    expect(trade.__conviction.currentScore).toBe(86);  // data intact
    expect(trade.__conviction.at).toBe(at0);           // original stamp — age honest
  });

  it('a THROWN deep call after a successful vote also preserves (and records lastError)', async () => {
    const { trade } = recordManualTrade({
      market: 'INDIA', symbol: 'TCS', side: 'LONG',
      entryPrice: 100, qty: 1, signal: SIGNAL_SNAPSHOT,
    });
    _ticks.set('IN_TCS', { price: 101 });
    let boom = false;
    const getDeepSignal = vi.fn(async () => {
      if (boom) throw new Error('upstream timeout');
      return { ok: true, signal: { side: 'LONG', grade: 'STRONG', voters: 9, superIntel: { aiScore: 84 } } };
    });
    startManualTradeMonitor({ getDeepSignal, send: vi.fn(async () => ({ ok: true })) });
    await __monitorTickForTests();
    expect(trade.__conviction.state).toBe('HOLDING');
    const at0 = trade.__conviction.at;

    boom = true;
    trade.__convictionAt = 0;
    await __monitorTickForTests();
    expect(trade.__conviction.state).toBe('HOLDING'); // not UNKNOWN
    expect(trade.__conviction.at).toBe(at0);          // original stamp
    expect(manualMonitorStatus().lastError).toContain('upstream timeout');
  });

  it('repeated failures keep preserving (no UNKNOWN wipe-loop while a real vote exists)', async () => {
    const { trade } = recordManualTrade({
      market: 'INDIA', symbol: 'INFY', side: 'LONG',
      entryPrice: 100, qty: 1, signal: SIGNAL_SNAPSHOT,
    });
    _ticks.set('IN_INFY', { price: 100 });
    let fail = false;
    const getDeepSignal = vi.fn(async () => (
      fail ? { ok: false, reason: 'down' } : { ok: true, signal: { side: 'LONG', grade: 'STRONG', voters: 9, superIntel: { aiScore: 84 } } }
    ));
    startManualTradeMonitor({ getDeepSignal, send: vi.fn(async () => ({ ok: true })) });
    await __monitorTickForTests();
    const at0 = trade.__conviction.at;
    fail = true;
    for (let i = 0; i < 3; i++) {
      trade.__convictionAt = 0;
      await __monitorTickForTests();
      expect(trade.__conviction.state).toBe('HOLDING');
      expect(trade.__conviction.at).toBe(at0);
    }
  });

  it('a trade that NEVER voted still degrades to UNKNOWN (the honest STALE bar)', async () => {
    const { trade } = recordManualTrade({
      market: 'INDIA', symbol: 'WIPRO', side: 'LONG',
      entryPrice: 100, qty: 1, signal: SIGNAL_SNAPSHOT,
    });
    _ticks.set('IN_WIPRO', { price: 100 });
    startManualTradeMonitor({ getDeepSignal: vi.fn(async () => ({ ok: false, reason: 'down' })), send: vi.fn() });
    await __monitorTickForTests();
    expect(trade.__conviction.state).toBe('UNKNOWN');
  });

  it('recovery: a later successful vote REPLACES the preserved one (self-healing)', async () => {
    const { trade } = recordManualTrade({
      market: 'INDIA', symbol: 'SBIN', side: 'LONG',
      entryPrice: 100, qty: 1, signal: SIGNAL_SNAPSHOT,
    });
    _ticks.set('IN_SBIN', { price: 100 });
    let fail = false;
    const getDeepSignal = vi.fn(async () => (
      fail
        ? { ok: false, reason: 'down' }
        : { ok: true, signal: { side: 'SHORT', grade: 'STRONG', voters: 9, superIntel: { aiScore: 95 } } }
    ));
    startManualTradeMonitor({ getDeepSignal, send: vi.fn(async () => ({ ok: true })) });
    await __monitorTickForTests();
    expect(trade.__conviction.state).toBe('FLIPPED'); // entry LONG, fresh SHORT
    const at0 = trade.__conviction.at;

    fail = true;
    trade.__convictionAt = 0;
    await __monitorTickForTests();
    expect(trade.__conviction.state).toBe('FLIPPED'); // preserved through the outage
    expect(trade.__conviction.at).toBe(at0);

    fail = false;
    trade.__convictionAt = 0;
    await __monitorTickForTests();
    expect(trade.__conviction.state).toBe('FLIPPED'); // re-voted fresh
    expect(trade.__conviction.at).toBeGreaterThanOrEqual(at0); // NEW stamp — not the old one
  });
});

// ============================================================
// 3) THE ROUTE FALLBACK — lastKnownConvictionForView + the banner
// ============================================================
describe('v11.5 route fallback — lastKnownConvictionForView + the banner it buys', () => {
  it('serves the last REAL vote (any state, any age)', () => {
    const c = { state: 'HOLDING', delta: 2, currentScore: 86, side: 'BUY', at: 12345 };
    expect(lastKnownConvictionForView({ __conviction: c })).toBe(c);
    const w = { state: 'WEAKENING', delta: -9, currentScore: 70, at: 999 };
    expect(lastKnownConvictionForView({ __conviction: w })).toBe(w);
  });

  it('never serves UNKNOWN or missing convictions (honest STALE)', () => {
    expect(lastKnownConvictionForView({ __conviction: { state: 'UNKNOWN', at: 1 } })).toBeNull();
    expect(lastKnownConvictionForView({ __conviction: null })).toBeNull();
    expect(lastKnownConvictionForView({})).toBeNull();
    expect(lastKnownConvictionForView(null)).toBeNull();
  });

  it('a preserved conviction keeps the banner THESIS_INTACT — not the dead STALE bar', () => {
    const trade = { side: 'BUY', entryPrice: 1235, status: 'OPEN', openedAt: Date.now() - 5 * 60_000, origin: SIGNAL_SNAPSHOT };
    const v = manualTradeView(trade, {
      ltp: 1240,
      conviction: { state: 'HOLDING', delta: 2, currentScore: 86, side: 'BUY', at: Date.now() - 5 * 60_000 },
    });
    expect(v.__view.banner).toBe('THESIS_INTACT'); // was: 'STALE — conviction data missing'
    expect(v.__view.conviction.at).toBeGreaterThan(0); // the vote's own stamp is visible
  });

  it('the view degrades honestly when there was NEVER a vote', () => {
    const trade = { side: 'BUY', entryPrice: 1235, status: 'OPEN', openedAt: Date.now(), origin: SIGNAL_SNAPSHOT };
    const v = manualTradeView(trade, { ltp: 1240, conviction: null });
    expect(v.__view.banner).toBe('STALE');
    // the missing-conviction branch stays byte-identical to the locked
    // shape (manualTrades.test.ts:401) — no `at` key is added there.
    expect(v.__view.conviction.at).toBeUndefined();
  });
});
