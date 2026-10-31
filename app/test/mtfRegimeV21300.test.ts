// ============================================================
// test/mtfRegimeV21300.test.ts — v21.30.0 S5 REGIME CLASSIFIER
// ------------------------------------------------------------
// Locks:
//   • ADX trend / chop / transition boundaries;
//   • ATR% and band-width volatility expansion → HIGH_VOL;
//   • explicit + compressed squeeze → SQUEEZE;
//   • UNKNOWN only when there is no usable evidence;
//   • regimeOf() honours explicit labels/aliases and falls back to the
//     classifier (not the old dir-only guess);
//   • evaluateRegimeFilter stays shadow by default and blocks only in
//     enforce mode;
//   • board rows carry the classifier's `regime` label.
// ============================================================
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  classifyMarketRegime, classifyRowRegime, REGIMES,
} from '../server/ai/mtfRegime.js';
import {
  regimeOf, evaluateRegimeFilter, REGIMES as GUARD_REGIMES,
} from '../server/ai/tradeGuards.js';

describe('v21.30.0 S5 — classifyMarketRegime', () => {
  it('strong ADX + direction → TREND_UP / TREND_DOWN', () => {
    expect(classifyMarketRegime({ dir: 1, adx: 25 })).toBe('TREND_UP');
    expect(classifyMarketRegime({ dir: -1, adx: 25 })).toBe('TREND_DOWN');
    expect(classifyMarketRegime({ dir: 1, adx: 18 })).toBe('TREND_UP');
  });

  it('ADX < 15 → CHOP; ADX 15-18 → TRANSITION; strong ADX without dir → TRANSITION', () => {
    expect(classifyMarketRegime({ dir: 1, adx: 14.9 })).toBe('CHOP');
    expect(classifyMarketRegime({ dir: 1, adx: 15 })).toBe('TRANSITION');
    expect(classifyMarketRegime({ dir: 1, adx: 17.9 })).toBe('TRANSITION');
    expect(classifyMarketRegime({ dir: null, adx: 30 })).toBe('TRANSITION');
    expect(classifyMarketRegime({ dir: 0, adx: 30 })).toBe('TRANSITION');
  });

  it('volatility expansion dominates → HIGH_VOL', () => {
    expect(classifyMarketRegime({ dir: 1, adx: 30, atrPct: 2.5 })).toBe('HIGH_VOL');
    expect(classifyMarketRegime({ adx: 10, atrPct: 2.1 })).toBe('HIGH_VOL');
    expect(classifyMarketRegime({ adx: 10, atrPct: 2.0 })).toBe('HIGH_VOL');
    expect(classifyMarketRegime({ bbWidthPct: 8 })).toBe('HIGH_VOL');
    // A 2.1% ATR inside a strong trend (ADX >= 20) is NOT auto-high-vol;
    // without a direction it is an unresolved transition.
    expect(classifyMarketRegime({ dir: 1, adx: 30, atrPct: 2.1 })).toBe('TREND_UP');
    expect(classifyMarketRegime({ adx: 30, atrPct: 2.1 })).toBe('TRANSITION');
    expect(classifyMarketRegime({ dir: -1, adx: 24, atrPct: 2.1 })).toBe('TREND_DOWN');
  });

  it('squeeze wins over chop when compressed or explicitly flagged', () => {
    expect(classifyMarketRegime({ squeeze: true, adx: 30, dir: 1 })).toBe('SQUEEZE');
    expect(classifyMarketRegime({ adx: 10, atrPct: 0.5 })).toBe('SQUEEZE');
    expect(classifyMarketRegime({ adx: 12, bbWidthPct: 1.2 })).toBe('SQUEEZE');
    // Tight ADX without tight ATR/bands is chop, not squeeze.
    expect(classifyMarketRegime({ adx: 10, atrPct: 1.4 })).toBe('CHOP');
  });

  it('no evidence → UNKNOWN (never a fabricated trend)', () => {
    expect(classifyMarketRegime({})).toBe('UNKNOWN');
    expect(classifyMarketRegime({ rsi: 55 })).toBe('UNKNOWN');
    // RSI extreme alone is not enough; it needs sustained bars.
    expect(classifyMarketRegime({ rsi: 75 })).toBe('UNKNOWN');
    expect(classifyMarketRegime({ rsi: 75, barsInTrend: 8 })).toBe('TREND_UP');
    expect(classifyMarketRegime({ rsi: 25, barsInTrend: 8 })).toBe('TREND_DOWN');
  });

  it('classifyRowRegime reads plan context fields', () => {
    expect(classifyRowRegime({ context: { dir: 1, adx: 26, atrPct: 1.2 } })).toBe('TREND_UP');
    expect(classifyRowRegime({ context: { dir: -1, adx: 26, atrPct: 1.2 } })).toBe('TREND_DOWN');
    expect(classifyRowRegime({ context: { dir: 1, adx: 9 } })).toBe('CHOP');
    expect(classifyRowRegime({ context: { dir: 1, atrPct: 3 } })).toBe('HIGH_VOL');
    expect(classifyRowRegime({ squeeze: true })).toBe('SQUEEZE');
    expect(classifyRowRegime({})).toBe('UNKNOWN');
  });

  it('exports the same regime vocabulary as the guard module', () => {
    expect(REGIMES).toEqual(GUARD_REGIMES);
    expect(REGIMES).toContain('SQUEEZE');
    expect(REGIMES).toContain('TRANSITION');
  });
});

