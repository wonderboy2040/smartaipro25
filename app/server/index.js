// ============================================================
// Wealth AI Pro — Backend API Proxy Server
// ------------------------------------------------------------
// Serves the built frontend (dist/) AND the /api/* proxy
// endpoints that the frontend expects. All AI provider API
// keys live ONLY on the server (never shipped to the browser).
//
// Run:   node server/index.js   (Render "Web Service" start cmd)
// Env:   PORT, GROQ_API_KEY, GEMINI_API_KEY, CLAUDE_API_KEY,
//        OPENROUTER_API_KEY, CEREBRAS_API_KEY, HF_API_KEY,
//        NVIDIA_API_KEY, TAVILY_API_KEY, API_URL (optional)
// ============================================================
import 'dotenv/config';
import express from 'express';
import { subscribe as feedSubscribe, snapshot as feedSnapshot, feedStatus, pruneLiveFeedNow } from './liveFeed.js';
import { ensureUsSubscribed, usClientUp, usClientDown, usMarketOpen as _usMarketOpen, isStaleUsQuote as _isStaleUsQuote, getUsSessionQuote, releaseUsSubscribed } from './usStream.js';
import { initInStream, ensureInSubscribed, inClientUp, inClientDown, releaseInSubscribed } from './inStream.js';
import { ensureCryptoSubscribed, cryptoClientUp, cryptoClientDown, releaseCryptoSubscribed, fetchCoinDcxTickers, lastTickerSource } from './cryptoStream.js';
// v10.10: CoinDCX DIRECT ultra-fast RT — USDT perps (FUT_) + USDC global
// equity perps (GLOB_) pushed straight into the shared liveFeed at 2s.
import { ensureCxRtSubscribed, cxRtClientUp, cxRtClientDown, releaseCxRtSubscribed, cxRtWsStatus } from './ai/cxRtStream.js';
import {
  getMLPrediction, getRegime, getBacktest,
  getHealth as mlHealth,
} from './mlEngine.js';
import { SERVER_MCP_TOOLS_OPENAI, SERVER_MCP_TOOLS_GEMINI, executeServerMCPTool } from './mcpTools.js';
import indmMcpRoutes from './mcp/routes.js';
// v11.0 MCP DATA AGENT MESH — 10 market-data agents + orchestrator routes.
import { registerMeshRoutes } from './mcp/mesh.js';
// Accuracy-plan Phase 1: boot-time mesh health visibility — the Render
// log now states exactly which agents are authed vs honestly absent
// (missing key), so a key-gap is visible without hitting the API.
import { allCards } from './mcp/agents/registry.js';
import { registerAITradingRoutes } from './ai/routes.js';
// v18.1: enriched /health — cached ml-service probe + agent liveness.
import { mlServiceHealth } from './ai/mlHealth.js';
// v21.12.0: committee visibility — boot banner + /health snapshot
// (user ask: "kitne models chal rahe hain" site/logs dono me dikhe).
import { committeeInfo, committeeBanner } from './ai/committee.js';
import { agentLiveness } from './ai/agent.js';
import { indiaAgentLiveness } from './ai/indiaAgent.js';
import { registerIntradayRoutes } from './intraday/routes.js';
import { registerTelegramWebhook } from './telegram/webhook.js';
// v9.1: graceful-shutdown flushers for the debounced intraday writers.
import { flushPaperState } from './intraday/paperTrading.js';
// v13.2 B6: bandwidth telemetry — REST wire bytes + SSE frame bytes + alerts
import { bandwidthMiddleware, trackBytes, initBandwidthAlerts } from './ai/bandwidth.js';
import { sendTelegramMessage } from './ai/secrets.js';
// v10.16 S2: manual-trade store — same shutdown-flush contract
import { flushManualState } from './ai/manualTrades.js';
// v18.6.3 REALTIME NEVER STOPS: connection-class-aware /api/stream cap
// (loopback/authed get more slots — the app's own 3 SSE streams + a
// second browser tab must never 429 into a permanent "feed down" loop).
import { sseConnMaxFor, extractSessionToken } from './lib/sseCap.js';
import { flushTrackRecordState } from './intraday/trackRecord.js';
import { flushJournalState } from './intraday/journal.js';
// v12.7 (recheck R3-#4): the shutdown flush's REMOTE leg — pushes every
// pending durable backup immediately (the four flushers above re-arm
// their durable pushes; this fires them inside the drain window).
import { flushBackupNow } from './intraday/backup.js';
import { filterTickersBySymbols } from './lib/tickerFilter.js';
import { startScheduler as startIndmPortfolioScheduler } from './mcp/portfolioSync.js';
import { durableBootRestoreAll } from './mcp/durable.js';
// v18.10: CoinDCX keys from app\.env auto-connect at boot (the UI
// Connect flow remains the other path — see mcp/coindcx.js bootstrap).
import { coindcxEnvBootstrap } from './mcp/coindcx.js';
// v19.1 NEVER-DOWN STABILITY GUARD — stdout volume governor + process
// self-heal (stay-alive crash guard, memory/lag watchdog, exit journal).
// Both are leaf modules (node builtins only) — safe to load first.
import { initLogGovernor, logGovernorStats } from './ai/logGovernor.js';
import {
  initSelfHeal, selfHealthSnapshot, registerTrim,
  selfHealNoteShutdown, reportLastExitOnBoot,
} from './ai/selfHeal.js';
import { __clearCandleCache } from './ai/data.js';
// v19.2 ANTI-FREEZE — Windows console QuickEdit guard (programmatic
// best-effort disable; the #1 "site 5-10 min me atak jaati hai" root cause
// on Windows portables). Leaf module, node builtins only.
import { disableQuickEditMode, consoleGuardStatus } from './ai/consoleGuard.js';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { fork } from 'node:child_process';
import crypto from 'node:crypto';
// v11.7 PERF: gzip responses (JS/CSS/JSON/HTML/SVG). The built bundle ships
// ~1.9MB of text assets across ~25 chunks — without transfer compression
// every visit re-downloaded all of it raw (e.g. vendor-react 192KB → ~60KB
// gzipped). Battle-tested middleware, zero hand-rolled stream edge cases.
import compression from 'compression';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

// v21.3.0 (Issue-1: "baar baar server down"): Express 4 async-rejection
// guard — sub-routers register through this proxy so an async handler
// throw becomes an honest 500 (next(err)) instead of a HUNG socket.
// Only AsyncFunction handlers with <4 args are wrapped; sync handlers,
// router objects, middleware factories and settings getters pass through
// byte-for-byte unchanged.
import { withAsyncRouteGuard } from './lib/asyncGuard.js';
const routesApp = withAsyncRouteGuard(app, {
  onError: (err) => { try { console.error('[async-guard] route handler rejected:', String(err?.message || err).slice(0, 160)); } catch { /* noop */ } },
});
const PORT = process.env.PORT || 8080;
const DEFAULT_USD_INR = 83.5;

