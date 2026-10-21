// ============================================================
// test/mtfDualBoard.test.ts — v21.16.0 MTF SIGNALS BOARD (DUAL-TF)
// ------------------------------------------------------------
// Pure-function suite: fuseDualTf (superintelligence fuse), the
// auto-link eligibility sift (dualAutoCandidates) aur honest
// degradations. Koi network nahi — sab synthetic inputs.
//
// Guards the USER SPEC:
//   • 75+ ACTION/STRONG rows hi auto-eligible ho sakte hain
//   • counter-trend / MISMATCH rows STRUCTURALLY 75+ cross nahi kar
//     sakte (caps) — auto bar kabhi leak nahi hota
//   • dual-TF confirm (context + trigger + side) bonus deta hai
//   • missing extended-TF data pe weights redistribute hote hain
//     (fake score nahi banta)
// ============================================================
import { describe, it, expect } from 'vitest';
import { fuseDualTf, dualAutoCandidates, mtfProEntryGate, buildEarlyRadar, DUAL_FUSE_WEIGHTS, __clearDualBoardCaches } from '../server/ai/mtfDualBoard.js';

/** A clean, fully-confirmed LONG plan fixture (planner-shaped). */
function planFixture(over = {}) {
  return {
    ok: true, symbol: 'TESTCO', market: 'INDIA', mode: 'INTRADAY',
    side: 'LONG', dir: 1, bias: 'LONG', grade: 'A', confidence: 82,
    alignedWithContext: true, counterTrend: false, triggerFired: true,
    context: { dir: 1, score: 80, trend: 'UP', structure: 'HH-HL', adx: 26, rsi: 58, atrPct: 0.3 },
    trigger: { score: 75, broke: true, volRatio: 1.6, bodyPct: 62, rsi: 57, macdHist: 0.4, overextended: false, patterns: [] },
    plan: { entry: 100, stopLoss: 99.2, t1: 100.8, t2: 101.6, netRR: { t1: 0.8, t2: 1.7 } },
    tfFit: { verdict: 'OK', ratioT1: 1.1, note: 'ok' },
    costs: { costR: 0.15, roundTripPct: 0.08 },
    // v21.23.2: production planner hamesha measured worldIndicators attach
    // karta hai — fixture me bhi (port ke guessed-count era me ye absent tha
    // aur fuse 7/8 FABRICATE karta tha; ab honest null → unverified).
    worldIndicators: {
      alignedCount: 7, totalCount: 8, aligned8Count: 7, total8Count: 8,
      confluencePct: 88, estimatedWinRatePct: 68, directionVerified: true,
      trapVeto: false, zoneWallVeto: false,
    },
    checklist: [], warnings: [], timePlan: {},
    ...over,
  };
}

const snap = { ok: true, consensus: 'BULLISH', agreementPct: 83, phase: 'TREND-ALIGNED', htfBias: 'BULLISH', ltfTrigger: 'BULLISH', timeframes: [] };
const boardSig = { symbol: 'TESTCO', side: 'LONG', superIntel: { aiScore: 78, tier: 'ACTION' }, grade: 'ACTION', confidence: 72 };

