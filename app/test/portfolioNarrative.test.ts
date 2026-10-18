// ============================================================
// test/portfolioNarrative.test.ts — ACCURACY-PLAN PHASE 4
// ------------------------------------------------------------
// LOCKED HERE (the portfolio AI overlay):
//   • portfolioRedFlags (PURE): market concentration × live regime
//     (India ≥50% + BEARISH NIFTY → flag; crypto ≥35% + BEARISH BTC
//     → flag), health-grade concentration risk, and the "top holding's
//     AI view flipped bearish" nudge (weight ≥10%, SHORT/FLIP views;
//     ≥20% escalates to high) — clean portfolio → zero flags
//   • narratePortfolio: quant-fallback narrative when the LLM layer
//     is unavailable (honest degrade, source 'quant-fallback');
//     injected-LLM path returns source 'llm'
//   • buildPortfolioNarration: quotes the client's OWN numbers, lists
//     the red flags verbatim, never asks the LLM to invent new ones
//   • buildPortfolioDigestText: the /portfolio telegram digest shape
// Hermetic — the LLM is injected, no network.
// ============================================================
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---- hermetic store (no disk; portfolioSync reads via store.js) ----
const _disk = vi.hoisted(() => new Map());
vi.mock('../server/lib/store.js', () => ({
  loadJSON: (f: string, d: unknown) => (_disk.has(f) ? structuredClone(_disk.get(f)) : structuredClone(d)),
  saveJSON: (f: string, v: unknown) => { _disk.set(f, v); },
}));
// signals.js is heavy — mock the regime + board surface the narrative
// route/webhook consume (portfolioNarrative imports buildRegime for the
// route path only; tests inject regimes directly).
vi.mock('../server/ai/signals.js', () => ({
  buildRegime: vi.fn(async () => null),
  getSignals: vi.fn(async () => ({ signals: [] })),
}));

const { portfolioRedFlags, narratePortfolio, buildPortfolioNarration, buildPortfolioDigestText } =
  await import('../server/ai/portfolioNarrative.js');

const BEAR = { label: 'BEARISH', regime: 'BEARISH' };
const BULL = { label: 'BULLISH', regime: 'BULLISH' };

beforeEach(() => {
  _disk.clear();
});

// ============================================================
// 1. The red-flag engine
// ============================================================
describe('portfolioRedFlags — concentration × regime × AI views', () => {
  it('India ≥50% in a BEARISH NIFTY regime → INDIA_BEAR_REGIME warn', () => {
    const flags = portfolioRedFlags(
      { marketSplit: { india: 60, usa: 20, crypto: 20 }, health: { grade: 'BALANCED' } },
      { regimes: { INDIA: BEAR, CRYPTO: BULL } },
    );
    expect(flags.some(f => f.code === 'INDIA_BEAR_REGIME')).toBe(true);
    const f = flags.find(x => x.code === 'INDIA_BEAR_REGIME')!;
    expect(f.level).toBe('warn');
    expect(f.title).toContain('60%');
  });

  it('crypto ≥35% in a BEARISH BTC regime → CRYPTO_BEAR_REGIME', () => {
    const flags = portfolioRedFlags(
      { marketSplit: { india: 30, usa: 30, crypto: 40 }, health: { grade: 'BALANCED' } },
      { regimes: { INDIA: BULL, CRYPTO: BEAR } },
    );
    expect(flags.some(f => f.code === 'CRYPTO_BEAR_REGIME')).toBe(true);
  });

  it('bullish / neutral regimes never flag the same exposure', () => {
    const flags = portfolioRedFlags(
      { marketSplit: { india: 70, crypto: 40 }, health: { grade: 'BALANCED' } },
      { regimes: { INDIA: BULL, CRYPTO: BULL } },
    );
    expect(flags.some(f => f.code.includes('BEAR_REGIME'))).toBe(false);
  });

  it('EGG-IN-ONE-BASKET grade → high-severity concentration flag', () => {
    const flags = portfolioRedFlags(
      { marketSplit: { india: 100 }, health: { grade: 'EGG-IN-ONE-BASKET' }, topWeight: 65 },
      {},
    );
    const f = flags.find(x => x.code === 'GRADE_EGG_IN_ONE_BASKET');
    expect(f).toBeTruthy();
    expect(f!.level).toBe('high');
  });

  it('a ≥10% holding with a fresh SHORT ensemble view → HOLDING_AI_BEARISH; ≥20% escalates high', () => {
    const holdings = [
      { label: 'BTC', group: 'crypto', weightPct: 25 },
      { label: 'RELIANCE', group: 'india', weightPct: 12 },
      { label: 'TCS', group: 'india', weightPct: 8 }, // below the 10% bar — never flagged
    ];
    const flags = portfolioRedFlags(
      { marketSplit: { india: 50 }, health: { grade: 'BALANCED' }, holdings },
      { aiViews: { BTC: { side: 'SHORT', confidence: 72, grade: 'ACTION' }, RELIANCE: { side: 'FLIP', confidence: 68 }, TCS: { side: 'SHORT', confidence: 80 } } },
    );
    const btc = flags.find(f => f.code === 'HOLDING_AI_BEARISH' && f.title.startsWith('BTC'));
    const rel = flags.find(f => f.code === 'HOLDING_AI_BEARISH' && f.title.startsWith('RELIANCE'));
    const tcs = flags.find(f => f.code === 'HOLDING_AI_BEARISH' && f.title.startsWith('TCS'));
    expect(btc).toBeTruthy();
    expect(btc!.level).toBe('high'); // 25% ≥ 20%
    expect(rel).toBeTruthy();
    expect(rel!.level).toBe('warn'); // 12% in [10,20)
    expect(tcs).toBeUndefined(); // 8% < 10% — too small to nag about
  });

  it('a clean balanced portfolio in bullish regimes → ZERO flags', () => {
    const flags = portfolioRedFlags(
      { marketSplit: { india: 40, usa: 35, crypto: 25 }, health: { grade: 'BALANCED' }, holdings: [{ label: 'X', group: 'india', weightPct: 15 }] },
      { regimes: { INDIA: BULL, CRYPTO: BULL }, aiViews: { X: { side: 'LONG', confidence: 70 } } },
    );
    expect(flags).toEqual([]);
  });

  it('high-severity flags sort before warns', () => {
    const flags = portfolioRedFlags(
      { marketSplit: { india: 100 }, health: { grade: 'EGG-IN-ONE-BASKET' }, topWeight: 65 },
      { regimes: { INDIA: BEAR } },
    );
    expect(flags[0].level).toBe('high');
  });
});

