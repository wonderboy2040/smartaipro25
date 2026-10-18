// ============================================================
// test/reconciler.test.ts — v20.7 RECONCILE + DEAD-MAN + KILL-SWITCH
// ------------------------------------------------------------
// Locks:
//   1. initReconciler arms + writes heartbeat file
//   2. killLevel L1/L2/L3 — setKill / canEnterNew / isKilled
//   3. external kill-flag file → arm L3
//   4. L3 flatten-all on next reconcile tick
//   5. orphan adopt: exchange has, PM doesn't → if no SL → flatten + alert
//   6. leader lease: SMARTAI_EXEC_NODE mismatch → canEnterNew=false
// ============================================================
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  initReconciler, __resetReconcilerForTests, __driveReconcileTickForTests,
  __setKillLevelForTests, __setEnginePairsForTests, killLevel, killReason, isKilled, canEnterNew,
  isLeader, leaderNode, setKill,
} from '../server/exec/reconciler.js';
import { PaperPort } from '../server/exec/port.js';
import { PositionManager } from '../server/exec/positionManager.js';

const TMP = path.join(os.tmpdir(), `reconciler-test-${Date.now()}-${process.pid}`);
const HEARTBEAT = path.join(TMP, 'execution-heartbeat.json');
const KILL_FLAG = path.join(TMP, 'execution-kill.flag');

beforeEach(() => {
  fs.mkdirSync(TMP, { recursive: true });
  __resetReconcilerForTests();
});

afterEach(() => {
  __resetReconcilerForTests();
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
});

describe('v20.7 reconciler — init + heartbeat', () => {
  it('initReconciler arms + writes heartbeat file', () => {
    const port = new PaperPort({ startingEquityUSDT: 1000 });
    initReconciler({ port, env: {}, heartbeatFile: HEARTBEAT, killFlagFile: KILL_FLAG });
    expect(fs.existsSync(HEARTBEAT)).toBe(true);
    const hb = JSON.parse(fs.readFileSync(HEARTBEAT, 'utf8'));
    expect(hb.pid).toBe(process.pid);
    expect(hb.killLevel).toBe(0);
    expect(typeof hb.at).toBe('number');
  });
});

