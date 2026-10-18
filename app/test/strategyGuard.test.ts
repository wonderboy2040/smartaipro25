// ============================================================
// test/strategyGuard.test.ts — v21.1.0 (Phase-4 lock)
// ------------------------------------------------------------
// 30-trade rolling kill rule + GO-LIVE gate ka contract:
//   • n < 30 → kuch paused nahi (warming)
//   • 30 negative-R trades → strategy PAUSED + guardBlocked true
//   • expectancy recover (rolling window me wins) → auto-resume
//   • paperReadiness: 100+ trades, +expectancy, DD limit ke andar → ready
//   • goLiveGate: insufficient paper → blocked honest reason ke saath;
//     VITEST default off + __setGoLiveEnforceForTests(true) se enforce
// Ledger hermetic SMARTAI_DATA_DIR me __setLedgerForTests se seed hota hai.
// ============================================================
import { describe, it, expect, beforeEach } from 'vitest';
import { __setLedgerForTests } from '../server/ai/ledger.js';
import {
  strategyHealth, strategyGuardBlocked, paperReadiness, goLiveGateBlocked,
  __setGoLiveEnforceForTests, GO_LIVE, KILL_RULE,
} from '../server/ai/strategyGuard.js';

function mkEntry(over: Partial<Record<string, unknown>> = {}) {
  return {
    id: `e-${Math.random().toString(36).slice(2)}`,
    ts: Date.now(), market: 'CRYPTO', symbol: 'BTC', side: 'LONG',
    mode: 'paper', source: 'agent',
    outcome: { ts: Date.now(), r: 1, pnlINR: 100, reason: null, exit: null },
    ...over,
  } as any;
}

