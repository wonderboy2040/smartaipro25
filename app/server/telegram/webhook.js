// ============================================================
// server/telegram/webhook.js — INTERACTIVE TELEGRAM BOT (v10.9)
// ------------------------------------------------------------
// The bot used to be one-way (notifications only). This module makes
// it LISTEN: Telegram's webhook delivers user messages here and they
// route to the SAME backend agents the website tabs use:
//
//   /intraday <query>     → runProTraderAgent  (intraday desk tools)
//   /crypto <query>        → runCryptoAgent     (CoinDCX desk tools)
//   /status               → both agents' quick status + desk summary
//   /weeklyreview         → the journal+calibration performance digest
//   🎤 voice note          → transcribe → same desk agent (Groq Whisper)
//   /trade <SYM> <side> … → #4 CONTROLLED APPROVAL (opt-in, admin-only,
//                           PIN second factor, daily cap — creates a
//                           REQUEST; the Approve button triggers the
//                           site's existing executeSignal gauntlet)
//   plain text            → session memory: continue the LAST desk the
//                           chat used (default crypto — 24/7 desk)
//
// SECURITY (non-negotiable):
//   1. X-Telegram-Bot-Api-Secret-Token header must equal
//      TELEGRAM_WEBHOOK_SECRET when that env is set (Telegram's own
//      mechanism — set at setWebhook time). Without the env set, the
//      webhook refuses everything except in development mode.
//   2. ACCESS = ROLES (#6): the configured chat id (secrets/env) is
//      always ADMIN. TELEGRAM_ROLES="<chatid>:<admin|viewer>,…"
//      extends access — viewers can read/ask, admins can additionally
//      use /trade. Every other chat is ignored.
//   3. READ-ONLY BY DEFAULT: no text ever places an order. /trade only
//      creates an approval request; execution happens EXCLUSIVELY
//      through runApprovedExecution — the site's single executeSignal
//      path (kill switch, risk caps, mandate freeze all apply).
//
// Telegram always gets an HTTP 200 fast (long LLM turns happen off
// the response path) — otherwise Telegram retries and doubles AI cost.
// ============================================================
import {
  telegramConfig, sendTelegramMessageTo, telegramApiCall, telegramFileBase64,
} from '../ai/secrets.js';
import nodeCrypto from 'node:crypto'; // v10.13: constant-time secret-token compare
import { runIntradayAgentForExternal } from '../intraday/routes.js';
import { runCryptoAgent } from '../ai/cryptoAgent.js';
import { agentStatus, loadAgentConfig } from '../ai/agent.js';
import { getSignals } from '../ai/signals.js';
import { runWeeklyPerformanceReview } from '../ai/weeklyReview.js';
// accuracy-plan Phase 4: the /portfolio two-way command — net-worth
// digest + the red-flag engine (concentration × regime × AI views).
import { buildPortfolioDigestText } from '../ai/portfolioNarrative.js';
import { netWorthSnapshot, getAssetsSnapshot } from '../mcp/portfolioSync.js';
import { buildRegime } from '../ai/signals.js';
import { transcribeVoiceNote, voiceMimeOf } from '../ai/voiceNotes.js';
import {
  approvalEnabled, createTradeApproval, beginPinPhase, rejectTradeApproval,
  submitPin, parseTradeCommand, parseApprovalCallback, pendingRequest,
  requestById as _requestById, approvalStatus, ownsRequest,
} from '../ai/tradeApproval.js';
import { runApprovedExecution } from '../ai/routes.js';

const r2 = (v) => (Number.isFinite(v) ? Math.round(v * 100) / 100 : null);
const esc = (s) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// ---------------- session memory (chat-keyed, in-memory) ----------------
const SESSION_TTL_MS = 30 * 60 * 1000; // plain-text routing remembers 30 min
const _sessions = new Map(); // chatId → { desk: 'intraday'|'crypto', at }
const _inflight = new Set(); // chatId → one LLM turn at a time (cost guard)

export function __telegramSessionsForTests() { return _sessions; }

function sessionDeskFor(chatId) {
  const s = _sessions.get(chatId);
  if (s && Date.now() - s.at < SESSION_TTL_MS) return s.desk;
  _sessions.delete(chatId);
  return null;
}
function rememberDesk(chatId, desk) {
  _sessions.set(chatId, { desk, at: Date.now() });
}

