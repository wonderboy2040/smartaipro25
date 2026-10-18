// ============================================================
// test/manualTradeSubHold.test.ts — v18.6.3 REALTIME NEVER STOPS (S2)
// ------------------------------------------------------------
// THE BUG: ltpForManualTrade() reads the liveFeed tick store, and the
// tick store only stays fresh while BROWSER SSE clients subscribe the
// symbols (streams are refcounted — zero clients → pollers park). The
// user's workflow (trade on the CoinDCX site in another browser tab →
// app tab hidden → SSE parks 30s later) drained the store, so with
// ZERO browser connections the monitor's 5s LTP sweep got null for
// every crypto trade — "trade open hai par realtime prices fetch
// nahi ho rahe" (frozen entry→live line, dead P&L).
//
// THE CONTRACT (locked here):
//   • open trades → the monitor HOLDS the upstream subscriptions
//     (crypto spot / India equities / CoinDCX perps) via the injected
//     ensureSubs + a service-level clientUp per stream
//   • trade added mid-flight → diff-ensure (only the NEW symbol)
//   • trade closed → diff-release of that symbol
//   • LAST open trade gone → everything released + clientDown (idle
//     streams park, zero upstream cost)
//   • monitor stopped while holding → releases everything
// Hermetic: liveFeed tick store + backup mocked, no network.
// ============================================================
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

process.env.SMARTAI_DATA_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '../.test-data-subhold');

// ---- controllable live tick store (ltpForManualTrade reads this) ----
const _ticks = vi.hoisted(() => new Map());
vi.mock('../server/liveFeed.js', () => ({
  getTick: (k) => _ticks.get(k) || null,
}));
// ---- no backup IO ----
vi.mock('../server/intraday/backup.js', () => ({
  scheduleBackup: vi.fn(),
  restoreBackup: vi.fn(async () => null),
  backupConfigured: vi.fn(() => false),
}));
// ---- no durable mirror IO ----
vi.mock('../server/mcp/durable.js', () => ({
  durablePut: vi.fn(async () => ({ ok: false })),
  decryptJSON: vi.fn(async () => null),
}));

const {
  startManualTradeMonitor, stopManualTradeMonitor,
  __setManualStateForTests, __resetManualStoreForTests,
  __monitorTickForTests, __tradeSubHoldForTests, tradeSubDiff,
} = await import('../server/ai/manualTrades.js');

const OPEN = (id, market, symbol, assetKind = null) => ({
  id, market, symbol, side: 'BUY', entryPrice: 100, qty: 1,
  status: 'OPEN', entryTime: Date.now() - 60_000, openedAt: Date.now() - 60_000,
  ...(assetKind ? { assetKind } : {}),
});

describe('tradeSubDiff — pure per-domain add/del diff', () => {
  it('new symbol → add; gone symbol → del; stable → no patch', () => {
    const patch = tradeSubDiff(
      { crypto: ['BTC'], india: [], fut: [], glob: [] },
      { crypto: ['BTC', 'ETH'], india: ['RELIANCE'], fut: ['SOL'], glob: [] },
    );
    expect(patch.crypto).toEqual({ add: ['ETH'], del: [] });
    expect(patch.india).toEqual({ add: ['RELIANCE'], del: [] });
    expect(patch.fut).toEqual({ add: ['SOL'], del: [] });
    expect(patch.glob).toBeUndefined();
  });

  it('closed symbol → del only', () => {
    const patch = tradeSubDiff(
      { crypto: ['BTC', 'ETH'], india: [], fut: [], glob: [] },
      { crypto: ['BTC'], india: [], fut: [], glob: [] },
    );
    expect(patch.crypto).toEqual({ add: [], del: ['ETH'] });
  });

  it('identical sets → empty patch (zero churn on every 5s tick)', () => {
    const patch = tradeSubDiff(
      { crypto: ['BTC'], india: ['RELIANCE'], fut: [], glob: [] },
      { crypto: ['BTC'], india: ['RELIANCE'], fut: [], glob: [] },
    );
    expect(Object.keys(patch)).toEqual([]);
  });

  it('null/empty inputs are safe', () => {
    expect(Object.keys(tradeSubDiff(null, null))).toEqual([]);
    // want={} → everything previously held is a DEL patch
    expect(tradeSubDiff({ crypto: ['BTC'] }, {})).toEqual({ crypto: { add: [], del: ['BTC'] } });
  });
});

