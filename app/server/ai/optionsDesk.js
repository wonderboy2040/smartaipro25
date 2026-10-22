// ============================================================
// server/ai/optionsDesk.js — INDIA OPTIONS INTELLIGENCE
// ------------------------------------------------------------
// The options half of the AI Trading tab (NSE indices):
//
//   1. CHAIN: tries the REAL NSE option-chain first (cookie
//      bootstrap). Datacenter blocks are common → falls back to a
//      Black-Scholes SYNTHETIC chain built from live spot (Yahoo
//      ^NSEI) + IV anchored to India VIX. Every response labels
//      its source — "nse" (real OI/IV) or "bs-model" (honest model).
//
//   2. ANALYTICS: PCR, max pain, OI walls, IV percentile — fed
//      INTO the ensemble's OptionsFlow model.
//
//   3. STRATEGY BUILDER: converts the ensemble consensus direction
//      into concrete, fully-priced option strategies (spreads /
//      directionals / iron condor) with max P&L, breakevens, net
//      Greeks and lot sizes.
// ============================================================
import { fetchNSEOptionChain, fetchBSEOptionChain, fetchYahooQuotes } from './data.js';
import { bsPrice, bsGreeks, impliedVol as _impliedVol, yearsToExpiry, nextWeeklyExpiry, normCdf } from './lib/blackScholes.js';
import { aggregateVotes as _aggregateVotes } from './ensemble.js';
import { sessionPhase } from './probrain.js';

const RISK_FREE = 0.069; // ~RBI repo-ish risk-free for NSE pricing
const STRIKE_STEPS = { NIFTY: 50, BANKNIFTY: 100, FINNIFTY: 50, MIDCPNIFTY: 25, NIFTYNXT50: 100, SENSEX: 100 };
const LOT_SIZES = { NIFTY: 75, BANKNIFTY: 35, FINNIFTY: 65, MIDCPNIFTY: 140, NIFTYNXT50: 25, SENSEX: 20 };
const IV_FLOOR = 0.10, IV_CAP = 0.60;

// ------------------------------------------------------------
// v11.1 NSE+SENSEX ADDENDUM — source honesty for model chains.
// Two fundamentally different "bs-model" cases exist under ONE
// label:
//   'bs-model-nifty-fallback' — NIFTY/BANKNIFTY/… when BOTH live NSE
//       paths (direct NSE + the Groww public NIFTY mirror, v21.0.5)
//       are TEMPORARILY blocked from this host (recoverable: the next
//       successful fetch restores live premiums). Direct NSE serves
//       the richest feed (volume + all expiries); the mirror is the
//       datacenter-proof relay. BANKNIFTY-family indices still ride
//       direct NSE alone (their groww pages are client-side rendered).
//   'bs-model-sensex-always' — SENSEX when BOTH live SENSEX paths
//       (Groww public mirror + direct BSE) are unreachable from this
//       host. v21.0.4: the mirror is datacenter-friendly and verified
//       live, so this is now the RARE case (mirror down AND direct
//       blocked) — but while it holds, SENSEX premiums are model
//       estimates and its signal cards carry an additional STRUCTURAL
//       confidence discount (no live-market cross-check possible).
// ------------------------------------------------------------
export const SENSEX_MODEL_SOURCE = 'bs-model-sensex-always';
export const NIFTY_MODEL_SOURCE = 'bs-model-nifty-fallback';
/** The persistent (non-dismissible) banner text the SENSEX desk and
 *  its option cards must ALWAYS carry in model mode. v21.0.4: the
 *  desk first tries the REAL BSE chain (Groww public mirror → direct
 *  BSE) — this banner now fires only when BOTH live paths are
 *  unreachable from this server. */
export const SENSEX_MODEL_BANNER = 'SENSEX premiums are model-estimated — live BSE quotes (direct + Groww public mirror) are unreachable from this server right now; auto-retry chalu rehta hai. For live SENSEX option prices, cross-check your broker.';
/** Structural AI-score discount for SENSEX model cards (no live
 *  cross-check possible — beyond the model-uncertainty handling). */
export function sensexStructuralDiscount() {
  const v = parseFloat(process.env.AI_SENSEX_MODEL_DISCOUNT);
  return Number.isFinite(v) && v >= 0 && v <= 30 ? v : 8;
}

// ------------------------------------------------------------
// v9.4 — F&O OPTION SIGNAL CARDS. The user's exact requested
// format ("Nifty50 15Sep 23400 CE · Target 110 · Entry (Buy) 86.5
// · Stop Loss 77") needs (a) the broker display name, (b) the
// DD+Mon expiry label, (c) the CURRENT weekly-expiry weekday.
//
// EXPIRY SCHEDULE (v9.6 FIX — user-verified vs the LIVE exchange,
// 11 Sep 2026): NSE NIFTY weekly = TUESDAY, BSE SENSEX weekly =
// THURSDAY. v9.4 had these SWAPPED — it served a "Nifty50 17Sep"
// card while the real Nifty weekly is 15Sep (17Sep ka Nifty contract
// exists hi nahi; BSE Sensex weekly 17Sep hai). The trader's broker
// terminal is ground truth. When the REAL NSE chain loads, its own
// expiryDates still win; but for SENSEX (BSE, datacenter-blocked)
// this map IS the expiry source, so it must be current.
// BANKEX/Sensex-50 weeklies are discontinued; BANKNIFTY is
// monthly-only — the map day only shapes the nearest-expiry guess
// for the synthetic chain.
// ------------------------------------------------------------
const INDEX_DISPLAY_NAMES = {
  NIFTY: 'Nifty50', BANKNIFTY: 'BankNifty', FINNIFTY: 'FinNifty',
  MIDCPNIFTY: 'MidcapNifty', NIFTYNXT50: 'NiftyNext50', SENSEX: 'Sensex',
};
const WEEKLY_EXPIRY_WEEKDAY = { NIFTY: 2, SENSEX: 4 }; // 2=Tue (NSE), 4=Thu (BSE)
// v9.7: SEBI weekly-expiry rationalization ke baad sirf NIFTY (NSE) aur
// SENSEX (BSE) ke weekly contracts zinda hain. BANKNIFTY / FINNIFTY /
// MIDCPNIFTY / NIFTYNXT50 ab MONTHLY-ONLY hain — expiry = month ka
// LAST Tuesday (NSE convention). Inka "next Tuesday" guess galat
// contract label deta tha; ab last-Tuesday hi hota hai.
const MONTHLY_ONLY = new Set(['BANKNIFTY', 'FINNIFTY', 'MIDCPNIFTY', 'NIFTYNXT50']);

/** Last <wd> (0=Sun…6=Sat) of the given calendar month (UTC date math). */
function lastWeekdayOfMonth(y, m, wd) {
  const d = new Date(Date.UTC(y, m + 1, 0)); // last day of month m
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() - wd + 7) % 7));
  return d;
}

/** Nearest monthly expiry (last Tuesday) for a MONTHLY_ONLY index, IST-aware. */
function nextMonthlyExpiryFor(sym, now = new Date()) {
  const wd = WEEKLY_EXPIRY_WEEKDAY[sym] ?? 2; // NSE family: last Tuesday
  const ist = new Date(now.getTime() + (330 + now.getTimezoneOffset()) * 60000);
  let d = lastWeekdayOfMonth(ist.getUTCFullYear(), ist.getUTCMonth(), wd);
  const cutoff = new Date(d); cutoff.setUTCHours(10, 0, 0, 0); // 15:30 IST = 10:00 UTC
  if (ist.getTime() >= cutoff.getTime()) {
    d = lastWeekdayOfMonth(ist.getUTCFullYear(), ist.getUTCMonth() + 1, wd);
  }
  return d.toISOString().slice(0, 10);
}

/** Nearest tradable expiry for a symbol under the CURRENT schedule. */
export function nextWeeklyExpiryFor(sym, now = new Date()) {
  if (MONTHLY_ONLY.has(sym)) return nextMonthlyExpiryFor(sym, now);
  const wd = WEEKLY_EXPIRY_WEEKDAY[sym] ?? 2; // NSE family default: Tuesday
  return nextWeeklyExpiry(now, wd);
}

/** "2026-09-17" → "17Sep", "2026-10-06" → "06Oct" — the trader shorthand the cards display.
 *  v20.0.1: day hamesha 2-digit padded (single-digit days — Oct 1-6 window —
 *  "6Oct" ban ke card-name contract /^DDMon$/ todate the; test caught it live). */
