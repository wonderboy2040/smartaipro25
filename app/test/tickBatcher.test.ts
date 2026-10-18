// ============================================================
// test/tickBatcher.test.ts — v10.17 RENDER-STORM KILLER
// ------------------------------------------------------------
// Locks the batching contract: N rapid ticks → ONE apply call per
// flush window, latest-per-id wins, partial deltas merge, hidden
// tabs never render, structural flushNow forces through, dispose
// cleans up.
// ============================================================
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createTickBatcher } from '../src/utils/tickBatcher';

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('createTickBatcher — buffered ingestion', () => {
  it('N rapid ticks for N ids → ONE apply call with all N deltas', () => {
    const applied: number[][] = [];
    const b = createTickBatcher<{ id: string; ltp: number }>((deltas) => {
      applied.push(deltas.map(d => d.ltp));
    }, { intervalMs: 800 });

    for (let i = 0; i < 20; i++) b.push({ id: `p${i % 5}`, ltp: 100 + i });
    expect(b.pending()).toBe(5); // 20 ticks collapsed to 5 ids
    vi.advanceTimersByTime(800);
    // latest per id: p0←i15(115) · p1←i16 · p2←i17 · p3←i18 · p4←i19
    expect(applied).toEqual([[115, 116, 117, 118, 119]]);
    expect(applied).toHaveLength(1); // ONE render, not 20
    expect(b.pending()).toBe(0);
    b.dispose();
  });

  it('20 back-to-back price changes → exactly 1 state update in the window', () => {
    let renders = 0;
    const b = createTickBatcher<{ id: string; ltp: number }>(() => { renders++; }, { intervalMs: 800 });
    for (let i = 0; i < 20; i++) b.push({ id: 'BTC', ltp: 100 + i });
    vi.advanceTimersByTime(800);
    expect(renders).toBe(1); // the old code did 20
    b.dispose();
  });

  it('later ticks overwrite earlier ones for the SAME id (latest wins)', () => {
    const seen: Array<Record<string, number>> = [];
    const b = createTickBatcher<{ id: string; ltp: number; upnl?: number }>((d) => {
      seen.push(Object.fromEntries(d.map(x => [x.id, x.ltp])));
    }, { intervalMs: 500 });
    b.push({ id: 'A', ltp: 100 });
    b.push({ id: 'A', ltp: 101 });
    b.push({ id: 'A', ltp: 102 });
    vi.advanceTimersByTime(500);
    expect(seen[0]).toEqual({ A: 102 });
    b.dispose();
  });

  it('partial deltas MERGE over the buffered row (wire-legit omissions kept)', () => {
    const seen: Array<Array<{ id: string; ltp?: number; upnl?: number }>> = [];
    const b = createTickBatcher<{ id: string; ltp?: number; upnl?: number }>((d) => { seen.push(d); }, { intervalMs: 500 });
    b.push({ id: 'A', ltp: 100, upnl: 5 });
    b.push({ id: 'A', upnl: 7 }); // partial: ltp omitted on the wire
    vi.advanceTimersByTime(500);
    expect(seen[0][0]).toEqual({ id: 'A', ltp: 100, upnl: 7 }); // ltp kept, upnl fresh
    b.dispose();
  });

  it('hidden tab → flush is a no-op (zero background renders); nothing is lost', () => {
    let renders = 0;
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
    const b = createTickBatcher<{ id: string; ltp: number }>(() => { renders++; }, { intervalMs: 800 });
    b.push({ id: 'A', ltp: 100 });
    vi.advanceTimersByTime(2400); // three flush windows while hidden
    expect(renders).toBe(0);
    expect(b.pending()).toBe(1); // buffered — not dropped
    (document as any).__restore?.();
    b.dispose();
  });

  it('flushNow forces through even while hidden (structural snapshot path)', () => {
    let renders = 0;
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
    const b = createTickBatcher<{ id: string; ltp: number }>(() => { renders++; }, { intervalMs: 800 });
    b.push({ id: 'A', ltp: 100 });
    b.flushNow();
    expect(renders).toBe(1);
    b.dispose();
  });

  it('empty buffer never fires apply', () => {
    let renders = 0;
    const b = createTickBatcher<{ id: string; ltp: number }>(() => { renders++; }, { intervalMs: 100 });
    vi.advanceTimersByTime(1000);
    expect(renders).toBe(0);
    b.dispose();
  });

  it('dispose stops the interval and drops the buffer', () => {
    let renders = 0;
    const b = createTickBatcher<{ id: string; ltp: number }>(() => { renders++; }, { intervalMs: 100 });
    b.push({ id: 'A', ltp: 1 });
    b.dispose();
    vi.advanceTimersByTime(1000);
    expect(renders).toBe(0);
    expect(b.pending()).toBe(0);
  });

  it('garbage deltas (no id / null) are dropped safely', () => {
    const b = createTickBatcher<{ id: string; ltp: number }>(() => {}, { intervalMs: 100 });
    expect(() => {
      (b as unknown as { push: (d: unknown) => void }).push(null);
      (b as unknown as { push: (d: unknown) => void }).push({ ltp: 1 });
      (b as unknown as { push: (d: unknown) => void }).push({ id: 42, ltp: 2 });
    }).not.toThrow();
    expect(b.pending()).toBe(0);
    b.dispose();
  });

  it('visibilitychange → instant flush (tab comes back live)', () => {
    let renders = 0;
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
    const b = createTickBatcher<{ id: string; ltp: number }>(() => { renders++; }, { intervalMs: 60_000 });
    b.push({ id: 'A', ltp: 100 });
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
    document.dispatchEvent(new Event('visibilitychange'));
    expect(renders).toBe(1);
    b.dispose();
  });
});
