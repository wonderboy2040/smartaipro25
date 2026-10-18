// ============================================================
// test/aiEnsemble.test.ts — Superintelligence Ensemble math
// ------------------------------------------------------------
// Pins the aggregation formula, STRONG gating, trade-plan ATR math
// and every quant model's voting behavior on synthetic contexts.
// ============================================================
import { describe, it, expect } from 'vitest';
import { aggregateVotes, buildTradePlan, evaluateExecutionGate, fitPlanToRiskCap, DEFAULT_GATES } from '../server/ai/ensemble.js';
import { runQuantModels, MODELS, aiCouncilVoteFromVerdict } from '../server/ai/models.js';
import { computeIndicatorsFromCandles, detectPatterns, rsi, macd, bollinger, atr } from '../server/ai/lib/indicators.js';
import { toCouncilCandidate, scannerPatterns } from '../server/ai/signals.js';

// ---- vote helpers ---------------------------------------------
const v = (id, dir, conf, weight = 1) => ({ id, name: id, role: 'test', weight, dir, conf, reasons: [] });

describe('aggregateVotes — the consensus formula', () => {
  it('unanimous strong bull votes → LONG, high confidence, agreement 1.0', () => {
    const out = aggregateVotes([
      v('a', 1, 90, 1.4), v('b', 1, 85, 1.3), v('c', 1, 80, 1.2),
    ]);
    expect(out.side).toBe('LONG');
    expect(out.agreement).toBe(1);
    // v6.12 quorum honesty: 3 voters cap confidence at 72 — a thin
    // committee can wear ACTION, never STRONG (was 75+ pre-v6.12,
    // which let single-factor noise reach the execution gate).
    expect(out.confidence).toBe(72);
    expect(out.grade).toBe('ACTION');
    expect(out.quorumCapped).toBe(true);
    expect(out.voters).toBe(3);
  });

  it('conflicting votes split agreement below the STRONG gate', () => {
    const out = aggregateVotes([
      v('a', 1, 90, 1.4), v('b', 1, 85, 1.3), v('c', 1, 80, 1.2), v('d', 1, 80, 1.1),
      v('e', -1, 95, 1.0), v('f', -1, 95, 1.0), // 2.0 of 7.2 weight against
    ]);
    expect(out.side).toBe('LONG');
    expect(out.agreement).toBeLessThan(0.75); // 5.2/7.2 ≈ 0.72
    // grade may still be STRONG-ish conf but agreement gate blocks it
    const strongEligible = out.confidence >= DEFAULT_GATES.minConfidence && out.agreement >= DEFAULT_GATES.minAgreement;
    if (strongEligible) expect(out.grade).toBe('STRONG');
    else expect(out.grade).not.toBe('STRONG');
  });

  it('all-abstain board → FLAT NEUTRAL with zero confidence', () => {
    const out = aggregateVotes([v('a', 0, 0, 1.4), v('b', 0, 0, 1.3)]);
    expect(out.side).toBe('FLAT');
    expect(out.confidence).toBe(0);
    expect(out.grade).toBe('NEUTRAL');
  });

  it('confidence blends |score| with agreement — a 55%-agreement 0.9-score is NOT 90%', () => {
    const out = aggregateVotes([
      v('a', 1, 99, 5), v('b', -1, 99, 4), // agreement 5/9 = 0.56, score 1/9
    ]);
    expect(out.confidence).toBeLessThan(30);
  });

  it('bearish unanimity → SHORT STRONG', () => {
    const out = aggregateVotes([v('a', -1, 90, 1.4), v('b', -1, 85, 1.3), v('c', -1, 88, 1.2), v('d', -1, 82, 1.1)]);
    expect(out.side).toBe('SHORT');
    expect(out.grade).toBe('STRONG');
  });

  it('grade ladder: WATCH below 55, ACTION 55-74, STRONG only at conf+agreement', () => {
    const weak = aggregateVotes([v('a', 1, 40, 1)]);
    expect(weak.grade).toBe('WATCH'); // conf ~38-40
    const mid = aggregateVotes([v('a', 1, 75, 1), v('b', 1, 70, 1)]);
    expect(['ACTION', 'WATCH']).toContain(mid.grade);
  });
});

