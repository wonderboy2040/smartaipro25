// ============================================================
// server/ai/ultrafastVerifier.js — v20.9.2 ULTRAFAST CHART
// VERIFICATION AGENT (UCV-A1 — "Deep AI Superintelligence Agent")
// ------------------------------------------------------------
// THE USER PROBLEM (verbatim intent): "Trade signals bahut mismatch
// ho rahe hai — long bolne par short jaa rahe hai, short bolne par
// long jaa rahe hai. Ek deep additional AI agent rakho jo REALTIME
// ULTRAFAST chart check kar sake ki LONG signal PAKKA long jayega
// kya nahi, aur SHORT signal PAKKA short jayega kya nahi."
//
// WHY THE MISMATCH HAPPENS (root cause, verified in audit): the
// committee's heaviest seats (TrendMatrix EMA-50 stack, 1h tape,
// macro regime) are LAGGING by construction — a 1h EMA stack stays
// bullish for hours after the micro trend has already rolled over.
// The v9.2 price-confirm guard + v20.4 counter-tape wiring soften
// this, but they only ADJUST confidence (±3..−18); no layer ever
// ANSWERS the only question the user actually asks:
//
//   "is the ultrafast chart RIGHT NOW moving with this signal?"
//
// WHAT THIS AGENT DOES (the missing layer):
//   1. Pulls the REALTIME ULTRAFAST chart stack per symbol:
//        • 1m candles (60-200 bars — the micro timeframe)
//        • 5m candles (micro-structure confirmation)
//        • the LIVE tick (sub-second print off the tick store)
//   2. Runs a 9-check MICRO-STRUCTURE analysis (pure math):
//        fast EMA stack · last-5/10 closes run · HH/HL vs LH/LL
//        structure · 1m volume pressure · rejection wicks ·
//        RSI(7) fast zone · 5m confirmation · live-tick velocity ·
//        momentum acceleration.
//   3. Emits ONE direction read: microDirection UP/DOWN/FLAT with a
//      −100..+100 microScore.
//   4. Emits THE ANSWER (the user's exact question):
//        CONFIRMED  → "LONG pakka long — ultrafast chart UP hai"
//        PENDING    → "1m tape neutral — confirmation ka wait karo"
//        REJECTED   → "LONG reject — 1m chart DOWN hai, ye entry
//                      ulta (short) ja sakta hai"  ← the mismatch
//                      case, caught BEFORE the trade.
//
// WHERE IT RUNS:
//   • signals.js — every 80+ AI-score / STRONG-grade board signal
//     gets the stamp `s.ultrafast` (REJECTED → aiScore capped 64 +
//     grade demoted WATCH — a signal fighting its own 1m chart can
//     never wear the 80+ tradeable badge).
//   • signals.js deep path — full payload (checklist rides along).
//   • proTraderAuto.js — a REJECTED verdict blocks the auto-entry
//     (reason 'ultrafast:REJECTED').
//   • signalRecheck.js — the 15s loop re-runs it on deep re-votes
//     and raises UC_REJECTED / UC_CONFIRMED transition events.
//
// PURITY + COST DISCIPLINE:
//   • analyzeUltrafastChart() / verifyUltrafast() are PURE —
//     numbers in, verdict out; unit-testable with zero fetches.
//   • fetchUltrafastContext() rides the EXISTING TTL candle caches
//     (1m 90s / 5m 120s in data.js) — repeated board cycles share
//     round-trips. A 45s verdict cache per (market,symbol,side)
//     absorbs the board + recheck + deep-path overlap.
//   • Hard deadline per call; a slow/missing source degrades to
//     PENDING ('insufficient data') — NEVER blocks the board.
// ============================================================
import { fetchCoinDcxCandles, fetchBinanceKlines } from './data.js';
// v20.9.3 FIX (H1 — currency-domain mismatch): the FUTURES desk tick is
// a USDT perp print (FUT_<SYM>, cxRtStream), but the old fetch used the
// SPOT INR candles (fetchCoinDcxCandles → <SYM>INR) — check 8 then
// computed (USDT − INR)/INR ≈ −98% → a permanent −8 score bias on every
// futures verdict (and the mirror +8 on hosts where the Binance USDT
// fallback served the CRYPTO desk against an IN_ INR tick). Futures
// candles are the SAME USDT domain as the FUT_ tick — fetch those.
import { fetchFuturesCandles, futuresPairFor } from './futures.js';
import { ema, rsi, atr as atrOf } from './lib/indicators.js';
// v20.9.2: the LIVE tick store (dependency-free module — the same store
// cxRtStream/cryptoStream write into and signalRecheck reads from).
import { getTick as _liveGetTick } from '../liveFeed.js';

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const r1 = (v) => (Number.isFinite(v) ? Math.round(v * 10) / 10 : null);
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// ---------------- verdict thresholds ----------------
/** microScore at/above this = the ultrafast chart is decisively UP. */
export const UC_CONFIRM_SCORE = 25;
/** microScore at/below the negation of this = decisively AGAINST. */
export const UC_REJECT_SCORE = 30;
/** AI-score hard cap applied to a REJECTED signal (below the 80+ bar). */
export const UC_REJECT_SCORE_CAP = 64;
/** Verdict cache TTL — boards cycle 30-60s, recheck 15s; 45s keeps
 *  overlap free while a 1m candle print still refreshes the read. */
