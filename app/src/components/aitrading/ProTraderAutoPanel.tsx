import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { apiFetch, getProxyBase, getSessionToken } from '../../utils/api';
import { swallow } from '../../utils/swallow';

// ============================================================
//  PRO TRADER AUTO — SAPTA v18.6 (Superintelligence Advance AI
//  Pro Trader Auto). User-spec gates: AI 75+ / conf 65+ /
//  verified 90+ (CONFIRM) — trades execute inside the user's
//  logged-in CoinDCX / Dhan browser tabs via the backend CDP
//  browser agent; exits wait for a CONFIRMED reversal.
// ============================================================

type Notify = (ok: boolean, text: string) => void;

interface PtaGate { minAiScore: number; minConfidence: number; minVerifiedScore: number; reversalConfirmTicks: number; tpExits?: { enabled: boolean; tp1ClosePct: number; tp1BreakevenLock: boolean } }
interface PtaCandidate { symbol?: string; side?: string; ai?: number; conf?: number; verified?: number; pass?: boolean; reasons?: string[]; skip?: string }
interface PtaPosition {
  id: string; market: string; symbol: string; side: 'LONG' | 'SHORT'; entryPrice: number; sl?: number; tp?: number; tp2?: number | null;
  tp1Hit?: boolean; tp2Hit?: boolean; tp1Px?: number | null; bookedPnlINR?: number;
  lastLtp?: number; ltpStale?: boolean; lastPnlINR?: number | null; lastRoePct?: number | null; pnlBasis?: string; status?: string; closeAttempts?: number; leverage?: number | string; mode?: string;
  confirmStreak?: number; reversalReasons?: string[];
  signal?: { aiScore?: number; conf?: number; verified?: number; verifyAction?: string; finalCall?: string };
}
interface PtaView {
  engine: string; running: boolean; mode: 'paper' | 'live'; lastTickAt?: number | null; lastTickAgeSec?: number | null; nextScanInSec?: number;
  gates: PtaGate; config: Record<string, unknown>;
  browser: { connected: boolean; browser?: { product?: string } | null; host?: string; port?: number; portsTried?: number[]; tabs: Record<string, { found: boolean; url?: string; hint?: string | null; health?: Record<string, unknown> }>; lastError?: string | null; hint?: string | null };
  candidates?: PtaCandidate[]; positions?: PtaPosition[];
  today?: { trades: number; cap: number; closed: number; pnlINR: number };
  log?: { ts: number; level: string; text: string }[];
}

const POLL_MS = 15_000;
const LOG_STYLE: Record<string, string> = {
  entry: 'text-emerald-300', exit: 'text-orange-300', error: 'text-red-400',
  skip: 'text-slate-400', info: 'text-cyan-300',
};

