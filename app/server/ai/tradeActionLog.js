// ============================================================
// server/ai/tradeActionLog.js — v21.29.0 (R1 ORDER IDEMPOTENCY)
// ------------------------------------------------------------
// Small, durable idempotency-key registry for money-moving actions
// (live entry, close, cancel). Goals:
//   • one logical action → at most ONE exchange mutation, even across
//     double-clicks, overlapping 3s/15s loops, or a process restart
//   • an AMBIGUOUS outcome (timeout on submit) keeps the key held — the
//     caller must reconcile, never blind-retry
//   • a deterministic rejection releases the key so the user can retry
//   • TTL (default 10 min) keeps the file bounded
//
// API:
//   actionKey(parts)                     stable short hash
//   claimAction(key, {ttlMs, meta})      → {ok:true} | {ok:false,duplicate}
//   finishAction(key, {status,result})   → hold until TTL
//   releaseAction(key, {reason})         → retry allowed immediately
//   withActionLock(key, fn, opts)        → async convenience wrapper
//   getAction(key)                       → status snapshot
//   __resetTradeActionLogForTests()
// ============================================================
import crypto from 'node:crypto';
import { loadJSON, saveJSON } from '../lib/store.js';

const FILE = 'trade-action-log.json';
const DEFAULT_TTL_MS = 10 * 60_000;
const MAX_ACTIONS = 400;

let _log = null; // { actions: { [key]: { status, at, until, meta, result, reason } } }

function _now() { return Date.now(); }

function _prune(log, now = _now()) {
  const actions = log.actions && typeof log.actions === 'object' ? log.actions : {};
  for (const [k, v] of Object.entries(actions)) {
    if (!v || Number(v.until) <= now) delete actions[k];
  }
  const keys = Object.keys(actions);
  if (keys.length > MAX_ACTIONS) {
    keys
      .sort((a, b) => Number(actions[a].at || 0) - Number(actions[b].at || 0))
      .slice(0, keys.length - MAX_ACTIONS)
      .forEach(k => delete actions[k]);
  }
  return actions;
}

function _load() {
  if (_log) return _log;
  const raw = loadJSON(FILE, { actions: {} });
  _log = { actions: _prune(raw && typeof raw === 'object' ? { actions: raw.actions || {} } : { actions: {} }) };
  return _log;
}

function _persist() {
  // Tests stay hermetic: no writes unless explicitly opted in.
  if (process.env.NODE_ENV === 'test' && process.env.TRADE_ACTION_LOG_PERSIST !== '1') return;
  try { saveJSON(FILE, _log); } catch { /* best-effort — memory still holds */ }
}

/** Stable short key from any JSON-able parts. */
export function actionKey(parts) {
  const body = typeof parts === 'string' ? parts : JSON.stringify(parts ?? null);
  return crypto.createHash('sha256').update(body).digest('hex').slice(0, 24);
}

/**
 * Atomically claim an action key. Synchronous by design (Node's event loop
 * makes this the atomic compare-and-set for the whole process).
 * Returns `{ok:true}` or `{ok:false, duplicate:true, status, until, result}`.
 */
export function claimAction(key, { ttlMs = DEFAULT_TTL_MS, meta = null, now = _now() } = {}) {
  const k = String(key || '').trim();
  if (!k) return { ok: false, duplicate: false, error: 'action key required' };
  const log = _load();
  _prune(log, now);
  const existing = log.actions[k];
  if (existing && Number(existing.until) > now) {
    return {
      ok: false, duplicate: true, key: k, status: existing.status || 'held',
      until: Number(existing.until), result: existing.result ?? null,
      meta: existing.meta ?? null,
    };
  }
  const ttl = Math.max(1_000, Number(ttlMs) || DEFAULT_TTL_MS);
  log.actions[k] = {
    status: 'in_progress', at: now, until: now + ttl, meta: meta || null,
  };
  _prune(log, now);
  _persist();
  return { ok: true, key: k, until: now + ttl };
}

/** Mark an action finished (accepted or ambiguous) — key stays held to TTL. */
export function finishAction(key, { status = 'done', result = null, ttlMs = null, now = _now() } = {}) {
  const k = String(key || '').trim();
  if (!k) return { ok: false, error: 'action key required' };
  const log = _load();
  const existing = log.actions[k];
  if (!existing) return { ok: false, error: 'action not claimed', key: k };
  existing.status = String(status || 'done');
  existing.result = result ?? null;
  if (Number(ttlMs) > 0) existing.until = now + Math.max(1_000, Number(ttlMs));
  log.actions[k] = existing;
  _persist();
  return { ok: true, key: k, until: Number(existing.until), status: existing.status };
}

/** Release a key after a deterministic (non-ambiguous) failure. */
export function releaseAction(key, { reason = null } = {}) {
  const k = String(key || '').trim();
  if (!k) return { ok: false, error: 'action key required' };
  const log = _load();
  if (!log.actions[k]) return { ok: false, error: 'action not claimed', key: k };
  delete log.actions[k];
  _persist();
  return { ok: true, key: k, released: true, reason };
}

export function getAction(key, { now = _now() } = {}) {
  const k = String(key || '').trim();
  if (!k) return null;
  const log = _load();
  _prune(log, now);
  const a = log.actions[k];
  if (!a) return null;
  return { key: k, status: a.status, at: a.at, until: a.until, meta: a.meta ?? null, result: a.result ?? null };
}

/**
 * Run `fn` at most once per key. On success the key is held (done); on a
 * thrown error it is released so a retry is possible. The return shape:
 *   { ok:true, key, value } | { ok:false, duplicate:true, key, until }
 */
export async function withActionLock(key, fn, { ttlMs = DEFAULT_TTL_MS, meta = null, now = _now() } = {}) {
  const claim = claimAction(key, { ttlMs, meta, now });
  if (!claim.ok) return claim;
  try {
    const value = await fn();
    finishAction(key, { status: 'done', result: null });
    return { ok: true, key, value };
  } catch (e) {
    releaseAction(key, { reason: String(e?.message || e) });
    throw e;
  }
}

export function __resetTradeActionLogForTests() {
  _log = { actions: {} };
}
