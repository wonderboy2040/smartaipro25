// ============================================================
// test/mtfAB.test.ts — ACCURACY-PLAN PHASE 2.1: MTF A/B SHADOW
// ------------------------------------------------------------
// LOCKED HERE (the plan's "Confirm karo IntradayTapeMTF ka w1.6
// upgrade genuinely behtar hai plain 15m tape (w1.3) se"):
//   • models.js intradayTapeMTF stamps __abShadow (the byte-identical
//     plain 15m read, NO agreement boost/penalty) ONLY when the MTF
//     payload actually ran — degraded fallbacks carry no shadow (they
//     ARE the plain seat; no double-count)
//   • ledger.js recordExecution journals BOTH arms (tape-mtf +
//     ab_tape15m shadow:true) on the tamper-evident chain
//   • trust.js mtfABReport: paired separation + Brier + verdict on
//     synthetic settled entries (MTF sharper / plain sharper /
//     needs data), honest notes
//   • weeklyQuantView carries the mtfAB block (the weekly narration
//     reads exactly this)
// Hermetic: in-memory store mock (same pattern as signalTrust).
// ============================================================
import { describe, it, expect, beforeEach, vi } from 'vitest';

// ---- the MTF seat must BE the registry's tape seat (flag ON before import) ----
process.env.AI_ENABLE_MTF_CONFLUENCE = 'true';

// ---- hermetic store (no disk) ----
const _disk = vi.hoisted(() => new Map());
vi.mock('../server/lib/store.js', () => ({
  loadJSON: (f: string, d: unknown) => (_disk.has(f) ? structuredClone(_disk.get(f)) : structuredClone(d)),
  saveJSON: (f: string, v: unknown) => { _disk.set(f, v); },
}));

// dynamic imports AFTER the env set (ES imports hoist above the env
// line otherwise — the intradayMtfConfluence.test.ts pattern)
const { MODELS, tapeVote } = await import('../server/ai/models.js');
const { recordExecution, markOutcome, __setLedgerForTests } = await import('../server/ai/ledger.js');
const { mtfABReport } = await import('../server/ai/trust.js');

const BULL_TAPE = { ltp: 1258, ema10: 1256, ema20: 1253, ema50: 1248, rsi: 64, macdHist: 1.2, macdSlope: 0.4, vwap: 1255, last3Pct: 0.7 };
const BEAR_TAPE = { ltp: 1258, ema20: 1266, ema50: 1272, ema10: 1262, rsi: 36, macdHist: -1.5, macdSlope: -0.5, vwap: 1263, last3Pct: -0.8 };
// moderate bull tape — plain conf ~80 so the +15 boost stays UNDER the
// 100 clamp (BULL_TAPE saturates both arms to 100 and the delta vanishes)
const MID_BULL_TAPE = { ltp: 1258, ema10: 1257, ema20: 1255, ema50: 1250, rsi: 61, macdHist: 0.2, macdSlope: -0.1, vwap: 1258, last3Pct: 0.3 };

beforeEach(() => {
  _disk.clear();
  __setLedgerForTests(null);
});

// ============================================================
// 1. The shadow stamp on the MTF vote
// ============================================================
describe('intradayTapeMTF — the A/B shadow arm', () => {
  const mtfModel = MODELS.find(m => m.id === 'tape-mtf') || MODELS.find(m => m.id === 'tape');

  it('carries __abShadow when the MTF payload ran (plain 15m dir + conf, no agreement math)', () => {
    const v = mtfModel.fn({ market: 'INDIA', tapeMTF: { m5: MID_BULL_TAPE, m15: MID_BULL_TAPE, h1: MID_BULL_TAPE } });
    expect(v.__abShadow).toBeTruthy();
    expect(v.__abShadow.id).toBe('ab_tape15m');
    // ALL-3-aligned: MTF conf got +15, the shadow keeps the plain conf
    const plain = tapeVote(MID_BULL_TAPE, '15m');
    expect(v.__abShadow.dir).toBe(plain.dir);
    expect(v.__abShadow.conf).toBe(plain.conf);
    expect(v.conf).toBeGreaterThan(v.__abShadow.conf); // the boost is the delta under test
  });

  it('1-of-3 conflict: shadow still the plain read; MTF conf pays the −20 penalty', () => {
    const v = mtfModel.fn({ market: 'INDIA', tapeMTF: { m5: BEAR_TAPE, m15: MID_BULL_TAPE, h1: BEAR_TAPE } });
    expect(v.__abShadow).toBeTruthy();
    const plain = tapeVote(MID_BULL_TAPE, '15m');
    expect(v.__abShadow.conf).toBe(plain.conf);
    expect(v.conf).toBeLessThan(v.__abShadow.conf); // the −20 conflict penalty is the delta under test
  });

  it('degraded fallback (no tapeMTF, plain tape) carries NO shadow — it IS the plain seat', () => {
    const v = mtfModel.fn({ market: 'INDIA', tape: BULL_TAPE });
    expect(v.dir).toBe(1);
    expect(v.__abShadow).toBeUndefined();
  });

  it('abstains (no payload at all) carry no shadow', () => {
    const v = mtfModel.fn({ market: 'INDIA', symbol: 'X', ltp: 100 });
    expect(v.dir).toBe(0);
    expect(v.__abShadow).toBeUndefined();
  });
});

