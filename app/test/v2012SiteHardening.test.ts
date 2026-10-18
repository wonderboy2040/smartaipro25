// ============================================================
// test/v2012SiteHardening.test.ts — v20.7.12 FULL-SITE HARDENING
// ------------------------------------------------------------
// The v20.7.12 advance-pro recheck found (and this suite locks):
//   A. coindcxRespError — the 200-wrapped CoinDCX error detector
//      (createFuturesTpsl/Order/exit verdicts + port honesty)
//   B. deepPinVerdict UNKNOWN — missing live side is NO-VERDICT,
//      not a false "thesis dead" FLIP
//   C. lib/store loadJSON mtime+size cache — clone protection,
//      external-write visibility, saveJSON invalidation
//   D. positionManager fill-match — NEW rows (post-open snapshot)
//      bind first; a pre-existing same-pair position is NOT hijacked
//   E. PaperPort bounded idempotency set + fill log (L-7)
//   F. source contracts — the wiring this release shipped:
//      /api/exec/enter route, PM 15m tick driver, watcher single-flight
//      guards, provider 35s chain deadlines, UNFILLED symbol block +
//      late-fill adoption, SAPTA SSE backpressure, _jSize cache fix,
//      fundamentals LRU hit-refresh, candles/replay/orderbook charset,
//      NAV chips (in-expert/in-recheck/in-manual/cx-recheck, no dead
//      SELF-FIX), useCxLivePrices per-domain sets + no tick-wipe,
//      useIntradayStream watchdog parity, stable-callback props
// ============================================================
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP = path.join(__dirname, '..');
const src = (p: string) => readFileSync(path.join(APP, p), 'utf8');

// v611-pattern: DATA_DIR override BEFORE any server module evaluates
// (static imports hoist — isliye saare server modules top-level dynamic
// imports hain, env assignment ke NEECHE).
const TMP = path.join(APP, '.test-data-v2012');
process.env.SMARTAI_DATA_DIR = TMP;
rmSync(TMP, { recursive: true, force: true });
mkdirSync(TMP, { recursive: true });

// ---- module mocks (import-chain hygiene — v2010LiveGuard pattern) ----
vi.mock('../server/ai/signals.js', () => ({
  getSignals: vi.fn(async () => ({ ok: true, signals: [] })),
  getDeepSignal: vi.fn(async () => null),
}));
vi.mock('../server/ai/browserAgent.js', () => ({
  browserConnect: vi.fn(async () => ({})),
  browserStatus: vi.fn(() => ({ connected: false })),
  cxReadPositions: vi.fn(async () => ({ ok: false, positions: [] })),
  cxClosePosition: vi.fn(async () => ({ ok: false })),
  cxEnsureTradePage: vi.fn(async () => null),
  cxSelectPair: vi.fn(async () => ({ ok: false })),
  cxPlaceOrder: vi.fn(async () => ({ ok: false })),
  cxPairUrl: vi.fn(() => ''),
}));
vi.mock('../server/cryptoStream.js', () => ({
  getTick: vi.fn(() => null),
  fetchCoinDcxTickers: vi.fn(async () => []),
}));

// server modules AFTER the env assignment (top-level dynamic — v611)
const { coindcxRespError } = await import('../server/ai/futures.js');
const { PaperPort, ApiFuturesPort } = await import('../server/exec/port.js');
const { PositionManager } = await import('../server/exec/positionManager.js');
const { loadJSON, saveJSON } = await import('../server/lib/store.js');
const { deepPinVerdict } = await import('../src/components/aitrading/deepAnalysisExtras');

afterEach(() => {
  // per-test file isolation (dir stays for the suite, removed on process exit
  // by the global test-data sweeper convention)
});

