// ============================================================
// test/supervisorGuard.test.ts — v19.2 ANTI-FREEZE SUPERVISOR
// ------------------------------------------------------------
// Locks the full anti-hang contract:
//   1. CONSOLE GUARD — non-win32 skip, env off-switch, PowerShell
//      command construction, QEDIT_OFF / ALREADY_OFF / NO_CONSOLE
//      verdicts, spawn-fail + timeout silent paths, never rejects.
//   2. SUPERVISOR — knobs parsing, child spawn contract
//      (SMARTAI_SUPERVISED=1 marker, app-root cwd), probe
//      ok/fail streaks, FREEZE verdict (kill + journal) only
//      after the grace window, BOOT-HANG verdict (fails+3 inside
//      grace), crash-exit journal + backoff doubling/cap/reset,
//      restart tick timing, hourly restart budget pause, clean
//      stop (SIGTERM forward on linux, graceful wait window,
//      force-kill fallback), stdout/stderr relay + file log +
//      rotation, spawn-fail/error resilience.
//   3. PROBE transport — timeout / connection-refused / status
//      code mapping (2xx-4xx alive, 5xx dead).
//   4. WIRING — index.js /api/ping route, consoleGuard import +
//      boot call, /health consoleguard+supervised fields, v19.2
//      arm line with v19.1 marker intact; supervisor.js source
//      contracts (taskkill tree-kill, stay-alive handlers).
// Hermetic: fake children (EventEmitter), fake httpGet, mutable
// clock, injectable fs, journal + log capture.
// ============================================================
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { EventEmitter } from 'node:events';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(__dirname, '..', 'server');
const TMP = path.join(__dirname, '..', '.tmp-supervisor-test');

// ---------- imports under test ----------
import {
  disableQuickEditMode, consoleGuardStatus, __resetConsoleGuardForTests,
} from '../server/ai/consoleGuard.js';
import { createSupervisor } from '../server/supervisor.js';

// ---------- scaffolding ----------
function fakePSChild(out = '', closeDelay = 0) {
  const c: any = new EventEmitter();
  c.stdout = new EventEmitter();
  c.stderr = new EventEmitter();
  c.kill = vi.fn(() => true);
  if (out !== null) {
    setTimeout(() => {
      c.stdout.emit('data', Buffer.from(out));
      c.emit('close', 0);
    }, closeDelay);
  }
  return c;
}

function fakeChild(pid = 4242) {
  const c: any = new EventEmitter();
  c.pid = pid;
  c.stdout = new EventEmitter();
  c.stderr = new EventEmitter();
  c.exitCode = null;
  c.signalCode = null;
  c.killCalls = [] as string[];
  c.kill = (sig?: string) => { c.killCalls.push(sig || 'default'); return true; };
  return c;
}

let tNow: number;
let entries: any[];
let logs: string[];
let spawnCalls: any[];
let currentChild: any;
let spawnShouldThrow: boolean;

function mkSupervisor(env: any = {}, extra: any = {}) {
  return createSupervisor({
    env: { WATCHDOG_PROBE_MS: '20000', WATCHDOG_FAILS: '3', WATCHDOG_GRACE_MS: '45000', ...env },
    spawnFn: (cmd: string, args: string[], opts: any) => {
      spawnCalls.push({ cmd, args, opts });
      if (spawnShouldThrow) throw new Error('spawn ENOENT');
      currentChild = fakeChild();
      return currentChild;
    },
    httpGetFn: (_opts: any, _cb: any) => new EventEmitter() as any,
    nowFn: () => tNow,
    logFn: (line: string) => { logs.push(String(line).replace(/\n$/, '')); },
    journalAppendFn: (e: any) => { entries.push(e); },
    platformFn: () => 'linux',
    nodeExe: 'node',
    serverEntry: '/app/server/index.js',
    appRoot: '/app',
    ...extra,
  });
}

beforeEach(() => {
  tNow = 1_700_000_000_000;
  entries = [];
  logs = [];
  spawnCalls = [];
  currentChild = null;
  spawnShouldThrow = false;
  __resetConsoleGuardForTests();
  mkdirSync(TMP, { recursive: true });
});

afterEach(() => {
  rmSync(TMP, { recursive: true, force: true });
  vi.restoreAllMocks();
});

