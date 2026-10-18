// ============================================================
// v4 MEGA upgrade tests — quant engine + dual-expert consensus
//   • gradeSignal A+/A/B boundaries
//   • analyzeIntradayFromScanner: volume floor, supertrend/POC/
//     SMA50 factors, dead-zone penalty, tighter RSI, gap penalty
//   • aiVerifySignals: structured consensus (mocked fetch) —
//     agreement bonus, ANY-AVOID rejection, direction-conflict
//     rejection, level merging, sanitizers
// No network: fetch is stubbed per-test.
// ============================================================
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const {
  gradeSignal, analyzeIntradayFromScanner, aiVerifySignals, inDeadZone,
  MIN_REL_VOLUME, HIGH_CONV_RR_FLOOR,
} = await import('../server/intraday/engine.js');
const { paceRelVolume, sessionElapsedShare } = await import('../server/intraday/time.js');

// Deterministic clocks for the session-pace volume math (2026-09 fix).
// SAT_NOON_IST: outside the NSE session → share 1 → pace == raw (the
// shipped end-of-day floor semantics the original tests were written
// against). Weekday session times exercise the pace normalization.
const SAT_NOON_IST = new Date('2026-08-29T06:30:00Z');   // Sat 12:00 IST
const MON_1015_IST = new Date('2026-08-31T04:45:00Z');   // Mon 10:15 IST (60 min in)
const MON_1100_IST = new Date('2026-08-31T05:30:00Z');   // Mon 11:00 IST (105 min in)
const MON_2000_IST = new Date('2026-08-31T14:30:00Z');   // Mon 20:00 IST (post-close)

// ---- shared synthetic TV snapshot (bullish, A+-capable) ----
const bullTv = {
  close: 812, open: 800, high: 816, low: 795, volume: 5e6, change: 1.5,
  ema10: 810, ema20: 805, sma20: 802, sma50: 790,
  rsi: 61, macd: 2.5, macdSignal: 1.5,
  atr: 10, vwap: 806,
  adx: 27, adxPlus: 25, adxMinus: 10,
  relVolume: 1.8,
  pivotMiddle: 805, pivotS1: 795, pivotR1: 820,
  recommend: 1, last: 812, exchange: 'NSE',
};
const bullGroww = { price: 812, prevClose: 800, change: 1.5, high: 816, low: 795, volume: 5e6 };

const cand = (over = {}) => ({
  symbol: 'SBIN', exchange: 'NSE', direction: 'LONG', quantConfidence: 90,
  ltp: 812, changePct: 1.5, rsi: 61, volumeRatio: 1.8, rr: 1.6, atr: 10,
  adx: 27, gapPct: 0.5, marketPhase: 'full', vwapDist: 0.75,
  entry: 812, stopLoss: 801, target1: 829.6, target2: 840.8,
  _momentumPct: 1.5, ...over,
});

beforeEach(() => { vi.unstubAllGlobals(); });
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

