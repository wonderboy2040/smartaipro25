// ============================================================
// server/bots/core/candleStore.js — Jev Bot Lab v20.8.0
// ------------------------------------------------------------
// Plan §5 Phase 1: incremental candle store with dedupe by
// timestamp and data-source provenance (source/feed/fetched_at)
// so a live-vs-backtest feed swap is VISIBLE instead of silently
// changing volume features.
//
// Layout: <stateDir>/candles/<desk>/<symbol>/<interval>.jsonl
// One JSON object per line: {t,o,h,l,c,v} — small, appendable,
// atomic-rewritten on compaction. Parquet was considered and
// deliberately rejected: no native parquet dep in this repo and
// the JSONL contract keeps the store auditable by eye.
// ============================================================
import fs from 'node:fs';
import path from 'node:path';
import { nn } from './features.js';

const r6 = (v) => (Number.isFinite(v) ? Math.round(v * 1e6) / 1e6 : null);

/** Normalize one bar to the store contract; null when unusable.
 *  v20.8.1 FIX (M): missing volume stays null — the old ?? 0 poisoned
 *  the volume median baseline and fabricated "volume collapse" facts
 *  (NIFTY index has no real volume). */
export function normBar(b) {
  if (!b || typeof b !== 'object') return null;
  const t = nn(b.time ?? b.t);
  const o = nn(b.open ?? b.o), h = nn(b.high ?? b.h), l = nn(b.low ?? b.l), c = nn(b.close ?? b.c);
  const v = nn(b.volume ?? b.v);
  if (t == null || o == null || h == null || l == null || c == null) return null;
  if (!(o > 0 && h > 0 && l > 0 && c > 0) || !(h >= l)) return null;
  return { t: Math.floor(t / 1000) * 1000, o: r6(o), h: r6(h), l: r6(l), c: r6(c), v: v == null ? null : r6(v) };
}

function storePath(stateDir, desk, symbol, interval) {
  const safeSym = String(symbol).replace(/[^A-Za-z0-9._-]/g, '_');
  return path.join(stateDir, 'candles', String(desk), safeSym, `${interval}.jsonl`);
}

/**
 * Load stored candles (oldest-first, deduped, sorted).
 * Returns { bars, meta } — meta null when no meta sidecar.
 */
export function loadCandles(stateDir, desk, symbol, interval) {
  const p = storePath(stateDir, desk, symbol, interval);
  const bars = [];
  let corruptLines = 0; // v20.8.1 FIX (M): skipped lines are COUNTED —
  // "self-heals on next save" was false (a skipped bar is permanently
  // lost because the next save merges from the parsed bars only).
  if (fs.existsSync(p)) {
    for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
      const s = line.trim();
      if (!s) continue;
      try {
        const b = normBar(JSON.parse(s));
        if (b) bars.push(b); else corruptLines++;
      } catch { corruptLines++; }
    }
  }
  const meta = loadMeta(stateDir, desk, symbol, interval);
  return { bars: dedupeSort(bars), meta, corruptLines };
}

function dedupeSort(bars) {
  const byT = new Map();
  for (const b of bars) byT.set(b.t, b); // last write wins
  return Array.from(byT.values()).sort((a, b) => a.t - b.t);
}

function metaPath(stateDir, desk, symbol, interval) {
  return storePath(stateDir, desk, symbol, interval) + '.meta.json';
}