// ============================================================
// 1. consoleGuard
// ============================================================
describe('consoleGuard — QuickEdit programmatic disable', () => {
  it('non-win32: skip, never spawns', async () => {
    const spawnFn = vi.fn();
    const r = await disableQuickEditMode({ spawnFn, platformFn: () => 'linux' });
    expect(r).toEqual({ attempted: false, disabled: false, reason: 'non-win32' });
    expect(spawnFn).not.toHaveBeenCalled();
    expect(consoleGuardStatus().attempted).toBe(false);
  });

  it('QUICKEDIT_GUARD=off: skip by env', async () => {
    const spawnFn = vi.fn();
    const r = await disableQuickEditMode({ spawnFn, platformFn: () => 'win32', env: { QUICKEDIT_GUARD: 'off' } });
    expect(r.attempted).toBe(false);
    expect(r.reason).toBe('disabled-by-env');
    expect(spawnFn).not.toHaveBeenCalled();
  });

  it('win32: powershell command carries SetConsoleMode + quick-edit bits', async () => {
    let captured: any;
    const spawnFn = (cmd: string, args: string[]) => {
      captured = { cmd, args };
      return fakePSChild('QEDIT_OFF');
    };
    const r = await disableQuickEditMode({ spawnFn, platformFn: () => 'win32', env: {} });
    expect(r).toEqual({ attempted: true, disabled: true, reason: 'quickedit-disabled' });
    expect(captured.cmd).toBe('powershell.exe');
    expect(captured.args[0]).toBe('-NoProfile');
    const script = captured.args.join(' ');
    expect(script).toContain('SetConsoleMode');
    expect(script).toContain('0x40');
    expect(script).toContain('0x80');
    expect(script).toContain('GetStdHandle(-10)');
    expect(consoleGuardStatus().disabled).toBe(true);
  });

  it('QEDIT_ALREADY_OFF verdict maps to disabled:true', async () => {
    const r = await disableQuickEditMode({
      spawnFn: () => fakePSChild('QEDIT_ALREADY_OFF'),
      platformFn: () => 'win32', env: {},
    });
    expect(r.disabled).toBe(true);
    expect(r.reason).toBe('quickedit-already-off');
  });

  it('NO_CONSOLE (hidden/no console) maps to disabled:false, attempted:true', async () => {
    const r = await disableQuickEditMode({
      spawnFn: () => fakePSChild('NO_CONSOLE'),
      platformFn: () => 'win32', env: {},
    });
    expect(r.attempted).toBe(true);
    expect(r.disabled).toBe(false);
    expect(r.reason).toBe('no-console-hidden-mode');
  });

  it('spawn throwing resolves (never rejects) with spawn-fail reason', async () => {
    const r = await disableQuickEditMode({
      spawnFn: () => { throw new Error('ENOENT powershell'); },
      platformFn: () => 'win32', env: {},
    });
    expect(r.attempted).toBe(true);
    expect(r.disabled).toBe(false);
    expect(r.reason).toContain('spawn-fail');
  });

  it('child error event resolves disabled:false', async () => {
    const c: any = new EventEmitter();
    c.stdout = new EventEmitter();
    c.stderr = new EventEmitter();
    c.kill = vi.fn();
    setTimeout(() => c.emit('error', Object.assign(new Error('fail'), { code: 'EPERM' })), 5);
    const r = await disableQuickEditMode({ spawnFn: () => c, platformFn: () => 'win32', env: {} });
    expect(r.disabled).toBe(false);
    expect(r.reason).toContain('EPERM');
  });

  it('timeout path: kills the PS child, resolves disabled:false', async () => {
    const c = fakePSChild(null); // never closes, never writes
    const r = await disableQuickEditMode({
      spawnFn: () => c, platformFn: () => 'win32', env: {}, timeoutMs: 40,
    });
    expect(r.disabled).toBe(false);
    expect(r.reason).toContain('timeout');
    expect(c.kill).toHaveBeenCalled();
  });

  it('unexpected/empty output resolves honestly', async () => {
    const r = await disableQuickEditMode({
      spawnFn: () => fakePSChild(''), platformFn: () => 'win32', env: {},
    });
    expect(r.attempted).toBe(true);
    expect(r.disabled).toBe(false);
    expect(r.reason).toContain('unexpected-output');
  });
});

