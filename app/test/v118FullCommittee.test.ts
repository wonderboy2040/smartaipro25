// ============================================================
// test/v118FullCommittee.test.ts — v11.8 "Full Committee" locks
//
// THE ASK (user, 2026-09-18): "Intraday TAB & CoinDCX TAB — 14
// models me sirf 3-4 ka response aa raha hai, isliye signal
// accuracy high nahi hai." Live-render diagnosis found FIVE
// structural voter losses; these tests lock each fix:
//
//   1. APPLICABLE-QUORUM: structural abstains (`na: true`) leave
//      the participation denominator — "6/17 voting" becomes
//      "6/11 applicable voting" and confidence stops being shaved
//      ~15% for seats that can never serve the market.
//   2. TAPE SEAT FALLBACK: MTF flag ON + 5m base dead + 15m tape
//      alive → the board path still injects the seat's degraded
//      15m vote (the old code skipped injection entirely).
//   3. OPTION-CHAIN CTX GATE: only REAL exchange chains (nse/bse)
//      may feed OptionsFlow; bs-model synthetic chains never vote.
//   4. BINANCE DEPTH FALLBACK: CoinDCX REST dead → Binance USDT
//      ladder serves, rescaled onto the INR anchor, honestly
//      labeled (InstFlow + VolumeFlow L2 vote from Render).
//   5. MESH `na` MARKS: equity seats on crypto / on-chain seat on
//      equity are structural — out of the denominator.
//
// Hermetic: no network anywhere.
// ============================================================
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------- module mocks (network-facing deps) ----------------
vi.mock('../server/ai/optionsDesk.js', () => ({
  getOptionsDesk: vi.fn(async (sym: string) => ({
    ok: true, symbol: sym,
    source: sym === 'NIFTY' ? 'nse' : 'bse',
    optionsCtx: { pcr: 1.55, maxPain: 24500, ivPercentile: 30, oiSkew: -0.2 },
  })),
}));
vi.mock('../server/ai/instFlow.js', () => ({
  warmInstFlow: vi.fn(async () => {}),
  refreshFiiDii: vi.fn(async () => null),
  instFlowVote: vi.fn(() => ({ dir: 0, conf: 0, reasons: ['mock instflow'] })),
  instFlowStatus: vi.fn(() => ({ enabled: true })),
}));
vi.mock('../server/ai/sentiment.js', () => ({
  refreshSentiment: vi.fn(async () => null),
  sentimentContextFor: vi.fn(() => null),
  absorbCouncilSentiment: vi.fn(() => null),
  sentimentStatus: vi.fn(() => ({ enabled: true })),
}));
vi.mock('../server/ai/fundamentals.js', () => ({
  attachFundamentals: vi.fn(async (ctx: unknown) => ctx),
  warmFundamentalsUniverse: vi.fn(async () => {}),
}));

import { aggregateVotes } from '../server/ai/ensemble.js';
import { MODELS, tapeVote } from '../server/ai/models.js';
import { instFlowProVote, techConsensusVote, fundaProPlusVote, cryptoOnChainProVote } from '../server/ai/meshModels.js';
import { getOrderbook } from '../server/ai/swing.js';
import { analyzeDepth } from '../server/ai/orderFlowDepth.js';
import { tapeMTFFromBase, resampleCandles } from '../server/ai/signals.js';

