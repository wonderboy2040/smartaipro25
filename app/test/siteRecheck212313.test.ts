// ============================================================
// test/siteRecheck212313.test.ts — v21.23.13
// AUTO-TRADE-LIVE CURE + CRYPTO PAPER-DESK ROUTING + DIRECTION HARDENING
// ------------------------------------------------------------
// User-reported, running EXACT v21.23.12 (c7767fe port == 87f05e6,
// 0 non-dist line diff):
//   (1) "crypto AUTO Trade Live button ON karne par bhi Auto Trade
//        nahi lag raha" — 5 root-causes cure kiye:
//       T1 neutral-tape hole (FRESH-TAPE-ABSENT stuck flag, 4 sites)
//       T2 engine-vs-UI boardSigs divergence (3 engine sites)
//       T3 manual PAPER clicks auto day-quota poison
//       T4 fake-green LIVE badge + silent arm failures + invisible
//          skip reasons
//   (2) "MTF board se Paper click Intraday tab me show hota hai" —
//       desk-scoped paper journal (summary/history/journal ?market=),
//       CoinDcxTab me naya CRYPTO Paper Desk, mirror singleton loop,
//       SL-trail hint-domain fix
//   (3) "long signal pakka long jana hai" — side-strict sweep:
//       spot-create body, marginExitBody, browser builders,
//       deep-monitor rows, openPaperTrade, restore side-inference,
//       Yahoo local sorts, cdc-official cert chain.
// Har lock apne fix ka EXACT disease class pin karta hai.
// ============================================================
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const APP_ROOT = path.join(__dirname, '..');
const read = (rel) => readFileSync(path.join(APP_ROOT, rel), 'utf8');

// ---- module mocks: in-memory store (no disk), light journal deps ----
vi.mock('../server/intraday/store.js', () => ({
  loadJSON: (_f: unknown, dflt: unknown) => (dflt && typeof dflt === 'object' ? structuredClone(dflt) : {}),
  saveJSON: () => true,
  DATA_DIR: '/tmp/unused-212313',
}));
vi.mock('../server/intraday/agent.js', () => ({ askLLM: vi.fn(async () => null) }));
vi.mock('../server/mcp/durable.js', () => ({ durablePut: vi.fn(), durableGetAll: vi.fn(() => []), durableInit: vi.fn() }));

import { istDayKey, dayKeyFor } from '../server/intraday/time.js';
import {
  openPaperTrade, getPaperSummary, getPaperHistory, updatePaperTradeStopLoss,
  restorePaperTrades, _resetForTests,
} from '../server/intraday/paperTrading.js';
import { recordTradeClose, getJournal, __reloadJournalForBoot } from '../server/intraday/journal.js';
import { recordLiveMtfBoardTrade, recordPaperMtfBoardTrade, mtfAutoStatus, __resetMtfAutoForTests } from '../server/ai/mtfAutoLink.js';
import { MODELS } from '../server/ai/models.js';
import { aggregateVotes } from '../server/ai/ensemble.js';
import { __orderFormScriptsForTests } from '../server/ai/browserAgent.js';
import { runLiveDirectionCertificate } from '../server/ai/directionLiveCert.js';

