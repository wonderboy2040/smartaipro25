// ============================================================
// src/components/aitrading/ManualTradeMonitor.tsx
// ------------------------------------------------------------
// v10.16 SECTION 2C — the dedicated MANUAL TRADE tracking section
// (rendered in both desks, above the paper-trade positions).
//
// Per trade: live LTP (5s refresh — the T1-tier cadence), live P&L in
// ₹/USDT and %, distance to SL and each target, time in trade, the
// LIVE CONVICTION BAR (ensemble re-vote vs the frozen entry snapshot),
// and the escalating STATE BANNER:
//   THESIS INTACT (green) — ensemble still backs the original side
//   WEAKENING     (amber) — conviction decaying, consider tightening
//   EXIT NOW      (red, pulsing, PINNED TO TOP) — ensemble FLIPPED
//   TARGET HIT    (blue) — price reached T1/T2
// Self-contained: fetches /api/manual-trades itself (5s while open
// trades exist, 30s idle), so the tabs need zero wiring beyond
// dropping the section in.
// ============================================================
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { apiFetch, getProxyBase } from '../../utils/api';
// v12.9 REALTIME: the tracker rides the SAME SSE tick stream the signal
// cards do (~1s pushes) — LTP + P&L repaint instantly between the 5s
// reconciliation polls.
import { useCxLivePrices } from './useCxLivePrices';
import { mergeLiveTicks, liveKeyFor } from './manualLiveMerge';

interface ManualTradeView {
  id: number;
  market: string;
  symbol: string;
  side: 'BUY' | 'SELL';
  assetKind?: 'OPTION' | null;
  entryPrice: number;
  qty: number;
  lotSize?: number;
  strike?: number;
  expiry?: string;
  optType?: string;
  status: string;
  entryTime: number;
  openedAt: number;
  closedAt?: number;
  exitPrice?: number;
  exitPnlINR?: number;
  exitPnlPct?: number;
  closeReason?: string;
  note?: string;
  origin?: {
    aiScore: number | null;
    grade: string | null;
    regime: string | null;
    voters: number | null;
    plan: { entry: number | null; stopLoss: number | null; target1: number | null; target2: number | null; riskPct: number | null; atr: number | null } | null;
    votes: Array<{ id: string; name: string; dir: number; conf: number | null }>;
  } | null;
  /** v13.1: the SVA verdict FROZEN at open — did the pro-trader layer
   *  confirm this entry, caution it, or reject it outright? */
  verify?: {
    agent: string;
    action: string;
    finalCall: string;
    score: number;
    veto?: boolean;
    verdict?: string;
    fails?: string[];
    warns?: number;
  } | null;
  __ltp?: number | null;
  /** v12.0: frozen at close — final R, peak R (MFE), exit-quality verdict. */
  exitR?: number | null;
  exitPeakR?: number | null;
  exitQuality?: string | null;
  __view?: {
    ltp: number | null;
    ageMin: number | null;
    pnl: { pnlINR: number; pnlPct: number; pnlUSDT: number | null; currency: 'INR' | 'USDT' };
    distances: { sl?: number | null; t1?: number | null; t2?: number | null };
    /** v12.0: the R-multiple view — rNow / rPeak (MFE) / rTrough (MAE) /
     * capturePct (kitna % of peak abhi bhi held hai). */
    r?: { riskPct: number | null; rNow: number | null; rPeak: number | null; rTrough: number | null; mfePct: number | null; maePct: number | null; capturePct: number | null };
    exitQuality?: string | null;
    conviction: { state: string | null; delta: number | null; currentScore: number | null; entryScore: number | null };
    banner: 'THESIS_INTACT' | 'WEAKENING' | 'EXIT_NOW' | 'TARGET_HIT' | 'STALE' | 'LOSS_CAP' | 'REVERSAL_BOOK';
    reversal?: { enabled: boolean; lossCapINR: number; profitTargetINR: number; pnlINR: number; state?: string | null; cycleId?: string | null; leg?: number | null; flip?: { side: string; qty: number; entry: number; sl: number | null; tp: number | null } | null } | null;
  };
}

/** v12.0: the tracker's aggregate track-record (closed trades). */
interface ManualStatsView {
  closed: number;
  closedWithR: number;
  wins: number;
  losses: number;
  winRate: number | null;
  avgR: number | null;
  bestR: number | null;
  worstR: number | null;
  avgHoldMin: number | null;
  avgCapturePct: number | null;
  gaveBack: number;
  disciplinedLosses: number;
  overshootLosses: number;
  note: string;
}

