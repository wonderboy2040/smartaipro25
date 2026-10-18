// ============================================================
// server/ai/backtest.js — WALK-FORWARD ENSEMBLE BACKTESTER
// ------------------------------------------------------------
// v6.5 — "would these signals have made money?" answered honestly.
//
// The SAME pipeline that runs live — indicators → quant models →
// aggregateVotes → buildTradePlan (risk-capped) — is replayed on
// historical candles bar-by-bar, and each generated trade is
// simulated with the SAME exit discipline the live watcher uses:
//
//   entry   = next bar's open + 0.1% slippage
//   exits   = SL (full close) · TP2 (runner target) · time-stop
//             (TP1 does NOT close — the live watcher lets winners
//             run to TP2; the backtest must mirror that or lie)
//   SL-first on ambiguous bars (conservative)
//
// Results are R-multiple-normalized (risk-based, capital-agnostic)
// plus a ₹ P&L at a fixed budget. Every number is derived from the
// exact models serving the live board — no look-ahead: bar i only
// ever sees candles[0..i].
// ============================================================
import { computeIndicatorsFromCandles } from './lib/indicators.js';
import { fetchCoinDcxCandles } from './data.js';
import { runQuantModels } from './models.js';
import { aggregateVotes, buildTradePlan, applyRegimeWeights, classifyRegimeFromCandles } from './ensemble.js';
// v12.6: the A/B validation leg — replay the SAME bars with the live
// trust guards (chase + OB/OS) applied at entry, exactly what the board
// and the execution gate now do. This is the proof layer: raw vs
// guarded on identical data.
import { entryTimingRead, CHASE_HARD_CONF_CAP as _CHASE_HARD_CONF_CAP, CHASE_SOFT_CONF_PENALTY } from './entryTiming.js';

const r2 = (v) => (Number.isFinite(v) ? Math.round(v * 100) / 100 : null);
const SLIPPAGE = 0.001; // 10 bps each side
const WARMUP = 60;      // bars burned before the first signal

// ---------------- historical data ----------------
/** v10.8: shared history fetcher for the Strategy Lab (and any future
 *  tool that needs the SAME candle sources the backtester uses). */
export async function fetchHistoryFor(market, sym) {
  const mkt = String(market).toUpperCase() === 'INDIA' ? 'INDIA' : 'CRYPTO';
  if (mkt === 'CRYPTO') {
    let candles = await fetchCoinDcxCandles(sym, '1h').catch(() => null);
    if (candles) return { candles, source: 'coindcx-1h' };
    candles = await fetchYahooHourlyCrypto(sym).catch(() => null);
    return candles ? { candles, source: 'yahoo-1h-USD' } : { candles: null, source: null };
  }
  const candles = await fetchYahooDailyCandles(sym).catch(() => null);
  return candles ? { candles, source: 'yahoo-1d' } : { candles: null, source: null };
}

async function fetchYahooDailyCandles(symbol, range = '2y') {
  const yh = `${symbol.toUpperCase().replace(/[^A-Z0-9-]/g, '')}.NS`;
  return fetchYahooChart(yh, '1d', range);
}

/** v6.5 fallback for crypto history when CoinDCX public candles are
 *  unreachable (e.g. sandboxed hosts): Yahoo 1h bars for <base>-USD.
 *  R-multiple stats are currency-agnostic; the ₹ P&L is computed on
 *  the same fixed budget, so USD prices stay comparable. */
async function fetchYahooHourlyCrypto(base) {
  return fetchYahooChart(`${base}-USD`, '1h', '3mo');
}

