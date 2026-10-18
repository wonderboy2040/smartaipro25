// ============================================================
// server/ai/tradeApproval.js — v10.9 #4 CONTROLLED TELEGRAM ORDER
// APPROVAL
// ------------------------------------------------------------
// SECURITY CONTRACT (non-negotiable — every rule is test-locked):
//
//   1. OPT-IN: AI_TELEGRAM_APPROVALS=on arms the flow. Default OFF —
//      /trade answers "disabled" and nothing else happens.
//   2. The chat-id allowlist is NOT enough: the Approve tap demands
//      a PIN second factor (AI_APPROVAL_PIN, 4-12 digits, in env).
//      3 wrong tries → the request is dead (re-create if genuine).
//   3. Hard daily cap: AI_APPROVAL_MAX_PER_DAY EXECUTED approvals per
//      IST day (default 3). Refused/failed executions don't count —
//      only real orders move the counter.
//   4. TTL: every request lives AI_APPROVAL_TTL_MS (default 5 min).
//      The PIN phase gets the shorter of that and 3 minutes.
//   5. ONE pending request at a time — no parallel approvals.
//   6. The Approve button ONLY triggers the site's EXISTING
//      executeSignal gauntlet (via routes.js runApprovedExecution,
//      source 'telegram-approval'): fresh-signal re-verification,
//      kill switch, risk caps, mandate freeze, one-per-pair. It adds
//      a manual trigger — it BYPASSES NOTHING.
//   7. No chat text ever becomes an order on its own: /trade parses a
//      strict grammar and creates a REQUEST, never an execution.
// ============================================================
import crypto from 'node:crypto';

// ---------------- env knobs ----------------
export function approvalEnabled() {
  return String(process.env.AI_TELEGRAM_APPROVALS || '').toLowerCase() === 'on';
}
export function approvalPin() {
  const p = String(process.env.AI_APPROVAL_PIN || '').trim();
  return /^\d{4,12}$/.test(p) ? p : ''; // malformed PIN = no approvals, ever
}
export function approvalDailyCap() {
  const n = Number(process.env.AI_APPROVAL_MAX_PER_DAY);
  return Number.isFinite(n) && n >= 1 && n <= 20 ? Math.floor(n) : 3;
}
export function approvalTtlMs() {
  const n = Number(process.env.AI_APPROVAL_TTL_MS);
  return Number.isFinite(n) && n >= 30_000 && n <= 30 * 60_000 ? n : 5 * 60_000;
}
/** v18.1 FIX: hard wall on the EXECUTING phase. A hung executeSignal
 * gauntlet (dead socket, stuck WS, never-settling promise) previously left
 * the request EXECUTING forever — and because EXECUTING counts toward the
 * one-at-a-time invariant, ONE hung execution wedged ALL future approvals.
 * The in-flight submitPin races this deadline; the sweep below is the
 * belt-and-braces backstop for anything that slips past it. */
export function execDeadlineMs() {
  const n = Number(process.env.AI_APPROVAL_EXEC_DEADLINE_MS);
  return Number.isFinite(n) && n >= 10_000 && n <= 15 * 60_000 ? n : 120_000;
}
const EXEC_SWEEP_GRACE_MS = 15_000; // grace beyond the in-flight race
/** IST day key — approvals reset at midnight IST like the agent's day. */
export function approvalDayKey(now = Date.now()) {
  return new Date(now).toLocaleDateString('sv-SE', { timeZone: 'Asia/Kolkata' });
}

// ---------------- state ----------------
const _requests = new Map(); // id → request (mutable state machine)
const _execDays = new Map(); // IST-day-key → executed count

