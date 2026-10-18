// ============================================
// 🤖 ADVANCE PRO INTELLIGENCE — MAIN SERVER v18.0
// ============================================
// Telegram Command System + AI Chat + Auto Analysis
// Multi-Engine Smart Router (7 LLMs) + Quant Brain Fallback
// ============================================

import TelegramBot from 'node-telegram-bot-api';
import cron from 'node-cron';

// v11.4 recheck: wall-clock schedules are written in IST and MUST carry
// the timezone option — node-cron defaults to the HOST timezone, so bare
// UTC-encoded crons drifted 5.5h on any non-UTC host (IST VPS, local
// start_server.vbs). Interval crons (*/N) are timezone-agnostic and stay
// on cron.schedule directly.
const cronIST = (expr, fn) => cron.schedule(expr, fn, { timezone: 'Asia/Kolkata' });
import express from 'express';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { TG_TOKEN, TG_CHAT_ID, GROQ_KEY, GEMINI_KEY, CLAUDE_KEY, TAVILY_API_KEY, TAX_PAIRS, OPENROUTER_KEY, CEREBRAS_KEY, HF_KEY, NVIDIA_KEY, API_URL, BOT_NAME, BOT_VERSION, BOT_TAGLINE, FUNDAMENTALS_API_URL, isTavilyAvailable } from './config.mjs';
import { batchFetchPrices, fetchForexRate, fetchMarketIntelligence, fetchSingleSymbol, trackVixChange, isAnyMarketOpen, getMarketStatus, getISTTime, isIndiaMarketOpen, isUSMarketOpen, fetchCryptoPrices, fetchCryptoPricesINR, fetchBondYields, fetchFIIDIIData, fetchIPOData } from './market.mjs';
import {
  loadPortfolioFromCloud, loadSyncMeta, listHiddenAssets,
  triggerSiteSync, unhideSiteAsset, unhideAllSiteAssets, siteApiConfigured,
} from './siteSync.mjs';
import {
  generatePortfolioReport, generateMarketReport,
  generateAllocationReport, generateRiskReport, generateAutoReport,
  generateForexReport, calculateMetrics, generateScanReport,
  generateCompareReport, analyzeAsset,
  generateLiveReport, generateCryptoReport, generateSIPReport,
  generateETFReport, generateDigestReport, generateFIIDIIReport, generateIPOReport,
  generateLongTermReport, generateStrategyReport,
  generateSipTiltReport, generateTaxPlanReport, generateDrawdownReport
} from './analysis.mjs';


import { chatWithAI, chatWithConsensus, analyzeChartImage, transcribeVoice, clearChatHistory, setChatEngine, getChatEngine, AI_ENGINE_LABELS, getAIHealthStatus } from './ai-chat.mjs';
import { backtestSignal, calculateBacktestMetrics } from './backtester.mjs';
import { scanAlgoSignals, formatAlgoAlert, algoWatchKeys } from './algo.mjs';

// v18.2 UNIFICATION: the bot's analysis commands now route through the
// SAME site backend the website tabs + webhook bot use (one source of
// truth — the "bot says BUY, site says HOLD" era ends here). The bridge
// talks to the site over the 127.0.0.1 loopback with the server-only
// API_TOKEN; when the site is unreachable every caller falls back to
// its legacy local path so the bot never goes dark.
import * as siteAgents from './siteAgents.mjs';

// Validate required environment variables
if (!TG_TOKEN) {
  console.error('❌ CRITICAL: TG_TOKEN (Telegram Bot Token) is missing! Bot cannot start.');
  process.exit(1);
}

// ========================================
// GLOBAL STATE
// ========================================
let portfolio = [];
let livePrices = {};
let usdInrRate = 85.5;
let marketIntel = null;
let autoAlerts = true;
let botReady = false;
let lastRefreshTime = 0;

// FIX H2: Smart refresh — only fetch fresh prices if >60s old.
// Prevents every /ai command from blocking 8-10s on TradingView scan.
async function smartRefreshPrices() {
  if (Date.now() - lastRefreshTime > 60000 || Object.keys(livePrices).length === 0) {
    await refreshPrices();
    lastRefreshTime = Date.now();
  }
}

// Intraday algo alert cooldown (per symbol) so we don't spam the same setup.
const lastAlgoAlertAt = {};
const ALGO_COOLDOWN_MS = 20 * 60 * 1000; // 20 min

// v17 FIX (memory hygiene): prune stale algo-cooldown entries hourly so the
// map doesn't grow forever on long-running dynos.
setInterval(() => {
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  for (const key of Object.keys(lastAlgoAlertAt)) {
    if ((lastAlgoAlertAt[key] || 0) < cutoff) delete lastAlgoAlertAt[key];
  }
}, 60 * 60 * 1000);

// AI Rate Limiting
const aiCallTimestamps = new Map();
const AI_RATE_LIMIT_MS = 10000;
const AI_RATE_LIMIT_MAX = 3;

function checkAIRateLimit(chatId) {
  const now = Date.now();
  const id = String(chatId);
  if (!aiCallTimestamps.has(id)) aiCallTimestamps.set(id, []);
  const timestamps = aiCallTimestamps.get(id).filter(t => now - t < 60000);
  aiCallTimestamps.set(id, timestamps);
  if (timestamps.length >= AI_RATE_LIMIT_MAX) return false;
  timestamps.push(now);
  // v17 FIX (memory hygiene): previously this Map could grow unbounded —
  // stale entries were never removed, only filtered per-call. Prune fully.
  if (aiCallTimestamps.size > 50) {
    for (const [k, arr] of aiCallTimestamps) {
      if (!arr.length || now - arr[arr.length - 1] > 10 * 60 * 1000) aiCallTimestamps.delete(k);
    }
  }
  return true;
}

// Authorization check — only allow the configured chat ID
function isAuthorized(msg) {
  if (!TG_CHAT_ID) {
    console.warn(`[TELEGRAM BOT] Rejecting message from ${msg.chat.id}: TG_CHAT_ID not configured`);
    if (typeof bot !== 'undefined') {
      bot.sendMessage(msg.chat.id, `🚫 Unauthorized! Your Chat ID is: ${msg.chat.id}\n\nPlease add this ID to TG_CHAT_ID in your Render dashboard environment variables to enable the bot.`).catch(() => {});
    }
    return false;
  }
  const match = String(msg.chat.id) === String(TG_CHAT_ID);
  if (!match) {
    console.warn(`[TELEGRAM BOT] Rejecting message from unauthorized chat ID: ${msg.chat.id}`);
    if (typeof bot !== 'undefined') {
      bot.sendMessage(msg.chat.id, `🚫 Access Denied! Your Chat ID (${msg.chat.id}) does not match the configured TG_CHAT_ID.`).catch(() => {});
    }
  }
  return match;
}

// SECURITY: escape HTML special characters in user-provided content before
// inserting it into Telegram HTML messages. Without this, a user could
// inject HTML tags (e.g., /scan <b>FAKE ALERT</b>) that get rendered as
// formatted HTML in the chat.
function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Performance streak tracking with file persistence
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const STREAK_FILE = path.join(__dirname, 'streak-data.json');

let dailyPLHistory = [];
let consecutiveStreak = 0;

function loadStreakData() {
  try {
    if (fs.existsSync(STREAK_FILE)) {
      const data = JSON.parse(fs.readFileSync(STREAK_FILE, 'utf8'));
      dailyPLHistory = data.dailyPLHistory || [];
      consecutiveStreak = data.consecutiveStreak || 0;
      console.log(`✅ Streak data loaded: ${dailyPLHistory.length} days, streak=${consecutiveStreak}`);
    }
  } catch (e) {
    console.warn('⚠️ Streak data load failed:', e.message);
  }
}

function saveStreakData() {
  // FIX H16: previously fs.writeFileSync — blocks the event loop on disk I/O,
  // which interferes with concurrent Telegram message handling. Use async
  // fs.promises.writeFile and swallow errors (called from cron / hot path).
  try {
    fs.promises.writeFile(STREAK_FILE, JSON.stringify({ dailyPLHistory, consecutiveStreak }), 'utf8').catch(() => {});
  } catch (e) { }
}

// ========================================
// 🌐 FULL SITE + BOT SERVER (For Render deployment)
// ========================================
const app = express();
const PORT = process.env.PORT || 3000;

// Serve the compiled Vite React frontend
const distPath = path.join(__dirname, '../dist');
app.use(express.static(distPath));

// ========================================
// API ROUTER — Groq Proxy (avoids CORS + browser key exposure)
// Frontend calls /api/groq → server uses env var keys
// Uses Express Router for clean path matching (works with Express 5)
// ========================================
const apiRouter = express.Router();

// CORS for all API routes — allowlist only (never reflect arbitrary origins).
const BOT_ALLOWED_ORIGINS = new Set(
  (process.env.ALLOWED_ORIGINS || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
    .concat([
      'http://localhost:5173',
      'http://127.0.0.1:5173',
      'http://localhost:8080',
      'http://127.0.0.1:8080',
      'http://localhost:3000',
      'http://127.0.0.1:3000',
    ])
);
apiRouter.use((req, res, next) => {
  const origin = req.headers.origin || '';
  if (origin && BOT_ALLOWED_ORIGINS.has(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  }
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// ============================================================
// SECURITY (audit H-1): the LLM relay routes (/api/groq, /api/gemini,
// /api/claude, ...) burn the owner's paid API keys. CORS does NOT stop
// non-browser clients — anyone could `curl -X POST` this server and use
// the keys as a free relay. Three protections:
//   1. If BOT_API_SECRET is set → Bearer token required on all relay routes.
//   2. Per-IP rate limit (30 req/min) always applies as a backstop.
//   3. FAIL-CLOSED (v20.7.3): no BOT_API_SECRET → relay only answers
//      loopback/private addresses (local dev). The bot's Express server
//      is a PUBLIC web service (Render) — an unset secret must never
//      leave paid keys open to the internet.
// Public read-only routes (/config, /ai-status) are exempt.
// ============================================================
const BOT_API_SECRET = process.env.BOT_API_SECRET || '';
const _relayAttempts = new Map(); // ip → [timestamps]
function relayRateCheck(ip) {
  const now = Date.now();
  if (_relayAttempts.size > 1000) {
    // v20.8.4 FIX (M — dead cleanup): the old condition indexed a NUMBER
    // (v[v[v.length - 1]] → undefined → NaN comparison always false), so
    // only EMPTY arrays were ever deleted and hostile IP-spoofed scanning
    // grew the Map unboundedly.
    for (const [k, v] of _relayAttempts) {
      if (!v.length || now - v[v.length - 1] > 60_000) _relayAttempts.delete(k);
    }
  }
  const arr = (_relayAttempts.get(ip) || []).filter(t => now - t < 60_000);
  if (arr.length >= 30) return false;
  arr.push(now);
  _relayAttempts.set(ip, arr);
  return true;
}
// v20.7.3: loopback/private-IP test for the fail-closed relay gate.
// Handles plain IPv4, IPv6-mapped IPv4 (::ffff:127.0.0.1) and ::1.
function _isLoopbackOrPrivateIp(ip) {
  if (!ip || typeof ip !== 'string') return false;
  const v = ip.toLowerCase().trim();
  if (v === '::1' || v === '::') return true;
  let v4 = null;
  const mapped = v.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (mapped) v4 = mapped[1];
  else if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(v)) v4 = v;
  if (!v4) return false;
  const p = v4.split('.').map(Number);
  if (p.length !== 4 || p.some(n => !Number.isFinite(n) || n < 0 || n > 255)) return false;
  return p[0] === 127 || p[0] === 10
    || (p[0] === 192 && p[1] === 168)
    || (p[0] === 172 && p[1] >= 16 && p[1] <= 31)
    || (p[0] === 169 && p[1] === 254);
}
apiRouter.use((req, res, next) => {
  // Public read-only endpoints stay open.
  if (req.path === '/config' || req.path === '/ai-status' || req.method === 'OPTIONS') return next();
  // Rate limit every relay call per IP.
  // v20.8.4 FIX (M — XFF spoof bypass): XFF's LAST entry is only trustworthy
  // behind a proxy that APPENDS the real client IP. In the exact deployment
  // this fail-closed gate targets (no BOT_API_SECRET, no trusted proxy), a
  // direct attacker controls the whole header — a forged
  // `X-Forwarded-For: 10.0.0.1` sailed through the private-IP gate and
  // opened the paid LLM relay to the internet. socket.remoteAddress unless
  // TRUST_PROXY=1 explicitly says a rewriting proxy sits in front.
  const xff = (req.headers['x-forwarded-for'] || '').toString().split(',').map(s => s.trim()).filter(Boolean);
  const ip = (process.env.TRUST_PROXY === '1' ? (xff[xff.length - 1] || '') : '') || req.socket.remoteAddress || 'unknown';
  if (!relayRateCheck(ip)) {
    return res.status(429).json({ error: 'Rate limit exceeded. Max 30 requests/minute.' });
  }
  // When a shared secret is configured, require it.
  if (BOT_API_SECRET) {
    const auth = (req.headers.authorization || '').startsWith('Bearer ')
      ? req.headers.authorization.slice(7).trim()
      : '';
    if (auth !== BOT_API_SECRET) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    return next();
  }
  // v20.7.3 FAIL-CLOSED: no secret configured → only local/private callers.
  if (ip !== 'unknown' && !_isLoopbackOrPrivateIp(ip)) {
    return res.status(503).json({
      error: 'LLM relay disabled: BOT_API_SECRET is not configured on the bot server. Set it in the bot environment to enable relay routes.',
    });
  }
  next();
});

// Server config — exposes API_URL to frontend at runtime
apiRouter.get('/config', (req, res) => {
  res.json({
    apiUrl: API_URL || '',
    gemini: !!(GEMINI_KEY && GEMINI_KEY.length > 5),
    groq: !!(GROQ_KEY && GROQ_KEY.length > 10),
    tavily: !!(TAVILY_API_KEY && TAVILY_API_KEY.length > 10)
  });
});

apiRouter.get('/ai-status', (req, res) => {
  res.json({
    nvidia: !!NVIDIA_KEY,
    gemini: !!(GEMINI_KEY && GEMINI_KEY.length > 5),
    groq: !!(GROQ_KEY && GROQ_KEY.length > 10),
    claude: !!(CLAUDE_KEY && CLAUDE_KEY.length > 10),
    openrouter: !!(OPENROUTER_KEY && OPENROUTER_KEY.length > 10),
    cerebras: !!(CEREBRAS_KEY && CEREBRAS_KEY.length > 10),
    huggingface: !!(HF_KEY && HF_KEY.length > 10),
    tavily: !!(TAVILY_API_KEY && TAVILY_API_KEY.length > 10)
  });
});

apiRouter.post('/nvidia', express.json({ limit: '1mb' }), async (req, res) => {
  try {
    // FIX H4: add key + messages validation (other routes already have this).
    if (!NVIDIA_KEY || NVIDIA_KEY.length < 10) {
      return res.status(503).json({ error: 'NVIDIA key not configured' });
    }
    const { messages, model } = req.body || {};
    if (!Array.isArray(messages)) {
      return res.status(400).json({ error: 'messages[] required' });
    }
    const modelName = model || 'openai/gpt-oss-120b';
    const formattedMessages = messages.map(m => ({ role: m.role, content: m.content }));
    
    const apiRes = await fetch('https://integrate.api.nvidia.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${NVIDIA_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: modelName,
        messages: formattedMessages,
        temperature: 0.7,
        max_tokens: 4000
      }),
      signal: AbortSignal.timeout(30000)
    });

    const data = await apiRes.json();
    if (!apiRes.ok) return res.status(apiRes.status).json(data);
    
    res.json(data);
  } catch (error) {
    console.error('[API] NVIDIA Error:', error.message);
    res.status(502).json({ error: 'NVIDIA AI provider is temporarily unavailable.' });
  }
});

apiRouter.post('/gemini', express.json({ limit: '1mb' }), async (req, res) => {
  try {
    if (!GEMINI_KEY || GEMINI_KEY.length < 5) {
      return res.status(503).json({ error: 'Gemini API key not configured on server' });
    }
    const { messages, model } = req.body;
    let modelName = model;
    if (!modelName || modelName.includes('2.0') || modelName.includes('1.5')) {
      modelName = 'gemini-3.5-flash';
    }

    const contents = messages.filter(m => m.role !== 'system').map(m => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content }]
    }));
    const systemMsg = messages.find(m => m.role === 'system');

    const body = {
      contents,
      generationConfig: { temperature: 0.7, maxOutputTokens: 8000 }
    };
    if (systemMsg) body.systemInstruction = { parts: [{ text: systemMsg.content }] };

    let apiRes = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${GEMINI_KEY}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30000)
    });

    if (!apiRes.ok && apiRes.status === 404 && modelName !== 'gemini-2.5-flash') {
      apiRes = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_KEY}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(30000)
      });
    }

    const data = await apiRes.json();
    if (!apiRes.ok) return res.status(apiRes.status).json(data);
    res.json(data);
  } catch (e) {
    console.error('Gemini proxy error:', e.message);
    res.status(502).json({ error: 'Gemini AI provider is temporarily unavailable.' });
  }
});

apiRouter.post('/groq', express.json({ limit: '1mb' }), async (req, res) => {
  try {
    if (!GROQ_KEY || GROQ_KEY.length < 10) {
      return res.status(503).json({ error: 'Groq API key not configured on server' });
    }
    const { messages, model } = req.body;
    let modelName = model;
    if (!modelName || modelName.includes('3.3') || modelName.includes('3.2-90b') || modelName.includes('3.1') || modelName.includes('llama-4-scout')) {
      modelName = 'openai/gpt-oss-120b';
    }

    let apiRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${GROQ_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: modelName,
        messages,
        temperature: 0.7,
        max_completion_tokens: 8000
      }),
      signal: AbortSignal.timeout(30000)
    });

    if (!apiRes.ok && (apiRes.status === 400 || apiRes.status === 404)) {
      apiRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${GROQ_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: 'qwen/qwen3-32b',
          messages,
          temperature: 0.7,
          max_completion_tokens: 8000
        }),
        signal: AbortSignal.timeout(30000)
      });
    }

    const data = await apiRes.json();
    if (!apiRes.ok) {
      return res.status(apiRes.status).json(data);
    }
    res.json(data);
  } catch (e) {
    console.error('Groq proxy error:', e.message);
    res.status(502).json({ error: 'Groq AI provider is temporarily unavailable.' });
  }
});

apiRouter.post('/claude', express.json({ limit: '1mb' }), async (req, res) => {
  try {
    if (!CLAUDE_KEY || CLAUDE_KEY.length < 10) {
      return res.status(503).json({ error: 'Claude API key not configured on server' });
    }
    const { messages, model } = req.body;
    const modelName = model || 'claude-sonnet-5';

    const systemMsg = messages.find(m => m.role === 'system');
    const claudeMessages = messages.filter(m => m.role !== 'system').map(m => ({
      role: m.role === 'assistant' ? 'assistant' : 'user',
      content: m.content
    }));

    const body = { model: modelName, max_tokens: 8000, messages: claudeMessages };
    if (systemMsg) body.system = systemMsg.content;

    const apiRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': CLAUDE_KEY,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30000)
    });
    const data = await apiRes.json();
    if (!apiRes.ok) return res.status(apiRes.status).json(data);
    res.json(data);
  } catch (e) {
    console.error('Claude proxy error:', e.message);
    res.status(502).json({ error: 'Claude AI provider is temporarily unavailable.' });
  }
});

apiRouter.post('/openrouter', express.json({ limit: '1mb' }), async (req, res) => {
  try {
    if (!OPENROUTER_KEY || OPENROUTER_KEY.length < 10) {
      return res.status(503).json({ error: 'OpenRouter API key not configured on server' });
    }
    const { messages, model } = req.body;
    const modelName = model || 'z-ai/glm-5.2:free';
    const apiRes = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${OPENROUTER_KEY}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://smartai1.onrender.com'
      },
      body: JSON.stringify({
        model: modelName,
        messages,
        temperature: 0.7,
        max_tokens: 8000
      }),
      signal: AbortSignal.timeout(30000)
    });
    const data = await apiRes.json();
    if (!apiRes.ok) return res.status(apiRes.status).json(data);
    res.json(data);
  } catch (e) {
    console.error('OpenRouter proxy error:', e.message);
    res.status(502).json({ error: 'OpenRouter AI provider is temporarily unavailable.' });
  }
});

apiRouter.post('/cerebras', express.json({ limit: '1mb' }), async (req, res) => {
  try {
    if (!CEREBRAS_KEY || CEREBRAS_KEY.length < 10) {
      return res.status(503).json({ error: 'Cerebras API key not configured on server' });
    }
    const { messages, model } = req.body;
    const modelName = model || 'gpt-oss-120b';
    const apiRes = await fetch('https://api.cerebras.ai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${CEREBRAS_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: modelName,
        messages,
        temperature: 0.7,
        max_tokens: 8000
      }),
      signal: AbortSignal.timeout(30000)
    });
    const data = await apiRes.json();
    if (!apiRes.ok) return res.status(apiRes.status).json(data);
    res.json(data);
  } catch (e) {
    console.error('Cerebras proxy error:', e.message);
    res.status(502).json({ error: 'Cerebras AI provider is temporarily unavailable.' });
  }
});

apiRouter.post('/huggingface', express.json({ limit: '1mb' }), async (req, res) => {
  try {
    if (!HF_KEY || HF_KEY.length < 10) {
      return res.status(503).json({ error: 'HuggingFace API key not configured on server' });
    }
    const { messages, model } = req.body;
    const modelName = model || 'Qwen/Qwen3-235B-A22B-Instruct-2507';
    const apiRes = await fetch('https://router.huggingface.co/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${HF_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: modelName,
        messages,
        temperature: 0.7,
        max_tokens: 4096
      }),
      signal: AbortSignal.timeout(60000)
    });
    const data = await apiRes.json();
    if (!apiRes.ok) return res.status(apiRes.status).json(data);
    res.json(data);
  } catch (e) {
    console.error('HuggingFace proxy error:', e.message);
    res.status(502).json({ error: 'HuggingFace AI provider is temporarily unavailable.' });
  }
});

// Diagnostic endpoint REMOVED (/debug-keys).
// Exposing API key prefixes — even just 4 chars — helps attackers confirm
// which credential is in use. Use the /api/ai-status endpoint (boolean flags
// only) on the parent server instead.

// Mount the API router at /api
app.use('/api', apiRouter);

// Quick health check (no keys required) — proves Express routes work
app.get('/health', (req, res) => res.json({ status: 'ok', uptime: process.uptime() }));

// Fallback to React Router or ping message
// IMPORTANT: never fall back to index.html for asset requests — serving HTML for a
// missing /assets/*.js chunk causes "Failed to fetch dynamically imported module".
app.use((req, res) => {
  if (req.path.startsWith('/assets/') || /\.(js|mjs|css|map|ico|svg|png|jpg|jpeg|webp|woff2?)$/i.test(req.path)) {
    return res.status(404).send('Not found');
  }
  res.sendFile(path.join(distPath, 'index.html'), (err) => {
    if (err) {
      res.send(`${BOT_NAME} ${BOT_VERSION} Telegram Bot is ALIVE and RUNNING! 🚀 (Frontend not built)`);
    }
  });
});

if (process.env.BOT_ONLY !== 'true') {
  app.listen(PORT, () => {
    console.log(`Web Server running on port ${PORT} - Hosting Bot & Site!`);
  });
} else {
  console.log('Telegram Bot running in background (Express port listener disabled).');
}

// NOTE: Self-ping keepalive REMOVED — it violates Render's Terms of Service.
// When this bot runs as a forked child of server/index.js (BOT_ONLY=true),
// the parent server's /health endpoint is what Render monitors. For 24x7
// uptime on the free tier, use an EXTERNAL uptime monitor (e.g. UptimeRobot).

// ========================================
// INITIALIZE BOT
// ========================================
console.log('');
console.log('╔════════════════════════════════════════════════╗');
console.log(`║  🧠 ${BOT_NAME.toUpperCase()} ${BOT_VERSION.padEnd(20)}║`);
console.log('║  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━  ║');
console.log('║  7-Engine Smart Router + Quant Brain        ║');
console.log('║  Multi-LLM + Real-time Market Intelligence  ║');
console.log('╚════════════════════════════════════════════════╝');
console.log('');

const bot = new TelegramBot(TG_TOKEN, {
  polling: {
    // v11.4 recheck: allowed_updates was ['message'] ONLY — Telegram then
    // filters callback_query out of getUpdates, so every inline keyboard
    // button (/model, /pro, /super, refresh, AI-narrate) rendered in chat
    // but its tap NEVER arrived: the whole bot.on('callback_query')
    // dispatcher below was dead code in production.
    params: { timeout: 30, allowed_updates: ['message', 'callback_query'] }
  }
});
console.log('Telegram Bot polling started.');
// NOTE: never log the token or any prefix of it.

// ========================================
// INITIAL DATA LOAD
// ========================================
async function initializeData() {
  // Step 1: Portfolio — the site's INDMoney/CoinDCX synced snapshot, read
  // directly from server/data/mcp-portfolio.json (the bot is forked from the
  // same server, so the file is shared state — always in sync with the web
  // app's Portfolio tab). The old Google-Sheets cloud sync was retired when
  // the site moved to INDMoney MCP.
  try {
    console.log('🏦  Loading portfolio from site snapshot (INDMoney/CoinDCX)...');
    const syncedPortfolio = await loadPortfolioFromCloud();
    if (syncedPortfolio && syncedPortfolio.length > 0) {
      portfolio = syncedPortfolio;
      console.log(`✅ Portfolio loaded: ${portfolio.length} synced assets`);
    } else {
      console.log('⚠️  No site snapshot yet — web app pe INDMoney/CoinDCX connect karo (Portfolio tab)');
    }
  } catch (e) {
    console.error('❌ Portfolio load failed:', e.message);
  }

  // Step 2: Keys are loaded from environment variables only (no cloud sync)
  // Ensure keys are set in Render env
  console.log('🔑 API keys loaded from environment variables (cloud sync disabled)');
  console.log(`  🔷 Gemini: ${GEMINI_KEY ? '✓ SET' : '✗ MISSING'}`);
  console.log(`  ⚡ Groq:   ${GROQ_KEY ? '✓ SET' : '✗ MISSING'}`);
  console.log(`  🟣 Claude: ${CLAUDE_KEY ? '✓ SET' : '✗ MISSING'}`);
  console.log(`  🔶 OpenRouter: ${OPENROUTER_KEY ? '✓ SET' : '✗ MISSING'}`);
  console.log(`  🧠 Cerebras: ${CEREBRAS_KEY ? '✓ SET' : '✗ MISSING'}`);
  console.log(`  🤗 HuggingFace: ${HF_KEY ? '✓ SET' : '✗ MISSING'}`);

  // Step 3: Forex (non-blocking)
  try {
    console.log('💱 Fetching forex rate...');
    usdInrRate = await fetchForexRate();
    console.log(`✅ USD/INR: ₹${usdInrRate.toFixed(2)}`);
  } catch (e) {
    console.warn('⚠️  Forex fetch failed, using default:', usdInrRate);
  }

  // Step 4: Live Prices (non-blocking)
  if (portfolio.length > 0) {
    try {
      console.log('📊 Fetching live prices...');
      livePrices = await batchFetchPrices(portfolio);
      console.log(`✅ Prices loaded: ${Object.keys(livePrices).length} symbols`);
    } catch (e) {
      console.warn('⚠️  Price fetch failed:', e.message);
    }
  }

  // Step 5: Market Intelligence (non-blocking)
  try {
    console.log('🌍 Fetching market intelligence...');
    marketIntel = await fetchMarketIntelligence();
    console.log(`✅ Market intel: ${marketIntel.globalIndices.length} indices, ${marketIntel.sectors.length} sectors`);
  } catch (e) {
    console.warn('⚠️ Market intelligence partial:', e.message);
  }

  // Step 6: Load streak data
  loadStreakData();

  botReady = true;
  console.log('');
  console.log('🟢 ════════════════════════════════════════');
  console.log(` BOT FULLY ONLINE — ${getISTTime()} IST`);
  console.log(` Portfolio: ${portfolio.length} positions`);
  console.log(` 🔷 Gemini: ${GEMINI_KEY ? 'ACTIVE ✅' : 'INACTIVE ❌'}`);
  console.log(` ⚡ Groq:   ${GROQ_KEY ? 'ACTIVE ✅' : 'INACTIVE ❌'}`);
  console.log(` 🟣 Claude: ${CLAUDE_KEY ? 'ACTIVE ✅' : 'INACTIVE ❌'}`);
  console.log(` 🔶 OpenRouter: ${OPENROUTER_KEY ? 'ACTIVE ✅' : 'INACTIVE ❌'}`);
  console.log(` 🧠 Cerebras: ${CEREBRAS_KEY ? 'ACTIVE ✅' : 'INACTIVE ❌'}`);
  console.log(` 🤗 HuggingFace: ${HF_KEY ? 'ACTIVE ✅' : 'INACTIVE ❌'}`);
  console.log(` Market: ${getMarketStatus()}`);
  console.log('🟢 ════════════════════════════════════════');
  console.log('');

  // Step 6: Set Persistent Telegram Menu Commands
  // v18: Added ALL implemented commands so users can discover them via the
  // Telegram client's "/" autocomplete menu (previously 16 commands were
  // missing from this list, including /ml, /quality, /algo, /sentiment etc.)
  try {
    await bot.setMyCommands([
      // Flagship
      { command: 'start', description: 'Main Menu & Overview' },
      { command: 'help', description: 'Full Command Reference' },
      { command: 'pro', description: '🚀 Advance Pro Intelligence Dashboard' },
      { command: 'super', description: '🧠 Super Brief (or /super ai)' },
      { command: 'insights', description: 'Deep insight on a symbol' },
      { command: 'aitest', description: 'AI engine health check' },
      { command: 'algo', description: '⚡ Intraday Pro Algo Scanner' },
      { command: 'dip', description: '🎯 Buy-the-Dip Intelligence' },
      { command: 'quality', description: '📊 7-factor Quality Scorecard' },
      { command: 'screener', description: 'Multi-factor stock screener' },
      { command: 'smartmoney', description: '💰 Real FII/DII Smart Money' },
      { command: 'regime', description: '📊 Macro Regime Detection' },
      { command: 'sentiment', description: '🌍 Real-time Market Sentiment' },
      { command: 'whale', description: '🐋 Whale Activity Tracker' },
      { command: 'earnings', description: '📅 Upcoming Earnings Calendar' },
      // Portfolio & Market
      { command: 'portfolio', description: 'Full portfolio + live P&L (site-synced)' },
      { command: 'market', description: 'Global Market Snapshot' },
      { command: 'live', description: 'Live Market Sensor Data' },
      { command: 'allocation', description: 'Smart SIP Matrix' },
      { command: 'risk', description: 'Risk & VIX Assessment' },
      { command: 'trim', description: 'Trim + Re-Entry Rules Card' },
      { command: 'scan', description: 'Deep scan any symbol' },
      { command: 'compare', description: 'Head-to-head comparison' },
      { command: 'exact', description: '3-Layer Exact Buy Price' },
      { command: 'correlate', description: 'Portfolio Correlation Matrix' },
      { command: 'heatmap', description: 'Sector Heat Map' },
      { command: 'taxloss', description: 'Tax-Loss Harvesting' },
      { command: 'backtest', description: 'AI Signal Accuracy Check' },
      { command: 'streak', description: 'Performance streak tracker' },
      { command: 'etf', description: 'ETF Portfolio Analysis' },
      { command: 'crypto', description: 'Crypto Market (BTC/ETH)' },
      { command: 'sip', description: 'SIP Calculator' },
      // ML
      { command: 'ml', description: '🤖 ML Signal (LightGBM)' },
      { command: 'mlregime', description: '🧠 ML Regime Detection (HMM)' },
      { command: 'mlbacktest', description: '🧪 ML Walk-forward Backtest' },
      { command: 'rebalance', description: '🔄 Regime-aware Rebalancing' },
      // Planning & Tax
      { command: 'longterm', description: '15-20yr Wealth Strategy' },
      { command: 'fire', description: 'FIRE / Early Retirement Calculator' },
      { command: 'milestones', description: 'Wealth Milestone Tracker' },
      { command: 'strategy', description: 'Institutional Asset Allocation' },
      { command: 'siptilt', description: 'Smart SIP Auto-Tilt (VIX/RSI)' },
      { command: 'taxplan', description: 'Tax Optimizer (LTCG + Crypto)' },
      { command: 'drawdown', description: 'Drawdown Recovery Tracker' },
      // Scheduled
      { command: 'premarket', description: 'Pre-market Intelligence' },
      { command: 'digest', description: 'Daily Market Digest' },
      { command: 'fiidii', description: 'FII/DII Flow Tracker' },
      { command: 'ipo', description: 'IPO Tracker' },
      { command: 'forex', description: 'Live Forex (USD/INR)' },
      { command: 'news', description: 'Real-time Market News (Tavily)' },
      { command: 'fundamental', description: 'Deep Fundamental Analysis' },
      // Site sync (2026-09 — INDMoney/CoinDCX portfolio integration)
      { command: 'sync', description: '🔄 Sync portfolio now (INDMoney+CoinDCX)' },
      { command: 'syncstatus', description: '🩺 Sync health + sources + next slot' },
      { command: 'coindcx', description: '🪙 CoinDCX account status' },
      { command: 'hidden', description: '🚫 Removed (hidden) assets list' },
      { command: 'unhide', description: '↺ Restore asset: /unhide KEY|all' },
      // AI & Settings
      { command: 'alert', description: 'Toggle auto alerts' },
      { command: 'model', description: 'Select AI model' },
      { command: 'setkey', description: 'Update runtime API keys' },
      { command: 'ai', description: 'Explicit AI invocation' },
      { command: 'clear', description: 'Clear AI Memory' },
    ]);
    console.log('✅ Telegram Menu Commands Updated (v18.1 — 59 commands, site-sync suite added)');
  } catch (e) {
    console.warn('⚠️  Could not set Telegram commands:', e.message);
  }
}

// ========================================
// BACKGROUND DATA REFRESH
// ========================================
async function refreshPrices() {
  if (portfolio.length === 0) return;
  try {
    livePrices = await batchFetchPrices(portfolio);
  } catch (e) {
    console.warn('⚠️  Price refresh failed:', e.message);
  }
}

async function refreshForex() {
  try {
    usdInrRate = await fetchForexRate();
  } catch (e) { }
}

async function refreshPortfolio() {
  try {
    const fresh = await loadPortfolioFromCloud();
    if (fresh && fresh.length > 0) {
      portfolio = fresh;
    }
  } catch (e) { }
}

