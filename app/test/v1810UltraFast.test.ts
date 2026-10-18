// ============================================================
// test/v1810UltraFast.test.ts — v18.10 ULTRA-FAST + ENV-CONNECT
// ------------------------------------------------------------
// Locks the three user-facing v18.10 fixes:
//   1. AGENT CYCLE-CRASH — "cycle error: Cannot read properties of
//      null (reading 'riskPct')" fired EVERY 60s cycle because board
//      rows with plan:null ("plan nahi bana") hit an unguarded
//      s.plan.riskPct BEFORE the qualifies() plan gate. The auto-agent
//      was effectively dead. Guard contract + semantic mirror here.
//   2. COINDCX ENV BOOTSTRAP — keys in app\.env (COINDCX_API_KEY +
//      COINDCX_SECRET) auto-connect at boot when nothing is saved:
//      alias resolution, trim, saved-creds-win, never-throws,
//      memoized, index.js wiring.
//   3. DIRECT SPOT-WS ULTRA-FAST PUSH — the official CoinDCX spot
//      socket's price print lands in liveFeed the INSTANT it arrives
//      (source 'coindcx-spot-ws'), no 2s-poller wait; unwatched coins
//      stay silent; the SSE status frame carries the spotWs tier.
// Hermetic — the WS is a fake double, the data dir is temp.
// ============================================================
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// Isolate the store BEFORE any server module loads (repo convention —
// lib/store.js reads SMARTAI_DATA_DIR at module-eval time).
process.env.SMARTAI_DATA_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  `../.test-data-v1810-${Date.now().toString(36)}-${process.pid}`);

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Dynamic imports AFTER the env var is set.
const cxSpotWs = await import('../server/ai/cxSpotWs.js');
const cryptoStream = await import('../server/cryptoStream.js');
const liveFeed = await import('../server/liveFeed.js');
const cxRtStream = await import('../server/ai/cxRtStream.js');
const coindcx = await import('../server/mcp/coindcx.js');

// ---------------- source contracts ----------------
const agentSrc = readFileSync(path.join(repoRoot, 'server/ai/agent.js'), 'utf8');
const indiaSrc = readFileSync(path.join(repoRoot, 'server/ai/indiaAgent.js'), 'utf8');
const indexSrc = readFileSync(path.join(repoRoot, 'server/index.js'), 'utf8');
const cryptoStreamSrc = readFileSync(path.join(repoRoot, 'server/cryptoStream.js'), 'utf8');
const cxRtStreamSrc = readFileSync(path.join(repoRoot, 'server/ai/cxRtStream.js'), 'utf8');

// ---------------- FakeSpotWs double (EIO=4 text frames) ----------------
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
}

const priceFrame = (prices: Record<string, number>) =>
  `42["currentPrices@spot#update",${JSON.stringify({ event: 'currentPrices@spot#update', data: JSON.stringify({ pr: 'SPOT', prices }) })}]`;

// ================================================================
// 1. AGENT CYCLE-CRASH FIX
// ================================================================
describe('v18.10 #1 — agent cycle-crash (plan-null row → riskPct TypeError)', () => {
  it('agent.js: the plan guard sits BEFORE the s.plan.riskPct read (the exact crash line)', () => {
    const guardIdx = agentSrc.indexOf('if (!s?.plan || !s.side) continue;');
    const riskIdx = agentSrc.indexOf('if ((s.plan.riskPct ?? 0) > (trading.maxRiskPct || 5)) continue;');
    expect(guardIdx).toBeGreaterThan(-1);
    expect(riskIdx).toBeGreaterThan(-1);
    // ORDER is the fix — the old code read s.plan.riskPct first.
    expect(guardIdx).toBeLessThan(riskIdx);
    expect(agentSrc).toContain('v18.10 CYCLE-CRASH FIX');
  });

  it('indiaAgent.js: same defensive guard before its riskPct read', () => {
    const guardIdx = indiaSrc.indexOf('if (!s?.plan || !s.side) continue;');
    const riskIdx = indiaSrc.indexOf('if ((s.plan.riskPct ?? 0) > (trading.maxRiskPct || 5)) continue;');
    expect(guardIdx).toBeGreaterThan(-1);
    expect(riskIdx).toBeGreaterThan(guardIdx);
  });

  it('semantic mirror — a plan:null board row is SKIPPED, never crashes the loop', () => {
    // the exact loop shape from agent.js (candidates pass):
    const loop = (signals: Array<Record<string, unknown>>, trading: { maxRiskPct?: number }) => {
      const out: Array<Record<string, unknown>> = [];
      for (const s of signals) {
        if (!s?.plan || !s.side) continue; // v18.10 guard
        if (((s.plan as Record<string, number>).riskPct ?? 0) > (trading.maxRiskPct || 5)) continue;
        out.push(s);
      }
      return out;
    };
    const board = [
      { symbol: 'BTC', side: 'LONG', plan: null },                    // THE user's crash row
      { symbol: 'ETH', side: 'LONG', plan: { riskPct: 2 } },          // normal
      { symbol: 'SOL', side: 'LONG', plan: { riskPct: 9 } },          // over cap → skip
      { symbol: 'XRP', plan: { riskPct: 1 } },                        // no side → skip
      null,                                                            // fully-null row
    ];
    expect(() => loop(board as Array<Record<string, unknown>>, { maxRiskPct: 5 })).not.toThrow();
    expect(loop(board as Array<Record<string, unknown>>, { maxRiskPct: 5 })).toHaveLength(1);
    expect(loop(board as Array<Record<string, unknown>>, { maxRiskPct: 5 })[0].symbol).toBe('ETH');
  });
});

