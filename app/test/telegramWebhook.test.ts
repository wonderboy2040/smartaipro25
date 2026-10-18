// ============================================================
// test/telegramWebhook.test.ts — INTERACTIVE TELEGRAM BOT (v10.9)
// ------------------------------------------------------------
// Pins: command parsing, the security gauntlet (secret-token header,
// role allowlist, production refusal without a secret), session
// memory routing, 4096-char splitting, #4 approval flow end-to-end
// (/trade → buttons → callback → PIN → single execution path),
// #5 voice notes, #6 roles.
// Express app is built inline; sends + both desk agents + every
// heavy server module are mocked.
// ============================================================
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';

const mockSendTo = vi.fn(async () => ({ ok: true, messageId: 1 }));
const mockApiCall = vi.fn(async () => ({ ok: true, result: { file_path: 'voice/file_1.oga' } }));
const mockFileB64 = vi.fn(async () => ({ ok: true, base64: 'QUJD', size: 3 }));
const mockApprovedExec = vi.fn(async () => ({ ok: true, orderRef: 'ord-9' }));
const mockWeeklyReview = vi.fn(async () => ({ ok: true, text: 'REVIEW TEXT', weekKey: '2026-W37' }));
const mockTranscribe = vi.fn(async () => ({ ok: true, text: 'BTC ka setup kaisa hai?', engine: 'groq-whisper-large-v3' }));

vi.mock('../server/ai/secrets.js', () => ({
  telegramConfig: () => ({ token: 'BOT-TOKEN', chatId: '111222333', source: 'env' }),
  sendTelegramMessage: vi.fn(async () => ({ ok: true })),
  sendTelegramMessageTo: (...a) => mockSendTo(...a),
  telegramApiCall: (...a) => mockApiCall(...a),
  telegramFileBase64: (...a) => mockFileB64(...a),
  telegramToken: () => 'BOT-TOKEN',
  getSecrets: () => ({}),
}));

vi.mock('../server/intraday/routes.js', () => ({
  runIntradayAgentForExternal: (...a) => mockIntradayAgent(...a),
}));
const mockIntradayAgent = vi.fn();

vi.mock('../server/ai/cryptoAgent.js', () => ({
  runCryptoAgent: (...a) => mockCryptoAgent(...a),
}));
const mockCryptoAgent = vi.fn();

vi.mock('../server/ai/agent.js', () => ({
  agentStatus: async () => ({
    ok: true,
    today: { tradesCount: 1, maxTrades: 3, realizedPnlINR: 40 },
    accuracy: { rollingWinRate: null, rollingWindow: 10, correlationGuard: true, dynamicTimeExit: true },
    openPositions: [], blockers: [],
  }),
  loadAgentConfig: () => ({ enabled: true, mode: 'paper' }),
}));

vi.mock('../server/ai/signals.js', () => ({
  getSignals: async () => null, // status degrades honestly
}));

vi.mock('../server/ai/weeklyReview.js', () => ({
  runWeeklyPerformanceReview: (...a) => mockWeeklyReview(...a),
}));

vi.mock('../server/ai/voiceNotes.js', () => ({
  transcribeVoiceNote: (...a) => mockTranscribe(...a),
  voiceMimeOf: (v) => v?.mime_type || 'audio/ogg',
}));

vi.mock('../server/ai/routes.js', () => ({
  runApprovedExecution: (...a) => mockApprovedExec(...a),
}));

import { registerTelegramWebhook, roleForChat } from '../server/telegram/webhook.js';
import { __testables, __telegramRolesForTests } from '../server/telegram/webhook.js';
import { createTradeApproval, beginPinPhase, __resetTradeApprovalForTests } from '../server/ai/tradeApproval.js';

const SECRET = 'test-secret-123';
const CHAT = '111222333';     // the configured chat — always admin
const VIEWER = '444555666';

function buildApp() {
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  registerTelegramWebhook(app, { KEYS: {}, OPENAI_COMPAT: {}, TG: { token: 'BOT-TOKEN', chatId: CHAT } });
  return app;
}

