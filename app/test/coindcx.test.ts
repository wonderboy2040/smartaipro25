// ============================================================
// test/coindcx.test.ts — CoinDCX crypto source + multi-source
// asset-table engine.
// Covers: HMAC request signing (byte-exact body), defensive
// balance normalization, balance→asset mapping (INR pair, USDT
// fallback × FX, fiat/dust/unpriceable skips), connect validation
// (invalid keys are NEVER persisted), the merged INDMoney+CoinDCX
// syncNow, CoinDCX-only sync, failure-keeps-previous-assets, the
// hidden (removed) asset engine across syncs, and per-source
// clearing on disconnect.
// ============================================================
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(__dirname, '..', 'server', 'data');
const SNAP_PATH = path.join(DATA, 'mcp-portfolio.json');
const CDCX_CREDS_PATH = path.join(DATA, 'mcp-coindcx.json');
const SYM_CACHE_PATH = path.join(DATA, 'mcp-symbol-cache.json');
const STORE_PATH = path.join(DATA, 'mcp-indmoney.json');

const coindcx = await import('../server/mcp/coindcx.js');
const syncMod = await import('../server/mcp/portfolioSync.js');
const indm = await import('../server/mcp/indmoney.js');
const cryptoStream = await import('../server/cryptoStream.js');
const symbolsMod = await import('../server/mcp/symbols.js');

const { normalizeBalances, mapBalancesToAssets, coindcxPrivate } = coindcx;
const {
  syncNow, getAssetsSnapshot, syncInfo, clearSourceAssets,
  hideAsset, unhideAsset, unhideAll,
  __resetSyncForTests, __stopSchedulerForTests,
} = syncMod;
const { __setFetchForTests: resetSymbolsFetch } = symbolsMod;

const CDCX_BALANCES_URL = 'https://api.coindcx.com/exchange/v1/users/balances';
const CDCX_TICKER_URL = 'https://api.coindcx.com/exchange/ticker';
const RATE_URL = 'https://open.er-api.com/v6/latest/USD';

// ---------------- helpers ----------------
function jsonRes(json, init = {}) {
  return {
    ok: (init.status ?? 200) >= 200 && (init.status ?? 200) < 300,
    status: init.status ?? 200,
    headers: new Map(Object.entries(init.headers || {})),
    text: async () => (typeof json === 'string' ? json : JSON.stringify(json)),
    json: async () => (typeof json === 'string' ? JSON.parse(json) : json),
  };
}

function tickers(items) { return items; }
function ticker(market, last, change = 0) { return { market, last_price: String(last), change_24_hour: String(change) }; }

/** Normalized balance record — the shape normalizeBalances() emits and
 *  mapBalancesToAssets() consumes. */
function nb(base, qty, name = base) {
  return { base, name, qty, free: qty, locked: 0 };
}

/** RAW CoinDCX /users/balances record (documented schema). */
function bal(cur, free, locked = 0) {
  return { currency_short_name: cur, currency_name: cur, available_balance: free, locked_balance: locked, balance: free };
}

beforeEach(() => {
  indm.__resetForTests();
  __resetSyncForTests();
  __stopSchedulerForTests();
  cryptoStream._resetCryptoStreamForTest();
  coindcx.__resetCoinDcxForTests();
  try { fs.rmSync(SNAP_PATH, { force: true }); } catch { /* ignore */ }
  try { fs.rmSync(CDCX_CREDS_PATH, { force: true }); } catch { /* ignore */ }
  try { fs.rmSync(SYM_CACHE_PATH, { force: true }); } catch { /* ignore */ }
});
afterEach(() => {
  vi.unstubAllGlobals();
  resetSymbolsFetch(null);
  try { fs.rmSync(SNAP_PATH, { force: true }); } catch { /* ignore */ }
  try { fs.rmSync(CDCX_CREDS_PATH, { force: true }); } catch { /* ignore */ }
  try { fs.rmSync(SYM_CACHE_PATH, { force: true }); } catch { /* ignore */ }
  try { fs.rmSync(STORE_PATH, { force: true }); } catch { /* ignore */ }
});

