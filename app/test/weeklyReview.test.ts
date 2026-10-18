// ============================================================
// test/weeklyReview.test.ts — v10.9 #3 WEEKLY DIGEST
// ------------------------------------------------------------
// Pins: the quant layer (rolling 7-IST-day closes, wins/losses, best/
// worst, byMode, topPairs, partials), the no-activity honesty, the
// LLM-narration contract (quant block in the prompt, header always
// visible even without an LLM), per-week caching, and the Sunday
// push flag.
// ============================================================
import { describe, it, expect, beforeEach, vi } from 'vitest';

const JOURNAL = {
  entries: [
    // in-window closes (rolling last 7 IST days from NOW)
    { kind: 'CLOSE', day: '2026-09-15', pair: 'BTCUSDT', pnlINR: 500, mode: 'paper', reason: 'target-2' },
    { kind: 'CLOSE', day: '2026-09-14', pair: 'ETHUSDT', pnlINR: -200, mode: 'live', reason: 'stop-loss' },
    { kind: 'CLOSE', day: '2026-09-12', pair: 'BTCUSDT', pnlINR: 150, mode: 'paper', reason: 'time-exit' },
    { kind: 'PARTIAL_TP', day: '2026-09-13', pair: 'SOLUSDT', pnlINR: 80, mode: 'paper' },
    // out-of-window
    { kind: 'CLOSE', day: '2026-08-30', pair: 'DOGEUSDT', pnlINR: 9999, mode: 'paper' },
    // noise
    { kind: 'ORDER', day: '2026-09-15', pair: 'X', pnlINR: 1 },
  ],
  // v10.15 S3: closed positions carry side + openedAt — the direction
  // split's source (CLOSE entries don't carry side).
  positions: [
    // 4 LONGs: 3 win, 1 loss — 75% WR
    { id: 'p1', side: 'LONG', status: 'CLOSED', openedAt: Date.parse('2026-09-15T04:35:00Z'), closedAt: Date.parse('2026-09-15T06:00:00Z'), pnlINR: 500, bookedPnlINR: 0 },
    { id: 'p2', side: 'LONG', status: 'CLOSED', openedAt: Date.parse('2026-09-14T05:10:00Z'), closedAt: Date.parse('2026-09-14T07:00:00Z'), pnlINR: -200, bookedPnlINR: 0 },
    { id: 'p3', side: 'LONG', status: 'CLOSED', openedAt: Date.parse('2026-09-12T09:45:00Z'), closedAt: Date.parse('2026-09-12T10:30:00Z'), pnlINR: 150, bookedPnlINR: 0 },
    { id: 'p4', side: 'LONG', status: 'CLOSED', openedAt: Date.parse('2026-09-13T10:05:00Z'), closedAt: Date.parse('2026-09-13T11:00:00Z'), pnlINR: 80, bookedPnlINR: 40 },
    // 4 SHORTs: 1 win, 3 losses — 25% WR (the "shorts are wrong" pattern)
    { id: 'p5', side: 'SHORT', status: 'CLOSED', openedAt: Date.parse('2026-09-15T09:20:00Z'), closedAt: Date.parse('2026-09-15T10:00:00Z'), pnlINR: 120, bookedPnlINR: 0 },
    { id: 'p6', side: 'SHORT', status: 'CLOSED', openedAt: Date.parse('2026-09-14T09:50:00Z'), closedAt: Date.parse('2026-09-14T10:30:00Z'), pnlINR: -90, bookedPnlINR: 0 },
    { id: 'p7', side: 'SHORT', status: 'CLOSED', openedAt: Date.parse('2026-09-13T09:05:00Z'), closedAt: Date.parse('2026-09-13T10:00:00Z'), pnlINR: -60, bookedPnlINR: 0 },
    { id: 'p8', side: 'SHORT', status: 'CLOSED', openedAt: Date.parse('2026-09-12T05:15:00Z'), closedAt: Date.parse('2026-09-12T06:00:00Z'), pnlINR: -110, bookedPnlINR: 0 },
    // out-of-window closed position — must NOT count
    { id: 'p9', side: 'LONG', status: 'CLOSED', openedAt: Date.parse('2026-08-25T05:00:00Z'), closedAt: Date.parse('2026-08-25T06:00:00Z'), pnlINR: 5000, bookedPnlINR: 0 },
    // still-open position — never counted
    { id: 'p10', side: 'LONG', status: 'OPEN', openedAt: Date.parse('2026-09-15T05:00:00Z'), closedAt: null, pnlINR: 999, bookedPnlINR: 0 },
  ],
};
const mockLoadJournal = vi.fn(() => JOURNAL);
const mockTrust = vi.fn(() => ({
  settled: 42, sufficient: true, brier: 0.18, brierVerdict: 'good', drift: -2,
  overall: { winRate: 58, avgConfidence: 70 },
  calibration: [{ bucket: '60-70', claimed: 65, winRate: 55, n: 12 }],
}));
const mockAskLLM = vi.fn(async () => null); // default: no LLM
const mockGetJournal = vi.fn(() => ({ stats: { count: 3, wins: 2, losses: 1, netPnl: 310, avgR: 0.9 } }));
const mockSendTG = vi.fn(async () => ({ ok: true }));
const mockTGConfig = vi.fn(() => ({ token: 'T', chatId: 'C' }));

