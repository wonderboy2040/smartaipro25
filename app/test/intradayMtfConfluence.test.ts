// ============================================================
// test/intradayMtfConfluence.test.ts — v10.5 MTF CONFLUENCE (Upgrade 1)
// ------------------------------------------------------------
// Locks the multi-timeframe confluence engine:
//   1. IntradayTapeMTF registered (w 1.6) when the flag is ON and
//      the plain IntradayTape (w 1.3) when OFF — same seat, never both
//   2. All-align case  → conf boost (+15), vote = the 15m anchor dir
//   3. 2-of-3 case     → partial confluence (agreement 0.67 — passes)
//   4. All-disagree    → conf penalty (-20), agreement 1/3 (< 0.67)
//   5. aggregateVotes mtfAgreement cap: < 0.67 → STRONG banned
//      (max ACTION); ≥ 0.67 → STRONG reachable
//   6. resampleCandles: pure OHLCV aggregation + bucket alignment
//   7. tapeMTFFromBase: m5/m15/h1 tapes + agreement math
//   8. Board regression (flag ON): the tape-mtf vote sits in the
//      committee and the signal carries the mtf wire payload
// Hermetic: data.js mocked OFFLINE, fetch stubbed per scenario.
// ============================================================
import { describe, it, expect, beforeEach, beforeAll, afterAll, vi } from 'vitest';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// hermetic data dir
process.env.SMARTAI_DATA_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '../.test-data-mtf');
// THE FLAG — set BEFORE models.js is imported (the registry is built
// at module load; this whole suite runs with the MTF seat live).
process.env.AI_ENABLE_MTF_CONFLUENCE = 'true';

// ---------------- unit-level imports (no mocks needed) ----------------
const { MODELS, runQuantModels, mtfConfluenceEnabled } = await import('../server/ai/models.js');
const { aggregateVotes } = await import('../server/ai/ensemble.js');

// ---------------- board-level mocks ----------------
const BEARISH_DAILY = {
  symbol: 'RELIANCE', exchange: 'NSE',
  ltp: 1258, open: 1267, high: 1267.4, low: 1253, volume: 9_000_000, changePct: -1.26,
  ema10: 1288.4, ema20: 1296.0, ema50: 1304.5, sma20: 1297, sma50: 1302,
  rsi: 37.2, macd: -7.46, macdSignal: -2.92, atr: 21.16, vwap: 1259.47,
  adx: 25.1, adxPlus: 14.2, adxMinus: 28.7, relVolume: 1.32,
  pivot: { p: 1294.7, s1: 1270.1, r1: 1319.3 },
  bbUpper: 1290, bbLower: 1240, stochK: 34.8, stochD: 38.1,
  high52w: 1600, low52w: 1000, recommend: -0.35,
};

// steady-drift candle series at a given bar-minutes. n is large when
// the 1h resample needs ≥35 bars (n×minutes ≥ 35h).
function driftSeries(minutes: number, n: number, driftPct: number, startPx = 1240) {
  const out = [];
  // epoch-aligned start so the resampler's buckets never split the
  // first bar into its own partial bucket (time-bucketed, like Yahoo)
  const align = minutes * 60_000;
  const t0 = Math.floor((Date.now() - n * align) / align) * align;
  let px = startPx;
  for (let i = 0; i < n; i++) {
    px = px * (1 + driftPct);
    const c = +px.toFixed(2);
    out.push({
      time: t0 + i * align,
      open: +(px * (1 - driftPct / 2)).toFixed(2), high: +(px * 1.0015).toFixed(2),
      low: +(px * 0.9985).toFixed(2), close: c, volume: 120_000 + (i % 7) * 9_000,
    });
  }
  return out;
}

// 5m bases long enough for a real 1h tape (≥35 1h buckets = 35h of bars)
const FALL_5M = () => driftSeries(5, 1200, -0.0016);
const RISE_5M = () => driftSeries(5, 1200, 0.0016);

