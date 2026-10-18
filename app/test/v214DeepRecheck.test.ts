// ============================================================
// test/v214DeepRecheck.test.ts — v21.4.1 DEEP-RECHECK REGRESSION LOCKS
// ------------------------------------------------------------
// Full-site line-by-line recheck se nikale CONFIRMED bugs ke locks:
//   [A1] ADX object-shape normalize (board chop ADX<15 leg dead tha)
//   [A2] final board aggregation revived-vote rediscount
//   [A4] deep-path ctx.__tv null guards
//   [A5] deep-path HARD HTF VETO + CHOP + score cap 62 (source contract)
//   [B1] expertPicks ADX trend leg + chop cap (object shape)
//   [B2] qualityVerdict quorumExempt (expert picks −25 blanket penalty)
//   [B4] trackRecord market-scoped dedup/flip (CRYPTO × FUTURES collision)
//   [B5] sub-cent exit/risk rounding (SHIB/PEPE class fake full-loss)
//   [B6] boardAiConfirm +2 chop-cap clamp (80+ re-cross ban)
//   [B7] evaluateTracked market-qualified quotes
//   [C3] futures precheck live-mode parity + leverage gate (source)
// ============================================================
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// hermetic data dir (same trick as v213)
process.env.SMARTAI_DATA_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '../.test-data-v214');

import { readAdxNum } from '../server/ai/signals.js';
import { qualityVerdict } from '../server/ai/probrain.js';
import { expertScoreFactors } from '../server/ai/expertPicks.js';
import {
  confirmBoardSignals, __resetBoardAiConfirmForTests, __setProvidersForTests,
} from '../server/ai/boardAiConfirm.js';
import {
  recordSignals, watcherSymbolsByMarket, evaluateTracked, getTrackRecord,
  flushTrackRecordState, __resetFlipGuardForTests,
} from '../server/intraday/trackRecord.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const readSrc = (p) => fs.readFileSync(path.join(__dirname, p), 'utf8');

// ---------------- fixtures ----------------
function strongBoardSignal(over = {}) {
  return {
    symbol: 'BTC', market: 'FUTURES', side: 'LONG', grade: 'STRONG',
    confidence: 80, agreement: 0.75, ltp: 50000, changePct: 2.1,
    plan: { entry: 50000, stopLoss: 48000, target1: 52000, target2: 54000, risk: 2000, riskPct: 4, rewardRisk: 2 },
    quality: { regime: { counterTrend: false }, mtf: { available: true, aligned: true, phase: 'TREND-ALIGNED', agreementPct: 78 } },
    superIntel: { aiScore: 84, tier: 'STRONG' },
    votes: Array.from({ length: 6 }, (_, i) => ({ id: `v${i}`, name: `M${i}`, dir: 1, conf: 70, weight: 1, reasons: ['r'] })),
    summary: 'consensus LONG',
    ...over,
  };
}

const trackedSig = (over = {}) => ({
  symbol: 'BTC', market: 'CRYPTO', direction: 'LONG',
  entry: 8600000, stopLoss: 8550000, target1: 8700000, target2: 8800000,
  ltp: 8600000, confidence: 80, qtyPerLakh: 2,
  ...over,
});

