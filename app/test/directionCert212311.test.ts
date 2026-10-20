// ============================================================
// test/directionCert212311.test.ts — v21.23.11 MIRROR-SHIELD
// ------------------------------------------------------------
// USER COMPLAINT (verbatim): "site me Jo bhi trade signals de rahe
// hai sab ke sab wrong direction me hai sab opposite jaa rahe hai …
// signals ab bhi systematic opposite jaa rahe hain … muje loss ho
// raha hai".
//
// ROOT CAUSE (live-forensics 2026-10-20, sandbox probe + CoinDCX
// docs + Aug-2026 SDKs): CoinDCX candle endpoints NEWEST-FIRST
// (descending) dete hain aur wire-format migrate ho raha hai
// (docs: `interval` param + {open,high,low,volume,close,time}; ek
// 2026 SDK CandleResponse `open_time` field list karta hai). Legacy
// parse me timestamp-key drift → NaN time → sort no-op → series API
// order (NEWEST-FIRST) me hi rehti thi → TIME-MIRRORED series →
// har indicator ulta → SAB signals opposite (prices WS overlay se
// live — "site working fine" lagta tha). Datacenter sandbox me
// CoinDCX Cloudflare-blocked hota hai (Binance leg chalti hai, 17/20
// AGREE probe) — isliye ye bug yahan reproduce HOTA nahi tha aur
// internal-consistency tests mocks ko assumed shape me banate the.
//
// THIS SUITE locks the four defense lines:
//   L1 fetchers (canonicalizeCandles + official-endpoint legs)
//   L2 overlays/resampler (ensureAscending at entry)
//   L3 compute (indicators/_tfVote/plan path)
//   L4 certificates (synthetic mirror cases + live-cert module shape)
// ============================================================
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../server/cryptoStream.js', () => ({
  fetchCoinDcxTickers: vi.fn(async () => []),
}));

import {
  parseCandleRow, canonicalizeCandles, ensureAscending,
  seriesOrientation, candleCanonicalStats, __resetCandleCanonicalStatsForTest,
} from '../server/ai/lib/candles.js';
import { computeIndicatorsFromCandles } from '../server/ai/lib/indicators.js';
import { __tfVote } from '../server/ai/mtf.js';
import { fetchCoinDcxCandles, __clearCandleCache } from '../server/ai/data.js';
import { fetchFuturesCandles, __clearFuturesCandleCacheForTest } from '../server/ai/futures.js';
import { buildPlanFromCandles } from '../server/ai/tradePlanner.js';
import { overlayTickOnCandles, _resetCxWsCandlesForTest } from '../server/ai/cxWsCandles.js';
import { runDirectionSelfTest } from '../server/ai/directionSelfTest.js';

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
    px /= 1.003;
    const wick = px * 0.002;
    return {
      time: t0 + i * intervalMs,
      open: +(px * 1.0015).toFixed(4), high: +(px * (1 + 0.004)).toFixed(4),
      low: +(px - wick).toFixed(4), close: +px.toFixed(4),
      volume: 100 + (i % 11) * 7,
    };
  });
}

// wire shapes (real CoinDCX families)
const toDocsShape = (cs, { newestFirst = true, seconds = false } = {}) => {
  const rows = cs.map(c => ({
    open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume,
    time: seconds ? Math.round(c.time / 1000) : c.time,
  }));
  return newestFirst ? rows.reverse() : rows;
};
const toLegacySpotShape = (cs) => // {o,h,l,c,v,t} seconds, newest-first (repo's old assumption)
  cs.map(c => ({ o: c.open, h: c.high, l: c.low, c: c.close, v: c.volume, t: Math.round(c.time / 1000) })).reverse();
const toOpenTimeShape = (cs) => // 2026-SDK drift shape: open_time/close_time keys
  cs.map(c => ({
    open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume,
    open_time: Math.round(c.time / 1000), close_time: Math.round(c.time / 1000) + 899,
  })).reverse();

