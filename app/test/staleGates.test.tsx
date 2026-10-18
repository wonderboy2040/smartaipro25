// ============================================================
// test/staleGates.test.tsx — v18.6.1 Fix 3 / 4 / 5 (rendered)
// ------------------------------------------------------------
// The STALE badge finally has teeth + the live-tick invalidation strip
// + the PULLBACK semantics line. Component contract:
//   • stale ACTION card → badge reads 'ACTION · STALE' (display-only:
//     the underlying signal.grade is untouched)
//   • stale card paper click → CONFIRM BAR opens, onExecute NOT fired;
//     'Proceed anyway →' fires it; 'Recheck karo' calls onDeep
//   • fresh card paper click → fires instantly, zero friction
//   • liveLtp through SL → red 'PLAN INVALIDATED' strip, buttons stay
//     enabled (informative warn, never fake-block)
//   • blueprint PULLBACK entry window → the "ye dip/bounce hi entry
//     trigger hai" line renders
// Both the Intraday tab (INDIA desk) and the CoinDCX tab (CRYPTO /
// FUTURES desks) render this same SignalCard → these gates cover all
// signals on both tabs.
// ============================================================
// @ts-nocheck
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { SignalCard } from '../src/components/aitrading/SignalCard';
import type { AISignal } from '../src/components/aitrading/types';

const NOW = Date.now();
const mins = (m) => m * 60_000;

const plan = {
  // CL-accurate geometry (the trigger case): entry 92.44, SL 93.47,
  // T1 91.41, T2 90.38, ATR 0.3 — SHORT sell-the-bounce design.
  entry: 92.44, stopLoss: 93.47, target1: 91.41, target2: 90.38,
  risk: 1.2, riskPct: 1.3, rewardRisk: 1.65, atrUsed: 0.3, planStyle: 'atr-based',
};

const base = (over = {}): AISignal => ({
  symbol: 'CL', market: 'CRYPTO', side: 'SHORT', grade: 'ACTION',
  confidence: 76, agreement: 0.68, participating: 4, voters: 4, totalModels: 9,
  ltp: 92.76, changePct: -3.0, plan,
  superIntel: {
    aiScore: 76, tier: 'ACTION', drivers: ['momentum'],
    blueprint: {
      side: 'SHORT', entry: 92.44, entryZone: [92.38, 92.67],
      entryTiming: { mode: 'PULLBACK', note: 'sell the bounce' },
      stopLoss: 93.47, targets: { t1: 91.41, t2: 90.38, t3: 89.5 },
      leverage: 3, maxSaneLeverage: 5, liquidation: 109.5,
      leverageNote: '3x sane for this stop',
      exitPlan: [
        { at: 91.41, bookPct: 40, action: 'book T1' },
        { at: 90.38, bookPct: 40, action: 'book T2' },
        { at: 89.5, bookPct: 20, action: 'runner trail' },
      ],
      exitBy: '8h', horizon: { label: 'intraday', hours: 8, note: 'high vol' },
      invalidation: 'close above 93.47',
    },
  },
  votes: [
    { id: 'm1', name: 'Trend Model', role: 'trend', dir: -1, conf: 80, weight: 1.2, reasons: ['ema aligned'] },
  ],
  signalAge: { firstSeenAt: NOW - mins(80), lastSeenAt: NOW - mins(67), ageMs: mins(80), flips24h: 0 },
  summary: 'test', aiNote: null, executable: true, generatedAt: NOW,
  ...over,
});

const noopExec = vi.fn(async () => ({ ok: true }));

describe('v18.6.1 Fix 3a — stale grade badge display downgrade', () => {
  it('stale ACTION card shows ACTION · STALE (underlying grade untouched)', () => {
    render(<SignalCard signal={base()} onExecute={noopExec} />);
    expect(screen.getByText('ACTION · STALE')).toBeTruthy();
    // the age chip still tells the full truth too (badge + chip = 2 STALE texts)
    expect(screen.getAllByText(/STALE/).length).toBeGreaterThanOrEqual(2);
  });
  it('fresh card keeps the plain badge (zero visual friction)', () => {
    render(<SignalCard signal={base({ signalAge: { firstSeenAt: NOW - mins(3), lastSeenAt: NOW - mins(1), ageMs: mins(3), flips24h: 0 } })} onExecute={noopExec} />);
    expect(screen.queryByText('ACTION · STALE')).toBeNull();
    expect(screen.getByText('ACTION')).toBeTruthy();
  });
});

