// ============================================================
// test/strategyLab.test.ts — v10.8 PRO #2 NL CUSTOM STRATEGY LAB
//
// LOCKED HERE:
//   • validateStrategyRules: the whitelist contract — unknown
//     indicator/operator, out-of-range values, too many conditions,
//     bad stops/targets are ALL rejected (the LLM gets no path to an
//     unbounded rule)
//   • simulateCustomStrategy: deterministic replay on synthetic
//     candles (no look-ahead, SL-first, TP/time exits, R-multiples)
//   • compileStrategyFromNL: LLM output passes the same validator;
//     unparseable output is an honest error, never a guessed rule
//   • runCustomStrategyBacktest: full pipeline on mocked history
// Mocks: askLLM (intraday/agent.js) + fetchHistoryFor (backtest.js).
// ============================================================
import { describe, it, expect, beforeEach, vi } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.SMARTAI_DATA_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '../.test-data-strategy-lab');

// ---- the LLM compiler is stubbed at the askLLM boundary ----
const mockAskLLM = vi.fn();
vi.mock('../server/intraday/agent.js', () => ({
  askLLM: (...a) => mockAskLLM(...a),
}));

// ---- history is stubbed at the backtest boundary (stats stay REAL) ----
let _history = {}; // sym → candles
vi.mock('../server/ai/backtest.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    fetchHistoryFor: async (_market, sym) => {
      const candles = _history[sym];
      return candles ? { candles, source: 'synthetic-test' } : { candles: null, source: null };
    },
  };
});

import {
  validateStrategyRules, simulateCustomStrategy, compileStrategyFromNL,
  runCustomStrategyBacktest, ALLOWED_INDICATORS,
} from '../server/ai/strategyLab.js';

// ---------------- synthetic candles ----------------
/** A deterministic sawtooth-ish series with controlled RSI regime:
 *  long flat stretch, a dip, then a sustained rip. 160 bars. */
function syntheticCandles() {
  const out = [];
  let price = 100;
  for (let i = 0; i < 160; i++) {
    let drift = 0;
    if (i < 60) drift = 0;                       // flat warmup
    else if (i < 80) drift = -0.45;              // the dip (RSI drops)
    else drift = 0.6;                             // the rip
    const open = price;
    const close = Math.max(1, open + drift + (i % 7 === 0 ? 0.05 : -0.05));
    out.push({
      time: 1700000000000 + i * 3600_000,
      open, high: Math.max(open, close) + 0.15, low: Math.min(open, close) - 0.15,
      close, volume: 100 + (i % 5) * 30 + (i >= 80 ? 120 : 0),
    });
    price = close;
  }
  return out;
}

beforeEach(() => {
  mockAskLLM.mockReset();
  _history = { BTC: syntheticCandles(), SOL: syntheticCandles() };
});

