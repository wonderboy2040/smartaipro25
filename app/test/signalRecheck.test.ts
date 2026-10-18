// ============================================================
// test/signalRecheck.test.ts — v20.7.5 THE 15s SIGNAL RECHECK
// ------------------------------------------------------------
// Pins the user's explicit contract: "AI ko sabhi trading 80+
// signals — Strong or Action — har 15 sec recheck karta rahe."
//
//   1. selectWatchlist — STRONG + ACTION only (WATCH/NEUTRAL/FLAT
//      never enter the watch), per-symbol dedupe with STRONG
//      priority, plan/aiScore extraction.
//   2. recheckRow — the pure price verdict: SL-through INVALIDATED
//      (long + short), >0.75 ATR adverse drift WEAKENING, T1/T2
//      touches (both sides), honest PENDING without a live price.
//   3. detectTransition / priceStateTransition — the committee +
//      price state machines (FLIPPED · PROMOTED · DEMOTED · NEW ·
//      DROPPED · RECOVERED).
//   4. recheckTick (injected deps, no live I/O) — the full loop:
//      watchlist merge, LTP sweep, event recording, Telegram push
//      with the 30-min dedupe, staggered deep re-vote flips, board
//      EXPIRED lifecycle.
//   5. signalRecheckStatus — panel view shape + problem-first sort.
//   6. buildTickStoreResolver — tick-store key mapping + staleness.
// ============================================================
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  selectWatchlist, recheckRow, detectTransition, priceStateTransition,
  formatRecheckEvent, recheckTick, signalRecheckStatus, startSignalRecheckLoop,
  buildTickStoreResolver, RECHECK_TICK_MS, RECHECK_GRADES,
  __resetSignalRecheckForTests, __rowsForTests, __eventsForTests, __pushedAtForTests,
} from '../server/ai/signalRecheck.js';

// ---------- fixtures ----------
const sig = (over = {}) => ({
  symbol: 'ETH', market: 'FUTURES', side: 'LONG', grade: 'STRONG',
  confidence: 78, agreement: 0.8,
  superIntel: { aiScore: 82 },
  plan: { entry: 100, stopLoss: 95, target1: 105, target2: 110, atrUsed: 2 },
  generatedAt: Date.now() - 10_000,
  ...over,
});

const board = (signals) => ({ signals });

// ---------- pure: watchlist selection ----------
describe('selectWatchlist — STRONG/ACTION hi watch me aate hain', () => {
  it('WATCH / NEUTRAL / FLAT rows are excluded', () => {
    const wl = selectWatchlist([
      board([sig({ symbol: 'A', grade: 'WATCH' })]),
      board([sig({ symbol: 'B', grade: 'NEUTRAL' })]),
      board([sig({ symbol: 'C', side: 'FLAT', grade: 'ACTION' })]),
    ].map((b, i) => ({ market: ['CRYPTO', 'INDIA', 'FUTURES'][i], ...b })));
    expect(wl.size).toBe(0);
  });

  it('STRONG + ACTION rows land with plan levels + aiScore extracted', () => {
    const wl = selectWatchlist([{ market: 'FUTURES', signals: [sig(), sig({ symbol: 'BTC', grade: 'ACTION', confidence: 61 })] }]);
    expect(wl.size).toBe(2);
    const eth = wl.get('FUTURES:ETH');
    expect(eth).toMatchObject({ market: 'FUTURES', symbol: 'ETH', side: 'LONG', grade: 'STRONG', aiScore: 82, entry: 100, stopLoss: 95, target1: 105, target2: 110, atr: 2 });
    expect(wl.get('FUTURES:BTC').grade).toBe('ACTION');
  });

  it('duplicate symbol across flavors: STRONG wins; market keys stay separate', () => {
    const wl = selectWatchlist([
      { market: 'CRYPTO', signals: [sig({ symbol: 'ETH', grade: 'ACTION' })] },
      { market: 'FUTURES', signals: [sig({ symbol: 'ETH' })] },
    ]);
    expect(wl.size).toBe(2);
    expect(wl.get('CRYPTO:ETH').grade).toBe('ACTION');
    expect(wl.get('FUTURES:ETH').grade).toBe('STRONG');
  });

  it('same market duplicate: the STRONG flavor replaces an ACTION one', () => {
    const wl = selectWatchlist([{ market: 'FUTURES', signals: [sig({ grade: 'ACTION' }), sig()] }]);
    expect(wl.size).toBe(1);
    expect(wl.get('FUTURES:ETH').grade).toBe('STRONG');
  });
});

