// ============================================================
// test/superIntelFallback.test.ts — v10.10 SUPER-INTELLIGENCE
// DETERMINISTIC DESK ANSWERS
// ------------------------------------------------------------
// The regression lock for the SOL "[object Object]" report: when
// ALL LLM engines are down, a coin deep-dive question must still
// return a FULL TICKET with exact numbers (entry zone / SL /
// T1-T2 / LEVERAGE / liquidation / staged exits) — because the
// tools are pure compute and never needed the LLM in the first
// place. Zero network: runTool is injected + mocked.
// ============================================================
import { describe, it, expect } from 'vitest';
import {
  detectSymbolInText, detectDeskIntent, kvLines,
  buildDeterministicCryptoAnswer, buildDeterministicIntradayAnswer,
} from '../server/ai/superIntelFallback.js';

// ---- the deep-scan payload analyze_coin returns (real shape) ----
// FUTURES blueprint — the liquidation-aware leverage ladder.
const SOL_DEEP = {
  symbol: 'SOL', market: 'FUTURES',
  side: 'LONG', grade: 'STRONG', confidence: 82, agreement: 0.85,
  voters: 9, totalModels: 11,
  ltp: 9120, changePct: 2.1,
  aiScore: 83, tier: 'ACTION', drivers: ['trend', 'momentum'],
  plan: { entry: 9120, stopLoss: 8600, target1: 9600, target2: 10000, riskPct: 5.7, rewardRisk: 2, planStyle: 'ATR' },
  quality: { veto: 'none', mtf: '2/3', session: 'open' },
  blueprint: {
    side: 'LONG', entry: 9120, entryZone: [8960, 9210],
    entryTiming: { mode: 'IMMEDIATE', note: 'Price EMA ke 0.4×ATR par hai — abhi entry window open hai' },
    stopLoss: 8600, targets: { t1: 9600, t2: 10000, t3: 10400 },
    leverage: 3, maxSaneLeverage: 7, liquidation: 6320,
    leverageNote: '3× margin (SL-distance sane-max 7×, tier cap 3×) · liquidation ≈ 6320',
    exitPlan: [
      { at: 9600, bookPct: 40, action: 'T1 9600 — 40% book + SL ko entry (9120) pe breakeven' },
      { at: 10000, bookPct: 40, action: 'T2 10000 — 40% book + bacha 20% trail (peak − 1×risk)' },
      { at: 10400, bookPct: 20, action: 'T3 10400 — runner 20% exit / trail' },
    ],
    exitBy: '3h ATR clock',
    invalidation: 'SL 8600 break → pick cancel, koi averaging nahi · BTC regime flip bhi invalid',
  },
  votes: [
    { model: 'EMA-Stack', dir: 'BULL', conf: 88, why: ['trend up'] },
    { model: 'RSI-Momo', dir: 'BULL', conf: 74, why: ['rsi 61'] },
    { model: 'SMC', dir: 'BEAR', conf: 55, why: ['supply above'] },
  ],
  aiNote: 'MTF 2/3 — 1h tape weak, size aadha rakho.',
};

// SPOT variant — superIntel sets CRYPTO leverage to 1 (cash-and-carry).
const SOL_SPOT_DEEP = {
  ...SOL_DEEP, market: 'CRYPTO',
  blueprint: {
    ...SOL_DEEP.blueprint,
    leverage: 1, liquidation: null,
    leverageNote: 'SPOT 1× — cash-and-carry, koi liquidation risk nahi',
  },
};

const SIZE_OUT = {
  entry: 9120, stopLoss: 8600, capital: 1000, riskPercent: 1.5,
  stopDistancePct: 5.7, riskAmount: 15, recommendedQty: 0.029,
  capitalDeployed: 264.5, target1_1R: 9640, target2_2R: 10160,
  maxSaneLeverage: 7, warning: 'Liquidation 7x leverage ke andar stop ke BAHAR rehti hai.',
  note: 'Risk ₹15 (1.5% of 1000) at 5.7% stop distance.',
};

const FUNDING_OUT = {
  symbol: 'SOL', markPrice: 131.2, fundingRate8h: 0.0000812,
  fundingBps8h: 0.81, approxDailyCarryPct: 0.0244,
  interpretation: 'balanced funding — carry is not a factor',
};

const mkRunTool = (map) => vi.fn(async (name, args) => {
  const h = map[name];
  if (typeof h === 'function') return h(args);
  if (h === undefined) return { error: `unknown tool ${name}` };
  return h;
});

