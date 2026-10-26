// ============================================================
// test/volTrail21237.test.ts — v21.23.7 VOLATILITY-ADAPTIVE SUPER SMART
// SL TRAIL + ULTRA-FAST TREND CAPTURE + WS health false-DOWN fix
// ------------------------------------------------------------
// USER PROBLEM (verbatim): "jab long or short pe TP1 & TP2 Profit book tak
// reach nhi ho raha hai bada profit amount book nhi ho raha hai bahut kam
// profit book karke trade exit ho raha hai isko advance pro level pe smart
// banao sl trail ko aur improvement karo trade volatile me"
// + "long or short trade signals trend ultra fast se capture hona chahiye"
// + "site me coindcx tab me FEEDS 2/2 · 4s WS ⚠ 1 DOWN isko bhi fix kardo"
//
// LOCKS:
//   S1 — vol classification boundaries (0.8 / 1.8 / 3.5 ATR%)
//   S2 — the full 4-class × 10-param trail table (user spec exact)
//   S3 — vol-adaptive stage entries (LOW = v21.23.6-identical; HIGH/EXTREME wider)
//   S4 — vol-adaptive chandelier (Stage 5) per class
//   S5 — vol-adaptive pullback giveback tolerance matrix
//   S6 — reversal-risk hint lock wider in HIGH/EXTREME (peak−0.65R)
//   S7 — C4 momentum-aware acceleration (SURGING widens / FADING tightens)
//   S8 — monotonic ratchet across LIVE vol-class switch (SL kabhi loose nahi)
//   S9 — TP1 partial book vol-aware (HIGH 40% / EXTREME 35% / default 50%)
//   S10 — deep-monitor vol stamps + telemetry return
//   S11 — WS ⚠ 1 DOWN false-positive fix (spotWs honest healthy + demand-armed)
//   S12 — ULTRA-FAST TREND CAPTURE 10s probe wiring (routes.js)
// ============================================================
import { describe, it, expect, beforeEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'mtf-voltrail-21237-'));
process.env.MTF_AUTO_DATA_DIR = TMP_DATA;

import {
  classifyVolatility, trailProfileFor, applyMomentum, momentumStateOf,
  resolveVolClass, tp1ClosePctFor, TRAIL_TABLE, VOL_CLASS, MOMENTUM,
} from '../server/ai/volTrail.js';
import { evaluateActiveTradeDeepMonitor, mtfAutoTick, __resetMtfAutoForTests } from '../server/ai/mtfAutoLink.js';
import {
  openPaperTrade, evaluatePaper, getPaperSummary, updatePaperTradeT1ClosePct,
  _resetForTests,
} from '../server/intraday/paperTrading.js';
import { spotWsStatus, spotWsDemand } from '../server/ai/cxSpotWs.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(APP_ROOT, p), 'utf8');
const LINK_SRC = read('server/ai/mtfAutoLink.js');
const ROUTES_SRC = read('server/ai/routes.js');
const HM_SRC = read('server/healthMonitor.js');
const CXSPOT_SRC = read('server/ai/cxSpotWs.js');
const CXRT_SRC = read('server/ai/cxRtStream.js');
const PAPER_SRC = read('server/intraday/paperTrading.js');

const NOW = 1_765_000_000_000;

// ---- deep-monitor fixture: LONG BTC trade · entry 100 · SL 99 (risk = 1R) ----
function dmTrade(over = {}) {
  return {
    symbol: 'BTCUSDT', market: 'FUTURES', execMarket: 'FUTURES', ccy: 'USDT',
    side: 'LONG', entry: 100, entryPrice: 100, stopLoss: 99, initialStopLoss: 99,
    t1: 101, t2: 102, qty: 1, peakPrice: 100, openedAt: NOW - 10 * 60_000,
    proExitPolicy: false,
    ...over,
  };
}
// boardRow with a LIVE ATR% volatility class + optional trigger momentum fields
function boardVol(atrPct, trigger = null, over = {}) {
  return { side: 'LONG', triggerFired: true, superScore: 85, context: { atrPct }, ...(trigger ? { trigger } : {}), ...over };
}

// ============================================================
// S1 — VOL CLASSIFICATION BOUNDARIES (user spec: <0.8 / <1.8 / <3.5 / ≥3.5)
// ============================================================
describe('v21.23.7 S1 — classifyVolatility boundaries', () => {
  it('ATR% boundaries: 0.1/0.79 LOW · 0.8/1.79 NORMAL · 1.8/3.49 HIGH · 3.5/10 EXTREME', () => {
    expect(classifyVolatility(0.1)).toBe(VOL_CLASS.LOW);
    expect(classifyVolatility(0.79)).toBe(VOL_CLASS.LOW);
    expect(classifyVolatility(0.8)).toBe(VOL_CLASS.NORMAL);
    expect(classifyVolatility(1.79)).toBe(VOL_CLASS.NORMAL);
    expect(classifyVolatility(1.8)).toBe(VOL_CLASS.HIGH);
    expect(classifyVolatility(3.49)).toBe(VOL_CLASS.HIGH);
    expect(classifyVolatility(3.5)).toBe(VOL_CLASS.EXTREME);
    expect(classifyVolatility(10)).toBe(VOL_CLASS.EXTREME);
  });
  it('null / 0 / invalid ATR → NORMAL (v21.23.6 default — no-data regression-free)', () => {
    expect(classifyVolatility(null)).toBe(VOL_CLASS.NORMAL);
    expect(classifyVolatility(0)).toBe(VOL_CLASS.NORMAL);
    expect(classifyVolatility(undefined)).toBe(VOL_CLASS.NORMAL);
    expect(classifyVolatility('abc')).toBe(VOL_CLASS.NORMAL);
  });
  it('resolveVolClass priority: LIVE ATR% > entry-stamped atrPct > stamped volClass > NORMAL', () => {
    expect(resolveVolClass({ liveAtrPct: 2.0, tradeAtrPct: 0.5, tradeVolClass: 'LOW' }).volClass).toBe(VOL_CLASS.HIGH);
    expect(resolveVolClass({ tradeAtrPct: 0.5, tradeVolClass: 'LOW' }).volClass).toBe(VOL_CLASS.LOW);
    expect(resolveVolClass({ tradeVolClass: 'EXTREME' }).volClass).toBe(VOL_CLASS.EXTREME);
    expect(resolveVolClass({}).volClass).toBe(VOL_CLASS.NORMAL);
  });
});