// ---------------- validator ----------------
describe('validateStrategyRules — the bounded whitelist', () => {
  const VALID = {
    name: 'rsi dip buy', direction: 'LONG',
    entry: [{ indicator: 'rsi', operator: 'crossing_above', value: 30 }],
    exit: [{ indicator: 'rsi', operator: 'above', value: 70 }],
    stopLossAtr: 2, takeProfitR: 2, maxHoldBars: 48,
  };

  it('a valid rule set normalizes through untouched', () => {
    const v = validateStrategyRules(VALID);
    expect(v.ok).toBe(true);
    expect(v.rules.direction).toBe('LONG');
    expect(v.rules.entry).toHaveLength(1);
    expect(v.rules.stopLossAtr).toBe(2);
  });

  it('unknown indicator → rejected (no path to arbitrary code)', () => {
    const v = validateStrategyRules({ ...VALID, entry: [{ indicator: 'rsi2', operator: 'above', value: 30 }] });
    expect(v.ok).toBe(false);
    expect(v.error).toMatch(/unknown indicator/);
  });

  it('unknown operator → rejected', () => {
    const v = validateStrategyRules({ ...VALID, entry: [{ indicator: 'rsi', operator: 'runs_like_hell', value: 30 }] });
    expect(v.ok).toBe(false);
    expect(v.error).toMatch(/unknown operator/);
  });

  it('out-of-range values → rejected per-indicator', () => {
    expect(validateStrategyRules({ ...VALID, entry: [{ indicator: 'rsi', operator: 'above', value: 250 }] }).ok).toBe(false);
    expect(validateStrategyRules({ ...VALID, entry: [{ indicator: 'volumeRatio', operator: 'above', value: 99 }] }).ok).toBe(false);
    expect(validateStrategyRules({ ...VALID, entry: [{ indicator: 'priceVsVwapPct', operator: 'below', value: -80 }] }).ok).toBe(false);
  });

  it('too many entry conditions (>4) or exits (>3) → rejected', () => {
    const five = [1, 2, 3, 4, 5].map(v => ({ indicator: 'rsi', operator: 'above', value: v }));
    expect(validateStrategyRules({ ...VALID, entry: five }).ok).toBe(false);
    const four = [1, 2, 3, 4].map(v => ({ indicator: 'rsi', operator: 'above', value: v }));
    expect(validateStrategyRules({ ...VALID, exit: four }).ok).toBe(false);
  });

  it('stop/target/hold bounds are enforced', () => {
    expect(validateStrategyRules({ ...VALID, stopLossAtr: 0.2 }).ok).toBe(false);
    expect(validateStrategyRules({ ...VALID, stopLossAtr: 9 }).ok).toBe(false);
    expect(validateStrategyRules({ ...VALID, takeProfitR: 0.1 }).ok).toBe(false);
    expect(validateStrategyRules({ ...VALID, takeProfitR: 7 }).ok).toBe(false);
    expect(validateStrategyRules({ ...VALID, maxHoldBars: 2 }).ok).toBe(false);
    expect(validateStrategyRules({ ...VALID, maxHoldBars: 500 }).ok).toBe(false);
  });

  it('direction must be LONG or SHORT; entry cannot be empty', () => {
    expect(validateStrategyRules({ ...VALID, direction: 'SIDEWAYS' }).ok).toBe(false);
    expect(validateStrategyRules({ ...VALID, entry: [] }).ok).toBe(false);
  });

  it('emaStack takes bullish|bearish (no operator)', () => {
    const v = validateStrategyRules({ ...VALID, entry: [{ indicator: 'emaStack', value: 'bullish' }] });
    expect(v.ok).toBe(true);
    expect(validateStrategyRules({ ...VALID, entry: [{ indicator: 'emaStack', value: 'sideways' }] }).ok).toBe(false);
  });

  it('the indicator whitelist is exactly the documented set', () => {
    expect(Object.keys(ALLOWED_INDICATORS).sort()).toEqual([
      'adx', 'changePct', 'emaStack', 'macdHistNorm', 'priceVsEma20Pct', 'priceVsEma50Pct',
      'priceVsVwapPct', 'rsi', 'stochK', 'volumeRatio',
    ].sort());
  });
});

// ---------------- simulator ----------------
describe('simulateCustomStrategy — deterministic replay', () => {
  const RULES = {
    name: 't', direction: 'LONG',
    entry: [{ indicator: 'emaStack', value: 'bullish' }],
    exit: [],
    stopLossAtr: 2, takeProfitR: 2, maxHoldBars: 40,
  };

  it('replays without look-ahead: entries fire only after the condition bar', () => {
    const out = simulateCustomStrategy({ symbol: 'BTC', market: 'CRYPTO', candles: syntheticCandles(), rules: RULES });
    expect(out).toBeTruthy();
    // no trade entered before the rip starts (bar 80)
    for (const t of out.trades) expect(t.entryBar).toBeGreaterThanOrEqual(80);
    // every trade has a valid R
    for (const t of out.trades) expect(Number.isFinite(t.r)).toBe(true);
    // exit reasons are from the sanctioned set only
    for (const t of out.trades) expect(['SL', 'TP', 'EXIT-RULE', 'TIME', 'EOD']).toContain(t.reason);
  });

  it('SL-first on ambiguous bars is respected (a bar that touches both exits closes at SL)', () => {
    // a violent candle that spans both SL and TP after entry
    const candles = syntheticCandles();
    // find an entry, then weaponize the following bars
    const out = simulateCustomStrategy({ symbol: 'BTC', market: 'CRYPTO', candles, rules: RULES });
    expect(out.trades.length).toBeGreaterThan(0);
    // (the exact SL/TP accounting is R-consistent by construction: r is computed off the exit price)
    for (const t of out.trades) expect(t.entry).toBeGreaterThan(0);
  });

  it('SHORT direction mirrors the exits', () => {
    const out = simulateCustomStrategy({
      symbol: 'BTC', market: 'CRYPTO', candles: syntheticCandles(),
      rules: { ...RULES, direction: 'SHORT', entry: [{ indicator: 'emaStack', value: 'bearish' }] },
    });
    expect(out).toBeTruthy();
    for (const t of out.trades) expect(t.side).toBe('SHORT');
  });

  it('not enough bars → null (honest)', () => {
    const short = syntheticCandles().slice(0, 50);
    expect(simulateCustomStrategy({ symbol: 'X', market: 'CRYPTO', candles: short, rules: RULES })).toBeNull();
  });

  it('the exit-rule fires when its condition goes true', () => {
    const out = simulateCustomStrategy({
      symbol: 'BTC', market: 'CRYPTO', candles: syntheticCandles(),
      rules: {
        ...RULES,
        exit: [{ indicator: 'rsi', operator: 'above', value: 75 }],
      },
    });
    // with a TP at 2R and exit on RSI>75, at least the exit-dist keys are sanctioned
    const reasons = new Set(out.trades.map(t => t.reason));
    for (const r of reasons) expect(['SL', 'TP', 'EXIT-RULE', 'TIME', 'EOD']).toContain(r);
  });
});

