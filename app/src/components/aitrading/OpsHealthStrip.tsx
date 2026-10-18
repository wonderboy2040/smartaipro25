// ============================================================
// OpsHealthStrip — v21.1.0 (Phase-3)
// ------------------------------------------------------------
// /api/health ka compact frontend view: per-feed last-tick ages,
// WS health, teeno kill layers, Bot Lab snapshot, exec heartbeat
// (dead-man) + data-dir writability. EngineHealthStrip (AI engines)
// ke SIDE me baith-ta hai — terminal ka OPERATIONS panel.
// Poll: 30s visibility-gated (D16 pattern). Fail: strip chupchap
// hide ho jaata hai (auxiliary UI — kabhi terminal nahi todta).
// ============================================================
import { memo, useCallback, useEffect, useState } from 'react';
import { HeartPulse } from 'lucide-react';
import { apiFetch } from '../../utils/api';
import { wsFeedView, wsFeedTooltipLine, type WsFeedEntry } from './wsFeedView';

interface HealthSnap {
  ok?: boolean;
  uptimeSec?: number;
  feeds?: {
    sources?: Record<string, { ageSec: number; live?: boolean }>;
    staleSources?: string[];
    ws?: Record<string, WsFeedEntry>;
  };
  // AI providers health — Bot Lab ka jev. (v21.14: Laya removed.)
  ai?: {
    jev?: { configured?: boolean; reachable?: boolean; breakerOpen?: boolean; p95?: number | null; rejects?: number };
  };
  kills?: {
    aiDesk?: { enabled?: boolean };
    exec?: { level?: number; reason?: string | null };
    botLab?: { globalPause?: boolean }; // v21.1.1 [audit A14]: bots[] unused tha (server objects bhejta tha, string[] typed) — dropped
  };
  bots?: { mode?: string | null; globalPause?: boolean };
  persist?: { execHeartbeat?: { ageSec?: number | null }; dataDirWritable?: boolean };
}

const chip = (tone: 'ok' | 'warn' | 'bad' | 'dim', text: string, title: string, key?: string) => (
  <span
    key={key}
    title={title}
    className={`px-1.5 py-0.5 rounded-md text-[9px] font-mono font-bold border ${
      tone === 'ok' ? 'bg-emerald-500/10 text-emerald-300 border-emerald-500/30'
      : tone === 'warn' ? 'bg-amber-500/10 text-amber-300 border-amber-500/30'
      : tone === 'bad' ? 'bg-red-500/15 text-red-300 border-red-500/40'
      : 'bg-slate-600/20 text-slate-500 border-slate-600/30'
    }`}
  >
    {text}
  </span>
);

