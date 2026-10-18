// ============================================================
// test/v2078SiteAudit.test.ts — v20.7.8 FULL-SITE DEEP RECHECK
// ------------------------------------------------------------
// Regression locks for every v20.7.8 fix (behavioral where cheap,
// source-contract where the runtime is too heavy to mount — the
// routeMount.test.ts precedent):
//   [H1]  index.js shutdown kills the forked Telegram bot child
//   [H2]  routes.js auto-executor re-entrancy guard
//   [M1]  secrets.js 3s TTL cache + invalidation
//   [M2]  cryptoStream honest wire labels + LiveSourceBadge amber pills
//   [M3]  routes.js registrar idempotency
//   [M5]  supervisor detached POSIX spawn + process-group kill
//   [L4]  data.js TV_SAFE carries Recommend.All at d[23]
//   [L5]  data.js crypto snapshot uses the shared USDINR store
//   [L6]  index.js jsonError headersSent guard
//   [L7]  routes.js Telegram HTML escaping
//   [L9]  positionsStream guarded first SSE write
//   [H-1] OrderConsole trail SET 0/NaN gate
//   [H-2] OrderConsole numeric SET empty-string gate
//   [H-3] App.tsx lazyWithRetry re-arms on success
//   [M-1] ProPanels stale-response seq guards
//   [M-3] api.ts ensureAuthenticated keeps session on unparseable 200
//   [M-5] SignalCard SimpleTradeTicket entry>0 guard (post-hooks)
//   [M-7] deepAnalysisExtras recheck baseline + hidden gate
// ============================================================
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EventEmitter } from 'node:events';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP = path.join(__dirname, '..');
const src = (p: string) => readFileSync(path.join(APP, p), 'utf8');

// ---------- imports under test ----------
import {
  getSecrets, setSecret, __resetSecretsForTests,
} from '../server/ai/secrets.js';
import { saveJSON, loadJSON } from '../server/lib/store.js';
import { liveSourceBadge } from '../src/components/aitrading/LiveSourceBadge';
import { createSupervisor } from '../server/supervisor.js';