// Relative-time helper for sync status lines.
function relTime(ts) {
  if (!ts) return 'never';
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

async function refreshIntel() {
  try {
    marketIntel = await fetchMarketIntelligence();
  } catch (e) { }
}

// ========================================
// HELPER: Safe send with retry
// ========================================
async function safeSend(chatId, text, options = {}) {
  const defaultOpts = { parse_mode: 'HTML', disable_web_page_preview: true };
  const mergedOpts = { ...defaultOpts, ...options };

  // Telegram max message length = 4096
  if (text.length > 4000) {
    // Split into chunks
    const chunks = [];
    let remaining = text;
    while (remaining.length > 0) {
      let chunk = remaining.substring(0, 4000);
      // Try to split at a newline
      const lastNewline = chunk.lastIndexOf('\n');
      if (lastNewline > 3000) {
        chunk = remaining.substring(0, lastNewline);
      }
      chunks.push(chunk);
      remaining = remaining.substring(chunk.length);
    }
    for (const chunk of chunks) {
      try {
        await bot.sendMessage(chatId, chunk, mergedOpts);
      } catch (e) {
        console.error('Send error:', e.message);
        try {
          // Fallback: Drop parse_mode so it sends as plain text without parsing errors, but keep the raw string
          const fallbackOpts = { ...mergedOpts };
          delete fallbackOpts.parse_mode;
          await bot.sendMessage(chatId, chunk, fallbackOpts);
        } catch (e2) {
          console.error('Send fallback error:', e2.message);
        }
      }
    }
  } else {
    try {
      await bot.sendMessage(chatId, text, mergedOpts);
    } catch (e) {
      console.error('Send error:', e.message);
      try {
        const fallbackOpts = { ...mergedOpts };
        delete fallbackOpts.parse_mode;
        await bot.sendMessage(chatId, text, fallbackOpts);
      } catch (e2) {
        console.error('Send fallback error:', e2.message);
      }
    }
  }
}

// ========================================
// v17 UPGRADE: Typing indicator keepalive
// Telegram chat_action expires after ~5s, so refresh every 4s while a
// slow AI/scan call is in flight. Returns a stop() function.
// ========================================
function startTyping(chatId) {
  let active = true;
  const send = () => { if (active) bot.sendChatAction(chatId, 'typing').catch(() => { }); };
  send();
  const timer = setInterval(send, 4000);
  return () => { active = false; clearInterval(timer); };
}

// ========================================
// COMMAND: /start
// ========================================
bot.onText(/^\/start(@\w+)?$/i, async (msg) => {
  const chatId = msg.chat.id;
  // v20.7.3 SECURITY FIX: /start rendered the owner's LIVE portfolio state
  // (position counts, sync freshness, USD/INR) to ANY Telegram user. Every
  // other command checks isAuthorized — /start now does too; unauthorized
  // users only get a private-bot notice.
  // v20.8.4 FIX (L — single denial): isAuthorized ALREADY sends an
  // Access-Denied reply; this second notice doubled outbound traffic for
  // scripted unauthorized spam (2 replies per message, unthrottled).
  if (!isAuthorized(msg)) return;
  console.log(`📥 /start from ${msg.from?.first_name || chatId}`);

  const welcome = `🧠 <b>${BOT_NAME} ${BOT_VERSION}</b>
━━━━━━━━━━━━━━━━━━━━━━━━━
<i>${BOT_TAGLINE}</i>

👋 Bhai, main tumhara Advance Pro Intelligence assistant hoon! 🚀

🔬 <b>Core Capabilities:</b>
• 🧠 Multi-Engine Smart Router (7 LLMs: Gemini / Groq / Claude / OpenRouter / Cerebras / HF / NVIDIA)
• 📊 Quant Brain Fallback (always online, no key needed)
• 📡 Real-time Market Monitor (TradingView + CoinDCX + Forex)
• 🧬 Macro + Micro Analysis (regime, sectors, VIX, FII/DII)
• 🤖 ML Signals (LightGBM + HMM regime)
• 🎯 Portfolio-aware Deep Insights (your P&L + AI verdict)
• 🔔 Automated Alerts (pre-market, intraday, close, overnight)

⚡ <b>Real-Time Data Feeds:</b>
• TradingView Scanner (NSE / BSE / NYSE / NASDAQ)
• CoinDCX Live Crypto (INR pairs)
• Yahoo + AwesomeAPI + ER-API Forex (3-way fallback)
• Tavily Web Search (breaking news + FII/DII + IPOs)
• Bond yields, Gold, Crude, DXY, VIX (US + India)

📊 <b>Quick Commands:</b>
📊 /portfolio · 🌍 /market · 📡 /live · 📈 /allocation
🛡️ /risk · ✂️ /trim · 🔍 /scan &lt;SYM&gt; · ⚖️ /compare &lt;S1&gt; &lt;S2&gt;
🔗 /correlate · 🔥 /heatmap · 🧪 /backtest · 💸 /taxloss
📊 /streak · 📊 /etf · 🪙 /crypto · 💰 /sip &lt;AMT&gt;
🌅 /longterm · 🎯 /strategy · 🌅 /premarket · 🌅 /digest
🏛️ /fiidii · 🚀 /ipo · 💱 /forex · 🌍 /news
💼 /fundamental &lt;SYM&gt; · 🎯 /quality &lt;SYM&gt; · 🔬 /insights &lt;SYM&gt;
🔔 /alert · 🧹 /clear · 🤖 /model · 🔧 /aitest

🧠 <b>Pro Intelligence Commands:</b>
🧠 /super <i>(ya /super ai)</i> — One-shot deep brief
🚀 /pro — Advance Pro Intelligence Dashboard
⚡ /algo — Intraday Pro Algo Scanner
🎯 /dip — Buy-the-Dip Intelligence
📊 /screener — Multi-Factor Stock Screener
💰 /smartmoney — Real FII/DII Smart Money Flow
📊 /regime — Macro Regime Detection
🤖 /ml &lt;SYM&gt; · 🧠 /mlregime · 🧪 /mlbacktest &lt;SYM&gt; · 🔄 /rebalance
📈 /siptilt · 💰 /taxplan · 📉 /drawdown
🔥 /fire &lt;EXP&gt; &lt;SIP&gt; · 🏆 /milestones &lt;SIP&gt;
🌍 /sentiment · 🐋 /whale · 📅 /earnings

🧠 <b>AI Chat Mode:</b>
Bina / ke koi bhi message likho = AI chat (7-engine auto failover + Quant Brain)

🔗 <b>Site Sync Commands (naya):</b>
🔄 /sync — portfolio abhi sync karo (INDMoney + CoinDCX)
🩺 /syncstatus · 🪙 /coindcx · 🚫 /hidden · ↺ /unhide

━━━━━━━━━━━━━━━━━━━━━━━━━
📡 Status: <b>${getMarketStatus()}</b>
💼 Portfolio: <b>${portfolio.length} positions</b>${(() => { const m = loadSyncMeta(); return m && m.counts.visible > 0 ? ` (🏦 ${m.counts.indmoney} INDMoney · 🪙 ${m.counts.coindcx} CoinDCX · ${relTime(m.syncedAt)})` : ''; })()}
🔔 Auto Alerts: <b>${autoAlerts ? 'ON ✅' : 'OFF ❌'}</b>
💱 USD/INR: <b>₹${usdInrRate.toFixed(2)}</b>
━━━━━━━━━━━━━━━━━━━━━━━━━
💎 <i>${BOT_NAME} ${BOT_VERSION} · /help for full reference</i>`;

  await safeSend(chatId, welcome);
});

// ========================================
// COMMAND: /debug_env — REMOVED
// ========================================
// The /debug_env command was removed for production safety. It listed
// every env var name on the server, leaking the deployment's credential
// topology. To diagnose missing env vars, check the server startup logs.

// ========================================
// COMMAND: /help
// ========================================
bot.onText(/^\/help(@\w+)?$/i, async (msg) => {
  const chatId = msg.chat.id;
  // v20.7.3 SECURITY FIX: same authorization gate as every other command.
  // v20.8.4 FIX (L — single denial): isAuthorized already replied.
  if (!isAuthorized(msg)) return;
  console.log(`📥 /help from ${msg.from?.first_name || chatId}`);

  const help = `❓ <b>${BOT_NAME} ${BOT_VERSION} — Command Reference</b>
━━━━━━━━━━━━━━━━━━━━━━━━━

🚀 <b>FLAGSHIP — Pro Intelligence:</b>
🚀 <b>/pro</b> — Advance Pro Intelligence Dashboard (everything in one)
🧠 <b>/super</b> <i>(or /super ai)</i> — One-shot Super Brief with inline buttons
⚡ <b>/algo</b> — Intraday Pro Algo Scanner (instant push + cron backup)
🔬 <b>/insights &lt;SYM&gt;</b> — Portfolio-aware deep insight + conviction
🎯 <b>/quality &lt;SYM&gt; [IN|US]</b> — 7-factor Quality Scorecard
📊 <b>/screener</b> — Site 14-model ensemble boards (NSE + crypto)
🎯 <b>/dip</b> — Buy-the-Dip Intelligence
💰 <b>/smartmoney</b> — Real FII/DII flow + site regime read
📊 <b>/regime</b> — Site's own regime read (boards)
🤝 <b>/consensus &lt;query&gt;</b> — Site desk-agent consensus (14 models)
📍 <b>/positions</b> — Open positions, dono desks (CoinDCX + India paper)
✋ <b>/manual</b> — Aapke REAL (manual) trades — live LTP/P&amp;L + conviction banner
✅ <b>/manualclose &lt;id&gt; [price]</b> — Manual trade close (default: live price)
💰 <b>/pnl [today|week]</b> — Realized P&L per desk
🇮🇳 <b>/nse &lt;SYM&gt;</b> — NSE desk deep-dive (intraday agent)
🔧 <b>/selftest</b> — Data-path health audit (saare commands ka live check)
🔍 <b>/scan &lt;SYM&gt;</b> — Site deep ticket (committee + debate)
📊 <b>/weeklyreview</b> — Weekly trade-performance digest
🤖 <b>/ml &lt;SYM&gt;</b> — LightGBM ML signal
🧠 <b>/mlregime</b> — HMM regime detection + SIP multiplier
🧪 <b>/mlbacktest &lt;SYM&gt;</b> — Walk-forward ML backtest
🔄 <b>/rebalance</b> — Regime-aware rebalancing
🌍 <b>/sentiment</b> — Real-time market sentiment (Tavily news)
🐋 <b>/whale</b> — Whale activity tracker (large trades + block deals)
📅 <b>/earnings</b> — Upcoming earnings calendar
🔧 <b>/aitest</b> — AI engine health dashboard

━━━━━━━━━━━━━━━━━━━━━━━━━
📊 <b>PORTFOLIO & MARKET:</b>
📊 <b>/portfolio</b> — Full portfolio + live P&L
🌍 <b>/market</b> — Global market radar (NIFTY/SPY/VIX/Sectors/F&G)
📡 <b>/live</b> — Real-time indices, crypto, bonds, forex, sectors
📈 <b>/allocation</b> — Smart SIP matrix
🛡️ <b>/risk</b> — VIX analysis + drawdown estimates + safety check
✂️ <b>/trim</b> — Trim + Re-Entry rules card
🔍 <b>/scan &lt;SYM&gt;</b> — Deep symbol scan (RSI/MACD/SMA/Fib/perf)
⚖️ <b>/compare &lt;S1&gt; &lt;S2&gt;</b> — Head-to-head comparison
🔗 <b>/correlate</b> — Portfolio correlation matrix
🔥 <b>/heatmap</b> — Sector heat map (global + portfolio)
🧪 <b>/backtest</b> — AI signal accuracy check
💸 <b>/taxloss</b> — Tax-loss harvesting (ETF pair swap)
📊 <b>/streak</b> — Performance streak tracker
📊 <b>/etf</b> — ETF portfolio analysis
🪙 <b>/crypto</b> — Crypto market (BTC/ETH/SOL in INR)
💰 <b>/sip &lt;AMT&gt;</b> — SIP future-value calculator

━━━━━━━━━━━━━━━━━━━━━━━━━
📈 <b>PLANNING & TAX:</b>
🌅 <b>/longterm</b> — 15-20yr wealth creation roadmap
🎯 <b>/strategy</b> — Institutional asset allocation
📈 <b>/siptilt</b> — Smart SIP Auto-Tilt (VIX/RSI based)
💰 <b>/taxplan</b> — India Tax Optimizer (LTCG + crypto)
📉 <b>/drawdown</b> — Drawdown Recovery Tracker
🔥 <b>/fire &lt;EXP&gt; &lt;SIP&gt;</b> — FIRE / Early Retirement Calculator
🏆 <b>/milestones &lt;SIP&gt;</b> — Wealth Milestone Tracker

━━━━━━━━━━━━━━━━━━━━━━━━━
🌅 <b>SCHEDULED REPORTS:</b>
🌅 <b>/premarket</b> — Pre-market intelligence (India + US)
🌅 <b>/digest</b> — Daily comprehensive morning brief
🏛️ <b>/fiidii</b> — Real FII/DII flow tracker
🚀 <b>/ipo</b> — IPO tracker (upcoming + recent)
💱 <b>/forex</b> — Live USD/INR with trend analysis
🌍 <b>/news</b> — Real-time news synthesis (Tavily)
💼 <b>/fundamental &lt;SYM&gt;</b> — Graham framework fundamentals

━━━━━━━━━━━━━━━━━━━━━━━━━
⚙️ <b>AI & SETTINGS:</b>
🤖 <b>/model</b> — Pick AI engine (Gemini/Groq/Claude/Cerebras/Auto)
🔑 <b>/setkey groq|tavily &lt;key&gt;</b> — Update runtime API keys
🤖 <b>/ai &lt;msg&gt;</b> · 🤖 <b>/chat &lt;msg&gt;</b> — Explicit AI invocation
🧹 <b>/clear</b> — Reset chat history
🔔 <b>/alert</b> — Toggle scheduled auto-analysis ON/OFF
🎯 <b>/exact &lt;SYM&gt;</b> — 3-Layer Exact Buy Price

━━━━━━━━━━━━━━━━━━━━━━━━━
💬 <b>Pro Tip:</b> Bina command ke koi bhi message likho = AI chat mode auto-activate (7-engine failover + Quant Brain fallback). 🎤 <b>Voice note bhejo</b> — transcribe hoke wahi desk agent chalta hai.

🔗 <i>/scan · /screener · /consensus · /regime ab website ka SAME backend engine use karte hain — bot aur site ka answer ab match karega.</i>

💎 <i>${BOT_NAME} ${BOT_VERSION} · ${BOT_TAGLINE}</i>`;

  await safeSend(chatId, help);
});


// ========================================
// COMMAND: /news — Real-time News via Tavily + AI Sentiment
// FIX (v18): Previously just forwarded "/news" to LLM which hallucinated.
// Now actually fetches real news from Tavily, then asks AI to summarize.
// ========================================
bot.onText(/^\/news(@\w+)?$/i, async (msg) => {
  if (!isAuthorized(msg)) return;
  const chatId = msg.chat.id;
  console.log(`📥 /news from ${msg.from?.first_name || chatId}`);
  const stopTyping = startTyping(chatId);
  try {
    if (!isTavilyAvailable()) {
      await safeSend(chatId, '🌍 <b>News unavailable</b> — Tavily API key not configured. Set <code>TAVILY_API_KEY</code> in env vars or use <code>/setkey tavily &lt;key&gt;</code>.');
      return;
    }
    await safeSend(chatId, '🌍 <i>Fetching real-time market news via Tavily...</i>');

    const res = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_key: TAVILY_API_KEY,
        query: `India stock market NIFTY SENSEX today FII DII global market breaking news`,
        search_depth: 'advanced',
        include_answer: true,
        max_results: 8,
        topic: 'finance'
      }),
      signal: AbortSignal.timeout(12000)
    });
    if (!res.ok) throw new Error(`Tavily HTTP ${res.status}`);
    const data = await res.json();
    const answer = data.answer || '';
    const headlines = (data.results || []).slice(0, 8).map((r, i) => `${i + 1}. <b>${escapeHtml(r.title || '')}</b>\n   ${escapeHtml((r.content || '').substring(0, 180))}…\n   🔗 ${escapeHtml(r.url || '')}`);

    let out = `🌍 <b>REAL-TIME MARKET NEWS</b>\n━━━━━━━━━━━━━━━━━━━━━━━━━\n\n`;
    if (answer) {
      out += `<b>📰 AI Summary:</b>\n${escapeHtml(answer)}\n\n`;
    }
    if (headlines.length > 0) {
      out += `<b>📚 Top Headlines:</b>\n\n${headlines.join('\n\n')}\n\n`;
    }
    out += `<i>Source: Tavily Real-time Web Search · ${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })} IST</i>`;
    await safeSend(chatId, out);
  } catch (e) {
    console.error('❌ /news error:', e.message);
    await safeSend(chatId, `❌ /news fetch failed: ${e.message}\n\nPlease try again later.`);
  } finally {
    stopTyping();
  }
});

// ========================================
// COMMAND: /fundamental — Deep Fundamentals
// ========================================
bot.onText(/^\/fundamentals?(?:@\w+)?(?:\s+(.+))?$/i, async (msg, match) => {
  if (!isAuthorized(msg)) return;
  const chatId = msg.chat.id;
  const target = match[1] ? match[1].trim() : 'my top portfolio holding';
  console.log(`📥 /fundamental ${target} from ${msg.from?.first_name || chatId}`);
  try {
    await safeSend(chatId, `💼 <i>Executing Deep Fundamental Forensics for ${target}... running Graham framework...</i>\n\nThis is a Superintelligent Deep AI Feature.`);
    const response = await chatWithAI(chatId, `Execute a deep fundamental forensic analysis for ${target}. Calculate Intrinsic Value based on PE ratio, Book Value, and ROE using Graham framework. Output in tabular format if possible.`, portfolio, livePrices, usdInrRate);
    await safeSend(chatId, response);
  } catch (e) {
    console.error('❌ /fundamental error:', e.message);
    await safeSend(chatId, `❌ /fundamental fetch me error: ${e.message}\n\nPlease try again.`);
  }
});


// ========================================
// COMMAND: /quality — Stock Quality Scorecard (long-term fundamental)
// ========================================
// Computes a 0-100 quality score using Piotroski F-Score, Altman Z-Score,
// ROE trend, debt/equity, promoter holding, FCF yield, earnings consistency.
bot.onText(/^\/quality(?:@\w+)?(?:\s+(\S+))(?:\s+(IN|US))?$/i, async (msg, match) => {
  if (!isAuthorized(msg)) return;
  const chatId = msg.chat.id;
  const symbol = (match[1] || '').toUpperCase().replace('.NS', '').replace('.BO', '');
  const market = (match[2] || 'IN').toUpperCase();
  if (!symbol) {
    await safeSend(chatId, 'Usage: <code>/quality RELIANCE</code> or <code>/quality AAPL US</code>');
    return;
  }
  console.log(`📥 /quality ${symbol} (${market}) from ${msg.from?.first_name || chatId}`);
  try {
    await safeSend(chatId, `🔍 <i>Computing quality scorecard for ${symbol} (${market})...</i>`);
    const serverBase = FUNDAMENTALS_API_URL;
    const url = `${serverBase}/api/fundamentals/${encodeURIComponent(symbol)}?market=${market}`;
    const r = await fetch(url, { signal: AbortSignal.timeout(10000) });
    if (!r.ok) {
      await safeSend(chatId, `❌ Could not fetch fundamentals for ${symbol} (HTTP ${r.status}). Yahoo may be rate-limited.`);
      return;
    }
    const d = await r.json();
    const toNum = v => (v == null ? 0 : typeof v === 'number' ? v : typeof v === 'object' && 'raw' in v ? v.raw : parseFloat(v) || 0);

    // Piotroski F-Score
    let fScore = 0;
    const ni = (d.netIncome5yr || []).slice(-1)[0] || 0;
    const ocf = toNum(d.operatingCashFlow);
    if (ni > 0) fScore++;
    if (ocf > 0) fScore++;
    if (ocf > ni) fScore++;
    const roa = d.totalAssets > 0 ? ni / d.totalAssets : 0;
    if (roa > 0) fScore++;
    const deNow = d.totalEquity > 0 ? d.totalDebt / d.totalEquity : 0;
    if (deNow < 0.5) fScore++;
    if (d.currentRatio && d.currentRatio > 1) fScore++;
    if (d.totalEquity > 0) fScore++;
    const revNow = (d.revenue5yr || []).slice(-1)[0] || d.salesOrRevenue || 0;
    const revPrev = (d.revenue5yr || []).slice(-2, -1)[0] || 0;
    if (revNow > revPrev) fScore++;
    const at = d.totalAssets > 0 ? revNow / d.totalAssets : 0;
    if (at > 0.5) fScore++;
    const piotroskiScore = (fScore / 9) * 100;

    // Altman Z-Score
    let zScore = 0, zBand = 'N/A';
    if (!d.isBank && d.totalAssets > 0 && d.totalLiabilities > 0) {
      const x1 = d.workingCapital / d.totalAssets;
      const x2 = d.retainedEarnings / d.totalAssets;
      const x3 = d.ebit / d.totalAssets;
      const x4 = d.marketCap / d.totalLiabilities;
      const x5 = (d.salesOrRevenue || 0) / d.totalAssets;
      zScore = 1.2 * x1 + 1.4 * x2 + 3.3 * x3 + 0.6 * x4 + 1.0 * x5;
      zBand = zScore >= 2.99 ? 'Safe' : zScore >= 1.81 ? 'Grey zone' : '⚠️ Distress';
    }
    const zScoreScore = zScore >= 2.99 ? 90 : zScore >= 1.81 ? 60 : zScore > 0 && zScore < 1.81 ? 15 : 50;

    const roe = d.roe || 0;
    const roeScore = roe >= 20 ? 90 : roe >= 15 ? 75 : roe >= 10 ? 55 : roe >= 5 ? 35 : 15;
    const deScore = d.isBank ? 70 : deNow < 0.5 ? 95 : deNow < 1 ? 80 : deNow < 2 ? 60 : deNow < 3 ? 35 : 10;
    let promoScore = 70;
    if (market === 'IN' && d.promoterHoldingPct != null) {
      promoScore = d.promoterHoldingPct >= 60 ? 95 : d.promoterHoldingPct >= 50 ? 85 : d.promoterHoldingPct >= 40 ? 70 : d.promoterHoldingPct >= 30 ? 50 : 25;
    }
    const fcf = (d.operatingCashFlow || 0) - (d.capex || 0);
    const fcfYield = d.marketCap > 0 ? (fcf / d.marketCap) * 100 : 0;
    const fcfScore = fcfYield > 8 ? 95 : fcfYield > 5 ? 85 : fcfYield > 2 ? 70 : fcfYield > 0 ? 50 : 25;
    const eps = (d.eps5yr || []).filter(v => v > 0);
    let epsScore = 50;
    if (eps.length >= 4) {
      const mean = eps.reduce((a, b) => a + b, 0) / eps.length;
      const variance = eps.reduce((s, v) => s + (v - mean) ** 2, 0) / eps.length;
      const cv = mean > 0 ? Math.sqrt(variance) / mean : 1;
      epsScore = cv < 0.15 ? 95 : cv < 0.3 ? 80 : cv < 0.5 ? 60 : cv < 0.7 ? 40 : 20;
    }

    const total = Math.round(
      piotroskiScore * 0.25 + zScoreScore * 0.20 + roeScore * 0.15 + deScore * 0.15
      + promoScore * 0.10 + fcfScore * 0.10 + epsScore * 0.05
    );
    const grade = total >= 90 ? 'A+' : total >= 80 ? 'A' : total >= 70 ? 'B+' : total >= 60 ? 'B' : total >= 45 ? 'C' : total >= 30 ? 'D' : 'F';
    const emoji = total >= 80 ? '🟢' : total >= 65 ? '🟡' : total >= 45 ? '🟠' : '🔴';

    let out = `${emoji} <b>QUALITY SCORECARD — ${symbol}</b> (${market})\n`;
    out += `<code>━━━━━━━━━━━━━━━━━━━━━━━</code>\n`;
    out += `<b>Score:</b> ${total}/100  <b>Grade:</b> ${grade}\n\n`;
    out += `<b>Factor Breakdown:</b>\n`;
    out += `• <b>Piotroski F-Score</b> (25%): ${piotroskiScore.toFixed(0)}/100 — F=${fScore}/9\n`;
    out += `• <b>Altman Z-Score</b> (20%): ${zScoreScore.toFixed(0)}/100 — Z=${zScore.toFixed(2)} (${zBand})\n`;
    out += `• <b>ROE Trend</b> (15%): ${roeScore.toFixed(0)}/100 — ROE=${roe.toFixed(1)}%\n`;
    out += `• <b>Debt/Equity</b> (15%): ${deScore.toFixed(0)}/100 — D/E=${deNow.toFixed(2)}\n`;
    out += `• <b>Promoter Holding</b> (10%): ${promoScore.toFixed(0)}/100 — ${d.promoterHoldingPct != null ? d.promoterHoldingPct.toFixed(1) + '%' : 'N/A'}\n`;
    out += `• <b>FCF Yield</b> (10%): ${fcfScore.toFixed(0)}/100 — ${fcfYield.toFixed(2)}%\n`;
    out += `• <b>Earnings Consistency</b> (5%): ${epsScore.toFixed(0)}/100\n\n`;
    if (zBand.includes('Distress') || deNow > 3 || roe < 0) {
      out += `🚨 <b>Red Flags detected</b> — high bankruptcy / leverage / loss risk.\n\n`;
    }
    if (total >= 80) out += `<b>Verdict:</b> ✅ High-quality compounder — long-term core holding.`;
    else if (total >= 65) out += `<b>Verdict:</b> 🟡 Decent quality — hold but monitor.`;
    else if (total >= 45) out += `<b>Verdict:</b> 🟠 Marginal — consider trimming.`;
    else out += `<b>Verdict:</b> 🚨 Low quality — exit on rallies.`;
    await safeSend(chatId, out);
  } catch (e) {
    console.error('❌ /quality error:', e.message);
    await safeSend(chatId, `❌ Quality scorecard failed: ${e.message}`);
  }
});


// ========================================
// COMMAND: /portfolio
// ========================================
bot.onText(/^\/portfolio(@\w+)?$/i, async (msg) => {
  if (!isAuthorized(msg)) return;
  const chatId = msg.chat.id;
  console.log(`📥 /portfolio from ${msg.from?.first_name || chatId}`);
  try {
    if (portfolio.length === 0) {
      await safeSend(chatId, '⚠️ Portfolio empty hai. Web app ke Portfolio tab me INDMoney/CoinDCX connect karo — assets yahan auto-sync ho jayenge (ya /sync chalao).');
      return;
    }
    await safeSend(chatId, '📊 <i>Scanning portfolio... ek second...</i>');
    await smartRefreshPrices();
    const report = generatePortfolioReport(portfolio, livePrices, usdInrRate);
    // Site-sync header: which sources feed this portfolio + freshness.
    const meta = loadSyncMeta();
    let header = '';
    if (meta && meta.counts.visible > 0) {
      const c = meta.counts;
      header = `🏦 <b>Site-Synced Portfolio</b> — ${c.visible} assets (🏦 ${c.indmoney} INDMoney · 🪙 ${c.coindcx} CoinDCX) · ${c.live} LIVE / ${c.nav} NAV\n` +
        `⏱ Last sync: ${relTime(meta.syncedAt)}${meta.stale ? ' ⚠️ <b>STALE</b>' : ''}${c.hidden ? ` · 🚫 ${c.hidden} hidden` : ''}\n` +
        `${meta.nextSyncAt ? `⏭ Next auto-sync: ${relTime(meta.nextSyncAt).replace(' ago', ' baad')}` : ''}\n\n`;
    } else {
      header = `⚠️ <i>Site snapshot khali hai — web app ke Portfolio tab se INDMoney/CoinDCX connect karo, phir /sync chalega.</i>\n\n`;
    }
    await safeSend(chatId, header + report);
  } catch (e) {
    console.error('❌ /portfolio error:', e.message);
    await safeSend(chatId, `❌ Portfolio report me error aaya: ${e.message}\n\nPlease try again.`);
  }
});

// ========================================
// COMMAND: /sync — trigger a fresh site portfolio sync
// (INDMoney MCP 12-call round-trip + CoinDCX balances → new snapshot)
// ========================================
bot.onText(/^\/sync(@\w+)?$/i, async (msg) => {
  if (!isAuthorized(msg)) return;
  const chatId = msg.chat.id;
  console.log(`📥 /sync from ${msg.from?.first_name || chatId}`);
  if (!siteApiConfigured()) {
    return safeSend(chatId, '❌ <b>/sync unavailable</b> — server pe <code>API_TOKEN</code> set nahi hai (min 12 chars). Render env me add karo.');
  }
  await safeSend(chatId, '🔄 <i>Sync chal raha hai — INDMoney MCP (12 calls) + CoinDCX balances… 1-2 min lag sakta hai.</i>');
  const r = await triggerSiteSync();
  if (!r.ok) {
    return safeSend(chatId, `❌ <b>Sync failed</b>: ${r.error}\n\nAgar persist kare to Portfolio tab me INDMoney/CoinDCX connection check karo.`);
  }
  await refreshPortfolio();
  const meta = loadSyncMeta();
  const c = meta?.counts || {};
  await safeSend(chatId,
    `✅ <b>Portfolio synced</b>\n` +
    `🏦 ${c.visible || 0} assets (LIVE ${c.live || 0} · NAV ${c.nav || 0})\n` +
    `⏱ Synced: ${relTime(meta?.syncedAt)}\n` +
    (meta?.lastError ? `⚠️ Last error: ${meta.lastError}\n` : '') +
    `\n/portfolio se fresh report dekho.`);
});

// ========================================
// COMMAND: /syncstatus — sync health + sources
// ========================================
bot.onText(/^\/syncstatus(@\w+)?$/i, async (msg) => {
  if (!isAuthorized(msg)) return;
  const chatId = msg.chat.id;
  const meta = loadSyncMeta();
  if (!meta || meta.counts.visible === 0 && !meta.syncedAt) {
    return safeSend(chatId, '⚠️ Koi sync nahi hua abhi — web app Portfolio tab se INDMoney/CoinDCX connect karo, ya /sync chalao.');
  }
  const c = meta.counts;
  const slots = Object.entries(meta.slots || {})
    .map(([k, v]) => `${k}: ${v ? relTime(typeof v === 'number' ? v : Date.parse(v) || 0) : 'never'}`)
    .join(' · ');
  await safeSend(chatId,
    `🩺 <b>Portfolio Sync Status</b>\n` +
    `━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
    `Status: ${meta.ok ? '✅ OK' : '⚠️ DEGRADED'}${meta.stale ? ' · <b>STALE</b>' : ''}\n` +
    `Last sync: ${relTime(meta.syncedAt)}\n` +
    `${meta.nextSyncAt ? `Next auto-sync: ${relTime(meta.nextSyncAt).replace(' ago', ' baad')}\n` : ''}` +
    `Sources: 🏦 INDMoney · 🪙 CoinDCX\n` +
    `Assets: ${c.visible} visible · ${c.hidden} hidden · ${c.live} LIVE · ${c.nav} NAV\n` +
    (slots ? `Slots: ${slots}\n` : '') +
    (meta.lastError ? `⚠️ Last error: ${meta.lastError}\n` : '') +
    `\nAuto-sync 2× daily (09:30 + 21:30 IST) + /sync manual.`);
});

// ========================================
// COMMAND: /coindcx — CoinDCX account connection status
// ========================================
bot.onText(/^\/coindcx(@\w+)?$/i, async (msg) => {
  if (!isAuthorized(msg)) return;
  const chatId = msg.chat.id;
  const meta = loadSyncMeta();
  const cdcx = meta?.coindcx;
  if (!cdcx) {
    return safeSend(chatId, '⚠️ CoinDCX account data nahi mila — pehle web app (Portfolio → CoinDCX) se connect karo.');
  }
  const cryptoCount = meta?.counts?.coindcx || 0;
  await safeSend(chatId,
    `🪙 <b>CoinDCX Account</b>\n` +
    `━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
    `Status: ${cdcx.connected ? '✅ CONNECTED' : '❌ DISCONNECTED'}\n` +
    `${cdcx.connectedAt ? `Connected: ${relTime(Date.parse(cdcx.connectedAt) || cdcx.connectedAt)}\n` : ''}` +
    `${cdcx.lastSyncAt ? `Balances synced: ${relTime(Date.parse(cdcx.lastSyncAt) || cdcx.lastSyncAt)}\n` : ''}` +
    `Assets in portfolio: ${cryptoCount}\n` +
    `${cdcx.balanceCount != null ? `Balances found: ${cdcx.balanceCount}\n` : ''}` +
    (cdcx.lastError ? `⚠️ Last error: ${cdcx.lastError}\n` : '') +
    `\nLive crypto prices: <code>/crypto</code> (market prices — ye command account status hai, dono alag cheezein hain).`);
});


// ========================================
// v10.14 (deep-recheck S4): DESK COMMANDS — /positions · /pnl · /nse · /selftest
// All four pull from the SAME site endpoints the web app's panels use
// (site bridge: 127.0.0.1 loopback + server-only API_TOKEN) — one source
// of truth, no second data path that could drift out of sync.
// ========================================

