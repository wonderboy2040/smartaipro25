// ============================================================
// test/cryptoCounterTape.test.ts — v20.4 CRYPTO COUNTER-TAPE WIRING
// ------------------------------------------------------------
// THE USER REPORT (CoinDCX tab): "Trade signal Strong 80+ SHORT
// rehne par bhi LONG jaa raha hai" — the board printed STRONG 80+
// SHORTs while the price/15m tape kept climbing.
//
// Deep-audit root cause (mechanical, not behavioural):
//   • probrain.qualityVerdict HAS the v9.3 counter-tape protection
//     (MISALIGNED htf-vs-15m phase → conf −12/−18 + WATCH/ACTION
//     grade caps) — built for EXACTLY this bug on the India desk.
//   • But signals.js fed it `enr?.ltfInd` — the INDIA-only
//     enrichment map (enrichN = INDIA ? … : 0). On CRYPTO/FUTURES
//     enr is ALWAYS null → mtfAnalysis compared the 1h committee
//     against ITSELF → phase UNAVAILABLE → the counter-tape caps
//     NEVER fired off India.
//   • The 15m tape enrichment the crypto desks DO fetch
//     (tapeEnriched) only voted (w 1.3) — it could never out-vote
//     5-7 lagging 1h seats (combined w ~5-9) that turn bearish
//     AFTER the dump, exactly when the tape V-bounces up.
//   → a lagging 1h bear stack printed STRONG SHORT at the bottom of
//     the V while the 15m tape was already ripping. The user shorted
//     the bottom and watched the trade "go LONG".
//
// v20.4 fix locked here (3 layers):
//   1. UNIT: qualityVerdict on CRYPTO with a real 15m LTF fires the
//      MISALIGNED phase + WATCH cap (driving tape) — and stays
//      inert (UNAVAILABLE) with ltf=null so the wiring test below
//      can never silently regress to feeding null.
//   2. BOARD: getSignals('CRYPTO') — bearish 1h committee + RISING
//      15m tape → the SHORT signal is DEMOTED below STRONG and
//      carries quality.mtf.phase MISALIGNED + counterTape flag.
//      The same 1h data + a CONFIRMING (falling) 15m tape still
//      earns the desk its STRONG SHORT (protection ≠ paralysis).
//   3. DEEP: getDeepSignal('BTC','CRYPTO') — the deep card (what
//      the execution gauntlets re-verify at click time) shows the
//      same MISALIGNED phase; pre-fix it compared 1h-vs-1h.
//
// Hermetic: data.js mocked, network stubbed offline (same pattern
// as cryptoBoardFallback.test.ts / intradayTapeAlignment.test.ts).
// ============================================================
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// hermetic data dir (never touches a dev install's journal/ledger)
process.env.SMARTAI_DATA_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '../.test-data-cx-counter-tape');

// ============================================================
// Fixtures — the exact scenario from the user's screen:
// a BEARISH 1h committee (the lagging stack after the dump) while
// the 15m tape V-bounces UP.
// ============================================================
const FAKE_FX = 85.9;

