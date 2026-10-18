// ============================================================
// test/cxLiveNeverStop.test.tsx — v18.6.3 REALTIME NEVER STOPS (C1)
// ------------------------------------------------------------
// THE SYMPTOM (user): CoinDCX tab open → ~2 min later the tracker
// shows LIVE OFF, the command bar shows "live feed down — retrying",
// realtime prices stop. Whatever killed the socket (429 cap race,
// server restart, half-dead TCP), the OLD hook had three ways to stay
// dead forever:
//   • backoff capped at 30s (a restart looked like a dead panel)
//   • a leaked null-socket state with no pending timer → NEVER retried
//   • a zombie OPEN socket with zero frames → showed 'live' forever
//
// THE CONTRACT (locked here with a fake EventSource + fake timers):
//   1. error → reconnect within the 5s cap (never 30s again)
//   2. NEVER-STOP watchdog: a leaked dead state (no socket, no timer)
//      self-heals within one 10s watchdog tick
//   3. ZOMBIE KILL: open socket + visible tab + 45s of silence →
//      hard reconnect (status passes through 'connecting')
//   4. hidden ≥30s → status 'parked' (not the alarming 'down');
//      visible again → instant reconnect + 'live' on open
//   5. live ticks still land in state through the batcher
//   6. unmount → everything cleaned (no zombie intervals)
// ============================================================
// @ts-nocheck
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

// ---- fake EventSource (liveStreamResilience pattern) ----
class FakeEventSource {
  static instances: any[] = [];
  url: string;
  readyState = 0;
  closed = false;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  private listeners = new Map();
  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }
  addEventListener(ev: string, fn: any) {
    if (!this.listeners.has(ev)) this.listeners.set(ev, []);
    this.listeners.get(ev).push(fn);
  }
  open() { this.readyState = 1; this.onopen?.(); }
  fail() { this.onerror?.(); }
  serverEvent(ev: string, data: unknown) {
    for (const fn of [...(this.listeners.get(ev) || [])]) fn({ data: JSON.stringify(data) });
  }
  close() { if (!this.closed) { this.closed = true; this.readyState = 2; } }
}

const { useCxLivePrices } = await import('../src/components/aitrading/useCxLivePrices');

const hide = () => Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
const show = () => Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
const vis = () => document.dispatchEvent(new Event('visibilitychange'));