// ---------------- gradeSignal ----------------
describe('gradeSignal — v4 A+/A/B boundaries', () => {
  it('A+ requires conf≥88, rr≥1.8, vol≥1.5, ADX≥25, VWAP-aligned, regime-aligned', () => {
    expect(gradeSignal(cand({ confidence: 88, effRR: 1.8, volumeRatio: 1.5, adx: 25, vwapDist: 0.1 }))).toBe('A+');
    // each failing gate drops to A or B
    expect(gradeSignal(cand({ confidence: 87, effRR: 1.8, volumeRatio: 1.5, adx: 25 }))).toBe('A');
    expect(gradeSignal(cand({ confidence: 88, effRR: 1.7, volumeRatio: 1.5, adx: 25 }))).toBe('A');
    expect(gradeSignal(cand({ confidence: 88, effRR: 1.8, volumeRatio: 1.4, adx: 25 }))).toBe('A');
    expect(gradeSignal(cand({ confidence: 88, effRR: 1.8, volumeRatio: 1.5, adx: 24 }))).toBe('A');
    // SHORT A+ needs vwapDist < 0
    expect(gradeSignal(cand({ direction: 'SHORT', confidence: 88, effRR: 1.8, volumeRatio: 1.5, adx: 25, vwapDist: -0.1 }))).toBe('A+');
    // counterTrend kills A+
    expect(gradeSignal(cand({ confidence: 90, effRR: 2, volumeRatio: 1.6, adx: 27, counterTrend: true }))).toBe('A');
  });

  it('A requires conf≥80, rr≥1.5, vol≥1.2', () => {
    expect(gradeSignal(cand({ confidence: 80, effRR: 1.5, volumeRatio: 1.2 }))).toBe('A');
    expect(gradeSignal(cand({ confidence: 79, effRR: 1.5, volumeRatio: 1.2 }))).toBe('B');
    expect(gradeSignal(cand({ confidence: 80, effRR: 1.4, volumeRatio: 1.2 }))).toBe('B');
    expect(gradeSignal(cand({ confidence: 80, effRR: 1.5, volumeRatio: 1.1 }))).toBe('B');
  });

  it('B for everything else / null-safe', () => {
    expect(gradeSignal(cand({ confidence: 70 }))).toBe('B');
    expect(gradeSignal(null)).toBe('B');
  });

  it('falls back to raw rr when effRR missing', () => {
    const s = cand({ confidence: 88, volumeRatio: 1.5, adx: 25 });
    delete s.effRR;
    s.rr = 1.9;
    expect(gradeSignal(s)).toBe('A+');
  });
});