// ============================================================
// [A1] readAdxNum — number | object | string | null normalizer
// ============================================================
describe('v21.4.1 [A1] — readAdxNum (ADX object-shape fix)', () => {
  it('reads the NUMBER form (TV rows)', () => {
    expect(readAdxNum(12.3)).toBe(12.3);
    expect(readAdxNum(0)).toBe(0);
    expect(readAdxNum(-5)).toBe(-5);
  });
  it('reads the OBJECT form ({adx, plusDI, minusDI}) — the shape every desk actually sends', () => {
    expect(readAdxNum({ adx: 12.3, plusDI: 25, minusDI: 10 })).toBe(12.3);
    expect(readAdxNum({ adx: '14.8' })).toBe(14.8);
    expect(readAdxNum({ adx: 0 })).toBe(0);
  });
  it('reads the STRING form', () => {
    expect(readAdxNum('12.3')).toBe(12.3);
  });
  it('null/undefined/NaN/garbage → null (honest degrade, kabhi 0 nahi)', () => {
    expect(readAdxNum(null)).toBeNull();
    expect(readAdxNum(undefined)).toBeNull();
    expect(readAdxNum({})).toBeNull();
    expect(readAdxNum({ adx: NaN })).toBeNull();
    expect(readAdxNum('[object Object]')).toBeNull();
    expect(readAdxNum({ plusDI: 25 })).toBeNull(); // adx field hi nahi
  });
  it('the OLD bug repro: parseFloat(String(object)) gave NaN — object < 15 never fired', () => {
    // v21.3.0 code: parseFloat(String({adx:9})) → NaN → adxNow null → chop dead
    const oldRead = (v) => { const n = typeof v === 'number' ? v : parseFloat(String(v ?? '')); return Number.isFinite(n) ? n : null; };
    expect(oldRead({ adx: 9 })).toBeNull();   // the bug
    expect(readAdxNum({ adx: 9 })).toBe(9);   // the fix
  });
});

// ============================================================
// [A2/A4/A5] signals.js source contracts (board rediscount + deep veto)
// ============================================================
describe('v21.4.1 [A2/A4/A5] — signals.js deep-path + board contracts', () => {
  const src = readSrc('../server/ai/signals.js');

  it('[A2] FINAL board aggregation wraps votes with _rediscountRevivedVotes (tape seat correlation discount)', () => {
    expect(src).toContain('aggregateVotesWithMeta(_rediscountRevivedVotes(votes)');
  });

  it('[A4] deep FUTURES/CRYPTO branches null-guard ctx.__tv (500-crash ban)', () => {
    expect(src).toContain('if (ctx && tv?.[sym]) ctx.__tv = tv[sym];');
  });

  it('[A5] deep mtf6 block carries the HARD HTF VETO + CHOP + executable=false + cap 62', () => {
    expect(src).toContain('counterHtfHitD');               // veto computed on the deep path
    expect(src).toContain('chopHitD');                      // chop leg on the deep path
    expect(src).toContain('_deepScoreCap = 62');           // superIntel cap thread
    expect(src).toContain('cap: _deepScoreCap');            // ...passed to computeSuperScore
    expect(src).toMatch(/built\.executable = false; \/\/ v21\.4\.1: demote ke baad kabhi executable nahi/);
  });

  it('[A1 wiring] board chop filter reads through readAdxNum (object-safe)', () => {
    expect(src).toContain('readAdxNum(c.ctx.ind?.adx)');
  });

  it('UCV-demote also clears executable (latent trap closed)', () => {
    expect(src).toContain('if (patch.grade) { s.grade = patch.grade; s.executable = false; }');
  });
});

// ============================================================
// [B2] qualityVerdict quorumExempt
// ============================================================
describe('v21.4.1 [B2] — qualityVerdict quorumExempt (expert picks blanket −25 fix)', () => {
  const base = { market: 'CRYPTO', side: 'LONG', votes: [{ dir: 1, conf: 80 }], ltp: 100, now: Date.now() };

  it('BOARD path (default): single voter → −25 + gradeCap WATCH (unchanged contract)', () => {
    const qv = qualityVerdict({ ...base });
    expect(qv.confAdj).toBe(-25);
    expect(qv.gradeCap).toBe('WATCH');
    expect(qv.flags.quorum.exempt).toBeUndefined();
  });

  it('EXEMPT caller (expert-pick composite): no quorum penalty, no WATCH cap, honest flag', () => {
    const qv = qualityVerdict({ ...base, quorumExempt: true });
    expect(qv.confAdj).toBe(0);           // regime/extension/MTF ladders neutral here
    expect(qv.gradeCap).toBe('STRONG');   // 80+ STRONG bar reachable again
    expect(qv.flags.quorum.exempt).toBe(true);
  });

  it('exempt caller still pays the REAL ladders (regime/extension/counter-tape)', () => {
    // extension veto must still WATCH-cap an exempt caller
    const qv = qualityVerdict({ ...base, quorumExempt: true, rsi: 88, changePct: 32, adx: 45 });
    expect(qv.gradeCap).toBe('WATCH');
    expect(qv.flags.veto).toBe('extension');
  });
});

