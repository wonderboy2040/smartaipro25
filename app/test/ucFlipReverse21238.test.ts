// ============================================================
// test/ucFlipReverse21238.test.ts — v21.23.8 UC FLIP-AND-REVERSE
// SUPER SMART INTELLIGENCE + SPOT FULL STOP + EQUITY SIM allowlist
// ------------------------------------------------------------
// USER PROBLEM (verbatim): "jab long trade lagne par thoda pullback hota hai
// koi baat thoda negative jata hai trade then phir se long trade upar jata hai
// ek ek baar wrong trade se against trade hota hai ... pullback ke baad bhi
// pura short niche chala jata hai tab UC ne Long se short pakka hone pe update
// karta hai status tab minimal loss ke sath vo long trade close karke
// immediately wahi trade short me lagna chahiye ... TP 1 and TP 2 tak full
// trade complete hoke full profit book hona chahiye" + "coindcx spot trade...
// spot ko full stop kardo sirf futures usdt & equity sim aur gold & silver me
// hi sirf itne me hi trade lagna chahiye"
//
// LOCKS:
//   S1  — deriveUcFlipReverseTicket (pure): board-plan SL valid-side + synthetic
//         1.2% fallback + T1/T2 sane spacing + sides/geometry
//   S2  — THE CORE: LOSS trade (fee NOT covered) + UC board flip PAKKA →
//         minimal-loss CLOSE (UC_FLIP_MINIMAL_LOSS_EXIT) + IMMEDIATE same-symbol
//         reverse SHORT entry (paper) + direction lock flipped
//   S3  — PROFIT flip: fee covered reversal profit-book + reverse entry
//   S4  — PULLBACK ≠ FLIP: board same-side rehne par trade SALTA hai (koi
//         close/flip nahi) — the "thoda pullback then upar jata hai" case
//   S5  — TP2 FULL COMPLETION: TP2 hit par full profit book + NO flip (trade
//         poora complete — "TP1/TP2 tak full trade complete" contract)
//   S6  — churn guards: daily flip cap (4/symbol) par reverse entry nahi +
//         LIVE age guard (< 60s flip exit blocked) + ucFlipReverse:false OFF
//   S7  — SPOT FULL STOP: executeSignal har mode reject (AI_SPOT_FULL_STOP=1) +
//         legacy 90s spot auto-executor permanently disabled (source pin)
//   S8  — EQUITY SIM allowlist: GLOBALFUTURES (USDC sim) rows ab auto-pool me —
//         paper SIM entry, ccy USDC, live order KABHI nahi
//   S9  — wiring source pins (mtfAutoLink + routes global-quote overlay)
// ============================================================
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'mtf-ucflip-21238-'));
process.env.MTF_AUTO_DATA_DIR = TMP_DATA;

import {
  mtfAutoTick, deriveUcFlipReverseTicket, __resetMtfAutoForTests,
} from '../server/ai/mtfAutoLink.js';
import { checkDirectionLock, __resetDirectionLocksForTests } from '../server/ai/directionLock.js';
import {
  executeSignal, spotTradeFullStop, __resetForTests as __resetOrdersForTests,
  __setConfigForTests as __setOrdersConfigForTests,
} from '../server/ai/coindcxOrders.js';
import { saveJSON, loadJSON as loadJSONOrig } from '../server/lib/store.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(APP_ROOT, p), 'utf8');
const LINK_SRC = read('server/ai/mtfAutoLink.js');
const ROUTES_SRC = read('server/ai/routes.js');
const ORDERS_SRC = read('server/ai/coindcxOrders.js');

const NOW = 1_765_000_000_000;
const utcDayKey = () => new Date(NOW).toLocaleDateString('sv-SE', { timeZone: 'UTC' });

// ---- fake paper engine (hermetic — real paperTrading separate suite me) ----
function fakePaper(openSeed = []) {
  const calls = { opened: [], closed: [] };
  const paper = {
    open: openSeed,
    openPaperTrade: vi.fn((input) => {
      calls.opened.push(input);
      const trade = { id: 900 + calls.opened.length, ...input, status: 'OPEN', realizedPnl: 0 };
      paper.open.push({ id: trade.id, symbol: input.symbol, market: input.market, status: 'OPEN', direction: input.direction, openedAt: NOW, t1ClosePct: input.t1ClosePct });
      return { ok: true, trade };
    }),
    closePaperTrade: vi.fn((id) => {
      calls.closed.push(id);
      const idx = paper.open.findIndex(t => t.id === id);
      if (idx >= 0) paper.open.splice(idx, 1);
      return { ok: true, trade: { id, realizedPnl: -0.4 } };
    }),
    getPaperSummary: vi.fn(() => ({ open: paper.open })),
    updatePaperTradeT1ClosePct: vi.fn(),
  };
  return { paper, calls };
}