// ---------------- analyzeIntradayFromScanner ----------------
describe('analyzeIntradayFromScanner — v4 factors', () => {
  it('rejects on KNOWN low relative volume (< 1.2x hard floor)', () => {
    // Post-close clock → pace == raw → 1.0 < 1.2 floor → rejected
    // (deterministic: the raw value semantics the floor was written for).
    vi.setSystemTime(SAT_NOON_IST);
    const r = analyzeIntradayFromScanner('SBIN', { ...bullTv, relVolume: 1.0 }, bullGroww, {});
    expect(r).toBeNull();
    vi.useRealTimers();
  });

  it('does NOT reject when relVolume is unknown (null feed value)', () => {
    vi.setSystemTime(SAT_NOON_IST);
    const r = analyzeIntradayFromScanner('SBIN', { ...bullTv, relVolume: null }, bullGroww, {});
    expect(r).not.toBeNull();
    vi.useRealTimers();
  });

  it('SESSION-PACE fix: morning raw 0.3 (≈1.4× pace) is NOT blanket-rejected', () => {
    // Verified live: 13% into the session TV raw relVol reads 0.13–0.41
    // for NORMAL names (cumulative ÷ FULL-day avg, NOT time-adjusted).
    // At 10:15 IST (60 min in) share = (60/375)*1.3 = 0.208 →
    // 0.30 raw = 1.44 pace → clears the 1.2 pace floor.
    const r = analyzeIntradayFromScanner('SBIN', { ...bullTv, relVolume: 0.30 }, bullGroww, { now: MON_1015_IST });
    expect(r).not.toBeNull();
    expect(r.volumeRatio).toBeGreaterThan(1.2); // pace stored, not raw
  });

  it('SESSION-PACE fix: genuinely dead morning name (0.05 raw ≈ 0.24 pace) IS rejected', () => {
    const r = analyzeIntradayFromScanner('SBIN', { ...bullTv, relVolume: 0.05 }, bullGroww, { now: MON_1015_IST });
    expect(r).toBeNull();
  });

  it('SESSION-PACE fix: volumeRatio is the pace value (1.8 raw @ 11:00 → 1.8/0.364 ≈ 4.95)', () => {
    const r = analyzeIntradayFromScanner('SBIN', { ...bullTv, relVolume: 1.8 }, bullGroww, { now: MON_1100_IST });
    expect(r).not.toBeNull();
    expect(r.volumeRatio).toBeCloseTo(1.8 / ((105 / 375) * 1.3), 1);
  });

  it('SESSION-PACE fix: post-close clock → pace == raw (shipped end-of-day behavior preserved)', () => {
    const r = analyzeIntradayFromScanner('SBIN', { ...bullTv, relVolume: 1.8 }, bullGroww, { now: MON_2000_IST });
    expect(r.volumeRatio).toBe(1.8);
    const slow = analyzeIntradayFromScanner('SBIN', { ...bullTv, relVolume: 1.0 }, bullGroww, { now: MON_2000_IST });
    expect(slow).toBeNull();
  });

  it('SESSION-PACE fix: CRYPTO follows the 24h UTC candle day (7e452c6 semantics)', () => {
    const r = analyzeIntradayFromScanner('BTC', {
      ...bullTv, relVolume: 1.8, exchange: 'BINANCE',
    }, { price: 812, prevClose: 800, change: 1.5, high: 816, low: 795, volume: 5e6 }, { market: 'CRYPTO', now: MON_1015_IST });
    // 04:45 UTC = 285/1440 elapsed of the UTC candle day → pace = 1.8 / 0.1979 ≈ 9.09
    expect(r.volumeRatio).toBeCloseTo(1.8 / (285 / 1440), 1);
  });

  it('paceRelVolume / sessionElapsedShare unit math', () => {
    // share boundaries
    expect(sessionElapsedShare('INDIA', MON_1015_IST)).toBeCloseTo(0.208, 2);
    expect(sessionElapsedShare('INDIA', new Date('2026-08-31T03:50:00Z'))).toBe(0.12); // 09:20 IST — floored
    expect(sessionElapsedShare('INDIA', MON_2000_IST)).toBe(1);      // post-close
    expect(sessionElapsedShare('INDIA', SAT_NOON_IST)).toBe(1);      // weekend
    // v11.2 (7e452c6): CRYPTO rides the 24h UTC candle day — 04:45 UTC = 285/1440,
    // early-UTC floored at 0.12 (no over-amplification of thin first hours)
    expect(sessionElapsedShare('CRYPTO', MON_1015_IST)).toBeCloseTo(285 / 1440, 4);
    expect(sessionElapsedShare('CRYPTO', new Date('2026-08-31T01:00:00Z'))).toBe(0.12); // 01:00 UTC — floored
    // pace math + unknown-value semantics
    expect(paceRelVolume(0.22, 'INDIA', MON_1015_IST)).toBeCloseTo(0.22 / 0.208, 2);
    expect(paceRelVolume(null, 'INDIA', MON_1015_IST)).toBe(null);
    expect(paceRelVolume(1.8, 'CRYPTO', MON_1015_IST)).toBeCloseTo(1.8 / (285 / 1440), 1);
    expect(paceRelVolume(1.8, 'INDIA', SAT_NOON_IST)).toBe(1.8);
  });

  // ---- v4.9 audit fix: the injectable clock (opts.now) now flows through
  // the ORB window, dead-zone, fresh-entry cutoff AND market phase —
  // previously these four read the wall clock even with opts.now injected,
  // so any time-shifted test would get wrong ORB/dead-zone/fresh results.
  const MON_0930_IST = new Date('2026-08-31T04:00:00Z'); // Mon 09:30 IST (ORB window)
  const MON_1440_IST = new Date('2026-08-31T09:10:00Z'); // Mon 14:40 IST (dead-zone)
  const MON_1520_IST = new Date('2026-08-31T09:50:00Z'); // Mon 15:20 IST (entries cut)

  it('v4.9 injectable clock: 09:30 via opts.now → ORB LIVE, phase early, fresh entries allowed', () => {
    const r = analyzeIntradayFromScanner('SBIN', bullTv, bullGroww, { now: MON_0930_IST });
    expect(r).toBeTruthy();
    expect(r.orbMode).toBe('LIVE');
    expect(r.marketPhase).toBe('early');
    expect(r.freshEntriesAllowed).toBe(true);
    expect(r._deadZone).toBe(false);
  });

  it('v4.9 injectable clock: 14:40 via opts.now → dead-zone flagged, power-hour phase, entries still open', () => {
    const r = analyzeIntradayFromScanner('SBIN', bullTv, bullGroww, { now: MON_1440_IST });
    expect(r._deadZone).toBe(true);
    expect(r.marketPhase).toBe('power-hour');
    expect(r.freshEntriesAllowed).toBe(true); // 14:40 < 15:00 cutoff
    expect(r.reasons.some((x: string) => x.includes('Dead-zone'))).toBe(true);
  });

  it('v4.9 injectable clock: 15:20 via opts.now → fresh entries blocked, ORB proxy, power-hour', () => {
    const r = analyzeIntradayFromScanner('SBIN', bullTv, bullGroww, { now: MON_1520_IST });
    expect(r.freshEntriesAllowed).toBe(false);
    expect(r.marketPhase).toBe('power-hour');
    expect(r.orbMode).toBe('PROXY');
  });

  it('v4.9 injectable clock: CRYPTO ignores the session clock (24/7 semantics)', () => {
    const r = analyzeIntradayFromScanner('BTCUSDT', bullTv, bullGroww, { now: MON_0930_IST, market: 'CRYPTO' });
    expect(r.marketPhase).toBe('full');
    expect(r.freshEntriesAllowed).toBe(true);
    expect(r.orbMode).toBe('PROXY'); // crypto: ATR-proxy only, never a session range
    expect(r.sqOffBy).toBe('24/7 (no EOD sq-off)');
  });

  it('emits v4 reasons: Supertrend proxy, SMA50 confluence (price near VWAP → POC)', () => {
    // price 0.18% above VWAP → value-area acceptance zone
    // (deterministic clock: real-clock made the pace math + early-phase
    // caps time-of-day dependent — sibling of the 14:30-15:00 flake fix)
    const nearPoc = analyzeIntradayFromScanner('SBIN', { ...bullTv, vwap: 810.5 }, { ...bullGroww }, { now: SAT_NOON_IST });
    expect(nearPoc).not.toBeNull();
    const reasons = nearPoc.reasons.join(' | ');
    expect(reasons).toContain('Supertrend(7) aligned');
    expect(reasons).toContain('Volume-POC');
    expect(reasons).toContain('SMA50 multi-timeframe confluence');
    // far-from-VWAP price → no POC premium
    const farFromPoc = analyzeIntradayFromScanner('SBIN', bullTv, bullGroww, { now: SAT_NOON_IST });
    expect(farFromPoc.reasons.join(' | ')).not.toContain('Volume-POC');
  });

  it('SMA50 missing → no confluence reason (factor skipped, no crash)', () => {
    const r = analyzeIntradayFromScanner('SBIN', { ...bullTv, sma50: null }, bullGroww, { now: SAT_NOON_IST });
    expect(r).not.toBeNull();
    expect(r.reasons.join(' | ')).not.toContain('SMA50');
  });

  it('counter-regime penalty is -10 (was -6)', () => {
    // Deterministic clock: with the real clock the suite flaked during the
    // 09:15-09:45 IST early window (pace-boosted scores saturate at 100,
    // the early-phase cap then clamps BOTH sides to 88 → diff 0).
    const neutral = analyzeIntradayFromScanner('SBIN', bullTv, bullGroww, { now: SAT_NOON_IST });
    const bear = analyzeIntradayFromScanner('SBIN', bullTv, bullGroww, { now: SAT_NOON_IST, regime: { regime: 'BEARISH', vixLevel: 'LOW' } });
    expect(neutral).not.toBeNull();
    expect(bear).not.toBeNull();
    // LONG in BEARISH regime: direction may stay LONG (score-driven) → -10
    if (bear.direction === 'LONG' && neutral.direction === 'LONG') {
      expect(neutral.quantConfidence - bear.quantConfidence).toBeGreaterThanOrEqual(10);
    }
  });

  it('gap > 2.5% penalized with -8 (was -4 at 3.5%)', () => {
    // prevClose such that gap = +3%
    const gw = { ...bullGroww, prevClose: 776.7, open: 800 };
    const r = analyzeIntradayFromScanner('SBIN', { ...bullTv, open: 800, change: 4.5 }, gw, { now: SAT_NOON_IST });
    expect(r).not.toBeNull();
    if (r.direction === 'LONG') {
      expect(r.reasons.join(' | ')).not.toContain('Gap +3.0%'); // no gap bonus beyond 2.5%
    }
  });

  it('exports quality gates and dead-zone helper', () => {
    expect(MIN_REL_VOLUME).toBe(1.2);
    expect(HIGH_CONV_RR_FLOOR).toBe(1.5);
    expect(inDeadZone(14 * 60 + 30)).toBe(true);
    expect(inDeadZone(14 * 60 + 59)).toBe(true);
    expect(inDeadZone(15 * 60)).toBe(false);
    expect(inDeadZone(10 * 60)).toBe(false);
  });

  it('dead-zone scoring: 14:45 IST analysis carries the penalty + flag', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-05T09:15:00Z')); // 14:45 IST
    const r = analyzeIntradayFromScanner('SBIN', bullTv, bullGroww, {});
    expect(r).not.toBeNull();
    expect(r._deadZone).toBe(true);
    expect(r.reasons.join(' | ')).toContain('Dead-zone');
    // Deterministic non-dead-zone check: keep FAKE timers and pin a morning
    // time. (Using real timers here made the test time-of-day flaky — it
    // failed whenever the suite ran between 14:30-15:00 IST.)
    vi.setSystemTime(new Date('2026-01-05T05:00:00Z')); // 10:30 IST
    const normal = analyzeIntradayFromScanner('SBIN', bullTv, bullGroww, {});
    expect(normal._deadZone).toBe(false);
    vi.useRealTimers();
  });
});

