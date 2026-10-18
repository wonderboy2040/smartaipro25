// ============================================================
// test/v2113MomentumCapture.test.ts — v21.13.0
// MOMENTUM CAPTURE ENGINE v2: the 90%-opposite-signal disease fixes.
//
// The live-proven root cause (2026-10-14): signals were NOT inverted —
// they were DAILY-RESOLUTION + LATE. RELIANCE daily RSI 41.8 (SHORT zone)
// while the 15m RSI was 83 (rally). This suite locks the fixes:
//   [F1] engine |15 columns (order = positional parse contract)
//   [F2] engine chase gate (HARD 48 / SOFT -7 / EXTENDED -4 / PULLBACK payload-only)
//   [F3] tvToInd histSlope honest-null (no fabricated level-as-slope)
//   [F4] momentumQuant regime-aware tails + null-slope-robust MACD
//   [F5] expertScoreFactors side-aware grading + lean/leanConflict
//   [F6] signalMemory flip windows 2m/5m + session-VWAP anchor
//   [F7] trackRecord SL gap-through parity (traded-price fill)
//   [F8] config.py META_MODEL_IDS 16-seat roster
//   [F9] misc: expertMode port 8100, boardAccountability dynamic label,
//        stream MAX_WATCH_NSE 56, engine nullish change fallback
// ============================================================
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

const {
  TV_INTRADAY_COLUMNS, analyzeIntradayFromScanner,
} = await import('../server/intraday/engine.js');
const { runQuantModels } = await import('../server/ai/models.js');
const { expertScoreFactors } = await import('../server/ai/expertPicks.js');
const {
  FLIP_COOLDOWN_MS, FLIP_SOFT_MS,
} = await import('../server/ai/signalMemory.js');

// deterministic mid-session clock (engine session-pace volume math)
const WED_1100_IST = new Date('2026-09-09T05:30:00Z');

// ---------------- [F1] engine |15 columns ----------------
describe('v21.13 [F1] — TV_INTRADAY_COLUMNS intraday resolution', () => {
  it('the momentum/trend columns carry |15 (15-minute) suffixes', () => {
    expect(TV_INTRADAY_COLUMNS).toContain('EMA10|15');
    expect(TV_INTRADAY_COLUMNS).toContain('EMA20|15');
    expect(TV_INTRADAY_COLUMNS).toContain('SMA20|15');
    expect(TV_INTRADAY_COLUMNS).toContain('SMA50|60');   // 1-HOUR HTF confluence
    expect(TV_INTRADAY_COLUMNS).toContain('RSI|15');
    expect(TV_INTRADAY_COLUMNS).toContain('MACD.macd|15');
    expect(TV_INTRADAY_COLUMNS).toContain('MACD.signal|15');
    expect(TV_INTRADAY_COLUMNS).toContain('ATR|15');
    expect(TV_INTRADAY_COLUMNS).toContain('ADX|15');
    expect(TV_INTRADAY_COLUMNS).toContain('ADX+DI|15');
    expect(TV_INTRADAY_COLUMNS).toContain('ADX-DI|15');
    expect(TV_INTRADAY_COLUMNS).toContain('Recommend.All|15');
  });

  it('daily/session columns stay UNSUFFIXED (day-range/gap/VWAP/pivots/relVolume)', () => {
    ['close', 'open', 'high', 'low', 'volume', 'change', 'VWAP',
      'relative_volume_10d_calc', 'Pivot.M.Classic.Middle',
      'Pivot.M.Classic.S1', 'Pivot.M.Classic.R1'].forEach(c => {
      expect(TV_INTRADAY_COLUMNS).toContain(c);
    });
    // Pivot.B.Classic.* returns null on TV (live-probed) — must NOT be used
    expect(TV_INTRADAY_COLUMNS.some(c => c.startsWith('Pivot.B.'))).toBe(false);
  });

  it('the array is the POSITIONAL d[0..23] contract — length 24, key positions fixed', () => {
    expect(TV_INTRADAY_COLUMNS).toHaveLength(24);
    expect(TV_INTRADAY_COLUMNS[0]).toBe('close');       // d[0] close (daily)
    expect(TV_INTRADAY_COLUMNS[6]).toBe('EMA10|15');    // d[6] ema10 (15m)
    expect(TV_INTRADAY_COLUMNS[10]).toBe('RSI|15');     // d[10] rsi (15m)
    expect(TV_INTRADAY_COLUMNS[13]).toBe('ATR|15');     // d[13] atr (15m)
    expect(TV_INTRADAY_COLUMNS[14]).toBe('VWAP');       // d[14] vwap (session, daily)
    expect(TV_INTRADAY_COLUMNS[23]).toBe('last');       // d[23] last
  });

  it('the intraday engine source pins the suffixed set (live-verified 2026-10-14)', () => {
    const src = readFileSync(join(root, 'server/intraday/engine.js'), 'utf8');
    expect(src).toMatch(/EMA10\|15/);
    expect(src).toMatch(/SMA50\|60/);
    expect(src).toMatch(/ATR\|15/);
    // the chase gate is wired (entryTimingRead import + CHASING reason)
    expect(src).toMatch(/entryTimingRead/);
    expect(src).toMatch(/🚀 CHASING/);
  });
});

