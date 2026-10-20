// ============================================================
// test/siteRecheck21239.test.ts — v21.23.9 FULL-SITE DEEP RECHECK locks
// ------------------------------------------------------------
// Audit findings jo is version me fix hue (har lock ek verified defect
// ki rok-tok karta hai):
//   S1 — CRITICAL: futuresOrderBody SHORT-inversion ('SELL' !== 'SHORT'
//        → long=true → SHORT entry ulti BUY position). Dual-vocabulary
//        honest map + unknown-side loud reject + port.js validation.
//   S2 — 3s fast SL-trail LIVE exchange sync dead param (newStopLoss →
//        stopLoss) — silent permanent no-op tha.
//   S3 — routes.js ka `./metals.js` import EXIST hi nahi karta tha →
//        XAU/XAG quote fallback legs 100% dead.
//   S4 — mtf.js 4h path overlay ko shared _yfCache me BAKE karta tha
//        (v21.23.5 cache-safety invariant violation).
//   S5 — chartCandles overlaid series cache + fetchedAt overstated.
//   S6 — spot WS telemetry: passthrough lastUpdateAt drop + failStreak
//        futures socket ka misattributed.
//   S7 — cxBookState btST/cmRT seconds stamps un-normalized → futures
//        live-bar overlay SILENT skippedStale.
//   S8 — healthMonitor ws_stale alert GLOB-quiet sessions par false-spam.
// ============================================================
import { describe, it, expect, beforeEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { futuresOrderBody } from '../server/ai/futures.js';
import { priceLevelsForLeg } from '../server/ai/reversalEngine.js';
import { ApiFuturesPort } from '../server/exec/port.js';
import { mergeFutBook, futBookSnapshot, _resetFutBookForTest } from '../server/ai/cxBookState.js';
import { spotWsStatus } from '../server/ai/cxSpotWs.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(APP_ROOT, p), 'utf8');
const FUT_SRC = read('server/ai/futures.js');
const PORT_SRC = read('server/exec/port.js');
const REV_SRC = read('server/ai/reversalEngine.js');
const ROUTES_SRC = read('server/ai/routes.js');
const MTF_SRC = read('server/ai/mtf.js');
const HM_SRC = read('server/healthMonitor.js');
const CXRT_SRC = read('server/ai/cxRtStream.js');
const CXWS_SRC = read('server/ai/cxWsCandles.js');

// ApiFuturesPort _fut mock (execPort.test.ts pattern)
const _futMock = {
  fetchFuturesWallets: vi.fn(async () => [{ currency: 'USDT', free: 500, locked: 0, total: 500 }]),
  listFuturesPositions: vi.fn(async () => []),
  createFuturesOrder: vi.fn(async (p) => ({ orderId: `ord-${Math.random().toString(36).slice(2, 10)}`, raw: { ...p } })),
  createFuturesTpsl: vi.fn(async (p) => ({ ok: true, ...p })),
  partialFuturesExit: vi.fn(async (p) => ({ ok: true, orderId: 'red-x', raw: { ...p } })),
  exitFuturesPosition: vi.fn(async (p) => ({ ok: true, ...p })),
};
beforeEach(() => {
  _futMock.createFuturesOrder.mockClear();
  _futMock.fetchFuturesWallets.mockClear();
  _futMock.listFuturesPositions.mockClear();
});

// ---------------------------------------------------------------
// S1 — CRITICAL SHORT-inversion fix
// ---------------------------------------------------------------
describe('v21.23.9 S1 — futuresOrderBody dual-vocabulary + port honest side (CRITICAL SHORT-inversion fix)', () => {
  it('THE INVERSION LOCK: exec-port vocabulary "sell" → exchange order side "sell" (pehle "SELL" !== "SHORT" → long=true → "buy" — SHORT entry ulti BUY position)', () => {
    const b = futuresOrderBody({ pair: 'B-ETH_USDT', side: 'sell', qty: 2, leverage: 3 });
    expect(b.order.side).toBe('sell');
  });
  it('"buy" → "buy" (exec-port LONG)', () => {
    const b = futuresOrderBody({ pair: 'B-BTC_USDT', side: 'buy', qty: 0.01, leverage: 3 });
    expect(b.order.side).toBe('buy');
  });
  it('"SHORT" → "sell" (mtfDual/reversal/partial vocabulary — regression-free)', () => {
    const b = futuresOrderBody({ pair: 'B-BTC_USDT', side: 'SHORT', qty: 0.01, leverage: 5, price: 100000 });
    expect(b.order.side).toBe('sell');
    expect(b.order.order_type).toBe('limit_order');
  });
  it('"LONG" → "buy" (regression-free)', () => {
    const b = futuresOrderBody({ pair: 'B-BTC_USDT', side: 'LONG', qty: 0.01, leverage: 3 });
    expect(b.order.side).toBe('buy');
    expect(b.order.order_type).toBe('market_order');
  });
  it('case-insensitive dono vocabularies ("Sell"/"sHoRt"/"Long"/"BuY")', () => {
    expect(futuresOrderBody({ pair: 'P', side: 'Sell', qty: 1, leverage: 1 }).order.side).toBe('sell');
    expect(futuresOrderBody({ pair: 'P', side: 'sHoRt', qty: 1, leverage: 1 }).order.side).toBe('sell');
    expect(futuresOrderBody({ pair: 'P', side: 'Long', qty: 1, leverage: 1 }).order.side).toBe('buy');
    expect(futuresOrderBody({ pair: 'P', side: 'BuY', qty: 1, leverage: 1 }).order.side).toBe('buy');
  });
  it('unknown side = LOUD reject (silent-LONG-default GONE — v21.23.4 doctrine)', () => {
    expect(() => futuresOrderBody({ pair: 'B-BTC_USDT', side: 'SIDEWAYS', qty: 1, leverage: 1 })).toThrow();
    expect(() => futuresOrderBody({ pair: 'B-BTC_USDT', qty: 1, leverage: 1 })).toThrow(); // side undefined
  });
  it('createFuturesOrder builder-throw ko honest {orderId:null, error} me convert karta hai — network call se PEHLE (source pin)', () => {
    expect(FUT_SRC).toContain('body = futuresOrderBody({ pair, side, qty, leverage, price, marginCurrency });');
    expect(FUT_SRC).toContain('return { orderId: null, error: String(e?.message || e).slice(0, 160) };');
  });
  it('port.js open(): invalid side → honest {ok:false} reject, order call KABHI nahi (silent sell-default hata)', async () => {
    const port = new ApiFuturesPort({ futuresMod: _futMock });
    const r = await port.open({ pair: 'B-BTC_USDT', side: 'SIDEWAYS', qty: 1, leverage: 2 });
    expect(r.ok).toBe(false);
    expect(String(r.error)).toMatch(/invalid side/);
    expect(_futMock.createFuturesOrder).not.toHaveBeenCalled();
  });
  it('port.js open(): SHORT → adapter "sell" pass karta hai (real builder ab sahi map karta hai — chain integrity)', async () => {
    const port = new ApiFuturesPort({ futuresMod: _futMock });
    const r = await port.open({ pair: 'B-ETH_USDT', side: 'SHORT', qty: 2, leverage: 3, type: 'limit', price: 50 });
    expect(r.ok).toBe(true);
    expect(_futMock.createFuturesOrder).toHaveBeenCalled();
    expect(_futMock.createFuturesOrder.mock.calls[0][0].side).toBe('sell');
  });
  it('port.js open(): "BUY" vocabulary bhi accept (isLong honest)', async () => {
    const port = new ApiFuturesPort({ futuresMod: _futMock });
    const r = await port.open({ pair: 'B-BTC_USDT', side: 'BUY', qty: 1, leverage: 2 });
    expect(r.ok).toBe(true);
    expect(_futMock.createFuturesOrder.mock.calls[0][0].side).toBe('buy');
  });
  it('port.js silent-default line GONE + validation present (source pin)', () => {
    expect(PORT_SRC).not.toContain("const isLong = String(side).toUpperCase() === 'LONG';");
    expect(PORT_SRC).toContain("if (s !== 'LONG' && s !== 'SHORT' && s !== 'BUY' && s !== 'SELL')");
    expect(PORT_SRC).toContain("const isLong = s === 'LONG' || s === 'BUY';");
  });
  it('priceLevelsForLeg: unknown side → {sl:null, tp:null} honest refuse (silent-LONG-default hata)', () => {
    expect(priceLevelsForLeg({ side: 'SIDEWAYS', entry: 0.5, qty: 1000, lossCapINR: 150, profitTargetINR: 500, usdInr: 84 }))
      .toEqual({ sl: null, tp: null });
    expect(priceLevelsForLeg({ side: undefined, entry: 0.5, qty: 1000, lossCapINR: 150, profitTargetINR: 500, usdInr: 84 }))
      .toEqual({ sl: null, tp: null });
    const l = priceLevelsForLeg({ side: 'LONG', entry: 0.5, qty: 1000, lossCapINR: 150, profitTargetINR: 500, usdInr: 84 });
    expect(Number(l.sl)).toBeGreaterThan(0);
    const s = priceLevelsForLeg({ side: 'SHORT', entry: 0.5, qty: 1000, lossCapINR: 150, profitTargetINR: 500, usdInr: 84 });
    expect(Number(s.sl)).toBeGreaterThan(0.5);
  });
  it('reversalEngine source pin: silent-LONG line GONE', () => {
    expect(REV_SRC).not.toContain("const long = String(side).toUpperCase() !== 'SHORT';");
  });
});

// ---------------------------------------------------------------
// S2 — 3s fast SL-trail LIVE sync dead-param fix
// ---------------------------------------------------------------
describe('v21.23.9 S2 — fastSlTrailLoop LIVE exchange SL sync (dead `newStopLoss` param fix)', () => {
  it('updateCoinDcxPositionSl ko ab `stopLoss:` milta hai (signature { positionId, symbol, pair, stopLoss, takeProfit }) — pehle `newStopLoss:` → har pass invalid-stopLoss early-return = SILENT DEAD CODE', () => {
    expect(ROUTES_SRC).toContain('stopLoss: tr.trailedStopLoss,');
    expect(ROUTES_SRC).not.toContain('newStopLoss: tr.trailedStopLoss,');
  });
  it('takeProfit HAMESHA t2 — v21.23.10 TP-LADDER FIX (honest update: v21.23.9 ka "TP1→T1 ladder" pin hi live bug tha)', () => {
    // CoinDCX create_tpsl FULL position close karta hai — pre-TP1 TP=T1 arm
    // karna matlab pehli Stage-1 trail par LIVE position POORI T1 par exit
    // (TP1-partial + TP2-runner design kabhi live me nahi chala). Entry
    // arming (tp2) + 15s deep tick (b.t2) pehle se TP2 — 3s loop ab aligned.
    expect(ROUTES_SRC).toContain('takeProfit: tr.t2,');
    expect(ROUTES_SRC).not.toContain('takeProfit: tr.tp1Hit ? tr.t2 : tr.t1,');
  });
  it('paper-side sync (updatePaperTradeStopLoss) untouched — positional signature', () => {
    expect(ROUTES_SRC).toContain('updatePaperTradeStopLoss(tr.paperId ?? tr.symbol, tr.trailedStopLoss)');
  });
});

// ---------------------------------------------------------------
// S3 — dead ./metals.js import fix
// ---------------------------------------------------------------
describe('v21.23.9 S3 — XAU/XAG metals fallback legs resurrected (dead `./metals.js` import fix)', () => {
  it('routes.js me `import(\'./metals.js\')` ka koi live import nahi bacha (module repo me EXIST hi nahi karta tha)', () => {
    expect(ROUTES_SRC).not.toContain("import('./metals.js')");
  });
  it('futures.js ka fetchMetalsPrices real resolve hota hai (dynamic import)', async () => {
    const mod = await import('../server/ai/futures.js');
    expect(typeof mod.fetchMetalsPrices).toBe('function');
  });
  it('dono call-sites ab futures.js se (source pins)', () => {
    expect(ROUTES_SRC).toContain("const { fetchMetalsPrices } = await import('./futures.js')");
    expect(ROUTES_SRC).toContain('const [{ fetchFuturesPrices, fetchMetalsPrices }] = await Promise.all([');
  });
});

// ---------------------------------------------------------------
// S4 — mtf.js 4h overlay-bake fix
// ---------------------------------------------------------------
describe('v21.23.9 S4 — 4h resample ab RAW 1h se (overlay-bake fix — cache hamesha RAW)', () => {
  it('4h branch ab raw 1h payload use karta hai (`{ raw: true }`)', () => {
    expect(MTF_SRC).toContain("_indiaCandles(symbol, '1h', market, { raw: true })");
  });
  it('purana overlaid-1h resample call GONE', () => {
    expect(MTF_SRC).not.toContain("const base = await _indiaCandles(symbol, '1h', market);");
  });
  it('raw passthrough: cache-hit + return dono overlay gate (per-READ discipline) — v21.23.10 null-mini-TTL honest update', () => {
    // v21.23.10: cache-hit line ab null-payload ko 60s mini-TTL se serve
    // karti hai (null ko poore 1d-TTL=30min tak cache karna ek transient
    // Yahoo 429 ke liye leg ko aadha ghanta blank rakhta tha) — RAW-cache
    // + per-READ overlay discipline INTACT (null path me overlay no-op).
    expect(MTF_SRC).toContain('if (hit && Date.now() - hit.at < (hit.payload == null ? 60_000 : ttl)) {');
    expect(MTF_SRC).toContain('return raw ? hit.payload : (hit.payload == null ? null : indiaOverlayCandles(symbol, tf, hit.payload));');
    expect(MTF_SRC).toContain('return raw ? out : indiaOverlayCandles(symbol, tf, out);');
  });
});

// ---------------------------------------------------------------
// S5 — chartCandles freshness honesty
// ---------------------------------------------------------------
describe('v21.23.9 S5 — chartCandles per-hit overlay refresh + honest fetchedAt', () => {
  it('INDIA/GLOBALFUTURES cache-hits per-read overlay refresh (domain-safe legs only)', () => {
    expect(MTF_SRC).toContain('const refreshed = indiaOverlayCandles(sym, t, base);');
    expect(MTF_SRC).toContain("if (mkt === 'INDIA' || mkt === 'GLOBALFUTURES') {");
  });
  it('fetchedAt ab honest dataAt (hit.at) — overstated `fetchedAt: now,` GONE', () => {
    expect(MTF_SRC).toContain('fetchedAt: dataAt,');
    expect(MTF_SRC).not.toContain('fetchedAt: now,');
  });
});

// ---------------------------------------------------------------
// S6 — spot WS telemetry honesty
// ---------------------------------------------------------------
describe('v21.23.9 S6 — spot WS lastUpdateAt + apna failStreak (passthrough + health fix)', () => {
  it('spotWsStatus(): failStreak finite number + lastUpdateAt field exist', () => {
    const st = spotWsStatus();
    expect(Number.isFinite(st.failStreak)).toBe(true);
    expect('lastUpdateAt' in st).toBe(true);
  });
  it('cxRtStream passthrough ab dono fields forward karta hai (source pin)', () => {
    expect(CXRT_SRC).toContain('lastUpdateAt: spot.lastUpdateAt ?? null,');
    expect(CXRT_SRC).toContain('failStreak: Number.isFinite(spot.failStreak) ? spot.failStreak : 0,');
  });
  it('healthMonitor spot entry ab SPOT ka failStreak padhta hai (futures socket ka nahi) (source pin)', () => {
    expect(HM_SRC).toContain('Number.isFinite(cx.spotWs.failStreak) ? cx.spotWs.failStreak : 0');
  });
});

// ---------------------------------------------------------------
// S7 — cxBookState seconds normalization
// ---------------------------------------------------------------
describe('v21.23.9 S7 — fut book ts seconds-normalization (futures overlay silent-skip fix)', () => {
  beforeEach(() => _resetFutBookForTest());
  it('btST SECONDS (top-level ts ABSENT) → snapshot row ts ms me (>1e12) — overlay ab fire hoga', () => {
    const sec = Math.floor(Date.now() / 1000);
    mergeFutBook({ 'B-BTC_USDT': { ls: 76_100.2, btST: sec } }, 0);
    const row = futBookSnapshot(10_000).get('B-BTC_USDT');
    expect(row).toBeTruthy();
    expect(Number(row.ts)).toBeGreaterThan(1e12);
  });
  it('btST ms → unchanged (no double-scale)', () => {
    const ms = Date.now();
    mergeFutBook({ 'B-BTC_USDT': { ls: 76_100.2, btST: ms } }, 0);
    const row = futBookSnapshot(10_000).get('B-BTC_USDT');
    expect(Number(row.ts)).toBe(ms);
  });
  it('cmRT seconds fallback bhi normalize', () => {
    const sec = Math.floor(Date.now() / 1000) - 1;
    mergeFutBook({ 'B-XAG_USDT': { mp: 38.5, cmRT: sec } }, 0);
    const row = futBookSnapshot(10_000).get('B-XAG_USDT');
    expect(row).toBeTruthy();
    expect(Number(row.ts)).toBeGreaterThan(1e12);
  });
  it('cxWsCandles _futTick defensive seconds→ms + dead row.at read GONE (source pin)', () => {
    expect(CXWS_SRC).toContain('const atMs = tsRaw > 0 && tsRaw < 1e12 ? tsRaw * 1000 : tsRaw;');
    expect(CXWS_SRC).not.toContain('Number(row?.ts) || Number(row?.at)');
  });
});

// ---------------------------------------------------------------
// S8 — healthMonitor globQuiet exemption
// ---------------------------------------------------------------
describe('v21.23.9 S8 — GLOB-only metals premarket false-alert fix (globQuiet exemption)', () => {
  it('coindcxFutures health entry globQuiet field (connected + glob-only-armed honest derivation) (source pin)', () => {
    expect(HM_SRC).toContain('globQuiet: _cxArmed');
    expect(HM_SRC).toContain('(cx?.domains?.fut || 0) === 0');
  });
  it('ws_stale alert-loop globQuiet skip (false Telegram spam GONE) (source pin)', () => {
    expect(HM_SRC).toContain('if (v?.globQuiet === true) continue;');
  });
});
