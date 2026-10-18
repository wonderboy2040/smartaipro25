// ============================================
// SITE SYNC — WealthAI live portfolio snapshot
// Advance Pro v18.1 — 2026-09 site integration
// ============================================
// The bot process is forked from the SAME repo/server (BOT_ONLY=true) and
// shares the filesystem, so it reads the site's merged INDMoney + CoinDCX
// asset snapshot (server/data/mcp-portfolio.json) DIRECTLY from disk —
// zero HTTP, zero auth, always consistent with what the web app shows.
//
// Loopback service calls (POST /api/mcp/indmoney/sync, /assets/hide, …)
// go through the site's HTTP API on 127.0.0.1 with the server-only
// API_TOKEN service credential (never exposed to the browser bundle).
//
// The OLD Google-Apps-Script cloud sync was fully removed in this pass —
// the site disconnected Sheets when INDMoney MCP took over the portfolio.
// ============================================

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SNAPSHOT_FILE = path.join(__dirname, '..', 'server', 'data', 'mcp-portfolio.json');

// Site loopback base — the bot runs as a child of server/index.js, so the
// Express app is always on 127.0.0.1:PORT from here.
const SITE_PORT = process.env.PORT || 8080;
const SITE_BASE = `http://127.0.0.1:${SITE_PORT}`;
const SERVICE_TOKEN = process.env.API_TOKEN || '';

// ------------------------------------------------------------
// Snapshot reader (disk — same file the web app's Portfolio tab serves)
// ------------------------------------------------------------
export function loadSiteSnapshot() {
  try {
    const raw = fs.readFileSync(SNAPSHOT_FILE, 'utf8');
    const snap = JSON.parse(raw);
    if (snap && typeof snap === 'object') return snap;
  } catch { /* no snapshot yet / unreadable */ }
  return null;
}