describe('v20.7 reconciler — kill-switch hierarchy', () => {
  it('L1: setKill(1) blocks new entries but does NOT flatten', async () => {
    const port = new PaperPort({ startingEquityUSDT: 1000 });
    let alerts = 0;
    initReconciler({ port, env: {}, alertSink: () => { alerts++; }, heartbeatFile: HEARTBEAT, killFlagFile: KILL_FLAG });
    setKill(1, 'manual UI button');
    expect(killLevel()).toBe(1);
    expect(isKilled()).toBe(true);
    expect(canEnterNew()).toBe(false);
    // L1 does NOT flatten — drive a tick + verify positions stay (none open in this test)
    await __driveReconcileTickForTests();
    expect(alerts).toBeGreaterThanOrEqual(1);
  });

  it('L2: setKill(2) reduce-only — closes all open positions on next tick', async () => {
    const port = new PaperPort({ startingEquityUSDT: 1000 });
    // open a position first
    await port.open({ pair: 'B-BTC_USDT', side: 'LONG', qty: 0.1, leverage: 5, type: 'market', price: 100, sl: 95, tp: 110, clientId: 'c1' });
    expect((await port.getPositions()).length).toBe(1);
    initReconciler({ port, env: {}, heartbeatFile: HEARTBEAT, killFlagFile: KILL_FLAG });
    setKill(2, 'daily loss limit hit');
    await __driveReconcileTickForTests();
    expect((await port.getPositions()).length).toBe(0);
  });

  it('L3: setKill(3) flatten + disable — closes all + refuses future starts', async () => {
    const port = new PaperPort({ startingEquityUSDT: 1000 });
    await port.open({ pair: 'B-BTC_USDT', side: 'LONG', qty: 0.1, leverage: 5, type: 'market', price: 100, sl: 95, tp: 110, clientId: 'c1' });
    initReconciler({ port, env: {}, heartbeatFile: HEARTBEAT, killFlagFile: KILL_FLAG });
    setKill(3, 'critical — flatten all');
    await __driveReconcileTickForTests();
    expect((await port.getPositions()).length).toBe(0);
    expect(canEnterNew()).toBe(false);
  });

  it('setKill(0) clears the kill + resumes', async () => {
    const port = new PaperPort({ startingEquityUSDT: 1000 });
    initReconciler({ port, env: {}, heartbeatFile: HEARTBEAT, killFlagFile: KILL_FLAG });
    setKill(3, 'critical');
    expect(killLevel()).toBe(3);
    setKill(0, 'manual clear');
    expect(killLevel()).toBe(0);
    expect(canEnterNew()).toBe(true);
  });

  it('kill-flag file → LEVEL verbatim restore (v21.1.1: L1 restart-mass-flatten fix) + foreign file → L3', async () => {
    const port = new PaperPort({ startingEquityUSDT: 1000 });
    initReconciler({ port, env: {}, heartbeatFile: HEARTBEAT, killFlagFile: KILL_FLAG });
    expect(killLevel()).toBe(0);
    // v21.1.1 [audit B1]: persisted {level:1} ab L1 hi restore hota hai —
    // pehle hard-coded L3 tha (restart par "no new entries" → "flatten
    // everything" escalate ho jaata tha — operator ne maanga hi nahi).
    fs.writeFileSync(KILL_FLAG, JSON.stringify({ level: 1, reason: 'daily-loss caution', at: Date.now() }));
    await __driveReconcileTickForTests();
    expect(killLevel()).toBe(1);
    expect(killReason()).toMatch(/daily-loss caution/);
    // removing the flag → resume
    fs.unlinkSync(KILL_FLAG);
    await __driveReconcileTickForTests();
    expect(killLevel()).toBe(0);
    // foreign/unparseable flag → fail-safe L3 (unchanged)
    fs.writeFileSync(KILL_FLAG, 'not-json-external-touch');
    await __driveReconcileTickForTests();
    expect(killLevel()).toBe(3);
    fs.unlinkSync(KILL_FLAG);
    await __driveReconcileTickForTests();
    expect(killLevel()).toBe(0);
    // explicit L3 flag → L3 restore
    fs.writeFileSync(KILL_FLAG, JSON.stringify({ level: 3, reason: 'external supervisor' }));
    await __driveReconcileTickForTests();
    expect(killLevel()).toBe(3);
    fs.unlinkSync(KILL_FLAG);
    await __driveReconcileTickForTests();
    expect(killLevel()).toBe(0);
  });
});

describe('v20.7 reconciler — leader lease', () => {
  it('isLeader() = true when SMARTAI_EXEC_NODE matches (or unset)', () => {
    const port = new PaperPort({ startingEquityUSDT: 1000 });
    initReconciler({ port, env: { SMARTAI_EXEC_NODE: 'laptop' }, heartbeatFile: HEARTBEAT, killFlagFile: KILL_FLAG });
    expect(isLeader()).toBe(true);
    expect(leaderNode()).toBe('laptop');
    expect(canEnterNew()).toBe(true);
  });

  it('isLeader() = false when SMARTAI_EXEC_NODE mismatch → canEnterNew=false', () => {
    const port = new PaperPort({ startingEquityUSDT: 1000 });
    initReconciler({ port, env: { SMARTAI_EXEC_NODE: 'render' }, heartbeatFile: HEARTBEAT, killFlagFile: KILL_FLAG });
    // Leader = SMARTAI_EXEC_LEADER (default 'laptop'); this node = 'render' → NOT leader.
    expect(isLeader()).toBe(false);
    expect(leaderNode()).toBe('laptop');
    expect(canEnterNew()).toBe(false);
  });

  it('isLeader() = true when SMARTAI_EXEC_NODE matches an explicit SMARTAI_EXEC_LEADER', () => {
    const port = new PaperPort({ startingEquityUSDT: 1000 });
    initReconciler({ port, env: { SMARTAI_EXEC_NODE: 'render', SMARTAI_EXEC_LEADER: 'render' }, heartbeatFile: HEARTBEAT, killFlagFile: KILL_FLAG });
    expect(isLeader()).toBe(true);
    expect(leaderNode()).toBe('render');
  });

  it('isLeader() = true when SMARTAI_EXEC_NODE is unset (single-node setup)', () => {
    const port = new PaperPort({ startingEquityUSDT: 1000 });
    initReconciler({ port, env: {}, heartbeatFile: HEARTBEAT, killFlagFile: KILL_FLAG });
    expect(isLeader()).toBe(true);
    expect(canEnterNew()).toBe(true);
  });
});

