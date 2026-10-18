// ============================================================
// test/intradayTapeAlignment.test.ts — v9.3 INTRADAY TAPE ALIGNMENT
// ------------------------------------------------------------
// THE "wrong trend" regression lock.
//
// The user's screenshot: 4 open PAPER SHORT positions on NSE stocks
// (RELIANCE / CIPLA / ITC / ASIANPAINT) all bleeding while the tape
// climbed — opened from STRONG/ACTION SHORT badges the engine gave on
// a RISING intraday tape. Root cause (verified live): the TV India
// scanner serves DAILY-timeframe indicators (scanner EMA10/EMA50 ==
// Yahoo DAILY EMAs to the cent) and the whole committee voted on the
// daily stack; the 15m tape only whispered -12 conf with NO grade cap
// on the MISALIGNED phase.
//
// v9.3 locks the fix:
//   1. IntradayTape (11th model, w 1.3) — the 15m tape VOTES
//   2. Counter-tape gating — a trade against a driving 15m tape is
//      WATCH-only (STRONG/ACTION banned); a stalling tape caps at ACTION
//   3. Board-level: bearish daily + rising 15m can NEVER badge STRONG
//      SHORT again; the SAME daily data with a CONFIRMING 15m tape
//      still produces STRONG SHORTs (the desk stays alive)
// Hermetic: data.js + network mocked OFFLINE (same pattern as
// boardResilience.test.ts).
// ============================================================
import { describe, it, expect, beforeEach, beforeAll, afterAll, vi } from 'vitest';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// hermetic data dir
process.env.SMARTAI_DATA_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '../.test-data-tape-align');

// ---------------- unit-level imports (no mocks needed) ----------------
const { MODELS, runQuantModels } = await import('../server/ai/models.js');
const { mtfAnalysis, qualityVerdict } = await import('../server/ai/probrain.js');
const { aggregateVotes } = await import('../server/ai/ensemble.js');

// ---------------- board-level mocks ----------------
// Bearish DAILY row for RELIANCE — modeled on the live scanner values
// from the day of the screenshot (daily RSI 37, price below every daily
// EMA, MACD hist negative, below pivot/S1, relVolume 1.3).
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

// A RISING 15m series (the tape climbing while the daily stack is
// bearish) — the exact screenshot scenario.
function risingTapeCandles(n = 90) {
  const out = [];
  const t0 = Date.now() - n * 15 * 60_000;
  let px = 1240;
  for (let i = 0; i < n; i++) {
    px = px * (1 + 0.0016); // steady climb ~ +0.16%/bar
    const c = +px.toFixed(2);
    out.push({
      time: t0 + i * 15 * 60_000,
      open: +(px * 0.9996).toFixed(2), high: +(px * 1.0015).toFixed(2),
      low: +(px * 0.9985).toFixed(2), close: c, volume: 120_000 + (i % 7) * 9_000,
    });
  }
  return out;
}

// A FALLING 15m series — same bearish daily, but the tape CONFIRMS.
// (Monotonic by construction — RSI computes to ~0. Kept for the v12.4
// OVERSOLD-guard lock below: a deeply oversold tape must NOT hand out
// an actionable SHORT badge.)
function fallingTapeCandles(n = 90) {
  const out = [];
  const t0 = Date.now() - n * 15 * 60_000;
  let px = 1290;
  for (let i = 0; i < n; i++) {
    px = px * (1 - 0.0016);
    const c = +px.toFixed(2);
    out.push({
      time: t0 + i * 15 * 60_000,
      open: +(px * 1.0004).toFixed(2), high: +(px * 1.0015).toFixed(2),
      low: +(px * 0.9985).toFixed(2), close: c, volume: 120_000 + (i % 7) * 9_000,
    });
  }
  return out;
}

