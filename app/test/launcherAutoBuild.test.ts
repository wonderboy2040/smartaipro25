// ============================================================
// test/launcherAutoBuild.test.ts — v20.8.3 ALWAYS-LATEST LAUNCHER
// ------------------------------------------------------------
// THE BUG THIS LOCKS SHUT ("v20.7.5 serve"):
//   Server frontend SIRF dist/ se serve karta hai; dist/ gitignored
//   hai isliye code-zips me nahi aata. Naya zip purane folder pe
//   overlay -> naya server code + PURANA dist = UI purana version
//   badge dikhata hai, koi error nahi.
//
// THE FIX UNDER TEST:
//   1. SUPERVISOR ensureFrontend — boot pe dist/.build-version stamp
//      vs package.json version compare; stale/missing = full npm
//      install + `npm run build` (buildingFrontend gating ke saath).
//   2. scripts/stamp-dist.mjs — postbuild hook jo dist/.build-version
//      likhta hai (DIST_DIR env = hermetic test override).
//   3. server/index.js — /api/ping `v` + /health `version` +
//      dist-missing 503 self-heal page (raw ENOENT khatam).
//   4. Frontend — useAuthState serverVersion capture + App.tsx
//      STALE-BUILD banner.
//
// Hermetic: fake children (EventEmitter), stateful injectable fs,
// zero real npm/network. Source-contract assertions jahan runtime
// boot karna meaningful nahi (index.js/App.tsx).
// ============================================================
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync, writeFileSync, mkdirSync, rmSync, mkdtempSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import os from 'node:os';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.join(__dirname, '..');
const SERVER_SRC = readFileSync(path.join(APP_ROOT, 'server', 'supervisor.js'), 'utf8');
const INDEX_SRC = readFileSync(path.join(APP_ROOT, 'server', 'index.js'), 'utf8');
const AUTH_SRC = readFileSync(path.join(APP_ROOT, 'src', 'hooks', 'useAuthState.ts'), 'utf8');
const APP_TSX = readFileSync(path.join(APP_ROOT, 'src', 'App.tsx'), 'utf8');
const VERSION_TS = readFileSync(path.join(APP_ROOT, 'src', 'version.ts'), 'utf8');
const PKG = JSON.parse(readFileSync(path.join(APP_ROOT, 'package.json'), 'utf8'));

// ---------- imports under test ----------
import { createSupervisor } from '../server/supervisor.js';

// ---------- scaffolding (supervisorGuard.test.ts pattern) ----------
function fakeChild(pid = 4242) {
  const c: any = new EventEmitter();
  c.pid = pid;
  c.stdout = new EventEmitter();
  c.stderr = new EventEmitter();
  c.exitCode = null;
  c.signalCode = null;
  c.kill = vi.fn(() => true);
  return c;
}

// Stateful frontend-world fake fs: dist presence + stamp + package.json
// version sab mutable hai — build "success" spawn ke waqt flip hota hai
// (postbuild stamp simulation).
function fsFrontend(fx: {
  hasDist: boolean;
  stamp: string | null;
  pkgVersion: string | null;
  nodeModules?: boolean;
}) {
  const norm = (p: string) => String(p).replace(/\\/g, '/');
  return {
    existsSync: (p: string) => {
      const q = norm(p);
      if (q.endsWith('/dist/index.html')) return fx.hasDist;
      if (q.includes('/node_modules/')) return !!fx.nodeModules;
      return false;
    },
    readFileSync: (p: string) => {
      const q = norm(p);
      if (q.endsWith('/package.json')) {
        if (fx.pkgVersion == null) throw new Error('ENOENT');
        return JSON.stringify({ version: fx.pkgVersion, dependencies: { express: '^4', dotenv: '^17' } });
      }
      if (q.endsWith('/dist/.build-version')) {
        if (fx.stamp == null) throw new Error('ENOENT');
        return fx.stamp;
      }
      throw new Error('ENOENT');
    },
    mkdirSync: () => {},
    appendFileSync: () => {},
    statSync: () => ({ size: 1 }),
    rmSync: () => {},
    renameSync: () => {},
  };
}

let logs: string[];
let entries: any[];
let spawnCalls: any[];