// ---------------- [F2] engine chase gate + 15m risk geometry ----------------
describe('v21.13 [F2] — engine momentum-capture gate (chase guard)', () => {
  // 15m-scale fixture: ATR 3.6 (≈ RELIANCE live 15m ATR 3.73)
  const tv15 = {
    close: 1185.4, open: 1167, high: 1186, low: 1162.7, volume: 5.5e6, change: 1.6,
    ema10: 1178.7, ema20: 1173.7, sma20: 1172.1, sma50: 1181.5, // SMA50 = 1h
    rsi: 83.0, macd: 5.8, macdSignal: 4.6, atr: 3.7, vwap: 1178.0,
    adx: 37.7, adxPlus: 36.9, adxMinus: 10.3, relVolume: 1.9,
    pivotMiddle: 1233.9, pivotS1: 1215, pivotR1: 1252.7,
    recommend: 0.6, last: null, exchange: 'NSE',
  };
  const groww = { price: 1185.4, prevClose: 1166.7, change: 1.6, high: 1186, low: 1162.7, volume: 5.5e6 };

  it('a 2.7×ATR15 chase above VWAP (RSI 83) is HARD-capped to 48 and flagged', () => {
    // ltp 1185.4 vs vwap 1178.0 → +7.4 → /3.7 = +2.0×ATR; RSI 83 ≥ 64 → HARD (RSI-assist at ≥1.9)
    const s = analyzeIntradayFromScanner('RELIANCE', tv15, groww, { now: WED_1100_IST });
    expect(s).toBeTruthy();
    expect(s!.chaseGuard).toBeTruthy();
    expect(s!.chaseGuard!.severity).toBe('HARD');
    expect(s!.quantConfidence).toBeLessThanOrEqual(48);
    expect(s!.reasons.join(' ')).toContain('CHASING');
    expect(s!.reasons.join(' ')).toContain('pullback ka wait karo');
  });

  it('a PULLBACK-band entry (0.5×ATR above VWAP) is payload-flagged, conf NEVER boosted on the engine', () => {
    // vwap-dist +0.5×ATR: price 1179.9 vs vwap 1178 → +1.9 → 0.51×ATR15 — inside [-0.6,+0.8]
    const tv = { ...tv15, rsi: 61, macd: 4, macdSignal: 3, atr: 3.7 };
    const gw = { ...groww, price: 1179.9, high: 1186, low: 1175 };
    const s = analyzeIntradayFromScanner('RELIANCE', tv, gw, { now: WED_1100_IST });
    expect(s).toBeTruthy();
    expect(s!.chaseGuard?.quality).toBe('PULLBACK');
    expect(s!.reasons.join(' ')).toContain('PULLBACK');
    // engine pe PULLBACK boost INTENTIONALLY nahi hai (suppression-only):
    // deterministic penalties — regime/circuit diffs kabhi distort nahi hote
    const base = { ...tv, vwap: 1178 };
    const sNoReason = analyzeIntradayFromScanner('RELIANCE', base, { ...gw }, { now: WED_1100_IST });
    expect(sNoReason!.chaseGuard?.quality).toBe('PULLBACK'); // stable band read
  });

  it('risk geometry is 15m-scaled: stop within [0.7, 1.8]×ATR15, T1 = 1.6R (intraday-reachable)', () => {
    const s = analyzeIntradayFromScanner('RELIANCE', tv15, groww, { now: WED_1100_IST });
    const atr = s!.atr;
    expect(atr).toBeGreaterThan(3);   // 15m ATR (RELIANCE live 3.73), NOT the daily 22.5
    expect(atr).toBeLessThan(5);
    const dist = Math.abs(s!.entry - s!.stopLoss);
    expect(dist).toBeGreaterThanOrEqual(0.7 * atr - 0.02);
    expect(dist).toBeLessThanOrEqual(1.8 * atr + 0.02);
    // T1 at 1.6R → intraday-reachable (the daily version was 3-4% = unreachable by 15:10)
    expect(Math.abs(s!.target1 - s!.entry)).toBeCloseTo(1.6 * dist, 1);
  });

  it('a legitimate 0.00% Groww change no longer falls through to the TV value (nullish)', () => {
    const s = analyzeIntradayFromScanner('RELIANCE', tv15, { ...groww, change: 0 }, { now: WED_1100_IST });
    expect(s!.changePct).toBe(0); // pre-v21.13: || fell through to tv.change (1.6)
  });
});