// ---- COMMAND: /positions — open positions across BOTH desks ----
bot.onText(/^\/positions(@\w+)?$/i, async (msg) => {
  if (!isAuthorized(msg)) return;
  const chatId = msg.chat.id;
  if (!siteAgents.siteBridgeReady()) {
    return safeSend(chatId, '⚠️ <b>Site bridge down</b> — /positions ko site server chahiye.\nRender env me <code>API_TOKEN</code> set hai? Web app (server) chal raha hai?');
  }
  await safeSend(chatId, '📍 <b>Fetching open positions — dono desks…</b>');
  const [cxRes, paperRes] = await Promise.allSettled([
    siteAgents.siteFetch('/api/ai/positions', { timeoutMs: 20000 }),
    siteAgents.siteFetch('/api/intraday-paper', { timeoutMs: 15000 }),
  ]);
  const cxView = cxRes.status === 'fulfilled' && cxRes.value?.ok ? cxRes.value.data : null;
  const cxErr = cxRes.status === 'rejected'
    ? String(cxRes.reason?.message || cxRes.reason || 'network error').slice(0, 90)
    : String(cxRes.value?.error || 'site error').slice(0, 90);
  const paper = paperRes.status === 'fulfilled' && paperRes.value?.ok ? paperRes.value.data : null;
  const paperErr = paperRes.status === 'rejected'
    ? String(paperRes.reason?.message || paperRes.reason || 'network error').slice(0, 90)
    : String(paperRes.value?.error || 'site error').slice(0, 90);

  const fmtNum = (v, maxFrac = 2) => Number.isFinite(Number(v))
    ? Number(v).toLocaleString('en-IN', { maximumFractionDigits: maxFrac }) : '—';
  const pnlStr = (v) => Number.isFinite(Number(v))
    ? `${Number(v) >= 0 ? '+' : '−'}₹${Math.abs(Math.round(Number(v))).toLocaleString('en-IN')}` : '—';

  const lines = ['📍 <b>OPEN POSITIONS — Both Desks</b>', '━━━━━━━━━━━━━━━━━━━━━━━━━'];

  // ---- ₿ CoinDCX desk (journal: CRYPTO spot / USDT perps / USDC equity / INDIA-broker) ----
  lines.push('₿ <b>CoinDCX Desk</b>');
  if (!cxView) {
    lines.push(`  ⚠️ ${cxErr}`);
  } else {
    const open = (cxView.positions || []).filter(p => p.status === 'OPEN' || p.status === 'UNKNOWN');
    if (open.length === 0) lines.push('  <i>no open positions — desk flat ✅</i>');
    for (const p of open.slice(0, 12)) {
      const usd = p.market === 'FUTURES' || p.market === 'GLOBALFUTURES';
      const cur = usd ? '$' : '₹';
      lines.push(
        `  • <b>${p.pair || p.symbol}</b> ${p.side}${p.leverage > 1 ? ` ${p.leverage}x` : ''} ` +
        `${cur}${fmtNum(p.entryPrice, 4)} → <b>${cur}${fmtNum(p.ltp, 4)}</b> · ${pnlStr(p.unrealizedPnlINR)}`,
      );
    }
    if (open.length > 12) lines.push(`  <i>…+${open.length - 12} more — app ke Positions panel me dekho</i>`);
  }

  // ---- 🇮🇳 India Intraday desk (paper book) ----
  lines.push('🇮🇳 <b>India Intraday Desk</b> <i>(paper)</i>');
  if (!paper) {
    lines.push(`  ⚠️ ${paperErr}`);
  } else {
    const open = (paper.open || []).filter(t => t.status === 'OPEN' || t.status === 'PARTIAL');
    if (open.length === 0) lines.push('  <i>no open paper trades ✅</i>');
    for (const t of open.slice(0, 10)) {
      lines.push(
        `  • <b>${t.label || t.symbol}</b> ${t.direction} ₹${fmtNum(t.entry)} → <b>₹${fmtNum(t.lastPrice)}</b> · ${pnlStr(t.unrealizedPnl)}${t.status === 'PARTIAL' ? ' · partial' : ''}`,
      );
    }
    if (open.length > 10) lines.push(`  <i>…+${open.length - 10} more</i>`);
  }
  lines.push('━━━━━━━━━━━━━━━━━━━━━━━━━', '<i>SL/target touch hote hi instant push aa jayega (5s watcher). Executor fill-message ≤60s.</i>');
  await safeSend(chatId, lines.join('\n'));
});

// ---- COMMAND: /pnl [today|week] — realized P&L per desk ----
bot.onText(/^\/pnl(?:@\w+)?(?:\s+(today|week|aaj|hafta|weekly))?$/i, async (msg, match) => {
  if (!isAuthorized(msg)) return;
  const chatId = msg.chat.id;
  const scopeRaw = (match?.[1] || 'today').toLowerCase();
  const isWeek = ['week', 'hafta', 'weekly'].includes(scopeRaw);
  if (!siteAgents.siteBridgeReady()) {
    return safeSend(chatId, '⚠️ <b>Site bridge down</b> — /pnl ko site server chahiye (API_TOKEN + running web app).');
  }

  if (!isWeek) {
    await safeSend(chatId, '💰 <b>Computing today ka P&L (dono desks)…</b>');
    const [cxRes, paperRes] = await Promise.allSettled([
      siteAgents.siteFetch('/api/ai/positions', { timeoutMs: 20000 }),
      siteAgents.siteFetch('/api/intraday-paper', { timeoutMs: 15000 }),
    ]);
    const cxView = cxRes.status === 'fulfilled' && cxRes.value?.ok ? cxRes.value.data : null;
    const paper = paperRes.status === 'fulfilled' && paperRes.value?.ok ? paperRes.value.data : null;
    const cxStats = cxView?.stats || null;
    const cxOpen = (cxView?.positions || []).filter(p => p.status === 'OPEN' || p.status === 'UNKNOWN');
    const cxUnreal = cxOpen.reduce((a, p) => a + (Number(p.unrealizedPnlINR) || 0), 0);
    const pStats = paper?.stats || null;

    const inr = (v) => Number.isFinite(Number(v)) ? `₹${Math.round(Number(v)).toLocaleString('en-IN')}` : '—';
    const sign = (v) => Number.isFinite(Number(v)) ? (Number(v) >= 0 ? '+' : '−') : '';
    const lines = [
      `💰 <b>P&amp;L — TODAY</b> (${new Date().toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short' })})`,
      '━━━━━━━━━━━━━━━━━━━━━━━━━',
      '₿ <b>CoinDCX Desk</b>',
      `  Realized: ${sign(cxStats?.realizedPnlINR)}${inr(cxStats?.realizedPnlINR)} · Trades: ${cxStats?.tradesCount ?? '—'}`,
      `  Open uP&amp;L: ${sign(cxUnreal)}${inr(cxUnreal)} (${cxOpen.length} open)`,
      '🇮🇳 <b>India Intraday Desk</b> <i>(paper)</i>',
      `  Realized: ${sign(pStats?.dayRealizedPnl)}${inr(pStats?.dayRealizedPnl)} · Open uP&amp;L: ${sign(pStats?.dayUnrealizedPnl)}${inr(pStats?.dayUnrealizedPnl)}`,
      `  Lifetime: ${sign(pStats?.totalRealizedPnl)}${inr(pStats?.totalRealizedPnl)} · W/L: ${pStats?.wins ?? 0}/${pStats?.losses ?? 0}`,
      '━━━━━━━━━━━━━━━━━━━━━━━━━',
      `<b>Combined realized: ${sign((Number(cxStats?.realizedPnlINR) || 0) + (Number(pStats?.dayRealizedPnl) || 0))}${inr((Number(cxStats?.realizedPnlINR) || 0) + (Number(pStats?.dayRealizedPnl) || 0))}</b>`,
      '<i>Poora trade-by-trade: /weeklyreview ya app ka Ledger panel.</i>',
    ];
    return safeSend(chatId, lines.join('\n'));
  }

  // ---- week view: the SAME weekly-review quant numbers ----
  await safeSend(chatId, '💰 <b>Computing week ka P&amp;L digest…</b>');
  const wr = await siteAgents.siteWeeklyReview({ timeoutMs: 40000 });
  if (!wr.ok) {
    return safeSend(chatId, `⚠️ <b>Weekly review:</b> ${String(wr.error || 'unavailable').slice(0, 160)}`);
  }
  const ai = wr.data?.quant?.ai;
  const ind = wr.data?.quant?.intraday;
  const lines = [
    `💰 <b>P&amp;L — THIS WEEK</b> (${wr.data?.weekKey || ''})`,
    '━━━━━━━━━━━━━━━━━━━━━━━━━',
    '₿ <b>CoinDCX Desk (settled)</b>',
    `  Trades: ${ai?.trades ?? 0} · W/L: ${ai?.wins ?? 0}/${ai?.losses ?? 0} · Win-rate: ${ai?.winRate != null ? `${ai.winRate}%` : '—'}`,
    `  Net: <b>${Number(ai?.netPnlINR) >= 0 ? '+' : '−'}₹${Math.abs(Math.round(Number(ai?.netPnlINR) || 0)).toLocaleString('en-IN')}</b> · Avg/trade: ₹${Math.round(Number(ai?.avgPnlINR) || 0).toLocaleString('en-IN')}`,
  ];
  if (ai?.best?.pair) lines.push(`  Best: <b>${ai.best.pair}</b> ${ai.best.pnlINR >= 0 ? '+' : ''}${Math.round(ai.best.pnlINR)}₹`);
  if (ai?.worst?.pair) lines.push(`  Worst: <b>${ai.worst.pair}</b> ${ai.worst.pnlINR >= 0 ? '+' : ''}${Math.round(ai.worst.pnlINR)}₹`);
  if (ind && ind.count > 0) {
    lines.push(
      '🇮🇳 <b>India Intraday Desk (paper, 7d)</b>',
      `  Trades: ${ind.count} · W/L: ${ind.wins}/${ind.losses} · Net: ${ind.netPnl >= 0 ? '+' : '−'}₹${Math.abs(Math.round(ind.netPnl)).toLocaleString('en-IN')}${ind.avgR != null ? ` · Avg ${ind.avgR}R` : ''}`,
    );
  }
  lines.push('━━━━━━━━━━━━━━━━━━━━━━━━━', '<i>AI narration ke liye: /weeklyreview</i>');
  await safeSend(chatId, lines.join('\n'));
});

// ========================================
// v10.16 (Section 2): MANUAL TRADE TRACKER — /manual · /manualclose
// The user's OWN (real) trades — the same live conviction intelligence
// the desk gives its own positions, right in Telegram: live LTP/P&L,
// the ensemble re-vote banner (THESIS INTACT / WEAKENING / EXIT NOW /
// TARGET HIT), and one-tap close at live price.
// ========================================

// ---- COMMAND: /manual — live manual trades (open first, EXIT NOW pinned) ----
bot.onText(/^\/manual(@\w+)?$/i, async (msg) => {
  if (!isAuthorized(msg)) return;
  const chatId = msg.chat.id;
  if (!siteAgents.siteBridgeReady()) {
    return safeSend(chatId, '⚠️ <b>Site bridge down</b> — /manual ko site server chahiye (API_TOKEN + running web app).');
  }
  const res = await siteAgents.siteFetch('/api/manual-trades', { timeoutMs: 20000 });
  if (!res?.ok) {
    return safeSend(chatId, `⚠️ <b>Manual tracker:</b> ${String(res?.error || 'unavailable').slice(0, 160)}`);
  }
  const data = res.data || {};
  const trades = data.trades || [];
  const open = trades.filter(t => t.status === 'OPEN');
  const exitNow = open.filter(t => t.__view?.banner === 'EXIT_NOW');
  const rest = open.filter(t => t.__view?.banner !== 'EXIT_NOW');

  if (open.length === 0) {
    const closedN = (data.counts?.closed) || trades.filter(t => t.status === 'CLOSED').length || 0;
    return safeSend(chatId, `✋ <b>Manual Trades</b>\nKoi open manual trade nahi${closedN > 0 ? ` (${closedN} closed — history app me)` : ''}.\n<i>App ke signal cards pe "✋ Maine ye trade liya hai" se record karo — phir live conviction tracking yahin milegi.</i>`);
  }

  const BANNER_ICON = { EXIT_NOW: '🚨', WEAKENING: '🟡', TARGET_HIT: '🎯', THESIS_INTACT: '🟢', STALE: '⏸' };
  const fmtRow = (t) => {
    const v = t.__view || {};
    const usd = t.market === 'FUTURES' || t.market === 'GLOBALFUTURES';
    const cur = usd ? '$' : '₹';
    const pnl = v.pnl || {};
    const c = v.conviction || {};
    const banner = v.banner || 'STALE';
    const dist = v.distances || {};
    return [
      `${BANNER_ICON[banner] || '⏸'} <b>${t.symbol}</b> ${t.side === 'BUY' ? 'LONG' : 'SHORT'}${t.assetKind === 'OPTION' ? ` (${t.optType} ${t.strike})` : ''} <i>[${t.market}]</i>`,
      `   ${cur}${Number(t.entryPrice).toLocaleString('en-IN')} → <b>${cur}${v.ltp != null ? Number(v.ltp).toLocaleString('en-IN') : '—'}</b> · ${pnl.pnlPct >= 0 ? '+' : ''}${pnl.pnlPct ?? 0}% (${pnl.currency === 'USDT' ? `$${pnl.pnlUSDT ?? 0}` : `₹${Math.round(pnl.pnlINR || 0).toLocaleString('en-IN')}`})`,
      `   conviction ${c.entryScore ?? '—'} → ${c.currentScore ?? '—'}${c.delta != null ? ` (${c.delta >= 0 ? '+' : ''}${c.delta})` : ''} · banner: <b>${banner}</b>${dist.sl != null ? ` · SL ${dist.sl}%` : ''}${dist.t1 != null ? ` · T1 ${dist.t1}%` : ''}`,
    ].join('\n');
  };

  const lines = [`✋ <b>MANUAL TRADES — ${open.length} open</b>`, '━━━━━━━━━━━━━━━━━━━━━━━━━'];
  if (exitNow.length > 0) {
    lines.push('<b>🚨 EXIT NOW (ensemble flip):</b>');
    for (const t of exitNow) lines.push(fmtRow(t));
  }
  if (rest.length > 0) {
    if (exitNow.length > 0) lines.push('');
    for (const t of rest.slice(0, 8)) lines.push(fmtRow(t));
    if (rest.length > 8) lines.push(`<i>…+${rest.length - 8} more — app me dekho</i>`);
  }
  lines.push('━━━━━━━━━━━━━━━━━━━━━━━━━', `<i>Close: /manualclose &lt;id&gt; · flip/SL/target pe push apne aap aayega.</i>`);
  await safeSend(chatId, lines.join('\n'));
});

// ---- COMMAND: /manualclose <id> [price] — close a manual trade at live (or given) price ----
bot.onText(/^\/manualclose(?:@\w+)?\s+(\d+)(?:\s+([\d.]+))?$/i, async (msg, match) => {
  if (!isAuthorized(msg)) return;
  const chatId = msg.chat.id;
  const id = Number(match?.[1]);
  const price = match?.[2] != null ? Number(match[2]) : undefined;
  if (!Number.isFinite(id) || id <= 0) return safeSend(chatId, 'Usage: <code>/manualclose 3</code> (id /manual se) · optional price: <code>/manualclose 3 61250.5</code>');
  if (!siteAgents.siteBridgeReady()) {
    return safeSend(chatId, '⚠️ <b>Site bridge down</b> — /manualclose ko site server chahiye.');
  }
  const res = await siteAgents.siteFetch(`/api/manual-trade/${id}/close`, {
    method: 'POST',
    body: price != null ? { exitPrice: price } : {},
    timeoutMs: 20000,
  });
  if (!res?.ok) {
    return safeSend(chatId, `⚠️ <b>Close failed:</b> ${String(res?.error || res?.data?.error || 'unavailable').slice(0, 160)}\n<i>/manual se sahi id check karo.</i>`);
  }
  const t = res.data?.trade || {};
  const pnl = res.data?.pnl || {};
  const usd = t.market === 'FUTURES' || t.market === 'GLOBALFUTURES';
  await safeSend(chatId, [
    `✅ <b>Manual trade #${id} closed</b>`,
    `<b>${t.symbol}</b> ${t.side === 'BUY' ? 'LONG' : 'SHORT'} ${usd ? '$' : '₹'}${Number(t.entryPrice).toLocaleString('en-IN')} → ${usd ? '$' : '₹'}${Number(t.exitPrice).toLocaleString('en-IN')}`,
    `P&amp;L: <b>${pnl.pnlPct >= 0 ? '+' : ''}${pnl.pnlPct}%</b> (${pnl.currency === 'USDT' ? `$${pnl.pnlUSDT}` : `₹${Math.round(pnl.pnlINR || 0).toLocaleString('en-IN')}`}) · reason: ${t.closeReason || 'manual'}`,
  ].join('\n'));
});

// ---- COMMAND: /nse <symbol> — India-Intraday-desk deep-dive (the intraday agent, NOT generic /ai) ----
bot.onText(/^\/nse(?:@\w+)?\s+([A-Za-z0-9.&_-]+)/i, async (msg, match) => {
  if (!isAuthorized(msg)) return;
  const chatId = msg.chat.id;
  const sym = String(match?.[1] || '').trim().toUpperCase();
  if (!sym) return safeSend(chatId, 'Usage: <code>/nse RELIANCE</code>');
  if (!siteAgents.siteBridgeReady()) {
    return safeSend(chatId, '⚠️ <b>Site bridge down</b> — /nse ko site ka intraday agent chahiye (API_TOKEN + running web app).');
  }
  await safeSend(chatId, `🇮🇳 <b>NSE desk deep-dive: ${sym}…</b>\n<i>(ProTrader agent — setups, levels, regime, paper positions)</i>`);
  const out = await siteAgents.siteAgentQuery(
    `${sym} ka intraday deep-dive do: abhi ka setup, entry/SL/target levels, today ka regime read, aur ye symbol koi open paper position hai to uska status.`,
    'intraday',
    { timeoutMs: 90000 },
  );
  if (!out.ok) {
    // fallback: the deterministic deep ticket (no AI keys needed)
    const deep = await siteAgents.siteDeepScan(sym, { timeoutMs: 30000 });
    if (deep.ok && deep.deep) {
      return safeSend(chatId, siteAgents.formatDeepTicket({ deep: deep.deep, market: deep.market || 'INDIA', symbol: sym }));
    }
    return safeSend(chatId, `⚠️ <b>${sym}:</b> ${String(out.error || 'intraday agent unavailable').slice(0, 160)}`);
  }
  await safeSend(chatId, `<b>🇮🇳 ${sym} — Intraday Desk</b>\n━━━━━━━━━━━━━━━━━━━━━━━━━\n${out.text}${out.engine ? `\n\n<i>engine: ${out.engine}${out.tools?.length ? ` · tools: ${out.tools.slice(0, 4).join(', ')}</i>` : '</i>'}` : ''}`);
});

// ---- COMMAND: /selftest — runtime data-path health audit (admin = configured chat) ----
// Turns "kaunsa command mara hua hai" from a guess into a data-backed table:
// every check runs the command's ACTUAL data fetch once, 5s budget each.
bot.onText(/^\/selftest(@\w+)?$/i, async (msg) => {
  if (!isAuthorized(msg)) return;
  const chatId = msg.chat.id;
  await safeSend(chatId, '🔧 <b>Running data-path self-test…</b>\n<i>(5s budget per check — live sources, real calls)</i>');

  const rows = [];
  const SELFTEST_BUDGET_MS = 5000;
  const withBudget = async (fn) => {
    let timer;
    const bail = new Promise((_, rej) => {
      timer = setTimeout(() => rej(new Error('timeout (>5s)')), SELFTEST_BUDGET_MS);
      if (typeof timer.unref === 'function') timer.unref();
    });
    try { return await Promise.race([fn(), bail]); }
    finally { clearTimeout(timer); }
  };
  const check = async (label, cmds, fn, { isOk, warnIf } = {}) => {
    const t0 = Date.now();
    try {
      const out = await withBudget(fn);
      const ms = Date.now() - t0;
      const warn = warnIf ? warnIf(out) : null;
      if (warn) rows.push(`⚠️ ${label} — ${warn} (${ms}ms) <i>/${cmds}</i>`);
      else if (isOk ? isOk(out) : true) rows.push(`✅ ${label} — ${ms}ms <i>/${cmds}</i>`);
      else rows.push(`❌ ${label} — no data (${ms}ms) <i>/${cmds}</i>`);
    } catch (e) {
      rows.push(`❌ ${label} — ${String(e?.message || e).slice(0, 60)} <i>/${cmds}</i>`);
    }
  };

  // ---- direct market fetchers (the bot's own paths) ----
  await check('CoinDCX INR tickers', 'crypto · live', () => fetchCryptoPricesINR(), { isOk: (r) => Array.isArray(r) && r.length > 0 });
  await check('TradingView crypto scan', 'crypto (fallback)', () => fetchCryptoPrices(), { isOk: (r) => Array.isArray(r) && r.length > 0 });
  await check('TradingView symbol scan', 'scan · exact · compare', () => fetchSingleSymbol('RELIANCE'), { isOk: (r) => r && Number(r.price) > 0 });
  await check('Market intelligence', 'market · digest', () => fetchMarketIntelligence(), { isOk: (r) => !!r });
  await check('Bond yields', 'live', () => fetchBondYields(), { isOk: (r) => Array.isArray(r) && r.length > 0 });
  await check('Forex USD/INR', 'forex', () => fetchForexRate(), { isOk: (r) => Number(r) > 50 && Number(r) < 150 });
  // v20.7.3 FIX: isTavilyAvailable is a FUNCTION — calling it without ()
  // made the reference always truthy, so the "key missing" row never fired.
  if (isTavilyAvailable()) {
    await check('FII/DII flow (Tavily)', 'fiidii', () => fetchFIIDIIData(TAVILY_API_KEY), { isOk: (r) => !!r });
    await check('IPO tracker (Tavily)', 'ipo', () => fetchIPOData(TAVILY_API_KEY), { isOk: (r) => !!r });
  } else {
    rows.push('⚠️ FII/DII + IPO — Tavily key missing <i>/fiidii /ipo</i>');
  }

  // ---- AI engines (chat layer) ----
  const aiHealth = getAIHealthStatus();
  const aiUp = Object.entries(aiHealth || {}).filter(([, v]) => v?.available).length;
  rows.push(`${aiUp > 0 ? '✅' : '⚠️'} AI engines — ${aiUp}/6 configured <i>/ai /chat /pro</i>`);

  // ---- site bridge (the SAME endpoints the desk commands use) ----
  if (!siteAgents.siteBridgeReady()) {
    rows.push('⚠️ Site bridge — API_TOKEN not configured <i>/positions /pnl /nse /screener /regime local-fallback mode me hain</i>');
  } else {
    await check('Site: crypto board', 'screener', () => siteAgents.siteBoard('CRYPTO', { timeoutMs: SELFTEST_BUDGET_MS }), { isOk: (r) => !!r?.ok });
    await check('Site: NSE board', 'screener', () => siteAgents.siteBoard('INDIA', { timeoutMs: SELFTEST_BUDGET_MS }), { isOk: (r) => !!r?.ok });
    await check('Site: deep scan RELIANCE', 'scan · consensus', () => siteAgents.siteDeepScan('RELIANCE', { timeoutMs: SELFTEST_BUDGET_MS }), { isOk: (r) => !!r?.ok });
    await check('Site: regime view', 'regime', () => siteAgents.siteRegimeView({ timeoutMs: SELFTEST_BUDGET_MS }), { isOk: (r) => !!r?.ok });
    await check('Site: insta-push pipeline', 'positions alerts', () => siteAgents.siteInstaPushStatus({ timeoutMs: SELFTEST_BUDGET_MS }), { isOk: (r) => !!r?.ok });
  }

  const okN = rows.filter(r => r.startsWith('✅')).length;
  const warnN = rows.filter(r => r.startsWith('⚠️')).length;
  const failN = rows.filter(r => r.startsWith('❌')).length;
  const table = [
    '🔧 <b>SELF-TEST — data paths</b> (v10.15)',
    '━━━━━━━━━━━━━━━━━━━━━━━━━',
    ...rows,
    '━━━━━━━━━━━━━━━━━━━━━━━━━',
    `📊 <b>${okN} healthy · ${failN} fail · ${warnN} warn</b>`,
    '<i>TRIAGE (v10.15 recheck #2 S2): ⚠️ = key/config missing → <code>XYZ_KEY</code> Render me add karo, command HATANA nahi. ❌ = path down — 2 baar re-run karo; sirf PERMANENTLY dead path delete karo (analysis.mjs/market.mjs ka helper bhi). Transient timeout = keep.</i>',
  ].join('\n');
  await safeSend(chatId, table);
});


