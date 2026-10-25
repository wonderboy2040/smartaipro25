// ============================================================
// test/directionCertificate.test.ts — v21.25.0 DIRECTION CERTIFICATE
// ------------------------------------------------------------
// USER SPEC: "LONG/SHORT signal ka matlab wahi hona chahiye jo order
// side jaata hai — agar ulta ho raha hai to fix karo aur explicit
// direction certificate dikhao."
//
// These tests pin the ONE shared contract:
//   LONG/BUY  -> LONG  -> exchange "buy"
//   SHORT/SELL-> SHORT -> exchange "sell"
//   unknown   -> NEVER silently LONG (blocked, explicit reason)
//   exchange activePos sign is authoritative over a declared side.
// ============================================================
import { describe, it, expect } from 'vitest';
import {
  DIRECTION_CERT_VERSION,
  normalizeSide,
  normalizeSideStrict,
  sideSign,
  orderSideForSignal,
  oppositeSideOf,
  auditDirectionalGeometry,
  resolveActivePosSide,
  buildDirectionCertificate,
  summarizeBoardDirectionIntegrity,
} from '../server/ai/directionCertificate.js';
import { recheckRow } from '../server/ai/signalRecheck.js';
import { verifySignal } from '../server/ai/signalVerifier.js';
import { verifyUltrafast } from '../server/ai/ultrafastVerifier.js';
import { pullbackLevelFor, levelTouched, patientPendingAction } from '../server/ai/patientEntry.js';
import { momentumStateOf, MOMENTUM } from '../server/ai/volTrail.js';
import { liveInvalidationCheck } from '../server/ai/superIntel.js';
import { mtfAnalysis, structureStop } from '../server/ai/probrain.js';

const LONG_TICKET = { symbol: 'BTC', market: 'FUTURES', side: 'LONG', entry: 100, stopLoss: 95, t1: 110, t2: 120 };
const SHORT_TICKET = { symbol: 'ETH', market: 'FUTURES', side: 'SHORT', entry: 100, stopLoss: 105, t1: 90, t2: 80 };

describe('directionCertificate — strict side vocabulary', () => {
  it('maps every LONG alias to LONG and every SHORT alias to SHORT', () => {
    for (const s of ['LONG', 'BUY', 'BULL', 'BULLISH', '+1', '1', ' long ']) expect(normalizeSide(s)).toBe('LONG');
    for (const s of ['SHORT', 'SELL', 'BEAR', 'BEARISH', '-1', ' short ']) expect(normalizeSide(s)).toBe('SHORT');
    expect(normalizeSide(1)).toBe('LONG');
    expect(normalizeSide(-1)).toBe('SHORT');
  });

  it('NEVER defaults an unknown/missing side to LONG', () => {
    for (const s of [null, undefined, '', 'FLAT', 'NEUTRAL', 'x', 'WAIT', 0, NaN]) {
      expect(normalizeSide(s)).toBeNull();
    }
  });

  it('strict normalization returns an explicit reason instead of guessing', () => {
    expect(normalizeSideStrict('buy')).toMatchObject({ ok: true, side: 'LONG', reason: null });
    const bad = normalizeSideStrict('moon');
    expect(bad.ok).toBe(false);
    expect(bad.side).toBeNull();
    expect(bad.reason).toContain('invalid');
  });

  it('maps signal side to the exchange order side (LONG→buy, SHORT→sell)', () => {
    expect(orderSideForSignal('LONG')).toBe('buy');
    expect(orderSideForSignal('BUY')).toBe('buy');
    expect(orderSideForSignal('SHORT')).toBe('sell');
    expect(orderSideForSignal('SELL')).toBe('sell');
    expect(orderSideForSignal('x')).toBeNull();
    expect(sideSign('LONG')).toBe(1);
    expect(sideSign('SHORT')).toBe(-1);
    expect(sideSign('x')).toBeNull();
    expect(oppositeSideOf('LONG')).toBe('SHORT');
    expect(oppositeSideOf('SHORT')).toBe('LONG');
    expect(oppositeSideOf('x')).toBeNull();
  });
});

