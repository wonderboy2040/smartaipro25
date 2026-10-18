// ============================================================
// liveFeed — central in-memory tick store + pub/sub for SSE
// ------------------------------------------------------------
// Every real-time source (NSE, Finnhub US, Binance crypto) writes the latest
// tick here, keyed exactly like the frontend price map:
//   IN_<symbol>  US_<symbol>   (crypto is stored as IN_<symbol> too)
// The /api/stream SSE endpoint reads/pushes from here.
// ============================================================
const _ticks = new Map();        // key -> { price, change, high, low, volume, time, source }
const _subscribers = new Set();  // fn(key, data)
const _sourceSeen = {};          // source -> last tick epoch (for feed-status)

export function setTick(key, data, source) {
  if (!key || !(data?.price > 0)) return;
  const tick = {
    price: data.price,
    change: typeof data.change === 'number' ? data.change : 0,
    high: data.high ?? data.price,
    low: data.low ?? data.price,
    volume: data.volume ?? 0,
    time: data.time ?? Date.now(),
    source: source || data.source || 'live',
    // 2026 P&L accuracy pass: the REAL previous close (when the source
    // provides it) so Today's P&L = (price - prevClose) * qty exactly —
    // no more back-computing from the rounded change % (which drifts).
    prevClose: (typeof data.prevClose === 'number' && data.prevClose > 0) ? data.prevClose : undefined,
  };
  _ticks.set(key, tick);
  if (source) _sourceSeen[source] = Date.now();
  for (const fn of _subscribers) {
    try { fn(key, tick); } catch { /* ignore subscriber errors */ }
  }
}

export function getTick(key) {
  return _ticks.get(key) || null;
}

export function snapshot(keys) {
  const out = {};
  (keys || []).forEach(k => { const t = _ticks.get(k); if (t) out[k] = t; });
  return out;
}

export function subscribe(fn) {
  _subscribers.add(fn);
  return () => _subscribers.delete(fn);
}

// Which sources have produced a tick in the last 60s (for the UI health dot).
export function feedStatus() {
  const now = Date.now();
  const live = {};
  for (const [src, at] of Object.entries(_sourceSeen)) {
    live[src] = (now - at) < 60000;
  }
  return live;
}

// v21.1.0 (Phase-3): per-source LAST-TICK AGES — /api/health + frontend strip
// ke liye. feedStatus() sirf booleans deta tha (60s window); ab har source ka
// age seconds me bhi milta hai (never-ticked sources skip — wo "not armed"
// hain, "stale" nahi).
export function feedAges() {
  const now = Date.now();
  const out = {};
  for (const [src, at] of Object.entries(_sourceSeen)) {
    out[src] = { lastTickAt: at, ageSec: Math.max(0, Math.round((now - at) / 1000)) };
  }
  return out;
}

// Housekeeping (2026 perf audit M2): _ticks previously grew forever — every
// key ever ticked stayed in the map for the whole process lifetime. Snapshots
// only ever ask for keys an active client cares about, so anything stale
// (>30 min without an update, map larger than 300) is safely evictable.
setInterval(() => {
  if (_ticks.size <= 300) return;
  const cutoff = Date.now() - 30 * 60 * 1000;
  for (const [k, t] of _ticks) {
    if ((t.time || 0) < cutoff) _ticks.delete(k);
  }
}, 5 * 60 * 1000).unref?.();

// v19.1 selfHeal hook: AGGRESSIVE prune under memory pressure. Evicts
// everything older than 5 min; if the map is still >200 entries, evicts
// oldest-first down to 200. Called ONLY by the never-down guard's trim
// registry (registerTrim('liveFeed', pruneLiveFeedNow)) — the normal
// housekeeping above is untouched. Next tick for a still-watched symbol
// re-populates it instantly, so the cost is one extra upstream fetch
// per live symbol — the right trade under memory pressure.
export function pruneLiveFeedNow() {
  const cutoff = Date.now() - 5 * 60 * 1000;
  for (const [k, t] of _ticks) {
    if ((t.time || 0) < cutoff) _ticks.delete(k);
  }
  if (_ticks.size > 200) {
    const entries = [..._ticks.entries()].sort((a, b) => (a[1].time || 0) - (b[1].time || 0));
    for (let i = 0; i < entries.length - 200; i++) _ticks.delete(entries[i][0]);
  }
  return _ticks.size;
}