const EXIT_QUALITY_STYLE: Record<string, { cls: string; label: string; title: string }> = {
  CLEAN_WIN: { cls: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/40', label: 'CLEAN WIN', title: 'Winner ne apne peak excursion ka zyada tar capture kiya' },
  CUT_WINNER: { cls: 'bg-amber-500/15 text-amber-300 border-amber-500/40', label: 'CUT TOO EARLY', title: 'Trade green tha lekin peak se bahut pehle cut hua — patience premium miss hua' },
  GAVE_BACK: { cls: 'bg-red-500/15 text-red-300 border-red-500/40', label: 'GAVE BACK', title: 'Profit tha, peak ke baad wapas de diya — trailing/breakeven discipline try karo' },
  DISCIPLINED_LOSS: { cls: 'bg-slate-600/20 text-slate-400 border-slate-600/30', label: 'DISCIPLINED LOSS', title: ' planned 1R ke andar loss — risk management kaam kar raha hai' },
  OVERSHOOT_LOSS: { cls: 'bg-red-500/20 text-red-300 border-red-500/50', label: 'OVERSHOT SL', title: '1R se zyada loss — stop slippage ya late exit, review karo' },
  UNKNOWN: { cls: 'bg-slate-600/20 text-slate-400 border-slate-600/30', label: '—', title: '' },
};

interface Props {
  /** 'INDIA' desk shows only India trades; 'CRYPTO' desk shows crypto+global; null = all. */
  desk?: 'INDIA' | 'CRYPTO' | null;
  notify?: (ok: boolean, text: string) => void;
}

const BANNER_STYLE: Record<string, { chip: string; label: string; icon: string }> = {
  THESIS_INTACT: { chip: 'bg-emerald-500/15 border-emerald-500/40 text-emerald-300', label: 'THESIS INTACT', icon: '🟢' },
  WEAKENING: { chip: 'bg-amber-500/15 border-amber-500/40 text-amber-300', label: 'WEAKENING — consider tightening', icon: '🟡' },
  EXIT_NOW: { chip: 'bg-red-500/20 border-red-500/60 text-red-300', label: 'EXIT NOW — ensemble FLIPPED', icon: '🚨' },
  TARGET_HIT: { chip: 'bg-sky-500/15 border-sky-500/40 text-sky-300', label: 'TARGET HIT', icon: '🎯' },
  STALE: { chip: 'bg-slate-500/15 border-slate-500/40 text-slate-400', label: 'STALE — conviction data missing', icon: '⏸' },
  // v12.8/v12.9 REVERSAL AI (engine-connected): the ₹ states of the
  // manual cycle — the loss-cap plan + the ₹ target BOOK call.
  LOSS_CAP: { chip: 'bg-violet-500/20 border-violet-500/60 text-violet-300', label: 'LOSS-CAP hit — Reversal cycle ACTIVE', icon: '🛑' },
  REVERSAL_BOOK: { chip: 'bg-emerald-500/20 border-emerald-500/60 text-emerald-300', label: '₹ TARGET hit — BOOK karo', icon: '✅' },
};

const pxFmt = (v: number | null | undefined, usd = false): string => {
  if (v == null || !Number.isFinite(v)) return '—';
  const a = Math.abs(v);
  const dp = a >= 1000 ? 2 : a >= 1 ? 2 : a >= 0.01 ? 4 : a >= 0.0001 ? 6 : 8;
  const s = v.toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp });
  return usd ? (a >= 1000 ? `$${s}` : `$${s}`) : `₹${s}`;
};

const pnlFmt = (n: number | null | undefined): string => {
  if (n == null || !Number.isFinite(n)) return '—';
  const sign = n >= 0 ? '+' : '−';
  const a = Math.abs(n);
  return a >= 1000 ? `${sign}${a >= 100000 ? (a / 100000).toFixed(2) + 'L' : Math.round(a).toLocaleString('en-IN')}` : `${sign}${a.toFixed(2)}`;
};

const ageFmt = (min: number | null): string => {
  if (min == null) return '—';
  if (min < 60) return `${Math.round(min)}m`;
  // v18.6.4: floor the remainder — Math.round "1h 60m" bana sakta tha
  return `${Math.floor(min / 60)}h ${Math.floor(min % 60)}m`;
};

/** The live conviction bar: entry score → current score, with the delta. */
const ConvictionBar = memo(function ConvictionBar({ view }: { view: NonNullable<ManualTradeView['__view']> }) {
  const c = view.conviction;
  const entry = c.entryScore ?? 0;
  const cur = c.currentScore ?? 0;
  const side = (c.state ?? '').toUpperCase();
  const barColor = side === 'FLIPPED' ? 'bg-red-500'
    : side === 'WEAKENING' ? 'bg-amber-400'
    : side === 'STRENGTHENING' ? 'bg-emerald-400'
    : 'bg-cyan-400';
  return (
    <div className="min-w-[128px]">
      <div className="flex items-center justify-between text-[9px] text-slate-500 mb-0.5">
        <span>CONVICTION</span>
        <span className="text-slate-400 font-mono">
          {entry ? Math.round(entry) : '—'} → {cur ? Math.round(cur) : '—'}
          {c.delta != null && (
            <span className={c.delta >= 0 ? 'text-emerald-400' : 'text-red-400'}> ({c.delta >= 0 ? '+' : ''}{c.delta})</span>
          )}
        </span>
      </div>
      <div className="h-1.5 bg-slate-800 rounded-full overflow-hidden flex">
        <div className="h-full bg-slate-600/70" style={{ width: `${Math.min(100, Math.max(0, entry))}%` }} />
        <div className={`h-full ${barColor} transition-all duration-700`} style={{ width: `${Math.max(0, Math.min(100, cur) - Math.min(100, Math.max(0, entry)))}%` }} />
      </div>
    </div>
  );
});

