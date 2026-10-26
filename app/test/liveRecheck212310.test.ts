// ============================================================
// test/liveRecheck212310.test.ts — v21.23.10 LIVE-MODE RESURRECTION
// ------------------------------------------------------------
// User: "lates github repo ko pull karo aur itne version build aapne codes
// diye hai sab not working hai deep level pe recheck karo issues thik kardo
// live mode pe not working" — builds v21.23.4…v21.23.9 sab.
//
// LIVE-probe (server ko real mode me boot karke) pakde gaye defects ke
// regression locks — tests jo single-tick fixtures me KABHI fail nahi
// hote the kyunki wahan liveExecute hamesha mock hota hai:
//
//  S1  THRASH-CURE   — failed LIVE attempt par escalating per-symbol
//                      backoff (5m→10m→20m…cap 4h); 3 loops (10s probe /
//                      15s recheck / 60s sweep) pehle same reject har ~10s
//                      dohrate the (live-probe: 44 reject events + ~100
//                      journal REJECTED rows minutes me).
//  S2  VOID ROLLBACK — failed attempt ka paper-mirror CLOSE nahi VOID
//                      (46 phantom MANUAL closes, net −₹2,206 poison).
//  S3  LIVE-CLOSE VERDICT — exchange close {ok:false} par book row CLOSED
//                      book NAHI hota (position exchange par khula reh
//                      jata tha jabki UI "closed" dikhata tha).
//  S4  INDIA PARAM   — routes.js `getFreshSignal` → executeIndiaSignal ka
//                      destructure naam `getFreshIndiaSignal` (MTF-auto
//                      India LIVE arm hote hi TypeError = structurally dead).
//  S5  DESK PRE-FLIGHT + probe parity (backoff consult + metals/equitySim rows).
//  S6  DEEP-TICK BOARDSIGS — 15s path (actual entry path) P0 direction
//                      guards bypass karta tha (boardSigs pass nahi hote the).
//  S7  FUTURES HARDENING — fresh-official price gate / meta fallback 60s TTL /
//                      filled aliases / wallet-fail block / honest SL verdict /
//                      UUID rescue / auto-sync scope.
//  S8  SIDE-VOCAB    — 'SELL' silent-LONG-default class (marginOrderBody /
//                      pRoundLadder / futures precheck).
//  S9  STALE AGE GATE — Yahoo 200+day-old intraday series "fresh" vote
//                      karti thi (fetch-time TTL, data-time nahi).
//  S10 SAPTA PARITY  — proTraderGate me dataDegraded check KABHI tha hi nahi.
//  S11 DEAD CONFIG KEYS — markets/liveExecution sanitize par strip.
//  S12 ADOPTED VOL STAMPS — manual/adopted LIVE positions hamesha NORMAL
//                      tight trail par chalti thi.
//  S13 BOARD-ROTATION SNAPSHOT — flip dekhne ke baad row top-6 se nikal
//                      jaye to detection usi tick marta tha.
// ============================================================
import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

process.env.MTF_AUTO_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'mtf-v212310-'));

import {
  mtfAutoTick,
  mtfAutoStatus,
  isLiveAttemptBackoffActive,
  setMtfAutoEnabled,
  updateMtfAutoConfig,
  syncCoinDcxActivePositionsToDeepMonitor,
  __resetMtfAutoForTests,
} from '../server/ai/mtfAutoLink.js';
import { isStaleIntradaySeries } from '../server/ai/mtf.js';
import { proTraderGate } from '../server/ai/proTraderAuto.js';
import { pRoundLadder } from '../server/ai/lib/priceRound.js';
import { isMetalsBase } from '../server/ai/futures.js';

import { fileURLToPath } from 'node:url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const readSrc = (p: string) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const ROUTES_SRC = readSrc('server/ai/routes.js');
const MTF_SRC = readSrc('server/ai/mtf.js');
const SIGNALS_SRC = readSrc('server/ai/signals.js');
const FUTURES_SRC = readSrc('server/ai/futures.js');
const INDIA_ORDERS_SRC = readSrc('server/ai/indiaOrders.js');
const COINDCX_ORDERS_SRC = readSrc('server/ai/coindcxOrders.js');
const STREAM_SRC = readSrc('server/intraday/stream.js');