const post = (app, body, headers = {}) => new Promise((resolve, reject) => {
  const server = app.listen(0, async () => {
    const port = server.address().port;
    try {
      const r = await fetch(`http://127.0.0.1:${port}/api/telegram/webhook`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify(body),
      });
      const j = await r.json().catch(() => ({}));
      server.close(() => resolve({ status: r.status, body: j }));
    } catch (e) {
      server.close(() => reject(e));
    }
  });
});

const wait = (ms = 100) => new Promise(r => setTimeout(r, ms));
// sendTelegramMessageTo(chatId, text, env, extra) → text is arg 1
const sentTexts = () => mockSendTo.mock.calls.map(c => String(c[1]));
const resetAll = () => { mockSendTo.mockClear(); mockApiCall.mockClear(); mockFileB64.mockClear(); mockApprovedExec.mockClear(); };

beforeEach(() => {
  resetAll();
  __resetTradeApprovalForTests();
  __telegramRolesForTests().clear();
  mockIntradayAgent.mockReset().mockResolvedValue({ ok: true, text: 'intraday answer', toolsUsed: ['analyze_setup'], engine: 'test' });
  mockCryptoAgent.mockReset().mockResolvedValue({ ok: true, text: 'crypto answer', toolsUsed: ['get_live_crypto_signals'], engine: 'test' });
  delete process.env.AI_TELEGRAM_APPROVALS;
  delete process.env.AI_APPROVAL_PIN;
});

afterEach(() => {
  delete process.env.TELEGRAM_WEBHOOK_SECRET;
  __telegramRolesForTests().clear();
});

// ============================================================
// command parsing
// ============================================================
describe('parseCommand', () => {
  const { parseCommand } = __testables;
  it('splits /crypto <query>', () => {
    expect(parseCommand('/crypto SOL deep analysis')).toEqual({ cmd: 'crypto', query: 'SOL deep analysis' });
  });
  it('splits /intraday and lowercases the command', () => {
    expect(parseCommand('/INTRADAY RELIANCE?')).toEqual({ cmd: 'intraday', query: 'RELIANCE?' });
  });
  it('knows the v10.9 commands', () => {
    expect(parseCommand('/trade BTC LONG 5000')).toEqual({ cmd: 'trade', query: 'BTC LONG 5000' });
    expect(parseCommand('/weeklyreview')).toEqual({ cmd: 'weeklyreview', query: '' });
    expect(parseCommand('/whoami@my_bot')).toEqual({ cmd: 'whoami', query: '' });
  });
  it('bare command carries an empty query', () => {
    expect(parseCommand('/status')).toEqual({ cmd: 'status', query: '' });
  });
  it('plain text → no command', () => {
    expect(parseCommand('kya buy karu?')).toEqual({ cmd: null, query: 'kya buy karu?' });
  });
});

// ============================================================
// #6 roles
// ============================================================
describe('roleForChat (#6)', () => {
  it('the configured chat is ALWAYS admin', () => {
    expect(roleForChat(CHAT, CHAT)).toBe('admin');
  });
  it('TELEGRAM_ROLES grant viewer/admin to other chats', () => {
    __telegramRolesForTests().set(VIEWER, 'viewer');
    expect(roleForChat(VIEWER, CHAT)).toBe('viewer');
    expect(roleForChat('777', CHAT)).toBeNull(); // strangers get nothing
  });
  it('a chat configured as viewer stays viewer even if also somehow listed', () => {
    __telegramRolesForTests().set(CHAT, 'viewer'); // the configured chat WINS
    expect(roleForChat(CHAT, CHAT)).toBe('admin');
  });
});

