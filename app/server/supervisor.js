#!/usr/bin/env node
// ============================================================
// SmartAI v20.0.1 — supervisor.js (ANTI-FREEZE SUPERVISOR)
//            v19.2 engine + v20.0.1 DEPS AUTO-INSTALL
// ------------------------------------------------------------
// v20.0.1 FIX (live bug, D:\SmartAI26 fresh install): v20 full zip
// me node_modules NAHI hota (user-data rule) — naye folder pe boot
// "ERR_MODULE_NOT_FOUND: dotenv" crash-loop me girta tha (aur
// purana message GALAT "port conflict" bolta tha). Ab:
//   * boot se PEHLE package.json deps vs node_modules audit —
//     missing ho to npm install KHUD chalta hai (internet chahiye,
//     15 min max, output [npm] lines me relay hota hai).
//   * child crash pe stderr se ERR_MODULE_NOT_FOUND sniff hota hai
//     -> journal reason 'deps-missing' + honest Hindi message +
//     ek auto-install retry (max 2 per supervisor run).
//   * install ke dauran restart-tick/startChild blocked rehte hain
//     (race-free); fail hone pe bhi loop honest rehta hai (budget
//     pause pehle se hi tha).
// THE EXTERNAL WATCHDOG THAT v19.1 WAS MISSING.
//
// v19.1 made the server crash-resilient (stay-alive, log
// governor, exit journal). But one failure class stayed
// UNRECOVERABLE: the HANG. Process zinda hai, event loop
// FROZEN (Windows QuickEdit console select, blocked stdout
// pipe, sync stall, runaway loop) — /health timeout, site
// "atak jaati hai", aur process kabhi exit nahi karta, so
// koi restart trigger nahi fire hota. The v19.1 watchdog bat
// only restarted on EXIT — a hung child never exits.
//
// THIS file closes that loop with an INDEPENDENT probe:
//   * spawns server/index.js as a child (env marker
//     SMARTAI_SUPERVISED=1) and RELIABLY consumes its stdout
//     (a pipe that is always drained can never fill and
//     freeze the child) — lines go to console + a rotated
//     file log (server/data/logs/server.log, 5MB x 2).
//   * every WATCHDOG_PROBE_MS it GETs /api/ping from its OWN
//     event loop. The ping route is zero-work — response time
//     IS the child's event-loop heartbeat.
//   * WATCHDOG_FAILS consecutive timeouts AFTER the boot grace
//     window = FREEZE VERDICT -> force-kill (taskkill /F /T on
//     Windows so grandchildren die too) -> journal -> restart.
//     A boot that never comes up hits the same verdict via
//     fails+3 (reason boot-hang).
//   * child EXIT (crash / OOM / V8 fatal) -> journal + restart
//     with exponential backoff (3s..60s, reset after 10 min
//     stable) and an hourly restart budget (default 20) that
//     pauses 10 min instead of crash-looping CPU burn.
//   * Ctrl+C -> graceful: child gets the console ctrl event on
//     Windows (shared console) and runs its own v19.1 graceful
//     shutdown; supervisor waits up to 8s, then force-kills,
//     journals watchdog-clean-shutdown, exits 0.
//   * supervisor itself NEVER exits on internal errors
//     (own uncaughtException/unhandledRejection stay-alive).
//
// Usage:  node server\supervisor.js     (Start-SmartAI-Watchdog.bat
//         does exactly this from the app root)
// Knobs (all optional, env): WATCHDOG_PORT | PORT, WATCHDOG_PROBE_MS
// (20s), WATCHDOG_TIMEOUT_MS (9s), WATCHDOG_FAILS (3),
// WATCHDOG_GRACE_MS (45s), WATCHDOG_MAX_RESTARTS_HOUR (20),
// WATCHDOG_BUDGET_PAUSE_MS (10m), WATCHDOG_LOG_FILE (path | off),
// WATCHDOG_JOURNAL (path), WATCHDOG_DISABLE (probes off ->
// restart-on-exit only), WATCHDOG_AUTO_INSTALL (default on — deps
// missing = auto npm install), WATCHDOG_INSTALL_TIMEOUT_MS (15m),
// WATCHDOG_APP_ROOT (deps-root override, rare).
// ============================================================

import { spawn } from 'node:child_process';
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { disableQuickEditMode } from './ai/consoleGuard.js';
// (v21.14: Laya sidecar removed — local AI model permanently retired)

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.join(__dirname, '..');
const SERVER_ENTRY = path.join(__dirname, 'index.js');
// v20.4.1 ISOLATION FIX: same contract as lib/store.js + ai/selfHeal.js —
// SMARTAI_DATA_DIR (dev/test isolation) wins over the module-relative
// server/data default (production). The watchdog journal + logs now
// stay inside the sandboxed data root when the override is set.
const DATA_DIR = process.env.SMARTAI_DATA_DIR
  ? path.resolve(process.env.SMARTAI_DATA_DIR)
  : path.join(__dirname, 'data');

const LOG_ROTATE_BYTES = 5 * 1024 * 1024; // 5MB
const JOURNAL_MAX_LINES = 60; // same cap as selfHeal journal

function _int(val, def, min, max) {
  // Out-of-range = garbage, NOT a silently clamped dangerous value
  // (e.g. WATCHDOG_FAILS=-4 must mean "default 3", not clamp-to-1).
  const n = parseInt(val, 10);
  if (!Number.isFinite(n) || n < min || n > max) return def;
  return n;
}

function _appendJournalEntry(file, entry) {
  try {
    const dir = path.dirname(file);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(file, JSON.stringify({ pid: process.pid, ...entry }) + '\n');
    try {
      const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
      if (lines.length > JOURNAL_MAX_LINES) {
        fs.writeFileSync(file, lines.slice(-JOURNAL_MAX_LINES).join('\n') + '\n');
      }
    } catch { /* cap best-effort */ }
  } catch { /* journal is diagnostics, never fatal */ }
}

/**
 * Factory (injectable deps for tests). Returns
 * { start, stop, _i } — _i exposes internals for unit tests.
 */