// v20.8.3 ALWAYS-LATEST: SERVER_VERSION — package.json se (single source;
// src/version.ts APP_VERSION release-gate ke through sync me rehta hai).
// /api/ping (v) + /health (version) ise expose karte hain; frontend APP_VERSION
// se compare karke STALE-BUILD banner dikhata hai — browser me purana dist
// serve ho raha ho (the "v20.7.5" bug) to user ko TURANT dikh jata hai.
const SERVER_VERSION = (() => {
  try {
    return String(JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', 'package.json'), 'utf8')).version || '0.0.0');
  } catch { return '0.0.0'; }
})();

// v19.1: arm the stdout governor FIRST — everything logged below (boot
// chatter, watcher lines, crash reports) is deduped + rate-capped so a
// piped/blocked console (Windows launcher / QuickEdit freeze) can never
// fill the OS pipe buffer and hang the event loop. LOG_GOVERNOR=off
// disables (raw passthrough).
initLogGovernor({ env: process.env });

// v19.2: fire the QuickEdit console guard at boot. Best-effort + never
// blocking/throwing: result lands in /health.consoleguard. Skipped when the
// EXTERNAL SUPERVISOR already ran it for this shared console (its boot call
// covers both processes), and on non-Windows (attempted:false, non-win32).
if (process.env.SMARTAI_SUPERVISED === '1') {
  try { console.log('[selfheal] running under EXTERNAL SUPERVISOR (v19.2 hang+crash auto-recover)'); } catch { /* noop */ }
} else {
  disableQuickEditMode({ env: process.env }).catch(() => { /* never fatal */ });
}

// v11.7 PERF: hide the Express fingerprint (minor hygiene).
app.disable('x-powered-by');

// v12.7 SECURITY (recheck R3-#5): the full header set existed only in the
// nginx.conf Docker path — the LIVE Render path shipped none of it. Safe
// subset (nothing that can break the SPA): nosniff, frame denial,
// referrer trimming, permissions lockdown, and a CSP limited to
// frame-ancestors/object-src/base-uri (a full script-src policy needs a
// per-build audit of inline scripts — deliberately not attempted blind).
app.use((req, res, next) => {
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('X-Frame-Options', 'DENY');
  res.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
  res.set('Content-Security-Policy', "frame-ancestors 'none'; object-src 'none'; base-uri 'self'");
  next();
});

// v20.8.4 FIX (M — pre-auth body-parse CPU surface): express.json runs
// BEFORE requireAuth, so an anonymous client could make the server parse a
// 4MB JSON body on ANY /api/* path and still get a 401 afterwards (per-IP
// limits exist only on the handful of public endpoints). This cheap guard
// rejects no-evidence /api/* requests BEFORE the body is read. It only
// checks for AUTH EVIDENCE (not validity — requireAuth stays the sole
// verifier), so semantics are unchanged for every legitimate caller.
// NOTE: public-ness mirrors requireAuth's rules — keep in sync.
app.use((req, res, next) => {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();
  if (!req.path.startsWith('/api/')) return next();
  const publicApi = PUBLIC_PATHS.has(req.path)
    || req.path.startsWith('/api/fundamentals/')
    || req.path.startsWith('/api/ml/');
  if (publicApi) return next();
  const hasAuthEvidence = (req.headers.authorization || '').startsWith('Bearer ')
    || (typeof req.headers.cookie === 'string' && req.headers.cookie.includes(SESSION_COOKIE))
    || (typeof req.url === 'string' && /[?&]session=/.test(req.url));
  if (!hasAuthEvidence) {
    return res.status(401).json({ error: { message: 'Authentication required. Please log in.' } });
  }
  next();
});

app.use(express.json({ limit: '4mb' })); // v20.8.2: 1mb 413'd the /api/bots/backtest 20k-bars cap before the route's own validation ran

// v11.7 PERF #1 — TRANSFER COMPRESSION.
// gzip every compressible response ≥1KB (default filter + threshold).
// Belt-and-braces on top of the package defaults: NEVER touch SSE streams
// (text/event-stream) — zlib buffering there would delay live ticks — and
// never touch anything a route already marked Cache-Control: no-transform
// (the SSE endpoints already send that, this filter keeps them untouched even
// if a future endpoint forgets the header). API JSON boards (the /api/ai/board
// payloads are regularly 100-400KB) get compressed too — big win on Render's
// free-tier network path.
app.use(compression({
  filter: (req, res) => {
    const ct = String(res.getHeader('Content-Type') || '');
    if (ct.includes('text/event-stream')) return false;
    const cc = String(res.getHeader('Cache-Control') || '');
    if (cc.includes('no-transform')) return false;
    return compression.filter(req, res);
  },
}));

// v13.2 B6: true-wire REST byte accounting (socket bytesWritten delta on
// 'finish' — includes headers; SSE is counted at its own write sites).
// Telemetry only — never in the response path's critical section.
app.use(bandwidthMiddleware());

// NOTE: CORS is handled by a single strict middleware further down
// (ALLOWED_ORIGINS allowlist + Vary: Origin). A previous looser
// substring-matching CORS layer here was removed — it could echo
// attacker origins like `evil-vercel.app.example.com` and could not be
// overridden by the stricter middleware that ran after it.

// ============================================================
// v21.1.0 (Phase-3 SPLIT): pura AUTH SYSTEM ab server/security/pinAuth.js
// me hai (PIN + sessions + limiters + requireAuth + auth endpoints).
// Yahan sirf wiring rehta hai — CORS/CSRF middleware is file me hi hain
// kyunki wo ALLOWED_ORIGINS/_corsFailClosed state share karte hain.
// ============================================================
import { requireAuth, registerAuthRoutes, sessions as _sessions, parseCookie, SESSION_COOKIE, _constEq, PUBLIC_PATHS, APP_PIN } from './security/pinAuth.js';

// --- CORS ---
// When the frontend is on a DIFFERENT origin (e.g. Vercel frontend calling
// Render backend), the browser sends `credentials: 'include'` for the session
// cookie. Browsers REJECT `Access-Control-Allow-Origin: *` when credentials
// are used — the server MUST echo the specific Origin header instead.
// We allowlist origins via the ALLOWED_ORIGINS env var; if not set, we echo
// any origin (safe for dev, restrict in production).
const ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS
  ? new Set(process.env.ALLOWED_ORIGINS.split(',').map(s => s.trim()).filter(Boolean))
  : null; // null = allow any (dev mode ONLY)

// SECURITY FIX (audit C-1): fail closed. When NODE_ENV=production and no
// ALLOWED_ORIGINS allowlist is configured, do NOT reflect arbitrary origins
// alongside `Access-Control-Allow-Credentials: true` -- the session cookie is
// SameSite=None, so reflecting any origin equals full cross-origin account
// takeover (portfolio reads, cloud-state overwrites, AI-key burn).
// v7.0.2 FIX: the guard used to fail open when NODE_ENV was UNSET — but
// bare `node server/index.js` start paths (VPS, containers) run exactly
// that way, silently echoing any origin with credentials.
// Now it fails closed in EVERY mode except an explicit NODE_ENV=development.
const _corsFailClosed = !ALLOWED_ORIGINS
  && String(process.env.NODE_ENV || '').toLowerCase() !== 'development';
if (_corsFailClosed) {
  console.warn('[wealth-ai] SECURITY: ALLOWED_ORIGINS is not set in production. ' +
    'CORS is FAIL-CLOSED -- no cross-origin requests will be authorized. ' +
    'Set ALLOWED_ORIGINS to your frontend origin(s), comma-separated.');
}

app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && !_corsFailClosed) {
    if (ALLOWED_ORIGINS) {
      // Production allowlist — only echo if origin is allowed.
      if (ALLOWED_ORIGINS.has(origin)) {
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Vary', 'Origin');
      }
      // Disallowed origins get NO ACAO header — browser blocks the response.
    } else {
      // Dev mode — echo any origin (no allowlist set).
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
    }
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// Apply auth middleware to ALL requests.
app.use(requireAuth);

// ============================================================
// v10.13 SECURITY (deep-recheck H-2): GLOBAL CSRF DISCRIMINATOR
// ------------------------------------------------------------
// The session cookie is SameSite=None (required for cross-origin
// deployments) — a third-party page can issue "simple requests"
// (form POST / no-cors fetch) that ride the cookie WITHOUT any
// preflight. CORS only hides the RESPONSE; the mutation still runs.
// That silently authenticates no-body mutations like:
//   POST /api/ai/orders/cancel-all          (cancels ALL live orders)
//   POST /api/ai/trading/kill-switch {}     (enabled:false → DISARMS it)
//   POST /api/ai/dhan/disconnect            (forgets broker keys)
//   POST /api/mcp/coindcx/disconnect        (forgets API keys)
// /api/auth/logout already had this exact discriminator inline; it is
// now generalized to EVERY state-changing request.
//
// DISCRIMINATOR (same as logout): a cross-site <form> can NEVER set an
// Authorization header, while the app's own cross-origin calls
// (Vercel → Render, also Sec-Fetch-Site: cross-site) always send the
// Bearer token via apiFetch. Therefore:
//   cross-site + no Bearer + session cookie present  → 403
// Login is exempt (no session exists yet — there is nothing to hijack;
// a login CSRF gains an attacker nothing on a single-user PIN app).
// Requests with no session cookie at all pass through (public paths /
// unauthenticated) — there is no cookie for an attacker to ride.
// Legacy browsers without Sec-Fetch-Site fall back to the same Origin
// host/allowlist check logout uses.
// ============================================================
app.use((req, res, next) => {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();
  if (req.path === '/api/auth/login') return next(); // nothing to hijack pre-login
  const hasBearer = /^Bearer\s+\S+/i.test(String(req.headers.authorization || ''));
  if (hasBearer) return next(); // explicit token auth — not a cookie ride-along
  const cookie = parseCookie(req.headers.cookie || '')[SESSION_COOKIE];
  if (!cookie) return next(); // no session cookie → CSRF has nothing to ride
  const secFetchSite = String(req.headers['sec-fetch-site'] || '').toLowerCase();
  if (secFetchSite === 'cross-site') {
    return res.status(403).json({ error: { message: 'Cross-site request blocked.' } });
  }
  if (!secFetchSite && req.headers.origin) {
    const origin = String(req.headers.origin);
    let allowed = false;
    try { allowed = !!req.headers.host && new URL(origin).host === String(req.headers.host); } catch { /* parse fail */ }
    if (!allowed && ALLOWED_ORIGINS) allowed = ALLOWED_ORIGINS.has(origin);
    if (!allowed && _corsFailClosed) {
      return res.status(403).json({ error: { message: 'Cross-site request blocked.' } });
    }
  }
  next();
});

// ============================================================
// v21.1.0 (Phase-3 SPLIT): auth endpoints (login/logout/check) ab
// registerAuthRoutes se aate hain — server/security/pinAuth.js me
// definitions. deps me index.js ka proxy-aware IP + CORS-aware
// legacy-origin check inject hota hai.
// ============================================================
registerAuthRoutes(app, {
  clientIpOf,
  logoutOriginAllowed: (req) => {
    const origin = req.headers.origin;
    let allowed = false;
    try { allowed = !!req.headers.host && new URL(String(origin)).host === String(req.headers.host); } catch { /* parse fail */ }
    if (!allowed && ALLOWED_ORIGINS) allowed = ALLOWED_ORIGINS.has(String(origin));
    if (!allowed && _corsFailClosed) return false;
    return true;
  },
});

// GET /api/config → returns runtime cloud sync configuration
app.get('/api/config', (_req, res) => {
  res.json({
    apiUrl: process.env.API_URL || process.env.VITE_API_URL || '',
    hasCloudSync: !!(process.env.API_URL || process.env.VITE_API_URL),
  });
});

// ------------------------------------------------------------
// Provider key map (server-side env vars — NOT VITE_*)
// ------------------------------------------------------------
const KEYS = {
  groq: (process.env.GROQ_API_KEY || process.env.GROQ_KEY || '').replace(/['"]/g, '').trim(),
  gemini: (process.env.GEMINI_API_KEY || process.env.GEMINI_KEY || '').replace(/['"]/g, '').trim(),
  claude: (process.env.CLAUDE_API_KEY || process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_KEY || '').replace(/['"]/g, '').trim(),
  openrouter: (process.env.OPENROUTER_API_KEY || process.env.OPENROUTER_KEY || '').replace(/['"]/g, '').trim(),
  cerebras: (process.env.CEREBRAS_API_KEY || process.env.CEREBRAS_KEY || '').replace(/['"]/g, '').trim(),
  huggingface: (process.env.HF_API_KEY || process.env.HUGGINGFACE_API_KEY || process.env.HF_KEY || '').replace(/['"]/g, '').trim(),
  nvidia: (process.env.NVIDIA_API_KEY || process.env.NVIDIA_KEY || '').replace(/['"]/g, '').trim(),
  tavily: (process.env.TAVILY_API_KEY || process.env.TAVILY_KEY || '').replace(/['"]/g, '').trim(),
};

// Telegram bot credentials (server-side env only).
// NEVER fall back to VITE_* vars — those are browser-exposed at build time.
const TG = {
  token: process.env.TG_TOKEN || '',
  chatId: process.env.TG_CHAT_ID || '',
};

// v18.8.1 BRICK-PROOF TELEGRAM CONFIG: a HALF-set pair (token without
// chat id, or chat id without token) used to make validateEnv() REFUSE
// TO START the whole server - one stray .env edit (TG_CHAT_ID added,
// TG_TOKEN value lost) brick-locked every desk. Telegram is an OPTIONAL
// notification channel and every sender already gates on token+chatId
// TOGETHER (startBot, /api/telegram relay, secrets.telegramConfig,
// telegramToken) - the boot exit protected nothing. Normalize the half
// pair at the SOURCE, before any subsystem arms or captures it, and
// clear process.env too so env-fallback paths (webhook.js, the forked
// bot child) see the same clean unconfigured state. If BOTH values were
// saved via Settings > Alerts (app-secrets), telegram still works from
// there - only the env fallback switches off.
if (!!TG.token !== !!TG.chatId) {
  console.warn(
    '[wealth-ai] WARNING: TG_TOKEN and TG_CHAT_ID must BOTH be set TOGETHER ' +
    `(found TG_TOKEN=${TG.token ? 'set' : 'EMPTY'}, TG_CHAT_ID=${TG.chatId ? 'set' : 'EMPTY'}). ` +
    'Telegram alerts ab OFF hain - app NORMAL chalegi. Fix app\\.env: ' +
    'DONO values daalo (TG_TOKEN + TG_CHAT_ID), ya dono khaali chhodo. ' +
    '(Settings > Alerts me dono saved hain to Telegram wahan se chalta rahega.)'
  );
  TG.token = '';
  TG.chatId = '';
  process.env.TG_TOKEN = '';
  process.env.TG_CHAT_ID = '';
}

// v20.7.3: service auth requires API_TOKEN >= 12 chars (see requireAuth) —
// a shorter token passes validateEnv() but every forked-bot loopback call
// silently 401s. Warn loudly at boot instead of failing opaquely later.
if (process.env.API_TOKEN && process.env.API_TOKEN.length < 12) {
  console.warn(
    `[wealth-ai] WARNING: API_TOKEN is ${process.env.API_TOKEN.length} chars — service auth (forked-bot loopback calls) ` +
    'requires >= 12 chars and is currently DISABLED. Generate a longer token ' +
    '(e.g. `node -e "console.log(crypto.randomUUID().replace(/-/g,\'\'))"`) and update BOTH app\\.env and the Telegram bot env.'
  );
}

// OpenAI-compatible providers — body is forwarded almost as-is.
const OPENAI_COMPAT = {
  groq: { url: 'https://api.groq.com/openai/v1/chat/completions', defModel: 'openai/gpt-oss-120b' },
  openrouter: { url: 'https://openrouter.ai/api/v1/chat/completions', defModel: 'z-ai/glm-5.2:free' },
  cerebras: { url: 'https://api.cerebras.ai/v1/chat/completions', defModel: 'gpt-oss-120b' },
  huggingface: { url: 'https://router.huggingface.co/v1/chat/completions', defModel: 'Qwen/Qwen3-235B-A22B-Instruct-2507' },
  nvidia: { url: 'https://integrate.api.nvidia.com/v1/chat/completions', defModel: 'openai/gpt-oss-120b' },
};

function jsonError(res, status, message, internalErr) {
  // v20.7.8 [L6]: a handler that already sent headers (partial res.json
  // on a circular board object, mid-stream SSE write) used to throw
  // ERR_HTTP_HEADERS_SENT here — the terminal middleware then no-op'd
  // and the socket hung until the client timed out. Log and bail.
  if (res.headersSent) {
    console.warn(`[wealth-ai] jsonError after headersSent (${status} ${message}) — response already streaming`);
    try { res.end(); } catch { /* socket gone */ }
    return;
  }
  const correlationId = crypto.randomUUID();
  if (internalErr) {
    console.error(`[corr=${correlationId}] ${status} ${message}`, internalErr?.message || internalErr);
  }
  return res.status(status).json({ error: { message, correlationId } });
}

// ------------------------------------------------------------
// Input validation helpers
// ------------------------------------------------------------

// Validate a stock symbol: only letters, numbers, dots, hyphens, underscores.
// Prevents injection of HTML/SQL/script content via symbol parameters.
function isValidSymbol(sym) {
  if (typeof sym !== 'string') return false;
  const s = sym.trim().toUpperCase();
  if (s.length === 0 || s.length > 20) return false;
  return /^[A-Z0-9.\-_]+$/.test(s);
}

// Escape HTML special characters — used when forwarding user-controlled
// content to Telegram (which uses parse_mode: 'HTML').
function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Strip ALL HTML tags — for maximum safety when forwarding user content
// to Telegram as HTML. Only plain text survives.
function stripHtml(str) {
  return String(str || '').replace(/<[^>]*>/g, '');
}

// Cap an array at a maximum length to prevent DoS via huge payloads.
function _capArray(arr, maxLen) {
  if (!Array.isArray(arr)) return [];
  return arr.slice(0, maxLen);
}

// ------------------------------------------------------------
// v10.13 SECURITY (deep-recheck M-2): per-IP rate limits on the PUBLIC
// market-data endpoints. /api/quote accepts 50 symbols/call and hits
// Groww/Yahoo/Finnhub upstreams; /api/quote + /api/chart are
// unauthenticated by design ("prices always load") — an anonymous loop
// could otherwise hammer third-party upstreams from OUR shared IP
// (429 bans that degrade the legit quote path for everyone). Limits are
// sized far above the busiest legitimate single-session pattern
// (India 3s poller + US poller + sync batches ≈ 40-50 req/min for one
// tab; multi-device use stays well under).
// ------------------------------------------------------------
const _pubRate = new Map(); // ip → { n, windowStart }
function publicRateCheck(ip, limit) {
  const now = Date.now();
  let r = _pubRate.get(ip);
  if (!r || now - r.windowStart > 10 * 60_000) { r = { n: 0, windowStart: now }; _pubRate.set(ip, r); }
  if (_pubRate.size > 5000) { // bounded map — prune finished windows
    for (const [k, v] of _pubRate) { if (now - v.windowStart > 10 * 60_000) _pubRate.delete(k); }
  }
  r.n++;
  return r.n <= limit;
}
function clientIp(req) {
  // v20.1 FIX (deep audit): delegate to the hardened clientIpOf() — the
  // old unconditional XFF trust let any LAN peer forge a fresh rate-limit
  // bucket per request on the PUBLIC guards (chart/quote/fundamentals).
  // clientIpOf honors XFF only behind TRUST_PROXY=1 or from loopback,
  // matching the v18.6.4 login-limiter hardening.
  return clientIpOf(req);
}
function pubGuard(req, res, limit) {
  if (!publicRateCheck(clientIp(req), limit)) {
    res.status(429).set('Retry-After', '30').json({ error: { message: 'Too many requests — please slow down.' } });
    return true;
  }
  return false;
}
const QUOTE_RATE_10MIN = 900;   // 1.5/s sustained — never touches legit tabs
const CHART_RATE_10MIN = 300;   // chart opens + 5m intraday refreshes
const FUND_RATE_10MIN = 240;    // 24h-cached fundamentals

// ------------------------------------------------------------
// GET /api/chart  → real OHLC candles for ANY symbol (incl. NSE/BSE)
// ------------------------------------------------------------
// The embeddable TradingView widget shows "This symbol is only available on
// TradingView" for NSE ETFs (e.g. NSE:JUNIORBEES) because their real-time data
// isn't licensed for the public widget. This proxy fetches real candles from
// Yahoo Finance server-side (no browser CORS issue) so the app can render the
// NSE chart itself with lightweight-charts.
// Query: ?symbol=JUNIORBEES&market=IN&interval=D   (interval: D | W | M)
// ------------------------------------------------------------
const YF_INDEX_MAP = {
  // Indian indices → Yahoo tickers
  NIFTY: '^NSEI', NIFTY50: '^NSEI', BANKNIFTY: '^NSEBANK', NIFTYBANK: '^NSEBANK',
  SENSEX: '^BSESN', INDIAVIX: '^INDIAVIX', CNXIT: '^CNXIT',
  FINNIFTY: '^CNXFIN', MIDCPNIFTY: 'NIFTY_MID_SELECT.NS', NIFTYNXT50: '^NIFTYNEXT50',
  // US indices
  SPX: '^GSPC', NDX: '^NDX', DJI: '^DJI', RUT: '^RUT', VIX: '^VIX',
};

function toYahooSymbol(symbol, market) {
  const clean = String(symbol || '').replace('.NS', '').replace('.BO', '').trim().toUpperCase();
  if (YF_INDEX_MAP[clean]) return YF_INDEX_MAP[clean];
  // Crypto → Yahoo uses e.g. BTC-USD
  const crypto = ['BTC', 'ETH', 'SOL', 'BNB', 'XRP', 'DOGE', 'ADA', 'AVAX', 'DOT', 'POL', 'LINK', 'UNI'];
  if (crypto.includes(clean)) return `${clean}-USD`;
  if ((market || '').toUpperCase() === 'IN') return `${clean}.NS`; // NSE listing on Yahoo
  return clean; // US tickers are plain on Yahoo
}

app.get('/api/chart', async (req, res) => {
  if (pubGuard(req, res, CHART_RATE_10MIN)) return; // v10.13: public-endpoint rate limit
  const { symbol = '', market = '', interval = 'D' } = req.query || {};
  if (!symbol) return jsonError(res, 400, 'symbol required');
  // SECURITY: validate symbol format to prevent injection / open-proxy abuse.
  if (!isValidSymbol(symbol)) return jsonError(res, 400, 'invalid symbol format');

  const ivMap = {
    D: { interval: '1d', range: '6mo' },
    W: { interval: '1wk', range: '2y' },
    M: { interval: '1mo', range: '5y' },
    // Intraday 5-minute candles (NSE session) — used by the Intraday tab's
    // live chart modal with Entry/SL/T1/T2 overlays.
    '5M': { interval: '5m', range: '1d' },
  };
  const cfg = ivMap[String(interval).toUpperCase()] || ivMap.D;
  const ysym = toYahooSymbol(symbol, market);

  // Try NSE then BSE for Indian symbols (some ETFs only list on one).
  const candidates = (String(market).toUpperCase() === 'IN' && !ysym.startsWith('^'))
    ? [ysym, ysym.replace('.NS', '.BO')]
    : [ysym];

  for (const ys of candidates) {
    try {
      const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ys)}?interval=${cfg.interval}&range=${cfg.range}`;
      const upstream = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (WealthAI chart proxy)' },
        signal: AbortSignal.timeout(8000),
      });
      if (!upstream.ok) continue;
      const json = await upstream.json();
      const r = json?.chart?.result?.[0];
      const ts = r?.timestamp;
      const q = r?.indicators?.quote?.[0];
      if (!Array.isArray(ts) || !q) continue;

      const candles = [];
      for (let i = 0; i < ts.length; i++) {
        const o = q.open?.[i], h = q.high?.[i], l = q.low?.[i], c = q.close?.[i], v = q.volume?.[i];
        if (o == null || h == null || l == null || c == null) continue;
        // v21.23.12 [UNIT-SAFETY]: Yahoo timestamps SECONDS me aate hain —
        // app ka har candle surface {time: ms} contract rakhta hai (canonicalizer
        // 1e12 heuristic, freshness gates). Pehle yahan seconds leak hoti thi
        // → koi bhi future consumer instant "stale"/1970-scale padhta.
        candles.push({ time: ts[i] * 1000, open: o, high: h, low: l, close: c, volume: v || 0 });
      }
      if (candles.length === 0) continue;
      return res.json({ symbol: ys, currency: r?.meta?.currency || '', candles });
    } catch (e) { /* try next candidate */ }
  }
  return jsonError(res, 502, 'chart data unavailable');
});

// ============================================================
// SUPER INTELLIGENCE — AI TRADING TERMINAL (v6)
// ------------------------------------------------------------
// Full engine lives in ./ai/* (replaced the v3 intraday desk):
//   lib/indicators.js    pure TA math (EMA/RSI/MACD/BB/ATR/Stoch/ADX…)
//   lib/blackScholes.js  option pricing + Greeks + IV solver
//   data.js              TV scanner / CoinDCX candles / NSE chain
//   models.js            9-model Superintelligence ensemble
//   ensemble.js          weighted consensus → STRONG gating
//   optionsDesk.js       India options chain + strategy builder
//   coindcxOrders.js     LIVE order execution + safety gates
//   routes.js            endpoint registration (below)
// ============================================================
registerAITradingRoutes(routesApp, {
  KEYS,
  OPENAI_COMPAT,
  TG,
  jsonError,
});

// ============================================================
// v20.8.0 JEV BOT LAB (server/bots/*)
// ------------------------------------------------------------
// Honest 3-arm signal pipeline (rules | gated | jev), ORB/LVL/
// ensemble-adapter strategies, hard botRisk layer, PaperPort
// default execution, per-bot virtual accounts, kill switches,
// decision-stream SSE for the Bots dashboard tab. Mode is PAPER
// unless BOTS_MODE=LIVE (and live needs an explicit exec port).
// ============================================================
import { registerBotRoutes } from './bots/routes.js';
import { fetchCoinDcxCandles, fetchBinanceKlines } from './ai/data.js';
import { fetchDhanHistory, DHAN_IDS } from './bots/core/dhanFetch.js';
import { saveCandles, loadCandles as _loadCandles, loadCandlesCached, mergeBarSeries, sameDenomination } from './bots/core/candleStore.js';
import { usdInrLastKnown, usdInrFallback } from './ai/lib/usdinr.js';

const BOTS_STATE_DIR = process.env.BOT_STATE_DIR
  || path.resolve(__dirname, '../data/bots');

// v20.8.2 FIX (H1 + H2 — the crypto bot spine): the chain is now
// USDT-denominated end-to-end, store-backed, and cache-bypassing.
//   • PRIMARY: Binance/Bybit USDT klines — the crypto paper accounts are
//     USDT, but the old CoinDCX-INR primary meant every price in the
//     bot's book was ~85x the account's unit; the Binance FALLBACK then
//     flipped the whole series 85x on a feed swap (phantom stops,
//     poisoned store history, lying provenance stamp).
//   • LAST LEG: CoinDCX INR candles scaled to USDT via the shared
//     USDINR store — honest provenance 'coindcx-inr/<fx>'.
//   • DEPTH: fresh window 1000 bars + bounded paged backfill until the
//     7-day-ATR warmup (2017 bars) is covered. The old 300-bar feed
//     left ATR null on EVERY row, so orb-crypto/lvl could never emit a
//     candidate — 2 of the 3 default bots were structurally dead while
//     heartbeats said "ok, bars:300".
//   • STORE MERGE: accumulated history merges UNDER the fresh fetch
//     (dedupe keep-newest, capped) so warmup depth survives restarts;
//     a denomination guard refuses to merge a store written in the
//     OTHER currency (v20.8.0/v20.8.1 wrote INR-scale crypto stores).
//   • noCache: a bot tick must never trade on the shared 120s candle
//     cache snapshot — post-close ticks used to see pre-close prices,
//     and the stale-feed veto burned most surviving candidates.
const BOTS_WARMUP_BARS = 2200;   // > 2017 (7-day ATR on 5m) + margin
const BOTS_LIVE_MERGE_CAP = 6000; // ~20 days of live context; the STORE keeps full depth

async function fetchCryptoBotsCandles(symbol) {
  let bars = await fetchBinanceKlines(symbol, '5m', { limit: 1000, noCache: true });
  let source = 'binance-usdt';
  if (!Array.isArray(bars) || bars.length < 60) {
    const cx = await fetchCoinDcxCandles(symbol, '5m', { noCache: true });
    if (Array.isArray(cx) && cx.length >= 60) {
      const fx = usdInrLastKnown() || usdInrFallback() || 84;
      bars = cx.map(b => ({
        time: b.time, open: b.open / fx, high: b.high / fx, low: b.low / fx, close: b.close / fx, volume: b.volume,
      }));
      source = `coindcx-inr/${fx}`;
    }
  }
  return { bars: Array.isArray(bars) && bars.length >= 60 ? bars : null, source };
}

// store-shape {t,o,h,l,c,v} -> feed-shape {time,open,high,low,close,volume}
const toFeedBar = (b) => ({ time: b.t, open: b.o, high: b.h, low: b.l, close: b.c, volume: b.v });

// v20.8.1 FIX (H1): mark prices for open paper positions — v20.8.0 never
// wired a provider, so settleOpenTrades (also unwired) had no live price.
// Async contract; rides the merged candle chain (same denomination as
// the position's own entry feed by construction).
// v20.8.4 FIX (M — pathological mark weight): the mark path used to run
// the FULL chain (fresh 1000-bar fetch + store load + merge + up to 2
// backfill pages) PER OPEN POSITION PER SETTLE — API abuse + >60s
// scheduler runs (the trigger window of the settle race). Now every
// provider fetch refreshes a tiny last-close cache the mark path reads
// first; full chain only on cache miss (bounded by MARK_CACHE_TTL_MS).
const _markCache = new Map(); // `${desk}|${symbol}` -> { price, at }
// v20.9.1 [H3]: 10 min → 4 min — jab position OPEN hoti hai to tick()
// candleProvider skip karta hai (myOpen>=1 → continue), isliye mark cache
// sirf TTL-expiry pe refresh hota tha: 10-min TTL = SL/TP detection
// worst-case 1-2 bar LATE (settle post-gap price pe book karta tha).
// 4 min < ek 5m candle → worst-case detection aadhi; API load per open
// symbol 0.25 req/min (5rps Dhan budget me negligible).
const MARK_CACHE_TTL_MS = 4 * 60_000;
function markCacheNote(desk, symbol, bars) {
  const last = Array.isArray(bars) && bars[bars.length - 1];
  const p = Number(last?.close);
  if (Number.isFinite(p) && p > 0) {
    if (_markCache.size > 500) _markCache.clear();
    _markCache.set(`${desk}|${symbol}`, { price: p, at: Date.now() });
  }
}
async function botMarkPrice(symbol, desk) {
  try {
    const hit = _markCache.get(`${desk}|${symbol}`);
    if (hit && Date.now() - hit.at < MARK_CACHE_TTL_MS) return hit.price;
    const bars = await provideBotsCandles(symbol, desk);
    markCacheNote(desk, symbol, bars);
    const last = bars?.[bars.length - 1];
    const p = Number(last?.close);
    return Number.isFinite(p) && p > 0 ? p : null;
  } catch { return null; }
}

// shared candle chain (also used by the mark provider). Returns
// { bars, source } so the store's provenance stamp names the feed that
// ACTUALLY served (v20.8.2: the old stamp hardcoded 'coindcx' even for
// Binance-served bars — the visibility field lied).
async function provideBotsCandlesWithSource(symbol, desk) {
  try {
    if (desk === 'crypto') {
      const { bars: fresh, source } = await fetchCryptoBotsCandles(symbol);
      if (!fresh) return null;
      // v20.8.4 FIX (H2 — the O(n) rewrite fix was defeated by its own
      // caller): loadCandlesCached (incremental tail cache — no full-file
      // parse per tick), and the SAVE below now persists only the DELTA
      // (bars >= store tail + genuinely-new backfill bars) instead of the
      // whole merged window — the old full-window save hit saveCandles'
      // out-of-order full merge-rewrite path on EVERY 60s tick per symbol.
      const { bars: hist } = loadCandlesCached(BOTS_STATE_DIR, 'crypto', symbol, '5m');
      // v20.9.4 FIX (H2 — dead cross-denomination guard): hist bars STORE
      // shape {t,o,h,l,c,v} me hain — `.close` undefined tha, isliye
      // sameDenomination(undefined, x) apne "unknown → don't nuke" branch
      // pe hamesha TRUE return karta tha aur ye guard KABHI fire nahi
      // hota tha (v20.8.2 ka "cross-currency poisoning → phantom stops"
      // scenario field-name typo se zinda ho gaya tha). Sahi field: `.c`.
      const histUsable = hist.length && sameDenomination(hist[hist.length - 1].c, fresh[fresh.length - 1].close);
      let merged = histUsable
        ? mergeBarSeries(hist, fresh, { maxBars: BOTS_LIVE_MERGE_CAP })
        : fresh.map(b => ({ t: b.time, o: b.open, h: b.high, l: b.low, c: b.close, v: b.volume }));
      let saveDelta;
      if (histUsable) {
        const histLastT = hist[hist.length - 1].t;
        const histSet = new Set(hist.map(b => b.t));
        saveDelta = merged.filter(b => b.t >= histLastT || !histSet.has(b.t));
      } else {
        // store absent or other-denomination: save the WHOLE fresh window
        // (saveCandles' denomination guard performs the clean reset)
        saveDelta = merged;
      }
      // bounded paged backfill (max 2 pages) until warmup depth is covered
      for (let page = 0; merged.length < BOTS_WARMUP_BARS && page < 2; page++) {
        const oldest = merged[0]?.t;
        if (!oldest) break;
        const older = await fetchBinanceKlines(symbol, '5m', { limit: 1000, endTime: oldest - 1 });
        if (!Array.isArray(older) || !older.length) break;
        const olderNorm = older.map(b => ({ t: b.time, o: b.open, h: b.high, l: b.low, c: b.close, v: b.volume }));
        merged = mergeBarSeries(olderNorm, merged, { maxBars: BOTS_LIVE_MERGE_CAP });
        saveDelta = mergeBarSeries(saveDelta, olderNorm, { maxBars: Number.POSITIVE_INFINITY });
      }
      return { bars: merged.map(toFeedBar), source, saveDelta };
    }
    if (desk === 'india') {
      const id = DHAN_IDS[symbol];
      if (!id) return null;
      const to = new Date().toISOString().slice(0, 10);
      const from = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
      const r = await fetchDhanHistory({ ...id, interval: '5', fromDate: from, toDate: to });
      // v20.8.2 FIX (L): a single failed 90d chunk used to discard the
      // WHOLE fetch (r.ok=false with thousands of good bars) — accept
      // partial history whenever it clears the minimum.
      if (r.bars?.length >= 60) {
        const bars = r.bars.map(b => ({ time: b.t, open: b.o, high: b.h, low: b.l, close: b.c, volume: b.v }));
        // v20.9.1 [M]: India branch pehle POORA 30-din fetch saveDelta ke
        // roop me return karti thi — har 60s tick pe per-symbol FULL
        // merge-rewrite (v20.8.4 ka crypto delta-fix is branch tak kabhi
        // nahi pahuncha tha; store unbounded maxBars:Infinity bhi).
        // Ab wahi delta computation: store tail ke baad wale /
        // genuinely-new bars only.
        let saveDelta = bars;
        try {
          const { bars: hist } = loadCandlesCached(BOTS_STATE_DIR, 'india', symbol, '5m');
          if (hist.length) {
            const histLastT = hist[hist.length - 1].t;
            const histSet = new Set(hist.map(b => b.t));
            saveDelta = bars.filter(b => b.t >= histLastT || !histSet.has(b.t));
          }
        } catch { /* store read fail → full window (saveCandles clean-reset karega) */ }
        return { bars, source: 'dhan', saveDelta };
      }
      return null;
    }
  } catch { /* provider failure = no data = bot stays flat (honest) */ }
  return null;
}

async function provideBotsCandles(symbol, desk) {
  const r = await provideBotsCandlesWithSource(symbol, desk);
  if (r) markCacheNote(desk, symbol, r.bars);
  return r ? r.bars : null;
}

registerBotRoutes(routesApp, {
  // v20.9.1 [H2]: risk-block / order / protection-flatten telegram alerts
  // ab WIRED hain — pehle routes.js default {enabled:false} + index.js kabhi
  // telegram pass hi nahi karta tha (v20.9.0 ka flagship alert feature
  // production me kabhi fire nahi hota tha). TG half-set pair pe disable
  // (brick-proof TG config wahi semantics).
  // v20.9.4 [H2]: env bhi inject — sendTelegramMessage {token,chatId}
  // shape maangta hai; pehle raw process.env jaata tha to TG_TOKEN/
  // TG_CHAT_ID wale deployment me bot alerts silently dead the.
  telegram: { enabled: Boolean(TG.token && TG.chatId), env: { token: TG.token, chatId: TG.chatId } },
  candleProvider: async (symbol, desk) => {
    const r = await provideBotsCandlesWithSource(symbol, desk);
    if (!r) return null;
    // v20.8.1 FIX (H1 — the store had ZERO producers): every fetch is
    // persisted with provenance (source/feed/fetched_at) so the >=6-month
    // backtest depth the plan requires actually accumulates. Fire-and-
    // forget — a store write failure never blocks trading.
    // v20.8.4 FIX (H2): persist ONLY the delta (see provider above) — the
    // old full-window save forced saveCandles' out-of-order FULL
    // merge-rewrite on every 60s tick per symbol (~20MB/min sync I/O at
    // 6-month depth). Also refreshes the mark cache for the settle path.
    markCacheNote(desk, symbol, r.bars);
    if (r.saveDelta?.length) {
      setImmediate(() => {
        try {
          saveCandles(BOTS_STATE_DIR, desk, symbol, '5m', r.saveDelta, {
            source: r.source,
            feed: desk === 'india' ? 'v2/charts/intraday' : 'bots-candle-chain',
          });
        } catch { /* best-effort persistence */ }
      });
    }
    return r.bars;
  },
  markPriceProvider: botMarkPrice,
});


// v13.2 B6: hourly bandwidth guard — ONE Telegram alert/day when the 30-day
// projection crosses the alert threshold of the Render cap (default 70% of
// 5GB). Never throws, unref'd — pure telemetry.
initBandwidthAlerts({
  send: sendTelegramMessage,
  env: {
    ...TG,
    BANDWIDTH_MONTHLY_CAP_GB: process.env.BANDWIDTH_MONTHLY_CAP_GB,
    BANDWIDTH_ALERT_PCT: process.env.BANDWIDTH_ALERT_PCT,
  },
  log: (...a) => console.log('[BANDWIDTH]', ...a),
});

// ============================================================
// INTRADAY DESK (server/intraday/*)
// ------------------------------------------------------------
// Dual-market scanner (India NSE + Crypto 24/7), SSE live stream,
// paper trading, track record, journal, universe editor, movers,
// market intel, Pro Trader agent, committee debate, briefing.
// 20 /api/intraday-* endpoints registered by routes.js.
// ============================================================
// v9.5 F&O OPTION PAPER TRADES — the intraday watcher needs live index
// spot (NIFTY/SENSEX) to re-price open option positions. Groww serves
// equities only, so indices ride the Yahoo fetcher above (^NSEI etc.,
// 3s micro-cache shared with /api/quote's index path).
const fetchIndexSpot = async (sym) => {
  try { return await fetchYahooQuote(toYahooSymbol(sym, 'IN')); } catch { return null; }
};

// v21.0.6 [audit B1] — LIVE option-chain ladder for open OPTION paper
// trades: the SAME fetchers the options desk displays (direct NSE →
// Groww mirror / BSE Groww mirror), so paper exits (SL/T1/T2/BE/EOD)
// act on the premium the user actually sees — BS model sirf fallback.
// Watcher 5s cadence pe paperTrading ka apna 30s per-underlying cache
// rate-limits karta hai (data.js Groww mirror ka 90s cache bhi saath hai).
const fetchOptionChainFor = async (underlying) => {
  const u = String(underlying || '').toUpperCase();
  try {
    if (u === 'SENSEX') {
      const { fetchBSEOptionChain } = await import('./ai/data.js');
      return await fetchBSEOptionChain('SENSEX');
    }
    const { fetchNSEOptionChain } = await import('./ai/data.js');
    return await fetchNSEOptionChain(u);
  } catch { return null; }
};

registerIntradayRoutes(routesApp, {
  fetchGrowwNseQuote,
  fetchCoinDcxTickers,
  fetchIndexSpot,
  fetchOptionChainFor,
  KEYS,
  OPENAI_COMPAT,
  TG,
  escapeHtml,
  jsonError,
});

// ============================================================
// v10.5.3 GLOBAL FUTURES FULL-UNIVERSE SCAN (Issue #2)
// ------------------------------------------------------------
// The global equity desk's universe is no longer a hardcoded 8-name
// list: it merges CoinDCX's live USDT-margined equity-perp instrument
// list into the desk seed every 30 min (new listings like MU-class
// names appear automatically; delisted discoveries drop out; the
// SPACEX synthetic SIM special case stays). Boot hook lives HERE (not
// routes.js) so test imports never trigger the upstream fetch.
// ============================================================
import { startGlobalUniverseRefresh } from './ai/globalFutures.js';
try { startGlobalUniverseRefresh(); } catch (e) { console.warn('[globalFutures] universe refresh failed to start:', e?.message || e); }

// ============================================================
// INTERACTIVE TELEGRAM BOT (server/telegram/webhook.js)
// ------------------------------------------------------------
// v10.1: the bot now LISTENS — /crypto, /intraday, /status commands
// route to the SAME agents the website tabs use (read-only). Webhook
// path is PUBLIC (Telegram can't send session cookies) but secured by
// the X-Telegram-Bot-Api-Secret-Token header + configured-chat-id
// allowlist. setWebhook is a one-time auth'd call
// (POST /api/telegram/setup-webhook { url }).
// ============================================================
registerTelegramWebhook(app, { KEYS, OPENAI_COMPAT, TG, jsonError });

// ============================================================
// INDMONEY PORTFOLIO MCP (server/mcp/*)
// OAuth 2.0 + PKCE connect flow + MCP streamable-HTTP client.
// Tokens stay server-side (server/data/mcp-indmoney.json).
// portfolioSync drives the ASSET TABLE (INDMoney = source of truth):
// 2×-daily auto-sync (09:30 & 21:30 IST by default) + boot catch-up
// for slots missed while the dyno slept (Render free tier).
// ============================================================
app.use(indmMcpRoutes);
try { startIndmPortfolioScheduler(); } catch (e) { console.warn('[mcp/portfolioSync] scheduler failed to start:', e?.message || e); }

// ============================================================
// v11.0 MCP DATA AGENT MESH (server/mcp/mesh.js)
// 10 market-data agents (Alpha Vantage, CoinGecko, CCXT-style,
// TradingView, TradingCentral, Quiver, Massive, CoinAPI, Finnhub,
// Alpaca) behind one capability-routed query surface:
//   GET  /api/mcp/agents        registry + live health
//   GET  /api/mcp/mesh/status   cache + breakers + budgets
//   POST /api/mcp/mesh/query    { capabilities, symbols }
// Registration is pure (zero network at import); agents fetch only
// when the council/mesh query invokes them. Missing key = agent
// honestly absent — never fake data.
// ============================================================
try { registerMeshRoutes(routesApp); } catch (e) { console.warn('[mcp/mesh] route registration failed:', e?.message || e); }

// ------------------------------------------------------------
// Accuracy-plan Phase 1: MCP MESH BOOT HEALTH — one line in the
// Render log on every deploy: usable/total agents + the missing-key
// list. A "missing key" agent is honestly absent (never fakes data);
// free-key links for every env var live in .env.example's v11.8 block.
// ------------------------------------------------------------
try {
  const cards = allCards();
  const unauthed = cards.filter(c => !c.authed);
  const keyless = unauthed.filter(c => c.authRequired === false);
  const missing = unauthed.filter(c => c.authRequired !== false);
  const usable = cards.length - missing.length;
  console.log(`[mesh] BOOT HEALTH — ${usable}/${cards.length} agents usable (authed ${cards.length - unauthed.length} · keyless ${keyless.length})${
    missing.length ? ` · MISSING KEYS: ${missing.map(c => `${c.id}→${c.envKey || 'no-env-key'}`).join(', ')}` : ' · full mesh — no missing keys'
  }`);
} catch { /* visibility only — never blocks boot */ }

// ------------------------------------------------------------
// GET /api/quote  → REAL-TIME last-traded price for one or many symbols
// ------------------------------------------------------------
// Returns genuine real-time last prices via multiple sources:
//   1. Finnhub /quote (US stocks/ETFs, if key set)
//   2. Groww NSE live (India stocks/ETFs; SKIPPED for indices like NIFTY)
//   3. Yahoo Finance v7/v8 (fallback for everything)
// Query: ?symbols=SMH,QQQ,MU&market=US   (comma separated, max 50)
// Resp:  { quotes: { SMH: {price,change,high,low,volume,prevClose,time,source}, ... } }
// ------------------------------------------------------------
const INDIAN_INDICES = new Set(['NIFTY','BANKNIFTY','SENSEX','INDIAVIX','CNXIT','NIFTY50','NIFTYBANK']);
// v10.11: the Finnhub fetcher now lives in ai/finnhubQuote.js — ONE shared
// micro-cache + ONE 55/min sliding-window rate limiter serves BOTH the US
// desk (/api/quote) and the EQUITY SIM desk's fallback chain
// (globalFutures.js), so neither can starve the other's free-tier key.
// Behavior is byte-identical to the old inline copy (3s micro-cache,
// in-flight promise sharing, isStaleUsQuote freshness gate).
import { fetchFinnhubQuote } from './ai/finnhubQuote.js';

// v10.12 (India plan #2): the Groww fetcher moved to ai/growwQuote.js —
// same 3s micro-cache + in-flight promise sharing this file always had
// (FOUR consumers: /api/quote, the intraday scanner, the SSE watcher, the
// India inStream 3s poller — N consumers still cost ONE round-trip/symbol),
// plus the new resilience layer: ONE jittered quick retry (~300-500ms)
// inside the same fetch cycle (a transient blip no longer costs a full
// 3s poll interval) and a per-symbol fail-streak backoff that skips ONE
// poll cycle for a persistently-erroring symbol (honest null instantly,
// callers fall back to Yahoo) instead of hammering it — keeping the shared
// cache budget healthy for the symbols that ARE working.
import { fetchGrowwNseQuote } from './ai/growwQuote.js';

// REAL-TIME NSE quote (the India equivalent of the US realtime fix):
// see ai/growwQuote.js — fetchGrowwNseQuote is imported above. NSE's own
// API blocks datacenter IPs (403), and Yahoo .NS is ~15-min delayed;
// Groww's public live-price endpoint serves the genuine NSE last-traded
// price (`ltp`, type LIVE_PRICE) for stocks AND ETFs from cloud servers.

// PERF (2026 lag audit): same 3s micro-cache + in-flight sharing pattern
// for the Yahoo fetcher below. fetchYahooQuote serves the Indian INDICES
// (NIFTY, BANKNIFTY, INDIAVIX — Groww has no index quotes) and the US
// fallback path; the browser polls them every few seconds, and without a
// cache each poll meant a fresh Yahoo round-trip per index per client.
const _yahooMicroCache = new Map(); // ysym -> { ts, promise }
const YAHOO_CACHE_MS = 3000;
async function fetchYahooQuote(ysym) {
  if (!ysym) return null;
  const hit = _yahooMicroCache.get(ysym);
  if (hit && Date.now() - hit.ts < YAHOO_CACHE_MS) return hit.promise;
  const promise = _fetchYahooQuoteUncached(ysym); // never throws — resolves null
  _yahooMicroCache.set(ysym, { ts: Date.now(), promise });
  if (_yahooMicroCache.size > 500) {
    const cutoff = Date.now() - YAHOO_CACHE_MS * 2;
    for (const [k, v] of _yahooMicroCache) if (v.ts < cutoff) _yahooMicroCache.delete(k);
  }
  return promise;
}
async function _fetchYahooQuoteUncached(ysym) {
  // 2026 realtime audit: v8 chart FIRST — it reliably answers from every IP
  // (verified live for NSE listings, US stocks/ETFs incl. newly-listed names
  // like SPCX). The v7 quote endpoint intermittently 401s without a crumb
  // from datacenter IPs, so every cold symbol used to pay a WASTED v7
  // round-trip before the v8 fallback kicked in.
  let quote = null;
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ysym)}?interval=5m&range=1d`;
    const r = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (WealthAI quote proxy)' },
      signal: AbortSignal.timeout(6000),
    });
    if (r.ok) {
      const j = await r.json();
      const result = j?.chart?.result?.[0];
      const m = result?.meta;
      if (m) {
        const price = m.regularMarketPrice;
        if (typeof price === 'number' && price > 0) {
          const prevClose = m.chartPreviousClose || m.previousClose || price;
          quote = {
            price,
            change: prevClose ? ((price - prevClose) / prevClose) * 100 : 0,
            high: m.regularMarketDayHigh || price,
            low: m.regularMarketDayLow || price,
            volume: m.regularMarketVolume || 0,
            prevClose,
            time: (m.regularMarketTime ? m.regularMarketTime * 1000 : Date.now()),
            source: 'yahoo-realtime',
          };
        }
      }
    }
  } catch { /* fall through to v7 */ }
  if (quote) return quote;

  // v7 fallback (occasionally serves fresher batch quotes). Reachable ONLY
  // when v8 4xx/5xx'd, timed out, or returned an unusable body — every v8
  // failure path used to `return null` directly, making this designed
  // fallback unreachable dead code (no price for the symbol even though
  // v7 would have answered).
  try {
    const qurl = `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${encodeURIComponent(ysym)}`;
    const qr = await fetch(qurl, {
      headers: { 'User-Agent': 'Mozilla/5.0 (WealthAI quote proxy)' },
      signal: AbortSignal.timeout(5000),
    });
    if (qr.ok) {
      const qj = await qr.json();
      const qr2 = qj?.quoteResponse?.result?.[0];
      if (qr2 && typeof qr2.regularMarketPrice === 'number' && qr2.regularMarketPrice > 0) {
        return {
          price: qr2.regularMarketPrice,
          change: qr2.regularMarketChangePercent ?? 0,
          high: qr2.regularMarketDayHigh || qr2.regularMarketPrice,
          low: qr2.regularMarketDayLow || qr2.regularMarketPrice,
          volume: qr2.regularMarketVolume || 0,
          prevClose: qr2.regularMarketPreviousClose || qr2.regularMarketPrice,
          time: (qr2.regularMarketTime ? qr2.regularMarketTime * 1000 : Date.now()),
          source: 'yahoo-realtime',
        };
      }
    }
  } catch { /* fall through */ }
  return null;
}
app.get('/api/quote', async (req, res) => {
  if (pubGuard(req, res, QUOTE_RATE_10MIN)) return; // v10.13: public-endpoint rate limit
  const raw = String(req.query.symbols || req.query.symbol || '').trim();
  const market = String(req.query.market || '').toUpperCase();
  if (!raw) return jsonError(res, 400, 'symbols required');

  const symbols = [...new Set(
    raw.split(',').map(s => s.trim().toUpperCase()).filter(Boolean)
  )].slice(0, 50);
  if (symbols.length === 0) return jsonError(res, 400, 'symbols required');
  // SECURITY: validate ALL symbols to prevent injection.
  for (const s of symbols) {
    if (!isValidSymbol(s)) return jsonError(res, 400, `invalid symbol: ${s}`);
  }

  const quotes = {};

  // India quotes — Groww NSE → Yahoo fallback
  // FIX H12: previously `const remaining = symbols.filter(s => !quotes[s])`
  // ran BEFORE any quotes were populated (quotes = {}) so `remaining ===
  // symbols` always — dead filter. Just iterate `symbols` directly.
  await Promise.allSettled(symbols.map(async (sym) => {
    // 1a) India real-time → Groww NSE live feed (datacenter-friendly, ETF-safe).
    // Indian indices (NIFTY etc.) skip Groww — Groww only has stock/ETF quotes
    if (market === 'IN' && !INDIAN_INDICES.has(sym)) {
      const gw = await fetchGrowwNseQuote(sym);
      if (gw) { quotes[sym] = gw; return; }
    }
    // 1b-0) Shared realtime-stream session (2026 audit): freshest-known US
    // price from the live SSE stream (Finnhub WS trades, else the Yahoo
    // fallback poller). Serving /api/quote from here means ONE upstream
    // round-trip feeds BOTH the SSE clients and the browser pollers.
    if (market !== 'IN') {
      const ses = getUsSessionQuote(sym.replace('.NS', '').replace('.BO', ''));
      if (ses) { quotes[sym] = ses; return; }
    }
    // 1b) Finnhub real-time (US only — Finnhub free tier is US equities/ETFs)
    if (market !== 'IN') {
      const fh = await fetchFinnhubQuote(sym.replace('.NS', '').replace('.BO', ''));
      if (fh) { quotes[sym] = fh; return; }
    }
    // 2) Yahoo real-time (no key, ~1-2s). Try NSE then BSE for Indian symbols.
    const ysym = toYahooSymbol(sym, market);
    const candidates = (market === 'IN' && !ysym.startsWith('^'))
      ? [ysym, ysym.replace('.NS', '.BO')]
      : [ysym];
    for (const ys of candidates) {
      const yq = await fetchYahooQuote(ys);
      if (yq) { quotes[sym] = yq; return; }
    }
  }));

  // v12.10 BANDWIDTH: Use Cache-Control: no-cache so clients revalidate via ETag.
  // When prices haven't changed, Express answers 304 Not Modified (zero body transfer).
  // Round snapshot ts to 3s window or max quote timestamp so JSON payload is byte-identical
  // between consecutive polls when prices are unchanged.
  const maxQuoteTime = Math.max(0, ...Object.values(quotes).map(q => q.time || 0));
  const snapTs = maxQuoteTime || Math.floor(Date.now() / 3000) * 3000;
  res.set('Cache-Control', 'no-cache');
  return res.json({ quotes, ts: snapTs });
});

// ------------------------------------------------------------
// GET /api/crypto-prices → proxy CoinDCX ticker (CORS fix)
// ------------------------------------------------------------
// CoinDCX's public API does NOT serve Access-Control-Allow-Origin, so
// the browser blocks every direct fetch from the frontend. This thin
// server-side proxy fetches the ticker, caches it briefly (3s) to avoid
// hammering upstream, and returns the full JSON array the frontend expects.
// ------------------------------------------------------------
// ------------------------------------------------------------
// GET /api/crypto-prices → proxy CoinDCX ticker (CORS fix)
// ------------------------------------------------------------
// CoinDCX's public API does NOT serve Access-Control-Allow-Origin, so
// the browser blocks every direct fetch from the frontend. This thin
// server-side proxy fetches the ticker and returns the full JSON array.
// 2026 perf audit (H2): now shares ONE cached in-flight-deduped round-trip
// with the cryptoStream SSE poller — previously both polled the full
// ~0.5-1MB upstream independently (double CPU + GC churn).
// v11.4 recheck: module-level so the transition log survives across requests
let _lastTickerSourceLogged = null;
// v12.7 BANDWIDTH (recheck R2-#1 — the biggest pure-egress lever): the
// client used to download the FULL ~400-market ticker array (~300KB raw)
// every 30s while only reading its own ~20-symbol watchlist. ?symbols=
// (comma list, e.g. BTC,SOL,DOGE) slices the cached array server-side to
// exactly the requested markets (~8KB) — a ~97% egress cut on this
// endpoint. No param = full array (backward-compatible for tests/tools).
// The filter itself lives in lib/tickerFilter.js (unit-tested there).
app.get('/api/crypto-prices', async (req, res) => {
  // v12.7: ?symbols= responses may be revalidated (the upstream cache is
  // 20s; a repeat poll inside the window gets a byte-identical body →
  // Express's weak ETag answers 304 → zero body transfer).
  res.set('Cache-Control', 'no-cache');
  try {
    const tickers = await fetchCoinDcxTickers();
    const served = filterTickersBySymbols(tickers, req.query.symbols);
    // v11.3: honest observability — which leg served (REST / spot-WS /
    // Binance-fx synth / stale). The header rides every response so a
    // degraded feed is visible without server access.
    // v11.4 recheck: log on SOURCE TRANSITION only — the frontend polls this
    // endpoint every 3s per tab, so per-request logging flooded Render logs
    // with ~1,200 identical lines/hour exactly during CoinDCX incidents.
    const _src = lastTickerSource();
    res.set('X-Price-Source', _src);
    if (_src !== _lastTickerSourceLogged && _src !== 'coindcx-rest') {
      _lastTickerSourceLogged = _src;
      // v18.5 FIX: the WS-FIRST design (cryptoStream v12.6) PREFERS the
      // spot-WS book over REST — a WS source here is the HEALTHY path,
      // not an outage. The old text ("CoinDCX REST unreachable") misread
      // normal operation as a failure in every log/terminal.
      console.log(`[crypto-prices] serving via ${_src} (WS-first mode — REST is the fallback, not required)`);
    } else if (_src === 'coindcx-rest' && _lastTickerSourceLogged !== null) {
      console.log(`[crypto-prices] REST recovered (${_lastTickerSourceLogged} -> coindcx-rest)`);
      _lastTickerSourceLogged = null;
    }
    return res.json(served);
  } catch (e) {
    return jsonError(res, 502, 'Failed to fetch crypto prices.', e);
  }
});

// ------------------------------------------------------------
// GET /api/forex → USD/INR rate proxy with server-side caching
// ------------------------------------------------------------
// Multiple upstream fallbacks so the rate is always available even if
// one free API is down. Cached 10s server-side to reduce upstream load.
// ------------------------------------------------------------
let _forexCache = { rate: DEFAULT_USD_INR, ts: 0 };
// FIX OPT-6: increased from 10s to 30s — client polls at 60s+, so 10s
// cache was cold on most hits and hammered upstream free-tier APIs.
const FOREX_CACHE_MS = 30000;

const FOREX_UPSTREAMS = [
  'https://open.er-api.com/v6/latest/USD',
  'https://api.frankfurter.app/latest?from=USD&to=INR',
  'https://api.exchangerate-api.com/v4/latest/USD',
];

async function fetchForexUpstream() {
  for (const url of FOREX_UPSTREAMS) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(4000) });
      if (!r.ok) continue;
      const j = await r.json();
      const inr = j?.rates?.INR;
      if (typeof inr === 'number' && inr > 50 && inr < 150) return inr;
    } catch { /* try next */ }
  }
  return null;
}

app.get('/api/forex', async (_req, res) => {
  const now = Date.now();
  if (_forexCache.rate && (now - _forexCache.ts) < FOREX_CACHE_MS) {
    res.set('Cache-Control', 'no-store, max-age=0');
    return res.json({ usdInr: _forexCache.rate, ts: _forexCache.ts, live: true });
  }
  const rate = await fetchForexUpstream();
  if (rate) _forexCache = { rate, ts: now };
  // v7.0.2: mark the fallback honestly — the old response stamped the
  // hardcoded DEFAULT_USD_INR as `ts: Date.now()` (a stale constant
  // disguised as a fresh quote for every consumer).
  const served = rate || _forexCache.rate || null;
  res.set('Cache-Control', 'no-store, max-age=0');
  return res.json({
    usdInr: served ?? DEFAULT_USD_INR,
    ts: served ? (rate ? now : _forexCache.ts) : 0,
    live: !!rate,
    ...(served ? {} : { fallback: true, fallbackRate: DEFAULT_USD_INR }),
  });
});

// ------------------------------------------------------------
// GET /api/stream  → Server-Sent Events: pushes live ticks to the browser.
// Query: ?in=RELIANCE,NIFTYBEES&us=SMH,VGT&crypto=BTC,ETH
// Events: `snapshot` (initial map), `tick` ({key,price,change,...}), `status`.
// Ultra-fast realtime push: India (Groww 3s + TV browser WS), US (Finnhub WS
// trades + TV america/scan 3s batch + Yahoo fallback), crypto (CoinDCX 2s
// anchor + Binance WS ~1s projected ticks). Per-key throttle keeps the
// stream light.
// ------------------------------------------------------------
function parseSyms(v) {
  // v7.0.2 SECURITY: validate the symbol charset — /api/stream is a PUBLIC
  // endpoint and anonymous visitors could previously subscribe up to 180
  // ARBITRARY strings per connection (upstream amplification / 429 bans).
  return String(v || '').split(',')
    .map(s => s.trim().toUpperCase())
    .filter(Boolean)
    .filter(s => /^[A-Z0-9._-]{1,20}$/.test(s))
    .slice(0, 60);
}

// v7.0.2 SECURITY + v18.6.3 REALTIME: cap concurrent SSE connections per
// IP, class-aware (see lib/sseCap.js). The app's OWN browser session
// legitimately holds 3 streams (global liveStream + CoinDCX board +
// manual-trade tracker) — the old flat cap of 3 meant any reconnect
// race or second tab 429'd into a PERMANENT "live feed down — retrying"
// loop (EventSource retries the same URL forever). Loopback/authed get
// 8/6 slots; anonymous remote stays at 3 (upstream amplification guard).
const _sseConns = new Map(); // ip → count
function sseConnMax(req, ip) {
  const token = extractSessionToken({ headers: req.headers, query: req.query });
  const authed = !!(token && _sessions.has(token));
  return { max: sseConnMaxFor(ip, authed), authed };
}
function sseConnAllowed(req, ip) {
  const n = _sseConns.get(ip) || 0;
  return n < sseConnMax(req, ip).max;
}
function sseConnOpen(ip) { _sseConns.set(ip, (_sseConns.get(ip) || 0) + 1); }
function sseConnClose(ip) {
  const n = (_sseConns.get(ip) || 1) - 1;
  if (n <= 0) _sseConns.delete(ip); else _sseConns.set(ip, n);
}

// ------------------------------------------------------------
// India server-side stream init (2026 realtime audit RC5) — injects the
// 3s-micro-cached quote fetchers so the 5s inStream poll shares upstream
// round-trips with /api/quote, the intraday scanner and the SSE watcher.
// ------------------------------------------------------------
initInStream({ fetchGrowwNseQuote, fetchYahooQuote, toYahooSymbol });

// v18.6.4 PROXY TRUST: X-Forwarded-For sirf tabhi honor hota hai jab the
// TCP peer khud loopback ho (localhost reverse-proxy) YA
// TRUST_PROXY=1 explicitly set ho (Render-style deployment). Pehle
// last XFF entry unconditionally trust hota thi — ek LAN peer
// "X-Forwarded-For: 127.0.0.1" bhej ke loopback SSE cap (8) + shared
// bucket mil sakta tha, aur login limiter rotate ho sakta tha.
// v21.1.0 (Phase-2): PaaS AUTO-DETECT — Render/DYNO/Railway-style env pe
// TCP peer HAMESHA load-balancer ka IP hota hai (TRUST_PROXY=1 ke bina sab
// users EK hi rate-limit bucket me ginte the: ek galat user poori terminal
// lock kar deta tha). Ab explicit TRUST_PROXY env override karti hai; uske
// bina PaaS pe default-on, bare-metal/local pe default-off. XFF parse
// LAST-entry leta hai (single-hop proxy ke liye spoof-resistant — client ke
// fake XFF ke baad appended real IP last me rehta hai).
// v21.1.1 [audit B15]: explicit override ab 1/true/yes/ON accept karta hai
// (TRUST_PROXY=true pehle silently OFF rehta tha); PaaS hint me "false"/"0"
// string-values ab ignore hote hain (RENDER="false" trust enable nahi karega).
const _TRUST_PROXY_EXPLICIT = process.env.TRUST_PROXY !== undefined;
const _TRUST_PROXY_TRUE = ['1', 'true', 'yes', 'on'].includes(String(process.env.TRUST_PROXY || '').trim().toLowerCase());
const _PAAS_HINT = [process.env.RENDER, process.env.DYNO, process.env.RAILWAY_ENVIRONMENT]
  .some(v => { const s = String(v || '').trim().toLowerCase(); return s.length > 0 && s !== 'false' && s !== '0' && s !== 'no' && s !== 'off'; });
const TRUST_PROXY = _TRUST_PROXY_EXPLICIT
  ? _TRUST_PROXY_TRUE
  : _PAAS_HINT;
function _isLoopback(ip) {
  const s = String(ip || '');
  return s === '127.0.0.1' || s === '::1' || s === '::ffff:127.0.0.1' || s.startsWith('::ffff:127.');
}
function clientIpOf(req) {
  const peer = req.socket?.remoteAddress || 'unknown';
  if (TRUST_PROXY || _isLoopback(peer)) {
    const xff = (req.headers['x-forwarded-for'] || '').toString().split(',').map((x) => x.trim()).filter(Boolean);
    if (xff.length > 0) return xff[xff.length - 1];
  }
  return peer;
}

app.get('/api/stream', (req, res) => {
  // v7.0.2 SECURITY + v18.6.3: per-IP SSE connection cap (class-aware —
  // see sseConnMax above / lib/sseCap.js). Authed/loopback retries get a
  // SHORT Retry-After so a blip heals in seconds, anonymous storms keep
  // the protective 30s.
  const _sseIp = clientIpOf(req);
  if (!sseConnAllowed(req, _sseIp)) {
    const { authed } = sseConnMax(req, _sseIp);
    return res.status(429).set('Retry-After', authed ? '5' : '30').json({ error: { message: 'Too many stream connections from this IP.' } });
  }
  sseConnOpen(_sseIp);
  res.on('close', () => sseConnClose(_sseIp));

  const inSyms = parseSyms(req.query.in);
  const usSyms = parseSyms(req.query.us);
  const cryptoSyms = parseSyms(req.query.crypto);
  // v10.10: the two CoinDCX perpetual domains — B-<BASE>_USDT perps and
  // B-<SYM>_USDC global equity perps — served by ai/cxRtStream.js (2s
  // direct CoinDCX poll, refcounted, idle-stop). SPOT stays on crypto=.
  const futSyms = parseSyms(req.query.fut);
  const globSyms = parseSyms(req.query.glob);

  const keys = new Set([
    ...inSyms.map(s => `IN_${s}`),
    ...usSyms.map(s => `US_${s}`),
    ...cryptoSyms.map(s => `IN_${s}`),
    ...futSyms.map(s => `FUT_${s}`),
    ...globSyms.map(s => `GLOB_${s}`),
  ]);

  // Kick off / refresh upstream subscriptions for the requested symbols.
  // 2026 realtime audit (RC5): Indian equities now get a server-side push
  // stream too (Groww NSE during market hours + Yahoo indices fallback) —
  // previously only US (Finnhub) and crypto (CoinDCX) had SSE sources.
  ensureInSubscribed(inSyms);
  if (usSyms.length) ensureUsSubscribed(usSyms);
  ensureCryptoSubscribed(cryptoSyms);
  ensureCxRtSubscribed({ fut: futSyms, glob: globSyms });

  // Notify streams a client is now active — starts polling/WebSocket if idle
  inClientUp();
  // v10.13 (deep-recheck L-5): an India/crypto-only session no longer holds
  // an EMPTY Finnhub socket open for its lifetime (usClientUp connects
  // unconditionally while ensureUsSubscribed is gated on usSyms.length).
  if (usSyms.length) usClientUp();
  cryptoClientUp();
  if (futSyms.length || globSyms.length) cxRtClientUp();

  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-store, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  if (res.flushHeaders) res.flushHeaders();
  // v10.13 (deep-recheck L-6): guarded — the close/cleanup handlers below
  // register AFTER this write; a synchronous throw here would skip them and
  // leak the clientUp refcounts (pollers would never stop).
  try { res.write('retry: 3000\n\n'); } catch { /* client gone before start */ }

  // ---- 2026 perf audit (H1): SSE backpressure guard ----
  // A stalled client (phone sleep / TCP zero-window) makes Node buffer every
  // SSE write in memory indefinitely — no drain handler, no cap. If write()
  // returns false AND the socket buffer exceeds 128KB we kill the connection
  // (the browser EventSource auto-reconnects when it wakes up). Without this,
  // 2-3 black-holed clients could eat ~36MB/hour each on a 512MB box.
  let _dead = false;
  const _sseWrite = (payload) => {
    if (_dead) return false;
    try {
      const ok = res.write(payload);
      // v13.2 B6: every frame that actually hit the socket counts
      // (compression skips text/event-stream → byteLength IS the wire size).
      trackBytes('sse:stream', typeof payload === 'string' ? Buffer.byteLength(payload) : (Buffer.isBuffer(payload) ? payload.length : 0));
      if (!ok && res.socket && res.socket.writableLength > 128 * 1024) {
        _dead = true;
        try { res.destroy(); } catch { /* noop */ }
        return false;
      }
      return true;
    } catch {
      _dead = true;
      return false;
    }
  };

  const snap = feedSnapshot([...keys]);
  if (Object.keys(snap).length) _sseWrite(`event: snapshot\ndata: ${JSON.stringify(snap)}\n\n`);
  else {
    // 2026 realtime audit: fresh symbols were JUST subscribed — their live
    // bootstrap (Yahoo US / Groww India) is still in flight. Send a deferred
    // snapshot (~1.2s) so a freshly-loaded site paints correct prices
    // instantly instead of waiting for the first pushed tick.
    const late = setTimeout(() => {
      try {
        const s2 = feedSnapshot([...keys]);
        if (Object.keys(s2).length) _sseWrite(`event: snapshot\ndata: ${JSON.stringify(s2)}\n\n`);
      } catch { /* client gone */ }
    }, 1200);
    if (typeof late.unref === 'function') late.unref();
    req.on('close', () => clearTimeout(late));
  }

  // v12.7 BANDWIDTH (recheck R2-#3): per-symbol SSE throttle 400ms→1000ms
  // + a dead-tick filter (|Δprice| < 0.05% vs the last SENT price pushes
  // nothing). ~33 subscribed keys × ~200B/frame at ~1Hz was ~0.3-0.4GB/day
  // of pure egress for price noise the UI's 800ms batcher smoothed away
  // anyway. A REAL move (>0.05%) still lands within its 1s slot.
  // v20.7.3 FIX: the dead-tick branch used to overwrite the stored price
  // with the UNSSENT price — a steady <0.05%/sec drift never crossed the
  // threshold against the previous tick, so nothing was EVER pushed and
  // clients displayed stale prices while the market drifted several %.
  // The baseline must stay the last SENT price (clock refreshes only).
  const lastSent = {};
  // v20.7.10: FLAT-PRICE HEARTBEAT — dead-band suppress karta tha ki flat
  // price wale symbols pe KABHI tick nahi jata; client (useCxLivePrices)
  // ka dead-band exemption phir ⚡ live label ko feed-alive hone tak (10
  // min tak) purane price pe zinda rakh sakta tha. Ab suppressed tick ke
  // 45s baad bhi wire pe kuch nahi gaya → force-send ek tick (flat price
  // client-side hamesha ≤45s fresh; dead-leg 120s me honest null).
  const lastSentAt = {};
  const unsub = feedSubscribe((key, tick) => {
    if (_dead || !keys.has(key)) return;
    const now = Date.now();
    const prev = lastSent[key];
    if (prev) {
      if ((now - prev.at) < 1000) return; // ≤1 update/sec/symbol
      const prevPrice = Number(prev.price);
      const price = Number(tick?.price);
      if (Number.isFinite(prevPrice) && prevPrice > 0 && Number.isFinite(price)
        && Math.abs(price - prevPrice) / prevPrice < 0.0005) {
        lastSent[key] = { at: now, price: prevPrice }; // refresh clock ONLY — keep last SENT price as baseline
        if (now - (lastSentAt[key] || 0) > 45_000) {
          lastSentAt[key] = now;
          _sseWrite(`event: tick\ndata: ${JSON.stringify({ key, ...tick })}\n\n`);
        }
        return;
      }
    }
    lastSent[key] = { at: now, price: Number(tick?.price) || null };
    lastSentAt[key] = now;
    _sseWrite(`event: tick\ndata: ${JSON.stringify({ key, ...tick })}\n\n`);
  });

  const keepalive = setInterval(() => {
    // v10.14 (deep-recheck S2 #3): the status frame now carries the cxRt
    // WS accelerator health (cooldown reason + remaining) so the CoinDCX
    // desk badge can explain a degradation instead of silently reverting
    // to REST. Flat source→bool keys stay first — existing consumers
    // (useAppState watchdogs) only regex-match those key names.
    _sseWrite(`event: status\ndata: ${JSON.stringify({ ...feedStatus(), cxRt: cxRtWsStatus() })}\n\n`);
  }, 15000);
  if (typeof keepalive.unref === 'function') keepalive.unref();

  req.on('close', () => {
    clearInterval(keepalive);
    unsub();
    // Notify streams this client left — pauses polling when no clients remain
    inClientDown();
    // v11.4 recheck: mirror the up-gate — a crypto/India-only session must
    // NOT decrement the US refcount it never incremented (it killed the
    // Finnhub feed for OTHER still-connected US sessions).
    if (usSyms.length) usClientDown();
    cryptoClientDown();
    if (futSyms.length || globSyms.length) cxRtClientDown();
    // Refcount release (2026 perf audit M2): the LAST client that wanted a
    // symbol schedules its graceful unsubscribe - subscribed sets no longer
    // grow for the whole process lifetime.
    releaseInSubscribed(inSyms);
    releaseUsSubscribed(usSyms);
    releaseCryptoSubscribed(cryptoSyms);
    releaseCxRtSubscribed({ fut: futSyms, glob: globSyms });
    try { res.end(); } catch { /* noop */ }
  });
});

// GET /api/feed-status → which real-time sources are live (for the UI dot).
app.get('/api/feed-status', (_req, res) => {
  res.set('Cache-Control', 'no-store');
  // v10.14: also carries the cxRt WS accelerator health (same shape as
  // the SSE status frame) — one health contract for poll + stream.
  res.json({ ...feedStatus(), cxRt: cxRtWsStatus() });
});

// ------------------------------------------------------------
// GET /api/ai-status → which providers have a key configured.
// The frontend skips any engine that is false here.
// ------------------------------------------------------------
app.get('/api/ai-status', (_req, res) => {
  res.json({
    gemini: !!KEYS.gemini,
    groq: !!KEYS.groq,
    claude: !!KEYS.claude,
    openrouter: !!KEYS.openrouter,
    cerebras: !!KEYS.cerebras,
    huggingface: !!KEYS.huggingface,
    nvidia: !!KEYS.nvidia,
    tavily: !!KEYS.tavily,
  });
});

// ------------------------------------------------------------
// Generic OpenAI-compatible proxy (groq/openrouter/cerebras/hf/nvidia)
// ------------------------------------------------------------
for (const [name, cfg] of Object.entries(OPENAI_COMPAT)) {
  app.post(`/api/${name}`, async (req, res) => {
    const key = KEYS[name];
    if (!key) return jsonError(res, 503, `${name} not configured`);
    try {
      const body = { ...req.body };
      // v10.13 (deep-recheck L-4): clamp client-controlled completion params
      // on the compat proxies — /api/claude already capped max_tokens at 8192,
      // but these proxies forwarded it (and `stream`) as-is, so an auth'd
      // client could request max_tokens: 200000 or SSE-stream every call
      // (quota burn on the shared free-tier keys).
      if (typeof body.max_tokens === 'number') body.max_tokens = Math.min(8192, Math.max(1, Math.floor(body.max_tokens)));
      else if (body.max_tokens == null) body.max_tokens = 4096;
      if (typeof body.temperature === 'number') body.temperature = Math.min(2, Math.max(0, body.temperature));
      delete body.stream; // the proxies never pipe SSE through — force non-stream
      // Auto-correct deprecated models (e.g. decommissioned Llama 3.3/3.2/3.1, preview-only Llama 4 Scout)
      if (name === 'groq' && (!body.model || body.model.includes('llama-3.3') || body.model.includes('llama-3.2-90b') || body.model.includes('llama-3.1') || body.model.includes('llama-4-scout'))) {
        body.model = 'openai/gpt-oss-120b';
      } else if (!body.model) {
        body.model = cfg.defModel;
      }
      // Auto-correct retired HuggingFace Qwen3-32B → 235B flagship
      if (name === 'huggingface' && body.model && body.model.includes('Qwen3-32B')) {
        body.model = cfg.defModel;
      }
      if (!Array.isArray(body.messages)) return jsonError(res, 400, 'messages[] required');

      // v20.7.12 [H3-4]: TOTAL CHAIN DEADLINE — fallback ladder (primary →
      // llama fallback) ek hi shared 35s signal pe chalti hai. Pehle har
      // fetch apna 30s leta tha → worst case ~60s ek request socket + res
      // pin karta tha. Ab pehla fetch max 30s kha sakta hai, fallback bache
      // hue time me hi try hota hai; deadline nikal gaya → seedha 502.
      const chainDeadline = AbortSignal.timeout(35_000);
      const chainFetch = (url, init = {}) =>
        fetch(url, { ...init, signal: chainDeadline });

      let upstream = await chainFetch(cfg.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${key}`,
          ...(name === 'openrouter' ? { 'HTTP-Referer': 'https://smartai11.onrender.com', 'X-Title': 'Wealth AI Pro' } : {}),
        },
        body: JSON.stringify(body),
      });

      // v20.8.4 FIX (H3 — dead fallback): the retry used the SAME file's
      // own decommissioned model — llama-3.3-70b-versatile is auto-rewritten
      // AWAY two pages up because Groq retired Llama 3.3/3.2/3.1, so this
      // leg could only ever 400/404 again (one extra upstream round-trip of
      // latency and zero resilience). Retry with the CURRENT default.
      if (!upstream.ok && name === 'groq' && (upstream.status === 400 || upstream.status === 404) && !chainDeadline.aborted) {
        body.model = 'openai/gpt-oss-120b';
        upstream = await chainFetch(cfg.url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${key}`,
          },
          body: JSON.stringify(body),
        });
      }

      const text = await upstream.text();
      res.status(upstream.status).type('application/json').send(text || '{}');
    } catch (e) {
      return jsonError(res, 502, `${name} AI provider is temporarily unavailable.`, e);
    }
  });
}

// ------------------------------------------------------------
// POST /api/tavily → Tavily web search (for NeuralChat live news)
// Translates the OpenAI-style messages body into a Tavily search
// and returns the result in OpenAI-compatible format.
// ------------------------------------------------------------
app.post('/api/tavily', async (req, res) => {
  if (!KEYS.tavily) return jsonError(res, 503, 'tavily not configured');
  try {
    const { messages = [] } = req.body || {};
    const userMsg = messages.filter(m => m.role === 'user').map(m => m.content).join(' ').trim();
    if (!userMsg) return jsonError(res, 400, 'search query required');
    const query = userMsg.substring(0, 400); // Tavily max query length
    const upstream = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_key: KEYS.tavily,
        query,
        search_depth: 'basic',
        max_results: 5,
        include_answer: true,
      }),
      signal: AbortSignal.timeout(10000),
    });
    if (!upstream.ok) return jsonError(res, 502, 'tavily upstream error');
    const data = await upstream.json();
    // Package as OpenAI-compatible response so the frontend can consume it uniformly
    const answer = data.answer || '';
    const results = (data.results || []).map(r => `• ${r.title}: ${r.content?.substring(0, 200) || ''}`).join('\n');
    const content = answer ? `${answer}\n\nSources:\n${results}` : results || 'No results found.';
    res.json({
      choices: [{ message: { role: 'assistant', content } }],
    });
  } catch (e) {
    return jsonError(res, 502, 'Search service is temporarily unavailable.', e);
  }
});

// ------------------------------------------------------------
// POST /api/gemini → translate OpenAI-style messages → Gemini,
// return Gemini's native shape (candidates[0].content.parts[0].text)
// ------------------------------------------------------------
app.post('/api/gemini', async (req, res) => {
  if (!KEYS.gemini) return jsonError(res, 503, 'gemini not configured');
  try {
    const { messages = [], model } = req.body || {};
    if (!Array.isArray(messages)) return jsonError(res, 400, 'messages[] required');

    // Normalize model name (gemini-3.5-flash / gemini-2.5-flash / gemini-2.0-flash)
    let requestedModel = model;
    if (!requestedModel || requestedModel.includes('2.0') || requestedModel.includes('1.5')) {
      requestedModel = 'gemini-3.5-flash';
    }
    const safeModel = String(requestedModel).replace(/[^a-zA-Z0-9.-]/g, '').slice(0, 50) || 'gemini-3.5-flash';

    const systemText = messages.filter(m => m.role === 'system').map(m => m.content).join('\n').trim();
    const contents = messages
      .filter(m => m.role !== 'system')
      .map(m => ({ role: m.role === 'assistant' || m.role === 'model' ? 'model' : 'user', parts: [{ text: String(m.content || '') }] }));
    const payload = { contents };
    if (systemText) payload.systemInstruction = { parts: [{ text: systemText }] };

    // v20.7.12 [H3-4]: TOTAL CHAIN DEADLINE — 4-rung model fallback
    // (3.5 → 2.5 → 2.0 → 1.5) pehle har rung apna 30s leta tha = worst
    // ~120s pinned socket. Ab ek shared 35s signal saare rungs pe — jo
    // bache hue time me fit ho wahi try hota hai.
    const chainDeadline = AbortSignal.timeout(35_000);
    const chainFetch = (url) => fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: chainDeadline,
    });

    let url = `https://generativelanguage.googleapis.com/v1beta/models/${safeModel}:generateContent?key=${KEYS.gemini}`;
    let upstream = await chainFetch(url);

    // If candidate model returns 404 (model not found): 3.5 → 2.5 → 2.0 → 1.5
    if (!upstream.ok && upstream.status === 404 && safeModel !== 'gemini-2.5-flash' && !chainDeadline.aborted) {
      url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${KEYS.gemini}`;
      upstream = await chainFetch(url);
    }
    if (!upstream.ok && upstream.status === 404 && safeModel !== 'gemini-2.0-flash' && !chainDeadline.aborted) {
      url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${KEYS.gemini}`;
      upstream = await chainFetch(url);
    }
    if (!upstream.ok && upstream.status === 404 && !chainDeadline.aborted) {
      url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${KEYS.gemini}`;
      upstream = await chainFetch(url);
    }

    const text = await upstream.text();
    res.status(upstream.status).type('application/json').send(text || '{}');
  } catch (e) {
    return jsonError(res, 502, 'Gemini AI provider is temporarily unavailable.', e);
  }
});

// ------------------------------------------------------------
// POST /api/claude → Anthropic Messages API,
// return native shape (content[0].text)
// ------------------------------------------------------------
app.post('/api/claude', async (req, res) => {
  if (!KEYS.claude) return jsonError(res, 503, 'claude not configured');
  try {
    const { messages = [], model = 'claude-sonnet-5', max_tokens = 1024 } = req.body || {};
    if (!Array.isArray(messages)) return jsonError(res, 400, 'messages[] required');
    // Cap max_tokens to prevent quota abuse.
    const safeMaxTokens = Math.min(Math.max(parseInt(max_tokens) || 1024, 1), 8192);
    const safeModel = String(model).replace(/[^a-zA-Z0-9.-]/g, '').slice(0, 50) || 'claude-sonnet-5';
    const system = messages.filter(m => m.role === 'system').map(m => m.content).join('\n').trim();
    const conv = messages
      .filter(m => m.role !== 'system')
      .map(m => ({ role: m.role === 'model' || m.role === 'assistant' ? 'assistant' : 'user', content: String(m.content || '') }));
    const payload = { model: safeModel, max_tokens: safeMaxTokens, messages: conv };
    if (system) payload.system = system;
    const upstream = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': KEYS.claude,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(30000),
    });
    const text = await upstream.text();
    res.status(upstream.status).type('application/json').send(text || '{}');
  } catch (e) {
    return jsonError(res, 502, 'Claude AI provider is temporarily unavailable.', e);
  }
});

// ------------------------------------------------------------
app.post('/api/chat/mcp', async (req, res) => {
  const { messages = [], engine = 'gemini', model = '', portfolio = [], livePrices = {} } = req.body || {};
  if (!Array.isArray(messages) || messages.length === 0) {
    return jsonError(res, 400, 'messages[] required');
  }

  const systemText = messages.filter(m => m.role === 'system').map(m => m.content).join('\n').trim();
  const userConvo = messages.filter(m => m.role !== 'system');
  const usedTools = [];
  // 2026 perf audit (M3): inject the 3s-micro-cached quote fetchers so the
  // MCP tool layer shares ONE upstream round-trip with the scanner, the SSE
  // watcher and /api/quote — previously get_live_quote re-implemented direct
  // Groww/Yahoo fetches (uncached, unbatched) on every agentic chat round.
  const toolContext = { tavilyKey: KEYS.tavily, portfolio, livePrices, fetchGrowwNseQuote, fetchYahooQuote };

  // 1. Gemini Agentic Tool Calling
  if ((engine === 'gemini' || engine === 'auto') && KEYS.gemini) {
    try {
      // SECURITY FIX (audit M-6): sanitize the client-supplied model name the
      // same way /api/gemini does -- previously the raw string was interpolated
      // into the upstream URL, allowing path/query injection vs the Gemini host.
      const targetModel = (() => {
        const raw = model && !model.includes('2.0') && !model.includes('1.5') ? model : 'gemini-3.5-flash';
        return String(raw).replace(/[^a-zA-Z0-9.-]/g, '').slice(0, 64) || 'gemini-3.5-flash';
      })();
      const contents = userConvo.map(m => ({
        role: m.role === 'assistant' || m.role === 'model' ? 'model' : 'user',
        parts: [{ text: String(m.content || '') }]
      }));

      const payload = {
        contents,
        systemInstruction: systemText ? { parts: [{ text: systemText }] } : undefined,
        tools: SERVER_MCP_TOOLS_GEMINI,
        generationConfig: { temperature: 0.7, maxOutputTokens: 4000 }
      };

      const upstream = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${targetModel}:generateContent?key=${KEYS.gemini}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(30000) // FIX Bug 4: increased from 20s to 30s for tool execution chains
      });

      if (!upstream.ok) throw new Error(`Gemini upstream error ${upstream.status}`);
      let data = await upstream.json();
      let candidate = data.candidates?.[0]?.content?.parts?.[0];

      // Tool loop (up to 2 calls)
      let loopCount = 0;
      while (candidate?.functionCall && loopCount < 2) {
        loopCount++;
        const fn = candidate.functionCall;
        usedTools.push(fn.name);
        const toolResult = await executeServerMCPTool(fn.name, fn.args, toolContext);

        contents.push({ role: 'model', parts: [{ functionCall: fn }] });
        contents.push({
          role: 'user',
          parts: [{ functionResponse: { name: fn.name, response: { result: toolResult } } }]
        });

        // BUG FIX (audit): the follow-up request previously re-sent the ORIGINAL
        // `payload` -- the tool result appended to `contents` was never actually
        // transmitted, so the model never saw its tool outputs.
        const followUpPayload = { ...payload, contents: contents.map(c => ({ ...c })) };
        const followUp = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${targetModel}:generateContent?key=${KEYS.gemini}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(followUpPayload),
          signal: AbortSignal.timeout(30000) // FIX Bug 4: increased from 20s to 30s
        });

        if (followUp.ok) {
          data = await followUp.json();
          candidate = data.candidates?.[0]?.content?.parts?.[0];
        } else {
          break;
        }
      }

      const text = data.candidates?.[0]?.content?.parts?.map(p => p.text).filter(Boolean).join('\n') || '';
      return res.json({
        text,
        usedEngine: targetModel,
        usedTools,
        isMCP: true
      });
    } catch (e) {
      console.warn('[MCP Server] Gemini tool call failed, attempting Groq fallback:', e.message);
    }
  }

  // 2. Groq / OpenAI Compatible Agentic Tool Calling
  const groqKey = KEYS.groq;
  if (groqKey) {
    try {
      const targetModel = 'openai/gpt-oss-120b';
      // Follow-up tool-result requests must use the model that ACTUALLY
      // answered the first call: re-sending a failed primary model 400s
      // again on the follow-up and the user gets an empty MCP answer.
      let activeModel = targetModel;
      const reqMessages = systemText ? [{ role: 'system', content: systemText }, ...userConvo] : [...userConvo];

      let upstream = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${groqKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: targetModel,
          messages: reqMessages,
          tools: SERVER_MCP_TOOLS_OPENAI,
          temperature: 0.7,
          max_completion_tokens: 4000
        }),
        signal: AbortSignal.timeout(30000) // FIX Bug 4: increased from 20s to 30s
      });

      // FIX Bug 3: If primary model fails (400/404 = model doesn't support tools),
      // fallback to the CURRENT default (v20.8.4: llama-3.3-70b-versatile is
      // decommissioned on Groq — the retry itself used to 400/404).
      if (!upstream.ok && (upstream.status === 400 || upstream.status === 404 || upstream.status === 422)) {
        const fallbackModel = 'openai/gpt-oss-120b';
        console.warn(`[MCP Server] Groq ${targetModel} failed (${upstream.status}), trying ${fallbackModel}...`);
        activeModel = fallbackModel;
        upstream = await fetch('https://api.groq.com/openai/v1/chat/completions', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${groqKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: fallbackModel,
            messages: reqMessages,
            tools: SERVER_MCP_TOOLS_OPENAI,
            temperature: 0.7,
            max_completion_tokens: 4000
          }),
          signal: AbortSignal.timeout(30000)
        });
      }

      if (!upstream.ok) throw new Error(`Groq upstream error ${upstream.status}`);
      let data = await upstream.json();
      let choice = data.choices?.[0];

      // Tool loop (up to 2 calls)
      let loopCount = 0;
      while (choice?.message?.tool_calls && choice.message.tool_calls.length > 0 && loopCount < 2) {
        loopCount++;
        reqMessages.push(choice.message);

        for (const tc of choice.message.tool_calls) {
          let args = {};
          try { args = JSON.parse(tc.function.arguments || '{ /* journal write best-effort */ }'); } catch { /* journal write best-effort */ }
          usedTools.push(tc.function.name);
          const toolResult = await executeServerMCPTool(tc.function.name, args, toolContext);
          reqMessages.push({
            role: 'tool',
            tool_call_id: tc.id,
            name: tc.function.name,
            content: JSON.stringify(toolResult)
          });
        }

        const followUp = await fetch('https://api.groq.com/openai/v1/chat/completions', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${groqKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: activeModel, messages: reqMessages, temperature: 0.7, max_completion_tokens: 4000 }),
          signal: AbortSignal.timeout(30000) // FIX Bug 4: increased from 20s to 30s
        });

        if (followUp.ok) {
          data = await followUp.json();
          choice = data.choices?.[0];
        } else {
          break;
        }
      }

      const text = choice?.message?.content || '';
      return res.json({
        text,
        usedEngine: 'groq-gpt-oss',
        usedTools,
        isMCP: true
      });
    } catch (e) {
      console.warn('[MCP Server] Groq tool call failed:', e.message);
    }
  }

  return jsonError(res, 502, 'MCP Tool Execution unavailable');
});

// ------------------------------------------------------------
// POST /api/vision-analysis → Gemini Vision Chart & Screenshot AI
// Analyzes technical charts, candlestick setups, support/resistance
// ------------------------------------------------------------
app.post('/api/vision-analysis', async (req, res) => {
  if (!KEYS.gemini) return jsonError(res, 503, 'Gemini Vision not configured on server');
  try {
    const { image, query, mimeType = 'image/jpeg' } = req.body || {};
    if (!image) return jsonError(res, 400, 'Base64 image payload required');

    // Clean base64 string
    const base64Data = image.includes(',') ? image.split(',')[1] : image;
    const prompt = query || 'Analyze this financial trading chart in detail. Identify the asset symbol, price trend, key support and resistance zones, candlestick patterns, technical indicator signals, and provide an actionable setup with exact Entry, Stop-Loss, and Target 1/Target 2 levels with Risk-to-Reward ratio in crisp Hinglish.';

    const payload = {
      contents: [{
        parts: [
          { text: prompt },
          { inlineData: { mimeType, data: base64Data } }
        ]
      }]
    };

    let url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:generateContent?key=${KEYS.gemini}`;
    let upstream = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(45000),
    });

    if (!upstream.ok && upstream.status === 404) {
      url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${KEYS.gemini}`;
      upstream = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(45000),
      });
    }

    if (!upstream.ok && upstream.status === 404) {
      url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${KEYS.gemini}`;
      upstream = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(45000),
      });
    }

    if (!upstream.ok) {
      const errText = await upstream.text();
      // v10.13 (deep-recheck L-2): log the upstream body server-side; the
      // client gets a generic message — the raw body can carry provider
      // account hints / internal detail to the browser.
      console.error('[vision-analysis] upstream error:', upstream.status, String(errText).slice(0, 500));
      return jsonError(res, 502, `Gemini Vision error: ${upstream.status}`);
    }

    const data = await upstream.json();
    const analysisText = data?.candidates?.[0]?.content?.parts?.[0]?.text || 'No analysis generated from image.';

    res.json({
      ok: true,
      analysis: analysisText,
      engine: 'gemini-vision-3.5',
      timestamp: Date.now()
    });
  } catch (err) {
    return jsonError(res, 502, 'Vision analysis failed', err);
  }
});

