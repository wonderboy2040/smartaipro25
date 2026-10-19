// ============================================================
// test/cxWsCandles.test.ts — v21.23.5 COINDCX ULTRAFAST WS LIVE-CANDLE OVERLAY
// ------------------------------------------------------------
// USER REQUEST (verbatim): "ye Yahoo 15m विशेष रूप से — D1 isko direct
// CoinDCX Ultrafast websockets se replace nhi kar sakte kya — kardo
// accurately."
//
// THE ACCURATE IMPLEMENTATION UNDER TEST (live-probe-verified in
// cxWsCandles.js header: CoinDCX PUBLIC sockets push ONLY ultrafast
// price books — candlestick channels carry ZERO events on BOTH
// documented endpoints): the REST chain (Yahoo .NS / CoinDCX spot /
// CoinDCX futures) stays the SERIES ANCHOR; the Ultrafast WS books
// overlay ONLY the LIVE FORMING BAR. Ye suite 3 contracts lock karti hai:
//   1. PURE CORE — same-bar update / roll-APPENDS / pre-history /
//      ±35% sanity / non-mutation (the shared REST cache slice that
//      data.js serves is NEVER mutated — cache poisoning lock)
//   2. ENABLE MATRIX — vitest me overlay default-OFF → byte-identical
//      pass-through (the v10.11 zero-regression contract) + opt-in
//      domain-matched tick routing (an India tick can NEVER overlay a
//      crypto series — cross-domain lock)
//   3. WIRING PINS — mtf.js 5 sites + ultrafastVerifier.js 2 REST
//      branches + the India CACHE-SAFETY ORDER (overlay per-READ,
//      kabhi shared cache me bake nahi) + Binance fallback legs
//      UN-overlaid (cross-domain by design)
// ============================================================
import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  overlayTickOnCandles,
  cxSpotOverlayCandles,
  cxFutOverlayCandles,
  indiaOverlayCandles,
  cxWsCandlesStatus,
  TF_MS,
  _setCxWsCandlesEnabledForTest,
  _setCxWsCandlesNowForTest,
  _setCxWsTickFnsForTest,
  _resetCxWsCandlesForTest,
} from '../server/ai/cxWsCandles.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.join(__dirname, '..');
const MTF_SRC = readFileSync(path.join(APP_ROOT, 'server', 'ai', 'mtf.js'), 'utf8');
const UCV_SRC = readFileSync(path.join(APP_ROOT, 'server', 'ai', 'ultrafastVerifier.js'), 'utf8');

// ---- fixture: a 40-bar ascending 15m grid (identical OHLC is fine —
// the pure core only inspects the tail; indicators are NOT computed here)
const T0 = 1_700_000_000_000;
function mkCandles(n = 40) {
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push({
      time: T0 + i * TF_MS['15m'],
      open: 100, high: 105, low: 99, close: 101, volume: 50,
    });
  }
  return out;
}
const lastBar = (c) => c[c.length - 1];