describe('fuseDualTf — superintelligence fuse', () => {
  it('a fully confirmed row scores STRONG/ELITE and is auto-eligible', () => {
    const f = fuseDualTf({ symbol: 'TESTCO', market: 'INDIA', boardSig, plan: planFixture(), snap, modeId: 'INTRADAY' });
    expect(f.superScore).toBeGreaterThanOrEqual(75);
    expect(['STRONG', 'ELITE', 'ACTION']).toContain(f.tier);
    expect(f.autoEligible).toBe(true);
    expect(f.autoBlockers).toEqual([]);
    expect(f.dualAligned).toBe(true);
    expect(f.drivers.some(d => d.includes('dual-TF confirm'))).toBe(true);
  });

  it('counter-trend side is capped at 74 — auto bar structurally blocked', () => {
    const p = planFixture({ side: 'SHORT', dir: -1, counterTrend: true, bias: 'SHORT', alignedWithContext: false });
    const f = fuseDualTf({ symbol: 'X', market: 'INDIA', boardSig, plan: p, snap, modeId: 'INTRADAY' });
    expect(f.superScore).toBeLessThanOrEqual(DUAL_FUSE_WEIGHTS.caps.counterTrend);
    expect(f.autoEligible).toBe(false);
    expect(f.autoBlockers).toContain('counter-trend');
    expect(f.gates.some(g => g.includes('counter-trend'))).toBe(true);
  });

  it('counter-HTF (1d+4h bias against side) hard-vetoes auto + direction verification', () => {
    const bearSnap = { ...snap, consensus: 'BEARISH', htfBias: 'BEARISH' };
    const f = fuseDualTf({ symbol: 'TESTCO', market: 'INDIA', boardSig, plan: planFixture(), snap: bearSnap, modeId: 'INTRADAY' });
    expect(f.counterHtf).toBe(true);
    expect(f.htfBias).toBe('BEARISH');
    expect(f.superScore).toBeLessThanOrEqual(58);
    expect(f.directionVerified).toBe(false);
    expect(f.autoEligible).toBe(false);
    expect(f.autoBlockers.some(b => b.includes('counter-HTF'))).toBe(true);
    expect(f.gates.some(g => g.includes('counter-HTF'))).toBe(true);
  });

  it('aligned HTF bias does NOT trip the counter-HTF gate', () => {
    const f = fuseDualTf({ symbol: 'TESTCO', market: 'INDIA', boardSig, plan: planFixture(), snap, modeId: 'INTRADAY' });
    expect(f.counterHtf).toBe(false);
    expect(f.autoEligible).toBe(true);
  });

  it('board ensemble opposite side hard-vetoes direction verification and auto', () => {
    const bearSnap = { ...snap, consensus: 'BEARISH', htfBias: 'BEARISH', ltfTrigger: 'BEARISH' };
    const p = planFixture({
      side: 'SHORT', dir: -1, bias: 'SHORT',
      context: { ...planFixture().context, dir: -1, trend: 'DOWN', structure: 'LH-LL' },
      trigger: { ...planFixture().trigger, macdHist: -0.4 },
      plan: { entry: 100, stopLoss: 100.8, t1: 99.2, t2: 98.4, netRR: { t1: 0.8, t2: 1.7 } },
    });
    const f = fuseDualTf({ symbol: 'ETH', market: 'CRYPTO', boardSig, plan: p, snap: bearSnap, modeId: 'INTRADAY' });
    expect(f.boardSideConflict).toBe(true);
    expect(f.directionVerified).toBe(false);
    expect(f.autoEligible).toBe(false);
    expect(f.autoBlockers.some(b => b.includes('board ensemble side LONG'))).toBe(true);
  });

  it('TF-fit MISMATCH caps at 70 and blocks the row', () => {
    const p = planFixture({ tfFit: { verdict: 'MISMATCH', ratioT1: 0.3, note: 'mismatch' } });
    const f = fuseDualTf({ symbol: 'X', market: 'INDIA', boardSig, plan: p, snap, modeId: 'INTRADAY' });
    expect(f.superScore).toBeLessThanOrEqual(DUAL_FUSE_WEIGHTS.caps.mismatch);
    expect(f.autoEligible).toBe(false);
    expect(f.autoBlockers.some(b => b.includes('TF-fit'))).toBe(true);
  });

  it('trigger-not-fired rows are never auto-eligible (no blind entries)', () => {
    const p = planFixture({ triggerFired: false, bias: 'WAIT-LONG', trigger: { ...planFixture().trigger, broke: false, score: 40 } });
    const f = fuseDualTf({ symbol: 'X', market: 'INDIA', boardSig, plan: p, snap, modeId: 'INTRADAY' });
    expect(f.triggerFired).toBe(false);
    expect(f.autoEligible).toBe(false);
    expect(f.autoBlockers.some(b => b.includes('trigger fire pending'))).toBe(true);
  });

  it('missing MTF-6 snapshot redistributes weights (no invented extended bias)', () => {
    const withSnap = fuseDualTf({ symbol: 'X', market: 'INDIA', boardSig, plan: planFixture(), snap, modeId: 'INTRADAY' });
    const noSnap = fuseDualTf({ symbol: 'X', market: 'INDIA', boardSig, plan: planFixture(), snap: null, modeId: 'INTRADAY' });
    expect(withSnap.weightSum).toBeCloseTo(1, 2);
    expect(noSnap.weightSum).toBeLessThan(1);
    expect(noSnap.components.find(c => c.k === 'extendedBias')).toBeUndefined();
    expect(noSnap.superScore).toBeGreaterThan(60); // still a real score from real inputs
  });

  it('WEIGHTS: components carry the documented fuse weights', () => {
    const f = fuseDualTf({ symbol: 'X', market: 'INDIA', boardSig, plan: planFixture(), snap, modeId: 'INTRADAY' });
    const byK = Object.fromEntries((f.components || []).map(c => [c.k, c.w]));
    expect(byK.contextTrend).toBe(DUAL_FUSE_WEIGHTS.contextTrend);
    expect(byK.triggerAction).toBe(DUAL_FUSE_WEIGHTS.triggerAction);
    expect(byK.planConfidence).toBe(DUAL_FUSE_WEIGHTS.planConfidence);
    expect(byK.extendedBias).toBe(DUAL_FUSE_WEIGHTS.extendedBias);
    expect(byK.boardBase).toBe(DUAL_FUSE_WEIGHTS.boardBase);
  });

  it('overextended entries lose points and get blocked', () => {
    const p = planFixture({ trigger: { ...planFixture().trigger, overextended: true } });
    const f = fuseDualTf({ symbol: 'X', market: 'INDIA', boardSig, plan: p, snap, modeId: 'INTRADAY' });
    expect(f.autoEligible).toBe(false);
    expect(f.autoBlockers.some(b => b.includes('overextended'))).toBe(true);
  });

  it('grade C plans stay out of the auto lane', () => {
    const p = planFixture({ grade: 'C', confidence: 55 });
    const f = fuseDualTf({ symbol: 'X', market: 'INDIA', boardSig, plan: p, snap, modeId: 'INTRADAY' });
    expect(f.autoBlockers).toContain('plan grade C (A/B chahiye)');
  });

  it('survives a totally missing plan (honest degrade, no crash)', () => {
    const f = fuseDualTf({ symbol: 'X', market: 'INDIA', boardSig: null, plan: null, snap: null, modeId: 'INTRADAY' });
    expect(f.autoEligible).toBe(false);
    expect(f.autoBlockers.length).toBeGreaterThan(0);
    expect(Number.isFinite(f.superScore)).toBe(true);
  });
});