// ============================================================
// [B1] expertScoreFactors ADX object shape
// ============================================================
describe('v21.4.1 [B1] — expertScoreFactors ADX (object form now scored)', () => {
  const tvBase = { ltp: 100, usdPrice: 100, ema10: 99, ema20: 98, ema50: 97, rsi: 60, adx: 20 };
  const ltfWith = (adxVal) => ({
    ltp: 100, ema10: 99.5, ema20: 98.5, ema50: 97.5, rsi: 60,
    macd: { macd: 1.2, signal: 0.6 },
    adx: typeof adxVal === 'number' ? { adx: adxVal, plusDI: 25, minusDI: 10 } : adxVal,
  });

  it('strong-ADX object (35) outscores weak-ADX object (8) — trend leg ab fires', () => {
    const a = expertScoreFactors({ tv: tvBase, ltf: ltfWith(35), market: 'CRYPTO', regime: null });
    const b = expertScoreFactors({ tv: tvBase, ltf: ltfWith(8), market: 'CRYPTO', regime: null });
    expect(a).toBeTruthy();
    expect(b).toBeTruthy();
    expect(a.score).toBeGreaterThan(b.score);
    expect(Number.isFinite(a.score)).toBe(true);
    expect(Number.isFinite(b.score)).toBe(true);
  });

  it('object form ≡ number form (parity: TV numeric adx vs LTF object adx)', () => {
    const obj = expertScoreFactors({ tv: tvBase, ltf: ltfWith(30), market: 'CRYPTO', regime: null });
    const numForm = expertScoreFactors({ tv: tvBase, ltf: { ...ltfWith(0), adx: 30 }, market: 'CRYPTO', regime: null });
    expect(obj.score).toBe(numForm.score);
  });
});

// ============================================================
// [B6] boardAiConfirm +2 chop-cap clamp
// ============================================================
describe('v21.4.1 [B6] — boardAiConfirm CONFIRMED bump clamp under chop cap', () => {
  beforeEach(() => { __resetBoardAiConfirmForTests(); });
  afterEach(() => { __resetBoardAiConfirmForTests(); });

  const agreeP = async (snap) => ({ action: snap.proposed, note: null, probs: {}, confidence: 70 });

  it('a chop-capped pick (78) can confirm but NEVER crosses 80 (the STRONG badge bar)', async () => {
    __setProvidersForTests({ jev: agreeP });
    const capped = strongBoardSignal({ symbol: 'DOGE', superIntel: undefined, score: 78, __chopCapped: true });
    await confirmBoardSignals([capped], 'FUTURES');
    expect(capped.aiConfirm.verdict).toBe('CONFIRMED');
    expect(capped.score).toBe(79); // 78 + max(0, 79-78) = 79 — NOT 80
  });

  it('an uncapped pick still gets the full +2 (legacy contract)', async () => {
    __setProvidersForTests({ jev: agreeP, laya: agreeP });
    const plain = strongBoardSignal({ symbol: 'ETH', superIntel: undefined, score: 78 });
    await confirmBoardSignals([plain], 'FUTURES');
    expect(plain.score).toBe(80); // 78 + 2
  });

  it('CONFLICT demote also clears executable', async () => {
    const disagreeP = async () => ({ action: 'wait', note: 'disagreed_side', probs: {}, confidence: 60 });
    __setProvidersForTests({ jev: disagreeP });
    const s = strongBoardSignal({ symbol: 'SOL', executable: true });
    await confirmBoardSignals([s], 'FUTURES');
    expect(s.grade).toBe('ACTION');
    expect(s.executable).toBe(false);
  });
});

