// ============================================================
// test/v612-core.test.ts — v6.12 PRO TRADER BRAIN
// ------------------------------------------------------------
// The honesty layer that fixes "no accurate signals + paper losses":
//   • quorum confidence caps (single-model fake consensus killer)
//   • paper/notify ACTION floor (the slot-machine fix)
//   • session phases (opening noise / square-off / closed gates)
//   • regime gate tightened (BTC ±0.75 / NIFTY ±0.35 + daily trend)
//   • extension guard (blow-off chase veto)
//   • structure stop (swing-aware SL)
//   • MTF alignment phases
// ============================================================
import { describe, expect, it } from 'vitest';
import { aggregateVotes, evaluateExecutionGate, buildTradePlan, QUORUM_CONF_CAPS } from '../server/ai/ensemble.js';
import {
  sessionPhase, mtfAnalysis, regimeGate, extensionGuard, structureStop, qualityVerdict, NSE_PHASES,
} from '../server/ai/probrain.js';

const v = (id: string, dir: number, conf: number, weight = 1) =>
  ({ id, name: id, role: '', weight, dir, conf, reasons: [] });

const mkSignal = (over: Record<string, unknown> = {}) => ({
  symbol: 'TEST', market: 'CRYPTO', side: 'LONG', grade: 'STRONG', confidence: 80,
  agreement: 0.9, participating: 6, totalModels: 9,
  ltp: 100, changePct: 0.5, generatedAt: Date.now(),
  plan: { entry: 100, stopLoss: 95, target1: 105, target2: 110, risk: 5, riskPct: 5, rewardRisk: 2, atrUsed: 3.5, planStyle: 'atr-based' },
  votes: [], summary: '', aiNote: null, executable: true,
  ...over,
});

// ---------------- QUORUM CONFIDENCE CAPS ----------------
describe('v6.12 quorum honesty (the fake-consensus killer)', () => {
  it('ONE loud model can never reach ACTION/STRONG — cap 52', () => {
    const out = aggregateVotes([v('trend', 1, 100, 1.4)]);
    expect(out.confidence).toBeLessThanOrEqual(QUORUM_CONF_CAPS[1]);
    expect(out.confidence).toBeLessThanOrEqual(52);
    expect(out.grade).toBe('WATCH'); // 52 ≥ 35 — watchlist note, not a trade
    expect(out.quorumCapped).toBe(true);
    expect(out.voters).toBe(1);
  });

  it('TWO voters cap at 54 — WATCH max, ACTION impossible', () => {
    const out = aggregateVotes([v('trend', 1, 100, 1.4), v('mom', 1, 95, 1.3)]);
    expect(out.confidence).toBeLessThanOrEqual(54);
    expect(out.grade).toBe('WATCH');
  });

  it('THREE voters cap at 72 — ACTION reachable, STRONG blocked', () => {
    const out = aggregateVotes([v('a', 1, 95, 1.4), v('b', 1, 95, 1.3), v('c', 1, 95, 1.2)]);
    expect(out.confidence).toBeLessThanOrEqual(72);
    expect(out.grade).toBe('ACTION');
  });

  it('FIVE+ voters — no cap, real committee can be STRONG', () => {
    const votes = [v('a', 1, 90, 1.4), v('b', 1, 88, 1.3), v('c', 1, 86, 1.2), v('d', 1, 85, 1.0), v('e', 1, 84, 1.1)];
    const out = aggregateVotes(votes);
    expect(out.quorumCapped).toBeUndefined();
    expect(out.confidence).toBeGreaterThanOrEqual(75);
    expect(out.grade).toBe('STRONG');
  });

  it('the v6.11 board bug: 1 voter @ conf 100 reads 52 (was 74 ACTION)', () => {
    // Reproduction of the exact pre-v6.12 crypto board: only the trend
    // model voted +100 on ETH while 8 models abstained.
    const votes = [
      v('trend', 1, 100, 1.4), v('mom', 0, 28, 1.3), v('vol', 0, 25, 0.9),
      v('volume', 0, 25, 1.2), v('pattern', 0, 22, 1.0), v('sr', 0, 22, 1.1),
      v('options', 0, 0, 1.0), v('regime', 0, 25, 0.8), v('smc', 0, 0, 1.1),
    ];
    const out = aggregateVotes(votes);
    expect(out.confidence).toBeLessThanOrEqual(52);
    expect(out.grade).not.toBe('ACTION');
    expect(out.grade).not.toBe('STRONG');
  });
});

