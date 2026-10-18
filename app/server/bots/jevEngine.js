// ============================================================
// server/bots/jevEngine.js — Jev Bot Lab v21.14.0
// ------------------------------------------------------------
// Jev (TypeSafe System One) client — plan §8, contract-faithful:
//
//   POST <provider-url>            (default https://api.typesafe.ai/v1/systemone;
//                                    JEV_BASE_URL override bhi chalega)
//   { [model], state, questions: { action: {type:'choice',...}, ... } }
//   -> { answers: { action: { choice, confidence, probabilities } }, usage }
//
// DECISION RULES (plan §8.2 — code-enforced, not prompt-enforced):
//   • chosen = answers.action.choice
//   • p = probabilities[chosen]          <- gate on THIS, NOT
//     `confidence` (repo found confidence inversely correlated
//     with outcome in one case — probabilities[chosen] is the
//     honest number)
//   • entry needs p >= threshold (default 0.30, sweep 0.20-0.60)
//   • chosen != proposed side -> WAIT (side flip KABHI nahi)
//   • parse/timeout/error -> WAIT (fallback). 'rule' fallback only
//     via conscious config.
//   • Jev only ever sees ENTRY decisions on flat positions.
//
// Ops (plan §8.3 + llmSentinel pattern):
//   • JSONL response cache keyed by sha256(payload) — backtests
//     cost cents, replays cost nothing
//   • retry w/ exponential backoff on 429/5xx/network only
//   • BREAKER: after `breakerThreshold` consecutive failures Jev
//     is marked down for `breakerCooldownMs` — no timeout storms
//   • stats: calls, cacheHits, errors, latency p50/p95, usage
//
// v21.5.0 speed knobs (ab generic engine features, v21.14 me Laya
// removal ke baad bhi available):
//   • `concurrency` (JEV_CONCURRENCY, default 0 = unlimited): provider
//     instance ke andar FIFO semaphore — bursts me top-scored signal
//     pehle server pakadta hai, har request ko queue ke BAAD apna pura
//     timeout budget milta hai.
//   • `retryOnTimeout` (JEV_RETRY_ON_TIMEOUT, default ON): timeout pe
//     retry queue line lambi kar sakta hai — slow providers ke liye OFF
//     karo. Timeout honest `timeout` note deta hai.
// ============================================================
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

// v21.1.0 (Phase-3, MaxListeners fix): createJev() factory HAR call pe
// process pe ek naya 'exit' listener add karta tha — server me single use
// the, par lab scripts (botlab-smoke/backtest/calibrate) + test suites me
// 11+ instances ban-te the → MaxListenersExceededWarning + hidden leak.
// Ab EK module-level listener saare live instances ke flushers chalata hai.
// v21.1.2 (report-1.4, cross-registry hardening): module-scoped armed flag
// vitest file-isolation me HAR test file ke liye reset ho jaata tha, jabki
// `process` shared rehta hai (fileParallelism:false = ek hi worker) — har
// file jo createJev tak pahunchti thi ek aur process 'exit' listener add
// karti thi. Ab flusher-Set + armed-flag dono globalThis par rehte hain:
// ek hi listener, chahe module kitni baar bhi re-instantiate ho.
const _G = globalThis;
const _jevFlushers = (_G.__smartaiJevFlushers ??= new Set());
function _armJevExitHook() {
  if (_G.__smartaiJevExitHookArmed) return;
  _G.__smartaiJevExitHookArmed = true;
  process.once('exit', () => {
    for (const flush of _jevFlushers) {
      try { flush(); } catch { /* never fatal */ }
    }
    _jevFlushers.clear();
  });
}

export const JEV_URL = 'https://api.typesafe.ai/v1/systemone';

/** base-URL -> full systemone endpoint resolver.
 * `JEV_BASE_URL=https://api.typesafe.ai` chalega; jo base pehle se
 * `/v1/systemone` pe khatam hota hai use as-is accept karte hain
 * (full-endpoint override bhi valid hai). */
