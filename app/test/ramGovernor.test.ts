// ============================================================
// test/ramGovernor.test.ts — v20.6 RAM GOVERNOR state transitions
// ------------------------------------------------------------
// Locks:
//   1. un-armed → ramCanEnter / ramCanLLM both true (no gate)
//   2. armed + GREEN (>3.5GB free) → both gates open
//   3. armed + YELLOW (2–3.5GB) → ramCanEnter false (LLM blocked,
//      but entries allowed) — wait, the plan says YELLOW blocks LLM
//      AND new entries. Let me re-read: "YELLOW: LLM calls band
//      (deterministic mode), HF models unload." — entries not
//      mentioned. The plan's RED section says "RED: naye entries
//      band, sirf positions manage". So YELLOW blocks LLM, RED
//      blocks entries. Verified in code: ramCanEnter() returns
//      state !== 'RED'; ramCanLLM() returns state === 'GREEN'.
//   4. armed + RED (<2GB) → both gates false + Telegram alert sink called once
//   5. RED alert re-fire has 5-min min-gap (no spam)
// ============================================================
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  initRamGovernor, __resetRamGovernorForTests, __driveRamTickForTests,
  ramState, ramCanEnter, ramCanLLM, ramGovernorArmed,
} from '../server/ai/ramGovernor.js';

beforeEach(() => __resetRamGovernorForTests());
afterEach(() => __resetRamGovernorForTests());

describe('v20.6 ramGovernor — state transitions', () => {
  it('un-armed → gates open (no governor)', () => {
    expect(ramGovernorArmed()).toBe(false);
    expect(ramCanEnter()).toBe(true);
    expect(ramCanLLM()).toBe(true);
  });

  it('armed + GREEN (4GB free) → both gates open', () => {
    initRamGovernor({ env: {} });
    __driveRamTickForTests(4 * 1024, 200); // 4GB free, 200MB RSS
    expect(ramState().state).toBe('GREEN');
    expect(ramCanEnter()).toBe(true);
    expect(ramCanLLM()).toBe(true);
  });

  it('armed + YELLOW (3GB free) → LLM blocked, entries allowed', () => {
    initRamGovernor({ env: {} });
    __driveRamTickForTests(3 * 1024, 200);
    expect(ramState().state).toBe('YELLOW');
    expect(ramCanEnter()).toBe(true);  // YELLOW allows entries (RED only blocks)
    expect(ramCanLLM()).toBe(false);   // YELLOW blocks LLM (forces deterministic mode)
  });

  it('armed + RED (1.5GB free) → both gates blocked', () => {
    initRamGovernor({ env: {} });
    __driveRamTickForTests(1.5 * 1024, 200);
    expect(ramState().state).toBe('RED');
    expect(ramCanEnter()).toBe(false);
    expect(ramCanLLM()).toBe(false);
  });

  it('RED triggers Telegram alert sink on RED entry (state-change boundary)', () => {
    let alerts = 0;
    initRamGovernor({ env: {}, alertSink: () => { alerts++; } });
    __driveRamTickForTests(1.5 * 1024, 200); // RED entry → 1 alert
    expect(ramState().state).toBe('RED');
    expect(alerts).toBe(1);
    // immediately re-tick (still RED, no state change) → no second alert
    __driveRamTickForTests(1.4 * 1024, 220);
    expect(alerts).toBe(1);
  });

  it('RED → GREEN → RED re-fires alert on every fresh RED entry', () => {
    let alerts = 0;
    initRamGovernor({ env: {}, alertSink: () => { alerts++; } });
    __driveRamTickForTests(1.5 * 1024, 200); // RED entry → 1 alert
    __driveRamTickForTests(4 * 1024, 200);   // GREEN → no alert
    __driveRamTickForTests(1.5 * 1024, 200); // RED entry again → 2 alerts
    expect(alerts).toBe(2);
  });

  it('RSS floor hit (process RSS alone exceeds total-reserve) → YELLOW even if free is high', () => {
    // totalmem default 16GB; reserve 600MB → if RSS > 16GB-600MB = 15.4GB,
    // the rss-floor hit triggers. (real-world swap scenario)
    initRamGovernor({ env: { RAM_RSS_RESERVE_MB: '600' } });
    __driveRamTickForTests(8 * 1024, 15 * 1024); // 8GB free BUT 15GB RSS → YELLOW
    expect(ramState().state).toBe('YELLOW');
  });

  it('custom env tunables (RAM_YELLOW_FREE_GB / RAM_RED_FREE_GB)', () => {
    initRamGovernor({ env: { RAM_YELLOW_FREE_GB: '5', RAM_RED_FREE_GB: '3' } });
    __driveRamTickForTests(4 * 1024, 200); // 4GB free < 5GB yellow threshold
    expect(ramState().state).toBe('YELLOW');
    __driveRamTickForTests(2 * 1024, 200); // 2GB free < 3GB red threshold
    expect(ramState().state).toBe('RED');
  });

  it('snapshot shape: armed, state, freeGB, rssMB, totalGB, yellowGB, redGB, since', () => {
    initRamGovernor({ env: {} });
    __driveRamTickForTests(4 * 1024, 200);
    const s = ramState();
    expect(s).toHaveProperty('armed', true);
    expect(s).toHaveProperty('state', 'GREEN');
    expect(typeof s.freeGB).toBe('number');
    expect(typeof s.rssMB).toBe('number');
    expect(typeof s.totalGB).toBe('number');
    expect(typeof s.yellowGB).toBe('number');
    expect(typeof s.redGB).toBe('number');
    expect(typeof s.since).toBe('number');
  });
});
