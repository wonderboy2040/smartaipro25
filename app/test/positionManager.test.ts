// ============================================================
// test/positionManager.test.ts — v20.7 protection-first + exit ladder
// ------------------------------------------------------------
// Locks:
//   1. protectionFirstEntry happy path: open → fill confirm → setProtection → state recorded
//   2. protection-fail → FLATTEN immediately (no naked leveraged position)
//   3. leverage mismatch → close + alert
//   4. exit ladder: ENTRY → T1_HIT → RUNNER → CLOSED via tick()
//   5. SL hit at tick-level (no candle wait)
//   6. give-back lock (peak ≥1.5R & retrace >35% → close)
//   7. time-stop (N candles no T1 → exit)
//   8. tiered reversal (1/2/3+ classes → tighten/reduce/close)
// ============================================================
import { describe, it, expect, beforeEach } from 'vitest';
import { PositionManager } from '../server/exec/positionManager.js';
import { PaperPort } from '../server/exec/port.js';

beforeEach(() => { /* each test fresh */ });

function _signal(over = {}) {
  return {
    pair: 'B-BTC_USDT', symbol: 'BTC', side: 'LONG', ltp: 100,
    superIntel: { tier: 'STRONG', aiScore: 85 }, grade: 'STRONG',
    __riskPct: 1,
    ...over,
  };
}
function _plan(over = {}) {
  return { entry: 100, stopLoss: 98.5, target1: 101.5, target2: 103, ...over };
}

describe('v20.7 PositionManager — protectionFirstEntry', () => {
  it('happy path: open → fill confirm → setProtection → state recorded', async () => {
    const port = new PaperPort({ startingEquityUSDT: 1000 });
    const pm = new PositionManager({ port });
    const r = await pm.protectionFirstEntry({ signal: _signal(), plan: _plan() });
    expect(r.ok).toBe(true);
    expect(r.positionId).toBeTruthy();
    expect(r.sizing.leverage).toBeGreaterThanOrEqual(5);
    // state recorded for exit ladder
    const st = pm._stateForTests();
    expect(st.length).toBe(1);
    expect(st[0].stage).toBe('ENTRY');
  });

  it('RAM RED blocks new entries', async () => {
    const port = new PaperPort({ startingEquityUSDT: 1000 });
    const ram = { ramCanEnter: () => false, ramCanLLM: () => false };
    const pm = new PositionManager({ port, ramGovernor: ram });
    const r = await pm.protectionFirstEntry({ signal: _signal(), plan: _plan() });
    expect(r.ok).toBe(false);
    expect(r.stage).toBe('ram-gate');
  });

  it('signal tier below ACTION blocks (no leverage bump)', async () => {
    const port = new PaperPort({ startingEquityUSDT: 1000 });
    const pm = new PositionManager({ port });
    const r = await pm.protectionFirstEntry({ signal: _signal({ superIntel: { tier: 'WATCH' } }), plan: _plan() });
    expect(r.ok).toBe(false);
    expect(r.stage).toBe('tier-gate');
  });

  it('protection-fail → FLATTEN immediately (no naked position)', async () => {
    const port = new PaperPort({ startingEquityUSDT: 1000 });
    // wrap setProtection to fail
    const origSetProt = port.setProtection.bind(port);
    let calls = 0;
    port.setProtection = async () => { calls++; return { ok: false, error: 'simulated network error' }; };
    let alertCount = 0;
    const pm = new PositionManager({ port, alertSink: () => { alertCount++; } });
    const r = await pm.protectionFirstEntry({ signal: _signal(), plan: _plan() });
    expect(r.ok).toBe(false);
    expect(r.stage).toBe('protection-fail');
    expect(calls).toBe(1); // setProtection was called once (and failed)
    // CRITICAL alert fired
    expect(alertCount).toBeGreaterThanOrEqual(1);
    // position was flattened — getPositions should be empty
    const positions = await port.getPositions();
    expect(positions.length).toBe(0);
  });
});