// ---------- pure: one price recheck ----------
describe('recheckRow — the 15s price verdict', () => {
  const row = { side: 'LONG', entry: 100, stopLoss: 95, target1: 105, target2: 110, atr: 2 };

  it('no live price → honest PENDING', () => {
    const r = recheckRow(row, null);
    expect(r.state).toBe('PENDING');
    expect(r.ltp).toBeNull();
  });

  it('LONG through SL → INVALIDATED (entry mat karo)', () => {
    const r = recheckRow(row, 94.5);
    expect(r.state).toBe('INVALIDATED');
    expect(r.reason).toMatch(/stop-loss/i);
  });

  it('SHORT through SL → INVALIDATED (mirror)', () => {
    const r = recheckRow({ ...row, side: 'SHORT', entry: 100, stopLoss: 105, target1: 95, target2: 90 }, 105.4);
    expect(r.state).toBe('INVALIDATED');
  });

  it('LONG >0.75 ATR adverse drift (not yet SL) → WEAKENING', () => {
    // entry 100, atr 2 → adverse = 100 − 98.4 = 1.6 = 0.8×ATR; SL is 95 so not invalidated
    const r = recheckRow(row, 98.4);
    expect(r.state).toBe('WEAKENING');
    expect(r.reason).toMatch(/ATR against/i);
  });

  it('T1 touched → TARGET_1 · T2 beyond → TARGET_2 (both sides)', () => {
    expect(recheckRow(row, 105.2).state).toBe('TARGET_1');
    expect(recheckRow(row, 110.9).state).toBe('TARGET_2');
    const shortRow = { side: 'SHORT', entry: 100, stopLoss: 105, target1: 95, target2: 90, atr: 2 };
    expect(recheckRow(shortRow, 94.8).state).toBe('TARGET_1');
    expect(recheckRow(shortRow, 89.5).state).toBe('TARGET_2');
  });

  it('healthy price → OK with side-adjusted movePct', () => {
    const r = recheckRow(row, 101);
    expect(r.state).toBe('OK');
    expect(r.movePct).toBeCloseTo(1, 5);
    const rs = recheckRow({ ...row, side: 'SHORT' }, 101);
    expect(rs.movePct).toBeCloseTo(-1, 5); // short: price up = adverse move
  });

  it('ATR fallback (1.2% of entry) when plan atr missing', () => {
    const r = recheckRow({ ...row, atr: null }, 97); // adverse 3 > 0.75×1.2
    expect(r.state).toBe('WEAKENING');
  });
});

