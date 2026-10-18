// ============================================================
// test/cxRtStream.test.ts — v10.10 + v10.11 COINDCX DIRECT RT
// ------------------------------------------------------------
// THE BUG (user report): "SPOT, Global Futures & Equity SIM USDC —
// ye tino section me realtime prices fetch nahi ho rahe, isliye
// wrong call or signal show ho rahe hai."
//
// THE CONTRACT (locked here):
//   • /api/stream?…&fut=BTC,ETH subscribes FUT_<BASE> keys — the 2s
//     DIRECT CoinDCX USDT-perp poll (public.coindcx.com RT feed)
//     writes ticks into liveFeed with source 'coindcx-fut-rt'.
//   • /api/stream?…&glob=AAPL,SPACEX subscribes GLOB_<SYM> keys —
//     the CoinDCX USDC equity-perp RT wins first (source
//     'coindcx-glob-rt'); names the RT feed doesn't carry fall back
//     to FINNHUB first (source 'finnhub-global-rt'), then Yahoo
//     (source 'yahoo-global-rt') at the 10s fallback cadence; SIM
//     names (SPACEX — no public price BY DESIGN) tick from the
//     deterministic synthetic walk (source 'global-sim-rt').
//   • v10.11 WEBSOCKET ACCELERATOR — the documented futures socket
//     (wss://stream.coindcx.com, Socket.IO v2 / EIO=3, channels
//     "B-<PAIR>@prices-futures", event "price-change") lands ticks
//     EVENT-DRIVEN (source 'coindcx-fut-ws' / 'coindcx-glob-ws');
//     the REST poller is the degrade path + illiquidity floor:
//     healthy WS (a tick landed < 30s ago) → REST @ 10s floor;
//     WS down / unproven / silent → REST @ 2s (zero regression).
//   • refcounted subscriptions + idle-stop: no client → no timer;
//     release → graceful eviction after 90s.
//   • the futures RT fetch is single-flight (board compute + stream
//     share ONE upstream round-trip).
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
  ensureCxRtSubscribed, releaseCxRtSubscribed, cxRtClientUp, cxRtClientDown,
  cxRtWsStatus,
  _resetCxRtForTest, _cxRtStateForTest, _pollOnceForTest,
  _setDcxWsEnabledForTest, _setDcxWsFactoryForTest, _setCxRtNowForTest, _setUsPremarketForTest,
  _setBinanceFutWsFactoryForTest,
} from '../server/ai/cxRtStream.js';
import { fetchFuturesPrices } from '../server/ai/futures.js';
import { __resetFuturesForTests } from '../server/ai/futures.js';
import { __resetGlobalForTests, syntheticPriceAt } from '../server/ai/globalFutures.js';
import { __resetFinnhubForTests } from '../server/ai/finnhubQuote.js';
import { getTick } from '../server/liveFeed.js';

const origFetch = globalThis.fetch;
const ORIG_FH_KEY = process.env.FINNHUB_API_KEY;

// ---------------- payloads ----------------
const futRow = (ls, pc = 1.5) => ({ ls, mp: ls * 0.9999, pc, h: ls * 1.01, l: ls * 0.99, v: 12_345 });
const FUT_USDT_PAYLOAD = {
  ts: Date.now(),
  prices: {
    'B-BTC_USDT': futRow(50_000, 2.5),
    'B-ETH_USDT': futRow(3_000, -1.2),
    'B-SOL_USDT': futRow(148.55, 4.1),
  },
};
const globRow = (ls, pc = 0.4) => ({ ls, mp: ls * 0.9999, pc, h: ls * 1.01, l: ls * 0.99, v: 987_654 });
const GLOB_USDC_PAYLOAD = {
  ts: Date.now(),
  prices: {
    'B-AAPL_USDC': globRow(333.62),
    'B-TSLA_USDC': globRow(412.05),
    'B-NVDA_USDC': globRow(196.4),
    'B-MSFT_USDC': globRow(498.11),
  },
};
const yahooChart = (price, prev) => ({
  chart: { result: [{ meta: { regularMarketPrice: price, chartPreviousClose: prev } }] },
});

// ---------------- fetch routing ----------------
// Both desks share https://public.coindcx.com/market_data/v3/current_prices/futures/rt —
// the GLOBAL probe carries a margin_currency param, the USDT perp feed doesn't.
function routeFetch(handler: (url: string) => { ok: boolean; status: number; json: () => Promise<unknown> } | null) {
  globalThis.fetch = vi.fn(async (url: any) => {
    const r = handler(String(url));
    if (!r) return { ok: true, status: 200, json: async () => ({}), text: async () => '{}' };
    return { ...r, text: async () => JSON.stringify({}) };
  }) as any;
}

const settle = () => new Promise(r => setTimeout(r, 30));

beforeEach(() => {
  _resetCxRtForTest();
  __resetFuturesForTests();
  __resetGlobalForTests();
  __resetFinnhubForTests();
  process.env.FINNHUB_API_KEY = '';
});

afterEach(() => {
  _resetCxRtForTest();
  __resetFinnhubForTests();
  process.env.FINNHUB_API_KEY = ORIG_FH_KEY;
  globalThis.fetch = origFetch;
});

describe('cxRtStream — USDT perp domain (FUT_ keys, 2s direct CoinDCX)', () => {
  it('subscribes, polls immediately and writes liveFeed ticks for the subscribed bases', async () => {
    routeFetch(url => {
      if (url.includes('current_prices/futures/rt') && !url.includes('margin_currency')) {
        return { ok: true, status: 200, json: async () => FUT_USDT_PAYLOAD };
      }
      return null;
    });
    ensureCxRtSubscribed({ fut: ['BTC', 'ETH'] });
    cxRtClientUp(); // ← fires the first poll instantly
    await vi.waitFor(() => expect(getTick('FUT_BTC')).toBeTruthy());

    const btc = getTick('FUT_BTC')!;
    expect(btc.price).toBeCloseTo(50_000, 6);
    expect(btc.source).toBe('coindcx-fut-rt');
    expect(btc.change).toBeCloseTo(2.5, 6);
    expect(btc.high).toBeGreaterThan(btc.price);
    expect(btc.low).toBeLessThan(btc.price);
    // 24h prevClose derived from changePct: price / (1 + pc/100)
    expect(btc.prevClose).toBeCloseTo(50_000 / 1.025, 4);

    const eth = getTick('FUT_ETH')!;
    expect(eth.price).toBeCloseTo(3_000, 6);
    expect(eth.source).toBe('coindcx-fut-rt');

    // NOT subscribed → no tick (the refcounted set is the contract)
    expect(getTick('FUT_SOL')).toBeNull();

    cxRtClientDown();
    expect(_cxRtStateForTest().timer).toBe(false); // idle-stop: no client → no timer
  });

  it('is single-flight: two concurrent fetchFuturesPrices calls share ONE upstream round-trip', async () => {
    let hits = 0;
    routeFetch(url => {
      if (url.includes('current_prices/futures/rt') && !url.includes('margin_currency')) {
        hits++;
        return { ok: true, status: 200, json: async () => FUT_USDT_PAYLOAD };
      }
      return null;
    });
    const [a, b] = await Promise.all([
      fetchFuturesPrices({ maxAgeMs: 0 }),
      fetchFuturesPrices({ maxAgeMs: 0 }),
    ]);
    expect(a).toBe(b); // same cached rows object
    expect(hits).toBe(1); // ONE upstream call for both consumers
  });

  it('falls back to Binance USDT perps (honest label) when CoinDCX RT goes dark', async () => {
    routeFetch(url => {
      if (url.includes('current_prices/futures/rt') && !url.includes('margin_currency')) {
        return { ok: false, status: 403, json: async () => ({}) }; // WAF block
      }
      if (url.includes('fapi.binance.com')) {
        // v21.13.x (P2): the REAL fapi ?symbol= contract — a single
        // ticker OBJECT per request (fapi ignores ?symbols= arrays)
        const sym = /symbol=([A-Z0-9]+)/.exec(url)?.[1] || '';
        const row = sym === 'BTCUSDT'
          ? { symbol: 'BTCUSDT', lastPrice: '61000.5', priceChangePercent: '1.1', highPrice: '61500', lowPrice: '60200', volume: '21000.5' }
          : { symbol: 'ETHUSDT', lastPrice: '3120.75', priceChangePercent: '-0.4', highPrice: '3150', lowPrice: '3080', volume: '15000.2' };
        return {
          ok: true, status: 200,
          json: async () => (sym ? row : [row]), // no-sig full-book caller keeps the array shape
        };
      }
      return null;
    });
    ensureCxRtSubscribed({ fut: ['BTC', 'ETH'] });
    cxRtClientUp();
    // NOTE: wait on the SOURCE, not just presence — liveFeed has no reset
    // hook, so FUT_BTC may still hold test-1's 'coindcx-fut-rt' tick when
    // this test starts. The Binance tick must actually LAND and overwrite.
    await vi.waitFor(() => expect(getTick('FUT_BTC')?.source).toBe('binance-fut-rt'));

    const btc = getTick('FUT_BTC')!;
    expect(btc.source).toBe('binance-fut-rt'); // honest label — NOT pretending to be CoinDCX
    expect(btc.price).toBeCloseTo(61_000.5, 6);
    expect(getTick('FUT_ETH')?.source).toBe('binance-fut-rt');
    cxRtClientDown();
  });
});