describe('monitor subscription hold — realtime prices with ZERO browser SSE clients', () => {
  let ensureSubs, releaseSubs, clientUp, clientDown;

  beforeEach(() => {
    __resetManualStoreForTests();
    stopManualTradeMonitor();
    ensureSubs = vi.fn();
    releaseSubs = vi.fn();
    clientUp = vi.fn();
    clientDown = vi.fn();
    _ticks.clear();
  });

  const boot = () => startManualTradeMonitor({
    ensureSubs, releaseSubs, clientUp, clientDown,
    send: async () => ({ ok: true }),
  });

  it('open crypto trade → holds the spot subscription + clientUp (pollers RUN)', async () => {
    __setManualStateForTests([OPEN(1, 'CRYPTO', 'BTC')]);
    boot();
    await __monitorTickForTests();
    expect(ensureSubs).toHaveBeenCalledWith({ crypto: ['BTC'] });
    expect(clientUp).toHaveBeenCalledWith('crypto');
    // idle tick again → NO extra ensure (refcount stable, zero churn)
    ensureSubs.mockClear();
    await __monitorTickForTests();
    expect(ensureSubs).not.toHaveBeenCalled();
    expect(__tradeSubHoldForTests().crypto.has('BTC')).toBe(true);
  });

  it('all four domains route to their own streams', async () => {
    __setManualStateForTests([
      OPEN(1, 'CRYPTO', 'BTC'),
      OPEN(2, 'INDIA', 'RELIANCE'),
      OPEN(3, 'FUTURES', 'SOL'),
      OPEN(4, 'GLOBALFUTURES', 'AAPL'),
      // OPTION trades re-price via Black-Scholes — no stream sub needed
      OPEN(5, 'INDIA', 'NIFTY', 'OPTION'),
    ]);
    boot();
    await __monitorTickForTests();
    expect(ensureSubs).toHaveBeenCalledWith({ crypto: ['BTC'] });
    expect(ensureSubs).toHaveBeenCalledWith({ india: ['RELIANCE'] });
    // fut + glob ride the SAME combined call (the cxRtStream contract)
    expect(ensureSubs).toHaveBeenCalledWith({ fut: ['SOL'], glob: ['AAPL'] });
    expect(clientUp).toHaveBeenCalledWith('crypto');
    expect(clientUp).toHaveBeenCalledWith('india');
    expect(clientUp).toHaveBeenCalledWith('cxrt');
  });

  it('new trade mid-flight → ONLY the new symbol ensured (diff, no re-ensure)', async () => {
    __setManualStateForTests([OPEN(1, 'CRYPTO', 'BTC')]);
    boot();
    await __monitorTickForTests();
    ensureSubs.mockClear();
    __setManualStateForTests([OPEN(1, 'CRYPTO', 'BTC'), OPEN(2, 'CRYPTO', 'ETH')]);
    await __monitorTickForTests();
    expect(ensureSubs).toHaveBeenCalledTimes(1);
    expect(ensureSubs).toHaveBeenCalledWith({ crypto: ['ETH'] });
  });

  it('trade closed → its symbol released exactly once; others keep running', async () => {
    __setManualStateForTests([OPEN(1, 'CRYPTO', 'BTC'), OPEN(2, 'CRYPTO', 'ETH')]);
    boot();
    await __monitorTickForTests();
    __setManualStateForTests([OPEN(1, 'CRYPTO', 'BTC')]); // ETH closed
    await __monitorTickForTests();
    expect(releaseSubs).toHaveBeenCalledWith({ crypto: ['ETH'] });
    // BTC still held — the stream must NOT park while a trade is open
    expect(__tradeSubHoldForTests()).not.toBeNull();
    expect(__tradeSubHoldForTests().crypto.has('BTC')).toBe(true);
    expect(clientDown).not.toHaveBeenCalledWith('crypto');
  });

  it('LAST trade gone → everything released + clientDown (streams park, zero cost)', async () => {
    __setManualStateForTests([OPEN(1, 'CRYPTO', 'BTC'), OPEN(2, 'INDIA', 'RELIANCE')]);
    boot();
    await __monitorTickForTests();
    expect(clientUp).toHaveBeenCalledWith('crypto');
    expect(clientUp).toHaveBeenCalledWith('india');
    // both closed → the NEXT tick (even the idle one) releases
    __setManualStateForTests([]);
    await __monitorTickForTests();
    expect(releaseSubs).toHaveBeenCalledWith({ crypto: ['BTC'] });
    expect(releaseSubs).toHaveBeenCalledWith({ india: ['RELIANCE'] });
    expect(clientDown).toHaveBeenCalledWith('crypto');
    expect(clientDown).toHaveBeenCalledWith('india');
    expect(__tradeSubHoldForTests()).toBeNull();
  });

  it('monitor STOPPED while holding → releases everything (no hot pollers after stop)', async () => {
    __setManualStateForTests([OPEN(1, 'FUTURES', 'SOL')]);
    boot();
    await __monitorTickForTests();
    expect(clientUp).toHaveBeenCalledWith('cxrt');
    releaseSubs.mockClear();
    stopManualTradeMonitor();
    expect(releaseSubs).toHaveBeenCalledWith({ fut: ['SOL'], glob: [] });
    expect(clientDown).toHaveBeenCalledWith('cxrt');
    expect(__tradeSubHoldForTests()).toBeNull();
  });

  it('no deps injected (old wiring / tests) → the LTP sweep still runs, no crash', async () => {
    __setManualStateForTests([OPEN(1, 'CRYPTO', 'BTC')]);
    _ticks.set('IN_BTC', { price: 101, time: Date.now() });
    startManualTradeMonitor({ send: async () => ({ ok: true }) });
    await expect(__monitorTickForTests()).resolves.toBeUndefined();
    expect(ensureSubs).not.toHaveBeenCalled();
  });
});
