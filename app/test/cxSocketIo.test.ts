// ============================================================
// test/cxSocketIo.test.ts — v10.11 the Engine.IO 3 (Socket.IO v2)
// framing client, isolated from the stream lifecycle.
//
// THE CONTRACT (locked here):
//   • EIO=3 wire discipline: on ws-open the client sends '40'; the
//     server's '40{sid}' ack fires onOpen; events arrive as
//     '42["name",payload]' and are decoded losslessly.
//   • Engine.IO keepalive: server ping '2' → client pong '3'.
//   • join/leave frames are exact: 42["join",{"channelName":…}].
//   • Channels queued BEFORE the ns-ack are replayed on connect
//     (CoinDCX channels do not survive reconnects).
//   • close() removes listeners (no late 'close' callback — the
//     deliberate-close path must NOT trigger the owner's reconnect).
//   • A remote drop fires onClose(wasNs=true); a never-connected
//     socket fires onClose(wasNs=false) (handshake failure → streak).
// ============================================================
import { describe, it, expect, vi } from 'vitest';
import { createCxSocketIo } from '../server/ai/cxSocketIo.js';

class FakeWs {
  readyState = 1;
  sent: string[] = [];
  closed = false;
  closeCalls = 0;
  terminated = false;
  private listeners = new Map<string, Array<(arg?: unknown) => void>>();
  constructor(public url: string) {}
  on(ev: string, fn: (arg?: unknown) => void) {
    if (!this.listeners.has(ev)) this.listeners.set(ev, []);
    this.listeners.get(ev)!.push(fn);
  }
  removeAllListeners() { this.listeners.clear(); }
  send(frame: string) { if (!this.closed) this.sent.push(frame); }
  close() { this.closeCalls += 1; this.closed = true; this._emit('close'); }
  terminate() { this.terminated = true; this.close(); }
  _emit(ev: string, arg?: unknown) { for (const fn of [...(this.listeners.get(ev) || [])]) fn(arg); }
  // test controls
  simulateOpen() {
    this._emit('open');
    // the real Engine.IO 3 server's FIRST frame after the ws open IS the
    // '0{…}' handshake — the client's '40' goes out only after it
    this._emit('message', '0{"sid":"srv","upgrades":[],"pingInterval":25000,"pingTimeout":60000}');
  }
  simulateMessage(frame: string) { this._emit('message', frame); }
  simulateDrop() { this._emit('close'); }
  simulateOpenSilent() { this._emit('open'); } // socket up, server never sends '0'
}

function makeIo(overrides: Record<string, unknown> = {}) {
  const ws = new FakeWs('wss://stream.coindcx.com/socket.io/?EIO=3&transport=websocket');
  const io = createCxSocketIo({
    url: ws.url,
    wsFactory: () => ws,
    onEvent: vi.fn(),
    onOpen: vi.fn(),
    onClose: vi.fn(),
    ...overrides,
  });
  return { io, ws };
}