// ---------------- #6: multi-user roles ----------------
// TELEGRAM_ROLES="<chatid>:admin,<chatid>:viewer" — the configured
// chat id (secrets/env) is ALWAYS admin. Unknown chats get nothing.
const _roles = new Map(); // chatId → 'admin' | 'viewer'
(function parseTelegramRoles() {
  for (const part of String(process.env.TELEGRAM_ROLES || '').split(',')) {
    const m = part.trim().match(/^(-?\d{3,20})\s*:\s*(admin|viewer)$/i);
    if (m) _roles.set(m[1], m[2].toLowerCase());
  }
})();

/** 'admin' | 'viewer' | null — null means NO access at all. */
export function roleForChat(chatId, adminChatId) {
  const id = String(chatId ?? '');
  if (adminChatId && id === String(adminChatId)) return 'admin';
  return _roles.get(id) || null;
}
export function __telegramRolesForTests() { return _roles; }

// ---------------- desk inference for voice notes ----------------
const CRYPTO_WORDS = /\b(btc|bitcoin|eth|ethereum|sol|solana|bnb|xrp|doge|ada|avax|dot|link|uni|shib|crypto|coindcx|perp|perpetual|funding|altcoin|usdt|usdc|memecoin)\b/i;
const INDIA_WORDS = /\b(nifty|sensex|banknifty|nse|bse|reliance|tcs|infy|infosys|hdfc|icici|sbi|itc|axis|kotak|adani|tata|bajaj|maruti|intraday|share\s?market|indian\s?market)\b/i;
function inferDeskFromText(text) {
  const t = String(text || '');
  if (CRYPTO_WORDS.test(t)) return 'crypto';
  if (INDIA_WORDS.test(t)) return 'intraday';
  return null;
}

// ---------------- command parsing ----------------
/** Split "/intraday BTC ka setup?" → { cmd: 'intraday', query: 'BTC ka setup?' } */
export function parseCommand(text) {
  const t = String(text || '').trim();
  // v20.7.3 FIX: 'portfolio' was missing from the command regex — the full
  // /portfolio handler existed (net-worth digest + red-flag engine) and
  // HELP_TEXT advertised it, but parseCommand could never return it, so
  // /portfolio fell through to the plain-text LLM routing (broken feature
  // + wasted tokens).
  const m = t.match(/^\/(intraday|crypto|status|help|start|trade|weeklyreview|whoami|portfolio)(?:@\w+)?(?:\s+([\s\S]*))?$/i);
  if (!m) return { cmd: null, query: t };
  return { cmd: m[1].toLowerCase(), query: (m[2] || '').trim() };
}

// ---------------- desk runners ----------------
async function runDeskAgent(desk, query, aiDeps) {
  const messages = [{ role: 'user', content: query.slice(0, 6000) }];
  if (desk === 'intraday') {
    const out = await runIntradayAgentForExternal(messages);
    return { ok: !!out?.ok, text: out?.ok ? out.text : (out?.error || 'intraday agent unavailable'), engine: out?.engine || null, tools: out?.toolsUsed || [] };
  }
  const out = await runCryptoAgent(messages, aiDeps || {});
  return { ok: !!out?.ok, text: out?.ok ? out.text : (out?.error || 'crypto agent unavailable'), engine: out?.engine || null, tools: out?.toolsUsed || [] };
}

const HELP_TEXT = [
  '🤖 <b>Wealth AI Pro — Interactive Desk Bot</b>',
  '',
  '<b>/crypto</b> &lt;question&gt; — CoinDCX desk agent (spot + futures setups, wallet, positions, sizing, track record)',
  '<b>/intraday</b> &lt;question&gt; — NSE intraday desk agent (setups, deep scans, regime, paper positions)',
  '<b>/portfolio</b> — net-worth digest + red flags (concentration × regime × holdings ke AI views)',
  '<b>/status</b> — dono desks ka snapshot (agent state + top signals)',
  '<b>/weeklyreview</b> — weekly trade-performance digest (journal + calibration)',
  '🎤 <b>Voice note bhejo</b> — transcribe hoke wahi desk agent chalta hai',
  '<b>/whoami</b> — is chat ka role (admin/viewer)',
  '',
  'Plain message bhejo to last-used desk continue hota hai (30 min memory). Answers full-ticket format me aate hain — entry/SL/targets/size/time-window ke saath.',
  '',
  '⚠️ Orders sirf /trade ke through, admin chat se — Approve button + PIN + daily cap ke saath. Baaki sab read-only hai.',
].join('\n');

