// ============================================================
// src/components/bots/useBots.ts — Jev Bot Lab v20.8.1
// ------------------------------------------------------------
// SSE consumption for the Bots desk: status frames (per-bot cards,
// mode, kill state, heartbeats, jev stats) + decision events.
// v20.8.1 FIX (H2): transport now goes through the app's API layer
// (getProxyBase + session token + apiFetch) — the old hard-coded
// relative URLs worked same-origin only; in the documented
// Vercel-to-Render split the SSE 401'd permanently and kill/arm POSTs
// silently failed. Also: permanent EventSource CLOSE now recreates
// with backoff instead of hanging on "reconnecting…" forever.
// ============================================================
import { useCallback, useEffect, useRef, useState } from 'react';
import { apiFetch, getProxyBase, getSessionToken } from '../../utils/api';

export interface BotAccountStats {
  equity: number; currency: string; startingEquity: number;
  totalReturnPct: number | null;
  todayPnl: { gross: number; net: number };
  feesPaid: number;
  winRate: number | null; avgR: number | null; trades: number;
  maxDrawdownPct: number | null;
}

// v21.14 (Laya removal): per-provider stats block — status.ai.jev.
// `jev` legacy field bhi same shape ka hai (server compat bhejta hai).
export interface AiProviderStats {
  calls: number; cacheHits: number; errors: number; rejects?: number;
  p50: number | null; p95: number | null;
  breakerOpen: boolean; threshold: number; model: string; hasKey: boolean;
  name?: string; url?: string;
}

export interface BotCard {
  // v21.14: arms rules | gated | jev | auto (laya/consensus removed)
  bot: string; arm: 'rules' | 'gated' | 'jev' | 'auto' | string;
  mode: 'PAPER' | 'LIVE' | string;
  killSwitch: boolean;
  heartbeat: { at: number; bars: number; note: string } | null;
  account: BotAccountStats | null;
  backtest: { pWin?: number; verdict?: string } | null;
}

export interface BotsStatus {
  mode: string; globalPause: boolean;
  scheduler?: string;
  ai: { jev: AiProviderStats | null } | null;
  aiMode?: { primary: string; shadow: string; onDown: string };
  jev: AiProviderStats | null;
  bots: BotCard[];
  at: string;
}

export interface BotEvent {
  bot: string; at: string; kind: string;
  symbol?: string; action?: string; reason?: string | null;
  jev?: { choice?: string | null; probs?: Record<string, number> | null; cached?: boolean; latencyMs?: number } | null;
  // v21.2.0 (dual-provider): per-provider telemetry (consensus/auto/shadow)
  ai?: Record<string, { choice?: string | null; probs?: Record<string, number> | null; cached?: boolean; latencyMs?: number | null; note?: string | null; shadow?: boolean } | null> | null;
  candidate?: { side?: string; entry?: number; stop?: number; target?: number };
  reasons?: string[];
  mode?: string;
  [k: string]: unknown;
}

function botsStreamUrl() {
  const session = getSessionToken();
  const base = `${getProxyBase()}/api/bots/stream`;
  return session ? `${base}?session=${encodeURIComponent(session)}` : base;
}

// v20.8.2 FIX (H3 — reconnect duplication): the server's SSE cursor is
// millisecond-timestamp based and re-sends the boundary event on every
// reconnect (native EventSource retry AND the CLOSED-recreate path both
// start a fresh connection) — the client used to APPEND those duplicates,
// so every reconnect doubled TAKE/order rows in the honesty log (a dup
// 'order' row reads as a double entry). Composite-key dedupe at receipt.
const eventKey = (e: BotEvent) => `${e.bot}|${e.at}|${e.kind}|${e.symbol ?? ''}|${e.candidate?.side ?? ''}`;