// ============================================================
// S2 — THE TRAIL TABLE (user spec exact — 4 classes × 10 params)
// ============================================================
describe('v21.23.7 S2 — TRAIL_TABLE exact user-spec values', () => {
  it('LOW = v21.23.6-identical or TIGHTER (no-regression guarantee)', () => {
    const p = trailProfileFor(VOL_CLASS.LOW);
    expect(p.stage1EarlyR).toBe(0.18);
    expect(p.stage1R).toBe(0.30);
    expect(p.stage2R).toBe(0.50);
    expect(p.stage3R).toBe(0.80);
    expect(p.stage3GivebackR).toBe(0.32);
    expect(p.stage4GivebackR).toBe(0.40);   // ≤ v21.23.6 ke 0.45 (tighter)
    expect(p.stage5ChandelierR).toBe(0.45);  // ≤ 0.50 (tighter)
    expect(p.givebackRatioPct).toBe(42);     // ≤ 45 (tighter)
    expect(p.givebackAbsFloorR).toBe(0.25);  // ≤ 0.28 (tighter)
    expect(p.hintGivebackR).toBe(0.50);      // identical
    expect(p.tp1ClosePct).toBe(0.50);        // identical
  });
  it('NORMAL = standard (default bina ATR data ke — giveback/chandelier v21.23.6-identical)', () => {
    const p = trailProfileFor(VOL_CLASS.NORMAL);
    expect(p.stage1EarlyR).toBe(0.22);
    expect(p.stage1R).toBe(0.35);
    expect(p.stage2R).toBe(0.55);
    expect(p.stage3R).toBe(0.85);
    expect(p.stage3GivebackR).toBe(0.35);
    expect(p.stage4GivebackR).toBe(0.45);
    expect(p.stage5ChandelierR).toBe(0.50);
    expect(p.givebackRatioPct).toBe(45);
    expect(p.givebackAbsFloorR).toBe(0.28);
    expect(p.hintGivebackR).toBe(0.50);
    expect(p.tp1ClosePct).toBe(0.50);
  });
  it('HIGH = WIDE trails (user spec)', () => {
    const p = trailProfileFor(VOL_CLASS.HIGH);
    expect(p.stage1EarlyR).toBe(0.30);
    expect(p.stage1R).toBe(0.45);
    expect(p.stage2R).toBe(0.65);
    expect(p.stage3R).toBe(0.95);
    expect(p.stage3GivebackR).toBe(0.42);
    expect(p.stage4GivebackR).toBe(0.55);
    expect(p.stage5ChandelierR).toBe(0.65);
    expect(p.givebackRatioPct).toBe(55);
    expect(p.givebackAbsFloorR).toBe(0.38);
    expect(p.hintGivebackR).toBe(0.65);
    expect(p.tp1ClosePct).toBe(0.40);        // runner BADA
  });
  it('EXTREME = ULTRA-WIDE trails (user spec)', () => {
    const p = trailProfileFor(VOL_CLASS.EXTREME);
    expect(p.stage1EarlyR).toBe(0.40);
    expect(p.stage1R).toBe(0.55);
    expect(p.stage2R).toBe(0.75);
    expect(p.stage3R).toBe(1.05);
    expect(p.stage3GivebackR).toBe(0.50);
    expect(p.stage4GivebackR).toBe(0.65);
    expect(p.stage5ChandelierR).toBe(0.80);
    expect(p.givebackRatioPct).toBe(65);
    expect(p.givebackAbsFloorR).toBe(0.50);
    expect(p.hintGivebackR).toBe(0.65);
    expect(p.tp1ClosePct).toBe(0.35);        // sabse bada runner
  });
  it('structural safety: stage3 giveback ≤ stage4 giveback har class me; thresholds per-class monotonic', () => {
    for (const cls of Object.values(VOL_CLASS)) {
      const p = trailProfileFor(cls);
      expect(p.stage1EarlyR).toBeLessThan(p.stage1R);
      expect(p.stage1R).toBeLessThan(p.stage2R);
      expect(p.stage2R).toBeLessThan(p.stage3R);
      expect(p.stage3GivebackR).toBeLessThanOrEqual(p.stage4GivebackR);
      expect(p.stage4GivebackR).toBeLessThanOrEqual(0.70);
      expect(p.stage5ChandelierR).toBeGreaterThanOrEqual(0.40);
      expect(p.stage5ChandelierR).toBeLessThanOrEqual(1.00);
      expect(p.tp1ClosePct).toBeGreaterThanOrEqual(0.30);
      expect(p.tp1ClosePct).toBeLessThanOrEqual(0.50);
    }
  });
  it('tp1ClosePctFor: HIGH vol 40% / EXTREME 35% / LOW+NORMAL 50%', () => {
    expect(tp1ClosePctFor(VOL_CLASS.LOW)).toBe(0.50);
    expect(tp1ClosePctFor(VOL_CLASS.NORMAL)).toBe(0.50);
    expect(tp1ClosePctFor(VOL_CLASS.HIGH)).toBe(0.40);
    expect(tp1ClosePctFor(VOL_CLASS.EXTREME)).toBe(0.35);
    expect(tp1ClosePctFor('BOGUS')).toBe(0.50); // unknown class → NORMAL default
  });
});

