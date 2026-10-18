// ============================================================
// src/App.tsx — v20.0 HIGH-PERFORMANCE TWO-DESK TERMINAL
// ------------------------------------------------------------
// COMPLETE REBUILD (user directive): sirf 2 desks bache hain —
//   🇮🇳 INDIA INTRADAY   (NSE: signals · committee · paper ·
//                         journal · options · execution)
//   ₿ COINDCX            (crypto spot + global futures: board ·
//                         signals · perps · auto-trader · mesh)
// Dashboard / Portfolio / Planner / Macro / NeuralChat /
// PortfolioHealthMonitor / global price-forex polling — SAB
// REMOVED. The shell is now near-zero-cost:
//   • no ticker strip (VIX/sentiment/forex polling GONE)
//   • no IndexedDB portfolio snapshots
//   • no INDMoney sync loop
//   • ONE /api/ping heartbeat per 30s (shared truth with the
//     external anti-freeze supervisor)
//   • both desks lazy-loaded, ErrorBoundary per desk
// Everything perf-critical lives inside the desks, which are
// untouched battle-tested v19 code.
// ============================================================
import { lazy, Suspense, useCallback, useEffect, useState } from 'react';
import { useAuthState } from './hooks/useAuthState';
import { ErrorBoundary } from './components/ErrorBoundary';
import { WifiOff } from 'lucide-react';
import { APP_VERSION, APP_TITLE } from './version';

type Desk = 'india' | 'crypto' | 'bots';
const DESK_ORDER: Desk[] = ['india', 'crypto', 'bots'];

// Lazy desks with auto-recovery after deploys (stale hashed chunks
// in the SW cache -> one forced reload instead of a broken screen).
// v20.7.8 [H-3]: clear the one-shot marker on SUCCESS. The old flow only
// removed it on a SECOND failure — so the first stale-chunk deploy self-
// healed, but a second deploy later in the same session threw straight
// to the ErrorBoundary ("Desk crash / Reload karo") — the exact broken
// screen this helper exists to prevent. Now every successful import
// re-arms recovery for the next deploy.
function lazyWithRetry(importFn: () => Promise<any>, name: string) {
  const key = `chunk_reload_${name}`;
  return lazy(() =>
    importFn()
      .then((mod: any) => {
        sessionStorage.removeItem(key);
        return mod;
      })
      .catch((err: unknown) => {
        if (!sessionStorage.getItem(key)) {
          sessionStorage.setItem(key, '1');
          window.location.reload();
          return new Promise<never>(() => {});
        }
        sessionStorage.removeItem(key);
        throw err;
      })
  );
}

const IndiaIntradayTab = lazyWithRetry(() => import('./components/tabs/IndiaIntradayTab'), 'india');
const CoinDcxTab = lazyWithRetry(() => import('./components/tabs/CoinDcxTab'), 'coindcx');
// v20.8.0 JEV BOT LAB desk — 3-arm honest-signal pipeline dashboard.
const BotsTab = lazyWithRetry(() => import('./components/tabs/BotsTab'), 'bots');

const DESK_META: Record<Desk, { label: string; icon: string }> = {
  india: { label: 'India Intraday', icon: '🇮🇳' },
  crypto: { label: 'CoinDCX', icon: '₿' },
  bots: { label: 'Bot Lab', icon: '🤖' },
};

// IST clock — trading desk canonical time (visibility-aware: interval
// pauses when the tab is hidden, resyncs on return; 1 render/sec max).
function IstClock() {
  const [now, setNow] = useState('--:--:--');
  useEffect(() => {
    let t: number | null = null;
    const fmt = () =>
      new Intl.DateTimeFormat('en-GB', {
        timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
      }).format(new Date());
    const start = () => {
      if (t != null) return;
      setNow(fmt());
      t = window.setInterval(() => setNow(fmt()), 1000);
    };
    const stop = () => { if (t != null) { clearInterval(t); t = null; } };
    const onVis = () => { if (document.hidden) stop(); else start(); }; // v20.9.1: ternary-expression statement lint clean
    start();
    document.addEventListener('visibilitychange', onVis);
    return () => { stop(); document.removeEventListener('visibilitychange', onVis); };
  }, []);
  return <span className="text-slate-400 font-mono text-[11px] tabular-nums">{now} IST</span>;
}

