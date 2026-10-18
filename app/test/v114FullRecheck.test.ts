// ============================================================
// test/v114FullRecheck.test.ts — v11.4 full-site recheck regression
// suite. Locks the behavioral fixes that came out of the 5-layer
// deep review (server core / AI layer / intraday / backup+telegram
// / frontend follow-ups tested elsewhere):
//   1. data.js   fetchYahooQuotes → TRUE daily change (previousClose)
//   2. engine.js crypto fractional sizing (no premature Math.floor)
//   3. trackRecord: PARTIAL dedup · BE-floor on post-T1 gap ·
//      RUNTIME reconcile (no zombie rows on long-lived processes)
//   4. time.js   NSE holiday calendar (fixed dates + env) ·
//      opening-minute pace share floor
//   5. paperTrading: summary buckets crypto trades on their OWN
//      UTC day (IST-morning window no longer dropped)
//   6. indiaAgent: SL ratchet rejects LOOSER stops
//   7. globalFutures: partial-TP gate uses partialTpEnabled + T1
//      books pct of the ORIGINAL qty
//   8. signals.js: getDeepSignal passes real deps to the deep
//      council (the swallowed ReferenceError is gone)
// Store/journal mocked — hermetic, no network.
// ============================================================
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../server/intraday/store.js', () => ({
  loadJSON: () => ({ signals: [], trades: [], nextId: 1, dayKey: '' }),
  saveJSON: vi.fn(() => true),
  DATA_DIR: '/tmp/unused',
}));
vi.mock('../server/intraday/journal.js', () => ({
  recordTradeClose: vi.fn(),
}));

const { fetchYahooQuotes } = await import('../server/ai/data.js');
const { analyzeIntradayFromScanner } = await import('../server/intraday/engine.js');
const paper = await import('../server/intraday/paperTrading.js');
const track = await import('../server/intraday/trackRecord.js');
const time = await import('../server/intraday/time.js');

// ---- indiaAgent: minimal mock surface (same as indiaAgent.test.ts) ----
vi.mock('../server/ai/eventGuard.js', () => ({
  eventGuardCheck: () => ({ action: 'allow' }),
}));
vi.mock('../server/ai/signals.js', () => ({
  getSignals: vi.fn(async () => ({ ok: true, signals: [] })),
  getDeepSignal: vi.fn(async () => null),
}));
vi.mock('../server/ai/dhan.js', () => ({
  dhanConnected: () => false,
  dhanPlaceOrder: vi.fn(async () => ({ orderId: 'test-order-1' })),
  dhanCancelOrder: vi.fn(async () => ({ ok: true })),
}));
const indiaAgent = await import('../server/ai/indiaAgent.js');
const { __setJournalForTests, loadJournal, __resetForTests, __setConfigForTests } = await import('../server/ai/coindcxOrders.js');

// ---- globalFutures: same mock surface as globalFutures.test.ts ----
vi.mock('../server/mcp/coindcx.js', () => ({
  coindcxConnected: () => false,
  coindcxPrivate: vi.fn(),
  coindcxPrivateGET: vi.fn(),
  coindcxStatus: () => ({ connected: false }),
  fetchGlobalFuturesInstruments: vi.fn(async () => []),
}));
const gf = await import('../server/ai/globalFutures.js');

const origFetch = globalThis.fetch;
beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); globalThis.fetch = origFetch; delete process.env.NSE_HOLIDAYS; });

// deterministic IST clocks
const SAT_NOON_IST = new Date('2026-08-29T06:30:00Z').getTime();   // Sat 12:00 IST
const MON_1015_IST = new Date('2026-08-31T04:45:00Z').getTime();   // Mon 10:15 IST

