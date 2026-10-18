// ============================================================
// test/manualTrades.test.ts — v10.16 SECTION 2: MANUAL TRADE TRACKER
// ------------------------------------------------------------
// LOCKED HERE:
//   • the pure math: P&L (direction/lot/fx-domain), level distances
//     (favor-frame signed), entry-vs-LTP deviation warn
//   • the STATE BANNER priority: TARGET_HIT > EXIT_NOW > WEAKENING >
//     STALE > THESIS_INTACT
//   • the SNAPSHOT FREEZE: plan/votes/regime/aiScore at record time —
//     the baseline every later conviction delta is measured against
//   • CRUD validation (symbol/side/price/qty + F&O fields) + honest
//     close (price or live stamp; never a fake 0 exit)
//   • LTP resolution: tick-store keys per market, India fallback,
//     OPTION Black-Scholes re-price on the live underlying
//   • the ALERT ladder: flip (EXIT NOW, immediate) / SL approach
//     (0.3×ATR) / T1+T2 (once each) / cooldowns
//   • the 5s level-touch wiring contract: rows satisfy
//     telegramPush.detectLevelTouches (status OPEN · LONG/SHORT sides)
//     so the user's own trades ride the SAME pipeline
//   • the monitor loop: deps live on _mon.deps (the wiring bug this
//     suite locks out), conviction stamping, idle parking
// Same hermetic scaffolding as positionConviction/paperHistory suites.
// ============================================================
import { describe, it, expect, beforeEach, vi } from 'vitest';

// ---- hermetic store (no disk) ----
const _disk = vi.hoisted(() => new Map());
vi.mock('../server/lib/store.js', () => ({
  loadJSON: (f, d) => (_disk.has(f) ? _disk.get(f) : d),
  saveJSON: (f, v) => { _disk.set(f, v); },
}));
// ---- no backup IO ----
// v12.7: manualTrades now imports restoreBackup + backupConfigured (the
// encrypted durable boot restore) and durablePut/decryptJSON — the mock
// factory must provide them or the module-eval boot-restore guard throws.
vi.mock('../server/intraday/backup.js', () => ({
  scheduleBackup: vi.fn(),
  restoreBackup: vi.fn(async () => null),
  backupConfigured: vi.fn(() => false),
  flushBackupNow: vi.fn(),
}));
vi.mock('../server/mcp/durable.js', () => ({
  durablePut: vi.fn(() => false),
  decryptJSON: vi.fn(() => null),
  durableConfigured: vi.fn(() => false),
}));
// ---- controllable live tick store ----
const _ticks = vi.hoisted(() => new Map());
vi.mock('../server/liveFeed.js', () => ({
  getTick: (k) => _ticks.get(k) || null,
}));
// ---- telegramPush's transitive imports stay hermetic (same boundary
// mocks as test/telegramPush.test.ts — only the PURE detector +
// formatter are consumed here) ----
vi.mock('../server/ai/coindcxOrders.js', () => ({
  getPositionsWithPnl: vi.fn(async () => ({ positions: [] })),
  loadConfig: vi.fn(() => ({ killSwitch: false })),
}));
vi.mock('../server/intraday/paperTrading.js', () => ({
  getPaperSummary: vi.fn(() => ({ open: [] })),
}));
vi.mock('../server/ai/secrets.js', () => ({
  telegramConfig: vi.fn(() => ({ token: 'T', chatId: 'C', source: 'env' })),
  sendTelegramMessage: vi.fn(async () => ({ ok: true })),
}));

import { __resetReversalForTests as _resetRevCfg } from '../server/ai/reversalEngine.js';
import {
  validateEntryVsLtp, manualPnlOf, manualLevelDistances, stateOfManualTrade,
  manualConvictionOf, flipSummary, manualTradesToPositionRows,
  recordManualTrade, listManualTrades, getManualTrade, closeManualTrade,
  ltpForManualTrade, manualTradeView, evaluateManualTradeAlerts,
  manualMonitorStatus, startManualTradeMonitor, stopManualTradeMonitor,
  __resetManualStoreForTests, __setManualStateForTests,
  __monitorTickForTests, __monitorStateForTests,
  // v12.0: R-multiple / MFE-MAE excursion / exit-quality / stats
  manualRiskPct, updateExcursion, manualRStats, exitQualityOf, manualStats,
} from '../server/ai/manualTrades.js';
import { detectLevelTouches, formatLevelTouch } from '../server/ai/telegramPush.js';

const SIGNAL_SNAPSHOT = {
  symbol: 'RELIANCE', market: 'INDIA', side: 'LONG', grade: 'STRONG',
  confidence: 82, agreement: 0.78, voters: 9,
  regime: 'REGIME ALIGNED',
  superIntel: { aiScore: 84 },
  plan: { entry: 1235, stopLoss: 1210, target1: 1260, target2: 1290, riskPct: 0.8, atr: 9.5 },
  votes: [
    { id: 'trend', name: 'TrendMatrix', dir: 1, conf: 88 },
    { id: 'momentum', name: 'MomentumX', dir: 1, conf: 74 },
    { id: 'options', name: 'OptionsFlow', dir: -1, conf: 66 },
  ],
  summary: '9-model committee LONG',
};

beforeEach(() => {
  _disk.clear();
  _ticks.clear();
  __resetManualStoreForTests();
  stopManualTradeMonitor();
  // the module-level alert-cooldown map survives store resets (ids
  // restart at 1) — clear it or test N+1 inherits test N's cooldowns.
  __monitorStateForTests().alerts.clear();
});

// ------------------------------------------------------------
describe('validateEntryVsLtp — the typo guard (warn, never block)', () => {
  it('within tolerance → no warn, deviation reported', () => {
    const r = validateEntryVsLtp({ entryPrice: 1240, ltp: 1235.3 });
    expect(r.warn).toBe(false);
    expect(r.deviationPct).toBeCloseTo(0.4, 1);
  });

  it('beyond tolerance → warn (a typo here corrupts every downstream P&L)', () => {
    const r = validateEntryVsLtp({ entryPrice: 1240, ltp: 1000 });
    expect(r.warn).toBe(true);
    expect(r.deviationPct).toBeCloseTo(24, 0);
  });

  it('missing prices → honest no-warn, null deviation', () => {
    expect(validateEntryVsLtp({ entryPrice: null, ltp: 100 })).toEqual({ warn: false, deviationPct: null });
    expect(validateEntryVsLtp({ entryPrice: 100, ltp: null })).toEqual({ warn: false, deviationPct: null });
  });
});