// ============================================================
// 2. supervisor — knobs + spawn contract
// ============================================================
describe('supervisor — knobs parsing + child spawn contract', () => {
  it('defaults: port 8080, probe 20s, timeout 9s, fails 3, grace 45s, budget 20/hour', () => {
    const sup = mkSupervisor();
    const k = sup._i.knobs;
    expect(k.port).toBe(8080);
    expect(k.probeMs).toBe(20000);
    expect(k.timeoutMs).toBe(9000);
    expect(k.fails).toBe(3);
    expect(k.graceMs).toBe(45000);
    expect(k.backoffBaseMs).toBe(3000);
    expect(k.backoffMaxMs).toBe(60000);
    expect(k.maxRestartsHour).toBe(20);
    expect(k.probesOn).toBe(true);
  });

  it('env overrides parse + clamp; WATCHDOG_DISABLE kills probes; log off', () => {
    const sup = mkSupervisor({
      WATCHDOG_PROBE_MS: '7000', WATCHDOG_FAILS: '5', WATCHDOG_TIMEOUT_MS: '4000',
      WATCHDOG_DISABLE: '1', WATCHDOG_LOG_FILE: 'off', WATCHDOG_PORT: '9099',
    });
    expect(sup._i.knobs.probeMs).toBe(7000);
    expect(sup._i.knobs.fails).toBe(5);
    expect(sup._i.knobs.timeoutMs).toBe(4000);
    expect(sup._i.knobs.probesOn).toBe(false);
    expect(sup._i.knobs.logFilePath).toBeNull();
    expect(sup._i.knobs.port).toBe(9099);
  });

  it('garbage env values fall back to defaults (never NaN)', () => {
    const sup = mkSupervisor({ WATCHDOG_PROBE_MS: 'abc', WATCHDOG_FAILS: '-4', WATCHDOG_PORT: 'not-a-port' });
    const k = sup._i.knobs;
    expect(k.probeMs).toBe(20000);
    expect(k.fails).toBe(3);
    expect(k.port).toBe(8080);
  });

  it('startChild: spawns node with server entry, app-root cwd, SMARTAI_SUPERVISED=1 marker, journals boot', () => {
    const sup = mkSupervisor();
    sup._i.state.started = true;
    const c = sup._i.startChild();
    expect(c).toBeTruthy();
    expect(spawnCalls.length).toBe(1);
    expect(spawnCalls[0].cmd).toBe('node');
    expect(spawnCalls[0].args).toEqual(['/app/server/index.js']);
    expect(spawnCalls[0].opts.cwd).toBe('/app');
    expect(spawnCalls[0].opts.env.SMARTAI_SUPERVISED).toBe('1');
    expect(spawnCalls[0].opts.stdio).toEqual(['ignore', 'pipe', 'pipe']);
    expect(sup._i.state.child).toBe(c);
    expect(entries.some((e) => e.ev === 'watchdog-boot' && e.reason === 'child-start')).toBe(true);
    // re-spawn while alive is a no-op
    expect(sup._i.startChild()).toBeNull();
    expect(spawnCalls.length).toBe(1);
  });

  it('spawn throwing: journals watchdog-crash, schedules restart, never throws out', () => {
    const sup = mkSupervisor();
    sup._i.state.started = true;
    spawnShouldThrow = true;
    expect(() => sup._i.startChild()).not.toThrow();
    expect(entries.some((e) => e.ev === 'watchdog-crash' && e.reason === 'spawn-fail')).toBe(true);
    expect(sup._i.state.nextRestartAt).toBeGreaterThan(tNow);
    expect(sup._i.state.restarts).toBe(1);
  });

  it('child error event (node binary missing): journals + restart scheduled', () => {
    const sup = mkSupervisor();
    sup._i.state.started = true;
    const c = sup._i.startChild();
    c.emit('error', Object.assign(new Error('no node'), { code: 'ENOENT' }));
    expect(entries.some((e) => e.ev === 'watchdog-crash' && e.reason === 'spawn-error')).toBe(true);
    expect(sup._i.state.child).toBeNull();
    expect(sup._i.state.restarts).toBe(1);
  });
});

// ============================================================
// 3. supervisor — freeze / boot-hang verdicts
// ============================================================
describe('supervisor — HANG detection', () => {
  it('streak below threshold never kills', () => {
    const sup = mkSupervisor();
    sup._i.state.started = true;
    const c = sup._i.startChild();
    tNow += 60000; // past grace
    sup._i.onProbeResult({ ok: false, why: 'timeout' });
    sup._i.onProbeResult({ ok: false, why: 'timeout' });
    expect(sup._i.state.failsStreak).toBe(2);
    expect(c.killCalls).toHaveLength(0);
    expect(entries.some((e) => e.ev === 'watchdog-restart')).toBe(false);
  });

  it('FREEZE verdict after grace: journal + SIGKILL + pendingReason', () => {
    const sup = mkSupervisor();
    sup._i.state.started = true;
    const c = sup._i.startChild();
    tNow += 60000; // uptime 60s > grace 45s
    sup._i.onProbeResult({ ok: false, why: 'timeout' });
    sup._i.onProbeResult({ ok: false, why: 'timeout' });
    sup._i.onProbeResult({ ok: false, why: 'timeout' }); // 3rd = threshold
    expect(sup._i.state.pendingReason).toBe('freeze');
    expect(c.killCalls).toContain('SIGKILL');
    const freezeEntry = entries.find((e) => e.ev === 'watchdog-restart' && e.reason === 'freeze');
    expect(freezeEntry).toBeTruthy();
    expect(freezeEntry.detail).toContain('3 consecutive probe fail');
    expect(freezeEntry.childPid).toBe(c.pid);
    // exit handler must NOT re-journal as crash (verdict carries), but the
    // restart accounting still lands: restarts=1, nextRestartAt = base backoff
    c.emit('exit', null, 'SIGKILL');
    expect(entries.filter((e) => e.ev === 'watchdog-restart').length).toBe(1);
    expect(sup._i.state.restarts).toBe(1);
    expect(sup._i.state.nextRestartAt).toBe(tNow + 3000); // base backoff
    expect(sup._i.state.child).toBeNull();
  });

  it('grace window protects a booting child (fails === threshold, uptime < grace)', () => {
    const sup = mkSupervisor();
    sup._i.state.started = true;
    const c = sup._i.startChild();
    tNow += 10000; // uptime 10s < grace 45s
    sup._i.onProbeResult({ ok: false, why: 'timeout' });
    sup._i.onProbeResult({ ok: false, why: 'timeout' });
    sup._i.onProbeResult({ ok: false, why: 'timeout' });
    expect(c.killCalls).toHaveLength(0);
    expect(sup._i.state.pendingReason).toBeNull();
  });

  it('BOOT-HANG verdict: fails+3 inside grace kills a child that never came up', () => {
    const sup = mkSupervisor();
    sup._i.state.started = true;
    const c = sup._i.startChild();
    tNow += 12000; // still inside grace
    for (let i = 0; i < 6; i++) sup._i.onProbeResult({ ok: false, why: 'timeout' });
    expect(sup._i.state.pendingReason).toBe('boot-hang');
    expect(c.killCalls).toContain('SIGKILL');
    expect(entries.some((e) => e.ev === 'watchdog-restart' && e.reason === 'boot-hang')).toBe(true);
  });

  it('probe OK resets the streak and logs recovery', () => {
    const sup = mkSupervisor();
    sup._i.state.started = true;
    sup._i.startChild();
    tNow += 60000;
    sup._i.onProbeResult({ ok: false, why: 'timeout' });
    sup._i.onProbeResult({ ok: true, why: 'status-200' });
    expect(sup._i.state.failsStreak).toBe(0);
    expect(logs.some((l) => l.includes('probe OK wapas'))).toBe(true);
  });

  it('probe with no child (restart gap): streak reset, no verdict', () => {
    const sup = mkSupervisor();
    sup._i.state.started = true;
    sup._i.startChild();
    sup._i.state.child = null; // gap between restarts
    sup._i.onProbeResult({ ok: false, why: 'timeout' });
    expect(sup._i.state.failsStreak).toBe(0);
    expect(entries.some((e) => e.reason === 'freeze' || e.reason === 'boot-hang')).toBe(false);
  });
});

