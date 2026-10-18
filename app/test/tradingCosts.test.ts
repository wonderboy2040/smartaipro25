// ============================================================
// test/tradingCosts.test.ts — v11.1 GAP 3 REGRESSION SUITE
// ------------------------------------------------------------
// Locks the real-transaction-cost model against known India fee
// schedules (current published rates, Oct-2024 levels) and the
// paper-desk wiring:
//   1. estimateRoundTripCost: equity-intraday / futures / options /
//      crypto branches — per-component values checked against
//      hand-computed schedules (flat ₹20/order brokerage default).
//   2. brokerage mode (flat per order vs percent) + env overrides.
//   3. costsForPaperTrade: open / closed / partial (2 sell orders).
//   4. paperTrading: every close stores grossPnl + costs + netPnl,
//      PAPER_CLOSE events carry pnlNet, summary/history serve the
//      NET numbers, and the journal entry captures the cost pair.
//   5. weeklyReview: the "costs ate ₹X this week (Y% of gross
//      profit)" line renders from journal stats.
// Hermetic — no network, no disk (store + journal mocked).
// ============================================================
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ---- journal mocked: recordTradeClose spy + controllable getJournal
// (weeklyReview's quantHeaderBlock reads the stats shape) ----
const journalStatsState: any = { stats: null };
const recordTradeCloseSpy = vi.fn();
vi.mock('../server/intraday/journal.js', () => ({
  recordTradeClose: (...a: any[]) => recordTradeCloseSpy(...a),
  getJournal: () => journalStatsState.stats || { stats: { count: 0, wins: 0, losses: 0, netPnl: 0, avgR: null } },
  getWeekKey: () => '2026-W38',
}));

// ---- store mocked so paper tests never touch server/data/ ----
vi.mock('../server/intraday/store.js', () => ({
  loadJSON: () => ({ trades: [], nextId: 1, dayKey: '' }),
  saveJSON: vi.fn(() => true),
  DATA_DIR: '/tmp/unused',
}));

// ---- weeklyReview's import chain (same shapes as its own suite) ----
vi.mock('../server/ai/coindcxOrders.js', () => ({ loadJournal: () => ({ entries: [], positions: [] }) }));
vi.mock('../server/ai/trust.js', () => ({
  trustReport: () => ({ settled: 0, sufficient: false, note: 'insufficient' }),
  councilAgentStats: () => [],
  councilCalibrationMultipliers: () => ({}),
}));
vi.mock('../server/intraday/agent.js', () => ({ askLLM: async () => null }));
vi.mock('../server/ai/secrets.js', () => ({
  telegramConfig: () => null,
  sendTelegramMessage: async () => ({ ok: false }),
}));

import {
  estimateRoundTripCost, costsForPaperTrade, instrumentTypeOfTrade,
  netPnlOfTrade, tradingCostsConfig,
} from '../server/ai/tradingCosts.js';
import {
  openPaperTrade, evaluatePaper, getPaperSummary, getPaperHistory, _resetForTests,
} from '../server/intraday/paperTrading.js';
import { quantHeaderBlock } from '../server/ai/weeklyReview.js';

beforeEach(() => {
  _resetForTests();
  recordTradeCloseSpy.mockClear();
  journalStatsState.stats = null;
  // deterministic default rates (tests may override per-case)
  delete process.env.AI_TC_BROKERAGE_MODE;
  delete process.env.AI_TC_BROKERAGE_FLAT;
  delete process.env.AI_TC_BROKERAGE_PCT;
  delete process.env.AI_TC_CRYPTO_FEE_PCT;
  delete process.env.AI_TC_STT_EQUITY_INTRADAY;
});
afterEach(() => {
  delete process.env.AI_TC_BROKERAGE_MODE;
  delete process.env.AI_TC_BROKERAGE_FLAT;
  delete process.env.AI_TC_BROKERAGE_PCT;
  delete process.env.AI_TC_CRYPTO_FEE_PCT;
  delete process.env.AI_TC_STT_EQUITY_INTRADAY;
});

