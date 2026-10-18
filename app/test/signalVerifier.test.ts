// ============================================================
// test/signalVerifier.test.ts — v13.1 SIGNAL VERIFICATION AGENT
// ------------------------------------------------------------
// LOCKED HERE (user spec: "ek Aisa Agent ko add karo jo tab me Signal
// mila usse advance pro trader level pe check karke final result bole
// long jana hai ya short accurate and high accuracy ke sath"):
//   • THE LIVE XRP CASE (24 Sep 2026): a LONG with OVERBOUGHT RSI 70 +
//     HARD chase (2.31×ATR) + 28% quorum must NOT come back CONFIRM —
//     the pro veto fires; strong flip case → FLIP → SHORT, weak case →
//     STAND_ASIDE. Never the signal's own side at full risk.
//   • A clean pullback setup (healthy quorum, MTF aligned, +edge,
//     R:R ≥ 2, regime aligned) → CONFIRM same side, sizeHint 1.
//   • The verdict ladder boundaries: 40 / 68 score lines.
//   • Partial input degrades honestly (WARN bands, never throws).
//   • Spot vs futures paths (perp crowd check only on FUTURES).
//   • verificationWire: compact + IDEMPOTENT (re-wiring a wire stamp
//     preserves its fails/warns — the manual-trade stamp path).
//   • checklist integrity: 10 checks, weights sum to exactly 100,
//     every check's points ≤ weight, score = Σ points.
// ============================================================
import { describe, it, expect } from 'vitest';
import { verifySignal, verificationWire } from '../server/ai/signalVerifier.js';

// ---- the LIVE XRP disaster, reconstructed from the trade record ----
// (origin: aiScore 57 · conf 48 · 3/11 voters · RSI 70 overbought ·
//  2.31×ATR above EMA20 — "LONG entry suppressed (chase hi hota hai)")
const XRP_CASE = {
  symbol: 'XRP', market: 'FUTURES', side: 'LONG',
  grade: 'WATCH', confidence: 48,
  voters: 3, totalModels: 11, agreement: 1,
  ltp: 1.619, changePct: 4.1,
  obOs: { tag: 'OVERBOUGHT', rsi: 70.4, extreme: false },
  chasing: { side: 'LONG', extAtr: 2.31, ref: 'EMA20', runBars: 4, runAtr: 2.8, severity: 'HARD', reason: 'RSI 70 + 2.31×ATR above EMA20 — stretched leg' },
  plan: { entry: 1.62, stopLoss: 1.54, target1: 1.7, target2: 1.78, riskPct: 5, rewardRisk: 1.0 },
  quality: { regime: { aligned: true, counterTrend: false, label: 'REGIME ALIGNED' } },
  superIntel: {
    aiScore: 57,
    winProb: { pWin: 48, pNeed: 50, edgePts: -2, evR: -0.04, evRealisticR: -0.06, verdict: 'NO EDGE', calibrated: false, drivers: [], note: '' },
  },
};

// ---- the clean pullback setup (the CURRENT live XRP read, actually) ----
const CLEAN_CASE = {
  symbol: 'XRP', market: 'FUTURES', side: 'LONG',
  grade: 'ACTION', confidence: 66,
  voters: 8, totalModels: 11, agreement: 0.73,
  ltp: 1.52, changePct: -1.2,
  entryQuality: { band: 'PULLBACK', extAtr: 0.02, ref: 'EMA20', note: 'pullback zone, acha entry' },
  mtf: { agreement: 0.8, dirs: { '5m': 1, '15m': 1, '1h': 1 } },
  plan: { entry: 1.52, stopLoss: 1.46, target1: 1.64, target2: 1.74, riskPct: 2, rewardRisk: 2.2 },
  quality: { regime: { aligned: true, counterTrend: false, label: 'REGIME ALIGNED' } },
  superIntel: {
    aiScore: 78,
    winProb: { pWin: 62, pNeed: 33.3, edgePts: 23.7, evR: 0.6, evRealisticR: 0.34, verdict: 'EDGE', calibrated: false, drivers: [], note: '' },
    perp: { fundingBps8h: 1.2, positioningScore: 70, read: { score: 70 } },
  },
};

