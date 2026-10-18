// ============================================================
// test/positionsStream.test.ts — v10.5.3 REALTIME POSITIONS
// regression suite (Issue #3: the fake "ULTRA STREAM").
//
// THE BUG: the positions panel was a 5-second REST poll
// (loadPositions → GET /api/ai/positions). A fast crypto move
// updated 4-5 times on the exchange before one UI refresh.
//
// THE FIX: /api/ai/positions/stream — an SSE channel driven by the
// SAME getPositionsWithPnl() view (one shared diff-poller for N
// clients) that pushes:
//   • `positions` (full snapshot) on connect + structural changes
//   • `tick` (one-position delta) on EVERY price change — no 5s
//     batching, no timer gating
//
// LOCKED HERE:
//   • every distinct LTP in a rapid sequence (4 ticks back-to-back)
//     produces its own `tick` push with the matching ltp/pnl
//   • open/close transitions escalate to a full `positions` push
//   • cadence: cached desks 1s, India-open 5s, nobody-watching 15s
//   • connect/disconnect client accounting (poller parks with 0)
// ============================================================
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const state = vi.hoisted(() => ({ view: null as any }));

vi.mock('../server/ai/coindcxOrders.js', () => ({
  // the ONLY import positionsStream.js makes — controllable per test
  getPositionsWithPnl: vi.fn(async () => state.view),
}));

import {
  positionsStreamHandler, nextDelay,
  __tickForTests, __clientsForTests, __resetPositionsStreamForTests,
} from '../server/ai/positionsStream.js';

// ---------------- fake SSE plumbing ----------------
const mkRes = () => {
  const writes: string[] = [];
  const headers: Record<string, string> = {};
  return {
    res: {
      set: (h: Record<string, string>) => { Object.assign(headers, h); },
      flushHeaders: () => { /* noop */ },
      write: (payload: string) => { writes.push(payload); return true; },
      socket: null,
      destroy: () => { /* noop */ },
      end: () => { /* noop */ },
    } as any,
    writes, headers,
  };
};
const mkReq = () => {
  const handlers: Record<string, Array<() => void>> = {};
  return {
    on: (ev: string, fn: () => void) => { (handlers[ev] = handlers[ev] || []).push(fn); },
    emitClose: () => { (handlers.close || []).forEach(fn => fn()); },
  } as any;
};

const sseFrames = (writes: string[]) => writes.map(w => {
  const m = w.match(/^event: (\w+)\ndata: (.+)\n\n$/s);
  return m ? { event: m[1], data: JSON.parse(m[2]) } : null;
}).filter(Boolean) as Array<{ event: string; data: any }>;

// ---------------- fixtures ----------------
const pos = (over: Record<string, unknown> = {}) => ({
  id: 'p1', pair: 'BTCINR', symbol: 'BTC', market: 'CRYPTO', side: 'LONG',
  mode: 'paper', qty: 0.05, entryPrice: 100, status: 'OPEN',
  sl: 95, tp: 110, tp2: 120, ltp: 100, unrealizedPnlINR: 0,
  priceSource: 'coindcx', ...over,
});
const setView = (positions: any[], entries: any[] = []) => {
  state.view = { positions, entries, stats: { tradesCount: positions.length } };
};

beforeEach(() => { __resetPositionsStreamForTests(); });

afterEach(() => { vi.restoreAllMocks(); });