describe('cxRtStream — USDC global equity domain (GLOB_ keys)', () => {
  it('prices listed names from the DIRECT CoinDCX USDC RT feed', async () => {
    routeFetch(url => {
      if (url.includes('current_prices/futures/rt') && url.includes('margin_currency')) {
        return { ok: true, status: 200, json: async () => GLOB_USDC_PAYLOAD };
      }
      if (url.includes('query1.finance.yahoo.com')) {
        return { ok: true, status: 200, json: async () => yahooChart(200, 198) };
      }
      if (url.includes('current_prices/futures/rt')) {
        return { ok: true, status: 200, json: async () => FUT_USDT_PAYLOAD };
      }
      return null;
    });
    ensureCxRtSubscribed({ glob: ['AAPL'] });
    cxRtClientUp();
    await vi.waitFor(() => expect(getTick('GLOB_AAPL')).toBeTruthy());

    const aapl = getTick('GLOB_AAPL')!;
    expect(aapl.price).toBeCloseTo(333.62, 6);
    expect(aapl.source).toBe('coindcx-glob-rt');
    cxRtClientDown();
  });

  it('ticks SIM names (SPACEX) from the deterministic synthetic walk — never frozen, honestly labeled', async () => {
    routeFetch(url => {
      if (url.includes('current_prices/futures/rt') && url.includes('margin_currency')) {
        return { ok: true, status: 200, json: async () => GLOB_USDC_PAYLOAD };
      }
      if (url.includes('query1.finance.yahoo.com')) {
        return { ok: true, status: 200, json: async () => yahooChart(200, 198) };
      }
      if (url.includes('current_prices/futures/rt')) {
        return { ok: true, status: 200, json: async () => FUT_USDT_PAYLOAD };
      }
      return null;
    });
    ensureCxRtSubscribed({ glob: ['SPACEX'] });
    cxRtClientUp();
    await vi.waitFor(() => expect(getTick('GLOB_SPACEX')).toBeTruthy());

    const spx = getTick('GLOB_SPACEX')!;
    expect(spx.source).toBe('global-sim-rt');
    expect(spx.price).toBeGreaterThan(0);
    // the tick IS the synthetic walk at poll time (deterministic contract)
    expect(spx.price).toBeCloseTo(syntheticPriceAt('SPACEX', spx.time), 6);
    cxRtClientDown();
  });
});

describe('cxRtStream — lifecycle hygiene', () => {
  it('no client → subscribe does NOT start the poller', () => {
    routeFetch(() => null);
    ensureCxRtSubscribed({ fut: ['BTC'], glob: ['AAPL'] });
    expect(_cxRtStateForTest().timer).toBe(false);
    expect(_cxRtStateForTest().activeClients).toBe(0);
  });

  it('release → graceful eviction after the 90s grace window', async () => {
    vi.useFakeTimers();
    try {
      routeFetch(() => null);
      ensureCxRtSubscribed({ fut: ['BTC'] });
      releaseCxRtSubscribed({ fut: ['BTC'] });
      expect(_cxRtStateForTest().fut).toContain('BTC'); // still inside the grace window
      vi.advanceTimersByTime(91_000);
      expect(_cxRtStateForTest().fut).not.toContain('BTC'); // evicted
    } finally {
      vi.useRealTimers();
    }
  });

  it('refcount: two subscribers, one release keeps the symbol alive', () => {
    routeFetch(() => null);
    ensureCxRtSubscribed({ fut: ['BTC'] });
    ensureCxRtSubscribed({ fut: ['BTC'] });
    releaseCxRtSubscribed({ fut: ['BTC'] });
    expect(_cxRtStateForTest().fut).toContain('BTC');
    releaseCxRtSubscribed({ fut: ['BTC'] });
    expect(_cxRtStateForTest().fut).toContain('BTC'); // still within grace — NOT evicted yet
  });
});

// ============================================================
// v10.11 (#1) — the Finnhub fallback label: RT dark + Finnhub up
// → the GLOB tick says finnhub-global-rt (the frontend badge's
// exact source string).
// ============================================================
describe('cxRtStream — FINNHUB fallback labels (GLOB_ keys)', () => {
  it('RT dark + Finnhub serves → tick source finnhub-global-rt', async () => {
    process.env.FINNHUB_API_KEY = 'test-key-123';
    routeFetch(url => {
      if (url.includes('current_prices/futures/rt')) {
        return { ok: false, status: 403, json: async () => ({}) }; // RT dark
      }
      if (url.includes('finnhub.io/api/v1/quote')) {
        return {
          ok: true, status: 200,
          json: async () => ({ c: 334.1, d: 2.5, dp: 0.75, h: 336, l: 332, pc: 331.6, t: Math.floor(Date.now() / 1000) }),
        };
      }
      if (url.includes('query1.finance.yahoo.com')) {
        return { ok: true, status: 200, json: async () => yahooChart(111.11, 110) };
      }
      return null;
    });
    ensureCxRtSubscribed({ glob: ['AAPL'] });
    cxRtClientUp();
    // liveFeed has no reset hook — wait on the SOURCE, not presence (the
    // earlier RT test may have left a coindcx-glob-rt tick on this key).
    await vi.waitFor(() => expect(getTick('GLOB_AAPL')?.source).toBe('finnhub-global-rt'));
    const aapl = getTick('GLOB_AAPL')!;
    expect(aapl.price).toBeCloseTo(334.1, 6);
    cxRtClientDown();
  });

  it('RT dark + Finnhub down too → the Yahoo label stays yahoo-global-rt (final fallback)', async () => {
    process.env.FINNHUB_API_KEY = 'test-key-123';
    routeFetch(url => {
      if (url.includes('current_prices/futures/rt')) {
        return { ok: false, status: 403, json: async () => ({}) };
      }
      if (url.includes('finnhub.io/api/v1/quote')) {
        return { ok: false, status: 429, json: async () => ({}) }; // rate-limited
      }
      if (url.includes('query1.finance.yahoo.com')) {
        return { ok: true, status: 200, json: async () => yahooChart(227.5, 225) };
      }
      return null;
    });
    ensureCxRtSubscribed({ glob: ['AAPL'] });
    cxRtClientUp();
    await vi.waitFor(() => expect(getTick('GLOB_AAPL')?.price).toBeCloseTo(227.5, 6));
    expect(getTick('GLOB_AAPL')!.source).toBe('yahoo-global-rt');
    cxRtClientDown();
  });
});

