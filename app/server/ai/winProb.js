// ============================================================
// server/ai/winProb.js — v12.0 WIN-PROBABILITY ENGINE
// ------------------------------------------------------------
// The "Highest Accuracy / Highest Win Trades" core. Every pro
// desk's first question is NOT "kya signal hai?" but "IS TRADE
// ME KITNI PROBABILITY HAI aur expected value kya hai?" — this
// engine answers exactly that, with numbers it can defend:
//
//   P(WIN)  = calibrated blend of:
//     1. AI SCORE prior            (the superintelligence verdict)
//     2. LEDGER CALIBRATION        (what ACTUALLY happened at this
//                                   confidence bucket historically —
//                                   trust.js's settled outcomes)
//     3. SIDE SPLIT                (LONG vs SHORT historical WR)
//     4. FUNDING / POSITIONING     (perps: crowded-side penalty,
//                                   squeeze-side bonus)
//     5. MTF + REGIME + AGREEMENT  (confluence adjustments)
//
//   P(NEED) = 1 / (1 + R:R) — the breakeven win-rate for the
//             plan's reward:risk. EDGE = P(WIN) − P(NEED).
//   EV(R)   = expected R-multiples per trade with the 40/40/20
//             partial book and a realistic capture haircut.
//
// HONESTY CONTRACT:
//   • P(WIN) is hard-capped at 92% — the engine NEVER claims
//     certainty; a "92" reads "strong, not guaranteed".
//   • Without ≥10 settled ledger outcomes the engine says
//     "uncalibrated" — no fake history, just the prior.
//   • Every adjustment arrives with a driver string (±pts) so
//     the card can show WHY the number is what it is.
//
// PURITY: computeWinProb() is pure (all numbers in, object out)
// — unit-locked in test/winProb.test.ts. calibrationSnapshot()
// is the only IO wrapper (5-min cached trust.js read).
// ============================================================
import { trustReport } from './trust.js';

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
// null/undefined → null (NEVER 0 — a missing input must not silently
// fire its adjustment branch)
const num = (v) => (v == null ? null : (Number.isFinite(Number(v)) ? Number(v) : null));
const r1 = (v) => (Number.isFinite(v) ? Math.round(v * 10) / 10 : null);
const r2 = (v) => (Number.isFinite(v) ? Math.round(v * 100) / 100 : null);

export const WIN_PROB_HARD_CAP = 92;    // never certainty
export const WIN_PROB_FLOOR = 8;        // never impossible
export const MIN_CALIBRATION_N = 10;    // per bucket
const MIN_SIDE_N = 20;                  // for the LONG/SHORT split
const CAPTURE_HAIRCUT = 0.75;           // partial book realism (40/40/20, trail-outs)

/** Prior win-probability from the AI score (uncalibrated start). */
export function priorFromAiScore(aiScore) {
  const s = clamp(num(aiScore) ?? 50, 0, 100);
  return clamp(30 + s * 0.45, 20, 88); // 80 → 66% · 85 → 68% · 50 → 52.5% · 90 → 70.5%
}

/**
 * The calibrated WIN PROBABILITY for one setup. PURE.
 *
 * @param {object} p
 * @param {string} p.side                 'LONG' | 'SHORT'
 * @param {string} p.market               'CRYPTO' | 'FUTURES' | 'INDIA' | 'GLOBALFUTURES'
 * @param {number} p.aiScore              superintelligence AI score 0-100
 * @param {number|null} [p.engineConf]    committee/expert confidence 0-100 (drives calibration bucket)
 * @param {number|null} [p.rewardRisk]    plan R:R (default 2)
 * @param {number|null} [p.agreement]     committee agreement 0-1
 * @param {boolean|null} [p.mtfAligned]   MTF confluence verdict
 * @param {boolean} [p.counterRegime]     signal fights the regime
 * @param {number|null} [p.fundingBps8h]  perp funding (FUTURES only)
 * @param {number|null} [p.positioningScore] perpIntel read score 0-100 (LONG-aligned)
 * @param {object|null} [p.calibration]   calibrationSnapshot() output (null = uncalibrated)
 * @returns {{pWin:number,pWinBand:[number,number],pNeed:number,edgePts:number,evR:number,evRealisticR:number,verdict:string,calibrated:boolean,drivers:string[],note:string}}
 */
