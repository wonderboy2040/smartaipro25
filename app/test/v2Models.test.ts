// ============================================================
// test/v2Models.test.ts — V2 SIGNAL-ACCURACY UPGRADE
// ------------------------------------------------------------
// Pins the 3 new ensemble seats (Phase 1-3) + the Phase 4 wiring:
//   • SentimentPulse — RSS lexicon / F&G / funding scoring + votes
//   • InstFlow — FII/DII net (India) + sustained orderbook imbalance
//   • FundaCheck — P/E vs sector avg + earnings surprise proxy
//   • MODELS[] registry: flag OFF = the exact 11-model bus,
//     flag ON = 14 models; ensemble math + backtest stay sane.
// All data is INJECTED via __testables — no network in unit tests
// (network behavior is probed by scripts/backtest_ab_v2.mjs).
// ============================================================
import { describe, it, expect, beforeEach } from 'vitest';
import { aggregateVotes } from '../server/ai/ensemble.js';
import { MODELS, V2_MODEL_IDS } from '../server/ai/models.js';
import { sentimentVote, sentimentContextFor, absorbCouncilSentiment, refreshSentiment, __testables as sentT } from '../server/ai/sentiment.js';
import { instFlowVote, __testables as flowT } from '../server/ai/instFlow.js';
import { fundamentalsVote, __testables as fundT } from '../server/ai/fundamentals.js';

const voteShape = (out, name) => {
  expect(out, `${name} returned a vote`).toBeTruthy();
  expect(typeof out.dir, `${name} dir`).toBe('number');
  expect([1, 0, -1], `${name} dir domain`).toContain(out.dir);
  expect(out.conf, `${name} conf 0-100`).toBeGreaterThanOrEqual(0);
  expect(out.conf, `${name} conf 0-100`).toBeLessThanOrEqual(100);
  expect(Array.isArray(out.reasons), `${name} reasons[]`).toBe(true);
};