// ============================================================
// S3/S4 — DEEP MONITOR VOL-ADAPTIVE STAGES (engine-level)
// ============================================================
describe('v21.23.7 S3 — stage entry thresholds volatility-scaled (engine)', () => {
  it('LOW vol (ATR 0.5%): v21.23.6-identical entries — 0.18 Early / 0.30 S1 / 0.50 S2', () => {
    const brd = boardVol(0.5);
    expect(evaluateActiveTradeDeepMonitor(dmTrade({ peakPrice: 100.19 }), { ltp: 100.19, boardRow: brd }).stageCode).toBe('STAGE_1_EARLY_SHIELD');
    expect(evaluateActiveTradeDeepMonitor(dmTrade({ peakPrice: 100.31 }), { ltp: 100.31, boardRow: brd }).stageCode).toBe('STAGE_1_RISK_HALVED');
    expect(evaluateActiveTradeDeepMonitor(dmTrade({ peakPrice: 100.51 }), { ltp: 100.51, boardRow: brd }).stageCode).toBe('STAGE_2_BREAKEVEN_PLUS');
  });
  it('HIGH vol (ATR 2.5%): 0.29R noise Stage-0 me hi rehta hai — 0.30 Early / 0.45 S1 / 0.65 S2 / 0.95 S3 (THE fix — v21.23.6 me 0.30R pe hi risk-halving trail shuru ho jaata tha)', () => {
    const brd = boardVol(2.5);
    expect(evaluateActiveTradeDeepMonitor(dmTrade({ peakPrice: 100.29 }), { ltp: 100.29, boardRow: brd }).stageCode).toBe('STAGE_0_INITIAL_GUARD');
    expect(evaluateActiveTradeDeepMonitor(dmTrade({ peakPrice: 100.31 }), { ltp: 100.31, boardRow: brd }).stageCode).toBe('STAGE_1_EARLY_SHIELD');
    expect(evaluateActiveTradeDeepMonitor(dmTrade({ peakPrice: 100.45 }), { ltp: 100.45, boardRow: brd }).stageCode).toBe('STAGE_1_RISK_HALVED');
    expect(evaluateActiveTradeDeepMonitor(dmTrade({ peakPrice: 100.65 }), { ltp: 100.65, boardRow: brd }).stageCode).toBe('STAGE_2_BREAKEVEN_PLUS');
    expect(evaluateActiveTradeDeepMonitor(dmTrade({ peakPrice: 100.95 }), { ltp: 100.95, boardRow: brd }).stageCode).toBe('STAGE_3_PROFIT_RATCHET');
  });
  it('EXTREME vol (ATR 4%): 0.40 Early / 0.55 S1 / 0.75 S2 / 1.05 S3 (wide t1 override — TP1 pehle nahi chhootna chahiye)', () => {
    const brd = boardVol(4.0);
    const wide = { t1: 102, t2: 103 };
    expect(evaluateActiveTradeDeepMonitor(dmTrade({ peakPrice: 100.40, ...wide }), { ltp: 100.40, boardRow: brd }).stageCode).toBe('STAGE_1_EARLY_SHIELD');
    expect(evaluateActiveTradeDeepMonitor(dmTrade({ peakPrice: 100.55, ...wide }), { ltp: 100.55, boardRow: brd }).stageCode).toBe('STAGE_1_RISK_HALVED');
    expect(evaluateActiveTradeDeepMonitor(dmTrade({ peakPrice: 100.75, ...wide }), { ltp: 100.75, boardRow: brd }).stageCode).toBe('STAGE_2_BREAKEVEN_PLUS');
    // NOTE: EXTREME ka stage-3 bar (1.05R) stage-4 ke `peakR >= 1.0` bar se UPAR hai —
    // matlab EXTREME me Stage-3 window preempt ho jaati hai aur SAFER Stage-4 (+0.65R floor)
    // seedha le leta hai (zyada profit jaldi lock — monotonic protection intact).
    const s4 = evaluateActiveTradeDeepMonitor(dmTrade({ peakPrice: 101.05, ...wide }), { ltp: 101.05, boardRow: brd });
    expect(s4.stageCode).toBe('STAGE_4_TP1_LOCKED');
    expect(s4.trailedStopLoss).toBeGreaterThanOrEqual(100.65 - 1e-9); // +0.65R floor
  });
  it('NO ATR data → NORMAL default (0.22 Early / 0.35 S1 / 0.55 S2)', () => {
    expect(evaluateActiveTradeDeepMonitor(dmTrade({ peakPrice: 100.21 }), { ltp: 100.21 }).stageCode).toBe('STAGE_0_INITIAL_GUARD');
    expect(evaluateActiveTradeDeepMonitor(dmTrade({ peakPrice: 100.23 }), { ltp: 100.23 }).stageCode).toBe('STAGE_1_EARLY_SHIELD');
    expect(evaluateActiveTradeDeepMonitor(dmTrade({ peakPrice: 100.36 }), { ltp: 100.36 }).stageCode).toBe('STAGE_1_RISK_HALVED');
    expect(evaluateActiveTradeDeepMonitor(dmTrade({ peakPrice: 100.56 }), { ltp: 100.56 }).stageCode).toBe('STAGE_2_BREAKEVEN_PLUS');
  });
  it('entry-stamped trade.atrPct bhi vol class resolve karta hai (3s fast loop w/o boardRow)', () => {
    const ev = evaluateActiveTradeDeepMonitor(dmTrade({ peakPrice: 100.95, atrPct: 2.5 }), { ltp: 100.95 });
    expect(ev.stageCode).toBe('STAGE_3_PROFIT_RATCHET'); // HIGH: 0.95 >= 0.95
    expect(ev.volClass).toBe(VOL_CLASS.HIGH);
  });
});