const UC_CACHE_TTL_MS = 45_000;
const UC_CACHE_MAX = 160;
const _verdictCache = new Map(); // `${mkt}:${sym}:${side}` → { at, out }

// ============================================================
// PART 1 — THE PURE MICRO-STRUCTURE ANALYSIS
// ============================================================
/**
 * Realtime ultrafast chart analysis. PURE.
 * @param {{ candles1m?: array|null, candles5m?: array|null, liveTick?: {price:number,time:number}|null, now?: number }} ctx
 * @returns {{
 *   ok: boolean, microDirection: 'UP'|'DOWN'|'FLAT', microScore: number,
 *   momentumPct: number|null, tickPct: number|null, atrPct: number|null,
 *   bars: number, checks: Array<{id:string,label:string,status:string,detail:string}>,
 *   summary: string,
 * }}
 */
export function analyzeUltrafastChart({ candles1m = null, candles5m = null, liveTick = null } = {}) {
  const c1 = Array.isArray(candles1m) ? candles1m.filter(c => num(c?.close) > 0) : [];
  const c5 = Array.isArray(candles5m) ? candles5m.filter(c => num(c?.close) > 0) : [];
  if (c1.length < 25) {
    return {
      ok: false, microDirection: 'FLAT', microScore: 0, momentumPct: null, tickPct: null,
      atrPct: null, bars: c1.length, checks: [], summary: 'insufficient 1m data (need ≥25 bars)',
    };
  }

  const closes1 = c1.map(c => c.close);
  const last = closes1[closes1.length - 1];
  const checks = [];
  let score = 0;

  // ---- 1. fastStack — EMA3/EMA8/EMA21 on the 1m closes ----
  // The ULTRAFAST trend stack: 3 over 8 over 21 = micro uptrend live.
  {
    const e3 = num(ema(closes1, 3)), e8 = num(ema(closes1, 8)), e21 = num(ema(closes1, 21));
    if (e3 != null && e8 != null && e21 != null) {
      if (e3 > e8 && e8 > e21) { score += 26; checks.push({ id: 'fastStack', label: '1m EMA 3>8>21', status: 'BULL', detail: `fast stack UP (e3 ${r1(e3)} > e8 ${r1(e8)} > e21 ${r1(e21)})` }); }
      else if (e3 < e8 && e8 < e21) { score -= 26; checks.push({ id: 'fastStack', label: '1m EMA 3<8<21', status: 'BEAR', detail: `fast stack DOWN (e3 ${r1(e3)} < e8 ${r1(e8)} < e21 ${r1(e21)})` }); }
      else {
        const s = e3 > e21 ? 8 : e3 < e21 ? -8 : 0;
        score += s;
        checks.push({ id: 'fastStack', label: '1m EMA stack mixed', status: 'FLAT', detail: `e3 ${r1(e3)} · e8 ${r1(e8)} · e21 ${r1(e21)} — stack transitioning` });
      }
    } else checks.push({ id: 'fastStack', label: '1m EMA stack', status: 'N/A', detail: 'window too thin' });
  }

  // ---- 2. recentRun — last 5 + last 10 1m closes net direction ----
  // What the last 5/10 minutes of prints ACTUALLY did (not a lagging
  // average — the live run itself).
  let momentumPct = null;
  {
    const ref5 = closes1[Math.max(0, closes1.length - 6)];
    const ref10 = closes1[Math.max(0, closes1.length - 11)];
    if (ref5 > 0 && ref10 > 0) {
      const p5 = ((last - ref5) / ref5) * 100;
      const p10 = ((last - ref10) / ref10) * 100;
      momentumPct = p5;
      const bullBars5 = c1.slice(-5).filter(c => c.close > c.open).length;
      // 5m run scaled ±22 by %, 10m ±10 — recent dominates.
      score += clamp(p5 * 9, -22, 22) + clamp(p10 * 2.2, -10, 10);
      checks.push({
        id: 'recentRun', label: 'last 5m / 10m run',
        status: p5 > 0.03 ? 'BULL' : p5 < -0.03 ? 'BEAR' : 'FLAT',
        detail: `5m ${p5 >= 0 ? '+' : ''}${r1(p5)}% (bull bars ${bullBars5}/5) · 10m ${p10 >= 0 ? '+' : ''}${r1(p10)}%`,
      });
    }
  }

  // ---- 3. microStructure — HH/HL vs LH/LL over the last 6 1m bars ----
  // The pro read: is the tape printing higher-highs + higher-lows
  // (accumulation) or lower-highs + lower-lows (distribution)?
  {
    const w = c1.slice(-6);
    let hh = 0, ll = 0, hl = 0, lh = 0;
    for (let i = 1; i < w.length; i++) {
      if (w[i].high > w[i - 1].high) hh++; else if (w[i].high < w[i - 1].high) lh++;
      if (w[i].low > w[i - 1].low) hl++; else if (w[i].low < w[i - 1].low) ll++;
    }
    const struct = (hh + hl) - (lh + ll); // −8..+8
    score += clamp(struct * 2.4, -18, 18);
    checks.push({
      id: 'microStructure', label: '6-bar structure',
      status: struct >= 3 ? 'BULL' : struct <= -3 ? 'BEAR' : 'FLAT',
      detail: struct >= 3 ? `HH/HL dominant (${hh}↑H ${hl}↑L vs ${lh}↓H ${ll}↓L) — accumulation tape`
        : struct <= -3 ? `LH/LL dominant (${lh}↓H ${ll}↓L vs ${hh}↑H ${hl}↑L) — distribution tape`
          : `structure mixed (H ${hh}↑/${lh}↓ · L ${hl}↑/${ll}↓)`,
    });
  }

  // ---- 4. volumePressure — up-bar vs down-bar volume, last 10 1m bars ----
  {
    const w = c1.slice(-10);
    let upV = 0, dnV = 0;
    for (const c of w) { if (c.close >= c.open) upV += (c.volume || 0); else dnV += (c.volume || 0); }
    const tot = upV + dnV;
    if (tot > 0) {
      const bias = (upV - dnV) / tot; // −1..+1
      score += clamp(bias * 16, -16, 16);
      checks.push({
        id: 'volumePressure', label: '1m volume pressure',
        status: bias > 0.18 ? 'BULL' : bias < -0.18 ? 'BEAR' : 'FLAT',
        detail: `${Math.round((upV / tot) * 100)}% of last-10-bar volume on UP bars`,
      });
    } else checks.push({ id: 'volumePressure', label: '1m volume pressure', status: 'N/A', detail: 'no volume on 1m feed' });
  }

  // ---- 5. wickRejection — who is defending, last 3 1m bars ----
  {
    const w = c1.slice(-3);
    let lowerWick = 0, upperWick = 0;
    for (const c of w) {
      const body = Math.abs(c.close - c.open) || 1e-12;
      const range = (c.high - c.low) || 1e-12;
      lowerWick += (Math.min(c.open, c.close) - c.low) / range > 0.55 && body / range < 0.45 ? 1 : 0;
      upperWick += (c.high - Math.max(c.open, c.close)) / range > 0.55 && body / range < 0.45 ? 1 : 0;
    }
    const wick = lowerWick - upperWick; // + = buyers defending dips
    score += wick * 5;
    checks.push({
      id: 'wickRejection', label: '3-bar wicks',
      status: wick > 0 ? 'BULL' : wick < 0 ? 'BEAR' : 'FLAT',
      detail: wick > 0 ? `${lowerWick} lower-wick rejection(s) — dips being bought` : wick < 0 ? `${upperWick} upper-wick rejection(s) — rallies being sold` : 'no decisive rejection wicks',
    });
  }

  // ---- 6. rsiFast — RSI(7) on 1m (zone read, not extreme) ----
  {
    const r = num(rsi(closes1, 7));
    if (r != null) {
      const s = r >= 56 ? 10 : r >= 52 ? 5 : r <= 44 ? -10 : r <= 48 ? -5 : 0;
      score += s;
      checks.push({
        id: 'rsiFast', label: '1m RSI(7)',
        status: r >= 56 ? 'BULL' : r <= 44 ? 'BEAR' : 'FLAT',
        detail: `RSI(7) ${Math.round(r)} — ${r >= 56 ? 'bull zone' : r <= 44 ? 'bear zone' : 'neutral'}`,
      });
    }
  }

  // ---- 7. confirm5m — the 5m micro trend agrees ----
  {
    if (c5.length >= 30) {
      const closes5 = c5.map(c => c.close);
      const e8 = num(ema(closes5, 8)), e21 = num(ema(closes5, 21));
      const lastBar = c5[c5.length - 1];
      const prevBar = c5[c5.length - 2] || lastBar;
      let s = 0;
      if (e8 != null && e21 != null) s += e8 > e21 ? 8 : e8 < e21 ? -8 : 0;
      s += lastBar.close > lastBar.open ? 4 : lastBar.close < lastBar.open ? -4 : 0;
      s += lastBar.close > prevBar.close ? 2 : lastBar.close < prevBar.close ? -2 : 0;
      score += s;
      checks.push({
        id: 'confirm5m', label: '5m confirmation',
        status: s > 0 ? 'BULL' : s < 0 ? 'BEAR' : 'FLAT',
        detail: `5m EMA8 ${e8 != null && e21 != null ? (e8 > e21 ? '> EMA21 (up)' : '< EMA21 (down)') : 'n/a'} · last 5m bar ${lastBar.close >= lastBar.open ? 'green' : 'red'}`,
      });
    } else checks.push({ id: 'confirm5m', label: '5m confirmation', status: 'N/A', detail: '5m window too thin' });
  }

  // ---- 8. tickVelocity — the LIVE print vs the last 1m close ----
  let tickPct = null;
  {
    const tickPx = num(liveTick?.price);
    if (tickPx != null && tickPx > 0 && last > 0) {
      tickPct = ((tickPx - last) / last) * 100;
      // v20.9.3 FIX (H1 guard): a live print vs a 1-minute-old close can
      // NEVER legitimately differ by 20% — that is a denomination
      // mismatch (USDT tick vs INR candles or the mirror), not velocity.
      // Score it N/A instead of injecting a constant ±8 skew.
      if (!Number.isFinite(tickPct) || Math.abs(tickPct) > 20) {
        checks.push({
          id: 'tickVelocity', label: 'live tick', status: 'N/A',
          detail: 'tick/candle denomination mismatch — skipped (v20.9.3 guard)',
        });
        tickPct = null;
      } else {
        score += clamp(tickPct * 12, -8, 8);
        checks.push({
          id: 'tickVelocity', label: 'live tick',
          status: tickPct > 0.01 ? 'BULL' : tickPct < -0.01 ? 'BEAR' : 'FLAT',
          detail: `live print ${tickPct >= 0 ? '+' : ''}${r1(tickPct * 100)}bps vs last 1m close`,
        });
      }
    } else checks.push({ id: 'tickVelocity', label: 'live tick', status: 'N/A', detail: 'no fresh tick in store' });
  }

  // ---- 9. acceleration — is the move gaining or fading? ----
  {
    const w6 = c1.slice(-6);
    if (w6.length === 6) {
      const recent3 = w6.slice(3).reduce((a, c) => a + (c.close - c.open), 0);
      const prior3 = w6.slice(0, 3).reduce((a, c) => a + (c.close - c.open), 0);
      const accel = recent3 - prior3;
      score += clamp(accel / Math.max(1e-9, Math.abs(prior3) + Math.abs(recent3)) * 10, -10, 10);
      checks.push({
        id: 'acceleration', label: '3-bar acceleration',
        status: accel > 0 ? 'BULL' : accel < 0 ? 'BEAR' : 'FLAT',
        detail: accel > 0 ? 'last 3 bars gaining vs prior 3 — move accelerating' : accel < 0 ? 'last 3 bars fading vs prior 3 — move decelerating' : 'steady tape',
      });
    }
  }

  const microScore = Math.round(clamp(score, -100, 100));
  const microDirection = microScore >= UC_CONFIRM_SCORE ? 'UP' : microScore <= -UC_CONFIRM_SCORE ? 'DOWN' : 'FLAT';
  const a = num(atrOf(c1, 14));
  const atrPct = a != null && last > 0 ? (a / last) * 100 : null;
  const bulls = checks.filter(c => c.status === 'BULL').length;
  const bears = checks.filter(c => c.status === 'BEAR').length;
  return {
    ok: true,
    microDirection, microScore,
    momentumPct: r1(momentumPct), tickPct: r1(tickPct), atrPct: r1(atrPct),
    bars: c1.length,
    checks,
    summary: `micro ${microDirection} (${microScore >= 0 ? '+' : ''}${microScore}/100 · ${bulls} bull / ${bears} bear checks)${momentumPct != null ? ` · 5m move ${momentumPct >= 0 ? '+' : ''}${r1(momentumPct)}%` : ''}`,
  };
}