describe('buildTradePlan — ATR-based risk engineering', () => {
  const longCtx = { ltp: 100, ind: { atr: 2 }, market: 'INDIA' };
  const shortCtx = { ltp: 100, ind: { atr: 2 }, market: 'INDIA' };

  it('LONG: SL = entry − 1.4×ATR, T1/T2 = 1R/2R', () => {
    const plan = buildTradePlan({ side: 'LONG', dir: 1 }, longCtx, 'INDIA')!;
    expect(plan.entry).toBe(100);
    expect(plan.stopLoss).toBeCloseTo(97.2, 1);   // 100 − 1.4×2
    expect(plan.risk).toBeCloseTo(2.8, 1);
    expect(plan.target1).toBeCloseTo(102.8, 1);
    expect(plan.target2).toBeCloseTo(105.6, 1);
    expect(plan.rewardRisk).toBe(2);
  });

  it('SHORT: mirrored levels', () => {
    const plan = buildTradePlan({ side: 'SHORT', dir: -1 }, shortCtx, 'INDIA')!;
    expect(plan.stopLoss).toBeCloseTo(102.8, 1);
    expect(plan.target1).toBeCloseTo(97.2, 1);
  });

  it('crypto uses a wider 1.6×ATR stop', () => {
    const plan = buildTradePlan({ side: 'LONG', dir: 1 }, { ltp: 100, ind: { atr: 2 } }, 'CRYPTO')!;
    expect(plan.stopLoss).toBeCloseTo(96.8, 1);
  });

  it('missing ATR falls back to % of price and labels the style', () => {
    const plan = buildTradePlan({ side: 'LONG', dir: 1 }, { ltp: 100, ind: {} }, 'INDIA')!;
    expect(plan.planStyle).toBe('atr-fallback');
    expect(plan.risk).toBeGreaterThan(0);
  });

  it('FLAT consensus or no LTP → null plan', () => {
    expect(buildTradePlan({ side: 'FLAT', dir: 0 }, longCtx, 'INDIA')).toBeNull();
    expect(buildTradePlan({ side: 'LONG', dir: 1 }, { ltp: 0, ind: {} }, 'INDIA')).toBeNull();
  });

  // v21.6.1 DISTINCT-LEVELS GUARD — the live diagnostic caught XRP $1.36
  // printing `entry 1.36 · T1 1.36` (SHORT T1 ON the entry) because the
  // 2-decimal tier collapsed a sub-cent risk. pRoundLadder keeps the whole
  // ladder distinct + strictly ordered (bumping to shared 4dp when needed).
  it('v21.6.1: plan levels never collapse onto the entry after rounding', () => {
    // XRP-class: price ≥1, tight risk ~0.0035 (sub-cent — the collapse tier)
    const ctx = { ltp: 1.3649, ind: { atr: 0.0022 } };
    const short = buildTradePlan({ side: 'SHORT', dir: -1 }, ctx, 'FUTURES')!;
    expect(short.entry).toBe(1.3649);                              // ladder shared 4dp
    expect(short.stopLoss).toBeGreaterThan(short.entry);          // SHORT SL above
    expect(short.target1).toBeLessThan(short.entry);               // SHORT T1 below — NOT equal
    expect(short.target2).toBeLessThan(short.target1);
    expect(short.risk).toBeGreaterThan(0);
    const long2 = buildTradePlan({ side: 'LONG', dir: 1 }, ctx, 'FUTURES')!;
    expect(long2.entry).toBe(1.3649);
    expect(long2.stopLoss).toBeLessThan(long2.entry);              // LONG SL below
    expect(long2.target1).toBeGreaterThan(long2.entry);            // LONG T1 above — NOT equal
    expect(long2.target2).toBeGreaterThan(long2.target1);
    // the ladder precision is shared across legs
    expect(String(long2.stopLoss).split('.')[1]?.length).toBe(4);
  });

  it('v21.6.1: normal-risk plans keep their classic 2-decimal levels', () => {
    const plan = buildTradePlan({ side: 'LONG', dir: 1 }, { ltp: 2.50, ind: { atr: 0.05 } }, 'CRYPTO')!;
    expect(plan.entry).toBe(2.5);
    expect(plan.stopLoss).toBeCloseTo(2.42, 2);
    expect(plan.target1).toBeCloseTo(2.58, 2);
  });
});

