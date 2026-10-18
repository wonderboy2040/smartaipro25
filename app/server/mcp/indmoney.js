// ============================================================
// server/mcp/indmoney.js — INDMoney Portfolio MCP Connector
// ------------------------------------------------------------
// Connects the SmartAI site to INDMoney's official MCP server
// (https://mcp.indmoney.com/mcp) so the user's real portfolio
// (stocks, MFs, FDs, etc.) can be displayed inside the app.
//
// What this module implements:
//  • OAuth 2.0 Authorization Code + PKCE (S256) flow against
//    INDMoney's authorization server (issuer https://mcp.indmoney.com/)
//  • RFC 7591 Dynamic Client Registration — the server registers
//    itself per deployment origin (Render / localhost), so no
//    manual client-id setup is needed by the user.
//  • MCP Streamable HTTP transport (JSON-RPC 2.0):
//      initialize → notifications/initialized → tools/list → tools/call
//    Handles both `application/json` and `text/event-stream` (SSE)
//    responses, plus Mcp-Session-Id lifecycle.
//  • Token lifecycle: expiry-aware access, transparent refresh,
//    revocation on disconnect, server-side persistence.
//  • Schema-agnostic portfolio normalizer: whatever shape INDMoney
//    returns is walked and converted into a unified
//    { holdings[], summary{} } view (with raw fallback).
//
// SECURITY: access/refresh tokens live ONLY in server/data/
// (never sent to the browser). The browser talks to our own
// authed /api/mcp/indmoney/* endpoints.
// ============================================================
import crypto from 'node:crypto';
import { loadJSON, saveJSON } from '../lib/store.js';
import { durablePut } from './durable.js';

// ---------------- INDMoney endpoints (fixed) ----------------
export const INDM = {
  MCP_URL: 'https://mcp.indmoney.com/mcp',
  AUTHORIZE_URL: 'https://mcp.indmoney.com/authorize',
  TOKEN_URL: 'https://mcp.indmoney.com/token',
  REGISTER_URL: 'https://mcp.indmoney.com/register',
  REVOKE_URL: 'https://mcp.indmoney.com/revoke',
  SCOPES: 'portfolio:read market:read',
  PROTOCOL_VERSION: '2025-03-26',
  CLIENT_NAME: 'SmartAI Trading Suite',
};

const STORE_FILE = 'mcp-indmoney.json';
const PENDING_TTL = 10 * 60 * 1000;   // OAuth pending state validity: 10 min
const TOKEN_BUFFER = 60 * 1000;       // refresh 60s before actual expiry
const MCP_TIMEOUT = 20_000;           // per-request MCP/OAuth timeout
const TOOLS_TTL = 10 * 60 * 1000;     // cache tools/list for 10 min
const PORTFOLIO_TTL = 60_000;         // cache portfolio fetch for 60s

// ---------------- persistent state ----------------
// Shape:
// {
//   clients:  { '<origin>': { clientId, issuedAt } },
//   pending:  { '<state>':  { verifier, redirectUri, clientId, origin, createdAt } },
//   tokens:   null | { accessToken, refreshToken, expiresAt, scope, obtainedAt },
//   mcp:      { sessionId: null, serverInfo: null, tools: null, toolsAt: 0 },
//   connectedAt: null, lastSyncAt: null
// }
const DEFAULT_STATE = {
  clients: {},
  pending: {},
  tokens: null,
  mcp: { sessionId: null, serverInfo: null, tools: null, toolsAt: 0 },
  connectedAt: null,
  lastSyncAt: null,
};

let _state = null;
function state() {
  if (!_state) _state = loadJSON(STORE_FILE, DEFAULT_STATE);
  // Defensive: repair anything malformed from older writes.
  if (!_state.clients || typeof _state.clients !== 'object') _state.clients = {};
  if (!_state.pending || typeof _state.pending !== 'object') _state.pending = {};
  if (!_state.mcp || typeof _state.mcp !== 'object') _state.mcp = { sessionId: null, serverInfo: null, tools: null, toolsAt: 0 };
  return _state;
}
function persist() {
  saveJSON(STORE_FILE, _state);
  // Durable (encrypted GitHub) write-through — credentials survive
  // Render's ephemeral-disk restarts. Best-effort, never throws.
  try { durablePut(STORE_FILE, _state); } catch { /* optional */ }
}

// Durable boot-restore hook: after mcp-indmoney.json is re-hydrated from
// the encrypted backup, drop the in-memory copy so the next state() call
// re-reads the disk file (tokens/clients are then live again with zero
// user action). Safe at boot; also exported for tests.
export function __dropInMemoryStateForBoot() { _state = null; }

// Test hook: wipe in-memory + on-disk state between test cases.
export function __resetForTests() {
  _state = structuredClone(DEFAULT_STATE);
  _portfolioCache = null;
  saveJSON(STORE_FILE, _state);
}

// ---------------- small utils ----------------
function b64url(buf) {
  return Buffer.from(buf).toString('base64url');
}
function nowMs() { return Date.now(); }

class IndmError extends Error {
  constructor(message, status = 500, code = 'INDM_ERROR') {
    super(message);
    this.status = status;
    this.code = code;
  }
}
export { IndmError };

// Fetch JSON with timeout + friendly errors.
async function postJSON(url, body, headers = {}) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(MCP_TIMEOUT),
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON body */ }
  return { res, json, text };
}

