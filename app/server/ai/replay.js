// ============================================================
// server/ai/replay.js — v20.2 INTRADAY GATE REPLAY HARNESS
// ------------------------------------------------------------
// THE GAP: BacktestLab replays the ensemble on DAILY bars; the
// intraday gates that actually shape every board signal — the MTF
// confluence ladder, the chase guard, the OB/OS suppression, the
// confidence grade ladder — had NO replay. Tuning them was blind.
//
// THIS: a deterministic, bar-by-bar replay of the QUANT GATE STACK
// on historical 5m bars (Yahoo INDIA chain, the same one MTF-6 and
// the charts use):
//   1. per-bar indicator state on 5m + resampled 15m + 1h
//   2. 3-TF weighted consensus (1h ×1.8 · 15m ×1.3 · 5m ×1.0 — the
//      MTF-6 weights for the TFs reconstructible from 5m data)
//   3. THE SAME GATES the board applies, in order:
//        OB/OS suppression (RSI ≥70 / ≤30)
//        chase guard (≥2.5×ATR from EMA20 → HARD cap)
//        MTF alignment ladder (+3 aligned / −7 counter)
//        confidence ladder (STRONG 75 + agreement 0.70 · ACTION 55)
//   4. ATR plan (1.4×ATR stop · 1R/2R targets) filled at bar close
//   5. THE PUBLISHED EXIT DISCIPLINE (T1 50% book → BE trail →
//      T2 / SL / BE / EOD 15:25) — the same rules trackRecord uses
//
// HONEST LIMITS (surfaced in the response, never hidden):
//   • quant-proxy consensus — the LLM council is NOT replayed
//   • fills at bar close, no intrabar path order (a bar that touches
//     both SL and T1 resolves CONSERVATIVELY: SL first)
//   • max one open position, 5-bar cooldown after a close
// ============================================================
import { computeIndicatorsFromCandles } from './lib/indicators.js';
import { rawTfCandles } from './mtf.js';

const WARM_5M = 120;          // bars before the first replayable bar
const TF_WEIGHT = { '5m': 1.0, '15m': 1.3, '1h': 1.8 };
const CHASE_HARD_ATR = 2.5;
const CHASE_SOFT_ATR = 1.8;
const OB_LEVEL = 70;
const OS_LEVEL = 30;
const EOD_MIN_IST = 15 * 60 + 25;   // 15:25 — same as trackRecord
const COOLDOWN_BARS = 5;
const MIN_TRADES = 8;         // below this the report says LOW SAMPLE

const IST_OFFSET_MIN = 330;
const istMinutesOf = (ts) => {
  const d = new Date(ts + IST_OFFSET_MIN * 60000);
  return d.getUTCHours() * 60 + d.getUTCMinutes();
};
const istDayKeyOf = (ts) => {
  const d = new Date(ts + IST_OFFSET_MIN * 60000);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
};
const inNseSession = (ts) => {
  const m = istMinutesOf(ts);
  return m >= 555 && m <= 930; // 09:15–15:30
};

/** Bucket 5m candles up (15m / 1h). */
function _resample(candles, minutes) {
  const widthMs = minutes * 60_000;
  const out = [];
  let b = null;
  for (const c of candles) {
    const bt = Math.floor(Number(c.time) / widthMs) * widthMs;
    if (!b || b.time !== bt) {
      if (b) out.push(b);
      b = { time: bt, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume || 0 };
    } else {
      b.high = Math.max(b.high, c.high);
      b.low = Math.min(b.low, c.low);
      b.close = c.close;
      b.volume += c.volume || 0;
    }
  }
  if (b) out.push(b);
  return out;
}