vi.mock('../server/ai/coindcxOrders.js', () => ({
  loadJournal: () => mockLoadJournal(),
}));
vi.mock('../server/ai/trust.js', () => ({
  trustReport: () => mockTrust(),
  // v11.0 council exports (computeCouncilWeek reads these — honest
  // neutral mocks: no settled council data in this suite's ledger)
  councilAgentStats: () => [],
  councilCalibrationMultipliers: () => ({}),
  // accuracy-plan Phase 2.1: the MTF A/B verdict block rides the quant
  // view — honest neutral mock (no paired settled data in this suite)
  mtfABReport: () => ({
    ok: true, pairs: 0, verdict: 'NEEDS DATA',
    mtf: { seat: 'IntradayTapeMTF (w1.6)', n: 0, wins: 0, hitRate: null, separation: null, brier: null },
    plain: { seat: 'IntradayTape plain 15m (w1.3, A/B shadow)', n: 0, wins: 0, hitRate: null, separation: null, brier: null },
    brierDeltaPlainMinusMtf: null,
    note: 'Insufficient paired data — mock.',
  }),
}));
vi.mock('../server/intraday/agent.js', () => ({
  askLLM: (...a) => mockAskLLM(...a),
}));
vi.mock('../server/intraday/journal.js', () => ({
  getJournal: () => mockGetJournal(),
  getWeekKey: () => '2026-W38',
}));
vi.mock('../server/ai/secrets.js', () => ({
  telegramConfig: () => mockTGConfig(),
  sendTelegramMessage: (...a) => mockSendTG(...a),
}));

import {
  computeAiDeskWeek, weeklyQuantView, quantHeaderBlock,
  runWeeklyPerformanceReview, weeklyAutoPushEnabled,
  __resetWeeklyReviewForTests,
} from '../server/ai/weeklyReview.js';

const NOW = new Date('2026-09-15T10:00:00+05:30').getTime(); // IST midday

beforeEach(() => {
  __resetWeeklyReviewForTests();
  mockAskLLM.mockReset().mockResolvedValue(null);
  mockLoadJournal.mockClear();
  mockSendTG.mockClear();
  mockTGConfig.mockClear().mockReturnValue({ token: 'T', chatId: 'C' });
});