function mkSupervisor(env: any = {}, extra: any = {}) {
  return createSupervisor({
    env: { WATCHDOG_PROBE_MS: '20000', WATCHDOG_FAILS: '3', WATCHDOG_GRACE_MS: '45000', ...env },
    spawnFn: (cmd: string, args: string[], opts: any) => {
      spawnCalls.push({ cmd, args, opts });
      return fakeChild();
    },
    httpGetFn: (_o: any, _cb: any) => new EventEmitter() as any,
    nowFn: () => 1_700_000_000_000,
    logFn: (line: string) => { logs.push(String(line).replace(/\n$/, '')); },
    journalAppendFn: (e: any) => { entries.push(e); },
    platformFn: () => 'linux',
    nodeExe: 'node',
    serverEntry: '/app/server/index.js',
    appRoot: '/app',
    ...extra,
  });
}

const npmSpawns = () => spawnCalls.filter((c) => String(c.cmd).includes('npm'));

beforeEach(() => {
  logs = [];
  entries = [];
  spawnCalls = [];
});

// ============================================================
// A. _frontendFresh — the stamp-vs-code verdict
// ============================================================
describe('v20.8.3 supervisor._frontendFresh', () => {
  it('dist + matching stamp = FRESH (shipped-dist zip turant boot, zero npm)', () => {
    const fx = { hasDist: true, stamp: '20.8.3', pkgVersion: '20.8.3', nodeModules: true };
    const sup = mkSupervisor({ WATCHDOG_LOG_FILE: 'off' }, { fsMod: fsFrontend(fx) as any });
    expect(sup._i._frontendFresh()).toBe(true);
    expect(sup._i._codeVersion()).toBe('20.8.3');
    expect(sup._i._distStamp()).toBe('20.8.3');
  });

  it('stamp MISMATCH (overlay zip: naya code, purana dist) = STALE — the v20.7.5 bug shape', () => {
    const fx = { hasDist: true, stamp: '20.7.5', pkgVersion: '20.8.3', nodeModules: true };
    const sup = mkSupervisor({ WATCHDOG_LOG_FILE: 'off' }, { fsMod: fsFrontend(fx) as any });
    expect(sup._i._frontendFresh()).toBe(false);
  });

  it('dist/index.html missing (fresh extract, no dist) = STALE', () => {
    const fx = { hasDist: false, stamp: null, pkgVersion: '20.8.3', nodeModules: true };
    const sup = mkSupervisor({ WATCHDOG_LOG_FILE: 'off' }, { fsMod: fsFrontend(fx) as any });
    expect(sup._i._frontendFresh()).toBe(false);
  });

  it('package.json na mile (fixture/legacy layout) = fresh tolerance, kabhi force-build nahi', () => {
    const fx = { hasDist: true, stamp: null, pkgVersion: null };
    const sup = mkSupervisor({ WATCHDOG_LOG_FILE: 'off' }, { fsMod: fsFrontend(fx) as any });
    expect(sup._i._frontendFresh()).toBe(true);
  });
});

