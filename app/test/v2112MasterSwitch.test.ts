// ============================================================
// test/v2112MasterSwitch.test.ts — v21.12.0 MASTER-SWITCH SUITE
// ------------------------------------------------------------
// USER REPORT: "META ensemble ON karna ml-service deploy ke baad haa
// kardo aur Accuracy upgrade — 13 → 16-model committee (tape-MTF w1.6
// + 3 naye seats) + 4 mesh shadow seats + 3× learning window sirf 13
// models hi bata raha hai 16 models nhi"
//
// Is suite me:
//   A) AI_ACCURACY_SUITE master switch — default ON, stale legacy
//      `false` ignored, explicit master false = legacy A/B rollback.
//   B) META ensemble default ON (user ask) + explicit false rollback.
//   C) committee.js — voting/shadow counts, tape seat, learning
//      window, META armed (subprocess env-sanitized) + boot banner.
//   D) supervisor CODE-UPGRADE GUARD — running v != disk package.json
//      → 2-probe stability window → ek upgrade-restart → loop-guard.
//      (Root cause: naya zip extract + purana process RAM me = "UI
//      naya, server purana" = 13-model board.)
//   E) Source contracts — .env.example, boot banner wiring, /health
//      committee field, agent payloads, UI dynamic count strings.
// ============================================================
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { EventEmitter } from 'node:events';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP = path.join(__dirname, '..');

// ---------- A) master switch (leaf module — direct import safe) ----------
import { accuracySuiteEnabled, legacyFlagEnabled } from '../server/ai/accuracySuite.js';
import { createSupervisor } from '../server/supervisor.js';

// ---------- scaffolding (supervisor) ----------
let tNow: number;
let entries: any[];
let logs: string[];
let currentChild: any;
let diskPkgVersion: string | null;

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

function mkSupervisor(extra: any = {}) {
  // v21.12: fsMod mock — package.json version mutable per-test
  const fakeFs = {
    readFileSync: (p: string, ...rest: any[]) => {
      if (String(p).endsWith('package.json')) {
        if (!diskPkgVersion) throw new Error('ENOENT');
        return JSON.stringify({ version: diskPkgVersion });
      }
      return readFileSync(p, ...rest);
    },
    existsSync: () => false,
  };
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return createSupervisor({
    env: { WATCHDOG_PROBE_MS: '20000', WATCHDOG_FAILS: '3', WATCHDOG_GRACE_MS: '45000' },
    spawnFn: () => { currentChild = fakeChild(); return currentChild; },
    httpGetFn: (_opts: any, _cb: any) => new EventEmitter() as any,
    nowFn: () => tNow,
    logFn: (line: string) => { logs.push(String(line).replace(/\n$/, '')); },
    journalAppendFn: (e: any) => { entries.push(e); },
    platformFn: () => 'linux',
    nodeExe: 'node',
    serverEntry: '/app/server/index.js',
    appRoot: '/app',
    fsMod: fakeFs as any,
    ...extra,
  });
}

beforeEach(() => {
  tNow = 1_700_000_000_000;
  entries = [];
  logs = [];
  currentChild = null;
  diskPkgVersion = '21.12.0';
});

// ============================================================
// A) AI_ACCURACY_SUITE master switch
// ============================================================
describe('v21.12 A — master switch semantics', () => {
  it('default (unset) → ON', () => {
    delete (process.env as any).AI_ACCURACY_SUITE;
    expect(accuracySuiteEnabled()).toBe(true);
  });

  it('explicit false/0/off/no → OFF (rollback path)', () => {
    for (const v of ['false', '0', 'off', 'no', 'FALSE']) {
      process.env.AI_ACCURACY_SUITE = v;
      expect(accuracySuiteEnabled()).toBe(false);
    }
  });

  it('garbage value → treated as empty → ON (safe default)', () => {
    process.env.AI_ACCURACY_SUITE = 'maybe';
    expect(accuracySuiteEnabled()).toBe(true);
  });

  it('legacyFlagEnabled — v9.x semantics (unset = OFF, explicit true = ON)', () => {
    delete (process.env as any).AI_ENABLE_V2_MODELS;
    expect(legacyFlagEnabled('AI_ENABLE_V2_MODELS')).toBe(false);
    process.env.AI_ENABLE_V2_MODELS = 'true';
    expect(legacyFlagEnabled('AI_ENABLE_V2_MODELS')).toBe(true);
    process.env.AI_ENABLE_V2_MODELS = 'false';
    expect(legacyFlagEnabled('AI_ENABLE_V2_MODELS')).toBe(false);
    delete (process.env as any).AI_ENABLE_V2_MODELS;
  });
});

