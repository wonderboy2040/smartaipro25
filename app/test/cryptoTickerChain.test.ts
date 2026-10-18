// ============================================================
// test/cryptoTickerChain.test.ts — v11.3 THE PERMANENT FIX
// ------------------------------------------------------------
// Production incident (2026-09-17, smartai1.onrender.com):
//   [corr=…] 502 Failed to fetch crypto prices. The operation was
//   aborted due to timeout
// Root cause: /api/crypto-prices → fetchCoinDcxTickers() had ONE leg
// (api.coindcx.com/exchange/ticker REST) behind Cloudflare — from
// Render datacenter IPs it times out, and after the 30s stale window
// every consumer 502'd.
//
// THE CHAIN (locked here, top to bottom):
//   1. REST ticker                      → source 'coindcx-rest'
//   2. 30s stale-serve                  → 'coindcx-rest-stale'
//   3. OFFICIAL spot-WS book (cxSpotWs) → 'coindcx-spot-ws'
//   4. Binance/Bybit USDT × live fx     → 'binance-fx-synth'
//   5. 3-min deep-stale serve           → 'coindcx-rest-deep-stale'
//   6. throw (honest 502 — everything really is dead)
// Plus: the SSE poller re-anchors INR ticks from the spot-WS book when
// the chain is dry, keeping IN_<BASE> live + the Binance projection
// ratio honest.
// Hermetic: fetch + WS are injected doubles.
// ============================================================
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';

const priceFrame = (prices: Record<string, number>) =>
  `42["currentPrices@spot#update",${JSON.stringify({ event: 'currentPrices@spot#update', data: JSON.stringify({ pr: 'SPOT', prices }) })}]`;
const statsFrame = (stats: Record<string, { pc: number; v: number }>) =>
  `42["priceStats@spot#update",${JSON.stringify({ event: 'priceStats@spot#update', data: JSON.stringify({ pr: 'SPOT', stats }) })}]`;

/** 30-market book so the WS is SERVABLE (≥25 fresh markets). */
const BIG_BOOK: Record<string, number> = { BTCINR: 6_123_456.5, ETHINR: 150_987.25 };
for (let i = 0; i < 28; i++) BIG_BOOK[`C${i}INR`] = 100 + i;