// ============================================================
// 1. fetchYahooQuotes — daily change, not a 5-session change
// ============================================================
describe('v11.4 · fetchYahooQuotes uses the TRUE daily change', () => {
  it('prefers meta.previousClose over chartPreviousClose (5-session) for changePct', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        chart: { result: [{ meta: {
          regularMarketPrice: 103,
          previousClose: 102,          // yesterday — the daily reference
          chartPreviousClose: 100,     // close before the 5d window
        } }] },
      }),
    }));
    vi.stubGlobal('fetch', fetchMock);
    const out = await fetchYahooQuotes(['NIFTY']);
    // daily: (103-102)/102 = +0.98% — the old code printed +3% (5-session)
    expect(out.NIFTY.price).toBe(103);
    expect(out.NIFTY.changePct).toBeCloseTo(0.98, 2);
  });

  it('falls back to chartPreviousClose only when previousClose is absent', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        chart: { result: [{ meta: { regularMarketPrice: 101, chartPreviousClose: 100 } }] },
      }),
    }));
    vi.stubGlobal('fetch', fetchMock);
    const out = await fetchYahooQuotes(['NIFTY']);
    expect(out.NIFTY.changePct).toBeCloseTo(1, 2);
  });
});

// ============================================================
// 2. crypto fractional position sizing
// ============================================================
describe('v11.4 · crypto qtyPerLakh keeps the fraction (no premature floor)', () => {
  it('BTC at ₹43.5L sizes ~0.0057 per lakh — not the 0.0001 dust minimum', () => {
    vi.setSystemTime(MON_1015_IST);
    const scale = 87;
    const tvInr = {
      close: 4350000, open: 4332600, high: 4402200, low: 4306500, volume: 12000, change: 1.5,
      ema10: 50100 * scale, ema20: 49900 * scale, sma20: 49800 * scale, sma50: 49500 * scale,
      rsi: 61, macd: 80 * scale, macdSignal: 40 * scale,
      atr: 350 * scale, vwap: 49900 * scale,
      adx: 27, adxPlus: 25, adxMinus: 10, relVolume: 1.8,
      pivotMiddle: 49900 * scale, pivotS1: 49400 * scale, pivotR1: 50400 * scale,
      recommend: 1, last: 50000 * scale, exchange: 'BINANCE',
    };
    const coindcx = { price: 4350000, prevClose: 4296296.3, change: 1.25, high: 4400000, low: 4300000, volume: 77 };
    const r = analyzeIntradayFromScanner('BTC', tvInr, coindcx, {
      market: 'CRYPTO',
      regime: { regime: 'BULLISH', vixLevel: 'LOW' },
    });
    expect(r).toBeTruthy();
    // cap leg: 25000 / 4350000 = 0.005747 → 0.0057 (4dp).
    // The old double-Math.floor collapsed this to 0.0001 (~50–90× undersize).
    expect(r.qtyPerLakh).toBeCloseTo(0.0057, 3);
    expect(r.qtyPerLakh).not.toBe(0.0001);
  });

  it('NSE whole-share sizing is unchanged (integer floor)', () => {
    vi.setSystemTime(MON_1015_IST);
    const r = analyzeIntradayFromScanner('SBIN', {
      close: 812, open: 800, high: 816, low: 795, volume: 5e6, change: 1.5,
      ema10: 810, ema20: 805, sma20: 802, sma50: 790,
      rsi: 61, macd: 2.5, macdSignal: 1.5, atr: 10, vwap: 806,
      adx: 27, adxPlus: 25, adxMinus: 10, relVolume: 1.8,
      pivotMiddle: 806, pivotS1: 800, pivotR1: 812, recommend: 1, last: 812, exchange: 'NSE',
    }, { price: 812, prevClose: 800, change: 1.5, high: 816, low: 795, volume: 5e6 }, {
      market: 'INDIA',
      regime: { regime: 'BULLISH', vixLevel: 'LOW' },
    });
    expect(r).toBeTruthy();
    expect(Number.isInteger(r.qtyPerLakh)).toBe(true);
    expect(r.qtyPerLakh).toBeGreaterThan(0);
  });
});