async function buildStatusText(aiDeps) {
  const cfg = loadAgentConfig();
  let agentBlock = 'agent status unavailable';
  try {
    const st = await agentStatus(null);
    const wr = st.accuracy?.rollingWinRate;
    agentBlock = [
      `mode <b>${cfg.mode.toUpperCase()}</b>${cfg.enabled ? ' · RUNNING' : ' · STOPPED'}`,
      `today ${st.today?.tradesCount ?? 0}/${st.today?.maxTrades ?? '?'} trades · realized ₹${r2(st.today?.realizedPnlINR ?? 0)}`,
      wr != null ? `rolling win-rate ${wr}% (last ${st.accuracy?.rollingWindow})` : `rolling win-rate: needs ${st.accuracy?.rollingWindow} closed trades`,
      st.accuracy?.correlationGuard !== false ? 'guards: quorum-bar + ATR time-exit + correlation ON' : 'guards: partial',
      (st.blockers || []).slice(0, 2).map(b => `⚠️ ${b.text}`).join('\n'),
    ].filter(Boolean).join('\n');
  } catch { /* keep unavailable */ }

  const deskLines = [];
  try {
    const [crypto, india] = await Promise.all([
      getSignals('CRYPTO', aiDeps, { limit: 3, warmOnly: true }).catch(() => null),
      getSignals('INDIA', aiDeps, { limit: 3, warmOnly: true }).catch(() => null),
    ]);
    const topOf = (b) => (b?.signals || [])[0];
    const c = topOf(crypto), i = topOf(india);
    deskLines.push(`₿ <b>Crypto desk</b>: ${c ? `${c.symbol} ${c.side} ${c.grade} · AI ${c.superIntel?.aiScore ?? c.confidence}` : 'board warming — 30s baad /status'}`);
    deskLines.push(`🇮🇳 <b>India desk</b>: ${i ? `${i.symbol} ${i.side} ${i.grade} · AI ${i.superIntel?.aiScore ?? i.confidence}` : 'board warming — 30s baad /status'}`);
  } catch { /* best-effort */ }

  const appr = approvalEnabled() ? `\n\n🛡️ <b>Approval flow</b>: ARMED (/trade) — ${approvalStatus().dailyUsed}/${approvalStatus().dailyCap} used today` : '';
  return ['📊 <b>DESK STATUS</b>', '', ...deskLines, '', `🤖 <b>Auto-agent</b>\n${agentBlock}${appr}`].join('\n');
}

// ---------------- #4: the approval UX ----------------
function approvalKeyboard(requestId) {
  return {
    inline_keyboard: [[
      { text: '✅ Approve', callback_data: `ta:app:${requestId}` },
      { text: '❌ Reject', callback_data: `ta:rej:${requestId}` },
    ]],
  };
}

function approvalCardHtml(req, { pinPhase = false } = {}) {
  const head = pinPhase
    ? '🔐 <b>APPROVE KARNE KE LIYE PIN BHEJO</b>'
    : '🛡️ <b>TRADE APPROVAL REQUEST</b>';
  const lines = [
    head,
    '━━━━━━━━━━━━━━━━━━━━━━━',
    `📌 <b>${esc(req.symbol)}</b> · ${req.side === 'LONG' ? '🟢 LONG' : '🔴 SHORT'}${req.leverage ? ` · ${req.leverage}x` : ''}`,
    `🧾 mode <b>${esc(String(req.mode).toUpperCase())}</b>${req.qtyINR ? ` · size ₹${Number(req.qtyINR).toLocaleString('en-IN')}` : ' · site default sizing'}`,
  ];
  if (pinPhase) {
    lines.push(`⏳ PIN window: <b>3 min</b> · tries left: <b>${req.maxPinTries - req.pinTries}</b>`);
    lines.push('🔢 Abhi 4-12 digit PIN message me bhejo (chat me likha hua rahega — baad me delete kar lena). Cancel = "cancel" likho.');
  } else {
    lines.push(`⏳ Request TTL: <b>5 min</b> · daily cap ${approvalStatus().dailyCap} orders`);
    lines.push('👇 Button dabao — Approve pe PIN maangengega. Order sirf site ke FULL safety gauntlet se hi jayega (kill switch + risk caps + mandate freeze).');
  }
  return lines.join('\n');
}

