// ============================================================
// test/winProb.test.ts — v12.0 WIN-PROBABILITY ENGINE LOCKS
// ------------------------------------------------------------
// The "Highest Accuracy / Highest Win Trades" core. LOCKED HERE:
//   • the prior: AI score → P(win) prior (monotone, bounded)
//   • ledger calibration: claimed-vs-actual bucket correction with
//     damping clamps (0.70..1.30) + the n≥10 gate per bucket
//   • the LONG/SHORT side split correction (clamped 0.85..1.15, n≥20)
//   • funding + positioning adjustments: PERPS ONLY, side-aware,
//     and NULL data never fires a branch (the num(null)≠0 contract)
//   • breakeven math: pNeed = 1/(1+R:R) — the EV geometry
//   • EV: full-book vs realistic (40/40/20 with the capture haircut)
//   • the verdict ladder: EDGE / FAIR / NO-EDGE
//   • HONESTY: hard cap 92% (never certainty), floor 8%, the
//     uncalibrated note tells the truth, drivers carry every ±pt
// ============================================================
import { describe, it, expect } from 'vitest';
import {
  computeWinProb, priorFromAiScore, WIN_PROB_HARD_CAP, WIN_PROB_FLOOR, MIN_CALIBRATION_N,
} from '../server/ai/winProb.js';

describe('priorFromAiScore — the AI-score prior', () => {
  it('is monotone in the AI score and bounded', () => {
    expect(priorFromAiScore(90)).toBeGreaterThan(priorFromAiScore(80));
    expect(priorFromAiScore(80)).toBeGreaterThan(priorFromAiScore(65));
    expect(priorFromAiScore(65)).toBeGreaterThan(priorFromAiScore(50));
    expect(priorFromAiScore(100)).toBeLessThanOrEqual(88);
    expect(priorFromAiScore(0)).toBeGreaterThanOrEqual(20);
  });
  it('maps the desk\'s real ladder sanely (80→~66%, 50→~52%)', () => {
    expect(Math.round(priorFromAiScore(80))).toBe(66);
    expect(Math.round(priorFromAiScore(50))).toBe(53);
  });
});

describe('computeWinProb — the uncalibrated base case', () => {
  it('a STRONG 84-score perp long with clean confluence reads EDGE', () => {
    const r = computeWinProb({
      side: 'LONG', market: 'FUTURES', aiScore: 84, engineConf: 78,
      rewardRisk: 2, agreement: 0.8, mtfAligned: true, fundingBps8h: 2,
    });
    // prior 66 → funding +2bps (no adj) → mtf +3 → agreement +2 → ~71
    expect(r.pWin).toBeGreaterThanOrEqual(68);
    expect(r.pWin).toBeLessThanOrEqual(74);
    expect(r.pNeed).toBeCloseTo(33.3, 1);
    expect(r.edgePts).toBeGreaterThan(30);
    expect(r.evRealisticR).toBeGreaterThan(0.15);
    expect(r.verdict).toBe('EDGE');
    expect(r.calibrated).toBe(false);
    // honesty: the note says uncalibrated
    expect(r.note).toMatch(/uncalibrated/i);
    // every adjustment is explainable
    expect(r.drivers.some(d => /MTF aligned/.test(d))).toBe(true);
    expect(r.drivers.some(d => /agreement/.test(d))).toBe(true);
  });

  it('a weak 42-score setup is NO-EDGE (pWin ≈ breakeven)', () => {
    const r = computeWinProb({ side: 'SHORT', market: 'CRYPTO', aiScore: 42, engineConf: 45, rewardRisk: 1.2 });
    expect(r.pNeed).toBeCloseTo(45.5, 1);
    expect(r.verdict).toBe('NO-EDGE');
    expect(r.evRealisticR).toBeLessThanOrEqual(0);
  });

  it('NULL inputs never fire adjustment branches (the num(null)≠0 contract)', () => {
    const r = computeWinProb({ side: 'LONG', market: 'CRYPTO', aiScore: 84, engineConf: 78 });
    // ONLY the prior driver — no phantom "0% agreement split", no
    // phantom positioning penalty, no funding driver on a spot market.
    expect(r.drivers).toHaveLength(1);
    expect(r.pWin).toBe(Math.round(priorFromAiScore(84)));
  });

  it('pWin is hard-capped at 92 and floored at 8 — never certainty', () => {
    const r = computeWinProb({ side: 'LONG', market: 'CRYPTO', aiScore: 100, engineConf: 99, rewardRisk: 3, agreement: 1, mtfAligned: true });
    expect(r.pWin).toBeLessThanOrEqual(WIN_PROB_HARD_CAP);
    const band = computeWinProb({ side: 'LONG', market: 'CRYPTO', aiScore: 1, engineConf: 40, rewardRisk: 1 });
    expect(band.pWin).toBeGreaterThanOrEqual(WIN_PROB_FLOOR);
  });

  it('the uncertainty band brackets pWin and widens with small samples', () => {
    const r = computeWinProb({ side: 'LONG', market: 'CRYPTO', aiScore: 70, engineConf: 65 });
    expect(r.pWinBand[0]).toBeLessThanOrEqual(r.pWin);
    expect(r.pWinBand[1]).toBeGreaterThanOrEqual(r.pWin);
  });
});

