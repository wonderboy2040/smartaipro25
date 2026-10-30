// ============================================================
// test/siteRecheck212312.test.ts — v21.23.12 FULL-SITE DEEP RECHECK
// ------------------------------------------------------------
// v21.23.11 ke baad ka fresh-eyes 4-domain audit (data / signal /
// exec / routes-UI) ne ~20 real defects diye. Ye suite unke REGRESSION
// LOCKS hai — har lock apne fix ka EXACT disease class pin karta hai:
//
//   S1  India MTF-live wrapper arity (getFreshSignalForExec me market
//       param tha hi nahi — 'INDIA' deps-slot me jaati thi → India
//       MTF live STRUCTURALLY dead; ab getDeepSignal(sym,'INDIA',…))
//   S2  gauntlet-side dataDegraded veto (v21.23.4 contract order-time
//       par enforce — manual/auto LIVE click pe degraded STRONG block)
//   S3  computeTrailSl / S4 fitPlanToRiskCap / S5 ratchetSl / S6
//       dhanOrderBody — v21.23.9 doctrine sweep (unknown side ≠ silent
//       LONG/SELL default)
//   S7  deep-path v21.23.4 ladder parity (__tfDegraded honest reject +
//       __tfDataThin stamp — board ≠ deep asymmetry khatam)
//   S8  resampleCandles mirror-cure (India committee 15m→1h chain)
//   S9  seriesOrientation KEY-DRIFT blind-spot cure (t/open_time/T/ts
//       keyed desc rows ab detect hote hain)
//   S10 parseCandleRow present-but-NaN high/low = DROP (contract honesty)
//   S11 cert pass-semantics (all-UNREACHABLE ≠ PASS) + wireAbsorb shape
//   S12 globalFutures USDC leg canonicalize (last uncanonicalized reader)
//   S13 futures candle-cache limit-in-key (depth-poison cure)
//   S14 India LIVE close fill-verify (naked-shares disease)
//   S15 mtfAutoLink re-anchor lifecycle reset (stale side/peak/t1Hit/
//       openedAt → instant-close churn + wrong-side management)
//   S16 liveClose null-verdict honesty (wrapper-throw ≠ success)
//   S17 reject-dedup scan-20 (journal-window displacement cure ×3 desks)
//   S18 agent failed-entry backoff stamp
//   S19 updatePaperTradeStopLoss marketHint (cross-desk collision cure)
//   S20 honest confluence (?? 5 / ?? 60 fabrication sweep)
//   S21 seat-guard sweep — desc-vs-asc equality (smc/swing/whale/
//       structureStop/maCross/entryTiming/simulateSymbol)
//   S22 canonicalizer recent-telemetry ring (wire-drift visibility)
//   S23 /api/chart ms-unit + watchdog stamps
// ============================================================
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const APP_ROOT = path.join(__dirname, '..');
const read = (rel) => readFileSync(path.join(APP_ROOT, rel), 'utf8');

// ---------------- deterministic synthetic series ----------------
const NOW = Date.now();
function risingSeries(n = 90, intervalMs = 300_000, start = 100) {
  let px = start; const t0 = NOW - n * intervalMs;
  return Array.from({ length: n }, (_, i) => {
    px *= 1.003;
    const wick = px * 0.002;
    return {
      time: t0 + i * intervalMs,
      open: +(px / 1.0015).toFixed(4), high: +(px + wick).toFixed(4),
      low: +(px * (1 - 0.004)).toFixed(4), close: +px.toFixed(4),
      volume: 100 + (i % 11) * 7,
    };
  });
}
function fallingSeries(n = 90, intervalMs = 300_000, start = 100) {
  let px = start; const t0 = NOW - n * intervalMs;
  return Array.from({ length: n }, (_, i) => {
    px *= 0.997;
    const wick = px * 0.002;
    return {
      time: t0 + i * intervalMs,
      open: +(px / 0.9985).toFixed(4), high: +(px + wick).toFixed(4),
      low: +(px * (1 - 0.004)).toFixed(4), close: +px.toFixed(4),
      volume: 100 + (i % 11) * 7,
    };
  });
}
const desc = (rows) => rows.slice().reverse();
const toTKey = (rows) => rows.map(({ time, open, high, low, close, volume }) => ({ t: time, o: open, h: high, l: low, c: close, v: volume }));

