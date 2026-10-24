// ============================================================
// test/mtfAutoApiHonesty.test.ts — v21.23.17
// Config/toggle saves used to collapse EVERY failure into `null`, so the UI
// could only say "NAHI hua (server error)". These locks prove the helper now
// returns the real server message + correlation ref, and keeps the successful
// path unchanged (POST config is authoritative, /status is an overlay).
// ============================================================
import { describe, it, expect, vi, afterEach } from 'vitest';
import { updateMtfAutoConfigApi, setMtfAutoEnabledApi } from '../src/components/aitrading/useAITrading';

const response = (payload: unknown, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => payload,
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('v21.23.17 MTF auto config/toggle failure honesty', () => {
  it('surfaces the real jsonError message + correlation ref on config failure', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => response({
      error: { message: 'holdMin must be 5..240', correlationId: 'corr123456789' },
    }, 400)));

    const r = await updateMtfAutoConfigApi({ holdMin: 999 });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.httpStatus).toBe(400);
    expect(r.error).toContain('holdMin must be 5..240');
    expect(r.error).toContain('ref: corr123456');
    expect(r.error).not.toContain('[object Object]');
  });

  it('surfaces the flat {ok:false,error} shape on toggle failure', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => response({
      ok: false, error: 'kill switch engaged — auto arm denied',
    }, 400)));

    const r = await setMtfAutoEnabledApi(true);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain('kill switch engaged');
  });

  it('keeps the successful POST authoritative when /status is unavailable', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (String(url).includes('/mtf-auto/status')) return response({ error: 'status down' }, 503);
      return response({ ok: true, config: { mode: 'INTRADAY', holdMin: 45 }, coindcxConnected: true });
    }));

    const r = await updateMtfAutoConfigApi({ mode: 'INTRADAY', holdMin: 45 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.status.ok).toBe(true);
    expect((r.status as unknown as { config: { mode: string } }).config.mode).toBe('INTRADAY');
  });

  it('turns a network failure into a readable reason (never a bare null)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ECONNREFUSED 127.0.0.1:3000'); }));

    const r = await setMtfAutoEnabledApi(false);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain('ECONNREFUSED');
  });
});
