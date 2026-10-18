// ============================================================
// src/components/aitrading/liveInvalidation.ts — v18.6.1
// ------------------------------------------------------------
// BETWEEN-CYCLE live-price sanity check (the Staleness & Quorum fix,
// Fix 4): the board rebuilds plans on a ~60s cadence, but the SSE
// liveLtp overlay updates every ~1-2s. This pure helper answers, on
// EVERY tick, "has price already moved against the frozen plan?"
//   LONG  → INVALIDATED if liveLtp <= stopLoss
//   SHORT → INVALIDATED if liveLtp >= stopLoss
//   > 0.5×ATR beyond the FAR (adverse) edge of the entry zone →
//   WEAKENING (the pullback ran past the intended buy/sell zone).
//
// Mirror of server/ai/superIntel.js liveInvalidationCheck (canonical).
// The signal liveLtp fed into SignalCard is ALREADY freshness-gated by
// useCxLivePrices (ticks older than 30s are dropped, same rule as
// manualLiveMerge) — so the two checks never conflict: this only ever
// runs on genuinely-live prices.
//
// Informative only — honest degrade, never fake-block: the trade
// buttons stay clickable, the strip just makes the truth visible.
// ============================================================

export type LiveInvalidationStatus = 'ok' | 'weakening' | 'invalidated';

export interface LiveInvalidationResult {
  status: LiveInvalidationStatus;
  /** empty when status === 'ok' */
  reason: string;
}

export interface LiveInvalidationInput {
  side: string;
  liveLtp: number | null | undefined;
  stopLoss: number | null | undefined;
  /** adverse edge of the pullback entry zone (LONG: zone low, SHORT: zone high).
   *  Pass null/undefined to skip the weakening check (e.g. no blueprint zone). */
  entryZoneLow?: number | null;
  entryZoneHigh?: number | null;
  /** ATR in PRICE units (plan.atrUsed); null → 1.2% of liveLtp fallback. */
  atr?: number | null;
}

export function liveInvalidationCheck({
  side, liveLtp, stopLoss, entryZoneLow = null, entryZoneHigh = null, atr = null,
}: LiveInvalidationInput): LiveInvalidationResult {
  const px = Number(liveLtp);
  const sl = Number(stopLoss);
  // v18.6.4: null/absent/<=0 SL = no SL check (Number(null)===0 used to
  // invalidate EVERY SHORT — px >= 0 is always true).
  if (!(px > 0) || !Number.isFinite(sl) || !(sl > 0)) return { status: 'ok', reason: '' };
  const long = String(side || '').toUpperCase() !== 'SHORT';
  if (long ? px <= sl : px >= sl) {
    return { status: 'invalidated', reason: 'live price already through stop-loss — plan is stale, do not enter' };
  }
  const farEdge = long ? Number(entryZoneLow) : Number(entryZoneHigh);
  const a = Number(atr) > 0 ? Number(atr) : px * 0.012; // 1.2% fallback when ATR unknown
  // v20.7.12 [L-3]: DIRECTIONAL check — pehle Math.abs se FAVOURABLE move bhi
  // WEAKENING flag hota tha (LONG me price entry zone se upar moon kare to bhi
  // amber "moved past entry zone"). Ab sirf ADVERSE direction flag hota hai.
  if (Number.isFinite(farEdge) && farEdge > 0 && (long ? px < farEdge - 0.5 * a : px > farEdge + 0.5 * a)) {
    return { status: 'weakening', reason: 'price has moved well past the planned entry zone (against the plan) — re-check before entry' };
  }
  return { status: 'ok', reason: '' };
}