// ============================================================
// S1-S6: execution-layer honesty (pure imports)
// ============================================================
import { evaluateExecutionGate, computeTrailSl, fitPlanToRiskCap } from '../server/ai/ensemble.js';
import { dhanOrderBody } from '../server/ai/dhan.js';
import { ratchetSl } from '../server/ai/coindcxOrders.js';

describe('v21.23.12 S1 — India MTF-live wrapper arity (STRUCTURAL-DEAD cure)', () => {
  const routes = read('server/ai/routes.js');
  it('getFreshSignalForExec ko INDIA market-param ke saath call KABHI nahi (us function me market param hai hi nahi)', () => {
    expect(routes).not.toContain("getFreshSignalForExec(sym, 'INDIA'");
  });
  it('dono India wrappers ab getDeepSignal(sym, INDIA, deps) pattern use karte hain', () => {
    expect(routes.match(/getDeepSignal\(sym, 'INDIA', depsForSignals\(\)\)/g)?.length).toBeGreaterThanOrEqual(2);
  });
  it('manual /india/execute + indiaAgent legacy wiring intact (regression guard)', () => {
    expect(routes).toContain("getDeepSignal(sym, 'INDIA', depsForSignals())");
  });
});

describe('v21.23.12 S2 — gauntlet-side dataDegraded veto (v21.23.4 contract at order time)', () => {
  const mkSignal = (over = {}) => ({
    market: 'CRYPTO', side: 'LONG', grade: 'STRONG', confidence: 90, agreement: 0.9,
    generatedAt: Date.now(),
    plan: { riskPct: 2 },
    ...over,
  });
  it('LIVE gauntlet: dataDegraded STRONG signal HARD-REFUSE hota hai (order-time last line)', () => {
    const v = evaluateExecutionGate(mkSignal({ dataDegraded: 'INTRADAY-TF-THIN', degradedReason: 'thin' }), { side: 'LONG', venue: 'CRYPTO' });
    expect(v.ok).toBe(false);
    expect(String(v.reason)).toContain('data-degraded');
  });
  it('LIVE gauntlet: freshTapeAbsent bhi block (29%-WR degenerate mode)', () => {
    const v = evaluateExecutionGate(mkSignal({ freshTapeAbsent: true }), { side: 'LONG', venue: 'CRYPTO' });
    expect(v.ok).toBe(false);
    expect(String(v.reason)).toContain('data-degraded');
  });
  it('practice (paper journaling) allowed rehta hai — v21.23.4 design parity', () => {
    const v = evaluateExecutionGate(mkSignal({ dataDegraded: 'INTRADAY-TF-THIN', grade: 'ACTION', confidence: 60 }), { side: 'LONG', venue: 'CRYPTO', requireStrong: false, practice: true });
    expect(v.ok).toBe(true);
  });
  it('clean STRONG signal LIVE pass (no false-block regression)', () => {
    const v = evaluateExecutionGate(mkSignal(), { side: 'LONG', venue: 'CRYPTO' });
    expect(v.ok).toBe(true);
  });
});