// ============================================================
// 1. known fee-schedule values
// ============================================================
describe('estimateRoundTripCost — known schedules', () => {
  it('EQUITY INTRADAY: 100 shares ₹1000→₹1010 (flat ₹20/order, 2 orders)', () => {
    const c = estimateRoundTripCost({ qty: 100, entryPrice: 1000, exitPrice: 1010, instrumentType: 'equity-intraday' })!;
    expect(c).toBeTruthy();
    expect(c.buyTurnover).toBe(100000);
    expect(c.sellTurnover).toBe(101000);
    expect(c.orders).toBe(2);
    expect(c.brokerage).toBe(40);                                    // 2 × ₹20
    expect(c.stt).toBe(25.25);                                       // 0.025% × sell 101000
    expect(c.exchangeTxn).toBe(5.97);                                // 0.00297% × (buy+sell)
    expect(c.sebi).toBe(0.2);                                        // 0.0001% × (buy+sell)
    expect(c.gst).toBe(8.31);                                        // 18% × (brokerage+txn+sebi)
    expect(c.stampDuty).toBe(3);                                     // 0.003% × buy
    expect(c.total).toBe(82.73);
  });

  it('EQUITY FUTURES branch: STT 0.02% sell, txn 0.00173%, stamp 0.002% buy', () => {
    const c = estimateRoundTripCost({ qty: 50, entryPrice: 50000, exitPrice: 50500, instrumentType: 'equity-futures' })!;
    expect(c.brokerage).toBe(40);
    expect(c.stt).toBe(505);                                         // 0.02% × 2525000
    expect(c.exchangeTxn).toBe(86.93);                               // 0.00173% × 5025000
    expect(c.stampDuty).toBe(50);                                    // 0.002% × 2500000
    expect(c.total).toBe(710.71);
  });

  it('OPTIONS branch: premium turnover basis (1 lot × 75, ₹86.5→₹110)', () => {
    const c = estimateRoundTripCost({ qty: 1, entryPrice: 86.5, exitPrice: 110, instrumentType: 'options', mult: 75 })!;
    expect(c.buyTurnover).toBe(6487.5);
    expect(c.sellTurnover).toBe(8250);
    expect(c.brokerage).toBe(40);
    expect(c.stt).toBe(8.25);                                        // 0.1% × sell premium
    expect(c.exchangeTxn).toBe(5.16);                                // 0.03503% × premium turnover
    expect(c.stampDuty).toBe(0.19);                                  // 0.003% × buy premium
    expect(c.total).toBe(61.75);
  });

  it('CRYPTO branch: approximate taker fee per side, no STT/GST', () => {
    const c = estimateRoundTripCost({ qty: 0.1, entryPrice: 5000000, exitPrice: 5050000, instrumentType: 'crypto' })!;
    expect(c.takerFee).toBe(502.5);                                  // 0.05% × (500000+505000)
    expect(c.stt).toBe(0);
    expect(c.gst).toBe(0);
    expect(c.total).toBe(502.5);
    expect(String(c.note)).toContain('taker');
  });

  it('rejects unusable inputs honestly (null, never a made-up fee)', () => {
    expect(estimateRoundTripCost({ qty: 0, entryPrice: 100, exitPrice: 101, instrumentType: 'equity-intraday' })).toBeNull();
    expect(estimateRoundTripCost({ qty: 10, entryPrice: 0, exitPrice: 101, instrumentType: 'equity-intraday' })).toBeNull();
    expect(estimateRoundTripCost({ qty: 10, entryPrice: 100, exitPrice: 101, instrumentType: 'wheat' })).toBeNull();
  });
});

// ============================================================
// 2. brokerage mode + env overrides
// ============================================================
describe('tradingCosts — brokerage modes and env overrides', () => {
  it('percent brokerage mode charges turnover × pct (order count irrelevant)', () => {
    process.env.AI_TC_BROKERAGE_MODE = 'percent';
    process.env.AI_TC_BROKERAGE_PCT = '0.03';
    const c = estimateRoundTripCost({ qty: 100, entryPrice: 1000, exitPrice: 1010, instrumentType: 'equity-intraday' })!;
    expect(c.brokerage).toBeCloseTo(60.3, 2); // 201000 × 0.03%
  });

  it('AI_TC_BROKERAGE_FLAT and AI_TC_STT_EQUITY_INTRADAY overrides land', () => {
    process.env.AI_TC_BROKERAGE_FLAT = '10';
    process.env.AI_TC_STT_EQUITY_INTRADAY = '0.05';
    const c = estimateRoundTripCost({ qty: 100, entryPrice: 1000, exitPrice: 1010, instrumentType: 'equity-intraday' })!;
    expect(c.brokerage).toBe(20);   // 2 × ₹10
    expect(c.stt).toBe(50.5);       // 0.05% × 101000
    expect(tradingCostsConfig().rates['equity-intraday'].sttSellPct).toBe(0.05);
  });
});