async function pta(method: 'GET' | 'POST', path: string, body?: unknown) {
  const r = await apiFetch(`${getProxyBase()}${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(20000),
  });
  const j = await r.json().catch(() => ({ ok: false, error: 'bad json' }));
  return j as Record<string, unknown>;
}

function Chip({ on, label, title, tone = 'cyan' }: { on: boolean | undefined; label: string; title?: string; tone?: 'cyan' | 'emerald' | 'red' | 'amber' | 'violet' }) {
  const tones: Record<string, string> = {
    cyan: 'border-cyan-500/40 bg-cyan-500/10 text-cyan-300',
    emerald: 'border-emerald-500/40 bg-emerald-500/15 text-emerald-300',
    red: 'border-red-500/40 bg-red-500/15 text-red-300',
    amber: 'border-amber-500/40 bg-amber-500/10 text-amber-300',
    violet: 'border-violet-500/40 bg-violet-500/10 text-violet-300',
  };
  return (
    <span
      title={title || label}
      className={`px-1.5 py-0.5 rounded text-[9px] font-black font-mono border tracking-wide ${
        on === undefined ? 'border-slate-600/40 bg-slate-600/20 text-slate-400'
        : on ? tones[tone] : 'border-slate-600/30 bg-slate-700/20 text-slate-500 line-through'}`}
    >
      {label}
    </span>
  );
}

export const ProTraderAutoPanel = memo(function ProTraderAutoPanel({ notify }: { notify?: Notify }) {
  const [view, setView] = useState<PtaView | null>(null);
  const [busy, setBusy] = useState(false);
  const [livePhrase, setLivePhrase] = useState('');
  const [cfgEd, setCfgEd] = useState<Record<string, unknown> | null>(null);
  const liveRef = useRef<HTMLDivElement | null>(null);

  const refresh = useCallback(async () => {
    try {
      const r = await apiFetch(`${getProxyBase()}/api/ai/protrader-auto?t=${Date.now()}`, { signal: AbortSignal.timeout(15000) });
      if (!r.ok) return;
      const j = (await r.json()) as PtaView;
      setView(j);
      setCfgEd((prev) => prev ?? (j.config as unknown as Record<string, unknown>));
    } catch { /* silent — next poll */ }
  }, []);

  useEffect(() => {
    refresh();
    const iv = setInterval(() => { if (!document.hidden) refresh(); }, POLL_MS);
    // live log stream (SSE) — falls back to the 15s poll
    // v20.1 FIX (deep audit #5): the SSE only attached if a token existed
    // at MOUNT time — a panel mounted before session restore (or after a
    // re-login without remount) silently never got the live stream for its
    // whole lifetime. 1s token-wait loop (the useIntradayStream pattern).
    let es: EventSource | null = null;
    let tokenWait: ReturnType<typeof setTimeout> | undefined;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
    const attachStream = () => {
      const session = getSessionToken();
      if (!session) {
        if (!tokenWait) tokenWait = setTimeout(attachStream, 1000);
        return;
      }
      try {
        es = new EventSource(`${getProxyBase()}/api/ai/protrader-auto/stream?session=${encodeURIComponent(session)}`);
        es.addEventListener('status', (e) => {
          try { const j = JSON.parse((e as MessageEvent).data) as PtaView; setView(j); setCfgEd((p) => p ?? (j.config as unknown as Record<string, unknown>)); } catch (err) { swallow('ProTraderAutoPanel.statusFrame', err); } // v21.1.0: malformed frame ab dev-me dikhta hai
        });
        es.onerror = () => {
          // v20.3: the native ~3s auto-reconnect re-tries the SAME
          // (stale-token) URL forever after a re-login. Close and
          // re-attach with a FRESH url + token (the useIntradayStream
          // pattern); the 15s poll keeps the panel alive meanwhile.
          try { es?.close(); } catch { /* noop */ }
          es = null;
          if (!reconnectTimer && !tokenWait) {
            reconnectTimer = setTimeout(() => { reconnectTimer = undefined; attachStream(); }, 5000);
          }
        };
      } catch { /* SSE optional */ }
    };
    attachStream();
    // v18.6.4: tab wapas visible → turant refresh (hidden-period ka frozen
    // engine state ek hi poll-me dikhna band ho jata hai)
    const onVis = () => { if (!document.hidden) refresh(); };
    document.addEventListener('visibilitychange', onVis);
    return () => { clearInterval(iv); if (tokenWait) clearTimeout(tokenWait); if (reconnectTimer) clearTimeout(reconnectTimer); document.removeEventListener('visibilitychange', onVis); try { es?.close(); } catch (err) { swallow('ProTraderAutoPanel.cleanup', err); } };
  }, [refresh]);

  const act = useCallback(async (fn: () => Promise<Record<string, unknown>>, okText: string) => {
    setBusy(true);
    try {
      const j = await fn();
      const ok = Boolean(j?.ok);
      // v20.8.5: alreadyRunning ka HONEST toast — "start" dabaane par jab
      // engine pehle se ON ho, user ko 'already tick' ka seedha jawab.
      if (ok && j?.alreadyRunning) {
        notify?.(true, `ℹ️ PRO TRADER AUTO pehle se ON hai (${String(j.mode || '').toUpperCase()}) — kab se: ${j.startedAt ? new Date(Number(j.startedAt)).toLocaleTimeString('en-IN', { hour12: false }) : '?'} · koi restart nahi hua`);
      } else {
        notify?.(ok, ok ? okText : String((j as { error?: string })?.error || 'action failed'));
      }
      await refresh();
      return j;
    } catch (e) {
      notify?.(false, String((e as Error)?.message || e));
      return null;
    } finally { setBusy(false); }
  }, [notify, refresh]);

  const browser = view?.browser;
  const cfg = (view?.config || {}) as Record<string, unknown>;
  const gates = view?.gates;

  const numField = (key: string, label: string, lo: number, hi: number, step = 1) => cfgEd && (
    <label className="flex items-center justify-between gap-2 bg-black/25 rounded-lg px-2.5 py-1.5 border border-white/5">
      <span className="text-[10px] text-slate-400 font-mono">{label}</span>
      <span className="flex items-center gap-1.5">
        <input
          type="number" min={lo} max={hi} step={step} value={Number(cfgEd[key] ?? 0)}
          onChange={(e) => setCfgEd({ ...cfgEd, [key]: Number(e.target.value) })}
          className="w-20 quantum-input text-[10px] font-mono text-right"
        />
      </span>
    </label>
  );

  return (
    <div className="quantum-panel rounded-2xl p-4">
      {/* header */}
      <div className="flex flex-wrap items-center gap-2 justify-between">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-[13px] font-black gradient-text-cyan tracking-wide">🧠 PRO TRADER AUTO</span>
          <Chip on={view?.running} label={view?.running ? (view.mode === 'live' ? 'LIVE · BROWSER' : 'PAPER') : 'OFF'} tone={view?.mode === 'live' ? 'red' : 'emerald'} title="Auto mode" />
          <Chip on={browser?.connected} label={`BROWSER ${browser?.port ?? 9222}`} tone="cyan" title={browser?.hint || 'Chrome/Edge CDP debug port (Start-AutoBrowser.bat automation window)'} />
          <Chip on={Boolean(browser?.tabs?.coindcx?.found)} label="COINDCX TAB" tone="violet" title={browser?.tabs?.coindcx?.url || 'coindcx.com tab kholo'} />
          <Chip on={Boolean(browser?.tabs?.dhan?.found)} label="DHAN TAB" tone="violet" title={browser?.tabs?.dhan?.url || 'web.dhan.co tab kholo'} />
        </div>
        <div className="flex items-center gap-1.5">
          <button disabled={busy} onClick={() => act(() => pta('POST', '/api/ai/protrader-auto/start', { mode: 'paper' }), 'ProTrader Auto PAPER start')}
            className="quantum-btn-ghost px-2.5 py-1 text-[10px] font-bold text-cyan-300">▶ START PAPER</button>
          <button disabled={busy} onClick={() => {
            if (livePhrase.trim().toUpperCase() !== 'LIVE') { notify?.(false, 'LIVE start karne ke liye box me LIVE type karo'); return; }
            act(() => pta('POST', '/api/ai/protrader-auto/start', { mode: 'live', liveConfirmPhrase: livePhrase.trim() }), 'ProTrader Auto LIVE start — ab browser me trade chalega');
          }} className="quantum-btn-ghost px-2.5 py-1 text-[10px] font-bold text-red-300">▶ START LIVE</button>
          <button disabled={busy || !view?.running} onClick={() => act(() => pta('POST', '/api/ai/protrader-auto/stop'), 'ProTrader Auto stop')}
            className="quantum-btn-ghost px-2.5 py-1 text-[10px] font-bold text-slate-300">■ STOP</button>
        </div>
      </div>

      {/* gates + live phrase */}
      <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
        <span className="text-[9px] font-mono text-slate-500 uppercase tracking-widest mr-1">entry gates</span>
        <Chip on label={`AI ≥ ${gates?.minAiScore ?? 75}`} tone="cyan" title="superIntel.aiScore gate" />
        <Chip on label={`CONF ≥ ${gates?.minConfidence ?? 65}`} tone="cyan" title="ensemble confidence gate" />
        <Chip on label={`VERIFIED ≥ ${gates?.minVerifiedScore ?? 70}`} tone="emerald" title="SVA verify.score + CONFIRM + finalCall === side" />
        <Chip on={gates?.tpExits?.enabled !== false} label={`TP EXITS ${gates?.tpExits?.enabled !== false ? `T1 ${gates?.tpExits?.tp1ClosePct ?? 50}%+BE / T2 FULL` : 'OFF'}`} tone="violet" title="v20.8.5 — TP1 hit: partial book (paper) + SL breakeven-lock; TP2 hit: full exit (profit booked)" />
        <Chip on label={`REVERSAL ${gates?.reversalConfirmTicks ?? 2}× CONFIRM`} tone="amber" title="close only after 2 consecutive reversal confirmations (SL = instant)" />
        <Chip on={cfg.requireVerifyConfirm !== false} label="SVA CONFIRM" tone="violet" />
        {view?.mode === 'paper' && <Chip on={false} label="browser clicks OFF (paper)" tone="amber" />}
      </div>
      {(!view?.running || view?.mode === 'paper') && (
        <div className="mt-2 flex items-center gap-2">
          <input value={livePhrase} onChange={(e) => setLivePhrase(e.target.value)} placeholder="LIVE type karke START LIVE dabao"
            className="quantum-input flex-1 text-[10px] font-mono" />
          <span className="text-[9px] text-slate-500 font-mono">type LIVE</span>
        </div>
      )}

      {/* browser block */}
      <div className="mt-2.5 bg-black/25 rounded-xl p-3 border border-white/5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="text-[10px] font-black text-slate-300 font-mono tracking-wide">🌐 BROWSER AGENT {browser?.browser?.product ? `· ${String(browser.browser.product).slice(0, 40)}` : ''}</span>
          <div className="flex gap-1.5">
            <button disabled={busy} onClick={() => act(() => pta('POST', '/api/ai/protrader-auto/browser/test'), 'Browser health probe complete')}
              className="quantum-btn-ghost px-2 py-0.5 text-[9px] font-bold text-cyan-300">CONNECT + HEALTH</button>
            <button disabled={busy} onClick={() => act(() => pta('POST', '/api/ai/protrader-auto/dry-run'), 'Dry-run complete')}
              className="quantum-btn-ghost px-2 py-0.5 text-[9px] font-bold text-violet-300">DRY RUN</button>
          </div>
        </div>
        {!browser?.connected && (
          <div className="mt-1.5 text-[10px] text-amber-300/90 font-mono leading-relaxed">
            <p>
              ⚠ Browser connect NAHI hua. Aapke NORMAL browser me khuli CoinDCX/Dhan tabs yahan count NAHI hoti —
              SmartAI ko apna DEDICATED automation window chahiye (debug port). Fix:
            </p>
            <p className="mt-1 pl-2 text-slate-300/90">
              1. <b>Start-AutoBrowser.bat</b> chalao (package folder me) — ye alag automation window kholta hai (dedicated profile, Chrome/Edge 136+ ke liye zaroori)
              <br />2. Us AUTOMATION window me CoinDCX + Dhan me <b>ek baar LOGIN</b> karo — tabs khule rakho
              <br />3. Wapas yahan <b>CONNECT + HEALTH</b> dabao — BROWSER + COINDCX TAB + DHAN TAB green ho jayenge
            </p>
            <p className="mt-1 text-slate-500">
              CDP: {browser?.host ?? '127.0.0.1'}:{(browser?.portsTried ?? [9222]).join('/')}
              {browser?.lastError ? ` · last: ${String(browser.lastError).slice(0, 140)}` : ''}
            </p>
          </div>
        )}
        {browser?.connected && browser.hint && (
          <p className="mt-1.5 text-[10px] text-amber-300/90 font-mono leading-relaxed">⚠ {browser.hint}</p>
        )}
        {(['coindcx', 'dhan'] as const).map((k) => {
          const tab = browser?.tabs?.[k];
          const health = tab?.health as { found?: Record<string, boolean>; error?: string } | undefined;
          return (
            <div key={k} className="mt-1.5">
              <div className="flex flex-wrap gap-1 items-center">
                <Chip on={Boolean(tab?.found)} label={k.toUpperCase()} tone={k === 'coindcx' ? 'violet' : 'cyan'} title={tab?.url} />
                {tab?.found && health?.found && Object.entries(health.found).map(([f, on]) => (
                  <Chip key={f} on={Boolean(on)} label={f} tone={on ? 'emerald' : 'red'} title={`${f} selector ${on ? 'OK' : 'MISSING — DOM badla hoga, page reload/inspect karo'}`} />
                ))}
                {tab?.found && health?.error && <span className="text-[9px] text-red-400 font-mono">{String(health.error).slice(0, 90)}</span>}
                {!tab?.found && tab?.hint && <span className="text-[9px] text-amber-300/80 font-mono">{String(tab.hint).slice(0, 110)}</span>}
              </div>
            </div>
          );
        })}
      </div>

      {/* candidates */}
      <div className="mt-2.5 grid gap-3 lg:grid-cols-2">
        <div className="bg-black/25 rounded-xl p-3 border border-white/5">
          <div className="text-[10px] font-black text-slate-300 font-mono tracking-wide mb-1.5">🎯 CANDIDATES (last scan)</div>
          {(view?.candidates || []).length === 0 && <div className="text-[10px] text-slate-500 font-mono">koi candidate nahi / scan pending…</div>}
          {(view?.candidates || []).slice(0, 6).map((c, i) => (
            <div key={`${c.symbol}-${i}`} className="flex flex-wrap items-center gap-1.5 py-0.5 border-b border-white/5 last:border-0">
              <span className={`text-[10px] font-black font-mono ${c.side === 'LONG' ? 'text-emerald-400' : c.side === 'SHORT' ? 'text-red-400' : 'text-slate-400'}`}>{c.symbol}</span>
              <span className="text-[9px] font-mono text-slate-500">{c.side}</span>
              <span className="text-[9px] font-mono text-cyan-300">AI {c.ai ?? '-'}</span>
              <span className="text-[9px] font-mono text-slate-400">C {c.conf ?? '-'}</span>
              <span className="text-[9px] font-mono text-emerald-300">V {c.verified ?? '-'}</span>
              {c.pass ? <Chip on label="PASS" tone="emerald" /> : <span className="text-[9px] font-mono text-slate-600" title={(c.reasons || []).join(', ')}>✗ {(c.skip || (c.reasons || [])[0] || 'gate fail').slice(0, 28)}</span>}
            </div>
          ))}
        </div>

        {/* positions */}
        <div className="bg-black/25 rounded-xl p-3 border border-white/5">
          <div className="text-[10px] font-black text-slate-300 font-mono tracking-wide mb-1.5">
            📈 OPEN POSITIONS ({view?.positions?.length || 0}/{String(cfg.maxConcurrent ?? 3)}) · today {view?.today?.trades ?? 0}/{view?.today?.cap ?? 6} · PnL {view?.today?.pnlINR != null ? `₹${view.today.pnlINR}` : '—'}
          </div>
          {(view?.positions || []).length === 0 && <div className="text-[10px] text-slate-500 font-mono">koi open trade nahi</div>}
          {(view?.positions || []).map((p) => (
            <div key={p.id} className="flex flex-wrap items-center gap-1.5 py-1 border-b border-white/5 last:border-0">
              <span className={`text-[10px] font-black font-mono ${p.side === 'LONG' ? 'text-emerald-400' : 'text-red-400'}`}>{p.symbol}</span>
              <span className="text-[9px] font-mono text-slate-500">{p.side} {p.leverage ? `×${p.leverage}` : ''}</span>
              <span className="text-[9px] font-mono text-slate-400">E {p.entryPrice}</span>
              <span className="text-[9px] font-mono text-cyan-300">L {p.lastLtp ?? '-'}</span>
              {p.tp1Hit && <span className="text-[9px] font-mono font-black text-violet-300" title={`TP1 hit @ ${p.tp1Px ?? '?'} — ${p.mode === 'live' ? 'LIVE: SL breakeven-lock (browser partial nahi)' : 'partial booked + SL breakeven'} · runner TP2 ${p.tp2 || '—'} pe full exit`}>T1✓{p.bookedPnlINR ? ` +₹${p.bookedPnlINR}` : ''}</span>}
              {p.tp2Hit && <span className="text-[9px] font-mono font-black text-emerald-300" title="TP2 hit — full exit">T2✓</span>}
              <span className={`text-[9px] font-mono font-black ${(p.lastPnlINR ?? 0) + (p.bookedPnlINR ?? 0) >= 0 ? 'text-emerald-300' : 'text-red-300'}`} title={`P&L basis: ${p.pnlBasis || 'notional'} (qty × Δprice)${p.bookedPnlINR ? ` · TP1-booked: ₹${p.bookedPnlINR} (final leg alag se)` : ''}${p.lastRoePct != null ? ` · ROE (margin lens): ${p.lastRoePct}%` : ''}`}>{p.lastPnlINR != null ? `${(p.lastPnlINR + (p.bookedPnlINR ?? 0)) >= 0 ? '+' : ''}₹${Math.round(p.lastPnlINR + (p.bookedPnlINR ?? 0))}` : '—'}</span>
              {p.status === 'CLOSE_UNKNOWN' && <span className="text-[9px] font-mono font-black text-amber-300 animate-pulse" title={`Browser close verify nahi hua — retry ${p.closeAttempts || 0}/8 chal raha hai. Broker panel me check karo.`}>⚠ CLOSE RETRY {p.closeAttempts || 0}/8</span>}
              {p.ltpStale && <span className="text-[9px] font-mono text-slate-600" title="LTP last-known hai (feed se fresh nahi mila) — monitor phir bhi chal raha hai">stale</span>}
              {(p.reversalReasons || []).length > 0 && (
                <span className="text-[9px] font-mono text-amber-300" title={(p.reversalReasons || []).join(' + ')}>⟲ {p.confirmStreak || 0}× {(p.reversalReasons || [])[0]?.slice(0, 24)}</span>
              )}
            </div>
          ))}
        </div>
      </div>

      {/* config editor */}
      {cfgEd && (
        <div className="mt-2.5 bg-black/25 rounded-xl p-3 border border-white/5">
          <div className="flex items-center justify-between mb-1.5">
            <span className="text-[10px] font-black text-slate-300 font-mono tracking-wide">⚙ CONFIG</span>
            <button disabled={busy} onClick={() => act(async () => {
              const { enabled, mode, ...patch } = cfgEd as Record<string, unknown>;
              const j = await pta('POST', '/api/ai/protrader-auto/config', patch);
              // v20.9.1 [H3]: server CLAMPS authoritative hain (HTML min/max
              // typed values ko rokate hi nahi; Number('') → 0 snap bhi hota
              // hai) — response ka clamped config wapas editor me sync karo,
              // warna editor 99 dikhata rahega jabki server ne 95 store kiya
              // (aur agli SAVE phir 99 hi bhejti — cross-tab drift).
              if (j?.ok && (j as { config?: Record<string, unknown> })?.config) {
                setCfgEd((prev) => ({ ...(prev || cfgEd), ...((j as { config: Record<string, unknown> }).config) }));
              }
              return j;
            }, 'Config saved')} className="quantum-btn-ghost px-2 py-0.5 text-[9px] font-bold text-cyan-300">SAVE</button>
          </div>
          <div className="grid gap-1.5 sm:grid-cols-2 xl:grid-cols-4">
            {numField('minAiScore', 'min AI score', 50, 95)}
            {numField('minConfidence', 'min conf', 50, 95)}
            {numField('minVerifiedScore', 'min verified', 50, 100)}
            {numField('stakeINR', 'stake ₹/trade', 100, 100000, 50)}
            {numField('cryptoLeverage', 'crypto leverage', 1, 10)}
            {numField('maxConcurrent', 'max open', 1, 10)}
            {numField('maxTradesPerDay', 'max/day', 1, 50)}
            {numField('cooldownMin', 'cooldown min', 5, 720, 5)}
            {numField('minReversalConf', 'reversal conf', 50, 95)}
            {numField('minMtfAgreePct', 'reversal MTF%', 50, 95)}
            {numField('tp1ClosePct', 'TP1 book %', 10, 90, 5)}
          </div>
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            <button onClick={() => setCfgEd({ ...cfgEd, tpExitsEnabled: !(cfgEd.tpExitsEnabled !== false) })}
              className={`px-2 py-0.5 rounded text-[9px] font-black font-mono border ${cfgEd.tpExitsEnabled !== false ? 'bg-violet-500/15 text-violet-300 border-violet-500/40' : 'bg-slate-600/20 text-slate-500 border-slate-600/30'}`}
              title="TP1 hit: partial book (paper) + SL breakeven-lock · TP2 hit: FULL exit (profit booked)">
              TP EXITS {cfgEd.tpExitsEnabled !== false ? 'ON (TP1 partial+BE / TP2 full)' : 'OFF'}
            </button>
            {([['crypto', 'CRYPTO desk'], ['india', 'INDIA desk']] as const).map(([k, label]) => {
              const desks = (cfgEd.desks || {}) as Record<string, boolean>;
              return (
                <button key={k} onClick={() => setCfgEd({ ...cfgEd, desks: { ...desks, [k]: !desks[k] } })}
                  className={`px-2 py-0.5 rounded text-[9px] font-black font-mono border ${desks[k] ? 'bg-emerald-500/15 text-emerald-300 border-emerald-500/40' : 'bg-slate-600/20 text-slate-500 border-slate-600/30'}`}>
                  {label} {desks[k] ? 'ON' : 'OFF'}
                </button>
              );
            })}
            {/* v19.0 user spec → v21.0.5: crypto desk product — FUTURES
                (B-{SYM}_USDT, USDT margin) LOCKED. The SPOT desk is
                REMOVED from the CoinDCX tab, so the legacy spot product
                toggle is gone with it. */}
            <span className="px-2 py-0.5 rounded text-[9px] font-black font-mono border bg-violet-500/15 text-violet-300 border-violet-500/40"
              title="v21.0.5: SPOT desk CoinDCX tab se REMOVE ho chuka hai — auto trading sirf Global Futures (USDT margin) me hota hai.">
              CRYPTO = FUTURES · USDT
            </span>
            <span className="text-[9px] text-slate-500 font-mono self-center">India product: {String(cfg.indiaProduct || 'MTF')} (leverage = MTF)</span>
          </div>
        </div>
      )}

      {/* log */}
      <div ref={liveRef} className="mt-2.5 bg-black/30 rounded-xl p-2.5 border border-white/5 max-h-44 overflow-y-auto scroll-thin font-mono text-[10px] leading-relaxed">
        {(view?.log || []).slice(-40).reverse().map((l, i) => (
          <div key={i} className={LOG_STYLE[l.level] || 'text-slate-300'}>
            <span className="text-slate-600">{new Date(l.ts).toLocaleTimeString('en-IN', { hour12: false })}</span>{' '}
            <span className="uppercase">[{l.level}]</span> {l.text}
          </div>
        ))}
        {(view?.log || []).length === 0 && <div className="text-slate-500">agent log khali — engine start karo</div>}
      </div>

      <p className="mt-2 text-[9px] text-slate-500 font-mono leading-relaxed">
        ENTRY: STRONG + executable + AI ≥{gates?.minAiScore ?? 75} + conf ≥{gates?.minConfidence ?? 65} + verified ≥{gates?.minVerifiedScore ?? 70} (SVA CONFIRM, finalCall=side) ·
        EXIT: TP1 partial book + SL→breakeven / TP2 FULL exit (profit booked) / SL instant / reversal {gates?.reversalConfirmTicks ?? 2}× confirm / EOD 15:15 IST ·
        LIVE = browser clicks (screenshot har order pe: server/data/protrader-shots) · paper = journal-only simulation
      </p>
    </div>
  );
});
