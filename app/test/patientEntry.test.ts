// ============================================================
// test/patientEntry.test.ts — v10.15 GAP 3
// ------------------------------------------------------------
// THE PATIENT ENTRY contract:
//   • extended signal (price > 1.5 ATR beyond the anchor) → a RESTING
//     limit at the DEPTH-DERIVED pullback level, not a market chase
//   • the pullback level sits just above a detected BID WALL for
//     longs / below an ASK WALL for shorts; no readable depth → the
//     signal's own anchor (never an arbitrary ATR fraction)
//   • at-anchor signal → the immediate path, exactly as today
//   • unfilled at window expiry → cancelled + journaled
//     missed-pullback (a GOOD outcome — it didn't chase)
//   • the level touched → fill at market (≈ the resting limit)
//   • missing data (no ATR / no ltp) → immediate (honest default —
//     patience must never BLOCK an entry because its read was absent)
//   • flag OFF (default) → the agents never classify at all
//   • the weekly review's patience A/B joins ENTRY_MODE markers to
//     closed positions (immediate vs patient win-rates)
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
  patientEntryEnabled, patientWindowMin, classifyEntry,
  pullbackLevelFor, levelTouched, patientPendingAction,
} from '../server/ai/patientEntry.js';
import { computeAiDeskWeek } from '../server/ai/weeklyReview.js';
import { loadAgentConfig, updateAgentConfig, __resetAgentForTests } from '../server/ai/agent.js';

const ORIG_ENV = process.env.AI_ENABLE_PATIENT_ENTRY;

beforeEach(() => {
  delete process.env.AI_ENABLE_PATIENT_ENTRY;
  __resetAgentForTests();
});
afterEach(() => {
  if (ORIG_ENV === undefined) delete process.env.AI_ENABLE_PATIENT_ENTRY;
  else process.env.AI_ENABLE_PATIENT_ENTRY = ORIG_ENV;
});

describe('classifyEntry — at-anchor vs extended (pure)', () => {
  it('price within 1.5 ATR of the anchor → at-anchor (the immediate path)', () => {
    expect(classifyEntry({ ltp: 100, entry: 100, atr: 2 })).toBe('at-anchor');
    expect(classifyEntry({ ltp: 102.9, entry: 100, atr: 2 })).toBe('at-anchor');   // 1.45×ATR
    expect(classifyEntry({ ltp: 97.1, entry: 100, atr: 2 })).toBe('at-anchor');
  });
  it('price beyond 1.5 ATR of the anchor → extended (chase risk)', () => {
    expect(classifyEntry({ ltp: 103.1, entry: 100, atr: 2 })).toBe('extended');    // 1.55×ATR
    expect(classifyEntry({ ltp: 96.9, entry: 100, atr: 2 })).toBe('extended');
    expect(classifyEntry({ ltp: 100, entry: 92, atr: 5 })).toBe('extended');       // 1.6×ATR below
  });
  it('missing ltp/entry/ATR → at-anchor (the honest default — patience never blocks on absent data)', () => {
    expect(classifyEntry({})).toBe('at-anchor');
    expect(classifyEntry({ ltp: 100, entry: 100, atr: 0 })).toBe('at-anchor');
    expect(classifyEntry({ ltp: null, entry: 100, atr: 2 })).toBe('at-anchor');
  });
});

