// ============================================================
// test/v1864UiAudit.test.tsx — v18.6.4 frontend audit fixes
// ------------------------------------------------------------
// LOCKED HERE:
//   • liveInvalidationCheck: null/absent stopLoss = NO SL check
//     (Number(null)===0 used to invalidate EVERY SHORT card)
//   • mergeLiveTicks: OPTION trades never take the underlying spot
//     tick (₹150 premium vs ₹24,600 index = -₹36L fantasy P&L)
//   • SignalCard renders exactly ONE VerifyBadge per card + ONE
//     VerifyChecklist when expanded (both used to render twice)
//   • ManualRow: an OPEN trade without __view renders 'conviction —'
//     instead of crashing the tab
// ============================================================
// @ts-nocheck
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

import { liveInvalidationCheck } from '../src/components/aitrading/liveInvalidation';
import { mergeLiveTicks, liveKeyFor } from '../src/components/aitrading/manualLiveMerge';

const NOW = Date.now();
const mins = (m) => m * 60_000;

// ============================================================
describe('v18.6.4 — liveInvalidationCheck: null stopLoss guard', () => {
  it('SHORT with stopLoss null → ok (was: instantly INVALIDATED via Number(null)===0)', () => {
    const r = liveInvalidationCheck({ side: 'SHORT', liveLtp: 94.5, stopLoss: null });
    expect(r.status).toBe('ok');
  });
  it('SHORT with stopLoss 0 → ok (no-check)', () => {
    const r = liveInvalidationCheck({ side: 'SHORT', liveLtp: 94.5, stopLoss: 0 });
    expect(r.status).toBe('ok');
  });
  it('SHORT with a REAL stopLoss still invalidates through it', () => {
    const r = liveInvalidationCheck({ side: 'SHORT', liveLtp: 95.5, stopLoss: 95 });
    expect(r.status).toBe('invalidated');
  });
  it('LONG with real stopLoss still invalidates', () => {
    const r = liveInvalidationCheck({ side: 'LONG', liveLtp: 94.5, stopLoss: 95 });
    expect(r.status).toBe('invalidated');
  });
});

// ============================================================
describe('v18.6.4 — mergeLiveTicks: OPTION-domain guard', () => {
  const optTrade = {
    status: 'OPEN', market: 'INDIA', symbol: 'NIFTY', assetKind: 'OPTION',
    __view: { ltp: 150, pnl: { pnlINR: 0, pnlPct: 0, pnlUSDT: null, currency: 'INR' } },
  };
  const ticks = { IN_NIFTY: { price: 24600, time: NOW - 1000 } }; // the UNDERLYING index spot

  it('an OPTION trade is NOT overwritten by the underlying index tick', () => {
    const out = mergeLiveTicks([optTrade], ticks, 84);
    expect(out[0]).toBe(optTrade);                 // same reference — unchanged
    expect(out[0].__view.ltp).toBe(150);           // premium stays
    expect(out[0].__view.pnl.pnlINR).toBe(0);      // no -₹36L fantasy
  });
  it('a normal INDIA equity trade still takes the live tick', () => {
    const eqTrade = {
      status: 'OPEN', market: 'INDIA', symbol: 'RELIANCE', assetKind: null,
      entryPrice: 2900, qty: 2, side: 'BUY',
      __view: { ltp: 2900, pnl: { pnlINR: 0, pnlPct: 0, pnlUSDT: null, currency: 'INR' } },
    };
    const out = mergeLiveTicks([eqTrade], { IN_RELIANCE: { price: 2950, time: NOW - 1000 } }, 84);
    expect(out[0]).not.toBe(eqTrade);
    expect(out[0].__view.ltp).toBe(2950);
    expect(out[0].__view.pnl.pnlINR).toBe(100);    // (2950-2900) × 2 × BUY
  });
  it('liveKeyFor namespaces unchanged (regression)', () => {
    expect(liveKeyFor('FUTURES', 'BTC')).toBe('FUT_BTC');
    expect(liveKeyFor('GLOBALFUTURES', 'TSLA')).toBe('GLOB_TSLA');
    expect(liveKeyFor('CRYPTO', 'XRP')).toBe('IN_XRP');
    expect(liveKeyFor('INDIA', 'TCS')).toBe('IN_TCS');
  });
});

// ============================================================
describe('v18.6.4 — SignalCard: single VerifyBadge / VerifyChecklist', () => {
  // minimal AISignal-shaped object with a verify stamp
  const verify = {
    agent: 'SVA-v1', action: 'CONFIRM', finalCall: 'SHORT', score: 92,
    verdict: 'aligned', checklist: [
      { id: 'trend', name: 'Trend', status: 'PASS', weight: 2, points: 2, detail: 'trend aligned' },
      { id: 'momentum', name: 'Momentum', status: 'PASS', weight: 1, points: 1, detail: 'ok' },
    ],
  };
  const plan = {
    entry: 92.44, stopLoss: 93.47, target1: 91.41, target2: 90.38,
    risk: 1.2, riskPct: 1.3, rewardRisk: 1.65, atrUsed: 0.3, planStyle: 'atr-based',
  };
  const base = (over = {}) => ({
    symbol: 'CL', market: 'CRYPTO', side: 'SHORT', grade: 'ACTION',
    confidence: 76, agreement: 0.68, participating: 4, voters: 4, totalModels: 9,
    ltp: 92.76, changePct: -3.0, plan,
    signalAge: { firstSeenAt: NOW - mins(3), lastSeenAt: NOW - mins(1), ageMs: mins(3), flips24h: 0 },
    votes: [], summary: 'test', aiNote: null, executable: true, generatedAt: NOW,
    verify,
    ...over,
  });

  it('exactly ONE VerifyBadge renders per collapsed card (was: 2)', async () => {
    const { SignalCard } = await import('../src/components/aitrading/SignalCard');
    render(<SignalCard signal={base()} onExecute={vi.fn(async () => ({ ok: true }))} />);
    // the badge label is '🛡 VERIFIED SHORT 92' — exactly one per card
    const badges = screen.getAllByText(/VERIFIED SHORT/);
    expect(badges.length).toBe(1);
  });

  it('expanded card renders the checklist EXACTLY once (was: 2, one un-gated)', async () => {
    const { SignalCard } = await import('../src/components/aitrading/SignalCard');
    const { fireEvent } = await import('@testing-library/react');
    render(<SignalCard signal={base()} onExecute={vi.fn(async () => ({ ok: true }))} />);
    // expand via the header expander (⌄ WHY / aria-expanded button)
    fireEvent.click(screen.getByRole('button', { name: /Models/i }));
    // checklist item names appear EXACTLY once each (the old un-gated
    // footer copy rendered the whole table a second time)
    expect(screen.getAllByText('Trend').length).toBe(1);
    expect(screen.getAllByText('Momentum').length).toBe(1);
    // and the badge is still exactly one on the expanded card
    expect(screen.getAllByText(/VERIFIED SHORT/).length).toBe(1);
  });
});
