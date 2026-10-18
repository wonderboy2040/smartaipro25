// ============================================================
// test/cxSpotWs.test.ts — v11.3 CoinDCX OFFICIAL SPOT WEBSOCKET
// ------------------------------------------------------------
// LIVE-VERIFIED CONTRACT (2026-09-17, wss://stream-spot.coindcx.com):
//   • EIO=4 handshake: server '0{json}' → client '40' → '40{sid}' ack
//   • channels  : "currentPrices@spot@1s" + "priceStats@spot@60s"
//   • events    : currentPrices@spot#update|#snapshot — payload.data is
//                 a JSON-encoded STRING: {pr:"SPOT", prices:{BTCINR:…}}
//                 priceStats@spot#update|#snapshot — {stats:{BTCINR:{pc,v,ts}}}
//   • liveness  : server '2' → client '3'; app-level ping every 25s
//   • a client-sent '2' KILLS the socket (verified live) — the client
//     must never ping proactively (cxSocketIo owns this)
//
// Locked here: protocol framing, book merge (string payloads), the
// CoinDCX-ticker-shaped synth array, demand lifecycle, handshake
// breaker, and idle close. Hermetic — the ws is a fake double.
// ============================================================
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  spotWsDemand, spotWsPrice, spotWsStatus, spotWsTickerArray,
  _setSpotWsFactoryForTest, _setSpotWsEnabledForTest, _resetSpotWsForTest, _setSpotWsNowForTest,
} from '../server/ai/cxSpotWs.js';