// ============================================================
// 1. APPLICABLE-QUORUM — `na` seats leave the denominator
// ============================================================
describe('v11.8 aggregateVotes — applicable-committee quorum', () => {
  const V = (id: string, dir: number, conf: number, weight: number, na = false) =>
    ({ id, dir, conf, weight, reasons: [], ...(na ? { na: true } : {}) });

  it('na seats do NOT dilute participation (the crypto-board case)', () => {
    // The live 2026-09-18 crypto board: 6 voting, 7 data-abstains, 4
    // structural (options/tape/fundamentals — na). OLD math:
    // participation = 6.07/11.01 = 0.55; NEW: 6.07/8.15 = 0.745.
    const votes = [
      V('trend', 1, 100, 1.05), V('momentum', 1, 88, 1.04), V('volume', 1, 44, 1.2),
      V('pattern', 1, 67, 1.1), V('smc', 1, 70, 0.88), V('regime', -1, 62, 0.8),
      // data-missing abstains — still count against quorum (honest)
      V('volatility', 0, 0, 1.08), V('sr', 0, 0, 1.375), V('sentiment', 0, 0, 0.7), V('instflow', 0, 0, 0.88),
      // structural — OUT of the denominator now
      V('options', 0, 0, 1.0, true), V('tape-mtf', 0, 0, 1.36, true), V('fundamentals', 0, 0, 0.5, true),
    ];
    const out = aggregateVotes(votes);
    expect(out.participating).toBe(6);
    // 13 seats total, 3 structural → 10 applicable
    expect(out.totalModels).toBe(10);
    expect(out.structuralAbsent).toBe(3);
    // participation counts ONLY applicable weight in the denominator
    const votingW = 1.05 + 1.04 + 1.2 + 1.1 + 0.88 + 0.8;
    const applicableW = votingW + 1.08 + 1.375 + 0.7 + 0.88;
    expect(out.participation).toBeCloseTo(votingW / applicableW, 2);
    expect(out.summary).toContain('6/10 models voting');
  });

  it('confidence is HIGHER than the old all-seats denominator (fair, not inflated)', () => {
    const mk = (na: boolean) => [
      V('a', 1, 80, 1), V('b', 1, 80, 1), V('c', 1, 80, 1), V('d', 1, 80, 1),
      V('x', 0, 0, 1, na), V('y', 0, 0, 1, na),
    ];
    const withNa = aggregateVotes(mk(true));
    const honestAbstains = aggregateVotes(mk(false)); // same votes, abstains counted (old behavior)
    expect(withNa.confidence).toBeGreaterThan(honestAbstains.confidence);
    // the gates are NOT loosened: agreement identical
    expect(withNa.agreement).toBe(honestAbstains.agreement);
  });

  it('votes WITHOUT na marks are byte-identical to the old math (no regression)', () => {
    const votes = [
      V('a', 1, 80, 1.4), V('b', 1, 70, 1.3), V('c', -1, 60, 0.9), V('d', 0, 0, 1.2),
    ];
    const out = aggregateVotes(votes);
    expect(out.totalModels).toBe(4);
    expect(out.structuralAbsent).toBe(0);
    expect(out.participation).toBeCloseTo(3.6 / 4.8, 2);
  });

  it('weight-0 shadow seats stay excluded from the denominator (mesh shadow mode)', () => {
    const votes = [
      V('a', 1, 80, 1), V('b', 1, 80, 1),
      V('mesh1', 1, 70, 0), V('mesh2', 0, 0, 0, true), // weight 0 + na both excluded
    ];
    const out = aggregateVotes(votes);
    expect(out.totalModels).toBe(2);
    // structuralAbsent counts ONLY na-flagged seats (mesh1 is excluded
    // by weight, not structural — it COULD vote once promoted)
    expect(out.structuralAbsent).toBe(1);
  });

  it('FLAT committee still reports applicable totalModels', () => {
    const out = aggregateVotes([V('a', 0, 0, 1), V('b', 0, 0, 1, true)]);
    expect(out.grade).toBe('NEUTRAL');
    expect(out.side).toBe('FLAT');
    expect(out.totalModels).toBe(1);
  });
});