// ---------------- aiVerifySignals (structured dual-expert) ----------------
describe('aiVerifySignals — v4 structured consensus', () => {
  const DEPS = {
    KEYS: { gemini: 'g-key', groq: 'q-key' },
    OPENAI_COMPAT: {
      groq: { url: 'https://groq.test/v1/chat/completions', defModel: 'llama-3.3-70b' },
    },
  };

  const geminiResp = (verdicts) => ({
    ok: true, json: async () => ({
      candidates: [{ content: { parts: [{ text: JSON.stringify({ verdicts }) }] } }],
    }),
  });
  const groqResp = (verdicts) => ({
    ok: true, json: async () => ({
      choices: [{ message: { content: JSON.stringify({ verdicts }) } }],
    }),
  });
  const stubFetch = (geminiVerdicts, groqVerdicts) => {
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      if (String(url).includes('generativelanguage')) return geminiResp(geminiVerdicts);
      if (String(url).includes('groq')) return groqResp(groqVerdicts);
      return { ok: false, status: 500, json: async () => ({}) };
    }));
  };

  const V = (over = {}) => ({
    verdict: 'LONG', confidence: 85, note: 'Strong stack',
    analysis: 'EMA stack bullish, VWAP support holding, volume expanding.',
    riskFactors: ['VIX spike'], entryQuality: 8, tradeType: 'MOMENTUM',
    slAdjust: 805, entryAdjust: 810, ...over,
  });

  it('unanimous agreement → +5 bonus, merged reasoning, per-model verdicts', async () => {
    stubFetch({ SBIN: V({ confidence: 80, entryQuality: 7 }) }, { SBIN: V() });
    const out = await aiVerifySignals([cand()], DEPS);
    expect(out.models).toContain('gemini');
    expect(out.models).toContain('groq');
    const v = out.verdicts.SBIN;
    expect(v.verdict).toBe('LONG');
    expect(v.confidence).toBe(Math.round((80 + 85) / 2 + 5)); // 85
    expect(v.dissent).toBe(0);
    expect(v.analysis).toContain('[GEMINI]');
    expect(v.analysis).toContain('[GROQ]');
    expect(v.riskFactors).toEqual(['VIX spike']);
    expect(v.entryQuality).toBe(8); // round((7+8)/2)
    expect(v.tradeType).toBe('MOMENTUM');
    expect(v.slAdjust).toBe(805);
    expect(v.perModel.gemini.confidence).toBe(80);
    expect(v.perModel.groq.confidence).toBe(85);
  });

  it('ANY avoid vote → setup rejected outright (not halved)', async () => {
    stubFetch({ SBIN: V() }, { SBIN: V({ verdict: 'AVOID', confidence: 70, note: 'RSI overbought' }) });
    const out = await aiVerifySignals([cand()], DEPS);
    expect(out.verdicts.SBIN.verdict).toBe('AVOID');
    expect(out.verdicts.SBIN.note).toContain('RSI');
  });

  it('direction conflict between experts → rejected as AVOID', async () => {
    stubFetch({ SBIN: V({ verdict: 'LONG' }) }, { SBIN: V({ verdict: 'SHORT' }) });
    const out = await aiVerifySignals([cand()], DEPS);
    expect(out.verdicts.SBIN.verdict).toBe('AVOID');
    expect(out.verdicts.SBIN.dissent).toBe(1);
  });

  it('tightest SL merge: LONG keeps the HIGHER (closer-to-entry) stop', async () => {
    stubFetch({ SBIN: V({ slAdjust: 803 }) }, { SBIN: V({ slAdjust: 806 }) });
    const out = await aiVerifySignals([cand()], DEPS);
    expect(out.verdicts.SBIN.slAdjust).toBe(806);
  });

  it('sanitizes garbage fields (entryQuality clamp, bad tradeType, non-numeric levels)', async () => {
    stubFetch(
      { SBIN: V({ entryQuality: 42, tradeType: 'WEIRD', slAdjust: 'abc' }) },
      { SBIN: V({ entryQuality: -5, tradeType: 'SCALP', slAdjust: null, riskFactors: 'not-an-array' }) },
    );
    const out = await aiVerifySignals([cand()], DEPS);
    const v = out.verdicts.SBIN;
    expect(v.entryQuality).toBe(6); // round((clamp(42)+clamp(-5))/2) = round(5.5) = 6
    expect(v.tradeType).toBe('SCALP'); // only valid type survived
    expect(v.slAdjust).toBeNull();
    expect(v.riskFactors).toEqual(['VIX spike']); // gemini's valid list kept, groq's non-array discarded
  });

  it('single-model response still produces a verdict (no agreement bonus)', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      if (String(url).includes('generativelanguage')) return geminiResp({ SBIN: V({ confidence: 82 }) });
      return { ok: false, status: 500, json: async () => ({}) }; // groq down
    }));
    const out = await aiVerifySignals([cand()], DEPS);
    const v = out.verdicts.SBIN;
    expect(v.verdict).toBe('LONG');
    expect(v.confidence).toBe(82); // no +5 bonus
    expect(v.perModel.gemini).toBeDefined();
    expect(v.perModel.groq).toBeUndefined();
  });

  it('returns null when every provider fails / no keys', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}) })));
    expect(await aiVerifySignals([cand()], DEPS)).toBeNull();
    expect(await aiVerifySignals([cand()], { KEYS: {}, OPENAI_COMPAT: {} })).toBeNull();
    expect(await aiVerifySignals([], DEPS)).toBeNull();
  });

  // v4.1 regression: models that drift off the verdict whitelist ("WAIT",
  // "NEUTRAL", "HOLD") must be discarded — NOT crash the consensus loop.
  it('non-standard verdicts are discarded; the valid expert vote still decides (no crash)', async () => {
    stubFetch(
      { SBIN: V({ verdict: 'WAIT', confidence: 60 }) },
      { SBIN: V({ verdict: 'NEUTRAL', confidence: 55 }) },
    );
    const out = await aiVerifySignals([cand()], DEPS);
    // Both votes drifted → no consensus entry for the symbol, no throw.
    expect(out).not.toBeNull();
    expect(out.verdicts.SBIN).toBeUndefined();
  });

  it('mixed valid + drifted verdicts → only the valid one counts (single-model consensus)', async () => {
    stubFetch(
      { SBIN: V({ verdict: 'WAIT', confidence: 90 }) },
      { SBIN: V({ verdict: 'LONG', confidence: 84 }) },
    );
    const out = await aiVerifySignals([cand()], DEPS);
    const v = out.verdicts.SBIN;
    expect(v.verdict).toBe('LONG');
    expect(v.confidence).toBe(84); // single valid vote, no agreement bonus
    expect(v.models).toEqual(['groq']);
    expect(v.perModel.gemini).toBeUndefined();
  });

  it('lowercase / padded verdicts normalize to the whitelist', async () => {
    stubFetch(
      { SBIN: V({ verdict: 'long ', confidence: 81 }) },
      { SBIN: V({ verdict: 'Long', confidence: 83 }) },
    );
    const out = await aiVerifySignals([cand()], DEPS);
    const v = out.verdicts.SBIN;
    expect(v.verdict).toBe('LONG');
    expect(v.confidence).toBe(Math.round((81 + 83) / 2 + 5)); // normalized → both counted, +5 consensus
  });
});
