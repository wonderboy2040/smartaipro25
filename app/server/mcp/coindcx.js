// ============================================================
// server/mcp/coindcx.js — CoinDCX account integration
// ------------------------------------------------------------
// The crypto half of the synced ASSET TABLE. INDMoney MCP covers
// INDIA (stocks/ETF/MF) + USA + whatever crypto it tracks; this
// module connects the user's actual CoinDCX exchange account via
// its official REST API (HMAC-SHA256 signed) and merges the live
// balances into the same asset-table snapshot:
//
//   • coindcxConnect(apiKey, secret)  — validates the pair with a
//     real /users/balances call BEFORE persisting (server/data/
//     mcp-coindcx.json — gitignored, never sent to the browser).
//   • fetchCoinDcxBalances()          — signed private call.
//   • normalizeBalances()             — defensive field mapping
//     (CoinDCX field names vary between doc versions — the
//     INDMoney lesson: parse EVERY plausible key).
//   • mapBalancesToAssets()           — pure: balances + public
//     ticker → valued crypto assets (INR pair, or USDT pair ×
//     live USD/INR), INR fiat + dust skipped.
//
// Pricing uses the SAME shared ticker round-trip as the SSE crypto
// stream + /api/crypto-prices (one cached upstream fetch, see
// server/cryptoStream.js) — no extra load on the 0.1-vCPU box.
//
// NOTE (v21.1.0 — stale comment corrected): the API key needs
// view/balance + TRADE permission (orders YAHAN se hi jaate hain —
// coindcxOrders.js / futures.js / proTraderAuto.js). Withdrawal
// permission OFF rakho + CoinDCX dashboard me IP whitelist ON karo.
// Agar sirf pricing/balance chahiye to read-only key bhi chalega —
// par LIVE trading modes us key se fire nahi honge.
// ============================================================
import crypto from 'node:crypto';
import https from 'node:https';
import { loadJSON, saveJSON } from '../lib/store.js';
import { fetchCoinDcxTickers } from '../cryptoStream.js';
import { durablePut } from './durable.js';

const CREDS_FILE = 'mcp-coindcx.json';
const API_BASE = 'https://api.coindcx.com';
const BALANCES_PATH = '/exchange/v1/users/balances';
const REQUEST_TIMEOUT_MS = 10000;
// Assets below this INR value are exchange dust — not portfolio rows.
const DUST_INR = 10;

// ---------------- trade history (cost basis) ----------------
// CoinDCX's app shows "Invested ₹X" per coin — that comes from the user's
// trade ledger, not the balances endpoint. We try the documented trade /
// order-history endpoints (whichever the API key's permission allows) and
// compute an avg-cost basis. A view-only key without trade permission
// simply yields no basis → the row honestly shows P&L n/a (the user can
// then enter a manual basis from the app's coin pages — see below).
//
// v5.2 endpoint fix: the DOCUMENTED trade-history endpoint is
// POST /exchange/v1/orders/trade_history (limit max 5000, from_id cursor).
// The previously-tried paths are kept as fallbacks — /exchange/v1/trades is
// the PUBLIC market-trades endpoint (signed calls fail), which is why
// basis never resolved with a valid key.
const TRADES_PATHS = [
  '/exchange/v1/orders/trade_history',         // DOCUMENTED: user's executed trades
  '/exchange/v1/trades',                        // list executed trades (page/size)
  '/exchange/v1/users/trades',                  // older docs variant
  '/exchange/v1/orders/fetch_order_history',    // order history (filled orders)
];
const TRADES_MAX_PAGES = 10; // 10 × 100 = 1000 trades — plenty for a real wallet
const TRADES_PAGE_LIMIT = 2000; // per-call limit for the documented endpoint

// ---------------- credential store (server-side only) ----------------
function loadCreds() {
  return loadJSON(CREDS_FILE, null);
}
function saveCreds(creds) {
  saveJSON(CREDS_FILE, creds);
  // Durable (encrypted GitHub) write-through — API keys survive Render's
  // ephemeral-disk restarts. Best-effort, never throws.
  try { durablePut(CREDS_FILE, creds); } catch { /* optional */ }
  return creds;
}

