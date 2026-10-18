// ============================================================
// server/ai/riskAnalytics.js — A4 PORTFOLIO RISK ANALYTICS
// ------------------------------------------------------------
// v13.2 (accuracy plan A4). The client riskEngine.ts computes an
// honest VaR/CVaR/drawdown from CURRENT positions, but two numbers
// were placeholders and one was missing entirely:
//   • sortinoRatio = sharpe × 1.3 (fake — no downside deviation)
//   • correlationMatrix: [] (never computed)
//   • rebalance suggestions: strings, not a drift engine
//
// This module computes the REAL thing server-side, where the daily
// candle history lives:
//   • per-holding + portfolio Sharpe (rf-aware) and Sortino
//     (downside deviation, REAL — not a multiple of Sharpe)
//   • correlation matrix across holdings (Pearson on aligned daily
//     returns, trailing-aligned)
//   • vol-parity + equal-weight rebalance drift engine with concrete
//     "move X% from A to B" suggestions
//
// Data: 90d daily closes — Yahoo ({SYM}.NS / US / BTC-USD style) for
// equities+ETFs, Binance 1d klines for crypto. Anything without a
// price series (fixed deposits, EPF, bonds without a symbol) is
// EXCLUDED from return math and listed honestly as skipped.
//
// Cache: whole-analytics snapshot keyed by the asset signature,
// 1h TTL (the plan's "daily refresh" would hide intraday syncs; 1h
// keeps it fresh without hammering Yahoo — candles barely move).
// NEVER THROWS.
// ============================================================
import { fetchYahooDailyCloses } from './data.js';
import { fetchBinanceKlines } from './data.js';

const CACHE_TTL_MS = 60 * 60 * 1000; // 1h
const LOOKBACK_DAYS = 90;
const _cache = new Map(); // signature → { at, payload }

const r2 = (v) => (Number.isFinite(v) ? Math.round(v * 100) / 100 : null);
const r4 = (v) => (Number.isFinite(v) ? Math.round(v * 10000) / 10000 : null);

// ---------------- pure math (exported for tests) ----------------

export function dailyReturns(closes) {
  const out = [];
  for (let i = 1; i < closes.length; i++) {
    if (closes[i - 1] > 0 && Number.isFinite(closes[i])) {
      out.push((closes[i] - closes[i - 1]) / closes[i - 1]);
    }
  }
  return out;
}

export function mean(xs) { return xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0; }

export function stdev(xs, m = null) {
  if (xs.length < 2) return 0;
  const mu = m == null ? mean(xs) : m;
  return Math.sqrt(xs.reduce((s, x) => s + (x - mu) ** 2, 0) / (xs.length - 1));
}

export function downsideDev(xs, mar = 0) {
  // Target downside deviation: sqrt( E[ min(r−MAR, 0)² ] ) — the
  // expectation is over ALL n observations (non-downside days
  // contribute 0), NOT over the downside-count only (that would
  // overstate it — the classic Sortino footgun).
  if (xs.length === 0) return 0;
  let acc = 0;
  for (const x of xs) {
    const d = x - mar;
    if (d < 0) acc += d * d;
  }
  return Math.sqrt(acc / xs.length);
}

const TRADING_DAYS = 252;

/** Real per-series risk block. rf is ANNUAL (e.g. 0.065). */
export function seriesStats(rets, rfAnnual) {
  if (rets.length < 10) return null; // not enough history — honest skip
  const mu = mean(rets);
  const sd = stdev(rets, mu);
  const dd = downsideDev(rets, 0);
  const annMu = mu * TRADING_DAYS;
  const annSd = sd * Math.sqrt(TRADING_DAYS);
  const annDd = dd * Math.sqrt(TRADING_DAYS);
  const _rfDaily = rfAnnual / TRADING_DAYS;
  const sharpe = annSd > 0 ? (annMu - rfAnnual) / annSd : null;
  const sortino = annDd > 0 ? (annMu - rfAnnual) / annDd : null;
  // max drawdown on the cumulative return path
  let cum = 1, peak = 1, maxDD = 0;
  for (const r of rets) {
    cum *= (1 + r);
    if (cum > peak) peak = cum;
    const ddPct = (peak - cum) / peak;
    if (ddPct > maxDD) maxDD = ddPct;
  }
  return {
    annReturnPct: r2(annMu * 100),
    annVolPct: r2(annSd * 100),
    sharpe: r2(sharpe),
    sortino: r2(sortino),
    maxDrawdownPct: r2(maxDD * 100),
    downsideDevPct: r2(annDd * 100),
    points: rets.length,
  };
}

