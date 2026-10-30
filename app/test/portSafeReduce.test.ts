// ============================================================
// test/portSafeReduce.test.ts — v21.29.0 R0a SAFE REDUCE + R1 WIRING
// ------------------------------------------------------------
// Locks:
//   • ApiFuturesPort.reduce delegates to futures.safeReduceFuturesPosition
//     (pre-read → guarded opposite-side order → post-read verify)
//   • already_flat is an idempotent success; side_mismatch / invalid_qty
//     never retry; ambiguous/unverified reduction returns retryAfterMs
//   • cancelOpenOrders is honestly wired (ok only when every cancel was
//     accepted; unsupported shape is surfaced instead of a fake ok)
//   • PositionManager honours the 5-minute no-blind-retry hold and deletes
//     local state on already_flat instead of advancing a phantom ladder
// ============================================================
import { describe, it, expect, vi } from 'vitest';
import { ApiFuturesPort, PaperPort } from '../server/exec/port.js';
import { PositionManager } from '../server/exec/positionManager.js';

function _pos(over = {}) {
  return { id: 'pos1', pair: 'B-BTC_USDT', activePos: 2, avgPrice: 100, leverage: 5, markPrice: 100, ...over };
}

function _portWith(safeReduce, over = {}) {
  const fut = {
    fetchFuturesWallets: vi.fn(async () => []),
    listFuturesPositions: vi.fn(async () => [_pos()]),
    partialFuturesExit: vi.fn(async () => ({ orderId: 'raw-1' })),
    safeReduceFuturesPosition: vi.fn(safeReduce),
    ...over,
  };
  return { fut, port: new ApiFuturesPort({ futuresMod: fut }) };
}

describe('v21.29.0 R0a — ApiFuturesPort.reduce uses the guarded reducer', () => {
  it('verified reduction → ok:true with verified qty truth', async () => {
    const { fut, port } = _portWith(async () => ({
      ok: true, verified: true, orderId: 'red-1', preQty: 2, requestedQty: 0.8,
      postQty: 1.2, capped: false, closeAll: false,
    }));
    const r = await port.reduce({ positionId: 'pos1', qty: 0.8 });
    expect(r.ok).toBe(true);
    expect(r.verified).toBe(true);
    expect(r.postQty).toBe(1.2);
    expect(fut.safeReduceFuturesPosition).toHaveBeenCalledWith(expect.objectContaining({
      positionId: 'pos1', pair: 'B-BTC_USDT', qty: 0.8, side: 'LONG', leverage: 5,
    }));
    expect(fut.partialFuturesExit).not.toHaveBeenCalled();
  });

  it('already_flat → idempotent success (no order sent, no retry)', async () => {
    const { fut, port } = _portWith(async () => ({
      ok: false, phase: 'pre', reason: 'already_flat', error: 'no open exchange position',
    }));
    const r = await port.reduce({ positionId: 'pos1', qty: 0.8 });
    expect(r.ok).toBe(true);
    expect(r.alreadyFlat).toBe(true);
    expect(r.reason).toBe('already_flat');
    expect(fut.partialFuturesExit).not.toHaveBeenCalled();
  });

  it('missing exchange row + safe helper present → alreadyFlat (not a hard failure)', async () => {
    const { port } = _portWith(async () => ({ ok: true, verified: true }), {
      listFuturesPositions: vi.fn(async () => []),
    });
    const r = await port.reduce({ positionId: 'gone', qty: 1 });
    expect(r.ok).toBe(true);
    expect(r.alreadyFlat).toBe(true);
  });

  it('side_mismatch → ok:false, retryAfterMs 0 (never auto-retries a wrong-side reduce)', async () => {
    const { port } = _portWith(async () => ({
      ok: false, phase: 'pre', reason: 'side_mismatch', actualSide: 'SHORT',
      error: 'side mismatch',
    }));
    const r = await port.reduce({ positionId: 'pos1', qty: 0.8 });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('side_mismatch');
    expect(r.retryAfterMs).toBe(0);
  });

  it('invalid_qty → ok:false, retryAfterMs 0', async () => {
    const { port } = _portWith(async () => ({
      ok: false, phase: 'pre', reason: 'invalid_qty', error: 'qty must be > 0',
    }));
    const r = await port.reduce({ positionId: 'pos1', qty: 0 });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('invalid_qty');
    expect(r.retryAfterMs).toBe(0);
  });

  it('accepted order but unverified post-read → ok:false + 5-minute hold', async () => {
    const { port } = _portWith(async () => ({
      ok: true, verified: false, orderId: 'red-2', warning: 'post-read did not reflect reduction',
    }));
    const r = await port.reduce({ positionId: 'pos1', qty: 0.8 });
    expect(r.ok).toBe(false);
    expect(r.verified).toBe(false);
    expect(r.ambiguous).toBe(true);
    expect(r.retryAfterMs).toBe(300_000);
  });

  it('transport ambiguity on the order → ok:false + 5-minute hold', async () => {
    const { port } = _portWith(async () => ({
      ok: false, phase: 'order', ambiguous: true, error: 'timeout',
    }));
    const r = await port.reduce({ positionId: 'pos1', qty: 0.8 });
    expect(r.ok).toBe(false);
    expect(r.ambiguous).toBe(true);
    expect(r.retryAfterMs).toBe(300_000);
  });

  it('no safe helper (legacy mock) preserves the raw honest path', async () => {
    const fut = {
      listFuturesPositions: vi.fn(async () => [_pos()]),
      partialFuturesExit: vi.fn(async () => ({ orderId: 'raw-1', raw: {} })),
    };
    const port = new ApiFuturesPort({ futuresMod: fut });
    const r = await port.reduce({ positionId: 'pos1', qty: 0.5 });
    expect(r.ok).toBe(true);
    expect(fut.partialFuturesExit).toHaveBeenCalledWith({
      pair: 'B-BTC_USDT', qty: 0.5, side: 'LONG', leverage: 5,
    });
  });
});