describe('buildEarlyRadar — leading setups before PAKKA verification', () => {
  const row = (over = {}) => ({
    ok: true, symbol: 'EARLY', market: 'INDIA', side: 'LONG', quoteCcy: 'INR',
    superScore: 66, tier: 'ACTION', directionVerified: false,
    counterHtf: false, counterTrend: false, reversalRisk: false,
    trapVeto: false, zoneWallVeto: false,
    earlyIgnition: false, triggerFired: true,
    ltp: 100, triggerLevel: 100.5, tfFit: 'OK',
    plan: { entry: 100, stopLoss: 99, t1: 101, t2: 102 },
    autoBlockers: ['direction not verified'], asOf: 1,
    ...over,
  });

  it('surfaces trigger-fired + early-ignition rows and explains WHY they are early', () => {
    const radar = buildEarlyRadar([
      row({ symbol: 'A', earlyIgnition: false, triggerFired: true }),
      row({ symbol: 'B', earlyIgnition: true, superScore: 62 }),
    ]);
    expect(radar.map(r => r.symbol)).toEqual(['B', 'A']);
    expect(radar[0].reason).toContain('EARLY IGNITION');
    expect(radar[1].reason).toContain('TRIGGER FIRED');
    expect(radar.every(r => r.blockers.length > 0)).toBe(true);
  });

  it('never surfaces verified, counter-HTF, counter-trend, reversal-risk or vetoed rows', () => {
    const radar = buildEarlyRadar([
      row({ symbol: 'VERIFIED', directionVerified: true }),
      row({ symbol: 'HTF', counterHtf: true }),
      row({ symbol: 'CTR', counterTrend: true }),
      row({ symbol: 'REV', reversalRisk: true }),
      row({ symbol: 'TRAP', trapVeto: true }),
      row({ symbol: 'WALL', zoneWallVeto: true }),
      row({ symbol: 'NEUTRAL', side: null }),
      row({ symbol: 'WEAK', superScore: 49, earlyIgnition: true }),
      row({ symbol: 'OK1', earlyIgnition: true }),
    ]);
    expect(radar.map(r => r.symbol)).toEqual(['OK1']);
  });

  it('dedupes symbols and caps the radar at the requested limit', () => {
    const radar = buildEarlyRadar([
      row({ symbol: 'BTC', superScore: 70 }),
      row({ symbol: 'BTC', earlyIgnition: true, superScore: 90 }),
      row({ symbol: 'ETH' }), row({ symbol: 'SOL' }), row({ symbol: 'XRP' }), row({ symbol: 'DOGE' }),
    ], 2);
    expect(radar).toHaveLength(2);
    expect(new Set(radar.map(r => r.symbol)).size).toBe(2);
    expect(radar[0].symbol).toBe('BTC');
  });

  it('honest empty radar (never fabricates signals)', () => {
    expect(buildEarlyRadar([])).toEqual([]);
    expect(buildEarlyRadar(null)).toEqual([]);
    expect(buildEarlyRadar([row({ triggerFired: false, earlyIgnition: false })])).toEqual([]);
  });
});