// ---------------- PAPER / NOTIFY ACTION FLOOR ----------------
describe('v6.12 paper ACTION floor (the slot-machine fix)', () => {
  const base = { side: 'LONG', venue: 'CRYPTO', maxAgeMs: 600_000, maxRiskPct: 5 };

  it('PAPER rejects a WATCH-grade signal — WATCH means watch, not trade', () => {
    const out = evaluateExecutionGate(mkSignal({ grade: 'WATCH', confidence: 48 }), { ...base, requireStrong: false });
    expect(out.ok).toBe(false);
    expect(out.reason).toMatch(/ACTION-grade/i);
  });

  it('PAPER rejects a NEUTRAL-grade signal', () => {
    const out = evaluateExecutionGate(mkSignal({ grade: 'NEUTRAL', confidence: 20 }), { ...base, requireStrong: false });
    expect(out.ok).toBe(false);
  });

  it('PAPER rejects grade-ACTION but sub-55 confidence', () => {
    const out = evaluateExecutionGate(mkSignal({ grade: 'ACTION', confidence: 54 }), { ...base, requireStrong: false });
    expect(out.ok).toBe(false);
    expect(out.reason).toMatch(/paper floor/i);
  });

  it('PAPER passes a real ACTION signal with honest conf ≥ 55', () => {
    const out = evaluateExecutionGate(mkSignal({ grade: 'ACTION', confidence: 66 }), { ...base, requireStrong: false });
    expect(out.ok).toBe(true);
    expect(out.reason).toMatch(/PAPER/i);
  });

  it('PAPER passes STRONG; LIVE still demands STRONG + agreement', () => {
    expect(evaluateExecutionGate(mkSignal(), { ...base, requireStrong: false }).ok).toBe(true);
    expect(evaluateExecutionGate(mkSignal(), { ...base, requireStrong: true }).ok).toBe(true);
    expect(evaluateExecutionGate(mkSignal({ grade: 'ACTION' }), { ...base, requireStrong: true }).ok).toBe(false);
  });
});

// ---------------- v9.0.2 PRACTICE FLAG (paper always starts) ----------------
describe('v9.0.2 practice flag — desk PAPER/NOTIFY clicks', () => {
  const base = { side: 'LONG', venue: 'CRYPTO', maxAgeMs: 600_000, maxRiskPct: 5 };

  it('practice: true lets a WATCH-grade signal through (fresh grade is journaled by the desk)', () => {
    const out = evaluateExecutionGate(mkSignal({ grade: 'WATCH', confidence: 40 }), { ...base, requireStrong: false, practice: true });
    expect(out.ok).toBe(true);
  });

  it('practice: true lets sub-55 confidence through', () => {
    const out = evaluateExecutionGate(mkSignal({ grade: 'ACTION', confidence: 41 }), { ...base, requireStrong: false, practice: true });
    expect(out.ok).toBe(true);
  });

  it('practice does NOT bypass the side/plan/risk checks', () => {
    expect(evaluateExecutionGate(mkSignal(), { ...base, side: 'SHORT', requireStrong: false, practice: true }).ok).toBe(false);
    expect(evaluateExecutionGate(mkSignal({ plan: null }), { ...base, requireStrong: false, practice: true }).ok).toBe(false);
    const wide = mkSignal({ plan: { entry: 100, stopLoss: 88, target1: 112, target2: 124, risk: 12, riskPct: 12, rewardRisk: 2 } });
    expect(evaluateExecutionGate(wide, { ...base, requireStrong: false, practice: true }).ok).toBe(false);
  });

  it('practice does NOT bypass staleness or the LIVE gauntlet', () => {
    const stale = mkSignal({ generatedAt: Date.now() - 20 * 60_000 });
    expect(evaluateExecutionGate(stale, { ...base, requireStrong: false, practice: true }).ok).toBe(false);
    expect(evaluateExecutionGate(mkSignal({ grade: 'ACTION' }), { ...base, requireStrong: true, practice: true }).ok).toBe(false);
  });
});