// ============================================================
// 1. PURE CORE
// ============================================================
describe('v21.23.5 overlayTickOnCandles — pure core', () => {
  beforeEach(() => _resetCxWsCandlesForTest());

  it('same-bar tick: close tracks the print, high/low extend, open/time/volume intact', () => {
    const in_ = mkCandles();
    const lastTime = lastBar(in_).time;
    const out = overlayTickOnCandles(in_, { price: 102, atMs: lastTime + 5 * 60_000 }, '15m');
    expect(out).not.toBe(in_);            // NEW array — input untouched
    expect(out.length).toBe(in_.length);  // same bar — no growth
    expect(lastBar(out).close).toBe(102);
    expect(lastBar(out).high).toBe(105);  // max(105, 102) — no shrink
    expect(lastBar(out).low).toBe(99);
    expect(lastBar(out).open).toBe(100);
    expect(lastBar(out).time).toBe(lastTime);
    expect(lastBar(out).volume).toBe(50);
  });

  it('high extends above, low dips below — the bar tracks BOTH extremes', () => {
    const in_ = mkCandles();
    const lastTime = lastBar(in_).time;
    const up = overlayTickOnCandles(in_, { price: 110, atMs: lastTime + 60_000 }, '15m');
    expect(lastBar(up).high).toBe(110);
    const dn = overlayTickOnCandles(in_, { price: 95.5, atMs: lastTime + 60_000 }, '15m');
    expect(lastBar(dn).low).toBe(95.5);
  });

  it('roll APPENDS the live bar (the documented contract) — anchor bar RETAINED byte-identical', () => {
    const in_ = mkCandles();
    const lastTime = lastBar(in_).time;
    const out = overlayTickOnCandles(in_, { price: 103, atMs: lastTime + TF_MS['15m'] + 60_000 }, '15m');
    expect(out.length).toBe(in_.length + 1);              // APPEND, not replace
    const anchor = out[out.length - 2];                   // the stale forming bar keeps its place…
    expect(anchor.time).toBe(lastTime);
    expect(anchor.close).toBe(101);
    expect(anchor.volume).toBe(50);
    const live = lastBar(out);                            // …and the print OPENS the next slot
    expect(live.time).toBe(lastTime + TF_MS['15m']);      // contiguous REST grid — no gap
    expect(live.open).toBe(103);
    expect(live.high).toBe(103);
    expect(live.low).toBe(103);
    expect(live.close).toBe(103);
    expect(live.volume).toBe(0);                           // REST anchor self-heals volume
  });

  it('after a roll, the next tick in the new window UPDATES the rolled bar (no double-append)', () => {
    const in_ = mkCandles();
    const lastTime = lastBar(in_).time;
    const rolled = overlayTickOnCandles(in_, { price: 103, atMs: lastTime + TF_MS['15m'] + 60_000 }, '15m');
    const out = overlayTickOnCandles(rolled, { price: 104, atMs: lastTime + TF_MS['15m'] + 2 * 60_000 }, '15m');
    expect(out.length).toBe(rolled.length);               // still 41
    expect(lastBar(out).close).toBe(104);
    expect(lastBar(out).high).toBe(104);
    expect(lastBar(out).time).toBe(lastTime + TF_MS['15m']);
  });

  it('pre-history print (tick older than the last bar) is IGNORED — same reference', () => {
    const in_ = mkCandles();
    const out = overlayTickOnCandles(in_, { price: 102, atMs: lastBar(in_).time - 1 }, '15m');
    expect(out).toBe(in_);
  });

  it('±35% sanity gate: a wrong-scale tick (INR-on-USDT / paise class) is IGNORED', () => {
    const in_ = mkCandles();
    const lastTime = lastBar(in_).time;
    expect(overlayTickOnCandles(in_, { price: 101 * 1.5, atMs: lastTime + 60_000 }, '15m')).toBe(in_);
    expect(overlayTickOnCandles(in_, { price: 101 * 0.5, atMs: lastTime + 60_000 }, '15m')).toBe(in_);
    // 30% off survives (crypto vol within one bar is legit); 40% never
    const edge = overlayTickOnCandles(in_, { price: 101 * 1.3, atMs: lastTime + 60_000 }, '15m');
    expect(lastBar(edge).close).toBeCloseTo(131.3, 6);
  });

  it('degenerate inputs pass through byte-identical / null — never throws', () => {
    expect(overlayTickOnCandles(null, { price: 102, atMs: T0 }, '15m')).toBeNull();
    const one = [mkCandles(2)[0]];
    expect(overlayTickOnCandles(one, { price: 102, atMs: T0 }, '15m')).toBe(one);          // <2 bars
    const in_ = mkCandles();
    const lastTime = lastBar(in_).time;
    expect(overlayTickOnCandles(in_, { price: 0, atMs: lastTime }, '15m')).toBe(in_);       // bad price
    expect(overlayTickOnCandles(in_, { price: NaN, atMs: lastTime }, '15m')).toBe(in_);
    expect(overlayTickOnCandles(in_, { price: 102 }, '15m')).toBe(in_);                     // no atMs
    expect(overlayTickOnCandles(in_, { price: 102, atMs: lastTime }, '7m')).toBe(in_);      // tf off the ladder
  });

  it('the INPUT array is never mutated (shared REST cache slice stays clean)', () => {
    const in_ = mkCandles();
    const snapshot = JSON.stringify(in_);
    overlayTickOnCandles(in_, { price: 110, atMs: lastBar(in_).time + 60_000 }, '15m');
    overlayTickOnCandles(in_, { price: 130, atMs: lastBar(in_).time + TF_MS['15m'] + 60_000 }, '15m');
    expect(JSON.stringify(in_)).toBe(snapshot);
  });

  it('telemetry counters: applied/updated/rolled/skippedStale/skippedSanity', () => {
    const in_ = mkCandles();
    const lastTime = lastBar(in_).time;
    const t1 = { applied: 0, updated: 0, rolled: 0, skippedStale: 0, skippedSanity: 0 };
    overlayTickOnCandles(in_, { price: 102, atMs: lastTime + 60_000 }, '15m', t1);
    expect(t1.applied).toBe(1);
    expect(t1.updated).toBe(1);
    expect(t1.rolled).toBe(0);
    const t2 = { applied: 0, updated: 0, rolled: 0, skippedStale: 0, skippedSanity: 0 };
    overlayTickOnCandles(in_, { price: 103, atMs: lastTime + TF_MS['15m'] + 60_000 }, '15m', t2);
    expect(t2.rolled).toBe(1);
    const t3 = { applied: 0, updated: 0, rolled: 0, skippedStale: 0, skippedSanity: 0 };
    overlayTickOnCandles(in_, { price: 102, atMs: lastTime - 1 }, '15m', t3);
    expect(t3.skippedStale).toBe(1);
    const t4 = { applied: 0, updated: 0, rolled: 0, skippedStale: 0, skippedSanity: 0 };
    overlayTickOnCandles(in_, { price: 999, atMs: lastTime + 60_000 }, '15m', t4);
    expect(t4.skippedSanity).toBe(1);
  });
});