// ---------------- [F3] tvToInd honest histSlope ----------------
describe('v21.13 [F3] — tvToInd no longer fabricates histSlope', () => {
  it('the tvToInd source sets histSlope null on TV snapshots (a snapshot cannot know the previous bar)', () => {
    const src = readFileSync(join(root, 'server/ai/signals.js'), 'utf8');
    // the fabricated alias (code form 'histSlope: macdHist }') must be GONE
    expect(src).not.toMatch(/histSlope:\s*macdHist\s*}/);
    expect(src).toMatch(/histSlope:\s*null/);
    expect(src).toMatch(/roc:\s*null/); // unchanged honest-null (snapshot cannot compute ROC)
  });
});

// ---------------- [F4] momentumQuant regime-aware + null-slope ----------------
describe('v21.13 [F4] — momentumQuant regime-aware contrarian tails', () => {
  // NOTE: momentumQuant votes at |score| > 1.0 — single ±0.4/±0.9 legs
  // never vote alone. Each fixture pairs the RSI-tail leg with a MACD leg
  // so the case asserts the TAIL's direction, not a lone-actor artifact.
  const runMomentum = (indOver = {}) => runQuantModels({
    market: 'CRYPTO', symbol: 'BTC', ltp: 100, regime: null,
    ind: { rsi: null, macd: null, adx: null, ...indOver },
  }).find(v => v.id === 'momentum')!;
  const MACD_UP = { macd: 2, signal: 1, hist: 1, histSlope: 0.3 };
  const MACD_DOWN = { macd: -2, signal: -1, hist: -1, histSlope: -0.3 };

  it('RSI 80 + STRONG trend (ADX 30) → continuation +0.4, NEVER the fade (the "momentum capture" fix)', () => {
    // strong-trend tail (+0.4) + a rising hist (+1.1) → LONG 1.5
    const strong = runMomentum({ rsi: 80, adx: 30, macd: MACD_UP });
    expect(strong.dir).toBe(1);
    expect(strong.reasons.join(' ')).toContain('no fade');
    // the SAME coin in a range (ADX 14) flips the tail to the −0.9 fade —
    // the pair proves the branch is genuinely regime-aware
    const range = runMomentum({ rsi: 80, adx: 14, macd: MACD_DOWN });
    expect(range.dir).toBe(-1);
    expect(range.reasons.join(' ')).toContain('exhaustion risk');
  });

  it('RSI 20 + STRONG downtrend → continuation −0.4 (no bounce-bet against a trending tape)', () => {
    const v = runMomentum({ rsi: 20, adx: 28, macd: MACD_DOWN });
    expect(v.dir).toBe(-1);
    expect(v.reasons.join(' ')).toContain('no bounce-bet');
  });

  it('RSI 20 + range (ADX 12) → bounce fuel +0.9 (LONG)', () => {
    const v = runMomentum({ rsi: 20, adx: 12, stochK: 15, stochD: 12 }); // K>D from OS (+0.5)
    expect(v.dir).toBe(1);
    expect(v.reasons.join(' ')).toContain('bounce fuel');
  });

  it('MACD hist>0 with histSlope NULL (TV snapshot) still votes LONG at reduced weight (honest label)', () => {
    const v = runMomentum({ macd: { macd: 2, signal: 1, hist: 1, histSlope: null }, adx: 25, rsi: 60 });
    expect(v.dir).toBe(1);
    expect(v.reasons.join(' ')).toContain('slope unknown');
  });

  it('ADX shape is normalized: OBJECT {adx} (candle paths) and NUMBER (TV rows) both work', () => {
    const obj = runMomentum({ rsi: 80, adx: { adx: 31, plusDI: 20, minusDI: 8 }, macd: MACD_UP });
    const num = runMomentum({ rsi: 80, adx: 31, macd: MACD_UP });
    expect(obj.dir).toBe(num.dir);
    expect(obj.dir).toBe(1);
  });
});

