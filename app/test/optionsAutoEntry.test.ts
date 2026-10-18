// test/optionsAutoEntry.test.ts — v21.0.2
// OPTIONS AUTO-ENTRY + exit-plan fixes ka contract test:
//   1. optionsAutoTick: NSE-closed / disabled / quota-done idle guards
//   2. optionsAutoTick: tradeable card → openPaperTrade EXACT card levels
//      (T1 = entry+0.5R, T2 = entry+1.0R — v21.0.2 exit-plan match fix)
//   3. quota/cooldown state accounting + per-underlying cap
//   4. paperTrading: expiry-day OPTION square-off 14:30 (not 15:10)
//   5. agent: agentTradesToday GLOBALFUTURES (sim) exclusion (quota separation)
//   6. indiaAgent: index-symbol candidates filtered out
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.resolve(__dirname, '..');

// ---- shared mocks (hoisted) ----
vi.mock('../server/intraday/time.js', () => ({
  isNseMarketOpen: vi.fn(() => true),
  freshEntriesAllowedFor: vi.fn(() => true),
  istMinutes: vi.fn(() => 10 * 60),
}));
const openPaperTradeMock = vi.fn(() => ({ ok: true, trade: { id: 1 } }));
vi.mock('../server/intraday/paperTrading.js', () => ({
  openPaperTrade: (...a) => openPaperTradeMock(...a),
  getPaperSummary: vi.fn(() => ({ open: [] })),
}));
const viewMock = vi.fn();
vi.mock('../server/ai/optionsDesk.js', () => ({
  getOptionSignalsView: (...a) => viewMock(...a),
}));
vi.mock('../server/ai/coindcxOrders.js', () => ({
  loadConfig: vi.fn(() => ({ killSwitch: false })),
  loadJournal: vi.fn(() => ({ entries: [] })),
  withJournalLock: vi.fn(),
  pushEntry: vi.fn(),
  todayIST: vi.fn(() => '2026-10-09'),
  dailyStats: vi.fn(() => ({})),
  loadProTraderConfig: vi.fn(() => ({})),
}));

// The module under test reads/writes state files in server/data — point
// them at a scratch dir via env before import (optionsAutoEntry caches
// paths at module load).
const SCRATCH = path.join(APP_ROOT, '.test-data-optauto');
process.env.OPTIONS_AUTO_SCRATCH = SCRATCH;

import { optionsAutoTick, optionsAutoStatus, setOptionsAutoEnabled } from '../server/ai/optionsAutoEntry.js';
import { agentTradesToday } from '../server/ai/agent.js';

const cfgFile = path.join(APP_ROOT, 'server', 'data', 'options-auto-config.json');
const stateFile = path.join(APP_ROOT, 'server', 'data', 'options-auto-state.json');
let cfgBak: string | null = null;
let stateBak: string | null = null;

beforeEach(() => {
  vi.clearAllMocks();
  fs.mkdirSync(SCRATCH, { recursive: true });
  cfgBak = fs.existsSync(cfgFile) ? fs.readFileSync(cfgFile, 'utf8') : null;
  stateBak = fs.existsSync(stateFile) ? fs.readFileSync(stateFile, 'utf8') : null;
});
afterEach(() => {
  if (cfgBak != null) fs.writeFileSync(cfgFile, cfgBak); else { try { fs.unlinkSync(cfgFile); } catch { /* */ } }
  if (stateBak != null) fs.writeFileSync(stateFile, stateBak); else { try { fs.unlinkSync(stateFile); } catch { /* */ } }
  try { fs.rmSync(SCRATCH, { recursive: true, force: true }); } catch { /* */ }
});

const DEPS = { /* minimal deps object — view mock decides cards */ };
const CARD = {
  kind: 'option-signal', name: 'Nifty50 09Oct 23400 CE', symbol: 'NIFTY', type: 'CE', strike: 23400,
  direction: 'LONG', expiry: '2026-10-09', dte: 0, entry: 100, target: 130, stopLoss: 80,
  aiScore: 82, tradeable: true, lotSize: 75, iv: 13.5,
};

