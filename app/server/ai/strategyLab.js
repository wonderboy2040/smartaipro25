// ============================================================
// server/ai/strategyLab.js — v10.8 PRO #2: NL CUSTOM STRATEGY LAB
// ------------------------------------------------------------
// (Vibe-Trading strategy-discovery port, right-sized). Users could
// never ask "backtest a strategy that buys when RSI < 30 and volume
// is 2x average" without a developer writing it. The Lab:
//
//   1. NL description → LLM compiles a BOUNDED rule-expression JSON
//      (NEVER free-form code — a strict whitelist the validator
//      enforces; unsafe/unbounded rules are rejected before running)
//   2. the validated rules replay bar-by-bar on the SAME candle
//      history the ensemble backtester uses (no look-ahead: bar i
//      only ever sees candles[0..i])
//   3. results come back in the SAME R-multiple stats shape as the
//      ensemble backtest — side-by-side comparable
//
// Exposed as POST /api/ai/strategy-lab (routes.js) + the
// backtest_custom_strategy tool inside the crypto desk chat agent.
// ============================================================
import { computeIndicatorsFromCandles } from './lib/indicators.js';
import { fetchHistoryFor, statsFromTrades } from './backtest.js';
import { askLLM } from '../intraday/agent.js';

const r2 = (v) => (Number.isFinite(v) ? Math.round(v * 100) / 100 : null);
const SLIPPAGE = 0.001; // 10 bps each side (same as the ensemble backtest)
const WARMUP = 60;

// ---------------- the bounded rule schema ----------------
/** Whitelisted indicators (computed from candles — every value the
 *  simulator reads is derived, never user/LLM-supplied). */
export const ALLOWED_INDICATORS = {
  rsi: { kind: 'bounded', lo: 0, hi: 100 },
  adx: { kind: 'bounded', lo: 0, hi: 100 },
  stochK: { kind: 'bounded', lo: 0, hi: 100 },
  volumeRatio: { kind: 'bounded', lo: 0, hi: 25 },       // volume / avgVolume20
  priceVsEma20Pct: { kind: 'pct', lo: -50, hi: 50 },      // (ltp-ema20)/ema20×100
  priceVsEma50Pct: { kind: 'pct', lo: -50, hi: 50 },
  priceVsVwapPct: { kind: 'pct', lo: -50, hi: 50 },
  macdHistNorm: { kind: 'pct', lo: -10, hi: 10 },         // macd.histogram / ltp ×100
  changePct: { kind: 'pct', lo: -50, hi: 50 },             // last bar % change
  emaStack: { kind: 'stack' },                            // ema10 vs ema20 vs ema50 ordering
};
export const ALLOWED_OPERATORS = ['above', 'below', 'crossing_above', 'crossing_below'];
const STACK_VALUES = ['bullish', 'bearish'];

/**
 * Validate + normalize a compiled strategy. PURE.
 * Rejects ANYTHING outside the whitelist (unknown indicator,
 * unknown operator, out-of-range value, too many conditions, missing
 * pieces) — the LLM gets no path to an unbounded rule.
 * @returns {{ok:true, rules:object}|{ok:false, error:string}}
 */