// ============================================================
// v10.11 (#5) — THE WEBSOCKET ACCELERATOR (Socket.IO v2 / EIO=3)
//   • a price-change event lands in liveFeed IMMEDIATELY (no 2s wait)
//   • the health proof: REST slows to the 10s floor ONLY after a
//     tick actually lands (a silent socket can never slow REST)
//   • WS drop → REST back to 2s instantly + reconnect scheduled
//   • late WS frames never regress a newer tick (out-of-order guard)
//   • unattributable events never count as health
//   • book-style full updates fan out per subscribed symbol
//   • ns-connected but silent for 2 min → watchdog kills it (docs'
//     payload shape is best-effort; a mismatch can never freeze prices)
// ============================================================

/** A faithful Socket.IO-v2 server double: speaks the EIO=3 text frames
 *  the real wss://stream.coindcx.com speaks ('40' ns-ack on '40',
 *  '2' ping → expects '3', '42[…]' events). */
class FakeDcxWs {
  readyState = 1; // WebSocket.OPEN
  url: string;
  sent: string[] = [];
  closed = false;
  private listeners = new Map<string, Array<(arg?: unknown) => void>>();
  constructor(url: string) {
    this.url = url;
    // the real socket fires 'open' after the TCP+TLS+EIO handshake — next
    // macrotask — and the server's first frame IS the Engine.IO '0' open
    setTimeout(() => {
      if (!this.closed) {
        this._emit('open');
        this._emit('message', '0{"sid":"srv","pingInterval":25000,"pingTimeout":60000}');
      }
    }, 0);
  }
  on(ev: string, fn: (arg?: unknown) => void) {
    if (!this.listeners.has(ev)) this.listeners.set(ev, []);
    this.listeners.get(ev)!.push(fn);
  }
  removeAllListeners() { this.listeners.clear(); }
  send(frame: string) {
    if (this.closed) return;
    this.sent.push(frame);
    if (frame === '40') this._emit('message', '40{"sid":"test-sid"}'); // server ns-ack
  }
  close() { if (!this.closed) { this.closed = true; this._emit('close'); } }
  terminate() { this.close(); }
  private _emit(ev: string, arg?: unknown) {
    for (const fn of [...(this.listeners.get(ev) || [])]) fn(arg);
  }
  // ---- server-side pushes (test controls) ----
  serverMessage(frame: string) { if (!this.closed) this._emit('message', frame); }
  drop() { this.readyState = 3; this.close(); } // remote-side drop
}

const pcFrame = (channel: string, data: Record<string, unknown>) =>
  `42["price-change",${JSON.stringify({ channelName: channel, data })}]`;