// ------------------------------------------------------------
// POST /api/ai-consensus → Multi-Engine AI Voting & Consensus
// Queries Gemini, Groq, and Cerebras/Claude in parallel to build consensus
// ------------------------------------------------------------
app.post('/api/ai-consensus', async (req, res) => {
  const { query, context = '' } = req.body || {};
  if (!query) return jsonError(res, 400, 'query string required');

  const models = [
    { name: 'Gemini 3.5 Flash', endpoint: 'gemini', model: 'gemini-3.5-flash' },
    { name: 'Groq GPT-OSS 120B', endpoint: 'groq', model: 'openai/gpt-oss-120b' },
    { name: 'Cerebras GPT-OSS 120B', endpoint: 'cerebras', model: 'gpt-oss-120b' },
  ];

  const systemPrompt = `You are an elite quantitative consensus engine.
Context: ${context || 'General Market'}
Task: Analyze the user request. Provide a definitive stance (BULLISH / BEARISH / NEUTRAL), specific price levels/targets, key technical reason, and risk parameters in concise Hinglish.`;

  const results = await Promise.allSettled(
    models.map(async (m) => {
      const start = Date.now();
      let responseText = null;

      if (m.endpoint === 'gemini' && KEYS.gemini) {
        const payload = {
          contents: [{ role: 'user', parts: [{ text: `${systemPrompt}\n\nQuery: ${query}` }] }]
        };
        const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${m.model}:generateContent?key=${KEYS.gemini}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(20000),
        });
        if (r.ok) {
          const j = await r.json();
          responseText = j?.candidates?.[0]?.content?.parts?.[0]?.text;
        }
      } else if (KEYS[m.endpoint]) {
        const cfg = OPENAI_COMPAT[m.endpoint];
        const r = await fetch(cfg.url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEYS[m.endpoint]}` },
          body: JSON.stringify({
            model: m.model,
            messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: query }],
            max_tokens: 1024,
          }),
          signal: AbortSignal.timeout(20000),
        });
        if (r.ok) {
          const j = await r.json();
          responseText = j?.choices?.[0]?.message?.content;
        }
      }

      if (!responseText) throw new Error(`${m.name} unavailable`);

      // v20.1 FIX (deep audit): the old BULLISH-first substring test read any
      // bearish answer containing the word "buy" ("do NOT buy", "sell; don't
      // buy dips") as BULLISH. Count BOTH keyword classes: a strict majority
      // decides; a mixed answer is an honest NEUTRAL (never a false bull).
      const lower = responseText.toLowerCase();
      const bullHits = ['bullish', 'buy', 'accumulate'].filter(w => lower.includes(w)).length;
      const bearHits = ['bearish', 'sell', 'avoid', 'short'].filter(w => lower.includes(w)).length;
      let stance = 'NEUTRAL';
      if (bullHits > bearHits) stance = 'BULLISH';
      else if (bearHits > bullHits) stance = 'BEARISH';

      return {
        model: m.name,
        stance,
        response: responseText,
        latencyMs: Date.now() - start
      };
    })
  );

  const successful = results
    .filter(r => r.status === 'fulfilled')
    .map(r => r.value);

  if (successful.length === 0) {
    return jsonError(res, 502, 'Consensus engines unavailable');
  }

  // Calculate consensus
  const stanceCounts = { BULLISH: 0, BEARISH: 0, NEUTRAL: 0 };
  for (const s of successful) stanceCounts[s.stance] = (stanceCounts[s.stance] || 0) + 1;

  let consensusStance = 'NEUTRAL';
  let maxCount = 0;
  for (const [st, cnt] of Object.entries(stanceCounts)) {
    if (cnt > maxCount) {
      maxCount = cnt;
      consensusStance = st;
    }
  }

  const agreementPct = Math.round((maxCount / successful.length) * 100);

  // Synthesize top response
  const primaryResponse = successful[0]?.response || '';

  res.json({
    ok: true,
    consensusStance,
    agreementPct,
    modelsCount: successful.length,
    models: successful.map(s => ({ name: s.model, stance: s.stance, latencyMs: s.latencyMs })),
    synthesizedResponse: `🤝 **MULTI-ENGINE CONSENSUS: ${consensusStance} (${agreementPct}% Agreement across ${successful.length} Models)**\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n${primaryResponse}`,
    timestamp: Date.now()
  });
});

// ------------------------------------------------------------
// POST /api/telegram → send a Telegram message using the SERVER's
// bot token + chat id (env). Lets the website push notifications
// even when the browser has no local Telegram config saved.
// Body: { message: string }
// FIX C11: Ignore any client-supplied chatId — otherwise any visitor could
// make the bot spam arbitrary chats. Always send to the server-configured
// TG_CHAT_ID. Simple per-IP rate limit (30 msgs / 10 min) prevents abuse.
// ------------------------------------------------------------
const _tgRateBucket = new Map(); // ip → [{ ts }]
const TG_RATE_LIMIT = { windowMs: 10 * 60 * 1000, max: 30 };

function tgRateCheck(ip) {
  const now = Date.now();
  // Prune stale IPs so the map cannot grow unbounded on a public endpoint.
  if (_tgRateBucket.size > 1000) {
    for (const [k, v] of _tgRateBucket) {
      if (!v.length || now - v[v.length - 1] > TG_RATE_LIMIT.windowMs * 2) _tgRateBucket.delete(k);
    }
  }
  const arr = (_tgRateBucket.get(ip) || []).filter(t => now - t < TG_RATE_LIMIT.windowMs);
  if (arr.length >= TG_RATE_LIMIT.max) return false;
  arr.push(now);
  _tgRateBucket.set(ip, arr);
  return true;
}

app.post('/api/telegram', async (req, res) => {
  if (!TG.token || !TG.chatId) return jsonError(res, 503, 'telegram not configured on server');
  const { message } = req.body || {};
  if (!message || typeof message !== 'string') return jsonError(res, 400, 'message required');
  // v20.1 FIX (deep audit): raw XFF trust replaced with clientIpOf() —
  // a forged X-Forwarded-For used to mint unlimited fresh telegram rate
  // buckets (30 msg/10min cap void). clientIpOf: XFF honored only when
  // TRUST_PROXY=1 or the peer is loopback.
  const ip = clientIpOf(req);
  if (!tgRateCheck(ip)) return jsonError(res, 429, 'rate limit exceeded — try again later');

  // SECURITY: strip ALL HTML tags from the client-supplied message.
  // Without this, anyone who can call /api/telegram can inject arbitrary
  // HTML (phishing links, fake system messages) into the user's Telegram
  // chat. The message is forwarded with parse_mode: 'HTML', so any tags
  // would be rendered. We also escape the remaining text so it displays
  // as plain text even under HTML parse mode.
  const safeMessage = escapeHtml(stripHtml(message)).slice(0, 4096);

  try {
    const upstream = await fetch(`https://api.telegram.org/bot${TG.token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: TG.chatId, text: safeMessage, parse_mode: 'HTML', disable_web_page_preview: true }),
      signal: AbortSignal.timeout(10000),
    });
    const text = await upstream.text();
    res.status(upstream.status).type('application/json').send(text || '{}');
  } catch (e) {
    return jsonError(res, 502, 'telegram upstream error', e);
  }
});

