// ============================================================
// server/ai/fundamentals.js — V2 MODEL #14: FundaCheck
// ------------------------------------------------------------
// Ensemble 11 → 14 upgrade, Phase 3 (India swing ONLY).
//
//   • P/E vs sector-average P/E — value tilt within the sector
//   • earnings-growth surprise proxy (quarterly YoY growth from
//     financialData.earningsGrowth — honestly labelled a proxy;
//     estimate-vs-actual surprise needs a paid feed)
//
// Data path (free, no key): Yahoo quoteSummary via the same
// cookie+crumb dance the public quote endpoints use — the SAME
// query1.finance.yahoo.com host the app already leans on for
// quotes/candles (no third-party site scraping). Sector peer set
// comes from sectors.js SECTOR_MAP (extended, not duplicated).
// Weekly cache — fundamentals don't move intraday.
//
// SCOPE GUARD (the plan's rule): fundamentals matter for
// swing/positional, NOT intraday. This model only votes when
// ctx.fundamentals was deliberately ATTACHED (deep-signal /
// swing paths do that). The intraday board never attaches it —
// the 15m tape must never be swung by a P/E ratio.
//
// Weight in MODELS[]: 0.5 — the lowest of all models, by design.
// ============================================================

import { SECTOR_MAP } from './sectors.js';

const clamp = (v, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, v));
const r1 = (v) => (Number.isFinite(v) ? Math.round(v * 10) / 10 : null);

function vote(dir, conf, reasons, na = false) {
  return { dir, conf: Math.round(clamp(conf)), reasons: reasons.filter(Boolean), ...(na ? { na: true } : {}) };
}

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36';
const TTL = 7 * 24 * 3600 * 1000;       // weekly — fundamentals are slow
const WARM_TIMEOUT = 6000;               // per-symbol deep-path budget

// cookie+crumb for Yahoo quoteSummary (45-min validity, re-danced on 401)
let _cookies = null, _crumb = null, _crumbAt = 0;
let _crumbInflight = null;

const _data = new Map();      // SYMBOL → {at, pe, forwardPe, sector, earnGrowth, revGrowth, err}
const _inflight = new Map();  // SYMBOL → promise
let _universeWarm = null;     // single-flight for the weekly universe warm

// ---------------- Yahoo cookie + crumb dance ----------------
async function ensureCrumb(force = false) {
  if (!force && _crumb && Date.now() - _crumbAt < 45 * 60_000) return { cookies: _cookies, crumb: _crumb };
  if (_crumbInflight && !force) return _crumbInflight;
  _crumbInflight = (async () => {
    try {
      const c = await fetch('https://fc.yahoo.com', { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(8000) });
      const cookies = (c.headers.getSetCookie?.() || []).map(x => x.split(';')[0]).join('; ');
      if (!cookies) throw new Error('no yahoo cookies');
      const cr = await fetch('https://query1.finance.yahoo.com/v1/test/getcrumb', {
        headers: { 'User-Agent': UA, Cookie: cookies }, signal: AbortSignal.timeout(8000),
      });
      if (!cr.ok) throw new Error(`getcrumb HTTP ${cr.status}`);
      const crumb = (await cr.text()).trim();
      if (!crumb || crumb.length > 40) throw new Error('bad crumb');
      _cookies = cookies; _crumb = crumb; _crumbAt = Date.now();
      return { cookies, crumb };
    } finally { _crumbInflight = null; }
  })();
  return _crumbInflight;
}

async function yahooQuoteSummary(symbol) {
  const yh = `${encodeURIComponent(symbol)}.NS`;
  const modules = 'defaultKeyStatistics,financialData,summaryDetail,assetProfile';
  let { cookies, crumb } = await ensureCrumb();
  for (const host of ['query1', 'query2']) {
    for (const _attempt of [0, 1]) {
      try {
        const url = `https://${host}.finance.yahoo.com/v10/finance/quoteSummary/${yh}?modules=${modules}&crumb=${encodeURIComponent(crumb)}`;
        const r = await fetch(url, { headers: { 'User-Agent': UA, Cookie: cookies }, signal: AbortSignal.timeout(9000) });
        if (r.status === 401 || r.status === 403) {
          // crumb expired mid-flight — re-dance once and retry
          ({ cookies, crumb } = await ensureCrumb(true));
          continue;
        }
        if (!r.ok) continue;
        const j = await r.json();
        const res = j?.quoteSummary?.result?.[0];
        if (!res) continue;
        const num = (x) => { const n = Number(x?.raw); return Number.isFinite(n) ? n : null; };
        return {
          pe: num(res?.summaryDetail?.trailingPE) ?? num(res?.defaultKeyStatistics?.trailingPE),
          forwardPe: num(res?.summaryDetail?.forwardPE),
          sector: res?.assetProfile?.sector ? String(res.assetProfile.sector) : null,
          earnGrowth: num(res?.financialData?.earningsGrowth),
          revGrowth: num(res?.financialData?.revenueGrowth),
        };
      } catch { /* next host/attempt */ }
    }
  }
  return null;
}