// ------------------------------------------------------------
describe('Phase 1 — SentimentPulse', () => {
  beforeEach(() => sentT.__clear());

  it('cold cache → honest abstain (never an invented number)', () => {
    const out = sentimentVote({ market: 'INDIA', symbol: 'RELIANCE' });
    voteShape(out, 'cold India');
    expect(out.dir).toBe(0);
    expect(out.conf).toBe(0);
    expect(out.reasons.join(' ')).toMatch(/abstain/i);
  });

  it('symbol-specific bullish headlines → LONG vote, capped below the loud models', () => {
    sentT.__setCache('INDIA', {
      market: 'INDIA', score: 10, headlineCount: 44, sources: ['www.moneycontrol.com'],
      bySymbol: { RELIANCE: { score: 80, headlines: 3, top: ['Reliance surges to record high'] } },
    });
    const out = sentimentVote({ market: 'INDIA', symbol: 'RELIANCE' });
    voteShape(out, 'warm India');
    expect(out.dir).toBe(1);
    expect(out.conf).toBeGreaterThanOrEqual(38);
    expect(out.conf).toBeLessThanOrEqual(58); // 0.7-weight context model, never the loudest voice
  });

  it('symbol without own headlines votes the market mood at reduced conf', () => {
    sentT.__setCache('INDIA', {
      market: 'INDIA', score: 40, headlineCount: 30, sources: ['x'],
      bySymbol: {},
    });
    const out = sentimentVote({ market: 'INDIA', symbol: 'SBIN' });
    expect(out.dir).toBe(1); // 40*0.6=24 ≥ 15
    expect(out.reasons.join(' ')).toMatch(/market mood/i);
  });

  it('crypto: Extreme Fear + crowded shorts → contrarian LONG', () => {
    sentT.__setCache('CRYPTO', {
      market: 'CRYPTO', score: 55, sources: ['F&G 18 Extreme Fear — contrarian long territory', 'perp funding -8bps/8h — shorts pay, squeeze fuel'],
    });
    const out = sentimentVote({ market: 'CRYPTO', symbol: 'BTC' });
    voteShape(out, 'warm crypto');
    expect(out.dir).toBe(1);
    // FUTURES desk reads the same crypto sentiment (perps share it)
    const fut = sentimentVote({ market: 'FUTURES', symbol: 'BTC' });
    expect(fut.dir).toBe(1);
  });

  it('muddled sentiment (|score| < 15) → abstain, not a guess', () => {
    sentT.__setCache('CRYPTO', { market: 'CRYPTO', score: 5, sources: ['F&G 50 neutral zone'] });
    const out = sentimentVote({ market: 'CRYPTO', symbol: 'ETH' });
    expect(out.dir).toBe(0);
    expect(out.reasons.join(' ')).toMatch(/muddled|abstain/i);
  });

  it('lexicon scores bullish vs bearish headlines in the right direction', () => {
    const bull = sentT.scoreHeadline('Infosys surges to record high after strong upgrade');
    const bear = sentT.scoreHeadline('Wipro plunges as fraud probe triggers downgrade');
    expect(bull).toBeGreaterThan(40);
    expect(bear).toBeLessThan(-40);
  });

  it('symbol alias matching catches company names the scanner cannot', () => {
    expect(sentT.matchesSymbol('infosys beats estimates', 'INFY')).toBe(true);
    expect(sentT.matchesSymbol('tata motors rallies on ev push', 'TATAMOTORS')).toBe(true);
    expect(sentT.matchesSymbol('infosys beats estimates', 'TCS')).toBe(false);
  });

  it('council context line + LLM absorption fold back into the cache', () => {
    sentT.__setCache('INDIA', {
      market: 'INDIA', score: 20, headlineCount: 12, sources: ['x'],
      bySymbol: { RELIANCE: { score: 60, headlines: 2, top: [] } },
    });
    const ctxLine = sentimentContextFor('INDIA');
    expect(ctxLine).toBeTruthy();
    expect(ctxLine).toMatch(/RELIANCE \+60|RELIANCE \+60/);
    const ok = absorbCouncilSentiment({ score: -30, model: 'gemini' }, 'INDIA');
    expect(ok).toBe(true);
    const out = sentimentVote({ market: 'INDIA', symbol: 'RELIANCE' });
    expect(out.reasons.join(' ')).toMatch(/LLM-refined by gemini/);
  });

  it('refreshSentiment stays null-tolerant when every feed is unreachable', async () => {
    const out = await refreshSentiment('INDIA'); // sandbox/offline → honest null
    expect(out === null || typeof out === 'object').toBe(true);
  });
});