export function validateStrategyRules(raw) {
  if (!raw || typeof raw !== 'object') return { ok: false, error: 'rules object required' };
  const name = String(raw.name || 'custom strategy').slice(0, 80);
  const direction = String(raw.direction || '').toUpperCase();
  if (direction !== 'LONG' && direction !== 'SHORT') return { ok: false, error: 'direction must be LONG or SHORT' };

  const condList = (arr, what, max, allowEmpty = false) => {
    if (arr == null) return []; // optional
    if (!Array.isArray(arr)) return { error: `${what} must be an array` };
    if (arr.length === 0) {
      // an EMPTY exit list is legitimate — SL/TP/time own the exit then.
      // An empty ENTRY list has nothing to run.
      if (allowEmpty) return [];
      return { error: `${what} cannot be empty` };
    }
    if (arr.length > max) return { error: `${what}: max ${max} conditions` };
    const out = [];
    for (const c of arr) {
      const ind = String(c?.indicator || '').trim();
      const spec = ALLOWED_INDICATORS[ind];
      if (!spec) return { error: `unknown indicator "${ind}" (allowed: ${Object.keys(ALLOWED_INDICATORS).join(', ')})` };
      if (spec.kind === 'stack') {
        const v = String(c?.value || '').toLowerCase();
        if (!STACK_VALUES.includes(v)) return { error: `emaStack value must be bullish|bearish` };
        out.push({ indicator: 'emaStack', value: v });
        continue;
      }
      const op = String(c?.operator || '').trim();
      if (!ALLOWED_OPERATORS.includes(op)) return { error: `unknown operator "${op}" (allowed: ${ALLOWED_OPERATORS.join(', ')})` };
      const val = Number(c?.value);
      if (!Number.isFinite(val)) return { error: `${ind}: numeric value required` };
      if (val < spec.lo || val > spec.hi) return { ok: false, error: `${ind}: value ${val} outside sane range [${spec.lo}, ${spec.hi}]` };
      out.push({ indicator: ind, operator: op, value: val });
    }
    return out;
  };

  const entry = condList(raw.entry, 'entry', 4);
  if (entry.error) return { ok: false, error: entry.error };
  if (!entry.length) return { ok: false, error: 'at least 1 entry condition required' };
  const exit = condList(raw.exit, 'exit', 3, true);
  if (exit.error) return { ok: false, error: exit.error };

  const stopLossAtr = Number(raw.stopLossAtr);
  if (!Number.isFinite(stopLossAtr) || stopLossAtr < 0.5 || stopLossAtr > 5) {
    return { ok: false, error: 'stopLossAtr must be 0.5–5 (ATR multiples)' };
  }
  const takeProfitR = Number(raw.takeProfitR);
  if (!Number.isFinite(takeProfitR) || takeProfitR < 0.5 || takeProfitR > 5) {
    return { ok: false, error: 'takeProfitR must be 0.5–5 (R multiples of the stop)' };
  }
  const maxHoldBars = Math.round(Number(raw.maxHoldBars));
  if (!Number.isFinite(maxHoldBars) || maxHoldBars < 6 || maxHoldBars > 168) {
    return { ok: false, error: 'maxHoldBars must be 6–168' };
  }
  return {
    ok: true,
    rules: { name, direction, entry, exit, stopLossAtr, takeProfitR, maxHoldBars },
  };
}

// ---------------- indicator read at bar i ----------------
/** Read one whitelisted indicator from a computed indicator set. PURE. */
function readIndicator(ind, indSet) {
  switch (ind) {
    case 'rsi': return Number(indSet.rsi);
    case 'adx': return Number(indSet.adx?.adx);
    case 'stochK': return Number(indSet.stochastic?.k);
    case 'volumeRatio': {
      const v = Number(indSet.volume), av = Number(indSet.avgVolume20);
      return av > 0 ? v / av : null;
    }
    case 'priceVsEma20Pct': {
      const e = Number(indSet.ema20), l = Number(indSet.ltp);
      return e > 0 ? ((l - e) / e) * 100 : null;
    }
    case 'priceVsEma50Pct': {
      const e = Number(indSet.ema50), l = Number(indSet.ltp);
      return e > 0 ? ((l - e) / e) * 100 : null;
    }
    case 'priceVsVwapPct': {
      const v = Number(indSet.vwap), l = Number(indSet.ltp);
      return v > 0 ? ((l - v) / v) * 100 : null;
    }
    case 'macdHistNorm': {
      const h = Number(indSet.macd?.hist), l = Number(indSet.ltp);
      return l > 0 ? (h / l) * 100 : null;
    }
    case 'changePct': return Number(indSet._changePct);
    default: return null;
  }
}

/** Evaluate ONE condition at bar i (prev = indicator set at bar i−1
 *  for the crossing operators). PURE. */