// v20.8.4 FIX (L — shape drift guard): status frames were stored RAW, so
// every .toFixed()/arithmetic in BotsTab depended on the server's numeric
// shape staying exact (a drifted field throws inside render → per-desk
// ErrorBoundary "Desk crash"). Coerce the known numerics at receipt — the
// same discipline toTick/toWsHealth already apply on the other desks.
const num = (v: unknown): number | null => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
// v21.14: ek provider stats block ko num-safe coerce — server shape
// drift per-desk ErrorBoundary se zyada door rahe.
function coerceProvider(p: AiProviderStats | null | undefined): AiProviderStats | null {
  if (!p || typeof p !== 'object') return p ?? null;
  // v21.2.0: !!'false' === TRUE tha — string booleans (drifted frames) ko
  // honest boolean me coerce karo, truthy-string poison nahi.
  const bool = (v: unknown): boolean => v === true || v === 'true' || v === 1 || v === '1';
  return {
    ...p,
    calls: num(p.calls) ?? 0,
    cacheHits: num(p.cacheHits) ?? 0,
    errors: num(p.errors) ?? 0,
    rejects: num(p.rejects) ?? 0,
    p50: num(p.p50),
    p95: num(p.p95),
    threshold: num(p.threshold) ?? 0,
    breakerOpen: bool(p.breakerOpen),
    hasKey: bool(p.hasKey),
    model: String(p.model ?? ''),
  };
}
// v21.2.0 (dual-provider): exported for the parse contract test — status
// frames ka numeric coercion (server shape drift guard) ab test-locked hai.
export function coerceStatus(s: BotsStatus | null): BotsStatus | null {
  if (!s || typeof s !== 'object') return s;
  const jev = coerceProvider(s.jev);
  const aiRaw = s.ai && typeof s.ai === 'object' ? s.ai : null;
  return {
    ...s,
    jev,
    ai: aiRaw ? { jev: coerceProvider(aiRaw.jev) } : aiRaw,
    bots: Array.isArray(s.bots) ? s.bots.map((b) => {
      if (!b || typeof b !== 'object') return b;
      const a = b.account && typeof b.account === 'object' ? b.account : null;
      const hb = b.heartbeat && typeof b.heartbeat === 'object' ? b.heartbeat : null;
      return {
        ...b,
        killSwitch: !!b.killSwitch,
        heartbeat: hb ? { ...hb, at: num(hb.at) ?? 0, bars: num(hb.bars) ?? 0, note: String(hb.note ?? '') } : hb,
        account: a ? {
          ...a,
          equity: num(a.equity) ?? 0,
          startingEquity: num(a.startingEquity) ?? 0,
          feesPaid: num(a.feesPaid) ?? 0,
          trades: num(a.trades) ?? 0,
          totalReturnPct: num(a.totalReturnPct),
          winRate: num(a.winRate),
          avgR: num(a.avgR),
          maxDrawdownPct: num(a.maxDrawdownPct),
          todayPnl: a.todayPnl && typeof a.todayPnl === 'object'
            ? { gross: num(a.todayPnl.gross) ?? 0, net: num(a.todayPnl.net) ?? 0 }
            : { gross: 0, net: 0 },
        } : a,
        backtest: b.backtest && typeof b.backtest === 'object'
          ? { ...b.backtest, pWin: num(b.backtest.pWin) ?? undefined }
          : b.backtest,
      };
    }) : [],
  };
}