// ============================================================
// B) META ensemble default ON
// ============================================================
describe('v21.12 B — META ensemble default ON (user ask)', () => {
  it('flag unset → ON (subprocess, env-sanitized)', () => {
    const out = execFileSync('node', ['-e',
      `delete process.env.AI_ENABLE_META_ENSEMBLE;
       import('./server/ai/ensemble.js').then(m => console.log(JSON.stringify({
         meta: m.metaEnsembleEnabled(), url: m.metaServiceUrl(),
       })))`], { cwd: APP, encoding: 'utf8', timeout: 20000 });
    const r = JSON.parse(out.trim().split('\n').pop());
    expect(r.meta).toBe(true);
    expect(r.url).toBe('http://127.0.0.1:8100');
  });

  it('explicit false → OFF (A/B rollback)', () => {
    const out = execFileSync('node', ['-e',
      `process.env.AI_ENABLE_META_ENSEMBLE = 'false';
       import('./server/ai/ensemble.js').then(m => console.log(JSON.stringify({ meta: m.metaEnsembleEnabled() })))`],
      { cwd: APP, encoding: 'utf8', timeout: 20000 });
    expect(JSON.parse(out.trim().split('\n').pop()).meta).toBe(false);
  });
});

// ============================================================
// C) committee info + banner
// ============================================================
describe('v21.12 C — committee composition visibility', () => {
  it('suite ON → 20 seats: 16 voting + 4 mesh shadow, tape-MTF w1.6, window 1200, META armed', () => {
    const out = execFileSync('node', ['-e',
      `delete process.env.AI_ACCURACY_SUITE;
       delete process.env.AI_ENABLE_V2_MODELS; delete process.env.AI_ENABLE_MESH_MODELS;
       delete process.env.AI_ENABLE_MTF_CONFLUENCE; delete process.env.AI_ENABLE_META_ENSEMBLE;
       delete process.env.AI_LEDGER_MAX_ENTRIES;
       Promise.all([import('./server/ai/committee.js')]).then(([c]) => {
         const info = c.committeeInfo();
         console.log(JSON.stringify({ info, banner: c.committeeBanner(info) }));
       })`], { cwd: APP, encoding: 'utf8', timeout: 20000 });
    const { info, banner } = JSON.parse(out.trim().split('\n').pop());
    expect(info.total).toBe(20);
    expect(info.voting).toBe(16);
    expect(info.shadow).toBe(4);
    expect(info.tapeSeat).toBe('tape-mtf');
    expect(info.tapeWeight).toBe(1.6);
    expect(info.learningWindow).toBe(1200);
    expect(info.accuracySuite).toBe(true);
    expect(info.meta.enabled).toBe(true);
    expect(info.meta.serviceUrl).toBe('http://127.0.0.1:8100');
    // banner — watchdog log me user ko poora composition dikhna chahiye
    expect(banner).toContain('16 voting + 4 mesh shadow');
    expect(banner).toContain('tape-MTF w1.6');
    expect(banner).toContain('window 1200');
    expect(banner).toContain('META ARMED');
  });

  it('legacy A/B (AI_ACCURACY_SUITE=false) → 13 voting + 0 shadow, plain tape w1.3, honest banner', () => {
    const out = execFileSync('node', ['-e',
      `process.env.AI_ACCURACY_SUITE = 'false';
       delete process.env.AI_ENABLE_V2_MODELS; delete process.env.AI_ENABLE_MESH_MODELS;
       delete process.env.AI_ENABLE_MTF_CONFLUENCE; delete process.env.AI_ENABLE_META_ENSEMBLE;
       import('./server/ai/committee.js').then((c) => {
         const info = c.committeeInfo();
         console.log(JSON.stringify({ info, banner: c.committeeBanner(info) }));
       })`], { cwd: APP, encoding: 'utf8', timeout: 20000 });
    const { info, banner } = JSON.parse(out.trim().split('\n').pop());
    expect(info.total).toBe(13);
    expect(info.voting).toBe(13);
    expect(info.shadow).toBe(0);
    expect(info.tapeSeat).toBe('tape');
    expect(info.tapeWeight).toBe(1.3);
    expect(info.accuracySuite).toBe(false);
    expect(banner).toContain('13 voting + 0 mesh shadow');
    expect(banner).toContain('tape w1.3 (legacy)');
  });
});