describe('directionCertificate — geometry audit', () => {
  it('accepts LONG SL below entry and targets above (ordered)', () => {
    const a = auditDirectionalGeometry({ side: 'LONG', entry: 100, stopLoss: 95, t1: 110, t2: 120 });
    expect(a.geometryValid).toBe(true);
    expect(a.slOnCorrectSide).toBe(true);
    expect(a.targetsOnCorrectSide).toBe(true);
    expect(a.targetsOrdered).toBe(true);
  });

  it('accepts SHORT SL above entry and targets below (ordered)', () => {
    const a = auditDirectionalGeometry({ side: 'SHORT', entry: 100, stopLoss: 105, t1: 90, t2: 80 });
    expect(a.geometryValid).toBe(true);
  });

  it('rejects inverted SL geometry on BOTH sides', () => {
    const badLong = auditDirectionalGeometry({ side: 'LONG', entry: 100, stopLoss: 105, t1: 110, t2: 120 });
    expect(badLong.geometryValid).toBe(false);
    expect(badLong.reasons.join(' ')).toMatch(/wrong side/i);
    const badShort = auditDirectionalGeometry({ side: 'SHORT', entry: 100, stopLoss: 95, t1: 90, t2: 80 });
    expect(badShort.geometryValid).toBe(false);
  });

  it('rejects a target on the wrong side and an unordered target ladder', () => {
    expect(auditDirectionalGeometry({ side: 'LONG', entry: 100, stopLoss: 95, t1: 90, t2: 120 }).geometryValid).toBe(false);
    expect(auditDirectionalGeometry({ side: 'LONG', entry: 100, stopLoss: 95, t1: 120, t2: 110 }).geometryValid).toBe(false);
  });

  it('requires targets only when requireTargets=true', () => {
    expect(auditDirectionalGeometry({ side: 'LONG', entry: 100, stopLoss: 95, requireTargets: true }).geometryValid).toBe(false);
    expect(auditDirectionalGeometry({ side: 'LONG', entry: 100, stopLoss: 95, requireTargets: false }).geometryValid).toBe(true);
  });
});

describe('directionCertificate — activePos sign is authoritative', () => {
  it('negative activePos = SHORT even when the declared side says LONG', () => {
    const r = resolveActivePosSide({ activePos: -5, side: 'LONG' });
    expect(r.side).toBe('SHORT');
    expect(r.activePosSide).toBe('SHORT');
    expect(r.source).toBe('activePos');
    expect(r.conflict).toBe(true);
  });

  it('positive activePos = LONG even when the declared side says SHORT', () => {
    const r = resolveActivePosSide({ activePos: 5, side: 'SHORT' });
    expect(r.side).toBe('LONG');
    expect(r.conflict).toBe(true);
  });

  it('zero/missing activePos falls back to the declared side without inventing one', () => {
    expect(resolveActivePosSide({ activePos: 0, side: 'LONG' })).toMatchObject({ side: 'LONG', conflict: false, source: 'declared' });
    expect(resolveActivePosSide({ activePos: 0, side: 'x' })).toMatchObject({ side: null, source: 'none' });
  });
});

