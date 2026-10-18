// ============================================================
// server/mcp/portfolioSync.js — INDMoney + CoinDCX → SmartAI assets
// ------------------------------------------------------------
// Turns the synced portfolio sources into the app's ASSET TABLE
// source of truth:
//   1. syncNow()      — fetchPortfolio (INDMoney MCP) + CoinDCX
//                       balances → resolveSymbols → map to unified
//                       assets → persist snapshot (server/data/
//                       mcp-portfolio.json). Either source can drive
//                       the table alone; both merge cleanly.
//   2. Scheduler      — auto-sync 2× daily (default 09:30 & 21:30
//                       IST; env INDM_SYNC_TIMES="HH:MM,HH:MM"),
//                       with boot catch-up for missed slots (Render
//                       free-tier cold starts) and a stale-trigger
//                       on GET /assets (>6h old → background sync).
//   3. Realtime       — exchange-listed assets (India stocks/ETFs,
//                       US stocks, crypto) carry tradeable symbols;
//                       the frontend pollers/SSE then tick them live.
//                       MF/FD/bond/gold/EPF/NPS assets keep
//                       INDMoney's own unit price (NAV) and are
//                       refreshed on each scheduled sync.
//   4. Hidden assets  — the user can REMOVE any row (INDIA/USA/
//                       crypto). Hidden keys persist across syncs
//                       (a re-synced holding stays hidden) until
//                       restored or its source is disconnected.
//
// A failed source sync NEVER wipes the last good snapshot — the
// previous assets stay visible with a stale marker.
// ============================================================
import { loadJSON, saveJSON } from '../lib/store.js';
import { fetchPortfolio, getStatus } from './indmoney.js';
import { resolveSymbolsForHoldings } from './symbols.js';
import {
  coindcxConnected, coindcxStatus, fetchCoinDcxAssets,
} from './coindcx.js';
import { durablePut } from './durable.js';

const SNAPSHOT_FILE = 'mcp-portfolio.json';
const FOREX_CACHE_MS = 10 * 60 * 1000;
const STALE_BG_MS = 6 * 60 * 60 * 1000;    // GET /assets triggers a bg sync past this age
const BG_MIN_GAP = 10 * 60 * 1000;         // …but never more often than this
const CATCHUP_WINDOW_MS = 4 * 60 * 60 * 1000; // a missed slot syncs up to 4h late
const DEFAULT_USD_INR = 84;

const FOREX_UPSTREAMS = [
  'https://open.er-api.com/v6/latest/USD',
  'https://api.frankfurter.app/latest?from=USD&to=INR',
];
let _fx = { rate: null, ts: 0 };

// ---------------- IST clock (UTC+5:30, no DST) ----------------
export function istParts(d = new Date()) {
  const ist = new Date(d.getTime() + 330 * 60 * 1000);
  return {
    y: ist.getUTCFullYear(), m: ist.getUTCMonth() + 1, d: ist.getUTCDate(),
    hh: ist.getUTCHours(), mm: ist.getUTCMinutes(),
  };
}
function istDayKey(ts) { const p = istParts(new Date(ts)); return `${p.y}-${String(p.m).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`; }

// Parse "HH:MM" → minutes; invalid entries are dropped.
export function parseSlots(raw) {
  const out = [];
  for (const part of String(raw || '').split(',')) {
    const m = /^(\d{1,2}):(\d{2})$/.exec(part.trim());
    if (!m) continue;
    const hh = parseInt(m[1], 10), mm = parseInt(m[2], 10);
    if (hh > 23 || mm > 59) continue;
    out.push(`${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`);
  }
  return out.length ? out : ['09:30', '21:30'];
}
export function syncSlots() { return parseSlots(process.env.INDM_SYNC_TIMES); }

// Slot timestamp (epoch ms) for TODAY in IST. Pure — exported for tests.
export function slotTsToday(slot, now = Date.now()) {
  const [hh, mm] = slot.split(':').map(n => parseInt(n, 10));
  const p = istParts(new Date(now));
  // IST wall-clock → UTC epoch: build UTC fields from IST parts, then -5:30.
  const asUTC = Date.UTC(p.y, p.m - 1, p.d, hh, mm, 0);
  return asUTC - 330 * 60 * 1000;
}

