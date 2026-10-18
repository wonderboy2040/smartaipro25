// ============================================================
// test/indmoneyMcp.test.ts — INDMoney MCP connector test suite
// Covers: PKCE correctness, SSE/JSON-RPC parsing, authorize URL,
// tool detection, schema-agnostic portfolio normalization,
// tool payload extraction, and the mocked end-to-end OAuth + MCP
// flow (register → authorize → token → initialize → tools/call).
// ============================================================
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STORE_PATH = path.join(__dirname, '..', 'server', 'data', 'mcp-indmoney.json');

const {
  pkceGenerate, pkceChallengeFrom, buildAuthorizeUrl, detectPortfolioTool,
  normalizePortfolio, summarizeHoldings, collectHoldings, extractToolPayload, parseSSEOrJSON,
  buildToolArgSets, assetTypeLabel, buildCodeMap, extractPositions, readAssetSummary,
  startConnect, completeConnect, getStatus, disconnect, listTools,
  fetchPortfolio, refreshAccessToken, __resetForTests, IndmError, INDM,
} = await import('../server/mcp/indmoney.js');

// ---------------- helpers ----------------
function sseBody(frames) {
  return frames.map(f => `event: message\ndata: ${JSON.stringify(f)}\n\n`).join('');
}
function jsonRes(json, init = {}) {
  return {
    ok: (init.status ?? 200) >= 200 && (init.status ?? 200) < 300,
    status: init.status ?? 200,
    headers: new Map(Object.entries(init.headers || {})),
    text: async () => (typeof json === 'string' ? json : JSON.stringify(json)),
  };
}
function textBody(text, status = 200) {
  return { ok: status >= 200 && status < 300, status, headers: new Map(), text: async () => text };
}