// OAuth 2.0 token-style endpoints (RFC 6749 §4.1.3, RFC 7009) REQUIRE
// application/x-www-form-urlencoded request bodies. Sending JSON here makes
// strict authorization servers (like INDMoney's) see an EMPTY body → they
// reply "Missing client_id" and the token exchange fails.
// (Dynamic Registration RFC 7591 and the MCP endpoint itself DO use JSON,
// which is why register + authorize worked but the code→token exchange died.)
async function postForm(url, params) {
  const body = Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
    .join('&');
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
    signal: AbortSignal.timeout(MCP_TIMEOUT),
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON body */ }
  return { res, json, text };
}

// ============================================================
// PKCE (RFC 7636, S256)
// ============================================================
export function pkceGenerate() {
  const verifier = b64url(crypto.randomBytes(48)); // 64 chars — within 43..128
  const challenge = pkceChallengeFrom(verifier);
  return { verifier, challenge };
}
export function pkceChallengeFrom(verifier) {
  return b64url(crypto.createHash('sha256').update(verifier).digest());
}

// ============================================================
// Dynamic Client Registration (per deployment origin)
// ============================================================
export async function ensureClient(origin) {
  const s = state();
  const cached = s.clients[origin];
  if (cached && cached.clientId) return cached.clientId;

  const redirectUri = `${origin}/api/mcp/indmoney/callback`;
  const { res, json } = await postJSON(INDM.REGISTER_URL, {
    client_name: INDM.CLIENT_NAME,
    redirect_uris: [redirectUri],
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none', // public client → PKCE required
    scope: INDM.SCOPES,
  });
  if (!res.ok || !json || !json.client_id) {
    throw new IndmError(
      `INDMoney client registration failed (HTTP ${res.status})`,
      502, 'REGISTRATION_FAILED'
    );
  }
  s.clients[origin] = { clientId: json.client_id, issuedAt: nowMs() };
  persist();
  return json.client_id;
}

// ============================================================
// OAuth: start (authorize URL) + finish (code exchange)
// ============================================================
export function buildAuthorizeUrl({ clientId, redirectUri, state: st, codeChallenge, scope }) {
  const u = new URL(INDM.AUTHORIZE_URL);
  u.searchParams.set('client_id', clientId);
  u.searchParams.set('redirect_uri', redirectUri);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('scope', scope || INDM.SCOPES);
  u.searchParams.set('state', st);
  u.searchParams.set('code_challenge', codeChallenge);
  u.searchParams.set('code_challenge_method', 'S256');
  return u.toString();
}

// Begin the connect flow for the given origin. Returns the authorize URL
// the browser should be redirected to (full-page navigation).
export async function startConnect(origin) {
  if (!/^https?:\/\//i.test(origin)) {
    throw new IndmError('Invalid origin for INDMoney OAuth', 400, 'BAD_ORIGIN');
  }
  const clientId = await ensureClient(origin);
  const redirectUri = `${origin}/api/mcp/indmoney/callback`;
  const { verifier, challenge } = pkceGenerate();
  const st = crypto.randomBytes(24).toString('hex');
  const s = state();
  // GC stale pending flows, then store this one.
  const cutoff = nowMs() - PENDING_TTL;
  for (const k of Object.keys(s.pending)) if (s.pending[k].createdAt < cutoff) delete s.pending[k];
  s.pending[st] = { verifier, redirectUri, clientId, origin, createdAt: nowMs() };
  persist();
  return {
    authorizeUrl: buildAuthorizeUrl({ clientId, redirectUri, state: st, codeChallenge: challenge }),
    state: st,
  };
}

// Read the saved origin for a pending OAuth flow (used by the callback
// to redirect back to the exact site that started the connect).
export function getPendingOrigin(st) {
  const p = state().pending?.[st];
  return p ? p.origin : null;
}

// Finish the flow at the callback: validate state, exchange code for tokens.
export async function completeConnect({ code, state: st, error, errorDescription }) {
  if (error) {
    throw new IndmError(
      `INDMoney authorization denied${errorDescription ? `: ${errorDescription}` : ''}`,
      400, 'AUTH_DENIED'
    );
  }
  const s = state();
  const pending = s.pending[st];
  if (!pending) throw new IndmError('Unknown or expired OAuth state. Restart the connect.', 400, 'BAD_STATE');
  delete s.pending[st]; // single-use
  persist();

  const { res, json } = await postForm(INDM.TOKEN_URL, {
    grant_type: 'authorization_code',
    code,
    redirect_uri: pending.redirectUri,
    client_id: pending.clientId,
    code_verifier: pending.verifier,
  });
  if (!res.ok || !json || !json.access_token) {
    const desc = json?.error_description || json?.error || `HTTP ${res.status}`;
    throw new IndmError(`Token exchange failed: ${desc}`, 502, 'TOKEN_EXCHANGE_FAILED');
  }
  s.tokens = {
    accessToken: json.access_token,
    refreshToken: json.refresh_token || null,
    expiresAt: json.expires_in ? nowMs() + json.expires_in * 1000 : null,
    scope: json.scope || INDM.SCOPES,
    obtainedAt: nowMs(),
    clientId: pending.clientId || null, // the client that ISSUED this token
  };
  // Fresh connection → reset any stale MCP session/tools cache.
  s.mcp = { sessionId: null, serverInfo: null, tools: null, toolsAt: 0 };
  s.connectedAt = nowMs();
  s.lastSyncAt = null;
  persist();
  return { ok: true, scope: s.tokens.scope };
}

