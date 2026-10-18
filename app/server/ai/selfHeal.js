// ============================================================
// server/ai/selfHeal.js — v19.1 NEVER-DOWN SELF HEAL GUARD
// ------------------------------------------------------------
// THE PROBLEM (user report: "localhost pe 5-10 min baad site down"):
// (a) v18.1's uncaughtException policy was FLUSH + process.exit(1) —
//     correct on Render (a supervisor restarts a clean process) but
//     WRONG on a Windows portable whose launcher has no reliable
//     watchdog: ONE stray sync throw in ANY callback (WS frame
//     handler, timer, emitter) = the whole site stays DOWN.
// (b) The user had NO way to see WHY it died — no exit record.
// (c) Slow memory growth / event-loop freezes were invisible.
//
// THE FIX (defense in depth):
//   • uncaughtException → STAY ALIVE by default (flush state, log
//     loud, count it). SELFHEAL_EXIT_ON_FATAL=true restores the
//     v18.1 exit-for-restart behaviour (Render-style supervisors).
//   • unhandledRejection → counted + rate-limited log (never exit —
//     same as before, now observable).
//   • EXIT-REASON JOURNAL — server/data/exit-reasons.log: every boot
//     and every exit (crash/ signal/ clean) is one JSON line. On the
//     NEXT boot the previous run's ending is reported in the console
//     ("previous run: HARD KILL / crash / clean shutdown"), so the
//     NEXT "site down" tells us exactly what happened.
//   • MEMORY WATCHDOG — RSS + heapUsed every 60s vs limits; on
//     breach: run registered cache trims (candles, liveFeed, …) +
//     throttled loud log. Exposed via selfHealthSnapshot().
//   • EVENT-LOOP LAG MONITOR — perf_hooks histogram, 30s buckets;
//     a multi-second freeze (frozen console / sync blob) is logged
//     and visible in /health.
// Leaf module — node builtins only; injectable emitter/now/memory
// for hermetic tests. NEVER throws.
// ============================================================
import { monitorEventLoopDelay } from 'node:perf_hooks';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// v20.4.1 ISOLATION FIX: the exit-reason journal hardcoded the module-
// relative server/data — a boot with SMARTAI_DATA_DIR set STILL wrote
// app/server/data/exit-reasons.log (caught by the v20.4.1 zip smoke:
// app-tree mutation + payload pollution on every exit). Mirror the
// lib/store.js contract: env override wins, production default is
// unchanged. Leaf-safe: env read inline, no store import (circular-free).
const JOURNAL_DIR = process.env.SMARTAI_DATA_DIR
  ? path.resolve(process.env.SMARTAI_DATA_DIR)
  : path.resolve(__dirname, '..', 'data');
const JOURNAL_FILE = path.join(JOURNAL_DIR, 'exit-reasons.log');
const JOURNAL_MAX_LINES = 60;
/** Test-only journal redirect (set via _setJournalFileForTest). */
let _journalFileOverride = null;
const _journalPath = () => _journalFileOverride || JOURNAL_FILE;

const DEFAULTS = {
  rssLimitMB: 1400,
  heapLimitMB: 1100,
  lagWarnMs: 4000,       // log when a 30s bucket's max lag exceeds this
  lagLogThrottleMs: 120_000,
  memLogThrottleMs: 300_000,
  flushThrottleMs: 30_000,
};