// ---- open linked LONG BTC book record (paper mirror) ----
function openLongBtc(over = {}) {
  return {
    paperId: 777, liveOrderId: null, livePositionId: null,
    executionMode: 'PAPER', traded: true, fullControl: false, openedInLiveMode: false,
    symbol: 'BTC', market: 'CRYPTO', execMarket: 'FUTURES', ccy: 'USDT', fxUsed: 94.95,
    side: 'LONG', score: 88, tier: 'ELITE', mode: 'INTRADAY', holdMin: 45,
    entry: 100, stopLoss: 99, initialStopLoss: 99, trailedStopLoss: 99, peakPrice: 100,
    t1: 101, t2: 102, qty: 1, leverage: 10, walletINR: 10000, walletDeployPct: 100,
    deployedWalletINR: 10000, deployedWalletUSDT: 105.3, buyingPowerINR: 100000, buyingPowerUSDT: 1053,
    feeBreakevenPrice: 100.12, deepMonitorStage: 'STAGE_0_INITIAL_GUARD',
    atrPct: null, volClass: null, momentumState: null, t1ClosePct: 0.5,
    openedAt: NOW - 5 * 60_000, dayKey: utcDayKey(), status: 'OPEN',
    closeReason: null, closedAt: null, pnl: null, notional: 9495, drivers: ['x'],
    ...over,
  };
}

// ---- board payloads ----
function cryptoBoardRows(rows, over = {}) {
  return { ok: true, market: 'CRYPTO', mode: 'INTRADAY', holdMin: 45, minScore: 75, rows, ...over };
}
// UC PAKKA flipped row: side SHORT + trigger FIRED — the "UC ne status update
// kar diya" state (v21.23.6 TRUE-flip definition).
function flippedShortRow(over = {}) {
  return {
    ok: true, symbol: 'BTC', market: 'CRYPTO', mode: 'INTRADAY', label: '15m → 5m', holdMin: 45,
    superScore: 86, tier: 'ELITE', side: 'SHORT', dir: -1, grade: 'A',
    triggerFired: true, dualAligned: true, counterTrend: false, tfFit: 'OK',
    directionVerified: true, ensembleSignalAvailable: true,
    autoEligible: true, autoBlockers: [],
    plan: { entry: 100.5, stopLoss: 100.6, t1: 98.5, t2: 97.5 },
    context: { dir: -1 }, ltp: 99.6, drivers: ['x'],
    ...over,
  };
}
function sameSideLongRow(over = {}) {
  return flippedShortRow({
    side: 'LONG', dir: 1, triggerFired: true,
    plan: { entry: 100, stopLoss: 99, t1: 101, t2: 102 },
    context: { dir: 1 }, ...over,
  });
}

function tickP(paper, board, over = {}) {
  return {
    boards: { CRYPTO: board },
    paper,
    quotes: { 'FUTURES|BTC': { price: 99.6 }, BTC: { price: 99.6 } },
    usdtQuotes: new Map([['BTC', 99.6]]),
    walletEquityINR: 10000,
    fx: 94.95,
    now: NOW,
    ...over,
  };
}

// ============================================================
// S1 — deriveUcFlipReverseTicket (PURE)
// ============================================================
describe('v21.23.8 S1 — deriveUcFlipReverseTicket (pure reverse-ticket math)', () => {
  it('SHORT flip + valid board-plan SL (above price, 0.3–5% band) → board-plan ticket', () => {
    const t = deriveUcFlipReverseTicket({
      side: 'SHORT', ltp: 99.6,
      boardRow: { plan: { entry: 100.5, stopLoss: 100.6, t1: 98.5, t2: 97.5 } },
    });
    expect(t).not.toBeNull();
    expect(t.side).toBe('SHORT');
    expect(t.entry).toBe(99.6);
    expect(t.stopLoss).toBe(100.6);       // plan SL (valid side + band)
    expect(t.t1).toBe(98.5);              // plan T1 (below px for SHORT)
    expect(t.t2).toBe(97.5);
    expect(t.src).toBe('board-plan');
    expect(t.riskUnit).toBeCloseTo(1.0, 4);
  });

  it('LONG flip + NO board row → synthetic 1.2% protective geometry (SL 1.2% neeche · T1 +1.25R · T2 +2.4R)', () => {
    const t = deriveUcFlipReverseTicket({ side: 'LONG', ltp: 100, boardRow: null });
    expect(t.riskUnit).toBeCloseTo(1.2, 6);
    expect(t.stopLoss).toBeCloseTo(98.8, 6);
    expect(t.t1).toBeCloseTo(101.5, 6);
    expect(t.t2).toBeCloseTo(102.88, 5);
    expect(t.src).toBe('synthetic');
  });

  it('plan SL galat side (SHORT ke liye SL price se NEECHE) → synthetic fallback (stale plan leak nahi)', () => {
    const t = deriveUcFlipReverseTicket({
      side: 'SHORT', ltp: 100,
      boardRow: { plan: { entry: 100, stopLoss: 90, t1: 98, t2: 95 } },
    });
    expect(t.src).toBe('synthetic');
    expect(t.stopLoss).toBeGreaterThan(100); // SHORT SL upar hi hona chahiye
    expect(t.riskUnit).toBeCloseTo(1.2, 6);
  });

  it('plan SL valid side par absurd distance (10%) → synthetic (0.3–5% band bahar)', () => {
    const t = deriveUcFlipReverseTicket({
      side: 'SHORT', ltp: 100,
      boardRow: { plan: { entry: 100, stopLoss: 110, t1: 98, t2: 95 } },
    });
    expect(t.src).toBe('synthetic');
  });

  it('invalid ltp → null; invalid side → null (no silent LONG)', () => {
    expect(deriveUcFlipReverseTicket({ side: 'SHORT', ltp: 0, boardRow: null })).toBeNull();
    expect(deriveUcFlipReverseTicket({ side: 'x', ltp: 100, boardRow: null })).toBeNull();
  });

  it('T1/T2 geometry har case me valid: LONG me SL < entry < T1 < T2; SHORT me ulta', () => {
    const long = deriveUcFlipReverseTicket({ side: 'LONG', ltp: 100 });
    expect(long.stopLoss).toBeLessThan(long.entry);
    expect(long.entry).toBeLessThan(long.t1);
    expect(long.t1).toBeLessThan(long.t2);
    const short = deriveUcFlipReverseTicket({ side: 'SHORT', ltp: 100 });
    expect(short.stopLoss).toBeGreaterThan(short.entry);
    expect(short.entry).toBeGreaterThan(short.t1);
    expect(short.t1).toBeGreaterThan(short.t2);
  });
});