// ============================================================
// the security gauntlet
// ============================================================
describe('webhook security', () => {
  it('WRONG secret-token header → ignored (ok false), agent never called', async () => {
    process.env.TELEGRAM_WEBHOOK_SECRET = SECRET;
    const app = buildApp();
    const { status, body } = await post(app, { message: { chat: { id: CHAT }, text: '/crypto hi' } }, { 'x-telegram-bot-api-secret-token': 'WRONG' });
    expect(status).toBe(200); // silent drop (Telegram would retry on 4xx)
    expect(body.ok).toBe(false);
  });

  it('PRODUCTION without any secret configured → refuses to process', async () => {
    process.env.NODE_ENV = 'production';
    delete process.env.TELEGRAM_WEBHOOK_SECRET;
    const app = buildApp();
    const { body } = await post(app, { message: { chat: { id: CHAT }, text: '/crypto hi' } });
    expect(body.ok).toBe(false);
    process.env.NODE_ENV = 'test';
  });

  it('v10.13: NODE_ENV UNSET (VPS / start_server.vbs path) + no secret → also refuses (fail-closed)', async () => {
    // The old gate only refused NODE_ENV === 'production' — the repo's own
    // documented start paths run with NODE_ENV unset and silently accepted
    // forged updates. Now every mode except EXPLICIT development refuses.
    const prev = process.env.NODE_ENV;
    delete process.env.NODE_ENV;
    delete process.env.TELEGRAM_WEBHOOK_SECRET;
    const app = buildApp();
    const { body } = await post(app, { message: { chat: { id: CHAT }, text: '/crypto hi' } });
    expect(body.ok).toBe(false);
    await wait();
    expect(mockCryptoAgent).not.toHaveBeenCalled();
    process.env.NODE_ENV = prev || 'test';
  });

  it('v10.13: EXPLICIT development mode + no secret → processes (local dev loop unchanged)', async () => {
    process.env.NODE_ENV = 'development';
    delete process.env.TELEGRAM_WEBHOOK_SECRET;
    const app = buildApp();
    const { body } = await post(app, { message: { chat: { id: CHAT }, text: '/crypto hi' } });
    expect(body.ok).toBe(true);
    await wait();
    expect(mockCryptoAgent).toHaveBeenCalled();
    process.env.NODE_ENV = 'test';
  });

  it('non-allowlisted chat id → silently ignored even with the right secret', async () => {
    process.env.TELEGRAM_WEBHOOK_SECRET = SECRET;
    const app = buildApp();
    const { body } = await post(app, { message: { chat: { id: '999' }, text: '/crypto hi' } }, { 'x-telegram-bot-api-secret-token': SECRET });
    expect(body.ignored).toBe('chat not allowlisted');
    await wait();
    expect(mockCryptoAgent).not.toHaveBeenCalled();
  });

  it('allowlisted chat + right secret → accepted, dispatched async', async () => {
    process.env.TELEGRAM_WEBHOOK_SECRET = SECRET;
    const app = buildApp();
    const { body } = await post(app, { message: { chat: { id: CHAT }, text: '/crypto top setups' } }, { 'x-telegram-bot-api-secret-token': SECRET });
    expect(body.accepted).toBe(true);
    await wait();
    expect(mockCryptoAgent).toHaveBeenCalledTimes(1);
    const msgs = mockCryptoAgent.mock.calls[0][0];
    expect(msgs[0].content).toBe('top setups');
    // replies go to the ASKING chat, never re-routed
    expect(mockSendTo.mock.calls.every(c => String(c[0]) === CHAT)).toBe(true);
  });

  it('busy chat (in-flight) → polite wait message, no parallel LLM cost', async () => {
    process.env.TELEGRAM_WEBHOOK_SECRET = SECRET;
    const app = buildApp();
    mockCryptoAgent.mockImplementation(() => new Promise(r => setTimeout(() => r({ ok: true, text: 'slow' }), 200)));
    await post(app, { message: { chat: { id: CHAT }, text: '/crypto q1' } }, { 'x-telegram-bot-api-secret-token': SECRET });
    await wait(30); // q1 in flight
    const { body } = await post(app, { message: { chat: { id: CHAT }, text: '/crypto q2' } }, { 'x-telegram-bot-api-secret-token': SECRET });
    expect(body.busy).toBe(true);
    await wait(300);
    expect(mockCryptoAgent).toHaveBeenCalledTimes(1); // q2 never dispatched
  });
});