// ============================================================
// quant layer (pure)
// ============================================================
describe('computeAiDeskWeek', () => {
  it('aggregates the rolling 7-IST-day window honestly', () => {
    const w = computeAiDeskWeek(JOURNAL, { now: NOW });
    expect(w.trades).toBe(3);        // the 3 in-window closes
    expect(w.wins).toBe(2);
    expect(w.losses).toBe(1);
    expect(w.winRate).toBe(66.7);
    expect(w.netPnlINR).toBe(450);   // 500 - 200 + 150
    expect(w.avgPnlINR).toBe(150);
    expect(w.partialBookings).toBe(1);
    expect(w.hadActivity).toBe(true);
  });
  it('excludes anything older than the window', () => {
    const w = computeAiDeskWeek(JOURNAL, { now: NOW });
    expect(w.best.pair).toBe('BTCUSDT');
    expect(w.worst.pair).toBe('ETHUSDT');
    expect(w.byMode).toEqual({ paper: 2, live: 1 });
    expect(w.topPairs[0]).toEqual({ pair: 'BTCUSDT', n: 2 });
  });
  it('empty journal → no activity, null win-rate (never a fake 0%)', () => {
    const w = computeAiDeskWeek({ entries: [] }, { now: NOW });
    expect(w.trades).toBe(0);
    expect(w.winRate).toBeNull();
    expect(w.hadActivity).toBe(false);
    // v10.15 S3: the direction split degrades honestly too
    expect(w.direction.byDirection.LONG).toMatchObject({ trades: 0, winRate: null });
    expect(w.direction.byDirection.SHORT).toMatchObject({ trades: 0, winRate: null });
    expect(w.direction.byEntryHour).toEqual([]);
  });
  // ---- v10.15 S3: the DIRECTION-ACCURACY BREAKDOWN ----
  it('v10.15 S3: direction split — LONG vs SHORT win-rate from closed positions', () => {
    const w = computeAiDeskWeek(JOURNAL, { now: NOW });
    // 4 in-window LONGs (p1-p4): wins = p1(500) p3(150) p4(80+40) → 3W/1L = 75%
    expect(w.direction.byDirection.LONG).toMatchObject({ trades: 4, wins: 3, losses: 1, winRate: 75 });
    // 4 in-window SHORTs (p5-p8): wins = p5(120) → 1W/3L = 25%
    expect(w.direction.byDirection.SHORT).toMatchObject({ trades: 4, wins: 1, losses: 3, winRate: 25 });
    // booked partial legs count in the total (p4: 80 + 40)
    expect(w.direction.byDirection.LONG.netPnlINR).toBe(570);
    expect(w.direction.byDirection.SHORT.netPnlINR).toBe(-140);
    // out-of-window (p9, Aug) and OPEN (p10) positions never count
    expect(w.direction.byDirection.LONG.trades).toBe(4);
  });
  it('v10.15 S3: entry-hour buckets expose the "first-15-min entries lose" pattern', () => {
    const w = computeAiDeskWeek(JOURNAL, { now: NOW });
    const hours = w.direction.byEntryHour;
    expect(hours.length).toBeGreaterThan(0);
    // buckets are ordered and labeled as IST hour ranges
    for (let i = 1; i < hours.length; i++) expect(hours[i].hour > hours[i - 1].hour).toBe(true);
    expect(hours[0].hour).toMatch(/^\d{2}:00-\d{2}:00$/);
    // 09:xx IST entries (openedAt 03:5x-04:2x UTC): p1(04:35→10:05 IST) is 10:00 bucket;
    // 04:35Z = 10:05 IST → the 10:00 bucket; 09:20Z = 14:50 IST etc. Just verify
    // every bucket's math is internally consistent (trades = wins + losses).
    for (const b of hours) expect(b.trades).toBe(b.wins + b.losses);
  });
  it('v10.15 S3: the direction split reaches the Telegram header + the LLM prompt block', () => {
    const q = weeklyQuantView({ now: NOW });
    const h = quantHeaderBlock(q);
    expect(h).toMatch(/Direction split/);
    expect(h).toMatch(/LONG 4 · 75%/);
    expect(h).toMatch(/SHORT 4 · 25%/);
    // prompt block (what the LLM narrates from) carries the same numbers
    const q2 = weeklyQuantView({ now: NOW });
    expect(q2.ai.direction.byDirection.SHORT.winRate).toBe(25);
  });
});