// ---------- shared fixtures ----------
const mkRow = (over: Record<string, unknown> = {}) => ({
  ok: true,
  symbol: 'SOL',
  market: 'CRYPTO',
  mode: 'INTRADAY',
  label: '15m + 5m',
  holdMin: 45,
  side: 'LONG',
  dir: 1,
  superScore: 92,
  tier: 'ELITE',
  autoEligible: true,
  autoBlockers: [],
  tfFit: 'GOOD',
  dualAligned: true,
  triggerFired: true,
  directionVerified: true,
  counterTrend: false,
  grade: 'A',
  costR: 0.1,
  plan: { entry: 150, stopLoss: 147, t1: 154.5, t2: 159 },
  ltp: 150,
  ...over,
});
const mkBoards = (rows: any[]) => ({ CRYPTO: { ok: true, rows } });
const mkPaper = () => {
  const calls = { open: [] as any[], close: [] as any[], void: [] as any[] };
  return {
    calls,
    paper: {
      getPaperSummary: () => ({ open: [], closedToday: [] }),
      openPaperTrade: (input: any) => { calls.open.push(input); return { ok: true, trade: { id: 900 + calls.open.length } }; },
      closePaperTrade: (id: any, q: any) => { calls.close.push({ id, q }); return { ok: true }; },
      voidPaperTrade: (id: any) => { calls.void.push(id); return { ok: true, voided: true }; },
    },
  };
};

beforeEach(() => {
  __resetMtfAutoForTests();
  setMtfAutoEnabled(true);
  updateMtfAutoConfig({ executionMode: 'live', desks: { crypto: true, india: false } });
});

// ---------------------------------------------------------------
// S1 — THRASH-CURE: failed-LIVE-attempt escalating backoff
// ---------------------------------------------------------------
describe('v21.23.10 S1 — failed LIVE attempt → escalating per-symbol backoff (thrash cure)', () => {
  it('attempt #1 reject: live-skip event + backoff stamped (isLiveAttemptBackoffActive true)', async () => {
    const hp = mkPaper();
    const t0 = Date.now();
    const out = await mtfAutoTick({
      now: t0,
      boards: mkBoards([mkRow()]),
      paper: hp.paper,
      quotes: { SOL: { price: 150 } },
      walletEquityINR: 10000,
      siteLiveActive: true,
      liveExecute: async () => ({ ok: false, error: 'CoinDCX API key & secret not connected' }),
    });
    expect(out.opened).toHaveLength(0);
    expect(out.skipped.join(' ')).toContain('live order not executed');
    expect(isLiveAttemptBackoffActive('SOL', t0 + 1000)).toBe(true);
    const st = mtfAutoStatus();
    expect(st.events.some((e: any) => e.kind === 'live-backoff')).toBe(true);
  });

  it('immediate re-tick: backoff blocker → liveExecute DOBARA call NAHI hota', async () => {
    const hp = mkPaper();
    const liveExecute = vi.fn(async () => ({ ok: false, error: 'exchange rejected' }));
    const t0 = Date.now();
    await mtfAutoTick({ now: t0, boards: mkBoards([mkRow()]), paper: hp.paper, quotes: { SOL: { price: 150 } }, siteLiveActive: true, liveExecute });
    expect(liveExecute).toHaveBeenCalledTimes(1);
    const out2 = await mtfAutoTick({ now: t0 + 20_000, boards: mkBoards([mkRow()]), paper: hp.paper, quotes: { SOL: { price: 150 } }, siteLiveActive: true, liveExecute });
    expect(liveExecute).toHaveBeenCalledTimes(1); // backoff — no second attempt
    expect(isLiveAttemptBackoffActive('SOL', t0 + 20_000)).toBe(true); // blocker active (candidates pool gate) — naya attempt sirf backoff window expiry ke baad
  });

  it('escalation: 5m window ke BAAD attempt #2 → count 2 → ab 10m window (2× backoff)', async () => {
    const hp = mkPaper();
    const liveExecute = vi.fn(async () => ({ ok: false, error: 'exchange rejected' }));
    const t0 = Date.now();
    await mtfAutoTick({ now: t0, boards: mkBoards([mkRow()]), paper: hp.paper, quotes: { SOL: { price: 150 } }, siteLiveActive: true, liveExecute });
    // +5m1s: backoff #1 expired → attempt #2 allowed
    await mtfAutoTick({ now: t0 + 5 * 60_000 + 1000, boards: mkBoards([mkRow()]), paper: hp.paper, quotes: { SOL: { price: 150 } }, siteLiveActive: true, liveExecute });
    expect(liveExecute).toHaveBeenCalledTimes(2);
    // +5m more (total 10m from #2? nahi — #2 se 5m): count-2 window 10m hai isliye abhi blocked
    expect(isLiveAttemptBackoffActive('SOL', t0 + 10 * 60_000 + 2000)).toBe(true);
    // count-2 ke 10m BAAD hi attempt #3
    await mtfAutoTick({ now: t0 + 5 * 60_000 + 1000 + 10 * 60_000 + 2000, boards: mkBoards([mkRow()]), paper: hp.paper, quotes: { SOL: { price: 150 } }, siteLiveActive: true, liveExecute });
    expect(liveExecute).toHaveBeenCalledTimes(3);
  });

  it('in-flight transient lock backoff NAHI lagata (concurrent attempt tha, failure nahi)', async () => {
    const hp = mkPaper();
    const t0 = Date.now();
    await mtfAutoTick({
      now: t0, boards: mkBoards([mkRow()]), paper: hp.paper, quotes: { SOL: { price: 150 } }, siteLiveActive: true,
      liveExecute: async () => ({ ok: false, inFlight: true, error: '1 session = 1 trade lock' }),
    });
    expect(isLiveAttemptBackoffActive('SOL', t0 + 1000)).toBe(false);
  });

  it('SUCCESS kabhi backoff nahi lagata', async () => {
    const hp = mkPaper();
    const t0 = Date.now();
    const out = await mtfAutoTick({
      now: t0, boards: mkBoards([mkRow()]), paper: hp.paper, quotes: { SOL: { price: 150 } }, siteLiveActive: true,
      liveExecute: async () => ({ ok: true, orderId: 'o1', position: { exchangePositionId: 'p1' }, filled: { qty: 2, price: 150, stopLoss: 147, t1: 154.5, t2: 159 } }),
    });
    expect(out.opened).toHaveLength(1);
    expect(isLiveAttemptBackoffActive('SOL', t0 + 1000)).toBe(false);
  });
});