describe('directionCertificate — certificate contract', () => {
  it('LONG signal certificate maps to buy and can be PAKKA', () => {
    const c = buildDirectionCertificate({ ...LONG_TICKET, directionVerified: true });
    expect(c.version).toBe(DIRECTION_CERT_VERSION);
    expect(c.ok).toBe(true);
    expect(c.side).toBe('LONG');
    expect(c.orderSide).toBe('buy');
    expect(c.verdict).toBe('PAKKA');
    expect(c.pakka).toBe(true);
    expect(c.sideSign).toBe(1);
  });

  it('SHORT signal certificate maps to sell and can be PAKKA', () => {
    const c = buildDirectionCertificate({ ...SHORT_TICKET, directionVerified: true });
    expect(c.ok).toBe(true);
    expect(c.side).toBe('SHORT');
    expect(c.orderSide).toBe('sell');
    expect(c.verdict).toBe('PAKKA');
  });

  it('unknown side = INVALID_SIDE, no order side, hard blocked', () => {
    const c = buildDirectionCertificate({ symbol: 'X', market: 'CRYPTO', side: 'moon', entry: 100, stopLoss: 95, t1: 110 });
    expect(c.ok).toBe(false);
    expect(c.blocked).toBe(true);
    expect(c.side).toBeNull();
    expect(c.orderSide).toBeNull();
    expect(c.verdict).toBe('INVALID_SIDE');
    expect(c.reasons.length).toBeGreaterThan(0);
  });

  it('inverted SL = INVALID_GEOMETRY, hard blocked', () => {
    const c = buildDirectionCertificate({ ...LONG_TICKET, stopLoss: 105 });
    expect(c.ok).toBe(false);
    expect(c.verdict).toBe('INVALID_GEOMETRY');
    expect(c.reasons.join(' ')).toMatch(/wrong side/i);
  });

  it('supplied order side that contradicts the signal = ORDER_SIDE_MISMATCH', () => {
    const c = buildDirectionCertificate({ ...LONG_TICKET, orderSide: 'sell' });
    expect(c.ok).toBe(false);
    expect(c.orderMismatch).toBe(true);
    expect(c.verdict).toBe('ORDER_SIDE_MISMATCH');
  });

  it('supplied order side that is not buy/sell = ORDER_SIDE_MISMATCH, hard blocked', () => {
    const c = buildDirectionCertificate({ ...LONG_TICKET, orderSide: 'hold' });
    expect(c.ok).toBe(false);
    expect(c.blocked).toBe(true);
    expect(c.checks.orderSideValid).toBe(false);
    expect(c.checks.orderSideAligned).toBe(false);
    expect(c.verdict).toBe('ORDER_SIDE_MISMATCH');
    expect(c.reasons.join(' ')).toMatch(/invalid/i);
    expect(c.orderSide).toBe('buy');
  });

  it('activePos/declared conflict = ACTIVE_POS_MISMATCH (never silently flipped)', () => {
    const c = buildDirectionCertificate({ ...LONG_TICKET, activePos: -3 });
    expect(c.ok).toBe(false);
    expect(c.side).toBe('SHORT');
    expect(c.activePosMismatch).toBe(true);
    expect(c.verdict).toBe('ACTIVE_POS_MISMATCH');
    expect(c.reasons.join(' ')).toMatch(/activePos/i);
  });

  it('verification conflicts do not fake hard integrity, but do block PAKKA', () => {
    const c = buildDirectionCertificate({ ...LONG_TICKET, directionVerified: true, conflictFlags: { svaConflict: true } });
    expect(c.ok).toBe(true);
    expect(c.pakka).toBe(false);
    expect(c.verdict).toBe('CONFLICT');
    expect(c.conflicts[0]).toMatch(/SVA/i);
  });
});

describe('directionCertificate — board summary', () => {
  it('summarizes certified LONG→BUY / SHORT→SELL and blocked rows', () => {
    const long = buildDirectionCertificate({ ...LONG_TICKET, directionVerified: true });
    const short = buildDirectionCertificate({ ...SHORT_TICKET, directionVerified: true });
    const blocked = buildDirectionCertificate({ ...LONG_TICKET, stopLoss: 105 });
    const sum = summarizeBoardDirectionIntegrity([
      { symbol: 'BTC', side: 'LONG', directionCertificate: long },
      { symbol: 'ETH', side: 'SHORT', directionCertificate: short },
      { symbol: 'BAD', side: 'LONG', directionCertificate: blocked },
    ]);
    expect(sum.total).toBe(3);
    expect(sum.valid).toBe(2);
    expect(sum.blocked).toBe(1);
    expect(sum.long).toBe(2);
    expect(sum.short).toBe(1);
    expect(sum.buy).toBe(2);
    expect(sum.sell).toBe(1);
    expect(sum.mismatches).toBe(0);
    expect(sum.status).toBe('ATTENTION');
    expect(sum.ok).toBe(false);
    expect(sum.issues).toHaveLength(1);
    expect(sum.issues[0].verdict).toBe('INVALID_GEOMETRY');
  });

  it('empty board = EMPTY; missing certificate = uncertified issue', () => {
    expect(summarizeBoardDirectionIntegrity([])).toMatchObject({ status: 'EMPTY', total: 0, ok: false });
    const sum = summarizeBoardDirectionIntegrity([{ symbol: 'X', side: 'LONG' }]);
    expect(sum.uncertified).toBe(1);
    expect(sum.status).toBe('ATTENTION');
    expect(sum.issues[0].verdict).toBe('UNCERTIFIED');
  });
});