// ============================================================
// 2. TAPE SEAT FALLBACK — MTF flag ON, 5m dead, 15m alive
// ============================================================
describe('v11.8 board tape seat — 15m fallback when the 5m base is dead', () => {
  // 15m candles with a clean downtrend (every bar lower) → the plain
  // 15m tape read is unambiguous SHORT.
  const down15m = Array.from({ length: 60 }, (_, i) => ({
    time: 1_700_000_000_000 + i * 15 * 60_000,
    open: 100 - i * 0.3, high: 100.4 - i * 0.3, low: 99.6 - i * 0.3,
    close: 100 - i * 0.3 - 0.15, volume: 1000,
  }));

  it('tapeMTFFromBase returns null without a 5m base (the board\'s exact dead case)', () => {
    expect(tapeMTFFromBase(null, down15m, null)).toBeNull();
    expect(tapeMTFFromBase([], down15m, null)).toBeNull();
  });

  it('the MTF seat fn degrades to a REAL 15m vote when tapeMTF is null but ctx.tape exists', async () => {
    // This is the models.js internal fallback the board now exercises
    // (old board code skipped the injection; the new condition
    // (enr.tapeMTF || enr.tape) lets the seat vote 15m-only).
    // The registry builds at import time with the env flag — re-import
    // the module with the flag ON to get the tape-mtf seat.
    vi.resetModules();
    vi.stubEnv('AI_ENABLE_MTF_CONFLUENCE', 'true');
    const { MODELS: M2, mtfConfluenceEnabled } = await import('../server/ai/models.js');
    expect(mtfConfluenceEnabled()).toBe(true);
    const seat = M2.find(m => m.id === 'tape-mtf');
    expect(seat).toBeTruthy();

    // Build the plain 15m tape snapshot (exactly what the board's
    // enrichment produces when only fetchYahooIntradayCandles succeeded)
    const { computeIndicatorsFromCandles } = await import('../server/ai/lib/indicators.js');
    const li = computeIndicatorsFromCandles(down15m);
    const t = {
      ltp: li.ltp, ema10: li.ema10, ema20: li.ema20, rsi: li.rsi,
      macdHist: li.macd?.hist ?? null, macdSlope: li.macd?.histSlope ?? null,
      vwap: null, last3Pct: -0.45,
    };
    // The degraded vote: fn receives {market, tape, tapeMTF: null}
    const v = seat!.fn!({ market: 'INDIA', tape: t, tapeMTF: null } as never);
    expect(v.dir).toBe(-1);
    expect(v.conf).toBeGreaterThan(0);
    // 15m-labelled reasons prove the honest degrade (not "unavailable")
    expect(JSON.stringify(v.reasons)).toContain('15m');
    // and the same seat under the MTF flag must NOT carry na on India
    expect((v as { na?: boolean }).na).toBeUndefined();
    vi.unstubAllEnvs();
  });

  it('resampleCandles keeps bucket alignment (the MTF builder primitive)', () => {
    // hour-aligned start (epoch-boundary buckets — exactly like Yahoo)
    const t0 = Math.floor(1_700_000_000_000 / 3_600_000) * 3_600_000;
    const five = Array.from({ length: 240 }, (_, i) => ({
      time: t0 + i * 5 * 60_000,
      open: 100, high: 101, low: 99, close: 100.5, volume: 10,
    }));
    const h1 = resampleCandles(five, 60)!;
    expect(h1).toBeTruthy();
    expect(h1.length).toBe(20);
    expect(h1[0].volume).toBe(120); // 12×5m bars per hour
  });
});

// ============================================================
// 3. OPTION-CHAIN CTX GATE — real chains vote, synthetic never
// ============================================================
describe('v11.8 OptionsFlow — real-chain gate', () => {
  const optionsSeat = MODELS.find(m => m.id === 'options');
  it('a REAL nse chain (pcr 1.55 extreme) → contrarian bullish vote', () => {
    // pcr 1.55 → +1.0 contrarian bull; maxPain 1.6% ABOVE spot → +0.7
    // gravity up; oiSkew neutral (null) — a clean net-bullish read.
    const v = optionsSeat!.fn!({ market: 'INDIA', symbol: 'NIFTY', ltp: 24800, options: { pcr: 1.55, maxPain: 25200, ivPercentile: 30, oiSkew: null } } as never);
    expect(v.dir).toBe(1);
    expect(v.conf).toBeGreaterThanOrEqual(48);
    expect((v as { na?: boolean }).na).toBeUndefined();
    expect(JSON.stringify(v.reasons)).toContain('contrarian bullish');
  });

  it('no options ctx → structural abstain carries na:true (out of the denominator)', () => {
    const v = optionsSeat!.fn!({ market: 'CRYPTO', symbol: 'BTC' } as never);
    expect(v.dir).toBe(0);
    expect(v.conf).toBe(0);
    expect((v as { na?: boolean }).na).toBe(true);
  });

  it('the cache gate rejects bs-model synthetic sources (REAL_CHAIN_RE)', async () => {
    // Direct unit check of the regex contract the board helper uses.
    const REAL_CHAIN_RE = /^(nse|bse)(-|$)/;
    expect(REAL_CHAIN_RE.test('nse')).toBe(true);
    expect(REAL_CHAIN_RE.test('bse')).toBe(true);
    expect(REAL_CHAIN_RE.test('nse-weekly')).toBe(true);
    expect(REAL_CHAIN_RE.test('bs-model-nifty')).toBe(false);
    expect(REAL_CHAIN_RE.test('bs-model-sensex-always')).toBe(false);
    expect(REAL_CHAIN_RE.test('synthetic')).toBe(false);
  });
});