/** A faithful stream-spot.coindcx.com double (EIO=4 text frames). */
class FakeSpotWs {
  readyState = 1; // WebSocket.OPEN
  url: string;
  sent: string[] = [];
  closed = false;
  private listeners = new Map<string, Array<(arg?: unknown) => void>>();
  constructor(url: string) {
    this.url = url;
    setTimeout(() => {
      if (!this.closed) {
        this._emit('open');
        this._emit('message', '0{"sid":"srv","pingInterval":45000,"pingTimeout":60000,"maxPayload":1000000}');
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
    if (frame === '40') this._emit('message', '40{"sid":"test-sid"}');
  }
  close() { if (!this.closed) { this.closed = true; this._emit('close'); } }
  terminate() { this.close(); }
  private _emit(ev: string, arg?: unknown) {
    for (const fn of [...(this.listeners.get(ev) || [])]) fn(arg);
  }
  serverMessage(frame: string) { if (!this.closed) this._emit('message', frame); }
  drop() { this.readyState = 3; this.close(); }
}

/** currentPrices@spot#update frame — data is a JSON-encoded STRING. */
const priceFrame = (prices: Record<string, number>) =>
  `42["currentPrices@spot#update",${JSON.stringify({ event: 'currentPrices@spot#update', data: JSON.stringify({ pr: 'SPOT', prices }) })}]`;
const priceSnapshot = (prices: Record<string, number>) =>
  `42["currentPrices@spot#snapshot",${JSON.stringify({ event: 'currentPrices@spot#snapshot', data: JSON.stringify({ pr: 'SPOT', prices }) })}]`;
const statsFrame = (stats: Record<string, { pc: number; v: number }>) =>
  `42["priceStats@spot#update",${JSON.stringify({ event: 'priceStats@spot#update', data: JSON.stringify({ pr: 'SPOT', stats }) })}]`;

const MANY_MARKETS: Record<string, number> = {};
for (let i = 0; i < 30; i++) MANY_MARKETS[`C${i}INR`] = 100 + i;

describe('cxSpotWs — CoinDCX official spot socket (v11.3)', () => {
  let sockets: FakeSpotWs[];

  beforeEach(() => {
    _resetSpotWsForTest();
    _setSpotWsEnabledForTest(true);
    sockets = [];
    _setSpotWsFactoryForTest((url: string) => {
      const s = new FakeSpotWs(url);
      sockets.push(s);
      return s;
    });
  });
  afterEach(() => {
    _setSpotWsFactoryForTest(null);
    _setSpotWsNowForTest(null);
    _resetSpotWsForTest();
  });

  it('EIO=4 handshake + joins the book channels (currentPrices@spot@1s + priceStats@spot@60s)', async () => {
    spotWsDemand();
    await vi.waitFor(() => expect(sockets.length).toBe(1));
    const sock = sockets[0];
    await vi.waitFor(() => expect(sock.sent.filter(f => f.startsWith('42["join"'))).toHaveLength(2));
    expect(sock.sent.find(f => f === '40')).toBeTruthy();
    expect(sock.sent.some(f => f.startsWith('42["join"') && f.includes('currentPrices@spot@1s'))).toBe(true);
    expect(sock.sent.some(f => f.startsWith('42["join"') && f.includes('priceStats@spot@60s'))).toBe(true);
    expect(sock.url).toContain('stream-spot.coindcx.com');
    expect(sock.url).toContain('EIO=4');
  });

  it('the client NEVER sends a proactive engine.io ping (a client "2" kills the live socket)', async () => {
    vi.useFakeTimers();
    try {
      spotWsDemand();
      await vi.advanceTimersByTimeAsync(50); // open + handshake + joins
      const sock = sockets[0];
      expect(sock.sent.filter(f => f.startsWith('42["join"'))).toHaveLength(2);
      // no bare '2' ping ever leaves the client
      expect(sock.sent.filter(f => f === '2')).toHaveLength(0);
      // the app-level keepalive IS the documented emit form (fires @25s)
      await vi.advanceTimersByTimeAsync(25_500);
      expect(sock.sent.some(f => f === '42["ping",{"data":"Ping message"}]')).toBe(true);
      expect(sock.sent.filter(f => f === '2')).toHaveLength(0); // still never a raw engine ping
    } finally {
      vi.useRealTimers();
    }
  });

  it('book update (data-as-STRING payload) merges into the price book + synth ticker array is CoinDCX-shaped', async () => {
    spotWsDemand();
    await vi.waitFor(() => expect(sockets.length).toBe(1));
    const sock = sockets[0];
    await vi.waitFor(() => expect(sock.sent.filter(f => f.startsWith('42["join"'))).toHaveLength(2));

    sock.serverMessage(priceFrame({ BTCINR: 6123456.5, ETHINR: 150987.25, BTCUSDT: 76421.4 }));
    sock.serverMessage(statsFrame({ BTCINR: { pc: 1.25, v: 77.5 }, ETHINR: { pc: -0.5, v: 9.1 } }));

    expect(spotWsPrice('BTCINR')).toBe(6123456.5);
    expect(spotWsPrice('ETHINR')).toBe(150987.25);
    expect(spotWsPrice('BTCUSDT')).toBe(76421.4);
    expect(spotWsPrice('SOLINR')).toBeNull(); // not in the book

    const arr = spotWsTickerArray();
    expect(arr.length).toBe(3);
    const btc = arr.find(t => t.market === 'BTCINR')!;
    expect(btc.last_price).toBe('6123456.5');       // string — repo-wide parseFloat consumers
    expect(btc.change_24_hour).toBe('1.25');
    expect(btc.volume).toBe('77.5');
    expect(btc.feed).toBe('coindcx-spot-ws');       // honest source label
    // USDT rows ride along (same official book — usable downstream)
    expect(arr.find(t => t.market === 'BTCUSDT')!.last_price).toBe('76421.4');
    const status = spotWsStatus();
    expect(status.markets).toBe(3);
    expect(status.servable).toBe(false);            // 3 < 25 — too thin to back the REST chain
  });

  it('#snapshot events merge too (the full book arrives on join)', async () => {
    spotWsDemand();
    await vi.waitFor(() => expect(sockets.length).toBe(1));
    const sock = sockets[0];
    await vi.waitFor(() => expect(sock.sent.filter(f => f.startsWith('42["join"'))).toHaveLength(2));
    sock.serverMessage(priceSnapshot(MANY_MARKETS));
    const status = spotWsStatus();
    expect(status.markets).toBe(30);
    expect(status.servable).toBe(true);             // ≥25 fresh — CAN back the REST chain
    expect(spotWsTickerArray().length).toBe(30);
  });

  it('server "2" ping is answered with "3" (Engine.IO liveness)', async () => {
    spotWsDemand();
    await vi.waitFor(() => expect(sockets.length).toBe(1));
    const sock = sockets[0];
    await vi.waitFor(() => expect(sock.sent.filter(f => f.startsWith('42["join"'))).toHaveLength(2));
    sock.serverMessage('2');
    expect(sock.sent.filter(f => f === '3').length).toBe(1);
  });

  it('handshake fail-streak trips the 30-min breaker', async () => {
    // a socket whose handshake NEVER completes (dropped before the
    // Engine.IO open) — the geo-block / auth-reject production case
    class DeadHandshakeWs {
      readyState = 0; // CONNECTING forever
      url = 'x';
      sent: string[] = [];
      closed = false;
      private listeners = new Map<string, Array<(arg?: unknown) => void>>();
      constructor() {
        setTimeout(() => { this.closed = true; this._emit('close'); }, 0);
      }
      on(ev: string, fn: (arg?: unknown) => void) {
        if (!this.listeners.has(ev)) this.listeners.set(ev, []);
        this.listeners.get(ev)!.push(fn);
      }
      removeAllListeners() { this.listeners.clear(); }
      send() {}
      close() { if (!this.closed) { this.closed = true; this._emit('close'); } }
      terminate() { this.close(); }
      private _emit(ev: string) {
        for (const fn of [...(this.listeners.get(ev) || [])]) fn(undefined);
      }
    }
    _setSpotWsFactoryForTest(() => {
      const s = new DeadHandshakeWs() as unknown as FakeSpotWs;
      sockets.push(s);
      return s;
    });
    vi.useFakeTimers();
    try {
      // 3 consecutive handshake failures (3s → 6s → 12s backoffs) trip
      // the breaker; iterate until it's armed or the safety cap hits.
      for (let i = 0; i < 6 && !spotWsStatus().cooling; i++) {
        spotWsDemand();
        await vi.advanceTimersByTimeAsync(15_000);
      }
      expect(spotWsStatus().cooling).toBe(true);
      // demand within the cooldown opens NOTHING
      const before = sockets.length;
      spotWsDemand();
      await vi.advanceTimersByTimeAsync(50);
      expect(sockets.length).toBe(before);
      // cooldown expires → demand re-opens the socket
      await vi.advanceTimersByTimeAsync(30 * 60_000 + 1_000);
      spotWsDemand();
      await vi.advanceTimersByTimeAsync(50);
      expect(sockets.length).toBe(before + 1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('idle: no demand for 2+ min → socket closes; fresh demand reconnects', async () => {
    vi.useFakeTimers();
    try {
      spotWsDemand();
      await vi.advanceTimersByTimeAsync(50);
      const sock = sockets[0];
      expect(sock.sent.filter(f => f.startsWith('42["join"'))).toHaveLength(2);
      expect(sock.closed).toBe(false);
      // 2 min + grace with NO demand → idle watchdog closes the socket
      await vi.advanceTimersByTimeAsync(130_000);
      expect(sock.closed).toBe(true);
      // demand returns → a fresh socket opens
      spotWsDemand();
      await vi.advanceTimersByTimeAsync(50);
      expect(sockets.length).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