function loadMeta(stateDir, desk, symbol, interval) {
  const p = metaPath(stateDir, desk, symbol, interval);
  if (!fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

/**
 * Merge two bar series (dedupe by timestamp, keep-NEWEST, oldest-first).
 * v20.8.2: shared by the live candle chain (store history under the
 * fresh fetch) — pure, exported, unit-testable.
 */
export function mergeBarSeries(hist, fresh, { maxBars = 6000 } = {}) {
  const byT = new Map();
  if (Array.isArray(hist)) for (const b of hist) { const n = normBar(b); if (n) byT.set(n.t, n); }
  if (Array.isArray(fresh)) for (const b of fresh) { const n = normBar(b); if (n) byT.set(n.t, n); }
  const all = Array.from(byT.values()).sort((a, b) => a.t - b.t);
  return all.length > maxBars ? all.slice(all.length - maxBars) : all;
}

/**
 * Denomination sanity guard: true when two series plausibly quote the
 * SAME currency. v20.8.2 FIX (H2 — cross-currency poisoning): the bot
 * chain's primary and fallback legs quote different currencies (USDT
 * vs INR ≈ 85x apart); a store written by the OTHER denomination must
 * never be merged under the fresh fetch (an INR-scale SL against a
 * USDT-scale mark = instant phantom stop).
 */
export function sameDenomination(histLastClose, freshLastClose, { toleranceX = 3 } = {}) {
  const a = nn(histLastClose), b = nn(freshLastClose);
  if (a == null || b == null || !(a > 0) || !(b > 0)) return true; // unknown -> don't nuke history on missing data
  const ratio = a / b;
  return ratio >= 1 / toleranceX && ratio <= toleranceX;
}

/** Read the last complete line (cheap tail probe).
 *  Returns { lastT, lastLineStart, lastClose, size } or null when unreadable.
 *  v20.8.4: lastClose added — the denomination guard needs the value, not
 *  just the timestamp. */
function tailProbe(p) {
  try {
    const st = fs.statSync(p);
    if (!st.size) return null;
    const fd = fs.openSync(p, 'r');
    try {
      const readLen = Math.min(st.size, 65536);
      const buf = Buffer.alloc(readLen);
      fs.readSync(fd, buf, 0, readLen, st.size - readLen);
      const txt = buf.toString('utf8');
      // find the START of the last complete line (ends with \n)
      let end = txt.length;
      if (txt.endsWith('\n')) end = txt.length - 1;
      const start = txt.lastIndexOf('\n', end - 1) + 1;
      if (start >= end) return null;
      const line = txt.slice(start, end);
      const b = normBar(JSON.parse(line));
      if (!b) return null;
      const lastLineStart = st.size - readLen + start;
      return { lastT: b.t, lastLineStart, lastClose: b.c, size: st.size };
    } finally { fs.closeSync(fd); }
  } catch { return null; }
}

/**
 * Merge new bars into the store (dedupe by timestamp, keep-newest).
 * Returns { added, total } counts.
 *
 * v20.8.2 FIX (H3 — O(n) rewrite per save): the old implementation
 * re-read and re-wrote the ENTIRE file on every call; the bot lab
 * saves every 60s per symbol, so at 6-month depth (~52k bars) that
 * was ~20MB/min of synchronous I/O on the event loop, growing
 * forever. New design:
 *   • bars newer than the file's last timestamp -> APPEND (O(new)).
 *   • a bar with t == lastT (the forming bar getting its final shape)
 *     -> tail fix-up: truncate the last line, rewrite it (O(1)).
 *   • out-of-order bars (t < lastT, e.g. a backfill) -> full
 *     merge-rewrite (rare, correctness-preserving).
 *   • meta sidecar only rewritten when something actually changed.
 */
export function saveCandles(stateDir, desk, symbol, interval, newBars, meta = {}) {
  const p = storePath(stateDir, desk, symbol, interval);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const norm = [];
  for (const raw of (Array.isArray(newBars) ? newBars : [])) {
    const b = normBar(raw);
    if (b) norm.push(b);
  }
  if (!norm.length) return { added: 0, total: 0 };

  const prevMeta = loadMeta(stateDir, desk, symbol, interval) || {};
  if (!fs.existsSync(p)) {
    const tmp = `${p}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, norm.map(b => JSON.stringify(b)).join('\n') + '\n');
    fs.renameSync(tmp, p);
    writeMetaSidecar(p, prevMeta, meta, norm.length);
    return { added: norm.length, total: norm.length };
  }

  const tail = tailProbe(p);
  if (!tail) {
    // unreadable tail (corrupt?) -> full rewrite from a clean parse
    const { bars: existing } = loadCandles(stateDir, desk, symbol, interval);
    const all = mergeBarSeries(existing, norm, { maxBars: Number.POSITIVE_INFINITY });
    const tmp = `${p}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, all.map(b => JSON.stringify(b)).join('\n') + '\n');
    fs.renameSync(tmp, p);
    writeMetaSidecar(p, prevMeta, meta, all.length);
    return { added: all.length - existing.length, total: all.length };
  }

  // v20.8.4 FIX (H2 follow-up — denomination poison guard): same contract
  // as the live merge's sameDenomination. A store written by the OTHER
  // currency's feed (USDT vs INR ≈ 85x) must never be MERGED with the
  // incoming batch (mixed-denomination file = phantom stops on every
  // consumer). Clean reset to the incoming batch, loudly stamped in meta.
  if (tail.lastClose != null && !sameDenomination(tail.lastClose, norm[norm.length - 1].c)) {
    const tmp = `${p}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, norm.map(b => JSON.stringify(b)).join('\n') + '\n');
    fs.renameSync(tmp, p);
    writeMetaSidecar(p, prevMeta, { ...meta, denominationReset: true, resetAt: new Date().toISOString() }, norm.length);
    return { added: norm.length, total: norm.length, denominationReset: true };
  }

  const older = norm.filter(b => b.t < tail.lastT);
  if (older.length) {
    // out-of-order batch: full merge-rewrite (keeps keep-newest semantics)
    const { bars: existing } = loadCandles(stateDir, desk, symbol, interval);
    const all = mergeBarSeries(existing, norm, { maxBars: Number.POSITIVE_INFINITY });
    const tmp = `${p}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, all.map(b => JSON.stringify(b)).join('\n') + '\n');
    fs.renameSync(tmp, p);
    writeMetaSidecar(p, prevMeta, meta, all.length);
    return { added: all.length - existing.length, total: all.length };
  }

  const newer = norm.filter(b => b.t > tail.lastT);
  const same = norm.filter(b => b.t === tail.lastT);
  if (!newer.length && !same.length) return { added: 0, total: prevMeta.bars || 0 };

  if (same.length) {
    // tail fix-up: drop the last line, then append same+newer
    fs.truncateSync(p, tail.lastLineStart);
  }
  const toAppend = [...same, ...newer].sort((a, b) => a.t - b.t);
  fs.appendFileSync(p, toAppend.map(b => JSON.stringify(b)).join('\n') + '\n');
  const total = (prevMeta.bars || 0) + newer.length; // same-t replaces, not adds
  writeMetaSidecar(p, prevMeta, meta, total);
  return { added: newer.length, total };
}