function _publicView(r) {
  return {
    id: r.id, symbol: r.symbol, side: r.side, mode: r.mode,
    qtyINR: r.qtyINR ?? null, leverage: r.leverage ?? null,
    state: r.state, createdAt: r.createdAt, expiresAt: r.expiresAt,
    pinTries: r.pinTries, maxPinTries: r.maxPinTries,
    reason: r.reason ?? null, executedResult: r.executedResult ?? null,
  };
}
function _expired(r, now) { return now >= r.expiresAt; }
function _pinWindowExpired(r, now) { return r.pinExpiresAt != null && now >= r.pinExpiresAt; }
function _expireIfDue(r, now = Date.now()) {
  if (r.state === 'PENDING' || r.state === 'APPROVING') {
    if (_expired(r, now)) { r.state = 'EXPIRED'; r.reason = 'ttl'; return true; }
    if (r.state === 'APPROVING' && _pinWindowExpired(r, now)) { r.state = 'EXPIRED'; r.reason = 'pin-window'; return true; }
  }
  // v18.1 zombie sweep: EXECUTING that never settled past the deadline is
  // swept to FAILED so status views and the one-at-a-time gate can never
  // wedge forever on a dead execution.
  if (r.state === 'EXECUTING') {
    const startedAt = r.execStartedAt || r.createdAt;
    if (now - startedAt > execDeadlineMs() + EXEC_SWEEP_GRACE_MS) {
      r.state = 'FAILED';
      r.reason = 'exec-zombie-swept';
      r.executedResult = { ok: false, error: 'exec-zombie-swept', note: 'execution never settled within the deadline — one-at-a-time gate freed' };
      return true;
    }
  }
  return false;
}

// ---------------- parsing (pure) ----------------
/**
 * /trade <SYMBOL> <LONG|SHORT|BUY|SELL> [qtyINR] [xLEVERAGE] [live|paper|notify]
 * Strict grammar — anything else is a usage error, never a guess.
 */
export function parseTradeCommand(text) {
  const raw = String(text || '').trim();
  // DEFENSE IN DEPTH: only a message that STARTS with /trade can ever be
  // parsed as one — bare chat text must never become an order request.
  if (!/^\/trade(@\w+)?(\s|$)/i.test(raw)) {
    return { ok: false, error: 'usage: /trade <SYMBOL> <LONG|SHORT> [qtyINR] [xLEVERAGE] [live|paper|notify] — e.g. /trade BTC LONG 5000 x3 paper' };
  }
  const t = raw.replace(/^\/trade(@\w+)?\s*/i, '').replace(/\s+/g, ' ');
  if (!t) {
    return { ok: false, error: 'usage: /trade <SYMBOL> <LONG|SHORT> [qtyINR] [xLEVERAGE] [live|paper|notify] — e.g. /trade BTC LONG 5000 x3 paper' };
  }
  const m = t.match(/^([A-Za-z0-9_.:-]{1,20})\s+(long|short|buy|sell)\b\s*(?:(\d{1,9}(?:\.\d{1,2})?)\s*)?(?:x(\d{1,2})\s*)?(live|paper|notify)?\s*$/i);
  if (!m) {
    return { ok: false, error: 'usage: /trade <SYMBOL> <LONG|SHORT> [qtyINR] [xLEVERAGE] [live|paper|notify] — e.g. /trade BTC LONG 5000 x3 paper' };
  }
  const side = /^(long|buy)$/i.test(m[2]) ? 'LONG' : 'SHORT';
  const symbol = m[1].toUpperCase();
  const qtyINR = m[3] != null ? Number(m[3]) : undefined;
  const leverage = m[4] != null ? Number(m[4]) : undefined;
  const mode = String(m[5] || 'paper').toLowerCase();
  return { ok: true, symbol, side, qtyINR, leverage, mode };
}

/** Telegram callback_data parser: 'ta:app:<id>' | 'ta:rej:<id>'. */
export function parseApprovalCallback(data) {
  const m = String(data || '').match(/^ta:(app|rej):([a-z0-9]{6,40})$/i);
  if (!m) return null;
  return { action: m[1].toLowerCase() === 'app' ? 'approve' : 'reject', id: m[2].toLowerCase() };
}

/** Constant-time-ish PIN compare — no early-exit length leak beyond
 *  the same check every call gets. */
