// ============================================================
// server/ai/logGovernor.js — v19.1 STDOUT VOLUME GOVERNOR
// ------------------------------------------------------------
// THE PROBLEM (user report: "localhost pe 5-10 min baad site down"):
// Windows portable launchers often run `node server/index.js` with a
// PIPED stdout. If the parent stops draining (tray app busy, console
// window frozen by QuickEdit select-mode, slow terminal relay), the
// OS pipe buffer (~64KB) fills — the next console.log BLOCKS FOREVER
// and the whole event loop freezes: /health stops answering, the
// browser spinner spins, "site down". The process is alive but hung.
//
// THE FIX: cap the log volume at the source.
//   • DEDUPE: identical lines within LOG_DEDUPE_MS collapse to one
//     line + "×N repeats" (watchers/streams love repeating lines).
//   • RATE CAP: soft token bucket of LOG_LINES_PER_MIN per channel;
//     excess lines are DROPPED (counted, summarized once a minute).
//   • v21.1.0 LOG LEVELS (Phase-3): console.log→info, console.warn→warn,
//     console.error→error, console.debug→debug. LOG_LEVEL env (default
//     'info') us level se NICHE ke sab lines DROP karta hai (LOG_LEVEL=warn
//     → info chatter gayab, sirf warn+error; LOG_LEVEL=error → sirf errors).
//     Flood control ko trigger point pe milta hai — per-call-site edits nahi.
//   • NEVER THROWS: any internal error falls back to raw console.
// Env knobs: LOG_LINES_PER_MIN (default 240), LOG_DEDUPE_MS (default
// 20000), LOG_LEVEL (default info), LOG_GOVERNOR=off to disable (raw
// passthrough).
// Leaf module — zero server imports, safe to load first.
// ============================================================

// v21.1.0: numeric level ranks — chhota number = zyada verbose.
const LEVEL_RANK = { debug: 10, info: 20, warn: 30, error: 40 };

let _orig = null;            // { log, warn, error }
const _state = {
  armed: false,
  lines: 0,          // total lines passed through (post-governor)
  raw: 0,            // total lines offered (pre-governor)
  suppressed: 0,     // deduped repeats
  dropped: 0,        // rate-capped away
  lastSummaryAt: 0,  // epoch of the last "dropped N" summary line
};
const _dedupe = new Map();   // key -> { count, firstAt, lastAt, sample }

const DEFAULTS = {
  linesPerMin: 240,
  dedupeMs: 20_000,
  summaryMs: 60_000,
};

function _num(v, def) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : def;
}

/** Normalize a message to a dedupe key: first line, 160 chars,
 *  timestamps/numbers/durations collapsed so "closed BTC 12.5" style
 *  lines with moving parts still dedupe when they repeat rapidly. */
function _keyOf(args) {
  try {
    const first = args.length === 0 ? '' : String(args[0] ?? '');
    const line = first.split('\n')[0] || '';
    return line
      .replace(/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}[.\d]*Z?/g, '<ts>')
      .replace(/\b\d+(\.\d+)?\b/g, '<n>')
      .slice(0, 160);
  } catch { return '<key>'; }
}

function _write(level, args) {
  try { _orig[level](...args); } catch { /* even the raw write failed — nothing left to do */ }
}

function _now() { return Date.now(); }