// ============================================================
// D) supervisor CODE-UPGRADE guard
// ============================================================
describe('v21.12 D — supervisor code-upgrade guard (13-models root cause fix)', () => {
  it('running v == disk v → never kills (happy path)', () => {
    const sup = mkSupervisor();
    sup._i.state.started = true;
    const c = sup._i.startChild();
    tNow += 60000;
    for (let i = 0; i < 5; i++) sup._i.onProbeResult({ ok: true, why: 'status-200', v: '21.12.0' });
    expect(c.killCalls).toHaveLength(0);
    expect(sup._i.state.codeMismatchStreak).toBe(0);
  });

  it('mismatch ×1 → stability window, NO kill yet (zip mid-extract race guard)', () => {
    const sup = mkSupervisor();
    sup._i.state.started = true;
    const c = sup._i.startChild();
    tNow += 60000;
    sup._i.onProbeResult({ ok: true, why: 'status-200', v: '21.11.0' }); // disk 21.12.0
    expect(c.killCalls).toHaveLength(0);
    expect(sup._i.state.codeMismatchStreak).toBe(1);
    expect(logs.some((l) => l.includes('CODE UPGRADE dikha'))).toBe(true);
  });

  it('mismatch ×2 (same disk v) → upgrade-restart: journal + kill + pendingReason', () => {
    const sup = mkSupervisor();
    sup._i.state.started = true;
    const c = sup._i.startChild();
    tNow += 60000;
    sup._i.onProbeResult({ ok: true, why: 'status-200', v: '21.11.0' });
    sup._i.onProbeResult({ ok: true, why: 'status-200', v: '21.11.0' });
    expect(c.killCalls).toContain('SIGKILL');
    expect(sup._i.state.pendingReason).toBe('code-upgrade');
    const e = entries.find((x) => x.ev === 'watchdog-restart' && x.reason === 'code-upgrade');
    expect(e).toBeTruthy();
    expect(e.detail).toContain('v21.11.0 != disk v21.12.0');
    expect(sup._i.state.upgradeRestarts).toBe(1);
    expect(sup._i.state.lastUpgradeTarget).toBe('21.12.0');
    // exit → verdict carries (no double journal), restart scheduled
    c.emit('exit', null, 'SIGKILL');
    expect(entries.filter((x) => x.ev === 'watchdog-restart').length).toBe(1);
    expect(sup._i.state.restarts).toBe(1);
  });

  it('after upgrade-restart, SAME target mismatch → NO second kill (loop guard) + hint log', () => {
    const sup = mkSupervisor();
    sup._i.state.started = true;
    const c = sup._i.startChild();
    tNow += 60000;
    sup._i.onProbeResult({ ok: true, why: 'status-200', v: '21.11.0' });
    sup._i.onProbeResult({ ok: true, why: 'status-200', v: '21.11.0' });
    expect(c.killCalls).toHaveLength(1);
    // restart hua, naya child bhi (partial deploy) purana version bolta hai
    sup._i.state.child = c; // simulate new child (same fake)
    sup._i.onProbeResult({ ok: true, why: 'status-200', v: '21.11.0' });
    sup._i.onProbeResult({ ok: true, why: 'status-200', v: '21.11.0' });
    sup._i.onProbeResult({ ok: true, why: 'status-200', v: '21.11.0' });
    expect(c.killCalls).toHaveLength(1); // NO second kill
    expect(logs.some((l) => l.includes('deploy partial'))).toBe(true);
    expect(sup._i.state.upgradeRestarts).toBe(1);
  });

  it('NEW target version (21.13.0 extract) → upgrade-restart allowed again (cap 3/boot)', () => {
    const sup = mkSupervisor();
    sup._i.state.started = true;
    let c = sup._i.startChild();
    tNow += 60000;
    sup._i.onProbeResult({ ok: true, why: 'status-200', v: '21.11.0' });
    sup._i.onProbeResult({ ok: true, why: 'status-200', v: '21.11.0' });
    expect(c.killCalls).toHaveLength(1);
    c.emit('exit', null, 'SIGKILL'); // upgrade-restart ka exit — state.child clear
    // naya zip aaya: disk ab 21.13.0, running ab new child (fake) 21.12.0 bolta hai
    diskPkgVersion = '21.13.0';
    c = sup._i.startChild(); // upgrade restart ka naya child
    expect(c).toBeTruthy();
    tNow += 60000;
    sup._i.onProbeResult({ ok: true, why: 'status-200', v: '21.12.0' });
    sup._i.onProbeResult({ ok: true, why: 'status-200', v: '21.12.0' });
    expect(c.killCalls).toContain('SIGKILL');
    expect(sup._i.state.upgradeRestarts).toBe(2);
  });

  it('disk package.json unreadable → guard no-op (never fatal)', () => {
    diskPkgVersion = null; // fs mock throws ENOENT
    const sup = mkSupervisor();
    sup._i.state.started = true;
    const c = sup._i.startChild();
    tNow += 60000;
    for (let i = 0; i < 5; i++) sup._i.onProbeResult({ ok: true, why: 'status-200', v: '21.11.0' });
    expect(c.killCalls).toHaveLength(0);
  });

  it('probe body parsing — /api/ping JSON `v` travels to the result (legacy mocks: v undefined)', async () => {
    const sup = mkSupervisor({
      httpGetFn: (_opts: any, cb: any) => {
        const req: any = new EventEmitter();
        req.destroy = vi.fn();
        setImmediate(() => {
          const res: any = new EventEmitter();
          res.resume = vi.fn();
          res.statusCode = 200;
          cb(res);
          res.emit('data', Buffer.from(JSON.stringify({ pong: true, t: 1, v: '21.12.0' })));
          res.emit('end');
        });
        return req;
      },
    });
    const r = await sup._i.probeOnce();
    expect(r.ok).toBe(true);
    expect((r as any).v).toBe('21.12.0');
    // non-JSON body → v undefined, probe still ok (guard no-op-safe path)
    const sup2 = mkSupervisor({
      httpGetFn: (_opts: any, cb: any) => {
        const req: any = new EventEmitter();
        req.destroy = vi.fn();
        setImmediate(() => {
          const res: any = new EventEmitter();
          res.resume = vi.fn();
          res.statusCode = 200;
          cb(res);
          res.emit('data', Buffer.from('<html>not json</html>'));
          res.emit('end');
        });
        return req;
      },
    });
    const r2 = await sup2._i.probeOnce();
    expect(r2.ok).toBe(true);
    expect((r2 as any).v).toBeUndefined();
  });
});