// ============================================================
// [B4] trackRecord market-scoped dedup + flip
// ============================================================
describe('v21.4.1 [B4] — trackRecord CRYPTO × FUTURES cross-desk collision', () => {
  beforeEach(() => { __resetFlipGuardForTests(); });
  afterEach(() => { flushTrackRecordState(); });

  it('same base symbol on BOTH desks (same UTC dayKey) opens TWO separate rows — futures feedback no longer swallowed', () => {
    recordSignals([trackedSig({ symbol: 'BTC', market: 'CRYPTO' })]);
    recordSignals([trackedSig({ symbol: 'BTC', market: 'FUTURES', entry: 102000, stopLoss: 100000, target1: 104000, target2: 106000, ltp: 102000 })]);
    const sets = watcherSymbolsByMarket();
    expect(sets.crypto).toContain('BTC');
    expect(sets.futures).toContain('BTC'); // OLD: second record was a "refresh" of the CRYPTO row
  });

  it('a FUTURES direction flip NEVER touch kare the CRYPTO row (domain-mix FLIP ban)', () => {
    recordSignals([trackedSig({ symbol: 'ETH', market: 'CRYPTO', entry: 300000, stopLoss: 295000, target1: 310000, target2: 320000, ltp: 300000 })]);
    recordSignals([trackedSig({ symbol: 'ETH', market: 'FUTURES', entry: 3500, stopLoss: 3400, target1: 3600, target2: 3700, ltp: 3500 })]);
    // FUTURES ETH flips SHORT — CRYPTO ETH row (LONG) must stay untouched
    recordSignals([trackedSig({ symbol: 'ETH', market: 'FUTURES', direction: 'SHORT', entry: 3490, stopLoss: 3550, target1: 3400, target2: 3350, ltp: 3490 })]);
    const rec = getTrackRecord(1);
    const cryptoEth = rec.open.find(r => r.symbol === 'ETH' && r.market === 'CRYPTO');
    expect(cryptoEth).toBeTruthy();
    expect(cryptoEth.direction).toBe('LONG');   // OLD: flip-closed at the USDT-domain 3490 price
    expect(cryptoEth.status).toBe('OPEN');
    const futEth = rec.open.find(r => r.symbol === 'ETH' && r.market === 'FUTURES');
    expect(futEth?.direction).toBe('SHORT');   // the futures row itself flipped honestly
    // dono desks ki apni row — ek hi symbol, do trades
    expect(rec.open.filter(r => r.symbol === 'ETH').length).toBe(2);
  });

  it('same base symbol dono desks → DO open rows (futures feedback no longer swallowed)', () => {
    recordSignals([trackedSig({ symbol: 'SOL', market: 'CRYPTO', entry: 20000, stopLoss: 19500, target1: 20500, target2: 21000, ltp: 20000 })]);
    recordSignals([trackedSig({ symbol: 'SOL', market: 'FUTURES', entry: 240, stopLoss: 233, target1: 246, target2: 252, ltp: 240 })]);
    const rec = getTrackRecord(1);
    expect(rec.open.filter(r => r.symbol === 'SOL').length).toBe(2); // OLD: doosri record "refresh" me swallow
    const sets = watcherSymbolsByMarket();
    expect(sets.crypto).toContain('SOL');
    expect(sets.futures).toContain('SOL');
  });
});

// ============================================================
// [B5] sub-cent rounding
// ============================================================
describe('v21.4.1 [B5] — sub-cent prices survive rounding (SHIB/PEPE class)', () => {
  afterEach(() => { flushTrackRecordState(); });

  it('risk/exitPrice/lastPrice kabhi 0 nahi bante jab price < 0.01 hai', () => {
    recordSignals([trackedSig({
      symbol: 'PEPE', market: 'CRYPTO', direction: 'LONG',
      entry: 0.000166, stopLoss: 0.000160, target1: 0.000180, target2: 0.000200,
      ltp: 0.000166, qtyPerLakh: 100000000,
    })]);
    const rec = getTrackRecord(1);
    const row = rec.open.find(r => r.symbol === 'PEPE');
    expect(row).toBeTruthy();
    expect(row.entry).toBe(0.000166);        // sub-cent levels byte-exact preserve
    expect(row.stopLoss).toBe(0.00016);       // (0.000160 === 0.00016 numerically)

    const events = [];
    evaluateTracked({ PEPE: { price: 0.000159 } }, events);
    const closed = getTrackRecord(1).history.find(r => r.symbol === 'PEPE');
    expect(closed).toBeTruthy();
    expect(closed.status).toBe('SL_HIT');
    expect(closed.exitPrice).toBeGreaterThan(0);   // OLD: +(0.00016).toFixed(2) = 0 → fake full-qty loss
    // v21.13 SL GAP-THROUGH PARITY (paperTrading [H3] jaisa): fill at the
    // TRADED price (0.000159 — the tick that fired, gapped through the
    // 0.00016 stop) — not the trigger level. Honest worst-side market fill.
    expect(closed.exitPrice).toBeCloseTo(0.000159, 8);
    // OLD bug ka asli damage: exitPrice 0 → pnl = qty × (0 − entry) = −16,600 fake wipeout.
    // FIX: honest loss = 1e8 × (0.000159 − 0.000166) = −700 (worse than
    // trigger-level −600 — that IS the gap-through honesty, [H3] parity).
    expect(closed.pnl).toBeCloseTo(-700, 0);
    expect(closed.rMultiple).toBeCloseTo(-700 / 600, 2); // −1.17R — an honest gapped SL, not a wipeout
  });
});

