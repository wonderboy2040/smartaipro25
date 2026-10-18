// ============================================================
// server/ai/lib/smc.js — ICT / SMART-MONEY CONCEPTS (v6.7 → v20.7.4 v2)
// ------------------------------------------------------------
// The 10th ensemble model. Pure candle-geometry detectors, no
// look-ahead (only candles[0..i]):
//
//   1. LIQUIDITY SWEEP — a wick pierces a prior swing high/low
//      (resting liquidity) but the bar CLOSES back inside. Classic
//      stop-hunt reversal: bearish when a high is swept (sell-side
//      liquidity grabbed above), bullish when a low is swept.
//   2. ORDER BLOCK — the last OPPOSITE candle before an impulsive
//      displacement move. Price retesting a bullish OB from above
//      = institutional support → bullish; mirror for bearish OB.
//   3. FVG (fair value gap) — 3-candle imbalance: candle1.high <
//      candle3.low (bullish FVG below price → magnet/support) or
//      candle1.low > candle3.high (bearish FVG above).
//   4. v20.7.4 MARKET STRUCTURE — swing map (HH/HL/LH/LL) + BOS /
//      CHoCH events (continuation vs reversal tell).
//   5. v20.7.4 EQH/EQL — equal-high/low liquidity pools (magnets).
//   6. v20.7.4 PREMIUM/DISCOUNT — ICT dealing-range position.
//   7. v20.7.4 KILL ZONES — Asia/London/NY session windows (IST).
//
// Each concept contributes a signed score; the vote direction is
// the net, confidence scales with how many concepts stack + how
// fresh the sweep is. Weights live in models.js (SMC entry).
// ============================================================

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/** Find the most recent swing high/low pivot before index i. */
function swingLevel(candles, i, side, lookback = 22, strength = 3) {
  // pivot = a bar whose high/low is the extreme of ±strength bars
  for (let j = Math.min(i - strength - 1, i - 1); j >= Math.max(strength, i - lookback); j--) {
    const c = candles[j];
    let isPivot = true;
    for (let k = j - strength; k <= j + strength; k++) {
      if (k === j || k < 0 || k >= candles.length) continue;
      if (side === 'high' && candles[k].high >= c.high) { isPivot = false; break; }
      if (side === 'low' && candles[k].low <= c.low) { isPivot = false; break; }
    }
    if (isPivot) return { index: j, price: side === 'high' ? c.high : c.low };
  }
  return null;
}

/** LIQUIDITY SWEEP detection on the last `recent` bars. */
export function detectSweep(candles, recent = 3) {
  const n = candles.length;
  if (n < 15) return null;
  for (let i = n - recent; i < n; i++) {
    if (i < 10) continue;
    const c = candles[i];
    const hi = swingLevel(candles, i, 'high');
    const lo = swingLevel(candles, i, 'low');
    // sweep of a swing HIGH: wick above, close back below → bearish
    if (hi && c.high > hi.price && c.close < hi.price) {
      return { type: 'sweep-high', dir: -1, level: hi.price, wick: Math.round((c.high - hi.price) / c.close * 10000) / 100, barAge: n - 1 - i };
    }
    // sweep of a swing LOW: wick below, close back above → bullish
    if (lo && c.low < lo.price && c.close > lo.price) {
      return { type: 'sweep-low', dir: 1, level: lo.price, wick: Math.round((lo.price - c.low) / c.close * 10000) / 100, barAge: n - 1 - i };
    }
  }
  return null;
}

/** ORDER BLOCK: last opposite candle before a displacement move. */
export function detectOrderBlock(candles, dispFactor = 1.6, maxScan = 60) {
  const n = candles.length;
  if (n < 25) return null;
  // displacement = a body ≥ dispFactor × recent avg body, in one direction
  const bodies = candles.slice(-Math.min(n, 40)).map(c => Math.abs(c.close - c.open));
  const avgBody = bodies.reduce((a, b) => a + b, 0) / (bodies.length || 1) || 1e-9;
  for (let i = n - 2; i >= Math.max(1, n - maxScan); i--) {
    const c = candles[i];
    const body = c.close - c.open;
    if (Math.abs(body) < dispFactor * avgBody) continue;
    // find the last OPPOSITE candle just before the displacement
    for (let j = i - 1; j >= Math.max(0, i - 6); j--) {
      const prev = candles[j];
      const prevBody = prev.close - prev.open;
      const opposite = body > 0 ? prevBody < 0 : prevBody > 0;
      if (!opposite) continue;
      const ltp = candles[n - 1].close;
      const ob = {
        type: body > 0 ? 'bullish-ob' : 'bearish-ob',
        dir: body > 0 ? 1 : -1,
        top: Math.max(prev.open, prev.close),
        bottom: Math.min(prev.open, prev.close),
        barAge: n - 1 - j,
      };
      // only meaningful when price is NEAR the OB (retest zone ±0.6%)
      const near = Math.abs(ltp - (ob.top + ob.bottom) / 2) / ltp;
      return { ...ob, nearPct: Math.round(near * 10000) / 100, inRetest: near <= 0.6 };
    }
  }
  return null;
}