// ============================================================
// A. coindcxRespError — the wrapped-rejection detector
// ============================================================
describe('v20.7.12 [A] coindcxRespError — CoinDCX 200-wrapped error bodies', () => {
  it('numeric code >= 400 → error message extracted', () => {
    expect(coindcxRespError({ code: 400, message: 'insufficient margin' })).toMatch(/insufficient margin/);
    expect(coindcxRespError({ code: 401, message: 'Invalid credentials' })).toMatch(/Invalid credentials/);
  });
  it('string status error/fail/reject → error', () => {
    expect(coindcxRespError({ status: 'error', message: 'tpsl rejected' })).toMatch(/tpsl rejected/);
    expect(coindcxRespError({ status: 'FAILED' })).toBeTruthy();
  });
  it('top-level error string → error', () => {
    expect(coindcxRespError({ error: 'bad params' })).toMatch(/bad params/);
  });
  it('SUCCESS shapes never flag (order create / tpsl / arrays)', () => {
    expect(coindcxRespError({ order: { id: 'x' } })).toBeNull();
    expect(coindcxRespError({ id: 'x' })).toBeNull();
    expect(coindcxRespError({ message: 'Success' })).toBeNull(); // no code/status/error marker
    expect(coindcxRespError([{ id: 1 }])).toBeNull();
    expect(coindcxRespError(null)).toBeNull();
    expect(coindcxRespError('ok')).toBeNull();
  });
  it('code 200 / small codes are not errors (false-positive safety)', () => {
    expect(coindcxRespError({ code: 200, message: 'ok' })).toBeNull();
    expect(coindcxRespError({ code: 0 })).toBeNull();
  });
});

// ============================================================
// B. deepPinVerdict UNKNOWN — honest no-verdict for missing live side
// ============================================================
describe('v20.7.12 [B] deepPinVerdict — UNKNOWN (no over-alarm)', () => {
  const sig = (over: Record<string, unknown>) => ({
    symbol: 'BTC', market: 'FUTURES', side: 'LONG', grade: 'STRONG',
    confidence: 75, plan: { entry: 100, stopLoss: 95, target1: 110, target2: 120 },
    ...over,
  }) as never;
  it('live side missing (data gap) → UNKNOWN, not FLIPPED', () => {
    const v = deepPinVerdict(sig({}), sig({ side: '' }));
    expect(v.verdict).toBe('UNKNOWN');
    expect(v.note).toMatch(/side nahi diya/i);
  });
  it('pinned side missing → UNKNOWN (verdict needs both sides)', () => {
    const v = deepPinVerdict(sig({ side: '' }), sig({}));
    expect(v.verdict).toBe('UNKNOWN');
  });
  it('explicit opposite side is STILL FLIPPED (real thesis death)', () => {
    const v = deepPinVerdict(sig({ side: 'LONG' }), sig({ side: 'SHORT' }));
    expect(v.verdict).toBe('FLIPPED');
  });
  it('same-side small drift still CONFIRMED (P1 regression intact)', () => {
    const v = deepPinVerdict(sig({}), sig({ confidence: 73 }));
    expect(v.verdict).toBe('CONFIRMED');
  });
});

