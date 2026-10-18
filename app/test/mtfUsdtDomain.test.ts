// ============================================================
// test/mtfUsdtDomain.test.ts — v21.17.0 USDT PRICING + PAPER UPGRADE
// ------------------------------------------------------------
// Ye suite user ke us complaint ko permanently band karta hai:
//   "MTF Signals Board me jo trading signals hai vo INR price me aa
//    rahe hai, muje USDT me price show hona hai"
//
// Coverage:
//   A) mtf.js — INR→USDT scaling helper + USDT resolver contract
//   B) paperTrading.js — FUTURES/USDT desk support (fractional qty,
//      UTC day, NO 15:10 EOD), quote-domain guard (INR quote se USDT
//      trade kabhi evaluate na ho), MFE/MAE + R tracking, upgraded
//      stats (WR/avgR/capture/exitMix/bySource/openRisk), source tag
//   C) mtfAutoLink.js — USDT sizing (₹risk ÷ fx), execMarket FUTURES,
//      audit source tagging, USDT quote coverage gate
//
// Store mocked (server/data/ kabhi touch nahi — paperHistory pattern).
// ============================================================
import { describe, it, expect, beforeEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

vi.mock('../server/intraday/store.js', () => ({
  loadJSON: () => ({ trades: [], nextId: 1, dayKey: '' }),
  saveJSON: vi.fn(() => true),
  DATA_DIR: '/tmp/unused',
}));
vi.mock('../server/intraday/journal.js', () => ({ recordTradeClose: vi.fn() }));

const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'mtf-usdt-test-'));
process.env.MTF_AUTO_DATA_DIR = TMP_DATA;

import { scaleCandlesInrToUsdt, rawTfCandlesUsdt } from '../server/ai/mtf.js';
import { buildPlanFromCandles } from '../server/ai/tradePlanner.js';
import { openPaperTrade, evaluatePaper, getPaperSummary, paperSymbolsByMarket, _resetForTests } from '../server/intraday/paperTrading.js';
import { mtfAutoTick, mtfAutoStatus, __resetMtfAutoForTests, loadMtfAutoConfig } from '../server/ai/mtfAutoLink.js';
import { usdInrRecord, __resetUsdInrStoreForTests } from '../server/ai/lib/usdinr.js';
import { instrumentTypeOfTrade, costsForPaperTrade } from '../server/ai/tradingCosts.js';

// ------------------------------------------------------------
// A) INR → USDT candle scaling (pure)
// ------------------------------------------------------------
describe('mtf.js — INR→USDT domain scaling', () => {
  const candles = [
    { time: 1, open: 8500, high: 8800, low: 8400, close: 8700, volume: 12 },
    { time: 2, open: 8700, high: 9000, low: 8600, close: 8900, volume: 9 },
  ];

  it('scales OHLC by /fx and keeps volume + time intact', () => {
    const out = scaleCandlesInrToUsdt(candles, 85);
    expect(out).toHaveLength(2);
    expect(out[0].open).toBeCloseTo(100, 6);
    expect(out[0].high).toBeCloseTo(103.5294117, 5);
    expect(out[0].close).toBeCloseTo(102.3529411, 5);
    expect(out[0].volume).toBe(12);
    expect(out[0].time).toBe(1);
  });

  it('rejects a non-sane fx (never fabricates a price domain)', () => {
    expect(scaleCandlesInrToUsdt(candles, 0)).toBeNull();
    expect(scaleCandlesInrToUsdt(candles, 5000)).toBeNull();
    expect(scaleCandlesInrToUsdt(null, 85)).toBeNull();
  });

  it('rawTfCandlesUsdt rejects garbage symbols without any network call', async () => {
    expect(await rawTfCandlesUsdt('', '15m')).toBeNull();
    expect(await rawTfCandlesUsdt('!!!', '15m')).toBeNull();
  });
});