// v12.4: a REALISTIC falling tape — trend down with periodic pullback
// bars (RSI lands ~41, safely inside the 30-70 band): the shape a real
// bearish intraday tape has. This is the fixture under which a
// CONFIRMING tape still earns the desk its STRONG/ACTION SHORT.
function fallingWithPullbacks(n = 90) {
  const out = [];
  const t0 = Date.now() - n * 15 * 60_000;
  let px = 1290;
  for (let i = 0; i < n; i++) {
    const bounce = i % 4 === 3; // every 4th bar a pullback up-bar
    px = px * (bounce ? 1.0045 : 0.998);
    const c = +px.toFixed(2);
    out.push({
      time: t0 + i * 15 * 60_000,
      open: +(px * (bounce ? 1.0004 : 0.9996)).toFixed(2), high: +(px * 1.0015).toFixed(2),
      low: +(px * 0.9985).toFixed(2), close: c, volume: 120_000 + (i % 7) * 9_000,
    });
  }
  return out;
}

// v21.13 COHERENCE: production me Yahoo 15m ka last close == live ltp
// (same symbol, same tape). Synthetic fixtures alag price pe khatam hote
// the (series 1247 vs TV row ltp 1258) — candle-derived levels (prev-bar
// high/low, S/R) fictional +ve/-ve fires karte the. Scale the served
// series so its final close lands exactly on the live ltp.
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

// which 15m series the stub serves this test (swapped per scenario)
let tapeSeries = null;
vi.mock('../server/ai/data.js', () => ({
  INDIA_UNIVERSE: ['RELIANCE'],
  CRYPTO_UNIVERSE: ['BTC'],
  FUTURES_UNIVERSE: ['B-BTC_USDT'],
  fetchTVIndiaBatch: async () => ({ RELIANCE: { ...BEARISH_DAILY } }),
  fetchTVCryptoBatch: async () => ({}),
  fetchCoinDcxCandles: async () => null,
  fetchYahooQuotes: async () => ({}), // neutral regime (no counter-regime noise)
  isNseOpen: () => true,
}));

vi.stubGlobal('fetch', vi.fn(async (url) => {
  const u = String(url);
  if (u.includes('RELIANCE.NS') && u.includes('interval=15m')) {
    if (tapeSeries) return yahooChartReply(cohereSeries(tapeSeries, BEARISH_DAILY.ltp));
  }
  throw new Error('offline (test)');
}));

const { getSignals, __clearSignalCaches } = await import('../server/ai/signals.js');

// v9.5 DETERMINISM FIX: the INDIA session gate (sessionPhase → "no-new-
// entries after 15:15 IST" → gradeCap WATCH) made these tests TIME-OF-DAY
// dependent — they passed at authoring time (mid-session) and failed every
// evening after 15:15 IST. All quality-verdict / board fixtures now pin a
// fixed mid-session Wednesday 11:00 IST so the suite is deterministic.
const MID_SESSION = new Date('2026-09-09T05:30:00Z'); // Wed 11:00 IST

beforeEach(() => {
  __clearSignalCaches();
  tapeSeries = null;
});