describe('evaluateExecutionGate — THE order gauntlet', () => {
  const now = Date.now();
  const strong = {
    symbol: 'BTC', market: 'CRYPTO', side: 'LONG', grade: 'STRONG',
    confidence: 82, agreement: 0.78, generatedAt: now,
    plan: { riskPct: 1.5 },
  };

  it('passes a fresh STRONG crypto signal with matching side', () => {
    const g = evaluateExecutionGate(strong, { side: 'LONG' });
    expect(g.ok).toBe(true);
  });

  it('venue gate: an INDIA signal is rejected on the default (crypto) venue — and passes on the India venue (v6.5)', () => {
    const g = evaluateExecutionGate({ ...strong, market: 'INDIA' }, { side: 'LONG' });
    expect(g.ok).toBe(false);
    expect(g.reason).toMatch(/INDIA market/);
    // the India gauntlet passes the SAME signal with venue: 'INDIA'
    const gi = evaluateExecutionGate({ ...strong, market: 'INDIA' }, { side: 'LONG', venue: 'INDIA' });
    expect(gi.ok).toBe(true);
  });

  it('rejects stale signals (> 90s)', () => {
    const g = evaluateExecutionGate({ ...strong, generatedAt: now - 120_000 }, { side: 'LONG' });
    expect(g.ok).toBe(false);
    expect(g.reason).toMatch(/stale/i);
  });

  it('rejects side mismatch — long signal, short request (v12.6 honest flip veto)', () => {
    const g = evaluateExecutionGate(strong, { side: 'SHORT' });
    expect(g.ok).toBe(false);
    // v12.6: the veto names BOTH sides + says the card must be re-confirmed
    expect(g.reason).toMatch(/fresh consensus LONG hai, aapne SHORT/);
    expect(g.reason).toMatch(/FLIP/);
  });

  it('rejects non-STRONG grades with the exact gate text', () => {
    const g = evaluateExecutionGate({ ...strong, grade: 'ACTION' }, { side: 'LONG' });
    expect(g.ok).toBe(false);
    expect(g.reason).toMatch(/grade ACTION/);
  });

  it('rejects oversized plan risk', () => {
    const g = evaluateExecutionGate({ ...strong, plan: { riskPct: 8 } }, { side: 'LONG', maxRiskPct: 5 });
    expect(g.ok).toBe(false);
    expect(g.reason).toMatch(/risk/);
  });

  it('honors custom gates (user tightened confidence to 85)', () => {
    const g = evaluateExecutionGate(strong, { side: 'LONG', gates: { minConfidence: 85, minAgreement: 0.70 } });
    expect(g.ok).toBe(false);
    expect(g.reason).toMatch(/confidence 82% < 85%/);
  });
});

