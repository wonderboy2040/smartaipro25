// ============================================================
// intraday/JournalPanel — AUTO TRADE JOURNAL (Phase 2)
// ------------------------------------------------------------
// Every closed virtual trade auto-journals (server-side hook).
// EOD AI review (15:45 IST cron ya on-demand button) + weekly
// improvement report (Fri 16:30 cron / on-demand) yahan dikhte
// hain. Panel trade log + AI coaching dono dikhata hai.
// ============================================================
import { memo, useCallback, useEffect, useState } from 'react';
import { apiFetch } from '../../utils/api';
import { describeApiError } from '../../utils/apiError';
import { ChevronDown, Loader2, BookOpen, Sparkles, CalendarDays } from 'lucide-react';

interface JournalEntry {
  tradeId: number;
  dayKey: string;
  symbol: string;
  direction: string;
  closeReason: string;
  realizedPnl: number;
  /** v11.1 GAP 3: net-of-costs pair on new entries (legacy stays gross). */
  costs?: number;
  netPnl?: number;
  rMultiple: number | null;
  holdMinutes: number | null;
  t1Hit: boolean;
  reviewed: boolean;
}

interface JournalData {
  entries: JournalEntry[];
  stats: { wins: number; losses: number; netPnl: number; avgR: number | null; count: number };
  todayReview: { text: string; engine: string } | null;
  reviews: { dayKey: string; text: string; engine: string; stats: { wins: number; losses: number; netPnl: number } }[];
  weekly: { weekKey: string; text: string; engine: string; stats: { wins: number; losses: number; netPnl: number; slDiscipline: number | null; t1BookingRate: number | null } }[];
}

const REASON_LABEL: Record<string, string> = {
  SL_HIT: '🛑 SL', SL_TRAIL_HIT: '🔒 Trail', T2_HIT: '🏆 T2', T1_BOOK: '🎯 T1',
  EOD_SQOFF: '🌙 EOD', MANUAL: '✋ Manual', STALE_SQOFF: '💤 Stale',
};