// ---------- pure: transitions ----------
describe('detectTransition + priceStateTransition — committee & price state machines', () => {
  it('NEW / DROPPED', () => {
    expect(detectTransition(null, { side: 'LONG', grade: 'STRONG' })).toBe('NEW');
    expect(detectTransition({ side: 'LONG', grade: 'STRONG' }, null)).toBe('DROPPED');
  });

  it('FLIPPED on side change (FLAT never flips)', () => {
    expect(detectTransition({ side: 'LONG', grade: 'STRONG' }, { side: 'SHORT', grade: 'STRONG' })).toBe('FLIPPED');
    expect(detectTransition({ side: 'FLAT', grade: 'WATCH' }, { side: 'LONG', grade: 'ACTION' })).toBe('PROMOTED');
  });

  it('PROMOTED / DEMOTED on grade movement', () => {
    expect(detectTransition({ side: 'LONG', grade: 'ACTION' }, { side: 'LONG', grade: 'STRONG' })).toBe('PROMOTED');
    expect(detectTransition({ side: 'LONG', grade: 'STRONG' }, { side: 'LONG', grade: 'ACTION' })).toBe('DEMOTED');
    expect(detectTransition({ side: 'LONG', grade: 'STRONG' }, { side: 'LONG', grade: 'STRONG' })).toBeNull();
  });

  it('priceStateTransition — sticky events + RECOVERED', () => {
    expect(priceStateTransition('OK', 'OK')).toBeNull();
    expect(priceStateTransition('OK', 'WEAKENING')).toBeNull(); // soft drift: no event spam
    expect(priceStateTransition('OK', 'INVALIDATED')).toBe('INVALIDATED');
    expect(priceStateTransition('OK', 'TARGET_1')).toBe('TARGET_1');
    expect(priceStateTransition('WEAKENING', 'OK')).toBe('RECOVERED');
    expect(priceStateTransition('INVALIDATED', 'OK')).toBe('RECOVERED');
    expect(priceStateTransition('TARGET_1', 'OK')).toBeNull(); // targets stay info-only
  });
});

// ---------- pure: event format ----------
describe('formatRecheckEvent — the Telegram message', () => {
  it('carries desk, symbol, side and the event label', () => {
    const msg = formatRecheckEvent('INVALIDATED', { market: 'FUTURES', symbol: 'ETH', side: 'LONG' }, { ltp: 94.5, cur: '', grade: 'STRONG' });
    expect(msg).toContain('ETH');
    expect(msg).toContain('INVALIDATED');
    expect(msg).toContain('entry MAT karo');
  });
});