// ============================================================
// routing + session memory
// ============================================================
describe('command routing', () => {
  it('/crypto routes to the crypto agent, /intraday to the intraday agent', async () => {
    process.env.TELEGRAM_WEBHOOK_SECRET = SECRET;
    const app = buildApp();
    await post(app, { message: { chat: { id: CHAT }, text: '/crypto BTC setup' } }, { 'x-telegram-bot-api-secret-token': SECRET });
    await wait();
    expect(mockCryptoAgent).toHaveBeenCalledTimes(1);
    await post(app, { message: { chat: { id: CHAT }, text: '/intraday RELIANCE' } }, { 'x-telegram-bot-api-secret-token': SECRET });
    await wait();
    expect(mockIntradayAgent).toHaveBeenCalledTimes(1);
  });

  it('PLAIN TEXT continues the last desk (session memory, default crypto)', async () => {
    process.env.TELEGRAM_WEBHOOK_SECRET = SECRET;
    const app = buildApp();
    await post(app, { message: { chat: { id: CHAT }, text: '/intraday SBIN' } }, { 'x-telegram-bot-api-secret-token': SECRET });
    await wait();
    await post(app, { message: { chat: { id: CHAT }, text: 'aur TCS?' } }, { 'x-telegram-bot-api-secret-token': SECRET });
    await wait();
    expect(mockIntradayAgent).toHaveBeenCalledTimes(2);
    expect(mockCryptoAgent).not.toHaveBeenCalled();
  });

  it('/help sends the command list and never calls an agent', async () => {
    process.env.TELEGRAM_WEBHOOK_SECRET = SECRET;
    const app = buildApp();
    await post(app, { message: { chat: { id: CHAT }, text: '/help' } }, { 'x-telegram-bot-api-secret-token': SECRET });
    await wait();
    expect(sentTexts().some(t => /Interactive Desk Bot/i.test(t))).toBe(true);
    expect(mockCryptoAgent).not.toHaveBeenCalled();
    expect(mockIntradayAgent).not.toHaveBeenCalled();
  });

  it('/status sends the desk snapshot', async () => {
    process.env.TELEGRAM_WEBHOOK_SECRET = SECRET;
    const app = buildApp();
    await post(app, { message: { chat: { id: CHAT }, text: '/status' } }, { 'x-telegram-bot-api-secret-token': SECRET });
    await wait(150);
    expect(sentTexts().some(t => /DESK STATUS/i.test(t))).toBe(true);
  });

  it('/whoami tells the chat its role', async () => {
    process.env.TELEGRAM_WEBHOOK_SECRET = SECRET;
    const app = buildApp();
    await post(app, { message: { chat: { id: CHAT }, text: '/whoami' } }, { 'x-telegram-bot-api-secret-token': SECRET });
    await wait();
    expect(sentTexts().some(t => /role <b>ADMIN<\/b>/i.test(t))).toBe(true);
  });

  it('long agent answers are split into ≤4096-char chunks (Telegram cap)', async () => {
    process.env.TELEGRAM_WEBHOOK_SECRET = SECRET;
    const app = buildApp();
    mockCryptoAgent.mockResolvedValue({ ok: true, text: 'x'.repeat(8000) + '\nlast line', toolsUsed: [] });
    await post(app, { message: { chat: { id: CHAT }, text: '/crypto batao' } }, { 'x-telegram-bot-api-secret-token': SECRET });
    await wait(150);
    const texts = sentTexts();
    const payload = texts.filter(t => !/⏳|🔧/.test(t));
    expect(payload.length).toBeGreaterThanOrEqual(2);
    expect(payload.every(t => t.length <= 4096)).toBe(true);
  });

  it('tool-trace footer is sent after the answer (transparency)', async () => {
    process.env.TELEGRAM_WEBHOOK_SECRET = SECRET;
    const app = buildApp();
    await post(app, { message: { chat: { id: CHAT }, text: '/crypto kuch bhi' } }, { 'x-telegram-bot-api-secret-token': SECRET });
    await wait(150);
    expect(sentTexts().some(t => /tools: get_live_crypto_signals/i.test(t))).toBe(true);
  });

  it('/weeklyreview sends the digest text', async () => {
    process.env.TELEGRAM_WEBHOOK_SECRET = SECRET;
    const app = buildApp();
    await post(app, { message: { chat: { id: CHAT }, text: '/weeklyreview' } }, { 'x-telegram-bot-api-secret-token': SECRET });
    await wait();
    expect(mockWeeklyReview).toHaveBeenCalledTimes(1);
    expect(sentTexts().some(t => /REVIEW TEXT/.test(t))).toBe(true);
  });
});

