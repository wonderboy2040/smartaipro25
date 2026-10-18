// ============================================================
// test/tradeApproval.test.ts — v10.9 #4 CONTROLLED APPROVAL
// ------------------------------------------------------------
// The security contract, test-locked:
//   opt-in OFF by default · PIN mandatory + 3 tries · daily hard cap
//   TTL expiry (request + PIN window) · one-at-a-time · ownership
//   (only the creating chat may act) · executeSignal-only execution
// ============================================================
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  approvalEnabled, approvalPin, approvalDailyCap, approvalTtlMs, approvalDayKey,
  parseTradeCommand, parseApprovalCallback, pinMatches,
  createTradeApproval, beginPinPhase, rejectTradeApproval, submitPin,
  dailyCapUsed, pendingRequest, ownsRequest, approvalStatus, requestById,
  __resetTradeApprovalForTests,
} from '../server/ai/tradeApproval.js';

const ADMIN_CHAT = '111222333';

function armEnv(over = {}) {
  process.env.AI_TELEGRAM_APPROVALS = 'on';
  process.env.AI_APPROVAL_PIN = '123456';
  process.env.AI_APPROVAL_MAX_PER_DAY = '2';
  process.env.AI_APPROVAL_TTL_MS = '60000'; // 1 min for fast TTL tests
  Object.assign(process.env, over);
}
function disarmEnv() {
  delete process.env.AI_TELEGRAM_APPROVALS;
  delete process.env.AI_APPROVAL_PIN;
  delete process.env.AI_APPROVAL_MAX_PER_DAY;
  delete process.env.AI_APPROVAL_TTL_MS;
}

beforeEach(() => { __resetTradeApprovalForTests(); armEnv(); });
afterEach(() => { disarmEnv(); });

// ============================================================
// env knobs
// ============================================================
describe('approval flags', () => {
  it('is OFF by default (opt-in only)', () => {
    delete process.env.AI_TELEGRAM_APPROVALS;
    expect(approvalEnabled()).toBe(false);
  });
  it('arms only on exact "on"', () => {
    process.env.AI_TELEGRAM_APPROVALS = 'on';
    expect(approvalEnabled()).toBe(true);
    process.env.AI_TELEGRAM_APPROVALS = 'true';
    expect(approvalEnabled()).toBe(false); // strict — no truthy guessing
  });
  it('malformed PIN = NO approvals ever', () => {
    process.env.AI_APPROVAL_PIN = '12';       // too short
    expect(approvalPin()).toBe('');
    process.env.AI_APPROVAL_PIN = 'abc12';    // non-digit
    expect(approvalPin()).toBe('');
    process.env.AI_APPROVAL_PIN = '1234567890123'; // too long
    expect(approvalPin()).toBe('');
    process.env.AI_APPROVAL_PIN = '123456';
    expect(approvalPin()).toBe('123456');
  });
  it('daily cap defaults to 3 and clamps to 1..20', () => {
    delete process.env.AI_APPROVAL_MAX_PER_DAY;
    expect(approvalDailyCap()).toBe(3);
    process.env.AI_APPROVAL_MAX_PER_DAY = '0';
    expect(approvalDailyCap()).toBe(3); // invalid → default
    process.env.AI_APPROVAL_MAX_PER_DAY = '5';
    expect(approvalDailyCap()).toBe(5);
  });
  it('TTL defaults to 5 min and clamps', () => {
    delete process.env.AI_APPROVAL_TTL_MS;
    expect(approvalTtlMs()).toBe(5 * 60_000);
    process.env.AI_APPROVAL_TTL_MS = '10';
    expect(approvalTtlMs()).toBe(5 * 60_000); // invalid → default
  });
  it('day key is IST-dated', () => {
    // 2026-09-15 01:30 IST is 2026-09-14 20:00 UTC — the IST day wins
    expect(approvalDayKey(Date.UTC(2026, 8, 14, 20, 0))).toBe('2026-09-15');
  });
});

