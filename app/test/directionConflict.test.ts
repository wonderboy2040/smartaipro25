// P0 regression: MTF row LONG/SHORT must never be auto-eligible when the board ensemble,
// the SVA verifier, or the AI council points the OTHER way.
import { describe, it, expect } from 'vitest';
import { buildPlanFromCandles } from '../server/ai/tradePlanner.js';
import { fuseDualTf } from '../server/ai/mtfDualBoard.js';

function rng(seed: number) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }
const gauss = (r: () => number) => Math.sqrt(-2 * Math.log(r() + 1e-12)) * Math.cos(2 * Math.PI * r());
function gen(seed: number, n: number, stepMs: number, drift: number, vol: number, endTs: number) {
  const r = rng(seed); let p = 100; const out: any[] = []; let t = endTs - n * stepMs;
  for (let i = 0; i < n; i++) { const o = p; const c = o * Math.exp(drift + vol * gauss(r));
    out.push({ time: t, open: o, high: Math.max(o, c) * (1 + Math.abs(vol * gauss(r)) * 0.5), low: Math.min(o, c) * (1 - Math.abs(vol * gauss(r)) * 0.5), close: c, volume: 1000 * (0.6 + r() * 1.2) });
    t += stepMs; p = c; }
  return out;
}
function eligibleFixture() {
  const al = (ms: number) => Math.floor(Date.now() / ms) * ms;
  for (let seed = 1; seed <= 2000; seed++) for (const drift of [0.0012, -0.0012]) {
    const vol = [0.0015, 0.0025, 0.004][seed % 3];
    const ctx = gen(seed, 240, 15 * 60_000, drift, vol, al(15 * 60_000));
    const trg = gen(seed + 999, 240, 5 * 60_000, drift / 3, vol * 0.65, al(5 * 60_000));
    const plan: any = buildPlanFromCandles({ symbol: 'T', market: 'CRYPTO', mode: 'INTRADAY', ctxCandles: ctx, trigCandles: trg, ltp: trg.at(-1).close });
    if (!plan.ok) continue;
    const f: any = fuseDualTf({ symbol: 'T', market: 'CRYPTO', plan, snap: null, modeId: 'INTRADAY' });
    if (f.autoEligible && f.superScore >= 75) return { plan, f };
  }
  throw new Error('no eligible fixture found');
}
describe('direction conflict guards', () => {
  const { plan, f } = eligibleFixture();
  const opp = f.side === 'LONG' ? 'SHORT' : 'LONG';
  it('baseline fixture is eligible', () => { expect(f.autoEligible).toBe(true); });
  it('board ensemble opposite side blocks auto-eligibility', () => {
    const r: any = fuseDualTf({ symbol: 'T', market: 'CRYPTO', boardSig: { symbol: 'T', side: opp, superIntel: { aiScore: 90 } }, plan, snap: null, modeId: 'INTRADAY' });
    expect(r.autoEligible).toBe(false); expect(r.directionVerified).toBe(false); expect(r.superScore).toBeLessThan(75);
    expect(r.autoBlockers.join(' ')).toMatch(/direction conflict/);
  });
  it('SVA FLIP blocks auto-eligibility', () => {
    const r: any = fuseDualTf({ symbol: 'T', market: 'CRYPTO', boardSig: { symbol: 'T', side: f.side, verify: { action: 'FLIP', finalCall: opp, veto: false } }, plan, snap: null, modeId: 'INTRADAY' });
    expect(r.autoEligible).toBe(false);
  });
  it('same-side board signal keeps eligibility', () => {
    const r: any = fuseDualTf({ symbol: 'T', market: 'CRYPTO', boardSig: { symbol: 'T', side: f.side, superIntel: { aiScore: 80 } }, plan, snap: null, modeId: 'INTRADAY' });
    expect(r.autoEligible).toBe(true);
  });
});