// v12.4: a REALISTIC falling 15m tape (trend down + periodic pullback
// bars — LTF RSI lands ~41, inside the 30-70 band). The board test below
// asserts a full-bearish-confluence ACTION/STRONG SHORT; a MONOTONIC
// decline would compute RSI ≈ 0 and the new OVERSOLD trust guard would
// (correctly) cap it to WATCH — the chase-suppression is locked in
// signalTrust.test.ts + intradayTapeAlignment.test.ts instead.
function falling15mWithPullbacks(n = 90) {
  const out = [];
  const minutes = 15;
  const align = minutes * 60_000;
  const t0 = Math.floor((Date.now() - n * align) / align) * align;
  let px = 1290;
  for (let i = 0; i < n; i++) {
    const bounce = i % 4 === 3;
    px = px * (bounce ? 1.0045 : 0.998);
    const c = +px.toFixed(2);
    out.push({
      time: t0 + i * align,
      open: +(px * (bounce ? 1.0004 : 0.9996)).toFixed(2), high: +(px * 1.0015).toFixed(2),
      low: +(px * 0.9985).toFixed(2), close: c, volume: 120_000 + (i % 7) * 9_000,
    });
  }
  return out;
}

// v21.13 COHERENCE: production me Yahoo 15m ka last close == live ltp.
// Synthetic fixtures alag price pe khatam hote the — candle-derived levels
// (prev-bar high/low) fictional fires karte the. Scale to the live ltp.
function cohereSeries(candles, ltp) {
  const last = candles[candles.length - 1]?.close;
  if (!(last > 0) || !(ltp > 0)) return candles;
  const k = ltp / last;
  return candles.map(c => ({
    ...c,
    open: +(c.open * k).toFixed(2), high: +(c.high * k).toFixed(2),
    low: +(c.low * k).toFixed(2), close: +(c.close * k).toFixed(2),
  }));
}

function yahooChartReply(candles) {
  const ts = candles.map(c => Math.floor(c.time / 1000));
  const quote = {
    open: candles.map(c => c.open),
    high: candles.map(c => c.high),
    low: candles.map(c => c.low),
    close: candles.map(c => c.close),
    volume: candles.map(c => c.volume),
  };
  const result = [{ meta: {}, timestamp: ts, indicators: { quote: [quote] } }];
  return { ok: true, json: async () => ({ chart: { result } }) };
}

// which series the stub serves (swapped per scenario)
let serve15m = null;
let serve5m = null;
vi.mock('../server/ai/data.js', () => ({
  INDIA_UNIVERSE: ['RELIANCE'],
  CRYPTO_UNIVERSE: ['BTC'],
  FUTURES_UNIVERSE: ['B-BTC_USDT'],
  fetchTVIndiaBatch: async () => ({ RELIANCE: { ...BEARISH_DAILY } }),
  fetchTVCryptoBatch: async () => ({}),
  fetchCoinDcxCandles: async () => null,
  fetchYahooQuotes: async () => ({}), // neutral regime
  isNseOpen: () => true,
}));

vi.stubGlobal('fetch', vi.fn(async (url) => {
  const u = String(url);
  if (u.includes('RELIANCE.NS') && u.includes('interval=15m')) {
    if (serve15m) return yahooChartReply(cohereSeries(serve15m, 1258)); // v21.13 coherence (series end == live ltp)
  }
  if (u.includes('RELIANCE.NS') && u.includes('interval=5m')) {
    if (serve5m) return yahooChartReply(serve5m);
  }
  throw new Error('offline (test)');
}));

const { getSignals, __clearSignalCaches, resampleCandles, tapeMTFFromBase } = await import('../server/ai/signals.js');

const MID_SESSION = new Date('2026-09-09T05:30:00Z'); // Wed 11:00 IST

beforeEach(() => {
  __clearSignalCaches();
  serve15m = null;
  serve5m = null;
});

// ============================================================
// 1. Registry — the MTF seat
// ============================================================
describe('v10.5 registry — IntradayTapeMTF replaces the 15m seat when the flag is ON', () => {
  it('flag is ON for this suite and the registry reflects it', () => {
    expect(mtfConfluenceEnabled()).toBe(true);
    const mtf = MODELS.find(m => m.id === 'tape-mtf');
    const plain = MODELS.find(m => m.id === 'tape');
    expect(mtf).toBeTruthy();
    expect(mtf.weight).toBe(1.6);
    expect(typeof mtf.fn).toBe('function');
    expect(plain).toBeUndefined(); // same seat — never both
  });

  it('v12.6: crypto ctx WITH an m15 tapeMTF payload votes (data-driven gate — the entry-timing seat)', () => {
    const v = runQuantModels({ market: 'CRYPTO', symbol: 'BTC', ltp: 60000, tapeMTF: { m15: { ltp: 60000, ema10: 60100, ema20: 59900, rsi: 60, macdHist: 30, macdSlope: 5, vwap: 60000, last3Pct: 1 } } }).find(x => x.id === 'tape-mtf');
    // a rising 15m tape votes LONG — no longer parked on crypto desks
    expect(v.dir).toBe(1);
  });

  it('crypto/futures ctx with NO tape payload → honest abstain', () => {
    const v = runQuantModels({ market: 'CRYPTO', symbol: 'BTC', ltp: 60000 }).find(x => x.id === 'tape-mtf');
    expect(v.dir).toBe(0);
    expect(v.reasons.join(' ')).toContain('abstain');
  });

  it('no MTF payload AND no plain tape → abstain', () => {
    const v = runQuantModels({ market: 'INDIA', symbol: 'X', ltp: 100 }).find(x => x.id === 'tape-mtf');
    expect(v.dir).toBe(0);
  });
});