// ------------------------------------------------------------
describe('manualPnlOf — direction / lots / currency-domain math', () => {
  it('India equity LONG: +pct and native INR', () => {
    const t = { market: 'INDIA', side: 'BUY', entryPrice: 100, qty: 10 };
    const p = manualPnlOf(t, 110);
    expect(p.pnlPct).toBeCloseTo(10, 2);
    expect(p.pnlINR).toBeCloseTo(100, 2);
    expect(p.pnlUSDT).toBeNull();
    expect(p.currency).toBe('INR');
  });

  it('SHORT flips the sign (SELL side reads a falling price as profit)', () => {
    const t = { market: 'INDIA', side: 'SELL', entryPrice: 100, qty: 10 };
    const p = manualPnlOf(t, 90);
    expect(p.pnlPct).toBeCloseTo(10, 2);
    expect(p.pnlINR).toBeCloseTo(100, 2);
  });

  it('FUTURES (USDT domain): native USDT + fx-converted INR', () => {
    const t = { market: 'FUTURES', side: 'BUY', entryPrice: 100, qty: 2 };
    const p = manualPnlOf(t, 105, { usdInr: 84 });
    expect(p.pnlUSDT).toBeCloseTo(10, 3);
    expect(p.pnlINR).toBeCloseTo(840, 1);
    expect(p.currency).toBe('USDT');
  });

  it('OPTION trades multiply qty (LOTS) by lotSize — the F&O paper-card convention', () => {
    const t = { market: 'INDIA', side: 'BUY', entryPrice: 100, qty: 2, lotSize: 75, assetKind: 'OPTION' };
    const p = manualPnlOf(t, 102);
    expect(p.pnlINR).toBeCloseTo(300, 1); // (102-100) × 2 lots × 75
    expect(p.pnlPct).toBeCloseTo(2, 2);
  });

  it('no live price → honest zeros (never a fake number)', () => {
    const p = manualPnlOf({ market: 'INDIA', side: 'BUY', entryPrice: 100, qty: 5 }, null);
    expect(p.pnlINR).toBe(0);
    expect(p.pnlPct).toBe(0);
    const u = manualPnlOf({ market: 'FUTURES', side: 'BUY', entryPrice: 100, qty: 5 }, null);
    expect(u.pnlUSDT).toBe(0);
  });
});

// ------------------------------------------------------------
describe('manualLevelDistances — favor-frame signed distances', () => {
  const plan = { stopLoss: 1210, target1: 1260, target2: 1290 };

  it('LONG: SL behind (negative), T1/T2 ahead (positive)', () => {
    const d = manualLevelDistances({ side: 'BUY', entryPrice: 1235, origin: { plan } }, 1240);
    expect(d.sl).toBeLessThan(0);
    expect(d.t1).toBeGreaterThan(0);
    expect(d.t2).toBeGreaterThan(0);
  });

  it('SHORT: the SAME plan mirrors (SL above = adverse)', () => {
    // a short entered at 1260 with SL 1290 / T1 1210 — reading 1240
    const shortPlan = { stopLoss: 1290, target1: 1210, target2: 1180 };
    const d = manualLevelDistances({ side: 'SELL', entryPrice: 1260, origin: { plan: shortPlan } }, 1240);
    expect(d.sl).toBeLessThan(0);   // SL above → against the short
    expect(d.t1).toBeGreaterThan(0); // T1 below → in favor
  });

  it('missing entry/ltp or levels → {} / nulls, never NaN', () => {
    expect(manualLevelDistances({ side: 'BUY', entryPrice: null }, 100)).toEqual({});
    expect(manualLevelDistances({ side: 'BUY', entryPrice: 100 }, null)).toEqual({});
    const d = manualLevelDistances({ side: 'BUY', entryPrice: 100, origin: { plan: {} } }, 100);
    expect(d.sl).toBeNull();
    expect(d.t1).toBeNull();
    expect(d.t2).toBeNull();
  });
});

// ------------------------------------------------------------
describe('stateOfManualTrade — the escalating banner', () => {
  const trade = { side: 'BUY', entryPrice: 1235, origin: { plan: { target1: 1260, target2: 1290 } } };

  it('TARGET_HIT beats EXIT_NOW (a reached target is bookable truth)', () => {
    expect(stateOfManualTrade({ convictionState: 'FLIPPED', ltp: 1265, trade })).toBe('TARGET_HIT');
  });

  it('FLIPPED → EXIT_NOW (thesis invalidated — the red pulsing row)', () => {
    expect(stateOfManualTrade({ convictionState: 'FLIPPED', ltp: 1240, trade })).toBe('EXIT_NOW');
  });

  it('WEAKENING / unknown / intact map straight through', () => {
    expect(stateOfManualTrade({ convictionState: 'WEAKENING', ltp: 1240, trade })).toBe('WEAKENING');
    expect(stateOfManualTrade({ convictionState: null, ltp: 1240, trade })).toBe('STALE');
    expect(stateOfManualTrade({ convictionState: 'UNKNOWN', ltp: 1240, trade })).toBe('STALE');
    expect(stateOfManualTrade({ convictionState: 'HOLDING', ltp: 1240, trade })).toBe('THESIS_INTACT');
    expect(stateOfManualTrade({ convictionState: 'STRENGTHENING', ltp: 1240, trade })).toBe('THESIS_INTACT');
  });
});

// ------------------------------------------------------------
describe('manualConvictionOf + flipSummary — the WHY behind a flip', () => {
  const trade = { side: 'BUY', origin: { aiScore: 84, votes: SIGNAL_SNAPSHOT.votes } };

  it('fresh opposite signal with quorum → FLIPPED (uses positionConviction core)', () => {
    const fresh = { side: 'SHORT', grade: 'STRONG', voters: 9, superIntel: { aiScore: 80 } };
    const c = manualConvictionOf(trade, fresh);
    expect(c.state).toBe('FLIPPED');
    expect(c.currentScore).toBe(80);
  });

  it('flipSummary names the models that switched sides vs entry (not the ones that always opposed)', () => {
    const fresh = {
      side: 'SHORT', superIntel: { aiScore: 80 },
      votes: [
        { id: 'trend', name: 'TrendMatrix', dir: -1 },     // was ours (dir 1) → FLIPPED
        { id: 'momentum', name: 'MomentumX', dir: 0 },      // was ours → now abstaining
        { id: 'options', name: 'OptionsFlow', dir: -1 },    // always opposed → not "ours"
        { id: 'newmodel', name: 'NewModel', dir: -1 },      // wasn't at entry → ignored
      ],
    };
    const w = flipSummary(trade, fresh);
    expect(w.flipped).toEqual(['TrendMatrix']);
    expect(w.abstainedNew).toEqual(['MomentumX']);
    expect(w.entryScore).toBe(84);
    expect(w.curScore).toBe(80);
  });

  it('no fresh signal → empty judgment aid', () => {
    const w = flipSummary(trade, null);
    expect(w.flipped).toEqual([]);
    expect(w.abstainedNew).toEqual([]);
  });
});