describe('SVA-v1 — the XRP-class burn (the reason this module exists)', () => {
  it('the live XRP case NEVER confirms the LONG — veto + flip/stand-aside', () => {
    const v = verifySignal(XRP_CASE);
    expect(v.veto).toBe(true);
    expect(['FLIP', 'STAND_ASIDE']).toContain(v.action);
    expect(v.action).not.toBe('CONFIRM');
    expect(v.sizeHint).toBe(0);
    expect(v.finalCall === 'NO_TRADE' || v.finalCall === 'SHORT').toBe(true);
  });

  it('strong flip case (RSI extreme + HARD chase + thin quorum) → FLIP → SHORT', () => {
    const v = verifySignal(XRP_CASE);
    // 25 (rsi) + 22 (hard chase) + 10 (quorum FAIL) + 8 (neg edge) = 75 over the 60 bar
    expect(v.action).toBe('FLIP');
    expect(v.finalCall).toBe('SHORT');
    expect(v.flipScore != null && (v.flipScore as number) >= 60).toBe(true);
  });

  it('hard chase alone with a HEALTHY committee → caution/confirm, not a hard veto', () => {
    const v = verifySignal({ ...XRP_CASE, voters: 8, totalModels: 11, obOs: null, superIntel: { ...XRP_CASE.superIntel, winProb: { ...XRP_CASE.superIntel.winProb, edgePts: 8 } }, mtf: { agreement: 0.75 } });
    expect(v.veto).toBe(false);
    // chase HARD still burns: never full CONFIRM at 16 dead points
    expect(v.action).not.toBe('CONFIRM');
  });

  it('weak flip case (only mild soft extension) → STAND_ASIDE, never a manufactured flip', () => {
    const v = verifySignal({
      symbol: 'DOGE', market: 'FUTURES', side: 'LONG', confidence: 40,
      voters: 4, totalModels: 11,
      chasing: { side: 'LONG', extAtr: 1.9, ref: 'EMA20', runBars: 2, runAtr: 1.2, severity: 'SOFT', reason: 'soft' },
      plan: { rewardRisk: 0.9 },
      superIntel: { aiScore: 41, winProb: { edgePts: -1 } },
    });
    // soft ext (8) + neg edge (8) = flipScore 46 < 60 → no trade
    expect(v.action).toBe('STAND_ASIDE');
    expect(v.finalCall).toBe('NO_TRADE');
    expect(v.sizeHint).toBe(0);
  });
});

describe('SVA-v1 — the clean setup confirms at full risk', () => {
  it('clean pullback + quorum + MTF + edge → CONFIRM LONG, sizeHint 1', () => {
    const v = verifySignal(CLEAN_CASE);
    expect(v.action).toBe('CONFIRM');
    expect(v.finalCall).toBe('LONG');
    expect(v.sizeHint).toBe(1);
    expect(v.score).toBeGreaterThanOrEqual(68);
  });

  it('SHORT side mirrors correctly (oversold SHORT entry gets the same veto)', () => {
    const v = verifySignal({
      ...XRP_CASE, side: 'SHORT',
      obOs: { tag: 'OVERSOLD', rsi: 28, extreme: true },
      chasing: { ...XRP_CASE.chasing, side: 'SHORT', severity: 'HARD' },
    });
    expect(v.veto).toBe(true);
    if (v.action === 'FLIP') expect(v.finalCall).toBe('LONG');
    else expect(v.action).toBe('STAND_ASIDE');
  });

  it('perp positioning OPPOSING the entry fires the crowd warning (futures only)', () => {
    const v = verifySignal({ ...CLEAN_CASE, superIntel: { ...CLEAN_CASE.superIntel, perp: { positioningScore: 20, read: { score: 20 } } } });
    const crowd = v.checklist.find(c => c.id === 'perpCrowd');
    expect(crowd?.status).toBe('WARN');
    // score dips below the CONFIRM line with the crowd against
    expect(v.score).toBeLessThan(verifySignal(CLEAN_CASE).score);
  });

  it('spot market skips the perp crowd check (PASS, no perp read needed)', () => {
    const v = verifySignal({ ...CLEAN_CASE, market: 'CRYPTO', superIntel: { aiScore: 78, winProb: CLEAN_CASE.superIntel.winProb } });
    const crowd = v.checklist.find(c => c.id === 'perpCrowd');
    expect(crowd?.status).toBe('PASS');
  });
});