// ============================================================
// T1 — NEUTRAL-TAPE HOLE: freshTapeAbsent = sirf data-TRULY-absent
// ============================================================
describe('v21.23.13 T1 — neutral-tape freshTapeAbsent cure', () => {
  it('tape seat: data-absent abstain carries tapeDataAbsent flag; data-PRESENT neutral vote does NOT', () => {
    const tapeReg = MODELS.find((m) => m.id === 'tape');
    expect(tapeReg).toBeTruthy();
    // (a) tape MISSING → honest abstain WITH the flag (v21.23.4 contract)
    const absent = tapeReg.fn({ market: 'CRYPTO' });
    expect(absent.dir).toBe(0);
    expect(absent.tapeDataAbsent).toBe(true);
    // (b) tape PRESENT but market-neutral (dir 0, data in hand) → vote
    // WITHOUT the flag — the flag means "no data", not "no edge"
    const neutral = tapeReg.fn({ market: 'CRYPTO', tape: {} });
    expect(neutral.dir).toBe(0);
    expect(neutral.tapeDataAbsent).toBeUndefined();
  });

  it('aggregateVotes: neutral data-present tape vote does NOT flag consensus FRESH-TAPE-ABSENT; absent flag does', () => {
    const bull = { id: 'ema', name: 'EMA', role: 'trend', weight: 2, dir: 1, conf: 80, reasons: [] };
    const withAbsent = aggregateVotes([bull, { id: 'tape', name: 'Tape', role: 'timing', weight: 1.3, dir: 0, conf: 0, reasons: [], tapeDataAbsent: true }]);
    expect(withAbsent.freshTapeAbsent).toBe(true); // v21.23.4 contract intact
    const withNeutral = aggregateVotes([bull, { id: 'tape', name: 'Tape', role: 'timing', weight: 1.3, dir: 0, conf: 26, reasons: [] }]);
    expect(withNeutral.freshTapeAbsent).toBeFalsy(); // THE v21.23.13 cure
    // and the neutral vote did not turn the consensus FLAT either
    expect(withNeutral.side).toBe('LONG');
  });

  it('all 4 injection sites use the data-present-neutral condition; old dir-only pattern is GONE', () => {
    const src = read('server/ai/signals.js');
    expect((src.match(/tapeV\.tapeDataAbsent !== true/g) || []).length).toBe(4); // India board + crypto board + India deep + crypto deep
    expect(src.includes('if (tapeV && tapeV.dir !== 0')).toBe(false); // old neutral-skipping pattern removed everywhere
  });
});

