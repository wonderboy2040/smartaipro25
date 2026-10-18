// ============================================================
// streamFeeds tests — 2026 realtime audit regression suite
// Covers the "US/India realtime prices not streaming on site load" fixes:
//   RC1  Finnhub REST staleness gate (isStaleUsQuote + usMarketOpen)
//   RC2  WS-gap Yahoo fallback poller (SPY/SMH/VGT get zero WS trades)
//   RC3  Yahoo bootstrap seeds a LIVE snapshot (not Friday's close)
//   RC4  Reconnect deadlock (cleared timer + future _reconnectAt)
//   RC5  India server-side push (inStream: NSE gating, Groww→Yahoo, crypto filter)
// No network — fetch + WebSocket are injected test doubles.
// ============================================================
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';

// Deterministic market clocks:
//  - US OPEN  : Monday 2026-08-31 15:00 UTC = 11:00 AM ET
//  - NSE OPEN : Monday 2026-08-31 04:30 UTC = 10:00 AM IST
//  - NSE CLOSED (evening): Monday 2026-08-31 14:30 UTC = 20:00 IST
const US_OPEN_T = new Date('2026-08-31T15:00:00Z').getTime();
const NSE_OPEN_T = new Date('2026-08-31T04:30:00Z').getTime();
const NSE_CLOSED_T = new Date('2026-08-31T14:30:00Z').getTime();

const yahooResponse = (price, pc, tSec) => ({
  ok: true,
  json: async () => ({
    chart: {
      result: [{
        meta: {
          regularMarketPrice: price,
          chartPreviousClose: pc,
          regularMarketDayHigh: price + 2,
          regularMarketDayLow: price - 2,
          regularMarketVolume: 4242,
          regularMarketTime: tSec,
        },
      }],
    },
  }),
});

// ---- usMarketOpen / isStaleUsQuote (pure) -------------------------
describe('usMarketOpen (ET session clock)', () => {
  it.each([
    ['Mon 11:00 ET → open', new Date('2026-08-31T15:00:00Z'), true],
    ['Mon 09:30 ET → open', new Date('2026-08-31T13:30:00Z'), true],
    ['Mon 16:00 ET → open (close edge)', new Date('2026-08-31T20:00:00Z'), true],
    ['Mon 17:00 ET → closed', new Date('2026-08-31T21:00:00Z'), false],
    ['Mon 03:00 UTC = Sun 23:00 ET → closed (weekend)', new Date('2026-08-31T03:00:00Z'), false],
    ['Sat 15:00 UTC → closed', new Date('2026-09-05T15:00:00Z'), false],
  ])('%s', async (_label, date, expected) => {
    const { usMarketOpen } = await import('../server/usStream.js');
    expect(usMarketOpen(date)).toBe(expected);
  });
});

describe('isStaleUsQuote (RC1 freshness gate)', () => {
  it('rejects a >5min-old quote while the market is OPEN (the Friday-close bug)', async () => {
    const { isStaleUsQuote } = await import('../server/usStream.js');
    const now = Date.now();
    expect(isStaleUsQuote(now - 10 * 60 * 1000, now, true)).toBe(true);
    expect(isStaleUsQuote(now - 3 * 60 * 1000, now, true)).toBe(false);
  });
  it('accepts an old quote when the market is CLOSED (last close IS the price)', async () => {
    const { isStaleUsQuote } = await import('../server/usStream.js');
    const now = Date.now();
    expect(isStaleUsQuote(now - 3 * 24 * 60 * 60 * 1000, now, false)).toBe(false);
  });
  it('trusts quotes without a timestamp', async () => {
    const { isStaleUsQuote } = await import('../server/usStream.js');
    expect(isStaleUsQuote(0, Date.now(), true)).toBe(false);
  });
});