// ============================================================
describe('detectSymbolInText — Hinglish symbol extraction', () => {
  it('aliases: solana / SOL / bitcoin / btc case-insensitive', () => {
    expect(detectSymbolInText('SOL ka deep analysis karo')?.symbol).toBe('SOL');
    expect(detectSymbolInText('solana kaisa lag raha hai')?.symbol).toBe('SOL');
    expect(detectSymbolInText('bitcoin ab kya karein')?.symbol).toBe('BTC');
    expect(detectSymbolInText('BTC/ETH pair suna hai')?.symbol).toBe('BTC'); // first+longest
  });

  it('longest alias wins: "ethereum" over "eth" word tricks', () => {
    expect(detectSymbolInText('ETH vs ethereum — dono alag hai?')?.symbol).toBe('ETH');
  });

  it('global tickers + company names map to the GLOBAL desk', () => {
    expect(detectSymbolInText('NVDA pe view do')?.market).toBe('GLOBALFUTURES');
    expect(detectSymbolInText('Apple kaisa lag raha hai')?.symbol).toBe('AAPL');
    expect(detectSymbolInText('tesla me kya scene hai')?.symbol).toBe('TSLA');
  });

  it('no symbol → null (honest, no false positives)', () => {
    expect(detectSymbolInText('aaj ka desk briefing do')).toBeNull();
    expect(detectSymbolInText('market kaisa hai')).toBeNull();
    expect(detectSymbolInText('hello ji')).toBeNull();
  });
});

describe('detectDeskIntent — priority + futures flag', () => {
  it('risk > pnl > wallet > positions > briefing > coin', () => {
    expect(detectDeskIntent('kill switch status kya hai')?.kind).toBe('risk');
    expect(detectDeskIntent('SOL ka P&L batao')?.kind).toBe('pnl');
    expect(detectDeskIntent('wallet balance kitna hai')?.kind).toBe('wallet');
    expect(detectDeskIntent('open positions dikhao')?.kind).toBe('positions');
    expect(detectDeskIntent('aaj ka desk briefing do')?.kind).toBe('briefing');
  });

  it('coin intent carries symbol + futures flag from "leverage/perp" words', () => {
    const i = detectDeskIntent('SOL ka deep analysis karo — entry, SL, leverage sab exact numbers me');
    expect(i).toMatchObject({ kind: 'coin', symbol: 'SOL', futures: true });
    const spot = detectDeskIntent('SOL spot me kaisa hai');
    expect(spot.futures).toBe(false);
  });

  it('non-actionable chat → null', () => {
    expect(detectDeskIntent('test')).toBeNull();
    expect(detectDeskIntent('')).toBeNull();
  });
});

