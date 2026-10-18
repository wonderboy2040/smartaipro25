// ============================================================
// intraday/adaptAISignal — new Signal Board → old Paper Desk bridge
// ------------------------------------------------------------
// v9.1: the India desk's SUPERINTELLIGENCE board (server/ai engine,
// AISignal shape) can now open positions in the Paper Desk simulator
// (server/intraday engine, IntradaySignal shape). This adapter maps
// one to the other HONESTLY:
//
//   • side  LONG/SHORT pass through; FLAT has no tradeable levels → null
//   • plan levels (entry/SL/T1/T2) pass through — the server
//     re-validates direction-consistent ordering anyway; we
//     pre-reject broken plans so the user gets feedback BEFORE a
//     wasted round-trip
//   • indicator fields the paper backend never reads (rsi/vwap/…)
//     get neutral values — they only matter for display components
//     we don't route through here
// ============================================================
import type { AISignal } from '../aitrading/types';
import type { IntradaySignal } from './types';

/** Levels must be direction-consistent — mirrors the server's
 *  openPaperTrade() sanity check (LONG: SL < E < T1 < T2, SHORT inverted). */
function levelsSane(direction: 'LONG' | 'SHORT', entry: number, sl: number, t1: number, t2: number): boolean {
  if (direction === 'LONG') {
    if (sl >= entry) return false;
    if (t1 > 0 && t1 <= entry) return false;
    if (t2 > 0 && t2 <= entry) return false;
    return true;
  }
  if (sl <= entry) return false;
  if (t1 > 0 && t1 >= entry) return false;
  if (t2 > 0 && t2 >= entry) return false;
  return true;
}

export function adaptAISignal(s: AISignal): IntradaySignal | null {
  // FLAT consensus or a planless signal has nothing to simulate.
  if (!s.plan || s.side === 'FLAT') return null;
  const direction: 'LONG' | 'SHORT' = s.side === 'SHORT' ? 'SHORT' : 'LONG';
  const p = s.plan;
  const entry = p.entry, sl = p.stopLoss, t1 = p.target1, t2 = p.target2;
  if (![entry, sl, t1, t2].every(v => Number.isFinite(v) && v > 0)) return null;
  if (!levelsSane(direction, entry, sl, t1, t2)) return null;

  const ltp = s.ltp ?? entry;
  return {
    symbol: s.symbol,
    ltp,
    changePct: s.changePct ?? 0,
    direction,
    confidence: s.confidence,
    quantConfidence: s.confidence,
    aiConfidence: s.confidence,
    aiModel: 'AI Council',
    aiNote: s.summary,
    market: 'INDIA',
    entry,
    stopLoss: sl,
    target1: t1,
    target2: t2,
    // Honest mirrors of the plan's own numbers (display-only here).
    rr: p.rewardRisk,
    atr: p.atrUsed,
    vwap: ltp,          // approximation — paper backend never reads it
    rsi: 50,            // neutral — paper backend never reads it
    volumeRatio: 1,     // neutral — paper backend never reads it
    reasons: [s.summary].filter(Boolean),
  };
}
