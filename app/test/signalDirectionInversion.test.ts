// ============================================================
// test/signalDirectionInversion.test.ts — v21.23.2
// SIGNAL-DIRECTION INVERSION regression suite
// ------------------------------------------------------------
// USER COMPLAINT (verbatim): "Trade signals Wrong and opposite jaa
// rahe hai — long trade signal ka short jaa raha hai, short trade
// signal ka long jaa raha hai."
//
// ROOT CAUSES (dono concrete-level pe fixed):
//   • BUG A — dhan.js dhanPlaceOrder: `buy = side !== 'SELL'` check
//     'SHORT' ko bhi BUY treat karta tha (side vocabulary mismatch:
//     India execution paths 'LONG'/'SHORT' bhejte hain, watcher exits
//     'BUY'/'SELL'). India LIVE SHORT entry exchange par BUY order thi
//     (journal SHORT, real position LONG) — "short ka long". SHORT
//     position ka protective SL SELL lagta tha — cover ke bajaye
//     double-short (position UNPROTECTED).
//   • BUG B — v21.13 silent FLIP-REALIGN (indiaOrders.js +
//     coindcxOrders.js): paper/notify me clicked card ke OPPOSITE side
//     ka trade silently khul jaata tha (gate anti-flip veto bypass) —
//     "long ka short". v21.23.2: conflict = honest BLOCK.
//
// LOCKED HERE:
//   • dhan transactionType matrix — DONO vocabularies, entry + SL sides
//     (pure dhanOrderBody — v21.23.2 me extract hui, pehle internal
//     dhanPrivate ke peeche untestable thi — isi liye bug kabhi pakda
//     nahi gaya tha)
//   • executeIndiaSignal LIVE SHORT wiring — indiaOrders.test.ts me
//     "v21.23.2 LIVE SHORT signal" test (side exchange tak SHORT hi)
// ============================================================
import { describe, it, expect } from 'vitest';

import { dhanOrderBody } from '../server/ai/dhan.js';

// ============================================================
// 1) dhan.js transactionType matrix — the "short ka long" LIVE fix
// ============================================================
describe('dhan.js dhanOrderBody side-vocabulary matrix (v21.23.2 inversion fix)', () => {
  const base = (over = {}) => dhanOrderBody({
    symbol: 'RELIANCE', securityId: 2885, quantity: 10, ...over,
  });

  it('LONG entry → BUY (ensemble vocabulary)', () => {
    const body = base({ side: 'LONG', kind: 'ENTRY' });
    expect(body.transactionType).toBe('BUY');
    expect(body.orderType).toBe('MARKET');
    expect(body.tradingSymbol).toBe('RELIANCE');
    expect(body.securityId).toBe('2885');
    expect(body.quantity).toBe(10);
  });

  it('SHORT entry → SELL (THE inversion bug: pehle BUY order jaati thi — "short signal ka long")', () => {
    const body = base({ side: 'SHORT', kind: 'ENTRY' });
    expect(body.transactionType).toBe('SELL');
    expect(body.orderType).toBe('MARKET');
  });

  it('LONG protective SL → SELL exit side (cover)', () => {
    const body = base({ side: 'LONG', kind: 'SL', triggerPrice: 95 });
    expect(body.transactionType).toBe('SELL');
    expect(body.orderType).toBe('STOP_LOSS_MARKET');
    expect(body.triggerPrice).toBe(95);
  });

  it('SHORT protective SL → BUY exit side (THE cover bug: pehle SELL — double-short, position unprotected)', () => {
    const body = base({ side: 'SHORT', kind: 'SL', triggerPrice: 105 });
    expect(body.transactionType).toBe('BUY');
    expect(body.orderType).toBe('STOP_LOSS_MARKET');
    expect(body.triggerPrice).toBe(105);
  });

  it("watcher exits 'BUY'/'SELL' vocabulary unchanged (passthrough compatibility)", () => {
    expect(base({ side: 'SELL', kind: 'ENTRY' }).transactionType).toBe('SELL');
    expect(base({ side: 'BUY', kind: 'ENTRY' }).transactionType).toBe('BUY');
    // SL branch with exit vocabulary (watcher paths jo position-side bhejte hain)
    expect(base({ side: 'BUY', kind: 'SL', triggerPrice: 95 }).transactionType).toBe('SELL');
    expect(base({ side: 'SELL', kind: 'SL', triggerPrice: 105 }).transactionType).toBe('BUY');
  });

  it('SL without a positive triggerPrice throws (validation preserved)', () => {
    expect(() => base({ side: 'SHORT', kind: 'SL', triggerPrice: 0 })).toThrow(/positive triggerPrice/);
    expect(() => base({ side: 'LONG', kind: 'SL', triggerPrice: null })).toThrow(/positive triggerPrice/);
  });

  it('unknown side value = LOUD THROW (v21.23.12 doctrine — silent order KABHI nahi)', () => {
    // Purana code kisi bhi unknown string ko silent BUY/SELL bana deta tha
    // (v21.23.2 ne "conservative SELL" compromise pin kiya tha). v21.23.9 ka
    // futuresOrderBody doctrine yahan port hua: unknown side = fail-honest
    // throw — call-site fix maangta hai, silent order KABHI nahi.
    expect(() => base({ side: 'SIDEWAYS', kind: 'ENTRY' })).toThrow(/unknown side/i);
    expect(() => base({ side: 'HOLD', kind: 'ENTRY' })).toThrow(/unknown side/i);
  });
});