// Tell the frontend whether server-side Telegram is available
app.get('/api/telegram-status', (_req, res) => {
  res.json({ configured: !!(TG.token && TG.chatId) });
});

// ------------------------------------------------------------
// SUPER INTELLIGENCE ML ENGINE (Pure JS — No Python service)
// ------------------------------------------------------------
// Replaces the Python FastAPI ML service entirely. All ML
// inference runs IN-PROCESS in this Node.js server — no extra
// service needed. This is critical for Render free tier since
// 2 services would exceed 750 hrs/month limit.
// ------------------------------------------------------------
// v7.0.2 SECURITY: /api/ml/* is public (no auth) and does real CPU work on
// client-supplied candle arrays — apply the same per-IP limiter the Telegram
// endpoints use, and cap the candles so a 1MB body can't drive a 10k-candle
// walk-forward simulation in a tight loop.
const _mlRate = new Map(); // ip → { n, windowStart }
function mlRateCheck(ip) {
  const now = Date.now();
  let r = _mlRate.get(ip);
  if (!r || now - r.windowStart > 10 * 60_000) { r = { n: 0, windowStart: now }; _mlRate.set(ip, r); }
  if (_mlRate.size > 5000) { // bounded map
    for (const [k, v] of _mlRate) { if (now - v.windowStart > 10 * 60_000) _mlRate.delete(k); }
  }
  r.n++;
  return r.n <= 30; // 30 requests / 10 min per IP
}
function mlGuard(req, res) {
  // v20.1 FIX (deep audit): raw XFF trust replaced with clientIpOf() — the
  // PUBLIC /api/ml/* CPU-bound endpoints (500-candle walk-forward) could be
  // rate-limit-evaded by a forged X-Forwarded-For per request (event-loop
  // saturation). Same hardening as the login limiter (v18.6.4).
  const ip = clientIpOf(req);
  if (!mlRateCheck(ip)) {
    return res.status(429).json({ error: 'Too many ML requests — thodi der baad try karo' });
  }
  if (req.body && Array.isArray(req.body.candles)) {
    // v20.8.4 FIX (L — wrong-status crash): a null/garbage ELEMENT inside
    // candles[] used to reach mlEngine and throw TypeError → terminal
    // middleware 500. Validate elements (not just length) → honest 400.
    const clean = req.body.candles.filter((c) => c && typeof c === 'object');
    if (clean.length !== req.body.candles.length) {
      return res.status(400).json({ error: 'candles[] elements must be objects' });
    }
    req.body.candles = req.body.candles.slice(0, 500); // CPU-bound input cap
  }
  return false;
}