export function pearson(a, b) {
  const n = Math.min(a.length, b.length);
  if (n < 10) return null;
  const x = a.slice(-n), y = b.slice(-n);
  const mx = mean(x), my = mean(y);
  let num = 0, dx = 0, dy = 0;
  for (let i = 0; i < n; i++) {
    num += (x[i] - mx) * (y[i] - my);
    dx += (x[i] - mx) ** 2;
    dy += (y[i] - my) ** 2;
  }
  const den = Math.sqrt(dx * dy);
  return den > 0 ? r4(num / den) : null;
}

/** Rebalance drift: current weights vs vol-parity (and equal-weight)
 *  targets. Returns concrete suggestions, sorted by drift. */
export function rebalanceSuggestions(holdings, { maxSuggestions = 4, driftThresholdPct = 3 } = {}) {
  // holdings: [{ label, weight (0-1), annVolPct }] — vol must exist
  const live = holdings.filter(h => h.annVolPct != null && h.annVolPct > 0 && h.weight > 0);
  if (live.length < 2) return [];
  const invVol = live.map(h => 1 / h.annVolPct);
  const invSum = invVol.reduce((s, v) => s + v, 0);
  const eq = 1 / live.length;
  const rows = live.map((h, i) => {
    const volTarget = invVol[i] / invSum;
    const eqTarget = eq;
    // blend: vol-parity is the primary target, equal-weight the sanity floor
    const target = Math.max(volTarget * 0.7 + eqTarget * 0.3, 0.02);
    return {
      label: h.label,
      currentPct: r2(h.weight * 100),
      volParityPct: r2(volTarget * 100),
      equalWeightPct: r2(eqTarget * 100),
      targetPct: r2(target * 100),
      driftPct: r2((h.weight - target) * 100),
    };
  });
  // normalise targets to sum 100 (blending can drift a little)
  const tSum = rows.reduce((s, r) => s + r.targetPct, 0) || 100;
  for (const r of rows) r.targetPct = r2((r.targetPct / tSum) * 100);
  for (const r of rows) r.driftPct = r2(r.currentPct - r.targetPct);
  const over = rows.filter(r => r.driftPct > driftThresholdPct).sort((a, b) => b.driftPct - a.driftPct);
  const under = rows.filter(r => r.driftPct < -driftThresholdPct).sort((a, b) => a.driftPct - b.driftPct);
  const out = [];
  for (let i = 0; i < Math.min(maxSuggestions, Math.max(over.length, under.length)); i++) {
    const o = over[i], u = under[i];
    if (o && u) out.push(`Trim ${o.label} ${Math.abs(o.driftPct)}% (${o.currentPct}%→${o.targetPct}% target) → add to ${u.label} (+${Math.abs(u.driftPct)}%)`);
    else if (o) out.push(`Trim ${o.label} ${Math.abs(o.driftPct)}% (target ${o.targetPct}%) — cash/debt side le jao`);
    else if (u) out.push(`Add to ${u.label} +${Math.abs(u.driftPct)}% (abhi ${u.currentPct}%, target ${u.targetPct}%)`);
  }
  return { rows: rows.sort((a, b) => b.currentPct - a.currentPct), suggestions: out };
}

// ---------------- series resolution ----------------

function yahooSymbolFor(asset) {
  const sym = String(asset.symbol || '').trim().toUpperCase();
  if (!sym) return null;
  if ((asset.market || '').toUpperCase() === 'IN') return `${sym.replace(/\.NS$/, '')}.NS`;
  return sym; // US tickers plain on Yahoo
}

async function seriesFor(asset, { yahoo, binance } = {}) {
  const kind = String(asset.kind || '').toLowerCase();
  const fetchY = yahoo || fetchYahooDailyCloses;
  const fetchB = binance || fetchBinanceKlines;
  try {
    if (kind === 'crypto') {
      const base = String(asset.symbol || asset.name || '').toUpperCase().split(/[^A-Z0-9]/)[0];
      if (!base) return [];
      const kl = await fetchB(base, '1d');
      if (Array.isArray(kl) && kl.length) {
        const closes = kl.map(k => Number(k?.close ?? k?.[4])).filter(v => Number.isFinite(v) && v > 0);
        if (closes.length >= 10) return closes.slice(-LOOKBACK_DAYS);
      }
      // Yahoo fallback (BTC-USD style)
      return (await fetchY(`${base}-USD`, '3mo')).slice(-LOOKBACK_DAYS);
    }
    const ysym = yahooSymbolFor(asset);
    if (!ysym) return [];
    if (['stock', 'etf', 'mf', 'gold'].includes(kind)) {
      return (await fetchY(ysym, '3mo')).slice(-LOOKBACK_DAYS);
    }
    return []; // fixed/bond/retirement/other — no honest daily series
  } catch { return []; }
}