// ============================================================
// PART 2 — THE AGENT VERDICT (the user's exact question answered)
// ============================================================
/**
 * The UCV-A1 verdict for one signal: will this LONG really go long?
 * Will this SHORT really go short? PURE.
 * @param {{ side: string, symbol?: string, market?: string,
 *           analysis: object|null, aiScore?: number|null,
 *           grade?: string|null }} p
 * @returns {{ agent, symbol, market, side, verdict: 'CONFIRMED'|'PENDING'|'REJECTED',
 *             confirmed: boolean, score: number, microDirection: string,
 *             answer: string, detail: string, checkedAt: number,
 *             checks?: Array, momentumPct?: number|null, bars?: number }}
 */
export function verifyUltrafast({ side, symbol = '?', market = 'CRYPTO', analysis = null, aiScore = null, grade = null, now = Date.now() } = {}) {
  const s = String(side || '').toUpperCase() === 'SHORT' ? 'SHORT' : 'LONG';
  const opposite = s === 'LONG' ? 'SHORT' : 'LONG';
  const sym = String(symbol || '?').toUpperCase();
  const mkt = String(market || 'CRYPTO').toUpperCase();

  // insufficient data → honest PENDING (never blocks, never lies)
  if (!analysis || analysis.ok !== true) {
    return {
      agent: 'UCV-A1', symbol: sym, market: mkt, side: s,
      verdict: 'PENDING', confirmed: false, score: 0, microDirection: 'FLAT',
      answer: `~ ${s} PENDING — ultrafast chart data adhura hai (${analysis?.summary || 'no 1m feed'}); confirmation ka wait karo`,
      detail: 'insufficient ultrafast data — honest pending, direction unverified',
      checkedAt: now,
    };
  }

  const ms = Number(analysis.microScore) || 0;
  const dir = String(analysis.microDirection || 'FLAT').toUpperCase();
  const aligned = (s === 'LONG' && dir === 'UP') || (s === 'SHORT' && dir === 'DOWN');
  const against = (s === 'LONG' && dir === 'DOWN') || (s === 'SHORT' && dir === 'UP');
  // strength in the signal's OWN direction (0..100 either way)
  const own = s === 'LONG' ? ms : -ms;

  let verdict;
  if (against && Math.abs(ms) >= UC_REJECT_SCORE) verdict = 'REJECTED';
  else if (aligned && Math.abs(ms) >= UC_CONFIRM_SCORE) verdict = 'CONFIRMED';
  else verdict = 'PENDING';

  const bulls = (analysis.checks || []).filter(c => c.status === 'BULL').length;
  const bears = (analysis.checks || []).filter(c => c.status === 'BEAR').length;

  let answer;
  if (verdict === 'CONFIRMED') {
    answer = `⚡ ${s} PAKKA ${s.toLowerCase()} — realtime ultrafast chart ${dir} hai (micro ${ms >= 0 ? '+' : ''}${ms}/100, ${s === 'LONG' ? bulls : bears} checks sahi)`;
  } else if (verdict === 'REJECTED') {
    answer = `✗ ${s} REJECT — realtime ultrafast chart ULTA ${opposite} taraf hai (micro ${ms >= 0 ? '+' : ''}${ms}/100); ye ${s} entry ${opposite.toLowerCase()} banne ka risk hai — trade mat lo`;
  } else {
    answer = `~ ${s} PENDING — 1m ultrafast tape neutral hai (micro ${ms >= 0 ? '+' : ''}${ms}/100); ${s === 'LONG' ? 'upside' : 'downside'} confirmation ka wait karo`;
  }

  return {
    agent: 'UCV-A1', symbol: sym, market: mkt, side: s,
    verdict, confirmed: verdict === 'CONFIRMED',
    score: Math.abs(ms), microDirection: dir,
    ownScore: own,
    answer, detail: analysis.summary || '',
    momentumPct: analysis.momentumPct ?? null,
    bars: analysis.bars ?? 0,
    checks: analysis.checks || [],
    aiScoreAtCheck: aiScore ?? null,
    gradeAtCheck: grade ?? null,
    checkedAt: now,
  };
}