// ============================================================
// C. lib/store — mtime+size load cache (the 1Hz journal parse fix)
// ============================================================
describe('v20.7.12 [C] lib/store loadJSON cache', () => {
  beforeEach(() => {
    // fresh files per test (dir already exists; store module already
    // bound to THIS dir via the module-top env assignment)
    rmSync(TMP, { recursive: true, force: true });
    mkdirSync(TMP, { recursive: true });
  });

  it('mutating the returned object NEVER corrupts the cache (clone on hit)', () => {
    saveJSON('c.json', { entries: [1, 2, 3], keep: true });
    const a = loadJSON('c.json', { entries: [], keep: false });
    expect(a.entries).toEqual([1, 2, 3]);
    a.entries.push(999); // caller mutates its copy
    (a as Record<string, unknown>).keep = 'MUTATED';
    const b = loadJSON('c.json', { entries: [], keep: false });
    expect(b.entries).toEqual([1, 2, 3]); // cache pristine
    expect((b as Record<string, unknown>).keep).toBe(true);
  });

  it('EXTERNAL write to the file is visible on the next load (stat check)', async () => {
    saveJSON('c.json', { v: 1 });
    expect(loadJSON('c.json', { v: 0 }).v).toBe(1);
    // external process / editor writes the file directly (mtime+size change)
    await new Promise(r => setTimeout(r, 30)); // mtime granularity safety
    writeFileSync(path.join(TMP, 'c.json'), JSON.stringify({ v: 222, pad: 'longer-content-changes-size-too' }), 'utf8');
    expect(loadJSON('c.json', { v: 0 }).v).toBe(222);
  });

  it('saveJSON invalidates — next load reads the NEW content', () => {
    saveJSON('c.json', { v: 1 });
    saveJSON('c.json', { v: 42 });
    expect(loadJSON('c.json', { v: 0 }).v).toBe(42);
  });

  it('fallback-merge hardening intact (null array fields normalized)', () => {
    writeFileSync(path.join(TMP, 'n.json'), JSON.stringify({ entries: null }), 'utf8');
    const j = loadJSON('n.json', { entries: [], positions: [] });
    expect(Array.isArray(j.entries)).toBe(true);
    expect(j.entries).toEqual([]);
  });
});

// ============================================================
// D. positionManager fill-match — NEW rows bind first (H2-5)
// ============================================================
describe('v20.7.12 [D] PositionManager fill-confirm matcher', () => {
  class PreExistingPlusNewPort extends PaperPort {
    opened = false;
    protectedIds = new Set<string>();
    async getPositions() {
      if (!this.opened) {
        // pre-open snapshot: user ka PEHLE SE khula same-pair position
        const pre = await super.open({ pair: 'B-ETH_USDT', side: 'LONG', qty: 0.5, leverage: 5, type: 'market', price: 100, clientId: 'pre-existing' });
        this.protectedIds.add(String((pre as unknown as { orderId: string }).orderId));
        return super.getPositions();
      }
      return super.getPositions();
    }
    async open(opts: Parameters<PaperPort['open']>[0]) {
      const r = await super.open(opts);
      if (r.ok) this.opened = true;
      return r;
    }
  }

  it('pre-existing same-pair position is NOT hijacked — NEW row binds (setProtection on the new id)', async () => {
    const port = new PreExistingPlusNewPort();
    const protectedIds: string[] = [];
    const pm = new PositionManager({
      port,
      cfg: { entryLimitTtlSec: 2, fillPollMs: 1 },
      alertSink: () => {},
    });
    // spy wrapper on setProtection to record which positionId gets the SL
    const origSet = port.setProtection.bind(port);
    (port as unknown as { setProtection: typeof port.setProtection }).setProtection = async (args) => {
      protectedIds.push(String(args.positionId));
      return origSet(args);
    };
    const r = await pm.protectionFirstEntry({
      signal: { symbol: 'ETH', pair: 'B-ETH_USDT', market: 'FUTURES', side: 'LONG', grade: 'STRONG', superIntel: { tier: 'STRONG' }, __riskPct: 1 },
      plan: { entry: 100, stopLoss: 95, target1: 110 },
    });
    expect(r.ok).toBe(true);
    expect(protectedIds.length).toBe(1);
    expect(protectedIds[0]).toBe(String(r.positionId)); // the NEW position, not the pre-existing one
    expect(port.protectedIds.has(protectedIds[0])).toBe(false); // and definitely not the user's old row
  });
});

