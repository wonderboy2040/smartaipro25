// ============================================================
// test/wickFilter.test.ts — v10.6 CROSS-EXCHANGE PRICE VALIDATION
// (Pro Upgrade #3) regression suite.
//
// LOCKED HERE:
//   • deviation ≤ threshold → ACCEPT (clean tick, no state)
//   • deviation > threshold, first sighting → SUPPRESS (no action)
//   • price back in line → episode closes as a WICK (auditable) and
//     the wickJournalEntry shape carries the wick_suppressed tag
//   • deviation persists past the revert window → ACCEPT sustained
//     (a real move / real venue divergence — never block forever)
//   • no reference (Binance down / symbol absent) → pass-through
//   • majors 0.5% vs alts 1.5% threshold tiers + env overrides
//   • kill switch AI_DISABLE_WICK_FILTER=1 → everything ACCEPTs
//   • CRYPTO (INR) normalization through the live USDTINR rate
//   • episode state never leaks across (market, base) keys
// ============================================================
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const state = vi.hoisted(() => ({ usdtInr: null as number | null }));

vi.mock('../server/cryptoStream.js', () => ({
  fetchCoinDcxTickers: vi.fn(async () => (
    state.usdtInr != null ? [{ market: 'USDTINR', last_price: String(state.usdtInr) }] : []
  )),
}));

import {
  assessTick, validateTick, wickFilterEnabled, wickThresholdPct,
  wickJournalEntry, wickFilterStatus, REVERT_WINDOW, __testables,
} from '../server/ai/wickFilter.js';

const MAJOR = 'BTC';
const ALT = 'SOLARIS'; // not in the majors set

beforeEach(() => {
  __testables.__resetWickForTests();
  state.usdtInr = null;
  delete process.env.AI_DISABLE_WICK_FILTER;
  delete process.env.AI_WICK_THRESHOLD_PCT;
  delete process.env.AI_WICK_ALT_THRESHOLD_PCT;
});
afterEach(() => {
  delete process.env.AI_DISABLE_WICK_FILTER;
  delete process.env.AI_WICK_THRESHOLD_PCT;
  delete process.env.AI_WICK_ALT_THRESHOLD_PCT;
});

describe('wickFilter thresholds (Pro #3)', () => {
  it('majors get the tight band, alts the wide one', () => {
    expect(wickThresholdPct('BTC')).toBe(0.5);
    expect(wickThresholdPct('SOLARIS')).toBe(1.5);
  });
  it('env overrides both tiers', () => {
    process.env.AI_WICK_THRESHOLD_PCT = '0.3';
    process.env.AI_WICK_ALT_THRESHOLD_PCT = '2.0';
    expect(wickThresholdPct('BTC')).toBe(0.3);
    expect(wickThresholdPct('SOLARIS')).toBe(2.0);
  });
  it('kill switch disables the filter', () => {
    process.env.AI_DISABLE_WICK_FILTER = '1';
    expect(wickFilterEnabled()).toBe(false);
    delete process.env.AI_DISABLE_WICK_FILTER;
    expect(wickFilterEnabled()).toBe(true);
  });
});

