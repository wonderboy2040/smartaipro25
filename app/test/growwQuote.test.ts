// ============================================================
// test/growwQuote.test.ts — v10.12 (India plan #2) the Groww
// resilience contract: quick jittered retry + per-symbol backoff.
//
// THE ASK (user plan):
//   • "transient failure → quick retry succeeds within the same cycle"
//     (one ~300-500ms retry INSIDE the fetch — a blip must not cost a
//     full 3s poll interval)
//   • "repeated failure → per-symbol backoff kicks in and resets on
//     next success" (a persistently-erroring symbol is skipped for one
//     poll cycle — honest null, zero upstream — while healthy symbols
//     keep polling at full cadence)
//
// Also locks the inherited micro-cache contract byte-for-byte:
//   • 3s micro-cache + in-flight promise sharing (N consumers = ONE
//     upstream round-trip + retry per symbol)
//   • .NS/.BO stripping, never-throws, source: 'groww-nse-realtime'
// Hermetic: no network — fetch is an injected test double.
// ============================================================
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const growwOk = (price = 2925.5) => ({
  ok: true,
  json: async () => ({
    ltp: price, dayChange: 12.5, dayChangePerc: 0.43, high: price + 10,
    low: price - 10, volume: 12345, lastTradeTime: Math.floor(Date.now() / 1000),
  }),
});

