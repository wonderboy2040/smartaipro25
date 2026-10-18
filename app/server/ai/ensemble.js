// ============================================================
// server/ai/ensemble.js — weighted consensus + STRONG gating
// ------------------------------------------------------------
// PURE aggregation: turns N model votes into ONE consensus signal.
// The STRONG grade here is THE execution gate — the order layer
// (coindcxOrders.js) re-checks it server-side before any live order.
//
//   confidence = |weighted score| blended with agreement ratio
//   agreement   = share of voting weight on the winning side
//   grade       = STRONG (≥ minConfidence AND agreement ≥ minAgreement)
//                 ACTION / WATCH / NEUTRAL below that
// ============================================================

import { pRound, pRoundLadder, MAX_STOP_FRACTION } from './lib/priceRound.js';

// v21.3.0 (Issue-3): sub-noise stop floor — the swing-structure stop may
// tighten the ATR baseline stop at most to this fraction of ONE ATR. A
// stop closer than 0.6×ATR sits inside normal fill noise (the "SAB SL
// hit" class). Env override for traders who want the raw structure stop.
export const MIN_STOP_ATR_FRACTION = (() => {
  const n = Number.parseFloat(String(process.env.AI_MIN_STOP_ATR_FRACTION ?? ''), 10);
  return Number.isFinite(n) && n > 0 && n <= 2 ? n : 0.6;
})();


export const DEFAULT_GATES = {
  minConfidence: 75,   // ensemble confidence ≥ this → STRONG-eligible
  minAgreement: 0.70,  // ≥ 70% of voting weight on the winning side
};

// v6.12 PRO-TRADER QUORUM CAPS — the fake-consensus killer.
// Pre-v6.12 a SINGLE loud model (conf 100) read as 74% confidence,
// 100% agreement, ACTION grade — the board displayed a one-factor
// EMA signal as a "9-model consensus" and paper trades died on it.
// Confidence is now capped by how many models actually voted:
//   voters 1-2 → hard cap below the ACTION line (WATCH max — a
//                 1-2 model "consensus" is a watchlist note, not a
//                 trade; paper/lucrative buttons refuse it)
//   voters 3   → cap 72 (STRONG impossible, ACTION reachable)
//   voters 4   → cap 85
//   voters ≥ 5 → no cap — real committee territory
export const QUORUM_CONF_CAPS = { 1: 52, 2: 54, 3: 72, 4: 85 };

// ---------------- v21.7.0 STRICT AGREEMENT CAP (accuracy upgrade) ----------------
// User ask: "Trading signals Accuracy ko Superintelligence se Upgrade
// kardo". The gap: STRONG needs agreement ≥0.70, but ACTION (conf ≥55)
// had NO agreement floor — a 55/45-weight SPLIT committee (jisme almost
// aadha board against hai) could still wear ACTION and execute paper
// entries. A split committee is a NO-TRADE, not a soft trade: ab
// agreement < AI_STRICT_AGREEMENT_MIN (default 0.62) par ACTION → WATCH
// cap lagta hai (board + deep dono paths, same post-pass pattern as the
// trust guards). Flag AI_STRICT_AGREEMENT=0/false → off (rollback).
export const STRICT_AGREEMENT_MIN = (() => {
  const v = Number.parseFloat(String(process.env.AI_STRICT_AGREEMENT_MIN ?? ''), 10);
  return Number.isFinite(v) && v >= 0.5 && v <= 0.9 ? v : 0.62;
})();

export function strictAgreementEnabled() {
  return !['false', '0', 'off', 'no'].includes(String(process.env.AI_STRICT_AGREEMENT || '').trim().toLowerCase());
}

/** PURE — cap a directional consensus to WATCH when the committee is
 * split. Returns the (possibly capped) consensus; never throws; FLAT /
 * null-agreement / STRONG untouched. Mirrors the veto-cap style. */
export function applyStrictAgreementCap(consensus, enabled = strictAgreementEnabled(), min = STRICT_AGREEMENT_MIN) {
  try {
    if (!enabled || !consensus || consensus.dir === 0) return consensus;
    const agr = Number(consensus.agreement);
    if (!Number.isFinite(agr) || agr >= min) return consensus;
    if (consensus.grade !== 'ACTION') return consensus; // only ACTION is capped (STRONG already needs ≥0.70)
    return {
      ...consensus,
      grade: 'WATCH',
      strictAgreementCap: true,
      summary: `${consensus.summary} · SPLIT CAP (agreement ${Math.round(agr * 100)}% < ${Math.round(min * 100)}%)`,
    };
  } catch { return consensus; }
}

/** PURE — v21.7.0 (Issue-1) F&O OPTIONS-CARD PLAN CONTEXT fix.
 * buildOptionSignalCards ka index-plan (target1/stopLoss → premium
 * re-price) pehle DAILY candles ke ctx se banta tha: ctx.ltp = Yahoo
 * daily close (ghanton purana) + ind.atr = DAILY ATR (~100-150 NIFTY
 * points) — jabki card ka Entry LIVE chain premium par tha. Result:
 * entry/exit systematically wrong (targets din-bhar ke move ke, SL
 * premium noise se kahin door). Ye helper options-flavor deep signals
 * ka plan-ctx banata hai: LIVE desk spot + 15m ATR (intraday
 * geometry). No-ops honestly when inputs absent. */
export function buildOptionsPlanCtx(ctx, opts, ltfInd) {
  if (!ctx) return ctx;
  const liveSpot = Number(opts?.liveSpot);
  const intraAtr = Number.isFinite(Number(ltfInd?.atr)) ? Number(ltfInd.atr) : NaN;
  const spotOk = Number.isFinite(liveSpot) && liveSpot > 0;
  const atrOk = Number.isFinite(intraAtr) && intraAtr > 0;
  if (!spotOk && !atrOk) return ctx;
  return {
    ...ctx,
    ...(spotOk ? { ltp: liveSpot } : {}),
    ...(atrOk ? { ind: { ...(ctx.ind || {}), atr: intraAtr } } : {}),
  };
}

const clamp = (v, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, v));
const r2 = (v) => Math.round(v * 100) / 100;
const r1 = (v) => Math.round(v * 10) / 10;