// Falling 1h candles in the INR domain — accelerating decline into a
// flat low consolidation (the realistic post-dump shape: price holds
// the low while the lagging EMA stack catches down), calibrated so
// the computed indicators read a REAL bear committee (not a
// degenerate oversold tape and not a stretched chase leg):
//   RSI ≈ 36 (bearish zone, above the v12.4 RSI≤30 SHORT veto) ·
//   ltp < ema10 < ema20 < ema50 · supertrend −1 · MFI 30 · OBV
//   falling · extension ≈ 1.2×ATR (below the v12.5 chase guard).
// v21.4.1: tail 25 bars (d=0.0006) → 14 bars (d=0.0010) — ADX(14)
// ka smoothing window (~27 bars) ab strong pre-tail bars bhi dekhta
// hai, isliye computed ADX ~16-19 band me aata hai (weak-trend, NOT
// chop). Purane fixture ka ADX 9.6 tha jo v21.3.0 ke CHOP FILTER
// (ADX<15 → WATCH cap) ki range me hai — par v21.3.0 me wo leg
// object-shape bug se DEAD tha, isliye ye fixture kabhi chop-hit nahi
// hota tha. A1 fix ke baad chop sach me fire hota hai; is fixture ka
// maqsad (counter-tape parity, weak-trend ACTION ceiling, RSI ~36
// bear committee) preserve karne ke liye tail chhota kiya gaya.
function falling1hINR(n = 200) {
  const out = [];
  const t0 = Date.now() - n * 3_600_000;
  let px = 7_200_000;
  // v21.4.1: tail ka LOW-wick 0.9992 → 0.9985 (sirf DOWN bars pe). ADX
  // high/low extremes se banta hai (−DM = low_{t-1} − low_t) — deeper
  // down-bar lows DI-separation bana dete hain BINA closes (RSI/MACD/
  // EMA committee) ko chue. Original flat tail ka candle-ADX 9.6 padta
  // tha jo v21.3.0 ke CHOP FILTER (ADX<15 → WATCH cap) ki range me hai
  // — par v21.3.0 me wo leg object-shape bug se DEAD tha, isliye ye
  // fixture kabhi chop-hit nahi hota tha. A1 fix ke baad chop sach me
  // fire hota hai; fixture ab apna original committee calibration
  // (RSI ≈ 35 bear zone, no chase) rakhta hai sirf wick-structure me
  // directionality jodkar — computed ADX weak-trend band (~17) me.
  const tail = 25;
  for (let i = 0; i < n; i++) {
    const inTail = i >= n - tail;
    const d = inTail ? 0.0006 : 0.0025 + (0.0035 - 0.0025) * (i / n);
    const bounce = i % 3 === 2;
    px = px * (bounce ? 1 + d * 1.2 : 1 - d);
    out.push({
      time: t0 + i * 3_600_000,
      open: +(px * 0.9998).toFixed(2), high: +(px * (bounce ? 1.0012 : 1.0006)).toFixed(2),
      low: +(px * (inTail && !bounce ? 0.9985 : 0.9992)).toFixed(2), close: +px.toFixed(2),
      volume: 1200 + (i % 7) * 130,
    });
  }
  return out;
}

// the price chain anchors on the 1h series' last close: ticker ltp,
// TV usdPrice, the wick-guard reference and both 15m tapes all agree
// on it, so no guard fires on a stale/mismatched print.
const END = falling1hINR().at(-1).close;
const BTC_INR_LTP = END;                       // CoinDCX INR ticker price
const BTC_USD_TV = +(END / FAKE_FX).toFixed(2); // TV row close (USD domain)

// A BEARISH 1h-domain TV row (modeled on a post-dump scanner read:
// RSI 34, price below every EMA, MACD deep under signal, -DI leads).
// Proportional to the live USD anchor so the rescale is exact.
function bearishTvRow() {
  const U = BTC_USD_TV;
  return {
    symbol: 'BTC', usdPrice: U, changePct: -3.1,
    rsi: 34.2, macd: -0.0069 * U, macdSignal: -0.0041 * U,
    ema10: 0.984 * U, ema20: 0.994 * U, ema50: 1.016 * U,
    sma20: 0.993 * U, sma50: 1.014 * U,
    atr: 0.0145 * U, adx: 31.5, adxPlus: 11.8, adxMinus: 24.9,
    bbUpper: 1.042 * U, bbLower: 0.958 * U,
    stochK: 26, stochD: 33,
    relVolume: 1.55, recommend: -0.42,
  };
}

// The RISING 15m tape — the V-bounce the user watched while the
// board said STRONG SHORT. Steady climb, INR domain, ends at ltp.
function risingTape15m(n = 90) {
  const out = [];
  const t0 = Date.now() - n * 15 * 60_000;
  let px = BTC_INR_LTP / Math.pow(1.0016, n - 1);
  for (let i = 0; i < n; i++) {
    px = px * 1.0016;
    out.push({
      time: t0 + i * 15 * 60_000,
      open: +(px * 0.9996).toFixed(2), high: +(px * 1.0015).toFixed(2),
      low: +(px * 0.9985).toFixed(2), close: +px.toFixed(2),
      volume: 120_000 + (i % 7) * 9_000,
    });
  }
  return out;
}