describe('cxRtStream — WEBSOCKET accelerator (CoinDCX futures socket)', () => {
  function armWs(sockets: FakeDcxWs[]) {
    _setDcxWsEnabledForTest(true);
    _setDcxWsFactoryForTest((url: string) => {
      const s = new FakeDcxWs(url);
      sockets.push(s);
      return s;
    });
  }

  it('a price-change event lands in liveFeed IMMEDIATELY — event-driven, no 2s REST wait', async () => {
    // EVERYTHING REST is dark — only the WS can serve this test
    routeFetch(url => ({ ok: false, status: 403, json: async () => ({}) }));
    const sockets: FakeDcxWs[] = [];
    armWs(sockets);
    ensureCxRtSubscribed({ fut: ['BTC'] });
    cxRtClientUp();
    await vi.waitFor(() => expect(sockets.length).toBe(1));
    const sock = sockets[0];
    // EIO=4 handshake: '40' ns-connect → '40{sid}' ack → join frames
    // v11.3: ONE book channel (currentPrices@futures@rt) replaces the
    // per-pair FUT joins — attributable pair keys in every book row.
    await vi.waitFor(() => expect(sock.sent.filter(f => f.startsWith('42["join"'))).toHaveLength(1));
    expect(sock.sent.find(f => f === '40')).toBeTruthy();
    expect(sock.sent.find(f => f.startsWith('42["join"'))).toContain('currentPrices@futures@rt');

    // the server pushes a price-change — the tick lands SYNCHRONOUSLY
    sock.serverMessage(pcFrame('B-BTC_USDT@prices-futures', { p: '61000.5', pc: 1.1, T: Date.now() }));
    const t = getTick('FUT_BTC');
    expect(t).toBeTruthy();
    expect(t!.price).toBeCloseTo(61000.5, 6);
    expect(t!.source).toBe('coindcx-fut-ws'); // honest label — the WS served it

    // the health proof landed → REST slowed to the 10s floor + healthy
    expect(_cxRtStateForTest().wsHealthy).toBe(true);
    expect(_cxRtStateForTest().restMs).toBe(10_000);
    cxRtClientDown();
  });

  it('the engine.io ping frame is answered (keepalive) and joins are re-sent per channel', async () => {
    routeFetch(() => null);
    const sockets: FakeDcxWs[] = [];
    armWs(sockets);
    ensureCxRtSubscribed({ fut: ['BTC', 'ETH'], glob: ['AAPL'] });
    cxRtClientUp();
    await vi.waitFor(() => expect(sockets.length).toBe(1));
    const sock = sockets[0];
    // v11.3: book channel (always) + per-pair GLOB channels — 2 joins
    await vi.waitFor(() => expect(sock.sent.filter(f => f.startsWith('42["join"'))).toHaveLength(2));
    // server ping '2' → client must pong '3' (Engine.IO liveness)
    sock.serverMessage('2');
    expect(sock.sent.filter(f => f === '3').length).toBe(1);
    // GLOB channels use the USDC pair shape
    expect(sock.sent.find(f => f.includes('B-AAPL_USDC@prices-futures'))).toBeTruthy();
    // the FUT domain rides the single book channel
    expect(sock.sent.find(f => f.includes('currentPrices@futures@rt'))).toBeTruthy();
    cxRtClientDown();
  });

  it('a LIVE socket that drops → REST instantly back to 2s + reconnect scheduled (degrade path)', async () => {
    routeFetch(url => ({ ok: false, status: 403, json: async () => ({}) }));
    const sockets: FakeDcxWs[] = [];
    armWs(sockets);
    ensureCxRtSubscribed({ fut: ['BTC'] });
    cxRtClientUp();
    await vi.waitFor(() => expect(sockets.length).toBe(1));
    const sock = sockets[0];
    await vi.waitFor(() => expect(sock.sent.filter(f => f.startsWith('42["join"'))).toHaveLength(1));
    // healthy: a tick landed → REST at the 10s floor
    sock.serverMessage(pcFrame('B-BTC_USDT@prices-futures', { p: '61000.5', pc: 1.1, T: Date.now() }));
    expect(_cxRtStateForTest().restMs).toBe(10_000);

    // the server drops us — REST returns to full 2s IMMEDIATELY
    sock.drop();
    expect(_cxRtStateForTest().ws.socket).toBe(false);
    expect(_cxRtStateForTest().wsHealthy).toBe(false);
    expect(_cxRtStateForTest().restMs).toBe(2_000);

    // and the reconnect is scheduled (3s base backoff) — a second socket appears
    await vi.waitFor(() => expect(sockets.length).toBe(2), { timeout: 6_000 });
    cxRtClientDown();
  });

  it('SILENT socket (open, joined, zero attributable ticks) never slows REST — the watchdog kills it after 2 min', async () => {
    routeFetch(() => null);
    const sockets: FakeDcxWs[] = [];
    armWs(sockets);
    const t0 = Date.now();
    let fake = t0;
    _setCxRtNowForTest(() => fake);
    try {
      ensureCxRtSubscribed({ fut: ['BTC'] });
      cxRtClientUp();
      await vi.waitFor(() => expect(sockets.length).toBe(1));
      const sock = sockets[0];
      // v11.3: ONE book-channel join for the single FUT subscription
      await vi.waitFor(() => expect(sock.sent.filter(f => f.startsWith('42["join"'))).toHaveLength(1));

      // connected but SILENT — REST must stay at the full 2s (no fake health)
      expect(_cxRtStateForTest().ws.connected).toBe(true);
      expect(_cxRtStateForTest().wsHealthy).toBe(false);
      expect(_cxRtStateForTest().restMs).toBe(2_000);

      // 2 minutes of silence → the watchdog kills the socket + cooldown
      fake = t0 + 121_000;
      await _pollOnceForTest();
      expect(_cxRtStateForTest().ws.socket).toBe(false);               // killed
      expect(_cxRtStateForTest().wsDisabledUntil).toBeGreaterThan(fake); // 10-min cooldown armed
      expect(sock.closed).toBe(true);
    } finally {
      _setCxRtNowForTest(null);
      cxRtClientDown();
    }
  });

  it('unattributable events NEVER count as health (docs payload is best-effort)', async () => {
    routeFetch(() => null);
    const sockets: FakeDcxWs[] = [];
    armWs(sockets);
    ensureCxRtSubscribed({ fut: ['BTC'] });
    cxRtClientUp();
    await vi.waitFor(() => expect(sockets.length).toBe(1));
    const sock = sockets[0];
    await vi.waitFor(() => expect(sock.sent.filter(f => f.startsWith('42["join"'))).toHaveLength(1));

    // an event with NO channelName / pair / prices book → cannot be attributed
    sock.serverMessage('42["price-change",{"p":"61000.5","T":' + Date.now() + '}]');
    expect(_cxRtStateForTest().wsHealthy).toBe(false);       // no fake health proof
    expect(_cxRtStateForTest().restMs).toBe(2_000);          // REST still full-speed
    // a NON price-change event is ignored outright
    sock.serverMessage('42["new-trade",{"channelName":"B-BTC_USDT@trades-futures","data":{"p":"1","q":"2","T":' + Date.now() + '}}]');
    expect(_cxRtStateForTest().wsHealthy).toBe(false);
    cxRtClientDown();
  });

  it('a LATE WS frame never regresses a newer tick (out-of-order guard)', async () => {
    routeFetch(() => null);
    const sockets: FakeDcxWs[] = [];
    armWs(sockets);
    ensureCxRtSubscribed({ fut: ['BTC'] });
    cxRtClientUp();
    await vi.waitFor(() => expect(sockets.length).toBe(1));
    const sock = sockets[0];
    await vi.waitFor(() => expect(sock.sent.filter(f => f.startsWith('42["join"'))).toHaveLength(1));

    const now = Date.now();
    sock.serverMessage(pcFrame('B-BTC_USDT@prices-futures', { p: '61000.5', pc: 1.1, T: now }));
    expect(getTick('FUT_BTC')!.price).toBeCloseTo(61000.5, 6);
    // a STALE frame arrives 60s late — must NOT regress the newer tick
    sock.serverMessage(pcFrame('B-BTC_USDT@prices-futures', { p: '59000', pc: 0.5, T: now - 60_000 }));
    expect(getTick('FUT_BTC')!.price).toBeCloseTo(61000.5, 6);
    cxRtClientDown();
  });

  // v10.13 (deep-recheck M3): epoch UNIT normalization. CoinDCX serves
  // SECONDS in `ts`/`T` fields while every internal comparison is in ms.
  // A seconds-based WS T against an ms-based REST tick used to make the
  // out-of-order guard reject (or accept) by LUCK of unit order — and a
  // seconds value stored into liveFeed poisoned frontend freshness logic.
  it('SECONDS-based WS T is normalized to ms — accepted after an ms REST tick (unit-mix guard)', async () => {
    // REST serves first with a normal ms-based ts (fetchFuturesPrices)
    routeFetch(url => {
      if (url.includes('/futures/data/active?')) return { ok: true, json: async () => [] };
      return {
        ok: true,
        json: async () => ({ ts: Date.now(), prices: { 'B-BTC_USDT': futRow(50_000, 2.5) } }),
      };
    });
    const sockets: FakeDcxWs[] = [];
    armWs(sockets);
    ensureCxRtSubscribed({ fut: ['BTC'] });
    cxRtClientUp();
    await _pollOnceForTest();
    expect(getTick('FUT_BTC')!.price).toBeCloseTo(50_000, 6);
    expect(getTick('FUT_BTC')!.source).toBe('coindcx-fut-rt');
    // the WS arms in parallel — wait for the live socket before pushing
    await vi.waitFor(() => expect(sockets.length).toBe(1));
    await vi.waitFor(() => expect(sockets[0].sent.filter(f => f.startsWith('42["join"'))).toHaveLength(1));

    // NOW a WS event with a SECONDS-based T (≈ now/1000). Pre-fix this
    // landed in liveFeed as ~1970 or tripped the guard by unit luck;
    // post-fix it is normalized to ms and ACCEPTED as the newer tick.
    const secs = Math.floor(Date.now() / 1000);
    sockets[0].serverMessage(pcFrame('B-BTC_USDT@prices-futures', { p: '51000', pc: 2.0, T: secs }));
    const t = getTick('FUT_BTC')!;
    expect(t.price).toBeCloseTo(51000, 6);
    expect(t.source).toBe('coindcx-fut-ws');
    expect(t.time).toBeGreaterThan(1e12); // stored in MILLISECONDS
    cxRtClientDown();
  });

  it('SECONDS-based REST ts is normalized to ms in liveFeed (futures.js parse)', async () => {
    routeFetch(url => {
      if (url.includes('/futures/data/active?')) return { ok: true, json: async () => [] };
      return {
        ok: true,
        json: async () => ({ ts: Math.floor(Date.now() / 1000), prices: { 'B-BTC_USDT': futRow(50_500, 1.0) } }),
      };
    });
    ensureCxRtSubscribed({ fut: ['BTC'] });
    cxRtClientUp();
    await _pollOnceForTest();
    const t = getTick('FUT_BTC')!;
    expect(t.price).toBeCloseTo(50_500, 6);
    expect(t.time).toBeGreaterThan(1e12); // ms, not seconds
    cxRtClientDown();
  });

  it('BOOK-STYLE full updates fan out per subscribed symbol (tolerant parse)', async () => {
    routeFetch(() => null);
    const sockets: FakeDcxWs[] = [];
    armWs(sockets);
    ensureCxRtSubscribed({ fut: ['BTC', 'ETH'] }); // SOL not subscribed
    cxRtClientUp();
    await vi.waitFor(() => expect(sockets.length).toBe(1));
    const sock = sockets[0];
    // v11.3: the two FUT subscriptions share ONE book-channel join
    await vi.waitFor(() => expect(sock.sent.filter(f => f.startsWith('42["join"'))).toHaveLength(1));

    sock.serverMessage(`42["price-change",${JSON.stringify({ prices: {
      'B-BTC_USDT': { ls: 61100, pc: 1.2, h: 61500, l: 60800, v: 900, T: Date.now() },
      'B-ETH_USDT': { ls: 3110, pc: -0.4, h: 3150, l: 3080, v: 800, T: Date.now() },
      'B-SOL_USDT': { ls: 148.5, pc: 4.1, h: 150, l: 146, v: 700, T: Date.now() },
    } })}]`);
    expect(getTick('FUT_BTC')!.price).toBeCloseTo(61100, 6);
    expect(getTick('FUT_BTC')!.source).toBe('coindcx-fut-ws');
    expect(getTick('FUT_ETH')!.price).toBeCloseTo(3110, 6);
    expect(getTick('FUT_SOL')).toBeNull(); // NOT subscribed → no tick (refcount contract)
    cxRtClientDown();
  });

  it('USDC equity-perp channels land GLOB_ ticks with the honest coindcx-glob-ws label', async () => {
    routeFetch(() => null);
    const sockets: FakeDcxWs[] = [];
    armWs(sockets);
    ensureCxRtSubscribed({ glob: ['AAPL'] });
    cxRtClientUp();
    await vi.waitFor(() => expect(sockets.length).toBe(1));
    const sock = sockets[0];
    // v11.3: book channel + the AAPL USDC channel = 2 joins
    await vi.waitFor(() => expect(sock.sent.filter(f => f.startsWith('42["join"'))).toHaveLength(2));
    expect(sock.sent.find(f => f.includes('B-AAPL_USDC@prices-futures'))).toBeTruthy();

    sock.serverMessage(pcFrame('B-AAPL_USDC@prices-futures', { p: '333.75', pc: 0.42, T: Date.now() }));
    const t = getTick('GLOB_AAPL');
    expect(t).toBeTruthy();
    expect(t!.price).toBeCloseTo(333.75, 6);
    expect(t!.source).toBe('coindcx-glob-ws');
    cxRtClientDown();
  });
});