describe('v21.23.12 S3/S4/S5/S6 — unknown-side doctrine sweep (silent LONG/SELL default khatam)', () => {
  it('S3a computeTrailSl: BUY vocab ab LONG jaisa trail karta hai (pehle silent-LONG → SELL trail ulta)', () => {
    const long = computeTrailSl({ side: 'LONG', entryPrice: 100, peakPrice: 112, currentSl: 100, initialRisk: 5, price: 111, offsetR: 1 });
    const buy = computeTrailSl({ side: 'BUY', entryPrice: 100, peakPrice: 112, currentSl: 100, initialRisk: 5, price: 111, offsetR: 1 });
    expect(long?.sl).toBeTruthy();
    expect(buy?.sl).toBe(long?.sl);
  });
  it('S3b computeTrailSl: garbage side → NO trail move (fail-honest null)', () => {
    expect(computeTrailSl({ side: 'garbage', entryPrice: 100, peakPrice: 112, currentSl: 100, initialRisk: 5, price: 111 })).toBeNull();
  });
  it('S4a fitPlanToRiskCap: SELL vocab ka SL entry ke UPAR fit hota hai (pehle silent-LONG → SL neeche)', () => {
    const sig = { side: 'SELL', ltp: 100, plan: { riskPct: 9, target1: 80, target2: 70, stopLoss: 109 } };
    const out = fitPlanToRiskCap(sig, 5);
    expect(out.note).toBeTruthy();
    expect(out.signal.plan.stopLoss).toBeGreaterThan(100);
    expect(out.signal.plan.target1).toBeLessThan(100);
  });
  it('S4b fitPlanToRiskCap: unknown side → unfitted (fail-honest)', () => {
    const sig = { side: 'WEIRD', ltp: 100, plan: { riskPct: 9 } };
    const out = fitPlanToRiskCap(sig, 5);
    expect(out.note).toBeNull();
    expect(out.signal.plan.riskPct).toBe(9);
  });
  it('S5 ratchetSl: BUY → LONG ratchet (tighten-only), garbage → SL move nahi hota', () => {
    expect(ratchetSl('BUY', 100, 110)).toBe(110);
    expect(ratchetSl('BUY', 110, 100)).toBe(110); // never loosens
    expect(ratchetSl('garbage', 100, 110)).toBe(100); // unknown → NO move
    expect(ratchetSl('garbage', 0, 110)).toBeFalsy(); // unknown → no initial arm
    expect(ratchetSl('SELL', 100, 90)).toBe(90);
  });
  it('S6 dhanOrderBody: unknown side LOUD THROW (comment ka fail-honest promise ab code hai)', () => {
    expect(() => dhanOrderBody({ symbol: 'RELIANCE', securityId: '123', side: 'HOLD', quantity: 1 }))
      .toThrow(/unknown side/i);
    // canonical vocabularies still map (no regression)
    expect(dhanOrderBody({ symbol: 'RELIANCE', securityId: '123', side: 'BUY', quantity: 1 }).transactionType).toBe('BUY');
    expect(dhanOrderBody({ symbol: 'RELIANCE', securityId: '123', side: 'SHORT', quantity: 1 }).transactionType).toBe('SELL');
    expect(dhanOrderBody({ symbol: 'RELIANCE', securityId: '123', side: 'LONG', quantity: 1, kind: 'SL', triggerPrice: 99 }).transactionType).toBe('SELL');
  });
});

// ============================================================
// S7/S8: deep-path ladder + resample mirror-cure
// ============================================================
import { resampleCandles } from '../server/ai/signals.js';
import { seriesOrientation, parseCandleRow, canonicalizeCandles, ensureAscending, candleCanonicalStats, __resetCandleCanonicalStatsForTest } from '../server/ai/lib/candles.js';

