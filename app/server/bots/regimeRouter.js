// ============================================================
// server/bots/regimeRouter.js — v20.9.0 REGIME-AWARE ROUTING (C3)
// ------------------------------------------------------------
// AUDIT (Phase C #3): "ORB sirf trend-regime me, LVL (sweep
// reversal) chop/range me. regime.js already hai; router banao."
// India desk ke liye ek `server/ai/regime.js` nahi hai — macro regime
// feed-depend hota hai. Ye router SELF-CONTAINED per-symbol regime
// use karta hai jo strategy ke hi prepared rows se nikalta hai
// (emaFastSlope vs atr) — koi extra feed nahi, koi look-ahead nahi
// (sirf LAST CLOSED row ka slope).
//
//   TREND   : |emaFastSlope| >= trendK * atr (normalized) — directional
//             move chal raha hai → ORB (breakout) strategies ka ghar
//   CHOP    : slope chhota hai, price apni EMA ke aas paas ghoomta hai
//             → LVL (sweep-reclaim) strategies ka ghar
//
// Routing matrix (vrat-only — jo strategy kis regime me NAHI trade
// karegi wahi enforce hota hai; enable-list nahi):
//   orb*   → CHOP me veto
//   lvl*   → TREND me veto
//   ensemble → no veto (dono source strategies ke candidates hote hain)
//
// Kill switch: BOTS_REGIME_ROUTING=off (knobs.js ke off/false/no
// semantics ke saath consistent).
// PURE functions — tests bina feed mocks ke.
// ============================================================

export function regimeRoutingEnabled(env = process.env) {
  const v = String(env.BOTS_REGIME_ROUTING || '').trim().toLowerCase();
  return !['off', 'false', 'no', '0', 'disabled'].includes(v);
}

/** Trend/chop classification from a prepared row (pure).
 *  trendK: slope-to-ATR ratio threshold (default 0.08 — emaFast ka
 *  3-bar slope ATR ke ~8% se zyada = directional). */
export function classifyRegime(row, { trendK = 0.08 } = {}) {
  const atr = Number(row?.atr);
  const slope = Number(row?.emaFastSlope);
  const px = Number(row?.emaFast ?? row?.bar?.close);
  if (!Number.isFinite(atr) || !(atr > 0) || !Number.isFinite(slope) || !Number.isFinite(px) || px <= 0) {
    return { regime: 'UNKNOWN', reason: 'insufficient_features' };
  }
  // Normalized slope: 3-bar EMA move as a fraction of ATR (price-scale free).
  // v20.9.4 FIX (H3 — triple-counted slope): emaFastSlope (features.js
  // emaSlopeAt(emas, i, 3)) PEHLE SE hi 3-bar EMA move hai (emas[i] −
  // emas[i−3]). Purana `Math.abs(slope * 3)` use 3× double-count karta
  // tha → documented trendK=0.08 (8% of ATR) effectively 2.67% pe
  // trigger hota tha — routing 3× zyada sensitive, lvl TREND-veto
  // flat markets tak me lagata tha. Ab pure 3-bar slope vs ATR.
  const norm = Math.abs(slope) / atr;
  return {
    regime: norm >= trendK ? 'TREND' : 'CHOP',
    normalizedSlope: Math.round(norm * 1000) / 1000,
    direction: slope > 0 ? 'UP' : 'DOWN',
  };
}

/** Strategy family from bot id (orb_in, orb_crypto_*, lvl, lvl_in, ensemble). */
export function strategyFamily(botId) {
  const id = String(botId || '').toLowerCase();
  if (id.startsWith('orb')) return 'orb';
  if (id.startsWith('lvl')) return 'lvl';
  if (id.startsWith('ensemble')) return 'ensemble';
  return 'unknown';
}

/**
 * The routing verdict — botRunner pre-decider me pehla cheap check
 * (Jev call se pehle, prepare ke BAAD — rows ka last-closed index pe).
 * PURE. Returns { ok, reason? } — reason STABLE string.
 */
export function regimeRoute({ botId, row, env = process.env }) {
  if (!regimeRoutingEnabled(env)) return { ok: true, routing: 'off' };
  const fam = strategyFamily(botId);
  if (fam === 'unknown' || fam === 'ensemble') return { ok: true, routing: 'unrouted' };
  const cls = classifyRegime(row);
  if (cls.regime === 'UNKNOWN') return { ok: true, routing: 'unknown' }; // guard data se disarm, arm nahi
  if (fam === 'orb' && cls.regime === 'CHOP') {
    return { ok: false, reason: `regime_mismatch(ORB needs TREND, got CHOP slope ${cls.normalizedSlope})` };
  }
  if (fam === 'lvl' && cls.regime === 'TREND') {
    return { ok: false, reason: `regime_mismatch(LVL needs CHOP, got TREND slope ${cls.normalizedSlope} ${cls.direction})` };
  }
  return { ok: true, routing: cls.regime };
}
