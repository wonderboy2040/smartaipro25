// ============================================================
// intraday/CommitteePanel — TRADER COMMITTEE DEBATE (Phase 2)
// ------------------------------------------------------------
// On-demand debate: Scalper ⚡ / Momentum 📈 / Risk Guardian 🛡️
// analyse the current top setups in parallel, then a Head-of-Desk
// judge issues the FINAL verdict. 10-min server cache.
// ============================================================
import { memo, useCallback, useState } from 'react';
import { apiFetch } from '../../utils/api';
import { describeApiError } from '../../utils/apiError';
import { ChevronDown, Loader2, RefreshCw, Gavel } from 'lucide-react';

interface PersonaResult {
  id: string;
  icon: string;
  label: string;
  take: string | null;
  votes: Record<string, { vote: string; reason: string }>;
  engine: string | null;
}

interface CommitteeData {
  ok: boolean;
  asOf: string;
  istTime: string;
  marketPhase: string;
  marketOpen: boolean;
  regime: { regime: string; vix: number | null; vixLevel: string | null } | null;
  setups: { symbol: string; direction: string; confidence: number }[];
  personas: PersonaResult[];
  verdict: string | null;
  verdictEngine: string | null;
  error?: string;
}

const VOTE_STYLE: Record<string, string> = {
  TRADE: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30',
  PASS: 'bg-slate-500/15 text-slate-300 border-slate-500/30',
  VETO: 'bg-red-500/15 text-red-300 border-red-500/30',
};

