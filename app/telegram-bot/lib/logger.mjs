// Tiny levelled logger. Never prints tokens, API secrets, PINs or raw chat ids.

import { maskId } from './util.mjs';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const SECRET_KEY = /token|secret|api.?key|authorization|password|pin/i;
const CHAT_KEY = /chat|owner|user.?id/i;

function cleanMeta(meta) {
  if (!meta || typeof meta !== 'object') return meta;
  const out = {};
  for (const [key, value] of Object.entries(meta)) {
    if (value === undefined) continue;
    if (SECRET_KEY.test(key)) { out[key] = '[redacted]'; continue; }
    if (CHAT_KEY.test(key) && (typeof value === 'string' || typeof value === 'number')) {
      out[key] = maskId(value);
      continue;
    }
    if (value instanceof Error) {
      out[key] = { name: value.name, message: value.message };
      continue;
    }
    out[key] = value;
  }
  return out;
}

export function createLogger(level = 'info') {
  const threshold = LEVELS[String(level).toLowerCase()] ?? LEVELS.info;
  const write = (lvl, message, meta) => {
    if (LEVELS[lvl] < threshold) return;
    const suffix = meta && Object.keys(meta).length ? ` ${JSON.stringify(cleanMeta(meta))}` : '';
    const line = `[bot] ${new Date().toISOString()} ${lvl.toUpperCase()} ${message}${suffix}`;
    if (lvl === 'error') console.error(line);
    else if (lvl === 'warn') console.warn(line);
    else console.log(line);
  };
  return {
    debug: (m, meta) => write('debug', m, meta),
    info: (m, meta) => write('info', m, meta),
    warn: (m, meta) => write('warn', m, meta),
    error: (m, meta) => write('error', m, meta),
  };
}