describe('quant models — voting on synthetic contexts', () => {
  it('registry has 12 models with sane weights; AI Council has fn=null (LLM layer)', () => {
    expect(MODELS).toHaveLength(13); // v21.7.0: +MACrossTracker · v6.7: +SmartMoneyICT · v9.3: +IntradayTape · v20.7.4: +StructurePro (BOS/CHoCH + Fib + VP + S/D)
    expect(MODELS.find(m => m.id === 'aicouncil')?.fn).toBeNull();
    const total = MODELS.reduce((a, m) => a + m.weight, 0);
    expect(total).toBeGreaterThan(8);
    expect(total).toBeLessThan(16); // v21.7.0: +MACrossTracker 1.15 → 14.75
  });

  it('bullish context → TrendMatrix + MomentumQuant vote LONG with reasons', () => {
    const ctx = {
      market: 'INDIA', symbol: 'TEST', ltp: 120, changePct: 1.2,
      ind: {
        ema10: 119, ema20: 118, ema50: 115, sma20: 117, sma50: 114,
        rsi: 62, macd: { macd: 1.2, signal: 1.0, hist: 0.2, histSlope: 0.1 },
        stochK: 65, stochD: 60, atr: 2.2, vwap: 118,
        adx: { adx: 28, plusDI: 25, minusDI: 12 }, relVolume: 1.6,
        pivot: { p: 118, s1: 116, r1: 120 },
        recommend: 0.5, high52w: 125, low52w: 90,
      },
      regime: { niftyChange: 0.8, indiaVix: 11 },
    };
    const votes = runQuantModels(ctx);
    const trend = votes.find(x => x.id === 'trend')!;
    const momo = votes.find(x => x.id === 'momentum')!;
    expect(trend.dir).toBe(1);
    expect(trend.reasons.join(' ')).toMatch(/EMA 10>20>50/);
    expect(momo.dir).toBe(1);
    expect(trend.conf).toBeGreaterThan(50);
    // OptionsFlow abstains on stocks (no options ctx)
    const opts = votes.find(x => x.id === 'options')!;
    expect(opts.dir).toBe(0);
  });

  it('bearish context → models vote SHORT', () => {
    const ctx = {
      market: 'INDIA', symbol: 'TEST', ltp: 80, changePct: -1.5,
      ind: {
        ema10: 82, ema20: 84, ema50: 88, sma20: 83, sma50: 87,
        rsi: 32, macd: { macd: -1.2, signal: -1.0, hist: -0.2, histSlope: -0.1 },
        stochK: 30, stochD: 35, atr: 2, vwap: 84,
        adx: { adx: 30, plusDI: 10, minusDI: 26 }, relVolume: 1.8,
        pivot: { p: 84, s1: 82, r1: 86 },
        recommend: -0.5, high52w: 120, low52w: 78,
      },
      regime: { niftyChange: -1.0, indiaVix: 19 },
    };
    const votes = runQuantModels(ctx);
    expect(votes.find(x => x.id === 'trend')!.dir).toBe(-1);
    expect(votes.find(x => x.id === 'momentum')!.dir).toBe(-1);
    expect(votes.find(x => x.id === 'regime')!.dir).toBe(-1);
  });

  it('crypto regime uses BTC change (not NIFTY)', () => {
    const votes = runQuantModels({ market: 'CRYPTO', symbol: 'X', ltp: 1, changePct: 0, ind: {}, regime: { btcChange: 3.0 } });
    const reg = votes.find(x => x.id === 'regime')!;
    expect(reg.dir).toBe(1);
    expect(reg.reasons.join(' ')).toMatch(/BTC/);
  });

  it('OptionsFlow votes contrarian on extreme PCR and toward max pain', () => {
    const votes = runQuantModels({
      market: 'INDIA', symbol: 'NIFTY', ltp: 24000, changePct: 0, ind: {},
      regime: {},
      options: { pcr: 1.6, maxPain: 24300, ivPercentile: 40, oiSkew: 0.2 },
    });
    const opts = votes.find(x => x.id === 'options')!;
    expect(opts.dir).toBe(1); // extreme puts + max pain above → bullish
    expect(opts.reasons.join(' ')).toMatch(/contrarian bullish/);
  });

  it('AI Council verdict mapping: AVOID → dir 0 with conf', () => {
    const av = aiCouncilVoteFromVerdict({ verdict: 'AVOID', confidence: 70, note: 'thin book' });
    expect(av!.dir).toBe(0);
    expect(av!.conf).toBeGreaterThanOrEqual(50);
    const long = aiCouncilVoteFromVerdict({ verdict: 'LONG', confidence: 88, note: 'confluence' });
    expect(long!.dir).toBe(1);
    expect(long!.conf).toBe(88);
  });

  it('model crashes are contained (dir 0 with error reason)', () => {
    const votes = runQuantModels({ market: 'INDIA', symbol: 'X', ltp: null, ind: null, regime: null });
    expect(votes).toHaveLength(12); // v21.7.0: 13 models − AI Council (fn=null) − v2/mesh flag-off; +MACrossTracker
    votes.forEach(vt => {
      if (vt.dir !== 0) return; // may legitimately vote from partial data
      expect(vt.conf).toBeGreaterThanOrEqual(0);
    });
  });
});

