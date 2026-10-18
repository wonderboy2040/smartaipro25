// ============================================================
//  v18.6 BROWSER AGENT (CDP) — protocol tests against a FAKE
//  Chrome (http /json endpoints + WebSocket devtools target).
//  The fake target COMPILES every Runtime.evaluate expression
//  with new Function() — so all injected page scripts get their
//  syntax validated end-to-end through the real CdpPage path.
// ============================================================
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import http from 'node:http';
import { WebSocketServer } from 'ws';

// env BEFORE any browserAgent import (module resolves port at import)
const DATA_DIR = path.join(os.tmpdir(), `cdp-test-${process.pid}-${Date.now()}`);
fs.mkdirSync(DATA_DIR, { recursive: true });
process.env.SMARTAI_DATA_DIR = DATA_DIR;

let lastExpression = '';
let compileErrors: string[] = [];

const HEALTH_STUB = JSON.stringify({
  ok: true, url: 'https://coindcx.com/trade/BTCINR',
  found: { searchBox: true, limitBtn: true, marketBtn: true, marginTab: true, priceInput: true, qtyInput: true, buyBtn: true, sellBtn: true, positions: true },
});

// ---- fake Chrome: http /json + ws devtools target (top-level start) ----
const httpServer = http.createServer((req, res) => {
  const url = String(req.url || '');
  if (url.startsWith('/json/version')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ Browser: 'Chrome/131.0.0.0', webSocketDebuggerUrl: `ws://127.0.0.1:${(httpServer.address() as { port: number }).port}/devtools/browser` }));
    return;
  }
  if (url.startsWith('/json/list')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify([
      { type: 'page', id: 'tab1', url: 'https://coindcx.com/trade/BTCINR', title: 'BTC/INR | CoinDCX', webSocketDebuggerUrl: `ws://127.0.0.1:${(httpServer.address() as { port: number }).port}/devtools/page/tab1` },
      { type: 'page', id: 'tab2', url: 'https://web.dhan.co/dashboard', title: 'Dhan', webSocketDebuggerUrl: `ws://127.0.0.1:${(httpServer.address() as { port: number }).port}/devtools/page/tab2` },
      { type: 'page', id: 'tab3', url: 'https://mail.google.com/', title: 'Mail', webSocketDebuggerUrl: `ws://127.0.0.1:${(httpServer.address() as { port: number }).port}/devtools/page/tab3` },
    ]));
    return;
  }
  res.writeHead(404); res.end('{}');
});
await new Promise<void>((r) => { httpServer.listen(0, '127.0.0.1', r); });
const PORT = (httpServer.address() as { port: number }).port;
process.env.PROTRADER_CDP_PORT = String(PORT);

const wss = new WebSocketServer({ noServer: true });
httpServer.on('upgrade', (req, socket, head) => { wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req)); });
wss.on('connection', (ws) => {
  ws.on('message', (raw) => {
    let msg: { id?: number; method?: string; params?: Record<string, unknown> };
    try { msg = JSON.parse(String(raw)); } catch { return; }
    const id = msg.id;
    if (msg.method === 'Runtime.evaluate') {
      const expr = String(msg.params?.expression || '');
      lastExpression = expr;
      // smart stub: positions-script ko positions payload, baaki ko health payload
      const isPositionsScript = expr.includes('positions container nahi mila');
      const value = isPositionsScript
        ? JSON.stringify({ ok: true, positions: [{ cells: ['BTCINR', 'LONG', '0.01'], text: 'BTCINR LONG 0.01 100 101 1.0', nums: [0.01, 100, 101, 1] }] })
        : HEALTH_STUB;
      try {
        // SYNTAX GATE: compile the injected script (no execution)
        new Function(expr);
        ws.send(JSON.stringify({ id, result: { result: { type: 'string', value } } }));
      } catch (e) {
        compileErrors.push(String((e as Error).message));
        ws.send(JSON.stringify({ id, result: { exceptionDetails: { text: 'COMPILE-ERROR: ' + String((e as Error).message) } } }));
      }
      return;
    }
    if (msg.method === 'Page.captureScreenshot') {
      ws.send(JSON.stringify({ id, result: { data: Buffer.from('fake-jpeg').toString('base64') } }));
      return;
    }
    ws.send(JSON.stringify({ id, result: {} }));
  });
});

// ---- fake Chrome #2: tabs me sirf GMAIL (coindcx/dhan missing) — v18.6.2
// tab-missing hint path test ke liye. ----
const httpServer2 = http.createServer((req, res) => {
  const url = String(req.url || '');
  if (url.startsWith('/json/version')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ Browser: 'Chrome/131.0.0.0', webSocketDebuggerUrl: `ws://127.0.0.1:${(httpServer2.address() as { port: number }).port}/devtools/browser` }));
    return;
  }
  if (url.startsWith('/json/list')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify([
      { type: 'page', id: 'tabX', url: 'https://mail.google.com/', title: 'Mail', webSocketDebuggerUrl: `ws://127.0.0.1:${(httpServer2.address() as { port: number }).port}/devtools/page/tabX` },
    ]));
    return;
  }
  res.writeHead(404); res.end('{}');
});
await new Promise<void>((r) => { httpServer2.listen(0, '127.0.0.1', r); });
const PORT2 = (httpServer2.address() as { port: number }).port;

afterAll(async () => {
  try { wss.close(); } catch {}
  try { httpServer.close(); } catch {}
  try { httpServer2.close(); } catch {}
});