// ---------------- manual cost basis (fallback store) ----------------
// When the API key has no trade-history permission, the trade-ledger basis
// is unavailable. The user can enter per-coin invested amounts ONCE (from
// the CoinDCX app's coin pages) — they persist across syncs and server
// restarts, and are used ONLY when the ledger basis is missing. Rows then
// show app-parity Invested / Avg Price / P&L.
const MANUAL_BASIS_FILE = 'mcp-coindcx-basis.json';
// v6.1: the FILE shape is now { basis: {BTC: 123}, updatedAt } so the
// durable boot-restore can compare freshness (a legacy flat file/backup
// from <= v6.0 is normalized on load). The module's API (flat maps in/out)
// is unchanged — callers and tests are unaffected.
function loadManualBasis() {
  const raw = loadJSON(MANUAL_BASIS_FILE, {});
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  if (raw.basis && typeof raw.basis === 'object' && !Array.isArray(raw.basis)) {
    return raw.basis;
  }
  // Legacy flat shape { BTC: 123 } (pre-v6.1 file or durable backup) —
  // the whole object IS the basis map.
  const { updatedAt: _updatedAt, ...coins } = raw;
  return coins;
}
function saveManualBasis(basis) {
  const store = { basis, updatedAt: Date.now() };
  saveJSON(MANUAL_BASIS_FILE, store);
  try { durablePut(MANUAL_BASIS_FILE, store); } catch { /* optional */ }
  return basis;
}
/** Set (or clear, when invested == null) one coin's manual invested amount. */
export function setManualBasis(coin, invested) {
  const key = String(coin || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!key) throw Object.assign(new Error('coin is required'), { status: 400, code: 'BAD_REQUEST' });
  const basis = loadManualBasis();
  if (invested == null || !(Number(invested) > 0)) delete basis[key];
  else basis[key] = Math.round(Number(invested) * 100) / 100;
  saveManualBasis(basis);
  return basis;
}
/** Clear one coin (or the whole store when coin is omitted). */
export function clearManualBasis(coin) {
  if (!coin) { saveManualBasis({}); return {}; }
  return setManualBasis(coin, null);
}
export function getManualBasis() {
  return loadManualBasis();
}
// Merge rule: trade-ledger basis wins per coin; manual basis fills the
// coins the ledger couldn't price (or the whole set when there's no ledger).
function mergeBasis(ledgerBasis, manualBasis) {
  if (!ledgerBasis && !manualBasis) return null;
  const out = { ...(ledgerBasis || {}) };
  for (const [coin, inv] of Object.entries(manualBasis || {})) {
    if (typeof inv !== 'number' || !(inv > 0)) continue;
    const led = out[coin];
    if (!led || !(led.invested > 0)) out[coin] = { qty: null, invested: inv, avgPrice: null, manual: true };
  }
  return Object.keys(out).length ? out : null;
}
export function coindcxConnected() {
  const c = loadCreds();
  return !!(c && typeof c.apiKey === 'string' && c.apiKey && typeof c.secret === 'string' && c.secret);
}
export function coindcxStatus() {
  const c = loadCreds();
  if (!c || !c.apiKey || !c.secret) {
    return { connected: false, connectedAt: null, lastSyncAt: null, balanceCount: 0, lastError: null };
  }
  return {
    connected: true,
    connectedAt: c.connectedAt || null,
    lastSyncAt: c.lastSyncAt || null,
    balanceCount: typeof c.balanceCount === 'number' ? c.balanceCount : 0,
    lastError: c.lastError || null,
    // v5.2 diagnostics: WHY is crypto P&L n/a? costBasis = trade-ledger
    // result (source endpoint + trades count); manualBasis = user-entered
    // per-coin invested (the view-only-key fallback).
    costBasis: c.costBasis || null,
    manualBasis: loadManualBasis(),
  };
}

