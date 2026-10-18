// ============================================================
// test/v189ProTraderRecheck.test.ts — v18.9 PRO TRADER RECHECK
// ------------------------------------------------------------
// The full-site deep recheck found real money-path bugs in the crypto
// order desk. These lock every fix:
//   1.  MARGIN PAIR fallback is B-BTC_INR (was malformed B-BTCINR)
//   2.  OFFICIAL-PRICE GATE — synthetic (binance-fx) and deep-stale
//       legs can NEVER trigger a live SL/TP close
//   3.  FEED-DEGRADED ALARM — empty/degraded feed journals + alerts
//       (a dead stop must never look healthy)
//   4.  KILL-SWITCH suspends live auto-closes (documented contract)
//   5.  MARGIN positions never take partial TP legs (opposite-side
//       margin position bug)
//   6.  PARTIAL leg below the exchange minimum → honest disable
//   7.  FEE HONESTY — booked P&L is NET of both-side taker fees
//   8.  AMBIGUITY COOLDOWN — timeout/network close failures defer
//       the re-send 5 min (double-sell protect)
//   9.  SINGLE-FLIGHT — overlapping watcher passes join, not stack
// ============================================================
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// v20.3: paper-fill slippage OFF for this suite — its subject is the
// v18.9 FEE honesty math, not fill realism (the exit-side slip is
// locked in aiOrders.test.ts + v203DeepAudit).
process.env.AI_COINDCX_SLIP_BPS = '0';

const mockPrivate = vi.fn();
vi.mock('../server/mcp/coindcx.js', () => ({
  coindcxPrivate: (...args) => mockPrivate(...args),
  coindcxConnected: () => true,
  coindcxStatus: () => ({ connected: true }),
  loadJSON: undefined, saveJSON: undefined,
}));
vi.mock('../server/ai/dhan.js', () => ({
  dhanConnected: () => false,
  dhanPlaceOrder: vi.fn(),
  dhanCancelOrder: vi.fn(),
  dhanOrderStatus: vi.fn(),
  dhanPositions: vi.fn(),
}));

// ticker feed mock: rows + WHICH LEG served them (officialPriceMap
// reads lastTickerSource() — the production gate input).
let _tickerRows = [{ market: 'BTCINR', last_price: '100' }];
let _tickerSrc = 'coindcx-rest';
const tickers = vi.fn(async () => _tickerRows);
vi.mock('../server/cryptoStream.js', () => ({
  fetchCoinDcxTickers: (...args) => tickers(...args),
  lastTickerSource: () => _tickerSrc,
}));

import {
  watchPositions, loadJournal, __resetForTests, __setJournalForTests,
} from '../server/ai/coindcxOrders.js';
import { loadJSON as loadJSONOrig, saveJSON } from '../server/lib/store.js';

const pos = (over = {}) => ({
  id: 'p1', pair: 'BTCINR', symbol: 'BTC', side: 'LONG', mode: 'paper', market: 'CRYPTO', source: 'manual',
  qty: 10, entryPrice: 100, notionalINR: 1000, sl: 95, tp: 105, tp2: 110,
  initialRisk: 5, peakPrice: 100, openedAt: Date.now() - 60_000, status: 'OPEN',
  ...over,
});

let _origCreds = null;
beforeEach(() => {
  __resetForTests();
  _origCreds = JSON.parse(JSON.stringify(loadJSONOrig('mcp-coindcx.json') || {}));
  saveJSON('mcp-coindcx.json', { apiKey: 'k', secret: 's', connectedAt: Date.now() });
  _tickerRows = [{ market: 'BTCINR', last_price: '100' }];
  _tickerSrc = 'coindcx-rest';
  mockPrivate.mockReset();
  mockPrivate.mockResolvedValue({ orders: [{ id: 'o1' }] });
  // v18.9 test hygiene: mockReset/mockRestore wipe vi.fn(impl) — only
  // CLEAR call counts; the closure implementation survives (trailing.test.ts
  // pattern).
  tickers.mockClear();
});
afterEach(() => {
  saveJSON('mcp-coindcx.json', _origCreds && _origCreds.apiKey != null ? _origCreds : { apiKey: null, secret: null });
  vi.restoreAllMocks();
});

