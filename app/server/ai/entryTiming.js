// ============================================================
// server/ai/entryTiming.js — v12.5 DIRECTION-TIMING ENGINE
// ------------------------------------------------------------
// THE LIVE COMPLAINT (2026-09-21): "long bola tho short jaa raha
// hai, short bola tho long" — the ensemble CONFIRMS a move that has
// already happened (14 candles of run-up → every lagging seat votes
// LONG), the entry lands at local exhaustion, and the mean-reversion
// that follows makes the trade immediately negative. The signals are
// not inverted — they are LATE. Chasing.
//
// The v12.4 OB/OS guard (RSI ≥ 70 / ≤ 30) only catches the RSI
// extreme. A +6% vertical run can print RSI 63 — under the guard,
// still a top-tick entry. This module reads the STRUCTURE:
//
//   • extAtr  — how far price sits from its intraday/1h mean
//               (EMA20, or VWAP on the India intraday desk), in ATR
//               units, SIGNED. +2.5 = price 2.5 ATR ABOVE the mean.
//   • runBars — consecutive closes in one direction at the END of
//               the tape (6 greens in a row = a vertical leg).
//   • runAtr  — how many ATR that run covered in total.
//
// VERDICT (severity, never flips the side — entries are suppressed,
// not redirected: catching a falling knife is the same disease):
//   HARD — extAtr in the signal's direction ≥ 2.5
//          OR (RSI ≥ 64 LONG / ≤ 36 SHORT AND extAtr ≥ 1.9)
//          OR runBars ≥ 6 covering ≥ 3 ATR
//          → grade capped WATCH + confidence capped (entry gate dead)
//   SOFT — extAtr in the signal's direction ≥ 1.8
//          → confidence haircut (the board warns, entries discouraged)
//
// PURE module: no stores, no clocks, no network — same contract as
// the v12.4 trust guards (never throws, never touches side/ltp).
// ============================================================

// thresholds — ATR-normalized so they mean the same thing on a ₹2
// smallcap and a $80k BTC. 2.5×ATR beyond the 20-mean is a stretched
// leg on ANY liquid instrument; 1.8 is "getting long in the tooth".
export const CHASE_EXT_ATR_HARD = 2.5;
export const CHASE_EXT_ATR_SOFT = 1.8;
// RSI assist: not extreme enough for the v12.4 OB/OS guard (64/36 vs
// 70/30) but combined with a stretched leg it is the same top-tick
// entry wearing a smaller RSI number.
const CHASE_RSI_ASSIST_HI = 64;
const CHASE_RSI_ASSIST_LO = 36;
const CHASE_EXT_RSI_ASSIST = 1.9;
// the vertical-leg read: 6 one-way closes covering 3 ATR is a
// news/liquidation spike — entering WITH it at the end is the WLD
// class of loss, entering AGAINST it is knife-catching. Both wait.
export const CHASE_RUN_BARS = 6;
export const CHASE_RUN_ATR = 3.0;
// discipline ladder (mirrors OB_OS_CONF_CAP 50 / extreme 42)
export const CHASE_HARD_CONF_CAP = 48;
export const CHASE_SOFT_CONF_PENALTY = 7;

// v12.6 ENTRY-QUALITY BANDS — the POSITIVE side of the timing read.
// The v12.5 chase guard only SUPPRESSES bad entries; these bands also
// REWARD good ones so the board's top cards become pullback-in-trend
// setups instead of the most-extended movers (the 29%-win-rate
// ranking disease: the highest aiScore sat on coins +2-13% into their
// move because late trend confirmation reads as maximum conviction).
//   PULLBACK  — extSigned ∈ [−0.6, +0.8]: price at/near its mean inside
//               the trend — the classic low-risk entry zone.
//   EXTENDED  — extSigned ∈ (1.5, 1.8): under the SOFT chase line but
//               clearly stretched — light haircut, warning chip.
// Quality never touches the side (same contract as the chase guard).
export const QUALITY_PULLBACK_LO = -0.6;
export const QUALITY_PULLBACK_HI = 0.8;
export const QUALITY_EXTENDED_LO = 1.5;
export const QUALITY_PULLBACK_CONF_BOOST = 4;   // capped at 100 by the caller
export const QUALITY_EXTENDED_CONF_PENALTY = 4;
export const QUALITY_PULLBACK_SCORE_MUL = 1.10; // board aiScore multiplier
export const QUALITY_EXTENDED_SCORE_MUL = 0.93;
export const QUALITY_HARD_SCORE_MUL = 0.85;     // chase HARD/SOFT cap multiplier

/**
 * Structural entry-timing read for a DIRECTIONAL consensus.
 * @param {object} p { side, ltp, ema20, vwap, atr, rsi, candles, market }
 *   candles: [{close,...}] oldest-first (the board/deep ctx shape);
 *   only the closes are read, any extra fields are ignored.
 * @returns {{side:string, extAtr:number|null, ref:string|null,
 *            runBars:number, runAtr:number|null,
 *            severity:'HARD'|'SOFT'|null, reason:string|null,
 *            quality:'PULLBACK'|'EXTENDED'|null, qualityNote:string|null} | null}
 *   null when the side is not directional or nothing is computable
 *   (missing price/ATR and no candle tail) — guards degrade silent.
 */
