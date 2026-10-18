// ============================================================
// server/bots/strategies/contract.js — Jev Bot Lab v20.8.0
// ------------------------------------------------------------
// Plan §6: every strategy implements the SAME interface so the
// engine, the live runner, gates, Jev and the dashboard all speak
// one contract:
//
//   id, desk, instrumentType, lotSize
//   prepare(bars)          -> rows with indicator columns (shared features.js)
//   detect(rows, i, ctx)   -> candidate | null   (called at bar i's CLOSE)
//   snapshot(sym, ts, row) -> { features, contextLines, proposed }
//   gates()                -> [ (row, ctx) -> vetoReason | null ]  (control arm)
//   jevPrompt()            -> { instructions, criteria, extra }
//   sessionKey(bar)        -> session bucket for one-per-day rules
//
// A candidate is { symbol, side, stop, target, entry?, features,
//                  audit: {...expected levels for the auditor} }.
// The strategy PROPOSES; it never executes (plan §2).
// ============================================================

/** Build the plain-English snapshot the decider arms consume. */
export function makeSnapshot({ symbol, ts, proposed, features, contextLines }) {
  return {
    symbol, ts, proposed,
    features: features || {},
    contextLines: contextLines || [],
  };
}

/** Round to 4dp — the audit tolerance contract (1e-3). */
export function r4(v) {
  const x = Number(v);
  return Number.isFinite(x) ? Math.round(x * 1e4) / 1e4 : null;
}

/** Feature guard: EVERY number the gates/Jev see must be finite.
 *  Returns null list of missing keys when all present. */
export function missingFeatures(features, required) {
  const miss = [];
  for (const k of required) {
    const v = features?.[k];
    if (v == null || !Number.isFinite(Number(v))) miss.push(k);
  }
  return miss.length ? miss : null;
}