describe('v21.23.7 S4 — Stage 5 chandelier volatility-adaptive (engine)', () => {
  it('HIGH vol chandelier = peak − 0.65R (v21.23.6 fixed 0.50R HIGH-vol noise ko maar raha tha)', () => {
    const ev = evaluateActiveTradeDeepMonitor(
      dmTrade({ t1Hit: true, peakPrice: 101.9 }),
      { ltp: 101.9, boardRow: boardVol(2.5) },
    );
    expect(ev.stageCode).toBe('STAGE_5_RUNNER_TO_TP2');
    expect(ev.trailedStopLoss).toBeCloseTo(101.25, 6); // 101.9 − 0.65R
  });
  it('EXTREME vol chandelier = peak − 0.80R (maximum room)', () => {
    const ev = evaluateActiveTradeDeepMonitor(
      dmTrade({ t1Hit: true, peakPrice: 101.9 }),
      { ltp: 101.9, boardRow: boardVol(4.5) },
    );
    expect(ev.trailedStopLoss).toBeCloseTo(101.10, 6); // 101.9 − 0.80R
  });
  it('LOW vol chandelier = peak − 0.45R (v21.23.6 se tighter)', () => {
    const ev = evaluateActiveTradeDeepMonitor(
      dmTrade({ t1Hit: true, peakPrice: 101.9 }),
      { ltp: 101.9, boardRow: boardVol(0.5) },
    );
    expect(ev.trailedStopLoss).toBeCloseTo(101.45, 6); // 101.9 − 0.45R
  });
  it('TP1 floor har vol class me intact (chandelier kabhi TP1 ke neeche nahi jaata)', () => {
    for (const atr of [0.5, 1.0, 2.5, 4.0]) {
      const ev = evaluateActiveTradeDeepMonitor(
        dmTrade({ t1Hit: true, peakPrice: 101.6 }),
        { ltp: 101.6, boardRow: boardVol(atr) },
      );
      expect(ev.trailedStopLoss).toBeGreaterThanOrEqual(101 - 1e-9); // >= TP1
    }
  });
});

// ============================================================
// S5 — PULLBACK GIVEBACK TOLERANCE MATRIX (per class)
// ============================================================
describe('v21.23.7 S5 — vol-adaptive pullback giveback tolerance', () => {
  it('HIGH vol: peak 1.2R → pull 0.70R (42% giveback) → HOLD — SL floor +0.65R (Stage-4 HIGH lock) upar hai', () => {
    const ev = evaluateActiveTradeDeepMonitor(
      dmTrade({ peakPrice: 101.2 }),
      { ltp: 100.70, boardRow: boardVol(2.5) },
    );
    expect(ev.shouldBookProfitNow).toBe(false);
    expect(ev.shouldClose).toBe(false);
  });
  it('SAME move NORMAL vol me Stage-4 lock 0.75R pe SL HIT → BOOK at +0.70R — HIGH-vol tolerance ka measurable delta', () => {
    const ev = evaluateActiveTradeDeepMonitor(
      dmTrade({ peakPrice: 101.2 }),
      { ltp: 100.70 }, // no boardRow → NORMAL default
    );
    expect(ev.shouldBookProfitNow).toBe(true);
    expect(ev.exitReason).toBe('TRAILED_SL_PROFIT_BOOKED');
  });
  it('EXTREME vol: peak 1.2R → pull 0.70R → HOLD (65% ratio bar bahut upar)', () => {
    const ev = evaluateActiveTradeDeepMonitor(
      dmTrade({ peakPrice: 101.2 }),
      { ltp: 100.70, boardRow: boardVol(4.2) },
    );
    expect(ev.shouldBookProfitNow).toBe(false);
  });
  it('HIGH vol: peak 0.8R → pull 0.35R (56% AND 0.45R abs ≥ 0.38R floor) → DEEP giveback → BOOK', () => {
    const ev = evaluateActiveTradeDeepMonitor(
      dmTrade({ peakPrice: 100.8 }),
      { ltp: 100.35, boardRow: boardVol(2.5) },
    );
    expect(ev.shouldBookProfitNow).toBe(true);
  });
  it('LOW vol: 42% + 0.25R tighter tolerance (v21.23.6 se tighter — dhang ke pullbacks me jaldi book)', () => {
    // peak 1.0 → pull 0.74: giveback 0.26R, ratio 26% < 42% → HOLD chhota wiggle
    const hold = evaluateActiveTradeDeepMonitor(
      dmTrade({ peakPrice: 101.0 }),
      { ltp: 100.74, boardRow: boardVol(0.5) },
    );
    expect(hold.shouldBookProfitNow).toBe(false);
    // peak 1.0 → pull 0.57: giveback 0.43R, ratio 43% ≥ 42% AND 0.43 ≥ 0.25 → BOOK
    const book = evaluateActiveTradeDeepMonitor(
      dmTrade({ peakPrice: 101.0 }),
      { ltp: 100.57, boardRow: boardVol(0.5) },
    );
    expect(book.shouldBookProfitNow).toBe(true);
  });
});

// ============================================================
// S6 — REVERSAL-RISK HINT LOCK (spec item 5: HIGH/EXTREME me wider)
// ============================================================
describe('v21.23.7 S6 — reversal-risk hint profit-lock vol-aware', () => {
  const hintRow = (atrPct) => boardVol(atrPct, null, { context: { atrPct, exhausted: true } });
  it('NORMAL vol peak 0.8R hint lock = peak − 0.50R → +0.30R (v21.23.6-identical; stage-2 lock +0.29R ko hint override karta hai)', () => {
    const ev = evaluateActiveTradeDeepMonitor(
      dmTrade({ peakPrice: 100.8 }),
      { ltp: 100.8, boardRow: hintRow(1.0) },
    );
    expect(ev.trailedStopLoss).toBeCloseTo(100.30, 6); // hint lock = max(0.15, 0.8 − 0.50)
    expect(ev.shouldBookProfitNow).toBe(false); // hint book NAHI karta (v21.23.6 contract)
    expect(ev.stageLabel).toContain('Reversal-Risk Profit-Lock');
  });
  it('HIGH vol peak 0.8R hint giveback WIDER (0.65R) → hint lock sirf +0.15R — stage-2 lock (+0.29R) hi final SL (volatile me hint zyada room deta hai)', () => {
    const ev = evaluateActiveTradeDeepMonitor(
      dmTrade({ peakPrice: 100.8 }),
      { ltp: 100.8, boardRow: hintRow(2.5) },
    );
    expect(ev.trailedStopLoss).toBeCloseTo(100.29, 6); // stage-2 ratchet dominates; hint 100.15 neeche tha
    expect(ev.shouldBookProfitNow).toBe(false);
  });
});