/** FVG: 3-candle imbalance near current price. */
export function detectFvg(candles, nearPctMax = 1.2) {
  const n = candles.length;
  if (n < 12) return null;
  const ltp = candles[n - 1].close;
  for (let i = n - 3; i >= Math.max(0, n - 30); i--) {
    const a = candles[i], c = candles[i + 2];
    // bullish FVG: candle1.high < candle3.low (gap below → magnet up)
    if (a.high < c.low) {
      const gapMid = (a.high + c.low) / 2;
      const near = Math.abs(ltp - gapMid) / ltp * 100;
      if (near <= nearPctMax) return { type: 'bullish-fvg', dir: 1, top: c.low, bottom: a.high, barAge: n - 1 - i };
    }
    // bearish FVG: candle1.low > candle3.high (gap above → magnet down)
    if (a.low > c.high) {
      const gapMid = (a.low + c.high) / 2;
      const near = Math.abs(ltp - gapMid) / ltp * 100;
      if (near <= nearPctMax) return { type: 'bearish-fvg', dir: -1, top: a.low, bottom: c.high, barAge: n - 1 - i };
    }
  }
  return null;
}

/**
 * THE SMC VOTE — used by models.js as the 10th ensemble model.
 * Accepts either ctx (signals.js shape: ctx.candles) or plain candles.
 *
 * v20.7.4 UPGRADE (SMC v2 — full ICT stack): sweep + OB + FVG ke
 * upar ab market-structure (BOS/CHoCH), equal-high/low liquidity
 * pools, premium/discount dealing range aur ICT kill-zone session
 * context bhi vote karta hai. Confluence zyada → confidence zyada
 * (bounded 88) — strong LONG/SHORT signals ke liye.
 */
export function smcVote(ctxOrCandles) {
  const candles = Array.isArray(ctxOrCandles) ? ctxOrCandles : ctxOrCandles?.candles;
  if (!Array.isArray(candles) || candles.length < 30) {
    return { dir: 0, conf: 0, reasons: ['SMC: not enough candles'] };
  }
  const ltp = candles[candles.length - 1].close;
  const sweep = detectSweep(candles);
  const ob = detectOrderBlock(candles);
  const fvg = detectFvg(candles);
  // ---- v20.7.4 v2 additions ----
  const structure = swingStructure(candles);
  const pools = equalLevels(candles);
  const pd = premiumDiscount(candles);
  const kz = ictKillZone(candles[candles.length - 1].time);
  const factCount = [sweep, ob, fvg, structure?.event, pools?.eqh != null || pools?.eql != null, pd].filter(Boolean).length;
  if (factCount === 0) {
    return { dir: 0, conf: 0, reasons: ['SMC: no sweep / order-block / FVG / structure confluence in range'] };
  }
  let score = 0;
  let conf = 34;
  const reasons = [];
  if (sweep) {
    // fresh sweeps (age ≤ 1 bar) weigh double
    const w = sweep.barAge <= 1 ? 2 : 1;
    score += sweep.dir * w;
    reasons.push(`${sweep.type === 'sweep-high' ? 'sell-side liquidity swept' : 'buy-side liquidity swept'} @ ${Math.round(sweep.level)} (wick ${sweep.wick}%, ${sweep.barAge} bar${sweep.barAge === 1 ? '' : 's'} ago)${w === 2 ? ' — FRESH' : ''}`);
  }
  // v2: market structure — CHoCH (reversal) 1.5 / BOS (continuation) 1.0,
  // fresh break (≤3 bars) +0.5
  if (structure?.event) {
    const ev = structure.event;
    const w = (ev.type === 'CHoCH' ? 1.5 : 1.0) + (ev.barAge <= 3 ? 0.5 : 0);
    score += ev.dir * w;
    reasons.push(`${ev.type} ${ev.dir > 0 ? 'bullish' : 'bearish'} — structure break @ ${Math.round(ev.level)} (${ev.barAge} bar pehle)`);
  } else if (structure?.trend) {
    score += structure.trend * 0.3; // trend context, koi fresh break nahi
    reasons.push(`structure ${structure.trend > 0 ? 'up (HH/HL)' : 'down (LH/LL)'} — break stale hai`);
  }
  if (ob?.inRetest) {
    score += ob.dir;
    reasons.push(`${ob.type === 'bullish-ob' ? 'price retesting bullish' : 'price retesting bearish'} order block (retest zone ${ob.nearPct}% away)`);
  } else if (ob) {
    // distant OB = weak context signal (quarter weight)
    score += ob.dir * 0.25;
  }
  if (fvg) {
    score += fvg.dir * 0.5;
    reasons.push(`${fvg.type === 'bullish-fvg' ? 'bullish' : 'bearish'} FVG ${Math.round(fvg.bottom)}–${Math.round(fvg.top)} acting as magnet`);
  }
  // v2: EQH/EQL liquidity pools — resting stops = price magnets
  if (pools?.eqh != null && pools.eqh > ltp) {
    score += 0.4;
    reasons.push(`EQH liquidity pool @ ${Math.round(pools.eqh)} (+${pools.eqhDistPct}%) — upside magnet`);
  }
  if (pools?.eql != null && pools.eql < ltp) {
    score -= 0.4;
    reasons.push(`EQL liquidity pool @ ${Math.round(pools.eql)} (${pools.eqlDistPct}%) — downside magnet`);
  }
  // v2: premium/discount dealing range (ICT)
  if (pd) {
    if (pd.zone === 'discount') { score += 0.5; reasons.push(`price in DISCOUNT (${pd.positionPct}% of dealing range) — longs favored`); }
    else if (pd.zone === 'premium') { score -= 0.5; reasons.push(`price in PREMIUM (${pd.positionPct}% of dealing range) — shorts favored`); }
  }
  // v2: ICT kill-zone session — institutional activity window
  if (kz?.inZone) { conf += 6; reasons.push(`${kz.name} kill-zone active — sweep probability high`); }
  if (score === 0) {
    return { dir: 0, conf: 0, reasons: ['SMC: signals cancel out (no net confluence)'] };
  }
  const dir = score > 0 ? 1 : -1;
  // confidence: base 34 + per-fact 12 + fresh sweep 8 + |score|×3, capped 88
  conf += factCount * 12 + (sweep && sweep.barAge <= 1 ? 8 : 0) + Math.min(8, Math.abs(score) * 3);
  return { dir, conf: clamp(conf, 0, 88), reasons };
}