/** Compact wire payload (board signals). Deep path / agent tool gets FULL. */
export function ultrafastWire(v) {
  if (!v || v.agent !== 'UCV-A1') return null;
  return {
    agent: 'UCV-A1',
    verdict: v.verdict,
    confirmed: !!v.confirmed,
    microDirection: v.microDirection,
    score: v.score,
    answer: v.answer,
    detail: v.detail || null,
    ...(v.momentumPct != null ? { momentumPct: v.momentumPct } : {}),
    ...(v.bars ? { bars: v.bars } : {}),
    checkedAt: v.checkedAt,
  };
}

// ============================================================
// PART 3 — THE GATE (REJECTED → no 80+ badge, no STRONG/ACTION)
// ============================================================
/**
 * Apply the ultrafast verdict to a board signal (MUTATES nothing —
 * returns a new object list of fields to merge, or null when the
 * signal keeps its own shape). A REJECTED direction:
 *   • aiScore capped to 64 (below the 80+ user filter — a signal
 *     fighting its own 1m chart is not an 80+ trade)
 *   • tier re-derived from the capped score
 *   • grade STRONG/ACTION → WATCH (auto-agent + execute gates all
 *     demand ≥ ACTION)
 *   • one driver line so the WHY is visible on the card
 * @returns {{ superIntel: object, grade?: string, note: string }|null}
 */