describe('cxRtStream — v10.15 BINANCE FUTURES WS ACCELERATOR (the tier between the CoinDCX socket and Binance REST)', () => {
  afterEach(() => { cxRtClientDown(); });

  /** A minimal `ws`-shaped double for the Binance combined-stream socket:
   *  fires 'open' next macrotask, 'message' with raw JSON strings. */
  class FakeBinanceWs {
    readyState = 1; // WebSocket.OPEN
    url: string;
    sent: string[] = [];
    closed = false;
    private listeners = new Map<string, Array<(arg?: unknown) => void>>();
    constructor(url: string) {
      this.url = url;
      setTimeout(() => { if (!this.closed) this._emit('open'); }, 0);
    }
    on(ev: string, fn: (arg?: unknown) => void) {
      if (!this.listeners.has(ev)) this.listeners.set(ev, []);
      this.listeners.get(ev)!.push(fn);
    }
    removeAllListeners() { this.listeners.clear(); }
    send(frame: string) { this.sent.push(frame); }
    close() { if (!this.closed) { this.closed = true; this._emit('close'); } }
    terminate() { this.close(); }
    private _emit(ev: string, arg?: unknown) {
      for (const fn of [...(this.listeners.get(ev) || [])]) fn(arg);
    }
    serverMessage(msg: unknown) { if (!this.closed) this._emit('message', JSON.stringify(msg)); }
    drop() { this.readyState = 3; this.close(); }
  }

  const tickerFrame = (base: string, c: string, P = '1.1') => ({
    stream: `${base.toLowerCase()}usdt@ticker`,
    data: { e: '24hrTicker', E: Date.now(), s: `${base}USDT`, c, P, h: String(Number(c) * 1.01), l: String(Number(c) * 0.99), v: '21000.5', x: String(Number(c) / 1.011) },
  });

  function armBinanceWs(sockets: FakeBinanceWs[]) {
    _setBinanceFutWsFactoryForTest((url: string) => {
      const s = new FakeBinanceWs(url);
      sockets.push(s);
      return s;
    });
  }

  it('CoinDCX WS DARK → the Binance WS opens, serves SUB-SECOND ticks, and the Binance REST path is NOT hit', async () => {
    let binanceRestHits = 0;
    routeFetch(url => {
      if (url.includes('fapi.binance.com')) { binanceRestHits++; return { ok: true, status: 200, json: async () => [] }; }
      return { ok: false, status: 403, json: async () => ({}) }; // CoinDCX dark everywhere
    });
    const sockets: FakeBinanceWs[] = [];
    armBinanceWs(sockets);
    ensureCxRtSubscribed({ fut: ['BTC'] });
    cxRtClientUp();
    // the accelerator arms BECAUSE the cx WS is dark (never proven)
    await vi.waitFor(() => expect(sockets.length).toBe(1));
    expect(sockets[0].url).toContain('fstream.binance.com/stream?streams=btcusdt@ticker');

    // liveFeed has no reset hook — earlier suites may have left a FRESH
    // coindcx-* tick on FUT_BTC, and the source-priority gate correctly
    // REJECTS binance ticks while that tick is fresh (<2.5s). Push frames
    // until the leftover ages out and the accelerator's tick lands —
    // the loop itself proves the no-flapping contract.
    await vi.waitFor(() => {
      sockets[0].serverMessage(tickerFrame('BTC', '61000.5', '1.1'));
      expect(getTick('FUT_BTC')?.source).toBe('binance-fut-ws');
    }, { timeout: 8000 });
    const t = getTick('FUT_BTC')!;
    expect(t.price).toBeCloseTo(61000.5, 6);
    expect(t.time).toBeGreaterThan(1e12); // ms event time
    expect(_cxRtStateForTest().binanceFut.healthy).toBe(true);

    // the WS owns FUT → REST slows to the 10s floor, and the next REST
    // beat SKIPS the WS-covered symbol entirely (the initial beats may
    // have probed REST before the WS proved itself — that's the tier
    // below doing its job; from the landed tick on, REST is bypassed).
    expect(_cxRtStateForTest().restMs).toBe(10_000);
    const hitsAfterLand = binanceRestHits;
    await _pollOnceForTest();
    expect(binanceRestHits).toBe(hitsAfterLand); // WS-covered symbol NOT re-fetched over REST
  });

  it('both CoinDCX AND Binance WS dark → the Binance REST 5s path still takes over (tier below)', async () => {
    const fapiUrls: string[] = [];
    routeFetch(url => {
      if (url.includes('current_prices/futures/rt') && !url.includes('margin_currency')) {
        return { ok: false, status: 403, json: async () => ({}) };
      }
      if (url.includes('fapi.binance.com')) {
        // v21.13.x (P2): per-symbol single-object contract
        const sym = /symbol=([A-Z0-9]+)/.exec(url)?.[1] || '';
        fapiUrls.push(url);
        return { ok: true, status: 200, json: async () => (sym
          ? { symbol: sym, lastPrice: '62000.25', priceChangePercent: '0.9', highPrice: '62500', lowPrice: '61500', volume: '9000' }
          : [{ symbol: 'BTCUSDT', lastPrice: '62000.25', priceChangePercent: '0.9', highPrice: '62500', lowPrice: '61500', volume: '9000' }]) };
      }
      return null;
    });
    const sockets: FakeBinanceWs[] = [];
    armBinanceWs(sockets);
    ensureCxRtSubscribed({ fut: ['BTC'] });
    cxRtClientUp();
    // the accelerator TRIED to open but never proved a tick (handshake
    // ok, zero frames) — the REST fallback still owns the desk. The
    // previous test's binance-fut-ws tick may still be fresh (<5s) on
    // FUT_BTC, gating the REST branch — wait for it to age out.
    await vi.waitFor(() => expect(sockets.length).toBe(1));
    await vi.waitFor(() => expect(getTick('FUT_BTC')?.source).toBe('binance-fut-rt'), { timeout: 15_000 });
    expect(getTick('FUT_BTC')!.price).toBeCloseTo(62000.25, 6);
    // v21.13.x BANDWIDTH LOCK (P2): the REST fallback requested ONLY the
    // missing subscribed bases via per-symbol ?symbol= requests — never
    // the full ~793-symbol ~1.1MB book (the outage-mode whale; fapi
    // ignores the old ?symbols= JSON-array param — live-verified).
    expect(fapiUrls.length).toBeGreaterThan(0);
    for (const u of fapiUrls) expect(u).toContain('?symbol=');
    expect(fapiUrls.some(u => u.includes('symbol=BTCUSDT'))).toBe(true); // the missing base requested
    expect(fapiUrls.length).toBeLessThanOrEqual(100);
  }, 25_000);

  it('the cx socket recovers → the accelerator STANDS DOWN (hot-standby closes; CoinDCX owns the key again)', async () => {
    // CoinDCX REST dark (so the accelerator arms) + a live cx WS double
    routeFetch(url => ({ ok: false, status: 403, json: async () => ({}) }));
    const cxSockets: FakeDcxWs[] = [];
    const bnSockets: FakeBinanceWs[] = [];
    _setDcxWsEnabledForTest(true);
    _setDcxWsFactoryForTest((url: string) => { const s = new FakeDcxWs(url); cxSockets.push(s); return s; });
    armBinanceWs(bnSockets);
    ensureCxRtSubscribed({ fut: ['BTC'] });
    cxRtClientUp();
    await vi.waitFor(() => expect(bnSockets.length).toBe(1)); // accelerator armed (cx unproven)
    // the cx WS proves itself with a landed tick
    await vi.waitFor(() => expect(cxSockets.length).toBe(1));
    await vi.waitFor(() => expect(cxSockets[0].sent.filter(f => f.startsWith('42["join"'))).toHaveLength(1));
    cxSockets[0].serverMessage(pcFrame('B-BTC_USDT@prices-futures', { p: '60000.5', pc: 1.0, T: Date.now() }));
    expect(getTick('FUT_BTC')!.source).toBe('coindcx-fut-ws');

    // the accelerator stands DOWN — its socket is closed
    await vi.waitFor(() => expect(bnSockets[0].closed).toBe(true));
    expect(_cxRtStateForTest().binanceFut.wantOpen).toBe(false);
    expect(cxRtWsStatus().binanceFut.wantOpen).toBe(false);
  });

  it('source priority: a FRESH coindcx-fut-rt tick is never overwritten by a binance-fut-ws tick (no badge flapping)', async () => {
    // CoinDCX REST healthy at 2s while the cx WS is dark → both paths
    // alive; the accelerator must respect the authoritative exchange.
    routeFetch(url => {
      if (url.includes('current_prices/futures/rt') && !url.includes('margin_currency')) {
        return { ok: true, status: 200, json: async () => ({ ts: Date.now(), prices: { 'B-BTC_USDT': futRow(50_000, 2.5) } }) };
      }
      return { ok: false, status: 403, json: async () => ({}) };
    });
    const sockets: FakeBinanceWs[] = [];
    armBinanceWs(sockets);
    ensureCxRtSubscribed({ fut: ['BTC'] });
    cxRtClientUp();
    await _pollOnceForTest();
    expect(getTick('FUT_BTC')!.source).toBe('coindcx-fut-rt'); // the authoritative 2s feed
    await vi.waitFor(() => expect(sockets.length).toBe(1));
    // a binance tick arrives — CoinDCX REST is fresh → the tick is REJECTED
    sockets[0].serverMessage(tickerFrame('BTC', '51000'));
    expect(getTick('FUT_BTC')!.source).toBe('coindcx-fut-rt');
    expect(getTick('FUT_BTC')!.price).toBeCloseTo(50_000, 6);
    // sanity: the gate is FRESHNESS-based — a fresh binance tick DOES land
    // once the CoinDCX REST tick ages past its window
  });

  it('no SSE clients → the accelerator closes with the host (Render idle-friendly)', async () => {
    routeFetch(url => ({ ok: false, status: 403, json: async () => ({}) }));
    const sockets: FakeBinanceWs[] = [];
    armBinanceWs(sockets);
    ensureCxRtSubscribed({ fut: ['BTC'] });
    cxRtClientUp();
    await vi.waitFor(() => expect(sockets.length).toBe(1));
    cxRtClientDown();
    await vi.waitFor(() => expect(sockets[0].closed).toBe(true));
    expect(_cxRtStateForTest().binanceFut.connected).toBe(false);
  });

  it('the stream list is capped at 20 bases and follows the subscribed universe', async () => {
    routeFetch(url => ({ ok: false, status: 403, json: async () => ({}) }));
    const sockets: FakeBinanceWs[] = [];
    armBinanceWs(sockets);
    const bases = Array.from({ length: 25 }, (_, i) => `COIN${i}`);
    ensureCxRtSubscribed({ fut: bases });
    cxRtClientUp();
    await vi.waitFor(() => expect(sockets.length).toBe(1));
    const streams = sockets[0].url.split('streams=')[1];
    expect(streams.split('/')).toHaveLength(20); // BINANCE_MAX_STREAMS parity
    expect(streams).toContain('coin0usdt@ticker');
    expect(streams).not.toContain('coin24usdt');
  });

  it('a LATE binance frame never regresses a newer tick (out-of-order guard)', async () => {
    routeFetch(url => ({ ok: false, status: 403, json: async () => ({}) }));
    const sockets: FakeBinanceWs[] = [];
    armBinanceWs(sockets);
    ensureCxRtSubscribed({ fut: ['BTC'] });
    cxRtClientUp();
    await vi.waitFor(() => expect(sockets.length).toBe(1));
    const now = Date.now();
    // earlier suites' fresh coindcx-* leftovers gate the first frame —
    // push until the accelerator's tick actually lands.
    await vi.waitFor(() => {
      sockets[0].serverMessage({ stream: 'btcusdt@ticker', data: { e: '24hrTicker', E: Date.now(), s: 'BTCUSDT', c: '61000.5', P: '1.1', h: '61500', l: '60800', v: '21000', x: '60000' } });
      expect(getTick('FUT_BTC')?.source).toBe('binance-fut-ws');
    }, { timeout: 8000 });
    expect(getTick('FUT_BTC')!.price).toBeCloseTo(61000.5, 6);
    // 60s-stale frame → rejected
    sockets[0].serverMessage({ stream: 'btcusdt@ticker', data: { e: '24hrTicker', E: now - 60_000, s: 'BTCUSDT', c: '59000', P: '0.5', h: '59500', l: '58800', v: '20000', x: '58000' } });
    expect(getTick('FUT_BTC')!.price).toBeCloseTo(61000.5, 6);
  });
});

