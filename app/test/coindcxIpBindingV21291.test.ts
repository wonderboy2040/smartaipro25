// ============================================================
// test/coindcxIpBindingV21291.test.ts — CoinDCX 28 Oct 2026
// MANDATORY IP BINDING.
// ------------------------------------------------------------
// Locks the v21.29.1 incident fix:
//   1. outboundIp.js — the app reports the SAME family:4 address that
//      signed CoinDCX calls leave from (the live box had two egress
//      IPs: 152.57.142.92 over the default path, 152.57.132.146 over
//      IPv4). Cached, failover, never throws.
//   2. 401/403 errors carry an actionable IP-binding hint (CoinDCX
//      returns the same generic "Invalid credentials" for a wrong
//      secret AND an unbound IP).
//   3. env bootstrap: a DIFFERENT .env key pair is the operator's
//      newer IP-bound key and must REPLACE the stale saved key; an
//      auth-failed pair is never persisted as a fake "connected".
// Hermetic — fetch/https never leave the process.
// ============================================================
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import dns from 'node:dns';

const coindcx = await import('../server/mcp/coindcx.js');
const outboundIp = await import('../server/lib/outboundIp.js');

const ENV_NAMES = ['COINDCX_API_KEY', 'COINDCX_KEY', 'COINDCX_APIKEY', 'COINDCX_PUBLIC_KEY',
  'COINDCX_SECRET', 'COINDCX_API_SECRET', 'COINDCX_SECRET_KEY', 'COINDCX_PRIVATE_KEY'];

const balancesRes = (body: unknown, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: new Map(),
  text: async () => JSON.stringify(body),
  json: async () => body,
});

function clearEnv() {
  for (const n of ENV_NAMES) delete process.env[n];
}

beforeEach(() => {
  clearEnv();
  (coindcx as any).__resetCoindcxEnvBootForTest();
  (coindcx as any).__setCredsForTests(null, null);
  outboundIp.__resetOutboundIpForTests();
});
afterEach(() => {
  vi.unstubAllGlobals();
  clearEnv();
  (coindcx as any).__resetCoindcxEnvBootForTest();
  (coindcx as any).__setCredsForTests(null, null);
  outboundIp.__resetOutboundIpForTests();
});

// ================================================================
// 1. OUTBOUND IPv4 DETECTION
// ================================================================
describe('outboundIp — family:4 egress address for CoinDCX binding', () => {
  it('coindcx.js pins Node DNS to IPv4 (fetch POSTs leave from the bound address)', () => {
    // live evidence: ipv4first fetch → 152.57.132.146, default (IPv6/NAT64)
    // fetch → 152.57.142.92 on the same box.
    expect(dns.getDefaultResultOrder()).toBe('ipv4first');
  });

  it('accepts only real IPv4 addresses', () => {
    expect(outboundIp.isValidIPv4('152.57.132.146')).toBe(true);
    expect(outboundIp.isValidIPv4(' 152.57.132.146 ')).toBe(true);
    expect(outboundIp.isValidIPv4('0.0.0.0')).toBe(true);
    expect(outboundIp.isValidIPv4('255.255.255.255')).toBe(true);
    expect(outboundIp.isValidIPv4('256.1.1.1')).toBe(false);
    expect(outboundIp.isValidIPv4('152.57.132')).toBe(false);
    expect(outboundIp.isValidIPv4('::1')).toBe(false);
    expect(outboundIp.isValidIPv4('not-an-ip')).toBe(false);
    expect(outboundIp.isValidIPv4(null)).toBe(false);
  });

  it('returns the trimmed address (a newline from the provider is normal)', async () => {
    outboundIp.__setOutboundIpFetcherForTests(async () => '152.57.132.146\n');
    expect(await outboundIp.getOutboundIPv4()).toBe('152.57.132.146');
  });

  it('fails over to the next provider when one is down or returns garbage', async () => {
    const calls: string[] = [];
    outboundIp.__setOutboundIpFetcherForTests(async (url: string) => {
      calls.push(url);
      if (calls.length === 1) throw new Error('ECONNRESET');
      if (calls.length === 2) return '<html>rate limited</html>';
      return '203.0.113.9';
    });
    expect(await outboundIp.getOutboundIPv4()).toBe('203.0.113.9');
    expect(calls).toHaveLength(3);
  });

  it('never throws — all providers down → null', async () => {
    outboundIp.__setOutboundIpFetcherForTests(async () => { throw new Error('offline'); });
    await expect(outboundIp.getOutboundIPv4()).resolves.toBeNull();
    expect(outboundIp.getCachedOutboundIPv4()).toBeNull();
  });

  it('caches for 10 minutes; refresh forces a new lookup', async () => {
    let n = 0;
    outboundIp.__setOutboundIpFetcherForTests(async () => { n++; return '198.51.100.7'; });
    expect(await outboundIp.getOutboundIPv4()).toBe('198.51.100.7');
    expect(await outboundIp.getOutboundIPv4()).toBe('198.51.100.7');
    expect(n).toBe(1);
    expect(outboundIp.getCachedOutboundIPv4()).toBe('198.51.100.7');
    await outboundIp.getOutboundIPv4({ refresh: true });
    expect(n).toBe(2);
  });

  it('coalesces concurrent lookups into one upstream call', async () => {
    let n = 0;
    outboundIp.__setOutboundIpFetcherForTests(async () => { n++; return '198.51.100.8'; });
    const [a, b, c] = await Promise.all([
      outboundIp.getOutboundIPv4(),
      outboundIp.getOutboundIPv4(),
      outboundIp.getOutboundIPv4(),
    ]);
    expect([a, b, c]).toEqual(['198.51.100.8', '198.51.100.8', '198.51.100.8']);
    expect(n).toBe(1);
  });
});

