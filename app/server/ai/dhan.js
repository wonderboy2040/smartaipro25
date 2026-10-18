// ============================================================
// server/ai/dhan.js — DHAN HQ v2 BROKER CONNECTOR (India, NSE equity)
// ------------------------------------------------------------
// v6.5 — India desk LIVE execution venue (the India twin of
// ../mcp/coindcx.js for credentials + transport). Dhan is chosen
// over Zerodha Kite deliberately: Kite's request-token session
// expires DAILY and needs an interactive OAuth re-login, while
// Dhan's access-token is long-lived — the only sane choice for an
// automated, signal-gated execution flow.
//
//   • creds: mcp-dhan.json { clientId, accessToken } (store.js +
//     encrypted durable backup — same pipeline as CoinDCX keys)
//   • instrument master: Dhan's public scrip CSV → NSE-equity
//     tradingSymbol → securityId map, cached to dhan-scrips.json
//     (24h refresh, in-flight dedupe, honest null on failure)
//   • transport: dhanPrivate() POST/GET with access-token +
//     client-id headers; NEVER trusts a client-supplied price
//
// Nothing here decides WHEN to trade — indiaOrders.js owns the
// gauntlet. This file only knows HOW to talk to Dhan.
// ============================================================
import { loadJSON, saveJSON } from '../lib/store.js';
import { durablePut } from '../mcp/durable.js';

const CREDS_FILE = 'mcp-dhan.json';
const SCRIPS_FILE = 'dhan-scrips.json';
const SCRIP_URL = 'https://images.dhan.co/api-data/api-scrip-master.csv';
const BASE = 'https://api.dhan.co/v2';
const SCRIP_TTL_MS = 24 * 3600_000;

const r2 = (v) => (Number.isFinite(v) ? Math.round(v * 100) / 100 : null);

// ---------------- credentials ----------------
export function dhanCreds() {
  return loadJSON(CREDS_FILE, null);
}
export function dhanConnected() {
  const c = dhanCreds();
  return !!(c && c.clientId && c.accessToken);
}
export function dhanConnect(clientId, accessToken) {
  const id = String(clientId || '').trim();
  const tok = String(accessToken || '').trim();
  if (!/^\d{4,12}$/.test(id)) {
    throw Object.assign(new Error('Dhan Client ID must be 4-12 digits (find it in the Dhan app → Profile)'), { status: 400 });
  }
  if (!tok || tok.length < 20 || /\s/.test(tok)) {
    throw Object.assign(new Error('Dhan Access Token looks invalid (expected a long token from Dhan HQ web → Access Token generator)'), { status: 400 });
  }
  const creds = { clientId: id, accessToken: tok, connectedAt: Date.now() };
  saveJSON(CREDS_FILE, creds);
  try { durablePut(CREDS_FILE, creds); } catch { /* best-effort */ }
  return creds;
}
export function dhanDisconnect() {
  saveJSON(CREDS_FILE, null);
  try { durablePut(CREDS_FILE, null); } catch { /* best-effort */ }
}

// ---------------- transport ----------------
/**
 * Signed-ish request: Dhan auth = static headers (access-token +
 * client-id). method/body optional. Returns parsed JSON or throws
 * with the Dhan error message surfaced (apiKey NEVER in the text).
 */
export async function dhanPrivate(path, { method = 'POST', body } = {}) {
  const c = dhanCreds();
  if (!c?.clientId || !c?.accessToken) throw new Error('Dhan not connected');
  const r = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'client-id': c.clientId,
      'access-token': c.accessToken,
    },
    body: method === 'GET' ? undefined : JSON.stringify(body ?? {}),
    signal: AbortSignal.timeout(12_000),
  });
  let j = null;
  try { j = await r.json(); } catch { /* non-JSON error body */ }
  if (!r.ok) {
    const msg = j?.errorMessage || j?.message || j?.error || `Dhan API ${r.status}`;
    throw Object.assign(new Error(String(msg).slice(0, 200)), { status: r.status });
  }
  return j;
}

// ---------------- instrument master ----------------
/** CSV → securityId map. Exported for tests (pure). */
export function parseScripCsv(text) {
  const map = {};
  if (!text || typeof text !== 'string') return map;
  const lines = text.split('\n');
  if (lines.length < 2) return map;
  const header = lines[0].split(',').map(h => h.trim().toUpperCase());
  const col = (name) => header.indexOf(name);
  const iSym = col('SEM_TRADING_SYMBOL');
  const iId = col('SEM_SCRIP_ID');
  const iExch = col('SEM_EXM_EXCH_ID');
  const iSeg = col('SEM_SEGMENT');
  const iInstr = col('SEM_INSTRUMENT_NAME');
  const iLot = col('SEM_LOT_UNITS');
  const iTick = col('SEM_TICK_SIZE');
  if (iSym < 0 || iId < 0) return map;
  for (let k = 1; k < lines.length; k++) {
    const line = lines[k];
    if (!line) continue;
    const f = line.split(',');
    const symbol = (f[iSym] || '').trim().toUpperCase();
    const id = (f[iId] || '').trim();
    if (!symbol || !id || map[symbol]) continue;
    // NSE cash segment equity only: exchange NSE, segment E (equity),
    // instrument EQUITY (case-tolerant — Dhan has used both cases).
    const exch = (f[iExch] || '').trim().toUpperCase();
    const seg = (f[iSeg] || '').trim().toUpperCase();
    const instr = (f[iInstr] || '').trim().toUpperCase();
    if (exch !== 'NSE') continue;
    if (seg !== 'E' && seg !== 'EQ') continue;
    if (instr && instr !== 'EQUITY') continue;
    const lot = Number(f[iLot]);
    const tick = Number(f[iTick]);
    map[symbol] = {
      securityId: id,
      lotUnits: Number.isFinite(lot) && lot > 0 ? lot : 1,
      tickSize: Number.isFinite(tick) && tick > 0 ? tick : 0.05,
    };
  }
  return map;
}