export function resolveProviderEndpoint(base) {
  const b = String(base || '').replace(/\/+$/, '');
  return b.endsWith('/v1/systemone') ? b : `${b}/v1/systemone`;
}

const hostOf = (u) => { try { return new URL(u).host; } catch { return String(u || '').slice(0, 40); } };

export const JEV_DEFAULTS = {
  model: 'jev-latest',
  threshold: 0.30,
  cachePath: 'cache/jev_cache.jsonl',
  timeoutMs: 4000,
  retries: 3,
  fallback: 'wait',            // 'wait' | 'rule'
  breakerThreshold: 4,         // consecutive fails -> open breaker
  breakerCooldownMs: 10 * 60 * 1000,
  maxCacheEntries: 20000,
};

/** per-provider env config (v21.14: sirf jev — Laya provider removed).
 * `jevConfig` wrapper purani API ke liye rakha gaya hai (back-compat). */
export function providerConfig(_name = 'jev', env = process.env) {
  return {
    ...JEV_DEFAULTS,
    name: 'jev',
    url: env.JEV_URL || resolveProviderEndpoint(env.JEV_BASE_URL || 'https://api.typesafe.ai'),
    model: env.JEV_MODEL || JEV_DEFAULTS.model,
    threshold: numOr(env.JEV_THRESHOLD, JEV_DEFAULTS.threshold),
    fallback: env.JEV_FALLBACK === 'rule' ? 'rule' : 'wait',
    apiKey: env.TYPESAFE_API_KEY || '',
    timeoutMs: numOr(env.JEV_TIMEOUT_MS, JEV_DEFAULTS.timeoutMs),
    retries: numOr(env.JEV_RETRIES, JEV_DEFAULTS.retries),
    // concurrency 0 = unlimited; timeout-retry ON (default)
    concurrency: numOr(env.JEV_CONCURRENCY, 0),
    retryOnTimeout: String(env.JEV_RETRY_ON_TIMEOUT ?? '1') !== '0',
  };
}

/** Env-driven Jev config (purani API — unchanged behaviour). */
export function jevConfig(env = process.env) {
  return providerConfig('jev', env);
}

function numOr(v, d) { const n = Number(v); return Number.isFinite(n) ? n : d; }

/** v21.5.0: AbortSignal.timeout() failures pehchano — undici TimeoutError
 * DOMException (name 'TimeoutError', msg "...aborted due to timeout") deta
 * hai; kuch versions cause-chain me AbortError rakhte hain. Name + message
 * dono se pakadte hain (false-positive sirf manual AbortError pe — jo abhi
 * is codebase me koi call-site nahi banata). */
function _isTimeoutErr(e) {
  if (!e) return false;
  const names = [e?.name, e?.cause?.name, e?.cause?.cause?.name];
  if (names.some((n) => n === 'TimeoutError' || n === 'AbortError')) return true;
  return /(?:operation was aborted|signal timed out|aborted due to timeout)/i.test(String(e?.message || ''));
}

const keyOf = (p) => crypto.createHash('sha256').update(JSON.stringify(p)).digest('hex').slice(0, 32);

/** Build the exact payload the provider expects from a snapshot + prompt.
 * falsy `model` -> field OMIT (payload-shape compat —
 * `model:"jev-latest"` bhejne pe 422 aa sakta hai jab tak T1 verify na ho). */
export function buildPayload({ model, snap, prompt }) {
  const out = {
    state: (snap.contextLines || []).join('\n'),
    questions: {
      action: { type: 'choice', instructions: prompt.instructions, criteria: prompt.criteria },
      ...(prompt.extra || {}),
    },
  };
  if (model) out.model = model;
  return out;
}

/**
 * Create a Jev decider. `decide(snap, prompt)` -> verdict object.
 * @param {object} opts JEV_DEFAULTS overrides + apiKey + fetchImpl
 *   (tests inject fetchImpl; production uses global fetch)
 */
