// ============================================================
// server/ai/mtfRegime.js — v21.30.0 [S5 REGIME CLASSIFIER]
// ------------------------------------------------------------
// Pure, deterministic market-regime read from the fields the MTF board
// already has (ADX, ATR%, direction, exhaustion). No exchange calls.
//
// Regimes:
//   TREND_UP / TREND_DOWN — directional ADX >= 18 with a clear dir
//   CHOP                  — ADX < 15 (directionless grind)
//   HIGH_VOL              — ATR% >= 2.5 (or >= 2.0 in a weak trend)
//   SQUEEZE               — explicit squeeze flag, or compressed ADX/ATR
//   TRANSITION            — ADX 15-18 or strong ADX with no direction
//   UNKNOWN               — no usable evidence (fail-open)
//
// The R5 filter keeps `shadow` as its default; this module only LABELS.
// ============================================================

function num(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export const REGIMES = Object.freeze([
  'TREND_UP', 'TREND_DOWN', 'CHOP', 'HIGH_VOL', 'SQUEEZE', 'TRANSITION', 'UNKNOWN',
]);

export function classifyMarketRegime({
  dir = null, adx = null, atrPct = null, squeeze = false,
  bbWidthPct = null, rsi = null, barsInTrend = null,
} = {}) {
  const d = num(dir);
  const a = num(adx);
  const atr = num(atrPct);
  const bb = num(bbWidthPct);
  const rsiN = num(rsi);
  const bars = num(barsInTrend);

  // Volatility expansion dominates: a stop placed inside a 3% ATR bar is
  // noise, regardless of trend strength.
  if (atr != null && atr >= 2.5) return 'HIGH_VOL';
  if (bb != null && bb >= 8) return 'HIGH_VOL';
  if (atr != null && atr >= 2.0 && (a == null || a < 20)) return 'HIGH_VOL';

  // Compression: explicit flag wins; otherwise tight ADX + tight ATR.
  if (squeeze === true) return 'SQUEEZE';
  if (a != null && a < 12 && atr != null && atr <= 0.8) return 'SQUEEZE';
  if (bb != null && bb <= 1.5 && a != null && a < 18) return 'SQUEEZE';

  if (a != null) {
    if (a < 15) return 'CHOP';
    if (a < 18) return 'TRANSITION';
    // Strong directional trend. A missing dir is TRANSITION, never a guess.
    if (d == null || d === 0) return 'TRANSITION';
    return d > 0 ? 'TREND_UP' : 'TREND_DOWN';
  }

  // No ADX: keep the legacy direction read, but only when direction is clear.
  if (d != null && d !== 0) return d > 0 ? 'TREND_UP' : 'TREND_DOWN';

  // Last-resort shape hints (never fabricate a trend from RSI alone).
  if (rsiN != null && (rsiN >= 70 || rsiN <= 30) && bars != null && bars >= 6) {
    return rsiN >= 70 ? 'TREND_UP' : 'TREND_DOWN';
  }
  return 'UNKNOWN';
}

/** Convenience wrapper for a board/auto row. */
export function classifyRowRegime(row = {}) {
  const ctx = row?.context && typeof row.context === 'object' ? row.context : {};
  return classifyMarketRegime({
    dir: ctx.dir ?? row?.trendDir ?? row?.dir,
    adx: ctx.adx ?? row?.adx,
    atrPct: ctx.atrPct ?? row?.atrPct,
    squeeze: row?.squeeze === true || ctx.squeeze === true,
    bbWidthPct: row?.bbWidthPct ?? ctx.bbWidthPct ?? row?.trigger?.bbWidthPct,
    rsi: ctx.rsi ?? row?.rsi,
    barsInTrend: ctx.barsInTrend ?? row?.barsInTrend,
  });
}
