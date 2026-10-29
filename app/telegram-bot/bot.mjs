// SmartAI Pro Telegram bot - entry point.
// Zero dependencies: Node built-ins + Telegram Bot API long polling.
// The site API is the only source of truth for market/portfolio state.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SiteApi } from './lib/api.mjs';
import { COMMANDS } from './lib/commands.mjs';
import { describeConfig, loadConfig, loadDotenv } from './lib/config.mjs';
import { acquireLock } from './lib/lock.mjs';
import { createLogger } from './lib/logger.mjs';
import { createRouter } from './lib/router.mjs';
import { JsonState } from './lib/state.mjs';
import { TelegramClient } from './lib/telegram.mjs';
import { maskId, sleep } from './lib/util.mjs';

const DROP_PENDING_AFTER_MS = 5 * 60 * 1000;

async function getMeWithRetry(tg, logger, attempts = 5) {
  let lastError = null;
  for (let i = 0; i < attempts; i += 1) {
    try {
      return await tg.getMe();
    } catch (error) {
      lastError = error;
      if (error?.code === 401) throw error;
      logger.warn('getMe failed - retrying', { attempt: i + 1, code: error?.code || 0 });
      await sleep(2000);
    }
  }
  throw lastError;
}

async function main() {
  loadDotenv();
  const config = loadConfig(process.env);
  const logger = createLogger(config.logLevel);

  logger.info('starting', describeConfig(config));
  if (config.fatal) {
    for (const problem of config.problems) logger.error(problem);
    process.exitCode = 1;
    return;
  }
  for (const problem of config.problems) logger.warn(problem);

  let lock = null;
  let state = null;
  let shuttingDown = false;

  const shutdown = async (reason, code = 0) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info('shutting down', { reason, code });
    try {
      state?.set('stoppedAt', Date.now());
      state?.flush();
    } catch { /* best effort */ }
    try { lock?.release(); } catch { /* best effort */ }
    process.exit(code);
  };

  process.on('SIGTERM', () => { shutdown('sigterm', 0).catch(() => process.exit(0)); });
  process.on('SIGINT', () => { shutdown('sigint', 0).catch(() => process.exit(0)); });
  process.on('disconnect', () => { shutdown('parent-disconnect', 0).catch(() => process.exit(0)); });
  process.on('uncaughtException', (error) => {
    logger.error('uncaughtException', { error });
  });
  process.on('unhandledRejection', (error) => {
    logger.error('unhandledRejection', { error });
  });

  try {
    lock = acquireLock(config.lockFile, logger);
  } catch (error) {
    logger.error(String(error?.message || error));
    process.exitCode = 1;
    return;
  }

  state = new JsonState(config.stateFile, {
    offset: 0,
    lastUpdateAt: 0,
    startedAt: 0,
    stoppedAt: 0,
    pid: 0,
  }, logger);

  const tg = new TelegramClient({
    token: config.token,
    logger,
  });

  let me;
  try {
    me = await getMeWithRetry(tg, logger);
  } catch (error) {
    logger.error('Telegram authentication failed - check TG_TOKEN', { code: error?.code || 0 });
    lock.release();
    process.exitCode = 1;
    return;
  }

  const botUsername = me?.username || null;
  const lastUpdateAt = Number(state.get('lastUpdateAt', 0)) || 0;
  const dropPending = !lastUpdateAt || (Date.now() - lastUpdateAt > DROP_PENDING_AFTER_MS);

  try {
    await tg.deleteWebhook(dropPending);
    logger.info('webhook cleared', { dropPending });
  } catch (error) {
    logger.warn('deleteWebhook failed (polling will retry on conflict)', { code: error?.code || 0 });
  }

  // Even if deleteWebhook failed, never execute a stale command backlog on a
  // fresh boot. Fetching the newest update with offset -1 advances our saved
  // offset past everything that was already queued.
  if (dropPending) {
    try {
      const last = await tg.getUpdates({ offset: -1, timeout: 0 });
      const lastId = Number(last?.[0]?.update_id);
      if (Number.isFinite(lastId)) {
        state.set('offset', lastId + 1);
        state.flush();
        logger.info('stale update backlog skipped', { offset: lastId + 1 });
      }
    } catch (error) {
      logger.warn('could not inspect stale backlog', { code: error?.code || 0 });
    }
  }

  try {
    await tg.setMyCommands(COMMANDS);
  } catch (error) {
    logger.warn('setMyCommands failed', { code: error?.code || 0 });
  }

  const api = new SiteApi({
    baseUrl: config.apiBaseUrl,
    token: config.apiToken,
    logger,
    defaultTimeoutMs: config.requestTimeoutMs,
  });

  const router = createRouter({
    api,
    tg,
    config,
    logger,
    botUsername,
  });

  state.set('startedAt', Date.now());
  state.set('pid', process.pid);
  state.flush();

  logger.info('ready', {
    bot: botUsername ? `@${botUsername}` : maskId(me?.id),
    owners: config.ownerIds.length,
    api: config.apiBaseUrl,
    offset: Number(state.get('offset', 0)) || 0,
    pid: process.pid,
  });

  let backoff = 1000;
  let webhookRetry = false;

  while (!shuttingDown) {
    try {
      const offset = Number(state.get('offset', 0)) || 0;
      const updates = await tg.getUpdates({
        offset,
        timeout: config.pollTimeoutSec,
      });
      backoff = 1000;
      webhookRetry = false;
      if (!Array.isArray(updates) || updates.length === 0) continue;

      for (const update of updates) {
        const id = Number(update?.update_id);
        if (Number.isFinite(id)) state.set('offset', id + 1);
        state.set('lastUpdateAt', Date.now());
        router.dispatchUpdate(update).catch((error) => {
          logger.warn('update dispatch failed', { error });
        });
      }
      state.flush();
    } catch (error) {
      if (shuttingDown) break;
      const code = Number(error?.code || 0);
      if (code === 401) {
        logger.error('Telegram token rejected (401) - fix TG_TOKEN and restart');
        await shutdown('telegram-401', 1);
        return;
      }
      if (code === 409) {
        if (!webhookRetry) {
          webhookRetry = true;
          logger.warn('Telegram 409 conflict - clearing webhook and retrying in 5s');
          await tg.deleteWebhook(false).catch(() => {});
          await sleep(5000);
          continue;
        }
        logger.warn('Telegram 409 conflict persists - another poller is using this token');
        await sleep(10000);
        continue;
      }
      if (code === 429) {
        const waitMs = Math.min(30000, Math.max(1000, Number(error?.retryAfter || 5) * 1000));
        logger.warn('Telegram rate limit - waiting', { waitMs });
        await sleep(waitMs);
        continue;
      }
      logger.warn('poll failed - retrying', { code, error: error?.message || String(error), backoff });
      await sleep(backoff);
      backoff = Math.min(backoff * 2, 30000);
    }
  }
}

const isMain = process.argv[1]
  && path.resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase();

if (isMain) {
  main().catch((error) => {
    console.error('[bot] fatal startup error:', error?.message || error);
    process.exitCode = 1;
  });
}

export { main };
