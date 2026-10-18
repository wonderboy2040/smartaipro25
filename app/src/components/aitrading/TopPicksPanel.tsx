// ============================================================
// src/components/aitrading/TopPicksPanel.tsx — v6.9
// ------------------------------------------------------------
// The "full universe analyze karke TOP 5 accurate signals" panel.
// Server-side composite ranking (confidence 40% + agreement 20% +
// R:R 15% + participation 10% + regime alignment 10% + momentum 5%)
// → ranked medal rows with the trade plan, score and a Hinglish
// rank reason. 🚀 TRADE jumps straight to the full signal card
// (one source of truth for the ticket); 🔬 opens deep analysis.
// ============================================================
import { memo } from 'react';
import { LiveSourceBadge } from './LiveSourceBadge';
import { aiDirSummary } from './aiConfirmText';
import type { AISignal, TopPick } from './types';

const MEDALS = ['🥇', '🥈', '🥉', '4', '5'];

function pickPriceFmt(market: string): (n: number | null | undefined) => string {
  return (n) => {
    if (n == null || !Number.isFinite(n)) return '—';
    // v7.0.2: USDT (not $) — every other futures surface (ticket, console,
    // positions) labels perp prices USDT; a mixed $/USDT display misled
    // notional comparisons between the Top-5 row and the trade ticket.
    // v10.7: GLOBALFUTURES labels USDC — the CoinDCX app-parity domain.
    if (market === 'GLOBALFUTURES') return `USDC ${n >= 100 ? n.toFixed(1) : n.toFixed(4)}`;
    if (market === 'FUTURES') return `${n >= 100 ? n.toFixed(1) : n.toFixed(4)} USDT`;
    return `₹${n >= 100 ? n.toFixed(1) : n.toFixed(2)}`;
  };
}

interface Props {
  picks?: TopPick[];
  market: 'INDIA' | 'CRYPTO' | 'FUTURES' | 'GLOBALFUTURES'; // v10.4: global equity SIM desk
  deskLabel: string;
  scanned?: number;
  loading?: boolean;
  onDeep?: (s: AISignal) => void;
  /** v10.10: live direct-CoinDCX LTP lookup — when the 2s RT stream has a
   *  tick for a pick's symbol it replaces the board-snapshot price (with a
   *  ⚡ marker); null/undefined → snapshot behaviour, nothing breaks. */
  liveLtpFor?: (market: string, symbol: string) => number | null | undefined;
  /** v10.11 (#1): source label of the live tick (server `source` field) →
   *  the provenance pill next to the live price. */
  liveSrcFor?: (market: string, symbol: string) => string | null | undefined;
}

/** Smooth-scroll to the full signal card + flash ring so the user
 *  lands exactly on the ticket they saw in the ranking. */
function jumpToSignalCard(signal: AISignal) {
  try {
    const el = document.getElementById(`sig-${signal.market}-${signal.symbol}`);
    if (!el) return false;
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    el.classList.add('ring-2', 'ring-cyan-300', 'animate-pulse');
    setTimeout(() => el.classList.remove('ring-2', 'ring-cyan-300', 'animate-pulse'), 2600);
    return true;
  } catch { return false; }
}