// ============================================================
// 4. supervisor — crash exit, backoff, budget, restart tick
// ============================================================
describe('supervisor — crash recovery + backoff + budget', () => {
  it('plain crash exit: journals exit(code), restart after base backoff; tick respects timing', () => {
    const sup = mkSupervisor();
    sup._i.state.started = true;
    const c1 = sup._i.startChild();
    tNow += 5000;
    c1.emit('exit', 1, null);
    const ex = entries.find((e) => e.ev === 'watchdog-restart' && e.reason === 'exit(1)');
    expect(ex).toBeTruthy();
    expect(ex.uptimeSec).toBe(5);
    expect(sup._i.state.nextRestartAt).toBe(tNow + 3000);
    // boot-crash hint logged (uptime < 10s)
    expect(logs.some((l) => l.includes('boot ke 10s ke andar crash'))).toBe(true);
    // not yet time
    tNow += 2000;
    sup._i._restartTick();
    expect(spawnCalls.length).toBe(1);
    // time
    tNow += 1500;
    sup._i._restartTick();
    expect(spawnCalls.length).toBe(2);
    expect(entries.filter((e) => e.ev === 'watchdog-boot').length).toBe(2);
  });

  it('backoff doubles per crash, caps at max, resets after a stable run', () => {
    const sup = mkSupervisor();
    sup._i.state.started = true;
    // crash 1 -> delay 3000, next 6000
    sup._i.startChild()!.emit('exit', 1, null);
    expect(sup._i.state.backoffDelayMs).toBe(6000);
    // crash 2 -> delay 6000, next 12000 (tick spawns; crash THAT child)
    tNow += 4000; sup._i._restartTick();
    currentChild.emit('exit', 1, null);
    expect(sup._i.state.backoffDelayMs).toBe(12000);
    // crash 3 -> delay 12000, next 24000
    tNow += 7000; sup._i._restartTick();
    currentChild.emit('exit', 1, null);
    expect(sup._i.state.backoffDelayMs).toBe(24000);
    // long crash chains ramp to the cap
    for (let i = 0; i < 4; i++) {
      tNow = Math.max(tNow, sup._i.state.nextRestartAt); sup._i._restartTick();
      currentChild.emit('exit', 1, null);
    }
    expect(sup._i.state.backoffDelayMs).toBe(60000); // capped
    // stable run (>= stableResetMs 10min) resets the CONSUMED delay to base
    // (nextRestartAt uses 3000; the stored next-crash backoff doubles from base)
    tNow += 700000;
    currentChild.emit('exit', 0, null);
    expect(sup._i.state.nextRestartAt).toBe(tNow + 3000); // base delay consumed
    expect(sup._i.state.backoffDelayMs).toBe(6000); // doubles from the reset base
  });

  it('hourly restart budget: pause + banner + resume after pause window', () => {
    const sup = mkSupervisor({ WATCHDOG_MAX_RESTARTS_HOUR: '3', WATCHDOG_BUDGET_PAUSE_MS: '10000' });
    sup._i.state.started = true;
    sup._i.startChild();
    for (let i = 0; i < 3; i++) {
      currentChild.emit('exit', 1, null);
      tNow = Math.max(tNow, sup._i.state.nextRestartAt);
      sup._i._restartTick();
    }
    expect(sup._i.state.budgetPausedUntil).toBe(0); // budget not yet hit
    expect(spawnCalls.length).toBe(4); // 1 initial + 3 restarts
    // 4th crash crosses the budget
    currentChild.emit('exit', 1, null);
    expect(sup._i.state.budgetPausedUntil).toBe(tNow + 10000);
    expect(entries.some((e) => e.ev === 'watchdog-budget-pause')).toBe(true);
    expect(logs.some((l) => l.includes('RESTART BUDGET'))).toBe(true);
    // during pause: tick refuses to spawn, banner once
    tNow += 100;
    sup._i._restartTick();
    expect(spawnCalls.length).toBe(4);
    sup._i._restartTick();
    expect(logs.filter((l) => l.includes('budget pause active')).length).toBe(1);
    // after pause (and past pending backoff): resumes
    tNow = Math.max(tNow, sup._i.state.budgetPausedUntil, sup._i.state.nextRestartAt);
    sup._i._restartTick();
    expect(spawnCalls.length).toBe(5);
  });
});

