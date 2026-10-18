// ============================================================
// test/v67-core.test.ts — LEDGER · ADAPTIVE · SMC · GEX · SWING
// ------------------------------------------------------------
// v6.7 pure-module coverage:
//   1. SHA-256 hash chain: append → verify → tamper → broken
//   2. Outcome stamping + per-model attribution stats
//   3. Adaptive Bayesian multipliers (bounds, no-data honesty)
//   4. SMC detectors (sweep / order block / FVG / vote)
//   5. GEX profile (flip, walls, expected move, model-chain skip)
//   6. Strategies: POP + payoff + straddle/strangle presence
//   7. Swing scoring + whale detection on synthetic candles
//   8. Learned-gates recommendation logic
// ============================================================
import { describe, it, expect, beforeEach } from 'vitest';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// hermetic data dir (same trick as the other suites)
process.env.SMARTAI_DATA_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '../.test-data-v67');

const { recordExecution, markOutcome, verifyLedger, ledgerStatus, modelStats, settlePositionOutcome, __setLedgerForTests, __ledgerRaw }
  = await import('../server/ai/ledger.js');
const { adaptiveMultipliers, applyAdaptiveWeights, MIN_SAMPLE } = await import('../server/ai/adaptive.js');
const { detectSweep, detectOrderBlock, detectFvg, smcVote } = await import('../server/ai/lib/smc.js');
const { computeGex, buildStrategies, analyzeChain } = await import('../server/ai/optionsDesk.js');
const { scoreSwing, detectWhale } = await import('../server/ai/swing.js');
const { learnedGates } = await import('../server/ai/backtest.js');
const { runQuantModels } = await import('../server/ai/models.js');

beforeEach(() => { __setLedgerForTests(null); });

const SIGNAL = (over = {}) => ({
  symbol: 'BTC', market: 'CRYPTO', side: 'LONG', grade: 'STRONG',
  confidence: 82, agreement: 0.8, summary: 'test',
  plan: { entry: 100, stopLoss: 96.8, target1: 103.2, target2: 106.4, riskPct: 3.2, rewardRisk: 2 },
  votes: [
    { id: 'trend', dir: 1, conf: 80 },
    { id: 'momentum', dir: 1, conf: 70 },
    { id: 'volatility', dir: -1, conf: 55 },
  ],
  ...over,
});

// ---------------- 1. hash chain ----------------
describe('ledger: SHA-256 tamper-evident chain', () => {
  it('appends entries and verifies intact', () => {
    const e1 = recordExecution(SIGNAL(), { mode: 'paper', source: 'manual' });
    const e2 = recordExecution(SIGNAL({ side: 'SHORT', symbol: 'ETH' }), { mode: 'live' });
    expect(e1.prevHash).toBeNull();
    expect(e2.prevHash).toBe(e1.hash);
    const v = verifyLedger();
    expect(v.ok).toBe(true);
    expect(v.entries).toBe(2);
    expect(v.headHash).toBe(e2.hash);
  });

  it('rejects broken input without recording', () => {
    expect(recordExecution(null, {})).toBeNull();
    expect(recordExecution({ symbol: 'X' }, {})).toBeNull();
  });

  it('detects tampering of a historical field', () => {
    recordExecution(SIGNAL(), { mode: 'paper' });
    recordExecution(SIGNAL({ symbol: 'ETH' }), { mode: 'paper' });
    const raw = __ledgerRaw();
    raw.entries[0].confidence = 99; // TAMPER
    __setLedgerForTests(raw);       // write the tampered state back
    const v = verifyLedger();
    expect(v.ok).toBe(false);
    expect(v.brokenAt).toBe(0);
  });

  it('detects chain re-linking (dropping an entry)', () => {
    recordExecution(SIGNAL(), { mode: 'paper' });
    recordExecution(SIGNAL({ symbol: 'ETH' }), { mode: 'paper' });
    const raw = __ledgerRaw();
    raw.entries.splice(0, 1); // remove the first — prev link now dangles
    __setLedgerForTests(raw);
    const v = verifyLedger();
    expect(v.ok).toBe(false);
  });
});

