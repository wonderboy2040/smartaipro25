// ============================================================
// v21.23.1 DIRECTION-LOCK RELEASE-ON-CLOSE regression tests
// ------------------------------------------------------------
// THE BUG (latest-repo audit): `releaseDirectionLock()` export tha par
// production me KAHIN call nahi hota tha (mtfAutoLink me sirf dead import).
// `checkDirectionLock()` me `active:true` lock KABHI expire nahi karta —
// ek baar koi engine symbol X par trade kholta hi opposite side
// process-restart tak block rehti thi.
//
// THE FIX (2 authoritative paths):
//   1. paperTrading.js `_closePart` — har paper-trade close (SL/T1/T2/
//      trail/EOD/manual/stale) yahin land karta hai → symbol par KOI AUR
//      open paper trade na ho to lock RELEASE (cooldown preserved).
//   2. `reconcileDirectionLocks(openSymbols)` — routes.js ke 60s always-on
//      watcher ALL books (paper engine + MTF book + shared journal + SAPTA)
//      se flat symbols detect karke active locks release karta hai.
// Store + journal mocked so tests never touch server/data/.
// ============================================================
import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';

vi.mock('../server/intraday/store.js', () => ({
  loadJSON: () => ({ trades: [], nextId: 1, dayKey: '' }),
  saveJSON: vi.fn(() => true),
  DATA_DIR: '/tmp/unused',
}));
vi.mock('../server/intraday/journal.js', () => ({
  recordTradeClose: vi.fn(),
}));

import {
  openPaperTrade,
  closePaperTrade,
  getPaperSummary,
  _resetForTests,
} from '../server/intraday/paperTrading.js';
import {
  acquireDirectionLock,
  checkDirectionLock,
  releaseDirectionLock,
  reconcileDirectionLocks,
  getDirectionLocks,
  __resetDirectionLocksForTests,
} from '../server/ai/directionLock.js';

// IST 10:00 Friday (pre-square-off market window) — same pin as optionPaperTrade tests.
const FAKE_NOW = new Date('2026-09-11T04:30:00Z');
beforeAll(() => { vi.useFakeTimers(); vi.setSystemTime(FAKE_NOW); });
afterAll(() => vi.useRealTimers());
const T0 = FAKE_NOW.getTime();

function openBtc(direction: 'LONG' | 'SHORT' = 'LONG') {
  return openPaperTrade({
    symbol: 'BTC', direction, entry: 100, qty: 5,
    stopLoss: direction === 'LONG' ? 98 : 102,
    target1: direction === 'LONG' ? 103 : 97,
    target2: direction === 'LONG' ? 106 : 94,
    market: 'CRYPTO',
  });
}

describe('v21.23.1 direction-lock RELEASE-ON-CLOSE (paper engine central hook)', () => {
  beforeEach(() => {
    _resetForTests();
    __resetDirectionLocksForTests();
  });

  it('paper trade close releases the active lock (cooldown kept) — opposite side blocked only till entry+4h, not forever', () => {
    const t = openBtc('LONG');
    expect(t?.trade?.id).toBeTruthy();
    acquireDirectionLock({ symbol: 'BTC', side: 'LONG', source: 'mtf-auto', cooldownMin: 240, now: T0 });

    // while open: opposite SHORT blocked (the guard works)
    expect(checkDirectionLock('BTC', 'SHORT', { now: T0 + 60_000 }).allowed).toBe(false);

    // close the trade (manual close path → _closePart central hook)
    const c = closePaperTrade(t.trade.id, { BTC: { price: 105 } });
    expect(c?.ok).toBe(true);

    // LOCK RELEASED: active=false, but flip-cooldown (from entry) still holds
    const locks = getDirectionLocks(T0 + 61_000);
    expect(locks.find(l => l.symbol === 'BTC')?.active).toBe(false);
    expect(checkDirectionLock('BTC', 'SHORT', { now: T0 + 61_000 }).allowed).toBe(false); // still cooldown
    expect(checkDirectionLock('BTC', 'SHORT', { now: T0 + 241 * 60_000 }).allowed).toBe(true); // after 4h+1m → allowed
    // same side always allowed after release
    expect(checkDirectionLock('BTC', 'LONG', { now: T0 + 61_000 }).allowed).toBe(true);
  });

  it('lock stays ACTIVE while ANOTHER open paper trade on the same symbol exists (multi-engine same-symbol hold)', () => {
    const a = openBtc('LONG');
    const b = openPaperTrade({ symbol: 'BTCUSDT', direction: 'LONG', entry: 100, qty: 5, stopLoss: 98, target1: 103, target2: 106, market: 'CRYPTO' });
    expect(a?.trade?.id).toBeTruthy();
    expect(b?.trade?.id).toBeTruthy();
    acquireDirectionLock({ symbol: 'BTC', side: 'LONG', source: 'agent', cooldownMin: 240, now: T0 });

    // close ONE of the two → lock must NOT release (other engine still open)
    closePaperTrade(a.trade.id, { BTC: { price: 105 } });
    expect(getDirectionLocks(T0 + 61_000).find(l => l.symbol === 'BTC')?.active).toBe(true);
    expect(checkDirectionLock('BTC', 'SHORT', { now: T0 + 61_000 }).allowed).toBe(false);

    // close the second → now flat → lock releases
    closePaperTrade(b.trade.id, { BTC: { price: 105 } });
    expect(getDirectionLocks(T0 + 62_000).find(l => l.symbol === 'BTC')?.active).toBe(false);
  });

  it('lock for a symbol with NO paper trade at all is untouched by the paper close hook (journal/live books own it)', () => {
    acquireDirectionLock({ symbol: 'ETH', side: 'LONG', source: 'agent', cooldownMin: 240, now: T0 });
    const t = openBtc('LONG');
    closePaperTrade(t.trade.id, { BTC: { price: 105 } });
    // ETH ka lock paper engine ke BTC close se kabhi release nahi hona chahiye
    expect(getDirectionLocks(T0 + 61_000).find(l => l.symbol === 'ETH')?.active).toBe(true);
  });

  it('LIVE board lock survives its mtf-auto paper mirror close (release ownership)', () => {
    const t = openPaperTrade({
      symbol: 'BTC', direction: 'LONG', entry: 100, qty: 5,
      stopLoss: 98, target1: 103, target2: 106, market: 'CRYPTO', source: 'mtf-auto',
    });
    acquireDirectionLock({ symbol: 'BTC', side: 'LONG', source: 'mtf-board-live', cooldownMin: 240, now: T0 });
    closePaperTrade(t.trade.id, { BTC: { price: 105 } });
    expect(getDirectionLocks(T0 + 61_000).find(l => l.symbol === 'BTC')?.active).toBe(true);
  });

  it('manual board PAPER close releases its own mtf-board-paper lock', () => {
    const t = openPaperTrade({
      symbol: 'BTC', direction: 'LONG', entry: 100, qty: 5,
      stopLoss: 98, target1: 103, target2: 106, market: 'CRYPTO', source: 'mtf-board-ui',
    });
    acquireDirectionLock({ symbol: 'BTC', side: 'LONG', source: 'mtf-board-paper', cooldownMin: 240, now: T0 });
    closePaperTrade(t.trade.id, { BTC: { price: 105 } });
    expect(getDirectionLocks(T0 + 61_000).find(l => l.symbol === 'BTC')?.active).toBe(false);
  });
});

