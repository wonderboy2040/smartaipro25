// ============================================================
// server/ai/globalRisk.js — v10.15 GAP 4: GLOBAL RISK BRAIN
// ------------------------------------------------------------
// THE GAP (superintelligence upgrade plan): each desk decides in
// isolation. The correlation guard works WITHIN a desk, but nothing
// reasons across both — the system can be simultaneously max-long
// NIFTY IT and max-long crypto majors, which in a global risk-off
// move are effectively ONE correlated bet, not two independent ones.
//
// This module is the single cross-desk portfolio brain:
//   • ONE exposure view: total risk deployed + net directional bias
//     across BOTH desks (crypto journal + India journal positions)
//   • ONE portfolio-level heat cap consulted by BOTH desks' entry
//     gauntlets — combined deployed risk over the ceiling vetoes new
//     entries REGARDLESS of which desk asks
//   • Rolling India↔crypto correlation (reuses correlation.js's
//     60d Pearson matrix — the BTC↔NIFTY link: both are risk assets,
//     their correlation spikes precisely in the drawdowns that matter)
//   • Risk-off detection: VIX spike + BTC breakdown TOGETHER (the two
//     legs of a global de-risking) → both desks' NEW-entry sizing is
//     down-weighted at once, instead of each desk discovering it late
//
// Honesty: positions without a readable SL are counted as `unpriced`
// (never a fabricated risk number); VIX/BTC data unreachable →
// riskOff false + `dataOk: false` (missing data is not a signal).
// Cached 5 min — the gauntlet reads it every tick for free.
// ============================================================
import { loadJournal } from './coindcxOrders.js';
import { fetchUsdInr } from './futures.js';

const CACHE_TTL_MS = 5 * 60 * 1000;
const _num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };

/** Portfolio heat cap: combined deployed risk as % of total desk
 *  capital. Env-tunable; 6% default (≈ 4 full-risk trades at 1.5%). */
export function globalHeatCapPct() {
  const n = Number(process.env.AI_GLOBAL_HEAT_CAP_PCT);
  return Number.isFinite(n) && n > 0 && n <= 100 ? n : 6;
}
/** Risk-off sizing multiplier for new entries on BOTH desks.
 *  Clamped to (0,1] — the env can only ever DE-RISK, never boost. */
export function riskOffMultiplier() {
  const n = Number(process.env.AI_RISKOFF_MUL);
  if (!Number.isFinite(n) || n <= 0) return 0.5;
  return Math.min(1, n);
}
/** The whole brain's kill switch. */
export function globalRiskEnabled() {
  return !['true', '1', 'on', 'yes'].includes(String(process.env.AI_DISABLE_GLOBAL_RISK || '').trim().toLowerCase());
}

// ---------------- the exposure view (journal is truth) ----------------
/**
 * Per-desk + combined risk-deployed view from the ONE journal both
 * desks write. PURE given (journal, usdInr).
 * Risk per position = |entry − SL| × qty in INR (the actual amount
 * that bleeds if the stop is hit); positions without a readable SL
 * are counted in `unpriced` — never invented.
 */