// ============================================================
// v20.7.4 — SMC v2 STRUCTURE MODULE (user-spec ICT upgrades)
// BOS / CHoCH / HH-HL-LH-LL / EQH-EQL / premium-discount / kill zones
// ============================================================

/**
 * MARKET STRUCTURE — fractal swing map with BOS / CHoCH events.
 * Walks candles left→right confirming pivots (strength bars each
 * side), labels them HH/HL/LH/LL, and fires a structural event when
 * a CLOSE breaks the last confirmed swing:
 *   • BOS  (Break of Structure)      — break in the SAME direction as
 *     the running trend → continuation.
 *   • CHoCH (Change of Character)   — break AGAINST the running
 *     trend → the first hard reversal tell.
 * No look-ahead: a pivot at bar i only becomes usable at i+strength.
 */
export function swingStructure(candles, { strength = 3, lookback = 120 } = {}) {
  const n = candles.length;
  if (n < 25) return null;
  const start = Math.max(strength, n - lookback);
  const pivH = [], pivL = [];
  const labels = [];
  let trend = 0;
  let lastEvent = null;
  let lastBrokenH = null, lastBrokenL = null;
  for (let i = start + strength; i < n; i++) {
    // confirm the pivot at p = i - strength (usable from bar i onward)
    const p = i - strength;
    if (p >= start) {
      let isH = true, isL = true;
      for (let k = p - strength; k <= p + strength; k++) {
        if (k === p || k < start || k >= n) continue;
        if (candles[k].high >= candles[p].high) isH = false;
        if (candles[k].low <= candles[p].low) isL = false;
        if (!isH && !isL) break;
      }
      if (isH) {
        const prev = pivH[pivH.length - 1];
        labels.push({ i: p, type: prev ? (candles[p].high > prev.price ? 'HH' : 'LH') : 'H', price: candles[p].high });
        pivH.push({ i: p, price: candles[p].high });
      }
      if (isL) {
        const prev = pivL[pivL.length - 1];
        labels.push({ i: p, type: prev ? (candles[p].low > prev.price ? 'HL' : 'LL') : 'L', price: candles[p].low });
        pivL.push({ i: p, price: candles[p].low });
      }
    }
    const c = candles[i].close;
    const lastH = pivH[pivH.length - 1];
    const lastL = pivL[pivL.length - 1];
    if (lastH && c > lastH.price && lastH !== lastBrokenH && i > lastH.i + 1) {
      lastEvent = { type: trend === -1 ? 'CHoCH' : 'BOS', dir: 1, level: lastH.price, at: i, barAge: n - 1 - i };
      trend = 1;
      lastBrokenH = lastH;
    } else if (lastL && c < lastL.price && lastL !== lastBrokenL && i > lastL.i + 1) {
      lastEvent = { type: trend === 1 ? 'CHoCH' : 'BOS', dir: -1, level: lastL.price, at: i, barAge: n - 1 - i };
      trend = -1;
      lastBrokenL = lastL;
    }
  }
  const lastH = pivH[pivH.length - 1] || null;
  const lastL = pivL[pivL.length - 1] || null;
  return {
    trend,
    event: lastEvent,
    swingHigh: lastH ? lastH.price : null,
    swingLow: lastL ? lastL.price : null,
    labels: labels.slice(-6),
    bias: lastEvent ? lastEvent.dir : trend,
  };
}