// ============================================================
// S7 — C4 MOMENTUM-AWARE ACCELERATION
// ============================================================
describe('v21.23.7 S7 — momentum-aware trail (SURGING widens / FADING tightens)', () => {
  const surgeTrig = { roc1: 0.08, roc3: 0.32, volRatio: 1.2 };
  const fadeTrig = { roc1: -0.06, roc3: 0.02, volRatio: 0.5 };
  it('momentumStateOf: side-aware SURGING / FADING / STEADY / UNKNOWN', () => {
    expect(momentumStateOf('LONG', { trigger: surgeTrig })).toBe(MOMENTUM.SURGING);
    expect(momentumStateOf('SHORT', { trigger: { roc1: -0.08, roc3: -0.32, volRatio: 1.2 } })).toBe(MOMENTUM.SURGING);
    expect(momentumStateOf('LONG', { trigger: fadeTrig })).toBe(MOMENTUM.FADING);
    expect(momentumStateOf('LONG', { trigger: { roc1: 0.01, roc3: 0.05, volRatio: 1.0 } })).toBe(MOMENTUM.STEADY);
    expect(momentumStateOf('LONG', null)).toBe(MOMENTUM.UNKNOWN);
    expect(momentumStateOf('LONG', {})).toBe(MOMENTUM.UNKNOWN);
  });
  it('SURGING: Stage-5 chandelier NORMAL 0.50R → 0.57R (fast move ko room — trend RIDE ho)', () => {
    const base = applyMomentum(trailProfileFor(VOL_CLASS.NORMAL), MOMENTUM.SURGING);
    expect(base.stage5ChandelierR).toBeCloseTo(0.57, 2); // 0.50 × 1.15 = 0.575 → 2dp round
    expect(base.stage4GivebackR).toBeCloseTo(0.55, 2);  // 0.45 + 0.10
    expect(base.hintGivebackR).toBeCloseTo(0.65, 2);    // 0.50 + 0.15
  });
  it('FADING: chandelier tighten 0.50R → 0.43R + hint lock JALDI (0.50 → 0.35 clamp 0.40)', () => {
    const f = applyMomentum(trailProfileFor(VOL_CLASS.NORMAL), MOMENTUM.FADING);
    expect(f.stage5ChandelierR).toBeCloseTo(0.43, 2);  // 0.50 × 0.85
    expect(f.hintGivebackR).toBeCloseTo(0.40, 2);      // 0.50 − 0.15 → clamped 0.40
  });
  it('momentum multipliers clamped: EXTREME+SURGING chandelier 0.92 ≤ 1.00; LOW+FADING 0.38 → 0.40 floor', () => {
    const es = applyMomentum(trailProfileFor(VOL_CLASS.EXTREME), MOMENTUM.SURGING);
    expect(es.stage5ChandelierR).toBeCloseTo(0.92, 2);
    expect(es.stage5ChandelierR).toBeLessThanOrEqual(1.00);
    const lf = applyMomentum(trailProfileFor(VOL_CLASS.LOW), MOMENTUM.FADING);
    expect(lf.stage5ChandelierR).toBeCloseTo(0.40, 2); // 0.45×0.85=0.38 → clamp 0.40
  });
  it('engine: SURGING LONG board (roc/vol in-direction) Stage-5 trail = peak − 0.57R (STEADY se WIDER)', () => {
    const steady = evaluateActiveTradeDeepMonitor(
      dmTrade({ t1Hit: true, peakPrice: 101.6 }),
      { ltp: 101.6, boardRow: boardVol(1.0) },
    );
    const surging = evaluateActiveTradeDeepMonitor(
      dmTrade({ t1Hit: true, peakPrice: 101.6 }),
      { ltp: 101.6, boardRow: boardVol(1.0, surgeTrig) },
    );
    expect(steady.trailedStopLoss).toBeCloseTo(101.10, 6);  // peak − 0.50R
    expect(surging.trailedStopLoss).toBeCloseTo(101.03, 6); // peak − 0.57R
    expect(surging.trailedStopLoss).toBeLessThan(steady.trailedStopLoss); // room ZYADA
    expect(surging.momentumState).toBe(MOMENTUM.SURGING);
  });
  it('engine: FADING SHORT board — trail TIGHTER (profit lock karo, move khatam)', () => {
    const shortTrade = {
      ...dmTrade(), side: 'SHORT', stopLoss: 101, initialStopLoss: 101,
      t1: 99, t2: 98, t1Hit: true, peakPrice: 98.4,
    };
    const steady = evaluateActiveTradeDeepMonitor(shortTrade, { ltp: 98.4, boardRow: boardVol(1.0, { roc1: 0, roc3: 0, volRatio: 1 }) });
    const fading = evaluateActiveTradeDeepMonitor(shortTrade, { ltp: 98.4, boardRow: boardVol(1.0, { roc1: 0.06, roc3: 0.02, volRatio: 0.5 }) });
    expect(steady.trailedStopLoss).toBeCloseTo(98.90, 6);  // peak + 0.50R
    expect(fading.trailedStopLoss).toBeCloseTo(98.83, 6);  // peak + 0.43R — SHORT me TIGHT = neeche
    expect(fading.momentumState).toBe(MOMENTUM.FADING);
  });
});