export function useBots({ limit = 120 } = {}) {
  const [status, setStatus] = useState<BotsStatus | null>(null);
  const [events, setEvents] = useState<BotEvent[]>([]);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const esRef = useRef<EventSource | null>(null);
  // v20.8.2: monotonic receipt id — stable list keys for the decision
  // stream (index-in-reversed-array keys remounted ALL rows on every
  // append, defeating memo) + dedupe bookkeeping.
  const ridRef = useRef(0);
  const seenRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    let disposed = false;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let attempt = 0;
    let reconnected = false; // v20.8.4: a drop happened since last open

    const attach = () => {
      if (disposed) return;
      let es: EventSource | null = null;
      try { es = new EventSource(botsStreamUrl()); } catch { return; }
      esRef.current = es;
      es.onopen = () => {
        attempt = 0;
        setConnected(true);
        setError(null);
        // v20.8.4 FIX (H3 — silent audit-log holes): after a LONG disconnect
        // (>60 events while the laptop slept / tab was parked), a fresh SSE
        // connection re-sends only the last 60 of the 120-event window — the
        // honesty log used to jump timestamps with no indication. One-shot
        // backfill via the REST endpoint (limit 500, deduped through the
        // same ingest path) fills the gap with REAL events instead.
        if (reconnected) {
          reconnected = false;
          apiFetch('/api/bots/events?limit=500')
            .then((r) => (r.ok ? r.json() : null))
            .then((j) => { if (Array.isArray(j?.events)) ingestEvents(j.events as BotEvent[]); })
            .catch(() => { /* best-effort */ });
        }
      };
      es.addEventListener('status', (e) => {
        try { setStatus(coerceStatus(JSON.parse((e as MessageEvent).data))); } catch { /* frame skip */ }
      });
      const ingestEvents = (list: BotEvent[]) => {
        setEvents((prev) => {
          // v20.8.2 FIX (H3): dedupe on receipt (reconnect re-sends the
          // boundary batch) + stamp a stable receipt id for list keys.
          const seen = seenRef.current;
          const fresh: BotEvent[] = [];
          for (const ev of list) {
            const k = eventKey(ev);
            if (seen.has(k)) continue;
            seen.add(k);
            fresh.push({ ...ev, __rid: ++ridRef.current } as BotEvent);
          }
          if (!fresh.length) return prev;
          // merge delta frames append-only, bounded
          const next = [...prev, ...fresh];
          const trimmed = next.length > limit ? next.slice(next.length - limit) : next;
          // rebuild the dedupe set from what we still hold (bounded)
          seenRef.current = new Set(trimmed.map(eventKey));
          return trimmed;
        });
      };
      es.addEventListener('events', (e) => {
        try {
          const d = JSON.parse((e as MessageEvent).data);
          if (Array.isArray(d.events)) ingestEvents(d.events as BotEvent[]);
        } catch { /* frame skip */ }
      });
      // v20.8.1 FIX (H2): distinguish PERMANENT close (HTTP 401/500 —
      // the browser gives up, native retry never fires) from a dropped
      // connection. Permanent close tears down and recreates with
      // backoff; a transient error lets EventSource retry natively.
      es.onerror = () => {
        setConnected(false);
        if (es && es.readyState === EventSource.CLOSED) {
          try { es.close(); } catch { /* noop */ }
          if (esRef.current === es) esRef.current = null;
          const wait = Math.min(15000, 1000 * 2 ** attempt);
          attempt += 1;
          reconnected = true;
          setError('bot stream closed — retrying');
          // v20.8.4 FIX (H3 — blind token expiry): the Bots desk mounts NO
          // recurring authenticated REST call (unlike India/CoinDCX desks),
          // so an expired session left the SSE recreate-loop spinning at
          // "reconnecting…" forever — cards froze at the last frame and the
          // PIN gate never appeared. At the 3rd consecutive failure, probe
          // an auth'd REST endpoint once: its 401 rides apiFetch's existing
          // throttled 'session-expired' path (→ logout → PIN gate).
          if (attempt === 3) {
            apiFetch('/api/bots/status').catch(() => { /* probe result handled by apiFetch */ });
          }
          retryTimer = setTimeout(attach, wait);
        }
      };
    };

    attach();
    return () => {
      disposed = true;
      if (retryTimer) clearTimeout(retryTimer);
      try { esRef.current?.close(); } catch { /* noop */ }
      esRef.current = null;
    };
  }, [limit]);

  // v20.8.1 FIX (H2 + memo): actions go through apiFetch (auth + proxy
  // base + credentials), results are returned so the UI can show
  // failure feedback, and the callbacks are STABLE (useCallback with
  // empty deps — they close over nothing mutable) so memo(BotCardView)
  // actually hits.
  // v20.8.2 FIX (L): instant UI feedback for kill/arm — the response
  // payload used to be discarded, so with SSE down a successful POST
  // looked like nothing happened until the stream healed.
  const patchBot = useCallback((bot: string, patch: Partial<BotCard>) => {
    setStatus((s) => (s && s.bots?.length
      ? { ...s, bots: s.bots.map((b) => (b.bot === bot ? { ...b, ...patch } : b)) }
      : s));
  }, []);

  const stopBot = useCallback(async (bot: string, on: boolean): Promise<{ ok?: boolean; error?: string; killSwitch?: boolean } | null> => {
    try {
      // v20.9.0 FIX (L2 — check:routes false positive): do EXPLICIT literal
      // calls. The old single template `` `/api/bots/${on ? 'stop' : 'start'}/${bot}` ``
      // had a ternary INSIDE the interpolation — the static route checker
      // normalized it to /api/bots/*/* which matches nothing, keeping the
      // CI gate permanently red (hiding real failures). Both literals now
      // resolve to the real /api/bots/start/:bot | /stop/:bot routes.
      const r = on
        ? await apiFetch(`/api/bots/stop/${bot}`, { method: 'POST' })
        : await apiFetch(`/api/bots/start/${bot}`, { method: 'POST' });
      if (!r.ok) return { ok: false, error: `HTTP ${r.status}` };
      const j = await r.json();
      if (typeof j?.killSwitch === 'boolean') patchBot(bot, { killSwitch: j.killSwitch });
      return j;
    } catch (e) {
      return { ok: false, error: String((e as Error)?.message || e) };
    }
  }, [patchBot]);

  const setArm = useCallback(async (bot: string, arm: string): Promise<{ ok?: boolean; error?: string; arm?: string; provider?: string; hint?: string } | null> => {
    try {
      const r = await apiFetch(`/api/bots/arm/${bot}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ arm }),
      });
      // 409 provider_unavailable ka server body (error + provider + hint)
      // surface karo — sirf "HTTP 409" nahi, warna user ko nahi pata
      // provider ka issue hai ya arm ka.
      const j = await r.json().catch(() => null);
      if (!r.ok) {
        const hint = j?.hint ? ` — ${j.hint}` : '';
        return { ok: false, error: `HTTP ${r.status}${j?.error ? `: ${j.error}${j?.provider ? ` (${j.provider})` : ''}` : ''}${hint}` };
      }
      if (typeof j?.arm === 'string') patchBot(bot, { arm: j.arm });
      return j;
    } catch (e) {
      return { ok: false, error: String((e as Error)?.message || e) };
    }
  }, [patchBot]);

  const runSmoke = useCallback(async (): Promise<unknown | null> => {
    try {
      const r = await apiFetch('/api/bots/smoke');
      if (!r.ok) return { error: `HTTP ${r.status}` };
      return await r.json();
    } catch (e) {
      return { error: String((e as Error)?.message || e) };
    }
  }, []);

  return { status, events, connected, error, stopBot, setArm, runSmoke };
}