// ============================================================
// utils/api — centralized API transport (auth + proxy base + fetch)
// ------------------------------------------------------------
// v20.7.11 DEAD-CODE PURGE: this file was 2,161 lines of v1-era
// "Wealth AI" portfolio plumbing (batch price scanner engine, Google-
// Sheet cloud sync, Groq-key cloud sync, Telegram alerts, market
// intelligence, IndMoney net-worth, CoinDCX connect, server-settings
// editor). The two-desk terminal uses NONE of it — every component
// talks to the Express API through apiFetch()/getProxyBase() only.
// The dead mass (40 exports + their internal helpers) was deleted;
// the six live exports below are the entire public surface.
// ============================================================

// v21.1.0 Phase-1.4: empty catches → swallow() (dev-only debug, behaviour same).
import { swallow } from './swallow';

// Proxy base helper — resolves backend server URL dynamically
// 1. Checks localStorage ('WEALTH_AI_BACKEND_URL')
// 2. Checks build-time VITE_API_PROXY
// 3. Defaults to production Render backend (https://smartai1.onrender.com) if hosted on Vercel/Netlify/GitHub Pages
export function getProxyBase(): string {
  try {
    const custom = localStorage.getItem('WEALTH_AI_BACKEND_URL');
    if (custom && custom.startsWith('http')) return custom.trim().replace(/\/$/, '');
  } catch (err) { swallow('api.getProxyBase', err); }

  const envProxy = (import.meta.env.VITE_API_PROXY as string) || '';
  if (envProxy) return envProxy.replace(/\/$/, '');

  if (typeof window !== 'undefined' && window.location) {
    const host = window.location.hostname;
    if (host.includes('.vercel.app') || host.includes('.github.io') || host.includes('.netlify.app')) {
      // v9.6: the CURRENT production backend. The old smartback URL was
      // a dead service — every Vercel deploy without VITE_API_PROXY set
      // silently pointed at it and login failed. Set VITE_API_PROXY in
      // Vercel to override this default.
      return 'https://smartai1.onrender.com';
    }
  }

  return '';
}

// (v10.13: the legacy module-const PROXY_BASE was removed — every call site
// now resolves getProxyBase() LIVE so a runtime backend switch applies
// everywhere at once.)

// ============================================================
// Centralized API fetch — sends auth token via Authorization header
// (bulletproof for cross-origin: Vercel frontend → Render backend)
// Also sends credentials (httpOnly cookie) as a fallback.
// ============================================================
let _sessionToken: string | null = null;
export function setSessionToken(token: string | null) {
  _sessionToken = token;
  // Store in BOTH sessionStorage (per-tab) and localStorage (persists across
  // browser restarts). This ensures the token survives page refresh, new tab,
  // and browser restart — fixing the "401 after refresh" bug.
  try {
    if (token) {
      sessionStorage.setItem('wealthai_session_token', token);
      localStorage.setItem('wealthai_session_token', token);
    } else {
      sessionStorage.removeItem('wealthai_session_token');
      localStorage.removeItem('wealthai_session_token');
    }
  } catch (err) { swallow('api.setSessionToken', err); }
}
// Restore token on module load — try sessionStorage first, then localStorage.
try {
  const t = sessionStorage.getItem('wealthai_session_token') || localStorage.getItem('wealthai_session_token');
  if (t) _sessionToken = t;
} catch (err) { swallow('api.tokenRestore', err); }

// Track the in-flight auth check so we don't fire it multiple times.
let _authCheckPromise: Promise<boolean> | null = null;

