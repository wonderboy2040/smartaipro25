// Update router: owner gate -> confirmation gate -> per-chat queue -> command
// handler -> Telegram delivery. Dangerous actions never execute from a plain
// command; they require an inline callback tap.

import { randomBytes } from 'node:crypto';
import { createCommandHandlers, parseCommand, resolveCommand } from './commands.mjs';
import {
  autoActionResult,
  autoKeyboard,
  errorResult,
  formatAutoStatus,
  menuResult,
} from './format.mjs';
import { maskId } from './util.mjs';

const SLOW_LABEL = {
  scan: '🔎 Fresh scan chal raha hai… (20–90s)',
  weekly: '📊 Weekly review compute ho raha hai… (up to 90s)',
  pnl: '📊 Weekly review compute ho raha hai… (up to 90s)',
  agent: '🧠 Desk agent soch raha hai…',
  crypto: '🧠 Crypto desk soch raha hai…',
  india: '🧠 India desk soch raha hai…',
};

export function isSlowCommand(name, args = '') {
  if (name === 'scan' || name === 'weekly') return true;
  if (name === 'pnl' && /^(week|weekly|hafta|hafte)\b/i.test(String(args))) return true;
  if (name === 'agent') return true;
  if ((name === 'crypto' || name === 'india') && String(args).trim()) return true;
  return false;
}

function normaliseResult(result) {
  if (!result) return { text: '—' };
  if (typeof result === 'string') return { text: result };
  return { ...result, text: String(result.text ?? '—') };
}

