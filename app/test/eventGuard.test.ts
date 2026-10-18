// ============================================================
// test/eventGuard.test.ts — v10.15 GAP 2
// ------------------------------------------------------------
// THE SCHEDULED-EVENT GUARD contract:
//   • entry inside the 30-min pre-event blackout → VETOED with a
//     reason string (journal-visible, like every other gate)
//   • entry at T-2h → sized DOWN (×0.5 default), NOT blocked
//   • no event / >6h away → no interference at all
//   • desk scoping: FOMC/US-CPI affect ALL desks (crypto included);
//     RBI/India-CPI/IIP affect INDIA only; earnings affect the
//     specific symbol's desk
//   • a flip in scope must never come from a stale calendar:
//     earnings roll FORWARD quarterly; past events are ignored
//   • AI_DISABLE_EVENT_GUARD → the whole guard is a no-op
//   • the signal-card chip reads the SAME check (blocked/haircut)
// ============================================================
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const mockPrivate = vi.fn();
const mockPrivateGET = vi.fn();
vi.mock('../server/mcp/coindcx.js', () => ({
  coindcxPrivate: (...args) => mockPrivate(...args),
  coindcxPrivateGET: (...args) => mockPrivateGET(...args),
  coindcxConnected: () => false,
  coindcxStatus: () => ({ connected: false }),
  fetchGlobalFuturesInstruments: vi.fn(async () => []),
}));

import {
  eventGuardCheck, eventGuardStatus, eventGuardEnabled, eventGuardTunables,
  rollQuarterlyForward, nextEarningsFor, nextIndiaCpi, nextIndiaIip, nextUsCpiWindow,
} from '../server/ai/eventGuard.js';

const ORIG_ENV = { DISABLE: process.env.AI_DISABLE_EVENT_GUARD, BLACKOUT: process.env.AI_EVENT_BLACKOUT_MIN, HAIRCUT: process.env.AI_EVENT_HAIRCUT_MIN };