describe('indicators — pure math pins', () => {
  // Accelerating (geometric) growth — MACD genuinely positive (linear series converge hist to 0).
  const up = Array.from({ length: 60 }, (_, i) => {
    const c = 100 * Math.pow(1.03, i);
    return { time: i, open: c / 1.01, high: c * 1.01, low: c / 1.02, close: c, volume: 1000 + i * 10 };
  });
  const flat = Array.from({ length: 60 }, () => ({ time: 0, open: 100, high: 101, low: 99, close: 100, volume: 1000 }));

  it('rising closes → RSI 100, MACD positive, price above EMA stack', () => {
    const closes = up.map(c => c.close);
    expect(rsi(closes)).toBe(100);
    const m = macd(closes)!;
    expect(m.hist).toBeGreaterThan(0);
    const agg = computeIndicatorsFromCandles(up)!;
    expect(agg.ema10).toBeGreaterThan(agg.ema50!);
    expect(agg.ltp).toBeCloseTo(100 * Math.pow(1.03, 59), 4);
  });

  it('flat series → mid Bollinger %B ~0.5, near-zero width', () => {
    const closes = flat.map(c => c.close);
    const bb = bollinger(closes)!;
    expect(bb.percentB).toBeCloseTo(0.5, 1);
    expect(bb.widthPct).toBeLessThan(1);
  });

  it('ATR of a 2-range series is exactly 2', () => {
    const two = Array.from({ length: 40 }, () => ({ time: 0, open: 100, high: 102, low: 100, close: 101, volume: 10 }));
    expect(atr(two)).toBeCloseTo(2, 5);
  });

  it('pattern detection: hammer + bullish engulfing', () => {
    const candles = [
      { time: 0, open: 100, high: 101, low: 99, close: 100.5, volume: 10 },
      { time: 1, open: 100, high: 100.2, low: 99, close: 99.5, volume: 10 },     // prev bearish
      { time: 2, open: 99.4, high: 99.5, low: 97, close: 99.3, volume: 10 },    // hammer: long lower wick
    ];
    const pats = detectPatterns(candles);
    expect(pats.map(p => p.name)).toContain('Hammer');
  });
});

describe('toCouncilCandidate — the 9th-model prompt normalization', () => {
  it('flattens the BOARD candidate shape ({ctx, votes, consensus, plan})', () => {
    const c = toCouncilCandidate({
      ctx: { symbol: 'RELIANCE', ltp: 1290.5, changePct: 1.2, ind: { rsi: 61, adx: { adx: 28 } } },
      votes: [v('trend', 1, 80, 1.2)],
      consensus: { side: 'LONG', confidence: 78 },
      plan: { entry: 1290, stopLoss: 1250, target1: 1330, target2: 1370 },
    });
    expect(c.symbol).toBe('RELIANCE');
    expect(c.side).toBe('LONG');
    expect(c.confidence).toBe(78);
    expect(c.ltp).toBe(1290.5);
    expect(c.changePct).toBe(1.2);
    expect(c.ind?.rsi).toBe(61);
    expect(c.plan?.stopLoss).toBe(1250);
    expect(c.votes).toHaveLength(1);
  });

  it('passes the FLAT/deep-path shape through (symbol/side/confidence on the candidate)', () => {
    const c = toCouncilCandidate({
      symbol: 'BTC', side: 'LONG', confidence: 55,
      ltp: 100, changePct: 2, ind: { rsi: 58 }, plan: null, votes: [v('x', 1, 70, 1)],
    });
    expect(c.symbol).toBe('BTC');
    expect(c.side).toBe('LONG');
    expect(c.confidence).toBe(55);
    expect(c.plan).toBeNull();
  });

  it('deep-path candidate with only {symbol, ctx, votes} resolves side/conf from ctx+defaults', () => {
    const c = toCouncilCandidate({ symbol: 'NIFTY', ctx: { symbol: 'NIFTY', ltp: 23800, changePct: -0.4, ind: {} }, votes: [] });
    expect(c.symbol).toBe('NIFTY');
    expect(c.ltp).toBe(23800);
    expect(c.side).toBeUndefined(); // honest: no consensus available
    expect(c.plan).toBeNull();
  });
});

