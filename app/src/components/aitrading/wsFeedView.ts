// ============================================================
// wsFeedView.ts — v21.1.2 (report Phase-1.1 / Cause-1 fix)
// ------------------------------------------------------------
// /api/health ke feeds.ws.* entries ka PURE classifier — UI red
// "WS DOWN" sirf tab dikhata hai jab stream ARMED ho (active
// subscribers / wantOpen) AUR unhealthy ho.
//
// KYUN: Ye streams refcounted hain — koi SSE/browser client nahi
// to _stopIfIdle() socket band kar deta hai, aur server honestly
// `healthy:false, armed:false` bhejta hai. Purana UI `armed` ignore
// karta tha → headless/Render deploys pe CoinDCX tab hamesha red
// "WS DOWN" false-positive dikhta tha. Idle ≠ Down.
//
// Server-side alert loop (healthMonitor _healthAlertTick) pehle se
// armed-aware tha — ye helper UI ko usi contract pe le aata hai.
// ============================================================

export interface WsFeedEntry {
  healthy?: boolean;
  armed?: boolean;
  ageSec?: number | null;
  cooldownReason?: string | null;
  failStreak?: number;
  cooldownRemainMs?: number;
}

export interface WsFeedView {
  /** ARMED + unhealthy = genuinely down (red). */
  down: boolean;
  /** armed:false = idle-by-design (grey — koi subscriber nahi). */
  idle: boolean;
  tone: 'ok' | 'warn' | 'bad' | 'dim';
}

/** Pure classification — koi React import nahi, seedha testable. */
export function wsFeedView(v?: WsFeedEntry | null): WsFeedView {
  const idle = v?.armed === false;
  const down = v?.healthy === false && !idle;
  // Priority: DOWN > healthy(OK — idle count ho to bhi stream khud green)
  // > unknown/idle (grey). healthy:true + armed:false transient hai —
  // honest green hi sahi.
  const tone = down ? 'bad' : v?.healthy === true ? 'ok' : 'dim';
  return { down, idle, tone };
}

const _mmss = (ms: number): string => {
  const s = Math.max(0, Math.round(ms / 1000));
  return s >= 60 ? `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s` : `${s}s`;
};

/** Tooltip ke liye ek WS feed ki human line — reason/streak/cooldown seedha dikhe. */
export function wsFeedTooltipLine(name: string, v?: WsFeedEntry | null): string {
  const view = wsFeedView(v);
  const age = v?.ageSec != null ? `${v.ageSec}s` : 'never';
  const parts: string[] = [];
  if (view.down) {
    parts.push(`DOWN · last tick ${age} purana`);
    if (v?.cooldownReason) parts.push(`reason: ${v.cooldownReason}`);
    if (v?.failStreak && v.failStreak > 0) parts.push(`fail-streak ${v.failStreak}`);
    if (v?.cooldownRemainMs && v.cooldownRemainMs > 0) parts.push(`cooldown ${_mmss(v.cooldownRemainMs)} bacha (REST 2s polling active — prices aate hain)`);
  } else if (view.idle) {
    parts.push(`IDLE (koi subscriber nahi — down nahi) · last tick ${age} purana`);
    if (v?.cooldownReason) parts.push(`last cooldown reason: ${v.cooldownReason}`);
  } else {
    parts.push(`OK · last tick ${age} purana`);
    if (v?.failStreak && v.failStreak > 0) parts.push(`fail-streak ${v.failStreak}`);
  }
  return `${name}: ${parts.join(' · ')}`;
}