// ---------------- SESSION PHASE ----------------
describe('v6.12 NSE session phases', () => {
  const wed = (istH: number, istM: number) => {
    // IST = UTC+5:30 → UTC minutes = IST minutes − 330
    const total = istH * 60 + istM - 330;
    return new Date(Date.UTC(2026, 8, 9, Math.floor(total / 60), ((total % 60) + 60) % 60));
  };

  it('pre-open / opening noise / prime / square-off / closed map correctly', () => {
    expect(sessionPhase('INDIA', wed(9, 0)).phase).toBe(NSE_PHASES.PRE_OPEN);
    expect(sessionPhase('INDIA', wed(9, 20)).phase).toBe(NSE_PHASES.OPENING);
    expect(sessionPhase('INDIA', wed(9, 45)).phase).toBe(NSE_PHASES.MORNING);
    expect(sessionPhase('INDIA', wed(12, 0)).phase).toBe(NSE_PHASES.MIDDAY);
    expect(sessionPhase('INDIA', wed(14, 0)).phase).toBe(NSE_PHASES.AFTERNOON);
    expect(sessionPhase('INDIA', wed(14, 45)).phase).toBe(NSE_PHASES.POWER);
    expect(sessionPhase('INDIA', wed(15, 20)).phase).toBe(NSE_PHASES.NO_NEW_ENTRIES);
    expect(sessionPhase('INDIA', wed(16, 30)).phase).toBe(NSE_PHASES.CLOSED);
  });

  it('weekend = CLOSED with honest note', () => {
    const sat = new Date(Date.UTC(2026, 8, 12, 6, 0)); // Sat
    expect(sessionPhase('INDIA', sat).phase).toBe(NSE_PHASES.CLOSED);
    expect(sessionPhase('INDIA', sat).tradeable).toBe(false);
  });

  it('crypto is always open (weekend note honest)', () => {
    const sat = new Date(Date.UTC(2026, 8, 12, 6, 0));
    const out = sessionPhase('CRYPTO', sat);
    expect(out.tradeable).toBe(true);
    expect(out.note).toMatch(/Weekend/);
  });
});

// ---------------- REGIME GATE ----------------
describe('v6.12 regime gate (tightened)', () => {
  it('BTC -1.4% is NO LONGER neutral — LONG pays the counter-trend penalty', () => {
    const rg = regimeGate({ market: 'CRYPTO', side: 'LONG', regime: { btcChange: -1.4 } });
    expect(rg.counterTrend).toBe(true);
    expect(rg.penaltyPct).toBeGreaterThanOrEqual(10);
  });

  it('BTC -1.4% + SHORT = aligned (no penalty)', () => {
    const rg = regimeGate({ market: 'CRYPTO', side: 'SHORT', regime: { btcChange: -1.4 } });
    expect(rg.aligned).toBe(true);
    expect(rg.penaltyPct).toBe(0);
  });

  it('BTC daily EMA trend tie-break: quiet day + DOWN trend penalizes LONG', () => {
    const rg = regimeGate({ market: 'CRYPTO', side: 'LONG', regime: { btcChange: 0.1, btcTrend: 'DOWN' } });
    expect(rg.counterTrend).toBe(true);
  });

  it('NIFTY -0.4% counts as risk-off now (was neutral pre-v6.12)', () => {
    const rg = regimeGate({ market: 'INDIA', side: 'LONG', regime: { niftyChange: -0.4, indiaVix: 10 } });
    expect(rg.counterTrend).toBe(true);
  });

  it('India VIX > 18 adds an extra penalty even when aligned', () => {
    const rg = regimeGate({ market: 'INDIA', side: 'SHORT', regime: { niftyChange: -1.2, indiaVix: 21 } });
    expect(rg.aligned).toBe(true);
    expect(rg.penaltyPct).toBeGreaterThanOrEqual(8);
  });
});