// ---------------------------------------------------------------
// S2 — VOID rollback (phantom paper trade cure)
// ---------------------------------------------------------------
describe('v21.23.10 S2 — failed LIVE attempt ka paper-mirror VOID hota hai (CLOSE nahi)', () => {
  it('reject par voidPaperTrade(tradeId) call hota hai, closePaperTrade KABHI nahi', async () => {
    const hp = mkPaper(); const calls = hp.calls;
    await mtfAutoTick({
      boards: mkBoards([mkRow()]), paper: hp.paper, quotes: { SOL: { price: 150 } }, siteLiveActive: true,
      liveExecute: async () => ({ ok: false, error: 'exchange rejected' }),
    });
    expect(calls.open).toHaveLength(1);       // optimistic mirror khula
    expect(calls.void).toHaveLength(1);        // rollback = VOID
    expect(calls.void[0]).toBe(901);
    expect(calls.close).toHaveLength(0);       // MANUAL close poison GONE
  });
});

// ---------------------------------------------------------------
// S3 — LIVE close verdict (book CLOSED sirf confirmed close par)
// ---------------------------------------------------------------
describe('v21.23.10 S3 — exchange close verdict check (fabricated CLOSE cure)', () => {
  const seedOpenLive = (now: number, over: Record<string, unknown> = {}) => __resetMtfAutoForTests({
    state: {
      day: 'seed',
      book: [{
        paperId: 55, liveOrderId: 'lo1', livePositionId: 'pos-1', pair: 'B-SOL_USDT',
        executionMode: 'LIVE', traded: true, fullControl: true, openedInLiveMode: true,
        symbol: 'SOL', market: 'CRYPTO', execMarket: 'FUTURES', ccy: 'USDT',
        side: 'LONG', score: 92, tier: 'ELITE', mode: 'INTRADAY', holdMin: 45,
        entry: 150, ltp: 150, stopLoss: 147, initialStopLoss: 147, trailedStopLoss: 147, peakPrice: 155,
        t1: 154.5, t2: 159, qty: 2, leverage: 5, walletINR: 10000,
        atrPct: 1.0, volClass: 'NORMAL', t1ClosePct: 0.5,
        openedAt: now - 3600_000, dayKey: 'seed', status: 'OPEN',
      }],
    },
  });

  const flipBoard = () => mkBoards([mkRow({ symbol: 'SOL', side: 'SHORT', dir: -1, superScore: 88, triggerFired: true })]);
  const usdtQ = (px: number) => new Map([['SOL', px]]);

  it('liveClose {ok:false} → book row OPEN rehta hai + syncError + live-close-failed event', async () => {
    const now = Date.now();
    seedOpenLive(now);
    setMtfAutoEnabled(true);
    updateMtfAutoConfig({ executionMode: 'live', desks: { crypto: true, india: false } });
    const hp = mkPaper();
    const out = await mtfAutoTick({
      boards: flipBoard(), paper: hp.paper,
      usdtQuotes: usdtQ(149.2),
      siteLiveActive: true,
      liveClose: async () => ({ ok: false, error: '401 Invalid credentials' }),
      liveUpdateSl: async () => ({ ok: true }),
    });
    const st = mtfAutoStatus();
    const row = (st.book || []).find((b: any) => b.symbol === 'SOL');
    expect(row?.status).toBe('OPEN'); // fabricated CLOSE gaya
    expect(String(row?.syncError || '')).toContain('401');
    expect(st.events.some((e: any) => e.kind === 'live-close-failed')).toBe(true);
    expect(out.closed).toHaveLength(0);
  });

  it('liveClose {ok:true} → honest CLOSED + UC_FLIP_MINIMAL_LOSS_EXIT reason', async () => {
    const now = Date.now();
    seedOpenLive(now);
    setMtfAutoEnabled(true);
    updateMtfAutoConfig({ executionMode: 'live', desks: { crypto: true, india: false } });
    const hp = mkPaper();
    const out = await mtfAutoTick({
      boards: flipBoard(), paper: hp.paper,
      usdtQuotes: usdtQ(149.2),
      siteLiveActive: true,
      liveClose: async () => ({ ok: true }),
      liveUpdateSl: async () => ({ ok: true }),
    });
    const st = mtfAutoStatus();
    const row = (st.book || []).find((b: any) => b.symbol === 'SOL');
    expect(row?.status).toBe('CLOSED');
    expect(row?.closeReason).toBe('UC_FLIP_MINIMAL_LOSS_EXIT');
    expect(out.closed).toHaveLength(1);
  });

  it('liveClose undefined (legacy stub contract) → permissive close (backward-compat)', async () => {
    const now = Date.now();
    seedOpenLive(now);
    setMtfAutoEnabled(true);
    updateMtfAutoConfig({ executionMode: 'live', desks: { crypto: true, india: false } });
    const hp = mkPaper();
    const out = await mtfAutoTick({
      boards: flipBoard(), paper: hp.paper,
      usdtQuotes: usdtQ(149.2),
      siteLiveActive: true,
      liveClose: async () => undefined,
      liveUpdateSl: async () => ({ ok: true }),
    });
    const st = mtfAutoStatus();
    const row = (st.book || []).find((b: any) => b.symbol === 'SOL');
    expect(row?.status).toBe('CLOSED');
    expect(out.closed).toHaveLength(1);
  });
});