describe('v20.7 reconciler — orphan adoption (reconcile)', () => {
  // v20.7.12 [H1]: flatten ab SIRF engine-owned orphans pe (journal me
  // recent LIVE FUTURES row). Manual positions adopt-only hain —
  // production me PM state kabhi populate nahi hoti thi, to pehle wala
  // unconditional flatten user ke apne manual trades ko 12s me band kar
  // deta tha. Engine-ownership test-hook se seed hota hai.
  it('ENGINE-OWNED orphan with no SL → flatten + alert (core rule)', async () => {
    const port = new PaperPort({ startingEquityUSDT: 1000 });
    // open a position directly via port (bypassing PM) → PM has no record
    await port.open({ pair: 'B-BTC_USDT', side: 'LONG', qty: 0.1, leverage: 5, type: 'market', price: 100, sl: null, tp: null, clientId: 'orphan1' });
    let alerts = 0;
    const alertMsgs = [];
    initReconciler({
      port,
      positionManager: { _stateForTests: () => [] }, // PM empty — orphan detected
      alertSink: (m) => { alerts++; alertMsgs.push(m); },
      env: {},
      heartbeatFile: HEARTBEAT, killFlagFile: KILL_FLAG,
    });
    __setEnginePairsForTests(['B-BTC_USDT']); // engine-owned (journal LIVE row hota)
    await __driveReconcileTickForTests();
    expect(alerts).toBeGreaterThanOrEqual(1);
    expect(alertMsgs.some(m => /ORPHAN/i.test(m))).toBe(true);
    // orphan was flattened
    expect((await port.getPositions()).length).toBe(0);
  });

  it('v20.7.12 [H1]: MANUAL orphan (not engine-owned) with no SL → ADOPT-ONLY — kabhi close nahi', async () => {
    const port = new PaperPort({ startingEquityUSDT: 1000 });
    await port.open({ pair: 'B-BTC_USDT', side: 'LONG', qty: 0.1, leverage: 5, type: 'market', price: 100, sl: null, tp: null, clientId: 'orphan-manual' });
    let alerts = 0;
    const alertMsgs = [];
    initReconciler({
      port,
      positionManager: { _stateForTests: () => [] },
      alertSink: (m) => { alerts++; alertMsgs.push(m); },
      env: {},
      heartbeatFile: HEARTBEAT, killFlagFile: KILL_FLAG,
    });
    __setEnginePairsForTests([]); // engine ke paas is pair ki koi LIVE row nahi
    await __driveReconcileTickForTests();
    // manual position SURVIVES — adopt-only + advisory alert
    expect((await port.getPositions()).length).toBe(1);
    expect(alertMsgs.some(m => /MANUAL.*adopt-only/i.test(m))).toBe(true);
    // advisory alert 30-min throttle — doosre tick pe repeat nahi
    await __driveReconcileTickForTests();
    expect(alertMsgs.filter(m => /MANUAL.*adopt-only/i.test(m)).length).toBe(1);
  });

  it('orphan WITH SL on exchange → adopt (no flatten)', async () => {
    const port = new PaperPort({ startingEquityUSDT: 1000 });
    await port.open({ pair: 'B-BTC_USDT', side: 'LONG', qty: 0.1, leverage: 5, type: 'market', price: 100, sl: 95, tp: 110, clientId: 'orphan2' });
    let alerts = 0;
    initReconciler({
      port,
      positionManager: { _stateForTests: () => [] },
      alertSink: () => { alerts++; },
      env: {},
      heartbeatFile: HEARTBEAT, killFlagFile: KILL_FLAG,
    });
    __setEnginePairsForTests(['B-BTC_USDT']);
    await __driveReconcileTickForTests();
    // orphan WITH SL → adopted, no flatten, no alert
    expect((await port.getPositions()).length).toBe(1);
  });
});