function renderAiText(text: string) {
  return text.split('\n').map((line, i) => {
    const t = line.trim();
    if (!t) return <div key={i} className="h-1.5" />;
    const header = t.match(/^#{1,4}\s+(.*)$/) || (t.startsWith('**') && t.endsWith('**') ? [null, t.slice(2, -2)] : null);
    const parts = t.replace(/^#{1,4}\s+/, '').replace(/^\*\*(.+)\*\*$/, '$1').split(/(\*\*[^*]+\*\*)/g).map((p, j) =>
      p.startsWith('**') && p.endsWith('**')
        ? <b key={j} className="text-slate-100">{p.slice(2, -2)}</b>
        : <span key={j}>{p}</span>,
    );
    if (header) return <div key={i} className="font-bold text-slate-100 text-[11px] pt-1">{parts}</div>;
    const bullet = /^[-•*]\s+/.test(t);
    return bullet
      ? <div key={i} className="flex gap-1.5"><span className="text-cyan-400/60 shrink-0">▸</span><div className="flex-1">{parts}</div></div>
      : <div key={i}>{parts}</div>;
  });
}

// 2026 perf audit (M4): memoized — only re-renders when refreshKey changes,
// not on every IntradayTab SSE quote tick.
export const JournalPanel = memo(function JournalPanel({ refreshKey }: { refreshKey: number }) {
  const [data, setData] = useState<JournalData | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [busy, setBusy] = useState<'eod' | 'weekly' | null>(null);
  const [msg, setMsg] = useState('');

  const load = useCallback(async () => {
    try {
      const res = await apiFetch('/api/intraday-journal?days=14', { signal: AbortSignal.timeout(8000) });
      if (res.ok) setData(await res.json());
    } catch { /* offline */ }
  }, []);

  useEffect(() => { load(); }, [load, refreshKey]);

  const runEod = async () => {
    setBusy('eod'); setMsg('');
    try {
      const res = await apiFetch('/api/intraday-journal/eod', { method: 'POST', signal: AbortSignal.timeout(90000) });
      const d = await res.json().catch(() => ({}));
      setMsg(res.ok ? '✅ EOD review ready' : `⚠️ ${describeApiError(d, res.status, 'review failed')}`);
      if (res.ok) load();
    } catch { setMsg('⚠️ EOD review timeout — thodi der baad try karein'); }
    finally { setBusy(null); }
  };

  const runWeekly = async () => {
    setBusy('weekly'); setMsg('');
    try {
      const res = await apiFetch('/api/intraday-journal/weekly', { method: 'POST', signal: AbortSignal.timeout(90000) });
      const d = await res.json().catch(() => ({}));
      setMsg(res.ok ? '✅ Weekly report ready' : `⚠️ ${describeApiError(d, res.status, 'report failed')}`);
      if (res.ok) load();
    } catch { setMsg('⚠️ Weekly report timeout — thodi der baad try karein'); }
    finally { setBusy(null); }
  };

  if (!data) return null;

  const hasContent = data.entries.length > 0 || data.reviews.length > 0 || data.weekly.length > 0;
  const pnl = data.stats?.netPnl ?? 0;

  return (
    <div className="quantum-panel rounded-2xl border border-cyan-500/20 overflow-hidden bg-black/40">
      <button
        onClick={() => setExpanded(e => !e)}
        className="w-full flex items-center justify-between gap-2 px-4 py-3 hover:bg-white/[0.02]"
      >
        <div className="flex items-center gap-2 flex-wrap">
          <span className="flex items-center gap-1.5 text-xs font-bold text-slate-200">
            <BookOpen size={14} className="text-cyan-400" /> AUTO TRADE JOURNAL
          </span>
          {data.stats && data.stats.count > 0 && (
            <span className="px-2 py-0.5 rounded-md text-[9px] font-black font-mono border bg-cyan-500/10 text-cyan-300 border-cyan-500/30">
              {data.stats.count} TRADES • {data.stats.wins}W/{data.stats.losses}L • {pnl >= 0 ? '+' : '−'}₹{Math.abs(pnl).toFixed(0)}
            </span>
          )}
          {data.todayReview && (
            <span className="px-2 py-0.5 rounded-md text-[9px] font-black font-mono border bg-emerald-500/15 text-emerald-300 border-emerald-500/30">
              ✅ AI REVIEWED
            </span>
          )}
          <span className="text-[9px] font-mono text-slate-600 hidden sm:inline">auto-journals every virtual trade</span>
        </div>
        <ChevronDown size={15} className={`text-slate-500 transition-transform ${expanded ? 'rotate-180' : ''}`} />
      </button>

      {expanded && (
        <div className="px-3 pb-3 space-y-3">
          {!hasContent && (
            <div className="text-center py-6 text-[11px] text-slate-500">
              Abhi koi closed trade nahi — pehle virtual trade close hone par journal auto-start ho jayega. 📝
            </div>
          )}

          {/* Action buttons */}
          <div className="flex items-center gap-2 flex-wrap">
            <button
              onClick={runEod}
              disabled={busy != null}
              className="px-3 py-1.5 rounded-xl bg-cyan-500/15 border border-cyan-500/35 text-cyan-200 font-bold text-[10.5px] hover:bg-cyan-500/25 transition-all disabled:opacity-40 flex items-center gap-1.5"
            >
              {busy === 'eod' ? <Loader2 size={12} className="animate-spin" /> : <Sparkles size={12} />}
              {busy === 'eod' ? 'Reviewing…' : 'Run EOD Review'}
            </button>
            <button
              onClick={runWeekly}
              disabled={busy != null}
              className="px-3 py-1.5 rounded-xl bg-purple-500/15 border border-purple-500/35 text-purple-200 font-bold text-[10.5px] hover:bg-purple-500/25 transition-all disabled:opacity-40 flex items-center gap-1.5"
            >
              {busy === 'weekly' ? <Loader2 size={12} className="animate-spin" /> : <CalendarDays size={12} />}
              {busy === 'weekly' ? 'Compiling…' : 'Weekly Report'}
            </button>
            {msg && <span className="text-[10px] font-mono text-slate-400">{msg}</span>}
          </div>

          {/* Today / latest EOD review */}
          {(data.todayReview || data.reviews[0]) && (
            <div className="rounded-xl border border-cyan-500/25 bg-cyan-500/[0.04] p-3 space-y-1.5">
              <div className="text-[11px] font-black text-cyan-200">
                🎯 EOD REVIEW — {data.todayReview ? 'TODAY' : data.reviews[0]?.dayKey}
              </div>
              <div className="text-[11px] leading-relaxed text-slate-300 space-y-0.5">
                {renderAiText((data.todayReview || data.reviews[0])!.text)}
              </div>
            </div>
          )}

          {/* Weekly report */}
          {data.weekly[0] && (
            <div className="rounded-xl border border-purple-500/25 bg-purple-500/[0.04] p-3 space-y-1.5">
              <div className="flex items-center justify-between gap-2">
                <div className="text-[11px] font-black text-purple-200">📅 WEEKLY REPORT — {data.weekly[0].weekKey}</div>
                {data.weekly[0].stats.slDiscipline != null && (
                  <span className="text-[9px] font-mono text-slate-500">
                    SL discipline {data.weekly[0].stats.slDiscipline}% • T1 booking {data.weekly[0].stats.t1BookingRate ?? 'n/a'}%
                  </span>
                )}
              </div>
              <div className="text-[11px] leading-relaxed text-slate-300 space-y-0.5">
                {renderAiText(data.weekly[0].text)}
              </div>
            </div>
          )}

          {/* Trade log */}
          {data.entries.length > 0 && (
            <div className="rounded-xl border border-white/10 overflow-hidden">
              <div className="grid grid-cols-[1.1fr_0.7fr_0.9fr_1fr_0.8fr] gap-1 px-2.5 py-1.5 bg-white/[0.03] text-[9px] font-black font-mono text-slate-500 uppercase tracking-wide">
                <span>Symbol</span><span>Dir</span><span>Exit</span><span className="text-right">P&L</span><span className="text-right">R</span>
              </div>
              <div className="max-h-56 overflow-y-auto scroll-thin">
                {data.entries.slice(0, 30).map(e => (
                  <div key={e.tradeId} className="grid grid-cols-[1.1fr_0.7fr_0.9fr_1fr_0.8fr] gap-1 px-2.5 py-1.5 text-[10.5px] font-mono border-t border-white/5 items-center">
                    <span className="text-slate-200 font-bold">{e.symbol}</span>
                    <span className={e.direction === 'LONG' ? 'text-emerald-400' : 'text-red-400'}>{e.direction === 'LONG' ? '▲' : '▼'}</span>
                    <span className="text-slate-400">{REASON_LABEL[e.closeReason] || e.closeReason}</span>
                    <span className={`text-right font-bold ${(e.netPnl ?? e.realizedPnl) > 0 ? 'text-emerald-400' : (e.netPnl ?? e.realizedPnl) < 0 ? 'text-red-400' : 'text-slate-400'}`} title={e.costs != null ? `gross ₹${e.realizedPnl} − costs ₹${e.costs} (brokerage/STT/txn/GST/SEBI/stamp)` : undefined}>
                      {(e.netPnl ?? e.realizedPnl) >= 0 ? '+' : '−'}₹{Math.abs(e.netPnl ?? e.realizedPnl).toFixed(0)}{e.costs != null && <span className="ml-0.5 text-[8px] font-black text-amber-500/70">net</span>}
                    </span>
                    <span className={`text-right ${e.rMultiple != null && e.rMultiple > 0 ? 'text-emerald-400/80' : 'text-slate-500'}`}>
                      {e.rMultiple != null ? `${e.rMultiple >= 0 ? '+' : ''}${e.rMultiple}R` : '—'}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
});
