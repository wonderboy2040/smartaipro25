// ============================================================
// test/execPort.test.ts — v20.7 Execution Port contract tests
// ------------------------------------------------------------
// Same scenarios run across all 3 adapters (ApiFuturesPort,
// BrowserCdpPort, PaperPort) to verify the contract holds.
// ============================================================
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ApiFuturesPort, BrowserCdpPort, PaperPort } from '../server/exec/port.js';

// stub futures.js for ApiFuturesPort
// v20.7.12: createFuturesOrder ka naya HONEST contract — {orderId, error?, raw}
// (pehle {id, ...p} spread tha; port.open ab exchange-issued orderId ke
// bina ok:false deta hai — 200-wrapped rejection / id-less body class).
const _futMock = {
  fetchFuturesWallets: vi.fn(async () => [{ currency: 'USDT', free: 500, locked: 0, total: 500, crossUserMargin: 0 }]),
  listFuturesPositions: vi.fn(async () => []),
  createFuturesOrder: vi.fn(async (p) => ({ orderId: `ord-${Math.random().toString(36).slice(2, 10)}`, raw: { ...p } })),
  createFuturesTpsl: vi.fn(async (p) => ({ ok: true, ...p })),
  partialFuturesExit: vi.fn(async (p) => ({ ok: true, orderId: `red-${Math.random().toString(36).slice(2, 8)}`, raw: { ...p } })),
  exitFuturesPosition: vi.fn(async (p) => ({ ok: true, ...p })),
};

beforeEach(() => {
  _futMock.fetchFuturesWallets.mockClear();
  _futMock.listFuturesPositions.mockClear();
  _futMock.createFuturesOrder.mockClear();
  _futMock.createFuturesTpsl.mockClear();
  _futMock.partialFuturesExit.mockClear();
  _futMock.exitFuturesPosition.mockClear();
});