beforeEach(() => {
  delete process.env.AI_DISABLE_EVENT_GUARD;
  delete process.env.AI_EVENT_BLACKOUT_MIN;
  delete process.env.AI_EVENT_HAIRCUT_MIN;
});
afterEach(() => {
  for (const [k, v] of Object.entries(ORIG_ENV)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

// FIXED reference clock, far from every real calendar edge:
// 2026-09-16 08:00 UTC — the Sep FOMC decision is at 18:00 UTC TODAY.
const NOW = Date.parse('2026-09-16T08:00:00Z');
const FOMC_AT = Date.parse('2026-09-16T18:00:00Z');

describe('eventGuard — the graded responses', () => {
  it('entry inside the T-30m blackout → VETOED with a journal-visible reason', () => {
    const now = FOMC_AT - 15 * 60_000;
    const r = eventGuardCheck({ symbol: 'BTC', desk: 'CRYPTO', now });
    expect(r.action).toBe('blackout');
    expect(r.reason).toContain('FOMC');
    expect(r.reason).toContain('15m');
    expect(r.event.kind).toBe('FOMC');
    expect(r.event.minutesUntil).toBe(15);
  });

  it('entry at T-2h → sized DOWN (haircut), NOT blocked', () => {
    const now = FOMC_AT - 100 * 60_000;
    const r = eventGuardCheck({ symbol: 'ETH', desk: 'FUTURES', now });
    expect(r.action).toBe('haircut');
    expect(r.multiplier).toBe(0.5);
    expect(r.reason).toContain('100m');
  });

  it('no event / >6h away → zero interference (allow, no event payload)', () => {
    // 10h before the FOMC decision — outside the 6h relevance window
    expect(eventGuardCheck({ symbol: 'BTC', desk: 'CRYPTO', now: FOMC_AT - 10 * 3600_000 })).toEqual({ action: 'allow' });
    // a plain weekday far from any calendar item
    const quiet = Date.parse('2026-09-21T08:00:00Z');
    const r = eventGuardCheck({ symbol: 'BTC', desk: 'CRYPTO', now: quiet });
    expect(r.action).toBe('allow'); // (US CPI window may exist but ~9 days out is beyond 6h)
    expect(r.event ?? null).toBeNull();
  });

  it('FOMC + US-CPI are ALL-desk events — crypto included (macro-sensitive)', () => {
    const now = FOMC_AT - 20 * 60_000;
    for (const desk of ['CRYPTO', 'FUTURES', 'GLOBALFUTURES', 'INDIA']) {
      expect(eventGuardCheck({ symbol: 'BTC', desk, now }).action).toBe('blackout');
    }
  });

  it('RBI / India-CPI / India-IIP scope to the INDIA desk ONLY — crypto never blocked by them', () => {
    // India IIP: last day of month 17:30 IST = 12:00 UTC. Pin now 15m
    // before Sep 30's release — India blacks out, crypto is untouched
    // (the next US CPI window opens Oct 12, FOMC Oct 28: both >6h away).
    const now = Date.parse('2026-09-30T11:45:00Z');
    expect(eventGuardCheck({ symbol: 'RELIANCE', desk: 'INDIA', now }).action).toBe('blackout');
    expect(eventGuardCheck({ symbol: 'BTC', desk: 'CRYPTO', now }).action).toBe('allow');
    expect(eventGuardCheck({ symbol: 'BTC', desk: 'FUTURES', now }).action).toBe('allow');
    // sanity: India CPI itself (Oct 12, 12:00 UTC) also scopes to INDIA —
    // note US CPI's window opens the SAME day 12:30 UTC, so crypto's
    // 45m-later haircut below is the US_CPI event, NOT India's CPI.
    const nowCpi = Date.parse('2026-10-12T11:45:00Z');
    expect(eventGuardCheck({ symbol: 'RELIANCE', desk: 'INDIA', now: nowCpi }).action).toBe('blackout');
    const cx = eventGuardCheck({ symbol: 'BTC', desk: 'CRYPTO', now: nowCpi });
    expect(cx.action).toBe('haircut');
    expect(cx.event.kind).toBe('US_CPI'); // the macro event, not India's
  });

  it('earnings affect the SYMBOL on its own desk — a different symbol is untouched', () => {
    // RELIANCE earnings roll to 2026-10-17 16:00 IST = 10:30 UTC
    const erAt = nextEarningsFor('RELIANCE', NOW).at;
    const now = erAt - 20 * 60_000;
    expect(eventGuardCheck({ symbol: 'RELIANCE', desk: 'INDIA', now }).action).toBe('blackout');
    expect(eventGuardCheck({ symbol: 'SBIN', desk: 'INDIA', now }).action).toBe('allow'); // not its print
    expect(eventGuardCheck({ symbol: 'RELIANCE', desk: 'CRYPTO', now }).action).toBe('allow'); // wrong desk
  });

  it('US earnings hit the GLOBALFUTURES desk names (NVDA/AAPL/…)', () => {
    const nv = nextEarningsFor('NVDA', NOW);
    expect(nv.market).toBe('US');
    const now = nv.at - 45 * 60_000; // T-45m → haircut window
    expect(eventGuardCheck({ symbol: 'NVDA', desk: 'GLOBALFUTURES', now }).action).toBe('haircut');
    const now2 = nv.at - 25 * 60_000; // T-25m → blackout
    expect(eventGuardCheck({ symbol: 'NVDA', desk: 'GLOBALFUTURES', now: now2 }).action).toBe('blackout');
  });

  it('AI_DISABLE_EVENT_GUARD=true → the whole guard is a no-op', () => {
    process.env.AI_DISABLE_EVENT_GUARD = 'true';
    expect(eventGuardEnabled()).toBe(false);
    const now = FOMC_AT - 15 * 60_000;
    expect(eventGuardCheck({ symbol: 'BTC', desk: 'CRYPTO', now })).toEqual({ action: 'allow' });
    expect(eventGuardStatus({ now }).upcoming).toHaveLength(0);
  });

  it('tunables: blackout/haircut windows are env-adjustable', () => {
    process.env.AI_EVENT_BLACKOUT_MIN = '60';
    process.env.AI_EVENT_HAIRCUT_MIN = '180';
    expect(eventGuardTunables()).toMatchObject({ blackoutMin: 60, haircutMin: 180, haircutMul: 0.5 });
    const now = FOMC_AT - 45 * 60_000; // inside the widened 60m blackout
    expect(eventGuardCheck({ symbol: 'BTC', desk: 'CRYPTO', now }).action).toBe('blackout');
  });
});

describe('eventGuard — the calendars stay honest', () => {
  it('stale earnings dates roll FORWARD quarterly until future (approximate, labeled)', () => {
    // RELIANCE's table date is 2026-07-18 (stale) — the next print must be FUTURE
    const er = nextEarningsFor('RELIANCE', NOW);
    expect(er.at).toBeGreaterThan(NOW);
    expect(er.approximate).toBe(true);
    // 2026-07-18 + 91d ≈ 2026-10-17 — one quarterly step, not 8
    expect(er.at - Date.parse('2026-07-18T00:00:00Z')).toBeLessThan(200 * 24 * 3600_000);
    // the print time is post-market 16:00 IST = 10:30 UTC
    expect(new Date(er.at).toISOString()).toContain('T10:30:00');
  });

  it('rollQuarterlyForward is pure and bounded', () => {
    const base = Date.parse('2026-07-18T00:00:00Z');
    const rolled = rollQuarterlyForward(base, NOW);
    expect(rolled).toBeGreaterThan(NOW);
    expect(rolled - NOW).toBeLessThan(91 * 24 * 3600_000); // lands within one step of "future"
    // already-future dates pass through untouched
    const future = NOW + 40 * 24 * 3600_000;
    expect(rollQuarterlyForward(future, NOW)).toBe(future);
  });

  it('unknown symbols have no earnings calendar entry (honest absence)', () => {
    expect(nextEarningsFor('SOMETHING', NOW)).toBeNull();
    expect(nextEarningsFor('', NOW)).toBeNull();
  });

  it('monthly patterns: India CPI lands 12th 17:30 IST, IIP on the month\u2019s last day', () => {
    const cpi = nextIndiaCpi(NOW); // Sep 12 already past at NOW → October's
    expect(new Date(cpi.at).toISOString()).toBe('2026-10-12T12:00:00.000Z');
    const iip = nextIndiaIip(NOW); // Sep 30 is future → this month's
    expect(new Date(iip.at).toISOString()).toContain('T12:00:00'); // 17:30 IST
    expect(new Date(iip.at).getUTCDate()).toBe(30);
    const usCpi = nextUsCpiWindow(NOW); // Sep 12-15 past → October window
    expect(new Date(usCpi.at).toISOString()).toContain('2026-10-1');
    expect(new Date(usCpi.at).toISOString()).toContain('T12:30:00'); // 08:30 ET (DST)
  });
});

describe('eventGuard — the status view (UI strip + route payload)', () => {
  it('lists upcoming events for a desk with inMin, sorted soonest-first', () => {
    const st = eventGuardStatus({ desk: 'INDIA', now: NOW });
    expect(st.ok).toBe(true);
    expect(st.enabled).toBe(true);
    expect(st.upcoming.length).toBeGreaterThan(0);
    // the Sep-16 FOMC decision (10h away at NOW) is NOT in the ≤6h check window
    // but the STATUS view lists 7 days — it must be there, first.
    expect(st.upcoming[0].kind).toBe('FOMC');
    expect(st.upcoming[0].inMin).toBe(600);
    // monotonic ordering
    for (let i = 1; i < st.upcoming.length; i++) {
      expect(st.upcoming[i].at).toBeGreaterThanOrEqual(st.upcoming[i - 1].at);
    }
  });

  it('desk-filtered: crypto does NOT see India-only events', () => {
    const st = eventGuardStatus({ desk: 'CRYPTO', now: NOW });
    for (const e of st.upcoming) {
      expect(e.desks.includes('ALL')).toBe(true); // only ALL-desk events survive the filter
    }
  });

  it('the signal-chip payload: blocked/haircut flags mirror the check verdict', () => {
    const blackout = eventGuardCheck({ symbol: 'BTC', desk: 'CRYPTO', now: FOMC_AT - 10 * 60_000 });
    expect(blackout.action).toBe('blackout');
    const haircut = eventGuardCheck({ symbol: 'BTC', desk: 'CRYPTO', now: FOMC_AT - 90 * 60_000 });
    expect(haircut.action).toBe('haircut');
    expect(haircut.multiplier).toBe(0.5);
    const far = eventGuardCheck({ symbol: 'BTC', desk: 'CRYPTO', now: FOMC_AT - 3 * 3600_000 });
    expect(far.action).toBe('allow'); // 3h away: visible chip, no interference
    expect(far.event.kind).toBe('FOMC');
    expect(far.event.minutesUntil).toBe(180);
  });
});