export const TopPicksPanel = memo(function TopPicksPanel({ picks, market, deskLabel, scanned, loading, onDeep, liveLtpFor, liveSrcFor }: Props) {
  const price = pickPriceFmt(market);
  const list = picks || [];

  return (
    <div className="quantum-panel rounded-2xl p-4 bg-gradient-to-br from-cyan-500/[0.05] via-transparent to-amber-500/[0.04]">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="flex items-center gap-2">
          <span className="text-sm font-black tracking-wide gradient-text-cyan">🏆 TOP 5 PICKS</span>
          <span className="px-2 py-0.5 rounded-md bg-cyan-500/15 text-cyan-300 text-[9px] font-black border border-cyan-500/30">{deskLabel}</span>
        </div>
        <span className="text-[10px] text-slate-500 font-mono">
          {scanned != null ? `${scanned} assets scanned → ranked by conf·agree·R:R·regime` : 'composite rank · board refresh ke saath update'}
        </span>
      </div>

      {loading && list.length === 0 && (
        <div className="py-8 text-center">
          <div className="text-3xl mb-2 animate-float">🏆</div>
          <div className="text-xs text-slate-400">Full universe scan ho raha hai — top 5 rank ho rahe hain…</div>
        </div>
      )}

      {!loading && list.length === 0 && (
        <div className="py-8 text-center">
          <div className="text-3xl mb-2">😌</div>
          <div className="text-xs text-slate-400 font-bold">Abhi koi actionable pick nahi</div>
          <div className="text-[10px] text-slate-500 mt-1">Ensemble tabhi bolta hai jab models agree karein — 60s me dobara rank hoga.</div>
        </div>
      )}

      <div className="mt-3 space-y-2">
        {list.map((p) => {
          const long = p.side === 'LONG';
          const medal = MEDALS[p.rank - 1] || p.rank;
          const plan = p.plan;
          // v10.10: live overlay — direct-CoinDCX 2s LTP wins over the snapshot.
          const livePx = liveLtpFor?.(p.market || market, p.symbol);
          const showPx = livePx != null && livePx > 0 ? livePx : p.ltp;
          const isLive = livePx != null && livePx > 0;
          const liveSrc = isLive ? liveSrcFor?.(p.market || market, p.symbol) : null;
          return (
            <div key={`${p.market}-${p.symbol}-${p.rank}`}
              className={`rounded-xl p-3 bg-black/25 border-l-4 ${long ? 'border-l-emerald-500/70' : 'border-l-red-500/70'} ${p.rank <= 3 ? 'bg-gradient-to-r from-white/[0.04] to-transparent' : ''}`}>
              <div className="flex items-center gap-2.5 flex-wrap">
                {/* rank medal */}
                <span className={`w-8 h-8 shrink-0 rounded-xl flex items-center justify-center text-sm font-black
                  ${p.rank === 1 ? 'bg-amber-400/15 text-amber-300 ring-1 ring-amber-400/40' :
                    p.rank === 2 ? 'bg-slate-300/10 text-slate-200 ring-1 ring-slate-300/30' :
                    p.rank === 3 ? 'bg-orange-400/10 text-orange-300 ring-1 ring-orange-400/30' :
                    'bg-black/40 text-slate-400'} font-mono`}
                  title={`composite score ${p.score}/100`}>
                  {p.rank <= 3 ? medal : `#${p.rank}`}
                </span>
                {/* symbol + side */}
                <div className="min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-sm font-black text-white font-mono tracking-wide">{p.symbol}</span>
                    <span className={`text-[11px] font-black ${long ? 'text-emerald-400' : 'text-red-400'}`}>{long ? '▲ LONG' : '▼ SHORT'}</span>
                    {p.grade === 'STRONG'
                      ? <span className="px-1.5 py-0.5 rounded bg-emerald-500/15 text-emerald-300 text-[9px] font-black border border-emerald-500/30">★ STRONG</span>
                      : <span className="px-1.5 py-0.5 rounded bg-cyan-500/15 text-cyan-300 text-[9px] font-black border border-cyan-500/30">⚡ ACTION</span>}
                    {/* v21.3.0 (Issue-2/5): AI confirmation — TOP-5
                        headline picks ab AI-verified dikhte hain (conflict picks
                        server-side hi exclude ho jaate hain). */}
                    {p.aiConfirm?.verdict === 'CONFIRMED' && (
                      <span className="px-1.5 py-0.5 rounded bg-cyan-500/15 text-cyan-300 text-[9px] font-black border border-cyan-500/40"
                        title={`Jev (cloud) ne ye side APPROVE kiya — server ne +3 score diya${aiDirSummary(p.aiConfirm)}`}>🤖 AI ✓</span>
                    )}
                    {p.aiConfirm?.verdict === 'CONFLICT' && (
                      <span className="px-1.5 py-0.5 rounded bg-red-500/15 text-red-300 text-[9px] font-black border border-red-500/40"
                        title={`Provider (Jev) ulta side chuna — score −8 (CONFLICT)${aiDirSummary(p.aiConfirm)}`}>🤖 AI ✗</span>
                    )}
                    {/* v21.3.0 (Issue-2): funding-rate chip — perp picks ka real
                        carry cost (positive = longs pay, negative = shorts pay). */}
                    {(() => {
                      const f = p.superIntel?.perp?.fundingBps8h;
                      if (f == null || !Number.isFinite(Number(f))) return null;
                      const fv = Number(f);
                      return (
                        <span className={`px-1.5 py-0.5 rounded text-[9px] font-bold border font-mono ${fv > 3 ? 'bg-amber-500/15 text-amber-300 border-amber-500/40' : 'bg-slate-700/40 text-slate-300 border-slate-600/40'}`}
                          title={`Funding rate ${fv.toFixed(1)} bps / 8h — ${fv > 0 ? 'longs pay shorts' : 'shorts pay longs'}${Math.abs(fv) > 10 ? ' · EXTREME (crowded)' : ''}`}>
                          ∑ {fv >= 0 ? '+' : ''}{fv.toFixed(1)}bp
                        </span>
                      );
                    })()}
                    {(() => {
                      const vc = p.voters ?? p.participating;
                      if (vc == null || !p.totalModels) return null;
                      const capped = vc < 5;
                      return (
                        <span
                          className={`px-1.5 py-0.5 rounded text-[9px] font-bold border ${capped ? 'bg-amber-500/15 text-amber-300 border-amber-500/40' : 'bg-slate-700/40 text-slate-300 border-slate-600/40'}`}
                          title={capped ? 'Thin committee (<5 voters) — AI score bar raised by quorum penalty' : `${vc} models voted`}
                        >
                          {vc}/{p.totalModels} votes{capped ? ' ⚠️ capped' : ''}
                        </span>
                      );
                    })()}
                    {showPx != null && (
                      <span className="text-[11px] font-mono text-slate-300">{isLive && <span className="text-emerald-400" title="Direct CoinDCX RT — 2s direct poll / WS event push">⚡ </span>}{price(showPx)}
                        {p.changePct != null && (
                          <span className={`ml-1 ${p.changePct >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                            {p.changePct >= 0 ? '+' : ''}{p.changePct.toFixed(2)}%
                          </span>
                        )}
                        {isLive && <span className="ml-1"><LiveSourceBadge src={liveSrc} /></span>}
                      </span>
                    )}
                  </div>
                </div>
                {/* score + mini stats */}
                <div className="ml-auto flex items-center gap-1.5 flex-wrap">
                  <span className="px-2 py-1 rounded-lg bg-cyan-500/10 border border-cyan-500/25 text-cyan-300 text-[10px] font-black font-mono" title="Composite score (conf·agree·R:R·regime)">{p.score}<span className="text-slate-500">/100</span></span>
                  {p.superIntel?.winProb && (
                    <span className={`px-2 py-1 rounded-lg text-[10px] font-mono font-black border ${p.superIntel.winProb.verdict === 'EDGE' ? 'bg-emerald-500/15 text-emerald-300 border-emerald-500/40' : p.superIntel.winProb.verdict === 'FAIR' ? 'bg-amber-500/10 text-amber-300 border-amber-500/30' : 'bg-red-500/10 text-red-300 border-red-500/30'}`}
                      title={`Win-probability engine: P(win) ${p.superIntel.winProb.pWin}% vs breakeven ${p.superIntel.winProb.pNeed}% · EV ${p.superIntel.winProb.evRealisticR}R${p.superIntel.winProb.calibrated ? ' · ledger-calibrated' : ' · uncalibrated prior'}`}>
                      🎯 {p.superIntel.winProb.pWin}%<span className="text-slate-500"> win</span>
                    </span>
                  )}
                  <span className="px-2 py-1 rounded-lg bg-black/40 text-slate-300 text-[10px] font-mono font-bold" title="Model confidence">{Math.round(p.confidence)}% conf</span>
                  <span className="px-2 py-1 rounded-lg bg-black/40 text-slate-300 text-[10px] font-mono font-bold" title="Committee agreement">{Math.round((p.agreement || 0) * 100)}% agree</span>
                  {plan?.rewardRisk != null && <span className="px-2 py-1 rounded-lg bg-violet-500/10 border border-violet-500/25 text-violet-300 text-[10px] font-mono font-bold" title="Reward : Risk @ T2">R:R 1:{plan.rewardRisk.toFixed(1)}</span>}
                </div>
              </div>

              {/* plan strip */}
              {plan && (
                <div className="grid grid-cols-4 gap-1.5 mt-2.5 text-center">
                  <div className="bg-black/30 rounded-lg py-1.5">
                    <div className="text-[8px] font-black text-slate-500 tracking-wider">ENTRY</div>
                    <div className="text-[11px] font-mono font-black text-cyan-300">{price(plan.entry)}</div>
                  </div>
                  <div className="bg-black/30 rounded-lg py-1.5">
                    <div className="text-[8px] font-black text-slate-500 tracking-wider">STOP-LOSS</div>
                    <div className="text-[11px] font-mono font-black text-red-300">{price(plan.stopLoss)}</div>
                  </div>
                  <div className="bg-black/30 rounded-lg py-1.5">
                    <div className="text-[8px] font-black text-slate-500 tracking-wider">TARGET 1</div>
                    <div className="text-[11px] font-mono font-black text-amber-300">{price(plan.target1)}</div>
                  </div>
                  <div className="bg-black/30 rounded-lg py-1.5">
                    <div className="text-[8px] font-black text-slate-500 tracking-wider">TARGET 2</div>
                    <div className="text-[11px] font-mono font-black text-emerald-300">{price(plan.target2)}</div>
                  </div>
                </div>
              )}

              {/* rank reason (Hinglish) + actions */}
              <div className="flex items-start justify-between gap-2 mt-2 flex-wrap">
                <p className="text-[10px] leading-relaxed text-slate-400 max-w-xl">
                  <span className="text-cyan-400 font-black">KYUN: </span>{p.rankReason}
                </p>
                <div className="flex gap-1.5 shrink-0">
                  <button
                    onClick={() => { if (!jumpToSignalCard(p)) onDeep?.(p); }}
                    className="px-3 py-1.5 rounded-lg text-[10px] font-black bg-gradient-to-r from-cyan-600 to-cyan-500 text-white hover:from-cyan-500 hover:to-cyan-400 transition-all shadow-lg shadow-cyan-500/20"
                    title="Is signal ka full trade ticket kholo (board card par le jaata hai)">
                    🚀 TRADE
                  </button>
                  <button
                    onClick={() => onDeep?.(p)}
                    className="quantum-btn-ghost px-2.5 py-1.5 rounded-lg text-[10px] font-black"
                    title="Full-committee deep analysis modal kholo">
                    🔬
                  </button>
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {list.length > 0 && (
        <p className="text-[10px] text-slate-500 mt-3 leading-relaxed">
          <b className="text-slate-400">Rank kaise hota hai:</b> 40% confidence · 20% models agreement · 15% reward:risk · 10% participation · 10% regime alignment (NIFTY/BTC trend) · 5% momentum.
          {market === 'FUTURES' && ' Futures picks USDT perpetuals par hain — margin + leverage ticket me.'}
          {market === 'INDIA' && ' Intraday discipline: 09:30–14:30 entry · 15:15 square-off · STOP-loss hamesha.'}
          Risk cap ke andar hi plan — sirf actionable grade signals qualify (STOP-loss hamesha ticket me).
        </p>
      )}
    </div>
  );
});
