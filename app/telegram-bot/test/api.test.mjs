import assert from 'node:assert/strict';
import test from 'node:test';
import { SiteApi, ApiError } from '../lib/api.mjs';

const jsonResponse = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { 'content-type': 'application/json' },
});

test('SiteApi sends the service bearer token and caches live board reads', async () => {
  const calls = [];
  const api = new SiteApi({
    baseUrl: 'http://127.0.0.1:8080/',
    token: 'service-secret',
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return jsonResponse({ ok: true, market: 'CRYPTO', rows: [] });
    },
  });

  const first = await api.mtfBoard('CRYPTO', { timeoutMs: 5000 });
  const second = await api.mtfBoard('CRYPTO', { timeoutMs: 5000 });

  assert.deepEqual(first, second);
  assert.equal(calls.length, 1, 'cached board should not hit the server twice');
  assert.equal(calls[0].url, 'http://127.0.0.1:8080/api/ai/mtf-dual/board?market=CRYPTO&mode=INTRADAY&limit=8');
  assert.equal(calls[0].options.headers.Authorization, 'Bearer service-secret');
});

test('fresh=true bypasses the board cache', async () => {
  let calls = 0;
  const api = new SiteApi({
    baseUrl: 'http://127.0.0.1:8080',
    token: 'x',
    fetchImpl: async () => {
      calls += 1;
      return jsonResponse({ ok: true, market: 'CRYPTO', rows: [] });
    },
  });

  await api.mtfBoard('CRYPTO', { fresh: true, timeoutMs: 5000 });
  await api.mtfBoard('CRYPTO', { fresh: true, timeoutMs: 5000 });
  assert.equal(calls, 2);
});

test('API errors carry a safe user-facing message without the token', async () => {
  const api = new SiteApi({
    baseUrl: 'http://127.0.0.1:8080',
    token: 'super-secret-token',
    fetchImpl: async () => jsonResponse({ error: 'bad request detail' }, 400),
  });

  await assert.rejects(
    () => api.get('/api/ai/positions'),
    (error) => {
      assert.ok(error instanceof ApiError);
      assert.equal(error.status, 400);
      assert.match(error.userMessage, /bad request detail/);
      assert.doesNotMatch(error.userMessage, /super-secret-token/);
      return true;
    },
  );
});

test('network failures are retried and then mapped to a connection message', async () => {
  let calls = 0;
  const api = new SiteApi({
    baseUrl: 'http://127.0.0.1:8080',
    token: 'x',
    fetchImpl: async () => {
      calls += 1;
      throw new TypeError('fetch failed');
    },
  });

  await assert.rejects(
    () => api.get('/api/ping', { retries: 1 }),
    (error) => {
      assert.equal(error.kind, 'network');
      assert.match(error.userMessage, /connect nahi hua/);
      return true;
    },
  );
  assert.equal(calls, 2);
});