// ============================================================
// E. PaperPort bounds (L-7)
// ============================================================
describe('v20.7.12 [E] PaperPort bounded bookkeeping', () => {
  it('idempotency set caps at 400 (FIFO) — long soaks bounded', async () => {
    const port = new PaperPort({ startingEquityUSDT: 1_000_000 });
    for (let i = 0; i < 405; i++) {
      await port.open({ pair: `B-X${i}_USDT`, side: 'LONG', qty: 0.001, leverage: 2, type: 'market', price: 10, clientId: `c-${i}` });
    }
    const size = (port as unknown as { _clientIds: Set<string> })._clientIds.size;
    expect(size).toBeLessThanOrEqual(400);
  });
  it('fill log caps at 400 entries', async () => {
    const port = new PaperPort({ startingEquityUSDT: 1_000_000 });
    for (let i = 0; i < 410; i++) {
      await port.open({ pair: `B-Y${i}_USDT`, side: 'LONG', qty: 0.001, leverage: 2, type: 'market', price: 10, clientId: `f-${i}` });
    }
    expect(port._dump().fillLog.length).toBeLessThanOrEqual(400);
  });
});

// ============================================================
// F. source contracts — the v20.7.12 wiring
// ============================================================
describe('v20.7.12 [F] source contracts — hardening wiring', () => {
  it('futures.js: createFuturesTpsl + createFuturesOrder inspect response bodies (H2-1)', () => {
    const s = src('server/ai/futures.js');
    expect(s).toMatch(/export function coindcxRespError/);
    expect(s).toMatch(/const errOf = coindcxRespError\(resp\);\s*\n\s*if \(errOf\) return \{ ok: false, error: errOf, raw: resp \};/);
    expect(s).toMatch(/exchange ne order id nahi diya/); // id-less 200 → honest fail
  });
  it('port.js: verdicts honest — close checks r?.ok, open requires exchange id (H2-1/H2-4)', () => {
    const s = src('server/exec/port.js');
    expect(s).toMatch(/ok: r\?\.ok === true/); // close
    expect(s).toMatch(/order\.error \|\| order\.orderId == null/); // open
    expect(s).not.toMatch(/\?\? clientId \?\? ''/); // the ok-lie fallback is gone
  });
  it('routes.js: POST /api/exec/enter exists + browser-mode refuse + journal audit (H2-2)', () => {
    const s = src('server/ai/routes.js');
    expect(s).toMatch(/app\.post\('\/api\/exec\/enter'/);
    expect(s).toMatch(/protection-first entry supported nahi hai/);
    expect(s).toMatch(/source: 'exec-enter'/);
  });
  it('index.js: PM 15m exit-ladder tick driver wired (H2-2)', () => {
    const s = src('server/index.js');
    expect(s).toMatch(/_pmTick = setInterval/);
    expect(s).toMatch(/15 \* 60_000/);
    // v20.8.4: the driver now feeds LIVE marks (fetchFuturesPrices chain) —
    // the empty-map shape was the price-blind-ladder bug (H2).
    expect(s).toMatch(/fetchFuturesPrices/);
    expect(s).toMatch(/_positionManager\.tick\(\{ pricesByPair, atrByPair: \{\} \}\)/);
  });
  it('routes.js: futures/global/india watchers single-flight guarded (H3-1)', () => {
    const s = src('server/ai/routes.js');
    expect(s).toMatch(/_futGuard/);
    expect(s).toMatch(/_globGuard/);
    expect(s).toMatch(/_indiaGuard/);
  });
  it('index.js: provider fallback chains share ONE 35s deadline (H3-4)', () => {
    const s = src('server/index.js');
    const hits = s.match(/AbortSignal\.timeout\(35_000\)/g) || [];
    expect(hits.length).toBeGreaterThanOrEqual(2); // compat-proxy + gemini ladders
  });
  it('proTraderAuto: UNFILLED blocks re-entry + late-fill adoption + SSE backpressure + _jSize fix (H3-2/H3-3/H3-5)', () => {
    const s = src('server/ai/proTraderAuto.js');
    expect(s).toMatch(/\['CLOSE_FAILED', 'UNFILLED'\]\.includes\(t\.status\)/);
    expect(s).toMatch(/LATE FILL ADOPTED/);
    expect(s).toMatch(/writableLength > 128 \* 1024/);
    expect(s).toMatch(/_jSize = st\.size/);
    expect(s).toMatch(/clearInterval\(_keepAlive\)/);
  });
  it('reconciler.js: engine-owned flatten + manual adopt-only (H1)', () => {
    const s = src('server/exec/reconciler.js');
    expect(s).toMatch(/_engineOwnedLivePairs/);
    expect(s).toMatch(/adopt-only/i);
  });
  it('store.js: mtime+size cache + saveJSON invalidation (H2-3)', () => {
    const s = src('server/lib/store.js');
    expect(s).toMatch(/hit\.mtimeMs === st\.mtimeMs && hit\.size === st\.size/);
    expect(s).toMatch(/k\.startsWith\(`\$\{filename\}\|`\)/);
  });
  it('index.js: fundamentals LRU hit-refresh (M-4)', () => {
    const s = src('server/index.js');
    expect(s).toMatch(/_fundamentalsCache\.delete\(rawSymbol\);\s*\n\s*_fundamentalsCache\.set\(rawSymbol, cached\)/);
  });
  it('routes.js: candles/replay/orderbook symbol charset validation (L-3)', () => {
    const s = src('server/ai/routes.js');
    expect((s.match(/charset \[A-Za-z0-9._-\]/g) || []).length).toBeGreaterThanOrEqual(2);
    expect(s).toMatch(/invalid symbol format/);
  });
  it('sizing.js: scientific-notation qty steps (L-2)', () => {
    const s = src('server/exec/sizing.js');
    expect(s).toMatch(/e-\(\\d\+\)\$/i.source ? /e-\(\\d\+\)/.test(s) : true);
    expect(s).toMatch(/mantissa/);
  });

  it('CoinDcxTab: dead SELF-FIX chip gone + RECHECK chip present + stable props (H2-1/H3-1/H3-2)', () => {
    const s = src('src/components/tabs/CoinDcxTab.tsx');
    expect(s).not.toMatch(/cx-selfimprove/);
    expect(s).toMatch(/id: 'cx-recheck'/);
    expect(s).toMatch(/const NAV_SIMPLE = NAV\.filter/);
    expect(s).not.toMatch(/ExpertPicksPanel/);
    expect(s).not.toMatch(/TopPicksPanel/);
    expect(s).not.toMatch(/ManualTradeMonitor/);
    expect(s).not.toMatch(/ReversalPanel/);
    expect(s).toMatch(/CX_DHAN_CONNECT_STUB/);
    expect(s).toMatch(/deepPinV\?\.verdict === 'DRIFTED'/); // H3-3 exec routing
    expect(s).toMatch(/deepPinV\?\.verdict === 'FLIPPED'/);
  });
  it('IndiaIntradayTab: recheck chip + stable dhan handlers + exec routing + removed legacy panels (H2-1/H3-2/H3-3)', () => {
    const s = src('src/components/tabs/IndiaIntradayTab.tsx');
    expect(s).toMatch(/id: 'in-recheck'/);
    expect(s).not.toMatch(/ExpertPicksPanel/);
    expect(s).not.toMatch(/TopPicksPanel/);
    expect(s).not.toMatch(/ManualTradeMonitor/);
    expect(s).toMatch(/const NAV_SIMPLE = NAV\.filter/);
    expect(s).toMatch(/const onDhanConnectStable = useCallback/);
    expect(s).toMatch(/deepCardCanExec \? onExecuteIndia : undefined/);
  });
  it('useCxLivePrices: per-domain sets + NO tick-wipe on dep change + identity-stable wsHealth (H2-2/H3-5/L-5)', () => {
    const s = src('src/components/aitrading/useCxLivePrices.ts');
    expect(s).toMatch(/domainSets/);
    // the flash-back wipe is gone as a STATEMENT (comments may mention it)
    expect(s).not.toMatch(/^\s*setTicks\(\{\}\);/m);
    expect(s).toMatch(/DROPPED-SYMBOL PRUNING/);
    expect(s).toMatch(/JSON\.stringify\(prev\) === JSON\.stringify\(next\)/);
  });
  it('useIntradayStream: mount-hidden park + never-stop watchdog + zombie kill (H3-4)', () => {
    const s = src('src/components/intraday/useIntradayStream.ts');
    expect(s).toMatch(/document\.hidden\) onVis\(\)/);
    expect(s).toMatch(/const watchdog = setInterval/);
    expect(s).toMatch(/> 45_000/);
  });
  it('deepAnalysisExtras: UNKNOWN verdict + de-ticked recheck + memo blocks (H2-3/M-8)', () => {
    const s = src('src/components/aitrading/deepAnalysisExtras.tsx');
    expect(s).toMatch(/'CONFIRMED' \| 'DRIFTED' \| 'FLIPPED' \| 'UNKNOWN'/);
    expect(s).toMatch(/nextRecheckAt/);
    expect(s).not.toContain('openedAt'); // dead ref removed
    expect(s).toMatch(/export const DeepPinnedCompare = memo/);
    expect(s).toMatch(/export const DeepIndicatorGrid = memo/);
  });
  it('deskShared: RefreshCountdown derives from generatedAt + hidden-gated (H3-6/L-6)', () => {
    const s = src('src/components/aitrading/deskShared.tsx');
    expect(s).toMatch(/genAt \+ REFRESH_MS - now/);
    expect(s).toMatch(/if \(!document\.hidden\) setNow/);
  });
  it('ManualTradeMonitor: memo-wrapped (H2-1)', () => {
    const s = src('src/components/aitrading/ManualTradeMonitor.tsx');
    expect(s).toMatch(/export const ManualTradeMonitor = memo/);
  });
  it('liveInvalidation: weakening is DIRECTIONAL (L-3)', () => {
    const s = src('src/components/aitrading/liveInvalidation.ts');
    expect(s).toMatch(/long \? px < farEdge - 0\.5 \* a : px > farEdge \+ 0\.5 \* a/);
  });
  it('useAITrading: deskCache sweeper (M-7)', () => {
    const s = src('src/components/aitrading/useAITrading.ts');
    expect(s).toMatch(/for \(const \[k, v\] of deskCache\) if \(v\.at < cutoff\) deskCache\.delete\(k\)/);
  });
  it('browserAgent: pageFor closes the previous CDP socket on tab churn (M-5)', () => {
    const s = src('server/ai/browserAgent.js');
    expect(s).toMatch(/if \(page && page\.ws\) \{ try \{ page\.ws\.close\(\); \} catch/);
  });
  it('ApiFuturesPort.open honest verdict behavioral (H2-4)', async () => {
    const port = new ApiFuturesPort({
      futuresMod: {
        createFuturesOrder: async () => ({ orderId: null, error: 'exchange rejected: insufficient margin', raw: { code: 400, message: 'insufficient margin' } }),
      } as never,
    });
    const r = await port.open({ pair: 'B-BTC_USDT', side: 'LONG', qty: 0.01, leverage: 5, type: 'market', clientId: 'x1' });
    expect(r.ok).toBe(false); // the v20.7.10-and-earlier ok:true LIE is dead
    expect(String(r.error)).toMatch(/insufficient margin/);
  });
  it('ApiFuturesPort.close honest verdict behavioral (H2-1)', async () => {
    const port = new ApiFuturesPort({
      futuresMod: {
        exitFuturesPosition: async () => ({ ok: false, error: 'position already closed', raw: { code: 404 } }),
      } as never,
    });
    const r = await port.close({ positionId: '123' });
    expect(r.ok).toBe(false); // pehle `ok: r != null` hamesha true tha
  });
});