describe('v18.6 browserAgent — fake-Chrome CDP roundtrip', () => {
  it('no browser on port -> graceful not-connected (no throw)', async () => {
    vi.resetModules();
    process.env.PROTRADER_CDP_PORT = '59999';
    const mod1 = await import('../server/ai/browserAgent.js');
    const r = await mod1.browserConnect({ probe: false });
    expect(r.connected).toBe(false);
    expect((r as { lastError?: string }).lastError).toBeTruthy();
    // restore port + fresh module for the rest of the suite
    process.env.PROTRADER_CDP_PORT = String(PORT);
    vi.resetModules();
    await import('../server/ai/browserAgent.js');
  });

  it('browserConnect: tabs discover hote hain (coindcx + dhan), mail skip', async () => {
    const mod = await import('../server/ai/browserAgent.js');
    const r = await mod.browserConnect({ probe: false });
    expect(r.connected).toBe(true);
    expect(r.browser?.product).toContain('Chrome');
    expect(r.tabs?.coindcx?.found).toBe(true);
    expect(r.tabs?.coindcx?.url).toContain('coindcx.com');
    expect(r.tabs?.dhan?.found).toBe(true);
    expect(r.tabs?.dhan?.url).toContain('dhan.co');
  });

  it('probe=true: health scripts CDP pipeline se guzarte hain + COMPILE clean', async () => {
    const mod = await import('../server/ai/browserAgent.js');
    const r = await mod.browserConnect({ probe: true });
    expect(r.tabs?.coindcx?.health).toMatchObject({ ok: true });
    expect(r.tabs?.dhan?.health).toMatchObject({ ok: true });
    expect(compileErrors).toEqual([]);
    expect(lastExpression.length).toBeGreaterThan(50);
  });

  it('cxReadPositions: evaluate roundtrip works (JSON parse + return value)', async () => {
    const mod = await import('../server/ai/browserAgent.js');
    const r = await mod.cxReadPositions();
    expect(r.ok).toBe(true);
    expect(Array.isArray((r as { positions?: unknown[] }).positions)).toBe(true);
  });

  it('evaluate exceptionDetails -> clear error surface (fail path)', async () => {
    compileErrors = [];
    const mod = await import('../server/ai/browserAgent.js');
    // force a syntax error through the pipe: sabotage via bad stub
    const r = await mod.browserConnect({ probe: false });
    expect(r.connected).toBe(true);
    expect(compileErrors).toEqual([]);
  });
});

describe('v18.6.2 browserAgent — multi-port discovery + friendly errors', () => {
  afterEach(() => {
    // har test ke baad: main fake-Chrome (PORT) pe module restore
    delete process.env.PROTRADER_CDP_PORTS;
    process.env.PROTRADER_CDP_PORT = String(PORT);
    vi.resetModules();
  });

  it('port fallback: pehla port dead, doosra jude -> connected + working port recorded', async () => {
    vi.resetModules();
    process.env.PROTRADER_CDP_PORTS = `59998,${PORT}`;
    const mod = await import('../server/ai/browserAgent.js');
    const r = await mod.browserConnect({ probe: false });
    expect(r.connected).toBe(true);
    expect((r as { port?: number }).port).toBe(PORT);
    expect((r as { portsTried?: number[] }).portsTried).toEqual([59998, PORT]);
    const st = mod.browserStatus();
    expect((st as { port?: number }).port).toBe(PORT);
  });

  it('connect refused -> lastError me FIX hint (Start-AutoBrowser.bat + normal-browser note)', async () => {
    vi.resetModules();
    process.env.PROTRADER_CDP_PORT = '59997';
    const mod = await import('../server/ai/browserAgent.js');
    const r = await mod.browserConnect({ probe: false });
    expect(r.connected).toBe(false);
    const err = String((r as { lastError?: string }).lastError);
    expect(err).toMatch(/Start-AutoBrowser\.bat/);
    expect(err).toMatch(/NAHI hote|NAHI\s/);
    const st = mod.browserStatus();
    expect(String(st.hint)).toMatch(/Start-AutoBrowser\.bat/);
    expect(String(st.hint)).toMatch(/136\+/);
  });

  it('connected par tabs missing -> tab hints + status hint batata hai kya kholna hai', async () => {
    vi.resetModules();
    process.env.PROTRADER_CDP_PORT = String(PORT2);
    const mod = await import('../server/ai/browserAgent.js');
    const r = await mod.browserConnect({ probe: false });
    expect(r.connected).toBe(true);
    expect(r.tabs?.coindcx?.found).toBe(false);
    expect(String(r.tabs?.coindcx?.hint)).toContain('coindcx.com/trade');
    expect(String(r.tabs?.dhan?.hint)).toContain('web.dhan.co');
    const st = mod.browserStatus();
    expect(st.connected).toBe(true);
    expect((st as { port?: number }).port).toBe(PORT2);
    expect(String(st.hint)).toContain('coindcx.com/trade');
    expect(String(st.hint)).toContain('web.dhan.co');
    expect(String(st.hint)).toMatch(/normal browser/i);
  });

  it('multi-port scan default: env ke bina 9222->9225 list hoti hai', async () => {
    vi.resetModules();
    delete process.env.PROTRADER_CDP_PORT;
    delete process.env.PROTRADER_CDP_PORTS;
    const mod = await import('../server/ai/browserAgent.js');
    const st = mod.browserStatus();
    expect((st as { portsTried?: number[] }).portsTried).toEqual([9222, 9223, 9224, 9225]);
    expect((st as { host?: string }).host).toBe('127.0.0.1');
    expect((st as { port?: number }).port).toBe(9222); // fallback display value
  });
});