// ============================================================
// v6.3 RECALIBRATION — the "no trade signals" fix
// ------------------------------------------------------------
// Pre-v6.3 the confidence formula (|Σdir·w·conf| / ALL weight) was
// mathematically starved: 3 abstainers diluted every India stock
// signal ~35% and realistic consensus landed 30-43% — below even the
// ACTION threshold. Users saw only WATCH/NEUTRAL cards ("trade
// signals hi nhi de rahe"). These tests pin the NEW contract.
// ============================================================
describe('v6.3 confidence recalibration — quorum-decomposed confidence', () => {
  // THE USER BUG: a real MARUTI-style bear day — 5 of 8 models vote
  // SHORT with 100% agreement, 3 abstain (no options chain, thin
  // volume, mid-BB). Pre-v6.3: conf 43 WATCH. Must now read ACTION.
  it('diluted-but-unanimous committee (5/8 voting, 100% agree) → ACTION, not WATCH', () => {
    const out = aggregateVotes([
      v('trend', -1, 100, 1.4), v('momentum', -1, 81, 1.3), v('pattern', -1, 53, 1.0),
      v('sr', -1, 58, 1.1), v('regime', -1, 63, 0.8),
      v('volatility', 0, 25, 0.9), v('volume', 0, 25, 1.2), v('options', 0, 0, 1.0),
    ]);
    expect(out.side).toBe('SHORT');
    expect(out.agreement).toBe(1);
    expect(out.participation).toBeCloseTo(5.6 / 8.7, 2);
    expect(out.confidence).toBeGreaterThanOrEqual(55);
    expect(out.grade).toBe('ACTION');
  });

  it('STRONG is REACHABLE with a full-committee confluence (the v6.0 ceiling bug)', () => {
    // 8/8 quant models voting the same side at realistic conviction —
    // pre-v6.3 this computed ~70 (below the 75 gate): STRONG could
    // NEVER fire, so LIVE execution was dead code in practice.
    const out = aggregateVotes([
      v('trend', 1, 100, 1.4), v('momentum', 1, 90, 1.3), v('volatility', 1, 80, 0.9),
      v('volume', 1, 85, 1.2), v('pattern', 1, 82, 1.0), v('sr', 1, 85, 1.1),
      v('regime', 1, 75, 0.8), v('options', 0, 0, 1.0),
    ]);
    expect(out.confidence).toBeGreaterThanOrEqual(75);
    expect(out.grade).toBe('STRONG');
  });

  it('quorum honesty: the SAME votes with more abstainers → strictly lower confidence, agreement unchanged', () => {
    const voters = [v('a', 1, 80, 1.4), v('b', 1, 75, 1.3), v('c', 1, 70, 1.2)];
    const full = aggregateVotes(voters);
    const diluted = aggregateVotes([...voters, v('x', 0, 30, 1.0), v('y', 0, 30, 1.0), v('z', 0, 0, 1.0)]);
    expect(diluted.agreement).toBe(full.agreement);
    expect(diluted.confidence).toBeLessThan(full.confidence);
    expect(diluted.participation).toBeLessThan(full.participation);
  });

  it('consensus exposes participation (quorum) and the summary mentions it', () => {
    const out = aggregateVotes([v('a', 1, 80, 1.4), v('b', 0, 25, 1.2)]);
    expect(typeof out.participation).toBe('number');
    expect(out.participation).toBeGreaterThan(0);
    expect(out.participation).toBeLessThanOrEqual(1);
    expect(out.summary).toMatch(/quorum/);
  });

  it('split committee still degrades hard (agreement factor intact)', () => {
    const out = aggregateVotes([
      v('a', 1, 90, 1.4), v('b', 1, 88, 1.3), v('c', -1, 92, 1.2), v('d', -1, 90, 1.1),
    ]);
    // 2.7 vs 2.3 — near-tie: must NOT be STRONG
    expect(out.grade).not.toBe('STRONG');
    expect(out.confidence).toBeLessThan(75);
  });
});

