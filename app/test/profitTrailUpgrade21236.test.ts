// ============================================================
// test/profitTrailUpgrade21236.test.ts — v21.23.6 AUTO-TRADE PROFIT MAXIMIZATION
// ------------------------------------------------------------
// USER SPEC (verbatim, abridged): "TP1 or TP2 hone par SL trail TOP me hona
// chahiye (long) / SHORT me utna NEECHE — ek ek baar thoda pull back hota hai,
// SL trail smartly adjust karna chahiye, hogye utna jyada se jyada profit
// book ho. Strong LONG signal pe jab price UPAR jata rehta hai trade AUTO
// CLOSE ho raha hai (short me bhi thode profit pe) — sab smartly superfast
// manage karo. Aur jab trade successful close ho, LIVE auto trade pe 5-min
// COOLDOWN lagake phir ELITE top trade VERIFY karke hi lagana chahiye."
//
// ROOT CAUSES THIS LOCKS SHUT (found in this pass):
//   R1 — `reversalRisk` board flag (context.exhausted / opposingFlow) was
//        counted as a CONFIRMED flip → strong trends (jahan exhaustion flags
//        ROUTINE fire hote hai) +0.12R pe profit-book ho jate the jabki
//        price aage hi badhta rehta tha. → ab RISK HINT = SL profit-lock
//        tighten ONLY, trade band NAHI.
//   R2 — peak-giveback 38% (bina absolute floor) har normal pullback pe
//        trade band kar deta tha. → ab DEEP giveback only: >=45% AND
//        >=0.28R absolute.
//   R3 — Stage 5 ka chandelier 0.30R / Stage 4 giveback 0.32R bahut tight
//        the → 0.50R / 0.45R (TP1 floor >= +0.65R pe hi hai).
//
// NEW GATES THIS LOCKS:
//   G1 — post-success 5-min PROFIT-COOLDOWN (LIVE sessions only) — seed a
//        profitable closed row 2m ago → entry BLOCKED; 6m ago → entry OPENS.
//   G2 — LIVE session ELITE-ONLY entry (tier ELITE/STRONG or superScore >= 80)
//        — hybrid siteLiveActive mode me pehle weak rows paper-mirror open
//        kar leti thi; ab block. PAPER mode UNCHANGED.
// ============================================================
import { describe, it, expect, beforeEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'mtf-profit-21236-'));
process.env.MTF_AUTO_DATA_DIR = TMP_DATA;

import {
  mtfAutoTick, __resetMtfAutoForTests, evaluateActiveTradeDeepMonitor,
} from '../server/ai/mtfAutoLink.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.join(__dirname, '..');
const LINK_SRC = read('server/ai/mtfAutoLink.js');
function read(p) { return fs.readFileSync(path.join(APP_ROOT, p), 'utf8'); }

const NOW = 1_765_000_000_000; // deterministic epoch

// ---- deep-monitor fixture: LONG BTC trade · entry 100 · SL 99 (risk = 1R) ----
function dmTrade(over = {}) {
  return {
    symbol: 'BTCUSDT', market: 'FUTURES', execMarket: 'FUTURES', ccy: 'USDT',
    side: 'LONG', entry: 100, entryPrice: 100, stopLoss: 99, initialStopLoss: 99,
    t1: 101, t2: 102, qty: 1, peakPrice: 100, openedAt: NOW - 10 * 60_000,
    // v21.26.1: this suite locks the LEGACY v1/v2 stage engine. Pro defaults
    // ON in production; explicit false keeps the old-behavior coverage.
    proExitPolicy: false,
    ...over,
  };
}