// ============================================================
// v10.14 (deep-recheck S2) — DOMAIN-AWARE SILENCE BUDGETS
//   Equity USDC perps (AAPL/MU/SPCX) legitimately go minutes without
//   a print (especially US premarket) — the old flat 120s watchdog
//   mistook that for a contract mismatch and benched the accelerator
//   for 10 min ("ultra-fast feel gone"). New contract:
//     • FUT-subscribed session silent > 2 min  → still killed (crypto
//       never goes that quiet — strict thresholds UNCHANGED)
//     • GLOB-only session silent 2 min         → alive (quiet ≠ dead)
//     • GLOB-only session silent 5 min         → killed, 3-min cooldown
//     • GLOB-only in US premarket, 5 min       → still alive (7.5-min budget)
//     • cxRtWsStatus() exposes the reason + remaining cooldown
// ============================================================
describe('cxRtStream — v10.14 GLOB-aware silent-kill thresholds', () => {
  afterEach(() => { _setUsPremarketForTest(null); });

  // local armWs (the WS-accelerator suite's helper is describe-scoped)
  function armWs(sockets: FakeDcxWs[]) {
    _setDcxWsEnabledForTest(true);
    _setDcxWsFactoryForTest((url: string) => {
      const s = new FakeDcxWs(url);
      sockets.push(s);
      return s;
    });
  }

  it('GLOB-only + 2 min of silence → socket ALIVE (quiet equity feed ≠ dead contract)', async () => {
    routeFetch(() => null);
    const sockets: FakeDcxWs[] = [];
    armWs(sockets);
    _setUsPremarketForTest(() => false); // regular hours budget = 5 min
    const t0 = Date.now();
    let fake = t0;
    _setCxRtNowForTest(() => fake);
    try {
      ensureCxRtSubscribed({ glob: ['AAPL', 'MU'] });
      cxRtClientUp();
      await vi.waitFor(() => expect(sockets.length).toBe(1));
      const sock = sockets[0];
      // v11.3: book channel + 2 USDC channels = 3 joins
      await vi.waitFor(() => expect(sock.sent.filter(f => f.startsWith('42["join"'))).toHaveLength(3));

      fake = t0 + 121_000; // past the OLD 2-min kill point
      await _pollOnceForTest();
      expect(_cxRtStateForTest().ws.socket).toBe(true);            // NOT killed
      expect(sock.closed).toBe(false);
      expect(_cxRtStateForTest().wsDisabledUntil).toBe(0);          // no cooldown
      expect(cxRtWsStatus().cooldownActive).toBe(false);
      expect(cxRtWsStatus().premarketBudget).toBe(300_000);         // the honest live budget
    } finally {
      _setCxRtNowForTest(null);
      cxRtClientDown();
    }
  });

  it('GLOB-only + 5 min of silence → killed with the SHORT 3-min cooldown (glob-quiet reason)', async () => {
    routeFetch(() => null);
    const sockets: FakeDcxWs[] = [];
    armWs(sockets);
    _setUsPremarketForTest(() => false);
    const t0 = Date.now();
    let fake = t0;
    _setCxRtNowForTest(() => fake);
    try {
      ensureCxRtSubscribed({ glob: ['AAPL'] });
      cxRtClientUp();
      await vi.waitFor(() => expect(sockets.length).toBe(1));
      const sock = sockets[0];
      // v11.3: book channel + 1 USDC channel = 2 joins
      await vi.waitFor(() => expect(sock.sent.filter(f => f.startsWith('42["join"'))).toHaveLength(2));

      fake = t0 + 301_000;
      await _pollOnceForTest();
      expect(_cxRtStateForTest().ws.socket).toBe(false);             // killed
      expect(sock.closed).toBe(true);
      expect(_cxRtStateForTest().wsDisabledUntil).toBeGreaterThan(fake);        // cooldown armed…
      expect(_cxRtStateForTest().wsDisabledUntil - fake).toBeLessThanOrEqual(3 * 60_000 + 1); // …but only 3 min
      expect(_cxRtStateForTest().wsCooldownReason).toBe('glob-quiet');
      const st = cxRtWsStatus();
      expect(st.cooldownActive).toBe(true);
      expect(st.cooldownReason).toBe('glob-quiet');
      expect(st.cooldownRemainMs).toBeGreaterThan(0);
    } finally {
      _setCxRtNowForTest(null);
      cxRtClientDown();
    }
  });

  it('same 5-min silence in US PREMARKET → still alive (7.5-min budget)', async () => {
    routeFetch(() => null);
    const sockets: FakeDcxWs[] = [];
    armWs(sockets);
    _setUsPremarketForTest(() => true); // 04:00–09:30 ET widened budget
    const t0 = Date.now();
    let fake = t0;
    _setCxRtNowForTest(() => fake);
    try {
      ensureCxRtSubscribed({ glob: ['AAPL'] });
      cxRtClientUp();
      await vi.waitFor(() => expect(sockets.length).toBe(1));
      const sock = sockets[0];
      // v11.3: book channel + 1 USDC channel = 2 joins
      await vi.waitFor(() => expect(sock.sent.filter(f => f.startsWith('42["join"'))).toHaveLength(2));

      fake = t0 + 301_000; // would die at regular-hours budget
      await _pollOnceForTest();
      expect(_cxRtStateForTest().ws.socket).toBe(true);             // premarket mercy
      expect(sock.closed).toBe(false);
      expect(cxRtWsStatus().premarketBudget).toBe(450_000);

      fake = t0 + 451_000; // past even the widened budget
      await _pollOnceForTest();
      expect(_cxRtStateForTest().ws.socket).toBe(false);
      expect(_cxRtStateForTest().wsCooldownReason).toBe('glob-quiet');
    } finally {
      _setUsPremarketForTest(null);
      _setCxRtNowForTest(null);
      cxRtClientDown();
    }
  });

  it('a FUT-subscribed session keeps the STRICT crypto thresholds — 2 min silence still kills (10-min cooldown)', async () => {
    routeFetch(() => null);
    const sockets: FakeDcxWs[] = [];
    armWs(sockets);
    _setUsPremarketForTest(() => false);
    const t0 = Date.now();
    let fake = t0;
    _setCxRtNowForTest(() => fake);
    try {
      ensureCxRtSubscribed({ fut: ['BTC'], glob: ['AAPL'] }); // BOTH domains — crypto speaks loudest
      cxRtClientUp();
      await vi.waitFor(() => expect(sockets.length).toBe(1));
      const sock = sockets[0];
      await vi.waitFor(() => expect(sock.sent.filter(f => f.startsWith('42["join"'))).toHaveLength(2));

      fake = t0 + 121_000;
      await _pollOnceForTest();
      expect(_cxRtStateForTest().ws.socket).toBe(false);             // killed — crypto silence IS broken
      expect(sock.closed).toBe(true);
      expect(_cxRtStateForTest().wsCooldownReason).toBe('silent-contract');
      expect(_cxRtStateForTest().wsDisabledUntil - fake).toBeGreaterThan(5 * 60_000); // 10-min cooldown
    } finally {
      _setCxRtNowForTest(null);
      cxRtClientDown();
    }
  });
});