// ============================================================
// parsing (pure)
// ============================================================
describe('parseTradeCommand', () => {
  it('parses the full grammar', () => {
    expect(parseTradeCommand('/trade BTC LONG 5000 x3 live')).toEqual({
      ok: true, symbol: 'BTC', side: 'LONG', qtyINR: 5000, leverage: 3, mode: 'live',
    });
  });
  it('buy/sell map to LONG/SHORT', () => {
    expect(parseTradeCommand('/trade ETH buy').side).toBe('LONG');
    expect(parseTradeCommand('/trade ETH sell 100').side).toBe('SHORT');
  });
  it('defaults: no qty, no leverage, paper mode', () => {
    expect(parseTradeCommand('/trade B-SOL_USDT short')).toEqual({
      ok: true, symbol: 'B-SOL_USDT', side: 'SHORT', qtyINR: undefined, leverage: undefined, mode: 'paper',
    });
  });
  it('rejects malformed input with usage, never a guess', () => {
    expect(parseTradeCommand('/trade').ok).toBe(false);
    expect(parseTradeCommand('/trade BTC').ok).toBe(false);
    expect(parseTradeCommand('/trade BTC sideways').ok).toBe(false);
    expect(parseTradeCommand('/trade BTC LONG -500').ok).toBe(false);
    expect(parseTradeCommand('BTC LONG').ok).toBe(false); // must start with /trade
  });
});

describe('parseApprovalCallback', () => {
  it('parses approve/reject callback_data', () => {
    expect(parseApprovalCallback('ta:app:abc123')).toEqual({ action: 'approve', id: 'abc123' });
    expect(parseApprovalCallback('ta:rej:abc123')).toEqual({ action: 'reject', id: 'abc123' });
  });
  it('rejects anything else (no path to act on foreign data)', () => {
    expect(parseApprovalCallback('ta:exec:abc123')).toBeNull();
    expect(parseApprovalCallback('random')).toBeNull();
    expect(parseApprovalCallback('')).toBeNull();
  });
});

describe('pinMatches', () => {
  it('exact match only', () => {
    expect(pinMatches('123456', '123456')).toBe(true);
    expect(pinMatches('123456', ' 123456 ')).toBe(true); // trimmed
    expect(pinMatches('123456', '123457')).toBe(false);
    expect(pinMatches('123456', '12345')).toBe(false);
    expect(pinMatches('', '123456')).toBe(false);
    expect(pinMatches('123456', '')).toBe(false);
  });
});

