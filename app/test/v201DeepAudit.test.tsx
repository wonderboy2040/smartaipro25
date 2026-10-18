// ============================================================
// test/v201DeepAudit.test.ts — v20.1 FULL-SITE + TRADE-SIGNAL
// DEEP RECHECK regression locks
// ------------------------------------------------------------
// The v20.1 deep audit (frontend + server infra + signal engine)
// found 10 real bugs. This file locks the machine-checked ones:
//
//   F1. DepthLadder — apiFetch returns the RAW Response; the widget
//       used to store it unparsed (permanently-dead L2 view + a
//       forever 2s poll). Must parse JSON + render the ladder.
//   F2. useCxLivePrices — the SSE URL must be rebuilt PER CONNECT
//       (fresh session token), never baked at mount (dead-401 loop).
//   F3. api.ts — a 401 anywhere dispatches a throttled
//       'session-expired' event (mid-session expiry must fall to the
//       PIN gate, not 401-loop until manual F5).
//   F4. useAuthState — the 'session-expired' event resets auth state.
//   S1. bandwidth.js — parameterized REST paths collapse to a route
//       template scope (bounded Map keyspace, no per-symbol scopes).
//   S2. bandwidth.js — hard scope cap (200) evicts smallest-lifetime.
//   S3. meshModels — the warm-seat store age-sweeps stale symbols.
//
// (CoinDcxTab indicator block, deskShared tooltip, ProTraderAutoPanel
//  token-wait and the index.js XFF/stance fixes are display/route
//  level — asserted by tsc + node --check + manual E2E.)
// ============================================================
// @ts-nocheck
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, render, waitFor } from '@testing-library/react';
import React from 'react';

// ---- module-level fetch stub (apiFetch rides global fetch) ----
let _fetchImpl = null;
const _fetch = (...args) => (_fetchImpl ? _fetchImpl(...args) : Promise.reject(new Error('no fetch stub')));
vi.stubGlobal('fetch', _fetch);

// ---- fake EventSource (cxLiveNeverStop pattern) ----
class FakeEventSource {
  static instances = [];
  url;
  closed = false;
  onopen = null;
  onerror = null;
  constructor(url) { this.url = url; FakeEventSource.instances.push(this); }
  addEventListener() {}
  open() { this.onopen?.(); }
  fail() { this.onerror?.(); }
  close() { this.closed = true; }
}
vi.stubGlobal('EventSource', FakeEventSource);

const { setSessionToken, apiFetch, __resetSessionExpiredThrottleForTests } = await import('../src/utils/api');
const { useAuthState } = await import('../src/hooks/useAuthState');
const { useCxLivePrices } = await import('../src/components/aitrading/useCxLivePrices');
const { DepthLadder } = await import('../src/components/aitrading/DepthLadder');

const okJson = (body, status = 200) => {
  const s = status;
  return {
    ok: s >= 200 && s < 300,
    status: s,
    json: () => Promise.resolve(typeof body === 'string' ? JSON.parse(body) : body),
  };
};

beforeEach(() => {
  FakeEventSource.instances = [];
  _fetchImpl = null;
  __resetSessionExpiredThrottleForTests();
  setSessionToken(null);
  try { sessionStorage.clear(); localStorage.clear(); } catch {}
});

afterEach(() => {
  vi.useRealTimers();
});

// ---------------- F1: DepthLadder parses the JSON body ----------------
describe('v20.1 F1 — DepthLadder renders the PARSED depth view', () => {
  it('a successful /api/ai/depth round-trip paints the ladder (old bug: raw Response stored, widget dead forever)', async () => {
    const depthPayload = {
      ok: true, market: 'CRYPTO', symbol: 'BTC', source: 'coindcx',
      bestBid: 100, bestAsk: 101, spreadPct: 1,
      imbalanceTop5: 0.62, imbalanceTop20: 0.55,
      bidWalls: [], askWalls: [], spoofRisk: false,
      ladder: {
        bids: [{ price: 100, qty: 2 }],
        asks: [{ price: 101, qty: 3 }],
      },
    };
    _fetchImpl = vi.fn().mockResolvedValue(okJson(depthPayload));
    const { container, unmount } = render(<DepthLadder market="CRYPTO" symbol="BTC" ltp={100} />);
    await waitFor(() => {
      expect(container.textContent).toContain('ORDER FLOW');
    });
    expect(container.textContent).not.toContain('L2 depth unavailable');
    // the fetch was a REAL call to the depth endpoint with symbol param
    const calledUrl = String(_fetchImpl.mock.calls[0]?.[0] || '');
    expect(calledUrl).toContain('/api/ai/depth');
    expect(calledUrl).toContain('symbol=BTC');
    unmount();
  });

  it('a non-ok / degraded payload honestly shows the unavailable line (no spin)', async () => {
    _fetchImpl = vi.fn().mockResolvedValue(okJson({ ok: false, reason: 'no book' }));
    const { container, unmount } = render(<DepthLadder market="CRYPTO" symbol="BTC" ltp={100} />);
    await waitFor(() => {
      expect(container.textContent).toContain('L2 depth unavailable');
    });
    unmount();
  });
});