export function computeWinProb({
  side, market, aiScore, engineConf = null, rewardRisk = null, agreement = null,
  mtfAligned = null, counterRegime = false, fundingBps8h = null, positioningScore = null,
  calibration = null,
}) {
  const long = String(side || 'LONG').toUpperCase() !== 'SHORT';
  const mkt = String(market || 'CRYPTO').toUpperCase();
  const isPerp = mkt === 'FUTURES';
  const rrRaw = num(rewardRisk);
  const rr = rrRaw != null && rrRaw > 0 ? rrRaw : 2;

  const drivers = [];
  let p = priorFromAiScore(aiScore);
  drivers.push(`AI score ${Math.round(clamp(num(aiScore) ?? 50, 0, 100))}/100 → prior ${Math.round(p)}%`);

  // --- 2. ledger calibration (what ACTUALLY happened at this confidence) ---
  let calibrated = false;
  const cal = calibration || null;
  const claimConf = clamp(num(engineConf) ?? num(aiScore) ?? 50, 40, 99);
  if (cal?.sufficient && Array.isArray(cal.buckets)) {
    const bucket = cal.buckets.find(b => claimConf >= b.lo && claimConf < b.hi);
    if (bucket && num(bucket.n) >= MIN_CALIBRATION_N && num(bucket.claimed) > 0 && num(bucket.winRate) != null) {
      const corr = clamp(num(bucket.winRate) / num(bucket.claimed), 0.70, 1.30);
      p = p * corr;
      calibrated = true;
      drivers.push(`ledger: ${bucket.bucket} me claimed ${r1(bucket.claimed)}% vs actual ${r1(bucket.winRate)}% (n=${bucket.n}) → ${corr > 1 ? '+' : ''}${r1((corr - 1) * 100)}%`);
    }
  }

  // --- 3. side split (LONG vs SHORT historical WR) ---
  if (cal?.sufficient && cal.direction) {
    const d = long ? cal.direction.LONG : cal.direction.SHORT;
    const all = cal.direction.ALL;
    if (d && all && num(d.n) >= MIN_SIDE_N && num(all.winRate) > 0 && num(d.winRate) != null) {
      const corr = clamp(num(d.winRate) / num(all.winRate), 0.85, 1.15);
      if (corr !== 1) {
        p = p * corr;
        drivers.push(`${long ? 'LONG' : 'SHORT'} side ka historical WR ${r1(d.winRate)}% vs overall ${r1(all.winRate)}% → ${corr > 1 ? '+' : ''}${r1((corr - 1) * 100)}%`);
      }
    }
  }

  // --- 4. funding + positioning (PERPS only) ---
  if (isPerp) {
    const fBps = num(fundingBps8h);
    if (fBps != null) {
      if (long) {
        if (fBps > 10) { const pen = Math.min(6, 0.2 * (fBps - 10)); p -= pen; drivers.push(`funding +${r1(fBps)}bps/8h — longs ka carry cost (−${r1(pen)}pts)`); }
        else if (fBps < -3) { const bon = Math.min(4, 0.25 * (-fBps - 3)); p += bon; drivers.push(`funding ${r1(fBps)}bps/8h — shorts pay kar rahe, squeeze fuel (+${r1(bon)}pts)`); }
      } else {
        if (fBps > 10) { const bon = Math.min(4, 0.15 * (fBps - 10)); p += bon; drivers.push(`funding +${r1(fBps)}bps/8h — crowded longs, short side squeeze-down edge (+${r1(bon)}pts)`); }
        else if (fBps < -3) { const pen = Math.min(6, 0.3 * (-fBps - 3)); p -= pen; drivers.push(`funding ${r1(fBps)}bps/8h — short carry + squeeze-up risk (−${r1(pen)}pts)`); }
      }
    }
    const pos = num(positioningScore);
    if (pos != null) {
      const adj = clamp(((long ? pos : 100 - pos) - 50) * 0.08, -4, 4);
      if (adj !== 0) { p += adj; drivers.push(`positioning read ${Math.round(long ? pos : 100 - pos)}/100 (${adj > 0 ? '+' : ''}${r1(adj)}pts)`); }
    }
  }

  // --- 5. confluence adjustments ---
  if (mtfAligned === true) { p += 3; drivers.push('MTF aligned (+3)'); }
  else if (mtfAligned === false) { p -= 3; drivers.push('MTF conflict (−3)'); }
  if (counterRegime) { p -= 4; drivers.push('counter-regime (−4)'); }
  const ag = num(agreement);
  if (ag != null && ag >= 0.75) { p += 2; drivers.push(`${Math.round(ag * 100)}% committee agreement (+2)`); }
  else if (ag != null && ag < 0.5) { p -= 2; drivers.push(`${Math.round(ag * 100)}% committee agreement — split (−2)`); }

  p = Math.round(clamp(p, WIN_PROB_FLOOR, WIN_PROB_HARD_CAP));

  // --- breakeven + EV ---
  const pNeed = Math.round((100 / (1 + rr)) * 10) / 10;            // % needed at 1:RR
  const edgePts = Math.round((p - pNeed) * 10) / 10;
  const fullBookR = 0.4 * (rr * 0.5) + 0.4 * rr + 0.2 * (rr * 1.5); // T1≈RR/2 · T2=RR · T3=1.5RR
  const capturedR = fullBookR * CAPTURE_HAIRCUT;                     // trail-outs + not-all-targets realism
  const evR = r2((p / 100) * fullBookR - (1 - p / 100) * 1.0);
  const evRealisticR = r2((p / 100) * capturedR - (1 - p / 100) * 1.0);
  const verdict = (edgePts >= 8 && evRealisticR > 0.15) ? 'EDGE' : (evRealisticR > 0 ? 'FAIR' : 'NO-EDGE');

  // --- uncertainty band (Wald 95%, effective n = settled outcomes or floor 30) ---
  const nEff = Math.max(30, num(cal?.settled) ?? 30);
  const half = Math.min(20, Math.max(6, Math.round(196 * Math.sqrt((p / 100) * (1 - p / 100) / nEff))));
  const band = [Math.max(WIN_PROB_FLOOR, p - half), Math.min(WIN_PROB_HARD_CAP, p + half)];

  return {
    pWin: p,
    pWinBand: band,
    pNeed,
    edgePts,
    evR,
    evRealisticR,
    verdict,
    calibrated,
    drivers: drivers.slice(0, 6),
    note: calibrated
      ? `Ledger-calibrated (settled outcomes: ${nEff}). Breakeven ${pNeed}% @ 1:${rr}. EV realistic ${evRealisticR}R/trade.`
      : `Uncalibrated prior (ledger me abhi ≥${MIN_CALIBRATION_N} settled outcomes nahi is bucket me) — trade settle hone par yeh number khud sudhrega. Breakeven ${pNeed}% @ 1:${rr}.`,
  };
}

