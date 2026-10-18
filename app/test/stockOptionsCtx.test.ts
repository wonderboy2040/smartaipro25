// ============================================================
// test/stockOptionsCtx.test.ts — ACCURACY-PLAN PHASE 2.2
// ------------------------------------------------------------
// LOCKED HERE (the plan's "OptionsFlow ko per-stock granularity dena"):
//   • buildIndiaStockCtx attaches the CACHED per-stock option ctx
//     (PCR/max-pain/IV/OI-skew) when the store holds a fresh (≤10m)
//     REAL (nse/bse) chain for the symbol — OptionsFlow then votes
//     on the stock exactly like it does on NIFTY/BANKNIFTY
//   • no cached ctx / stale store → options stays null → the seat's
//     honest structural abstain (byte-identical legacy behavior)
//   • the store's snapshot honors the 10-min TTL
//   • the top-N knob bounds the warm slice (default 6, 0-10 clamp)
// Feasibility note (in-code too): Massive/Polygon + AlphaVantage serve
// US options only — the per-stock source is the repo's OWN
// getOptionsDesk(sym) real-chain machinery (same as the options scanner).
// Hermetic — no network.
// ============================================================
import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const hooks = await import('../server/ai/signals.js').then(m => m.__stockOptionsForTests());
const SIGNALS_SRC = readFileSync(resolve(process.cwd(), 'server/ai/signals.js'), 'utf8');

beforeEach(() => {
  hooks.clear();
});

describe('per-stock option ctx store (Phase 2.2)', () => {
  it('snapshot returns a fresh injected ctx; TTL expiry nulls it', () => {
    hooks.setCtx('RELIANCE', { pcr: 1.6, maxPain: 1290, ivPercentile: 42, oiSkew: 0.2 });
    expect(hooks.snapshot('RELIANCE')).toBeTruthy();
    expect(hooks.snapshot('RELIANCE').pcr).toBe(1.6);
    expect(hooks.snapshot('TCS')).toBeNull(); // absent name — honest null
    // age the store past the 10-min TTL → snapshot goes null
    hooks.store.at = Date.now() - (10 * 60_000 + 1);
    expect(hooks.snapshot('RELIANCE')).toBeNull();
  });

  it('the top-N knob is clamped 0-10 with default 6', () => {
    expect(hooks.topN).toBeGreaterThanOrEqual(0);
    expect(hooks.topN).toBeLessThanOrEqual(10);
    expect(hooks.topN).toBe(6); // default (env unset in this worker)
  });

  it('the board ctx builder reads the snapshot (wire lock, source-level)', () => {
    const src = SIGNALS_SRC;
    // buildIndiaStockCtx attaches the per-stock snapshot — never a fetch
    expect(src).toContain('options: _stockOptionsSnapshot(row.symbol)');
    // the warm is bounded to the top slice and fire-and-forget
    expect(src).toContain('_refreshStockOptionsCtx((tiered?.scan || INDIA_UNIVERSE)).catch(() => {})');
    // model chains never vote — the REAL_CHAIN_RE gate guards the store
    expect(src.match(/REAL_CHAIN_RE\.test\(src\)/g)?.length).toBeGreaterThanOrEqual(2);
    // the deep path attaches the cached stock ctx without fetching
    expect(src).toContain('const stkOpt = _stockOptionsSnapshot(ctx.symbol)');
  });
});