/** One open manual trade row. */
const ManualRow = memo(function ManualRow({ t, onClose, busy }: { t: ManualTradeView; onClose: (t: ManualTradeView) => void; busy: boolean }) {
  const v = t.__view;
  const usd = t.market === 'FUTURES' || t.market === 'GLOBALFUTURES';
  const banner = v?.banner ?? 'STALE';
  const bs = BANNER_STYLE[banner] ?? BANNER_STYLE.STALE;
  const pnl = v?.pnl;
  const dist = v?.distances ?? {};
  const long = t.side === 'BUY';
  return (
    <div className={`rounded-xl border p-3 space-y-2.5 transition-all
      ${banner === 'EXIT_NOW' ? 'border-red-500/50 bg-red-950/30 animate-pulse' : banner === 'LOSS_CAP' ? 'border-violet-500/50 bg-violet-950/20' : banner === 'REVERSAL_BOOK' ? 'border-emerald-500/50 bg-emerald-950/20' : 'border-slate-700/50 bg-slate-900/40'}`}>
      {/* line 1: identity + banner */}
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-sm font-black text-slate-100 truncate">{t.symbol}</span>
          <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${long ? 'bg-emerald-500/15 text-emerald-400' : 'bg-red-500/15 text-red-400'}`}>
            {long ? 'LONG' : 'SHORT'}
          </span>
          {t.assetKind === 'OPTION' && (
            <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-violet-500/15 text-violet-300">
              {t.optType} {t.strike} · {t.expiry}
            </span>
          )}
          <span className="text-[10px] text-slate-500">{t.market}</span>
        </div>
        <span className={`text-[10px] font-black px-2 py-1 rounded-lg border ${bs.chip}`}>
          {bs.icon} {bs.label}
        </span>
      </div>

      {/* line 2: price + P&L + R-multiple + distances */}
      <div className="grid grid-cols-2 sm:grid-cols-5 gap-2 text-[11px]">
        <div>
          <div className="text-slate-500 text-[9px] uppercase tracking-wide font-bold">Entry → Live</div>
          <div className="font-mono text-slate-200">
            {pxFmt(t.entryPrice, usd)} → <b className="text-cyan-300">{pxFmt(v?.ltp, usd)}</b>
          </div>
        </div>
        <div>
          <div className="text-slate-500 text-[9px] uppercase tracking-wide font-bold">P&L ({pnl?.currency === 'USDT' ? 'USDT' : 'INR'})</div>
          <div className={`font-mono font-bold ${(pnl?.pnlPct ?? 0) >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
            {pnlFmt(pnl?.currency === 'USDT' ? pnl?.pnlUSDT : pnl?.pnlINR)} · {pnl?.pnlPct != null ? `${pnl.pnlPct >= 0 ? '+' : ''}${pnl.pnlPct.toFixed(2)}%` : '—'}
          </div>
        </div>
        {/* v12.0: the live R-multiple + peak capture — "kitna R khada hai
            aur peak se kitna gira hai" ek nazar me */}
        <div>
          <div className="text-slate-500 text-[9px] uppercase tracking-wide font-bold" title={`1R = ${v?.r?.riskPct != null ? v.r.riskPct.toFixed(2) + '%' : 'origin SL se'} · peak = max favorable excursion (MFE)`}>R NOW / PEAK</div>
          <div className="font-mono font-bold" title={`MFE ${v?.r?.mfePct != null ? v.r.mfePct.toFixed(2) + '%' : '—'} · MAE ${v?.r?.maePct != null ? v.r.maePct.toFixed(2) + '%' : '—'} · capture ${v?.r?.capturePct != null ? v.r.capturePct.toFixed(0) + '%' : '—'}`}>
            <span className={(v?.r?.rNow ?? 0) >= 0 ? 'text-emerald-400' : 'text-red-400'}>{v?.r?.rNow != null ? `${v.r.rNow > 0 ? '+' : ''}${v.r.rNow.toFixed(2)}R` : '—'}</span>
            <span className="text-slate-600"> / </span>
            <span className="text-cyan-400">{v?.r?.rPeak != null ? `peak ${v.r.rPeak > 0 ? '+' : ''}${v.r.rPeak.toFixed(2)}R` : '—'}</span>
            {v?.r?.capturePct != null && (v.r.rPeak ?? 0) > 0.5 && (
              <span className={`ml-1 text-[9px] font-black ${v.r.capturePct >= 60 ? 'text-emerald-400' : v.r.capturePct >= 30 ? 'text-amber-400' : 'text-red-400'}`}>
                {Math.round(v.r.capturePct)}% kept
              </span>
            )}
          </div>
        </div>
        <div>
          <div className="text-slate-500 text-[9px] uppercase tracking-wide font-bold">SL / T1 / T2 dist</div>
          <div className="font-mono text-slate-300">
            <span className="text-red-400/90">{dist.sl != null ? `${dist.sl.toFixed(1)}%` : '—'}</span>
            {' / '}
            <span className="text-emerald-400/90">{dist.t1 != null ? `${dist.t1.toFixed(1)}%` : '—'}</span>
            {' / '}
            <span className="text-emerald-300/90">{dist.t2 != null ? `${dist.t2.toFixed(1)}%` : '—'}</span>
          </div>
        </div>
        <div>
          <div className="text-slate-500 text-[9px] uppercase tracking-wide font-bold">Time in trade</div>
          <div className="font-mono text-slate-300">{ageFmt(v?.ageMin ?? null)}</div>
        </div>
      </div>

      {/* line 3: conviction bar + snapshot chips + close */}
      <div className="flex items-end justify-between gap-3 flex-wrap">
        {/* v18.6.4: __view guard — ek OPEN trade bina view ke (partial
            response / restore) ConvictionBar ko crash karta tha
            ("Tab crashed"). Honest null render. */}
        {v ? <ConvictionBar view={v} /> : <span className="text-[9px] text-slate-600">conviction —</span>}
        <div className="flex items-center gap-2 flex-wrap">
          {t.origin?.aiScore != null && (
            <span className="text-[9px] text-slate-500 border border-slate-700/50 rounded px-1.5 py-0.5">
              entry AI {Math.round(t.origin.aiScore)} · {t.origin.grade ?? '—'}{t.origin.voters ? ` · ${t.origin.voters} voters` : ''}
            </span>
          )}
          {t.origin?.regime && (
            <span className="text-[9px] text-slate-500 border border-slate-700/50 rounded px-1.5 py-0.5">{t.origin.regime}</span>
          )}
          {/* v13.1 SVA open-time verdict — the "kya verifier ne pehle hi
              mana kiya tha?" stamp. Red when the trade was opened against
              a FLIP/STAND_ASIDE verdict (the XRP class). */}
          {t.verify && (
            <span
              className={`text-[9px] font-black border rounded px-1.5 py-0.5 font-mono ${
                t.verify.action === 'CONFIRM' ? 'bg-emerald-500/15 text-emerald-300 border-emerald-500/40'
                  : t.verify.action === 'CAUTION' ? 'bg-amber-500/15 text-amber-300 border-amber-500/40'
                    : 'bg-rose-500/15 text-rose-300 border-rose-500/40'}`}
              title={`SVA verdict @ open: ${t.verify.action} — ${t.verify.finalCall} (${t.verify.score}/100)${t.verify.verdict ? `\n${t.verify.verdict}` : ''}${t.verify.fails?.length ? `\nFAILs: ${t.verify.fails.join(', ')}` : ''}`}>
              🛡 {t.verify.action} {t.verify.finalCall} {t.verify.score}
            </span>
          )}
          <button onClick={() => onClose(t)} disabled={busy}
            className="text-[10px] font-bold px-2.5 py-1 rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-600/60 text-slate-200 disabled:opacity-40">
            CLOSE @ LIVE
          </button>
        </div>
      </div>

      {banner === 'EXIT_NOW' && (
        <div className="text-[11px] text-red-300 bg-red-500/10 border border-red-500/30 rounded-lg px-2.5 py-1.5">
          🚨 <b>Ensemble ab opposite side vote kar raha hai</b> — thesis invalid. SL pe wait karne ki jagah ab exit judge karo.
          Telegram pe <b>kyon</b> (kaunse models flip hue) ka push already gaya hai.
        </div>
      )}
      {banner === 'LOSS_CAP' && (
        <div className="text-[11px] text-violet-300 bg-violet-500/10 border border-violet-500/30 rounded-lg px-2.5 py-1.5">
          🛑 <b>Reversal cycle ACTIVE</b> (leg {v?.reversal?.leg ?? 1}): minimal loss accept karke <b>CLOSE karo</b> → ulta <b>{v?.reversal?.flip?.side || (long ? 'SHORT' : 'LONG')}</b> entry → target pe profit <b>BOOK</b>.
          {v?.reversal?.flip && (
            <span className="block mt-1 font-mono text-[10px] text-violet-200/90">
              FLIP plan — qty {v.reversal.flip.qty} @ ~{pxFmt(v.reversal.flip.entry, usd)}{v.reversal.flip.sl != null ? ` · SL ${pxFmt(v.reversal.flip.sl, usd)} (₹${Math.round(v.reversal?.lossCapINR ?? 0)}) / TP ${pxFmt(v.reversal.flip.tp, usd)} (₹${Math.round(v.reversal?.profitTargetINR ?? 0)})` : ''}
            </span>
          )}
          <span className="block mt-0.5 text-violet-400/70 text-[10px]">(Manual trade — execute aap karo; Telegram pe full plan push ho chuka hai.)</span>
        </div>
      )}
      {banner === 'REVERSAL_BOOK' && (
        <div className="text-[11px] text-emerald-300 bg-emerald-500/10 border border-emerald-500/30 rounded-lg px-2.5 py-1.5">
          ✅ <b>Reversal cycle — ₹ TARGET hit</b> (leg {v?.reversal?.leg ?? 1}, +₹{Math.round(v?.reversal?.profitTargetINR ?? 0)}): profit <b>BOOK karo</b> — realized karo.
          Price wapas ult jaye to re-entry window me opp side confirm hone par next leg ka plan milega.
        </div>
      )}
      {banner === 'WEAKENING' && (
        <div className="text-[11px] text-amber-300/90 bg-amber-500/10 border border-amber-500/30 rounded-lg px-2.5 py-1.5">
          🟡 Conviction decay ho rahi hai — SL ko breakeven/T1 ki taraf tighten karna consider karo (noise se churn nahi, sirf protect).
        </div>
      )}
    </div>
  );
});

/** One closed manual trade row (compact history). */
const ClosedRow = memo(function ClosedRow({ t }: { t: ManualTradeView }) {
  const won = (t.exitPnlPct ?? 0) >= 0;
  const usd = t.market === 'FUTURES' || t.market === 'GLOBALFUTURES';
  return (
    <div className="flex items-center justify-between gap-2 text-[11px] py-1.5 border-b border-slate-800/60 last:border-0">
      <div className="flex items-center gap-2 min-w-0">
        <span className="font-bold text-slate-300 truncate">{t.symbol}</span>
        <span className={t.side === 'BUY' ? 'text-emerald-500' : 'text-red-500'}>{t.side === 'BUY' ? 'L' : 'S'}</span>
        {t.assetKind === 'OPTION' && <span className="text-[9px] text-violet-400">{t.optType} {t.strike}</span>}
      </div>
      <div className="flex items-center gap-3 text-slate-500 shrink-0">
        <span className="font-mono">{pxFmt(t.entryPrice, usd)} → {pxFmt(t.exitPrice, usd)}</span>
        <span className={`font-mono font-bold ${won ? 'text-emerald-400' : 'text-red-400'}`}>
          {t.exitPnlPct != null ? `${won ? '+' : ''}${t.exitPnlPct.toFixed(2)}%` : '—'}
          {t.exitPnlINR != null && !usd && ` · ${pnlFmt(t.exitPnlINR)}`}
        </span>
        {/* v12.0: the final R + peak + exit-quality verdict */}
        {t.exitR != null && (
          <span className={`font-mono font-bold text-[10px] ${t.exitR > 0 ? 'text-emerald-400' : 'text-red-400'}`} title={`Peak (MFE) ${t.exitPeakR != null ? t.exitPeakR.toFixed(2) + 'R' : '—'}`}>
            {t.exitR > 0 ? '+' : ''}{t.exitR.toFixed(2)}R{t.exitPeakR != null && t.exitPeakR > t.exitR ? ` (peak ${t.exitPeakR.toFixed(2)}R)` : ''}
          </span>
        )}
        {(() => {
          const q = EXIT_QUALITY_STYLE[t.__view?.exitQuality || t.exitQuality || 'UNKNOWN'] || EXIT_QUALITY_STYLE.UNKNOWN;
          if (!q.title) return null;
          return <span className={`text-[9px] font-black px-1.5 py-0.5 rounded border ${q.cls}`} title={q.title}>{q.label}</span>;
        })()}
        <span className="text-[9px] max-w-[90px] truncate">{t.closeReason}</span>
      </div>
    </div>
  );
});

// v20.7.12 [H2-1]: memo — tab ke ~1.25/s live-tick re-renders pe ye
// panel skip hota hai (props desk + notify dono stable hain).
export const ManualTradeMonitor = memo(function ManualTradeMonitor({ desk, notify }: Props) {
  const [trades, setTrades] = useState<ManualTradeView[] | null>(null);
  const [stats, setStats] = useState<ManualStatsView | null>(null);
  const [usdInr, setUsdInr] = useState(84);
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState(false);
  const [showClosed, setShowClosed] = useState(false);
  const activeRef = useRef(true);
  const tradesRef = useRef<ManualTradeView[] | null>(null);
  // v10.18 (deep-recheck #3): response sequence guard — the scheduled
  // timer's load() and the close() path's load() could interleave, and
  // the OLDER response landing last resurrected the just-closed row.
  const loadSeqRef = useRef(0);
  // v18.6.3 REALTIME NEVER STOPS: the LIVE OFF badge needs 3 CONSECUTIVE
  // failures — one slow poll (deep re-vote, board scan) used to flip the
  // badge red for 5s, recover, flip again… noise the user read as "feed
  // dead". 3-strike + instant recovery on the next success.
  const failStreakRef = useRef(0);

  const load = useCallback(async () => {
    const seq = ++loadSeqRef.current;
    try {
      // v18.6.3: 25s (was 20s) — outlasts the server's 12s deep re-vote
      // budget + LTP sweep with margin; a slow-but-succeeding poll no
      // longer aborts into LIVE OFF.
      const r = await apiFetch(`${getProxyBase()}/api/manual-trades`, { signal: AbortSignal.timeout(25000) })
        .then(x => x.json()).catch(() => null);
      if (seq !== loadSeqRef.current) return; // stale — a newer load already landed
      if (!r?.ok) { failStreakRef.current += 1; if (failStreakRef.current >= 3) setError(true); return; }
      failStreakRef.current = 0;
      setError(false);
      let list: ManualTradeView[] = r.trades || [];
      if (desk === 'INDIA') list = list.filter(t => t.market === 'INDIA');
      else if (desk === 'CRYPTO') list = list.filter(t => t.market !== 'INDIA');
      // v12.0: the tracker's own track-record (R win-rate · avg R · capture)
      if (r.stats) setStats(r.stats as ManualStatsView);
      // v12.9: the server's OWN fx for the realtime P&L recompute
      if (Number(r.usdInr) > 0) setUsdInr(Number(r.usdInr));
      // v10.18: sync the ref INSIDE load — the cadence scheduler reads it
      // right after `await load()`, but the separate `useEffect(() => {
      // tradesRef.current = trades })` only commits AFTER the next render,
      // so the FIRST refresh after mount always waited 30s even with open
      // trades (the "LIVE 5s" badge lied until the second poll).
      tradesRef.current = list;
      setTrades(list);
    } catch { if (seq === loadSeqRef.current) { failStreakRef.current += 1; if (failStreakRef.current >= 3) setError(true); } }
  }, [desk]);

  // 5s refresh while open trades exist (the plan's T1-tier cadence —
  // the monitor's LTP sweep is already running server-side; this just
  // repaints), 30s when idle.
  useEffect(() => {
    activeRef.current = true;
    load();
    let timer: ReturnType<typeof setTimeout> | null = null;
    const schedule = () => {
      const openCount = (tradesRef.current || []).filter(t => t.status === 'OPEN').length;
      timer = setTimeout(async () => {
        if (!activeRef.current) return;
        await load();
        schedule();
      }, openCount > 0 ? 5000 : 30000);
    };
    schedule();
    return () => { activeRef.current = false; if (timer) clearTimeout(timer); };
     
  }, [load]);

  useEffect(() => { tradesRef.current = trades; }, [trades]);

  // ---- v12.9 REALTIME PRICES: the tracker's own SSE subscription ----
  // The OPEN trades' symbols ride the SAME /api/stream the signal cards
  // use (~1s pushes; snapshot + tick + 30s-freshness). LTP + P&L repaint
  // instantly between the 5s reconciliation polls; banner/conviction
  // stay server-computed (the 5s poll refreshes them).
  const openTrades = (trades || []).filter(t => t.status === 'OPEN');
  const rtLists = useMemo(() => {
    const fut: string[] = [], glob: string[] = [], spot: string[] = [], india: string[] = [];
    for (const t of openTrades) {
      const sym = String(t.symbol || '').trim().toUpperCase();
      if (!sym) continue;
      // v18.6.4: OPTION trades ka SSE subscribe MAT karo — unka symbol
      // UNDERLYING hai (NIFTY), tick 24,600 aa jaati thi jabki trade
      // premium-domain hai; mergeLiveTicks bhi unhe skip karta hai.
      if (t.assetKind === 'OPTION') continue;
      if (t.market === 'FUTURES') fut.push(sym);
      else if (t.market === 'GLOBALFUTURES') glob.push(sym);
      else if (t.market === 'CRYPTO') spot.push(sym);
      else india.push(sym);
    }
    return { fut, glob, spot, india };
    // openTrades identity changes per poll — the symbol SETS are what
    // the subscription keys on; keep this memo on the joined strings.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openTrades.map(t => `${t.market}:${t.symbol}:${t.assetKind || ''}`).join('|')]);
  const { ticks, status: rtStatus } = useCxLivePrices(
    openTrades.length > 0,
    rtLists.spot, rtLists.fut, rtLists.glob, rtLists.india,
  );
  // the LIVE merge — pure helper (unit-tested); re-renders land at the
  // hook's 800ms batched cadence, never per tick
  const liveTrades = useMemo(
    () => mergeLiveTicks(trades || [], ticks as Record<string, { price: number; time: number }>, usdInr),
    [trades, ticks, usdInr],
  );
  const anyLive = openTrades.some(t => {
    if (t.assetKind === 'OPTION') return false; // premium domain — BS re-price, 5s poll
    const k = liveKeyFor(String(t.market || ''), String(t.symbol || ''));
    const tick = k ? (ticks as Record<string, { price: number; time: number }>)[k] : null;
    return !!tick && Date.now() - tick.time <= 30_000;
  });

  const close = useCallback(async (t: ManualTradeView) => {
    if (busy) return;
    setBusy(true);
    try {
      const r = await apiFetch(`${getProxyBase()}/api/manual-trade/${t.id}/close`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      }).then(x => x.json()).catch(() => ({ ok: false, error: 'network error' }));
      if (r.ok) notify?.(true, `✅ ${t.symbol} closed @ ${r.trade?.exitPrice ?? '—'} · P&L ${r.pnl?.pnlPct != null ? r.pnl.pnlPct.toFixed(2) : '—'}%`);
      else notify?.(false, `⛔ ${r.error || 'close failed'}`);
      await load();
    } finally { setBusy(false); }
  }, [busy, notify, load]);

  const open = (liveTrades || []).filter(t => t.status === 'OPEN');
  const closed = (trades || []).filter(t => t.status === 'CLOSED');
  const exitNow = open.filter(t => t.__view?.banner === 'EXIT_NOW' || t.__view?.banner === 'LOSS_CAP' || t.__view?.banner === 'REVERSAL_BOOK');
  const rest = open.filter(t => t.__view?.banner !== 'EXIT_NOW' && t.__view?.banner !== 'LOSS_CAP' && t.__view?.banner !== 'REVERSAL_BOOK');

  if (trades && open.length === 0 && closed.length === 0) {
    // No trades yet — the section stays collapsed to a single hint line
    // (the button on signal cards is the entry point).
    return (
      <div className="text-[11px] text-slate-600 border border-dashed border-slate-800/60 rounded-xl px-3 py-2.5">
        📝 Manual Trade Tracker — signal card pe <b className="text-slate-500">"✋ Maine ye trade liya hai"</b> button se apna REAL trade record karo; yahan live conviction tracking milegi.
      </div>
    );
  }

  return (
    <div className="quantum-panel rounded-2xl p-3.5 space-y-3">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div>
          <div className="text-xs font-black text-slate-100 flex items-center gap-1.5">
            ✋ MANUAL TRADE TRACKER
            {open.length > 0 && <span className="text-[10px] px-1.5 py-0.5 rounded bg-cyan-500/15 text-cyan-300 border border-cyan-500/30">{open.length} open</span>}
          </div>
          <div className="text-[10px] text-slate-500 mt-0.5">
            aapke REAL trades — <span className="text-cyan-400">REALTIME prices (SSE ~1s)</span> · P&L · SL/T distances · <span className="text-cyan-400">ensemble conviction re-vote (30s)</span> · <span className="text-violet-400">Reversal ₹-cycle engine-connected</span>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {closed.length > 0 && (
            <button onClick={() => setShowClosed(s => !s)}
              className="text-[10px] font-bold px-2 py-1 rounded-lg bg-slate-800/70 hover:bg-slate-700/70 border border-slate-700/50 text-slate-400">
              {showClosed ? 'hide' : 'show'} closed ({closed.length})
            </button>
          )}
          {/* v18.6.4: 4-STATE honesty chip (CoinDcxTab ke mirror me) —
              parked ≠ down: tab background me hona outage NAHI hai.
              error (3-strike) hi red hai. */}
          <span className={`text-[9px] px-1.5 py-0.5 rounded border flex items-center gap-1
            ${error ? 'text-red-400 border-red-500/30 bg-red-500/10'
              : rtStatus === 'parked' ? 'text-slate-400 border-slate-600/40 bg-slate-800/40'
                : rtStatus === 'down' ? 'text-amber-400 border-amber-500/30 bg-amber-500/10'
                  : anyLive && rtStatus === 'live' ? 'text-cyan-300 border-cyan-500/30 bg-cyan-500/10'
                    : 'text-emerald-400 border-emerald-500/30 bg-emerald-500/10'}`}>
            <span className={`w-1.5 h-1.5 rounded-full ${error ? 'bg-red-400' : rtStatus === 'parked' ? 'bg-slate-500' : rtStatus === 'down' ? 'bg-amber-400 animate-pulse' : anyLive && rtStatus === 'live' ? 'bg-cyan-400 animate-pulse' : 'bg-emerald-400 animate-pulse'}`} />
            {error ? 'LIVE OFF — retrying'
              : rtStatus === 'parked' ? 'feed paused (tab background)'
                : rtStatus === 'down' ? 'reconnecting (≤5s)'
                  : anyLive && rtStatus === 'live' ? 'REALTIME ⚡' : 'LIVE 5s'}
          </span>
        </div>
      </div>

      {error && <div className="text-[11px] text-red-400/80">tracker fetch fail — retry ho raha hai…</div>}

      {/* v12.0: the tracker's own track-record — R win-rate · avg R ·
          capture efficiency · exit-quality counts. Ye Numbers khud
          improve karne ka feedback loop hain (gave-back = trailing
          discipline). */}
      {stats && (stats.closedWithR ?? 0) > 0 && (
        <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-6 gap-1.5" title={stats.note}>
          <div className="bg-black/30 rounded-lg px-2 py-1.5 border border-slate-800">
            <div className="text-[8px] font-black tracking-widest text-slate-600">🏅 WIN-RATE (R)</div>
            <div className={`text-[12px] font-mono font-black ${(stats.winRate ?? 0) >= 50 ? 'text-emerald-300' : 'text-amber-300'}`}>{stats.winRate != null ? `${stats.winRate.toFixed(0)}%` : '—'}<span className="text-[9px] text-slate-600"> · {stats.wins}W/{stats.losses}L</span></div>
          </div>
          <div className="bg-black/30 rounded-lg px-2 py-1.5 border border-slate-800" title={`Best ${stats.bestR ?? '—'}R · worst ${stats.worstR ?? '—'}R`}>
            <div className="text-[8px] font-black tracking-widest text-slate-600">📊 AVG R</div>
            <div className={`text-[12px] font-mono font-black ${(stats.avgR ?? 0) > 0 ? 'text-emerald-300' : 'text-red-300'}`}>{stats.avgR != null ? `${stats.avgR > 0 ? '+' : ''}${stats.avgR.toFixed(2)}R` : '—'}</div>
          </div>
          <div className="bg-black/30 rounded-lg px-2 py-1.5 border border-slate-800" title="Winners ne apne peak excursion ka average kitna % rakha">
            <div className="text-[8px] font-black tracking-widest text-slate-600">🎯 CAPTURE</div>
            <div className={`text-[12px] font-mono font-black ${(stats.avgCapturePct ?? 0) >= 60 ? 'text-emerald-300' : (stats.avgCapturePct ?? 0) >= 30 ? 'text-amber-300' : 'text-red-300'}`}>{stats.avgCapturePct != null ? `${stats.avgCapturePct.toFixed(0)}%` : '—'}</div>
          </div>
          <div className="bg-black/30 rounded-lg px-2 py-1.5 border border-slate-800" title="Gave-back + cut-too-early count — trailing/breakeven discipline ka gap">
            <div className="text-[8px] font-black tracking-widest text-slate-600">↩ GAVE BACK</div>
            <div className={`text-[12px] font-mono font-black ${stats.gaveBack > 0 ? 'text-amber-300' : 'text-emerald-300'}`}>{stats.gaveBack}</div>
          </div>
          <div className="bg-black/30 rounded-lg px-2 py-1.5 border border-slate-800" title="Disciplined losses (≤1R) vs overshot (>1R)">
            <div className="text-[8px] font-black tracking-widest text-slate-600">🛡 LOSSES</div>
            <div className="text-[12px] font-mono font-black text-slate-300">{stats.disciplinedLosses}<span className="text-[9px] text-emerald-400"> ok</span> / {stats.overshootLosses}<span className="text-[9px] text-red-400"> over</span></div>
          </div>
          <div className="bg-black/30 rounded-lg px-2 py-1.5 border border-slate-800" title="Average hold time">
            <div className="text-[8px] font-black tracking-widest text-slate-600">⏱ AVG HOLD</div>
            <div className="text-[12px] font-mono font-black text-slate-300">{stats.avgHoldMin != null ? ageFmt(stats.avgHoldMin) : '—'}</div>
          </div>
        </div>
      )}

      {/* EXIT NOW rows pinned to the top — the highlighted exit line */}
      {exitNow.map(t => <ManualRow key={t.id} t={t} onClose={close} busy={busy} />)}
      {rest.map(t => <ManualRow key={t.id} t={t} onClose={close} busy={busy} />)}

      {showClosed && closed.length > 0 && (
        <div className="pt-1">
          <div className="text-[9px] uppercase tracking-wide font-bold text-slate-600 mb-1">Closed ({closed.length})</div>
          {closed.slice(0, 50).map(t => <ClosedRow key={t.id} t={t} />)}
        </div>
      )}

      {open.length === 0 && closed.length > 0 && (
        <div className="text-[11px] text-slate-600">koi open manual trade nahi — sab closed me hai ✅</div>
      )}
    </div>
  );
});