describe('v20.7 PaperPort — contract', () => {
  it('health() returns { ok, mode: paper, latencyMs, reasons }', async () => {
    const p = new PaperPort({ startingEquityUSDT: 1000 });
    const h = await p.health();
    expect(h.ok).toBe(true);
    expect(h.mode).toBe('paper');
    expect(typeof h.latencyMs).toBe('number');
    expect(Array.isArray(h.reasons)).toBe(true);
  });
  it('getEquity() returns { totalUSDT, freeUSDT, unrealizedUSDT }', async () => {
    const p = new PaperPort({ startingEquityUSDT: 1000 });
    const e = await p.getEquity();
    expect(e.totalUSDT).toBe(1000);
    expect(e.freeUSDT).toBe(1000);
    expect(e.unrealizedUSDT).toBe(0);
  });
  it('open() with clientId idempotency — duplicate clientId returns ok without new fill', async () => {
    const p = new PaperPort({ startingEquityUSDT: 1000 });
    const r1 = await p.open({ pair: 'B-BTC_USDT', side: 'LONG', qty: 0.01, leverage: 5, type: 'market', price: 100, sl: 98, tp: 105, clientId: 'x1' });
    expect(r1.ok).toBe(true);
    const r2 = await p.open({ pair: 'B-BTC_USDT', side: 'LONG', qty: 0.01, leverage: 5, type: 'market', price: 100, sl: 98, tp: 105, clientId: 'x1' });
    expect(r2.ok).toBe(true);
    // v20.8.2: the duplicate verdict now RETURNS THE EXISTING POSITION
    // (dup:true) instead of a positionless ok — the runner's order event
    // used to log a fake second "order ok" for a trade never placed.
    expect(r2.dup).toBe(true);
    expect(r2.orderId).toBe(r1.orderId);
    const positions = await p.getPositions();
    expect(positions.length).toBe(1); // only ONE position — idempotent
  });
  it('open() rejects when insufficient free margin', async () => {
    const p = new PaperPort({ startingEquityUSDT: 50 });
    // qty 1 × price 100 = 100 notional / 5x lev = 20 margin > 50 free? no, 20 < 50 ok
    // try qty 10 × 100 / 5x = 200 margin > 50 → reject
    const r = await p.open({ pair: 'B-BTC_USDT', side: 'LONG', qty: 10, leverage: 5, type: 'market', price: 100, sl: 95, tp: 110, clientId: 'big' });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/insufficient free margin/i);
  });
  it('setProtection() updates SL/TP on an existing position', async () => {
    const p = new PaperPort({ startingEquityUSDT: 1000 });
    const o = await p.open({ pair: 'B-BTC_USDT', side: 'LONG', qty: 0.1, leverage: 5, type: 'market', price: 100, sl: 95, tp: 110, clientId: 'p1' });
    const r = await p.setProtection({ positionId: o.orderId, sl: 98, tp: 108 });
    expect(r.ok).toBe(true);
    const positions = await p.getPositions();
    expect(positions[0].sl).toBe(98);
    expect(positions[0].tp).toBe(108);
  });
  it('reduce() partial-closes and frees proportional margin', async () => {
    const p = new PaperPort({ startingEquityUSDT: 1000 });
    const o = await p.open({ pair: 'B-BTC_USDT', side: 'LONG', qty: 0.1, leverage: 5, type: 'market', price: 100, sl: 95, tp: 110, clientId: 'p2' });
    const eqBefore = await p.getEquity();
    const r = await p.reduce({ positionId: o.orderId, qty: 0.04 });
    expect(r.ok).toBe(true);
    const positions = await p.getPositions();
    expect(positions[0].qty).toBeCloseTo(0.06, 4);
    const eqAfter = await p.getEquity();
    expect(eqAfter.freeUSDT).toBeGreaterThan(eqBefore.freeUSDT);
  });
  it('close() realizes P&L and returns the realized amount', async () => {
    const p = new PaperPort({ startingEquityUSDT: 1000 });
    const o = await p.open({ pair: 'B-BTC_USDT', side: 'LONG', qty: 0.1, leverage: 5, type: 'market', price: 100, sl: 95, tp: 110, clientId: 'p3' });
    p.setMarkPrice('B-BTC_USDT', 110); // +10 USD unrealized
    const r = await p.close({ positionId: o.orderId });
    expect(r.ok).toBe(true);
    expect(r.raw.realizedPnl).toBeGreaterThan(0);
    const positions = await p.getPositions();
    expect(positions.length).toBe(0);
  });
  it('liquidation price matches the 0.95/lev formula (5x → ~19% below entry for LONG)', async () => {
    const p = new PaperPort({ startingEquityUSDT: 1000 });
    const o = await p.open({ pair: 'B-BTC_USDT', side: 'LONG', qty: 0.1, leverage: 5, type: 'market', price: 100, sl: 95, tp: 110, clientId: 'p4' });
    const positions = await p.getPositions();
    // 0.95/5 = 0.19 → liq ≈ 100 × (1 - 0.19) = 81
    expect(positions[0].liqPrice).toBeCloseTo(81, 1);
  });
});