describe('v21.23.12 S7 — deep-path v21.23.4 ladder parity (board ≠ deep asymmetry khatam)', () => {
  it('signals.js deep path me __tfDegraded honest-reject wired hai', () => {
    const src = read('server/ai/signals.js');
    expect(src).toMatch(/__tfDegraded\)\s*\{\s*const payload = \{\s*ok: false,\s*reason: `INTRADAY-TF-UNAVAILABLE/);
  });
  it('deep path __tfDataThin consensus.dataDegraded stamp deta hai (executable:false + gauntlet veto chain)', () => {
    const src = read('server/ai/signals.js');
    expect(src).toContain("consensus = {\n      ...consensus,\n      dataDegraded: 'INTRADAY-TF-THIN',");
  });
});

describe('v21.23.12 S8 — resampleCandles mirror-cure (India committee 15m→1h chain)', () => {
  it('DESC 15m input → ASC 1h buckets, newest close = last bucket close (pehle mirrored buckets)', () => {
    const rising = risingSeries(120, 900_000); // 30h of 15m bars rising
    const asc = resampleCandles(rising, 60);
    const out = resampleCandles(desc(rising), 60);
    expect(seriesOrientation(out)).toBe('asc');
    expect(out.length).toBe(asc!.length);
    expect(out![out!.length - 1].close).toBeCloseTo(rising[rising.length - 1].close, 4);
    expect(out![0].close).toBeCloseTo(asc![0].close, 4);
  });
  it('falling desc input → falling asc buckets (direction preserved, mirror nahi)', () => {
    const falling = fallingSeries(90, 900_000);
    const out = resampleCandles(desc(falling), 60);
    expect(seriesOrientation(out)).toBe('asc');
    expect(out![0].close).toBeGreaterThan(out![out!.length - 1].close);
  });
});

// ============================================================
// S9/S10/S22: canonicalizer hardening + telemetry ring
// ============================================================
describe('v21.23.12 S9 — seriesOrientation KEY-DRIFT blind-spot cure', () => {
  it('legacy {t,...} keyed DESC rows ab DETECT hote hain (pehle NaN → unknown → untouched mirror)', () => {
    const rising = risingSeries(40, 900_000);
    const tKeyedDesc = toTKey(desc(rising));
    expect(seriesOrientation(tKeyedDesc)).toBe('desc');
    const fixed = ensureAscending(tKeyedDesc);
    expect(seriesOrientation(fixed)).toBe('asc');
    expect(Number(fixed![fixed!.length - 1].t)).toBeGreaterThan(Number(fixed![0].t));
  });
  it('open_time-keyed desc rows bhi (SDK wire-drift shape)', () => {
    const rising = risingSeries(40, 900_000);
    const rows = desc(rising).map((r) => ({ open_time: r.time, open: r.open, high: r.high, low: r.low, close: r.close, volume: r.volume }));
    expect(seriesOrientation(rows)).toBe('desc');
    expect(seriesOrientation(ensureAscending(rows))).toBe('asc');
  });
  it('seconds-scale t-keyed rows bhi detect (s↔ms normalize)', () => {
    const rising = risingSeries(40, 900_000);
    const rows = desc(rising).map((r) => ({ t: Math.round(r.time / 1000), o: r.open, h: r.high, l: r.low, c: r.close, v: r.volume }));
    expect(seriesOrientation(rows)).toBe('desc');
  });
});

describe('v21.23.12 S10 — parseCandleRow contract honesty (present-but-NaN high/low = DROP)', () => {
  it('high: NaN present → row DROP (comment ka "DROPPED, never repaired" promise)', () => {
    expect(parseCandleRow({ time: NOW, open: 100, high: NaN, low: 99, close: 101, volume: 1 })).toBeNull();
  });
  it('low: "oops" present → row DROP', () => {
    expect(parseCandleRow({ time: NOW, open: 100, high: 102, low: 'oops', close: 101, volume: 1 })).toBeNull();
  });
  it('high OMITTED (WS roll bar) → honest synth ab bhi (no regression)', () => {
    const r = parseCandleRow({ time: NOW, open: 100, low: 99, close: 101, volume: 1 });
    expect(r?.high).toBe(101);
  });
});

describe('v21.23.12 S22 — canonicalizer recent-telemetry ring (wire-drift visibility)', () => {
  beforeEach(() => { __resetCandleCanonicalStatsForTest(); });
  it('desc wire canonicalize → recent ring me {label, orientation:desc, dropped} entry', () => {
    canonicalizeCandles(toTKey(desc(risingSeries(40, 900_000))), { label: 'cdc-spot:BTC:15m' });
    const st = candleCanonicalStats();
    expect(st.recent.length).toBe(1);
    expect(st.recent[0].label).toBe('cdc-spot:BTC:15m');
    expect(st.recent[0].orientation).toBe('desc');
    expect(st.recent[0].outBars).toBe(40);
  });
  it('ring bounded (16) — telemetry kabhi unbounded grow nahi karti', () => {
    for (let i = 0; i < 20; i++) canonicalizeCandles(risingSeries(40, 900_000), { label: `x:${i}` });
    expect(candleCanonicalStats().recent.length).toBeLessThanOrEqual(16);
  });
});

// ============================================================
// S11: certificate pass-semantics + shape
// ============================================================
import { runLiveDirectionCertificate } from '../server/ai/directionLiveCert.js';

describe('v21.23.12 S11 — cert pass-semantics honesty (all-UNREACHABLE ≠ PASS)', () => {
  it('payload shape: verifiedChains/unverifiedChains/wireAbsorb fields + current stamp', async () => {
    const r = await runLiveDirectionCertificate();
    // v21.27.2 honest pin bump: cert ab release version ke saath stamped hai.
    expect(r.version).toBe('v21.29.1');
    expect(typeof r.verifiedChains).toBe('number');
    expect(typeof r.unverifiedChains).toBe('number');
    expect(Array.isArray(r.wireAbsorb)).toBe(true);
  }, 90_000);
  it('pass ⇒ ≥1 chain actually PASS (0-verified kabhi PASS nahi)', async () => {
    const r = await runLiveDirectionCertificate();
    if (r.pass) expect(r.verifiedChains).toBeGreaterThan(0);
    else expect(r.verifiedChains === 0 || r.chains.some((c) => c.status === 'FAIL')).toBe(true);
  }, 90_000);
  it('0-verified case me summary INCONCLUSIVE bolti hai', async () => {
    const r = await runLiveDirectionCertificate();
    if (r.verifiedChains === 0 && !r.chains.some((c) => c.status === 'FAIL')) {
      expect(r.summary).toContain('INCONCLUSIVE');
      expect(r.pass).toBe(false);
    }
  }, 90_000);
  it('source-lock: pass formula me passCount > 0 required hai', () => {
    const src = read('server/ai/directionLiveCert.js');
    expect(src).toContain('fails.length === 0 && passCount > 0 && synthetic.pass');
  });
});

// ============================================================
// S12: globalFutures USDC leg (the last uncanonicalized reader)
// ============================================================
import { fetchGlobalUsdcCandleQuotes, __resetGlobalForTests } from '../server/ai/globalFutures.js';

describe('v21.23.12 S12 — globalFutures USDC candle-quote leg canonicalize', () => {
  afterEach(() => { vi.restoreAllMocks(); __resetGlobalForTests?.(); });
  it('newest-first legacy wire → price = TRUE newest close (pehle NaN-sort no-op → ~30-min-stale OLDEST bar)', async () => {
    const rows = desc(risingSeries(35, 60_000)).map((r) => ({
      time: r.time, open: r.open, high: r.high, low: r.low, close: r.close, volume: r.volume,
    }));
    const trueNewest = rows[0].close; // desc[0] = newest
    globalThis.fetch = vi.fn(async () => ({ ok: true, status: 200, json: async () => rows })) as unknown as typeof fetch;
    const q = await fetchGlobalUsdcCandleQuotes({ bases: ['BTC'] });
    expect(q.get('BTC')?.price).toBeCloseTo(trueNewest, 4);
  }, 20_000);
  it('open_time key drift rows bhi (NaN-time filter disease) → canonical asc, newest price', async () => {
    const rising = risingSeries(35, 60_000);
    const rows = desc(rising).map((r) => ({ open_time: r.time, open: r.open, high: r.high, low: r.low, close: r.close, volume: r.volume }));
    const trueNewest = rows[0].close;
    globalThis.fetch = vi.fn(async () => ({ ok: true, status: 200, json: async () => rows })) as unknown as typeof fetch;
    const q = await fetchGlobalUsdcCandleQuotes({ bases: ['BTC'] });
    expect(q.get('BTC')?.price).toBeCloseTo(trueNewest, 4);
  }, 20_000);
});

// ============================================================
// S13/S17/S18: journal-dedup + cache-key + agent backoff (source locks)
// ============================================================
describe('v21.23.12 S13 — reject-dedup + cache-key + close-verify wiring (source locks)', () => {
  it('S13a futures candle-cache key me limit hai (depth-poison cure)', () => {
    const src = read('server/ai/futures.js');
    expect(src).toContain('const cacheKey = `fut:${pair}:${resolution}:${');
  });
  it('S17a coindcxOrders reject() me 5-min scan-20 dedup hai', () => {
    const src = read('server/ai/coindcxOrders.js');
    expect(src).toContain('__repeatCount = (Number(e.__repeatCount) || 1) + 1');
  });
  it('S17b futures reject() me same dedup hai (spot-futures parity)', () => {
    const src = read('server/ai/futures.js');
    expect(src).toContain("REJECT-DEDUP — futures side");
    expect(src).toContain('__repeatCount = (Number(e.__repeatCount) || 1) + 1');
  });
  it('S17c indiaOrders dedup ab last-20 scan karta hai (interleaved-entry chain-break cure)', () => {
    const src = read('server/ai/indiaOrders.js');
    expect(src).toContain('DEDUP SCAN-20');
    expect(src).toContain('for (let k = _entries.length - 1, n = 0; k >= 0 && n < 20; k--, n++)');
  });
  it('S18 agent failed-entry backoff: stamp + skip + 10-min window', () => {
    const src = read('server/ai/agent.js');
    expect(src).toContain('_stampFailedEntryBackoff(pairOfSignal(best)');
    expect(src).toContain('FAILED_ENTRY_BACKOFF_MS = 10 * 60_000');
    expect(src).toContain('_failedEntryBackoff.get(_fbPair)');
  });
});

// ============================================================
// S14: India LIVE close fill-verify (naked-shares disease)
// ============================================================
describe('v21.23.12 S14 — India LIVE close fill-verify (entry-path parity)', () => {
  it('dhanOrderStatus poll helper + teeno close paths verified-fill maange hain', () => {
    const src = read('server/ai/indiaOrders.js');
    expect(src).toContain('async function _dhanVerifyFill(orderId');
    expect(src).toContain("os.includes('TRADED') || os.includes('FILLED') || os.includes('COMPLETE')");
    // watcher / partial / manual teeno call-sites
    expect(src.match(/_dhanVerifyFill\(/g)?.length).toBeGreaterThanOrEqual(3);
    expect(src).toContain('watcher-close:');
    expect(src).toContain('partial-close:');
    expect(src).toContain('manual-close:');
  });
  it('SL-M cancel sirf verified fill ke BAAD (naked-shares guard)', () => {
    const src = read('server/ai/indiaOrders.js');
    expect(src).toContain('position OPEN + SL-M armed');
  });
});

// ============================================================
// S15: mtfAutoLink re-anchor lifecycle reset
// ============================================================
import { recordLiveMtfBoardTrade, __resetMtfAutoForTests } from '../server/ai/mtfAutoLink.js';

describe('v21.23.12 S15 — recordLiveMtfBoardTrade re-anchor lifecycle reset', () => {
  beforeEach(() => { __resetMtfAutoForTests(); });
  it('existing OPEN row re-anchor: side/peakPrice/t1Hit/openedAt sab FRESH hote hain', () => {
    // pehla LIVE LONG order
    const r1 = recordLiveMtfBoardTrade({
      symbol: 'BTC', market: 'CRYPTO', side: 'LONG', entry: 100, stopLoss: 90, t1: 110, t2: 120,
      qty: 1, leverage: 5, walletINR: 100000,
    });
    expect(r1?.side).toBe('LONG');
    expect(r1?.deepMonitorStage).toBe('STAGE_0_INITIAL_GUARD');
    // STALE lifecycle poison inject karo (purane row ki tarah)
    r1!.t1Hit = true;
    r1!.peakPrice = 150;
    r1!.openedAt = Date.now() - 3 * 60 * 60_000;
    r1!.deepMonitorStage = 'STAGE_5_LOCK';
    // SAME symbol ka NAYA order — side FLIP ke saath
    const r2 = recordLiveMtfBoardTrade({
      symbol: 'BTC', market: 'CRYPTO', side: 'SHORT', entry: 200, stopLoss: 210, t1: 190, t2: 180,
      qty: 2, leverage: 5, walletINR: 100000, superScore: 88,
    });
    expect(r2).toBe(r1); // re-anchor, naya row nahi
    expect(r2!.side).toBe('SHORT'); // (b) wrong-side management cure
    expect(r2!.t1Hit).toBe(false); // (a) instant Stage-4/5 lock cure
    expect(r2!.peakPrice).toBe(200); // peak naye entry pe reset
    expect(r2!.openedAt).toBeGreaterThan(Date.now() - 60_000); // 90s grace firewall re-armed
    expect(r2!.deepMonitorStage).toBe('STAGE_0_INITIAL_GUARD');
    expect(r2!.entry).toBe(200);
    expect(r2!.stopLoss).toBe(210);
  });
  it('S16 source-lock: liveClose null-verdict ab FAIL hai (undefined permissive contract intact)', () => {
    const src = read('server/ai/mtfAutoLink.js');
    expect(src).toContain("if (lc === null) liveCloseFailed = 'liveClose wrapper threw / returned null");
    expect(src).toContain('undefined = documented legacy permissive stub contract');
  });
  it('S16b source-lock: LIVE close par failed paper-mirror VOID hota hai (double-book cure)', () => {
    const src = read('server/ai/mtfAutoLink.js');
    expect(src).toContain('PAPER-MIRROR VOID');
    expect(src).toContain('paper-mirror-voided');
  });
});

// ============================================================
// S19: updatePaperTradeStopLoss marketHint (cross-desk collision)
// ============================================================
import { openPaperTrade, updatePaperTradeStopLoss, _resetForTests as _resetPaperForTests } from '../server/intraday/paperTrading.js';

describe('v21.23.12 S19 — updatePaperTradeStopLoss marketHint (cross-desk collision cure)', () => {
  beforeEach(() => { _resetPaperForTests(); });
  it('same symbol do desks — marketHint ke bina FIRST match, hint ke saath CORRECT desk', () => {
    const a = openPaperTrade({ symbol: 'ABC', direction: 'LONG', entry: 100, qty: 1, stopLoss: 90, target1: 110, target2: 120, market: 'INDIA' });
    const b = openPaperTrade({ symbol: 'ABC', direction: 'SHORT', entry: 50, qty: 1, stopLoss: 55, target1: 45, target2: 40, market: 'CRYPTO' });
    expect(a.trade || a).toBeTruthy();
    expect(b.trade || b).toBeTruthy();
    const cryptoId = (b.trade || b).id ?? b.id;
    // marketHint = CRYPTO → CRYPTO wale trade ki SL ratchet (LONG India ko chhodo)
    const out = updatePaperTradeStopLoss('ABC', 45, 'CRYPTO');
    expect(out.ok).toBe(true);
    expect((out.trade?.direction ?? out.trade?.market) !== undefined).toBe(true);
    expect(out.trade?.id).toBe(cryptoId);
    expect(out.trade?.stopLoss).toBe(45); // SHORT: 55→45 tighten hua
  });
  it('bina hint ke legacy behavior intact (pehla OPEN match)', () => {
    openPaperTrade({ symbol: 'XYZ', direction: 'LONG', entry: 100, qty: 1, stopLoss: 90, target1: 110, target2: 120, market: 'INDIA' });
    const out = updatePaperTradeStopLoss('XYZ', 95);
    expect(out.ok).toBe(true);
    expect(out.trade?.stopLoss).toBe(95);
  });
});

// ============================================================
// S20: honest confluence (fabrication sweep) — source lock
// ============================================================
describe('v21.23.12 S20 — tradePlanner honest confluence (?? 5 / ?? 60 fabrication sweep)', () => {
  it('missing leg ab 0 contribute karta hai — fabricated 5/8 kabhi nahi', () => {
    const src = read('server/ai/tradePlanner.js');
    expect(src).not.toContain('aligned8Count ?? 5');
    expect(src).not.toContain('confluencePct ?? 60');
    expect(src).toContain('aligned8Count ?? 0');
    expect(src).toContain('confluencePct ?? 0');
  });
});

// ============================================================
// S21: seat-guard sweep — desc vs asc output equality locks
// ============================================================
import { smcVote } from '../server/ai/lib/smc.js';
import { scoreSwing, detectWhale } from '../server/ai/swing.js';
import { structureStop } from '../server/ai/probrain.js';
import { maCrossFromCandles, structurePro } from '../server/ai/models.js';
import { entryTimingRead } from '../server/ai/entryTiming.js';
import { simulateSymbol } from '../server/ai/backtest.js';

describe('v21.23.12 S21 — seat-guard sweep: mirrored input ab asc-input jaisa hi vote deta hai', () => {
  const rising = risingSeries(120, 900_000);
  const falling = fallingSeries(120, 900_000);

  it('S21a smcVote: desc series ka vote/direction asc ke EQUAL (pehle ulta)', () => {
    const va = smcVote(rising);
    const vd = smcVote(desc(rising));
    expect(vd.dir).toBe(va.dir);
  });
  it('S21b scoreSwing: desc == asc score', () => {
    const a = scoreSwing('BTC', 'CRYPTO', rising);
    const d = scoreSwing('BTC', 'CRYPTO', desc(rising));
    expect(d?.score).toBe(a?.score);
    expect(d?.dir).toBe(a?.dir);
  });
  it('S21c detectWhale: desc == asc verdict', () => {
    const rows = falling.slice();
    rows[rows.length - 1] = { ...rows[rows.length - 1], volume: 5000, close: rows[rows.length - 1].close * 0.99 };
    const a = detectWhale('BTC', 'CRYPTO', rows);
    const d = detectWhale('BTC', 'CRYPTO', desc(rows));
    expect(d?.dir).toBe(a?.dir);
  });
  it('S21d structureStop: desc == asc stop level', () => {
    const a = structureStop({ candles: rising, side: 'LONG', ltp: rising[rising.length - 1].close, atr: 2 });
    const d = structureStop({ candles: desc(rising), side: 'LONG', ltp: rising[rising.length - 1].close, atr: 2 });
    expect(d?.sl).toBe(a?.sl);
  });
  it('S21e maCrossFromCandles: desc == asc cross read', () => {
    const a = maCrossFromCandles(rising);
    const d = maCrossFromCandles(desc(rising));
    expect(d?.main?.sign).toBe(a?.main?.sign);
    expect(d?.main?.bars).toBe(a?.main?.bars);
  });
  it('S21f structurePro: desc == asc vote', () => {
    const mkCtx = (rows) => ({ candles: rows, ind: {} });
    const a = structurePro(mkCtx(rising));
    const d = structurePro(mkCtx(desc(rising)));
    expect(d.dir).toBe(a.dir);
  });
  it('S21g entryTimingRead: desc == asc chase verdict (polarity flip cure)', () => {
    // LONG side, vertical rising run at the END → asc me runBars bade
    const runTail = rising.slice(); // already rising with strong tail
    const p = { side: 'LONG', ltp: runTail[runTail.length - 1].close, ema20: runTail[runTail.length - 1].close * 0.9, atr: 2, rsi: 55, candles: runTail, market: 'CRYPTO' };
    const a = entryTimingRead(p);
    const d = entryTimingRead({ ...p, candles: desc(runTail) });
    expect(d?.runBars).toBe(a?.runBars);
    expect(d?.severity).toBe(a?.severity);
  });
  it('S21h simulateSymbol: desc == asc edge-stats core (trades count parity)', () => {
    const a = simulateSymbol({ symbol: 'BTC', market: 'CRYPTO', candles: rising, minGrade: 'ACTION', maxRiskPct: 5 });
    const d = simulateSymbol({ symbol: 'BTC', market: 'CRYPTO', candles: desc(rising), minGrade: 'ACTION', maxRiskPct: 5 });
    // desc input ab asc-oriented hota hai → edge stats identically derivable
    expect(d).not.toBeNull();
    expect(a).not.toBeNull();
    expect(d!.stats?.trades).toBe(a!.stats?.trades);
  });
});

// ============================================================
// S23: unit-safety + launcher stamps
// ============================================================
describe('v21.23.12 S23 — /api/chart ms-unit + watchdog stamps + NaN-vote filter', () => {
  it('/api/chart Yahoo seconds → ms conversion wired', () => {
    const src = read('server/index.js');
    expect(src).toContain('time: ts[i] * 1000');
  });
  it('watchdog bat teeno stamps current version (REM + title + banner)', () => {
    const bat = read('Start-SmartAI-Watchdog.bat');
    // v21.27.2 honest pin bump: bat ab v21.27.2 stamped hai.
    expect(bat).toContain('v21.29.1');
    expect(bat).not.toContain('v21.23.12');
    expect(bat).not.toContain('v21.23.11');
    expect(bat).not.toContain('v21.23.10');
  });
  it('aggregateVotes NaN-dir vote ab filtered (NaN score disease)', () => {
    const src = read('server/ai/ensemble.js');
    expect(src).toContain("typeof v.dir === 'number' && Number.isFinite(v.dir)");
  });
  it('globalFutures USDC leg canonicalizeCandles use karta hai', () => {
    const src = read('server/ai/globalFutures.js');
    expect(src).toContain("canonicalizeCandles(rows, { label: `glob-usdc:");
  });
});