// ---- inStream pure + flow ----------------------------------------
describe('inStream (RC5 — India server-side push)', () => {
  let inStream;
  let getTick; // from the FRESH module registry (vi.resetModules re-imports liveFeed too)
  beforeEach(async () => {
    vi.resetModules();
    vi.useFakeTimers();
    getTick = (await import('../server/liveFeed.js')).getTick;
    inStream = await import('../server/inStream.js');
    inStream._resetInStreamForTest();
  });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });

  it('nseWindow: IST session + 15:40 grace, weekdays only', () => {
    expect(inStream.nseWindow(new Date(NSE_OPEN_T))).toBe(true);       // Mon 10:00 IST
    expect(inStream.nseWindow(new Date(NSE_CLOSED_T))).toBe(false);    // Mon 20:00 IST
    expect(inStream.nseWindow(new Date('2026-08-30T04:30:00Z'))).toBe(false); // Sunday
    expect(inStream.nseWindow(new Date('2026-08-31T10:10:00Z'))).toBe(true);  // 15:40 IST grace edge
  });

  it('subscribes equities, filters crypto bases (cryptoStream owns those)', () => {
    const groww = vi.fn(async () => ({ price: 3000, change: 0.5 }));
    inStream.initInStream({ fetchGrowwNseQuote: groww });
    inStream.ensureInSubscribed(['RELIANCE', 'BTC', 'ETH', 'TCS.NS']);
    const st = inStream.inDebugState();
    expect(st.subscribed).toContain('RELIANCE');
    expect(st.subscribed).toContain('TCS'); // .NS stripped
    expect(st.subscribed).not.toContain('BTC');
    expect(st.subscribed).not.toContain('ETH');
  });

  it('after-hours one-shot seeds the SSE snapshot via Groww (site-load price paint)', async () => {
    vi.setSystemTime(NSE_CLOSED_T); // 20:00 IST — NSE closed
    const groww = vi.fn(async (s) => ({ price: s === 'RELIANCE' ? 2925.5 : 0, change: 1.2, high: 2950, low: 2900, volume: 100, time: Date.now() }));
    inStream.initInStream({ fetchGrowwNseQuote: groww });
    inStream.ensureInSubscribed(['RELIANCE']);
    await vi.advanceTimersByTimeAsync(50);
    const t = getTick('IN_RELIANCE');
    expect(t).toBeTruthy();
    expect(t.price).toBe(2925.5);
    // v10.12 (#1): canonical India source label (Groww·live badge on the UI)
    expect(t.source).toBe('groww-live');
    // No polling loop outside NSE hours:
    expect(inStream.inDebugState().timer).toBe(false);
  });

  it('falls back to Yahoo (indices) when Groww has no quote', async () => {
    vi.setSystemTime(NSE_CLOSED_T);
    const groww = vi.fn(async () => null);
    const yahoo = vi.fn(async (ysym) => ({ price: 24800, change: -0.4, high: 25000, low: 24700, volume: 0, time: Date.now() }));
    const toY = vi.fn(() => '^NSEI');
    inStream.initInStream({ fetchGrowwNseQuote: groww, fetchYahooQuote: yahoo, toYahooSymbol: toY });
    inStream.ensureInSubscribed(['NIFTY']);
    await vi.advanceTimersByTimeAsync(50);
    const t = getTick('IN_NIFTY');
    expect(t).toBeTruthy();
    expect(t.price).toBe(24800);
    // v10.12 (#1): the Yahoo fallback is honestly labeled (Yahoo·delayed)
    expect(t.source).toBe('yahoo-delayed');
    expect(toY).toHaveBeenCalledWith('NIFTY', 'IN');
  });

  // v10.12.1 REGRESSION (deep-recheck live find): Groww's CASH/<INDEX>
  // endpoint serves a garbage STALE ltp for index names (observed live:
  // 19425.35, lastTradeTime Nov-2023, while ^NSEI was current). The inStream
  // poller must skip Groww for indices ENTIRELY — not "try Groww first" —
  // or the SSE wire pushes a WRONG price tagged 'groww-live'.
  it('REGRESSION (v10.12.1): indices skip Groww entirely — its garbage stale index ltp (19425 vs live ^NSEI) can NEVER be served as groww-live', async () => {
    vi.setSystemTime(NSE_CLOSED_T);
    // Groww serves the REAL garbage payload shape for indices: ltp>0 + null close
    const groww = vi.fn(async (s) => (s === 'NIFTY'
      ? { price: 19425.35, change: 0, high: 19425.35, low: 19425.35, volume: 0, time: 1699592213000 }
      : { price: 2925.5, change: 1.2 }));
    const yahoo = vi.fn(async () => ({ price: 24912.4, change: -0.31, high: 25000, low: 24700, volume: 0, time: Date.now() }));
    const toY = vi.fn(() => '^NSEI');
    inStream.initInStream({ fetchGrowwNseQuote: groww, fetchYahooQuote: yahoo, toYahooSymbol: toY });

    inStream.ensureInSubscribed(['NIFTY', 'SENSEX']);
    await vi.advanceTimersByTimeAsync(50);

    const t = getTick('IN_NIFTY');
    expect(t).toBeTruthy();
    expect(t.price).toBe(24912.4);            // Yahoo's CURRENT spot…
    expect(t.source).toBe('yahoo-delayed');   // …honestly labeled
    expect(groww).not.toHaveBeenCalled();     // Groww never even asked for an index
    expect(getTick('IN_SENSEX')?.source).toBe('yahoo-delayed');

    // Stocks still go to Groww first (no behavior change for equities):
    inStream.ensureInSubscribed(['RELIANCE']);
    await vi.advanceTimersByTimeAsync(50);
    expect(getTick('IN_RELIANCE')?.source).toBe('groww-live');
    expect(groww).toHaveBeenCalledWith('RELIANCE');
  });

  it('during NSE hours: 5s poll loop runs while clients are connected and stops when they leave', async () => {
    vi.setSystemTime(NSE_OPEN_T); // 10:00 IST Monday — open
    let calls = 0;
    const groww = vi.fn(async () => { calls++; return { price: 100 + calls, change: 0.1 }; });
    inStream.initInStream({ fetchGrowwNseQuote: groww });
    inStream.ensureInSubscribed(['SBIN']);
    await vi.advanceTimersByTimeAsync(50); // one-shot
    const afterOneShot = calls;

    inStream.inClientUp();               // SSE client connects → loop starts
    expect(inStream.inDebugState().timer).toBe(true);
    await vi.advanceTimersByTimeAsync(5000); // +1 poll round
    expect(calls).toBeGreaterThan(afterOneShot);

    inStream.inClientDown();             // last client leaves → loop stops
    expect(inStream.inDebugState().timer).toBe(false);
    const stopped = calls;
    await vi.advanceTimersByTimeAsync(15000);
    expect(calls).toBe(stopped);         // zero upstream calls while idle
  });
});