describe('v20.7 ApiFuturesPort — contract (with stubbed futures.js)', () => {
  it('health() returns ok when fetchFuturesWallets returns array', async () => {
    const port = new ApiFuturesPort({ futuresMod: _futMock });
    const h = await port.health();
    expect(h.ok).toBe(true);
    expect(h.mode).toBe('api');
  });
  it('getEquity() reads USDT row from fetchFuturesWallets', async () => {
    const port = new ApiFuturesPort({ futuresMod: _futMock });
    const e = await port.getEquity();
    expect(e.totalUSDT).toBe(500);
    expect(e.freeUSDT).toBe(500);
  });
  it('getPositions() maps activePos sign to side', async () => {
    _futMock.listFuturesPositions.mockResolvedValueOnce([
      { id: 'pos1', pair: 'B-BTC_USDT', activePos: 0.5, avgPrice: 100, leverage: 5, liquidationPrice: 81, sl: 95, tp: 110, markPrice: 105 },
      { id: 'pos2', pair: 'B-ETH_USDT', activePos: -2.0, avgPrice: 50, leverage: 3, liquidationPrice: 65, sl: 55, tp: 45, markPrice: 48 },
    ]);
    const port = new ApiFuturesPort({ futuresMod: _futMock });
    const positions = await port.getPositions();
    expect(positions[0].side).toBe('LONG');
    expect(positions[0].qty).toBe(0.5);
    expect(positions[1].side).toBe('SHORT');
    expect(positions[1].qty).toBe(2.0);
  });
  it('v20.7.10 open(): ADAPTER-EXACT keys — qty (not quantity), side buy/sell, market price:null (pehle quantity:qty → NaN → exchange 400 + client_id silently dropped)', async () => {
    const port = new ApiFuturesPort({ futuresMod: _futMock });
    const r = await port.open({ pair: 'B-BTC_USDT', side: 'LONG', qty: 0.01, leverage: 5, type: 'market', price: 100, sl: 95, tp: 110, clientId: 'c1' });
    expect(r.ok).toBe(true);
    const call = _futMock.createFuturesOrder.mock.calls[0][0];
    expect(call.qty).toBe(0.01);            // destructure key — NOT `quantity`
    expect(call.quantity).toBeUndefined();
    expect(call.pair).toBe('B-BTC_USDT');
    expect(call.side).toBe('buy');          // LONG → buy
    expect(call.leverage).toBe(5);
    expect(call.price).toBeNull();          // market → null (order_type price>0 se derive hota hai)
    expect(call.client_id).toBeUndefined(); // adapter sirf documented keys leta hai
    expect(r.clientId).toBe('c1');          // caller-side idempotency ledger echo
  });
  it('v20.7.10 open(): SHORT + limit → side sell + numeric price passthrough', async () => {
    const port = new ApiFuturesPort({ futuresMod: _futMock });
    const r = await port.open({ pair: 'B-ETH_USDT', side: 'SHORT', qty: 2, leverage: 3, type: 'limit', price: 50 });
    expect(r.ok).toBe(true);
    const call = _futMock.createFuturesOrder.mock.calls[0][0];
    expect(call.side).toBe('sell');
    expect(call.price).toBe(50);
  });
  it('v20.7.10 setProtection(): stopLoss/takeProfit keys (adapter destructure — pehle sl/tp undefined → "no levels given" → ok:true LIE, naked leveraged position!)', async () => {
    const port = new ApiFuturesPort({ futuresMod: _futMock });
    const r = await port.setProtection({ positionId: 'pos1', sl: 95, tp: 110 });
    expect(r.ok).toBe(true);
    expect(_futMock.createFuturesTpsl).toHaveBeenCalledWith({ positionId: 'pos1', stopLoss: 95, takeProfit: 110 });
  });
  it('v20.7.10 setProtection(): adapter reject ({ok:false}) ab port bhi ok:false (pehle !!r truthy-object LIE — SL set na hote hue bhi protected maan liya jata tha)', async () => {
    _futMock.createFuturesTpsl.mockResolvedValueOnce({ ok: false, error: 'no levels given' });
    const port = new ApiFuturesPort({ futuresMod: _futMock });
    const r = await port.setProtection({ positionId: 'pos1', sl: 95, tp: 110 });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/no levels given/);
  });
  it('v20.7.10 close(): exitFuturesPosition ko POSITIONAL positionId (pehle {positionId} object → "[object Object]" exchange request body me)', async () => {
    const port = new ApiFuturesPort({ futuresMod: _futMock });
    const r = await port.close({ positionId: 'pos1' });
    expect(r.ok).toBe(true);
    expect(_futMock.exitFuturesPosition).toHaveBeenCalledWith('pos1'); // positional, NOT {positionId: ...}
  });
  it('v20.7.10 reduce(): position resolve karke sahi pair/side/leverage (pehle {positionId,qty} → pair undefined + side default SHORT — SHORT reduce pe bhi SHORT-side order = position DOUBLE)', async () => {
    _futMock.listFuturesPositions.mockResolvedValueOnce([
      { id: 'pos9', pair: 'B-ETH_USDT', activePos: -2.0, avgPrice: 50, leverage: 3 },
    ]);
    _futMock.partialFuturesExit.mockResolvedValueOnce({ orderId: 'red-1', raw: {} });
    const port = new ApiFuturesPort({ futuresMod: _futMock });
    const r = await port.reduce({ positionId: 'pos9', qty: 1 });
    expect(r.ok).toBe(true);
    expect(_futMock.partialFuturesExit).toHaveBeenCalledWith({ pair: 'B-ETH_USDT', qty: 1, side: 'SHORT', leverage: 3 });
  });
  it('v20.7.10 reduce(): position exchange pe nahi mili → honest ok:false (already closed?)', async () => {
    _futMock.listFuturesPositions.mockResolvedValueOnce([]);
    const port = new ApiFuturesPort({ futuresMod: _futMock });
    const r = await port.reduce({ positionId: 'gone', qty: 1 });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/nahi mili|not found/i);
  });
  it('open() failure path returns { ok: false, error } — never throws', async () => {
    _futMock.createFuturesOrder.mockRejectedValueOnce(new Error('network down'));
    const port = new ApiFuturesPort({ futuresMod: _futMock });
    const r = await port.open({ pair: 'B-BTC_USDT', side: 'LONG', qty: 0.01, leverage: 5, type: 'market', price: 100, clientId: 'fail1' });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/network down/i);
  });
});