describe('SVA-v1 — the verdict ladder + checklist integrity', () => {
  it('checklist has exactly 10 checks with weights summing to 100', () => {
    const v = verifySignal(CLEAN_CASE);
    expect(v.checklist.length).toBe(10);
    const total = v.checklist.reduce((s, c) => s + c.weight, 0);
    expect(total).toBe(100);
  });

  it('score = Σ points and every check earns ≤ its weight', () => {
    const v = verifySignal(XRP_CASE);
    const sum = v.checklist.reduce((s, c) => s + c.points, 0);
    expect(Math.round(sum)).toBe(v.score);
    for (const c of v.checklist) expect(c.points).toBeLessThanOrEqual(c.weight);
  });

  it('the 40/68 ladder boundaries hold (thin committee + soft reads → CAUTION)', () => {
    // borderline-thin setup: quorum FAIL (core — blocks CONFIRM) +
    // mid reads land in the CAUTION band (score 40-67, half risk)
    const v = verifySignal({
      symbol: 'WLD', market: 'FUTURES', side: 'LONG', confidence: 55,
      voters: 3, totalModels: 11,
      mtf: { agreement: 0.5 },
      chasing: { side: 'LONG', extAtr: 1.9, ref: 'EMA20', runBars: 2, runAtr: 1.2, severity: 'SOFT', reason: 'soft' },
      plan: { rewardRisk: 1.3 },
      superIntel: { aiScore: 58, winProb: { edgePts: 2 } },
    });
    expect(v.action).toBe('CAUTION');
    expect(v.finalCall).toBe('LONG');
    expect(v.sizeHint).toBe(0.5);
    expect(v.score).toBeGreaterThanOrEqual(40);
    expect(v.score).toBeLessThan(68);
  });

  it('partial input never throws — missing fields score their neutral WARN band', () => {
    const v = verifySignal({ symbol: 'BTC', market: 'FUTURES', side: 'LONG' });
    expect(v.agent).toBe('SVA-v1');
    expect(v.score).toBeGreaterThan(0);
    expect(v.checklist.length).toBe(10);
    for (const c of v.checklist) expect(['PASS', 'WARN', 'FAIL']).toContain(c.status);
  });

  it('verdict + proNote are non-empty Hinglish strings (the audit trail)', () => {
    const v = verifySignal(XRP_CASE);
    expect(v.verdict.length).toBeGreaterThan(10);
    expect(v.proNote.length).toBeGreaterThan(20);
    expect(v.proNote).toContain('SVA-v1');
  });

  it('freshFlip warns on stability; regime counterTrend fails the regime check', () => {
    const v = verifySignal({
      ...CLEAN_CASE,
      freshFlip: { from: 'SHORT', to: 'LONG', ageSec: 90 },
      quality: { regime: { aligned: false, counterTrend: true, label: 'COUNTER-TREND' } },
    });
    expect(v.checklist.find(c => c.id === 'stability')?.status).toBe('WARN');
    expect(v.checklist.find(c => c.id === 'regime')?.status).toBe('FAIL');
    expect(v.action).not.toBe('CONFIRM');
  });
});

describe('SVA-v1 — the wire payload (board stamps + manual-trade records)', () => {
  it('trims the checklist but keeps the verdict essentials', () => {
    const w = verificationWire(verifySignal(CLEAN_CASE));
    expect(w).not.toBeNull();
    expect(w!.agent).toBe('SVA-v1');
    expect(w!.action).toBe('CONFIRM');
    expect(w!.finalCall).toBe('LONG');
    expect(typeof w!.score).toBe('number');
    expect(Array.isArray((w as { fails?: string[] }).fails)).toBe(true);
    expect(w!.checklist).toBeUndefined();
  });

  it('IDEMPOTENT: re-wiring an already-compact stamp preserves its fails/warns', () => {
    const full = verifySignal(XRP_CASE);
    const w1 = verificationWire(full);
    const w2 = verificationWire(w1);
    expect(w2).toEqual(w1);
    expect((w2 as { fails: string[] }).fails).toEqual((w1 as { fails: string[] }).fails);
    expect((w2 as { warns: number }).warns).toBe((w1 as { warns: number }).warns);
  });

  it('null/garbage in → null out (never a broken stamp on a trade)', () => {
    expect(verificationWire(null)).toBeNull();
    expect(verificationWire(undefined)).toBeNull();
    expect(verificationWire({})).toBeNull();
  });
});