// ---------------- 2. outcomes + attribution ----------------
describe('ledger: outcome stamping + model stats', () => {
  it('marks outcome once (idempotent) and credits models', () => {
    const e = recordExecution(SIGNAL(), { mode: 'paper' });
    expect(e.outcome).toBeNull();
    expect(markOutcome(e.id, { r: 2.1, pnlINR: 640, reason: 'TP2' })).toBe(true);
    // second mark must NOT overwrite (outcome integrity)
    expect(markOutcome(e.id, { r: -1, pnlINR: -300, reason: 'fake' })).toBe(false);
    const raw = __ledgerRaw();
    expect(raw.entries[0].outcome.r).toBe(2.1);

    // attribution: trend/momentum voted WITH the trade and it WON → win;
    // volatility opposed and it won → loss
    const stats = modelStats();
    const by = Object.fromEntries(stats.map(s => [s.model, s]));
    expect(by.trend.wins).toBe(1);
    expect(by.momentum.wins).toBe(1);
    expect(by.volatility.losses).toBe(1);
  });

  it('settlePositionOutcome computes R from position fields', () => {
    const e = recordExecution(SIGNAL(), { mode: 'paper' });
    const p = {
      ledgerEntryId: e.id, status: 'CLOSED',
      qty: 2, initialRisk: 3.2, pnlINR: 6.4, closeReason: 'TP2', closePrice: 103.2,
    };
    expect(settlePositionOutcome(p, 'TP2')).toBe(true);
    expect(__ledgerRaw().entries[0].outcome.r).toBe(1);
    // non-closed / missing id → no-op
    expect(settlePositionOutcome({ ...p, status: 'OPEN' }, 'x')).toBe(false);
    expect(settlePositionOutcome({ ...p, ledgerEntryId: null }, 'x')).toBe(false);
  });

  it('status block reports verified + winRate', () => {
    const e1 = recordExecution(SIGNAL(), { mode: 'paper' });
    const e2 = recordExecution(SIGNAL({ symbol: 'ETH' }), { mode: 'paper' });
    markOutcome(e1.id, { r: 1 });
    markOutcome(e2.id, { r: -1 });
    const st = ledgerStatus();
    expect(st.verified).toBe(true);
    expect(st.settled).toBe(2);
    expect(st.wins).toBe(1);
    expect(st.winRate).toBe(50);
  });
});

// ---------------- 3. adaptive weights ----------------
describe('adaptive: Bayesian multipliers', () => {
  it('no/small data → multiplier exactly 1.0 (honest)', () => {
    const m = adaptiveMultipliers([{ model: 'trend', wins: 3, losses: 2 }]);
    expect(m.trend.mul).toBe(1);
    expect(m.trend.posterior).toBeNull();
  });

  it('posterior maps to bounded multipliers', () => {
    const strong = adaptiveMultipliers([{ model: 'a', wins: 18, losses: 2 }]);  // p≈0.9
    const weak = adaptiveMultipliers([{ model: 'b', wins: 2, losses: 18 }]);   // p≈0.1
    const mid = adaptiveMultipliers([{ model: 'c', wins: 8, losses: 8 }]);     // p=0.5
    expect(strong.a.mul).toBeGreaterThan(1.2);
    expect(strong.a.mul).toBeLessThanOrEqual(1.3);
    expect(weak.b.mul).toBeLessThan(0.8);
    expect(weak.b.mul).toBeGreaterThanOrEqual(0.7);
    expect(mid.c.mul).toBe(1);
    expect(MIN_SAMPLE).toBe(8);
  });

  it('applies multipliers to votes transparently', () => {
    const votes = [
      { id: 'trend', dir: 1, conf: 80, weight: 1.4 },
      { id: 'momentum', dir: 1, conf: 70, weight: 1.3 },
      { id: 'other', dir: 0, conf: 0, weight: 1 },
    ];
    const out = applyAdaptiveWeights(votes, { trend: { mul: 1.25, n: 20, posterior: 0.62 }, momentum: { mul: 0.75, n: 10, posterior: 0.38 } });
    expect(out[0].weight).toBeCloseTo(1.75, 2);
    expect(out[0].adaptiveMul).toBe(1.25);
    expect(out[1].weight).toBeCloseTo(0.98, 2);
    expect(out[2].weight).toBe(1); // dir=0 untouched
    expect(out[2].adaptiveMul).toBeUndefined();
  });
});

// ---------------- 4. SMC detectors ----------------
const mkCandles = (spec) => spec.map(([o, h, l, c, v = 100]) => ({ open: o, high: h, low: l, close: c, volume: v }));

const C = (o, h, l, c) => ({ open: o, high: h, low: l, close: c, volume: 100 });