app.get('/api/ml/health', (_req, res) => { res.json(mlHealth()); });

app.post('/api/ml/predict', (req, res) => {
  if (mlGuard(req, res)) return;
  const { symbol, market, price, change, candles } = req.body || {};
  if (!symbol) return res.status(400).json({ error: 'symbol required' });
  // v11.4 recheck: `price || 100` fabricated ₹100-anchored entry/SL/target
  // levels whenever the client mounted before its live price landed — the
  // Dashboard ML card then showed absurd levels (₹1,250 stock → Entry ₹97)
  // and the panel's broken refetch gate (fixed alongside) never corrected
  // them. Derive the anchor from the last candle when possible; otherwise
  // refuse honestly — never invent a price.
  let mlPrice = Number(price);
  if (!(mlPrice > 0) && Array.isArray(candles) && candles.length) {
    const c = candles[candles.length - 1];
    const lastClose = Number(c?.close ?? c?.c);
    if (lastClose > 0) mlPrice = lastClose;
  }
  if (!(mlPrice > 0)) {
    return res.status(400).json({ error: 'live price required — ML levels are price-anchored (no candles to derive one from)' });
  }
  const result = getMLPrediction(symbol, market || 'IN', mlPrice, Number(change) || 0, candles);
  res.json(result);
});

// FIX H6/H7: removed misleading GET stubs for /api/ml/signals and /api/ml/regime
// that returned empty/hardcoded data. POST routes below remain (frontend uses
// those). GET /api/ml/regime is kept (defaults to safe regime for callers
// that don't have live data).
// v20.9.1 [H2]: POST /api/ml/signals bhi RETIRED — getAllSignals(portfolio,
// livePrices) internally generateSignal(null, price, change) call karta tha
// jo candles na hone pe HAMESHA {HOLD, confidence:30, neutral} return karta
// hai — public API har symbol ke liye fake HOLD-30 dikhati thi (GET stubs
// wale hi "hardcoded data" class ka). Honest 410 + guidance (frontend
// is route ko use nahi karta — verified grep; /api/ml/predict real hai).
app.post('/api/ml/signals', (_req, res) => {
  res.status(410).json({
    error: 'ml/signals retired — ye endpoint candle-history ke bina sirf hardcoded HOLD deta tha. Real per-symbol signal ke liye POST /api/ml/predict {symbol, price, change, rsi} use karo.',
  });
});

app.get('/api/ml/regime', (_req, res) => {
  // Returns a default NEUTRAL regime — callers needing live data should POST.
  const regime = getRegime(
    { change: 0 }, { change: 0 },
    { price: 15 }, 18, 104, { change: 0 }
  );
  res.json(regime);
});

// (POST /api/ml/signals v20.9.1 me 410-retire hua — upar dekho; ye purana
// handler hata diya gaya kyunki getAllSignals candle-history ke bina sirf
// hardcoded HOLD-30 deta tha.)

app.post('/api/ml/regime', (req, res) => {
  if (mlGuard(req, res)) return;
  const { nifty, bankNifty, vix, usVix, dxy, gold } = req.body || {};
  const regime = getRegime(nifty, bankNifty, vix, usVix, dxy, gold);
  res.json(regime);
});

app.post('/api/ml/backtest', (req, res) => {
  if (mlGuard(req, res)) return;
  const { symbol, candles } = req.body || {};
  const result = getBacktest(symbol || '', Array.isArray(candles) ? candles.slice(0, 500) : []);
  res.json(result);
});

// ------------------------------------------------------------
// v10.5 POST /api/ml/meta-ensemble — PROXY to the Python
// meta-learner (ml-service /meta-ensemble, Upgrade 4).
// The Node in-process engine stays the default; this route exists
// so the frontend (and ops) can query the stacked meta-learner
// without exposing the Python service. Honest 503 when the Python
// service isn't deployed — the caller falls back to the in-process
// weighted ensemble (never a fake "meta" answer).
// ------------------------------------------------------------
// v21.11.0 PORT-COLLISION FIX: 8000 → 8100 (historical: 8000 pehle Laya
// local AI ka port tha — v21.14 me Laya remove ho chuka). ensemble.js synced.
const ML_SERVICE_BASE = () => String(process.env.ML_SERVICE_URL || 'http://127.0.0.1:8100').replace(/\/+$/, '');
app.post('/api/ml/meta-ensemble', async (req, res) => {
  if (mlGuard(req, res)) return;
  const { votes, regime } = req.body || {};
  if (!Array.isArray(votes)) {
    return res.status(400).json({ error: 'votes[] required: [{id, dir, conf, weight?}]' });
  }
  try {
    const r = await fetch(`${ML_SERVICE_BASE()}/meta-ensemble`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // FIX v18.1: ml-service enforces ML_API_TOKEN (when set) — without
        // forwarding it every proxy call was a 401 and the stacked meta-learner
        // silently never got used from the frontend.
        ...(process.env.ML_API_TOKEN ? { 'X-API-Key': process.env.ML_API_TOKEN } : {}),
      },
      body: JSON.stringify({ votes: votes.slice(0, 40), regime: String(regime || 'NEUTRAL') }),
      signal: AbortSignal.timeout(2500),
    });
    if (!r.ok) throw new Error(`ml-service ${r.status}`);
    const j = await r.json();
    return res.json(j);
  } catch (e) {
    return res.status(503).json({
      error: `ml-service unreachable (${e?.message || 'unknown'}) — the in-process weighted ensemble is authoritative`,
    });
  }
});

// GET /api/fundamentals/:symbol → fundamental data for Quality Scorecard
// ------------------------------------------------------------
// Proxies Yahoo Finance quoteSummary server-side (no CORS issue) and
// normalises the response into the shape expected by qualityScorecard.ts.
// Cached 24h because fundamentals change slowly.
// ------------------------------------------------------------
const _fundamentalsCache = new Map();  // symbol → { data, ts }
const _fundamentalsInFlight = new Map(); // v10.13: symbol -> shared compute promise (stampede fix)
const FUNDAMENTALS_TTL = 24 * 60 * 60 * 1000;

