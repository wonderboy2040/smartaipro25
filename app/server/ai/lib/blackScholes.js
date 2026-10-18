// ============================================================
// server/ai/lib/blackScholes.js — option pricing + Greeks + IV
// ------------------------------------------------------------
// Pure Black-Scholes-Merton implementation for the India OPTIONS
// desk. Used two ways:
//   1. PRICE synthetically when NSE's live option-chain is blocked
//      (datacenter IP / Cloudflare) — spot + IV (India VIX or a
//      sensible floor) → honest model premiums, clearly labeled.
//   2. SOLVE for implied volatility from REAL NSE premiums when the
//      chain IS reachable (Newton-Raphson with bisection fallback).
//
// T (time to expiry) is in YEARS; r is risk-free (decimal);
// sigma is annualized vol (decimal). European-style assumption —
// fine for liquid NIFTY/BANKNIFTY weeklies where early exercise
// on calls is negligible (no dividends on the indices).
// ============================================================

const SQRT_2PI = Math.sqrt(2 * Math.PI);

// Standard normal CDF — Abramowitz & Stegun 7.1.26 via erf.
function normCdf(x) {
  // Zelen & Severo approximation, |error| < 7.5e-8.
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989422804014327 * Math.exp(-x * x / 2);
  let p = d * t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  if (x >= 0) p = 1 - p;
  return p;
}

// Standard normal PDF.
function normPdf(x) {
  return Math.exp(-x * x / 2) / SQRT_2PI;
}

/**
 * Black-Scholes price.
 * @param {number} S    spot
 * @param {number} K    strike
 * @param {number} T    years to expiry (>= 0)
 * @param {number} r    risk-free rate (decimal, e.g. 0.07)
 * @param {number} sigma annualized vol (decimal, e.g. 0.13)
 * @param {'CE'|'PE'} type call ('CE') or put ('PE')
 */
export function bsPrice(S, K, T, r, sigma, type) {
  if (!(S > 0) || !(K > 0) || !(sigma > 0)) return 0;
  if (!(T > 0)) return type === 'CE' ? Math.max(0, S - K) : Math.max(0, K - S);
  const sqT = Math.sqrt(T);
  const d1 = (Math.log(S / K) + (r + sigma * sigma / 2) * T) / (sigma * sqT);
  const d2 = d1 - sigma * sqT;
  const disc = Math.exp(-r * T);
  if (type === 'CE') return S * normCdf(d1) - K * disc * normCdf(d2);
  return K * disc * normCdf(-d2) - S * normCdf(-d1);
}

/**
 * Full Greeks for one option. theta is per-day (natural for traders).
 */
export function bsGreeks(S, K, T, r, sigma, type) {
  if (!(S > 0) || !(K > 0) || !(sigma > 0) || !(T > 0)) {
    return { delta: 0, gamma: 0, theta: 0, vega: 0, rho: 0 };
  }
  const sqT = Math.sqrt(T);
  const d1 = (Math.log(S / K) + (r + sigma * sigma / 2) * T) / (sigma * sqT);
  const d2 = d1 - sigma * sqT;
  const disc = Math.exp(-r * T);
  const pdf = normPdf(d1);
  const delta = type === 'CE' ? normCdf(d1) : normCdf(d1) - 1;
  const gamma = pdf / (S * sigma * sqT);
  // Vega per 1 vol point (1%) — the unit option chains quote.
  const vega = (S * pdf * sqT) / 100;
  const thetaYear = type === 'CE'
    ? -(S * pdf * sigma) / (2 * sqT) - r * K * disc * normCdf(d2)
    : -(S * pdf * sigma) / (2 * sqT) + r * K * disc * normCdf(-d2);
  const theta = thetaYear / 365; // per calendar day
  const rho = type === 'CE'
    ? (K * T * disc * normCdf(d2)) / 100
    : (-K * T * disc * normCdf(-d2)) / 100;
  return { delta, gamma, vega, theta, rho };
}

/**
 * Implied volatility via Newton-Raphson, bisection fallback.
 * Returns decimal (e.g. 0.1375 = 13.75%) or null when unsolvable.
 */
export function impliedVol(price, S, K, T, r, type) {
  if (!(price > 0) || !(S > 0) || !(K > 0) || !(T > 0)) return null;
  const intrinsic = type === 'CE' ? Math.max(0, S - K) : Math.max(0, K - S);
  if (price <= intrinsic + 1e-9) return null; // no time value → no IV

  // Newton-Raphson from a 20% guess.
  let sigma = 0.20;
  for (let i = 0; i < 60; i++) {
    const p = bsPrice(S, K, T, r, sigma, type);
    const diff = price - p;
    if (Math.abs(diff) < 1e-6) return sigma;
    const sqT = Math.sqrt(T);
    const d1 = (Math.log(S / K) + (r + sigma * sigma / 2) * T) / (sigma * sqT);
    const vega = S * normPdf(d1) * sqT;
    if (vega < 1e-10) break;
    const next = sigma + diff / vega;
    if (!(next > 0) || !Number.isFinite(next)) break;
    sigma = Math.min(5, Math.max(0.005, next)); // clamp 0.5%..500%
  }

  // Bisection fallback (NR diverged on deep wings).
  let lo = 0.005, hi = 5;
  for (let i = 0; i < 100; i++) {
    const mid = (lo + hi) / 2;
    const p = bsPrice(S, K, T, r, mid, type);
    if (Math.abs(p - price) < 1e-6) return mid;
    if (p < price) lo = mid; else hi = mid;
  }
  const pl = bsPrice(S, K, T, r, lo, type), ph = bsPrice(S, K, T, r, hi, type);
  if (price >= pl - 1e-6 && price <= ph + 1e-6) return (lo + hi) / 2;
  return null;
}

/** Trading-days-ish time to expiry for NSE weekly options (expiry 15:30 IST). */
export function yearsToExpiry(expiryISO, now = new Date()) {
  const exp = new Date(expiryISO);
  if (isNaN(exp.getTime())) return 0;
  const ms = exp.getTime() - now.getTime();
  if (ms <= 0) return 0;
  return ms / (365 * 24 * 60 * 60 * 1000);
}

/** Next weekly expiry for an NSE index option (Tuesday for NIFTY post-2025, Thursday legacy fallback). */
export function nextWeeklyExpiry(now = new Date(), weekday = 2) {
  // IST clock.
  const ist = new Date(now.getTime() + (330 + now.getTimezoneOffset()) * 60000);
  const d = new Date(ist);
  d.setHours(15, 30, 0, 0);
  let days = (weekday - d.getDay() + 7) % 7;
  if (days === 0 && ist.getHours() * 60 + ist.getMinutes() >= 15 * 60 + 30) days = 7;
  d.setDate(d.getDate() + days);
  // Saturday/Sunday → roll back to Friday close (market holiday proxy).
  if (d.getDay() === 6) d.setDate(d.getDate() - 1);
  if (d.getDay() === 0) d.setDate(d.getDate() - 2);
  return d.toISOString().slice(0, 10);
}

export { normCdf };
