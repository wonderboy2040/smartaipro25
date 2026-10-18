// ============================================================
// test/coindcxGet.test.ts — v12.3 GET-with-body transport for the
// derivatives futures wallet routes
// ------------------------------------------------------------
// v12.3 ROOT-CAUSE LOCK: the official docs.coindcx.com samples send
// the SIGNED compact {"timestamp":<int ms>} JSON as the GET REQUEST
// BODY (requests.get(url, data=json_body)); params like page/size
// ride the query string UNSIGNED. Every query-param variant 401'd
// live for exactly this reason (empty body can never verify).
// Node's undici fetch FORBIDS GET bodies, so the body-mode transport
// rides node:https — these tests stub BOTH transports (https for
// body mode, global fetch for the legacy query mode) and pin the
// exact wire contract of each.
// ============================================================
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import crypto from 'node:crypto';

const origFetch = globalThis.fetch;
const fetchMock = vi.fn();

// ---- node:https stub (body-mode transport) ----
// Emulates the callback/stream shape _httpsGetJson consumes:
// https.request(opts, cb) -> req {on,write,end}; cb(res); res{statusCode,on}
const httpsRequestMock = vi.fn();
vi.mock('node:https', () => ({ default: { request: (...a) => httpsRequestMock(...a) } }));

// import AFTER the stubs are declared — the module reads globalThis.fetch
// and node:https at call time, not import time, so order is safe.
import { coindcxPrivateGET } from '../server/mcp/coindcx.js';

const okText = JSON.stringify([]);

function stubHttps(status: number, text: string, capture: { opts?: unknown; headers?: unknown; body?: string[] } = {}) {
  httpsRequestMock.mockImplementationOnce(((opts: any, cb: any) => {
    capture.opts = opts;
    capture.headers = opts.headers;
    capture.body = [];
    const handlers: Record<string, Array<(d?: unknown) => void>> = {};
    const res = {
      statusCode: status,
      on: (ev: string, fn: (d?: unknown) => void) => { (handlers[ev] = handlers[ev] || []).push(fn); },
      _fire: () => {
        (handlers['data'] || []).forEach(fn => fn(Buffer.from(text, 'utf8')));
        (handlers['end'] || []).forEach(fn => fn());
      },
    };
    const req = {
      on: vi.fn(),
      write: (b: Buffer) => { capture.body!.push(b.toString('utf8')); },
      end: () => { setTimeout(() => { cb(res); res._fire(); }, 0); },
      destroy: vi.fn(),
    };
    return req;
  }) as any);
}

beforeEach(() => {
  fetchMock.mockReset();
  httpsRequestMock.mockReset();
  globalThis.fetch = fetchMock as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = origFetch;
});

const okJson = (body: unknown) => ({
  ok: true, status: 200,
  json: async () => body,
  text: async () => JSON.stringify(body),
});

