// ============================================================
// test/apiError.test.ts — v10.10 [object Object] KILLER tests
// ------------------------------------------------------------
// The backend has two live error contracts ({error:{message,corrId}}
// from jsonError() and flat {error:'string'}), plus FastAPI
// {detail} bodies from ml-service proxies. Every one of them must
// extract to a clean human string — the SOL "[object Object]"
// report must never come back.
// ============================================================
import { describe, it, expect } from 'vitest';
import { extractApiError, extractApiErrorRef, describeApiError } from '../src/utils/apiError';

describe('extractApiError — every backend error contract', () => {
  it('plain string passes through', () => {
    expect(extractApiError('Agent engines unavailable')).toBe('Agent engines unavailable');
  });

  it('Error instance → .message', () => {
    expect(extractApiError(new Error('fetch failed'))).toBe('fetch failed');
    expect(extractApiError(new Error(''), 'fallback-x')).toBe('fallback-x');
  });

  it('THE BUG: jsonError() shape {error:{message,correlationId}} unwraps the message', () => {
    const body = { error: { message: 'Agent engines unavailable: gemini 429 | groq 429', correlationId: 'c-1234567890' } };
    expect(extractApiError(body)).toBe('Agent engines unavailable: gemini 429 | groq 429');
  });

  it('flat contract {ok:false, error:"string"}', () => {
    expect(extractApiError({ ok: false, error: 'start failed: live phrase galat hai' })).toBe('start failed: live phrase galat hai');
  });

  it('generic {message} body', () => {
    expect(extractApiError({ message: 'Bad Request' })).toBe('Bad Request');
  });

  it('FastAPI {detail} body (ml-service proxies)', () => {
    expect(extractApiError({ detail: 'model file missing' })).toBe('model file missing');
    expect(extractApiError({ detail: { message: 'ensemble stale' } })).toBe('ensemble stale');
  });

  it('nested {error:{error:{message}}} proxies still resolve', () => {
    expect(extractApiError({ error: { error: { message: 'deep failure' } } })).toBe('deep failure');
  });

  it('unknown object shape → truncated safe JSON, NEVER "[object Object]"', () => {
    const out = extractApiError({ weird: { a: 1 } });
    expect(out).not.toBe('[object Object]');
    expect(out).toContain('weird');
  });

  it('null/undefined/empty → fallback', () => {
    expect(extractApiError(null, 'Agent unavailable')).toBe('Agent unavailable');
    expect(extractApiError(undefined, 'Agent unavailable')).toBe('Agent unavailable');
    expect(extractApiError({}, 'Agent unavailable')).toBe('Agent unavailable');
  });

  it('never throws on hostile input (circular ref, symbol keys)', () => {
    const circular: Record<string, unknown> = { error: {} };
    circular.self = circular;
    expect(typeof extractApiError(circular, 'safe fallback')).toBe('string');
  });
});

describe('extractApiErrorRef — server correlation id surfacing', () => {
  it('reads corr id from the jsonError envelope', () => {
    expect(extractApiErrorRef({ error: { message: 'x', correlationId: 'abc-1234567890' } })).toBe('abc-1234567890'.slice(0, 12));
  });

  it('reads top-level correlationId too', () => {
    expect(extractApiErrorRef({ correlationId: 'zzz' })).toBe('zzz');
  });

  it('missing → empty string (no noise)', () => {
    expect(extractApiErrorRef({ error: 'flat string' })).toBe('');
    expect(extractApiErrorRef(null)).toBe('');
  });
});

describe('describeApiError — the panel one-liner', () => {
  it('message + (ref: id) suffix when correlationId present', () => {
    const out = describeApiError({ error: { message: 'engines down', correlationId: 'corr-abcdef123456' } }, 502);
    expect(out).toBe('engines down (ref: corr-abcdef1)');
  });

  it('status-coded fallback when body empty', () => {
    expect(describeApiError({}, 503)).toBe('request failed (503)');
    expect(describeApiError(undefined, 500, 'agent error 500')).toBe('agent error 500');
  });

  it('no ref suffix when absent', () => {
    expect(describeApiError({ error: 'boom' }, 400)).toBe('boom');
  });
});
