// ============================================================
// test/safeReduceV21280.test.ts — v21.28.0 F3 SAFE FUTURES REDUCE
// ------------------------------------------------------------
// LIVE partial exits pehle raw opposite-side order bhejte the. Ye suite
// pure reduce-plan guard + exchange-verified safe wrapper lock karti hai:
//   • already flat → no order
//   • side mismatch → no order (position ko ulta na badhao)
//   • qty > position → cap (over-reduce/flip impossible)
//   • post-trade re-read confirms reduced qty (or honestly unverified)
// ============================================================
import { describe, it, expect, vi } from 'vitest';
import { planFuturesReduce, safeReduceFuturesPosition } from '../server/ai/futures.js';

const pos = (over = {}) => ({
  id: 'p1', pair: 'B-BTC_USDT', activePos: 2, leverage: 5,
  avgPrice: 100, liquidationPrice: 80, markPrice: 100,
  ...over,
});

describe('v21.28.0 F3 — planFuturesReduce (pure)', () => {
  it('already flat → honest refuse (no order)', () => {
    const r = planFuturesReduce({ activePos: 0, expectedSide: 'LONG', requestedQty: 1 });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('already_flat');
  });

  it('side mismatch → honest refuse', () => {
    const r = planFuturesReduce({ activePos: 2, expectedSide: 'SHORT', requestedQty: 1 });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('side_mismatch');
    expect(r.actualSide).toBe('LONG');
  });

  it('requested qty greater than position is capped, never flipped', () => {
    const r = planFuturesReduce({ activePos: 2, expectedSide: 'LONG', requestedQty: 5 });
    expect(r.ok).toBe(true);
    expect(r.qty).toBe(2);
    expect(r.capped).toBe(true);
    expect(r.closeAll).toBe(true);
    expect(r.remaining).toBe(0);
  });

  it('SHORT position reduces on the SHORT side with positive qty', () => {
    const r = planFuturesReduce({ activePos: -0.75, expectedSide: 'SHORT', requestedQty: 0.4 });
    expect(r.ok).toBe(true);
    expect(r.side).toBe('SHORT');
    expect(r.qty).toBe(0.4);
    expect(r.remaining).toBe(0.35);
  });

  it('precision floor never rounds UP the reduce qty', () => {
    const r = planFuturesReduce({
      activePos: 1, expectedSide: 'LONG', requestedQty: 0.129, pair: 'B-BTC_USDT', qtyPrecision: 2,
    });
    expect(r.qty).toBe(0.12);
    expect(r.remaining).toBe(0.88);
  });

  it('invalid side / qty refused', () => {
    expect(planFuturesReduce({ activePos: 1, expectedSide: 'SIDEWAYS', requestedQty: 1 }).reason).toBe('invalid_side');
    expect(planFuturesReduce({ activePos: 1, expectedSide: 'LONG', requestedQty: 0 }).reason).toBe('invalid_qty');
  });
});

describe('v21.28.0 F3 — safeReduceFuturesPosition (exchange verified)', () => {
  it('caps qty to the exchange position and verifies post-trade reduction', async () => {
    let positions = [pos({ activePos: 2 })];
    const reduceExit = vi.fn(async ({ qty }) => {
      positions = [pos({ activePos: 2 - qty })];
      return { orderId: 'o1' };
    });
    const r = await safeReduceFuturesPosition({
      pair: 'B-BTC_USDT', qty: 5, side: 'LONG', leverage: 5, settleMs: [0],
      deps: {
        coindcxConnected: () => true,
        listFuturesPositions: async () => positions.map((p) => ({ ...p })),
        partialFuturesExit: reduceExit,
      },
    });
    expect(r.ok).toBe(true);
    expect(r.verified).toBe(true);
    expect(r.requestedQty).toBe(2);
    expect(r.capped).toBe(true);
    expect(r.postQty).toBe(0);
    expect(reduceExit).toHaveBeenCalledWith(expect.objectContaining({ qty: 2, side: 'LONG', pair: 'B-BTC_USDT' }));
  });

  it('pre-read flat → no exchange order at all', async () => {
    const reduceExit = vi.fn();
    const r = await safeReduceFuturesPosition({
      pair: 'B-BTC_USDT', qty: 1, side: 'LONG', settleMs: [0],
      deps: {
        coindcxConnected: () => true,
        listFuturesPositions: async () => [],
        partialFuturesExit: reduceExit,
      },
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('already_flat');
    expect(reduceExit).not.toHaveBeenCalled();
  });

  it('exchange side mismatch → no order', async () => {
    const reduceExit = vi.fn();
    const r = await safeReduceFuturesPosition({
      pair: 'B-BTC_USDT', qty: 1, side: 'SHORT', settleMs: [0],
      deps: {
        coindcxConnected: () => true,
        listFuturesPositions: async () => [pos({ activePos: 2 })],
        partialFuturesExit: reduceExit,
      },
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('side_mismatch');
    expect(reduceExit).not.toHaveBeenCalled();
  });

  it('pre-read network failure refuses a blind reduce', async () => {
    const reduceExit = vi.fn();
    const r = await safeReduceFuturesPosition({
      pair: 'B-BTC_USDT', qty: 1, side: 'LONG', settleMs: [0],
      deps: {
        coindcxConnected: () => true,
        listFuturesPositions: async () => { throw new Error('timeout'); },
        partialFuturesExit: reduceExit,
      },
    });
    expect(r.ok).toBe(false);
    expect(r.phase).toBe('pre');
    expect(reduceExit).not.toHaveBeenCalled();
  });

  it('order accepted but qty unreadable → verified:false with honest warning', async () => {
    const reduceExit = vi.fn(async () => ({ orderId: 'o2' }));
    const r = await safeReduceFuturesPosition({
      pair: 'B-BTC_USDT', qty: 0.5, side: 'LONG', settleMs: [0, 0],
      deps: {
        coindcxConnected: () => true,
        listFuturesPositions: async () => [pos({ activePos: 2 })], // stale exchange truth
        partialFuturesExit: reduceExit,
      },
    });
    expect(r.ok).toBe(true);
    expect(r.verified).toBe(false);
    expect(r.orderId).toBe('o2');
    expect(r.warning).toMatch(/re-read/i);
  });

  it('disconnected → refuse before any read/order', async () => {
    const reduceExit = vi.fn();
    const read = vi.fn();
    const r = await safeReduceFuturesPosition({
      pair: 'B-BTC_USDT', qty: 1, side: 'LONG',
      deps: { coindcxConnected: () => false, listFuturesPositions: read, partialFuturesExit: reduceExit },
    });
    expect(r.ok).toBe(false);
    expect(read).not.toHaveBeenCalled();
    expect(reduceExit).not.toHaveBeenCalled();
  });
});