// ================================================================
// 2. COINDCX ENV BOOTSTRAP
// ================================================================
describe('v18.10 #2 — CoinDCX keys in .env auto-connect at boot', () => {
  const ENV_NAMES = ['COINDCX_API_KEY', 'COINDCX_KEY', 'COINDCX_APIKEY', 'COINDCX_PUBLIC_KEY',
    'COINDCX_SECRET', 'COINDCX_API_SECRET', 'COINDCX_SECRET_KEY', 'COINDCX_PRIVATE_KEY'];

  beforeEach(() => {
    for (const n of ENV_NAMES) delete process.env[n];
    (coindcx as any).__resetCoindcxEnvBootForTest();
    (coindcx as any).__setCredsForTests(null, null);
  });
  afterEach(() => {
    for (const n of ENV_NAMES) delete process.env[n];
    (coindcx as any).__resetCoindcxEnvBootForTest();
    (coindcx as any).__setCredsForTests(null, null);
  });

  it('coindcxEnvCreds — canonical names, aliases, and whitespace trim', () => {
    expect((coindcx as any).coindcxEnvCreds()).toBeNull(); // nothing set
    process.env.COINDCX_API_KEY = '  key123 ';
    process.env.COINDCX_SECRET = '  sec456 ';
    expect((coindcx as any).coindcxEnvCreds()).toEqual({ apiKey: 'key123', secret: 'sec456' });
    delete process.env.COINDCX_API_KEY; delete process.env.COINDCX_SECRET;
    // aliases
    process.env.COINDCX_APIKEY = 'k2';
    process.env.COINDCX_API_SECRET = 's2';
    expect((coindcx as any).coindcxEnvCreds()).toEqual({ apiKey: 'k2', secret: 's2' });
    // half-pair → null (the Telegram both-or-none lesson)
    delete process.env.COINDCX_API_SECRET;
    expect((coindcx as any).coindcxEnvCreds()).toBeNull();
  });

  it('bootstrap — env pair validated + persisted via the connector (the user flow)', async () => {
    process.env.COINDCX_API_KEY = 'envKey';
    process.env.COINDCX_SECRET = 'envSec';
    const calls: Array<{ k: string; s: string }> = [];
    const out = await (coindcx as any).coindcxEnvBootstrap(() => {}, {
      connector: async (k: string, s: string) => { calls.push({ k, s }); return { connected: true, balanceCount: 7, validated: true }; },
    });
    expect(calls).toEqual([{ k: 'envKey', s: 'envSec' }]);
    expect(out.ok).toBe(true);
    expect(out.source).toBe('env');
    expect(out.balanceCount).toBe(7);
  });

  it('bootstrap — saved creds WIN over env (UI connect stays authoritative)', async () => {
    (coindcx as any).__setCredsForTests('uiKey', 'uiSecret');
    process.env.COINDCX_API_KEY = 'envKey';
    process.env.COINDCX_SECRET = 'envSec';
    const connector = vi.fn();
    const out = await (coindcx as any).coindcxEnvBootstrap(() => {}, { connector });
    expect(connector).not.toHaveBeenCalled();
    expect(out).toEqual({ ok: true, source: 'already-connected' });
  });

  it('bootstrap — invalid env keys: one result, NEVER throws (no brick)', async () => {
    process.env.COINDCX_API_KEY = 'bad';
    process.env.COINDCX_SECRET = 'pair';
    const out = await (coindcx as any).coindcxEnvBootstrap(() => {}, {
      connector: async () => { throw Object.assign(new Error('401 Unauthorized'), { status: 401 }); },
    });
    expect(out.ok).toBe(false);
    expect(out.source).toBe('env-invalid');
    expect(String(out.error)).toContain('401');
  });

  it('bootstrap — memoized: one attempt per process even when callers race', async () => {
    process.env.COINDCX_API_KEY = 'k';
    process.env.COINDCX_SECRET = 's';
    let n = 0;
    const connector = async () => { n++; return { connected: true, balanceCount: 1, validated: true }; };
    const a = (coindcx as any).coindcxEnvBootstrap(() => {}, { connector });
    const b = (coindcx as any).coindcxEnvBootstrap(() => {}, { connector }); // different connector, same memo
    expect(await a).toBe(await b);
    expect(n).toBe(1);
  });

  it('index.js wires the bootstrap at boot (non-fatal catch)', () => {
    expect(indexSrc).toContain("import { coindcxEnvBootstrap } from './mcp/coindcx.js'");
    expect(indexSrc).toContain('coindcxEnvBootstrap((line) => console.log(line))');
    expect(indexSrc).toMatch(/coindcx-env.*bootstrap failed \(non-fatal\)/s);
  });
});

