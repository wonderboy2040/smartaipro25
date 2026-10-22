// ============================================================
// test/mtfAutoLink.test.ts — v21.16.0 MTF AUTO-LINK (paper/auto)
// ------------------------------------------------------------
// Hermetic suite: paper engine INJECT ki jati hai (koi real file/broker
// IO nahi) — ye exactly wahi `mtfAutoTick` contract verify karta hai
// jo production loop (server/ai/routes.js, 60s) chalata hai.
//
// Guards the USER SPEC + safety rails:
//   • 75+ full-confirm rows → openPaperTrade call (risk-based qty)
//   • budget / quota / cooldown / max-open / kill-switch / market-gate
//     sab hard caps enforce hote hain
//   • TIME-STOP: plan window ke baad closePaperTrade call
//   • PAPER ONLY — module me koi live-exec import nahi hai
// ============================================================
import { describe, it, expect, beforeEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// v21.16.0: suite kabhi REAL server/data/ na chhue — apna tmp dir.
const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'mtf-auto-test-'));
process.env.MTF_AUTO_DATA_DIR = TMP_DATA;
import {
  mtfAutoTick, mtfAutoStatus, loadMtfAutoConfig, updateMtfAutoConfig,
  setMtfAutoEnabled, normalizeLinkSymbol, recordPaperMtfBoardTrade,
  __resetMtfAutoForTests, MTF_AUTO_DEFAULTS,
} from '../server/ai/mtfAutoLink.js';

/** Injected paper engine fake — records every call. */
function fakePaper(over = {}) {
  const calls = { opened: [], closed: [] };
  const paper = {
    open: [],
    openPaperTrade: vi.fn((input) => {
      calls.opened.push(input);
      const trade = { id: 900 + calls.opened.length, ...input };
      paper.open.push({ id: trade.id, symbol: input.symbol, market: input.market, status: 'OPEN', direction: input.direction, openedAt: Date.now() });
      return { ok: true, trade };
    }),
    closePaperTrade: vi.fn((id) => {
      calls.closed.push(id);
      paper.open = paper.open.filter(t => t.id !== id);
      return { ok: true, trade: { id, realizedPnl: 123.45 } };
    }),
    getPaperSummary: vi.fn(() => ({ open: paper.open })),
  };
  Object.assign(paper, over);
  return { paper, calls };
}

/** A dual-board with one eligible CRYPTO row (fresh, aligned, fired). */
function boardFixture(symbol = 'BTCUSDT', over = {}) {
  return {
    ok: true, market: 'CRYPTO', mode: 'INTRADAY', holdMin: 45, minScore: 75,
    rows: [{
      ok: true, symbol, market: 'CRYPTO', mode: 'INTRADAY', label: '15m → 5m', holdMin: 45,
      superScore: 82, tier: 'STRONG', side: 'LONG', dir: 1, grade: 'A',
      triggerFired: true, dualAligned: true, counterTrend: false, tfFit: 'OK',
      autoEligible: true, autoBlockers: [],
      plan: { entry: 100, stopLoss: 99, t1: 101, t2: 102 },
      drivers: ['dual-TF confirm: context+trigger aligned (+4)'],
      ...over,
    }],
  };
}

describe('mtfAutoLink — config + status', () => {
  beforeEach(() => { __resetMtfAutoForTests(); });

  it('defaults: OFF, paper-only, minScore 75, sensible caps', () => {
    const cfg = loadMtfAutoConfig();
    expect(cfg.enabled).toBe(false);
    expect(cfg.minScore).toBe(75);
    expect(cfg.riskPerTradeINR).toBe(MTF_AUTO_DEFAULTS.riskPerTradeINR);
    const st = mtfAutoStatus();
    expect(st.paperOnly).toBe(true);
    expect(st.note).toMatch(/PAPER/i);
  });

  it('v21.23.14: GLOBALFUTURES sim book row stays GLOBALFUTURES/USDC', () => {
    const rec = recordPaperMtfBoardTrade({
      symbol: 'NVDA', market: 'GLOBALFUTURES', side: 'LONG',
      entry: 100, stopLoss: 98, t1: 103, t2: 106, qty: 2,
    });
    expect(rec?.market).toBe('GLOBALFUTURES');
    expect(rec?.execMarket).toBe('GLOBALFUTURES');
    expect(rec?.ccy).toBe('USDC');
    expect(rec?.fxUsed).toBeNull();
  });

  it('clamps a hostile config (score floor 65, risk 100..25000)', () => {
    const cfg = updateMtfAutoConfig({ minScore: 5, riskPerTradeINR: 10_000_000, maxTradesPerDay: 999, mode: 'HACK' });
    expect(cfg.minScore).toBeGreaterThanOrEqual(65);
    expect(cfg.riskPerTradeINR).toBeLessThanOrEqual(25000);
    expect(cfg.maxTradesPerDay).toBeLessThanOrEqual(25);
    expect(cfg.mode).toBe('INTRADAY');
  });

  it('normalizeLinkSymbol strips venue namespaces + quote suffixes', () => {
    expect(normalizeLinkSymbol('FUT_BTC', 'CRYPTO')).toBe('BTC');
    expect(normalizeLinkSymbol('BTCUSDT', 'CRYPTO')).toBe('BTC');
    expect(normalizeLinkSymbol('SOL-USDT', 'CRYPTO')).toBe('SOL');
    expect(normalizeLinkSymbol('RELIANCE', 'INDIA')).toBe('RELIANCE');
    expect(normalizeLinkSymbol('tcs', 'INDIA')).toBe('TCS');
  });
});