// ============================================================
// T2 — ENGINE-vs-UI BOARDSIGS PARITY (crypto desk)
// ============================================================
describe('v21.23.13 T2 — engine boardSigs parity (CRYPTO→FUTURES like UI route)', () => {
  it('all 5 CRYPTO-desk boardSigs sites use the UI-route mapping (UI + 60s sweep + 15s deep tick + /run + preview)', () => {
    const src = read('server/ai/routes.js');
    // v21.23.15 [A6]: /mtf-auto/preview is the 5th site — a raw-CRYPTO
    // preview disagreed with the FUTURES board the engine actually trades.
    expect((src.match(/getSignals\(market === 'CRYPTO' \? 'FUTURES' : market/g) || []).length).toBe(5);
    // engine loops raw-CRYPTO boardSigs (the divergence) must not exist
    expect(src.includes('const base = await getSignals(market, deps, { warmOnly: true })')).toBe(false);
    expect(src.includes('const base = await getSignals(market, depsForSignals(), { warmOnly: true })')).toBe(false);
  });
});

// ============================================================
// T3 — PAPER-QUOTA POISONING CURE + deep-monitor side honesty
// ============================================================
describe('v21.23.13 T3 — paper clicks do not eat the auto engine quota', () => {
  beforeEach(() => { __resetMtfAutoForTests({ state: { dayCount: 0 } }); });

  it('manual PAPER registration does NOT consume dayCount (was: 5 clicks = auto dead all day)', () => {
    recordPaperMtfBoardTrade({ symbol: 'BTC', market: 'CRYPTO', side: 'LONG', entry: 100, stopLoss: 90, t1: 110, t2: 120, qty: 0.5 });
    recordPaperMtfBoardTrade({ symbol: 'ETH', market: 'CRYPTO', side: 'SHORT', entry: 50, stopLoss: 55, t1: 45, t2: 40, qty: 1 });
    expect(mtfAutoStatus().dayCount).toBe(0);
  });

  it('manual LIVE registration still counts (real-money budget intact)', () => {
    recordLiveMtfBoardTrade({ symbol: 'ETH', market: 'CRYPTO', side: 'SHORT', entry: 50, stopLoss: 55, t1: 45, t2: 40, qty: 1 });
    expect(mtfAutoStatus().dayCount).toBe(1);
  });

  it('invalid side on deep-monitor registration LOUD-throws (no silent LONG default)', () => {
    expect(() => recordLiveMtfBoardTrade({ symbol: 'SOL', market: 'CRYPTO', side: 'FLAT', entry: 100, stopLoss: 90, qty: 1 })).toThrow(/invalid side/);
    expect(() => recordPaperMtfBoardTrade({ symbol: 'SOL', market: 'CRYPTO', side: undefined, entry: 100, stopLoss: 90, qty: 1 })).toThrow(/invalid side/);
  });

  it('BUY alias normalizes to LONG in the deep-monitor book row', () => {
    recordLiveMtfBoardTrade({ symbol: 'SOL', market: 'CRYPTO', side: 'BUY', entry: 100, stopLoss: 90, t1: 110, t2: 120, qty: 1 });
    const row = (mtfAutoStatus().book || []).find((b) => b.symbol === 'SOL');
    expect(row?.side).toBe('LONG');
  });
});

// ============================================================
// T4 — HONEST LIVE BUTTON (UI source locks)
// ============================================================
describe('v21.23.13 T4 — honest LIVE badge + arm + idle transparency (UI locks)', () => {
  it('isLiveAuto requires canLive + executionMode live + fresh server deskReady (A3)', () => {
    const src = read('src/components/aitrading/MTFDualBoardPanel.tsx');
    expect(src.includes('armed && canLive && autoFresh && auto?.executionMode === \'live\'')).toBe(true);
    expect(src.includes('deskReadiness?.ready === true')).toBe(true);
    expect(src.includes('setAutoFresh(false)')).toBe(true);
  });
  it('onAutoLiveExecute: honest abort on config/toggle fail + creds pre-flight + skip-reason status', () => {
    const src = read('src/components/aitrading/MTFDualBoardPanel.tsx');
    expect(src.includes('HONEST ARM — LIVE')).toBe(true);
    expect(src.includes('CREDS PRE-FLIGHT')).toBe(true);
    expect(src.includes('coindcxConnected === false')).toBe(true);
    expect(src.includes('last-tick skip')).toBe(true); // idle-reason transparency
    expect(src.includes('keys NOT connected')).toBe(true); // status-line warning
  });
});

// ============================================================
// P1 — DESK-SCOPED PAPER SUMMARY / HISTORY
// ============================================================
describe('v21.23.13 P1 — getPaperSummary/getPaperHistory desk filter', () => {
  beforeEach(() => {
    const todayIndia = dayKeyFor('INDIA');
    const todayCrypto = dayKeyFor('CRYPTO');
    _resetForTests({
      trades: [
        { id: 1, symbol: 'SBIN', market: 'INDIA', direction: 'LONG', entry: 100, qty: 1, stopLoss: 90, target1: 110, target2: 120, remainingQty: 1, status: 'OPEN', openedAt: Date.now() - 60_000, dayKey: todayIndia, source: 'ui', realizedPnl: 0, unrealizedPnl: 0, parts: [] },
        { id: 2, symbol: 'BTC', market: 'CRYPTO', direction: 'LONG', entry: 100, qty: 0.5, stopLoss: 90, target1: 110, target2: 120, remainingQty: 0.5, status: 'OPEN', openedAt: Date.now() - 60_000, dayKey: todayCrypto, source: 'mtf-board-ui', realizedPnl: 0, unrealizedPnl: 0, parts: [] },
        { id: 3, symbol: 'ETH', market: 'FUTURES', direction: 'SHORT', entry: 50, qty: 1, stopLoss: 55, target1: 45, target2: 40, remainingQty: 1, status: 'OPEN', openedAt: Date.now() - 60_000, dayKey: todayCrypto, source: 'mtf-auto', realizedPnl: 0, unrealizedPnl: 0, parts: [] },
        { id: 4, symbol: 'TCS', market: 'INDIA', direction: 'LONG', entry: 200, qty: 1, stopLoss: 190, target1: 210, target2: 220, remainingQty: 0, status: 'CLOSED', openedAt: Date.now() - 3_600_000, closedAt: Date.now() - 1_800_000, realizedPnl: 500, unrealizedPnl: 0, lastPrice: 210, dayKey: todayIndia, closeReason: 'T1_HIT', parts: [] },
        { id: 5, symbol: 'SOL', market: 'CRYPTO', direction: 'LONG', entry: 100, qty: 1, stopLoss: 90, target1: 110, target2: 120, remainingQty: 0, status: 'CLOSED', openedAt: Date.now() - 3_600_000, closedAt: Date.now() - 1_800_000, realizedPnl: 200, unrealizedPnl: 0, lastPrice: 120, dayKey: todayCrypto, closeReason: 'T2_HIT', parts: [] },
      ],
      nextId: 6,
      dayKey: dayKeyFor('INDIA'),
    });
  });

  it('market=INDIA → only NSE rows (open + closedToday + stats + history)', () => {
    const s = getPaperSummary('INDIA');
    expect(s.open.length).toBe(1);
    expect(s.open[0].symbol).toBe('SBIN');
    expect(s.closedToday.length).toBe(1);
    expect(s.closedToday[0].symbol).toBe('TCS');
    expect(s.stats.openCount).toBe(1);
    expect(getPaperHistory(90, 'INDIA').totalClosed).toBe(1);
  });

  it('market=CRYPTO → crypto family rows (CRYPTO spot + FUTURES perp + GLOBALFUTURES)', () => {
    const s = getPaperSummary('CRYPTO');
    expect(s.open.length).toBe(2); // BTC (CRYPTO) + ETH (FUTURES) — the MTF board paper rows
    expect(s.open.every((t) => t.market !== 'INDIA')).toBe(true);
    expect(s.closedToday.length).toBe(1);
    expect(s.closedToday[0].symbol).toBe('SOL');
    expect(getPaperHistory(90, 'CRYPTO').totalClosed).toBe(1);
  });

  it('no filter → whole shared journal (engine callers + mirror + legacy back-compat)', () => {
    const s = getPaperSummary();
    expect(s.open.length).toBe(3);
    expect(s.closedToday.length).toBe(2);
    expect(getPaperHistory(90).totalClosed).toBe(2);
  });

  it('route layer + panel wiring locks (?market= query, desk props, mirror singleton)', () => {
    expect(read('server/intraday/routes.js').includes('getPaperSummary(paperMarketFilter(req.query.market))')).toBe(true);
    expect(read('server/intraday/routes.js').includes('getPaperHistory(days, paperMarketFilter(req.query.market))')).toBe(true);
    expect(read('src/components/intraday/PaperTradePanel.tsx').includes('desk?: \'INDIA\' | \'CRYPTO\' | null')).toBe(true);
    expect(read('src/components/intraday/PaperTradePanel.tsx').includes('ensureMirrorSyncLoop()')).toBe(true);
    expect(read('src/components/tabs/CoinDcxTab.tsx').includes('PaperTradePanel desk="CRYPTO"')).toBe(true);
    expect(read('src/components/tabs/CoinDcxTab.tsx').includes('cx-paper-desk')).toBe(true);
    expect(read('src/components/tabs/IndiaIntradayTab.tsx').includes('PaperTradePanel desk="INDIA"')).toBe(true);
    expect(read('src/utils/paperMirror.ts').includes('export function ensureMirrorSyncLoop')).toBe(true);
    expect(read('src/utils/paperMirror.ts').includes('PAPER_MIRROR_RESTORED_EVENT')).toBe(true);
  });
});

// ============================================================
// P2 — SL-TRAIL HINT DOMAIN (3s fast loop symbol-fallback fix)
// ============================================================
describe('v21.23.13 P2 — SL-trail hint domain (execMarket first)', () => {
  beforeEach(() => { _resetForTests(); });

  it('FUTURES paper row matches FUTURES hint; CRYPTO hint must NOT match it (the old wrong hint)', () => {
    openPaperTrade({ symbol: 'BTC', direction: 'LONG', entry: 100, qty: 0.5, stopLoss: 90, target1: 110, target2: 120, market: 'FUTURES' });
    const wrongDomain = updatePaperTradeStopLoss('BTC', 95, 'CRYPTO'); // the OLD route hint — must not match a FUTURES row
    expect(wrongDomain.ok).toBe(false);
    const rightDomain = updatePaperTradeStopLoss('BTC', 95, 'FUTURES'); // execMarket = the paper journal's actual domain
    expect(rightDomain.ok).toBe(true);
    expect(rightDomain.trade?.stopLoss).toBe(95);
  });

  it('routes.js fast-SL loop passes execMarket first', () => {
    expect(read('server/ai/routes.js').includes('tr.execMarket || tr.market || null')).toBe(true);
    expect(read('server/ai/routes.js').includes('tr.market || tr.execMarket || null')).toBe(false);
  });
});

// ============================================================
// P3 — JOURNAL DESK STAMP + FILTER (crypto closes stop polluting NSE view)
// ============================================================
describe('v21.23.13 P3 — journal market stamp + desk-scoped read', () => {
  it('recordTradeClose stamps market; getJournal filters per desk (legacy rows stay visible)', () => {
    __reloadJournalForBoot();
    const today = istDayKey();
    recordTradeClose({ id: 910_101, status: 'CLOSED', symbol: 'SBIN', market: 'INDIA', direction: 'LONG', entry: 100, qty: 1, stopLoss: 90, target1: 110, target2: 120, dayKey: today, realizedPnl: 500, openedAt: Date.now() - 3_600_000, closedAt: Date.now() - 60_000, closeReason: 'T1_HIT', parts: [] });
    recordTradeClose({ id: 910_102, status: 'CLOSED', symbol: 'BTC', market: 'FUTURES', direction: 'SHORT', entry: 100, qty: 1, stopLoss: 105, target1: 90, target2: 85, dayKey: today, realizedPnl: -50, openedAt: Date.now() - 3_600_000, closedAt: Date.now() - 60_000, closeReason: 'SL_HIT', parts: [] });

    const all = getJournal(14, null);
    expect(all.entries.some((e) => e.tradeId === 910_101 && e.market === 'INDIA')).toBe(true);
    expect(all.entries.some((e) => e.tradeId === 910_102 && e.market === 'FUTURES')).toBe(true);

    const india = getJournal(14, 'INDIA');
    expect(india.entries.some((e) => e.tradeId === 910_101)).toBe(true);
    expect(india.entries.some((e) => e.tradeId === 910_102)).toBe(false); // crypto close not in NSE view

    const crypto = getJournal(14, 'CRYPTO');
    expect(crypto.entries.some((e) => e.tradeId === 910_102)).toBe(true);
    expect(crypto.entries.some((e) => e.tradeId === 910_101)).toBe(false);

    expect(read('src/components/intraday/JournalPanel.tsx').includes('desk?: \'INDIA\' | \'CRYPTO\' | null')).toBe(true);
    expect(read('src/components/tabs/IndiaIntradayTab.tsx').includes('JournalPanel desk="INDIA"')).toBe(true);
  });
});

// ============================================================
// D1 — OPEN PAPER TRADE SIDE HONESTY (no silent LONG default)
// ============================================================
describe('v21.23.13 D1 — openPaperTrade direction honesty', () => {
  beforeEach(() => { _resetForTests(); });

  it('missing/garbage direction → honest error (was: silently LONG)', () => {
    const r = openPaperTrade({ symbol: 'SBIN', entry: 100, qty: 1, stopLoss: 90, target1: 110, target2: 120, market: 'INDIA' });
    expect(r.error).toMatch(/Valid direction required/);
    const g = openPaperTrade({ symbol: 'SBIN', direction: 'SIDEWAYS', entry: 100, qty: 1, stopLoss: 90, target1: 110, target2: 120, market: 'INDIA' });
    expect(g.error).toMatch(/Valid direction required/);
  });

  it('BUY/SELL dual-vocab normalize → LONG/SHORT', () => {
    const a = openPaperTrade({ symbol: 'SBIN', direction: 'BUY', entry: 100, qty: 1, stopLoss: 90, target1: 110, target2: 120, market: 'INDIA' });
    expect(a.trade?.direction).toBe('LONG');
    const b = openPaperTrade({ symbol: 'BTC', direction: 'SELL', entry: 100, qty: 0.5, stopLoss: 105, target1: 90, target2: 85, market: 'FUTURES' });
    expect(b.trade?.direction).toBe('SHORT');
  });
});

// ============================================================
// D2 — RESTORE SIDE-INFERENCE (legacy mirror rows)
// ============================================================
describe('v21.23.13 D2 — restore side-inference from row levels', () => {
  beforeEach(() => { _resetForTests(); });

  it('direction missing → infer from SL position + directionAssumed stamp; explicit SELL → SHORT, not assumed', () => {
    const today = dayKeyFor('INDIA');
    const r = restorePaperTrades({ trades: [
      { id: 901, symbol: 'SBIN', market: 'INDIA', entry: 100, qty: 1, stopLoss: 105, target1: 90, target2: 85, remainingQty: 1, status: 'OPEN', openedAt: Date.now() - 60_000, dayKey: today, realizedPnl: 0 }, // SL>entry → SHORT structure
      { id: 902, symbol: 'TCS', market: 'INDIA', entry: 200, qty: 1, stopLoss: 190, target1: 210, target2: 220, remainingQty: 1, status: 'OPEN', openedAt: Date.now() - 60_000, dayKey: today, realizedPnl: 0 }, // SL<entry → LONG structure
      { id: 903, symbol: 'INFY', market: 'INDIA', direction: 'SELL', entry: 300, qty: 1, stopLoss: 305, target1: 295, target2: 290, remainingQty: 1, status: 'OPEN', openedAt: Date.now() - 60_000, dayKey: today, realizedPnl: 0 },
    ] });
    expect(r.ok).toBe(true);
    const open = getPaperSummary().open;
    const sbin = open.find((t) => t.id === 901);
    expect(sbin?.direction).toBe('SHORT');
    expect(sbin?.directionAssumed).toBe(true);
    const tcs = open.find((t) => t.id === 902);
    expect(tcs?.direction).toBe('LONG');
    expect(tcs?.directionAssumed).toBe(true);
    const infy = open.find((t) => t.id === 903);
    expect(infy?.direction).toBe('SHORT');
    expect(infy?.directionAssumed).toBeUndefined(); // explicit side — no assumption
  });
});

// ============================================================
// D3 — EXECUTION BODY SIDE-STRICTNESS (spot create + margin exit)
// ============================================================
describe('v21.23.13 D3 — order-body side-strictness (last silent defaults closed)', () => {
  it('spot /orders/create body: dual-vocab strict + LOUD THROW (source lock on the last strict-ternary)', () => {
    const src = read('server/ai/coindcxOrders.js');
    expect(src.includes('_spotSideAlias')).toBe(true);
    expect(src.includes("silent 'buy' default v21.23.13 se mana hai")).toBe(true);
    expect(src.includes("side: effectiveSignal.side === 'SHORT' ? 'sell' : 'buy'")).toBe(false); // old silent default gone
  });

  it('marginExitBody: unknown side LOUD-throws instead of silent buy', () => {
    const src = read('server/ai/coindcxOrders.js');
    expect(src.includes('marginExitBody: invalid side')).toBe(true);
    expect(src.includes("String(side).toLowerCase() === 'short' ? 'sell' : 'buy'")).toBe(false);
  });

  it('browser builders: invalid side throws at BUILD time (no wrong-side click possible)', () => {
    const S = __orderFormScriptsForTests();
    expect(() => S.cxPlaceOrderScript({ side: 'FLAT', price: 100 })).toThrow(/invalid side/);
    expect(() => S.cxPlaceOrderScript({ side: undefined, price: 100 })).toThrow(/invalid side/);
    expect(() => S.dhanPlaceOrderScript({ side: 'GARBAGE', price: 100, quantity: 1, product: 'CNC' })).toThrow(/invalid side/);
    // valid dual-vocab builds correct scripts
    const cxShort = S.cxPlaceOrderScript({ side: 'SELL', price: 100 });
    expect(cxShort).toContain('"SHORT"');
    const dhanLong = S.dhanPlaceOrderScript({ side: 'LONG', price: 100, quantity: 1, product: 'CNC' });
    expect(dhanLong).toContain('"buy"');
    const dhanShort = S.dhanPlaceOrderScript({ side: 'SELL', price: 100, quantity: 1, product: 'CNC' });
    expect(dhanShort).toContain('"sell"');
  });
});

// ============================================================
// D4 — YAHOO LOCAL SORTS (S2-PARITY: last wire-order-trust readers)
// ============================================================
describe('v21.23.13 D4 — Yahoo candle local ascending sort', () => {
  it('signals.js fetchYahooCandles sorts locally before the ≥30 gate', () => {
    const src = read('server/ai/signals.js');
    const m = src.match(/const out = \[\];[\s\S]{0,900}?out\.sort\(\(a, b\) => a\.time - b\.time\);\s*\n\s*return out\.length >= 30 \? out : null;/);
    expect(m).toBeTruthy();
  });
  it('expertMode fetchYahooChartCandles sorts locally before cache/return', () => {
    const src = read('server/ai/expertMode.js');
    expect(src.includes('candles.sort((a, b) => a.time - b.time);')).toBe(true);
  });
});

// ============================================================
// D5 — LIVE CERT: cdc-official chain + version stamps
// ============================================================
describe('v21.23.13 D5 — directionLiveCert cdc-official chain', () => {
  it('skipNetwork payload is honest (version stamp current)', async () => {
    const cert = await runLiveDirectionCertificate({ skipNetwork: true });
    expect(cert.pass).toBe(true);
    expect(cert.version).toBe('v21.23.16'); // was v21.23.15
    expect(cert.chains).toEqual([]);
  });

  it('cert source: documented-endpoint chain wired with the SAME canonicalizer + label', () => {
    const src = read('server/ai/directionLiveCert.js');
    expect(src.includes("'cdc-official (api.coindcx.com BTCINR 15m)'")).toBe(true);
    expect(src.includes("canonicalizeCandles(raw, { label: 'cdc-official:BTC:15m' })")).toBe(true);
  });
});

// ============================================================
// D6 — VERSION + STAMP AGREEMENT (release gate)
// ============================================================
describe('v21.23.16 D6 — version stamps', () => {
  it('package.json === src/version.ts === 21.23.16; watchdog bat stamped, no stale versions', () => {
    const pkg = JSON.parse(read('package.json'));
    expect(pkg.version).toBe('21.23.16');
    expect(read('src/version.ts')).toContain("APP_VERSION = '21.23.16'");
    const bat = read('Start-SmartAI-Watchdog.bat');
    expect(bat).toContain('v21.23.16');
    expect(bat).not.toContain('v21.23.14');
    expect(bat).not.toContain('v21.23.12');
    expect(bat).not.toContain('v21.23.11');
  });
});