// ============================================================
// v11.3 — THE FUTURES BOOK CHANNEL (currentPrices@futures@rt)
// ------------------------------------------------------------
// LIVE-VERIFIED (2026-09-17, wss://stream.coindcx.com EIO=4): the
// channel pushes FULL book updates ~1/sec with ATTRIBUTABLE pair keys:
//   42["currentPrices@futures#update", {"event":"…","data":"<JSON string>"}]
//   data = { vs, ts, pr:"futures", prices: { "B-BTC_USDT":
//            { ls?, pc?, v?, mp?, bmST?, cmRT? } } }
// The old per-pair "@prices-futures" price-change events carry NO pair
// identity (payload = {T, p, pr}) — the book channel is the only
// attributable stream. Locked here: string-payload parse, ls-tick
// landing + honest label + health proof, mp keep-alive semantics,
// heartbeat health proof, and the shared book state (futures.js's
// fetchFuturesPrices fallback leg).
// ============================================================
describe('cxRtStream — v11.3 FUTURES BOOK CHANNEL (attributable book updates)', () => {
  function armWs(sockets: FakeDcxWs[]) {
    _setDcxWsEnabledForTest(true);
    _setDcxWsFactoryForTest((url: string) => {
      const s = new FakeDcxWs(url);
      sockets.push(s);
      return s;
    });
  }

  /** A live book update frame — data is a JSON-encoded STRING. */
  const bookFrame = (prices: Record<string, Record<string, unknown>>, ts?: number) =>
    `42["currentPrices@futures#update",${JSON.stringify({
      event: 'currentPrices@futures#update',
      data: JSON.stringify({ vs: 1, ts: ts ?? Date.now(), pr: 'futures', prices }),
    })}]`;

  afterEach(() => { cxRtClientDown(); });

  it('a book update (data-as-STRING) lands the ls tick IMMEDIATELY with the honest label + proves health → REST 10s floor', async () => {
    routeFetch(() => null); // REST fully dark
    const sockets: FakeDcxWs[] = [];
    armWs(sockets);
    ensureCxRtSubscribed({ fut: ['BTC'] });
    cxRtClientUp();
    await vi.waitFor(() => expect(sockets.length).toBe(1));
    const sock = sockets[0];
    await vi.waitFor(() => expect(sock.sent.filter(f => f.startsWith('42["join"'))).toHaveLength(1));
    // the ONE join is the book channel
    expect(sock.sent.find(f => f.startsWith('42["join"'))).toContain('currentPrices@futures@rt');

    sock.serverMessage(bookFrame({ 'B-BTC_USDT': { ls: 76_421.4, pc: 1.1, v: 2_100.5, mp: 76_420.9 } }));
    const t = getTick('FUT_BTC');
    expect(t).toBeTruthy();
    expect(t!.price).toBeCloseTo(76_421.4, 6);
    expect(t!.source).toBe('coindcx-fut-ws'); // honest label
    expect(t!.change).toBeCloseTo(1.1, 6);
    expect(t!.volume).toBeCloseTo(2_100.5, 6);
    // attributable tick landed → health proven → REST slowed to the 10s floor
    expect(_cxRtStateForTest().wsHealthy).toBe(true);
    expect(_cxRtStateForTest().restMs).toBe(10_000);
    // the shared book state carries the row for futures.js's fallback
    expect(_cxRtStateForTest().book.pairs).toBe(1);
    expect(_cxRtStateForTest().book.fresh).toBe(1);
  });

  it('unsubscribed pairs merge into the BOOK but land NO tick (refcount contract)', async () => {
    routeFetch(() => null);
    const sockets: FakeDcxWs[] = [];
    armWs(sockets);
    ensureCxRtSubscribed({ fut: ['BTC'] });
    cxRtClientUp();
    await vi.waitFor(() => expect(sockets.length).toBe(1));
    const sock = sockets[0];
    await vi.waitFor(() => expect(sock.sent.filter(f => f.startsWith('42["join"'))).toHaveLength(1));

    sock.serverMessage(bookFrame({
      'B-BTC_USDT': { ls: 76_421.4, pc: 1.1, v: 100 },
      'B-SOL_USDT': { ls: 148.55, pc: 4.1, v: 700 },
    }));
    expect(getTick('FUT_BTC')!.price).toBeCloseTo(76_421.4, 6);
    expect(getTick('FUT_SOL')).toBeNull(); // NOT subscribed → no tick
    expect(_cxRtStateForTest().book.pairs).toBe(2); // both rows in the book
  });

  it('mp-only rows are a KEEP-ALIVE: they land only when the current tick is stale, never displacing a fresh ls', async () => {
    routeFetch(() => null);
    const sockets: FakeDcxWs[] = [];
    armWs(sockets);
    ensureCxRtSubscribed({ fut: ['BTC'] });
    cxRtClientUp();
    await vi.waitFor(() => expect(sockets.length).toBe(1));
    const sock = sockets[0];
    await vi.waitFor(() => expect(sock.sent.filter(f => f.startsWith('42["join"'))).toHaveLength(1));

    // controllable clock — the 8s staleness budget rides _nowFn()
    let fake = Date.now();
    _setCxRtNowForTest(() => fake);
    try {
      // ls tick first
      sock.serverMessage(bookFrame({ 'B-BTC_USDT': { ls: 76_421.4, pc: 1.1, v: 100 } }));
      expect(getTick('FUT_BTC')!.price).toBeCloseTo(76_421.4, 6);
      // a FRESHER mp-only row must NOT displace the fresh ls tick
      fake += 1_000;
      sock.serverMessage(bookFrame({ 'B-BTC_USDT': { mp: 99_999.9 } }));
      expect(getTick('FUT_BTC')!.price).toBeCloseTo(76_421.4, 6); // unchanged
      // …but once the tick ages out (8s), an mp row lands as the keep-alive
      fake += 9_000;
      sock.serverMessage(bookFrame({ 'B-BTC_USDT': { mp: 77_000.5 } }));
      expect(getTick('FUT_BTC')!.price).toBeCloseTo(77_000.5, 6);
    } finally {
      _setCxRtNowForTest(null);
    }
  });

  it('a heartbeat-only row (no ls/mp) for a SUBSCRIBED symbol proves health without landing a tick', async () => {
    routeFetch(() => null);
    const sockets: FakeDcxWs[] = [];
    armWs(sockets);
    ensureCxRtSubscribed({ fut: ['BTC'] });
    cxRtClientUp();
    await vi.waitFor(() => expect(sockets.length).toBe(1));
    const sock = sockets[0];
    await vi.waitFor(() => expect(sock.sent.filter(f => f.startsWith('42["join"'))).toHaveLength(1));
    expect(_cxRtStateForTest().wsHealthy).toBe(false); // nothing proven yet
    // liveFeed carries no reset hook — capture whatever tick a previous
    // suite left and assert the heartbeat changes NOTHING
    const before = getTick('FUT_BTC');
    sock.serverMessage(bookFrame({ 'B-BTC_USDT': { bmST: Date.now(), cmRT: Date.now() } }));
    expect(_cxRtStateForTest().wsHealthy).toBe(true);  // alive channel proven
    expect(getTick('FUT_BTC')).toEqual(before);        // but no price landed
  });
});