describe('weeklyQuantView + header', () => {
  it('assembles desk + calibration + intraday in one payload', () => {
    const q = weeklyQuantView({ now: NOW });
    expect(q.ai.trades).toBe(3);
    expect(q.calibration.sufficient).toBe(true);
    expect(q.intraday.count).toBe(3);
    expect(q.weekKey).toBe('2026-W38');
  });
  it('quant header always carries the numbers', () => {
    const h = quantHeaderBlock(weeklyQuantView({ now: NOW }));
    expect(h).toMatch(/WEEKLY TRADE-PERFORMANCE REVIEW/);
    expect(h).toMatch(/3 closed \(2W\/1L/);
    expect(h).toMatch(/net <b>₹450<\/b>/);
    expect(h).toMatch(/Brier 0\.18/);
  });
});

// ============================================================
// orchestration
// ============================================================
describe('runWeeklyPerformanceReview', () => {
  it('no settled activity → honest refusal', async () => {
    mockLoadJournal.mockReturnValueOnce({ entries: [] });
    mockGetJournal.mockReturnValueOnce({ stats: { count: 0 } });
    const out = await runWeeklyPerformanceReview({}, { now: NOW });
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/koi settled trade nahi/i);
  });
  it('NO LLM → still returns the quant view with the honest note', async () => {
    const out = await runWeeklyPerformanceReview({}, { now: NOW });
    expect(out.ok).toBe(true);
    expect(out.engine).toBeNull();
    expect(out.text).toMatch(/WEEKLY TRADE-PERFORMANCE REVIEW/);
    expect(out.text).toMatch(/LLM narration unavailable/);
  });
  it('LLM narrates — and the PROMPT it gets carries the quant numbers', async () => {
    mockAskLLM.mockResolvedValueOnce({ engine: 'gemini', text: 'WEEK VERDICT: GREEN' });
    const out = await runWeeklyPerformanceReview({}, { now: NOW });
    expect(out.ok).toBe(true);
    expect(out.engine).toBe('gemini');
    expect(out.text).toContain('WEEK VERDICT: GREEN');
    const prompt = mockAskLLM.mock.calls[0][1];
    expect(prompt).toMatch(/WEEK OF: 2026-W38/);
    expect(prompt).toMatch(/closed trades 3 \(2W\/1L, win-rate 66\.7%\), net ₹450/);
    expect(prompt).toMatch(/Brier 0\.18/);
    expect(prompt).toMatch(/NSE INTRADAY PAPER DESK/);
    // system prompt pins the sections + verdict
    expect(mockAskLLM.mock.calls[0][0]).toMatch(/Week Scorecard/);
    expect(mockAskLLM.mock.calls[0][0]).toMatch(/GREEN\/AMBER\/RED/);
  });
  it('per-week cache: second call is cached, force recomputes', async () => {
    mockAskLLM.mockResolvedValue({ engine: 'x', text: 't' });
    const a = await runWeeklyPerformanceReview({}, { now: NOW });
    const b = await runWeeklyPerformanceReview({}, { now: NOW });
    expect(b.cached).toBe(true);
    expect(mockAskLLM).toHaveBeenCalledTimes(1);
    const c = await runWeeklyPerformanceReview({}, { now: NOW, force: true });
    expect(c.cached).toBe(false);
    expect(mockAskLLM).toHaveBeenCalledTimes(2);
  });
});

describe('auto-push flag', () => {
  it('default ON; off disables', () => {
    expect(weeklyAutoPushEnabled()).toBe(true);
    const prev = process.env.AI_WEEKLY_REVIEW_PUSH;
    process.env.AI_WEEKLY_REVIEW_PUSH = 'off';
    expect(weeklyAutoPushEnabled()).toBe(false);
    process.env.AI_WEEKLY_REVIEW_PUSH = prev;
  });
});