// ============================================================
// 3. costsForPaperTrade — open / closed / partial
// ============================================================
describe('costsForPaperTrade — trade-shape derivation', () => {
  it('CLOSED trade with 2 parts = 3 executed orders (1 buy + 2 sells)', () => {
    const t = {
      symbol: 'XYZ', market: 'INDIA', direction: 'LONG',
      entry: 1000, qty: 100, lastPrice: 1015,
      parts: [
        { qty: 50, exitPrice: 1010, ts: 1, reason: 'T1_BOOK' },
        { qty: 50, exitPrice: 1020, ts: 2, reason: 'T2_HIT' },
      ],
    };
    const c = costsForPaperTrade(t as any)!;
    expect(c.orders).toBe(3);
    expect(c.brokerage).toBe(60);                                   // 3 × ₹20
    expect(c.stt).toBeCloseTo(25.38, 1);                            // 0.025% × 101500
    expect(c.sellTurnover).toBe(101500);
  });

  it('OPEN trade (no parts) = entry-side costs only, honestly labelled', () => {
    const c = costsForPaperTrade({ symbol: 'XYZ', market: 'INDIA', entry: 1000, qty: 100, lastPrice: 1005, parts: [] } as any)!;
    expect(c.orders).toBe(1);
    expect(c.brokerage).toBe(20);
    expect(c.stt).toBe(0);
    expect(c.stampDuty).toBe(3);
    expect(String(c.note)).toContain('entry-side costs so far');
  });

  it('instrument branch from trade shape: option lots / crypto / equity', () => {
    expect(instrumentTypeOfTrade({ assetKind: 'OPTION' })).toBe('options');
    expect(instrumentTypeOfTrade({ market: 'CRYPTO' })).toBe('crypto');
    expect(instrumentTypeOfTrade({ market: 'INDIA' })).toBe('equity-intraday');
    expect(instrumentTypeOfTrade(null)).toBeNull();
  });

  it('netPnlOfTrade = gross − costs (both exposed)', () => {
    const n = netPnlOfTrade({
      symbol: 'XYZ', market: 'INDIA', entry: 1000, qty: 100,
      realizedPnl: 1000, unrealizedPnl: 0, lastPrice: 1010,
      parts: [{ qty: 100, exitPrice: 1010, ts: 1, reason: 'T2_HIT' }],
    } as any)!;
    expect(n.grossPnl).toBe(1000);
    expect(n.costs).toBeGreaterThan(0);
    expect(n.netPnl).toBeCloseTo(1000 - n.costs, 2);
  });
});