/**
 * Aggregate model votes into a consensus.
 *
 * v6.3 RECALIBRATION — the v6.0 formula (|Σ dir·w·conf| / ALL weight)
 * was mathematically starved: 3 abstaining models diluted every board
 * signal ~35% and the model conf scale topped out ~70, so confidence
 * could NEVER reach the 75% STRONG gate — the terminal showed only
 * WATCH/NEUTRAL cards and users saw "no trade signals".
 *
 * New decomposition (each factor is honest and inspectable):
 *   score         = raw / votingWeight  → the weighted-average conviction
 *                                          of the models that DID vote
 *   participation = votingWeight / applicableWeight → quorum (abstain =
 *                                          weaker committee mandate, not zero)
 *   agreement     = winWeight / votingWeight → side unison of voters
 *
 *   confidence = 100 × score × (0.60 + 0.40·agreement) × (0.70 + 0.30·participation)
 *
 * v11.8 APPLICABLE-QUORUM FIX: votes may carry `na: true` — a STRUCTURAL
 * abstain (a seat that cannot serve this market at all: OptionsFlow on
 * spot crypto, IntradayTape on crypto, FundaCheck on crypto, equity mesh
 * seats on the crypto desk…). Those seats used to sit in the
 * participation denominator and systematically shaved ~15% off every
 * board confidence ("6/17 models voting" on a desk where 6 of the 11
 * applicable seats HAD voted). The denominator now counts only seats
 * that COULD have voted — data-missing abstains still count against
 * quorum (honest), structural ones do not (fair).
 *
 * Calibrated so: a 5/8-model all-aligned bear stack reads ACTION (~66),
 * a full-committee confluence reads STRONG (75+), diluted or split
 * committees stay WATCH/NEUTRAL. Gates are UNCHANGED — only the scale
 * now actually reaches them.
 *
 * v10.5 opts.mtfAgreement (Upgrade 1 — MTF confluence): the 3-timeframe
 * (5m/15m/1h) agreement read, 0..1. When the timeframes DISAGREE
 * (< 0.67 — i.e. only the trading TF + at most nothing aligned) the
 * STRONG grade is banned regardless of the weighted score: a signal
 * fighting 2 of its 3 timeframes is practice-grade at best (the plan's
 * "MODERATE cap" — this ladder's equivalent below STRONG is ACTION).
 *
 * @param {{id,name,weight,dir,conf,reasons,na?}[]} votes
 * @param {object} gates { minConfidence, minAgreement }
 * @param {object} [opts] { mtfAgreement?: number|null }
 */
export function aggregateVotes(votes, gates = DEFAULT_GATES, opts = {}) {
  const valid = (votes || []).filter(v => v && typeof v.dir === 'number' && v.dir !== 0 && (v.conf || 0) > 0 && (v.weight || 0) > 0);
  const votingWeight = valid.reduce((a, v) => a + v.weight, 0);
  // v11.8: the quorum denominator = seats that could serve this market.
  // `na: true` marks structural abstains (see header). Weight-0 seats
  // (mesh shadow mode) were already excluded.
  const applicable = (votes || []).filter(v => v && (v.weight || 0) > 0 && !v.na);
  const allWeight = applicable.reduce((a, v) => a + v.weight, 0);

  if (votingWeight <= 0) {
    return {
      side: 'FLAT', dir: 0, confidence: 0, agreement: 0, participation: 0,
      grade: 'NEUTRAL', participating: 0, totalModels: applicable.length || (votes || []).length,
      summary: 'No model found a tradeable edge',
    };
  }

  const bull = valid.filter(v => v.dir > 0).reduce((a, v) => a + v.weight, 0);
  const bear = valid.filter(v => v.dir < 0).reduce((a, v) => a + v.weight, 0);
  // v12.7 (recheck R1-#5): an EXACT bull/bear weight tie is an honest
  // NO-EDGE — it used to default LONG (`bull >= bear`), which minted a
  // directional call the committee never actually made. Ties are rare
  // (float weights), but a tie breaking LONG is a silent directional
  // bias on every desk that shares this aggregator.
  if (bull === bear) {
    return {
      side: 'FLAT', dir: 0, confidence: 0, agreement: 0.5,
      participation: Math.round((votingWeight / (allWeight > 0 ? allWeight : votingWeight)) * 100) / 100,
      grade: 'NEUTRAL', participating: valid.length, totalModels: applicable.length || (votes || []).length,
      applicableModels: applicable.length,
      structuralAbsent: (votes || []).filter(v => v?.na).length,
      bullWeight: r2(bull), bearWeight: r2(bear), tie: true,
      voters: valid.length,
      summary: `Committee exactly split (bull weight ${r2(bull)} = bear weight ${r2(bear)}) — no edge`,
    };
  }
  const side = bull > bear ? 'LONG' : 'SHORT';
  const dir = side === 'LONG' ? 1 : -1;
  const winWeight = Math.max(bull, bear);
  const _loseWeight = Math.min(bull, bear);

  // Agreement: winning weight / voting weight (abstaining models don't count against).
  const agreement = winWeight / votingWeight;

  // Score: weighted-average conviction of the VOTING models (opposing
  // votes subtract from the winning side's average).
  const raw = valid.reduce((a, v) => a + v.dir * v.weight * ((v.conf || 0) / 100), 0);
  const score = Math.abs(raw) / votingWeight; // 0..1

  // Quorum: how much of the committee's weight actually showed up.
  const participation = allWeight > 0 ? votingWeight / allWeight : 1;

  let confidence = Math.round(clamp(
    score * 100 * (0.60 + 0.40 * agreement) * (0.70 + 0.30 * participation)
  ));

  // v6.12: quorum honesty — a 1-2 model "consensus" is not a
  // consensus. The cap is applied BEFORE the grade ladder so no
  // single-factor signal can ever wear the ACTION/STRONG badge.
  const voters = valid.length;
  const quorumCap = QUORUM_CONF_CAPS[voters];
  let quorumCapped = false;
  if (quorumCap != null && confidence > quorumCap) {
    confidence = quorumCap;
    quorumCapped = true;
  }

  let grade;
  if (confidence >= gates.minConfidence && agreement >= gates.minAgreement) grade = 'STRONG';
  else if (confidence >= 55) grade = 'ACTION';
  else if (confidence >= 35) grade = 'WATCH';
  else grade = 'NEUTRAL';

  // v10.5 MTF CONFLUENCE CAP (Upgrade 1): the plan's "confluence <
  // 0.67 → max MODERATE". This ladder's grade below STRONG is ACTION
  // (NEUTRAL < WATCH < ACTION < STRONG) — a high-score signal whose
  // 5m/15m/1h timeframes disagree can no longer wear STRONG, whatever
  // the weighted committee thinks (cap only ever TIGHTENS).
  // v10.5.1: "disagree" means FEWER than 2 of 3 timeframes aligned —
  // 2/3 itself PASSES (the plan's 0.67 ≈ 2/3; the float 2/3 = 0.666…
  // must not trip its own 2-of-3 case). Integer-exact via ×3.
  const _rawMtf = opts?.mtfAgreement;
  const mtfAgreement = _rawMtf == null ? null : (Number.isFinite(Number(_rawMtf)) ? Number(_rawMtf) : null);
  let mtfCapped = false;
  if (mtfAgreement != null && mtfAgreement * 3 < 2 - 1e-9 && grade === 'STRONG') {
    grade = 'ACTION';
    mtfCapped = true;
  }

  return {
    side, dir, confidence, agreement: Math.round(agreement * 100) / 100,
    participation: Math.round(participation * 100) / 100,
    grade,
    voters,
    quorumCapped: quorumCapped || undefined,
    ...(mtfAgreement != null ? { mtfAgreement: Math.round(mtfAgreement * 100) / 100 } : {}),
    mtfCapped: mtfCapped || undefined,
    participating: valid.length,
    totalModels: applicable.length,
    applicableModels: applicable.length,
    structuralAbsent: (votes || []).filter(v => v?.na).length,
    bullWeight: r2(bull), bearWeight: r2(bear),
    summary: `${side} ${confidence}% · ${valid.length}/${applicable.length} models voting · ${Math.round(agreement * 100)}% agreement · ${Math.round(participation * 100)}% quorum${quorumCapped ? ' · quorum-capped (few voters)' : ''}${mtfCapped ? ' · MTF-capped (timeframes disagree)' : ''}`,
  };
}

