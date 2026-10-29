// ============================================================
// src/hooks/useAuthState.ts — v20.0 LEAN TERMINAL STATE
// ------------------------------------------------------------
// The 2570-line useAppState (portfolio prices, forex, INDMoney
// sync, IndexedDB snapshots, planner, macro — all REMOVED in
// the v20 two-tab rebuild) shrinks to exactly what the shell
// needs:
//   1) server-side PIN auth  (/api/auth/login + /api/auth/check)
//   2) session token restore (instant, verified in background)
//   3) dark/light theme
//   4) backend heartbeat     (/api/ping, 30s, zero-work probe)
// Nothing else polls. The two desks (India Intraday / CoinDCX)
// own ALL their data streams — the shell adds ZERO recurring
// network load beyond one ping per 30s.
// ============================================================
import { useCallback, useEffect, useRef, useState } from 'react';
import { apiFetch, getProxyBase, setSessionToken, ensureAuthenticated } from '../utils/api';
import { secureStorage } from '../utils/secureStorage';

export type BackendStatus = 'checking' | 'live' | 'down';
export type Theme = 'dark' | 'light';

const HEARTBEAT_MS = 30_000;
const HEARTBEAT_RETRY_MS = 3_000;
const HEARTBEAT_TIMEOUT_MS = 8_000;
// Watchdog ke neeche server pehla request answer karne me ~45-60s leta hai.
// Itne waqt me "SERVER DOWN" dikhana galat hai — page pehle 90s "CHECKING"
// rehta hai, phir hi DOWN (server genuinely band ho to).
const BOOT_GRACE_MS = 90_000;