// ============================================================
// 2. ENABLE MATRIX + DOMAIN-MATCHED ROUTING
// ============================================================
describe('v21.23.5 wrappers — enable matrix + domain-matched ticks', () => {
  beforeEach(() => _resetCxWsCandlesForTest());

  it('hermetic by construction: under vitest (NODE_ENV=test) the overlay defaults OFF — zero-regression contract', () => {
    expect(process.env.NODE_ENV).toBe('test');
    expect(cxWsCandlesStatus().enabled).toBe(false);
  });

  it('disabled → byte-identical pass-through EVEN with a live tick available (skippedDisabled)', () => {
    const in_ = mkCandles();
    _setCxWsCandlesNowForTest(() => lastBar(in_).time + 60_000);
    _setCxWsTickFnsForTest({ spotInr: () => ({ price: 102, atMs: lastBar(in_).time + 60_000 }) });
    const out = cxSpotOverlayCandles('BTC', '15m', in_);
    expect(out).toBe(in_); // SAME reference
    expect(cxWsCandlesStatus().liveBar.skippedDisabled).toBe(1);
  });

  it('enabled + NO fresh book tick → byte-identical (data-missing ≠ fabricate)', () => {
    const in_ = mkCandles();
    _setCxWsCandlesEnabledForTest(true);
    _setCxWsTickFnsForTest({ spotInr: () => null });
    const out = cxSpotOverlayCandles('BTC', '15m', in_);
    expect(out).toBe(in_);
    expect(cxWsCandlesStatus().liveBar.skippedNoTick).toBe(1);
  });

  it('enabled + spot WS INR tick → the forming bar tracks the ultrafast print (key spot-inr:BTC:15m)', () => {
    const in_ = mkCandles();
    const now = lastBar(in_).time + 60_000;
    _setCxWsCandlesEnabledForTest(true);
    _setCxWsCandlesNowForTest(() => now);
    _setCxWsTickFnsForTest({ spotInr: (b) => b === 'BTC' ? { price: 102, atMs: now } : null });
    const out = cxSpotOverlayCandles('BTC', '15m', in_);
    expect(lastBar(out).close).toBe(102);
    const st = cxWsCandlesStatus();
    expect(st.liveBar.applied).toBe(1);
    expect(st.liveBar.lastKey).toBe('spot-inr:BTC:15m');
    expect(st.liveBar.lastTickPrice).toBe(102);
  });

  it('FUT_/GLOB_ base strip: the futures-prefixed symbol still overlays its SPOT INR row', () => {
    const in_ = mkCandles();
    const now = lastBar(in_).time + 60_000;
    const seen = [];
    _setCxWsCandlesEnabledForTest(true);
    _setCxWsCandlesNowForTest(() => now);
    _setCxWsTickFnsForTest({ spotInr: (b) => { seen.push(b); return { price: 102, atMs: now }; } });
    const out = cxSpotOverlayCandles('FUT_BTC', '15m', in_);
    expect(seen).toEqual(['BTC']); // prefix stripped before the book lookup
    expect(lastBar(out).close).toBe(102);
  });

  it('futures USDT-perp tick routes to the futures key — never the spot book', () => {
    const in_ = mkCandles();
    const now = lastBar(in_).time + 60_000;
    _setCxWsCandlesEnabledForTest(true);
    _setCxWsCandlesNowForTest(() => now);
    _setCxWsTickFnsForTest({
      fut: (b) => b === 'BTC' ? { price: 101.8, atMs: now } : null, // in-domain for the 101-close fixture
      spotInr: () => { throw new Error('cross-domain leak — futures path must not read the spot book'); },
    });
    const out = cxFutOverlayCandles('BTC', '15m', in_);
    expect(lastBar(out).close).toBe(101.8);
    expect(cxWsCandlesStatus().liveBar.lastKey).toBe('fut-usdt:BTC:15m');
  });

  it('India Groww liveFeed tick overlays the .NS series (key india:RELIANCE:15m) — the Yahoo-15m live upgrade', () => {
    const in_ = mkCandles();
    const now = lastBar(in_).time + 60_000;
    _setCxWsCandlesEnabledForTest(true);
    _setCxWsCandlesNowForTest(() => now);
    _setCxWsTickFnsForTest({ india: (s) => s === 'RELIANCE' ? { price: 102.5, atMs: now } : null });
    const out = indiaOverlayCandles('RELIANCE', '15m', in_);
    expect(lastBar(out).close).toBe(102.5);
    expect(cxWsCandlesStatus().liveBar.lastKey).toBe('india:RELIANCE:15m');
    expect(cxWsCandlesStatus().liveBar.applied).toBe(1);
  });

  it('GLOB_ indices strip before the liveFeed lookup (GLOBALFUTURES rows ride the India path)', () => {
    const in_ = mkCandles();
    const now = lastBar(in_).time + 60_000;
    const seen = [];
    _setCxWsCandlesEnabledForTest(true);
    _setCxWsCandlesNowForTest(() => now);
    _setCxWsTickFnsForTest({ india: (s) => { seen.push(s); return { price: 101.5, atMs: now }; } });
    const out = indiaOverlayCandles('GLOB_NIFTY', '15m', in_);
    expect(seen).toEqual(['NIFTY']);
    expect(lastBar(out).close).toBe(101.5);
  });

  it('CROSS-DOMAIN lock: an India-only tick can NEVER overlay a crypto series (and vice versa)', () => {
    const in_ = mkCandles();
    const now = lastBar(in_).time + 60_000;
    _setCxWsCandlesEnabledForTest(true);
    _setCxWsCandlesNowForTest(() => now);
    _setCxWsTickFnsForTest({
      india: () => ({ price: 2_400, atMs: now }), // only the India book is alive
    });
    // spot/fut getters fall back to the real (hermetic, empty) books → null
    expect(cxSpotOverlayCandles('BTC', '15m', in_)).toBe(in_);
    expect(cxFutOverlayCandles('BTC', '15m', in_)).toBe(in_);
    const out = indiaOverlayCandles('RELIANCE', '15m', in_);
    expect(lastBar(out).close).toBe(101); // 2400 fails sanity → untouched
    // and a spot-only tick never touches the India series:
    _setCxWsTickFnsForTest({ spotInr: () => ({ price: 102, atMs: now }) });
    expect(indiaOverlayCandles('RELIANCE', '15m', in_)).toBe(in_);
  });

  it('status payload: books health flags + sanityPct pin', () => {
    const st = cxWsCandlesStatus();
    expect(typeof st.books.spotFresh).toBe('boolean');
    expect(typeof st.books.futFresh).toBe('boolean');
    expect(st.sanityPct).toBe(0.35);
    expect(Number.isFinite(st.asOf)).toBe(true);
  });
});