// ------------------------------------------------------------
// v10.6 REGIME-AWARE DYNAMIC MODEL REWEIGHTING (Pro Upgrade #4)
// ------------------------------------------------------------
// The 14 model weights are static constants — a trend-following model
// like TrendMatrix should matter more in a TRENDING regime and less
// in a CHOPPY one, but the code weighted it the same always. This is
// a multiplier LAYER on top of the existing base weights, applied on
// the weighted-average fallback path ONLY (the meta-ensemble path
// learns its own non-linear combinations — never double-adjusted).
//
// Gated by AI_ENABLE_REGIME_WEIGHTS (default OFF — the plan's own
// sequencing: backtest both ways (`--strategy regime_weighted`)
// before flipping the flag on live boards).
export function regimeWeightsEnabled() {
  return ['true', '1', 'on', 'yes'].includes(String(process.env.AI_ENABLE_REGIME_WEIGHTS || '').trim().toLowerCase());
}

/**
 * Classify the current market state — PURE.
 * @param {object} a { market, changePct, trend, vix }
 *   changePct: the gate index's 24h move (BTC for crypto, NIFTY for
 *              India, NDX for global). trend: 'UP'|'DOWN'|'FLAT'|null
 *              (the daily EMA20/50 tie-break from buildRegime).
 *              vix: IndiaVix / USVIX level (null for crypto).
 * @returns {'TRENDING'|'CHOPPY'|'HIGH_VOL'|'LOW_VOL'|null}
 */
export function classifyRegime({ market, changePct, trend, vix }) {
  // null/undefined must stay null (Number(null) === 0 — a missing VIX
  // must NEVER read as "calm = 0")
  const num = (v) => (v == null || v === '' ? null : (Number.isFinite(Number(v)) ? Number(v) : null));
  const ch = num(changePct);
  const vx = num(vix);
  const mkt = String(market || '').toUpperCase();
  const isCryptoish = mkt === 'CRYPTO' || mkt === 'FUTURES';
  const isGlobal = mkt === 'GLOBALFUTURES';
  const trendAligned = ch != null && trend && ((ch > 0 && trend === 'UP') || (ch < 0 && trend === 'DOWN'));

  if (isCryptoish) {
    if (ch == null) return null;
    if (Math.abs(ch) >= 2.5) return 'HIGH_VOL';
    if (Math.abs(ch) >= 0.75 && trendAligned) return 'TRENDING';
    if (Math.abs(ch) < 0.5 && (!trend || trend === 'FLAT')) return 'LOW_VOL';
    return 'CHOPPY';
  }
  // INDIA + GLOBAL (index gate + vol gauge)
  const strongMove = isGlobal ? 2.0 : 1.0;
  const dirMove = isGlobal ? 0.5 : 0.35;
  const calmVix = isGlobal ? 14 : 11;
  const hotVix = isGlobal ? 25 : 18;
  if (vx != null && vx >= hotVix) return 'HIGH_VOL';
  if (ch != null && Math.abs(ch) >= strongMove) return 'HIGH_VOL';
  if (ch != null && Math.abs(ch) >= dirMove && trendAligned) return 'TRENDING';
  if (vx != null && vx <= calmVix && (ch == null || Math.abs(ch) < dirMove)) return 'LOW_VOL';
  if (ch == null) return null;
  return 'CHOPPY';
}

/** Map a live buildRegime() payload into classifyRegime's inputs. */
export function classifyRegimeFor(regime, market) {
  if (!regime || typeof regime !== 'object') return null;
  const mkt = String(market || '').toUpperCase();
  if (mkt === 'CRYPTO' || mkt === 'FUTURES') {
    return classifyRegime({ market: mkt, changePct: regime.btcChange, trend: regime.btcTrend, vix: null });
  }
  if (mkt === 'GLOBALFUTURES') {
    return classifyRegime({ market: mkt, changePct: regime.ndxChange, trend: regime.ndxTrend, vix: regime.usVix });
  }
  return classifyRegime({ market: 'INDIA', changePct: regime.niftyChange, trend: regime.niftyTrend, vix: regime.indiaVix });
}

/** Rolling regime from a candle history (backtest path — no look-ahead:
 * everything computed from bars [0..i] only). */
export function classifyRegimeFromCandles(hist, market) {
  const closes = (hist || []).map(c => c.close);
  const n = closes.length;
  if (n < 60) return null;
  const lookback = 24;
  const ch = closes[n - 1 - lookback] > 0 ? ((closes[n - 1] / closes[n - 1 - lookback]) - 1) * 100 : null;
  const ema = (p) => {
    const k = 2 / (p + 1);
    let e = closes[0];
    for (let j = 1; j < n; j++) e = closes[j] * k + e * (1 - k);
    return e;
  };
  const e20 = ema(20), e50 = ema(50);
  const spread = e50 > 0 ? (e20 - e50) / e50 * 100 : 0;
  const trend = Math.abs(spread) < 0.5 ? 'FLAT' : spread > 0 ? 'UP' : 'DOWN';
  return classifyRegime({ market, changePct: ch, trend, vix: null });
}

// The multiplier table — deliberately MODEST (±25% max): this is a
// tilt, not a takeover; the base weights stay the spine. Unknown
// model ids default 1.0 (a new seat is never accidentally reweighted).
export const REGIME_MODEL_MULTIPLIERS = {
  TRENDING: { trend: 1.25, momentum: 1.15, smc: 1.15, tape: 1.15, 'tape-mtf': 1.15, volatility: 0.85, sr: 0.90, pattern: 0.95, volume: 1.05, regime: 1.10 },
  CHOPPY: { trend: 0.75, momentum: 0.80, smc: 0.80, tape: 0.85, 'tape-mtf': 0.85, volatility: 1.20, sr: 1.25, pattern: 1.10, volume: 1.00, regime: 1.00, instflow: 1.10 },
  HIGH_VOL: { trend: 0.85, momentum: 0.90, smc: 0.90, tape: 0.95, 'tape-mtf': 0.95, volatility: 1.25, sr: 1.05, pattern: 0.95, volume: 1.00, regime: 1.10, options: 1.05 },
  LOW_VOL: { trend: 1.10, momentum: 1.05, smc: 1.00, tape: 1.05, 'tape-mtf': 1.05, volatility: 0.80, sr: 0.95, pattern: 1.00, volume: 1.00, regime: 1.00 },
};

/** One model's multiplier under a regime label (1.0 when unknown). */
export function regimeMulFor(label, modelId) {
  if (!label) return 1;
  const m = REGIME_MODEL_MULTIPLIERS[label]?.[modelId];
  return Number.isFinite(m) && m > 0 ? Math.max(0.5, Math.min(1.5, m)) : 1;
}

/**
 * Apply the regime multipliers to a votes array (COPY — the input is
 * never mutated; adaptive weights may share the objects). label null /
 * flag OFF → votes returned as-is (byte-identical legacy path).
 * Adjusted votes carry regimeAdj { label, base, mul } for the UI.
 *
 * `force: true` bypasses the env flag — used ONLY by the backtest's
 * `--strategy regime_weighted` A/B mode (the whole point of which is
 * comparing the tilt BEFORE flipping the flag on live boards).
 */