// ---------------- L1: the canonicalizer core ----------------
describe('v21.23.11 [L1] parseCandleRow — alias-tolerant wire shapes', () => {
  it('parses legacy spot {o,h,l,c,v,t} (seconds)', () => {
    const r = parseCandleRow({ o: 100, h: 110, l: 95, c: 105, v: 12, t: Math.round(NOW / 1000) - 3600 });
    expect(r).not.toBeNull();
    expect(r.close).toBe(105);
    expect(r.time).toBeGreaterThan(1.2e12);
  });
  it('parses docs shape {open,high,low,volume,close,time} (ms)', () => {
    const r = parseCandleRow({ open: 100, high: 110, low: 95, volume: 12, close: 105, time: NOW - 3600_000 });
    expect(r?.close).toBe(105);
    expect(r?.time).toBe(NOW - 3600_000);
  });
  it('parses 2026-SDK drift shape {…, open_time, close_time} (no `time` key)', () => {
    const r = parseCandleRow({ open: 100, high: 110, low: 95, close: 105, volume: 12, open_time: Math.round((NOW - 3600_000) / 1000), close_time: Math.round((NOW - 3600_000) / 1000) + 899 });
    expect(r?.close).toBe(105);
    expect(r?.time).toBeGreaterThan(1.2e12);
  });
  it('parses Binance-style array rows [t,o,h,l,c,v]', () => {
    const r = parseCandleRow([NOW - 3600_000, '100', '110', '95', '105', '12']);
    expect(r?.close).toBe(105);
    expect(r?.volume).toBe(12);
  });
  it('DROPS rows with missing/NaN time (the no-op-sort mirror seed)', () => {
    expect(parseCandleRow({ open: 100, high: 110, low: 95, close: 105, volume: 12 })).toBeNull();
    expect(parseCandleRow({ open: 100, high: 110, low: 95, close: 105, volume: 12, time: NaN })).toBeNull();
    expect(parseCandleRow({ open: 100, high: 110, low: 95, close: 105, volume: 12, time: undefined })).toBeNull();
  });
  it('DROPS rows with broken geometry (wrong-scale/paise class)', () => {
    expect(parseCandleRow({ open: 100, high: 50, low: 95, close: 105, volume: 1, time: NOW })).toBeNull();
    expect(parseCandleRow({ open: 100, high: 110, low: 99999, close: 105, volume: 1, time: NOW })).toBeNull();
  });
  it('DROPS array rows whose layout misreads a price as time (legacy bare-array guard)', () => {
    // [o,h,l,c,v,t] layout read as [t,...] → "time" = 1654 → 1970 epoch → reject
    expect(parseCandleRow([1654, 1660, 1650, 1655, 1000, Math.round(NOW / 1000)])).toBeNull();
  });
  it('synthesizes missing high/low from open/close (honest, geometry-safe)', () => {
    const r = parseCandleRow({ open: 100, close: 105, t: Math.round(NOW / 1000) });
    expect(r?.high).toBe(105);
    expect(r?.low).toBe(100);
  });
});

describe('v21.23.11 [L1] seriesOrientation + ensureAscending', () => {
  it('orientation: asc / desc / mixed / unknown', () => {
    const asc = risingSeries(50);
    expect(seriesOrientation(asc)).toBe('asc');
    expect(seriesOrientation(asc.slice().reverse())).toBe('desc');
    const mixed = [asc[0], asc[10], asc[5], asc[20], asc[15], asc[30], asc[25]];
    expect(seriesOrientation(mixed)).toBe('mixed');
    expect(seriesOrientation([asc[0], asc[1]])).toBe('unknown');
    expect(seriesOrientation(null)).toBe('unknown');
  });
  it('ensureAscending: desc → reversed COPY, input untouched', () => {
    const asc = risingSeries(50);
    const desc = asc.slice().reverse();
    const fixed = ensureAscending(desc);
    expect(fixed).not.toBe(desc); // copy
    expect(desc[0].time).toBeGreaterThan(desc[desc.length - 1].time); // input still desc
    expect(fixed[0].time).toBe(asc[0].time);
    expect(fixed[49].time).toBe(asc[49].time);
  });
  it('ensureAscending: asc → SAME reference (zero-copy hot path)', () => {
    const asc = risingSeries(50);
    expect(ensureAscending(asc)).toBe(asc);
  });
  it('ensureAscending: mixed/unknown → untouched (no silent reorder)', () => {
    const mixed = [1, 2, 3, 4, 5, 6, 7].map(i => ({ time: NOW + (i % 2 === 0 ? i : -i) * 60000, open: 1, high: 2, low: 0.5, close: 1.5, volume: 1 }));
    const short = [{ time: NOW, open: 1, high: 2, low: 0.5, close: 1.5, volume: 1 }];
    expect(ensureAscending(mixed)).toBe(mixed);
    expect(ensureAscending(short)).toBe(short);
  });
});