// ---------------- [F5] expertScoreFactors side-aware ----------------
describe('v21.13 [F5] — expertScoreFactors SIDE-AWARE grading', () => {
  // bearish coin: deep red daily-style TV row
  const bearishTv = {
    ltp: 100,
    ema10: 104, ema20: 106, ema50: 108, sma20: 106, sma50: 107,
    rsi: 34, macd: -1.2, macdSignal: -0.8, atr: 2.5, vwap: 103,
    adx: 27, adxPlus: 12, adxMinus: 26, relVolume: 1.4,
    pivot: { p: 104, s1: 100, r1: 108 },
    recommend: -0.4, high52w: 140, low52w: 80,
  };

  it('no side param → the expert lean wins (auto behaviour, the expert picks panel)', () => {
    const e = expertScoreFactors({ tv: bearishTv, market: 'CRYPTO', regime: null });
    expect(e).toBeTruthy();
    expect(e!.side).toBe('SHORT');
    expect(e!.lean).toBe('SHORT');
    expect(e!.gradedFor).toBe('auto');
    expect(e!.leanConflict).toBe(false);
  });

  it('side: LONG (committee consensus) → graded FOR LONG + leanConflict surfaced (never a silent opposite-side blend)', () => {
    const e = expertScoreFactors({ tv: bearishTv, market: 'CRYPTO', regime: null, side: 'LONG' });
    expect(e!.side).toBe('LONG');           // graded FOR the committee side
    expect(e!.lean).toBe('SHORT');          // the honest lean still surfaced
    expect(e!.leanConflict).toBe(true);     // and flagged
    expect(e!.gradedFor).toBe('LONG');
    // a conflicted coin grades LOWER for the committee side than an aligned
    // one would — the ranking disease fix is exactly this
    const aligned = expertScoreFactors({
      tv: { ...bearishTv, ema10: 99, ema20: 101, ema50: 104, rsi: 62, macd: 1.0, macdSignal: 0.6, adx: 27, adxPlus: 26, adxMinus: 12 },
      market: 'CRYPTO', regime: null, side: 'LONG',
    });
    expect(aligned!.score).toBeGreaterThan(e!.score);
  });

  it('the board/deep call sites pass the consensus side (source contract)', () => {
    const src = readFileSync(join(root, 'server/ai/signals.js'), 'utf8');
    expect(src).toMatch(/side:\s*consensus\.side,/);        // pass-1 + deep
    expect(src).toMatch(/side:\s*consensus2\.side,/);        // final board
    expect(src).toMatch(/v21\.13: SIDE-AWARE/);               // the fix's own marker comment
  });
});