// ---------------- calibration snapshot (IO, cached 5 min) ----------------
let _calSnap = { at: 0, val: null };
/**
 * Compact trust.js snapshot for the engine: bucket claimed-vs-actual
 * + LONG/SHORT split. Cached 5 min (trust reads the whole ledger).
 */
export async function calibrationSnapshot() {
  if (_calSnap.val && Date.now() - _calSnap.at < 5 * 60_000) return _calSnap.val;
  let val = null;
  try {
    const rep = trustReport(); // sync read over the settled ledger
    if (rep?.ok && rep.sufficient) {
      // trust.js buckets carry only the '40-55%' label — parse lo/hi out
      // so computeWinProb can place a confidence inside its bucket.
      const buckets = (rep.calibration || []).map(b => {
        const m = /^(\d+)%?\s*-\s*(\d+)%?$/.exec(String(b.bucket || ''));
        const plus = /^(\d+)%\+$/.exec(String(b.bucket || ''));
        const lo = m ? Number(m[1]) : plus ? Number(plus[1]) : null;
        const hi = m ? Number(m[2]) : plus ? 101 : null;
        return {
          bucket: b.bucket, lo, hi, claimed: b.claimed, n: b.n, winRate: b.winRate,
        };
      }).filter(b => b.lo != null && b.hi != null);
      val = {
        sufficient: true,
        settled: rep.settled,
        buckets,
        direction: {
          LONG: rep.direction?.LONG || null,
          SHORT: rep.direction?.SHORT || null,
          ALL: rep.overall || null,
        },
      };
    } else {
      val = { sufficient: false, settled: rep?.settled ?? 0, buckets: [], direction: null };
    }
  } catch {
    val = { sufficient: false, settled: 0, buckets: [], direction: null };
  }
  _calSnap = { at: Date.now(), val };
  return val;
}

// ---------------- test hooks ----------------
export function __resetWinProbForTests() { _calSnap = { at: 0, val: null }; }
export function __setCalibrationForTests(snap) { _calSnap = { at: Date.now(), val: snap }; }