// ------------------------------------------------------------
describe('Phase 2 — InstFlow', () => {
  beforeEach(() => { flowT.__clearFii(); flowT.__clearBooks(); });

  it('cold caches (both desks) → honest abstain', () => {
    voteShape(instFlowVote({ market: 'INDIA', symbol: 'RELIANCE' }), 'cold India');
    voteShape(instFlowVote({ market: 'CRYPTO', symbol: 'BTC' }), 'cold crypto');
    expect(instFlowVote({ market: 'INDIA', symbol: 'RELIANCE' }).dir).toBe(0);
    expect(instFlowVote({ market: 'CRYPTO', symbol: 'BTC' }).dir).toBe(0);
  });

  it('FII+DII strong net-buy day → market-wide LONG tilt (regime-class)', () => {
    flowT.__setFii({ asOf: '12-Sep-2026', fiiNet: 3204.5, diiNet: -800, combinedNet: 2404.5 });
    const out = instFlowVote({ market: 'INDIA', symbol: 'ANY' });
    expect(out.dir).toBe(1);
    expect(out.conf).toBeLessThanOrEqual(56);
    expect(out.reasons.join(' ')).toMatch(/net-buy/);
  });

  it('mild institutional day (below ±1500Cr) → abstain with the figures shown', () => {
    flowT.__setFii({ asOf: '12-Sep-2026', fiiNet: 600, diiNet: -100, combinedNet: 500 });
    const out = instFlowVote({ market: 'INDIA', symbol: 'ANY' });
    expect(out.dir).toBe(0);
    expect(out.reasons.join(' ')).toMatch(/below conviction threshold/);
  });

  it('sustained bid-heavy book (>60% across polls) → LONG; single poll is not sustained', () => {
    flowT.__pushBook('BTC', [{ depthShare: 0.68 }, { depthShare: 0.72 }, { depthShare: 0.65 }]);
    const out = instFlowVote({ market: 'CRYPTO', symbol: 'BTC' });
    expect(out.dir).toBe(1);
    expect(out.reasons.join(' ')).toMatch(/68% of depth across 3 polls/);

    flowT.__clearBooks();
    flowT.__pushBook('BTC', [{ depthShare: 0.70 }]); // one poll only
    const single = instFlowVote({ market: 'CRYPTO', symbol: 'BTC' });
    expect(single.dir).toBe(0);
    expect(single.reasons.join(' ')).toMatch(/no sustained|not polled/i);
  });

  it('mixed depth → abstain (the honest-abstain-at-neutral pattern)', () => {
    flowT.__pushBook('ETH', [{ depthShare: 0.55 }, { depthShare: 0.48 }, { depthShare: 0.62 }]);
    expect(instFlowVote({ market: 'CRYPTO', symbol: 'ETH' }).dir).toBe(0);
  });

  it('FUTURES desk votes the spot book as a flagged proxy with lower conf', () => {
    flowT.__pushBook('BTC', [{ depthShare: 0.68 }, { depthShare: 0.72 }, { depthShare: 0.65 }]);
    const spot = instFlowVote({ market: 'CRYPTO', symbol: 'BTC' });
    const fut = instFlowVote({ market: 'FUTURES', symbol: 'BTC' });
    expect(fut.dir).toBe(spot.dir);
    expect(fut.reasons.join(' ')).toMatch(/spot-book proxy/);
    expect(fut.conf).toBeLessThanOrEqual(spot.conf);
  });
});

// ------------------------------------------------------------
describe('Phase 3 — FundaCheck (India swing only)', () => {
  beforeEach(() => fundT.__clear());

  it('intraday board ctx (no fundamentals attached) → abstains BY DESIGN', () => {
    const out = fundamentalsVote({ market: 'INDIA', symbol: 'RELIANCE' });
    voteShape(out, 'board ctx');
    expect(out.dir).toBe(0);
    expect(out.reasons.join(' ')).toMatch(/intraday desk by design/);
  });

  it('non-India markets → abstains', () => {
    expect(fundamentalsVote({ market: 'CRYPTO', symbol: 'BTC', fundamentals: { pe: 10 } }).dir).toBe(0);
    expect(fundamentalsVote({ market: 'FUTURES', symbol: 'BTC', fundamentals: { pe: 10 } }).dir).toBe(0);
  });

  it('cheap vs sector + earnings compounding → LONG (value+catalyst)', () => {
    const out = fundamentalsVote({
      market: 'INDIA', symbol: 'SBIN',
      fundamentals: { pe: 10.6, sector: 'BANKING', sectorAvgPe: 25.1, earnGrowth: 0.12 },
    });
    expect(out.dir).toBe(1);
    expect(out.conf).toBeLessThanOrEqual(56);
    expect(out.reasons.join(' ')).toMatch(/value\+catalyst|discounted/);
  });

  it('premium multiple + shrinking earnings → SHORT (de-rating risk)', () => {
    const out = fundamentalsVote({
      market: 'INDIA', symbol: 'RELIANCE',
      fundamentals: { pe: 22.8, sector: 'ENERGY', sectorAvgPe: 9.2, earnGrowth: -0.224 },
    });
    expect(out.dir).toBe(-1);
    expect(out.reasons.join(' ')).toMatch(/de-rating risk/);
  });

  it('premium multiple but growth supports it → abstain', () => {
    const out = fundamentalsVote({
      market: 'INDIA', symbol: 'TCS',
      fundamentals: { pe: 28, sector: 'IT', sectorAvgPe: 23, earnGrowth: 0.18 },
    });
    expect(out.dir).toBe(0);
  });

  it('missing sector average (<3 peers) → honest abstain, not a guess', () => {
    const out = fundamentalsVote({
      market: 'INDIA', symbol: 'ONGC',
      fundamentals: { pe: 8, sector: 'ENERGY', sectorAvgPe: null, earnGrowth: 0.05 },
    });
    expect(out.dir).toBe(0);
    expect(out.reasons.join(' ')).toMatch(/sector-average P\/E/);
  });

  it('sectorAvgPe needs ≥3 priced peers and excludes the subject', () => {
    fundT.__set('TCS', { pe: 28, sector: 'IT' });
    fundT.__set('INFY', { pe: 24, sector: 'IT' });
    expect(fundT.sectorAvgPe('IT', 'TCS')).toBeNull(); // only 1 peer
    fundT.__set('WIPRO', { pe: 20, sector: 'IT' });
    fundT.__set('HCLTECH', { pe: 25, sector: 'IT' });
    expect(fundT.sectorAvgPe('IT', 'TCS')).toBeCloseTo((24 + 20 + 25) / 3, 5);
  });
});