// ============================================================
// E) source contracts
// ============================================================
describe('v21.12 E — wiring + UI source contracts', () => {
  const envExample = () => readFileSync(path.join(APP, '.env.example'), 'utf8');
  const idx = () => readFileSync(path.join(APP, 'server', 'index.js'), 'utf8');
  const supSrc = () => readFileSync(path.join(APP, 'server', 'supervisor.js'), 'utf8');
  const agentSrc = (f: string) => readFileSync(path.join(APP, 'server', 'ai', f), 'utf8');
  const uiSrc = (f: string) => readFileSync(path.join(APP, 'src', 'components', f), 'utf8');

  it('.env.example: master switch + META default ON + ML_SERVICE_URL uncommented', () => {
    const s = envExample();
    expect(s).toContain('AI_ACCURACY_SUITE=true');
    expect(s).toMatch(/^AI_ENABLE_META_ENSEMBLE=true$/m);
    expect(s).toMatch(/^ML_SERVICE_URL=http:\/\/127\.0\.0\.1:8100$/m);
    // legacy flags documented as master-gated
    expect(s).toContain('IGNORED hote hain');
  });

  it('index.js: boot committee banner + /health committee field wired', () => {
    const s = idx();
    expect(s).toContain('committeeBanner()');
    expect(s).toContain("import { committeeInfo, committeeBanner } from './ai/committee.js'");
    expect(s).toMatch(/committee,?\n/);
  });

  it('supervisor.js: code-upgrade guard wired (probe v parse + guard + caps)', () => {
    const s = supSrc();
    expect(s).toContain("'code-upgrade'");
    expect(s).toContain('_checkCodeUpgrade(result)');
    expect(s).toContain('upgradeRestarts >= 3');
    expect(s).toContain('j.v');
  });

  it('agent + indiaAgent payloads: committee snapshot attached', () => {
    expect(agentSrc('agent.js')).toContain('committee: (() => { try { return committeeInfo(); }');
    expect(agentSrc('indiaAgent.js')).toContain('committee: (() => { try { return committeeInfo(); }');
  });

  it('AgentPanel: dynamic committee chip (hardcoded 16/13 committee strings GONE)', () => {
    const s = uiSrc('aitrading/AgentPanel.tsx');
    expect(s).toContain('🧬 committee');
    expect(s).toContain('acc.committee');
    expect(s).not.toContain("'ON (16-model committee)'");
    expect(s).not.toContain("'OFF (13-model committee)'");
  });

  it('tabs: stale hardcoded 10-model strings GONE (dynamic models.length)', () => {
    const cx = uiSrc('tabs/CoinDcxTab.tsx');
    const inTab = uiSrc('tabs/IndiaIntradayTab.tsx');
    for (const s of [cx, inTab]) {
      expect(s).not.toMatch(/\b10-model\b/);
      expect(s).toContain('${models.length || 16}-model');
    }
  });

  it('models.js + meshModels.js: master-gated flag fns', () => {
    const m = agentSrc('models.js');
    expect(m).toContain("from './accuracySuite.js'");
    expect(m).toContain("if (accuracySuiteEnabled()) return true;");
    const mm = agentSrc('meshModels.js');
    expect(mm).toContain("from './accuracySuite.js'");
    expect(mm).toContain('if (accuracySuiteEnabled()) return true;');
  });

  it('setup.ts: legacy pins include master + meta (202 legacy suites byte-identical)', () => {
    const s = readFileSync(path.join(APP, 'src', 'test', 'setup.ts'), 'utf8');
    expect(s).toContain("process.env.AI_ACCURACY_SUITE ??= 'false'");
    expect(s).toContain("process.env.AI_ENABLE_META_ENSEMBLE ??= 'false'");
  });
});