// ---- tick harness (the mtfAutoLink.test.ts pattern) ----
function fakePaper(over = {}) {
  const calls = { opened: [], closed: [] };
  const paper = {
    open: [],
    openPaperTrade: vi.fn((input) => {
      calls.opened.push(input);
      const trade = { id: 900 + calls.opened.length, ...input };
      paper.open.push({ id: trade.id, symbol: input.symbol, market: input.market, status: 'OPEN', direction: input.direction, openedAt: NOW });
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
function liveP(paper, over = {}) {
  return {
    boards: { CRYPTO: boardFixture() },
    paper,
    quotes: {},
    usdtQuotes: new Map([['BTC', 100.25]]), // normalizeLinkSymbol BTCUSDT → BTC — quote key = base
    walletEquityINR: 10000,
    fx: 94.95,
    now: NOW,
    ...over,
  };
}
function liveExecuteOk() {
  return vi.fn(async () => ({
    ok: true, filled: { qty: 1, price: 100.25, stopLoss: 99, t1: 101, t2: 102 },
  }));
}
function closedProfitRow(minsAgo, over = {}) {
  return {
    symbol: 'BTCUSDT', market: 'CRYPTO', execMarket: 'FUTURES', executionMode: 'LIVE',
    side: 'LONG', entry: 100, qty: 1, status: 'CLOSED',
    closeReason: 'TP2_TARGET_HIT_FULL_PROFIT', closedAt: NOW - minsAgo * 60_000,
    pnl: 250, openedAt: NOW - (minsAgo + 30) * 60_000, notional: 1000,
    dayKey: '2099-01-01', // stale day — quota isolation; cooldown mechanism day-agnostic hai
    ...over,
  };
}

// ============================================================
// R1 — reversalRisk risk-hint ≠ confirmed flip (THE strong-trend auto-close killer)
// ============================================================
describe('v21.23.6 R1 — reversalRisk no longer books strong-trend winners', () => {
  it('board reversalRisk + peak 0.6R + fee-covered → NO book (pehle +0.12R pe close ho jata tha)', () => {
    const ev = evaluateActiveTradeDeepMonitor(
      dmTrade({ peakPrice: 100.6 }),
      { ltp: 100.6, boardRow: { side: 'LONG', triggerFired: true, superScore: 85, reversalRisk: true } },
    );
    expect(ev.shouldBookProfitNow).toBe(false);
    expect(ev.shouldClose).toBe(false);
    expect(ev.exitReason).toBeNull();
    expect(ev.trailedStopLoss).toBeGreaterThan(100); // profit-lock tightened above entry
  });

  it('reversalRisk hint tightens SL to a profit-lock (peak−0.50R, min +0.15R) — trade OPEN rehta hai', () => {
    // peak 0.5R with an early-stage trade: Stage 2 lock is +0.15R; hint keeps >= +0.15R
    const ev = evaluateActiveTradeDeepMonitor(
      dmTrade({ peakPrice: 100.5 }),
      { ltp: 100.5, boardRow: { side: 'LONG', triggerFired: true, superScore: 85, context: { exhausted: true } } },
    );
    expect(ev.shouldBookProfitNow).toBe(false);
    expect(ev.trailedStopLoss).toBeGreaterThanOrEqual(100.15 - 1e-9);
    expect(ev.stageLabel).toContain('Reversal-Risk Profit-Lock');
  });

  it('TRUE flip (side actually SHORT + triggerFired) STILL books — reversal profit-book intact', () => {
    const ev = evaluateActiveTradeDeepMonitor(
      dmTrade({ peakPrice: 100.35 }),
      { ltp: 100.35, boardRow: { side: 'SHORT', triggerFired: true, superScore: 70 } },
    );
    expect(ev.reversalDetected).toBe(true);
    expect(ev.shouldBookProfitNow).toBe(true);
    expect(ev.exitReason).toBe('PRE_T1_REVERSAL_PROFIT_BOOKED');
  });

  it('defensive tighten pre-fee on reversalRisk hint: SL → −0.35R (capital guard, no close)', () => {
    const ev = evaluateActiveTradeDeepMonitor(
      dmTrade({ peakPrice: 100 }),
      { ltp: 99.95, boardRow: { side: 'LONG', triggerFired: true, superScore: 85, reversalRisk: true } },
    );
    expect(ev.trailedStopLoss).toBeCloseTo(99.65, 6);
    expect(ev.shouldBookProfitNow).toBe(false);
    expect(ev.stageLabel).toContain('Defensive Reversal Tighten');
  });
});

// ============================================================
// TP1/TP2 SL-TRAIL DIRECTION (user spec: long→UPAR, short→NEECHE)
// ============================================================
describe('v21.23.6 — TP1/TP2 hit par SL trail entry ke UPAR (long) / NEECHE (short)', () => {
  it('TP1 hit LONG → trailed SL = entry + 0.65R (above entry)', () => {
    const ev = evaluateActiveTradeDeepMonitor(dmTrade({ t1Hit: true, peakPrice: 101 }), { ltp: 100.9 });
    expect(ev.stageCode).toBe('STAGE_4_TP1_LOCKED');
    expect(ev.trailedStopLoss).toBeCloseTo(100.65, 6);
    expect(ev.trailedStopLoss).toBeGreaterThan(100); // UPAR — profit locked
  });

  it('TP1 hit SHORT → trailed SL = entry − 0.65R (below entry)', () => {
    const ev = evaluateActiveTradeDeepMonitor(
      dmTrade({ side: 'SHORT', stopLoss: 101, initialStopLoss: 101, t1: 99, t2: 98, t1Hit: true, peakPrice: 99 }),
      { ltp: 99.1 },
    );
    expect(ev.stageCode).toBe('STAGE_4_TP1_LOCKED');
    expect(ev.trailedStopLoss).toBeCloseTo(99.35, 6);
    expect(ev.trailedStopLoss).toBeLessThan(100); // NEECHE — profit locked
  });

  it('TP2 hit → full profit book', () => {
    const ev = evaluateActiveTradeDeepMonitor(dmTrade({ t1Hit: true, peakPrice: 102 }), { ltp: 102 });
    expect(ev.tp2Hit).toBe(true);
    expect(ev.shouldBookProfitNow).toBe(true);
    expect(ev.exitReason).toBe('TP2_TARGET_HIT_FULL_PROFIT');
  });

  it('monotonic ratchet: SL kabhi LOOSE nahi hota (peaks up + pullback +新高 seq)', () => {
    let carried = dmTrade();
    let lastSl = 0;
    for (const px of [100.5, 101, 101.6, 101.2, 101.9]) {
      const ev = evaluateActiveTradeDeepMonitor(carried, { ltp: px });
      expect(ev.trailedStopLoss).toBeGreaterThanOrEqual(lastSl - 1e-9);
      lastSl = ev.trailedStopLoss;
      carried = {
        ...carried,
        peakPrice: Math.max(carried.peakPrice, px),
        stopLoss: ev.trailedStopLoss,
        trailedStopLoss: ev.trailedStopLoss,
        t1Hit: carried.t1Hit || px >= 101,
      };
    }
    expect(lastSl).toBeGreaterThan(101); // run ne TP1 ke upar lock kiya
  });
});

// ============================================================
// R2 + R3 — PULLBACK TOLERANCE (normal pullback survival + deep-giveback book)
// ============================================================
describe('v21.23.6 R2/R3 — pullback tolerance + wider chandelier', () => {
  it('peak 1.6R → pullback to 1.2R (25% giveback) → HOLD (normal pullback, trend jaari)', () => {
    const ev = evaluateActiveTradeDeepMonitor(dmTrade({ t1Hit: true, peakPrice: 101.6 }), { ltp: 101.2 });
    expect(ev.shouldBookProfitNow).toBe(false);
    expect(ev.shouldClose).toBe(false);
  });

  it('peak 0.5R → pull to 0.25R: ratio 50% BUT abs giveback 0.25R < 0.28R floor → HOLD (pehle 38% pe band ho jata)', () => {
    const ev = evaluateActiveTradeDeepMonitor(dmTrade({ peakPrice: 100.5 }), { ltp: 100.25 });
    expect(ev.shouldBookProfitNow).toBe(false);
  });

  it('peak 1.6R → pull to 0.8R (50% AND 0.8R absolute) → DEEP giveback → BOOK', () => {
    const ev = evaluateActiveTradeDeepMonitor(dmTrade({ t1Hit: true, peakPrice: 101.6 }), { ltp: 100.8 });
    expect(ev.shouldBookProfitNow).toBe(true);
    expect(ev.exitReason).toBeTruthy(); // TRAILED_SL_PROFIT_BOOKED | T1_BOOKED_REVERSAL_PROFIT_LOCK
  });

  it('Stage 5 chandelier = peak − 0.50R (was 0.30R) — floor stays at TP1', () => {
    const ev = evaluateActiveTradeDeepMonitor(dmTrade({ t1Hit: true, peakPrice: 101.6 }), { ltp: 101.6 });
    expect(ev.stageCode).toBe('STAGE_5_RUNNER_TO_TP2');
    expect(ev.trailedStopLoss).toBeCloseTo(101.1, 6); // 101.6 − 0.50R
    expect(ev.trailedStopLoss).toBeGreaterThan(101);  // >= TP1 floor
  });
});

// ============================================================
// G1 — POST-SUCCESS 5-MIN PROFIT-COOLDOWN (LIVE sessions only)
// ============================================================
describe('v21.23.6 G1 — post-success 5-min cooldown on LIVE re-entry', () => {
  const cfg = { enabled: true, executionMode: 'live', postSuccessCooldownMin: 5, minScore: 75 };

  it('profitable close 2m ago → LIVE entry BLOCKED (skipped reason visible, no order)', async () => {
    __resetMtfAutoForTests({ config: cfg, state: { book: [closedProfitRow(2)] } });
    const { paper } = fakePaper();
    const out = await mtfAutoTick(liveP(paper, { liveExecute: liveExecuteOk(), siteLiveByDesk: { crypto: true, india: false } }));
    expect(out.skipped.join(' | ')).toMatch(/post-success cooldown/);
    expect(paper.openPaperTrade).not.toHaveBeenCalled();
    expect(out.opened).toHaveLength(0);
  });

  it('profitable close 6m ago → cooldown expired → ELITE-verified entry OPENS', async () => {
    __resetMtfAutoForTests({ config: cfg, state: { book: [closedProfitRow(6)] } });
    const { paper } = fakePaper();
    const out = await mtfAutoTick(liveP(paper, { liveExecute: liveExecuteOk(), siteLiveByDesk: { crypto: true, india: false } }));
    expect(out.skipped.join(' | ')).not.toMatch(/post-success cooldown/);
    expect(paper.openPaperTrade).toHaveBeenCalledTimes(1);
    expect(out.opened).toHaveLength(1);
  });

  it('EXCHANGE_POSITION_CLOSED in >=0.5R profit stage counts as success (native TP/SL fills)', async () => {
    __resetMtfAutoForTests({
      config: cfg,
      state: { book: [closedProfitRow(2, { pnl: null, closeReason: 'EXCHANGE_POSITION_CLOSED', peakR: 0.9 })] },
    });
    const { paper } = fakePaper();
    const out = await mtfAutoTick(liveP(paper, { liveExecute: liveExecuteOk(), siteLiveByDesk: { crypto: true, india: false } }));
    expect(out.skipped.join(' | ')).toMatch(/post-success cooldown/);
    expect(paper.openPaperTrade).not.toHaveBeenCalled();
  });

  it('LOSS close (SL_HIT, pnl<0) ≠ successful → NO cooldown, re-entry allowed', async () => {
    __resetMtfAutoForTests({
      config: cfg,
      state: { book: [closedProfitRow(2, { pnl: -50, closeReason: 'SL_HIT' })] },
    });
    const { paper } = fakePaper();
    const out = await mtfAutoTick(liveP(paper, { liveExecute: liveExecuteOk(), siteLiveByDesk: { crypto: true, india: false } }));
    expect(out.skipped.join(' | ')).not.toMatch(/post-success cooldown/);
    expect(paper.openPaperTrade).toHaveBeenCalledTimes(1);
  });

  it('PURGED_UNTRADED rows never count as success', async () => {
    __resetMtfAutoForTests({
      config: cfg,
      state: { book: [closedProfitRow(2, { pnl: null, closeReason: 'PURGED_UNTRADED_ENTRY' })] },
    });
    const { paper } = fakePaper();
    const out = await mtfAutoTick(liveP(paper, { liveExecute: liveExecuteOk(), siteLiveByDesk: { crypto: true, india: false } }));
    expect(out.skipped.join(' | ')).not.toMatch(/post-success cooldown/);
    expect(paper.openPaperTrade).toHaveBeenCalledTimes(1);
  });

  it('postSuccessCooldownMin=0 → cooldown OFF (explicit config escape hatch)', async () => {
    __resetMtfAutoForTests({
      config: { ...cfg, postSuccessCooldownMin: 0 },
      state: { book: [closedProfitRow(2)] },
    });
    const { paper } = fakePaper();
    const out = await mtfAutoTick(liveP(paper, { liveExecute: liveExecuteOk(), siteLiveByDesk: { crypto: true, india: false } }));
    expect(out.skipped.join(' | ')).not.toMatch(/post-success cooldown/);
    expect(paper.openPaperTrade).toHaveBeenCalledTimes(1);
  });

  it('PAPER session: cooldown NOT applied (LIVE-only gate)', async () => {
    __resetMtfAutoForTests({
      config: { enabled: true, executionMode: 'paper', postSuccessCooldownMin: 5, minScore: 75 },
      state: { book: [closedProfitRow(2)] },
    });
    const { paper } = fakePaper();
    const out = await mtfAutoTick(liveP(paper, { liveExecute: liveExecuteOk() }));
    expect(out.skipped.join(' | ')).not.toMatch(/post-success cooldown/);
    expect(paper.openPaperTrade).toHaveBeenCalledTimes(1);
  });
});

// ============================================================
// G2 — LIVE ELITE-ONLY ENTRY (elite top trade verify karke hi lagana)
// ============================================================
describe('v21.23.6 G2 — LIVE session entry = ELITE/STRONG (superScore>=80) ONLY', () => {
  it('hybrid siteLiveActive mode: ACTION-tier row (score 76) → NO open (pehle paper-mirror khul jata tha)', async () => {
    __resetMtfAutoForTests({ config: { enabled: true, executionMode: 'paper', minScore: 75 } });
    const { paper } = fakePaper();
    const out = await mtfAutoTick(liveP(paper, {
      boards: { CRYPTO: boardFixture('BTCUSDT', { tier: 'ACTION', superScore: 76 }) },
      siteLiveActive: true,
      liveExecute: liveExecuteOk(),
    }));
    expect(paper.openPaperTrade).not.toHaveBeenCalled();
    expect(out.opened).toHaveLength(0);
  });

  it('same hybrid mode: STRONG row (score 82) → LIVE order executes + opens', async () => {
    __resetMtfAutoForTests({ config: { enabled: true, executionMode: 'paper', minScore: 75 } });
    const { paper } = fakePaper();
    const out = await mtfAutoTick(liveP(paper, { siteLiveActive: true, liveExecute: liveExecuteOk() }));
    expect(paper.openPaperTrade).toHaveBeenCalledTimes(1);
    expect(out.opened).toHaveLength(1);
  });

  it('desk-scope: India-only live session never places a CRYPTO LIVE order', async () => {
    __resetMtfAutoForTests({ config: { enabled: true, executionMode: 'paper', minScore: 75 } });
    const { paper } = fakePaper();
    const liveExecute = liveExecuteOk();
    const out = await mtfAutoTick(liveP(paper, {
      siteLiveActive: true,
      siteLiveByDesk: { crypto: false, india: true },
      liveExecute,
    }));
    expect(liveExecute).not.toHaveBeenCalled();
    expect(paper.openPaperTrade).toHaveBeenCalledTimes(1);
    expect(out.opened).toHaveLength(1);
  });

  it('desk-scope: crypto live session still places the CRYPTO LIVE order', async () => {
    __resetMtfAutoForTests({ config: { enabled: true, executionMode: 'paper', minScore: 75 } });
    const { paper } = fakePaper();
    const liveExecute = liveExecuteOk();
    const out = await mtfAutoTick(liveP(paper, {
      siteLiveActive: true,
      siteLiveByDesk: { crypto: true, india: false },
      liveExecute,
    }));
    expect(liveExecute).toHaveBeenCalledTimes(1);
    expect(out.opened).toHaveLength(1);
  });

  it('PAPER session (no siteLiveActive): ACTION-tier row still opens — paper mode UNCHANGED', async () => {
    __resetMtfAutoForTests({ config: { enabled: true, executionMode: 'paper', minScore: 75 } });
    const { paper } = fakePaper();
    const out = await mtfAutoTick(liveP(paper, {
      boards: { CRYPTO: boardFixture('BTCUSDT', { tier: 'ACTION', superScore: 76 }) },
    }));
    expect(paper.openPaperTrade).toHaveBeenCalledTimes(1);
    expect(out.opened).toHaveLength(1);
  });
});

// ============================================================
// SOURCE PINS — the tuning constants + gates, verbatim
// ============================================================
describe('v21.23.6 source pins', () => {
  it('boardFlipped me reversalRisk clause REMOVED (R1 root-cause pin)', () => {
    expect(LINK_SRC).not.toContain('boardRow.reversalRisk === true && feeCovered');
    expect(LINK_SRC).toContain('const reversalRiskHint = Boolean(boardRow && (');
  });

  it('pullback tolerance constants: 45% ratio AND 0.28R absolute floor (v21.23.7: ab profile-driven — NORMAL default inhi values pe)', () => {
    // v21.23.7: deep monitor ab volTrail.js profile se chalta hai — NORMAL
    // class (default) ke liye giveback tolerance 45% + 0.28R hi hai (v21.23.6-identical);
    // LOW 42%/0.25R · HIGH 55%/0.38R · EXTREME 65%/0.50R volTrail21237.test.ts me locked.
    expect(LINK_SRC).toContain('peakGivebackRatio >= (profile.givebackRatioPct / 100) && givebackR >= profile.givebackAbsFloorR && feeCovered');
  });

  it('stage 5 chandelier + stage 4 giveback ab vol-adaptive profile se (v21.23.7: NORMAL = 0.50R / 0.45R — v21.23.6-identical)', () => {
    expect(LINK_SRC).toContain('profile.stage5ChandelierR * risk');
    expect(LINK_SRC).toContain('Math.max(0.65, +(peakR - profile.stage4GivebackR).toFixed(2))'); // stage-4 ratchet
    expect(LINK_SRC).not.toContain('peakPrice - 0.30 * risk'); // old tight chandelier GONE
    expect(LINK_SRC).not.toContain('peakPrice - 0.50 * risk'); // hardcoded chandelier GONE — profile-driven only
  });

  it('cooldown + elite gates wired (config default 5 + helper + tick gate)', () => {
    expect(LINK_SRC).toContain('postSuccessCooldownMin: 5');
    // v21.23.18: cooldown helper ab live-scoped hai — PAPER test closes real
    // LIVE re-entry ko block nahi karte.
    expect(LINK_SRC).toContain('function _lastProfitCloseAt(liveOnly = false)');
    expect(LINK_SRC).toContain('const lastSuccessAt = _lastProfitCloseAt(isLiveSession);');
    expect(LINK_SRC).toContain('post-success cooldown: ${leftMin}m left');
  });
});