// Pure scheduler decision: which slots are due at `now` given last runs.
export function computeDueSlots(now, lastRuns = {}, slots = syncSlots(), catchupMs = CATCHUP_WINDOW_MS) {
  const due = [];
  for (const slot of slots) {
    const ts = slotTsToday(slot, now);
    if (now < ts) continue;                              // slot not reached yet today
    if (now - ts > catchupMs) continue;                  // too late — skip missed slot
    const last = lastRuns[slot];
    if (last != null && istDayKey(last) === istDayKey(now)) continue; // already ran today
    due.push(slot);
  }
  return due;
}

// Next upcoming slot (epoch ms) strictly after `now` — for the UI countdown.
export function nextSlotTs(now = Date.now(), slots = syncSlots()) {
  let best = null;
  for (const slot of slots) {
    let ts = slotTsToday(slot, now);
    if (ts <= now) {
      // tomorrow's run of this slot
      const p = istParts(new Date(now));
      ts = Date.UTC(p.y, p.m - 1, p.d + 1, ...slot.split(':').map(n => parseInt(n, 10))) - 330 * 60 * 1000;
    }
    if (best == null || ts < best) best = ts;
  }
  return best;
}

// ---------------- USD/INR (for US-asset unit conversion) ----------------
async function fetchUsdInr() {
  if (_fx.rate != null && Date.now() - _fx.ts < FOREX_CACHE_MS) return _fx.rate;
  for (const url of FOREX_UPSTREAMS) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(5000) });
      if (!r.ok) continue;
      const j = await r.json();
      const inr = j?.rates?.INR;
      if (typeof inr === 'number' && inr > 50 && inr < 150) {
        _fx = { rate: inr, ts: Date.now() };
        return inr;
      }
    } catch { /* next upstream */ }
  }
  return _fx.rate ?? DEFAULT_USD_INR;
}

// ---------------- holdings → assets mapper (PURE) ----------------
// holdings: normalized holdings from fetchPortfolio()
// resolutions: [{ market, kind, symbol, noLive }] (from resolveSymbolsForHoldings)
// usdInr: conversion rate for US assets (their INDMoney values are INR).
export function mapHoldingsToAssets(holdings, resolutions, usdInr = DEFAULT_USD_INR) {
  const rate = (typeof usdInr === 'number' && usdInr > 50 && usdInr < 150) ? usdInr : DEFAULT_USD_INR;
  const assets = [];
  const seenIds = new Set();
  const seenKeys = new Map(); // slug-base → occurrence count (stable dedupe keys)
  for (let i = 0; i < (holdings || []).length; i++) {
    const h = holdings[i];
    const r = resolutions[i] || { market: 'IN', kind: 'other', symbol: null, noLive: true };

    const qty = (typeof h.qty === 'number' && h.qty > 0) ? h.qty : 1;
    const invested = typeof h.invested === 'number' ? h.invested
      : (typeof h.avgPrice === 'number' ? h.avgPrice * qty : null);
    const value = typeof h.value === 'number' ? h.value
      : (typeof h.currentPrice === 'number' ? h.currentPrice * qty : invested);
    if (invested == null && value == null) continue; // nothing usable

    // Per-unit prices. US assets: INDMoney reports INR — convert to USD so
    // the frontend's US price machinery (USD quotes × live FX) stays correct.
    const isUS = r.market === 'US';
    const lastPrice = value != null ? value / qty / (isUS ? rate : 1) : null;
    const avgPrice = invested != null ? invested / qty / (isUS ? rate : 1) : (lastPrice ?? 0);

    let id = `indm-${slug(h.name)}-${i}`;
    while (seenIds.has(id)) id += 'x';
    seenIds.add(id);

    // Stable removal key (survives index shifts between syncs):
    // name-based, with deterministic ordinals for same-name duplicates.
    const keyBase = `indm:${slug(h.name)}`;
    const n = (seenKeys.get(keyBase) || 0) + 1;
    seenKeys.set(keyBase, n);
    const key = n === 1 ? keyBase : `${keyBase}:${n}`;

    assets.push({
      id,
      key,
      name: String(h.name || 'Unknown'),
      source: 'indmoney',
      symbol: r.symbol || null,          // tradeable exchange symbol or null
      market: isUS ? 'US' : 'IN',
      kind: r.kind,                      // stock|etf|mf|crypto|bond|gold|retirement|fixed|other
      qty,
      avgPrice: round2(avgPrice),
      lastPrice: lastPrice != null ? round2(lastPrice) : null,
      value: value != null ? round2(value) : null,       // INR (INDMoney native)
      invested: invested != null ? round2(invested) : null, // INR
      pnl: h.pnl != null ? round2(h.pnl) : (value != null && invested != null ? round2(value - invested) : null),
      pnlPct: h.pnlPct != null ? h.pnlPct : (value != null && invested ? round2(((value - invested) / invested) * 100) : null),
      oneDayChangePct: h.oneDayChangePct != null ? h.oneDayChangePct : null,
      assetType: h.assetType || 'Other',
      assetEnum: h.assetEnum || null,
      noLive: !!r.noLive,                // no exchange price → seeded INDMoney price
    });
  }
  return assets;
}