// ------------------------------------------------------------
describe('recordManualTrade — validation + THE SNAPSHOT FREEZE', () => {
  it('a valid trade records OK with the full originating snapshot frozen', () => {
    const out = recordManualTrade({
      market: 'INDIA', symbol: 'RELIANCE', side: 'LONG',
      entryPrice: 1235, qty: 10, ltp: 1235.3, signal: SIGNAL_SNAPSHOT,
    });
    expect(out.ok).toBe(true);
    expect(out.warn).toBeNull();
    const t = out.trade;
    expect(t.id).toBe(1);
    expect(t.status).toBe('OPEN');
    expect(t.market).toBe('INDIA');
    // THE BASELINE: plan + votes + regime + aiScore frozen verbatim
    expect(t.origin.aiScore).toBe(84);
    expect(t.origin.regime).toBe('REGIME ALIGNED');
    expect(t.origin.grade).toBe('STRONG');
    expect(t.origin.voters).toBe(9);
    expect(t.origin.plan).toMatchObject({ entry: 1235, stopLoss: 1210, target1: 1260, target2: 1290, atr: 9.5 });
    expect(t.origin.votes).toHaveLength(3);
    expect(t.origin.votes[0]).toEqual({ id: 'trend', name: 'TrendMatrix', dir: 1, conf: 88 });
  });

  it('rejects bad symbol / side / price / qty with honest errors', () => {
    expect(recordManualTrade({ symbol: 'X', side: 'BUY', entryPrice: 10, qty: 1 }).error).toContain('symbol');
    expect(recordManualTrade({ symbol: 'RELIANCE', side: 'SIDEWAYS', entryPrice: 10, qty: 1 }).error).toContain('side');
    expect(recordManualTrade({ symbol: 'RELIANCE', side: 'BUY', entryPrice: 0, qty: 1 }).error).toContain('entryPrice');
    expect(recordManualTrade({ symbol: 'RELIANCE', side: 'BUY', entryPrice: 10, qty: 0 }).error).toContain('qty');
  });

  it('F&O trades REQUIRE strike + CE/PE + expiry (the BS re-price contract)', () => {
    const base = { market: 'INDIA', symbol: 'NIFTY', side: 'LONG', entryPrice: 120, qty: 2, strike: 24500 };
    expect(recordManualTrade({ ...base, optType: 'XX', expiry: '2027-06-24' }).error).toContain('CE/PE');
    expect(recordManualTrade({ ...base, optType: 'CE', expiry: '24-06-2027' }).error).toContain('expiry');
    const ok = recordManualTrade({ ...base, optType: 'CE', expiry: '2027-06-24', iv: 13, lotSize: 75 });
    expect(ok.ok).toBe(true);
    expect(ok.trade.assetKind).toBe('OPTION');
    expect(ok.trade.lotSize).toBe(75);
    expect(ok.trade.underlying).toBe('NIFTY');
  });

  it('a wild entry-vs-LTP deviation WARNS but records (genuine fills can be off)', () => {
    const out = recordManualTrade({
      market: 'INDIA', symbol: 'RELIANCE', side: 'LONG',
      entryPrice: 1500, qty: 5, ltp: 1235.3, signal: SIGNAL_SNAPSHOT,
    });
    expect(out.ok).toBe(true);
    expect(out.warn).toContain('typo');
    expect(out.trade.entryWarn).toContain('%');
  });

  it('ids increment; list is open-first + newest-first; status filter works', () => {
    const a = recordManualTrade({ market: 'INDIA', symbol: 'AAA', side: 'BUY', entryPrice: 10, qty: 1 });
    const b = recordManualTrade({ market: 'INDIA', symbol: 'BBB', side: 'BUY', entryPrice: 10, qty: 1 });
    expect(b.trade.id).toBe(a.trade.id + 1);
    closeManualTrade(a.trade.id, { exitPrice: 11 });
    const list = listManualTrades();
    expect(list[0].symbol).toBe('BBB'); // open first
    expect(list.filter(t => t.status === 'CLOSED')).toHaveLength(1);
    expect(listManualTrades({ status: 'OPEN' })).toHaveLength(1);
  });
});

// ------------------------------------------------------------
describe('closeManualTrade — the honest exit', () => {
  it('closes at a given price with P&L stamped', () => {
    const { trade } = recordManualTrade({
      market: 'INDIA', symbol: 'RELIANCE', side: 'BUY', entryPrice: 100, qty: 10,
    });
    const out = closeManualTrade(trade.id, { exitPrice: 105, reason: 'booked' });
    expect(out.ok).toBe(true);
    expect(out.trade.status).toBe('CLOSED');
    expect(out.trade.exitPrice).toBe(105);
    expect(out.trade.closeReason).toBe('booked');
    expect(out.pnl.pnlPct).toBeCloseTo(5, 2);
    expect(out.trade.exitPnlINR).toBeCloseTo(50, 1);
  });

  it('closes at the LIVE stamp when no price is given', () => {
    const { trade } = recordManualTrade({ market: 'INDIA', symbol: 'TCS', side: 'BUY', entryPrice: 100, qty: 1 });
    trade.__ltp = 103; trade.__ltpAt = Date.now(); // the monitor's sweep stamp (v18.6.4: LTP apni ghadi ke saath aata hai)
    const out = closeManualTrade(trade.id, {});
    expect(out.ok).toBe(true);
    expect(out.trade.exitPrice).toBe(103);
  });

  it('unknown id / already closed / no price anywhere → honest errors, never a fake 0 exit', () => {
    expect(closeManualTrade(999, {})).toEqual({ ok: false, error: 'trade not found' });
    const { trade } = recordManualTrade({ market: 'INDIA', symbol: 'TCS', side: 'BUY', entryPrice: 100, qty: 1 });
    closeManualTrade(trade.id, { exitPrice: 101 });
    expect(closeManualTrade(trade.id, { exitPrice: 102 }).error).toBe('already closed');
    const { trade: t2 } = recordManualTrade({ market: 'INDIA', symbol: 'WIPRO', side: 'BUY', entryPrice: 100, qty: 1 });
    expect(closeManualTrade(t2.id, {}).error).toContain('exit price unavailable');
  });
});

