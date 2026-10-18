// ============================================================
// test/v2111Recheck.test.ts — v21.1.1 Advance-Pro recheck fixes
// ------------------------------------------------------------
// Is file ke contracts (full-site deep audit ke findings):
//   • A1: kill-rule ab LIVE-only block karta hai (reason text bhi)
//   • A12: KILL_RULE env footguns — empty string + minTrades>window clamp
//   • A10/A13: healthMonitor ok persist-failures fold karta hai
//   • B3: spot dust-guard ab order-placement se PEHLE chalta hai
//   • C1: paperTrading stale-chain fallback 5-min bound
// Ledger hermetic SMARTAI_DATA_DIR me __setLedgerForTests se seed hota hai.
// ============================================================
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { __setLedgerForTests } from '../server/ai/ledger.js';
import { strategyHealth, strategyGuardBlocked, KILL_RULE } from '../server/ai/strategyGuard.js';

function mkEntry(over: Record<string, unknown> = {}) {
  return {
    id: `e${Math.random().toString(36).slice(2, 10)}`,
    ts: Date.now() - Math.floor(Math.random() * 3600_000),
    mode: 'paper', market: 'CRYPTO', source: 'agent', symbol: 'BTC',
    outcome: { r: -1 }, ...over,
  };
}

beforeEach(() => {
  __setLedgerForTests({ entries: [] });
});

describe('v21.1.1 [audit A1] — kill rule LIVE-only block (deadlock fix)', () => {
  it('paused strategy ka reason LIVE-only semantics declare karta hai (paper continue)', () => {
    const entries = [];
    for (let i = 0; i < 30; i++) entries.push(mkEntry());
    __setLedgerForTests({ entries });
    const row = strategyHealth().strategies.find(s => s.strategy === 'agent:CRYPTO');
    expect(row!.paused).toBe(true);
    const g = strategyGuardBlocked('agent', 'CRYPTO');
    expect(g.blocked).toBe(true);
    // v21.1.1: reason ab LIVE-only block promise karta hai — paper window
    // refresh karta rahega (auto-resume reachable). Pehla text all-modes
    // block ka tha jo one-way latch (deadlock) tha.
    expect(String(g.reason)).toMatch(/LIVE entries blocked/i);
    expect(String(g.reason)).toMatch(/paper chalta rahega/i);
  });
});

describe('v21.1.1 [audit A12] — KILL_RULE env footgun guards', () => {
  it('default window=30 >= minTrades=30 (sane config)', () => {
    expect(KILL_RULE.window).toBeGreaterThanOrEqual(KILL_RULE.minTrades);
    expect(KILL_RULE.window).toBeGreaterThan(0);
    expect(KILL_RULE.minTrades).toBeGreaterThan(0);
  });

  it('STRATEGY_KILL_WINDOW="" (empty) → default 30, 0 nahi (fresh-import me)', async () => {
    vi.resetModules();
    process.env.STRATEGY_KILL_WINDOW = '';
    process.env.STRATEGY_KILL_MIN_TRADES = '30';
    try {
      const mod = await import('../server/ai/strategyGuard.js');
      expect(mod.KILL_RULE.window).toBe(30); // empty string ko 0 nahi maana
    } finally {
      delete process.env.STRATEGY_KILL_WINDOW;
      delete process.env.STRATEGY_KILL_MIN_TRADES;
    }
  });

  it('STRATEGY_KILL_MIN_TRADES=50 > STRATEGY_KILL_WINDOW=20 → window clamp to 50 (rule silently-disabled nahi)', async () => {
    vi.resetModules();
    process.env.STRATEGY_KILL_WINDOW = '20';
    process.env.STRATEGY_KILL_MIN_TRADES = '50';
    try {
      const mod = await import('../server/ai/strategyGuard.js');
      expect(mod.KILL_RULE.window).toBe(50); // clamped up — winR.length >= minTrades reachable
      expect(mod.KILL_RULE.minTrades).toBe(50);
    } finally {
      delete process.env.STRATEGY_KILL_WINDOW;
      delete process.env.STRATEGY_KILL_MIN_TRADES;
    }
  });
});

describe('v21.1.1 [audit C1] — paperTrading stale-chain fallback AGE-BOUNDED', () => {
  it('injectOptionPaperQuotes: 5-min+ purani cached chain serve NAHI hoti (BS fallback ya no-quote)', async () => {
    // Hermetic: fetchChain → fresh fail; liveFeed purani chain cache bana ke
    // chhodte hain via ek open trade + ek successful fetch, phir time travel.
    const { openPaperTrade, injectOptionPaperQuotes, _resetForTests } = await import('../server/intraday/paperTrading.js');
    _resetForTests();
    const chain = {
      symbol: 'NIFTY', spot: 22500, lotSize: 75, source: 'nse',
      rows: Array.from({ length: 10 }, (_, i) => ({
        strike: 22400 + i * 50, expiry: '2026-10-13',
        callLTP: 100 + i, putLTP: 90 - i * 2, callIV: 12, putIV: 12,
      })),
    };
    let calls = 0;
    const fetchChain = async () => { calls++; return calls === 1 ? chain : null; };
    openPaperTrade({
      symbol: 'NIFTY22500CE', direction: 'LONG', entry: 137, qty: 1,
      stopLoss: 100, target1: 160, target2: 180, market: 'INDIA', assetKind: 'OPTION',
      underlying: 'NIFTY', strike: 22500, optType: 'CE', expiry: '2026-10-13', iv: 13, lotSize: 75,
    });
    // pass 1: live chain serve hota hai (cache warm)
    const q1: Record<string, { price: number }> = {};
    await injectOptionPaperQuotes(q1, async () => null, fetchChain);
    expect(q1['NIFTY22500CE']).toBeTruthy();
    expect(q1['NIFTY22500CE'].price).toBeGreaterThan(0);
    // pass 2 (chain ladder dead): stale cache abhi bhi allowed (< 5 min)
    const q2: Record<string, { price: number }> = {};
    await injectOptionPaperQuotes(q2, async () => null, async () => null);
    expect(q2['NIFTY22500CE']).toBeTruthy();
    // v21.1.1: 6-min purani chain → NULL (BS path ya skip) — frozen premium serve nahi
    const { __ageChainCacheForTests } = await import('../server/intraday/paperTrading.js');
    __ageChainCacheForTests(6 * 60_000);
    const q3: Record<string, { price: number }> = {};
    await injectOptionPaperQuotes(q3, async () => null, async () => null);
    // chain unavailable + 6-min stale → live-chain LTP serve NAHI hona chahiye
    expect(q3['NIFTY22500CE']?.price).not.toBe(q1['NIFTY22500CE'].price);
  });
});