function round2(n) { return Math.round(n * 100) / 100; }

// Summary over the VISIBLE asset rows (null-safe: basis-less crypto rows
// contribute value but NOT pnl — same honesty rule as the frontend).
// The INDMoney panel + snapshot cards use this so "INVESTED / CURRENT
// VALUE / TOTAL P&L" always match what the table actually shows — the
// raw INDMoney-leg summary (hidden rows included) stays available as
// `summaryAll` for debugging.
export function summarizeAssets(assets) {
  const list = Array.isArray(assets) ? assets : [];
  let totalValue = 0, totalInvested = 0, totalPnl = 0, withBasis = 0, oneDayChange = 0, oneDayCount = 0, oneDayValue = 0;
  for (const a of list) {
    if (!a || typeof a !== 'object') continue;
    if (typeof a.value === 'number' && Number.isFinite(a.value)) totalValue += a.value;
    if (typeof a.oneDayChangePct === 'number' && Number.isFinite(a.oneDayChangePct)
      && typeof a.value === 'number' && Number.isFinite(a.value)) {
      oneDayChange += a.value * (a.oneDayChangePct / 100);
      oneDayValue += a.value; // denominator = ONLY rows with day data
      oneDayCount++;
    }
    if (typeof a.invested === 'number' && Number.isFinite(a.invested)) {
      totalInvested += a.invested;
      if (typeof a.pnl === 'number' && Number.isFinite(a.pnl)) totalPnl += a.pnl;
      else if (typeof a.value === 'number' && Number.isFinite(a.value)) totalPnl += a.value - a.invested;
      withBasis++;
    }
  }
  return {
    totalValue: round2(totalValue),
    totalInvested: round2(totalInvested),
    totalPnl: round2(totalPnl),
    totalPnlPct: totalInvested > 0 ? round2((totalPnl / totalInvested) * 100) : null,
    oneDayChange: oneDayCount ? round2(oneDayChange) : null,
    // Weighted avg over the rows that HAVE day data — mixing in basis-less
    // rows (MFs/FDs, which report no oneDayChangePct) understated the
    // portfolio's "today %" whenever part of the table lacked day data.
    oneDayChangePct: oneDayCount && oneDayValue > 0 ? round2((oneDayChange / oneDayValue) * 100) : null,
    holdingCount: list.length,
    withBasis,
  };
}
function slug(name) {
  const s = String(name || 'asset').replace(/[^A-Za-z0-9]+/g, '').toUpperCase();
  return (s.slice(0, 12) || 'ASSET');
}

// ---------------- snapshot persistence ----------------
export function getAssetsSnapshot() {
  return loadJSON(SNAPSHOT_FILE, null);
}
function writeSnapshot(snap) {
  saveJSON(SNAPSHOT_FILE, snap);
  // Durable (encrypted GitHub) write-through — the asset rows + hidden
  // keys survive Render's ephemeral-disk restarts. Best-effort.
  try { durablePut(SNAPSHOT_FILE, snap); } catch { /* optional */ }
  return snap;
}