export function applyRegimeWeights(votes, label, { force = false } = {}) {
  if (!label || (!force && !regimeWeightsEnabled())) return votes;
  const table = REGIME_MODEL_MULTIPLIERS[label];
  if (!table) return votes;
  return (votes || []).map(v => {
    const mul = regimeMulFor(label, v?.id);
    if (mul === 1) return v;
    return { ...v, weight: Math.round(v.weight * mul * 1000) / 1000, regimeAdj: { label, base: v.weight, mul } };
  });
}

/** Status view for /api/ai/trust + the dashboard panel. */
export function regimeReweightView(regime, market) {
  const enabled = regimeWeightsEnabled();
  const label = enabled ? classifyRegimeFor(regime, market) : null;
  const table = label ? REGIME_MODEL_MULTIPLIERS[label] : null;
  const names = { trend: 'TrendMatrix', momentum: 'MomentumQuant', volatility: 'VolatilityScope', volume: 'VolumeFlow', pattern: 'PatternNeural', sr: 'SRMatrix', options: 'OptionsFlow', regime: 'MacroRegime', smc: 'SmartMoneyICT', tape: 'IntradayTape', 'tape-mtf': 'IntradayTapeMTF', instflow: 'InstFlow' };
  return {
    enabled,
    label,
    note: enabled
      ? (label ? `regime=${label} — model weights tilted ±25% max (weighted-average path only; meta-ensemble untouched)` : 'regime inputs unavailable — base weights (no tilt)')
      : 'AI_ENABLE_REGIME_WEIGHTS off — static base weights (A/B against --strategy regime_weighted first)',
    downWeighted: table ? Object.entries(table).filter(([, m]) => m < 1).map(([id, m]) => ({ id, name: names[id] || id, mul: m })) : [],
    upWeighted: table ? Object.entries(table).filter(([, m]) => m > 1).map(([id, m]) => ({ id, name: names[id] || id, mul: m })) : [],
  };
}

// ------------------------------------------------------------
// v10.5 META-ENSEMBLE STACKING (Upgrade 4 — Node consume side)
// ------------------------------------------------------------
// AI_ENABLE_META_ENSEMBLE=true routes the raw model votes through
// the Python meta-learner (ml-service POST /meta-ensemble, LightGBM
// trained on the 29-feature vote contract). EVERY failure mode —
// service down, timeout, malformed response, feature mismatch —
// falls back to the deterministic weighted aggregateVotes(). A
// circuit breaker keeps the hot path clean: after one failure the
// calls are skipped for 5 minutes (no per-symbol timeout tax).
export function metaEnsembleEnabled() {
  // v21.12.0 (user ask: "META ensemble ON karna ml-service deploy ke
  // baad haa kardo"): DEFAULT ON. ml-service 8100 pe hai (v21.11.0
  // port-collision fix — 8000 kabhi probe nahi hota) + har
  // failure mode graceful hai (down/timeout/malformed → weighted
  // fallback + 5-min circuit breaker), isliye default-ON zero-risk hai.
  // ml-service band ho to bhi site normal chalta hai — meta sirf tab
  // bolta hai jab service zinda ho AUR weighted committee se agree kare.
  // Explicit `false` env override hamesha jeet-ta hai (A/B rollback).
  const raw = String(process.env.AI_ENABLE_META_ENSEMBLE ?? '').trim().toLowerCase();
  if (raw) return ['true', '1', 'on', 'yes'].includes(raw);
  return true;
}

// v21.11.0 PORT-COLLISION FIX: default 8000 → 8100 (historical: 8000
// Laya local AI ka home port tha — v21.14 me Laya remove ho chuka).
// Purana default ML-service ko bhi 8000 pe point karta tha — META flag
// ON karne par app us port pe garbage /meta-ensemble POST karti (404 →
// breaker → repeat). ml-service ab 8100 pe hai (main.py + Dockerfile
// synced). ML_SERVICE_URL env se override possible hi tha, par default
// hi galat port pe point karta tha.
const META_SERVICE_URL = () => String(process.env.ML_SERVICE_URL || 'http://127.0.0.1:8100').replace(/\/+$/, '');
// v21.12.0: exported — committee info banner + /health isko surface
// karte hain (ops ko dikhna chahiye meta kis endpoint pe try kar raha hai).
export const metaServiceUrl = META_SERVICE_URL;
const META_BREAKER_MS = 5 * 60_000;
const META_TIMEOUT_MS = 400;
let _metaBreakerAt = 0;

export function __resetMetaBreakerForTests() { _metaBreakerAt = 0; }

/** POST the raw votes to the Python meta-learner. null on ANY
 * problem (caller falls back to weighted). Pure transport. */
async function _callMetaService(votes, regime) {
  const now = Date.now();
  if (now - _metaBreakerAt < META_BREAKER_MS) return null;
  try {
    const body = JSON.stringify({
      votes: (votes || []).map(v => ({ id: v.id, dir: v.dir, conf: v.conf, weight: v.weight })),
      regime: String(regime || 'NEUTRAL').toUpperCase(),
    });
    const res = await fetch(`${META_SERVICE_URL()}/meta-ensemble`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // FIX v18.1: ml-service enforces ML_API_TOKEN (when set) — without
        // this header _callMetaService was ALWAYS 401, the breaker opened,
        // and the stacked meta-learner was silently dead in production.
        ...(process.env.ML_API_TOKEN ? { 'X-API-Key': process.env.ML_API_TOKEN } : {}),
      },
      body,
      signal: AbortSignal.timeout(META_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`meta-ensemble ${res.status}`);
    const j = await res.json();
    // response contract: { ok, side, confidence, agreement, grade, source }
    if (!j || j.ok !== true || !['LONG', 'SHORT', 'FLAT'].includes(j.side)
      || !Number.isFinite(Number(j.confidence)) || !['meta', 'weighted'].includes(j.source)) {
      throw new Error('meta-ensemble malformed response');
    }
    return j;
  } catch {
    _metaBreakerAt = Date.now(); // open the breaker — 5 min weighted-only
    return null;
  }
}

/**
 * Meta-aware aggregation: weighted consensus + (flag on) the Python
 * meta-learner's recombination. The meta result can only be USED when
 * it agrees with the weighted side — a combiner that flips sides
 * against its own committee is un-trustable in production. Response
 * carries source: 'meta' | 'weighted' for honest audit.
 */