function conditionTrue(cond, indSet, prevSet) {
  if (cond.indicator === 'emaStack') {
    const { ema10, ema20, ema50 } = indSet;
    if (![ema10, ema20, ema50].every(Number.isFinite)) return false;
    if (cond.value === 'bullish') return ema10 > ema20 && ema20 > ema50;
    return ema10 < ema20 && ema20 < ema50;
  }
  const now = readIndicator(cond.indicator, indSet);
  if (!Number.isFinite(now)) return false;
  const prev = prevSet ? readIndicator(cond.indicator, prevSet) : null;
  switch (cond.operator) {
    case 'above': return now > cond.value;
    case 'below': return now < cond.value;
    case 'crossing_above': return Number.isFinite(prev) && prev <= cond.value && now > cond.value;
    case 'crossing_below': return Number.isFinite(prev) && prev >= cond.value && now < cond.value;
    default: return false;
  }
}

function conditionsTrue(conds, indSet, prevSet) {
  return (conds || []).every(c => conditionTrue(c, indSet, prevSet));
}

/** Bar-close change % helper stamped onto the indicator set. */
function withChangePct(indSet, candles, i) {
  const prev = candles[i - 1]?.close;
  indSet._changePct = prev > 0 ? ((candles[i].close / prev) - 1) * 100 : 0;
  return indSet;
}

// ---------------- the simulator (pure, exported for tests) ----------------
/**
 * Replay ONE symbol's history through the validated custom rules.
 * No look-ahead: indicators at bar i use candles[0..i]; entry fires
 * at the NEXT bar's open with 10bps slippage; SL-first on ambiguous
 * bars (the ensemble backtester's conservative rule).
 * @returns {{trades:[], stats:object}|null} null = not enough bars.
 */
export function simulateCustomStrategy({ symbol, market, candles, rules, capitalPerTradeINR = 1000 }) {
  if (!Array.isArray(candles) || candles.length < WARMUP + 20) return null;
  const isLong = rules.direction === 'LONG';
  const trades = [];
  let open = null;
  let indCache = new Map(); // i → indSet (crossing ops need i and i−1)
  const indAt = (i) => {
    if (indCache.has(i)) return indCache.get(i);
    const s = withChangePct(computeIndicatorsFromCandles(candles.slice(0, i + 1)), candles, i);
    indCache.set(i, s);
    // bound the cache — only the last 2 are ever needed
    if (indCache.size > 4) {
      const keep = [...indCache.keys()].sort((a, b) => b - a).slice(0, 2);
      indCache = new Map(keep.map(k => [k, indCache.get(k)]));
    }
    return s;
  };

  let i = WARMUP;
  while (i < candles.length - 1) {
    if (!open) {
      const indSet = indAt(i);
      const prevSet = i > 0 ? indAt(i - 1) : null;
      if (indSet && conditionsTrue(rules.entry, indSet, prevSet)) {
        const next = candles[i + 1];
        const entry = next.open * (1 + (isLong ? SLIPPAGE : -SLIPPAGE));
        const atr = Number(indSet.atr);
        if (atr > 0) {
          const risk = atr * rules.stopLossAtr;
          if (risk > 0) {
            open = {
              symbol, market, side: rules.direction,
              entryBar: i + 1, entryTime: next?.time ?? null,
              entry, sl: isLong ? entry - risk : entry + risk,
              tp: isLong ? entry + risk * rules.takeProfitR : entry - risk * rules.takeProfitR,
              risk, qty: capitalPerTradeINR > 0 ? capitalPerTradeINR / entry : 0,
            };
            i += 1;
            continue;
          }
        }
      }
      i += 1;
      continue;
    }

    const bar = candles[i];
    // SL-first on ambiguous bars (conservative — mirrors backtest.js)
    if (isLong ? bar.low <= open.sl : bar.high >= open.sl) {
      const exit = open.sl * (1 + (isLong ? -SLIPPAGE : SLIPPAGE));
      finishCustom(open, trades, exit, 'SL', i);
      open = null; i += 1; continue;
    }
    if (isLong ? bar.high >= open.tp : bar.low <= open.tp) {
      const exit = open.tp * (1 + (isLong ? -SLIPPAGE : SLIPPAGE));
      finishCustom(open, trades, exit, 'TP', i);
      open = null; i += 1; continue;
    }
    // exit conditions (evaluated at bar close — the strategy's own exit)
    const indSet = indAt(i);
    const prevSet = i > 0 ? indAt(i - 1) : null;
    if (indSet && rules.exit?.length && conditionsTrue(rules.exit, indSet, prevSet)) {
      finishCustom(open, trades, bar.close, 'EXIT-RULE', i);
      open = null; i += 1; continue;
    }
    if (i - open.entryBar >= rules.maxHoldBars) {
      finishCustom(open, trades, bar.close, 'TIME', i);
      open = null; i += 1; continue;
    }
    i += 1;
  }
  if (open) finishCustom(open, trades, candles[candles.length - 1].close, 'EOD', candles.length - 1);
  return { trades, stats: statsFromTrades(trades) };
}