// ---------------- EXTENSION GUARD ----------------
describe('v6.12 extension guard (blow-off chase veto)', () => {
  it('DOT +15.3% LONG = VETO (the exact board bug)', () => {
    const ext = extensionGuard({ market: 'CRYPTO', side: 'LONG', changePct: 15.3, rsi: 83.5 });
    expect(ext.veto).toBe(true);
    expect(ext.reasons.join(' ')).toMatch(/blow-off|exhaustion/i);
  });

  it('+3.5% India LONG = downgrade (entry extended but not vetoed)', () => {
    const ext = extensionGuard({ market: 'INDIA', side: 'LONG', changePct: 3.5 });
    expect(ext.veto).toBe(false);
    expect(ext.downgrade).toBe(true);
  });

  it('RSI 80 LONG crypto = veto (exhaustion)', () => {
    expect(extensionGuard({ market: 'CRYPTO', side: 'LONG', rsi: 80 }).veto).toBe(true);
  });

  it('crash-side SHORT veto: -9% India SHORT = capitulation bounce risk', () => {
    expect(extensionGuard({ market: 'INDIA', side: 'SHORT', changePct: -9 }).veto).toBe(true);
  });

  it('calm tape + normal RSI = clean entry', () => {
    const ext = extensionGuard({ market: 'INDIA', side: 'LONG', changePct: 0.4, rsi: 58, adx: { adx: 28 } });
    expect(ext.veto).toBe(false);
    expect(ext.downgrade).toBe(false);
  });
});

// ---------------- STRUCTURE STOP ----------------
describe('v6.12 swing-structure stop', () => {
  // Shallow pullback tape: gentle slide into a pivot low at bar 26
  // (low 98.8), then a recovery to ~100 — the swing sits ~1.1 ATR
  // under price, so the structure stop (98.66) is TIGHTER than the
  // 1.4×ATR stop (98.43 → wait, higher = tighter for LONG).
  const candles = Array.from({ length: 40 }, (_, i) => {
    const base = i < 26 ? 100.5 - i * 0.05 : i === 26 ? 99.1 : 99.1 + (i - 26) * 0.07;
    return { time: i * 3600_000, open: base, high: base + 0.3, low: base - 0.3, close: base + 0.1, volume: 10 };
  });
  const ltp = candles[candles.length - 1].close;
  const atr = 1.2;

  it('places the SL behind the swing low, padded for noise (LONG)', () => {
    const ss = structureStop({ candles, side: 'LONG', ltp, atr });
    expect(ss).not.toBeNull();
    expect(ss!.sl).toBeLessThan(ltp);
    expect(ss!.structural).toBeLessThanOrEqual(ltp);
  });

  it('rejects a swing too far away (> 2.2 ATR) — ATR stop stands', () => {
    // a deep recent spike low at bar 30 becomes the most recent pivot —
    // 21 units below price is > 2.2 ATR: structurally true, risk-fantasy
    const far = candles.map((c, i) => (i === 30 ? { ...c, low: c.low - 20 } : c));
    const ss = structureStop({ candles: far, side: 'LONG', ltp, atr });
    expect(ss?.rejected).toBe(true);
    expect(ss?.sl).toBeNull();
  });

  it('no candles → null (honest degrade)', () => {
    expect(structureStop({ candles: null, side: 'LONG', ltp, atr })).toBeNull();
  });

  it('buildTradePlan takes the TIGHTER of structure vs ATR (risk shrinks, never grows)', () => {
    const ss = structureStop({ candles, side: 'LONG', ltp, atr });
    const ctx = { ltp, ind: { atr } };
    const plain = buildTradePlan({ side: 'LONG', dir: 1 }, ctx, 'INDIA');
    const structured = buildTradePlan({ side: 'LONG', dir: 1 }, ctx, 'INDIA', { structureStop: ss! });
    expect(structured!.risk).toBeLessThanOrEqual(plain!.risk);
    expect(structured!.planStyle).toMatch(/structure/);
    expect(structured!.structure?.level).toBeTypeOf('number');
  });
});