describe('smc: liquidity sweep / order block / FVG', () => {
  it('detects a bullish sweep of a swing low (wick below, close back inside)', () => {
    const c = [];
    for (let i = 0; i < 14; i++) c.push(C(100, 101, 99, 100));
    c.push(C(100, 101, 95, 100));                     // pivot low
    for (let i = 0; i < 10; i++) c.push(C(100, 101, 97.5, 100));
    c.push(C(100, 101, 94, 99.5));                    // SWEEP
    const s = detectSweep(c);
    expect(s).not.toBeNull();
    expect(s.dir).toBe(1);
    expect(s.type).toBe('sweep-low');
    expect(s.level).toBe(95);
  });

  it('detects a bearish sweep of a swing high', () => {
    const c = [];
    for (let i = 0; i < 14; i++) c.push(C(100, 101, 99, 100));
    c.push(C(100, 105, 99, 100));                     // pivot high 105
    for (let i = 0; i < 10; i++) c.push(C(100, 102.5, 99, 100));
    c.push(C(100, 106, 99, 100.5));                   // SWEEP
    const s = detectSweep(c);
    expect(s.dir).toBe(-1);
    expect(s.type).toBe('sweep-high');
  });

  it('no sweep when price closes beyond the level (real breakout)', () => {
    const c = [];
    for (let i = 0; i < 14; i++) c.push(C(100, 101, 99, 100));
    c.push(C(100, 105, 99, 100));
    for (let i = 0; i < 10; i++) c.push(C(100, 102.5, 99, 100));
    c.push(C(100, 107, 100, 106));                    // closes above — breakout
    expect(detectSweep(c)).toBeNull();
  });

  it('detects a bullish FVG near price', () => {
    const c = [];
    for (let i = 0; i < 12; i++) c.push(C(98, 100, 97.5, 99));
    c.push(C(99, 100, 98.5, 99.5));      // A
    c.push(C(99.5, 100.2, 99, 100));     // B
    c.push(C(100.6, 101, 100.4, 100.8)); // C low 100.4 > A high 100 → FVG
    const f = detectFvg(c);
    expect(f).not.toBeNull();
    expect(f.type).toBe('bullish-fvg');
    expect(f.bottom).toBe(100);
    expect(f.top).toBe(100.4);
  });

  it('order block: displacement after a RED candle', () => {
    const c = [];
    for (let i = 0; i < 22; i++) c.push(C(100, 100.6, 99.4, 100)); // 25-candle minimum (detector guard)
    c.push(C(99.8, 100.2, 99.6, 99.5)); // RED (body -0.3) before displacement
    c.push(C(100, 102.5, 99.9, 102.3)); // big bullish displacement
    c.push(C(101.5, 102.4, 101.2, 102));
    const ob = detectOrderBlock(c);
    expect(ob).not.toBeNull();
    expect(ob.dir).toBe(1);
    expect(ob.type).toBe('bullish-ob');
  });

  it('smcVote stacks confluence with fresh sweep weighting', () => {
    const c = [];
    for (let i = 0; i < 16; i++) c.push(C(100, 101, 99, 100)); // 30-candle minimum
    c.push(C(100, 101, 95, 100));
    for (let i = 0; i < 12; i++) c.push(C(100, 101, 97.5, 100));
    c.push(C(100, 101, 94, 99.5)); // FRESH sweep low
    const v = smcVote({ candles: c });
    expect(v.dir).toBe(1);
    expect(v.conf).toBeGreaterThan(40);
    expect(v.reasons.some(r => r.includes('FRESH') || r.includes('swept'))).toBe(true);
  });

  it('smcVote abstains on flat/no-feature candles', () => {
    const c = [];
    for (let i = 0; i < 40; i++) c.push(C(100, 100.05, 99.95, 100));
    const v = smcVote({ candles: c });
    expect(v.dir).toBe(0);
    expect(v.conf).toBe(0);
  });

  it('runs inside the 11-model bus (registry integration)', () => {
    const votes = runQuantModels({
      market: 'CRYPTO', symbol: 'BTC', ltp: 100, changePct: 0, volume: 0,
      candles: mkCandles(Array.from({ length: 60 }, () => [100, 101, 99, 100])),
      ind: {}, regime: { btcChange: null }, options: null,
    });
    expect(votes.some(v => v.id === 'smc')).toBe(true);
    expect(votes.length).toBe(12); // v21.7.0: 12 quant models (aicouncil has no fn) — v9.3: +IntradayTape · v20.7.4: +StructurePro · v21.7.0: +MACrossTracker
  });
});