// ============================================================
// S2 — THE CORE: minimal-loss UC flip close + IMMEDIATE reverse entry
// ============================================================
describe('v21.23.8 S2 — LOSS trade + UC flip PAKKA → minimal-loss close + IMMEDIATE reverse SHORT', () => {
  beforeEach(() => { __resetMtfAutoForTests(); __resetDirectionLocksForTests(); });

  it('LONG @100 in loss (ltp 99.6, fee NOT covered) + board SHORT PAKKA → UC_FLIP_MINIMAL_LOSS_EXIT + same-symbol SHORT reverse entry', async () => {
    __resetMtfAutoForTests({
      config: { enabled: true, executionMode: 'paper', minScore: 75 },
      state: { book: [openLongBtc()] },
    });
    const { paper, calls } = fakePaper([{ id: 777, symbol: 'BTC', market: 'FUTURES', status: 'OPEN', direction: 'LONG', openedAt: NOW - 5 * 60_000 }]);
    const out = await mtfAutoTick(tickP(paper, cryptoBoardRows([flippedShortRow()])));

    // 1) purana LONG trade minimal-loss CLOSE
    expect(out.closed).toHaveLength(1);
    expect(out.closed[0].reason).toBe('UC_FLIP_MINIMAL_LOSS_EXIT');
    expect(paper.closePaperTrade).toHaveBeenCalledWith(777, expect.anything(), 'UC_FLIP_MINIMAL_LOSS_EXIT');
    // 2) IMMEDIATE same-symbol SHORT reverse entry (paper)
    expect(out.opened).toHaveLength(1);
    const flip = out.opened[0];
    expect(flip.symbol).toBe('BTC');
    expect(flip.side).toBe('SHORT');                    // LONG → SHORT flip
    expect(flip.flipEntry).toBe(true);
    expect(flip.flippedFrom).toBe('LONG');
    expect(flip.execMarket).toBe('FUTURES');
    expect(flip.executionMode).toBe('PAPER');
    expect(flip.stopLoss).toBeGreaterThan(flip.entry);  // SHORT geometry
    expect(flip.t1).toBeLessThan(flip.entry);
    expect(flip.t2).toBeLessThan(flip.t1);
    expect(flip.qty).toBeGreaterThan(0);
    // 3) reverse ticket current price pe anchored (ltp 99.6)
    expect(paper.openPaperTrade).toHaveBeenCalledTimes(1);
    expect(calls.opened[0].entry).toBe(99.6);
    expect(calls.opened[0].direction).toBe('SHORT');
    expect(calls.opened[0].market).toBe('FUTURES');
    expect(calls.opened[0].source).toBe('uc-flip-reverse');
    // 4) direction lock flipped: SHORT allowed, LONG blocked
    const lockShort = checkDirectionLock('BTC', 'SHORT', { now: NOW + 1000 });
    const lockLong = checkDirectionLock('BTC', 'LONG', { now: NOW + 1000 });
    expect(lockShort.allowed).toBe(true);
    expect(lockShort.lockedSide).toBe('SHORT');
    expect(lockLong.allowed).toBe(false);
  });

  it('protective exit still happens, but unverified/ensemble-missing opposite row NEVER opens a reverse entry', async () => {
    __resetMtfAutoForTests({
      config: { enabled: true, executionMode: 'paper', minScore: 75 },
      state: { book: [openLongBtc()] },
    });
    const { paper } = fakePaper([{ id: 777, symbol: 'BTC', market: 'FUTURES', status: 'OPEN', direction: 'LONG', openedAt: NOW - 5 * 60_000 }]);
    const out = await mtfAutoTick(tickP(paper, cryptoBoardRows([flippedShortRow({
      directionVerified: false,
      ensembleSignalAvailable: false,
    })])));

    expect(out.closed).toHaveLength(1);
    expect(out.closed[0].reason).toBe('UC_FLIP_MINIMAL_LOSS_EXIT');
    expect(out.opened).toHaveLength(0);
    expect(paper.openPaperTrade).not.toHaveBeenCalled();
  });

  it('dayCount accounting: flip entry din ka ek trade count karti hai (quota honest)', async () => {
    __resetMtfAutoForTests({
      config: { enabled: true, executionMode: 'paper', minScore: 75 },
      state: { book: [openLongBtc()], dayCount: 0 },
    });
    const { paper } = fakePaper([{ id: 777, symbol: 'BTC', market: 'FUTURES', status: 'OPEN', direction: 'LONG' }]);
    const out = await mtfAutoTick(tickP(paper, cryptoBoardRows([flippedShortRow()])));
    expect(out.opened).toHaveLength(1);
    const stateRaw = JSON.parse(fs.readFileSync(path.join(TMP_DATA, 'mtf-auto-state.json'), 'utf8'));
    expect(stateRaw.dayCount).toBe(1);
  });

  it('LIVE adopted position flip: liveClose + liveExecute reverse + strict traded-only (live fail → koi book row NAHI)', async () => {
    __resetMtfAutoForTests({
      config: { enabled: true, executionMode: 'live', minScore: 75 },
      state: { book: [openLongBtc({
        paperId: null, executionMode: 'LIVE', traded: true, fullControl: true,
        openedInLiveMode: true, liveOrderId: 'ord-1', livePositionId: 'pos-1',
      })] },
    });
    const { paper, calls } = fakePaper([]);
    const liveClose = vi.fn(async () => ({ ok: true }));
    const liveExecute = vi.fn(async (o) => ({
      ok: true, orderId: 'ord-2', position: { id: 'pos-2', exchangePositionId: 'pos-2' },
      filled: { qty: o.qty, price: o.entry, stopLoss: o.stopLoss, t1: o.target1, t2: o.target2 },
    }));
    const out = await mtfAutoTick(tickP(paper, cryptoBoardRows([flippedShortRow()]), {
      siteLiveActive: true, liveClose, liveExecute,
    }));
    expect(liveClose).toHaveBeenCalledTimes(1);
    expect(out.closed[0].reason).toBe('UC_FLIP_MINIMAL_LOSS_EXIT');
    expect(liveExecute).toHaveBeenCalledTimes(1);
    expect(liveExecute.mock.calls[0][0].side).toBe('SHORT');
    expect(liveExecute.mock.calls[0][0].market).toBe('FUTURES');
    expect(out.opened).toHaveLength(1);
    expect(out.opened[0].executionMode).toBe('LIVE');
    expect(out.opened[0].livePositionId).toBe('pos-2');
    expect(out.opened[0].flipEntry).toBe(true);

    // strict traded-only: live FAIL → reverse book row NAHI
    __resetMtfAutoForTests({
      config: { enabled: true, executionMode: 'live', minScore: 75 },
      state: { book: [openLongBtc({
        paperId: null, executionMode: 'LIVE', traded: true, fullControl: true,
        openedInLiveMode: true, liveOrderId: 'ord-1', livePositionId: 'pos-1',
      })] },
    });
    const liveExecuteFail = vi.fn(async () => ({ ok: false, error: 'insufficient margin' }));
    const out2 = await mtfAutoTick(tickP(paper, cryptoBoardRows([flippedShortRow()]), {
      siteLiveActive: true, liveClose, liveExecute: liveExecuteFail,
    }));
    expect(out2.closed).toHaveLength(1);      // protective minimal-loss exit hua
    expect(out2.opened).toHaveLength(0);       // par reverse entry NAHI (traded-only)
    expect(liveExecuteFail).toHaveBeenCalledTimes(1);
  });

  it('v21.24.0 Phase 0: LIVE entries paused — flip protective exit hota hai, reverse LIVE entry NAHI', async () => {
    __resetMtfAutoForTests({
      config: { enabled: true, executionMode: 'live', minScore: 75, liveEntryPaused: true },
      state: {
        book: [openLongBtc({
          paperId: null, executionMode: 'LIVE', traded: true, fullControl: true,
          openedInLiveMode: true, liveOrderId: 'ord-1', livePositionId: 'pos-1',
        })],
      },
    });
    const { paper } = fakePaper([]);
    const liveClose = vi.fn(async () => ({ ok: true, realizedPnl: -5 }));
    const liveExecute = vi.fn(async () => ({ ok: true }));
    const out = await mtfAutoTick(tickP(paper, cryptoBoardRows([flippedShortRow()]), {
      siteLiveActive: true, liveClose, liveExecute,
    }));

    // 1) existing position ka protective exit still happened (management alive)
    expect(liveClose).toHaveBeenCalledTimes(1);
    expect(out.closed).toHaveLength(1);
    expect(out.closed[0].reason).toBe('UC_FLIP_MINIMAL_LOSS_EXIT');
    // 2) reverse LIVE entry blocked — main pause return se pehle deep-monitor
    //    flip path ka apna guard hi fire hua (event proof)
    expect(liveExecute).not.toHaveBeenCalled();
    expect(out.opened).toHaveLength(0);
    const stateRaw = JSON.parse(fs.readFileSync(path.join(TMP_DATA, 'mtf-auto-state.json'), 'utf8'));
    const events = (stateRaw.events || []).map(e => String(e.text || '')).join(' ');
    expect(events).toMatch(/UC FLIP-REVERSE SKIP BTC: LIVE entries paused \(Phase 0\)/);
  });

  it('PAPER trade + siteLiveActive: reverse PAPER hi rehta hai — LIVE order leak nahi', async () => {
    __resetMtfAutoForTests({
      config: { enabled: true, executionMode: 'paper', minScore: 75 },
      state: { book: [openLongBtc()] },
    });
    const { paper, calls } = fakePaper([{ id: 777, symbol: 'BTC', market: 'FUTURES', status: 'OPEN', direction: 'LONG', openedAt: NOW - 5 * 60_000 }]);
    const liveClose = vi.fn(async () => ({ ok: true }));
    const liveExecute = vi.fn(async () => ({ ok: true }));
    const out = await mtfAutoTick(tickP(paper, cryptoBoardRows([flippedShortRow()]), {
      siteLiveActive: true, liveClose, liveExecute,
    }));
    expect(out.closed[0].reason).toBe('UC_FLIP_MINIMAL_LOSS_EXIT');
    expect(liveClose).not.toHaveBeenCalled();
    expect(liveExecute).not.toHaveBeenCalled();
    expect(out.opened).toHaveLength(1);
    expect(out.opened[0].executionMode).toBe('PAPER');
    expect(calls.opened[0].source).toBe('uc-flip-reverse');
  });

  it('board top-6 se bahar open trade ke liye fresh row build hota hai — flip exit silent nahi', async () => {
    __resetMtfAutoForTests({
      config: { enabled: true, executionMode: 'paper', minScore: 75 },
      state: { book: [openLongBtc()] },
    });
    const { paper } = fakePaper([{ id: 777, symbol: 'BTC', market: 'FUTURES', status: 'OPEN', direction: 'LONG', openedAt: NOW - 5 * 60_000 }]);
    const buildRow = vi.fn(async ({ symbol }) => ({
      ok: true, symbol, market: 'CRYPTO', side: 'SHORT', triggerFired: false,
      directionVerified: true, ensembleSignalAvailable: true, autoEligible: true,
      superScore: 80, plan: { entry: 99.6, stopLoss: 100.6, t1: 98.5, t2: 97.5 },
      context: { dir: -1 }, triggerDir: -1, ltp: 99.6,
    }));
    const out = await mtfAutoTick(tickP(paper, cryptoBoardRows([]), { buildDualRow: buildRow }));
    expect(buildRow).toHaveBeenCalledTimes(1);
    expect(out.closed).toHaveLength(1);
    expect(out.closed[0].reason).toBe('UC_FLIP_MINIMAL_LOSS_EXIT');
    expect(out.opened).toHaveLength(1);
    expect(out.opened[0].side).toBe('SHORT');
  });
});