// ============================================================
// 4. BINANCE DEPTH FALLBACK — labeled proxy when CoinDCX REST dies
// ============================================================
describe('v11.8 Binance depth fallback', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('getOrderbook falls back to the Binance USDT proxy when both CoinDCX URLs fail — honestly labeled', async () => {
    // CoinDCX hosts fail, Binance answers a deep two-sided book
    vi.stubGlobal('fetch', vi.fn(async (url: unknown) => {
      const u = String(url);
      if (u.includes('coindcx.com')) throw new Error('blocked from datacenter');
      if (u.includes('binance.com')) return {
        ok: true,
        json: async () => ({
          bids: [['60000', '2'], ['59999', '1'], ['59998', '1']],
          asks: [['60002', '0.5'], ['60003', '0.2']],
        }),
      };
      throw new Error(`unexpected url ${u}`);
    }));
    const ob = await getOrderbook('BTC');
    expect(ob.ok).toBe(true);
    expect(ob.source).toBe('binance-usdt-proxy');
    expect(ob.bidVol).toBe(4);
    expect(ob.askVol).toBe(0.7);
    // bid-heavy: (4-0.7)/4.7 ≈ +63.8% — the InstFlow depthShare ≈ 0.85
    expect(ob.imbalancePct).toBeGreaterThan(50);
    expect(ob.read).toContain('Binance USDT book (proxy');
    vi.unstubAllGlobals();
  });

  it('getOrderbook prefers the REAL CoinDCX INR book when it answers', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: unknown) => {
      const u = String(url);
      if (u.includes('coindcx.com')) return {
        ok: true,
        json: async () => ({
          bids: [{ price: '5000000', quantity: '1.5' }], asks: [{ price: '5000100', quantity: '1.4' }],
        }),
      };
      throw new Error(`binance should NOT be called when coindcx answers: ${u}`);
    }));
    const ob = await getOrderbook('BTC');
    expect(ob.ok).toBe(true);
    expect(ob.source).toBe('coindcx-inr');
    vi.unstubAllGlobals();
  });

  it('both hosts dead → honest failure (ok:false)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('dead'); }));
    const ob = await getOrderbook('BTC');
    expect(ob.ok).toBe(false);
    vi.unstubAllGlobals();
  });

  it('a rescaled Binance ladder keeps wall distances in the INR domain', () => {
    // readDepth rescales by ltp/mid — unit-check the math end to end
    // via analyzeDepth on a synthetic rescaled ladder.
    const midUsdt = 60000, ltpInr = 5_100_000; // factor 85
    const f = ltpInr / midUsdt;
    const bids = Array.from({ length: 25 }, (_, i) => ({ price: (59999 - i * 5) * f, qty: i === 5 ? 20 : 2 }));
    const asks = Array.from({ length: 25 }, (_, i) => ({ price: (60001 + i * 5) * f, qty: 0.1 }));
    const d = analyzeDepth({ bids, asks, ltp: ltpInr, now: Date.now() });
    expect(d.ok).toBe(true);
    // near-unanimous bid-side book
    expect(d.imbalanceTop5).toBeGreaterThan(0.9);
    // the bid wall sits 5 USDT-levels (≈0.04%) below the INR anchor
    const wall = (d.bidWalls || [])[0];
    expect(wall).toBeTruthy();
    const distPct = Math.abs((ltpInr - (wall!.price ?? 0)) / ltpInr) * 100;
    expect(distPct).toBeGreaterThan(0.01);
    expect(distPct).toBeLessThan(0.1);
  });
});