// Refresh the access token (transparent, auto-invoked).
export async function refreshAccessToken() {
  const s = state();
  if (!s.tokens || !s.tokens.refreshToken) {
    throw new IndmError('Not connected (no refresh token)', 401, 'NOT_CONNECTED');
  }
  // Prefer the client that ISSUED this token (persisted at connect time).
  // Object-insertion order of s.clients is NOT a valid signal — a user
  // connecting first from an old/preview origin then from the deployed one
  // would send the WRONG client_id with the CURRENT refresh token →
  // invalid_grant → the whole connection wrongly wiped. Legacy stored
  // tokens (no clientId) fall back to the first-registered client.
  const clientId = s.tokens.clientId
    || s.clients[Object.keys(s.clients)[0]]?.clientId;
  if (!clientId) throw new IndmError('Stored client registration missing', 500, 'NO_CLIENT');

  const { res, json } = await postForm(INDM.TOKEN_URL, {
    grant_type: 'refresh_token',
    refresh_token: s.tokens.refreshToken,
    client_id: clientId,
  });
  if (!res.ok || !json || !json.access_token) {
    // Refresh token revoked/expired → connection is dead.
    await disconnect(); // best-effort revoke + clear
    throw new IndmError('Session expired — reconnect INDMoney.', 401, 'REFRESH_FAILED');
  }
  s.tokens = {
    accessToken: json.access_token,
    refreshToken: json.refresh_token || s.tokens.refreshToken,
    expiresAt: json.expires_in ? nowMs() + json.expires_in * 1000 : null,
    scope: json.scope || s.tokens.scope,
    obtainedAt: nowMs(),
    clientId: s.tokens.clientId || null,
  };
  s.mcp = { sessionId: null, serverInfo: null, tools: null, toolsAt: 0 };
  persist();
  return s.tokens.accessToken;
}

// Revoke + forget everything.
export async function disconnect() {
  const s = state();
  if (s.tokens?.accessToken) {
    try {
      await postForm(INDM.REVOKE_URL, { token: s.tokens.accessToken });
    } catch { /* best effort */ }
  }
  s.tokens = null;
  s.mcp = { sessionId: null, serverInfo: null, tools: null, toolsAt: 0 };
  s.connectedAt = null;
  s.lastSyncAt = null;
  persist();
  return { ok: true };
}

// Expiry-aware token getter (auto-refresh when needed).
async function getAccessToken() {
  const s = state();
  if (!s.tokens) throw new IndmError('INDMoney not connected', 401, 'NOT_CONNECTED');
  const expiring = s.tokens.expiresAt && (s.tokens.expiresAt - nowMs() < TOKEN_BUFFER);
  if (!expiring) return s.tokens.accessToken;
  if (s.tokens.refreshToken) return refreshAccessToken();
  return s.tokens.accessToken; // no expiry info / no refresh → just try
}

// ============================================================
// MCP Streamable HTTP transport (JSON-RPC 2.0)
// ============================================================
export function parseSSEOrJSON(text) {
  // Streamable HTTP servers may answer with `text/event-stream` (one or
  // more `data:` frames) or plain `application/json`. Normalise both.
  const trimmed = (text || '').trim();
  if (!trimmed) return [];
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try { const j = JSON.parse(trimmed); return Array.isArray(j) ? j : [j]; } catch { return []; }
  }
  const out = [];
  for (const block of trimmed.split(/\r?\n\r?\n/)) {
    for (const line of block.split(/\r?\n/)) {
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;
      try { out.push(JSON.parse(payload)); } catch { /* ignore frame */ }
    }
  }
  return out;
}

let _rpcSeq = 1;

// One JSON-RPC round-trip against the MCP endpoint.
// _retried guards against infinite 401/404 retry loops (one retry max).
async function mcpRpc(method, params, { notification = false, _retried = false } = {}) {
  const accessToken = await getAccessToken();
  const id = notification ? undefined : _rpcSeq++;
  const headers = {
    Authorization: `Bearer ${accessToken}`,
    Accept: 'application/json, text/event-stream',
  };
  const sessionId = state().mcp.sessionId;
  if (sessionId) headers['Mcp-Session-Id'] = sessionId;

  const body = { jsonrpc: '2.0', method, ...(params !== undefined ? { params } : {}) };
  if (!notification) body.id = id;

  const res = await fetch(INDM.MCP_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(MCP_TIMEOUT),
  });

  // Session id comes back (mainly) on the initialize response.
  const sid = res.headers.get('mcp-session-id');
  if (sid) state().mcp.sessionId = sid;

  if (res.status === 401 && !_retried) {
    // Access token just expired mid-session → refresh once, retry once.
    const s = state();
    if (s.tokens?.refreshToken) {
      await refreshAccessToken();
      return mcpRpc(method, params, { notification, _retried: true });
    }
    throw new IndmError('INDMoney session expired — reconnect required.', 401, 'MCP_UNAUTHORIZED');
  }
  if (res.status === 404 && sessionId && !_retried) {
    // Server lost our session → re-handshake once, retry once.
    state().mcp.sessionId = null;
    state().mcp.serverInfo = null;
    state().mcp.tools = null; state().mcp.toolsAt = 0;
    persist();
    await ensureMcpSession();
    return mcpRpc(method, params, { notification, _retried: true });
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new IndmError(`MCP ${method} failed (HTTP ${res.status}) ${text.slice(0, 200)}`, 502, 'MCP_HTTP_ERROR');
  }

  const text = await res.text().catch(() => '');
  if (notification || res.status === 202) return null; // 202 = accepted notification

  const messages = parseSSEOrJSON(text);
  const match = messages.find(m => m && m.id === id);
  if (match && match.error) {
    throw new IndmError(`MCP error: ${match.error.message || JSON.stringify(match.error)}`, 502, 'MCP_RPC_ERROR');
  }
  return match ? match.result : (messages[0]?.result ?? null);
}

