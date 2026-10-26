// ============================================================
// test/smartTrail21240.test.ts — v21.24.0 SMART TRAIL v2 + ROLLING TP2
// ------------------------------------------------------------
// Locks the contract of server/ai/smartTrail.js and its wiring in
// evaluateActiveTradeDeepMonitor():
//   T1  mode parsing (off | shadow(default) | enforce)
//   T2  tier table interpolation is monotonic
//   T3  LONG/SHORT mirror symmetry of the plan (pure)
//   T4  AVAX replay (live log 2026-10-24): v1 closes on a 0.4R pullback,
//       v2 holds through it
//   T5  SL only ever TIGHTENS under v2 (property test, LONG + SHORT)
//   T6  shadow mode never changes a decision vs off (property test)
//   T7  rolling TP2 — extends near T2 on SURGING/STEADY, never on
//       FADING / reversal hint / after maxExt; shadow only reports it
//   T8  stage-4 label honesty (LIVE has no partial; TP1 pending)
//   T9  paper target2 extender is monotonic + ignores closed trades
//   T10 rolling TP2 integration guards (old target reached / no fresh quote)
//   T11 lightweight open book + TP sync acknowledgement
//   T12 stale-quote TP2 guard on the 3s status path
// ============================================================
import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// @ts-expect-error — plain JS modules
import { smartTrailMode, smartTrailConfig, smartTrailPlan, smartExtendTarget, lockFraction } from '../server/ai/smartTrail.js';
// @ts-expect-error — plain JS module
import {
  evaluateActiveTradeDeepMonitor, __resetMtfAutoForTests,
  mtfAutoOpenCount, mtfAutoOpenRows, markAutoTradeTpSynced,
  getActiveAutoTradesDeepMonitor,
} from '../server/ai/mtfAutoLink.js';
import { openPaperTrade, updatePaperTradeTarget2, closePaperTrade, _resetForTests as _resetPaperForTests } from '../server/intraday/paperTrading.js';