// ============================================================
describe('buildDeterministicCryptoAnswer — the SOL case', () => {
  it('SOL deep-dive with NO LLM → FULL TICKET with exact numbers', async () => {
    const runTool = mkRunTool({
      analyze_coin: () => SOL_DEEP,
      calculate_position_size: () => SIZE_OUT,
      get_funding_rate: () => FUNDING_OUT,
    });
    const toolTrace = [];
    const out = await buildDeterministicCryptoAnswer(
      [{ role: 'user', content: 'SOL ka deep analysis karo — entry, SL, leverage sab exact numbers me' }],
      {}, runTool, toolTrace,
    );
    expect(out).not.toBeNull();
    const t = out.text;
    // the mode banner (honesty: engine down, numbers exact)
    expect(t).toContain('SUPER-INTEL DETERMINISTIC MODE');
    // the exact numbers the user asked for
    expect(t).toContain('SOL LONG');
    expect(t).toContain('8,960');          // entry zone low
    expect(t).toContain('9,210');          // entry zone high
    expect(t).toContain('8,600');          // SL
    expect(t).toContain('9,600');          // T1
    expect(t).toContain('10,000');         // T2
    expect(t).toContain('3×');             // leverage ladder
    expect(t).toContain('7×');             // max sane leverage
    expect(t).toContain('6,320');          // liquidation
    expect(t).toContain('0.029');          // sizing qty
    expect(t).toContain('82%');            // confidence
    expect(t).toContain('83/100');         // AI score
    // funding appears for futures asks
    expect(t).toContain('0.0081%');        // funding 8h pct
    // staged exits + invalidation
    expect(t).toContain('40% book');
    expect(t).toContain('Invalidation');
    // the tool trace lights the UI chips (Deep Scan + Sizing + Funding)
    expect(toolTrace.map(x => x.tool)).toEqual([
      'analyze_coin', 'calculate_position_size', 'get_funding_rate',
    ]);
  });

  it('SPOT ask → 1× cash line, no funding call', async () => {
    const runTool = mkRunTool({
      analyze_coin: () => SOL_SPOT_DEEP,
      calculate_position_size: () => SIZE_OUT,
    });
    const out = await buildDeterministicCryptoAnswer(
      [{ role: 'user', content: 'SOL spot me kaisa setup hai' }], {}, runTool, [],
    );
    expect(out.text).toContain('SPOT 1× cash');
    expect(runTool).not.toHaveBeenCalledWith('get_funding_rate', expect.anything(), expect.anything());
  });

  it('tool error → honest error answer (never fake numbers)', async () => {
    const runTool = mkRunTool({ analyze_coin: () => ({ error: 'No data for FOO' }) });
    const out = await buildDeterministicCryptoAnswer(
      [{ role: 'user', content: 'SOL analysis do' }], {}, runTool, [],
    );
    // symbol detected as SOL but the tool mock returns an error for it
    expect(out.text).toContain('scan nahi ho paya');
  });

  it('desk briefing merges SPOT/FUTURES/GLOBAL boards, aiScore-ranked top-3', async () => {
    const runTool = mkRunTool({
      get_live_crypto_signals: () => ({
        SPOT: [{ symbol: 'BTC', side: 'LONG', confidence: 70, aiScore: 71, plan: { entry: 5000000, stopLoss: 4900000, target1: 5100000, target2: 5200000, rewardRisk: 2 } }],
        FUTURES: [{ symbol: 'SOL', side: 'LONG', confidence: 80, aiScore: 83, plan: { entry: 9120, stopLoss: 8600, target1: 9600, target2: 10000, rewardRisk: 2 } }],
        GLOBAL: [{ symbol: 'NVDA', side: 'LONG', confidence: 60, aiScore: 61, plan: { entry: 120, stopLoss: 115, target1: 130, target2: 140, rewardRisk: 2 } }],
      }),
      get_market_regime: () => ({ regime: 'RISK-ON', btcChangePct24h: 1.2, fearGreed: { value: 56 } }),
    });
    const out = await buildDeterministicCryptoAnswer(
      [{ role: 'user', content: 'aaj ka desk briefing do' }], {}, runTool, [],
    );
    expect(out.text).toContain('DESK BRIEFING');
    expect(out.text).toContain('RISK-ON');
    // aiScore-ranked rows: SOL(83) before BTC(71) before NVDA(61) —
    // compare the ROW positions (the header's BTC regime note is not a row)
    const row = (sym) => out.text.search(new RegExp(`- \\*\\*${sym} `));
    expect(row('SOL')).toBeGreaterThan(-1);
    expect(row('SOL')).toBeLessThan(row('BTC'));
    expect(row('BTC')).toBeLessThan(row('NVDA'));
  });

  it('wallet / pnl / risk / positions intents answer from their tools', async () => {
    for (const [q, tool] of [
      ['mera wallet balance dikhao', 'get_wallet'],
      ['aaj ka P&L kitna hai', 'get_pnl'],
      ['risk status aur blockers batao', 'get_risk_status'],
      ['open positions kya hain', 'get_open_positions'],
    ]) {
      const runTool = mkRunTool({
        get_wallet: () => ({ connected: false, equityINR: null }),
        get_pnl: () => ({ realizedINR: -120, unrealizedINR: 40, winRate: 44 }),
        get_risk_status: () => ({ killSwitch: false, blockers: [] }),
        get_open_positions: () => ({ count: 1, positions: [{ pair: 'B-SOL_USDT', side: 'LONG' }] }),
      });
      const out = await buildDeterministicCryptoAnswer([{ role: 'user', content: q }], {}, runTool, []);
      expect(out.text.length).toBeGreaterThan(80);
      expect(runTool).toHaveBeenCalledWith(tool, expect.anything(), expect.anything());
    }
  });

  it('non-actionable message → null (falls to the honest engines-unavailable path)', async () => {
    const out = await buildDeterministicCryptoAnswer([{ role: 'user', content: 'test' }], {}, mkRunTool({}), []);
    expect(out).toBeNull();
  });

  it('runTool crash → null (never fake numbers)', async () => {
    const runTool = vi.fn(async () => { throw new Error('boom'); });
    const out = await buildDeterministicCryptoAnswer(
      [{ role: 'user', content: 'SOL ka deep analysis karo' }], {}, runTool, [],
    );
    expect(out).toBeNull();
  });
});

