// ============================================================
// test/recheck212315.test.ts — v21.23.15 post-ship RECHECK locks
// Covers the fixes that followed the initial direction-accuracy ship:
//   • boot-time persistence guard (no pre-restore default stamp)
//   • desk-scoped live readiness / armability (India typed-LIVE only)
//   • kill switch reaching the background MTF ticks
//   • India live close routed to Dhan, not CoinDCX
//   • no quota inflation / journal lock in the SL updater
// ============================================================
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mtf-recheck-212315-'));
process.env.MTF_AUTO_DATA_DIR = TMP;

type MtfMod = typeof import('../server/ai/mtfAutoLink.js');
let mtf: MtfMod;

const read = (rel: string) => fs.readFileSync(path.join(process.cwd(), rel), 'utf8');
const CFG_FILE = path.join(TMP, 'mtf-auto-config.json');

beforeAll(async () => {
  mtf = await import('../server/ai/mtfAutoLink.js');
});

afterAll(() => {
  try { mtf?.__reloadMtfAutoForBoot({ restored: false }); } catch { /* best-effort */ }
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* best-effort */ }
  delete process.env.MTF_AUTO_DATA_DIR;
});

describe('v21.23.15 recheck — boot persistence guard', () => {
  it('suppresses config/state writes until the restore attempt completes', () => {
    mtf.__resetMtfAutoForTests();
    try { fs.unlinkSync(CFG_FILE); } catch { /* absent */ }
    mtf.__beginMtfAutoBoot();
    const next = mtf.updateMtfAutoConfig({ minScore: 88 });
    expect(next.minScore).toBe(88); // in-memory update still works
    expect(fs.existsSync(CFG_FILE)).toBe(false); // but nothing stamped on disk
    mtf.__reloadMtfAutoForBoot({ restored: false, configRestored: false, stateRestored: false });
    const saved = mtf.updateMtfAutoConfig({ minScore: 89 });
    expect(saved.minScore).toBe(89);
    expect(fs.existsSync(CFG_FILE)).toBe(true);
    expect(JSON.parse(fs.readFileSync(CFG_FILE, 'utf8')).minScore).toBe(89);
  });

  it('server starts the guard before the durable restore race', () => {
    const index = read('server/index.js');
    const durable = read('server/mcp/durable.js');
    expect(index).toContain('__beginMtfAutoBoot');
    expect(index.indexOf('__beginMtfAutoBoot')).toBeLessThan(index.indexOf('durableBootRestoreAll()'));
    // Reload must be unconditional after the attempt, not only on success.
    expect(durable).toContain('configRestored: !!mtfCfg');
    expect(durable).toContain('stateRestored: !!mtfState');
  });
});

describe('v21.23.15 recheck — desk scope + safety source pins', () => {
  it('India live is armed only by typed indiaMode; MTF executionMode cannot arm it', () => {
    const routes = read('server/ai/routes.js');
    expect(routes).toContain("india: Boolean(desks.india && !killSwitch && tcfg.indiaMode === 'live')");
    expect(routes).not.toContain("india: Boolean(autoLinkLive || tcfg.indiaMode === 'live')");
    expect(routes).toContain('deskArmable');
    expect(routes).toContain('killSwitch: ready.killSwitch');
  });

  it('background MTF ticks receive the global kill switch', () => {
    const routes = read('server/ai/routes.js');
    const hits = routes.match(/killSwitch: \(\(\) => \{ try \{ return !!loadConfig\(\)\?\.killSwitch; \} catch \{ return false; \} \}\)\(\)/g) || [];
    expect(hits.length).toBeGreaterThanOrEqual(2);
  });

  it('live order arming follows the per-desk site flag, not global executionMode alone', () => {
    const ai = read('server/ai/mtfAutoLink.js');
    expect(ai).toContain('const wantLiveOrder = !isSimRow');
    expect(ai).toContain('Boolean(siteLiveForDesk(p, row.market))');
    expect(ai).toContain("(cfg.executionMode === 'live' || cfg.autoSyncSiteLive !== false)");
    expect(ai).not.toContain("cfg.executionMode === 'live' || Boolean(siteLiveForDesk(p, row.market)");
  });

  it('daily quota is not silently inflated to 15 in live mode', () => {
    const ai = read('server/ai/mtfAutoLink.js');
    expect(ai).toContain('const effectiveMaxTradesPerDay = cfg.maxTradesPerDay;');
    expect(ai).not.toContain('Math.max(cfg.maxTradesPerDay, 15)');
    expect(ai).not.toContain('priorWasLive ? Math.max(Number(cfg.maxTradesPerDay) || 5, 15)');
  });

  it('daily quota counts each desk against its own UTC/IST day boundary', () => {
    const ai = read('server/ai/mtfAutoLink.js');
    expect(ai).toContain('const dayCountAllDesks = stDay.book.filter(b => b.dayKey === dayKeyFor(b.market, new Date(now))).length;');
    expect(ai).toContain('const flipDayCount = stq.book.filter(b => b.dayKey === dayKeyFor(b.market, new Date(now))).length;');
  });

  it('POST /mtf-auto/config paper mode defaults autoSyncSiteLive to false', () => {
    const routes = read('server/ai/routes.js');
    expect(routes).toContain("if (body.executionMode === 'paper' && body.autoSyncSiteLive === undefined)");
    expect(routes).toContain('body.autoSyncSiteLive = false;');
  });

  it('India LIVE pre-flight does not require CoinDCX creds (Dhan desk)', () => {
    const src = read('src/components/aitrading/MTFDualBoardPanel.tsx');
    expect(src).toContain("if (deskKey === 'crypto' && stArm?.coindcxConnected === false)");
  });
});

describe('v21.23.15 recheck — India live lifecycle', () => {
  it('deep-monitor close routes India positions to closeIndiaPosition', () => {
    const routes = read('server/ai/routes.js');
    expect(routes).toContain("if (mkt === 'INDIA')");
    expect(routes).toContain('closeIndiaPosition(String(id)');
    expect(routes).toContain('positionId: outIndia.position?.id');
  });

  it('India SL is never sent to the CoinDCX SL updater; journal writes stay locked', () => {
    const ai = read('server/ai/mtfAutoLink.js');
    const futures = read('server/ai/futures.js');
    expect(ai).toContain('const indiaDeskRow = b.market === \'INDIA\' || b.execMarket === \'INDIA\';');
    expect(ai).toContain('if (!indiaDeskRow && b.executionMode === \'LIVE\'');
    // The old direct `jPos.sl = sl; saveJournalFresh(j);` is gone.
    expect(futures).not.toContain('jPos.sl = sl;');
    expect(futures).toContain('jp.sl = sl;');
  });

  it('UI arm guard + stale-status green-off + India label', () => {
    const ui = read('src/components/aitrading/MTFDualBoardPanel.tsx');
    expect(ui).toContain('deskArmable?.armable === false');
    expect(ui).toContain('!autoFresh');
    expect(ui).toContain('LIVE DHAN');
    expect(ui).toContain('hydratedRef');
  });
});