function finishCustom(t, trades, exitPrice, reason, exitBar) {
  const isLong = t.side === 'LONG';
  const rMult = ((isLong ? exitPrice - t.entry : t.entry - exitPrice) / t.risk);
  const pnlINR = t.qty > 0 ? rMult * t.risk * t.qty : 0;
  trades.push({
    symbol: t.symbol, side: t.side,
    entry: r2(t.entry), exit: r2(exitPrice), sl: r2(t.sl), tp: r2(t.tp),
    risk: r2(t.risk), r: r2(rMult), pnlINR: r2(pnlINR), reason,
    entryBar: t.entryBar, exitBar, holdBars: exitBar - t.entryBar,
    entryTime: t.entryTime ?? null,
  });
}

// ---------------- NL → rules (LLM, bounded output) ----------------
/**
 * Compile a natural-language description into the bounded rule JSON.
 * The LLM NEVER emits code — only the whitelisted shape, which then
 * passes validateStrategyRules or is rejected honestly.
 */
export async function compileStrategyFromNL(description, deps) {
  const desc = String(description || '').trim().slice(0, 800);
  if (desc.length < 8) return { ok: false, error: 'description too short — describe the entry/exit idea' };
  const schema = `{
  "name": "short name",
  "direction": "LONG" | "SHORT",
  "entry": [ {"indicator": IND, "operator": OP, "value": NUMBER} or {"indicator":"emaStack","value":"bullish"|"bearish"} ],   // 1-4 conditions, ALL must be true
  "exit": [ ... 0-3 optional conditions, ANY true = exit ],
  "stopLossAtr": 0.5-5,
  "takeProfitR": 0.5-5,
  "maxHoldBars": 6-168
}
IND ∈ {rsi, adx, stochK, volumeRatio, priceVsEma20Pct, priceVsVwapPct, priceVsEma50Pct, macdHistNorm, changePct, emaStack}
OP ∈ {above, below, crossing_above, crossing_below}
Ranges: rsi/adx/stochK 0-100 · volumeRatio 0-25 (1 = average volume, 2 = 2x average) · price-vs-X % −50..50 · macdHistNorm −10..10 · changePct −50..50.`;

  const system = `You are a strategy compiler for a trading terminal's Strategy Lab. Convert the user's natural-language strategy idea into EXACTLY the JSON schema given. Rules:
- ONLY the whitelisted indicators/operators/values — anything else will be REJECTED before running
- translate ideas honestly: "volume 2x average" → volumeRatio above 2; "RSI oversold bounce" → rsi crossing_above 30
- if the idea cannot be expressed within the whitelist, still return the CLOSEST expressible version and set "name" to include "(approx)"
- respond with STRICT JSON only, no markdown`;
  const user = `SCHEMA:\n${schema}\n\nUSER STRATEGY IDEA:\n${desc}\n\nJSON:`;

  const { text } = (await askLLM(system, user, deps, { temperature: 0.1, maxTokens: 900, timeout: 25000 }).catch(() => ({ text: null }))) || {};
  if (!text) return { ok: false, error: 'compiler unavailable (no AI keys / provider down) — try again in a minute' };
  const cleaned = String(text).replace(/```json|```/g, '').trim();
  const start = cleaned.indexOf('{'), end = cleaned.lastIndexOf('}');
  if (start < 0 || end <= start) return { ok: false, error: 'compiler returned unparseable output — rephrase the idea and retry' };
  let parsed;
  try { parsed = JSON.parse(cleaned.slice(start, end + 1)); } catch { return { ok: false, error: 'compiler returned invalid JSON — rephrase and retry' }; }
  const v = validateStrategyRules(parsed);
  if (!v.ok) return { ok: false, error: `compiled strategy failed safety validation: ${v.error}` };
  return v;
}

