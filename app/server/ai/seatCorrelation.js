// ============================================================
// server/ai/seatCorrelation.js — v21.0 CORE-SEAT CORRELATION GUARD
// ------------------------------------------------------------
// THE FALSE-DIVERSITY FIX (deep-check finding D1-D4):
//   meshModels.js ka Phase-1C correlation guard sirf 4 optional
//   MESH seats ko discount karta tha — CORE committee ke andar
//   TrendMatrix/IntradayTape (dono EMA-stack), MomentumQuant/
//   IntradayTape (dono RSI/MACD) jaise statistically-redundant
//   pairs kabhi nahi chhede. Ye module WOH guard generalized karta
//   hai: signal-ledger ke settled entries se HAR core-seat pair ka
//   vote-direction Pearson correlation compute hota hai —
//     corr > 0.85 → redundant seat ka weight ×0.5
//     corr > 0.70 → redundant seat ka weight ×0.75
//     overlap < 20 settled entries → koi discount nahi (honest)
//
// DESIGN (meshModels.js wale proven pattern par):
//   • STATIC pairs + primary designation — har known-overlap pair
//     me kaun "primary" hai (apna unique context zyada): trend >
//     tape (ADX/Supertrend context), momentum > tape (Stoch/ROC),
//     smc > structure (SMC = structure authority v21.0 me).
//   • v21.0.6 [audit]: STATIC known-pair set hi evaluate hota hai
//     (CORE_DEDUP_PAIRS) — advertised "pairwise full-matrix" mode
//     kabhi implement nahi hua tha; comment ab code se match karta hai.
//   • PURE functions — test-friendly, no fetches, no clock reads.
//   • Vote-path gate `applyCoreCorrelationDiscounts()` returns a
//     COPY (input votes kabhi mutate nahi hote).
//
// HONESTY: discount sirf tab lagta hai jab DATA bole (>= 20 overlap).
// Ek naye install par ledger khaali hai → koi discount nahi → boards
// byte-identical chalte hain jab tak evidence na jame.
// ============================================================
import { __ledgerRaw } from './ledger.js';

export const CORE_CORR_MIN_N = 20;   // settled entries chahiye discount se pehle
export const CORE_CORR_HARD = 0.85;  // ×0.5
export const CORE_CORR_SOFT = 0.70;  // ×0.75

// Known-overlap pairs (deep-check D1-D4) — [primary, redundant]:
// primary apna unique context rakhta hai, redundant seat discounted.
// (StructurePro ke BOS/CHoCH duplicate legs v21.0 me REMOVE ho chuke
// hain models.js me — ye statistical guard uska safety-net hai agar
// votes phir bhi correlate karein.)
export const CORE_DEDUP_PAIRS = [
  ['trend', 'tape'],
  ['trend', 'tape-mtf'],
  ['momentum', 'tape'],
  ['momentum', 'tape-mtf'],
  ['smc', 'structure'],
  // v21.7.0: MACrossTracker (SMA20/50 cross events) TrendMatrix ke EMA-stack
  // read ke naikfamily hai — trend primary (ADX/Supertrend unique context),
  // macross redundant-side discount (sirf ledger evidence ≥20 overlap par).
  ['trend', 'macross'],
];

// Core quant seats (mesh/shadow seats alag se gate hote hain).
// v21.0.6 [audit]: CORE_SEAT_IDS unused tha (view sirf CORE_DEDUP_PAIRS
// chalata hai) — dead code removed.

function _pearsonDirs(pairs) {
  const n = pairs.length;
  if (n < 2) return null;
  const xs = pairs.map(p => p.a), ys = pairs.map(p => p.b);
  const mx = xs.reduce((s, v) => s + v, 0) / n;
  const my = ys.reduce((s, v) => s + v, 0) / n;
  let num = 0, dx = 0, dy = 0;
  for (let i = 0; i < n; i++) {
    const a = xs[i] - mx, b = ys[i] - my;
    num += a * b; dx += a * a; dy += b * b;
  }
  if (dx <= 0 || dy <= 0) return null;
  return num / Math.sqrt(dx * dy);
}