// Sync status + scheduler info for the frontend (no MCP calls).
export function syncInfo() {
  const snap = getAssetsSnapshot();
  const slots = syncSlots();
  const lastRuns = snap?.slots || {};
  const assets = Array.isArray(snap?.assets) ? snap.assets : [];
  const hidden = Array.isArray(snap?.hidden) ? snap.hidden : [];
  const visibleAssets = assets.filter(a => !hidden.includes(a.key));
  return {
    connected: getStatus().connected,
    ok: !!snap?.ok,
    syncedAt: snap?.syncedAt || null,
    stale: snap?.syncedAt ? Date.now() - snap.syncedAt > STALE_BG_MS : true,
    slots,
    lastRuns,
    nextSyncAt: nextSlotTs(),
    assetCount: visibleAssets.length,
    liveCount: visibleAssets.filter(a => !a.noLive).length,
    hiddenCount: assets.length - visibleAssets.length,
    sources: {
      indmoney: getStatus().connected,
      coindcx: coindcxConnected(),
    },
    coindcx: coindcxStatus(),
    lastError: snap?.lastError || null,
  };
}

// ---------------- hidden assets (user-removed rows) ----------------
// Removal is a HIDE, not a delete: the next sync re-adds the holding
// (INDMoney/CoinDCX still report it) but it stays hidden until restored.

// ---------------- v10.5 NET-WORTH AGGREGATION (Upgrade 3) ----------------
// The unified view the Portfolio tab's "Net Worth Summary" card reads:
// every visible asset bucketed into an asset class, with the total and
// the source-of-truth stamps. KIND → CLASS is the primary mapping
// (resolveSymbolsForHoldings assigns it); assetType (the INDMoney enum
// label) is the fallback; a CoinDCX-source row is crypto whatever it
// says. Hidden rows never count (they are removed, not "zero-value").
const CLASS_OF_KIND = {
  stock: 'Equity', etf: 'Equity', mf: 'Mutual Funds', retirement: 'EPF',
  gold: 'Gold', crypto: 'Crypto', bond: 'Fixed Income', fixed: 'Fixed Income',
  other: 'Other',
};
function assetClassOf(a) {
  if (a?.source === 'coindcx' || a?.kind === 'crypto') return 'Crypto';
  return CLASS_OF_KIND[a?.kind] || CLASS_OF_KIND[String(a?.kind || '').toLowerCase()] || 'Other';
}

export function netWorthSnapshot() {
  const snap = getAssetsSnapshot();
  const hidden = Array.isArray(snap?.hidden) ? snap.hidden : [];
  const assets = (Array.isArray(snap?.assets) ? snap.assets : []).filter(a => a && !hidden.includes(a.key));
  const byClass = new Map();
  let total = 0;
  let valued = 0;
  for (const a of assets) {
    const cls = assetClassOf(a);
    const cur = byClass.get(cls) || { category: cls, valueINR: 0, count: 0 };
    cur.count += 1;
    if (typeof a.value === 'number' && Number.isFinite(a.value)) {
      cur.valueINR += a.value;
      total += a.value;
      valued += 1;
    }
    byClass.set(cls, cur);
  }
  const categories = [...byClass.values()]
    .map(c => ({ ...c, valueINR: round2(c.valueINR) }))
    .sort((x, y) => y.valueINR - x.valueINR)
    .map(c => ({ ...c, pct: total > 0 ? round2((c.valueINR / total) * 100) : null }));
  const info = syncInfo();
  return {
    ok: assets.length > 0,
    totalValueINR: round2(total),
    valuedCount: valued,
    holdingCount: assets.length,
    categories,
    sources: info.sources,
    syncedAt: snap?.syncedAt || null,
    lastError: snap?.lastError || null,
    note: 'All values INR (INDMoney native; US rows reported in INR by the app). Hidden rows excluded.',
  };
}

function persistHiddenUpdate(mutate) {
  const snap = getAssetsSnapshot() || {};
  const hidden = new Set(Array.isArray(snap.hidden) ? snap.hidden : []);
  const changed = mutate(hidden, snap);
  if (!changed) return false;
  const out = { ...snap, hidden: [...hidden] };
  saveJSON(SNAPSHOT_FILE, out);
  return true;
}

