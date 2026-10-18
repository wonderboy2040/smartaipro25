// ============================================================
// server/mcp/tapetide.js — Tapetide India Stock Research MCP Connector
// ------------------------------------------------------------
// Tapetide (https://tapetide.com) is "India's AI-first stock
// research platform — analyze every NSE & BSE stock". Their MCP
// server (https://mcp.tapetide.com/mcp) exposes stock research
// tools, but requires an authenticated Tapetide account.
//
// What this module implements (mirrors the proven INDMoney
// connector in ./indmoney.js — same architecture, verified live):
//  • OAuth 2.0 Authorization Code + PKCE (S256) against
//    Tapetide's authorization server (issuer https://mcp.tapetide.com/,
//    scopes openid email profile — user logs in with their own
//    Tapetide account; THAT login is the "API key").
//  • RFC 7591 Dynamic Client Registration — verified LIVE: the
//    server accepts POST /register and issues a client_id per
//    deployment origin (Render / localhost), zero manual setup.
//  • MCP Streamable HTTP transport (JSON-RPC 2.0):
//      initialize → notifications/initialized → tools/list → tools/call
//    Handles both application/json and text/event-stream (SSE)
//    responses plus the Mcp-Session-Id lifecycle.
//  • Token lifecycle: expiry-aware access, transparent refresh,
//    forget-on-disconnect (Tapetide metadata exposes no
//    revocation_endpoint — disconnect clears local state only).
//  • Tool CATALOG auto-categorization (analysis / quotes /
//    screener / fundamentals / news / patterns) so the UI can
//    organize whatever tools the account exposes — the exact
//    tool surface is only knowable AFTER the user connects.
//
// SECURITY: access/refresh tokens live ONLY in server/data/
// (never sent to the browser). The browser talks to our own
// authed /api/mcp/tapetide/* endpoints.
// ============================================================
import crypto from 'node:crypto';
import { loadJSON, saveJSON } from '../lib/store.js';
import { durablePut } from './durable.js';

// ---------------- Tapetide endpoints (fixed) ----------------
export const TPT = {
  MCP_URL: 'https://mcp.tapetide.com/mcp',
  AUTHORIZE_URL: 'https://mcp.tapetide.com/authorize',
  TOKEN_URL: 'https://mcp.tapetide.com/token',
  REGISTER_URL: 'https://mcp.tapetide.com/register',
  SCOPES: 'openid email profile',
  PROTOCOL_VERSION: '2025-03-26',
  CLIENT_NAME: 'SmartAI Trading Suite',
};

const STORE_FILE = 'mcp-tapetide.json';
const PENDING_TTL = 10 * 60 * 1000;   // OAuth pending state validity: 10 min
const TOKEN_BUFFER = 60 * 1000;       // refresh 60s before actual expiry
const MCP_TIMEOUT = 25_000;           // per-request MCP/OAuth timeout (research tools can be slow)
const TOOLS_TTL = 10 * 60 * 1000;     // cache tools/list for 10 min

// ---------------- persistent state ----------------
// Shape:
// {
//   clients:  { '<origin>': { clientId, issuedAt } },
//   pending:  { '<state>':  { verifier, redirectUri, clientId, origin, createdAt } },
//   tokens:   null | { accessToken, refreshToken, expiresAt, scope, obtainedAt },
//   mcp:      { sessionId: null, serverInfo: null, tools: null, toolsAt: 0 },
//   connectedAt: null, lastToolsAt: null
// }
const DEFAULT_STATE = {
  clients: {},
  pending: {},
  tokens: null,
  mcp: { sessionId: null, serverInfo: null, tools: null, toolsAt: 0 },
  connectedAt: null,
  lastToolsAt: null,
};