// ============================================================
// 5. MESH `na` MARKS — structural seats out of the denominator
// ============================================================
describe('v11.8 mesh seats — structural market gates carry na', () => {
  it('InstFlowPro on CRYPTO → na (Quiver serves the global desk only)', () => {
    const v = instFlowProVote({ market: 'CRYPTO', symbol: 'BTC' } as never) as { dir: number; na?: boolean };
    expect(v.dir).toBe(0);
    expect(v.na).toBe(true);
  });
  it('TechConsensus on CRYPTO → na; on INDIA it is applicable (may abstain for data, no na)', () => {
    const v = techConsensusVote({ market: 'CRYPTO', symbol: 'BTC' } as never) as { dir: number; na?: boolean };
    expect(v.na).toBe(true);
    const vi = techConsensusVote({ market: 'INDIA', symbol: 'RELIANCE' } as never) as { dir: number; na?: boolean };
    expect(vi.na).toBeUndefined(); // data-missing abstain — stays in the denominator
  });
  it('FundaProPlus on CRYPTO → na', () => {
    const v = fundaProPlusVote({ market: 'CRYPTO', symbol: 'BTC' } as never) as { dir: number; na?: boolean };
    expect(v.na).toBe(true);
  });
  it('CryptoOnChainPro on INDIA → na (on-chain serves crypto desks)', () => {
    const v = cryptoOnChainProVote({ market: 'INDIA', symbol: 'NIFTY' } as never) as { dir: number; na?: boolean };
    expect(v.na).toBe(true);
  });
});

// ============================================================
// 6. END-TO-END — the live 2026-09-18 CRYPTO board, re-scored
// ============================================================
describe('v11.8 end-to-end — the live crypto board re-scored with the fixes', () => {
  it('same live votes, na marks applied → the exact confidence lift the user gets', () => {
    // Snapshot of the live ENA card (2026-09-18): 6 voters, agreement 0.87,
    // OLD participation 0.47 → conf 34 (NEUTRAL, quorum-diluted).
    const liveVotes = [
      { id: 'trend', dir: 1, conf: 100, weight: 1.05 },
      { id: 'momentum', dir: 1, conf: 88, weight: 1.04 },
      { id: 'volume', dir: 1, conf: 44, weight: 1.2 },
      { id: 'pattern', dir: 1, conf: 67, weight: 1.1 },
      { id: 'smc', dir: 1, conf: 70.5, weight: 0.88 },
      { id: 'regime', dir: -1, conf: 62, weight: 0.8 },
      { id: 'volatility', dir: 0, conf: 0, weight: 1.08 },
      { id: 'sr', dir: 0, conf: 0, weight: 1.375 },
      { id: 'sentiment', dir: 0, conf: 0, weight: 0.7 },
      { id: 'instflow', dir: 0, conf: 0, weight: 0.88 },
      { id: 'options', dir: 0, conf: 0, weight: 1.0, na: true },
      { id: 'tape-mtf', dir: 0, conf: 0, weight: 1.36, na: true },
      { id: 'fundamentals', dir: 0, conf: 0, weight: 0.5, na: true },
    ].map(v => ({ ...v, reasons: [] }));
    const out = aggregateVotes(liveVotes);
    // participation 0.47 → ~0.70+ (the denominator dropped the 3 structural seats)
    expect(out.participation).toBeGreaterThanOrEqual(0.6);
    expect(out.confidence).toBeGreaterThanOrEqual(38);
    expect(out.summary).toContain('6/10 models voting');
    // still honest about the split committee (regime disagrees)
    expect(out.agreement).toBeCloseTo(0.87, 1);
  });
});