// ============================================================
// 1. The IntradayTape model itself
// ============================================================
describe('v9.3 IntradayTape — the 15m committee seat', () => {
  const tapeModel = MODELS.find(m => m.id === 'tape');
  const run = (ctx) => runQuantModels(ctx).find(v => v.id === 'tape');

  it('is registered with weight 1.3 (a full seat, not a whisper)', () => {
    expect(tapeModel).toBeTruthy();
    expect(tapeModel.weight).toBe(1.3);
    expect(typeof tapeModel.fn).toBe('function');
  });

  it('a RISING 15m tape votes LONG with real conviction', () => {
    const v = run({
      market: 'INDIA', symbol: 'X', ltp: 1258,
      tape: { ltp: 1258, ema10: 1256, ema20: 1253, ema50: 1248, rsi: 64, macdHist: 1.2, macdSlope: 0.4, vwap: 1255, last3Pct: 0.7 },
    });
    expect(v.dir).toBe(1);
    expect(v.conf).toBeGreaterThan(55);
    expect(v.reasons.join(' ')).toContain('15m');
  });

  it('a FALLING 15m tape votes SHORT', () => {
    const v = run({
      market: 'INDIA', symbol: 'X', ltp: 1258,
      tape: { ltp: 1258, ema10: 1262, ema20: 1266, ema50: 1272, rsi: 36, macdHist: -1.5, macdSlope: -0.5, vwap: 1263, last3Pct: -0.8 },
    });
    expect(v.dir).toBe(-1);
    expect(v.conf).toBeGreaterThan(55);
  });

  it('no tape data → honest abstain (dir 0, low conf, honest reason)', () => {
    const v = run({ market: 'INDIA', symbol: 'X', ltp: 1258, ind: null, regime: null });
    expect(v.dir).toBe(0);
    expect(v.conf).toBe(0);
    expect(v.reasons.join(' ')).toContain('abstains');
  });

  it('v12.6: crypto/futures ctx WITH a tape payload now VOTES (the entry-timing seat — 1h reads the swing, 15m reads timing)', () => {
    const v = run({
      market: 'CRYPTO', symbol: 'BTC', ltp: 60000,
      tape: { ltp: 60000, ema10: 60100, ema20: 59900, rsi: 62, macdHist: 30, macdSlope: 5, vwap: 60000, last3Pct: 0.4 },
    });
    // a rising 15m tape votes LONG — the committee is no longer a pure
    // 1h trend echo (the 29%-win-rate disease)
    expect(v.dir).toBe(1);
    expect(v.conf).toBeGreaterThan(50);
  });

  it('v12.6: crypto/futures ctx WITHOUT tape data still abstains honestly (dir 0)', () => {
    const v = run({ market: 'CRYPTO', symbol: 'BTC', ltp: 60000, ind: null, regime: null });
    expect(v.dir).toBe(0);
    expect(v.conf).toBe(0);
    expect(v.reasons.join(' ')).toContain('abstains');
  });

  it('a mild/coil tape abstains rather than voting noise (dir 0)', () => {
    const v = run({
      market: 'INDIA', symbol: 'X', ltp: 100,
      tape: { ltp: 100, ema10: 100, ema20: 100, rsi: 50, macdHist: 0, macdSlope: 0, vwap: 100, last3Pct: 0 },
    });
    expect(v.dir).toBe(0);
  });
});

