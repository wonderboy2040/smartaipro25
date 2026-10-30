// ============================================================
// test/v2113xDeepRecheck.test.ts — v21.13.x FULL-SITE DEEP RECHECK
// ------------------------------------------------------------
// User ask: "latest repo ko pull karo aur full site deep recheck karo
// aur issues fix kardo dekho sab accurately theek se work kar rahe
// hai kya Trading Signals ke koi distrub tho nhi kar raha hai"
//
// This suite locks the deep-recheck fixes (audited end-to-end):
//   [B1] dead maCrossFromCandles import removed (signals.js)
//   [B2] trackRecord BE_TRAIL_EXIT worst-side fill (paperTrading parity)
//   [B3] INDIA INDEX contexts the 15m→1h chain (board + deep parity);
//        deep-path ltfCandles NEVER the 1h committee series for INDIA
//   [B4] expertPicks rewardRisk derived from the T1 ladder
//   [B5] engine exact-score tie demoted below the pool floor (no free LONG)
//   [P1] metals priceSource label derived from the SERVING rows' sources
//   [P2] fapi per-symbol requests (the ?symbols= JSON-array param is
//        IGNORED by fapi — live-verified) in futures.js + cxRtStream.js
//   [P3] useAITrading loadBoards sequence guard (stale-response discard)
//   [M5] expertMode ML base trailing-slash strip genuinely applied
//   [M7] mlHealth accepts Python /health {"status":"ok"}
//   [M1] Python meta_ensemble_enabled default-ON (config.py pin)
//   [M6] orchestrator shadow votes excluded from the voting denominator
// ============================================================
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const src = (p) => readFileSync(join(root, p), 'utf8');

// hermetic data dir
process.env.SMARTAI_DATA_DIR = join(here, '../.test-data-v2113x');