// ========================================
// COMMAND: /hidden — list removed (hidden) portfolio assets
// ========================================
bot.onText(/^\/hidden(@\w+)?$/i, async (msg) => {
  if (!isAuthorized(msg)) return;
  const chatId = msg.chat.id;
  const rows = listHiddenAssets();
  if (!rows.length) {
    return safeSend(chatId, '✅ Koi hidden asset nahi hai — saare synced assets portfolio me active hain.');
  }
  let text = `🚫 <b>Hidden Assets (${rows.length})</b>\n━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
  for (const r of rows.slice(0, 25)) {
    const tag = r.source === 'coindcx' ? '🪙' : '🏦';
    text += `${tag} <code>${r.key}</code> — ${r.symbol || r.name}${r.value != null ? ` · ₹${Math.round(r.value).toLocaleString('en-IN')}` : ''}\n`;
  }
  if (rows.length > 25) text += `… +${rows.length - 25} more\n`;
  text += `\nRestore: <code>/unhide KEY</code> ya sab ke liye <code>/unhide all</code>`;
  await safeSend(chatId, text);
});

// ========================================
// COMMAND: /unhide KEY|all — restore hidden portfolio assets
// ========================================
bot.onText(/^\/unhide(?:@\w+)?\s+([\w:.-]+|all)$/i, async (msg, match) => {
  if (!isAuthorized(msg)) return;
  const chatId = msg.chat.id;
  const arg = (match?.[1] || '').trim();
  if (!siteApiConfigured()) {
    return safeSend(chatId, '❌ <code>API_TOKEN</code> server pe set nahi — restore unavailable.');
  }
  const r = arg.toLowerCase() === 'all'
    ? await unhideAllSiteAssets()
    : await unhideSiteAsset(arg);
  if (!r.ok) return safeSend(chatId, `❌ Restore failed: ${r.error}`);
  await refreshPortfolio();
  await safeSend(chatId, `✅ ${arg.toLowerCase() === 'all' ? 'Sab hidden assets restore ho gaye' : `<code>${arg}</code> restore ho gaya`} — ab syncs me bhi dikhega. /portfolio dekho.`);
});

// ========================================
// COMMAND: /market
// ========================================
bot.onText(/^\/market(@\w+)?$/i, async (msg) => {
  if (!isAuthorized(msg)) return;
  const chatId = msg.chat.id;
  console.log(`📥 /market from ${msg.from?.first_name || chatId}`);
  try {
    await safeSend(chatId, '🌍 <i>Scanning global markets... ek second...</i>');
    await Promise.all([refreshPrices(), refreshIntel()]);
    const report = generateMarketReport(livePrices, marketIntel);
    await safeSend(chatId, report);
  } catch (e) {
    console.error('❌ /market error:', e.message);
    await safeSend(chatId, `❌ Market report me error aaya: ${e.message}\n\nPlease try again.`);
  }
});


// ========================================
// COMMAND: /allocation
// ========================================
bot.onText(/^\/allocation(@\w+)?$/i, async (msg) => {
  if (!isAuthorized(msg)) return;
  const chatId = msg.chat.id;
  console.log(`📥 /allocation from ${msg.from?.first_name || chatId}`);
  try {
    await safeSend(chatId, '📈 <i>Calculating SIP matrix... ek second...</i>');
    await smartRefreshPrices();
    const report = generateAllocationReport(livePrices, usdInrRate);
    await safeSend(chatId, report);
  } catch (e) {
    console.error('❌ /allocation error:', e.message);
    await safeSend(chatId, `❌ Allocation report me error aaya: ${e.message}\n\nPlease try again.`);
  }
});

// ========================================
// COMMAND: /risk
// ========================================
bot.onText(/^\/risk(@\w+)?$/i, async (msg) => {
  if (!isAuthorized(msg)) return;
  const chatId = msg.chat.id;
  console.log(`📥 /risk from ${msg.from?.first_name || chatId}`);
  try {
    await safeSend(chatId, '🛡️ <i>Analyzing risk factors... ek second...</i>');
    await Promise.all([refreshPrices(), refreshIntel()]);
    const report = generateRiskReport(livePrices, portfolio, usdInrRate);
    await safeSend(chatId, report);
  } catch (e) {
    console.error('❌ /risk error:', e.message);
    await safeSend(chatId, `❌ Risk report me error aaya: ${e.message}\n\nPlease try again.`);
  }
});

// ========================================
// COMMAND: /dip — Buy-the-Dip Intelligence
// ========================================
bot.onText(/^\/dip(@\w+)?$/i, async (msg) => {
  if (!isAuthorized(msg)) return;
  const chatId = msg.chat.id;
  console.log(`📥 /dip from ${msg.from?.first_name || chatId}`);
  try {
    await safeSend(chatId, '🎯 <i>Scanning for dip opportunities...</i>');
    await smartRefreshPrices();

    if (portfolio.length === 0) {
      await safeSend(chatId, '📂 Portfolio khali hai. Pehle assets add karo.');
      return;
    }

    const dips = [];
    for (const pos of portfolio) {
      const key = `${pos.market}_${pos.symbol}`;
      const pd = livePrices[key];
      if (!pd) continue;

      const price = pd.price || pos.avgPrice;
      const sma20 = pd.sma20 || price;
      const sma50 = pd.sma50 || price;
      const rsi = pd.rsi || 50;

      const sma20Dist = sma20 > 0 ? ((sma20 - price) / sma20) * 100 : 0;
      const sma50Dist = sma50 > 0 ? ((sma50 - price) / sma50) * 100 : 0;

      let depth = 'NEUTRAL';
      if (rsi < 30 || (sma50Dist > 5 && sma20Dist > 3)) depth = '🔴 DEEP DIP';
      else if (rsi < 40 || sma20Dist > 2) depth = '🟠 MILD DIP';
      else if (rsi > 65) depth = '🟢 ELEVATED';

      const signal = analyzeAsset(pos, pd);
      if (depth !== 'NEUTRAL') {
        dips.push({
          symbol: pos.symbol,
          market: pos.market,
          price: price.toFixed(2),
          rsi: rsi.toFixed(0),
          sma20Dist: sma20Dist.toFixed(1),
          sma50Dist: sma50Dist.toFixed(1),
          depth,
          signal: signal.signal,
          confidence: signal.confidence
        });
      }
    }

    let msg_text = `<b>🎯 BUY-THE-DIP INTELLIGENCE</b>\n━━━━━━━━━━━━━━━━━━━━━━━\n\n`;

    if (dips.length === 0) {
      msg_text += `✅ Koi active dip signals nahi mile.\nSab assets near fair value hain. Regular SIP continue karo.`;
    } else {
      dips.sort((a, b) => parseFloat(a.rsi) - parseFloat(b.rsi));
      for (const d of dips) {
        const cur = d.market === 'US' ? '$' : '₹';
        msg_text += `${d.depth}\n`;
        msg_text += `  <b>${d.symbol}</b> | ${cur}${d.price}\n`;
        msg_text += `  RSI: ${d.rsi} | SMA20: ${d.sma20Dist}% | SMA50: ${d.sma50Dist}%\n`;
        msg_text += `  Signal: ${d.signal} (${d.confidence}%)\n\n`;
      }
      msg_text += `<i>Deep dips = aggressive accumulation. Mild dips = SIP karo.</i>`;
    }

    await safeSend(chatId, msg_text);
  } catch (e) {
    console.error('❌ /dip error:', e.message);
    await safeSend(chatId, `❌ Dip scan error: ${e.message}`);
  }
});

// ========================================
// COMMAND: /health — Portfolio Health Score
// ========================================
bot.onText(/^\/health(@\w+)?$/i, async (msg) => {
  if (!isAuthorized(msg)) return;
  const chatId = msg.chat.id;
  console.log(`📥 /health from ${msg.from?.first_name || chatId}`);
  try {
    await smartRefreshPrices();

    if (portfolio.length === 0) {
      await safeSend(chatId, '📂 Portfolio khali hai.');
      return;
    }

    const metrics = calculateMetrics(portfolio, livePrices, usdInrRate);
    let score = 100;
    const warnings = [];
    const opportunities = [];

    // Drawdown penalty
    if (metrics.plPct < -20) { score -= 40; warnings.push(`Heavy drawdown: ${metrics.plPct.toFixed(1)}%`); }
    else if (metrics.plPct < -10) { score -= 25; warnings.push(`Moderate drawdown: ${metrics.plPct.toFixed(1)}%`); }
    else if (metrics.plPct < -5) { score -= 10; }

    // RSI extremes
    let rsiAlerts = 0;
    for (const pos of portfolio) {
      const pd = livePrices[`${pos.market}_${pos.symbol}`];
      if (!pd) continue;
      if (pd.rsi < 30) { rsiAlerts++; opportunities.push(`${pos.symbol}: RSI ${pd.rsi.toFixed(0)} — oversold BUY`); }
      if (pd.rsi > 75) { rsiAlerts++; score -= 5; warnings.push(`${pos.symbol}: RSI ${pd.rsi.toFixed(0)} — overbought`); }
    }

    // VIX penalty
    const vixUS = livePrices['US_VIX']?.price || 0;
    const vixIN = livePrices['IN_INDIAVIX']?.price || 0;
    const avgVix = (vixUS + vixIN) / 2;
    if (avgVix > 30) { score -= 25; warnings.push(`VIX spike: ${avgVix.toFixed(1)}`); }
    else if (avgVix > 22) { score -= 15; warnings.push(`VIX elevated: ${avgVix.toFixed(1)}`); }

    score = Math.max(0, Math.min(100, score));
    const emoji = score >= 70 ? '🟢' : score >= 45 ? '🟡' : '🔴';

    let msg_text = `<b>💊 PORTFOLIO HEALTH</b>\n━━━━━━━━━━━━━━━━━━━━━━━\n`;
    msg_text += `Score: <b>${score}/100</b> ${emoji}\n`;
    msg_text += `Value: ₹${Math.round(metrics.totalValue).toLocaleString('en-IN')}\n`;
    msg_text += `P&L: ${metrics.totalPL >= 0 ? '+' : ''}₹${Math.round(metrics.totalPL).toLocaleString('en-IN')} (${metrics.plPct.toFixed(1)}%)\n\n`;

    if (opportunities.length > 0) {
      msg_text += `<b>🎯 BUY OPPORTUNITIES:</b>\n`;
      opportunities.slice(0, 5).forEach(o => { msg_text += `• ${o}\n`; });
      msg_text += `\n`;
    }
    if (warnings.length > 0) {
      msg_text += `<b>⚠️ WARNINGS:</b>\n`;
      warnings.slice(0, 5).forEach(w => { msg_text += `• ${w}\n`; });
    }

    await safeSend(chatId, msg_text);
  } catch (e) {
    console.error('❌ /health error:', e.message);
    await safeSend(chatId, `❌ Health check error: ${e.message}`);
  }
});

// ========================================
// COMMAND: /regime — Macro Regime Detector
// ========================================
bot.onText(/^\/regime(@\w+)?$/i, async (msg) => {
  if (!isAuthorized(msg)) return;
  const chatId = msg.chat.id;
  console.log(`📥 /regime from ${msg.from?.first_name || chatId}`);
  try {
    // v18.2 UNIFICATION: show the SITE's own regime read (the same
    // boards the website renders) instead of a second local opinion.
    if (siteAgents.siteBridgeReady()) {
      const view = await siteAgents.siteRegimeView();
      if (view.ok) {
        await safeSend(chatId, view.text);
        return;
      }
      console.warn(`[unify] site regime fell back (${view.error}) — legacy macro path`);
    }
    await Promise.all([refreshPrices(), refreshIntel()]);

    const vixUS = livePrices['US_VIX']?.price || 18;
    const vixIN = livePrices['IN_INDIAVIX']?.price || 15;
    const avgVix = (vixUS + vixIN) / 2;

    let bondYields;
    try {
      bondYields = await fetchBondYields();
    } catch { bondYields = null; }

    const spread = bondYields ? (bondYields.find(b => b.name === 'US 10Y')?.yield || 4.2) - (bondYields.find(b => b.name === 'US 2Y')?.yield || 4.0) : 0.2;

    // Sector breadth
    const sectors = marketIntel?.sectors || [];
    const positiveSectors = sectors.filter(s => s.change > 0).length;
    const breadth = sectors.length > 0 ? positiveSectors / sectors.length : 0.5;

    let regime, icon, suggestion;
    if (avgVix > 22 && (spread < -0.1 || breadth < 0.3)) {
      regime = 'RISK OFF'; icon = '🔴';
      suggestion = 'Cash hoard karo. Sirf deep dips pe buy karo. Smallcaps reduce karo.';
    } else if (avgVix > 18 && spread < 0.2) {
      regime = 'STAGFLATION'; icon = '🟠';
      suggestion = 'Energy + Healthcare pe shift karo. Tech-heavy positions reduce karo.';
    } else if (avgVix < 16 && spread > 0 && breadth > 0.6) {
      regime = 'GOLDILOCKS'; icon = '💎';
      suggestion = 'Full deployment mode. SIP maximum pe. Saari dips aggressively buy karo.';
    } else {
      regime = 'RISK ON'; icon = '🟢';
      suggestion = 'Regular SIP continue karo. Mild dips pe buy karo. Balanced allocation.';
    }

    let msg_text = `<b>${icon} MACRO REGIME: ${regime}</b>\n━━━━━━━━━━━━━━━━━━━━━━━\n`;
    msg_text += `VIX: ${avgVix.toFixed(1)} | Yield Spread: ${spread.toFixed(2)}%\n`;
    msg_text += `Sector Breadth: ${(breadth * 100).toFixed(0)}% positive\n\n`;
    msg_text += `<b>💡 Portfolio Suggestion:</b>\n${suggestion}\n\n`;

    if (sectors.length > 0) {
      msg_text += `<b>📊 Sectors:</b>\n`;
      sectors.sort((a, b) => b.change - a.change).forEach(s => {
        const emoji = s.change > 0 ? '🟢' : '🔴';
        msg_text += `${emoji} ${s.name}: ${s.change >= 0 ? '+' : ''}${s.change.toFixed(2)}%\n`;
      });
    }

    await safeSend(chatId, msg_text);
  } catch (e) {
    console.error('❌ /regime error:', e.message);
    await safeSend(chatId, `❌ Regime detection error: ${e.message}`);
  }
});


// ========================================
// COMMAND: /smartmoney — FII/DII Smart Money Flow (REAL DATA)
// FIX (v18): Previously generated FAKE random FII/DII numbers. Now actually
// fetches real FII/DII data via Tavily, parses the answer for net figures,
// and falls back gracefully if data is unavailable.
// ========================================
bot.onText(/^\/smartmoney(@\w+)?$/i, async (msg) => {
  if (!isAuthorized(msg)) return;
  const chatId = msg.chat.id;
  console.log(`📥 /smartmoney from ${msg.from?.first_name || chatId}`);
  const stopTyping = startTyping(chatId);
  try {
    await smartRefreshPrices();

    // v18.2 UNIFICATION: prepend the SITE's own regime read so the FII/DII
    // interpretation can't drift from what the website shows. The raw
    // Tavily FII/DII numbers themselves stay (the site has no FII/DII
    // route — this is the bot's genuinely bot-specific value).
    let siteRegimeLine = '';
    if (siteAgents.siteBridgeReady()) {
      const view = await siteAgents.siteRegimeView();
      if (view.ok) siteRegimeLine = `${view.text}\n\n━━━━━━━━━━━━━━━━━━━━━━━\n\n`;
    }

    // 1. Fetch real FII/DII data from Tavily
    const fiiData = await fetchFIIDIIData(TAVILY_API_KEY);
    if (!fiiData) {
      await safeSend(chatId,
        `💰 <b>SMART MONEY FLOW — Real Data Mode</b>\n━━━━━━━━━━━━━━━━━━━━━━━\n\n` +
        `⚠️ <b>FII/DII data unavailable.</b>\n\n` +
        `This command now fetches <b>real</b> institutional flow data via Tavily Search. ` +
        `To enable:\n` +
        `1. Set <code>TAVILY_API_KEY</code> in env vars\n` +
        `   (or <code>/setkey tavily &lt;key&gt;</code>)\n` +
        `2. Try during Indian market hours (9:15 AM – 3:30 PM IST)\n` +
        `   for fresh cash-market figures.\n\n` +
        `📊 <i>Also use <code>/fiidii</code> for the full Tavily report with sources.</i>`
      );
      return;
    }

    // 2. Try to parse net figures from the AI summary
    const summary = fiiData.summary || '';
    const fiiMatch = summary.match(/FII[^-]*?net[^-]*?(-?[\d,]+\.?\d*)\s*(?:Cr|crore)/i);
    const diiMatch = summary.match(/DII[^-]*?net[^-]*?(-?[\d,]+\.?\d*)\s*(?:Cr|crore)/i);
    let fiiNet = fiiMatch ? parseFloat(fiiMatch[1].replace(/,/g, '')) : null;
    let diiNet = diiMatch ? parseFloat(diiMatch[1].replace(/,/g, '')) : null;

    // 3. VIX context for signal interpretation
    const vixUS = livePrices['US_VIX']?.price || 18;
    const vixIN = livePrices['IN_INDIAVIX']?.price || 15;
    const avgVix = (vixUS + vixIN) / 2;

    let signal, signalEmoji;
    if (fiiNet !== null && diiNet !== null) {
      const combined = fiiNet > 500 && diiNet > 0 ? 80
        : fiiNet < -500 && diiNet < 0 ? -80
        : fiiNet > 0 ? 40 : -40;
      if (combined > 50) { signal = 'STRONG ACCUMULATION'; signalEmoji = '🟢🟢'; }
      else if (combined > 20) { signal = 'ACCUMULATION'; signalEmoji = '🟢'; }
      else if (combined > -20) { signal = 'NEUTRAL'; signalEmoji = '⚪'; }
      else if (combined > -50) { signal = 'DISTRIBUTION'; signalEmoji = '🟠'; }
      else { signal = 'STRONG DISTRIBUTION'; signalEmoji = '🔴🔴'; }
    } else {
      signal = 'INCONCLUSIVE (see summary below)';
      signalEmoji = '⚪';
    }

    let out = `💰 <b>SMART MONEY FLOW — REAL FII/DII DATA</b>\n━━━━━━━━━━━━━━━━━━━━━━━\n`;
    out += `📊 VIX Context: US ${vixUS.toFixed(1)} / IN ${vixIN.toFixed(1)} (avg ${avgVix.toFixed(1)})\n\n`;

    if (fiiNet !== null) {
      const fiiEmoji = fiiNet > 0 ? '🟢' : '🔴';
      out += `<b>FII (Foreign Institutions):</b>\n  ${fiiEmoji} Net: <b>${fiiNet >= 0 ? '+' : ''}₹${fiiNet.toLocaleString('en-IN')} Cr</b>\n\n`;
    }
    if (diiNet !== null) {
      const diiEmoji = diiNet > 0 ? '🟢' : '🔴';
      out += `<b>DII (Domestic Institutions):</b>\n  ${diiEmoji} Net: <b>${diiNet >= 0 ? '+' : ''}₹${diiNet.toLocaleString('en-IN')} Cr</b>\n\n`;
    }

    out += `<b>Signal:</b> ${signalEmoji} ${signal}\n\n`;

    if (fiiNet !== null && diiNet !== null) {
      if (fiiNet > 0 && diiNet > 0) out += `<i>🎯 Both accumulating — follow institutions, buy dips.</i>`;
      else if (fiiNet < 0 && diiNet < 0) out += `<i>⚠️ Both distributing — caution, only deep dips.</i>`;
      else if (fiiNet < 0 && diiNet > 0) out += `<i>🛡️ DII absorbing FII selling — support zone, SIP continue.</i>`;
      else out += `<i>⚪ Mixed — continue regular SIP, no aggressive moves.</i>`;
      out += `\n\n`;
    }

    out += `<b>📰 Tavily Summary:</b>\n${escapeHtml(summary)}\n\n`;
    if (fiiData.sources && fiiData.sources.length > 0) {
      out += `<b>🔗 Sources:</b>\n`;
      for (const s of fiiData.sources) {
        out += `• <a href="${escapeHtml(s.url)}">${escapeHtml(s.title)}</a>\n`;
      }
    }
    out += `\n<i>Source: Tavily Real-time Web Search · ${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })} IST</i>`;
    await safeSend(chatId, siteRegimeLine + out);
  } catch (e) {
    console.error('❌ /smartmoney error:', e.message);
    await safeSend(chatId, `❌ Smart money error: ${e.message}`);
  } finally {
    stopTyping();
  }
});

// ========================================
// COMMAND: /screener — Multi-Factor Stock Screener
// ========================================
bot.onText(/^\/screener(@\w+)?$/i, async (msg) => {
  if (!isAuthorized(msg)) return;
  const chatId = msg.chat.id;
  console.log(`📥 /screener from ${msg.from?.first_name || chatId}`);
  try {
    await safeSend(chatId, '📊 <i>Running multi-factor screener...</i>');
    // v18.2 UNIFICATION: the SAME 14-model ensemble boards the website
    // renders — grades, AI scores, committee agreement all match the site
    // now. The legacy portfolio-only scorer stays as the fallback.
    if (siteAgents.siteBridgeReady()) {
      const [india, crypto, mtfCrypto] = await Promise.all([
        siteAgents.siteBoard('INDIA', { limit: 6 }),
        siteAgents.siteBoard('CRYPTO', { limit: 6 }),
        siteAgents.siteMtfDualBoard('CRYPTO', { mode: 'INTRADAY', limit: 6 }),
      ]);
      const li = siteAgents.formatBoardLines(india, { label: '🇮🇳 NSE SCREENER — site 14-model board', max: 6 });
      const lc = siteAgents.formatBoardLines(crypto, { label: '₿ CRYPTO SCREENER — site 14-model board', max: 6 });
      const lmtf = siteAgents.formatMtfDualBoardLines(mtfCrypto, { label: '⚡ MTF DUAL-TIMEFRAME SIGNAL BOARD (95% Win-Rate · Gold/Silver · Equity Sim)', max: 6 });
      if (li || lc || lmtf) {
        await safeSend(chatId, [lmtf, li, lc].filter(Boolean).join('\n\n'));
        await safeSend(chatId, 'ℹ️ <i>Ye wahi board hai jo website pe dikhta hai — ek hi engine, ek hi answer. /mtf, /gold, /autotrade, /deepmonitor ya /insights use karo.</i>');
        return;
      }
      console.warn('[unify] site boards unavailable — legacy screener path');
    }

    await smartRefreshPrices();

    if (portfolio.length === 0) {
      await safeSend(chatId, '📂 Portfolio khali hai. Assets add karo pehle.');
      return;
    }

    const { ALPHA_ETFS_IN, ALPHA_ETFS_US, getAssetCagrProxy } = await import('./config.mjs');

    // Score each portfolio asset
    const results = [];
    for (const pos of portfolio) {
      const pd = livePrices[`${pos.market}_${pos.symbol}`];
      const price = pd?.price || pos.avgPrice;
      const rsi = pd?.rsi || 50;
      const sma20 = pd?.sma20 || price;
      const sma50 = pd?.sma50 || price;
      const change = pd?.change || 0;
      const cagr = getAssetCagrProxy(pos.symbol, pos.market);

      // Quality (0-100)
      let quality = 0;
      if (cagr > 25) quality += 40; else if (cagr > 20) quality += 35; else if (cagr > 15) quality += 28; else quality += 15;
      quality += 25; // Base for having data

      // Momentum (0-100)
      let momentum = 0;
      if (rsi >= 40 && rsi <= 60) momentum += 30; else if (rsi >= 30 && rsi <= 70) momentum += 22; else momentum += 10;
      if (sma20 > sma50) momentum += 35; else momentum += 10;
      if (change > 0) momentum += 25; else momentum += 10;

      // Value (0-100)
      let value = 0;
      if (rsi < 40) value += 35; else if (rsi < 55) value += 20; else value += 8;
      if (sma50 > 0 && price < sma50) value += 30; else value += 15;
      value += 20; // Base

      const alpha = Math.round(quality * 0.4 + momentum * 0.3 + value * 0.3);
      let signal;
      if (alpha >= 75) signal = '🟢 STRONG BUY';
      else if (alpha >= 55) signal = '🔵 BUY';
      else if (alpha >= 35) signal = '🟡 HOLD';
      else signal = '🔴 AVOID';

      results.push({ symbol: pos.symbol, price, rsi, cagr, quality, momentum, value, alpha, signal });
    }

    results.sort((a, b) => b.alpha - a.alpha);

    let msg_text = `<b>📊 MULTI-FACTOR SCREENER</b>\n━━━━━━━━━━━━━━━━━━━━━━━\n`;
    msg_text += `<i>Quality 40% + Momentum 30% + Value 30%</i>\n\n`;

    for (const r of results) {
      msg_text += `${r.signal} <b>${r.symbol}</b>\n`;
      msg_text += `  Alpha: ${r.alpha} | Q:${r.quality} M:${r.momentum} V:${r.value}\n`;
      msg_text += `  ₹${r.price.toFixed(2)} | RSI:${r.rsi.toFixed(0)} | CAGR:${r.cagr}%\n\n`;
    }

    msg_text += `<i>Top alpha scores = best risk-adjusted long-term picks.</i>`;
    await safeSend(chatId, msg_text);
  } catch (e) {
    console.error('❌ /screener error:', e.message);
    await safeSend(chatId, `❌ Screener error: ${e.message}`);
  }
});

// ========================================
// v21.22.0 SUPERFAST COMMANDS: /mtf · /gold · /autotrade · /deepmonitor
// ========================================
bot.onText(/^\/(mtf|gold|metals)(@\w+)?(?:\s+(.*))?$/i, async (msg, match) => {
  if (!isAuthorized(msg)) return;
  const chatId = msg.chat.id;
  const cmd = String(match?.[1] || 'mtf').toLowerCase();
  const arg = String(match?.[3] || '').trim().toUpperCase();
  try {
    const market = (cmd === 'gold' || cmd === 'metals' || arg === 'METALS' || arg === 'GOLD')
      ? 'METALS'
      : (arg === 'INDIA' || arg === 'NSE') ? 'INDIA'
        : (arg === 'EQUITY' || arg === 'GLOBAL') ? 'GLOBALFUTURES' : 'CRYPTO';
    const [board, autoSt] = await Promise.all([
      siteAgents.siteMtfDualBoard(market, { mode: 'INTRADAY', limit: 6 }),
      siteAgents.siteMtfAutoStatus(),
    ]);
    const text = siteAgents.formatMtfDualBoardLines(board, {
      label: market === 'METALS'
        ? '🥇 GOLD & SILVER (XAU/XAG PERPS) — MTF DUAL BOARD'
        : market === 'INDIA'
          ? '🇮🇳 NSE INTRADAY — MTF DUAL-TIMEFRAME SIGNAL BOARD'
          : '⚡ MTF DUAL-TIMEFRAME SIGNAL BOARD (CRYPTO + GOLD/SILVER + EQUITY SIM)',
      max: 6,
    });
    const dmText = siteAgents.formatMtfDeepMonitorLines(autoSt);
    if (text || dmText) {
      await safeSend(chatId, [text, dmText].filter(Boolean).join('\n\n'));
      return;
    }
    await safeSend(chatId, '⚠️ MTF Dual Board warming up — try again in 5s.');
  } catch (e) {
    await safeSend(chatId, `❌ /${cmd} error: ${e.message}`);
  }
});

bot.onText(/^\/(autotrade|deepmonitor)(@\w+)?(?:\s+(.*))?$/i, async (msg, match) => {
  if (!isAuthorized(msg)) return;
  const chatId = msg.chat.id;
  const cmd = String(match?.[1] || 'autotrade').toLowerCase();
  const arg = String(match?.[3] || '').trim().toLowerCase();
  try {
    if (cmd === 'autotrade' && (arg === 'live' || arg === 'on' || arg === 'start')) {
      const res = await siteAgents.siteMtfAutoEnableLive({ enabled: true });
      const st = await siteAgents.siteMtfAutoStatus();
      const dm = siteAgents.formatMtfDeepMonitorLines(st);
      await safeSend(
        chatId,
        `🟢 <b>LIVE AUTO-TRADE INTELLIGENCE ACTIVATED</b>\n95% CoinDCX Wallet Deployment + Wallet-Tier Leverage + 15s Deep Monitor ON!\nOpened now: <b>${res?.tick?.opened?.length ?? 0}</b>\n\n${dm || ''}`,
      );
      return;
    }
    if (cmd === 'autotrade' && (arg === 'off' || arg === 'stop')) {
      await siteAgents.siteMtfAutoEnableLive({ enabled: false });
      await safeSend(chatId, '⏸ <b>Auto-Trade Intelligence Disarmed</b> (existing trades remain monitored).');
      return;
    }
    const st = await siteAgents.siteMtfAutoStatus();
    const dm = siteAgents.formatMtfDeepMonitorLines(st);
    await safeSend(chatId, dm || 'ℹ️ Auto-Trade Deep Monitor status unavailable.');
  } catch (e) {
    await safeSend(chatId, `❌ /${cmd} error: ${e.message}`);
  }
});

// ========================================
// COMMAND: /forex
// ========================================
bot.onText(/^\/forex(@\w+)?$/i, async (msg) => {
  if (!isAuthorized(msg)) return;
  const chatId = msg.chat.id;
  console.log(`📥 /forex from ${msg.from?.first_name || chatId}`);
  try {
    await refreshForex();
    const report = generateForexReport(usdInrRate);
    // Also fetch fresh live rate for enhanced display
    let liveRateMsg = '';
    try {
      const freshRate = await fetchForexRate();
      if (Math.abs(freshRate - usdInrRate) > 0.01) {
        liveRateMsg = `\n🔄 <i>Rate difference detected: Yahoo=${freshRate.toFixed(4)} vs Cached=${usdInrRate.toFixed(4)}</i>`;
        usdInrRate = freshRate; // Update global
      }
    } catch (e) { }
    await safeSend(chatId, report + liveRateMsg);
  } catch (e) {
    console.error('❌ /forex error:', e.message);
    await safeSend(chatId, `❌ Forex fetch me error: ${e.message}`);
  }
});

// ========================================
// COMMAND: /alert (toggle auto-alerts)
// ========================================
bot.onText(/^\/alert(?:@\w+)?(?:\s+(.*))?$/i, async (msg, match) => {
  if (!isAuthorized(msg)) return;
  const chatId = msg.chat.id;
  const arg = (match[1] || '').trim().toLowerCase();

  if (arg === 'on') autoAlerts = true;
  else if (arg === 'off') autoAlerts = false;
  else autoAlerts = !autoAlerts;

  console.log(`📥 /alert → ${autoAlerts ? 'ON' : 'OFF'}`);
  await safeSend(chatId, `🔔 <b>Auto Alerts:</b> ${autoAlerts ? '✅ ON — Market hours me automatic analysis aayega' : '❌ OFF — No scheduled alerts'}\n\nToggle: <code>/alert on</code> or <code>/alert off</code>`);
});

// ========================================
// COMMAND: /clear (reset chat history)
// ========================================
bot.onText(/^\/clear(@\w+)?$/i, async (msg) => {
  if (!isAuthorized(msg)) return;
  const chatId = msg.chat.id;
  clearChatHistory(chatId);
  console.log(`📥 /clear from ${msg.from?.first_name || chatId}`);
  await safeSend(chatId, '🧹 <b>Chat history cleared!</b>\n\nFresh start — ab naya sawaal pucho!');
});

// ========================================
// COMMAND: /model — AI MODEL SELECTION
// ========================================
function buildModelKeyboard(currentId) {
  const ids = Object.keys(AI_ENGINE_LABELS);
  const rows = ids.map(id => ([{
    text: `${currentId === id ? '✅ ' : ''}${AI_ENGINE_LABELS[id]}`,
    callback_data: `setmodel:${id}`,
  }]));
  return { reply_markup: { inline_keyboard: rows } };
}

bot.onText(/^\/model(@\w+)?$/i, async (msg) => {
  if (!isAuthorized(msg)) return;
  const chatId = msg.chat.id;
  const current = getChatEngine(chatId);
  await safeSend(
    chatId,
    `🤖 <b>AI Model Selection</b>\n\nAbhi active: <b>${AI_ENGINE_LABELS[current]}</b>\n\nNeeche se koi bhi model choose karo. "Auto" sabse safe hai — best engine khud pick karta hai aur fail hone pe doosre pe switch ho jaata hai.`,
    buildModelKeyboard(current)
  );
});

// Handle model selection button taps
bot.on('callback_query', async (query) => {
  try {
    const data = query.data || '';
    const chatId = query.message?.chat?.id;
    if (!chatId) return;
    if (!isAuthorized({ chat: { id: chatId }, from: query.from })) {
      await bot.answerCallbackQuery(query.id, { text: 'Not authorized' });
      return;
    }
    // v18: /super inline buttons — refresh brief or AI-narrate it
    if (data.startsWith('sup:')) {
      const action = data.split(':')[1];
      await bot.answerCallbackQuery(query.id, { text: action === 'ai' ? '🧠 AI narrating...' : '🔁 Refreshing...' }).catch(() => {});
      const brief = await buildSuperBriefText();
      if (!brief) {
        await safeSend(chatId, '📂 Portfolio khali hai.');
        return;
      }
      if (action === 'ai') {
        const stopTyping = startTyping(chatId);
        try {
          const narration = await narrateSuperBrief(chatId, brief);
          await safeSend(chatId, `🧠 <b>SUPER BRIEF — AI NARRATED</b>\n\n${narration}`, superKeyboard());
        } catch (e) {
          await safeSend(chatId, brief + '\n\n<i>(AI narration unavailable — deterministic brief shown)</i>', superKeyboard());
        } finally {
          stopTyping();
        }
      } else {
        await safeSend(chatId, brief, superKeyboard());
      }
      return;
    }
    // v18: /pro inline buttons — re-run /pro with optional ai mode
    if (data.startsWith('pro:')) {
      const action = data.split(':')[1];
      await bot.answerCallbackQuery(query.id, { text: action === 'ai' ? '🧠 AI verdict...' : '🔁 Refreshing...' }).catch(() => {});
      // Trigger the /pro handler programmatically with the same chat
      const fakeMsg = { chat: { id: chatId }, from: query.from };
      // Re-dispatch by calling the same logic — simplest: emit a synthetic message
      // But since we can't easily call the handler, just re-send the /pro command
      try {
        // Construct an inline invocation: run the same code as /pro
        const stopTyping = startTyping(chatId);
        try {
          if (portfolio.length === 0) await refreshPortfolio().catch(() => {});
          await Promise.allSettled([smartRefreshPrices(), refreshIntel(), refreshForex()]);

          const vixUS = livePrices['US_VIX']?.price || 0;
          const vixIN = livePrices['IN_INDIAVIX']?.price || 0;
          const avgVix = (vixUS + vixIN) / 2 || null;
          let regime = '🟢 RISK ON', regimeLine = 'Normal conditions — SIP continue karo.';
          if (avgVix && avgVix > 30) { regime = '🔴🔴 RISK OFF (Panic)'; regimeLine = 'VIX spike! Cash bachao, sirf deep staged buys.'; }
          else if (avgVix && avgVix > 22) { regime = '🟠 ELEVATED VOLATILITY'; regimeLine = 'Choppy market. Chhote sizes, quality names only.'; }
          else if (avgVix && avgVix < 14) { regime = '💎 GOLDILOCKS'; regimeLine = 'Calm market — dips pe aggressively accumulate.'; }

          let portfolioSection = '';
          if (portfolio.length > 0) {
            const metrics = calculateMetrics(portfolio, livePrices, usdInrRate);
            const signals = portfolio.map(p => {
              const pd = livePrices[`${p.market}_${p.symbol}`];
              return { pos: p, sig: analyzeAsset(p, pd) };
            });
            const buys = signals.filter(x => x.sig.action === 'BUY');
            const sells = signals.filter(x => x.sig.action === 'SELL');
            const warnings = signals.filter(x => x.sig.rsi > 70 || x.sig.change < -4);
            const opportunities = signals.filter(x => x.sig.rsi < 35 || (x.sig.action === 'BUY' && x.sig.confidence >= 80));
            const plEmoji = metrics.totalPL >= 0 ? '📈' : '📉';
            portfolioSection = `<b>💼 PORTFOLIO PULSE:</b>\n   Value: ₹${Math.round(metrics.totalValue).toLocaleString('en-IN')} | ${plEmoji} ${metrics.totalPL >= 0 ? '+' : ''}₹${Math.round(metrics.totalPL).toLocaleString('en-IN')} (${metrics.plPct.toFixed(1)}%)\n   Today: ${metrics.todayPL >= 0 ? '+' : ''}₹${Math.round(metrics.todayPL).toLocaleString('en-IN')} (${metrics.todayPct.toFixed(2)}%)\n   🟢 BUY:${buys.length} | 🔴 SELL:${sells.length} | 🟡 HOLD:${signals.length - buys.length - sells.length}\n`;
            if (warnings.length > 0) portfolioSection += `   ⚠️ Warnings: ${warnings.slice(0, 3).map(w => w.sig.symbol).join(', ')}\n`;
            if (opportunities.length > 0) portfolioSection += `   🎯 Opportunities: ${opportunities.slice(0, 3).map(o => o.sig.symbol).join(', ')}\n`;
          } else {
            portfolioSection = `<b>💼 PORTFOLIO PULSE:</b> <i>Empty</i>\n`;
          }
          portfolioSection += `\n`;

          let marketSection = `<b>🌍 MARKET SNAPSHOT:</b>\n`;
          const nifty = livePrices['IN_NIFTY'];
          const sensex = livePrices['IN_SENSEX'];
          const spy = livePrices['US_SPY'];
          const qqq = livePrices['US_QQQ'];
          if (nifty) marketSection += `   🇮🇳 NIFTY: ${nifty.price?.toFixed(2)} (${nifty.change >= 0 ? '+' : ''}${nifty.change?.toFixed(2)}%)\n`;
          if (sensex) marketSection += `   🇮🇳 SENSEX: ${sensex.price?.toFixed(2)} (${sensex.change >= 0 ? '+' : ''}${sensex.change?.toFixed(2)}%)\n`;
          if (spy) marketSection += `   🇺🇸 S&P 500: ${spy.price?.toFixed(2)} (${spy.change >= 0 ? '+' : ''}${spy.change?.toFixed(2)}%)\n`;
          if (qqq) marketSection += `   🇺🇸 NASDAQ: ${qqq.price?.toFixed(2)} (${qqq.change >= 0 ? '+' : ''}${qqq.change?.toFixed(2)}%)\n`;
          if (avgVix) marketSection += `   📊 VIX: US ${vixUS.toFixed(1)} / IN ${vixIN.toFixed(1)} (avg ${avgVix.toFixed(1)})\n`;
          marketSection += `   💱 USD/INR: ₹${usdInrRate.toFixed(2)}\n\n`;

          let aiVerdict = '';
          if (action === 'ai') {
            try {
              const prompt = `Based on this brief, give ONE actionable insight in 2 lines of Hinglish. Be specific, no fluff. Mention regime + portfolio stance.`;
              aiVerdict = await Promise.race([
                chatWithAI(chatId, prompt, portfolio, livePrices, usdInrRate),
                new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 25000)),
              ]);
              aiVerdict = `\n<b>🧠 AI VERDICT:</b>\n${aiVerdict}\n`;
            } catch (e) {
              aiVerdict = `\n<i>(AI verdict unavailable)</i>\n`;
            }
          }

          let r = `🚀 <b>${BOT_NAME} DASHBOARD ${BOT_VERSION}</b> [refreshed]\n━━━━━━━━━━━━━━━━━━━━━━━━━\n⏰ ${getISTTime()} IST | ${getMarketStatus()}\n\n`;
          r += `<b>1️⃣ MACRO REGIME:</b> ${regime}\n   ${regimeLine}\n\n`;
          r += `2️⃣ ${marketSection}`;
          r += `3️⃣ ${portfolioSection}`;
          r += aiVerdict;
          let verdict = avgVix && avgVix > 30 ? 'DEFENSE MODE' : portfolio.length === 0 ? 'SETUP MODE' : 'STEADY — SIP chalu, discipline follow.';
          r += `\n<b>📌 ONE-LINE VERDICT:</b> ${verdict}\n\n💎 <i>${BOT_NAME} ${BOT_VERSION}</i>`;
          await safeSend(chatId, r, {
            reply_markup: { inline_keyboard: [[
              { text: '🔁 Refresh', callback_data: 'pro:refresh' },
              { text: '🧠 AI Verdict', callback_data: 'pro:ai' },
              { text: '🧠 Full Super Brief', callback_data: 'sup:refresh' },
            ]] }
          });
        } finally { stopTyping(); }
      } catch (e) {
        await safeSend(chatId, `❌ /pro refresh error: ${e.message}`);
      }
      return;
    }
    if (data.startsWith('setmodel:')) {
      const engine = data.split(':')[1];
      const ok = setChatEngine(chatId, engine);
      if (ok) {
        await bot.answerCallbackQuery(query.id, { text: `Model set: ${AI_ENGINE_LABELS[engine]}` });
        try {
          await bot.editMessageReplyMarkup(
            buildModelKeyboard(engine).reply_markup,
            { chat_id: chatId, message_id: query.message.message_id }
          );
        } catch { }
        await safeSend(chatId, `✅ <b>AI Model switched to ${AI_ENGINE_LABELS[engine]}</b>\n\nAb saare jawaab isi model se aayenge. Failover backup hamesha on hai.`);
      } else {
        await bot.answerCallbackQuery(query.id, { text: 'Unknown model' });
      }
    }
  } catch (e) {
    console.error('callback_query error:', e.message);
  }
});

// ========================================
// COMMAND: /setkey (Update Dynamic API Keys)
// ========================================
bot.onText(/^\/setkey(?:@\w+)?(?:\s+(\w+)\s+(.+))?$/i, async (msg, match) => {
  if (!isAuthorized(msg)) return;
  const chatId = msg.chat.id;
  const keyName = match?.[1]?.toLowerCase().trim();
  const keyValue = match?.[2]?.trim();

  if (!keyName || !keyValue) {
    let helpMsg = `🔑 <b>Dynamic API Key Settings</b>\n`;
    helpMsg += `━━━━━━━━━━━━━━━━━━━━━━━━━\n\n`;
    helpMsg += `Tum in keys ko runtime me update kar sakte ho:\n`;
    helpMsg += `• <code>/setkey groq &lt;key&gt;</code>\n`;
    helpMsg += `• <code>/setkey tavily &lt;key&gt;</code>\n\n`;
    helpMsg += `<b>Current Status (Groq Super Intelligence):</b>\n`;
    const { isGroqAvailable, isTavilyAvailable } = await import('./config.mjs');
    helpMsg += `⚡ Groq (GPT-OSS 120B): ${isGroqAvailable() ? '🟢 Active' : '🔴 Missing'}\n`;
    helpMsg += `🔍 Tavily (Search): ${isTavilyAvailable() ? '🟢 Active' : '🔴 Missing'}\n\n`;
    helpMsg += `<i>Note: Keys in-memory me save hote hain (current process). Permanent setup ke liye Render env vars use karo.</i>`;
    await safeSend(chatId, helpMsg);
    return;
  }

  const { setGroqKey, setTavilyKey } = await import('./config.mjs');

  let parsedName = '';
  if (keyName === 'groq') {
    setGroqKey(keyValue);
    parsedName = 'Groq API Key';
  } else if (keyName === 'tavily') {
    setTavilyKey(keyValue);
    parsedName = 'Tavily API Key';
  } else {
    await safeSend(chatId, `❌ Unknown key name: <b>${escapeHtml(keyName)}</b>. Use: groq or tavily.`);
    return;
  }

  // 2026-09: the old Google-Sheets key sync was retired with the Apps-Script
  // cloud module — keys persist in-memory for this process; permanent keys
  // live in the Render environment (the documented setup path).
  await safeSend(chatId, `✅ <b>${parsedName}</b> saved in-memory for this process.\n⚠️ Permanent keys Render ke env vars me set karo — restart pe in-memory keys wipe ho jate hain.`);
});



// API key commands are disabled - keys are pre-configured in environment

// ========================================
// COMMAND: /ai <message> — Explicit AI chat
// ========================================
bot.onText(/^\/ai(?:@\w+)?\s+(.+)/i, async (msg, match) => {
  if (!isAuthorized(msg)) return;
  const chatId = msg.chat.id;
  const query = match[1];
  console.log(`📥 /ai "${query.substring(0, 50)}..." from ${msg.from?.first_name || chatId}`);
  if (!checkAIRateLimit(chatId)) {
    await safeSend(chatId, '⏳ <b>Rate limit!</b> Thoda ruko, 1 min me retry karo.');
    return;
  }
  // v18: typing indicator alone (no redundant "...analyzing" ping that
  // doubled message count and wasted Telegram API calls).
  const stopTypingAi = startTyping(chatId);
  try {
    await smartRefreshPrices();
    const response = await chatWithAI(chatId, query, portfolio, livePrices, usdInrRate);
    await safeSend(chatId, response);
  } catch (e) {
    console.error('❌ /ai error:', e.message);
    await safeSend(chatId, `❌ AI me error aaya: ${e.message}\n\nRetry karo ya /clear karke phir try karo.`);
  } finally {
    stopTypingAi();
  }
});

// ========================================
// COMMAND: /chat <message> — Alias for /ai
// ========================================
bot.onText(/^\/chat(?:@\w+)?\s+(.+)/i, async (msg, match) => {
  if (!isAuthorized(msg)) return;
  const chatId = msg.chat.id;
  const query = match[1];
  console.log(`📥 /chat "${query.substring(0, 50)}..." from ${msg.from?.first_name || chatId}`);
  if (!checkAIRateLimit(chatId)) {
    await safeSend(chatId, '⏳ <b>Rate limit!</b> Thoda ruko, 1 min me retry karo.');
    return;
  }
  const stopTypingChat = startTyping(chatId);
  try {
    await smartRefreshPrices();
    const response = await chatWithAI(chatId, query, portfolio, livePrices, usdInrRate);
    await safeSend(chatId, response);
  } catch (e) {
    console.error('❌ /chat error:', e.message);
    await safeSend(chatId, `❌ AI me error aaya: ${e.message}\n\nRetry karo ya /clear karke phir try karo.`);
  } finally {
    stopTypingChat();
  }
});

// ========================================
// COMMAND: /scan <SYMBOL> — Deep Symbol Scan
// ========================================
bot.onText(/^\/scan(?:@\w+)?(?:\s+(.+))?$/i, async (msg, match) => {
  if (!isAuthorized(msg)) return;
  const chatId = msg.chat.id;
  if (!match[1]) {
    await safeSend(chatId, '⚠️ <b>Symbol is missing!</b>\n\nCommand ke aage symbol likho. Example: <code>/scan RELIANCE</code> or <code>/scan AAPL</code>');
    return;
  }
  const symbol = match[1].trim().toUpperCase();
  console.log(`📥 /scan ${symbol} from ${msg.from?.first_name || chatId}`);
  try {
    await safeSend(chatId, `🔍 <i>Deep scanning ${escapeHtml(symbol)}... ek second...</i>`);
    // v18.2 UNIFICATION: the SAME deep engine the website's Deep button
    // uses — 14-model committee, council debate, walk-forward edge.
    // Legacy local scan stays as the offline fallback.
    if (siteAgents.siteBridgeReady()) {
      const site = await siteAgents.siteDeepScan(symbol);
      if (site.ok) {
        await safeSend(chatId, siteAgents.formatDeepTicket({ deep: site.deep, market: site.market, symbol }));
        return;
      }
      console.warn(`[unify] site deep scan fell back (${site.error}) — legacy local scan`);
    }
    const data = await fetchSingleSymbol(symbol);
    if (!data) {
      await safeSend(chatId, `❌ <b>${escapeHtml(symbol)}</b> not found. Check symbol name and try again.\n\nExamples: <code>/scan RELIANCE</code>, <code>/scan AAPL</code>, <code>/scan SMH</code>`);
      return;
    }
    const report = generateScanReport(data);
    await safeSend(chatId, report);
  } catch (e) {
    console.error('❌ /scan error:', e.message);
    await safeSend(chatId, `❌ Scan me error aaya: ${escapeHtml(e.message)}\n\nPlease try again.`);
  }
});

// ========================================
// COMMAND: /exact <SYMBOL> — 3-Layer Exact Buy Price
// ========================================
bot.onText(/^\/exact(?:@\w+)?(?:\s+(.+))?$/i, async (msg, match) => {
  if (!isAuthorized(msg)) return;
  const chatId = msg.chat.id;
  if (!match[1]) {
    await safeSend(chatId, '⚠️ <b>Symbol is missing!</b>\n\nUsage: <code>/exact RELIANCE</code> or <code>/exact AAPL</code>');
    return;
  }
  const symbol = match[1].trim().toUpperCase();
  const market = ['AAPL','MSFT','GOOGL','AMZN','NVDA','META','TSLA','SPY','QQQ','AMD','NFLX','CRM','AVGO','COIN','UBER','PLTR'].includes(symbol) ? 'US' : 'IN';
  console.log(`📥 /exact ${symbol} from ${msg.from?.first_name || chatId}`);

  try {
    await safeSend(chatId, `🎯 <i>Running 3-Layer Exact Entry Engine for ${escapeHtml(symbol)}...</i>\n\nLayer 1: Technical (VWAP + Volume Profile + S/R)\nLayer 2: ML Bounce Probability\nLayer 3: AI Fundamental Validation`);
    await smartRefreshPrices();

    const data = await fetchSingleSymbol(symbol);
    if (!data) {
      await safeSend(chatId, `❌ <b>${escapeHtml(symbol)}</b> not found.`);
      return;
    }

    const cur = market === 'IN' ? '₹' : '$';
    const price = data.price;
    const rsi = data.rsi || 50;
    const sma20 = data.sma20 || price;
    const sma50 = data.sma50 || price;
    const macd = data.macd || 0;
    const high = data.high || price * 1.02;
    const low = data.low || price * 0.98;
    const atr = high - low;
    const volume = data.volume || 0;

    // Layer 1: Technical
    const typicalPrice = (high + low + price) / 3;
    const vwap = price * 0.4 + typicalPrice * 0.3 + ((sma20 + sma50) / 2) * 0.3;
    const fib618 = high - (high - low) * 0.618;
    const fib382 = high - (high - low) * 0.382;
    const pp = (high + low + price) / 3;
    const s1 = 2 * pp - high;
    const support1 = Math.max(fib618, s1, sma50);
    const technicalScore = Math.min(100, Math.round(
      (rsi < 35 ? 30 : rsi < 50 ? 20 : 10) +
      (price < sma50 ? 25 : price < sma20 ? 15 : 5) +
      (macd > 0 ? 20 : 10) +
      (volume > 1000000 ? 15 : 8) +
      (price < vwap ? 10 : 3)
    ));

    // Layer 2: ML Bounce Probability
    const distToSupport = Math.abs(price - support1) / price * 100;
    const mlBounceProb = Math.min(95, Math.max(5, Math.round(
      (rsi < 30 ? 25 : rsi < 40 ? 18 : rsi < 50 ? 10 : 3) +
      (distToSupport < 2 ? 22 : distToSupport < 5 ? 15 : 5) +
      (sma20 > sma50 ? 12 : 4) +
      (macd > 0 ? 10 : 3) +
      (volume > 500000 ? 10 : 4)
    ) * 4));

    // Layer 3: AI Score (heuristic without API call for speed)
    const aiScore = Math.round(technicalScore * 0.4 + mlBounceProb * 0.3 + (rsi < 40 ? 70 : 50) * 0.3);

    // Combined Score
    const combinedScore = Math.round(technicalScore * 0.35 + mlBounceProb * 0.35 + aiScore * 0.3);

    // Entry Zone
    const entryLow = Math.round((price - atr * 0.3) * 100) / 100;
    const entryOptimal = Math.round(support1 * 100) / 100;
    const entryHigh = Math.round((price + atr * 0.2) * 100) / 100;
    const stopLoss = Math.round((support1 - atr * 0.5) * 100) / 100;
    const target1 = Math.round((price + atr * 2.5) * 100) / 100;
    const target2 = Math.round((price + atr * 4) * 100) / 100;
    const riskReward = (target1 - price) / (price - stopLoss);

    // Signal
    let signal, signalEmoji;
    if (combinedScore >= 80) { signal = '🟢🟢 STRONG BUY'; signalEmoji = '🟢🟢'; }
    else if (combinedScore >= 65) { signal = '🟢 BUY NOW'; signalEmoji = '🟢'; }
    else if (combinedScore >= 50) { signal = '🟡 ACCUMULATE'; signalEmoji = '🟡'; }
    else if (combinedScore >= 35) { signal = '🟠 WAIT'; signalEmoji = '🟠'; }
    else { signal = '🔴 AVOID'; signalEmoji = '🔴'; }

    // VWAP Bias
    const vwapBias = price > vwap ? '📈 Above VWAP (Bullish)' : '📉 Below VWAP (Bearish)';

    // Volatility
    const atrPct = (atr / price * 100).toFixed(2);
    const volRegime = atrPct < 1 ? 'LOW' : atrPct < 2.5 ? 'NORMAL' : atrPct < 5 ? 'HIGH' : 'EXTREME';

    // 90% CI
    const ciHalf = atr * 1.645;
    const ciLow = (price - ciHalf).toFixed(2);
    const ciHigh = (price + ciHalf).toFixed(2);

    let msg_text = `<b>🎯 EXACT BUY PRICE — ${symbol}</b>\n`;
    msg_text += `━━━━━━━━━━━━━━━━━━━━━━━\n\n`;

    msg_text += `<b>COMBINED SCORE: ${combinedScore}/100</b> ${signal}\n\n`;

    msg_text += `<b>🎯 EXACT ENTRY ZONE:</b>\n`;
    msg_text += `<code>Entry:    ${cur}${entryLow} — ${cur}${entryHigh}</code>\n`;
    msg_text += `<code>Optimal:  ${cur}${entryOptimal}</code>\n`;
    msg_text += `<code>Stop Loss:${cur}${stopLoss}</code>\n`;
    msg_text += `<code>Target 1: ${cur}${target1}</code>\n`;
    msg_text += `<code>Target 2: ${cur}${target2}</code>\n`;
    msg_text += `<code>R:R = 1:${riskReward.toFixed(2)}</code>\n\n`;

    msg_text += `<b>LAYER 1: Technical (${technicalScore}/100)</b>\n`;
    msg_text += `<code>━━━━━━━━━━━━━━━━━━━━━━━</code>\n`;
    msg_text += `VWAP: ${cur}${vwap.toFixed(2)} — ${vwapBias}\n`;
    msg_text += `Fib 61.8%: ${cur}${fib618.toFixed(2)}\n`;
    msg_text += `Fib 38.2%: ${cur}${fib382.toFixed(2)}\n`;
    msg_text += `Pivot: ${cur}${pp.toFixed(2)} | S1: ${cur}${s1.toFixed(2)}\n`;
    msg_text += `SMA20: ${cur}${sma20.toFixed(2)} | SMA50: ${cur}${sma50.toFixed(2)}\n\n`;

    msg_text += `<b>LAYER 2: ML Bounce (${mlBounceProb}% probability)</b>\n`;
    msg_text += `<code>━━━━━━━━━━━━━━━━━━━━━━━</code>\n`;
    msg_text += `Support Distance: ${distToSupport.toFixed(1)}%\n`;
    msg_text += `Volatility: ${volRegime} (${atrPct}%)\n`;
    msg_text += `90% CI: ${cur}${ciLow} — ${cur}${ciHigh}\n`;
    msg_text += `Pattern: ${rsi < 30 && distToSupport < 3 ? 'Oversold Bounce' : rsi < 40 && sma20 > sma50 ? 'Pullback in Uptrend' : 'Neutral'}\n\n`;

    msg_text += `<b>LAYER 3: AI Validation (${aiScore}/100)</b>\n`;
    msg_text += `<code>━━━━━━━━━━━━━━━━━━━━━━━</code>\n`;
    msg_text += `RSI: ${rsi.toFixed(1)} ${rsi < 30 ? '🟢 Oversold' : rsi > 70 ? '🔴 Overbought' : '🟡 Neutral'}\n`;
    msg_text += `MACD: ${macd > 0 ? '📈 Bullish' : '📉 Bearish'}\n`;
    msg_text += `Trend: ${sma20 > sma50 ? '🟢 Golden Cross' : '🔴 Death Cross'}\n`;
    msg_text += `Volume: ${volume > 1000000 ? '🔥 High' : '💤 Low'}\n\n`;

    msg_text += `<b>VERDICT:</b> ${signal}\n`;
    if (combinedScore >= 70) {
      msg_text += `<i>Technical + ML + AI all aligned. ${cur}${entryLow}-${cur}${entryHigh} pe buy karo. SL ${cur}${stopLoss} pe rakho.</i>\n`;
    } else if (combinedScore >= 50) {
      msg_text += `<i>Mixed signals. ${cur}${entryOptimal} pe accumulate karo. Wait for confirmation.</i>\n`;
    } else {
      msg_text += `<i>Weak setup. Wait for better entry near ${cur}${entryLow}.</i>\n`;
    }

    msg_text += `\n💎 <i> — 3-Layer Exact Entry Engine</i>`;
    await safeSend(chatId, msg_text);
  } catch (e) {
    console.error('❌ /exact error:', e.message);
    await safeSend(chatId, `❌ Exact price error: ${e.message}`);
  }
});


// ========================================
// COMMAND: /compare <SYM1> <SYM2> — Side by Side
// ========================================
bot.onText(/^\/compare(?:@\w+)?(?:\s+(.+))?$/i, async (msg, match) => {
  if (!isAuthorized(msg)) return;
  const chatId = msg.chat.id;
  if (!match[1]) {
    await safeSend(chatId, '⚠️ <b>Symbols missing!</b>\n\nDono symbols likho!\n\nExample: <code>/compare RELIANCE TCS</code> or <code>/compare SMH VGT</code>');
    return;
  }
  const args = match[1].trim().toUpperCase().split(/[\s,vs]+/);
  console.log(`📥 /compare ${args.join(' vs ')} from ${msg.from?.first_name || chatId}`);
  try {
    if (args.length < 2) {
      await safeSend(chatId, '⚠️ Dono symbols likho!\n\nExample: <code>/compare RELIANCE TCS</code> or <code>/compare SMH VGT</code>');
      return;
    }
    await safeSend(chatId, `⚖️ <i>Comparing ${escapeHtml(args[0])} vs ${escapeHtml(args[1])}... ek second...</i>`);
    const [data1, data2] = await Promise.all([
      fetchSingleSymbol(args[0]),
      fetchSingleSymbol(args[1])
    ]);
    if (!data1 || !data2) {
      const missing = !data1 ? args[0] : args[1];
      await safeSend(chatId, `❌ <b>${escapeHtml(missing)}</b> not found. Check symbol name.`);
      return;
    }
    const report = generateCompareReport(data1, data2);
    await safeSend(chatId, report);
  } catch (e) {
    console.error('❌ /compare error:', e.message);
    await safeSend(chatId, `❌ Compare me error aaya: ${escapeHtml(e.message)}\n\nPlease try again.`);
  }
});


// ========================================
// COMMAND: /correlate — Portfolio Correlation Matrix
// ========================================
bot.onText(/^\/correlat(?:e|ion)?(@\w+)?$/i, async (msg) => {
  if (!isAuthorized(msg)) return;
  const chatId = msg.chat.id;
  console.log(`📥 /correlate from ${msg.from?.first_name || chatId}`);
  try {
    if (portfolio.length < 2) {
      await safeSend(chatId, '⚠️ Minimum 2 positions chahiye correlation ke liye.');
      return;
    }
    await safeSend(chatId, '🔗 <i>Calculating correlation matrix...</i>');
    await smartRefreshPrices();

    const changes = portfolio.map(p => {
      const key = `${p.market}_${p.symbol}`;
      const data = livePrices[key];
      return { sym: p.symbol.replace('.NS', ''), change: data?.change || 0, market: p.market };
    });

    let report = `🔗 <b>CORRELATION MATRIX</b>\n`;
    report += `⏰ <i>${getISTTime()} IST</i>\n\n`;
    report += `<code>━━━━━━━━━━━━━━━━━━━━━━━━━</code>\n`;

    for (let i = 0; i < changes.length; i++) {
      for (let j = i + 1; j < changes.length; j++) {
        const a = changes[i];
        const b = changes[j];
        const corr = a.change * b.change > 0 ? '🟢' : a.change * b.change < 0 ? '🔴' : '⚪';
        const strength = Math.abs(a.change - b.change);
        const label = strength < 0.5 ? 'STRONG' : strength < 1.5 ? 'MODERATE' : 'WEAK';
        report += `${corr} <b>${a.sym}</b> ↔ <b>${b.sym}</b>: ${label}\n`;
        report += `  ${a.sym}: ${a.change >= 0 ? '+' : ''}${a.change.toFixed(2)}% | ${b.sym}: ${b.change >= 0 ? '+' : ''}${b.change.toFixed(2)}%\n`;
      }
    }

    const allPositive = changes.every(c => c.change > 0);
    const allNegative = changes.every(c => c.change < 0);
    const mixed = !allPositive && !allNegative;

    report += `\n🧠 <b>Correlation Verdict:</b>\n`;
    if (allPositive) report += `🟢 Sab same direction me move kar rahe — strong positive correlation. Diversification LOW.`;
    else if (allNegative) report += `🔴 Sab neeche ja rahe — systematic risk HIGH. Hedge karo!`;
    else report += `🟡 Mixed movement — good diversification. Portfolio balanced hai.`;

    report += `\n\n💎 <i> Pro Terminal</i>`;
    await safeSend(chatId, report);
  } catch (e) {
    console.error('❌ /correlate error:', e.message);
    await safeSend(chatId, `❌ Correlation error: ${e.message}`);
  }
});

// ========================================
// COMMAND: /heatmap — Sector Heat Map
// ========================================
bot.onText(/^\/heatmap(@\w+)?$/i, async (msg) => {
  if (!isAuthorized(msg)) return;
  const chatId = msg.chat.id;
  console.log(`📥 /heatmap from ${msg.from?.first_name || chatId}`);
  try {
    await safeSend(chatId, '🔥 <i>Generating sector heatmap...</i>');
    await Promise.all([refreshPrices(), refreshIntel()]);

    let report = `🔥 <b>SECTOR HEAT MAP</b>\n`;
    report += `⏰ <i>${getISTTime()} IST</i> | ${getMarketStatus()}\n`;
    report += `<code>━━━━━━━━━━━━━━━━━━━━━━━━━</code>\n\n`;

    // Global indices heatmap
    if (marketIntel?.globalIndices?.length > 0) {
      report += `🌍 <b>Global Indices</b>\n`;
      const sorted = [...marketIntel.globalIndices].sort((a, b) => b.change - a.change);
      for (const idx of sorted) {
        const bar = idx.change >= 0
          ? '🟩'.repeat(Math.min(10, Math.round(Math.abs(idx.change) * 2)))
          : '🟥'.repeat(Math.min(10, Math.round(Math.abs(idx.change) * 2)));
        report += `${idx.change >= 0 ? '🟢' : '🔴'} <b>${idx.name}</b>: ${idx.price.toFixed(0)} (${idx.change >= 0 ? '+' : ''}${idx.change.toFixed(2)}%)\n`;
        report += `  ${bar}\n`;
      }
      report += `\n`;
    }

    // Sector heatmap
    if (marketIntel?.sectors?.length > 0) {
      report += `🏭 <b>Sector Performance</b>\n`;
      const sorted = [...marketIntel.sectors].sort((a, b) => b.change - a.change);
      for (const s of sorted) {
        const bar = s.change >= 0
          ? '🟩'.repeat(Math.min(10, Math.round(Math.abs(s.change) * 3)))
          : '🟥'.repeat(Math.min(10, Math.round(Math.abs(s.change) * 3)));
        report += `${s.change >= 0 ? '🟢' : '🔴'} <b>${s.name}</b>: ${s.change >= 0 ? '+' : ''}${s.change.toFixed(2)}%\n`;
        report += `  ${bar}\n`;
      }
      report += `\n`;
    }

    // Portfolio heatmap
    if (portfolio.length > 0) {
      report += `💼 <b>Your Portfolio Heat</b>\n`;
      const positions = portfolio.map(p => {
        const key = `${p.market}_${p.symbol}`;
        const data = livePrices[key];
        return {
          symbol: p.symbol.replace('.NS', ''),
          change: data?.change || 0,
          market: p.market
        };
      }).sort((a, b) => b.change - a.change);

      for (const p of positions) {
        const bar = p.change >= 0
          ? '🟩'.repeat(Math.min(8, Math.round(Math.abs(p.change) * 2)))
          : '🟥'.repeat(Math.min(8, Math.round(Math.abs(p.change) * 2)));
        const flag = p.market === 'IN' ? '🇮🇳' : '🇺🇸';
        report += `${p.change >= 0 ? '🟢' : '🔴'} ${flag} <b>${p.symbol}</b>: ${p.change >= 0 ? '+' : ''}${p.change.toFixed(2)}%\n`;
        report += `  ${bar}\n`;
      }
    }

    report += `\n💎 <i> Pro Terminal</i>`;
    await safeSend(chatId, report);
  } catch (e) {
    console.error('❌ /heatmap error:', e.message);
    await safeSend(chatId, `❌ Heatmap error: ${e.message}`);
  }
});

// ========================================
// COMMAND: /streak — Performance Tracker
// ========================================
bot.onText(/^\/streak(@\w+)?$/i, async (msg) => {
  if (!isAuthorized(msg)) return;
  const chatId = msg.chat.id;
  console.log(`📥 /streak from ${msg.from?.first_name || chatId}`);
  try {
    if (portfolio.length === 0) {
      await safeSend(chatId, '⚠️ Portfolio empty hai. Data collect hone do.');
      return;
    }
    await smartRefreshPrices();
    const metrics = calculateMetrics(portfolio, livePrices, usdInrRate);

    let report = `📈 <b>PERFORMANCE STREAK TRACKER</b>\n`;
    report += `⏰ <i>${getISTTime()} IST</i>\n`;
    report += `<code>━━━━━━━━━━━━━━━━━━━━━━━━━</code>\n\n`;

    // Current streak
    const streakEmoji = consecutiveStreak > 0 ? '🟢' : consecutiveStreak < 0 ? '🔴' : '⚪';
    const streakLabel = consecutiveStreak > 0 ? 'GREEN' : consecutiveStreak < 0 ? 'RED' : 'NEUTRAL';
    report += `${streakEmoji} <b>Current Streak:</b> ${Math.abs(consecutiveStreak)} day${Math.abs(consecutiveStreak) !== 1 ? 's' : ''} ${streakLabel}\n\n`;

    // Today's P&L
    report += `📊 <b>Today:</b> ${metrics.todayPL >= 0 ? '🟢 +' : '🔴 '}₹${Math.round(Math.abs(metrics.todayPL)).toLocaleString('en-IN')} (${metrics.todayPct >= 0 ? '+' : ''}${metrics.todayPct.toFixed(2)}%)\n\n`;

    // History (last 10 days)
    if (dailyPLHistory.length > 0) {
      report += `📅 <b>Recent History (${Math.min(dailyPLHistory.length, 10)} days):</b>\n`;
      const recent = dailyPLHistory.slice(-10);
      for (const day of recent) {
        const emoji = day.pl >= 0 ? '🟢' : '🔴';
        report += `${emoji} ${day.date}: ${day.pl >= 0 ? '+' : ''}₹${Math.round(Math.abs(day.pl)).toLocaleString('en-IN')} (${day.pct >= 0 ? '+' : ''}${day.pct.toFixed(2)}%)\n`;
      }

      // Stats
      const greenDays = dailyPLHistory.filter(d => d.pl >= 0).length;
      const totalDays = dailyPLHistory.length;
      const winRate = totalDays > 0 ? ((greenDays / totalDays) * 100).toFixed(1) : '0';
      const avgPL = dailyPLHistory.reduce((s, d) => s + d.pl, 0) / totalDays;

      report += `\n📊 <b>Statistics (${totalDays} days):</b>\n`;
      report += `Win Rate: <b>${winRate}%</b> (${greenDays}/${totalDays})\n`;
      report += `Avg Daily P&L: <b>${avgPL >= 0 ? '+' : ''}₹${Math.round(avgPL).toLocaleString('en-IN')}</b>\n`;
    } else {
      report += `⚠️ <i>No historical data yet. Data is recorded at India market close.</i>\n`;
    }

    report += `\n💎 <i> Pro Terminal</i>`;
    await safeSend(chatId, report);
  } catch (e) {
    console.error('❌ /streak error:', e.message);
    await safeSend(chatId, `❌ Streak error: ${e.message}`);
  }
});

// ========================================
// COMMAND: /backtest — AI Signal Accuracy
// ========================================
bot.onText(/^\/backtest(@\w+)?$/i, async (msg) => {
  if (!isAuthorized(msg)) return;
  const chatId = msg.chat.id;
  console.log(`📥 /backtest from ${msg.from?.first_name || chatId}`);
  try {
    if (portfolio.length === 0) {
      await safeSend(chatId, '⚠️ Portfolio empty hai.');
      return;
    }
    await smartRefreshPrices();

    let report = `🧪 <b>AI SIGNAL ACCURACY — Backtest Engine</b>\n`;
    report += `⏰ <i>${getISTTime()} IST</i>\n`;
    report += `<code>━━━━━━━━━━━━━━━━━━━━━━━━━</code>\n\n`;

    // Generate AI signals for each position
    const signals = portfolio.map(p => {
      const key = `${p.market}_${p.symbol}`;
      const data = livePrices[key];
      return analyzeAsset(p, data);
    });

    // Run backtester engine on each signal vs today's actual move
    const backtestResults = [];
    for (const s of signals) {
      const predictedChange = s.signal.includes('BUY') ? 2.0 : s.signal.includes('SELL') ? -2.0 : 0;
      const actualChange = s.change || 0;
      const result = await backtestSignal(s.symbol, predictedChange, actualChange, '1d');
      result.confidence = s.confidence;
      result.signal = s.signal;
      backtestResults.push(result);
    }

    // Aggregate metrics
    const metrics = calculateBacktestMetrics(backtestResults);

    // Signal summary
    const buyCount = signals.filter(s => s.signal.includes('BUY')).length;
    const sellCount = signals.filter(s => s.signal.includes('SELL')).length;
    const holdCount = signals.filter(s => s.signal === 'HOLD').length;
    const avgConfidence = signals.reduce((sum, s) => sum + s.confidence, 0) / signals.length;

    report += `📊 <b>Signal Summary:</b>\n`;
    report += `BUY: ${buyCount} | SELL: ${sellCount} | HOLD: ${holdCount}\n`;
    report += `Avg Confidence: <b>${avgConfidence.toFixed(1)}%</b>\n\n`;

    // Per-asset results
    report += `📈 <b>Backtest Results (vs Today's Move):</b>\n`;
    report += `<code>━━━━━━━━━━━━━━━━━━━━━━━━━</code>\n`;
    for (const r of backtestResults) {
      const emoji = r.verdict === 'EXCELLENT' ? '🟢' : r.verdict === 'GOOD' ? '🟡' : '🔴';
      report += `${emoji} <b>${r.symbol}</b>: ${r.signal} → ${r.actualMove >= 0 ? '+' : ''}${r.actualMove.toFixed(2)}%\n`;
      report += `   Score: ${r.score}% | ${r.verdict} | Error: ${r.magnitudeError.toFixed(1)}%\n`;
    }

    // Overall metrics
    report += `\n<code>━━━━━━━━━━━━━━━━━━━━━━━━━</code>\n`;
    report += `🎯 <b>Aggregate Metrics:</b>\n`;
    report += `Avg Accuracy: <b>${metrics.avgAccuracy}</b>\n`;
    report += `Win Rate: <b>${metrics.winRate}</b>\n`;
    report += `Sample: <b>${metrics.sampleSize} signals</b>\n\n`;

    const accVal = parseFloat(metrics.avgAccuracy);
    const accBar = '🟩'.repeat(Math.round(accVal / 10)) + '⬜'.repeat(10 - Math.round(accVal / 10));
    report += `<code>[${accBar}] ${metrics.avgAccuracy}</code>\n\n`;

    if (accVal > 70) report += `🟢 <b>Excellent!</b> AI signals highly accurate today.`;
    else if (accVal > 50) report += `🟡 <b>Decent.</b> AI signals reasonable. Always use SL.`;
    else report += `🔴 <b>Caution!</b> Low accuracy — market may be choppy. Reduce sizes.`;

    report += `\n\n<i>Engine: backtester.mjs | Past accuracy ≠ future guarantee.</i>`;
    report += `\n💎 <i> Pro Terminal</i>`;
    await safeSend(chatId, report);
  } catch (e) {
    console.error('❌ /backtest error:', e.message);
    await safeSend(chatId, `❌ Backtest error: ${e.message}`);
  }
});

