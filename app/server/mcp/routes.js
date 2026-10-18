// ============================================================
// server/mcp/routes.js — Express routes for the INDMoney MCP +
// CoinDCX portfolio integrations (the ASSET TABLE sources).
// All routes sit behind the global requireAuth middleware
// (Bearer token / session cookie).
//
//   GET  /api/mcp/indmoney/status      → connection status
//   GET  /api/mcp/indmoney/connect     → 302 → INDMoney OAuth (PKCE)
//   GET  /api/mcp/indmoney/callback    → OAuth redirect target
//   POST /api/mcp/indmoney/disconnect  → revoke + forget tokens
//   GET  /api/mcp/indmoney/tools       → list MCP tools
//   POST /api/mcp/indmoney/call        → generic MCP tool call (debug)
//   GET  /api/mcp/indmoney/assets      → synced asset TABLE snapshot
//                                      (hidden rows filtered out;
//                                      triggers a background refresh
//                                      when stale)
//   POST /api/mcp/indmoney/sync        → force asset-table sync now
//                                      (INDMoney + CoinDCX both)
//   POST /api/mcp/indmoney/assets/hide    → remove an asset row (hide)
//   POST /api/mcp/indmoney/assets/unhide  → restore removed row(s)
//   POST /api/mcp/coindcx/connect      → save + validate API keys
//   POST /api/mcp/coindcx/disconnect   → forget keys + drop assets
//   GET  /api/mcp/coindcx/status       → connection + last balance sync
//
//   Tapetide (India stock-research MCP, v4.7):
//   GET  /api/mcp/tapetide/status      → connection + tools catalog state
//   GET  /api/mcp/tapetide/connect     → 302 → Tapetide OAuth (PKCE)
//   GET  /api/mcp/tapetide/callback    → OAuth redirect target
//   POST /api/mcp/tapetide/disconnect  → forget tokens
//   GET  /api/mcp/tapetide/tools       → tools list (categorized)
//   POST /api/mcp/tapetide/call        → generic MCP tool call
// ============================================================
import { Router } from 'express';
import {
  startConnect, completeConnect, disconnect, getStatus,
  getPendingOrigin, IndmError, listTools, callTool, extractToolPayload,
} from './indmoney.js';
import {
  syncNow, syncInfo, getAssetsSnapshot, maybeBackgroundSync,
  clearSourceAssets, hideAsset, unhideAsset, unhideAll, summarizeAssets,
  netWorthSnapshot,
} from './portfolioSync.js';
import {
  coindcxConnect, coindcxDisconnect, coindcxStatus,
  setManualBasis, clearManualBasis, getManualBasis,
} from './coindcx.js';
import { getSettings, setSetting } from './settings.js';
import { durableStatus } from './durable.js';
import * as tapetide from './tapetide.js';

const router = Router();

// --- tiny in-memory rate limit for outbound MCP calls (60/min) ---
const RL_WINDOW = 60_000;
const RL_MAX = 60;
const _hits = new Map();
function rateLimited(key) {
  const now = Date.now();
  const rec = _hits.get(key);
  if (!rec || now - rec.start > RL_WINDOW) { _hits.set(key, { start: now, n: 1 }); return false; }
  rec.n += 1;
  return rec.n > RL_MAX;
}
// GC occasionally so the map never grows unbounded.
if (typeof setInterval === 'function') {
  const t = setInterval(() => {
    const now = Date.now();
    for (const [k, v] of _hits) if (now - v.start > RL_WINDOW * 2) _hits.delete(k);
  }, 5 * 60_000);
  t.unref?.();
}

// Uniform error mapping → JSON shape used across this codebase.
// Handles IndmError AND TptError (tapetide.js) — both carry
// { status, code } (duck-typing keeps the modules decoupled).
function fail(res, err) {
  if (err instanceof IndmError) {
    return res.status(err.status).json({ error: { message: err.message, code: err.code } });
  }
  if (err && typeof err.status === 'number' && err.code) {
    return res.status(err.status).json({ error: { message: err.message, code: err.code } });
  }
  console.error('[mcp/routes] Unexpected error:', err?.message || err);
  return res.status(500).json({ error: { message: 'MCP internal error', code: 'INTERNAL' } });
}

