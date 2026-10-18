// ============================================================
// test/aiSecrets.test.ts — v6.5 SECRETS STORE
// ------------------------------------------------------------
// Validation (400-shaped), masked status (NEVER raw values),
// telegram resolution (secrets WIN over env) and delivery.
// ============================================================
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import {
  getSecrets, setSecret, secretsStatus, telegramConfig, sendTelegramMessage,
  __resetSecretsForTests,
} from '../server/ai/secrets.js';
import { loadJSON as loadJSONOrig, saveJSON } from '../server/lib/store.js';

let _orig = null;
beforeEach(() => {
  _orig = JSON.parse(JSON.stringify(loadJSONOrig('ai-secrets.json') || {}));
  __resetSecretsForTests();
});
afterEach(() => {
  saveJSON('ai-secrets.json', _orig && Object.keys(_orig).length ? _orig : { secrets: {}, updatedAt: 0 });
  vi.restoreAllMocks();
});

describe('setSecret — strict validation', () => {
  it('rejects unknown keys', () => {
    expect(() => setSecret('apiKey', 'x')).toThrow(/Unknown secret key/);
  });

  it('telegramBotToken: format <botId>:<hash>', () => {
    expect(() => setSecret('telegramBotToken', 'garbage')).toThrow(/BotFather/);
    setSecret('telegramBotToken', '123456789:AAEhBOweik6ad9r_QXMENQjcrGbqCr5U-tU');
    expect(getSecrets().telegramBotToken).toBe('123456789:AAEhBOweik6ad9r_QXMENQjcrGbqCr5U-tU');
  });

  it('telegramChatId: numeric (supergroup -100 prefix tolerated)', () => {
    expect(() => setSecret('telegramChatId', 'abc')).toThrow(/numeric/);
    setSecret('telegramChatId', '-1001234567890');
    expect(getSecrets().telegramChatId).toBe('1001234567890');
  });

  it('gemini/groq keys: long tokens only', () => {
    expect(() => setSecret('geminiApiKey', 'short')).toThrow(/invalid/i);
    expect(() => setSecret('groqApiKey', 'has spaces inside')).toThrow(/invalid/i);
    setSecret('geminiApiKey', 'AIzaSy' + 'x'.repeat(40));
    setSecret('groqApiKey', 'gsk_' + 'x'.repeat(40));
    expect(getSecrets().geminiApiKey).toBeTruthy();
    expect(getSecrets().groqApiKey).toBeTruthy();
  });

  it('null clears a secret', () => {
    setSecret('geminiApiKey', 'AIzaSy' + 'x'.repeat(40));
    setSecret('geminiApiKey', null);
    expect(getSecrets().geminiApiKey).toBeUndefined();
  });
});

describe('secretsStatus — masked, never raw', () => {
  it('returns configured + 4-char tail only', () => {
    setSecret('telegramBotToken', '123456789:AAEhBOweik6ad9r_QXMENQjcrGbqCr5U-tU');
    const st = secretsStatus();
    expect(st.telegramBotToken.configured).toBe(true);
    expect(st.telegramBotToken.tail).toBe('…U-tU');
    expect(st.telegramChatId.configured).toBe(false);
    const raw = JSON.stringify(st);
    expect(raw).not.toContain('AAEhBOweik');
  });
});

describe('telegramConfig — resolution order', () => {
  it('null when nothing is configured', () => {
    expect(telegramConfig({})).toBeNull();
    expect(telegramConfig({})).toBeNull();
  });

  it('secrets WIN over env', () => {
    setSecret('telegramBotToken', '123456789:AAEhBOweik6ad9r_QXMENQjcrGbqCr5U-tU');
    setSecret('telegramChatId', '987654321');
    const cfg = telegramConfig({ token: 'env-token', chatId: 'env-chat' });
    expect(cfg!.token).toBe('123456789:AAEhBOweik6ad9r_QXMENQjcrGbqCr5U-tU');
    expect(cfg!.chatId).toBe('987654321');
    expect(cfg!.source).toBe('app');
  });

  it('env fallback when no secret is stored', () => {
    const cfg = telegramConfig({ token: 'env-token', chatId: 'env-chat' });
    expect(cfg!.token).toBe('env-token');
    expect(cfg!.source).toBe('env');
  });

  it('needs BOTH token and chatId (half-configured = off)', () => {
    setSecret('telegramBotToken', '123456789:AAEhBOweik6ad9r_QXMENQjcrGbqCr5U-tU');
    expect(telegramConfig({})).toBeNull();
  });
});

describe('sendTelegramMessage — delivery', () => {
  it('returns ok:false (no throw) when unconfigured', async () => {
    const out = await sendTelegramMessage('hi', {});
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/not configured/);
  });

  it('POSTs to the bot API with HTML parse mode', async () => {
    setSecret('telegramBotToken', '123456789:AAEhBOweik6ad9r_QXMENQjcrGbqCr5U-tU');
    setSecret('telegramChatId', '987654321');
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ ok: true }) }));
    vi.stubGlobal('fetch', fetchMock);
    const out = await sendTelegramMessage('<b>test</b>', {});
    expect(out.ok).toBe(true);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain('bot123456789:AAEhBOweik6ad9r_QXMENQjcrGbqCr5U-tU/sendMessage');
    expect(init.method).toBe('POST');
    const body = JSON.parse(init.body);
    expect(body.chat_id).toBe('987654321');
    expect(body.parse_mode).toBe('HTML');
  });

  it('surfaces an HTTP failure without throwing', async () => {
    setSecret('telegramBotToken', '123456789:AAEhBOweik6ad9r_QXMENQjcrGbqCr5U-tU');
    setSecret('telegramChatId', '987654321');
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 400, text: async () => 'Bad Request: chat not found' })));
    const out = await sendTelegramMessage('x', {});
    expect(out.ok).toBe(false);
    expect(out.error).toContain('400');
  });
});