describe('pullbackLevelFor — the depth-derived level (pure)', () => {
  it('LONG: the resting limit sits just ABOVE the highest reachable bid wall', () => {
    const depth = { bidWalls: [{ price: 98.2, qty: 5000 }, { price: 96.5, qty: 4000 }] };
    const { level, basis } = pullbackLevelFor({ side: 'LONG', ltp: 101, entry: 100, depth });
    expect(basis).toBe('bid-wall');
    expect(level).toBeGreaterThan(98.2);          // just above the wall
    expect(level).toBeLessThan(98.2 * 1.001);     // a HAIR above, not a gap
  });
  it('SHORT: the resting limit sits just BELOW the lowest reachable ask wall', () => {
    const depth = { askWalls: [{ price: 103.5, qty: 5000 }, { price: 105.5, qty: 4000 }] };
    const { level, basis } = pullbackLevelFor({ side: 'SHORT', ltp: 101, entry: 100, depth });
    expect(basis).toBe('ask-wall');
    expect(level).toBeLessThan(103.5);
    expect(level).toBeGreaterThan(103.5 * 0.999);
  });
  it('walls out of reach (LONG walls above price / far below) are ignored → the anchor', () => {
    // bid wall ABOVE the live price makes no sense for a LONG pullback
    expect(pullbackLevelFor({ side: 'LONG', ltp: 101, entry: 99.5, depth: { bidWalls: [{ price: 102, qty: 9000 }] } })).toMatchObject({ level: 99.5, basis: 'anchor' });
    // a wall 10% below is not a "pullback" — it's a breakdown level
    expect(pullbackLevelFor({ side: 'LONG', ltp: 101, entry: 99.5, depth: { bidWalls: [{ price: 90, qty: 9000 }] } })).toMatchObject({ level: 99.5, basis: 'anchor' });
  });
  it('no readable depth → the signal\'s own anchor (never an arbitrary ATR fraction)', () => {
    expect(pullbackLevelFor({ side: 'LONG', ltp: 103, entry: 100, depth: null })).toMatchObject({ level: 100, basis: 'anchor' });
    expect(pullbackLevelFor({ side: 'LONG', ltp: 103, entry: 100 })).toMatchObject({ level: 100, basis: 'anchor' });
    expect(pullbackLevelFor({ side: 'LONG', ltp: 103, entry: 100, depth: { ok: false } })).toMatchObject({ level: 100, basis: 'anchor' });
  });
});

describe('levelTouched + patientPendingAction — the fill/expire decision (pure)', () => {
  it('LONG fills when price trades DOWN to the level; SHORT when it trades UP', () => {
    expect(levelTouched({ side: 'LONG', level: 99, ltp: 98.95 })).toBe(true);
    expect(levelTouched({ side: 'LONG', level: 99, ltp: 99.5 })).toBe(false);
    expect(levelTouched({ side: 'SHORT', level: 103, ltp: 103.2 })).toBe(true);
    expect(levelTouched({ side: 'SHORT', level: 103, ltp: 102.8 })).toBe(false);
  });
  it('level touched within the window → fill', () => {
    const pending = { symbol: 'BTC', side: 'LONG', level: 99, expiresAt: Date.now() + 10 * 60_000 };
    expect(patientPendingAction({ pending, ltp: 98.9, now: Date.now() })).toMatchObject({ action: 'fill' });
  });
  it('window expired untouched → expire (the missed-pullback journal moment)', () => {
    const pending = { symbol: 'BTC', side: 'LONG', level: 99, expiresAt: Date.now() - 1000 };
    expect(patientPendingAction({ pending, ltp: 100.5, now: Date.now() })).toMatchObject({ action: 'expire' });
  });
  it('level untouched, window open → wait', () => {
    const pending = { symbol: 'BTC', side: 'LONG', level: 99, expiresAt: Date.now() + 10 * 60_000 };
    expect(patientPendingAction({ pending, ltp: 100.5, now: Date.now() })).toMatchObject({ action: 'wait' });
  });
  it('missing ltp → wait (an absent price never fills or kills the order)', () => {
    const pending = { symbol: 'BTC', side: 'LONG', level: 99, expiresAt: Date.now() + 10 * 60_000 };
    expect(patientPendingAction({ pending, ltp: null, now: Date.now() })).toMatchObject({ action: 'wait' });
  });
  it('a malformed pending → expire (never a stuck resting order)', () => {
    expect(patientPendingAction({ pending: null, ltp: 100, now: Date.now() })).toMatchObject({ action: 'expire' });
    expect(patientPendingAction({ pending: { level: 0 }, ltp: 100, now: Date.now() })).toMatchObject({ action: 'expire' });
  });
});