// ---------------- MTF ----------------
describe('v6.12 multi-timeframe analysis', () => {
  it('daily up + 15m up + LONG = ALIGNED', () => {
    const m = mtfAnalysis({ htf: { ema20: 105, ema50: 100, rsi: 60 }, ltf: { ema20: 104, ema50: 101, macdHist: 1 }, side: 'LONG' });
    expect(m.aligned).toBe(true);
    expect(m.phase).toBe('ALIGNED');
  });

  it('daily DOWN + 15m up + LONG = COUNTER_HTF (the reversal trap)', () => {
    const m = mtfAnalysis({ htf: { ema20: 95, ema50: 100 }, ltf: { ema20: 102, ema50: 101, macdHist: 1 }, side: 'LONG' });
    expect(m.aligned).toBe(false);
    expect(m.phase).toBe('COUNTER_HTF');
  });

  it('daily UP + 15m down + LONG = MISALIGNED (conflict, not reversal)', () => {
    const m = mtfAnalysis({ htf: { ema20: 105, ema50: 100 }, ltf: { ema20: 99, ema50: 101, macdHist: -1 }, side: 'LONG' });
    expect(m.aligned).toBe(false);
    expect(m.phase).toBe('MISALIGNED');
  });

  it('no LTF data → UNAVAILABLE, honest skip (no penalty)', () => {
    const m = mtfAnalysis({ htf: { ema20: 105, ema50: 100 }, ltf: null, side: 'LONG' });
    expect(m.available).toBe(false);
    expect(m.aligned).toBeNull();
  });

  it('LTF RSI 75 on a LONG entry gets the timing warning', () => {
    const m = mtfAnalysis({ htf: { ema20: 105, ema50: 100 }, ltf: { ema20: 106, ema50: 101, rsi: 76 }, side: 'LONG' });
    expect(m.reasons.join(' ')).toMatch(/overbought/);
  });
});

// ---------------- QUALITY VERDICT SYNTHESIS ----------------
describe('v6.12 qualityVerdict — the grade-cap ladder', () => {
  const base = {
    market: 'CRYPTO', side: 'LONG',
    votes: [v('a', 1, 90, 1.4), v('b', 1, 88, 1.3), v('c', 1, 86, 1.2), v('d', 1, 85, 1.0), v('e', 1, 84, 1.1)],
    ltp: 100, changePct: 0.3, rsi: 58, adx: { adx: 30 }, atr: 2,
    candles: null, regime: { btcChange: 1.2, btcTrend: 'UP' },
    htf: { ema20: 105, ema50: 100 }, ltf: { ema20: 104, ema50: 101, macdHist: 1 }, ltfLabel: '1h',
    consensus: { dir: 1, side: 'LONG' } as never, now: Date.now(),
  };

  it('full confluence → STRONG cap, regime + MTF bonuses', () => {
    const qv = qualityVerdict(base);
    expect(qv.gradeCap).toBe('STRONG');
    expect(qv.confAdj).toBeGreaterThan(0);
    expect(qv.flags.quorum.voters).toBe(5);
  });

  it('extension veto forces the WATCH cap regardless of everything else', () => {
    const qv = qualityVerdict({ ...base, changePct: 12 });
    expect(qv.gradeCap).toBe('WATCH');
    expect(qv.flags.veto).toBe('extension');
  });

  it('single-voter quorum forces the WATCH cap', () => {
    const qv = qualityVerdict({ ...base, votes: [v('a', 1, 100, 1.4)] });
    expect(qv.gradeCap).toBe('WATCH');
    expect(qv.flags.veto).toBe('quorum');
  });

  it('India closed session caps the grade at WATCH', () => {
    // Sat Sep 12 2026 — market closed
    const qv = qualityVerdict({ ...base, market: 'INDIA', now: Date.UTC(2026, 8, 12, 6, 0) });
    expect(qv.session.phase).toBe('CLOSED');
    expect(qv.gradeCap).toBe('WATCH');
  });

  it('counter-regime trade bleeds confidence via confAdj', () => {
    const aligned = qualityVerdict(base).confAdj;
    const counter = qualityVerdict({ ...base, regime: { btcChange: -1.4, btcTrend: 'DOWN' } }).confAdj;
    expect(counter).toBeLessThan(aligned);
  });
});

