// ============================================================
// server/ai/superIntel.js — v9 SUPERINTELLIGENCE PRO TRADER ENGINE
// ------------------------------------------------------------
// The Superintelligence layer that sits ON TOP of both Signal
// Boards (the 10-model committee board in the CoinDCX/AI Trading
// desk AND the dual-AI intraday scanner):
//
//   • computeSuperScore()  — the composite AI SCORE (0-100). It
//     blends THREE independent conviction sources:
//        1. ENGINE conviction  — committee confidence / quant
//           confidence / dual-AI consensus (the board's own number)
//        2. EXPERT factors     — the 7-factor expert score
//           (trend / momentum / volume / SMC / volatility /
//           regime / R:R) from expertPicks.intradayExpertFactors
//        3. AI verdict         — LLM council / Gemini+Groq dual-AI
//           confidence when present
//     …then applies the honest quality adjustments (extension
//     veto caps, MTF alignment, session gate, quorum caps,
//     counter-regime penalty). Tier ladder: 80+ = STRONG (the
//     user's "80+ AI score" filter), 85+ = ELITE.
//
//   • buildSuperBlueprint() — the full pro-trader ticket on every
//     signal: entry zone + entry TIMING window, leverage ladder
//     (liquidation-aware), staged exit plan (40/40/20 partials),
//     EXIT TIME (hard square-off clock for India / horizon-based
//     wall-clock for crypto) + invalidation note.
//
//   • intradayExpertFactors() — the 7-factor expert score for the
//     INTRADAY scanner's signal shape (no candles there — pure
//     field math, SMC abstains honestly at 50).
//
// PURITY: everything here is pure number-in → object-out. No
// fetches, no clock reads (time arrives as a parameter). That is
// what makes the tier ladder + leverage ladder + exit-clock math
// unit-testable (test/superIntel.test.ts).
// ============================================================
import { maxSaneLeverage } from './ensemble.js';
import { pricePrecision } from './expertPicks.js';

// ---------------- tier ladder ----------------
export const SUPER_TIERS = {
  ELITE: 85,   // 85+ — highest conviction, max futures leverage 6x
  STRONG: 80,  // 80+ — the user-facing "80+ AI score" bar
  ACTION: 65,  // 65-79 — tradeable, smaller size
  WATCH: 50,   // 50-64 — watch-only
};
export const SUPER_MIN_STRONG = SUPER_TIERS.STRONG;

const clamp = (v, lo = 1, hi = 99) => Math.max(lo, Math.min(hi, v));
const num = (v) => (v != null && Number.isFinite(Number(v)) ? Number(v) : null);
const pR = (v) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return Number(n.toFixed(pricePrecision(n)));
};

/** Tier from the final AI score. */
export function superTier(score) {
  const s = Number(score) || 0;
  if (s >= SUPER_TIERS.ELITE) return 'ELITE';
  if (s >= SUPER_TIERS.STRONG) return 'STRONG';
  if (s >= SUPER_TIERS.ACTION) return 'ACTION';
  if (s >= SUPER_TIERS.WATCH) return 'WATCH';
  return 'NEUTRAL';
}

// ---------------- composite AI score ----------------
/**
 * The SUPERINTELLIGENCE AI SCORE for one signal.
 *
 * Blend (when the AI verdict is present):
 *    45% engine conviction + 35% expert factors + 20% AI verdict
 * Without an AI verdict the weights redistribute:
 *    55% engine conviction + 45% expert factors
 *
 * Honest quality adjustments (from the PRO TRADER BRAIN layer):
 *   • extension veto   → hard cap 65 (never STRONG while extended)
 *   • MTF aligned     → +4, MTF misaligned → −4 (when available)
 *   • session closed  → −6 (India square-off window / market shut)
 *   • quorum-capped   → −4 (too few voting models)
 *   • counter-regime  → −6
 *   • agreement ≥ 80% → +3 (full committee alignment)
 *
 * @param {object} p
 * @param {number} p.engineConf      board conviction 0-100 (committee/quant)
 * @param {number|null} [p.expertScore] 7-factor expert score 0-100 (null = unavailable)
 * @param {number|null} [p.aiConf]    LLM/dual-AI confidence 0-100 (null = offline)
 * @param {object|null} [p.quality]   probrain quality verdict flags
 * @param {number|null} [p.agreement] committee agreement 0-1
 * @param {boolean} [p.counterTrend]  signal fights the market regime
 * @param {number|null} [p.cap]        HARD ceiling for the final score (e.g. the
 *                                     intraday B-grade is watch-only → 64)
 * @returns {{ aiScore: number, tier: string, drivers: string[] }}
 */