// ============================================================
// [B7] evaluateTracked market-qualified quotes
// ============================================================
describe('v21.4.1 [B7] — evaluateTracked reads per-desk (market-qualified) quotes', () => {
  afterEach(() => { flushTrackRecordState(); });

  it('BTC CRYPTO (INR) + BTC FUTURES (USDT): futures row apne USDT price pe hi evaluate hota hai', () => {
    recordSignals([trackedSig({ symbol: 'BTC2', market: 'CRYPTO', entry: 8600000, stopLoss: 8550000, target1: 8700000, target2: 8800000, ltp: 8600000 })]);
    recordSignals([trackedSig({ symbol: 'BTC2', market: 'FUTURES', entry: 102000, stopLoss: 103000, target1: 104000, target2: 106000, ltp: 102000 })]);
    const events = [];
    // plain map = INR domain (8.5M); qualified map = USDT truth (102,000).
    // BUG case: futures row INR price padhta → 8.5M ≥ T2 106000 → fake T2_HIT win.
    // FIX: qualified key pe USDT 102,000 ≤ SL 103,000 → honest SL_HIT.
    evaluateTracked({ BTC2: { price: 8500000 } }, events, { 'FUTURES|BTC2': { price: 102000 } });
    const rec = getTrackRecord(1);
    const futRow = [...rec.open, ...rec.history].find(r => r.symbol === 'BTC2' && r.market === 'FUTURES');
    const cxRow = [...rec.open, ...rec.history].find(r => r.symbol === 'BTC2' && r.market === 'CRYPTO');
    expect(futRow.status).toBe('SL_HIT');        // USDT domain fired — NOT the fake T2_HIT
    // v21.13 gap-through parity: fill at the TRADED USDT price (102,000 —
    // the tick that gapped through the 103,000 stop), not the trigger level.
    expect(futRow.exitPrice).toBe(102000);
    expect(cxRow.status).toBe('SL_HIT');          // crypto row apne INR price pe (8.5M ≤ 8.55M)
    expect(cxRow.exitPrice).toBe(8500000);        // v21.13: traded INR price (8.5M), not the 8.55M level
  });

  it('legacy callers (no qualified map) still work via the plain-key fallback', () => {
    recordSignals([trackedSig({ symbol: 'ADA', market: 'FUTURES', entry: 0.9, stopLoss: 0.85, target1: 0.95, target2: 1.0, ltp: 0.9, qtyPerLakh: 100000 })]);
    const events = [];
    evaluateTracked({ ADA: { price: 0.84 } }, events); // no third arg
    const closed = getTrackRecord(1).history.find(r => r.symbol === 'ADA');
    expect(closed?.status).toBe('SL_HIT');
  });
});

// ============================================================
// [C3] futures precheck parity (source contract)
// ============================================================
describe('v21.4.1 [C3] — futures precheck live-parity (source contract)', () => {
  it('precheck reads the signal with mode live (same gauntlet as the real order)', () => {
    const src = readSrc('../server/ai/futures.js');
    expect(src).toContain("getFreshSignal(pair, { mode: 'live' })");
  });
  it('leverage sanity is a BLOCKING gate in the precheck', () => {
    const src = readSrc('../server/ai/futures.js');
    expect(src).toContain("gate('Leverage sanity'");
  });
});