// ============================================================
describe('buildDeterministicIntradayAnswer — the India tab', () => {
  const RELIANCE = {
    symbol: 'RELIANCE', ltp: 2912.5, changePct: 0.8, direction: 'LONG',
    quantConfidence: 74, entry: 2910, entryZone: [2900, 2925], stopLoss: 2880,
    target1: 2970, target2: 3010, trailingSL: 2905, rr: 2, effRR: 1.8,
    qtyPerLakh: 34, rsi: 58, adx: 22, volumeRatio: 1.4, vwapDist: 0.3,
    freshEntriesAllowed: true, counterTrend: false,
    reasons: ['EMA10>EMA20>EMA50 stack', 'VWAP ke upar'],
  };

  it('NSE symbol ask → FULL TICKET (entry zone / SL / T1-T2 / qtyPerLakh)', async () => {
    const runTool = mkRunTool({ analyze_setup: () => RELIANCE });
    const out = await buildDeterministicIntradayAnswer(
      [{ role: 'user', content: 'RELIANCE ka analysis do — entry SL batao' }], {}, runTool, [],
    );
    expect(out.text).toContain('RELIANCE — NSE INTRADAY SETUP');
    expect(out.text).toContain('2,900');
    expect(out.text).toContain('2,880');
    expect(out.text).toContain('2,970');
    expect(out.text).toContain('34 qty/lakh');
    expect(out.text).toContain('MIS 1×');
    expect(out.text).toContain('FULL TICKET');
  });

  it('briefing ask → scanner top setups with the market-closed truth', async () => {
    const runTool = mkRunTool({
      get_live_intraday_signals: () => ({ marketOpen: false, asOf: new Date().toISOString(), signals: [
        { symbol: 'TATAMOTORS', direction: 'LONG', confidence: 78, grade: 'A', entryZone: [950, 965], stopLoss: 935, target1: 990, target2: 1010, rr: 2 },
      ] }),
    });
    const out = await buildDeterministicIntradayAnswer(
      [{ role: 'user', content: 'top setups kaunse hain aaj' }], {}, runTool, [],
    );
    expect(out.text).toContain('INTRADAY DESK BRIEFING');
    expect(out.text).toContain('market band');
    expect(out.text).toContain('TATAMOTORS');
  });

  it('no symbol / no briefing intent → null', async () => {
    const out = await buildDeterministicIntradayAnswer([{ role: 'user', content: 'hello ji' }], {}, mkRunTool({}), []);
    expect(out).toBeNull();
  });

  it('random ALL-CAPS chat word with no NSE data → honest NO-TRADE answer (never a crash)', async () => {
    const runTool = mkRunTool({
      analyze_setup: () => ({ error: 'No live data for HELLO' }),
      get_live_intraday_signals: () => ({ marketOpen: true, signals: [] }),
    });
    const out = await buildDeterministicIntradayAnswer(
      [{ role: 'user', content: 'HELLO JI AAP KE BARE ME SOCHA THA' }], {}, runTool, [],
    );
    // the junk "symbol" has no live data → falls to the scanner truth
    expect(out.text).toContain('NO-TRADE');
    expect(out.text).not.toContain('[object Object]');
  });

  it('symbol with no live data falls back to the briefing answer, not a dead end', async () => {
    const runTool = mkRunTool({
      analyze_setup: () => ({ error: 'No live data for XYZ' }),
      get_live_intraday_signals: () => ({ marketOpen: true, signals: [] }),
    });
    const out = await buildDeterministicIntradayAnswer(
      [{ role: 'user', content: 'XYZ ka analysis do' }], {}, runTool, [],
    );
    expect(out.text).toContain('NO-TRADE window');
  });
});

describe('kvLines — readable tool dumps', () => {
  it('renders nested objects as bullet lines, arrays as numbered rows', () => {
    const s = kvLines({ equityINR: 10500, spot: { balanceINR: 2000, deployableINR: 1800 }, positions: [{ pair: 'B-SOL_USDT', side: 'LONG' }] });
    expect(s).toContain('equity i n r'); // camelCase → spaced label
    expect(s).toContain('1,80');
    expect(s).toContain('B-SOL_USDT');
    expect(s).not.toContain('[object Object]');
  });
  it('never throws on junk', () => {
    expect(typeof kvLines(null)).toBe('string');
    expect(typeof kvLines([1, 2])).toBe('string');
  });
});