// ------------------------------------------------------------
describe('ltpForManualTrade — LTP resolution per market', () => {
  it('reads the tick store under the per-market key', async () => {
    _ticks.set('IN_RELIANCE', { price: 1236 });
    _ticks.set('FUT_SOL', { price: 21.5 });
    _ticks.set('GLOB_MU', { price: 180 });
    expect(await ltpForManualTrade({ market: 'INDIA', symbol: 'RELIANCE', status: 'OPEN' })).toBe(1236);
    expect(await ltpForManualTrade({ market: 'FUTURES', symbol: 'SOL', status: 'OPEN' })).toBe(21.5);
    expect(await ltpForManualTrade({ market: 'GLOBALFUTURES', symbol: 'MU', status: 'OPEN' })).toBe(180);
  });

  it('India falls back to the injected TV batch when the tick store is cold', async () => {
    const fetchIndiaQuotes = vi.fn(async () => ({ RELIANCE: { price: 1237.5 } }));
    const px = await ltpForManualTrade(
      { market: 'INDIA', symbol: 'RELIANCE', status: 'OPEN' },
      { fetchIndiaQuotes },
    );
    expect(px).toBe(1237.5);
    expect(fetchIndiaQuotes).toHaveBeenCalledWith(['RELIANCE']);
  });

  it('OPTION trades re-price the premium via Black-Scholes on the live underlying', async () => {
    // dynamic ~30d expiry — a hardcoded date is a time bomb
    const expiry = new Date(Date.now() + 30 * 86400_000).toISOString().slice(0, 10);
    const opt = {
      market: 'INDIA', symbol: 'NIFTY', underlying: 'NIFTY', status: 'OPEN', assetKind: 'OPTION',
      optType: 'CE', strike: 24000, expiry, iv: 13,
    };
    const fetchIndexSpot = vi.fn(async () => ({ price: 24500 }));
    const px = await ltpForManualTrade(opt, { fetchIndexSpot });
    expect(px).not.toBeNull();
    expect(px).toBeGreaterThan(550); // 500 intrinsic + real 30d time value
    expect(px).toBeLessThan(900);    // and not absurd
  });

  it('expired option → intrinsic only; CLOSED trade → null', async () => {
    const opt = {
      market: 'INDIA', symbol: 'NIFTY', underlying: 'NIFTY', status: 'OPEN', assetKind: 'OPTION',
      optType: 'CE', strike: 24000, expiry: '2020-01-01', iv: 13,
    };
    const fetchIndexSpot = vi.fn(async () => ({ price: 24500 }));
    expect(await ltpForManualTrade(opt, { fetchIndexSpot })).toBe(500); // intrinsic
    expect(await ltpForManualTrade({ market: 'INDIA', symbol: 'X', status: 'CLOSED' })).toBeNull();
  });
});

// ------------------------------------------------------------
describe('manualTradeView — the UI row contract', () => {
  it('wires ltp/pnl/distances/conviction/banner + ageMin', () => {
    const { trade } = recordManualTrade({
      market: 'INDIA', symbol: 'RELIANCE', side: 'LONG',
      entryPrice: 1235, qty: 10, signal: SIGNAL_SNAPSHOT,
    });
    const v = manualTradeView(trade, {
      ltp: 1250,
      conviction: { state: 'HOLDING', delta: -2, currentScore: 82, entryScore: 84 },
    });
    expect(v.__ltp).toBe(1250);
    expect(v.__view.pnl.pnlPct).toBeCloseTo(1.21, 2); // (1250−1235)/1235 = 1.2145…
    expect(v.__view.banner).toBe('THESIS_INTACT');
    expect(v.__view.conviction.delta).toBe(-2);
    expect(v.__view.ageMin).toBeGreaterThanOrEqual(0);
    expect(v.__view.distances.sl).toBeLessThan(0);
  });

  it('missing conviction degrades honestly (nulls, not invented numbers)', () => {
    const v = manualTradeView({ side: 'BUY', entryPrice: 100, origin: { aiScore: 80 } }, { ltp: 101 });
    expect(v.__view.conviction).toEqual({ state: null, delta: null, currentScore: null, entryScore: 80 });
  });
});