export function pinMatches(expected, given) {
  const a = String(expected || '');
  const b = String(given ?? '').trim();
  if (!a || !b) return false;
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// ---------------- lifecycle ----------------
export function dailyCapUsed(now = Date.now()) {
  return _execDays.get(approvalDayKey(now)) || 0;
}

export function pendingRequest(now = Date.now()) {
  for (const r of _requests.values()) {
    _expireIfDue(r, now);
    // v18.1: EXECUTING counts as "pending" for the one-at-a-time gate — no
    // parallel approvals while an order is in flight (contract #5). The
    // exec deadline + zombie sweep above guarantee this can't wedge forever.
    if (r.state === 'PENDING' || r.state === 'APPROVING' || r.state === 'EXECUTING') return _publicView(r);
  }
  return null;
}

export function requestById(id, now = Date.now()) {
  const r = _requests.get(String(id || '').toLowerCase());
  if (!r) return null;
  _expireIfDue(r, now);
  return _publicView(r);
}

/** Defense in depth: only the chat that CREATED a request may submit
 *  its PIN (or tap its buttons) — a viewer chat can never move an
 *  admin's approval forward even if it somehow learned the id. */
export function ownsRequest(id, chatId) {
  const r = _requests.get(String(id || '').toLowerCase());
  return !!r && r.chatId === String(chatId ?? '');
}

/** Create a pending approval request (admin-only caller checks roles). */
export function createTradeApproval({ symbol, side, mode, qtyINR, leverage, chatId } = {}, { now = Date.now() } = {}) {
  if (!approvalEnabled()) return { ok: false, error: 'disabled' };
  if (!approvalPin()) return { ok: false, error: 'no-pin', hint: 'AI_APPROVAL_PIN (4-12 digits) env me set karo pehle' };
  if (!symbol || !/^[A-Z0-9_.:-]{1,20}$/.test(symbol)) return { ok: false, error: 'bad-symbol' };
  if (side !== 'LONG' && side !== 'SHORT') return { ok: false, error: 'bad-side' };
  if (mode !== 'live' && mode !== 'paper' && mode !== 'notify') return { ok: false, error: 'bad-mode' };
  if (qtyINR != null && (!Number.isFinite(qtyINR) || qtyINR <= 0 || qtyINR > 10_000_000)) return { ok: false, error: 'bad-qty' };
  if (leverage != null && (!Number.isFinite(leverage) || leverage < 1 || leverage > 25)) return { ok: false, error: 'bad-leverage' };
  if (dailyCapUsed(now) >= approvalDailyCap()) {
    return { ok: false, error: 'daily-cap', used: dailyCapUsed(now), cap: approvalDailyCap(), resetsAt: 'next IST midnight' };
  }
  const existing = pendingRequest(now);
  if (existing) return { ok: false, error: 'one-at-a-time', existing };

  const id = (crypto.randomUUID?.() || `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`).replace(/-/g, '').slice(0, 24).toLowerCase();
  const req = {
    id, symbol, side, mode,
    qtyINR: qtyINR ?? null, leverage: leverage ?? null,
    chatId: String(chatId ?? ''),
    createdAt: now, expiresAt: now + approvalTtlMs(),
    state: 'PENDING', pinTries: 0, maxPinTries: 3, pinExpiresAt: null,
    reason: null, executedResult: null,
  };
  _requests.set(id, req);
  // hygiene: drop >24h-old entries so the map can't grow unbounded
  if (_requests.size > 60) {
    for (const [k, r] of _requests) if (Date.now() - r.createdAt > 24 * 3600_000) _requests.delete(k);
  }
  return { ok: true, id, request: _publicView(req), ttlMs: approvalTtlMs() };
}

/** Approve tap → the request moves to PIN-awaiting. */
export function beginPinPhase(id, { now = Date.now() } = {}) {
  const r = _requests.get(String(id || '').toLowerCase());
  if (!r) return { ok: false, error: 'unknown-id' };
  if (_expireIfDue(r, now)) return { ok: false, error: 'expired' };
  if (r.state !== 'PENDING') return { ok: false, error: `already-${r.state.toLowerCase()}` };
  r.state = 'APPROVING';
  r.pinExpiresAt = now + Math.min(approvalTtlMs(), 3 * 60_000);
  return { ok: true, request: _publicView(r), pinWindowMs: Math.min(approvalTtlMs(), 3 * 60_000) };
}

/** Reject tap. */
export function rejectTradeApproval(id, { now = Date.now() } = {}) {
  const r = _requests.get(String(id || '').toLowerCase());
  if (!r) return { ok: false, error: 'unknown-id' };
  _expireIfDue(r, now);
  if (r.state !== 'PENDING' && r.state !== 'APPROVING') return { ok: false, error: `already-${r.state.toLowerCase()}` };
  r.state = 'REJECTED';
  return { ok: true };
}

/**
 * Submit the PIN for an APPROVING request. On the correct PIN the
 * injected `execute` (the site's ONLY order path) runs — the result
 * (ok or refused-by-gauntlet) is reported honestly.
 *
 * @param {(req) => Promise<{ok:boolean,...}>} execute runApprovedExecution
 */
export async function submitPin(id, pin, { now = Date.now(), execute } = {}) {
  const r = _requests.get(String(id || '').toLowerCase());
  if (!r) return { ok: false, error: 'unknown-id' };
  if (_expireIfDue(r, now)) return { ok: false, error: 'expired' };
  if (r.state !== 'APPROVING') return { ok: false, error: `not-awaiting-pin (state: ${r.state.toLowerCase()})` };

  if (!pinMatches(approvalPin(), pin)) {
    r.pinTries++;
    if (r.pinTries >= r.maxPinTries) {
      r.state = 'REJECTED';
      r.reason = 'pin-tries-exhausted';
      return { ok: false, error: 'pin-dead', request: _publicView(r) };
    }
    return { ok: false, error: 'wrong-pin', triesLeft: r.maxPinTries - r.pinTries, request: _publicView(r) };
  }

  r.state = 'EXECUTING';
  r.execStartedAt = Date.now(); // v18.1: zombie-sweep anchor
  try {
    // v18.1 FIX: race the gauntlet against execDeadlineMs(). A hung execute
    // (never-settling promise) now resolves to FAILED 'exec-timeout' instead
    // of wedging EXECUTING forever. The late-settling original promise gets a
    // no-op catch so it can never surface as an unhandledRejection (which,
    // post-v18.1, would take the process down).
    const execPromise = execute(_publicView(r));
    if (execPromise && typeof execPromise.catch === 'function') execPromise.catch(() => {});
    let out;
    try {
      out = await Promise.race([
        execPromise,
        new Promise((_resolve, reject) => {
          const t = setTimeout(() => reject(new Error('exec-timeout')), execDeadlineMs());
          if (typeof t.unref === 'function') t.unref();
        }),
      ]);
    } catch (e) {
      if (String(e?.message || '') === 'exec-timeout') {
        r.state = 'FAILED';
        r.reason = 'exec-timeout (gauntlet did not settle within AI_APPROVAL_EXEC_DEADLINE_MS — verify positions/journal; the order MAY have landed late)';
        r.executedResult = { ok: false, error: 'exec-timeout' };
        return { ok: true, executed: false, error: 'exec-timeout', request: _publicView(r) };
      }
      throw e;
    }
    if (out?.ok) {
      r.state = 'EXECUTED';
      r.executedResult = { ok: true, orderRef: out.orderRef ?? out.id ?? null, note: out.note ?? null };
      const dk = approvalDayKey(now);
      _execDays.set(dk, (_execDays.get(dk) || 0) + 1);
      // prune day counters (keep yesterday + today)
      if (_execDays.size > 2) {
        const keys = [..._execDays.keys()].sort();
        for (const k of keys.slice(0, _execDays.size - 2)) _execDays.delete(k);
      }
      return { ok: true, executed: true, result: out, request: _publicView(r) };
    }
    r.state = 'FAILED';
    r.reason = String(out?.error || 'execution refused').slice(0, 200);
    r.executedResult = { ok: false, error: r.reason };
    return { ok: true, executed: false, result: out, request: _publicView(r) };
  } catch (e) {
    r.state = 'FAILED';
    r.reason = String(e?.message || e).slice(0, 200);
    r.executedResult = { ok: false, error: r.reason };
    return { ok: true, executed: false, error: r.reason, request: _publicView(r) };
  }
}

/** Status surface (route + tests). */
export function approvalStatus(now = Date.now()) {
  for (const r of _requests.values()) _expireIfDue(r, now);
  const recent = [..._requests.values()]
    .sort((a, b) => b.createdAt - a.createdAt).slice(0, 5).map(_publicView);
  return {
    ok: true,
    enabled: approvalEnabled(),
    pinConfigured: !!approvalPin(),
    dailyCap: approvalDailyCap(),
    dailyUsed: dailyCapUsed(now),
    dayKey: approvalDayKey(now),
    ttlMs: approvalTtlMs(),
    pending: pendingRequest(now),
    recent,
    note: 'Approval = manual trigger for the SAME executeSignal gauntlet (kill switch, risk caps, mandate freeze all apply). PIN + allowlist + daily cap enforced here.',
  };
}

// ---------------- test hooks ----------------
export function __resetTradeApprovalForTests() {
  _requests.clear();
  _execDays.clear();
}
export function __requestsForTests() { return _requests; }
export function __execDaysForTests() { return _execDays; }