// ---------------- per-symbol cache ----------------
// v10.18 (deep-recheck #3): the symbol key space is user-controlled
// (deep-analysis of arbitrary tickers) — bounded now, like every
// other repo cache. Successful entries win eviction over error rows.
const DATA_CAP = 300;
function _capData() {
  if (_data.size <= DATA_CAP) return;
  const entries = [..._data.entries()].sort((a, b) =>
    (a[1].err ? 0 : 1) - (b[1].err ? 0 : 1) || a[1].at - b[1].at);
  for (const [k] of entries.slice(0, _data.size - DATA_CAP)) _data.delete(k);
}

function dataGet(symbol) {
  const d = _data.get(symbol);
  return d && Date.now() - d.at < TTL ? d : null;
}

async function refreshOne(symbol) {
  const hit = dataGet(symbol);
  if (hit) return hit;
  if (_inflight.has(symbol)) return _inflight.get(symbol);
  const p = (async () => {
    try {
      const fresh = await yahooQuoteSummary(symbol);
      if (fresh && (fresh.pe != null || fresh.earnGrowth != null)) {
        const entry = { at: Date.now(), symbol, ...fresh };
        _data.set(symbol, entry);
        _capData();
        return entry;
      }
      // remember the failure briefly so deep scans don't hammer a
      // dead path on every click (10-min backoff, still honest)
      _data.set(symbol, { at: Date.now() - TTL + 10 * 60_000, symbol, err: 'unreachable' });
      _capData();
      return null;
    } catch { return null; }
    finally { _inflight.delete(symbol); }
  })();
  _inflight.set(symbol, p);
  return p;
}

/** Sector-average trailing P/E from cached peers (needs ≥3). */
function sectorAvgPe(sector, exclude) {
  if (!sector) return null;
  const peers = [];
  for (const [sec, syms] of Object.entries(SECTOR_MAP)) {
    if (String(sec).toLowerCase() !== String(sector).toLowerCase()) continue;
    for (const s of syms) {
      if (s === exclude) continue;
      const d = dataGet(s);
      if (d && Number.isFinite(d.pe) && d.pe > 0) peers.push(d.pe);
    }
  }
  if (peers.length < 3) return null;
  return peers.reduce((a, b) => a + b, 0) / peers.length;
}

/** Find the symbol's SECTOR_MAP sector key (by membership, not name). */
function sectorOf(symbol) {
  for (const [sec, syms] of Object.entries(SECTOR_MAP)) {
    if (syms.includes(symbol)) return sec;
  }
  return null;
}

/**
 * Warm the whole India universe's fundamentals (weekly, single-flight,
 * fire-and-forget — fills sector averages so P/E-vs-sector reads are
 * meaningful). Staggered 6-wide to stay polite to the free endpoint.
 */
async function warmFundamentalsUniverse() {
  if (_universeWarm) return _universeWarm;
  _universeWarm = (async () => {
    try {
      const symbols = Object.values(SECTOR_MAP).flat();
      for (let i = 0; i < symbols.length; i += 6) {
        await Promise.allSettled(symbols.slice(i, i + 6).map(s => refreshOne(s)));
      }
    } catch { /* honest degrade */ }
    finally { _universeWarm = null; }
  })();
  return _universeWarm;
}

/**
 * Attach fundamentals to a ctx for the SWING/deep path (India only).
 * Awaits the symbol's own data (≤6s budget); kicks the weekly
 * universe warm in the background so sector averages fill up.
 * Returns the ctx (unchanged when data unreachable — the model then
 * abstains honestly).
 */
export async function attachFundamentals(ctx) {
  if (!ctx || ctx.market !== 'INDIA' || !ctx.symbol) return ctx;
  const symbol = String(ctx.symbol).toUpperCase();
  warmFundamentalsUniverse().catch(() => {});
  const entry = await Promise.race([
    refreshOne(symbol),
    new Promise(res => setTimeout(() => res(dataGet(symbol)), WARM_TIMEOUT)),
  ]).catch(() => null);
  if (entry && !entry.err) {
    const sectorKey = sectorOf(symbol) || entry.sector;
    ctx.fundamentals = {
      pe: entry.pe ?? null,
      forwardPe: entry.forwardPe ?? null,
      sector: sectorKey,
      yahooSector: entry.sector ?? null,
      earnGrowth: entry.earnGrowth ?? null,
      revGrowth: entry.revGrowth ?? null,
      sectorAvgPe: sectorAvgPe(sectorKey, symbol),
      asOf: entry.at,
    };
  }
  return ctx;
}