// Derive the public origin of THIS deployment (Render proxy aware).
// v20.9.1 [L]: x-forwarded-host ab WOHI trust-gating use karta hai jo
// clientIpOf (index.js) XFF ke liye karta hai — pehle koi bhi peer
// header-passing intermediary is origin ko control kar sakta tha (OAuth
// error-path redirect open-redirect footgun). TRUST_PROXY=1 ya loopback
// peer ke bina req.headers.host hi authoritative hai.
const _MCP_TRUST_PROXY = String(process.env.TRUST_PROXY || '') === '1';
function _mcpIsLoopback(ip) {
  const s = String(ip || '');
  return s === '127.0.0.1' || s === '::1' || s === '::ffff:127.0.0.1' || s.startsWith('::ffff:127.');
}
function requestOrigin(req) {
  const proto = (req.headers['x-forwarded-proto'] || req.protocol || 'https').toString().split(',')[0].trim();
  const peer = req.socket?.remoteAddress || 'unknown';
  const fwdHost = (_MCP_TRUST_PROXY || _mcpIsLoopback(peer))
    ? (req.headers['x-forwarded-host'] || '').toString().split(',')[0].trim()
    : '';
  const host = (fwdHost || req.headers.host || '').toString().split(',')[0].trim();
  if (!host) return null;
  return `${proto}://${host}`;
}

// ------------------------------------------------------------
// GET /status — is INDMoney connected?
// ------------------------------------------------------------
router.get('/api/mcp/indmoney/status', (_req, res) => {
  try {
    res.json({ ok: true, ...getStatus(), durable: durableStatus() });
  } catch (err) { return fail(res, err); }
});

// ------------------------------------------------------------
// GET /connect — full-page redirect that starts the OAuth flow.
// ------------------------------------------------------------
router.get('/api/mcp/indmoney/connect', async (req, res) => {
  try {
    const origin = requestOrigin(req);
    if (!origin) throw new IndmError('Could not determine site origin', 400, 'NO_ORIGIN');
    const { authorizeUrl } = await startConnect(origin);
    return res.redirect(302, authorizeUrl);
  } catch (err) { return fail(res, err); }
});

// ------------------------------------------------------------
// GET /callback — INDMoney redirects the browser back here.
// Auth: the user's session cookie rides along on this top-level
// navigation (SameSite=None/Lax both allow it), so requireAuth
// has already validated them before we reach this handler.
// ------------------------------------------------------------
router.get('/api/mcp/indmoney/callback', async (req, res) => {
  const { code, state, error, error_description: errDesc } = req.query;
  let origin = requestOrigin(req);

  try {
    // Prefer the origin captured when /connect was hit (robust to proxy
    // header quirks on the callback leg).
    const saved = typeof state === 'string' ? getPendingOrigin(state) : null;
    if (saved) origin = saved;
    if (!origin) throw new IndmError('Missing site origin for redirect', 400, 'NO_ORIGIN');

    await completeConnect({ code, state, error, errorDescription: errDesc });
    // v20.9.3 FIX (L): 'portfolio' tab v20.0 me remove ho chuka tha — the
    // redirect landed on the DEFAULT desk with zero connect feedback.
    // Valid desk + a param the shell surfaces (App.tsx mcp connect chip).
    return res.redirect(302, `${origin}/?tab=india&indm=ok`);
  } catch (err) {
    const reason = encodeURIComponent(String(err?.message || err?.code || 'unknown_error'));
    const base = origin || '';
    return res.redirect(302, `${base}/?tab=india&indm=error&reason=${reason}`);
  }
});

