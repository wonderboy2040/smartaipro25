// ============================================================
// server/ai/bandwidth.js — B6 BANDWIDTH TELEMETRY
// ------------------------------------------------------------
// The Render free tier ships ~5GB/month of egress. The 2026 perf
// audits cut WHAT rides the wire (delta SSE, dead-tick filters,
// ETag 304s, idle backoff); this module makes the result MEASURABLE
// so the next fix is data-driven instead of dashboard-driven.
//
//   • trackBytes(scope, n)      — O(1) rolling accounting, hourly buckets
//   • bandwidthMiddleware()     — REST true wire bytes (socket bytesWritten
//                                 delta on 'finish' — real headers+body on
//                                 the wire, zero serialization cost)
//   • trackSseWrite(scope)      — wraps an SSE `write(payload)` helper so
//                                 every frame counts (string byteLength)
//   • bandwidthView()           — JSON view for GET /api/ai/bandwidth:
//                                 rolling 24h, 30d projection, cap %,
//                                 per-scope breakdown, verdict
//   • initBandwidthAlerts()     — hourly unref'd check; ONE Telegram alert
//                                 per day when the 30-day projection
//                                 crosses BANDWIDTH_ALERT_PCT (default 70)
//                                 of BANDWIDTH_MONTHLY_CAP_GB (default 5)
//
// Design notes:
//   - Hourly buckets (24) — cheap ring, self-expiring, survives without
//     persistence (a Render restart resets the clock; the projection
//     re-bases on whatever history it has, min 1h before projecting).
//   - REST via socket-bytesWritten delta: keep-alive sockets are
//     request-serial in practice (browsers open 1 in-flight request per
//     socket) — attribution is honest within a few percent, which is
//     exactly the resolution a 5GB/month decision needs.
//   - SSE frames are counted at the write site (Express compression
//     skips text/event-stream — Cache-Control: no-transform) so
//     byteLength(payload) IS the wire number.
// ============================================================

const HOUR_MS = 60 * 60 * 1000;

// v20.1 FIX (deep audit): the REST middleware keys scopes by the FULL
// req.path — parameterized routes (/api/fundamentals/:symbol etc.) mint
// a NEW scope per distinct symbol, and _scopes/_lifetime never prune
// themselves. A single client rotating symbols grows the Map-of-Maps
// for the whole process lifetime. Two-part fix:
//   1) _routeTemplateOf() collapses symbol-like path segments to ':p'
//      (all-caps alnum/dot/dash, 2-24 chars — NSE/BSE/CoinDCX symbols)
//   2) a hard LRU cap (200 scopes) as belt-and-suspenders — evicts the
//      smallest-lifetime scopes first, mirroring every other bounded
//      map in this repo.
const MAX_SCOPES = 200;
function _routeTemplateOf(path) {
  const p = String(path || '').split('?')[0];
  const segs = p.split('/').map(seg =>
    /^[A-Z0-9.\-_]{2,24}$/.test(seg) && /\d|[A-Z]{2}/.test(seg) && !['API', 'AI', 'AUTH'].includes(seg)
      ? ':p' : seg);
  const t = segs.join('/');
  return t === p ? p : t;
}
function _capScopes() {
  if (_scopes.size <= MAX_SCOPES) return;
  const ranked = [..._lifetime.entries()].sort((a, b) => (a[1] || 0) - (b[1] || 0));
  const drop = ranked.slice(0, _scopes.size - MAX_SCOPES);
  for (const [k] of drop) { _scopes.delete(k); _lifetime.delete(k); }
}

// scope → Map(hourStart → bytes). Kept tiny: ~10 scopes × 24 hours.
const _scopes = new Map();
// scope → lifetime bytes (since process start) — the "who is the hog" view.
const _lifetime = new Map();
const _startedAt = Date.now();

function _hour(now = Date.now()) { return Math.floor(now / HOUR_MS) * HOUR_MS; }

/** Core counter — call anywhere bytes hit the wire. */
export function trackBytes(scope, n) {
  const bytes = Number(n) || 0;
  if (!scope || bytes <= 0) return;
  const h = _hour();
  let hours = _scopes.get(scope);
  if (!hours) { hours = new Map(); _scopes.set(scope, hours); }
  hours.set(h, (hours.get(h) || 0) + bytes);
  // expire buckets older than 24h (lazy — one pass per new hour)
  if (hours.size > 25) {
    for (const k of hours.keys()) if (k < h - 24 * HOUR_MS) hours.delete(k);
  }
  _lifetime.set(scope, (_lifetime.get(scope) || 0) + bytes);
  _capScopes(); // v20.1: bounded scope keyspace (parameterized REST routes)
}

/**
 * Express middleware — counts true REST wire bytes per response.
 * Mount AFTER compression, BEFORE routes. Only /api/* is interesting
 * (static assets are served with immutable 1-year caching and hit the
 * browser cache, not the wire — skip the noise).
 */
export function bandwidthMiddleware() {
  return (req, res, next) => {
    if (!req.path || !req.path.startsWith('/api/')) return next();
    const start = req.socket ? req.socket.bytesWritten : -1;
    res.on('finish', () => {
      try {
        if (!req.socket) return;
        const delta = req.socket.bytesWritten - start;
        if (delta > 0) trackBytes(`rest:${_routeTemplateOf(req.path)}`, delta);
      } catch { /* socket gone — nothing to count */ }
    });
    next();
  };
}

/**
 * Wrap an SSE write helper so every successful frame is counted.
 *   const write = trackSseWrite('sse:positions', (payload) => res.write(payload));
 * The wrapper is transparent: returns whatever the inner fn returns.
 */
