// ============================================================
// v21.23.1 SAPTA (proTraderAuto) DIRECTION-LOCK ACQUIRE test
// ------------------------------------------------------------
// THE GAP (latest-repo audit): proTraderGate sirf `checkDirectionLock`
// karta tha — SAPTA ki trades lock ACQUIRE nahi karti thi, isliye
// doosre engines (agent / MTF auto / india-agent) ko SAPTA ki position
// ka pata nahi chalta tha aur koi bhi engine usi symbol par OPPOSITE
// side trade khol sakta tha.
//
// THE FIX: `_tryEntry` → `_saveTrade` ke turant baad (status
// MONITORING/PLACED) `acquireDirectionLock({ source: 'protrader-auto' })`.
// Release routes.js ke 60s `reconcileDirectionLocks` sweep se hota hai
// (SAPTA positions `proTraderStatusView().positions` me dikhti hain).
// Store mocked → koi real server/data write nahi.
// ============================================================
import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';

vi.mock('../server/lib/store.js', () => ({
  loadJSON: (_file: string, def: unknown) => (def ?? {}),
  saveJSON: vi.fn(() => true),
  DATA_DIR: '/tmp/unused-protrader-lock-test',
}));

import { PROTRADER_DEFAULTS, proTraderGate, __internals } from '../server/ai/proTraderAuto.js';
import {
  acquireDirectionLock,
  checkDirectionLock,
  getDirectionLocks,
  __resetDirectionLocksForTests,
} from '../server/ai/directionLock.js';

// IST 10:30 Friday — NSE entry window open (sizing + market-open gates pass).
const FAKE_NOW = new Date('2026-09-11T05:00:00Z');
beforeAll(() => { vi.useFakeTimers(); vi.setSystemTime(FAKE_NOW); });
afterAll(() => vi.useRealTimers());

const strongIndiaSignal = () => ({
  symbol: 'ITC',
  market: 'INDIA',
  side: 'LONG',
  grade: 'STRONG',
  confidence: 82,
  ltp: 412,
  executable: false, // INDIA desk exempt from the executable gate
  superIntel: { aiScore: 86 },
  verify: { action: 'CONFIRM', finalCall: 'LONG', score: 84 },
  plan: { entry: 412, stopLoss: 408, target1: 420, target2: 428 },
});

describe('v21.23.1 SAPTA entry acquires the cross-engine direction lock', () => {
  beforeEach(() => __resetDirectionLocksForTests());

  it('paper-mode entry stamps acquireDirectionLock(source: protrader-auto) — opposite side now blocked for other engines', async () => {
    const cfg = { ...PROTRADER_DEFAULTS, mode: 'paper', stakeINR: 2000, enabled: true };
    const before = checkDirectionLock('ITC', 'SHORT');
    expect(before.allowed).toBe(true); // no lock yet

    const r = await __internals._tryEntry({}, cfg, strongIndiaSignal(), null);
    expect(r?.ok).toBe(true);
    expect(r?.trade?.status).toBe('MONITORING');

    // SAPTA ki trade ab doosre engines ko direction-lock me dikhti hai
    const locks = getDirectionLocks();
    const itc = locks.find(l => l.symbol === 'ITC');
    expect(itc).toBeTruthy();
    expect(itc?.side).toBe('LONG');
    expect(itc?.source).toBe('protrader-auto');
    expect(itc?.active).toBe(true);

    const after = checkDirectionLock('ITC', 'SHORT');
    expect(after.allowed).toBe(false);
    expect(after.lockedBy).toBe('protrader-auto');
    expect(after.reason).toContain('cross-engine direction lock');
    // same side still fine
    expect(checkDirectionLock('ITC', 'LONG').allowed).toBe(true);
  });

  it('proTraderGate still blocks SAPTA when ANOTHER engine already holds the opposite-side lock', () => {
    acquireDirectionLock({ symbol: 'ITC', side: 'SHORT', source: 'agent', cooldownMin: 240 });
    const g = proTraderGate(strongIndiaSignal(), PROTRADER_DEFAULTS);
    expect(g.pass).toBe(false);
    expect(g.reasons).toContain('direction-lock:SHORT');
  });
});