// ============================================================
// state machine
// ============================================================
describe('createTradeApproval', () => {
  it('refuses when disabled', () => {
    delete process.env.AI_TELEGRAM_APPROVALS;
    expect(createTradeApproval({ symbol: 'BTC', side: 'LONG', mode: 'paper', chatId: ADMIN_CHAT }).error).toBe('disabled');
  });
  it('refuses when no PIN configured (PIN is mandatory)', () => {
    delete process.env.AI_APPROVAL_PIN;
    expect(createTradeApproval({ symbol: 'BTC', side: 'LONG', mode: 'paper', chatId: ADMIN_CHAT }).error).toBe('no-pin');
  });
  it('creates a PENDING request with TTL', () => {
    const now = Date.now();
    const out = createTradeApproval({ symbol: 'BTC', side: 'LONG', mode: 'paper', qtyINR: 5000, chatId: ADMIN_CHAT }, { now });
    expect(out.ok).toBe(true);
    expect(out.request.state).toBe('PENDING');
    expect(out.request.expiresAt).toBe(now + 60_000);
    expect(out.request.symbol).toBe('BTC');
  });
  it('rejects bad symbols/sides/modes/qty/leverage', () => {
    const bad = [
      { symbol: 'BTC; DROP TABLE', side: 'LONG', mode: 'paper' },
      { symbol: '', side: 'LONG', mode: 'paper' },
      { symbol: 'BTC', side: 'SIDEWAYS', mode: 'paper' },
      { symbol: 'BTC', side: 'LONG', mode: 'yolo' },
      { symbol: 'BTC', side: 'LONG', mode: 'paper', qtyINR: -5 },
      { symbol: 'BTC', side: 'LONG', mode: 'paper', qtyINR: 99_999_999 },
      { symbol: 'BTC', side: 'LONG', mode: 'paper', leverage: 50 },
      { symbol: 'BTC', side: 'LONG', mode: 'paper', leverage: 0 },
    ];
    for (const b of bad) {
      expect(createTradeApproval({ ...b, chatId: ADMIN_CHAT }).ok).toBe(false);
    }
  });
  it('ONE pending request at a time', () => {
    expect(createTradeApproval({ symbol: 'BTC', side: 'LONG', mode: 'paper', chatId: ADMIN_CHAT }).ok).toBe(true);
    const second = createTradeApproval({ symbol: 'ETH', side: 'SHORT', mode: 'paper', chatId: ADMIN_CHAT });
    expect(second.ok).toBe(false);
    expect(second.error).toBe('one-at-a-time');
  });
  it('daily cap blocks creation', async () => {
    const exec = vi.fn(async () => ({ ok: true }));
    for (let i = 0; i < 2; i++) { // cap = 2
      const r = createTradeApproval({ symbol: `SYM${i}`, side: 'LONG', mode: 'paper', chatId: ADMIN_CHAT });
      beginPinPhase(r.id);
      await submitPin(r.id, '123456', { execute: exec });
      rejectTradeApproval(r.id); // state hygiene — cap already counted on EXECUTED
    }
    const third = createTradeApproval({ symbol: 'X', side: 'LONG', mode: 'paper', chatId: ADMIN_CHAT });
    expect(third.ok).toBe(false);
    expect(third.error).toBe('daily-cap');
    expect(third.used).toBe(2);
  });
});

describe('PIN flow', () => {
  it('3 wrong tries kill the request', async () => {
    const r = createTradeApproval({ symbol: 'BTC', side: 'LONG', mode: 'paper', chatId: ADMIN_CHAT });
    beginPinPhase(r.id);
    const exec = vi.fn(async () => ({ ok: true }));
    expect((await submitPin(r.id, '000000', { execute: exec })).error).toBe('wrong-pin');
    expect((await submitPin(r.id, '000001', { execute: exec })).error).toBe('wrong-pin');
    const third = await submitPin(r.id, '000002', { execute: exec });
    expect(third.error).toBe('pin-dead');
    expect(exec).not.toHaveBeenCalled();
    expect(pendingRequest()).toBeNull(); // dead — nothing pending
  });
  it('correct PIN executes through the injected (single) path and counts the day', async () => {
    const r = createTradeApproval({ symbol: 'BTC', side: 'LONG', mode: 'paper', qtyINR: 5000, leverage: 3, chatId: ADMIN_CHAT });
    beginPinPhase(r.id);
    const exec = vi.fn(async (req) => {
      expect(req.symbol).toBe('BTC');
      expect(req.side).toBe('LONG');
      return { ok: true, orderRef: 'ord-1' };
    });
    const out = await submitPin(r.id, '123456', { execute: exec });
    expect(out.ok).toBe(true);
    expect(out.executed).toBe(true);
    expect(exec).toHaveBeenCalledTimes(1);
    expect(out.request.state).toBe('EXECUTED');
    expect(dailyCapUsed()).toBe(1);
  });
  it('gauntlet REFUSAL is honest: FAILED state, day cap NOT consumed', async () => {
    const r = createTradeApproval({ symbol: 'BTC', side: 'LONG', mode: 'paper', chatId: ADMIN_CHAT });
    beginPinPhase(r.id);
    const exec = vi.fn(async () => ({ ok: false, error: 'kill switch ON' }));
    const out = await submitPin(r.id, '123456', { execute: exec });
    expect(out.ok).toBe(true);        // the flow worked
    expect(out.executed).toBe(false); // the ORDER didn't
    expect(out.request.state).toBe('FAILED');
    expect(out.request.reason).toBe('kill switch ON');
    expect(dailyCapUsed()).toBe(0);   // only EXECUTED counts
  });
  it('executor THROWING is contained (FAILED, no crash, no count)', async () => {
    const r = createTradeApproval({ symbol: 'BTC', side: 'LONG', mode: 'paper', chatId: ADMIN_CHAT });
    beginPinPhase(r.id);
    const out = await submitPin(r.id, '123456', { execute: async () => { throw new Error('boom'); } });
    expect(out.executed).toBe(false);
    expect(out.request.state).toBe('FAILED');
    expect(dailyCapUsed()).toBe(0);
  });
  it('PIN only works in the APPROVING phase (button-first is mandatory)', async () => {
    const r = createTradeApproval({ symbol: 'BTC', side: 'LONG', mode: 'paper', chatId: ADMIN_CHAT });
    // no beginPinPhase — straight PIN attempt must fail
    const out = await submitPin(r.id, '123456', { execute: async () => ({ ok: true }) });
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/not-awaiting-pin/);
  });
});