export function createJev(opts = {}) {
  const cfg = { name: 'jev', ...JEV_DEFAULTS, ...opts };
  const name = String(cfg.name || 'jev');
  const url = cfg.url || JEV_URL;                  // v21.2.0: provider endpoint override
  const apiKey = cfg.apiKey || '';
  const doFetch = cfg.fetchImpl || ((...a) => fetch(...a));
  const cache = new Map();
  let cacheDirty = false;

  // ---- load cache (best-effort) ----
  const _cacheFile = () => cfg.cachePath;
  try {
    if (cfg.cachePath && fs.existsSync(cfg.cachePath)) {
      const lines = fs.readFileSync(cfg.cachePath, 'utf8').split('\n');
      for (const line of lines) {
        const s = line.trim();
        if (!s) continue;
        try {
          const r = JSON.parse(s);
          if (r?.key && r?.response) cache.set(r.key, r.response);
        } catch { /* skip corrupt line */ }
      }
    }
  } catch { /* read-only fs etc: cache is an optimization, not a dependency */ }

  const stats = {
    calls: 0, cacheHits: 0, errors: 0, rejects: 0,
    latencies: [], usage: { inputTokens: 0, outputTokens: 0 },
    breaker: { fails: 0, openedAt: null, trips: 0 },
  };
  // v21.5.0: FIFO concurrency gate — sirf WIRE calls pe lagta
  // hai (cache-hits turant bypass). Telemetry stats.queueWaits me dikhta hai.
  let _queueWaits = 0;
  const _acquire = (() => {
    const max = Number(cfg.concurrency);
    if (!Number.isFinite(max) || max <= 0) return null; // unlimited (cloud)
    let active = 0;
    const waiters = [];
    return () => new Promise((grant) => {
      const start = () => {
        active++;
        grant(() => { active--; const next = waiters.shift(); if (next) next(); });
      };
      if (active < max) start();
      else { _queueWaits++; waiters.push(start); }
    });
  })();
  const pushLat = (ms) => {
    stats.latencies.push(ms);
    if (stats.latencies.length > 500) stats.latencies.shift();
  };
  const pct = (q) => {
    if (!stats.latencies.length) return null;
    const s = [...stats.latencies].sort((a, b) => a - b);
    return s[Math.min(s.length - 1, Math.floor(q * s.length))];
  };

  const breakerOpen = () => {
    if (stats.breaker.openedAt == null) return false;
    if (Date.now() - stats.breaker.openedAt >= cfg.breakerCooldownMs) {
      stats.breaker.openedAt = null; stats.breaker.fails = 0; // half-open: retry
      return false;
    }
    return true;
  };
  const breakerFail = () => {
    stats.breaker.fails++;
    if (stats.breaker.fails >= cfg.breakerThreshold) {
      stats.breaker.openedAt = Date.now();
      stats.breaker.trips++;
    }
  };
  const breakerOk = () => { stats.breaker.fails = 0; stats.breaker.openedAt = null; };

  async function post(payload) {
    // v21.5.0: local provider ke liye timeout retry-able NAHI hai (wo
    // single-worker server ki line aur lambi karta hai). Cloud (jev) ka
    // purana behaviour (timeout bhi retry) unchanged — cfg.retryOnTimeout.
    const retryOnTimeout = cfg.retryOnTimeout !== false;
    for (let i = 0; i <= cfg.retries; i++) {
      try {
        const r = await doFetch(url, {
          method: 'POST',
          headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(cfg.timeoutMs),
        });
        if (r.status === 429 || r.status >= 500) throw Object.assign(new Error(`HTTP ${r.status}`), { retryable: true, status: r.status });
        if (!r.ok) return { ok: false, fatal: true, status: r.status };  // 4xx won't heal by retrying
        const j = await r.json();
        return { ok: true, json: j };
      } catch (e) {
        // v21.2.0 (dual-provider): 5xx retry-exhaustion par status saath
        // lautta hai — decide() `http_5xx` note bana paata hai (auto-arm
        // failover usi pe trigger hota hai; generic network_error nahi).
        const timedOut = _isTimeoutErr(e);
        const msg = timedOut ? 'timeout' : String(e?.message || e);
        if (timedOut && !retryOnTimeout) return { ok: false, error: msg, status: e?.status };
        if (i === cfg.retries) return { ok: false, error: msg, status: e?.status };
        await new Promise((res) => setTimeout(res, 300 * 2 ** i));
      }
    }
    return { ok: false, error: 'unreachable' };
  }

  function persistCache() {
    if (!cacheDirty || !cfg.cachePath) return;
    try {
      fs.mkdirSync(path.dirname(cfg.cachePath), { recursive: true });
      // rewrite bounded (Map preserves insertion; drop oldest beyond cap)
      const entries = Array.from(cache.entries()).slice(-cfg.maxCacheEntries);
      // v20.9.1 [L]: ATOMIC write (tmp + rename) — repo-wide convention hai;
      // direct writeFileSync crash-mid-write pe corrupt JSONL chhod deta
      // tha (loader bad lines skip karta hai, par purane verdicts silently
      // jaate the + agle writes bhi fail ho sakte the partial line pe).
      const tmp = `${cfg.cachePath}.tmp-${process.pid}`;
      fs.writeFileSync(tmp, entries.map(([k, v]) => JSON.stringify({ key: k, response: v })).join('\n') + '\n');
      fs.renameSync(tmp, cfg.cachePath);
      cacheDirty = false;
    } catch { /* cache write failure must never break trading */ }
  }

  // v20.8.1 FIX (H3 — event-loop): the full cache file (up to 20k
  // entries, potentially MBs) was rewritten SYNCHRONOUSLY on every
  // successful Jev call. Persistence is now debounced (30s dirty
  // timer + flush on break) — the hot path stays non-blocking.
  let _persistTimer = null;
  const persistCacheDebounced = () => {
    if (_persistTimer != null) return;
    _persistTimer = setTimeout(() => {
      _persistTimer = null;
      persistCache();
    }, 30_000);
    if (typeof _persistTimer.unref === 'function') _persistTimer.unref();
  };
  // v20.8.4 FIX (L — flush-on-exit): the debounce comment promised "flush
  // on break" but no shutdown hook ever existed — the last ≤30s of cache
  // entries were lost on every exit (re-fetched at real cost on restart).
  // v21.1.0: instance-level listener ke bajaye module-level registry me
  // apna flusher register karo (upar _armJevExitHook dekho) — listener
  // count ab instance count se independent hai.
  _jevFlushers.add(() => {
    try {
      if (_persistTimer != null) { clearTimeout(_persistTimer); _persistTimer = null; }
      if (cacheDirty) persistCache();
    } catch { /* never fatal */ }
  });
  _armJevExitHook();

  /**
   * THE DECIDER. snap: { proposed: 'enter_long'|'enter_short',
   * contextLines, features }. prompt: strategy.jevPrompt().
   */
  async function decide(snap, prompt) {
    const payload = buildPayload({ model: cfg.model, snap, prompt });
    // v21.2.0 (dual-provider): cache key ab provider-aware hai — same
    // payload provider/name (ya model '' vs 'english') ke liye alag key.
    const key = keyOf({ provider: name, model: cfg.model || '', payload });
    const t0 = Date.now();

    // ---- breaker: fail fast while Jev is down ----
    if (breakerOpen()) {
      return { action: cfg.fallback === 'rule' ? snap.proposed : 'wait', note: 'breaker_open', cached: false, latencyMs: 0 };
    }

    let resp = cache.get(key);
    const cached = !!resp;
    const wire = !resp;
    if (!resp) {
      if (!apiKey) {
        // No key configured: WAIT with an explicit note. A missing key is
        // NOT a signal to trade (plan: koi parse/timeout/error -> WAIT).
        return { action: 'wait', note: 'no_api_key', cached: false, latencyMs: 0 };
      }
      stats.calls++;
      // v21.5.0: wire call semaphore ke PEECHHE — queued request ko apna
      // PURA timeout budget milta hai (queue-wait se timeout kha peelna
      // khatam). Cache-hit upar se hi bypass ho chuka hai.
      const release = _acquire ? await _acquire() : null;
      let r;
      try { r = await post(payload); }
      finally { if (release) { try { release(); } catch { /* never fatal */ } } }
      if (!r.ok) {
        stats.errors++;
        // v21.2.0 (dual-provider plan Step-1.4 — BREAKER FIX): HTTP 4xx
        // provider-DOWN nahi hai. Ek lambi chali hui state / null-score
        // level 400/422 de sakti hai — breaker usse 10 min ke liye band
        // kar deta tha (failover ko bhi roka jaata tha). Ab 4xx sirf
        // `rejects` counter + note; breaker sirf 5xx/429/network pe.
        if (r.fatal) {
          stats.rejects++;
        } else {
          breakerFail();
        }
        const note = r.fatal
          ? `http_${r.status}`
          : (Number(r.status) >= 500 ? `http_${r.status}` : (r.error === 'timeout' ? 'timeout' : 'network_error'));
        return {
          action: cfg.fallback === 'rule' ? snap.proposed : 'wait',
          note,
          cached: false, latencyMs: Date.now() - t0,
        };
      }
      resp = r.json;
      // v20.8.1 FIX (M): only WELL-FORMED responses are cached — a
      // garbage-but-200 body used to be served from cache on every
      // identical future payload (a permanent no_answer wait).
      const a0 = resp?.answers?.action;
      const p0 = a0?.probabilities?.[a0?.choice];
      const wellFormed = !!a0?.choice && Number.isFinite(Number(p0));
      if (wellFormed) {
        cache.set(key, resp);
        // v20.8.2 FIX (M — the Map trim was a placebo): __trim existed but
        // NOTHING called it in the hot path (only the file write was
        // bounded) — the in-memory Map grew without limit in a
        // long-lived process.
        trimCache();
        cacheDirty = true;
        persistCacheDebounced();
      }
      breakerOk();
      const u = resp?.usage;
      if (u) {
        stats.usage.inputTokens += Number(u.input_tokens || 0) || 0;
        stats.usage.outputTokens += Number(u.output_tokens || 0) || 0;
      }
    } else {
      stats.cacheHits++;
    }
    // v20.8.1 FIX (M): latency stats only for WIRE calls — ~0ms cache
    // hits used to skew p50/p95 toward zero.
    if (wire) pushLat(Date.now() - t0);

    // ---- decision rules (plan §8.2, code-enforced) ----
    const a = resp?.answers?.action;
    if (!a?.choice) {
      // v20.8.1 FIX (M): malformed answers count as breaker failures —
      // a persistently broken endpoint must trip the breaker, not fail
      // silently forever.
      breakerFail();
      return { action: 'wait', note: 'no_answer', probs: a?.probabilities || null, cached, latencyMs: Date.now() - t0 };
    }
    const p = Number(a.probabilities?.[a.choice] ?? NaN);
    if (!Number.isFinite(p)) {
      breakerFail();
      return { action: 'wait', note: 'no_probability', probs: a.probabilities || null, cached, latencyMs: Date.now() - t0 };
    }

    if (a.choice !== 'wait') {
      // gate on probabilities[chosen], NOT confidence (plan §1)
      if (p < cfg.threshold) {
        // v21.11 (decision transparency): `picked` = the model's RAW
        // choice — board confirm layer isse UI tak pahunchata hai ("Jev
        // ○ SHORT-lean 29%" — kabhi ka '○' sirf abstain nahi tha, side
        // pata hi nahi chalti thi). action 'wait' hi rehta hai — trading
        // contract (no-flip) untouched.
        return { action: 'wait', picked: a.choice, note: `below_threshold(${p.toFixed(2)})`, probs: a.probabilities, confidence: a.confidence, cached, latencyMs: Date.now() - t0 };
      }
      // side flip is BANNED: Jev disagreeing with the proposed side = WAIT
      if (a.choice !== snap.proposed) {
        // v21.11: `picked` = the ULTA side the model actually chose —
        // confirm layer isse DISAGREE + direction ke saath surface karta
        // hai. Trading decision phir bhi WAIT hi hai (no-flip contract).
        return { action: 'wait', picked: a.choice, note: 'disagreed_side', probs: a.probabilities, confidence: a.confidence, cached, latencyMs: Date.now() - t0 };
      }
    }
    return {
      action: a.choice,
      probs: a.probabilities,
      confidence: a.confidence,
      aux: resp.answers,
      cached,
      latencyMs: Date.now() - t0,
    };
  }

  decide.stats = () => ({
    ...stats,
    latencies: undefined,
    name,                                     // provider name ('jev')
    url: hostOf(url),                         // host only — full URL/keys kabhi expose nahi
    p50: pct(0.5), p95: pct(0.95),
    cacheSize: cache.size,
    breakerOpen: breakerOpen(),
    threshold: cfg.threshold,
    model: cfg.model,
    fallback: cfg.fallback,
    hasKey: !!apiKey,
    queueWaits: _queueWaits,                   // v21.5.0: semaphore telemetry
    concurrency: Number(cfg.concurrency) || 0, // 0 = unlimited
  });
  decide.config = () => ({ ...cfg, name, url, apiKey: apiKey ? '***' : '' });
  decide.__cache = cache;   // test hook
  decide.__breakerFail = breakerFail; // test hook
  decide.__persist = persistCache;
  // v20.8.1 FIX (M): the in-memory Map is TRIMMED beyond the cap (only
  // the file write was bounded before — slow memory growth in a
  // long-lived process). v20.8.2 FIX (M): now actually CALLED on every
  // cache.set (see trimCache() above).
  const trimCache = () => {
    if (cache.size > cfg.maxCacheEntries) {
      const excess = cache.size - cfg.maxCacheEntries;
      const it = cache.keys();
      for (let i = 0; i < excess; i++) { const k = it.next().value; cache.delete(k); }
    }
  };
  decide.__trim = trimCache;
  return decide;
}

