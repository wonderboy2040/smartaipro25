// ============================================================
// test/liveSourceBadge.test.tsx — v10.11 (#1) the source-
// transparency badge contract.
//
// THE ASK (user plan): "a small tag next to the live price —
// CoinDCX·RT (green), Finnhub·RT (blue), Yahoo·delayed (amber) —
// only rendered when liveLtp != null."
//
// THE CONTRACT (locked here):
//   • Every server source label maps to its honest pill:
//       coindcx-*            → CoinDCX·RT   (emerald)
//       finnhub-global-rt    → Finnhub·RT   (sky)
//       binance-*            → Binance·RT   (sky, honest fallback label)
//       yahoo-global-rt      → Yahoo·delayed (amber)
//       global-sim-rt        → SIM·synthetic (slate)
//   • Unknown/missing source → neutral LIVE pill (the price IS live,
//     the provenance just wasn't labeled — never a blank, never a
//     wrong guess).
//   • The badge renders ONLY beside a live price (SignalCard gates
//     it on liveLtp != null — locked by the render test below).
// ============================================================
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { LiveSourceBadge, liveSourceBadge } from '../src/components/aitrading/LiveSourceBadge';
import { SignalCard } from '../src/components/aitrading/SignalCard';
import type { AISignal } from '../src/components/aitrading/types';

describe('liveSourceBadge — the pure label mapping', () => {
  it('direct CoinDCX feeds (REST + WS, both domains) → CoinDCX·RT', () => {
    for (const src of ['coindcx-fut-rt', 'coindcx-fut-ws', 'coindcx-glob-rt', 'coindcx-glob-ws', 'coindcx-live']) {
      const b = liveSourceBadge(src);
      expect(b.label).toBe('CoinDCX·RT');
      expect(b.cls).toContain('emerald');
    }
  });
  it('finnhub-global-rt → Finnhub·RT (blue)', () => {
    const b = liveSourceBadge('finnhub-global-rt');
    expect(b.label).toBe('Finnhub·RT');
    expect(b.cls).toContain('sky');
  });
  it('binance fallbacks → Binance·RT; the WS accelerator gets its own ACC label (v20.9.3)', () => {
    for (const src of ['binance-fut-rt', 'binance-fut']) {
      expect(liveSourceBadge(src).label).toBe('Binance·RT');
    }
    // v20.9.3: the spot WS accelerator runs ALONGSIDE CoinDCX (INR projection) —
    // its own label, not the "both dark" perp-fallback tooltip
    expect(liveSourceBadge('binance-crypto-ws').label).toBe('Binance·ACC');
  });
  it('v10.15: binance-fut-ws → Binance·WS emerald (the SUB-SECOND accelerator tier, distinct from the 5s REST fallback)', () => {
    const b = liveSourceBadge('binance-fut-ws');
    expect(b.label).toBe('Binance·WS');
    expect(b.cls).toContain('emerald');
    expect(b.title).toContain('SUB-SECOND');
    // the REST fallback keeps its sky label — the two tiers stay distinct
    expect(liveSourceBadge('binance-fut-rt').label).toBe('Binance·RT');
    expect(liveSourceBadge('binance-fut-rt').cls).toContain('sky');
  });
  it('yahoo-global-rt → Yahoo·delayed (amber)', () => {
    const b = liveSourceBadge('yahoo-global-rt');
    expect(b.label).toBe('Yahoo·delayed');
    expect(b.cls).toContain('amber');
  });
  it('global-sim-rt → SIM·synthetic (slate)', () => {
    const b = liveSourceBadge('global-sim-rt');
    expect(b.label).toBe('SIM·synthetic');
    expect(b.cls).toContain('slate');
  });
  it('unknown or missing → NEUTRAL slate LIVE pill — never a green guess (v10.13)', () => {
    // v10.13 (deep-recheck M6): the default used to be GREEN — a label sink
    // that laundered delayed/unknown feeds into realtime-looking pills.
    // Unknown provenance must LOOK unknown.
    for (const src of [undefined, null, '', 'mystery-feed', 'some-future-typo']) {
      const b = liveSourceBadge(src);
      expect(b.label).toBe('LIVE');
      expect(b.cls).toContain('slate');
      expect(b.cls).not.toContain('emerald');
    }
  });
  it('v10.13: yahoo-us-fallback → amber Yahoo·delayed (was laundered green LIVE)', () => {
    const b = liveSourceBadge('yahoo-us-fallback');
    expect(b.label).toBe('Yahoo·delayed');
    expect(b.cls).toContain('amber');
  });
  it('v10.13: finnhub-stream (WS trades) vs finnhub-rest (REST bootstrap) map distinctly', () => {
    expect(liveSourceBadge('finnhub-stream').label).toBe('Finnhub·WS');
    expect(liveSourceBadge('finnhub-stream').cls).toContain('sky');
    expect(liveSourceBadge('finnhub-rest').label).toBe('Finnhub·RT');
    expect(liveSourceBadge('finnhub-rest').cls).toContain('sky');
  });
  it('v10.13: tv-us-batch → TV·batch (sky, scanner batch cadence)', () => {
    const b = liveSourceBadge('tv-us-batch');
    expect(b.label).toBe('TV·batch');
    expect(b.cls).toContain('sky');
  });
  it('groww-live → Groww·live (emerald) and tv-ws → TV·WS (sky) — India contract unchanged', () => {
    expect(liveSourceBadge('groww-live').label).toBe('Groww·live');
    expect(liveSourceBadge('groww-live').cls).toContain('emerald');
    expect(liveSourceBadge('tv-ws').label).toBe('TV·WS');
    expect(liveSourceBadge('tv-ws').cls).toContain('sky');
  });
});

describe('LiveSourceBadge — the pill render', () => {
  it('renders the mapped label', () => {
    render(<LiveSourceBadge src="finnhub-global-rt" />);
    expect(screen.getByText('Finnhub·RT')).toBeTruthy();
  });
});

describe('SignalCard — the badge renders ONLY beside a live price', () => {
  const base: AISignal = {
    id: 't1', market: 'FUTURES', symbol: 'BTC', side: 'LONG', grade: 'STRONG',
    confidence: 82, agreement: 0.8, voters: 10,
    ltp: 50_000, changePct: 2.5,
    reason: 'test', models: [], generatedAt: Date.now(),
  } as unknown as AISignal;

  it('liveLtp present + finnhub source → the Finnhub·RT pill shows next to ⚡ LIVE', () => {
    render(<SignalCard signal={base} liveLtp={61_000.5} liveSrc="finnhub-global-rt" />);
    expect(screen.getByText('⚡ LIVE')).toBeTruthy();
    expect(screen.getByText('Finnhub·RT')).toBeTruthy();
  });

  it('liveLtp present + coindcx WS source → CoinDCX·RT pill', () => {
    render(<SignalCard signal={base} liveLtp={61_000.5} liveSrc="coindcx-fut-ws" />);
    expect(screen.getByText('CoinDCX·RT')).toBeTruthy();
  });

  it('NO live tick → NO badge (and no ⚡ LIVE) — snapshot price only', () => {
    render(<SignalCard signal={base} />);
    expect(screen.queryByText('⚡ LIVE')).toBeNull();
    expect(screen.queryByText('CoinDCX·RT')).toBeNull();
    expect(screen.queryByText('Finnhub·RT')).toBeNull();
    expect(screen.queryByText('LIVE')).toBeNull();
  });
});