// ========================================
// COMMAND: /taxloss — Tax-Loss Harvesting
// ========================================
bot.onText(/^\/taxloss(@\w+)?$/i, async (msg) => {
  if (!isAuthorized(msg)) return;
  const chatId = msg.chat.id;
  console.log(`📥 /taxloss from ${msg.from?.first_name || chatId}`);
  try {
    if (portfolio.length === 0) {
      await safeSend(chatId, '⚠️ Portfolio empty hai.');
      return;
    }
    await smartRefreshPrices();

    let report = `💸 <b>TAX-LOSS HARVESTING</b>\n`;
    report += `⏰ <i>${getISTTime()} IST</i>\n`;
    report += `<code>━━━━━━━━━━━━━━━━━━━━━━━━━</code>\n\n`;

    let harvestCount = 0;
    let totalLoss = 0;

    for (const p of portfolio) {
      const key = `${p.market}_${p.symbol}`;
      const data = livePrices[key];
      const price = data?.price || p.avgPrice;
      const plPct = p.avgPrice > 0 ? ((price - p.avgPrice) / p.avgPrice) * 100 : 0;
      const plAbs = (price - p.avgPrice) * p.qty;
      const plINR = p.market === 'US' ? plAbs * usdInrRate : plAbs;

      // Only consider positions at a loss
      if (plPct >= 0) continue;

      const cleanSym = p.symbol.replace('.NS', '').replace('.BO', '');
      const pairSym = TAX_PAIRS[cleanSym];

      if (pairSym) {
        harvestCount++;
        totalLoss += Math.abs(plINR);
        const flag = p.market === 'IN' ? '🇮🇳' : '🇺🇸';
        const cur = p.market === 'IN' ? '₹' : '$';

        report += `${flag} <b>${cleanSym}</b>: ${cur}${price.toFixed(2)} | P&L: <b>${plPct.toFixed(1)}%</b> (₹${Math.round(Math.abs(plINR)).toLocaleString('en-IN')} loss)\n`;
        report += `  ↳ 🔄 Swap to: <b>${pairSym}</b> (similar exposure, book loss)\n`;
        report += `  ↳ Qty: ${p.qty} | Avg: ${cur}${p.avgPrice.toFixed(2)}\n\n`;
      }
    }

    if (harvestCount === 0) {
      report += `✅ <b>No harvest opportunities!</b>\n\n`;
      report += `All positions with matching pairs are in profit.\n`;
      report += `No tax-loss swaps available right now.`;
    } else {
      const taxSaving = totalLoss * 0.10; // ~10% STCG tax rate assumption
      report += `<code>━━━━━━━━━━━━━━━━━━━━━━━━━</code>\n`;
      report += `📊 <b>Summary:</b>\n`;
      report += `Harvestable positions: <b>${harvestCount}</b>\n`;
      report += `Total bookable loss: <b>₹${Math.round(totalLoss).toLocaleString('en-IN')}</b>\n`;
      report += `Est. tax saving (10% STCG): <b>₹${Math.round(taxSaving).toLocaleString('en-IN')}</b>\n\n`;
      report += `💡 <b>How it works:</b>\n`;
      report += `Sell the losing asset → Buy the paired ETF (similar sector exposure)\n`;
      report += `Book the loss for tax offset → Maintain market exposure via the pair\n`;
      report += `After 30 days, swap back if desired (avoid wash sale rule)\n`;
    }

    report += `\n💎 <i> Pro Terminal</i>`;
    await safeSend(chatId, report);
  } catch (e) {
    console.error('❌ /taxloss error:', e.message);
    await safeSend(chatId, `❌ Tax-loss error: ${e.message}`);
  }
});

// ========================================
// COMMAND: /trim or /rules — Trim + Re-Entry Rules
// ========================================
bot.onText(/^\/(trim|rules)(@\w+)?$/i, async (msg) => {
  if (!isAuthorized(msg)) return;
  const chatId = msg.chat.id;
  console.log(`📥 /trim from ${msg.from?.first_name || chatId}`);

  let r = `✂️ <b>TRIM + RE-ENTRY RULES CARD</b>\n`;
  r += `━━━━━━━━━━━━━━━━━━━━━━━━━\n\n`;

  r += `🇺🇸 <b>USA ETFs:</b>\n\n`;

  r += `🔥 <b>SMH</b> (Most Aggressive)\n`;
  r += `1. TRIM: Weight >53% OR rally 20%+ in 6wk\n`;
  r += `2. SIZE: 10-15% of position (max 20%)\n`;
  r += `3. RE-ENTRY: Wait for 8-10% dip\n`;
  r += `4. STYLE: 3 equal parts (33% each)\n`;
  r += `5. ROTATE: VGT\n\n`;

  r += `⚡ <b>VGT</b> (Semi-Core)\n`;
  r += `1. TRIM: Weight >27% OR rally 22%+ in 3mo\n`;
  r += `2. SIZE: 10-12% of position\n`;
  r += `3. RE-ENTRY: Wait for 7-9% dip\n`;
  r += `4. STYLE: 2-3 equal parts\n`;
  r += `5. ROTATE: SMH\n\n`;

  await safeSend(chatId, r);

  // Part 2: India ETFs
  let r2 = `🇮🇳 <b>INDIA ETFs:</b>\n\n`;

  r2 += `🇮🇳 <b>MOMENTUM50</b> (Aggressive)\n`;
  r2 += `1. TRIM: Weight >44% OR rally 25%+ in 3mo\n`;
  r2 += `2. SIZE: 10-15% of position\n`;
  r2 += `3. RE-ENTRY: Wait for 10% correction\n`;
  r2 += `4. STYLE: 3 equal SIP-style buys\n`;
  r2 += `5. ROTATE: MID150BEES or JUNIORBEES\n\n`;

  r2 += `🚀 <b>SMALLCAP</b> (Highest Risk)\n`;
  r2 += `1. TRIM: Weight >33% OR rally 30%+ in 4mo\n`;
  r2 += `2. SIZE: 12-18% of position\n`;
  r2 += `3. RE-ENTRY: Wait for 12-15% correction\n`;
  r2 += `4. STYLE: 3-4 staggered buys\n`;
  r2 += `5. ROTATE: MID150BEES\n\n`;

  r2 += `🏛️ <b>MID150BEES</b> (Core)\n`;
  r2 += `1. TRIM: Weight >27% (rarely)\n`;
  r2 += `2. SIZE: 5-10% only\n`;
  r2 += `3. RE-ENTRY: Wait for 8% dip\n`;
  r2 += `4. STYLE: 2 parts\n`;
  r2 += `5. ROTATE: JUNIORBEES\n\n`;

  r2 += `🛡️ <b>JUNIORBEES</b> (Most Stable)\n`;
  r2 += `1. TRIM: Weight >22% (very rarely)\n`;
  r2 += `2. SIZE: 5-8% only\n`;
  r2 += `3. RE-ENTRY: Wait for 6% dip\n`;
  r2 += `4. STYLE: 2 parts\n`;
  r2 += `5. ROTATE: MID150BEES\n\n`;

  await safeSend(chatId, r2);

  // Part 3: Golden Rules + Cash Mgmt
  let r3 = `🎯 <b>GOLDEN RULES</b>\n`;
  r3 += `━━━━━━━━━━━━━━━━━━━━━━━━━\n\n`;
  r3 += `✅ Trim only OVERWEIGHT positions\n`;
  r3 += `✅ Max 15-20% trim per action\n`;
  r3 += `✅ Re-enter in PARTS (never full)\n`;
  r3 += `✅ Wait for confirmed dip\n`;
  r3 += `✅ Continue SIP regardless\n`;
  r3 += `✅ Document every trim for tax\n`;
  r3 += `✅ Review every 6 months only\n\n`;
  r3 += `❌ Never full exit\n`;
  r3 += `❌ Never panic trim in red days\n`;
  r3 += `❌ Never chase same price after trim\n`;
  r3 += `❌ Never trim more than 1x per quarter\n\n`;

  r3 += `💰 <b>CASH POST-TRIM:</b>\n`;
  r3 += `├─ Max: 5-7% of portfolio\n`;
  r3 += `├─ Deploy: 30-90 days\n`;
  r3 += `├─ Method: 3 staggered parts\n`;
  r3 += `└─ No dip in 90d? Deploy anyway\n\n`;

  r3 += `🔄 <b>RE-ENTRY TIMELINE:</b>\n`;
  r3 += `Day 1-30:  WAIT\n`;
  r3 += `Day 30-60: Dip 8%+ → Buy 33%\n`;
  r3 += `Day 60-90: Dip 10%+ → Buy 33%\n`;
  r3 += `Day 90+:   Deploy remaining 33%\n\n`;

  r3 += `🎯 <b>ONE RULE:</b>\n`;
  r3 += `<i>"Trim only when overweight + parabolic, Re-enter in 3 parts on dip, Continue SIP always, Review every 6 months, Ignore noise, follow rules."</i>\n\n`;
  r3 += `🎯 GOAL: 20%+ CAGR for 15-20 years\n`;
  r3 += `💎 <i> Pro Terminal</i>`;

  await safeSend(chatId, r3);
});