// ---------------------------------------------------------------
// S4 — India param-name fix (CRITICAL: MTF-auto India LIVE structurally dead tha)
// ---------------------------------------------------------------
describe('v21.23.10 S4 — executeIndiaSignal wiring: getFreshIndiaSignal + pre-flight + honest source', () => {
  it('dono MTF routes call-sites ab `getFreshIndiaSignal:` pass karte hain (executeIndiaSignal ka destructure naam)', () => {
    // v21.23.12 HONEST PIN UPDATE: v21.23.10 ka "fix" sirf PARAM KA NAAM theek
    // karta tha — function getFreshSignalForExec(pairOrSymbol, deps, opts) me
    // market param HAI HI NAHI tha: 'INDIA' string deps-slot me, real deps
    // opts-slot me, market hardcoded 'CRYPTO' → India MTF live STRUCTURALLY
    // dead hi rehta tha (yahi pin us buggy wiring ko lock kar raha tha).
    // Ab correct pattern: getDeepSignal(sym,'INDIA',deps) — routes.js:2020 /
    // indiaAgent.js:853 jaisa. Arity-disease string repo me kabhi nahi.
    expect(ROUTES_SRC).not.toContain("getFreshSignalForExec(sym, 'INDIA'");
    // TEENO wrapper blocks ab SAME correct async getDeepSignal(sym,'INDIA',…)
    // shape me: 2 naye (mtf-board-live-ui + mtf-auto-india) + 1 pehla-se-sahi
    // manual /india/execute path — ab sab identical wiring.
    expect((ROUTES_SRC.match(/getFreshIndiaSignal: async \(sym\) =>/g) || []).length).toBe(3);
  });
  it('purana galat naam `getFreshSignal:` India exec calls se GONE', () => {
    expect(ROUTES_SRC).not.toContain("getFreshSignal: (sym, o) => getFreshSignalForExec(sym, 'INDIA'");
  });
  it('desk pre-flight: India un-armed → honest blocked verdict (gauntlet spam se pehle)', () => {
    expect(ROUTES_SRC).toContain("if (tcfg.indiaMode !== 'live')");
    expect(ROUTES_SRC).toContain('India LIVE mode is not armed');
  });
  it('desk pre-flight: crypto creds absent → honest blocked verdict', () => {
    expect(ROUTES_SRC).toContain('if (!hasEnvOrSavedCreds)');
    expect(ROUTES_SRC).toContain('CoinDCX API key & secret not connected');
  });
  it('honest source tag: mtf-auto India attempts ab mtf-auto-india (india-agent misattribution GONE)', () => {
    expect(ROUTES_SRC).toContain("source: 'mtf-auto-india'");
  });
  it('indiaOrders.js reject dedup: identical consecutive reject journal me naya row NAHI (repeat-count update)', () => {
    expect(INDIA_ORDERS_SRC).toContain('__repeatCount');
    expect(INDIA_ORDERS_SRC).toContain('5 * 60_000');
  });
});