// ------------------------------------------------------------
describe('Phase 4 — registry wiring + ensemble integration', () => {
  it('MODELS bus in this process matches the AI_ENABLE_V2_MODELS flag', () => {
    // vitest runs without the flag set → the exact production bus
    expect(MODELS.length).toBe(13); // v21.7.0: +MACrossTracker (12 + macross)
    expect(MODELS.some(m => m.id === 'macross')).toBe(true); // v21.7.0 Issue-2
    expect(MODELS.some(m => m.id === 'sentiment')).toBe(false);
    // flag-on coverage is enforced by the spawn test below
  });

  it('AI_ENABLE_V2_MODELS=true spawns a 15-model bus with all 3 v2 seats', async () => {
    const { execFileSync } = await import('node:child_process');
    let out = '';
    try {
      out = execFileSync('node', ['-e',
        `import('./server/ai/models.js').then(m => {
          console.log(JSON.stringify({ n: m.MODELS.length, ids: m.MODELS.map(x => x.id), v2: m.v2ModelsEnabled() }));
        })`], { env: { ...process.env, AI_ENABLE_V2_MODELS: 'true' }, encoding: 'utf8', timeout: 20000 });
    } catch (e) {
      out = e.stdout || '';
    }
    const parsed = JSON.parse(out.trim().split('\n').pop());
    expect(parsed.v2).toBe(true);
    expect(parsed.n).toBe(16); // v21.7.0: +MACrossTracker (13 base + 3 v2 seats)
    for (const id of V2_MODEL_IDS) expect(parsed.ids).toContain(id);
    // weights per the plan: 0.7 / 0.8 / 0.5
    expect(parsed.ids).toContain('sentiment');
    expect(parsed.ids).toContain('instflow');
    expect(parsed.ids).toContain('fundamentals');
  });

  it('v2 votes integrate with the ensemble math — direction pinned both ways', () => {
    // a full-committee bull confluence WITH the 3 v2 seats aligned
    const base = [
      { id: 'trend', name: 'T', role: 'r', weight: 1.4, dir: 1, conf: 80, reasons: [] },
      { id: 'momentum', name: 'M', role: 'r', weight: 1.3, dir: 1, conf: 78, reasons: [] },
      { id: 'volume', name: 'V', role: 'r', weight: 1.2, dir: 1, conf: 76, reasons: [] },
      { id: 'sr', name: 'S', role: 'r', weight: 1.1, dir: 1, conf: 74, reasons: [] },
      { id: 'smc', name: 'X', role: 'r', weight: 1.1, dir: 1, conf: 72, reasons: [] },
    ];
    const out11 = aggregateVotes(base);
    expect(out11.grade).toBe('STRONG');
    // high-conviction aligned v2 votes RAISE the committee conf
    const strong = aggregateVotes([
      ...base,
      { id: 'sentiment', name: 'SP', role: 'r', weight: 0.7, dir: 1, conf: 85, reasons: [] },
      { id: 'instflow', name: 'IF', role: 'r', weight: 0.8, dir: 1, conf: 84, reasons: [] },
      { id: 'fundamentals', name: 'FC', role: 'r', weight: 0.5, dir: 1, conf: 82, reasons: [] },
    ]);
    expect(strong.grade).toBe('STRONG');
    expect(strong.agreement).toBe(1);
    expect(strong.confidence).toBeGreaterThan(out11.confidence);
    // LOW-conviction aligned v2 seats dilute the weighted-average
    // conviction — the plan Phase 4 #2 observation-window behavior
    // ("initially low-confidence voters diluting agreement"): gates
    // stay unchanged, trust.js observes for 2 weeks.
    const diluted = aggregateVotes([
      ...base,
      { id: 'sentiment', name: 'SP', role: 'r', weight: 0.7, dir: 1, conf: 52, reasons: [] },
      { id: 'instflow', name: 'IF', role: 'r', weight: 0.8, dir: 1, conf: 48, reasons: [] },
      { id: 'fundamentals', name: 'FC', role: 'r', weight: 0.5, dir: 1, conf: 47, reasons: [] },
    ]);
    expect(diluted.confidence).toBeLessThan(out11.confidence);
    expect(diluted.grade).toBe('ACTION'); // borderline STRONG demotes — honest, observed, tunable later
  });

  it('abstaining v2 seats dilute participation mildly (plan: gates unchanged, observe)', () => {
    const base = [
      { id: 'trend', name: 'T', role: 'r', weight: 1.4, dir: 1, conf: 80, reasons: [] },
      { id: 'momentum', name: 'M', role: 'r', weight: 1.3, dir: 1, conf: 78, reasons: [] },
      { id: 'volume', name: 'V', role: 'r', weight: 1.2, dir: 1, conf: 76, reasons: [] },
      { id: 'sr', name: 'S', role: 'r', weight: 1.1, dir: 1, conf: 74, reasons: [] },
      { id: 'smc', name: 'X', role: 'r', weight: 1.1, dir: 1, conf: 72, reasons: [] },
    ];
    const withAbstains = aggregateVotes([
      ...base,
      { id: 'sentiment', name: 'SP', role: 'r', weight: 0.7, dir: 0, conf: 0, reasons: [] },
      { id: 'instflow', name: 'IF', role: 'r', weight: 0.8, dir: 0, conf: 0, reasons: [] },
      { id: 'fundamentals', name: 'FC', role: 'r', weight: 0.5, dir: 0, conf: 0, reasons: [] },
    ]);
    // participation 6.1/8.1 ≈ 0.753 — the plan's known effect: abstains
    // weaken the committee mandate, not zero it. Borderline STRONGs can
    // demote to ACTION during the observation window; adaptive.js will
    // start correcting weights after MIN_SAMPLE (8) settled outcomes.
    expect(withAbstains.participation).toBeGreaterThan(0.74);
    expect(withAbstains.participation).toBeLessThan(0.80);
    expect(['STRONG', 'ACTION']).toContain(withAbstains.grade);
    expect(withAbstains.confidence).toBeGreaterThan(60); // still solidly tradeable
  });

  it('v2 model fns never throw on hostile contexts (the runQuantModels contract)', () => {
    expect(() => sentimentVote(null)).not.toThrow();
    expect(() => instFlowVote({})).not.toThrow();
    expect(() => fundamentalsVote(null)).not.toThrow();
    expect(() => sentimentVote({ market: 'WEIRD', symbol: 42 })).not.toThrow();
    expect(() => instFlowVote({ market: 'WEIRD' })).not.toThrow();
  });
});
