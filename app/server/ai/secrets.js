// ============================================================
// server/ai/secrets.js — AI TERMINAL SECRETS (server-side only)
// ------------------------------------------------------------
// v6.5 — the roadmap items users asked for by chat:
//   • Telegram bot token + chat id  (alert delivery)
//   • AI Council keys (Gemini / Groq) — the 9th model without
//     needing Render env access
//
// Stored in server/data/ai-secrets.json and mirrored to the
// ENCRYPTED GitHub durable backup (durablePut) — the same pipeline
// as the CoinDCX API keys. Unlike mcp-settings.json (whose values
// are served back to the browser for UI display), these values are
// NEVER returned raw: GET endpoints serve a masked status only
// ({ configured, tail: '…abcd' }). env vars always remain a
// fallback — a secret set here simply WINS (the user typed it in
// the UI precisely because they can't set env on Render easily).
// ============================================================
import { loadJSON, saveJSON } from '../lib/store.js';
import { durablePut } from '../mcp/durable.js';

const SECRETS_FILE = 'ai-secrets.json';

// v20.7.8 [M1]: 3s TTL cache. getSecrets() sits on the hottest server
// path — routes.js effectiveKeys() builds depsForSignals() on EVERY
// /api/ai/* request, agent tick, 15s recheck loop and insta-push sink,
// and each call was a synchronous readFileSync of the secrets file
// (1-3ms on cloud disks, serially blocking the event loop). Secrets
// change only through setSecret() (which invalidates this cache) or
// out-of-process edits (picked up within 3s — the "a key saved mid-
// flight engages on the next board run" contract is ≥30s, so this is
// invisible). Cached object is NEVER handed out by reference.
const SECRETS_TTL_MS = 3000;
let _secretsCache = { at: 0, val: null };

export function getSecrets() {
  const now = Date.now();
  if (_secretsCache.val && (now - _secretsCache.at) < SECRETS_TTL_MS) {
    return { ..._secretsCache.val };
  }
  const store = loadJSON(SECRETS_FILE, { secrets: {} }) || {};
  const out = {};
  for (const k of Object.keys(KEYS)) {
    const v = store?.secrets?.[k];
    if (typeof v === 'string' && v.length > 0) out[k] = v;
  }
  _secretsCache = { at: now, val: out };
  return { ...out };
}

// ---- known keys + validators --------------------
// Each validator: (value) => sanitized string | null (clear).
// Throws a 400-shaped error on invalid input.
const KEYS = {
  telegramBotToken: (v) => {
    if (v == null || v === '') return null;
    const s = String(v).trim();
    if (!/^\d{6,12}:[A-Za-z0-9_-]{30,60}$/.test(s)) {
      throw Object.assign(
        new Error('Telegram bot token format is <botId>:<hash> — get it from @BotFather'),
        { status: 400, code: 'BAD_REQUEST' },
      );
    }
    return s;
  },
  telegramChatId: (v) => {
    if (v == null || v === '') return null;
    const s = String(v).trim().replace(/^-100/, '100'); // supergroup prefix tolerated
    if (!/^\d{3,20}$/.test(s)) {
      throw Object.assign(
        new Error('Telegram chat id must be numeric — get it from @userinfobot or the bot\'s /getUpdates'),
        { status: 400, code: 'BAD_REQUEST' },
      );
    }
    return s;
  },
  geminiApiKey: (v) => {
    if (v == null || v === '') return null;
    const s = String(v).trim();
    if (s.length < 20 || /\s/.test(s)) {
      throw Object.assign(new Error('Gemini API key looks invalid (expected a long token from aistudio.google.com)'), { status: 400, code: 'BAD_REQUEST' });
    }
    return s;
  },
  groqApiKey: (v) => {
    if (v == null || v === '') return null;
    const s = String(v).trim();
    if (s.length < 20 || /\s/.test(s)) {
      throw Object.assign(new Error('Groq API key looks invalid (expected gsk_... from console.groq.com)'), { status: 400, code: 'BAD_REQUEST' });
    }
    return s;
  },
};

/** Set (or clear, when value == null) one secret. Validates strictly,
 *  persists to disk + pushes the encrypted durable backup. */