// ------------------------------------------------------------
// B) Paper engine — perp/USDT desk support + analytics upgrade
// ------------------------------------------------------------
describe('paperTrading — FUTURES (USDT) desk support', () => {
  beforeEach(() => {
    _resetForTests();
    __resetUsdInrStoreForTests();
  });

  const openFut = () => openPaperTrade({
    symbol: 'BTC', market: 'FUTURES', direction: 'LONG',
    entry: 82000, qty: 0.05, stopLoss: 81000, target1: 83000, target2: 84000,
    source: 'mtf-auto', sourceMeta: { score: 84, tier: 'STRONG', mode: 'INTRADAY', holdMin: 45 },
  });

  it('opens a fractional-qty FUTURES paper trade with audit provenance', () => {
    const r = openFut();
    expect(r.error).toBeUndefined();
    const t = r.trade;
    expect(t.market).toBe('FUTURES');
    expect(t.qty).toBe(0.05);                       // fractional (4dp) — NOT floored to 0
    expect(t.source).toBe('mtf-auto');
    expect(t.sourceMeta.score).toBe(84);
    expect(t.dayKey).toMatch(/^\d{4}-\d{2}-\d{2}$/); // UTC day for perps
  });

  it('futures rows never get the 15:10 IST EOD square-off', () => {
    openFut();
    // 15:30 IST = well past the NSE square-off; crypto-style desks stay open
    const ev = { events: [] };
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-10T10:05:00.000Z')); // 15:35 IST
    try {
      evaluatePaper({ 'FUTURES|BTC': { price: 82100, src: 'coindcx-fut-usdt' } }, ev.events);
      const open = getPaperSummary().open;
      expect(open).toHaveLength(1);
      expect(open[0].status).toBe('OPEN');
    } finally {
      vi.useRealTimers();
    }
  });

  it('QUOTE DOMAIN GUARD: an INR (coindcx-inr) quote never moves a FUTURES trade', () => {
    const { trade } = openFut();
    // plain key carries the CRYPTO-desk INR price (~₹72,00,000) — 85× the entry
    const ev = { events: [] };
    evaluatePaper({ BTC: { price: 7200000, src: 'coindcx-inr' } }, ev.events);
    const row = getPaperSummary().open.find(t => t.id === trade.id);
    expect(row?.status).toBe('OPEN');                 // no false fill
    expect(row?.lastPrice).toBe(82000);               // untouched
  });

  it('the qualified USDT key DOES move it (T1 50% book path)', () => {
    const { trade } = openFut();
    const ev = { events: [] };
    evaluatePaper({ 'FUTURES|BTC': { price: 83050, src: 'coindcx-fut-usdt' } }, ev.events);
    const row = getPaperSummary().open.find(t => t.id === trade.id);
    expect(row?.status).toBe('PARTIAL');              // T1 hit → 50% booked
    expect(row?.remainingQty).toBeCloseTo(0.025, 6);
    expect(row?.mfeR).toBeGreaterThanOrEqual(1);      // excursion tracking live
  });

  it('MFE/MAE + R tracking: peak and worst excursions recorded in R', () => {
    const { trade } = openFut();
    // risk per unit = 1000 → 1R
    evaluatePaper({ 'FUTURES|BTC': { price: 82300, src: 'coindcx-fut-usdt' } }, []);  // +0.3R
    evaluatePaper({ 'FUTURES|BTC': { price: 81500, src: 'coindcx-fut-usdt' } }, []);  // −0.5R
    const row = getPaperSummary().open.find(t => t.id === trade.id);
    expect(row?.mfeR).toBeCloseTo(0.3, 2);
    expect(row?.maeR).toBeCloseTo(-0.5, 2);
  });

  it('watcher routing buckets futures/global paper rows separately', () => {
    openFut();
    openPaperTrade({ symbol: 'SBIN', direction: 'LONG', entry: 800, qty: 10, stopLoss: 780, target1: 820, target2: 850 });
    const by = paperSymbolsByMarket();
    expect(by.futures).toContain('BTC');
    expect(by.india).toContain('SBIN');
    expect(by.crypto).toEqual([]);
  });

  it('UPGRADED STATS: WR / avgR / excursion / exitMix / source split / openRisk', () => {
    const { trade } = openFut();
    // close it at T2 via the qualified quote
    evaluatePaper({ 'FUTURES|BTC': { price: 84100, src: 'coindcx-fut-usdt' } }, []);
    const s = getPaperSummary().stats;
    expect(s.closedTotal).toBe(1);
    expect(s.winRatePct).toBe(100);
    expect(s.avgR).not.toBeNull();
    expect(Number.isFinite(s.avgMfeR)).toBe(true);
    expect(Object.keys(s.exitMix || {}).length).toBeGreaterThan(0);
    expect(s.bySource['mtf-auto'].n).toBe(1);
    expect(s.bySource['mtf-auto'].wins).toBe(1);
    expect(trade.id).toBeTruthy();
  });

  it('openRisk reflects current SL exposure', () => {
    openFut();
    const s = getPaperSummary().stats;
    expect(s.openRisk).toBeCloseTo(0.05 * 1000, 2);
  });
  it('DEEP RECHECK [C1]: evaluatePaper reads byMarket (3rd arg) when plain quotes[sym] is INR', () => {
    const { trade } = openFut();
    const events: unknown[] = [];
    // Plain quotes.BTC has CoinDCX INR (₹86L); byMarket['FUTURES|BTC'] has the USDT perp quote ($83,050)
    evaluatePaper(
      { BTC: { price: 8600000, src: 'coindcx-inr' } },
      events,
      { 'FUTURES|BTC': { price: 83050, src: 'coindcx-fut-usdt' } },
    );
    const row = getPaperSummary().open.find(t => t.id === trade.id);
    expect(row?.status).toBe('PARTIAL');
    expect(row?.lastPrice).toBe(83050);
  });

  it('DEEP RECHECK [C2]: tradingCosts classifies FUTURES/GLOBALFUTURES as crypto taker-fee (never ₹20 equity brokerage)', () => {
    expect(instrumentTypeOfTrade({ market: 'FUTURES', symbol: 'BTC' })).toBe('crypto');
    expect(instrumentTypeOfTrade({ market: 'GLOBALFUTURES', symbol: 'AAPL' })).toBe('crypto');
    const c = costsForPaperTrade({ market: 'FUTURES', symbol: 'BTC', qty: 0.01, entry: 82000, parts: [{ qty: 0.01, exitPrice: 83000 }] });
    expect(c?.instrumentType).toBe('crypto');
    // turnover = 820 + 830 = 1650 USDT; at 0.05% taker fee = 0.83 USDT (NOT ₹40 flat brokerage!)
    expect(c?.total).toBeCloseTo(0.83, 2);
  });
  it('DEEP RECHECK [C3]: openPaperTrade + evaluatePaper preserve 4dp ladders on >=1 USDT coins (DOT $1.09 class — never collapse SL/T1 onto entry)', () => {
    const r = openPaperTrade({
      symbol: 'DOT', market: 'FUTURES', direction: 'SHORT',
      entry: 1.09, qty: 100, stopLoss: 1.0949, target1: 1.0851, target2: 1.0802,
    });
    expect(r.error).toBeUndefined();
    expect(r.trade.entry).toBe(1.09);
    expect(r.trade.stopLoss).toBe(1.0949); // NOT collapsed to 1.09!
    expect(r.trade.target1).toBe(1.0851);  // NOT collapsed to 1.09!
    expect(r.trade.target2).toBe(1.0802);
    // Tick at entry (1.09) must NOT false-trigger SL_HIT
    evaluatePaper({ 'FUTURES|DOT': { price: 1.09, src: 'coindcx-fut-usdt' } }, []);
    expect(getPaperSummary().open.find(t => t.id === r.trade.id)?.status).toBe('OPEN');
    // Tick at 1.0850 (4dp) must preserve 4dp and hit T1 (PARTIAL)
    evaluatePaper({ 'FUTURES|DOT': { price: 1.0850, src: 'coindcx-fut-usdt' } }, []);
    const afterT1 = getPaperSummary().open.find(t => t.id === r.trade.id);
    expect(afterT1?.status).toBe('PARTIAL');
    expect(afterT1?.lastPrice).toBe(1.085);
  });

  it('DEEP RECHECK [C4]: buildPlanFromCandles guards against cross-currency ltp (INR ltp into USDT candles) + uses crypto cost model for FUTURES + keeps sub-$1 ltp precision', () => {
    const mkBars = (base: number, n = 65) => Array.from({ length: n }, (_, i) => ({
      time: 1700000000 + i * 300,
      open: base * (1 + i * 0.0005),
      high: base * (1 + i * 0.0005 + 0.002),
      low: base * (1 + i * 0.0005 - 0.0015),
      close: base * (1 + (i + 1) * 0.0005),
      volume: 1000 + i * 20,
    }));
    // Pass an INR ltp (7,200,000) into USDT candles (~82,000) on FUTURES
    const plan = buildPlanFromCandles({
      symbol: 'BTC', market: 'FUTURES', mode: 'INTRADAY', holdMin: 45, side: 'LONG',
      ltp: 7200000, // mismatched INR ltp — must be rejected by ratio guard!
      ctxCandles: mkBars(82000, 65),
      trigCandles: mkBars(82000, 65),
    });
    expect(plan.ok).toBe(true);
    expect(plan.quoteCcy).toBe('USDT');
    expect(plan.ltp).toBeLessThan(100000); // used candle close (~83,845), NOT 7,200,000!
    expect(plan.plan.stopLoss).toBeGreaterThan(70000);
    expect(plan.costs.model).toMatch(/crypto|taker/i);

    // Sub-$1 coin (DOGE ~0.0848) preserves 4dp on plan.ltp
    const doge = buildPlanFromCandles({
      symbol: 'DOGE', market: 'CRYPTO', mode: 'INTRADAY', holdMin: 45, side: 'LONG',
      ctxCandles: mkBars(0.0830, 65),
      trigCandles: mkBars(0.0830, 65),
    });
    expect(doge.ok).toBe(true);
    expect(String(doge.ltp).split('.')[1]?.length).toBeGreaterThanOrEqual(3);
  });
});