// ============================================================
// 2. Counter-tape strength (mtfAnalysis) + gating (qualityVerdict)
// ============================================================
describe('v9.3 counter-tape strength + grade gating', () => {
  // daily downtrend (htf) + SHORT signal; ltf = the 15m tape
  const htfBearish = { ema20: 1296, ema50: 1304, rsi: 37 };

  it('MISALIGNED + a DRIVING tape (RSI momentum zone + MACD against the trade) → strength 1', () => {
    const m = mtfAnalysis({ htf: htfBearish, ltf: { ema20: 1253, ema50: 1248, rsi: 63, macdHist: 1.2 }, side: 'SHORT' });
    expect(m.phase).toBe('MISALIGNED');
    expect(m.aligned).toBe(false);
    expect(m.ltfDir).toBe(1);
    expect(m.againstTapeStrength).toBe(1);
  });

  it('MISALIGNED + a STALLING tape (RSI mid-zone) → strength 0 (reversal stays practiceable)', () => {
    const m = mtfAnalysis({ htf: htfBearish, ltf: { ema20: 1253, ema50: 1248, rsi: 51, macdHist: 0.1 }, side: 'SHORT' });
    expect(m.phase).toBe('MISALIGNED');
    expect(m.againstTapeStrength).toBe(0);
  });

  it('ALIGNED (daily and tape agree) → strength 0, no counter-tape flag', () => {
    const m = mtfAnalysis({ htf: htfBearish, ltf: { ema20: 1262, ema50: 1266, rsi: 36, macdHist: -1.5 }, side: 'SHORT' });
    expect(m.phase).toBe('ALIGNED');
    expect(m.aligned).toBe(true);
    expect(m.againstTapeStrength).toBe(0);
  });

  const goodVotes = [
    { id: 'trend', weight: 1.4, dir: -1, conf: 95, reasons: [] },
    { id: 'momentum', weight: 1.3, dir: -1, conf: 88, reasons: [] },
    { id: 'volume', weight: 1.2, dir: -1, conf: 80, reasons: [] },
    { id: 'sr', weight: 1.1, dir: -1, conf: 78, reasons: [] },
    { id: 'tape', weight: 1.3, dir: 1, conf: 75, reasons: [] },
  ];

  it('qualityVerdict: STRONG counter-tape → gradeCap WATCH + counter-tape veto flag', () => {
    const qv = qualityVerdict({
      market: 'INDIA', side: 'SHORT', consensus: { side: 'SHORT' }, votes: goodVotes,
      ltp: 1258, changePct: -1.2, rsi: 37, adx: 25,
      htf: htfBearish, ltf: { ema20: 1253, ema50: 1248, rsi: 63, macdHist: 1.2 },
      ltfLabel: '15m', now: MID_SESSION,
    });
    expect(qv.mtf.phase).toBe('MISALIGNED');
    expect(qv.mtf.againstTapeStrength).toBe(1);
    expect(qv.flags.counterTape).toEqual({ strong: true, ltfDir: 1 });
    expect(qv.gradeCap).toBe('WATCH');
    expect(qv.flags.veto).toBe('counter-tape');
    // the reason must say it out loud (the user reads this on the card)
    expect(qv.reasons.join(' ')).toContain('COUNTER-TAPE');
    // conf penalty stacks: -12 (misaligned) -6 (driving tape) = -18
    expect(qv.confAdj).toBeLessThanOrEqual(-18);
  });

  it('qualityVerdict: mild counter-tape (stalling) → gradeCap ACTION, no veto', () => {
    const qv = qualityVerdict({
      market: 'INDIA', side: 'SHORT', consensus: { side: 'SHORT' }, votes: goodVotes,
      ltp: 1258, changePct: -1.2, rsi: 37, adx: 25,
      htf: htfBearish, ltf: { ema20: 1253, ema50: 1248, rsi: 51, macdHist: 0.05 },
      ltfLabel: '15m', now: MID_SESSION,
    });
    expect(qv.mtf.phase).toBe('MISALIGNED');
    expect(qv.gradeCap).toBe('ACTION');
    expect(qv.flags.veto).toBeFalsy();
  });

  it('qualityVerdict: tape-ALIGNED short → gradeCap stays STRONG (no false-positive gating)', () => {
    const qv = qualityVerdict({
      market: 'INDIA', side: 'SHORT', consensus: { side: 'SHORT' },
      votes: goodVotes.map(v => v.id === 'tape' ? { ...v, dir: -1 } : v),
      ltp: 1258, changePct: -1.2, rsi: 37, adx: 25,
      htf: htfBearish, ltf: { ema20: 1262, ema50: 1266, rsi: 36, macdHist: -1.5 },
      ltfLabel: '15m', now: MID_SESSION,
    });
    expect(qv.mtf.phase).toBe('ALIGNED');
    expect(qv.gradeCap).toBe('STRONG');
    expect(qv.flags.counterTape).toBeUndefined();
  });

  it('the tape vote materially moves the ensemble (a rising tape vote must cut SHORT conviction)', () => {
    const base = goodVotes.slice(0, 4); // daily-only committee
    const withTape = [...base, goodVotes[4]]; // + the rising 15m tape vote
    const confDailyOnly = aggregateVotes(base).confidence;
    const confWithTape = aggregateVotes(withTape).confidence;
    expect(confWithTape).toBeLessThan(confDailyOnly);
  });
});

