// ============================================================
// src/components/aitrading/aiConfirmText.ts
// ------------------------------------------------------------
// v21.11.0 (decision transparency) — shared text helpers for the
// Jev AI confirmation chips. Pehle har panel apna copy-paste tooltip
// rakhta tha aur provider ka directional read kahin bhi surface nahi
// hota tha (sirf ✓/✗/○). Ab ek hi jagah:
//   • aiDirSummary()  — tooltip ke liye compact per-provider lines
//   • aiDecisionText() — modal/panel rows ke liye one-liner per provider
// v21.14.0: Laya provider removed — sirf jev.
// Legacy payloads (bina aiConfirm.detail ke) ke liye aiDirSummary ''
// return karta hai — purana tooltip text untouched rehta hai.
// ============================================================

/** Fully-loose decision shape — panels apne local (string-valued) types
 *  rakhte hain; helper in fields ko structurally padhta hai. AISignal ka
 *  strict AiProviderDecision (types.ts) bhi isme structurally fit hota
 *  hai (narrow → wide assignability). */
type DecisionLike = {
  v?: string | null;
  picked?: string | null;
  pLong?: number | null;
  pShort?: number | null;
  pWait?: number | null;
  confidence?: number | null;
  latencyMs?: number | null;
  reason?: string | null;
};

type DecisionOrNull = DecisionLike | null | undefined;

type ConfirmLike = {
  detail?: { jev?: DecisionOrNull } | null;
} | null | undefined;

const sideOf = (p?: string | null) => (p === 'enter_short' ? 'SHORT' : p === 'enter_long' ? 'LONG' : null);
const pct = (x?: number | null) => (x != null && Number.isFinite(x) ? `${Math.round(x * 100)}%` : null);

const pOfPicked = (d: DecisionLike) =>
  d.picked === 'enter_short' ? d.pShort : d.picked === 'enter_long' ? d.pLong : null;

/** One provider's decision as a compact human line:
 *  "Jev: ULTA — SHORT chuna (p 68%) · conf 71 · 240ms"
 *  "Jev: LONG ki taraf LEAN (p 29%) par threshold ke neeche"
 *  "Jev: entry nahi li (reason: slow)" */
export function aiDecisionText(name: string, d: DecisionOrNull): string {
  if (!d) return `${name}: decision unavailable`;
  const side = sideOf(d.picked);
  const p = pOfPicked(d);
  const tail = [
    d.confidence != null ? `conf ${d.confidence}` : null,
    d.latencyMs != null ? `${d.latencyMs}ms` : null,
  ].filter(Boolean).join(' · ');
  if (d.v === 'AGREE') {
    return `${name}: ${side ?? 'same side'} APPROVE${pct(p) ? ` (p ${pct(p)})` : ''}${tail ? ` · ${tail}` : ''}`;
  }
  if (d.v === 'DISAGREE') {
    return `${name}: ULTA — ${side ?? 'opposite side'} chuna${pct(p) ? ` (p ${pct(p)})` : ''}${tail ? ` · ${tail}` : ''}`;
  }
  if (side) {
    return `${name}: ${side} ki taraf LEAN${pct(p) ? ` (p ${pct(p)})` : ''} par threshold ke neeche — entry nahi`;
  }
  return `${name}: entry nahi li (reason: ${d.reason || 'wait'})`;
}

/** Tooltip suffix — ek line me provider ka decision (agar detail
 *  available hai). Empty string for legacy payloads. */
export function aiDirSummary(aiConfirm: ConfirmLike): string {
  if (!aiConfirm?.detail) return '';
  const d = aiConfirm.detail?.jev;
  if (!d) return '';
  return `\n${aiDecisionText('Jev', d)}`;
}