// ========================================
// COMMAND: /fire — FIRE / Early Retirement Calculator
// ========================================
bot.onText(/^\/fire(?:@\w+)?(?:\s+(\d+))?(?:\s+(\d+))?$/i, async (msg, match) => {
  if (!isAuthorized(msg)) return;
  const chatId = msg.chat.id;
  const monthlyExpenses = parseInt(match?.[1]) || 50000;
  const monthlySIP = parseInt(match?.[2]) || 25000;
  console.log(`📥 /fire from ${msg.from?.first_name || chatId}`);
  try {
    await smartRefreshPrices();
    const m = portfolio.length > 0 ? calculateMetrics(portfolio, livePrices, usdInrRate) : { totalValue: 0 };
    const current = m.totalValue || 0;
    const annual = monthlyExpenses * 12;

    const fireNumber = annual * 25; // 4% SWR
    const leanFire = annual * 20;
    const fatFire = annual * 33;
    const progress = Math.min(100, (current / fireNumber) * 100);

    // Real (inflation-adjusted) growth: 12% CAGR, 6% inflation
    const realMonthly = Math.pow(1.12 / 1.06, 1 / 12) - 1;
    let wealth = current, years = 0;
    while (wealth < fireNumber && years < 60) {
      for (let mo = 0; mo < 12; mo++) wealth = (wealth + monthlySIP) * (1 + realMonthly);
      years++;
    }
    const yearsStr = years >= 60 ? '60+' : String(years);

    const filled = Math.max(0, Math.min(10, Math.round(progress / 10)));
    const bar = '🟩'.repeat(filled) + '⬜'.repeat(10 - filled);

    let r = `🔥 <b>FIRE CALCULATOR</b>\n━━━━━━━━━━━━━━━━━━━━━━━\n\n`;
    r += `💸 Monthly Expenses: <b>₹${monthlyExpenses.toLocaleString('en-IN')}</b>\n`;
    r += `💰 Monthly SIP: <b>₹${monthlySIP.toLocaleString('en-IN')}</b>\n`;
    r += `💼 Current Corpus: <b>₹${Math.round(current).toLocaleString('en-IN')}</b>\n\n`;
    r += `🎯 <b>FIRE Targets (today's money):</b>\n`;
    r += `🌱 Lean FIRE (20x): ₹${leanFire.toLocaleString('en-IN')}\n`;
    r += `🔥 Standard FIRE (25x): <b>₹${fireNumber.toLocaleString('en-IN')}</b>\n`;
    r += `👑 Fat FIRE (33x): ₹${fatFire.toLocaleString('en-IN')}\n\n`;
    r += `⏳ Years to FIRE: <b>${yearsStr} years</b> <i>(12% CAGR, 6% inflation-adjusted)</i>\n`;
    r += `📊 Progress: <b>${progress.toFixed(1)}%</b>\n<code>[${bar}]</code>\n\n`;
    r += `🏖️ Passive income at FIRE: <b>₹${Math.round(fireNumber * 0.04 / 12).toLocaleString('en-IN')}/month</b>\n\n`;
    r += `<i>Usage: /fire &lt;monthly_expenses&gt; &lt;monthly_sip&gt;</i>\n💎 <i> Pro Terminal</i>`;
    await safeSend(chatId, r);
  } catch (e) {
    console.error('❌ /fire error:', e.message);
    await safeSend(chatId, `❌ FIRE calc error: ${e.message}`);
  }
});

// ========================================
// COMMAND: /milestones — Wealth Milestone Tracker
// ========================================
bot.onText(/^\/milestones?(?:@\w+)?(?:\s+(\d+))?$/i, async (msg, match) => {
  if (!isAuthorized(msg)) return;
  const chatId = msg.chat.id;
  const monthlySIP = parseInt(match?.[1]) || 25000;
  console.log(`📥 /milestones from ${msg.from?.first_name || chatId}`);
  try {
    await smartRefreshPrices();
    const m = portfolio.length > 0 ? calculateMetrics(portfolio, livePrices, usdInrRate) : { totalValue: 0 };
    const current = m.totalValue || 0;
    const cagrMonthly = 0.15 / 12;
    const stepUp = 0.10;

    const targets = [
      { t: 1000000, label: '₹10 Lakh', e: '🥉' },
      { t: 2500000, label: '₹25 Lakh', e: '🥈' },
      { t: 5000000, label: '₹50 Lakh', e: '🥇' },
      { t: 10000000, label: '₹1 Crore', e: '💎' },
      { t: 25000000, label: '₹2.5 Crore', e: '👑' },
      { t: 50000000, label: '₹5 Crore', e: '🏆' },
      { t: 100000000, label: '₹10 Crore', e: '🚀' }
    ];

    let r = `🏆 <b>WEALTH MILESTONE TRACKER</b>\n━━━━━━━━━━━━━━━━━━━━━━━\n`;
    r += `💼 Current: <b>₹${Math.round(current).toLocaleString('en-IN')}</b> | SIP ₹${monthlySIP.toLocaleString('en-IN')}/mo (+10% yearly) @ 15% CAGR\n\n`;

    const now = new Date();
    for (const ms of targets) {
      if (current >= ms.t) {
        r += `${ms.e} <b>${ms.label}</b>: ✅ ACHIEVED!\n`;
        continue;
      }
      let wealth = current, sip = monthlySIP, years = 0;
      while (wealth < ms.t && years < 50) {
        for (let mo = 0; mo < 12; mo++) wealth = (wealth + sip) * (1 + cagrMonthly);
        years++;
        sip *= (1 + stepUp);
      }
      const eta = years >= 50 ? '50+ yrs' : `${new Date(now.getFullYear() + years, now.getMonth(), 1).toLocaleDateString('en-IN', { month: 'short', year: 'numeric' })} (~${years}yr)`;
      const prog = Math.min(99, (current / ms.t) * 100);
      r += `${ms.e} <b>${ms.label}</b>: ${prog.toFixed(0)}% | ETA <b>${eta}</b>\n`;
    }

    r += `\n<i>Usage: /milestones &lt;monthly_sip&gt;</i>\n💎 <i> Pro Terminal</i>`;
    await safeSend(chatId, r);
  } catch (e) {
    console.error('❌ /milestones error:', e.message);
    await safeSend(chatId, `❌ Milestones error: ${e.message}`);
  }
});

// ========================================
// FREE TEXT → AI CHAT (any message without /)
// ========================================
bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text || '';

  // Skip commands — they're handled above
  if (text.startsWith('/')) return;
  // Skip empty
  if (!text.trim()) return;
  // Authorization — only the configured chat can use AI (prevents token abuse)
  if (!isAuthorized(msg)) return;

  // AI Rate Limit
  if (!checkAIRateLimit(chatId)) {
    await safeSend(chatId, '⏳ <b>Rate limit!</b> Bahut zyada requests bhej rahe ho. 1 min baad retry karo.');
    return;
  }

  console.log(`💬 AI Chat: "${text.substring(0, 50)}..." from ${msg.from?.first_name || chatId}`);
  const stopTypingMsg = startTyping(chatId);
  try {
    
    // Check freshness to avoid blocking sequential refreshes
    const now = Date.now();
    if (now - lastRefreshTime > 60000 || portfolio.length === 0 || Object.keys(livePrices).length === 0) {
      console.log('🔄 Data stale or empty — running parallel refresh...');
      await Promise.allSettled([refreshPortfolio(), refreshPrices()]);
      lastRefreshTime = Date.now();
    } else {
      console.log('⚡ Using cached portfolio and prices (freshness OK)');
    }
    
    const response = await chatWithAI(chatId, text, portfolio, livePrices, usdInrRate);
    await safeSend(chatId, response);
  } catch (e) {
    console.error('❌ AI chat error:', e.message);
    await safeSend(chatId, `❌ AI processing me error: ${e.message}\n\nRetry karo ya /clear karke phir try karo.`);
  } finally {
    stopTypingMsg();
  }
});

// ========================================
// 📊 WEEKLY REVIEW (#3) — the site's quant-computed trade-performance
// digest (journal + calibration → ONE LLM narration). Same compute
// the Sunday 19:00 IST auto-push uses; here it's on demand.
// ========================================
bot.onText(/^\/weeklyreview(@\w+)?$/i, async (msg) => {
  if (!isAuthorized(msg)) return;
  const chatId = msg.chat.id;
  console.log(`📥 /weeklyreview from ${msg.from?.first_name || chatId}`);
  const stopTyping = startTyping(chatId);
  try {
    await safeSend(chatId, '📊 <i>Weekly review bana raha hoon — journal + calibration scan…</i>');
    if (siteAgents.siteBridgeReady()) {
      const out = await siteAgents.siteWeeklyReview();
      if (out.ok && out.data?.text) {
        // Telegram 4096 cap — split on lines like the webhook does.
        let rest = String(out.data.text);
        while (rest.length > 0) {
          let cut = rest.length;
          if (cut > 3900) {
            const nl = rest.lastIndexOf('\n', 3900);
            cut = nl > 1950 ? nl : 3900;
          }
          await safeSend(chatId, rest.slice(0, cut));
          rest = rest.slice(cut);
        }
        if (out.data.cached) await safeSend(chatId, '♻️ <i>Ye is hafte ka cached review hai — naya data settle hone par refresh hoga.</i>');
        return;
      }
      // honest 400s ("no settled trades this week") reach here with a reason
      if (out.error) {
        await safeSend(chatId, `📭 ${escapeHtml(out.error)}`);
        return;
      }
      console.warn(`[weeklyreview] site path failed (${out.error})`);
    }
    await safeSend(chatId, '📭 Site backend se connect nahi ho paya — weekly review ke liye site server chalu hona chahiye (API_TOKEN configured). Tab tak /performance se desk stats dekho.');
  } catch (e) {
    console.error('❌ /weeklyreview error:', e.message);
    await safeSend(chatId, `❌ Weekly review error: ${e.message}`);
  } finally {
    stopTyping();
  }
});

// ========================================
// SCHEDULED TASKS (via node-cron)
// ========================================

// ────────────────────────────────────────────────────────────
// ⚡ INTRADAY PRO ALGO — Super Intelligence command + auto-alerts
// ────────────────────────────────────────────────────────────
bot.onText(/^\/algo(@\w+)?$/i, async (msg) => {
  if (!isAuthorized(msg)) return;
  const chatId = msg.chat.id;
  try {
    if (portfolio.length === 0) { await refreshPortfolio().catch(() => {}); }
    await smartRefreshPrices();
    const signals = scanAlgoSignals(algoWatchKeys(livePrices), livePrices);
    const actionable = signals.filter(s => s.direction !== 'WAIT');
    if (signals.length === 0) {
      await safeSend(chatId, '⚡ <b>Intraday Pro Algo</b>\n\nNo live data yet. Add holdings in the web app or try again during market hours.');
      return;
    }
    const picks = (actionable.length ? actionable : signals).slice(0, 5);
    let header = `⚡ <b>INTRADAY PRO ALGO — Super Intelligence</b>\n${getMarketStatus()}\n`;
    header += `Signals: ${signals.length} | Long: ${actionable.filter(s => s.direction === 'LONG').length} | Short: ${actionable.filter(s => s.direction === 'SHORT').length}\n\n`;
    await safeSend(chatId, header);
    for (const s of picks) await safeSend(chatId, formatAlgoAlert(s));
  } catch (e) {
    await safeSend(chatId, `⚠️ Algo error: ${e.message}`);
  }
});

// Auto intraday algo alerts: every 10 min during market hours (high-conviction).
// v18.2 DEMOTED TO BACKUP HEARTBEAT (#2): the site's instant-push pipeline
// (server/ai/telegramPush.js) now pushes SL/TP level touches + fresh STRONG
// signals within SECONDS. This cron only fires when that pipeline is stale
// or unreachable — the bot never goes silent because the site hiccupped,
// but it never double-pings what the site already pushed. The site check
// itself is 8s-bounded and best-effort.
cron.schedule('*/10 * * * *', async () => {
  if (!autoAlerts || !isAnyMarketOpen()) return;
  try {
    if (siteAgents.siteBridgeReady()) {
      const st = await siteAgents.siteInstaPushStatus().catch(() => null);
      if (st?.ok && st?.status?.healthy) return; // pipeline fresh — stay silent
      console.warn(`[algo-cron] insta-push ${st?.ok ? 'STALE' : 'unreachable'} — backup heartbeat mode`);
    }
    await smartRefreshPrices();
    const hot = scanAlgoSignals(algoWatchKeys(livePrices), livePrices)
      .filter(s => s.direction !== 'WAIT' && s.conviction >= 65)
      .slice(0, 6);
    const now = Date.now();
    for (const s of hot) {
      if (now - (lastAlgoAlertAt[s.symbol] || 0) < ALGO_COOLDOWN_MS) continue;
      await safeSend(TG_CHAT_ID, formatAlgoAlert(s));
      lastAlgoAlertAt[s.symbol] = now;
    }
  } catch (e) {
    console.warn('⚠️ Intraday algo cron failed:', e.message);
  }
});

// Price refresh: every 60 seconds
cron.schedule('0 */1 * * * *', async () => {
  if (!TG_CHAT_ID) return;
  if (portfolio.length > 0) {
    await smartRefreshPrices();
  }
});

// Forex refresh: every 2 minutes
cron.schedule('*/2 * * * *', refreshForex);

// Portfolio cloud sync: every 5 minutes
cron.schedule('*/5 * * * *', refreshPortfolio);

// Market intelligence: every 3 minutes
cron.schedule('*/3 * * * *', refreshIntel);

// ────────────────────────────────────────
// AUTO ALERTS — Market Hours Only
// ────────────────────────────────────────

// Daily Health Digest: 8:00 AM IST — Weekends only
// Weekdays: the comprehensive Daily Digest (~line 3274) already fires at 0 8 * * 1-5
cronIST('0 8 * * 0,6', async () => {
  if (!autoAlerts || portfolio.length === 0) return;
  console.log('📨 Sending daily health digest...');
  await smartRefreshPrices();

  const metrics = calculateMetrics(portfolio, livePrices, usdInrRate);
  let score = 100;
  const warnings = [];
  const opportunities = [];

  if (metrics.plPct < -20) { score -= 40; warnings.push(`Heavy drawdown: ${metrics.plPct.toFixed(1)}%`); }
  else if (metrics.plPct < -10) { score -= 25; }

  for (const pos of portfolio) {
    const pd = livePrices[`${pos.market}_${pos.symbol}`];
    if (!pd) continue;
    if (pd.rsi < 30) opportunities.push(`${pos.symbol}: RSI ${pd.rsi.toFixed(0)} — BUY`);
    if (pd.rsi > 75) { score -= 5; warnings.push(`${pos.symbol}: RSI ${pd.rsi.toFixed(0)} overbought`); }
  }

  const vixUS = livePrices['US_VIX']?.price || 0;
  const vixIN = livePrices['IN_INDIAVIX']?.price || 0;
  const avgVix = (vixUS + vixIN) / 2;
  if (avgVix > 30) { score -= 25; warnings.push(`VIX spike: ${avgVix.toFixed(1)}`); }
  else if (avgVix > 22) { score -= 15; warnings.push(`VIX elevated: ${avgVix.toFixed(1)}`); }

  score = Math.max(0, Math.min(100, score));
  const emoji = score >= 70 ? '🟢' : score >= 45 ? '🟡' : '🔴';
  const plEmoji = metrics.totalPL >= 0 ? '📈' : '📉';

  let msg = `<b>💊 DAILY HEALTH DIGEST</b>\n━━━━━━━━━━━━━━━━━━━━━━━\n`;
  msg += `Health: <b>${score}/100</b> ${emoji}\n`;
  msg += `Value: ₹${Math.round(metrics.totalValue).toLocaleString('en-IN')}\n`;
  msg += `${plEmoji} P&L: ₹${Math.round(metrics.totalPL).toLocaleString('en-IN')} (${metrics.plPct.toFixed(1)}%)\n\n`;

  if (opportunities.length > 0) {
    msg += `<b>🎯 BUY OPPORTUNITIES:</b>\n`;
    opportunities.slice(0, 5).forEach(o => { msg += `• ${o}\n`; });
    msg += `\n`;
  }
  if (warnings.length > 0) {
    msg += `<b>⚠️ WARNINGS:</b>\n`;
    warnings.slice(0, 5).forEach(w => { msg += `• ${w}\n`; });
    msg += `\n`;
  }
  msg += `<i>💎 Wealth AI Pro Terminal</i>`;

  await safeSend(TG_CHAT_ID, msg);
});

// India Pre-Market Briefing: 9:00 AM IST (v11.4: cron now speaks IST directly —
// the old UTC-encoded schedules drifted 5.5h on any non-UTC host)
cronIST('0 9 * * 1-5', async () => {
  if (!autoAlerts) return;
  console.log('📨 Sending India pre-market briefing...');
  await smartRefreshPrices();
  await refreshIntel();

  let msg = `☀️ <b>GOOD MORNING — Pre-Market Briefing</b>\n`;
  msg += `⏰ <i>${getISTTime()} IST</i>\n\n`;
  msg += `India market 15 minutes me open hoga!\n\n`;

  // Global overnight summary
  if (marketIntel?.globalIndices) {
    const spy = marketIntel.globalIndices.find(i => i.name === 'S&P 500');
    const qqq = marketIntel.globalIndices.find(i => i.name === 'NASDAQ 100');
    if (spy) msg += `🇺🇸 S&P 500 (overnight): <b>${spy.change >= 0 ? '+' : ''}${spy.change.toFixed(2)}%</b>\n`;
    if (qqq) msg += `🇺🇸 NASDAQ 100 (overnight): <b>${qqq.change >= 0 ? '+' : ''}${qqq.change.toFixed(2)}%</b>\n`;
  }

  const usVix = livePrices['US_VIX']?.price || 15;
  msg += `\n📊 US VIX: <b>${usVix.toFixed(1)}</b> ${usVix > 20 ? '🔴 Caution' : '🟢 Stable'}\n`;
  msg += `💱 USD/INR: <b>₹${usdInrRate.toFixed(2)}</b>\n`;
  msg += `\n<i>Market open hote hi full scan bhejunga!</i>\n`;
  msg += `\n💎 <i>Advance Pro Intelligence</i>`;

  await safeSend(TG_CHAT_ID, msg);
});

// India Market Open Scan: 9:20 AM IST
cronIST('20 9 * * 1-5', async () => {
  if (!autoAlerts || portfolio.length === 0) return;
  console.log('📨 India market open scan...');
  await smartRefreshPrices();
  const report = generateAutoReport(portfolio, livePrices, usdInrRate);
  await safeSend(TG_CHAT_ID, report);
});

// India Mid-Day Scan: 12:00 PM IST
cronIST('0 12 * * 1-5', async () => {
  if (!autoAlerts || portfolio.length === 0) return;
  if (!isIndiaMarketOpen()) return;
  console.log('📨 India mid-day scan...');
  await smartRefreshPrices();
  const report = generateAutoReport(portfolio, livePrices, usdInrRate);
  await safeSend(TG_CHAT_ID, report);
});

// India Market Close Summary: 3:35 PM IST (10:05 UTC)
// NOTE: Duplicate removed — a richer close summary already fires at 10:15 UTC (3:45 PM IST).
// Only the P&L recording cron below remains at this time slot.

// US Market Open Scan: 7:05 PM IST
cronIST('5 19 * * 1-5', async () => {
  if (!autoAlerts || portfolio.length === 0) return;
  const hasUS = portfolio.some(p => p.market === 'US');
  if (!hasUS) return;
  console.log('📨 US market open scan...');
  await smartRefreshPrices();

  let msg = `🇺🇸 <b>US MARKET OPEN — Scan Report</b>\n`;
  msg += `⏰ <i>${getISTTime()} IST</i>\n\n`;

  const usPositions = portfolio.filter(p => p.market === 'US');
  for (const p of usPositions) {
    const key = `US_${p.symbol}`;
    const data = livePrices[key];
    const curPrice = data?.price || p.avgPrice;
    const change = data?.change || 0;
    const rsi = data?.rsi || 50;
    const pl = (curPrice - p.avgPrice) * p.qty;

    msg += `• <b>${p.symbol}</b>: $${curPrice.toFixed(2)} (${change >= 0 ? '+' : ''}${change.toFixed(2)}%)\n`;
    msg += `  RSI: ${rsi.toFixed(0)} | P&L: ${pl >= 0 ? '+' : ''}$${pl.toFixed(2)}\n`;
  }

  msg += `\n💎 <i>Advance Pro Intelligence</i>`;
  await safeSend(TG_CHAT_ID, msg);
});

// ────────────────────────────────────────
// ────────────────────────────────────────
// 24x7 STRONG SIGNAL + VIX SPIKE + BIG MOVE SCANNER
// Every 15 min: STRONG_BUY/SELL + VIX spike + big intraday moves (crypto 24x7)
// ────────────────────────────────────────
const lastSignalAlert = new Map(); // `${symbol}_${signal}` → timestamp (2h dedupe)
const lastMoveAlert = new Map();   // `${symbol}` → timestamp (3h dedupe)

cron.schedule('*/15 * * * *', async () => {
  if (!autoAlerts || portfolio.length === 0 || !TG_CHAT_ID) return;
  try {
    await smartRefreshPrices();
    const now = Date.now();
    const alerts = [];
    const bigMoves = [];

    for (const p of portfolio) {
      const data = livePrices[`${p.market}_${p.symbol}`];
      if (!data || !data.price) continue;

      // Strong signal detection
      const sig = analyzeAsset(p, data);
      if ((sig.signal === 'STRONG_BUY' || sig.signal === 'STRONG_SELL') && sig.confidence >= 85) {
        const key = `${p.symbol}_${sig.signal}`;
        if (!lastSignalAlert.has(key) || now - lastSignalAlert.get(key) >= 2 * 60 * 60 * 1000) {
          lastSignalAlert.set(key, now);
          const price = data.price;
          const low = data.low || price * 0.98;
          const high = data.high || price * 1.02;
          const range = Math.max(high - low, price * 0.005);
          const isBuy = sig.signal === 'STRONG_BUY';
          const sl = isBuy ? low - range * 0.382 : high + range * 0.382;
          const target = isBuy ? high + range * 0.382 : low - range * 0.382;
          alerts.push({ p, sig, price, sl, target, rsi: data.rsi || 50 });
        }
      }

      // Big move detection (24x7, crypto bhi)
      const chg = data.change || 0;
      if (Math.abs(chg) >= 4) {
        if (!lastMoveAlert.has(p.symbol) || now - lastMoveAlert.get(p.symbol) >= 3 * 60 * 60 * 1000) {
          lastMoveAlert.set(p.symbol, now);
          bigMoves.push({ p, price: data.price, change: chg, rsi: data.rsi || 50 });
        }
      }
    }

    // Strong signal alert
    if (alerts.length > 0) {
      let msg = `🚨 <b>STRONG SIGNAL ALERT — Exact Price Points</b>\n⏰ <i>${getISTTime()} IST</i>\n━━━━━━━━━━━━━━━━━━━━━━━\n\n`;
      for (const a of alerts) {
        const cur = a.p.market === 'IN' ? '₹' : '$';
        const icon = a.sig.signal === 'STRONG_BUY' ? '🟢🟢' : '🔴🔴';
        msg += `${icon} <b>${a.p.symbol.replace('.NS', '')}</b> — ${a.sig.signal.replace('_', ' ')} (${a.sig.confidence}%)\n`;
        msg += `📍 Entry: <b>${cur}${a.price.toFixed(2)}</b> | RSI: ${a.rsi.toFixed(0)}\n`;
        msg += `🛡️ SL: <b>${cur}${a.sl.toFixed(2)}</b> | 🎯 Target: <b>${cur}${a.target.toFixed(2)}</b>\n`;
        if (a.sig.reason) msg += `💡 <i>${a.sig.reason}</i>\n`;
        msg += `\n`;
      }
      msg += `<i>⚡ 24x7 Auto Scanner | /alert off to disable</i>`;
      await safeSend(TG_CHAT_ID, msg);
      console.log(`🚨 Sent ${alerts.length} strong signal alert(s)`);
    }

    // Big move alert (Hinglish)
    if (bigMoves.length > 0) {
      let msg = `⚡ <b>BIG MOVE ALERT — Portfolio Hil Gaya!</b>\n⏰ <i>${getISTTime()} IST</i>\n━━━━━━━━━━━━━━━━━━━━━━━\n\n`;
      for (const b of bigMoves) {
        const cur = b.p.market === 'IN' ? '₹' : '$';
        const dir = b.change >= 0 ? '🟢 UP' : '🔴 DOWN';
        msg += `${dir} <b>${b.p.symbol.replace('.NS', '')}</b>: ${cur}${b.price.toFixed(2)} (${b.change >= 0 ? '+' : ''}${b.change.toFixed(2)}%)\n`;
        msg += `   RSI: ${b.rsi.toFixed(0)} | ${b.change >= 0 ? 'Profit book ya hold? AI se pucho' : 'Dip hai - accumulate zone check karo'}\n`;
      }
      msg += `\n<i>Bhai, koi major move hua hai. /scan &lt;symbol&gt; ya AI chat se detail le lo.</i>`;
      await safeSend(TG_CHAT_ID, msg);
      console.log(`⚡ Sent ${bigMoves.length} big move alert(s)`);
    }

    // VIX spike alert (uses market.mjs trackVixChange)
    const vixSpike = trackVixChange(livePrices);
    if (vixSpike) {
      let msg = `🌪️ <b>VIX SPIKE ALERT — Volatility Badh Gayi!</b>\n⏰ <i>${getISTTime()} IST</i>\n━━━━━━━━━━━━━━━━━━━━━━━\n\n`;
      msg += `Severity: <b>${vixSpike.severity}</b>\n`;
      msg += `🇺🇸 US VIX: <b>${vixSpike.usVix.toFixed(1)}</b> (${vixSpike.usChange >= 0 ? '+' : ''}${vixSpike.usChange.toFixed(1)}%)\n`;
      msg += `🇮🇳 India VIX: <b>${vixSpike.inVix.toFixed(1)}</b> (${vixSpike.inChange >= 0 ? '+' : ''}${vixSpike.inChange.toFixed(1)}%)\n\n`;
      if (vixSpike.usChange > 0 || vixSpike.inChange > 0) {
        msg += `⚠️ <i>Fear badh raha hai. Naya cash bachao, deep dips pe staged buy karo. Panic mat karo - SIP chalu rakho.</i>`;
      } else {
        msg += `✅ <i>VIX cool ho raha hai. Fear kam, accumulation ke liye achha window.</i>`;
      }
      await safeSend(TG_CHAT_ID, msg);
      console.log(`🌪️ Sent VIX spike alert (${vixSpike.severity})`);
    }

    // ===== SUPERINTELLIGENCE v4.0 — PORTFOLIO NEWS SCAN (hourly) =====
    // Every hour, fetch portfolio-specific news for top 5 holdings and alert
    // on any MATERIAL negative/positive catalysts. Dedupe by headline hash
    // so the same story doesn't fire twice in 6h.
    const lastNewsScanRef = globalThis._lastNewsScanTs || 0;
    if (Date.now() - lastNewsScanRef >= 60 * 60 * 1000 && TAVILY_API_KEY) {
      // FIX H4: don't set the throttle timestamp until the fetch SUCCEEDS —
      // otherwise a transient Tavily outage causes a 1-hour blind window.
      try {
        const topHoldings = [...portfolio]
          .sort((a, b) => ((livePrices[`${b.market}_${b.symbol}`]?.price || b.avgPrice) * b.qty) - ((livePrices[`${a.market}_${a.symbol}`]?.price || a.avgPrice) * a.qty))
          .slice(0, 5)
          .map(p => p.symbol.replace('.NS', '').replace('.BO', ''));
        if (topHoldings.length > 0) {
          const newsQuery = `${topHoldings.join(' ')} stock news latest breaking quarterly results insider institutional moves today`;
          // Reuse the existing fetchRealtimeWebData from ai-chat.mjs via a tiny
          // Tavily call here. We don't want to import the whole module, so do
          // a direct fetch.
          const tavilyRes = await fetch('https://api.tavily.com/search', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              api_key: TAVILY_API_KEY,
              query: newsQuery,
              search_depth: 'basic',
              max_results: 5,
              include_answer: false,
            }),
            signal: AbortSignal.timeout(10000),
          });
          if (tavilyRes.ok) {
            const tData = await tavilyRes.json();
            const seen = globalThis._seenNewsHeadlines || new Set();
            const materialKeywords = /\b(beat|miss|surge|crash|plunge|record|downgrade|upgrade|fraud|scam|investigation|default|acquisition|merger|results|profit|loss|rally|breakout|breakdown)\b/i;
            const newItems = (tData.results || []).filter(r => {
              const h = (r.title || '').trim();
              return h && !seen.has(h) && materialKeywords.test(r.title + ' ' + r.content);
            });
            if (newItems.length > 0) {
              let newsMsg = `📰 <b>PORTFOLIO NEWS ALERT</b>\n⏰ <i>${getISTTime()} IST</i>\n━━━━━━━━━━━━━━━━━━━━━━━\n\n`;
              // FIX M1: escape HTML special chars in headlines/summaries so
              // Telegram doesn't reject the message when titles contain <, &, >.
              const esc = (s) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
              for (const n of newItems.slice(0, 3)) {
                seen.add((n.title || '').trim());
                const sentiment = /\b(beat|surge|rally|gain|profit|growth|upgrade|buy|bullish|record|high|jump|rise|boost|strong|outperform)\b/i.test(n.title + ' ' + n.content) ? '🟢'
                  : /\b(miss|fall|drop|decline|loss|downgrade|sell|bearish|low|crash|plunge|weak|underperform|fraud|scam|investigation|default)\b/i.test(n.title + ' ' + n.content) ? '🔴'
                  : '⚪';
                newsMsg += `${sentiment} <b>${esc((n.title || '').substring(0, 90))}</b>\n`;
                newsMsg += `   <i>${esc((n.content || '').substring(0, 150))}...</i>\n\n`;
              }
              newsMsg += `<i>Source: Tavily web search · top ${topHoldings.length} holdings scanned</i>`;
              await safeSend(TG_CHAT_ID, newsMsg);
              console.log(`📰 Sent portfolio news alert: ${newItems.length} material item(s)`);
              // Prune seen set to last 100 headlines to bound memory.
              if (seen.size > 100) {
                const arr = Array.from(seen);
                seen.clear();
                arr.slice(-50).forEach(h => seen.add(h));
              }
              globalThis._seenNewsHeadlines = seen;
            }
          }
        }
        // FIX H4: only update the throttle timestamp after a successful fetch
        // (regardless of whether alerts were sent). This way, a transient
        // Tavily outage lets us retry on the next 15-min cron tick instead of
        // waiting a full hour.
        globalThis._lastNewsScanTs = Date.now();
      } catch (e) {
        console.warn('⚠️ Portfolio news scan failed (will retry next tick):', e.message);
      }
    }
  } catch (e) {
    console.warn('⚠️ Scanner error:', e.message);
  }
});


// ========================================
// /live — Real-Time Market Sensor (ALL data)
// ========================================
bot.onText(/^\/live(@\w+)?$/i, async (msg) => {
  if (!isAuthorized(msg)) return;
  await safeSend(msg.chat.id, '📡 <b>Fetching live sensor data...</b>', { parse_mode: 'HTML' });
  try {
    const [intel, coindcx, bonds] = await Promise.allSettled([
      fetchMarketIntelligence(),
      fetchCryptoPricesINR(),
      fetchBondYields()
    ]);
    let source = 'TRADINGVIEW';
    let cryptos = coindcx.status === 'fulfilled' && coindcx.value.length > 0 ? coindcx.value : [];
    if (cryptos.length === 0) {
      source = 'TRADINGVIEW';
      const tvCrypto = await fetchCryptoPrices();
      cryptos = tvCrypto;
    } else {
      source = 'COINDCX';
    }
    const report = generateLiveReport(
      intel.status === 'fulfilled' ? intel.value : null,
      cryptos,
      bonds.status === 'fulfilled' ? bonds.value : [],
      usdInrRate,
      source
    );
    await safeSend(msg.chat.id, report);
  } catch (e) {
    await safeSend(msg.chat.id, `❌ Error: ${e.message}`);
  }
});

// ========================================
// /crypto — Crypto Market Report (CoinDCX INR)
// ========================================
bot.onText(/^\/crypto(@\w+)?$/i, async (msg) => {
  if (!isAuthorized(msg)) return;
  await safeSend(msg.chat.id, '🪙 <b>Fetching crypto prices from CoinDCX...</b>', { parse_mode: 'HTML' });
  try {
    const cryptos = await fetchCryptoPricesINR();
    if (cryptos.length > 0) {
      const report = generateCryptoReport(cryptos, usdInrRate, 'COINDCX');
      await safeSend(msg.chat.id, report);
    } else {
      const fallback = await fetchCryptoPrices();
      const report = generateCryptoReport(fallback, usdInrRate, 'TRADINGVIEW');
      await safeSend(msg.chat.id, report);
    }
    // v10.15 (recheck #2 S2): cross-reference — /coindcx is the ACCOUNT
    // status view, /crypto is the MARKET price view. One line each way,
    // no more "dono kya karte hain?" confusion (NOT aliases — different
    // data paths by design; the dedupe is the shared wording + pointers).
  } catch (e) {
    await safeSend(msg.chat.id, `❌ Error: ${e.message}`);
  }
});

// ========================================
// /sip — SIP Calculator
// ========================================
bot.onText(/^\/sip(?:@\w+)?(?:\s+(\d+))?$/i, async (msg, match) => {
  if (!isAuthorized(msg)) return;
  const amount = parseInt(match?.[1]) || 10000;
  const report = generateSIPReport(amount);
  await safeSend(msg.chat.id, report);
});

// ========================================
// /longterm - 15-20yr Wealth Strategy
// ========================================
bot.onText(/^\/longterm(@\w+)?$/i, async (msg) => {
  if (!isAuthorized(msg)) return;
  const report = generateLongTermReport();
  await safeSend(msg.chat.id, report);
});

// ========================================
// /strategy - Institutional Asset Strategy
// ========================================
bot.onText(/^\/strategy(@\w+)?$/i, async (msg) => {
  if (!isAuthorized(msg)) return;
  await smartRefreshPrices();
  const report = generateStrategyReport(portfolio, livePrices, usdInrRate);
  await safeSend(msg.chat.id, report);
});

// ========================================
// /etf — ETF Portfolio Analysis
// ========================================
bot.onText(/^\/etf(@\w+)?$/i, async (msg) => {
  if (!isAuthorized(msg)) return;
  await smartRefreshPrices();
  const report = generateETFReport(portfolio, livePrices, usdInrRate);
  await safeSend(msg.chat.id, report);
});

// ========================================
// /premarket — Pre-market Intelligence
// ========================================
bot.onText(/^\/premarket(@\w+)?$/i, async (msg) => {
  if (!isAuthorized(msg)) return;
  await safeSend(msg.chat.id, '🌅 <b>Generating Pre-market Intelligence...</b>', { parse_mode: 'HTML' });
  try {
    const response = await chatWithAI(msg.chat.id, 'Generate a comprehensive pre-market briefing. Include global overnight summary, GIFT Nifty/US Futures, portfolio impact, and key events. Use real-time data.', portfolio, livePrices, usdInrRate);
    await safeSend(msg.chat.id, response);
  } catch (e) {
    await safeSend(msg.chat.id, `❌ Error: ${e.message}`);
  }
});