// Full handshake (initialize + notifications/initialized).
async function ensureMcpSession() {
  const s = state();
  if (s.mcp.sessionId && s.mcp.serverInfo) return;
  const result = await mcpRpc('initialize', {
    protocolVersion: INDM.PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: { name: 'smartai-trading-suite', version: '4.2.0' },
  });
  s.mcp.serverInfo = result?.serverInfo || result?.server || { name: 'indmoney-mcp' };
  if (result?.protocolVersion) s.mcp.protocolVersion = result.protocolVersion;
  persist();
  // Notify readiness (202 Accepted expected; ignore result).
  try { await mcpRpc('notifications/initialized', undefined, { notification: true }); } catch { /* non-fatal */ }
}

// ============================================================
// Tools
// ============================================================
export async function listTools({ force = false } = {}) {
  const s = state();
  if (!force && s.mcp.tools && nowMs() - (s.mcp.toolsAt || 0) < TOOLS_TTL) {
    return { tools: s.mcp.tools, cached: true };
  }
  await ensureMcpSession();
  const result = await mcpRpc('tools/list', {});
  const tools = Array.isArray(result?.tools) ? result.tools : [];
  s.mcp.tools = tools;
  s.mcp.toolsAt = nowMs();
  persist();
  return { tools, cached: false };
}

export async function callTool(name, args = {}) {
  await ensureMcpSession();
  const result = await mcpRpc('tools/call', { name, arguments: args });
  if (result?.isError) {
    const msg = result?.content?.map(c => c?.text).filter(Boolean).join(' ') || 'tool call failed';
    throw new IndmError(`INDMoney tool error: ${msg}`, 502, 'TOOL_ERROR');
  }
  return result;
}

// Pick the most portfolio-ish tool from tools/list.
// INDMoney's exact tool names are not published; detect robustly.
function portfolioScore(t) {
  const hay = `${t.name || ''} ${t.description || ''}`.toLowerCase();
  if (!hay.trim()) return -1;
  let s = 0;
  if (/portfolio/.test(hay)) s += 10;
  if (/holding/.test(hay)) s += 8;
  if (/position/.test(hay)) s += 6;
  if (/net.?worth|wealth|asset|investment/.test(hay)) s += 4;
  if (/summary|overview|detail/.test(hay)) s += 2;
  if (/stock|equit|mutual|fund/.test(hay)) s += 2;
  if (/transaction|order|history|price|quote|news|market|watchlist/.test(hay)) s -= 5; // clearly not portfolio
  if (/family/.test(hay)) s -= 6; // family-wide views rank below personal holdings
  return s;
}
export function detectPortfolioTool(tools) {
  if (!Array.isArray(tools) || tools.length === 0) return null;
  const ranked = tools.map(t => ({ t, s: portfolioScore(t) })).sort((a, b) => b.s - a.s);
  return ranked[0] && ranked[0].s > 0 ? ranked[0].t : null;
}

// Ranked portfolio-ish tool candidates (score > 0, best first, capped).
function rankPortfolioTools(tools, cap = 4) {
  if (!Array.isArray(tools)) return [];
  return tools
    .map(t => ({ t, s: portfolioScore(t) }))
    .filter(x => x.s > 0)
    .sort((a, b) => b.s - a.s)
    .slice(0, cap)
    .map(x => x.t);
}

// ============================================================
// Schema-driven tool arguments
// ============================================================
// INDMoney tools declare Pydantic models — e.g. networth_holdings REQUIRES
// an `asset_type` argument. Calling with {} fails server-side validation:
//   "1 validation error for networth_holdingsArguments asset_type Field required"
// So before calling a tool we synthesize argument sets from its MCP
// inputSchema: enum values are enumerated exactly; a required asset_type
// without an enum falls back to INDMoney's known asset-type tokens.
const MAX_TOOL_CALLS = 12; // total tools/call budget per portfolio fetch
// Real INDMoney asset_type enum (observed live from networth_holdings schema):
// IND_STOCK, MF, US_STOCK, BOND, EPF, NPS, SA, FD, CRYPTO, INSURANCE, VEHICLE, RE.
// Used when a required asset_type arrives WITHOUT an enum in the schema.
const KNOWN_ASSET_TYPES = [
  'IND_STOCK', 'MF', 'US_STOCK', 'BOND', 'EPF', 'NPS', 'SA', 'FD',
  'CRYPTO', 'INSURANCE', 'VEHICLE', 'RE',
];
const ASSET_TYPE_LABELS = [
  [/mutual|(^|[\s_-])mf([\s_-]|$)/i, 'Mutual Fund'],
  [/etf/i, 'ETF'],
  [/fixed|(^|[\s_-])fd([\s_-]|$)|deposit/i, 'Fixed Income'],
  [/gold/i, 'Gold'],
  [/nps|ppf|epf|pension|provident/i, 'Retirement'],
  [/bond/i, 'Bonds'],
  [/crypto|bitcoin/i, 'Crypto'],
  [/real.?estate|property|(^|[\s_-])re([\s_-]|$)/i, 'Real Estate'],
  [/insur/i, 'Insurance'],
  [/vehicle|\bcar\b/i, 'Vehicle'],
  [/(^|[\s_-])sa([\s_-]|$)|saving/i, 'Savings'],
  [/stock|equit|share/i, 'Stock'],
  [/other/i, 'Other'],
];