describe('v21.23.1 reconcileDirectionLocks sweep (routes.js 60s always-on watcher)', () => {
  beforeEach(() => __resetDirectionLocksForTests());

  it('releases ONLY flat symbols — symbols still open in ANY book hold their active lock', () => {
    acquireDirectionLock({ symbol: 'BTC', side: 'LONG', source: 'mtf-auto', now: T0 });
    acquireDirectionLock({ symbol: 'ETH', side: 'SHORT', source: 'agent', now: T0 });
    acquireDirectionLock({ symbol: 'SOL', side: 'LONG', source: 'india-agent', now: T0 });

    // ETH abhi bhi kahin khula hai (say shared journal) — BTC/SOL flat hain
    const sweep = reconcileDirectionLocks(['ETHUSDT'], { now: T0 + 60_000 });
    expect(sweep.released.sort()).toEqual(['BTC', 'SOL']);
    expect(sweep.heldActive).toBe(1);

    const locks = getDirectionLocks(T0 + 61_000);
    expect(locks.find(l => l.symbol === 'ETH')?.active).toBe(true);
    expect(locks.find(l => l.symbol === 'BTC')?.active).toBe(false);
    expect(locks.find(l => l.symbol === 'SOL')?.active).toBe(false);
    // released symbols: cooldown preserved (abhi bhi opposite blocked)
    expect(checkDirectionLock('BTC', 'SHORT', { now: T0 + 61_000 }).allowed).toBe(false);
  });

  it('normalizes exchange-style symbols (B-BTC_USDT / FUTURES|BTC → BTC) before matching open books', () => {
    acquireDirectionLock({ symbol: 'BTC', side: 'LONG', source: 'protrader-auto', now: T0 });
    const sweep = reconcileDirectionLocks(['B-BTC_USDT', 'FUTURES|BTC'], { now: T0 + 60_000 });
    expect(sweep.released).toEqual([]); // position still open (normalized match) → hold
    expect(getDirectionLocks(T0 + 61_000).find(l => l.symbol === 'BTC')?.active).toBe(true);
  });

  it('already-released (cooldown-phase) locks are not double-processed; empty/invalid input is safe', () => {
    acquireDirectionLock({ symbol: 'BTC', side: 'LONG', source: 'agent', now: T0 });
    releaseDirectionLock('BTC', { now: T0 + 30_000 }); // paper-engine style manual release
    const sweep = reconcileDirectionLocks([], { now: T0 + 60_000 });
    expect(sweep.released).toEqual([]); // inactive lock release-skip — cooldown chal raha hai
    expect(sweep.heldActive).toBe(0);
    expect(reconcileDirectionLocks(null, { now: T0 }).released).toEqual([]);
  });
});
