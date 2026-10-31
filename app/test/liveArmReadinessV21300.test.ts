// ============================================================
// test/liveArmReadinessV21300.test.ts — v21.30.0 LIVE-ARM UX
// ------------------------------------------------------------
// Locks:
//   • prerequisites (desk/creds/kill-switch/India typed-LIVE) are separate
//     from missing money caps;
//   • a caps-only block exposes armableWithCaps so the explicit LIVE click
//     can send its caps patch instead of aborting before it;
//   • the strict `armable` never becomes true while caps are missing;
//   • the UI gates on prereqArmable (not the strict field) and the server
//     surfaces every new field on status/config/toggle.
// ============================================================
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { describeDeskArmState, evaluateLiveArmRisk } from '../server/ai/riskArm.js';

const FULL_CAPS = {
  riskPerTradePct: 1,
  maxRiskPerTradePct: 2,
  maxLeverage: 10,
  maxWalletDeployPct: 100,
  dailyLossPct: 1.5,
};

describe('v21.30.0 — LIVE arm readiness split', () => {
  it('caps-only block keeps prerequisites green but strict armable red', () => {
    const riskArm = evaluateLiveArmRisk({});
    const st = describeDeskArmState({ cfg: {}, prereqOk: true, prereqWhy: null, riskArm });
    expect(st.prereqArmable).toBe(true);
    expect(st.armable).toBe(false);
    expect(st.armableWithCaps).toBe(true);
    expect(st.needsRiskCaps).toBe(true);
    expect(st.capsOnlyBlock).toBe(true);
    expect(st.riskCapsMissing.length).toBeGreaterThan(0);
    expect(st.why).toMatch(/risk caps/i);
  });

  it('caps present → strict armable true, caps block cleared', () => {
    const riskArm = evaluateLiveArmRisk(FULL_CAPS);
    const st = describeDeskArmState({ cfg: FULL_CAPS, prereqOk: true, riskArm });
    expect(riskArm.ok).toBe(true);
    expect(st.prereqArmable).toBe(true);
    expect(st.armable).toBe(true);
    expect(st.capsOnlyBlock).toBe(false);
    expect(st.needsRiskCaps).toBe(false);
    expect(st.why).toBeNull();
  });

  it('prerequisite failure stays blocked even with full caps', () => {
    const st = describeDeskArmState({
      cfg: FULL_CAPS,
      prereqOk: false,
      prereqWhy: 'CoinDCX API keys not connected',
      riskArm: evaluateLiveArmRisk(FULL_CAPS),
    });
    expect(st.prereqArmable).toBe(false);
    expect(st.armable).toBe(false);
    expect(st.armableWithCaps).toBe(false);
    expect(st.capsOnlyBlock).toBe(false);
    expect(st.why).toMatch(/API keys/i);
  });
});

describe('v21.30.0 — LIVE-arm wiring pins', () => {
  const root = process.cwd();
  const routesSrc = fs.readFileSync(path.join(root, 'server/ai/routes.js'), 'utf8');
  const panelSrc = fs.readFileSync(path.join(root, 'src/components/aitrading/MTFDualBoardPanel.tsx'), 'utf8');
  const typesSrc = fs.readFileSync(path.join(root, 'src/components/aitrading/useAITrading.ts'), 'utf8');

  it('server exposes the split and keeps deskArmable strict', () => {
    expect(routesSrc).toContain('describeDeskArmState');
    expect(routesSrc).toContain('prereqArmable:');
    expect(routesSrc).toContain('armableWithCaps:');
    expect(routesSrc).toContain('capsOnlyBlock:');
    expect(routesSrc).toContain('riskCapsMissing: riskArm.missing');
    expect(routesSrc).toMatch(/deskArmable:\s*\{\s*crypto:\s*\{\s*armable:\s*cryptoArm\.armable/);
  });

  it('UI gate uses prerequisites while the click still sends the caps', () => {
    expect(panelSrc).toContain('const deskPrereq = auto?.prereqArmable?.[deskKey] || deskArmable;');
    expect(panelSrc).toContain('status?.prereqArmable?.[deskKey] || status?.deskArmable?.[deskKey]');
    expect(panelSrc).toContain('capsOnlyBlock');
    expect(panelSrc).toContain('riskPerTradePct: 1');
    expect(panelSrc).toContain('maxWalletDeployPct: 100');
    expect(typesSrc).toContain('prereqArmable?:');
    expect(typesSrc).toContain('armableWithCaps?:');
    expect(typesSrc).toContain('capsOnlyBlock?:');
  });
});