export async function aggregateVotesWithMeta(votes, gates = DEFAULT_GATES, { regime, mtfAgreement } = {}) {
  const weighted = aggregateVotes(votes, gates, { mtfAgreement });
  if (!metaEnsembleEnabled()) return { ...weighted, source: 'weighted' };
  const meta = await _callMetaService(votes, regime);
  if (!meta || meta.source !== 'meta') {
    return { ...weighted, source: meta?.source || 'weighted' };
  }
  if (meta.side !== weighted.side || weighted.side === 'FLAT') {
    // honest disagreement — keep the weighted verdict, note the meta read
    return {
      ...weighted,
      source: 'weighted',
      metaRead: { side: meta.side, confidence: meta.confidence },
    };
  }
  // meta agrees with the weighted side → use its confidence/grade
  // (never LOWER than the honest quorum/MTF caps already applied)
  const conf = Math.max(5, Math.min(99, Math.round(meta.confidence)));
  let grade;
  if (conf >= gates.minConfidence && (meta.agreement ?? 0) >= gates.minAgreement) grade = 'STRONG';
  else if (conf >= 55) grade = 'ACTION';
  else if (conf >= 35) grade = 'WATCH';
  else grade = 'NEUTRAL';
  if (weighted.quorumCapped && conf > weighted.confidence) {
    // quorum caps are HONESTY caps — meta may not bypass them
    return { ...weighted, source: 'meta-capped', metaRead: { side: meta.side, confidence: conf } };
  }
  // v20.9.4 FIX (H2 wiring guard): MTF cap bhi honesty cap hai — pehle
  // sirf quorumCapped re-check hota tha, isliye ek meta STRONG 5m/15m/1h
  // disagreement (mtfCapped) ke upar se chipak sakta tha (board/deep dono
  // sites MTF cap ko PRE-META apply karte hain — meta usay undo na kare).
  if (weighted.mtfCapped && conf > weighted.confidence) {
    return { ...weighted, source: 'meta-capped', metaRead: { side: meta.side, confidence: conf } };
  }
  return {
    ...weighted,
    confidence: conf,
    grade,
    agreement: Number.isFinite(Number(meta.agreement)) ? Math.round(Number(meta.agreement) * 100) / 100 : weighted.agreement,
    source: 'meta',
    metaLabel: meta.label || null,
    summary: `${weighted.summary} · meta-ensemble ${meta.label || meta.side} ${conf}%`,
  };
}

/**
 * Build the full trade plan (entry / SL / targets / R:R) from the
 * consensus + the symbol's live context. ATR-based, engine-style:
 *   SL   = entry ∓ 1.4 × ATR      (crypto: 1.6 × ATR — 24/7 noise)
 *   T1   = entry ± 1.0 × R
 *   T2   = entry ± 2.0 × R
 */
export function buildTradePlan(consensus, ctx, market, opts = {}) {
  const ltp = ctx?.ltp;
  if (!consensus || consensus.dir === 0 || !(ltp > 0)) {
    return null;
  }
  const cryptoish = market === 'CRYPTO' || market === 'FUTURES' || market === 'GLOBALFUTURES'; // v6.8/v10.4: futures + global-equity SIM = 24/7 noise regime too
  const atr = ctx?.ind?.atr ?? (ctx?.indicators?.atr) ?? null;
  const atrFallback = ltp * (cryptoish ? 0.012 : 0.008);
  const a = atr != null && atr > 0 ? atr : atrFallback;
  const slMult = cryptoish ? 1.6 : 1.4;
  const long = consensus.dir > 0;
  // v9.2 STOP-DISTANCE CAP: an absurd ATR (micro-price meme coins,
  // thin Yahoo fallback candles) can put the stop 3.8× the price away —
  // LONG stop goes NEGATIVE, SHORT targets go negative. A stop wider
  // than 30% of price is untradeable fiction; the honest plan caps it
  // (30% keeps even the 3R target positive on both sides).
  const maxSlDist = ltp * MAX_STOP_FRACTION;
  let stopLoss = long ? ltp - Math.min(slMult * a, maxSlDist) : ltp + Math.min(slMult * a, maxSlDist);
  let planStyle = atr != null ? 'atr-based' : 'atr-fallback';
  if (slMult * a > maxSlDist) planStyle = `${planStyle}+stop-capped(30%)`;
  let structure = null;
  // v6.12: swing-structure stop — when the probrain layer found a
  // valid recent swing, the stop sits BEHIND the structure (padded
  // for noise) instead of in no-man's land. We take the TIGHTER of
  // (structure, ATR) so risk never widens versus the ATR baseline.
  const ss = opts.structureStop;
  if (ss && Number.isFinite(ss.sl) && ss.sl > 0) {
    // v6.12.1 belt-and-braces (recheck C-1): a structure stop is only
    // valid on the CORRECT side of entry (LONG: below ltp, SHORT:
    // above). A wrong-side stop would be an instant stop-out even if
    // some upstream layer let it through.
    const sideOk = long ? ss.sl < ltp : ss.sl > ltp;
    const tighter = long ? Math.max(stopLoss, ss.sl) : Math.min(stopLoss, ss.sl);
    if (sideOk && ((long && tighter > stopLoss && tighter < ltp) || (!long && tighter < stopLoss && tighter > ltp))) {
      // v21.3.0 (Issue-3: "4-5 paper trades SAB SL hit") SUB-NOISE STOP
      // FLOOR: the structure stop takes the TIGHTER of (swing, 1.6×ATR)
      // — a quiet-regime swing 0.2-0.3×ATR away used to put the stop
      // INSIDE normal noise, so paper fills + the 30s watcher cadence
      // alone stopped the trade out before any thesis could play. The
      // stop may now tighten at most to MIN_STOP_ATR_FRACTION × ATR of
      // distance; a would-be-tighter swing keeps the floor and the plan
      // flags `stopFloored` (UI honesty). ATR-fallback plans (a = fake
      // ATR) aur 1.4× India plans bhi covered — floor unhi units me hai.
      let effStop = tighter;
      let stopFloored = false;
      const minDist = MIN_STOP_ATR_FRACTION * a;
      if (Math.abs(ltp - effStop) < minDist) {
        effStop = long ? ltp - minDist : ltp + minDist;
        stopFloored = true;
      }
      stopLoss = effStop;
      planStyle = `${planStyle}+${ss.style || 'structure'}${stopFloored ? '+floor' : ''}`;
      structure = { level: ss.structural ?? null, barsAgo: ss.barsAgo ?? null, ...(stopFloored ? { floored: true } : {}) };
    }
  }
  // v6.4 — build-time risk cap (optional): when the caller knows the
  // user's maxRiskPct the plan is born INSIDE the cap instead of being
  // rejected downstream (fitPlanToRiskCap is the execute-time twin).
  let riskClamped = false, originalRiskPct = null;
  const cap = Number(opts.maxRiskPct);
  if (Number.isFinite(cap) && cap > 0) {
    const cappedDist = Math.min(ltp * (cap / 100), maxSlDist);
    if (Math.abs(ltp - stopLoss) > cappedDist) {
      originalRiskPct = r2((Math.abs(ltp - stopLoss) / ltp) * 100);
      stopLoss = long ? ltp - cappedDist : ltp + cappedDist;
      riskClamped = true;
    }
  }
  const risk = Math.abs(ltp - stopLoss);
  const target1 = long ? ltp + risk : ltp - risk;
  const target2 = long ? ltp + 2 * risk : ltp - 2 * risk;
  const rr = risk > 0 ? Math.abs(target2 - ltp) / risk : 0;
  // v9.2: adaptive price precision — a fixed 2-decimal round collapsed
  // sub-1 instruments (DOGE 0.0848 → entry 0.08, T1 0.08, T2 0.08;
  // OP's SL landed ON the entry = instant stop-out). pRound keeps 4-8
  // significant decimals on low-price legs so SL/T1/T2 stay DISTINCT
  // and direction-consistent. Prices ≥ 1 round exactly as before.
  //
  // v21.6.1 DISTINCT-LEVELS GUARD: 2-decimal rounding ka ≥1 wala cousin —
  // XRP $1.36 jaise instrument pe risk < 0.005 aaya (tight structure stop
  // + floor) to `entry 1.36 · T1 1.36` ban gaya (SHORT target entry PE —
  // kabhi pay nahi karega; live diagnostic ne pakda tha). pRoundLadder
  // poori ladder ko EK shared precision pe round karta hai jahan har
  // level distinct + strictly side-ordered rehta hai (LONG: SL < entry
  // < T1 < T2; SHORT mirror) — card kabhi galat-side level nahi dikhata.
  const ladder = pRoundLadder({ side: long ? 'LONG' : 'SHORT', entry: ltp, stopLoss, targets: [target1, target2] });
  const entryR = ladder.entry, stopR = ladder.stopLoss, t1R = ladder.targets[0], t2R = ladder.targets[1];
  // risk on the ROUNDED legs (display-consistent — the card shows these)
  const riskR = Math.abs(entryR - stopR);
  return {
    entry: entryR,
    stopLoss: stopR,
    target1: t1R,
    target2: t2R,
    risk: riskR > 0 ? pRound(riskR) : pRound(risk),
    riskPct: r2((risk / ltp) * 100),
    rewardRisk: r2(rr),
    // v6.12: honest flag — the reward side is mechanically 2R by
    // construction; structure-aware stops change risk, not reward.
    // The probrain quality layer separately judges whether 2R is
    // structurally reachable. rrBelowFloor flags unusable plans.
    rrBelowFloor: rr < 1.5 || undefined,
    atrUsed: pRound(a),
    planStyle,
    ...(structure ? { structure } : {}),
    ...(structure?.floored ? { stopFloored: true } : {}),
    ...(riskClamped ? { riskClamped: true, originalRiskPct } : {}),
  };
}