// ------------------------------------------------------------
describe('evaluateManualTradeAlerts — the push ladder', () => {
  const mkTrade = (over = {}) => {
    const { trade } = recordManualTrade({
      market: 'INDIA', symbol: 'RELIANCE', side: 'LONG',
      entryPrice: 1235, qty: 10, signal: SIGNAL_SNAPSHOT,
    });
    return Object.assign(trade, over);
  };

  it('conviction FLIP → immediate EXIT NOW push carrying the WHY (models + score move)', async () => {
    const t = mkTrade({ __ltp: 1240 });
    const send = vi.fn(async () => ({ ok: true }));
    const pushed = await evaluateManualTradeAlerts(t, {
      send,
      conviction: { state: 'FLIPPED', delta: -160, currentScore: 80, side: 'SELL' },
      freshSignal: {
        side: 'SHORT', superIntel: { aiScore: 80 },
        votes: [
          { id: 'trend', name: 'TrendMatrix', dir: -1 },
          { id: 'momentum', name: 'MomentumX', dir: 0 },
        ],
      },
    });
    expect(pushed).toContain('flip');
    expect(send).toHaveBeenCalledTimes(1);
    const text = send.mock.calls[0][0];
    expect(text).toContain('EXIT NOW');
    expect(text).toContain('RELIANCE');
    expect(text).toContain('TrendMatrix'); // the flipped model named
    expect(text).toContain('84');          // entry score in the WHY
  });

  it('cooldown: an immediate second evaluation does NOT re-push the flip', async () => {
    const t = mkTrade({ __ltp: 1240 });
    const send = vi.fn(async () => ({ ok: true }));
    const args = { send, conviction: { state: 'FLIPPED', currentScore: 80 }, freshSignal: null };
    await evaluateManualTradeAlerts(t, args);
    const pushed2 = await evaluateManualTradeAlerts(t, args);
    expect(pushed2).toEqual([]);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('SL within 0.3×ATR → SL-approach push (suppressed while EXIT_NOW)', async () => {
    const t = mkTrade({ __ltp: 1212 }); // SL 1210, ATR 9.5 → |dist| 2 ≤ 0.3×9.5 = 2.85
    const send = vi.fn(async () => ({ ok: true }));
    const pushed = await evaluateManualTradeAlerts(t, { send, conviction: { state: 'HOLDING' } });
    expect(pushed).toContain('sl');
    expect(send.mock.calls[0][0]).toContain('SL approach');
    // EXIT_NOW suppresses the SL nudge (no noise during the bigger signal)
    const t2 = mkTrade({ __ltp: 1213 });
    const send2 = vi.fn(async () => ({ ok: true }));
    const p2 = await evaluateManualTradeAlerts(t2, { send: send2, conviction: { state: 'FLIPPED' } });
    expect(p2).toContain('flip');
    expect(p2).not.toContain('sl');
  });

  it('T1 and T2 each push ONCE (6h cooldown each)', async () => {
    const t = mkTrade({ __ltp: 1265 }); // T1 1260 touched
    const send = vi.fn(async () => ({ ok: true }));
    const pushed = await evaluateManualTradeAlerts(t, { send, conviction: { state: 'HOLDING' } });
    expect(pushed).toContain('t1');
    expect(send.mock.calls[0][0]).toContain('T1 HIT');
    // re-evaluate at T2 — t1 must not re-fire, t2 must
    t.__ltp = 1292;
    const p2 = await evaluateManualTradeAlerts(t, { send, conviction: { state: 'HOLDING' } });
    expect(p2).toContain('t2');
    expect(p2).not.toContain('t1');
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('fresh healthy trade → zero pushes (no noise)', async () => {
    const t = mkTrade({ __ltp: 1240 }); // mid-range, THESIS_INTACT, young
    const send = vi.fn(async () => ({ ok: true }));
    const pushed = await evaluateManualTradeAlerts(t, { send, conviction: { state: 'HOLDING' } });
    expect(pushed).toEqual([]);
    expect(send).not.toHaveBeenCalled();
  });

  it('a send failure is contained and RETRYABLE (no full-cooldown suppression, honest pushed flag)', async () => {
    // v10.18 contract: the FULL cooldown arms only on a successful send —
    // one transient Telegram blip must not eat the EXIT-NOW push for 30
    // minutes. A failed send reserves a short 30s failure-retry hold, and
    // the pushed flag honestly reports that nothing went out.
    const t = mkTrade({ __ltp: 1240 });
    const send = vi.fn(async () => { throw new Error('telegram down'); });
    const pushed = await evaluateManualTradeAlerts(t, {
      send, conviction: { state: 'FLIPPED', currentScore: 80 }, freshSignal: null,
    });
    expect(pushed).not.toContain('flip'); // nothing actually went out
    expect(send).toHaveBeenCalledTimes(1); // attempted, no crash
    // immediate re-evaluation is still held back (no double-send hammer)
    const pushed2 = await evaluateManualTradeAlerts(t, {
      send, conviction: { state: 'FLIPPED', currentScore: 80 }, freshSignal: null,
    });
    expect(pushed2).not.toContain('flip');
    expect(send).toHaveBeenCalledTimes(1);
    // after the 30s failure-retry window the alert fires again — and
    // once Telegram is healthy the FULL cooldown arms
    const nowSpy = vi.spyOn(Date, 'now');
    const base = Date.now();
    nowSpy.mockReturnValue(base + 31_000);
    const sendOk = vi.fn(async () => ({ ok: true }));
    const pushed3 = await evaluateManualTradeAlerts(t, {
      send: sendOk, conviction: { state: 'FLIPPED', currentScore: 80 }, freshSignal: null,
    });
    expect(pushed3).toContain('flip'); // recovered — the alert was never lost
    expect(sendOk).toHaveBeenCalledTimes(1);
    // full cooldown now armed: a 4th evaluation inside 30 min does not re-send
    const pushed4 = await evaluateManualTradeAlerts(t, {
      send: sendOk, conviction: { state: 'FLIPPED', currentScore: 80 }, freshSignal: null,
    });
    expect(pushed4).not.toContain('flip');
    expect(sendOk).toHaveBeenCalledTimes(1);
    nowSpy.mockRestore();
  });
});

// ------------------------------------------------------------
describe('manualTradesToPositionRows — the 5s level-touch wiring contract', () => {
  it('rows satisfy detectLevelTouches: status OPEN + LONG/SHORT sides + MAN- ids', () => {
    const { trade } = recordManualTrade({
      market: 'INDIA', symbol: 'RELIANCE', side: 'LONG',
      entryPrice: 1235, qty: 10, signal: SIGNAL_SNAPSHOT,
    });
    trade.__ltp = 1209; // at/below SL 1210 → the detector must FIRE (LONG: ltp ≤ sl)
    const rows = manualTradesToPositionRows([trade]);
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe('MAN-1');
    expect(rows[0].status).toBe('OPEN');
    expect(rows[0].side).toBe('LONG');
    const touches = detectLevelTouches(rows);
    expect(touches.map(t => t.kind)).toContain('SL');
    expect(touches[0].manual).toBe(true);
    // the push text carries the MANUAL tag (not the executor footer)
    const text = formatLevelTouch(touches[0]);
    expect(text).toContain('MANUAL');
    expect(text).toContain('aapka trade');
  });

  it('BUY/SELL is translated to LONG/SHORT — a BUY trade is never level-checked inverted', () => {
    const shortTrade = {
      id: 2, status: 'OPEN', market: 'INDIA', symbol: 'TCS', side: 'SELL',
      entryPrice: 400, qty: 5,
      origin: { plan: { stopLoss: 420, target1: 380 } },
      __ltp: 421, // above SL → SHORT stop touched
    };
    const rows = manualTradesToPositionRows([shortTrade]);
    expect(rows[0].side).toBe('SHORT');
    const touches = detectLevelTouches(rows);
    expect(touches.map(t => t.kind)).toContain('SL');
    // and the T1 at 380 must NOT fire for a SHORT at 421
    expect(touches.map(t => t.kind)).not.toContain('TP1');
  });

  it('CLOSED trades and priceless rows are skipped; INR-domain rows carry ₹ uP&L, USDT-domain stay null', () => {
    const openIndia = { id: 3, status: 'OPEN', market: 'INDIA', symbol: 'SBIN', side: 'BUY', entryPrice: 600, qty: 2, origin: { plan: {} }, __ltp: 610 };
    const openPerp = { id: 4, status: 'OPEN', market: 'FUTURES', symbol: 'SOL', side: 'BUY', entryPrice: 20, qty: 3, origin: { plan: {} }, __ltp: 22 };
    const closed = { id: 5, status: 'CLOSED', market: 'INDIA', symbol: 'OLD', side: 'BUY', entryPrice: 100, qty: 1, origin: { plan: {} }, __ltp: 101 };
    const noEntry = { id: 6, status: 'OPEN', market: 'INDIA', symbol: 'BAD', side: 'BUY', entryPrice: null, qty: 1 };
    const rows = manualTradesToPositionRows([openIndia, openPerp, closed, noEntry]);
    expect(rows.map(r => r.id)).toEqual(['MAN-3', 'MAN-4']);
    expect(rows[0].unrealizedPnlINR).toBeCloseTo(20, 1);  // (610-600)×2
    expect(rows[1].unrealizedPnlINR).toBeNull();           // USDT domain — omitted, not guessed
    expect(rows[1].liquidation).toBeNull();
    expect(rows[1].leverage).toBe(1);
  });
});

// ------------------------------------------------------------
describe('the monitor loop — 5s LTP sweep + 30s conviction re-vote', () => {
  it('parks idle with zero open trades (no error, no pushes)', async () => {
    startManualTradeMonitor({ send: vi.fn() });
    await __monitorTickForTests();
    const st = manualMonitorStatus();
    expect(st.ok).toBe(true);
    expect(st.openTrades).toBe(0);
    expect(st.lastError).toBeNull();
  });

  it('THE WIRING CONTRACT: deps are read from _mon.deps — a deep signal re-votes + fires alerts', async () => {
    const { trade } = recordManualTrade({
      market: 'INDIA', symbol: 'RELIANCE', side: 'LONG',
      entryPrice: 1235, qty: 10, signal: SIGNAL_SNAPSHOT,
    });
    _ticks.set('IN_RELIANCE', { price: 1240 });
    const send = vi.fn(async () => ({ ok: true }));
    const getDeepSignal = vi.fn(async () => ({
      ok: true,
      signal: {
        side: 'SHORT', grade: 'STRONG', voters: 9, superIntel: { aiScore: 80 },
        votes: [{ id: 'trend', name: 'TrendMatrix', dir: -1 }],
      },
    }));
    startManualTradeMonitor({
      getDeepSignal,
      depsForSignals: () => ({}),
      send,
      fetchIndiaQuotes: vi.fn(),
      fetchIndexSpot: vi.fn(),
      usdInrOf: async () => 84,
    });
    await __monitorTickForTests();
    // LTP sweep stamped from the tick store
    expect(trade.__ltp).toBe(1240);
    // conviction re-vote ran through the INJECTED getDeepSignal (not undefined)
    expect(getDeepSignal).toHaveBeenCalledWith('RELIANCE', 'INDIA', {});
    expect(trade.__conviction.state).toBe('FLIPPED');
    expect(trade.__conviction.side).toBe('SELL');
    // the EXIT NOW push fired with the WHY
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0]).toContain('EXIT NOW');
    // status is honest
    const st = manualMonitorStatus();
    expect(st.openTrades).toBe(1);
    expect(st.pushes).toBe(1);
  });

  it('a failing deep signal degrades to UNKNOWN conviction (never crashes the loop)', async () => {
    const { trade } = recordManualTrade({ market: 'INDIA', symbol: 'TCS', side: 'BUY', entryPrice: 100, qty: 1 });
    _ticks.set('IN_TCS', { price: 101 });
    startManualTradeMonitor({ getDeepSignal: vi.fn(async () => { throw new Error('boom'); }), send: vi.fn() });
    await __monitorTickForTests();
    expect(trade.__conviction.state).toBe('UNKNOWN');
    const st = manualMonitorStatus();
    expect(st.lastError).toContain('boom');
  });

  it('startManualTradeMonitor is idempotent (one timer, not a stack)', () => {
    startManualTradeMonitor({ send: vi.fn() });
    startManualTradeMonitor({ send: vi.fn() });
    const { mon } = __monitorStateForTests();
    expect(mon).toBeTruthy();
    expect(mon.timer).toBeTruthy();
    const timersBefore = mon.timer;
    startManualTradeMonitor({ send: vi.fn() });
    expect(__monitorStateForTests().mon.timer).toBe(timersBefore);
  });
});

// ============================================================
// v12.0 PRO TRADER — R-multiple · MFE/MAE excursion · exit quality
// ============================================================
describe('manualRiskPct — the 1R definition (frozen origin plan)', () => {
  const t = (side, entry, sl) => ({ side, entryPrice: entry, origin: { plan: { stopLoss: sl } } });
  it('LONG with SL below entry → adverse distance in %', () => {
    expect(manualRiskPct(t('BUY', 100, 95))).toBe(5);
  });
  it('SHORT with SL above entry → same math mirrored', () => {
    expect(manualRiskPct(t('SELL', 100, 106))).toBe(6);
  });
  it('an SL on the PROFIT side is not a stop — refused (null)', () => {
    expect(manualRiskPct(t('BUY', 100, 110))).toBeNull();
    expect(manualRiskPct(t('SELL', 100, 90))).toBeNull();
  });
  it('no plan / no SL → null (no fake 1R)', () => {
    expect(manualRiskPct({ side: 'BUY', entryPrice: 100 })).toBeNull();
    expect(manualRiskPct(t('BUY', 100, null))).toBeNull();
  });
});

describe('updateExcursion + manualRStats — MFE/MAE tracking', () => {
  const mk = () => ({ side: 'BUY', entryPrice: 100, status: 'OPEN', origin: { plan: { stopLoss: 95 } } });
  it('favorable moves raise peakR, adverse moves lower troughR', () => {
    const t = mk();
    updateExcursion(t, 104); // +4% on 5% risk = +0.8R
    updateExcursion(t, 97);  // −3% = −0.6R
    updateExcursion(t, 102); // +2% = +0.4R
    expect(t.__peakR).toBe(0.8);
    expect(t.__troughR).toBe(-0.6);
    expect(t.__mfePct).toBe(4);
    expect(t.__maePct).toBe(-3);
    const rs = manualRStats(t, 102);
    expect(rs.rNow).toBe(0.4);
    expect(rs.rPeak).toBe(0.8);
    expect(rs.rTrough).toBe(-0.6);
    expect(rs.capturePct).toBe(50); // 0.4 / 0.8
    expect(rs.riskPct).toBe(5);
  });
  it('SHORT side: adverse/favorable flip correctly', () => {
    const t = { side: 'SELL', entryPrice: 100, status: 'OPEN', origin: { plan: { stopLoss: 104 } } };
    updateExcursion(t, 98); // short +2% favorable, risk 4% → +0.5R
    expect(manualRStats(t, 98).rNow).toBe(0.5);
    updateExcursion(t, 101); // short −1% adverse → −0.25R
    expect(t.__troughR).toBe(-0.25);
  });
  it('no SL → no R math at all (all null, honest)', () => {
    const t = { side: 'BUY', entryPrice: 100, status: 'OPEN', origin: { plan: {} } };
    updateExcursion(t, 110);
    expect(t.__mfePct).toBe(10);       // raw excursion still tracked
    expect(t.__peakR).toBeUndefined(); // but no R without 1R
    expect(manualRStats(t, 110).rNow).toBeNull();
  });
  it('CLOSED trades read the exit price branch', () => {
    const t = { side: 'BUY', entryPrice: 100, status: 'CLOSED', exitPrice: 103, origin: { plan: { stopLoss: 95 } } };
    expect(manualRStats(t, null).rNow).toBe(0.6);
  });
});

describe('exitQualityOf — the report card', () => {
  it('CLEAN_WIN: winner kept most of the peak', () => {
    expect(exitQualityOf({ rFinal: 1.8, rPeak: 2.0 })).toBe('CLEAN_WIN');
  });
  it('GAVE_BACK: ≥1R peak, closed under 30% of it', () => {
    expect(exitQualityOf({ rFinal: 0.2, rPeak: 1.5 })).toBe('GAVE_BACK');
  });
  it('CUT_WINNER: green exit but <40% of a ≥1.5R peak', () => {
    expect(exitQualityOf({ rFinal: 0.7, rPeak: 2.0 })).toBe('CUT_WINNER'); // 35% kept — the 30-40% band
  });
  it('DISCIPLINED_LOSS vs OVERSHOOT_LOSS: the 1R line', () => {
    expect(exitQualityOf({ rFinal: -1.0, rPeak: 0.3 })).toBe('DISCIPLINED_LOSS');
    expect(exitQualityOf({ rFinal: -1.4, rPeak: 0.2 })).toBe('OVERSHOOT_LOSS');
  });
  it('UNKNOWN on missing data', () => {
    expect(exitQualityOf({ rFinal: null, rPeak: null })).toBe('UNKNOWN');
  });
});

describe('manualStats — the tracker track-record', () => {
  it('aggregates win-rate, avg R, capture + quality counts over closed trades', () => {
    const closed = [
      { status: 'CLOSED', side: 'BUY', entryPrice: 100, exitPrice: 110, openedAt: 1e6, closedAt: 1e6 + 60_000, origin: { plan: { stopLoss: 95 } }, __peakR: 2.0 },
      { status: 'CLOSED', side: 'BUY', entryPrice: 100, exitPrice: 96, openedAt: 2e6, closedAt: 2e6 + 120_000, origin: { plan: { stopLoss: 95 } }, __peakR: 0.2 },
      { status: 'OPEN', side: 'BUY', entryPrice: 100, origin: { plan: { stopLoss: 95 } } }, // ignored — open
    ];
    const s = manualStats(closed);
    expect(s.closed).toBe(2);
    expect(s.closedWithR).toBe(2);
    expect(s.wins).toBe(1);
    expect(s.losses).toBe(1);
    expect(s.winRate).toBe(50);
    expect(s.avgR).toBe(0.6); // (+2 − 0.8)/2
    expect(s.bestR).toBe(2.0);
    expect(s.worstR).toBe(-0.8);
    expect(s.avgHoldMin).toBe(2); // 1 min + 2 min
    expect(s.avgCapturePct).toBe(100); // the one winner closed AT its peak
    expect(s.disciplinedLosses).toBe(1);
    expect(s.overshootLosses).toBe(0);
  });
  it('empty book → honest nulls, never fake zeros', () => {
    const s = manualStats([]);
    expect(s.closed).toBe(0);
    expect(s.winRate).toBeNull();
    expect(s.avgR).toBeNull();
    expect(s.note).toMatch(/depend karte hain/i);
  });
});

describe('closeManualTrade — v12.0 exit freeze', () => {
  it('freezes exitR + peak + exit-quality on close', () => {
    // a plan that matches THIS trade's entry (100) — 1R = 5%
    const { trade } = recordManualTrade({ market: 'INDIA', symbol: 'TCS', side: 'BUY', entryPrice: 100, qty: 1, signal: { ...SIGNAL_SNAPSHOT, plan: { entry: 100, stopLoss: 95, target1: 110, target2: 120, riskPct: 5, atr: 2 } } });
    updateExcursion(trade, 108); // peak 8%/5% = 1.6R
    const out = closeManualTrade(trade.id, { exitPrice: 101 });
    expect(out.ok).toBe(true);
    expect(out.trade.exitR).toBe(0.2);   // 1%/5%
    expect(out.trade.exitPeakR).toBe(1.6);
    expect(out.trade.exitQuality).toBe('GAVE_BACK'); // green but only 12.5% of peak kept
    expect(out.r.rNow).toBe(0.2);
  });
});

describe('manualTradeView — the v12.0 wire contract', () => {
  it('open rows carry the r block; closed rows carry exitQuality', () => {
    const PLAN100 = { ...SIGNAL_SNAPSHOT, plan: { entry: 100, stopLoss: 95, target1: 110, target2: 120, riskPct: 5, atr: 2 } };
    const open = recordManualTrade({ market: 'INDIA', symbol: 'TCS', side: 'BUY', entryPrice: 100, qty: 1, signal: PLAN100 });
    updateExcursion(open.trade, 103);
    const v = manualTradeView(open.trade, { ltp: 103, conviction: null });
    expect(v.__view.r.rNow).toBe(0.6);       // 3%/5%
    expect(v.__view.r.rPeak).toBe(0.6);
    expect(v.__view.r.riskPct).toBe(5);       // from the injected plan (95/100)
    expect(v.__view.banner).toBeTruthy();

    const closed = recordManualTrade({ market: 'INDIA', symbol: 'INFY', side: 'BUY', entryPrice: 100, qty: 1, signal: PLAN100 });
    updateExcursion(closed.trade, 110);
    closeManualTrade(closed.trade.id, { exitPrice: 109 });
    const v2 = manualTradeView(closed.trade, { ltp: null, conviction: null });
    expect(v2.__view.r.rNow).toBe(1.8);
    expect(v2.__view.exitQuality).toBe('CLEAN_WIN');
  });
});

// ------------------------------------------------------------
// v13.1 SIGNAL VERIFICATION AGENT — the open-time SVA stamp on every
// manual trade + the OPT-IN reversal AUTO-CUT in the 5s sweep (the
// live XRP fix: ₹150 cap crossed → trade CLOSED at the crossing
// price, not left to bleed to −₹2,250).
// ------------------------------------------------------------
const XRP_BURN_SIGNAL = {
  symbol: 'XRP', market: 'FUTURES', side: 'LONG', grade: 'WATCH',
  confidence: 48, agreement: 1, voters: 3, totalModels: 11,
  obOs: { tag: 'OVERBOUGHT', rsi: 70.4 },
  chasing: { side: 'LONG', extAtr: 2.31, ref: 'EMA20', runBars: 4, runAtr: 2.8, severity: 'HARD', reason: 'stretched' },
  plan: { entry: 1.62, stopLoss: 1.54, target1: 1.7, target2: 1.78, riskPct: 5, rewardRisk: 1.0 },
  quality: { regime: { aligned: true, counterTrend: false } },
  superIntel: { aiScore: 57, winProb: { pWin: 48, pNeed: 50, edgePts: -2 } },
  summary: 'LONG 63% · 3/11 · ⛔ OVERBOUGHT RSI 70 — LONG entry suppressed',
};

const CLEAN_LONG_SIGNAL = {
  ...SIGNAL_SNAPSHOT, market: 'FUTURES', symbol: 'BTC',
  voters: 8, totalModels: 11,
  entryQuality: { band: 'PULLBACK', extAtr: 0.02, ref: 'EMA20' },
  mtf: { agreement: 0.8 },
  plan: { entry: 60000, stopLoss: 59000, target1: 62000, target2: 63000, riskPct: 1.7, rewardRisk: 2.0 },
  superIntel: { aiScore: 82, winProb: { pWin: 64, pNeed: 33.3, edgePts: 24 } },
};

describe('recordManualTrade — the v13.1 SVA open-time stamp', () => {
  it('the XRP-class burn signal stamps a REJECT verdict (FLIP/STAND_ASIDE) on the trade', () => {
    const out = recordManualTrade({
      market: 'FUTURES', symbol: 'XRP', side: 'BUY',
      entryPrice: 1.619, qty: 299.7, signal: XRP_BURN_SIGNAL,
    });
    expect(out.ok).toBe(true);
    const v = out.trade.verify;
    expect(v).toBeTruthy();
    expect(v.agent).toBe('SVA-v1');
    expect(['FLIP', 'STAND_ASIDE']).toContain(v.action);
    expect(v.sizeHint).toBe(0);
    // wire-compact stamp: no checklist bloat on the trade record
    expect(v.checklist).toBeUndefined();
    expect(Array.isArray(v.fails)).toBe(true);
  });

  it('a clean CONFIRM verdict stamps too (full-risk record)', () => {
    const out = recordManualTrade({
      market: 'FUTURES', symbol: 'BTC', side: 'BUY',
      entryPrice: 60000, qty: 0.01, signal: CLEAN_LONG_SIGNAL,
    });
    expect(out.ok).toBe(true);
    expect(out.trade.verify.action).toBe('CONFIRM');
    expect(out.trade.verify.finalCall).toBe('LONG');
    expect(out.trade.verify.sizeHint).toBe(1);
  });

  it('a pre-computed wire verdict passes through VERBATIM (no recompute drift)', () => {
    const wire = { agent: 'SVA-v1', action: 'CAUTION', finalCall: 'LONG', score: 55, veto: false, sizeHint: 0.5, verdict: '⚠️ CAUTION LONG', fails: ['rr'], warns: 2 };
    const out = recordManualTrade({
      market: 'CRYPTO', symbol: 'SOL', side: 'BUY',
      entryPrice: 20, qty: 3, signal: { side: 'LONG', grade: 'ACTION', confidence: 60, voters: 6, totalModels: 11 }, verify: wire,
    });
    expect(out.ok).toBe(true);
    expect(out.trade.verify).toEqual(wire);
  });

  it('no signal → no stamp (honest absence, never a fake verdict)', () => {
    const out = recordManualTrade({ market: 'INDIA', symbol: 'TCS', side: 'BUY', entryPrice: 100, qty: 1 });
    expect(out.ok).toBe(true);
    expect(out.trade.verify).toBeUndefined();
  });
});

describe('the monitor sweep — v13.1 OPT-IN reversal AUTO-CUT at LOSS_CAP', () => {
  it('autoCut ON: cap crossing CLOSES the trade at the crossing price with the AUTO-CUT reason', async () => {
    _resetRevCfg(); // the 60s cfg cache must NOT leak the previous test's config
    _disk.set('ai-agent-config.json', {
      reversalEnabled: true, reversalLossCapINR: 150, reversalProfitTargetINR: 500,
      reversalMaxLegs: 3, reversalReentryWindowMin: 45, reversalAutoCut: true,
    });
    const { trade } = recordManualTrade({
      market: 'FUTURES', symbol: 'XRP', side: 'BUY',
      entryPrice: 0.5, qty: 1000, signal: XRP_BURN_SIGNAL,
    });
    // 0.5 → 0.498: (0.498-0.5)*1000 = −2 USDT ×84 = −₹168 ≤ −₹150 cap
    _ticks.set('FUT_XRP', { price: 0.498 });
    const send = vi.fn(async () => ({ ok: true }));
    startManualTradeMonitor({ send, usdInrOf: async () => 84, getDeepSignal: vi.fn(async () => ({ ok: false })) });
    await __monitorTickForTests();
    expect(trade.status).toBe('CLOSED');
    expect(trade.closeReason).toContain('REVERSAL AUTO-CUT');
    expect(trade.exitPrice).toBe(0.498);
    expect(trade.exitPnlINR).toBeCloseTo(-168, 0);
    // the cycle record survives for the board (flip plan intact)
    expect(trade.reversal.state).toBe('LOSS_CAP');
    expect(trade.reversal.flip.side).toBe('SHORT');
    // the push fired (activation + auto-cut confirmation)
    expect(send).toHaveBeenCalled();
  });

  it('autoCut OFF (default): the cap crossing stays ADVISORY (v12.7 rule preserved)', async () => {
    _resetRevCfg();
    _disk.set('ai-agent-config.json', {
      reversalEnabled: true, reversalLossCapINR: 150, reversalProfitTargetINR: 500,
      reversalMaxLegs: 3, reversalReentryWindowMin: 45,
    });
    const { trade } = recordManualTrade({
      market: 'FUTURES', symbol: 'XRP', side: 'BUY',
      entryPrice: 0.5, qty: 1000, signal: XRP_BURN_SIGNAL,
    });
    _ticks.set('FUT_XRP', { price: 0.498 });
    startManualTradeMonitor({ send: vi.fn(async () => ({ ok: true })), usdInrOf: async () => 84, getDeepSignal: vi.fn(async () => ({ ok: false })) });
    await __monitorTickForTests();
    // stamped + pushed, but the trade STAYS OPEN (user executes)
    expect(trade.status).toBe('OPEN');
    expect(trade.reversal.state).toBe('LOSS_CAP');
    expect(trade.reversal.flip.side).toBe('SHORT');
  });
});