async function handleTradeCommand({ query, chatKey, role, send }) {
  if (!approvalEnabled()) {
    await send('🛡️ Approval flow OFF hai (default). Enable: env me <code>AI_TELEGRAM_APPROVALS=on</code> + <code>AI_APPROVAL_PIN</code> set karo, phir deploy restart.');
    return;
  }
  if (role !== 'admin') {
    await send('🚫 Sirf <b>admin</b> chat trade approval use kar sakta hai (ye chat viewer hai).');
    return;
  }
  // parseTradeCommand is STRICT: it only ever parses a message that
  // starts with /trade (bare chat text must never become an order) —
  // so re-attach the prefix the router already stripped.
  const parsed = parseTradeCommand(`/trade ${String(query || '').trim()}`.trim());
  if (!parsed.ok) {
    await send(`⚠️ ${esc(parsed.error)}`);
    return;
  }
  const out = createTradeApproval({
    symbol: parsed.symbol, side: parsed.side, mode: parsed.mode,
    qtyINR: parsed.qtyINR, leverage: parsed.leverage, chatId: chatKey,
  });
  if (!out.ok) {
    if (out.error === 'daily-cap') {
      await send(`🛑 Daily approval cap hit (${out.used}/${out.cap}) — IST midnight pe reset. Kal try karo.`);
    } else if (out.error === 'one-at-a-time') {
      const p = pendingRequest();
      await send(`⏳ Ek request already pending hai (${p ? `${esc(p.symbol)} ${p.side}` : ''}) — pehle usko complete/reject karo (ya 5 min expiry ka wait karo).`);
    } else if (out.error === 'no-pin') {
      await send(`⚠️ ${esc(out.hint || 'AI_APPROVAL_PIN missing')}`);
    } else {
      await send(`⚠️ Approval create nahi hua: ${esc(out.error)}`);
    }
    return;
  }
  const r = await send(approvalCardHtml(out.request), undefined, approvalKeyboard(out.id));
  if (!r?.ok) await send('⚠️ Approval card send nahi hua — Telegram error. Dobara try karo.');
}

/** callback_query handler — the ONLY place an Approve tap is interpreted. */
async function handleApprovalCallback({ callbackQuery, send, cfgTG }) {
  const data = String(callbackQuery?.data || '');
  const cb = parseApprovalCallback(data);
  // answerCallbackQuery is fire-safe (never throws) — it just stops the
  // button's spinning clock; the chat message carries the real outcome.
  const answerCb = (text) => telegramApiCall('answerCallbackQuery', {
    callback_query_id: callbackQuery?.id,
    ...(text ? { text: String(text).slice(0, 190) } : {}),
  }, { token: cfgTG?.token || process.env.TG_TOKEN || '' });
  if (!cb) { await answerCb('Unknown request'); return { ok: true }; }

  if (cb.action === 'reject') {
    const out = rejectTradeApproval(cb.id);
    await answerCb(out.ok ? 'Rejected ✖' : 'Already closed');
    if (out.ok) await send('❌ <b>Trade request REJECTED</b> — kuch execute nahi hua.');
    return { ok: true };
  }

  // approve → PIN phase
  const out = beginPinPhase(cb.id);
  if (!out.ok) {
    await answerCb(out.error === 'expired' ? 'Expired' : 'Closed');
    if (out.error === 'expired') await send('⌛ Request expire ho gaya (5 min TTL) — /trade se naya banao.');
    else if (out.error === 'unknown-id') await send('⚠️ Unknown request.');
    else await send(`⚠️ Request ab open nahi hai (${esc(out.error)}).`);
    return { ok: true };
  }
  await answerCb('PIN bhejo ✅');
  await send(approvalCardHtml(out.request, { pinPhase: true }));
  return { ok: true };
}

/** Plain text while a request awaits its PIN: digit-like → PIN attempt.
 *  ONLY the chat that created the request — a viewer chat never sees
 *  (nor moves) someone else's approval. */
async function handlePossiblePin({ text, chatKey, send }) {
  const p = pendingRequest();
  if (!p || !ownsRequest(p.id, chatKey)) return false; // normal routing continues
  const t = String(text || '').trim();

  if (/^\/?(cancel|stop)$/i.test(t)) {
    const out = rejectTradeApproval(p.id);
    await send(out.ok ? '🚫 <b>Approval cancelled</b> — kuch execute nahi hua.' : `⚠️ ${esc(out.error)}`);
    return true;
  }
  if (!/^\d{4,12}$/.test(t)) {
    await send('🔐 Ek approval PIN ka wait kar raha hoon — 4-12 digit PIN bhejo, ya "cancel" likho. (Dusre sawaal abhi pause hain.)');
    return true; // swallow it — never let a PIN-window message hit an LLM
  }
  const out = await submitPin(p.id, t, { execute: (req) => runApprovedExecution(req) });
  if (!out.ok) {
    if (out.error === 'wrong-pin') {
      await send(`❌ Galat PIN — ${out.triesLeft} tries baaki. Phir se bhejo (ya "cancel").`);
    } else if (out.error === 'pin-dead') {
      await send('🛑 3 galat PIN — request dead ho gaya. /trade se naya banao (agar genuine tha).');
    } else {
      await send(`⚠️ ${esc(out.error)}`);
    }
    return true;
  }
  if (out.executed) {
    await send([
      '✅ <b>APPROVED + EXECUTED</b>',
      `📌 ${esc(out.request.symbol)} ${out.request.side}${out.request.leverage ? ` · ${out.request.leverage}x` : ''} · ${esc(String(out.request.mode).toUpperCase())}`,
      `📊 Result: <pre>${esc(JSON.stringify(out.result ?? {}).slice(0, 500))}</pre>`,
      `🛡️ Full gauntlet se gaya (kill switch / risk caps / mandate freeze) · daily cap: ${approvalStatus().dailyUsed}/${approvalStatus().dailyCap}`,
    ].filter(Boolean).join('\n'));
  } else {
    await send([
      '🚫 <b>GAUNTLET REFUSED</b> — order execute NAHI hua.',
      `📌 ${esc(out.request.symbol)} ${out.request.side}`,
      `Reason: <code>${esc(String(out.error || out.result?.error || 'refused').slice(0, 200))}</code>`,
      'ℹ️ Ye wahi safety checks hain jo website ke Execute button pe lagte hain — approve karne se bypass nahi hota.',
    ].filter(Boolean).join('\n'));
  }
  return true;
}