export function ultrafastGatePatch(v, currentSignal) {
  if (!v || v.verdict !== 'REJECTED') return null;
  const si = currentSignal?.superIntel;
  if (!si) return null;
  const capped = Math.min(Number(si.aiScore) || 0, UC_REJECT_SCORE_CAP);
  const tier = capped >= 85 ? 'ELITE' : capped >= 80 ? 'STRONG' : capped >= 65 ? 'ACTION' : capped >= 50 ? 'WATCH' : 'NEUTRAL';
  const grade = ['STRONG', 'ACTION'].includes(String(currentSignal?.grade || '')) ? 'WATCH' : currentSignal?.grade;
  const drivers = Array.isArray(si.drivers) ? si.drivers.slice() : [];
  drivers.push(`UCV-A1 REJECT — 1m chart ${v.microDirection} (micro ${v.score}/100)`);
  return {
    superIntel: { ...si, aiScore: capped, tier, drivers: drivers.slice(0, 5), ultrafastRejected: true },
    ...(grade !== currentSignal?.grade ? { grade } : {}),
    note: `UCV-A1: direction REJECTED by realtime ultrafast chart (${v.detail || 'micro against'})`,
  };
}

// ============================================================
// PART 4 — THE FETCH WRAPPER (context for the pure core)
// ============================================================
/** Candle fetch riding the existing TTL cache chain (never throws).
 * v20.9.3 FIX (H1): per-desk CURRENCY DOMAIN must match the tick store
 * key the verifier reads — FUTURES candles (B-<SYM>_USDT, pcode=f) pair
 * with the FUT_ USDT tick; spot INR candles pair with the IN_ INR tick;
 * the Binance fallback is USDT too, so it stays a valid futures fallback
 * but is NO LONGER used as the CRYPTO-desk primary-coin fallback against
 * an INR tick (the |tickPct|>20 guard in check 8 nets that residue). */