describe('v20.7 BrowserCdpPort — contract (Phase 6 hardening pending)', () => {
  it('health(): browser CONNECTED → ok:true (real browserStatus probe)', async () => {
    const ba = { cxEnsureTradePage: vi.fn(), cxSelectPair: vi.fn(), cxPlaceOrder: vi.fn(), cxClosePosition: vi.fn(), cxReadPositions: vi.fn(async () => []), browserStatus: vi.fn(() => ({ connected: true, tabs: {} })) };
    const port = new BrowserCdpPort({ browserAgent: ba });
    const h = await port.health();
    expect(h.ok).toBe(true);
    expect(h.mode).toBe('browser');
  });
  it('v20.7.7 health(): browser DOWN → ok:false + honest reason (pehle HAMESHA ok:true tha!)', async () => {
    const ba = { cxEnsureTradePage: vi.fn(), cxSelectPair: vi.fn(), cxPlaceOrder: vi.fn(), cxClosePosition: vi.fn(), cxReadPositions: vi.fn(async () => []), browserStatus: vi.fn(() => ({ connected: false, lastError: 'connect fail @127.0.0.1:9222' })) };
    const port = new BrowserCdpPort({ browserAgent: ba });
    const h = await port.health();
    expect(h.ok).toBe(false);
    expect(h.reasons?.[0]).toMatch(/connect fail/);
  });
  it('v20.7.7 health(): browserStatus absent → ok:false (honest degrade, jhotha ok:true nahi)', async () => {
    const ba = { cxEnsureTradePage: vi.fn(), cxSelectPair: vi.fn(), cxPlaceOrder: vi.fn(), cxClosePosition: vi.fn(), cxReadPositions: vi.fn(async () => []) };
    const port = new BrowserCdpPort({ browserAgent: ba });
    const h = await port.health();
    expect(h.ok).toBe(false);
  });
  it('setProtection() returns ok:false (Phase 6 pending — flatten-on-fail will trigger)', async () => {
    const ba = {};
    const port = new BrowserCdpPort({ browserAgent: ba });
    const r = await port.setProtection({ positionId: 'p1', sl: 95, tp: 110 });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/Phase 6 pending/i);
  });
  it('v20.7.7 close(): positional-arg signature + r?.ok verdict (object-arg TypeError + jhootha !!r fix)', async () => {
    const ba = {
      cxClosePosition: vi.fn(async (pair, side) => ({ ok: true, closed: String(pair).toUpperCase(), steps: ['row-found', 'exit-click'] })),
      browserStatus: vi.fn(() => ({ connected: true })),
    };
    const port = new BrowserCdpPort({ browserAgent: ba });
    const r = await port.close({ positionId: 'B-DOT_USDT' });
    expect(r.ok).toBe(true);
    expect(ba.cxClosePosition).toHaveBeenCalledWith('B-DOT_USDT', null); // positional + resolved side (empty positions → null)
  });
  it('v20.7.10 close(): positions table se SIDE resolve karke pass (hedge rows me galat-row close guard)', async () => {
    const ba = {
      cxClosePosition: vi.fn(async (pair: string, side: string) => ({ ok: true, closed: String(pair).toUpperCase(), side })),
      cxReadPositions: vi.fn(async () => ({ ok: true, positions: [
        { cells: ['B-DOT_USDT', 'SHORT', '31.74', '3.15'], text: 'B-DOT_USDT SHORT 31.74 3.15', nums: [31.74, 3.15] },
      ] })),
      browserStatus: vi.fn(() => ({ connected: true })),
    };
    const port = new BrowserCdpPort({ browserAgent: ba });
    const r = await port.close({ positionId: 'B-DOT_USDT' });
    expect(r.ok).toBe(true);
    expect(ba.cxClosePosition).toHaveBeenCalledWith('B-DOT_USDT', 'SHORT'); // side RESOLVED from row text
  });
  it('v20.7.7 close(): failed close ab ok:false (pehle truthy-object se hamesha ok:true tha — failed close bhi "closed" journal hota tha)', async () => {
    const ba = {
      cxClosePosition: vi.fn(async () => ({ ok: false, error: 'position row nahi mila' })),
      browserStatus: vi.fn(() => ({ connected: true })),
    };
    const port = new BrowserCdpPort({ browserAgent: ba });
    const r = await port.close({ positionId: 'B-DOT_USDT' });
    expect(r.ok).toBe(false);
  });
  it('v20.7.7 reduce(): full close + honest note (browser partial-exit unsupported)', async () => {
    const ba = {
      cxClosePosition: vi.fn(async () => ({ ok: true })),
      browserStatus: vi.fn(() => ({ connected: true })),
    };
    const port = new BrowserCdpPort({ browserAgent: ba });
    const r = await port.reduce({ positionId: 'B-DOT_USDT', qty: 5 });
    expect(r.ok).toBe(true);
    expect(String(r.note)).toMatch(/FULL close/);
  });
  it('v20.7.7 getPositions(): {cells,text,nums} rows se id/pair derive (pehle id hamesha "" tha → close-by-id fail)', async () => {
    const ba = {
      cxReadPositions: vi.fn(async () => ({ ok: true, positions: [
        { cells: ['B-DOT_USDT', 'LONG', '31.74', '3.15'], text: 'B-DOT_USDT LONG 31.74 3.15', nums: [31.74, 3.15] },
      ] })),
      browserStatus: vi.fn(() => ({ connected: true })),
    };
    const port = new BrowserCdpPort({ browserAgent: ba });
    const rows = await port.getPositions();
    expect(rows.length).toBe(1);
    expect(rows[0].pair).toBe('B-DOT_USDT');
    expect(rows[0].id).toBe('B-DOT_USDT');
    expect(rows[0].side).toBe('LONG');
  });
  it('v20.7.7 open(): qty pass-through — market order (price null) me direct qty driver tak jaati hai', async () => {
    const ba = {
      cxEnsureTradePage: vi.fn(async () => ({})),
      cxSelectPair: vi.fn(async () => ({ ok: true })),
      cxPairUrl: (pair, product) => `https://coindcx.com/futures/${pair}`,
      cxPlaceOrder: vi.fn(async (_page, opts) => ({ ok: true, steps: ['fallback:market-order', 'qty-set:direct'] })),
      browserStatus: vi.fn(() => ({ connected: true })),
    };
    const port = new BrowserCdpPort({ browserAgent: ba });
    const r = await port.open({ pair: 'B-DOT_USDT', side: 'LONG', qty: 31, leverage: 3, type: 'market', price: null, clientId: 'mk1' });
    expect(r.ok).toBe(true);
    const call = ba.cxPlaceOrder.mock.calls[0][1];
    expect(call.qty).toBe(31);       // direct qty
    expect(call.totalINR).toBe(0);   // price null → no bogus NaN/Infinity total
    expect(call.price).toBeNull();
  });
});