// v20.3: moved to module scope (pure) so the lookahead semantics are
// directly unit-testable — the regression lock lives in v203DeepAudit.
function _bucketsCompleted(series, ts, widthMs) {
  // number of resampled bars whose bucket CLOSED at/before the decision
  // moment — the close of the current 5m bar (ts + 5m).
  // v20.3 LOOKAHEAD FIX: the old check `series[i].time <= ts` tested the
  // bucket START, so the still-FORMING 15m/1h bucket was included — its
  // close/high/low were resampled from 5m bars that are IN THE FUTURE at
  // the decision moment (up to 55 min of future price on the 1h TF,
  // weight 1.8). Every replay stat was systematically optimistic.
  const decisionMs = ts + 5 * 60_000;
  let n = 0;
  for (let i = series.length - 1; i >= 0; i--) {
    if (series[i].time + widthMs <= decisionMs) { n = i + 1; break; }
  }
  return n;
}
function _tfIndAt(series, ts, warm, widthMs) {
  const n = _bucketsCompleted(series, ts, widthMs);
  if (n < warm) return null;
  const win = series.slice(Math.max(0, n - 100), n);
  return win.length >= 30 ? computeIndicatorsFromCandles(win) : null;
}

// test hooks — the bucket semantics are the replay's honesty contract.
export const __replayInternalsForTests = { _bucketsCompleted, _tfIndAt, _resample };

/** Per-TF direction score — the SAME signal family _tfVote weighs
 *  (EMA stack · RSI · MACD-hist · supertrend), scaled to [-4, 4]. */
function _tfScore(ind) {
  if (!ind) return null;
  let s = 0;
  const close = ind.ltp;
  if (ind.ema20 != null && ind.ema50 != null) s += ind.ema20 > ind.ema50 ? 1.2 : -1.2;
  if (ind.ema20 != null) s += close > ind.ema20 ? 0.8 : -0.8;
  if (ind.rsi != null) s += ind.rsi > 55 ? 0.8 : ind.rsi < 45 ? -0.8 : 0;
  const mac = ind.macd && typeof ind.macd === 'object' ? ind.macd : null;
  if (mac && mac.hist != null) s += mac.hist > 0 ? 1.0 : -1.0;
  if (ind.supertrend && Number.isFinite(ind.supertrend.direction)) s += ind.supertrend.direction * 0.9;
  return Math.max(-4, Math.min(4, s));
}