describe('dualAutoCandidates — the pick sift', () => {
  const row = (over = {}) => ({
    ok: true, symbol: 'AAA', market: 'INDIA', mode: 'INTRADAY', superScore: 82, tier: 'STRONG',
    side: 'LONG', autoEligible: true, autoBlockers: [], holdMin: 45,
    plan: { entry: 100, stopLoss: 99, t1: 101, t2: 102 }, ...over,
  });

  it('picks a clean 82-score row', () => {
    const out = dualAutoCandidates([row()], { minScore: 75 }, { openSymbols: new Set(), lastEntryAt: {} });
    expect(out[0].autoPickBlockers).toEqual([]);
  });

  it('enforces the 75 bar (74 is out)', () => {
    const out = dualAutoCandidates([row({ superScore: 74 })], { minScore: 75 }, { openSymbols: new Set(), lastEntryAt: {} });
    expect(out[0].autoPickBlockers.some(b => b.includes('< 75'))).toBe(true);
  });

  it('blocks already-open symbols', () => {
    const out = dualAutoCandidates([row()], { minScore: 75 }, { openSymbols: new Set(['AAA']), lastEntryAt: {} });
    expect(out[0].autoPickBlockers).toContain('already open');
  });

  it('enforces the per-symbol cooldown', () => {
    const now = 1_700_000_000_000;
    const out = dualAutoCandidates([row()], { minScore: 75, cooldownMin: 30 }, { openSymbols: new Set(), lastEntryAt: { AAA: now - 10 * 60_000 }, now });
    expect(out[0].autoPickBlockers.some(b => b.includes('cooldown'))).toBe(true);
  });

  it('cooldown expiry → pickable again', () => {
    const now = 1_700_000_000_000;
    const out = dualAutoCandidates([row()], { minScore: 75, cooldownMin: 30 }, { openSymbols: new Set(), lastEntryAt: { AAA: now - 31 * 60_000 }, now });
    expect(out[0].autoPickBlockers).toEqual([]);
  });

  it('eligible picks sort above blocked ones (and by score within)', () => {
    const out = dualAutoCandidates([
      row({ symbol: 'LOW', superScore: 76 }),
      row({ symbol: 'BLOCKED', autoBlockers: ['counter-trend'], superScore: 95 }),
      row({ symbol: 'TOP', superScore: 88 }),
    ], { minScore: 75 }, { openSymbols: new Set(), lastEntryAt: {} });
    expect(out[0].symbol).toBe('TOP');
    expect(out[1].symbol).toBe('LOW');
    expect(out[2].symbol).toBe('BLOCKED');
  });

  it('__clearDualBoardCaches is safe', () => {
    expect(() => __clearDualBoardCaches()).not.toThrow();
  });
});