// ============================================================
// 3. trackRecord — PARTIAL dedup · BE floor · runtime reconcile
// ============================================================
describe('v11.4 · trackRecord PARTIAL rows', () => {
  const sig = (over = {}) => ({
    symbol: 'BTC', market: 'CRYPTO', exchange: 'BINANCE', direction: 'LONG',
    entry: 100, stopLoss: 95, target1: 110, target2: 120,
    ltp: 100, qtyPerLakh: 1, confidence: 80, quantConfidence: 80,
    ...over,
  });

  it('re-published PARTIAL rows are refreshed, never duplicated', () => {
    vi.setSystemTime(SAT_NOON_IST);
    track.__reloadTrackRecordForBoot();   // hermetic state per test (mocked store returns fresh)
    track.recordSignals([sig()]);
    // T1 → PARTIAL
    track.evaluateTracked({ BTC: { price: 111 } }, []);
    expect(track.getTrackRecord(1).openCount).toBe(1);
    // the next scan republishes the same symbol+direction:
    track.recordSignals([sig({ confidence: 85 })]);
    const rec = track.getTrackRecord(1);
    expect(rec.openCount).toBe(1);           // no second row (old code: 2)
    const row = rec.open[0];
    expect(row.status).toBe('PARTIAL');
    expect(row.confidence).toBe(85);         // confidence refresh applied
    // entry stays FROZEN (T1 was booked against the old levels)
    expect(row.entry).toBe(100);
  });

  it('a tick gapping below the ORIGINAL SL after T1 exits at the breakeven floor, not at the stop', () => {
    vi.setSystemTime(SAT_NOON_IST);
    track.__reloadTrackRecordForBoot();
    track.recordSignals([sig()]);
    track.evaluateTracked({ BTC: { price: 111 } }, []);      // T1 → PARTIAL
    const events: any[] = [];
    track.evaluateTracked({ BTC: { price: 94 } }, events);   // gaps straight through SL
    const ev = events.find(e => e.type === 'SL_HIT');
    expect(ev).toBeFalsy();                                   // old code closed at SL (full loss)
    const be = events.find(e => e.type === 'BE_TRAIL_EXIT');
    expect(be).toBeTruthy();
    // v21.13.x (B2): the BE trail fills at the TRADED price (worst-side)
    // — a tick gapping THROUGH breakeven (94 < entry 100) books the
    // runner at the honest market-order fill (paperTrading [H3] parity),
    // not a fake breakeven. Pehle exact-entry 100 fill hota tha.
    expect(be.price).toBe(94);                                // worst-side fill (tick 94 < entry 100)
    const rec = track.getTrackRecord(1);
    expect(rec.openCount).toBe(0);
  });

  it('RUNTIME reconcile closes stale-day rows during evaluateTracked (no boot-only zombies)', () => {
    vi.setSystemTime(SAT_NOON_IST);   // Sat 12:00 IST = UTC Sat 06:30
    track.__reloadTrackRecordForBoot();
    track.recordSignals([sig()]);
    expect(track.getTrackRecord(1).openCount).toBe(1);
    // cross the UTC day boundary with the process still alive:
    vi.setSystemTime(new Date('2026-08-30T00:30:00Z'));       // UTC Sunday 00:30
    const events: any[] = [];
    track.evaluateTracked({}, events);                        // no quotes needed
    const rec = track.getTrackRecord(1);
    expect(rec.openCount).toBe(0);                            // closed, not zombie
    expect(rec.history[0].status).toBe('EOD_EXIT');
    expect(events.some(e => e.type === 'EOD_EXIT')).toBe(true);
  });
});