// ---------------- 1. margin pair fallback ----------------
describe('v18.9 #1 — margin pair convention fallback', () => {
  it('a live leveraged SL close sends the exit through B-BTC_INR (not the malformed B-BTCINR)', async () => {
    // active_pairs unreachable → convention fallback must carry the
    // underscore (module contract: margin pairs are "B-BTC_INR").
    mockPrivate.mockImplementation(async (path) => {
      if (String(path).includes('active_pairs')) throw new Error('[503] upstream down');
      return { orders: [{ id: 'x1' }] };
    });
    __setJournalForTests({
      entries: [],
      positions: [pos({ mode: 'live', leverage: 3, side: 'LONG', sl: 101, liquidation: 60 })],
    });
    _tickerRows = [{ market: 'BTCINR', last_price: '100' }]; // 100 <= 101 → SL hit
    await watchPositions({});
    const exitCall = mockPrivate.mock.calls.find(c => String(c[0]).includes('exit_positions'));
    expect(exitCall).toBeDefined();
    const body = exitCall![3];
    expect(body.positions[0].pair).toBe('B-BTC_INR');
  });
});

// ---------------- 2. official-price gate ----------------
describe('v18.9 #2 — synthetic/degraded prices can never fire a live stop', () => {
  it('binance-fx-synth source → NO close, feed-degraded WATCH_ERROR journaled', async () => {
    _tickerSrc = 'binance-fx-synth';
    _tickerRows = [{ market: 'BTCINR', last_price: '80', __synthetic: 'binance-fx' }]; // ~4.6% low
    __setJournalForTests({ entries: [], positions: [pos({ mode: 'live', sl: 95 })] });
    const closures = await watchPositions({});
    expect(closures).toHaveLength(0);
    const j = loadJournal();
    expect(j.positions[0].status).toBe('OPEN'); // NOT stopped out on a synthetic print
    const alarm = j.entries.find(e => e.kind === 'WATCH_ERROR' && e.pair === 'ALL');
    expect(alarm).toBeDefined();
    expect(String(alarm!.reason)).toContain('PRICE FEED degraded');
  });

  it('coindcx-rest-deep-stale source → same gate (3-min-old prints are not tradable)', async () => {
    _tickerSrc = 'coindcx-rest-deep-stale';
    __setJournalForTests({ entries: [], positions: [pos({ mode: 'live', sl: 95 })] });
    await watchPositions({});
    expect(loadJournal().positions[0].status).toBe('OPEN');
  });

  it('a paper position still closes on a healthy official print (gate is not a freeze)', async () => {
    _tickerRows = [{ market: 'BTCINR', last_price: '94' }]; // SL hit
    __setJournalForTests({ entries: [], positions: [pos({})] });
    const closures = await watchPositions({});
    expect(closures).toHaveLength(1);
    expect(loadJournal().positions[0].status).toBe('CLOSED');
  });

  it('synthetic rows are filtered even when the source label says official', async () => {
    // belt-and-braces: source says rest but rows carry __synthetic markers
    _tickerSrc = 'coindcx-rest';
    _tickerRows = [
      { market: 'BTCINR', last_price: '80', __synthetic: 'binance-fx' },
      { market: 'ETHINR', last_price: '200', __synthetic: 'binance-fx' },
    ];
    __setJournalForTests({ entries: [], positions: [pos({ mode: 'live', sl: 95 })] });
    await watchPositions({});
    expect(loadJournal().positions[0].status).toBe('OPEN');
  });
});

// ---------------- 3. feed-degraded alarm ----------------
describe('v18.9 #3 — a dead feed is loud, never silent', () => {
  it('empty ticker book with open positions → throttled WATCH_ERROR + alarm entry', async () => {
    _tickerRows = [];
    __setJournalForTests({ entries: [], positions: [pos({})] });
    const closures = await watchPositions({});
    expect(closures).toHaveLength(0);
    const j = loadJournal();
    const alarm = j.entries.find(e => e.kind === 'WATCH_ERROR' && /PRICE FEED degraded|feed/i.test(String(e.reason || '')));
    expect(alarm).toBeDefined();
  });
});