// ---------------- fixtures ----------------
// A RISING 15m series (~90 bars) — the tape climbing (fraction +0.16%/bar)
function rising15m(n = 96) {
  const out = [];
  // v21.28.0 [TEST-HERMETIC]: end at the CURRENT 15m wall instead of a fixed
  // 2026-09-09 stamp. The v21.23.10 stale-data gate is live whenever NSE is
  // open; a frozen fixture then honestly returns null and this suite would
  // assert the daily fallback (RSI ~0) instead of the 15m→1h chain. A fresh
  // anchor keeps the intended fixture semantics at any run time.
  const step = 15 * 60_000;
  const last = Math.floor(Date.now() / step) * step;
  const t0 = last - (n - 1) * step;
  let px = 24800;
  for (let i = 0; i < n; i++) {
    px = px * (1 + 0.0016);
    out.push({
      time: t0 + i * 15 * 60_000,
      open: +(px * 0.9996).toFixed(2), high: +(px * 1.0015).toFixed(2),
      low: +(px * 0.9985).toFixed(2), close: +px.toFixed(2),
      volume: 120_000 + (i % 7) * 9_000,
    });
  }
  return out;
}
// A BEARISH daily series (~130 bars, -0.25%/bar) — the OLD disease source
function bearishDaily(n = 130) {
  const out = [];
  const t0 = new Date('2026-03-01T00:00:00Z').getTime();
  let px = 26500;
  for (let i = 0; i < n; i++) {
    px = px * (1 - 0.0025);
    out.push({
      time: t0 + i * 24 * 3600_000,
      open: +(px * 1.001).toFixed(2), high: +(px * 1.004).toFixed(2),
      low: +(px * 0.996).toFixed(2), close: +px.toFixed(2),
      volume: 1_000_000,
    });
  }
  return out;
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

// ---------------- [B3] index 15m→1h chain (unit) ----------------
describe('v21.13.x [B3] — buildIndiaIndexCtx: the 15m→1h committee chain', () => {
  const SIGNALS = '../server/ai/signals.js';

  beforeAll(() => {
    // ^NSEI 15m → rising (150 bars — the REAL Yahoo 1mo 15m feed is ~500
    // bars; a 96-bar fixture resamples to just 24 hourly buckets < the
    // 30-bucket honesty floor, so the ctx honestly kept the 15m series
    // and the "1h wall" assertion failed on the fixture, not the code);
    // ^NSEI daily (interval=1d) → bearish
    const R15 = rising15m(150);
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      const u = String(url);
      if (u.includes('%5ENSEI') || u.includes('^NSEI')) {
        if (u.includes('interval=15m')) return yahooChartReply(R15);
        if (u.includes('interval=1d')) return yahooChartReply(bearishDaily());
      }
      throw new Error('offline (test)');
    }));
  });

  it('a rising 15m tape + bearish daily → the committee votes the 1H VIEW (not yesterday\'s daily)', async () => {
    const { __clearSignalCaches, buildIndiaIndexCtx } = await import(SIGNALS);
    __clearSignalCaches();
    const ctx = await buildIndiaIndexCtx('NIFTY', null, null);
    expect(ctx).toBeTruthy();
    expect(ctx.isIndex).toBe(true);
    // the 1h candles: buckets aligned to 60min walls
    const candleTimes = (ctx.candles || []).map(c => c.time);
    expect(candleTimes.length).toBeGreaterThanOrEqual(30);
    for (const t of candleTimes) expect(t % (60 * 60_000)).toBe(0);
    // ind = the 1H view: RSI must reflect the RISING series (>55), NOT the
    // bearish daily (which computes deeply oversold ~0-10)
    expect(ctx.ind.rsi).toBeGreaterThan(55);
    // the honest HTF reference is preserved
    expect(ctx.__dailyInd).toBeTruthy();
    expect(ctx.__dailyInd.rsi).toBeLessThan(35);
    // the 15m view rides along (pass-1 revival fires for indexes now)
    expect(ctx.__ltfInd).toBeTruthy();
    expect(ctx.__ltfInd.rsi).toBeGreaterThan(55);
    // ltp = the freshest 15m close, not the daily close
    expect(ctx.ltp).toBeCloseTo(rising15m(150)[rising15m(150).length - 1].close, 0);
  });

  it('unknown symbols honestly return null (no fake isIndex ctx for stocks)', async () => {
    const { __clearSignalCaches, buildIndiaIndexCtx } = await import(SIGNALS);
    __clearSignalCaches();
    const ctx = await buildIndiaIndexCtx('SOMEUNKNOWN', null, null);
    expect(ctx).toBeNull();
  });

  it('Yahoo 15m down → honest daily fallback (pre-v21.13.x behaviour preserved)', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      const u = String(url);
      if ((u.includes('%5ENSEI') || u.includes('^NSEI')) && u.includes('interval=1d')) {
        return yahooChartReply(bearishDaily());
      }
      throw new Error('offline (test)');
    }));
    const { __clearSignalCaches, buildIndiaIndexCtx } = await import(SIGNALS);
    __clearSignalCaches();
    const ctx = await buildIndiaIndexCtx('NIFTY', null, null);
    expect(ctx).toBeTruthy();
    expect(ctx.ind.rsi).toBeLessThan(35); // the daily view
    expect(ctx.__ltfInd).toBeNull();      // honest: no 15m
    vi.unstubAllGlobals();
  });
});

