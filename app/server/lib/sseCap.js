// ============================================================
// server/lib/sseCap.js — v18.6.3 REALTIME NEVER STOPS
// ------------------------------------------------------------
// THE BUG (user report, CoinDCX tab): the app itself opens exactly
// THREE /api/stream SSE connections once a manual trade is open
//   1. useAppState's global liveStream (App-level, always mounted)
//   2. CoinDcxTab's useCxLivePrices (board symbols)
//   3. ManualTradeMonitor's useCxLivePrices (open-trade symbols)
// which lands EXACTLY on the old SSE_MAX_PER_IP = 3. Any FOURTH
// connection — a reconnect race against a slow socket close, a
// second browser tab of the app, a phone peek — gets HTTP 429, and
// because EventSource retries the same URL forever, that stream sat
// in a PERMANENT "live feed down — retrying" loop while the browser
// tab stayed open (the exact symptom: ~2 min after opening the
// CoinDCX tab, the command-bar chip goes red and realtime prices
// stop).
//
// THE FIX: the cap is now connection-class aware:
//   • loopback (127.0.0.1 / ::1 — the Windows desktop app talking
//     to its own bundled server) → 8
//   • authenticated sessions (valid Bearer/cookie/?session= token
//     in the session store) → 6
//   • anonymous remote (public Render endpoint) → 3 (unchanged —
//     the amplification guard that motivated the cap stays intact)
//
// PURE module (no server boot side-effects) so tests import it
// directly; index.js wires it into /api/stream.
// ============================================================

const LOOPBACK_IPS = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1', 'localhost']);

export const SSE_MAX_ANON = 3;    // anonymous remote (unchanged guard)
export const SSE_MAX_AUTHED = 6;  // logged-in browser session
export const SSE_MAX_LOOPBACK = 8; // the desktop app's own browser

/** True when the SSE client is on the same machine as the server
 *  (the Windows portable app — browser → 127.0.0.1:8080). */
export function isLoopbackIp(ip) {
  if (!ip) return false;
  let raw = String(ip).trim().toLowerCase();
  // v20.7.3: actually strip IPv6-mapped IPv4 and IPv4 port suffixes (the
  // comment always claimed this — now it does it). Also accepts the
  // hexadecimal form ::ffff:7f00:1.
  raw = raw.replace(/^\[|\]$/g, '');
  const portStripped = raw.replace(/:\d+$/, '');
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(portStripped)) raw = portStripped;
  if (raw === '::ffff:7f00:1') return true;
  const mapped = raw.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (mapped) raw = mapped[1];
  return LOOPBACK_IPS.has(raw);
}

/** The per-IP concurrent /api/stream connection cap for a request. */
export function sseConnMaxFor(ip, authed) {
  if (isLoopbackIp(ip)) return SSE_MAX_LOOPBACK;
  if (authed) return SSE_MAX_AUTHED;
  return SSE_MAX_ANON;
}

/** Extract the session token from an SSE-ish request the same way
 *  requireAuth does (Bearer → cookie → ?session=). PURE — the caller
 *  checks membership in the live session store. */
export function extractSessionToken({ headers = {}, query = {} } = {}) {
  const authHeader = String(headers.authorization || '');
  if (authHeader.startsWith('Bearer ')) {
    const t = authHeader.substring(7).trim();
    if (t) return t;
  }
  const cookie = parseCookie(headers.cookie || '');
  if (cookie.wealthai_session) return cookie.wealthai_session;
  if (query && typeof query.session === 'string' && query.session) {
    return query.session;
  }
  return null;
}

function parseCookie(header) {
  const out = {};
  if (!header) return out;
  for (const pair of String(header).split(';')) {
    const idx = pair.indexOf('=');
    if (idx < 0) continue;
    const key = pair.substring(0, idx).trim();
    const val = pair.substring(idx + 1).trim();
    if (key) out[key] = val;
  }
  return out;
}