export function hideAsset(key) {
  if (typeof key !== 'string' || !key) return false;
  const snap = getAssetsSnapshot();
  const assets = Array.isArray(snap?.assets) ? snap.assets : [];
  if (!assets.some(a => a.key === key)) return false; // unknown asset
  return persistHiddenUpdate(hidden => {
    if (hidden.has(key)) return false;
    hidden.add(key);
    return true;
  });
}

export function unhideAsset(key) {
  if (typeof key !== 'string' || !key) return false;
  return persistHiddenUpdate(hidden => {
    if (!hidden.has(key)) return false;
    hidden.delete(key);
    return true;
  });
}

export function unhideAll() {
  return persistHiddenUpdate(hidden => {
    if (hidden.size === 0) return false;
    hidden.clear();
    return true;
  });
}

// ---------------- the sync engine ----------------
let _inFlight = false;
let _lastBgAttempt = 0;

// Sources: 'indmoney' (MCP holdings) + 'coindcx' (exchange balances).
// `sources` option limits a run (e.g. the CoinDCX connect flow syncs
// ONLY coindcx so the user sees balances immediately, without a full
// 12-call INDMoney round-trip); the other source keeps its previous
// assets in the merged snapshot.
export async function syncNow({ force = true, reason = 'manual', sources } = {}) {
  if (_inFlight) return { ...syncInfo(), busy: true };
  const wantIndm = sources == null || sources.includes('indmoney');
  const wantCdcx = sources == null || sources.includes('coindcx');
  const indmConnected = getStatus().connected;
  const cdcxConnected = coindcxConnected();
  if ((wantIndm && indmConnected) || (wantCdcx && cdcxConnected)) {
    // at least one requested source is connected — proceed
  } else {
    const info = syncInfo();
    return { ...info, ok: false, reason: 'not-connected', assets: [] };
  }
  _inFlight = true;
  try {
    const prev = getAssetsSnapshot() || {};
    const prevAssets = Array.isArray(prev.assets) ? prev.assets : [];

    // ---------------- INDMoney leg ----------------
    // state: 'ok' fresh assets | 'fail' keep previous assets (stale) |
    // 'skip' source not requested | 'off' source disconnected → assets dropped
    let indmAssets = [];
    let indmSummary = prev.summary || null;
    let indmOfficial = !!prev.officialSummary;
    let indmPositions = Array.isArray(prev.positions) ? prev.positions : [];
    let indmError = null;
    if (wantIndm && indmConnected) {
      try {
        const pf = await fetchPortfolio({ force });
        if (pf.ok) {
          const usdInr = await fetchUsdInr();
          const resolutions = await resolveSymbolsForHoldings(pf.holdings);
          indmAssets = mapHoldingsToAssets(pf.holdings, resolutions, usdInr);
          indmSummary = pf.summary || null;
          indmOfficial = !!pf.officialSummary;
          indmPositions = pf.positions || [];
        } else {
          indmAssets = prevAssets.filter(a => (a.source || 'indmoney') === 'indmoney');
          indmError = `no holdings (${pf.reason || 'unknown'})`;
        }
      } catch (err) {
        // hard failure (network / token revoked) — keep last good assets
        indmAssets = prevAssets.filter(a => (a.source || 'indmoney') === 'indmoney');
        indmError = String(err?.message || err).slice(0, 200);
      }
    } else if (wantIndm && !indmConnected) {
      indmError = null; // disconnected is not an error — assets simply gone
    } else if (!wantIndm && indmConnected) {
      // Not requested this run (e.g. the CoinDCX connect / Set-Basis quick
      // sync) — PRESERVE the previous INDMoney rows per the documented
      // merge contract. Without this branch a crypto-only sync wrote a
      // crypto-only snapshot: the whole India/USA table vanished (hidden
      // flags with it) and the gutted snapshot was durable-backed,
      // surviving restarts. Recovery needed a manual full sync.
      indmAssets = prevAssets.filter(a => (a.source || 'indmoney') === 'indmoney');
    }

    // ---------------- CoinDCX leg ----------------
    let cdcxAssets = [];
    let cdcxInfo = prev.coindcx || null;
    let cdcxError = null;
    if (wantCdcx && cdcxConnected) {
      try {
        const usdInr = await fetchUsdInr();
        const out = await fetchCoinDcxAssets(usdInr);
        cdcxAssets = out?.assets || [];
        cdcxInfo = {
          syncedAt: Date.now(),
          balanceCount: out?.balanceCount ?? 0,
          lastError: null,
        };
      } catch (err) {
        // bad creds / API down — keep the previous CoinDCX assets (stale)
        cdcxAssets = prevAssets.filter(a => a.source === 'coindcx');
        cdcxError = String(err?.message || err).slice(0, 200);
        cdcxInfo = { ...(prev.coindcx || {}), lastError: cdcxError };
      }
    } else if (!wantCdcx && cdcxConnected) {
      // Not requested this run — keep the previous crypto rows (mirror of
      // the INDMoney preserve branch: never drop a connected source's
      // assets just because it wasn't part of THIS run).
      cdcxAssets = prevAssets.filter(a => a.source === 'coindcx');
    }

    // ---------------- merge + persist ----------------
    const anyError = indmError || cdcxError;
    const anyFresh = (wantIndm && indmConnected && !indmError) || (wantCdcx && cdcxConnected && !cdcxError);

    // v10.18 (deep-recheck #3): MID-SYNC DISCONNECT race. `indmConnected`
    // / `cdcxConnected` were captured 30-60s of awaits ago at sync start.
    // If the user disconnected a source during that window,
    // clearSourceAssets() already wrote a snapshot WITHOUT that source's
    // rows — and this still-running sync would then write them right
    // back (resurrect + durable-put, surviving restarts until the next
    // sync). Re-check connectivity in the same no-await window as the
    // hidden re-read below and drop the now-disconnected source's rows,
    // mirroring clearSourceAssets exactly (summary/positions/coindcx
    // residue dropped along with them).
    const indmStill = getStatus().connected;
    const cdcxStill = coindcxConnected();
    const dropIndm = indmConnected && !indmStill;
    const dropCdcx = cdcxConnected && !cdcxStill;
    if (dropIndm) { indmSummary = null; indmOfficial = false; indmPositions = []; }
    if (dropCdcx) { cdcxInfo = null; }
    const assets = (dropIndm || dropCdcx)
      ? [...indmAssets, ...cdcxAssets].filter(a => {
          const src = a.source || 'indmoney';
          return !((dropIndm && src === 'indmoney') || (dropCdcx && src === 'coindcx'));
        })
      : [...indmAssets, ...cdcxAssets];
    const anyUsable = assets.length > 0;

    // Re-read hidden RIGHT BEFORE the merge write: a hide/unhide landing
    // during this sync's 30-60s of awaits must not be silently reverted
    // by the `prev` captured at sync start (no awaits between this read
    // and the write — the race window is effectively closed).
    const nowSnap = getAssetsSnapshot() || {};
    const hiddenNow = Array.isArray(nowSnap.hidden) ? nowSnap.hidden : [];
    // Hidden keys carry forward verbatim (a removed asset stays removed
    // across syncs). Keys for dropped sources are cleaned below via
    // clearSourceAssets(); here we keep everything that still matches an
    // asset so the UI list stays honest.
    const hidden = hiddenNow.filter(k => assets.some(a => a.key === k));

    // Mark scheduler slots as run (scheduler passes its slot; manual marks none).
    let slots = prev.slots || {};
    if (reason && reason !== 'manual') slots = { ...slots, [reason]: Date.now() };

    writeSnapshot({
      // ok = fresh, error-free data. A failed leg keeps the previous
      // assets in the snapshot but marks it NOT ok (stale) — the /assets
      // ROUTE separately decides usability (degraded-tolerant there).
      ok: anyUsable && !anyError,
      source: 'indmoney+coindcx',
      // syncedAt only advances on FRESH data — a failed sync must keep the
      // previous timestamp so "stale" stays honest.
      syncedAt: anyFresh ? Date.now() : (prev.syncedAt || null),
      assets,
      summary: indmSummary,
      officialSummary: indmOfficial,
      positions: indmPositions,
      coindcx: cdcxInfo,
      hidden,
      counts: {
        assets: assets.length,
        live: assets.filter(a => !a.noLive).length,
        noLive: assets.filter(a => a.noLive).length,
        resolved: assets.filter(a => a.symbol).length,
        coindcx: assets.filter(a => a.source === 'coindcx').length,
      },
      lastError: indmError || cdcxError || null,
      failedAt: indmError || cdcxError ? Date.now() : null,
      slots,
    });
    const info = syncInfo();
    if (anyError) return { ...info, ok: false, error: String(anyError) };
    if (!anyUsable) return { ...info, ok: false, error: 'no holdings from any source' };
    return info;
  } finally {
    _inFlight = false;
  }
}