async function _candlesFor(symbol, market, tf) {
  const base = String(symbol || '').toUpperCase().replace(/^(FUT_|GLOB_)/, '');
  try {
    if (market === 'FUTURES') {
      const res = tf === '1m' ? '1' : '5';
      const a = await fetchFuturesCandles(futuresPairFor(base), res, 120).catch(() => null);
      if (Array.isArray(a) && a.length >= 25) return a;
      return await fetchBinanceKlines(base, tf).catch(() => null);
    }
    if (market === 'CRYPTO') {
      const a = await fetchCoinDcxCandles(base, tf).catch(() => null);
      if (Array.isArray(a) && a.length >= 25) return a;
      // v20.9.3: Binance fallback is USDT while the CRYPTO tick (IN_<SYM>)
      // is INR — a ~98% denomination gap. Only use it when we have NO
      // fresh INR tick (check 8's |tickPct|>20 guard is the safety net).
      return await fetchBinanceKlines(base, tf).catch(() => null);
    }
    if (market === 'GLOBALFUTURES') return null; // Yahoo path handled by MTF-6 for that desk
    return null;
  } catch { return null; }
}

/** Live tick off the store (same keys the recheck resolver uses). */
function _tickFor(getTick, market, symbol) {
  if (typeof getTick !== 'function') return null;
  try {
    const k = market === 'FUTURES' ? `FUT_${symbol}` : market === 'GLOBALFUTURES' ? `GLOB_${symbol}` : `IN_${symbol}`;
    const t = getTick(k);
    const px = num(t?.price);
    if (px != null && px > 0 && Date.now() - (t.time || 0) < 45_000) return { price: px, time: t.time };
    return null;
  } catch { return null; }
}