// A CONFIRMING 15m tape — trend down with periodic pullback bars
// (RSI ~41, the shape a real bearish intraday tape has). Same 1h
// data + this tape must keep the desk's STRONG SHORT alive.
function fallingTape15m(n = 90) {
  const out = [];
  const t0 = Date.now() - n * 15 * 60_000;
  let px = BTC_INR_LTP * 1.16; // falls to ≈ ltp over the run
  for (let i = 0; i < n; i++) {
    const bounce = i % 4 === 3;
    px = px * (bounce ? 1.0045 : 0.9978);
    out.push({
      time: t0 + i * 15 * 60_000,
      open: +(px * (bounce ? 1.0004 : 0.9996)).toFixed(2),
      high: +(px * 1.0015).toFixed(2), low: +(px * 0.9985).toFixed(2),
      close: +px.toFixed(2),
      volume: 120_000 + (i % 7) * 9_000,
    });
  }
  return out;
}

// which 15m series the mocked candle feed serves this test
let tapeSeries = risingTape15m();

// ---------------- data.js mock (module-graph-wide) ----------------
vi.mock('../server/ai/data.js', () => ({
  INDIA_UNIVERSE: ['RELIANCE'],
  CRYPTO_UNIVERSE: ['BTC'],
  FUTURES_UNIVERSE: ['B-BTC_USDT'],
  fetchTVIndiaBatch: async () => ({}),
  fetchTVIndiaBatchChunked: async () => ({}),
  fetchTVCryptoBatch: async () => ({ BTC: bearishTvRow() }), // the bearish 1h committee
  fetchCoinDcxCandles: async (base, tf) => {
    if (tf === '15m') return tapeSeries;   // ← the tape the board refused to see (pre-fix)
    if (tf === '1h') return falling1hINR(); // the lagging bearish 1h stack
    return null;
  },
  fetchBinanceKlines: async () => falling1hINR(),
  fetchYahooQuotes: async () => ({}),      // neutral BTC regime (no counter-regime noise)
  isNseOpen: () => false,
}));

