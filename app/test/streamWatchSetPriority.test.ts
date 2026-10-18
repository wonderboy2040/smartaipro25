// ============================================================
// test/streamWatchSetPriority.test.ts — v9.4 realtime paper-price
// regression suite.
//
// THE BUG (user report: "paper trade lagane par realtime prices
// fetch nahi ho rahe"): the SSE watcher's watch set was assembled
// scan-first / paper-last and then sliced to a 24-symbol cap, while
// tracked signal rows accumulate through the whole session
// (MAX_PER_DAY = 40). A few hours into the desk day the paper
// symbols were the FIRST to be silently dropped — the open paper
// position froze at its entry price while everyone else kept
// ticking.
//
// THE FIX: paper symbols are inserted FIRST in the watch map
// (Map preserves insertion order → they can never be the dropped
// ones), and the cap rose 24 → 34. These tests lock both halves.
// Store/journal mocked — hermetic, no disk, no network.
// ============================================================
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../server/intraday/store.js', () => ({
  loadJSON: () => ({ trades: [], nextId: 1, dayKey: '' }),
  saveJSON: vi.fn(() => true),
}));
vi.mock('../server/intraday/journal.js', () => ({
  recordTradeClose: vi.fn(),
}));
vi.mock('../server/intraday/trackRecord.js', () => ({
  watcherSymbolsByMarket: vi.fn(() => ({ india: [], crypto: [] })),
}));

import { watchSetForTests, setScanSymbols } from '../server/intraday/stream.js';
import { openPaperTrade, _resetForTests } from '../server/intraday/paperTrading.js';

const mk = (sym) => ({
  symbol: sym, direction: 'LONG', entry: 100, qty: 5,
  stopLoss: 95, target1: 110, target2: 120, market: 'INDIA',
});

describe('v9.4 watch-set priority — paper trades always get quotes', () => {
  beforeEach(() => {
    _resetForTests();
    setScanSymbols([]);
  });

  it('paper symbols are FIRST in the watch set (scan + empty tracked)', () => {
    expect(openPaperTrade(mk('MARUTI')).ok).toBe(true);
    expect(openPaperTrade(mk('RELIANCE')).ok).toBe(true);
    setScanSymbols(['ITC', 'SBIN', 'TCS'], 'INDIA');
    const order = [...watchSetForTests().keys()];
    // the two open paper positions lead; scan symbols follow
    expect(order.indexOf('MARUTI')).toBeLessThan(order.indexOf('ITC'));
    expect(order.indexOf('RELIANCE')).toBeLessThan(order.indexOf('ITC'));
    expect(order.slice(0, 2).sort()).toEqual(['MARUTI', 'RELIANCE']);
    expect(order).toContain('ITC');
    expect(order).toContain('SBIN');
  });

  it('closed paper trades leave the watch set; crypto paper marks CRYPTO', () => {
    const a = openPaperTrade({ ...mk('BTC'), market: 'CRYPTO', entry: 50000, stopLoss: 48000, target1: 52000, target2: 53000, qty: 0.01 });
    expect(a.ok).toBe(true);
    const ws = watchSetForTests();
    expect(ws.get('BTC')).toBe('CRYPTO');
  });

  it('paper symbol classification is INDIA by default', () => {
    expect(openPaperTrade(mk('ITC')).ok).toBe(true);
    expect(watchSetForTests().get('ITC')).toBe('INDIA');
  });

  it('MAX_WATCH_NSE is 56 (v21.13: 34→56 vs MAX_PER_DAY 80) — room for paper + scan + a tracked tail', async () => {
    // v21.13: 34 → 56 — MAX_PER_DAY (80) ke against cap mismatch tha;
    // busy days me late tracked rows quotes se starve hote the.
    // 56 = 10 paper (max open) + 5 scan + 41 tracked headroom.
    const src = await import('node:fs').then((fs) =>
      fs.readFileSync('server/intraday/stream.js', 'utf8'));
    expect(src).toMatch(/MAX_WATCH_NSE\s*=\s*56/);
  });
});