/**
 * JEV PING (plan §4.2 smoke): one real call, full response printed.
 * url/model/name override.
 */
export async function jevPing({ apiKey, url, model, name = 'jev_ping', fetchImpl } = {}) {
  const key = apiKey || process.env.TYPESAFE_API_KEY || '';
  const endpoint = url || JEV_URL;
  if (!key) return { name, status: 'SKIPPED', reason: 'no API key configured' };
  const doFetch = fetchImpl || ((...a) => fetch(...a));
  const t0 = Date.now();
  try {
    const body = {
      state: 'Test: NIFTY broke above the 15-minute opening range with volume 1.4x average. ATR range 0.9. Trend up.',
      questions: {
        action: {
          type: 'choice',
          instructions: 'Should the breakout long be taken?',
          criteria: { enter_long: 'Take the long breakout', wait: 'Stand aside' },
        },
      },
    };
    if (model) body.model = model;
    const r = await doFetch(endpoint, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(8000),
    });
    const j = await r.json().catch(() => null);
    return {
      name, status: r.ok ? 'PASS' : 'FAIL',
      http: r.status, latencyMs: Date.now() - t0,
      choice: j?.answers?.action?.choice ?? null,
      probabilities: j?.answers?.action?.probabilities ?? null,
      usage: j?.usage ?? null,
    };
  } catch (e) {
    return { name, status: 'FAIL', error: String(e?.message || e), latencyMs: Date.now() - t0 };
  }
}