export function trackSseWrite(scope, inner) {
  return (payload) => {
    const out = inner(payload);
    try {
      const n = typeof payload === 'string'
        ? Buffer.byteLength(payload)
        : (Buffer.isBuffer(payload) ? payload.length : 0);
      if (n > 0) trackBytes(scope, n);
    } catch { /* telemetry must never break the stream */ }
    return out;
  };
}

function _rolling24h() {
  const cutoff = _hour() - 23 * HOUR_MS; // keep 24 full buckets (current + 23)
  const byScope = {};
  let total = 0;
  for (const [scope, hours] of _scopes) {
    let s = 0;
    for (const [h, b] of hours) { if (h >= cutoff) s += b; }
    if (s > 0) { byScope[scope] = s; total += s; }
  }
  return { total, byScope };
}

function _capBytes(env = {}) {
  const gb = Number(env.BANDWIDTH_MONTHLY_CAP_GB) > 0 ? Number(env.BANDWIDTH_MONTHLY_CAP_GB) : 5;
  return Math.round(gb * 1024 * 1024 * 1024);
}

/** JSON view for the /api/ai/bandwidth endpoint (auth'd like all /api/ai/*). */
export function bandwidthView(env = {}) {
  const { total, byScope } = _rolling24h();
  const cap = _capBytes(env);
  // Projection = observed daily average × 30. Only project once we have
  // at least 1h of history (a fresh boot must not scream "0.2% used").
  const uptimeH = Math.max(0, (Date.now() - _startedAt) / HOUR_MS);
  const hoursWithTraffic = Math.max(1, Math.min(24, uptimeH));
  const dailyAvg = total / hoursWithTraffic;
  const projected30d = Math.round(dailyAvg * 30);
  const capPct = cap > 0 ? Math.round((projected30d / cap) * 1000) / 10 : 0;
  const alertPct = Number(env.BANDWIDTH_ALERT_PCT) > 0 ? Number(env.BANDWIDTH_ALERT_PCT) : 70;
  const topScopes = Object.entries(byScope)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 12)
    .map(([scope, bytes]) => ({ scope, bytes, mb: Math.round(bytes / 1048576 * 10) / 10, pctOf24h: total > 0 ? Math.round((bytes / total) * 1000) / 10 : 0 }));
  return {
    ok: true,
    since: new Date(_startedAt).toISOString(),
    uptimeHours: Math.round(uptimeH * 10) / 10,
    rolling24h: { bytes: total, mb: Math.round(total / 1048576 * 10) / 10 },
    dailyAverage: { bytes: Math.round(dailyAvg), mb: Math.round(dailyAvg / 1048576 * 10) / 10 },
    projected30d: { bytes: projected30d, gb: Math.round(projected30d / 1073741824 * 100) / 100 },
    cap: { gb: Math.round(cap / 1073741824 * 10) / 10, alertPct },
    capPct,
    status: capPct >= 100 ? 'OVER_CAP' : capPct >= alertPct ? 'ALERT' : 'OK',
    topScopes,
    lifetime: Object.fromEntries(
      [..._lifetime.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 12)
        .map(([scope, bytes]) => [scope, { bytes, mb: Math.round(bytes / 1048576 * 10) / 10 }]),
    ),
  };
}

/**
 * Hourly Telegram guard — fires ONE message per UTC day when the 30-day
 * projection crosses the alert threshold. Never throws; unref'd timer.
 *   initBandwidthAlerts({ send: sendTelegramMessage, env: process.env })
 */
export function initBandwidthAlerts({ send, env = {}, log = () => {} } = {}) {
  if (typeof send !== 'function') return null;
  const _cap = _capBytes(env);
  const _alertPct = Number(env.BANDWIDTH_ALERT_PCT) > 0 ? Number(env.BANDWIDTH_ALERT_PCT) : 70;
  let lastAlertDay = '';
  const timer = setInterval(async () => {
    try {
      const view = bandwidthView(env);
      if (view.status === 'OK') return;
      const day = new Date().toISOString().slice(0, 10);
      if (day === lastAlertDay) return; // one per day, not one per hour
      lastAlertDay = day;
      const gb = (n) => (n / 1073741824).toFixed(2);
      const top = view.topScopes.slice(0, 3)
        .map((s) => `${s.scope} ${s.mb}MB (${s.pctOf24h}%)`).join(' · ');
      const text = [
        `🚨 <b>BANDWIDTH ${view.status === 'OVER_CAP' ? 'CAP BREACH' : 'ALERT'}</b>`,
        `30-day projection: <b>${gb(view.projected30d.bytes)} GB</b> = <b>${view.capPct}%</b> of the ${view.cap.gb}GB Render cap`,
        `rolling 24h: ${view.rolling24h.mb}MB · daily avg ${view.dailyAverage.mb}MB`,
        top ? `top: ${top}` : '',
        'Delta-SSE + ETag-304 fixes live hain — agar ye alert repeat ho to per-symbol cadence/subscription audit karo (/api/ai/bandwidth).',
      ].filter(Boolean).join('\n');
      await send(text, env);
      log(`[BANDWIDTH] alert sent — projection ${view.capPct}% of cap`);
    } catch { /* alerting must never take anything down */ }
  }, HOUR_MS);
  if (typeof timer.unref === 'function') timer.unref();
  return timer;
}

export function __resetBandwidthForTests() {
  _scopes.clear();
  _lifetime.clear();
}

/** v20.1 test hook — current distinct scope count (the 200-cap lock). */
export function __scopeCountForTests() {
  return _scopes.size;
}

export const __testables = { _hour, _rolling24h, _capBytes, _routeTemplateOf, MAX_SCOPES };