// ============================================================
// 2. The narration
// ============================================================
describe('narratePortfolio — quant-computes, LLM-narrates', () => {
  it('LLM down → honest quant-fallback narrative with the flags listed', async () => {
    const out = await narratePortfolio(
      { insights: { health: { grade: 'BALANCED' }, diversificationScore: 61 }, redFlags: [{ level: 'warn', code: 'X', title: 'T1', detail: 'D1' }], holdings: [] },
      { askLLM: async () => { throw new Error('no key'); } },
    );
    expect(out.ok).toBe(true);
    expect(out.source).toBe('quant-fallback');
    expect(out.narrative).toContain('T1');
    expect(out.narrative).toContain('not a trade call');
  });

  it('LLM up → its text verbatim, source llm', async () => {
    const out = await narratePortfolio(
      { insights: {}, redFlags: [], holdings: [] },
      { askLLM: async () => ' PORTFOLIO COACH NOTE ' },
    );
    expect(out.source).toBe('llm');
    expect(out.narrative).toBe('PORTFOLIO COACH NOTE');
  });

  it('the prompt quotes the client numbers + flags verbatim, forbids inventing', () => {
    const p = buildPortfolioNarration({
      insights: { health: { grade: 'BALANCED' }, diversificationScore: 61, marketSplit: { india: 55, usa: 25, crypto: 20 } },
      redFlags: [{ level: 'warn', code: 'X', title: 'THE FLAG', detail: 'THE DETAIL' }],
      holdings: [{ label: 'BTC', group: 'crypto', weightPct: 30, plPct: 12.5 }],
      totalValueINR: 500000,
    });
    expect(p).toContain('THE FLAG');
    expect(p).toContain('BTC (crypto): 30.0% · P&L +12.5%');
    expect(p).toContain('55% India');
    expect(p).toContain('do not invent new ones');
    expect(p).toContain('NEVER a buy/sell call on savings');
  });
});

// ============================================================
// 3. The /portfolio telegram digest
// ============================================================
describe('buildPortfolioDigestText — the two-way /portfolio answer', () => {
  it('net worth + categories + flags + the not-a-trade-call note', async () => {
    const t = await buildPortfolioDigestText({
      netWorth: { totalValueINR: 812345, holdingCount: 17, valuedCount: 15, categories: [{ category: 'Equity', valueINR: 400000, pct: 49.2 }, { category: 'Crypto', valueINR: 300000, pct: 36.9 }] },
      topHoldings: [{ label: 'BTC', group: 'crypto', weightPct: 40 }],
      regimes: { INDIA: BULL, CRYPTO: BEAR },
    });
    expect(t).toContain('PORTFOLIO DIGEST');
    expect(t).toContain('8,12,345'); // en-IN locale grouping
    expect(t).toContain('Equity');
    // BTC 30% + category implies crypto-heavy → the BEARISH BTC regime flag fires
    expect(t).toContain('Crypto exposure');
    expect(t).toContain('not a trade call');
  });

  it('empty snapshot → honest empty-category line, no crash', async () => {
    const t = await buildPortfolioDigestText({ netWorth: {} });
    expect(t).toContain('sync pehle karo');
    expect(t).toContain('koi nahi');
  });
});