// ---------- the tick (injected deps) ----------
describe('recheckTick — the 15s loop with injected deps', () => {
  let boards; let ltp; let deep; let sent;

  beforeEach(() => {
    __resetSignalRecheckForTests();
    process.env.AI_SIGNAL_RECHECK = 'off'; // no interval — manual ticks only
    boards = {
      CRYPTO: board([]), FUTURES: board([sig()]), INDIA: board([]), GLOBALFUTURES: board([]),
    };
    ltp = new Map([['ETH', { price: 100.5, src: 'tick' }]]);
    deep = null;
    sent = [];
    startSignalRecheckLoop({
      getSignals: async (mkt) => boards[mkt] || board([]),
      getDeepSignal: async (sym) => deep,
      depsForSignals: () => ({}),
      send: async (text) => { sent.push(text); return { ok: true }; },
      fetchLtp: async () => ltp,
    });
  });

  afterEach(() => {
    __resetSignalRecheckForTests();
    delete process.env.AI_SIGNAL_RECHECK;
  });

  it('tick 1: watch starts, price recheck OK, checks counted', async () => {
    await recheckTick();
    const rows = __rowsForTests();
    const eth = rows.get('FUTURES:ETH');
    expect(eth).toBeTruthy();
    expect(eth.state).toBe('OK');
    expect(eth.checks).toBe(1);
    expect(eth.ltp).toBe(100.5);
    expect(__eventsForTests().some(e => e.type === 'NEW')).toBe(true);
  });

  it('SL-through on a later tick → INVALIDATED event + ONE telegram push (deduped)', async () => {
    await recheckTick(); // OK
    ltp.set('ETH', { price: 94.2, src: 'tick' });
    await recheckTick(); // INVALIDATED → push
    expect(__rowsForTests().get('FUTURES:ETH').state).toBe('INVALIDATED');
    expect(sent.filter(t => t.includes('INVALIDATED')).length).toBe(1);
    // recover → OK (no push for recovery? RECOVERED is an event but not pushed)
    ltp.set('ETH', { price: 99 });
    await recheckTick();
    expect(__rowsForTests().get('FUTURES:ETH').state).toBe('OK');
    // invalidate again within the 30-min cooldown → deduped, no second push
    ltp.set('ETH', { price: 94.0, src: 'tick' });
    await recheckTick();
    expect(__rowsForTests().get('FUTURES:ETH').state).toBe('INVALIDATED');
    expect(sent.filter(t => t.includes('INVALIDATED')).length).toBe(1);
  });

  it('deep re-vote FLIP is caught and pushed (staggered: 4th tick)', async () => {
    await recheckTick();
    await recheckTick();
    await recheckTick();
    // 4th tick triggers the deep re-vote pass
    deep = {
      ok: true,
      signal: {
        symbol: 'ETH', side: 'SHORT', grade: 'ACTION', confidence: 58,
        plan: { entry: 99, stopLoss: 104, target1: 94, target2: 89, atrUsed: 2 },
      },
    };
    await recheckTick();
    const eth = __rowsForTests().get('FUTURES:ETH');
    expect(eth.side).toBe('SHORT');
    expect(eth.grade).toBe('ACTION');
    expect(eth.stopLoss).toBe(104);
    expect(__eventsForTests().some(e => e.type === 'FLIPPED')).toBe(true);
    expect(sent.some(t => t.includes('FLIPPED'))).toBe(true);
  });

  it('board drops the signal → EXPIRED (kept, not deleted on the first pass)', async () => {
    await recheckTick();
    boards.FUTURES = board([]);
    await recheckTick();
    const eth = __rowsForTests().get('FUTURES:ETH');
    expect(eth.state).toBe('EXPIRED');
    expect(eth.expiredAt).toBeTruthy();
    expect(__rowsForTests().has('FUTURES:ETH')).toBe(true); // context kept ~5 min
  });

  it('status view: problems sort first, shape is panel-ready', async () => {
    await recheckTick();
    ltp.set('ETH', { price: 94.2, src: 'tick' });
    await recheckTick();
    const st = signalRecheckStatus();
    expect(st.ok).toBe(true);
    expect(st.tickMs).toBe(RECHECK_TICK_MS);
    expect(st.rows.length).toBeGreaterThan(0);
    expect(st.rows[0].state).toBe('INVALIDATED');
    expect(st.rows[0]).toHaveProperty('lastCheckAgeS');
    expect(st.rows[0]).toHaveProperty('events');
    expect(st.watched).toBe(1);
  });
});

// ---------- the tick-store resolver ----------
describe('buildTickStoreResolver — tick store first, staleness-honest', () => {
  it('fresh IN_/FUT_/GLOB_ ticks resolve; stale and unknown do not', () => {
    const now = Date.now();
    const getTick = (k) => {
      if (k === 'IN_ETH') return { price: 100, time: now - 1000 };
      if (k === 'FUT_BTC') return { price: 50_000, time: now - 60_000 }; // stale
      return null;
    };
    const resolve = buildTickStoreResolver({ getTick });
    expect(resolve('CRYPTO', 'ETH')).toEqual({ price: 100, src: 'tick' });
    expect(resolve('FUTURES', 'BTC')).toBeNull(); // 60s old > 45s ceiling
    expect(resolve('INDIA', 'RELIANCE')).toBeNull();
    expect(resolve('GLOBALFUTURES', 'NVDA')).toBeNull();
  });

  it('market → tick-key mapping is correct', () => {
    const seen = [];
    const resolve = buildTickStoreResolver({ getTick: (k) => { seen.push(k); return null; } });
    resolve('FUTURES', 'ETH'); resolve('GLOBALFUTURES', 'NVDA'); resolve('INDIA', 'TCS');
    expect(seen).toEqual(['FUT_ETH', 'GLOB_NVDA', 'IN_TCS']);
  });
});

// ---------- constants pin ----------
describe('recheck constants — the user contract', () => {
  it('15s cadence · STRONG+ACTION grades', () => {
    expect(RECHECK_TICK_MS).toBe(15_000);
    expect(RECHECK_GRADES).toEqual(['STRONG', 'ACTION']);
  });
});