/**
 * The board/deep/recheck entry point: verify ONE signal against the
 * realtime ultrafast chart. Cached 45s per (market, symbol, side);
 * deadline-bounded; honest PENDING on any failure.
 * @param {{ side, symbol, market, aiScore?, grade? }} sig
 * @param {{ getTick?: Function, deadlineMs?: number, now?: number }} [opts]
 */
export async function verifySignalUltrafast(sig, opts = {}) {
  const side = String(sig?.side || '').toUpperCase() === 'SHORT' ? 'SHORT' : 'LONG';
  const symbol = String(sig?.symbol || '').toUpperCase();
  const market = String(sig?.market || 'CRYPTO').toUpperCase();
  const key = `${market}:${symbol}:${side}`;
  const hit = _verdictCache.get(key);
  if (hit && Date.now() - hit.at < UC_CACHE_TTL_MS) return hit.out;

  const deadline = Number(opts.deadlineMs) || 1500;
  const getTick = typeof opts.getTick === 'function' ? opts.getTick : _liveGetTick;
  const [c1, c5] = await Promise.race([
    Promise.all([_candlesFor(symbol, market, '1m'), _candlesFor(symbol, market, '5m')]),
    new Promise((res) => { const t = setTimeout(() => res([null, null]), deadline); t.unref?.(); }),
  ]).catch(() => [null, null]);

  const analysis = analyzeUltrafastChart({
    candles1m: c1, candles5m: c5,
    liveTick: _tickFor(getTick, market, symbol),
  });
  const out = verifyUltrafast({
    side, symbol, market, analysis,
    aiScore: sig?.aiScore ?? sig?.superIntel?.aiScore ?? null,
    grade: sig?.grade ?? null,
    now: Date.now(),
  });

  _verdictCache.set(key, { at: Date.now(), out });
  while (_verdictCache.size > UC_CACHE_MAX) {
    const k = _verdictCache.keys().next().value;
    if (k === undefined) break;
    _verdictCache.delete(k);
  }
  return out;
}

/** Test hook — clear the verdict cache between suites. */
export function __resetUltrafastForTests() { _verdictCache.clear(); }