/**
 * Assemble the final signal object (what the API serves).
 */
export function buildSignal({ symbol, market, ctx, votes, consensus, plan, aiNote, quality }) {
  const changePct = ctx?.changePct ?? null;
  return {
    symbol,
    market,
    side: consensus.side,
    grade: consensus.grade,
    confidence: consensus.confidence,
    agreement: consensus.agreement,
    participation: consensus.participation ?? null,
    participating: consensus.participating,
    voters: consensus.voters ?? consensus.participating ?? null,
    totalModels: consensus.totalModels,
    bullWeight: consensus.bullWeight ?? null,
    bearWeight: consensus.bearWeight ?? null,
    ltp: pRound(ctx?.ltp ?? null),
    changePct: r1(changePct),
    plan,
    quality: quality || null,
    votes: (votes || []).map(v => ({
      id: v.id, name: v.name, role: v.role, weight: v.weight,
      dir: v.dir, conf: v.conf, reasons: v.reasons || [],
      // v11.8: structural abstain marker — the seat cannot serve this
      // market (out of the quorum denominator). The UI can gray these
      // rows; abstentions below already collects their reasons.
      ...(v.na ? { na: true } : {}),
    })),
    // v10.16 S3: the abstaining models + their stated reasons — the
    // diagnostic that answers "WHY is quorum thin?" at the source (a
    // dead data feed shows up HERE, not as a mystery 85-score bar).
    abstentions: (votes || [])
      .filter(v => !v || v.dir === 0 || !(v.conf > 0) || !(v.weight > 0))
      .map(v => ({ id: v?.id, name: v?.name, reason: (v?.reasons || [])[0] || null, ...(v?.na ? { na: true } : {}) }))
      .filter(a => a.id),
    summary: consensus.summary,
    aiNote: aiNote || null,
    // v20.9.4 [H2 — meta-ensemble wiring]: aggregateVotesWithMeta se aayi
    // consensus apna source (meta/meta-capped) carry karti hai — signal
    // pe stamp karo taaki cryptoAgent/intradayAgent ka metaEnsemble field
    // (jo pehle hamesha null tha) honest audit data de. Weighted source
    // stamp nahi hota (noise-free default shape).
    ...((consensus.source === 'meta' || consensus.source === 'meta-capped')
      ? { meta: { source: consensus.source, label: consensus.metaLabel ?? null } }
      : {}),
    executable: (market === 'CRYPTO' || market === 'FUTURES' || market === 'GLOBALFUTURES') && consensus.grade === 'STRONG' && !!plan,
    // v12.4 SIGNAL TRUST wire fields (attached by applySignalTrustGuards
    // on both the board and deep paths — see signalMemory.js):
    //   signalAge — when this direction FIRST appeared + last confirm
    //   obOs      — the overbought/oversold suppression verdict
    //   freshFlip — the anti-whipsaw verdict (side just flipped)
    //   chasing   — v12.5 structural extension verdict (ATR-distance
    //               from the mean + one-way candle run — the "signals
    //               direction galat" chase fix; see entryTiming.js)
    ...(consensus.signalAge ? { signalAge: consensus.signalAge } : {}),
    ...(consensus.obOs ? { obOs: consensus.obOs } : {}),
    ...(consensus.freshFlip ? { freshFlip: consensus.freshFlip } : {}),
    ...(consensus.chasing ? { chasing: consensus.chasing } : {}),
    // v12.6 entryQuality — the PULLBACK / EXTENDED band (the positive
    // side of the timing read; drives the board re-rank + the card chip).
    ...(consensus.entryQuality ? { entryQuality: consensus.entryQuality } : {}),
    generatedAt: Date.now(),
  };
}

/**
 * THE EXECUTION GATE — used by the order layer (and tests).
 * A LIVE order may ONLY pass when ALL conditions hold:
 *   1. fresh ensemble run (age ≤ maxAgeMs)
 *   2. market matches the execution venue (crypto=CoinDCX,
 *      India=Dhan — v6.5 made the venue a parameter)
 *   3. side matches the requested side
 *   4. grade STRONG: confidence ≥ gates.minConfidence
 *      AND agreement ≥ gates.minAgreement
 *   5. plan exists with a sane risk (≤ maxRiskPct)
 *   6. AI Council (when online) did NOT veto (its vote is already
 *      inside the ensemble — a veto drops agreement/confidence).
 * PAPER mode (practice money) uses requireStrong:false with a
 * longer freshness window — v6.12 raised its floor: paper requires
 * grade ≥ ACTION (confidence ≥ 55). v9.0.2 adds `practice: true`:
 * the desks pass it for PAPER/NOTIFY clicks so the grade/conf floor
 * no longer dead-ends practice — the card the user clicked was
 * graded at SCAN time and the fresh re-run's honest grade/conf is
 * journaled instead (the direct fix for "paper trading start hi
 * nhi ho raha"). LIVE keeps the full strict gauntlet untouched.
 */