export function setSecret(key, value) {
  if (!Object.prototype.hasOwnProperty.call(KEYS, key) || typeof key !== 'string') {
    throw Object.assign(
      new Error(`Unknown secret key: ${String(key)} (known: ${Object.keys(KEYS).join(', ')})`),
      { status: 400, code: 'BAD_REQUEST' },
    );
  }
  const clean = KEYS[key](value);
  const store = loadJSON(SECRETS_FILE, { secrets: {} }) || {};
  if (!store.secrets || typeof store.secrets !== 'object') store.secrets = {};
  if (clean == null) delete store.secrets[key];
  else store.secrets[key] = clean;
  store.updatedAt = Date.now();
  saveJSON(SECRETS_FILE, store);
  _secretsCache = { at: 0, val: null }; // v20.7.8 [M1]: a saved key is live on the NEXT call
  try { durablePut(SECRETS_FILE, store); } catch { /* best-effort */ }
  return true;
}

/** Masked status for the browser — NEVER the raw values. */
export function secretsStatus() {
  const s = getSecrets();
  const mask = (v) => (v ? { configured: true, tail: `…${v.slice(-4)}` } : { configured: false, tail: null });
  return {
    telegramBotToken: mask(s.telegramBotToken),
    telegramChatId: mask(s.telegramChatId),
    geminiApiKey: mask(s.geminiApiKey),
    groqApiKey: mask(s.groqApiKey),
  };
}

// ---------------- telegram delivery ----------------
/**
 * Resolve the ACTIVE telegram config: secrets WIN over env (the UI
 * is where the user typed their intent), env is the fallback.
 * Returns { token, chatId } or null when unconfigured.
 */
export function telegramConfig(env = {}) {
  const s = getSecrets();
  const token = s.telegramBotToken || (env?.token || '');
  const chatId = s.telegramChatId || (env?.chatId || '');
  return token && chatId ? { token, chatId, source: s.telegramBotToken ? 'app' : 'env' } : null;
}

// ---------------- v21.0 telegram delivery health ----------------
// "Notifications nahi aa rahe" ko DIAGNOSABLE banane ka counter layer:
// har send ka outcome 24h rolling window me track hota hai (sent/failed/
// lastError) — /api/ai/insta-push/status + engines status se UI tak.
// Failures TELEGRAM_HTTP_FAILS_* env knobs se capped warn karte hain.
const _tgDelivery = { sent: [], failed: [], lastError: null, lastErrorAt: null };

function _tgTrack(kind, info) {
  const now = Date.now();
  const arr = kind === 'ok' ? _tgDelivery.sent : _tgDelivery.failed;
  arr.push(now);
  // 24h rolling prune (cap 2000 entries — memory safe)
  while (arr.length && now - arr[0] > 24 * 60 * 60 * 1000) arr.shift();
  while (arr.length > 2000) arr.shift();
  if (kind !== 'ok') {
    _tgDelivery.lastError = String(info || 'unknown').slice(0, 160);
    _tgDelivery.lastErrorAt = now;
  }
}

/** 24h delivery health view (UI/status endpoints ke liye). */
export function telegramDeliveryHealth() {
  const now = Date.now();
  const win = (arr) => arr.filter((t) => now - t <= 24 * 60 * 60 * 1000).length;
  return {
    sent24h: win(_tgDelivery.sent),
    failed24h: win(_tgDelivery.failed),
    lastError: _tgDelivery.lastError,
    lastErrorAt: _tgDelivery.lastErrorAt,
    healthy: _tgDelivery.failed.length === 0 || win(_tgDelivery.failed) < 10,
  };
}

/** Fire-and-safe send (never throws; 10s timeout).
 *  v21.0: delivery-health tracking add hua — har send ka outcome
 *  telegramDeliveryHealth() me dikhta hai (24h window). */