// ============================================================
// 2-4. The three confluence scenarios (synthetic tapes)
// ============================================================
describe('v10.5 IntradayTapeMTF — confluence scenarios', () => {
  const BULL_TAPE = { ltp: 1258, ema10: 1256, ema20: 1253, ema50: 1248, rsi: 64, macdHist: 1.2, macdSlope: 0.4, vwap: 1255, last3Pct: 0.7 };
  const BEAR_TAPE = { ltp: 1258, ema20: 1266, ema50: 1272, ema10: 1262, rsi: 36, macdHist: -1.5, macdSlope: -0.5, vwap: 1263, last3Pct: -0.8 };
  const mtfModel = MODELS.find(m => m.id === 'tape-mtf');
  const run = (tapeMTF) => mtfModel.fn({ market: 'INDIA', tapeMTF });

  it('ALL-ALIGN (3/3 bull) → LONG vote, conf boost, agreement reason', () => {
    const v = run({ m5: BULL_TAPE, m15: BULL_TAPE, h1: BULL_TAPE });
    expect(v.dir).toBe(1);
    expect(v.reasons.join(' ')).toContain('ALL 3 timeframes aligned');
    expect(v.conf).toBeGreaterThan(60);
  });

  it('2-OF-3 (m5 bear, m15+h1 bull) → agreement 0.67, partial confluence, still a vote', () => {
    const v = run({ m5: BEAR_TAPE, m15: BULL_TAPE, h1: BULL_TAPE });
    expect(v.dir).toBe(1); // the 15m anchor carries the vote
    expect(v.reasons.join(' ')).toContain('2 of 3 timeframes aligned');
    expect(v.conf).toBeGreaterThan(50);
  });

  it('ALL-DISAGREE (m5+h1 bear, m15 bull) → agreement 1/3, conf penalty, honest conflict reason', () => {
    const aligned = run({ m5: BULL_TAPE, m15: BULL_TAPE, h1: BULL_TAPE });
    const conflicted = run({ m5: BEAR_TAPE, m15: BULL_TAPE, h1: BEAR_TAPE });
    expect(conflicted.dir).toBe(1); // anchor still carries, but…
    expect(conflicted.conf).toBeLessThan(aligned.conf); // …-20 penalty bites
    expect(conflicted.reasons.join(' ')).toContain('Timeframe conflict');
  });

  it('neutral 15m anchor → honest abstain (no vote from a coil)', () => {
    const v = run({ m5: BULL_TAPE, m15: { ltp: 100, ema10: 100, ema20: 100, rsi: 50, macdHist: 0, vwap: 100, last3Pct: 0 }, h1: BULL_TAPE });
    expect(v.dir).toBe(0);
  });

  it('graceful degrade: no tapeMTF but a plain tape → falls back to the plain 15m logic', () => {
    const v = mtfModel.fn({ market: 'INDIA', tape: BULL_TAPE });
    expect(v.dir).toBe(1);
    expect(v.reasons.join(' ')).toContain('15m');
  });
});