export function computeSuperScore({ engineConf, expertScore = null, aiConf = null, quality = null, agreement = null, counterTrend = false, cap = null }) {
  const eng = clamp(num(engineConf) ?? 0, 0, 100);
  const exp = expertScore != null ? clamp(num(expertScore), 0, 100) : null;
  const ai = aiConf != null ? clamp(num(aiConf), 0, 100) : null;

  let score;
  if (exp != null && ai != null) score = 0.45 * eng + 0.35 * exp + 0.20 * ai;
  else if (exp != null) score = 0.55 * eng + 0.45 * exp;
  else if (ai != null) score = 0.65 * eng + 0.35 * ai;
  else score = eng;

  const drivers = [];
  if (exp != null) drivers.push(`7-factor expert score ${Math.round(exp)}/100`);
  if (ai != null) drivers.push(`AI verdict ${Math.round(ai)}%`);
  drivers.push(`engine conviction ${Math.round(eng)}%`);

  const q = quality || {};
  let capped = null;
  if (q?.extension?.veto) { capped = 65; drivers.push('extension veto — score capped'); }
  const hardCap = num(cap);
  if (hardCap != null && (capped == null || hardCap < capped)) capped = hardCap;
  if (q?.mtf?.available) {
    if (q?.mtf?.aligned === true) { score += 4; drivers.push('HTF/LTF aligned (+4)'); }
    else if (q?.mtf?.aligned === false) { score -= 4; drivers.push('HTF/LTF conflict (−4)'); }
  }
  if (q?.session?.tradeable === false) { score -= 6; drivers.push('session gate (−6)'); }
  if (q?.quorumCapped) { score -= 4; drivers.push('quorum cap (−4)'); }
  if (counterTrend) { score -= 6; drivers.push('counter-regime (−6)'); }
  const ag = num(agreement);
  if (ag != null && ag >= 0.8) { score += 3; drivers.push(`${Math.round(ag * 100)}% agreement (+3)`); }

  score = Math.round(clamp(score));
  if (capped != null && score > capped) score = capped;
  return { aiScore: score, tier: superTier(score), drivers: drivers.slice(0, 4) };
}

// ---------------- exit clock ----------------
/**
 * Exit TIME for the blueprint.
 *   INDIA  → hard square-off clock (NSE intraday) + "abhi" context
 *   CRYPTO → horizon-based wall-clock: high volatility → 8h
 *            (intraday manage), sane → 72h (swing)
 * Returns { exitBy, horizon } — exitBy is a human IST string.
 */
export function exitClock({ market, atrPctLtp = null, now = Date.now(), sqOffBy = null }) {
  const mkt = String(market || 'CRYPTO').toUpperCase();
  const d = now instanceof Date ? now : new Date(now);
  const fmtIST = (dt) => dt.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false });

  if (mkt === 'INDIA') {
    return {
      exitBy: sqOffBy || '15:10 IST',
      horizon: { label: 'INTRADAY', hours: 6.25, note: 'NSE intraday — 15:10 IST se pehle square-off, position carry mat karo' },
    };
  }
  const high = atrPctLtp != null && atrPctLtp > 2.2;
  const hrs = high ? 8 : 72;
  const exitAt = new Date(d.getTime() + hrs * 3600_000);
  return {
    exitBy: `${fmtIST(exitAt)} IST`,
    horizon: high
      ? { label: 'INTRADAY', hours: 8, note: 'Volatility high hai — 8 ghante ke andar manage karo, overnight risk mat lo' }
      : { label: 'SWING', hours: 72, note: 'Volatility sane hai — 1-3 din ka swing hold kar sakte ho' },
  };
}