export function deskExposure(journal, usdInr = 84) {
  const fx = usdInr > 0 ? usdInr : 84;
  const open = (journal?.positions || []).filter(p => p && (p.status === 'OPEN' || p.status === 'UNKNOWN'));
  const desks = { crypto: { open: 0, riskINR: 0, unpriced: 0, long: 0, short: 0 }, india: { open: 0, riskINR: 0, unpriced: 0, long: 0, short: 0 } };
  for (const p of open) {
    // India positions always carry market:'INDIA' (indiaOrders contract);
    // crypto rows carry CRYPTO/FUTURES/GLOBALFUTURES or legacy undefined
    const desk = String(p.market || '').toUpperCase() === 'INDIA' ? desks.india : desks.crypto;
    desk.open += 1;
    const long = /^(L|B)/i.test(String(p.side || ''));
    if (long) desk.long += 1; else desk.short += 1;
    const entry = _num(p.entryPrice);
    const sl = _num(p.sl);
    const qty = _num(p.qty);
    if (entry > 0 && sl > 0 && qty > 0) {
      // currency domain: FUTURES/GLOBALFUTURES price in USDT/USDC → INR;
      // CRYPTO spot + INDIA already price in INR
      const usdTsd = p.market === 'FUTURES' || p.market === 'GLOBALFUTURES' || /^B-/.test(String(p.pair || '')) || /-USD$/.test(String(p.pair || ''));
      const perUnit = Math.abs(entry - sl) * (usdTsd ? fx : 1);
      desk.riskINR += perUnit * qty;
    } else {
      desk.unpriced += 1;
    }
  }
  const total = {
    open: desks.crypto.open + desks.india.open,
    riskINR: Math.round((desks.crypto.riskINR + desks.india.riskINR) * 100) / 100,
    unpriced: desks.crypto.unpriced + desks.india.unpriced,
    netDirBias: (desks.crypto.long + desks.india.long) - (desks.crypto.short + desks.india.short),
  };
  return { desks, total };
}

// ---------------- the market read (VIX + BTC + correlation) ----------------
/** Risk-off = VIX spike AND BTC breakdown together. PURE over inputs. */
export function riskOffOf({ vix, vix5dAgo, btcCloses }) {
  const dataOk = _num(vix) > 0 && Array.isArray(btcCloses) && btcCloses.length >= 21;
  if (!dataOk) return { riskOff: false, dataOk: false, vixSpike: false, btcBreakdown: false };
  const vixSpike = vix >= 25 && _num(vix5dAgo) > 0 && (vix / vix5dAgo - 1) >= 0.15;
  // BTC below its 20-day average by >1.5% = breakdown
  const last = btcCloses[btcCloses.length - 1];
  const sma20 = btcCloses.slice(-20).reduce((s, c) => s + c, 0) / 20;
  const btcBreakdown = last > 0 && sma20 > 0 && last < sma20 * 0.985;
  return { riskOff: vixSpike && btcBreakdown, dataOk: true, vixSpike, btcBreakdown };
}

// ---------------- the combined view (cached) ----------------
let _cache = { at: 0, view: null };
let _fetchImpl = null; // test injection for the VIX/BTC legs
let _matrixImpl = null; // test injection for the correlation matrix

export function _setGlobalRiskFetchForTest(fn) { _fetchImpl = fn; }
export function _setGlobalRiskMatrixForTest(fn) { _matrixImpl = fn; }
export function _resetGlobalRiskForTest() { _cache = { at: 0, view: null }; _fetchImpl = null; _matrixImpl = null; }

async function _marketRead() {
  const f = _fetchImpl || globalThis.fetch;
  // VIX + BTC daily closes in ONE pass (Yahoo chart API, 1mo daily).
  // v10.18 (deep-recheck #3): 8s deadlines — the gauntlet awaits this
  // read on entry ticks; a black-holed Yahoo route used to stall the
  // whole entry path (undici's default headers timeout is minutes).
  const opts = { signal: AbortSignal.timeout(8000) };
  const [vix, btc] = await Promise.all([
    f('https://query1.finance.yahoo.com/v8/finance/chart/%5EVIX?range=1mo&interval=1d', opts)
      .then(r => r.json()).catch(() => null),
    f('https://query1.finance.yahoo.com/v8/finance/chart/BTC-USD?range=1mo&interval=1d', opts)
      .then(r => r.json()).catch(() => null),
  ]);
  const closesOf = (j) => {
    try {
      const s = j?.chart?.result?.[0]?.indicators?.quote?.[0]?.close;
      return Array.isArray(s) ? s.filter(c => Number.isFinite(c) && c > 0) : [];
    } catch { return []; }
  };
  const vixCloses = closesOf(vix);
  const btcCloses = closesOf(btc);
  return {
    vix: vixCloses.length ? vixCloses[vixCloses.length - 1] : null,
    vix5dAgo: vixCloses.length >= 6 ? vixCloses[vixCloses.length - 6] : null,
    btcCloses,
  };
}