// ---------------------------------------------------------------
// S5 — probe parity: backoff consult + metals/equitySim rows
// ---------------------------------------------------------------
describe('v21.23.10 S5 — fastEntryProbeLoop parity (backoff + metals/equitySim rows)', () => {
  it('probe backoff-me symbols par free escalation nahi karta', () => {
    expect(ROUTES_SRC).toContain('!isLiveAttemptBackoffActive(r.symbol)');
  });
  it('probe ab metalsRows + equitySimRows bhi scan karta hai (pehle sirf bd.rows)', () => {
    expect(ROUTES_SRC).toContain('...(Array.isArray(bd?.metalsRows) ? bd.metalsRows : [])');
    expect(ROUTES_SRC).toContain('...(Array.isArray(bd?.equitySimRows) ? bd.equitySimRows : [])');
  });
});

// ---------------------------------------------------------------
// S6 — deep-tick boardSigs parity (P0 direction guards fastest path par)
// ---------------------------------------------------------------
describe('v21.23.10 S6 — 15s deep-tick board ab boardSigs ke saath banta hai', () => {
  it('deep tick getDualMtfBoard call me boardSigs pass hota hai (60s loop jaisa; v21.25.3: canonical desk merge)', () => {
    expect(ROUTES_SRC).toContain("const boardSigs = await boardSignalsForDesk(market, depsForSignals());\n          boards[market] = await getDualMtfBoard({ market, mode: cfg.mode, holdMin: cfg.holdMin, minScore: cfg.minScore, boardSigs, fx: fxLive }).catch(() => null);");
  });
});

// ---------------------------------------------------------------
// S7 — futures.js live-order hardening
// ---------------------------------------------------------------
describe('v21.23.10 S7 — executeMtfDualLiveOrder hardening (fresh price / meta TTL / aliases / wallet gate / SL sync)', () => {
  it('fresh-official price gate: stale (>30s) ya Binance/Bybit synth row livePx ban sakta hai hi nahi', () => {
    expect(FUTURES_SRC).toContain('const freshOfficial = rowTs > 0 && Date.now() - rowTs <= 30_000 && !/binance|bybit/i.test(rowSrc);');
    expect(FUTURES_SRC).toContain('if (!freshOfficial) livePx = null;');
  });
  it('instrument-meta fallback ab sirf 60s cache (6h poison GONE) + bust re-fetch', () => {
    expect(FUTURES_SRC).toContain('hit._fallback ? 60_000 : 6 * 3600_000');
    expect(FUTURES_SRC).toContain('fetchFuturesInstrumentMeta(pair, { bust: true })');
    expect(FUTURES_SRC).toContain("String(meta.status) !== 'active'");
  });
  it('filled contract aliases: walletDeployINR + buyingPowerINR producer-side guaranteed (teeno return sites)', () => {
    expect((FUTURES_SRC.match(/walletDeployINR: deployedWalletINR,/g) || []).length).toBe(3);
    expect((FUTURES_SRC.match(/buyingPowerINR: Math\.round\(Number\(deployedWalletINR\) \* Number\(lev \|\| leverage \|\| 1\)\),/g) || []).length).toBe(3);
  });
  it('wallet-read FAILURE par live order block (₹8000 guess + 14 wasted POSTs GONE)', () => {
    expect(FUTURES_SRC).toContain("error: 'futures wallet read failed'");
    expect(FUTURES_SRC).toContain('futures wallet read failed — order blocked');
  });
  it('updateCoinDcxPositionSl honest verdict: journal-only update ab ok:false (lastExchangeSl galat stamp GONE)', () => {
    expect(FUTURES_SRC).toContain('journalOnly: true');
    expect(FUTURES_SRC).toContain('exchange position id not resolvable — journal updated only');
  });
  it('UUID rescue: failed id par pair-based re-resolve + retry (SL sync + close dono)', () => {
    expect((FUTURES_SRC.match(/const exchList = await listFuturesPositions\(\)\.catch\(\(\) => \[\]\);\n      const row = exchList\.find\(p => p\.pair === normPair && p\.activePos !== 0\);\n      if \(row\?\.id && String\(row\.id\) !== String\(exchPosId\)\)/g) || []).length).toBe(2);
  });
  it('global mode-live auto-sync ab sirf MANUAL board clicks ke liye (auto engine silent global flip GONE)', () => {
    expect(FUTURES_SRC).toContain("source !== 'mtf-auto-live'");
  });
});