// ---------------- the blueprint ----------------
/**
 * Full SUPERINTELLIGENCE trade blueprint for one signal.
 * Pure math: prices arrive as numbers, time as `now`.
 *
 * Leverage ladder (liquidation-aware):
 *   FUTURES → min(maxSaneLeverage(SL-distance), tier cap)
 *             ELITE 6x · STRONG 5x · else 3x
 *   CRYPTO  → 1x (spot INR = cash-and-carry, no margin)
 *   INDIA   → 1x plan (MIS leverage broker-side hota hai — plan honest)
 */
export function buildSuperBlueprint({
  side, ltp, atr, aiScore, market, ema20 = null,
  entryZoneLow = null, entryZoneHigh = null,
  stopLoss, target1, target2, target3 = null,
  atrPctLtp = null, now = Date.now(), sqOffBy = null, changePct: _changePct = null,
}) {
  if (!(ltp > 0) || !Number.isFinite(stopLoss) || !Number.isFinite(target1)) return null;
  const long = String(side || 'LONG').toUpperCase() !== 'SHORT';
  const sgn = long ? 1 : -1;
  const mkt = String(market || 'CRYPTO').toUpperCase();
  const a = (atr != null && atr > 0) ? atr : ltp * 0.012;
  const score = clamp(num(aiScore) ?? 50, 0, 100);

  // --- entry zone (caller's zone if given, else ATR band; low edge
  //     floored at 50% of price so an absurd ATR can't push it negative) ---
  const zLo = Number.isFinite(entryZoneLow) && entryZoneLow > 0 ? entryZoneLow : Math.max(long ? ltp - 0.35 * a : ltp - 0.10 * a, ltp * 0.5);
  const zHi = Number.isFinite(entryZoneHigh) && entryZoneHigh > 0 ? entryZoneHigh : long ? ltp + 0.10 * a : ltp + 0.35 * a;

  // --- entry TIMING window ---
  const emaDist = ema20 != null && ema20 > 0 ? Math.abs(ltp - ema20) / a : 0;
  const timing = emaDist <= 0.5
    ? { mode: 'IMMEDIATE', note: `Price EMA ke ${emaDist.toFixed(1)}×ATR par hai — abhi entry window open hai (${pR(zLo)}–${pR(zHi)})` }
    : { mode: 'PULLBACK', note: `EMA (${pR(ema20)}) se ${emaDist.toFixed(1)}×ATR door — pullback zone ${pR(zLo)}–${pR(zHi)} me limit entry lagao` };

  // --- leverage ladder (liquidation-aware) ---
  const slDistPct = (Math.abs(ltp - stopLoss) / ltp) * 100;
  const sane = maxSaneLeverage(slDistPct, 10);
  const tierCap = score >= SUPER_TIERS.ELITE ? 6 : score >= SUPER_TIERS.STRONG ? 5 : 3;
  let leverage;
  if (mkt === 'FUTURES') leverage = Math.max(1, Math.min(sane, tierCap));
  else if (mkt === 'CRYPTO') leverage = 1;   // spot INR = cash, no margin
  else leverage = 1;                          // India equities: MIS broker-side
  const liquidation = leverage > 1 ? pR(long ? ltp * (1 - 0.95 / leverage) : ltp * (1 + 0.95 / leverage)) : null;
  const levNote = mkt === 'FUTURES'
    ? `${leverage}× margin (SL-distance sane-max ${sane}×, tier cap ${tierCap}×)${liquidation ? ` · liquidation ≈ ${liquidation}` : ''}`
    : mkt === 'CRYPTO' ? 'SPOT 1× — cash-and-carry, koi liquidation risk nahi' : 'MIS 1× plan — broker-side ~5× margin aapke broker par depend karta hai';

  // --- staged exit plan (40/40/20) ---
  const risk = Math.abs(ltp - stopLoss);
  const t3 = target3 != null && Number.isFinite(target3) && target3 > 0 ? target3 : ltp + sgn * 3 * risk;
  const exitPlan = [
    { at: pR(target1), bookPct: 40, action: `T1 ${pR(target1)} — 40% book + SL ko entry (${pR(ltp)}) pe breakeven` },
    { at: pR(target2), bookPct: 40, action: `T2 ${pR(target2)} — 40% book + bacha 20% trail (peak − 1×risk)` },
    { at: pR(t3), bookPct: 20, action: `T3 ${pR(t3)} — runner 20% exit / trail` },
  ];

  // --- exit clock ---
  const clock = exitClock({ market: mkt, atrPctLtp, now, sqOffBy });

  return {
    side: long ? 'LONG' : 'SHORT',
    entry: pR(ltp),
    entryZone: [pR(zLo), pR(zHi)],
    entryTiming: timing,
    stopLoss: pR(stopLoss),
    targets: { t1: pR(target1), t2: pR(target2), t3: pR(t3) },
    leverage,
    maxSaneLeverage: sane,
    liquidation,
    leverageNote: levNote,
    exitPlan,
    exitBy: clock.exitBy,
    horizon: clock.horizon,
    invalidation: `SL ${pR(stopLoss)} break → pick cancel, koi averaging nahi${mkt !== 'INDIA' ? ' · BTC regime flip bhi invalid' : ''}`,
  };
}

