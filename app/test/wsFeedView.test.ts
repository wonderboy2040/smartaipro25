// ============================================================
// wsFeedView.test.ts — v21.1.2 (report Phase-1.1 / 2-Test-add)
// ------------------------------------------------------------
// OpsHealthStrip WS chip classification contract:
//   • armed:false + healthy:false → IDLE (grey), DOWN nahi
//   • armed:true  + healthy:false → DOWN (red)
//   • cooldown detail tooltip me aata hai (reason/streak/remain)
// Ye wahi contract hai jo server-side healthMonitor._healthAlertTick
// follow karta hai (armed === false → skip alert).
// ============================================================
import { describe, expect, it } from 'vitest';
import { wsFeedView, wsFeedTooltipLine } from '../src/components/aitrading/wsFeedView';

describe('wsFeedView — IDLE vs DOWN classification (v21.1.2)', () => {
  it('idle socket (armed:false, healthy:false) DOWN NAHI hai — grey idle', () => {
    const v = wsFeedView({ healthy: false, armed: false, ageSec: null });
    expect(v.down).toBe(false);
    expect(v.idle).toBe(true);
    expect(v.tone).toBe('dim');
  });

  it('armed + unhealthy = DOWN (red)', () => {
    const v = wsFeedView({ healthy: false, armed: true, ageSec: 140 });
    expect(v.down).toBe(true);
    expect(v.idle).toBe(false);
    expect(v.tone).toBe('bad');
  });

  it('armed (undefined) + unhealthy = DOWN — missing armed fail-safe red', () => {
    // agar koi purana server `armed` field bhejna bhool jaye to red hi safe hai
    const v = wsFeedView({ healthy: false, ageSec: 200 });
    expect(v.down).toBe(true);
    expect(v.tone).toBe('bad');
  });

  it('healthy stream = OK', () => {
    expect(wsFeedView({ healthy: true, armed: true, ageSec: 2 }).tone).toBe('ok');
    expect(wsFeedView({ healthy: true, armed: false, ageSec: 30 }).tone).toBe('ok');
  });

  it('null/undefined entry = dim (unknown), red nahi', () => {
    expect(wsFeedView(null).down).toBe(false);
    expect(wsFeedView(undefined).tone).toBe('dim');
    expect(wsFeedView({}).down).toBe(false);
  });

  it('idle me bhi healthy:true kabhi DOWN nahi', () => {
    const v = wsFeedView({ healthy: true, armed: false });
    expect(v.down).toBe(false);
    expect(v.idle).toBe(true);
  });
});

describe('wsFeedTooltipLine — reason/streak/cooldown detail (report-1.5)', () => {
  it('DOWN line me cooldown reason + fail-streak + remaining aata hai', () => {
    const line = wsFeedTooltipLine('coindcxFutures', {
      healthy: false, armed: true, ageSec: 145,
      cooldownReason: 'handshake-streak', failStreak: 3, cooldownRemainMs: 552_000,
    });
    expect(line).toContain('coindcxFutures: DOWN');
    expect(line).toContain('handshake-streak');
    expect(line).toContain('fail-streak 3');
    expect(line).toContain('cooldown 9m12s');
    expect(line).toContain('REST 2s polling active'); // prices aate hain — honest context
  });

  it('IDLE line me "down nahi" context aata hai', () => {
    const line = wsFeedTooltipLine('coindcxFutures', { healthy: false, armed: false, ageSec: null });
    expect(line).toContain('IDLE');
    expect(line).toContain('koi subscriber nahi');
    expect(line).toContain('never'); // lastTickAt null → age "never"
  });

  it('OK line me fail-streak jab >0 ho tab dikhta hai', () => {
    expect(wsFeedTooltipLine('binanceFutures', { healthy: true, armed: true, ageSec: 1, failStreak: 0 }))
      .not.toContain('fail-streak');
    expect(wsFeedTooltipLine('binanceFutures', { healthy: true, armed: true, ageSec: 1, failStreak: 2 }))
      .toContain('fail-streak 2');
  });
});