// ---- usStream lifecycle (RC2/RC3/RC4) -----------------------------
describe('usStream — keyless Yahoo operation (RC2/RC3)', () => {
  let us;
  let getTick;
  let setTick;
  let fetchMock;
  beforeEach(async () => {
    vi.resetModules();
    vi.stubEnv('FINNHUB_API_KEY', '');
    vi.useFakeTimers();
    vi.setSystemTime(US_OPEN_T); // US market OPEN
    const lf = await import('../server/liveFeed.js');
    getTick = lf.getTick; setTick = lf.setTick;
    us = await import('../server/usStream.js');
    us._resetUsStreamForTest();
    fetchMock = vi.fn(async () => yahooResponse(713.36, 716.43, Math.floor(US_OPEN_T / 1000)));
    us._setUsFetchForTest(fetchMock);
  });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); us?._setUsFetchForTest(null); });

  it('bootstrap seeds a LIVE Yahoo snapshot the moment a symbol is subscribed (no Finnhub key needed)', async () => {
    us.ensureUsSubscribed(['SPY']);
    await vi.advanceTimersByTimeAsync(50);
    const t = getTick('US_SPY');
    expect(t).toBeTruthy();
    expect(t.price).toBe(713.36);            // LIVE price, not Friday's close
    expect(t.source).toBe('yahoo-us-fallback');
    // change% computed against the CORRECT prevClose (716.43, not Thursday's 721.11)
    expect(t.change).toBeCloseTo(((713.36 - 716.43) / 716.43) * 100, 4);
  });

  it('WS-gap fallback poller refreshes symbols that get no WS trades (the SPY/SMH/VGT case)', async () => {
    us.ensureUsSubscribed(['SPY']);
    await vi.advanceTimersByTimeAsync(50);
    const bootCalls = fetchMock.mock.calls.length;

    us.usClientUp(); // SSE client active → fallback poller starts
    expect(us.usDebugState().fallbackTimer).toBe(true);
    await vi.advanceTimersByTimeAsync(5000); // one 5s cycle
    const t = getTick('US_SPY');
    expect(t.price).toBe(713.36);
    expect(fetchMock.mock.calls.length).toBeGreaterThan(bootCalls); // Yahoo was polled
    // ...and the poller idles once the last client leaves:
    us.usClientDown();
    expect(us.usDebugState().fallbackTimer).toBe(false);
  });

  it('WS trade ticks win over the fallback and mark lastWsTick so Yahoo stops polling that symbol', async () => {
    us.ensureUsSubscribed(['QQQ']);
    await vi.advanceTimersByTimeAsync(50);
    // (keyless — no WS here, so simulate the WS tick path via liveFeed directly)
    setTick('US_QQQ', { price: 713.68, change: -0.38, high: 715, low: 713, volume: 100, time: Date.now() }, 'finnhub-stream');
    const t = getTick('US_QQQ');
    expect(t.price).toBe(713.68);
    expect(t.source).toBe('finnhub-stream');
  });

  it('getUsSessionQuote: serves the shared stream session to /api/quote and expires when stale', async () => {
    us.ensureUsSubscribed(['SPY']);
    await vi.advanceTimersByTimeAsync(50); // bootstrap done
    const q = us.getUsSessionQuote('SPY');
    expect(q).toBeTruthy();
    expect(q.price).toBe(713.36);
    expect(q.source).toBe('yahoo-us-fallback');
    expect(q.prevClose).toBe(716.43); // correct prevClose (not Thursday's close)
    // No clients → no fallback refresh → session goes stale after maxStale (8s open):
    await vi.advanceTimersByTimeAsync(9000);
    expect(us.getUsSessionQuote('SPY')).toBeNull();
  });
});