// ------------------------------------------------------------
// POST /disconnect — revoke tokens + clear stored state.
// Also clears the INDMoney-sourced asset rows: INDMoney IS an
// asset source, so disconnecting removes its rows — but CoinDCX
// crypto rows (the other source) survive.
// ------------------------------------------------------------
router.post('/api/mcp/indmoney/disconnect', async (_req, res) => {
  try {
    const out = await disconnect();
    try { clearSourceAssets('indmoney'); } catch { /* non-fatal */ }
    return res.json(out);
  } catch (err) { return fail(res, err); }
});

// ------------------------------------------------------------
// GET /tools — list tools exposed by the INDMoney MCP server.
// ------------------------------------------------------------
router.get('/api/mcp/indmoney/tools', async (req, res) => {
  try {
    if (rateLimited('tools')) throw new IndmError('Too many requests — try again shortly', 429, 'RATE_LIMITED');
    const force = req.query.force === '1' || req.query.force === 'true';
    const { tools, cached } = await listTools({ force });
    return res.json({
      ok: true, cached,
      tools: (tools || []).map(t => ({
        name: t.name,
        description: t.description || null,
        inputSchema: t.inputSchema ? { type: t.inputSchema.type, properties: Object.keys(t.inputSchema.properties || {}) } : null,
      })),
    });
  } catch (err) { return fail(res, err); }
});

// ------------------------------------------------------------
// GET/POST /assets — the synced ASSET TABLE (INDMoney + CoinDCX
// are the sources of truth for the app's portfolio). Returns the
// persisted snapshot + scheduler info; rows the user REMOVED are
// filtered out (they stay restorable). When the snapshot is stale
// (>6h) and a source is connected, a background refresh is fired
// (deduped, rate-limited) so the next poll gets fresh data without
// this request blocking on a full round-trip.
// ------------------------------------------------------------
router.get('/api/mcp/indmoney/assets', (_req, res) => {
  try {
    maybeBackgroundSync();
    const snap = getAssetsSnapshot();
    const info = syncInfo();
    // Degraded-tolerant: a FAILED sync keeps the last good assets — they
    // stay usable (ok) with lastError/stale flags explaining the state.
    // Only "no source connected" or "no assets at all" make the table
    // unusable.
    const allAssets = Array.isArray(snap?.assets) ? snap.assets : [];
    const hidden = Array.isArray(snap?.hidden) ? snap.hidden : [];
    const assets = allAssets.filter(a => !hidden.includes(a.key));
    const hiddenAssets = allAssets.filter(a => hidden.includes(a.key));
    const anySource = info.sources?.indmoney || info.sources?.coindcx;
    const usable = !!anySource && assets.length > 0;
    // v5.1: the panel's INVESTED / CURRENT VALUE / TOTAL P&L card is the
    // summary over the VISIBLE rows (what the table shows) — the raw
    // INDMoney-leg summary (hidden rows included) moves to summaryAll.
    // counts.assets is likewise visible-only; hiddenCount carries the rest.
    return res.json({
      ok: usable,
      reason: !anySource ? 'not-connected' : (assets.length === 0 && hiddenAssets.length === 0 ? (snap?.lastError || 'no-snapshot') : (assets.length === 0 ? 'all-hidden' : null)),
      assets,
      hiddenAssets,
      hiddenCount: hiddenAssets.length,
      counts: snap?.counts ? {
        ...snap.counts,
        assets: assets.length,
        hidden: hiddenAssets.length,
      } : null,
      summary: summarizeAssets(assets),
      summaryAll: snap?.summary || null,
      positions: Array.isArray(snap?.positions) ? snap.positions : [],
      sources: info.sources,
      coindcx: info.coindcx,
      syncedAt: snap?.syncedAt || null,
      stale: info.stale,
      // v10.5 (Upgrade 3): the unified net-worth view — every visible
      // asset bucketed by class (Equity/MF/EPF/Gold/Crypto/Fixed), the
      // total, and the source stamps. The Portfolio tab's Net Worth
      // Summary card renders exactly this.
      netWorth: netWorthSnapshot(),
      slots: info.slots,
      lastRuns: info.lastRuns,
      nextSyncAt: info.nextSyncAt,
      lastError: snap?.lastError || null,
    });
  } catch (err) { return fail(res, err); }
});