// ============================================================
// [M1] secrets — TTL cache + invalidation semantics
// ============================================================
describe('v20.7.8 [M1] secrets TTL cache', () => {
  let _orig: any;
  beforeEach(() => {
    _orig = JSON.parse(JSON.stringify(loadJSON('ai-secrets.json') || {}));
    __resetSecretsForTests();
  });
  afterEach(() => {
    saveJSON('ai-secrets.json', _orig && Object.keys(_orig).length ? _orig : { secrets: {}, updatedAt: 0 });
    __resetSecretsForTests();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('setSecret is visible on the NEXT getSecrets call (no stale cache)', () => {
    expect(getSecrets().geminiApiKey).toBeUndefined();
    setSecret('geminiApiKey', 'AIzaSy' + 'v2078'.repeat(8));
    expect(getSecrets().geminiApiKey).toBe('AIzaSy' + 'v2078'.repeat(8));
  });

  it('returns a COPY — mutating the result never poisons the cache', () => {
    setSecret('geminiApiKey', 'AIzaSy' + 'orig111'.repeat(5));
    const a = getSecrets() as any;
    a.geminiApiKey = 'TAMPERED';
    delete a.groqApiKey;
    const b = getSecrets() as any;
    expect(b.geminiApiKey).toBe('AIzaSy' + 'orig111'.repeat(5));
  });

  it('out-of-process disk edits are picked up within the TTL window (3s)', () => {
    vi.useFakeTimers();
    setSecret('groqApiKey', 'gsk_' + 'oldkey'.repeat(8));
    expect(getSecrets().groqApiKey).toBe('gsk_' + 'oldkey'.repeat(8));
    // another process writes the file directly
    const disk = loadJSON('ai-secrets.json', { secrets: {} }) as any;
    disk.secrets.groqApiKey = 'gsk_' + 'newkey'.repeat(8);
    saveJSON('ai-secrets.json', disk);
    // inside the window: cached copy still served
    vi.advanceTimersByTime(1000);
    expect(getSecrets().groqApiKey).toBe('gsk_' + 'oldkey'.repeat(8));
    // past the window: fresh disk read
    vi.advanceTimersByTime(2_100);
    expect(getSecrets().groqApiKey).toBe('gsk_' + 'newkey'.repeat(8));
  });

  it('__resetSecretsForTests never serves a stale cached secret to the next test', () => {
    setSecret('geminiApiKey', 'AIzaSy' + 'aaaa'.repeat(10));
    __resetSecretsForTests();
    expect(getSecrets().geminiApiKey).toBeUndefined();
  });
});

// ============================================================
// [M2] LiveSourceBadge — degraded CoinDCX/Binance legs are AMBER
// ============================================================
describe('v20.7.8 [M2] honest degraded feed badges', () => {
  it('coindcx-rest-stale → amber CoinDCX·stale (never the green RT pill)', () => {
    const b = liveSourceBadge('coindcx-rest-stale');
    expect(b.label).toBe('CoinDCX·stale');
    expect(b.cls).toContain('amber');
    expect(b.cls).not.toContain('emerald');
  });
  it('coindcx-rest-deep-stale → amber CoinDCX·3m-old', () => {
    const b = liveSourceBadge('coindcx-rest-deep-stale');
    expect(b.label).toBe('CoinDCX·3m-old');
    expect(b.cls).toContain('amber');
  });
  it('binance-fx-synth → amber Binance·fx-synth (synthetic INR projection)', () => {
    const b = liveSourceBadge('binance-fx-synth');
    expect(b.label).toBe('Binance·fx-synth');
    expect(b.cls).toContain('amber');
    expect(b.cls).not.toContain('emerald');
  });
  it('the healthy labels keep their original pills (no regression)', () => {
    expect(liveSourceBadge('coindcx-live').label).toBe('CoinDCX·RT');
    expect(liveSourceBadge('coindcx-live').cls).toContain('emerald');
    expect(liveSourceBadge('coindcx-spot-ws').label).toBe('CoinDCX·RT');
    expect(liveSourceBadge('binance-fut-ws').label).toBe('Binance·WS');
  });
});

// ============================================================
// [L4] data.js — TV_SAFE carries Recommend.All; safe path parses it
// ============================================================
describe('v20.7.8 [L4] TV safe-set recommend column', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('fetchTVIndiaBatch parses recommend off the SAFE column set (d[23])', async () => {
    vi.useFakeTimers();
    try {
      const dataMod = await import('../server/ai/data.js');
      let calls = 0;
      const safeRow = {
        s: 'NSE:RELIANCE',
        d: [140, 139, 141, 138, 1_000_000, 0.7, 140, 140, 139, 140, 139,
          55, 0.5, 0.4, 2.1, 140, 25, 14, 11, 1.2, 140, 138, 142, -0.42],
      };
      vi.stubGlobal('fetch', vi.fn(async () => {
        calls++;
        if (calls === 1) return { ok: false }; // TV_FULL rejected → safe retry
        return {
          ok: true,
          json: async () => ({ data: [safeRow] }),
        };
      }));
      const out = await dataMod.fetchTVIndiaBatch(['RELIANCE']);
      expect(calls).toBe(2); // extended set failed, safe set served
      expect(out.RELIANCE).toBeTruthy();
      expect(out.RELIANCE.recommend).toBe(-0.42); // d[23] — was ALWAYS null pre-fix
      expect(out.RELIANCE.bbUpper).toBeNull(); // safe set honestly drops BB
    } finally {
      vi.useRealTimers();
    }
  });
});

// ============================================================
// [M5] supervisor — detached POSIX spawn + process-group kill
// ============================================================
describe('v20.7.8 [M5] supervisor POSIX tree-kill', () => {
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

  it('POSIX startChild spawns DETACHED (own process group → group-killable)', () => {
    const spawnCalls: any[] = [];
    const sup = createSupervisor({
      env: { WATCHDOG_DISABLE: '1', WATCHDOG_LOG_FILE: 'off' },
      spawnFn: (_cmd: string, _args: string[], opts: any) => { spawnCalls.push(opts); return fakeChild(); },
      httpGetFn: () => new EventEmitter() as any,
      nowFn: () => 1_700_000_000_000,
      logFn: () => {},
      journalAppendFn: () => {},
      platformFn: () => 'linux',
      nodeExe: 'node',
      serverEntry: '/app/server/index.js',
      appRoot: '/app',
    });
    sup._i.state.started = true;
    sup._i.startChild();
    expect(spawnCalls.length).toBe(1);
    expect(spawnCalls[0].detached).toBe(true); // v20.7.8: group leader
    expect(spawnCalls[0].stdio).toEqual(['ignore', 'pipe', 'pipe']); // unchanged
  });

  it('win32 startChild stays NON-detached (taskkill /T owns the tree)', () => {
    const spawnCalls: any[] = [];
    const sup = createSupervisor({
      env: { WATCHDOG_DISABLE: '1', WATCHDOG_LOG_FILE: 'off' },
      spawnFn: (_cmd: string, _args: string[], opts: any) => { spawnCalls.push(opts); return fakeChild(); },
      httpGetFn: () => new EventEmitter() as any,
      nowFn: () => 1_700_000_000_000,
      logFn: () => {},
      journalAppendFn: () => {},
      platformFn: () => 'win32',
      nodeExe: 'node',
      serverEntry: '/app/server/index.js',
      appRoot: '/app',
    });
    sup._i.state.started = true;
    sup._i.startChild();
    expect(spawnCalls[0].detached).toBe(false);
  });

  it('POSIX forceKill: group kill attempted, direct SIGKILL still recorded', () => {
    const child = fakeChild(777);
    const sup = createSupervisor({
      env: { WATCHDOG_DISABLE: '1', WATCHDOG_LOG_FILE: 'off' },
      spawnFn: () => fakeChild(),
      httpGetFn: () => new EventEmitter() as any,
      nowFn: () => 1_700_000_000_000,
      logFn: () => {},
      journalAppendFn: () => {},
      platformFn: () => 'linux',
      nodeExe: 'node',
      serverEntry: '/app/server/index.js',
      appRoot: '/app',
    });
    expect(() => sup._i.forceKill(child)).not.toThrow(); // ESRCH on the group kill is caught
    expect(child.killCalls).toEqual(['SIGKILL']); // belt-and-braces direct kill
  });
});

// ============================================================
// Source contracts (routeMount.test.ts precedent) — the fixes that
// live inside heavy runtimes (Express registrar, 3195-line index,
// full OrderConsole render tree) are locked by structure here.
// ============================================================
describe('v20.7.8 source contracts', () => {
  it('[H1] index.js: graceful shutdown SIGTERMs the bot child + blocks post-shutdown restart', () => {
    const s = src('server/index.js');
    expect(s).toMatch(/clearTimeout\(_botRestartTimer\)/);
    expect(s).toMatch(/_botProcess\.kill\('SIGTERM'\)/);
    // the exit handler must NOT schedule a restart once shutdown began
    expect(s).toMatch(/if \(_shuttingDown\)[\s\S]{0,200}no restart/);
  });

  it('[H2] routes.js: auto-executor has the _autoBusy re-entrancy guard with finally-release', () => {
    const s = src('server/ai/routes.js');
    expect(s).toMatch(/if \(_autoBusy\) return/);
    expect(s).toMatch(/_autoBusy = true/);
    expect(s).toMatch(/finally \{ _autoBusy = false; \}/);
  });

  it('[M3] routes.js: registrar is idempotent (double registration cannot double the live loops)', () => {
    const s = src('server/ai/routes.js');
    expect(s).toMatch(/let _registered = false/);
    expect(s).toMatch(/if \(_registered\) \{[\s\S]{0,300}return;\s*\}/);
    expect(s).toMatch(/_registered = true/);
  });

  it('[L6] index.js: jsonError bails on headersSent instead of throwing ERR_HTTP_HEADERS_SENT', () => {
    const s = src('server/index.js');
    expect(s).toMatch(/function jsonError[\s\S]{0,400}res\.headersSent/);
  });

  it('[L7] routes.js: client-derived Telegram fields are HTML-escaped', () => {
    const s = src('server/ai/routes.js');
    expect(s).toMatch(/const _tgEsc = \(v\) =>/);
    expect(s).toMatch(/\$\{_tgEsc\(out\.trade\.symbol\)\}/);
    expect(s).toMatch(/\$\{_tgEsc\(out\.trade\.closeReason\)\}/);
    // no unescaped remainders of the two migrated sites
    expect(s).not.toMatch(/<b>\$\{out\.trade\.symbol\}<\/b>/);
  });

  it('[L9] positionsStream.js: first SSE write is guarded', () => {
    const s = src('server/ai/positionsStream.js');
    expect(s).toMatch(/try \{ res\.write\('retry: 3000\\n\\n'\); \} catch \{ return; \}/);
  });

  it('[M2] cryptoStream.js: degraded legs get honest wire labels (not blanket coindcx-live)', () => {
    const s = src('server/cryptoStream.js');
    expect(s).toMatch(/tsrc === 'coindcx-rest-stale' \|\| tsrc === 'coindcx-rest-deep-stale'/);
    expect(s).toMatch(/t\.__synthetic \? 'binance-fx-synth'/);
  });

  it('[L5] data.js: crypto snapshot INR fallback uses the shared USDINR store, not a flat 84', () => {
    const s = src('server/ai/data.js');
    expect(s).toMatch(/usdInrFallback as _usdInrFallback/);
    expect(s).not.toMatch(/usdPrice \* 84\b/);
  });

  it('[H-1/H-2] OrderConsole: trail + numeric SET buttons gate empty/NaN/non-positive', () => {
    const s = src('src/components/aitrading/OrderConsole.tsx');
    // trail arm + offset: empty → disabled, must be > 0
    expect(s).toMatch(/trailArm\.trim\(\) === '' \|\| !Number\.isFinite\(Number\(trailArm\)\) \|\| !\(Number\(trailArm\) > 0\)/);
    expect(s).toMatch(/trailOff\.trim\(\) === '' \|\| !Number\.isFinite\(Number\(trailOff\)\) \|\| !\(Number\(trailOff\) > 0\)/);
    // numeric fields: empty-string gate (Number('') === 0 hole)
    expect(s).toMatch(/const fNum = f\.val\.trim\(\) === '' \? NaN : Number\(f\.val\)/);
    expect(s).toMatch(/f\.positive \? !\(fNum > 0\) : fNum < 0/);
  });

  it('[H-3] App.tsx: lazyWithRetry clears the one-shot marker on SUCCESS', () => {
    const s = src('src/App.tsx');
    expect(s).toMatch(/\.then\(\(mod: any\) => \{\s*sessionStorage\.removeItem\(key\);/);
  });

  it('[M-1] ProPanels: all three prop-driven loaders carry the stale-response seq guard', () => {
    const s = src('src/components/aitrading/ProPanels.tsx');
    expect((s.match(/if \(seq !== seqRef\.current\) return;/g) || []).length).toBeGreaterThanOrEqual(3);
  });

  it('[M-3] api.ts: unparseable-but-OK auth check PRESERVES the session', () => {
    const s = src('src/utils/api.ts');
    expect(s).toMatch(/res\.json\(\)\.catch\(\(\) => null\)/);
    expect(s).toMatch(/if \(data == null\) return true;/);
  });

  it('[M-5] SignalCard: SimpleTradeTicket guards entry>0 AFTER the hooks (Rules of Hooks safe)', () => {
    const s = src('src/components/aitrading/SignalCard.tsx');
    const ticketStart = s.indexOf('function SimpleTradeTicket');
    const guardPos = s.indexOf('if (!(plan.entry > 0)) return (', ticketStart);
    const hooksEnd = s.indexOf("useEffect(() => () => { if (resultTimer.current) clearTimeout(resultTimer.current); }, []);", ticketStart);
    expect(ticketStart).toBeGreaterThanOrEqual(0);
    expect(guardPos).toBeGreaterThan(hooksEnd); // guard AFTER the last hook
  });

  it('[M-7] deepAnalysisExtras: baseline advances, dead ternary gone, hidden-tab gated', () => {
    const s = src('src/components/aitrading/deepAnalysisExtras.tsx');
    expect(s).toMatch(/let last = sig;/);
    expect(s).toMatch(/last = now;/);
    // the SIDE FLIP appendLog call itself must be unconditionally 'bad'
    // (the old dead ternary lived in the CALL, not the comment)
    expect(s).toMatch(/appendLog\(`SIDE FLIP:[^`]+`, 'bad'\);/);
    expect(s).not.toMatch(/appendLog\(`SIDE FLIP:[^`]+`,\s*now\.side === prev\.side \? 'info' : 'bad'\)/);
    expect(s).toMatch(/if \(document\.hidden\) return;/);
  });
});