// ============================================================
// v6.12.1 — FULL-CODE RECHECK REGRESSIONS (C-1, H-1, H-2)
// Found by the v6.12.1 full-site review; each test pins the exact
// bug that shipped in v6.12.0.
// ============================================================
import { runQuantModels } from '../server/ai/models.js';

describe('v6.12.1 C-1: wrong-side structure stop (instant stop-out killer)', () => {
  // Broken-structure tape: pivot low 99.0 forms at bar 30, price
  // bounces (bars 31-33), then BREAKS below the swing and slides to
  // ~96 — a dip-buy entry under the pivot. The old code put the
  // "structure stop" at ~98.9 (ABOVE entry!) — an instant guaranteed
  // loss through every gate.
  const candles = Array.from({ length: 40 }, (_, i) => {
    const base = i < 30 ? 100.2 - i * 0.04
      : i === 30 ? 99.0
        : i <= 33 ? 99.0 + (i - 30) * 0.25   // bounce off the pivot
          : 99.75 - (i - 33) * 0.6;          // break below the swing
    return { time: i * 3600_000, open: base, high: base + 0.25, low: base - 0.25, close: base - 0.05, volume: 10 };
  });
  const ltp = candles[candles.length - 1].close; // ≈ 96.1 — below the 99.0 pivot
  const atr = 1.2;

  it('structureStop REJECTS a swing on the wrong side of price (LONG, price below pivot)', () => {
    const ss = structureStop({ candles, side: 'LONG', ltp, atr });
    expect(ss).not.toBeNull();
    expect(ss!.rejected).toBe(true);
    expect(ss!.sl).toBeNull();
    expect(String(ss!.reasons[0])).toMatch(/upar|structure already broken/);
  });

  it('SHORT mirror: price above the last swing high → rejected', () => {
    const inv = candles.map(c => ({ ...c, open: 200 - c.open, high: 200 - c.low, low: 200 - c.high, close: 200 - c.close }));
    const ss = structureStop({ candles: inv, side: 'SHORT', ltp: 200 - ltp, atr });
    expect(ss?.rejected).toBe(true);
    expect(ss?.sl).toBeNull();
  });

  it('buildTradePlan belt-and-braces: a FORGED wrong-side ss.sl can never flip the SL above entry', () => {
    const ctx = { ltp, ind: { atr } };
    const forged = buildTradePlan({ side: 'LONG', dir: 1 }, ctx, 'CRYPTO', {
      structureStop: { sl: 98.93, structural: 99.0, barsAgo: 5, style: 'swing-structure' } as never,
    });
    expect(forged!.stopLoss).toBeLessThan(ltp);
    expect(forged!.risk).toBeGreaterThan(0);
    expect(forged!.target1).toBeGreaterThan(ltp);
    const shortForged = buildTradePlan({ side: 'SHORT', dir: -1 }, ctx, 'CRYPTO', {
      structureStop: { sl: 95.0, structural: 94.8, barsAgo: 5, style: 'swing-structure' } as never,
    });
    expect(shortForged!.stopLoss).toBeGreaterThan(ltp);
  });

  it('the execution gate could never again bless an inverted plan (defense in depth)', () => {
    const inverted = mkSignal({
      market: 'CRYPTO', side: 'LONG', ltp,
      plan: { entry: ltp, stopLoss: 98.93, target1: 98.93, target2: 101, risk: 2.13, riskPct: 2.2, rewardRisk: 0, atrUsed: atr, planStyle: 'atr-based+swing-structure' },
    });
    const out = evaluateExecutionGate(inverted, { side: 'LONG', venue: 'CRYPTO', maxAgeMs: 600_000, maxRiskPct: 5, requireStrong: false });
    // NOTE: this documents why the plan-builder side check matters —
    // the gate itself only checks magnitude. With the C-1 fix the
    // inverted plan is never BUILT, so this signal shape is now
    // unreachable in production; the plan builder tests above are the
    // real regression guard.
    expect(out.ok).toBe(true); // gate passes magnitude-only — the fix lives upstream
  });
});

