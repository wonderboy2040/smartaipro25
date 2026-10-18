// ============================================================
// test/clearClosedPositions.test.ts — v10.17 CLEAR CLOSED
// ------------------------------------------------------------
// Locks the console sweep: only CLOSED rows go, OPEN/UNKNOWN are
// structurally untouched, a HOUSEKEEP audit entry stamps the sweep,
// the no-op path writes nothing, and the journal lock serialises.
// ============================================================
import { describe, it, expect, beforeEach } from 'vitest';
import {
  clearClosedPositions, loadJournal, __setJournalForTests, __resetForTests,
} from '../server/ai/coindcxOrders.js';

const pos = (id, market, status, over = {}) => ({
  id, market, symbol: id, pair: `${id}INR`, side: 'LONG', mode: 'paper',
  qty: 1, entryPrice: 100, status, openedAt: Date.now() - 3600_000,
  closedAt: status === 'CLOSED' ? Date.now() - 60_000 : null,
  closeReason: status === 'CLOSED' ? 'T2_HIT' : null,
  ...over,
});

beforeEach(() => {
  __resetForTests();
});

describe('clearClosedPositions — the console sweep', () => {
  it('removes ONLY closed rows; OPEN and UNKNOWN survive untouched', async () => {
    const open = pos('p-open', 'CRYPTO', 'OPEN');
    const unknown = pos('p-unknown', 'CRYPTO', 'UNKNOWN', { qty: 3 });
    const closed1 = pos('p-closed-1', 'CRYPTO', 'CLOSED');
    const closed2 = pos('p-closed-2', 'INDIA', 'CLOSED');
    __setJournalForTests({ entries: [], positions: [open, unknown, closed1, closed2] });

    const out = await clearClosedPositions();
    expect(out).toEqual({ ok: true, removed: 2, kept: 2 });

    const j = loadJournal();
    expect(j.positions.map(p => p.id)).toEqual(['p-open', 'p-unknown']);
    expect(j.positions.find(p => p.id === 'p-unknown')!.qty).toBe(3); // untouched
  });

  it('stamps a HOUSEKEEP audit entry with the sweep count (ledger trail intact)', async () => {
    __setJournalForTests({ entries: [], positions: [pos('c1', 'CRYPTO', 'CLOSED'), pos('c2', 'CRYPTO', 'CLOSED')] });
    await clearClosedPositions();
    const j = loadJournal();
    const entry = j.entries.find(e => e.kind === 'HOUSEKEEP');
    expect(entry).toBeDefined();
    expect(entry!.status).toBe('CLOSED_SWEEP');
    expect(entry!.removed).toBe(2);
    expect(entry!.day).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(entry!.note).toContain('2 CLOSED');
  });

  it('empty sweep (nothing closed) writes NO entry and reports removed 0', async () => {
    const open = pos('only-open', 'CRYPTO', 'OPEN');
    __setJournalForTests({ entries: [], positions: [open] });
    const out = await clearClosedPositions();
    expect(out).toEqual({ ok: true, removed: 0, kept: 1 });
    expect(loadJournal().entries).toHaveLength(0);
  });

  it('journal without positions array degrades safely', async () => {
    __setJournalForTests({ entries: [] });
    const out = await clearClosedPositions();
    expect(out).toEqual({ ok: true, removed: 0, kept: 0 });
  });

  it('sweep is repeat-safe (second call is a no-op)', async () => {
    __setJournalForTests({ entries: [], positions: [pos('c1', 'CRYPTO', 'CLOSED')] });
    await clearClosedPositions();
    const out2 = await clearClosedPositions();
    expect(out2.removed).toBe(0);
    expect(loadJournal().entries.filter(e => e.kind === 'HOUSEKEEP')).toHaveLength(1);
  });

  it('runs through the journal lock (serialized with other writers)', async () => {
    __setJournalForTests({ entries: [], positions: [pos('c1', 'CRYPTO', 'CLOSED'), pos('o1', 'CRYPTO', 'OPEN')] });
    // fire two concurrent sweeps — the lock must serialise them; the
    // second sees the already-swept journal and no-ops
    const [a, b] = await Promise.all([clearClosedPositions(), clearClosedPositions()]);
    const removedTotal = (a.removed || 0) + (b.removed || 0);
    expect(removedTotal).toBe(1); // exactly one sweep did the work
    expect(loadJournal().positions).toHaveLength(1);
  });
});
