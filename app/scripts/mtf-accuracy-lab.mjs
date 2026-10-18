#!/usr/bin/env node
// ============================================================
// scripts/mtf-accuracy-lab.mjs — "Kya zyada timeframes se accuracy
// milti hai?" ka MEASURED jawab (offline research harness).
// ------------------------------------------------------------
// Ye script site ka runtime code NAHI hai — ye ek research lab hai jo
// asli market data (Yahoo chart API: NSE 5m/15m/1h/1d + crypto
// BTC/ETH/SOL) par 5 sawaalon ka number-nikal ke jawab deta hai:
//
//   A) ALIGNMENT STUDY  — ek hi entry rule (5m breakout) lo, aur
//      dekho: jab 0 / 1 / 2 / 3 / 4 timeframes (5m·15m·1h·1d) same
//      direction me aligned hote hain, to win% aur expectancy kya
//      hoti hai? → "zyada TF = zyada accuracy?" ka direct evidence.
//   B) STRATEGY COMPARE — S1 (sirf 5m) vs S2 (15m context + 5m
//      trigger = user plan A) vs S3 (1h context + 15m trigger =
//      user plan B) vs S4/S5 (same + extra TF filters).
//   C) HOLD-WINDOW LAB  — same setup, exit window 15/20/30/60/90/120
//      min vs "poora session": user ka "15-20 min me exit" aur
//      "1-1.5 hr me exit" claim ka test (kitne trades window ke andar
//      target tak pahunchte hain, net expectancy kya rehti hai).
//   D) COST REALITY     — India intraday + crypto taker costs ke
//      BAAD ki net expectancy (gross vs net; chhote SL pe cost ≈
//      0.1-0.2R kha jaati hai).
//   E) MFE DIAGNOSTIC   — 20 min me price average kitna favourable
//      move deta hai (R me) — "jyada profit 15-20 min me" realistic
//      hai ya nahi, iska seedha data.
//
// USAGE:  node scripts/mtf-accuracy-lab.mjs [--fast] [--days=30]
// OUTPUT: lab-out/mtf-lab-results.json + lab-out/mtf-lab-results.md
//
// HONESTY: Yahoo ka 5m/15m data sirf ~60 din ka milta hai → ye
// study ek chhote window (ek-do regime) ki hai, isliye numbers
// "indicative" hain, guarantee nahi. Look-ahead se bachne ke liye
// entry HAMESHA signal bar ke NEXT bar ke open par li jaati hai aur
// same bar me SL+T2 dono lagna ho to SL maana jaata hai
// (conservative). Cost model statutory + flat brokerage use karta hai.
// ============================================================

import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(HERE, '..', 'lab-out');

const argv = process.argv.slice(2);
const FAST = argv.includes('--fast');
const DAYS = Number((argv.find(a => a.startsWith('--days=')) || '').split('=')[1]) || 30;
const DELAY_MS = FAST ? 250 : 450;

// ---------------- universe ----------------
const INDIA = [
  'RELIANCE.NS', 'TCS.NS', 'HDFCBANK.NS', 'ICICIBANK.NS', 'INFY.NS',
  'SBIN.NS', 'ITC.NS', 'LT.NS', 'AXISBANK.NS', 'KOTAKBANK.NS',
  'BHARTIARTL.NS', 'MARUTI.NS', 'TATAMOTORS.NS', 'SUNPHARMA.NS', 'HINDUNILVR.NS',
  'BAJFINANCE.NS', 'ASIANPAINT.NS', 'TITAN.NS', 'WIPRO.NS', 'ADANIENT.NS',
];
const CRYPTO = ['BTC-USD', 'ETH-USD', 'SOL-USD'];

// Indian intraday round-trip cost as % of turnover (Zerodha-like flat
// ₹20/order, ₹1,00,000 notional, 1 buy + 1 sell order):
//   brokerage 40 + STT 25 (0.025% sell) + txn 5.94 + SEBI 0.2 +
//   stamp 3 + GST 18% on (40+5.94+0.2) ≈ ₹82 → 0.082% of turnover.
const COST_PCT = { INDIA: 0.082, CRYPTO: 0.10 };

// ---------------- indicators (series) ----------------
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

function emaSeries(values, period) {
  const out = new Array(values.length).fill(null);
  if (values.length < period) return out;
  const k = 2 / (period + 1);
  let prev = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  out[period - 1] = prev;
  for (let i = period; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

function rsiSeries(closes, period = 14) {
  const out = new Array(closes.length).fill(null);
  if (closes.length <= period) return out;
  let gain = 0, loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d >= 0) gain += d; else loss -= d;
  }
  let ag = gain / period, al = loss / period;
  out[period] = al === 0 ? 100 : 100 - 100 / (1 + ag / al);
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    ag = (ag * (period - 1) + Math.max(d, 0)) / period;
    al = (al * (period - 1) + Math.max(-d, 0)) / period;
    out[i] = al === 0 ? 100 : 100 - 100 / (1 + ag / al);
  }
  return out;
}