// ================================================================
// 2. AUTH-ERROR HINT (401/403 = invalid secret OR unbound IP)
// ================================================================
describe('CoinDCX 401/403 → actionable IP-binding hint', () => {
  it('401 carries the cached outbound IPv4 + the exact bind steps', async () => {
    outboundIp.__setCachedOutboundIpForTests('152.57.132.146');
    vi.stubGlobal('fetch', async () => balancesRes({ code: 401, message: 'Invalid credentials', status: 'error' }, 401));
    const err = await coindcx.coindcxPrivate('/exchange/v1/users/balances', 'k', 's').catch(e => e);
    expect(err.status).toBe(401);
    expect(err.message).toContain('[401] Invalid credentials'); // live error prefix preserved
    expect(err.message).toContain('IP binding mandatory');
    expect(err.message).toContain('152.57.132.146');
    expect(err.message).toContain('NAYA key');
  });

  it('401 without a warmed cache still points at npm run coindcx:check', async () => {
    vi.stubGlobal('fetch', async () => balancesRes({ message: 'Invalid credentials' }, 401));
    const err = await coindcx.coindcxPrivate('/x', 'k', 's').catch(e => e);
    expect(err.message).toContain('IP binding mandatory');
    expect(err.message).toContain('npm run coindcx:check');
  });

  it('403 (IP not allowed) gets the same hint', async () => {
    outboundIp.__setCachedOutboundIpForTests('152.57.132.146');
    vi.stubGlobal('fetch', async () => balancesRes({ message: 'Forbidden' }, 403));
    const err = await coindcx.coindcxPrivate('/x', 'k', 's').catch(e => e);
    expect(err.status).toBe(403);
    expect(err.message).toContain('IP binding mandatory');
    expect(err.message).toContain('152.57.132.146');
  });

  it('non-auth errors stay clean (no misleading IP-binding text)', async () => {
    vi.stubGlobal('fetch', async () => balancesRes({ message: 'Internal error' }, 500));
    const err = await coindcx.coindcxPrivate('/x', 'k', 's').catch(e => e);
    expect(err.status).toBe(500);
    expect(err.message).toBe('[500] Internal error');
    expect(err.message).not.toContain('IP binding');
  });
});

// ================================================================
// 3. ENV BOOTSTRAP PRIORITY (the live user report)
// ================================================================
describe('coindcxEnvBootstrap — new IP-bound .env key beats the stale saved key', () => {
  it('differing .env pair is validated and REPLACES the saved creds', async () => {
    (coindcx as any).__setCredsForTests('oldUiKey', 'oldUiSecret');
    process.env.COINDCX_API_KEY = 'newIpBoundKey';
    process.env.COINDCX_SECRET = 'newIpBoundSecret';
    vi.stubGlobal('fetch', async () => balancesRes([{
      currency_short_name: 'BTC', currency_name: 'Bitcoin', available_balance: 1, locked_balance: 0,
    }]));
    outboundIp.__setOutboundIpFetcherForTests(async () => '152.57.132.146');
    const logs: string[] = [];
    const out = await (coindcx as any).coindcxEnvBootstrap((l: string) => logs.push(l));

    expect(out.ok).toBe(true);
    expect(out.source).toBe('env-updated');
    expect(out.balanceCount).toBe(1);
    const saved = (coindcx as any).__getCredsForTests();
    expect(saved.apiKey).toBe('newIpBoundKey');
    expect(saved.secret).toBe('newIpBoundSecret');
    expect(coindcx.coindcxStatus().connected).toBe(true);
    // boot IP line is fire-and-forget (never blocks boot)
    await vi.waitFor(() => expect(logs.some(l => l.includes('152.57.132.146'))).toBe(true));
  });

  it('auth-failed differing pair is NOT persisted and the saved key survives', async () => {
    (coindcx as any).__setCredsForTests('oldUiKey', 'oldUiSecret');
    process.env.COINDCX_API_KEY = 'unboundKey';
    process.env.COINDCX_SECRET = 'unboundSecret';
    vi.stubGlobal('fetch', async () => balancesRes({ code: 401, message: 'Invalid credentials' }, 401));
    outboundIp.__setOutboundIpFetcherForTests(async () => '152.57.132.146');
    const out = await (coindcx as any).coindcxEnvBootstrap(() => {});

    expect(out.ok).toBe(false);
    expect(out.source).toBe('env-invalid');
    expect(out.savedPreserved).toBe(true);
    expect(String(out.error)).toContain('401');
    const saved = (coindcx as any).__getCredsForTests();
    expect(saved.apiKey).toBe('oldUiKey');
    expect(saved.secret).toBe('oldUiSecret');
  });

  it('non-auth probe failure still uses the v21.20 futures fallback (keeps execution alive)', async () => {
    process.env.COINDCX_API_KEY = 'futuresKey';
    process.env.COINDCX_SECRET = 'futuresSecret';
    // e.g. spot endpoint 502 / futures-scoped key — not an auth verdict
    vi.stubGlobal('fetch', async () => balancesRes({ message: 'Bad gateway' }, 502));
    outboundIp.__setOutboundIpFetcherForTests(async () => '152.57.132.146');
    const out = await (coindcx as any).coindcxEnvBootstrap(() => {});

    expect(out.ok).toBe(true);
    expect(out.fallback).toBe(true);
    const saved = (coindcx as any).__getCredsForTests();
    expect(saved.apiKey).toBe('futuresKey');
    expect(saved.source).toBe('env-fallback');
  });
});