let _state = null;
function state() {
  if (!_state) _state = loadJSON(STORE_FILE, DEFAULT_STATE);
  if (!_state.clients || typeof _state.clients !== 'object') _state.clients = {};
  if (!_state.pending || typeof _state.pending !== 'object') _state.pending = {};
  if (!_state.mcp || typeof _state.mcp !== 'object') _state.mcp = { sessionId: null, serverInfo: null, tools: null, toolsAt: 0 };
  return _state;
}
function persist() {
  saveJSON(STORE_FILE, _state);
  // Durable (encrypted GitHub) write-through — survives Render's
  // ephemeral-disk restarts. Best-effort, never throws.
  try { durablePut(STORE_FILE, _state); } catch { /* optional */ }
}

// Durable boot-restore hook (see indmoney.js — same pattern).
export function __dropInMemoryStateForBoot() { _state = null; }

// Test hook: wipe in-memory + on-disk state between test cases.
export function __resetForTests() {
  _state = structuredClone(DEFAULT_STATE);
  saveJSON(STORE_FILE, _state);
}

// ---------------- small utils ----------------
function b64url(buf) {
  return Buffer.from(buf).toString('base64url');
}
function nowMs() { return Date.now(); }

class TptError extends Error {
  constructor(message, status = 500, code = 'TPT_ERROR') {
    super(message);
    this.status = status;
    this.code = code;
  }
}
export { TptError };

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