// Background sync guard used by GET /assets: fire-and-forget when stale.
export function maybeBackgroundSync() {
  if (!getStatus().connected && !coindcxConnected()) return false;
  if (Date.now() - _lastBgAttempt < BG_MIN_GAP) return false;
  const snap = getAssetsSnapshot();
  const stale = !snap?.ok || !snap?.syncedAt || Date.now() - snap.syncedAt > STALE_BG_MS;
  if (!stale || _inFlight) return false;
  _lastBgAttempt = Date.now();
  void syncNow({ force: true, reason: 'stale-trigger' }).catch(() => { });
  return true;
}

// ---------------- daily 2× scheduler ----------------
let _schedTimer = null;
let _lastSchedFail = 0;      // failure backoff — never hammer INDMoney
const SCHED_FAIL_BACKOFF_MS = 10 * 60 * 1000;
export function startScheduler() {
  if (_schedTimer) return _schedTimer;
  const tick = () => {
    try {
      if (!getStatus().connected && !coindcxConnected()) return;
      const snap = getAssetsSnapshot() || {};
      const due = computeDueSlots(Date.now(), snap.slots || {});
      if (due.length === 0) return;
      if (Date.now() - _lastSchedFail < SCHED_FAIL_BACKOFF_MS) return; // retry later, not every tick
      const run = syncNow({ force: true, reason: due[0] });
      run.then(out => {
        _lastSchedFail = out?.ok === false ? Date.now() : 0;
      }).catch(() => { _lastSchedFail = Date.now(); });
    } catch { /* scheduler must never crash the server */ }
  };
  tick(); // boot catch-up for slots missed while the dyno slept
  _schedTimer = setInterval(tick, 60 * 1000);
  _schedTimer.unref?.();
  return _schedTimer;
}
export function __stopSchedulerForTests() {
  if (_schedTimer) { clearInterval(_schedTimer); _schedTimer = null; }
  _lastSchedFail = 0;
}