// ============================================================
// normalizeBalances — defensive field mapping
// ============================================================
describe('normalizeBalances', () => {
  it('parses the documented schema and sums free + locked', () => {
    const out = normalizeBalances([
      { currency_short_name: 'BTC', currency_name: 'Bitcoin', available_balance: 0.5, locked_balance: 0.1 },
      { currency_short_name: 'ETH', currency_name: 'Ethereum', available_balance: 2, locked_balance: 0 },
    ]);
    expect(out).toEqual([
      { base: 'BTC', name: 'Bitcoin', qty: 0.6, free: 0.5, locked: 0.1 },
      { base: 'ETH', name: 'Ethereum', qty: 2, free: 2, locked: 0 },
    ]);
  });

  it('falls back to alternate field names (currency/free/balance)', () => {
    const out = normalizeBalances([
      { currency: 'XRP', free: 100, locked: 20 },
      { currency_short_name: 'ADA', balance: '300' },
    ]);
    expect(out.find(b => b.base === 'XRP')?.qty).toBe(120);
    expect(out.find(b => b.base === 'ADA')?.qty).toBe(300);
  });

  it('drops zero/negative balances and garbage rows', () => {
    const out = normalizeBalances([
      { currency_short_name: 'DODGE0', available_balance: 0, locked_balance: 0 },
      { currency_short_name: 'NEG', available_balance: -5 },
      null,
      'nope',
      { currency_short_name: 'SOL', available_balance: 1.5 },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].base).toBe('SOL');
  });
});

// ============================================================
// mapBalancesToAssets — valuation rules
// ============================================================
describe('mapBalancesToAssets', () => {
  it('prices INR pairs directly with 24h change; key/id/source stamped', () => {
    const assets = mapBalancesToAssets(
      [nb('BTC', 0.5, 'Bitcoin')],
      tickers([ticker('BTCINR', 6000000, 2.5), ticker('ETHINR', 300000)]),
      83,
    );
    expect(assets).toHaveLength(1);
    const a = assets[0];
    expect(a.key).toBe('cdcx:BTC');
    expect(a.id).toBe('cdcx-BTC');
    expect(a.source).toBe('coindcx');
    expect(a.symbol).toBe('BTC');
    expect(a.market).toBe('IN');
    expect(a.kind).toBe('crypto');
    expect(a.qty).toBe(0.5);
    expect(a.lastPrice).toBe(6000000);
    expect(a.value).toBe(3000000);
    expect(a.oneDayChangePct).toBe(2.5);
    expect(a.invested).toBeNull();
    expect(a.pnl).toBeNull();
    expect(a.noLive).toBe(false);
    expect(a.name).toContain('Bitcoin');
    expect(a.name).toContain('CoinDCX');
  });

  it('falls back to the USDT pair × live USD/INR when no INR pair exists', () => {
    const assets = mapBalancesToAssets(
      [nb('QNT', 10)],
      tickers([ticker('QNTUSDT', 100)]),
      84,
    );
    expect(assets).toHaveLength(1);
    expect(assets[0].lastPrice).toBe(8400);
    expect(assets[0].value).toBe(84000);
    expect(assets[0].oneDayChangePct).toBeNull(); // change only tracked for INR pairs
  });

  it('skips INR fiat, dust, and unpriceable coins', () => {
    const assets = mapBalancesToAssets(
      [
        nb('INR', 50000),   // fiat cash — not a crypto holding
        nb('DOGE', 10),     // 10 × ₹4 = ₹40 — above dust, kept
        nb('PEPE2', 999),   // no market at all
      ],
      tickers([ticker('DOGEINR', 4)]),
      84,
    );
    expect(assets).toHaveLength(1);
    expect(assets[0].symbol).toBe('DOGE');
  });

  it('dust below ₹10 is skipped', () => {
    const assets = mapBalancesToAssets(
      [nb('SHIB', 1000)],
      tickers([ticker('SHIBINR', 0.0005)]),
      84,
    );
    expect(assets).toHaveLength(0);
  });
});