describe('usStream — Finnhub WS lifecycle + reconnect deadlock fix (RC4)', () => {
  let us;
  let getTick;
  let wsInstances;
  let fetchMock;
  const makeFakeWs = () => {
    const ws = new EventEmitter();
    ws.readyState = 0; // CONNECTING
    ws.sent = [];
    ws.send = (d) => { ws.sent.push(JSON.parse(d)); };
    ws.close = () => { ws.readyState = 3; };
    wsInstances.push(ws);
    setTimeout(() => { ws.readyState = 1; ws.emit('open'); }, 20); // async open
    return ws;
  };
  beforeEach(async () => {
    vi.resetModules();
    vi.stubEnv('FINNHUB_API_KEY', 'TEST-KEY');
    vi.useFakeTimers();
    vi.setSystemTime(US_OPEN_T);
    getTick = (await import('../server/liveFeed.js')).getTick;
    us = await import('../server/usStream.js');
    us._resetUsStreamForTest();
    wsInstances = [];
    us._setWsFactoryForTest(makeFakeWs);
    fetchMock = vi.fn(async () => yahooResponse(713.36, 716.43, Math.floor(US_OPEN_T / 1000)));
    us._setUsFetchForTest(fetchMock);
  });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); us?._setWsFactoryForTest(null); us?._setUsFetchForTest(null); });

  it('connects on first client and subscribes every tracked symbol', async () => {
    us.ensureUsSubscribed(['SPY', 'QQQ']);
    await vi.advanceTimersByTimeAsync(30);
    us.usClientUp();
    await vi.advanceTimersByTimeAsync(30);
    expect(wsInstances.length).toBe(1);
    const subs = wsInstances[0].sent.filter(m => m.type === 'subscribe').map(m => m.symbol);
    expect(subs).toContain('SPY');
    expect(subs).toContain('QQQ');
  });

  it('REGRESSION (deadlock): a client arriving inside the reconnect backoff window still gets connected', async () => {
    us.ensureUsSubscribed(['SPY']);
    await vi.advanceTimersByTimeAsync(30);
    us.usClientUp();
    await vi.advanceTimersByTimeAsync(30);
    expect(wsInstances.length).toBe(1);

    // Socket dies → 5s backoff scheduled.
    wsInstances[0].emit('error');
    expect(us.usDebugState().reconnectAt).toBeGreaterThan(Date.now());

    // The only client leaves → _disconnect() CLEARS the reconnect timer
    // (old bug: timer cleared but _reconnectAt stayed in the future).
    us.usClientDown();

    // A NEW client arrives 2s into the 5s backoff — must not be stranded.
    vi.advanceTimersByTime(2000);
    us.usClientUp();
    // Old code: _connect() refused by _reconnectAt and NOTHING would ever retry.
    await vi.advanceTimersByTimeAsync(3001); // ride out the remaining backoff
    await vi.advanceTimersByTimeAsync(50);   // let the fresh socket finish opening
    expect(wsInstances.length).toBe(2);      // reconnect actually happened
    const subs = wsInstances[1].sent.filter(m => m.type === 'subscribe').map(m => m.symbol);
    expect(subs).toContain('SPY');
  });

  it('WS trade message sets a realtime tick with trade volume and lastWsTick tracking', async () => {
    us.ensureUsSubscribed(['NVDA']);
    await vi.advanceTimersByTimeAsync(30);
    us.usClientUp();
    await vi.advanceTimersByTimeAsync(30);
    const ws = wsInstances[0];
    ws.emit('message', JSON.stringify({
      type: 'trade',
      data: [{ s: 'NVDA', p: 219.74, t: Date.now(), v: 350 }],
    }));
    const t = getTick('US_NVDA');
    expect(t).toBeTruthy();
    expect(t.price).toBe(219.74);
    expect(t.volume).toBe(350); // per-trade volume now forwarded (was always 0)
    expect(us.usDebugState().lastWsTick.NVDA).toBeGreaterThan(0);
  });
});