// ---------------- 4. kill-switch semantics ----------------
describe('v18.9 #4 — kill switch semantics (v21.1.1 revised: exits ENFORCED under kill)', () => {
  it('killSwitch ON → live SL close STILL fires (kill = no NEW entries, stops disarm nahi hote); paper simulates', async () => {
    // v21.1.1 [audit B11]: v18.9 ka behavior (kill ON → live stops SUSPEND,
    // position manual control) DANGEROUS tha — panic-kill dabane wala trader
    // apne STOP LOSSES disarm nahi karna chahta. Ab entries block, exits
    // enforce. Ye test naya contract lock karta hai.
    saveJSON('ai-trading-config.json', { killSwitch: true });
    __setJournalForTests({
      entries: [],
      positions: [pos({ mode: 'live', sl: 95, id: 'live1' }), pos({ id: 'paper1', sl: 95 })],
    });
    _tickerRows = [{ market: 'BTCINR', last_price: '90' }]; // both SL hit
    await watchPositions({});
    const j = loadJournal();
    const live = j.positions.find(p => p.id === 'live1')!;
    const paper = j.positions.find(p => p.id === 'paper1')!;
    expect(live.status).toBe('CLOSED'); // v21.1.1: SL close EXECUTED under kill
    expect(paper.status).toBe('CLOSED'); // simulation continues
    // honest journal note (once per day per position)
    expect(j.entries.some(e => e.kind === 'WATCH_ERROR' && /KILL SWITCH ON/.test(String(e.reason || '')))).toBe(true);
    // the live market sell DID fire (exit enforced)
    expect(mockPrivate.mock.calls.filter(c => String(c[0]).includes('orders/create')).length).toBeGreaterThanOrEqual(1);
  });
});

// ---------------- 5. margin positions never partial-TP ----------------
describe('v18.9 #5 — leveraged books are excluded from partial TP', () => {
  it('leverage>1 agent position at T1 → NO partial leg, NO opposite-side margin order', async () => {
    __setJournalForTests({
      entries: [],
      positions: [pos({ mode: 'paper', source: 'agent', leverage: 3, tp: 105, tp2: 115, liquidation: 60 })],
    });
    _tickerRows = [{ market: 'BTCINR', last_price: '106' }]; // T1 hit
    await watchPositions({});
    const j = loadJournal();
    expect(j.entries.some(e => e.kind === 'PARTIAL_TP')).toBe(false);
    expect(j.positions[0].tp1Hit).toBeFalsy();
    expect(j.positions[0].qty).toBe(10); // full book untouched
    // and no margin create was attempted
    expect(mockPrivate.mock.calls.filter(c => String(c[0]).endsWith('/margin/orders'))).toHaveLength(0);
  });

  it('a spot agent position still takes its T1 partial leg (no behavior loss)', async () => {
    __setJournalForTests({
      entries: [],
      positions: [pos({ mode: 'paper', source: 'agent', tp: 105, tp2: 115 })],
    });
    _tickerRows = [{ market: 'BTCINR', last_price: '106' }];
    await watchPositions({});
    const j = loadJournal();
    expect(j.entries.some(e => e.kind === 'PARTIAL_TP')).toBe(true);
    expect(j.positions[0].tp1Hit).toBe(true);
  });
});

// ---------------- 6. partial leg below exchange minimum ----------------
describe('v18.9 #6 — partial legs respect the exchange minimum', () => {
  it('leg qty below products minQty → partialTpOff + honest journal (no 422 retry loop)', async () => {
    // products_details: BTCINR minQty 0.5 — T1 40% of 10 = 4 → ABOVE min…
    // use qty 1 → T1 40% = 0.4 < 0.5 → disable.
    const fetchOrig = globalThis.fetch;
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => [{ pair: 'BTCINR', symbol: 'BTCINR', precision: 6, min_quantity: 0.5, min_notional: 100 }],
    })));
    try {
      __setJournalForTests({
        entries: [],
        positions: [pos({ mode: 'paper', source: 'agent', qty: 1, originalQty: 1, tp: 105, tp2: 115 })],
      });
      _tickerRows = [{ market: 'BTCINR', last_price: '106' }];
      await watchPositions({});
      const j = loadJournal();
      expect(j.positions[0].partialTpOff).toBe(true);
      expect(j.entries.some(e => e.kind === 'WATCH_ERROR' && /below the exchange minimum/.test(String(e.reason || '')))).toBe(true);
      expect(j.entries.some(e => e.kind === 'PARTIAL_TP')).toBe(false);
    } finally {
      vi.unstubAllGlobals();
      globalThis.fetch = fetchOrig;
    }
  });
});