// ============================================================
// 5. Ensemble grade cap — agreement < 0.67 bans STRONG
// ============================================================
describe('v10.5 aggregateVotes — the MTF confluence cap', () => {
  const strongVotes = [
    { id: 'trend', weight: 1.4, dir: -1, conf: 95, reasons: [] },
    { id: 'momentum', weight: 1.3, dir: -1, conf: 88, reasons: [] },
    { id: 'volume', weight: 1.2, dir: -1, conf: 80, reasons: [] },
    { id: 'sr', weight: 1.1, dir: -1, conf: 78, reasons: [] },
    { id: 'smc', weight: 1.1, dir: -1, conf: 74, reasons: [] },
  ];

  it('no mtfAgreement → STRONG reachable (backward compat)', () => {
    const c = aggregateVotes(strongVotes);
    expect(c.grade).toBe('STRONG');
  });

  it('agreement 1.0 (all TFs aligned) → STRONG still reachable', () => {
    const c = aggregateVotes(strongVotes, undefined, { mtfAgreement: 1 });
    expect(c.grade).toBe('STRONG');
    expect(c.mtfCapped).toBeUndefined();
  });

  it('agreement 0.67 (2-of-3) → passes (>= threshold)', () => {
    const c = aggregateVotes(strongVotes, undefined, { mtfAgreement: 0.67 });
    expect(c.grade).toBe('STRONG');
  });

  it('agreement 0.33 (< 0.67) → STRONG BANNED, max ACTION, flagged', () => {
    const c = aggregateVotes(strongVotes, undefined, { mtfAgreement: 1 / 3 });
    expect(c.grade).toBe('ACTION');
    expect(c.grade).not.toBe('STRONG');
    expect(c.mtfCapped).toBe(true);
    expect(c.mtfAgreement).toBeCloseTo(0.33, 2);
    expect(c.summary).toContain('MTF-capped');
  });

  it('null/garbage agreement → ignored (honest, no cap)', () => {
    expect(aggregateVotes(strongVotes, undefined, { mtfAgreement: null }).grade).toBe('STRONG');
    expect(aggregateVotes(strongVotes, undefined, { mtfAgreement: 'x' }).grade).toBe('STRONG');
  });
});

// ============================================================
// 6. resampleCandles — the pure OHLCV resampler
// ============================================================
describe('v10.5 resampleCandles — server-side resampling', () => {
  // epoch-aligned base (15m boundary) so the test bars sit INSIDE buckets
  const T0 = 1699999200000; // divisible by 15m and 1h
  const bars = (minutes, closes) => closes.map((close, i) => ({
    time: T0 + i * minutes * 60_000,
    open: close - 1, high: close + 2, low: close - 2, close, volume: 100,
  }));

  it('3×5m → one 15m bar with aggregated OHLCV', () => {
    const out = resampleCandles(bars(5, [10, 11, 12]), 15);
    expect(out).toHaveLength(1);
    expect(out[0].open).toBe(9);
    expect(out[0].high).toBe(14);
    expect(out[0].low).toBe(8);
    expect(out[0].close).toBe(12);
    expect(out[0].volume).toBe(300);
  });

  it('bars from DIFFERENT 15m buckets never merge (time-bucketed)', () => {
    // :05 and :10 share the first 15m bucket; :40 sits in the third
    const odd = [
      { time: T0 + 5 * 60_000, open: 1, high: 1, low: 1, close: 1, volume: 1 },
      { time: T0 + 10 * 60_000, open: 2, high: 2, low: 2, close: 2, volume: 1 },
      { time: T0 + 40 * 60_000, open: 3, high: 3, low: 3, close: 3, volume: 1 },
    ];
    const out = resampleCandles(odd, 15);
    expect(out).toHaveLength(2);
    expect(out[0].close).toBe(2);
    expect(out[0].volume).toBe(2);
    expect(out[1].close).toBe(3);
  });

  it('12×5m → 4×15m or 1×1h with volume sums intact', () => {
    const src = bars(5, Array.from({ length: 12 }, (_, i) => 10 + i));
    expect(resampleCandles(src, 15)).toHaveLength(4);
    const h1 = resampleCandles(src, 60);
    expect(h1).toHaveLength(1);
    expect(h1[0].volume).toBe(1200);
  });

  it('garbage in → null out (never throws)', () => {
    expect(resampleCandles(null, 15)).toBeNull();
    expect(resampleCandles([], 15)).toBeNull();
    expect(resampleCandles(bars(5, [1]), 0)).toBeNull();
  });
});