export const OpsHealthStrip = memo(function OpsHealthStrip() {
  const [snap, setSnap] = useState<HealthSnap | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await apiFetch('/api/health', { signal: AbortSignal.timeout(8000) });
      if (!res.ok) { setSnap(null); return; }
      const d = (await res.json().catch(() => null)) as HealthSnap | null;
      setSnap(d && typeof d === 'object' ? d : null);
    } catch { setSnap(null); /* silent — auxiliary strip */ }
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(() => { if (!document.hidden) load(); }, 30_000);
    return () => clearInterval(t);
  }, [load]);

  if (!snap) return null;

  // ---- feeds ----
  const sources = Object.entries(snap.feeds?.sources || {});
  const liveCount = sources.filter(([, v]) => v?.live).length;
  const stale = snap.feeds?.staleSources || [];
  const worstAge = sources.reduce((m, [, v]) => Math.max(m, v?.ageSec || 0), 0);
  const wsEntries = Object.entries(snap.feeds?.ws || {});
  // v21.1.2 (report Phase-1.1 / Cause-1): IDLE ≠ DOWN. Purana UI sirf
  // `healthy === false` dekhta tha — server ke idle sockets (koi subscriber
  // nahi, armed:false) bhi red "WS DOWN" ban jaate the. Ab classification
  // wsFeedView helper se hoti hai (pure + unit-tested):
  //   • armed + unhealthy  → DOWN (red)
  //   • armed:false         → IDLE (grey, "N idle")
  //   • healthy             → OK
  const wsViews = wsEntries.map(([k, v]) => ({ name: k, entry: v, view: wsFeedView(v) }));
  const wsDown = wsViews.filter((w) => w.view.down);
  const wsIdle = wsViews.filter((w) => w.view.idle);

  // ---- kills ----
  const execLvl = snap.kills?.exec?.level || 0;
  const aiKill = snap.kills?.aiDesk?.enabled === true;
  const botPause = snap.kills?.botLab?.globalPause === true || snap.bots?.globalPause === true;
  const anyKill = aiKill || execLvl > 0 || botPause;

  // ---- AI providers (v21.14: jev-only) ----
  // Chip: "AI: J ✓" — configured+healthy green, breaker-open red,
  // not-configured grey (dim). Bot Lab ke selected-arm providers hi
  // alerting ke liye healthMonitor me hain; ye chip provider dikhata hai.
  const aiJev = snap.ai?.jev;
  const anyAi = !!aiJev?.configured;
  const aiBreaker = !!aiJev?.breakerOpen;
  const provLabel = (p: { configured?: boolean; breakerOpen?: boolean } | undefined, short: string) =>
    !p?.configured ? `${short} –` : p.breakerOpen ? `${short} ⚠` : `${short} ✓`;

  // ---- persist ----
  const hbAge = snap.persist?.execHeartbeat?.ageSec ?? null;
  const dirsOk = snap.persist?.dataDirWritable !== false; // undefined (unarmed) bhi dim-OK

  const feedTone = stale.length > 0 ? 'bad' : liveCount > 0 ? 'ok' : 'dim';
  const feedTitle = sources.length === 0
    ? 'Koi feed source abhi armed nahi (market closed / streams idle)'
    : `${liveCount}/${sources.length} sources LIVE (60s window)${stale.length ? ` — STALE >90s: ${stale.join(', ')}` : ''}`;

  return (
    <div className="flex items-center gap-1.5 px-3 pb-2 flex-wrap">
      <span className="flex items-center gap-1 text-[9px] font-black font-mono text-slate-500" title="Operational health — v21.1.0 /api/health: feed last-tick ages, kill layers, exec heartbeat, data-dirs. 30s poll.">
        <HeartPulse size={10} /> OPS
      </span>
      {chip(feedTone, `FEEDS ${liveCount}/${sources.length}${worstAge > 0 ? ` · ${worstAge}s` : ''}`, feedTitle, 'feeds')}
      {wsEntries.length > 0 && chip(
        wsDown.length > 0 ? 'bad' : 'ok',
        wsDown.length > 0
          ? `WS ⚠ ${wsDown.length} DOWN`
          : wsIdle.length > 0
            ? `WS ${wsEntries.length - wsIdle.length}/${wsEntries.length} · ${wsIdle.length} idle`
            : `WS ${wsEntries.length}/${wsEntries.length}`,
        wsDown.length > 0
          ? `WS DOWN (armed streams): ${wsDown.map((w) => w.name).join(', ')}\n${wsViews.map((w) => wsFeedTooltipLine(w.name, w.entry)).join('\n')}`
          : wsIdle.length > 0
            ? `Armed streams sab healthy${wsIdle.length ? ` · ${wsIdle.length} IDLE (koi subscriber nahi — normal, down nahi)` : ''}\n${wsViews.map((w) => wsFeedTooltipLine(w.name, w.entry)).join('\n')}`
            : `All market WebSockets healthy\n${wsViews.map((w) => wsFeedTooltipLine(w.name, w.entry)).join('\n')}`,
        'ws',
      )}
      {chip(anyKill ? 'bad' : 'ok',
        anyKill ? (execLvl > 0 ? `⛔ EXEC KILL L${execLvl}` : aiKill ? '⛔ KILL ON' : '⛔ BOTS PAUSED') : 'KILLS CLEAR',
        anyKill
          ? `Kill active — AI desk: ${aiKill ? 'ON' : 'off'} · Exec: L${execLvl} (${snap.kills?.exec?.reason || 'no reason'}) · BotLab global pause: ${botPause ? 'ON' : 'off'} — live entries blocked`
          : 'Teeno kill layers clear (AI desk / exec / Bot Lab)',
        'kills')}
      {anyAi && chip(
        aiBreaker ? 'bad' : 'ok',
        `AI: ${provLabel(aiJev, 'J')}`,
        aiBreaker
          ? `AI provider BREAKER OPEN — Jev: ${aiJev?.breakerOpen ? 'DOWN' : aiJev?.configured ? 'ok' : 'n/a'} — AI arms WAIT mode me hain`
          : `Bot Lab AI provider — Jev: ${aiJev?.configured ? (aiJev?.reachable ? 'reachable' : 'unreachable') : 'not configured (TYPESAFE_API_KEY)'}`,
        'ai',
      )}
      {snap.bots?.mode && chip(snap.bots.globalPause ? 'warn' : 'dim', `BOTS ${String(snap.bots.mode).toUpperCase()}`, `Bot Lab mode: ${snap.bots.mode}${snap.bots.globalPause ? ' · GLOBAL PAUSE' : ''}`, 'bots')}
      {chip(hbAge != null && hbAge > 30 ? 'bad' : dirsOk ? 'ok' : 'bad',
        hbAge != null ? `HB ${hbAge}s` : (dirsOk ? 'DISK OK' : 'DISK FAIL'),
        hbAge != null && hbAge > 30
          ? `Exec heartbeat ${hbAge}s STALE (>30s) — reconcile loop atka hua hai, check karo`
          : dirsOk
            ? 'Exec heartbeat fresh + data-dirs writable (journal/ledger persist OK)'
            : 'DATA-DIR WRITE FAIL — journal/ledger persist nahi ho rahe! Disk full ya read-only mount.',
        'persist')}
      {chip('dim', `UP ${Math.floor((snap.uptimeSec || 0) / 60)}m`, `Server uptime: ${Math.floor((snap.uptimeSec || 0) / 3600)}h ${Math.floor(((snap.uptimeSec || 0) % 3600) / 60)}m`, 'up')}
    </div>
  );
});