// ------------------------------------------------------------
// POST /assets/hide — REMOVE an asset row (India/USA/crypto, any
// source). Removal persists across syncs; restore via /unhide.
// Body: { key: string }
// ------------------------------------------------------------
router.post('/api/mcp/indmoney/assets/hide', (req, res) => {
  try {
    const { key } = req.body || {};
    if (typeof key !== 'string' || !key) {
      throw new IndmError('`key` (string) is required', 400, 'BAD_REQUEST');
    }
    const changed = hideAsset(key);
    if (!changed) {
      throw new IndmError('Asset not found or already removed', 404, 'NOT_FOUND');
    }
    return res.json({ ok: true, key, ...syncInfo() });
  } catch (err) { return fail(res, err); }
});

// ------------------------------------------------------------
// POST /assets/unhide — restore a removed row.
// Body: { key: string } OR { all: true }
// ------------------------------------------------------------
router.post('/api/mcp/indmoney/assets/unhide', (req, res) => {
  try {
    const { key, all } = req.body || {};
    let changed = false;
    if (all === true) {
      changed = unhideAll();
    } else if (typeof key === 'string' && key) {
      changed = unhideAsset(key);
    } else {
      throw new IndmError('`key` (string) or `all: true` is required', 400, 'BAD_REQUEST');
    }
    if (!changed) {
      throw new IndmError('Nothing to restore', 404, 'NOT_FOUND');
    }
    return res.json({ ok: true, ...(all === true ? {} : { key }), ...syncInfo() });
  } catch (err) { return fail(res, err); }
});

// ------------------------------------------------------------
// POST /sync — force the asset-table sync NOW (manual button).
// Syncs BOTH sources (INDMoney MCP + CoinDCX balances).
// Rate-limited; returns the fresh snapshot info.
// ------------------------------------------------------------
router.post('/api/mcp/indmoney/sync', async (req, res) => {
  try {
    if (rateLimited('sync')) throw new IndmError('Too many requests — try again shortly', 429, 'RATE_LIMITED');
    const out = await syncNow({ force: true, reason: 'manual' });
    return res.json({ ok: !!out.ok, ...out });
  } catch (err) { return fail(res, err); }
});

// ------------------------------------------------------------
// CoinDCX — crypto exchange account (API key + secret, stored
// ONLY server-side). Connect validates the pair with a real
// balances call, then triggers a coindcx-only quick sync so the
// crypto rows land immediately.
// ------------------------------------------------------------
router.get('/api/mcp/coindcx/status', (_req, res) => {
  try {
    res.json({ ok: true, ...coindcxStatus(), durable: durableStatus() });
  } catch (err) { return fail(res, err); }
});

router.post('/api/mcp/coindcx/connect', async (req, res) => {
  try {
    if (rateLimited('coindcx')) throw new IndmError('Too many requests — try again shortly', 429, 'RATE_LIMITED');
    const { apiKey, secret } = req.body || {};
    let out;
    try {
      out = await coindcxConnect(apiKey, secret);
    } catch (err) {
      throw new IndmError(`CoinDCX connect failed: ${err?.message || 'invalid API key/secret'}`, 401, 'CDCX_AUTH');
    }
    // Quick coindcx-only sync so the user sees balances immediately
    // (a full 12-call INDMoney round-trip would add 30-60s here).
    try { await syncNow({ force: true, reason: 'manual', sources: ['coindcx'] }); } catch { /* non-fatal — scheduled sync will pick it up */ }
    return res.json({ ok: true, ...out, ...syncInfo() });
  } catch (err) { return fail(res, err); }
});

router.post('/api/mcp/coindcx/disconnect', (_req, res) => {
  try {
    const out = coindcxDisconnect();
    try { clearSourceAssets('coindcx'); } catch { /* non-fatal */ }
    return res.json({ ok: true, ...out });
  } catch (err) { return fail(res, err); }
});