// ---------------- 5. GEX ----------------
// realistic 5-day premiums: ATM ≈ 110 (IV 12), step 50 — WIDE chain
// (±300) so every strategy strike (strangle wings at ±250) is real
const wideRow = (k, cOI, pOI, cL, pL) => ({ strike: k, callOI: cOI, putOI: pOI, callIV: 12, putIV: 12, callLTP: cL, putLTP: pL, callOIChange: 0, putOIChange: 0 });
const CHAIN = {
  symbol: 'NIFTY', spot: 25000, expiry: nextExp(),
  rows: [
    wideRow(24700, 20, 1600, 410, 2),
    wideRow(24750, 40, 1300, 360, 4),
    wideRow(24800, 80, 1000, 310, 8),
    wideRow(24850, 150, 800, 262, 16),
    wideRow(24900, 100, 900, 215, 30),
    wideRow(24950, 300, 600, 172, 52),
    wideRow(25000, 500, 500, 132, 132),
    wideRow(25050, 700, 300, 95, 172),
    wideRow(25100, 900, 100, 62, 215),
    wideRow(25150, 800, 150, 40, 262),
    wideRow(25200, 1000, 80, 24, 310),
    wideRow(25250, 1300, 40, 14, 360),
    wideRow(25300, 1600, 20, 8, 410),
  ],
};

function nextExp() {
  // a date a few days out (stable for BS math)
  const d = new Date(Date.now() + 5 * 86400_000);
  return d.toISOString().slice(0, 10);
}

describe('optionsDesk: GEX profile', () => {
  it('computes per-strike GEX, flip, walls, expected move', () => {
    const g = computeGex(CHAIN, 25000, 12);
    expect(g).not.toBeNull();
    expect(g.perStrike.length).toBe(13);
    // put-heavy below + call-heavy above → net GEX crosses zero → flip exists
    expect(g.gammaFlip).not.toBeNull();
    expect(g.callWall).not.toBeNull();
    expect(g.putWall).not.toBeNull();
    // expected move from ATM straddle 132+132=264 → ×0.85 = 224.4 (0.9%)
    expect(g.expectedMove.abs).toBeCloseTo(224.4, -1);
    expect(g.expectedMove.pct).toBeCloseTo(0.9, 1);
    expect(g.expectedMove.method).toBe('atm-straddle×0.85');
  });

  it('skips synthetic chains (no real OI) honestly', () => {
    const model = { ...CHAIN, rows: CHAIN.rows.map(r => ({ ...r, callOI: 0, putOI: 0 })) };
    expect(computeGex(model, 25000, 12)).toBeNull();
  });

  it('analyzeChain embeds gex when real OI exists', () => {
    const a = analyzeChain(CHAIN, 25000);
    expect(a.gex).toBeDefined();
    expect(a.maxPain).not.toBeNull();
  });
});

// ---------------- 6. strategies: POP + payoff + new builders ----------------
const DESK = {
  ok: true, symbol: 'NIFTY', spot: 25000, expiry: CHAIN.expiry, lotSize: 75,
  analytics: { pcr: 1, maxPain: 25000, atmIV: 12, ivPercentile: 30, oiSkew: 0, callOI: 1, putOI: 1 },
  rows: CHAIN.rows,
};

describe('optionsDesk: strategies with POP + payoff', () => {
  it('neutral desk builds iron condor + strangle + long straddle (low IV)', () => {
    const out = buildStrategies(DESK, { side: 'FLAT', confidence: 20, grade: 'NEUTRAL' });
    const ids = out.map(s => s.id);
    expect(ids).toContain('iron-condor');
    expect(ids).toContain('short-strangle');
    expect(ids).toContain('long-straddle');
    expect(ids).not.toContain('bull-call-spread');
  });

  it('rich IV builds the iron fly (short straddle) too', () => {
    const rich = { ...DESK, analytics: { ...DESK.analytics, ivPercentile: 70 } };
    const out = buildStrategies(rich, { side: 'FLAT', confidence: 20, grade: 'NEUTRAL' });
    expect(out.map(s => s.id)).toContain('short-straddle');
  });

  it('STRONG LONG builds directional spreads with POP + payoff points', () => {
    const out = buildStrategies(DESK, { side: 'LONG', confidence: 80, grade: 'STRONG' });
    expect(out.map(s => s.id)).toContain('bull-call-spread');
    expect(out.map(s => s.id)).toContain('long-call');
    for (const s of out) {
      expect(Array.isArray(s.payoff)).toBe(true);
      expect(s.payoff.length).toBeGreaterThanOrEqual(20);
      expect(typeof s.pop).toBe('number');
      expect(s.pop).toBeGreaterThanOrEqual(0);
      expect(s.pop).toBeLessThanOrEqual(100);
    }
    // payoff at deep-ITM for a bull call spread = width - debit (>0)
    const bcs = out.find(s => s.id === 'bull-call-spread');
    const last = bcs.payoff[bcs.payoff.length - 1];
    expect(last.pnl).toBeGreaterThan(0);
    const first = bcs.payoff[0];
    expect(first.pnl).toBeCloseTo(-bcs.netDebit, 1); // deep OTM = -debit
  });

  it('credit-range POP (condor) is meaningfully high, debit POP (long call) lower', () => {
    const out = buildStrategies(DESK, { side: 'FLAT', confidence: 20, grade: 'NEUTRAL' });
    const condor = out.find(s => s.id === 'iron-condor');
    expect(condor.pop).toBeGreaterThan(45); // tight ±0.8% wings at 5 DTE ≈ 48% — honest math
  });
});