// ============================================================
// S8 — MONOTONIC RATCHET ACROSS VOL-CLASS SWITCH
// ============================================================
describe('v21.23.7 S8 — monotonic ratchet: LIVE vol-class switch SL kabhi LOOSE nahi karta', () => {
  it('LOW-vol trail ke baad board HIGH-vol ho gaya → SL ratchet pehle jaisa tight ya zyada (never looser)', () => {
    // Step 1: LOW vol, peak 0.55R → Stage 2 lock
    let carried = dmTrade();
    const lowEv = evaluateActiveTradeDeepMonitor(carried, { ltp: 100.55, boardRow: boardVol(0.5) });
    expect(lowEv.stageCode).toBe('STAGE_2_BREAKEVEN_PLUS');
    const lockedLow = lowEv.trailedStopLoss;
    expect(lockedLow).toBeGreaterThan(100);
    carried = { ...carried, stopLoss: lockedLow, trailedStopLoss: lockedLow, peakPrice: 100.55 };
    // Step 2: SAME trade ab HIGH-vol board dekhta hai (regime shift) — pullback me
    const highEv = evaluateActiveTradeDeepMonitor(carried, { ltp: 100.52, boardRow: boardVol(2.5) });
    expect(highEv.trailedStopLoss).toBeGreaterThanOrEqual(lockedLow - 1e-9);
    // Step 3: EXTREME switch bhi loose nahi
    carried = { ...carried, stopLoss: highEv.trailedStopLoss, trailedStopLoss: highEv.trailedStopLoss };
    const extEv = evaluateActiveTradeDeepMonitor(carried, { ltp: 100.50, boardRow: boardVol(4.2) });
    expect(extEv.trailedStopLoss).toBeGreaterThanOrEqual(highEv.trailedStopLoss - 1e-9);
  });
  it('vol telemetry return hota hai (UI + 3s loop stamps ke liye)', () => {
    const ev = evaluateActiveTradeDeepMonitor(dmTrade(), { ltp: 100.2, boardRow: boardVol(2.5, { roc1: 0.08, roc3: 0.3, volRatio: 1.1 }) });
    expect(ev.volClass).toBe(VOL_CLASS.HIGH);
    expect(ev.momentumState).toBe(MOMENTUM.SURGING);
    expect(ev.atrPct).toBeCloseTo(2.5, 4);
    expect(ev.t1ClosePct).toBe(0.40);
  });
});

// ============================================================
// S9 — TP1 PARTIAL BOOK VOL-AWARE (paper engine)
// ============================================================
describe('v21.23.7 S9 — paper engine TP1 partial: t1ClosePct', () => {
  beforeEach(() => { _resetForTests(); });

  it('default 50% (koi stamp nahi) — v21.23.6-identical fractional book', () => {
    openPaperTrade({ symbol: 'BTC', direction: 'LONG', entry: 100, qty: 0.01, stopLoss: 99, target1: 101, target2: 102, market: 'FUTURES' });
    const events = [];
    evaluatePaper({ BTC: { price: 101.2 } }, events);
    const t = getPaperSummary().open[0];
    expect(t.status).toBe('PARTIAL');
    expect(t.parts[0].qty).toBeCloseTo(0.005, 6);
  });
  it('HIGH vol stamp 0.40 → TP1 pe 40% book, 60% runner (bada trend runner)', () => {
    openPaperTrade({ symbol: 'BTC', direction: 'LONG', entry: 100, qty: 0.01, stopLoss: 99, target1: 101, target2: 102, market: 'FUTURES', t1ClosePct: 0.40, atrPct: 2.5 });
    const events = [];
    evaluatePaper({ BTC: { price: 101.2 } }, events);
    const t = getPaperSummary().open[0];
    expect(t.status).toBe('PARTIAL');
    expect(t.parts[0].qty).toBeCloseTo(0.004, 6);
    expect(t.remainingQty).toBeCloseTo(0.006, 6);
    expect(t.t1ClosePct).toBe(0.40);
    expect(t.atrPct).toBe(2.5);
  });
  it('EXTREME vol stamp 0.35 → sabse bada runner', () => {
    openPaperTrade({ symbol: 'BTC', direction: 'LONG', entry: 100, qty: 0.02, stopLoss: 99, target1: 101, target2: 102, market: 'FUTURES', t1ClosePct: 0.35 });
    const events = [];
    evaluatePaper({ BTC: { price: 101.2 } }, events);
    const t = getPaperSummary().open[0];
    expect(t.parts[0].qty).toBeCloseTo(0.007, 6); // 0.02 × 0.35
  });
  it('INDIA desk integer ceil: qty 10 × 0.40 → 4 lots book', () => {
    openPaperTrade({ symbol: 'SBIN', direction: 'LONG', entry: 800, qty: 10, stopLoss: 780, target1: 820, target2: 850, market: 'INDIA', t1ClosePct: 0.40 });
    const events = [];
    evaluatePaper({ SBIN: { price: 822 } }, events);
    const t = getPaperSummary().open[0];
    expect(t.status).toBe('PARTIAL');
    expect(t.parts[0].qty).toBe(4);
  });
  it('unsplittable 1-lot (0.40 × 1 → ceil 1 == remaining) → BE-protect (v21.0.6 contract intact)', () => {
    openPaperTrade({ symbol: 'SBIN', direction: 'LONG', entry: 800, qty: 1, stopLoss: 780, target1: 820, target2: 850, market: 'INDIA', t1ClosePct: 0.40 });
    const events = [];
    evaluatePaper({ SBIN: { price: 822 } }, events);
    const t = getPaperSummary().open[0];
    expect(t.status).toBe('OPEN');
    expect(t.stopLoss).toBe(800); // BE lock
  });
  it('updatePaperTradeT1ClosePct: pre-T1 update OK · post-T1 frozen · invalid pct reject', () => {
    const r = openPaperTrade({ symbol: 'BTC', direction: 'LONG', entry: 100, qty: 0.01, stopLoss: 99, target1: 101, target2: 102, market: 'FUTURES' });
    const id = r.trade.id;
    expect(updatePaperTradeT1ClosePct(id, 0.35).ok).toBe(true);
    expect(getPaperSummary().open[0].t1ClosePct).toBe(0.35);
    expect(updatePaperTradeT1ClosePct(id, 0.99).ok).toBe(false); // out of clamp
    expect(updatePaperTradeT1ClosePct(id, 0.01).ok).toBe(false);
    // TP1 book hone ke BAAD frozen
    evaluatePaper({ BTC: { price: 101.2 } }, []);
    const after = updatePaperTradeT1ClosePct(id, 0.40);
    expect(after.ok).toBe(false);
  });
});