describe('TTL windows', () => {
  it('request expires after the TTL', () => {
    const t0 = Date.now();
    const r = createTradeApproval({ symbol: 'BTC', side: 'LONG', mode: 'paper', chatId: ADMIN_CHAT }, { now: t0 });
    expect(beginPinPhase(r.id, { now: t0 + 59_000 }).ok).toBe(true);
    const late = beginPinPhase(r.id, { now: t0 + 61_000 }); // re-approve after expiry… new request check
    expect(late.ok).toBe(false);
    expect(requestById(r.id, t0 + 61_000).state).toBe('EXPIRED');
  });
  it('PIN window (3 min) can be shorter than the request TTL', async () => {
    process.env.AI_APPROVAL_TTL_MS = String(10 * 60_000); // 10-min request
    const t0 = Date.now();
    const r = createTradeApproval({ symbol: 'BTC', side: 'LONG', mode: 'paper', chatId: ADMIN_CHAT }, { now: t0 });
    beginPinPhase(r.id, { now: t0 });
    const out = await submitPin(r.id, '123456', { now: t0 + 4 * 60_000, execute: async () => ({ ok: true }) });
    expect(out.ok).toBe(false);
    expect(out.error).toBe('expired'); // 3-min PIN window lapsed although the request had 10 min
  });
});

describe('ownership (defense in depth)', () => {
  it('only the creating chat owns the request', () => {
    const r = createTradeApproval({ symbol: 'BTC', side: 'LONG', mode: 'paper', chatId: ADMIN_CHAT });
    expect(ownsRequest(r.id, ADMIN_CHAT)).toBe(true);
    expect(ownsRequest(r.id, '999888777')).toBe(false); // a viewer chat can never move it
    expect(ownsRequest(r.id, undefined)).toBe(false);
    expect(ownsRequest('nonexistent', ADMIN_CHAT)).toBe(false);
  });
});

describe('reject + status', () => {
  it('reject works from PENDING and APPROVING', () => {
    const r = createTradeApproval({ symbol: 'BTC', side: 'LONG', mode: 'paper', chatId: ADMIN_CHAT });
    expect(rejectTradeApproval(r.id).ok).toBe(true);
    expect(rejectTradeApproval(r.id).error).toBe('already-rejected');
    const r2 = createTradeApproval({ symbol: 'ETH', side: 'LONG', mode: 'paper', chatId: ADMIN_CHAT });
    beginPinPhase(r2.id);
    expect(rejectTradeApproval(r2.id).ok).toBe(true);
  });
  it('status surface reflects the state', () => {
    createTradeApproval({ symbol: 'BTC', side: 'LONG', mode: 'paper', chatId: ADMIN_CHAT });
    const st = approvalStatus();
    expect(st.enabled).toBe(true);
    expect(st.pinConfigured).toBe(true);
    expect(st.dailyCap).toBe(2);
    expect(st.pending?.symbol).toBe('BTC');
  });
});