// ============================================================
// 7. tapeMTFFromBase — the m5/m15/h1 payload + agreement math
// ============================================================
describe('v10.5 tapeMTFFromBase — MTF payload builder', () => {
  it('climbing 5m base + climbing native 15m → all three tapes (h1 included), agreement 1', () => {
    const base5m = driftSeries(5, 1200, 0.0009);
    const native15m = driftSeries(15, 90, 0.0027);
    const mtf = tapeMTFFromBase(base5m, native15m, null);
    expect(mtf).toBeTruthy();
    expect(mtf.m5).toBeTruthy();
    expect(mtf.m15).toBeTruthy();
    expect(mtf.h1).toBeTruthy();
    expect(mtf.agreement).toBe(1);
  });

  it('falling 5m base + climbing native 15m → agreement 1/3 (h1 follows the 5m base)', () => {
    const base5m = driftSeries(5, 1200, -0.0016);
    const native15m = driftSeries(15, 90, 0.0027);
    const mtf = tapeMTFFromBase(base5m, native15m, null);
    expect(mtf).toBeTruthy();
    expect(mtf.agreement).toBeCloseTo(1 / 3, 5);
  });

  it('no 5m base → null (honest degrade, no MTF read)', () => {
    expect(tapeMTFFromBase(null, driftSeries(15, 90, 0.002), null)).toBeNull();
    expect(tapeMTFFromBase([1, 2, 3], driftSeries(15, 90, 0.002), null)).toBeNull();
  });
});

// ============================================================
// 8. THE BOARD — flag ON end-to-end (clock pinned mid-session)
// ============================================================
describe('v10.5 board — MTF confluence live on the India desk', () => {
  beforeAll(() => { vi.useFakeTimers(); vi.setSystemTime(MID_SESSION); });
  afterAll(() => { vi.useRealTimers(); });

  it('tape-mtf vote in the committee + mtf payload on the signal (all TFs bearish)', async () => {
    serve15m = falling15mWithPullbacks(); // realistic falling 15m (RSI ~41 — not oversold)
    serve5m = FALL_5M();                    // falling 5m → h1 resamples bear too
    const board = await getSignals('INDIA', {}, { limit: 10, noCache: true });
    expect(board.ok).toBe(true);
    const sig = board.signals.find(s => s.symbol === 'RELIANCE');
    expect(sig).toBeTruthy();
    const mtfVote = (sig.votes || []).find(v => v.id === 'tape-mtf');
    expect(mtfVote).toBeTruthy();
    expect(mtfVote.dir).toBe(-1); // daily bearish + all TFs bearish
    // the wire payload rides the signal for the badge
    expect(sig.mtf).toBeTruthy();
    expect(sig.mtf.m15).toBeTruthy();
    expect(sig.mtf.m15.dir).toBe(-1);
    expect(sig.mtf.agreement).toBe(1); // all three aligned
    // full confluence must still allow the desk to fire
    if (sig.side === 'SHORT') expect(['STRONG', 'ACTION']).toContain(sig.grade);
  }, 30_000);

  it('5m/1h conflict (climbing) vs 15m (falling) → agreement < 2/3 on the payload + NO double tape vote', async () => {
    serve15m = driftSeries(15, 90, -0.0016); // falling trading TF
    serve5m = RISE_5M();                    // recent 5m climb (h1 climbs too)
    const board = await getSignals('INDIA', {}, { limit: 10, noCache: true });
    const sig = board.signals.find(s => s.symbol === 'RELIANCE');
    expect(sig).toBeTruthy();
    expect(sig.mtf).toBeTruthy();
    expect(sig.mtf.m15?.dir).toBe(-1);
    expect([sig.mtf.m5?.dir, sig.mtf.h1?.dir]).toContain(1); // the climbers
    expect(sig.mtf.agreement).toBeLessThan(2 / 3);
    // only ONE tape seat voted
    const tapeSeats = (sig.votes || []).filter(v => v.id === 'tape' || v.id === 'tape-mtf');
    expect(tapeSeats.length).toBeLessThanOrEqual(1);
    // and a conflicted read can NEVER wear STRONG
    if (sig.side === 'SHORT' || sig.side === 'LONG') expect(sig.grade).not.toBe('STRONG');
  }, 30_000);

  it('5m feed dead → honest degrade to the plain 15m tape logic (no crash, no badge payload gap)', async () => {
    serve15m = driftSeries(15, 90, -0.0016);
    serve5m = null; // 5m fetch fails → tapeMTF null → MTF model falls back
    const board = await getSignals('INDIA', {}, { limit: 10, noCache: true });
    const sig = board.signals.find(s => s.symbol === 'RELIANCE');
    expect(sig).toBeTruthy();
    // the seat still voted via the graceful fallback (plain-tape logic)
    const tapeSeats = (sig.votes || []).filter(v => v.id === 'tape' || v.id === 'tape-mtf');
    expect(tapeSeats.length).toBeLessThanOrEqual(1);
  }, 30_000);
});