describe('cxSocketIo — EIO=3 handshake + framing', () => {
  it('ws-open → sends 40 → server 40{sid} ack → onOpen fires once', () => {
    const onOpen = vi.fn();
    const { io, ws } = makeIo({ onOpen });
    io.connect();
    expect(ws.sent).toEqual([]);
    ws.simulateOpen();
    expect(ws.sent).toEqual(['40']); // the Socket.IO v2 namespace connect
    ws.simulateMessage('40{"sid":"abc"}');
    expect(onOpen).toHaveBeenCalledTimes(1); // fired for the ns-ack, not the ws-open
    expect(io.state().connected).toBe(true);
  });

  it('decodes 42["event",payload] frames losslessly', () => {
    const onEvent = vi.fn();
    const { io, ws } = makeIo({ onEvent });
    io.connect();
    ws.simulateOpen();
    ws.simulateMessage('40{"sid":"abc"}');
    ws.simulateMessage('42["price-change",{"channelName":"B-BTC_USDT@prices-futures","data":{"p":"61000.5"}}]');
    expect(onEvent).toHaveBeenCalledWith('price-change', {
      channelName: 'B-BTC_USDT@prices-futures',
      data: { p: '61000.5' },
    });
    // malformed frames are swallowed (never throw into the socket layer)
    ws.simulateMessage('42[not-json');
    ws.simulateMessage('9999');
    expect(onEvent).toHaveBeenCalledTimes(1);
  });

  it('engine.io v3 keepalive: server ping 2 → client pong 3', () => {
    const { io, ws } = makeIo();
    io.connect();
    ws.simulateOpen();
    ws.simulateMessage('40{"sid":"abc"}');
    ws.simulateMessage('2');
    ws.simulateMessage('2');
    expect(ws.sent.filter(f => f === '3')).toHaveLength(2);
  });

  it('join/leave frames are EXACT — 42["join",{"channelName":…}]', () => {
    const { io, ws } = makeIo();
    io.connect();
    ws.simulateOpen();
    expect(ws.sent).toEqual(['40']); // the ns-connect fires on the EIO '0' handshake, not the ws-open
    // channels queued BEFORE the ns-ack are held, then replayed on connect
    io.join('B-BTC_USDT@prices-futures');
    io.join('B-AAPL_USDC@prices-futures');
    expect(ws.sent).toEqual(['40']); // nothing leaks before the ack
    ws.simulateMessage('40{"sid":"abc"}');
    expect(ws.sent).toEqual([
      '40',
      '42["join",{"channelName":"B-BTC_USDT@prices-futures"}]',
      '42["join",{"channelName":"B-AAPL_USDC@prices-futures"}]',
    ]);
    io.leave('B-BTC_USDT@prices-futures');
    expect(ws.sent[3]).toBe('42["leave",{"channelName":"B-BTC_USDT@prices-futures"}]');
    expect(io.state().channels).toEqual(['B-AAPL_USDC@prices-futures']);
  });

  it('join on an ALREADY-connected socket sends immediately', () => {
    const { io, ws } = makeIo();
    io.connect();
    ws.simulateOpen();
    ws.simulateMessage('40{"sid":"abc"}');
    io.join('B-ETH_USDT@prices-futures');
    expect(ws.sent).toContain('42["join",{"channelName":"B-ETH_USDT@prices-futures"}]');
  });
});

describe('cxSocketIo — lifecycle honesty', () => {
  it('a REMOTE drop fires onClose(wasNs=true) — a healthy-socket drop is not a handshake failure', () => {
    const onClose = vi.fn();
    const { io, ws } = makeIo({ onClose });
    io.connect();
    ws.simulateOpen();
    ws.simulateMessage('40{"sid":"abc"}');
    ws.simulateDrop();
    expect(onClose).toHaveBeenCalledWith(true);
    expect(io.state().connected).toBe(false);
  });

  it('a NEVER-connected socket drops → onClose(wasNs=false) (handshake failure semantics)', () => {
    const onClose = vi.fn();
    const { io, ws } = makeIo({ onClose });
    io.connect();
    ws.simulateDrop(); // died before any ns-ack
    expect(onClose).toHaveBeenCalledWith(false);
  });

  it('DELIBERATE close(): no late onClose callback (owner reconnect must not fire)', () => {
    const onClose = vi.fn();
    const { io, ws } = makeIo({ onClose });
    io.connect();
    ws.simulateOpen();
    ws.simulateMessage('40{"sid":"abc"}');
    io.close();
    expect(onClose).not.toHaveBeenCalled(); // deliberate ≠ disconnect
    expect(io.state().socket).toBe(false);
    expect(ws.closeCalls).toBe(1);
    // a late remote 'close' after removeAllListeners is swallowed too
    ws.simulateDrop();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('a throwing ws factory → onError + onClose(falsy) — never an unhandled throw', () => {
    const onError = vi.fn();
    const onClose = vi.fn();
    const io = createCxSocketIo({
      url: 'wss://stream.coindcx.com/socket.io/?EIO=3&transport=websocket',
      wsFactory: () => { throw new Error('geo-block'); },
      onError, onClose,
    });
    expect(() => io.connect()).not.toThrow();
    expect(onError).toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledWith(false);
  });

  it("a SILENT handshake (socket open, server never sends the EIO '0' frame) is terminated by the 8s watchdog", () => {
    vi.useFakeTimers();
    try {
      const onClose = vi.fn();
      const { io, ws } = makeIo({ onClose });
      io.connect();
      ws.simulateOpenSilent();       // TCP/TLS up — but no Engine.IO handshake
      expect(ws.sent).toEqual([]);    // the '40' must NOT race ahead of the '0'
      vi.advanceTimersByTime(8_500);  // past the handshake budget
      expect(ws.terminated).toBe(true);       // watchdog cut it
      expect(onClose).toHaveBeenCalledWith(false); // handshake-failure semantics
      expect(io.state().socket).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});