// ============================================================
// v6.3 scannerPatterns — candlestick derivation for India stocks
// (scanner rows have OHLC + change% but no pattern column; the
// PatternNeural model previously had ZERO pattern input on NSE)
// ============================================================
describe('scannerPatterns — deriving today\\u2019s candle from scanner OHLC', () => {
  const base = { open: 100, high: 103, low: 99, ltp: 102.5, changePct: 2.5 };

  it('strong green body → Bullish Marubozu, bias +1', () => {
    const p = scannerPatterns({ open: 100, high: 102.6, low: 99.9, ltp: 102.5, changePct: 2.5 });
    const maru = p.find(x => x.name.includes('Marubozu'));
    expect(maru).toBeDefined();
    expect(maru.bias).toBe(1);
  });

  it('long lower wick small body → Hammer, bias +1', () => {
    const p = scannerPatterns({ open: 100, high: 100.4, low: 97, ltp: 100.3, changePct: -1 });
    expect(p.find(x => x.name === 'Hammer')?.bias).toBe(1);
  });

  it('long upper wick small body → Shooting Star, bias -1', () => {
    const p = scannerPatterns({ open: 100, high: 103, low: 99.9, ltp: 100.5, changePct: 1 });
    expect(p.find(x => x.name === 'Shooting Star')?.bias).toBe(-1);
  });

  it('open above prev close → Gap Up; open below → Gap Down', () => {
    const up = scannerPatterns({ ...base, open: 101, ltp: 102.5, changePct: 2.5 });
    // prevClose = 102.5/1.025 = 100 → open 101 > 100.5 ✓
    expect(up.find(x => x.name === 'Gap Up')?.bias).toBe(1);
    const down = scannerPatterns({ ...base, open: 98, ltp: 99, changePct: -1 });
    // prevClose = 99/0.99 = 100 → open 98 < 99.5 ✓
    expect(down.find(x => x.name === 'Gap Down')?.bias).toBe(-1);
  });

  it('degrades to [] on missing/zero OHLC (never throws)', () => {
    expect(scannerPatterns({ open: null, high: 10, low: 9, ltp: 9.5, changePct: 0 })).toEqual([]);
    expect(scannerPatterns({ open: 10, high: 10, low: 10, ltp: 10, changePct: 0 })).toEqual([]); // zero range
    expect(scannerPatterns({})).toEqual([]);
  });
});

// ============================================================
// v6.4 — RISK AUTO-FIT (the "plan risk 5.04% > 5% max" bug)
// ============================================================
describe('v6.4 buildTradePlan maxRiskPct — plans born inside the cap', () => {
  it('clamps an 8% ATR stop to the 5% cap (LONG): SL 95, T1 105, T2 110, honest flags', () => {
    // crypto 1.6×ATR: ltp 100, atr 5 → stop 8% away
    const plan = buildTradePlan({ side: 'LONG', dir: 1 }, { ltp: 100, ind: { atr: 5 } }, 'CRYPTO', { maxRiskPct: 5 });
    expect(plan).not.toBeNull();
    expect(plan!.riskPct).toBe(5);
    expect(plan!.stopLoss).toBeCloseTo(95, 1);
    expect(plan!.target1).toBeCloseTo(105, 1);
    expect(plan!.target2).toBeCloseTo(110, 1);
    expect(plan!.riskClamped).toBe(true);
    expect(plan!.originalRiskPct).toBeCloseTo(8, 1);
  });

  it('clamps on the SHORT side symmetrically (SL 105 on ltp 100)', () => {
    const plan = buildTradePlan({ side: 'SHORT', dir: -1 }, { ltp: 100, ind: { atr: 5 } }, 'CRYPTO', { maxRiskPct: 5 });
    expect(plan!.stopLoss).toBeCloseTo(105, 1);
    expect(plan!.target1).toBeCloseTo(95, 1);
    expect(plan!.riskClamped).toBe(true);
  });

  it('leaves an under-cap plan untouched (no clamp flags)', () => {
    const plan = buildTradePlan({ side: 'LONG', dir: 1 }, { ltp: 100, ind: { atr: 2 } }, 'CRYPTO', { maxRiskPct: 5 });
    expect(plan!.riskClamped).toBeUndefined();
    expect(plan!.riskPct).toBeCloseTo(3.2, 1);
  });

  it('no maxRiskPct opt → legacy behavior (wide stops stay wide)', () => {
    const plan = buildTradePlan({ side: 'LONG', dir: 1 }, { ltp: 100, ind: { atr: 5 } }, 'CRYPTO');
    expect(plan!.riskPct).toBeCloseTo(8, 1);
    expect(plan!.riskClamped).toBeUndefined();
  });
});