app.get('/api/fundamentals/:symbol', async (req, res) => {
  if (pubGuard(req, res, FUND_RATE_10MIN)) return; // v10.13: public-endpoint rate limit
  const rawSymbol = String(req.params.symbol || '').trim().toUpperCase();
  if (!rawSymbol) return jsonError(res, 400, 'symbol required');
  // SECURITY: validate symbol format.
  if (!isValidSymbol(rawSymbol)) return jsonError(res, 400, 'invalid symbol format');
  const market = String(req.query.market || '').toUpperCase();

  const cached = _fundamentalsCache.get(rawSymbol);
  if (cached && Date.now() - cached.ts < FUNDAMENTALS_TTL) {
    // v20.7.12 [M-4]: LRU hit-refresh — Map insertion-order FIFO tha (hit
    // order nahi badalta tha), isliye hot symbol evict ho ke cold zinda
    // rehte the. Re-set se MRU position refresh.
    _fundamentalsCache.delete(rawSymbol);
    _fundamentalsCache.set(rawSymbol, cached);
    return res.json(cached.data);
  }

  // v10.13 (deep-recheck L-5): cache-stampede fix. On TTL expiry, N
  // concurrent cold requests share ONE in-flight promise — the first
  // caller computes, everyone else awaits the same round-trips.
  {
    const pending = _fundamentalsInFlight.get(rawSymbol);
    if (pending) {
      try { return res.json(await pending); }
      catch (e) { return jsonError(res, 502, 'Failed to fetch fundamentals data.', e); }
    }
  }
  const _compute = (async () => {

  // Map to Yahoo ticker (same logic as /api/chart)
  const ysym = toYahooSymbol(rawSymbol, market);

  // FIX: Yahoo v10 quoteSummary is now rate-limited/blocked for many IPs.
    // Use v8 chart API (more reliable) for price + meta, then try v10 for
    // fundamentals. If v10 fails, use v8 data to compute what we can.
    const chartUrl = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ysym)}?interval=1d&range=1y`;
    const chartR = await fetch(chartUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0 (WealthAI fundamentals proxy)' },
      signal: AbortSignal.timeout(6000),
    });
    if (!chartR.ok) throw new Error(`Yahoo chart ${chartR.status}`);
    const chartJ = await chartR.json();
    const result = chartJ?.chart?.result?.[0];
    if (!result) throw new Error('No chart result');
    const meta = result.meta || {};

    // Try v10 quoteSummary for fundamentals (may fail)
    let qs = null;
    try {
      const modules = 'incomeStatementHistory,balanceSheetHistory,defaultKeyStatistics,financialData,summaryDetail,price';
      const qsUrl = `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(ysym)}?modules=${modules}`;
      const qsR = await fetch(qsUrl, {
        headers: { 'User-Agent': 'Mozilla/5.0 (WealthAI fundamentals proxy)' },
        signal: AbortSignal.timeout(5000),
      });
      if (qsR.ok) {
        const qsJ = await qsR.json();
        qs = qsJ?.quoteSummary?.result?.[0];
      }
    } catch { /* v10 failed — use chart data only */ }

    // ---- Build FundamentalData from whatever we have ----
    const toNum = (v) => {
      if (v == null) return 0;
      if (typeof v === 'number') return v;
      if (typeof v === 'object' && 'raw' in v) return v.raw || 0;
      return parseFloat(v) || 0;
    };

    const price = meta.regularMarketPrice || 0;
    const _prevClose = meta.chartPreviousClose || meta.previousClose || price;
    const marketCap = meta.marketCap || 0;

    // Extract historical closes from chart for 5yr approximation
    const timestamps = result.timestamp || [];
    const quoteClose = result.indicators?.quote?.[0]?.close || [];
    const _closes = timestamps.map((t, i) => ({ date: new Date(t * 1000).toISOString().split('T')[0], close: quoteClose[i] })).filter(c => c.close != null);

    // Compute approximate revenue/earnings from market cap + P/E (if available)
    const peRatio = qs?.summaryDetail?.trailingPE ? toNum(qs.summaryDetail.trailingPE) : 0;
    const pbRatio = qs?.defaultKeyStatistics?.priceToBook ? toNum(qs.defaultKeyStatistics.priceToBook) : 0;
    const eps = qs?.defaultKeyStatistics?.trailingEps ? toNum(qs.defaultKeyStatistics.trailingEps) : (peRatio > 0 ? price / peRatio : 0);
    const bookValuePerShare = qs?.defaultKeyStatistics?.bookValuePerShare ? toNum(qs.defaultKeyStatistics.bookValuePerShare) : (pbRatio > 0 ? price / pbRatio : 0);
    const divYield = qs?.summaryDetail?.dividendYield ? toNum(qs.summaryDetail.dividendYield) * 100 : 0;
    const beta = qs?.summaryDetail?.beta ? toNum(qs.summaryDetail.beta) : 1.0;

    // From v10 (if available)
    const income = qs?.incomeStatementHistory?.incomeStatementHistory || [];
    const balance = qs?.balanceSheetHistory?.balanceSheetStatements || [];
    const fin = qs?.financialData || {};
    const ks = qs?.defaultKeyStatistics || {};

    const latest = income[0] || {};
    const bs = balance[0] || {};

    const revenue5yr = income.length > 0 ? income.map(i => toNum(i.totalRevenue)).reverse() : [marketCap / (peRatio || 15)];
    const netIncome5yr = income.length > 0 ? income.map(i => toNum(i.netIncome)).reverse() : [eps * (marketCap / price || 1)];
    const eps5yr = income.length > 0 ? income.map(i => toNum(i.dilutedEPS)).reverse() : [eps];

    const totalAssets = toNum(bs.totalAssets);
    const totalLiabilities = toNum(bs.totalLiab);
    const totalEquity = toNum(bs.totalStockholderEquity);
    const totalDebt = toNum(bs.totalDebt || bs.shortLongTermDebt);
    const retainedEarnings = toNum(bs.retainedEarnings);
    const currentAssets = toNum(bs.totalCurrentAssets);
    const currentLiab = toNum(bs.totalCurrentLiabilities);
    const workingCapital = currentAssets - currentLiab;
    const ebit = toNum(latest.operatingIncome) || toNum(latest.ebit) || (netIncome5yr[netIncome5yr.length - 1] || 0) * 1.3;
    const operatingCashFlow = toNum(fin.operatingCashflow || fin.totalCashFromOperatingActivities) || (netIncome5yr[netIncome5yr.length - 1] || 0) * 1.2;
    const capex = Math.abs(toNum(fin.capex || fin.capitalExpenditures)) || operatingCashFlow * 0.3;
    const promoterHoldingPct = ks.heldPercentInsiders != null ? ks.heldPercentInsiders * 100 : undefined;
    const grossMargin = latest.grossProfit && latest.totalRevenue ? (toNum(latest.grossProfit) / toNum(latest.totalRevenue)) * 100 : (peRatio > 0 ? 30 : 0);
    const netMargin = netIncome5yr[netIncome5yr.length - 1] && revenue5yr[revenue5yr.length - 1] ? (netIncome5yr[netIncome5yr.length - 1] / revenue5yr[revenue5yr.length - 1]) * 100 : (peRatio > 0 ? 10 : 0);
    const roe = totalEquity > 0 ? (netIncome5yr[netIncome5yr.length - 1] / totalEquity) * 100 : (eps > 0 && bookValuePerShare > 0 ? (eps / bookValuePerShare) * 100 : 0);
    const isBank = !bs.inventory || (totalDebt > totalEquity * 5 && totalAssets > 0);

    const data = {
      symbol: rawSymbol,
      market: market === 'IN' ? 'IN' : 'US',
      revenue5yr,
      netIncome5yr,
      eps5yr,
      totalAssets,
      totalLiabilities,
      totalEquity,
      totalDebt,
      retainedEarnings,
      workingCapital,
      ebit,
      marketCap,
      salesOrRevenue: revenue5yr[revenue5yr.length - 1] || 0,
      operatingCashFlow,
      capex,
      bookValuePerShare,
      promoterHoldingPct,
      grossMargin,
      netMargin,
      roe,
      isBank,
      currentRatio: currentLiab > 0 ? currentAssets / currentLiab : 1,
      // Extra fields from chart data
      price,
      peRatio,
      pbRatio,
      divYield,
      beta,
      source: qs ? 'yahoo-v10+v8' : 'yahoo-v8-only',
    };

    // 2026 perf audit (M2): cap the cache at 200 entries (the endpoint is
    // public — distinct-symbol enumeration could grow this Map without
    // limit; the 24h TTL only refetches, never evicts). LRU: Map preserves
    // insertion order, so evict the oldest key.
    if (_fundamentalsCache.size >= 200) {
      const oldest = _fundamentalsCache.keys().next().value;
      if (oldest !== undefined) _fundamentalsCache.delete(oldest);
    }
    _fundamentalsCache.set(rawSymbol, { data, ts: Date.now() });
    return data;
  })();
  _fundamentalsInFlight.set(rawSymbol, _compute.finally(() => _fundamentalsInFlight.delete(rawSymbol)));
  try {
    const data = await _compute;
    res.set('Cache-Control', 'public, max-age=86400');
    return res.json(data);
  } catch (e) {
    return jsonError(res, 502, 'Failed to fetch fundamentals data.', e);
  }
});

// ------------------------------------------------------------
// GET /api/inflation → India CPI + US CPI for real-returns calc
// ------------------------------------------------------------
// Fetches India CPI YoY from World Bank API (free, no key) and US CPI
// from BLS-style endpoint. Cached 24h because CPI is monthly.
// ------------------------------------------------------------
let _inflationCache = { data: null, ts: 0 };
const INFLATION_TTL = 24 * 60 * 60 * 1000;

app.get('/api/inflation', async (_req, res) => {
  if (_inflationCache.data && Date.now() - _inflationCache.ts < INFLATION_TTL) {
    return res.json(_inflationCache.data);
  }
  // World Bank API: indicator FP.CPI.TOTL.ZG (inflation, consumer prices %)
  // Latest value per country. Returns array of observations.
  async function fetchWB(country) {
    try {
      const url = `https://api.worldbank.org/v2/country/${country}/indicator/FP.CPI.TOTL.ZG?format=json&per_page=5&date=2023:2024`;
      const r = await fetch(url, { signal: AbortSignal.timeout(5000) });
      if (!r.ok) return null;
      const j = await r.json();
      const obs = j?.[1];
      if (Array.isArray(obs) && obs.length > 0) {
        // First entry is most recent.
        const v = obs[0]?.value;
        if (typeof v === 'number' && v > -50 && v < 200) return v;
      }
    } catch { /* fall through */ }
    return null;
  }
  const [india, us] = await Promise.all([fetchWB('IN'), fetchWB('US')]);
  const data = {
    india: india ?? 6,    // fallback to typical long-run avg
    us: us ?? 3,
    source: 'World Bank CPI (FP.CPI.TOTL.ZG)',
    fetchedAt: new Date().toISOString(),
  };
  _inflationCache = { data, ts: Date.now() };
  res.set('Cache-Control', 'public, max-age=86400');
  return res.json(data);
});

// Static frontend (built by `vite build` → dist/)
// ------------------------------------------------------------
const distDir = path.resolve(__dirname, '..', 'dist');
// v21.0.1 FIX (Vision AI button "show nahi ho raha"): watchdog ke BINA
// direct `npm start` karne pe stale dist serve hota tha aur koi warning
// nahi milti thi (UI banner sirf version-mismatch pe dikhta hai). Boot
// par ek loud console warning — stamp vs package.json — taaki "naya
// feature dikh nahi raha" wali class of bugs turant diagnose ho jaye.
try {
  const stampPath = path.join(distDir, '.build-version');
  const stamp = fs.existsSync(stampPath) ? String(fs.readFileSync(stampPath, 'utf8')).trim() : null;
  if (!stamp) {
    console.warn('[wealth-ai] ⚠ dist/ MISSING — frontend build nahi hua. Watchdog (Start-SmartAI-Watchdog.bat) chalao ya khud `npm run build` karo. Tab tak self-heal page serve hoga.');
  } else if (stamp !== SERVER_VERSION) {
    console.warn(`[wealth-ai] ⚠ dist STALE — serving v${stamp} jabki server v${SERVER_VERSION} hai. Naye features (Vision AI etc.) dikhenge hi nahi! Watchdog dobara chalao (auto npm install + rebuild) ya khud \`npm run build\` karo.`);
  }
} catch { /* best-effort — serve continue */ }
// v11.7 PERF #2 — REAL BROWSER CACHING FOR HASHED ASSETS.
// express.static's default was `Cache-Control: public, max-age=0` — a
// content-hashed build (index-C2rax6Rt.js etc.) re-downloaded ALL ~1.9MB
// of chunks on EVERY visit. Vite content-hashes every /assets/* filename,
// so those responses are immutable by construction: cache them for a year.
// index.html / sw.js / manifest.json must NEVER be long-cached (a deploy
// must be picked up immediately — stale HTML is what breaks deploys).
app.use(express.static(distDir, {
  setHeaders: (res, filePath) => {
    if (filePath.split(path.sep).includes('assets')) {
      res.set('Cache-Control', 'public, max-age=31536000, immutable');
    } else {
      const base = path.basename(filePath);
      if (base === 'sw.js' || base === 'widget.html' || base === 'manifest.json') {
        // service worker + widget page + manifest must always revalidate
        // (spec-safe SW updates depend on revalidating the SW file itself)
        res.set('Cache-Control', 'no-cache');
      } else if (/\.html?$/i.test(base)) {
        // the app shell: revalidate via ETag so deploys land immediately while 304 avoids re-downloading unchanged HTML
        res.set('Cache-Control', 'no-cache');
      }
    }
  },
}));

// SPA fallback for any non-/api, non-/health route.
// FIX C8: When a code-split chunk (e.g. /assets/vendor-charts-abc.js) is
// missing after a redeploy, the previous catch-all served index.html for the
// JS file, the browser tried to parse HTML as JS, and the entire app died
// with "Failed to fetch dynamically imported module". Return a real 404 for
// asset paths so the browser surfaces the error and the lazy-retry logic in
// App.tsx (lazyWithRetry) can force a clean reload.
// FIX: Exclude /health from this catch-all so the health endpoint below
// actually returns JSON (Render health check needs JSON, not HTML).
app.get(/^(?!\/api\/|\/health).*/, (req, res) => {
  const isAsset = req.path.startsWith('/assets/')
    || /\.(js|mjs|css|map|ico|svg|png|jpe?g|webp|woff2?|ttf|otf|json|wasm)$/i.test(req.path);
  if (isAsset) return res.status(404).send('Not found');
  // v20.8.3: dist/ missing = build kabhi nahi hua / delete ho gaya. Pehle
  // yahan raw ENOENT 500 stack jata tha. Ab SELF-HEAL page — asli fix
  // supervisor ka ensureFrontend auto-build hai; ye page 15s refresh pe
  // khud theek ho jata hai jaise hi build complete hota hai.
  const distIndex = path.join(distDir, 'index.html');
  if (!fs.existsSync(distIndex)) {
    return res.status(503).type('html').send(
      '<!doctype html><html lang="en"><head><meta charset="utf-8">'
      + '<meta name="viewport" content="width=device-width, initial-scale=1">'
      + '<meta http-equiv="refresh" content="15">'
      + '<title>SmartAI Pro — build ho raha hai</title></head>'
      + '<body style="background:#020617;color:#e2e8f0;font-family:system-ui,sans-serif;'
      + 'display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0">'
      + '<div style="max-width:560px;padding:32px;text-align:center">'
      + '<div style="font-size:48px">⚡</div>'
      + '<h1 style="color:#22d3ee;font-size:20px;margin:16px 0 8px">SmartAI Pro v' + SERVER_VERSION + '</h1>'
      + '<p style="font-size:14px;line-height:1.6;color:#94a3b8">Frontend build missing/stale hai — '
      + 'server code v' + SERVER_VERSION + ' chal raha hai.</p>'
      + '<p style="font-size:13px;line-height:1.7;color:#64748b">Agar <b>Start-SmartAI-Watchdog.bat</b> '
      + 'chal raha hai to server restart hone par build <b>khud</b> hogi (auto-build) — thoda wait karo. '
      + 'agar 5 min me nahi theek hui to Watchdog window band karke <b>Start-SmartAI-Watchdog.bat</b> '
      + 'dobara chalao — npm install + build KHUD hoga (internet chahiye, 2-5 min).</p>'
      + '<p style="font-size:12px;color:#475569">Ye page har 15s auto-refresh hota hai.</p>'
      + '</div></body></html>'
    );
  }
  // v12.10 BANDWIDTH: revalidate via ETag — ensures fresh deploy lands immediately without transferring unchanged HTML
  res.set('Cache-Control', 'no-cache');
  res.sendFile(distIndex);
});

// ============================================================
// CLOUD SYNC PROXY — routes Google Sheets sync through the backend
// ============================================================
// WHY: The frontend previously called Google Apps Script DIRECTLY,
// which required VITE_API_URL and VITE_API_TOKEN as BUILD-TIME env vars
// on Vercel. If those weren't set, cloud sync silently failed and the
// portfolio was empty on Vercel (but worked on Render where the env
// vars were available at build time).
//
// Now the frontend calls /api/cloud/load and /api/cloud/save (which are
// authenticated via the session token). The server uses its own API_URL
// and API_TOKEN env vars to call Google Apps Script. This eliminates the
// build-time env var requirement and keeps the token server-side only.
// ============================================================
const CLOUD_API_URL = process.env.API_URL || process.env.VITE_API_URL || '';
// SECURITY: no hardcoded fallback — a baked-in token defeats the env-var design.
const CLOUD_AUTH_TOKEN = process.env.API_TOKEN || '';

// GET /api/cloud/load → proxy to Google Apps Script ?action=load
app.get('/api/cloud/load', async (req, res) => {
  if (!CLOUD_API_URL) return jsonError(res, 503, 'Cloud sync not configured (API_URL not set).');
  if (!CLOUD_AUTH_TOKEN) return jsonError(res, 503, 'Cloud sync not configured (API_TOKEN not set).');
  try {
    const fetchUrl = CLOUD_API_URL.includes('?')
      ? `${CLOUD_API_URL}&action=load&authToken=${encodeURIComponent(CLOUD_AUTH_TOKEN)}&t=${Date.now()}`
      : `${CLOUD_API_URL}?action=load&authToken=${encodeURIComponent(CLOUD_AUTH_TOKEN)}&t=${Date.now()}`;

    console.log(`☁️ Cloud load: fetching ${CLOUD_API_URL.substring(0, 60)}...`);
    const upstream = await fetch(fetchUrl, { redirect: 'follow', signal: AbortSignal.timeout(15000) });
    if (!upstream.ok) return jsonError(res, 502, `Cloud sync upstream HTTP ${upstream.status}.`);
    const text = await upstream.text();
    let data;
    try { data = JSON.parse(text); } catch {
      // Apps Script sometimes wraps JSON in extra text — try to extract object or array
      const match = text.match(/\{[\s\S]*\}/) || text.match(/\[[\s\S]*\]/);
      if (!match) return jsonError(res, 502, 'Cloud sync returned invalid data.');
      try { data = JSON.parse(match[0]); } catch { return jsonError(res, 502, 'Cloud sync returned invalid JSON.'); }
    }
    if (typeof data === 'string') {
      try { data = JSON.parse(data); } catch { return jsonError(res, 502, 'Cloud sync returned invalid data.'); }
    }
    // Detect Apps Script auth/error responses like {ok:false, error:"..."}
    if (data && data.ok === false && data.error) {
      console.warn(`☁️ Cloud load: Apps Script error: ${data.error}`);
      return jsonError(res, 502, `Cloud sync error: ${data.error}`);
    }
    console.log(`☁️ Cloud load: success, portfolio items: ${data?.portfolio?.length ?? (Array.isArray(data) ? data.length : 'unknown')}`);
    return res.json(data);
  } catch (e) {
    console.error('☁️ Cloud load fetch error:', e?.message || e);
    return jsonError(res, 502, 'Cloud sync failed.', e);
  }
});

// POST /api/cloud/save → proxy to Google Apps Script (action=update)
app.post('/api/cloud/save', async (req, res) => {
  if (!CLOUD_API_URL) return jsonError(res, 503, 'Cloud sync not configured (API_URL not set).');
  if (!CLOUD_AUTH_TOKEN) return jsonError(res, 503, 'Cloud sync not configured (API_TOKEN not set).');
  const { portfolio, usdInr, state } = req.body || {};
  if (!Array.isArray(portfolio) || portfolio.length === 0) {
    return jsonError(res, 400, 'portfolio[] required (non-empty).');
  }
  try {
    const upstream = await fetch(CLOUD_API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      redirect: 'follow',
      body: JSON.stringify({ action: 'update', authToken: CLOUD_AUTH_TOKEN, portfolio, timestamp: Date.now(), usdInr, state: state ?? null }),
      signal: AbortSignal.timeout(10000),
    });
    // Verify the Apps Script actually accepted the save — it can return
    // HTTP 200 with { ok:false, error } (silent data loss if we trust status
    // alone). Read the body ONCE as text then parse: upstream.json() consumes
    // the stream, so the old json()→text() fallback could never run (an HTML
    // error page with HTTP 200 was reported as savedOk:true).
    let body = null;
    try {
      const text = await upstream.text();
      try { body = JSON.parse(text); } catch {
        const match = text.match(/\{[\s\S]*\}/);
        if (match) { try { body = JSON.parse(match[0]); } catch { /* not JSON */ } }
      }
    } catch { /* unreadable body */ }
    const savedOk = upstream.ok && !(body && body.ok === false);
    if (!savedOk) {
      console.warn(`☁️ Cloud save: upstream rejected — HTTP ${upstream.status}, body: ${JSON.stringify(body).slice(0, 200)}`);
    }
    return res.json({ ok: savedOk, saved: portfolio.length, error: savedOk ? undefined : (body?.error || `HTTP ${upstream.status}`) });
  } catch (e) {
    return jsonError(res, 502, 'Cloud sync save failed.', e);
  }
});

// POST /api/cloud/save-key → proxy to Google Apps Script (action=saveKey)
app.post('/api/cloud/save-key', async (req, res) => {
  if (!CLOUD_API_URL) return jsonError(res, 503, 'Cloud sync not configured.');
  if (!CLOUD_AUTH_TOKEN) return jsonError(res, 503, 'Cloud sync not configured.');
  const { groqKey } = req.body || {};
  if (!groqKey) return jsonError(res, 400, 'groqKey required.');
  try {
    const upstream = await fetch(CLOUD_API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      redirect: 'follow',
      body: JSON.stringify({ action: 'saveKey', authToken: CLOUD_AUTH_TOKEN, groqKey, timestamp: Date.now() }),
      signal: AbortSignal.timeout(10000),
    });
    // v20.7.3 FIX: mirror the /api/cloud/save verification — the Apps Script
    // can return HTTP 200 with { ok:false } (silent data loss if we trust
    // the status code alone). Read the body once, parse, honour ok:false.
    let body = null;
    try {
      const text = await upstream.text();
      try { body = JSON.parse(text); } catch {
        const match = text.match(/\{[\s\S]*\}/);
        if (match) { try { body = JSON.parse(match[0]); } catch { /* not JSON */ } }
      }
    } catch { /* unreadable body */ }
    const savedOk = upstream.ok && !(body && body.ok === false);
    if (!savedOk) {
      console.warn(`☁️ Cloud save-key: upstream rejected — HTTP ${upstream.status}, body: ${JSON.stringify(body).slice(0, 200)}`);
    }
    return res.json({ ok: savedOk, error: savedOk ? undefined : (body?.error || `HTTP ${upstream.status}`) });
  } catch (e) {
    return jsonError(res, 502, 'Cloud sync key save failed.', e);
  }
});