// ------------------------------------------------------------
// MANUAL COST BASIS (v5.2) — the CoinDCX app's "Invested ₹X" comes
// from its trade ledger; a view-only API key cannot see it. These
// routes let the user enter per-coin invested amounts ONCE (from the
// app's coin pages). They persist across syncs (durable-backed) and
// are used ONLY when the ledger basis is missing for that coin.
// ------------------------------------------------------------
router.get('/api/mcp/coindcx/basis', (_req, res) => {
  try {
    return res.json({ ok: true, basis: getManualBasis() });
  } catch (err) { return fail(res, err); }
});

router.post('/api/mcp/coindcx/basis', async (req, res) => {
  try {
    const { coin, invested } = req.body || {};
    if (!coin || typeof coin !== 'string') {
      throw new IndmError('`coin` (string) is required — e.g. "BTC"', 400, 'BAD_REQUEST');
    }
    const num = Number(invested);
    if (invested == null || !Number.isFinite(num) || num < 0) {
      throw new IndmError('`invested` (number ≥ 0) is required — the app\'s invested amount for this coin', 400, 'BAD_REQUEST');
    }
    const basis = setManualBasis(coin, num > 0 ? num : null);
    // Refresh rows immediately (coindcx-only quick sync).
    try { await syncNow({ force: true, reason: 'manual', sources: ['coindcx'] }); } catch { /* non-fatal */ }
    return res.json({ ok: true, basis, ...coindcxStatus() });
  } catch (err) { return fail(res, err); }
});

router.post('/api/mcp/coindcx/basis/clear', async (req, res) => {
  try {
    const coin = req.body?.coin;
    if (coin != null && typeof coin !== 'string') {
      throw new IndmError('`coin` must be a string when provided', 400, 'BAD_REQUEST');
    }
    const basis = clearManualBasis(coin || undefined);
    try { await syncNow({ force: true, reason: 'manual', sources: ['coindcx'] }); } catch { /* non-fatal */ }
    return res.json({ ok: true, basis, ...coindcxStatus() });
  } catch (err) { return fail(res, err); }
});

// ------------------------------------------------------------
// APP SETTINGS (v6.1) — server-side, durable-backed user
// calibrations so they survive multi-device logins, cookie/cache
// wipes, and Render restarts. Currently known key:
//   usdAppRate — INDMoney's internal USD-INR rate implied by the
//   app's USD Invested ("Match App", 🦅 USA card). null = live FX.
// The store is encrypted before it hits the GitHub durable backup,
// exactly like the MCP credentials.
// ------------------------------------------------------------
router.get('/api/mcp/settings', (_req, res) => {
  try {
    return res.json({ ok: true, settings: getSettings(), durable: durableStatus() });
  } catch (err) { return fail(res, err); }
});

router.post('/api/mcp/settings', (req, res) => {
  try {
    const { key, value } = req.body || {};
    if (!key || typeof key !== 'string') {
      throw new IndmError('`key` (string) is required — e.g. "usdAppRate"', 400, 'BAD_REQUEST');
    }
    // null / missing value CLEARS the setting (reset-to-live-FX etc.).
    const settings = setSetting(key, value == null ? null : value);
    return res.json({ ok: true, settings, durable: durableStatus() });
  } catch (err) { return fail(res, err); }
});

// ------------------------------------------------------------
// POST /call — generic MCP tool invocation (debug/power use).
// Body: { tool: string, args?: object }
// ------------------------------------------------------------
router.post('/api/mcp/indmoney/call', async (req, res) => {
  try {
    if (rateLimited('call')) throw new IndmError('Too many requests — try again shortly', 429, 'RATE_LIMITED');
    const { tool, args } = req.body || {};
    if (!tool || typeof tool !== 'string') {
      throw new IndmError('`tool` (string) is required', 400, 'BAD_REQUEST');
    }
    const safeArgs = (args && typeof args === 'object' && !Array.isArray(args)) ? args : {};
    const result = await callTool(tool, safeArgs);
    return res.json({ ok: true, tool, payload: extractToolPayload(result) ?? result });
  } catch (err) { return fail(res, err); }
});