export function assetTypeLabel(v) {
  if (v == null) return null;
  const s = String(v);
  if (!s || /^all$/i.test(s)) return null; // mixed payload → keep per-holding types
  for (const [re, label] of ASSET_TYPE_LABELS) if (re.test(s)) return label;
  return null;
}

// Build the argument sets a tool should be called with, from inputSchema.
// Returns { argSets, satisfiable } — argSets is always a non-empty array
// (falls back to [{}] when nothing can be synthesized).
export function buildToolArgSets(tool) {
  const schema = tool && tool.inputSchema && typeof tool.inputSchema === 'object'
    ? tool.inputSchema : null;
  const required = Array.isArray(schema?.required) ? schema.required : [];
  const props = schema && schema.properties && typeof schema.properties === 'object'
    ? schema.properties : {};
  if (required.length === 0) return { argSets: [{}], satisfiable: true };

  const perField = [];
  for (const name of required) {
    const p = (props[name] && typeof props[name] === 'object') ? props[name] : {};
    let values = null;
    if (Array.isArray(p.enum) && p.enum.length > 0) {
      values = p.enum.map(v => String(v));
    } else if (p.default !== undefined && p.default !== null) {
      values = [p.default];
    } else if (/asset_?types?/i.test(name)) {
      values = KNOWN_ASSET_TYPES;
    } else if (p.type === 'boolean') {
      values = [true];
    } else if (p.type === 'integer' || p.type === 'number') {
      values = null; // cannot infer a meaningful number
    } else {
      values = null;
    }
    if (!values) return { argSets: [{}], satisfiable: false };
    perField.push(values.map(v => ({ name, value: v })));
  }

  // Cartesian product across required fields, capped to the call budget.
  let combos = [{}];
  for (const options of perField) {
    const next = [];
    for (const base of combos) {
      for (const o of options) {
        if (next.length >= MAX_TOOL_CALLS) break;
        next.push({ ...base, [o.name]: o.value });
      }
      if (next.length >= MAX_TOOL_CALLS) break;
    }
    combos = next;
  }
  return { argSets: combos.slice(0, MAX_TOOL_CALLS), satisfiable: true };
}

// ============================================================
// Portfolio fetch + normalize
// ============================================================
let _portfolioCache = null; // { data, tool, fetchedAt }

// Extract the JSON payload an MCP tool returned (content[].text → JSON).
export function extractToolPayload(result) {
  if (!result) return null;
  if (Array.isArray(result.content)) {
    for (const c of result.content) {
      if (c?.type === 'text' && typeof c.text === 'string') {
        const t = c.text.trim();
        if (t.startsWith('{') || t.startsWith('[')) {
          try { return JSON.parse(t); } catch { return t; }
        }
        return t;
      }
      if (c?.type === 'resource' && c.resource?.text) {
        try { return JSON.parse(c.resource.text); } catch { return c.resource.text; }
      }
    }
  }
  if (result.structuredContent && typeof result.structuredContent === 'object') {
    return result.structuredContent;
  }
  return result; // passthrough
}

// ---- schema-agnostic normalizer -----------------------------------------
// Key lists cover both casing conventions AND INDMoney's REAL field names
// (observed live): holdings[] → investment, investment_code, isin_code,
// total_units, unit_price, invested_amount, market_value, total_pnl, pnl_per;
// positions[] → quantity, avg_price, buy_val, realised_gains, t1_qty.
const QTY_KEYS = ['qty', 'quantity', 'units', 'totalunits', 'total_units', 'shares', 'noofshares', 'holdingqty'];
const AVG_KEYS = ['avgprice', 'averageprice', 'avg_cost', 'avgcost', 'buyprice', 'investedprice', 'purchaseprice', 'buyavgprice', 'unitprice'];
const PRICE_KEYS = ['currentprice', 'lastprice', 'ltp', 'price', 'marketprice', 'nav', 'currprice', 'unitprice', 'unit_price'];
const VALUE_KEYS = ['currentvalue', 'value', 'marketvalue', 'totalvalue', 'worth', 'presentvalue', 'buyval'];
// v20.9.1 [L]: invested (cost basis) ke liye DEDICATED buy-value keys —
// VALUE_KEYS me currentvalue/marketvalue PEHLE aate the, to dono present
// rows me object key-order decide karta tha ki cost basis sahi hai ya
// current market value (invested galat + mark-to-market double-count).
const BUY_VALUE_KEYS = ['buyval', 'buy_val', 'buyvalue', 'investedvalue', 'invested', 'cost', 'costvalue', 'averageprice'];
const INVESTED_KEYS = ['invested', 'investedamount', 'investedvalue', 'totalinvested', 'cost', 'buyvalue', 'amountinvested'];
const NAME_KEYS = ['name', 'stockname', 'stock', 'companyname', 'symbolname', 'securityname', 'assetname', 'instrumentname', 'title', 'label', 'scheme_name', 'fundname', 'investment', 'investmentname'];
const SYM_KEYS = ['symbol', 'ticker', 'stocksymbol', 'tradingsymbol', 'scrip', 'shortname', 'isin', 'isincode', 'isin_code'];
const PNL_KEYS = ['pnl', 'total_pnl', 'totalpnl', 'profit', 'profitandloss', 'pl', 'gain', 'returns', 'unrealised', 'unrealized'];
const PNL_PCT_KEYS = ['pnl_per', 'pnlper', 'pnl_percentage', 'pnlpercentage', 'returnspercentage', 'gainpct'];
// Per-holding 1-day change % (INDMoney: one_day_change_percentage).
// NOT plain "change" — that key is ambiguous (abs ₹ vs %) across providers.
const ONE_DAY_PCT_KEYS = ['one_day_change_percentage', 'onedaychangepercentage', 'day_change_percentage', 'daychangepercentage', 'd1_change_percentage', 'onedaypnlpercentage'];
const TYPE_HINTS = [
  [/mutual|\bmf\b|scheme|fund(?!am)/i, 'Mutual Fund'],
  [/fixed.?deposit|\bfd\b|ppf|nps|sovereign|gold(?: bond)?|bond/i, 'Fixed Income / Gold'],
  [/etf/i, 'ETF'],
  [/stock|equit|share|cash/i, 'Stock'],
];