// GET /api/cloud/load-key → proxy to Google Apps Script (action=loadKey)
app.get('/api/cloud/load-key', async (req, res) => {
  if (!CLOUD_API_URL) return jsonError(res, 503, 'Cloud sync not configured.');
  if (!CLOUD_AUTH_TOKEN) return jsonError(res, 503, 'Cloud sync not configured.');
  try {
    const url = `${CLOUD_API_URL}?action=loadKey&authToken=${encodeURIComponent(CLOUD_AUTH_TOKEN)}&t=${Date.now()}`;
    const upstream = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!upstream.ok) return jsonError(res, 502, 'Cloud sync key load error.');
    const text = await upstream.text();
    let data;
    try { data = JSON.parse(text); } catch {
      const match = text.match(/\{[\s\S]*\}/);
      if (!match) return res.json({ groqKey: '' });
      try { data = JSON.parse(match[0]); } catch { return res.json({ groqKey: '' }); }
    }
    return res.json(data);
  } catch (e) {
    return jsonError(res, 502, 'Cloud sync key load failed.', e);
  }
});

// ============================================================
// APP STATE SYNC — planner settings, transaction ledger, price
// alerts, SIP frequency. Survives browser cache/cookie clears.
// Stored in Google Sheets via Apps Script (action=saveState).
// ============================================================
// POST /api/state/save { state: {...} } → chunked key-value store
app.post('/api/state/save', async (req, res) => {
  if (!CLOUD_API_URL) return jsonError(res, 503, 'Cloud sync not configured (API_URL not set).');
  if (!CLOUD_AUTH_TOKEN) return jsonError(res, 503, 'Cloud sync not configured (API_TOKEN not set).');
  const state = req.body?.state;
  if (!state || typeof state !== 'object') return jsonError(res, 400, 'state object required.');
  try {
    const upstream = await fetch(CLOUD_API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      redirect: 'follow',
      body: JSON.stringify({ action: 'saveState', authToken: CLOUD_AUTH_TOKEN, state, timestamp: Date.now() }),
      signal: AbortSignal.timeout(10000),
    });
    let body = null;
    try { body = await upstream.json(); } catch { /* non-JSON */ }
    const ok = upstream.ok && !(body && body.ok === false);
    return res.json({ ok, error: ok ? undefined : (body?.error || `HTTP ${upstream.status}`) });
  } catch (e) {
    return jsonError(res, 502, 'App state save failed.', e);
  }
});

// ============================================================
// HEALTH ENDPOINT — used by Render health check + uptime monitors
// ============================================================
function _agentsLiveness() {
  // v18.1: never let a liveness probe break /health — each getter is
  // wrapped; a throw (bad config file, etc.) degrades to null, not a 500.
  const wrap = (fn) => { try { return fn(); } catch { return null; } };
  return {
    crypto: wrap(agentLiveness),
    india: wrap(indiaAgentLiveness),
  };
}

// v19.2 ANTI-FREEZE SUPERVISOR: ultra-light liveness endpoint. ZERO work
// (no snapshots, no fs, no middleware deps) so its response time is a pure
// event-loop heartbeat — the EXTERNAL supervisor (Start-SmartAI-Watchdog.bat
// -> node server/supervisor.js) probes this every 20s from its OWN loop; 3
// consecutive timeouts = FREEZE verdict = force-kill + restart. /health
// stays the DEEP status endpoint (feeds/agents/ml/selfheal).
app.get('/api/ping', (_req, res) => {
  // v20.8.3: `v` = SERVER_VERSION — zero-work string, koi fs/io nahi. Frontend
  // isko APP_VERSION se compare karke STALE-BUILD banner dikhata hai.
  res.json({ pong: true, t: Date.now(), pid: process.pid, up: Math.round(process.uptime()), v: SERVER_VERSION });
});

app.get('/health', (_req, res) => {
  // v18.1: enriched health — feeds + agent liveness + cached ml-service
  // probe. One endpoint now answers "is everything actually alive?" for
  // the Windows launcher watchdog AND for ops dashboards.
  // v19.1: + selfheal block — rss/heap/loop-lag/crash counters/exit
  // journal verdict/log-governor stats. The next "site slow/down"
  // report is answerable from this ONE payload.
  let selfheal = null;
  try { selfheal = selfHealthSnapshot(); } catch { selfheal = null; }
  // v21.12.0: committee snapshot — voting/shadow seat counts, tape seat,
  // learning window, META armed. "Kitne models chal rahe hain" ka ek hi
  // source of truth (boot banner + AgentPanel isi data se render hote hain).
  let committee = null;
  try { committee = committeeInfo(); } catch { committee = null; }
  res.json({
    ok: true,
    // v20.8.3: server-side code version (package.json) — UI + ops dono
    // isse built-frontend version se compare karte hain.
    version: SERVER_VERSION,
    committee,
    uptime: process.uptime(),
    // FIX (audit L-3): `killed` is only true after an explicit .kill(); after a
    // crash-exit it stays false, so health wrongly reported a dead bot as alive.
    botAlive: !!(_botProcess && _botProcess.exitCode === null && !_botProcess.killed),
    providers: Object.entries(KEYS).filter(([, v]) => v).map(([k]) => k),
    feeds: {
      crypto: { up: cryptoClientUp(), rt: cxRtWsStatus() },
      us: { up: usClientUp() },
      in: { up: inClientUp() },
    },
    agents: _agentsLiveness(),
    ml: { engine: mlHealth(), service: mlServiceHealth() },
    selfheal,
    consoleguard: (() => { try { return consoleGuardStatus(); } catch { return null; } })(),
    supervised: process.env.SMARTAI_SUPERVISED === '1',
    timestamp: Date.now(),
  });
});

// v21.1.0 (Phase-3): /api/health — OPERATIONAL HEALTH aggregator (authed,
// requireAuth isle pehle chal chuka hai). /health liveness + /api/ping
// zero-work probe ke ALAWA ye operational surface deta hai: per-feed
// last-tick AGES, teeno kill-switch layers, Bot Lab snapshot, exec
// heartbeat (dead-man) age, dono data-dirs ki writability. 60s Telegram
// alert loop (initHealthMonitor) isi module pe chalta hai.
app.get('/api/health', async (_req, res) => {
  try {
    const { healthSnapshot } = await import('./healthMonitor.js');
    const snap = await healthSnapshot();
    res.json(snap);
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e || 'health snapshot failed') });
  }
});

// ============================================================
// START SERVER + BOT
// ============================================================
let _botProcess = null;
let _botRestartTimer = null;
// FIX (audit L-4): exponential backoff for bot auto-restart. A bot that crashes
// on boot previously restarted every 5s forever (infinite fork/exit loop, log
// spam + CPU churn). Backoff doubles per crash up to 5 minutes and resets after
// 10 minutes of stable uptime.
let _botRestartDelay = 5000;
let _botStartedAt = 0;

// ------------------------------------------------------------
// ------------------------------------------------------------
// v19.1 NEVER-DOWN SELF HEAL - process-level error handling.
// REPLACES the v18.1 flush-and-exit pair:
//   * uncaughtException -> STAY ALIVE (flush + loud log + counter).
//     The v18.1 exit(1)-and-restart policy assumed a supervisor
//     (Render / launcher watchdog). On a Windows portable WITHOUT a
//     reliable watchdog, one stray sync throw anywhere = the site
//     stays down -- the exact "5-10 min baad site down" report.
//     SELFHEAL_EXIT_ON_FATAL=true restores the exit behaviour.
//   * unhandledRejection -> logged + counted (same as v18.1, now
//     observable via /health.selfheal).
//   * exit-reason journal -> server/data/exit-reasons.log; the next
//     boot reports how the previous run ended (clean / crash / hard
//     kill) -- the "site down" root cause becomes VISIBLE.
//   * memory + event-loop-lag watchdog with cache-trim registry.
// ------------------------------------------------------------
initSelfHeal({
  env: process.env,
  getFlushers: () => [
    ['paper', flushPaperState], ['track-record', flushTrackRecordState], ['journal', flushJournalState],
    ['manual-trades', flushManualState],
  ],
  getLogStats: () => logGovernorStats(),
  log: console.error,
});
// trims the guard can fire under memory pressure (each is bounded + safe)
registerTrim('liveFeed', pruneLiveFeedNow);
registerTrim('candle-cache', __clearCandleCache);
reportLastExitOnBoot();
// v21.1.0 (Phase-3): OPERATIONAL HEALTH MONITOR — 60s loop jo stale feeds
// (>90s), WS drops, teeno kill layers, exec-heartbeat gap (>30s) aur
// read-only data-dirs ko THROTTLED Telegram alerts se surface karta hai
// (15-min per-key dedup). Snapshot /api/health endpoint pe milta hai.
try {
  const { initHealthMonitor } = await import('./healthMonitor.js');
  initHealthMonitor();
  console.log('[health] v21.1.0 health monitor armed - /api/health snapshot + 60s Telegram alert loop (stale feeds / kills / heartbeat / disk)');
} catch (e) {
  try { console.error('[health] monitor init failed (non-fatal):', e?.message || e); } catch { /* noop */ }
}
try { console.log('[selfheal] v19.1 NEVER-DOWN STABILITY GUARD armed - crash-stay-alive ON (SELFHEAL_EXIT_ON_FATAL=false) | log-governor ON | memory+lag watchdog ON | exit journal: server/data/exit-reasons.log'); } catch { /* noop */ }
try { console.log('[selfheal] v19.2 ANTI-FREEZE layer armed - QuickEdit console guard (win32 best-effort) + /api/ping heartbeat | HANG-recovery ke liye Start-SmartAI-Watchdog.bat chalao (external supervisor)'); } catch { /* noop */ }

// ============================================================
// v20.6 RAM GOVERNOR — local-first 16GB laptop setup defense.
// See server/ai/ramGovernor.js for the full design. The governor
// samples os.freemem() + process RSS every 10s (unref'd) and
// exposes ramCanEnter() / ramCanLLM() boolean gates that the
// execution path (proTraderAuto + future positionManager) reads
// BEFORE opening / extending positions or firing LLM calls. Under
// YELLOW, LLM calls block (deterministic mode); under RED, new
// entries block (positions still managed). Telegram CRITICAL
// alert fires once per RED entry. Tunables: RAM_YELLOW_FREE_GB
// (default 3.5), RAM_RED_FREE_GB (default 2), RAM_TICK_SEC (10),
// RAM_RSS_RESERVE_MB (600).
// ============================================================
try {
  const { initRamGovernor } = await import('./ai/ramGovernor.js');
  // v20.6.2 FIX (re-applied after upstream merge revert): the alertSink
  // was calling `_t.sendTelegramRaw(msg)` on the telegramPush module —
  // but that export DOESN'T EXIST. Wire up the REAL sender:
  // sendTelegramMessage(text, env) from ai/secrets.js.
  let _tgPush = null;
  try {
    const { sendTelegramMessage } = await import('./ai/secrets.js');
    // v20.9.4 [H2]: TG-shaped env — raw process.env me env.token/env.chatId
    // nahi hote (TG_TOKEN/TG_CHAT_ID hote hain) → config null → alert dead.
    _tgPush = (msg) => { sendTelegramMessage(msg, { token: process.env.TG_TOKEN || '', chatId: process.env.TG_CHAT_ID || '' }).catch(() => {}); };
  } catch { /* telegram not configured — alertSink stays null, governor still works (gates + console only) */ }
  initRamGovernor({ env: process.env, alertSink: _tgPush });
  console.log('[ram-governor] v20.6 armed — GREEN/YELLOW/RED traffic light for entries + LLM calls (16GB local setup). Telegram CRITICAL alert on RED (via ai/secrets.js::sendTelegramMessage).');
} catch (e) {
  console.log(`[ram-governor] arm failed (non-fatal — app continues): ${String(e?.message || e).slice(0, 120)}`);
}

// ============================================================
// v20.7 EXECUTION STACK — Phase 2 (Port) + Phase 4 (PositionManager)
// + Phase 5 (Reconciler + Dead-man + Kill-switch).
// ------------------------------------------------------------
// The execution port (api / browser / paper) + position manager
// (protection-first + exit ladder + tiered reversal) + reconciler
// (orphan adopt + dead-man + L1/L2/L3 kill-switch + leader lease).
// All gated behind EXEC_MODE env (default 'paper' — safe).
// ============================================================
let _execPort = null;
let _positionManager = null;
try {
  const { resolveExecutionPort } = await import('./exec/port.js');
  const { PositionManager } = await import('./exec/positionManager.js');
  const { initReconciler, setKill: _setKill, killLevel: _killLevel } = await import('./exec/reconciler.js');
  const { ramCanEnter, ramCanLLM } = await import('./ai/ramGovernor.js');
  // shared Telegram alert sink (re-uses the secrets.js sender)
  let _execAlert = null;
  try {
    const { sendTelegramMessage } = await import('./ai/secrets.js');
    // v20.9.4 [H2]: TG-shaped env (same fix as _tgPush above).
    _execAlert = (msg) => { sendTelegramMessage(msg, { token: process.env.TG_TOKEN || '', chatId: process.env.TG_CHAT_ID || '' }).catch(() => {}); };
  } catch { /* telemetry best-effort */ }
  _execPort = await resolveExecutionPort({ env: process.env });
  _positionManager = new PositionManager({
    port: _execPort,
    ramGovernor: { ramCanEnter, ramCanLLM },
    alertSink: _execAlert,
  });
  initReconciler({
    port: _execPort,
    positionManager: _positionManager,
    alertSink: _execAlert,
    env: process.env,
  });
  // v20.7: expose the live port + PM on globalThis so routes can read state
  // without re-resolving (avoids a second PaperPort instance masking the
  // real one). Routes read globalThis.__execPort / globalThis.__positionManager.
  globalThis.__execPort = _execPort;
  globalThis.__positionManager = _positionManager;
  // v20.9.3 FIX (M): boot hydration — exec-enter positions (journal rows,
  // execManaged:true) wapas PM ladder-state me. Pehle ek restart pura
  // ladder management uda deta tha (in-memory _state + koi positions row
  // nahi thi). Read-only loadJSON — same store the routes use.
  try {
    const { loadJSON } = await import('./lib/store.js');
    const j = loadJSON('ai-trading-journal.json', { entries: [], positions: [] });
    const n = _positionManager.hydrateFromJournal?.((j?.positions) || []) || 0;
    if (n > 0) console.log(`[exec-stack] hydrate: ${n} exec-enter position(s) journal se ladder me wapas`);
  } catch (e) { console.log(`[exec-stack] hydrate skip: ${String(e?.message || e).slice(0, 80)}`); }
  const _mode = _execPort.mode || 'paper';
  // ------------------------------------------------------------
  // v20.7.12 [H2-2]: the PM EXIT-LADDER TICK DRIVER — ab /api/exec/enter
  // real hai, isliye ladder bhi chalna chahiye. 15m cadence (revCandleTf
  // convention — candle-close logic, tick nahi); PM state khali (koi
  // protection-first entry nahi) to pure no-op (getPositions bhi nahi —
  // state check pehle). Actions journal-console + PM ka apna alertSink.
  // ------------------------------------------------------------
  const _pmTick = setInterval(async () => {
    try {
      if (!_positionManager) return;
      if (_positionManager._stateForTests().length === 0) return; // nothing to ladder
      // v20.8.4 FIX (H2 — price-blind ladder): the driver used to pass
      // EMPTY price/ATR maps, and in EXEC_MODE=paper (the default) the
      // PaperPort mark never refreshes after the fill — so T1/T2/trail/SL
      // legs all evaluated against the ENTRY price and could never fire;
      // only the candlesSeen time-stop worked. Live marks now come from
      // the futures price chain (20s cache, Binance/Bybit fallback legs);
      // ATR falls back to entry*0.012 inside the ladder (documented).
      const pricesByPair = {};
      try {
        const { fetchFuturesPrices } = await import('./ai/futures.js');
        const rows = await fetchFuturesPrices().catch(() => []);
        for (const r of (Array.isArray(rows) ? rows : [])) {
          const p = Number(r?.mark ?? r?.last);
          if (Number.isFinite(p) && p > 0 && r?.pair) pricesByPair[r.pair] = p;
        }
      } catch { /* ladder falls back to port marks */ }
      const actions = await _positionManager.tick({ pricesByPair, atrByPair: {} });
      if (Array.isArray(actions)) {
        for (const a of actions) console.log(`[posmgr] ${a.kind} ${a.id}${a.newSl != null ? ` → SL ${a.newSl}` : ''}`);
      }
    } catch { /* never throws out of the timer */ }
  }, 15 * 60_000);
  if (_pmTick.unref) _pmTick.unref();
  console.log(`[exec-stack] v20.7 armed — EXEC_MODE=${_mode} · PositionManager protection-first + exit ladder (15m tick driver ON) · Reconciler 12s (engine-owned flatten + manual adopt-only) + dead-man + kill-switch L1/L2/L3 + leader lease. Telegram CRITICAL alerts via ai/secrets.js.`);
} catch (e) {
  console.log(`[exec-stack] arm failed (non-fatal — app continues): ${String(e?.message || e).slice(0, 120)}`);
}

// ------------------------------------------------------------
// v9.1 GRACEFUL SHUTDOWN — the intraday desk's debounced writers
// (paper trades 1s / track record 1s / journal 1.5s) could lose the
// very last state change on a deploy/restart that lands inside the
// debounce window (e.g. a paper-trade close immediately followed by
// SIGTERM). Flush them synchronously before exiting.
// ------------------------------------------------------------
let _shuttingDown = false;
let _httpServer = null; // v10.13: captured at listen() for graceful drain
function _gracefulShutdown(signal) {
  if (_shuttingDown) return;
  _shuttingDown = true;
  // v20.7.8 [H1]: kill the forked Telegram bot child BEFORE exiting.
  // process.exit() does NOT kill forked children — on Linux/VPS/Docker
  // (docker stop, systemctl, Render SIGTERM) with TG polling mode, every
  // shutdown left a live orphan holding the Telegram long-poll; after the
  // restart TWO pollers fought over getUpdates (409 storms, duplicate
  // command processing). The bot has its own SIGTERM handler.
  try {
    clearTimeout(_botRestartTimer);
    if (_botProcess && _botProcess.exitCode === null && !_botProcess.killed) {
      _botProcess.kill('SIGTERM');
      console.log('[wealth-ai] shutdown: SIGTERM sent to Telegram bot child');
    }
  } catch { /* best-effort — never block shutdown on the child */ }
  // v19.1: record the INTENTIONAL stop in the exit journal so the next
  // boot says "CLEAN SHUTDOWN" instead of guessing "hard kill".
  selfHealNoteShutdown(signal === 'SIGINT' ? 'ctrl-c' : 'sigterm');
  for (const [name, flush] of [
    ['paper', flushPaperState], ['track-record', flushTrackRecordState], ['journal', flushJournalState],
    ['manual-trades', flushManualState],
  ]) {
    try { flush(); } catch (e) { console.warn(`[wealth-ai] shutdown flush ${name}:`, e?.message); }
  }
  // v12.7: the flushers above wrote the EPHEMERAL disk + queued their
  // durable pushes — fire them NOW (bypassing the debounce/gap once) so
  // the remote GitHub backup leaves the shutdown at most seconds stale,
  // not a full debounce+60s-gap window behind.
  try { flushBackupNow(); } catch { /* best-effort */ }
  // v10.13 (deep-recheck L-8): drain in-flight HTTP responses before exit —
  // the old immediate process.exit() cut responses (SSE frames, API calls)
  // mid-write on every deploy. server.close() stops NEW connections; a
  // short hard-exit deadline keeps Render's SIGTERM window bounded.
  const exitCode = signal === 'SIGINT' ? 130 : 143;
  if (_httpServer) {
    try {
      _httpServer.close(() => process.exit(exitCode));
      setTimeout(() => process.exit(exitCode), 2000).unref?.();
      return;
    } catch { /* fall through to immediate exit */ }
  }
  process.exit(exitCode);
}
process.on('SIGTERM', () => _gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => _gracefulShutdown('SIGINT'));

// ------------------------------------------------------------
// Startup environment validation.
// APP_PIN is REQUIRED — without it, the app has no authentication
// and all endpoints are public. The server refuses to start.
// ------------------------------------------------------------
function validateEnv() {
  const errors = [];
  const warnings = [];

  if (!APP_PIN) {
    errors.push(
      'APP_PIN is not set. The server requires a PIN for authentication. ' +
      'Set APP_PIN in your environment variables (e.g. APP_PIN=1234).'
    );
  } else if (/^(change_me_to_a_strong_pin|1234|password|changeme)$/i.test(String(APP_PIN).trim())) {
    // v20.9.3 FIX (L): .env.example ka placeholder khud ek "working" PIN hai
    // — README ke copy-paste dev quick-start path usi PIN pe boot kar deta
    // tha (documented + guessable). Refuse with a pointed message.
    errors.push(
      `APP_PIN="${String(APP_PIN).trim()}" is a known placeholder/default — this is a documented, guessable value. ` +
      'Set a real PIN in your environment (letters+digits, not in any docs).'
    );
  }

  // v18.8.1: TG half-config no longer bricks boot. The pair is
  // normalized at the TG definition site (both cleared + loud warning)
  // BEFORE any subsystem arms, so by the time validateEnv runs the
  // values are always BOTH-set or BOTH-empty. Telegram is an optional
  // channel - only auth-critical misconfigs (APP_PIN missing,
  // VITE_API_TOKEN === API_TOKEN leak) still refuse to start.

  // v10.13 SECURITY (deep-recheck H-1): refuse to boot when the master
  // service token would ALSO be baked into the public browser bundle.
  // render.yaml no longer declares VITE_API_TOKEN, but a hand-rolled env
  // (.env, Docker, VPS) can still set both to the same value — that single
  // mistake hands every anonymous visitor a valid master bearer token
  // (API_TOKEN authenticates on EVERY endpoint, incl. /api/ai/execute and
  // cloud save). Fail LOUD at boot instead.
  const viteTok = String(process.env.VITE_API_TOKEN || '').trim();
  if (viteTok) {
    if (viteTok === String(process.env.API_TOKEN || '').trim()) {
      errors.push(
        'VITE_API_TOKEN === API_TOKEN — the master service token would be INLINED ' +
        'INTO THE PUBLIC BROWSER BUNDLE (build-time VITE_* vars are readable by anyone ' +
 'who downloads the JS). Remove VITE_API_TOKEN from the build environment; ' +
        'cloud sync uses the WEALTH_AI_CLOUD_TOKEN localStorage override.'
      );
    } else {
      warnings.push('VITE_API_TOKEN is set — its value ships inside the public bundle. Ensure it is NOT the API_TOKEN master key.');
    }
  }

  // v10.13 (deep-recheck M-4): weak-PIN heads-up. Not enforced (existing
  // deployments already run a short PIN — forcing a change would lock the
  // owner out after upgrade), but a 4-digit PIN has only 10k combinations.
  if (APP_PIN && String(APP_PIN).length < 8 && /^\d+$/.test(String(APP_PIN))) {
    warnings.push('APP_PIN is short (<8 chars). A longer PIN is strongly recommended — login throttling is per-IP plus a global failure lockout.');
  }

  // Warn if no AI provider keys are set.
  const anyAiKey = Object.values(KEYS).some(v => v);
  if (!anyAiKey) {
    warnings.push('No AI provider keys configured — NeuralChat and AI features will be unavailable.');
  }

  for (const w of warnings) console.warn(`[wealth-ai] WARNING: ${w}`);
  for (const e of errors) console.error(`[wealth-ai] ERROR: ${e}`);
  if (errors.length > 0) {
    // v21.3.0 (Issue-1): BOOT-REFUSED marker — the watchdog restarts
    // this process up to 20x/hour with a 10-min budget pause, and the
    // ONLY place the reason lived was the (usually closed) console
    // window. A one-line marker file next to the data dirs makes
    // "watchdog chal raha hai par site kabhi nahi khulti" self-
    // diagnosing — supervisor console + user dono padh sakte hain.
    try {
      const marker = path.join(__dirname, 'data', 'BOOT-REFUSED.txt');
      fs.mkdirSync(path.dirname(marker), { recursive: true });
      fs.writeFileSync(marker, `[${new Date().toISOString()}] Server refused to start due to config errors:\n${errors.map((e) => `  - ${e}`).join('\n')}\n\nFix app/.env (APP_PIN etc.) and restart. Ye file successful boot par delete ho jaati hai.\n`);
    } catch { /* marker is diagnostics — never blocks exit */ }
    console.error('[wealth-ai] Refusing to start due to configuration errors.');
    process.exit(1);
  }
}