describe('useCxLivePrices — v18.6.3 never-stop engine', () => {
  beforeEach(() => {
    FakeEventSource.instances = [];
    vi.stubGlobal('EventSource', FakeEventSource);
    vi.useFakeTimers();
    localStorage.clear();
    show();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  const mount = (spot = ['BTC']) => renderHook(
    () => useCxLivePrices(true, spot, [], [], []),
  );

  it('connects + goes live on open; ticks land in state', () => {
    const h = mount();
    const es = FakeEventSource.instances[0];
    expect(es).toBeTruthy();
    expect(h.result.current.status).toBe('connecting');
    act(() => { es.open(); });
    expect(h.result.current.status).toBe('live');
    act(() => {
      es.serverEvent('snapshot', { IN_BTC: { price: 100, change: 1, time: Date.now() } });
    });
    expect(h.result.current.ticks.IN_BTC?.price).toBe(100);
    h.unmount();
  });

  it('CONTRACT 1 — sustained error streak: every reconnect gap ≤ 5s cap (the old cap was 30s)', () => {
    const h = mount();
    // fail EVERY socket as it spawns (server down for the whole streak) —
    // measure the gaps between reconnect attempts
    const gaps: number[] = [];
    for (let i = 0; i < 6; i++) {
      const before = FakeEventSource.instances.length;
      const cur = FakeEventSource.instances[before - 1];
      act(() => { cur.fail(); });
      let waited = 0;
      while (FakeEventSource.instances.length === before && waited < 31_000) {
        act(() => { vi.advanceTimersByTime(500); });
        waited += 500;
      }
      gaps.push(waited);
    }
    expect(gaps.length).toBe(6);
    // never a 30s+ dark window again (old BACKOFF_MAX_MS=30_000)
    expect(Math.max(...gaps)).toBeLessThanOrEqual(5_500);
    expect(h.result.current.status).toBe('down');
    // and it RECOVERS: next socket opens clean → live
    const fresh = FakeEventSource.instances[FakeEventSource.instances.length - 1];
    act(() => { fresh.open(); });
    expect(h.result.current.status).toBe('live');
    h.unmount();
  });

  it('CONTRACT 2 — NEVER-STOP watchdog: a stuck "parked" state (missed visibilitychange) self-heals ≤10s', () => {
    const h = mount();
    const es = FakeEventSource.instances[0];
    act(() => { es.open(); });
    // user hides (trades on the exchange site in another tab) → parked
    act(() => { hide(); vis(); });
    act(() => { vi.advanceTimersByTime(31_000); });
    expect(h.result.current.status).toBe('parked');
    // THE STUCK STATE: the tab becomes visible again but the
    // visibilitychange event is MISSED (fired during a render) — the
    // OLD hook sat parked with no socket forever = permanent
    // "live feed down — retrying". The watchdog must unpark + connect.
    show(); // NO vis() dispatch — the event is lost
    act(() => { vi.advanceTimersByTime(10_000); });
    const fresh = FakeEventSource.instances[1];
    expect(fresh).toBeTruthy();
    act(() => { fresh.open(); });
    expect(h.result.current.status).toBe('live');
    h.unmount();
  });

  it('CONTRACT 3 — ZOMBIE KILL: 45s of silence on an open socket → hard reconnect', () => {
    const h = mount();
    const es = FakeEventSource.instances[0];
    act(() => { es.open(); });
    act(() => { es.serverEvent('snapshot', { IN_BTC: { price: 100, change: 0, time: Date.now() } }); });
    expect(h.result.current.status).toBe('live');
    // watchdog ticks every 10s: at the 40s tick silence is 40s (< 45) —
    // still trusted
    act(() => { vi.advanceTimersByTime(44_000); });
    expect(FakeEventSource.instances.length).toBe(1);
    expect(es.closed).toBe(false);
    // the 50s watchdog tick sees silence > 45s → zombie dies, fresh socket
    act(() => { vi.advanceTimersByTime(10_000); });
    expect(FakeEventSource.instances.length).toBe(2);
    expect(es.closed).toBe(true);
    const fresh = FakeEventSource.instances[1];
    act(() => { fresh.open(); });
    expect(h.result.current.status).toBe('live');
    h.unmount();
  });

  it('CONTRACT 4 — hidden ≥30s → status "parked" (not "down"); visible → instant live', () => {
    const h = mount();
    const es = FakeEventSource.instances[0];
    act(() => { es.open(); });
    // hide the tab (user trades on the exchange site in another tab)
    act(() => { hide(); vis(); });
    act(() => { vi.advanceTimersByTime(31_000); });
    expect(h.result.current.status).toBe('parked');
    expect(es.closed).toBe(true);
    // user comes back — instant reconnect, live again
    act(() => { show(); vis(); });
    const fresh = FakeEventSource.instances[1];
    expect(fresh).toBeTruthy();
    act(() => { fresh.open(); });
    expect(h.result.current.status).toBe('live');
    h.unmount();
  });

  it('CONTRACT 5 — brief hide (<30s) keeps the socket; keepalive frames keep the zombie-kill clock fresh', () => {
    const h = mount();
    const es = FakeEventSource.instances[0];
    act(() => { es.open(); });
    act(() => { hide(); vis(); });
    act(() => { vi.advanceTimersByTime(25_000); });
    expect(h.result.current.status).toBe('live'); // not parked yet
    expect(es.closed).toBe(false);
    // the server's 15s keepalive lands while hidden — clock stays fresh
    act(() => { es.serverEvent('status', { cxRt: { connected: true } }); });
    act(() => { show(); vis(); });
    // 40s pass with a keepalive frame midway — silence never crosses 45s
    act(() => { vi.advanceTimersByTime(20_000); });
    act(() => { es.serverEvent('status', { cxRt: { connected: true } }); });
    act(() => { vi.advanceTimersByTime(20_000); });
    expect(es.closed).toBe(false); // SAME socket — never zombie-killed
    expect(FakeEventSource.instances.length).toBe(1);
    h.unmount();
  });

  it('CONTRACT 6 — unmount cleans every timer (no zombie reconnects after teardown)', () => {
    const h = mount();
    const es = FakeEventSource.instances[0];
    act(() => { es.open(); });
    h.unmount();
    const count = FakeEventSource.instances.length;
    act(() => { vi.advanceTimersByTime(120_000); });
    expect(FakeEventSource.instances.length).toBe(count); // nothing reconnected
    expect(es.closed).toBe(true);
  });
});
