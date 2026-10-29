// Site API client. The server is the single source of truth: this bot never
// computes prices, portfolio values or signals locally.

import { truncate } from './util.mjs';

export class ApiError extends Error {
  constructor(message, { status = 0, kind = 'http', path = '', retryAfter = null, detail = null } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.kind = kind;
    this.path = path;
    this.retryAfter = retryAfter;
    this.detail = detail;
  }

  get userMessage() {
    if (this.kind === 'timeout') return 'Server ne time par jawab nahi diya. Thodi der baad try karo.';
    if (this.kind === 'network') return 'Server se connect nahi hua. Watchdog/server chal raha hai?';
    if (this.status === 401) return 'API auth fail (401). API_TOKEN server .env se match nahi kar raha.';
    if (this.status === 403) return 'API access denied (403).';
    if (this.status === 404) return 'Endpoint nahi mila (404). Server version check karo.';
    if (this.status === 429) return 'Server rate-limit (429). Thodi der baad try karo.';
    if (this.status >= 500) return `Server error (${this.status}). Logs check karo.`;
    if ((this.status === 400 || this.status === 409 || this.status === 422) && this.message) {
      return truncate(this.message, 300);
    }
    return this.status ? `API error (${this.status}).` : 'API request fail hui.';
  }
}

function buildQuery(query) {
  if (!query) return '';
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === '') continue;
    params.set(key, String(value));
  }
  const q = params.toString();
  return q ? `?${q}` : '';
}

class TtlCache {
  constructor() {
    this.entries = new Map();
  }

  async wrap(key, ttlMs, fn) {
    const entry = this.entries.get(key);
    if (entry?.hasValue && Date.now() - entry.at < ttlMs) return entry.value;
    if (entry?.pending) return entry.pending;
    const pending = Promise.resolve()
      .then(fn)
      .then((value) => {
        this.entries.set(key, { at: Date.now(), hasValue: true, value });
        return value;
      })
      .catch((error) => {
        this.entries.delete(key);
        throw error;
      });
    this.entries.set(key, { pending });
    return pending;
  }

  delete(key) {
    this.entries.delete(key);
  }

  clear() {
    this.entries.clear();
  }
}

export class SiteApi {
  constructor({ baseUrl, token, logger = null, fetchImpl = globalThis.fetch, defaultTimeoutMs = 40000 } = {}) {
    const base = String(baseUrl || '').trim().replace(/\/+$/, '');
    if (!/^https?:\/\//i.test(base)) {
      throw new Error('BOT_API_BASE_URL must start with http:// or https://');
    }
    if (typeof fetchImpl !== 'function') throw new Error('global fetch unavailable (Node 20+ required)');
    this.baseUrl = base;
    this.token = String(token || '').trim();
    this.logger = logger;
    this.fetchImpl = fetchImpl;
    this.defaultTimeoutMs = defaultTimeoutMs;
    this.cache = new TtlCache();
  }

  async request(path, { method = 'GET', body, query, timeoutMs, retries = 0 } = {}) {
    if (!String(path).startsWith('/')) throw new Error('API path must start with /');
    const url = `${this.baseUrl}${path}${buildQuery(query)}`;
    const timeout = Math.max(1000, Number(timeoutMs) || this.defaultTimeoutMs);
    const headers = { Accept: 'application/json' };
    if (this.token) headers.Authorization = `Bearer ${this.token}`;
    if (body !== undefined) headers['Content-Type'] = 'application/json';

    const attempts = Math.max(0, Number(retries) || 0) + 1;
    let lastError = null;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const started = Date.now();
      try {
        const response = await this.fetchImpl(url, {
          method,
          headers,
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: AbortSignal.timeout(timeout),
        });
        const raw = await response.text();
        let data = null;
        if (raw) {
          try { data = JSON.parse(raw); } catch { data = null; }
        }
        const ms = Date.now() - started;
        if (!response.ok) {
          const reason = data?.error?.message || data?.error || data?.reason || data?.message || null;
          throw new ApiError(
            reason ? String(reason) : `HTTP ${response.status}`,
            { status: response.status, kind: 'http', path, detail: data },
          );
        }
        if (this.logger) this.logger.debug('api ok', { method, path, status: response.status, ms });
        return data;
      } catch (error) {
        lastError = error instanceof ApiError
          ? error
          : new ApiError(error?.message || String(error), {
            kind: error?.name === 'TimeoutError' || error?.name === 'AbortError' ? 'timeout' : 'network',
            path,
          });
        const retryable = lastError.kind === 'network'
          || lastError.kind === 'timeout'
          || (lastError.status >= 500 && lastError.status < 600);
        if (!retryable || attempt === attempts - 1) break;
        await new Promise((resolve) => setTimeout(resolve, 400 * (attempt + 1)));
      }
    }
    if (this.logger) {
      this.logger.warn('api failed', {
        method,
        path,
        status: lastError?.status || 0,
        kind: lastError?.kind || 'error',
      });
    }
    throw lastError;
  }

  get(path, opts = {}) {
    return this.request(path, { ...opts, method: 'GET' });
  }

  post(path, body = {}, opts = {}) {
    return this.request(path, { ...opts, method: 'POST', body });
  }

  ping() {
    return this.get('/api/ping', { timeoutMs: 4000, retries: 1 });
  }

  health() {
    return this.get('/health', { timeoutMs: 10000, retries: 1 });
  }

  operationalHealth() {
    return this.get('/api/health', { timeoutMs: 15000 });
  }

  positions() {
    return this.get('/api/ai/positions', { timeoutMs: 20000 });
  }

  paper(market = null) {
    return this.get('/api/intraday-paper', {
      timeoutMs: 10000,
      query: market ? { market } : undefined,
    });
  }

  mtfAutoStatus() {
    return this.cache.wrap('mtf-auto', 8000, () => this.get('/api/ai/mtf-auto/status', { timeoutMs: 18000 }));
  }

  invalidateAuto() {
    this.cache.delete('mtf-auto');
  }

  toggleAuto(enabled) {
    this.invalidateAuto();
    return this.post('/api/ai/mtf-auto/toggle', { enabled: Boolean(enabled) }, { timeoutMs: 15000 });
  }

  setAutoConfig(patch) {
    this.invalidateAuto();
    return this.post('/api/ai/mtf-auto/config', patch || {}, { timeoutMs: 15000 });
  }

  pushStatus() {
    return this.get('/api/ai/insta-push/status', { timeoutMs: 8000, retries: 1 });
  }

  mtfBoard(market = 'CRYPTO', { fresh = false, mode = 'INTRADAY', limit = 8, timeoutMs = 90000 } = {}) {
    const path = '/api/ai/mtf-dual/board';
    const query = { market, mode, limit };
    if (fresh) query.fresh = '1';
    if (fresh) {
      return this.get(path, { query, timeoutMs });
    }
    const key = `${market}|${mode}|${limit}`;
    return this.cache.wrap(key, 20000, () => this.get(path, { query, timeoutMs }));
  }

  agent(desk, messages, { timeoutMs = 120000 } = {}) {
    const path = desk === 'india' ? '/api/intraday-agent' : '/api/crypto-agent';
    return this.post(path, { messages }, { timeoutMs });
  }

  weekly({ timeoutMs = 120000 } = {}) {
    return this.post('/api/ai/weekly-review', {}, { timeoutMs });
  }
}
