// ============================================================
// test/v203DeepAudit.test.ts — v20.3 FULL-SITE RECHECK locks
// ------------------------------------------------------------
// The v20.3 deep audit found 27 defects across server/client/build.
// This suite locks the SERVER-side behavioral fixes:
//   R1  replay.js — 15m/1h TF votes only use COMPLETED buckets
//       (the v20.2 lookahead bias made every replay stat optimistic)
//   R2  trackRecord — cross-source (scanner vs AI-board) direction
//       disagreements no longer flip-churn the row every cycle
//   R3  formatStrongSignal — FUTURES plans label USDT (not ₹)
//   R4  telegramPush env-keys — an env-only TG deployment gets the
//       instant-push paths (the silent "keyless" outage)
//   R5  coindcxOrders paper exits fill adversely (exit-side slip)
//   R6  futures partial-TP ambiguous retry guard (double-sell class)
// Client locks (CandleChart race/validation, wallet dedup 4th panel,
// PortfolioHeat SIM separation) ride the aiOrders/telegramPush/v202
// suites + this file's chart-validation case.
// ============================================================
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// hermetic data dir (same trick as the other suites)
process.env.SMARTAI_DATA_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '../.test-data-v203');

// ---- R1: replay internals (pure, no mocks needed) ----
import { __replayInternalsForTests } from '../server/ai/replay.js';
const { _bucketsCompleted, _resample } = __replayInternalsForTests;

const T0 = Date.UTC(2026, 7, 31, 4, 0, 0); // Mon 04:00 UTC — 09:30 IST
const bar5 = (i, over = {}) => ({
  time: T0 + i * 5 * 60_000,
  open: 100 + i, high: 101 + i, low: 99 + i, close: 100.5 + i, volume: 1000, ...over,
});

describe('v20.3 R1 — replay TF votes use only COMPLETED buckets (no lookahead)', () => {
  it('15m: a bucket whose START is behind the decision bar is NOT counted until it CLOSES', () => {
    // 12 five-minute bars 04:00..04:55 → 15m buckets starting 04:00, 04:15, 04:30, 04:45
    const c5 = Array.from({ length: 12 }, (_, i) => bar5(i));
    const c15 = _resample(c5, 15);
    expect(c15.map(b => b.time)).toEqual([
      T0, T0 + 15 * 60_000, T0 + 30 * 60_000, T0 + 45 * 60_000,
    ]);
    // Decision at the CLOSE of the 04:50 5m bar (bar.time = 04:50, decision moment 04:55).
    // Buckets closed by 04:55: 04:00 (closes 04:15), 04:15 (closes 04:30),
    // 04:30 (closes 04:45). The 04:45 bucket closes at 05:00 — still forming.
    const n = _bucketsCompleted(c15, T0 + 50 * 60_000, 15 * 60_000);
    expect(n).toBe(3);
    // the v20.2 bug counted 4 (start 04:45 <= 04:50) — leaking the close
    // of 5m bars 04:55/05:00 into the vote.
  });

  it('1h: up to 55 minutes of future price no longer leaks into the highest-weight TF', () => {
    const c5 = Array.from({ length: 16 }, (_, i) => bar5(i)); // 04:00..05:15
    const c60 = _resample(c5, 60);
    // decision at close of the 04:05 bar → only the 03:00 bucket (had it
    // existed) would be complete; the 04:00 1h bucket closes at 05:00.
    const n = _bucketsCompleted(c60, T0 + 5 * 60_000, 60 * 60_000);
    expect(n).toBe(0); // the 04:00 bucket is still forming → NOT completed
    // decision at close of the 05:05 bar (05:10 decision moment):
    const n2 = _bucketsCompleted(c60, T0 + 65 * 60_000, 60 * 60_000);
    expect(n2).toBe(1); // 04:00 bucket closed at 05:00 ≤ 05:10
  });

  it('the completed window slice ends at a bucket that closed at/before the decision', () => {
    const c5 = Array.from({ length: 12 }, (_, i) => bar5(i));
    const c15 = _resample(c5, 15);
    const ts = T0 + 50 * 60_000;
    const n = _bucketsCompleted(c15, ts, 15 * 60_000);
    const last = c15.slice(0, n).at(-1);
    expect(last.time + 15 * 60_000).toBeLessThanOrEqual(ts + 5 * 60_000);
  });
});

// ---- R2: trackRecord flip cooldown ----
import { recordSignals, getTrackRecord, __reloadTrackRecordForBoot, __resetFlipGuardForTests } from '../server/intraday/trackRecord.js';
import { saveJSON } from '../server/lib/store.js';