// ============================================================
// B. ensureFrontend — full auto-build path
// ============================================================
describe('v20.8.3 supervisor.ensureFrontend', () => {
  it('fresh dist -> honest skip, ZERO npm spawns', async () => {
    const fx = { hasDist: true, stamp: '20.8.3', pkgVersion: '20.8.3', nodeModules: true };
    const sup = mkSupervisor({ WATCHDOG_LOG_FILE: 'off' }, { fsMod: fsFrontend(fx) as any });
    const r = await sup._i.ensureFrontend();
    expect(r).toEqual({ ok: true, skipped: 'fresh' });
    expect(npmSpawns()).toHaveLength(0);
  });

  it('STALE dist -> FULL npm install (no --omit=dev) THEN `npm run build`; build success = stamp match + journal + honest logs', async () => {
    const fx = { hasDist: true, stamp: '20.7.5', pkgVersion: '20.8.3', nodeModules: true };
    const sup = mkSupervisor({ WATCHDOG_LOG_FILE: 'off' }, {
      fsMod: fsFrontend(fx) as any,
      spawnFn: (cmd: string, args: string[], opts: any) => {
        spawnCalls.push({ cmd, args, opts });
        const c = fakeChild();
        if (args.includes('build')) {
          // successful `npm run build` + postbuild stamp simulated
          fx.hasDist = true;
          fx.stamp = fx.pkgVersion;
        }
        setTimeout(() => c.emit('exit', 0), 5);
        return c;
      },
    });
    const p = sup._i.ensureFrontend();
    // buildingFrontend gate ON during build (race-free, installingDeps pattern)
    // (install+build awaited sequentially; flag cleared at end)
    const r = await p;
    expect(r.ok).toBe(true);
    expect(sup._i.state.buildingFrontend).toBe(false);
    expect(sup._i.state.frontendBuildTries).toBe(1);
    // install: FULL (vite/dev deps chahiye) — --omit=dev NAHI hona chahiye
    const install = npmSpawns().find((c) => c.args.includes('install'));
    expect(install).toBeTruthy();
    expect(install.args).not.toContain('--omit=dev');
    expect(install.opts.cwd).toBe('/app');
    // build: npm run build
    const build = npmSpawns().find((c) => c.args.includes('build') && c.args.includes('run'));
    expect(build).toBeTruthy();
    // journal + honest Hindi logs
    expect(entries.some((e) => e.ev === 'frontend-build' && e.reason === 'dist-stale-or-missing')).toBe(true);
    expect(logs.some((l) => l.includes('dist/ STALE'))).toBe(true);
    expect(logs.some((l) => l.includes('frontend build COMPLETE'))).toBe(true);
  });

  it('install FAIL -> build spawn NAHI, honest fail, flag cleared', async () => {
    const fx = { hasDist: false, stamp: null, pkgVersion: '20.8.3' };
    const sup = mkSupervisor({ WATCHDOG_LOG_FILE: 'off' }, {
      fsMod: fsFrontend(fx) as any,
      spawnFn: (cmd: string, args: string[], opts: any) => {
        spawnCalls.push({ cmd, args, opts });
        const c = fakeChild();
        setTimeout(() => c.emit('exit', args.includes('install') ? 1 : 0), 5);
        return c;
      },
    });
    const r = await sup._i.ensureFrontend();
    expect(r.ok).toBe(false);
    expect(r.code).toBe('1');
    expect(npmSpawns().some((c) => c.args.includes('run'))).toBe(false);
    expect(sup._i.state.buildingFrontend).toBe(false);
    expect(logs.some((l) => l.includes('npm install FAIL'))).toBe(true);
  });

  it('build FAIL (vite error) -> ok:false honest code, koi fake-success nahi', async () => {
    const fx = { hasDist: false, stamp: null, pkgVersion: '20.8.3' };
    const sup = mkSupervisor({ WATCHDOG_LOG_FILE: 'off' }, {
      fsMod: fsFrontend(fx) as any,
      spawnFn: (cmd: string, args: string[], opts: any) => {
        spawnCalls.push({ cmd, args, opts });
        const c = fakeChild();
        setTimeout(() => c.emit('exit', 0), 5); // install OK, build exit bhi 0...
        return c;
      },
    });
    // build exit 0 par stamp ABHI bhi mismatch (postbuild fail) — stamped verdict
    const r = await sup._i.ensureFrontend();
    expect(r.ok).toBe(false);
    expect(r.code).toBe('stamp-mismatch-after-build');
    expect(logs.some((l) => l.includes('frontend build FAIL'))).toBe(true);
  });

  it('WATCHDOG_AUTO_BUILD=0 -> honest skip + journal, zero spawns (purana dist serve hoga)', async () => {
    const fx = { hasDist: true, stamp: '20.7.5', pkgVersion: '20.8.3' };
    const sup = mkSupervisor({ WATCHDOG_LOG_FILE: 'off', WATCHDOG_AUTO_BUILD: '0' }, { fsMod: fsFrontend(fx) as any });
    const r = await sup._i.ensureFrontend();
    expect(r.skipped).toBe('auto-build-off');
    expect(npmSpawns()).toHaveLength(0);
    expect(entries.some((e) => e.ev === 'frontend-build' && e.reason === 'skipped-auto-build-off')).toBe(true);
    expect(logs.some((l) => l.includes('auto-build OFF'))).toBe(true);
  });

  it('tries guard: 1 attempt per supervisor run — dobara call gaveUp', async () => {
    const fx = { hasDist: false, stamp: null, pkgVersion: '20.8.3' };
    const sup = mkSupervisor({ WATCHDOG_LOG_FILE: 'off' }, {
      fsMod: fsFrontend(fx) as any,
      spawnFn: (cmd: string, args: string[], opts: any) => {
        spawnCalls.push({ cmd, args, opts });
        const c = fakeChild();
        setTimeout(() => c.emit('exit', 1), 5);
        return c;
      },
    });
    await sup._i.ensureFrontend(); // tries = 1
    const before = npmSpawns().length;
    const r2 = await sup._i.ensureFrontend();
    expect(r2.gaveUp).toBe(true);
    expect(npmSpawns().length).toBe(before); // koi naya spawn nahi
    expect(logs.some((l) => l.includes('auto-build limit (1/run)'))).toBe(true);
  });

  it('race-free gating: buildingFrontend me startChild + _restartTick dono blocked', () => {
    const src = SERVER_SRC;
    expect(src).toContain('state.installingDeps || state.buildingFrontend) return null');
    expect(src).toContain('state.installingDeps || state.buildingFrontend) return;');
  });

  it('boot order: ensureFrontend PEHLE, ensureDeps BAAD (full install runtime deps bhi cover karta hai)', () => {
    const bootIdx = SERVER_SRC.indexOf('async function _boot()');
    expect(bootIdx).toBeGreaterThan(0);
    const bootBody = SERVER_SRC.slice(bootIdx, bootIdx + 700);
    const feIdx = bootBody.indexOf('await ensureFrontend();');
    const depsIdx = bootBody.indexOf('await ensureDeps();');
    expect(feIdx).toBeGreaterThan(-1);
    expect(depsIdx).toBeGreaterThan(feIdx);
  });

  it('knobs: WATCHDOG_AUTO_BUILD default ON, =0 OFF; WATCHDOG_BUILD_TIMEOUT_MS parse', () => {
    const on = mkSupervisor({ WATCHDOG_LOG_FILE: 'off' });
    expect(on._i.knobs.autoBuild).toBe(true);
    expect(on._i.knobs.buildTimeoutMs).toBe(900000);
    const off = mkSupervisor({ WATCHDOG_LOG_FILE: 'off', WATCHDOG_AUTO_BUILD: '0', WATCHDOG_BUILD_TIMEOUT_MS: '120000' });
    expect(off._i.knobs.autoBuild).toBe(false);
    expect(off._i.knobs.buildTimeoutMs).toBe(120000);
  });

  it('_runNpmCommand win32: npm.cmd + shell spawn (guard contract preserved)', async () => {
    const sup = createSupervisor({
      env: { WATCHDOG_LOG_FILE: 'off' },
      spawnFn: (cmd: string, args: string[], opts: any) => {
        spawnCalls.push({ cmd, args, opts });
        const c = fakeChild();
        setTimeout(() => c.emit('exit', 0), 5);
        return c;
      },
      httpGetFn: () => new EventEmitter() as any,
      nowFn: () => 1,
      logFn: (l: string) => { logs.push(l); },
      journalAppendFn: () => {},
      platformFn: () => 'win32',
      nodeExe: 'node',
      serverEntry: '/app/server/index.js',
      appRoot: '/app',
    });
    const r = await sup._i._runNpmCommand(['run', 'build'], 60000);
    expect(r.ok).toBe(true);
    const call = npmSpawns()[0];
    expect(call.cmd).toBe('npm.cmd');
    expect(call.opts.shell).toBe(true);
    expect(call.opts.cwd).toBe('/app');
  });
});