async function fetchYahooChart(yhTicker, interval, range) {
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yhTicker)}?interval=${interval}&range=${range}`;
    const r = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (WealthAI backtest)' },
      signal: AbortSignal.timeout(10_000),
    });
    if (!r.ok) return null;
    const j = await r.json();
    const res = j?.chart?.result?.[0];
    const ts = res?.timestamp;
    const q = res?.indicators?.quote?.[0];
    if (!Array.isArray(ts) || !q) return null;
    const out = [];
    for (let i = 0; i < ts.length; i++) {
      if (q.open?.[i] == null || q.close?.[i] == null) continue;
      out.push({
        time: ts[i] * 1000,
        open: q.open[i], high: q.high?.[i] ?? q.close[i], low: q.low?.[i] ?? q.close[i],
        close: q.close[i], volume: q.volume?.[i] || 0,
      });
    }
    return out.length >= 120 ? out : null;
  } catch { return null; }
}

// ---------------- the simulation core (pure, exported for tests) ----------------
/**
 * Simulate ONE symbol's history through the live ensemble.
 * @returns {{trades: [], stats: {}}|null} null when data is unusable.
 *
 * v10.6 `strategy: 'regime_weighted'` (Pro Upgrade #4): the same
 * replay with the regime multiplier layer FORCED on — a rolling
 * TRENDING/CHOPPY/HIGH_VOL/LOW_VOL label is classified from the
 * candle history itself (no look-ahead: bars [0..i] only) and tilts
 * the model weights per bar. The A/B runner below runs BOTH legs on
 * identical data so the flag can be evaluated before going live.
 */
export function simulateSymbol({ symbol, market, candles, minGrade = 'ACTION', maxRiskPct = 5, capitalPerTradeINR = 1000, maxHoldBars = 48, strategy = 'weighted', minConfidence = 0 }) {
  if (!Array.isArray(candles) || candles.length < WARMUP + 20) return null;
  const long = side => String(side).toUpperCase() !== 'SHORT';
  const trades = [];
  let i = WARMUP;
  let openTrade = null;

  const gradeFloor = { STRONG: 4, ACTION: 3, WATCH: 2, NEUTRAL: 1 }[String(minGrade).toUpperCase()] || 3;
  if (gradeFloor < 3) { /* WATCH/NEUTRAL floors are allowed for experimentation */ }
  // v12.6 GUARDED leg: the live entry discipline replayed — chase
  // (structural extension) + OB/OS (RSI extreme) land on the consensus
  // BEFORE the grade floor decides, mirroring applySignalTrustGuards +
  // evaluateExecutionGate on the live path. Never flips the side.
  const guarded = strategy === 'guarded';

  while (i < candles.length - 1) {
    if (!openTrade) {
      // ---- signal evaluation at bar i close (no look-ahead) ----
      const hist = candles.slice(0, i + 1);
      const ind = computeIndicatorsFromCandles(hist);
      if (ind) {
        const prev = candles[i - 1]?.close;
        const ctx = {
          market, symbol,
          ltp: candles[i].close,
          changePct: prev > 0 ? ((candles[i].close / prev) - 1) * 100 : 0,
          volume: candles[i].volume || 0,
          ind, candles: hist, options: null,
          regime: market === 'CRYPTO' ? { btcChange: null } : { niftyChange: null, indiaVix: null },
        };
        const votes = applyRegimeWeights(runQuantModels(ctx),
          strategy === 'regime_weighted' ? classifyRegimeFromCandles(hist, market) : null,
          { force: true });
        let consensus = aggregateVotes(votes);
        // ---- v12.6 GUARDED: the live trust guards on the replay ----
        if (guarded && consensus.dir !== 0) {
          const rsi = ind.rsi ?? null;
          let skip = false;
          let confAdj = 0;
          // OB/OS (v12.4 live rule)
          if (consensus.side === 'LONG' && rsi != null && rsi >= 70) skip = true;
          if (consensus.side === 'SHORT' && rsi != null && rsi <= 30) skip = true;
          // CHASE (v12.5 live rule — same module, same thresholds)
          const timing = entryTimingRead({
            side: consensus.side,
            ltp: candles[i].close,
            ema20: ind.ema20 ?? null,
            atr: ind.atr ?? null,
            rsi,
            candles: hist,
            market,
          });
          if (timing) {
            if (timing.severity === 'HARD') skip = true;
            else if (timing.severity === 'SOFT') confAdj -= CHASE_SOFT_CONF_PENALTY;
          }
          if (confAdj !== 0) {
            consensus = { ...consensus, confidence: Math.max(5, (Number(consensus.confidence) || 0) + confAdj) };
          }
          if (skip) { i += 1; continue; }
        }
        const gf = { STRONG: 4, ACTION: 3, WATCH: 2, NEUTRAL: 1 }[consensus.grade] || 1;
        // v21.1.0 (Phase-4): optional CONFIDENCE bar — walk-forward mode ke
        // TRAIN/TEST legs isko vary karte hain (learnedGates ka output).
        if (consensus.dir !== 0 && gf >= gradeFloor && (Number(consensus.confidence) || 0) >= minConfidence) {
          const plan = buildTradePlan(consensus, ctx, market, { maxRiskPct });
          if (plan) {
            const next = candles[i + 1];
            const entry = next.open * (1 + (long(consensus.side) ? SLIPPAGE : -SLIPPAGE));
            const risk = Math.abs(entry - plan.stopLoss);
            if (risk > 0) {
              openTrade = {
                symbol, market, side: consensus.side, grade: consensus.grade, confidence: consensus.confidence,
                agreement: consensus.agreement, entryBar: i + 1, entryTime: next?.time ?? null, entry, sl: plan.stopLoss, tp: plan.target1, tp2: plan.target2,
                risk, qty: capitalPerTradeINR > 0 ? capitalPerTradeINR / entry : 0,
                planStyle: plan.planStyle + (plan.riskClamped ? ' (fitted)' : ''),
                modelsVoting: consensus.participating,
              };
              i += 1;
              continue;
            }
          }
        }
      }
      i += 1;
      continue;
    }

    // ---- manage the open trade bar-by-bar ----
    const bar = candles[i];
    const isLong = long(openTrade.side);
    // SL-first on ambiguous bars (conservative)
    if (isLong ? bar.low <= openTrade.sl : bar.high >= openTrade.sl) {
      const exit = openTrade.sl * (1 + (isLong ? -SLIPPAGE : SLIPPAGE));
      finish(openTrade, trades, exit, 'SL', i);
      openTrade = null;
      i += 1;
      continue;
    }
    if (isLong ? bar.high >= openTrade.tp2 : bar.low <= openTrade.tp2) {
      const exit = openTrade.tp2 * (1 + (isLong ? -SLIPPAGE : SLIPPAGE));
      finish(openTrade, trades, exit, 'TP2', i);
      openTrade = null;
      i += 1;
      continue;
    }
    if (i - openTrade.entryBar >= maxHoldBars) {
      finish(openTrade, trades, bar.close, 'TIME', i);
      openTrade = null;
      i += 1;
      continue;
    }
    i += 1;
  }

  if (openTrade) { // data ended mid-trade — mark-to-market close
    finish(openTrade, trades, candles[candles.length - 1].close, 'EOD', candles.length - 1);
  }
  return { trades, stats: statsFrom(trades) };
}

function finish(t, trades, exitPrice, reason, exitBar) {
  const isLong = String(t.side).toUpperCase() !== 'SHORT';
  const rMult = ((isLong ? exitPrice - t.entry : t.entry - exitPrice) / t.risk);
  const pnlINR = t.qty > 0 ? rMult * t.risk * t.qty : 0;
  trades.push({
    symbol: t.symbol, side: t.side, grade: t.grade, confidence: t.confidence,
    entry: r2(t.entry), exit: r2(exitPrice), sl: r2(t.sl), tp2: r2(t.tp2),
    risk: r2(t.risk), r: r2(rMult), pnlINR: r2(pnlINR), reason,
    entryBar: t.entryBar, exitBar, holdBars: exitBar - t.entryBar,
    entryTime: t.entryTime ?? null,
    planStyle: t.planStyle, modelsVoting: t.modelsVoting,
  });
}

/** v10.8: shared R-multiple stats block (the Strategy Lab aggregates
 *  custom-strategy results with the SAME math as the ensemble backtest). */
export function statsFromTrades(trades) { return statsFrom(trades); }

function statsFrom(trades) {
  const n = trades.length;
  if (n === 0) return { trades: 0, wins: 0, losses: 0, winRate: null, avgR: null, totalR: 0, profitFactor: null, maxDDR: 0, avgHoldBars: null, pnlINR: 0 };
  const wins = trades.filter(t => t.r > 0);
  const losses = trades.filter(t => t.r <= 0);
  const totalR = trades.reduce((a, t) => a + t.r, 0);
  const grossWin = wins.reduce((a, t) => a + t.r, 0);
  const grossLoss = Math.abs(losses.reduce((a, t) => a + t.r, 0));
  // max drawdown in R on the cumulative equity curve
  let cum = 0, peak = 0, maxDD = 0;
  for (const t of trades) {
    cum += t.r;
    if (cum > peak) peak = cum;
    if (peak - cum > maxDD) maxDD = peak - cum;
  }
  return {
    trades: n,
    wins: wins.length,
    losses: losses.length,
    winRate: r2((wins.length / n) * 100),
    avgR: r2(totalR / n),
    totalR: r2(totalR),
    profitFactor: grossLoss > 0 ? r2(grossWin / grossLoss) : (grossWin > 0 ? Infinity : null),
    maxDDR: r2(maxDD),
    avgHoldBars: r2(trades.reduce((a, t) => a + t.holdBars, 0) / n),
    pnlINR: r2(trades.reduce((a, t) => a + (t.pnlINR || 0), 0)),
  };
}

// ---------------- v6.7: learned gates (glama jakemo007-inspired) ----------------
/**
 * "The agent learns from backtests and applies those rules live."
 * Honest version: per-grade PERFORMANCE + a bounded gate
 * recommendation. We never auto-apply — the user sees the numbers
 * and clicks. Rules:
 *   • STRONG (n≥20) winRate < 45%  → recommend RAISING minConfidence
 *     (the bar is letting weak "strongs" through) — capped at 85
 *   • ACTION (n≥20) winRate ≥ 60%  → the ensemble is under-trading
 *     its second tier — suggest lowering minConfidence to harvest it
 *     (floor 60) — ONLY if STRONG's own winRate is healthy ≥ 50%
 *   • anything else → keep current (insufficient evidence)
 */
export function learnedGates(trades, currentMinConfidence = 75) {
  const per = {};
  for (const g of ['STRONG', 'ACTION', 'WATCH']) {
    const t = trades.filter(x => x.grade === g);
    const wins = t.filter(x => x.r > 0).length;
    per[g] = {
      n: t.length,
      winRate: t.length > 0 ? Math.round((wins / t.length) * 1000) / 10 : null,
      avgR: t.length > 0 ? Math.round((t.reduce((a, x) => a + x.r, 0) / t.length) * 100) / 100 : null,
    };
  }
  let suggested = currentMinConfidence;
  let why = 'insufficient settled evidence to move the gate — keeping the current bar';
  if (per.STRONG.n >= 20 && per.STRONG.winRate != null) {
    if (per.STRONG.winRate < 45) {
      suggested = Math.min(85, Math.max(currentMinConfidence, 80));
      why = `STRONG signals won only ${per.STRONG.winRate}% of ${per.STRONG.n} backtested trades — raise the bar so only cleaner confluences grade STRONG`;
    } else if (per.ACTION.n >= 20 && per.ACTION.winRate != null && per.ACTION.winRate >= 60) {
      suggested = Math.max(60, Math.min(currentMinConfidence, 70));
      why = `ACTION signals won ${per.ACTION.winRate}% of ${per.ACTION.n} trades (STRONG itself is ${per.STRONG.winRate}%) — the 55–75% confidence band is under-traded: lowering the STRONG bar to ${suggested}% harvests it`;
    } else if (per.STRONG.winRate >= 55) {
      why = `STRONG health-check passed (${per.STRONG.winRate}% of ${per.STRONG.n}) — current gate is calibrated, no change recommended`;
    }
  }
  const changed = suggested !== currentMinConfidence;
  return {
    perGrade: per,
    currentMinConfidence,
    suggestedMinConfidence: changed ? suggested : null,
    recommendation: why,
    changed,
    disclaimer: 'Backtest-learned, bounded to 60–85, human-approved. Past ≠ future. Apply only if you accept the trade-off described above.',
  };
}

// ---------------- v21.1.0 (Phase-4): WALK-FORWARD TRAIN/TEST ----------------
/**
 * Overfit-pakadne wala split: candles 70/30 me kat-te hain —
 *   TRAIN (pehla 70%): default gates pe replay → learnedGates() ek
 *     confidence bar "seekhta" hai (sirf in-sample trades se).
 *   TEST (aakhri 30%, WARMUP carry ke saath): usi LEARNED bar pe replay.
 * Verdict: train-expectancy vs test-expectancy ka degradation —
 *   HIGH overfit (>40% drop), MODERATE (>15%), ya CALIBRATED.
 * Ye backtest ke "no look-ahead" replay ke UPAR hai: gate-tuning bhi
 * ab out-of-sample me verify hota hai, sirf in-sample flattery nahi.
 */
export function walkForwardSymbol({ symbol, market, candles, maxRiskPct = 5, capitalPerTradeINR = 1000, maxHoldBars = 48, currentMinConfidence = 75, trainPct = 0.7, strategy = 'weighted' }) {
  if (!Array.isArray(candles) || candles.length < (WARMUP + 20) * 2) return null;
  const cut = Math.max(WARMUP + 30, Math.floor(candles.length * trainPct));
  const trainC = candles.slice(0, cut);
  const testC = candles.slice(Math.max(WARMUP, cut - WARMUP)); // indicators test-start pe hot hon

  const base = { symbol, market, maxRiskPct, capitalPerTradeINR, maxHoldBars, strategy };
  const trainSim = simulateSymbol({ ...base, candles: trainC, minGrade: 'ACTION' });
  if (!trainSim) return null;
  const learned = learnedGates(trainSim.trades || [], currentMinConfidence);
  const learnedBar = learned.suggestedMinConfidence ?? currentMinConfidence;

  // TRAIN bhi learned bar pe (in-sample flattery ka reference)
  const trainAtLearned = simulateSymbol({ ...base, candles: trainC, minGrade: 'ACTION', minConfidence: learnedBar });
  // TEST: current bar + learned bar + NO-bar dono legs — "current bar" (live
  // config ka 75) aksar in-sample me hi ZERO trades deta hai (confidence
  // distribution 55-72 rehta hai) — us case me overfit verdict BASE system
  // ke train/test split se aata hai, kuch bhi nahi.
  const testCurrent = simulateSymbol({ ...base, candles: testC, minGrade: 'ACTION', minConfidence: currentMinConfidence });
  const testLearned = simulateSymbol({ ...base, candles: testC, minGrade: 'ACTION', minConfidence: learnedBar });
  const testNoBar = simulateSymbol({ ...base, candles: testC, minGrade: 'ACTION' });

  let trainExp = trainAtLearned?.stats?.avgR ?? null;
  let testExp = testLearned?.stats?.avgR ?? null;
  let comparisonBasis = 'learned-bar';
  const learnedHasTrades = (trainAtLearned?.stats?.trades || 0) > 0 && (testLearned?.stats?.trades || 0) > 0;
  if (!learnedHasTrades) {
    // learned bar pe dono legs empty → BASE split comparison (no confidence filter)
    trainExp = trainSim.stats?.avgR ?? null;
    testExp = testNoBar?.stats?.avgR ?? null;
    comparisonBasis = 'base-split (learned bar pe zero trades)';
  }
  let overfit = 'UNKNOWN';
  let degradationPct = null;
  if (trainExp != null && testExp != null && trainExp > 0) {
    degradationPct = Math.round(((trainExp - testExp) / trainExp) * 1000) / 10;
    overfit = degradationPct > 40 ? 'HIGH' : degradationPct > 15 ? 'MODERATE' : 'CALIBRATED';
  } else if (trainExp != null && testExp != null) {
    // v21.1.1 [audit A8]: train expectancy <= 0 ho to system me edge hi
    // nahi hai — pehle testExp > trainExp pe 'CALIBRATED' bol deta tha
    // (loschh consistent system = calibrated padh lena, misleading).
    // Ab: train negative → NO_EDGE / NO_TRAIN_EDGE hi, chahe test kuch bhi ho.
    overfit = trainExp <= 0 ? (testExp > 0 ? 'NO_TRAIN_EDGE' : 'NO_EDGE') : 'NO_EDGE';
  }

  return {
    symbol,
    split: { trainBars: trainC.length, testBars: testC.length, trainPct, learnedBar, currentBar: currentMinConfidence },
    train: { defaultGates: trainSim.stats, atLearnedBar: trainAtLearned?.stats ?? null, learned },
    test: { currentBar: testCurrent?.stats ?? null, learnedBar: testLearned?.stats ?? null, noBar: testNoBar?.stats ?? null },
    verdict: { overfit, degradationPct, comparisonBasis },
  };
}

// ---------------- multi-symbol runner (cached) ----------------
const DEFAULT_CRYPTO = ['BTC', 'ETH', 'BNB', 'SOL', 'XRP', 'DOGE'];
const DEFAULT_INDIA = ['RELIANCE', 'HDFCBANK', 'ICICIBANK', 'INFY', 'TCS', 'SBIN'];
const _cache = new Map();
const CACHE_TTL = 10 * 60_000;
// v10.18 (deep-recheck #3): the cache key embeds the caller's symbol
// list — an authed user iterating combos grew this map with full
// backtest payloads forever. Bounded like every other repo cache.
const CACHE_CAP = 24;

export async function runBacktest({ market = 'CRYPTO', symbols, minGrade = 'ACTION', capitalPerTradeINR = 1000, maxRiskPct = 5, currentMinConfidence = 75, strategy = 'weighted', walkForward = false }) {
  const mkt = String(market).toUpperCase() === 'INDIA' ? 'INDIA' : 'CRYPTO';
  const syms = (Array.isArray(symbols) && symbols.length > 0 ? symbols : (mkt === 'CRYPTO' ? DEFAULT_CRYPTO : DEFAULT_INDIA))
    .map(s => String(s).toUpperCase().replace(/[^A-Z0-9-]/g, '')).filter(Boolean).slice(0, 8);
  // v21.1.1 [audit A7]: currentMinConfidence ab cache key me — learned gates
  // is value se derive hote hain; config change ke baad bhi 10-min TTL
  // cache purana verdict serve karta tha (walk-forward verdict bhi).
  const key = `bt:${mkt}:${syms.join(',')}:${minGrade}:${capitalPerTradeINR}:${maxRiskPct}:${strategy}:${currentMinConfidence}:${walkForward ? 'wf' : 'std'}`;
  const hit = _cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL) return hit.payload;

  const maxHoldBars = mkt === 'CRYPTO' ? 48 : 5; // 48h vs 5 trading days
  const results = await Promise.allSettled(syms.map(async (sym) => {
    let candles = null;
    let source = null;
    if (mkt === 'CRYPTO') {
      candles = await fetchCoinDcxCandles(sym, '1h').catch(() => null);
      if (candles) source = 'coindcx-1h';
      else {
        candles = await fetchYahooHourlyCrypto(sym).catch(() => null);
        if (candles) source = 'yahoo-1h-USD';
      }
    } else {
      candles = await fetchYahooDailyCandles(sym).catch(() => null);
      if (candles) source = 'yahoo-1d';
    }
    if (!candles) return { symbol: sym, ok: false, reason: 'no historical data (CoinDCX + Yahoo both unreachable)' };
    const sim = simulateSymbol({ symbol: sym, market: mkt, candles, minGrade, maxRiskPct, capitalPerTradeINR, maxHoldBars, strategy });
    if (!sim) return { symbol: sym, ok: false, reason: 'not enough bars' };
    // v21.1.0 (Phase-4): WALK-FORWARD train/test leg — overfit verdict per symbol.
    let wf = null;
    if (walkForward) {
      wf = walkForwardSymbol({ symbol: sym, market: mkt, candles, maxRiskPct, capitalPerTradeINR, maxHoldBars, currentMinConfidence, strategy });
    }
    // v10.6 A/B: the regime leg also runs the PLAIN leg on the SAME
    // candles — identical folds, side-by-side comparison.
    let comparison = null;
    if (strategy === 'regime_weighted') {
      const plain = simulateSymbol({ symbol: sym, market: mkt, candles, minGrade, maxRiskPct, capitalPerTradeINR, maxHoldBars, strategy: 'weighted' });
      comparison = plain ? { weighted: plain.stats, regime_weighted: sim.stats } : null;
    }
    return { symbol: sym, ok: true, source, ...(comparison ? { comparison } : {}), ...(wf ? { walkForward: wf } : {}), ...sim };
  }));

  const perSymbol = results.map(r => r.status === 'fulfilled' ? r.value : { symbol: '?', ok: false, reason: 'failed' });
  const allTrades = perSymbol.filter(s => s.ok).flatMap(s => s.trades.map(t => ({ ...t, symbol: s.symbol })));
  // v6.12.1 FIX (recheck M-2): sort CHRONOLOGICALLY by the (now
  // stamped) entry time — trades previously carried no `entryTime`, so
  // the primary comparator was NaN and the equity curve + maxDD were
  // computed over a symbol-alphabetical phantom ordering.
  allTrades.sort((a, b) => ((a.entryTime ?? 0) - (b.entryTime ?? 0)) || (a.symbol < b.symbol ? -1 : 1));
  // equity curve in cumulative R (chronological)
  let cum = 0;
  const equity = allTrades.map((t, idx) => { cum += t.r; return { i: idx + 1, cumR: r2(cum), symbol: t.symbol, r: t.r }; });
  const stats = statsFrom(allTrades);
  const gradeDist = {};
  for (const t of allTrades) gradeDist[t.grade] = (gradeDist[t.grade] || 0) + 1;
  const exitDist = {};
  for (const t of allTrades) exitDist[t.reason] = (exitDist[t.reason] || 0) + 1;

  const payload = {
    ok: allTrades.length > 0 || perSymbol.some(s => s.ok),
    market: mkt,
    strategy,
    params: { minGrade, capitalPerTradeINR, maxRiskPct, maxHoldBars, slippagePct: 0.1, warmupBars: WARMUP },
    scannedSymbols: perSymbol.filter(s => s.ok).length,
    dataSources: perSymbol.filter(s => s.ok).map(s => ({ symbol: s.symbol, source: s.source })),
    perSymbol,
    stats: { ...stats, symbols: perSymbol.filter(s => s.ok).length },
    gradeDist, exitDist,
    equity: equity.slice(-120), // cap the payload
    trades: allTrades.slice(-40).reverse(), // most recent first (display)
    barsInfo: perSymbol.map(s => ({ symbol: s.symbol, ok: s.ok, source: s.source || null })),
    // v6.7: backtest-learned gate tuning (read-only recommendation —
    // the user applies it; nothing auto-mutates the live config)
    learned: learnedGates(allTrades, currentMinConfidence),
    // v21.1.0 (Phase-4): aggregate overfit verdict jab walk-forward mode ON ho
    ...(walkForward ? {
      walkForward: {
        perSymbol: perSymbol.filter(s => s.ok && s.walkForward).map(s => ({ symbol: s.symbol, ...s.walkForward })),
        summary: (() => {
          const rows = perSymbol.filter(s => s.ok && s.walkForward?.verdict).map(s => s.walkForward.verdict);
          if (!rows.length) return null;
          return {
            symbols: rows.length,
            high: rows.filter(v => v.overfit === 'HIGH').length,
            moderate: rows.filter(v => v.overfit === 'MODERATE').length,
            calibrated: rows.filter(v => v.overfit === 'CALIBRATED').length,
          };
        })(),
      },
    } : {}),
    disclaimer: 'Walk-forward replay of the SAME live ensemble on historical candles. Past performance ≠ future results. R = multiples of initial risk. No AI Council vote (offline in backtests).',
    generatedAt: Date.now(),
  };
  _cache.set(key, { at: Date.now(), payload });
  // v10.18: bounded — the key embeds the caller's symbol list, so an
  // authed user iterating combos grew this map with full backtest
  // payloads forever (same discipline as every other repo cache).
  if (_cache.size > CACHE_CAP) {
    const entries = [..._cache.entries()].sort((a, b) => a[1].at - b[1].at);
    for (const [k] of entries.slice(0, _cache.size - CACHE_CAP)) _cache.delete(k);
  }
  return payload;
}

export function __clearBacktestCache() { _cache.clear(); }