describe('assessTick — the state machine (PURE)', () => {
  it('clean tick → ACCEPT, no episode', () => {
    const v = assessTick({ market: 'CRYPTO', base: MAJOR, price: 100, refPrice: 100.2 });
    expect(v.action).toBe('ACCEPT');
    expect(v.episode).toBeNull();
    expect(v.deviationPct).toBeLessThan(0.5);
  });

  it('first deviating tick → SUPPRESS (the wick gets a chance to revert)', () => {
    const v = assessTick({ market: 'CRYPTO', base: MAJOR, price: 103, refPrice: 100 });
    expect(v.action).toBe('SUPPRESS');
    expect(v.deviationPct).toBeCloseTo(3, 1);
    expect(v.firstSeen).toBeGreaterThan(0);
  });

  it('revert → the episode CLOSES as a wick (auditable, exactly once)', () => {
    assessTick({ market: 'CRYPTO', base: MAJOR, price: 103, refPrice: 100, now: 1000 });
    const back = assessTick({ market: 'CRYPTO', base: MAJOR, price: 100.1, refPrice: 100, now: 2000 });
    expect(back.action).toBe('ACCEPT');
    expect(back.episode).toBe('wick');
    expect(back.firstSeen).toBe(1000);
    // state cleared — the next clean tick is a plain ACCEPT, not another wick close
    const again = assessTick({ market: 'CRYPTO', base: MAJOR, price: 100.1, refPrice: 100, now: 3000 });
    expect(again.episode).toBeNull();
  });

  it('deviation persisting past the revert window → ACCEPT sustained (a real move)', () => {
    assessTick({ market: 'CRYPTO', base: MAJOR, price: 103, refPrice: 100, now: 1000 });
    const later = assessTick({ market: 'CRYPTO', base: MAJOR, price: 103.2, refPrice: 100, now: 1000 + REVERT_WINDOW + 1 });
    expect(later.action).toBe('ACCEPT');
    expect(later.episode).toBe('sustained');
  });

  it('deviation INSIDE the window keeps suppressing', () => {
    assessTick({ market: 'CRYPTO', base: MAJOR, price: 103, refPrice: 100, now: 1000 });
    const still = assessTick({ market: 'CRYPTO', base: MAJOR, price: 103.2, refPrice: 100, now: 1000 + REVERT_WINDOW - 1 });
    expect(still.action).toBe('SUPPRESS');
  });

  it('no reference → pass-through (validator blindness never blocks trading)', () => {
    const v = assessTick({ market: 'CRYPTO', base: MAJOR, price: 103, refPrice: null });
    expect(v.action).toBe('ACCEPT');
    expect(v.deviationPct).toBeNull();
  });

  it('episode state never leaks across (market, base) keys', () => {
    assessTick({ market: 'CRYPTO', base: MAJOR, price: 103, refPrice: 100, now: 1000 });
    const other = assessTick({ market: 'FUTURES', base: MAJOR, price: 100.1, refPrice: 100, now: 2000 });
    expect(other.episode).toBeNull(); // FUTURES|BTC had no episode
    const fut = assessTick({ market: 'FUTURES', base: MAJOR, price: 103, refPrice: 100, now: 2000 });
    expect(fut.action).toBe('SUPPRESS');
  });

  it('alt threshold is genuinely wider', () => {
    // 1.2% deviation: suppressed on the major, accepted on the alt
    expect(assessTick({ market: 'CRYPTO', base: MAJOR, price: 101.2, refPrice: 100 }).action).toBe('SUPPRESS');
    expect(assessTick({ market: 'CRYPTO', base: ALT, price: 101.2, refPrice: 100 }).action).toBe('ACCEPT');
  });
});

describe('validateTick — the async wrapper', () => {
  it('CRYPTO (INR) normalizes through the live USDTINR rate', async () => {
    __testables.__setRefBookForTests('spot', { BTC: 100 }); // USDT
    state.usdtInr = 84; // → refPrice 8400 INR
    const ok = await validateTick({ market: 'CRYPTO', base: 'BTC', price: 8400 });
    expect(ok.action).toBe('ACCEPT');
    expect(ok.refPrice).toBe(8400);
    expect(ok.refSource).toContain('USDTINR');
    const bad = await validateTick({ market: 'CRYPTO', base: 'BTC', price: 8600 });
    expect(bad.action).toBe('SUPPRESS');
  });

  it('FUTURES compares 1:1 in the USDT domain against the perp book', async () => {
    __testables.__setRefBookForTests('fut', { BTC: 100 });
    const v = await validateTick({ market: 'FUTURES', base: 'BTC', price: 102 });
    expect(v.action).toBe('SUPPRESS');
    expect(v.refPrice).toBe(100);
  });

  it('Binance down → pass-through, never a block', async () => {
    __testables.__setRefBookForTests('fut', null);
    const v = await validateTick({ market: 'FUTURES', base: 'BTC', price: 102 });
    expect(v.action).toBe('ACCEPT');
    expect(v.refPrice).toBeNull();
  });

  it('kill switch → everything ACCEPTs', async () => {
    process.env.AI_DISABLE_WICK_FILTER = 'true';
    __testables.__setRefBookForTests('fut', { BTC: 100 });
    const v = await validateTick({ market: 'FUTURES', base: 'BTC', price: 150 });
    expect(v.action).toBe('ACCEPT');
  });
});