// ============================================================
// C. scripts/stamp-dist.mjs — REAL execution (DIST_DIR hermetic override)
// ============================================================
describe('v20.8.3 scripts/stamp-dist.mjs (postbuild stamp writer)', () => {
  const STAMP_SCRIPT = path.join(APP_ROOT, 'scripts', 'stamp-dist.mjs');

  it('dist with index.html -> writes .build-version = package.json version', () => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), 'stampdist-ok-'));
    try {
      writeFileSync(path.join(tmp, 'index.html'), '<html><body>ok</body></html>');
      const r = spawnSync(process.execPath, [STAMP_SCRIPT], {
        env: { ...process.env, DIST_DIR: tmp },
        encoding: 'utf8',
      });
      expect(r.status).toBe(0);
      expect(readFileSync(path.join(tmp, '.build-version'), 'utf8')).toBe(PKG.version);
      expect(r.stdout).toContain('[stamp-dist]');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('dist BINA index.html -> exit 1 (koi fake stamp nahi)', () => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), 'stampdist-fail-'));
    try {
      const r = spawnSync(process.execPath, [STAMP_SCRIPT], {
        env: { ...process.env, DIST_DIR: tmp },
        encoding: 'utf8',
      });
      expect(r.status).toBe(1);
      expect(r.stderr).toContain('index.html nahi mila');
      expect(() => readFileSync(path.join(tmp, '.build-version'), 'utf8')).toThrow();
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('package.json wiring: postbuild hook = stamp-dist (har build path stamp likhta hai)', () => {
    expect(PKG.scripts.postbuild).toBe('node scripts/stamp-dist.mjs');
  });
});