// ============================================================
// S9b — mtfAutoTick ENTRY-STAMP wiring (HIGH-vol row → 0.40 partial stamp)
// ============================================================
describe('v21.23.7 S9b — mtfAutoTick entry stamps vol class + t1ClosePct', () => {
  beforeEach(() => { __resetMtfAutoForTests(); });

  function fakePaper() {
    const calls = { opened: [] };
    const paper = {
      open: [],
      openPaperTrade: vi.fn((input) => {
        calls.opened.push(input);
        const trade = { id: 900 + calls.opened.length, ...input };
        paper.open.push({ id: trade.id, symbol: input.symbol, market: input.market, status: 'OPEN', direction: input.direction, openedAt: NOW, t1ClosePct: input.t1ClosePct });
        return { ok: true, trade };
      }),
      closePaperTrade: vi.fn(() => ({ ok: true, trade: { realizedPnl: 1 } })),
      getPaperSummary: vi.fn(() => ({ open: paper.open })),
    };
    return { paper, calls };
  }
  function boardHighVol() {
    return {
      ok: true, market: 'CRYPTO', mode: 'INTRADAY', holdMin: 45, minScore: 75,
      rows: [{
        ok: true, symbol: 'BTCUSDT', market: 'CRYPTO', mode: 'INTRADAY', label: '15m → 5m', holdMin: 45,
        superScore: 85, tier: 'ELITE', side: 'LONG', dir: 1, grade: 'A',
        triggerFired: true, dualAligned: true, counterTrend: false, tfFit: 'OK',
        autoEligible: true, autoBlockers: [],
        plan: { entry: 100, stopLoss: 99, t1: 101, t2: 102 },
        context: { atrPct: 2.2, dir: 1 },
        drivers: ['x'],
      }],
    };
  }
  function tickP(paper, over = {}) {
    return {
      boards: { CRYPTO: boardHighVol() },
      paper,
      quotes: {},
      usdtQuotes: new Map([['BTC', 100.25]]),
      walletEquityINR: 10000,
      fx: 94.95,
      now: NOW,
      ...over,
    };
  }

  it('HIGH-vol (ATR 2.2%) ELITE row → openPaperTrade me t1ClosePct 0.40 + atrPct stamp', async () => {
    __resetMtfAutoForTests({ config: { enabled: true, executionMode: 'paper', minScore: 75 } });
    const { paper, calls } = fakePaper();
    const out = await mtfAutoTick(tickP(paper));
    expect(out.opened).toHaveLength(1);
    expect(paper.openPaperTrade).toHaveBeenCalledTimes(1);
    expect(calls.opened[0].t1ClosePct).toBe(0.40);   // HIGH vol — runner bada
    expect(calls.opened[0].atrPct).toBe(2.2);
  });
});

// ============================================================
// S10 — DEEP-MONITOR 15s TICK VOL STAMPS + TP1 PCT LIVE-SYNC (source pins)
// ============================================================
describe('v21.23.7 S10 — deep monitor stamps + live-sync wiring (source pins)', () => {
  it('15s tick b.atrPct/b.volClass/b.momentumState/b.t1ClosePct stamps', () => {
    expect(LINK_SRC).toContain('b.atrPct = deepEval.atrPct ?? b.atrPct ?? null');
    expect(LINK_SRC).toContain('b.volClass = deepEval.volClass || b.volClass || null');
    expect(LINK_SRC).toContain('b.momentumState = deepEval.momentumState || b.momentumState || null');
    expect(LINK_SRC).toContain('b.t1ClosePct = deepEval.t1ClosePct || b.t1ClosePct || 0.5');
  });
  it('TP1 se pehle vol-class shift → paper engine partial % live-update (guarded)', () => {
    expect(LINK_SRC).toContain('deepEval.tp1Hit !== true && livePaper?.id != null');
    expect(LINK_SRC).toContain('paper.updatePaperTradeT1ClosePct(livePaper.id, deepEval.t1ClosePct)');
  });
  it('entry-stamp: vol class + t1ClosePct open path me', () => {
    expect(LINK_SRC).toContain('t1ClosePct: entryT1ClosePct');
    expect(LINK_SRC).toContain('const entryVolClass = entryAtrPct != null ? classifyVolatility(entryAtrPct)');
    expect(LINK_SRC).toContain('volClass: entryVolClass');
  });
});