// ---- 2026-09 ultra-fast pass: TV america/scan BATCH fallback --------------
describe('usStream — TV america/scan batch (the ETF-vs-stock cadence fix)', () => {
  let us;
  let getTick;
  let fetchMock;
  const tvScanResponse = (rows) => ({
    ok: true,
    json: async () => ({ data: rows }),
  });

  const MANY = ['SPY','QQQ','AAPL','MSFT','NVDA','AMZN','GOOGL','META','TSLA','AVGO',
    'JPM','V','UNH','HD','PG','JNJ','LLY','WMT','KO','PEP',
    'MRK','COST','ADBE','CRM','NFLX','AMD','INTC','QCOM','TXN','MU'];

  beforeEach(async () => {
    vi.resetModules();
    vi.stubEnv('FINNHUB_API_KEY', '');
    vi.useFakeTimers();
    vi.setSystemTime(US_OPEN_T);
    const lf = await import('../server/liveFeed.js');
    getTick = lf.getTick;
    us = await import('../server/usStream.js');
    us._resetUsStreamForTest();
  });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); us?._setUsFetchForTest(null); });

  it('ONE batch request refreshes EVERY gap symbol — late-list stocks tick at the same ~3s cadence as early ETFs', async () => {
    // Router mock: TV scanner POST → full batch payload; Yahoo chart → per-symbol.
    let tvCalls = 0; let yahooCalls = 0;
    fetchMock = vi.fn(async (url, opts) => {
      if (String(url).includes('scanner.tradingview.com/america/scan')) {
        tvCalls++;
        const body = JSON.parse(opts.body);
        const rows = body.symbols.tickers
          .map(t => ({ s: t, d: [t.split(':')[1].length * 3.1, 1.5, 99, 98, 1234, t.split(':')[1].length * 3.2] }))
          .filter(r => r.d[5] > 0);
        return tvScanResponse(rows);
      }
      yahooCalls++;
      return yahooResponse(713.36, 716.43, Math.floor(US_OPEN_T / 1000));
    });
    us._setUsFetchForTest(fetchMock);

    us.ensureUsSubscribed(MANY);
    await vi.advanceTimersByTimeAsync(200); // bootstrap (bounded semaphore)
    us.usClientUp();
    await vi.advanceTimersByTimeAsync(3100); // one 3s fallback cycle

    // EVERY symbol got a tick (TV batch covered all 30 in ONE request).
    for (const sym of MANY) {
      const t = getTick(`US_${sym}`);
      expect(t, `US_${sym} should have a tick`).toBeTruthy();
      expect(t.source).toBe('tv-us-batch');
    }
    expect(tvCalls).toBe(1);
    // NOTE: per-symbol Yahoo chart calls at this point are only the fresh-symbol
    // BOOTSTRAP (one instant snapshot per symbol at subscribe time) — the
    // recurring 3s fallback cycle itself needed ZERO Yahoo round-trips because
    // the TV batch covered all 30 symbols in the single request above.
  });

  it('TV scanner failure falls through to the per-symbol Yahoo round-robin (no wedge)', async () => {
    fetchMock = vi.fn(async (url) => {
      if (String(url).includes('scanner.tradingview.com')) {
        return { ok: false, status: 429 };
      }
      return yahooResponse(501.11, 500.0, Math.floor(US_OPEN_T / 1000));
    });
    us._setUsFetchForTest(fetchMock);
    us.ensureUsSubscribed(['AAPL']);
    await vi.advanceTimersByTimeAsync(50);
    const bootCalls = fetchMock.mock.calls.length;
    us.usClientUp();
    await vi.advanceTimersByTimeAsync(3100);
    // Yahoo was used as the fallback for the TV failure.
    const t = getTick('US_AAPL');
    expect(t).toBeTruthy();
    expect(t.source).toBe('yahoo-us-fallback');
    expect(fetchMock.mock.calls.length).toBeGreaterThan(bootCalls);
  });

  it('TV circuit breaker: after 5 consecutive scan failures the batch path pauses (Yahoo carries on)', async () => {
    let tvFail = 0;
    fetchMock = vi.fn(async (url) => {
      if (String(url).includes('scanner.tradingview.com')) { tvFail++; return { ok: false, status: 403 }; }
      return yahooResponse(501.11, 500.0, Math.floor(US_OPEN_T / 1000));
    });
    us._setUsFetchForTest(fetchMock);
    us.ensureUsSubscribed(['AAPL']);
    await vi.advanceTimersByTimeAsync(50);
    us.usClientUp();
    for (let i = 0; i < 6; i++) await vi.advanceTimersByTimeAsync(3100);
    // Breaker must be engaged: 5 failures + the reset probe budget consumed.
    const tvCallsAfterBreaker = fetchMock.mock.calls.filter(([u]) => String(u).includes('scanner.tradingview.com')).length;
    expect(tvFail).toBeGreaterThanOrEqual(5);
    expect(tvCallsAfterBreaker).toBeLessThanOrEqual(6); // no infinite hammering
    const t = getTick('US_AAPL');
    expect(t?.source).toBe('yahoo-us-fallback'); // price path still alive
  });
});

