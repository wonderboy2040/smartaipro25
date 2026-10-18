// ============================================================
// src/utils/tickBatcher.ts — v10.17 RENDER-STORM KILLER
// ------------------------------------------------------------
// THE BUG: /api/ai/positions/stream pushes a per-row `tick` event on
// EVERY price change (crypto ~1s cadence across N positions → up to
// N events/sec). useAITrading ran setPositions() PER EVENT — the
// whole tab tree re-rendered 5-15×/sec while positions were open.
// That was the console "lag" (typing felt heavy, charts stuttered).
//
// THE FIX: buffer incoming deltas in a Map (id → delta), flush them
// in ONE state update on a throttled interval (800ms — the same
// cadence useCxLivePrices already proved for price ticks). Mirrors
// that hook's proven pattern:
//   • flush() is a no-op while document.hidden (zero background
//     renders) and fires instantly on visibilitychange
//   • flushNow() for structural events (full snapshots) — a fresh
//     book replaces buffered ticks wholesale
// ============================================================

export interface TickBatcher<T extends { id: string }> {
  /** Buffer one delta. Merges over any unflushed delta for the same id
   *  (only the LATEST price/PnL matters — intermediate ticks are noise;
   *  fields the newer tick omitted are kept — partial deltas are legit). */
  push: (delta: T) => void;
  /** Apply buffered deltas in ONE call. No-op when empty or hidden. */
  flush: () => void;
  /** Flush even when hidden (structural snapshot arrived). Clears the buffer. */
  flushNow: () => void;
  /** True when there are unflushed deltas buffered. */
  pending: () => number;
  /** Stop the interval timer + drop the buffer (effect cleanup). */
  dispose: () => void;
}

export function createTickBatcher<T extends { id: string }>(
  apply: (deltas: T[]) => void,
  opts: { intervalMs?: number; isHidden?: () => boolean } = {},
): TickBatcher<T> {
  const intervalMs = opts.intervalMs ?? 800;
  const isHidden = opts.isHidden ?? (() => (typeof document !== 'undefined' && document.hidden));
  const buffer = new Map<string, T>();
  let timer: ReturnType<typeof setInterval> | null = null;

  const flush = (force = false) => {
    if (buffer.size === 0) return;
    if (!force && isHidden()) return; // background tab → zero renders
    const deltas = [...buffer.values()];
    buffer.clear();
    apply(deltas);
  };

  timer = setInterval(() => flush(false), intervalMs);

  const onVis = () => { if (!isHidden()) flush(true); };
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', onVis);
  }

  return {
    push(delta) {
      if (!delta || typeof delta.id !== 'string') return;
      const prev = buffer.get(delta.id);
      buffer.set(delta.id, prev ? { ...prev, ...delta } : delta);
    },
    flush: () => flush(false),
    flushNow: () => flush(true),
    pending: () => buffer.size,
    dispose() {
      if (timer) { clearInterval(timer); timer = null; }
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', onVis);
      }
      buffer.clear();
    },
  };
}
