// ============================================================
// server/bots/core/dhanFetch.js — Jev Bot Lab v20.8.0
// ------------------------------------------------------------
// Plan §4.1/§5: Dhan v2 intraday chart fetcher.
//   • POST https://api.dhan.co/v2/charts/intraday
//   • 5 requests/second throttle (docs+forum agreed; older docs
//     said 1/s — throttle is configurable, default conservative)
//   • date range chunked to <=90 days per call (docs cap; actual
//     cap discovered at runtime is logged by the smoke test)
//   • retry with exponential backoff on 429/5xx/network
//   • v2 timestamps are plain UNIX seconds — normalized to ms here
// Credentials come from dhan.js creds (env DHAN_CLIENT_ID /
// DHAN_ACCESS_TOKEN) — keys NEVER leave the server.
// ============================================================
import { dhanCreds, dhanConnected } from '../../ai/dhan.js';
import { normBar } from './candleStore.js';

const DHAN_CHART_URL = 'https://api.dhan.co/v2/charts/intraday';

export function dhanRateLimitPerSec(env = process.env) {
  const n = Number(env.DHAN_RATE_LIMIT_PER_SEC);
  return Number.isFinite(n) && n > 0 ? n : 5;
}

// -------- shared throttle (module-level, all callers) --------
// v20.8.1 FIX (H1 — empirically proven burst): every throttled() call
// invoked _pump(), and each pump scheduled its OWN timer computed from
// the SAME _lastCallAt — N concurrent callers dispatched N requests in
// ~0ms, blowing the documented 5 rps Dhan limit. Now a single pending
// timer guards the chain.
let _lastCallAt = 0;
let _timer = null;
const _queue = [];
function _pump() {
  if (_timer != null || _queue.length === 0) return;
  const gap = 1000 / dhanRateLimitPerSec();
  const wait = Math.max(0, _lastCallAt + gap - Date.now());
  _timer = setTimeout(() => {
    _timer = null;
    const run = _queue.shift();
    _lastCallAt = Date.now();
    if (run) run();
    _pump();
  }, wait);
}
function throttled() {
  return new Promise((resolve) => { _queue.push(resolve); _pump(); });
}

/** v20.9.0 (M6 — audit): Dhan v2 intraday docs `YYYY-MM-DD HH:MM:SS`
 *  dikhate hain; code pehle date-only bhejta tha. Date-only me
 *  `toDate` ka din EXCLUDE hone ka risk tha (har 90-din chunk ka
 *  aakhri din gayab — audit ka "verify karo" item; live creds ke
 *  bina confirm nahi ho sakta). ROBUST approach: datetime-with-session
 *  FIRST (09:15:00 / 15:30:00 IST bounds), aur agar API us format ko
 *  reject kare (4xx) ya ZERO bars de, to ek baar date-only fallback
 *  + note. Env se pin bhi kar sakte ho: DHAN_DATE_FORMAT=|datetime|date
 *  (auto = default). */
export function dhanChunkDates({ fromDate, toDate, mode = 'auto' }) {
  const f = String(fromDate || '').slice(0, 10);
  const t = String(toDate || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(f) || !/^\d{4}-\d{2}-\d{2}$/.test(t)) return null;
  if (mode === 'date') return { fromDate: f, toDate: t };
  // datetime + NSE session bounds (IST wall-clock, jo Dhan expect karta hai)
  return { fromDate: `${f} 09:15:00`, toDate: `${t} 15:30:00` };
}

export function dhanDateFormat(env = process.env) {
  const v = String(env.DHAN_DATE_FORMAT || 'auto').trim().toLowerCase();
  return ['auto', 'datetime', 'date'].includes(v) ? v : 'auto';
}

/**
 * Fetch ONE chunk of Dhan intraday candles.
 * v20.9.0 (M6): datetime-with-session default + ONE date-only fallback
 * attempt when the strict format is rejected/empty (auto mode only).
 * @returns {Promise<{ok, status?, bars?, error?, note?}>}
 */
