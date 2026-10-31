// ============================================================
// test/mtfLiveArm21272.test.ts — v21.27.2
// MTF DUAL BOARD ⚡ LIVE BUTTON — ARM-FROM-BUTTON CURE
// ------------------------------------------------------------
// User report: pressing ⚡ LIVE on the MTF Dual Board always failed with
// "LIVE execution is not enabled for this desk/tab — arm it in the desk
// console first" even when the server said the crypto desk was armable.
//
// Root cause: the guard demanded `liveExecEnabled` BEFORE arming, while the
// button itself is the arming control (chicken-and-egg). v21.27.2 allows the
// click to arm CRYPTO live when `deskArmable.crypto.armable === true`
// (desk on + kill switch off + CoinDCX creds); the server still enforces the
// typed-LIVE phrase + real creds. India stays typed-LIVE-only and
// GLOBALFUTURES stays PAPER-only.
// ============================================================
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const APP_ROOT = path.join(__dirname, '..');
const read = (rel: string) => readFileSync(path.join(APP_ROOT, rel), 'utf8');

describe('v21.27.2 MTF LIVE button arms crypto LIVE', () => {
  const ui = read('src/components/aitrading/MTFDualBoardPanel.tsx');
  const routes = read('server/ai/routes.js');
  const coindcx = read('server/ai/coindcxOrders.js');

  it('button is enabled when the server says the crypto desk prerequisites are met', () => {
    expect(ui).toContain("const cryptoClickArmable = deskKey === 'crypto'");
    expect(ui).toContain("&& market !== 'GLOBALFUTURES'");
    // v21.30.0: gate on prereqArmable (caps are patched by the same click).
    expect(ui).toContain('&& deskPrereq?.armable === true;');
    expect(ui).toContain('&& (liveExecEnabled || cryptoClickArmable);');
    // The old hard pre-arm block no longer sits at the top of the handler.
    expect(ui).not.toContain("if (!liveExecEnabled) {\n      notify(false, '⛔ LIVE execution is not enabled");
  });

  it('the arm call is the existing MTF config route, which syncs typed site LIVE', () => {
    expect(ui).toContain('const resCfg = await updateMtfAutoConfigApi(cfgPatch);');
    expect(routes).toContain("updateConfig({ mode: 'live', liveConfirmPhrase: 'LIVE', allowAuto: false })");
    expect(coindcx).toContain('Enabling LIVE mode requires liveConfirmPhrase="LIVE"');
    expect(coindcx).toContain('if (!coindcxConnected())');
  });

  it('India and GLOBALFUTURES never auto-arm from this button', () => {
    expect(ui).toContain("if (market === 'GLOBALFUTURES')");
    expect(ui).toContain('GLOBALFUTURES SIM desk PAPER-only');
    expect(ui).toContain("if (deskKey !== 'crypto')");
    expect(ui).toContain('India console me typed LIVE se arm karo');
  });

  it('unconfirmed crypto arm aborts honestly instead of showing LIVE ON', () => {
    expect(ui).toContain("const clickArmedCrypto = !liveExecEnabled && deskKey === 'crypto'");
    expect(ui).toContain('CRYPTO LIVE arm server ne confirm nahi kiya');
  });

  it('armability failure shows the server reason, not the desk-console hint', () => {
    expect(ui).toContain("if (arm?.armable !== true)");
    expect(ui).toContain("arm?.why || 'server desk readiness unavailable");
  });
});