// ============================================================
// S3 — PROFIT flip: reversal profit-book + reverse entry
// ============================================================
describe('v21.23.8 S3 — PROFIT me UC flip → reversal profit-book + reverse entry', () => {
  beforeEach(() => { __resetMtfAutoForTests(); __resetDirectionLocksForTests(); });

  it('LONG @100 profit me (ltp 100.8, fee covered, peak T1 se neeche) + board SHORT PAKKA → REVERSAL_FEE_SAFE_EXIT + SHORT reverse', async () => {
    __resetMtfAutoForTests({
      config: { enabled: true, executionMode: 'paper', minScore: 75 },
      state: { book: [openLongBtc({ peakPrice: 100.8, t1Hit: false })] },
    });
    const { paper } = fakePaper([{ id: 777, symbol: 'BTC', market: 'FUTURES', status: 'OPEN', direction: 'LONG', openedAt: NOW - 5 * 60_000 }]);
    const out = await mtfAutoTick(tickP(paper, cryptoBoardRows([flippedShortRow({ ltp: 100.8 })]), {
      quotes: { 'FUTURES|BTC': { price: 100.8 }, BTC: { price: 100.8 } },
      usdtQuotes: new Map([['BTC', 100.8]]),
    }));
    expect(out.closed).toHaveLength(1);
    expect(out.closed[0].reason).toBe('REVERSAL_FEE_SAFE_EXIT');  // profit-book path
    expect(out.closed[0].feeCovered).toBe(true);
    expect(out.opened).toHaveLength(1);
    expect(out.opened[0].side).toBe('SHORT');
    expect(out.opened[0].entry).toBe(100.8);                      // reverse current price pe
  });
});