// ============================================================
// 5. supervisor — clean stop
// ============================================================
describe('supervisor — clean shutdown', () => {
  it('stop() on linux: forwards SIGTERM, waits for exit, journals clean-shutdown', async () => {
    const sup = mkSupervisor();
    sup._i.state.started = true;
    const c = sup._i.startChild();
    const stopP = sup.stop();
    c.emit('exit', 0, null); // graceful path completes
    await stopP;
    expect(c.killCalls).toContain('SIGTERM');
    expect(entries.some((e) => e.ev === 'watchdog-clean-shutdown')).toBe(true);
    expect(sup._i.state.shuttingDown).toBe(true);
    // child exit after stop() is ignored (no restart accounting)
    const restarts = sup._i.state.restarts;
    c.emit('exit', 0, null);
    expect(sup._i.state.restarts).toBe(restarts);
  });

  it('stop() force path: child refuses to die -> SIGKILL fallback after 8s window', async () => {
    vi.useFakeTimers();
    try {
      const sup = mkSupervisor();
      sup._i.state.started = true;
      const c = sup._i.startChild();
      const stopP = sup.stop();
      await vi.advanceTimersByTimeAsync(8200);
      await stopP;
      expect(c.killCalls).toEqual(['SIGTERM', 'SIGKILL']);
      expect(entries.some((e) => e.ev === 'watchdog-clean-shutdown')).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('stop() on win32: NO SIGTERM forward (shared console ctrl event owns it)', async () => {
    const sup = mkSupervisor({}, { platformFn: () => 'win32' });
    sup._i.state.started = true;
    const c = sup._i.startChild();
    const stopP = sup.stop();
    c.emit('exit', 0, null);
    await stopP;
    expect(c.killCalls).toHaveLength(0); // console event did the job
  });

  it('forceKill on win32 uses taskkill /F /T tree-kill', () => {
    const taskkillCalls: any[] = [];
    const sup = mkSupervisor({}, {
      platformFn: () => 'win32',
      spawnFn: (cmd: string, args: string[], opts: any) => {
        if (cmd === 'taskkill') { taskkillCalls.push({ cmd, args, opts }); return new EventEmitter(); }
        spawnCalls.push({ cmd, args, opts });
        currentChild = fakeChild(777);
        return currentChild;
      },
    });
    sup._i.forceKill(fakeChild(777));
    expect(taskkillCalls.length).toBe(1);
    expect(taskkillCalls[0].args).toEqual(['/F', '/T', '/PID', '777']);
  });
});

// ============================================================
// 6. supervisor — stdout relay + file log + rotation
// ============================================================
describe('supervisor — log relay + rotation', () => {
  it('child stdout lines relay to logFn + file; stderr prefixed; partial lines buffered', () => {
    const logFile = path.join(TMP, 'server.log');
    const sup = mkSupervisor({ WATCHDOG_LOG_FILE: logFile });
    sup._i.state.started = true;
    const c = sup._i.startChild();
    c.stdout.emit('data', Buffer.from('[srv] line1\n'));
    c.stdout.emit('data', Buffer.from('par'));
    c.stdout.emit('data', Buffer.from('tial\r\n'));
    c.stderr.emit('data', Buffer.from('boom\n'));
    expect(logs).toContain('[srv] line1');
    expect(logs).toContain('partial');
    expect(logs.some((l) => l.includes('[srv:err] boom'))).toBe(true);
    const written = readFileSync(logFile, 'utf8');
    expect(written).toContain('[srv] line1\n');
    expect(written).toContain('partial\n');
    expect(written).toContain('[srv:err] boom\n');
  });

  it('rotation: >5MB renames f->f.1, f.1->f.2, removes f.2 (injectable fs)', () => {
    const calls: string[] = [];
    const fsMod: any = {
      existsSync: () => true,
      mkdirSync: () => {},
      appendFileSync: () => { calls.push('append'); },
      statSync: () => ({ size: 6 * 1024 * 1024 }),
      rmSync: (p: string) => { calls.push(`rm:${p}`); },
      renameSync: (a: string, b: string) => { calls.push(`mv:${a}->${b}`); },
    };
    const sup = mkSupervisor({ WATCHDOG_LOG_FILE: '/tmp/server.log' }, { fsMod });
    sup._i._appendLog('x\n');
    expect(calls).toContain('append');
    expect(calls).toContain('rm:/tmp/server.log.2');
    expect(calls).toContain('mv:/tmp/server.log.1->/tmp/server.log.2');
    expect(calls).toContain('mv:/tmp/server.log->/tmp/server.log.1');
  });

  it('relay never throws on hostile child data (null chunks etc.)', () => {
    const sup = mkSupervisor({ WATCHDOG_LOG_FILE: 'off' });
    sup._i.state.started = true;
    const c = sup._i.startChild();
    expect(() => c.stdout.emit('data', null)).not.toThrow();
    expect(() => c.stdout.emit('data', undefined)).not.toThrow();
  });
});

// ============================================================
// 7. probe transport
// ============================================================
describe('supervisor — probeOnce transport mapping', () => {
  function probeWith(impl: (req: any, res: any, cb: any) => void) {
    const sup = mkSupervisor({}, {
      httpGetFn: (_opts: any, cb: any) => {
        const req: any = new EventEmitter();
        req.destroy = vi.fn();
        setImmediate(() => {
          const res: any = new EventEmitter();
          res.resume = vi.fn();
          impl(req, res, cb);
        });
        return req;
      },
    });
    return sup._i.probeOnce();
  }

  it('200 with end -> ok', async () => {
    const r = await probeWith((_req, res, cb) => { res.statusCode = 200; cb(res); res.emit('end'); });
    expect(r).toEqual({ ok: true, why: 'status-200' });
  });

  it('404 still means loop-alive (route moved), 500 means dead', async () => {
    const a = await probeWith((_q, res, cb) => { res.statusCode = 404; cb(res); res.emit('end'); });
    expect(a.ok).toBe(true);
    const b = await probeWith((_q, res, cb) => { res.statusCode = 500; cb(res); res.emit('end'); });
    expect(b.ok).toBe(false);
  });

  it('req timeout -> destroy + {ok:false, why:timeout}', async () => {
    const r = await probeWith((req, _res, _cb) => { req.emit('timeout'); });
    expect(r.ok).toBe(false);
    expect(r.why).toBe('timeout');
  });

  it('connection error (ECONNREFUSED) -> {ok:false, why:ECONNREFUSED}', async () => {
    const r = await probeWith((req, _res, _cb) => { req.emit('error', Object.assign(new Error('x'), { code: 'ECONNREFUSED' })); });
    expect(r).toEqual({ ok: false, why: 'ECONNREFUSED' });
  });

  it('httpGet throwing sync -> {ok:false} resolved, never rejected', async () => {
    const sup = mkSupervisor({}, { httpGetFn: () => { throw new Error('boom'); } });
    const r = await sup._i.probeOnce();
    expect(r.ok).toBe(false);
    expect(r.why).toContain('throw-');
  });
});

// ============================================================
// 8. wiring — index.js + supervisor.js source contracts
// ============================================================
describe('wiring — v19.2 source contracts', () => {
  const idx = () => readFileSync(path.join(SRC, 'index.js'), 'utf8');
  const supSrc = () => readFileSync(path.join(SRC, 'supervisor.js'), 'utf8');

  it('index.js: /api/ping liveness route registered (public, pre-/health)', () => {
    const s = idx();
    expect(s).toContain("app.get('/api/ping'");
    expect(s.indexOf("app.get('/api/ping'")).toBeLessThan(s.indexOf("app.get('/health'"));
    expect(s).toContain('pong: true');
  });

  it('index.js: consoleGuard imported + fired at boot (non-supervised path)', () => {
    const s = idx();
    expect(s).toContain("from './ai/consoleGuard.js'");
    expect(s).toContain('disableQuickEditMode({ env: process.env })');
    expect(s).toContain("process.env.SMARTAI_SUPERVISED === '1'");
  });

  it('index.js: /health carries consoleguard + supervised fields', () => {
    const s = idx();
    expect(s).toContain('consoleguard:');
    expect(s).toContain('supervised: process.env.SMARTAI_SUPERVISED');
  });

  it('index.js: v19.2 arm line present AND v19.1 marker intact (installer chain)', () => {
    const s = idx();
    expect(s).toContain('v19.2 ANTI-FREEZE layer armed');
    expect(s).toContain('v19.1 NEVER-DOWN STABILITY GUARD armed');
  });

  it('supervisor.js: probe path, supervised marker, tree-kill, stay-alive handlers, main guard', () => {
    const s = supSrc();
    expect(s).toContain("path: '/api/ping'");
    expect(s).toContain("SMARTAI_SUPERVISED: '1'");
    expect(s).toContain('taskkill');
    expect(s).toContain('uncaughtException');
    expect(s).toContain('unhandledRejection');
    expect(s).toContain("process.on('SIGINT'");
    expect(s).toContain('disableQuickEditMode');
    expect(s).toContain('fileURLToPath(import.meta.url)'); // __isMain guard
  });

  it('supervisor.js exports createSupervisor; run() boots internally (CLI wired)', () => {
    const s = supSrc();
    expect(s).toContain('export function createSupervisor');
    // v20.7.11 dead-code purge: run() had no external importer — it is now
    // internal-only (boot + CLI entry). The wiring contract survives:
    expect(s).toMatch(/async function run\(/);
    expect(s).toMatch(/run\(\)\.catch\(/); // __isMain boot path
  });

  it('consoleGuard.js: leaf module (node builtins only, no project imports)', () => {
    const s = readFileSync(path.join(SRC, 'ai', 'consoleGuard.js'), 'utf8');
    expect(s).not.toMatch(/from '\.\.\/(?!node:)/);
    expect(s).toContain('QUICKEDIT_GUARD');
  });
});

// ============================================================
// 9. supervisor — v20.0.1 DEPENDENCY AUTO-INSTALL
//    (live bug: fresh install bina node_modules -> ERR_MODULE_NOT_FOUND
//    crash-loop + GALAT "port conflict" message. Ab preflight audit +
//    auto npm install + honest diagnosis.)
// ============================================================
describe('supervisor — v20.0.1 dependency auto-install', () => {
  const PKG = JSON.stringify({
    name: 'smartai', version: '20.0.1', type: 'module',
    dependencies: { dotenv: '^17.4.2', express: '^4.21.2', ws: '^8.21.0' },
  });

  // fs mod jisme package.json padha ja sakta hai par HAR node_modules path missing hai
  function fsMissingDeps(): any {
    return {
      existsSync: (p: string) => !String(p).replace(/\\/g, '/').includes('/node_modules/'),
      readFileSync: (p: string) => {
        if (String(p).replace(/\\/g, '/').endsWith('/package.json')) return PKG;
        throw new Error('ENOENT');
      },
      mkdirSync: () => {},
      appendFileSync: () => {},
      statSync: () => ({ size: 1 }),
      rmSync: () => {},
      renameSync: () => {},
    };
  }

  const npmSpawns = () => spawnCalls.filter((c) => String(c.cmd).includes('npm'));
  const tick = () => new Promise((r) => setTimeout(r, 15));

  it('_missingDeps: frontend-build-only deps (react/lucide/motion/lightweight-charts) SKIP — audit sirf runtime deps karta hai', () => {
    const PKG_FE = JSON.stringify({
      dependencies: {
        react: '^19', 'react-dom': '^19', 'lucide-react': '^1', motion: '^12', 'lightweight-charts': '^5',
        dotenv: '^17', express: '^4',
      },
    });
    const fsMod: any = {
      existsSync: (p: string) => !String(p).includes('node_modules'),
      readFileSync: () => PKG_FE,
    };
    const sup = mkSupervisor({ WATCHDOG_LOG_FILE: 'off' }, { fsMod });
    expect(sup._i._missingDeps()).toEqual(['dotenv', 'express']);
  });

  it('knobs: WATCHDOG_AUTO_INSTALL default ON, "0" = off; timeout parses', () => {
    const a = mkSupervisor();
    expect(a._i.knobs.autoInstall).toBe(true);
    expect(a._i.knobs.installTimeoutMs).toBe(900000);
    const b = mkSupervisor({ WATCHDOG_AUTO_INSTALL: '0', WATCHDOG_INSTALL_TIMEOUT_MS: '120000' });
    expect(b._i.knobs.autoInstall).toBe(false);
    expect(b._i.knobs.installTimeoutMs).toBe(120000);
  });

  it('ensureDeps: no package.json (fixture roots) -> skip, zero npm spawns', async () => {
    const fsMod: any = { readFileSync: () => { throw new Error('ENOENT'); } };
    const sup = mkSupervisor({ WATCHDOG_LOG_FILE: 'off' }, { fsMod });
    const r = await sup._i.ensureDeps();
    expect(r.ok).toBe(true);
    expect(npmSpawns()).toHaveLength(0);
    expect(sup._i.state.depsInstallTries).toBe(0);
  });

  it('ensureDeps: auto-install OFF env -> honest skip, zero spawns', async () => {
    const sup = mkSupervisor({ WATCHDOG_AUTO_INSTALL: '0', WATCHDOG_LOG_FILE: 'off' }, { fsMod: fsMissingDeps() });
    const r = await sup._i.ensureDeps();
    expect(r.skipped).toBe('auto-install-off');
    expect(npmSpawns()).toHaveLength(0);
  });

  it('missing deps -> npm install spawned (npm cmd, --omit=dev, app-root cwd), journaled + honest logs; installingDeps blocks spawn/tick', async () => {
    const sup = mkSupervisor({ WATCHDOG_LOG_FILE: 'off' }, { fsMod: fsMissingDeps() });
    sup._i.state.started = true;
    const p = sup._i.ensureDeps();
    const npmCall = npmSpawns()[0];
    expect(npmCall).toBeTruthy();
    expect(npmCall.args).toContain('install');
    expect(npmCall.args).toContain('--omit=dev');
    expect(npmCall.args).toContain('--no-audit');
    expect(npmCall.opts.cwd).toBe('/app');
    expect(entries.some((e) => e.ev === 'watchdog-deps-install' && e.reason === 'missing-node-modules')).toBe(true);
    expect(logs.some((l) => l.includes('node_modules missing hai'))).toBe(true);
    // install ke dauran child spawn + tick dono blocked (race-free)
    expect(sup._i.startChild()).toBeNull();
    sup._i._restartTick();
    expect(spawnCalls.filter((c) => c.cmd === 'node')).toHaveLength(0);
    expect(sup._i.state.installingDeps).toBe(true);
    // npm child exits 0 -> install "complete" path (fs ab bhi missing bolega -> honest)
    currentChild.emit('exit', 0);
    const r = await p;
    expect(sup._i.state.installingDeps).toBe(false);
    expect(r.ok).toBe(false);
    expect(logs.some((l) => l.includes('npm install ke BAAD bhi missing'))).toBe(true);
    expect(sup._i.state.depsInstallTries).toBe(1);
  });

  it('npm install timeout -> honest fail, installingDeps cleared, never rejects', async () => {
    const sup = mkSupervisor({ WATCHDOG_INSTALL_TIMEOUT_MS: '30000', WATCHDOG_LOG_FILE: 'off' }, { fsMod: fsMissingDeps() });
    const p = sup._i.ensureDeps();
    currentChild.emit('exit', 1); // npm exit 1 = fail
    const r = await p;
    expect(r.ok).toBe(false);
    expect(r.code).toBe('1');
    expect(sup._i.state.installingDeps).toBe(false);
    expect(logs.some((l) => l.includes('npm install FAIL'))).toBe(true);
  });

  it('tries guard: 2 attempts max per supervisor run, phir honest gaveUp', async () => {
    const sup = mkSupervisor({ WATCHDOG_LOG_FILE: 'off' }, { fsMod: fsMissingDeps() });
    sup._i.state.depsInstallTries = 2;
    const r = await sup._i.ensureDeps();
    expect(r.gaveUp).toBe(true);
    expect(npmSpawns()).toHaveLength(0);
    expect(logs.some((l) => l.includes('auto-install limit (2)'))).toBe(true);
  });

  it('child crash with ERR_MODULE_NOT_FOUND: deps-missing journal + auto-install retry + NO misleading "port conflict" line', async () => {
    const sup = mkSupervisor({ WATCHDOG_LOG_FILE: 'off' }, { fsMod: fsMissingDeps() });
    sup._i.state.started = true;
    const c = sup._i.startChild();
    c.stderr.emit('data', Buffer.from("Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'dotenv' imported from D:\\SmartAI26\\app\\server\\index.js\n"));
    c.emit('exit', 1, null);
    // honest diagnosis + auto-install fired
    expect(logs.some((l) => l.includes('DEPENDENCY MISSING'))).toBe(true);
    expect(logs.some((l) => l.includes('port conflict'))).toBe(false);
    const npmCall = npmSpawns()[0];
    expect(npmCall).toBeTruthy();
    // install done (npm child exit 0) -> restart scheduled as deps-missing
    currentChild.emit('exit', 0);
    await tick();
    const ex = entries.find((e) => e.ev === 'watchdog-restart');
    expect(String(ex.reason)).toContain('deps-missing');
    expect(sup._i.state.restarts).toBe(1);
    expect(sup._i.state.nextRestartAt).toBeGreaterThan(tNow);
    // crash accounting bhi child-free
    expect(sup._i.state.child).toBeNull();
    // restart lands: tick spawns the server child again
    tNow = Math.max(tNow, sup._i.state.nextRestartAt);
    sup._i._restartTick();
    expect(spawnCalls.filter((x) => x.cmd === 'node').length).toBe(2);
  });

  it('module-err crash with auto-install exhausted -> honest guidance + 60s cool delay (no hot loop)', async () => {
    const sup = mkSupervisor({ WATCHDOG_LOG_FILE: 'off' }, { fsMod: fsMissingDeps() });
    sup._i.state.started = true;
    sup._i.state.depsInstallTries = 2;
    const c = sup._i.startChild();
    c.stderr.emit('data', Buffer.from('Error [ERR_MODULE_NOT_FOUND]: Cannot find package'));
    c.emit('exit', 1, null);
    expect(npmSpawns()).toHaveLength(0);
    expect(logs.some((l) => l.includes('Auto-install off/limit'))).toBe(true);
    expect(sup._i.state.nextRestartAt).toBe(tNow + 60000);
    expect(entries.some((e) => String(e.reason).includes('deps-missing'))).toBe(true);
  });

  it('plain crash (stderr BINA module-err) -> purana exit(code) behavior byte-identical', async () => {
    const sup = mkSupervisor({ WATCHDOG_LOG_FILE: 'off' }, { fsMod: fsMissingDeps() });
    sup._i.state.started = true;
    const c = sup._i.startChild();
    c.stderr.emit('data', Buffer.from('EADDRINUSE boom\n'));
    c.emit('exit', 1, null);
    await tick();
    expect(entries.some((e) => e.reason === 'exit(1)')).toBe(true);
    expect(entries.some((e) => String(e.reason).includes('deps-missing'))).toBe(false);
    expect(npmSpawns()).toHaveLength(0);
    expect(sup._i.state.nextRestartAt).toBe(tNow + 3000);
  });
});

// ============================================================
// 10. wiring — v20.0.1 source contracts (deps self-heal)
// ============================================================
describe('wiring — v20.0.1 deps self-heal contracts', () => {
  it('supervisor.js: ERR_MODULE_NOT_FOUND sniff + npm install + honest reason + boot preflight', () => {
    const s = readFileSync(path.join(SRC, 'supervisor.js'), 'utf8');
    expect(s).toContain("line.includes('ERR_MODULE_NOT_FOUND')");
    expect(s).toContain('WATCHDOG_AUTO_INSTALL');
    expect(s).toContain('WATCHDOG_APP_ROOT');
    expect(s).toContain("'--omit=dev'");
    expect(s).toContain('deps-missing');
    expect(s).toContain('npm.cmd'); // win32 spawn form
    expect(s).toContain('_boot()'); // deps audit BEFORE first child spawn
    expect(s).toContain('state.installingDeps'); // race-free gating
  });
});