function _govern(level, cfg, args) {
  _state.raw++;
  if (!_state.armed) { _write(level, args); return; }
  try {
    // ---- v21.1.0 level pass (dedupe/rate se PEHLE — filtered line ka
    // bucket consume karna bhi waste hai) ----
    const rank = LEVEL_RANK[cfg.levelName?.[level] ?? 'info'] ?? LEVEL_RANK.info;
    if (rank < cfg.minRank) { _state.levelDropped++; return; }
    const now = _now();
    const key = `${level}:${_keyOf(args)}`;

    // ---- dedupe pass ----
    const d = _dedupe.get(key);
    if (d && now - d.lastAt < cfg.dedupeMs) {
      d.count++;
      d.lastAt = now;
      // let every 25th repeat through so long-running storms stay
      // observable, but 1 line instead of hundreds
      if (d.count % 25 !== 0) { _state.suppressed++; return; }
      _state.lines++;
      _write(level, [...args.slice(0, 1), `… (repeat ×${d.count} within ${Math.round(cfg.dedupeMs / 1000)}s — log-governor)`]);
      return;
    }
    if (d) _dedupe.delete(key);
    if (_dedupe.size > 500) _dedupe.clear(); // bound the map itself
    _dedupe.set(key, { count: 1, firstAt: now, lastAt: now });

    // ---- rate-cap pass (rolling minute token bucket) ----
    const minuteStart = Math.floor(now / 60_000) * 60_000;
    if (_state.minuteStart !== minuteStart) { _state.minuteStart = minuteStart; _state.minuteLines = 0; }
    if (_state.minuteLines >= cfg.linesPerMin) {
      _state.dropped++;
      // once per summary window, ONE honest line about the drop
      if (now - _state.lastSummaryAt > cfg.summaryMs) {
        _state.lastSummaryAt = now;
        _state.minuteLines++; // this line counts against the same cap
        _state.lines++;
        _write(level, [`[log-governor] rate cap ${cfg.linesPerMin} lines/min hit — dropped ${_state.dropped} lines so far (spinning watchers/logs are the usual cause; server stays UP)`]);
      }
      return;
    }
    _state.minuteLines++;
    _state.lines++;
    _write(level, args);
  } catch {
    // governor itself must never break logging
    try { _write(level, args); } catch { /* dead console */ }
  }
}

/**
 * Arm the governor. Idempotent. Call as EARLY as possible in
 * server/index.js (before the boot chatter starts).
 *   initLogGovernor({ env, nowFn })
 */
export function initLogGovernor({ env = process.env, nowFn: _nowFn } = {}) {
  if (_state.armed || _orig) return false;
  const off = String(env.LOG_GOVERNOR || '').toLowerCase() === 'off';
  // v21.1.0: console channel → level name mapping (log=info is the
  // industry convention). LOG_LEVEL default 'info' — pehle jaisa behavior
  // (kuch suppress nahi hota, sirf naya debug channel filter hota hai).
  const levelName = { log: 'info', warn: 'warn', error: 'error', debug: 'debug' };
  const wanted = String(env.LOG_LEVEL || 'info').toLowerCase();
  const minRank = LEVEL_RANK[wanted] ?? LEVEL_RANK.info; // unknown value → info (safe)
  const cfg = {
    linesPerMin: _num(env.LOG_LINES_PER_MIN, DEFAULTS.linesPerMin),
    dedupeMs: _num(env.LOG_DEDUPE_MS, DEFAULTS.dedupeMs),
    summaryMs: DEFAULTS.summaryMs,
    levelName,
    minRank,
    level: wanted,
  };
  _orig = { log: console.log, warn: console.warn, error: console.error, debug: console.debug };
  if (off) {
    _state.armed = false; // passthrough, but stats stay wired
  } else {
    _state.armed = true;
  }
  _state.cfg = cfg;
  _state.minuteStart = 0;
  _state.minuteLines = 0;
  _state.levelDropped = 0;
  const wrap = (level) => (...args) => _govern(level, cfg, args);
  console.log = wrap('log');
  console.warn = wrap('warn');
  console.error = wrap('error');
  console.debug = wrap('debug');
  return true;
}

/** Stats for /health + diagnostics. Never throws. */
export function logGovernorStats() {
  try {
    return {
      armed: _state.armed,
      lines: _state.lines,
      raw: _state.raw,
      suppressedRepeats: _state.suppressed,
      dropped: _state.dropped,
      dedupeKeys: _dedupe.size,
      capPerMin: _state.cfg?.linesPerMin || DEFAULTS.linesPerMin,
      logLevel: _state.cfg?.level || 'info',
      levelDropped: _state.levelDropped || 0,
    };
  } catch { return { armed: false }; }
}

/** Test hook — restore the raw console + reset state. */
export function __resetLogGovernorForTests() {
  if (_orig) {
    try {
      console.log = _orig.log;
      console.warn = _orig.warn;
      console.error = _orig.error;
      if (typeof _orig.debug === 'function') console.debug = _orig.debug; // v21.1.0
    } catch { /* already restored */ }
  }
  _orig = null;
  _state.armed = false;
  _state.lines = 0; _state.raw = 0; _state.suppressed = 0; _state.dropped = 0; _state.levelDropped = 0;
  _state.lastSummaryAt = 0; _state.minuteStart = 0; _state.minuteLines = 0;
  _state.cfg = null;
  _dedupe.clear();
}

/** Internal (tests): drive one governed decision without touching console. */
export const __testables = { _govern, _keyOf, DEFAULTS };