describe('mtfAutoLink — tick gates', () => {
  beforeEach(() => { __resetMtfAutoForTests(); });

  it('OFF by default: tick is a no-op', async () => {
    const { paper, calls } = fakePaper();
    const out = await mtfAutoTick({ boards: { CRYPTO: boardFixture() }, paper });
    expect(out.opened).toEqual([]);
    expect(out.skipped).toContain('auto-link OFF');
    expect(calls.opened).toEqual([]);
  });

  it('kill-switch blocks everything', async () => {
    __resetMtfAutoForTests({ config: { enabled: true } });
    const { paper, calls } = fakePaper();
    const out = await mtfAutoTick({ boards: { CRYPTO: boardFixture() }, paper, killSwitch: true });
    expect(out.skipped.join(' ')).toMatch(/kill-switch/i);
    expect(calls.opened).toEqual([]);
  });

  it('opening is PAPER openPaperTrade with risk-based qty', async () => {
    __resetMtfAutoForTests({ config: { enabled: true, riskPerTradeINR: 2000, desks: { india: false, crypto: true } } });
    const { paper, calls } = fakePaper();
    const out = await mtfAutoTick({ boards: { CRYPTO: boardFixture() }, paper, now: Date.now() });
    expect(out.opened).toHaveLength(1);
    expect(calls.opened).toHaveLength(1);
    const o = calls.opened[0];
    expect(o.symbol).toBe('BTC');           // FUT_/quote-suffix normalized
    expect(o.direction).toBe('LONG');
    expect(o.market).toBe('FUTURES');   // v21.17.0: USDT-perp paper domain
    expect(o.stopLoss).toBe(99);
    expect(o.target1).toBe(101);
    expect(o.target2).toBe(102);
    // v21.17.0: crypto rows USDT domain me execute hote hain (FUTURES desk)
    // — risk ₹2000 / fx84 = 23.81 USDT ÷ SL-distance 1 = 23.81 raw qty, phir
    // ₹50k per-trade notional cap (USDT me) se clamp. Dono caps INR terms
    // me verify hote hain (fx 84 = cfg default jab caller fx na de).
    const FX = 84;
    expect(o.market).toBe('FUTURES');
    expect(o.qty * Math.abs(o.entry - o.stopLoss) * FX).toBeLessThanOrEqual(2000 + 1e-6);
    expect(o.qty * o.entry * FX).toBeLessThanOrEqual(50000 + 1e-6);
    expect(o.qty).toBeGreaterThan(0);
    const st = mtfAutoStatus();
    expect(st.openCount).toBe(1);
    expect(st.dayCount).toBe(1);
    expect(st.events.some(e => e.kind === 'entry')).toBe(true);
  });

  it('daily quota blocks further entries', async () => {
    __resetMtfAutoForTests({ config: { enabled: true, maxTradesPerDay: 1, desks: { india: false, crypto: true } } });
    const { paper, calls } = fakePaper();
    await mtfAutoTick({ boards: { CRYPTO: boardFixture() }, paper });
    expect(calls.opened).toHaveLength(1);
    // second tick — quota exhausted (maxOpenPositions default 6 > 1, so quota is the gate)
    await mtfAutoTick({ boards: { CRYPTO: boardFixture('ETH') }, paper });
    expect(calls.opened).toHaveLength(1);
    const st = mtfAutoStatus();
    expect(st.dayCount).toBe(1);
  });

  it('notional budget caps qty (never oversize)', async () => {
    __resetMtfAutoForTests({ config: { enabled: true, riskPerTradeINR: 2000, maxNotionalPerTradeINR: 500, maxPositionsINR: 100000, desks: { india: false, crypto: true } } });
    const { paper, calls } = fakePaper();
    await mtfAutoTick({ boards: { CRYPTO: boardFixture() }, paper });
    expect(calls.opened).toHaveLength(1);
    const o = calls.opened[0];
    // clamp floor 1000₹ hai (CLAMPS) — USDT desk par cap = 1000/84 ≈ 11.9 USDT
    expect(o.qty * o.entry).toBeLessThanOrEqual(1000 / 84 + 1e-6);
    expect(o.qty).toBeGreaterThan(0);
  });

  it('cooldown + already-open symbols block re-entry', async () => {
    __resetMtfAutoForTests({ config: { enabled: true, cooldownMin: 30, desks: { india: false, crypto: true } } });
    const { paper, calls } = fakePaper();
    await mtfAutoTick({ boards: { CRYPTO: boardFixture() }, paper });
    expect(calls.opened).toHaveLength(1);
    const out2 = await mtfAutoTick({ boards: { CRYPTO: boardFixture() }, paper });
    expect(out2.opened).toHaveLength(0);
    expect(out2.skipped.concat(out2.candidates === 0 ? ['no-candidates'] : []).join(' ').length).toBeGreaterThan(0);
  });

  it('max open positions gate', async () => {
    __resetMtfAutoForTests({ config: { enabled: true, maxOpenPositions: 1, desks: { india: false, crypto: true } } });
    const { paper, calls } = fakePaper();
    await mtfAutoTick({ boards: { CRYPTO: boardFixture() }, paper });
    await mtfAutoTick({ boards: { CRYPTO: boardFixture('ETH') }, paper });
    expect(calls.opened).toHaveLength(1);
    const st = mtfAutoStatus();
    expect(st.openCount).toBe(1);
  });

  it('INDIA desk honours the NSE clock (no entries when closed)', async () => {
    __resetMtfAutoForTests({ config: { enabled: true, desks: { india: true, crypto: false } } });
    const { paper, calls } = fakePaper();
    const indiaBoard = { ...boardFixture('RELIANCE'), market: 'INDIA' };
    indiaBoard.rows[0].market = 'INDIA';
    const out = await mtfAutoTick({ boards: { INDIA: indiaBoard }, paper });
    if (calls.opened.length === 0) {
      expect(out.skipped.join(' ')).toMatch(/NSE closed|cutoff/);
    } else {
      // test ran inside NSE hours — entry must be a real paper open
      expect(calls.opened[0].market).toBe('INDIA');
    }
  });
});