function _signature(assets) {
  return assets.map(a => `${a.key || a.id}:${a.kind}:${a.symbol}:${a.value ?? 0}`).join('|');
}

/**
 * THE analytics endpoint payload. assets = portfolioSync wire rows.
 * Fetchers injectable for tests. NEVER THROWS.
 */
export async function computePortfolioRiskAnalytics(assets, { rfAnnualPct, fetchers = {}, now = Date.now() } = {}) {
  try {
    const rf = Number.isFinite(Number(rfAnnualPct)) && Number(rfAnnualPct) > 0 && Number(rfAnnualPct) < 30
      ? Number(rfAnnualPct) / 100 : 0.065;
    const list = Array.isArray(assets) ? assets.filter(a => a && (a.value ?? 0) > 0) : [];
    if (list.length === 0) return { ok: false, reason: 'no-assets' };

    const sig = _signature(list);
    const hit = _cache.get(sig);
    if (hit && now - hit.at < CACHE_TTL_MS) return { ok: true, cached: true, ...hit.payload };

    // resolve series (bounded concurrency: 6 at a time)
    const series = new Array(list.length).fill([]);
    for (let i = 0; i < list.length; i += 6) {
      const chunk = list.slice(i, i + 6);
      const res = await Promise.all(chunk.map(a => seriesFor(a, fetchers)));
      for (let j = 0; j < res.length; j++) series[i + j] = res[j];
    }

    const totalValue = list.reduce((s, a) => s + (a.value ?? 0), 0);
    const holdingRows = [];
    const included = [];
    const skipped = [];
    for (let i = 0; i < list.length; i++) {
      const a = list[i];
      const rets = dailyReturns(series[i] || []);
      const st = seriesStats(rets, rf);
      const weight = totalValue > 0 ? (a.value ?? 0) / totalValue : 0;
      if (st) {
        included.push({ i, rets, weight });
        holdingRows.push({
          label: a.symbol || a.name, kind: a.kind, market: a.market,
          valueINR: r2(a.value ?? 0), weightPct: r2(weight * 100),
          ...st,
        });
      } else {
        skipped.push({ label: a.symbol || a.name, kind: a.kind, reason: series[i] && series[i].length ? 'short history' : 'no daily series (fixed/EPF/bond ya symbol resolve fail)' });
      }
    }

    // ---- portfolio-level: value-weighted aligned returns ----
    let portfolio = null;
    let corr = { symbols: [], matrix: [] };
    if (included.length > 0) {
      // trailing-align every included series to the shortest (common tail)
      const minLen = Math.min(...included.map(x => x.rets.length));
      if (minLen >= 10) {
        const aligned = included.map(x => x.rets.slice(-minLen));
        const wSum = included.reduce((s, x) => s + x.weight, 0) || 1;
        const portRets = [];
        for (let t = 0; t < minLen; t++) {
          let r = 0;
          for (let k = 0; k < included.length; k++) r += (included[k].weight / wSum) * aligned[k][t];
          portRets.push(r);
        }
        portfolio = { ...seriesStats(portRets, rf), holdingsCount: included.length, alignedPoints: minLen };

        // correlation matrix on the SAME aligned returns
        if (included.length >= 2) {
          const symbols = included.map(x => list[x.i].symbol || list[x.i].name);
          const matrix = aligned.map((ai, x) => aligned.map((bi, y) => (x === y ? 1 : pearson(ai, bi))));
          corr = { symbols, matrix };
        }
      }
    }

    // ---- rebalance drift ----
    const reb = rebalanceSuggestions(holdingRows.map(h => ({ label: h.label, weight: (h.weightPct ?? 0) / 100, annVolPct: h.annVolPct })));

    const payload = {
      rfAnnualPct: r2(rf * 100),
      lookbackDays: LOOKBACK_DAYS,
      generatedAt: new Date(now).toISOString(),
      holdings: holdingRows,
      skipped,
      portfolio,
      correlation: corr,
      rebalance: reb.rows ? reb : { rows: [], suggestions: [] },
    };
    _cache.set(sig, { at: now, payload });
    if (_cache.size > 8) {
      const oldest = _cache.keys().next().value;
      if (oldest !== undefined) _cache.delete(oldest);
    }
    return { ok: true, ...payload };
  } catch (e) {
    return { ok: false, reason: String(e?.message || e).slice(0, 160) };
  }
}

export function __resetRiskAnalyticsForTests() { _cache.clear(); }

export const __testables = { _signature, seriesFor, yahooSymbolFor };