// ============================================================
// 2. The ledger journals BOTH arms
// ============================================================
describe('recordExecution — both arms on the chain', () => {
  const mkVotes = (mtfConf: number, plainConf: number) => ([
    { id: 'tape-mtf', name: 'IntradayTapeMTF', weight: 1.6, dir: 1, conf: mtfConf, reasons: [],
      __abShadow: { id: 'ab_tape15m', dir: 1, conf: plainConf, weight: 1.3 } },
    { id: 'trend', name: 'TrendMatrix', weight: 1.4, dir: 1, conf: 80, reasons: [] },
  ]);

  it('a vote with __abShadow journals tape-mtf AND ab_tape15m (shadow:true)', () => {
    const e = recordExecution({
      symbol: 'RELIANCE', market: 'INDIA', side: 'LONG', grade: 'ACTION', confidence: 72,
      votes: mkVotes(78, 63),
    }, { mode: 'paper' });
    expect(e).toBeTruthy();
    expect(e.votes['tape-mtf']).toEqual({ dir: 1, conf: 78 });
    expect(e.votes['ab_tape15m']).toEqual({ dir: 1, conf: 63, shadow: true });
    // the chain still verifies with the shadow key aboard
    expect(e.hash).toBeTruthy();
  });

  it('votes WITHOUT __abShadow journal exactly as before (back-compat)', () => {
    const e = recordExecution({
      symbol: 'TCS', market: 'INDIA', side: 'LONG', confidence: 70,
      votes: [{ id: 'trend', dir: 1, conf: 80 }],
    }, { mode: 'paper' });
    expect(Object.keys(e.votes)).toEqual(['trend']);
  });
});

// ============================================================
// 3. mtfABReport — the measured verdict
// ============================================================
describe('mtfABReport — separation + Brier + verdict', () => {
  const seed = (rows: Array<{ mtfConf: number; plainConf: number; r: number; side?: string; dir?: number }>) => {
    __setLedgerForTests(null);
    for (const x of rows) {
      const dir = x.dir ?? 1;
      const e = recordExecution({
        symbol: 'X', market: 'INDIA', side: x.side || 'LONG', confidence: 70,
        votes: [{ id: 'tape-mtf', dir, conf: x.mtfConf, __abShadow: { id: 'ab_tape15m', dir, conf: x.plainConf } }],
      }, { mode: 'paper' });
      markOutcome(e.id, { r: x.r, reason: 'test' });
    }
  };

  it('needs-data below the paired minimum — honest note, no fake verdict', () => {
    seed([{ mtfConf: 80, plainConf: 60, r: 1 }, { mtfConf: 70, plainConf: 65, r: -1 }]);
    const r = mtfABReport();
    expect(r.ok).toBe(true);
    expect(r.pairs).toBe(2);
    expect(r.verdict).toBe('NEEDS DATA');
    expect(r.note).toContain('Insufficient');
  });

  it('MTF SHARPER when its conf separates wins from losses and plain does not', () => {
    // 12 pairs: MTF conf 85 on wins / 45 on losses; plain flat 60 everywhere
    seed([
      ...Array.from({ length: 6 }, () => ({ mtfConf: 85, plainConf: 60, r: 1.2 })),
      ...Array.from({ length: 6 }, () => ({ mtfConf: 45, plainConf: 60, r: -1 })),
    ]);
    const r = mtfABReport();
    expect(r.pairs).toBe(12);
    expect(r.mtf.separation).toBeGreaterThan(0);
    expect(r.plain.separation).toBe(0);
    expect(r.brierDeltaPlainMinusMtf).toBeGreaterThan(0); // plain worse
    expect(['MTF SHARPER', 'MTF SHARPER (separation)']).toContain(r.verdict);
  });

  it('PLAIN SHARPER when the MTF layer anti-separates (conf high on losers)', () => {
    seed([
      ...Array.from({ length: 6 }, () => ({ mtfConf: 50, plainConf: 80, r: 1.2 })),
      ...Array.from({ length: 6 }, () => ({ mtfConf: 88, plainConf: 40, r: -1 })),
    ]);
    const r = mtfABReport();
    expect(r.mtf.separation).toBeLessThan(0);
    expect(r.plain.separation).toBeGreaterThan(0);
    expect(r.brierDeltaPlainMinusMtf).toBeLessThan(0);
    expect(['PLAIN 15m SHARPER', 'PLAIN 15m SHARPER (separation)']).toContain(r.verdict);
  });

  it('hit-rates are identical by design (same dir) — the report states the method honestly', () => {
    seed([
      ...Array.from({ length: 5 }, () => ({ mtfConf: 80, plainConf: 60, r: 1 })),
      ...Array.from({ length: 5 }, () => ({ mtfConf: 80, plainConf: 60, r: -1 })),
    ]);
    const r = mtfABReport();
    expect(r.mtf.hitRate).toBe(r.plain.hitRate);
    expect(r.method).toContain('identical by design');
  });

  it('SHORT trades attribute correctly (dir −1 vs side SHORT)', () => {
    seed([
      { mtfConf: 85, plainConf: 60, r: 1.4, side: 'SHORT', dir: -1 },
      { mtfConf: 85, plainConf: 60, r: 1.1, side: 'SHORT', dir: -1 },
    ]);
    const r = mtfABReport();
    expect(r.mtf.n).toBe(2);
    expect(r.mtf.wins).toBe(2);
  });
});

// ============================================================
// 4. The weekly review carries the block
// ============================================================
describe('weeklyQuantView — the mtfAB block rides the payload', () => {
  it('the quant view includes mtfAB (weekly narration source)', async () => {
    const { weeklyQuantView } = await import('../server/ai/weeklyReview.js');
    const q = weeklyQuantView({ now: Date.now() });
    expect(q.mtfAB).toBeTruthy();
    expect(q.mtfAB.ok).toBe(true);
    expect(typeof q.mtfAB.verdict).toBe('string');
  });
});