describe('coindcxPrivateGET (v12.3 documented GET-with-body auth)', () => {
  it('DEFAULT: node:https GET carrying the signed compact {"timestamp":<int ms>} as the REQUEST BODY — no timestamp in the query', async () => {
    const cap: { opts?: any; headers?: any; body?: string[] } = {};
    stubHttps(200, okText, cap);
    await coindcxPrivateGET('/exchange/v1/derivatives/futures/wallets', 'KEY', 'SECRET', {});

    expect(httpsRequestMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).not.toHaveBeenCalled();
    // the request goes to the CoinDCX host, GET method, right path
    expect(cap.opts.hostname).toBe('api.coindcx.com');
    expect(cap.opts.method).toBe('GET');
    expect(cap.opts.path).toBe('/exchange/v1/derivatives/futures/wallets'); // NO query
    // the body is the compact JSON string…
    expect(cap.body).toHaveLength(1);
    const bodyTs = (JSON.parse(cap.body![0]) as { timestamp: number }).timestamp;
    expect(bodyTs).toBeGreaterThanOrEqual(1_600_000_000_000); // ms epoch
    // Content-Length + Content-Type ride the headers
    expect(cap.headers['Content-Type']).toBe('application/json');
    expect(cap.headers['Content-Length']).toBe(Buffer.byteLength(cap.body![0], 'utf8'));
    expect(cap.headers['X-AUTH-APIKEY']).toBe('KEY');
    // v20.5.1: the User-Agent MUST be the same Mozilla browser string the
    // PUBLIC futures-instruments fetch uses (lines 837/853 of coindcx.js).
    // A custom product UA like `wealthai-coindcx/1.0` is still 401'd by
    // CoinDCX's WAF on the derivatives private GET family (the v20.5 fix
    // did not unblock every install); the Mozilla UA is the one string
    // the team has CONFIRMED passes through.
    expect(cap.headers['User-Agent']).toBe('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36');
    // CoinDCX documented contract also requires Accept: application/json
    // on the signed GET family — some installs get 406 without it.
    expect(cap.headers['Accept']).toBe('application/json');
    // …and the signature is HMAC-SHA256 over that EXACT string
    const expected = crypto.createHmac('sha256', 'SECRET').update(cap.body![0]).digest('hex');
    expect(cap.headers['X-AUTH-SIGNATURE']).toBe(expected);
  });

  it('body mode: params ride the query string UNSIGNED (transactions sample: ?page=1&size=1000 + {"timestamp":...} body)', async () => {
    const cap: { opts?: any; body?: string[] } = {};
    stubHttps(200, okText, cap);
    await coindcxPrivateGET('/x/y', 'K', 'S', { page: '1', size: '1000' });
    expect(cap.opts.path).toBe('/x/y?page=1&size=1000');
    expect(cap.opts.path).not.toContain('timestamp');
    // the signed body carries ONLY the timestamp
    const parsed = JSON.parse(cap.body![0]);
    expect(Object.keys(parsed)).toEqual(['timestamp']);
    const expected = crypto.createHmac('sha256', 'S').update(cap.body![0]).digest('hex');
    expect(cap.headers['X-AUTH-SIGNATURE']).toBe(expected);
  });

  it('body mode + unit s signs the 10-digit int form in the body', async () => {
    const cap: { opts?: any; body?: string[] } = {};
    stubHttps(200, okText, cap);
    await coindcxPrivateGET('/x', 'K', 'S', {}, { unit: 's', tsType: 'num' });
    expect(cap.opts.path).toBe('/x'); // still nothing in the query
    const ts = (JSON.parse(cap.body![0]) as { timestamp: number }).timestamp;
    expect(String(ts)).toMatch(/^\d{10}$/);
    const expected = crypto.createHmac('sha256', 'S').update(cap.body![0]).digest('hex');
    expect(cap.headers['X-AUTH-SIGNATURE']).toBe(expected);
  });

  it('body mode + tsType str signs {"timestamp":"<ms-string>"} in the body', async () => {
    const cap: { opts?: any; body?: string[] } = {};
    stubHttps(200, okText, cap);
    await coindcxPrivateGET('/x', 'K', 'S', {}, { unit: 'ms', tsType: 'str' });
    const ts = (JSON.parse(cap.body![0]) as { timestamp: string }).timestamp;
    expect(String(ts)).toMatch(/^\d{13}$/);
    const expected = crypto.createHmac('sha256', 'S').update(cap.body![0]).digest('hex');
    expect(cap.headers['X-AUTH-SIGNATURE']).toBe(expected);
  });

  it('body mode + sep spaced signs {"timestamp": <int>} with Python json.dumps spacing in the body', async () => {
    const cap: { opts?: any; body?: string[] } = {};
    stubHttps(200, okText, cap);
    await coindcxPrivateGET('/x', 'K', 'S', {}, { sep: 'spaced' });
    // body literally contains ': ' after the key — json.dumps default
    expect(cap.body![0]).toMatch(/^\{"timestamp": \d+\}$/);
    const expected = crypto.createHmac('sha256', 'S').update(cap.body![0]).digest('hex');
    expect(cap.headers['X-AUTH-SIGNATURE']).toBe(expected);
  });

  it('body mode: [401] error surfaces with the status prefix (the live incident shape)', async () => {
    stubHttps(401, JSON.stringify({ message: 'Invalid credentials' }));
    await expect(coindcxPrivateGET('/x', 'K', 'S', {})).rejects.toThrow('[401] Invalid credentials');
  });

  it('body mode: a network error rejects (timeout path)', async () => {
    httpsRequestMock.mockImplementationOnce(((opts: any, _cb: any) => {
      const req = {
        on: (ev: string, fn: (e: Error) => void) => { if (ev === 'error') setTimeout(() => fn(new Error('socket hang up')), 0); },
        write: () => {},
        end: () => {},
        destroy: vi.fn(),
      };
      return req;
    }) as any);
    await expect(coindcxPrivateGET('/x', 'K', 'S', {})).rejects.toThrow('socket hang up');
  });

  it('THE LIVE-401 REGRESSION: pre-v12.3 wire (query params, empty body) is now reachable ONLY via mode:"query" on the fetch transport', async () => {
    fetchMock.mockImplementationOnce(async () => okJson([]));
    await coindcxPrivateGET('/x', 'K', 'S', {}, { mode: 'query', unit: 's', tsType: 'str' });
    expect(httpsRequestMock).not.toHaveBeenCalled(); // query mode never rides https
    const [url, opts] = fetchMock.mock.calls[0];
    const u = new URL(String(url));
    // legacy wire: timestamp + params in the query, NOTHING in the body
    const ts = u.searchParams.get('timestamp');
    expect(ts).toMatch(/^\d{10}$/);
    expect(opts.body).toBeUndefined();
    expect(opts.headers['Content-Type']).toBeUndefined();
    const expected = crypto.createHmac('sha256', 'S').update(JSON.stringify({ timestamp: ts })).digest('hex');
    expect(opts.headers['X-AUTH-SIGNATURE']).toBe(expected);
  });

  it('query mode: signs extra params into the same compact JSON and the query string (v10.3.2-v12.2 contract)', async () => {
    fetchMock.mockImplementationOnce(async () => okJson({ wallets: [] }));
    await coindcxPrivateGET('/x/y', 'K', 'S', { page: '1' }, { mode: 'query', unit: 's', tsType: 'str' });
    const [url, opts] = fetchMock.mock.calls[0];
    const u = new URL(String(url));
    const ts = u.searchParams.get('timestamp');
    expect(u.searchParams.get('page')).toBe('1');
    expect(opts.body).toBeUndefined();
    const expected = crypto.createHmac('sha256', 'S').update(JSON.stringify({ page: '1', timestamp: ts })).digest('hex');
    expect(opts.headers['X-AUTH-SIGNATURE']).toBe(expected);
  });

  it('query mode: tsType num signs {"timestamp":<int>} — the digits stay in the query', async () => {
    fetchMock.mockImplementationOnce(async () => okJson([]));
    await coindcxPrivateGET('/x', 'K', 'S', {}, { mode: 'query', unit: 'ms', tsType: 'num' });
    const [url, opts] = fetchMock.mock.calls[0];
    const ts = new URL(String(url)).searchParams.get('timestamp');
    expect(ts).toMatch(/^\d{13}$/);
    const expected = crypto.createHmac('sha256', 'S').update(JSON.stringify({ timestamp: Number(ts) })).digest('hex');
    expect(opts.headers['X-AUTH-SIGNATURE']).toBe(expected);
    expect(opts.body).toBeUndefined();
  });

  it('query mode: surfaces [status] message errors like the POST transport (the [404] not_found case)', async () => {
    fetchMock.mockImplementationOnce(async () => ({
      ok: false, status: 404,
      json: async () => ({ message: 'not_found' }),
      text: async () => JSON.stringify({ message: 'not_found' }),
    }));
    await expect(coindcxPrivateGET('/x', 'K', 'S', {}, { mode: 'query' })).rejects.toThrow('[404] not_found');
  });

  it('query mode: tolerates plain-text error bodies', async () => {
    fetchMock.mockImplementationOnce(async () => ({
      ok: false, status: 401,
      json: async () => { throw new Error('not json'); },
      text: async () => 'Unauthorized',
    }));
    await expect(coindcxPrivateGET('/x', 'K', 'S', {}, { mode: 'query' })).rejects.toThrow('[401] CoinDCX API 401');
  });
});