function atrSeries(candles, period = 14) {
  const out = new Array(candles.length).fill(null);
  if (candles.length <= period) return out;
  const tr = new Array(candles.length).fill(0);
  for (let i = 0; i < candles.length; i++) {
    const p = candles[i - 1];
    tr[i] = p ? Math.max(candles[i].high - candles[i].low, Math.abs(candles[i].high - p.close), Math.abs(candles[i].low - p.close))
      : candles[i].high - candles[i].low;
  }
  let prev = tr.slice(1, period + 1).reduce((a, b) => a + b, 0) / period;
  out[period] = prev;
  for (let i = period + 1; i < candles.length; i++) {
    prev = (prev * (period - 1) + tr[i]) / period;
    out[i] = prev;
  }
  return out;
}

function macdHistSeries(closes, fast = 12, slow = 26, sig = 9) {
  const ef = emaSeries(closes, fast), es = emaSeries(closes, slow);
  const macd = closes.map((_, i) => (ef[i] != null && es[i] != null ? ef[i] - es[i] : null));
  const valid = macd.filter(v => v != null);
  const sigArr = emaSeries(valid, sig);
  const out = new Array(closes.length).fill(null);
  let k = 0;
  for (let i = 0; i < closes.length; i++) {
    if (macd[i] == null) continue;
    out[i] = sigArr[k] != null ? macd[i] - sigArr[k] : null;
    k++;
  }
  return out;
}

function adxSeries(candles, period = 14) {
  const n = candles.length;
  const out = new Array(n).fill(null);
  if (n < period * 2) return out;
  const tr = new Array(n).fill(0), plusDM = new Array(n).fill(0), minusDM = new Array(n).fill(0);
  for (let i = 1; i < n; i++) {
    const c = candles[i], p = candles[i - 1];
    tr[i] = Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close));
    const up = c.high - p.high, dn = p.low - c.low;
    plusDM[i] = up > dn && up > 0 ? up : 0;
    minusDM[i] = dn > up && dn > 0 ? dn : 0;
  }
  const smooth = (arr) => {
    const s = new Array(n).fill(null);
    let sum = arr.slice(1, period + 1).reduce((a, b) => a + b, 0);
    s[period] = sum;
    for (let i = period + 1; i < n; i++) { sum = sum - sum / period + arr[i]; s[i] = sum; }
    return s;
  };
  const trS = smooth(tr), pS = smooth(plusDM), mS = smooth(minusDM);
  const dx = new Array(n).fill(null);
  for (let i = period; i < n; i++) {
    if (trS[i] == null || trS[i] === 0) continue;
    const pdi = 100 * (pS[i] / trS[i]), mdi = 100 * (mS[i] / trS[i]);
    const sum = pdi + mdi;
    dx[i] = sum === 0 ? 0 : 100 * Math.abs(pdi - mdi) / sum;
  }
  // Wilder smoothing of DX → ADX
  const first = dx.findIndex((v, i) => v != null && i >= period * 2 - 1);
  if (first === -1) return out;
  let prev = dx.slice(period, first + 1).filter(v => v != null).reduce((a, b) => a + b, 0) / Math.max(1, dx.slice(period, first + 1).filter(v => v != null).length);
  out[first] = prev;
  for (let i = first + 1; i < n; i++) {
    if (dx[i] == null) { out[i] = prev; continue; }
    prev = (prev * (period - 1) + dx[i]) / period;
    out[i] = prev;
  }
  return out;
}