describe('v18.6.1 Fix 3b — stale paper-trade confirm bar', () => {
  it('stale: PAPER click opens the confirm bar instead of firing', () => {
    noopExec.mockClear();
    render(<SignalCard signal={base()} onExecute={noopExec} />);
    fireEvent.click(screen.getByRole('button', { name: /🧪 PAPER TRADE/ }));
    expect(screen.getByTestId('stale-confirm-bar')).toBeTruthy();
    expect(screen.getByText(/re-confirm NAHI kiya/)).toBeTruthy();
    expect(noopExec).not.toHaveBeenCalled();
  });
  it("'Proceed anyway →' fires the original paper action", () => {
    noopExec.mockClear();
    render(<SignalCard signal={base()} onExecute={noopExec} />);
    fireEvent.click(screen.getByRole('button', { name: /🧪 PAPER TRADE/ }));
    fireEvent.click(screen.getByRole('button', { name: /Proceed anyway/ }));
    expect(noopExec).toHaveBeenCalledTimes(1);
    expect(noopExec.mock.calls[0][1]).toBe('paper');
    expect(screen.queryByTestId('stale-confirm-bar')).toBeNull();
  });
  it("'Recheck karo' calls onDeep (deep re-analysis) and dismisses", () => {
    const onDeep = vi.fn();
    noopExec.mockClear();
    render(<SignalCard signal={base()} onExecute={noopExec} onDeep={onDeep} />);
    fireEvent.click(screen.getByRole('button', { name: /🧪 PAPER TRADE/ }));
    fireEvent.click(screen.getByRole('button', { name: /Recheck karo/ }));
    expect(onDeep).toHaveBeenCalledTimes(1);
    expect(noopExec).not.toHaveBeenCalled();
    expect(screen.queryByTestId('stale-confirm-bar')).toBeNull();
  });
  it('fresh: PAPER click fires instantly — no confirm bar', () => {
    noopExec.mockClear();
    render(<SignalCard signal={base({ signalAge: { firstSeenAt: NOW - mins(3), lastSeenAt: NOW - mins(1), ageMs: mins(3), flips24h: 0 } })} onExecute={noopExec} />);
    fireEvent.click(screen.getByRole('button', { name: /🧪 PAPER TRADE/ }));
    expect(noopExec).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('stale-confirm-bar')).toBeNull();
  });
});

describe('v18.6.1 Fix 4 — between-cycle live-price invalidation strip', () => {
  it('SHORT with live price through SL → red PLAN INVALIDATED strip', () => {
    render(<SignalCard signal={base()} onExecute={noopExec} liveLtp={93.6} />);
    const strip = screen.getByTestId('live-invalidation-strip');
    expect(strip.textContent).toContain('PLAN INVALIDATED');
    expect(strip.textContent).toContain('93.6');
  });
  it('buttons remain clickable (informative warn, never fake-block)', () => {
    render(<SignalCard signal={base()} onExecute={noopExec} liveLtp={93.6} />);
    expect(screen.getByRole('button', { name: /🧪 PAPER TRADE/ }).disabled).toBe(false);
  });
  it('price past the far zone edge but under SL → amber weakening strip', () => {
    // SHORT far edge = 92.67 (zone high); live 93.10 is 0.43 past it (>0.5×ATR=0.15)
    // but still under SL 93.47 → WEAKENING, not invalidated
    render(<SignalCard signal={base()} onExecute={noopExec} liveLtp={93.10} />);
    const strip = screen.getByTestId('live-invalidation-strip');
    expect(strip.textContent).toContain('weakening');
    expect(strip.textContent).not.toContain('INVALIDATED');
  });
  it('LONG weakening: dip ran 0.5×ATR below the zone low, above SL', () => {
    const longPlan = { ...plan, stopLoss: 91.41 };
    render(<SignalCard signal={base({ side: 'LONG', plan: longPlan })} onExecute={noopExec} liveLtp={91.90} />);
    const strip = screen.getByTestId('live-invalidation-strip');
    expect(strip.textContent).toContain('weakening');
  });
  it('healthy live price inside the design → NO strip (the CL trigger case)', () => {
    // live 92.76: 0.09 above the zone high (< 0.5×ATR=0.15), under SL
    render(<SignalCard signal={base()} onExecute={noopExec} liveLtp={92.76} />);
    expect(screen.queryByTestId('live-invalidation-strip')).toBeNull();
  });
  it('no live tick / no plan → no strip (honest degrade)', () => {
    render(<SignalCard signal={base()} onExecute={noopExec} />);
    expect(screen.queryByTestId('live-invalidation-strip')).toBeNull();
    render(<SignalCard signal={base({ plan: null })} onExecute={noopExec} liveLtp={93.6} />);
    expect(screen.queryByTestId('live-invalidation-strip')).toBeNull();
  });
});

describe('v18.6.1 Fix 5 — PULLBACK entry semantics line', () => {
  it('PULLBACK mode renders the "bounce hi entry trigger hai" line on a SHORT', () => {
    render(<SignalCard signal={base()} onExecute={noopExec} />);
    const note = screen.getByTestId('pullback-entry-note');
    expect(note.textContent).toContain('bounce hi entry trigger hai');
    expect(note.textContent).toContain('rally SELL');
    expect(note.textContent).toContain('93.47'); // SL level in the copy
  });
  it('LONG PULLBACK says dip/dip BUY; IMMEDIATE mode says nothing extra', () => {
    render(<SignalCard signal={base({ side: 'LONG', grade: 'ACTION' })} onExecute={noopExec} />);
    expect(screen.getByTestId('pullback-entry-note').textContent).toContain('dip BUY');
    render(<SignalCard signal={base({
      side: 'LONG',
      superIntel: { ...base().superIntel, blueprint: { ...base().superIntel.blueprint, entryTiming: { mode: 'IMMEDIATE', note: 'now' } } },
    })} onExecute={noopExec} />);
    // second render (IMMEDIATE) must not carry a pullback note
    expect(screen.getAllByTestId('pullback-entry-note')).toHaveLength(1); // only the first card's
  });
});