// Stable pseudo-symbol for NAV-priced assets without an exchange symbol
// (mutual funds, FDs, bonds…) — mirrors the frontend's generator.
const STOP_WORDS = new Set(['LTD', 'LIMITED', 'THE', 'OF', 'AND', 'INC', 'PLC', 'COMPANY', 'INDIA']);
function pseudoSymbol(name, used) {
  const words = String(name || 'ASSET').replace(/[^A-Za-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean);
  const meaningful = words.filter(w => !STOP_WORDS.has(w.toUpperCase()));
  let base = (meaningful.length ? meaningful : words).map(w => w.toUpperCase()).join('').slice(0, 10) || 'ASSET';
  if (!/^[A-Z]/.test(base)) base = `A${base.slice(0, 9)}`;
  let out = base; let n = 1;
  while (used.has(out)) out = `${base.slice(0, 8)}${n++}`;
  used.add(out);
  return out;
}

// Map the snapshot's assets onto the bot's portfolio[] entry shape
// ({ symbol, market, qty, avgPrice } + site metadata for AI context).
function mapAssets(snapshot) {
  const assets = Array.isArray(snapshot?.assets) ? snapshot.assets : [];
  const hidden = new Set(Array.isArray(snapshot?.hidden) ? snapshot.hidden : []);
  const used = new Set();
  const out = [];
  for (const a of assets) {
    if (hidden.has(a.key)) continue;
    const symRaw = String(a.symbol || '').trim().toUpperCase();
    const symbol = /^[A-Z0-9&.\-]{1,15}$/.test(symRaw) ? symRaw : pseudoSymbol(a.name, used);
    const qty = Number(a.qty) || 0;
    const avgPrice = Number(a.avgPrice) || (qty > 0 ? (Number(a.invested) || Number(a.value) || 0) / qty : 0);
    out.push({
      symbol,
      market: String(a.market || 'IN').toUpperCase() === 'US' ? 'US' : 'IN',
      qty,
      avgPrice: +(avgPrice.toFixed ? avgPrice.toFixed(2) : avgPrice),
      // site metadata (AI context + commands)
      name: a.name || symbol,
      assetType: a.assetType || 'Other',
      noLive: !!a.noLive,               // NAV-priced (MF/FD/bond) — no live quote
      source: a.source || 'indmoney',   // indmoney | coindcx
      indmKey: a.key,                   // stable hide/restore key
      lastSyncPrice: Number(a.lastPrice) || null,
      lastSyncPnlPct: Number(a.pnlPct) || null,
    });
  }
  return out;
}

// Portfolio loader — drop-in replacement for the old Apps-Script loader.
export async function loadPortfolioFromCloud() {
  const snap = loadSiteSnapshot();
  if (!snap) return null;
  const entries = mapAssets(snap);
  if (entries.length === 0) return null;
  console.log(`🏦 Site snapshot: ${entries.length} synced assets (INDMoney/CoinDCX) — last sync ${snap.syncedAt ? new Date(snap.syncedAt).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }) + ' IST' : 'never'}`);
  return entries;
}

// ------------------------------------------------------------
// Sync metadata — powers /syncstatus, /coindcx, /portfolio headers
// ------------------------------------------------------------
export function loadSyncMeta() {
  const snap = loadSiteSnapshot();
  const assets = Array.isArray(snap?.assets) ? snap.assets : [];
  const hidden = new Set(Array.isArray(snap?.hidden) ? snap.hidden : []);
  const visible = assets.filter(a => !hidden.has(a.key));
  return {
    ok: !!snap?.ok,
    syncedAt: snap?.syncedAt || null,
    stale: snap?.syncedAt ? Date.now() - snap.syncedAt > 6 * 60 * 60 * 1000 : true,
    slots: snap?.slots || {},
    nextSyncAt: snap?.nextSyncAt || null,
    lastError: snap?.lastError || null,
    counts: {
      visible: visible.length,
      hidden: hidden.size,
      live: visible.filter(a => !a.noLive).length,
      nav: visible.filter(a => a.noLive).length,
      coindcx: visible.filter(a => a.source === 'coindcx').length,
      indmoney: visible.filter(a => a.source !== 'coindcx').length,
    },
    coindcx: snap?.coindcx || null,
  };
}

// Hidden asset rows (for /hidden — includes restore keys).
export function listHiddenAssets() {
  const snap = loadSiteSnapshot();
  const assets = Array.isArray(snap?.assets) ? snap.assets : [];
  const hidden = new Set(Array.isArray(snap?.hidden) ? snap.hidden : []);
  return assets.filter(a => hidden.has(a.key))
    .map(a => ({ key: a.key, name: a.name, symbol: a.symbol || null, source: a.source || 'indmoney', value: a.value }));
}

// ------------------------------------------------------------
// Loopback service client (site HTTP API + API_TOKEN service auth)
// ------------------------------------------------------------
export function siteApiConfigured() {
  return SERVICE_TOKEN.length >= 12;
}

export async function siteApi(pathname, { method = 'GET', body } = {}) {
  if (!siteApiConfigured()) return { ok: false, error: 'API_TOKEN not configured (min 12 chars) — service calls disabled.' };
  try {
    const res = await fetch(`${SITE_BASE}${pathname}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${SERVICE_TOKEN}`,
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(150000), // a full sync = 12 MCP calls, can take ~2 min
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, error: (j?.error?.message || `HTTP ${res.status}`) };
    return { ok: true, data: j };
  } catch (e) {
    return { ok: false, error: e?.message || 'network error' };
  }
}

/** Trigger a fresh portfolio sync on the site (INDMoney + CoinDCX legs). */
export async function triggerSiteSync() {
  return siteApi('/api/mcp/indmoney/sync', { method: 'POST', body: { reason: 'telegram-bot' } });
}

/** Hide / restore asset rows (persist across syncs). */
export async function hideSiteAsset(key) {
  return siteApi('/api/mcp/indmoney/assets/hide', { method: 'POST', body: { key } });
}
export async function unhideSiteAsset(key) {
  return siteApi('/api/mcp/indmoney/assets/unhide', { method: 'POST', body: { key } });
}
export async function unhideAllSiteAssets() {
  return siteApi('/api/mcp/indmoney/assets/unhide', { method: 'POST', body: { all: true } });
}
