// ============================================================
// test/tapetideMcp.test.ts — Tapetide India MCP connector suite
// Covers: PKCE correctness, SSE/JSON-RPC parsing, authorize URL,
// tool catalog categorization, payload extraction, and the fully
// mocked OAuth + MCP flow (register → authorize → token →
// initialize → tools/list → tools/call), status safety (no token
// leaks), 401-refresh-retry, and disconnect semantics.
// ============================================================
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STORE_PATH = path.join(__dirname, '..', 'server', 'data', 'mcp-tapetide.json');

const {
  pkceGenerate, pkceChallengeFrom, buildAuthorizeUrl, parseSSEOrJSON,
  categorizeTool, categoryLabel, buildCatalog, extractToolPayload,
  startConnect, completeConnect, getPendingOrigin, disconnect,
  refreshAccessToken, getStatus, listTools, callTool,
  __resetForTests, TptError, TPT,
} = await import('../server/mcp/tapetide.js');

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
    expect(pkceChallengeFrom(verifier)).toMatch(/^[A-Za-z0-9_-]{43}$/);
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

  it('returns [] for garbage / empty', () => {
    expect(parseSSEOrJSON('')).toEqual([]);
    expect(parseSSEOrJSON('not json at all')).toEqual([]);
  });
});

// ---------------- authorize URL ----------------
describe('buildAuthorizeUrl', () => {
  it('contains all required OAuth + PKCE params against tapetide.com', () => {
    const url = buildAuthorizeUrl({
      clientId: 'tapetide-test-1',
      redirectUri: 'https://smartai.example.com/api/mcp/tapetide/callback',
      state: 'st-123',
      codeChallenge: 'chal-abc',
    });
    const u = new URL(url);
    expect(u.origin + u.pathname).toBe('https://mcp.tapetide.com/authorize');
    expect(u.searchParams.get('client_id')).toBe('tapetide-test-1');
    expect(u.searchParams.get('redirect_uri')).toBe('https://smartai.example.com/api/mcp/tapetide/callback');
    expect(u.searchParams.get('response_type')).toBe('code');
    expect(u.searchParams.get('scope')).toBe('openid email profile');
    expect(u.searchParams.get('state')).toBe('st-123');
    expect(u.searchParams.get('code_challenge')).toBe('chal-abc');
    expect(u.searchParams.get('code_challenge_method')).toBe('S256');
  });
});

// ---------------- tool catalog categorization ----------------
describe('categorizeTool / buildCatalog', () => {
  const TOOLS = [
    { name: 'analyze_stock', description: 'Deep AI analysis of any NSE/BSE stock with a verdict' },
    { name: 'get_quote', description: 'Live price quote with OHLC for a symbol' },
    { name: 'top_gainers', description: 'Today top gainers leaderboard on NSE' },
    { name: 'financials', description: 'Quarterly earnings, balance sheet, profit and loss' },
    { name: 'stock_news', description: 'Latest news headlines and sentiment for a company' },
    { name: 'find_pattern', description: 'Candlestick pattern scanner with RSI and MACD' },
    { name: 'search_company', description: 'Search companies by name or sector' },
    { name: 'mystery_gadget', description: '' },
  ];

  it('buckets tools into the expected categories', () => {
    const byName = Object.fromEntries(TOOLS.map(t => [t.name, categorizeTool(t)]));
    expect(byName.analyze_stock).toBe('analysis');
    expect(byName.get_quote).toBe('quotes');
    expect(byName.top_gainers).toBe('screener');
    expect(byName.financials).toBe('fundamentals');
    expect(byName.stock_news).toBe('news');
    expect(byName.find_pattern).toBe('patterns');
    expect(byName.search_company).toBe('reference');
    expect(byName.mystery_gadget).toBe('other');
  });

  it('buildCatalog groups, sorts deterministically, and alphabetizes tools', () => {
    const catalog = buildCatalog(TOOLS);
    expect(catalog.length).toBeGreaterThan(3);
    const keys = catalog.map(c => c.key);
    // analysis (weight 0) before screener (weight 2) before other (fallback last)
    expect(keys.indexOf('analysis')).toBeLessThan(keys.indexOf('screener'));
    expect(keys[keys.length - 1]).toBe('other');
    for (const cat of catalog) {
      const names = cat.tools.map(t => t.name);
      const sorted = [...names].sort((a, b) => a.localeCompare(b));
      expect(names).toEqual(sorted);
    }
    // counts sum to total tools
    const total = catalog.reduce((n, c) => n + c.tools.length, 0);
    expect(total).toBe(TOOLS.length);
  });

  it('empty / null tool lists survive', () => {
    expect(buildCatalog(null)).toEqual([]);
    expect(buildCatalog([])).toEqual([]);
    expect(categorizeTool(null)).toBe('other');
    expect(categoryLabel('analysis')).toBe('AI Analysis & Signals');
    expect(categoryLabel('nope')).toBe('Other Tools');
  });
});