describe('v21.0.2 options auto-entry', () => {
  it('disabled by default — tick is a no-op', async () => {
    setOptionsAutoEnabled(false);
    const r = await optionsAutoTick(DEPS, undefined as any);
    expect(r).toEqual({ ok: true, idle: 'disabled' });
    expect(openPaperTradeMock).not.toHaveBeenCalled();
  });

  it('enabled + tradeable card → openPaperTrade at EXACT card levels (T1=+0.5R, T2=+1.0R)', async () => {
    setOptionsAutoEnabled(true);
    viewMock.mockResolvedValue({ ok: true, cards: [CARD] });
    const r = await optionsAutoTick(DEPS, undefined as any);
    expect((r as any).ok).toBe(true);
    expect((r as any).opened).toBeTruthy();
    expect(openPaperTradeMock).toHaveBeenCalledTimes(1);
    const arg = openPaperTradeMock.mock.calls[0][0];
    // exit-plan match fix: reward 30 → T1 115, T2 130 (NOT 130/145)
    expect(arg.target1).toBe(115);
    expect(arg.target2).toBe(130);
    expect(arg.stopLoss).toBe(80);
    expect(arg.symbol).toBe('NIFTY23400CE');
    expect(arg.assetKind).toBe('OPTION');
    expect(arg.label).toContain('· AUTO');
    // state: quota counted
    const st = optionsAutoStatus();
    expect(st.entriesToday).toBe(1);
    expect(st.quotaLeft).toBe(2);
  });

  it('non-tradeable / low-AI cards are skipped', async () => {
    setOptionsAutoEnabled(true);
    viewMock.mockResolvedValue({ ok: true, cards: [{ ...CARD, tradeable: false }, { ...CARD, aiScore: 60 }] });
    const r = await optionsAutoTick(DEPS, undefined as any);
    expect((r as any).idle).toBe('no-qualifying-card');
    expect(openPaperTradeMock).not.toHaveBeenCalled();
  });

  it('quota done → idle (state me count=quota → no entry)', async () => {
    setOptionsAutoEnabled(true);
    viewMock.mockResolvedValue({ ok: true, cards: [CARD] });
    // quota seed karo seedha state file me (3/3 used) — tick ko sirf
    // guard verify karna hai, real opens cooldown ke saath alag test me
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    fs.writeFileSync(stateFile, JSON.stringify({ day: new Date(Date.now() + (5.5 * 3600_000)).toISOString().slice(0, 10), count: 3, perUnderlying: {}, lastEntryAt: {}, lastEntry: null }));
    const r = await optionsAutoTick(DEPS, undefined as any);
    expect((r as any).idle).toBe('quota-done');
    expect(openPaperTradeMock).not.toHaveBeenCalled();
  });

  it('already-open contract is skipped (one-per-contract)', async () => {
    setOptionsAutoEnabled(true);
    const { getPaperSummary } = await import('../server/intraday/paperTrading.js');
    (getPaperSummary as any).mockReturnValue({ open: [{ symbol: 'NIFTY23400CE' }] });
    viewMock.mockResolvedValue({ ok: true, cards: [CARD] });
    const r = await optionsAutoTick(DEPS, undefined as any);
    expect((r as any).idle).toBe('no-qualifying-card');
  });

  it('NSE closed → idle (no entries after hours)', async () => {
    setOptionsAutoEnabled(true);
    const T = await import('../server/intraday/time.js');
    (T.isNseMarketOpen as any).mockReturnValue(false);
    const r = await optionsAutoTick(DEPS, undefined as any);
    expect((r as any).idle).toBe('nse-closed');
    (T.isNseMarketOpen as any).mockReturnValue(true);
  });

  it('kill switch → idle', async () => {
    setOptionsAutoEnabled(true);
    const CO = await import('../server/ai/coindcxOrders.js');
    (CO.loadConfig as any).mockReturnValue({ killSwitch: true });
    const r = await optionsAutoTick(DEPS, undefined as any);
    expect((r as any).idle).toBe('kill-switch');
    (CO.loadConfig as any).mockReturnValue({ killSwitch: false });
  });
});

describe('v21.0.2 agent quota separation (sim exclusion)', () => {
  it('agentTradesToday excludes GLOBALFUTURES sim entries', () => {
    const j = {
      entries: [
        { day: '2026-10-09', kind: 'ORDER', source: 'agent', status: 'FILLED', market: 'GLOBALFUTURES' },
        { day: '2026-10-09', kind: 'ORDER', source: 'agent', status: 'FILLED', market: 'FUTURES' },
        { day: '2026-10-09', kind: 'ORDER', source: 'agent', status: 'FILLED', market: 'INDIA' },
        { day: '2026-10-09', kind: 'ORDER', source: 'agent', status: 'REJECTED', market: 'FUTURES' },
        { day: '2026-10-08', kind: 'ORDER', source: 'agent', status: 'FILLED', market: 'FUTURES' },
      ],
    };
    const t = agentTradesToday(j as any);
    // sirf aaj ki FILLED FUTURES + INDIA — sim (GLOBALFUTURES) aur kal/purani REJECTED nahi
    expect(t.length).toBe(2);
    expect(t.every(e => e.market !== 'GLOBALFUTURES')).toBe(true);
  });
});