export async function replayIntradayGates(symbol, opts = {}) {
  const sym = String(symbol || '').toUpperCase().trim();
  if (!sym || sym.length > 16) return { ok: false, error: 'bad symbol' };
  const mkt = String(opts.market || 'INDIA').toUpperCase();
  if (mkt !== 'INDIA') return { ok: false, error: 'replay harness currently serves the INDIA desk (5m Yahoo chain)' };

  const c5 = await rawTfCandles(sym, 'INDIA', '5m');
  if (!Array.isArray(c5) || c5.length < WARM_5M + 40) {
    return { ok: false, error: 'insufficient 5m history (source down or thin symbol)' };
  }
  const c15 = _resample(c5, 15);
  const c60 = _resample(c5, 60);

  // gate counters
  const gates = { bars: 0, obos: 0, chaseHard: 0, chaseSoft: 0, mtfCounter: 0, mtfAligned: 0, belowAction: 0, entries: 0, cooled: 0 };

  const trades = [];
  let open = null;          // { side, entry, sl, t1, t2, entryIdx, entryDay, t1Hit }
  let cooldown = 0;
  const ind5Cache = new Map(); // idx → indicator snapshot (lazy)

  const indAt = (idx) => {
    if (ind5Cache.has(idx)) return ind5Cache.get(idx);
    const win = c5.slice(Math.max(0, idx - WARM_5M), idx + 1);
    const v = win.length >= 30 ? computeIndicatorsFromCandles(win) : null;
    ind5Cache.set(idx, v);
    // keep the cache bounded — only trailing indices matter
    if (ind5Cache.size > 400) {
      const cut = ind5Cache.keys().next().value;
      ind5Cache.delete(cut);
    }
    return v;
  };

  const closeTrade = (exitPrice, reason, bar) => {
    // same P&L model as trackRecord: T1 booked at 50%, remainder at exit
    const long = open.side === 'LONG';
    const sign = long ? 1 : -1;
    let pnlR;
    if (open.t1Hit) {
      pnlR = 0.5 * ((open.t1 - open.entry) * sign / open.risk) + 0.5 * ((exitPrice - open.entry) * sign / open.risk);
    } else {
      pnlR = ((exitPrice - open.entry) * sign) / open.risk;
    }
    trades.push({
      side: open.side, day: open.entryDay, entryIdx: open.entryIdx,
      entry: open.entry, exit: +(+exitPrice).toFixed(2),
      reason, r: +pnlR.toFixed(3), t1Hit: open.t1Hit,
      barsHeld: bar - open.entryIdx,
    });
    open = null;
    cooldown = COOLDOWN_BARS;
  };

  for (let i = WARM_5M; i < c5.length; i++) {
    const bar = c5[i];
    if (!inNseSession(bar.time)) continue;
    gates.bars++;

    // ---- open trade management FIRST (exits rule the day) ----
    if (open) {
      const long = open.side === 'LONG';
      const hitSL = long ? bar.low <= open.sl : bar.high >= open.sl;
      const hitT1 = !open.t1Hit && (long ? bar.high >= open.t1 : bar.low <= open.t1);
      const hitT2 = long ? bar.high >= open.t2 : bar.low <= open.t2;
      // conservative intrabar order: SL before T1, T2 first on the runner
      if (open.t1Hit) {
        if (hitT2) { closeTrade(open.t2, 'T2', i); continue; }
        const hitBE = long ? bar.low <= open.entry : bar.high >= open.entry;
        if (hitBE) { closeTrade(open.entry, 'BE_TRAIL', i); continue; }
      } else if (hitSL) {
        closeTrade(open.sl, 'SL', i); continue;
      } else if (hitT2) {
        open.t1Hit = true; closeTrade(open.t2, 'T2', i); continue;
      } else if (hitT1) {
        open.t1Hit = true; // book 50%, trail to breakeven
      }
      const eod = istMinutesOf(bar.time) >= EOD_MIN_IST;
      const dayRolled = istDayKeyOf(bar.time) !== open.entryDay;
      if (eod || dayRolled) { closeTrade(bar.close, 'EOD', i); continue; }
      continue;
    }
    if (cooldown > 0) { cooldown--; gates.cooled++; continue; }

    // ---- gate stack on a fresh bar ----
    const i5 = indAt(i);
    if (!i5) continue;
    const i15 = _tfIndAt(c15, bar.time, 80, 15 * 60_000);
    const i60 = _tfIndAt(c60, bar.time, 60, 60 * 60_000);

    const s5 = _tfScore(i5);
    const s15 = i15 ? _tfScore(i15) : null;
    const s60 = i60 ? _tfScore(i60) : null;
    const parts = [['5m', s5], ['15m', s15], ['1h', s60]].filter(([, v]) => v != null);
    if (parts.length < 2) continue;
    const wsum = parts.reduce((a, [tf, v]) => a + v * TF_WEIGHT[tf], 0);
    const wtot = parts.reduce((a, [tf]) => a + TF_WEIGHT[tf], 0);
    if (!(wtot > 0)) continue;
    const score = wsum / wtot;                       // -4..4
    const domW = Math.abs(wsum) / wtot;              // agreement share 0..4
    const agreement = Math.min(1, domW / 2.6);       // normalize: 2.6+ = full agreement
    const side = score >= 0.45 ? 'LONG' : score <= -0.45 ? 'SHORT' : null;
    if (!side) { gates.belowAction++; continue; }

    // conf ladder proxy (the MTF ladder: aligned +3 / counter −7)
    let conf = 50 + Math.min(45, Math.abs(score) * 11);
    const aligned = parts.filter(([_tf, v]) => (side === 'LONG' ? v > 0 : v < 0)).length;
    if (aligned === parts.length) { conf += 3; gates.mtfAligned++; }
    else if (aligned === 0) { conf -= 7; gates.mtfCounter++; }
    conf = Math.max(20, Math.min(95, conf));

    // OB/OS trust guard (5m RSI)
    const rsi5 = i5.rsi;
    if (side === 'LONG' && rsi5 != null && rsi5 >= OB_LEVEL) { gates.obos++; continue; }
    if (side === 'SHORT' && rsi5 != null && rsi5 <= OS_LEVEL) { gates.obos++; continue; }

    // chase guard (ATR-distance from EMA20 on the 5m)
    const atr = i5.atr ?? null;
    const ema20 = i5.ema20 ?? null;
    let chase = null;
    if (atr > 0 && ema20 != null) {
      const dist = Math.abs(bar.close - ema20) / atr;
      if (dist >= CHASE_HARD_ATR) { chase = 'HARD'; gates.chaseHard++; }
      else if (dist >= CHASE_SOFT_ATR) { chase = 'SOFT'; gates.chaseSoft++; }
    }
    if (chase === 'HARD') { conf = Math.min(conf, 48); }  // the documented cap

    // grade ladder
    const grade = conf >= 75 && agreement >= 0.70 ? 'STRONG' : conf >= 55 ? 'ACTION' : 'WATCH';
    if (grade === 'WATCH') { gates.belowAction++; continue; }

    // ---- ATR plan, filled at bar close ----
    const a = atr > 0 ? atr : bar.close * 0.004;
    const long = side === 'LONG';
    const sl = long ? bar.close - 1.4 * a : bar.close + 1.4 * a;
    const risk = Math.abs(bar.close - sl);
    if (!(risk > 0)) continue;
    open = {
      side, entry: bar.close, sl: +sl.toFixed(2),
      t1: +(long ? bar.close + risk : bar.close - risk).toFixed(2),
      t2: +(long ? bar.close + 2 * risk : bar.close - 2 * risk).toFixed(2),
      risk: +risk.toFixed(2), r: risk,
      entryIdx: i, entryDay: istDayKeyOf(bar.time), t1Hit: false,
    };
    gates.entries++;
  }
  if (open) closeTrade(c5[Math.min(c5.length - 1, open.entryIdx + 200)].close || open.entry, 'EOD', c5.length - 1);

  // ---- stats ----
  const n = trades.length;
  const wins = trades.filter(t => t.r > 0).length;
  const losses = trades.filter(t => t.r < 0).length;
  const rSum = trades.reduce((a, t) => a + t.r, 0);
  let peak = 0, cum = 0, maxDD = 0;
  for (const t of trades) {
    cum += t.r;
    peak = Math.max(peak, cum);
    maxDD = Math.max(maxDD, peak - cum);
  }
  const grossW = trades.filter(t => t.r > 0).reduce((a, t) => a + t.r, 0);
  const grossL = Math.abs(trades.filter(t => t.r < 0).reduce((a, t) => a + t.r, 0));
  const byReason = {};
  for (const t of trades) byReason[t.reason] = (byReason[t.reason] || 0) + 1;

  return {
    ok: true, symbol: sym, market: mkt,
    bars: c5.length, sessionBars: gates.bars,
    window: { from: istDayKeyOf(c5[WARM_5M].time), to: istDayKeyOf(c5[c5.length - 1].time) },
    trades: n, wins, losses,
    winRate: wins + losses > 0 ? +((wins / (wins + losses)) * 100).toFixed(1) : null,
    avgR: n > 0 ? +(rSum / n).toFixed(3) : null,
    expectancyR: n > 0 ? +(rSum / n).toFixed(3) : null,
    profitFactor: grossL > 0 ? +(grossW / grossL).toFixed(2) : (grossW > 0 ? null : 0),
    maxDD_R: +maxDD.toFixed(2),
    totalR: +rSum.toFixed(2),
    byReason,
    gates,
    sampleNote: n < MIN_TRADES ? `LOW SAMPLE — ${n} trades in the window (min ${MIN_TRADES} for a meaningful read)` : 'sample OK',
    honest: 'Quant-proxy replay: 5m/15m/1h TF votes + OB/OS + chase + MTF ladder + conf ladder + ATR plan + T1-50%/BE-trail discipline. LLM council NOT replayed; fills at bar close; intrabar SL-before-T1 (conservative).',
  };
}