export function evaluateExecutionGate(signal, { side, gates = DEFAULT_GATES, maxAgeMs = 90_000, maxRiskPct = 5, requireStrong = true, venue = 'CRYPTO', practice = false } = {}) {
  if (!signal) return { ok: false, reason: 'no signal' };
  if (Date.now() - (signal.generatedAt || 0) > maxAgeMs) return { ok: false, reason: `signal stale (age > ${Math.round(maxAgeMs / 1000)}s) — re-run ensemble` };
  const wantVenue = String(venue).toUpperCase();
  if (String(signal.market || 'CRYPTO').toUpperCase() !== wantVenue) {
    return { ok: false, reason: `signal is for the ${signal.market} market — this gate guards ${wantVenue} execution` };
  }
  // v9.5 side-vocabulary normalisation: ensemble sides are LONG/SHORT/FLAT,
  // but order layers (and hand-rolled API calls) naturally speak BUY/SELL.
  // A raw string compare rejected "requested BUY" against "side LONG" —
  // the exact class of direction bug this gate exists to prevent. Accept
  // both vocabularies; FLAT never matches anything tradeable.
  const SIDE_ALIAS = { BUY: 'LONG', SELL: 'SHORT', LONG: 'LONG', SHORT: 'SHORT' };
  const wantSide = SIDE_ALIAS[String(side || signal.side).toUpperCase()]
    || String(side || signal.side).toUpperCase();
  const sigSide = SIDE_ALIAS[String(signal.side).toUpperCase()] || String(signal.side);
  // FLAT / planless vetoes FIRST (a FLAT signal is not a "flip" — saying
  // so would mislead; the honest reason is there is no consensus side).
  if (signal.side === 'FLAT' || !signal.plan) return { ok: false, reason: 'no tradeable side/plan in the current consensus' };
  if (sigSide !== wantSide) {
    // v12.6: the honest reason a clicked side didn't execute — the card
    // the user approved was built up to 60s ago; the FRESH consensus
    // re-run at click time flipped. This veto is what keeps a LONG click
    // from ever silently executing as SHORT (or vice versa).
    return {
      ok: false,
      reason: `fresh consensus ${sigSide} hai, aapne ${wantSide} card pe trade maara tha — signal FLIP ho gaya (whipsaw window). Card refresh karke naya setup confirm karo; auto-flip execute kabhi nahi hota.`,
    };
  }
  // v12.5 CHASE GUARD — the honest journal reason for a suppressed
  // entry (the board already capped the grade to WATCH — a WATCH can
  // never satisfy requireStrong — this veto makes the WHY readable
  // instead of a bare "grade WATCH" line). Buying a +2.5×ATR vertical
  // leg is the WLD class of loss; practice entries are refused TOO —
  // rehearsing a bad habit is still a bad habit.
  if (signal.chasing && signal.chasing.severity === 'HARD') {
    const c = signal.chasing;
    return {
      ok: false,
      reason: `chasing guard — ${c.reason || `price ${c.extAtr}×ATR extended`}; entry suppressed (pullback ka wait karo, top-tick chase mat karo)`,
    };
  }
  // v20.9.3 FIX (H2): UCV-A1 hard veto — the realtime ultrafast chart
  // REJECTED this direction (1m/5m micro-structure fighting the trade)
  // but a stale/unpatched signal object can still carry STRONG/80+
  // here (e.g. the deep path pre-v20.9.3, or a cached getFreshSignalForExec
  // read). Board + deep + this gauntlet must ALL refuse the direction —
  // practice included (rehearsing a rejected direction is worse than
  // useless: it teaches the wrong habit).
  if (signal.ultrafast?.verdict === 'REJECTED' || signal.ucRejected === true) {
    const uc = signal.ultrafast;
    return {
      ok: false,
      reason: `UCV-A1 REJECTED — realtime ultrafast chart ${uc?.microDirection ? `${uc.microDirection} hai` : 'is direction ke against hai'} (micro ${uc?.score ?? '?'}/100); ${signal.side} entry suppressed (1m structure se ladna mat karo)`,
    };
  }
  if (requireStrong) {
    if (signal.grade !== 'STRONG') return { ok: false, reason: `grade ${signal.grade} — live orders need STRONG (${gates.minConfidence}% conf + ${Math.round(gates.minAgreement * 100)}% agreement)` };
    if ((signal.confidence ?? 0) < gates.minConfidence) return { ok: false, reason: `confidence ${signal.confidence}% < ${gates.minConfidence}% gate` };
    if ((signal.agreement ?? 0) < gates.minAgreement) return { ok: false, reason: `agreement ${Math.round((signal.agreement || 0) * 100)}% < ${Math.round(gates.minAgreement * 100)}% gate` };
  } else if (!practice) {
    // v6.12: PAPER/NOTIFY floor — ACTION minimum. A WATCH/NEUTRAL
    // signal is a watchlist note, not a rehearsal trade.
    // v9.0.2: `practice` (desk PAPER/NOTIFY clicks) skips this floor —
    // the fresh consensus is journaled honestly by the desk instead.
    if (signal.grade !== 'STRONG' && signal.grade !== 'ACTION') {
      return { ok: false, reason: `grade ${signal.grade} — paper practice bhi ACTION-grade confluence maangta hai (WATCH = sirf dekho, trade mat karo)` };
    }
    if ((signal.confidence ?? 0) < 55) return { ok: false, reason: `confidence ${signal.confidence}% < 55% paper floor` };
  }
  const riskPct = signal.plan.riskPct ?? 0;
  if (!(riskPct > 0)) return { ok: false, reason: 'no risk plan' };
  if (riskPct > maxRiskPct) return { ok: false, reason: `plan risk ${riskPct}% > ${maxRiskPct}% max` };
  return { ok: true, reason: requireStrong
    ? `STRONG ${signal.side} · ${signal.confidence}% conf · ${Math.round(signal.agreement * 100)}% agreement`
    : `PAPER ${signal.side} · ${signal.confidence}% conf (ACTION+ floor — practice bhi discipline se)` };
}

/**
 * v6.5 — TRAILING STOP-LOSS MATH (shared by the crypto + India watchers).
 *
 * A prop desk doesn't let a winner round-trip back to the initial stop.
 * The ratchet (all LONG flipped for SHORT):
 *   • track peakPrice since entry (highest high for LONG)
 *   • initial risk R = |entry − original SL| (stored at open)
 *   • once profit ≥ armR × R   → SL ≥ entry (breakeven floor)
 *   • beyond that, trail       → SL = peak − offsetR × R
 *   • RATCHET-ONLY: a new SL may only TIGHTEN (LONG: > current; SHORT: < current)
 *   • never trail past the live price (that close is this tick's SL job)
 *
 * Pure + exported for tests. Returns { sl, peak, stage } or null when
 * nothing should move yet (or inputs are unusable).
 */