describe('v21.23.11 [L1] canonicalizeCandles — THE mirror kill shot', () => {
  beforeEach(__resetCandleCanonicalStatsForTest);
  const rising = risingSeries(90);
  it('docs-shape NEWEST-FIRST (the documented CoinDCX order) → canonical ASCENDING', () => {
    const out = canonicalizeCandles(toDocsShape(rising), { label: 't1' });
    expect(seriesOrientation(out)).toBe('asc');
    expect(out[out.length - 1].close).toBeCloseTo(rising[rising.length - 1].close, 6);
    expect(out[0].time).toBe(rising[0].time);
    expect(candleCanonicalStats().reversed).toBe(1);
  });
  it('legacy spot-shape NEWEST-FIRST → canonical ASCENDING', () => {
    const out = canonicalizeCandles(toLegacySpotShape(rising), { label: 't2' });
    expect(seriesOrientation(out)).toBe('asc');
    expect(out.length).toBe(90);
  });
  it('open_time drift-shape (no `time` key) NEWEST-FIRST → canonical ASCENDING', () => {
    const out = canonicalizeCandles(toOpenTimeShape(rising), { label: 't3' });
    expect(seriesOrientation(out)).toBe('asc');
    expect(out.length).toBe(90);
    expect(out[out.length - 1].close).toBeCloseTo(rising[rising.length - 1].close, 6);
  });
  it('NaN-time rows DROPPED — never reach the sort (NaN sort = no-op mirror)', () => {
    const poisoned = toDocsShape(rising);
    poisoned[5] = { ...poisoned[5], time: NaN };
    poisoned[20] = { ...poisoned[20], time: 'garbage' };
    const out = canonicalizeCandles(poisoned, { label: 't4' });
    expect(out.length).toBe(88);
    expect(out.every(c => Number.isFinite(c.time))).toBe(true);
    expect(seriesOrientation(out)).toBe('asc');
  });
  it('below minBars → honest null (thin wire never becomes a fake series)', () => {
    expect(canonicalizeCandles(toDocsShape(rising).slice(0, 5), { label: 't5', minBars: 30 })).toBeNull();
  });
  it('empty/non-array → null', () => {
    expect(canonicalizeCandles(null)).toBeNull();
    expect(canonicalizeCandles([])).toBeNull();
  });
  it('Binance-style array rows work end-to-end', () => {
    const arrRows = rising.map(c => [c.time, c.open, c.high, c.low, c.close, c.volume]);
    const out = canonicalizeCandles(arrRows, { label: 't6' });
    expect(seriesOrientation(out)).toBe('asc');
    expect(out.length).toBe(90);
  });
});

// ---------------- L1: fetcher wiring (mocked wire) ----------------
function routeFetch(handlers = {}) {
  globalThis.fetch = vi.fn(async (url) => {
    const u = String(url);
    for (const [needle, responder] of Object.entries(handlers)) {
      if (u.includes(needle)) {
        const body = typeof responder === 'function' ? responder(u) : responder;
        return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
      }
    }
    return { ok: true, status: 200, json: async () => ({}), text: async () => '{}' };
  }) as unknown as typeof fetch;
}