describe('v21.30.0 S5 — regimeOf + evaluateRegimeFilter', () => {
  it('explicit labels and aliases win over the classifier', () => {
    expect(regimeOf({ regime: 'BULLISH', context: { adx: 9, dir: 1 } })).toBe('TREND_UP');
    expect(regimeOf({ regime: { label: 'COMPRESSION' } })).toBe('SQUEEZE');
    expect(regimeOf({ context: { regime: 'RANGE' } })).toBe('CHOP');
    expect(regimeOf({ regime: 'MIXED' })).toBe('TRANSITION');
  });

  it('falls back to the classifier for ADX rows (no explicit label)', () => {
    expect(regimeOf({ context: { adx: 26, dir: 1 } })).toBe('TREND_UP');
    expect(regimeOf({ context: { adx: 9, dir: 1, atrPct: 0.4 } })).toBe('SQUEEZE');
    expect(regimeOf({ context: { adx: 30, atrPct: 3 } })).toBe('HIGH_VOL');
  });

  it('flags counter-trend and chop, stays shadow by default', () => {
    const longBear = evaluateRegimeFilter({ row: { side: 'LONG', context: { adx: 26, dir: -1 } } });
    expect(longBear.regime).toBe('TREND_DOWN');
    expect(longBear.wouldBlock).toBe(true);
    expect(longBear.blocked).toBe(false);
    expect(longBear.shadow).toBe(true);

    const shortBull = evaluateRegimeFilter({ row: { side: 'SHORT', context: { adx: 26, dir: 1 } } });
    expect(shortBull.wouldBlock).toBe(true);
    expect(shortBull.reasons[0]).toMatch(/SHORT against TREND_UP/i);

    const enforced = evaluateRegimeFilter({
      row: { side: 'LONG', context: { adx: 26, dir: -1 } }, mode: 'enforce',
    });
    expect(enforced.blocked).toBe(true);
  });

  it('chop blocks only when blockChop is on; HIGH_VOL only when opted in', () => {
    const chop = evaluateRegimeFilter({
      row: { side: 'LONG', context: { adx: 9, dir: 1, atrPct: 1.2 } }, mode: 'enforce',
    });
    expect(chop.regime).toBe('CHOP');
    expect(chop.blocked).toBe(true);
    const chopAllowed = evaluateRegimeFilter({
      row: { side: 'LONG', context: { adx: 9, dir: 1, atrPct: 1.2 } }, mode: 'enforce', blockChop: false,
    });
    expect(chopAllowed.blocked).toBe(false);

    const highVol = evaluateRegimeFilter({
      row: { side: 'LONG', context: { adx: 26, dir: 1, atrPct: 3 } }, mode: 'enforce',
    });
    expect(highVol.regime).toBe('HIGH_VOL');
    expect(highVol.blocked).toBe(false);
    const highVolVeto = evaluateRegimeFilter({
      row: { side: 'LONG', context: { adx: 26, dir: 1, atrPct: 3 } }, mode: 'enforce', blockHighVol: true,
    });
    expect(highVolVeto.blocked).toBe(true);
  });

  it('aligned trend passes in enforce mode', () => {
    const out = evaluateRegimeFilter({ row: { side: 'SHORT', context: { adx: 28, dir: -1 } }, mode: 'enforce' });
    expect(out.regime).toBe('TREND_DOWN');
    expect(out.wouldBlock).toBe(false);
    expect(out.blocked).toBe(false);
  });
});

describe('v21.30.0 S5 — board wiring pins', () => {
  const root = process.cwd();
  const boardSrc = fs.readFileSync(path.join(root, 'server/ai/mtfDualBoard.js'), 'utf8');
  const autoSrc = fs.readFileSync(path.join(root, 'server/ai/mtfAutoLink.js'), 'utf8');

  it('board rows carry the classifier regime label', () => {
    expect(boardSrc).toContain("import { classifyRowRegime } from './mtfRegime.js';");
    expect(boardSrc).toContain('regime: plan?.ok');
    expect(boardSrc).toContain('classifyRowRegime({ context: plan.context, dir: fuse.dir, trendDir: fuse.trendDir })');
  });

  it('R5 default stays shadow', () => {
    expect(autoSrc).toContain("regimeFilter: 'shadow'");
    expect(autoSrc).toContain("export function regimeFilterMode() { return _guardMode('regimeFilter', 'REGIME_FILTER', 'shadow'); }");
  });
});