describe('cryptoStream — v11.3 fetchCoinDcxTickers resilience chain', () => {
  let crypto: typeof import('../server/cryptoStream.js');
  let spot: typeof import('../server/ai/cxSpotWs.js');
  let getTick: typeof import('../server/liveFeed.js').getTick;
  let sockets: any[];

  const restDead = () => ({ ok: false, status: 403, json: async () => ({}) });

  /** Binance 24h ticker response shape for the synth leg. */
  const binanceBook = () => ([
    { symbol: 'BTCUSDT', lastPrice: '72993.5', priceChangePercent: '1.1', highPrice: '73500', lowPrice: '72200', volume: '21000.5' },
    { symbol: 'ETHUSDT', lastPrice: '1800.25', priceChangePercent: '-0.4', highPrice: '1830', lowPrice: '1780', volume: '15000.2' },
  ]);
  const yahooFx = (rate: number) => ({
    ok: true, status: 200,
    json: async () => ({ chart: { result: [{ meta: { regularMarketPrice: rate } }] } }),
  });

  function armSpotWs() {
    spot._setSpotWsEnabledForTest(true);
    spot._setSpotWsFactoryForTest((url: string) => {
      const ws: any = new EventEmitter();
      Object.assign(ws, {
        readyState: 0,
        url,
        sent: [] as string[],
        closed: false,
        on: (ev: string, fn: (arg?: unknown) => void) => ws.addListener(ev, fn),
        removeAllListeners: () => ws.removeAllListeners(),
        send: (frame: string) => {
          ws.sent.push(frame);
          if (frame === '40') ws.emit('message', '40{"sid":"s"}');
        },
        close: () => { ws.closed = true; ws.emit('close'); },
        terminate: () => { ws.closed = true; ws.emit('close'); },
        serverMessage: (frame: string) => ws.emit('message', frame),
      });
      setTimeout(() => { ws.readyState = 1; ws.emit('open'); ws.emit('message', '0{"sid":"srv","pingInterval":45000,"pingTimeout":60000}'); }, 0);
      sockets.push(ws);
      return ws;
    });
  }

  beforeEach(async () => {
    vi.resetModules();
    sockets = [];
    spot = await import('../server/ai/cxSpotWs.js');
    spot._resetSpotWsForTest();
    crypto = await import('../server/cryptoStream.js');
    crypto._resetCryptoStreamForTest();
    getTick = (await import('../server/liveFeed.js')).getTick;
    // Binance WS accelerator: a quiet, never-opening socket (not this suite's subject)
    crypto._setBinanceWsFactoryForTest(() => {
      const ws = new EventEmitter();
      Object.assign(ws, { readyState: 0, close: () => {}, terminate: () => {}, removeAllListeners: () => ws.removeAllListeners() });
      return ws as any;
    });
  });
  afterEach(() => {
    crypto?._setBinanceWsFactoryForTest(null);
    crypto?._setCryptoFetchForTest(null);
    crypto?._resetCryptoStreamForTest();
    spot?._setSpotWsFactoryForTest(null);
    spot?._resetSpotWsForTest();
  });

  it('leg 1 — REST healthy serves the real ticker array (source coindcx-rest)', async () => {
    crypto._setCryptoFetchForTest(async () => ({
      ok: true, json: async () => [{ market: 'BTCINR', last_price: '4350000', change_24_hour: '1.25', volume: '77' }],
    }));
    const t = await crypto.fetchCoinDcxTickers();
    expect(Array.isArray(t)).toBe(true);
    expect(t[0].market).toBe('BTCINR');
    expect(crypto.lastTickerSource()).toBe('coindcx-rest');
  });

  it('leg 3 — REST dead + spot-WS book servable → the OFFICIAL WS array serves (source coindcx-spot-ws)', async () => {
    crypto._setCryptoFetchForTest(async () => restDead());
    armSpotWs();
    // first call arms the WS (demand) — REST fails this round (no book yet,
    // Binance dead, no cache) → throws honestly
    await expect(crypto.fetchCoinDcxTickers()).rejects.toThrow();
    // the socket connects; push the book
    await vi.waitFor(() => expect(sockets.length).toBe(1));
    const sock = sockets[0];
    await vi.waitFor(() => expect(sock.sent.filter((f: string) => f.startsWith('42["join"'))).toHaveLength(2));
    sock.serverMessage(priceFrame(BIG_BOOK));
    sock.serverMessage(statsFrame({ BTCINR: { pc: 1.25, v: 77.5 } }));
    // second call: REST dead → the WS book serves
    const t = await crypto.fetchCoinDcxTickers();
    const btc = (t as any[]).find(x => x.market === 'BTCINR')!;
    expect(btc.last_price).toBe('6123456.5');
    expect(btc.change_24_hour).toBe('1.25');
    expect(btc.feed).toBe('coindcx-spot-ws');
    expect(crypto.lastTickerSource()).toBe('coindcx-spot-ws');
  });

  it('leg 4 — REST dead + WS thin + Binance reachable → fx-anchored synth rows (source binance-fx-synth)', async () => {
    crypto._setCryptoFetchForTest(async (url: string) => {
      if (String(url).includes('query1.finance.yahoo.com')) return yahooFx(85.5);
      if (String(url).includes('api.binance.com')) return { ok: true, json: async () => binanceBook() };
      return restDead(); // api.coindcx.com + mirrors + bybit all dark
    });
    // no spot WS armed (thin book — nothing to serve)
    const t = await crypto.fetchCoinDcxTickers();
    const btc = (t as any[]).find(x => x.market === 'BTCINR')!;
    expect(parseFloat(btc.last_price)).toBeCloseTo(72_993.5 * 85.5, 6); // USDT × live fx
    expect(btc.change_24_hour).toBe('1.1');
    expect(btc.__synthetic).toBe('binance-fx'); // honest marker
    expect(crypto.lastTickerSource()).toBe('binance-fx-synth');
  });

  it('leg 5 — everything dead + <3-min-old REST cache → deep-stale serve beats a dead board', async () => {
    // step 1: REST works once → cache populated
    let restOk = true;
    crypto._setCryptoFetchForTest(async () => restOk
      ? { ok: true, json: async () => [{ market: 'BTCINR', last_price: '4350000', change_24_hour: '1.25', volume: '77' }] }
      : restDead());
    await crypto.fetchCoinDcxTickers();
    // step 2: everything goes dark (incl. Binance + Yahoo)
    crypto._setCryptoFetchForTest(async () => restDead());
    // 30s+ stale window passes (fake clock) → NOT the shallow stale leg,
    // must fall through to the DEEP-stale leg
    vi.useFakeTimers();
    await vi.advanceTimersByTimeAsync(45_000);
    try {
      const t = await crypto.fetchCoinDcxTickers();
      expect((t as any[])[0].market).toBe('BTCINR');
      expect((t as any[])[0].last_price).toBe('4350000');
      expect(crypto.lastTickerSource()).toBe('coindcx-rest-deep-stale');
    } finally {
      vi.useRealTimers();
    }
  });

  it('leg 6 — truly everything dead → the honest throw (a 502 the route can name)', async () => {
    crypto._setCryptoFetchForTest(async () => restDead());
    await expect(crypto.fetchCoinDcxTickers()).rejects.toThrow();
  });

  it('SSE poller — REST dead + WS book servable → INR ticks land with the honest coindcx-spot-ws source', async () => {
    crypto._setCryptoFetchForTest(async () => restDead());
    armSpotWs();
    crypto.ensureCryptoSubscribed(['BTC']);
    crypto.cryptoClientUp();
    await vi.waitFor(() => expect(sockets.length).toBe(1));
    const sock = sockets[0];
    await vi.waitFor(() => expect(sock.sent.filter((f: string) => f.startsWith('42["join"'))).toHaveLength(2));
    sock.serverMessage(priceFrame(BIG_BOOK));
    // the next 2s poll beat: fetchCoinDcxTickers serves via the WS leg → tick lands
    await vi.waitFor(() => {
      const t = getTick('IN_BTC');
      expect(t).toBeTruthy();
      expect(t!.source).toBe('coindcx-spot-ws');
      expect(t!.price).toBe(6_123_456.5);
    }, { timeout: 6_000 });
    crypto.cryptoClientDown();
  });

  it('SSE poller — chain fully dry + a fresh partial WS row → the anchor STILL lands (partial-book rescue)', async () => {
    crypto._setCryptoFetchForTest(async () => restDead());
    armSpotWs();
    crypto.ensureCryptoSubscribed(['BTC']);
    crypto.cryptoClientUp();
    await vi.waitFor(() => expect(sockets.length).toBe(1));
    const sock = sockets[0];
    await vi.waitFor(() => expect(sock.sent.filter((f: string) => f.startsWith('42["join"'))).toHaveLength(2));
    // ONE market only — servable=false (<25), so the chain throws, but
    // the per-symbol anchor rescue keeps IN_BTC alive
    sock.serverMessage(priceFrame({ BTCINR: 6_200_000 }));
    await vi.waitFor(() => {
      const t = getTick('IN_BTC');
      expect(t).toBeTruthy();
      expect(t!.source).toBe('coindcx-spot-ws');
      expect(t!.price).toBe(6_200_000);
    }, { timeout: 6_000 });
    crypto.cryptoClientDown();
  });
});