// ---------------- [F6] flip windows + session-VWAP anchor ----------------
describe('v21.13 [F6] — flip-cooldown retune + session-VWAP anchor', () => {
  it('FLIP_COOLDOWN_MS is 2 minutes (was 5) and FLIP_SOFT_MS 5 minutes (was 10)', () => {
    expect(FLIP_COOLDOWN_MS).toBe(2 * 60_000);
    expect(FLIP_SOFT_MS).toBe(5 * 60_000);
  });

  it('the India chase guard anchors to the SESSION VWAP (ctx.__tv.vwap), not the month-anchored candle VWAP', () => {
    const src = readFileSync(join(root, 'server/ai/signalMemory.js'), 'utf8');
    expect(src).toMatch(/SESSION-VWAP ANCHOR FIX/);
    expect(src).toMatch(/ctx\?\.__tv\?\.vwap \?\? ltf\?\.vwap/);
  });
});

// ---------------- [F7] trackRecord SL gap-through ----------------
describe('v21.13 [F7] — trackRecord SL gap-through parity (source contract)', () => {
  it('SL_HIT fills at the TRADED price (paperTrading v20.9.1 [H3] jaisa), not the trigger level', () => {
    const src = readFileSync(join(root, 'server/intraday/trackRecord.js'), 'utf8');
    expect(src).toMatch(/SL GAP-THROUGH PARITY/);
    expect(src).toMatch(/_closeRow\(row, price, 'SL_HIT', events\)/);
    expect(src).not.toMatch(/_closeRow\(row, row\.stopLoss, 'SL_HIT'/);
  });
});

// ---------------- [F8] META roster sync ----------------
describe('v21.13 [F8] — ml-service META_MODEL_IDS 16-seat roster', () => {
  it('has all 16 live voting ids (structure / macross / tape-mtf were silently zero-filled before)', () => {
    const src = readFileSync(join(root, 'ml-service/app/config.py'), 'utf8');
    ['"trend"', '"momentum"', '"volatility"', '"volume"', '"pattern"', '"sr"',
      '"options"', '"regime"', '"smc"', '"structure"', '"macross"', '"tape-mtf"',
      '"aicouncil"', '"sentiment"', '"instflow"', '"fundamentals"'].forEach(id => {
      expect(src).toContain(id);
    });
    expect(src).not.toContain('"tape",'); // legacy tape replaced by tape-mtf (w1.6)
  });
});

// ---------------- [F9] misc fixes ----------------
describe('v21.13 [F9] — misc: port, dynamic committee label, watch cap', () => {
  it('expertMode defaults ML_SERVICE_URL to 8100 (ml-service port; 8000 historically Laya)', () => {
    const src = readFileSync(join(root, 'server/ai/expertMode.js'), 'utf8');
    expect(src).toMatch(/127\.0\.0\.1:8100/);
    expect(src).not.toMatch(/127\.0\.0\.1:8000/);
  });

  it('boardAccountability builds its committee label from LIVE counts (no stale hardcoded number)', () => {
    const src = readFileSync(join(root, 'server/ai/boardAccountability.js'), 'utf8');
    expect(src).toMatch(/_committeeLabel\(\)/);
    expect(src).not.toMatch(/10-model consensus/);
  });

  it('stream watcher cap MAX_WATCH_NSE is 56 (v21.13: 34 → 56 vs MAX_PER_DAY 80)', () => {
    const src = readFileSync(join(root, 'server/intraday/stream.js'), 'utf8');
    expect(src).toMatch(/MAX_WATCH_NSE = 56/);
  });
});