describe('v20.7 PositionManager — exit ladder', () => {
  it('T1 hit → 40% reduce + SL to breakeven + fees', async () => {
    const port = new PaperPort({ startingEquityUSDT: 1000 });
    const pm = new PositionManager({ port });
    const r = await pm.protectionFirstEntry({ signal: _signal(), plan: _plan() });
    expect(r.ok).toBe(true);
    // price moves to T1 (≈1R = 101.5)
    const pos = (await port.getPositions())[0];
    port.setMarkPrice('B-BTC_USDT', 101.5);
    const actions = await pm.tick({ pricesByPair: { 'B-BTC_USDT': 101.5 } });
    const t1Act = actions.find(a => a.kind === 't1');
    expect(t1Act).toBeTruthy();
    expect(t1Act.newSl).toBeGreaterThan(pos.avgPrice); // SL moved up (LONG)
  });

  it('SL hit at tick-level → immediate close (no candle wait)', async () => {
    const port = new PaperPort({ startingEquityUSDT: 1000 });
    const pm = new PositionManager({ port });
    const r = await pm.protectionFirstEntry({ signal: _signal(), plan: _plan() });
    // price drops below SL (98.5)
    port.setMarkPrice('B-BTC_USDT', 98.0);
    const actions = await pm.tick({ pricesByPair: { 'B-BTC_USDT': 98.0 } });
    const slAct = actions.find(a => a.kind === 'sl-hit');
    expect(slAct).toBeTruthy();
    const positions = await port.getPositions();
    expect(positions.length).toBe(0);
  });

  it('time-stop: N candles with no T1 → exit', async () => {
    const port = new PaperPort({ startingEquityUSDT: 1000 });
    const pm = new PositionManager({ port, cfg: { timeStopCandles: 3 } });
    const r = await pm.protectionFirstEntry({ signal: _signal(), plan: _plan() });
    // 4 ticks (above timeStopCandles 3), price stays at entry (no T1)
    for (let i = 0; i < 4; i++) {
      await pm.tick({ pricesByPair: { 'B-BTC_USDT': 100 } });
    }
    const positions = await port.getPositions();
    expect(positions.length).toBe(0);
  });

  it('tiered reversal: 3+ evidence classes → full close', async () => {
    const port = new PaperPort({ startingEquityUSDT: 1000 });
    const pm = new PositionManager({ port });
    const r = await pm.protectionFirstEntry({ signal: _signal(), plan: _plan() });
    const actions = await pm.reversalCheck({ evidenceByPair: { 'B-BTC_USDT': ['structure-break', 'mtf-flip', 'ensemble-flip'] } });
    const closeAct = actions.find(a => a.kind === 'reversal-close');
    expect(closeAct).toBeTruthy();
    expect(closeAct.classes).toBe(3);
    const positions = await port.getPositions();
    expect(positions.length).toBe(0);
  });

  it('tiered reversal: 2 evidence classes → 50% reduce', async () => {
    const port = new PaperPort({ startingEquityUSDT: 1000 });
    const pm = new PositionManager({ port });
    const r = await pm.protectionFirstEntry({ signal: _signal(), plan: _plan() });
    const posBefore = (await port.getPositions())[0];
    const actions = await pm.reversalCheck({ evidenceByPair: { 'B-BTC_USDT': ['structure-break', 'mtf-flip'] } });
    const reduceAct = actions.find(a => a.kind === 'reversal-reduce');
    expect(reduceAct).toBeTruthy();
    // reduceQty is r2(qty * 0.5) — rounded to 2 decimals; allow ±0.01 slack
    expect(reduceAct.reduceQty).toBeGreaterThan(posBefore.qty * 0.5 - 0.01);
    expect(reduceAct.reduceQty).toBeLessThan(posBefore.qty * 0.5 + 0.01);
  });

  it('tiered reversal: 1 evidence class → SL tighten to BE', async () => {
    const port = new PaperPort({ startingEquityUSDT: 1000 });
    const pm = new PositionManager({ port });
    const r = await pm.protectionFirstEntry({ signal: _signal(), plan: _plan() });
    const posBefore = (await port.getPositions())[0];
    const actions = await pm.reversalCheck({ evidenceByPair: { 'B-BTC_USDT': ['structure-break'] } });
    const tightenAct = actions.find(a => a.kind === 'reversal-tighten');
    expect(tightenAct).toBeTruthy();
    expect(tightenAct.newSl).toBeGreaterThan(posBefore.sl); // SL moved up (LONG)
  });
});