describe('mtfAutoLink — time-stop', () => {
  beforeEach(() => { __resetMtfAutoForTests(); });

  it('closes a linked trade after its plan window (with grace)', async () => {
    const now = Date.now();
    __resetMtfAutoForTests({
      config: { enabled: true, desks: { india: false, crypto: true } },
      state: {
        dayCount: 1,
        book: [{
          paperId: 55, symbol: 'BTC', market: 'CRYPTO', side: 'LONG', score: 82, tier: 'STRONG',
          mode: 'INTRADAY', holdMin: 45, entry: 100, stopLoss: 99, t1: 101, t2: 102, qty: 1,
          riskINR: 1, notional: 100, openedAt: now - 50 * 60_000, dayKey: 'x',
          status: 'OPEN', closeReason: null, closedAt: null, pnl: null,
        }],
      },
    });
    const { paper, calls } = fakePaper();
    paper.open.push({ id: 55, symbol: 'BTC', market: 'CRYPTO', status: 'OPEN' });
    const out = await mtfAutoTick({ boards: {}, paper, quotes: { BTC: { price: 101 } } });
    expect(out.closed.map(c => c.symbol)).toContain('BTC');
    expect(calls.closed).toContain(55);
    const st = mtfAutoStatus();
    const rec = (st.book || []).find(b => b.paperId === 55);
    expect(rec?.status).toBe('CLOSED');
    expect(rec?.closeReason).toMatch(/TIME_STOP/);
    expect(st.events.some(e => e.kind === 'time-exit')).toBe(true);
  });

  it('young trades are NOT time-stopped', async () => {
    const now = Date.now();
    __resetMtfAutoForTests({
      config: { enabled: true },
      state: { book: [{ paperId: 61, symbol: 'BTC', market: 'CRYPTO', side: 'LONG', score: 80, tier: 'STRONG', holdMin: 45, entry: 100, stopLoss: 99, t1: 101, t2: 102, qty: 1, openedAt: now - 5 * 60_000, status: 'OPEN' }] },
    });
    const { paper, calls } = fakePaper();
    paper.open.push({ id: 61, symbol: 'BTC', market: 'CRYPTO', status: 'OPEN' });
    await mtfAutoTick({ boards: {}, paper });
    expect(calls.closed).toEqual([]);
  });

  it('setMtfAutoEnabled toggles persisted state', () => {
    expect(setMtfAutoEnabled(true).enabled).toBe(true);
    expect(mtfAutoStatus().enabled).toBe(true);
    expect(setMtfAutoEnabled(false).enabled).toBe(false);
  });
});
