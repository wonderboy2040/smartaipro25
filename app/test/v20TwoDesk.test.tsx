// ============================================================
// test/v20TwoDesk.test.tsx — v20.0 TWO-DESK REBUILD CONTRACTS
// ------------------------------------------------------------
// Locks the v20 "sirf Intraday + CoinDCX" directive:
//   1. The shell renders EXACTLY the trading desks (india, crypto)
//      + the v20.8.0 Bot Lab desk (jev bot lab — a DESK, not a
//      resurrected dashboard: per-bot cards + decision stream)
//   2. Removed features STAY removed (file-level guard — a
//      careless merge that resurrects useAppState/NeuralChat/
//      PortfolioTab fails here, not in production)
//   3. useAuthState: server-side PIN contract + heartbeat shape
//   4. SW never caches /api/* (private-data rule survives v20)
//   5. Deep-link + keyboard desk switching
// ============================================================
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';

const read = (p: string) => readFileSync(p, 'utf8');

describe('v20.0 two-desk terminal — shell contracts', () => {
  it('App.tsx defines exactly the trading desks + v20.8 Bot Lab desk', () => {
    const src = read('src/App.tsx');
    expect(src).toMatch(/type Desk = 'india' \| 'crypto' \| 'bots'/);
    expect(src).toMatch(/const DESK_ORDER: Desk\[\] = \['india', 'crypto', 'bots'\]/);
    expect(src).toMatch(/lazyWithRetry\(\(\) => import\('\.\/components\/tabs\/BotsTab'\), 'bots'\)/);
    // no dead legacy desk can sneak in
    expect(src).not.toMatch(/'dashboard'|'portfolio'|'planner'|'macro'/);
  });

  it('App.tsx renders both desks via lazyWithRetry with ErrorBoundary', () => {
    const src = read('src/App.tsx');
    expect(src).toMatch(/lazyWithRetry\(\(\) => import\('\.\/components\/tabs\/IndiaIntradayTab'\), 'india'\)/);
    expect(src).toMatch(/lazyWithRetry\(\(\) => import\('\.\/components\/tabs\/CoinDcxTab'\), 'coindcx'\)/);
    expect(src).toMatch(/<ErrorBoundary key=\{desk\}/);
  });

  it('App.tsx shell has ZERO recurring network loops beyond the 30s heartbeat', () => {
    const src = read('src/App.tsx');
    // the only interval in the shell is the IST clock (1s, local) — no fetch loops
    const intervals = src.match(/setInterval\(/g) || [];
    expect(intervals.length).toBeLessThanOrEqual(1);
    expect(src).not.toMatch(/apiFetch/); // shell never fetches business data
  });

  it('login screen: inline error (no alert), busy state, maxLength=32 strong-PIN', () => {
    const src = read('src/App.tsx');
    expect(src).toMatch(/maxLength=\{32\}/);
    expect(src).toMatch(/loginError &&/);
    expect(src).not.toMatch(/alert\(/);
  });
});

describe('v20.0 two-desk terminal — removed-feature guards (file level)', () => {
  const REMOVED = [
    'src/hooks/useAppState.ts',
    'src/hooks/AppContext.ts',
    'src/hooks/usePrefetch.ts',
    'src/hooks/useKeyboardShortcuts.tsx',
    'src/components/NeuralChat.tsx',
    'src/components/PortfolioHealthMonitor.tsx',
    'src/components/InstallPWA.tsx',
    'src/components/tabs/DashboardTab.tsx',
    'src/components/tabs/PortfolioTab.tsx',
    'src/components/tabs/PlannerTab.tsx',
    'src/components/tabs/MacroTab.tsx',
    'src/utils/liveStream.ts',
    'src/utils/tvWebsocket.ts',
    'src/utils/portfolioInsights.ts',
    'src/utils/wealthEngine.ts',
    'public/widget.html',
  ];
  it.each(REMOVED)('%s stays deleted', (f) => {
    expect(existsSync(f)).toBe(false);
  });

  it('main.tsx mounts App without the old global context', () => {
    const src = read('src/main.tsx');
    expect(src).toMatch(/import App from "\.\/App"/);
    expect(src).not.toMatch(/AppContext/);
  });
});

describe('v20.0 useAuthState — auth + heartbeat contracts', () => {
  it('PIN goes to the server (/api/auth/login), never client-compared', () => {
    const src = read('src/hooks/useAuthState.ts');
    expect(src).toMatch(/\/api\/auth\/login/);
    expect(src).toMatch(/\/api\/auth\/logout/);
    expect(src).toMatch(/ensureAuthenticated/);
    expect(src).not.toMatch(/VITE_SECURE_PIN/);
  });

  it('heartbeat: /api/ping, 30s interval, 4s abort timeout', () => {
    const src = read('src/hooks/useAuthState.ts');
    expect(src).toMatch(/HEARTBEAT_MS = 30_000/);
    expect(src).toMatch(/HEARTBEAT_TIMEOUT_MS = 4_000/);
    expect(src).toMatch(/\/api\/ping/);
    expect(src).toMatch(/AbortController/);
  });

  it('session restore is instant (no await before setIsAuthenticated)', () => {
    const src = read('src/hooks/useAuthState.ts');
    expect(src).toMatch(/setSessionToken\(token\);\s*\n\s*setIsAuthenticated\(true\)/);
    expect(src).toMatch(/ensureAuthenticated\(\)\.then/);
  });
});

describe('v20.0 service worker — private-data + lean shell', () => {
  it('ALL /api/* traffic is network-only (never cached)', () => {
    const src = read('public/sw.js');
    expect(src).toMatch(/url\.pathname\.startsWith\('\/api\/'\)\) return;/);
    expect(src).not.toMatch(/PUBLIC_API/);
  });

  it('portfolio background-sync engine is gone', () => {
    const src = read('public/sw.js');
    expect(src).not.toMatch(/periodicsync/);
    expect(src).not.toMatch(/widget-data/);
    expect(src).not.toMatch(/cloud\/load/);
  });

  it('activate evicts every non-v20 cache (old private leftovers die)', () => {
    const src = read('public/sw.js');
    expect(src).toMatch(/k !== CACHE_VERSION/);
    expect(src).toMatch(/'smartai-pro-v20'/);
  });
});