/**
 * EQUAL HIGHS / LOWS (EQH / EQL) — resting liquidity pools.
 * Two+ nearby swing extremes = stops cluster there; price gets
 * MAGNETIZED to sweep them (ICT liquidity draw).
 */
export function equalLevels(candles, { tolerancePct = 0.12, lookback = 80 } = {}) {
  const n = candles.length;
  if (n < 25) return null;
  const win = candles.slice(-Math.min(n, lookback));
  const highs = [], lows = [];
  for (let i = 3; i < win.length - 3; i++) {
    let isH = true, isL = true;
    for (let k = i - 3; k <= i + 3; k++) {
      if (k === i) continue;
      if (win[k].high >= win[i].high) isH = false;
      if (win[k].low <= win[i].low) isL = false;
    }
    if (isH) highs.push(win[i].high);
    if (isL) lows.push(win[i].low);
  }
  const eq = (arr) => {
    for (let i = arr.length - 1; i > 0; i--) {
      for (let j = i - 1; j >= Math.max(0, i - 4); j--) {
        const tol = (Math.max(arr[i], arr[j]) * tolerancePct) / 100;
        if (Math.abs(arr[i] - arr[j]) <= tol) return (arr[i] + arr[j]) / 2;
      }
    }
    return null;
  };
  const eqh = eq(highs), eql = eq(lows);
  const ltp = win[win.length - 1].close;
  return {
    eqh, eql,
    eqhDistPct: eqh != null ? Math.round(((eqh - ltp) / ltp) * 10000) / 100 : null,
    eqlDistPct: eql != null ? Math.round(((eql - ltp) / ltp) * 10000) / 100 : null,
  };
}

/**
 * PREMIUM / DISCOUNT — the ICT dealing range read. Price in the
 * upper part of the range = premium (shorts favored, longs chased);
 * lower part = discount (longs favored). Equilibrium = 50%.
 */
export function premiumDiscount(candles, { lookback = 90 } = {}) {
  if (!Array.isArray(candles) || candles.length < 20) return null;
  const win = candles.slice(-Math.min(candles.length, lookback));
  let hi = -Infinity, lo = Infinity;
  for (const c of win) {
    if (c.high > hi) hi = c.high;
    if (c.low < lo) lo = c.low;
  }
  if (!(hi > lo)) return null;
  const ltp = win[win.length - 1].close;
  const pos = (ltp - lo) / (hi - lo);
  return {
    rangeHigh: hi, rangeLow: lo,
    equilibrium: (hi + lo) / 2,
    zone: pos > 0.62 ? 'premium' : (pos < 0.38 ? 'discount' : 'equilibrium'),
    positionPct: Math.round(pos * 10000) / 100,
    bias: pos < 0.38 ? 1 : (pos > 0.62 ? -1 : 0),
  };
}

/**
 * ICT KILL ZONES — the institutional activity windows (IST clock,
 * CoinDCX India desk). Sweeps / displacement land in these windows
 * far more often; a kill-zone flag boosts SMC confidence slightly.
 * Accepts ms (or seconds — auto-detected).
 */
export function ictKillZone(tsMs) {
  const raw = Number(tsMs);
  if (!Number.isFinite(raw) || raw <= 0) return { name: 'unknown', inZone: false };
  const t = raw > 1e12 ? raw : raw * 1000;
  const ist = new Date(t + (330 + new Date(t).getTimezoneOffset()) * 60_000);
  const m = ist.getHours() * 60 + ist.getMinutes();
  const zones = [
    { name: 'Asia (Tokyo)', from: 5 * 60 + 30, to: 11 * 60 + 30 },
    { name: 'London open', from: 12 * 60 + 30, to: 15 * 60 + 30 },
    { name: 'New York AM', from: 17 * 60 + 30, to: 20 * 60 + 30 },
  ];
  for (const z of zones) if (m >= z.from && m < z.to) return { name: z.name, inZone: true };
  return { name: 'off-session', inZone: false };
}