export function createSupervisor(opts = {}) {
  const env = opts.env || process.env;

  const knobs = {
    port: _int(env.WATCHDOG_PORT || env.PORT, 8080, 1, 65535),
    probeMs: _int(env.WATCHDOG_PROBE_MS, 20000, 3000, 600000),
    timeoutMs: _int(env.WATCHDOG_TIMEOUT_MS, 9000, 1000, 120000),
    fails: _int(env.WATCHDOG_FAILS, 3, 1, 20),
    graceMs: _int(env.WATCHDOG_GRACE_MS, 45000, 5000, 600000),
    backoffBaseMs: _int(env.WATCHDOG_BACKOFF_BASE_MS, 3000, 1000, 600000),
    backoffMaxMs: _int(env.WATCHDOG_BACKOFF_MAX_MS, 60000, 4000, 900000),
    stableResetMs: _int(env.WATCHDOG_STABLE_RESET_MS, 600000, 60000, 86400000),
    maxRestartsHour: _int(env.WATCHDOG_MAX_RESTARTS_HOUR, 20, 3, 1000),
    budgetPauseMs: _int(env.WATCHDOG_BUDGET_PAUSE_MS, 600000, 10000, 86400000),
    probesOn: env.WATCHDOG_DISABLE !== '1',
    // v20.0.1: fresh-install deps self-heal (see header).
    // v20.8.4 FIX (L): accept ALL the natural "off" spellings — only an
    // exact '0' used to disable, so WATCHDOG_AUTO_BUILD=false/off silently
    // left auto-build ON (a user following the sibling knobs' conventions
    // got the opposite of what they asked for).
    autoInstall: !['0', 'false', 'off', 'no'].includes(String(env.WATCHDOG_AUTO_INSTALL ?? '').toLowerCase()),
    installTimeoutMs: _int(env.WATCHDOG_INSTALL_TIMEOUT_MS, 900000, 30000, 3600000),
    // v20.8.3 ALWAYS-LATEST: dist/ stale/missing ho to KHUD npm install +
    // vite build chala dega (zip-overlay update ka guaranteed fresh-build path).
    autoBuild: !['0', 'false', 'off', 'no'].includes(String(env.WATCHDOG_AUTO_BUILD ?? '').toLowerCase()),
    buildTimeoutMs: _int(env.WATCHDOG_BUILD_TIMEOUT_MS, 900000, 60000, 3600000),
    // v20.8.4 FIX (H2): single-instance lock — two double-clicked watchdogs
    // used to run CONCURRENT npm installs in the same dir (EPERM/rename
    // corruption on Windows) and then mask each other's crash-loop (both
    // probe the same port; the FIRST server answers both).
    lockFile: env.WATCHDOG_LOCK_FILE || path.join(DATA_DIR, 'watchdog.lock'),
    lockStaleMs: _int(env.WATCHDOG_LOCK_STALE_MS, 12 * 3600_000, 60_000, 30 * 86400_000),
    // child entry override (tests / custom boot chains); default = the real server
    childEntry: env.WATCHDOG_CHILD || opts.serverEntry || SERVER_ENTRY,
    logFilePath: env.WATCHDOG_LOG_FILE === 'off' ? null
      : (env.WATCHDOG_LOG_FILE || path.join(DATA_DIR, 'logs', 'server.log')),
    journalFile: env.WATCHDOG_JOURNAL || path.join(DATA_DIR, 'exit-reasons.log'),
  };

  const deps = {
    spawnFn: opts.spawnFn || spawn,
    httpGetFn: opts.httpGetFn || ((...a) => http.get(...a)),
    nowFn: opts.nowFn || (() => Date.now()),
    logFn: opts.logFn || ((line) => { try { process.stdout.write(line); } catch { /* frozen console never kills us */ } }),
    journalAppendFn: opts.journalAppendFn || ((entry) => _appendJournalEntry(knobs.journalFile, entry)),
    platformFn: opts.platformFn || (() => process.platform),
    nodeExe: opts.nodeExe || process.execPath,
    appRoot: env.WATCHDOG_APP_ROOT || opts.appRoot || APP_ROOT,
    fsMod: opts.fsMod || fs,
  };

  const state = {
    started: false,
    shuttingDown: false,
    child: null,
    childStartedAt: 0,
    failsStreak: 0,
    restarts: 0,
    restartHistory: [],
    backoffDelayMs: knobs.backoffBaseMs,
    nextRestartAt: 0,
    pendingReason: null,
    budgetPausedUntil: 0,
    budgetBannerShown: false,
    depsInstallTries: 0,
    installingDeps: false,
    // v20.8.3: frontend build state — boot-phase gating (race-free, installingDeps jaisa)
    frontendBuildTries: 0,
    buildingFrontend: false,
    // v20.8.4: set in _boot once the frontend has EVER been fresh this
    // run — the child-exit rebuild path only applies when we previously
    // HAD a working dist (a fresh-install fixture / never-booted supervisor
    // must keep the exact v19.2 crash-restart behavior).
    frontendEverFresh: false,
    childModuleErr: false,
    upAnnounced: false,
    probeTimer: null,
    tickTimer: null,
    // v21.12.0 CODE-UPGRADE GUARD state — "naya zip extract kiya par
    // purana server process RAM me chalta raha" disease ka structural
    // fix (user ka 13-models report isi se aaya: UI naya, server purana).
    codeMismatchStreak: 0,      // consecutive probes jisme running v != disk v
    codeMismatchDiskV: null,    // mismatch window ka DISK version (stability ke liye same hona chahiye)
    lastUpgradeTarget: null,    // jis disk-version ke liye humne restart kar diya (loop-guard)
    upgradeRestarts: 0,         // is supervisor boot me kitne upgrade-restarts (cap 3)
  };

  const now = () => deps.nowFn();

  function journal(entry) {
    try { deps.journalAppendFn({ at: now(), supervisorPid: process.pid, ...entry }); } catch { /* never fatal */ }
  }

  function log(line) {
    // Single funnel: console + (optional) file log. The FILE must carry
    // supervisor lines too — the console may be lost (QuickEdit/closed
    // window) but the file is the diagnostic record.
    const text = String(line).replace(/\n$/, '');
    try { deps.logFn(text + '\n'); } catch { /* never fatal */ }
    if (knobs.logFilePath) _appendLog(text + '\n');
  }

  // (v21.14: Laya sidecar wiring removed — supervisor ab sirf site child
  //  manage karta hai. Historical note: yahan supervisor-managed local
  //  AI ka adopt/spawn/ready-poll/hang-detect/crash-restart hota tha;
  //  Laya removal ke saath poora surface retire ho gaya.)

  // ---------------- child stdout relay + file log ----------------
  function _appendLog(line) {
    const f = knobs.logFilePath;
    if (!f) return;
    try {
      const dir = path.dirname(f);
      if (!deps.fsMod.existsSync(dir)) deps.fsMod.mkdirSync(dir, { recursive: true });
      deps.fsMod.appendFileSync(f, line);
      try {
        const st = deps.fsMod.statSync(f);
        if (st.size > LOG_ROTATE_BYTES) {
          try { deps.fsMod.rmSync(f + '.2', { force: true }); } catch { /* best-effort */ }
          try { deps.fsMod.renameSync(f + '.1', f + '.2'); } catch { /* first rotation */ }
          try { deps.fsMod.renameSync(f, f + '.1'); } catch { /* best-effort */ }
        }
      } catch { /* stat/rotate best-effort */ }
    } catch { /* log file never fatal */ }
  }

  function _emitLine(line, isErr) {
    log((isErr ? '[srv:err] ' : '') + line);
    // v20.0.1: crash ki ASLI wajah pakdo — ERR_MODULE_NOT_FOUND =
    // node_modules adha/gayab. Is signal ke bina restart loop galat
    // "port conflict" hint de deta tha (live bug D:\SmartAI26).
    if (isErr && typeof line === 'string' && line.includes('ERR_MODULE_NOT_FOUND')) {
      state.childModuleErr = true;
    }
  }

  function _relayChild(child) {
    const mk = (isErr) => {
      let buf = '';
      const handler = (d) => {
        try {
          buf += String(d || '');
          let idx;
          while ((idx = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, idx).replace(/\r$/, '');
            buf = buf.slice(idx + 1);
            if (line.trim()) _emitLine(line, isErr);
          }
        } catch { /* relay never fatal */ }
      };
      // v20.0.1: exit pe adhi (bina newline wali) line bhi flush —
      // ERR_MODULE_NOT_FOUND aksri aadhi line me mila tha (live bug:
      // sniff miss ho gaya tha kyunki line buffer me atki rahi).
      handler.flush = () => {
        try {
          if (buf.trim()) _emitLine(buf.replace(/\r$/, ''), isErr);
          buf = '';
        } catch { /* never fatal */ }
      };
      return handler;
    };
    const outH = mk(false);
    const errH = mk(true);
    try {
      child.stdout.on('data', outH);
      child.stderr.on('data', errH);
      child.on('exit', () => { try { outH.flush(); errH.flush(); } catch { /* noop */ } });
    } catch { /* relay never fatal */ }
  }

  // ---------------- process control ----------------
  function forceKill(child) {
    try {
      if (!child) return;
      if (deps.platformFn() === 'win32' && child.pid) {
        // /T = tree kill: telegram-bot / ml children bhi (agar hon)
        deps.spawnFn('taskkill', ['/F', '/T', '/PID', String(child.pid)], { stdio: 'ignore' });
      } else {
        // v20.7.8 [M5]: POSIX tree-kill. The child is spawned detached
        // (= own process group leader), so a negative-PID signal kills
        // the WHOLE tree — the forked telegram-bot survives a plain
        // child.kill('SIGKILL') (SIGKILL can't be caught, so the child's
        // own shutdown handler never runs). Direct kill follows as
        // belt-and-braces (also keeps the fake-child kill log honest).
        if (child.pid) {
          try { process.kill(-child.pid, 'SIGKILL'); } catch { /* not a leader / already gone */ }
        }
        child.kill('SIGKILL');
      }
    } catch { /* already dead — exit event will fire */ }
  }

  function startChild() {
    if (state.shuttingDown || state.child || state.installingDeps || state.buildingFrontend) return null;
    journal({ ev: 'watchdog-boot', reason: 'child-start', restart: state.restarts });
    log('[watchdog] server start ho raha hai...');
    let child;
    try {
      child = deps.spawnFn(deps.nodeExe, [knobs.childEntry], {
        cwd: deps.appRoot,
        env: { ...env, SMARTAI_SUPERVISED: '1' },
        stdio: ['ignore', 'pipe', 'pipe'],
        // v20.7.8 [M5]: own process group on POSIX — lets forceKill()
        // tree-kill via negative-PID signal. (Windows: taskkill /T owns
        // the tree; detached there changes console semantics, so off.)
        detached: deps.platformFn() !== 'win32',
      });
    } catch (err) {
      journal({ ev: 'watchdog-crash', reason: 'spawn-fail', detail: String(err && err.message || err).slice(0, 120) });
      log(`[watchdog] child spawn FAIL: ${String(err && err.message || err).slice(0, 120)}`);
      _scheduleRestart('spawn-fail');
      return null;
    }
    state.child = child;
    state.childStartedAt = now();
    state.failsStreak = 0;
    state.pendingReason = null;
    state.upAnnounced = false;
    state.childModuleErr = false;
    // v20.0.1: spawn hone pe "UP" nahi bolte — crash pe jhootha lagta
    // tha. UP tab bolte hain jab pehla /api/ping OK ho (onProbeResult).
    log(`[watchdog] server START (pid ${child.pid}) — pehla /api/ping OK milte hi UP kahenge`);
    _relayChild(child);
    try {
      child.on('error', (err) => {
        if (state.shuttingDown) return;
        journal({ ev: 'watchdog-crash', reason: 'spawn-error', detail: String(err && err.code || err).slice(0, 80) });
        state.child = null;
        _scheduleRestart('spawn-error');
      });
      child.on('exit', (code, signal) => _onChildExit(code, signal));
    } catch { /* wiring never fatal */ }
    return child;
  }

  function _onChildExit(code, signal) {
    if (state.shuttingDown) return; // stop() owns the journal
    const uptimeMs = now() - state.childStartedAt;
    if (uptimeMs >= knobs.stableResetMs) {
      state.backoffDelayMs = knobs.backoffBaseMs; // stable run — reset backoff
    }
    // verdict: 'freeze' | 'boot-hang' (journal already written before the
    // kill) | null = plain crash exit (journal HERE).
    const verdict = state.pendingReason;
    const wasModuleErr = state.childModuleErr && !verdict;
    if (!verdict) {
      journal({
        ev: 'watchdog-restart',
        reason: wasModuleErr ? `deps-missing(exit(${signal || code}))` : `exit(${signal || code})`,
        code, signal, uptimeSec: Math.round(uptimeMs / 1000),
      });
    }
    log(`[watchdog] server band hua (${signal || `code ${code}`}) — uptime ${Math.round(uptimeMs / 1000)}s`);
    if (wasModuleErr) {
      // v20.0.1 HONEST diagnosis: dependency missing thi (node_modules
      // adha ya gayab — fresh install bina npm install). "port conflict"
      // hint is case me galat tha.
      state.childModuleErr = false;
      if (knobs.autoInstall && state.depsInstallTries < 2) {
        log('[watchdog] reason pakda gaya: DEPENDENCY MISSING (node_modules me package nahi mila) — npm install auto chal raha hai...');
        _depsRecoveryRestart();
      } else {
        log('[watchdog] reason pakda gaya: DEPENDENCY MISSING. Auto-install off/limit — khud chalao: app folder me "npm install --omit=dev" phir watchdog dobara chalao.');
        _scheduleRestart('deps-missing', 60000);
      }
    } else {
      if (!verdict && uptimeMs < 10000) {
        log('[watchdog] boot ke 10s ke andar crash — port conflict (kya 8080 pe dusra instance?) ya config issue. Console output upar dekho.');
      }
      _scheduleRestart(verdict || `exit(${signal || code})`);
    }
    // v20.8.4 FIX (H3 — the 503 promise): ensureFrontend runs ONLY in
    // _boot() (before any server exists), and the 1-attempt build limit
    // then blocks rebuilds until the SUPERVISOR itself restarts — so a
    // runtime-deleted/corrupted dist served the 503 "khud theek ho jayega"
    // page forever. A child exit is a natural retry point: reset the
    // attempt counter and re-run the stamp check (buildingFrontend gates
    // startChild, so the restart happens AFTER the rebuild). Gated on
    // frontendEverFresh so never-booted/fixture supervisors keep the pure
    // crash-restart semantics.
    if (!state.shuttingDown && !state.buildingFrontend && state.frontendEverFresh && !_frontendFresh()) {
      state.frontendBuildTries = 0;
      ensureFrontend().catch(() => { /* never fatal */ });
    }
    state.child = null;
    state.pendingReason = null;
    state.failsStreak = 0;
  }

  // v20.0.1: module-err crash ke baad — deps install karo, PHIR restart
  // schedule karo (install ke dauran tick/startChild blocked = race-free).
  async function _depsRecoveryRestart() {
    try {
      await ensureDeps();
    } catch { /* never fatal */ }
    if (state.shuttingDown) return;
    _scheduleRestart('deps-missing');
  }

  function _scheduleRestart(reason, delayOverride) {
    if (state.shuttingDown) return;
    const t = now();
    const hourAgo = t - 3600000;
    state.restartHistory = state.restartHistory.filter((x) => x > hourAgo);
    if (state.restartHistory.length >= knobs.maxRestartsHour) {
      if (state.budgetPausedUntil <= t) {
        state.budgetPausedUntil = t + knobs.budgetPauseMs;
        state.budgetBannerShown = false;
        journal({ ev: 'watchdog-budget-pause', reason: 'restart-budget', restarts: state.restarts });
        log(`[watchdog] RESTART BUDGET khatam (${knobs.maxRestartsHour}/hour) — ${Math.round(knobs.budgetPauseMs / 60000)} min ruk kar wapas khud start hoga.`);
      }
    }
    const delay = delayOverride != null ? delayOverride : state.backoffDelayMs;
    if (delayOverride == null) state.backoffDelayMs = Math.min(state.backoffDelayMs * 2, knobs.backoffMaxMs);
    state.nextRestartAt = t + delay;
    state.restartHistory.push(t);
    state.restarts++;
    log(`[watchdog] restart #${state.restarts} ${Math.round(delay / 1000)}s baad (${reason})`);
  }

  function _restartTick() {
    if (state.shuttingDown || !state.started) return;
    if (state.child || state.installingDeps || state.buildingFrontend) return;
    const t = now();
    if (state.budgetPausedUntil > t) {
      if (!state.budgetBannerShown) {
        state.budgetBannerShown = true;
        log(`[watchdog] budget pause active — ${Math.round((state.budgetPausedUntil - t) / 1000)}s baad resume.`);
      }
      return;
    }
    if (state.nextRestartAt && t >= state.nextRestartAt) {
      state.nextRestartAt = 0;
      startChild();
    }
  }

  // ---------------- liveness probe ----------------
  // v21.12.0: probe ab /api/ping ka BODY bhi padhta hai (v = SERVER_VERSION
  // of the RUNNING child) — onProbeResult isko disk ke package.json se
  // compare karta hai (code-upgrade guard, neeche). Body parse fail / mock
  // httpGetFn jo data emit nahi karta → v undefined → guard no-op (safe).
  function probeOnce() {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (ok, why, v) => { if (!settled) { settled = true; resolve({ ok, why, v }); } };
      let req;
      try {
        req = deps.httpGetFn({
          host: '127.0.0.1', port: knobs.port, path: '/api/ping',
          timeout: knobs.timeoutMs, agent: false,
        }, (res) => {
          let body = '';
          let v;
          try {
            res.on('data', (d) => { if (body.length < 4096) body += String(d || ''); });
            res.resume();
          } catch { /* body best-effort */ }
          const onDone = () => {
            try {
              const j = body ? JSON.parse(body) : null;
              if (j && typeof j.v === 'string') v = j.v;
            } catch { /* non-JSON body — v stays undefined */ }
            finish(
              res.statusCode >= 200 && res.statusCode < 500,
              `status-${res.statusCode}`,
              v,
            );
          };
          res.on('end', onDone);
          res.on('error', () => finish(false, 'res-error'));
        });
      } catch (err) {
        finish(false, `throw-${String(err && err.code || err).slice(0, 40)}`);
        return;
      }
      if (!req || typeof req.on !== 'function') { finish(false, 'no-request'); return; }
      req.on('timeout', () => { try { req.destroy(); } catch { /* noop */ } finish(false, 'timeout'); });
      req.on('error', (err) => finish(false, String(err && err.code || 'error').slice(0, 40)));
    });
  }

  // v21.12.0 CODE-UPGRADE GUARD — running child ka SERVER_VERSION (/api/ping
  // `v`) vs disk ka package.json version. Mismatch = naya code extract hua
  // hai par purana process abhi RAM me chal raha hai (exact wahi bug jisme
  // user ke box pe naya UI + PURANA 13-model server tha). Design guards:
  //   • 2 CONSECUTIVE same-disk-version mismatches — zip extract ke
  //     mid-way race (aadhi files nayi) me restart nahi hoga.
  //   • Ek hi disk-version ke liye SIRF EK upgrade-restart — partial
  //     deploy (server files purani, package.json nayi) me loop nahi.
  //   • Max 3 upgrade-restarts per supervisor boot.
  //   • fs read fail / v missing / version strings empty → guard no-op.
  function _diskPkgVersion() {
    try {
      const pkg = JSON.parse(deps.fsMod.readFileSync(path.join(deps.appRoot, 'package.json'), 'utf8'));
      return String(pkg.version || '').trim() || null;
    } catch { return null; }
  }

  function _checkCodeUpgrade(result) {
    if (!result || !result.ok || !result.v) { state.codeMismatchStreak = 0; state.codeMismatchDiskV = null; return; }
    const diskV = _diskPkgVersion();
    if (!diskV || diskV === result.v) { state.codeMismatchStreak = 0; state.codeMismatchDiskV = null; return; }
    // disk window stability — mid-extraction race protection
    if (state.codeMismatchDiskV !== diskV) {
      state.codeMismatchDiskV = diskV;
      state.codeMismatchStreak = 1;
      log(`[watchdog] CODE UPGRADE dikha (running v${result.v} · disk v${diskV}) — confirm ho raha hai...`);
      return;
    }
    state.codeMismatchStreak++;
    if (state.codeMismatchStreak < 2) return;
    if (state.lastUpgradeTarget === diskV) {
      // isi target ke liye restart kar chuke hain — ab bhi mismatch = partial
      // deploy. DOOSRA restart loop nahi (user ko hint de do).
      if (state.codeMismatchStreak === 2) {
        log(`[watchdog] CODE UPGRADE restart ke baad bhi v${result.v} != v${diskV} — deploy partial lagta hai (server files purani?). Khud restart karo: watchdog band karke Start-SmartAI-Watchdog.bat dobara chalao.`);
      }
      return;
    }
    if (state.upgradeRestarts >= 3) {
      log('[watchdog] CODE UPGRADE detected par upgrade-restart cap (3) cross ho gaya — manual restart karo.');
      return;
    }
    journal({
      ev: 'watchdog-restart', reason: 'code-upgrade',
      detail: `running v${result.v} != disk v${diskV} — naya code load karne ke liye restart`,
      childPid: state.child.pid, uptimeSec: Math.round((now() - state.childStartedAt) / 1000),
    });
    log(`[watchdog] CODE UPGRADE DETECTED — running v${result.v}, disk v${diskV} — naya code load ho raha hai (server restart, auto)...`);
    state.lastUpgradeTarget = diskV;
    state.upgradeRestarts++;
    state.codeMismatchStreak = 0;
    state.pendingReason = 'code-upgrade';
    forceKill(state.child);
  }

  function onProbeResult(result) {
    const t = now();
    if (!state.child) { state.failsStreak = 0; return; } // restart gap — nothing to judge
    if (result.ok) {
      // v21.12.0: code-upgrade guard pehle — UP-announce/failed-streak
      // bookkeeping baad me (guard forceKill kar sakta hai).
      try { _checkCodeUpgrade(result); } catch { /* guard never fatal */ }
      if (!state.upAnnounced && state.child && state.child.pid) {
        state.upAnnounced = true;
        log(`[watchdog] server UP (pid ${state.child.pid}) — /api/ping OK, aage har ${Math.round(knobs.probeMs / 1000)}s probe`);
        // v20.9.3 FIX (M): BACKUP_STATE_ON_BOOT=1 ab actually wired hai —
        // backup-state.mjs ke header me documented tha par supervisor me
        // reference hi nahi tha (doc/env lie). Child UP hone pe EK baar
        // (per supervisor boot) state backup chalao; failure non-fatal.
        if (String(env.BACKUP_STATE_ON_BOOT || '').trim() === '1' && !state._bootBackupRan) {
          state._bootBackupRan = true;
          try {
            deps.spawnFn(deps.nodeExe, [path.join(APP_ROOT, 'scripts', 'backup-state.mjs')], {
              cwd: APP_ROOT, env: { ...env }, stdio: 'ignore', detached: false,
            }).on('error', () => { /* backup best-effort */ });
            log('[watchdog] BACKUP_STATE_ON_BOOT — state backup chal raha hai (background)');
          } catch { /* backup never fatal */ }
        }
      }
      if (state.failsStreak > 0) {
        log(`[watchdog] probe OK wapas (fail-streak ${state.failsStreak} khatam)`);
      }
      state.failsStreak = 0;
      return;
    }
    state.failsStreak++;
    const uptimeMs = t - state.childStartedAt;
    const inGrace = uptimeMs < knobs.graceMs;
    if (state.failsStreak === 1) {
      log(`[watchdog] probe FAIL #1 (${result.why}) — dekh rahe hain`);
    }
    const hangLimit = knobs.fails + 3;
    if (state.failsStreak >= hangLimit && inGrace) {
      // boot grace ke bhi andar itne fails = child kabhi UP hi nahi hua
      journal({
        ev: 'watchdog-restart', reason: 'boot-hang',
        detail: `${state.failsStreak} probe fail boot grace ke andar (server kabhi UP nahi hua)`,
        childPid: state.child.pid, uptimeSec: Math.round(uptimeMs / 1000),
      });
      log('[watchdog] BOOT HANG detected — force restart');
      state.pendingReason = 'boot-hang';
      forceKill(state.child);
      return;
    }
    if (state.failsStreak >= knobs.fails && !inGrace) {
      journal({
        ev: 'watchdog-restart', reason: 'freeze',
        detail: `${state.failsStreak} consecutive probe fail (event-loop unresponsive)`,
        childPid: state.child.pid, uptimeSec: Math.round(uptimeMs / 1000),
      });
      log('[watchdog] SERVER HANG (FREEZE) detected — force-kill + restart kar rahe hain');
      state.pendingReason = 'freeze';
      forceKill(state.child);
    }
  }

  // ---------------- v20.0.1 dependency self-heal ----------------
  // v20.0.1: ye 5 dependencies SIRF frontend BUILD time pe chahiye
  // (dist/ pehle se built + shipped hai) — runtime pe server inhe
  // kabhi import nahi karta. Offline node_modules bundle me ye nahi
  // hote (zip ~4x chhota), isliye audit inhe skip karta hai. Naya/
  // unknown package.json dep -> hamesha check hoga (fail-safe).
  const FRONTEND_BUILD_ONLY = new Set([
    'react', 'react-dom', 'lucide-react', 'motion', 'lightweight-charts',
  ]);

  function _missingDeps() {
    try {
      const pkgFile = deps.fsMod.readFileSync(path.join(deps.appRoot, 'package.json'), 'utf8');
      const depsList = Object.keys(JSON.parse(pkgFile).dependencies || {})
        .filter((name) => !FRONTEND_BUILD_ONLY.has(name));
      const missing = [];
      for (const name of depsList) {
        const dir = path.join(deps.appRoot, 'node_modules', ...name.split('/'));
        if (!deps.fsMod.existsSync(dir)) missing.push(name);
      }
      return missing;
    } catch {
      return []; // package.json na mile = fixture/legacy layout — audit skip
    }
  }

  // v21.0 TELEGRAM-BOT DEPS SELF-HEAL (telegram fix T1): server index.js
  // telegram-bot/bot.mjs ko FORK karta hai, par ye watchdog sirf ROOT
  // package.json audit karta tha — telegram-bot/node_modules (apna alag
  // package.json: node-telegram-bot-api, node-cron, express, dotenv)
  // kabhi install NAHI hota tha → forked bot ERR_MODULE_NOT_FOUND se
  // crash-loop (5s→5min backoff) — saare scheduled digests/algo alerts
  // kabhi nahi pahunchte the aur koi surface reason nahi dikhata tha.
  function _missingBotDeps() {
    try {
      const botDir = path.join(deps.appRoot, 'telegram-bot');
      const pkgFile = deps.fsMod.readFileSync(path.join(botDir, 'package.json'), 'utf8');
      const depsList = Object.keys(JSON.parse(pkgFile).dependencies || {});
      const missing = [];
      for (const name of depsList) {
        const dir = path.join(botDir, 'node_modules', ...name.split('/'));
        if (!deps.fsMod.existsSync(dir)) missing.push(name);
      }
      return missing;
    } catch {
      return []; // telegram-bot/ na ho (koi feature-cut install) — skip
    }
  }

  function _runBotInstall() {
    // npm --prefix <dir> install — telegram-bot/package.json ke saath.
    return _runNpmCommand(['install', '--omit=dev', '--no-audit', '--no-fund', '--loglevel=error', '--prefix', 'telegram-bot'], knobs.installTimeoutMs);
  }

  async function ensureBotDeps() {
    if (!knobs.autoInstall) return { ok: true, skipped: 'auto-install-off' };
    const missing = _missingBotDeps();
    if (!missing.length) return { ok: true, missing: [] };
    log(`[watchdog] telegram-bot/node_modules missing hai (${missing.join(', ')}) — bot crash-loop ka #1 reason tha. npm install chal raha hai...`);
    journal({ ev: 'watchdog-bot-deps-install', reason: 'telegram-bot-node-modules-missing', missing: missing.slice(0, 8) });
    const r = await _runBotInstall();
    const still = _missingBotDeps();
    if (r.ok && !still.length) {
      log('[watchdog] telegram-bot deps complete — bot ab fork hoga.');
      return { ok: true, missing: [] };
    }
    log(`[watchdog] telegram-bot npm install adhura (${r.ok ? 'still: ' + still.join(', ') : 'code ' + r.code}) — bot khud chalao: npm --prefix telegram-bot install`);
    return { ok: false, missing: still.length ? still : missing };
  }

  // v20.8.3: generalized npm runner — ensureDeps (install --omit=dev)
  // aur ensureFrontend (full install + run build) dono isi se chalte
  // hain. Spawn contract wahi hai jo supervisorGuard tests lock karte
  // hain (win32 npm.cmd + shell, line-relay, timeout taskkill, exit-code
  // verdict) — isliye _runNpmInstall ka behaviour byte-identical hai.
  function _runNpmCommand(args, timeoutMs) {
    return new Promise((resolve) => {
      const isWin = deps.platformFn() === 'win32';
      const npmCmd = isWin ? 'npm.cmd' : 'npm';
      let child;
      try {
        child = deps.spawnFn(npmCmd, args, {
          cwd: deps.appRoot,
          env: { ...env, npm_config_loglevel: 'error' },
          stdio: ['ignore', 'pipe', 'pipe'],
          shell: isWin, // win32 pe npm.cmd shell se hi resolve hota hai
          // v20.8.4 FIX (H3 — POSIX orphan npm): detached on POSIX so the
          // timeout branch can TREE-kill the whole group (npm -> vite ->
          // esbuild children). A plain child.kill() leaves vite writing
          // dist/ hashes UNDER a server that already started serving —
          // mixed-version assets pinned for a year by immutable caching.
          detached: !isWin,
        });
      } catch (err) {
        resolve({ ok: false, code: `spawn-fail:${String(err && err.code || err).slice(0, 60)}` });
        return;
      }
      if (!child || typeof child.on !== 'function') {
        resolve({ ok: false, code: 'no-child' });
        return;
      }
      const relay = (isErr) => {
        let buf = '';
        return (d) => {
          try {
            buf += String(d || '');
            let idx;
            while ((idx = buf.indexOf('\n')) >= 0) {
              const line = buf.slice(0, idx).replace(/\r$/, '').trim();
              buf = buf.slice(idx + 1);
              if (line) log(`[npm] ${isErr ? 'ERR ' : ''}${line}`);
            }
          } catch { /* never fatal */ }
        };
      };
      try {
        if (child.stdout && child.stdout.on) child.stdout.on('data', relay(false));
        if (child.stderr && child.stderr.on) child.stderr.on('data', relay(true));
      } catch { /* never fatal */ }
      let settled = false;
      const t = setTimeout(() => {
        try { child.kill(); } catch { /* noop */ }
        if (isWin && child.pid) {
          try { deps.spawnFn('taskkill', ['/F', '/T', '/PID', String(child.pid)], { stdio: 'ignore' }); } catch { /* noop */ }
        } else if (child.pid) {
          // v20.8.4: POSIX tree-kill (npm is a group leader — see detached)
          try { process.kill(-child.pid, 'SIGKILL'); } catch { /* not a leader / already gone */ }
        }
        finish({ ok: false, code: 'timeout' });
      }, timeoutMs || knobs.installTimeoutMs);
      const finish = (r) => { if (!settled) { settled = true; clearTimeout(t); resolve(r); } };
      try {
        child.on('error', (err) => finish({ ok: false, code: `npm-spawn-error:${String(err && err.code || err).slice(0, 40)}` }));
        child.on('exit', (code2) => finish({ ok: code2 === 0, code: String(code2) }));
      } catch { finish({ ok: false, code: 'wire-fail' }); }
    });
  }

  function _runNpmInstall() {
    return _runNpmCommand(['install', '--omit=dev', '--omit=optional', '--no-audit', '--no-fund', '--loglevel=error'], knobs.installTimeoutMs);
  }

  async function ensureDeps() {
    if (!knobs.autoInstall) return { ok: true, skipped: 'auto-install-off' };
    const missing = _missingDeps();
    if (!missing.length) return { ok: true, missing: [] };
    if (state.depsInstallTries >= 2) {
      log(`[watchdog] deps phir missing hain (${missing.slice(0, 3).join(', ')}${missing.length > 3 ? ` +${missing.length - 3}` : ''}) — auto-install limit (2) hit. Khud chalao: "npm install" (${deps.appRoot} me), phir watchdog restart.`);
      return { ok: false, missing, gaveUp: true };
    }
    state.depsInstallTries++;
    state.installingDeps = true;
    journal({ ev: 'watchdog-deps-install', reason: 'missing-node-modules', missing: missing.slice(0, 8) });
    log(`[watchdog] node_modules missing hai (${missing.slice(0, 4).join(', ')}${missing.length > 4 ? ` +${missing.length - 4} aur` : ''}) — npm install chal raha hai (internet chahiye, 1-3 min, max ${Math.round(knobs.installTimeoutMs / 60000)} min)...`);
    const r = await _runNpmInstall();
    state.installingDeps = false;
    if (r.ok) {
      const still = _missingDeps();
      if (still.length) {
        log(`[watchdog] npm install ke BAAD bhi missing: ${still.join(', ')} — package.json / Node version check karo (Node >= 20 chahiye).`);
        return { ok: false, missing: still };
      }
      log('[watchdog] npm install complete — saari dependencies ready. Server start ho raha hai...');
      return { ok: true, missing: [] };
    }
    log(`[watchdog] npm install FAIL (${r.code}) — internet/proxy check karo. Bina deps ke try kar rahe hain (crash ka honest reason upar aayega).`);
    return { ok: false, code: r.code, missing };
  }

  // ---------------- v20.8.3 ALWAYS-LATEST frontend self-heal ----------------
  // THE "v20.7.5 SERVE" BUG: server frontend SIRF dist/ se serve karta
  // hai (vite build output, .gitignore me). Code-zip me dist nahi hota —
  // naya zip purane folder pe overlay karne par PURANA dist serve hota
  // rehta hai (UI purana version badge dikhata hai). Ab boot pe:
  //   dist/index.html missing  YA  dist/.build-version != package.json
  //   version  ->  FULL npm install (dev deps bhi — vite chahiye) +
 //   `npm run build` (postbuild khud .build-version stamp likhta hai).
  // Stamp match = zero work (shipped-dist zip turant boot hota hai).
  function _codeVersion() {
    try {
      return String(JSON.parse(deps.fsMod.readFileSync(path.join(deps.appRoot, 'package.json'), 'utf8')).version || '');
    } catch { return ''; }
  }

  function _distStamp() {
    try {
      return String(deps.fsMod.readFileSync(path.join(deps.appRoot, 'dist', '.build-version'), 'utf8')).trim();
    } catch { return ''; }
  }

  function _frontendFresh() {
    try {
      const idxPath = path.join(deps.appRoot, 'dist', 'index.html');
      if (!deps.fsMod.existsSync(idxPath)) return false;
      // Asset integrity guard: index.html me script/css hashed filenames hote hain.
      // Agar unme se koi file dist/assets me missing ho to frontend blank ho jayega!
      try {
        const html = deps.fsMod.readFileSync(idxPath, 'utf8');
        if (typeof html === 'string') {
          const matches = html.matchAll(/(?:src|href)=["'](?:\.\/|\/)?assets\/([^"']+)["']/g);
          for (const m of matches) {
            const assetPath = path.join(deps.appRoot, 'dist', 'assets', m[1]);
            if (!deps.fsMod.existsSync(assetPath)) return false;
          }
        }
      } catch { /* mock fs / unreadable fallback to stamp check */ }
    } catch { return false; }
    const code = _codeVersion();
    // package.json na mile = fixture/legacy layout — kabhi force-build na karo
    if (!code) return true;
    return _distStamp() === code;
  }

  async function ensureFrontend() {
    if (_frontendFresh()) return { ok: true, skipped: 'fresh' };
    const codeV = _codeVersion();
    const stampV = _distStamp();
    if (!knobs.autoBuild) {
      log('[watchdog] dist/ STALE/missing hai par auto-build OFF (WATCHDOG_AUTO_BUILD=0) — PURANA frontend serve hoga! Khud chalao: npm install && npm run build.');
      journal({ ev: 'frontend-build', reason: 'skipped-auto-build-off', codeVersion: codeV || 'unknown', distStamp: stampV || 'none' });
      return { ok: false, skipped: 'auto-build-off' };
    }
    if (state.frontendBuildTries >= 1) {
      log('[watchdog] frontend build pehle hi fail hua tha — auto-build limit (1/run) hit. Khud chalao: npm install phir npm run build (Node >= 20 + internet).');
      return { ok: false, gaveUp: true };
    }
    state.frontendBuildTries++;
    state.buildingFrontend = true;
    journal({ ev: 'frontend-build', reason: 'dist-stale-or-missing', codeVersion: codeV || 'unknown', distStamp: stampV || 'none' });
    log(`[watchdog] dist/ STALE (code=${codeV || '?'} dist=${stampV || 'none'}) — fresh frontend build chal raha hai (internet chahiye, pehli baar 2-5 min)...`);
    // FULL install (dev deps INCLUDED — vite/typescript build ke liye zaroori).
    // Ye runtime deps bhi cover kar deta hai, isliye iske baad ensureDeps
    // ka audit no-op niklega — double-install nahi hota.
    const install = await _runNpmCommand(['install', '--no-audit', '--no-fund', '--loglevel=error'], knobs.installTimeoutMs);
    if (!install.ok) {
      state.buildingFrontend = false;
      log(`[watchdog] npm install FAIL (${install.code}) — build nahi ho saka. Purana dist (agar hai) serve hoga; server crash hoga to reason journal me.`);
      return { ok: false, code: install.code };
    }
    log('[watchdog] deps ready — vite build chal raha hai...');
    const build = await _runNpmCommand(['run', 'build'], knobs.buildTimeoutMs);
    state.buildingFrontend = false;
    if (build.ok && _frontendFresh()) {
      log(`[watchdog] frontend build COMPLETE (v${codeV || _codeVersion() || '?'}) — FRESH site serve hogi.`);
      return { ok: true };
    }
    const why = build.ok ? 'stamp-mismatch-after-build' : build.code;
    log(`[watchdog] frontend build FAIL (${why}) — "npm run build" khud chalao aur output dekho (Node >= 20 chahiye).`);
    return { ok: false, code: why };
  }

  // ---------------- lifecycle ----------------
  // ---------------- v20.8.4 single-instance lock ----------------
  // The double-click hazard: two supervisors both see stale dist → two
  // concurrent `npm install`s in the SAME directory (Windows EPERM/rename
  // corruption of node_modules) → then both probe 127.0.0.1:8080 and the
  // FIRST server answers both, so supervisor #2 can never notice its own
  // child is crash-looping on EADDRINUSE. Lock = PID + timestamp file in
  // DATA_DIR; a dead PID or an aged-out file is take-over-able (stale).
  function _pidAlive(pid) {
    if (!pid || !Number.isFinite(pid)) return false;
    try { process.kill(pid, 0); return true; } catch (e) { return e?.code === 'EPERM'; }
  }
  function acquireLock() {
    try {
      let prev = null;
      try { prev = JSON.parse(deps.fsMod.readFileSync(knobs.lockFile, 'utf8')); } catch { /* no lock */ }
      if (prev && prev.pid) {
        const age = now() - (Number(prev.at) || 0);
        const stale = age > knobs.lockStaleMs || !_pidAlive(prev.pid);
        if (!stale) {
          return { ok: false, pid: prev.pid, path: knobs.lockFile, reason: 'another watchdog is running' };
        }
        journal({ ev: 'watchdog-lock', reason: 'stale-lock-takeover', prevPid: prev.pid, ageSec: Math.round(age / 1000) });
      }
      deps.fsMod.mkdirSync(path.dirname(knobs.lockFile), { recursive: true });
      deps.fsMod.writeFileSync(knobs.lockFile, JSON.stringify({ pid: process.pid, at: now() }));
      return { ok: true, pid: process.pid, path: knobs.lockFile };
    } catch (e) {
      // lock failure must NEVER kill the watchdog (read-only FS etc.) —
      // degrade to lock-less with a loud note.
      return { ok: true, degraded: true, error: String(e?.message || e).slice(0, 80) };
    }
  }
  function releaseLock() {
    try {
      const prev = JSON.parse(deps.fsMod.readFileSync(knobs.lockFile, 'utf8'));
      if (prev?.pid === process.pid) deps.fsMod.rmSync(knobs.lockFile, { force: true });
    } catch { /* never fatal */ }
  }
  // v20.8.4: belt-and-braces for a watchdog started from a DIFFERENT
  // DATA_DIR (lock file elsewhere) — if something already answers /api/ping
  // on our port, an instance is serving; a second one only adds a masked
  // crash-loop. Honest exit instead.
  function _portAlreadyServing() {
    return new Promise((resolve) => {
      let settled2 = false;
      const done = (v) => { if (!settled2) { settled2 = true; resolve(v); } };
      try {
        const req = deps.httpGetFn({ host: '127.0.0.1', port: knobs.port, path: '/api/ping', timeout: 1500, agent: false }, (res) => {
          try { res.resume(); } catch { /* noop */ }
          done(true);
        });
        if (!req || typeof req.on !== 'function') { done(false); return; }
        req.on('timeout', () => { try { req.destroy(); } catch { /* noop */ } done(false); });
        req.on('error', () => done(false));
      } catch { done(false); }
    });
  }

  function start() {
    if (state.started || state.shuttingDown) return;
    state.started = true;
    log('============================================================');
    log(' SMARTAI v21.14 ANTI-FREEZE SUPERVISOR (code-upgrade guard · auto-build)');
    log(`  child : ${deps.nodeExe} server${path.sep}index.js (SMARTAI_SUPERVISED=1)`);
    log(`  probe : /api/ping har ${Math.round(knobs.probeMs / 1000)}s (timeout ${Math.round(knobs.timeoutMs / 1000)}s, fails ${knobs.fails}, grace ${Math.round(knobs.graceMs / 1000)}s)`);
    log('  hang  : FREEZE = force-kill + restart | crash = backoff restart');
    log(`  budget: ${knobs.maxRestartsHour}/hour (phir ${Math.round(knobs.budgetPauseMs / 60000)} min pause)`);
    log(`  log   : ${knobs.logFilePath || 'off (console only)'} | journal: ${knobs.journalFile}`);
    log(knobs.autoInstall
      ? '  deps  : AUTO npm-install ON (node_modules missing ho to khud lagayega)'
      : '  deps  : auto npm-install OFF (WATCHDOG_AUTO_INSTALL=0)');
    log(knobs.autoBuild
      ? '  build : AUTO frontend-build ON (dist/ stale/mismatch ho to khud banayega — v20.8.3)'
      : '  build : auto frontend-build OFF (WATCHDOG_AUTO_BUILD=0)');
    log('  ye window khuli rakho (minimize OK). Ctrl+C = clean band.');
    log('============================================================');
    _boot();
    if (knobs.probesOn) {
      state.probeTimer = setInterval(() => {
        probeOnce().then((r) => { try { onProbeResult(r); } catch { /* never fatal */ } }).catch(() => { /* probe never fatal */ });
      }, knobs.probeMs);
    }
    state.tickTimer = setInterval(_restartTick, 1000);
    // v19.2 CRITICAL: these timers must keep the event loop REF'd. A
    // watchdog that dies when its child dies is no watchdog — with
    // unref'd timers the loop empties the moment the child's stdio pipes
    // close, the process silently exits, and the scheduled restart NEVER
    // fires (found live in smoke: "restart #1 3s baad" logged, then the
    // process was gone). Only exit paths are SIGINT/SIGTERM -> stop().
  }

  // v20.0.1: boot = deps audit (+ auto npm install) THEN child. Install
  // ke dauran tick/startChild blocked hain, isliye koi race nahi.
  // v20.8.3: FRONTEND FRESHNESS PEHLE — build needed ho to full npm
  // install runtime deps ko bhi satisfy kar deta hai, isliye ensureDeps
  // uske BAAD no-op nikalta hai (double-install avoided).
  async function _boot() {
    try {
      await ensureFrontend();
    } catch { /* never fatal */ }
    // v20.8.4: remember that this run reached a fresh frontend (drives the
    // child-exit rebuild path — see _onChildExit).
    state.frontendEverFresh = _frontendFresh();
    if (state.shuttingDown) return;
    try {
      await ensureDeps();
    } catch { /* never fatal */ }
    // v21.0: telegram-bot deps bhi boot pe ensure — bot fork hone se
    // PEHLE node_modules ready (warna crash-loop backoff me ghanto lagte
    // the + saare scheduled alerts silent rehte the).
    try {
      await ensureBotDeps();
    } catch { /* never fatal */ }
    startChild();
  }

  async function stop() {
    if (state.shuttingDown) return;
    state.shuttingDown = true;
    try { clearInterval(state.probeTimer); } catch { /* noop */ }
    try { clearInterval(state.tickTimer); } catch { /* noop */ }
    const child = state.child;
    if (child) {
      log('[watchdog] clean shutdown — child ko graceful window (8s)...');
      if (deps.platformFn() !== 'win32') {
        // Windows: shared console ctrl event pehle hi child ko SIGINT de
        // chuka hoga — hard-kill race se bachne ke liye forward skip.
        try { child.kill('SIGTERM'); } catch { /* noop */ }
      }
      await new Promise((resolve) => {
        if (child.exitCode !== null || child.signalCode) return resolve();
        const t = setTimeout(() => { forceKill(child); resolve(); }, 8000);
        child.on('exit', () => { clearTimeout(t); resolve(); });
      });
      state.child = null;
    }
    journal({ ev: 'watchdog-clean-shutdown', reason: 'supervisor-stop' });
    releaseLock();
    log('[watchdog] supervisor band. Site wapas laane ke liye Start-SmartAI-Watchdog.bat dobara chalao.');
  }

  return {
    start,
    stop,
    _i: {
      state, knobs, deps,
      probeOnce, onProbeResult, startChild, _restartTick,
      _scheduleRestart, _onChildExit, forceKill, journal,
      _emitLine, _appendLog,
      ensureDeps, _missingDeps, _runNpmInstall, _runNpmCommand,
      ensureFrontend, _frontendFresh, _codeVersion, _distStamp,
      acquireLock, releaseLock, _portAlreadyServing, _pidAlive,
    },
  };
}