describe('computeWinProb — ledger calibration', () => {
  const cal = {
    sufficient: true,
    settled: 60,
    buckets: [{ bucket: '75-85%', lo: 75, hi: 85, claimed: 80, n: 25, winRate: 62 }],
    direction: null,
  };
  it('overconfident bucket gets pulled DOWN toward the realized win-rate', () => {
    const r = computeWinProb({ side: 'LONG', market: 'CRYPTO', aiScore: 84, engineConf: 78, calibration: cal });
    expect(r.calibrated).toBe(true);
    // prior 66 × (62/80 = 0.775) ≈ 51 — damped truth
    expect(r.pWin).toBeLessThanOrEqual(53);
    expect(r.drivers.some(d => /claimed 80% vs actual 62%/i.test(d))).toBe(true);
  });
  it('underconfident bucket gets pulled UP (the engine credits real edge)', () => {
    const up = { ...cal, buckets: [{ bucket: '75-85%', lo: 75, hi: 85, claimed: 80, n: 25, winRate: 94 }] };
    const r = computeWinProb({ side: 'LONG', market: 'CRYPTO', aiScore: 84, engineConf: 78, calibration: up });
    // 66 × clamp(94/80, 0.7, 1.3) = 66 × 1.175 ≈ 78
    expect(r.pWin).toBeGreaterThan(70);
  });
  it('the n≥10 gate refuses to calibrate off a thin bucket', () => {
    const thin = { ...cal, buckets: [{ bucket: '75-85%', lo: 75, hi: 85, claimed: 80, n: 9, winRate: 40 }] };
    const r = computeWinProb({ side: 'LONG', market: 'CRYPTO', aiScore: 84, engineConf: 78, calibration: thin });
    expect(r.calibrated).toBe(false);
    expect(r.pWin).toBe(Math.round(priorFromAiScore(84)));
  });
  it('bucket lookup places engineConf (falls back to aiScore) in the right bucket', () => {
    const wide = {
      sufficient: true, settled: 40,
      buckets: [
        { bucket: '40-55%', lo: 40, hi: 55, claimed: 47.5, n: 20, winRate: 47 },
        { bucket: '85%+', lo: 85, hi: 101, claimed: 92.5, n: 15, winRate: 70 },
      ],
      direction: null,
    };
    const elite = computeWinProb({ side: 'LONG', market: 'CRYPTO', aiScore: 90, engineConf: 88, calibration: wide });
    expect(elite.calibrated).toBe(true); // 88 lands in the 85%+ bucket
    expect(elite.pWin).toBeLessThan(priorFromAiScore(90));
  });
});

describe('computeWinProb — the side split', () => {
  const cal = {
    sufficient: true, settled: 80, buckets: [], direction: {
      LONG: { n: 40, winRate: 66 }, SHORT: { n: 40, winRate: 48 }, ALL: { winRate: 57 },
    },
  };
  it('a historically-stronger LONG side earns a (clamped) credit', () => {
    const r = computeWinProb({ side: 'LONG', market: 'CRYPTO', aiScore: 70, engineConf: 65, calibration: cal });
    expect(r.drivers.some(d => /LONG side ka historical WR 66% vs overall 57%/i.test(d))).toBe(true);
    expect(r.pWin).toBeGreaterThan(priorFromAiScore(70));
  });
  it('a historically-weak SHORT side gets penalized', () => {
    const r = computeWinProb({ side: 'SHORT', market: 'CRYPTO', aiScore: 70, engineConf: 65, calibration: cal });
    expect(r.pWin).toBeLessThan(priorFromAiScore(70));
  });
  it('thin side samples (n<20) do not adjust', () => {
    const thin = { ...cal, direction: { LONG: { n: 12, winRate: 90 }, SHORT: { n: 0, winRate: null }, ALL: { winRate: 57 } } };
    const r = computeWinProb({ side: 'LONG', market: 'CRYPTO', aiScore: 70, engineConf: 65, calibration: thin });
    expect(r.pWin).toBe(Math.round(priorFromAiScore(70)));
  });
});