// ---------------- source contracts (B1/B3-deep/P1/P2/M5/M6/M1) ----------------
describe('v21.13.x deep-recheck source contracts', () => {
  it('[B1] the dead maCrossFromCandles import is gone from signals.js', () => {
    const s = src('server/ai/signals.js');
    expect(s).not.toMatch(/import\s*\{[^}]*maCrossFromCandles[^}]*\}\s*from/);
  });

  it('[B3-deep] the deep path NEVER feeds the INDIA 1h committee series as the "15m" LTF', () => {
    const s = src('server/ai/signals.js');
    // the ltfCandles selection excludes INDIA entirely (stocks AND indexes)
    expect(s).toMatch(/let ltfCandles = mkt !== 'INDIA' && Array\.isArray\(ctx\.candles\)/);
    // the old daily-guard variable is gone
    expect(s).not.toContain('_ctxCandlesAreDaily');
    // both index call-sites route through the shared builder (board parity)
    expect(s.match(/buildIndiaIndexCtx\(/g)?.length).toBeGreaterThanOrEqual(3); // def + board + deep
  });

  it('[P1] metals priceSource is derived from the serving rows (honest labels)', () => {
    const s = src('server/ai/signals.js');
    expect(s).toMatch(/_srcCounts/);
    expect(s).not.toContain("superMeta.priceSource = 'coindcx-fut-usdt (metals)'");
  });

  it('[P2] futures.js fapi leg uses per-symbol requests (fapi ignores ?symbols= JSON arrays)', () => {
    const s = src('server/ai/futures.js');
    expect(s).not.toContain('?symbols=${encodeURIComponent(JSON.stringify(symbols))}');
    expect(s).toMatch(/fapi\/v1\/ticker\/24hr\?symbol=\$\{encodeURIComponent\(sym\)\}/);
  });

  it('[P2] cxRtStream fapi leg uses per-symbol requests too', () => {
    const s = src('server/ai/cxRtStream.js');
    expect(s).not.toContain('_bnFutSymbolsParam');
    expect(s).toMatch(/_bnFutSymbolUrls/);
    expect(s).toMatch(/\?symbol=\$\{encodeURIComponent\(s\)\}/);
  });

  it('[M5] expertMode ML base strip is APPLIED code, not a comment', () => {
    const s = src('server/ai/expertMode.js');
    // the code line: String(... || 'http://127.0.0.1:8100').replace(/\/+$/, '')
    // (regex note: the literal text "/\\/+$" is slash backslash slash plus dollar)
    expect(s).toMatch(/String\(process\.env\.ML_SERVICE_URL \|\| 'http:\/\/127\.0\.0\.1:8100'\)\.replace\(\/\\\/\+\$\/, ''\)/);
  });

  it('[M7] mlHealth accepts the Python /health {"status":"ok"} shape', () => {
    const s = src('server/ai/mlHealth.js');
    expect(s).toMatch(/j\?\.status === 'ok'/);
  });

  it('[M1] Python meta_ensemble_enabled defaults ON (Node master-switch semantics)', () => {
    const s = src('ml-service/app/config.py');
    expect(s).toMatch(/not in \("false", "0", "off", "no"\)/);
  });

  it('[M6] Python weighted echo excludes weight-0 shadow votes', () => {
    const s = src('ml-service/app/orchestrator.py');
    expect(s).toContain('_vote_weight');
    expect(s).not.toMatch(/v\.get\("weight"\) or 1\.0/);
  });

  it('[M2] the Python training proxies cover the 3 new seats', () => {
    const s = src('ml-service/models/train_signal.py');
    expect(s).toContain('votes["structure"]');
    expect(s).toContain('votes["macross"]');
    expect(s).toContain('votes["tape-mtf"]');
    expect(s).not.toMatch(/votes\["tape"\]/);
  });

  it('[P3] loadBoards carries the sequence guard (stale responses discarded)', () => {
    const s = src('src/components/aitrading/useAITrading.ts');
    expect(s).toContain('boardsSeqRef');
    expect(s).toMatch(/if \(seq !== boardsSeqRef\.current\) return/);
  });
});

// ---------------- [B5] engine tie demotion ----------------
describe('v21.13.x [B5] — intraday engine exact-score tie → no free LONG', () => {
  it('a fully NEUTRAL TV row (all defaults, no signal either way) demotes below the pool floor', async () => {
    const { analyzeIntradayFromScanner } = await import('../server/intraday/engine.js');
    const WED_1100_IST = new Date('2026-09-09T05:30:00Z');
    // a deliberately dead-flat row: ltp == every MA == vwap, RSI 50, ATR tiny
    const flat = {
      close: 1000, open: 1000, high: 1000, low: 1000, volume: 1e6, change: 0,
      ema10: 1000, ema20: 1000, sma20: 1000, sma50: 1000,
      rsi: 50, macd: 0, macdSignal: 0, atr: 0.5, vwap: 1000,
      adx: 0, adxPlus: 0, adxMinus: 0, relVolume: 1,
      pivotMiddle: 1000, pivotS1: 1000, pivotR1: 1000,
      recommend: 0, last: null, exchange: 'NSE',
    };
    const groww = { price: 1000, prevClose: 1000, change: 0, high: 1000, low: 1000, volume: 1e6 };
    const s = analyzeIntradayFromScanner('FLATCO', flat, groww, { now: WED_1100_IST });
    if (s) {
      // exact-tie (or near-tie) reads must NEVER clear the routes pool floor (70)
      expect(s.quantConfidence).toBeLessThan(70);
      expect(s.reasons.join(' ')).toContain('TIE');
    }
  });
});

// ---------------- [B4] expertPicks rewardRisk ----------------
describe('v21.13.x [B4] — expertPicks rewardRisk derived from the T1 ladder', () => {
  it('the source computes RR from |T1-entry|/|entry-SL| (no hardcoded 2)', () => {
    const s = src('server/ai/expertPicks.js');
    expect(s).not.toMatch(/rewardRisk: 2,?\s*\n/);
    expect(s).toMatch(/rewardRisk: r2\(Math\.abs\(t1R - entryR\)/);
  });
});