// OAuth token endpoints REQUIRE application/x-www-form-urlencoded
// (RFC 6749 §4.1.3) — same lesson as INDMoney (JSON bodies are
// silently seen as empty by strict servers).
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

  const redirectUri = `${origin}/api/mcp/tapetide/callback`;
  const { res, json } = await postJSON(TPT.REGISTER_URL, {
    client_name: TPT.CLIENT_NAME,
    redirect_uris: [redirectUri],
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none', // public client → PKCE required
    scope: TPT.SCOPES,
  });
  if (!res.ok || !json || !json.client_id) {
    throw new TptError(
      `Tapetide client registration failed (HTTP ${res.status})`,
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
  const u = new URL(TPT.AUTHORIZE_URL);
  u.searchParams.set('client_id', clientId);
  u.searchParams.set('redirect_uri', redirectUri);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('scope', scope || TPT.SCOPES);
  u.searchParams.set('state', st);
  u.searchParams.set('code_challenge', codeChallenge);
  u.searchParams.set('code_challenge_method', 'S256');
  return u.toString();
}

// Begin the connect flow for the given origin. Returns the authorize
// URL the browser should be redirected to (full-page navigation).
export async function startConnect(origin) {
  if (!/^https?:\/\//i.test(origin)) {
    throw new TptError('Invalid origin for Tapetide OAuth', 400, 'BAD_ORIGIN');
  }
  const clientId = await ensureClient(origin);
  const redirectUri = `${origin}/api/mcp/tapetide/callback`;
  const { verifier, challenge } = pkceGenerate();
  const st = crypto.randomBytes(24).toString('hex');
  const s = state();
  const cutoff = nowMs() - PENDING_TTL;
  for (const k of Object.keys(s.pending)) if (s.pending[k].createdAt < cutoff) delete s.pending[k];
  s.pending[st] = { verifier, redirectUri, clientId, origin, createdAt: nowMs() };
  persist();
  return {
    authorizeUrl: buildAuthorizeUrl({ clientId, redirectUri, state: st, codeChallenge: challenge }),
    state: st,
  };
}

export function getPendingOrigin(st) {
  const p = state().pending?.[st];
  return p ? p.origin : null;
}

// Finish the flow at the callback: validate state, exchange code.
export async function completeConnect({ code, state: st, error, errorDescription }) {
  if (error) {
    throw new TptError(
      `Tapetide authorization denied${errorDescription ? `: ${errorDescription}` : ''}`,
      400, 'AUTH_DENIED'
    );
  }
  if (!code) throw new TptError('Missing authorization code', 400, 'NO_CODE');
  const s = state();
  const pending = s.pending[st];
  if (!pending) throw new TptError('Unknown or expired OAuth state. Restart the connect.', 400, 'BAD_STATE');
  delete s.pending[st]; // single-use
  persist();

  const { res, json } = await postForm(TPT.TOKEN_URL, {
    grant_type: 'authorization_code',
    code,
    redirect_uri: pending.redirectUri,
    client_id: pending.clientId,
    code_verifier: pending.verifier,
  });
  if (!res.ok || !json || !json.access_token) {
    const desc = json?.error_description || json?.error || `HTTP ${res.status}`;
    throw new TptError(`Token exchange failed: ${desc}`, 502, 'TOKEN_EXCHANGE_FAILED');
  }
  s.tokens = {
    accessToken: json.access_token,
    refreshToken: json.refresh_token || null,
    expiresAt: json.expires_in ? nowMs() + json.expires_in * 1000 : null,
    scope: json.scope || TPT.SCOPES,
    obtainedAt: nowMs(),
    clientId: pending.clientId || null, // the client that ISSUED this token
  };
  s.mcp = { sessionId: null, serverInfo: null, tools: null, toolsAt: 0 };
  s.connectedAt = nowMs();
  s.lastToolsAt = null;
  persist();
  return { ok: true, scope: s.tokens.scope };
}

// Refresh the access token (transparent, auto-invoked).
export async function refreshAccessToken() {
  const s = state();
  if (!s.tokens || !s.tokens.refreshToken) {
    throw new TptError('Not connected (no refresh token)', 401, 'NOT_CONNECTED');
  }
  // Prefer the client that ISSUED this token (persisted at connect time);
  // object-insertion order of s.clients is not a valid signal (a stale
  // first-registered origin would send the wrong client_id and kill the
  // connection with invalid_grant). Legacy tokens fall back to the first
  // registered client.
  const clientId = s.tokens.clientId
    || s.clients[Object.keys(s.clients)[0]]?.clientId;
  if (!clientId) throw new TptError('Stored client registration missing', 500, 'NO_CLIENT');

  const { res, json } = await postForm(TPT.TOKEN_URL, {
    grant_type: 'refresh_token',
    refresh_token: s.tokens.refreshToken,
    client_id: clientId,
  });
  if (!res.ok || !json || !json.access_token) {
    await disconnect(); // best-effort clear
    throw new TptError('Session expired — reconnect Tapetide.', 401, 'REFRESH_FAILED');
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

// Forget everything (Tapetide publishes no revocation endpoint —
// local token clear only; the user can also revoke from their
// Tapetide account page).
export async function disconnect() {
  const s = state();
  s.tokens = null;
  s.mcp = { sessionId: null, serverInfo: null, tools: null, toolsAt: 0 };
  s.connectedAt = null;
  s.lastToolsAt = null;
  persist();
  return { ok: true };
}

// Expiry-aware token getter (auto-refresh when needed).
async function getAccessToken() {
  const s = state();
  if (!s.tokens) throw new TptError('Tapetide not connected', 401, 'NOT_CONNECTED');
  const expiring = s.tokens.expiresAt && (s.tokens.expiresAt - nowMs() < TOKEN_BUFFER);
  if (!expiring) return s.tokens.accessToken;
  if (s.tokens.refreshToken) return refreshAccessToken();
  return s.tokens.accessToken; // no expiry info / no refresh → just try
}

// ============================================================
// MCP Streamable HTTP transport (JSON-RPC 2.0)
// ============================================================
export function parseSSEOrJSON(text) {
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

  const res = await fetch(TPT.MCP_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(MCP_TIMEOUT),
  });

  const sid = res.headers.get('mcp-session-id');
  if (sid) state().mcp.sessionId = sid;

  if (res.status === 401 && !_retried) {
    const s = state();
    if (s.tokens?.refreshToken) {
      await refreshAccessToken();
      return mcpRpc(method, params, { notification, _retried: true });
    }
    throw new TptError('Tapetide session expired — reconnect required.', 401, 'MCP_UNAUTHORIZED');
  }
  if (res.status === 404 && sessionId && !_retried) {
    state().mcp.sessionId = null;
    state().mcp.serverInfo = null;
    state().mcp.tools = null; state().mcp.toolsAt = 0;
    persist();
    await ensureMcpSession();
    return mcpRpc(method, params, { notification, _retried: true });
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new TptError(`MCP ${method} failed (HTTP ${res.status}) ${text.slice(0, 200)}`, 502, 'MCP_HTTP_ERROR');
  }

  const text = await res.text().catch(() => '');
  if (notification || res.status === 202) return null;

  const messages = parseSSEOrJSON(text);
  const match = messages.find(m => m && m.id === id);
  if (match && match.error) {
    throw new TptError(`MCP error: ${match.error.message || JSON.stringify(match.error)}`, 502, 'MCP_RPC_ERROR');
  }
  return match ? match.result : (messages[0]?.result ?? null);
}

async function ensureMcpSession() {
  const s = state();
  if (s.mcp.sessionId && s.mcp.serverInfo) return;
  const result = await mcpRpc('initialize', {
    protocolVersion: TPT.PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: { name: 'smartai-trading-suite', version: '4.7.0' },
  });
  s.mcp.serverInfo = result?.serverInfo || result?.server || { name: 'tapetide-mcp' };
  if (result?.protocolVersion) s.mcp.protocolVersion = result.protocolVersion;
  persist();
  try { await mcpRpc('notifications/initialized', undefined, { notification: true }); } catch { /* non-fatal */ }
}

// ============================================================
// Tools — listing, calling, catalog categorization
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
  s.lastToolsAt = nowMs();
  persist();
  return { tools, cached: false };
}

export async function callTool(name, args = {}) {
  await ensureMcpSession();
  const result = await mcpRpc('tools/call', { name, arguments: args });
  if (result?.isError) {
    const msg = result?.content?.map(c => c?.text).filter(Boolean).join(' ') || 'tool call failed';
    throw new TptError(`Tapetide tool error: ${msg}`, 502, 'TOOL_ERROR');
  }
  return result;
}

// ---- catalog categorization ----------------------------------
// The exact Tapetide tool surface is only knowable AFTER connect,
// so tools are bucketed by keyword scoring. Pure + unit-tested.
const CATEGORY_RULES = [
  // NOTE: every rule carries the `g` flag — String#match then counts ALL
  // keyword hits, so multi-keyword tools (e.g. "candlestick pattern scanner
  // with RSI and MACD") score their strongest category above weaker ones.
  { key: 'analysis',    label: 'AI Analysis & Signals', weight: 0, test: /analy[sz]e|analysis|signal|recommend|verdict|rating|outlook|insight|swing|intraday.?call|predict|forecast|deep.?dive/g },
  { key: 'quotes',      label: 'Quotes & Prices',       weight: 1, test: /quote|price|ltp|ohlc|candle|chart|live|market.?depth|level|bid.?ask/g },
  { key: 'screener',    label: 'Screeners & Rankings',  weight: 2, test: /screen|filter|scan|top.?gainer|top.?loser|movers|most.?active|rank|leaderboard|best.?stock/g },
  { key: 'fundamentals',label: 'Fundamentals & Financials', weight: 3, test: /fundamental|financial|balance.?sheet|profit|earning|revenue|pe.?ratio|valuation|dividend|quarterly|annual.?report|dmat|metrics/g },
  { key: 'news',        label: 'News & Sentiment',      weight: 4, test: /news|sentiment|headline|event|announcement|corporate.?action|board.?meeting/g },
  { key: 'patterns',    label: 'Patterns & Technicals', weight: 5, test: /pattern|candlestick|indicator|rsi|macd|moving.?average|support|resistance|technical|trend|momentum|volume/g },
  { key: 'portfolio',   label: 'Portfolio & Watchlist', weight: 6, test: /portfolio|holding|watchlist|position|holding/g },
  { key: 'reference',   label: 'Reference & Search',    weight: 7, test: /search|list|lookup|symbol|ticker|company|info|profile|about|metadata|sectors?|industr/g },
];
const CATEGORY_FALLBACK = { key: 'other', label: 'Other Tools' };

export function categorizeTool(tool) {
  const hay = `${tool?.name || ''} ${tool?.description || ''}`.toLowerCase();
  if (!hay.trim()) return CATEGORY_FALLBACK.key;
  let best = null;
  let bestScore = 0;
  for (const rule of CATEGORY_RULES) {
    const matches = hay.match(rule.test) || [];
    if (matches.length === 0) continue;
    // description matches count double (stronger signal than name).
    const descHay = `${tool?.description || ''}`.toLowerCase();
    const descMatches = descHay.match(rule.test) || [];
    const score = matches.length + descMatches.length * 2;
    if (score > bestScore) { bestScore = score; best = rule; }
  }
  return best ? best.key : CATEGORY_FALLBACK.key;
}

export function categoryLabel(key) {
  const r = CATEGORY_RULES.find(r => r.key === key);
  return r ? r.label : CATEGORY_FALLBACK.label;
}

export function buildCatalog(tools) {
  const byCat = {};
  for (const t of (tools || [])) {
    const cat = categorizeTool(t);
    if (!byCat[cat]) byCat[cat] = [];
    byCat[cat].push(t);
  }
  // Deterministic order: rule weight, then tool count desc, then name.
  const entries = Object.entries(byCat).map(([key, list]) => ({
    key,
    label: categoryLabel(key),
    tools: [...list].sort((a, b) => String(a?.name || '').localeCompare(String(b?.name || ''))),
  }));
  entries.sort((a, b) => {
    const wa = CATEGORY_RULES.find(r => r.key === a.key)?.weight ?? 99;
    const wb = CATEGORY_RULES.find(r => r.key === b.key)?.weight ?? 99;
    if (wa !== wb) return wa - wb;
    return b.tools.length - a.tools.length;
  });
  return entries;
}

// Extract the useful payload from a tools/call result (content
// blocks are the MCP standard; fall back to raw).
export function extractToolPayload(result) {
  if (!result) return null;
  if (Array.isArray(result?.content)) {
    const texts = result.content
      .map(c => (c?.type === 'text' && typeof c.text === 'string') ? c.text : null)
      .filter(Boolean);
    if (texts.length) {
      const joined = texts.join('\n');
      // Tools often return JSON as text — parse it back when it
      // clearly is JSON (starts with { or [).
      const trimmed = joined.trim();
      if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
        try { return JSON.parse(trimmed); } catch { /* keep text */ }
      }
      return joined;
    }
    // Non-text content (images/resources) → summarize shape.
    return result.content.map(c => ({ type: c?.type, hasData: !!(c?.data || c?.resource) }));
  }
  if (result?.structuredContent && typeof result.structuredContent === 'object') {
    return result.structuredContent;
  }
  return result;
}

// Public status snapshot (safe — never includes tokens).
export function getStatus() {
  const s = state();
  const tools = Array.isArray(s.mcp.tools) ? s.mcp.tools : [];
  return {
    ok: true,
    connected: !!s.tokens,
    connectedAt: s.connectedAt || null,
    scope: s.tokens?.scope || null,
    expiresAt: s.tokens?.expiresAt || null,
    serverName: s.mcp?.serverInfo?.name || null,
    serverInfo: s.mcp?.serverInfo || null,
    toolsCount: tools.length,
    toolsAgeMs: s.mcp.toolsAt ? nowMs() - s.mcp.toolsAt : null,
    lastToolsAt: s.lastToolsAt || null,
    registeredOrigins: Object.keys(s.clients || {}).length,
  };
}