// ============================================================
// S4 — PULLBACK ≠ FLIP (the "thoda pullback then phir upar" contract)
// ============================================================
describe('v21.23.8 S4 — pullback me UC flip NAHI — trade SL-trail ke saath SALTA hai', () => {
  beforeEach(() => { __resetMtfAutoForTests(); __resetDirectionLocksForTests(); });

  it('board row SAME side (LONG) rehne par ltp 99.6 pullback → koi close NAHI, koi flip NAHI', async () => {
    __resetMtfAutoForTests({
      config: { enabled: true, executionMode: 'paper', minScore: 75 },
      state: { book: [openLongBtc()] },
    });
    const { paper } = fakePaper([{ id: 777, symbol: 'BTC', market: 'FUTURES', status: 'OPEN', direction: 'LONG' }]);
    const out = await mtfAutoTick(tickP(paper, cryptoBoardRows([sameSideLongRow({ ltp: 99.6 })])));
    expect(out.closed).toHaveLength(0);
    expect(out.opened).toHaveLength(0);
    expect(paper.closePaperTrade).not.toHaveBeenCalled();
    const stateRaw = JSON.parse(fs.readFileSync(path.join(TMP_DATA, 'mtf-auto-state.json'), 'utf8'));
    expect(stateRaw.book[0].status).toBe('OPEN');
  });
});

// ============================================================
// S5 — TP2 FULL COMPLETION: TP2 hit = full profit, koi flip nahi
// ============================================================
describe('v21.23.8 S5 — TP2 tak full trade complete → full profit book + NO flip', () => {
  beforeEach(() => { __resetMtfAutoForTests(); __resetDirectionLocksForTests(); });

  it('ltp 102.5 (T2 hit) + board SHORT PAKKA → T2_PROFIT_BOOK close + koi reverse entry NAHI', async () => {
    __resetMtfAutoForTests({
      config: { enabled: true, executionMode: 'paper', minScore: 75 },
      state: { book: [openLongBtc({ peakPrice: 102.5, t1Hit: true })] },
    });
    const { paper } = fakePaper([{ id: 777, symbol: 'BTC', market: 'FUTURES', status: 'OPEN', direction: 'LONG' }]);
    const out = await mtfAutoTick(tickP(paper, cryptoBoardRows([flippedShortRow({ ltp: 102.5 })]), {
      quotes: { 'FUTURES|BTC': { price: 102.5 }, BTC: { price: 102.5 } },
      usdtQuotes: new Map([['BTC', 102.5]]),
    }));
    expect(out.closed).toHaveLength(1);
    expect(out.closed[0].reason).toBe('T2_PROFIT_BOOK');
    expect(out.opened).toHaveLength(0);   // trade POORA complete — flip nahi
  });
});