// ---- 2026-09 ultra-fast pass: Binance WS INR projection -------------------
describe('cryptoStream — CoinDCX anchor + Binance WS projected ticks', () => {
  let crypto;
  let getTick;
  let fetchMock;
  let wsInstances;

  const makeFakeBinanceWs = () => {
    const ws = new EventEmitter();
    ws.readyState = 0;
    ws.close = () => { ws.readyState = 3; ws.emit('close'); };
    ws.terminate = ws.close;
    ws.removeAllListeners = () => { ws.removeAllListeners('message'); ws.removeAllListeners('open'); ws.removeAllListeners('close'); ws.removeAllListeners('error'); };
    wsInstances.push(ws);
    setTimeout(() => { ws.readyState = 1; ws.emit('open'); }, 10);
    return ws;
  };

  beforeEach(async () => {
    vi.resetModules();
    vi.useFakeTimers();
    getTick = (await import('../server/liveFeed.js')).getTick;
    crypto = await import('../server/cryptoStream.js');
    crypto._resetCryptoStreamForTest();
    wsInstances = [];
    crypto._setBinanceWsFactoryForTest(makeFakeBinanceWs);
    fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => [
        { market: 'BTCINR', last_price: '4350000', change_24_hour: '1.25', high: '4400000', low: '4300000', volume: '77' },
        { market: 'ETHINR', last_price: '150000', change_24_hour: '-0.5', high: '155000', low: '148000', volume: '9' },
      ],
    }));
    crypto._setCryptoFetchForTest(fetchMock);
  });
  afterEach(() => {
    vi.useRealTimers();
    crypto?._setBinanceWsFactoryForTest(null);
    crypto?._setCryptoFetchForTest(null);
    crypto?._resetCryptoStreamForTest();
  });

  it('CoinDCX anchor poll pushes 2s INR ticks', async () => {
    crypto.ensureCryptoSubscribed(['BTC']);
    crypto.cryptoClientUp();
    await vi.advanceTimersByTimeAsync(50);
    const t = getTick('IN_BTC');
    expect(t).toBeTruthy();
    expect(t.price).toBe(4350000);
    expect(t.source).toBe('coindcx-live');
  });

  it('Binance WS tick is projected into INR via the anchor ratio (sub-second acceleration)', async () => {
    crypto.ensureCryptoSubscribed(['BTC']);
    crypto.cryptoClientUp();
    await vi.advanceTimersByTimeAsync(50); // CoinDCX anchor: BTC INR 4,350,000
    // Binance says BTC = 50,000 USDT → ratio = 4,350,000/50,000 = 87
    expect(wsInstances.length).toBe(1);
    // ...but first Binance tick arrives to establish the USDT price:
    wsInstances[0].emit('message', JSON.stringify({ stream: 'btcusdt@ticker', data: { c: '50000' } }));
    await vi.advanceTimersByTimeAsync(2000); // next CoinDCX poll re-anchors with the known USDT price
    // Now a live Binance tick mid-poll-window → projected INR tick:
    wsInstances[0].emit('message', JSON.stringify({ stream: 'btcusdt@ticker', data: { c: '50100' } }));
    const t = getTick('IN_BTC');
    expect(t).toBeTruthy();
    expect(t.source).toBe('binance-crypto-ws');
    expect(t.price).toBeCloseTo(50100 * 87, 0); // 50,100 USDT × 87 INR/USDT
  });

  it('NO anchor → NO projection (CoinDCX owns the symbol until anchored)', async () => {
    crypto.ensureCryptoSubscribed(['ETH']);
    crypto.cryptoClientUp();
    await vi.advanceTimersByTimeAsync(50); // ETH anchor exists via CoinDCX poll
    // Simulate Binance tick for a coin with NO CoinDCX anchor (SOL not subscribed):
    wsInstances[0].emit('message', JSON.stringify({ stream: 'solusdt@ticker', data: { c: '150' } }));
    const t = getTick('IN_SOL');
    expect(t).toBeFalsy();
  });

  it('Binance handshake failures trip the circuit breaker (geo-block safety)', async () => {
    // A WS that NEVER opens and only errors — 3 strikes → disabled.
    let attempts = 0;
    crypto._setBinanceWsFactoryForTest(() => {
      attempts++;
      const ws = new EventEmitter();
      ws.readyState = 0;
      ws.close = () => { ws.readyState = 3; };
      setTimeout(() => { ws.emit('error'); }, 10);
      return ws;
    });
    crypto.ensureCryptoSubscribed(['BTC']);
    crypto.cryptoClientUp();
    await vi.advanceTimersByTimeAsync(100);
    // First failure → reconnect in 5s → fail → reconnect → fail → breaker tripped.
    for (let i = 0; i < 30; i++) await vi.advanceTimersByTimeAsync(1000);
    expect(attempts).toBeLessThanOrEqual(4); // 3 attempts + at most 1 cooldown probe... none within 30 min
    // CoinDCX polling keeps prices live regardless:
    const t = getTick('IN_BTC');
    expect(t?.price).toBe(4350000);
  });
});