// ------------------------------------------------------------
// C) Auto-link — USDT sizing + coverage gate + provenance
// ------------------------------------------------------------
describe('mtfAutoLink — USDT sizing for crypto rows', () => {
  beforeEach(() => {
    __resetMtfAutoForTests();
  });

  function fakePaper() {
    const calls = [];
    const open = [];
    return {
      calls, open,
      paper: {
        openPaperTrade: vi.fn((input) => {
          calls.push(input);
          const trade = { id: 500 + calls.length, ...input };
          open.push({ id: trade.id, symbol: input.symbol, market: input.market, status: 'OPEN' });
          return { ok: true, trade };
        }),
        closePaperTrade: vi.fn(() => ({ ok: true, trade: { realizedPnl: 0 } })),
        getPaperSummary: vi.fn(() => ({ open })),
      },
    };
  }

  const board = () => ({
    ok: true, market: 'CRYPTO', mode: 'INTRADAY', holdMin: 45, minScore: 75,
    rows: [{
      ok: true, symbol: 'BTCUSDT', market: 'CRYPTO', mode: 'INTRADAY', label: '15m → 5m', holdMin: 45,
      superScore: 84, tier: 'STRONG', side: 'LONG', dir: 1, grade: 'A', triggerFired: true,
      dualAligned: true, counterTrend: false, tfFit: 'GOOD', autoEligible: true, autoBlockers: [],
      plan: { entry: 82000, stopLoss: 81000, t1: 83000, t2: 84000 }, drivers: [],
    }],
  });

  it('qty = (₹risk ÷ fx) ÷ |entry−SL|, executed on the FUTURES (USDT) desk, audited', async () => {
    __resetMtfAutoForTests({ config: { enabled: true, riskPerTradeINR: 2000, maxNotionalPerTradeINR: 500000, maxPositionsINR: 300000, desks: { india: false, crypto: true } } });
    const { paper, calls } = fakePaper();
    const out = await mtfAutoTick({ boards: { CRYPTO: board() }, paper, fx: 83.3, usdtQuotes: { BTC: 82000 } });
    expect(out.opened).toHaveLength(1);
    const o = calls[0];
    expect(o.market).toBe('FUTURES');                 // USDT-perp paper domain
    expect(o.symbol).toBe('BTC');
    expect(o.source).toBe('mtf-auto');
    expect(o.sourceMeta.score).toBe(84);
    // risk ₹2000 at 83.3 → 24.0096 USDT ÷ 1000 SL distance = 0.024 qty
    expect(o.qty).toBeCloseTo(2000 / 83.3 / 1000, 4);
    const rec = mtfAutoStatus().book[0];
    expect(rec.ccy).toBe('USDT');
    expect(rec.riskUsdt).toBeCloseTo(o.qty * 1000, 3);
    expect(rec.fxUsed).toBe(83.3);
  });

  it('USDT quote coverage gate: no live perp quote → no entry (never a zombie)', async () => {
    __resetMtfAutoForTests({ config: { enabled: true, desks: { india: false, crypto: true } } });
    const { paper, calls } = fakePaper();
    const out = await mtfAutoTick({ boards: { CRYPTO: board() }, paper, fx: 83.3, usdtQuotes: { ETH: 2400 } });
    expect(out.opened).toHaveLength(0);
    expect(out.skipped.join(' ')).toMatch(/no live USDT perp quote/i);
    expect(calls).toHaveLength(0);
  });

  it('notional budget is enforced in ₹ terms (cap/qty shrink accordingly)', async () => {
    __resetMtfAutoForTests({ config: { enabled: true, riskPerTradeINR: 2000, maxNotionalPerTradeINR: 5000, maxPositionsINR: 100000, desks: { india: false, crypto: true } } });
    const { paper, calls } = fakePaper();
    await mtfAutoTick({ boards: { CRYPTO: board() }, paper, fx: 83.3, usdtQuotes: { BTC: 82000 } });
    const o = calls[0];
    expect(o.qty * o.entry * 83.3).toBeLessThanOrEqual(5000 + 1e-6);
  });

  it('config exposes the fx knob (clamped) for the UI', () => {
    const cfg = loadMtfAutoConfig();
    expect(cfg.inrPerUsdt).toBeGreaterThanOrEqual(40);
    expect(cfg.inrPerUsdt).toBeLessThanOrEqual(150);
    expect(mtfAutoStatus().ccyMode).toMatch(/USDT/);
  });

  it('usdInr helper sanity: recorded rate drives the fallback', () => {
    __resetUsdInrStoreForTests();
    expect(usdInrRecord(86.5, 'test')).toBe(86.5);
    expect(usdInrRecord(5, 'test')).toBe(86.5);       // out-of-band rejected
  });
  it('DEEP RECHECK [C5]: mtfAutoTick immediately reconciles linked trades closed early by SL/T2 (before holdMin expires)', async () => {
    __resetMtfAutoForTests({ config: { enabled: true, riskPerTradeINR: 2000, maxNotionalPerTradeINR: 500000, maxPositionsINR: 300000, desks: { india: false, crypto: true } } });
    const fp = fakePaper();
    const t0 = 1_700_000_000_000;
    await mtfAutoTick({ boards: { CRYPTO: board() }, paper: fp.paper, fx: 84, usdtQuotes: { BTC: 82000 }, now: t0 });
    expect(mtfAutoStatus().openCount).toBe(1);
    expect(mtfAutoStatus().openNotionalINR).toBeGreaterThan(0);

    // 5 minutes later (well before holdMin=45m), the paper engine closed the trade at T2_HIT
    const closedTrade = { ...fp.open[0], status: 'CLOSED', closeReason: 'T2_HIT', closedAt: t0 + 5 * 60_000, realizedPnl: 47.62 };
    fp.open.length = 0;
    fp.paper.getPaperSummary = vi.fn(() => ({ open: [], closedToday: [closedTrade] }));

    await mtfAutoTick({ boards: { CRYPTO: { ok: true, rows: [] } }, paper: fp.paper, fx: 84, now: t0 + 5 * 60_000 });
    const st = mtfAutoStatus();
    expect(st.openCount).toBe(0);
    expect(st.openNotionalINR).toBe(0);
    expect(st.book[0].status).toBe('CLOSED');
    expect(st.book[0].closeReason).toBe('T2_HIT');
    expect(st.book[0].pnl).toBe(47.62);
  });
});
