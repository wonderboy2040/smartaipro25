// SmartAI Pro Telegram bot - configuration.
// The bot never owns market/portfolio state: every number comes from the
// server API. This file only resolves env + safe runtime defaults.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const BOT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const APP_ROOT = path.resolve(BOT_ROOT, '..');
export const BOT_NAME = 'SmartAI Pro Bot';
export const BOT_VERSION = '21.25.3';

/** Parse a dotenv file without the `dotenv` dependency. */
export function parseDotenv(text) {
  const out = {};
  for (const rawLine of String(text ?? '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const m = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    let value = m[2].trim();
    const quoted = (value.startsWith('"') && value.endsWith('"'))
      || (value.startsWith("'") && value.endsWith("'"));
    if (quoted) {
      const doubleQuoted = value.startsWith('"');
      value = value.slice(1, -1);
      if (doubleQuoted) {
        value = value
          .replace(/\\n/g, '\n')
          .replace(/\\r/g, '\r')
          .replace(/\\t/g, '\t')
          .replace(/\\"/g, '"');
      }
    } else {
      const hash = value.search(/\s#/);
      if (hash >= 0) value = value.slice(0, hash).trim();
    }
    out[m[1]] = value;
  }
  return out;
}

/** Load bot/.env then app/.env without overriding real environment values. */
export function loadDotenv({ env = process.env, files } = {}) {
  const candidates = files ?? [
    path.join(BOT_ROOT, '.env'),
    path.join(APP_ROOT, '.env'),
  ];
  const loaded = [];
  for (const file of candidates) {
    let parsed;
    try {
      parsed = parseDotenv(fs.readFileSync(file, 'utf8'));
    } catch {
      continue;
    }
    for (const [key, value] of Object.entries(parsed)) {
      if (env[key] === undefined) env[key] = value;
    }
    loaded.push(file);
  }
  return loaded;
}

const clampInt = (value, min, max, fallback) => {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
};

const normalizeBaseUrl = (value, port) => {
  const raw = String(value || '').trim();
  if (raw) return raw.replace(/\/+$/, '');
  return `http://127.0.0.1:${port}`;
};

export function loadConfig(env = process.env) {
  const token = String(env.TG_TOKEN || '').trim();
  const ownerIds = String(env.TG_CHAT_ID || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const apiToken = String(env.API_TOKEN || '').trim();
  const port = clampInt(env.PORT, 1, 65535, 8080);
  const apiBaseUrl = normalizeBaseUrl(env.BOT_API_BASE_URL || env.API_BASE_URL, port);

  const problems = [];
  if (!token) problems.push('TG_TOKEN missing');
  if (ownerIds.length === 0) problems.push('TG_CHAT_ID missing (owner chat id)');
  if (!apiToken) problems.push('API_TOKEN missing - site API calls will be unauthorized');
  else if (apiToken.length < 12) problems.push('API_TOKEN too short - server service auth requires at least 12 characters');

  return Object.freeze({
    botName: BOT_NAME,
    version: BOT_VERSION,
    token,
    ownerIds,
    apiToken,
    port,
    apiBaseUrl,
    pollTimeoutSec: clampInt(env.BOT_POLL_TIMEOUT_SEC, 5, 50, 10),
    requestTimeoutMs: clampInt(env.BOT_REQUEST_TIMEOUT_MS, 3000, 180000, 40000),
    boardTimeoutMs: clampInt(env.BOT_BOARD_TIMEOUT_MS, 10000, 180000, 90000),
    agentTimeoutMs: clampInt(env.BOT_AGENT_TIMEOUT_MS, 10000, 180000, 120000),
    weeklyTimeoutMs: clampInt(env.BOT_WEEKLY_TIMEOUT_MS, 10000, 180000, 120000),
    sendTimeoutMs: 15000,
    confirmTtlMs: clampInt(env.BOT_CONFIRM_TTL_MS, 15000, 300000, 90000),
    stateFile: path.resolve(BOT_ROOT, env.BOT_STATE_FILE || '.state.json'),
    lockFile: path.resolve(BOT_ROOT, env.BOT_LOCK_FILE || '.bot.lock'),
    logLevel: String(env.BOT_LOG_LEVEL || 'info').toLowerCase(),
    maxAgentChars: 2000,
    problems,
    fatal: problems.some((p) => p.startsWith('TG_TOKEN') || p.startsWith('TG_CHAT_ID') || p.startsWith('API_TOKEN')),
  });
}

export function describeConfig(config) {
  return {
    version: config.version,
    apiBaseUrl: config.apiBaseUrl,
    owners: config.ownerIds.length,
    apiToken: Boolean(config.apiToken),
    pollTimeoutSec: config.pollTimeoutSec,
    stateFile: config.stateFile,
  };
}