// ============================================================
// S6 — churn guards: flip cap / age guard / config OFF
// ============================================================
describe('v21.23.8 S6 — flip churn guards', () => {
  beforeEach(() => { __resetMtfAutoForTests(); __resetDirectionLocksForTests(); });

  it('daily flip cap (4/symbol) par protective EXIT to hota hai par REVERSE entry NAHI', async () => {
    const flips = Array.from({ length: 4 }, (_, i) => openLongBtc({
      paperId: 800 + i, side: i % 2 === 0 ? 'LONG' : 'SHORT',
      status: 'CLOSED', closeReason: 'UC_FLIP_MINIMAL_LOSS_EXIT', closedAt: NOW - 60_000,
      flipEntry: true, flippedFrom: i % 2 === 0 ? 'SHORT' : 'LONG', openedAt: NOW - (10 - i) * 60_000,
    }));
    __resetMtfAutoForTests({
      config: { enabled: true, executionMode: 'paper', minScore: 75 },
      state: { book: [...flips, openLongBtc()] },
    });
    const { paper } = fakePaper([{ id: 777, symbol: 'BTC', market: 'FUTURES', status: 'OPEN', direction: 'LONG' }]);
    const out = await mtfAutoTick(tickP(paper, cryptoBoardRows([flippedShortRow()])));
    expect(out.closed).toHaveLength(1);   // minimal-loss protective exit hamesha allowed
    expect(out.opened).toHaveLength(0);   // par 5th flip entry cap ke kaadam nahi
  });

  it('v21.23.18: PAPER session me doosra open PAPER trade 1-session lock todta nahi — reverse entry blocked', async () => {
    __resetMtfAutoForTests({
      config: { enabled: true, executionMode: 'paper', minScore: 75 },
      state: {
        book: [
          openLongBtc(),
          openLongBtc({ paperId: 778, symbol: 'ETH', entry: 50, stopLoss: 49, t1: 51, t2: 52, notional: 4747.5 }),
        ],
      },
    });
    const { paper } = fakePaper([
      { id: 777, symbol: 'BTC', market: 'FUTURES', status: 'OPEN', direction: 'LONG', openedAt: NOW - 5 * 60_000 },
      { id: 778, symbol: 'ETH', market: 'FUTURES', status: 'OPEN', direction: 'LONG', openedAt: NOW - 5 * 60_000 },
    ]);
    const out = await mtfAutoTick(tickP(paper, cryptoBoardRows([flippedShortRow()])));
    expect(out.closed).toHaveLength(1);
    expect(out.closed[0].reason).toBe('UC_FLIP_MINIMAL_LOSS_EXIT');
    // PAPER mode me bhi 1 session = 1 trade — ETH open hai to BTC reverse nahi
    expect(out.opened).toHaveLength(0);
    expect(paper.open.map(t => t.symbol)).toEqual(['ETH']);
  });

  it('v21.23.18: LIVE flip notional budget PAPER test rows ko count nahi karta', async () => {
    __resetMtfAutoForTests({
      config: {
        enabled: true, executionMode: 'live', minScore: 75,
        maxPositionsINR: 100000, maxNotionalPerTradeINR: 50000,
      },
      state: {
        book: [
          openLongBtc({
            paperId: null, executionMode: 'LIVE', traded: true, fullControl: true,
            openedInLiveMode: true, liveOrderId: 'ord-1', livePositionId: 'pos-1',
          }),
          openLongBtc({
            paperId: 778, symbol: 'ETH', executionMode: 'PAPER',
            entry: 50, stopLoss: 49, t1: 51, t2: 52, notional: 99999.99,
          }),
        ],
      },
    });
    const { paper } = fakePaper([
      { id: 778, symbol: 'ETH', market: 'FUTURES', status: 'OPEN', direction: 'LONG', openedAt: NOW - 5 * 60_000 },
    ]);
    const liveClose = vi.fn(async () => ({ ok: true }));
    const liveExecute = vi.fn(async (o) => ({
      ok: true, orderId: 'ord-2', position: { id: 'pos-2' },
      filled: { qty: o.qty, price: o.entry, stopLoss: o.stopLoss, t1: o.target1, t2: o.target2 },
    }));
    const out = await mtfAutoTick(tickP(paper, cryptoBoardRows([flippedShortRow()]), {
      siteLiveByDesk: { crypto: true, india: false }, liveClose, liveExecute,
    }));
    expect(out.closed).toHaveLength(1);
    expect(out.opened).toHaveLength(1);
    expect(out.opened[0].executionMode).toBe('LIVE');
    expect(liveExecute).toHaveBeenCalledTimes(1);
  });

  it('ucFlipReverse:false → flip close bhi nahi (pure opt-out — v21.23.6/7 behavior)', async () => {
    __resetMtfAutoForTests({
      config: { enabled: true, executionMode: 'paper', minScore: 75, ucFlipReverse: false },
      state: { book: [openLongBtc()] },
    });
    const { paper } = fakePaper([{ id: 777, symbol: 'BTC', market: 'FUTURES', status: 'OPEN', direction: 'LONG' }]);
    const out = await mtfAutoTick(tickP(paper, cryptoBoardRows([flippedShortRow()])));
    expect(out.closed).toHaveLength(0);
    expect(out.opened).toHaveLength(0);
  });

  it('LIVE age guard: <60s purane LIVE trade par UC-flip protective exit NAHI (instant-noise churn)', async () => {
    __resetMtfAutoForTests({
      config: { enabled: true, executionMode: 'live', minScore: 75 },
      state: { book: [openLongBtc({
        paperId: null, executionMode: 'LIVE', traded: true, fullControl: true,
        openedInLiveMode: true, liveOrderId: 'ord-1', livePositionId: 'pos-1',
        openedAt: Date.now() - 20_000,   // sirf 20s purana (runtime clock tick)
      })] },
    });
    const { paper } = fakePaper([]);
    const liveClose = vi.fn(async () => ({ ok: true }));
    // runtime-clock tick (p.now omitted) — real Date.now based
    const out = await mtfAutoTick({
      boards: { CRYPTO: cryptoBoardRows([flippedShortRow({ ltp: 99.6 })]) },
      paper,
      quotes: { 'FUTURES|BTC': { price: 99.6 }, BTC: { price: 99.6 } },
      usdtQuotes: new Map([['BTC', 99.6]]),
      walletEquityINR: 10000,
      fx: 94.95,
      siteLiveActive: true,
      liveClose,
      liveExecute: vi.fn(),
    });
    expect(liveClose).not.toHaveBeenCalled();
    expect(out.closed).toHaveLength(0);
    expect(out.opened).toHaveLength(0);
  });
});

