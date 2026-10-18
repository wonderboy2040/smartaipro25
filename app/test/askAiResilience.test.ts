// ============================================================
// test/askAiResilience.test.ts — v10.3.1 ASK-AI reliability
// ------------------------------------------------------------
// User report: "ASK AI theek se kaam nahi kar raha hai" — the
// intraday agent's first question after every cold boot walked a
// 30-90s NSE scan through UNBOUNDED sequential tool awaits and died
// at the 90s frontend gate. These tests pin the three fixes:
//   1. Tool timeout — a hanging tool degrades to an honest error at
//      the 20s bound instead of eating the whole request budget.
//   2. Stale-while-revalidate — get_live_intraday_signals serves a
//      cached scan instantly (age attached) and refreshes in the
//      background; only a zero-history boot blocks on the scan.
//   3. Cold cache still blocks exactly once (no stale data to serve).
// ============================================================
import { describe, it, expect, vi, afterEach } from 'vitest';
import { __internals } from '../server/intraday/agent.js';

const { executeAgentTool, withToolTimeout, TOOL_TIMEOUT_MS } = __internals;

afterEach(() => { vi.useRealTimers(); });

// ---------------- 1. tool timeout bound ----------------
describe('withToolTimeout (the Ask-AI freeze fix)', () => {
  it('passes a fast tool result through untouched', async () => {
    const out = await withToolTimeout(Promise.resolve({ ok: true, ltp: 123.45 }), 'get_intraday_quote');
    expect(out).toEqual({ ok: true, ltp: 123.45 });
  });

  it('a hanging tool degrades to an honest error at the bound', async () => {
    vi.useFakeTimers();
    const hanging = new Promise(() => {}); // never settles — a dead feed
    const p = withToolTimeout(hanging, 'get_live_intraday_signals');
    const assertion = expect(p).resolves.toMatchObject({
      error: expect.stringContaining('get_live_intraday_signals timeout'),
    });
    await vi.advanceTimersByTimeAsync(TOOL_TIMEOUT_MS);
    await assertion;
  });

  it('a tool that REJECTS after the race degrades safely (no unhandled rejection)', async () => {
    vi.useFakeTimers();
    const lateReject = new Promise((_, rej) => setTimeout(() => rej(new Error('feed died')), TOOL_TIMEOUT_MS + 5000));
    const p = withToolTimeout(lateReject, 'get_intraday_quote');
    const assertion = expect(p).resolves.toMatchObject({ error: expect.stringContaining('timeout') });
    await vi.advanceTimersByTimeAsync(TOOL_TIMEOUT_MS);
    await assertion;
    // advance past the late rejection — it must have been swallowed
    await vi.advanceTimersByTimeAsync(10_000);
  });
});

// ---------------- 2. stale-while-revalidate ----------------
describe('get_live_intraday_signals (stale-while-revalidate)', () => {
  it('serves a STALE cached scan instantly and refreshes in background', async () => {
    const stale = {
      asOf: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
      marketOpen: true,
      signals: [{ symbol: 'RELIANCE', direction: 'LONG', confidence: 82 }],
    };
    const triggerScan = vi.fn(async () => {
      await new Promise(r => setTimeout(r, 60));
      return { ...stale, asOf: new Date().toISOString(), refreshed: true };
    });
    const t0 = Date.now();
    const out = await executeAgentTool('get_live_intraday_signals', {}, {
      getLastScan: () => stale,
      triggerScan,
    });
    // Served from cache WITHOUT blocking on the (slow) live scan
    expect(Date.now() - t0).toBeLessThan(40);
    expect(out.signals[0].symbol).toBe('RELIANCE');
    expect(out.asOf).toBe(stale.asOf);
    // Background revalidation was kicked off
    await new Promise(r => setTimeout(r, 100));
    expect(triggerScan).toHaveBeenCalledTimes(1);
  });

  it('serves a FRESH scan (<3 min) without re-scanning at all', async () => {
    const fresh = {
      asOf: new Date(Date.now() - 30 * 1000).toISOString(),
      marketOpen: true,
      signals: [{ symbol: 'TATAMOTORS', direction: 'SHORT', confidence: 77 }],
    };
    const triggerScan = vi.fn(async () => { throw new Error('should not be called'); });
    const out = await executeAgentTool('get_live_intraday_signals', {}, {
      getLastScan: () => fresh,
      triggerScan,
    });
    expect(out.signals[0].symbol).toBe('TATAMOTORS');
    expect(triggerScan).not.toHaveBeenCalled();
  });

  it('a ZERO-history boot still blocks on the live scan exactly once', async () => {
    const cold = {
      asOf: new Date().toISOString(),
      marketOpen: true,
      signals: [{ symbol: 'HDFCBANK', direction: 'LONG', confidence: 88 }],
    };
    const triggerScan = vi.fn(async () => cold);
    const out = await executeAgentTool('get_live_intraday_signals', {}, {
      getLastScan: () => null,
      triggerScan,
    });
    expect(out.signals[0].symbol).toBe('HDFCBANK');
    expect(triggerScan).toHaveBeenCalledTimes(1);
  });

  it('an empty-signals cache is treated as cold (blocking scan)', async () => {
    const scan = {
      asOf: new Date().toISOString(),
      marketOpen: false,
      signals: [],
    };
    const triggerScan = vi.fn(async () => scan);
    const out = await executeAgentTool('get_live_intraday_signals', {}, {
      getLastScan: () => ({ ...scan, signals: [] }),
      triggerScan,
    });
    expect(out).toMatchObject({ marketOpen: false, signals: [] });
    expect(triggerScan).toHaveBeenCalledTimes(1);
  });
});