// ============================================================
// 4. time.js — holiday calendar + opening-minute pace share
// ============================================================
describe('v11.4 · NSE holiday calendar', () => {
  it('fixed-date national holidays close the market (2026-10-02 is a Friday)', () => {
    // Fri 02-Oct-2026 11:00 IST — inside normal hours, but Gandhi Jayanti
    expect(time.isNseMarketOpen(new Date('2026-10-02T05:30:00Z'))).toBe(false);
    expect(time.isNseHoliday(new Date('2026-10-02T05:30:00Z'))).toBe(true);
    expect(time.isNseMarketOpen(new Date('2026-01-26T05:00:00Z'))).toBe(false); // Republic Day (Mon)
  });

  it('NSE_HOLIDAYS env adds movable-feast closures (and only valid dates)', () => {
    process.env.NSE_HOLIDAYS = ' 2026-11-08 , 2026-11-09 , garbage ';
    // Sun 08-Nov-2026 12:00 IST — weekend anyway; use Mon 09-Nov 11:00 IST
    expect(time.isNseMarketOpen(new Date('2026-11-09T05:30:00Z'))).toBe(false);
    expect(time.isNseHoliday(new Date('2026-11-08T06:30:00Z'))).toBe(true);
    // "garbage" must not break anything
    expect(time.isNseHoliday(new Date('2026-11-10T05:30:00Z'))).toBe(false);
  });

  it('fail-open: an ordinary weekday inside hours stays OPEN', () => {
    // Mon 31-Aug-2026 11:00 IST
    expect(time.isNseMarketOpen(new Date('2026-08-31T05:30:00Z'))).toBe(true);
  });

  it('sessionElapsedShare gives the 09:15 ORB minute the 0.12 floor, not 1', () => {
    // Mon 31-Aug-2026 09:15 IST exactly — the opening minute in progress
    // (signature: (market, date))
    const share = (time as any).sessionElapsedShare('INDIA', new Date('2026-08-31T03:45:30Z'));
    expect(share).toBeCloseTo(0.12, 3);
    // and 09:16 already earns elapsed share: (1/375)*1.3 = 0.0035 → floor 0.12
    const share2 = (time as any).sessionElapsedShare('INDIA', new Date('2026-08-31T03:46:00Z'));
    expect(share2).toBeCloseTo(0.12, 3);
    // mid-session sanity: 12:00 IST → (165/375)*1.3 = 0.572
    const share3 = (time as any).sessionElapsedShare('INDIA', new Date('2026-08-31T06:30:00Z'));
    expect(share3).toBeCloseTo(0.572, 2);
  });
});

// ============================================================
// 5. paperTrading — market-aware "today" in the summary
// ============================================================
describe('v11.4 · getPaperSummary buckets crypto trades on their UTC day', () => {
  it('a crypto trade closed 02:00 IST Sunday still counts in closedToday/dayRealizedPnl', () => {
    // Sun 06-Aug-2026 02:00 IST = Sat 20:30 UTC — the UTC day is STILL
    // Saturday, one day BEHIND the IST day. The old IST-only filter
    // dropped exactly these trades.
    vi.setSystemTime(new Date('2026-08-08T20:30:00Z'));
    (paper as any)._resetForTests?.();
    const open = paper.openPaperTrade({
      symbol: 'BTC', market: 'CRYPTO', direction: 'LONG',
      entry: 50000, qty: 0.01, stopLoss: 48000, target1: 52000, target2: 53000,
    });
    expect(open.ok).toBe(true);
    const closed = paper.closePaperTrade(open.trade.id, { BTC: { price: 51000 } });
    expect(closed.ok).toBe(true);
    const s = paper.getPaperSummary();
    expect(s.stats.openCount).toBe(0);
    expect(s.closedToday.length).toBe(1);
    expect(s.stats.dayRealizedPnl).toBeGreaterThan(0);
  });
});

// ============================================================
// 6. indiaAgent — the SL ratchet actually ratchets
// ============================================================
describe('v11.4 · adjustAgentPositionSl enforces tighten-only', () => {
  const seedPos = (sl: number) => {
    const j = loadJournal();
    const p = {
      id: 'pos-ratchet-1', pair: 'RELIANCE-INR', symbol: 'RELIANCE', market: 'INDIA',
      side: 'LONG', qty: 10, entryPrice: 100, sl, tp: 110, tp2: 115,
      status: 'OPEN', mode: 'paper', source: 'agent', openedAt: Date.now(),
      entry: { kind: 'ORDER', day: '2026-08-31', symbol: 'RELIANCE-INR', side: 'LONG', mode: 'paper', market: 'INDIA', source: 'agent' },
      events: [], exitPrice: null, closedAt: null, legs: [], parts: [],
    };
    j.positions = [p];
    __setJournalForTests(j);
    return p;
  };

  it('rejects a LOOSER stop (long: newSl < current) and keeps the broker-safe level', async () => {
    vi.setSystemTime(MON_1015_IST);
    const p = seedPos(102);                       // already trailed to 102
    const out = await indiaAgent.__adjustAgentPositionSlForTest(p.id, 98, 'conviction weakened → SL down', p);
    expect(out.ok).toBe(false);
    expect(String(out.error)).toMatch(/looser/i);
    expect(loadJournal().positions[0].sl).toBe(102);   // unchanged
  });

  it('accepts a TIGHTER stop (long: newSl > current)', async () => {
    vi.setSystemTime(MON_1015_IST);
    const p = seedPos(95);
    const out = await indiaAgent.__adjustAgentPositionSlForTest(p.id, 100, 'T1 BE-lock', p);
    expect(out.ok).toBe(true);
    expect(loadJournal().positions[0].sl).toBe(100);
  });

  it('equal SL is a no-op (no journal churn)', async () => {
    vi.setSystemTime(MON_1015_IST);
    const p = seedPos(100);
    const out = await indiaAgent.__adjustAgentPositionSlForTest(p.id, 100, 'same level', p);
    expect(out.ok).toBe(true);
    expect((out as any).unchanged).toBe(true);
    expect(loadJournal().positions[0].sl).toBe(100);
  });
});

