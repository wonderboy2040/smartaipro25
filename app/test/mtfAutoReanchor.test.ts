// ============================================================
// test/mtfAutoReanchor.test.ts — v21.25.3 RE-ANCHOR MONEY LOCKS
// ------------------------------------------------------------
// `recordLiveMtfBoardTrade()` ka re-anchor branch pehle sirf levels
// (entry/qty/SL/T1/T2) update karta tha. Derived money fields purane
// lifecycle ke rehte the:
//   • riskINR/riskUsdt  → Phase-0 audit stale risk dikhata tha
//   • notional          → open-notional budget under-count (cap bypass)
//   • marginINR/USDT    → UI + risk view galat
//   • dayKey            → naya order purane din ke quota bucket me
//   • feeBreakevenPrice → fee-aware reversal purana fee floor use karta
//   • paperId/live ids  → PAPER row LIVE session lock kha raha tha
//
// Ye suite in sab ko lock karta hai (naye-row path ke SAME contract se).
// Hermetic: setup.ts har suite ko apna MTF_AUTO_DATA_DIR deta hai.
// ============================================================
import { describe, it, expect, beforeEach } from 'vitest';
import {
  recordLiveMtfBoardTrade,
  recordPaperMtfBoardTrade,
  mtfAutoStatus,
  __resetMtfAutoForTests,
} from '../server/ai/mtfAutoLink.js';
import { dayKeyFor } from '../server/intraday/time.js';

const BASE_CFG = {
  walletAmountINR: 100000,
  walletDeployPct: 100,
  inrPerUsdt: 100,
  maxTradesPerDay: 5,
  executionMode: 'live',
};