// ============================================================
// 3. WIRING PINS (source contracts — the repo's pin-test discipline)
// ============================================================
describe('v21.23.5 wiring pins — mtf.js + ultrafastVerifier.js', () => {
  it('mtf.js imports all three overlays from cxWsCandles.js', () => {
    expect(MTF_SRC).toContain("from './cxWsCandles.js'");
    expect(MTF_SRC).toContain('cxSpotOverlayCandles');
    expect(MTF_SRC).toContain('cxFutOverlayCandles');
    expect(MTF_SRC).toContain('indiaOverlayCandles');
  });

  it('India cache-hit path applies the overlay PER-READ (hit.payload — never a baked cache)', () => {
    expect(MTF_SRC).toContain('indiaOverlayCandles(symbol, tf, hit.payload)');
  });

  it('CACHE-SAFETY ORDER: _yfCache.set stores the RAW series BEFORE the overlay return', () => {
    const setAt = MTF_SRC.indexOf('_yfCache.set');
    const overlayAt = MTF_SRC.indexOf('return indiaOverlayCandles(symbol, tf, out)');
    expect(setAt).toBeGreaterThan(-1);
    expect(overlayAt).toBeGreaterThan(-1);
    expect(setAt).toBeLessThan(overlayAt);
  });

  it('mtf.js CRYPTO branch: CoinDCX spot REST candles get the WS INR overlay', () => {
    expect(MTF_SRC).toContain('return cxSpotOverlayCandles(base, tf, c)');
  });

  it('mtf.js USDT legs: futures Leg-1 + spot Leg-3 (BEFORE the ÷fx scaling) both overlaid', () => {
    expect(MTF_SRC).toContain('candles: cxFutOverlayCandles(base, tf, fc)');
    expect(MTF_SRC).toContain('cxSpotOverlayCandles(base, tf, cdc).map('); // overlay in INR domain, THEN scale
  });

  it('Binance fallback legs stay UN-overlaid (cross-domain by design) — exact occurrence counts', () => {
    expect((MTF_SRC.match(/cxSpotOverlayCandles\(/g) || []).length).toBe(2); // CRYPTO branch + Leg-3 only
    expect((MTF_SRC.match(/cxFutOverlayCandles\(/g) || []).length).toBe(1);  // Leg-1 only
    expect((MTF_SRC.match(/indiaOverlayCandles\(/g) || []).length).toBe(2);  // cache-hit + fresh path
    expect(MTF_SRC).not.toContain('cxSpotOverlayCandles(base, tf, await');  // Binance leg unwrapped
  });

  it('ultrafastVerifier.js: BOTH REST candle branches overlaid, Binance fallbacks unwrapped', () => {
    expect(UCV_SRC).toContain("import { cxFutOverlayCandles, cxSpotOverlayCandles } from './cxWsCandles.js'");
    expect(UCV_SRC).toContain('return cxFutOverlayCandles(base, tf, a)');   // FUTURES branch
    expect(UCV_SRC).toContain('return cxSpotOverlayCandles(base, tf, a)'); // CRYPTO branch
    expect((UCV_SRC.match(/cxFutOverlayCandles\(/g) || []).length).toBe(1);
    expect((UCV_SRC.match(/cxSpotOverlayCandles\(/g) || []).length).toBe(1);
    expect(UCV_SRC).not.toContain('OverlayCandles(base, tf, await');        // Binance legs unwrapped
  });

  it('TF_MS covers the full 15m — D1 ladder + the verifier 1m/5m legs', () => {
    expect(TF_MS).toEqual({
      '1m': 60_000, '5m': 300_000, '15m': 900_000,
      '1h': 3_600_000, '4h': 14_400_000, '1d': 86_400_000,
    });
  });
});