// ---------------- #5: voice notes ----------------
async function handleVoiceMessage({ voice, chatKey, cfgTG, aiDeps, send }) {
  await send('🎤 <i>Sun raha hoon — transcript bana raha hoon…</i>');
  const got = await telegramApiCall('getFile', { file_id: voice?.file_id }, { token: cfgTG.token });
  if (!got?.ok || !got?.result?.file_path) {
    await send(`⚠️ Voice file nahi mila (${esc(String(got?.error || 'getFile failed').slice(0, 120))}) — text me likho.`);
    return;
  }
  const dl = await telegramFileBase64(got.result.file_path, { token: cfgTG.token });
  if (!dl?.ok) {
    await send(`⚠️ ${esc(dl?.error || 'download failed')} — text me likho.`);
    return;
  }
  const tr = await transcribeVoiceNote(dl.base64, { mimeType: voiceMimeOf(voice) });
  if (!tr?.ok || !tr.text?.trim()) {
    await send(`⚠️ ${esc(String(tr?.error || 'transcription failed').slice(0, 180))}\n\n<i>Text me likho — wahi agent chalega.</i>`);
    return;
  }
  const said = tr.text.trim();
  await send(`📝 <b>Transcript</b> <i>(${esc(tr.engine)})</i>: "${esc(said.slice(0, 400))}"`);

  const desk = inferDeskFromText(said) || sessionDeskFor(chatKey) || 'crypto';
  rememberDesk(chatKey, desk);
  await send(desk === 'intraday' ? '⏳ Intraday desk agent soch raha hai…' : '⏳ Crypto desk agent soch raha hai…');
  const out = await runDeskAgent(desk, said, aiDeps);
  if (!out.ok || !out.text) {
    await send(`⚠️ ${out.text || 'agent unavailable'}`);
    return;
  }
  for (const c of chunkForTelegram(out.text)) await send(c);
  if (out.tools?.length) await send(`🔧 tools: ${out.tools.join(', ')}${out.engine ? ` · engine ${out.engine}` : ''}`);
}