describe('v21.25.3 recordLiveMtfBoardTrade re-anchor money bookkeeping', () => {
  beforeEach(() => {
    __resetMtfAutoForTests({ config: BASE_CFG });
  });

  it('LIVE re-anchor recomputes risk/notional/margin/fee/dayKey from the NEW order', () => {
    const r1 = recordLiveMtfBoardTrade({
      orderId: 'live-1', positionId: 'pos-1', paperId: 'mirror-1',
      symbol: 'BTC', market: 'CRYPTO', side: 'LONG',
      entry: 100, stopLoss: 90, t1: 110, t2: 120,
      qty: 1, leverage: 5, walletINR: 100000, fx: 100,
      openedBy: 'AUTO', autoTrade: true, autoEngine: true,
    });
    expect(r1).toBeTruthy();
    // stale lifecycle markers inject karo — re-anchor ko sab reset karna hai
    r1!.dayKey = '1999-12-31';
    r1!.flipEntry = true;
    r1!.flippedFrom = 'LONG';
    r1!.t2Extensions = 3;
    r1!.bookedPnl = 500;
    r1!.slSyncPending = true;
    r1!.tpSyncPending = true;

    const r2 = recordLiveMtfBoardTrade({
      orderId: 'live-2', positionId: 'pos-2', paperId: 'mirror-2',
      symbol: 'BTC', market: 'CRYPTO', side: 'SHORT',
      entry: 200, stopLoss: 210, t1: 190, t2: 180,
      qty: 2, leverage: 5, walletINR: 100000, fx: 100,
      superScore: 88, tier: 'ELITE',
    });

    expect(r2).toBe(r1); // same OPEN row re-anchors, naya row nahi
    expect(r2!.side).toBe('SHORT');
    expect(r2!.entry).toBe(200);
    expect(r2!.qty).toBe(2);
    expect(r2!.stopLoss).toBe(210);
    // fx=100 → USDT book, 1 USDT = ₹100
    expect(r2!.riskUsdt).toBeCloseTo(20, 6);       // 2 × |200−210|
    expect(r2!.riskINR).toBeCloseTo(2000, 2);      // 20 × 100
    expect(r2!.notionalUsdt).toBeCloseTo(400, 6);  // 2 × 200
    expect(r2!.notional).toBeCloseTo(40000, 2);
    expect(r2!.marginUsdt).toBeCloseTo(80, 6);     // notional / 5x
    expect(r2!.marginINR).toBeCloseTo(8000, 2);
    // SHORT fee floor = entry × (1 − 0.12%)
    expect(r2!.feeBreakevenPrice).toBeCloseTo(199.76, 4);
    expect(r2!.dayKey).toBe(dayKeyFor('FUTURES'));
    expect(r2!.flipEntry).toBe(false);
    expect(r2!.flippedFrom).toBeNull();
    expect(r2!.t2Extensions).toBe(0);
    expect(r2!.bookedPnl).toBe(0);
    expect(r2!.slSyncPending).toBe(false);
    expect(r2!.tpSyncPending).toBe(false);
    expect(r2!.lastExchangeSl).toBe(210);
    expect(r2!.lastExchangeTp).toBe(180);
    // fresh manual click = manual provenance (auto quota poison cure)
    expect(r2!.openedBy).toBe('MANUAL');
    expect(r2!.autoTrade).toBe(false);
    expect(r2!.autoEngine).toBe(false);
    // both LIVE executions count, PAPER practice does not
    expect(mtfAutoStatus().dayCount).toBe(2);
  });

  it('PAPER → LIVE re-anchor clears stale paper ids and stamps the live order', () => {
    const p1 = recordPaperMtfBoardTrade({
      paperId: 'paper-1', symbol: 'ETH', market: 'CRYPTO', side: 'LONG',
      entry: 50, stopLoss: 45, t1: 55, t2: 60,
      qty: 1, leverage: 5, walletINR: 100000, fx: 100,
    });
    expect(p1!.executionMode).toBe('PAPER');
    expect(p1!.paperId).toBe('paper-1');
    expect(mtfAutoStatus().dayCount).toBe(0);

    const live = recordLiveMtfBoardTrade({
      orderId: 'live-eth-1', positionId: 'pos-eth-1', paperId: 'mirror-eth-1',
      symbol: 'ETH', market: 'CRYPTO', side: 'LONG',
      entry: 60, stopLoss: 55, t1: 65, t2: 70,
      qty: 2, leverage: 5, walletINR: 100000, fx: 100,
    });
    expect(live).toBe(p1);
    expect(live!.executionMode).toBe('LIVE');
    expect(live!.openedInLiveMode).toBe(true);
    expect(live!.paperId).toBe('mirror-eth-1');
    expect(live!.liveOrderId).toBe('live-eth-1');
    expect(live!.livePositionId).toBe('pos-eth-1');
    expect(live!.notionalUsdt).toBeCloseTo(120, 6);
    expect(mtfAutoStatus().dayCount).toBe(1);

    const paperAgain = recordPaperMtfBoardTrade({
      paperId: 'paper-2', symbol: 'ETH', market: 'CRYPTO', side: 'SHORT',
      entry: 70, stopLoss: 75, t1: 65, t2: 60,
      qty: 1, leverage: 5, walletINR: 100000, fx: 100,
    });
    expect(paperAgain).toBe(p1);
    expect(paperAgain!.executionMode).toBe('PAPER');
    expect(paperAgain!.openedInLiveMode).toBe(false);
    expect(paperAgain!.paperId).toBe('paper-2');
    // LIVE ids previous lifecycle ke hain — practice row unhe carry nahi karegi
    expect(paperAgain!.liveOrderId).toBeNull();
    expect(paperAgain!.livePositionId).toBeNull();
    expect(mtfAutoStatus().dayCount).toBe(1); // paper practice quota nahi khaata
  });

  it('side flip + activePos re-anchor refreshes direction certificate and derived risk', () => {
    const long = recordLiveMtfBoardTrade({
      orderId: 'live-long', positionId: 'pos-long',
      symbol: 'SOL', market: 'CRYPTO', side: 'LONG', activePos: 3,
      entry: 100, stopLoss: 90, t1: 110, t2: 120,
      qty: 1, leverage: 5, walletINR: 100000, fx: 100,
    });
    expect(long!.directionCertificate?.side).toBe('LONG');

    const short = recordLiveMtfBoardTrade({
      orderId: 'live-short', positionId: 'pos-short',
      symbol: 'SOL', market: 'CRYPTO', side: 'SHORT', activePos: -2,
      entry: 120, stopLoss: 126, t1: 114, t2: 108,
      qty: 2, leverage: 5, walletINR: 100000, fx: 100,
    });
    expect(short).toBe(long);
    expect(short!.side).toBe('SHORT');
    expect(short!.orderSide).toBe('sell');
    expect(short!.activePos).toBe(-2);
    expect(short!.directionCertificate?.side).toBe('SHORT');
    expect(short!.riskUsdt).toBeCloseTo(12, 6);      // 2 × |120−126|
    expect(short!.notionalUsdt).toBeCloseTo(240, 6); // 2 × 120
    expect(short!.marginUsdt).toBeCloseTo(48, 6);    // 240 / 5x
  });
});