// ============================================================
// D. server/index.js source contracts — version + self-heal page
// ============================================================
describe('v20.8.3 server version exposure + dist-missing self-heal', () => {
  it('/api/ping carries `v: SERVER_VERSION` (zero-work, frontend banner isi pe chalta hai)', () => {
    expect(INDEX_SRC).toContain('v: SERVER_VERSION');
  });

  it('/health carries `version: SERVER_VERSION`', () => {
    expect(INDEX_SRC).toContain('version: SERVER_VERSION');
  });

  it('SERVER_VERSION package.json se padha jata hai (single source)', () => {
    expect(INDEX_SRC).toContain("path.resolve(__dirname, '..', 'package.json')");
  });

  it('SPA fallback: dist-missing pe 503 + self-heal HTML (raw ENOENT 500 stack nahi)', () => {
    expect(INDEX_SRC).toContain("fs.existsSync(distIndex)");
    expect(INDEX_SRC).toContain('status(503)');
    expect(INDEX_SRC).toContain('Start-SmartAI-Watchdog.bat');
    expect(INDEX_SRC).toContain('http-equiv="refresh"');
  });

  it('fs import present (guard ke liye zaroori tha — pehle index.js me fs tha hi nahi)', () => {
    expect(INDEX_SRC).toContain("import fs from 'node:fs';");
  });

  it('boot line SERVER_VERSION se aati hai — v20.4.2 hardcoded stale string khatam', () => {
    expect(INDEX_SRC).toContain('v${SERVER_VERSION} THREE-DESK TERMINAL');
    expect(INDEX_SRC).not.toContain("v20.4.2 TWO-DESK TERMINAL");
  });
});

// ============================================================
// E. Frontend source contracts — stale-build DETECTION visible
// ============================================================
describe('v20.8.3 frontend stale-build visibility', () => {
  it('useAuthState: /api/ping JSON ka `v` capture hota hai (extra request nahi)', () => {
    expect(AUTH_SRC).toContain('setServerVersion');
    expect(AUTH_SRC).toContain("typeof d.v === 'string'");
    expect(AUTH_SRC).toContain('serverVersion,');
  });

  it('App.tsx: staleBuild banner — browser vA vs server vB user ko DIKHE', () => {
    expect(APP_TSX).toContain('serverVersion !== APP_VERSION');
    expect(APP_TSX).toContain('BUILD STALE');
    expect(APP_TSX).toContain('Start-SmartAI-Watchdog.bat');
  });

  it('version agreement: package.json === src/version.ts APP_VERSION (release gate)', () => {
    const m = VERSION_TS.match(/APP_VERSION = '([^']+)'/);
    expect(m).toBeTruthy();
    expect(m![1]).toBe(PKG.version);
    expect(PKG.version).toBe('21.30.0'); // v21.30.0 (signal timing + safety hardening)
  });

  it('Watchdog bat: v21.30.0 stamps + auto-build line + NO stale version stamps', () => {
    const bat = readFileSync(path.join(APP_ROOT, 'Start-SmartAI-Watchdog.bat'), 'utf8');
    expect(bat).toContain('v21.30.0');
    expect(bat).not.toContain('v21.23.14');
    // v21.23.12 [D3]: title/REM lines me STALE stamps chhupe the (banner hi
    // bumped hota tha) — console window title purana version dikhata tha.
    expect(bat).not.toContain('v21.23.12');
    expect(bat).not.toContain('v21.23.11');
    expect(bat).not.toContain('v21.23.10');
    expect(bat).toContain('AUTO npm install');
  });

  it('RUN-FIRST.md zip me ship hota hai (Windows user ka pehla sawal: exe ya bat?)', () => {
    const p = path.join(APP_ROOT, '..', 'RUN-FIRST.md');
    const txt = readFileSync(p, 'utf8');
    expect(txt).toContain('Start-SmartAI-Watchdog.bat');
    expect(txt).toContain('localhost:8080');
    expect(txt).toContain('APP_PIN');
  });
});

// ============================================================
// F. zip-readiness: dist stamp contract (build ke baad verify)
// ============================================================
describe('v20.8.3 run-ready zip contract', () => {
  it('tracked launcher files git me hain (future zips me auto-ship)', () => {
    // agar ye file test chala rahi hai, tracked hai hi — sanity via source presence
    expect(SERVER_SRC).toContain('ensureFrontend');
    expect(SERVER_SRC).toContain('_frontendFresh');
    expect(SERVER_SRC).toContain('_distStamp');
  });
});