export function computeTrailSl(opts) {
  if (!opts || typeof opts !== 'object') return null;
  const { side, entryPrice, peakPrice, currentSl, initialRisk, price, armR = 1.0, offsetR = 1.0 } = opts;
  const long = String(side).toUpperCase() !== 'SHORT';
  const entry = Number(entryPrice), peak = Number(peakPrice), risk = Number(initialRisk), ltp = Number(price);
  if (!(entry > 0) || !(peak > 0) || !(risk > 0) || !(ltp > 0)) return null;
  const arm = Number.isFinite(Number(armR)) && armR > 0 ? armR : 1.0;
  const off = Number.isFinite(Number(offsetR)) && offsetR > 0 ? offsetR : 1.0;
  const profit = long ? peak - entry : entry - peak;
  if (profit < arm * risk) return null; // not armed yet — initial SL stands
  let candidate;
  let stage;
  if (profit < (arm + 0.5 * off) * risk) {
    // stage 1: lock breakeven (entry) — the psychological lock
    candidate = entry;
    stage = 'breakeven';
  } else {
    // stage 2: trail the peak at offsetR × R behind
    candidate = long ? peak - off * risk : peak + off * risk;
    stage = 'trail';
  }
  // breakeven floor for stage 2 as well (never below entry once armed)
  candidate = long ? Math.max(candidate, entry) : Math.min(candidate, entry);
  // ratchet: only tighten
  const cur = Number(currentSl);
  if (Number.isFinite(cur) && cur > 0) {
    if (long && candidate <= cur) return null;
    if (!long && candidate >= cur) return null;
  }
  // never cross the live price (that's a stop HIT, not a trail move)
  if (long && candidate >= ltp) return null;
  if (!long && candidate <= ltp) return null;
  // v9.2: adaptive precision — a 2-decimal trail stop on a sub-1
  // instrument rounds ONTO the entry (OP-class instant stop-outs).
  return { sl: pRound(candidate), peak, stage };
}

/**
 * v6.4 — RISK AUTO-FIT (the execute-time twin of buildTradePlan's cap).
 *
 * The user bug: a STRONG crypto signal whose structural ATR stop reads
 * 5.04% vs the 5% cap used to hard-REJECT even the PAPER button
 * ("Signal gate: plan risk 5.04% > 5% max"). A 0.04% overshoot is not
 * a risk problem — conflating stop WIDTH with money AT RISK was. A
 * prop desk fits the stop to the cap and re-derives targets; it does
 * not bounce the trade.
 *
 *   SL  → entry ∓ cap% (tightened to the configured ceiling)
 *   T1  → entry ± 1× fitted risk · T2 → entry ± 2× fitted risk
 *   plan.riskClamped = true + originalRiskPct (honest audit trail)
 *
 * PAPER always fits (practice money must never dead-end on stop
 * width). LIVE callers decide their own tolerance BEFORE calling this
 * (executeSignal only fits mild overshoot ≤ 1.5× cap for live — a
 * wildly-wide ATR stop clamped tight is noise-suicide and honestly
 * belongs in a REJECT).
 *
 * @returns {{ signal, note: string|null }} note is set when a fit happened
 */
export function fitPlanToRiskCap(signal, maxRiskPct = 5) {
  const plan = signal?.plan;
  const ltp = Number(signal?.ltp);
  const riskPct = Number(plan?.riskPct);
  if (!plan || !Number.isFinite(riskPct) || !(riskPct > 0) || !(ltp > 0)
    || !Number.isFinite(Number(maxRiskPct)) || !(maxRiskPct > 0)) {
    return { signal, note: null };
  }
  if (riskPct <= maxRiskPct) return { signal, note: null };
  const long = signal.side !== 'SHORT';
  const capDist = ltp * (maxRiskPct / 100);
  const stopLoss = long ? ltp - capDist : ltp + capDist;
  const target1 = long ? ltp + capDist : ltp - capDist;
  const target2 = long ? ltp + 2 * capDist : ltp - 2 * capDist;
  const fitted = {
    ...plan,
    stopLoss: pRound(stopLoss),
    target1: pRound(target1),
    target2: pRound(target2),
    risk: pRound(capDist),
    riskPct: r2(maxRiskPct),
    rewardRisk: 2,
    riskClamped: true,
    originalRiskPct: r2(riskPct),
    planStyle: `${plan.planStyle || 'atr'}→risk-fitted`,
  };
  return {
    signal: { ...signal, plan: fitted },
    note: `risk auto-fitted ${r2(riskPct)}% → ${r2(maxRiskPct)}% cap (SL tightened, targets re-derived)`,
  };
}

/**
 * v6.6 — MAX SANE LEVERAGE for a given stop distance.
 *
 * With isolated-margin leverage L, the liquidation sits roughly at
 * 0.95/L away from entry (0.95 = conservative 5% maintenance buffer).
 * If that distance is SMALLER than the stop-loss distance the SL is
 * dead code — the exchange liquidates first and the "risk-managed"
 * plan is fiction. This returns the largest L (1..maxCap) that keeps
 * liquidation OUTSIDE the stop:
 *      0.95 / L ≥ stopDistPct / 100   →   L ≤ 95 / stopDistPct
 * A 5% stop → L ≤ 19 (capped by config), a 10% stop → L ≤ 9.
 */
export function maxSaneLeverage(stopDistPct, maxCap = 10) {
  const pct = Number(stopDistPct);
  const cap = Math.max(1, Math.min(20, Number(maxCap) || 10));
  if (!Number.isFinite(pct) || !(pct > 0)) return 1;
  return Math.max(1, Math.min(cap, Math.floor(95 / pct)));
}

/**
 * v6.6 — LEVERAGE VIEW (the one honest number set for a leveraged trade).
 *
 * Pure math shared by the execute path and the ticket preview (the
 * frontend mirrors it — one source of truth for the FORMULAS, the
 * server recomputes everything at execute time and wins).
 *
 * Liquidation estimate (isolated margin, documented approximation):
 *   LONG  liq ≈ entry × (1 − 0.95/L)     SHORT liq ≈ entry × (1 + 0.95/L)
 * The 0.95 factor bakes in a conservative ~5% maintenance margin so
 * the estimate triggers EARLY rather than late. It is an ESTIMATE —
 * the exchange's exact maintenance tiers differ per pair.
 *
 *   qty       = margin × L / entry          (notional = margin × L)
 *   riskINR   = qty × |entry − SL|          (scales with L — honest!)
 *   effRiskOnMargin = riskINR / margin      (5% stop @ 10x = 50%)
 *   liqBeforeSl     = liquidation closer than the SL → SL is fiction
 */
export function computeLeverageView({ side, entry, stopLoss, target2, marginINR, leverage }) {
  const e = Number(entry), sl = Number(stopLoss), t2 = Number(target2);
  const margin = Number(marginINR);
  const L = Math.max(1, Math.floor(Number(leverage) || 1));
  if (!(e > 0) || !(margin > 0) || !(sl > 0)) return null;
  const long = String(side).toUpperCase() !== 'SHORT';
  if (long !== (sl < e)) return null; // SL on the wrong side — unusable

  const notionalINR = margin * L;
  const qty = notionalINR / e;
  const slDist = Math.abs(e - sl);
  const t2Dist = t2 > 0 ? Math.abs(t2 - e) : null;
  const liquidation = pRound(long ? e * (1 - 0.95 / L) : e * (1 + 0.95 / L));
  const liqDist = Math.abs(e - liquidation);
  const slDistPct = r2((slDist / e) * 100);

  return {
    leverage: L,
    marginINR: r2(margin),
    notionalINR: r2(notionalINR),
    qty: r2(qty),
    liquidation,
    liqDistPct: r2((liqDist / e) * 100),
    slDistPct,
    riskINR: r2(qty * slDist),
    rewardT2INR: t2Dist != null ? r2(qty * t2Dist) : null,
    effRiskOnMarginPct: r2((slDist / e) * 100 * L), // ₹ risk as % of margin
    liqBeforeSl: liqDist < slDist,
    maxSaneLeverage: maxSaneLeverage(slDistPct),
  };
}