// Case/separator-insensitive key lookup: avgPrice, avg_price and AVGPRICE
// all resolve to the same normalized name. INDMoney's real schema is
// unknown, so every casing convention must be handled.
function pick(obj, keys) {
  const wanted = new Set(keys.map(k => k.replace(/[_\s-]/g, '').toLowerCase()));
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
    if (wanted.has(k.replace(/[_\s-]/g, '').toLowerCase())) return v;
  }
  return undefined;
}
function toNum(v) {
  if (v == null) return null;
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const n = Number(v.replace(/[₹,\s]/g, ''));
    if (Number.isFinite(n)) return n;
  }
  return null;
}
function looksLikeHolding(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return false;
  const hasName = pick(obj, NAME_KEYS) !== undefined || pick(obj, SYM_KEYS) !== undefined;
  const hasQtyOrVal = toNum(pick(obj, QTY_KEYS)) !== null
    || toNum(pick(obj, VALUE_KEYS)) !== null
    || toNum(pick(obj, INVESTED_KEYS)) !== null;
  return hasName && hasQtyOrVal;
}
function classifyType(raw, name) {
  const hay = `${raw?.asset_type || ''} ${raw?.assetType || ''} ${raw?.type || ''} ${raw?.category || ''} ${name || ''}`;
  for (const [re, label] of TYPE_HINTS) if (re.test(hay)) return label;
  return 'Other';
}
function normalizeHolding(raw) {
  const name = String(pick(raw, NAME_KEYS) ?? pick(raw, SYM_KEYS) ?? 'Unknown');
  const symbol = pick(raw, SYM_KEYS) != null ? String(pick(raw, SYM_KEYS)) : null;
  const qty = toNum(pick(raw, QTY_KEYS));
  const avg = toNum(pick(raw, AVG_KEYS));
  const price = toNum(pick(raw, PRICE_KEYS));
  const value = toNum(pick(raw, VALUE_KEYS)) ?? (price != null && qty != null ? price * qty : null);
  const invested = toNum(pick(raw, INVESTED_KEYS)) ?? (avg != null && qty != null ? avg * qty : null);
  const pnlRaw = toNum(pick(raw, PNL_KEYS));
  const pnlPctRaw = toNum(pick(raw, PNL_PCT_KEYS));
  const oneDayPctRaw = toNum(pick(raw, ONE_DAY_PCT_KEYS));
  const pnl = (value != null && invested != null) ? value - invested : pnlRaw;
  const pnlPct = pnlPctRaw ?? (pnl != null && invested ? (pnl / invested) * 100 : null);
  return {
    name, symbol, qty, avgPrice: avg, currentPrice: price, value, invested,
    pnl: pnl != null ? Math.round(pnl * 100) / 100 : null,
    pnlPct: pnlPct != null ? Math.round(pnlPct * 100) / 100 : null,
    oneDayChangePct: oneDayPctRaw != null ? Math.round(oneDayPctRaw * 100) / 100 : null,
    assetType: classifyType(raw, name),
  };
}

// Walk an arbitrary JSON tree; collect objects that look like holdings.
// Position containers are SKIPPED — trading positions are extracted
// separately (they overlap settled holdings and would double-count).
const SKIP_KEYS = new Set([
  'mtf_positions', 'positions', 'intra_day_positions', 'derivative_positions',
  'drv_intra_day_positions', 'commodity_positions', 'commodity_intra_day_positions',
  'strategy_positions', 'open_orders', 'open_derivative_orders',
  'open_commodity_orders', 'open_gtt_commodity_orders', 'asset_summary', 'meta_info',
]);
export function collectHoldings(node, out = [], depth = 0) {
  if (depth > 8 || out.length > 2000) return out; // depth/size guard
  if (Array.isArray(node)) {
    for (const item of node) collectHoldings(item, out, depth + 1);
    return out;
  }
  if (node && typeof node === 'object') {
    if (looksLikeHolding(node)) { out.push(normalizeHolding(node)); return out; }
    for (const [k, v] of Object.entries(node)) {
      if (SKIP_KEYS.has(k)) continue;
      collectHoldings(v, out, depth + 1);
    }
  }
  return out;
}

export function normalizePortfolio(payload) {
  if (payload == null) return { ok: false, reason: 'empty', holdings: [], summary: null };
  if (typeof payload === 'string') return { ok: false, reason: 'text-only', holdings: [], summary: null };
  return summarizeHoldings(collectHoldings(payload));
}