export async function fetchDhanIntradayChunk({ securityId, exchangeSegment, instrument, interval = '5', fromDate, toDate, creds = null, timeoutMs = 12000, _dateMode = null }) {
  const c = creds || dhanCreds();
  if (!c?.clientId || !c?.accessToken) return { ok: false, error: 'no_dhan_creds' };
  const mode = _dateMode || dhanDateFormat();
  const dates = dhanChunkDates({ fromDate, toDate, mode: mode === 'date' ? 'date' : 'datetime' })
    || { fromDate, toDate };
  const body = {
    securityId: String(securityId),
    exchangeSegment: String(exchangeSegment),
    instrument: String(instrument),
    interval: String(interval),
    oi: false,
    fromDate: dates.fromDate, toDate: dates.toDate,
  };
  try {
    const r = await fetch(DHAN_CHART_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'access-token': c.accessToken,
        'client-id': c.clientId,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (r.status === 429 || r.status >= 500) {
      // v20.8.1 FIX (M): honor Retry-After + add jitter
      const ra = Number(r.headers?.get?.('retry-after'));
      const waitMs = Number.isFinite(ra) && ra > 0 ? ra * 1000 : 400 * (1 + Math.random());
      return { ok: false, status: r.status, retryable: true, error: `HTTP ${r.status}`, retryAfterMs: waitMs };
    }
    if (!r.ok) {
      // v20.9.0 (M6): datetime format reject hua → date-only fallback
      // (sirf auto mode me, aur sirf EK baar — loop nahi).
      if (mode === 'auto') {
        return fetchDhanIntradayChunk({ securityId, exchangeSegment, instrument, interval, fromDate, toDate, creds: c, timeoutMs, _dateMode: 'date' })
          .then((res) => ({ ...res, note: 'datetime format rejected (HTTP ' + r.status + ') — retried date-only' }));
      }
      return { ok: false, status: r.status, error: `HTTP ${r.status}` };
    }
    const j = await r.json();
    const ts = Array.isArray(j.timestamp) ? j.timestamp : [];
    if (!ts.length) {
      // v20.9.0 (M6): datetime format OK-tha-par-zero-bars — kai APIs
      // strict end-bound ko exclude karte hain; date-only ek baar try.
      if (mode === 'auto' && interval !== '1') {
        const retry = await fetchDhanIntradayChunk({ securityId, exchangeSegment, instrument, interval, fromDate, toDate, creds: c, timeoutMs, _dateMode: 'date' });
        if (retry.ok && retry.bars?.length) return { ...retry, note: 'datetime gave 0 bars — date-only worked' };
      }
      return { ok: true, bars: [], notes: { keys: Object.keys(j), dateMode: mode } };
    }
    const bars = [];
    for (let i = 0; i < ts.length; i++) {
      // v2: UNIX SECONDS. Defensive: some v1 pairs returned ms —
      // normalize both (plan §1: "parse karte waqt verify karo").
      let t = Number(ts[i]);
      if (!Number.isFinite(t)) continue;
      if (t > 1e12) t = Math.floor(t / 1000) * 1000; else t = t * 1000;
      const b = normBar({
        time: t,
        open: j.open?.[i], high: j.high?.[i], low: j.low?.[i],
        close: j.close?.[i], volume: j.volume?.[i],
      });
      if (b) bars.push(b);
    }
    bars.sort((a, b) => a.t - b.t);
    return { ok: true, bars, notes: { keys: Object.keys(j), dateMode: mode } };
  } catch (e) {
    return { ok: false, retryable: true, error: String(e?.message || e) };
  }
}

/** Chunk a [fromDate,toDate] range into <=chunkDays pieces (plan: 90). */
export function chunkRange(fromDate, toDate, chunkDays = 90) {
  const chunks = [];
  let a = new Date(`${fromDate}T00:00:00Z`);
  const b = new Date(`${toDate}T00:00:00Z`);
  if (Number.isNaN(a.getTime()) || Number.isNaN(b.getTime()) || b < a) return chunks;
  while (a <= b) {
    const end = new Date(a.getTime() + (chunkDays - 1) * 86400000);
    const stop = end < b ? end : b;
    chunks.push({ fromDate: a.toISOString().slice(0, 10), toDate: stop.toISOString().slice(0, 10) });
    a = new Date(stop.getTime() + 86400000);
  }
  return chunks;
}

/**
 * Fetch a full ranged history with throttle + retry/backoff.
 * @param {object} a securityId, exchangeSegment, instrument, interval,
 *   fromDate, toDate, retries=3, onProgress(chunkIdx,total,bars)
 * @returns {Promise<{ok, bars, errors}>}
 */
export async function fetchDhanHistory(a = {}) {
  const { securityId, exchangeSegment, instrument, interval = '5', fromDate, toDate,
    retries = 3, chunkDays = 90, onProgress = null } = a;
  const chunks = chunkRange(fromDate, toDate, chunkDays);
  if (!chunks.length) return { ok: false, bars: [], errors: ['bad_range'] };
  const bars = [];
  const errors = [];
  for (let ci = 0; ci < chunks.length; ci++) {
    const { fromDate: f, toDate: t } = chunks[ci];
    let res = null;
    for (let attempt = 0; attempt <= retries; attempt++) {
      await throttled();
      res = await fetchDhanIntradayChunk({ securityId, exchangeSegment, instrument, interval, fromDate: f, toDate: t });
      if (res.ok || !res.retryable) break;
      const base = res.retryAfterMs || 400 * 2 ** attempt;
      await new Promise(rr => setTimeout(rr, base * (0.8 + Math.random() * 0.4))); // backoff + jitter
    }
    if (res?.ok) {
      // v20.8.1 FIX (L): a 90-day 1-min chunk is ~34k elements — spread
      // args flirt with call-stack limits; push in a loop.
      for (const b of res.bars) bars.push(b);
    } else {
      errors.push(`${f}..${t}: ${res?.error || 'unknown'}`);
    }
    if (onProgress) onProgress(ci + 1, chunks.length, res?.bars?.length || 0);
  }
  return { ok: errors.length === 0, bars, errors };
}

/** Well-known security ids (plan §1 verified-facts table). */
export const DHAN_IDS = {
  NIFTY: { securityId: '13', exchangeSegment: 'IDX_I', instrument: 'INDEX' },
  BANKNIFTY: { securityId: '25', exchangeSegment: 'IDX_I', instrument: 'INDEX' },
  RELIANCE: { securityId: '2885', exchangeSegment: 'NSE_EQ', instrument: 'EQUITY' },
};

/** Phase 0 smoke: does 5-min data work, how far back, is IST parse right?
 *  v20.9.0 (M6): bar-count assertion — NSE 5-min session me ~75 bars/
 *  din hote hain; >= 70/session expected. Zyada kam = date-window ka
 *  aakhri din gayab ho raha hai (wahi bug jo ye fix pakadta hai). */
export async function smokeDhan5m({ fromDate, toDate } = {}) {
  const c = dhanCreds();
  if (!c?.clientId || !c?.accessToken) {
    return { name: 'dhan_5m', status: 'SKIPPED', reason: 'no DHAN_CLIENT_ID/DHAN_ACCESS_TOKEN (add creds to .env — Data APIs plan may be required)', connected: dhanConnected() };
  }
  const f = fromDate || isoDaysAgo(30);
  const t = toDate || new Date().toISOString().slice(0, 10);
  const r = await fetchDhanHistory({ ...DHAN_IDS.NIFTY, interval: '5', fromDate: f, toDate: t });
  if (!r.ok || !r.bars.length) {
    return { name: 'dhan_5m', status: 'FAIL', reason: r.errors.join('; ') || 'no bars', bars: 0 };
  }
  const first = new Date(r.bars[0].t);
  const last = new Date(r.bars[r.bars.length - 1].t);
  // v20.9.0 (M6): sessions estimate + per-session bar density check
  const days = Math.max(1, Math.round((last.getTime() - first.getTime()) / 86400000) * (5 / 7));
  const sessions = Math.max(1, Math.round(days));
  const barsPerSession = r.bars.length / sessions;
  const densityOk = barsPerSession >= 70;
  return {
    name: 'dhan_5m', status: densityOk ? 'PASS' : 'WARN',
    bars: r.bars.length, barsPerSession: Math.round(barsPerSession),
    densityCheck: densityOk ? 'ok (>=70/session)' : `LOW (${Math.round(barsPerSession)}/session) — last-day exclusion suspect?`,
    range: { from: f, to: t },
    firstBar: first.toISOString(), lastBar: last.toISOString(),
    istFirst: first.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }),
    errors: r.errors,
  };
}

export function isoDaysAgo(n) {
  return new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
}