// v21.3.0 (Issue-1: "baar baar server down") CONSTRAINED-PLATFORM PROFILE.
// THE BUG: the defaults above are tuned for the user's 16GB Windows
// laptop — on a Render free dyno (512MB cgroup) the platform OOM-killer
// fires LONG before these limits ever trip a trim, so the dyno is
// killed + restarted in a loop = exactly the repeated-down symptom.
// THE FIX: detect a constrained platform (cgroup memory.max < 1.5GB,
// or RENDER/DYNO/RAILWAY/KOYEB/FLY env markers) and (a) default the
// memory limits DOWN to a 512MB-dyno-safe profile, (b) default
// exitOnFatal to TRUE there — a supervised dyno restarts a clean
// process, whereas stay-alive-after-corruption serves garbage state.
// Explicit env (SELFHEAL_RSS_LIMIT_MB etc.) ALWAYS wins over the
// platform profile — a user who knows better is never overridden.
const CONSTRAINED_DEFAULTS = {
  rssLimitMB: 420,
  heapLimitMB: 330,
};
const _CGROUP_FILES = [
  '/sys/fs/cgroup/memory.max',            // cgroup v2
  '/sys/fs/cgroup/memory/memory.limit_in_bytes', // cgroup v1
];
/** Read the container's hard memory ceiling (bytes), null when
 *  unlimited/unreadable (bare-metal + VMs read `max`/huge numbers). */
function _cgroupMemLimitBytes(env = process.env) {
  try {
    if (String(env?.SMARTAI_NO_CGROUP_PROBE || '') === '1') return null;
    for (const f of _CGROUP_FILES) {
      try {
        const raw = fs.readFileSync(f, 'utf8').trim();
        if (!raw || raw === 'max') continue;
        const n = Number(raw);
        if (Number.isFinite(n) && n > 0 && n < 1e15) return n;
      } catch { /* next file */ }
    }
  } catch { /* probe must never throw */ }
  return null;
}
/** True when running on a small container/PaaS dyno where the laptop-
 *  tuned defaults would OOM. Pure + exported for tests. */
export function isConstrainedPlatform(env = process.env, memLimitBytes = null) {
  try {
    const markers = ['RENDER', 'DYNO', 'RAILWAY_SERVICE_ID', 'KOYEB', 'FLY_APP_NAME'];
    if (markers.some((k) => env && String(env[k] || '').length > 0)) return true;
    // SMARTAI_NO_CGROUP_PROBE=1 disables cgroup-based detection ENTIRELY
    // (explicit param included — a dev box can force the laptop profile).
    let bytes = memLimitBytes;
    if (String(env?.SMARTAI_NO_CGROUP_PROBE || '') === '1') bytes = null;
    if (bytes == null) bytes = _cgroupMemLimitBytes(env);
    if (bytes != null && bytes > 0 && bytes < 1.5 * 1024 * 1024 * 1024) return true;
  } catch { /* never throw */ }
  return false;
}

const _state = {
  armed: false,
  emitter: null,
  nowFn: () => Date.now(),
  memFn: () => process.memoryUsage(),
  env: {},
  cfg: DEFAULTS,
  getFlushers: null,
  getLogStats: null,
  log: (() => { try { return console.error; } catch { return (() => {}); } })(),
  // counters
  uncaught: 0,
  rejections: 0,
  memTrims: 0,
  memAlerts: 0,
  lagAlerts: 0,
  lastError: null,
  lastErrorAt: 0,
  // watchdog state
  memPressure: false,
  loopLagMean: 0,
  loopLagMax: 0,
  _lastMemLogAt: 0,
  _lastLagLogAt: 0,
  _lastFlushAt: 0,
  _hist: null,
  _watchTimer: null,
  _journalThisRun: false,
  _bootReported: null,
  _prevTail: null,
};

// ---------------- exit-reason journal ----------------
function _journalAppend(entry) {
  try {
    const file = _journalPath();
    const dir = path.dirname(file);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const line = JSON.stringify({ pid: process.pid, ...entry }) + '\n';
    fs.appendFileSync(file, line);
    // bound the file: keep the tail only
    try {
      const raw = fs.readFileSync(file, 'utf8');
      const lines = raw.split('\n').filter(Boolean);
      if (lines.length > JOURNAL_MAX_LINES) {
        fs.writeFileSync(file, lines.slice(-JOURNAL_MAX_LINES).join('\n') + '\n');
      }
    } catch { /* cap best-effort */ }
    return true;
  } catch { return false; /* journal is diagnostics, never fatal */ }
}