// ---------------- the VOTE (sync, models.js contract) ----------------
/**
 * FundaCheck — ensemble seat #14. India swing-only (scope-gated by
 * ctx.fundamentals presence — the intraday board never attaches it).
 * Slow confirming factor: LOW conf by design, never the loudest voice.
 */
export function fundamentalsVote(ctx) {
  if (!ctx || ctx.market !== 'INDIA') {
    // v11.8 `na: true` — structural: the seat cannot serve non-India
    // markets; it must not sit in the quorum denominator (ensemble.js).
    return vote(0, 0, ['FundaCheck is India-only — abstains'], true);
  }
  const f = ctx.fundamentals;
  if (!f) {
    // The intraday board reaches here by design — 15m tape trades
    // must NOT be swung by a P/E ratio. Abstain is the correct vote.
    // v11.8 `na: true`: structurally not served on the intraday board
    // path (fundamentals attach on swing/deep paths only).
    return vote(0, 0, ['no fundamentals attached on this path (intraday desk by design) — FundaCheck abstains'], true);
  }
  const reasons = [];
  if (f.sector) reasons.push(`${f.sector} sector`);
  if (Number.isFinite(f.pe)) reasons.push(`P/E ${r1(f.pe)}${Number.isFinite(f.forwardPe) ? ` (fwd ${r1(f.forwardPe)})` : ''}`);

  const pe = Number(f.pe);
  const avg = Number(f.sectorAvgPe);
  const eg = Number(f.earnGrowth);

  if (!Number.isFinite(pe) || !(pe > 0)) {
    return vote(0, 0, [...reasons, 'no usable P/E (loss-making or missing) — abstains']);
  }
  if (!Number.isFinite(avg) || !(avg > 0)) {
    return vote(0, 0, [...reasons, 'sector-average P/E needs ≥3 priced peers (weekly warm fills it) — abstains for now']);
  }

  const rel = (pe - avg) / avg; // + = expensive vs sector, − = cheap vs sector
  reasons.push(`vs sector avg ${r1(avg)} → ${rel > 0 ? '+' : ''}${Math.round(rel * 100)}%`);
  if (Number.isFinite(eg)) reasons.push(`earnings growth ${eg > 0 ? '+' : ''}${Math.round(eg * 100)}% YoY (surprise proxy)`);

  // ---- the read: value + catalyst alignment ----
  const cheap = rel <= -0.15;
  const expensive = rel >= 0.20;
  const growing = Number.isFinite(eg) && eg > 0.10;
  const shrinking = Number.isFinite(eg) && eg < -0.05;

  if (cheap && growing) {
    return vote(1, 56, [...reasons, 'cheap vs sector AND earnings compounding — classic swing value+catalyst']);
  }
  if (cheap && !shrinking) {
    return vote(1, 47, [...reasons, 'discounted vs sector without deterioration — mean-reversion candidate']);
  }
  if (expensive && shrinking) {
    return vote(-1, 50, [...reasons, 'premium multiple with shrinking earnings — de-rating risk on swing horizon']);
  }
  if (expensive && growing) {
    return vote(0, 0, [...reasons, 'premium multiple but growth supports it — no edge either way, abstains']);
  }
  return vote(0, 0, [...reasons, 'valuation and growth in fair-value band — no fundamentals edge, abstains']);
}

// ---------------- transparency ----------------
export function fundamentalsStatus() {
  const cached = [..._data.values()].filter(d => !d.err);
  return {
    enabled: true,
    cacheTtlDays: TTL / 86400000,
    symbolsCached: cached.length,
    sectorsCovered: [...new Set(cached.map(d => d.sector).filter(Boolean))],
    universeSize: Object.values(SECTOR_MAP).flat().length,
    note: 'India swing-only seat: votes only where ctx.fundamentals is attached (deep-scan path); intraday board abstains by design.',
  };
}

export const __testables = {
  _data, sectorAvgPe, sectorOf, yahooQuoteSummary,
  __set(symbol, entry) { _data.set(symbol, { at: Date.now(), symbol, ...entry }); },
  __clear() { _data.clear(); _inflight.clear(); _crumb = null; _cookies = null; _crumbAt = 0; },
};