// ============================================================
// S11 — WS ⚠ 1 DOWN FALSE-POSITIVE FIX (the CoinDCX tab permanent red bug)
// ============================================================
describe('v21.23.7 S11 — spot WS honest health (false-DOWN fix)', () => {
  it('cxSpotWs.spotWsStatus: healthy/demandAgeMs/cooldownRemainMs fields exist (healthy derived, not hallucinated)', () => {
    const st = spotWsStatus();
    expect(st).toHaveProperty('healthy');
    expect(st).toHaveProperty('demandAgeMs');
    expect(st).toHaveProperty('cooldownRemainMs');
    expect(typeof st.healthy).toBe('boolean');
    // vitest me enabled=false → healthy=false (honest, aur armed bhi false → IDLE, not DOWN)
    expect(st.healthy).toBe(false);
  });
  it('demand heartbeat track hota hai (armed basis) — spotWsDemand ke baad demandAgeMs finite', () => {
    spotWsDemand();
    const st = spotWsStatus();
    expect(st.demandAgeMs).not.toBeNull();
    expect(Number(st.demandAgeMs)).toBeGreaterThanOrEqual(0);
  });
  it('cxRtStream passthrough: spotWs.healthy + demandAgeMs + cooldownRemainMs (pehle healthy EXIST nahi karta tha)', () => {
    expect(CXRT_SRC).toContain('healthy: spot.healthy === true');
    expect(CXRT_SRC).toContain('demandAgeMs: spot.demandAgeMs ?? null');
    expect(CXRT_SRC).toContain('cooldownRemainMs: spot.cooldownRemainMs ?? 0');
  });
  it('healthMonitor: coindcxSpot armed ab SPOT DEMAND se (fut-domains _cxArmed se NAHI) + honest healthy', () => {
    expect(HM_SRC).toContain('const spotArmed = cx.spotWs.enabled === true');
    expect(HM_SRC).toContain('Number(cx.spotWs.demandAgeMs) <= 120_000');
    expect(HM_SRC).toContain('armed: spotArmed, // demand-driven idle ≠ down');
    expect(HM_SRC).toContain('healthy: cx.spotWs.healthy === true');
    // THE regression pin: spot armed ab kabhi bhi fut-domain _cxArmed se copy nahi hota
    expect(HM_SRC).not.toContain('armed: _cxArmed,\n        failStreak');
  });
  it('cxSpotWs healthy derivation = enabled + connected + fresh book (silent-kill window ke andar)', () => {
    expect(CXSPOT_SRC).toContain('const healthy = _enabled === true && connected === true');
    expect(CXSPOT_SRC).toContain('ageMs != null && ageMs <= SPOT_WS_SILENT_KILL_MS');
  });
});

// ============================================================
// S12 — ULTRA-FAST TREND CAPTURE (10s warm-board entry probe)
// ============================================================
describe('v21.23.7 S12 — ultra-fast trend capture probe (wiring pins)', () => {
  it('10s probe loop exists + warm-board-only (peek 8s) + full-tick escalation', () => {
    expect(ROUTES_SRC).toContain('fastEntryProbeLoop');
    expect(ROUTES_SRC).toContain('const warm = peekDualMtfBoards(8_000)');
    expect(ROUTES_SRC).toContain('await onAutoTradeDeepTick(); // FULL evaluation — har gate andar re-check');
    expect(ROUTES_SRC).toContain('}, 10_000);');
  });
  it('probe SAB entry gates bypass NAHI karta — sirf cheap pre-gates (escalation ke andar re-check)', () => {
    expect(ROUTES_SRC).toContain('if (isLiveSession && openCount >= 1) return;');
    expect(ROUTES_SRC).toContain('if (openCount >= (cfg.maxOpenPositions || 3)) return;');
    expect(ROUTES_SRC).toContain('if (!(cfg?.desks?.india || cfg?.desks?.crypto)) return;');
    expect(ROUTES_SRC).toContain("if (now - _lastProbeEscalateAt < 8_000) return;");
  });
  it('onAutoTradeDeepTick hoisted named const (recheck + probe dono isi se chalte hain)', () => {
    expect(ROUTES_SRC).toContain('const onAutoTradeDeepTick = async () => {');
    expect(ROUTES_SRC).toContain('onAutoTradeDeepTick,\n  });');
  });
  it('paper deps me updatePaperTradeT1ClosePct wired (3 tick call-sites)', () => {
    const occurrences = ROUTES_SRC.split('updatePaperTradeT1ClosePct').length - 1;
    expect(occurrences).toBeGreaterThanOrEqual(3); // import + 3 paper deps objects
  });
  it('paperTrading: t1ClosePct open-stamp + evaluate + restore + live-update export', () => {
    expect(PAPER_SRC).toContain('export function updatePaperTradeT1ClosePct(id, pct)');
    expect(PAPER_SRC).toContain('const t1Pct = Number.isFinite(Number(t.t1ClosePct))');
    expect(PAPER_SRC).toContain("events.push({ type: 'PAPER_CLOSE', symbol: t.symbol, direction: t.direction, price: t.target1, pnl: t.realizedPnl, pnlNet: t.netPnl ?? null, note: `Paper: booked ${Math.round(t1Pct * 100)}% at T1, trail to entry` })");
  });
});

// ============================================================
// CROSS-CUTTING — engine profile source pins (mtfAutoLink consumes profile)
// ============================================================
describe('v21.23.7 — deep monitor profile consumption pins', () => {
  it('har stage threshold + chandelier + giveback + hint profile se (hardcoded GONE)', () => {
    expect(LINK_SRC).toContain("import {\n  trailProfileResolved, tp1ClosePctFor, classifyVolatility,");
    expect(LINK_SRC).toContain('peakR >= profile.stage3R');
    expect(LINK_SRC).toContain('peakR >= profile.stage2R');
    expect(LINK_SRC).toContain('peakR >= profile.stage1R');
    expect(LINK_SRC).toContain('peakR >= profile.stage1EarlyR');
    expect(LINK_SRC).toContain('const beShieldBarR = +(profile.stage1R + 0.12).toFixed(2)');
    expect(LINK_SRC).toContain('Math.max(0.15, +(peakR - profile.hintGivebackR).toFixed(2))');
    // hardcoded v21.23.6 stage constants GONE (profile-driven only):
    expect(LINK_SRC).not.toContain('} else if (peakR >= 0.30) {');
    expect(LINK_SRC).not.toContain('} else if (peakR >= 0.50) {');
    expect(LINK_SRC).not.toContain('} else if (peakR >= 0.80) {');
    expect(LINK_SRC).not.toContain('} else if (peakR >= 0.18) {');
  });
  it('vol telemetry deep-eval return me (3s loop + UI read inhi se)', () => {
    expect(LINK_SRC).toContain('volClass,');
    expect(LINK_SRC).toContain('momentumState,');
    expect(LINK_SRC).toContain('t1ClosePct: profile.tp1ClosePct,');
  });
});

// cleanup temp data dir at end
import { afterAll } from 'vitest';
afterAll(() => { try { fs.rmSync(TMP_DATA, { recursive: true, force: true }); } catch { /* best-effort */ } });