// ---------------- intraday 7-factor expert score ----------------
/**
 * Expert factors for the INTRADAY scanner's signal shape (no
 * candles on that path — pure field math, SMC abstains at 50).
 * Side-aware like expertPicks: every factor grades the IMPLIED
 * direction. Returns { score, factors[] } (0-100).
 */
export function intradayExpertFactors(sig, regime = null) {
  if (!sig) return null;
  const long = String(sig.direction || 'LONG').toUpperCase() !== 'SHORT';
  const sgn = long ? 1 : -1;
  const ltp = num(sig.ltp) || 0;
  if (!(ltp > 0)) return null;
  const atr = num(sig.atr) || ltp * 0.02;

  // 1. TREND — ADX + trendStrength label
  const adx = num(sig.adx) ?? 20;
  const ts = sig.trendStrength;
  let trend = 50;
  trend += adx >= 28 ? 26 : adx >= 22 ? 16 : adx >= 16 ? 4 : -12;
  if (ts === 'STRONG') trend += 12; else if (ts === 'BUILDING') trend += 6; else if (ts === 'WEAK-RANGE') trend -= 10;
  trend = clamp(trend, 0, 100);

  // 2. MOMENTUM — RSI sweet zone vs direction
  const rsi = num(sig.rsi) ?? 50;
  let momentum = 50;
  if (long ? (rsi >= 52 && rsi <= 68) : (rsi >= 32 && rsi <= 48)) momentum += 24;
  else if (long ? (rsi >= 46 && rsi < 52) : (rsi > 48 && rsi <= 54)) momentum += 8;
  else if (long ? rsi > 78 : rsi < 22) momentum -= 18;           // exhaustion
  else momentum -= 8;
  const chg = num(sig.changePct);
  if (chg != null) { if (chg * sgn > 0.4) momentum += 6; else if (chg * sgn < -0.6) momentum -= 6; }
  momentum = clamp(momentum, 0, 100);

  // 3. VOLUME — session-paced relative volume
  const vr = num(sig.volumeRatio) ?? 1;
  let volume = 50;
  if (vr >= 2.0) volume += 34; else if (vr >= 1.5) volume += 26; else if (vr >= 1.2) volume += 16; else if (vr >= 0.9) volume += 4; else volume -= 16;
  volume = clamp(volume, 0, 100);

  // 4. VOLATILITY — ATR% rideable + gap sanity
  const atrPct = (atr / ltp) * 100;
  let volatility = 50;
  if (atrPct >= 0.5 && atrPct <= 2.5) volatility += 18;
  else if (atrPct > 4) volatility -= 16;
  const gap = num(sig.gapPct);
  if (gap != null && Math.abs(gap) > 2.5) volatility -= 8;       // gap risk
  volatility = clamp(volatility, 0, 100);

  // 5. REGIME — market gate vs direction
  let reg = 50;
  const r = regime || {};
  if (r.regime === 'BULLISH') reg += long ? 18 : -18;
  else if (r.regime === 'BEARISH') reg += long ? -18 : 18;
  if (r.vixLevel === 'HIGH') reg -= 6;
  reg = clamp(reg, 0, 100);

  // 6. R:R — slippage-adjusted reward geometry
  const rrEff = num(sig.effRR) ?? num(sig.rr) ?? 0;
  let rr = 50;
  if (rrEff >= 2.0) rr += 32; else if (rrEff >= 1.6) rr += 24; else if (rrEff >= 1.3) rr += 10; else if (rrEff < 1.0) rr -= 20;
  rr = clamp(rr, 0, 100);

  // 7. SMC — no candles on this path: honest neutral
  const smc = 50;

  const W = { trend: 0.24, momentum: 0.20, volume: 0.16, smc: 0.08, volatility: 0.12, regime: 0.10, rr: 0.10 };
  const score = Math.round(clamp(
    W.trend * trend + W.momentum * momentum + W.volume * volume + W.smc * smc
    + W.volatility * volatility + W.regime * reg + W.rr * rr, 0, 100));

  const factors = [
    { key: 'trend', label: 'Trend Structure', value: Math.round(trend), weight: W.trend },
    { key: 'momentum', label: 'Momentum', value: Math.round(momentum), weight: W.momentum },
    { key: 'volume', label: 'Volume Flow', value: Math.round(volume), weight: W.volume },
    { key: 'smc', label: 'SMC / ICT', value: smc, weight: W.smc },
    { key: 'volatility', label: 'Volatility Fit', value: Math.round(volatility), weight: W.volatility },
    { key: 'regime', label: 'Market Regime', value: Math.round(reg), weight: W.regime },
    { key: 'rr', label: 'R:R Quality', value: Math.round(rr), weight: W.rr },
  ];
  return { score, factors, atrPct };
}