// ============================================================
// 7. globalFutures — partial-TP gate + T1 fraction
// ============================================================
describe('v11.4 · Global desk partial-TP', () => {
  it('fires (old gate read the nonexistent pro.enabled) and books 40% of the ORIGINAL qty at T1', async () => {
    vi.setSystemTime(MON_1015_IST);
    __resetForTests();
    __setConfigForTests({ mode: 'paper', minConfidence: 75, minAgreement: 0.7, maxRiskPct: 5, dailyMaxTrades: 50, dailyMaxLossINR: 100_000, maxOrderINR: 1_000_000, maxOpenPositions: 50 });
    gf.__resetGlobalForTests();
    const out = await gf.executeGlobalSignal({
      symbol: 'NVDA', side: 'LONG', mode: 'paper',
      marginUSDT: 100, leverage: 2,
      getFreshSignal: async () => ({
        symbol: 'NVDA', market: 'GLOBALFUTURES', side: 'LONG', grade: 'STRONG',
        confidence: 84, agreement: 0.8, generatedAt: Date.now(),
        ltp: 120, plan: { entry: 120, stopLoss: 116, target1: 124, target2: 128, risk: 4, riskPct: 3.3, rewardRisk: 2, atrUsed: 3, planStyle: 'atr-based' },
        votes: [], summary: 'x', executable: true,
      }),
      source: 'agent',               // partial-TP is agent-only
    });
    if (!out.ok) throw new Error(`executeGlobalSignal failed: ${String(out.error)}`);
    expect(out.ok).toBe(true);
    const origQty = out.position.qty;           // 100×2/120 = 1.66

    // Yahoo routing: price at T1 (124)
    globalThis.fetch = vi.fn(async (url: any) => {
      const u = String(url);
      if (u.includes('query1.finance.yahoo.com')) {
        return { ok: true, status: 200, json: async () => ({ chart: { result: [{ meta: { regularMarketPrice: 124, chartPreviousClose: 120 } }] } }) };
      }
      return { ok: true, status: 200, json: async () => ({}) };
    }) as any;

    await gf.watchGlobalPositions({});
    const j = loadJournal();
    const pos = j.positions.find((x: any) => x.id === out.position.id);
    expect(pos.status).toBe('OPEN');            // runner survives
    expect(pos.tp1Hit).toBe(true);
    // 40% of ORIGINAL: 1.66 × 0.4 = 0.66 closed → 1.00 left.
    // The old formula booked 1.66/0.6×0.4 = 1.11 → only 0.55 left (at 50%
    // it closed the WHOLE position).
    expect(pos.qty).toBeCloseTo(1.0, 1);
    expect(origQty).toBeCloseTo(1.66, 1);
  });
});

// ============================================================
// 8. signals.js — the deep council receives real deps
// ============================================================
describe('v11.4 · getDeepSignal deep-council deps (swallowed ReferenceError fixed)', () => {
  it('the getDeepSignal body no longer references the out-of-scope depsSafe', async () => {
    const fs = await import('node:fs');
    const src = fs.readFileSync('server/ai/signals.js', 'utf8');
    const start = src.indexOf('export async function getDeepSignal');
    expect(start).toBeGreaterThan(-1);
    // getDeepSignal sits near the end of the file; _computeBoard (where
    // depsSafe legitimately lives) is defined EARLIER — slice to the tail.
    const tail = src.slice(start);
    expect(tail).not.toContain('depsSafe');           // the bug: ReferenceError swallowed by catch
    expect(tail).toMatch(/deps:\s*deps\s*\|\|\s*\{\}/); // the fix: real deps object
  });
});