describe('the flag + windows', () => {
  it('OFF by default (config + env both unset)', () => {
    expect(patientEntryEnabled(loadAgentConfig())).toBe(false);
  });
  it('env var arms it; the agent knob round-trips', () => {
    for (const v of ['true', '1', 'on', 'yes']) {
      process.env.AI_ENABLE_PATIENT_ENTRY = v;
      expect(patientEntryEnabled(loadAgentConfig())).toBe(true);
    }
    process.env.AI_ENABLE_PATIENT_ENTRY = 'off';
    expect(patientEntryEnabled(loadAgentConfig())).toBe(false);
    updateAgentConfig({ patientEntry: true });
    expect(patientEntryEnabled(loadAgentConfig())).toBe(true);
  });
  it('windows: crypto 15m, India 10m, env override bounded', () => {
    expect(patientWindowMin('CRYPTO')).toBe(15);
    expect(patientWindowMin('FUTURES')).toBe(15);
    expect(patientWindowMin('INDIA')).toBe(10);
    process.env.AI_PATIENT_WINDOW_MIN = '5';
    expect(patientWindowMin('INDIA')).toBe(5);
    process.env.AI_PATIENT_WINDOW_MIN = '500'; // absurd → bounded back to defaults
    expect(patientWindowMin('CRYPTO')).toBe(15);
  });
});

describe('the weekly review patience A/B (ENTRY_MODE markers → closed positions)', () => {
  const NOW = new Date('2026-09-15T10:00:00+05:30').getTime();
  const journal = {
    entries: [
      { kind: 'CLOSE', day: '2026-09-15', pair: 'BTCUSDT', pnlINR: 500, mode: 'paper' },
      { kind: 'CLOSE', day: '2026-09-14', pair: 'ETHUSDT', pnlINR: -200, mode: 'paper' },
      // the patience A/B markers (joined to positions by positionId)
      { kind: 'ENTRY_MODE', day: '2026-09-15', positionId: 'a1', mode: 'patient', symbol: 'BTCUSDT' },
      { kind: 'ENTRY_MODE', day: '2026-09-14', positionId: 'a2', mode: 'immediate', symbol: 'ETHUSDT' },
      { kind: 'ENTRY_MODE', day: '2026-09-13', positionId: 'a3', mode: 'immediate', symbol: 'SOLUSDT' },
      // one unfilled window — the discipline win
      { kind: 'MISSED_PULLBACK', day: '2026-09-13', symbol: 'XRPUSDT', text: 'expired unfilled' },
      // out-of-window marker + noise — never counted
      { kind: 'ENTRY_MODE', day: '2026-08-01', positionId: 'a9', mode: 'immediate', symbol: 'OLD' },
      { kind: 'ORDER', day: '2026-09-15', pair: 'X' },
    ],
    positions: [
      { id: 'a1', side: 'LONG', status: 'CLOSED', openedAt: NOW - 3600_000, closedAt: NOW - 600_000, pnlINR: 500, bookedPnlINR: 0 },
      { id: 'a2', side: 'SHORT', status: 'CLOSED', openedAt: NOW - 7200_000, closedAt: NOW - 3600_000, pnlINR: -200, bookedPnlINR: 0 },
      { id: 'a3', side: 'LONG', status: 'CLOSED', openedAt: NOW - 86400_000, closedAt: NOW - 80000_000, pnlINR: 150, bookedPnlINR: 0 },
    ],
  };
  it('immediate vs patient win-rates + the missed-pullback count, joined by positionId', () => {
    const w = computeAiDeskWeek(journal, { now: NOW });
    expect(w.byEntryMode.patient).toMatchObject({ trades: 1, wins: 1, winRate: 100 });
    expect(w.byEntryMode.immediate).toMatchObject({ trades: 2, wins: 1, winRate: 50 });
    expect(w.byEntryMode.missedPullbacks).toBe(1); // in-window only
  });
  it('no markers → honest zeros (never a fabricated A/B)', () => {
    const w = computeAiDeskWeek({ entries: [], positions: [] }, { now: NOW });
    expect(w.byEntryMode.immediate).toMatchObject({ trades: 0, winRate: null });
    expect(w.byEntryMode.patient).toMatchObject({ trades: 0, winRate: null });
    expect(w.byEntryMode.missedPullbacks).toBe(0);
  });
});