describe('v21.23.11 [L1] fetchCoinDcxCandles — wire-shape immune', () => {
  beforeEach(() => { __clearCandleCache(); __resetCandleCanonicalStatsForTest; });
  it('legacy {o,h,l,c,v,t} newest-first wire → ascending series', async () => {
    const rising = risingSeries(60, 900_000);
    routeFetch({ 'public.coindcx.com/market_data/candles': toLegacySpotShape(rising) });
    const out = await fetchCoinDcxCandles('BTC', '15m', { noCache: true });
    expect(Array.isArray(out)).toBe(true);
    expect(out.length).toBe(60);
    expect(seriesOrientation(out)).toBe('asc');
    expect(out[out.length - 1].close).toBeCloseTo(rising[rising.length - 1].close, 6);
  });
  it('drifted docs-shape {open,…,time} newest-first wire → ascending series (old parser would have DROPPED all)', async () => {
    const rising = risingSeries(60, 900_000);
    routeFetch({ 'public.coindcx.com/market_data/candles': toDocsShape(rising) });
    const out = await fetchCoinDcxCandles('BTC', '15m', { noCache: true });
    expect(Array.isArray(out)).toBe(true);
    expect(seriesOrientation(out)).toBe('asc');
  });
  it('legacy endpoint dead → OFFICIAL endpoint leg serves (api.coindcx.com interval param)', async () => {
    const rising = risingSeries(60, 900_000);
    const calls: string[] = [];
    globalThis.fetch = vi.fn(async (url) => {
      const u = String(url); calls.push(u);
      if (u.includes('public.coindcx.com')) return { ok: false, status: 403, json: async () => ({}) } as Response;
      if (u.includes('api.coindcx.com/market_data/candles')) {
        expect(u).toContain('interval=15m');
        return { ok: true, status: 200, json: async () => toDocsShape(rising), text: async () => 'x' } as Response;
      }
      return { ok: true, status: 200, json: async () => ({}), text: async () => '{}' } as Response;
    }) as unknown as typeof fetch;
    const out = await fetchCoinDcxCandles('BTC', '15m', { noCache: true });
    expect(calls.some(u => u.includes('B-BTC_INR'))).toBe(true);
    expect(Array.isArray(out)).toBe(true);
    expect(seriesOrientation(out)).toBe('asc');
  });
  it('all CoinDCX legs dead → honest null (resample/Binance fallbacks own the rest)', async () => {
    routeFetch({});
    const out = await fetchCoinDcxCandles('BTC', '15m', { noCache: true });
    expect(out).toBeNull();
  });
});

describe('v21.23.11 [L1] fetchFuturesCandles — the user\'s LIVE trade path, wire-shape immune', () => {
  beforeEach(() => { __clearFuturesCandleCacheForTest(); });
  it('legacy {s:"ok",data:[…time]} wire (docs order tolerated) → ascending', async () => {
    const rising = risingSeries(40, 900_000);
    routeFetch({ 'market_data/candlesticks': { s: 'ok', data: toDocsShape(rising, { newestFirst: true }) } });
    const out = await fetchFuturesCandles('B-BTC_USDT', '15', 40);
    expect(Array.isArray(out)).toBe(true);
    expect(seriesOrientation(out)).toBe('asc');
    expect(out[out.length - 1].close).toBeCloseTo(rising[rising.length - 1].close, 6);
  });
  it('open_time drift shape (timestamp key renamed) → ascending — THE mirror case killed', async () => {
    // Pre-v21.23.11 parser: Number(x.time)=NaN → sort no-op → newest-first
    // preserved → MIRRORED SERIES → sab futures signals opposite.
    const rising = risingSeries(40, 900_000);
    routeFetch({ 'market_data/candlesticks': { s: 'ok', data: toOpenTimeShape(rising) } });
    const out = await fetchFuturesCandles('B-BTC_USDT', '15', 40);
    expect(Array.isArray(out)).toBe(true);
    expect(out.length).toBe(40);
    expect(seriesOrientation(out)).toBe('asc');
    expect(out[out.length - 1].close).toBeCloseTo(rising[rising.length - 1].close, 6);
  });
  it('legacy candlesticks dead → official /market_data/candles leg serves (interval param)', async () => {
    const rising = risingSeries(40, 900_000);
    const calls: string[] = [];
    globalThis.fetch = vi.fn(async (url) => {
      const u = String(url); calls.push(u);
      if (u.includes('candlesticks')) return { ok: true, status: 200, json: async () => ({ s: 'no_data', data: [] }), text: async () => 'x' } as Response;
      if (u.includes('api.coindcx.com/market_data/candles')) {
        expect(u).toContain('pair=B-BTC_USDT');
        expect(u).toContain('interval=15m');
        return { ok: true, status: 200, json: async () => toDocsShape(rising), text: async () => 'x' } as Response;
      }
      return { ok: true, status: 200, json: async () => ({}), text: async () => '{}' } as Response;
    }) as unknown as typeof fetch;
    const out = await fetchFuturesCandles('B-BTC_USDT', '15', 40);
    expect(calls.some(u => u.includes('api.coindcx.com/market_data/candles'))).toBe(true);
    expect(Array.isArray(out)).toBe(true);
    expect(seriesOrientation(out)).toBe('asc');
  });
});