describe('v21.29.0 R1 — cancelOpenOrders honest wiring', () => {
  it('all cancels accepted → ok:true with the cancelled ids', async () => {
    const fut = {
      cancelFuturesOpenOrdersForPair: vi.fn(async () => ({ ok: true, cancelled: ['o1', 'o2'], failed: [] })),
    };
    const port = new ApiFuturesPort({ futuresMod: fut });
    const r = await port.cancelOpenOrders({ pair: 'B-BTC_USDT' });
    expect(r.ok).toBe(true);
    expect(r.cancelled).toEqual(['o1', 'o2']);
    expect(fut.cancelFuturesOpenOrdersForPair).toHaveBeenCalledWith({ pair: 'B-BTC_USDT' });
  });

  it('partial/unsupported cancel → ok:false + manual verification note', async () => {
    const fut = {
      cancelFuturesOpenOrdersForPair: vi.fn(async () => ({
        ok: false, unsupported: true, failed: [{ orderId: 'o1', error: 'unknown shape' }],
      })),
    };
    const port = new ApiFuturesPort({ futuresMod: fut });
    const r = await port.cancelOpenOrders({ pair: 'B-BTC_USDT' });
    expect(r.ok).toBe(false);
    expect(r.unsupported).toBe(true);
    expect(r.note).toMatch(/manually verify/i);
  });

  it('helper missing → honest unsupported verdict (never fake ok)', async () => {
    const port = new ApiFuturesPort({ futuresMod: {} });
    const r = await port.cancelOpenOrders({ pair: 'B-BTC_USDT' });
    expect(r.ok).toBe(false);
    expect(r.unsupported).toBe(true);
  });
});

function _signal() {
  return {
    pair: 'B-BTC_USDT', symbol: 'BTC', side: 'LONG', ltp: 100,
    superIntel: { tier: 'STRONG', aiScore: 85 }, grade: 'STRONG', __riskPct: 1,
  };
}
function _plan() {
  return { entry: 100, stopLoss: 98.5, target1: 101.5, target2: 103 };
}

describe('v21.29.0 R0a — PositionManager no-blind-retry hold', () => {
  it('ambiguous reduce → second candle does NOT retry (hold active)', async () => {
    const port = new PaperPort({ startingEquityUSDT: 1000 });
    const pm = new PositionManager({ port });
    const opened = await pm.protectionFirstEntry({ signal: _signal(), plan: _plan() });
    expect(opened.ok).toBe(true);
    let reduceCalls = 0;
    port.reduce = async () => {
      reduceCalls++;
      return { ok: false, ambiguous: true, retryAfterMs: 300_000, error: 'unverified' };
    };
    port.setMarkPrice('B-BTC_USDT', 101.5);
    const a1 = await pm.tick({ pricesByPair: { 'B-BTC_USDT': 101.5 } });
    expect(a1.find(a => a.kind === 't1:reduce-failed')).toBeTruthy();
    expect(reduceCalls).toBe(1);
    // Same T1 level on the next candle: held, no second opposite-side order.
    const a2 = await pm.tick({ pricesByPair: { 'B-BTC_USDT': 101.5 } });
    expect(a2.find(a => a.kind === 't1:reduce-hold')).toBeTruthy();
    expect(reduceCalls).toBe(1);
  });

  it('already_flat reduce → local state deleted (no phantom ladder)', async () => {
    const port = new PaperPort({ startingEquityUSDT: 1000 });
    const pm = new PositionManager({ port });
    await pm.protectionFirstEntry({ signal: _signal(), plan: _plan() });
    port.reduce = async () => ({ ok: true, alreadyFlat: true, reason: 'already_flat' });
    port.setMarkPrice('B-BTC_USDT', 101.5);
    const actions = await pm.tick({ pricesByPair: { 'B-BTC_USDT': 101.5 } });
    expect(actions.find(a => a.kind === 't1:already-flat')).toBeTruthy();
    expect(pm._stateForTests().length).toBe(0);
  });
});