let _scripInflight = null;
async function loadScripMap(force = false) {
  const cached = loadJSON(SCRIPS_FILE, null);
  const fresh = cached && Number.isFinite(cached.updatedAt) && Date.now() - cached.updatedAt < SCRIP_TTL_MS
    && cached.map && Object.keys(cached.map).length > 1000;
  if (!force && fresh) return cached.map;
  if (_scripInflight) return _scripInflight;
  _scripInflight = (async () => {
    try {
      const r = await fetch(SCRIP_URL, { signal: AbortSignal.timeout(30_000) });
      if (!r.ok) throw new Error(`scrip master HTTP ${r.status}`);
      const text = await r.text();
      const map = parseScripCsv(text);
      if (Object.keys(map).length > 1000) {
        const store = { updatedAt: Date.now(), map };
        saveJSON(SCRIPS_FILE, store);
        return map;
      }
      throw new Error('scrip master parsed too small');
    } catch (e) {
      // stale cache beats no cache (symbols rarely change ids)
      if (cached?.map && Object.keys(cached.map).length > 1000) return cached.map;
      throw e;
    } finally {
      _scripInflight = null;
    }
  })();
  return _scripInflight;
}

/** tradingSymbol → { securityId, lotUnits, tickSize } | null */
export async function resolveDhanSymbol(symbol) {
  const sym = String(symbol || '').trim().toUpperCase();
  if (!sym) return null;
  try {
    const map = await loadScripMap();
    return map[sym] || null;
  } catch {
    return null;
  }
}
export async function scripMasterStatus() {
  const cached = loadJSON(SCRIPS_FILE, null);
  return {
    cached: !!(cached?.map && Object.keys(cached.map).length > 1000),
    symbols: cached?.map ? Object.keys(cached.map).length : 0,
    updatedAt: cached?.updatedAt || null,
  };
}

// ---------------- order placement ----------------
/**
 * Place an intraday NSE equity order.
 * kind: 'ENTRY' (MARKET) | 'SL' (STOP_LOSS_MARKET with triggerPrice)
 */
export async function dhanPlaceOrder({ symbol, side, quantity, kind = 'ENTRY', triggerPrice = null }) {
  const meta = await resolveDhanSymbol(symbol);
  if (!meta) {
    throw Object.assign(new Error(`Dhan securityId not found for ${symbol} (scrip master unavailable or symbol not NSE-equity)`), { status: 400 });
  }
  const qty = Math.floor(Number(quantity));
  if (!(qty >= 1)) throw Object.assign(new Error('quantity must be ≥ 1 share'), { status: 400 });
  const buy = String(side).toUpperCase() !== 'SELL';
  const body = {
    transactionType: kind === 'SL' ? (buy ? 'SELL' : 'BUY') : buy ? 'BUY' : 'SELL', // SL order is the protective EXIT side
    exchangeSegment: 'NSE_EQ',
    productType: 'INTRADAY',
    orderType: kind === 'SL' ? 'STOP_LOSS_MARKET' : 'MARKET',
    tradingSymbol: String(symbol).toUpperCase(),
    securityId: String(meta.securityId),
    quantity: qty,
    validity: 'DAY',
  };
  if (kind === 'SL') {
    const tp = Number(triggerPrice);
    if (!(tp > 0)) throw Object.assign(new Error('SL order needs a positive triggerPrice'), { status: 400 });
    body.triggerPrice = r2(tp);
  }
  const resp = await dhanPrivate('/orders', { method: 'POST', body });
  const orderId = resp?.orderId || null;
  const orderStatus = resp?.orderStatus || (orderId ? 'TRANSIT' : 'UNKNOWN');
  return { orderId, orderStatus, securityId: meta.securityId, lotUnits: meta.lotUnits, tickSize: meta.tickSize };
}

/** Day positions (for reconciliation). */
export async function dhanPositions() {
  return dhanPrivate('/positions', { method: 'POST', body: {} });
}

/** Order book entry for one id. */
export async function dhanOrderStatus(orderId) {
  return dhanPrivate(`/orders/${encodeURIComponent(String(orderId))}`, { method: 'GET' });
}

/** Cancel one open order (best-effort — used when the site closes a
 *  position at TP2/time and the protective broker SL must not linger). */
export async function dhanCancelOrder(orderId) {
  try {
    await dhanPrivate(`/orders/${encodeURIComponent(String(orderId))}`, { method: 'DELETE' });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e?.message || e).slice(0, 150) };
  }
}

/** Profile ping — validates the creds without placing anything. */
export async function dhanProfile() {
  const p = await dhanPrivate('/profile', { method: 'GET' });
  return { name: p?.name || null, clientId: p?.clientId || p?.dhanClientId || null, raw: 'ok' };
}

// ---------------- test hooks ----------------
export function __resetDhanForTests() {
  saveJSON(CREDS_FILE, null);
}
export function __setDhanForTests(clientId, accessToken) {
  saveJSON(CREDS_FILE, { clientId, accessToken, connectedAt: Date.now() });
}
export function __setScripsForTests(map, updatedAt = Date.now()) {
  saveJSON(SCRIPS_FILE, { updatedAt, map: map || {} });
}