function _journalTail() {
  try {
    const file = _journalPath();
    if (!fs.existsSync(file)) return [];
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
    return lines.slice(-3).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
}

/** Boot-time diagnosis: what happened to the PREVIOUS run?
 *  Returns { verdict, detail } and logs one honest line. */
export function reportLastExitOnBoot() {
  if (_state._bootReported) return _state._bootReported;
  try {
    // v20.4.3 FIX: initSelfHeal() appends THIS run's 'boot' record before
    // this function runs, so re-reading the journal always saw our own boot
    // and falsely reported "HARD KILL" on every restart. Use the tail that
    // was snapshotted BEFORE the boot record was written.
    const tail = Array.isArray(_state._prevTail) ? _state._prevTail : _journalTail();
    if (tail.length === 0) {
      _state._bootReported = { verdict: 'NO RECORD', detail: 'first run (ya journal padhne se pehle delete)' };
    } else {
      const last = tail[tail.length - 1];
      if (last && last.ev === 'exit') {
        _state._bootReported = {
          verdict: String(last.reason || '').startsWith('clean-shutdown') ? 'CLEAN SHUTDOWN' : `EXIT (${last.reason})`,
          detail: String(last.detail || '').slice(0, 160),
          at: last.at,
        };
      } else if (last && last.ev === 'boot') {
        // a boot record with no exit after it = the process died HARD
        // (OOM kill / console kill / V8 fatal) — no handler ran
        _state._bootReported = {
          verdict: 'HARD KILL (no exit record — OOM ya force-kill likely)',
          detail: `previous pid ${last.pid} started ${new Date(last.at).toISOString()} aur bina clean exit ke gaya`,
          at: last.at,
        };
      } else {
        _state._bootReported = { verdict: 'UNKNOWN', detail: 'journal tail unrecognized' };
      }
    }
    try { _state.log(`[selfheal] previous run: ${_state._bootReported.verdict}${_state._bootReported.detail ? ' — ' + _state._bootReported.detail : ''}`); } catch { /* noop */ }
    return _state._bootReported;
  } catch {
    _state._bootReported = { verdict: 'UNKNOWN', detail: 'journal read failed' };
    return _state._bootReported;
  }
}

// ---------------- cache trim registry ----------------
const _trims = new Map(); // name -> fn
export function registerTrim(name, fn) {
  try {
    if (typeof fn === 'function') _trims.set(String(name || 'trim'), fn);
  } catch { /* noop */ }
}
function _runTrims(where) {
  let ran = 0;
  for (const [_name, fn] of _trims) {
    try { fn(); ran++; } catch { /* one bad trim never blocks the rest */ }
  }
  _state.memTrims++;
  try { _state.log(`[selfheal] memory pressure (${where}) — flushed ${ran}/${_trims.size} registered cache trims; app stays UP`); } catch { /* noop */ }
}

// ---------------- memory + lag watchdog ----------------
function _watchTick() {
  try {
    const now = _state.nowFn();
    const m = _state.memFn();
    const rssMB = Math.round((m.rss || 0) / 1048576);
    const heapMB = Math.round((m.heapUsed || 0) / 1048576);
    _state.rssMB = rssMB;
    _state.heapMB = heapMB;
    const breach = rssMB > _state.cfg.rssLimitMB || heapMB > _state.cfg.heapLimitMB;
    _state.memPressure = breach;
    if (breach && now - _state._lastMemLogAt > _state.cfg.memLogThrottleMs) {
      _state._lastMemLogAt = now;
      _state.memAlerts++;
      _runTrims(`rss ${rssMB}MB / heap ${heapMB}MB vs limits ${_state.cfg.rssLimitMB}/${_state.cfg.heapLimitMB}MB`);
    } else if (breach) {
      _state.memPressure = true; // stay flagged, log already throttled
    }
    // event-loop lag bucket
    if (_state._hist) {
      try {
        // v20.5.1 FIX (event-loop freeze false positives): perf_hooks
        // monitorEventLoopDelay() returns a histogram whose .max and
        // .mean are in NANOSECONDS, not milliseconds. The previous
        // code stored them raw into loopLagMax and compared against
        // lagWarnMs (4000 ms) — but treating ns as ms meant a real
        // 4-microsecond lag tripped the alarm (false positive), and
        // the display divided ns by 1000 → microseconds labeled as
        // "seconds" → "180224.0s in the last 30s" flooded the console
        // (impossible value; a 30s bucket can max be ~30s). Convert
        // ns → ms here (÷1_000_000) so the threshold and display
        // are both correct: 4ms real lag stays under the alarm; a
        // 4-second freeze surfaces as "4.0s".
        const NS_PER_MS = 1_000_000;
        _state.loopLagMean = Math.round(_state._hist.mean / NS_PER_MS);
        _state.loopLagMax = Math.round(_state._hist.max / NS_PER_MS);
        if (_state.loopLagMax > _state.cfg.lagWarnMs && now - _state._lastLagLogAt > _state.cfg.lagLogThrottleMs) {
          _state._lastLagLogAt = now;
          _state.lagAlerts++;
          try {
            _state.log(`[selfheal] EVENT-LOOP FREEZE detected — worst lag ${(_state.loopLagMax / 1000).toFixed(1)}s in the last 30s (heavy sync work / frozen console / blocked stdout). Server abhi bhi zinda hai; agar browser me site atki hai to console window pe click karke Enter dabao (QuickEdit select-mode freeze).`);
          } catch { /* noop */ }
        }
        _state._hist.reset();
      } catch { /* hist best-effort */ }
    }
  } catch { /* watchdog itself must never throw */ }
}

// ---------------- process handlers ----------------
function _bestEffortFlush(reason) {
  const now = _state.nowFn();
  if (now - _state._lastFlushAt < DEFAULTS.flushThrottleMs) return; // storms don't hammer disk
  _state._lastFlushAt = now;
  try {
    const flushers = (typeof _state.getFlushers === 'function' ? _state.getFlushers() : []) || [];
    for (const [_name, fn] of flushers) {
      try { if (typeof fn === 'function') fn(); } catch { /* best-effort during crash */ }
    }
  } catch { /* never re-throw inside the crash path */ }
  _journalAppend({ ev: 'crash-flush', reason, at: now, uptimeSec: Math.round(process.uptime()) });
}

function _onUncaught(err) {
  _state.uncaught++;
  _state.lastError = String(err?.message || err).slice(0, 300);
  _state.lastErrorAt = _state.nowFn();
  const stack = String(err?.stack || '').split('\n').slice(0, 4).join(' | ');
  try {
    _state.log(`[selfheal] UNCAUGHT EXCEPTION #${_state.uncaught} — app STAYS UP (v19.1 never-down guard; SELFHEAL_EXIT_ON_FATAL=true se purana exit behaviour milta hai): ${_state.lastError} ${stack}`);
  } catch { /* noop */ }
  _bestEffortFlush('uncaught-exception');
  if (_state.exitOnFatal) {
    // legacy v18.1 behaviour, opt-in: clean restart beats zombie state
    try { _journalAppend({ ev: 'exit', reason: 'uncaught-exception-exit', detail: _state.lastError, at: _state.nowFn(), uptimeSec: Math.round(process.uptime()), uncaught: _state.uncaught }); } catch { /* noop */ }
    setTimeout(() => process.exit(1), 250).unref?.();
  }
}

function _onRejection(reason) {
  _state.rejections++;
  // the log governor dedupes repeats; still cap the tail noise
  if (_state.rejections <= 5 || _state.rejections % 25 === 0) {
    try { _state.log(`[selfheal] unhandled rejection #${_state.rejections}: ${String(reason?.message || reason).slice(0, 200)} — logged, app stays UP`); } catch { /* noop */ }
  }
}

function _onExit(code) {
  try {
    if (_state._journalThisRun) return;
    _state._journalThisRun = true;
    _journalAppend({
      ev: 'exit', reason: code === 0 ? 'clean-exit' : `exit-code-${code}`,
      at: _state.nowFn(), uptimeSec: Math.round(process.uptime()),
      uncaught: _state.uncaught, rejections: _state.rejections,
    });
  } catch { /* journaling must never block exit */ }
}

/** Signal hook — call from the existing graceful-shutdown path so the
 *  journal records intentional stops (restart/tray exit) distinctly
 *  from crashes. */
export function selfHealNoteShutdown(reason) {
  try {
    _state._journalThisRun = true;
    _journalAppend({
      ev: 'exit', reason: `clean-shutdown (${reason})`, at: _state.nowFn(),
      uptimeSec: Math.round(process.uptime()),
      uncaught: _state.uncaught, rejections: _state.rejections,
    });
  } catch { /* noop */ }
}

// ---------------- arm ----------------
/**
 * Arm the guard. Idempotent. Registers process handlers, the boot
 * journal entry, and the 60s memory/lag watchdog.
 *   initSelfHeal({
 *     env, emitter?, nowFn?, memFn?, journalFile?,
 *     getFlushers, getLogStats, log?
 *   })
 */
export function initSelfHeal(opts = {}) {
  if (_state.armed) return false;
  const env = opts.env || process.env;
  const off = String(env.SELFHEAL_ENABLED || 'true').toLowerCase() === 'false';
  if (off) {
    try { console.log('[selfheal] SELFHEAL_ENABLED=false — never-down guard OFF (not recommended)'); } catch { /* noop */ }
    return false;
  }
  _state.armed = true;
  _state.env = env;
  _state.emitter = opts.emitter || process;
  if (opts.nowFn) _state.nowFn = opts.nowFn;
  if (opts.memFn) _state.memFn = opts.memFn;
  if (typeof opts.getFlushers === 'function') _state.getFlushers = opts.getFlushers;
  if (typeof opts.getLogStats === 'function') _state.getLogStats = opts.getLogStats;
  if (typeof opts.log === 'function') _state.log = opts.log;
  const constrained = isConstrainedPlatform(env);
  _state.platformConstrained = constrained;
  const effDefaults = constrained ? { ...DEFAULTS, ...CONSTRAINED_DEFAULTS } : DEFAULTS;
  if (constrained) {
    try {
      _state.log(`[selfheal] CONSTRAINED PLATFORM detected (cgroup/PaaS) — memory limits ${CONSTRAINED_DEFAULTS.rssLimitMB}/${CONSTRAINED_DEFAULTS.heapLimitMB}MB + exit-on-fatal ON (supervised dyno: clean restart beats zombie state). Env overrides still win.`);
    } catch { /* noop */ }
  }
  _state.cfg = {
    rssLimitMB: Number(env.SELFHEAL_RSS_LIMIT_MB) > 0 ? Number(env.SELFHEAL_RSS_LIMIT_MB) : effDefaults.rssLimitMB,
    heapLimitMB: Number(env.SELFHEAL_HEAP_LIMIT_MB) > 0 ? Number(env.SELFHEAL_HEAP_LIMIT_MB) : effDefaults.heapLimitMB,
    lagWarnMs: Number(env.SELFHEAL_LAG_WARN_MS) > 0 ? Number(env.SELFHEAL_LAG_WARN_MS) : DEFAULTS.lagWarnMs,
    lagLogThrottleMs: DEFAULTS.lagLogThrottleMs,
    memLogThrottleMs: DEFAULTS.memLogThrottleMs,
  };
  const _fatalSet = String(env.SELFHEAL_EXIT_ON_FATAL || '').toLowerCase();
  _state.exitOnFatal = _fatalSet === 'true' ? true : _fatalSet === 'false' ? false : constrained;

  // handlers — first-registered runs first; index.js's v18.1 handlers
  // are REPLACED by this module (the old block is deleted there).
  try { _state.emitter.on('uncaughtException', _onUncaught); } catch { /* noop */ }
  try { _state.emitter.on('unhandledRejection', _onRejection); } catch { /* noop */ }
  try { _state.emitter.on('exit', _onExit); } catch { /* noop */ }

  // boot journal entry (previous run's verdict is reported by
  // reportLastExitOnBoot — call it AFTER arm, from index.js)
  try { _state._prevTail = _journalTail(); } catch { _state._prevTail = null; }
  _journalAppend({ ev: 'boot', at: _state.nowFn(), node: process.version });

  // event-loop lag histogram (30s buckets)
  try {
    _state._hist = monitorEventLoopDelay({ resolution: 50 });
    _state._hist.enable();
  } catch { _state._hist = null; }

  // watchdog: 60s cadence
  try {
    _state._watchTimer = setInterval(_watchTick, 60_000);
    if (typeof _state._watchTimer.unref === 'function') _state._watchTimer.unref();
  } catch { /* timer best-effort */ }

  return true;
}

// ---------------- snapshot for /health ----------------
export function selfHealthSnapshot() {
  try {
    const m = _state.memFn();
    const logStats = (typeof _state.getLogStats === 'function' ? (() => { try { return _state.getLogStats(); } catch { return null; } })() : null);
    return {
      ok: true,
      armed: _state.armed,
      exitOnFatal: !!_state.exitOnFatal,
      platformConstrained: !!_state.platformConstrained,
      pid: process.pid,
      uptimeSec: Math.round(process.uptime()),
      memory: {
        rssMB: Math.round((m.rss || 0) / 1048576),
        heapUsedMB: Math.round((m.heapUsed || 0) / 1048576),
        heapTotalMB: Math.round((m.heapTotal || 0) / 1048576),
        externalMB: Math.round((m.external || 0) / 1048576),
        limitsMB: { rss: _state.cfg.rssLimitMB, heap: _state.cfg.heapLimitMB },
        pressure: !!_state.memPressure,
      },
      loopLagMs: { mean: _state.loopLagMean, max30s: _state.loopLagMax },
      counts: {
        uncaughtExceptions: _state.uncaught,
        unhandledRejections: _state.rejections,
        memTrims: _state.memTrims,
        memAlerts: _state.memAlerts,
        lagAlerts: _state.lagAlerts,
      },
      lastError: _state.lastError ? { message: _state.lastError, at: _state.lastErrorAt } : null,
      previousRun: _state._bootReported || null,
      logGovernor: logStats,
    };
  } catch {
    return { ok: false, armed: _state.armed };
  }
}

// ---------------- test hooks ----------------
export function __resetSelfHealForTests() {
  try { if (_state._hist) { _state._hist.disable(); } } catch { /* noop */ }
  try { if (_state._watchTimer) clearInterval(_state._watchTimer); } catch { /* noop */ }
  try {
    if (_state.emitter && _state.emitter !== process) {
      _state.emitter.removeAllListeners?.();
    }
  } catch { /* noop */ }
  _trims.clear();
  Object.assign(_state, {
    armed: false, emitter: null, env: {}, cfg: DEFAULTS,
    getFlushers: null, getLogStats: null,
    log: (() => { try { return console.error; } catch { return (() => {}); } })(),
    uncaught: 0, rejections: 0, memTrims: 0, memAlerts: 0, lagAlerts: 0,
    lastError: null, lastErrorAt: 0,
    memPressure: false, rssMB: 0, heapMB: 0, loopLagMean: 0, loopLagMax: 0,
    _lastMemLogAt: 0, _lastLagLogAt: 0, _lastFlushAt: 0,
    _hist: null, _watchTimer: null, _journalThisRun: false, _bootReported: null, _prevTail: null,
    exitOnFatal: false, platformConstrained: false,
  });
  _journalFileOverride = null;
}
export function _setJournalFileForTest(p) { _journalFileOverride = p; }
export function __driveWatchTickForTests() { _watchTick(); }
export function __triggerUncaughtForTests(err) { _onUncaught(err); }
export function __triggerRejectionForTests(reason) { _onRejection(reason); }
export function __triggerExitForTests(code) { _onExit(code); }
export const __testables = { _runTrims, _journalAppend, _journalTail, _journalPath };