describe('ai/strategyGuard.js — v21.1.0 Phase-4 kill rule + go-live gate', () => {
  beforeEach(() => {
    __setLedgerForTests({ entries: [] });
    __setGoLiveEnforceForTests(false);
  });

  it('KILL RULE: empty ledger → nothing paused (warming), guard passes', () => {
    const h = strategyHealth();
    expect(h.strategies).toHaveLength(0);
    expect(strategyGuardBlocked('agent', 'CRYPTO').blocked).toBe(false);
  });

  it('KILL RULE: 30 negative-expectancy trades → strategy PAUSED + blocked with honest reason', () => {
    // 20 losses, 5 wins, 5 losses → rolling 30 = -expectancy
    const entries = [];
    for (let i = 0; i < 20; i++) entries.push(mkEntry({ outcome: { r: -1 } }));
    for (let i = 0; i < 5; i++) entries.push(mkEntry({ outcome: { r: 0.5 } }));
    for (let i = 0; i < 5; i++) entries.push(mkEntry({ outcome: { r: -1 } }));
    __setLedgerForTests({ entries });

    const row = strategyHealth().strategies.find(s => s.strategy === 'agent:CRYPTO');
    expect(row).toBeTruthy();
    expect(row!.paused).toBe(true);
    expect(row!.rolling.n).toBe(30);
    expect(row!.rolling.expectancyR).toBeLessThan(0);

    const g = strategyGuardBlocked('agent', 'CRYPTO');
    expect(g.blocked).toBe(true);
    expect(String(g.reason)).toMatch(/AUTO-PAUSED/);
    // doosri strategy (futures) unaffected
    expect(strategyGuardBlocked('agent', 'FUTURES').blocked).toBe(false);
  });

  it('KILL RULE: n < 30 settled → NOT paused (minTrades floor)', () => {
    const entries = [];
    for (let i = 0; i < KILL_RULE.minTrades - 1; i++) entries.push(mkEntry({ outcome: { r: -1 } }));
    __setLedgerForTests({ entries });
    const row = strategyHealth().strategies.find(s => s.strategy === 'agent:CRYPTO');
    expect(row!.rolling.expectancyR).toBeLessThan(0);
    expect(row!.paused).toBe(false); // sample abhi chhota hai
  });

  it('KILL RULE: recovery — rolling window me wins aane par auto-resume', () => {
    // pehle 30 losses (paused), phir 30 wins se window recover
    // (ts strictly increasing — realistic settle order)
    const base = Date.now();
    const entries = [];
    for (let i = 0; i < 30; i++) entries.push(mkEntry({ ts: base + i, outcome: { r: -1 } }));
    for (let i = 0; i < 30; i++) entries.push(mkEntry({ ts: base + 100 + i, outcome: { r: 2 } }));
    __setLedgerForTests({ entries });
    const row = strategyHealth().strategies.find(s => s.strategy === 'agent:CRYPTO');
    expect(row!.paused).toBe(false);
    expect(row!.rolling.expectancyR).toBeGreaterThan(0);
  });

  it('GO-LIVE GATE: 100 profitable paper trades within DD → ready', () => {
    const entries = [];
    for (let i = 0; i < GO_LIVE.minTrades; i++) entries.push(mkEntry({ outcome: { r: i % 3 === 0 ? -1 : 1.5 } }));
    __setLedgerForTests({ entries });
    const p = paperReadiness();
    expect(p.stats.settledPaperTrades).toBe(GO_LIVE.minTrades);
    expect(p.stats.expectancyR).toBeGreaterThan(0);
    expect(p.ready).toBe(true);
    expect(p.reasons).toHaveLength(0);
  });

  it('GO-LIVE GATE: insufficient trades + negative expectancy + DD breach → 3 honest reasons', () => {
    const entries = [];
    // 50 trades, negative expectancy, drawdown > GO_LIVE.maxDrawdownR
    for (let i = 0; i < 50; i++) entries.push(mkEntry({ outcome: { r: -0.4 } }));
    __setLedgerForTests({ entries });
    const p = paperReadiness();
    expect(p.ready).toBe(false);
    expect(p.reasons.length).toBeGreaterThanOrEqual(2);
    expect(p.reasons.join(' ')).toMatch(/trades 50\//);
  });

  it('GO-LIVE GATE: enforcement — blocked jab tak criteria clear nahi; pass jab clear', () => {
    // empty ledger + enforce ON → blocked
    __setGoLiveEnforceForTests(true);
    const blocked = goLiveGateBlocked();
    expect(blocked.blocked).toBe(true);
    expect(String(blocked.reason)).toMatch(/GO-LIVE GATE/);

    // qualifying paper record + enforce ON → allowed
    const entries = [];
    for (let i = 0; i < GO_LIVE.minTrades; i++) entries.push(mkEntry({ outcome: { r: i % 3 === 0 ? -0.5 : 1.2 } }));
    __setLedgerForTests({ entries });
    const ok = goLiveGateBlocked();
    expect(ok.blocked).toBe(false);
  });

  it('GO-LIVE GATE: LIVE-mode entries ke liye paper hi gine jaate hain (live trades count nahi)', () => {
    const entries = [];
    for (let i = 0; i < GO_LIVE.minTrades; i++) entries.push(mkEntry({ mode: 'live', outcome: { r: 5 } }));
    __setLedgerForTests({ entries });
    const p = paperReadiness();
    expect(p.stats.settledPaperTrades).toBe(0);
    expect(p.ready).toBe(false);
  });

  it('relaxed entries (practice fills engine never endorsed) EXCLUDED from all stats', () => {
    const entries = [
      ...Array.from({ length: 30 }, () => mkEntry({ relaxed: true, outcome: { r: -1 } })),
      ...Array.from({ length: 5 }, () => mkEntry({ outcome: { r: 1 } })),
    ];
    __setLedgerForTests({ entries });
    const row = strategyHealth().strategies.find(s => s.strategy === 'agent:CRYPTO');
    expect(row!.n).toBe(5); // relaxed 30 count nahi hue
    expect(row!.paused).toBe(false);
  });
});