export async function sendTelegramMessage(text, env = {}) {
  const cfg = telegramConfig(env);
  if (!cfg) return { ok: false, error: 'telegram not configured' };
  try {
    const r = await fetch(`https://api.telegram.org/bot${cfg.token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: cfg.chatId, text, parse_mode: 'HTML', disable_web_page_preview: true }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!r.ok) {
      const body = await r.text().catch(() => '');
      const err = `telegram HTTP ${r.status} ${body.slice(0, 120)}`;
      _tgTrack('fail', err);
      return { ok: false, error: err };
    }
    _tgTrack('ok');
    return { ok: true };
  } catch (e) {
    const err = String(e?.message || e).slice(0, 120);
    _tgTrack('fail', err);
    return { ok: false, error: err };
  }
}

// ---------------- v10.9: multi-user + interactive surfaces ----------------
/** Just the token (secrets WIN over env) — multi-user sends target
 *  an EXPLICIT chat id, so the default chatId must not leak in. */
export function telegramToken(env = {}) {
  const s = getSecrets();
  return s.telegramBotToken || String(env?.token || '') || null;
}

/**
 * Send to an EXPLICIT chat id (v10.9 #6 multi-user roles: the reply goes
 * to the chat that ASKED — a viewer chat must never redirect to the
 * admin's configured chat, and vice versa). Same fire-safe contract.
 * @param {string} chatId numeric Telegram chat id
 * @param {object} extra { replyMarkup } — inline keyboard for approvals
 */
export async function sendTelegramMessageTo(chatId, text, env = {}, extra = {}) {
  const token = telegramToken(env);
  const id = String(chatId ?? '').trim();
  if (!token) return { ok: false, error: 'telegram token not configured' };
  if (!/^-?\d{3,20}$/.test(id)) return { ok: false, error: `invalid chat id "${id.slice(0, 12)}"` };
  try {
    const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: Number(id),
        text: String(text || ''),
        parse_mode: 'HTML',
        disable_web_page_preview: true,
        ...(extra?.replyMarkup ? { reply_markup: extra.replyMarkup } : {}),
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!r.ok) {
      const body = await r.text().catch(() => '');
      return { ok: false, error: `telegram HTTP ${r.status} ${body.slice(0, 120)}` };
    }
    const j = await r.json().catch(() => ({}));
    return { ok: true, messageId: j?.result?.message_id ?? null };
  } catch (e) {
    return { ok: false, error: String(e?.message || e).slice(0, 120) };
  }
}

/**
 * Generic Bot API call (v10.9 #4: answerCallbackQuery + getFile for the
 * approval buttons and voice downloads). Same fire-safe contract.
 */
export async function telegramApiCall(method, payload = {}, env = {}) {
  const token = telegramToken(env);
  if (!token) return { ok: false, error: 'telegram token not configured' };
  if (!/^[a-zA-Z]+$/.test(String(method))) return { ok: false, error: 'bad method' };
  try {
    const r = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload || {}),
      signal: AbortSignal.timeout(10_000),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j?.ok) {
      return { ok: false, error: `telegram ${method} HTTP ${r.status} ${String(j?.description || '').slice(0, 120)}` };
    }
    return { ok: true, result: j.result ?? true };
  } catch (e) {
    return { ok: false, error: String(e?.message || e).slice(0, 120) };
  }
}

/** Download a Telegram file by file_path (voice notes). */
export async function telegramFileBase64(filePath, env = {}) {
  const token = telegramToken(env);
  const fp = String(filePath || '').replace(/[^A-Za-z0-9/_.-]/g, '');
  if (!token || !fp) return { ok: false, error: 'token/file_path missing' };
  try {
    const r = await fetch(`https://api.telegram.org/file/bot${token}/${fp}`, {
      signal: AbortSignal.timeout(30_000),
    });
    if (!r.ok) return { ok: false, error: `file download HTTP ${r.status}` };
    const buf = Buffer.from(await r.arrayBuffer());
    if (!buf?.length || buf.length > 20 * 1024 * 1024) return { ok: false, error: `voice file too large (${buf.length} bytes)` };
    return { ok: true, base64: buf.toString('base64'), size: buf.length };
  } catch (e) {
    return { ok: false, error: String(e?.message || e).slice(0, 120) };
  }
}

// ---------------- test hooks ----------------
export function __resetSecretsForTests() {
  saveJSON(SECRETS_FILE, { secrets: {}, updatedAt: 0 });
  _secretsCache = { at: 0, val: null }; // v20.7.8 [M1]: never serve a stale cached secret to the next test
}
export function __setSecretForTests(key, value) {
  setSecret(key, value);
}