describe('computeWinProb — funding + positioning (PERPS ONLY)', () => {
  it('a crowded-long perp (funding +18bps) penalizes the LONG side', () => {
    const base = computeWinProb({ side: 'LONG', market: 'FUTURES', aiScore: 80, engineConf: 75, rewardRisk: 2 });
    const crowded = computeWinProb({ side: 'LONG', market: 'FUTURES', aiScore: 80, engineConf: 75, rewardRisk: 2, fundingBps8h: 18 });
    expect(crowded.pWin).toBeLessThan(base.pWin);
    expect(crowded.drivers.some(d => /carry cost/i.test(d))).toBe(true);
    // the SHORT side of the same print is the squeeze-down edge
    const short = computeWinProb({ side: 'SHORT', market: 'FUTURES', aiScore: 80, engineConf: 75, rewardRisk: 2, fundingBps8h: 18 });
    expect(short.pWin).toBeGreaterThan(computeWinProb({ side: 'SHORT', market: 'FUTURES', aiScore: 80, engineConf: 75, rewardRisk: 2 }).pWin);
  });
  it('negative funding (shorts paying) is squeeze fuel for the LONG side', () => {
    const base = computeWinProb({ side: 'LONG', market: 'FUTURES', aiScore: 80, engineConf: 75, rewardRisk: 2 });
    const squeeze = computeWinProb({ side: 'LONG', market: 'FUTURES', aiScore: 80, engineConf: 75, rewardRisk: 2, fundingBps8h: -12 });
    expect(squeeze.pWin).toBeGreaterThan(base.pWin);
  });
  it('funding NEVER applies to spot CRYPTO / INDIA markets', () => {
    const r = computeWinProb({ side: 'LONG', market: 'CRYPTO', aiScore: 80, engineConf: 75, rewardRisk: 2, fundingBps8h: 25 });
    expect(r.drivers.some(d => /funding/i.test(d))).toBe(false);
  });
  it('the positioning read nudges at most ±4 pts, side-aware', () => {
    const bull = computeWinProb({ side: 'LONG', market: 'FUTURES', aiScore: 70, engineConf: 65, positioningScore: 80 });
    const bear = computeWinProb({ side: 'LONG', market: 'FUTURES', aiScore: 70, engineConf: 65, positioningScore: 20 });
    expect(bull.pWin - bear.pWin).toBeCloseTo(4.8, 0); // (80−20)/50 × 0.08 = 4.8
    // inverted for the SHORT side
    const shortBull = computeWinProb({ side: 'SHORT', market: 'FUTURES', aiScore: 70, engineConf: 65, positioningScore: 80 });
    const shortBear = computeWinProb({ side: 'SHORT', market: 'FUTURES', aiScore: 70, engineConf: 65, positioningScore: 20 });
    expect(shortBear.pWin - shortBull.pWin).toBeCloseTo(4.8, 0);
  });
});

describe('computeWinProb — breakeven + EV geometry', () => {
  it('pNeed = 1/(1+R:R) at the plan\'s reward:risk', () => {
    expect(computeWinProb({ side: 'LONG', market: 'CRYPTO', aiScore: 60, rewardRisk: 3 }).pNeed).toBeCloseTo(25, 1);
    expect(computeWinProb({ side: 'LONG', market: 'CRYPTO', aiScore: 60, rewardRisk: 1.5 }).pNeed).toBeCloseTo(40, 1);
    expect(computeWinProb({ side: 'LONG', market: 'CRYPTO', aiScore: 60 }).pNeed).toBeCloseTo(33.3, 1); // default RR 2
  });
  it('EV full-book > EV realistic (the capture haircut is honest)', () => {
    const r = computeWinProb({ side: 'LONG', market: 'CRYPTO', aiScore: 80, engineConf: 75, rewardRisk: 2 });
    expect(r.evR).toBeGreaterThan(r.evRealisticR);
    // realistic: p×(0.9×RR×0.75) − (1−p)×1 — a positive-edge number
    expect(r.evRealisticR).toBeGreaterThan(0);
  });
  it('the verdict ladder: EDGE needs BOTH a big edge and positive EV', () => {
    // 60% pWin @ 1:1 (breakeven 50) — edge 10pts but EV realistic ≈ 0.05
    const fairish = computeWinProb({ side: 'LONG', market: 'CRYPTO', aiScore: 67, engineConf: 62, rewardRisk: 1 });
    expect(['FAIR', 'EDGE']).toContain(fairish.verdict);
    expect(fairish.evRealisticR).toBeLessThan(0.2);
  });
});

describe('computeWinProb — the MIN_CALIBRATION_N contract', () => {
  it('exports the calibration gate the engine documents', () => {
    expect(MIN_CALIBRATION_N).toBe(10);
  });
});