// ---------------- CLI entry ----------------
async function run(opts = {}) {
  // v20.8.4 FIX (M — Node version gate, fail-fast): vite ^7 requires
  // Node ^20.19 || >=22.12; on Node 18 the watchdog used to boot, run a
  // 15-minute npm install that only WARNS about engines, and then die
  // with a cryptic internal vite error — with the "Node >= 20 chahiye"
  // hint appearing only AFTER the failure (and the 1-attempt build limit
  // requiring a full watchdog restart). Honest refusal up front.
  const _nodeMajor = parseInt(String(process.versions.node || '0').split('.')[0], 10) || 0;
  if (_nodeMajor < 20) {
    try {
      process.stdout.write(`[watchdog] Node ${process.versions.node} hai — SmartAI ko Node.js 20+ chahiye (vite build requirement).\n`);
      process.stdout.write('[watchdog] https://nodejs.org se Node 20 LTS (ya 22) install karo, phir Start-SmartAI-Watchdog.bat dobara chalao.\n');
    } catch { /* console may be dead */ }
    process.exit(1);
  }

  const sup = createSupervisor(opts);

  // v20.8.4 FIX (H2 — single instance): double-clicked watchdogs corrupt
  // node_modules via concurrent npm installs and mask each other's crash
  // loops. Lock first; if another LIVE watchdog (or any server on our
  // port) is already there, exit honestly instead of stacking.
  const lock = sup._i.acquireLock();
  if (lock && lock.ok === false) {
    process.stdout.write(`[watchdog] ek aur watchdog pehle se chal raha hai (pid ${lock.pid}) — dusra instance mat chalao.\n`);
    process.stdout.write('[watchdog] Agar purana watchdog band ho gaya hai to DATA_DIR/watchdog.lock delete karke dobara chalao.\n');
    process.exit(0);
  }
  if (await sup._i._portAlreadyServing()) {
    process.stdout.write(`[watchdog] port ${sup._i.knobs.port} pe pehle se SmartAI chal raha hai (koi aur watchdog / server).\n`);
    process.stdout.write('[watchdog] Browser me http://localhost:' + sup._i.knobs.port + ' kholo — dusra watchdog band rakho.\n');
    process.exit(0);
  }

  // QuickEdit guard: supervisor apne console pe bhi fire karta hai —
  // child + supervisor dono isi shared console me likhte hain, ek hi
  // call dono ko freeze-vector se bachati hai. Best-effort, silent-fail.
  try {
    const r = await disableQuickEditMode({ env: process.env });
    if (r.attempted) {
      process.stdout.write(`[watchdog] QuickEdit console guard: ${r.disabled ? 'ON' : 'SKIPPED'} (${r.reason})\n`);
    }
  } catch { /* never fatal */ }

  // Supervisor ko KABHI internal error pe mat maro — watchdog marta
  // hai to poora protection khatam.
  process.on('uncaughtException', (err) => {
    try { process.stdout.write(`[watchdog] internal error (ZINDA RAHE HAIN): ${String(err && err.message || err).slice(0, 160)}\n`); } catch { /* noop */ }
  });
  process.on('unhandledRejection', (reason) => {
    try { process.stdout.write(`[watchdog] unhandled rejection (ignored): ${String(reason).slice(0, 160)}\n`); } catch { /* noop */ }
  });

  let _stopping = false;
  const stop2 = async () => {
    if (_stopping) return;
    _stopping = true;
    try { await sup.stop(); } catch { /* noop */ }
    process.exit(0);
  };
  process.on('SIGINT', () => { stop2(); });
  process.on('SIGTERM', () => { stop2(); });

  sup.start();
  return sup;
}

const __isMain = (() => {
  try {
    return process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch { return false; }
})();

if (__isMain) {
  run().catch((err) => {
    try { process.stderr.write(`[watchdog] FATAL boot: ${String(err && err.stack || err).slice(0, 400)}\n`); } catch { /* noop */ }
    process.exit(1);
  });
}