// Render persona take / verdict text (bullets + **bold** + ### headers).
function renderTake(text: string) {
  return text.split('\n').map((line, i) => {
    const t = line.trim();
    if (!t) return <div key={i} className="h-1.5" />;
    const header = t.match(/^#{1,4}\s+(.*)$/);
    const parts = t.replace(/^#{1,4}\s+/, '').split(/(\*\*[^*]+\*\*)/g).map((p, j) =>
      p.startsWith('**') && p.endsWith('**')
        ? <b key={j} className="text-slate-100">{p.slice(2, -2)}</b>
        : <span key={j}>{p}</span>,
    );
    if (header) return <div key={i} className="font-bold text-slate-100 text-[11.5px] pt-1.5">{parts}</div>;
    const bullet = /^[-•*]\s+/.test(t);
    return bullet
      ? <div key={i} className="flex gap-1.5"><span className="text-purple-400/60 shrink-0">▸</span><div className="flex-1">{parts}</div></div>
      : <div key={i}>{parts}</div>;
  });
}

// 2026 perf audit (M4): memoized — IntradayTab re-renders on every SSE tick;
// this panel manages its own state so memo short-circuits needless re-renders.
export const CommitteePanel = memo(function CommitteePanel() {
  const [data, setData] = useState<CommitteeData | null>(null);
  const [busy, setBusy] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [error, setError] = useState('');

  const run = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      const res = await apiFetch('/api/intraday-committee', {
        method: 'POST',
        signal: AbortSignal.timeout(120000),
      });
      const d = await res.json().catch(() => ({}));
      // v10.10 [object Object] fix — unwrap {error:{message}} properly.
      if (!res.ok) throw new Error(describeApiError(d, res.status, `committee error ${res.status}`));
      setData(d);
    } catch (e) {
      const err = e as { message?: string };
      setError(err?.message || 'Committee unavailable');
    } finally {
      setBusy(false);
    }
  }, [busy]);

  return (
    <div className="quantum-panel rounded-2xl border border-amber-500/20 overflow-hidden bg-black/40">
      <button
        onClick={() => setExpanded(e => !e)}
        className="w-full flex items-center justify-between gap-2 px-4 py-3 hover:bg-white/[0.02]"
      >
        <div className="flex items-center gap-2 flex-wrap">
          <span className="flex items-center gap-1.5 text-xs font-black text-transparent bg-clip-text bg-gradient-to-r from-amber-300 to-red-300">
            <Gavel size={14} className="text-amber-400" /> TRADER COMMITTEE DEBATE
          </span>
          <span className="px-2 py-0.5 rounded-md text-[9px] font-black font-mono border bg-amber-500/15 text-amber-300 border-amber-500/30">
            ⚡📈🛡️ 3 PERSONAS
          </span>
          {data && !busy && (
            <span className="text-[10px] font-mono text-slate-500">
              last debate {new Date(data.asOf).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour12: false })} IST
            </span>
          )}
        </div>
        <ChevronDown size={15} className={`text-slate-500 transition-transform ${expanded ? 'rotate-180' : ''}`} />
      </button>

      {expanded && (
        <div className="px-3 pb-3 space-y-3">
          {/* Run button */}
          <div className="flex items-center gap-2 flex-wrap">
            <button
              onClick={run}
              disabled={busy}
              className="px-3.5 py-2 rounded-xl bg-amber-500/20 border border-amber-500/40 text-amber-200 font-bold text-[11px] hover:bg-amber-500/30 transition-all disabled:opacity-40 flex items-center gap-1.5"
            >
              {busy ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />}
              {busy ? 'Committee debate ho rahi hai…' : data ? 'Re-run Debate' : 'Run Committee Debate'}
            </button>
            {data?.regime && (
              <span className="text-[10px] font-mono text-slate-500">
                NIFTY {data.regime.regime} • VIX {data.regime.vix?.toFixed(1) ?? 'n/a'}
              </span>
            )}
            <span className="text-[10px] font-mono text-slate-600">4 AI calls • 10-min cache</span>
          </div>

          {error && (
            <div className="rounded-xl border border-red-500/25 bg-red-500/10 px-3 py-2 text-[11px] text-red-300 font-mono">
              ⚠️ {error}
            </div>
          )}

          {busy && !data && (
            <div className="grid gap-2 md:grid-cols-3">
              {['⚡ Scalper', '📈 Momentum', '🛡️ Guardian'].map(p => (
                <div key={p} className="rounded-xl border border-white/10 bg-white/[0.02] p-3 animate-pulse">
                  <div className="text-[11px] font-bold text-slate-400">{p} thinking…</div>
                </div>
              ))}
            </div>
          )}

          {data?.personas && (
            <>
              {/* Persona cards */}
              <div className="grid gap-2 md:grid-cols-3">
                {data.personas.map(p => (
                  <div key={p.id} className="rounded-xl border border-white/10 bg-white/[0.02] p-3 space-y-2">
                    <div className="flex items-center justify-between gap-1">
                      <div className="text-[11px] font-black text-slate-200">{p.icon} {p.label}</div>
                      <div className="flex gap-1">
                        {data.setups.map(s => {
                          const v = p.votes?.[s.symbol]?.vote;
                          return v ? (
                            <span key={s.symbol} className={`px-1.5 py-0.5 rounded-md text-[8.5px] font-black font-mono border ${VOTE_STYLE[v] || ''}`} title={`${s.symbol}: ${p.votes[s.symbol]?.reason || ''}`}>
                              {s.symbol.slice(0, 4)} {v}
                            </span>
                          ) : null;
                        })}
                      </div>
                    </div>
                    {p.take ? (
                      <div className="text-[10.5px] leading-relaxed text-slate-400 space-y-0.5 max-h-52 overflow-y-auto scroll-thin pr-1">
                        {renderTake(p.take)}
                      </div>
                    ) : (
                      <div className="text-[10px] text-slate-600 font-mono italic">no response (engine fallback)</div>
                    )}
                  </div>
                ))}
              </div>

              {/* Judge verdict */}
              {data.verdict && (
                <div className="rounded-xl border border-amber-500/25 bg-amber-500/[0.04] p-3 space-y-1.5">
                  <div className="flex items-center justify-between gap-2">
                    <div className="text-[11px] font-black text-amber-200">⚖️ HEAD OF DESK — FINAL VERDICT</div>
                    {data.verdictEngine && (
                      <span className="text-[9px] font-mono text-slate-600">{data.verdictEngine.split('/').pop()?.slice(0, 20)}</span>
                    )}
                  </div>
                  <div className="text-[11px] leading-relaxed text-slate-300 space-y-0.5">
                    {renderTake(data.verdict)}
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
});