describe('v6.12.1 H-1: grade-cap ladder can never be re-raised (WATCH stays WATCH)', () => {
  const mk = (over: Record<string, unknown> = {}) => ({
    market: 'CRYPTO', side: 'LONG',
    votes: [v('a', 1, 90, 1.4), v('b', 1, 88, 1.3)],
    ltp: 100, changePct: 0.3, rsi: 58, adx: { adx: 30 }, atr: 2,
    candles: null, regime: { btcChange: -3.0, btcTrend: 'DOWN' },
    htf: { ema20: 105, ema50: 100 }, ltf: { ema20: 104, ema50: 101, macdHist: 1 }, ltfLabel: '1h',
    consensus: { dir: 1, side: 'LONG' } as never, now: Date.now(),
    ...over,
  });

  it('2 voters + STRONG counter-regime → cap stays WATCH (v6.12.0 leaked it to ACTION)', () => {
    const qv = qualityVerdict(mk());
    expect(qv.flags.quorum.voters).toBe(2);
    expect(qv.regime.counterTrend).toBe(true);
    expect(qv.regime.penaltyPct).toBeGreaterThanOrEqual(15);
    // the v6.12.0 bug: the counter-regime line re-raised this WATCH to ACTION
    expect(qv.gradeCap).toBe('WATCH');
  });

  it('untradeable session cap survives too (no escalation path)', () => {
    const qv = qualityVerdict({ ...mk(), market: 'INDIA', regime: { niftyChange: -1.5, indiaVix: 20 }, now: Date.UTC(2026, 8, 12, 6, 0) });
    expect(qv.session.tradeable).toBe(false);
    expect(qv.gradeCap).toBe('WATCH');
  });
});

describe('v6.12.1 H-2: MacroRegime votes on the FUTURES desk (was silently dead)', () => {
  it('FUTURES ctx with btcChange regime → the regime model VOTES (non-zero)', () => {
    const votes = runQuantModels({
      market: 'FUTURES', symbol: 'BTCUSDT', ltp: 50000, changePct: 0.4,
      ind: { rsi: 55, ema20: 50200, ema50: 49900, macd: { hist: 40 }, atr: 600, adx: 26 },
      regime: { btcChange: 2.0, btcTrend: 'UP' },
    });
    const macro = votes.find(x => x.id === 'regime');
    expect(macro).toBeDefined();
    expect(macro!.dir).not.toBe(0); // v6.12.0: dir 0, conf 25, no reasons — model dead on FUTURES
    expect((macro!.reasons || []).length).toBeGreaterThan(0);
    expect(String(macro!.reasons[0])).toMatch(/BTC/);
  });

  it('FUTURES risk-off regime → bearish vote (mirror works too)', () => {
    const votes = runQuantModels({
      market: 'FUTURES', symbol: 'ETHUSDT', ltp: 3000, changePct: -0.2,
      ind: { rsi: 48, ema20: 2990, ema50: 3010, macd: { hist: -5 }, atr: 40, adx: 22 },
      regime: { btcChange: -2.8, btcTrend: 'DOWN' },
    });
    const macro = votes.find(x => x.id === 'regime');
    expect(macro!.dir).toBeLessThan(0);
  });
});