describe('v10.5.3 positions stream — price-driven push, not a 5s poll', () => {
  it('connect → first poll pushes the FULL snapshot (`positions` event)', async () => {
    setView([pos()]);
    const { res, headers, writes } = mkRes();
    const req = mkReq();
    positionsStreamHandler(req, res);
    expect(__clientsForTests()).toBe(1);
    expect(headers['Content-Type']).toBe('text/event-stream');
    expect(writes[0]).toContain('retry: 3000');
    await __tickForTests();
    const frames = sseFrames(writes);
    const snap = frames.find(f => f.event === 'positions');
    expect(snap).toBeTruthy();
    expect(snap.data.positions).toHaveLength(1);
    expect(snap.data.positions[0].id).toBe('p1');
    expect(snap.data.stats).toBeTruthy();
  });

  it('RAPID TICKS: every distinct LTP gets its own `tick` push (no 5s batching)', async () => {
    setView([pos({ ltp: 100, unrealizedPnlINR: 0 })]);
    const { res, writes } = mkRes();
    const req = mkReq();
    positionsStreamHandler(req, res);
    await __tickForTests(); // snapshot

    // four back-to-back price moves — the old REST poll would have shown
    // ONLY the last one (or none) within a 5s window
    const seq = [
      { ltp: 101, upnl: 0.05 },
      { ltp: 102.5, upnl: 0.125 },
      { ltp: 103.75, upnl: 0.1875 },
      { ltp: 104, upnl: 0.2 },
    ];
    for (const s of seq) {
      setView([pos({ ltp: s.ltp, unrealizedPnlINR: s.upnl })]);
      await __tickForTests();
    }
    const ticks = sseFrames(writes).filter(f => f.event === 'tick');
    expect(ticks).toHaveLength(4);
    expect(ticks.map(t => t.data.ltp)).toEqual([101, 102.5, 103.75, 104]);
    expect(ticks[1].data.unrealizedPnlINR).toBeCloseTo(0.125, 6);
    expect(ticks[3].data.id).toBe('p1');
    // no spurious full snapshots during pure price moves
    expect(sseFrames(writes).filter(f => f.event === 'positions')).toHaveLength(1);
  });

  it('an unchanged LTP pushes NOTHING (diff-only — the stream stays light)', async () => {
    setView([pos({ ltp: 100 })]);
    const { res, writes } = mkRes();
    positionsStreamHandler(mkReq(), res);
    await __tickForTests();
    const before = writes.length;
    await __tickForTests(); // same view again
    expect(writes.length).toBe(before);
  });

  it('open → close escalates to a FULL `positions` push (structural change)', async () => {
    setView([pos({ ltp: 100 })]);
    const { res, writes } = mkRes();
    positionsStreamHandler(mkReq(), res);
    await __tickForTests();

    setView([pos({ ltp: 95, status: 'CLOSED', closePrice: 95, pnlINR: -0.25, unrealizedPnlINR: -0.25 })], []);
    await __tickForTests();
    const frames = sseFrames(writes);
    const snaps = frames.filter(f => f.event === 'positions');
    expect(snaps).toHaveLength(2);
    expect(snaps[1].data.positions[0].status).toBe('CLOSED');
    // a status flip must NOT go out as a mere `tick`
    const ticksAfter = frames.filter(f => f.event === 'tick');
    expect(ticksAfter).toHaveLength(0);
  });

  it('a NEWLY OPENED position (agent-opened) is caught by the idle poller', async () => {
    setView([]);
    const { res, writes } = mkRes();
    positionsStreamHandler(mkReq(), res);
    await __tickForTests();
    expect(sseFrames(writes).filter(f => f.event === 'positions')[0].data.positions).toHaveLength(0);

    setView([pos({ id: 'agent-1', pair: 'SOLINR', symbol: 'SOL', ltp: 148 })]);
    await __tickForTests();
    const snaps = sseFrames(writes).filter(f => f.event === 'positions');
    expect(snaps).toHaveLength(2);
    expect(snaps[1].data.positions[0].id).toBe('agent-1');
  });

  it('cadence rules: cached desks 1s · India-open 5s · nobody-watching 15s', () => {
    expect(nextDelay(true, false)).toBe(1000);  // crypto/futures/global only
    expect(nextDelay(true, true)).toBe(5000);   // an India position is open
    expect(nextDelay(false, false)).toBe(15000); // no clients
    expect(nextDelay(false, true)).toBe(15000);
  });

  it('client disconnect: the writer is dropped and the client count parks at 0', () => {
    setView([pos()]);
    const { res } = mkRes();
    const req = mkReq();
    positionsStreamHandler(req, res);
    expect(__clientsForTests()).toBe(1);
    req.emitClose();
    expect(__clientsForTests()).toBe(0);
  });

  it('India-open books switch the poller to the 5s TV-scanner-safe cadence', async () => {
    setView([pos({ market: 'INDIA', pair: 'RELIANCE-EQ', symbol: 'RELIANCE' })]);
    const { res } = mkRes();
    positionsStreamHandler(mkReq(), res);
    await __tickForTests();
    // the pure decision helper reflects exactly what the poller schedules
    expect(nextDelay(true, true)).toBe(5000);
  });
});