// ------------------------------------------------------------
// TAPETIDE — India stock-research MCP (OAuth account login =
// the "API key"). v4.7. Same flow shape as INDMoney above.
// ------------------------------------------------------------
router.get('/api/mcp/tapetide/status', (_req, res) => {
  try {
    res.json({ ok: true, ...tapetide.getStatus(), durable: durableStatus() });
  } catch (err) { return fail(res, err); }
});

router.get('/api/mcp/tapetide/connect', async (req, res) => {
  try {
    const origin = requestOrigin(req);
    if (!origin) throw new IndmError('Could not determine site origin', 400, 'NO_ORIGIN');
    const { authorizeUrl } = await tapetide.startConnect(origin);
    return res.redirect(302, authorizeUrl);
  } catch (err) { return fail(res, err); }
});

// Callback: top-level navigation → session cookie auths it (same
// as INDMoney callback). Redirects back to the INTRADAY tab (the
// Tapetide research desk lives there).
router.get('/api/mcp/tapetide/callback', async (req, res) => {
  const { code, state, error, error_description: errDesc } = req.query;
  let origin = requestOrigin(req);
  try {
    const saved = typeof state === 'string' ? tapetide.getPendingOrigin(state) : null;
    if (saved) origin = saved;
    if (!origin) throw new IndmError('Missing site origin for redirect', 400, 'NO_ORIGIN');
    await tapetide.completeConnect({ code, state, error, errorDescription: errDesc });
    // v20.9.3 FIX (L): 'trading' tab legacy-map ho ke india desk pe jata tha
    // bina kisi connect feedback ke — explicit tab + readable param.
    return res.redirect(302, `${origin}/?tab=india&tpt=ok`);
  } catch (err) {
    const reason = encodeURIComponent(String(err?.message || err?.code || 'unknown_error'));
    const base = origin || '';
    return res.redirect(302, `${base}/?tab=india&tpt=error&reason=${reason}`);
  }
});

router.post('/api/mcp/tapetide/disconnect', async (_req, res) => {
  try {
    const out = await tapetide.disconnect();
    return res.json(out);
  } catch (err) { return fail(res, err); }
});

// GET /tools — the connected account's tool surface, bucketed
// into a catalog (analysis / quotes / screener / fundamentals / …).
router.get('/api/mcp/tapetide/tools', async (req, res) => {
  try {
    if (rateLimited('tapetide-tools')) throw new IndmError('Too many requests — try again shortly', 429, 'RATE_LIMITED');
    const force = req.query.force === '1' || req.query.force === 'true';
    const { tools, cached } = await tapetide.listTools({ force });
    const catalog = tapetide.buildCatalog(tools);
    return res.json({
      ok: true, cached,
      count: (tools || []).length,
      catalog: catalog.map(cat => ({
        key: cat.key, label: cat.label, count: cat.tools.length,
        tools: cat.tools.map(t => ({
          name: t.name,
          description: t.description || null,
          inputSchema: t.inputSchema ? { type: t.inputSchema.type, properties: Object.keys(t.inputSchema.properties || {}) } : null,
        })),
      })),
    });
  } catch (err) { return fail(res, err); }
});

// POST /call — generic MCP tool invocation (research desk).
// Body: { tool: string, args?: object }
router.post('/api/mcp/tapetide/call', async (req, res) => {
  try {
    if (rateLimited('tapetide-call')) throw new IndmError('Too many requests — try again shortly', 429, 'RATE_LIMITED');
    const { tool, args } = req.body || {};
    if (!tool || typeof tool !== 'string') {
      throw new IndmError('`tool` (string) is required', 400, 'BAD_REQUEST');
    }
    const safeArgs = (args && typeof args === 'object' && !Array.isArray(args)) ? args : {};
    const result = await tapetide.callTool(tool, safeArgs);
    return res.json({ ok: true, tool, payload: tapetide.extractToolPayload(result) ?? result });
  } catch (err) { return fail(res, err); }
});

export default router;