/** Telegram hard-caps messages at 4096 chars — split longer tickets. */
function chunkForTelegram(text, MAX = 3900) {
  const chunks = [];
  let rest = String(text || '');
  while (rest.length > 0) {
    let cut = rest.length;
    if (cut > MAX) {
      const nl = rest.lastIndexOf('\n', MAX);
      cut = nl > MAX * 0.5 ? nl : MAX; // prefer a line break, else hard cut
    }
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  return chunks;
}

// ---------------- the webhook handler ----------------
/**
 * Register POST /api/telegram/webhook + the one-time setWebhook helper.
 * @param app  Express app
 * @param deps { KEYS, OPENAI_COMPAT, TG, jsonError } — AI + telegram deps
 */
export function registerTelegramWebhook(app, deps = {}) {
  const aiDeps = {
    KEYS: deps.KEYS,
    OPENAI_COMPAT: deps.OPENAI_COMPAT,
    getTradingConfig: deps.getTradingConfig,
  };
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET || '';

  app.post('/api/telegram/webhook', async (req, res) => {
    // Telegram needs a fast 200 ALWAYS — do the work after.
    const body = req.body || {};
    const respond = (ok, extra) => res.status(200).json({ ok, ...(extra || {}) });

    // ---- security gate 1: Telegram secret_token header ----
    if (secret) {
      // v10.13 (deep-recheck M-1): constant-time compare (the plain !== leaked
      // byte-by-byte through response timing — same digest pattern index.js
      // uses for the PIN and the service token).
      const got = String(req.headers['x-telegram-bot-api-secret-token'] || '');
      let eq = false;
      try {
        const ha = nodeCrypto.createHash('sha256').update(got).digest();
        const hb = nodeCrypto.createHash('sha256').update(secret).digest();
        eq = nodeCrypto.timingSafeEqual(ha, hb);
      } catch { eq = false; }
      if (!eq) {
        // A 4xx would make Telegram retry a foreign URL forever — the
        // documented pattern is a silent 200 drop.
        return respond(false);
      }
    } else if (String(process.env.NODE_ENV || '').toLowerCase() !== 'development') {
      // v10.13 (deep-recheck M-1): FAIL CLOSED in every mode except an
      // EXPLICIT NODE_ENV=development. The old check only refused
      // NODE_ENV === 'production' — the repo's own documented start paths
      // (start_server.vbs, plain `node server/index.js` on a VPS) run with
      // NODE_ENV unset, silently accepting forged updates with zero secret
      // (mirrors the v7.0.2 CORS fail-closed fix for the same footgun).
      // Refuse (still 200 to Telegram, but nothing is processed).
      return respond(false, { note: 'TELEGRAM_WEBHOOK_SECRET not configured' });
    }

    // ---- #4: callback_query (Approve/Reject buttons) ----
    const callbackQuery = body?.callback_query;
    if (callbackQuery?.id) {
      const cqChatId = callbackQuery?.message?.chat?.id;
      const cfgTG0 = telegramConfig({ token: deps.TG?.token || process.env.TG_TOKEN || '', chatId: deps.TG?.chatId || process.env.TG_CHAT_ID || '' });
      if (!cfgTG0) return respond(true, { ignored: 'telegram not configured' });
      // roles gate the buttons too — ONLY an admin chat may act on an
      // approval button, and only on a request that chat itself created
      const role0 = roleForChat(cqChatId, cfgTG0.chatId);
      if (!role0 || role0 !== 'admin') return respond(true, { ignored: 'buttons are admin-only' });
      const cbParsed = parseApprovalCallback(callbackQuery?.data);
      if (cbParsed && !ownsRequest(cbParsed.id, cqChatId)) {
        await telegramApiCall('answerCallbackQuery', {
          callback_query_id: callbackQuery.id,
          text: 'Ye request is chat ki nahi hai',
        }, { token: cfgTG0.token });
        return respond(true, { ignored: 'not owner' });
      }
      const send0 = (t) => sendTelegramMessageTo(cqChatId, t, { token: cfgTG0.token });
      setImmediate(() => {
        // v11.4 recheck: token rides along — answerCb used to resolve the
        // token from app-secrets ONLY (empty env), so in TG_TOKEN-env
        // deployments every Approve/Reject tap left the button's loading
        // clock spinning to timeout (the answer silently failed).
        handleApprovalCallback({ callbackQuery, send: send0, cfgTG: cfgTG0 })
          .catch(async (e) => { await send0(`⚠️ Approval error: ${String(e?.message || e).slice(0, 160)}`).catch(() => {}); });
      });
      return respond(true, { accepted: true });
    }

    const msg = body?.message;
    const chatId = msg?.chat?.id;
    const text = String(msg?.text || '').trim();
    const voice = msg?.voice;
    if (!chatId || (!text && !voice)) return respond(true, { ignored: 'no text or voice message' });

    // ---- security gate 2: role allowlist (#6) ----
    const cfgTG = telegramConfig({ token: deps.TG?.token || process.env.TG_TOKEN || '', chatId: deps.TG?.chatId || process.env.TG_CHAT_ID || '' });
    if (!cfgTG) return respond(true, { ignored: 'telegram not configured' });
    const role = roleForChat(chatId, cfgTG.chatId);
    if (!role) {
      return respond(true, { ignored: 'chat not allowlisted' }); // silently drop strangers
    }

    // ---- cost guard: one LLM turn per chat ----
    const chatKey = String(chatId);
    if (_inflight.has(chatKey)) {
      await sendTelegramMessageTo(chatKey, '⏳ Pichla answer abhi ban raha hai — dusra sawaal thodi der baad.', { token: cfgTG.token }).catch(() => {});
      return respond(true, { busy: true });
    }

    // process OFF the response path
    // v20.8.4 FIX (H3 — TOCTOU on the cost guard): the add used to happen
    // INSIDE setImmediate, but the has() check runs synchronously here —
    // two updates for the same chat delivered in the same event-loop poll
    // phase (Telegram bursts) BOTH passed the check before either
    // immediate ran, so the Set never blocked either turn (two concurrent
    // LLM turns, exactly the double-spend the guard exists to prevent).
    // Add synchronously right after the check; the existing finally owns
    // the delete.
    _inflight.add(chatKey);
    setImmediate(() => {
      (async () => {
        const send = (t, _unused, replyMarkup) => sendTelegramMessageTo(chatKey, t, { token: cfgTG.token }, { replyMarkup });
        try {
          if (voice) {
            await handleVoiceMessage({ voice, chatKey, cfgTG, aiDeps, send });
            return;
          }
          await handleTelegramCommand({ text, chatKey, role, cfgTG, aiDeps, send });
        } catch (e) {
          await send(`⚠️ Agent error: ${String(e?.message || e).slice(0, 160)}`).catch(() => {});
        } finally {
          _inflight.delete(chatKey);
        }
      })();
    });
    return respond(true, { accepted: true });
  });

  // ---------------- approval status (transparency route) ----------------
  app.get('/api/telegram/approval/status', (_req, res) => {
    try { res.json(approvalStatus()); } catch (e) { res.status(500).json({ ok: false, error: String(e?.message || e) }); }
  });

  // ---------------- one-time setup (auth'd, manual) ----------------
  // POST /api/telegram/setup-webhook { url: "https://<render-app>.onrender.com" }
  // Calls Telegram setWebhook with the secret — do this ONCE per deploy URL.
  app.post('/api/telegram/setup-webhook', async (req, res) => {
    try {
      const cfgTG = telegramConfig({ token: deps.TG?.token || process.env.TG_TOKEN || '', chatId: deps.TG?.chatId || process.env.TG_CHAT_ID || '' });
      if (!cfgTG || !cfgTG.token) return res.status(400).json({ ok: false, error: 'Telegram bot token not configured (secrets ya TG_TOKEN)' });
      const url = String(req.body?.url || '').trim();
      if (!/^https:\/\/.+/.test(url)) return res.status(400).json({ ok: false, error: 'url required (https://your-render-app.onrender.com)' });
      if (!secret) return res.status(400).json({ ok: false, error: 'TELEGRAM_WEBHOOK_SECRET env set karo pehle (random 32+ chars) — security requirement' });
      const r = await fetch(`https://api.telegram.org/bot${cfgTG.token}/setWebhook`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url: `${url.replace(/\/$/, '')}/api/telegram/webhook`,
          secret_token: secret,
          allowed_updates: ['message', 'callback_query'], // v10.9: buttons too
          drop_pending_updates: true,
        }),
        signal: AbortSignal.timeout(10_000),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j?.ok) return res.status(502).json({ ok: false, error: `setWebhook failed: ${j?.description || r.status}` });
      res.json({ ok: true, webhook: j.result, url: `${url.replace(/\/$/, '')}/api/telegram/webhook`, note: 'Telegram ab is URL pe messages + callback_query bhejega. TELEGRAM_WEBHOOK_SECRET verify hota hai har request pe.' });
    } catch (e) {
      res.status(500).json({ ok: false, error: `setup failed: ${e?.message || e}` });
    }
  });

  // quick delete (dev aid)
  app.post('/api/telegram/remove-webhook', async (_req, res) => {
    try {
      const cfgTG = telegramConfig({ token: deps.TG?.token || process.env.TG_TOKEN || '', chatId: deps.TG?.chatId || process.env.TG_CHAT_ID || '' });
      if (!cfgTG?.token) return res.status(400).json({ ok: false, error: 'telegram not configured' });
      const r = await fetch(`https://api.telegram.org/bot${cfgTG.token}/deleteWebhook`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}', signal: AbortSignal.timeout(10_000) });
      const j = await r.json().catch(() => ({}));
      res.json({ ok: !!j?.ok, result: j?.result ?? null });
    } catch (e) {
      res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
  });
}

