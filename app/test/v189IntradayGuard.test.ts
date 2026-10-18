// ============================================================
// test/v189IntradayGuard.test.ts — v18.9 INTRADAY GUARDS
// ------------------------------------------------------------
//   1. paperTrading evaluatePaper: per-tick day-rollover guard
//      (a non-CRYPTO trade from a previous IST day closes
//      STALE_SQOFF instead of being managed against today's prices)
//   2. trackRecord recordSignals: OPEN row levels are FROZEN at
//      first publish (confidence/lastPrice still refresh)
//   3. committee runCommitteeDebate: 2-of-3 persona quorum
// ============================================================
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../server/intraday/store.js', () => ({
  loadJSON: () => ({ signals: [], trades: [], nextId: 1, dayKey: '' }),
  saveJSON: vi.fn(() => true),
  DATA_DIR: '/tmp/unused',
}));
vi.mock('../server/intraday/journal.js', () => ({
  recordTradeClose: vi.fn(),
}));
// committee's askLLM — lives in intraday/agent.js. QUEUE-fed (call order
// is irrelevant; Promise.all fires the 3 persona calls before any body
// runs). Returns the { text, engine } shape the committee expects.
let _llmQueue: (string | null)[] = [];
const askLLM = vi.fn(async () => {
  const a = _llmQueue.shift() ?? null;
  return a == null ? null : { text: a, engine: 'mock' };
});
vi.mock('../server/intraday/agent.js', () => ({
  askLLM: (...a: unknown[]) => askLLM(...(a as never[])),
}));

const paper = await import('../server/intraday/paperTrading.js');
const track = await import('../server/intraday/trackRecord.js');
const committee = await import('../server/intraday/committee.js');

// Wed 2026-01-14 11:00 IST (NSE open) and Thu 2026-01-15 09:30 IST
const WED_1100 = new Date('2026-01-14T05:30:00Z').getTime();
const THU_0930 = new Date('2026-01-15T04:00:00Z').getTime();

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(WED_1100);
  paper._resetForTests();
  track.__reloadTrackRecordForBoot();
  _llmQueue = [];
  askLLM.mockClear();
});
afterEach(() => { vi.useRealTimers(); });

// ---------------- 1. paper day-rollover ----------------
describe('v18.9 paper #1 — evaluatePaper day-rollover guard', () => {
  it('a Tuesday NSE trade evaluated on Wednesday closes STALE_SQOFF (no next-day management)', () => {
    // open on Wednesday (today) — then time-travel to Thursday
    const open = paper.openPaperTrade({
      symbol: 'SBIN', direction: 'LONG', entry: 800, qty: 10, stopLoss: 780, target1: 820, target2: 850,
    });
    expect(open.ok).toBe(true);

    vi.setSystemTime(THU_0930); // next session, 09:30 IST
    const events: any[] = [];
    paper.evaluatePaper({ SBIN: { price: 795 } }, events); // between SL and T1
    const ev = events.find(e => e.type === 'PAPER_CLOSE');
    expect(ev).toBeTruthy();
    expect(ev.note).toMatch(/stale-day square-off/);
    const s = paper.getPaperSummary();
    expect(s.open.length).toBe(0);
  });

  it('CRYPTO trades roll on UTC days — no NSE rollover close', () => {
    const open = paper.openPaperTrade({
      symbol: 'BTC', market: 'CRYPTO', direction: 'LONG', entry: 100, qty: 0.5, stopLoss: 95,
    });
    expect(open.ok).toBe(true);
    vi.setSystemTime(THU_0930);
    const events: any[] = [];
    paper.evaluatePaper({ BTC: { price: 97 } }, events);
    expect(events.find(e => e.type === 'PAPER_CLOSE')).toBeFalsy(); // still managed, not force-closed
    expect(paper.getPaperSummary().open.length).toBe(1);
  });

  it('same-day trade is untouched by the guard (normal SL/T1 still applies)', () => {
    paper.openPaperTrade({
      symbol: 'SBIN', direction: 'LONG', entry: 800, qty: 10, stopLoss: 780, target1: 820, target2: 850,
    });
    const events: any[] = [];
    paper.evaluatePaper({ SBIN: { price: 795 } }, events);
    expect(events.find(e => e.type === 'PAPER_CLOSE')).toBeFalsy();
    expect(paper.getPaperSummary().open.length).toBe(1);
  });
});

// ---------------- 2. trackRecord level freeze ----------------
describe('v18.9 track #2 — OPEN row levels freeze at first publish', () => {
  const sig = (over = {}) => ({
    symbol: 'SBIN', market: 'INDIA', direction: 'LONG',
    entry: 800, stopLoss: 780, target1: 820, target2: 850,
    ltp: 800, qtyPerLakh: 12, confidence: 80, quantConfidence: 75,
    ...over,
  });

  it('a republish with new levels does NOT rewrite an OPEN row’s entry/SL/targets', () => {
    track.recordSignals([sig()]);
    // engine re-plans the same setup with lifted levels mid-life
    track.recordSignals([sig({ entry: 808, stopLoss: 795, target1: 830, target2: 860, confidence: 86, ltp: 808 })]);
    const rec = track.getTrackRecord(1);
    expect(rec.openCount).toBe(1);
    const row = rec.open[0];
    expect(row.entry).toBe(800);          // FROZEN
    expect(row.stopLoss).toBe(780);       // FROZEN
    expect(row.target1).toBe(820);        // FROZEN
    expect(row.target2).toBe(850);        // FROZEN
    expect(row.confidence).toBe(86);      // live field refreshes
    expect(row.lastPrice).toBe(808);      // live field refreshes
  });
});

// ---------------- 3. committee quorum ----------------
describe('v18.9 committee #3 — 2-of-3 persona quorum', () => {
  const DEPS = {
    getLastScan: () => ({
      signals: [{ symbol: 'RELIANCE', direction: 'LONG', entry: 100, stopLoss: 95, target1: 105, confidence: 80 }],
      marketRegime: { regime: 'BULLISH', vixLevel: 'LOW' },
    }),
    KEYS: {}, OPENAI_COMPAT: {},
  };

  it('only 1 persona answering → honest quorum fail (no fake "committee" verdict)', async () => {
    committee.clearCommitteeCache();
    _llmQueue = ['TAKE: RELIANCE trade hai', null, null, 'ignored judge']; // 1 of 3
    const r = await committee.runCommitteeDebate(DEPS as never);
    expect(r.ok).toBe(false);
    expect(String(r.error)).toMatch(/quorum/i);
  });

  it('all 3 answering → debate proceeds to the judge (no quorum block)', async () => {
    committee.clearCommitteeCache();
    _llmQueue = ['TAKE: scalp', 'TRADE: momentum', 'VETO-none: risk ok', 'FINAL: APPROVE — RELIANCE LONG'];
    const r = await committee.runCommitteeDebate(DEPS as never);
    expect(r.ok).toBe(true);
    expect(askLLM.mock.calls.length).toBeGreaterThanOrEqual(4); // 3 personas + judge
  });
});
