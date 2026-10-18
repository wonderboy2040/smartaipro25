// ============================================================
// server/security/pinAuth.js — v21.1.0 (Phase-3 split)
// ------------------------------------------------------------
// index.js se AUTH SYSTEM ka extraction (195-385 + 491-604):
//   • Server-side PIN (APP_PIN env — browser me KABHI nahi jata)
//   • In-memory session store (30d TTL + hourly GC)
//   • Per-IP login rate limiter (5/min)
//   • GLOBAL distributed-brute-force lockout (150 fails / 15min → 5min lock)
//   • requireAuth middleware (Bearer → cookie → ?session= fallback ladder)
//   • Service-token auth (API_TOKEN — forked bot child ke loopback calls)
//   • Auth endpoints: POST /api/auth/login · /logout · GET /api/auth/check
//
// SECURITY-INVARIANT notes (jo split me preserve hue):
//   • PIN compare = SHA-256 dono sides + timingSafeEqual (length leak nahi)
//   • Cookie SameSite=None;Secure sirf HTTPS pe (plain HTTP → Lax)
//   • Logout cross-site discriminator: Bearer ya same-host/allowlist origin
//
// index.js me jo baaki rakha gaya: CORS middleware, CSRF discriminator
// (wo app.use wiring karte hain), SSE cap (sessions import karta hai).
// ============================================================
import crypto from 'node:crypto';

// Server-side PIN — REQUIRED. No default, no VITE_ fallback.
export const APP_PIN = process.env.APP_PIN || '';

// In-memory session store (single-user app, no persistence needed).
// 2026 persistence pass: 24h → 30 days — the app is single-user; a
// month-long session cookie dramatically cuts re-login frequency (the PIN
// is only re-entered if cookies are explicitly cleared or after a month
// away).
export const sessions = new Map(); // token → { lastSeen: number }
const SESSION_TTL = 30 * 24 * 60 * 60 * 1000; // 30 days

// Clean up expired sessions periodically.
setInterval(() => {
  const now = Date.now();
  for (const [token, info] of sessions) {
    if (now - info.lastSeen > SESSION_TTL) sessions.delete(token);
  }
}, 60 * 60 * 1000).unref?.();

// Login rate limiter — 5 attempts per minute per IP (brute-force protection).
const _loginAttempts = new Map(); // ip → [timestamps]
export function loginRateCheck(ip) {
  // v21.1.1 [audit A15]: ab sirf FAILED attempts window me aate hain
  // (recordLoginFail dekho). Pehle har attempt — successful logins samet —
  // count hota tha: ek rapid re-login burst (5 quick logins) bhi 429
  // de deta tha. Check-only ban gaya; recording fail-path me hota hai.
  const now = Date.now();
  // Prune stale IPs so the map cannot grow unbounded on a public endpoint.
  if (_loginAttempts.size > 1000) {
    for (const [k, v] of _loginAttempts) {
      if (!v.length || now - v[v.length - 1] > 10 * 60 * 1000) _loginAttempts.delete(k);
    }
  }
  const arr = (_loginAttempts.get(ip) || []).filter(t => now - t < 60 * 1000);
  return arr.length < 5;
}

/** v21.1.1 [audit A15]: ek FAILED login attempt record karo (per-IP 60s window). */
export function recordLoginFail(ip) {
  const now = Date.now();
  const arr = (_loginAttempts.get(ip) || []).filter(t => now - t < 60 * 1000);
  arr.push(now);
  _loginAttempts.set(ip, arr);
}