function startBot() {
  if (!TG.token) {
    console.log('[wealth-ai] TG_TOKEN not configured. Telegram Bot not started.');
    return;
  }
  // v11.4 recheck: WEBHOOK vs POLLING conflict. The forked poller's
  // getUpdates 409s the moment a webhook is registered, and the
  // node-telegram-bot-api library's 409 handler then silently calls
  // deleteWebHook() and resumes polling — killing the role-based webhook
  // surface ~300ms after POST /api/telegram/setup-webhook, with no error
  // anywhere. A deployment that sets TELEGRAM_WEBHOOK_SECRET intends
  // WEBHOOK mode (setup-webhook refuses to register without it), so the
  // poller is NOT forked. Escape hatch: TG_MODE=polling forces the
  // poller back on (then don't call setup-webhook).
  if (process.env.TELEGRAM_WEBHOOK_SECRET && process.env.TG_MODE !== 'polling') {
    console.log('[wealth-ai] TELEGRAM_WEBHOOK_SECRET set — webhook mode: Telegram long-poll bot NOT forked (it would 409 and auto-delete the webhook). Call POST /api/telegram/setup-webhook once, or set TG_MODE=polling to use the poller instead.');
    return;
  }
  try {
    const botPath = path.resolve(__dirname, '..', 'telegram-bot', 'bot.mjs');
    console.log('[wealth-ai] Starting Telegram Bot (server-side child process).');
    _botProcess = fork(botPath, [], {
      env: { ...process.env, BOT_ONLY: 'true' },
    });
    _botStartedAt = Date.now();
    _botProcess.on('error', (err) => {
      console.error('[wealth-ai] Bot process error:', err.message);
    });
    _botProcess.on('exit', (code) => {
      // v20.7.8 [H1]: never auto-restart the bot out of a deliberate
      // shutdown — the old handler scheduled a fresh fork AFTER the parent
      // decided to die (and after _gracefulShutdown cleared the timer).
      if (_shuttingDown) {
        console.log(`[wealth-ai] Bot exited code=${code} during shutdown — no restart.`);
        return;
      }
      // Reset backoff if the bot stayed up for a while (stable run).
      if (Date.now() - _botStartedAt > 10 * 60 * 1000) _botRestartDelay = 5000;
      const delay = Math.min(_botRestartDelay, 5 * 60 * 1000);
      _botRestartDelay = Math.min(_botRestartDelay * 2, 5 * 60 * 1000);
      console.warn(`[wealth-ai] Bot exited code=${code} - auto-restart in ${Math.round(delay / 1000)}s`);
      clearTimeout(_botRestartTimer);
      _botRestartTimer = setTimeout(() => {
        console.log('[wealth-ai] Restarting bot...');
        startBot();
      }, delay);
    });
  } catch (e) {
    console.error('[wealth-ai] Failed to start bot:', e.message);
    clearTimeout(_botRestartTimer);
    _botRestartTimer = setTimeout(startBot, 10000);
  }
}

// Validate once before binding the port. validateEnv() is the single source
// of truth for startup requirements and refuses unsafe configurations.
validateEnv();

// ------------------------------------------------------------
// Terminal error middleware (Express 4 does NOT catch async rejections).
// Any route handler that ever throws asynchronously would otherwise leave
// the socket hanging with no response. This converts those into a clean
// 500 JSON error instead.
// ------------------------------------------------------------
// v20.9.1 [M]: 500s pe `detail` field raw err.message leak karta tha
// (file paths, upstream URLs, TypeError internals) — message sanitize
// karke detail ne khud hi wo sanitize defeat kar diya tha. Ab detail
// sirf 4xx pe jata hai; 500 ka detail server-side log me hi rehta hai.
app.use((err, _req, res, _next) => {
  console.error('[wealth-ai] Unhandled route error:', err?.message || err);
  if (!res.headersSent) {
    // v10.13 (deep-recheck L-1): body-parser errors carry err.status=400 —
    // a malformed JSON body is a CLIENT error and must 400 (was 500).
    const status = Number.isInteger(err?.status) && err.status >= 400 && err.status <= 599
      ? err.status
      : (Number.isInteger(err?.statusCode) && err.statusCode >= 400 && err.statusCode <= 599 ? err.statusCode : 500);
    // v20.9.1 [M]: detail sirf 4xx client-errors pe — 500 pe raw message
    // (file paths / upstream URLs / TypeError internals) client tak nahi
    // jaata (message-only sanitize ko detail field defeat kar raha tha).
    res.status(status).json({
      error: {
        message: status === 500 ? 'Internal server error.' : String(err?.message || err).slice(0, 200),
        ...(status < 500 ? { detail: String(err?.message || err).slice(0, 200) } : {}),
      },
    });
  }
});

// ------------------------------------------------------------
// v10.3.1 DURABLE BOOT RESTORE — AWAITED BEFORE THE PORT OPENS.
// Render's ephemeral filesystem starts every boot with an empty
// server/data/. The old fire-and-forget restore left a window where
// a watcher tick could durablePut an EMPTY journal over the good
// backup — the exact "site refresh par saare positions clear"
// bug (refresh after idle = Render spin-down cold boot = wiped
// journal with no restore). Now the trading state (journal with
// open positions, risk config, both agents' state, credentials)
// hydrates BEFORE any route can serve or write. Bounded by an 8s
// race so a dead GitHub can never block boot — trading continues
// from the local (empty) disk exactly as before in that case.
// ------------------------------------------------------------
try {
  // Block MTF config/state persistence until the restore attempt finishes.
  // A slow/dead durable backend must not let a boot-time writer stamp a
  // newer default empty state over the backup.
  try {
    const mtfBoot = await import('./ai/mtfAutoLink.js');
    mtfBoot.__beginMtfAutoBoot?.();
  } catch { /* best-effort */ }
  await Promise.race([
    durableBootRestoreAll(),
    new Promise(resolve => { const t = setTimeout(resolve, 8000); if (typeof t.unref === 'function') t.unref(); }),
  ]);
} catch (e) {
  console.warn('[mcp/durable] boot restore error:', e?.message || e);
}

// ------------------------------------------------------------
// v21.1.1 [audit B2]: exec-stack RE-HYDRATE after durable restore.
// Pehle hydrate (exec-arm section) durableBootRestoreAll se PEHLE chalta
// tha — ephemeral-FS deploys (Render) par journal us waqt khali hota hai,
// seconds baad durable backup se restore hota hai, aur PM ladder-state
// kabhi nahi banta. Futures watcher phir un rows ko skip karta tha
// ("PM manage karta hai" — jo tha hi nahi) → restored live positions ka
// koi T1/T2/trail/SL-hit management nahi, sirf native exchange SL bachata.
// hydrateFromJournal idempotent hai (existing ids skip) isliye restore ke
// baad ek baar aur chalana safe hai.
// ------------------------------------------------------------
try {
  if (_positionManager?.hydrateFromJournal) {
    const { loadJSON } = await import('./lib/store.js');
    const j = loadJSON('ai-trading-journal.json', { entries: [], positions: [] });
    const n = _positionManager.hydrateFromJournal((j?.positions) || []) || 0;
    if (n > 0) console.log(`[exec-stack] post-restore hydrate: ${n} exec-enter position(s) durable journal se ladder me`);
  }
} catch (e) { console.log(`[exec-stack] post-restore hydrate skip: ${String(e?.message || e).slice(0, 80)}`); }

// v10.13 (deep-recheck L-8): capture the server so graceful shutdown can
// drain in-flight responses before exiting.
_httpServer = app.listen(PORT, async () => {
  const ready = Object.entries(KEYS).filter(([, v]) => v).map(([k]) => k);
  console.log(`[smartai] server on :${PORT} — providers: ${ready.join(', ') || 'NONE'}`);
  console.log('[smartai] Authentication: enabled (server-side PIN + httpOnly session cookie)');
  // v20.8.3: SERVER_VERSION se boot line (v20.4.2 hardcoded string 19 releases
  // stale thi) — /api/ping `v`, /health `version` aur ye line ab ek hi source se.
  console.log(`[smartai] v${SERVER_VERSION} THREE-DESK TERMINAL — India Intraday + CoinDCX + JEV Bot Lab · lean frontend · zero-polling shell`);
  // v21.12.0: committee composition boot banner — user ke "sirf 13 models
  // dikh rahe hain" waale confusion ka end. Watchdog logs me ab hamesha
  // dikhega ki board par EXACTLY kaun-kaun kitne seats baithte hain.
  try { console.log(committeeBanner()); } catch { /* banner never fatal */ }

  // v21.23.4: RUNTIME DIRECTION CERTIFICATE — har boot pe synthetic
  // ground-truth proof (rising→LONG/BUY · falling→SHORT/SELL). "Signals
  // opposite" complaint pe sabse PEHLE ye line dekho: FAIL = computation
  // bug (build galat/gadbad code), PASS = computation sahi (data-feed
  // inspect karo). /api/ai/direction-selftest se on-demand bhi.
  try {
    const { logDirectionSelfTestAtBoot } = await import('./ai/directionSelfTest.js');
    logDirectionSelfTestAtBoot((lvl, line) => console.log(line));
  } catch { /* certificate never fatal at boot */ }

  // v21.23.11: LIVE DIRECTION CERTIFICATE — synthetic PASS hone ke bawajood
  // user ke live box pe "sab signals opposite" isliye reh gaya tha ki wire-
  // format drift (CoinDCX timestamp key / newest-first order) internal tests
  // aur synthetic selftest dono ke blind spot me tha. Ye certificate REAL
  // network se app ke APNE candle chains ko audit karta hai — orientation
  // (mirror), LTP-vs-ticker (scale), vote-vs-realized-trend (inversion).
  // Koi chain FAIL ho to boot log uska NAAM lekar shout karta hai — silent
  // mirror ab kabhi nahi. Non-blocking (boot kabhi wait nahi karta).
  try {
    const { logLiveDirectionCertAtBoot } = await import('./ai/directionLiveCert.js');
    logLiveDirectionCertAtBoot((lvl, line) => console.log(line));
  } catch { /* live certificate never fatal at boot */ }

  // v21.3.0 (Issue-1): a previous successful boot clears the refusal marker.
  try { const m = path.join(__dirname, 'data', 'BOOT-REFUSED.txt'); if (fs.existsSync(m)) fs.rmSync(m); } catch { /* noop */ }

  // No self-ping keepalive (Render ToS violation).
  // For 24x7 uptime on free tier, use an EXTERNAL uptime monitor
  // (e.g. UptimeRobot) that pings /health every 5 min.
});

// v21.3.0 (Issue-1: EADDRINUSE zombie fix) — app.listen() ka koi 'error'
// handler nahi tha. Ek port conflict (doosra npm start / restart race /
// orphaned child) uncaughtException fires karta tha, selfHeal ka
// STAY-ALIVE policy use ZINDA rakhta tha, aur process hamesha ke liye
// SUNN (kabhi listen nahi karta) reh jaata tha — the "server down"
// symptom that never heals. Ab bind-fail honest exit(1) + journal karta
// hai taaki supervisor ka restart/backoff turant engage ho.
try {
  _httpServer.on('error', (err) => {
    const code = String(err?.code || '');
    try {
      console.error(`[smartai] HTTP SERVER ERROR (${code}): ${err?.message || err}`);
      if (code === 'EADDRINUSE') {
        console.error(`[smartai] Port ${PORT} pehle se kisi aur process ke paas hai — purana Start-SmartAI server band karo (ya Task Manager me node.exe close karo) aur dobara start karo.`);
      }
    } catch { /* console best-effort */ }
    // journal via the selfHeal module (best-effort; never blocks exit)
    try {
      import('./ai/selfHeal.js').then((m) => {
        try { m.selfHealNoteShutdown(`http-server-error ${code}`); } catch { /* noop */ }
        process.exit(1);
      }).catch(() => process.exit(1));
    } catch { process.exit(1); }
  });
} catch { /* listener attach best-effort */ }

// Start Telegram bot with auto-restart (after listen — the webhook
// route + long-poll bot need the express app wired and serving).
startBot();

// ============================================================
// v21.0 BOOT-TIME TELEGRAM SELF-TEST (telegram fix T2)
// ------------------------------------------------------------
// "Koi notifications nahi aa rahe" ka #2 reason: sendTelegramMessage
// fire-and-forget hai — 401 (bad token) / 403 (user ne bot pe START
// nahi dabaya) / 400 (galat chat id) errors {ok:false} me SWALLOW ho
// jaate the. Boot pe ek getMe + ek test sendMessage ye errors ko
// LOUD diagnose karta hai. Watchdog restart-loop spam se bachne ke
// liye: max 1 test message / ghanta (marker file se guard).
// ============================================================
async function telegramSelfTest() {
  try {
    const { telegramConfig } = await import('./ai/secrets.js');
    const cfg = telegramConfig(TG);
    if (!cfg) {
      console.log('[telegram-selftest] Telegram configured nahi hai (TG_TOKEN + TG_CHAT_ID dono chahiye) — alerts OFF, app normal.');
      return;
    }
    // getMe — token validity check (NO message bhejta)
    let me = null;
    try {
      const r = await fetch(`https://api.telegram.org/bot${cfg.token}/getMe`, { signal: AbortSignal.timeout(8000) });
      const j = await r.json().catch(() => ({}));
      me = j?.result?.username ? `@${j.result.username}` : null;
      if (!r.ok || !me) {
        console.warn(`[telegram-selftest] ❌ getMe FAIL (HTTP ${r.status}) — TG_TOKEN INVALID hai. .env me sahi token daalo (BotFather se naya copy karo).`);
        return;
      }
    } catch (e) {
      console.warn(`[telegram-selftest] ⚠️ getMe timeout/network (${String(e?.message || e).slice(0, 60)}) — baad me retry hoga.`);
      return;
    }
    // Rate guard: 1 test message / hour (watchdog restarts spam na karein)
    const marker = path.join(__dirname, 'data', '.tg-selftest-at');
    try {
      const last = Number(fs.readFileSync(marker, 'utf8')) || 0;
      if (Date.now() - last < 60 * 60 * 1000) {
        console.log(`[telegram-selftest] ✅ bot ${me} reachable — test message recently bheja gaya tha (marker fresh), skip.`);
        return;
      }
    } catch { /* no marker = first run */ }
    // Test send — 403 = user ne START nahi dabaya, 400 = chat id galat
    const r2 = await fetch(`https://api.telegram.org/bot${cfg.token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: cfg.chatId,
        text: '✅ <b>SmartAI Pro Telegram connected</b>\n<blockquote>Boot self-test v' + SERVER_VERSION + ' — alerts pipeline LIVE hai.</blockquote>',
        parse_mode: 'HTML',
      }),
      signal: AbortSignal.timeout(8000),
    });
    if (r2.ok) {
      console.log(`[telegram-selftest] ✅ Telegram delivery VERIFIED (bot ${me} → chat ${cfg.chatId}) — notifications pipeline healthy.`);
      try { fs.writeFileSync(marker, String(Date.now())); } catch { /* best-effort */ }
    } else if (r2.status === 403) {
      console.warn(`[telegram-selftest] ❌ 403 Forbidden — is chat me bot ne START nahi mila! Telegram app me bot (${me}) kholo aur /start bhejo (ONE time), phir watchdog restart.`);
    } else if (r2.status === 400) {
      console.warn(`[telegram-selftest] ❌ 400 Bad Request — TG_CHAT_ID (${cfg.chatId}) galat lag raha hai. /getmychat wale bot se ya @userinfobot se sahi numeric chat id lo.`);
    } else {
      console.warn(`[telegram-selftest] ❌ sendMessage HTTP ${r2.status} — token/chat config recheck karo.`);
    }
  } catch (e) {
    console.warn(`[telegram-selftest] self-test error (non-fatal): ${String(e?.message || e).slice(0, 100)}`);
  }
}
telegramSelfTest();

// v18.10 COINDCX ENV BOOTSTRAP — keys sitting in app\.env
// (COINDCX_API_KEY + COINDCX_SECRET) connect the exchange account at
// boot when nothing is saved yet: the wallet card flips to LIVE · API
// CONNECTED, the order console unblocks, the agent reads real equity.
// Best-effort + async: an invalid pair logs one line and the app keeps
// running in paper mode (never a brick — the v18.8.1 Telegram lesson).
coindcxEnvBootstrap((line) => console.log(line)).catch((e) =>
  console.log(`[coindcx-env] bootstrap failed (non-fatal): ${String(e?.message || e).slice(0, 120)}`));

// ============================================================
// v20.6 SELF-IMPROVEMENT ENGINE — REMOVED FROM DEFAULT RUNTIME
// ------------------------------------------------------------
// v19.0 introduced a 4-cadence loop (6h harvest · 1h drift · 1h
// auto-approvals · weekly gate-tune+lessons) that wrote into the
// ledger and feed the evolution ledger. The live user report was
// that this loop was CAUSING LOAD on the trade-signal path (every
// harvest/drift pass walks the ledger; every weekly pass attempts
// LLM calls; the council prompt block grew with lessons text →
// council token spend rose + board cycle latency crept up). The
// user explicitly asked to "completely remove" the loop and clean
// up the site.
//
// Strategy: do NOT delete the loop modules (council.js dynamically
// `await import('./lessonsEngine.js')` for the lessonsBlock prompt;
// deleting would crash that path). Instead:
//   1. Default SELFIMPROVE_ENABLED=false in .env.example (below).
//   2. Rip the 4 setInterval blocks — even if someone flips the
//      flag to true, no loop runs (heavy work must be triggered
//      manually — the /api/ai/self/* routes were removed in v20.6.3).
//   3. Unmount SelfImprovementPanel from CoinDcxTab (no UI load).
//   4. (v20.6.3) routes.js handlers + SelfImprovementPanel.tsx were then REMOVED.
//
// Modules LEFT IN PLACE (touching them breaks signal generation):
//   • adaptive.js (v6.7, NOT v19.0) — applyAdaptiveWeights runs on
//     every board tick in signals.js; DO NOT TOUCH.
//   • signalMemory.js (v12.4) — applySignalTrustGuards (OB/OS + flip
//     cooldown gate); INDEPENDENT of this loop.
//   • selfHeal.js (v19.1) — server stability watchdog (uncaught
//     exception + memory + event-loop monitor); INDEPENDENT.
//   • boardAccountability.js (v20.2) — board→trackRecord bridge;
//     route-layer only; INDEPENDENT.
//   • mlHealth.js (v18.1) — cached ml-service reachability probe;
//     INDEPENDENT.
// ============================================================
try {
  const _siFlag = String(process.env.SELFIMPROVE_ENABLED || 'false').toLowerCase();
  if (_siFlag === 'true') {
    // opt-in only — the heavy loop is OFF by default. The flag is kept
    // for users who want to re-arm the v19.0 loop manually; the
    // intervals below fire only when SELFIMPROVE_ENABLED=true.
    const { harvestOutcomes } = await import('./ai/outcomeHarvester.js');
    const { runDriftCheck } = await import('./ai/driftMonitor.js');
    const { processAutoApprovals } = await import('./ai/selfCouncil.js');
    const { runGateTune } = await import('./ai/gateTuner.js');
    const { generateLessons } = await import('./ai/lessonsEngine.js');
    const { loadAgentConfig } = await import('./ai/agent.js');
    const { evolutionStatus } = await import('./ai/evolutionLedger.js');

    setTimeout(() => {
      try { const h = harvestOutcomes(); console.log(`[selfimprove] boot harvest: +${h.added} rows (total ${h.total}) — drift ${runDriftCheck().verdict}`); } catch { /* guarded */ }
    }, 45000).unref?.();

    setInterval(() => {
      try { runDriftCheck(); } catch { /* guarded */ }
      try { const r = processAutoApprovals(); if (r.autoApplied > 0) console.log(`[selfimprove] auto-approved ${r.autoApplied} safe-tier proposal(s) (24h rule)`); } catch { /* guarded */ }
    }, 3600000).unref?.();

    setInterval(() => {
      try { const h = harvestOutcomes(); if (h.added > 0) console.log(`[selfimprove] harvest: +${h.added} rows (total ${h.total})`); } catch { /* guarded */ }
    }, 6 * 3600000).unref?.();

    setInterval(() => {
      try {
        const r = runGateTune({ current: loadAgentConfig() });
        if (r.verdict !== 'NOT ENOUGH DATA') console.log(`[selfimprove] weekly gate-tune: ${r.verdict}`);
      } catch { /* guarded */ }
      generateLessons({ KEYS, OPENAI_COMPAT }).catch(() => { /* LLM down → deterministic path inside */ });
    }, 7 * 86400000).unref?.();

    const _evo = evolutionStatus();
    console.log(`[selfimprove] v19.0 SELF-IMPROVEMENT ENGINE armed (opt-in SELFIMPROVE_ENABLED=true) — evolution ledger: ${_evo.total} entries (verified: ${_evo.verified}). DEFAULT is OFF; user re-armed.`);
  } else {
    // v20.6 default: the loop is OFF. No intervals, no harvest, no
    // drift watch, no lessons, no gate-tune. (The /api/ai/self/*
    // routes were removed in v20.6.3.)
    console.log('[selfimprove] v20.6 SELF-IMPROVEMENT ENGINE DISABLED by default (SELFIMPROVE_ENABLED not set to true) — loop intervals NOT armed; signal-generation path is now free of this load. The /api/ai/self/* routes were removed in v20.6.3.');
  }
} catch (e) {
  console.log(`[selfimprove] arm check failed (non-fatal — app continues): ${String(e?.message || e).slice(0, 120)}`);
}