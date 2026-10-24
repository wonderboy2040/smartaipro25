// scripts/smart-trail-replay.mjs — v21.24.0
// Run from app/:  node scripts/smart-trail-replay.mjs [paths=20000] [seed=7]
// SYNTHETIC replay: same random price paths fed to the REAL evaluateActiveTradeDeepMonitor under
//   SMART_TRAIL_V2=off (v1) vs enforce (v2). Shows the MECHANISM (exit geometry vs noise, fee drag,
//   rolling TP2) — it is NOT a market backtest and says nothing about signal edge.
import { evaluateActiveTradeDeepMonitor } from '../server/ai/mtfAutoLink.js';

const N = Number(process.argv[2]) || 20000;
let seed = Number(process.argv[3]) || 7;
const rnd = () => (seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296;
const gauss = () => { let u = 0, v = 0; while (u === 0) u = rnd(); while (v === 0) v = rnd(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };

const FEE_RT = 0.0010;            // 0.05% per side round trip (repo default; verify with your CoinDCX fee tier)
const STEPS = 96;                 // 96 x 5m = 8h
const R_MULTS = [1.0, 1.4, 2.0];  // stop distance in units of 5m ATR (AVAX live trade was ~ the 1.0 case)

function makePath(driftBias, phi = 0) {
  const atr5 = 0.0015 + rnd() * 0.0035;           // 0.15%..0.50% per 5m ATR
  const sigma = atr5 / 1.25;                      // per-bar sd
  const mu1 = (driftBias + (rnd() - 0.5) * 0.5) * sigma;
  const flip = rnd() < 0.3;                       // regime change mid-way
  const mu2 = flip ? -mu1 * (0.5 + rnd()) : mu1;
  const rets = [], vols = [];
  let prev = 0;
  for (let i = 0; i < STEPS; i++) {
    const r = (i < STEPS / 2 ? mu1 : mu2) + sigma * gauss() + phi * prev;   // phi<0 = choppy / mean-reverting
    rets.push(r); prev = r; vols.push(0.8 + rnd() * 0.9);
  }
  return { atr5, rets, vols };
}

function runOne(path, rMult, mode) {
  process.env.SMART_TRAIL_V2 = mode;
  const entry = 100;
  const risk = entry * path.atr5 * rMult;
  let tr = {
    symbol: 'SIMUSDT', market: 'FUTURES', execMarket: 'FUTURES', ccy: 'USDT', side: 'LONG', executionMode: 'LIVE',
    entry, entryPrice: entry, stopLoss: entry - risk, initialStopLoss: entry - risk, t1: entry + risk, t2: entry + 2 * risk,
    qty: 1, peakPrice: entry, openedAt: 0, atrPct: path.atr5 * 100 * 1.7, leverage: 10, t2Extensions: 0,
  };
  let px = entry, peakR = 0, exit = null;
  const hist = [];
  for (let i = 0; i < STEPS; i++) {
    px *= (1 + path.rets[i]);
    hist.push(path.rets[i] * 100);
    peakR = Math.max(peakR, (px - entry) / risk);
    // exchange-native SL (carried SL from the previous step) fills at the stop
    if (px <= tr.stopLoss) { exit = { px: tr.stopLoss, why: 'SL' }; break; }
    const r1 = hist[hist.length - 1];
    const r3 = hist.slice(-3).reduce((a, b) => a + b, 0);
    const row = { trigger: { roc1: r1, roc3: r3, volRatio: path.vols[i] }, context: { atrPct: path.atr5 * 100 * 1.7 } };
    const ev = evaluateActiveTradeDeepMonitor(tr, { ltp: px, boardRow: row });
    if (ev.shouldClose) { exit = { px: ev.tp2Hit ? Math.min(px, ev.t2) : px, why: ev.exitReason || 'CLOSE' }; break; }
    tr = { ...tr, peakPrice: ev.peakPrice, stopLoss: ev.trailedStopLoss, trailedStopLoss: ev.trailedStopLoss, t1Hit: tr.t1Hit || ev.tp1Hit, t2: ev.t2, t2Extensions: ev.t2Extensions };
  }
  if (!exit) exit = { px, why: 'TIME' };
  const grossR = (exit.px - entry) / risk;
  const feeR = (entry * FEE_RT) / risk;
  return { netR: grossR - feeR, grossR, feeR, peakR, why: exit.why, rMult };
}

function summarize(rows) {
  const n = rows.length;
  const mean = (a) => a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0;
  const wins = rows.filter(r => r.netR > 0), losses = rows.filter(r => r.netR <= 0);
  const big = rows.filter(r => r.peakR >= 1.5);
  const t2 = rows.filter(r => /TP2|TARGET/.test(r.why)).length;
  return {
    n, meanNetR: +mean(rows.map(r => r.netR)).toFixed(3), win: +(100 * wins.length / n).toFixed(1),
    avgWin: +mean(wins.map(r => r.netR)).toFixed(2), avgLoss: +mean(losses.map(r => r.netR)).toFixed(2),
    feeR: +mean(rows.map(r => r.feeR)).toFixed(2),
    capture: big.length ? +(100 * mean(big.map(r => r.grossR / r.peakR))).toFixed(0) : null,
    tp2: +(100 * t2 / n).toFixed(1),
  };
}

for (const [label, bias, phi] of [
  ['NEUTRAL tape (no edge: drift ~ 0)', 0, 0],
  ['DIRECTION-RIGHT tape (drift +0.35σ — signal was correct)', 0.35, 0],
  ['ADVERSE: CHOPPY mean-reverting tape (phi -0.35, drift 0) — v2 downside check', 0, -0.35],
]) {
  console.log(`\n=== ${label} — ${N} paths per R-bucket ===`);
  for (const rMult of R_MULTS) {
    const paths = Array.from({ length: N }, () => makePath(bias, phi));
    const v1 = summarize(paths.map(p => runOne(p, rMult, 'off')));
    const v2 = summarize(paths.map(p => runOne(p, rMult, 'enforce')));
    console.log(`R = ${rMult} x ATR5`);
    console.log('   v1 ', JSON.stringify(v1));
    console.log('   v2 ', JSON.stringify(v2));
  }
}
console.log('\nLegend: meanNetR = average R per trade AFTER fees | win% | avgWin/avgLoss in R | feeR = fee in R units | capture% = exit/peak on trades that reached >=1.5R | tp2% = exits by TP2');
