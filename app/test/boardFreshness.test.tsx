// ============================================================
// test/boardFreshness.test.tsx — v10.9 #8 SIGNAL FRESHNESS DECAY
// ------------------------------------------------------------
// Pins the pure grading (live <2m / aging 2-5m / stale >5m), the
// opacity ramp classes, and the rendered badge states.
// ============================================================
// @ts-nocheck
import { describe, it, expect, vi } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import { boardAgeInfo, boardStaleClass, FreshnessBadge } from '../src/components/aitrading/deskShared';
import type { SignalBoard } from '../src/components/aitrading/types';

const boardAt = (generatedAt: number): SignalBoard => ({ generatedAt, signals: [] } as any);

describe('boardAgeInfo (pure grading)', () => {
  const NOW = 1_000_000_000_000;
  it('no board → none', () => {
    expect(boardAgeInfo(null, NOW)).toEqual({ ageMin: null, level: 'none' });
    expect(boardAgeInfo({} as any, NOW).level).toBe('none');
  });
  it('fresh board → live', () => {
    expect(boardAgeInfo(boardAt(NOW - 60_000), NOW).level).toBe('live');
    expect(boardAgeInfo(boardAt(NOW - 119_999), NOW).level).toBe('live');
  });
  it('2-5 min → aging', () => {
    expect(boardAgeInfo(boardAt(NOW - 2 * 60_000), NOW).level).toBe('aging');
    expect(boardAgeInfo(boardAt(NOW - 4.9 * 60_000), NOW).level).toBe('aging');
  });
  it('>5 min → stale (the Intraday-tab concept)', () => {
    expect(boardAgeInfo(boardAt(NOW - 5 * 60_000), NOW).level).toBe('stale');
    expect(boardAgeInfo(boardAt(NOW - 42 * 60_000), NOW).level).toBe('stale');
  });
  it('future timestamps clamp to live (never negative ages)', () => {
    expect(boardAgeInfo(boardAt(NOW + 60_000), NOW).level).toBe('live');
  });
});

describe('boardStaleClass (the opacity ramp)', () => {
  const NOW = 1_000_000_000_000;
  it('live → no decay', () => {
    expect(boardStaleClass(boardAt(NOW - 30_000), NOW)).toBe('');
  });
  it('aging → 80% opacity', () => {
    expect(boardStaleClass(boardAt(NOW - 3 * 60_000), NOW)).toMatch(/opacity-80/);
  });
  it('stale → 50% opacity', () => {
    expect(boardStaleClass(boardAt(NOW - 8 * 60_000), NOW)).toMatch(/opacity-50/);
  });
});

describe('FreshnessBadge (rendered)', () => {
  it('renders LIVE for a fresh board', () => {
    render(<FreshnessBadge board={boardAt(Date.now() - 30_000)} />);
    expect(screen.getByText('LIVE')).toBeTruthy();
  });
  it('renders Xm old for an aging board', () => {
    render(<FreshnessBadge board={boardAt(Date.now() - 3 * 60_000)} />);
    expect(screen.getByText(/3m old/)).toBeTruthy();
  });
  it('renders the STALE warning past 5 minutes', () => {
    render(<FreshnessBadge board={boardAt(Date.now() - 7 * 60_000)} />);
    expect(screen.getByText(/STALE 7m/)).toBeTruthy();
  });
  it('renders nothing without a board', () => {
    const { container } = render(<FreshnessBadge board={null} />);
    expect(container.firstChild).toBeNull();
  });
});
