// Telegram Bot API client (long polling, no third-party library).
// Every dynamic string is HTML-escaped by the formatters before it gets here;
// this client only adds transport-level safety (chunking + parse fallback).

import { htmlToPlain, sleep, splitHtml, splitPlain, stripControl } from './util.mjs';

// Telegram errors keep the transport cause for logs, never for user output.
export class TelegramError extends Error {
  constructor(message, { code = 0, retryAfter = null, method = '', cause = null } = {}) {
    super(message);
    this.name = 'TelegramError';
    this.code = code;
    this.retryAfter = retryAfter;
    this.method = method;
    this.cause = cause;
  }
}

const PARSE_ERROR = /can't parse entities|can't find end|unsupported start tag|unexpected end tag/i;
const NOT_EDITABLE = /message to edit not found|message can't be edited|message is not modified/i;

export class TelegramClient {
  constructor({ token, baseUrl = 'https://api.telegram.org', logger = null, fetchImpl = globalThis.fetch } = {}) {
    if (!token) throw new Error('Telegram token missing');
    if (typeof fetchImpl !== 'function') throw new Error('global fetch unavailable (Node 20+ required)');
    this.token = String(token);
    this.baseUrl = String(baseUrl || 'https://api.telegram.org').replace(/\/+$/, '');
    this.logger = logger;
    this.fetchImpl = fetchImpl;
    this.typingAt = new Map();
  }