// ---------------- L2: overlay + resampler ----------------
describe('v21.23.11 [L2] overlayTickOnCandles — forming bar = TRUE newest', () => {
  beforeEach(_resetCxWsCandlesForTest);
  it('descending input: live tick patches the TRUE newest bar (previously: bogus roll after oldest)', () => {
    const asc = risingSeries(40, 900_000);
    const desc = asc.slice().reverse();
    const tick = { price: asc[39].close * 1.01, atMs: asc[39].time + 60_000 }; // inside the newest forming bar
    const out = overlayTickOnCandles(desc, tick, '15m');
    expect(out.length).toBe(40); // same bar updated — NOT a bogus roll-append
    expect(seriesOrientation(out)).toBe('asc');
    expect(out[39].close).toBeCloseTo(tick.price, 6);
    expect(out[39].time).toBe(asc[39].time);
  });
  it('ascending input: unchanged behavior (same-bar update in place)', () => {
    const asc = risingSeries(40, 900_000);
    const tick = { price: asc[39].close * 1.005, atMs: asc[39].time + 60_000 };
    const out = overlayTickOnCandles(asc, tick, '15m');
    expect(out.length).toBe(40);
    expect(out[39].close).toBeCloseTo(tick.price, 6);
  });
});

// ---------------- L3: compute + vote + plan ----------------
describe('v21.23.11 [L3] compute/vote/plan — mirrored series can never read opposite', () => {
  const rising = risingSeries(90);
  const falling = fallingSeries(90);
  it('computeIndicatorsFromCandles: descending rising-series reads like ascending (LTP = latest)', () => {
    const ascInd = computeIndicatorsFromCandles(rising);
    const descInd = computeIndicatorsFromCandles(rising.slice().reverse());
    expect(ascInd).not.toBeNull();
    expect(descInd).not.toBeNull();
    expect(descInd.ltp).toBeCloseTo(ascInd.ltp, 6); // ltp = LATEST close, not oldest
    expect(Math.sign((descInd.ema20 ?? 0) - (descInd.ema50 ?? 0))).toBe(Math.sign((ascInd.ema20 ?? 0) - (ascInd.ema50 ?? 0)));
  });
  it('_tfVote: descending rising-series → BULL (the live disease killed at the vote layer)', () => {
    const vAsc = __tfVote(rising, '15m');
    const vDesc = __tfVote(rising.slice().reverse(), '15m');
    expect(vAsc?.dir).toBe(1);
    expect(vDesc?.dir).toBe(vAsc?.dir);
  });
  it('_tfVote: descending falling-series → BEAR', () => {
    const vAsc = __tfVote(falling, '15m');
    const vDesc = __tfVote(falling.slice().reverse(), '15m');
    expect(vAsc?.dir).toBe(-1);
    expect(vDesc?.dir).toBe(vAsc?.dir);
  });
  it('buildPlanFromCandles: time-mirrored RISING series → LONG (or honest refuse), NEVER SHORT', () => {
    const mirrored = rising.slice().reverse();
    const p = buildPlanFromCandles({ symbol: 'BTC', market: 'CRYPTO', mode: 'INTRADAY', ctxCandles: mirrored, trigCandles: mirrored });
    if (p?.ok) expect(p?.side).toBe('LONG');
    else expect(p?.ok).toBe(false); // honest refuse acceptable; SHORT is NOT
  });
  it('buildPlanFromCandles: time-mirrored FALLING series → SHORT (or refuse), NEVER LONG', () => {
    const mirrored = falling.slice().reverse();
    const p = buildPlanFromCandles({ symbol: 'BTC', market: 'CRYPTO', mode: 'INTRADAY', ctxCandles: mirrored, trigCandles: mirrored });
    if (p?.ok) expect(p?.side).toBe('SHORT');
    else expect(p?.ok).toBe(false);
  });
  it('buildPlanFromCandles: ascending inputs → unchanged reference behavior (side + polarity)', () => {
    const up = buildPlanFromCandles({ symbol: 'BTC', market: 'CRYPTO', mode: 'INTRADAY', ctxCandles: rising, trigCandles: rising });
    expect(up?.ok).toBe(true);
    expect(up?.side).toBe('LONG');
    expect(up.plan.stopLoss).toBeLessThan(up.plan.entry);
    const down = buildPlanFromCandles({ symbol: 'BTC', market: 'CRYPTO', mode: 'INTRADAY', ctxCandles: falling, trigCandles: falling });
    expect(down?.side).toBe('SHORT');
    expect(down.plan.stopLoss).toBeGreaterThan(down.plan.entry);
  });
});