describe('strict-side consumers — no silent LONG anywhere', () => {
  it('signalRecheck: unknown side = INVALID_SIDE (never evaluated as LONG)', () => {
    expect(recheckRow({ side: 'moon', stopLoss: 95, target1: 110, target2: 120 }, 100).state).toBe('INVALID_SIDE');
    expect(recheckRow({ side: 'LONG', stopLoss: 95, target1: 110, target2: 120 }, 100).state).not.toBe('INVALID_SIDE');
  });

  it('SVA verifySignal: unknown side = NO_TRADE/STAND_ASIDE with zero size', () => {
    const v = verifySignal({ symbol: 'BTC', market: 'FUTURES', side: 'moon' });
    expect(v.finalCall).toBe('NO_TRADE');
    expect(v.action).toBe('STAND_ASIDE');
    expect(v.veto).toBe(true);
    expect(v.sizeHint).toBe(0);
    expect(v.invalidSide).toBe(true);
  });

  it('UCV verifyUltrafast: unknown side = REJECTED, never a LONG chart check', () => {
    const v = verifyUltrafast({ side: 'moon', symbol: 'BTC', market: 'CRYPTO', analysis: { ok: true, microDirection: 'UP', microScore: 60 } });
    expect(v.verdict).toBe('REJECTED');
    expect(v.confirmed).toBe(false);
    expect(v.invalidSide).toBe(true);
  });

  it('patientEntry: unknown side = no level, no fill, cancel pending', () => {
    expect(pullbackLevelFor({ side: 'moon', ltp: 100, entry: 99, depth: { bidWalls: [{ price: 98 }] } })).toMatchObject({ level: null, basis: 'invalid-side' });
    expect(levelTouched({ side: 'moon', level: 99, ltp: 98 })).toBe(false);
    expect(patientPendingAction({ pending: { side: 'moon', level: 99, expiresAt: Date.now() + 60_000 }, ltp: 98 })).toEqual({ action: 'expire' });
  });

  it('volTrail: unknown side = MOMENTUM.UNKNOWN (neutral, not +1 LONG)', () => {
    expect(momentumStateOf('moon', { trigger: { roc1: 0.1, roc3: 0.4, volRatio: 1.3 } })).toBe(MOMENTUM.UNKNOWN);
    expect(momentumStateOf('LONG', { trigger: { roc1: 0.1, roc3: 0.4, volRatio: 1.3 } })).toBe(MOMENTUM.SURGING);
  });

  it('liveInvalidationCheck: unknown side = invalid-side (no wrong-side invalidation)', () => {
    expect(liveInvalidationCheck({ side: 'moon', liveLtp: 90, stopLoss: 95 }).status).toBe('invalid-side');
    expect(liveInvalidationCheck({ side: 'SHORT', liveLtp: 94, stopLoss: 93.47 }).status).toBe('invalidated');
  });

  it('probrain MTF analysis: unknown side = INVALID_SIDE phase', () => {
    const m = mtfAnalysis({ htf: { ema20: 105, ema50: 100 }, ltf: { ema20: 104, ema50: 101, macdHist: 1 }, side: 'moon' });
    expect(m.phase).toBe('INVALID_SIDE');
    expect(m.aligned).toBeNull();
  });

  it('structureStop: LONG stop below / SHORT stop above on mirrored candles', () => {
    const up = Array.from({ length: 24 }, (_, i) => {
      const base = 121 + i * 0.12;
      const spike = i === 19;
      return {
        time: i,
        open: base,
        high: spike ? 126 : base + 0.8,
        low: spike ? 120 : base - 0.4,
        close: base + 0.15,
      };
    });
    const down = up.map((c) => ({
      time: c.time,
      open: 304 - c.open,
      high: 304 - c.low,
      low: 304 - c.high,
      close: 304 - c.close,
    }));
    const longStop = structureStop({ candles: up, side: 'LONG', ltp: 124, atr: 2 });
    const shortStop = structureStop({ candles: up, side: 'SHORT', ltp: 124, atr: 2 });
    expect(longStop?.sl).toBeLessThan(124);
    expect(shortStop?.sl).toBeGreaterThan(124);
    expect(structureStop({ candles: down, side: 'LONG', ltp: 180, atr: 2 })?.sl).toBeLessThan(180);
    expect(structureStop({ candles: down, side: 'SHORT', ltp: 180, atr: 2 })?.sl).toBeGreaterThan(180);
    expect(structureStop({ candles: up, side: 'moon', ltp: 124, atr: 2 })).toBeNull();
  });
});