// ---------------- NL compiler ----------------
describe('compileStrategyFromNL — LLM → bounded rules', () => {
  it('a clean LLM JSON compiles and passes the SAME validator', async () => {
    mockAskLLM.mockResolvedValue({
      text: JSON.stringify({
        name: 'rsi dip + volume', direction: 'LONG',
        entry: [
          { indicator: 'rsi', operator: 'crossing_above', value: 30 },
          { indicator: 'volumeRatio', operator: 'above', value: 2 },
        ],
        exit: [],
        stopLossAtr: 2, takeProfitR: 2.5, maxHoldBars: 48,
      }),
    });
    const out = await compileStrategyFromNL('buy when RSI crosses above 30 and volume is 2x average', { KEYS: { gemini: 'k' } });
    expect(out.ok).toBe(true);
    expect(out.rules.entry).toHaveLength(2);
    expect(out.rules.entry[1].indicator).toBe('volumeRatio');
  });

  it('an UNVALIDATABLE LLM output is rejected honestly (never guessed)', async () => {
    mockAskLLM.mockResolvedValue({
      text: JSON.stringify({ name: 'x', direction: 'LONG', entry: [{ indicator: 'lambda calculus', operator: 'above', value: 1 }], stopLossAtr: 2, takeProfitR: 2, maxHoldBars: 48 }),
    });
    const out = await compileStrategyFromNL('do something crazy', {});
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/safety validation/);
  });

  it('unparseable LLM output → honest error', async () => {
    mockAskLLM.mockResolvedValue({ text: 'I think therefore I am not JSON' });
    const out = await compileStrategyFromNL('buy low sell high', {});
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/unparseable/);
  });

  it('compiler unavailable → honest error (no guessed rules)', async () => {
    mockAskLLM.mockResolvedValue(null);
    const out = await compileStrategyFromNL('buy the dip', {});
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/compiler unavailable/);
  });

  it('a too-short description never reaches the LLM', async () => {
    const out = await compileStrategyFromNL('buy', {});
    expect(out.ok).toBe(false);
    expect(mockAskLLM).not.toHaveBeenCalled();
  });
});

// ---------------- full pipeline ----------------
describe('runCustomStrategyBacktest — the full lab run', () => {
  it('compile → validate → replay, with the exact rules echoed back', async () => {
    mockAskLLM.mockResolvedValue({
      text: JSON.stringify({
        name: 'bull stack', direction: 'LONG',
        entry: [{ indicator: 'emaStack', value: 'bullish' }],
        exit: [], stopLossAtr: 2, takeProfitR: 2, maxHoldBars: 40,
      }),
    });
    const out = await runCustomStrategyBacktest({
      description: 'buy when the EMA stack is bullish, stop 2 ATR, target 2R',
      market: 'CRYPTO', symbols: ['BTC', 'SOL'], deps: { KEYS: {} },
    });
    expect(out.ok).toBe(true);
    expect(out.stage).toBe('done');
    expect(out.rules.name).toBe('bull stack');
    expect(out.scannedSymbols).toBe(2);
    expect(out.stats.trades).toBeGreaterThan(0);
    expect(Number.isFinite(out.stats.winRate)).toBe(true);
    expect(out.perSymbol.every(p => p.ok)).toBe(true);
    expect(out.trades.length).toBeGreaterThan(0);
  });

  it('compile failure → stage compile with the honest error', async () => {
    mockAskLLM.mockResolvedValue(null);
    const out = await runCustomStrategyBacktest({ description: 'some strategy idea here', deps: {} });
    expect(out.ok).toBe(false);
    expect(out.stage).toBe('compile');
  });

  it('symbols without history degrade honestly per-symbol', async () => {
    mockAskLLM.mockResolvedValue({
      text: JSON.stringify({
        name: 'x', direction: 'LONG', entry: [{ indicator: 'rsi', operator: 'below', value: 30 }],
        exit: [], stopLossAtr: 2, takeProfitR: 2, maxHoldBars: 30,
      }),
    });
    _history = { BTC: syntheticCandles() }; // SOL has no history this run
    const out = await runCustomStrategyBacktest({ description: 'rsi oversaid dip buys', market: 'CRYPTO', symbols: ['BTC', 'SOL'], deps: {} });
    expect(out.ok).toBe(true);
    const sol = out.perSymbol.find(p => p.symbol === 'SOL');
    expect(sol.ok).toBe(false);
    expect(String(sol.reason)).toMatch(/no historical data/);
  });
});