export function useAuthState() {
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [authChecked, setAuthChecked] = useState(false);
  const [pinInput, setPinInput] = useState('');
  const [loginBusy, setLoginBusy] = useState(false);
  const [loginError, setLoginError] = useState('');
  const [backend, setBackend] = useState<BackendStatus>('checking');
  // v20.8.3 ALWAYS-LATEST: server-side code version (/api/ping ka `v` field).
  // App.tsx isko APP_VERSION (build-time baked) se compare karke STALE-BUILD
  // banner dikhata hai — browser purana dist chala raha ho to turant dikhe.
  const [serverVersion, setServerVersion] = useState<string | null>(null);
  const [theme, setTheme] = useState<Theme>(
    () => (secureStorage.getItem('theme') as Theme) || 'dark'
  );

  // --- theme ---
  useEffect(() => {
    try { secureStorage.setItem('theme', theme); } catch { /* quota */ }
  }, [theme]);
  const toggleTheme = useCallback(() => {
    setTheme((t) => (t === 'dark' ? 'light' : 'dark'));
  }, []);

  // --- session restore: instant auth (no await) + background verify ---
  // Same battle-tested pattern as v18 useAppState: restore token
  // synchronously so the desks start streaming immediately on F5;
  // if the token turns out expired, log out gracefully.
  useEffect(() => {
    const auth = secureStorage.getItem('authDone');
    if (auth !== 'true') { setAuthChecked(true); return; }
    let token: string | null = null;
    try {
      token = sessionStorage.getItem('wealthai_session_token')
        || localStorage.getItem('wealthai_session_token');
    } catch { /* private mode */ }
    if (!token) {
      secureStorage.removeItem('authDone');
      setAuthChecked(true);
      return;
    }
    setSessionToken(token);
    setIsAuthenticated(true);
    setAuthChecked(true);
    ensureAuthenticated().then((valid) => {
      if (!valid) {
        secureStorage.removeItem('authDone');
        setSessionToken(null);
        setIsAuthenticated(false);
      }
    }).catch(() => { /* offline — keep session */ });
  }, []);

  // v20.1 FIX (deep audit #4): mid-session token expiry — api.ts now
  // dispatches a throttled 'session-expired' event whenever any REST call
  // answers 401. Without this listener an expired token left every board
  // poll + SSE stream 401-looping with the PIN gate never shown until a
  // manual F5. Reset mirrors the boot-time invalid-token path.
  useEffect(() => {
    const onSessionExpired = () => {
      secureStorage.removeItem('authDone');
      setSessionToken(null);
      setIsAuthenticated(false);
    };
    window.addEventListener('session-expired', onSessionExpired);
    return () => window.removeEventListener('session-expired', onSessionExpired);
  }, []);

  // --- PIN login (server-side compare against APP_PIN env) ---
  const verifyPin = useCallback(async () => {
    const pin = pinInput.trim();
    if (!pin || loginBusy) return;
    setLoginBusy(true);
    setLoginError('');
    try {
      const res = await apiFetch(`${getProxyBase()}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pin }),
      });
      if (res.ok) {
        const data = await res.json().catch(() => ({}));
        if (data.sessionToken) setSessionToken(data.sessionToken);
        secureStorage.setItem('authDone', 'true');
        setIsAuthenticated(true);
        setPinInput('');
      } else if (res.status === 401) {
        setLoginError('Galat PIN — dobara try karein');
        setPinInput('');
      } else {
        // v21.1.1 [audit D5]: server ka human message surface karo —
        // 429 (rate-limit / 5-min global lockout) ka reason body me hota
        // hai; pehle generic "Login fail (HTTP 429)" dikhata tha jabki
        // asli message "Too many failed attempts..." tha.
        const body = await res.json().catch(() => ({} as { error?: { message?: string } }));
        const srvMsg = body?.error?.message;
        setLoginError(srvMsg ? `${srvMsg}` : `Login fail (HTTP ${res.status})`);
      }
    } catch {
      const base = getProxyBase();
      setLoginError(
        base
          ? `Backend (${base}) reachable nahi hai — server chalu hai?`
          : 'Backend reachable nahi hai — server chalu hai?'
      );
    } finally {
      setLoginBusy(false);
    }
  }, [pinInput, loginBusy]);

  const logout = useCallback(() => {
    secureStorage.removeItem('authDone');
    setSessionToken(null);
    setIsAuthenticated(false);
    setPinInput('');
    apiFetch(`${getProxyBase()}/api/auth/logout`, { method: 'POST' }).catch(() => { /* best-effort */ });
  }, []);

  // --- backend heartbeat: ONE zero-work ping per 30s while LIVE ---
  // This is also what the external anti-freeze supervisor probes —
  // the shell status dot and the supervisor share the same truth.
  //
  // v21.26.7 WATCHDOG-BOOT FIX ("Start-SmartAI-Watchdog.bat ke baad SERVER
  // DOWN"): the supervised server boot (~45-60s) se pehle koi request answer
  // nahi karta, aur background tab me Chrome purana 30s interval throttle kar
  // deta hai (1 tick/min) — badge minutes tak DOWN atka rehta tha bhale server
  // UP ho chuka ho. Ab: NOT-LIVE par har 3s retry, 8s ping timeout (busy boot
  // loop), pehle 90s "CHECKING" (false DOWN nahi), aur tab visible/focused
  // hote hi turant ek beat. LIVE steady-state wahi 1 ping / 30s.
  const hbRef = useRef<number | null>(null);
  useEffect(() => {
    let cancelled = false;
    let inFlight = false;
    let wasLive = false;
    let fails = 0;
    const startedAt = Date.now();

    const schedule = (ms: number) => {
      if (cancelled) return;
      if (hbRef.current) window.clearTimeout(hbRef.current);
      hbRef.current = window.setTimeout(beat, ms);
    };

    const beat = async () => {
      if (cancelled || inFlight) return;
      inFlight = true;
      const ctl = new AbortController();
      const kill = window.setTimeout(() => ctl.abort(), HEARTBEAT_TIMEOUT_MS);
      let next = HEARTBEAT_RETRY_MS;
      try {
        const res = await fetch(`${getProxyBase()}/api/ping`, { signal: ctl.signal, cache: 'no-store' });
        if (cancelled) return;
        if (res.ok) {
          wasLive = true;
          fails = 0;
          setBackend('live');
          next = HEARTBEAT_MS;
          // v20.8.3: version capture — ping zero-work hai, `v` bhi wahi JSON me
          // aata hai (koi extra request nahi). Shape change = silent ignore.
          try {
            const d = await res.json();
            if (d && typeof d.v === 'string' && d.v) setServerVersion(d.v);
          } catch { /* ping shape change — ignore */ }
        } else {
          // Server ne HTTP answer diya par healthy nahi — ye DOWN hai.
          fails++;
          setBackend('down');
        }
      } catch {
        if (!cancelled) {
          fails++;
          if (wasLive) {
            // v21.26.7: ek transient timeout (heavy tick) badge ko turant
            // DOWN na kare — 3s me recheck, do lagatar fail par DOWN.
            if (fails >= 2) setBackend('down');
          } else if (Date.now() - startedAt < BOOT_GRACE_MS) {
            setBackend('checking');
          } else {
            setBackend('down');
          }
        }
      } finally {
        inFlight = false;
        window.clearTimeout(kill);
        schedule(next);
      }
    };

    // Background tab se wapas aate hi status turant sach dikhe (throttled
    // timer ka intezaar nahi).
    const wake = () => {
      if (cancelled || inFlight) return;
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
      schedule(0);
    };

    beat();
    document.addEventListener('visibilitychange', wake);
    window.addEventListener('online', wake);
    window.addEventListener('focus', wake);
    window.addEventListener('pageshow', wake);
    return () => {
      cancelled = true;
      if (hbRef.current) { window.clearTimeout(hbRef.current); hbRef.current = null; }
      document.removeEventListener('visibilitychange', wake);
      window.removeEventListener('online', wake);
      window.removeEventListener('focus', wake);
      window.removeEventListener('pageshow', wake);
    };
  }, []);

  return {
    isAuthenticated, authChecked,
    pinInput, setPinInput, verifyPin, loginBusy, loginError,
    logout,
    theme, toggleTheme,
    backend,
    serverVersion,
  };
}