// ---------------- multi-symbol runner ----------------
/**
 * Full lab run: NL → rules → replay across symbols.
 * @param {{description:string, market?:'CRYPTO'|'INDIA', symbols?:string[],
 *          capitalPerTradeINR?:number, deps?:object}} a
 */
export async function runCustomStrategyBacktest({ description, market = 'CRYPTO', symbols, capitalPerTradeINR = 1000, deps }) {
  const mkt = String(market).toUpperCase() === 'INDIA' ? 'INDIA' : 'CRYPTO';
  const compiled = await compileStrategyFromNL(description, deps);
  if (!compiled.ok) return { ok: false, stage: 'compile', error: compiled.error };

  const defSyms = mkt === 'INDIA' ? ['RELIANCE', 'HDFCBANK', 'ICICIBANK', 'INFY', 'TCS', 'SBIN'] : ['BTC', 'ETH', 'BNB', 'SOL', 'XRP', 'DOGE'];
  const syms = (Array.isArray(symbols) && symbols.length > 0 ? symbols : defSyms)
    .map(s => String(s).toUpperCase().replace(/[^A-Z0-9-]/g, '')).filter(Boolean).slice(0, 6);

  const results = await Promise.allSettled(syms.map(async (sym) => {
    const { candles, source } = await fetchHistoryFor(mkt, sym);
    if (!candles) return { symbol: sym, ok: false, reason: 'no historical data (CoinDCX + Yahoo both unreachable)' };
    const sim = simulateCustomStrategy({ symbol: sym, market: mkt, candles, rules: compiled.rules, capitalPerTradeINR });
    if (!sim) return { symbol: sym, ok: false, reason: 'not enough bars' };
    return { symbol: sym, ok: true, source, ...sim };
  }));
  const perSymbol = results.map(r => r.status === 'fulfilled' ? r.value : { symbol: '?', ok: false, reason: 'failed' });
  const allTrades = perSymbol.filter(s => s.ok).flatMap(s => s.trades.map(t => ({ ...t, symbol: s.symbol })));
  allTrades.sort((a, b) => ((a.entryTime ?? 0) - (b.entryTime ?? 0)) || (a.symbol < b.symbol ? -1 : 1));
  let cum = 0;
  const equity = allTrades.map((t, idx) => { cum += t.r; return { i: idx + 1, cumR: r2(cum), symbol: t.symbol, r: t.r }; });

  const exitDist = {};
  for (const t of allTrades) exitDist[t.reason] = (exitDist[t.reason] || 0) + 1;

  return {
    ok: allTrades.length > 0 || perSymbol.some(s => s.ok),
    stage: 'done',
    market: mkt,
    strategy: 'custom',
    description: String(description || '').slice(0, 300),
    rules: compiled.rules, // the EXACT validated rules that ran — full transparency
    params: { capitalPerTradeINR, slippagePct: 0.1, warmupBars: WARMUP },
    scannedSymbols: perSymbol.filter(s => s.ok).length,
    dataSources: perSymbol.filter(s => s.ok).map(s => ({ symbol: s.symbol, source: s.source })),
    perSymbol: perSymbol.map(s => ({ symbol: s.symbol, ok: s.ok, reason: s.reason ?? null, stats: s.stats ?? null, trades: s.ok ? (s.trades || []).slice(-10) : undefined })),
    stats: { ...statsFromTrades(allTrades), symbols: perSymbol.filter(s => s.ok).length },
    exitDist,
    equity: equity.slice(-120),
    trades: allTrades.slice(-30).reverse(),
    disclaimer: 'Custom strategy compiled from your description by an LLM into a bounded rule set, then replayed walk-forward on historical candles (no look-ahead). Past performance ≠ future results. R = multiples of initial risk. Not investment advice.',
    generatedAt: Date.now(),
  };
}

// test hooks ------------------------------------------------
export const __internals = { readIndicator, conditionTrue, withChangePct };