// ============================================================
// coindcxPrivate — HMAC signing (byte-exact)
// ============================================================
describe('coindcxPrivate (HMAC-SHA256 request signing)', () => {
  it('signs the exact request body with the secret and sends the auth headers', async () => {
    let captured = null;
    vi.stubGlobal('fetch', async (url, init = {}) => {
      captured = { url: String(url), init };
      return jsonRes([]);
    });
    await coindcxPrivate('/exchange/v1/users/balances', 'my-key', 'my-secret', { page: 1, size: 200 });
    expect(captured.url).toBe(CDCX_BALANCES_URL);
    expect(captured.init.method).toBe('POST');
    expect(captured.init.headers['X-AUTH-APIKEY']).toBe('my-key');
    const bodyStr = String(captured.init.body);
    const body = JSON.parse(bodyStr);
    expect(body.page).toBe(1);
    expect(body.size).toBe(200);
    expect(body.timestamp).toBeGreaterThan(Date.now() - 60_000);
    // signature must be HMAC-SHA256(secret, exact body bytes) — hex
    const expected = crypto.createHmac('sha256', 'my-secret').update(bodyStr).digest('hex');
    expect(captured.init.headers['X-AUTH-SIGNATURE']).toBe(expected);
  });

  it('surfaces API errors with status (never a raw stack)', async () => {
    vi.stubGlobal('fetch', async () => jsonRes({ message: 'Invalid API key' }, { status: 401 }));
    await expect(coindcxPrivate('/exchange/v1/users/balances', 'bad', 'bad'))
      .rejects.toThrow('Invalid API key');
  });
});

// ============================================================
// fetchBalancesSigned — docs-exact string params + pagination
// ============================================================
describe('fetchBalancesSigned (paginated balances)', () => {
  it('sends STRING page/size (docs format) and stops after a short page', async () => {
    const calls = [];
    vi.stubGlobal('fetch', async (url, init = {}) => {
      if (String(url) === CDCX_BALANCES_URL) {
        const body = JSON.parse(String(init.body));
        calls.push(body);
        if (body.page === '1') return jsonRes(Array.from({ length: 100 }, (_, i) => bal(`C${i}`, 1)));
        return jsonRes([bal('ETH', 2)]);
      }
      throw new Error(`unexpected ${url}`);
    });
    const out = await coindcx.__fetchBalancesSignedForTests()('k', 's');
    expect(out).toHaveLength(101);          // 100 from page 1 + 1 from page 2
    expect(calls).toHaveLength(2);          // short page 2 → loop terminated
    expect(calls[0].page).toBe('1');        // STRING params (CoinDCX docs)
    expect(calls[0].size).toBe('100');
    expect(calls[1].page).toBe('2');
    expect(typeof calls[0].timestamp).toBe('number');
  });

  it('single short page → exactly one upstream call', async () => {
    let callCount = 0;
    vi.stubGlobal('fetch', async (url) => {
      if (String(url) === CDCX_BALANCES_URL) { callCount++; return jsonRes([bal('BTC', 1)]); }
      throw new Error(`unexpected ${url}`);
    });
    const out = await coindcx.__fetchBalancesSignedForTests()('k', 's');
    expect(out).toHaveLength(1);
    expect(callCount).toBe(1);
  });

  it('caps pagination at 5 pages even if pages stay full', async () => {
    let callCount = 0;
    vi.stubGlobal('fetch', async (url) => {
      if (String(url) === CDCX_BALANCES_URL) {
        callCount++;
        return jsonRes(Array.from({ length: 100 }, (_, i) => bal(`X${callCount}_${i}`, 1)));
      }
      throw new Error(`unexpected ${url}`);
    });
    const out = await coindcx.__fetchBalancesSignedForTests()('k', 's');
    expect(callCount).toBe(5);
    expect(out).toHaveLength(500);
  });
});