// ============================================================
// S7 — SPOT FULL STOP (executeSignal gate + legacy loop dead)
// ============================================================
describe('v21.23.8 S7 — CoinDCX SPOT FULL STOP', () => {
  let _origCreds = null;
  beforeEach(() => {
    __resetOrdersForTests();
    _origCreds = JSON.parse(JSON.stringify(loadJSONOrig('mcp-coindcx.json') || {}));
    saveJSON('mcp-coindcx.json', { apiKey: 'test-key', secret: 'test-secret', connectedAt: Date.now() });
  });
  afterEach(() => {
    delete process.env.AI_SPOT_FULL_STOP;
    saveJSON('mcp-coindcx.json', _origCreds && _origCreds.apiKey != null ? _origCreds : { apiKey: null, secret: null });
  });

  it('spotTradeFullStop(): test-env default off · =1 on · =0 off', () => {
    delete process.env.AI_SPOT_FULL_STOP;
    expect(spotTradeFullStop()).toBe(false);     // NODE_ENV=test → hermetic gauntlet locks padte rahi
    process.env.AI_SPOT_FULL_STOP = '1';
    expect(spotTradeFullStop()).toBe(true);
    process.env.AI_SPOT_FULL_STOP = '0';
    expect(spotTradeFullStop()).toBe(false);
  });

  it('AI_SPOT_FULL_STOP=1 → executeSignal HAR mode reject (live/notify/paper — spot poora band)', async () => {
    process.env.AI_SPOT_FULL_STOP = '1';
    __setOrdersConfigForTests({ mode: 'live', allowAuto: false, killSwitch: false, minConfidence: 60, minAgreement: 0.5 });
    const freshSignal = async () => ({
      symbol: 'BTC', market: 'CRYPTO', side: 'LONG', grade: 'STRONG', confidence: 82,
      agreement: 0.78, generatedAt: Date.now(), ltp: 100,
      plan: { entry: 100, stopLoss: 96.8, target1: 103.2, target2: 106.4, risk: 3.2, riskPct: 3.2, rewardRisk: 2, atrUsed: 2, planStyle: 'atr-based' },
      votes: [], summary: 'x',
    });
    for (const mode of ['live', 'notify', 'paper']) {
      const out = await executeSignal({ symbol: 'BTC', side: 'LONG', mode, getFreshSignal: freshSignal, source: 'test' });
      expect(out.ok).toBe(false);
      expect(String(out.error)).toContain('SPOT FULL STOP');
    }
  });

  it('source pin: gate 0 executeSignal me sabse pehle + runtime default-ON policy', () => {
    expect(ORDERS_SRC).toContain('export function spotTradeFullStop()');
    expect(ORDERS_SRC).toContain(`return String(process.env.NODE_ENV || '').trim().toLowerCase() !== 'test'`);
    expect(ORDERS_SRC).toContain('--- gate 0: v21.23.8 SPOT FULL STOP');
    expect(ORDERS_SRC).toContain('SPOT FULL STOP — CoinDCX spot band hai (v21.23.8)');
  });

  it('source pin: legacy 90s spot auto-executor PERMANENTLY disabled (early return, koi signal scan nahi)', () => {
    expect(ROUTES_SRC).toContain('LEGACY SPOT AUTO-EXECUTOR — v21.23.8 me PERMANENTLY DISABLED');
    // loop body ab sirf audit-shell: early return BEFORE getSignals/executeSignal
    const loopSrc = ROUTES_SRC.slice(ROUTES_SRC.indexOf('const auto = setInterval'));
    const retAt = loopSrc.indexOf('v21.23.8: SPOT FULL STOP — legacy spot auto-executor permanently disabled');
    const noScanAfter = loopSrc.slice(retAt, retAt + 400);
    expect(noScanAfter).not.toContain("getSignals('CRYPTO'");
    expect(noScanAfter).not.toContain('await executeSignal(');
  });
});