// Check if the current session is valid. If the token is missing or
// invalid, this returns false so the caller can force re-login.
// The check is cached — only runs once per page load.
export async function ensureAuthenticated(): Promise<boolean> {
  // If we already have a token, verify it's still valid.
  if (_sessionToken) {
    if (_authCheckPromise) return _authCheckPromise;
    _authCheckPromise = (async () => {
      try {
        const res = await apiFetch(`/api/auth/check`);
        if (res.ok) {
          // v20.7.8 [M-3]: a 200 with an unparseable/HTML body (proxy, edge
          // cache, captive portal) used to fall into the catch and read as
          // "token invalid" — the user was booted to the PIN gate while
          // every other endpoint would have succeeded. An OK response we
          // can't parse must PRESERVE the session; real expiry still lands
          // here via the 401 → session-expired path in apiFetch.
          const data = await res.json().catch(() => null);
          if (data?.authenticated) return true;
          if (data == null) return true;
        }
        // Token invalid — clear it.
        setSessionToken(null);
        return false;
      } catch {
        // Network failure is NOT "token invalid" either — keep the token,
        // let the next apiFetch decide (it will surface its own errors).
        return true;
      } finally {
        _authCheckPromise = null;
      }
    })();
    return _authCheckPromise;
  }
  return false;
}

export function apiFetch(input: string, init: RequestInit = {}): Promise<Response> {
  const proxyBase = getProxyBase();
  let url = input;
  if (!input.startsWith('http')) {
    const cleanPath = input.startsWith('/') ? input : `/${input}`;
    url = `${proxyBase}${cleanPath}`;
  }

  const headers: Record<string, string> = { ...(init.headers as Record<string, string> || {}) };
  // PRIMARY auth: Authorization Bearer token — works cross-origin ALWAYS,
  // no SameSite/cookie/CORS-credential issues.
  if (_sessionToken) {
    headers['Authorization'] = `Bearer ${_sessionToken}`;
  }
  // v1.3 THROTTLE-GUARD: default 30s timeout when the caller didn't supply
  // its own AbortSignal. Prevents corner-case hung requests from stalling
  // the UI indefinitely (all existing explicit timeouts still take priority).
  // v10.13 (deep-recheck L3): no longer MUTATES the caller's init object —
  // a shared/reused init gained a surprise .signal side effect.
  const signal = init.signal ?? AbortSignal.timeout(30000);
  return fetch(url, { ...init, signal, credentials: 'include', headers })
    .then(res => {
      // MIRROR-BANNER FIX (v4.4): any successful API round-trip is proof the
      // Express backend is alive (the /health probe can false-negative on a
      // cold free-tier boot >9s). Throttled global event — StaticMirrorBanner
      // listens and hides itself the moment real traffic succeeds.
      if (res.ok) notifyBackendOnline();
      // v20.1 FIX (deep audit): mid-session 401 — the token expired while the
      // terminal was open. Every REST call used to silently 401 (boards
      // "unreachable", SSE 401-loops) and the UI never fell back to the PIN
      // gate until a manual F5. A throttled 'session-expired' event resets
      // the auth state; useAuthState listens. Wrong-PIN logins also 401 —
      // the reset is a no-op there (user is already at the gate).
      if (res.status === 401) notifySessionExpired();
      return res;
    });
}

let _last401At = 0;
function notifySessionExpired() {
  try {
    if (typeof window === 'undefined' || !window.dispatchEvent) return;
    if (Date.now() - _last401At < 3000) return; // one event per burst
    _last401At = Date.now();
    window.dispatchEvent(new CustomEvent('session-expired'));
  } catch (err) { swallow('api.notifySessionExpired', err); } /* non-browser env */
}
/** v20.1 test hook — reset the session-expired burst throttle between cases. */
export function __resetSessionExpiredThrottleForTests() { _last401At = 0; }

let _lastOnlinePing = 0;
function notifyBackendOnline() {
  try {
    if (typeof window === 'undefined' || !window.dispatchEvent) return;
    if (Date.now() - _lastOnlinePing < 5000) return; // throttle event spam
    _lastOnlinePing = Date.now();
    window.dispatchEvent(new CustomEvent('backend-online'));
  } catch (err) { swallow('api.notifyBackendOnline', err); } /* non-browser env */
}
export function getSessionToken(): string | null { return _sessionToken; }