describe('growwQuote — micro-cache (inherited contract, byte-identical)', () => {
  let gq;
  let fetchMock;
  beforeEach(async () => {
    vi.resetModules();
    vi.useFakeTimers();
    gq = await import('../server/ai/growwQuote.js');
    gq.__resetGrowwForTests();
    fetchMock = vi.fn(async () => growwOk());
    gq._setGrowwFetchForTest(fetchMock);
  });
  afterEach(() => { vi.useRealTimers(); gq?.__resetGrowwForTests(); });

  it('serves the quote with the honest internal source label', async () => {
    const q = await gq.fetchGrowwNseQuote('RELIANCE');
    expect(q).toBeTruthy();
    expect(q.price).toBe(2925.5);
    expect(q.source).toBe('groww-nse-realtime');
    expect(q.prevClose).toBeCloseTo(2925.5 - 12.5, 6);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('strips .NS/.BO and normalizes case (same key → one round-trip)', async () => {
    await gq.fetchGrowwNseQuote('reliance.NS');
    await gq.fetchGrowwNseQuote('RELIANCE');
    await gq.fetchGrowwNseQuote('RELIANCE.BO');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('3s micro-cache: N consumers within the window share ONE round-trip', async () => {
    const [a, b, c] = await Promise.all([
      gq.fetchGrowwNseQuote('TCS'), gq.fetchGrowwNseQuote('TCS'), gq.fetchGrowwNseQuote('TCS'),
    ]);
    expect(a.price).toBe(b.price);
    expect(b.price).toBe(c.price);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(3100);
    await gq.fetchGrowwNseQuote('TCS');
    expect(fetchMock).toHaveBeenCalledTimes(2); // cache expired → one new round-trip
  });

  it('never throws — upstream exception resolves null (after the in-cycle retry)', async () => {
    gq._setGrowwFetchForTest(vi.fn(async () => { throw new Error('ECONNRESET'); }));
    const p = gq.fetchGrowwNseQuote('SBIN');
    // Fake timers: the fetch cycle contains the ~300-500ms retry sleep —
    // advance the clock to let it settle, THEN await.
    await vi.advanceTimersByTimeAsync(600);
    expect(await p).toBeNull();
  });

  it('empty/invalid symbol → null without any upstream call', async () => {
    expect(await gq.fetchGrowwNseQuote('')).toBeNull();
    expect(await gq.fetchGrowwNseQuote(null)).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('growwQuote — (#2.1) quick jittered retry inside the SAME cycle', () => {
  let gq;
  beforeEach(async () => {
    vi.resetModules();
    vi.useFakeTimers();
    gq = await import('../server/ai/growwQuote.js');
    gq.__resetGrowwForTests();
  });
  afterEach(() => { vi.useRealTimers(); gq?.__resetGrowwForTests(); });

  it('transient failure → the ~300-500ms retry SUCCEEDS in the same cycle (no 3s wait)', async () => {
    let calls = 0;
    gq._setGrowwFetchForTest(vi.fn(async () => {
      calls++;
      return calls === 1 ? { ok: false, status: 503 } : growwOk(1234);
    }));
    const p = gq.fetchGrowwNseQuote('HDFCBANK');
    await vi.advanceTimersByTimeAsync(600); // ride the jittered retry window
    const q = await p;
    expect(q).toBeTruthy();
    expect(q.price).toBe(1234);
    expect(calls).toBe(2); // fail → ONE retry → success (same fetch cycle)
    // The streak NEVER armed — the blip was absorbed by the retry:
    expect(gq.__growwStateForTests('HDFCBANK').failStreak).toBe(0);
    expect(gq.__growwStateForTests('HDFCBANK').backoffActive).toBe(false);
  });

  it('both attempts fail → null this cycle + streak 1 (no backoff yet — one bad cycle is not a pattern)', async () => {
    gq._setGrowwFetchForTest(vi.fn(async () => ({ ok: false, status: 500 })));
    const p = gq.fetchGrowwNseQuote('ITC');
    await vi.advanceTimersByTimeAsync(600);
    expect(await p).toBeNull();
    const st = gq.__growwStateForTests('ITC');
    expect(st.failStreak).toBe(1);
    expect(st.backoffActive).toBe(false);
  });
});

describe('growwQuote — (#2.2) per-symbol fail-streak backoff (skip 1 cycle)', () => {
  let gq;
  let fetchMock;
  beforeEach(async () => {
    vi.resetModules();
    vi.useFakeTimers();
    gq = await import('../server/ai/growwQuote.js');
    gq.__resetGrowwForTests();
    fetchMock = vi.fn(async () => ({ ok: false, status: 503 }));
    gq._setGrowwFetchForTest(fetchMock);
  });
  afterEach(() => { vi.useRealTimers(); gq?.__resetGrowwForTests(); });

  it('2 consecutive failed cycles → backoff arms: next call is an INSTANT null with ZERO upstream', async () => {
    // Cycle 1 (cold fetch + retry): fail.
    let p = gq.fetchGrowwNseQuote('TATASTEEL');
    await vi.advanceTimersByTimeAsync(600);
    expect(await p).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2);

    // Cache entry (null promise) expires after 3s → cycle 2: fail again.
    await vi.advanceTimersByTimeAsync(3100);
    p = gq.fetchGrowwNseQuote('TATASTEEL');
    await vi.advanceTimersByTimeAsync(600);
    expect(await p).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(4); // streak = 2 → backoff ARMED

    // Backoff window (4.5s from arming): instant null, no upstream at all.
    await vi.advanceTimersByTimeAsync(1000);
    const t0 = Date.now();
    p = gq.fetchGrowwNseQuote('TATASTEEL');
    expect(await p).toBeNull();
    expect(Date.now() - t0).toBeLessThan(50);          // INSTANT — no retry sleep either
    expect(fetchMock).toHaveBeenCalledTimes(4);        // ZERO new upstream calls
    expect(gq.__growwStateForTests('TATASTEEL').backoffActive).toBe(true);
  });

  it('backoff is PER-SYMBOL — a healthy symbol keeps full-cadence polling meanwhile', async () => {
    // Kill TATASTEEL twice (arm the backoff)…
    for (let i = 0; i < 2; i++) {
      const p = gq.fetchGrowwNseQuote('TATASTEEL');
      await vi.advanceTimersByTimeAsync(3100);
      await p;
    }
    expect(gq.__growwStateForTests('TATASTEEL').backoffActive).toBe(true);

    // …while MARUTI stays healthy the whole time:
    gq._setGrowwFetchForTest(vi.fn(async (url) =>
      String(url).includes('MARUTI') ? growwOk(4500) : { ok: false, status: 503 }));
    const q = await gq.fetchGrowwNseQuote('MARUTI');
    expect(q?.price).toBe(4500);
    expect(gq.__growwStateForTests('MARUTI').backoffActive).toBe(false);
    // And the erroring symbol is STILL held (no cross-symbol contagion):
    expect(gq.__growwStateForTests('TATASTEEL').backoffActive).toBe(true);
  });

  it('backoff EXPIRES → the probe resumes (never a frozen symbol)', async () => {
    for (let i = 0; i < 2; i++) {
      const p = gq.fetchGrowwNseQuote('CIPLA');
      await vi.advanceTimersByTimeAsync(3100);
      await p;
    }
    expect(gq.__growwStateForTests('CIPLA').backoffActive).toBe(true);

    // Ride out the 4.5s hold (from the aring moment) + the 3s cache null:
    await vi.advanceTimersByTimeAsync(8000);
    // Upstream is healthy again:
    gq._setGrowwFetchForTest(vi.fn(async () => growwOk(1500)));
    const q = await gq.fetchGrowwNseQuote('CIPLA');
    expect(q?.price).toBe(1500);
  });

  it('SUCCESS resets the fail-streak AND clears the backoff completely', async () => {
    // One failure (streak 1)…
    let p = gq.fetchGrowwNseQuote('SBIN');
    await vi.advanceTimersByTimeAsync(600);
    expect(await p).toBeNull();

    // …then a success on the retry cycle:
    gq._setGrowwFetchForTest(vi.fn(async () => growwOk(800)));
    await vi.advanceTimersByTimeAsync(3100); // cache expiry
    const q = await gq.fetchGrowwNseQuote('SBIN');
    expect(q?.price).toBe(800);
    const st = gq.__growwStateForTests('SBIN');
    expect(st.failStreak).toBe(0);
    expect(st.backoffUntil).toBe(0);
    expect(st.backoffActive).toBe(false);
  });

  it('steady state for a persistently-dead symbol: half-rate probing, never hammering', async () => {
    // 20 simulated seconds of a dead symbol at the natural 3s poll cadence —
    // count REAL upstream attempts (each fetch cycle = 2 attempts with the retry).
    const start = Date.now();
    while (Date.now() - start < 20_000) {
      const p = gq.fetchGrowwNseQuote('ONWARD');
      await vi.advanceTimersByTimeAsync(600);  // ride any in-cycle retry sleep
      await p;                                  // resolves (null)
      await vi.advanceTimersByTimeAsync(2400);  // rest of the 3s poll cadence
    }
    // Without backoff: ~7 polls × 2 attempts = ~14 upstream calls in 20s.
    // With skip-1-cycle backoff armed from failure #2 the clock alternates
    // probe-cycle → hold → probe-cycle: at most ~9 upstream attempts.
    expect(fetchMock.mock.calls.length).toBeLessThanOrEqual(9);
    expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(4); // never frozen silent either
  });
});