// Dedup + aggregate already-normalized holdings (shared by the single-payload
// path and the multi-call fetch path).
export function summarizeHoldings(holdings) {
  const list = Array.isArray(holdings) ? holdings : [];
  // Dedup by name (nested repeats across summary/detail sections).
  const seen = new Set();
  const uniq = list.filter(h => {
    const key = `${h.name}|${h.qty}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  const totalValue = uniq.reduce((a, h) => a + (h.value || 0), 0);
  const totalInvested = uniq.reduce((a, h) => a + (h.invested || 0), 0);
  const totalPnl = totalValue - totalInvested;
  const summary = uniq.length
    ? {
        totalValue: Math.round(totalValue * 100) / 100,
        totalInvested: Math.round(totalInvested * 100) / 100,
        totalPnl: Math.round(totalPnl * 100) / 100,
        totalPnlPct: totalInvested ? Math.round((totalPnl / totalInvested) * 10000) / 100 : null,
        holdingCount: uniq.length,
      }
    : null;

  return {
    ok: uniq.length > 0,
    reason: uniq.length ? null : 'no-holdings-found',
    holdings: uniq,
    summary,
  };
}

// ============================================================
// INDMoney real-schema extras: positions, code map, official summary
// ============================================================

// investment_code/ind_stock_id → human name map (built from holdings[] of
// the same response — positions[] carries only opaque INDS codes).
export function buildCodeMap(payload, map = new Map()) {
  const arr = payload?.holdings;
  if (Array.isArray(arr)) {
    for (const h of arr) {
      if (!h || typeof h !== 'object') continue;
      const code = h.investment_code ?? h.investmentcode ?? h.ind_stock_id;
      const name = h.investment ?? pick(h, NAME_KEYS);
      if (code != null && name != null) map.set(String(code), String(name));
    }
  }
  return map;
}

// Trading positions (MTF / delivery / intraday) — NOT merged into holdings
// (they overlap settled holdings; INDMoney shows them separately too).
export function extractPositions(payload, codeMap = new Map()) {
  const out = [];
  if (!payload || typeof payload !== 'object') return out;
  const sections = [
    ['MTF', payload.mtf_positions],
    ['POSITION', payload.positions],
    ['INTRADAY', payload.intra_day_positions],
  ];
  for (const [kind, arr] of sections) {
    if (!Array.isArray(arr)) continue;
    for (const raw of arr) {
      if (!raw || typeof raw !== 'object') continue;
      const code = raw.ind_stock_id ?? raw.investment_code ?? raw.instrument_id;
      const name = code != null && codeMap.has(String(code))
        ? codeMap.get(String(code))
        : (pick(raw, NAME_KEYS) ?? pick(raw, SYM_KEYS) ?? code ?? 'Unknown');
      out.push({
        name: String(name),
        symbol: pick(raw, SYM_KEYS) != null ? String(pick(raw, SYM_KEYS)) : null,
        kind,
        qty: toNum(pick(raw, QTY_KEYS)),
        avgPrice: toNum(pick(raw, AVG_KEYS)),
        // v20.9.1 [L]: cost basis BUY_VALUE_KEYS se (market-value keys se
        // pehle), fallback VALUE_KEYS.
        invested: toNum(pick(raw, BUY_VALUE_KEYS)) ?? toNum(pick(raw, VALUE_KEYS)), // buy_val
        realisedPnl: toNum(raw.realised_gains ?? raw.realised_gains ?? raw.realisedpnl),
        t1Qty: toNum(raw.t1_qty ?? raw.t1qty) ?? 0,
        positionId: raw.position_id ?? raw.positionid ?? null,
      });
    }
  }
  return out;
}

// INDMoney's own account-level totals (asset_summary) — used as the summary
// when every successful call reports the SAME numbers (i.e. it is
// account-wide, not scoped to the requested asset_type).
export function readAssetSummary(payload) {
  const a = payload?.asset_summary;
  if (!a || typeof a !== 'object') return null;
  const totalValue = toNum(a.total_value ?? a.totalvalue ?? a.value);
  if (totalValue == null) return null;
  const invested = toNum(a.invested ?? a.invested_amount ?? a.investedamount);
  const pnl = invested != null ? totalValue - invested : null;
  return {
    totalValue: Math.round(totalValue * 100) / 100,
    totalInvested: invested != null ? Math.round(invested * 100) / 100 : null,
    totalPnl: pnl != null ? Math.round(pnl * 100) / 100 : null,
    totalPnlPct: pnl != null && invested ? Math.round((pnl / invested) * 10000) / 100 : null,
    oneDayChange: toNum(a.one_day_change ?? a.onedaychange),
    oneDayChangePct: toNum(a.one_day_change_percentage ?? a.onedaychangepercentage),
  };
}

function consistentSummary(summaries) {
  if (!summaries.length) return null;
  const first = summaries[0];
  const same = summaries.every(s =>
    s.totalValue === first.totalValue && s.totalInvested === first.totalInvested);
  return same ? first : null;
}

// Main entry: fetch the user's portfolio via MCP.
//
// INDMoney's portfolio tools declare REQUIRED arguments (e.g.
// networth_holdings needs asset_type), so a single empty-args call fails
// validation. Strategy:
//   1. Rank portfolio-ish tools (personal holdings above family-wide views);
//      synthesize argument sets from each tool's inputSchema.
//   2. SEQUENTIAL per-tool sweeps: run the best tool's full argument sweep;
//      the moment a tool yields holdings we STOP — never mixing other
//      tools' views (family portfolio would double-count).
//   3. Per-call failure tolerance: an unsupported asset type is skipped, not
//      fatal; only when EVERY call fails do we surface the underlying error.
//   4. asset_summary is promoted to the official summary when all successful
//      calls agree (account-wide); otherwise totals are computed from holdings.
//   5. mtf/positions arrays are extracted separately (never into holdings).
export async function fetchPortfolio({ force = false } = {}) {
  const s = state();
  if (!s.tokens) throw new IndmError('INDMoney not connected', 401, 'NOT_CONNECTED');
  if (!force && _portfolioCache && nowMs() - _portfolioCache.fetchedAt < PORTFOLIO_TTL) {
    return { ..._portfolioCache.data, cached: true };
  }
  const { tools } = await listTools({ force });
  const ranked = rankPortfolioTools(tools);
  if (ranked.length === 0) {
    return {
      ok: false, reason: 'no-portfolio-tool', summary: null, holdings: [],
      tools: (tools || []).map(t => ({ name: t.name, description: (t.description || '').slice(0, 120) })),
      fetchedAt: nowMs(), cached: false,
    };
  }

  const holdings = [];
  const positions = [];
  const summaries = [];
  const calls = [];        // successful (tool, args) pairs — diagnostics
  const failures = [];     // skipped pairs with their error text
  const codeMap = new Map();
  let firstPayload = null;
  let firstError = null;
  let callsUsed = 0;
  let satisfiableTool = false; // any tool had a synthesizable schema?

  for (const tool of ranked) {
    if (callsUsed >= MAX_TOOL_CALLS) break;
    const { argSets, satisfiable } = buildToolArgSets(tool);
    if (!satisfiable) continue;
    satisfiableTool = true;
    let toolHoldings = 0;

    for (const args of argSets.slice(0, MAX_TOOL_CALLS)) {
      if (callsUsed >= MAX_TOOL_CALLS) break;
      callsUsed++;
      let payload;
      try {
        const result = await callTool(tool.name, args);
        payload = extractToolPayload(result);
      } catch (err) {
        if (!firstError) firstError = err;
        failures.push({ tool: tool.name, args, error: String(err?.message || err).slice(0, 200) });
        continue; // one bad asset type must not kill the whole sync
      }
      calls.push({ tool: tool.name, args });
      if (firstPayload === null) firstPayload = payload;

      const sum = readAssetSummary(payload);
      if (sum) summaries.push(sum);
      buildCodeMap(payload, codeMap);
      for (const p of extractPositions(payload, codeMap)) positions.push(p);

      // Stamp the asset type implied by the argument, but only where the
      // holding itself doesn't already classify (ETF/MF names win over the arg).
      // assetEnum keeps the raw enum (IND_STOCK/US_STOCK/CRYPTO/…) — the
      // portfolio-sync mapper uses it to pick the market & symbol resolver.
      const label = assetTypeLabel(args?.asset_type ?? args?.assetType);
      const enumv = args?.asset_type ?? args?.assetType ?? null;
      for (const h of collectHoldings(payload)) {
        if (label && (!h.assetType || h.assetType === 'Other')) h.assetType = label;
        if (enumv) h.assetEnum = String(enumv);
        holdings.push(h);
        toolHoldings++;
      }
    }

    // This tool delivered holdings → stop; do not mix other tools' views.
    if (toolHoldings > 0) break;
  }

  // No tool had a satisfiable schema → legacy empty-args attempt on top tools.
  if (!satisfiableTool && callsUsed === 0) {
    for (const tool of ranked.slice(0, 3)) {
      let payload;
      try {
        const result = await callTool(tool.name, {});
        payload = extractToolPayload(result);
      } catch (err) {
        if (!firstError) firstError = err;
        failures.push({ tool: tool.name, args: {}, error: String(err?.message || err).slice(0, 200) });
        continue;
      }
      calls.push({ tool: tool.name, args: {} });
      if (firstPayload === null) firstPayload = payload;
      const sum = readAssetSummary(payload);
      if (sum) summaries.push(sum);
      buildCodeMap(payload, codeMap);
      for (const p of extractPositions(payload, codeMap)) positions.push(p);
      for (const h of collectHoldings(payload)) holdings.push(h);
    }
  }

  // Every single call failed → surface the real error (as before).
  if (calls.length === 0 && firstError) throw firstError;

  // Dedup positions by positionId (or name|qty|kind).
  const seenPos = new Set();
  const uniqPos = positions.filter(p => {
    const key = p.positionId ?? `${p.name}|${p.qty}|${p.kind}`;
    if (seenPos.has(key)) return false;
    seenPos.add(key);
    return true;
  });

  const normalized = summarizeHoldings(holdings);
  const official = consistentSummary(summaries);
  const summary = normalized.ok && official
    ? { ...official, holdingCount: normalized.summary.holdingCount }
    : normalized.summary;

  const out = {
    ...normalized,
    summary,
    officialSummary: !!official,
    positions: uniqPos.length ? uniqPos : undefined,
    tools: ranked.map(t => ({ name: t.name })),
    calls,
    failures: failures.length ? failures : undefined,
    fetchedAt: nowMs(),
    cached: false,
    payloadPreview: normalized.ok ? null : safePreview(firstPayload),
  };
  if (normalized.ok) {
    _portfolioCache = { data: out, fetchedAt: out.fetchedAt };
    s.lastSyncAt = out.fetchedAt;
    persist();
  }
  return out;
}
function safePreview(p) {
  try { const t = JSON.stringify(p); return t.length > 4000 ? t.slice(0, 4000) + '…' : t; } catch { return null; }
}

// Lightweight status for the frontend.
export function getStatus() {
  const s = state();
  return {
    connected: !!s.tokens,
    connecting: Object.keys(s.pending || {}).length > 0,
    connectedAt: s.connectedAt,
    lastSyncAt: s.lastSyncAt,
    expiresAt: s.tokens?.expiresAt || null,
    scope: s.tokens?.scope || null,
    hasRefreshToken: !!s.tokens?.refreshToken,
    registeredOrigins: Object.keys(s.clients || {}),
    toolCount: Array.isArray(s.mcp.tools) ? s.mcp.tools.length : 0,
  };
}