export function expiryLabel(expiry) {
  if (typeof expiry !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(expiry)) return null;
  const [, mm, dd] = expiry.split('-');
  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${String(parseInt(dd, 10)).padStart(2, '0')}${MON[parseInt(mm, 10) - 1] || ''}`;
}

const r2 = (v) => (Number.isFinite(v) ? Math.round(v * 100) / 100 : null);
const r1 = (v) => (Number.isFinite(v) ? Math.round(v * 10) / 10 : null);

// ---------------- chain analytics (works for BOTH sources) ----------------
export function analyzeChain(chain, spot) {
  if (!chain || !Array.isArray(chain.rows) || chain.rows.length === 0 || !(spot > 0)) return null;
  let callOI = 0, putOI = 0;
  const walls = [];
  for (const r of chain.rows) {
    callOI += r.callOI || 0;
    putOI += r.putOI || 0;
    walls.push({
      strike: r.strike,
      totalOI: (r.callOI || 0) + (r.putOI || 0),
      callOI: r.callOI || 0, putOI: r.putOI || 0,
      callOIChange: r.callOIChange || 0, putOIChange: r.putOIChange || 0,
    });
  }
  const pcr = callOI > 0 ? putOI / callOI : null;

  // Max pain: strike minimizing total writer payout.
  let maxPain = null, minPain = Infinity;
  const strikes = chain.rows.map(r => r.strike);
  for (const k of strikes) {
    let payout = 0;
    for (const r of chain.rows) {
      if (r.strike < k) payout += (k - r.strike) * (r.callOI || 0);
      if (r.strike > k) payout += (r.strike - k) * (r.putOI || 0);
    }
    if (payout < minPain) { minPain = payout; maxPain = k; }
  }

  // IV percentile from the chain's own IVs (ATM ± 3 strikes).
  const near = chain.rows.filter(r => Math.abs(r.strike - spot) / spot < 0.03);
  const ivs = near.flatMap(r => [r.callIV, r.putIV]).filter(v => v != null && v > 0).map(v => v / 100);
  const atmIV = ivs.length ? ivs.reduce((a, b) => a + b, 0) / ivs.length : null;

  // OI skew: which side is adding open interest today.
  let dCall = 0, dPut = 0;
  for (const r of chain.rows) { dCall += r.callOIChange || 0; dPut += r.putOIChange || 0; }
  const oiSkew = (dCall + dPut) > 0 ? (dCall - dPut) / (dCall + dPut) : null;

  // v6.7 GEX / GAMMA FLIP / EXPECTED MOVE (glama Trading-Volatility inspired).
  // All from data we ALREADY fetch (OI + IV + Greeks) — no new source.
  const gex = computeGex(chain, spot, atmIV);
  // v6.11 (glama tv-mcp skew + options flow): OTM put-vs-call IV skew
  // and volume/OI flow — real chains only (synthetic = honest null).
  const skewFlow = computeSkewFlow(chain, spot);

  return { pcr: r2(pcr), maxPain, atmIV: atmIV ? r2(atmIV * 100) : null, ivPercentile: null, oiSkew: r2(oiSkew), callOI, putOI, ...(gex ? { gex } : {}), ...(skewFlow || {}) };
}

/**
 * v6.11 — IV SKEW + VOLUME/OI FLOW (glama tv-mcp "skew" + "options
 * volume/flow"). Real-chain only (synthetic rows carry no volume/OI
 * → honest null, never a made-up number).
 *
 *   skew = avg OTM-put IV − avg OTM-call IV (strikes 2–6% from spot)
 *     positive skew = crash insurance in demand = fear bid
 *     negative/flat = complacency (call chasing)
 *   flow = call volume vs put volume + today's OI-change direction —
 *     who is actually paying premium today.
 */
export function computeSkewFlow(chain, spot) {
  if (!chain || !Array.isArray(chain.rows) || !(spot > 0)) return null;
  const isReal = chain.rows.some(r => (r.callVolume || 0) + (r.putVolume || 0) > 0 || (r.callOI || 0) + (r.putOI || 0) > 0);
  if (!isReal) return null;

  const putIVs = [], callIVs = [];
  let callVol = 0, putVol = 0, dCall = 0, dPut = 0;
  for (const r of chain.rows) {
    callVol += r.callVolume || 0; putVol += r.putVolume || 0;
    dCall += r.callOIChange || 0; dPut += r.putOIChange || 0;
    const dist = Math.abs(r.strike - spot) / spot;
    if (dist >= 0.02 && dist <= 0.06) {
      if (r.strike < spot && r.putIV > 0) putIVs.push(r.putIV);
      if (r.strike > spot && r.callIV > 0) callIVs.push(r.callIV);
    }
  }
  const avg = (a) => a.length ? a.reduce((s, v) => s + v, 0) / a.length : null;
  const putIV = avg(putIVs), callIV = avg(callIVs);
  const skew = (putIV != null && callIV != null) ? Math.round((putIV - callIV) * 10) / 10 : null;
  const volRatio = putVol > 0 ? callVol / putVol : null;
  const oiLean = (dCall + dPut) !== 0 ? (dCall - dPut) / (dCall + dPut) : null;

  const skewRead = skew == null ? 'OTM IVs thin — skew measure nahi hua'
    : skew >= 2.5 ? 'put skew HIGH — hedgers crash-insurance kharid rahe hain (fear bid)'
    : skew >= 0.5 ? 'mild put skew — normal protective demand'
    : skew > -0.5 ? 'flat skew — dono side equally priced (complacency zone)'
    : 'CALL skew — upside chasing (FOMO bid, rallies fade-prone)';
  const flowRead = volRatio == null ? 'volume data nahi'
    : volRatio >= 1.5 ? 'call volume dominates — aggressive upside bets aaj'
    : volRatio <= 0.67 ? 'put volume dominates — protection/downside bets aaj'
    : 'balanced two-way flow';

  return {
    skew: {
      putIV: putIV != null ? r1(putIV) : null,
      callIV: callIV != null ? r1(callIV) : null,
      value: skew,
      read: skewRead,
    },
    flow: {
      callVolume: Math.round(callVol),
      putVolume: Math.round(putVol),
      callPutVolRatio: volRatio != null ? r2(volRatio) : null,
      oiLean: oiLean != null ? r2(oiLean) : null,
      oiLeanRead: oiLean == null ? 'OI change flat'
        : oiLean > 0.15 ? 'calls OI add kar rahe — positioning bullish'
        : oiLean < -0.15 ? 'puts OI add kar rahe — positioning defensive'
        : 'OI changes balanced',
      read: flowRead,
    },
  };
}

/**
 * v6.7 — GAMMA EXPOSURE PROFILE (per-strike, flip, walls, expected move).
 *  GEX_k = gamma_k × OI_k × 100 × spot   (per-share gamma × contracts)
 *  call dealers are typically SHORT gamma / put dealers LONG — the
 *  standard retail approximation nets them: +put GEX − call GEX
 *  (positive net GEX = mean-reversion pin regime; negative = trend /
 *  gamma-flip acceleration regime).
 *  gammaFlip = strike where cumulative net GEX crosses zero.
 *  callWall / putWall = largest absolute strike-level GEX magnets.
 *  expectedMove = ATM straddle price × 0.85 (the classic 1-expiry
 *  expected-move proxy; ~1 SD under lognormal at expiry).
 * Only meaningful with REAL OI — synthetic chains return null
 *  (bs-model rows carry OI 0 → honest skip).
 */
export function computeGex(chain, spot, atmIVFallback) {
  if (!chain || !Array.isArray(chain.rows) || !(spot > 0)) return null;
  const expiry = chain.expiry;
  const T = yearsToExpiry(`${expiry}T15:30:00+05:30`);
  if (!(T > 0)) return null;
  const ivDefault = atmIVFallback ? Math.min(IV_CAP, Math.max(IV_FLOOR, atmIVFallback)) : 0.13;
  const hasRealOI = chain.rows.some(r => (r.callOI || 0) + (r.putOI || 0) > 0);
  if (!hasRealOI) return null; // model chain — no honest GEX

  const per = [];
  let cum = 0;
  const sorted = [...chain.rows].sort((a, b) => a.strike - b.strike);
  for (const r of sorted) {
    const callG = bsGreeks(spot, r.strike, T, RISK_FREE, Math.min(IV_CAP, Math.max(IV_FLOOR, (r.callIV || ivDefault * 100) / 100)), 'CE').gamma || 0;
    const putG = bsGreeks(spot, r.strike, T, RISK_FREE, Math.min(IV_CAP, Math.max(IV_FLOOR, (r.putIV || ivDefault * 100) / 100)), 'PE').gamma || 0;
    // dealer-positioning convention: calls short gamma (−), puts long gamma (+)
    const netGex = (putG * (r.putOI || 0) - callG * (r.callOI || 0)) * 100 * spot;
    cum += netGex;
    per.push({ strike: r.strike, netGex: Math.round(netGex), cumGex: Math.round(cum) });
  }

  // gamma flip: first zero-crossing of cumulative GEX (low → high strikes)
  let gammaFlip = null;
  for (let i = 1; i < per.length; i++) {
    if ((per[i - 1].cumGex < 0 && per[i].cumGex >= 0) || (per[i - 1].cumGex > 0 && per[i].cumGex <= 0)) {
      gammaFlip = per[i].strike; break;
    }
  }
  // walls: biggest absolute strike-level GEX on each side
  let callWall = null, putWall = null, maxAbs = 0, minAbs = 0;
  for (const p of per) {
    if (p.netGex < minAbs) { minAbs = p.netGex; callWall = p.strike; } // negative = call-side wall
    if (p.netGex > maxAbs) { maxAbs = p.netGex; putWall = p.strike; }  // positive = put-side wall
  }
  const totalNet = cum;

  // expected move from the ATM straddle (×0.85 empirical haircut)
  const atmRow = sorted.reduce((best, r) => (Math.abs(r.strike - spot) < Math.abs(best.strike - spot) ? r : best), sorted[0]);
  const straddle = (atmRow.callLTP || 0) + (atmRow.putLTP || 0);
  const hasLtp = straddle > 0;
  const emAbs = hasLtp ? straddle * 0.85 : (spot * (ivDefault * Math.sqrt(T)) * 0.85);
  const expectedMove = {
    abs: r2(emAbs),
    pct: r2((emAbs / spot) * 100),
    low: Math.round(spot - emAbs), high: Math.round(spot + emAbs),
    method: hasLtp ? 'atm-straddle×0.85' : 'bs-iv-approx',
  };

  const regimeNote = totalNet > 0
    ? 'Positive net GEX — dealers dampen moves (mean-reversion / pin toward walls)'
    : 'Negative net GEX — dealers hedge WITH the move (trend acceleration zone)';

  return {
    perStrike: per,
    gammaFlip,
    callWall, // v21.0.6 [audit]: dead no-op ternary removed (cond ? callWall : callWall)
    putWall,
    totalNetGex: Math.round(totalNet),
    expectedMove,
    regimeNote,
  };
}

// ---------------- synthetic BS chain (the honest fallback) ----------------
export function buildSyntheticChain(symbol, spot, iv, expiryDate, strikeCount = 21, sourceTag = 'bs-model') {
  const step = STRIKE_STEPS[symbol] || Math.max(1, Math.round(spot * 0.005));
  const atm = Math.round(spot / step) * step;
  const T = yearsToExpiry(`${expiryDate}T15:30:00+05:30`);
  if (!(T > 0)) return null;
  // v10.5.2 PUT-SKEW RECALIBRATION (ATM parity fix): v9.7 ka FLAT ATM
  // bump (PE +0.8 / CE −0.3 vol pts at EVERY strike — 1.1 vol pts
  // combined) near-dated ATM strikes par put-call parity ko overpower
  // karta tha — synthetic chain ATM put ko same-strike CALL se upar
  // price kar rahi thi (C−P ≈ −0.77 on a 1-day NIFTY weekly), jo kisi
  // bhi trader ke liye visibly wrong number hai. Real NSE index skew
  // DISTANCE-AWARE hai: ~0 at-the-money, growing crash-insurance
  // premium on OTM puts (2–6% OTM — wahi window computeSkewFlow()
  // upar measure karta hai). ATM rows ab skew-neutral hain → dono
  // legs EK hi smile IV share karti hain → BS identity
  // C − P = S − K·e^(−rT) exactly holds (parity naturally positive
  // for index options); OTM puts ko full crash premium milta hai,
  // OTM calls ko halka discount (the smirk).
  const PE_SKEW_MAX = 0.010;   // +1.0 vol pt full put premium at ≥5% OTM
  const CE_SKEW_MAX = -0.004;  // −0.4 vol pt call-side discount at ≥5% OTM
  const SKEW_RAMP_PCT = 0.05;   // linear ramp: 0 at ATM → full at 5% OTM
  const rows = [];
  for (let k = -strikeCount; k <= strikeCount; k++) {
    const strike = atm + k * step;
    if (strike <= 0) continue;
    // Smile: wings carry extra vol — a mild, standard curve.
    const m = Math.abs(Math.log(strike / spot));
    const smileIV = Math.min(IV_CAP, Math.max(IV_FLOOR, iv * (1 + 1.6 * m * m * 12)));
    // Distance-aware skew: ~0 at the money (parity untouched), full
    // crash premium by 5% OTM. Negative moneyness → OTM put side.
    const moneynessPct = (strike - spot) / spot;
    const peSkewAtStrike = PE_SKEW_MAX * Math.min(1, Math.max(0, -moneynessPct / SKEW_RAMP_PCT));
    const ceSkewAtStrike = CE_SKEW_MAX * Math.min(1, Math.max(0, moneynessPct / SKEW_RAMP_PCT));
    const putIV = Math.min(IV_CAP, Math.max(IV_FLOOR, smileIV + peSkewAtStrike));
    const callIV = Math.min(IV_CAP, Math.max(IV_FLOOR, smileIV + ceSkewAtStrike));
    const call = bsPrice(spot, strike, T, RISK_FREE, callIV, 'CE');
    const put = bsPrice(spot, strike, T, RISK_FREE, putIV, 'PE');
    rows.push({
      strike, expiry: expiryDate,
      callOI: 0, callOIChange: 0, callIV: r2(callIV * 100), callLTP: r2(call), callVolume: 0,
      putOI: 0, putOIChange: 0, putIV: r2(putIV * 100), putLTP: r2(put), putVolume: 0,
    });
  }
  return { symbol, spot: r2(spot), expiry: expiryDate, rows, source: sourceTag, synthetic: true, atmStrike: atm, fetchedAt: Date.now() };
}

// ---------------- assemble the full options desk payload ----------------
export async function getOptionsDesk(symbol = 'NIFTY') {
  const sym = String(symbol || 'NIFTY').toUpperCase();
  // v11.1 NSE+SENSEX addendum: SENSEX is a BSE index — there IS no NSE
  // chain for it (the old code used to hammer NSE's equities endpoint,
  // which can never answer). Route it through the best-effort BSE
  // fetch; every other underlying keeps the proven NSE path.
  const isBseIndex = sym === 'SENSEX';
  const [chain, quotes] = await Promise.all([
    (isBseIndex ? fetchBSEOptionChain(sym) : fetchNSEOptionChain(sym)).catch(() => null),
    fetchYahooQuotes([sym, 'INDIAVIX']).catch(() => ({})),
  ]);
  const spot = chain?.spot ?? quotes[sym]?.price ?? null;
  const vix = quotes['INDIAVIX']?.price ?? null;

  let outChain = null, analytics = null;
  if (chain && spot) {
    // Pick the nearest weekly expiry from the exchange's own list. Compare against
    // the IST calendar date (before 05:30 IST the UTC date is yesterday —
    // an already-passed expiry would otherwise still be selectable).
    const today = (() => {
      try { return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date()); }
      catch { return new Date().toISOString().slice(0, 10); }
    })();
    // v21.1.1 [audit C8]: 15:30 ke baad TODAY's expiry drop — degenerate
    // zero-greeks table (T=0) serve hota tha jabki option settle ho chuka.
    // Market-close ke baad sirf aagli expiry hi pick hogi.
    const _pastCloseToday = (() => {
      try {
        const ist = new Date(Date.now() + 5.5 * 3600_000);
        return ist.getUTCHours() > 15 || (ist.getUTCHours() === 15 && ist.getUTCMinutes() >= 30);
      } catch { return false; }
    })();
    const exp = (chain.expiryDates || []).map(d => String(d))
      .filter(d => d >= today && !(_pastCloseToday && d === today)).sort()[0]
      || nextWeeklyExpiryFor(sym);
    const rows = chain.rows.filter(r => r.expiry === exp);
    if (rows.length > 5) {
      outChain = { symbol: sym, spot: r2(spot), expiry: exp, rows, source: chain.source, via: chain.via || null, lotSize: Number(chain.lotSize) || null, fetchedAt: chain.fetchedAt };
      analytics = analyzeChain(outChain, spot);
      // IV percentile approximated from ATM IV vs VIX level.
      if (analytics?.atmIV != null && vix) {
        analytics.ivPercentile = r1(Math.max(0, Math.min(100, 50 + (analytics.atmIV - vix) * 6)));
      }
    }
  }
  let syntheticNote = null;
  if (!outChain && spot) {
    // BS-synthetic fallback: IV anchored to India VIX (or 13% floor).
    const iv = vix ? Math.min(IV_CAP, Math.max(IV_FLOOR, vix / 100)) : 0.13;
    const expiry = nextWeeklyExpiryFor(sym);
    // v11.1 source honesty — two DIFFERENT kinds of "model chain":
    //   SENSEX (BSE datacenter-blocked, spike-verified) → PERMANENT,
    //   structural: its own tag + the persistent-limitation banner.
    //   NIFTY-family (NSE usually reachable) → RECOVERABLE outage.
    const sourceTag = isBseIndex ? SENSEX_MODEL_SOURCE : NIFTY_MODEL_SOURCE;
    outChain = buildSyntheticChain(sym, spot, iv, expiry, 21, sourceTag);
    if (outChain) {
      syntheticNote = isBseIndex
        ? `${SENSEX_MODEL_BANNER} Premiums below are Black-Scholes estimates (IV anchored to India VIX ${vix ? r1(vix) : 'n/a'} + India put-skew) — OI/PCR/GEX unavailable in model mode.`
        : `NSE chain temporarily unreachable from this server (direct NSE + Groww public mirror dono tried; auto-retry chalu hai) — showing a Black-Scholes model chain (IV anchored to India VIX ${vix ? r1(vix) : 'n/a'} + India put-skew). Premiums are model estimates, NOT live quotes; OI/PCR unavailable in model mode. The next successful fetch restores live data.`;
      analytics = null; // honest: no real OI → no PCR/max-pain
    }
  }

  if (!outChain) {
    return { ok: false, symbol: sym, reason: 'No spot price or chain data available right now', spot, vix };
  }

  // OptionsFlow model inputs for the ensemble (India index signals).
  const optionsCtx = analytics ? {
    pcr: analytics.pcr, maxPain: analytics.maxPain,
    ivPercentile: analytics.ivPercentile, oiSkew: analytics.oiSkew,
  } : null;

  return {
    ok: true,
    symbol: sym,
    spot: outChain.spot,
    spotChangePct: r2(chain?.spotChangePct ?? quotes[sym]?.changePct ?? null),
    vix: r1(vix),
    expiry: outChain.expiry,
    // v6.13: days-to-expiry (0 = expiry-day) for the ticket UI
    dte: daysToExpiry(outChain.expiry),
    source: outChain.source,
    // v21.0.4: which live relay served the chain ('groww' mirror vs direct)
    sourceVia: outChain.via || null,
    syntheticNote,
    lotSize: outChain.lotSize || LOT_SIZES[sym] || 1,
    analytics,
    optionsCtx,
    // ATM ± 6 strikes for the UI table.
    rows: outChain.rows
      .filter(r => Math.abs(r.strike - (outChain.atmStrike ?? Math.round(spot / (STRIKE_STEPS[sym] || 50)) * (STRIKE_STEPS[sym] || 50))) <= (STRIKE_STEPS[sym] || 50) * 6)
      .map(r => ({ ...r, callGreeks: greeksFor(spot, r.strike, outChain.expiry, r.callIV, 'CE'), putGreeks: greeksFor(spot, r.strike, outChain.expiry, r.putIV, 'PE') })),
    fetchedAt: Date.now(),
  };
}

function greeksFor(spot, strike, expiry, ivPct, type) {
  const T = yearsToExpiry(`${expiry}T15:30:00+05:30`);
  const sigma = ivPct ? Math.max(IV_FLOOR, Math.min(IV_CAP, ivPct / 100)) : 0.13;
  const g = bsGreeks(spot, strike, T, RISK_FREE, sigma, type);
  return {
    delta: r2(g.delta),
    // v21.0.3: index-option gamma ~0.0005-0.005 — r2 usse 0.00 bana deta
    // tha (chain table me "gamma khaali" dikhta tha). 4dp jab chhota ho.
    gamma: Math.abs(g.gamma) < 0.01 ? +(g.gamma).toFixed(4) : r2(g.gamma),
    theta: r2(g.theta),
    vega: r2(g.vega),
  };
}

// ---------------- strategy builder ----------------
/**
 * v6.7 additions (glama trading_skills-inspired):
 *   • POP — probability of profit at expiry via the lognormal
 *     terminal distribution (Black-Scholes N(d2) of the breakevens).
 *   • payoff — sampled expiry payoff curve (per share) for the UI's
 *     SVG chart: [{ s: spot, pnl }] across ±6% of spot.
 *   • Short Straddle + Short Strangle (premium harvesting when the
 *     ensemble is NEUTRAL / low conviction), and a Long Straddle
 *     (event-style breakout play) when conviction is split but the
 *     IV percentile is LOW (cheap vol + coiled setup).
 */
function popFor({ spot, expiry, atmIV, breakevens, bias, kind }) {
  const T = yearsToExpiry(`${expiry}T15:30:00+05:30`);
  if (!(T > 0) || !(spot > 0) || !atmIV || !Array.isArray(breakevens) || breakevens.length === 0) return null;
  const sigma = Math.min(IV_CAP, Math.max(IV_FLOOR, atmIV / 100));
  // P(S_T > K) = N(d2(K))
  const pAbove = (K) => {
    const d2 = (Math.log(spot / K) + (RISK_FREE - 0.5 * sigma * sigma) * T) / (sigma * Math.sqrt(T));
    return normCdf(d2);
  };
  let p;
  if (kind === 'credit-range' && breakevens.length >= 2) {
    // profit BETWEEN the breakevens: P(low < S_T < high)
    const [lo, hi] = [...breakevens].sort((a, b) => a - b);
    p = pAbove(lo) - pAbove(hi);
  } else if (kind === 'breakout' && breakevens.length >= 2) {
    // v11.4 recheck: LONG STRADDLE — profit OUTSIDE both breakevens:
    // P(S_T > hi) + P(S_T < lo). It previously fell into the debit
    // branch's bearish arm (bias 'BREAKOUT' !== 'BULLISH') computing
    // P(S ≤ hi) — counting the whole between-BE loss zone as "profit"
    // and systematically overstating the straddle's POP.
    const [lo, hi] = [...breakevens].sort((a, b) => a - b);
    p = pAbove(hi) + (1 - pAbove(lo));
  } else if (kind === 'debit') {
    const b = breakevens[0];
    p = bias === 'BULLISH' ? pAbove(b) : 1 - pAbove(b);
  } else { // credit-tail (short straddle-ish): profit below BE1 / above BE2
    const [lo, hi] = [...breakevens].sort((a, b) => a - b);
    p = pAbove(lo) + (1 - pAbove(hi));
  }
  return r1(Math.max(0, Math.min(100, p * 100)));
}

/** Expiry payoff per share at spot s for a leg list. */
function payoffPoint(legs, s) {
  let pnl = 0;
  for (const l of legs) {
    const intrinsic = l.type === 'CE' ? Math.max(0, s - l.strike) : Math.max(0, l.strike - s);
    const signed = l.action === 'BUY' ? intrinsic - l.premium : l.premium - intrinsic;
    pnl += signed;
  }
  return Math.round(pnl * 100) / 100;
}

function attachPnlProfile(strat, { spot, expiry, atmIV }) {
  if (!strat) return strat;
  const legs = strat.legs || [];
  if (!(spot > 0) || legs.length === 0) return strat;
  const lo = spot * 0.94, hi = spot * 1.06;
  const points = [];
  for (let k = 0; k <= 24; k++) {
    const s = Math.round((lo + ((hi - lo) * k) / 24) / 1) ;
    points.push({ s, pnl: payoffPoint(legs, s) });
  }
  strat.payoff = points;
  strat.pop = popFor({ spot, expiry, atmIV, breakevens: strat.breakevens, bias: strat.bias, kind: strat._popKind || 'debit' });
  delete strat._popKind;
  return strat;
}

/**
 * Convert an ensemble direction into CONCRETE priced strategies.
 * Each strategy: legs + maxProfit/maxLoss + breakevens + net Greeks.
 * All values per SHARE (multiply by lotSize for the contract).
 */
export function buildStrategies(desk, consensus) {
  if (!desk?.ok || !(desk.spot > 0)) return [];
  const { symbol, spot, expiry, lotSize, rows } = desk;
  const step = STRIKE_STEPS[symbol] || 50;
  const atm = Math.round(spot / step) * step;
  const find = (strike) => rows.find(r => r.strike === strike) || null;
  const leg = (action, type, strike) => {
    const row = find(strike);
    const iv = (type === 'CE' ? row?.callIV : row?.putIV) || null;
    const premium = (type === 'CE' ? row?.callLTP : row?.putLTP)
      ?? r2(bsPrice(spot, strike, yearsToExpiry(`${expiry}T15:30:00+05:30`), RISK_FREE, 0.13, type));
    const g = greeksFor(spot, strike, expiry, iv, type);
    return {
      action, type, strike,
      premium: r2(premium),
      iv: iv ? r1(iv) : null,
      delta: g.delta, theta: g.theta,
    };
  };
  const _T = yearsToExpiry(`${expiry}T15:30:00+05:30`);
  const out = [];
  // v6.7: POP needs an IV anchor — real chain ATM IV, else the VIX the
  // synthetic chain was priced from (honest model-estimated POP)
  const atmIV = desk?.analytics?.atmIV ?? (desk?.vix != null ? r1(desk.vix) : null);
  const ivPct = desk?.analytics?.ivPercentile ?? null;

  const side = consensus?.side || 'FLAT';
  const conf = consensus?.confidence || 0;
  const grade = consensus?.grade || 'NEUTRAL';

  // --- STRONG LONG: Bull Call Spread (defined-risk directional) ---
  if (side === 'LONG' && (grade === 'STRONG' || grade === 'ACTION')) {
    const l1 = leg('BUY', 'CE', atm);
    const l2 = leg('SELL', 'CE', atm + 2 * step);
    const debit = l1.premium - l2.premium;
    const width = l2.strike - l1.strike;
    out.push({
      id: 'bull-call-spread', name: 'Bull Call Spread', _popKind: 'debit',
      bias: 'BULLISH', conviction: grade,
      rationale: `Ensemble consensus LONG ${conf}% — buy the ATM call, sell 2-strikes OTM to fund it. Defined risk, IV-tolerant.`,
      legs: [l1, l2],
      netDebit: r2(debit),
      maxProfit: r2(Math.max(0, width - debit)),
      maxLoss: r2(debit),
      breakevens: [r2(l1.strike + debit)],
      netDelta: r2(l1.delta - l2.delta), netTheta: r2(l1.theta - l2.theta),
      perLot: { maxProfit: r2(Math.max(0, width - debit) * lotSize), maxLoss: r2(debit * lotSize) },
      exitPlan: `Book at target2 of the index plan or 50% of max profit; hard-stop at 60% of debit. Expiry ${expiry}.`,
    });
    // Momentum kicker for STRONG: naked-ish directional long call.
    if (grade === 'STRONG') {
      const l = leg('BUY', 'CE', atm);
      out.push({
        id: 'long-call', name: 'Long Call (ATM)', _popKind: 'debit',
        bias: 'BULLISH', conviction: 'STRONG',
        rationale: `STRONG consensus ${conf}% with ${Math.round((consensus?.agreement || 0) * 100)}% agreement — full directional exposure via ATM call (only when IV percentile < 60).`,
        legs: [l],
        netDebit: r2(l.premium),
        maxProfit: null, // unlimited
        maxLoss: r2(l.premium),
        breakevens: [r2(atm + l.premium)],
        netDelta: l.delta, netTheta: l.theta,
        perLot: { maxProfit: null, maxLoss: r2(l.premium * lotSize) },
        exitPlan: `Trail at 1.5× debit; stop at 50% premium decay; expiry-day theta burn is severe — square by ${expiry} 14:30.`,
      });
    }
  }

  // --- STRONG SHORT: Bear Put Spread ---
  if (side === 'SHORT' && (grade === 'STRONG' || grade === 'ACTION')) {
    const l1 = leg('BUY', 'PE', atm);
    const l2 = leg('SELL', 'PE', atm - 2 * step);
    const debit = l1.premium - l2.premium;
    const width = l1.strike - l2.strike;
    out.push({
      id: 'bear-put-spread', name: 'Bear Put Spread', _popKind: 'debit',
      bias: 'BEARISH', conviction: grade,
      rationale: `Ensemble consensus SHORT ${conf}% — buy the ATM put, sell 2-strikes ITM to fund it. Defined risk.`,
      legs: [l1, l2],
      netDebit: r2(debit),
      maxProfit: r2(Math.max(0, width - debit)),
      maxLoss: r2(debit),
      breakevens: [r2(l1.strike - debit)],
      netDelta: r2(l1.delta - l2.delta), netTheta: r2(l1.theta - l2.theta),
      perLot: { maxProfit: r2(Math.max(0, width - debit) * lotSize), maxLoss: r2(debit * lotSize) },
      exitPlan: `Book at target2 or 50% max profit; stop at 60% of debit. Expiry ${expiry}.`,
    });
    if (grade === 'STRONG') {
      const l = leg('BUY', 'PE', atm);
      out.push({
        id: 'long-put', name: 'Long Put (ATM)', _popKind: 'debit',
        bias: 'BEARISH', conviction: 'STRONG',
        rationale: `STRONG consensus ${conf}% — full directional downside via ATM put (check IV percentile first).`,
        legs: [l],
        netDebit: r2(l.premium),
        maxProfit: null, // down to zero
        maxLoss: r2(l.premium),
        breakevens: [r2(atm - l.premium)],
        netDelta: l.delta, netTheta: l.theta,
        perLot: { maxProfit: null, maxLoss: r2(l.premium * lotSize) },
        exitPlan: `Trail at 1.5× debit; stop at 50% decay; square by ${expiry} 14:30.`,
      });
    }
  }

  // --- NEUTRAL / low conviction: Iron Condor ---
  if (out.length === 0 || grade === 'NEUTRAL' || grade === 'WATCH') {
    const wings = 4 * step;
    const legs = [
      leg('SELL', 'CE', atm + wings),
      leg('BUY', 'CE', atm + wings + 2 * step),
      leg('SELL', 'PE', atm - wings),
      leg('BUY', 'PE', atm - wings - 2 * step),
    ];
    const credit = legs[0].premium - legs[1].premium + legs[2].premium - legs[3].premium;
    const width = 2 * step;
    out.push({
      id: 'iron-condor', name: 'Iron Condor', _popKind: 'credit-range',
      bias: 'NEUTRAL', conviction: grade,
      rationale: `No STRONG consensus (${conf}%) — harvest theta instead: sell 4-strike OTM wings, buy protection. Works when IV percentile is high.`,
      legs,
      netCredit: r2(credit),
      maxProfit: r2(credit),
      maxLoss: r2(Math.max(0, width - credit)),
      breakevens: [r2(atm + wings + credit), r2(atm - wings - credit)],
      netDelta: r2(legs.reduce((a, l) => a + (l.action === 'SELL' ? -l.delta : l.delta), 0)),
      netTheta: r2(legs.reduce((a, l) => a + (l.action === 'SELL' ? -l.theta : l.theta), 0)),
      perLot: { maxProfit: r2(credit * lotSize), maxLoss: r2(Math.max(0, width - credit) * lotSize) },
      exitPlan: `Book at 50% credit or adjust when spot breaches a short strike. Avoid holding into expiry-day gamma.`,
    });

    // v6.7 — SHORT STRADDLE: premium harvesting when real OI/IV data says
    // the desk is truly neutral AND vol is RICH (IV percentile ≥ 55 — sell
    // expensive vol, not cheap vol). Defined-risk guard: wings appended.
    if ((ivPct == null || ivPct >= 55) && out.every(s => s.id !== 'short-straddle')) {
      const legsS = [
        leg('SELL', 'CE', atm),
        leg('SELL', 'PE', atm),
        leg('BUY', 'CE', atm + 4 * step),
        leg('BUY', 'PE', atm - 4 * step),
      ];
      const creditS = legsS[0].premium + legsS[1].premium - legsS[2].premium - legsS[3].premium;
      if (creditS > 0) {
        out.push({
          id: 'short-straddle', name: 'Iron Fly (Short Straddle + Wings)', _popKind: 'credit-range',
          bias: 'NEUTRAL', conviction: grade,
          rationale: `Neutral ensemble (${conf}%) + rich IV (percentile ${ivPct ?? 'n/a'}) — sell the ATM straddle, buy 4-strike wings to cap the tail. Theta-positive, gamma-risky: size small.`,
          legs: legsS,
          netCredit: r2(creditS),
          maxProfit: r2(creditS),
          maxLoss: r2(Math.max(0, 4 * step - creditS)),
          breakevens: [r2(atm - creditS), r2(atm + creditS)],
          netDelta: r2(legsS.reduce((a, l) => a + (l.action === 'SELL' ? -l.delta : l.delta), 0)),
          netTheta: r2(legsS.reduce((a, l) => a + (l.action === 'SELL' ? -l.theta : l.theta), 0)),
          perLot: { maxProfit: r2(creditS * lotSize), maxLoss: r2(Math.max(0, 4 * step - creditS) * lotSize) },
          exitPlan: `Book 50% credit fast; hard-adjust when |spot − ${atm}| > ${2 * step}. Never hold naked — wings are the seatbelt.`,
        });
      }
    }

    // v6.7 — SHORT STRANGLE (OTM credit, cheaper gamma than the fly):
    // sell 2-strike OTM call + 2-strike OTM put, 5-strike wings.
    if (out.every(s => s.id !== 'short-strangle')) {
      const legsG = [
        leg('SELL', 'CE', atm + 2 * step),
        leg('SELL', 'PE', atm - 2 * step),
        leg('BUY', 'CE', atm + 5 * step),
        leg('BUY', 'PE', atm - 5 * step),
      ];
      const creditG = legsG[0].premium + legsG[1].premium - legsG[2].premium - legsG[3].premium;
      if (creditG > 0) {
        out.push({
          id: 'short-strangle', name: 'Short Strangle (Winged)', _popKind: 'credit-range',
          bias: 'NEUTRAL', conviction: grade,
          rationale: `Neutral ensemble (${conf}%) — sell 2-strike OTM call+put strangle, cap tails with 5-strike wings. Wider profit zone than the Iron Fly, lower credit.`,
          legs: legsG,
          netCredit: r2(creditG),
          maxProfit: r2(creditG),
          maxLoss: r2(Math.max(0, 3 * step - creditG)),
          breakevens: [r2(atm - 2 * step - creditG), r2(atm + 2 * step + creditG)],
          netDelta: r2(legsG.reduce((a, l) => a + (l.action === 'SELL' ? -l.delta : l.delta), 0)),
          netTheta: r2(legsG.reduce((a, l) => a + (l.action === 'SELL' ? -l.theta : l.theta), 0)),
          perLot: { maxProfit: r2(creditG * lotSize), maxLoss: r2(Math.max(0, 3 * step - creditG) * lotSize) },
          exitPlan: `Book 50% credit; roll the tested side when spot breaches a short strike. Wings cap the disaster case.`,
        });
      }
    }
  }

  // v6.7 — LONG STRADDLE (event/breakout play): conviction is SPLIT
  // (WATCH/NEUTRAL) and vol is CHEAP (IV percentile ≤ 40 or unknown
  // with low VIX) — pay for both sides and let the breakout pay for it.
  if ((grade === 'WATCH' || grade === 'NEUTRAL' || side === 'FLAT') && (ivPct == null || ivPct <= 40)) {
    const lc = leg('BUY', 'CE', atm);
    const lp = leg('BUY', 'PE', atm);
    const debit = lc.premium + lp.premium;
    if (debit > 0) {
      out.push({
        id: 'long-straddle', name: 'Long Straddle (ATM)', _popKind: 'breakout',
        bias: 'BREAKOUT', conviction: 'WATCH',
        rationale: `Split committee (${conf}%) + cheap vol (IV percentile ${ivPct ?? 'n/a'}) — buy the ATM straddle: any move beyond ±${r1((debit / spot) * 100)}% at expiry pays. Theta bleeds daily — this is a coiled-spring bet, not a hold.`,
        legs: [lc, lp],
        netDebit: r2(debit),
        maxProfit: null,
        maxLoss: r2(debit),
        breakevens: [r2(atm + debit), r2(atm - debit)],
        netDelta: r2(lc.delta + lp.delta), netTheta: r2(lc.theta + lp.theta),
        perLot: { maxProfit: null, maxLoss: r2(debit * lotSize) },
        exitPlan: `Sell into the breakout at +100% premium; stop at 40% decay by day 3. Expiry-day gamma is the friend ONLY if the move comes.`,
      });
    }
  }

  // v6.7 — attach POP + payoff profile to every strategy
  // v6.13 — attach the ORDER TICKET (step-by-step entry/exit guide)
  return out.map(s => {
    const withPop = attachPnlProfile(s, { spot, expiry, atmIV });
    withPop.orderTicket = buildOrderTicket(desk, withPop, consensus);
    return withPop;
  });
}

// ------------------------------------------------------------
// v6.13 — ORDER TICKET: the "trade kaise karna hai" layer.
// Converts a priced strategy into a step-by-step broker-ready
// guide: KAB (session phase + grade honesty) · KONSA expiry
// (DTE-aware theta logic) · LIMIT ORDER (per-leg prices at the
// NSE 0.05 tick, BUY slightly-above / SELL slightly-below for
// fill probability) · EXIT (SL% / target / time-exit) · lots.
// PURE — `now` injectable for tests. Honest: missing data → null.
// ------------------------------------------------------------
const roundToTick = (v) => Math.round(v * 20) / 20; // NSE ₹0.05 tick

export function daysToExpiry(expiry, now = Date.now()) {
  // IST calendar-date semantics: expiry aaj (IST) → 0, kal → 1.
  // (Epoch-diff/ceil off-by-one deta — aaj expiry ko "1 din baaki"
  // bol deta tha, jo option trader ke liye jhooth hai.)
  if (typeof expiry !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(expiry)) return null;
  const nowIst = new Date(now + 330 * 60000).toISOString().slice(0, 10); // IST wall-clock date
  const d = Math.round((Date.parse(`${expiry}T00:00:00Z`) - Date.parse(`${nowIst}T00:00:00Z`)) / 86_400_000);
  return Number.isFinite(d) ? d : null;
}

function expiryAdvice(dte, expiry) {
  if (dte == null) return { dte: null, expiryDay: false, text: 'Expiry date confirm nahi hui — order se pehle broker me expiry check karo.' };
  if (dte <= 0) return {
    dte: 0, expiryDay: true,
    text: `⚠️ Ye chain AAJ ke expiry (${expiry} 15:30) pe hai — aaj expiry me raat bhar theta ~100% jala + gamma violent. Sirf scalpers. Aaj lena hi hai to 14:00–14:30 tak square-off PAKKA. Aaram se lena hai to NEXT weekly expiry lo (chain dropdown me agli date) — wahan premium full nahi bhaadkti.`,
  };
  if (dte === 1) return { dte: 1, expiryDay: false, text: `Kal (${expiry}) expiry hai — intraday direction ke liye theek, par position AAJ hi close karo: kal subah opening gap + theta dono premium kha sakte hain.` };
  if (dte <= 4) return { dte, expiryDay: false, text: `Current weekly expiry (${expiry}, ${dte} din baaki) — intraday F&O ke liye sabse best liquidity aur fast premium response.` };
  return { dte, expiryDay: false, text: `Weekly expiry ${dte} din door hai (${expiry}) — premium dheere move hota hai; intraday ke liye theek, agar swing lena hai to next weekly bhi dekh lo.` };
}

function whenAdvice(consensus, directional, now) {
  const phase = sessionPhase('INDIA', now);
  const grade = consensus?.grade || 'NEUTRAL';
  const gradeOk = grade === 'STRONG' || grade === 'ACTION';
  const gradeLine = directional && !gradeOk
    ? `⚠️ Ensemble signal abhi ${grade}-grade hai — ACTION hone tak entry MAT karo (ye desk sirf mature signals pe bolta hai). `
    : '';
  const phaseText = {
    PRE_OPEN: 'Market abhi band hai (pre-open) — order mat lagao. Best plan: 9:30 MORNING window me limit order.',
    OPENING: '9:15–9:30 opening noise hai — spread wide, moves fake. 9:30 ka wait karo, fir entry.',
    MORNING: 'MORNING prime window (9:30–10:30) — entry ke liye best time, liquidity full.',
    MIDDAY: 'Midday chop (10:30–13:30) — entry sirf level pe, size aadha rakho.',
    AFTERNOON: 'Afternoon window (13:30–14:30) — trend continuation entries OK.',
    POWER: 'Power hour (14:30–15:15) — momentum entries OK, par 15:15 se pehle hi.',
    NO_NEW_ENTRIES: '15:15+ hai — fresh entry band, sirf square-off. Naya trade kal MORNING window me.',
    CLOSED: 'NSE band hai — order abhi nahi (kal gap risk). Plan ready rakho, kal 9:30 me lagao.',
  }[phase.phase] || `Session: ${phase.phase}.`;
  return { text: gradeLine + phaseText, phase: phase.phase, tradeable: !!phase.tradeable };
}

function exitAdvice(strat, expiryInfo) {
  const id = strat.id;
  const expiryDay = expiryInfo.expiryDay;
  // (a) directional debit spreads — SL on combined premium, target on
  //     half the width, time on broker MIS auto square-off.
  if (id === 'bull-call-spread' || id === 'bear-put-spread') {
    const debit = strat.netDebit ?? 0;
    const half = debit / 2;
    return {
      sl: `SL: combined premium 50% gir jaye (₹${r2(debit)} → ₹${r2(half)}) ya index apna SL level tode — jo PEHLE aaye. Entry order ke SAATH hi SL lagao (bracket/cover order ya turant SL-M) — baad me sochne ka time nahi hota.`,
      target: `Target: 50% max profit book karo (premium ₹${r2(debit)} → ₹${r2(debit + (strat.maxProfit ?? 0) / 2)}) ya index T2 — dono me se jo pehle. Greed nahi — 50% par nikal jao.`,
      time: expiryDay
        ? 'Aaj expiry hai: 14:00–14:30 tak square-off COMPULSORY (theta last ghante me sab kha jaata hai).'
        : 'Intraday (MIS): broker 15:15 auto square-off karega. Raat tak hold chahiye to NRML/CF product me lo (margin badhta hai).',
    };
  }
  // (b) naked directionals — premium-% based (option ka SL index level
  //     pe nahi, premium pe hota hai).
  if (id === 'long-call' || id === 'long-put') {
    const p = strat.netDebit ?? 0;
    return {
      sl: `SL: premium −40% (₹${r2(p)} → ₹${r2(p * 0.6)}) — OPTION me SL premium pe lagate hain, index level pe nahi. Broker me SL-M trigger ₹${r2(p * 0.6)} premium ke barabar.`,
      target: `Target: premium +80–100% (₹${r2(p)} → ₹${r2(p * 1.8)}–${r2(p * 2)}) ya index T2. +50% ke baad SL ko entry (cost) pe shift karo — trade free ho jaata hai.`,
      time: expiryDay
        ? 'Expiry-day hai: 14:30 se pehle book karo — 15:00 ke baad ATM premium zero-bazaar hai.'
        : `Expiry-day (${expiryInfo.expiry}) 14:30 se pehle pakka exit — last din theta burn severe hai.`,
    };
  }
  // (c) credit harvesters — theta tumhari taraf, par gamma risk.
  if (id === 'iron-condor' || id === 'short-straddle' || id === 'short-strangle') {
    const credit = strat.netCredit ?? strat.maxProfit ?? 0;
    return {
      sl: `SL/Adjust: spot kisi SHORT strike ke paas aa jaye (±${r1(Math.abs((strat.breakevens?.[0] ?? 0) - (strat.legs?.[0]?.strike ?? 0))) || 'level'} ke andar) → roll/adjust ya exit. Loss cap: net credit ka ~2× — isse aage mat pahunchne do.`,
      target: `Target: 50% credit jaldi book karo (₹${r2(credit)} me se ₹${r2(credit / 2)}) — theta tumhari taraf hai, time ke saath profit badhta hai, par greed mat karo.`,
      time: 'Expiry-day (Thursday) subah tak exit — aakhri din gamma pin violent hota hai, wings ke bawajood slippage milti hai.',
    };
  }
  // (d) long straddle — breakout play.
  if (id === 'long-straddle') {
    const p = strat.netDebit ?? 0;
    return {
      sl: `SL: straddle premium −30% (₹${r2(p)} → ₹${r2(p * 0.7)}) — coil fail maan ke nikal jao.`,
      target: `Target: premium +60–100% — breakout aaye to EK side ki option book karo, doosri hedge ban jaati hai.`,
      time: 'Max 2–3 din hold — har din theta ~2–4% premium kaat ta hai. Breakout ke turant baad book karo.',
    };
  }
  return { sl: '—', target: '—', time: '—' };
}

export function buildOrderTicket(desk, strat, consensus, now = Date.now()) {
  try {
    if (!desk?.ok || !(desk.spot > 0) || !strat?.legs?.length || !(desk.lotSize > 0)) return null;
    const lotSize = desk.lotSize;
    const expiryInfo = expiryAdvice(daysToExpiry(desk.expiry, now), desk.expiry);
    const directional = strat.bias === 'BULLISH' || strat.bias === 'BEARISH';
    const when = whenAdvice(consensus, directional, now);
    // Per-leg LIMIT prices: BUY ko tick-up (+1% cushion — fill milti hai,
    // overpay ka limit hai), SELL ko tick-down (fill mile, zyada cheap
    // nahi bechna padta).
    const legs = strat.legs.map(l => {
      const ltp = Number(l.premium) || 0;
      if (!(ltp > 0)) return null;
      const limit = l.action === 'BUY'
        ? roundToTick(Math.max(ltp + 0.05, ltp * 1.01))
        : roundToTick(Math.max(0.05, ltp * 0.99));
      return { action: l.action, type: l.type, strike: l.strike, ltp: r2(ltp), limit: r2(limit), qtyPerLot: lotSize };
    }).filter(Boolean);
    if (legs.length !== strat.legs.length) return null;
    const perLotLoss = Number.isFinite(strat.perLot?.maxLoss) && strat.perLot.maxLoss > 0
      ? Math.round(strat.perLot.maxLoss) : null;
    const lotRows = perLotLoss ? [1, 2, 3].map(l => ({ lots: l, maxLoss: perLotLoss * l })) : [];
    return {
      kind: (strat.netCredit ?? 0) > 0 ? 'credit' : 'debit',
      dte: expiryInfo.dte,
      expiryDay: expiryInfo.expiryDay,
      whenText: when.text,
      sessionPhase: when.phase,
      sessionTradeable: when.tradeable,
      expiryText: expiryInfo.text,
      legs,
      lotRows,
      perLotLoss,
      exit: exitAdvice(strat, expiryInfo),
    };
  } catch {
    return null; // honest — ticket nahi bana to UI guide nahi dikhayega
  }
}

// ------------------------------------------------------------
// v9.4 — F&O OPTION SIGNAL CARDS ("Stock name: Nifty50 17Sep 23400 CE
// · Target · Entry (Buy) · Stop Loss"). Converts the ensemble's INDEX
// consensus into ONE concrete, fully-priced option contract card:
//
//   direction LONG → BUY the ATM CE; SHORT → BUY the ATM PE
//     (option buying keeps the card honest: defined premium risk,
//     no margin, exactly how an intraday F&O retail ticket looks)
//   Entry      = the contract's live premium (NSE chain LTP, else
//                the BS model price — the card carries its source)
//   Target     = the SAME option re-priced with the index at the
//                ensemble plan's target1 (BS holds IV+expiry fixed —
//                the standard "what's my premium if NIFTY goes to X")
//   Stop Loss  = the option re-priced with the index at plan stopLoss
//
// Premium guards (BUY semantics — SL < entry < target, always):
//   • target must clear entry by ≥10%, else premium-based +30%
//   • SL must sit below entry; BS-implied loss capped at 65% of
//     premium (a full wipe as the suggested stop is never "accurate")
// Every level rounds to the NSE ₹0.05 tick.
// ------------------------------------------------------------
// v9.6 — SUPERINTELLIGENCE F&O SIGNAL CARDS. The user's exact
// requested format kept front-and-center:
//
//   Stock name : Nifty50 15Sep 23400 CE
//   Target     : 110.00
//   Entry (Buy): 86.50
//   Stop Loss  : 77.00
//
// UPGRADE over v9.4 (single ATM card):
//   • THREE candidates per index — ATM + ITM + OTM (one strike each
//     side) — every one re-priced the v9.4 way: LONG → BUY the CE,
//     SHORT → BUY the PE (defined premium risk, no margin); Target/
//     SL = the option BS re-priced at the ensemble plan's target1/
//     stopLoss. Premium guards (BUY semantics — SL < entry < target,
//     always): target must clear entry by ≥10% (else premium-based
//     +30%), BS-implied loss capped at 65% of premium, every level
//     on the NSE ₹0.05 tick.
//   • every candidate carries an AI SCORE (0-100, transparent blend:
//     35% index-consensus confidence + 20% POP-at-expiry + 15%
//     reward:risk + 15% delta-fit (ATM ideal) + 15% grade).
//     85+ ELITE · 75+ STRONG · 65+ ACTION · else WATCH.
//   • the VIEW merges NIFTY+SENSEX and serves the TOP 4 cards by
//     AI score (user spec: "top 4 cards show hone chahiye").
//   • pro metrics per card: POP, breakeven, theta, per-lot cost/
//     risk/reward, expected index move, strike-bias chip, 3-tier
//     exit discipline, Hinglish machine note.
// ------------------------------------------------------------
export function buildOptionSignalCards(desk, deep) {
  if (!desk?.ok || !(desk.spot > 0)) return [];
  const sig = deep?.signal;
  const side = sig?.side;
  if (side !== 'LONG' && side !== 'SHORT') return [];
  const symbol = desk.symbol;
  const type = side === 'LONG' ? 'CE' : 'PE';
  const spot = desk.spot;
  const rows = Array.isArray(desk.rows) ? desk.rows : [];
  if (rows.length === 0) return [];
  const T = yearsToExpiry(`${desk.expiry}T15:30:00+05:30`);
  if (!(T > 0)) return []; // expiry-day post-15:30 — nothing honest to price

  // v21.0.6 [audit]: chain lotSize FIRST (live feed authoritative —
  // exchange revision pakad leta hai), hardcoded LOT_SIZES sirf fallback.
  const lotSize = Number(desk.lotSize) > 0 ? Math.floor(Number(desk.lotSize)) : (LOT_SIZES[symbol] || 1);
  const step = STRIKE_STEPS[symbol] || 50;
  const plan = sig?.plan && Number.isFinite(sig.plan.target1) && Number.isFinite(sig.plan.stopLoss)
    ? sig.plan : null;

  // ---- candidate strikes: ATM + one ITM + one OTM (BUY-side view:
  // CE me spot-upar-wale strikes OTM, PE me neeche-wale OTM).
  const atm = rows.reduce((best, r) => (Math.abs(r.strike - spot) < Math.abs(best.strike - spot) ? r : best), rows[0]);
  const byStrike = (k) => rows.find(r => r.strike === k);
  const cand = [];
  const otmDir = side === 'LONG' ? 1 : -1; // CE: upar OTM · PE: neeche OTM
  // v10.11 (expiry-day fix): candidates whose premium has COLLAPSED below
  // the tradeable floor are DROPPED, not tick-clamped. Minutes before expiry
  // an OTM premium rounds to the ₹0.05 tick and the old code served a
  // degenerate 0.05/0.05/0.05 card (SL == entry == target — meaningless
  // numbers next to a fresh-looking call). Below ~₹1 the bid-ask spread IS
  // the premium; no honest card exists for that strike.
  const MIN_TRADEABLE_PREMIUM = 1.0;
  const pushCand = (row, bias) => {
    if (!row) return;
    const ltp = type === 'CE' ? row.callLTP : row.putLTP;
    if (!(ltp > 0)) return;
    if (ltp < MIN_TRADEABLE_PREMIUM) return; // collapsed premium — skip honestly
    cand.push({ row, bias, strike: row.strike, ltp });
  };
  pushCand(atm, 'ATM');
  pushCand(byStrike(atm.strike - otmDir * step), 'ITM');
  pushCand(byStrike(atm.strike + otmDir * step), 'OTM');
  if (cand.length === 0) return [];

  const grade = sig?.grade || 'NEUTRAL';
  const gradeBonus = grade === 'STRONG' ? 100 : grade === 'ACTION' ? 70 : 40;
  const cards = cand.map(({ row, bias, strike, ltp }) => {
    const ivPct = (type === 'CE' ? row.callIV : row.putIV) || null;
    const g = greeksFor(spot, strike, desk.expiry, ivPct, type);
    const sigma = Math.min(IV_CAP, Math.max(IV_FLOOR, (ivPct ?? 13) / 100));
    const priceAt = (indexLevel) => roundToTick(Math.max(0.05, bsPrice(indexLevel, strike, T, RISK_FREE, sigma, type)));

    const entry = roundToTick(Math.max(0.05, ltp));

    // Target / SL — index-plan geometry translated into premium terms.
    let target = null, stopLoss = null;
    let basisT = 'premium-based', basisS = 'premium-based';
    if (plan && plan.target1 > 0 && (side === 'LONG' ? plan.target1 > spot : plan.target1 < spot)) {
      const t = priceAt(plan.target1);
      if (t > entry * 1.10) { target = t; basisT = 'index-plan→premium'; }
    }
    if (plan && plan.stopLoss > 0 && (side === 'LONG' ? plan.stopLoss < spot : plan.stopLoss > spot)) {
      const s = priceAt(plan.stopLoss);
      if (s < entry) { stopLoss = s; basisS = 'index-plan→premium'; }
    }
    if (target == null) target = roundToTick(entry * 1.30);
    if (stopLoss == null) stopLoss = roundToTick(entry * 0.75);
    if (stopLoss < entry * 0.35) stopLoss = roundToTick(entry * 0.35); // cap max premium loss at 65%
    // v10.11 (expiry-day fix): tick-separation guards — sub-tick geometry
    // can NEVER serve SL >= entry or target <= entry (belt-and-suspenders
    // under the candidate floor above; protects every future path).
    if (!(stopLoss < entry)) stopLoss = roundToTick(Math.max(entry * 0.35, entry - 0.05));
    if (!(target > entry)) target = roundToTick(Math.max(entry * 1.30, entry + 0.05));

    const risk = entry - stopLoss;
    const reward = target - entry;
    const rr = risk > 0 ? r2(reward / risk) : null;

    // POP at expiry — lognormal P(S_T clears strike±debit): the true
    // at-expiry probability for a LONG option (1dp %).
    const kEff = type === 'CE' ? strike + entry : strike - entry;
    let pop = null;
    if (kEff > 0) {
      const d2 = (Math.log(spot / kEff) + (RISK_FREE - 0.5 * sigma * sigma) * T) / (sigma * Math.sqrt(T));
      const p = type === 'CE' ? normCdf(d2) : 1 - normCdf(d2);
      pop = Math.round(Math.max(0, Math.min(1, p)) * 1000) / 10;
    }

    // AI SCORE (transparent blend — methodology ships with the view)
    const conf = Math.max(0, Math.min(100, Number(sig?.confidence ?? 50)));
    const rrScore = rr != null ? Math.max(0, Math.min(1, rr / 2.5)) * 100 : 0;
    const deltaFit = g.delta != null ? Math.max(0, 100 - (Math.abs(Math.abs(g.delta) - 0.5) / 0.5) * 100) : 50;
    // v11.1 NSE+SENSEX addendum — STRUCTURAL discount: a SENSEX model
    // card can NEVER be cross-checked against a live market (BSE blocks
    // datacenter IPs by design), so its score carries an additional
    // haircut BEYOND the model-uncertainty handling. NIFTY's occasional
    // model mode is recoverable and carries no such discount.
    const aiScoreRaw = Math.round(
      0.35 * conf + 0.20 * (pop ?? 40) + 0.15 * rrScore + 0.15 * deltaFit + 0.15 * gradeBonus,
    );
    const structuralDiscount = desk.source === SENSEX_MODEL_SOURCE ? sensexStructuralDiscount() : 0;
    const aiScore = Math.max(0, Math.round(aiScoreRaw - structuralDiscount));
    const tier = aiScore >= 85 ? 'ELITE' : aiScore >= 75 ? 'STRONG' : aiScore >= 65 ? 'ACTION' : 'WATCH';

    const expectedMovePct = plan ? r1(Math.abs((plan.target1 - spot) / spot) * 100) : null;
    const breakeven = r1(type === 'CE' ? strike + entry : strike - entry);
    const name = `${INDEX_DISPLAY_NAMES[symbol] || symbol} ${expiryLabel(desk.expiry) || desk.expiry} ${strike} ${type}`;

    return {
      kind: 'option-signal',
      name,                       // "Nifty50 15Sep 23400 CE" — user's format
      symbol, type, strike,
      direction: side,            // the INDEX consensus driving the card
      expiry: desk.expiry,
      expiryLabel: expiryLabel(desk.expiry),
      dte: daysToExpiry(desk.expiry),
      // the four numbers the user asked for, in his exact framing:
      entry,                      // Entry (Buy) — premium
      target,                     // Target — premium
      stopLoss,                   // Stop Loss — premium
      ltp: r2(ltp),
      delta: g.delta, theta: g.theta,
      iv: ivPct ? r1(ivPct) : null,
      lotSize,
      perLotCost: Math.round(entry * lotSize),
      perLotRisk: Math.round(risk * lotSize),
      perLotReward: Math.round(reward * lotSize),
      rr,
      // ---- v9.6 SUPERINTELLIGENCE pro layer ----
      aiScore, tier,
      ...(structuralDiscount > 0 ? { aiScoreRaw, structuralDiscount } : {}),
      pop,
      breakeven,
      expectedMovePct,
      strikeBias: bias,            // ATM | ITM | OTM
      trendTag: side === 'LONG' ? '▲ BULLISH INDEX CONSENSUS' : '▼ BEARISH INDEX CONSENSUS',
      exitPlan: {
        t1: r1(entry + reward * 0.5), t1Note: 'book 50% · SL → breakeven',
        t2: r1(target), t2Note: 'book 40% · baaki trail',
        hardStop: r1(stopLoss),
        timeExit: '15:10 IST (expiry-day 14:30)',
      },
      consensus: {
        side, confidence: sig?.confidence ?? null,
        grade, agreement: sig?.agreement ?? null,
      },
      // v9.4 discipline kept, now AI-score aware: STRONG/ACTION grade
      // YA 75+ AI score — the same bar the auto-agent fires on.
      tradeable: grade === 'STRONG' || grade === 'ACTION' || aiScore >= 75,
      basis: { target: basisT, stopLoss: basisS },
      indexLevels: plan ? {
        spot: r2(spot),
        target1: r2(plan.target1), stopLoss: r2(plan.stopLoss),
      } : { spot: r2(spot) },
      source: desk.source,        // 'nse' | 'bse' (live premiums) | 'bs-model-*' (honest model)
      note: plan
        ? `Index plan se bana hai: ${symbol} ${r2(plan.target1)} pe premium target, ${r2(plan.stopLoss)} pe stop (BS re-price, IV/dte constant).${structuralDiscount > 0 ? ` SENSEX model-mode: AI score pe −${structuralDiscount} structural discount (no live-market cross-check possible).` : ''}`
        : `Premium-based levels (index plan nahi mila): +30% target / −25% SL discipline.${structuralDiscount > 0 ? ` SENSEX model-mode: AI score pe −${structuralDiscount} structural discount (no live-market cross-check possible).` : ''}`,
      machineNote: `🧠 AI ${aiScore}/100 (${tier}) — ${bias} strike · Δ ${g.delta != null ? g.delta.toFixed(2) : '—'} · POP ${pop != null ? `${pop}%` : '—'} · R:R ${rr != null ? `${rr}R` : '—'}${bias === 'OTM' ? ' · sasta par POP kam' : bias === 'ITM' ? ' · mehenga par POP zyada' : ' · peak liquidity + gamma'}${structuralDiscount > 0 ? ` · ⚠ SENSEX model-only (−${structuralDiscount} structural, ${SENSEX_MODEL_SOURCE})` : ''}.`,
    };
  });

  // ranked by AI score, best first; the view merges indices → TOP 4.
  cards.sort((a, b) => (b.aiScore ?? 0) - (a.aiScore ?? 0));
  return cards.slice(0, 3);
}

// ------------------------------------------------------------
// v9.6 — combined SUPERINTELLIGENCE view for the F&O SIGNAL CARDS
// strip: one request computes NIFTY + SENSEX desks (each + its deep
// consensus), builds the ranked candidates per index, then merges
// and serves the TOP 4 cards by AI score (user spec), 30s cached.
// Deep signals are imported lazily so the module graph stays
// acyclic (signals.js → ensemble.js → here is already an edge for
// OptionsFlow inputs).
// ------------------------------------------------------------
const _cardsCache = new Map();
export async function getOptionSignalsView(deps, symbols = ['NIFTY', 'SENSEX']) {
  const key = symbols.join(',');
  const hit = _cardsCache.get(key);
  if (hit && Date.now() - hit.at < 30_000) return hit.data;
  const { getDeepSignal } = await import('./signals.js');
  const desks = await Promise.all((symbols || []).map(async (sym) => {
    try {
      const s = String(sym || '').toUpperCase();
      const desk = await getOptionsDesk(s);
      if (!desk?.ok) return { symbol: s, ok: false, reason: desk?.reason || 'desk unavailable' };
      // v21.7.0 (Issue-1): liveSpot pass — options-flavor deep signal ka
      // index plan ab LIVE desk spot par anchor hota hai (Yahoo daily
      // close nahi) + 15m ATR geometry (signals.js buildOptionsPlanCtx).
      // Entry/exit cards ka index-level geometry real market se aligned.
      const deep = await getDeepSignal(s, 'INDIA', deps, { optionsCtx: desk.optionsCtx, liveSpot: desk.spot }).catch(() => null);
      const consensus = deep?.ok
        ? { side: deep.signal.side, confidence: deep.signal.confidence, grade: deep.signal.grade }
        : { side: 'FLAT', confidence: 0, grade: 'NEUTRAL' };
      return {
        symbol: s, ok: true, spot: desk.spot, dte: desk.dte,
        expiry: desk.expiry, expiryLabel: expiryLabel(desk.expiry),
        lotSize: desk.lotSize, source: desk.source,
        consensus,
        cards: buildOptionSignalCards(desk, deep),
        noCardReason: (!deep?.ok || deep.signal?.side === 'FLAT')
          ? 'Ensemble index consensus abhi FLAT hai — directional option card nahi banega (neutral desk pe Options Desk ke straddle/condor dekho).'
          : null,
      };
    } catch (e) {
      return { symbol: String(sym || '').toUpperCase(), ok: false, reason: e?.message || 'failed' };
    }
  }));
  // v9.6: merge both desks' ranked cards → global TOP 4 by AI score.
  const all = [];
  for (const d of desks) if (d.ok && Array.isArray(d.cards)) all.push(...d.cards);
  all.sort((a, b) => (b.aiScore ?? 0) - (a.aiScore ?? 0));
  const data = {
    ok: true, asOf: Date.now(),
    topCount: 4,
    cards: all.slice(0, 4),
    methodology: 'AI score = 35% index-consensus + 20% POP-at-expiry + 15% reward:risk + 15% delta-fit (ATM ideal) + 15% grade. Nifty50 + Sensex candidates (ATM/ITM/OTM) merged, TOP 4 served, har 30s re-ranked.',
    desks,
  };
  _cardsCache.set(key, { at: Date.now(), data });
  return data;
}


/**
 * v6.11 — INCOME SETUP RANKER (glama tv-mcp "rank_income_setups"):
 * run the strategy builder on all three NSE indices, keep ONLY the
 * credit-harvest setups (Iron Condor / Iron Fly / Winged Strangle),
 * rank by risk-adjusted expected credit:
 *
 *   score = POP × (credit / spot × 100)
 *
 * i.e. expected credit-capture per rupee of underlying exposure.
 * Honesty: synthetic desks (bs-model) still rank but carry their
 * source tag; a desk that fails to load is skipped, never faked.
 */
export async function rankIncomeSetups() {
  const symbols = ['NIFTY', 'BANKNIFTY', 'FINNIFTY'];
  const INCOME_IDS = new Set(['iron-condor', 'short-straddle', 'short-strangle']);
  const desks = await Promise.all(symbols.map(s => getOptionsDesk(s).catch(() => null)));
  const loaded = desks.filter(d => d?.ok);
  const rows = [];
  for (const desk of loaded) {
    // income ranking wants the NEUTRAL harvest view — call the builder
    // with a flat consensus so directional spreads don't pollute it
    const strategies = buildStrategies(desk, { side: 'FLAT', confidence: 0, grade: 'NEUTRAL', agreement: 0 });
    for (const s of strategies) {
      // NOTE: attachPnlProfile deletes _popKind — income = credit-range ids
      if (!INCOME_IDS.has(s.id)) continue;
      const credit = Number(s.netCredit ?? s.maxProfit);
      const pop = Number(s.pop);
      if (!(credit > 0)) continue;
      const creditPct = r2((credit / desk.spot) * 100);
      const score = (pop != null && Number.isFinite(pop))
        ? Math.round(pop * creditPct * 10) / 10
        : null;
      rows.push({
        symbol: desk.symbol,
        name: s.name,
        id: s.id,
        credit: r2(credit),
        creditPct,
        pop: pop ?? null,
        maxLoss: s.maxLoss,
        riskReward: s.maxLoss > 0 ? r2(credit / s.maxLoss) : null,
        score,
        breakevens: s.breakevens,
        source: desk.source,
        expiry: desk.expiry,
        exitPlan: s.exitPlan,
      });
    }
  }
  rows.sort((a, b) => (b.score ?? -1) - (a.score ?? -1));
  return {
    ok: true,
    asOf: Date.now(),
    count: rows.length,
    desksLoaded: loaded.length,
    top: rows.slice(0, 6),
    methodology: 'score = POP × credit%-of-spot (expected credit capture). Credit-only setups; directional spreads ranked alag se Options Desk me.',
    note: loaded.length === 0
      ? 'koi options desk load nahi hui — thodi der baad retry karo'
      : rows.some(r => r.source && r.source !== 'nse' && r.source !== 'bse')
        ? '⚠️ model-chain desks — premiums estimates hain, live quotes nahi (exchange chain is host se unreachable).'
        : 'sab desks live exchange chain par.',
  };
}

export { STRIKE_STEPS, LOT_SIZES, RISK_FREE };