// ---------------------------------------------------------------
// S8 — side-vocabulary class fixes
// ---------------------------------------------------------------
describe('v21.23.10 S8 — SELL/BUY vocabulary (silent-LONG-default class GONE)', () => {
  it('pRoundLadder: SELL === SHORT behaviour (unit)', () => {
    const sell = pRoundLadder({ side: 'SELL', entry: 100, stopLoss: 102, targets: [96, 94] });
    const short = pRoundLadder({ side: 'SHORT', entry: 100, stopLoss: 102, targets: [96, 94] });
    expect(sell).toEqual(short); // pehle 'SELL' ulta LONG ladder banata tha
    const buy = pRoundLadder({ side: 'BUY', entry: 100, stopLoss: 98, targets: [104, 106] });
    const long = pRoundLadder({ side: 'LONG', entry: 100, stopLoss: 98, targets: [104, 106] });
    expect(buy).toEqual(long);
  });
  it('marginOrderBody dual-vocabulary + unknown-side throw (source pin)', () => {
    expect(COINDCX_ORDERS_SRC).toContain("const long = s === 'LONG' || s === 'BUY';");
    expect(COINDCX_ORDERS_SRC).toContain('marginOrderBody: invalid side');
    expect(COINDCX_ORDERS_SRC).not.toContain("String(side).toUpperCase() !== 'SHORT'");
  });
  it('futures precheck liquidation estimate SELL/SHORT dono samajhta hai (source pin)', () => {
    expect(FUTURES_SRC).toContain("!['SHORT', 'SELL'].includes(String(signal.side || '').toUpperCase())");
  });
});

// ---------------------------------------------------------------
// S9 — stale-data age gate
// ---------------------------------------------------------------
describe('v21.23.10 S9 — isStaleIntradaySeries (Yahoo stale-200 age gate)', () => {
  const now = 1_800_000_000_000;
  const bars = (lastBarAt: number) => Array.from({ length: 60 }, (_, i) => ({ time: lastBarAt - (59 - i) * 900_000, close: 1 }));
  it('NSE-open me day-old 15m series = STALE (1456-min live-probe case)', () => {
    expect(isStaleIntradaySeries(bars(now - 1456 * 60_000), '15m', { sessionOpen: true, now })).toBe(true);
  });
  it('fresh last bar = NOT stale', () => {
    expect(isStaleIntradaySeries(bars(now - 5 * 60_000), '15m', { sessionOpen: true, now })).toBe(false);
  });
  it('session closed → gate inert (purani session LEGITIMATE)', () => {
    expect(isStaleIntradaySeries(bars(now - 1456 * 60_000), '15m', { sessionOpen: false, now })).toBe(false);
  });
  it('daily bars exempt (by-definition stale)', () => {
    expect(isStaleIntradaySeries(bars(now - 3 * 86_400_000), '1d', { sessionOpen: true, now })).toBe(false);
  });
  it('mtf.js + signals.js dono is gate se wired hain', () => {
    expect(MTF_SRC).toContain('isStaleIntradaySeries(out, tf, { sessionOpen: isNseOpen() })');
    expect(SIGNALS_SRC).toContain("isStaleIntradaySeries(out, '15m', { sessionOpen: isNseOpen() })");
  });
  it('mtf.js null-payload 60s mini-TTL (1d-TTL null poison GONE)', () => {
    expect(MTF_SRC).toContain('hit.payload == null ? 60_000 : ttl');
  });
});

// ---------------------------------------------------------------
// S10 — SAPTA dataDegraded parity
// ---------------------------------------------------------------
describe('v21.23.10 S10 — proTraderGate dataDegraded block (v21.23.4 parity)', () => {
  const baseSig: Record<string, unknown> = {
    symbol: 'RELIANCE', market: 'INDIA', side: 'LONG', grade: 'STRONG',
    plan: { entry: 100, stopLoss: 95 }, superIntel: { aiScore: 85 }, confidence: 80,
    verify: { score: 75, action: 'CONFIRM', finalCall: 'LONG' },
    executable: false,
  };
  it('dataDegraded signal SAPTA gate par BLOCKED (pehle ek engine par banned, dusre par tradable)', () => {
    const g = proTraderGate({ ...baseSig, dataDegraded: 'FRESH-TAPE-ABSENT' } as any);
    expect(g.pass).toBe(false);
    expect(g.reasons.join(' ')).toContain('data-degraded:FRESH-TAPE-ABSENT');
  });
  it('control: same signal bina dataDegraded ke pass hota hai (regression-free)', () => {
    const g = proTraderGate({ ...baseSig } as any);
    expect(g.pass).toBe(true);
  });
});