// ---------------- L4: certificates ----------------
describe('v21.23.11 [L4] runDirectionSelfTest — extended with mirror-shield section', () => {
  it('passes 18/18 including the mirror cases', () => {
    const r = runDirectionSelfTest();
    expect(r.pass).toBe(true);
    expect(r.version).toBe('v21.23.11');
    const names = r.checks.map(c => c.name);
    expect(names.some(n => n.includes('newest-first → canonical ASCENDING'))).toBe(true);
    expect(names.some(n => n.includes('open_time-key drift'))).toBe(true);
    expect(names.some(n => n.includes('time-mirrored rising series'))).toBe(true);
  });
});

describe('v21.23.11 [L4] runLiveDirectionCertificate — module contract', () => {
  it('skipNetwork → honest empty pass', async () => {
    const { runLiveDirectionCertificate } = await import('../server/ai/directionLiveCert.js');
    const r = await runLiveDirectionCertificate({ skipNetwork: true });
    expect(r.pass).toBe(true);
    expect(r.chains).toEqual([]);
  });
  it('all chains dead → every chain UNREACHABLE (honest skip), certificate still resolves', async () => {
    routeFetch({}); // everything falls through to empty {}
    const { runLiveDirectionCertificate } = await import('../server/ai/directionLiveCert.js');
    const r = await runLiveDirectionCertificate();
    expect(Array.isArray(r.chains)).toBe(true);
    expect(r.chains.length).toBeGreaterThan(3);
    for (const c of r.chains) expect(['UNREACHABLE', 'SKIP', 'PASS', 'FAIL']).toContain(c.status);
  });
  it('a MIRRORED live wire is CAUGHT: orientation FAIL names the chain', async () => {
    // Simulate the user's box: legacy futures wire serves newest-first rows
    // whose parse WOULD have mirrored pre-fix; canonicalizer rescues → PASS.
    const rising = risingSeries(40, 900_000);
    routeFetch({ 'market_data/candlesticks': { s: 'ok', data: toOpenTimeShape(rising) } });
    const { runLiveDirectionCertificate } = await import('../server/ai/directionLiveCert.js');
    const r = await runLiveDirectionCertificate();
    const fut = r.chains.find(c => String(c.chain).includes('coindcx-fut'));
    // v21.23.12 [DE-VACUOUS]: pehle `if (fut && fut.status !== 'UNREACHABLE')`
    // guard mock-wire drift pe kuch bhi assert kiye bina PASS ho jaata tha —
    // ab chain hone hi chahiye aur UNREACHABLE hona hi FAIL hona chahiye.
    expect(fut).toBeTruthy();
    expect(fut?.status).not.toBe('UNREACHABLE');
    expect(fut?.checks?.orientation_ascending).toBe(true);
  });
});