function volSmaSeries(candles, period = 20) {
  const out = new Array(candles.length).fill(null);
  let sum = 0;
  for (let i = 0; i < candles.length; i++) {
    sum += candles[i].volume || 0;
    if (i >= period) sum -= candles[i - period].volume || 0;
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

// ---------------- data fetch (Yahoo, IST-aware) ----------------
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function istParts(ms) {
  const f = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kolkata', hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  });
  const p = Object.fromEntries(f.formatToParts(new Date(ms)).map(x => [x.type, x.value]));
  return { day: `${p.year}-${p.month}-${p.day}`, hh: Number(p.hour), mm: Number(p.minute) };
}
const istMinutes = (ms) => { const { hh, mm } = istParts(ms); return hh * 60 + mm; };

async function yahoo(ticker, interval, range) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=${interval}&range=${range}&includePrePost=false`;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (SmartAI mtf-lab)' }, signal: AbortSignal.timeout(20_000) });
      if (r.status === 429 || r.status >= 500) { await sleep(1200 * (attempt + 1)); continue; }
      if (!r.ok) return null;
      const j = await r.json();
      const res = j?.chart?.result?.[0];
      const ts = res?.timestamp, q = res?.indicators?.quote?.[0];
      if (!Array.isArray(ts) || !q) return null;
      const out = [];
      for (let i = 0; i < ts.length; i++) {
        if (q.open?.[i] == null || q.close?.[i] == null || q.high?.[i] == null || q.low?.[i] == null) continue;
        out.push({
          t: ts[i] * 1000, open: q.open[i], high: q.high[i], low: q.low[i],
          close: q.close[i], volume: q.volume?.[i] || 0,
        });
      }
      return out.length ? out : null;
    } catch { await sleep(800 * (attempt + 1)); }
  }
  return null;
}

/** NSE session filter (09:15–15:30 IST start times) — crypto untouched. */
function filterSession(candles, isIndia) {
  if (!isIndia) return candles;
  return candles.filter(c => { const m = istMinutes(c.t); return m >= 9 * 60 + 15 && m <= 15 * 60 + 30; });
}

/** index of last closed bar at ts (bar close = start + tfMin) */
function lastClosedIdx(candles, ts, tfMin) {
  let lo = 0, hi = candles.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (candles[mid].t + tfMin * 60_000 <= ts) { ans = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return ans;
}

// ---------------- level (per-timeframe) analytics ----------------
function buildLevel(candles, tfMin) {
  const closes = candles.map(c => c.close);
  return {
    candles, tfMin,
    ema9: emaSeries(closes, 9),
    ema20: emaSeries(closes, 20),
    ema50: emaSeries(closes, 50),
    rsi: rsiSeries(closes, 14),
    atr: atrSeries(candles, 14),
    macdH: macdHistSeries(closes),
    adx: adxSeries(candles, 14),
    vSma: volSmaSeries(candles, 20),
  };
}

/** Directional bias of a level at closed-bar index i: +1 / -1 / 0. */
function biasAt(lv, i) {
  if (i == null || i < 55) return 0;
  const { ema20, ema50, macdH, adx } = lv;
  if (ema20[i] == null || ema50[i] == null) return 0;
  const up = ema20[i] > ema50[i] && lv.candles[i].close > ema20[i];
  const dn = ema20[i] < ema50[i] && lv.candles[i].close < ema20[i];
  const strong = (adx[i] ?? 0) >= 14;
  const mom = (macdH[i] ?? 0);
  if (up && strong && mom > 0) return 1;
  if (dn && strong && mom < 0) return -1;
  // softer fallback (structure only) — still counts as "with trend"
  if (up) return 1;
  if (dn) return -1;
  return 0;
}

// ---------------- trade simulation ----------------
/**
 * Simulate a long/short from the bar AFTER signalIdx.
 * SL = slMult × ATR(trigger) at signal time; target = targetR × risk.
 * First-touch between SL and target inside `holdBars`; else time-exit
 * at that bar's close. Same-bar SL+target → SL (conservative).
 */
function simulate({ candles: lv, tfMin, signalIdx, dir, slMult, targetR, holdBars }) {
  const entryIdx = signalIdx + 1;
  if (entryIdx >= lv.length) return null;
  const a = signalIdx >= 0 ? __atr(lv, signalIdx) : null;
  if (!a || a <= 0) return null;
  const entry = lv[entryIdx].open;
  const risk = slMult * a;
  if (!(entry > 0) || !(risk > 0)) return null;
  const sl = dir > 0 ? entry - risk : entry + risk;
  const tgt = dir > 0 ? entry + targetR * risk : entry - targetR * risk;
  const lastIdx = Math.min(lv.length - 1, entryIdx + holdBars - 1);
  let mfe = 0, mae = 0, exitR = null, exitIdx = lastIdx, reason = 'TIME';
  for (let j = entryIdx; j <= lastIdx; j++) {
    const c = lv[j];
    const fav = dir > 0 ? (c.high - entry) / risk : (entry - c.low) / risk;
    const adv = dir > 0 ? (entry - c.low) / risk : (c.high - entry) / risk;
    mfe = Math.max(mfe, fav); mae = Math.max(mae, adv);
    const hitSl = dir > 0 ? c.low <= sl : c.high >= sl;
    const hitTp = dir > 0 ? c.high >= tgt : c.low <= tgt;
    if (hitSl && hitTp) { exitR = -1; exitIdx = j; reason = 'SL'; break; }
    if (hitSl) { exitR = -1; exitIdx = j; reason = 'SL'; break; }
    if (hitTp) { exitR = targetR; exitIdx = j; reason = 'TP'; break; }
  }
  if (exitR == null) {
    const c = lv[lastIdx];
    exitR = dir > 0 ? (c.close - entry) / risk : (entry - c.close) / risk;
    reason = 'TIME';
  }
  const minutes = Math.max(1, (exitIdx - entryIdx + 1) * (tfMin || 5));
  const riskPct = risk / entry;
  return { exitR, mfe, mae, reason, minutes, riskPct };
}

// ATR cache per candle-array identity (avoids recompute in the loop)
const _atrMemo = new WeakMap();
function __atr(candles, idx) {
  let s = _atrMemo.get(candles);
  if (!s) { s = atrSeries(candles, 14); _atrMemo.set(candles, s); }
  return s[idx];
}


// ---------------- aggregation helpers ----------------
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
const median = (a) => {
  if (!a.length) return 0;
  const s = [...a].sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

function summarize(rows, costPct) {
  if (!rows.length) return { n: 0 };
  const Rs = rows.map(r => r.exitR);
  const wins = rows.filter(r => r.exitR > 0);
  const losses = rows.filter(r => r.exitR <= 0);
  const grossExp = mean(Rs);
  const netRs = rows.map(r => r.exitR - (costPct / 100) / Math.max(1e-9, r.riskPct));
  const netExp = mean(netRs);
  const byReason = rows.reduce((acc, r) => { acc[r.reason] = (acc[r.reason] || 0) + 1; return acc; }, {});
  return {
    n: rows.length,
    winPct: +(100 * wins.length / rows.length).toFixed(1),
    grossExpR: +grossExp.toFixed(3),
    netExpR: +netExp.toFixed(3),
    avgWinR: +mean(wins.map(r => r.exitR)).toFixed(2),
    avgLossR: +mean(losses.map(r => r.exitR)).toFixed(2),
    mfeMedianR: +median(rows.map(r => r.mfe)).toFixed(2),
    maeMedianR: +median(rows.map(r => r.mae)).toFixed(2),
    tpPct: +(100 * (byReason.TP || 0) / rows.length).toFixed(1),
    slPct: +(100 * (byReason.SL || 0) / rows.length).toFixed(1),
    timePct: +(100 * (byReason.TIME || 0) / rows.length).toFixed(1),
    medianMin: Math.round(median(rows.map(r => r.minutes))),
    avgRiskPct: +(100 * mean(rows.map(r => r.riskPct))).toFixed(2),
    costR: +((costPct / 100) / Math.max(1e-9, mean(rows.map(r => r.riskPct)))).toFixed(3),
  };
}

// ---------------- per-symbol analysis ----------------
function analyzeSymbol(name, market, levels, cfg) {
  const { m5, m15, h1, d } = levels;
  const costPct = COST_PCT[market] || 0.08;
  const out = { symbol: name, market, m5Bars: m5.candles.length, alignment: [], strategies: {}, holdLab: {}, mfe20: null };

  // -------- A) ALIGNMENT STUDY (5m breakout trigger, bucketed by #aligned TFs) --------
  const buckets = new Map();  // k → rows (target 2R)
  const buckets1 = new Map(); // k → rows (target 1R — user plan ka T1)
  const mfe20Rows = [];
  const { slMult = 1.5, targetR = 2, holdBars = 78 } = cfg;
  for (let i = 60; i < m5.candles.length - 2; i++) {
    const c = m5.candles[i], p = m5.candles[i - 1];
    const dir = c.close > p.high ? 1 : (c.close < p.low ? -1 : 0);
    if (!dir) continue;
    if ((m5.vSma[i] ?? 0) > 0 && (c.volume || 0) < 1.1 * m5.vSma[i]) continue; // volume filter
    const tsClose = c.t + m5.tfMin * 60_000;
    const i15 = lastClosedIdx(m15.candles, tsClose, m15.tfMin);
    const i1h = lastClosedIdx(h1.candles, tsClose, h1.tfMin);
    const i1d = lastClosedIdx(d.candles, tsClose, d.tfMin);
    const b5 = biasAt(m5, i), b15 = biasAt(m15, i15), b1h = biasAt(h1, i1h), b1d = biasAt(d, i1d);
    const align = [b5, b15, b1h, b1d].filter(b => b === dir).length;
    const sim = simulate({ candles: m5.candles, tfMin: m5.tfMin, signalIdx: i, dir, slMult, targetR, holdBars });
    const sim1 = simulate({ candles: m5.candles, tfMin: m5.tfMin, signalIdx: i, dir, slMult, targetR: 1, holdBars });
    if (!sim || !sim1) continue;
    const row = { dir, align, ...sim, b5, b15, b1h, b1d };
    const arr = buckets.get(align) || []; arr.push(row); buckets.set(align, arr);
    const arr1 = buckets1.get(align) || []; arr1.push(sim1); buckets1.set(align, arr1);

    // MFE inside the user's 15–20 min window (4 × 5m bars)
    const e = i + 1;
    if (e + 3 < m5.candles.length) {
      const entry = m5.candles[e].open;
      const risk = slMult * __atr(m5.candles, i);
      if (risk > 0) {
        let fav = 0;
        for (let j = e; j <= e + 3; j++) {
          const cc = m5.candles[j];
          fav = Math.max(fav, dir > 0 ? (cc.high - entry) / risk : (entry - cc.low) / risk);
        }
        mfe20Rows.push({ r: fav, riskPct: risk / entry, align });
      }
    }
  }
  out.alignment = [...buckets.keys()].sort().map(k => {
    const two = summarize(buckets.get(k), costPct);
    const one = summarize(buckets1.get(k) || [], costPct);
    return {
      alignedTfs: k, ...two,
      winPct1R: one.winPct, grossExpR1R: one.grossExpR, netExpR1R: one.netExpR,
      tpPct1R: one.tpPct, timePct1R: one.timePct, medianMin1R: one.medianMin,
    };
  });
  out.mfe20 = {
    n: mfe20Rows.length,
    medianMfeR: +median(mfe20Rows.map(r => r.r)).toFixed(2),
    p75MfeR: +(function (a) { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(0.75 * (s.length - 1))] : 0; })(mfe20Rows.map(r => r.r)).toFixed(2),
    pctReaching1R: +(100 * mfe20Rows.filter(r => r.r >= 1).length / Math.max(1, mfe20Rows.length)).toFixed(1),
    pctReaching05R: +(100 * mfe20Rows.filter(r => r.r >= 0.5).length / Math.max(1, mfe20Rows.length)).toFixed(1),
    avgRiskPct: +(100 * mean(mfe20Rows.map(r => r.riskPct))).toFixed(2),
  };

  // -------- B) STRATEGY COMPARE --------
  const strat = (contextLv, contextTfMin, extra) => {
    const rows = [];
    for (let i = 60; i < m5.candles.length - 2; i++) {
      const c = m5.candles[i], p = m5.candles[i - 1];
      const dir = c.close > p.high ? 1 : (c.close < p.low ? -1 : 0);
      if (!dir) continue;
      if ((m5.vSma[i] ?? 0) > 0 && (c.volume || 0) < 1.1 * m5.vSma[i]) continue;
      const tsClose = c.t + m5.tfMin * 60_000;
      const ctxIdx = lastClosedIdx(contextLv.candles, tsClose, contextLv.tfMin);
      const bCtx = biasAt(contextLv, ctxIdx);
      // trigger-quality gate on 5m: RSI in a healthy band + trigger bar body
      const r5 = m5.rsi[i];
      const bodyOk = dir > 0 ? c.close > c.open : c.close < c.open;
      const rsiOk = dir > 0 ? (r5 ?? 50) >= 48 && (r5 ?? 50) <= 78 : (r5 ?? 50) <= 52 && (r5 ?? 50) >= 22;
      if (!bodyOk || !rsiOk) continue;
      if (extra) {
        const tsE = c.t + m5.tfMin * 60_000;
        const ok = extra.every((lvl) => biasAt(lvl, lastClosedIdx(lvl.candles, tsE, lvl.tfMin)) === dir);
        if (!ok) continue;
      }
      if (contextLv && bCtx !== dir) continue;
      const sim = simulate({ candles: m5.candles, tfMin: m5.tfMin, signalIdx: i, dir, slMult, targetR, holdBars });
      if (sim) rows.push(sim);
    }
    return summarize(rows, costPct);
  };

  const S1 = (() => { // single TF: 5m-only trend rule (no HTF filter)
    const rows = [];
    for (let i = 60; i < m5.candles.length - 2; i++) {
      const e9 = m5.ema9[i], e21 = m5.ema20[i], e9p = m5.ema9[i - 1], e21p = m5.ema20[i - 1];
      if (e9 == null || e21 == null || e9p == null || e21p == null) continue;
      const crossUp = e9p <= e21p && e9 > e21, crossDn = e9p >= e21p && e9 < e21;
      if (!crossUp && !crossDn) continue;
      const dir = crossUp ? 1 : -1;
      const r5 = m5.rsi[i] ?? 50;
      if (dir > 0 && r5 < 52) continue;
      if (dir < 0 && r5 > 48) continue;
      const sim = simulate({ candles: m5.candles, tfMin: m5.tfMin, signalIdx: i, dir, slMult, targetR, holdBars });
      if (sim) rows.push(sim);
    }
    return summarize(rows, costPct);
  })();

  const S0 = (() => { // random-entry baseline: alternating long/short every 40th bar
    const rows = [];
    for (let i = 60; i < m5.candles.length - 2; i += 40) {
      const dir = (Math.floor(i / 40) % 2) ? 1 : -1;
      const sim = simulate({ candles: m5.candles, tfMin: m5.tfMin, signalIdx: i, dir, slMult, targetR, holdBars });
      if (sim) rows.push(sim);
    }
    return summarize(rows, costPct);
  })();

  const S2 = strat(m15, 15, null);                              // 15m context + 5m trigger (user plan A)
  const S3 = (() => { // 1h context + 15m trigger — user plan B (trades live on the 15m tape)
    const rows = [];
    const t15 = m15, trig = m15;
    for (let i = 60; i < trig.candles.length - 2; i++) {
      const c = trig.candles[i], p = trig.candles[i - 1];
      const dir = c.close > p.high ? 1 : (c.close < p.low ? -1 : 0);
      if (!dir) continue;
      if ((trig.vSma[i] ?? 0) > 0 && (c.volume || 0) < 1.1 * trig.vSma[i]) continue;
      const tsClose = c.t + t15.tfMin * 60_000;
      if (biasAt(h1, lastClosedIdx(h1.candles, tsClose, h1.tfMin)) !== dir) continue;
      const r = t15.rsi[i] ?? 50;
      if (dir > 0 ? !(r >= 48 && r <= 78) : !(r <= 52 && r >= 22)) continue;
      const sim = simulate({ candles: t15.candles, tfMin: t15.tfMin, signalIdx: i, dir, slMult, targetR, holdBars: Math.ceil(78 / 3) });
      if (sim) rows.push(sim);
    }
    return summarize(rows, costPct);
  })();
  const S4 = strat(m15, 15, [h1]);                      // 15m→5m + 1h align
  const S5 = strat(m15, 15, [h1, d]);            // 15m→5m + 1h + 1d align

  out.strategies = {
    'S0: random-entry baseline': S0,
    'S1: 5m-only (single TF)': S1,
    'S2: 15m context + 5m trigger (user plan A)': S2,
    'S3: 1h context + 15m trigger (user plan B)': S3,
    'S4: S2 + 1h alignment': S4,
    'S5: S2 + 1h + 1d alignment (4 TF)': S5,
  };

  // -------- C) HOLD-WINDOW LAB (S2 rule, different time-stops) --------
  for (const win of [3, 4, 6, 12, 24, 78]) { // 15 / 20 / 30 / 60 / 120 min / session (5m bars)
    const holdBars = win;
    const rows = [];
    for (let i = 60; i < m5.candles.length - 2; i++) {
      const c = m5.candles[i], p = m5.candles[i - 1];
      const dir = c.close > p.high ? 1 : (c.close < p.low ? -1 : 0);
      if (!dir) continue;
      if ((m5.vSma[i] ?? 0) > 0 && (c.volume || 0) < 1.1 * m5.vSma[i]) continue;
      const tsClose = c.t + m5.tfMin * 60_000;
      if (biasAt(m15, lastClosedIdx(m15.candles, tsClose, m15.tfMin)) !== dir) continue;
      const r = m5.rsi[i] ?? 50;
      if (dir > 0 ? !(r >= 48 && r <= 78) : !(r <= 52 && r >= 22)) continue;
      const sim = simulate({ candles: m5.candles, tfMin: m5.tfMin, signalIdx: i, dir, slMult, targetR, holdBars });
      if (sim) rows.push(sim);
    }
    const label = win === 78 ? 'session (rest of day)' : `${win * 5} min`;
    out.holdLab[label] = summarize(rows, costPct);
  }

  return out;
}

// ---------------- main ----------------
async function main() {
  const t0 = Date.now();
  const symbols = FAST ? [...INDIA.slice(0, 6), ...CRYPTO] : [...INDIA, ...CRYPTO];
  const results = [];
  const ranges = { '5m': `${Math.max(5, Math.min(60, DAYS))}d`, '15m': `${Math.max(5, Math.min(60, DAYS))}d`, '1h': '6mo', '1d': '1y' };

  for (const ticker of symbols) {
    const isIndia = ticker.endsWith('.NS');
    const market = isIndia ? 'INDIA' : 'CRYPTO';
    process.stdout.write(`[lab] ${ticker} … `);
    const raw = {};
    for (const [tf, range] of Object.entries(ranges)) {
      raw[tf] = await yahoo(ticker, tf, range);
      await sleep(DELAY_MS);
    }
    const m5raw = filterSession(raw['5m'] || [], isIndia);
    const m15raw = filterSession(raw['15m'] || [], isIndia);
    const h1raw = filterSession(raw['1h'] || [], isIndia);
    const draw = raw['1d'] || [];
    if (m5raw.length < 400 || m15raw.length < 120 || h1raw.length < 120 || draw.length < 60) {
      console.log(`SKIP (thin data: 5m=${m5raw.length} 15m=${m15raw.length} 1h=${h1raw.length} 1d=${draw.length})`);
      continue;
    }
    const levels = {
      m5: buildLevel(m5raw, 5), m15: buildLevel(m15raw, 15),
      h1: buildLevel(h1raw, 60), d: buildLevel(draw, 1440),
    };
    const res = analyzeSymbol(ticker, market, levels, { slMult: 1.5, targetR: 2, holdBars: 78 });
    results.push(res);
    console.log(`ok (5m bars=${m5raw.length})`);
  }

  // ---------- aggregate ----------
  const agg = (key, sub) => {
    const rows = results.map(r => (sub ? r[sub]?.[key] : r[key])).filter(Boolean);
    if (!rows.length) return null;
    return {
      symbols: rows.length,
      n: rows.reduce((a, r) => a + (r.n || 0), 0),
      winPct: +(mean(rows.map(r => r.winPct || 0))).toFixed(1),
      grossExpR: +mean(rows.map(r => r.grossExpR || 0)).toFixed(3),
      netExpR: +mean(rows.map(r => r.netExpR || 0)).toFixed(3),
      mfeMedianR: +mean(rows.map(r => r.mfeMedianR || 0)).toFixed(2),
      tpPct: +mean(rows.map(r => r.tpPct || 0)).toFixed(1),
      slPct: +mean(rows.map(r => r.slPct || 0)).toFixed(1),
      timePct: +mean(rows.map(r => r.timePct || 0)).toFixed(1),
      medianMin: Math.round(mean(rows.map(r => r.medianMin || 0))),
      avgRiskPct: +mean(rows.map(r => r.avgRiskPct || 0)).toFixed(2),
      costR: +mean(rows.map(r => r.costR || 0)).toFixed(3),
    };
  };

  const stratKeys = results[0] ? Object.keys(results[0].strategies) : [];
  const byMarket = (mkt) => results.filter(r => r.market === mkt);
  const report = {
    generatedAt: new Date().toISOString(),
    windowDays: DAYS,
    runtimeSec: Math.round((Date.now() - t0) / 1000),
    config: { slAtrMult: 1.5, targetR: 2, entryAtNextBarOpen: true, sameBarSLandTP: 'SL (conservative)', costPct: COST_PCT },
    symbols: results.map(r => ({ symbol: r.symbol, market: r.market, bars5m: r.m5Bars })),
    alignmentAll: [0, 1, 2, 3, 4].map(k => {
      const rows = results.flatMap(r => (r.alignment.find(a => a.alignedTfs === k) ? [r.alignment.find(a => a.alignedTfs === k)] : []));
      if (!rows.length) return null;
      return {
        alignedTfs: k,
        n: rows.reduce((a, r) => a + r.n, 0),
        winPct: +mean(rows.map(r => r.winPct)).toFixed(1),
        grossExpR: +mean(rows.map(r => r.grossExpR)).toFixed(3),
        netExpR: +mean(rows.map(r => r.netExpR)).toFixed(3),
        winPct1R: +mean(rows.map(r => r.winPct1R || 0)).toFixed(1),
        grossExpR1R: +mean(rows.map(r => r.grossExpR1R || 0)).toFixed(3),
        netExpR1R: +mean(rows.map(r => r.netExpR1R || 0)).toFixed(3),
        mfeMedianR: +mean(rows.map(r => r.mfeMedianR)).toFixed(2),
        tpPct: +mean(rows.map(r => r.tpPct)).toFixed(1),
      };
    }).filter(Boolean),
    alignmentByMarket: {
      INDIA: [0, 1, 2, 3, 4].map(k => {
        const rows = byMarket('INDIA').flatMap(r => r.alignment.filter(a => a.alignedTfs === k));
        if (!rows.length) return null;
        return { alignedTfs: k, n: rows.reduce((a, r) => a + r.n, 0), winPct: +mean(rows.map(r => r.winPct)).toFixed(1), grossExpR: +mean(rows.map(r => r.grossExpR)).toFixed(3), netExpR: +mean(rows.map(r => r.netExpR)).toFixed(3) };
      }).filter(Boolean),
      CRYPTO: [0, 1, 2, 3, 4].map(k => {
        const rows = byMarket('CRYPTO').flatMap(r => r.alignment.filter(a => a.alignedTfs === k));
        if (!rows.length) return null;
        return { alignedTfs: k, n: rows.reduce((a, r) => a + r.n, 0), winPct: +mean(rows.map(r => r.winPct)).toFixed(1), grossExpR: +mean(rows.map(r => r.grossExpR)).toFixed(3), netExpR: +mean(rows.map(r => r.netExpR)).toFixed(3) };
      }).filter(Boolean),
    },
    strategiesAll: Object.fromEntries(stratKeys.map(k => [k, agg(k, 'strategies')])),
    strategiesIndia: Object.fromEntries(stratKeys.map(k => {
      const rows = byMarket('INDIA').map(r => r.strategies[k]).filter(Boolean);
      if (!rows.length) return [k, null];
      return [k, { n: rows.reduce((a, r) => a + r.n, 0), winPct: +mean(rows.map(r => r.winPct)).toFixed(1), netExpR: +mean(rows.map(r => r.netExpR)).toFixed(3), medianMin: Math.round(mean(rows.map(r => r.medianMin))), timePct: +mean(rows.map(r => r.timePct)).toFixed(1) }];
    })),
    strategiesCrypto: Object.fromEntries(stratKeys.map(k => {
      const rows = byMarket('CRYPTO').map(r => r.strategies[k]).filter(Boolean);
      if (!rows.length) return [k, null];
      return [k, { n: rows.reduce((a, r) => a + r.n, 0), winPct: +mean(rows.map(r => r.winPct)).toFixed(1), netExpR: +mean(rows.map(r => r.netExpR)).toFixed(3), medianMin: Math.round(mean(rows.map(r => r.medianMin))), timePct: +mean(rows.map(r => r.timePct)).toFixed(1) }];
    })),
    holdLabAll: (() => {
      const labels = results[0] ? Object.keys(results[0].holdLab) : [];
      return Object.fromEntries(labels.map(l => {
        const rows = results.map(r => r.holdLab[l]).filter(Boolean);
        return [l, { n: rows.reduce((a, r) => a + r.n, 0), winPct: +mean(rows.map(r => r.winPct)).toFixed(1), grossExpR: +mean(rows.map(r => r.grossExpR)).toFixed(3), netExpR: +mean(rows.map(r => r.netExpR)).toFixed(3), tpPct: +mean(rows.map(r => r.tpPct)).toFixed(1), timePct: +mean(rows.map(r => r.timePct)).toFixed(1) }];
      }));
    })(),
    mfe20All: (() => {
      const rows = results.map(r => r.mfe20).filter(Boolean);
      return {
        n: rows.reduce((a, r) => a + r.n, 0),
        medianMfeR: +mean(rows.map(r => r.medianMfeR)).toFixed(2),
        p75MfeR: +mean(rows.map(r => r.p75MfeR)).toFixed(2),
        pctReaching1R: +mean(rows.map(r => r.pctReaching1R)).toFixed(1),
        pctReaching05R: +mean(rows.map(r => r.pctReaching05R)).toFixed(1),
        avgRiskPct: +mean(rows.map(r => r.avgRiskPct)).toFixed(2),
      };
    })(),
    perSymbol: results,
  };

  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(path.join(OUT_DIR, 'mtf-lab-results.json'), JSON.stringify(report, null, 2));

  // ---------- markdown ----------
  const L = [];
  L.push('# MTF Accuracy Lab — measured results (Yahoo data)', '');
  L.push(`Generated: ${report.generatedAt} · window ≈ ${DAYS} days · symbols: ${results.length} · runtime ${report.runtimeSec}s`);
  L.push(`Config: SL = 1.5×ATR(trigger) · target = 2R · entry = next-bar open · same-bar SL+TP → SL · costs: India 0.082% / crypto 0.10% of turnover`, '');
  L.push('## A) Alignment study — 5m breakout trades bucketed by how many TFs agreed', '');
  L.push('| TFs aligned (5m/15m/1h/1d) | trades | win% (2R) | gross exp (R) | NET exp (R) | win% (T1=1R) | gross exp (R) 1R | NET exp (R) 1R | median MFE (R) | TP hit % |');
  L.push('|---|---|---|---|---|---|---|---|---|---|');
  for (const a of report.alignmentAll) L.push(`| ${a.alignedTfs} | ${a.n} | ${a.winPct} | ${a.grossExpR} | ${a.netExpR} | ${a.winPct1R} | ${a.grossExpR1R} | ${a.netExpR1R} | ${a.mfeMedianR} | ${a.tpPct} |`);
  L.push('');
  L.push('## B) Strategy comparison', '');
  L.push('| Strategy | trades | win% | gross exp (R) | NET exp (R) | median hold (min) | time-stop % |');
  L.push('|---|---|---|---|---|---|---|');
  for (const [k, v] of Object.entries(report.strategiesAll)) if (v) L.push(`| ${k} | ${v.n} | ${v.winPct} | ${v.grossExpR} | ${v.netExpR} | ${v.medianMin} | ${v.timePct} |`);
  L.push('');
  L.push('## C) Hold-window lab (15m context + 5m trigger rule)', '');
  L.push('| Exit window | trades | win% | gross exp (R) | NET exp (R) | TP hit % | time-stop % |');
  L.push('|---|---|---|---|---|---|---|');
  for (const [k, v] of Object.entries(report.holdLabAll)) L.push(`| ${k} | ${v.n} | ${v.winPct} | ${v.grossExpR} | ${v.netExpR} | ${v.tpPct} | ${v.timePct} |`);
  L.push('');
  L.push('## D) 20-minute MFE diagnostic (all 5m breakout entries)', '');
  L.push(`trades=${report.mfe20All.n} · median MFE in 20 min = **${report.mfe20All.medianMfeR}R** · p75 = ${report.mfe20All.p75MfeR}R · reached +1R: ${report.mfe20All.pctReaching1R}% · reached +0.5R: ${report.mfe20All.pctReaching05R}% · avg risk size = ${report.mfe20All.avgRiskPct}% of price`);
  writeFileSync(path.join(OUT_DIR, 'mtf-lab-results.md'), L.join('\n'));

  console.log('\n' + L.join('\n'));
  console.log(`\n[lab] wrote ${path.join(OUT_DIR, 'mtf-lab-results.json')} + .md in ${report.runtimeSec}s`);
}

main().catch(e => { console.error('[lab] FATAL', e); process.exit(1); });