// ---------------------------------------------------------------
// S11 — dead config keys strip
// ---------------------------------------------------------------
describe('v21.23.10 S11 — _sanitizeCfg allowlist (markets/liveExecution dead keys GONE)', () => {
  it('updateMtfAutoConfig dead keys persist NAHI karta', () => {
    const cfg = updateMtfAutoConfig({ minScore: 75, markets: ['CRYPTO'], liveExecution: true } as any);
    expect((cfg as any).markets).toBeUndefined();
    expect((cfg as any).liveExecution).toBeUndefined();
    expect(cfg.minScore).toBe(75);
  });
  it('allowlist pin: sanitize sirf MTF_AUTO_DEFAULTS keys se build hota hai', () => {
    const MTF_LINK_SRC = readSrc('server/ai/mtfAutoLink.js');
    expect(MTF_LINK_SRC).toContain('for (const k of Object.keys(MTF_AUTO_DEFAULTS)) out[k] = cfg[k];');
  });
});

// ---------------------------------------------------------------
// S12 — adopted position vol stamps
// ---------------------------------------------------------------
describe('v21.23.10 S12 — adopted CoinDCX positions par vol-class stamps (NORMAL-forever cure)', () => {
  it('sync adoption rec me atrPct/volClass/t1ClosePct stamped (SL-distance proxy se)', () => {
    const out = syncCoinDcxActivePositionsToDeepMonitor([
      {
        id: 'cdx-pos-xau-1', positionId: 'cdx-pos-xau-1', pair: 'B-XAU_USDT', symbol: 'XAU',
        side: 'LONG', activePos: 2, avgPrice: 2650, entryPrice: 2650, leverage: 5,
        sl: 2618, openedAt: Date.now() - 600_000,
      },
    ], { authoritativeExchangeList: false });
    expect(out.synced.length).toBe(1);
    const rec = out.synced[0] as any;
    expect(Number(rec.atrPct)).toBeGreaterThan(0);
    expect(rec.volClass).toBeTruthy();
    expect(Number(rec.t1ClosePct)).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------
// S13 — board-rotation snapshot (flip detection zinda)
// ---------------------------------------------------------------
describe('v21.23.10 S13 — board-rotation snapshot: flip detection zinda', () => {
  const usdtQ = (px: number) => new Map([['SOL', px]]);
  const seedLive = (t0: number) => __resetMtfAutoForTests({
    state: {
      day: 'seed',
      book: [{
        paperId: 55, liveOrderId: 'lo1', livePositionId: 'pos-1', pair: 'B-SOL_USDT',
        executionMode: 'LIVE', traded: true, fullControl: true, openedInLiveMode: true,
        symbol: 'SOL', market: 'CRYPTO', execMarket: 'FUTURES', ccy: 'USDT',
        side: 'LONG', score: 92, tier: 'ELITE', mode: 'INTRADAY', holdMin: 45,
        entry: 150, ltp: 150, stopLoss: 147, initialStopLoss: 147, trailedStopLoss: 147, peakPrice: 151,
        t1: 154.5, t2: 159, qty: 2, leverage: 5, walletINR: 10000,
        atrPct: 1.0, volClass: 'NORMAL', t1ClosePct: 0.5,
        openedAt: t0 - 3600_000, dayKey: 'seed', status: 'OPEN',
      }],
    },
  });
  const flipRow = () => mkBoards([mkRow({ symbol: 'SOL', side: 'SHORT', dir: -1, superScore: 88, triggerFired: true })]);

  it('row ABSENT + snapshot ABSENT → NO exit (false-flip se honest bachav)', async () => {
    const t0 = Date.now();
    seedLive(t0);
    setMtfAutoEnabled(true);
    updateMtfAutoConfig({ executionMode: 'live', desks: { crypto: true, india: false } });
    const hp = mkPaper();
    const out = await mtfAutoTick({
      now: t0, boards: mkBoards([]), paper: hp.paper,
      usdtQuotes: usdtQ(149.0), siteLiveActive: true,
      liveClose: async () => ({ ok: true }), liveUpdateSl: async () => ({ ok: true }),
    });
    expect(out.closed).toHaveLength(0);
  });

  it('row PRESENT (flip) → snapshot stored + exit fires (normal path control)', async () => {
    const t0 = Date.now();
    seedLive(t0);
    setMtfAutoEnabled(true);
    updateMtfAutoConfig({ executionMode: 'live', desks: { crypto: true, india: false } });
    const hp = mkPaper();
    const out = await mtfAutoTick({
      now: t0, boards: flipRow(), paper: hp.paper,
      usdtQuotes: usdtQ(149.0), siteLiveActive: true,
      liveClose: async () => ({ ok: true }), liveUpdateSl: async () => ({ ok: true }),
    });
    expect(out.closed).toHaveLength(1);
    expect(out.closed[0]?.reason).toBe('UC_FLIP_MINIMAL_LOSS_EXIT');
  });

  it('ROW ROTATED OUT (top-6 se bahar) + fresh snapshot (≤120s) → flip detection SNAPSHOT se zinda — exit FIRE', async () => {
    const t0 = Date.now();
    // step 1: flipped row dekho (grace-se-pehle kabhi NAHI — seed trade 1h purana hai,
    // exit turant fire hoga isliye snapshot-store step ke liye SAME-SIDE row dikhao)
    seedLive(t0);
    setMtfAutoEnabled(true);
    updateMtfAutoConfig({ executionMode: 'live', desks: { crypto: true, india: false } });
    const hp = mkPaper();
    const outA = await mtfAutoTick({
      now: t0, boards: flipRow(), paper: hp.paper,
      usdtQuotes: usdtQ(149.0), siteLiveActive: true,
      // liveClose FAIL — exit fire hua par exchange close nahi hua (verdict fix!)
      // → row OPEN rehta hai + snapshot (SHORT flipped row) stored
      liveClose: async () => ({ ok: false, error: 'network blip' }), liveUpdateSl: async () => ({ ok: true }),
    });
    expect(outA.closed).toHaveLength(0); // verdict fix: close fail → book OPEN
    // step 2: row ab board se GAYA (rotation) — sirf snapshot bacha hai
    const outB = await mtfAutoTick({
      now: t0 + 60_000, boards: mkBoards([]), paper: hp.paper,
      usdtQuotes: usdtQ(148.8), siteLiveActive: true,
      liveClose: async () => ({ ok: true }), liveUpdateSl: async () => ({ ok: true }),
    });
    expect(outB.closed).toHaveLength(1); // SNAPSHOT se flip exit
    expect(outB.closed[0]?.reason).toBe('UC_FLIP_MINIMAL_LOSS_EXIT');
    const st = mtfAutoStatus();
    expect(st.events.some((e: any) => e.kind === 'flip-exit')).toBe(true);
  });

  it('snapshot EXPIRED (>120s) → detection band (stale flip se false exit nahi)', async () => {
    const t0 = Date.now();
    seedLive(t0);
    setMtfAutoEnabled(true);
    updateMtfAutoConfig({ executionMode: 'live', desks: { crypto: true, india: false } });
    const hp = mkPaper();
    await mtfAutoTick({
      now: t0, boards: flipRow(), paper: hp.paper,
      usdtQuotes: usdtQ(149.0), siteLiveActive: true,
      liveClose: async () => ({ ok: false, error: 'network blip' }), liveUpdateSl: async () => ({ ok: true }),
    });
    const outB = await mtfAutoTick({
      now: t0 + 130_000, boards: mkBoards([]), paper: hp.paper,
      usdtQuotes: usdtQ(148.8), siteLiveActive: true,
      liveClose: async () => ({ ok: true }), liveUpdateSl: async () => ({ ok: true }),
    });
    expect(outB.closed).toHaveLength(0); // TTL khatam — honest no-data no-flip
  });
});

// ---------------------------------------------------------------
// S14 — stream.js metals quotes + misc wiring pins
// ---------------------------------------------------------------
describe('v21.23.10 S14 — metals quote leg + misc', () => {
  it('isMetalsBase XAU/XAG (control)', () => {
    expect(isMetalsBase('XAU')).toBe(true);
    expect(isMetalsBase('XAG')).toBe(true);
    expect(isMetalsBase('BTC')).toBe(false);
  });
  it('stream.js futures bucket me metals quotes fill (manual metals paper trades SL/T1/T2 evaluation freeze cure)', () => {
    expect(STREAM_SRC).toContain('fetchMetalsPrices()');
    expect(STREAM_SRC).toContain('futMod.isMetalsBase(s)');
  });
  it('mtf.js metals candle chain wired (rawTfCandlesUsdt Leg-1.5 + _candlesFor METALS + _metalsCandlesFor)', () => {
    expect(MTF_SRC).toContain('src: \'binance-fapi-metals\'');
    expect(MTF_SRC).toContain('src: \'yahoo-comex-metals\'');
    expect(MTF_SRC).toContain('if (market === \'METALS\') {');
    expect(MTF_SRC).toContain('async function _metalsCandlesFor(base, tf)');
  });
  it('routes.js fastSlTrailLoop takeProfit ab HAMESHA t2 (TP-LADDER FIX — full-close-at-T1 disease)', () => {
    expect(ROUTES_SRC).toContain('takeProfit: tr.t2,');
    expect(ROUTES_SRC).not.toContain('takeProfit: tr.tp1Hit ? tr.t2 : tr.t1');
  });
  it('voidPaperTrade paper engine me exported (quote-free rollback)', () => {
    const PAPER_SRC = readSrc('server/intraday/paperTrading.js');
    expect(PAPER_SRC).toContain('export function voidPaperTrade(id)');
    expect(ROUTES_SRC).toContain('voidPaperTrade as voidPaperTradeExec');
    expect(ROUTES_SRC).toContain('voidPaperTrade: voidPaperTradeExec');
  });
});