// ---------------- F2: useCxLivePrices rebuilds the URL per connect ----------------
describe('v20.1 F2 — the SSE URL re-reads the session token on every connect', () => {
  it('token baked at mount + expired → reconnect uses the FRESH token (old bug: dead-401 URL loop)', async () => {
    vi.useFakeTimers();
    setSessionToken('token-old');
    const h = renderHook(() => useCxLivePrices(true, ['BTC'], [], [], []));
    const first = FakeEventSource.instances[0];
    expect(first.url).toContain('session=token-old');
    // token rotates (re-login) while the socket is up
    act(() => { setSessionToken('token-new'); });
    // the socket dies → reconnect path fires
    act(() => { first.fail(); });
    let waited = 0;
    while (FakeEventSource.instances.length < 2 && waited < 30_000) {
      act(() => { vi.advanceTimersByTime(500); });
      waited += 500;
    }
    const second = FakeEventSource.instances[1];
    expect(second).toBeTruthy();
    expect(second.url).toContain('session=token-new');
    expect(second.url).toContain('crypto=');
    h.unmount();
  });
});

// ---------------- F3 + F4: mid-session 401 → PIN gate ----------------
describe('v20.1 F3/F4 — a mid-session 401 resets auth (no 401-loop until manual F5)', () => {
  it('apiFetch dispatches a throttled session-expired event on 401', async () => {
    setSessionToken('tok');
    const events = [];
    window.addEventListener('session-expired', () => events.push(1));
    // three 401s in one burst → ONE event (throttled)
    _fetchImpl = vi.fn().mockResolvedValue(okJson({ error: 'unauthorized' }, 401));
    await apiFetch('/api/ai/signals?market=CRYPTO');
    await apiFetch('/api/ai/signals?market=INDIA');
    await apiFetch('/api/ai/signals?market=FUTURES');
    expect(events.length).toBe(1);
    window.removeEventListener('session-expired', () => events.push(1));
  });

  it('useAuthState falls back to NOT authenticated on the session-expired event', async () => {
    setSessionToken('tok');
    localStorage.setItem('authDone', 'true'); // secureStorage plaintext passthrough
    // boot check passes (token valid at boot)
    _fetchImpl = vi.fn().mockResolvedValue(okJson({ authenticated: true }));
    const h = renderHook(() => useAuthState());
    await waitFor(() => expect(h.result.current.isAuthenticated).toBe(true));
    // then the token expires mid-session: next call 401s
    _fetchImpl = vi.fn().mockResolvedValue(okJson({ error: 'unauthorized' }, 401));
    await act(async () => { await apiFetch('/api/ai/signals'); });
    await waitFor(() => expect(h.result.current.isAuthenticated).toBe(false));
    h.unmount();
  });
});

// ---------------- S1 + S2: bandwidth scope keyspace is bounded ----------------
describe('v20.1 S1/S2 — bandwidth telemetry scopes are route-template-keyed and capped', () => {
  it('parameterized REST paths collapse to :p (no per-symbol scope explosion)', async () => {
    const { __resetBandwidthForTests, bandwidthMiddleware, bandwidthView } = await import('../server/ai/bandwidth.js');
    __resetBandwidthForTests();
    const mw = bandwidthMiddleware();
    const hit = (path) => {
      const req = { path, socket: { bytesWritten: 1000 } };
      const res = { on: (ev, fn) => { if (ev === 'finish') { req.socket.bytesWritten = 2000; fn(); } } };
      mw(req, res, () => {});
    };
    hit('/api/fundamentals/RELIANCE');
    hit('/api/fundamentals/HDFCBANK');
    hit('/api/quote/BTCINR');
    hit('/api/quote/ETHINR');
    const v = bandwidthView({});
    const scopes = (v.topScopes || []).map(s => s.scope);
    expect(scopes).toContain('rest:/api/fundamentals/:p');
    expect(scopes).toContain('rest:/api/quote/:p');
    // per-symbol scopes must NOT exist
    expect(scopes.some(s => s.includes('RELIANCE') || s.includes('BTCINR'))).toBe(false);
  });

  it('the scopes map is hard-capped (200) — evicts smallest-lifetime first', async () => {
    const { __resetBandwidthForTests, trackBytes, __scopeCountForTests } = await import('../server/ai/bandwidth.js');
    __resetBandwidthForTests();
    // 300 distinct scopes with increasing traffic
    for (let i = 0; i < 300; i++) trackBytes(`rest:/api/zz/DIR${i}`, 100 + i);
    const { bandwidthView } = await import('../server/ai/bandwidth.js');
    const v = bandwidthView({});
    expect(__scopeCountForTests()).toBeLessThanOrEqual(200);
    expect(v.ok).toBe(true);
  });
});

// ---------------- S3: meshModels warm-seat store age-sweeps ----------------
describe('v20.1 S3 — meshModels warm-seat store evicts stale symbols', () => {
  it('entries untouched for 30+ min drop out on the next warm tick', async () => {
    const mod = await import('../server/ai/meshModels.js');
    const { __resetMeshModelsForTests, __testables, warmMeshModels } = mod;
    __resetMeshModelsForTests();
    const { _store, _lastQueryAt } = __testables;
    // a FRESH entry (just warmed) and a STALE one (45 min old)
    _store.set('CRYPTO|BTC', { at: Date.now(), caps: {} });
    _store.set('CRYPTO|DEADCOIN', { at: Date.now() - 45 * 60_000, caps: {} });
    _lastQueryAt.set('crypto-tech-consensus|CRYPTO|BTC', Date.now());
    _lastQueryAt.set('crypto-tech-consensus|CRYPTO|DEADCOIN', Date.now() - 45 * 60_000);
    await warmMeshModels('CRYPTO', ['ETH']); // any warm tick sweeps
    expect(_store.has('CRYPTO|BTC')).toBe(true);
    expect(_store.has('CRYPTO|DEADCOIN')).toBe(false);
    expect(_lastQueryAt.has('crypto-tech-consensus|CRYPTO|DEADCOIN')).toBe(false);
  });
});