// ---------------- 7. fee honesty ----------------
describe('v18.9 #7 — booked P&L is NET of both-side taker fees (default 0.10%/side)', () => {
  it('paper SL close books pnlINR net of fees and carries feesINR', async () => {
    __setJournalForEntries();
    _tickerRows = [{ market: 'BTCINR', last_price: '95' }]; // SL hit at 95
    await watchPositions({});
    const j = loadJournal();
    const p = j.positions[0];
    expect(p.status).toBe('CLOSED');
    const fees = (100 + 95) * 10 * 0.001; // 1.95
    expect(p.feesINR).toBeCloseTo(fees, 2);
    expect(p.pnlINR).toBeCloseTo(-50 - fees, 2); // gross −50 → net −51.95
    const closeEntry = j.entries.find(e => e.kind === 'CLOSE');
    expect(closeEntry!.feesINR).toBeCloseTo(fees, 2);
  });

  it('AI_COINDCX_FEE_PCT env is the documented opt-out knob (source contract)', async () => {
    // The fee constant is computed at module load; asserting a cold-process
    // re-read is impractical in-process — lock the ENV wiring instead so
    // the knob can never be silently dropped by a refactor.
    const src = await import('node:fs').then(fs => fs.readFileSync('server/ai/coindcxOrders.js', 'utf8'));
    expect(src).toContain('AI_COINDCX_FEE_PCT');
    expect(src).toMatch(/Number\.isFinite\(n\) && n >= 0 && n <= 1 \? n : 0\.10/);
  });
});
function __setJournalForEntries() {
  __setJournalForTests({ entries: [], positions: [pos({})] });
}

// ---------------- 8. ambiguity cooldown ----------------
describe('v18.9 #8 — ambiguous close failures defer the re-send (double-sell protect)', () => {
  it('timeout error → closeRetryAfter set + journal note; next immediate pass does NOT re-send', async () => {
    mockPrivate.mockImplementation(async (path) => {
      if (String(path).includes('active_pairs')) throw new Error('[503] down');
      throw new Error('The operation was aborted due to timeout');
    });
    __setJournalForTests({ entries: [], positions: [pos({ mode: 'live', sl: 95 })] });
    _tickerRows = [{ market: 'BTCINR', last_price: '90' }]; // SL hit
    await watchPositions({});
    let j = loadJournal();
    let p = j.positions[0];
    expect(p.status).toBe('OPEN');
    expect(p.closeRetryAfter).toBeGreaterThan(Date.now() + 4 * 60_000);
    expect(j.entries.some(e => e.kind === 'WATCH_ERROR' && /MAY have executed/.test(String(e.reason || '')))).toBe(true);

    // second pass immediately (cooldown active) → NO new close attempt
    const callsAfterFirst = mockPrivate.mock.calls.length;
    await watchPositions({});
    expect(mockPrivate.mock.calls.length).toBe(callsAfterFirst);
  });

  it('definitive [422] rejection keeps the 60s retry (no cooldown) — exchange moved no coins', async () => {
    mockPrivate.mockImplementation(async (path) => {
      if (String(path).includes('active_pairs')) throw new Error('[503] down');
      throw new Error('[422] total_quantity is below minimum');
    });
    __setJournalForTests({ entries: [], positions: [pos({ mode: 'live', sl: 95 })] });
    _tickerRows = [{ market: 'BTCINR', last_price: '90' }];
    await watchPositions({});
    const j = loadJournal();
    expect(j.positions[0].closeRetryAfter).toBeFalsy();
    expect(j.positions[0].status).toBe('OPEN');
  });
});

// ---------------- 9. single-flight ----------------
describe('v18.9 #9 — watcher single-flight (overlapping ticks join, never stack)', () => {
  it('two concurrent watchPositions calls → ONE ticker fetch + ONE exchange close', async () => {
    _tickerRows = [{ market: 'BTCINR', last_price: '90' }]; // SL hit, paper
    __setJournalForTests({ entries: [], positions: [pos({})] });
    const [a, b] = await Promise.all([watchPositions({}), watchPositions({})]);
    // 1 watcher fetch + ≤1 wick-validator USDTINR fetch per PASS — a stacked
    // second pass would double this (4+).
    expect(tickers.mock.calls.length).toBeLessThanOrEqual(2);
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
    expect(loadJournal().positions[0].status).toBe('CLOSED');
  });
});
