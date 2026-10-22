// ============================================================
// test/fullFlowAudit212314.test.ts — v21.23.14 full-flow hardening
// ------------------------------------------------------------
// Pins the high-risk fixes from the top-agent/MTF deep recheck:
//   • PLACED live rows are never monitored as filled positions
//   • close verdicts are honored by the reconciler (covered in reconciler.test)
//   • opposite-side live positions cannot be returned as a successful entry
//   • India live book anchors to broker fill
//   • UC flip reverse requires verified/ensemble/auto-ready row
//   • EQUITY SIM keeps GLOBALFUTURES/USDC domain
//   • PAPER TEST disables site-live sync
// ============================================================
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

describe('v21.23.14 full-flow audit pins', () => {
  it('SAPTA never runs TP/SL/reversal monitoring on an unfilled PLACED row', () => {
    const src = read('server/ai/proTraderAuto.js');
    expect(src).toContain('UNFILLED LIMIT GUARD');
    expect(src).toContain("if (t.status === 'PLACED') {");
    expect(src).toContain('no-plan-stop');
    expect(src).toContain('stop-polarity');
  });

  it('live entry re-checks STOP before the browser order', () => {
    const src = read('server/ai/proTraderAuto.js');
    expect(src).toContain('STOP pressed during tick');
    expect(src).toContain('loadProTraderConfig();');
  });

  it('existing exchange position must match the requested side', () => {
    const src = read('server/ai/futures.js');
    expect(src).toContain('Opposite ${exchSide} position already active');
    expect(src).toContain('existingSide: exchSide');
  });

  it('India manual live MTF rows are anchored to the Dhan fill', () => {
    const src = read('server/ai/routes.js');
    expect(src).toContain('const iFilled = outIndia.filled || {};');
    expect(src).toContain('GLOBALFUTURES/EQUITY SIM is PAPER-only');
    expect(src).toContain('entry: Number(iFilled.price) > 0 ? Number(iFilled.price)');
    expect(src).toContain('qty: Number(iFilled.qty) > 0 ? Number(iFilled.qty)');
  });

  it('CU flip reverse is blocked on unverified/ensemble-missing/auto-ineligible rows', () => {
    const src = read('server/ai/mtfAutoLink.js');
    expect(src).toContain('REVERSE-ENTRY PARITY');
    expect(src).toContain('directionVerified: s.directionVerified === true');
    expect(src).toContain('ensembleSignalAvailable: s.ensembleSignalAvailable !== false');
    expect(src).toContain('reverseReady');
  });

  it('sim book rows keep GLOBALFUTURES/USDC instead of CRYPTO/FUTURES/USDT', () => {
    const src = read('server/ai/mtfAutoLink.js');
    expect(src).toContain("const isSimBook = rawBookMarket === 'GLOBALFUTURES'");
    expect(src).toContain("const execMarket = isSimBook ? 'GLOBALFUTURES'");
    expect(src).toContain("existing.execMarket = execMarket");
  });

  it('board row cache includes the board-signal fingerprint', () => {
    const src = read('server/ai/mtfDualBoard.js');
    expect(src).toContain('CACHE-IDENTITY');
    expect(src).toContain('const sigTag = boardSig');
    expect(src).toContain('${sigTag}');
  });

  it('auto candidates inherit the 5-minute main-signal age floor', () => {
    const src = read('server/ai/mtfDualBoard.js');
    expect(src).toContain('AUTO/MANUAL PARITY');
    expect(src).toContain('row.mainSignalAgeMs');
    expect(src).toContain('stability confirm pending');
  });

  it('PAPER TEST explicitly disables site-live sync and UI mirrors the server gate', () => {
    const src = read('src/components/aitrading/MTFDualBoardPanel.tsx');
    expect(src).toContain('autoSyncSiteLive: false');
    expect(src).toContain('r.autoEligible === true');
    expect(src).toContain("r.assetClass !== 'EQUITY_SIM'");
  });

  it('crypto agent re-reads STOP before every split executor call', () => {
    const src = read('server/ai/agent.js');
    expect(src).toContain('STOP DURING TICK');
    expect(src).toContain('stopRequestedMidTick');
    expect(src).toContain('loadAgentConfig()?.enabled !== true');
    expect(src).toContain('abortSplitForStop');
  });

  it('India global-risk gate uses the crypto agent last wallet equity, not a hardcoded 10k', () => {
    const agent = read('server/ai/agent.js');
    const india = read('server/ai/indiaAgent.js');
    expect(agent).toContain('export function agentLastWalletEquityINR()');
    expect(india).toContain('agentLastWalletEquityINR');
    expect(india).toContain('cryptoEquityINR: cxEquityINR');
    expect(india).not.toContain('cryptoEquityINR: 10_000');
  });

  it('manual board PAPER/LIVE entries check and acquire the cross-engine direction lock', () => {
    const src = read('server/ai/routes.js');
    expect(src).toContain('MANUAL BOARD LOCK');
    expect(src).toContain('checkDirectionLock(baseSym, row.side)');
    expect(src).toContain('checkDirectionLock(baseSym, side)');
    expect(src).toContain("source: 'mtf-board-paper'");
    expect(src).toContain("source: 'mtf-board-live'");
  });

  it('site-live routing is desk-scoped (India live cannot arm crypto auto)', () => {
    const ai = read('server/ai/mtfAutoLink.js');
    const routes = read('server/ai/routes.js');
    expect(ai).toContain('SITE-LIVE DESK SCOPE');
    expect(ai).toContain('siteLiveForDesk(p, row.market)');
    expect(ai).toContain("siteLiveForDesk(p, 'INDIA')");
    expect(routes).toContain('siteLiveByDesk');
    expect(routes).toContain('india: Boolean(autoLinkLive || tcfg.indiaMode === \'live\')');
  });

  it('LIVE close P&L is marked estimated when exchange does not report it', () => {
    const src = read('server/ai/mtfAutoLink.js');
    expect(src).toContain("b.pnlSource = 'EXCHANGE'");
    expect(src).toContain("b.pnlSource = 'ESTIMATE'");
    expect(src).toContain('pnlVerified: b.pnlVerified');
  });
});