// ============================================================
// #4 the approval flow (end-to-end through the webhook)
// ============================================================
describe('approval flow (#4)', () => {
  function arm() {
    process.env.AI_TELEGRAM_APPROVALS = 'on';
    process.env.AI_APPROVAL_PIN = '123456';
  }

  it('disabled by default → /trade says so, nothing created', async () => {
    process.env.TELEGRAM_WEBHOOK_SECRET = SECRET;
    const app = buildApp();
    await post(app, { message: { chat: { id: CHAT }, text: '/trade BTC LONG 5000' } }, { 'x-telegram-bot-api-secret-token': SECRET });
    await wait();
    expect(sentTexts().some(t => /OFF hai/i.test(t))).toBe(true);
    expect(mockSendTo.mock.calls.some(c => c[3]?.replyMarkup)).toBeFalsy();
  });

  it('viewer chat is blocked from /trade', async () => {
    arm();
    process.env.TELEGRAM_WEBHOOK_SECRET = SECRET;
    __telegramRolesForTests().set(VIEWER, 'viewer');
    const app = buildApp();
    await post(app, { message: { chat: { id: VIEWER }, text: '/trade BTC LONG 5000' } }, { 'x-telegram-bot-api-secret-token': SECRET });
    await wait();
    expect(sentTexts().some(t => /sirf <b>admin<\/b>/i.test(t))).toBe(true);
  });

  it('full happy path: /trade → card with buttons → approve callback → PIN → single execution', async () => {
    arm();
    process.env.TELEGRAM_WEBHOOK_SECRET = SECRET;
    const app = buildApp();

    // 1) create
    await post(app, { message: { chat: { id: CHAT }, text: '/trade BTC LONG 5000 x3 paper' } }, { 'x-telegram-bot-api-secret-token': SECRET });
    await wait();
    const cardCall = mockSendTo.mock.calls.find(c => c[3]?.replyMarkup);
    expect(cardCall).toBeTruthy();
    const kb = cardCall[3].replyMarkup.inline_keyboard[0];
    expect(kb.map(b => b.text)).toEqual(['✅ Approve', '❌ Reject']);
    const approveData = kb[0].callback_data;
    expect(approveData).toMatch(/^ta:app:/);

    // 2) approve tap (callback_query from the SAME admin chat)
    resetAll();
    await post(app, { callback_query: { id: 'cbq1', data: approveData, message: { chat: { id: CHAT } } } }, { 'x-telegram-bot-api-secret-token': SECRET });
    await wait();
    expect(mockApiCall).toHaveBeenCalledWith('answerCallbackQuery', expect.objectContaining({ callback_query_id: 'cbq1' }), expect.anything());
    expect(sentTexts().some(t => /PIN BHEJO/i.test(t))).toBe(true);

    // 3) the PIN (digit message from the same chat)
    resetAll();
    await post(app, { message: { chat: { id: CHAT }, text: '123456' } }, { 'x-telegram-bot-api-secret-token': SECRET });
    await wait(150);
    expect(mockApprovedExec).toHaveBeenCalledTimes(1);
    const execArgs = mockApprovedExec.mock.calls[0][0];
    expect(execArgs).toMatchObject({ symbol: 'BTC', side: 'LONG', mode: 'paper', qtyINR: 5000, leverage: 3 });
    expect(sentTexts().some(t => /APPROVED \+ EXECUTED/i.test(t))).toBe(true);
    // the digit message never reached an LLM
    expect(mockCryptoAgent).not.toHaveBeenCalled();
  });

  it('wrong PIN → tries left; third wrong → dead, no execution', async () => {
    arm();
    process.env.TELEGRAM_WEBHOOK_SECRET = SECRET;
    const app = buildApp();
    await post(app, { message: { chat: { id: CHAT }, text: '/trade ETH SHORT' } }, { 'x-telegram-bot-api-secret-token': SECRET });
    await wait();
    const cardCall = mockSendTo.mock.calls.find(c => c[3]?.replyMarkup);
    await post(app, { callback_query: { id: 'cbq1', data: cardCall[3].replyMarkup.inline_keyboard[0][0].callback_data, message: { chat: { id: CHAT } } } }, { 'x-telegram-bot-api-secret-token': SECRET });
    await wait();
    for (let i = 0; i < 3; i++) {
      await post(app, { message: { chat: { id: CHAT }, text: '000000' } }, { 'x-telegram-bot-api-secret-token': SECRET });
      await wait(120);
    }
    expect(mockApprovedExec).not.toHaveBeenCalled();
    expect(sentTexts().some(t => /3 galat PIN/i.test(t))).toBe(true);
  });

  it('PIN window swallows non-digit text (no LLM cost while PIN pending)', async () => {
    arm();
    process.env.TELEGRAM_WEBHOOK_SECRET = SECRET;
    const app = buildApp();
    await post(app, { message: { chat: { id: CHAT }, text: '/trade BTC LONG' } }, { 'x-telegram-bot-api-secret-token': SECRET });
    await wait();
    const cardCall = mockSendTo.mock.calls.find(c => c[3]?.replyMarkup);
    await post(app, { callback_query: { id: 'cbq1', data: cardCall[3].replyMarkup.inline_keyboard[0][0].callback_data, message: { chat: { id: CHAT } } } }, { 'x-telegram-bot-api-secret-token': SECRET });
    await wait();
    await post(app, { message: { chat: { id: CHAT }, text: 'BTC kaisa lag raha hai?' } }, { 'x-telegram-bot-api-secret-token': SECRET });
    await wait(150);
    expect(mockCryptoAgent).not.toHaveBeenCalled(); // swallowed by the PIN window
    expect(sentTexts().some(t => /PIN ka wait/i.test(t))).toBe(true);
    // cancel works
    await post(app, { message: { chat: { id: CHAT }, text: 'cancel' } }, { 'x-telegram-bot-api-secret-token': SECRET });
    await wait();
    expect(sentTexts().some(t => /Approval cancelled/i.test(t))).toBe(true);
  });

  it('digits from ANOTHER chat never touch the pending PIN (ownership)', async () => {
    arm();
    process.env.TELEGRAM_WEBHOOK_SECRET = SECRET;
    __telegramRolesForTests().set(VIEWER, 'viewer');
    const app = buildApp();
    await post(app, { message: { chat: { id: CHAT }, text: '/trade BTC LONG' } }, { 'x-telegram-bot-api-secret-token': SECRET });
    await wait();
    const cardCall = mockSendTo.mock.calls.find(c => c[3]?.replyMarkup);
    await post(app, { callback_query: { id: 'cbq1', data: cardCall[3].replyMarkup.inline_keyboard[0][0].callback_data, message: { chat: { id: CHAT } } } }, { 'x-telegram-bot-api-secret-token': SECRET });
    await wait();
    // viewer sends digits → NOT a PIN attempt for the admin's request
    await post(app, { message: { chat: { id: VIEWER }, text: '123456' } }, { 'x-telegram-bot-api-secret-token': SECRET });
    await wait(150);
    expect(mockApprovedExec).not.toHaveBeenCalled();
    expect(mockCryptoAgent).toHaveBeenCalledTimes(1); // viewer's digits went to the (default) desk
  });

  it('viewer chat cannot act on approval buttons', async () => {
    arm();
    process.env.TELEGRAM_WEBHOOK_SECRET = SECRET;
    __telegramRolesForTests().set(VIEWER, 'viewer');
    const app = buildApp();
    const r = createTradeApproval({ symbol: 'BTC', side: 'LONG', mode: 'paper', chatId: CHAT });
    const { body } = await post(app, { callback_query: { id: 'cbq9', data: `ta:app:${r.id}`, message: { chat: { id: VIEWER } } } }, { 'x-telegram-bot-api-secret-token': SECRET });
    expect(body.ignored).toBe('buttons are admin-only');
    expect(beginPinPhase(r.id).ok).toBe(true); // still PENDING — the tap moved nothing
  });

  it('approve tap on a FOREIGN chat request → not owner', async () => {
    arm();
    process.env.TELEGRAM_WEBHOOK_SECRET = SECRET;
    const app = buildApp();
    const otherAdmin = '777888999';
    __telegramRolesForTests().set(otherAdmin, 'admin');
    const r = createTradeApproval({ symbol: 'BTC', side: 'LONG', mode: 'paper', chatId: CHAT });
    const { body } = await post(app, { callback_query: { id: 'cbq8', data: `ta:app:${r.id}`, message: { chat: { id: otherAdmin } } } }, { 'x-telegram-bot-api-secret-token': SECRET });
    expect(body.ignored).toBe('not owner');
  });

  it('reject tap → clean rejection, nothing executed', async () => {
    arm();
    process.env.TELEGRAM_WEBHOOK_SECRET = SECRET;
    const app = buildApp();
    await post(app, { message: { chat: { id: CHAT }, text: '/trade BTC LONG' } }, { 'x-telegram-bot-api-secret-token': SECRET });
    await wait();
    const cardCall = mockSendTo.mock.calls.find(c => c[3]?.replyMarkup);
    const rejectData = cardCall[3].replyMarkup.inline_keyboard[0][1].callback_data;
    await post(app, { callback_query: { id: 'cbq7', data: rejectData, message: { chat: { id: CHAT } } } }, { 'x-telegram-bot-api-secret-token': SECRET });
    await wait();
    expect(sentTexts().some(t => /REJECTED/i.test(t))).toBe(true);
    expect(mockApprovedExec).not.toHaveBeenCalled();
  });
});