// ============================================================
// S8 — EQUITY SIM allowlist (GLOBALFUTURES USDC sim auto-entries)
// ============================================================
describe('v21.23.8 S8 — EQUITY SIM rows ab auto-pool me (sirf allowed domains)', () => {
  beforeEach(() => { __resetMtfAutoForTests(); __resetDirectionLocksForTests(); });

  it('ELITE GLOBALFUTURES row (NVDA) → paper SIM entry market GLOBALFUTURES · ccy USDC · live order KABHI nahi', async () => {
    __resetMtfAutoForTests({ config: { enabled: true, executionMode: 'paper', minScore: 75 } });
    const { paper, calls } = fakePaper([]);
    const nvdaRow = {
      ok: true, symbol: 'NVDA', market: 'GLOBALFUTURES', mode: 'INTRADAY', label: '15m → 5m', holdMin: 45,
      superScore: 88, tier: 'ELITE', side: 'LONG', dir: 1, grade: 'A',
      triggerFired: true, dualAligned: true, counterTrend: false, tfFit: 'OK',
      autoEligible: true, autoBlockers: [],
      plan: { entry: 200, stopLoss: 198, t1: 203, t2: 206 },
      context: { dir: 1, atrPct: 2.2 }, ltp: 200.5, drivers: ['x'],
    };
    const board = cryptoBoardRows([], { metalsRows: [], equitySimRows: [nvdaRow] });
    const liveExecute = vi.fn();
    const out = await mtfAutoTick({
      boards: { CRYPTO: board },
      paper,
      quotes: { 'GLOBALFUTURES|NVDA': { price: 200.5 } },
      usdtQuotes: new Map([['BTC', 99.6]]),
      walletEquityINR: 10000,
      fx: 94.95,
      now: NOW,
      siteLiveActive: true,       // LIVE session me bhi SIM desk live order nahi lagta
      liveExecute,
    });
    expect(out.opened).toHaveLength(1);
    const rec = out.opened[0];
    expect(rec.symbol).toBe('NVDA');
    expect(rec.execMarket).toBe('GLOBALFUTURES');
    expect(rec.ccy).toBe('USDC');
    expect(rec.executionMode).toBe('PAPER');   // SIM desk — live impossible
    expect(liveExecute).not.toHaveBeenCalled();
    expect(calls.opened[0].market).toBe('GLOBALFUTURES');
    expect(calls.opened[0].t1ClosePct).toBe(0.40);  // HIGH vol stamp (ATR 2.2%)
  });

  it('source pins: pool me equitySimRows + isSimRow live-guard + USDC ccy', () => {
    expect(LINK_SRC).toContain('equitySimRows');
    expect(LINK_SRC).toContain('const isSimRow = rowExecMarket === \'GLOBALFUTURES\'');
    expect(LINK_SRC).toContain('ccy: isSimRow ? \'USDC\' : (isUsd ? \'USDT\' : \'INR\')');
    expect(LINK_SRC).toContain('const wantLiveOrder = cfg.liveEntryPaused !== true && !isSimRow &&');
  });
});

// ============================================================
// S9 — wiring source pins (flip engine + global-quote overlay)
// ============================================================
describe('v21.23.8 S9 — UC flip-reverse wiring source pins', () => {
  it('mtfAutoLink: flip engine wired (protective exit + immediate reverse + churn guards)', () => {
    expect(LINK_SRC).toContain('UC_FLIP_MINIMAL_LOSS_EXIT');
    expect(LINK_SRC).toContain('ucFlipProtectiveExit');
    expect(LINK_SRC).toContain('await _tryOpenUcFlipReverse({');
    expect(LINK_SRC).toContain('export function deriveUcFlipReverseTicket');
    expect(LINK_SRC).toContain('ucFlipReverse: true');
    expect(LINK_SRC).toContain('out.ucFlipReverse = cfg.ucFlipReverse !== false');
    expect(LINK_SRC).toContain('const UC_FLIP_MAX_PER_SYMBOL_PER_DAY = 4');
    expect(LINK_SRC).toContain('releaseDirectionLock(sym, { clearCooldown: true })');
    expect(LINK_SRC).toContain("acquireDirectionLock({ symbol: sym, side, source: 'uc-flip-reverse', now })");
    // TP2-complete protection: flip TP2 hit pe KABHI nahi
    expect(LINK_SRC).toContain('&& !deepEval.tp2Hit');
  });

  it('routes: EQUITY SIM global-quote overlay wired (deep monitor + 3s evaluatePaper + status)', () => {
    expect(ROUTES_SRC).toContain('const mtfGlobalQuoteOverlay = async () => {');
    expect(ROUTES_SRC).toContain('`GLOBALFUTURES|${String(sym).toUpperCase()}`');
    const overlays = ROUTES_SRC.split('mtfGlobalQuoteOverlay()').length - 1;
    expect(overlays).toBeGreaterThanOrEqual(5);  // helper def + status + manual-run + 60s loop + 3s loop + 15s deep tick
    expect(ROUTES_SRC).toContain('fetchGlobalLtpMap,');
  });
});