// ============================================================
// 4. paper-desk wiring — gross AND net on every close
// ============================================================
describe('paperTrading — net-of-costs book-keeping', () => {
  it('T2 close stores grossPnl + costs + netPnl, emits pnlNet, and the journal entry captures the pair', () => {
    const open = openPaperTrade({ symbol: 'XYZ', direction: 'LONG', entry: 100, qty: 10, stopLoss: 92, target1: 108, target2: 112, market: 'INDIA' });
    expect(open.ok).toBe(true);
    const events: any[] = [];
    evaluatePaper({ XYZ: { price: 112 } }, events);
    const t = (open as any).trade;
    expect(t.status).toBe('CLOSED');
    expect(t.realizedPnl).toBe(120);                        // gross (10 × 12) — semantics unchanged
    expect(t.grossPnl).toBe(120);
    expect(t.costs).toBeGreaterThan(0);
    expect(t.netPnl).toBeCloseTo(120 - t.costs, 1);
    expect(t.costsBreakdown.instrumentType).toBe('equity-intraday');
    expect(t.costsBreakdown.brokerage).toBe(40);
    // the PAPER_CLOSE event carries the net figure
    expect(events[0].pnl).toBe(120);
    expect(events[0].pnlNet).toBeCloseTo(120 - t.costs, 1);
    // journal entry (recordTradeClose) received the cost pair
    expect(recordTradeCloseSpy).toHaveBeenCalledWith(expect.objectContaining({
      netPnl: expect.any(Number),
      costs: expect.any(Number),
      costsBreakdown: expect.objectContaining({ instrumentType: 'equity-intraday' }),
    }));
  });

  it('summary + history serve the NET numbers with gross intact', () => {
    openPaperTrade({ symbol: 'XYZ', direction: 'LONG', entry: 100, qty: 10, stopLoss: 92, target1: 108, target2: 112, market: 'INDIA' });
    evaluatePaper({ XYZ: { price: 112 } }, []);
    const s = getPaperSummary();
    expect(s.stats.dayRealizedPnl).toBe(120);
    expect(s.stats.dayCosts).toBeGreaterThan(0);
    expect(s.stats.dayNetPnl).toBeCloseTo(120 - s.stats.dayCosts, 1);
    expect(s.stats.totalNetPnl).toBeCloseTo(s.stats.totalRealizedPnl - s.stats.totalCosts, 1);
    // closed row: netPnl present (the displayed headline)
    const row = s.closedToday.find((r: any) => r.symbol === 'XYZ');
    expect(row.netPnl).toBeCloseTo(120 - s.stats.dayCosts, 1);
    expect(row.grossPnl).toBe(120);
    const h = getPaperHistory(90);
    const g = h.groups.find((x: any) => x.trades === 1);
    expect(g.costs).toBeCloseTo(s.stats.dayCosts, 1);
    expect(g.netPnl).toBeCloseTo(120 - s.stats.dayCosts, 1);
    expect(h.overall.totalCosts).toBeCloseTo(s.stats.dayCosts, 1);
    expect(h.overall.totalNetPnl).toBeCloseTo(h.overall.totalPnl - h.overall.totalCosts!, 1);
    expect(h.overall.costsPctOfGrossProfit).toBeCloseTo((s.stats.dayCosts / 120) * 100, 0);
  });

  it('option paper trades cost on the OPTIONS schedule (STT 0.1% of sell premium)', () => {
    // v21.0.6: qty=2 — 1-lot trades ab T1 pe book NAHI hote (BE-protect
    // runner — audit B2 fix); 2 lots pe T1 half-book = same 1-lot booking
    // jiske cost-math assertions (1762.5 gross / 8.25 STT) lock hain.
    const open = openPaperTrade({
      symbol: 'NIFTY24400CE', direction: 'LONG', entry: 86.5, qty: 2,
      stopLoss: 77, target1: 110, target2: 130, market: 'INDIA',
      assetKind: 'OPTION', underlying: 'NIFTY', strike: 24400, optType: 'CE',
      expiry: '2026-09-22', iv: 13, lotSize: 75, label: 'Nifty50 22Sep 24400 CE',
    });
    expect(open.ok).toBe(true);
    evaluatePaper({ NIFTY24400CE: { price: 110 } }, []);
    const t = (open as any).trade;
    expect(t.realizedPnl).toBeCloseTo(1762.5, 1);           // (110−86.5) × 75
    expect(t.costsBreakdown.instrumentType).toBe('options');
    expect(t.costsBreakdown.stt).toBe(8.25);                // 0.1% × 8250 sell premium
    expect(t.netPnl).toBeCloseTo(t.realizedPnl - t.costs, 1);
  });
});

// ============================================================
// 5. weeklyReview — the cost-drag line
// ============================================================
describe('weeklyReview — "costs ate" gross-vs-net gap', () => {
  const mkAi = () => ({
    days: 7, trades: 0, wins: 0, losses: 0, winRate: null, netPnlINR: 0,
    avgPnlINR: null, best: null, worst: null, byMode: {}, topPairs: [],
    partialBookings: 0, hadActivity: false,
    direction: { byDirection: {}, byEntryHour: [] },
    byEntryMode: { immediate: { trades: 0 }, patient: { trades: 0 }, missedPullbacks: 0 },
  });

  it('renders the cost-drag line when journal stats carry the cost pair', () => {
    const header = quantHeaderBlock({
      ai: mkAi() as any,
      calibration: { sufficient: false, note: 'x' } as any,
      intraday: { count: 3, wins: 2, losses: 1, netPnl: 310, avgR: 0.9, costs: 100, netPnlAfterCosts: 210, grossWin: 500, tradesWithCosts: 3 },
      council: null,
    } as any);
    expect(header).toContain('Costs ate ₹100');
    expect(header).toContain('20% of gross profit');
    expect(header).toContain('210');
  });

  it('no cost line when no cost-carrying trades exist (honest absence)', () => {
    const header = quantHeaderBlock({
      ai: mkAi() as any,
      calibration: { sufficient: false, note: 'x' } as any,
      intraday: { count: 3, wins: 2, losses: 1, netPnl: 310, avgR: 0.9, costs: 0, tradesWithCosts: 0 },
      council: null,
    } as any);
    expect(header).not.toContain('Costs ate');
  });
});