// Keep every stateful helper in this file away from the live runtime book.
const _origDataDir = process.env.MTF_AUTO_DATA_DIR;
const _testDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mtf-auto-v21240-'));
process.env.MTF_AUTO_DATA_DIR = _testDataDir;
afterAll(() => {
  // Never leak the override into later suites (process.env is per worker,
  // not per test file) and never leave a temp book behind.
  if (_origDataDir === undefined) delete process.env.MTF_AUTO_DATA_DIR;
  else process.env.MTF_AUTO_DATA_DIR = _origDataDir;
  try { fs.rmSync(_testDataDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

const ENV_KEY = 'SMART_TRAIL_V2';
const SMART_ENV_KEYS = [
  ENV_KEY, 'SMART_TRAIL_TP_EXTEND', 'SMART_TRAIL_NOISE_K',
  'SMART_TRAIL_NOISE_FLOOR_R', 'SMART_TRAIL_NOISE_CAP_R', 'SMART_TRAIL_ACTIVATION_R',
  'SMART_TRAIL_EXT_STEP_R', 'SMART_TRAIL_MAX_EXT', 'SMART_TRAIL_EXT_APPROACH_R',
];
let _savedEnv: Record<string, string | undefined> = {};
beforeEach(() => {
  _savedEnv = {};
  for (const k of SMART_ENV_KEYS) {
    _savedEnv[k] = process.env[k];
    delete process.env[k]; // start every case from the documented defaults
  }
});
afterEach(() => {
  for (const k of SMART_ENV_KEYS) {
    if (_savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = _savedEnv[k];
  }
});
const setMode = (m: string | null) => { if (m == null) delete process.env[ENV_KEY]; else process.env[ENV_KEY] = m; };

let seed = 424242;
const rnd = () => (seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296;

function longTrade(over: Record<string, unknown> = {}) {
  return {
    symbol: 'BTCUSDT', market: 'FUTURES', execMarket: 'FUTURES', ccy: 'USDT', side: 'LONG',
    entry: 100, entryPrice: 100, stopLoss: 99, initialStopLoss: 99, t1: 101, t2: 102, qty: 1,
    peakPrice: 100, openedAt: Date.now() - 600_000, atrPct: 0.45,
    // v21.26.1: legacy v1/v2 stage-engine coverage (pro defaults ON in prod).
    proExitPolicy: false,
    ...over,
  };
}
const surgingLong = { trigger: { roc1: 0.2, roc3: 0.6, volRatio: 1.6 }, context: { atrPct: 0.45 } };
const fadingLong = { trigger: { roc1: -0.2, roc3: -0.3, volRatio: 0.6 }, context: { atrPct: 0.45 } };

describe('T1 smartTrailMode', () => {
  it('default / garbage = shadow; explicit values honoured', () => {
    expect(smartTrailMode({})).toBe('shadow');
    expect(smartTrailMode({ SMART_TRAIL_V2: 'banana' })).toBe('shadow');
    expect(smartTrailMode({ SMART_TRAIL_V2: 'OFF' })).toBe('off');
    expect(smartTrailMode({ SMART_TRAIL_V2: '0' })).toBe('off');
    expect(smartTrailMode({ SMART_TRAIL_V2: 'enforce' })).toBe('enforce');
    expect(smartTrailMode({ SMART_TRAIL_V2: 'on' })).toBe('enforce');
  });
});

describe('T2 lockFraction tiers', () => {
  it('0 below activation, monotonic non-decreasing, capped at last tier', () => {
    const t = smartTrailConfig().tiers;
    expect(lockFraction(0.5, t)).toBe(0);
    let prev = 0;
    for (let p = 1.0; p <= 8; p += 0.1) {
      const f = lockFraction(p, t);
      expect(f).toBeGreaterThanOrEqual(prev - 1e-12);
      prev = f;
    }
    expect(lockFraction(50, t)).toBe(t[t.length - 1][1]);
  });
});

describe('T3 mirror symmetry (pure plan)', () => {
  it('LONG and mirrored SHORT get the same lockR / noiseR', () => {
    const cfg = smartTrailConfig({});
    for (let i = 0; i < 300; i++) {
      const risk = 0.5 + rnd();
      const peakR = 0.2 + rnd() * 6;
      const atrPct = 0.1 + rnd() * 1.5;
      const mom = ['SURGING', 'STEADY', 'FADING', 'UNKNOWN'][Math.floor(rnd() * 4)];
      const hint = rnd() < 0.3;
      const entryL = 100;
      const L = smartTrailPlan({ isLong: true, entry: entryL, risk, peakPrice: entryL + peakR * risk, ltp: entryL + peakR * risk, atrPct, momentum: mom, feeFloor: entryL * 1.0011, peakCoveredFee: true, tp1Touched: peakR > 1.2, t1: entryL + risk, reversalRiskHint: hint }, cfg);
      // Mirror in PRICE units: ATR% is a % of the price level, and a mirrored SHORT peaks at a different
      // level than the LONG — scale the % so both see the SAME ATR in price terms.
      const peakL = entryL + peakR * risk, peakS = entryL - peakR * risk;
      const S = smartTrailPlan({ isLong: false, entry: entryL, risk, peakPrice: peakS, ltp: peakS, atrPct: atrPct * (peakL / peakS), momentum: mom, feeFloor: entryL * 0.9989, peakCoveredFee: true, tp1Touched: peakR > 1.2, t1: entryL - risk, reversalRiskHint: hint }, cfg);
      expect(S.active).toBe(L.active);
      if (L.active) {
        expect(Math.abs(S.lockR - L.lockR)).toBeLessThan(0.03);
        expect(Math.abs(S.noiseR - L.noiseR)).toBeLessThan(0.02);
      }
    }
  });
});

describe('T4 AVAX replay — live log 2026-10-24 (SHORT, R=0.026, peak 9.034 → bounce 9.0445)', () => {
  const avax = (over: Record<string, unknown> = {}) => ({
    symbol: 'AVAXUSDT', market: 'FUTURES', execMarket: 'FUTURES', ccy: 'USDT', side: 'SHORT', executionMode: 'LIVE',
    entry: 9.064, entryPrice: 9.064, stopLoss: 9.09, initialStopLoss: 9.09, t1: 9.02, t2: 8.92, qty: 13,
    leverage: 10, peakPrice: 9.064, openedAt: Date.now() - 600_000, atrPct: 0.45,
    proExitPolicy: false,
    ...over,
  });
  function run(mode: string) {
    setMode(mode);
    let tr: any = avax();
    const step = (ltp: number) => {
      const ev = evaluateActiveTradeDeepMonitor(tr, { ltp });
      tr = { ...tr, peakPrice: ev.peakPrice, stopLoss: ev.trailedStopLoss, trailedStopLoss: ev.trailedStopLoss, t1Hit: tr.t1Hit || ev.tp1Hit, t2: ev.t2, t2Extensions: ev.t2Extensions };
      return ev;
    };
    step(9.034);                  // peak ≈ +1.15R
    return step(9.0445);          // bounce ≈ +0.77R
  }
  it('v1 (off) books the whole position on the bounce — exactly the live outcome', () => {
    const ev = run('off');
    expect(ev.shouldClose).toBe(true);
    expect(ev.exitReason).toBe('TRAILED_SL_PROFIT_BOOKED');
    expect(ev.smartTrail).toBeNull();
  });
  it('v2 (enforce) holds through that pullback and keeps a fee-safe lock', () => {
    const ev = run('enforce');
    expect(ev.shouldClose).toBe(false);
    expect(ev.trailEngine).toBe('v2');
    // SHORT: SL must stay ABOVE price and BELOW entry (profit locked), never at entry+
    expect(ev.trailedStopLoss).toBeGreaterThan(9.0445);
    expect(ev.trailedStopLoss).toBeLessThan(9.064);
  });
  it('shadow reports the v2 SL but v1 still decides', () => {
    const ev = run('shadow');
    expect(ev.shouldClose).toBe(true);
    expect(ev.smartTrail).toBeTruthy();
    expect(ev.smartTrail.mode).toBe('shadow');
    expect(ev.smartTrail.slPrice).toBeGreaterThan(9.0445);
  });
});

describe('T5 SL only tightens under v2 (property)', () => {
  for (const side of ['LONG', 'SHORT'] as const) {
    it(`${side}: random paths — trailed SL monotonic, never past the peak, never below initial SL`, () => {
      setMode('enforce');
      const isLong = side === 'LONG';
      for (let run = 0; run < 150; run++) {
        const sign = isLong ? 1 : -1;
        let tr: any = isLong
          ? longTrade()
          : { ...longTrade(), side: 'SHORT', stopLoss: 101, initialStopLoss: 101, t1: 99, t2: 98 };
        let px = 100, lastSl = tr.stopLoss;
        const drift = (rnd() - 0.35) * 0.25;
        for (let k = 0; k < 120; k++) {
          px += sign * (drift + (rnd() - 0.5) * 0.7);
          const ev = evaluateActiveTradeDeepMonitor(tr, { ltp: px, boardRow: rnd() < 0.5 ? surgingLong : null });
          if (isLong) { expect(ev.trailedStopLoss).toBeGreaterThanOrEqual(lastSl - 1e-9); }
          else { expect(ev.trailedStopLoss).toBeLessThanOrEqual(lastSl + 1e-9); }
          lastSl = ev.trailedStopLoss;
          if (ev.shouldClose) break;
          tr = { ...tr, peakPrice: ev.peakPrice, stopLoss: ev.trailedStopLoss, trailedStopLoss: ev.trailedStopLoss, t1Hit: tr.t1Hit || ev.tp1Hit, t2: ev.t2, t2Extensions: ev.t2Extensions };
        }
      }
    });
  }
});

describe('T6 shadow never changes a decision vs off (property)', () => {
  it('trailedStopLoss / shouldClose / exitReason identical for 400 random states', () => {
    for (let i = 0; i < 400; i++) {
      const isLong = rnd() < 0.5;
      const entry = 100;
      const risk = 0.4 + rnd() * 1.2;
      const base: any = isLong
        ? longTrade({ stopLoss: entry - risk, initialStopLoss: entry - risk, t1: entry + risk, t2: entry + 2 * risk, atrPct: 0.1 + rnd() * 1.5 })
        : { ...longTrade({ atrPct: 0.1 + rnd() * 1.5 }), side: 'SHORT', stopLoss: entry + risk, initialStopLoss: entry + risk, t1: entry - risk, t2: entry - 2 * risk };
      const peakMove = rnd() * 4 * risk;
      base.peakPrice = isLong ? entry + peakMove : entry - peakMove;
      base.t1Hit = rnd() < 0.3;
      const ltp = isLong ? entry + peakMove * rnd() : entry - peakMove * rnd();
      const row = rnd() < 0.5 ? null : (rnd() < 0.5 ? surgingLong : { reversalRisk: true, context: { atrPct: 0.4 } });
      setMode('off');
      const a = evaluateActiveTradeDeepMonitor(base, { ltp, boardRow: row });
      setMode('shadow');
      const b = evaluateActiveTradeDeepMonitor(base, { ltp, boardRow: row });
      expect(b.trailedStopLoss).toBe(a.trailedStopLoss);
      expect(b.shouldClose).toBe(a.shouldClose);
      expect(b.exitReason).toBe(a.exitReason);
      expect(b.t2).toBe(a.t2);
      expect(b.t2Extended).toBe(false);
    }
  });
});

describe('T7 rolling TP2', () => {
  const nearT2 = (over: Record<string, unknown> = {}) => longTrade({ t1Hit: true, peakPrice: 101.8, ...over });
  it('enforce + SURGING + near T2: target pushed +1R, no close', () => {
    setMode('enforce');
    const ev = evaluateActiveTradeDeepMonitor(nearT2(), { ltp: 101.8, boardRow: surgingLong });
    expect(ev.t2Extended).toBe(true);
    expect(ev.t2).toBeCloseTo(103, 6);
    expect(ev.t2Extensions).toBe(1);
    expect(ev.tp2Hit).toBe(false);
    expect(ev.shouldClose).toBe(false);
  });
  it('FADING momentum / reversal hint / not near T2 / T1 not behind us → no extension', () => {
    setMode('enforce');
    expect(evaluateActiveTradeDeepMonitor(nearT2(), { ltp: 101.8, boardRow: fadingLong }).t2Extended).toBe(false);
    expect(evaluateActiveTradeDeepMonitor(nearT2(), { ltp: 101.8, boardRow: { ...surgingLong, reversalRisk: true } }).t2Extended).toBe(false);
    expect(evaluateActiveTradeDeepMonitor(nearT2({ peakPrice: 101.2 }), { ltp: 101.2, boardRow: surgingLong }).t2Extended).toBe(false);
    expect(evaluateActiveTradeDeepMonitor(longTrade({ t1: 101.5, t2: 102, peakPrice: 101.4 }), { ltp: 101.4, boardRow: surgingLong }).t2Extended).toBe(false);
  });
  it('maxExt reached → fixed TP2 closes the position as before', () => {
    setMode('enforce');
    const ev = evaluateActiveTradeDeepMonitor(nearT2({ t2Extensions: 3, peakPrice: 102.1 }), { ltp: 102.1, boardRow: surgingLong });
    expect(ev.t2Extended).toBe(false);
    expect(ev.tp2Hit).toBe(true);
    expect(ev.shouldClose).toBe(true);
  });
  it('shadow only REPORTS wouldExtendT2 — target and decisions untouched', () => {
    setMode('shadow');
    const ev = evaluateActiveTradeDeepMonitor(nearT2({ peakPrice: 102.05 }), { ltp: 102.05, boardRow: surgingLong });
    expect(ev.t2Extended).toBe(false);
    expect(ev.t2).toBe(102);
    expect(ev.smartTrail.wouldExtendT2).toBeCloseTo(103, 6);
    expect(ev.tp2Hit).toBe(true);
  });
  it('SHORT mirror extends downwards', () => {
    setMode('enforce');
    const sh = { ...longTrade({ t1Hit: true }), side: 'SHORT', stopLoss: 101, initialStopLoss: 101, t1: 99, t2: 98, peakPrice: 98.2 };
    const row = { trigger: { roc1: -0.2, roc3: -0.6, volRatio: 1.6 }, context: { atrPct: 0.45 } };
    const ev = evaluateActiveTradeDeepMonitor(sh, { ltp: 98.2, boardRow: row });
    expect(ev.t2Extended).toBe(true);
    expect(ev.t2).toBeCloseTo(97, 6);
  });
  it('pure helper respects disabled flag', () => {
    const cfg = smartTrailConfig({ SMART_TRAIL_TP_EXTEND: 'off' });
    expect(smartExtendTarget({ isLong: true, entry: 100, risk: 1, ltp: 101.9, t1: 101, t2: 102, momentum: 'SURGING', tp1Touched: true, peakR: 1.9 }, cfg)).toBeNull();
  });
});

describe('T8 stage-4 label honesty', () => {
  it('LIVE row at peak ≥1R with TP1 NOT touched never claims "Booked"', () => {
    setMode('off');
    const ev = evaluateActiveTradeDeepMonitor(
      longTrade({ executionMode: 'LIVE', t1: 101.7, t2: 103, peakPrice: 101.1 }), { ltp: 101.1 });
    expect(ev.stageCode).toBe('STAGE_4_TP1_LOCKED');
    expect(ev.stageLabel).toContain('TP1 pending');
    expect(ev.stageLabel).not.toContain('Booked');
  });
  it('LIVE row with TP1 touched says full position / no partial', () => {
    setMode('off');
    const ev = evaluateActiveTradeDeepMonitor(
      longTrade({ executionMode: 'LIVE', t1Hit: true, peakPrice: 101.2 }), { ltp: 101.2 });
    expect(ev.stageLabel).toContain('no partial');
  });
});

describe('T9 paper updatePaperTradeTarget2', () => {
  beforeEach(() => { _resetPaperForTests(); });
  it('SHORT: only moves further down; LONG: only further up; closed trades ignored', () => {
    const s: any = openPaperTrade({ symbol: 'ABC', direction: 'SHORT', entry: 50, qty: 1, stopLoss: 55, target1: 45, target2: 40, market: 'CRYPTO' });
    const sid = (s.trade || s).id;
    expect(updatePaperTradeTarget2(sid, 35).updated).toBe(true);
    expect(updatePaperTradeTarget2(sid, 38).updated).toBe(false);       // toward entry = refused
    const l: any = openPaperTrade({ symbol: 'XYZ', direction: 'LONG', entry: 100, qty: 1, stopLoss: 95, target1: 105, target2: 110, market: 'CRYPTO' });
    const lid = (l.trade || l).id;
    expect(updatePaperTradeTarget2(lid, 120).updated).toBe(true);
    expect(updatePaperTradeTarget2(lid, 115).updated).toBe(false);
    expect(updatePaperTradeTarget2(lid, -1).ok).toBe(false);
    closePaperTrade(lid, { 'CRYPTO|XYZ': { price: 101 }, XYZ: { price: 101 } }, 'TEST');
    expect(updatePaperTradeTarget2(lid, 130).ok).toBe(false);
  });
});

describe('T10 rolling TP2 integration guards', () => {
  const nearT2 = (over: Record<string, unknown> = {}) => longTrade({ t1Hit: true, peakPrice: 101.8, ...over });
  it('enforce never extends after price already reached the OLD target', () => {
    setMode('enforce');
    const ev = evaluateActiveTradeDeepMonitor(nearT2({ peakPrice: 102.05 }), { ltp: 102.05, boardRow: surgingLong });
    // Telemetry still shows what the extender WOULD do, but the live target must not move:
    // the exchange-native TP is already filling at the old level.
    expect(ev.smartTrail.wouldExtendT2).toBeCloseTo(103, 6);
    expect(ev.smartTrail.wouldExtendBeforeTarget).toBe(false);
    expect(ev.t2Extended).toBe(false);
    expect(ev.t2).toBe(102);
    expect(ev.tp2Hit).toBe(true);
  });

  it('allowTpExtension:false (status/preview without fresh quotes) never moves T2', () => {
    setMode('enforce');
    const ev = evaluateActiveTradeDeepMonitor(nearT2(), {
      ltp: 101.8, boardRow: surgingLong, allowTpExtension: false,
    });
    expect(ev.t2Extended).toBe(false);
    expect(ev.t2).toBe(102);
    expect(ev.smartTrail.wouldExtendT2).toBeCloseTo(103, 6);
  });
});

describe('T11 lightweight open book + TP sync acknowledgement', () => {
  const row = (over: Record<string, unknown> = {}) => ({
    status: 'OPEN', symbol: 'BTCUSDT', market: 'CRYPTO', execMarket: 'FUTURES', side: 'LONG',
    executionMode: 'LIVE', traded: true, fullControl: true, paperId: 'P1', t2: 110,
    tpSyncPending: true, ...over,
  });
  beforeEach(() => {
    __resetMtfAutoForTests({
      state: {
        book: [
          row(),
          row({ symbol: 'ETHUSDT', paperId: 'P2', executionMode: 'PAPER', fullControl: false, t2: 200 }),
          row({ symbol: 'XRPUSDT', paperId: 'P3', status: 'CLOSED' }),
          row({ symbol: 'ADAUSDT', paperId: 'P4', traded: false, untradedFallback: true }),
          row({ symbol: 'RELIANCE', market: 'INDIA', execMarket: 'INDIA', paperId: 'P5' }),
        ],
      },
    });
  });

  it('counts only genuinely traded OPEN rows, per market', () => {
    expect(mtfAutoOpenCount()).toBe(3);
    expect(mtfAutoOpenCount('CRYPTO')).toBe(2);
    expect(mtfAutoOpenCount('INDIA')).toBe(1);
    const rows = mtfAutoOpenRows();
    expect(rows).toHaveLength(3);
    expect(rows.map(r => r.symbol).sort()).toEqual(['BTCUSDT', 'ETHUSDT', 'RELIANCE']);
  });

  it('ack clears pending only for the current target; a stale ack is refused', () => {
    const stale = markAutoTradeTpSynced({ paperId: 'P1', t2: 111, exchange: true });
    expect(stale.ok).toBe(false);
    expect(String(stale.error)).toContain('target moved');

    const ok = markAutoTradeTpSynced({ paperId: 'P1', t2: 110, exchange: true });
    expect(ok.ok).toBe(true);
    expect(ok.trade.tpSyncPending).toBe(false);
    expect(ok.trade.lastExchangeTp).toBe(110);

    // Symbol fallback resolves the matching open row (not the first book row).
    const bySym = markAutoTradeTpSynced({ symbol: 'ETHUSDT', t2: 200, exchange: true });
    expect(bySym.ok).toBe(true);
    expect(bySym.trade.symbol).toBe('ETHUSDT');
    expect(bySym.trade.tpSyncPending).toBe(false);
  });
});

describe('T12 stale-quote TP2 guard (3s status path)', () => {
  beforeEach(() => {
    setMode('enforce');
    __resetMtfAutoForTests({
      // v21.26.1: the status path reads the GLOBAL policy config; pin this
      // suite to the legacy engine (PRO default-ON keeps the original TP2).
      config: { proExitPolicy: false },
      state: {
        book: [{
          status: 'OPEN', symbol: 'BTCUSDT', market: 'CRYPTO', execMarket: 'FUTURES', side: 'LONG',
          executionMode: 'PAPER', traded: true, paperId: 'P1', entry: 100, entryPrice: 100,
          stopLoss: 99, initialStopLoss: 99, trailedStopLoss: 99, peakPrice: 101.8, ltp: 101.8,
          t1: 101, t2: 102, t1Hit: true, qty: 1, atrPct: 0.45, momentumState: 'SURGING',
          openedAt: Date.now() - 600_000,
          // v21.26.1: this suite pins the LEGACY rolling-TP2 engine. PRO policy
          // (default ON) intentionally keeps the original TP2, covered in
          // test/proExitPolicy21261.test.ts.
          proExitPolicy: false,
        }],
      },
    });
  });

  it('missing quote = telemetry only; a fresh sane quote extends', () => {
    const stale = getActiveAutoTradesDeepMonitor({});
    expect(stale.trades[0].t2).toBe(102);
    expect(stale.trades[0].t2Extended).toBe(false);
    expect(stale.trades[0].smartTrail.wouldExtendT2).toBeCloseTo(103, 6);

    const fresh = getActiveAutoTradesDeepMonitor({ 'FUTURES|BTCUSDT': { price: 101.8 } });
    expect(fresh.trades[0].t2).toBeCloseTo(103, 6);
    expect(fresh.trades[0].t2Extended).toBe(true);
  });
});