// v10.13 SECURITY (deep-recheck M-4): GLOBAL failed-PIN lockout. The per-IP
// limiter above is trivially bypassed by rotating IPs (a 4-digit PIN has only
// 10k combinations). This counts FAILED pins across ALL IPs in a rolling
// 15-min window: past 150 total failures the login endpoint 429s globally
// for 5 minutes. Sized so a forgetful owner (a handful of failures) never
// trips it, while a distributed spray cannot iterate the keyspace.
const _pinFails = []; // timestamps of failed PIN attempts (global)
const PIN_FAIL_WINDOW_MS = 15 * 60 * 1000;
const PIN_FAIL_LOCK_LIMIT = 150;
const PIN_FAIL_LOCK_MS = 5 * 60 * 1000;
let _pinLockUntil = 0;
function recordPinFail() {
  const now = Date.now();
  _pinFails.push(now);
  while (_pinFails.length && now - _pinFails[0] > PIN_FAIL_WINDOW_MS) _pinFails.shift();
  if (_pinFails.length >= PIN_FAIL_LOCK_LIMIT) {
    _pinLockUntil = Math.max(_pinLockUntil, now + PIN_FAIL_LOCK_MS);
    _pinFails.length = 0; // fresh window after the lockout arms
    console.warn('[wealth-ai] SECURITY: global PIN-failure lockout armed for 5 minutes (distributed brute-force suspected).');
  }
}
function pinLockActive() { return Date.now() < _pinLockUntil; }

// Cookie name for the session token.
export const SESSION_COOKIE = 'wealthai_session';

// Paths that do NOT require authentication.
export const PUBLIC_PATHS = new Set([
  '/health',
  '/api/ping', // v19.2: zero-work liveness heartbeat (external supervisor probe)
  '/api/auth/login',
  '/api/auth/check',
  '/api/config',
  '/api/ai-status',
  '/api/telegram-status',
  '/api/telegram/webhook', // v10.1: Telegram's server-to-server webhook (secret-token + chat-id allowlist inside)
  '/api/feed-status',
  // Cloud sync endpoints REQUIRE AUTH — they proxy portfolio data and
  // stored API keys; exposing them publicly would leak private data.
  '/api/auth/logout',
  // Market data endpoints are PUBLIC — they fetch public market prices,
  // no private data. Making these public ensures prices always load.
  '/api/quote',
  '/api/chart',
  '/api/crypto-prices',
  '/api/forex',
  '/api/feed-status',
  '/api/inflation',
  '/api/stream',
  '/api/fundamentals',
]);

// Auth middleware — checks multiple auth mechanisms in order:
// 1. Authorization: Bearer <token> header (PRIMARY — bulletproof for cross-origin)
// 2. httpOnly session cookie (fallback — same-origin only)
// 3. ?session=<token> query param (fallback — for EventSource SSE)
export function requireAuth(req, res, next) {
  // Public paths skip auth (exact match + prefix match for dynamic routes).
  if (PUBLIC_PATHS.has(req.path)) return next();
  // /api/fundamentals/:symbol is public (dynamic segment).
  if (req.path.startsWith('/api/fundamentals/')) return next();
  // /api/ml/ endpoints are public (ML predictions, market data — not private).
  if (req.path.startsWith('/api/ml/')) return next();

  // Static assets (served by express.static) are public.
  // SECURITY FIX (audit M-1): extension bypass is now restricted to safe
  // methods (GET/HEAD) on NON-API paths only. Previously any method (POST/
  // PUT/DELETE) on a path merely ending in .json (etc.) skipped auth -- a
  // latent auth-bypass footgun for future /api routes with trailing params.
  if ((req.method === 'GET' || req.method === 'HEAD')
    && !req.path.startsWith('/api/')
    && (req.path.startsWith('/assets/') || /\.(js|mjs|css|map|ico|svg|png|jpe?g|webp|woff2?|ttf|otf|json|wasm)$/i.test(req.path))) {
    return next();
  }

  // SPA fallback (index.html) is public — the login screen must load.
  if (req.method === 'GET' && !req.path.startsWith('/api/')) {
    return next();
  }

  // 1. Authorization: Bearer <token> header (PRIMARY — works cross-origin always)
  let token = null;
  const authHeader = req.headers.authorization || '';
  if (authHeader.startsWith('Bearer ')) {
    token = authHeader.substring(7).trim();
  }

  // 2. httpOnly session cookie (fallback — same-origin or SameSite=None)
  if (!token) {
    token = parseCookie(req.headers.cookie || '')[SESSION_COOKIE];
  }

  // 3. ?session=<token> query param (fallback — for EventSource SSE)
  if (!token && req.query && typeof req.query.session === 'string') {
    token = req.query.session;
  }

  // 0. SERVICE AUTH (2026-09 bot integration): the Telegram bot process is
  // forked from THIS server and shares its env. API_TOKEN (server-only,
  // never exposed to the browser bundle) authorizes loopback service calls
  // (portfolio sync trigger, asset hide/unhide) without a browser session.
  // Browser sessions are random UUIDs — they can never collide with this.
  const SERVICE_TOKEN = process.env.API_TOKEN || '';
  if (token && SERVICE_TOKEN.length >= 12 && _constEq(token, SERVICE_TOKEN)) {
    return next();
  }

  if (!token || !sessions.has(token)) {
    return res.status(401).json({ error: { message: 'Authentication required. Please log in.' } });
  }

  // Refresh session activity.
  sessions.get(token).lastSeen = Date.now();
  next();
}