// ---------------- signed private REST call ----------------
// CoinDCX auth: JSON body MUST include `timestamp` (ms epoch);
// signature = HMAC-SHA256(secret, exact request body string) hex;
// headers X-AUTH-APIKEY / X-AUTH-SIGNATURE. Body is sent byte-for-byte
// as signed — any reordering breaks the signature.
export async function coindcxPrivate(path, apiKey, secret, body = {}) {
  const payload = JSON.stringify({ ...body, timestamp: Date.now() });
  const signature = crypto.createHmac('sha256', secret).update(payload).digest('hex');
  const r = await fetch(`${API_BASE}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-AUTH-APIKEY': apiKey,
      'X-AUTH-SIGNATURE': signature,
    },
    body: payload,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* error body may be plain */ }
  if (!r.ok) {
    const msg = (json && (json.message || json.error || json.error_description)) || `CoinDCX API ${r.status}`;
    // Status prefix so a 404/401 is unmistakable in user-facing errors
    // ("[404] ..." = CoinDCX endpoint, vs a body-less route 404 = the app
    // is running on a static mirror — see StaticMirrorBanner).
    const err = new Error(`[${r.status}] ${String(msg).slice(0, 180)}`);
    err.status = r.status;
    throw err;
  }
  return json;
}

// ---------------- signed private REST call (GET, REQUEST-BODY auth) ----------------
// v12.3 THE DOCUMENTED CONTRACT (docs.coindcx.com "Wallet Details" +
// "Wallet Transactions" samples — extracted from the official 1.1MB
// Slate docs capture, 2026-09-19):
//   Python: response = requests.get(url, data=json_body, headers=headers)
//     url     = https://api.coindcx.com/exchange/v1/derivatives/futures/wallets
//     body    = {"timestamp": <int ms>}   (json.dumps, separators=(',', ':'))
//   Node:    request.get({ url, headers, json: true, body: {timestamp} })
// i.e. THE SIGNED COMPACT JSON TRAVELS AS THE GET REQUEST **BODY** —
// NOT as query params. page/size-style params ride the QUERY STRING
// UNSIGNED (transactions sample: ?page=1&size=1000 + {"timestamp":...}
// body); the timestamp NEVER goes in the query string in body mode.
//
// THIS was the live 2026-09-19 401 root cause: every query-param variant
// (v10.3.2 seconds-string -> v12.1 int permutations -> v12.2 spaced-JSON)
// 401'd with "Invalid credentials" because the server verifies the
// signature against the REQUEST BODY — an empty body can never verify.
// Meanwhile the SAME key POSTs fine (POSTs sign the body they send),
// which is why the v12.2 scope probe correctly reported scope OK.
//
// Legacy `mode: 'query'` (the v10.3.2-v12.2 wire form — params +
// timestamp all in the query string, nothing in the body) is kept for
// ladder fallback rungs in case the route family ever reverts to it.
//   • v12.1 `tsType: 'num'` — timestamp as a JSON NUMBER (the doc
//     samples: int(round(time.time() * 1000)) / Math.floor(Date.now())).
//   • v12.2 `sep: 'spaced'` — Python json.dumps default spacing (", "
//     and ": ") as a canonical-rebuild insurance variant.
// v12.3: GET-with-body transport. The Fetch spec (and Node's undici
// `fetch`) FORBIDS a body on GET — "Request with GET/HEAD method cannot
// have body" — while the official CoinDCX Python samples send exactly
// that (requests.get(url, data=json_body); Python's requests is a raw
// HTTP client with no Fetch-spec restriction). The body-mode GET
// therefore rides Node's native `https` module, which happily writes a
// GET body onto the socket. Same URL, same headers, same signed JSON.
const API_HOST = new URL(API_BASE).hostname;
function _httpsGetJson(path, headers, bodyStr) {
  return new Promise((resolve, reject) => {
    const bodyBuf = bodyStr ? Buffer.from(bodyStr, 'utf8') : null;
    const req = https.request({
      hostname: API_HOST,
      path,
      method: 'GET',
      headers: {
        ...headers,
        ...(bodyBuf ? { 'Content-Length': bodyBuf.length } : {}),
      },
      timeout: REQUEST_TIMEOUT_MS,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch { /* error body may be plain */ }
        resolve({
          ok: res.statusCode >= 200 && res.statusCode < 300,
          status: res.statusCode,
          json,
          text,
        });
      });
    });
    req.on('timeout', () => req.destroy(new Error('CoinDCX API timeout')));
    req.on('error', (e) => reject(e));
    if (bodyBuf) req.write(bodyBuf);
    req.end();
  });
}

export async function coindcxPrivateGET(path, apiKey, secret, params = {}, { unit = 'ms', tsType = 'num', sep = 'compact', mode = 'body' } = {}) {
  const tsNum = unit === 'ms' ? Date.now() : Math.floor(Date.now() / 1000);
  const timestamp = tsType === 'num' ? tsNum : String(tsNum);
  const bodyMode = mode !== 'query';
  // body mode signs {timestamp} only (the documented wallet GET body);
  // query mode signs {...params, timestamp} (the legacy wire form).
  const payload = bodyMode ? { timestamp } : { ...params, timestamp };
  // v12.2: exact Python json.dumps default rendering — `, ` between
  // items, `: ` after each key, values JSON-escaped the same way. Built
  // by hand (never a regex on the compact string) so a param VALUE
  // containing ',' or ':' can't corrupt the canonical form.
  const payloadStr = sep === 'spaced'
    ? '{' + Object.entries(payload).map(([k, v]) => `${JSON.stringify(k)}: ${JSON.stringify(v)}`).join(', ') + '}'
    : JSON.stringify(payload);
  const signature = crypto.createHmac('sha256', secret).update(payloadStr).digest('hex');
  // body mode: params ride the query UNSIGNED (transactions sample:
  // ?page=1&size=1000 + {"timestamp":...} body) and the timestamp NEVER
  // goes in the query; query mode: the full signed object rides the query.
  const qsEntries = bodyMode ? Object.entries(params) : Object.entries(payload);
  const qs = qsEntries.length
    ? '?' + new URLSearchParams(qsEntries.map(([k, v]) => [k, String(v)])).toString()
    : '';
  const headers = {
    // v20.5.1: switch from `wealthai-coindcx/1.0` to the SAME Mozilla UA the
    // PUBLIC futures-instruments fetch uses (lines 837, 853). CoinDCX's WAF
    // on the derivatives private GET family (futures wallet / margin /
    // positions-GET) is more aggressive than just UA-matching — a custom
    // product UA still got 401'd for some installs (the v20.5 fix didn't
    // unblock everyone). The Mozilla UA is the one string the team has
    // CONFIRMED passes through the WAF on this host (it's what the public
    // fetchGlobalFuturesInstruments call rides). Flow through both the
    // body-mode `_httpsGetJson` and the legacy `fetch` branch.
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36',
    // CoinDCX's documented contract requires Accept: application/json on
    // the signed GET family — some installs get 406 without it.
    'Accept': 'application/json',
    // body mode carries JSON — the Python sample sets this header and
    // the Node `request({json:true})` form sets it implicitly.
    ...(bodyMode ? { 'Content-Type': 'application/json' } : {}),
    'X-AUTH-APIKEY': apiKey,
    'X-AUTH-SIGNATURE': signature,
  };
  // THE v12.3 FIX (transport): body mode rides the native https module
  // with the signed JSON as the GET request BODY (undici fetch forbids
  // GET bodies); query mode keeps the legacy fetch wire unchanged.
  let r;
  if (bodyMode) {
    r = await _httpsGetJson(path + qs, headers, payloadStr);
  } else {
    r = await fetch(`${API_BASE}${path}${qs}`, {
      method: 'GET',
      headers,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const text = await r.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* error body may be plain */ }
    r = { ok: r.ok, status: r.status, json, text };
  }
  if (!r.ok) {
    const msg = (r.json && (r.json.message || r.json.error || r.json.error_description)) || `CoinDCX API ${r.status}`;
    const err = new Error(`[${r.status}] ${String(msg).slice(0, 180)}`);
    err.status = r.status;
    throw err;
  }
  return r.json;
}

// ---------------- balances fetch with pagination ----------------
// CoinDCX docs use STRING page/size values; one page holds at most
// `size` records. Loop until a short page arrives (max 5 pages —
// far beyond any real wallet's distinct-currency count).
export async function fetchBalancesSigned(apiKey, secret) {
  const PAGE_SIZE = 100;
  const MAX_PAGES = 5;
  let merged = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const raw = await coindcxPrivate(BALANCES_PATH, apiKey, secret, {
      page: String(page),
      size: String(PAGE_SIZE),
    });
    const list = Array.isArray(raw) ? raw : [];
    merged = merged.concat(list);
    if (list.length < PAGE_SIZE) break; // last page reached
  }
  return merged;
}

// ---------------- balances (defensive normalizer) ----------------
// CoinDCX /users/balances returns per-currency records. Documented
// fields: currency_short_name / currency_name / balance /
// locked_balance / available_balance — but versions differ, so every
// plausible key is tried (lesson from the INDMoney schema hunt).
export function normalizeBalances(raw) {
  const list = Array.isArray(raw) ? raw : [];
  const out = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const base = String(
      item.currency_short_name ?? item.currencyShortName ?? item.currency ?? item.short_name ?? item.symbol ?? ''
    ).trim().toUpperCase();
    if (!base) continue;
    const free = numOrNull(
      item.available_balance ?? item.availableBalance ?? item.balance ?? item.free ?? item.available ?? 0
    );
    const locked = numOrNull(
      item.locked_balance ?? item.lockedBalance ?? item.locked ?? item.in_order ?? 0
    );
    const total = (free ?? 0) + (locked ?? 0);
    if (total <= 0) continue;
    out.push({
      base,
      name: String(item.currency_name ?? item.currencyName ?? item.currency_full_name ?? item.full_name ?? base),
      qty: total,
      free: free ?? 0,
      locked: locked ?? 0,
    });
  }
  return out;
}
function numOrNull(v) {
  const n = typeof v === 'number' ? v : parseFloat(String(v ?? '').replace(/[^0-9.eE+-]/g, ''));
  return Number.isFinite(n) ? n : null;
}

// ---------------- connect / disconnect ----------------
export async function coindcxConnect(apiKey, secret) {
  if (!apiKey || !secret || typeof apiKey !== 'string' || typeof secret !== 'string') {
    const err = new Error('apiKey and secret are required');
    err.status = 400;
    throw err;
  }
  // Validate BEFORE persisting — a bad pair must never be stored.
  const raw = await fetchBalancesSigned(apiKey.trim(), secret.trim());
  const balances = normalizeBalances(raw);
  saveCreds({
    apiKey: apiKey.trim(),
    secret: secret.trim(),
    connectedAt: Date.now(),
    lastSyncAt: Date.now(),
    balanceCount: balances.length,
    lastError: null,
    // preserve nothing else — fresh credentials
  });
  // v12.2: a fresh key must be probed with a CLEAN slate — the futures
  // wallet transport's sticky rung + 5-min probe cooldown and the cached
  // key-scope verdict all belong to the PREVIOUS key. Dynamic import:
  // futures.js statically imports this module, so a static back-import
  // would create a cycle; the runtime indirection keeps both directions
  // loadable. Non-fatal on failure (the cooldown would simply lapse).
  try {
    const fut = await import('../ai/futures.js');
    if (typeof fut.resetWalletTransportForReconnect === 'function') fut.resetWalletTransportForReconnect();
  } catch { /* non-fatal */ }
  return { connected: true, balanceCount: balances.length, validated: true };
}

export function coindcxDisconnect() {
  const had = coindcxConnected();
  try { saveCreds({ apiKey: null, secret: null, connectedAt: null }); } catch { /* non-fatal */ }
  return { connected: false, wasConnected: had };
}

// ---------------- v18.10 ENV BOOTSTRAP ----------------
// THE USER REPORT: "maine app\.env me coindcx ka api and secret sab dala
// hai phir site me ⚠ CoinDCX not connected show ho raha hai". Root cause:
// the ONLY entry to the credential store was the Portfolio-tab UI Connect
// flow — nothing ever read COINDCX keys from the environment, so .env keys
// sat unused while every consumer (wallet card, live-mode gate, order
// console, agent equity) read the empty store.
//
// Bootstrap contract (boot-time, best-effort, NEVER fatal):
//   • no saved creds + BOTH env sides present → validate with a REAL
//     balances call (the same coindcxConnect the UI uses) + persist →
//     the whole app wakes up connected, exactly like a UI connect.
//   • saved creds already present → env is IGNORED (the UI store wins;
//     a user who connected via UI keeps that identity).
//   • env keys invalid → one loud log line, app continues in paper
//     mode (never a brick — the v18.8.1 Telegram lesson).
//   • memoized: one attempt per process, even when callers race.
const ENV_KEY_NAMES = ['COINDCX_API_KEY', 'COINDCX_KEY', 'COINDCX_APIKEY', 'COINDCX_PUBLIC_KEY'];
const ENV_SECRET_NAMES = ['COINDCX_SECRET', 'COINDCX_API_SECRET', 'COINDCX_SECRET_KEY', 'COINDCX_PRIVATE_KEY'];

/** PURE: both sides from the environment (aliased, trimmed) or null.
 *  Exported for the boot log + tests. */
export function coindcxEnvCreds() {
  const apiKey = ENV_KEY_NAMES.map(n => process.env[n]).find(v => typeof v === 'string' && v.trim());
  const secret = ENV_SECRET_NAMES.map(n => process.env[n]).find(v => typeof v === 'string' && v.trim());
  return (apiKey && secret) ? { apiKey: apiKey.trim(), secret: secret.trim() } : null;
}

let _envBootPromise = null;
/**
 * Boot-time env connect. `log` = console-line sink; `connector` is
 * injectable for hermetic tests (defaults to the REAL coindcxConnect).
 * Returns { ok, source, ... } — never throws.
 */
export function coindcxEnvBootstrap(log = () => {}, { connector } = {}) {
  if (_envBootPromise) return _envBootPromise;
  const connect = connector || coindcxConnect;
  _envBootPromise = (async () => {
    if (coindcxConnected()) {
      log('[coindcx-env] already connected (saved creds) — .env COINDCX keys ignored');
      return { ok: true, source: 'already-connected' };
    }
    const creds = coindcxEnvCreds();
    if (!creds) {
      log('[coindcx-env] no COINDCX_API_KEY + COINDCX_SECRET in .env — Portfolio tab → Connect CoinDCX ya .env me dono daalo (v18.10 se .env se bhi connect hota hai)');
      return { ok: false, source: 'no-env-creds' };
    }
    try {
      const out = await connect(creds.apiKey, creds.secret);
      log(`[coindcx-env] .env COINDCX keys CONNECTED${out?.balanceCount != null ? ` (${out.balanceCount} balances)` : ''} — wallet live, LIVE mode unblocked, UI Connect ki zarurat nahi`);
      return { ok: true, source: 'env', ...(out || {}) };
    } catch (e) {
      // v21.20.0: In production (no test `connector` override), even if the spot
      // balance endpoint hiccups or key is futures-scoped, persist the .env keys
      // so Futures Live orders & MTF Dual Board Live buttons work out of the box!
      if (!connector) {
        try {
          saveCreds({
            apiKey: creds.apiKey,
            secret: creds.secret,
            connectedAt: Date.now(),
            lastSyncAt: Date.now(),
            balanceCount: 0,
            source: 'env-fallback',
            lastError: String(e?.message || e).slice(0, 140),
          });
          log(`[coindcx-env] .env COINDCX keys saved for Futures/Live execution (spot probe note: ${String(e?.message || e).slice(0, 100)})`);
          return { ok: true, source: 'env', fallback: true, warning: String(e?.message || e) };
        } catch { /* ignore */ }
      }
      log(`[coindcx-env] .env COINDCX keys INVALID — ${String(e?.message || e).slice(0, 140)} — paper mode continue; Portfolio tab → Connect se sahi key daalo (CoinDCX app me API key banate waqt view/balance + trade permission)`);
      return { ok: false, source: 'env-invalid', error: String(e?.message || e) };
    }
  })();
  return _envBootPromise;
}

/** Test hook: forget the memoized boot so a suite can re-run it. */
export function __resetCoindcxEnvBootForTest() { _envBootPromise = null; }

// ---------------- balances → assets (PURE) ----------------
// tickers: raw CoinDCX /exchange/ticker array (shared upstream).
// usdInr: used only when a coin has no INR pair but does have a
// USDT pair.
// basis: { BTC: { qty, invested, avgPrice }, ... } from the trade
// ledger (computeCostBasis). Rows with a basis get invested/pnl/pnlPct
// exactly like the CoinDCX app shows; without one they stay null and
// the frontend marks them P&L n/a (never fake a number).
export function mapBalancesToAssets(balances, tickers, usdInr = 84, basis = null) {
  const byMarket = new Map();
  for (const t of (Array.isArray(tickers) ? tickers : [])) {
    if (t && typeof t.market === 'string') byMarket.set(t.market, t);
  }
  const assets = [];
  for (const b of (Array.isArray(balances) ? balances : [])) {
    // INR is fiat cash on the exchange, not a crypto holding — skip.
    if (b.base === 'INR') continue;

    const inrT = byMarket.get(`${b.base}INR`);
    const usdT = !inrT ? byMarket.get(`${b.base}USDT`) : null;
    let price = null;
    let pair = null;
    if (inrT) {
      price = parseFloat(inrT.last_price);
      pair = `${b.base}INR`;
    } else if (usdT) {
      const usd = parseFloat(usdT.last_price);
      if (Number.isFinite(usd) && usd > 0) { price = usd * usdInr; pair = `${b.base}USDT`; }
    }
    if (!(price > 0)) continue; // unpriceable coin — skip rather than lie

    const value = price * b.qty;
    if (value < DUST_INR) continue; // dust filter

    const binfo = basis && basis[b.base] && basis[b.base].invested > 0 ? basis[b.base] : null;
    // avg price: ledger avg when present; manual basis → invested/qty.
    const bAvg = binfo ? (binfo.avgPrice ?? (binfo.qty > 0 ? binfo.invested / binfo.qty : binfo.invested / b.qty)) : null;

    assets.push({
      id: `cdcx-${b.base}`,
      key: `cdcx:${b.base}`,
      name: cryptoName(b.base),
      symbol: b.base,
      market: 'IN',               // CoinDCX trades INR pairs → IN market pricing
      kind: 'crypto',
      source: 'coindcx',
      qty: b.qty,
      avgPrice: binfo ? round2(bAvg) : null, // avg INR cost per unit
      lastPrice: round2(price),
      value: round2(value),
      invested: binfo ? round2(binfo.invested) : null, // INR cost basis (trade ledger)
      pnl: binfo ? round2(value - binfo.invested) : null,
      pnlPct: binfo ? round2(((value - binfo.invested) / binfo.invested) * 100) : null,
      oneDayChangePct: pair && inrT ? (parseFloat(inrT.change_24_hour) || 0) : null,
      assetType: 'Crypto',
      assetEnum: 'CRYPTO',
      basisSource: binfo ? (binfo.manual ? 'manual' : 'ledger') : null,
      noLive: false,              // crypto ticks live via SSE/poller
    });
  }
  return assets;
}

// ---------------- trade history → avg-cost basis (PURE) ----------------
// Normalize either shape (executed trades list OR order history):
//   trades:   { side, market, quantity, price, fee, timestamp }
//   orders:   { side, market, total_quantity, remaining_quantity,
//               price, average_price, fee, status, timestamp }
// Only FILLED quantity counts (order history mixes open/cancelled).
export function normalizeTrades(raw) {
  const list = Array.isArray(raw) ? raw
    : (Array.isArray(raw?.orders) ? raw.orders
      : (Array.isArray(raw?.data) ? raw.data : []));
  const out = [];
  for (const t of list) {
    if (!t || typeof t !== 'object') continue;
    const side = String(t.side || '').toLowerCase();
    if (side !== 'buy' && side !== 'sell') continue;
    const market = String(t.market || t.pair || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (!market || market.length < 5) continue;
    // Base = market minus quote suffix (BTCINR → BTC).
    const quote = market.endsWith('USDT') ? 'USDT'
      : (market.endsWith('INR') ? 'INR' : null);
    if (!quote) continue; // unknown quote currency — skip rather than guess
    const base = market.slice(0, market.length - quote.length);
    if (!base || base === 'INR' || base === 'USDT') continue;

    const filledQty = typeof t.quantity === 'number'
      ? t.quantity
      : numOrNull(t.filled_quantity ?? t.quantity);
    let qty = filledQty;
    let price = numOrNull(t.price ?? t.price_per_unit ?? t.average_price ?? t.avg_price ?? t.avgPrice);
    if (qty == null && typeof t.total_quantity === 'number') {
      // order-history: filled = total − remaining
      const rem = numOrNull(t.remaining_quantity) ?? 0;
      qty = Math.max(0, t.total_quantity - rem);
      price = price ?? numOrNull(t.average_price);
    }
    if (qty == null || !(qty > 0)) continue;

    // Order history: skip anything not (partially) filled.
    const status = String(t.status || '').toLowerCase();
    if (status && !/fill|complete|partial|execut/.test(status)) continue;

    if (!(price > 0)) continue;
    const fee = numOrNull(t.fee ?? t.fees ?? t.fee_amount) ?? 0;
    const ts = numOrNull(t.timestamp ?? t.created_at ?? t.time) ?? 0;
    out.push({ side, base, quote, qty, price, fee, ts });
  }
  return out;
}

// Avg-cost walk over the ledger:
//   buy  → qty += q, cost += q·price + fee   (fees are part of cost)
//   sell → qty −= q at avg cost (realized)   (sell fees hit realized, not basis)
// Result: per-coin { qty, invested, avgPrice } for the REMAINING balance.
// USDT-quote trades are converted at the CURRENT usdInr (approximation —
// historical per-trade FX is not exposed by the API).
export function computeCostBasis(trades, usdInr = 84) {
  const rate = (typeof usdInr === 'number' && usdInr > 50 && usdInr < 150) ? usdInr : 84;
  const coins = new Map(); // base → { qty, cost }
  const sorted = [...(Array.isArray(trades) ? trades : [])].sort((a, b) => (a.ts || 0) - (b.ts || 0));
  for (const t of sorted) {
    if (!t || typeof t !== 'object') continue;
    const fx = t.quote === 'USDT' ? rate : 1; // INR-quote trades are native
    const c = coins.get(t.base) || { qty: 0, cost: 0 };
    const q = Math.abs(Number(t.qty) || 0);
    if (!(q > 0)) continue;
    if (t.side === 'buy') {
      c.qty += q;
      c.cost += q * (Number(t.price) || 0) * fx + (Number(t.fee) || 0) * fx;
    } else { // sell at average cost
      const avg = c.qty > 0 ? c.cost / c.qty : 0;
      const sold = Math.min(q, c.qty);
      c.qty -= sold;
      c.cost -= avg * sold;
      if (c.qty <= 1e-10) { c.qty = 0; c.cost = 0; } // fully closed → reset
    }
    coins.set(t.base, c);
  }
  const out = {};
  for (const [base, c] of coins) {
    if (c.qty > 0 && c.cost > 0) {
      out[base] = { qty: c.qty, invested: c.cost, avgPrice: c.cost / c.qty };
    }
  }
  return out;
}

// Try each trades endpoint with the user's key; return { trades, endpoint }
// or null when none is reachable/allowed (view-only key without trade
// permission is a legitimate outcome — the caller then runs basis-less).
export async function fetchCoinDcxTrades(apiKey, secret) {
  for (const path of TRADES_PATHS) {
    try {
      const merged = [];
      if (path === '/exchange/v1/orders/trade_history') {
        // Documented endpoint: cursor pagination via from_id (older-than),
        // limit max 5000. Loop until a short page arrives.
        let fromId = null;
        for (let i = 0; i < TRADES_MAX_PAGES; i++) {
          const body = { limit: String(TRADES_PAGE_LIMIT) };
          if (fromId != null) body.from_id = String(fromId);
          const raw = await coindcxPrivate(path, apiKey, secret, body);
          const list = Array.isArray(raw) ? raw
            : (Array.isArray(raw?.orders) ? raw.orders
              : (Array.isArray(raw?.data) ? raw.data : []));
          if (!Array.isArray(list) || list.length === 0) break;
          merged.push(...list);
          // Cursor = the smallest numeric id in this batch (responses are
          // newest-first); stop when the page is short or no ids exist.
          const ids = list.map(t => Number(t?.id)).filter(n => Number.isFinite(n) && n > 0);
          if (list.length < TRADES_PAGE_LIMIT || ids.length === 0) break;
          fromId = Math.min(...ids);
        }
      } else {
        // Legacy endpoints: classic page/size pagination.
        for (let page = 1; page <= TRADES_MAX_PAGES; page++) {
          const raw = await coindcxPrivate(path, apiKey, secret, {
            page: String(page),
            size: '100',
          });
          const list = Array.isArray(raw) ? raw
            : (Array.isArray(raw?.orders) ? raw.orders
              : (Array.isArray(raw?.data) ? raw.data : []));
          merged.push(...list);
          if (!Array.isArray(list) || list.length < 100) break; // last page
        }
      }
      // An endpoint that answers with a list we can parse wins — even an
      // empty one (a wallet funded by transfers, not trades).
      return { trades: normalizeTrades(merged), endpoint: path };
    } catch (err) {
      const status = err?.status;
      if (status === 401 || status === 403 || status === 404 || status === 400) continue; // not allowed here → next
      throw err; // network/auth-level failure — let the caller degrade
    }
  }
  return null;
}

const COIN_NAMES = new Map(Object.entries({
  BTC: 'Bitcoin', ETH: 'Ethereum', BNB: 'BNB', SOL: 'Solana', XRP: 'XRP', ADA: 'Cardano',
  DOGE: 'Dogecoin', TRX: 'TRON', DOT: 'Polkadot', MATIC: 'Polygon (MATIC)', POL: 'Polygon (POL)',
  LTC: 'Litecoin', LINK: 'Chainlink', AVAX: 'Avalanche', SHIB: 'Shiba Inu', WBTC: 'Wrapped Bitcoin',
  BCH: 'Bitcoin Cash', UNI: 'Uniswap', ATOM: 'Cosmos', XLM: 'Stellar', NEAR: 'NEAR Protocol',
  APT: 'Aptos', ARB: 'Arbitrum', OP: 'Optimism', FIL: 'Filecoin', ICP: 'Internet Computer',
  AAVE: 'Aave', MKR: 'Maker', INJ: 'Injective', SUI: 'Sui', SEI: 'Sei', TIA: 'Celestia',
  PEPE: 'Pepe', FLOKI: 'Floki', USDT: 'Tether (USDT)', USDC: 'USD Coin (USDC)',
  QNT: 'Quant', EGLD: 'MultiversX', ALGO: 'Algorand', VET: 'VeChain', HT: 'Huobi Token',
}));
function cryptoName(base) {
  const known = COIN_NAMES.get(base);
  return known ? `${known} (CoinDCX)` : `${base} (CoinDCX)`;
}

function round2(n) { return Math.round(n * 100) / 100; }

// ---------------- fetch + record one balance sync ----------------
// Called from portfolioSync.syncNow(). Throws on hard failure (creds
// invalid / API unreachable) so the sync engine can keep the previous
// CoinDCX assets (degraded-tolerant). Trade-history fetch is best-effort:
// a key without trade permission simply leaves rows basis-less (honest).
export async function fetchCoinDcxAssets(usdInr) {
  const creds = loadCreds();
  if (!creds?.apiKey || !creds?.secret) return null; // not connected
  const [raw, tickers, tradesOut] = await Promise.all([
    fetchBalancesSigned(creds.apiKey, creds.secret),
    fetchCoinDcxTickers(),
    fetchCoinDcxTrades(creds.apiKey, creds.secret).catch(() => null),
  ]);
  const balances = normalizeBalances(raw);
  const ledgerBasis = tradesOut ? computeCostBasis(tradesOut.trades, usdInr) : null;
  const manualBasis = loadManualBasis();
  const basis = mergeBasis(ledgerBasis, manualBasis);
  const assets = mapBalancesToAssets(balances, tickers, usdInr, basis);
  // Write-back: merge the sync metadata onto the CURRENT creds file. The
  // awaits above can span a concurrent reconnect (user rotating keys via
  // /connect) — spreading the STALE `creds` snapshot here would silently
  // revert the fresh keys (and durable-back the dead ones), killing every
  // later sync with [401] until the next manual reconnect. If the keys
  // changed mid-flight, skip the write-back entirely.
  const freshCreds = loadCreds();
  if (freshCreds?.apiKey === creds.apiKey && freshCreds?.secret === creds.secret) {
    saveCreds({
      ...freshCreds,
      lastSyncAt: Date.now(),
      balanceCount: balances.length,
      lastError: null,
      costBasis: {
        source: tradesOut?.endpoint || null,
        trades: tradesOut?.trades?.length ?? 0,
        coins: ledgerBasis ? Object.keys(ledgerBasis) : [],
        manualCoins: Object.keys(manualBasis || {}),
        computedAt: Date.now(),
      },
    });
  }
  return { assets, balanceCount: balances.length, basis };
}

// ---------------- global equity futures instruments (PUBLIC) ----------------
// v10.5.3 FULL-UNIVERSE SCAN (Issue #2): the Global Equity SIM desk's
// watchlist is no longer a hand-typed 8-name array — it MERGES whatever
// single-stock perps CoinDCX actually lists with the desk's liquid
// seed. This function pulls CoinDCX's PUBLIC derivatives instrument
// list and separates equity-linked perps from crypto perps:
//
//   • v10.7 USDC SCAN FIRST — CoinDCX's Global Futures (the US stocks
//     the app's "Global Futures" section actually shows: AAPL, TSLA,
//     TSM, SKHX…) are USDC-margined perps (B-<TICKER>_USDC). The
//     margin_currency_short_name[]=USDC variant is tried in both
//     param shapes and a scan is accepted only when it yields >= 3
//     B-<BASE>_USDC rows (same never-trust-one-shape discipline as
//     everywhere else in this module).
//   • a base with a CoinDCX SPOT market is a CRYPTO COIN — every
//     tradeable crypto trades on spot; tokenized/synthetic equities
//     have no spot market. (fetchCoinDcxTickers carries the whole
//     spot book and is already 2s-cached + shared with the SSE stream
//     and /api/crypto-prices — no extra upstream load.)
//   • leveraged-token bases (3L/3S/BULL/BEAR/HALF suffixes) are crypto
//     derivatives, never equities.
//   • perp-only crypto staples that lack a spot market are excluded by
//     an explicit set (belt-and-braces for venue-specific gaps).
//   • v10.7 COMMODITY/INDEX fix: the USDT book also lists METALS /
//     ENERGY / INDEX perps (XAU gold, XAG silver, NATGAS, INX, COPPER,
//     ROBO, SLX, RAYSOL…) which pass every crypto filter yet are NOT
//     stocks — they used to crowd the discovered tail with names that
//     have no Yahoo equity ticker. Explicitly excluded.
// Whatever survives is a candidate global-equity perp: { symbol, pair,
// margin }.
// The Yahoo ticker mapping for each discovery lives in
// server/ai/globalFutures.js (alias table for class-A/B shares etc).
const FUTURES_ACTIVE_INSTRUMENTS_URL = 'https://api.coindcx.com/exchange/v1/derivatives/futures/data/active_instruments';
let _globalInstrumentsCache = null, _globalInstrumentsAt = 0;
const GLOBAL_INSTRUMENTS_CACHE_MS = 30 * 60_000;
// Perp-only crypto bases seen without spot markets on some venue
// revisions — explicitly never equities.
const PERP_ONLY_CRYPTO_BASES = new Set(['PEPE', 'BONK', 'FLOKI', 'ORDI', 'SATS', 'RATS', 'MOODENG', 'GOAT', 'PNUT', 'ACT', 'NEIRO', 'POPCAT', 'MEW', 'TURBO', 'WIF']);
const PERP_LEVERAGED_PATTERNS = [/3L$/, /3S$/, /BULL$/, /BEAR$/, /HALF$/];
// v10.7: commodity / energy / index perp bases on the USDT book —
// real markets, but NOT stocks (no Yahoo equity ticker, and the desk
// is an EQUITY simulator). Never discovered as "equity perps".
const COMMODITY_INDEX_BASES = new Set([
  'XAU', 'XAG', 'XPT', 'XPD',          // metals
  'NATGAS', 'GAS', 'OIL', 'BRN', 'WTI', 'NG', // energy
  'INX', 'SPX', 'NDX', 'DJ', 'DXY',    // indices / FX
  'COPPER', 'ROBO', 'SLX', 'ARX', 'RAYSOL', 'URA', // sector/commodity baskets
]);

/** True when the base survives the equity-ticker shape + exclusion sets. */
function _isEquityPerpBase(base, spotBases) {
  if (spotBases.has(base)) return false;
  if (PERP_ONLY_CRYPTO_BASES.has(base)) return false;
  if (COMMODITY_INDEX_BASES.has(base)) return false;
  if (PERP_LEVERAGED_PATTERNS.some(re => re.test(base))) return false;
  if (!/^[A-Z]{1,8}$/.test(base)) return false; // ticker-shaped (no digits — equity tickers are letters)
  return true;
}

export async function fetchGlobalFuturesInstruments({ maxAgeMs = GLOBAL_INSTRUMENTS_CACHE_MS } = {}) {
  if (_globalInstrumentsCache && Date.now() - _globalInstrumentsAt < maxAgeMs) return _globalInstrumentsCache;
  // crypto bases = every SPOT market base (shared cached round-trip)
  const spotBases = new Set();
  try {
    const tickers = await fetchCoinDcxTickers();
    for (const t of (Array.isArray(tickers) ? tickers : [])) {
      const base = String(t?.market || '').replace(/(INR|USDT|USDC|BTC|BNB)$/, '');
      if (base) spotBases.add(base.toUpperCase());
    }
  } catch { /* ticker book unavailable → classification falls to the explicit sets */ }

  const rows = [];
  const seen = new Set();
  const pushRows = (list, margin) => {
    for (const raw of list) {
      // the endpoint returns plain pair strings; object shapes are tolerated
      const pair = String(raw?.pair || raw?.instrument || raw || '').toUpperCase();
      const m = pair.match(/^B-([A-Z0-9]+)_(USDC|USDT)$/);
      if (!m) continue;
      const base = m[1];
      if (seen.has(base)) continue;
      if (!_isEquityPerpBase(base, spotBases)) continue;
      seen.add(base);
      rows.push({ symbol: base, pair, margin });
    }
  };

  // 1) v10.7 USDC scan — the app's actual Global Futures stock list.
  //    Both param shapes tried; a scan counts only with >= 3 USDC rows
  //    (a 200-with-USDT-payload or error page must never be mistaken
  //    for "no global futures exist"). Failures are swallowed here —
  //    the USDT scan below still gets its chance.
  let anyRow = false;
  for (const param of ['margin_currency_short_name%5B%5D=USDC', 'margin_currency_short_name=USDC']) {
    try {
      const r = await fetch(`${FUTURES_ACTIVE_INSTRUMENTS_URL}?${param}`, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36' },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (!r.ok) throw new Error(`global futures instruments HTTP ${r.status}`);
      const list = await r.json();
      if (!Array.isArray(list) || list.length === 0) throw new Error('global futures instruments: empty');
      const usdcPairs = list.map(x => String(x?.pair || x?.instrument || x || '').toUpperCase())
        .filter(p => /^B-[A-Z0-9]+_USDC$/.test(p));
      if (usdcPairs.length >= 3) { pushRows(usdcPairs, 'USDC'); anyRow = true; break; }
    } catch { /* try the next param shape */ }
  }

  // 2) the USDT scan (v10.5.3 behavior — equity-shaped USDT perps)
  try {
    const url = `${FUTURES_ACTIVE_INSTRUMENTS_URL}?margin_currency_short_name[]=USDT`;
    const r = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36' },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!r.ok) throw new Error(`global futures instruments HTTP ${r.status}`);
    const list = await r.json();
    if (!Array.isArray(list) || list.length === 0) throw new Error('global futures instruments: empty');
    pushRows(list, 'USDT');
  } catch (e) {
    // BOTH scans unreachable AND zero USDC rows → honest throw (caller
    // degrades to seed-only). USDC-only success is a valid partial.
    if (!anyRow) throw e;
  }

  _globalInstrumentsCache = rows;
  _globalInstrumentsAt = Date.now();
  return rows;
}

// ---------------- test hooks ----------------
export function __resetCoinDcxForTests() {
  try { saveCreds({ apiKey: null, secret: null }); } catch { /* ignore */ }
}
export function __setCredsForTests(apiKey, secret, extra = {}) {
  saveCreds({ apiKey, secret, connectedAt: Date.now(), ...extra });
}
export function __coindcxPrivateForTests() { return coindcxPrivate; }
export function __fetchBalancesSignedForTests() { return fetchBalancesSigned; }
export function __fetchCoinDcxTradesForTests() { return (...args) => fetchCoinDcxTrades(...args); }