// ============================================================
// 3. THE BOARD REGRESSION — the exact screenshot bug, end-to-end
// (clock pinned to mid-session: the 15:15 IST no-new-entries cap must
// not leak into these assertions)
// ============================================================
describe('v9.3 board — bearish daily + rising 15m tape (THE screenshot bug)', () => {
  beforeAll(() => { vi.useFakeTimers(); vi.setSystemTime(MID_SESSION); });
  afterAll(() => { vi.useRealTimers(); });

  it('can NEVER badge STRONG SHORT while the tape is climbing', async () => {
    tapeSeries = risingTapeCandles();
    const board = await getSignals('INDIA', {}, { limit: 10, noCache: true });
    expect(board.ok).toBe(true);
    const sig = board.signals.find(s => s.symbol === 'RELIANCE');
    expect(sig).toBeTruthy();
    // The tape vote must be IN the committee's published votes
    const tapeVote = (sig.votes || []).find(v => v.id === 'tape');
    expect(tapeVote).toBeTruthy();
    expect(tapeVote.dir).toBe(1); // the 15m tape voted LONG against the daily SHORTs
    // The exact bug assertion: NOT a STRONG SHORT anymore
    expect(sig.side).not.toBe('STRONG');
    if (sig.side === 'SHORT') {
      expect(sig.grade).not.toBe('STRONG');
      expect(sig.quality?.mtf?.phase).toBe('MISALIGNED');
      expect(sig.quality?.counterTape?.strong).toBe(true);
    }
    // honest reason on the payload
    expect((sig.quality?.reasons || []).join(' ')).toContain('COUNTER-TAPE');
  }, 30_000);

  it('the SAME daily data with a CONFIRMING 15m tape still earns STRONG/ACTION SHORT (desk stays alive)', async () => {
    tapeSeries = fallingWithPullbacks(); // realistic bearish tape (RSI ~41 — not oversold)
    const board = await getSignals('INDIA', {}, { limit: 10, noCache: true });
    expect(board.ok).toBe(true);
    const sig = board.signals.find(s => s.symbol === 'RELIANCE');
    expect(sig).toBeTruthy();
    expect(sig.side).toBe('SHORT'); // daily + tape both bearish
    expect(['STRONG', 'ACTION']).toContain(sig.grade);
    expect(sig.quality?.mtf?.phase).toBe('ALIGNED');
    expect(sig.quality?.counterTape).toBeUndefined();
    const tapeVote = (sig.votes || []).find(v => v.id === 'tape');
    expect(tapeVote?.dir).toBe(-1);
  }, 30_000);

  // v12.4 SIGNAL TRUST GUARD — the OB/OS lock: a MONOTONIC decline (RSI
  // pinned at ~0, deeply oversold) is a chase zone, not an entry zone.
  // The SHORT card still SHOWS (honest — side, tape vote, alignment all
  // intact) but it can never wear ACTION/STRONG, and the suppression is
  // stamped on the payload (obOs) so the card can say WHY.
  it('v12.4 OVERSOLD guard: a deeply-oversold confirming tape caps the SHORT to WATCH + stamps obOs', async () => {
    tapeSeries = fallingTapeCandles(); // monotonic → LTF RSI ≈ 0
    const board = await getSignals('INDIA', {}, { limit: 10, noCache: true });
    expect(board.ok).toBe(true);
    const sig = board.signals.find(s => s.symbol === 'RELIANCE');
    expect(sig).toBeTruthy();
    expect(sig.side).toBe('SHORT'); // the view itself is untouched
    const tapeVote = (sig.votes || []).find(v => v.id === 'tape');
    expect(tapeVote?.dir).toBe(-1); // the tape still voted bearish
    expect(sig.grade).toBe('WATCH'); // ...but the badge is disciplined
    expect(sig.obOs).toMatchObject({ tag: 'OVERSOLD' });
    expect(sig.obOs?.rsi).toBeLessThanOrEqual(30);
    // the age payload rides every directional card now
    expect(sig.signalAge).toBeTruthy();
    expect(sig.signalAge?.firstSeenAt).toBeGreaterThan(0);
  }, 30_000);

  it('board cut + re-rank: signals length never exceeds the limit', async () => {
    tapeSeries = risingTapeCandles();
    const board = await getSignals('INDIA', {}, { limit: 3, noCache: true });
    expect(board.signals.length).toBeLessThanOrEqual(3);
  }, 30_000);
});