// Simple cookie parser (avoids adding cookie-parser dependency).
export function parseCookie(header) {
  const out = {};
  if (!header) return out;
  for (const pair of header.split(';')) {
    const idx = pair.indexOf('=');
    if (idx < 0) continue;
    const key = pair.substring(0, idx).trim();
    const val = pair.substring(idx + 1).trim();
    if (key) out[key] = val;
  }
  return out;
}

// Constant-time comparison for long-lived bearer secrets (digest both
// sides to fixed-length SHA-256 buffers — also neutralizes length leaks).
// Same pattern as the PIN check in /api/auth/login: a plain === on the
// service token would leak bytes through response timing.
export function _constEq(a, b) {
  try {
    const ha = crypto.createHash('sha256').update(String(a)).digest();
    const hb = crypto.createHash('sha256').update(String(b)).digest();
    return crypto.timingSafeEqual(ha, hb);
  } catch { return false; }
}

/** v20.4.3 — scheme-aware session cookie attributes. */
export function _sessionCookieAttrs(req) {
  const proto = String((req && req.headers && req.headers['x-forwarded-proto']) || '').split(',')[0].trim().toLowerCase();
  const https = !!(req && (req.secure || proto === 'https'));
  return https ? { sameSite: 'None', secure: '; Secure' } : { sameSite: 'Lax', secure: '' };
}

/**
 * Register the three auth endpoints on the app.
 *   deps.clientIpOf(req)          — proxy-trust-aware IP (index.js)
 *   deps.logoutOriginAllowed(req) — legacy-browser origin check (CORS state
 *                                   — same-host/allowlist/fail-closed — index.js me rehta hai)
 */
