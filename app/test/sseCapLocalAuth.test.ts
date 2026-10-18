// ============================================================
// test/sseCapLocalAuth.test.ts — v18.6.3 REALTIME NEVER STOPS (S1)
// ------------------------------------------------------------
// THE BUG (user report): the app's own browser holds exactly THREE
// /api/stream SSE connections once a manual trade is open (global
// liveStream + CoinDCX board + manual tracker) — exactly the old
// flat SSE_MAX_PER_IP = 3. Any fourth connection (a reconnect race
// against a slow socket close, a second app tab, a phone peek) got
// HTTP 429, and EventSource retries the same URL forever → the
// stream sat in a PERMANENT "live feed down — retrying" loop.
//
// THE CONTRACT (locked here, pure module — no server boot):
//   • loopback (the Windows desktop app → 127.0.0.1) → 8 slots
//   • authenticated remote session → 6 slots
//   • anonymous remote → 3 slots (the amplification guard intact)
//   • extractSessionToken: Bearer header → cookie → ?session=,
//     same precedence as requireAuth
// ============================================================
import { describe, it, expect } from 'vitest';
import {
  isLoopbackIp, sseConnMaxFor, extractSessionToken,
  SSE_MAX_ANON, SSE_MAX_AUTHED, SSE_MAX_LOOPBACK,
} from '../server/lib/sseCap.js';

describe('sseCap — v18.6.3 connection-class-aware /api/stream cap', () => {
  it('loopback gets the desktop-app budget (8)', () => {
    expect(sseConnMaxFor('127.0.0.1', false)).toBe(SSE_MAX_LOOPBACK);
    expect(sseConnMaxFor('127.0.0.1', false)).toBe(8);
    expect(sseConnMaxFor('::1', true)).toBe(8);
    expect(sseConnMaxFor('::ffff:127.0.0.1', false)).toBe(8);
    // loopback wins even without auth — it's the app's own browser
    expect(sseConnMaxFor('127.0.0.1', false)).toBeGreaterThan(SSE_MAX_AUTHED);
  });

  it('authenticated remote sessions get 6 (never collide with the app\'s own 3)', () => {
    expect(sseConnMaxFor('49.36.12.9', true)).toBe(SSE_MAX_AUTHED);
    expect(sseConnMaxFor('49.36.12.9', true)).toBe(6);
    // the app's own three streams + reconnect race + second tab all fit
    expect(SSE_MAX_AUTHED).toBeGreaterThanOrEqual(5);
  });

  it('anonymous remote stays at the protective 3 (v7.0.2 guard intact)', () => {
    expect(sseConnMaxFor('49.36.12.9', false)).toBe(SSE_MAX_ANON);
    expect(SSE_MAX_ANON).toBe(3);
    expect(sseConnMaxFor('203.0.113.7', false)).toBe(3);
  });

  it('the app\'s own 3 connections fit inside the loopback budget with room to spare', () => {
    // the exact regression: 4th connection (reconnect race / 2nd tab)
    // must be allowed on loopback
    const cap = sseConnMaxFor('127.0.0.1', true);
    expect(cap).toBeGreaterThanOrEqual(3 + 1);
    // even 6 parallel streams (three tabs) fit
    expect(cap).toBeGreaterThanOrEqual(6);
  });

  it('isLoopbackIp — IPv4 / IPv6 / mapped forms, case + whitespace safe', () => {
    expect(isLoopbackIp('127.0.0.1')).toBe(true);
    expect(isLoopbackIp('::1')).toBe(true);
    expect(isLoopbackIp('::FFFF:127.0.0.1')).toBe(true);
    expect(isLoopbackIp('localhost')).toBe(true);
    expect(isLoopbackIp(' 127.0.0.1 ')).toBe(true);
    expect(isLoopbackIp('192.168.1.5')).toBe(false);
    expect(isLoopbackIp('::ffff:192.168.1.5')).toBe(false);
    expect(isLoopbackIp(null)).toBe(false);
    expect(isLoopbackIp('')).toBe(false);
  });
});

describe('extractSessionToken — Bearer → cookie → ?session= precedence', () => {
  it('Bearer header wins', () => {
    const token = extractSessionToken({
      headers: { authorization: 'Bearer abc-123' },
      query: { session: 'zzz' },
    });
    expect(token).toBe('abc-123');
  });

  it('falls back to the session cookie (no Bearer)', () => {
    const token = extractSessionToken({
      headers: { cookie: 'other=1; wealthai_session=tok-cookie; x=2' },
      query: {},
    });
    expect(token).toBe('tok-cookie');
  });

  it('falls back to ?session= (the EventSource path)', () => {
    const token = extractSessionToken({
      headers: {},
      query: { session: 'tok-sse' },
    });
    expect(token).toBe('tok-sse');
  });

  it('null when nothing present (anonymous remote)', () => {
    expect(extractSessionToken({ headers: {}, query: {} })).toBeNull();
    expect(extractSessionToken()).toBeNull();
  });
});