// ---------------- command dispatcher ----------------
async function handleTelegramCommand({ text, chatKey, role, _cfgTG, aiDeps, send }) {
  // ---- PIN window first: a pending approval swallows digit messages ----
  if (await handlePossiblePin({ text, chatKey, send })) return;

  const { cmd, query } = parseCommand(text);

  if (cmd === 'help' || cmd === 'start') {
    await send(HELP_TEXT);
    return;
  }
  if (cmd === 'whoami') {
    const st = approvalStatus();
    await send(`🪪 Chat <code>${esc(chatKey)}</code> · role <b>${role.toUpperCase()}</b>\n${role === 'admin' ? '🛡️ /trade approvals available (agar enabled hai).' : '👀 Read-only access — desk agents + reports.'}${st.enabled ? `\nApproval flow: ARMED · aaj ${st.dailyUsed}/${st.dailyCap} used.` : ''}`);
    return;
  }
  if (cmd === 'status') {
    await send('⏳ Status ready ho raha hai…');
    await send(await buildStatusText(aiDeps));
    return;
  }
  if (cmd === 'weeklyreview') {
    await send('📊 <i>Weekly review bana raha hoon — journal + calibration scan…</i>');
    const out = await runWeeklyPerformanceReview(aiDeps);
    if (!out.ok) { await send(`📭 ${esc(out.error || 'review unavailable')}`); return; }
    for (const c of chunkForTelegram(out.text)) await send(c);
    if (out.cached) await send('♻️ <i>Ye is hafte ka cached review hai — naya data settle hone par refresh hoga.</i>');
    return;
  }
  // accuracy-plan Phase 4: the /portfolio two-way digest — the same
  // red-flag engine the site's Portfolio AI overlay runs, answered in
  // chat (net-worth by class + concentration × regime × AI-view flags).
  if (cmd === 'portfolio') {
    await send('💼 <i>Portfolio digest bana raha hoon — net worth + red flags…</i>');
    try {
      const nw = netWorthSnapshot();
      const snap = getAssetsSnapshot();
      const hidden = Array.isArray(snap?.hidden) ? snap.hidden : [];
      const assets = (Array.isArray(snap?.assets) ? snap.assets : []).filter(a => a && !hidden.includes(a.key));
      const total = Number(nw?.totalValueINR) || 0;
      const topHoldings = assets
        .filter(a => typeof a.value === 'number' && a.value > 0 && total > 0)
        .sort((a, b) => b.value - a.value)
        .slice(0, 6)
        .map(a => ({
          label: String(a.symbol || a.name || a.key || '').slice(0, 24),
          // coindcx rows are crypto; indmoney rows ride the INDMoney
          // asset taxonomy (equity/mf/etc → the India/US split the site
          // itself renders; digest-level granularity: india-vs-crypto)
          group: (a?.source === 'coindcx' || a?.kind === 'crypto') ? 'crypto' : 'india',
          weightPct: Math.round((a.value / total) * 1000) / 10,
          plPct: null,
        }));
      const [regimeIndia, regimeCrypto] = await Promise.all([
        buildRegime('INDIA').catch(() => null),
        buildRegime('CRYPTO').catch(() => null),
      ]);
      const text = await buildPortfolioDigestText({
        netWorth: nw,
        topHoldings,
        regimes: { INDIA: regimeIndia, CRYPTO: regimeCrypto },
        aiViews: {}, // digest-level: views fetched by the site overlay; here regime flags suffice
      });
      for (const c of chunkForTelegram(text)) await send(c);
    } catch (e) {
      await send(`📭 Portfolio digest unavailable: ${esc(String(e?.message || e))} — INDMoney/CoinDCX sync pehle karo (site ke Portfolio tab se).`);
    }
    return;
  }
  if (cmd === 'trade') {
    await handleTradeCommand({ query, chatKey, role, send });
    return;
  }

  let desk = null;
  if (cmd === 'intraday' || cmd === 'crypto') {
    desk = cmd;
    if (!query) {
      await send(desk === 'intraday'
        ? 'Likho: <b>/intraday RELIANCE ka setup kaisa hai?</b>'
        : 'Likho: <b>/crypto SOL ka deep analysis do</b>');
      return;
    }
  } else {
    // plain text → session memory picks the last desk (default crypto)
    desk = sessionDeskFor(chatKey) || 'crypto';
  }
  rememberDesk(chatKey, desk);

  await send(desk === 'intraday' ? '⏳ Intraday desk agent soch raha hai…' : '⏳ Crypto desk agent soch raha hai…');
  const out = await runDeskAgent(desk, query, aiDeps);
  if (!out.ok || !out.text) {
    await send(`⚠️ ${out.text || 'agent unavailable'}`);
    return;
  }
  for (const c of chunkForTelegram(out.text)) await send(c);
  // tool trace footer — the transparency the web panels show too
  if (out.tools?.length) {
    await send(`🔧 tools: ${out.tools.join(', ')}${out.engine ? ` · engine ${out.engine}` : ''}`);
  }
}

// test hooks
export const __testables = { parseCommand, buildStatusText, HELP_TEXT, handlePossiblePin, chunkForTelegram, inferDeskFromText };