// ---------------- PKCE ----------------
describe('PKCE (RFC 7636 S256)', () => {
  it('generates a valid verifier (43-128 chars, base64url charset)', () => {
    const { verifier, challenge } = pkceGenerate();
    expect(verifier.length).toBeGreaterThanOrEqual(43);
    expect(verifier.length).toBeLessThanOrEqual(128);
    expect(verifier).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(challenge).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(challenge).not.toBe(verifier);
  });

  it('challenge = BASE64URL(SHA256(verifier)) — matches independent node crypto', () => {
    const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjsg';
    const expected = crypto.createHash('sha256').update(verifier).digest('base64url');
    expect(pkceChallengeFrom(verifier)).toBe(expected);
    // 43-char base64url output (SHA256 digest) — per RFC 7636 §4.2
    expect(pkceChallengeFrom(verifier)).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('different verifiers → different challenges', () => {
    const a = pkceGenerate();
    const b = pkceGenerate();
    expect(a.challenge).not.toBe(b.challenge);
  });
});

// ---------------- MCP response parsing ----------------
describe('parseSSEOrJSON', () => {
  it('parses plain JSON objects', () => {
    const out = parseSSEOrJSON('{"jsonrpc":"2.0","id":1,"result":{"ok":true}}');
    expect(out).toHaveLength(1);
    expect(out[0].result.ok).toBe(true);
  });

  it('parses SSE frames and picks JSON-RPC messages', () => {
    const body = sseBody([
      { jsonrpc: '2.0', id: 7, result: { tools: [] } },
      { jsonrpc: '2.0', method: 'notifications/roots' },
    ]);
    const out = parseSSEOrJSON(body);
    expect(out).toHaveLength(2);
    expect(out.find(m => m.id === 7).result).toEqual({ tools: [] });
  });

  it('ignores [DONE] frames and empty payloads', () => {
    const body = 'data: [DONE]\n\ndata: {"jsonrpc":"2.0","id":3,"result":1}\n\n';
    const out = parseSSEOrJSON(body);
    expect(out).toHaveLength(1);
  });

  it('returns [] for garbage', () => {
    expect(parseSSEOrJSON('')).toEqual([]);
    expect(parseSSEOrJSON('not json at all')).toEqual([]);
  });
});

// ---------------- authorize URL ----------------
describe('buildAuthorizeUrl', () => {
  it('contains all required OAuth + PKCE params', () => {
    const url = buildAuthorizeUrl({
      clientId: 'cid-123',
      redirectUri: 'https://app.example.com/api/mcp/indmoney/callback',
      state: 'st4te',
      codeChallenge: 'ch-abc',
      scope: 'portfolio:read',
    });
    const u = new URL(url);
    expect(u.origin + u.pathname).toBe('https://mcp.indmoney.com/authorize');
    expect(u.searchParams.get('client_id')).toBe('cid-123');
    expect(u.searchParams.get('redirect_uri')).toBe('https://app.example.com/api/mcp/indmoney/callback');
    expect(u.searchParams.get('response_type')).toBe('code');
    expect(u.searchParams.get('scope')).toBe('portfolio:read');
    expect(u.searchParams.get('state')).toBe('st4te');
    expect(u.searchParams.get('code_challenge')).toBe('ch-abc');
    expect(u.searchParams.get('code_challenge_method')).toBe('S256');
  });

  it('defaults scope when omitted', () => {
    const url = buildAuthorizeUrl({ clientId: 'x', redirectUri: 'https://a/cb', state: 's', codeChallenge: 'c' });
    expect(new URL(url).searchParams.get('scope')).toBe(INDM.SCOPES);
  });
});

// ---------------- schema-driven tool arguments ----------------
describe('buildToolArgSets (inputSchema → argument sets)', () => {
  it('no required fields → single empty arg-set, satisfiable', () => {
    const r = buildToolArgSets({ name: 'get_portfolio', inputSchema: { type: 'object', properties: { x: { type: 'string' } } } });
    expect(r.argSets).toEqual([{}]);
    expect(r.satisfiable).toBe(true);
  });

  it('missing/absent schema → empty arg-set (legacy behavior)', () => {
    expect(buildToolArgSets({ name: 't' }).argSets).toEqual([{}]);
    expect(buildToolArgSets({ name: 't', inputSchema: null }).satisfiable).toBe(true);
  });

  it('required enum field → one arg-set per enum value (the exact networth_holdings fix)', () => {
    const tool = {
      name: 'networth_holdings',
      inputSchema: {
        type: 'object',
        properties: { asset_type: { type: 'string', enum: ['stocks', 'mutual_funds', 'fd'] } },
        required: ['asset_type'],
      },
    };
    const r = buildToolArgSets(tool);
    expect(r.satisfiable).toBe(true);
    expect(r.argSets).toEqual([
      { asset_type: 'stocks' },
      { asset_type: 'mutual_funds' },
      { asset_type: 'fd' },
    ]);
  });

  it('required asset_type WITHOUT enum → known INDMoney asset-type fallbacks', () => {
    const tool = {
      name: 'networth_holdings',
      inputSchema: {
        type: 'object',
        properties: { asset_type: { type: 'string', description: 'Asset type filter' } },
        required: ['asset_type'],
      },
    };
    const r = buildToolArgSets(tool);
    expect(r.satisfiable).toBe(true);
    expect(r.argSets.length).toBeGreaterThan(4);
    expect(r.argSets.length).toBeLessThanOrEqual(12);
    expect(r.argSets.every(a => typeof a.asset_type === 'string' && a.asset_type)).toBe(true);
    // real INDMoney tokens (observed live)
    expect(r.argSets.map(a => a.asset_type)).toContain('IND_STOCK');
    expect(r.argSets.map(a => a.asset_type)).toContain('MF');
  });

  it('required field with a default → uses the default', () => {
    const tool = {
      name: 't',
      inputSchema: {
        type: 'object',
        properties: { mode: { type: 'string', default: 'full' } },
        required: ['mode'],
      },
    };
    expect(buildToolArgSets(tool).argSets).toEqual([{ mode: 'full' }]);
  });

  it('required boolean → [true]; required unknown string → unsatisfiable', () => {
    const boolTool = {
      name: 't',
      inputSchema: { type: 'object', properties: { detailed: { type: 'boolean' } }, required: ['detailed'] },
    };
    expect(buildToolArgSets(boolTool).argSets).toEqual([{ detailed: true }]);

    const strTool = {
      name: 't',
      inputSchema: { type: 'object', properties: { symbol: { type: 'string' } }, required: ['symbol'] },
    };
    const r = buildToolArgSets(strTool);
    expect(r.satisfiable).toBe(false);
    expect(r.argSets).toEqual([{}]);
  });

  it('multiple required fields → cartesian product, capped at 12', () => {
    const tool = {
      name: 't',
      inputSchema: {
        type: 'object',
        properties: {
          a: { type: 'string', enum: ['1', '2', '3', '4', '5'] },
          b: { type: 'string', enum: ['x', 'y', 'z'] },
        },
        required: ['a', 'b'],
      },
    };
    const r = buildToolArgSets(tool);
    expect(r.argSets).toHaveLength(12); // 15 combos → capped
    expect(r.argSets[0]).toEqual({ a: '1', b: 'x' });
  });
});

describe('assetTypeLabel', () => {
  it('maps INDMoney asset tokens to display labels', () => {
    expect(assetTypeLabel('stocks')).toBe('Stock');
    expect(assetTypeLabel('IND_STOCK')).toBe('Stock');
    expect(assetTypeLabel('US_STOCK')).toBe('Stock');
    expect(assetTypeLabel('mutual_funds')).toBe('Mutual Fund');
    expect(assetTypeLabel('MF')).toBe('Mutual Fund');
    expect(assetTypeLabel('mf')).toBe('Mutual Fund');
    expect(assetTypeLabel('etf')).toBe('ETF');
    expect(assetTypeLabel('fd')).toBe('Fixed Income');
    expect(assetTypeLabel('fixed_deposit')).toBe('Fixed Income');
    expect(assetTypeLabel('gold')).toBe('Gold');
    expect(assetTypeLabel('bonds')).toBe('Bonds');
    expect(assetTypeLabel('BOND')).toBe('Bonds');
    expect(assetTypeLabel('nps')).toBe('Retirement');
    expect(assetTypeLabel('EPF')).toBe('Retirement');
    expect(assetTypeLabel('ppf')).toBe('Retirement');
    expect(assetTypeLabel('cryptocurrency')).toBe('Crypto');
    expect(assetTypeLabel('CRYPTO')).toBe('Crypto');
    expect(assetTypeLabel('real_estate')).toBe('Real Estate');
    expect(assetTypeLabel('RE')).toBe('Real Estate');
    expect(assetTypeLabel('SA')).toBe('Savings');
    expect(assetTypeLabel('INSURANCE')).toBe('Insurance');
    expect(assetTypeLabel('VEHICLE')).toBe('Vehicle');
    expect(assetTypeLabel('others')).toBe('Other');
  });
  it('all / unknown / null → null (keep per-holding classification)', () => {
    expect(assetTypeLabel('all')).toBeNull();
    expect(assetTypeLabel('ALL')).toBeNull();
    expect(assetTypeLabel(null)).toBeNull();
    expect(assetTypeLabel('xyzzy')).toBeNull();
  });
});

describe('summarizeHoldings (dedup + aggregate)', () => {
  it('dedups by name|qty and aggregates totals', () => {
    const r = summarizeHoldings([
      { name: 'IRFC', qty: 100, value: 15000, invested: 10000, pnl: 5000, assetType: 'Stock' },
      { name: 'IRFC', qty: 100, value: 15000, invested: 10000, pnl: 5000, assetType: 'Stock' },
      { name: 'HDFC Flexi', qty: 2, value: 5000, invested: 4800, pnl: 200, assetType: 'Mutual Fund' },
    ]);
    expect(r.ok).toBe(true);
    expect(r.holdings).toHaveLength(2);
    expect(r.summary.totalValue).toBe(20000);
    expect(r.summary.totalInvested).toBe(14800);
    expect(r.summary.totalPnl).toBe(5200);
  });
  it('empty list → not ok, no-holdings-found', () => {
    const r = summarizeHoldings([]);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('no-holdings-found');
    expect(r.summary).toBeNull();
  });
});

// ---------------- INDMoney real-schema (observed live) ----------------
describe('real INDMoney payload schema (user-reported live response)', () => {
  const REAL_PAYLOAD = {
    is_cached_response: false,
    positions: null,
    intra_day_positions: null,
    mtf_positions: [
      { ind_stock_id: 'INDS18666', isin_code: 'INF200KA1FS1', quantity: 45, avg_price: 260.57, buy_val: 11725.65, realised_gains: 0, t1_qty: 10, position_id: '92966827' },
      { ind_stock_id: 'INDS19602', isin_code: 'INF204KB1V68', quantity: 10, avg_price: 240.39, buy_val: 2403.9, realised_gains: 0, t1_qty: 10, position_id: '92966842' },
    ],
    asset_summary: { total_value: 328618.18, invested: 304979.08, one_day_change: -1824.69, one_day_change_percentage: -0.55 },
    holdings: [
      { investment_code: 'INDS33035', investment: 'Motilal Oswal Nifty 500 Momentum 50 ETF', asset_type: 'STOCK', invested_amount: 103380.5, market_value: 107619.2, total_pnl: 4238.7, pnl_per: 4.1, total_units: 1990, unit_price: 54.08 },
      { investment_code: 'INDS29513', investment: 'Mirae Asset Nifty Smallcap 250 Momen.Quali. 100ETF', asset_type: 'STOCK', invested_amount: 74986.98, market_value: 85985.78, total_pnl: 10998.8, pnl_per: 14.67, total_units: 1774, unit_price: 48.47 },
      { investment_code: 'INDS19602', investment: 'Nippon India ETF Nifty Midcap 150', asset_type: 'STOCK', invested_amount: 73056.7, market_value: 78893.1, total_pnl: 5836.4, pnl_per: 7.99, total_units: 330, unit_price: 239.07 },
    ],
  };

  it('collectHoldings detects holdings[] via investment/total_units keys — and SKIPS mtf_positions', () => {
    const hs = collectHoldings(REAL_PAYLOAD);
    // THE user-reported bug: 0 holdings detected. Now: all 3, no MTF dupes.
    expect(hs).toHaveLength(3);
    expect(hs.map(h => h.name)).toEqual([
      'Motilal Oswal Nifty 500 Momentum 50 ETF',
      'Mirae Asset Nifty Smallcap 250 Momen.Quali. 100ETF',
      'Nippon India ETF Nifty Midcap 150',
    ]);
    // no MTF positions leaked into holdings (no ISINs / INDS codes)
    expect(hs.some(h => /INF|INDS/.test(h.name))).toBe(false);
    const mo = hs[0];
    expect(mo.qty).toBe(1990);
    expect(mo.value).toBe(107619.2);
    expect(mo.invested).toBe(103380.5);
    expect(mo.pnl).toBe(4238.7);
    expect(mo.pnlPct).toBe(4.1);
    expect(mo.currentPrice).toBe(54.08);
    expect(mo.assetType).toBe('ETF'); // name-based classification beats arg stamp
  });

  it('buildCodeMap + extractPositions: MTF positions get human names, never double-counted', () => {
    const map = buildCodeMap(REAL_PAYLOAD);
    expect(map.get('INDS19602')).toBe('Nippon India ETF Nifty Midcap 150');
    const ps = extractPositions(REAL_PAYLOAD, map);
    expect(ps).toHaveLength(2);
    expect(ps.every(p => p.kind === 'MTF')).toBe(true);
    expect(ps[1].name).toBe('Nippon India ETF Nifty Midcap 150'); // resolved via codeMap
    expect(ps[0].name).toBe('INF200KA1FS1'); // unknown code → isin fallback
    expect(ps[0].qty).toBe(45);
    expect(ps[0].avgPrice).toBe(260.57);
    expect(ps[0].invested).toBe(11725.65);
    expect(ps[0].t1Qty).toBe(10);
  });

  it('readAssetSummary parses asset_summary totals incl. one-day change', () => {
    const s = readAssetSummary(REAL_PAYLOAD);
    expect(s).toEqual({
      totalValue: 328618.18,
      totalInvested: 304979.08,
      totalPnl: 23639.1,
      totalPnlPct: 7.75,
      oneDayChange: -1824.69,
      oneDayChangePct: -0.55,
    });
    expect(readAssetSummary({})).toBeNull();
    expect(readAssetSummary(null)).toBeNull();
    expect(readAssetSummary({ asset_summary: { invested: 1 } })).toBeNull(); // no total_value
  });

  it('normalizePortfolio on the real payload: ok, 3 holdings, computed summary', () => {
    const r = normalizePortfolio(REAL_PAYLOAD);
    expect(r.ok).toBe(true);
    expect(r.holdings).toHaveLength(3);
    expect(r.summary.totalValue).toBeCloseTo(107619.2 + 85985.78 + 78893.1, 2);
    expect(r.summary.totalInvested).toBeCloseTo(103380.5 + 74986.98 + 73056.7, 2);
  });
});

describe('portfolio tool ranking', () => {
  it('personal networth_holdings ranks above family-wide tools', () => {
    const tools = [
      { name: 'get_family_asset_holdings', description: 'Family asset holdings across members' },
      { name: 'networth_holdings', description: 'User net worth holdings by asset type' },
      { name: 'get_family_portfolio', description: 'Family portfolio' },
      { name: 'networth_snapshot', description: 'Net worth snapshot' },
    ];
    expect(detectPortfolioTool(tools).name).toBe('networth_holdings');
  });
});

// ---------------- portfolio tool detection ----------------
describe('detectPortfolioTool', () => {
  it('prefers portfolio/holdings tools over market/price tools', () => {
    const tools = [
      { name: 'get_stock_price', description: 'Get live stock price' },
      { name: 'get_portfolio', description: 'User portfolio holdings' },
      { name: 'market_news', description: 'Latest market news' },
    ];
    expect(detectPortfolioTool(tools)?.name).toBe('get_portfolio');
  });

  it('returns null when nothing looks like a portfolio tool', () => {
    const tools = [
      { name: 'get_price', description: 'price' },
      { name: 'get_news', description: 'news' },
    ];
    expect(detectPortfolioTool(tools)).toBeNull();
    expect(detectPortfolioTool([])).toBeNull();
    expect(detectPortfolioTool(null)).toBeNull();
  });
});

// ---------------- normalization ----------------
describe('normalizePortfolio / collectHoldings', () => {
  it('normalizes a nested INDMoney-style payload (stocks + MFs)', () => {
    const payload = {
      data: {
        stocks: [
          { stockName: 'Reliance Industries', symbol: 'RELIANCE', assetType: 'EQUITY', quantity: 10, avgPrice: 2400, currentPrice: 2900 },
          { stockName: 'TCS', symbol: 'TCS', assetType: 'EQUITY', quantity: 5, avgPrice: 3500, currentPrice: 3900 },
        ],
        mutualFunds: [
          { scheme_name: 'Parag Parikh Flexi Cap', assetType: 'MF', units: 120.5, nav: 78.4, investedAmount: 8500 },
        ],
      },
    };
    const out = normalizePortfolio(payload);
    expect(out.ok).toBe(true);
    expect(out.holdings).toHaveLength(3);

    const reli = out.holdings.find(h => h.name === 'Reliance Industries');
    expect(reli.qty).toBe(10);
    expect(reli.invested).toBe(24000);
    expect(reli.value).toBe(29000);
    expect(reli.pnl).toBe(5000);
    expect(reli.pnlPct).toBeCloseTo(20.83, 1);
    expect(reli.assetType).toBe('Stock');

    const ppfc = out.holdings.find(h => h.name === 'Parag Parikh Flexi Cap');
    expect(ppfc.assetType).toBe('Mutual Fund');
    expect(ppfc.value).toBeCloseTo(9447.2, 0);

    expect(out.summary.holdingCount).toBe(3);
    expect(out.summary.totalInvested).toBe(50000);
    expect(out.summary.totalValue).toBeCloseTo(57947.2, 0);
    expect(out.summary.totalPnl).toBeCloseTo(7947.2, 0);
  });

  it('uses explicit pnl fields when value/invested are absent', () => {
    const payload = { holdings: [{ name: 'Infosys', qty: 8, pnl: 1200, pnlPct: 12.5 }] };
    const out = normalizePortfolio(payload);
    const infy = out.holdings[0];
    expect(infy.pnl).toBe(1200);
    // summary math: value 0 + invested 0 → pnl falls back to raw
    expect(out.summary).not.toBeNull();
  });

  it('dedups repeated holdings (summary + detail sections)', () => {
    const h = { name: 'HDFC Bank', qty: 20, avgPrice: 1500, currentPrice: 1600 };
    const out = normalizePortfolio({ summary: { holdings: [h] }, detail: { holdings: [h] } });
    expect(out.holdings).toHaveLength(1);
  });

  it('classifies FD/gold/ETF asset types', () => {
    const out = collectHoldings([
      { name: 'SBI Fixed Deposit', qty: 1, invested: 100000, currentValue: 107500 },
      { name: 'Nippon ETF Nifty BeES', symbol: 'NIFTYBEES', qty: 100, avgPrice: 200, currentPrice: 210 },
      { name: 'Sovereign Gold Bond', qty: 5, invested: 25000, currentValue: 31000 },
    ]);
    const types = out.map(h => h.assetType);
    expect(types).toContain('Fixed Income / Gold');
    expect(types).toContain('ETF');
  });

  it('handles string ₹ amounts with commas', () => {
    const out = collectHoldings([{ name: 'Wipro', qty: '25', avgPrice: '₹400', currentPrice: '500.50' }]);
    expect(out[0].qty).toBe(25);
    expect(out[0].avgPrice).toBe(400);
    expect(out[0].currentPrice).toBeCloseTo(500.5, 2);
  });

  it('parses INDMoney per-holding one-day change % (one_day_change_percentage)', () => {
    const out = collectHoldings([{
      investment: 'Motilal Oswal Nifty 500 Momentum 50 ETF',
      total_units: 1990, unit_price: 54.08, invested_amount: 103380.5,
      market_value: 107619.2, one_day_change_percentage: -0.39,
    }]);
    expect(out[0].oneDayChangePct).toBe(-0.39);
  });

  it('plain "change" fields are NOT misread as 1-day % (ambiguous key)', () => {
    const out = collectHoldings([{ name: 'X', qty: 1, change: 12.5, invested: 100, market_value: 110 }]);
    expect(out[0].oneDayChangePct).toBeNull();
  });

  it('flags unknown/empty payloads gracefully', () => {
    expect(normalizePortfolio(null).ok).toBe(false);
    expect(normalizePortfolio('some text').reason).toBe('text-only');
    expect(normalizePortfolio({ foo: 'bar' }).ok).toBe(false);
    expect(normalizePortfolio({ foo: 'bar' }).reason).toBe('no-holdings-found');
  });

  it('walks reasonably-nested trees; depth guard stops pathological nesting', () => {
    // 5 levels deep — inside the guard, must be found.
    let node = { name: 'Deep Co', qty: 1 };
    for (let i = 0; i < 5; i++) node = { nested: node };
    const found = collectHoldings(node);
    expect(found).toHaveLength(1);
    expect(found[0].name).toBe('Deep Co');
    // 12 levels deep — beyond the depth guard, ignored (no crash).
    let deep = { name: 'Too Deep Co', qty: 1 };
    for (let i = 0; i < 12; i++) deep = { nested: deep };
    expect(collectHoldings(deep)).toHaveLength(0);
  });
});

// ---------------- tool payload extraction ----------------
describe('extractToolPayload', () => {
  it('parses JSON text content', () => {
    const result = { content: [{ type: 'text', text: '{"data":{"stocks":[]}}' }] };
    expect(extractToolPayload(result)).toEqual({ data: { stocks: [] } });
  });
  it('returns plain text as-is', () => {
    const result = { content: [{ type: 'text', text: 'Portfolio: ₹12,34,567' }] };
    expect(extractToolPayload(result)).toBe('Portfolio: ₹12,34,567');
  });
  it('uses structuredContent when present', () => {
    const result = { structuredContent: { total: 5 }, content: [] };
    expect(extractToolPayload(result)).toEqual({ total: 5 });
  });
  it('passes through when nothing else matches', () => {
    expect(extractToolPayload({ weird: true })).toEqual({ weird: true });
    expect(extractToolPayload(null)).toBeNull();
  });
});

// ---------------- end-to-end (mocked network) ----------------
describe('OAuth + MCP flow (mocked fetch)', () => {
  const ORIGIN = 'https://smartai.example.com';
  let calls; // record of { url, body }

  beforeEach(() => {
    __resetForTests();
    calls = [];
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    // never leave token state on disk after tests
    try { fs.rmSync(STORE_PATH, { force: true }); } catch { /* ignore */ }
  });

  function parseStubBody(init) {
    if (!init.body) return null;
    const ct = String(
      (init.headers && (init.headers['Content-Type'] || init.headers['content-type'])) || ''
    );
    if (ct.includes('application/x-www-form-urlencoded')) {
      return Object.fromEntries(new URLSearchParams(String(init.body)));
    }
    try { return JSON.parse(init.body); } catch { return null; }
  }

  function stubFetch(handler) {
    vi.stubGlobal('fetch', async (url, init = {}) => {
      const body = parseStubBody(init);
      calls.push({ url: String(url), body, headers: init.headers || {} });
      if (process.env.DEBUG_INDM) console.log('[stub]', String(url), body?.method, 'calls=', calls.length);
      return handler(String(url), body, init);
    });
  }

  it('token / refresh / revoke endpoints receive form-urlencoded bodies (RFC 6749)', async () => {
    stubFetch((url) => {
      if (url === INDM.REGISTER_URL) return jsonRes({ client_id: 'client-form-1' });
      if (url === INDM.TOKEN_URL) return jsonRes({ access_token: 'AT-F', refresh_token: 'RT-F', expires_in: 3600 });
      if (url === INDM.REVOKE_URL) return jsonRes({});
      throw new Error(`unexpected url ${url}`);
    });

    const { state } = await startConnect(ORIGIN);
    await completeConnect({ code: 'c-form', state });
    await refreshAccessToken();
    await disconnect();

    const tokenCalls = calls.filter(c => c.url === INDM.TOKEN_URL);
    expect(tokenCalls).toHaveLength(2); // authorization_code + refresh_token
    for (const c of tokenCalls) {
      const ct = String(c.headers['Content-Type'] || c.headers['content-type'] || '');
      expect(ct).toContain('application/x-www-form-urlencoded');
      expect(ct).not.toContain('json');
      // body must carry the OAuth params in form encoding
      expect(c.body.grant_type).toBeTruthy();
      expect(c.body.client_id).toBe('client-form-1');
    }
    expect(tokenCalls[0].body.code).toBe('c-form');
    expect(tokenCalls[0].body.code_verifier).toBeTruthy();
    expect(tokenCalls[1].body.refresh_token).toBe('RT-F');

    const revokeCalls = calls.filter(c => c.url === INDM.REVOKE_URL);
    expect(revokeCalls).toHaveLength(1);
    const rct = String(revokeCalls[0].headers['Content-Type'] || revokeCalls[0].headers['content-type'] || '');
    expect(rct).toContain('application/x-www-form-urlencoded');
    expect(revokeCalls[0].body.token).toBe('AT-F');

    // registration endpoint stays JSON (RFC 7591)
    const regCalls = calls.filter(c => c.url === INDM.REGISTER_URL);
    expect(regCalls).toHaveLength(1);
    const jct = String(regCalls[0].headers['Content-Type'] || regCalls[0].headers['content-type'] || '');
    expect(jct).toContain('application/json');
  });

  it('register → authorize URL → token exchange → connected status', async () => {
    stubFetch((url, body) => {
      if (url === INDM.REGISTER_URL) return jsonRes({ client_id: 'client-e2e-1' });
      if (url === INDM.TOKEN_URL) {
        expect(body.grant_type).toBe('authorization_code');
        expect(body.code).toBe('auth-code-xyz');
        expect(body.code_verifier).toBeTruthy();
        return jsonRes({ access_token: 'AT-1', refresh_token: 'RT-1', expires_in: 3600, scope: 'portfolio:read' });
      }
      throw new Error(`unexpected url ${url}`);
    });

    const { authorizeUrl, state } = await startConnect(ORIGIN);
    const u = new URL(authorizeUrl);
    expect(u.searchParams.get('client_id')).toBe('client-e2e-1');
    expect(u.searchParams.get('redirect_uri')).toBe(`${ORIGIN}/api/mcp/indmoney/callback`);
    expect(u.searchParams.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(u.searchParams.get('state')).toBe(state);

    // second startConnect reuses the registered client (no re-register)
    await startConnect(ORIGIN);
    const registerCalls = calls.filter(c => c.url === INDM.REGISTER_URL);
    expect(registerCalls).toHaveLength(1);

    const done = await completeConnect({ code: 'auth-code-xyz', state });
    expect(done.ok).toBe(true);
    const st = getStatus();
    expect(st.connected).toBe(true);
    expect(st.hasRefreshToken).toBe(true);
    expect(st.registeredOrigins).toContain(ORIGIN);

    // replaying the same state must fail (single-use)
    await expect(completeConnect({ code: 'x', state })).rejects.toMatchObject({ code: 'BAD_STATE' });
  });

  it('initialize (SSE + session id) → tools/list → tools/call → normalized portfolio', async () => {
    // 1) OAuth exchange first
    stubFetch((url, body) => {
      if (url === INDM.REGISTER_URL) return jsonRes({ client_id: 'client-e2e-2' });
      if (url === INDM.TOKEN_URL) return jsonRes({ access_token: 'AT-2', refresh_token: 'RT-2', expires_in: 3600 });
      if (url === INDM.MCP_URL) {
        if (body.method === 'initialize') {
          return jsonRes(
            { jsonrpc: '2.0', id: body.id, result: { protocolVersion: '2025-06-18', serverInfo: { name: 'indmoney', version: '1' } } },
            { headers: { 'mcp-session-id': 'sess-abc-123' } }
          );
        }
        if (body.method === 'notifications/initialized') return jsonRes('', { status: 202 });
        if (body.method === 'tools/list') {
          return new Response(sseBody([{ jsonrpc: '2.0', id: body.id, result: { tools: [
            { name: 'get_portfolio', description: 'User portfolio holdings and P&L' },
            { name: 'get_price', description: 'live price' },
          ] } }]), { headers: { 'content-type': 'text/event-stream' } });
        }
        if (body.method === 'tools/call') {
          expect(body.params.name).toBe('get_portfolio');
          return jsonRes({ jsonrpc: '2.0', id: body.id, result: { content: [{ type: 'text', text: JSON.stringify({
            data: { stocks: [{ stockName: 'IRFC', quantity: 100, avgPrice: 100, currentPrice: 150 }] },
          }) }] } });
        }
        throw new Error(`unexpected MCP method ${body.method}`);
      }
      throw new Error(`unexpected url ${url}`);
    });

    const { state } = await startConnect(ORIGIN);
    await completeConnect({ code: 'c1', state });

    const { tools } = await listTools({ force: true });
    expect(tools.map(t => t.name)).toEqual(['get_portfolio', 'get_price']);

    const pf = await fetchPortfolio({ force: true });
    expect(pf.ok).toBe(true);
    expect(pf.calls).toHaveLength(1);
    expect(pf.calls[0].tool).toBe('get_portfolio');
    expect(pf.holdings[0].name).toBe('IRFC');
    expect(pf.holdings[0].pnl).toBe(5000);
    expect(pf.summary.totalValue).toBe(15000);
    expect(pf.summary.totalInvested).toBe(10000);
    // cached second read
    const pf2 = await fetchPortfolio({ force: false });
    expect(pf2.cached).toBe(true);

    // session id + bearer must be echoed on the tools/call request
    const mcpCalls = calls.filter(c => c.url === INDM.MCP_URL && c.body.method === 'tools/call');
    expect(mcpCalls).toHaveLength(1);
    expect(mcpCalls[0].headers['Mcp-Session-Id']).toBe('sess-abc-123');
    expect(mcpCalls[0].headers['Authorization']).toBe('Bearer AT-2');

    const st = getStatus();
    expect(st.connected).toBe(true);
    expect(st.toolCount).toBe(2);
    expect(st.lastSyncAt).toBeGreaterThan(0);

    await disconnect();
    expect(getStatus().connected).toBe(false);
  });

  it('networth_holdings(asset_type) — required enum arg: called per value, merged + stamped (THE user-reported bug)', async () => {
    const enumValues = ['stocks', 'mutual_funds'];
    const payloads = {
      stocks: { data: { holdings: [{ stockName: 'IRFC', quantity: 100, avgPrice: 100, currentPrice: 150 }] } },
      mutual_funds: { data: { holdings: [{ scheme_name: 'HDFC Flexi Cap', units: 200, avgPrice: 50, currentPrice: 55 }] } },
    };
    stubFetch((url, body) => {
      if (url === INDM.REGISTER_URL) return jsonRes({ client_id: 'client-nw' });
      if (url === INDM.TOKEN_URL) return jsonRes({ access_token: 'AT-NW', refresh_token: 'RT-NW', expires_in: 3600 });
      if (url === INDM.MCP_URL) {
        if (body.method === 'initialize') return jsonRes({ jsonrpc: '2.0', id: body.id, result: { serverInfo: { name: 'indmoney' } } }, { headers: { 'mcp-session-id': 'nw-1' } });
        if (body.method === 'notifications/initialized') return jsonRes('', { status: 202 });
        if (body.method === 'tools/list') {
          return jsonRes({ jsonrpc: '2.0', id: body.id, result: { tools: [{
            name: 'networth_holdings',
            description: 'Get user net worth holdings by asset type',
            inputSchema: {
              type: 'object',
              properties: { asset_type: { type: 'string', enum: enumValues } },
              required: ['asset_type'],
            },
          }] } });
        }
        if (body.method === 'tools/call') {
          // THE FIX: the tool must now be called WITH asset_type, never {}
          expect(body.params.name).toBe('networth_holdings');
          expect(enumValues).toContain(body.params.arguments.asset_type);
          return jsonRes({ jsonrpc: '2.0', id: body.id, result: { content: [{ type: 'text', text: JSON.stringify(payloads[body.params.arguments.asset_type]) }] } });
        }
        throw new Error(`unexpected MCP method ${body.method}`);
      }
      throw new Error(`unexpected url ${url}`);
    });

    const { state } = await startConnect(ORIGIN);
    await completeConnect({ code: 'nw', state });

    const pf = await fetchPortfolio({ force: true });
    expect(pf.ok).toBe(true);
    // both enum values were called exactly once
    expect(pf.calls).toHaveLength(2);
    expect(pf.calls.map(c => c.args.asset_type).sort()).toEqual(['mutual_funds', 'stocks']);
    // holdings from both calls, merged + deduped
    expect(pf.holdings).toHaveLength(2);
    // asset types stamped from the argument value
    const irfc = pf.holdings.find(h => h.name === 'IRFC');
    expect(irfc.assetType).toBe('Stock');
    const hdfc = pf.holdings.find(h => h.name === 'HDFC Flexi Cap');
    expect(hdfc.assetType).toBe('Mutual Fund');
    expect(pf.summary.totalValue).toBe(15000 + 11000);
    // no empty-args call was ever made
    const emptyCalls = calls.filter(c => c.url === INDM.MCP_URL && c.body.method === 'tools/call' && (!c.body.params.arguments || Object.keys(c.body.params.arguments).length === 0));
    expect(emptyCalls).toHaveLength(0);
  });

  it('one failing asset type is skipped — others still sync (partial failure tolerance)', async () => {
    stubFetch((url, body) => {
      if (url === INDM.REGISTER_URL) return jsonRes({ client_id: 'client-pf' });
      if (url === INDM.TOKEN_URL) return jsonRes({ access_token: 'AT-PF', refresh_token: 'RT-PF', expires_in: 3600 });
      if (url === INDM.MCP_URL) {
        if (body.method === 'initialize') return jsonRes({ jsonrpc: '2.0', id: body.id, result: { serverInfo: { name: 'indmoney' } } }, { headers: { 'mcp-session-id': 'pf-1' } });
        if (body.method === 'notifications/initialized') return jsonRes('', { status: 202 });
        if (body.method === 'tools/list') {
          return jsonRes({ jsonrpc: '2.0', id: body.id, result: { tools: [{
            name: 'networth_holdings',
            description: 'holdings by asset type',
            inputSchema: {
              type: 'object',
              properties: { asset_type: { type: 'string', enum: ['stocks', 'crypto'] } },
              required: ['asset_type'],
            },
          }] } });
        }
        if (body.method === 'tools/call') {
          if (body.params.arguments.asset_type === 'crypto') {
            // server-side validation style failure for this asset type
            return jsonRes({ jsonrpc: '2.0', id: body.id, result: { isError: true, content: [{ type: 'text', text: 'Error executing tool networth_holdings: unsupported asset type crypto' }] } });
          }
          return jsonRes({ jsonrpc: '2.0', id: body.id, result: { content: [{ type: 'text', text: JSON.stringify({ holdings: [{ stockName: 'TCS', quantity: 10, avgPrice: 3500, currentPrice: 4000 }] }) }] } });
        }
        throw new Error(`unexpected MCP method ${body.method}`);
      }
      throw new Error(`unexpected url ${url}`);
    });

    const { state } = await startConnect(ORIGIN);
    await completeConnect({ code: 'pf', state });

    const pf = await fetchPortfolio({ force: true });
    // stocks succeeded, crypto failed → partial sync, NOT a thrown error
    expect(pf.ok).toBe(true);
    expect(pf.holdings[0].name).toBe('TCS');
    expect(pf.failures).toHaveLength(1);
    expect(pf.failures[0].args.asset_type).toBe('crypto');
    expect(pf.failures[0].error).toContain('unsupported asset type');
  });

  it('asset_type WITHOUT enum → known-value fallback calls; only supported values yield data', async () => {
    const supported = new Set(['IND_STOCK', 'MF']);
    stubFetch((url, body) => {
      if (url === INDM.REGISTER_URL) return jsonRes({ client_id: 'client-noenum' });
      if (url === INDM.TOKEN_URL) return jsonRes({ access_token: 'AT-NE', refresh_token: 'RT-NE', expires_in: 3600 });
      if (url === INDM.MCP_URL) {
        if (body.method === 'initialize') return jsonRes({ jsonrpc: '2.0', id: body.id, result: { serverInfo: { name: 'indmoney' } } }, { headers: { 'mcp-session-id': 'ne-1' } });
        if (body.method === 'notifications/initialized') return jsonRes('', { status: 202 });
        if (body.method === 'tools/list') {
          return jsonRes({ jsonrpc: '2.0', id: body.id, result: { tools: [{
            name: 'networth_holdings',
            description: 'holdings by asset type',
            inputSchema: {
              type: 'object',
              properties: { asset_type: { type: 'string', description: 'filter' } },
              required: ['asset_type'],
            },
          }] } });
        }
        if (body.method === 'tools/call') {
          const at = body.params.arguments.asset_type;
          if (!supported.has(at)) {
            return jsonRes({ jsonrpc: '2.0', id: body.id, result: { isError: true, content: [{ type: 'text', text: 'invalid asset type' }] } });
          }
          return jsonRes({ jsonrpc: '2.0', id: body.id, result: { content: [{ type: 'text', text: JSON.stringify({ holdings: at === 'IND_STOCK' ? [{ stockName: 'WIPRO', quantity: 50, avgPrice: 400, currentPrice: 450 }] : [{ scheme_name: 'SBI Bluechip', units: 10, avgPrice: 100, currentPrice: 120 }] }) }] } });
        }
        throw new Error(`unexpected MCP method ${body.method}`);
      }
      throw new Error(`unexpected url ${url}`);
    });

    const { state } = await startConnect(ORIGIN);
    await completeConnect({ code: 'ne', state });

    const pf = await fetchPortfolio({ force: true });
    expect(pf.ok).toBe(true);
    expect(pf.holdings.map(h => h.name).sort()).toEqual(['SBI Bluechip', 'WIPRO']);
    expect(pf.calls).toHaveLength(2); // only IND_STOCK + MF succeeded
    expect(pf.failures.length).toBeGreaterThanOrEqual(8); // the rest were skipped
    // never exceeded the call budget
    const allToolCalls = calls.filter(c => c.url === INDM.MCP_URL && c.body.method === 'tools/call');
    expect(allToolCalls.length).toBeLessThanOrEqual(12);
  });

  it('every call fails → the underlying tool error is thrown (error surfacing preserved)', async () => {
    stubFetch((url, body) => {
      if (url === INDM.REGISTER_URL) return jsonRes({ client_id: 'client-allfail' });
      if (url === INDM.TOKEN_URL) return jsonRes({ access_token: 'AT-AF', refresh_token: 'RT-AF', expires_in: 3600 });
      if (url === INDM.MCP_URL) {
        if (body.method === 'initialize') return jsonRes({ jsonrpc: '2.0', id: body.id, result: { serverInfo: { name: 'indmoney' } } }, { headers: { 'mcp-session-id': 'af-1' } });
        if (body.method === 'notifications/initialized') return jsonRes('', { status: 202 });
        if (body.method === 'tools/list') {
          return jsonRes({ jsonrpc: '2.0', id: body.id, result: { tools: [{
            name: 'networth_holdings',
            description: 'holdings',
            inputSchema: { type: 'object', properties: { asset_type: { type: 'string', enum: ['stocks'] } }, required: ['asset_type'] },
          }] } });
        }
        if (body.method === 'tools/call') {
          return jsonRes({ jsonrpc: '2.0', id: body.id, result: { isError: true, content: [{ type: 'text', text: 'Error executing tool networth_holdings: 1 validation error for networth_holdingsArguments asset_type Field required' }] } });
        }
        throw new Error(`unexpected MCP method ${body.method}`);
      }
      throw new Error(`unexpected url ${url}`);
    });

    const { state } = await startConnect(ORIGIN);
    await completeConnect({ code: 'af', state });

    await expect(fetchPortfolio({ force: true })).rejects.toMatchObject({ code: 'TOOL_ERROR' });
  });

  it('real payload e2e: enum sweep + official summary + positions + no double-count', async () => {
    const ENUM = ['IND_STOCK', 'MF'];
    const RESPONSES = {
      IND_STOCK: {
        is_cached_response: false,
        positions: null,
        mtf_positions: [{ ind_stock_id: 'INDS18666', isin_code: 'INF200KA1FS1', quantity: 45, avg_price: 260.57, buy_val: 11725.65, realised_gains: 0, t1_qty: 10, position_id: '92966827' }],
        asset_summary: { total_value: 328618.18, invested: 304979.08, one_day_change: -1824.69, one_day_change_percentage: -0.55 },
        holdings: [
          { investment_code: 'INDS33035', investment: 'Motilal Oswal Nifty 500 Momentum 50 ETF', asset_type: 'STOCK', invested_amount: 103380.5, market_value: 107619.2, total_pnl: 4238.7, pnl_per: 4.1, total_units: 1990, unit_price: 54.08 },
          { investment_code: 'INDS19602', investment: 'Nippon India ETF Nifty Midcap 150', asset_type: 'STOCK', invested_amount: 73056.7, market_value: 78893.1, total_pnl: 5836.4, pnl_per: 7.99, total_units: 330, unit_price: 239.07 },
        ],
      },
      MF: {
        positions: null,
        mtf_positions: null,
        asset_summary: { total_value: 328618.18, invested: 304979.08, one_day_change: -1824.69, one_day_change_percentage: -0.55 },
        holdings: [
          { investment_code: 'INDS41001', investment: 'HDFC Flexi Cap Fund', asset_type: 'MF', invested_amount: 50000, market_value: 55000, total_pnl: 5000, pnl_per: 10, total_units: 100, unit_price: 550 },
        ],
      },
    };
    const called = [];
    stubFetch((url, body) => {
      if (url === INDM.REGISTER_URL) return jsonRes({ client_id: 'client-real' });
      if (url === INDM.TOKEN_URL) return jsonRes({ access_token: 'AT-REAL', refresh_token: 'RT-REAL', expires_in: 3600 });
      if (url === INDM.MCP_URL) {
        if (body.method === 'initialize') return jsonRes({ jsonrpc: '2.0', id: body.id, result: { serverInfo: { name: 'indmoney' } } }, { headers: { 'mcp-session-id': 'real-1' } });
        if (body.method === 'notifications/initialized') return jsonRes('', { status: 202 });
        if (body.method === 'tools/list') {
          return jsonRes({ jsonrpc: '2.0', id: body.id, result: { tools: [{
            name: 'networth_holdings',
            description: 'Get user net worth holdings by asset type',
            inputSchema: { type: 'object', properties: { asset_type: { type: 'string', enum: ENUM } }, required: ['asset_type'] },
          }] } });
        }
        if (body.method === 'tools/call') {
          const at = body.params.arguments.asset_type;
          called.push(at);
          return jsonRes({ jsonrpc: '2.0', id: body.id, result: { content: [{ type: 'text', text: JSON.stringify(RESPONSES[at]) }] } });
        }
        throw new Error(`unexpected MCP method ${body.method}`);
      }
      throw new Error(`unexpected url ${url}`);
    });

    const { state } = await startConnect(ORIGIN);
    await completeConnect({ code: 'real', state });

    const pf = await fetchPortfolio({ force: true });
    expect(pf.ok).toBe(true);
    expect(called.sort()).toEqual(['IND_STOCK', 'MF']);
    // 3 holdings total: 2 from IND_STOCK + 1 from MF — MTF NOT counted
    expect(pf.holdings).toHaveLength(3);
    expect(pf.holdings.map(h => h.name)).toContain('HDFC Flexi Cap Fund');
    // official summary wins (consistent across both calls) + holdingCount
    expect(pf.officialSummary).toBe(true);
    expect(pf.summary.totalValue).toBe(328618.18);
    expect(pf.summary.totalInvested).toBe(304979.08);
    expect(pf.summary.oneDayChange).toBe(-1824.69);
    expect(pf.summary.holdingCount).toBe(3);
    // MTF position extracted separately, resolved via codeMap
    expect(pf.positions).toHaveLength(1);
    expect(pf.positions[0].kind).toBe('MTF');
    expect(pf.positions[0].qty).toBe(45);
    // HDFC (from MF arg, unclassifiable name) gets the arg-stamped type
    expect(pf.holdings.find(h => h.name === 'HDFC Flexi Cap Fund').assetType).toBe('Mutual Fund');
    // ETFs keep their own classification (name wins over arg stamp)
    expect(pf.holdings.find(h => h.name.includes('Motilal')).assetType).toBe('ETF');
    // assetEnum stamp: the raw enum rides along for the portfolio-sync mapper
    expect(pf.holdings.find(h => h.name.includes('Motilal')).assetEnum).toBe('IND_STOCK');
    expect(pf.holdings.find(h => h.name === 'HDFC Flexi Cap Fund').assetEnum).toBe('MF');
  });

  it('tool 1 yields no holdings → sequential fallback to tool 2', async () => {
    stubFetch((url, body) => {
      if (url === INDM.REGISTER_URL) return jsonRes({ client_id: 'client-seq' });
      if (url === INDM.TOKEN_URL) return jsonRes({ access_token: 'AT-SEQ', refresh_token: 'RT-SEQ', expires_in: 3600 });
      if (url === INDM.MCP_URL) {
        if (body.method === 'initialize') return jsonRes({ jsonrpc: '2.0', id: body.id, result: { serverInfo: { name: 'x' } } }, { headers: { 'mcp-session-id': 'seq-1' } });
        if (body.method === 'notifications/initialized') return jsonRes('', { status: 202 });
        if (body.method === 'tools/list') {
          // tool 1 out-ranks tool 2 (portfolio 10 + summary 2 > holdings 8)
          return jsonRes({ jsonrpc: '2.0', id: body.id, result: { tools: [
            { name: 'portfolio_summary_snapshot', description: 'Portfolio summary snapshot overview', inputSchema: { type: 'object', properties: {}, required: [] } },
            { name: 'get_holdings', description: 'User holdings', inputSchema: { type: 'object', properties: {}, required: [] } },
          ] } });
        }
        if (body.method === 'tools/call') {
          if (body.params.name === 'portfolio_summary_snapshot') {
            // summary-only tool: no holdings, but a valid asset_summary
            return jsonRes({ jsonrpc: '2.0', id: body.id, result: { content: [{ type: 'text', text: JSON.stringify({ asset_summary: { total_value: 100, invested: 90 } }) }] } });
          }
          return jsonRes({ jsonrpc: '2.0', id: body.id, result: { content: [{ type: 'text', text: JSON.stringify({ holdings: [{ stockName: 'TATA POWER', quantity: 20, avgPrice: 250, currentPrice: 280 }] }) }] } });
        }
        throw new Error(`unexpected MCP method ${body.method}`);
      }
      throw new Error(`unexpected url ${url}`);
    });

    const { state } = await startConnect(ORIGIN);
    await completeConnect({ code: 'seq', state });

    const pf = await fetchPortfolio({ force: true });
    expect(pf.ok).toBe(true);
    expect(pf.holdings[0].name).toBe('TATA POWER');
    // both tools were called (tool 1 first, then fallback) — but holdings came only from tool 2
    expect(pf.calls.map(c => c.tool)).toEqual(['portfolio_summary_snapshot', 'get_holdings']);
    // official summary from the snapshot tool is still honored
    expect(pf.officialSummary).toBe(true);
    expect(pf.summary.totalValue).toBe(100);
  });

  it('unsatisfiable required arg (symbol) → legacy empty-args attempt kept', async () => {
    stubFetch((url, body) => {
      if (url === INDM.REGISTER_URL) return jsonRes({ client_id: 'client-sym' });
      if (url === INDM.TOKEN_URL) return jsonRes({ access_token: 'AT-SY', refresh_token: 'RT-SY', expires_in: 3600 });
      if (url === INDM.MCP_URL) {
        if (body.method === 'initialize') return jsonRes({ jsonrpc: '2.0', id: body.id, result: { serverInfo: { name: 'x' } } }, { headers: { 'mcp-session-id': 'sy-1' } });
        if (body.method === 'notifications/initialized') return jsonRes('', { status: 202 });
        if (body.method === 'tools/list') {
          return jsonRes({ jsonrpc: '2.0', id: body.id, result: { tools: [{
            name: 'portfolio_details',
            description: 'Portfolio holdings and positions',
            inputSchema: { type: 'object', properties: { symbol: { type: 'string' } }, required: ['symbol'] },
          }] } });
        }
        if (body.method === 'tools/call') {
          // server actually tolerates missing symbol (has a default)
          return jsonRes({ jsonrpc: '2.0', id: body.id, result: { content: [{ type: 'text', text: JSON.stringify({ holdings: [{ stockName: 'INFY', quantity: 5, avgPrice: 1500, currentPrice: 1600 }] }) }] } });
        }
        throw new Error(`unexpected MCP method ${body.method}`);
      }
      throw new Error(`unexpected url ${url}`);
    });

    const { state } = await startConnect(ORIGIN);
    await completeConnect({ code: 'sy', state });

    const pf = await fetchPortfolio({ force: true });
    expect(pf.ok).toBe(true);
    expect(pf.holdings[0].name).toBe('INFY');
    expect(pf.calls).toHaveLength(1);
    expect(pf.calls[0].args).toEqual({});
  });

  it('401 mid-session triggers one refresh + retry, then succeeds', async () => {
    let mcp401Once = false;
    let tokenCalls = 0;
    stubFetch((url, body) => {
      if (url === INDM.REGISTER_URL) return jsonRes({ client_id: 'client-e2e-3' });
      if (url === INDM.TOKEN_URL) {
        tokenCalls += 1;
        if (body.grant_type === 'authorization_code') return jsonRes({ access_token: 'AT-A', refresh_token: 'RT-A', expires_in: 3600 });
        return jsonRes({ access_token: 'AT-B', refresh_token: 'RT-A', expires_in: 3600 });
      }
      if (url === INDM.MCP_URL) {
        if (body.method === 'initialize') return jsonRes({ jsonrpc: '2.0', id: body.id, result: { serverInfo: { name: 'x' } } }, { headers: { 'mcp-session-id': 's1' } });
        if (body.method === 'notifications/initialized') return jsonRes('', { status: 202 });
        if (body.method === 'tools/list') {
          if (!mcp401Once) { mcp401Once = true; return jsonRes({ error: 'invalid_token' }, { status: 401 }); }
          return jsonRes({ jsonrpc: '2.0', id: body.id, result: { tools: [{ name: 'get_portfolio', description: 'portfolio' }] } });
        }
        throw new Error(`unexpected ${body.method}`);
      }
      throw new Error(`unexpected url ${url}`);
    });

    const { state } = await startConnect(ORIGIN);
    await completeConnect({ code: 'c', state });
    const { tools } = await listTools({ force: true });
    expect(tools[0].name).toBe('get_portfolio');
    expect(tokenCalls).toBe(2); // initial + refresh
    // retry used the refreshed bearer
    const retryCall = calls.find(c => c.url === INDM.MCP_URL && c.body.method === 'tools/list' && c.headers['Authorization'] === 'Bearer AT-B');
    expect(retryCall).toBeTruthy();
  });

  it('failed refresh revokes the connection (REFRESH_FAILED → NOT_CONNECTED)', async () => {
    stubFetch((url, body) => {
      if (url === INDM.REGISTER_URL) return jsonRes({ client_id: 'client-e2e-4' });
      if (url === INDM.TOKEN_URL) {
        if (body.grant_type === 'authorization_code') return jsonRes({ access_token: 'AT-C', refresh_token: 'RT-C', expires_in: 3600 });
        return jsonRes({ error: 'invalid_grant' }, { status: 400 });
      }
      if (url === INDM.REVOKE_URL) return jsonRes({});
      if (url === INDM.MCP_URL) {
        if (body.method === 'initialize') return jsonRes({ jsonrpc: '2.0', id: body.id, result: {} }, { headers: { 'mcp-session-id': 's' } });
        if (body.method === 'notifications/initialized') return jsonRes('', { status: 202 });
        if (body.method === 'tools/list') return jsonRes({ error: 'invalid_token' }, { status: 401 });
      }
      throw new Error(`unexpected url ${url}`);
    });

    const { state } = await startConnect(ORIGIN);
    await completeConnect({ code: 'c', state });
    // 401 on tools/list → refresh fails (invalid_grant) → connection revoked.
    await expect(listTools({ force: true })).rejects.toMatchObject({ code: 'REFRESH_FAILED' });
    expect(getStatus().connected).toBe(false);
  });

  it('IndmError carries status + code for route mapping', () => {
    const e = new IndmError('boom', 401, 'TEST');
    expect(e.status).toBe(401);
    expect(e.code).toBe('TEST');
    expect(e instanceof Error).toBe(true);
  });
});