export function createRouter({
  api,
  tg,
  config,
  logger = null,
  clock = () => Date.now(),
  botUsername = null,
} = {}) {
  const { handlers, clearHistory } = createCommandHandlers({ api, tg, config, clock, logger });
  const pending = new Map(); // `${chatId}:${token}` -> { id, chatId, action, createdAt, messageId }
  const queues = new Map();
  const unauthorizedAt = new Map();

  const owner = (fromId, chatId) => {
    const from = String(fromId ?? '');
    const chat = String(chatId ?? '');
    return config.ownerIds.some((id) => id === from || id === chat);
  };

  const chatKey = (chatId) => String(chatId ?? 'unknown');

  const enqueue = (key, fn) => {
    const prev = queues.get(key) || Promise.resolve();
    const task = prev.catch(() => {}).then(fn);
    const guarded = task.catch((error) => reportFatal(key, error));
    const chained = guarded.finally(() => {
      if (queues.get(key) === chained) queues.delete(key);
    });
    queues.set(key, chained);
    return guarded;
  };

  const reportFatal = async (key, error) => {
    logger?.error('update handler failed', { chatId: maskId(key), error });
    try {
      await tg.send(key, '⚠️ <b>Internal error</b>\nDobara try karo. Agar repeat ho to server logs dekho.', {
        keyboard: [[{ text: '☰ Menu', callback_data: 'c:menu' }]],
      });
    } catch {
      /* never let error reporting loop */
    }
  };

  const sendUnauthorized = async (chatId) => {
    const key = chatKey(chatId);
    const now = clock();
    const last = unauthorizedAt.get(key);
    if (last && now - last < 10 * 60 * 1000) return;
    unauthorizedAt.set(key, now);
    logger?.warn('unauthorized message ignored', { chatId: maskId(key) });
    try {
      await tg.send(chatId, '⛔ <b>Private bot</b>\nYe bot owner-only hai.', { keyboard: null });
    } catch {
      /* best effort */
    }
  };

  const deliver = async (chatId, result, { editMessageId = null } = {}) => {
    const payload = normaliseResult(result);
    const options = {
      keyboard: payload.keyboard || null,
      plain: payload.plain === true,
      disablePreview: payload.disablePreview !== false,
    };
    if (editMessageId) {
      try {
        return await tg.edit(chatId, editMessageId, payload.text, options);
      } catch (error) {
        if (error?.unchanged) return null;
        if (!error?.notEditable) logger?.warn('edit failed - sending a new message', { code: error?.code || 0 });
      }
    }
    return tg.send(chatId, payload.text, options);
  };

  const placeholderFor = (name, args) => SLOW_LABEL[name] || (isSlowCommand(name, args) ? '⏳ Working…' : null);

  const presentConfirmation = async (ctx, result, targetMessageId) => {
    const action = result.pendingAction?.action;
    if (!action) return deliver(ctx.chatId, result, { editMessageId: targetMessageId });

    for (const key of pending.keys()) {
      if (key.startsWith(`${ctx.chatId}:`)) pending.delete(key);
    }
    const token = randomBytes(4).toString('hex');
    const key = `${ctx.chatId}:${token}`;
    const createdAt = clock();
    const keyboard = [[
      { text: action === 'live' ? '✅ CONFIRM LIVE' : '✅ Confirm', callback_data: `c:auto:confirm:${token}` },
      { text: '✖️ Cancel', callback_data: `c:auto:cancel:${token}` },
    ]];
    const delivered = await deliver(ctx.chatId, {
      text: result.text,
      keyboard,
    }, { editMessageId: targetMessageId });
    pending.set(key, {
      id: token,
      chatId: String(ctx.chatId),
      action,
      createdAt,
      messageId: delivered?.message_id ?? targetMessageId ?? null,
    });
    return delivered;
  };

  const runHandler = async ({
    name,
    args,
    message,
    chatId,
    callbackMessageId = null,
    refresh = false,
  }) => {
    const handler = handlers[name];
    if (!handler) {
      await deliver(chatId, {
        text: '❓ Unknown command. /help dekho.',
        keyboard: [[{ text: '☰ Menu', callback_data: 'c:menu' }]],
      }, { editMessageId: callbackMessageId });
      return;
    }

    const slow = isSlowCommand(name, args);
    let targetMessageId = callbackMessageId;
    if (slow) {
      const label = placeholderFor(name, args);
      if (callbackMessageId) {
        try {
          const edited = await tg.edit(chatId, callbackMessageId, label, {});
          targetMessageId = edited?.message_id ?? callbackMessageId;
        } catch {
          const sent = await tg.send(chatId, label).catch(() => null);
          targetMessageId = sent?.message_id ?? null;
        }
      } else {
        const sent = await tg.send(chatId, label).catch(() => null);
        targetMessageId = sent?.message_id ?? null;
      }
    }

    const ctx = {
      message,
      chatId,
      userId: message?.from?.id ?? null,
      chatType: message?.chat?.type || 'unknown',
      args,
      command: name,
      callbackMessageId,
      refresh,
    };
    Promise.resolve(tg.typing?.(chatId)).catch(() => {});
    let result;
    try {
      result = normaliseResult(await handler(ctx));
    } catch (error) {
      logger?.warn('command failed', { command: name, error });
      await deliver(chatId, errorResult(error), { editMessageId: targetMessageId }).catch(() => {});
      return;
    }
    if (result.pendingAction) {
      await presentConfirmation(ctx, result, targetMessageId);
    } else {
      await deliver(chatId, result, { editMessageId: targetMessageId });
    }
  };

  const cancelPending = (chatId) => {
    let removed = 0;
    const prefix = `${chatId}:`;
    for (const key of pending.keys()) {
      if (key.startsWith(prefix)) { pending.delete(key); removed += 1; }
    }
    return removed;
  };

  const executeAutoAction = async (action, chatId, messageId, callbackId) => {
    await tg.answerCallback(callbackId, action === 'off' ? 'Disarming…' : 'Confirmed');
    try {
      let next;
      if (action === 'on') next = await api.toggleAuto(true);
      else if (action === 'off') next = await api.toggleAuto(false);
      else if (action === 'live') {
        await api.setAutoConfig({ executionMode: 'live' });
        api.invalidateAuto?.();
        next = await api.mtfAutoStatus();
      } else if (action === 'paper') {
        await api.setAutoConfig({ executionMode: 'paper' });
        api.invalidateAuto?.();
        next = await api.mtfAutoStatus();
      } else {
        throw new Error('Unknown auto action');
      }
      const result = autoActionResult(action, next);
      await deliver(chatId, result, { editMessageId: messageId });
      logger?.info('auto action applied', { action });
    } catch (error) {
      logger?.warn('auto action failed', { action, error });
      await deliver(chatId, errorResult(error), { editMessageId: messageId }).catch(() => {});
    }
  };

  const handleAutoCallback = async (cb, parts) => {
    const chatId = cb.message?.chat?.id;
    const messageId = cb.message?.message_id;
    const sub = parts[2];
    if (sub === 'confirm' || sub === 'cancel') {
      const token = parts[3];
      const key = `${chatId}:${token}`;
      const entry = pending.get(key);
      if (!entry) {
        await tg.answerCallback(cb.id, 'Expired', { showAlert: true });
        await deliver(chatId, {
          text: '⌛ Ye confirmation expire ho gaya. /auto se dobara try karo.',
          keyboard: [[{ text: '☰ Menu', callback_data: 'c:menu' }]],
        }, { editMessageId: messageId }).catch(() => {});
        return;
      }
      if (clock() - entry.createdAt > config.confirmTtlMs) {
        pending.delete(key);
        await tg.answerCallback(cb.id, 'Expired', { showAlert: true });
        await deliver(chatId, {
          text: '⌛ Confirmation expire ho gaya. Kuch execute nahi hua.',
          keyboard: [[{ text: '☰ Menu', callback_data: 'c:menu' }]],
        }, { editMessageId: messageId }).catch(() => {});
        return;
      }
      pending.delete(key);
      if (sub === 'cancel') {
        await tg.answerCallback(cb.id, 'Cancelled');
        const status = await api.mtfAutoStatus().catch(() => null);
        await deliver(chatId, status
          ? { text: `✖️ Cancelled.\n\n${formatAutoStatus(status)}`, keyboard: autoKeyboard(status) }
          : { text: '✖️ Cancelled.', keyboard: [[{ text: '☰ Menu', callback_data: 'c:menu' }]] }, {
          editMessageId: messageId,
        }).catch(() => {});
        return;
      }
      await executeAutoAction(entry.action, chatId, messageId, cb.id);
      return;
    }

    if (sub === 'on') {
      await tg.answerCallback(cb.id, '');
      await runHandler({ name: 'auto', args: 'on', message: cb.message, chatId, callbackMessageId: messageId, refresh: true });
      return;
    }
    if (sub === 'off') {
      await executeAutoAction('off', chatId, messageId, cb.id);
      return;
    }
    if (sub === 'mode') {
      const mode = parts[3] === 'live' ? 'live' : 'paper';
      await tg.answerCallback(cb.id, mode === 'live' ? 'Live mode…' : 'Paper mode…');
      await runHandler({ name: 'auto', args: mode, message: cb.message, chatId, callbackMessageId: messageId, refresh: true });
      return;
    }
    await tg.answerCallback(cb.id, '');
    await runHandler({ name: 'auto', args: '', message: cb.message, chatId, callbackMessageId: messageId, refresh: true });
  };

  const handleCallback = async (cb) => {
    const chatId = cb.message?.chat?.id;
    if (!owner(cb.from?.id, chatId)) {
      await tg.answerCallback(cb.id, 'Not authorized', { showAlert: true });
      logger?.warn('unauthorized callback ignored', { chatId: maskId(chatId) });
      return;
    }
    const data = String(cb.data || '');
    const parts = data.split(':');
    if (parts[0] !== 'c' || !parts[1]) {
      await tg.answerCallback(cb.id, 'Expired');
      return;
    }

    if (parts[1] === 'auto') {
      await handleAutoCallback(cb, parts);
      return;
    }

    await tg.answerCallback(cb.id, '');
    const messageId = cb.message?.message_id;
    if (parts[1] === 'menu') {
      await deliver(chatId, menuResult(), { editMessageId: messageId });
      return;
    }

    const map = {
      status: ['status', ''],
      health: ['health', ''],
      positions: ['positions', ''],
      alerts: ['alerts', ''],
      weekly: ['weekly', ''],
      ping: ['ping', ''],
      version: ['version', ''],
      help: ['help', ''],
      signals: ['signals', ''],
      pnl: ['pnl', ''],
    };
    if (parts[1] === 'sig') {
      const market = String(parts[2] || 'crypto').toLowerCase();
      await runHandler({ name: 'signals', args: market, message: cb.message, chatId, callbackMessageId: messageId, refresh: true });
      return;
    }
    if (parts[1] === 'scan') {
      const market = String(parts[2] || 'crypto').toLowerCase();
      await runHandler({ name: 'scan', args: market, message: cb.message, chatId, callbackMessageId: messageId, refresh: true });
      return;
    }
    if (parts[1] === 'pnl' && parts[2]) {
      await runHandler({ name: 'pnl', args: parts[2], message: cb.message, chatId, callbackMessageId: messageId, refresh: true });
      return;
    }
    const target = map[parts[1]];
    if (!target) {
      await deliver(chatId, menuResult(), { editMessageId: messageId });
      return;
    }
    await runHandler({
      name: target[0],
      args: target[1],
      message: cb.message,
      chatId,
      callbackMessageId: messageId,
      refresh: true,
    });
  };

  const handleMessage = async (msg) => {
    const text = String(msg?.text || '').trim();
    if (!text) return;
    if (msg.from?.is_bot) return;
    const chatId = msg.chat?.id;
    if (!owner(msg.from?.id, chatId)) {
      await sendUnauthorized(chatId);
      return;
    }

    if (!text.startsWith('/')) {
      const privateChat = msg.chat?.type === 'private';
      const mention = botUsername ? `@${String(botUsername).toLowerCase()}` : null;
      if (!privateChat && !(mention && text.toLowerCase().includes(mention))) return;
      const question = mention
        ? text.replace(new RegExp(mention.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'ig'), '').trim()
        : text;
      if (!question) return;
      await runHandler({ name: 'agent', args: question, message: msg, chatId });
      return;
    }

    const parsed = parseCommand(text, botUsername);
    if (!parsed) return;
    const resolved = resolveCommand(parsed.name, parsed.args);

    if (resolved.name === 'cancel') {
      const removed = cancelPending(chatId);
      await tg.send(chatId, removed
        ? `✖️ ${removed} pending confirmation cancel ho gayi.`
        : 'Koi pending confirmation nahi hai.', { keyboard: null }).catch(() => {});
      return;
    }

    await runHandler({ name: resolved.name, args: resolved.args, message: msg, chatId });
  };

  const dispatchUpdate = (update) => {
    if (update?.message) {
      return enqueue(String(update.message.chat?.id ?? 'unknown'), () => handleMessage(update.message));
    }
    if (update?.callback_query) {
      return enqueue(String(update.callback_query.message?.chat?.id ?? 'unknown'), () => handleCallback(update.callback_query));
    }
    return Promise.resolve();
  };

  const drain = () => Promise.allSettled([...queues.values()]);

  return {
    handleMessage,
    handleCallback,
    dispatchUpdate,
    drain,
    cancelPending,
    pendingCount: () => pending.size,
    clearHistory,
    // test hooks
    _pending: pending,
    _owner: owner,
    _isSlow: isSlowCommand,
  };
}