describe('v10.6.1 — sustained-gap hold + validator negative-cache', () => {
  it('after ACCEPT-sustained, a STILL-deviating tick stays ACCEPT (no SUPPRESS→ACCEPT oscillation)', () => {
    assessTick({ market: 'CRYPTO', base: MAJOR, price: 103, refPrice: 100, now: 1000 });
    const sustained = assessTick({ market: 'CRYPTO', base: MAJOR, price: 103.2, refPrice: 100, now: 1000 + REVERT_WINDOW + 1 });
    expect(sustained.action).toBe('ACCEPT');
    expect(sustained.episode).toBe('sustained');
    // the OLD bug: state was deleted → the next tick re-opened a fresh
    // episode and SUPPRESSED for another 15s window. Acceptance must HOLD.
    const still = assessTick({ market: 'CRYPTO', base: MAJOR, price: 103.1, refPrice: 100, now: 1000 + REVERT_WINDOW + 5000 });
    expect(still.action).toBe('ACCEPT');
    expect(still.episode).toBe('sustained');
    // stats: the sustained transition counts ONCE, not per tick
    expect(wickFilterStatus().stats.sustained).toBe(1);
  });

  it('sustained symbol is NOT listed as currently suppressed', () => {
    assessTick({ market: 'CRYPTO', base: MAJOR, price: 103, refPrice: 100, now: 1000 });
    assessTick({ market: 'CRYPTO', base: MAJOR, price: 103.2, refPrice: 100, now: 1000 + REVERT_WINDOW + 1 });
    const s = wickFilterStatus();
    expect(s.currentlySuppressed.filter(x => x.base === MAJOR)).toHaveLength(0);
  });

  it('gap closing AFTER a sustained acceptance is a clean close — NOT a wick (no false WICK_SUPPRESSED journal)', () => {
    assessTick({ market: 'CRYPTO', base: MAJOR, price: 103, refPrice: 100, now: 1000 });
    assessTick({ market: 'CRYPTO', base: MAJOR, price: 103.2, refPrice: 100, now: 1000 + REVERT_WINDOW + 1 });
    const back = assessTick({ market: 'CRYPTO', base: MAJOR, price: 100.1, refPrice: 100, now: 1000 + REVERT_WINDOW + 60000 });
    expect(back.action).toBe('ACCEPT');
    expect(back.episode).toBeNull(); // we ACTED on the sustained ticks — no wick to journal
    expect(wickFilterStatus().stats.wickEpisodes).toBe(0);
  });

  it('validator negative-cache: while Binance is marked down, no refetch is attempted (pass-through)', async () => {
    __testables.__setRefBookForTests('fut', { BTC: 100 });
    // simulate a hard outage window (map cleared, negative-cache armed)
    __testables._ref.fut.map = null;
    __testables._ref.fut.downUntil = Date.now() + 60_000;
    const t0 = Date.now();
    const v = await validateTick({ market: 'FUTURES', base: 'BTC', price: 102 });
    expect(v.action).toBe('ACCEPT');
    expect(v.refPrice).toBeNull();
    expect(Date.now() - t0).toBeLessThan(500); // returned instantly — NO 4s timeout fetch
    // a fresh-book success must clear the outage window
    __testables.__setRefBookForTests('fut', { BTC: 100 });
    __testables._ref.fut.downUntil = Date.now() + 60_000; // still armed?
    const ok2 = await validateTick({ market: 'FUTURES', base: 'BTC', price: 100.1 });
    // TTL-fresh book wins over the stale downUntil → validated normally
    expect(ok2.refPrice).toBe(100);
  });
});

describe('journal + status (audit trail)', () => {
  it('wickJournalEntry carries the wick_suppressed tag + deviation facts', () => {
    assessTick({ market: 'CRYPTO', base: MAJOR, price: 103, refPrice: 100, now: 1000 });
    const closed = assessTick({ market: 'CRYPTO', base: MAJOR, price: 100.1, refPrice: 100, now: 2000 });
    const entry = wickJournalEntry({ market: 'CRYPTO', base: MAJOR, pair: 'BTCINR', verdict: { ...closed, refPrice: 100, refSource: 'binance-spot-usdt' } });
    expect(entry.kind).toBe('WICK_SUPPRESSED');
    expect(entry.pair).toBe('BTCINR');
    expect(entry.reason).toContain('wick_suppressed');
    expect(entry.deviationPct).toBeGreaterThan(0);
    expect(entry.suppressSince).toBe(1000);
  });

  it('status exposes suppressed symbols + stats counters', () => {
    assessTick({ market: 'FUTURES', base: 'ETH', price: 3000, refPrice: 2500, now: 1000 });
    const s = wickFilterStatus();
    expect(s.enabled).toBe(true);
    expect(s.currentlySuppressed.some(x => x.base === 'ETH')).toBe(true);
    expect(s.stats.suppressed).toBeGreaterThan(0);
  });
});