  async call(method, payload = {}, { timeoutMs = 20000, retries = 1 } = {}) {
    const url = `${this.baseUrl}/bot${this.token}/${method}`;
    const attempts = Math.max(0, Number(retries) || 0) + 1;
    let lastError = null;

    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        const response = await this.fetchImpl(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(timeoutMs),
        });
        const raw = await response.text();
        let data = null;
        if (raw) {
          try { data = JSON.parse(raw); } catch { data = null; }
        }
        if (!response.ok || data?.ok === false) {
          const description = String(data?.description || `HTTP ${response.status}`)
            .replaceAll(this.token, '***');
          const error = new TelegramError(description, {
            code: Number(data?.error_code || response.status || 0),
            retryAfter: Number(data?.parameters?.retry_after || 0) || null,
            method,
          });
          if (error.code === 429) {
            if (attempt < attempts - 1) {
              const waitSec = Math.max(1, Number(error.retryAfter) || 1);
              await sleep(Math.min(10000, waitSec * 1000));
              continue;
            }
          }
          if (error.code >= 500 && attempt < attempts - 1) {
            await sleep(700 * (attempt + 1));
            continue;
          }
          throw error;
        }
        return data?.result ?? null;
      } catch (error) {
        lastError = error instanceof TelegramError
          ? error
          : new TelegramError(
            String(error?.message || error).replaceAll(this.token, '***'),
            { code: 0, method, cause: error?.cause || null },
          );
        const retryable = lastError.code === 0 || lastError.code >= 500;
        if (!retryable || attempt === attempts - 1) break;
        await sleep(700 * (attempt + 1));
      }
    }
    this.logger?.warn('telegram call failed', {
      method,
      code: lastError?.code || 0,
      cause: lastError?.cause?.code || lastError?.cause?.message || null,
    });
    throw lastError;
  }

  getMe() {
    return this.call('getMe', {}, { timeoutMs: 10000, retries: 2 });
  }

  deleteWebhook(dropPending = false) {
    return this.call('deleteWebhook', { drop_pending_updates: Boolean(dropPending) }, {
      timeoutMs: 12000,
      retries: 2,
    });
  }

  setMyCommands(commands) {
    return this.call('setMyCommands', { commands }, { timeoutMs: 12000, retries: 2 });
  }

  getUpdates({ offset = 0, timeout = 25, allowedUpdates = ['message', 'callback_query'] } = {}) {
    return this.call('getUpdates', {
      offset,
      timeout,
      allowed_updates: allowedUpdates,
    }, {
      timeoutMs: Math.max(15000, (Number(timeout) + 10) * 1000),
      retries: 0,
    });
  }

  async sendRaw(chatId, text, { parseMode = 'HTML', keyboard = null, disablePreview = true } = {}) {
    const payload = {
      chat_id: chatId,
      text: stripControl(text),
      disable_web_page_preview: Boolean(disablePreview),
    };
    if (parseMode) payload.parse_mode = parseMode;
    if (keyboard) payload.reply_markup = { inline_keyboard: keyboard };
    return this.call('sendMessage', payload, { timeoutMs: 20000, retries: 1 });
  }

  async editRaw(chatId, messageId, text, { parseMode = 'HTML', keyboard = null, disablePreview = true } = {}) {
    const payload = {
      chat_id: chatId,
      message_id: messageId,
      text: stripControl(text),
      disable_web_page_preview: Boolean(disablePreview),
    };
    if (parseMode) payload.parse_mode = parseMode;
    if (keyboard) payload.reply_markup = { inline_keyboard: keyboard };
    return this.call('editMessageText', payload, { timeoutMs: 20000, retries: 0 });
  }

  async send(chatId, text, { keyboard = null, plain = false, disablePreview = true } = {}) {
    const chunks = plain ? splitPlain(text, 4000) : splitHtml(text, 3900);
    if (!chunks.length) return null;
    let last = null;
    for (let i = 0; i < chunks.length; i += 1) {
      const isLast = i === chunks.length - 1;
      const chunk = chunks[i];
      try {
        last = await this.sendRaw(chatId, chunk, {
          parseMode: plain ? null : 'HTML',
          keyboard: isLast ? keyboard : null,
          disablePreview,
        });
      } catch (error) {
        if (!plain && error instanceof TelegramError && PARSE_ERROR.test(error.message)) {
          this.logger?.warn('telegram parse fallback (send)');
          last = await this.sendRaw(chatId, htmlToPlain(chunk), {
            parseMode: null,
            keyboard: isLast ? keyboard : null,
            disablePreview,
          });
        } else {
          throw error;
        }
      }
    }
    return last;
  }

  async edit(chatId, messageId, text, { keyboard = null, plain = false, disablePreview = true } = {}) {
    const chunks = plain ? splitPlain(text, 4000) : splitHtml(text, 3900);
    if (!chunks.length) return null;
    let last = null;
    try {
      last = await this.editRaw(chatId, messageId, chunks[0], {
        parseMode: plain ? null : 'HTML',
        keyboard: chunks.length === 1 ? keyboard : null,
        disablePreview,
      });
    } catch (error) {
      if (!plain && error instanceof TelegramError && PARSE_ERROR.test(error.message)) {
        last = await this.editRaw(chatId, messageId, htmlToPlain(chunks[0]), {
          parseMode: null,
          keyboard: chunks.length === 1 ? keyboard : null,
          disablePreview,
        });
      } else if (error instanceof TelegramError && NOT_EDITABLE.test(error.message)) {
        const marked = new TelegramError(error.message, {
          code: error.code,
          retryAfter: error.retryAfter,
          method: error.method,
        });
        marked.notEditable = /message is not modified/i.test(error.message) ? false : true;
        marked.unchanged = /message is not modified/i.test(error.message);
        throw marked;
      } else {
        throw error;
      }
    }
    if (chunks.length > 1) {
      for (let i = 1; i < chunks.length; i += 1) {
        const isLast = i === chunks.length - 1;
        last = await this.sendRaw(chatId, chunks[i], {
          parseMode: plain ? null : 'HTML',
          keyboard: isLast ? keyboard : null,
          disablePreview,
        });
      }
    }
    return last;
  }

  async answerCallback(callbackId, text = '', { showAlert = false } = {}) {
    if (!callbackId) return null;
    try {
      return await this.call('answerCallbackQuery', {
        callback_query_id: callbackId,
        text: text ? String(text).slice(0, 190) : undefined,
        show_alert: Boolean(showAlert),
      }, { timeoutMs: 10000, retries: 0 });
    } catch (error) {
      this.logger?.debug('answerCallback failed', { error: error?.message || String(error) });
      return null;
    }
  }

  async typing(chatId) {
    const key = String(chatId);
    const now = Date.now();
    const last = this.typingAt.get(key);
    if (last && now - last < 4000) return;
    this.typingAt.set(key, now);
    try {
      await this.call('sendChatAction', { chat_id: chatId, action: 'typing' }, {
        timeoutMs: 8000,
        retries: 0,
      });
    } catch {
      /* typing is cosmetic */
    }
  }
}