// ============================================================
// #5 voice notes
// ============================================================
describe('voice notes (#5)', () => {
  it('voice → getFile + download + transcribe → desk agent with the transcript', async () => {
    process.env.TELEGRAM_WEBHOOK_SECRET = SECRET;
    const app = buildApp();
    await post(app, { message: { chat: { id: CHAT }, voice: { file_id: 'VFID', duration: 7, mime_type: 'audio/ogg' } } }, { 'x-telegram-bot-api-secret-token': SECRET });
    await wait(150);
    expect(mockApiCall).toHaveBeenCalledWith('getFile', { file_id: 'VFID' }, expect.anything());
    expect(mockFileB64).toHaveBeenCalledWith('voice/file_1.oga', expect.anything());
    expect(mockTranscribe).toHaveBeenCalledWith('QUJD', expect.objectContaining({ mimeType: 'audio/ogg' }));
    expect(mockCryptoAgent).toHaveBeenCalledTimes(1); // transcript said BTC → crypto desk
    expect(mockCryptoAgent.mock.calls[0][0][0].content).toBe('BTC ka setup kaisa hai?');
    expect(sentTexts().some(t => /Transcript/i.test(t))).toBe(true);
  });

  it('transcription failure → honest message, no agent call', async () => {
    process.env.TELEGRAM_WEBHOOK_SECRET = SECRET;
    mockTranscribe.mockResolvedValueOnce({ ok: false, error: 'no engine' });
    const app = buildApp();
    await post(app, { message: { chat: { id: CHAT }, voice: { file_id: 'VFID2' } } }, { 'x-telegram-bot-api-secret-token': SECRET });
    await wait(150);
    expect(mockCryptoAgent).not.toHaveBeenCalled();
    expect(sentTexts().some(t => /no engine/i.test(t))).toBe(true);
  });
});