// ---------------- v18.6.1 between-cycle live invalidation ----------------
/**
 * Cheap between-cycle sanity check: has the live price already moved
 * materially against the thesis since the plan was built, WITHOUT
 * waiting for the next full board recompute (~60s cadence)?
 *   LONG  → INVALIDATED if liveLtp <= stopLoss
 *   SHORT → INVALIDATED if liveLtp >= stopLoss
 *   Otherwise, if liveLtp has moved > 0.5×ATR beyond the FAR (adverse)
 *   edge of the entry zone — the pullback already ran past the intended
 *   buy/sell zone with no reversal — flag WEAKENING (soft warn, not a
 *   hard SL hit).
 * Pure. The frontend mirror (src/components/aitrading/
 * liveInvalidation.ts) runs this on EVERY SSE price tick against the
 * frozen plan; export here is the canonical server-side copy (tests +
 * future server-side stamping). No side effects, never throws.
 */
export function liveInvalidationCheck({ side, liveLtp, stopLoss, entryZoneLow = null, entryZoneHigh = null, atr = null }) {
  const px = Number(liveLtp);
  const sl = Number(stopLoss);
  if (!(px > 0) || !Number.isFinite(sl)) return { status: 'ok', reason: '' };
  const long = String(side || '').toUpperCase() !== 'SHORT';
  if (long ? px <= sl : px >= sl) {
    return { status: 'invalidated', reason: 'live price already through stop-loss — plan is stale, do not enter' };
  }
  const farEdge = long ? Number(entryZoneLow) : Number(entryZoneHigh);
  const a = Number(atr) > 0 ? Number(atr) : px * 0.012; // 1.2% fallback when ATR unknown
  // v20.7.12 [L-3] (frontend-mirror sync): DIRECTIONAL check — pehle
  // Math.abs se FAVOURABLE move bhi WEAKENING flag hota tha. Ab sirf
  // ADVERSE direction flag hota hai (frontend twin liveInvalidation.ts
  // ke saath behaviour-identical).
  if (Number.isFinite(farEdge) && farEdge > 0 && (long ? px < farEdge - 0.5 * a : px > farEdge + 0.5 * a)) {
    return { status: 'weakening', reason: 'price has moved well past the planned entry zone (against the plan) — re-check before entry' };
  }
  return { status: 'ok', reason: '' };
}