export function registerAuthRoutes(app, deps = {}) {
  const clientIpOf = deps.clientIpOf || (() => 'unknown');
  const logoutOriginAllowed = deps.logoutOriginAllowed || (() => true);

  // POST /api/auth/login → { pin: string } → sets session cookie
  app.post('/api/auth/login', (req, res) => {
    // v18.6.4: proxy-trust-aware client IP (see clientIpOf in index.js)
    const ip = clientIpOf(req);
    // v10.13: global lockout check BEFORE the per-IP limiter (rotating IPs
    // must not bypass it; also don't count lockout-blocked probes as attempts).
    if (pinLockActive()) {
      return res.status(429).json({ error: { message: 'Too many failed attempts. Login is temporarily locked — please wait a few minutes.' } });
    }
    if (!loginRateCheck(ip)) {
      return res.status(429).json({ error: { message: 'Too many login attempts. Please wait a minute.' } });
    }

    const { pin } = req.body || {};
    if (!APP_PIN) {
      return res.status(500).json({ error: { message: 'Server PIN not configured. Set APP_PIN env var.' } });
    }
    if (typeof pin !== 'string' || pin.length === 0) {
      return res.status(400).json({ error: { message: 'PIN required.' } });
    }

    // Constant-time comparison to prevent timing attacks.
    // Hash both sides first so a length mismatch cannot leak the PIN length.
    const a = crypto.createHash('sha256').update(String(pin)).digest();
    const b = crypto.createHash('sha256').update(APP_PIN).digest();
    if (!crypto.timingSafeEqual(a, b)) {
      recordPinFail(); // v10.13: feeds the global distributed-brute-force lockout
      recordLoginFail(ip); // v21.1.1 [audit A15]: per-IP window me sirf failures
      return res.status(401).json({ error: { message: 'Invalid PIN.' } });
    }

    // Generate session token and store it.
    const token = crypto.randomUUID();
    sessions.set(token, { lastSeen: Date.now() });

    // Cookie SameSite policy:
    // ALWAYS use SameSite=None; Secure in production. This is REQUIRED for
    // cross-origin deployments (Vercel frontend → Render backend). If we use
    // SameSite=Strict, the browser blocks the cookie on cross-origin requests
    // and every API call after login returns 401.
    // SameSite=None REQUIRES Secure, so we set it whenever SameSite=None.
    // v20.4.3 FIX: only HTTPS requests get SameSite=None; Secure. On plain
    // HTTP (local / LAN IP / Safari) a Secure cookie is silently dropped, so
    // fall back to SameSite=Lax (Bearer sessionToken still works either way).
    const { sameSite, secure } = _sessionCookieAttrs(req);
    res.setHeader('Set-Cookie', `${SESSION_COOKIE}=${token}; HttpOnly; SameSite=${sameSite}; Path=/; Max-Age=${SESSION_TTL / 1000}${secure}`);
    return res.json({ ok: true, sessionToken: token }); // sessionToken used for EventSource ?session= param
  });

  // POST /api/auth/logout → clears session cookie
  app.post('/api/auth/logout', (req, res) => {
    // CSRF guard (2026-09 audit): logout is a state-changing PUBLIC POST and
    // the session cookie is SameSite=None — a third-party page posting a
    // cross-site form to this URL is a "simple request" (no preflight) and
    // the cookie rides along. Repeated forced logouts = session DoS.
    // DISCRIMINATOR: a cross-site <form> can NEVER set an Authorization
    // header, while the app's own cross-origin logout (Vercel → Render,
    // also Sec-Fetch-Site: cross-site) always sends the Bearer token via
    // apiFetch. Bearer-authenticated cross-site logouts are therefore
    // allowed; headerless cross-site requests are rejected.
    const secFetchSite = String(req.headers['sec-fetch-site'] || '').toLowerCase();
    const hasBearer = /^Bearer\s+\S+/i.test(String(req.headers.authorization || ''));
    if (secFetchSite === 'cross-site' && !hasBearer) {
      return res.status(403).json({ ok: false, error: 'Cross-site logout blocked.' });
    }
    // Legacy browsers (no Sec-Fetch-Site): Origin allowlist, Bearer-exempt.
    const origin = req.headers.origin;
    if (origin && !secFetchSite && !hasBearer && !logoutOriginAllowed(req)) {
      return res.status(403).json({ ok: false, error: 'Cross-site logout blocked.' });
    }
    const token = parseCookie(req.headers.cookie || '')[SESSION_COOKIE];
    if (token) sessions.delete(token);
    // Bearer-token logout: the token itself may be the session — invalidate
    // it too (belt and braces for cookie-less cross-origin sessions).
    const bearer = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
    if (bearer) sessions.delete(bearer);
    { const { sameSite, secure } = _sessionCookieAttrs(req); res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; HttpOnly; SameSite=${sameSite}; Path=/; Max-Age=0${secure}`); }
    res.json({ ok: true });
  });

  // GET /api/auth/check → returns whether the caller is authenticated
  // Checks ALL auth mechanisms: Authorization header, cookie, query param.
  app.get('/api/auth/check', (req, res) => {
    // 1. Authorization: Bearer <token> header (primary — what frontend sends)
    let token = null;
    const authHeader = req.headers.authorization || '';
    if (authHeader.startsWith('Bearer ')) {
      token = authHeader.substring(7).trim();
    }
    // 2. httpOnly session cookie (fallback)
    if (!token) {
      token = parseCookie(req.headers.cookie || '')[SESSION_COOKIE];
    }
    // 3. ?session=<token> query param (fallback)
    if (!token && req.query && typeof req.query.session === 'string') {
      token = req.query.session;
    }
    res.json({ authenticated: !!(token && sessions.has(token)) });
  });
}