// ---------------- payload extraction ----------------
describe('extractToolPayload', () => {
  it('joins text content blocks', () => {
    const out = extractToolPayload({ content: [{ type: 'text', text: 'RELIANCE' }, { type: 'text', text: 'BUY' }] });
    expect(out).toBe('RELIANCE\nBUY');
  });

  it('re-parses JSON text content into an object', () => {
    const out = extractToolPayload({ content: [{ type: 'text', text: '{"verdict":"BUY","score":8}' }] });
    expect(out).toEqual({ verdict: 'BUY', score: 8 });
  });

  it('keeps plain text as text', () => {
    const out = extractToolPayload({ content: [{ type: 'text', text: 'Analysis: strong uptrend, hold.' }] });
    expect(out).toBe('Analysis: strong uptrend, hold.');
  });

  it('uses structuredContent when present', () => {
    const out = extractToolPayload({ structuredContent: { rows: [1, 2] } });
    expect(out).toEqual({ rows: [1, 2] });
  });

  it('summarizes non-text content shape', () => {
    const out = extractToolPayload({ content: [{ type: 'image', data: 'x' }] });
    expect(out).toEqual([{ type: 'image', hasData: true }]);
  });

  it('null-safe', () => {
    expect(extractToolPayload(null)).toBe(null);
  });
});