/**
 * The one payload both desks' gauntlets + the panels read. Cached 5 min.
 * @param {{ cryptoEquityINR:number, indiaCapitalINR:number, usdInr?:number }} cap
 */
export async function globalRiskView({ cryptoEquityINR = 10_000, indiaCapitalINR = 10_000, usdInr = null, force = false } = {}) {
  const now = Date.now();
  if (!force && _cache.view && (now - _cache.at) < CACHE_TTL_MS) {
    // refresh the capital-relative parts against the fresh capitals
    const v = _cache.view;
    return _withCaps(v, cryptoEquityINR, indiaCapitalINR);
  }
  const j = loadJournal();
  const fx = (usdInr ?? (await fetchUsdInr().catch(() => null))) || 84;
  const exposure = deskExposure(j, fx);
  const market = await _marketRead().catch(() => ({ vix: null, vix5dAgo: null, btcCloses: [] }));
  const riskOff = riskOffOf(market);
  // India↔crypto link: the correlation matrix's BTC↔NIFTY read (cached
  // 15 min inside correlation.js; unreachable data → null, never fake 0)
  let btcNifty = null;
  try {
    const matrixFn = _matrixImpl || (await import('./correlation.js')).correlationMatrix;
    const m = await matrixFn().catch(() => null);
    btcNifty = m?.riskLink?.r ?? null;
  } catch { btcNifty = null; }

  const view = { exposure, riskOff, btcNifty, asOf: now };
  _cache = { at: now, view };
  return _withCaps(view, cryptoEquityINR, indiaCapitalINR);
}

function _withCaps(view, cryptoEquityINR, indiaCapitalINR) {
  const capINR = (cryptoEquityINR > 0 ? cryptoEquityINR : 10_000) + (indiaCapitalINR > 0 ? indiaCapitalINR : 10_000);
  const heatPct = Math.round((view.exposure.total.riskINR / capINR) * 1000) / 10;
  const capPct = globalHeatCapPct();
  return {
    ok: true,
    enabled: globalRiskEnabled(),
    ...view,
    capINR: Math.round(capINR),
    heatPct,
    heatCapPct: capPct,
    overHeat: view.exposure.total.riskINR > capINR * (capPct / 100),
    veto: globalRiskEnabled() && view.exposure.total.riskINR > capINR * (capPct / 100),
    vetoReason: view.exposure.total.riskINR > capINR * (capPct / 100)
      ? `global heat ${heatPct}% > cap ${capPct}% (₹${Math.round(view.exposure.total.riskINR).toLocaleString('en-IN')} risk deployed across BOTH desks vs ₹${Math.round(capINR).toLocaleString('en-IN')} capital)`
      : null,
    riskOffMul: riskOffMultiplier(),
    note: 'Cross-desk portfolio brain: combined deployed risk + net bias + BTC↔NIFTY link + VIX/BTC risk-off. Unpriced positions counted, never invented.',
  };
}

/**
 * The gate BOTH entry gauntlets consult (same call, one truth).
 * @returns {{veto:boolean, reason:string|null, sizeMul:number, riskOff:boolean}}
 */
export async function globalRiskGate({ cryptoEquityINR, indiaCapitalINR, usdInr } = {}) {
  const v = await globalRiskView({ cryptoEquityINR, indiaCapitalINR, usdInr });
  return {
    veto: !!v.veto,
    reason: v.vetoReason,
    sizeMul: v.riskOff?.riskOff ? v.riskOffMul : 1,
    riskOff: !!v.riskOff?.riskOff,
    heatPct: v.heatPct,
    heatCapPct: v.heatCapPct,
  };
}

// ---------------- test hook ----------------
export function __globalRiskCacheForTest() { return _cache; }