// Disconnect must drop the synced assets of THAT source with it —
// the other source's assets survive (e.g. disconnecting INDMoney
// keeps the CoinDCX crypto rows, and vice-versa).
export function clearSourceAssets(source) {
  const snap = getAssetsSnapshot() || {};
  const keep = (Array.isArray(snap.assets) ? snap.assets : [])
    .filter(a => (a.source || 'indmoney') !== source);
  const hidden = (Array.isArray(snap.hidden) ? snap.hidden : [])
    .filter(k => keep.some(a => a.key === k));
  writeSnapshot({
    ...snap,
    ok: keep.length > 0,
    assets: keep,
    hidden,
    counts: keep.length ? {
      assets: keep.length,
      live: keep.filter(a => !a.noLive).length,
      noLive: keep.filter(a => a.noLive).length,
      resolved: keep.filter(a => a.symbol).length,
      coindcx: keep.filter(a => a.source === 'coindcx').length,
    } : null,
    // source-specific residue is dropped along with its assets
    ...(source === 'indmoney' ? { summary: null, officialSummary: false, positions: [], lastError: null } : {}),
    ...(source === 'coindcx' ? { coindcx: null } : {}),
    clearedAt: Date.now(),
  });
}

// Full wipe (legacy path + tests): nothing survives.
export function clearSnapshot() {
  writeSnapshot({
    ok: false, source: 'indmoney', syncedAt: null, assets: [], slots: {}, hidden: [],
    clearedAt: Date.now(),
  });
}

// ---------------- test hooks ----------------
export function __resetSyncForTests() {
  _inFlight = false;
  _lastBgAttempt = 0;
  _fx = { rate: null, ts: 0 };
}
export function __setFetchForTests(fn) {
  globalThis.fetch = fn; // forex upstreams use global fetch
}