describe('mtfProEntryGate - manual PAPER/LIVE parity with auto quality gates', () => {
  const proRow = (over = {}) => ({
    ok: true, side: 'LONG', superScore: 82, tier: 'STRONG',
    directionVerified: true, triggerFired: true, counterHtf: false, counterTrend: false,
    autoEligible: true, autoBlockers: [], ensembleSignalAvailable: true,
    plan: { entry: 100, stopLoss: 99, t1: 101, t2: 102 },
    ...over,
  });
  const mainLong = (over = {}) => ({
    side: 'LONG', grade: 'STRONG', confidence: 84,
    mtf: { htfBias: 'BULLISH' }, signalAge: { ageMs: 60 * 60_000 },
    verify: { veto: false, action: 'BUY' },
    ...over,
  });

  it('allows a verified, triggered, ensemble-confirmed row', () => {
    const g = mtfProEntryGate(proRow(), { mainSignal: mainLong() });
    expect(g.ok).toBe(true);
    expect(g.blockers).toEqual([]);
  });

  it('blocks the id-84 class: technical SHORT vs stable main LONG', () => {
    const shortRow = proRow({ side: 'SHORT', plan: { entry: 100, stopLoss: 101, t1: 99, t2: 98 } });
    const g = mtfProEntryGate(shortRow, { mainSignal: mainLong() });
    expect(g.ok).toBe(false);
    expect(g.blockers.some(b => b.includes('cross-engine veto'))).toBe(true);
  });

  it('blocks unverified / trigger-pending rows even when the plan looks complete', () => {
    const pending = proRow({
      directionVerified: false, triggerFired: false, autoEligible: false,
      autoBlockers: ['direction not PAKKA verified', 'trigger fire pending'],
    });
    const g = mtfProEntryGate(pending, { mainSignal: mainLong() });
    expect(g.ok).toBe(false);
    expect(g.blockers).toEqual(expect.arrayContaining(['direction not PAKKA verified', 'trigger fire pending']));
  });

  it('fails closed when the main ensemble signal is unavailable', () => {
    const g = mtfProEntryGate(proRow({ ensembleSignalAvailable: false }), { mainSignal: null });
    expect(g.ok).toBe(false);
    expect(g.blockers.some(b => b.includes('ensemble signal unavailable'))).toBe(true);
    expect(g.blockers.some(b => b.includes('ensemble signal missing'))).toBe(true);
  });

  it('blocks a fresh main signal before its stability window', () => {
    const g = mtfProEntryGate(proRow(), { mainSignal: mainLong({ signalAge: { ageMs: 30_000 } }) });
    expect(g.ok).toBe(false);
    expect(g.blockers.some(b => b.includes('stability confirm pending'))).toBe(true);
  });

  it('blocks a same-side but non-actionable NEUTRAL main signal', () => {
    const g = mtfProEntryGate(proRow(), { mainSignal: mainLong({ grade: 'NEUTRAL', confidence: 5 }) });
    expect(g.ok).toBe(false);
    expect(g.blockers.some(b => b.includes('grade NEUTRAL'))).toBe(true);
    expect(g.blockers.some(b => b.includes('confidence 5 < 60'))).toBe(true);
  });

  it('auto candidates also reject rows without ensemble context', () => {
    const out = dualAutoCandidates([proRow({ ensembleSignalAvailable: false })], { minScore: 75 }, { openSymbols: new Set(), lastEntryAt: {} });
    expect(out[0].autoPickBlockers.some(b => b.includes('ensemble signal unavailable'))).toBe(true);
  });
});
describe('v21.16.0 — cost/noise-stop gates (live-test regression)', () => {
  it('cost >= 0.5R row is never auto-eligible (INJ micro-range class)', () => {
    const p = planFixture({ costs: { costR: 10.06, roundTripPct: 0.1 }, plan: { entry: 765.74, stopLoss: 765.8, t1: 765.68, t2: 765.62, netRR: { t1: -4, t2: -8 }, stopPct: 0.008 } });
    const f = fuseDualTf({ symbol: 'INJ', market: 'CRYPTO', boardSig, plan: p, snap, modeId: 'INTRADAY' });
    expect(f.autoEligible).toBe(false);
    expect(f.autoBlockers.some(b => b.includes('0.5R'))).toBe(true);
    expect(f.autoBlockers.some(b => b.includes('stop') || b.includes('noise'))).toBe(true);
    expect(f.autoBlockers.some(b => b.includes('net RR'))).toBe(true);
  });

  it('healthy-cost row still passes (guard did not over-tighten)', () => {
    const f = fuseDualTf({ symbol: 'BTC', market: 'CRYPTO', boardSig, plan: planFixture({ costs: { costR: 0.12, roundTripPct: 0.1 } }), snap, modeId: 'INTRADAY' });
    expect(f.autoEligible).toBe(true);
  });
});