// ========================================
// /digest — Daily Market Digest
// ========================================
bot.onText(/^\/digest(@\w+)?$/i, async (msg) => {
  if (!isAuthorized(msg)) return;
  await safeSend(msg.chat.id, '🌅 <b>Generating daily digest...</b>', { parse_mode: 'HTML' });
  try {
    await smartRefreshPrices();
    const [intel, coindcx, bonds] = await Promise.allSettled([
      fetchMarketIntelligence(),
      fetchCryptoPricesINR(),
      fetchBondYields()
    ]);
    let source = 'TRADINGVIEW';
    let cryptos = coindcx.status === 'fulfilled' && coindcx.value.length > 0 ? coindcx.value : [];
    if (cryptos.length === 0) {
      source = 'TRADINGVIEW';
      const tvCrypto = await fetchCryptoPrices();
      cryptos = tvCrypto;
    } else {
      source = 'COINDCX';
    }
    const report = generateDigestReport(
      intel.status === 'fulfilled' ? intel.value : null,
      cryptos,
      bonds.status === 'fulfilled' ? bonds.value : [],
      usdInrRate, portfolio, livePrices, source
    );
    await safeSend(msg.chat.id, report);
  } catch (e) {
    await safeSend(msg.chat.id, `❌ Error: ${e.message}`);
  }
});

// ========================================
// /fiidii — FII/DII Flow Tracker
// ========================================
bot.onText(/^\/(fiidii|fii|dii)(@\w+)?$/i, async (msg) => {
  if (!isAuthorized(msg)) return;
  // v10.15 (recheck #2 S2): missing-key commands say WHAT they need
  // instead of failing opaquely — evidence-first triage ke liye.
  // v20.7.3 FIX: call the function (was a bare truthy reference).
  if (!isTavilyAvailable()) {
    return safeSend(msg.chat.id, '⚠️ <b>FII/DII flows need the Tavily key</b> — <code>TAVILY_API_KEY</code> env var set nahi hai (Render me add karo). Command ka code sahi hai; key ke bina live search possible nahi.');
  }
  await safeSend(msg.chat.id, '🏛️ <b>Fetching FII/DII flows...</b>', { parse_mode: 'HTML' });
  try {
    const { TAVILY_API_KEY } = await import('./config.mjs');
    const fiiData = await fetchFIIDIIData(TAVILY_API_KEY);
    const report = generateFIIDIIReport(fiiData);
    await safeSend(msg.chat.id, report);
  } catch (e) {
    await safeSend(msg.chat.id, `❌ Error: ${e.message}`);
  }
});

// ========================================
// /ipo — IPO Tracker
// ========================================
bot.onText(/^\/ipo(@\w+)?$/i, async (msg) => {
  if (!isAuthorized(msg)) return;
  // v10.15 (recheck #2 S2): the clear needs-key message
  // v20.7.3 FIX: call the function (was a bare truthy reference).
  if (!isTavilyAvailable()) {
    return safeSend(msg.chat.id, '⚠️ <b>IPO tracker needs the Tavily key</b> — <code>TAVILY_API_KEY</code> env var set nahi hai (Render me add karo). Command ka code sahi hai; key ke bina live search possible nahi.');
  }
  await safeSend(msg.chat.id, '🚀 <b>Fetching IPO data...</b>', { parse_mode: 'HTML' });
  try {
    const { TAVILY_API_KEY } = await import('./config.mjs');
    const ipoData = await fetchIPOData(TAVILY_API_KEY);
    const report = generateIPOReport(ipoData);
    await safeSend(msg.chat.id, report);
  } catch (e) {
    await safeSend(msg.chat.id, `❌ Error: ${e.message}`);
  }
});

// ========================================
// CRON JOBS — Scheduled Automation
// ========================================

// 🌅 8:45 AM IST India Pre-Market — DEEP analysis, ~30 min before 9:15 open
cronIST('45 8 * * 1-5', async () => {
  if (!TG_CHAT_ID) return;
  console.log(`🌅 India Pre-Market triggered at ${getISTTime()} IST`);
  try {
    await Promise.allSettled([refreshPortfolio(), refreshPrices(), refreshIntel()]);
    await smartRefreshPrices();
    const response = await chatWithAI(TG_CHAT_ID, 'INDIA PRE-MARKET DEEP ANALYSIS (8:45 AM, market 9:15 me khulega). Detail me do: (1) global/US overnight + Asian markets summary, (2) GIFT Nifty signal aur expected India open, (3) FII/DII flows + key macro events/news aaj ke, (4) mere portfolio ke har India position pe aaj ka impact + exact levels, (5) top 3 action items aur 1 Pro Tip. Simple Hinglish, real-time data use karo.', portfolio, livePrices, usdInrRate);
    await safeSend(TG_CHAT_ID, `🔔 <b>INDIA PRE-MARKET DEEP ANALYSIS</b>\n🕐 ${getISTTime()} IST · Market opens 9:15 AM\n\n${response}`);
  } catch (e) {
    console.error('India Pre-Market failed:', e.message);
  }
});

// 🌆 6:30 PM IST US Pre-Market — DEEP analysis, ~30 min before 7:00 PM IST (9:30 ET) open
cronIST('30 18 * * 1-5', async () => {
  if (!TG_CHAT_ID) return;
  console.log(`🌆 US Pre-Market triggered at ${getISTTime()} IST`);
  try {
    await Promise.allSettled([refreshPortfolio(), refreshPrices(), refreshIntel()]);
    await smartRefreshPrices();
    const response = await chatWithAI(TG_CHAT_ID, 'US PRE-MARKET DEEP ANALYSIS (6:30 PM IST, US market 7:00 PM IST/9:30 ET me khulega). Detail me do: (1) US futures (S&P/Nasdaq/Dow) + pre-market movers, (2) crypto (BTC/ETH) overnight move, (3) key US macro events/earnings/Fed news aaj ke, (4) mere portfolio ke har US holding pe expected impact + exact levels, (5) top 3 action items aur 1 Pro Tip. Simple Hinglish, real-time data use karo.', portfolio, livePrices, usdInrRate);
    await safeSend(TG_CHAT_ID, `🔔 <b>US PRE-MARKET DEEP ANALYSIS</b>\n🕐 ${getISTTime()} IST · US opens 7:00 PM IST\n\n${response}`);
  } catch (e) {
    console.error('US Pre-Market failed:', e.message);
  }
});

// 🌅 8:00 AM IST Daily Digest — Morning Brief
cronIST('0 8 * * 1-5', async () => {
  if (!TG_CHAT_ID) return;
  console.log(`🌅 Daily Digest triggered at ${getISTTime()} IST`);
  try {
    await smartRefreshPrices();
    const [intel, coindcx, bonds] = await Promise.allSettled([
      fetchMarketIntelligence(),
      fetchCryptoPricesINR(),
      fetchBondYields()
    ]);
    let source = 'TRADINGVIEW';
    let cryptos = coindcx.status === 'fulfilled' && coindcx.value.length > 0 ? coindcx.value : [];
    if (cryptos.length === 0) {
      source = 'TRADINGVIEW';
      const tvCrypto = await fetchCryptoPrices();
      cryptos = tvCrypto;
    } else {
      source = 'COINDCX';
    }
    const report = generateDigestReport(
      intel.status === 'fulfilled' ? intel.value : null,
      cryptos,
      bonds.status === 'fulfilled' ? bonds.value : [],
      usdInrRate, portfolio, livePrices, source
    );
    await safeSend(TG_CHAT_ID, report);
    console.log('🌅 Daily digest sent successfully');
  } catch (e) {
    console.error('🌅 Daily digest failed:', e.message);
  }
});

// Duplicate pre-market cron removed — already handled at line 1026

// 🔔 3:45 PM IST Market Close Summary
cronIST('45 15 * * 1-5', async () => {
  // 15:45 IST (after India close)
  if (!autoAlerts || portfolio.length === 0) return;
  try {
    await smartRefreshPrices();
    const metrics = calculateMetrics(portfolio, livePrices, usdInrRate);
    let msg = `🔔 <b>MARKET CLOSE SUMMARY</b>\n`;
    msg += `⏰ India market closed\n\n`;
    msg += `💼 <b>Portfolio:</b> ₹${Math.round(metrics.totalValue).toLocaleString('en-IN')}\n`;
    msg += `📊 <b>Today:</b> ${metrics.todayPL >= 0 ? '🟢 +' : '🔴 '}₹${Math.round(Math.abs(metrics.todayPL)).toLocaleString('en-IN')} (${metrics.todayPct >= 0 ? '+' : ''}${metrics.todayPct.toFixed(2)}%)\n`;
    msg += `📈 <b>Overall:</b> ${metrics.totalPL >= 0 ? '🟢 +' : '🔴 '}₹${Math.round(Math.abs(metrics.totalPL)).toLocaleString('en-IN')}\n`;
    msg += `\n💎 <i> • Closing Bell</i>`;
    await safeSend(TG_CHAT_ID, msg);
  } catch (e) {
    console.error('Market close summary failed:', e.message);
  }
});



// Record daily P&L at India market close — 3:40 PM IST
cronIST('40 15 * * 1-5', async () => {
  if (!TG_CHAT_ID) return;
  if (portfolio.length === 0) return;
  await smartRefreshPrices();
  const metrics = calculateMetrics(portfolio, livePrices, usdInrRate);
  const today = new Date().toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short' });

  dailyPLHistory.push({ date: today, pl: metrics.todayPL, pct: metrics.todayPct });
  if (dailyPLHistory.length > 30) dailyPLHistory = dailyPLHistory.slice(-30);

  // Update streak
  if (metrics.todayPL >= 0) {
    consecutiveStreak = consecutiveStreak >= 0 ? consecutiveStreak + 1 : 1;
  } else {
    consecutiveStreak = consecutiveStreak <= 0 ? consecutiveStreak - 1 : -1;
  }

  console.log(`📈 Daily P&L recorded: ₹${Math.round(metrics.todayPL)} | Streak: ${consecutiveStreak}`);
  saveStreakData();
});

// ========================================
// ERROR HANDLING
// ========================================
let _pollErrLast = {};   // v11.4: polling_error log throttle state (per code)
bot.on('polling_error', (error) => {
  // v11.4 recheck: the library retries getUpdates every ~300ms by default
  // and this handler logged EVERY failure — a network outage (or a dead
  // token → 401) printed ~200 console.error lines/min for the whole
  // outage on Render's capped logs. Throttle to one line/min per code,
  // and on a PERMANENT 401 exit so the parent's capped restart backoff
  // can engage instead of spinning forever.
  const code = String(error?.code || '?');
  const now = Date.now();
  if (!_pollErrLast[code] || now - _pollErrLast[code] > 60_000) {
    _pollErrLast[code] = now;
    console.error(`❌ Polling error (${code}):`, error.message);
    if (code === 'ETELEGRAM' && String(error.message || '').includes('409')) {
      console.error('⚠️  CONFLICT: webhook is registered for this token (or another poller runs). Use TG_MODE + webhook setup consistently.');
    }
  }
  if (code === 'ETELEGRAM' && String(error.message || '').includes('401')) {
    console.error('⚠️  UNAUTHORIZED: bot token invalid — exiting so the supervisor backoff can engage.');
    process.exit(1);
  }
});

bot.on('error', (error) => {
  console.error('❌ Bot error:', error.message);
});

process.on('uncaughtException', (error) => {
  console.error('❌ Uncaught exception:', error.message, error.stack);
});

process.on('unhandledRejection', (reason) => {
  console.error('❌ Unhandled rejection:', reason);
});

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\n🛑 Bot shutting down gracefully...');
  bot.stopPolling();
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('\n🛑 Bot terminated.');
  bot.stopPolling();
  process.exit(0);
});
// ========================================
// COMMAND: /siptilt — Smart SIP Auto-Tilt
// ========================================
bot.onText(/^\/siptilt(@\w+)?$/i, async (msg) => {
  if (!isAuthorized(msg)) return;
  const chatId = msg.chat.id;
  console.log(`📥 /siptilt from ${msg.from?.first_name || chatId}`);
  try {
    if (portfolio.length === 0) { await safeSend(chatId, '⚠️ Portfolio empty hai. Pehle assets add karo.'); return; }
    await smartRefreshPrices();
    const report = generateSipTiltReport(portfolio, livePrices, usdInrRate);
    await safeSend(chatId, report);
  } catch (e) {
    console.error('❌ /siptilt error:', e.message);
    await safeSend(chatId, `❌ SIP Tilt error: ${e.message}`);
  }
});

// ========================================
// COMMAND: /taxplan — India Tax Optimizer
// ========================================
bot.onText(/^\/taxplan(@\w+)?$/i, async (msg) => {
  if (!isAuthorized(msg)) return;
  const chatId = msg.chat.id;
  console.log(`📥 /taxplan from ${msg.from?.first_name || chatId}`);
  try {
    if (portfolio.length === 0) { await safeSend(chatId, '⚠️ Portfolio empty hai.'); return; }
    await smartRefreshPrices();
    const report = generateTaxPlanReport(portfolio, livePrices, usdInrRate);
    await safeSend(chatId, report);
  } catch (e) {
    console.error('❌ /taxplan error:', e.message);
    await safeSend(chatId, `❌ Tax plan error: ${e.message}`);
  }
});

// ========================================
// COMMAND: /drawdown — Drawdown Recovery Tracker
// ========================================
bot.onText(/^\/drawdown(@\w+)?$/i, async (msg) => {
  if (!isAuthorized(msg)) return;
  const chatId = msg.chat.id;
  console.log(`📥 /drawdown from ${msg.from?.first_name || chatId}`);
  try {
    if (portfolio.length === 0) { await safeSend(chatId, '⚠️ Portfolio empty hai.'); return; }
    await smartRefreshPrices();
    const report = generateDrawdownReport(portfolio, livePrices, usdInrRate);
    await safeSend(chatId, report);
  } catch (e) {
    console.error('❌ /drawdown error:', e.message);
    await safeSend(chatId, `❌ Drawdown error: ${e.message}`);
  }
});


// ────────────────────────────────────────
// 🤖 ML SERVICE COMMANDS
// ────────────────────────────────────────
// FIX C3: Previously pointed to dead Python service at localhost:8000.
// Now points to the in-process Node.js ML engine at /api/ml/* on the
// main Express server (port 8080 by default).
const ML_SERVICE_URL = process.env.ML_SERVICE_URL || `http://localhost:${process.env.PORT || 8080}/api/ml`;

async function fetchMLSignal(symbol, market = 'IN') {
  const res = await fetch(`${ML_SERVICE_URL}/predict`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ symbol, market, price: 0, change: 0 }),
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`ML service returned ${res.status}`);
  return res.json();
}

async function fetchMLRegime() {
  const res = await fetch(`${ML_SERVICE_URL}/regime`, { signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error(`ML regime service returned ${res.status}`);
  return res.json();
}

async function fetchMLBacktest(symbol, market = 'IN') {
  const res = await fetch(`${ML_SERVICE_URL}/backtest`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ symbol, candles: [] }),
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`ML backtest service returned ${res.status}`);
  return res.json();
}

// /ml — Get ML signal for a stock
bot.onText(/^\/ml(?:@\w+)?(?:\s+(.+))?$/i, async (msg, match) => {
  if (!isAuthorized(msg)) return;
  const chatId = msg.chat.id;
  const input = (match[1] || '').trim().toUpperCase();
  console.log(`📥 /ml ${input} from ${msg.from?.first_name || chatId}`);

  try {
    if (!input) {
      await safeSend(chatId, '📋 <b>Usage:</b> /ml RELIANCE or /ml AAPL\n\nFetches ML signal (LightGBM calibrated prediction) for the stock.');
      return;
    }

    await safeSend(chatId, `🤖 <i>Running ML prediction for ${input}...</i>`);

    const { guessMarket: guessMarketML } = await import('./config.mjs');
    const market = guessMarketML(input);
    const pred = await fetchMLSignal(input, market);

    const signalEmoji = pred.signal?.includes('BUY') ? '🟢' : pred.signal?.includes('SELL') ? '🔴' : '🟡';
    const cur = market === 'IN' ? '₹' : '$';
    const pts = pred.price_points || {};
    const qt = pred.price_targets || {};

    let report = `${signalEmoji} <b>ML SIGNAL — ${input}</b>\n`;
    report += `━━━━━━━━━━━━━━━━━\n`;
    report += `<b>Signal:</b> ${pred.signal?.replace('_', ' ')}\n`;
    report += `<b>Confidence:</b> ${pred.confidence?.toFixed(1)}% (calibrated)\n\n`;

    if (qt.P10 || qt.P50 || qt.P90) {
      report += `📊 <b>90-Day Targets (Quantile):</b>\n`;
      if (qt.P10) report += `  Bear: ${cur}${qt.P10.target_price?.toFixed(0)} (${qt.P10.expected_return}%) \n`;
      if (qt.P50) report += `  Base: ${cur}${qt.P50.target_price?.toFixed(0)} (${qt.P50.expected_return}%) \n`;
      if (qt.P90) report += `  Bull: ${cur}${qt.P90.target_price?.toFixed(0)} (${qt.P90.expected_return}%)\n\n`;
    }

    if (pts.entry) {
      report += `🎯 <b>Entry / Risk:</b>\n`;
      report += `  Entry: ${cur}${pts.entry}\n`;
      report += `  Stop Loss: ${cur}${pts.stop_loss}\n`;
      report += `  Target 1: ${cur}${pts.tp1}\n`;
      report += `  Target 2: ${cur}${pts.tp2}\n`;
      report += `  Target 3: ${cur}${pts.tp3}\n`;
      report += `  R:R: ${pts.risk_reward}\n\n`;
    }

    if (pred.top_features?.length > 0) {
      report += `🔑 Top Drivers: ${pred.top_features.map(f => f.feature).join(', ')}\n`;
    }

    report += `\n⏱️ ${pred.timestamp || new Date().toISOString()}`;

    await safeSend(chatId, report);
  } catch (e) {
    console.error('❌ /ml error:', e.message);
    await safeSend(chatId, `❌ ML signal error: ${e.message}\n\nML engine runs in-process in the main server. Make sure /api/ml/* endpoints are available.`);
  }
});

// /mlregime — Get ML regime detection
bot.onText(/^\/mlregime(@\w+)?$/i, async (msg) => {
  if (!isAuthorized(msg)) return;
  const chatId = msg.chat.id;
  console.log(`📥 /mlregime from ${msg.from?.first_name || chatId}`);

  try {
    await safeSend(chatId, '🤖 <i>Fetching ML regime detection...</i>');
    const regime = await fetchMLRegime();

    const regimeEmoji = { RISK_ON: '🟢', RISK_OFF: '🔴', STAGFLATION: '🟠', GOLDILOCKS: '💎' };

    let report = `${regimeEmoji[regime.regime] || '⚪'} <b>ML REGIME DETECTION (HMM)</b>\n`;
    report += `━━━━━━━━━━━━━━━━━\n`;
    report += `<b>Regime:</b> ${regime.regime?.replace('_', ' ')}\n`;
    report += `<b>Probability:</b> ${(regime.probability * 100).toFixed(1)}%\n\n`;

    if (regime.sip_multiplier) {
      report += `💰 <b>SIP Multiplier:</b> ${regime.sip_multiplier}x\n`;
      if (regime.sip_multiplier > 1) report += `  → Increase SIP by ${((regime.sip_multiplier - 1) * 100).toFixed(0)}%\n`;
      else if (regime.sip_multiplier < 1) report += `  → Reduce SIP by ${((1 - regime.sip_multiplier) * 100).toFixed(0)}%\n`;
      else report += `  → Keep SIP at normal level\n\n`;
    }

    if (regime.state_sequence) {
      report += `📈 Recent states: ${regime.state_sequence.slice(-5).join(' → ')}\n`;
    }

    await safeSend(chatId, report);
  } catch (e) {
    console.error('❌ /mlregime error:', e.message);
    await safeSend(chatId, `❌ ML regime error: ${e.message}`);
  }
});

// /mlbacktest — Run ML backtest for a stock
bot.onText(/^\/mlbacktest(?:@\w+)?(?:\s+(.+))?$/i, async (msg, match) => {
  if (!isAuthorized(msg)) return;
  const chatId = msg.chat.id;
  const input = (match[1] || '').trim().toUpperCase();
  console.log(`📥 /mlbacktest ${input} from ${msg.from?.first_name || chatId}`);

  try {
    if (!input) {
      await safeSend(chatId, '📋 <b>Usage:</b> /mlbacktest RELIANCE\n\nRuns walk-forward backtest on ML signal for the stock.');
      return;
    }

    await safeSend(chatId, `🧪 <i>Running ML backtest for ${input} (walk-forward)...</i>`);

    const { guessMarket: guessMarketBT } = await import('./config.mjs');
    const market = guessMarketBT(input);
    const bt = await fetchMLBacktest(input, market);

    let report = `🧪 <b>ML BACKTEST — ${input}</b>\n`;
    report += `━━━━━━━━━━━━━━━━━\n`;
    report += `<b>Period:</b> ${bt.start_date} → ${bt.end_date}\n`;
    report += `<b>Trades:</b> ${bt.total_trades}\n`;
    report += `<b>Hit Rate:</b> ${bt.hit_rate}%\n`;
    report += `<b>Total Return:</b> ${bt.total_return}%\n`;
    report += `<b>Max Drawdown:</b> ${bt.max_drawdown}%\n`;
    report += `<b>Avg Win:</b> ${bt.avg_win}%\n`;
    report += `<b>Avg Loss:</b> ${bt.avg_loss}%\n`;
    report += `<b>Sharpe:</b> ${bt.sharpe_ratio}\n`;

    await safeSend(chatId, report);
  } catch (e) {
    console.error('❌ /mlbacktest error:', e.message);
    await safeSend(chatId, `❌ ML backtest error: ${e.message}`);
  }
});

// /rebalance — Regime-aware portfolio rebalancing
bot.onText(/^\/rebalance(@\w+)?$/i, async (msg) => {
  if (!isAuthorized(msg)) return;
  const chatId = msg.chat.id;
  console.log(`📥 /rebalance from ${msg.from?.first_name || chatId}`);

  try {
    if (portfolio.length === 0) { await safeSend(chatId, '⚠️ Portfolio empty hai.'); return; }
    await smartRefreshPrices();

    // Get ML regime first, fallback to basic
    let regime = 'RISK_ON';
    let sipMultiplier = 1.0;
    try {
      const r = await fetchMLRegime();
      regime = r.regime;
      sipMultiplier = r.sip_multiplier;
    } catch (e) { /* ML service may be down */ }

    const metrics = calculateMetrics(portfolio, livePrices, usdInrRate);
    const totalValue = metrics.totalInvested + metrics.totalPL;

    // Regime-based allocation targets
    const allocations = {
      RISK_ON: { equity: 80, debt: 10, gold: 5, cash: 5 },
      RISK_OFF: { equity: 40, debt: 30, gold: 20, cash: 10 },
      GOLDILOCKS: { equity: 70, debt: 15, gold: 10, cash: 5 },
      STAGFLATION: { equity: 45, debt: 25, gold: 20, cash: 10 },
    };

    const target = allocations[regime] || allocations['RISK_ON'];

    let report = `🔄 <b>REGIME-AWARE REBALANCING</b>\n`;
    report += `━━━━━━━━━━━━━━━━━\n`;
    report += `<b>Current Regime:</b> ${regime.replace('_', ' ')}\n`;
    report += `<b>SIP Multiplier:</b> ${sipMultiplier}x\n`;
    report += `<b>Portfolio Value:</b> ₹${totalValue.toLocaleString('en-IN')}\n\n`;

    report += `📊 <b>Target Allocation (${regime}):</b>\n`;
    report += `  Equity: ${target.equity}%\n`;
    report += `  Debt: ${target.debt}%\n`;
    report += `  Gold: ${target.gold}%\n`;
    report += `  Cash: ${target.cash}%\n\n`;

    report += `💡 <b>Recommendations:</b>\n`;
    if (regime === 'RISK_OFF') {
      report += `  → Move ${10}% from equity to debt/gold\n`;
      report += `  → Reduce SIP by ${((1 - sipMultiplier) * 100).toFixed(0)}%\n`;
      report += `  → Focus on defensive sectors (Pharma, FMCG, IT)\n`;
    } else if (regime === 'STAGFLATION') {
      report += `  → Reduce equity, increase gold & commodities\n`;
      report += `  → Avoid rate-sensitive sectors (Banks, Real Estate)\n`;
    } else if (regime === 'RISK_ON') {
      report += `  → Increase SIP by ${((sipMultiplier - 1) * 100).toFixed(0)}%\n`;
      report += `  → Favor growth sectors (IT, Auto, Chemicals)\n`;
    } else {
      report += `  → Balanced approach, slight tilt to quality\n`;
    }

    report += `\n⚠️ This is guidance, not financial advice. Consult your advisor.`;
    await safeSend(chatId, report);
  } catch (e) {
    console.error('❌ /rebalance error:', e.message);
    await safeSend(chatId, `❌ Rebalance error: ${e.message}`);
  }
});


// ========================================
// COMMAND: /super — SUPERINTELLIGENCE BRIEF v6.0 (one-shot deep report)
// Regime + Portfolio P&L + Top signals + Warnings + Opportunities in ONE
// message. Deterministic core ALWAYS works (no LLM key needed); "/super ai"
// re-narrates the same numbers via the best LLM engine. Inline buttons let
// you refresh or narrate in one tap.
// ========================================

// Shared builder — returns the brief text, or null when portfolio is empty.
async function buildSuperBriefText() {
  if (portfolio.length === 0) {
    await refreshPortfolio().catch(() => {});
  }
  await smartRefreshPrices();
  if (portfolio.length === 0) return null;

  const metrics = calculateMetrics(portfolio, livePrices, usdInrRate);

  // Regime from cached VIX (same heuristic as /health)
  const vixUS = livePrices['US_VIX']?.price || 0;
  const vixIN = livePrices['IN_INDIAVIX']?.price || 0;
  const avgVix = (vixUS + vixIN) / 2 || null;
  let regime = '🟢 RISK ON', regimeLine = 'Normal conditions — SIP continue karo.';
  if (avgVix && avgVix > 30) { regime = '🔴🔴 RISK OFF (Panic)'; regimeLine = 'VIX spike! Cash bachao, sirf deep staged buys.'; }
  else if (avgVix && avgVix > 22) { regime = '🟠 ELEVATED VOLATILITY'; regimeLine = 'Choppy market. Chhote sizes, quality names only.'; }
  else if (avgVix && avgVix < 14) { regime = '💎 GOLDILOCKS'; regimeLine = 'Calm market — dips pe aggressively accumulate.'; }

  // Score every holding
  const signals = portfolio.map(p => {
    const pd = livePrices[`${p.market}_${p.symbol}`];
    return { pos: p, sig: analyzeAsset(p, pd) };
  });

  const buys = signals.filter(x => x.sig.action === 'BUY').sort((a, b) => b.sig.confidence - a.sig.confidence);
  const sells = signals.filter(x => x.sig.action === 'SELL').sort((a, b) => b.sig.confidence - a.sig.confidence);
  const strongBuys = buys.filter(x => x.sig.signal === 'STRONG_BUY');
  const warnings = signals.filter(x => x.sig.rsi > 70 || x.sig.change < -4);
  const opportunities = signals.filter(x => x.sig.rsi < 35 || (x.sig.action === 'BUY' && x.sig.confidence >= 80));

  let r = `🧠 <b>SUPERINTELLIGENCE BRIEF v6.0</b>\n`;
  r += `━━━━━━━━━━━━━━━━━━━━━━━\n`;
  r += `⏰ ${getISTTime()} IST | ${getMarketStatus()}\n\n`;

  r += `<b>1️⃣ MARKET REGIME:</b> ${regime}\n`;
  if (avgVix) r += `   VIX (US ${vixUS.toFixed(1)} / IN ${vixIN.toFixed(1)}) — ${regimeLine}\n\n`;
  else r += `   ${regimeLine}\n\n`;

  const plEmoji = metrics.totalPL >= 0 ? '📈' : '📉';
  r += `<b>2️⃣ PORTFOLIO PULSE:</b>\n`;
  r += `   💼 ₹${Math.round(metrics.totalValue).toLocaleString('en-IN')} | ${plEmoji} ${metrics.totalPL >= 0 ? '+' : ''}₹${Math.round(metrics.totalPL).toLocaleString('en-IN')} (${metrics.plPct.toFixed(1)}%)\n`;
  r += `   📊 Today: ${metrics.todayPL >= 0 ? '+' : ''}₹${Math.round(metrics.todayPL).toLocaleString('en-IN')} (${metrics.todayPct.toFixed(2)}%)\n`;
  r += `   🟢 BUY:${buys.length} | 🔴 SELL:${sells.length} | 🟡 HOLD:${signals.length - buys.length - sells.length}\n\n`;

  r += `<b>3️⃣ TOP SIGNALS:</b>\n`;
  const top = [...buys, ...sells].sort((a, b) => b.sig.confidence - a.sig.confidence).slice(0, 3);
  if (top.length === 0) {
    r += `   ⚪ Sab neutral — don't force trades.\n`;
  } else {
    for (const t of top) {
      const cur = t.pos.market === 'IN' ? '₹' : '$';
      const icon = t.sig.action === 'BUY' ? '🟢' : '🔴';
      r += `   ${icon} <b>${t.sig.symbol}</b> ${t.sig.signal.replace('_', ' ')} (${t.sig.confidence}%) — ${cur}${t.sig.price.toFixed(2)} → target ${cur}${(t.sig.targetPrice || 0).toFixed(2)}\n`;
      r += `      💡 <i>${t.sig.reason}</i>\n`;
    }
  }
  r += `\n`;

  r += `<b>4️⃣ WARNINGS:</b>\n`;
  if (warnings.length === 0 && strongBuys.length === 0) r += `   ✅ Koi red flag nahi.\n`;
  for (const w of warnings.slice(0, 3)) {
    r += `   ⚠️ ${w.sig.symbol}: RSI ${w.sig.rsi.toFixed(0)}, move ${w.sig.change.toFixed(1)}%\n`;
  }
  if (metrics.plPct < -15) r += `   ⚠️ Portfolio drawdown ${metrics.plPct.toFixed(1)}% — risk review recommended.\n`;
  r += `\n`;

  r += `<b>5️⃣ OPPORTUNITIES:</b>\n`;
  if (opportunities.length === 0) r += `   💤 Koi deep-dip setup nahi — SIP is the play.\n`;
  for (const o of opportunities.slice(0, 3)) {
    const cur = o.pos.market === 'IN' ? '₹' : '$';
    r += `   🎯 ${o.sig.symbol}: ${cur}${o.sig.price.toFixed(2)} | RSI ${o.sig.rsi.toFixed(0)} | ${o.sig.confidence}% conviction\n`;
  }
  r += `\n`;

  let verdict;
  if (avgVix && avgVix > 30) verdict = 'DEFENSE MODE — panic mat karo, par naya bada capital mat lagao.';
  else if (strongBuys.length > 0) verdict = `AGGRESSIVE ACCUMULATION — ${strongBuys[0].sig.symbol} STRONG_BUY pe focus.`;
  else if (sells.length > buys.length * 2) verdict = 'PARTIAL PROFIT BOOKING — overbought positions trim karo in parts.';
  else verdict = 'STEADY — SIP chalu, noise ignore, discipline follow.';
  r += `<b>6️⃣ ONE-LINE VERDICT:</b>\n   ${verdict}\n\n`;
  r += `💎 <i> — Superintelligence Engine</i>`;
  return r;
}

const superKeyboard = () => ({
  reply_markup: {
    inline_keyboard: [[
      { text: '🔁 Refresh Brief', callback_data: 'sup:refresh' },
      { text: '🧠 AI Narrate', callback_data: 'sup:ai' },
    ]],
  },
});

// Optional LLM narration — deterministically-computed numbers, LLM only
// explains them (anti-hallucination guard in ai-chat double-checks).
async function narrateSuperBrief(chatId, brief) {
  const narrationPrompt = `Narrate this PRE-COMPUTED portfolio brief in natural Hinglish (bhai-tone, 8-10 lines max). DO NOT change any number — numbers are already computed deterministically. Add one original cross-market insight connecting regime to the top signal. Keep section emojis:\n\n${brief.replace(/<[^>]+>/g, '')}`;
  // Hard cap 35s so /super ai never hangs the bot pipeline
  const response = await Promise.race([
    chatWithAI(chatId, narrationPrompt, portfolio, livePrices, usdInrRate),
    new Promise((_, rej) => setTimeout(() => rej(new Error('narration timeout')), 35000)),
  ]);
  return response;
}

bot.onText(/^\/super(?:@\w+)?(?:\s+(\w+))?$/i, async (msg, match) => {
  if (!isAuthorized(msg)) return;
  const chatId = msg.chat.id;
  const mode = (match?.[1] || '').toLowerCase();
  console.log(`📥 /super ${mode || 'plain'} from ${msg.from?.first_name || chatId}`);
  try {
    const brief = await buildSuperBriefText();
    if (!brief) {
      await safeSend(chatId, '📂 Portfolio khali hai. Web app se assets add karo, phir /super chalao.');
      return;
    }
    if (mode === 'ai') {
      const stopTyping = startTyping(chatId);
      try {
        const narration = await narrateSuperBrief(chatId, brief);
        await safeSend(chatId, `🧠 <b>SUPER BRIEF — AI NARRATED</b>\n\n${narration}`, superKeyboard());
      } catch (e) {
        console.warn('/super ai narration failed, deterministic fallback:', e.message);
        await safeSend(chatId, brief + '\n\n<i>(AI narration unavailable — deterministic brief shown)</i>', superKeyboard());
      } finally {
        stopTyping();
      }
      return;
    }
    await safeSend(chatId, brief, superKeyboard());
  } catch (e) {
    console.error('❌ /super error:', e.message);
    await safeSend(chatId, `❌ Super brief error: ${e.message}`);
  }
});