export function entryTimingRead(p) {
  try {
    const { side, ltp, ema20, vwap, atr, rsi, candles, market } = p || {};
    const s = String(side || '').toUpperCase();
    if (s !== 'LONG' && s !== 'SHORT') return null;

    const px = Number(ltp);
    const a = Number(atr);
    // intraday desks anchor to the session VWAP (the intraday mean
    // every prop desk fades extremes against); everything else to
    // EMA20 on its trading timeframe.
    const isIndia = String(market || '').toUpperCase() === 'INDIA';
    const vwapNum = Number(vwap);
    const refNum = isIndia && vwapNum > 0 ? vwapNum : Number(ema20);
    const refTag = isIndia && vwapNum > 0 ? 'VWAP' : 'EMA20';

    const out = {
      side: s, extAtr: null, ref: null, runBars: 0, runAtr: null,
      severity: null, reason: null, quality: null, qualityNote: null,
    };

    // ---- extension from the mean, in ATR units ----
    if (Number.isFinite(px) && refNum > 0 && a > 0) {
      out.extAtr = Math.round(((px - refNum) / a) * 100) / 100;
      out.ref = refTag;
    }

    // ---- the one-way candle run at the END of the tape ----
    if (Array.isArray(candles) && candles.length >= 6) {
      const cl = [];
      for (const c of candles) {
        const v = Number(c && c.close);
        if (Number.isFinite(v) && v > 0) cl.push(v);
      }
      if (cl.length >= 6) {
        let run = 0;
        for (let i = cl.length - 1; i > 0; i--) {
          const step = s === 'LONG' ? cl[i] > cl[i - 1] : cl[i] < cl[i - 1];
          if (step) run++;
          else break;
        }
        out.runBars = run;
        const startIdx = cl.length - 1 - run;
        if (run > 0 && startIdx >= 0 && a > 0) {
          out.runAtr = Math.round((Math.abs(cl[cl.length - 1] - cl[startIdx]) / a) * 100) / 100;
        }
      }
    }

    // ---- verdict (positive = stretched IN the signal's direction) ----
    const dirSign = s === 'LONG' ? 1 : -1;
    const extSigned = out.extAtr == null ? null : out.extAtr * dirSign;
    const rsiN = Number(rsi);
    const rsiHot = Number.isFinite(rsiN)
      ? (s === 'LONG' ? rsiN >= CHASE_RSI_ASSIST_HI : rsiN <= CHASE_RSI_ASSIST_LO)
      : false;
    const above = s === 'LONG' ? 'above' : 'below';

    // ---- v12.6 ENTRY-QUALITY BAND (the positive side of the read) ----
    // PULLBACK: at/near the mean in-trend — the entry zone the board
    // should be RANKING to the top (conf boost + score multiplier).
    if (extSigned != null && extSigned >= QUALITY_PULLBACK_LO && extSigned <= QUALITY_PULLBACK_HI) {
      out.quality = 'PULLBACK';
      out.qualityNote = `price ${Math.abs(out.extAtr)}×ATR ${out.extAtr >= 0 ? 'above' : 'below'} ${refTag} — pullback zone, acha entry (trend intact, timing fresh)`;
    } else if (extSigned != null && extSigned > QUALITY_EXTENDED_LO && extSigned < CHASE_EXT_ATR_SOFT) {
      out.quality = 'EXTENDED';
      out.qualityNote = `price ${Math.abs(out.extAtr)}×ATR ${above} ${refTag} — stretched (retrace entry better)`;
    } else {
      out.quality = null;
    }

    if (extSigned != null && extSigned >= CHASE_EXT_ATR_HARD) {
      out.severity = 'HARD';
      out.reason = `price ${Math.abs(out.extAtr)}×ATR ${above} ${refTag} — chase entry (top-tick risk)`;
    } else if (rsiHot && extSigned >= CHASE_EXT_RSI_ASSIST) {
      out.severity = 'HARD';
      out.reason = `RSI ${Math.round(rsiN)} + ${Math.abs(out.extAtr)}×ATR ${above} ${refTag} — stretched leg`;
    } else if (out.runBars >= CHASE_RUN_BARS && (out.runAtr ?? 0) >= CHASE_RUN_ATR) {
      out.severity = 'HARD';
      out.reason = `${out.runBars} one-way candles (${out.runAtr}×ATR run) — vertical leg, wait for it to breathe`;
    } else if (extSigned >= CHASE_EXT_ATR_SOFT) {
      out.severity = 'SOFT';
      out.reason = `${Math.abs(out.extAtr)}×ATR ${above} ${refTag} — extended; retrace entry better`;
    }

    // nothing computable at all (no price/ATR/candle tail) → silent
    // degrade: no stamp, the signal rides as if the guard were off
    if (out.severity == null && out.extAtr == null && out.runBars === 0) return null;
    return out;
  } catch {
    return null; // guards NEVER break the signal
  }
}