// ---------------- mocked OAuth + MCP flow ----------------
describe('Tapetide OAuth + MCP flow (mocked fetch)', () => {
  const ORIGIN = 'https://smartai.example.com';
  let calls;

  beforeEach(() => {
    __resetForTests();
    calls = [];
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    try { fs.rmSync(STORE_PATH, { force: true }); } catch { /* ignore */ }
  });

  function parseStubBody(init) {
    if (!init.body) return null;
    const ct = String((init.headers && (init.headers['Content-Type'] || init.headers['content-type'])) || '');
    if (ct.includes('application/x-www-form-urlencoded')) {
      return Object.fromEntries(new URLSearchParams(String(init.body)));
    }
    try { return JSON.parse(init.body); } catch { return null; }
  }

  function stubFetch(handler) {
    vi.stubGlobal('fetch', async (url, init = {}) => {
      const body = parseStubBody(init);
      calls.push({ url: String(url), body, headers: init.headers || {} });
      return handler(String(url), body, init);
    });
  }

  it('token endpoint receives form-urlencoded bodies (RFC 6749); registration stays JSON', async () => {
    stubFetch((url) => {
      if (url === TPT.REGISTER_URL) return jsonRes({ client_id: 'tpt-client-1' });
      if (url === TPT.TOKEN_URL) return jsonRes({ access_token: 'AT-1', refresh_token: 'RT-1', expires_in: 3600 });
      if (url === TPT.MCP_URL) return jsonRes({ jsonrpc: '2.0', id: 1, result: {} });
      throw new Error(`unexpected url ${url}`);
    });

    const { state } = await startConnect(ORIGIN);
    await completeConnect({ code: 'c-1', state });
    await refreshAccessToken();

    const tokenCalls = calls.filter(c => c.url === TPT.TOKEN_URL);
    expect(tokenCalls).toHaveLength(2); // authorization_code + refresh_token
    for (const c of tokenCalls) {
      const ct = String(c.headers['Content-Type'] || c.headers['content-type'] || '');
      expect(ct).toContain('application/x-www-form-urlencoded');
      expect(c.body.client_id).toBe('tpt-client-1');
    }
    expect(tokenCalls[0].body.grant_type).toBe('authorization_code');
    expect(tokenCalls[0].body.code).toBe('c-1');
    expect(tokenCalls[0].body.code_verifier).toBeTruthy();
    expect(tokenCalls[1].body.grant_type).toBe('refresh_token');
    expect(tokenCalls[1].body.refresh_token).toBe('RT-1');

    // DCR body: JSON, openid scopes, public client, tapetide callback
    const regCalls = calls.filter(c => c.url === TPT.REGISTER_URL);
    expect(regCalls).toHaveLength(1);
    expect(regCalls[0].body.scope).toBe('openid email profile');
    expect(regCalls[0].body.token_endpoint_auth_method).toBe('none');
    expect(regCalls[0].body.redirect_uris[0]).toBe(`${ORIGIN}/api/mcp/tapetide/callback`);
  });

  it('register → authorize URL → token exchange → connected status → pending origin', async () => {
    stubFetch((url, body) => {
      if (url === TPT.REGISTER_URL) return jsonRes({ client_id: 'tpt-e2e' });
      if (url === TPT.TOKEN_URL) {
        expect(body.grant_type).toBe('authorization_code');
        expect(body.code).toBe('auth-code-xyz');
        return jsonRes({ access_token: 'AT-1', refresh_token: 'RT-1', expires_in: 3600, scope: 'openid email profile' });
      }
      if (url === TPT.MCP_URL) return jsonRes({ jsonrpc: '2.0', id: 1, result: {} });
      throw new Error(`unexpected url ${url}`);
    });

    const { authorizeUrl, state } = await startConnect(ORIGIN);
    const u = new URL(authorizeUrl);
    expect(u.searchParams.get('client_id')).toBe('tpt-e2e');
    expect(u.searchParams.get('redirect_uri')).toBe(`${ORIGIN}/api/mcp/tapetide/callback`);
    expect(u.searchParams.get('code_challenge_method')).toBe('S256');

    // pending origin readable before completion
    expect(getPendingOrigin(state)).toBe(ORIGIN);

    await completeConnect({ code: 'auth-code-xyz', state });

    const st = getStatus();
    expect(st.ok).toBe(true);
    expect(st.connected).toBe(true);
    expect(st.connectedAt).toBeGreaterThan(0);
    // NO tokens in the public status snapshot
    expect(JSON.stringify(st)).not.toContain('AT-1');
    expect(JSON.stringify(st)).not.toContain('RT-1');

    // state is single-use → second attempt fails
    await expect(completeConnect({ code: 'x', state })).rejects.toThrow(/Unknown or expired OAuth state/);
  });

  it('connect errors: denied / missing code / bad state / token failure', async () => {
    stubFetch((url) => {
      if (url === TPT.REGISTER_URL) return jsonRes({ client_id: 'tpt-err' });
      if (url === TPT.TOKEN_URL) return jsonRes({ error: 'invalid_grant', error_description: 'bad code' }, { status: 400 });
      if (url === TPT.MCP_URL) return jsonRes({ jsonrpc: '2.0', id: 1, result: {} });
      throw new Error(`unexpected url ${url}`);
    });

    await expect(completeConnect({ error: 'access_denied', state: 'nope' }))
      .rejects.toThrow(/authorization denied/i);

    await expect(completeConnect({ state: 'nope' })).rejects.toThrow(/Missing authorization code/i);

    const { state } = await startConnect(ORIGIN);
    await expect(completeConnect({ code: 'c', state })).rejects.toThrow(/Token exchange failed: bad code/i);

    // failed exchange → still NOT connected
    expect(getStatus().connected).toBe(false);
  });

  it('MCP session: initialize → tools/list (SSE) → tools/call; session-id header reused', async () => {
    // Phase 1: connect.
    stubFetch((url) => {
      if (url === TPT.REGISTER_URL) return jsonRes({ client_id: 'tpt-mcp' });
      if (url === TPT.TOKEN_URL) return jsonRes({ access_token: 'AT-M', refresh_token: 'RT-M', expires_in: 3600 });
      throw new Error(`unexpected url ${url}`);
    });
    const { state } = await startConnect(ORIGIN);
    await completeConnect({ code: 'c-mcp', state });

    // Phase 2: MCP with SSE responses.
    let rpcId = 100;
    const mcpCalls = [];
    stubFetch((url, body, init) => {
      if (url !== TPT.MCP_URL) return jsonRes({ jsonrpc: '2.0', id: 1, result: {} });
      mcpCalls.push({ body, auth: init.headers?.Authorization, sid: init.headers?.['Mcp-Session-Id'] });
      rpcId += 1;
      const respId = body?.id ?? rpcId;
      if (body?.method === 'initialize') {
        return jsonRes(sseBody([{ jsonrpc: '2.0', id: respId, result: { serverInfo: { name: 'tapetide-mcp', version: '1.0' }, protocolVersion: '2025-03-26' } }]), { headers: { 'mcp-session-id': 'sess-tpt-1' } });
      }
      if (body?.method === 'tools/list') {
        return jsonRes(sseBody([{ jsonrpc: '2.0', id: respId, result: { tools: [
          { name: 'analyze_stock', description: 'AI analysis for NSE stock', inputSchema: { type: 'object', properties: { symbol: {} } } },
          { name: 'get_quote', description: 'live quote', inputSchema: { type: 'object', properties: {} } },
        ] } }]));
      }
      if (body?.method === 'tools/call') {
        return jsonRes({ jsonrpc: '2.0', id: respId, result: { content: [{ type: 'text', text: '{"verdict":"HOLD","note":"range-bound"}' }] } });
      }
      // notifications/initialized → 202, no body
      return { ok: true, status: 202, headers: new Map(), text: async () => '' };
    });

    const { tools, cached } = await listTools();
    expect(cached).toBe(false);
    expect(tools).toHaveLength(2);
    expect(tools[0].name).toBe('analyze_stock');

    // second call hits the cache → no new MCP calls
    const before = mcpCalls.length;
    const { cached: c2 } = await listTools();
    expect(c2).toBe(true);
    expect(mcpCalls.length).toBe(before);

    // Authorization bearer + session id wired on MCP calls
    const initCall = mcpCalls.find(c => c.body?.method === 'initialize');
    expect(initCall.auth).toBe('Bearer AT-M');
    const toolsCall = mcpCalls.find(c => c.body?.method === 'tools/list');
    expect(toolsCall.sid).toBe('sess-tpt-1');

    // status reflects the server name + tools count
    const st = getStatus();
    expect(st.serverName).toBe('tapetide-mcp');
    expect(st.toolsCount).toBe(2);
    expect(st.registeredOrigins).toBe(1);

    // callTool parses the JSON text content back into an object
    const payload = extractToolPayload(await callTool('analyze_stock', { symbol: 'RELIANCE' }));
    expect(payload).toEqual({ verdict: 'HOLD', note: 'range-bound' });
    const callBody = mcpCalls.find(c => c.body?.method === 'tools/call')?.body;
    expect(callBody.params.name).toBe('analyze_stock');
    expect(callBody.params.arguments).toEqual({ symbol: 'RELIANCE' });
  });

  it('tools/call isError → TptError with the tool message', async () => {
    stubFetch((url) => {
      if (url === TPT.REGISTER_URL) return jsonRes({ client_id: 'tpt-errtool' });
      if (url === TPT.TOKEN_URL) return jsonRes({ access_token: 'AT-E', refresh_token: 'RT-E', expires_in: 3600 });
      if (url === TPT.MCP_URL) {
        return jsonRes({ jsonrpc: '2.0', id: 1, result: { isError: true, content: [{ type: 'text', text: 'symbol not found' }] } });
      }
      throw new Error(`unexpected url ${url}`);
    });
    const { state } = await startConnect(ORIGIN);
    await completeConnect({ code: 'c-e', state });
    await expect(callTool('analyze_stock', { symbol: 'XXXX' })).rejects.toThrow(/symbol not found/);
  });

  it('401 on MCP → transparent refresh + one retry', async () => {
    stubFetch((url) => {
      if (url === TPT.REGISTER_URL) return jsonRes({ client_id: 'tpt-401' });
      if (url === TPT.TOKEN_URL) return jsonRes({ access_token: 'AT-NEW', refresh_token: 'RT-401', expires_in: 3600 });
      if (url === TPT.MCP_URL) {
        // First MCP call 401s (no session yet) → retry after refresh succeeds.
        return { ok: false, status: 401, headers: new Map(), text: async () => '{"error":"authentication_required"}' };
      }
      throw new Error(`unexpected url ${url}`);
    });
    const { state } = await startConnect(ORIGIN);
    await completeConnect({ code: 'c-401', state });
    // Every MCP attempt 401s → after ONE refresh retry it surfaces 401.
    await expect(listTools()).rejects.toThrow(/401|MCP_HTTP_ERROR|UNAUTHORIZED/i);
    const tokenCalls = calls.filter(c => c.url === TPT.TOKEN_URL);
    expect(tokenCalls.length).toBeGreaterThanOrEqual(2); // original + at least one refresh
  });

  it('disconnect clears connection (no revoke endpoint — local forget only)', async () => {
    stubFetch((url) => {
      if (url === TPT.REGISTER_URL) return jsonRes({ client_id: 'tpt-disc' });
      if (url === TPT.TOKEN_URL) return jsonRes({ access_token: 'AT-D', refresh_token: 'RT-D', expires_in: 3600 });
      if (url === TPT.MCP_URL) return jsonRes({ jsonrpc: '2.0', id: 1, result: {} });
      throw new Error(`unexpected url ${url}`);
    });
    const { state } = await startConnect(ORIGIN);
    await completeConnect({ code: 'c-d', state });
    expect(getStatus().connected).toBe(true);
    await disconnect();
    const st = getStatus();
    expect(st.connected).toBe(false);
    expect(st.toolsCount).toBe(0);
    expect(st.connectedAt).toBe(null);
    // next call fails as NOT connected
    await expect(callTool('x')).rejects.toThrow(/not connected/i);
  });

  it('bad origin rejected before any network call', async () => {
    stubFetch(() => { throw new Error('should not be called'); });
    await expect(startConnect('not-a-url')).rejects.toThrow(/Invalid origin/i);
  });
});