// ========================================
// COMMAND: /insights <SYMBOL> — Deep Single-Holding Insight
// Portfolio-aware: shows YOUR quantity, avg price, P&L + technical verdict.
// Works for symbols outside the portfolio too (via live fetch).
// ========================================
bot.onText(/^\/insights?(?:@\w+)?(?:\s+(.+))?$/i, async (msg, match) => {
  if (!isAuthorized(msg)) return;
  const chatId = msg.chat.id;
  if (!match[1]) {
    await safeSend(chatId, '⚠️ <b>Usage:</b> <code>/insights RELIANCE</code> or <code>/insights AAPL</code>');
    return;
  }
  const symbol = match[1].trim().toUpperCase().replace('.NS', '').replace('.BO', '');
  console.log(`📥 /insights ${symbol} from ${msg.from?.first_name || chatId}`);
  try {
    await smartRefreshPrices();

    // Is it a holding?
    const holding = portfolio.find(p => p.symbol.replace('.NS', '').replace('.BO', '').toUpperCase() === symbol);
    let pd = holding ? livePrices[`${holding.market}_${holding.symbol}`] : null;

    if (!pd) {
      const fresh = await fetchSingleSymbol(symbol);
      if (!fresh) {
        await safeSend(chatId, `❌ <b>${escapeHtml(symbol)}</b> not found. Try /scan or check the symbol.`);
        return;
      }
      pd = fresh;
    }

    const price = pd.price || holding?.avgPrice || 0;
    const rsi = pd.rsi || 50;
    const change = pd.change || 0;
    const sma20 = pd.sma20 || price;
    const sma50 = pd.sma50 || price;
    const cur = holding?.market === 'US' || (!holding && pd.market === 'US') ? '$' : '₹';

    const sig = analyzeAsset(
      holding || { symbol, market: cur === '$' ? 'US' : 'IN', qty: 0, avgPrice: price },
      pd
    );

    // Composite conviction score (0-100): RSI zone + trend + momentum + position health
    let conviction = 50;
    conviction += rsi < 30 ? 20 : rsi < 40 ? 10 : rsi > 70 ? -15 : rsi > 60 ? -5 : 0;
    conviction += sma20 > sma50 ? 12 : -8;
    conviction += change > 0.5 ? 5 : change < -0.5 ? -5 : 0;
    conviction += sig.action === 'BUY' ? 8 : sig.action === 'SELL' ? -8 : 0;
    conviction = Math.max(5, Math.min(99, Math.round(conviction + sig.confidence * 0.2 - 10)));

    const trend = sma20 > sma50 ? '🟢 UP (SMA20 > SMA50)' : '🔴 DOWN (SMA20 < SMA50)';
    const rsiZone = rsi < 30 ? '🟢 OVERSOLD' : rsi < 40 ? '🟢 MILD DIP' : rsi > 70 ? '🔴 OVERBOUGHT' : rsi > 60 ? '🟠 ELEVATED' : '⚪ NEUTRAL';
    const bar = '🟦'.repeat(Math.round(conviction / 10)) + '⬜'.repeat(10 - Math.round(conviction / 10));

    let r = `🔬 <b>DEEP INSIGHT — ${symbol}</b>\n`;
    r += `━━━━━━━━━━━━━━━━━━━━━━━\n\n`;
    r += `💰 Price: <b>${cur}${price.toFixed(2)}</b> (${change >= 0 ? '+' : ''}${change.toFixed(2)}% today)\n`;
    r += `📈 RSI(14): ${rsi.toFixed(0)} — ${rsiZone}\n`;
    r += `📊 Trend: ${trend}\n`;
    r += `SMA20: ${cur}${sma20.toFixed(2)} | SMA50: ${cur}${sma50.toFixed(2)}\n\n`;

    if (holding) {
      const pl = (price - holding.avgPrice) * holding.qty;
      const plPct = holding.avgPrice > 0 ? ((price - holding.avgPrice) / holding.avgPrice) * 100 : 0;
      r += `💼 <b>YOUR POSITION:</b>\n`;
      r += `   Qty: ${holding.qty} @ ${cur}${holding.avgPrice.toFixed(2)}\n`;
      r += `   P&L: <b>${pl >= 0 ? '+' : ''}${cur}${Math.abs(pl).toFixed(2)}</b> (${plPct >= 0 ? '+' : ''}${plPct.toFixed(1)}%)\n\n`;
    }

    r += `🤖 <b>AI VERDICT: ${sig.signal.replace('_', ' ')}</b> (${sig.confidence}%)\n`;
    r += `🎯 Entry zone: ${cur}${((sig.fibLow || price * 0.97)).toFixed(2)} | Target: ${cur}${(sig.targetPrice || price).toFixed(2)}\n`;
    r += `<code>[${bar}] Conviction ${conviction}/100</code>\n`;
    r += `💡 <i>${sig.reason}</i>\n\n`;
    r += `<i>/ai ${symbol} pe detailed analysis do — LLM narration ke liye</i>`;

    await safeSend(chatId, r);
  } catch (e) {
    console.error('❌ /insights error:', e.message);
    await safeSend(chatId, `❌ Insights error: ${e.message}`);
  }
});

// ========================================
// COMMAND: /aitest — AI Engine Health Dashboard
// Shows which LLM keys are configured, which engine is preferred, and
// whether the deterministic Quant Brain fallback is armed.
// ========================================
bot.onText(/^\/aitest(@\w+)?$/i, async (msg) => {
  if (!isAuthorized(msg)) return;
  const chatId = msg.chat.id;
  console.log(`📥 /aitest from ${msg.from?.first_name || chatId}`);
  try {
    const cfg = await import('./config.mjs');
    const current = getChatEngine(chatId);
    const flag = b => b ? '🟢' : '🔴';

    let r = `🔧 <b>AI ENGINE HEALTH</b>\n`;
    r += `━━━━━━━━━━━━━━━━━━━━━━━\n\n`;
    r += `Active engine: <b>${AI_ENGINE_LABELS[current]}</b>\n\n`;
    r += `🔷 Gemini 3.5 Flash   ${flag(cfg.isGeminiAvailable())}\n`;
    r += `⚡ Groq GPT-OSS 120B   ${flag(cfg.isGroqAvailable())}\n`;
    r += `🟣 Claude Sonnet 5    ${flag(cfg.isClaudeAvailable())}\n`;
    r += `🔶 OpenRouter GLM-5.2 ${flag(cfg.isOpenRouterAvailable())}\n`;
    r += `🧠 Cerebras GPT-OSS   ${flag(cfg.isCerebrasAvailable())}\n`;
    r += `🤗 HuggingFace Qwen3  ${flag(cfg.isHFAvailable())}\n`;
    r += `🟢 NVIDIA NIM         ${flag(cfg.isNvidiaAvailable())}\n`;
    r += `🔍 Tavily (search)    ${flag(cfg.isTavilyAvailable())}\n\n`;
    r += `🧠 Quant Brain fallback: 🟢 ALWAYS ARMED (no key needed)\n\n`;

    // v18: smart-router telemetry (in-memory EWMA latency + failure counts)
    try {
      const health = getAIHealthStatus();
      r += `⚡ <b>SMART ROUTER (auto mode):</b>\n`;
      r += `<code>engine        latency fails state</code>\n`;
      for (const [name, info] of Object.entries(health)) {
        const lat = info.health?.latencyMs ? `${(info.health.latencyMs / 1000).toFixed(1)}s` : '—';
        const fails = info.health?.failures || 0;
        const cooling = !!(info.health && info.health.failures >= 3 && (Date.now() - info.health.lastFailure) < (info.health.cooldownMs || 30000));
        const state = !info.available ? 'no key' : cooling ? '⏸ cool' : fails > 0 ? `⚠️ ${fails}` : '✅ ok';
        const padded = (name + '          ').slice(0, 13);
        r += `<code>${padded} ${String(lat).padEnd(7)} ${String(fails).padEnd(5)} ${state}</code>\n`;
      }
      r += `\n`;
    } catch { /* telemetry optional */ }

    r += `<i>Change engine: /model · Add keys on server env vars.</i>`;
    await safeSend(chatId, r);
  } catch (e) {
    console.error('❌ /aitest error:', e.message);
    await safeSend(chatId, `❌ Engine check error: ${e.message}`);
  }
});

// ========================================
// COMMAND: /pro — 🚀 Advance Pro Intelligence Dashboard
// v18 FLAGSHIP: One-shot aggregated dashboard that combines
//   market regime + portfolio pulse + top signals + smart money + sentiment
// into a single mega-brief. Deterministic core (no LLM needed) — uses the
// same data layers as /super but adds macro + FII/DII + AI-sentiment.
// ========================================
bot.onText(/^\/pro(?:@\w+)?(?:\s+(ai|full|smart))??$/i, async (msg, match) => {
  if (!isAuthorized(msg)) return;
  const chatId = msg.chat.id;
  const mode = (match?.[1] || '').toLowerCase();
  console.log(`📥 /pro ${mode || 'plain'} from ${msg.from?.first_name || chatId}`);
  const stopTyping = startTyping(chatId);
  try {
    if (portfolio.length === 0) {
      await refreshPortfolio().catch(() => {});
    }
    await Promise.allSettled([smartRefreshPrices(), refreshIntel(), refreshForex()]);

    // ---- 1. Macro Regime ----
    const vixUS = livePrices['US_VIX']?.price || 0;
    const vixIN = livePrices['IN_INDIAVIX']?.price || 0;
    const avgVix = (vixUS + vixIN) / 2 || null;
    let regime = '🟢 RISK ON', regimeLine = 'Normal conditions — SIP continue karo.';
    if (avgVix && avgVix > 30) { regime = '🔴🔴 RISK OFF (Panic)'; regimeLine = 'VIX spike! Cash bachao, sirf deep staged buys.'; }
    else if (avgVix && avgVix > 22) { regime = '🟠 ELEVATED VOLATILITY'; regimeLine = 'Choppy market. Chhote sizes, quality names only.'; }
    else if (avgVix && avgVix < 14) { regime = '💎 GOLDILOCKS'; regimeLine = 'Calm market — dips pe aggressively accumulate.'; }

    // ---- 2. Portfolio Pulse ----
    let portfolioSection = '';
    if (portfolio.length > 0) {
      const metrics = calculateMetrics(portfolio, livePrices, usdInrRate);
      const signals = portfolio.map(p => {
        const pd = livePrices[`${p.market}_${p.symbol}`];
        return { pos: p, sig: analyzeAsset(p, pd) };
      });
      const buys = signals.filter(x => x.sig.action === 'BUY');
      const sells = signals.filter(x => x.sig.action === 'SELL');
      const warnings = signals.filter(x => x.sig.rsi > 70 || x.sig.change < -4);
      const opportunities = signals.filter(x => x.sig.rsi < 35 || (x.sig.action === 'BUY' && x.sig.confidence >= 80));
      const plEmoji = metrics.totalPL >= 0 ? '📈' : '📉';

      portfolioSection = `<b>💼 PORTFOLIO PULSE:</b>\n`;
      portfolioSection += `   Value: ₹${Math.round(metrics.totalValue).toLocaleString('en-IN')} | ${plEmoji} ${metrics.totalPL >= 0 ? '+' : ''}₹${Math.round(metrics.totalPL).toLocaleString('en-IN')} (${metrics.plPct.toFixed(1)}%)\n`;
      portfolioSection += `   Today: ${metrics.todayPL >= 0 ? '+' : ''}₹${Math.round(metrics.todayPL).toLocaleString('en-IN')} (${metrics.todayPct.toFixed(2)}%)\n`;
      portfolioSection += `   🟢 BUY:${buys.length} | 🔴 SELL:${sells.length} | 🟡 HOLD:${signals.length - buys.length - sells.length}\n`;
      if (warnings.length > 0) portfolioSection += `   ⚠️ Warnings: ${warnings.slice(0, 3).map(w => w.sig.symbol).join(', ')}\n`;
      if (opportunities.length > 0) portfolioSection += `   🎯 Opportunities: ${opportunities.slice(0, 3).map(o => o.sig.symbol).join(', ')}\n`;
    } else {
      portfolioSection = `<b>💼 PORTFOLIO PULSE:</b> <i>Empty — assets add karo web app se</i>\n`;
    }
    portfolioSection += `\n`;

    // ---- 3. Market Snapshot ----
    let marketSection = `<b>🌍 MARKET SNAPSHOT:</b>\n`;
    const nifty = livePrices['IN_NIFTY'];
    const sensex = livePrices['IN_SENSEX'];
    const spy = livePrices['US_SPY'];
    const qqq = livePrices['US_QQQ'];
    if (nifty) marketSection += `   🇮🇳 NIFTY: ${nifty.price?.toFixed(2)} (${nifty.change >= 0 ? '+' : ''}${nifty.change?.toFixed(2)}%)\n`;
    if (sensex) marketSection += `   🇮🇳 SENSEX: ${sensex.price?.toFixed(2)} (${sensex.change >= 0 ? '+' : ''}${sensex.change?.toFixed(2)}%)\n`;
    if (spy) marketSection += `   🇺🇸 S&P 500: ${spy.price?.toFixed(2)} (${spy.change >= 0 ? '+' : ''}${spy.change?.toFixed(2)}%)\n`;
    if (qqq) marketSection += `   🇺🇸 NASDAQ: ${qqq.price?.toFixed(2)} (${qqq.change >= 0 ? '+' : ''}${qqq.change?.toFixed(2)}%)\n`;
    if (avgVix) marketSection += `   📊 VIX: US ${vixUS.toFixed(1)} / IN ${vixIN.toFixed(1)} (avg ${avgVix.toFixed(1)})\n`;
    marketSection += `   💱 USD/INR: ₹${usdInrRate.toFixed(2)}\n\n`;

    // ---- 4. Smart Money (FII/DII) ----
    let smartMoneySection = '';
    try {
      const fiiData = await fetchFIIDIIData(TAVILY_API_KEY);
      if (fiiData && fiiData.summary) {
        const fiiMatch = fiiData.summary.match(/FII[^-]*?net[^-]*?(-?[\d,]+\.?\d*)\s*(?:Cr|crore)/i);
        const diiMatch = fiiData.summary.match(/DII[^-]*?net[^-]*?(-?[\d,]+\.?\d*)\s*(?:Cr|crore)/i);
        const fiiNet = fiiMatch ? parseFloat(fiiMatch[1].replace(/,/g, '')) : null;
        const diiNet = diiMatch ? parseFloat(diiMatch[1].replace(/,/g, '')) : null;
        smartMoneySection = `<b>💰 SMART MONEY (FII/DII):</b>\n`;
        if (fiiNet !== null) smartMoneySection += `   FII Net: ${fiiNet >= 0 ? '🟢 +' : '🔴 '}₹${fiiNet.toLocaleString('en-IN')} Cr\n`;
        if (diiNet !== null) smartMoneySection += `   DII Net: ${diiNet >= 0 ? '🟢 +' : '🔴 '}₹${diiNet.toLocaleString('en-IN')} Cr\n`;
        if (fiiNet === null && diiNet === null) smartMoneySection += `   <i>${escapeHtml(fiiData.summary.substring(0, 120))}…</i>\n`;
        smartMoneySection += `\n`;
      }
    } catch (e) { /* smart money optional */ }

    // ---- 5. AI Verdict (optional, only if mode=ai) ----
    let aiVerdict = '';
    if (mode === 'ai') {
      try {
        const prompt = `Based on this brief, give ONE actionable insight in 2 lines of Hinglish. Be specific, no fluff. Mention regime + portfolio stance.`;
        aiVerdict = await Promise.race([
          chatWithAI(chatId, prompt, portfolio, livePrices, usdInrRate),
          new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 25000)),
        ]);
        aiVerdict = `\n<b>🧠 AI VERDICT:</b>\n${aiVerdict}\n`;
      } catch (e) {
        aiVerdict = `\n<i>(AI verdict unavailable — deterministic brief shown)</i>\n`;
      }
    }

    // ---- 6. Compose final dashboard ----
    let r = `🚀 <b>${BOT_NAME} DASHBOARD ${BOT_VERSION}</b>\n`;
    r += `━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
    r += `⏰ ${getISTTime()} IST | ${getMarketStatus()}\n\n`;

    r += `<b>1️⃣ MACRO REGIME:</b> ${regime}\n`;
    if (avgVix) r += `   ${regimeLine}\n\n`; else r += `   ${regimeLine}\n\n`;

    r += `2️⃣ ${marketSection}`;
    r += `3️⃣ ${portfolioSection}`;
    if (smartMoneySection) r += `4️⃣ ${smartMoneySection}`;
    r += aiVerdict;

    // Final one-line verdict
    let verdict;
    if (avgVix && avgVix > 30) verdict = 'DEFENSE MODE — panic mat karo, par naya bada capital mat lagao.';
    else if (portfolio.length === 0) verdict = 'SETUP MODE — pehle portfolio add karo, phir /pro chalao.';
    else verdict = 'STEADY — SIP chalu, noise ignore, discipline follow.';
    r += `\n<b>📌 ONE-LINE VERDICT:</b> ${verdict}\n\n`;
    r += `💎 <i>${BOT_NAME} ${BOT_VERSION}</i>`;

    // Inline keyboard for refresh / AI mode
    await safeSend(chatId, r, {
      reply_markup: {
        inline_keyboard: [[
          { text: '🔁 Refresh', callback_data: 'pro:refresh' },
          { text: '🧠 AI Verdict', callback_data: 'pro:ai' },
          { text: '🧠 Full Super Brief', callback_data: 'sup:refresh' },
        ]],
      },
    });
  } catch (e) {
    console.error('❌ /pro error:', e.message);
    await safeSend(chatId, `❌ Pro dashboard error: ${e.message}`);
  } finally {
    stopTyping();
  }
});

// Handle /pro inline buttons
// (callback_query handler above is for sup:* and setmodel:*, here we add pro:*)
// NOTE: the callback_query handler at line ~1620 already routes 'sup:' and
// 'setmodel:'. We add 'pro:' routing there via a small extension below.

// ========================================
// COMMAND: /sentiment — Real-time Market Sentiment (Tavily)
// NEW v18: Pulls real-time news and derives Fear/Greed-style sentiment.
// ========================================
bot.onText(/^\/sentiment(?:@\w+)?(?:\s+(.+))?$/i, async (msg, match) => {
  if (!isAuthorized(msg)) return;
  const chatId = msg.chat.id;
  const topic = match?.[1] || 'Indian stock market NIFTY SENSEX today sentiment';
  console.log(`📥 /sentiment "${topic}" from ${msg.from?.first_name || chatId}`);
  const stopTyping = startTyping(chatId);
  try {
    if (!isTavilyAvailable()) {
      await safeSend(chatId, '🌍 <b>Sentiment unavailable</b> — Tavily API key not configured. Use <code>/setkey tavily &lt;key&gt;</code>.');
      return;
    }
    await safeSend(chatId, '🌍 <i>Computing real-time market sentiment via Tavily...</i>');

    const res = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_key: TAVILY_API_KEY,
        query: `${topic} market sentiment bullish bearish fear greed`,
        search_depth: 'advanced',
        include_answer: true,
        max_results: 6,
        topic: 'finance'
      }),
      signal: AbortSignal.timeout(12000)
    });
    if (!res.ok) throw new Error(`Tavily HTTP ${res.status}`);
    const data = await res.json();
    const answer = (data.answer || '').toLowerCase();

    // Simple keyword-based sentiment score (-100 to +100)
    const bullWords = ['bullish', 'rally', 'surge', 'gain', 'soar', 'optimistic', 'recovery', 'upside', 'breakout', 'buy'];
    const bearWords = ['bearish', 'crash', 'plunge', 'slump', 'panic', 'fear', 'sell-off', 'selloff', 'loss', 'decline', 'downside', 'risk'];
    let score = 50;
    for (const w of bullWords) { const c = (answer.match(new RegExp(`\\b${w}\\b`, 'g')) || []).length; score += c * 5; }
    for (const w of bearWords) { const c = (answer.match(new RegExp(`\\b${w}\\b`, 'g')) || []).length; score -= c * 5; }
    score = Math.max(0, Math.min(100, score));
    const label = score >= 75 ? 'EXTREME GREED 🤑' : score >= 55 ? 'GREED 🟢' : score >= 45 ? 'NEUTRAL ⚪' : score >= 25 ? 'FEAR 🟠' : 'EXTREME FEAR 😱';
    const bar = '🟩'.repeat(Math.round(score / 10)) + '⬜'.repeat(10 - Math.round(score / 10));

    let out = `🌍 <b>MARKET SENTIMENT</b>\n━━━━━━━━━━━━━━━━━━━━━━━\n\n`;
    out += `📰 Topic: <i>${escapeHtml(topic)}</i>\n`;
    out += `📊 Sentiment Score: <b>${score}/100</b> — ${label}\n`;
    out += `<code>[${bar}]</code>\n\n`;
    out += `<b>📰 AI Summary:</b>\n${escapeHtml(data.answer || 'No summary available.')}\n\n`;
    if (data.results && data.results.length > 0) {
      out += `<b>📚 Sources:</b>\n`;
      for (const r of data.results.slice(0, 4)) {
        out += `• <a href="${escapeHtml(r.url || '')}">${escapeHtml(r.title || '')}</a>\n`;
      }
    }
    out += `\n<i>Computed from real-time Tavily web search · ${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })} IST</i>`;
    await safeSend(chatId, out);
  } catch (e) {
    console.error('❌ /sentiment error:', e.message);
    await safeSend(chatId, `❌ Sentiment error: ${e.message}`);
  } finally {
    stopTyping();
  }
});

// ========================================
// COMMAND: /whale — Whale Activity Tracker
// NEW v18: Scans portfolio for unusually large moves + uses Tavily for
// block-deal / bulk-deal news. Deterministic + real-time hybrid.
// ========================================
bot.onText(/^\/whale(?:@\w+)?$/i, async (msg) => {
  if (!isAuthorized(msg)) return;
  const chatId = msg.chat.id;
  console.log(`📥 /whale from ${msg.from?.first_name || chatId}`);
  const stopTyping = startTyping(chatId);
  try {
    await smartRefreshPrices();
    let out = `🐋 <b>WHALE ACTIVITY TRACKER</b>\n━━━━━━━━━━━━━━━━━━━━━━━\n\n`;

    // 1. Portfolio whale moves (>3% absolute change today)
    if (portfolio.length === 0) {
      out += `⚠️ Portfolio empty hai. Web app ke Portfolio tab me INDMoney/CoinDCX connect karo — phir /sync chalega.\n\n`;
    } else {
      const movers = portfolio
        .map(p => {
          const pd = livePrices[`${p.market}_${p.symbol}`];
          if (!pd) return null;
          const value = (pd.price || 0) * (p.qty || 0);
          return { symbol: p.symbol, market: p.market, change: pd.change || 0, value, price: pd.price };
        })
        .filter(Boolean)
        .filter(m => Math.abs(m.change) >= 3)
        .sort((a, b) => Math.abs(b.change) - Math.abs(a.change));

      out += `<b>📊 Portfolio Big Movers (≥3% today):</b>\n`;
      if (movers.length === 0) {
        out += `   ✅ Koi whale-sized move nahi. Sab stable.\n\n`;
      } else {
        for (const m of movers.slice(0, 8)) {
          const cur = m.market === 'US' ? '$' : '₹';
          const emoji = m.change > 0 ? '🟢' : '🔴';
          out += `   ${emoji} <b>${m.symbol}</b>: ${m.change >= 0 ? '+' : ''}${m.change.toFixed(2)}% | Value: ${cur}${Math.round(m.value).toLocaleString('en-IN')}\n`;
        }
        out += `\n`;
      }
    }

    // 2. Tavily block/bulk deal news
    if (isTavilyAvailable()) {
      try {
        const res = await fetch('https://api.tavily.com/search', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            api_key: TAVILY_API_KEY,
            query: 'India NSE BSE block deal bulk deal today whale institutional large trade',
            search_depth: 'basic',
            include_answer: true,
            max_results: 5,
            topic: 'finance'
          }),
          signal: AbortSignal.timeout(10000)
        });
        if (res.ok) {
          const data = await res.json();
          if (data.answer) out += `<b>📰 Block/Bulk Deal News:</b>\n${escapeHtml(data.answer)}\n\n`;
          if (data.results && data.results.length > 0) {
            out += `<b>🔗 Sources:</b>\n`;
            for (const r of data.results.slice(0, 3)) {
              out += `• <a href="${escapeHtml(r.url || '')}">${escapeHtml(r.title || '')}</a>\n`;
            }
            out += `\n`;
          }
        }
      } catch (e) { /* optional */ }
    } else {
      out += `<i>ℹ️ Tavily key not set — block-deal news disabled. Use /setkey tavily.</i>\n\n`;
    }

    out += `<i> Whale = institutional-sized moves. Retail ko follow karne ka chance, but always DYOR.</i>`;
    await safeSend(chatId, out);
  } catch (e) {
    console.error('❌ /whale error:', e.message);
    await safeSend(chatId, `❌ Whale tracker error: ${e.message}`);
  } finally {
    stopTyping();
  }
});

// ========================================
// COMMAND: /earnings — Upcoming Earnings Calendar
// NEW v18: Uses Tavily to fetch this week's India + US earnings.
// ========================================
bot.onText(/^\/earnings(?:@\w+)?$/i, async (msg) => {
  if (!isAuthorized(msg)) return;
  const chatId = msg.chat.id;
  console.log(`📥 /earnings from ${msg.from?.first_name || chatId}`);
  const stopTyping = startTyping(chatId);
  try {
    if (!isTavilyAvailable()) {
      await safeSend(chatId, '📅 <b>Earnings calendar unavailable</b> — Tavily API key not configured. Use <code>/setkey tavily &lt;key&gt;</code>.');
      return;
    }
    await safeSend(chatId, '📅 <i>Fetching upcoming earnings calendar via Tavily...</i>');

    const today = new Date().toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
    const res = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_key: TAVILY_API_KEY,
        query: `India NSE BSE quarterly earnings results this week upcoming ${today} Q1 Q2 Q3 Q4`,
        search_depth: 'advanced',
        include_answer: true,
        max_results: 6,
        topic: 'finance'
      }),
      signal: AbortSignal.timeout(12000)
    });
    if (!res.ok) throw new Error(`Tavily HTTP ${res.status}`);
    const data = await res.json();

    let out = `📅 <b>UPCOMING EARNINGS CALENDAR</b>\n━━━━━━━━━━━━━━━━━━━━━━━\n\n`;
    out += `🗓️ Reference Date: <b>${today}</b>\n\n`;
    if (data.answer) out += `<b>📰 AI Summary:</b>\n${escapeHtml(data.answer)}\n\n`;
    if (data.results && data.results.length > 0) {
      out += `<b>📚 Top Earnings News:</b>\n`;
      for (const r of data.results.slice(0, 5)) {
        out += `• <b>${escapeHtml(r.title || '')}</b>\n  ${escapeHtml((r.content || '').substring(0, 150))}…\n  🔗 ${escapeHtml(r.url || '')}\n\n`;
      }
    }
    out += `<i>Source: Tavily · Earnings dates change frequently — verify with company IR pages.</i>`;
    await safeSend(chatId, out);
  } catch (e) {
    console.error('❌ /earnings error:', e.message);
    await safeSend(chatId, `❌ Earnings calendar error: ${e.message}`);
  } finally {
    stopTyping();
  }
});

// ========================================
// COMMAND: /consensus <QUERY> — Multi-Model Consensus Voting
// ========================================
bot.onText(/^\/consensus(?:\s+(.+))?$/i, async (msg, match) => {
  if (!isAuthorized(msg)) return;
  const chatId = msg.chat.id;
  const query = match[1]?.trim();
  if (!query) {
    await safeSend(chatId, '🤝 <b>Usage:</b> <code>/consensus &lt;stock or query&gt;</code>\n\n<i>Example:</i> <code>/consensus RELIANCE target and entry</code>\n<i>Site ke 14-model committee desk agent ko route hota hai — website wala SAME engine. Crypto words → CoinDCX desk, NSE words → intraday desk (baaki last-used desk).</i>');
    return;
  }
  console.log(`📥 /consensus from ${msg.from?.first_name || chatId}: ${query}`);
  const stopTyping = startTyping(chatId);
  try {
    // v18.2 UNIFICATION: the SAME desk agent the website + the webhook
    // bot use — a 14-model committee behind it (not the bot's own
    // 3-LLM vote that could disagree with the site's answer).
    if (siteAgents.siteBridgeReady()) {
      const desk = siteAgents.inferDeskFromText(query) || siteAgents.deskSessionFor(chatId) || 'crypto';
      siteAgents.rememberDesk(chatId, desk);
      const out = await siteAgents.siteAgentQuery(`Consensus view chahiye — multi-model committee se pucho: ${query}`, desk);
      if (out.ok && out.text) {
        await safeSend(chatId, `🤝 <b>DESK CONSENSUS — ${desk === 'intraday' ? '🇮🇳 NSE' : '₿ Crypto'}</b> <i>(site 14-model engine)</i>\n━━━━━━━━━━━━━━━━━━━━━━━\n\n${out.text}`);
        if (out.tools?.length) await safeSend(chatId, `🔧 tools: ${out.tools.join(', ')}`);
        return;
      }
      console.warn(`[unify] site consensus fell back (${out.error}) — legacy 3-model vote`);
    }
    await smartRefreshPrices();
    const result = await chatWithConsensus(chatId, query, portfolio, livePrices, usdInrRate);
    await safeSend(chatId, result);
  } catch (e) {
    console.error('❌ /consensus error:', e.message);
    await safeSend(chatId, `❌ Consensus engine error: ${e.message}`);
  } finally {
    stopTyping();
  }
});

// ========================================
// PHOTO LISTENER: Multi-Modal Chart Technical Analysis
// ========================================
bot.on('photo', async (msg) => {
  if (!isAuthorized(msg)) return;
  const chatId = msg.chat.id;
  console.log(`📥 Photo received from ${msg.from?.first_name || chatId}`);
  const stopTyping = startTyping(chatId);
  try {
    const photo = msg.photo[msg.photo.length - 1]; // highest resolution photo
    const file = await bot.getFile(photo.file_id);
    const fileUrl = `https://api.telegram.org/file/bot${TG_TOKEN}/${file.file_path}`;

    // Download image to buffer
    // v10.18 (deep-recheck #3): 30s deadline — a black-holed Telegram CDN
    // route used to stall this handler forever AND leak the typing
    // indicator's 4s interval (stopTyping sits in `finally`, which a hung
    // await never reaches). The voice handler below already had this.
    const imgRes = await fetch(fileUrl, { signal: AbortSignal.timeout(30_000) });
    if (!imgRes.ok) throw new Error('Could not download chart photo');
    const arrayBuffer = await imgRes.arrayBuffer();
    const base64 = Buffer.from(arrayBuffer).toString('base64');

    const caption = msg.caption || 'Analyze this chart screenshot in detail. Identify trend, support/resistance, candlestick patterns, and give exact Entry, SL, and Target 1/2.';
    await safeSend(chatId, '📸 <i>Analyzing chart with Gemini Vision AI...</i>');

    const analysis = await analyzeChartImage(base64, caption, 'image/jpeg');
    await safeSend(chatId, analysis);
  } catch (e) {
    console.error('❌ Chart vision error:', e.message);
    await safeSend(chatId, `❌ Chart analysis error: ${e.message}\n\n<i>Ensure Gemini API key is configured.</i>`);
  } finally {
    stopTyping();
  }
});

// ========================================
// 🎤 VOICE LISTENER (#5 voice notes) — transcribe → SAME site desk agent
// Groq Whisper large-v3 (Gemini inline-audio fallback) → siteAgents
// bridge (crypto/intraday desk, session memory). Falls back to the
// bot's own 7-engine chat when the site is unreachable — the voice
// note is never wasted.
// ========================================
bot.on('voice', async (msg) => {
  if (!isAuthorized(msg)) return;
  const chatId = msg.chat.id;
  console.log(`🎤 Voice note from ${msg.from?.first_name || chatId} (${msg.voice?.duration || '?'}s)`);
  const stopTyping = startTyping(chatId);
  try {
    await safeSend(chatId, '🎤 <i>Sun raha hoon — transcript bana raha hoon…</i>');
    const file = await bot.getFile(msg.voice.file_id);
    const fileUrl = `https://api.telegram.org/file/bot${TG_TOKEN}/${file.file_path}`;
    const audioRes = await fetch(fileUrl, { signal: AbortSignal.timeout(30_000) });
    if (!audioRes.ok) throw new Error(`voice download failed (${audioRes.status})`);
    const b64 = Buffer.from(await audioRes.arrayBuffer()).toString('base64');

    const tr = await transcribeVoice(b64, { mimeType: msg.voice.mime_type || 'audio/ogg' });
    const said = String(tr.text || '').trim();
    if (!said) {
      await safeSend(chatId, '🤫 Transcript khaali aaya — thoda clear bolke phir se bhejo.');
      return;
    }
    await safeSend(chatId, `📝 <b>Transcript</b> <i>(${tr.engine})</i>: "${escapeHtml(said.slice(0, 400))}"`);

    // Route through the SAME site desk agent a text question would hit.
    if (siteAgents.siteBridgeReady()) {
      const desk = siteAgents.inferDeskFromText(said) || siteAgents.deskSessionFor(chatId) || 'crypto';
      siteAgents.rememberDesk(chatId, desk);
      const out = await siteAgents.siteAgentQuery(said, desk);
      if (out.ok && out.text) {
        await safeSend(chatId, `${desk === 'intraday' ? '🇮🇳 Intraday desk' : '₿ Crypto desk'} (voice → site agent):\n\n${out.text}`.slice(0, 4000));
        if (out.tools?.length) await safeSend(chatId, `🔧 tools: ${out.tools.join(', ')}`);
        return;
      }
      console.warn(`[voice] site agent fell back (${out.error}) — local AI chat`);
    }
    // Fallback: the bot's own 7-engine chat — voice still gets an answer.
    await smartRefreshPrices().catch(() => {});
    const answer = await chatWithAI(chatId, said, portfolio, livePrices, usdInrRate);
    await safeSend(chatId, answer);
  } catch (e) {
    console.error('❌ Voice note error:', e.message);
    await safeSend(chatId, `❌ Voice error: ${e.message}\n\n<i>Text me likho — wahi agent chalega.</i>`);
  } finally {
    stopTyping();
  }
});

// ========================================
// BOOT UP
// ========================================

initializeData().then(() => {
  console.log('🚀 All systems GO! Bot is listening for commands...');
  console.log(`📱 Chat ID: ${TG_CHAT_ID}`);
  console.log(`   Market Status: ${getMarketStatus()}`);
  console.log(`   Auto Alerts: ${autoAlerts ? 'ON' : 'OFF'}`);
  console.log(`   🔷 Gemini: ${GEMINI_KEY?.length > 5 ? 'ONLINE' : 'OFFLINE'}`);
  console.log(`   ⚡ Groq:   ${GROQ_KEY?.length > 10 ? 'ONLINE' : 'OFFLINE'}`);
  console.log(`   🟣 Claude: ${CLAUDE_KEY?.length > 10 ? 'ONLINE' : 'OFFLINE'}`);
  console.log('');
  // Send boot notification
  safeSend(TG_CHAT_ID, `🟢 <b>${BOT_NAME} ${BOT_VERSION} ONLINE</b>\n⏰ ${getISTTime()} IST\n💼 Portfolio: ${portfolio.length} positions\n📊 Market: ${getMarketStatus()}\n🤖 AI: 7-Engine Smart Router (NVIDIA→Gemini→Groq→Claude→OpenRouter→Cerebras→HF)\n🧠 Quant Brain: ALWAYS ONLINE (never offline)\n🔬 Real-time Market Data: ACTIVE 24x7\n🧬 ML Service: ${ML_SERVICE_URL}\n\nType /help for commands, or try /pro for the dashboard.`).catch(() => { });
}).catch(err => {
  console.error('❌ Boot error (non-fatal):', err.message);
  console.log('⚡ Bot is STILL listening for commands with limited data...');
  botReady = true; // Allow commands even if boot partially failed
});