// ============================================================
// coindcxConnect — validate BEFORE persist
// ============================================================
describe('coindcxConnect', () => {
  it('persists only after a successful balances call', async () => {
    vi.stubGlobal('fetch', async (url) => {
      if (String(url) === CDCX_BALANCES_URL) return jsonRes([bal('BTC', 1)]);
      throw new Error(`unexpected ${url}`);
    });
    const out = await coindcx.coindcxConnect('k1', 's1');
    expect(out).toEqual({ connected: true, balanceCount: 1, validated: true });
    expect(coindcx.coindcxConnected()).toBe(true);
    expect(coindcx.coindcxStatus().connected).toBe(true);
    expect(coindcx.coindcxStatus().balanceCount).toBe(1);
  });
  it('invalid keys are rejected AND never stored', async () => {
    vi.stubGlobal('fetch', async () => jsonRes({ message: 'Unauthorized' }, { status: 401 }));
    await expect(coindcx.coindcxConnect('k2', 's2')).rejects.toThrow('Unauthorized');
    expect(coindcx.coindcxConnected()).toBe(false);
  });

  it('missing fields → 400 without any fetch', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    await expect(coindcx.coindcxConnect('', '')).rejects.toThrow('required');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('disconnect wipes the credentials', async () => {
    coindcx.__setCredsForTests('k', 's');
    expect(coindcx.coindcxConnected()).toBe(true);
    coindcx.coindcxDisconnect();
    expect(coindcx.coindcxConnected()).toBe(false);
  });
});

// ============================================================
// Multi-source syncNow — INDMoney + CoinDCX merge
// ============================================================
describe('syncNow multi-source (INDMoney + CoinDCX)', () => {
  const ORIGIN = 'https://smartai.example.com';

  // Minimal INDMoney MCP flow: 1 enum asset type with 1 holding.
  function stubIndmFlow() {
    vi.stubGlobal('fetch', async (url, init = {}) => {
      const u = String(url);
      if (u === RATE_URL) return jsonRes({ rates: { INR: 80 } });
      if (u === indm.INDM.REGISTER_URL) return jsonRes({ client_id: 'cdcx-merge' });
      if (u === indm.INDM.TOKEN_URL) return jsonRes({ access_token: 'AT-M', refresh_token: 'RT-M', expires_in: 3600 });
      if (u === indm.INDM.MCP_URL) {
        const body = JSON.parse(String(init.body || '{}'));
        if (body.method === 'initialize') return jsonRes({ jsonrpc: '2.0', id: body.id, result: { serverInfo: { name: 'indmoney' } } }, { headers: { 'mcp-session-id': 'm1' } });
        if (body.method === 'notifications/initialized') return jsonRes('', { status: 202 });
        if (body.method === 'tools/list') {
          return jsonRes({ jsonrpc: '2.0', id: body.id, result: { tools: [{
            name: 'networth_holdings',
            inputSchema: { type: 'object', properties: { asset_type: { type: 'string', enum: ['IND_STOCK'] } }, required: ['asset_type'] },
          }] } });
        }
        if (body.method === 'tools/call') {
          return jsonRes({ jsonrpc: '2.0', id: body.id, result: { content: [{ type: 'text', text: JSON.stringify({
            holdings: [{ investment: 'Reliance Industries', invested_amount: 100000, market_value: 110000, total_units: 40, unit_price: 2750, total_pnl: 10000, pnl_per: 10 }],
            asset_summary: { total_value: 110000, invested: 100000 },
          }) }] } });
        }
        throw new Error(`unexpected MCP method ${body.method}`);
      }
      if (u === CDCX_BALANCES_URL) return jsonRes([bal('BTC', 0.5), bal('ETH', 2), bal('INR', 9000)]);
      if (u.startsWith(CDCX_TICKER_URL)) return jsonRes([ticker('BTCINR', 6000000, 1.5), ticker('ETHINR', 300000, -2)]);
      if (u.includes('groww.in')) return jsonRes({ content: [] });
      if (u.includes('scanner.tradingview.com')) return jsonRes({ data: [] });
      throw new Error(`unexpected url ${u}`);
    });
  }

  async function connectIndm() {
    const { state } = await indm.startConnect(ORIGIN);
    await indm.completeConnect({ code: 'merge-code', state });
  }

  it('merges INDMoney holdings + CoinDCX balances into one snapshot', async () => {
    stubIndmFlow();
    await connectIndm();
    coindcx.__setCredsForTests('mk', 'ms');

    const out = await syncNow({ force: true, reason: 'manual' });
    expect(out.ok).toBe(true);

    const snap = getAssetsSnapshot();
    expect(snap.assets).toHaveLength(3); // Reliance + BTC + ETH (INR fiat skipped)
    expect(snap.assets.filter(a => a.source === 'indmoney')).toHaveLength(1);
    expect(snap.assets.filter(a => a.source === 'coindcx')).toHaveLength(2);
    expect(snap.counts.coindcx).toBe(2);
    expect(snap.source).toBe('indmoney+coindcx');

    const btc = snap.assets.find(a => a.key === 'cdcx:BTC');
    expect(btc.value).toBe(3000000);
    const rel = snap.assets.find(a => a.key && a.key.startsWith('indm:'));
    expect(rel.symbol).toBeNull(); // no Groww match in this stub → noLive path
    expect(rel.noLive).toBe(true);

    // syncInfo reports BOTH sources + coindcx detail
    const info = syncInfo();
    expect(info.sources).toEqual({ indmoney: true, coindcx: true });
    expect(info.coindcx.connected).toBe(true);
    expect(info.coindcx.lastSyncAt).toBeTruthy();
  });

  it('CoinDCX-only sync works with INDMoney disconnected', async () => {
    stubIndmFlow(); // fetch stub still handles coindcx + forex
    coindcx.__setCredsForTests('solo', 'solo');
    // NOTE: INDMoney never connected

    const out = await syncNow({ force: true, reason: 'manual' });
    expect(out.ok).toBe(true);
    const snap = getAssetsSnapshot();
    expect(snap.assets).toHaveLength(2);
    expect(snap.assets.every(a => a.source === 'coindcx')).toBe(true);
    expect(syncInfo().sources).toEqual({ indmoney: false, coindcx: true });
  });

  it('a coindcx-only quick sync (sources: [coindcx]) does not touch INDMoney MCP', async () => {
    stubIndmFlow();
    await connectIndm();
    coindcx.__setCredsForTests('qk', 'qs');

    let mcpCalled = false;
    const orig = globalThis.fetch;
    vi.stubGlobal('fetch', async (url, init = {}) => {
      if (String(url) === indm.INDM.MCP_URL) mcpCalled = true;
      return orig(url, init);
    });

    await syncNow({ force: true, reason: 'manual', sources: ['coindcx'] });
    expect(mcpCalled).toBe(false);
    const snap = getAssetsSnapshot();
    expect(snap.assets).toHaveLength(2);
    expect(snap.assets.every(a => a.source === 'coindcx')).toBe(true);
  });

  it('a failed CoinDCX sync preserves previous balances + records lastError', async () => {
    stubIndmFlow();
    coindcx.__setCredsForTests('f1', 'f1');
    const out1 = await syncNow({ force: true, reason: 'manual' });
    expect(out1.ok).toBe(true);
    expect(getAssetsSnapshot().assets).toHaveLength(2);

    // Now the balances endpoint starts failing (key revoked).
    vi.stubGlobal('fetch', async (url) => {
      const u = String(url);
      if (u === CDCX_BALANCES_URL) return jsonRes({ message: 'Invalid API key' }, { status: 401 });
      if (u === RATE_URL) return jsonRes({ rates: { INR: 80 } });
      if (u.startsWith(CDCX_TICKER_URL)) return jsonRes([ticker('BTCINR', 6000000)]);
      throw new Error(`unexpected ${u}`);
    });
    const out2 = await syncNow({ force: true, reason: 'manual' });
    expect(out2.ok).toBe(false);        // sync FAILED — but data stays usable
    const snap = getAssetsSnapshot();
    expect(snap.assets).toHaveLength(2); // kept
    expect(snap.assets.every(a => a.source === 'coindcx')).toBe(true);
    expect(snap.coindcx.lastError).toContain('Invalid API key');
    expect(snap.lastError).toContain('Invalid API key');
  });

  it('neither source connected → not-connected, no snapshot write', async () => {
    const out = await syncNow({ force: true, reason: 'manual' });
    expect(out.ok).toBe(false);
    expect(out.reason).toBe('not-connected');
  });
});

// ============================================================
// Hidden (removed) assets — hide persists across syncs
// ============================================================
describe('hidden assets (user-removed rows)', () => {
  const CDCX_STUB = () => {
    vi.stubGlobal('fetch', async (url) => {
      const u = String(url);
      if (u === CDCX_BALANCES_URL) return jsonRes([bal('BTC', 1), bal('ETH', 2)]);
      if (u.startsWith(CDCX_TICKER_URL)) return jsonRes([ticker('BTCINR', 100, 1), ticker('ETHINR', 50)]);
      if (u === RATE_URL) return jsonRes({ rates: { INR: 80 } });
      throw new Error(`unexpected ${u}`);
    });
  };

  it('hide → row leaves the visible set, reappears only via unhide', async () => {
    CDCX_STUB();
    coindcx.__setCredsForTests('h1', 'h1');
    await syncNow({ force: true });

    expect(hideAsset('cdcx:BTC')).toBe(true);
    let snap = getAssetsSnapshot();
    expect(snap.assets).toHaveLength(2);        // full set unchanged
    expect(snap.hidden).toEqual(['cdcx:BTC']); // but flagged
    let info = syncInfo();
    expect(info.assetCount).toBe(1);
    expect(info.hiddenCount).toBe(1);

    // re-sync → BTC returns from the exchange but STAYS hidden
    await syncNow({ force: true });
    snap = getAssetsSnapshot();
    expect(snap.assets).toHaveLength(2);
    expect(snap.hidden).toEqual(['cdcx:BTC']);

    // restore → visible again
    expect(unhideAsset('cdcx:BTC')).toBe(true);
    info = syncInfo();
    expect(info.assetCount).toBe(2);
    expect(info.hiddenCount).toBe(0);
  });

  it('hide unknown key → false; unhide with nothing hidden → false', async () => {
    CDCX_STUB();
    coindcx.__setCredsForTests('h2', 'h2');
    await syncNow({ force: true });
    expect(hideAsset('cdcx:NOPE')).toBe(false);
    expect(unhideAsset('cdcx:BTC')).toBe(false);
    expect(unhideAll()).toBe(false);
  });

  it('unhideAll restores every removed row', async () => {
    CDCX_STUB();
    coindcx.__setCredsForTests('h3', 'h3');
    await syncNow({ force: true });
    hideAsset('cdcx:BTC');
    hideAsset('cdcx:ETH');
    expect(syncInfo().hiddenCount).toBe(2);
    expect(unhideAll()).toBe(true);
    expect(syncInfo().hiddenCount).toBe(0);
    expect(syncInfo().assetCount).toBe(2);
  });

  it('hiding the same key twice is a no-op', async () => {
    CDCX_STUB();
    coindcx.__setCredsForTests('h4', 'h4');
    await syncNow({ force: true });
    expect(hideAsset('cdcx:BTC')).toBe(true);
    expect(hideAsset('cdcx:BTC')).toBe(false);
    expect(getAssetsSnapshot().hidden).toEqual(['cdcx:BTC']);
  });
});

// ============================================================
// Per-source clearing on disconnect
// ============================================================
describe('clearSourceAssets (source-scoped disconnect)', () => {
  const BOTH_STUB = () => {
    vi.stubGlobal('fetch', async (url, init = {}) => {
      const u = String(url);
      if (u === RATE_URL) return jsonRes({ rates: { INR: 80 } });
      if (u === CDCX_BALANCES_URL) return jsonRes([bal('BTC', 1)]);
      if (u.startsWith(CDCX_TICKER_URL)) return jsonRes([ticker('BTCINR', 100)]);
      if (u === indm.INDM.REGISTER_URL) return jsonRes({ client_id: 'clear-1' });
      if (u === indm.INDM.TOKEN_URL) return jsonRes({ access_token: 'AT-C', refresh_token: 'RT-C', expires_in: 3600 });
      if (u === indm.INDM.MCP_URL) {
        const body = JSON.parse(String(init.body || '{}'));
        if (body.method === 'initialize') return jsonRes({ jsonrpc: '2.0', id: body.id, result: {} }, { headers: { 'mcp-session-id': 'c1' } });
        if (body.method === 'notifications/initialized') return jsonRes('', { status: 202 });
        if (body.method === 'tools/list') return jsonRes({ jsonrpc: '2.0', id: body.id, result: { tools: [{ name: 'networth_holdings', inputSchema: { type: 'object', properties: { asset_type: { type: 'string', enum: ['IND_STOCK'] } }, required: ['asset_type'] } }] } });
        if (body.method === 'tools/call') return jsonRes({ jsonrpc: '2.0', id: body.id, result: { content: [{ type: 'text', text: JSON.stringify({ holdings: [{ investment: 'Reliance Industries', invested_amount: 100, market_value: 110, total_units: 1 }] }) }] } });
        throw new Error(`unexpected MCP method ${body.method}`);
      }
      if (u.includes('groww.in')) return jsonRes({ content: [] });
      if (u.includes('scanner.tradingview.com')) return jsonRes({ data: [] });
      throw new Error(`unexpected ${u}`);
    });
  };

  it('disconnecting INDMoney keeps the CoinDCX rows (and their hidden flags)', async () => {
    BOTH_STUB();
    const { state } = await indm.startConnect('https://smartai.example.com');
    await indm.completeConnect({ code: 'c-code', state });
    coindcx.__setCredsForTests('cl', 'cl');

    await syncNow({ force: true });
    expect(getAssetsSnapshot().assets).toHaveLength(2);
    hideAsset('cdcx:BTC'); // user removed the BTC row
    expect(syncInfo().assetCount).toBe(1);

    clearSourceAssets('indmoney');
    const snap = getAssetsSnapshot();
    expect(snap.assets).toHaveLength(1);
    expect(snap.assets[0].source).toBe('coindcx');
    expect(snap.hidden).toEqual(['cdcx:BTC']); // coindcx hidden flag survives
    expect(snap.summary).toBeNull();           // indmoney residue cleared
    expect(snap.positions).toEqual([]);
  });

  it('disconnecting CoinDCX keeps the INDMoney rows', async () => {
    BOTH_STUB();
    const { state } = await indm.startConnect('https://smartai.example.com');
    await indm.completeConnect({ code: 'c2-code', state });
    coindcx.__setCredsForTests('cl2', 'cl2');

    await syncNow({ force: true });
    expect(getAssetsSnapshot().assets).toHaveLength(2);

    clearSourceAssets('coindcx');
    const snap = getAssetsSnapshot();
    expect(snap.assets).toHaveLength(1);
    expect(snap.assets[0].source).toBe('indmoney');
    expect(snap.coindcx).toBeNull();
  });
});