// ================================================================
// 3. DIRECT SPOT-WS ULTRA-FAST PUSH
// ================================================================
describe('v18.10 #3 — official spot-WS price print → liveFeed tick instantly', () => {
  let sockets: FakeSpotWs[];

  beforeEach(() => {
    (cxSpotWs as any)._resetSpotWsForTest();
    (cxSpotWs as any)._setSpotWsEnabledForTest(true);
    sockets = [];
    (cxSpotWs as any)._setSpotWsFactoryForTest((url: string) => {
      const s = new FakeSpotWs(url);
      sockets.push(s);
      return s;
    });
  });
  afterEach(() => {
    (cxSpotWs as any)._setSpotWsFactoryForTest(null);
    (cxSpotWs as any)._setSpotWsNowForTest(null);
    (cxSpotWs as any)._resetSpotWsForTest();
  });

  it('a BTCINR print on the exchange socket lands in liveFeed as IN_BTC · coindcx-spot-ws', async () => {
    cryptoStream.ensureCryptoSubscribed(['BTC']);
    (cxSpotWs as any).spotWsDemand();
    await vi.waitFor(() => expect(sockets.length).toBe(1));
    const sock = sockets[0];
    await vi.waitFor(() => expect(sock.sent.filter(f => f.startsWith('42["join"'))).toHaveLength(2));

    // THE moment: exchange prints, tick exists — no 2s poller wait.
    sock.serverMessage(priceFrame({ BTCINR: 6123456.5 }));
    const t = liveFeed.getTick('IN_BTC');
    expect(t).not.toBeNull();
    expect(t!.price).toBe(6123456.5);
    expect(t!.source).toBe('coindcx-spot-ws');
  });

  it('unwatched coins never tick (the IN_ namespace stays honest)', async () => {
    cryptoStream.ensureCryptoSubscribed(['BTC']);
    expect(liveFeed.getTick('IN_ZZZ')).toBeNull();
    (cxSpotWs as any).spotWsDemand();
    await vi.waitFor(() => expect(sockets.length).toBe(1));
    const sock = sockets[0];
    await vi.waitFor(() => expect(sock.sent.filter(f => f.startsWith('42["join"'))).toHaveLength(2));
    sock.serverMessage(priceFrame({ ZZZINR: 42.5, BTCUSDT: 76421.4 })); // non-INR pair + unwatched coin
    expect(liveFeed.getTick('IN_ZZZ')).toBeNull(); // unwatched coin → no tick
    // BTCUSDT is a USDT market — the IN_ (INR) namespace never sees it:
    // the handler's /^([A-Z0-9]+)INR$/ gate rejects it (source contract
    // below pins the regex itself).
    expect(cryptoStreamSrc).toContain("/^([A-Z0-9]+)INR$/.exec(String(market || ''))");
  });

  it('the SSE status frame tier carries spotWs health (badge honesty)', async () => {
    const st = (cxRtStream as any).cxRtWsStatus();
    expect(st).toBeTruthy();
    expect(typeof st.spotWs).toBe('object');
    expect(st.spotWs).toHaveProperty('enabled');
    expect(st.spotWs).toHaveProperty('connected');
    expect(st.spotWs).toHaveProperty('servable');
    expect(st.spotWs).toHaveProperty('freshMarkets');
    expect(st.spotWs).toHaveProperty('markets');
    expect(st.spotWs).toHaveProperty('ageMs');
    expect(st.spotWs).toHaveProperty('cooling');
    // a full fresh book flips servable — the SPOT·WS badge's proof
    const many: Record<string, number> = {};
    for (let i = 0; i < 30; i++) many[`C${i}INR`] = 100 + i;
    (cxSpotWs as any).spotWsDemand();
    await vi.waitFor(() => expect(sockets.length).toBe(1));
    const sock = sockets[0];
    await vi.waitFor(() => expect(sock.sent.filter(f => f.startsWith('42["join"'))).toHaveLength(2));
    sock.serverMessage(priceFrame(many));
    const st2 = (cxRtStream as any).cxRtWsStatus();
    expect(st2.spotWs.servable).toBe(true);
    expect(st2.spotWs.freshMarkets).toBe(30);
  });

  it('cryptoStream registers the direct-push handler at import (source contract)', () => {
    expect(cryptoStreamSrc).toContain('setSpotWsOnPrice((market, price) => {');
    expect(cryptoStreamSrc).toContain("'coindcx-spot-ws'"); // honest source label
    expect(cxRtStreamSrc).toContain("import { spotWsStatus } from './cxSpotWs.js'");
  });
});