function writeMetaSidecar(p, prevMeta, meta, totalBars) {
  const mt = `${p}.meta.json`;
  const m = { ...prevMeta, ...meta, updatedAt: new Date().toISOString(), bars: totalBars };
  // v20.8.1 FIX (H3): meta sidecar write is atomic too (a crash mid-write
  // used to truncate provenance silently).
  const mtmp = `${mt}.${process.pid}.tmp`;
  fs.writeFileSync(mtmp, JSON.stringify(m, null, 2));
  fs.renameSync(mtmp, mt);
}

/**
 * Fetch-only-if-stale helper: given a desired minimum last-bar time,
 * reports whether the store already covers it.
 * v20.8.1 PERF: reads the LAST LINE only — the old full-file parse to
 * read one timestamp was O(file).
 */
export function coversUpTo(stateDir, desk, symbol, interval, minLastTsMs) {
  const p = storePath(stateDir, desk, symbol, interval);
  const meta = loadMeta(stateDir, desk, symbol, interval);
  let bars = [];
  if (fs.existsSync(p)) {
    try {
      const txt = fs.readFileSync(p, 'utf8').trimEnd();
      const lastLine = txt.slice(txt.lastIndexOf('\n') + 1);
      const b = normBar(JSON.parse(lastLine));
      if (b) bars = [b];
    } catch { /* fall back to full load below */ }
    if (!bars.length) {
      bars = loadCandles(stateDir, desk, symbol, interval).bars.slice(-1);
    }
  }
  if (!bars.length) return { covered: false, bars: [], meta };
  const last = bars[bars.length - 1].t;
  return { covered: last >= minLastTsMs, bars, meta, last };
}

// v20.8.4 FIX (H2 follow-up — per-tick full-file parse killed): the live
// chain loads store history on EVERY provider call (per symbol per 60s
// tick + per mark fetch); at 6-month depth (~52k bars ≈ 5MB) that is a
// full synchronous JSONL parse per symbol per minute — the exact growing
// sync-I/O disease the v19 never-freeze work exists to kill. Incremental
// tail cache: stat the file; unchanged = zero-parse hit, append-only
// growth (saveCandles appends whole lines) = parse ONLY the new byte
// range, shrink/rewrite (tail fix-up, compaction, denom reset) = one full
// reload. Cache bounded at 64 paths (universe is 3-20 symbols).
const _loadCache = new Map(); // path -> { mtimeMs, size, bars, corrupt }
export function loadCandlesCached(stateDir, desk, symbol, interval) {
  const p = storePath(stateDir, desk, symbol, interval);
  const meta = loadMeta(stateDir, desk, symbol, interval);
  let st = null;
  try { st = fs.statSync(p); } catch {
    _loadCache.delete(p);
    return { bars: [], meta, corruptLines: 0 };
  }
  if (_loadCache.size > 64) _loadCache.clear();
  const c = _loadCache.get(p);
  if (c && st.size === c.size && st.mtimeMs === c.mtimeMs) {
    return { bars: c.bars, meta, corruptLines: c.corrupt };
  }
  if (c && st.size > c.size && st.mtimeMs >= c.mtimeMs) {
    // append-only growth: parse just the new slice (previous cache size
    // was a line boundary — saveCandles always writes trailing '\n')
    let bars = c.bars;
    let corrupt = c.corrupt;
    try {
      const fd = fs.openSync(p, 'r');
      try {
        const len = st.size - c.size;
        const buf = Buffer.alloc(len);
        fs.readSync(fd, buf, 0, len, c.size);
        for (const line of buf.toString('utf8').split('\n')) {
          const s = line.trim();
          if (!s) continue;
          try {
            const b = normBar(JSON.parse(s));
            if (b) bars.push(b); else corrupt++;
          } catch { corrupt++; }
        }
      } finally { fs.closeSync(fd); }
    } catch {
      const r = loadCandles(stateDir, desk, symbol, interval);
      _loadCache.set(p, { mtimeMs: st.mtimeMs, size: st.size, bars: r.bars, corrupt: r.corruptLines });
      return { bars: r.bars, meta: loadMeta(stateDir, desk, symbol, interval), corruptLines: r.corruptLines };
    }
    bars = dedupeSort(bars);
    _loadCache.set(p, { mtimeMs: st.mtimeMs, size: st.size, bars, corrupt });
    return { bars, meta: loadMeta(stateDir, desk, symbol, interval), corruptLines: corrupt };
  }
  // full (re)load — first sight, external rewrite, or shrink
  const r = loadCandles(stateDir, desk, symbol, interval);
  _loadCache.set(p, { mtimeMs: st.mtimeMs, size: st.size, bars: r.bars, corrupt: r.corruptLines });
  return { bars: r.bars, meta, corruptLines: r.corruptLines };
}
