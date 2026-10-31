// ============================================================
// test/orderHygieneR1.test.ts — v21.29.0 R1 ORDER HYGIENE + IDEMPOTENCY
// ------------------------------------------------------------
// Locks:
//   • action keys are stable + duplicate-safe; done/ambiguous hold,
//     deterministic release frees the key, TTL expires
//   • futures open-order list/cancel helpers never fake ok
//   • hygiene on = cancel, shadow = list only, off = no exchange call
//   • executeMtfDualLiveOrder refuses a duplicate key before any network
// ============================================================
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  actionKey, claimAction, finishAction, releaseAction, getAction, withActionLock,
  __resetTradeActionLogForTests,
} from '../server/ai/tradeActionLog.js';
import {
  listFuturesOpenOrders, cancelFuturesOpenOrder, cancelFuturesOpenOrdersForPair,
  orderHygieneMode, runOrderHygieneForPair, executeMtfDualLiveOrder,
  classifyOpenOrder, orderHygieneScope, confirmFuturesFlatForPair,
} from '../server/ai/futures.js';

beforeEach(() => { __resetTradeActionLogForTests(); });
afterEach(() => { __resetTradeActionLogForTests(); });

describe('v21.29.0 R1 — trade action log idempotency', () => {
  it('actionKey is stable and input-sensitive', () => {
    expect(actionKey(['a', 1])).toBe(actionKey(['a', 1]));
    expect(actionKey(['a', 1])).not.toBe(actionKey(['a', 2]));
  });

  it('claim → duplicate; finish holds; release frees', () => {
    const k = actionKey(['order', 'BTC', 1]);
    expect(claimAction(k, { now: 1000, ttlMs: 10_000 }).ok).toBe(true);
    const dup = claimAction(k, { now: 2000 });
    expect(dup.ok).toBe(false);
    expect(dup.duplicate).toBe(true);
    expect(dup.status).toBe('in_progress');

    finishAction(k, { status: 'done', now: 2500 });
    expect(claimAction(k, { now: 3000 }).duplicate).toBe(true);
    expect(getAction(k, { now: 3000 }).status).toBe('done');

    releaseAction(k, { now: 3500 });
    expect(claimAction(k, { now: 3600 }).ok).toBe(true);
  });

  it('TTL expiry allows a new claim', () => {
    const k = actionKey(['order', 'ETH']);
    claimAction(k, { now: 1_000, ttlMs: 5_000 });
    expect(claimAction(k, { now: 6_500 }).ok).toBe(true);
  });

  it('withActionLock runs fn once per key', async () => {
    const k = actionKey(['once']);
    const fn = vi.fn(async () => 42);
    const first = await withActionLock(k, fn);
    expect(first.ok).toBe(true);
    expect(first.value).toBe(42);
    const second = await withActionLock(k, fn);
    expect(second.ok).toBe(false);
    expect(second.duplicate).toBe(true);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('withActionLock releases the key when fn throws', async () => {
    const k = actionKey(['boom']);
    await expect(withActionLock(k, async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    expect(getAction(k)).toBeNull();
  });
});

describe('v21.29.0 R1 — futures open-order helpers (deps seam)', () => {
  it('lists + maps open orders through the injected seam', async () => {
    const r = await listFuturesOpenOrders({
      pair: 'B-BTC_USDT',
      deps: { listOpenOrders: async () => ({ ok: true, orders: [{ id: 'o1', pair: 'B-BTC_USDT', side: 'buy', total_quantity: 2 }] }) },
    });
    expect(r.ok).toBe(true);
    expect(r.orders[0]).toMatchObject({ orderId: 'o1', pair: 'B-BTC_USDT', qty: 2 });
  });

  it('unsupported response shape is surfaced (never a fake ok)', async () => {
    const r = await listFuturesOpenOrders({
      deps: { listOpenOrders: async () => ({ ok: false, error: 'shape unknown' }) },
    });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/shape unknown/i);
  });

  it('all cancels accepted → ok:true; one rejection → ok:false + failed[]', async () => {
    const okAll = await cancelFuturesOpenOrdersForPair({
      pair: 'B-BTC_USDT',
      deps: {
        listOpenOrders: async () => ({ ok: true, orders: [{ id: 'o1' }, { id: 'o2' }] }),
        cancelOpenOrder: async ({ orderId }) => ({ ok: true, orderId }),
      },
    });
    expect(okAll.ok).toBe(true);
    expect(okAll.cancelled).toEqual(['o1', 'o2']);

    const partial = await cancelFuturesOpenOrdersForPair({
      pair: 'B-BTC_USDT',
      deps: {
        listOpenOrders: async () => ({ ok: true, orders: [{ id: 'o1' }, { id: 'o2' }] }),
        cancelOpenOrder: async ({ orderId }) => (orderId === 'o2'
          ? { ok: false, error: 'rejected' }
          : { ok: true, orderId }),
      },
    });
    expect(partial.ok).toBe(false);
    expect(partial.cancelled).toEqual(['o1']);
    expect(partial.failed).toHaveLength(1);
  });

  it('cancelFuturesOpenOrder requires an id', async () => {
    const r = await cancelFuturesOpenOrder({ orderId: '  ' });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/orderId required/i);
  });
});

describe('v21.29.0 R1 — order hygiene modes', () => {
  const prev = process.env.FUTURES_ORDER_HYGIENE;
  afterEach(() => {
    if (prev === undefined) delete process.env.FUTURES_ORDER_HYGIENE; else process.env.FUTURES_ORDER_HYGIENE = prev;
  });

  it('defaults to on; parses shadow/off aliases', () => {
    delete process.env.FUTURES_ORDER_HYGIENE;
    expect(orderHygieneMode()).toBe('on');
    process.env.FUTURES_ORDER_HYGIENE = 'shadow';
    expect(orderHygieneMode()).toBe('shadow');
    process.env.FUTURES_ORDER_HYGIENE = 'off';
    expect(orderHygieneMode()).toBe('off');
  });

  it('shadow lists but never calls cancel', async () => {
    process.env.FUTURES_ORDER_HYGIENE = 'shadow';
    const cancelOpenOrder = vi.fn();
    const r = await runOrderHygieneForPair({
      pair: 'B-BTC_USDT',
      deps: {
        listOpenOrders: async () => ({ ok: true, orders: [{ id: 'o1' }, { id: 'o2' }] }),
        cancelOpenOrder,
      },
    });
    expect(r.shadow).toBe(true);
    expect(r.wouldCancel).toEqual(['o1', 'o2']);
    expect(cancelOpenOrder).not.toHaveBeenCalled();
  });

  it('off performs no exchange call at all', async () => {
    process.env.FUTURES_ORDER_HYGIENE = 'off';
    const listOpenOrders = vi.fn();
    const r = await runOrderHygieneForPair({ pair: 'B-BTC_USDT', deps: { listOpenOrders } });
    expect(r.skipped).toBe(true);
    expect(listOpenOrders).not.toHaveBeenCalled();
  });

  it('on cancels through the deps seam', async () => {
    process.env.FUTURES_ORDER_HYGIENE = 'on';
    const r = await runOrderHygieneForPair({
      pair: 'B-BTC_USDT',
      deps: {
        listOpenOrders: async () => ({ ok: true, orders: [{ id: 'o1' }] }),
        cancelOpenOrder: async ({ orderId }) => ({ ok: true, orderId }),
      },
    });
    expect(r.ok).toBe(true);
    expect(r.cancelled).toEqual(['o1']);
  });
});

describe('v21.30.0 S1 — order classification + phase-aware hygiene', () => {
  const prevMode = process.env.FUTURES_ORDER_HYGIENE;
  const prevScope = process.env.FUTURES_HYGIENE_SCOPE;
  afterEach(() => {
    if (prevMode === undefined) delete process.env.FUTURES_ORDER_HYGIENE;
    else process.env.FUTURES_ORDER_HYGIENE = prevMode;
    if (prevScope === undefined) delete process.env.FUTURES_HYGIENE_SCOPE;
    else process.env.FUTURES_HYGIENE_SCOPE = prevScope;
  });

  const mixedOrders = () => ([
    { id: 'e1', pair: 'B-BTC_USDT', type: 'LIMIT', limit_price: 100 },
    { id: 'p1', pair: 'B-BTC_USDT', type: 'STOP_MARKET' },
    { id: 'p2', pair: 'B-BTC_USDT', type: 'TAKE_PROFIT_MARKET' },
    { id: 'p3', pair: 'B-BTC_USDT', type: 'LIMIT', reduce_only: true },
    { id: 'u1', pair: 'B-BTC_USDT', type: 'SOMETHING_NEW' },
  ]);

  it('classifies entry / protective / unknown without guessing', () => {
    expect(classifyOpenOrder({ type: 'LIMIT' })).toBe('ENTRY');
    expect(classifyOpenOrder({ type: 'MARKET' })).toBe('ENTRY');
    expect(classifyOpenOrder({})).toBe('ENTRY'); // legacy R1 row
    expect(classifyOpenOrder({ type: 'STOP_MARKET' })).toBe('PROTECTIVE');
    expect(classifyOpenOrder({ type: 'TAKE_PROFIT_MARKET' })).toBe('PROTECTIVE');
    expect(classifyOpenOrder({ type: 'LIMIT', raw: { stop_price: '95' } })).toBe('PROTECTIVE');
    expect(classifyOpenOrder({ type: 'LIMIT', raw: { reduce_only: true } })).toBe('PROTECTIVE');
    expect(classifyOpenOrder({ type: 'SOMETHING_NEW' })).toBe('UNKNOWN');
  });

  it('scope defaults to entry-only and parses all', () => {
    delete process.env.FUTURES_HYGIENE_SCOPE;
    expect(orderHygieneScope()).toBe('entry-only');
    process.env.FUTURES_HYGIENE_SCOPE = 'ALL';
    expect(orderHygieneScope()).toBe('all');
  });

  it('pre-close cancels ENTRY only; PROTECTIVE + UNKNOWN stay', async () => {
    process.env.FUTURES_ORDER_HYGIENE = 'on';
    delete process.env.FUTURES_HYGIENE_SCOPE;
    const cancelled: string[] = [];
    const r = await runOrderHygieneForPair({
      pair: 'B-BTC_USDT', phase: 'pre-close',
      deps: {
        listOpenOrders: async () => ({ ok: true, orders: mixedOrders() }),
        cancelOpenOrder: async ({ orderId }) => { cancelled.push(orderId); return { ok: true, orderId }; },
      },
    });
    expect(r.ok).toBe(true);
    expect(r.cancelled).toEqual(['e1']);
    expect(cancelled).toEqual(['e1']);
    expect(r.kept.map((k: any) => k.orderId).sort()).toEqual(['p1', 'p2', 'p3', 'u1']);
    expect(r.classified).toMatchObject({ ENTRY: 1, PROTECTIVE: 3, UNKNOWN: 1 });
  });

  it('post-flat cancels ENTRY + PROTECTIVE; UNKNOWN is never auto-cancelled', async () => {
    process.env.FUTURES_ORDER_HYGIENE = 'on';
    const cancelled: string[] = [];
    const r = await runOrderHygieneForPair({
      pair: 'B-BTC_USDT', phase: 'post-flat',
      deps: {
        listOpenOrders: async () => ({ ok: true, orders: mixedOrders() }),
        cancelOpenOrder: async ({ orderId }) => { cancelled.push(orderId); return { ok: true, orderId }; },
      },
    });
    expect(r.ok).toBe(true);
    expect(cancelled.sort()).toEqual(['e1', 'p1', 'p2', 'p3']);
    expect(r.kept).toEqual([{ orderId: 'u1', class: 'UNKNOWN' }]);
  });

  it('scope=all widens pre-close, but rearm stays ENTRY-only', async () => {
    process.env.FUTURES_ORDER_HYGIENE = 'on';
    const wide: string[] = [];
    await runOrderHygieneForPair({
      pair: 'B-BTC_USDT', phase: 'pre-close', scope: 'all',
      deps: {
        listOpenOrders: async () => ({ ok: true, orders: mixedOrders() }),
        cancelOpenOrder: async ({ orderId }) => { wide.push(orderId); return { ok: true, orderId }; },
      },
    });
    expect(wide.sort()).toEqual(['e1', 'p1', 'p2', 'p3']);

    const rearm: string[] = [];
    await runOrderHygieneForPair({
      pair: 'B-BTC_USDT', phase: 'rearm', scope: 'all',
      deps: {
        listOpenOrders: async () => ({ ok: true, orders: mixedOrders() }),
        cancelOpenOrder: async ({ orderId }) => { rearm.push(orderId); return { ok: true, orderId }; },
      },
    });
    expect(rearm).toEqual(['e1']);
  });

  it('shadow reports the phase-filtered wouldCancel list without cancelling', async () => {
    process.env.FUTURES_ORDER_HYGIENE = 'shadow';
    const cancelOpenOrder = vi.fn();
    const r = await runOrderHygieneForPair({
      pair: 'B-BTC_USDT', phase: 'post-flat',
      deps: { listOpenOrders: async () => ({ ok: true, orders: mixedOrders() }), cancelOpenOrder },
    });
    expect(r.shadow).toBe(true);
    expect(r.wouldCancel.sort()).toEqual(['e1', 'p1', 'p2', 'p3']);
    expect(cancelOpenOrder).not.toHaveBeenCalled();
  });

  it('flat confirmation is true only on a successful read with no active row', async () => {
    const flat = await confirmFuturesFlatForPair('B-BTC_USDT', {
      deps: {
        listPositions: async () => [
          { pair: 'B-ETH_USDT', activePos: 2 },
          { pair: 'B-BTC_USDT', activePos: 0 },
        ],
      },
    });
    expect(flat).toEqual({ flat: true, pair: 'B-BTC_USDT' });

    const active = await confirmFuturesFlatForPair('B-BTC_USDT', {
      deps: { listPositions: async () => [{ pair: 'B-BTC_USDT', activePos: -1.5 }] },
    });
    expect(active.flat).toBe(false);
    expect(active.activePos).toBe(-1.5);

    const unknown = await confirmFuturesFlatForPair('B-BTC_USDT', {
      deps: { listPositions: async () => { throw new Error('positions unreachable'); } },
    });
    expect(unknown.flat).toBeNull();
    expect(unknown.reason).toMatch(/unreachable/);

    expect((await confirmFuturesFlatForPair('', { deps: {} })).flat).toBeNull();
  });
});

describe('v21.29.0 R1 — live order idempotency gate', () => {
  it('a claimed plan key blocks the order BEFORE any network call', async () => {
    const opts = {
      symbol: 'BTC', side: 'LONG', mode: 'INTRADAY', source: 'mtf-dual-board',
      entry: 100, stopLoss: 99, t1: 101, t2: 102,
    };
    const key = actionKey(['mtf-live', opts.symbol, opts.side, opts.mode, opts.source,
      opts.entry, opts.stopLoss, opts.t1, opts.t2]);
    claimAction(key, { ttlMs: 60_000 });
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const r = await executeMtfDualLiveOrder(opts);
    expect(r.ok).toBe(false);
    expect(r.duplicate).toBe(true);
    expect(r.idempotencyKey).toBe(key);
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});