// ---------------- 7. swing + whales ----------------
function trendCandles(n, start, step, side) {
  const out = [];
  let p = start;
  for (let i = 0; i < n; i++) {
    const o = p;
    p = side > 0 ? p + step : p - step;
    const c = p;
    const h = Math.max(o, c) + step * 0.4;
    const l = Math.min(o, c) - step * 0.4;
    out.push({ open: o, high: h, low: l, close: c, volume: 100 + i });
  }
  return out;
}

describe('swing + whales: scoring & spike detection', () => {
  it('uptrend candles score a LONG swing with plan + reasons', () => {
    const c = trendCandles(120, 100, 0.5, 1);
    const idea = scoreSwing('TEST', 'INDIA', c);
    expect(idea).not.toBeNull();
    expect(idea.side).toBe('LONG');
    expect(idea.plan.entry).toBeCloseTo(c[c.length - 1].close, 5);
    expect(idea.plan.stopLoss).toBeLessThan(idea.plan.entry);
    expect(idea.plan.target2).toBeGreaterThan(idea.plan.target1);
    expect(idea.reasons.length).toBeGreaterThanOrEqual(3);
  });

  it('downtrend candles score SHORT', () => {
    const c = trendCandles(120, 200, 0.5, -1);
    const idea = scoreSwing('TEST', 'CRYPTO', c);
    expect(idea.side).toBe('SHORT');
  });

  it('flat candles → no idea (honest)', () => {
    const c = Array.from({ length: 100 }, (_, i) => ({ open: 100, high: 100.2, low: 99.8, close: 100, volume: 100 + (i % 3) }));
    expect(scoreSwing('TEST', 'INDIA', c)).toBeNull();
  });

  it('whale detection: 4x volume spike + 2% up → ACCUMULATION', () => {
    const c = trendCandles(30, 100, 0.1, 1).map((x, i) => ({ ...x, volume: 100 }));
    c[c.length - 1] = { ...c[c.length - 1], volume: 400, close: c[c.length - 2].close * 1.02 };
    const w = detectWhale('TEST', 'CRYPTO', c);
    expect(w).not.toBeNull();
    expect(w.spike).toBeGreaterThanOrEqual(3.5);
    expect(w.direction).toBe('ACCUMULATION');
  });

  it('whale detection: below 2.5x threshold → null', () => {
    const c = trendCandles(30, 100, 0.1, 1).map(x => ({ ...x, volume: 100 }));
    c[c.length - 1] = { ...c[c.length - 1], volume: 200 };
    expect(detectWhale('TEST', 'CRYPTO', c)).toBeNull();
  });
});

// ---------------- 8. learned gates ----------------
describe('backtest: learned gate recommendation', () => {
  const trades = (n, winRate, grade = 'STRONG') => Array.from({ length: n }, (_, i) => ({
    grade, r: (i / n) < winRate ? 1 : -1,
  }));

  it('insufficient evidence → no change', () => {
    const l = learnedGates(trades(10, 0.6), 75);
    expect(l.changed).toBe(false);
    expect(l.suggestedMinConfidence).toBeNull();
  });

  it('weak STRONG performance → raise the bar (bounded 85)', () => {
    const l = learnedGates(trades(40, 0.35), 75);
    expect(l.changed).toBe(true);
    expect(l.suggestedMinConfidence).toBe(80);
  });

  it('healthy STRONG + strong ACTION band → suggest harvesting (floor 60/70)', () => {
    const all = [...trades(30, 0.60, 'STRONG'), ...trades(30, 0.70, 'ACTION')];
    const l = learnedGates(all, 75);
    expect(l.changed).toBe(true);
    expect(l.suggestedMinConfidence).toBe(70);
  });

  it('healthy STRONG only → keep the current gate', () => {
    const all = [...trades(30, 0.60, 'STRONG'), ...trades(30, 0.45, 'ACTION')];
    const l = learnedGates(all, 75);
    expect(l.changed).toBe(false);
    expect(l.recommendation).toContain('health-check');
  });
});