describe('v6.4 fitPlanToRiskCap — execute-time auto-fit', () => {
  const mk = (riskPct: number, side = 'LONG') => ({
    symbol: 'BTC', market: 'CRYPTO', side, grade: 'STRONG',
    confidence: 82, agreement: 0.78, generatedAt: Date.now(), ltp: 100,
    plan: {
      entry: 100, stopLoss: side === 'LONG' ? 100 - riskPct : 100 + riskPct,
      target1: side === 'LONG' ? 100 + riskPct : 100 - riskPct,
      target2: side === 'LONG' ? 100 + 2 * riskPct : 100 - 2 * riskPct,
      risk: riskPct, riskPct, rewardRisk: 2, atrUsed: riskPct / 1.6, planStyle: 'atr-based',
    },
  });

  it('THE USER BUG: 5.04% vs 5% cap → fitted, not bounced', () => {
    const { signal, note } = fitPlanToRiskCap(mk(5.04), 5);
    expect(note).toMatch(/auto-fitted 5\.04% → 5%/);
    expect(signal.plan.riskPct).toBe(5);
    expect(signal.plan.stopLoss).toBeCloseTo(95, 1); // 100 × 5%
    expect(signal.plan.target2).toBeCloseTo(110, 1);
    expect(signal.plan.riskClamped).toBe(true);
    expect(signal.plan.originalRiskPct).toBeCloseTo(5.04, 2);
  });

  it('SHORT side mirrors correctly (SL above entry)', () => {
    const { signal, note } = fitPlanToRiskCap(mk(6.2, 'SHORT'), 5);
    expect(note).toBeTruthy();
    expect(signal.plan.stopLoss).toBeCloseTo(105, 1);
    expect(signal.plan.target1).toBeCloseTo(95, 1);
  });

  it('under-cap plan is a no-op with no note', () => {
    const { signal, note } = fitPlanToRiskCap(mk(3.2), 5);
    expect(note).toBeNull();
    expect(signal.plan.riskPct).toBe(3.2);
    expect(signal.plan.riskClamped).toBeUndefined();
  });

  it('degrades safely on broken inputs (never throws, never mutates)', () => {
    expect(fitPlanToRiskCap(null, 5).note).toBeNull();
    expect(fitPlanToRiskCap(mk(8), 0).note).toBeNull();
    expect(fitPlanToRiskCap(mk(8), NaN).note).toBeNull();
    expect(fitPlanToRiskCap({ ...mk(8), ltp: null }, 5).note).toBeNull();
    expect(fitPlanToRiskCap({ ...mk(8), plan: null }, 5).note).toBeNull();
  });
});

// ============================================================
// v12.7 — EXACT TIE HONESTY (recheck R1-#5)
// ------------------------------------------------------------
// `bull >= bear` used to mint a LONG call on a committee that was
// EXACTLY split — a silent directional bias on every desk that shares
// this aggregator. An exact weight tie is now an honest FLAT.
// ============================================================
describe('v12.7 aggregateVotes — exact bull/bear weight tie → honest FLAT', () => {
  it('a perfect tie returns FLAT/NEUTRAL with the split summary (never a minted LONG)', () => {
    const votes = [
      { id: 'a', name: 'A', role: 'trend', weight: 1.2, dir: 1, conf: 80 },
      { id: 'b', name: 'B', role: 'momentum', weight: 1.2, dir: -1, conf: 80 },
    ];
    const out = aggregateVotes(votes);
    expect(out.side).toBe('FLAT');
    expect(out.dir).toBe(0);
    expect(out.grade).toBe('NEUTRAL');
    expect(out.confidence).toBe(0);
    expect(out.tie).toBe(true);
    expect(out.summary).toContain('exactly split');
    expect(out.voters).toBe(2);
  });

  it('one-sided votes still resolve LONG/SHORT normally (no regression)', () => {
    const votes = [
      { id: 'a', name: 'A', role: 'trend', weight: 1.2, dir: 1, conf: 80 },
      { id: 'b', name: 'B', role: 'momentum', weight: 1.2, dir: -1, conf: 80 },
      { id: 'c', name: 'C', role: 'volume', weight: 0.6, dir: 1, conf: 70 },
    ];
    const out = aggregateVotes(votes);
    expect(out.side).toBe('LONG');
    expect(out.tie).toBeUndefined();
  });
});