function _pairsBetween(entries, seatA, seatB) {
  const pairs = [];
  for (const e of entries) {
    const a = e?.votes?.[seatA]?.dir;
    const b = e?.votes?.[seatB]?.dir;
    if (Number.isFinite(a) && a !== 0 && Number.isFinite(b) && b !== 0) {
      pairs.push({ a, b });
    }
  }
  return pairs;
}

/**
 * Full pairwise correlation view over CORE seats from the settled
 * ledger. Returns { pairs: { 'a|b': {corr, n, discount, verdict} },
 * minOverlap, hard, soft, note }.
 */
export function coreSeatCorrelationView({ entries = null } = {}) {
  const ents = Array.isArray(entries) ? entries : (__ledgerRaw()?.entries || []);
  const settled = ents.filter(e => e && e.votes && e.outcome);
  const out = {};

  // Static known-overlap pairs (the evaluated set).
  const seen = new Set();
  for (const [primary, redundant] of CORE_DEDUP_PAIRS) {
    const key = [primary, redundant].sort().join('|');
    if (seen.has(key)) continue;
    seen.add(key);
    const pairs = _pairsBetween(settled, primary, redundant);
    const corr = _pearsonDirs(pairs);
    let discount = 1;
    let verdict = 'independent';
    if (pairs.length < CORE_CORR_MIN_N || corr == null) {
      verdict = 'insufficient-overlap';
    } else if (corr > CORE_CORR_HARD) {
      discount = 0.5; verdict = 'redundant';
    } else if (corr > CORE_CORR_SOFT) {
      discount = 0.75; verdict = 'partially-redundant';
    }
    out[key] = {
      primary, redundant, corr: corr == null ? null : Math.round(corr * 1000) / 1000,
      overlapN: pairs.length, discount, verdict,
    };
  }
  return {
    ok: true,
    minOverlap: CORE_CORR_MIN_N,
    hard: CORE_CORR_HARD,
    soft: CORE_CORR_SOFT,
    settledEntries: settled.length,
    pairs: out,
    note: 'Core false-diversity guard: statically-known overlap pairs (trend↔tape EMA, momentum↔tape RSI/MACD, smc↔structure) ko ledger-settled vote-direction correlation se discount. corr>0.85→×0.5, >0.70→×0.75, <20 overlap→no discount (honest).',
  };
}

/**
 * Vote-path gate: apply correlation discounts to the REDUNDANT seat of
 * each statically-known pair. Returns a COPY — input never mutated.
 * `view` injectable for tests; ledger se auto-compute warna.
 */
export function applyCoreCorrelationDiscounts(votes, { view = null, enabled = true } = {}) {
  if (!enabled || !Array.isArray(votes) || votes.length === 0) return votes;
  const v = view || coreSeatCorrelationView();
  if (!v || !v.pairs) return votes;
  const discountBySeat = {};
  for (const key of Object.keys(v.pairs)) {
    const p = v.pairs[key];
    if (p && Number.isFinite(p.discount) && p.discount > 0 && p.discount < 1) {
      discountBySeat[p.redundant] = Math.min(discountBySeat[p.redundant] ?? 1, p.discount);
    }
  }
  if (Object.keys(discountBySeat).length === 0) return votes;
  return votes.map(vt => {
    if (!vt || !vt.id || !(vt.id in discountBySeat)) return vt;
    const disc = discountBySeat[vt.id];
    return {
      ...vt,
      weight: Math.round((vt.weight || 0) * disc * 1000) / 1000,
      corrDiscount: disc,
      corrDiscounted: true,
    };
  });
}

/** Introspection for /api/ai/status — core seats + guard state. */
export function coreSeatGuardStatus() {
  const v = coreSeatCorrelationView();
  const active = Object.values(v.pairs || {}).filter(p => p.discount < 1);
  return {
    enabled: true,
    settledEntries: v.settledEntries,
    minOverlap: v.minOverlap,
    activeDiscounts: active.map(p => ({
      pair: `${p.primary}↔${p.redundant}`,
      corr: p.corr, overlapN: p.overlapN, discount: p.discount, verdict: p.verdict,
    })),
    note: v.note,
  };
}