export default function App() {
  const {
    isAuthenticated, authChecked,
    pinInput, setPinInput, verifyPin, loginBusy, loginError,
    logout, theme, toggleTheme, backend, serverVersion,
  } = useAuthState();
  const [desk, setDesk] = useState<Desk>('india');
  const [isOnline, setIsOnline] = useState(typeof navigator !== 'undefined' ? navigator.onLine : true);
  // v20.8.3 ALWAYS-LATEST: build-time APP_VERSION vs server-side `v` (/api/ping).
  // Mismatch = browser me PURANA dist chal raha hai (the "v20.7.5 serve" bug) —
  // iske bina user ko pata hi nahi chalta ki latest code run nahi ho raha.
  // null = server abhi booted/ping fail — koi banner nahi (no false alarm).
  const staleBuild = !!serverVersion && serverVersion !== APP_VERSION;

  useEffect(() => {
    const on = () => setIsOnline(true);
    const off = () => setIsOnline(false);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    return () => { window.removeEventListener('online', on); window.removeEventListener('offline', off); };
  }, []);

  // deep-link: /?tab=india|crypto (legacy ?tab=trading -> india)
  useEffect(() => {
    try {
      const t = new URLSearchParams(window.location.search).get('tab');
      const d = t === 'trading' ? 'india' : t;
      if (d === 'india' || d === 'crypto' || d === 'bots') setDesk(d);
    } catch { /* non-fatal */ }
  }, []);

  // v20.9.3 FIX (L): MCP OAuth connect feedback — indmoney/tapetide callbacks
  // ab ?indm=ok|error / ?tpt=ok|error ke saath aate hain (pehle ?tab=portfolio
  // pe redirect hote the jo desk hi nahi hai). Ek 12s ka connect-result chip.
  const [mcpConnectNote, setMcpConnectNote] = useState<string | null>(null);
  useEffect(() => {
    try {
      const q = new URLSearchParams(window.location.search);
      const indm = q.get('indm');
      const tpt = q.get('tpt');
      const which = indm ? 'IndMoney' : tpt ? 'TapeTide' : null;
      const val = indm || tpt;
      if (!which || !val) return;
      setMcpConnectNote(val === 'ok'
        ? `${which} MCP connect ho gaya — portfolio sync ab available`
        : `${which} MCP connect FAIL — ${q.get('reason') || 'unknown error'}`);
      const t = setTimeout(() => setMcpConnectNote(null), 12_000);
      return () => clearTimeout(t);
    } catch { /* non-fatal */ }
  }, []);

  // keyboard: 1 -> India desk, 2 -> CoinDCX desk, 3 -> Bots desk
  useEffect(() => {
    if (!isAuthenticated) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement
        || e.target instanceof HTMLSelectElement // v20.8.2: the Bots arm selector — number keys switched desks underneath it
        || (e.target as HTMLElement | null)?.isContentEditable) return;
      // v20.8.2 FIX (M): the deep-analysis modals lock body scroll while
      // open (both desks use the same convention) — pressing 1/2/3 mid-
      // analysis unmounted the tab and destroyed the pinned-signal modal.
      if (typeof document !== 'undefined' && document.body?.style?.overflow === 'hidden') return;
      if (e.key === '1') setDesk('india');
      if (e.key === '2') setDesk('crypto');
      if (e.key === '3') setDesk('bots');
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isAuthenticated]);

  const switchDesk = useCallback((d: Desk) => setDesk(d), []);

  // v20 boot line (one console line, zero recurring cost)
  // v20.3: single-source version (src/version.ts) — the badge/banner can
  // never go stale again (the v20.2 zip shipped a v20.0 header).
  useEffect(() => {
    try { console.log(`%c⚡ ${APP_TITLE}`, 'color:#22d3ee'); } catch { /* noop */ }
  }, []);

  // ---------- SESSION RESTORE SPLASH ----------
  // F5 pe token instantly restore hota hai — PIN form flash na ho,
  // isliye restore-check complete hone tak ek splash dikhao.
  if (!authChecked) {
    return (
      <div className="min-h-screen login-bg flex items-center justify-center">
        <div className="text-center">
          <div className="text-5xl animate-float mb-3">⚡</div>
          <div className="text-sm text-slate-500 font-medium">Session restore ho raha hai…</div>
        </div>
      </div>
    );
  }

  // ---------- LOGIN SCREEN ----------
  if (!isAuthenticated) {
    return (
      <div className="min-h-screen login-bg flex items-center justify-center p-4">
        <div className="quantum-modal rounded-3xl p-8 max-w-sm w-full animate-scale-in">
          <div className="text-center mb-8">
            <div className="relative inline-block">
              <div className="text-6xl mb-2 animate-float">⚡</div>
              <div className="absolute -inset-4 bg-cyan-500/10 rounded-full blur-xl pointer-events-none" />
            </div>
            <h1 className="text-3xl font-black gradient-text-cyan font-display text-glow mt-4">SmartAI Pro</h1>
            <div className="flex items-center justify-center gap-2 mt-2">
              <span className="quantum-badge">v{APP_VERSION.split('-')[0]} · TRADING TERMINAL</span>
            </div>
            <p className="text-slate-500 text-sm mt-3">India Intraday + CoinDCX desks · PIN enter karein</p>
          </div>
          <div className="relative z-10">
            <input
              type="password"
              value={pinInput}
              onChange={(e) => { setPinInput(e.target.value); }}
              onKeyDown={(e) => e.key === 'Enter' && verifyPin()}
              placeholder="••••"
              maxLength={32}
              autoComplete="current-password"
              disabled={loginBusy}
              className="w-full text-center px-4 py-5 quantum-input rounded-2xl text-3xl tracking-[0.3em] text-cyan-400 font-bold mb-4 font-mono placeholder-slate-700 relative z-10"
            />
            {loginError && (
              <div className="mb-4 px-3 py-2 rounded-xl bg-red-500/10 border border-red-500/20 text-red-400 text-xs font-semibold text-center">
                {loginError}
              </div>
            )}
            <button
              onClick={verifyPin}
              disabled={loginBusy || !pinInput.trim()}
              className="quantum-btn-primary w-full py-4 bg-gradient-to-r from-cyan-500 to-purple-600 animate-gradient rounded-2xl font-bold text-white text-lg relative z-10 disabled:opacity-50"
            >
              {loginBusy ? '⏳ Verifying…' : '🔓 Unlock Terminal'}
            </button>
          </div>
          <div className="text-center mt-5 relative z-10 flex items-center justify-center gap-2">
            <span className={`w-1.5 h-1.5 rounded-full ${backend === 'live' ? 'bg-emerald-400 animate-pulse-dot' : backend === 'down' ? 'bg-red-400 animate-pulse' : 'bg-amber-500 animate-pulse'}`} />
            <span className="text-[10px] text-slate-600 font-mono tracking-wider">
              {backend === 'live' ? 'SERVER LIVE' : backend === 'down' ? 'SERVER DOWN — Watchdog chalu karo' : 'CHECKING SERVER…'}
            </span>
          </div>
          {staleBuild && (
            <div className="mt-3 px-3 py-2 rounded-xl bg-red-500/10 border border-red-500/20 text-red-400 text-[11px] font-semibold text-center">
              ⚠ BUILD STALE — site v{APP_VERSION} · server v{serverVersion}. Watchdog dobara chalao (auto-rebuild).
            </div>
          )}
          <div className="text-center mt-2 relative z-10">
            <span className="text-[10px] text-slate-600 font-mono tracking-wider">AES-256 · SESSION TOKEN · SERVER-SIDE PIN</span>
          </div>
        </div>
      </div>
    );
  }

  // ---------- TERMINAL SHELL ----------
  return (
    <div className={`min-h-screen bg-gradient-to-br from-slate-950 via-[#0a0f1e] to-slate-950 text-slate-200 ${theme}`}>
      {/* v20.8.3 STALE-BUILD BANNER — browser ka built APP_VERSION server ke
          package.json `v` se match nahi = purana dist serve ho raha hai.
          Asli fix supervisor ensureFrontend auto-build hai; ye banner user ko
          turant batata hai ki restart karna hai (future updates pe bhi). */}
      {staleBuild && (
        <div className="bg-red-500/15 border-b border-red-500/30 text-red-300 text-[11px] font-semibold px-4 py-1.5 text-center">
          ⚠ BUILD STALE — browser v{APP_VERSION} · server v{serverVersion} · Watchdog window me Ctrl+C karke
          <b> Start-SmartAI-Watchdog.bat</b> dobara chalao (naya code auto-build hoga), phir F5.
        </div>
      )}
      {/* v20.9.3: MCP OAuth connect result (12s auto-dismiss) */}
      {mcpConnectNote && (
        <div className="bg-cyan-500/10 border-b border-cyan-500/25 text-cyan-300 text-[11px] font-semibold px-4 py-1.5 text-center">
          🔗 {mcpConnectNote}
        </div>
      )}
      {/* Header — one row, zero recurring network cost */}
      <header className="sticky top-0 z-40 quantum-appbar border-b border-white/5">
        <div className="container mx-auto px-4 py-2.5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            {/* brand + status */}
            <div className="flex items-center gap-3 order-1 min-w-0">
              <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-cyan-500/20 to-indigo-500/20 flex items-center justify-center border border-cyan-500/20 flex-shrink-0">
                <span className="text-xl">⚡</span>
              </div>
              <div>
                <div className="flex items-center gap-2">
                  <h1 className="text-lg font-black gradient-text-cyan font-display uppercase tracking-wider text-glow">SMARTAI PRO</h1>
                  <span className="quantum-badge hidden sm:inline-flex">v{APP_VERSION}</span>
                </div>
                <div className="flex items-center gap-2 text-[11px]">
                  <span className={`w-1.5 h-1.5 rounded-full ${!isOnline ? 'bg-red-400 animate-pulse' : backend === 'live' ? 'bg-cyan-400 animate-pulse-dot' : backend === 'down' ? 'bg-red-400 animate-pulse' : 'bg-amber-500 animate-pulse'}`} />
                  <span className={`font-medium ${!isOnline || backend === 'down' ? 'text-red-400' : backend === 'live' ? 'text-cyan-500/80' : 'text-amber-400/80'}`}>
                    {!isOnline ? 'OFFLINE' : backend === 'live' ? 'LIVE' : backend === 'down' ? 'SERVER DOWN' : 'SYNCING'}
                  </span>
                  <span className="text-slate-700">•</span>
                  <IstClock />
                  {!isOnline && (
                    <span className="flex items-center gap-1 px-1.5 py-0.5 rounded bg-red-500/15 text-red-400 text-[9px] font-bold">
                      <WifiOff size={10} /> Offline
                    </span>
                  )}
                </div>
              </div>
            </div>

            {/* the TWO desks */}
            <div className="order-3 sm:order-2 w-full sm:w-auto flex gap-1 quantum-panel p-1 rounded-2xl max-w-full" role="tablist" aria-label="Trading desks">
              {DESK_ORDER.map((d, i) => (
                <button
                  key={d}
                  onClick={() => switchDesk(d)}
                  role="tab"
                  aria-selected={desk === d}
                  title={`${DESK_META[d].label} — press ${i + 1}`}
                  className={`quantum-tab flex-1 sm:flex-none px-4 sm:px-5 py-2.5 rounded-xl font-semibold text-sm whitespace-nowrap flex items-center justify-center gap-2 ${desk === d ? 'active' : 'text-slate-500 hover:text-slate-300 hover:bg-white/[0.03]'}`}
                >
                  <span>{DESK_META[d].icon}</span>
                  <span>{DESK_META[d].label}</span>
                </button>
              ))}
            </div>

            {/* right controls */}
            <div className="flex gap-2 relative order-2 sm:order-3 shrink-0">
              <button onClick={toggleTheme} aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`} className="quantum-btn-ghost p-2.5 rounded-xl text-lg min-w-[44px] min-h-[44px] flex items-center justify-center" title={`Toggle ${theme === 'dark' ? 'Light' : 'Dark'} Mode`}>{theme === 'dark' ? '🌞' : '🌙'}</button>
              <button onClick={logout} aria-label="Logout" className="quantum-btn-ghost p-2.5 rounded-xl text-lg min-w-[44px] min-h-[44px] flex items-center justify-center" title="Logout">🔐</button>
            </div>
          </div>
        </div>
      </header>

      {/* Desk content — each desk owns its streams; shell adds none */}
      <main className="container mx-auto px-4 py-4">
        <Suspense fallback={
          <div className="flex items-center justify-center py-20">
            <div className="text-center">
              <div className="text-4xl mb-3 animate-float">⚡</div>
              <div className="text-sm text-slate-500 font-medium">{DESK_META[desk].label} desk load ho rahi hai…</div>
            </div>
          </div>
        }>
          <ErrorBoundary key={desk} fallback={
            <div className="quantum-panel rounded-2xl p-8 text-center border border-red-500/20">
              <div className="text-4xl mb-3">🚨</div>
              <div className="text-red-400 font-bold mb-2">Desk crash</div>
              <div className="text-slate-500 text-sm">Reload karo ya dusri desk kholo</div>
            </div>
          }>
            {desk === 'india' && <IndiaIntradayTab />}
            {desk === 'crypto' && <CoinDcxTab />}
            {desk === 'bots' && <BotsTab />}
          </ErrorBoundary>
        </Suspense>
      </main>
    </div>
  );
}