// ---------------- raw network stub (tickers + fx + wick ref) ----------------
vi.stubGlobal('fetch', vi.fn(async (url) => {
  const u = String(url);
  if (u.includes('api.coindcx.com/exchange/ticker')) {
    return new Response(JSON.stringify([
      { market: 'BTCINR', last_price: String(BTC_INR_LTP), volume_24_hour: '42' },
    ]), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  if (u.includes('USDINR=X')) {
    return new Response(JSON.stringify({
      chart: { result: [{ meta: { regularMarketPrice: FAKE_FX } }] },
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  if (u.includes('api.binance.com/api/v3/ticker/price')) { // wick-guard cross-venue ref
    return new Response(JSON.stringify([
      { symbol: 'BTCUSDT', price: String(BTC_USD_TV) },   // = BTC_INR_LTP / FAKE_FX — no suppression
    ]), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  throw new Error('offline (test)');
}));

const { getSignals, getDeepSignal, __clearSignalCaches } = await import('../server/ai/signals.js');
const { mtfAnalysis, qualityVerdict } = await import('../server/ai/probrain.js');

beforeEach(() => {
  __clearSignalCaches();
  tapeSeries = risingTape15m();
});

// ============================================================
// 1. UNIT — the pure probrain layer (crypto market, real 15m LTF)
// ============================================================
describe('v20.4 counter-tape unit layer (CRYPTO market)', () => {
  const BEAR_HTF = { ema20: 75_600, ema50: 77_100, rsi: 38 };            // the 1h committee
  const RISING_15M = { ema20: 6_430_000, ema50: 6_380_000, rsi: 61, macd: { hist: 18_000, histSlope: 4_000 } };
  const FALLING_15M = { ema20: 6_600_000, ema50: 6_720_000, rsi: 41, macd: { hist: -22_000, histSlope: -5_000 } };
  const votes = [
    { id: 'trend', name: 'TrendMatrix', role: 'r', weight: 1.4, dir: -1, conf: 88, reasons: [] },
    { id: 'momentum', name: 'MomentumQuant', role: 'r', weight: 1.3, dir: -1, conf: 84, reasons: [] },
    { id: 'volume', name: 'VolumeFlow', role: 'r', weight: 1.2, dir: -1, conf: 80, reasons: [] },
  ];

  it('SHORT vs a RISING 15m tape (bearish 1h htf) → MISALIGNED, driving tape → gradeCap WATCH', () => {
    const qv = qualityVerdict({
      market: 'CRYPTO', side: 'SHORT', consensus: { confidence: 82, agreement: 0.9 }, votes,
      ltp: BTC_INR_LTP, changePct: -3.1, rsi: 34, adx: 31,
      atr: 110_000, candles: null, regime: {}, htf: BEAR_HTF, ltf: RISING_15M,
      ltfLabel: '15m', now: Date.now(),
    });
    expect(qv.mtf.phase).toBe('MISALIGNED');
    expect(qv.mtf.aligned).toBe(false);
    expect(qv.flags.counterTape).toBeTruthy();
    expect(qv.flags.counterTape.strong).toBe(true);       // RSI 61 + MACD+ = driving tape
    expect(['WATCH', 'ACTION']).toContain(qv.gradeCap);   // STRONG banned
    expect(qv.gradeCap).toBe('WATCH');                    // driving tape → WATCH-only
    expect(qv.confAdj).toBeLessThanOrEqual(-12);
  });

  it('SHORT vs a CONFIRMING 15m tape (same bearish 1h) → ALIGNED, gradeCap STRONG (desk stays alive)', () => {
    const qv = qualityVerdict({
      market: 'CRYPTO', side: 'SHORT', consensus: { confidence: 82, agreement: 0.9 }, votes,
      ltp: BTC_INR_LTP, changePct: -3.1, rsi: 34, adx: 31,
      atr: 110_000, candles: null, regime: {}, htf: BEAR_HTF, ltf: FALLING_15M,
      ltfLabel: '15m', now: Date.now(),
    });
    expect(qv.mtf.phase).toBe('ALIGNED');
    expect(qv.gradeCap).toBe('STRONG');
    expect(qv.confAdj).toBeGreaterThan(0);                // aligned bonus
  });

  it('ltf=null (the pre-fix crypto wiring) → phase UNAVAILABLE — the exact inertness the fix removes', () => {
    const qv = qualityVerdict({
      market: 'CRYPTO', side: 'SHORT', consensus: { confidence: 82, agreement: 0.9 }, votes,
      ltp: BTC_INR_LTP, changePct: -3.1, rsi: 34, adx: 31,
      atr: 110_000, candles: null, regime: {}, htf: BEAR_HTF, ltf: null,
      ltfLabel: '15m', now: Date.now(),
    });
    // documents WHY the protection never fired off India pre-v20.4:
    // no LTF → mtf skips honestly → no MISALIGNED → no cap
    expect(qv.mtf.phase).toBe('UNAVAILABLE');
    expect(qv.mtf.available).toBe(false);
  });

  it('mtfAnalysis accepts the candle-shape 15m indicators (macd.hist) the crypto tape enrichment produces', () => {
    const m = mtfAnalysis({ htf: BEAR_HTF, ltf: RISING_15M, side: 'SHORT', ltfLabel: '15m' });
    expect(m.phase).toBe('MISALIGNED');
    expect(m.againstTapeStrength).toBe(1);
  });
});

// ============================================================
// 2. BOARD — getSignals('CRYPTO'): the lagging 1h bear stack + the
//    rising 15m tape (the user's exact screen)
// ============================================================
describe('v20.4 crypto board — counter-tape STRONG demotion', () => {
  it('bearish 1h committee + RISING 15m tape → SHORT side, but grade DEMOTED below STRONG with the counter-tape veto', async () => {
    const board = await getSignals('CRYPTO', {}, { noCache: true });
    expect(board.ok).toBe(true);
    const btc = board.signals.find(s => s.symbol === 'BTC');
    expect(btc).toBeTruthy();
    // the scenario reproduces: the lagging 1h stack wins the SIDE vote
    expect(btc.side).toBe('SHORT');
    // the tape seat actually voted (revived, LONG) — the counterweight exists
    const tapeVote = (btc.votes || []).find(v => v.id === 'tape' || v.id === 'tape-mtf');
    expect(tapeVote).toBeTruthy();
    expect(tapeVote.dir).toBe(1);
    // THE FIX: the quality layer now SEES the 15m tape (pre-fix: enr=null
    // → ltf=null → UNAVAILABLE → the STRONG badge shipped un-demoted).
    // NOTE: quality.mtf.phase is later RE-STATED by the v18.5 MTF-6 engine
    // (its 6-TF consensus is trend-TF dominated, so it can read TREND-
    // ALIGNED here) — the counter-tape truth survives on quality.counterTape
    // + confAdj + the grade cap, which is what the gauntlets respect.
    expect(btc.quality?.counterTape).toBeTruthy();
    expect(btc.quality?.counterTape?.strong).toBe(true);  // driving tape (15m RSI>55 + MACD+)
    expect(btc.quality?.confAdj).toBeLessThanOrEqual(-12);
    expect(btc.quality?.mtf?.available).toBe(true);       // an MTF read exists (probrain or mtf6)
    // STRONG is banned against a driving tape (WATCH/ACTION only)
    expect(btc.grade).not.toBe('STRONG');
    expect(['WATCH', 'ACTION', 'NEUTRAL']).toContain(btc.grade);
    // the demotion is honest: the board says WHY
    const why = (btc.quality?.reasons || []).join(' ');
    expect(why).toContain('COUNTER-TAPE');
  }, 30_000);

  it('same bearish 1h data + CONFIRMING 15m tape → the desk stays tradeable (ACTION/STRONG, NO counter-tape veto — protection ≠ paralysis)', async () => {
    tapeSeries = fallingTape15m();
    const board = await getSignals('CRYPTO', {}, { noCache: true });
    expect(board.ok).toBe(true);
    const btc = board.signals.find(s => s.symbol === 'BTC');
    expect(btc).toBeTruthy();
    expect(btc.side).toBe('SHORT');
    // THE PARITY LOCK: with the tape CONFIRMING, the counter-tape caps
    // must NOT bind — no flag, no −18, the aligned bonus applies.
    expect(btc.quality?.counterTape).toBeFalsy();
    expect(btc.quality?.confAdj).toBeGreaterThan(0);
    expect(btc.confidence).toBeGreaterThanOrEqual(70);
    // ACTION is the honest ceiling on this fixture (the flat tail reads
    // ADX<18 → probrain's weak-trend downgrade — a REAL guard, unrelated
    // to counter-tape). STRONG would also be fine; the lock is: tradeable
    // grade + no veto, while the rising-tape twin is demoted+flagged.
    expect(['ACTION', 'STRONG']).toContain(btc.grade);
  }, 30_000);
});

// ============================================================
// 3. DEEP — getDeepSignal('BTC','CRYPTO'): the card the execution
//    gauntlets re-verify at click time must agree with the board
// ============================================================
describe('v20.4 crypto deep dive — the 1h-vs-1h self-compare is gone', () => {
  it('bearish 1h + RISING 15m tape → deep card carries the counter-tape veto + grade below STRONG', async () => {
    const deep = await getDeepSignal('BTC', 'CRYPTO', {});
    expect(deep.ok).toBe(true);
    expect(deep.signal.side).toBe('SHORT');
    expect(deep.signal.quality?.counterTape?.strong).toBe(true);
    expect(deep.signal.quality?.confAdj).toBeLessThanOrEqual(-12);
    expect(deep.signal.grade).not.toBe('STRONG');
  }, 30_000);

  it('bearish 1h + CONFIRMING 15m tape → deep card agrees with the board (tradeable, no counter-tape)', async () => {
    tapeSeries = fallingTape15m();
    const deep = await getDeepSignal('BTC', 'CRYPTO', {});
    expect(deep.ok).toBe(true);
    expect(deep.signal.side).toBe('SHORT');
    expect(deep.signal.quality?.counterTape).toBeFalsy();
    expect(deep.signal.quality?.confAdj).toBeGreaterThan(0);
    expect(['ACTION', 'STRONG']).toContain(deep.signal.grade);
  }, 30_000);
});