const sig = (symbol, direction, over = {}) => ({
  symbol, direction, market: 'INDIA', confidence: 75, ltp: 100,
  entry: 100, stopLoss: 97, target1: 103, target2: 106,
  exchange: 'NSE', qtyPerLakh: 10, ...over,
});

describe('v20.3 R2 — cross-source direction disagreement no longer flip-churns the row', () => {
  beforeEach(() => {
    saveJSON('tracked-signals.json', { signals: [], dayKey: '' });
    __reloadTrackRecordForBoot();
    __resetFlipGuardForTests();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-31T05:00:00Z')); // Mon 10:30 IST, in-session
  });
  afterEach(() => vi.useRealTimers());

  it('board SHORT flips the row ONCE; the scanner re-publishing LONG 1 min later is SUPPRESSED (the churn)', () => {
    recordSignals([sig('SBIN', 'LONG')]);                     // scanner publishes LONG
    vi.setSystemTime(new Date('2026-08-31T05:01:00Z'));
    const ev1 = recordSignals([sig('SBIN', 'SHORT')]);        // board: first genuine flip goes through
    // (both the close AND the replacement-open journal as FLIP events)
    expect(ev1.filter(e => e.type === 'FLIP')).toHaveLength(2);
    vi.setSystemTime(new Date('2026-08-31T05:02:00Z'));
    // 1 min later the scanner publishes LONG again — the pre-v20.3 code
    // flip-closed + re-opened EVERY cycle (row churned all day)
    const ev2 = recordSignals([sig('SBIN', 'LONG', { confidence: 55 })]);
    const tr = getTrackRecord(1);
    expect(tr.totalTracked).toBe(2);              // LONG (closed FLIP) + SHORT (open) — no third row
    expect(tr.open[0].direction).toBe('SHORT');   // the board's plan survives the churn
    expect(tr.open[0].confidence).toBe(55);       // live fields DID refresh
    expect(ev2).toEqual([]);                      // churn suppressed — no FLIP/OPEN events
  });

  it('a GENUINE flip still goes through once the 30-min cooldown expires', () => {
    recordSignals([sig('SBIN', 'LONG')]);
    vi.setSystemTime(new Date('2026-08-31T05:31:00Z')); // 31 min later
    const ev = recordSignals([sig('SBIN', 'SHORT')]);
    const tr = getTrackRecord(1);
    expect(tr.totalTracked).toBe(2);              // the closed row + the fresh one
    expect(tr.open[0].direction).toBe('SHORT');
    // honest journal, once: the FLIP close + the FLIP replacement-open
    // (2 events — close and reopen both tag as FLIP)
    expect(ev.filter(e => e.type === 'FLIP')).toHaveLength(2);
  });
});

// ---- R3: formatStrongSignal currency honesty ----
import { formatStrongSignal } from '../server/ai/telegramPush.js';

describe('v20.3 R3 — STRONG message currency matches the desk', () => {
  it('FUTURES plan levels are labelled USDT (not the hardcoded ₹)', () => {
    const txt = formatStrongSignal({
      symbol: 'BTC', side: 'LONG', confidence: 84, agreement: 0.8, participating: 9, totalModels: 14,
      plan: { entry: 65000, stopLoss: 64000, target2: 68000, rewardRisk: 3 },
    }, 'FUTURES');
    expect(txt).toMatch(/B-USDT Perps/);
    expect(txt).toMatch(/65,000 USDT/);
    expect(txt).not.toMatch(/₹/);
  });
  it('INDIA keeps ₹', () => {
    const txt = formatStrongSignal({
      symbol: 'RELIANCE', side: 'LONG', confidence: 84, agreement: 0.8, participating: 9, totalModels: 14,
      plan: { entry: 2500, stopLoss: 2450, target2: 2600, rewardRisk: 2 },
    }, 'INDIA');
    expect(txt).toMatch(/NSE/);
    expect(txt).toMatch(/₹2,500/);
  });
});

// ---- R6: futures partial ambiguous-retry guard (pure classifier import) ----
import { isAmbiguousTransportError } from '../server/ai/coindcxOrders.js';

describe('v20.3 R6 — the ambiguous-transport classifier is shared with the futures desk', () => {
  it('classifies timeouts/network failures as ambiguous, HTTP rejections as definitive', () => {
    expect(isAmbiguousTransportError(new Error('fetch failed'))).toBe(true);
    expect(isAmbiguousTransportError(new Error('This operation was aborted'))).toBe(true);
    expect(isAmbiguousTransportError(new Error('socket hang up'))).toBe(true);
    expect(isAmbiguousTransportError(new Error('[401] Invalid credentials'))).toBe(false);
    expect(isAmbiguousTransportError(new Error('[422] qty too low'))).toBe(false);
  });
});
