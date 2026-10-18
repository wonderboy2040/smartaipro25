// ============================================================
// src/components/aitrading/AgentPanel.tsx — SUPERINTELLIGENCE
// AUTO-AGENT console (v7.0 PRO TRADER)
// ------------------------------------------------------------
// The autonomous desk in ONE panel:
//   ┌ AGENT STATUS     running/idle/paused · mode · scans · uptime
//   ├ WALLET           live CoinDCX balance fetch — spot INR/USDT +
//   │                  futures margin + equity (kitna bacha hai)
//   ├ NEXT-TRADE SIZING what the agent WOULD invest on the next
//   │                  STRONG signal (₹X risk → Y qty → Z margin)
//   ├ 3-TRADE METER    daily quota slots · realized P&L · loss cap
//   ├ PRO STRATEGY     T1 40% + BE lock · T2 40% · runner 20% trail
//   ├ CONFIG           risk%/trade · min conf · leverage · hold ·
//   │                  cooldown · Partial TP / BE-lock toggles
//   ├ OPEN POSITIONS   exit-stage: ENTRY → T1 → T2 → RUNNER +
//   │                  booked P&L vs unrealized · time-exit bar
//   ├ TODAY'S TRADES   fill log with sizes + reasons
//   ├ TOP PICKS        India intraday + futures + equity-sim STRONG picks
//   └ LIVE LOG         every scan decision (entry/skip/exit/error)
//
// The agent runs SERVER-SIDE (60s loop). This panel polls /api/ai/agent
// every 30s — start/stop are real API calls, not local state.
// ============================================================
import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { fetchAgentStatus, startAgent, stopAgent, saveAgentConfig } from './useAITrading';
import { useWalletPoll } from './useWalletPoll';
import type { AgentView, AgentLogLine, AgentPick, AgentSizingPreview, WalletView } from './types';

const POLL_MS = 30_000;

const fmtINR = (n: number | null | undefined, dp = 0) => {
  if (n == null || !Number.isFinite(n)) return '—';
  if (Math.abs(n) >= 1e7) return `₹${(n / 1e7).toFixed(2)}Cr`;
  if (Math.abs(n) >= 1e5) return `₹${(n / 1e5).toFixed(2)}L`;
  return `₹${n.toLocaleString('en-IN', { maximumFractionDigits: dp })}`;
};
const fmtUSDT = (n: number | null | undefined, dp = 2) =>
  n == null || !Number.isFinite(n) ? '—' : `${n.toLocaleString('en-US', { maximumFractionDigits: dp })} USDT`;
const ago = (ts: number | null) => {
  if (!ts) return '—';
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  return `${Math.floor(s / 3600)}h ago`;
};

const LOG_STYLE: Record<string, string> = {
  entry: 'text-emerald-300',
  exit: 'text-orange-300',
  error: 'text-red-400',
  skip: 'text-slate-500',
  info: 'text-cyan-300',
};

// v7.0 PRO TRADER: exit-stage chip colors (ENTRY → T1 → T2 → RUNNER)
const STAGE_STYLE: Record<string, { label: string; cls: string }> = {
  ENTRY: { label: '🟢 ENTRY', cls: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/40' },
  T1_HIT: { label: '🟡 T1 HIT', cls: 'bg-amber-500/15 text-amber-300 border-amber-500/40' },
  T2_HIT: { label: '🟡 T1 HIT', cls: 'bg-amber-500/15 text-amber-300 border-amber-500/40' },
  RUNNER: { label: '⚡ RUNNER', cls: 'bg-orange-500/15 text-orange-300 border-orange-500/40' },
};

/** v7.0: the PRO TRADER strategy card — the complete exit plan at a glance. */
function ProStrategyCard({ cfg }: { cfg: AgentView['config'] }) {
  const t1 = Number(cfg?.tp1ClosePct ?? 40);
  const t2 = Number(cfg?.tp2ClosePct ?? 40);
  const runner = Number(cfg?.runnerPct ?? 20);
  return (
    <div className="bg-gradient-to-br from-emerald-500/[0.08] to-amber-500/[0.05] border border-emerald-500/20 rounded-xl p-3">
      <div className="text-[10px] font-black text-emerald-300 tracking-wider mb-2">🎯 PRO STRATEGY — ADVANCE TRADER EXIT PLAN</div>
      <div className="space-y-1 text-[10px] font-mono text-slate-300">
        <div className="flex items-center gap-2">
          <span className="text-cyan-300 font-black w-14 shrink-0">ENTRY</span>
          <span>wallet-based SL sizing — risk {cfg?.riskPerTradePct ?? 1.5}% of equity, capped at 60% deployable</span>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-amber-300 font-black w-14 shrink-0">T1 (1R)</span>
          <span>close {t1}% → SL {cfg?.breakEvenAfterTp1 ? '→ breakeven (risk-free runner)' : 'unchanged'}</span>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-orange-300 font-black w-14 shrink-0">T2 (2R)</span>
          <span>close {t2}% → SL → T1 (profit lock)</span>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-fuchsia-300 font-black w-14 shrink-0">RUNNER</span>
          <span>{runner}% trails — ATR ratchet + time-exit {cfg?.maxHoldMin ?? 90}m + native TP/SL backstop</span>
        </div>
      </div>
      {!cfg?.partialTpEnabled && (
        <div className="text-[9px] text-amber-400/90 mt-1.5 font-mono">⚠ Partial TP OFF — classic full-exit at TP2/SL apply hota hai</div>
      )}
    </div>
  );
}

/** v7.0: NEXT-TRADE SIZING — "agent will invest ₹X on the next STRONG signal". */
function SizingPreviewCard({ preview }: { preview: AgentSizingPreview | null | undefined }) {
  if (!preview) return null;
  const isFut = preview.desk === 'FUTURES';
  return (
    <div className="bg-black/25 rounded-xl p-3">
      <div className="flex items-center justify-between mb-2">
        <span className="text-[10px] font-black text-violet-300 tracking-wider">📐 NEXT TRADE SIZING {preview.symbol ? `· ${preview.symbol}` : ''}</span>
        {preview.desk && <span className={`px-1.5 py-0.5 rounded text-[9px] font-black ${isFut ? 'bg-violet-500/15 text-violet-300' : 'bg-cyan-500/15 text-cyan-300'}`}>{preview.desk}</span>}
      </div>
      <div className="grid grid-cols-2 gap-1.5 text-[10px] font-mono">
        <div className="bg-black/30 rounded-lg px-2 py-1.5">
          <div className="text-slate-500 text-[9px] font-bold">RISK / TRADE</div>
          <div className="text-red-300 font-black text-xs">₹{(preview.riskINR ?? 0).toLocaleString('en-IN', { maximumFractionDigits: 0 })}</div>
          <div className="text-slate-500 text-[9px]">{preview.riskPct}% of ₹{(preview.equityINR ?? 0).toLocaleString('en-IN', { maximumFractionDigits: 0 })} equity</div>
        </div>
        {isFut ? (
          <div className="bg-black/30 rounded-lg px-2 py-1.5">
            <div className="text-slate-500 text-[9px] font-bold">EST. MARGIN</div>
            <div className="text-cyan-300 font-black text-xs">{preview.marginUSDT?.toLocaleString('en-US', { maximumFractionDigits: 2 })} USDT</div>
            <div className="text-slate-500 text-[9px]">{preview.qty} qty @ {preview.entry} · {preview.leverage}x</div>
          </div>
        ) : (
          <div className="bg-black/30 rounded-lg px-2 py-1.5">
            <div className="text-slate-500 text-[9px] font-bold">EST. ORDER</div>
            <div className="text-cyan-300 font-black text-xs">₹{(preview.budgetINR ?? 0).toLocaleString('en-IN', { maximumFractionDigits: 0 })}</div>
            <div className="text-slate-500 text-[9px]">@ ₹{preview.entry ?? '—'} entry</div>
          </div>
        )}
      </div>
      <div className="text-[9px] text-slate-500 mt-1.5 font-mono">{preview.note}{preview.capped ? ' · deployable cap hit' : ''}</div>
    </div>
  );
}

function WalletCard({ wallet }: { wallet: WalletView | null }) {
  if (!wallet) {
    return (
      <div className="bg-black/25 rounded-xl p-3 text-[11px] text-slate-500">
        <div className="font-black text-slate-400 mb-1">📱 COINDCX WALLET</div>
        <div>Wallet fetch pending / API key not connected — agent paper mode equity ₹10,000 practice budget use karega.</div>
      </div>
    );
  }
  const fut = wallet.futures?.usdt as { free?: number; locked?: number; total?: number } | undefined;
  const futINR = wallet.futures?.inr as { free?: number; locked?: number; total?: number } | undefined;
  const spotINR = wallet.spot?.inr as { free?: number; locked?: number; total?: number } | undefined;
  const spotUSDT = wallet.spot?.usdt as { free?: number; locked?: number; total?: number } | undefined;
  const fx = Number(wallet.usdInr) > 40 ? Number(wallet.usdInr) : 84;
  const hasFutINR = (Number(futINR?.free) || 0) > 0 || (Number(futINR?.total) || 0) > 0;
  const hasFutUSDT = (Number(fut?.free) || 0) > 0 || (Number(fut?.total) || 0) > 0;
  const combinedFutUSDT = (Number(wallet.deployableFuturesUSDT) || 0) + ((Number(wallet.deployableFuturesINR) || 0) / fx);
  return (
    <div className="bg-black/25 rounded-xl p-3">
      <div className="flex items-center justify-between mb-2">
        <span className="text-[10px] font-black text-amber-300 tracking-wider">📱 COINDCX WALLET · LIVE</span>
        <span className="text-[9px] font-mono text-slate-500">{ago(wallet.fetchedAt)}</span>
      </div>
      <div className="grid grid-cols-2 gap-1.5 text-[10px] font-mono">
        <div className="bg-black/30 rounded-lg px-2 py-1.5">
          <div className="text-slate-500 text-[9px] font-bold">TOTAL EQUITY</div>
          <div className="text-emerald-300 font-black text-xs">{fmtINR(wallet.equityINR, 0)}</div>
        </div>
        <div className="bg-black/30 rounded-lg px-2 py-1.5">
          <div className="text-slate-500 text-[9px] font-bold">
            {hasFutINR && !hasFutUSDT ? 'FUTURES MARGIN (INR)' : 'FUTURES MARGIN (USDT / INR)'}
          </div>
          <div className="text-cyan-300 font-black text-xs">
            {hasFutINR && !hasFutUSDT
              ? `${fmtINR(futINR?.free)} (≈ ${fmtUSDT((futINR?.free ?? 0) / fx)})`
              : hasFutINR && hasFutUSDT
                ? `${fmtUSDT(fut?.free)} + ${fmtINR(futINR?.free)}`
                : fmtUSDT(fut?.free)}
          </div>
          <div className="text-slate-500 text-[9px]">
            {hasFutINR && !hasFutUSDT
              ? `locked ${fmtINR(futINR?.locked)} · total ${fmtINR(futINR?.total)}`
              : `locked ${fmtUSDT(fut?.locked)} · ≈ ${fmtINR(((fut?.total ?? 0) * fx) + (futINR?.total ?? 0))}`}
          </div>
        </div>
        <div className="bg-black/30 rounded-lg px-2 py-1.5">
          <div className="text-slate-500 text-[9px] font-bold">SPOT INR</div>
          <div className="text-slate-200 font-black">{fmtINR(spotINR?.free)}</div>
          <div className="text-slate-500 text-[9px]">locked {fmtINR(spotINR?.locked)}</div>
        </div>
        <div className="bg-black/30 rounded-lg px-2 py-1.5">
          <div className="text-slate-500 text-[9px] font-bold">SPOT USDT</div>
          <div className="text-slate-200 font-black">{fmtUSDT(spotUSDT?.free)}</div>
          <div className="text-slate-500 text-[9px]">USD/₹ {wallet.usdInr ?? '—'}</div>
        </div>
      </div>
      {(wallet.spot?.error || wallet.futures?.error) && (
        <div className="text-[9px] text-amber-500/80 mt-1.5 font-mono">
          ⚠ {wallet.spot?.error || wallet.futures?.error}
        </div>
      )}
      <div className="text-[9px] text-slate-500 mt-1.5">
        Agent in futures trades sirf {hasFutINR ? `${fmtINR(wallet.deployableFuturesINR ?? futINR?.free ?? 0)} (≈ ${fmtUSDT(combinedFutUSDT)})` : fmtUSDT(wallet.deployableFuturesUSDT)} free margin ka safe hissa use karta hai — liquidation &amp; fee buffer hamesha bacha rehta hai.
      </div>
    </div>
  );
}

function TradeSlots({ used, total, pnlINR, lossCapINR }: { used: number; total: number; pnlINR: number; lossCapINR: number }) {
  return (
    <div className="bg-black/25 rounded-xl p-3">
      <div className="flex items-center justify-between mb-2">
        <span className="text-[10px] font-black text-cyan-300 tracking-wider">⚡ DAILY TRADE QUOTA</span>
        <span className={`font-mono text-[10px] font-black ${pnlINR > 0 ? 'text-emerald-400' : pnlINR < 0 ? 'text-red-400' : 'text-slate-400'}`}>
          today {pnlINR > 0 ? '+' : ''}{fmtINR(pnlINR)}
        </span>
      </div>
      <div className="flex gap-1.5 mb-1.5">
        {Array.from({ length: Math.min(total, 10) }).map((_, i) => (
          <div key={i} className={`flex-1 h-6 rounded-md flex items-center justify-center text-[10px] font-black font-mono border ${i < used
            ? 'bg-cyan-500/20 text-cyan-300 border-cyan-500/40'
            : 'bg-black/30 text-slate-500 border-slate-700/40'}`}>
            {i < used ? '✓' : i + 1}
          </div>
        ))}
      </div>
      <div className="flex justify-between text-[9px] font-mono text-slate-500">
        <span>{used}/{total} trades used · resets IST midnight</span>
        <span>loss cap −{fmtINR(lossCapINR)}</span>
      </div>
    </div>
  );
}

type CfgKey = 'maxTradesPerDay' | 'minAiScore' | 'minConfidence' | 'riskPerTradePct' | 'maxLeverage' | 'maxHoldMin' | 'cooldownMin' | 'dailyLossCapPct' | 'quorumPenalty' | 'nearMissScoreGap' | 'nearMissMinConfidence' | 'nearMissMaxPerDay';
const CFG_FIELDS: { key: CfgKey; label: string; min: number; max: number; step: number; suffix: string; hint: string }[] = [
  { key: 'maxTradesPerDay', label: 'Trades/day', min: 1, max: 10, step: 1, suffix: '', hint: 'user spec: 3' },
  { key: 'minAiScore', label: 'Min AI score', min: 55, max: 95, step: 1, suffix: '', hint: '75+ = auto entry (user spec)' },
  { key: 'minConfidence', label: 'Min confidence', min: 55, max: 95, step: 1, suffix: '%', hint: 'legacy STRONG bar' },
  { key: 'quorumPenalty', label: 'Quorum Penalty', min: 0, max: 15, step: 1, suffix: '', hint: 'thin committee (<5 voters) AI score bump' },
  { key: 'riskPerTradePct', label: 'Risk/trade', min: 0.25, max: 10, step: 0.25, suffix: '%', hint: '% of wallet equity' },
  { key: 'maxLeverage', label: 'Max leverage', min: 1, max: 10, step: 1, suffix: 'x', hint: 'futures ceiling' },
  { key: 'maxHoldMin', label: 'Max hold', min: 5, max: 480, step: 5, suffix: 'm', hint: 'time-exit (winner extension adds)' },
  { key: 'cooldownMin', label: 'Cooldown', min: 1, max: 240, step: 1, suffix: 'm', hint: 'between entries' },
  { key: 'dailyLossCapPct', label: 'Day loss cap', min: 0.5, max: 50, step: 0.5, suffix: '%', hint: 'stand-down' },
  // v10.8 NEAR-MISS AUTO-TRADE knobs (user spec)
  { key: 'nearMissScoreGap', label: 'Near-miss gap', min: 0, max: 20, step: 1, suffix: 'pt', hint: 'AI score within this far BELOW the bar still qualifies for near-miss auto-entry' },
  { key: 'nearMissMinConfidence', label: 'NM min conf', min: 55, max: 95, step: 1, suffix: '%', hint: 'high-confidence floor for near-miss entries' },
  { key: 'nearMissMaxPerDay', label: 'NM per day', min: 0, max: 5, step: 1, suffix: '', hint: 'max near-miss auto-entries per day (quality guard)' },
];

function AgentConfigEditor({ cfg, onSaved }: { cfg: AgentView['config']; onSaved: (ok: boolean, msg: string) => void }) {
  const [draft, setDraft] = useState<Partial<Record<CfgKey, number>>>({});
  const [toggles, setToggles] = useState<Partial<Record<'partialTpEnabled' | 'breakEvenAfterTp1' | 'manageManualPositions' | 'nearMissAutoTrade' | 'winnerExtendEnabled', boolean>>>({});
  const [saving, setSaving] = useState(false);
  const dirty = Object.keys(draft).length > 0 || Object.keys(toggles).length > 0;
  const save = async () => {
    setSaving(true);
    const r = await saveAgentConfig({ ...draft, ...toggles });
    setSaving(false);
    if (r.ok) { setDraft({}); setToggles({}); onSaved(true, '✅ Agent config saved — next scan se live'); }
    else onSaved(false, `⛔ ${r.error}`);
  };
  // v7.0 effective toggle states (draft overrides server config)
  const partialOn = toggles.partialTpEnabled != null ? toggles.partialTpEnabled : !!cfg.partialTpEnabled;
  const beLockOn = toggles.breakEvenAfterTp1 != null ? toggles.breakEvenAfterTp1 : !!cfg.breakEvenAfterTp1;
  // v9.7: trend-flip exit on manual positions (default ON — user spec)
  const manualOn = toggles.manageManualPositions != null ? toggles.manageManualPositions : cfg.manageManualPositions !== false;
  // v10.8: near-miss auto-trade + winner extension (default ON — user spec)
  const nearMissOn = toggles.nearMissAutoTrade != null ? toggles.nearMissAutoTrade : cfg.nearMissAutoTrade !== false;
  const winnerExtOn = toggles.winnerExtendEnabled != null ? toggles.winnerExtendEnabled : cfg.winnerExtendEnabled !== false;
  return (
    <div className="bg-black/25 rounded-xl p-3">
      <div className="text-[10px] font-black text-violet-300 tracking-wider mb-2">⚙ AGENT RULES (server-side enforced)</div>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-1.5">
        {CFG_FIELDS.map(f => {
          const value = draft[f.key] != null ? draft[f.key] : Number(cfg[f.key]);
          return (
            <label key={f.key} className="bg-black/30 rounded-lg px-2 py-1.5 block" title={f.hint}>
              <div className="flex justify-between items-baseline">
                <span className="text-[9px] font-bold text-slate-500">{f.label}</span>
                <span className="text-[10px] font-mono font-black text-slate-200">{value}{f.suffix}</span>
              </div>
              <input type="range" min={f.min} max={f.max} step={f.step} value={value}
                onChange={e => setDraft(d => ({ ...d, [f.key]: Number(e.target.value) }))}
                className="w-full h-1 mt-1 accent-cyan-500 cursor-pointer" aria-label={f.label} />
            </label>
          );
        })}
      </div>

      {/* v9.7 PRO TRADER toggles + v10.8 near-miss/winner-extension */}
      <div className="grid grid-cols-2 sm:grid-cols-5 gap-1.5 mt-2">
        <button
          onClick={() => setToggles(t => ({ ...t, partialTpEnabled: !partialOn }))}
          className={`px-2 py-1.5 rounded-lg text-[10px] font-black border transition-colors ${partialOn
            ? 'bg-emerald-500/15 text-emerald-300 border-emerald-500/40'
            : 'bg-black/30 text-slate-500 border-slate-700/40'}`}
          title="3-tier exit: T1 partial close + T2 partial close + trailing runner">
          📊 PARTIAL TP: {partialOn ? 'ON' : 'OFF'}
        </button>
        <button
          onClick={() => setToggles(t => ({ ...t, breakEvenAfterTp1: !beLockOn }))}
          disabled={!partialOn}
          className={`px-2 py-1.5 rounded-lg text-[10px] font-black border transition-colors disabled:opacity-40 ${beLockOn && partialOn
            ? 'bg-amber-500/15 text-amber-300 border-amber-500/40'
            : 'bg-black/30 text-slate-500 border-slate-700/40'}`}
          title="T1 hit hone ke baad SL entry price par lock — runner risk-free">
          🔒 BE LOCK: {beLockOn ? 'ON' : 'OFF'}
        </button>
        <button
          onClick={() => setToggles(t => ({ ...t, manageManualPositions: !manualOn }))}
          className={`px-2 py-1.5 rounded-lg text-[10px] font-black border transition-colors ${manualOn
            ? 'bg-sky-500/15 text-sky-300 border-sky-500/40'
            : 'bg-black/30 text-slate-500 border-slate-700/40'}`}
          title="TREND-FLIP exit manual positions par bhi lagega — board aapke held pair pe QUALIFYING opposite-side signal de to position turant cut (time-exit/partial-TP sirf agent ke apne trades par rehte hain)">
          🛡 TREND-EXIT MANUAL: {manualOn ? 'ON' : 'OFF'}
        </button>
        <button
          onClick={() => setToggles(t => ({ ...t, nearMissAutoTrade: !nearMissOn }))}
          className={`px-2 py-1.5 rounded-lg text-[10px] font-black border transition-colors ${nearMissOn
            ? 'bg-fuchsia-500/15 text-fuchsia-300 border-fuchsia-500/40'
            : 'bg-black/30 text-slate-500 border-slate-700/40'}`}
          title="NEAR-MISS AUTO-TRADE — jab full bar koi clear na kare, sabse highest AI-score + high-confidence near-miss auto-entry lagta hai (per-day capped, journal-tagged)">
          🎯 NEAR-MISS AUTO: {nearMissOn ? 'ON' : 'OFF'}
        </button>
        <button
          onClick={() => setToggles(t => ({ ...t, winnerExtendEnabled: !winnerExtOn }))}
          className={`px-2 py-1.5 rounded-lg text-[10px] font-black border transition-colors ${winnerExtOn
            ? 'bg-violet-500/15 text-violet-300 border-violet-500/40'
            : 'bg-black/30 text-slate-500 border-slate-700/40'}`}
          title="WINNER EXTENSION — time-exit par profitable position (opposite signal na ho) ki window extend hoti hai + SL breakeven lock — winners ko bhaagne ka room milta hai">
          ♾ WIN-EXTEND: {winnerExtOn ? 'ON' : 'OFF'}
        </button>
      </div>
      {/* v7.0: the T1/T2/runner split at a glance */}
      <div className="flex items-center gap-1.5 mt-1.5" title="T1/T2/runner exit split (T1+T2 sliders ke through adjust hota hai)">
        <span className="text-[9px] font-black text-slate-500 shrink-0">SPLIT</span>
        <div className="flex-1 h-3 rounded-md overflow-hidden flex border border-black/40">
          <div className="bg-amber-500/50 flex items-center justify-center text-[8px] font-black text-amber-100" style={{ width: `${Number(cfg.tp1ClosePct ?? 40)}%` }}>T1 {cfg.tp1ClosePct ?? 40}%</div>
          <div className="bg-orange-500/50 flex items-center justify-center text-[8px] font-black text-orange-100" style={{ width: `${Number(cfg.tp2ClosePct ?? 40)}%` }}>T2 {cfg.tp2ClosePct ?? 40}%</div>
          <div className="bg-fuchsia-500/50 flex items-center justify-center text-[8px] font-black text-fuchsia-100" style={{ width: `${Number(cfg.runnerPct ?? 20)}%` }}>R {cfg.runnerPct ?? 20}%</div>
        </div>
      </div>

      <div className="flex items-center gap-2 mt-2">
        <button onClick={save} disabled={!dirty || saving}
          className={`px-3 py-1.5 rounded-lg text-[10px] font-black transition-colors ${dirty && !saving ? 'bg-cyan-500/20 text-cyan-300 border border-cyan-500/40 hover:bg-cyan-500/30' : 'bg-black/30 text-slate-500 border border-slate-700/40'}`}>
          {saving ? 'saving…' : dirty ? 'SAVE RULES' : 'saved'}
        </button>
        {dirty && <span className="text-[9px] text-amber-400/80 font-mono">unsaved changes</span>}
        <span className="ml-auto text-[9px] font-mono text-slate-500">
          auto bar: AI score ≥ {Number(cfg.minAiScore ?? 75)} YA STRONG {Number(cfg.minConfidence)}% + {Math.round(Number(cfg.minAgreement) * 100)}% agreement
          {cfg.nearMissAutoTrade !== false ? ` · near-miss gap ${Number(cfg.nearMissScoreGap ?? 10)}pt conf≥${Number(cfg.nearMissMinConfidence ?? 70)}%` : ''}
        </span>
      </div>
    </div>
  );
}

function ConvictionBar({ c }: { c?: { state: string; delta: number | null; currentScore: number | null; entryScore: number | null; side?: string | null } | null }) {
  // v10.15 GAP 1: the live conviction bar — the ensemble's re-vote on
  // this position. green STRENGTHENING → amber WEAKENING → red FLIPPED.
  if (!c || !c.state || c.state === 'UNKNOWN') return null;
  const st = String(c.state);
  const cls = st === 'STRENGTHENING' ? 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30'
    : st === 'WEAKENING' ? 'bg-amber-500/15 text-amber-300 border-amber-500/40'
    : st === 'FLIPPED' ? 'bg-red-500/15 text-red-300 border-red-500/40'
    : 'bg-slate-600/20 text-slate-400 border-slate-500/30';
  const icon = st === 'STRENGTHENING' ? '▲' : st === 'WEAKENING' ? '▼' : st === 'FLIPPED' ? '⯅' : '•';
  const title = `Live conviction — the 14-model ensemble's re-vote on this position\nentry score ${c.entryScore ?? '?'} → now ${c.currentScore ?? '?'} (${c.side ?? '?'}) · delta ${c.delta != null ? (c.delta > 0 ? '+' : '') + c.delta : '?'}${st === 'FLIPPED' ? '\nFLIPPED: thesis invalidated — conviction-flip exit fires' : st === 'WEAKENING' ? '\nWEAKENING: in-profit positions get SL → breakeven' : st === 'STRENGTHENING' ? '\nSTRENGTHENING: earns winner-extension room' : ''}`;
  return (
    <span className={`px-1.5 py-0.5 rounded border text-[9px] font-black ${cls}`} title={title}>
      CONVICTION {icon} {st}{c.delta != null ? ` ${c.delta > 0 ? '+' : ''}${c.delta}` : ''}
    </span>
  );
}

function OpenPositions({ positions, cfg }: { positions: AgentView['openPositions']; cfg?: AgentView['config'] }) {
  if (positions.length === 0) {
    return <div className="bg-black/25 rounded-xl p-3 text-[11px] text-slate-500">No open agent positions — agent scans every 30s, entry sirf top-conviction signal par.</div>;
  }
  return (
    <div className="bg-black/25 rounded-xl p-3 space-y-1.5">
      <div className="text-[10px] font-black text-orange-300 tracking-wider mb-1">🤖 OPEN AGENT POSITIONS — PRO 3-TIER EXIT ARMED</div>
      {positions.map(p => {
        const holdPct = p.ageMin != null ? Math.min(100, (p.ageMin / Math.max(1, p.maxHoldMin)) * 100) : 0;
        const stage = STAGE_STYLE[p.exitStage || 'ENTRY'] || STAGE_STYLE.ENTRY;
        const splitActive = cfg?.partialTpEnabled !== false;
        const origQty = p.originalQty ?? p.qty;
        const remainingPct = origQty > 0 ? Math.round((p.qty / origQty) * 100) : 100;
        return (
          <div key={p.id} className="bg-black/30 rounded-lg px-2.5 py-2">
            <div className="flex items-center gap-2 flex-wrap text-[10px] font-mono font-bold">
              <span className={p.side === 'LONG' ? 'text-emerald-400' : 'text-red-400'}>{p.side}</span>
              <span className="text-slate-200">{p.pair}</span>
              <span className="text-slate-400">{p.mode.toUpperCase()}</span>
              {p.leverage != null && <span className="text-amber-300">{p.leverage}x</span>}
              <span className="text-slate-300">{p.qty} @ {p.entryPrice}</span>
              <span className="text-slate-500">SL {p.sl ?? '—'} · T1 {p.tp ?? '—'} · T2 {p.tp2 ?? '—'}</span>
              {p.marginUSDT != null && <span className="text-cyan-300">margin {p.marginUSDT} USDT</span>}
              <span className="ml-auto text-slate-400">{p.ageMin ?? '?'}m old</span>
            </div>
            {/* v7.0: exit-stage pipeline — ENTRY → T1 HIT → T2 HIT/RUNNER */}
            {splitActive && (
              <div className="mt-1.5 flex items-center gap-1.5 flex-wrap">
                <span className={`px-1.5 py-0.5 rounded border text-[9px] font-black ${stage.cls}`}>
                  {stage.label}{(p.exitStage === 'T1_HIT' || p.exitStage === 'T2_HIT') ? ' (40% booked, SL→BE)' : p.exitStage === 'RUNNER' ? ' (80% booked, trailing)' : ''}
                </span>
                <ConvictionBar c={p.conviction} />
                <div className="flex items-center gap-1" title="qty remaining vs original">
                  <div className="w-16 h-1.5 rounded-full bg-black/40 overflow-hidden">
                    <div className="h-full rounded-full bg-amber-400/70" style={{ width: `${remainingPct}%` }} />
                  </div>
                  <span className="text-[9px] text-slate-500 font-mono">{remainingPct}% left</span>
                </div>
                {p.bookedPnlINR != null && (
                  <span className={`text-[10px] font-black font-mono ${(p.bookedPnlINR || 0) >= 0 ? 'text-emerald-400' : 'text-red-400'}`} title="realized via partial T1/T2 legs">
                    booked {p.bookedPnlINR >= 0 ? '+' : ''}₹{Math.abs(p.bookedPnlINR).toLocaleString('en-IN', { maximumFractionDigits: 0 })}
                  </span>
                )}
              </div>
            )}
            <div className="mt-1.5 flex items-center gap-2">
              <div className="flex-1 h-1 rounded-full bg-black/40 overflow-hidden" role="img" aria-label="time to auto exit">
                <div className={`h-full rounded-full ${holdPct > 80 ? 'bg-red-500/70' : 'bg-orange-400/60'}`} style={{ width: `${holdPct}%` }} />
              </div>
              <span className="text-[9px] font-mono text-slate-500">time-exit {p.maxHoldMin}m</span>
            </div>
            {!splitActive && <div className="mt-1.5"><ConvictionBar c={p.conviction} /></div>}
          </div>
        );
      })}
    </div>
  );
}

function TodayTrades({ trades }: { trades: AgentView['today']['trades'] }) {
  if (trades.length === 0) {
    return <div className="bg-black/25 rounded-xl p-3 text-[11px] text-slate-500">Aaj koi agent trade abhi nahi — STRONG setup ka intezaar.</div>;
  }
  return (
    <div className="bg-black/25 rounded-xl p-3 space-y-1.5">
      <div className="text-[10px] font-black text-emerald-300 tracking-wider mb-1">📋 TODAY'S AGENT TRADES</div>
      {trades.slice().reverse().map((t, i) => (
        <div key={`${t.ts}-${i}`} className="bg-black/30 rounded-lg px-2.5 py-1.5 flex items-center gap-2 flex-wrap text-[10px] font-mono">
          <span className="text-slate-500">{new Date(t.ts).toLocaleTimeString('en-IN', { hour12: false })}</span>
          <span className={t.side === 'LONG' ? 'text-emerald-400' : 'text-red-400'}>{t.side}</span>
          <span className="text-slate-200">{t.pair}</span>
          <span className="text-slate-500">{t.mode.toUpperCase()}</span>
          {t.leverage != null && <span className="text-amber-300">{t.leverage}x</span>}
          {t.qty != null && <span className="text-slate-300">{t.qty} @ {t.price}</span>}
          {t.marginUSDT != null && <span className="text-cyan-300">m {t.marginUSDT} USDT</span>}
          <span className={`ml-auto px-1.5 py-0.5 rounded text-[9px] font-black ${t.status === 'FILLED' || t.status === 'SUBMITTED' ? 'bg-emerald-500/15 text-emerald-300' : t.status === 'REJECTED' ? 'bg-red-500/15 text-red-300' : 'bg-slate-600/20 text-slate-400'}`}>{t.status}</span>
          {t.reason && <div className="w-full text-[9px] text-slate-500 truncate" title={t.reason}>{t.reason}</div>}
        </div>
      ))}
    </div>
  );
}

function PickStrip({ title, picks, accent }: { title: string; picks: AgentPick[] | undefined | null; accent: string }) {
  if (!picks || picks.length === 0) return null;
  return (
    <div className="bg-black/25 rounded-xl p-3">
      <div className={`text-[10px] font-black ${accent} tracking-wider mb-2`}>{title}</div>
      {/* v6.10: roomier pick cards — 2-per-row on sm+ (was 3, too
          cramped), E/SL/T2 plan chips with labels + color coding,
          grade pill instead of floating text, conf as a mini bar. */}
      <div className="grid gap-2 sm:grid-cols-2">
        {picks.map((pick) => (
          <div key={pick.symbol} className="bg-black/30 rounded-lg px-2.5 py-2 space-y-1.5">
            <div className="flex items-center gap-2">
              <span className={`px-1.5 py-0.5 rounded text-[9px] font-black ${pick.side === 'LONG' ? 'bg-emerald-500/15 text-emerald-300' : 'bg-red-500/15 text-red-300'}`}>{pick.side}</span>
              <span className="text-[11px] text-slate-100 font-black font-mono">{pick.symbol}</span>
              {pick.aiScore != null && (
                <span className="text-[9px] font-black text-violet-300/90 bg-violet-500/10 border border-violet-500/25 rounded px-1.5 py-0.5" title="superintelligence AI score — 75+ par agent auto-entry karta hai">🧠 {pick.aiScore}</span>
              )}
              {pick.voters != null && (
                <span
                  className={`text-[9px] font-bold px-1.5 py-0.5 rounded border ${pick.voters < 5 ? 'bg-amber-500/15 text-amber-300 border-amber-500/40' : 'bg-slate-700/40 text-slate-300 border-slate-600/40'}`}
                  title={pick.voters < 5 ? 'Thin committee (<5 voters) — quorum penalty applied' : `${pick.voters} models voted`}
                >
                  {pick.voters}v{pick.voters < 5 ? ' ⚠️' : ''}
                </span>
              )}
              <span className="text-[9px] font-black text-amber-300/90 bg-amber-500/10 border border-amber-500/25 rounded px-1.5 py-0.5">{pick.grade}</span>
            </div>
            <div className="flex items-center gap-1.5" title="model confidence">
              <div className="flex-1 h-1 rounded-full bg-black/40 overflow-hidden">
                <div className="h-full rounded-full bg-cyan-500/60" style={{ width: `${Math.min(100, Math.max(0, pick.confidence ?? 0))}%` }} />
              </div>
              <span className="text-[9px] text-slate-400 font-mono font-bold shrink-0">{pick.confidence}%</span>
            </div>
            {pick.plan && (
              <div className="flex items-center gap-1 flex-wrap text-[9px] font-mono">
                <span className="px-1.5 py-0.5 rounded bg-black/40 text-slate-400" title="entry">E {pick.plan.entry}</span>
                <span className="px-1.5 py-0.5 rounded bg-red-500/10 text-red-300/90" title="stop loss">SL {pick.plan.stopLoss}</span>
                <span className="px-1.5 py-0.5 rounded bg-emerald-500/10 text-emerald-300/90" title="target 2">T2 {pick.plan.target2}</span>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function LogFeed({ log }: { log: AgentLogLine[] }) {
  return (
    <div className="bg-black/25 rounded-xl p-3">
      <div className="text-[10px] font-black text-slate-400 tracking-wider mb-1.5">🛰 AGENT LOG (live — every 30s scan)</div>
      <div className="max-h-44 overflow-y-auto space-y-0.5 font-mono text-[10px]">
        {log.length === 0 && <div className="text-slate-500">no log lines yet — agent start karo</div>}
        {log.map((l, i) => (
          <div key={`${l.ts}-${i}`} className="flex gap-2">
            <span className="text-slate-500 shrink-0">{new Date(l.ts).toLocaleTimeString('en-IN', { hour12: false })}</span>
            <span className={LOG_STYLE[l.level] || 'text-slate-300'}>{l.text}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

export const AgentPanel = memo(function AgentPanel({ notify }: { notify: (ok: boolean, text: string) => void }) {
  const [view, setView] = useState<AgentView | null>(null);
  // v20.3: the shared wallet store — this panel escaped the v20.2 dedup
  // (a 4th independent 60s signed /api/ai/wallet call; now it rides the
  // SAME single poller + snapshot as WalletCard/WalletStrip/PortfolioHeat).
  const { wallet } = useWalletPoll();
  const [busy, setBusy] = useState(false);
  const [livePhrase, setLivePhrase] = useState('');
  const [showLive, setShowLive] = useState(false);
  // v7.0.2: honest failure state — a persistently failing status API used
  // to show the loading spinner FOREVER (silent 5xx / proxy failure).
  const [viewFailed, setViewFailed] = useState(false);
  // v9.2.1: a poll failed but an older view is on screen — flag it as
  // stale instead of pretending the panel is dead.
  const [stalePoll, setStalePoll] = useState(false);
  const viewRef = useRef(view);
  viewRef.current = view;

  const load = useCallback(async () => {
    const v = await fetchAgentStatus();
    if (v) { setView(v); setViewFailed(false); setStalePoll(false); }
    else if (!viewRef.current) setViewFailed(true);
    else setStalePoll(true);
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(() => { if (!document.hidden) load(); }, POLL_MS);
    return () => { clearInterval(t); };
  }, [load]);

  const cfg = view?.config;
  const running = !!view?.state?.running;
  const paused = view?.today?.paused || view?.state?.pausedToday;
  const liveArmed = view?.trading?.mode === 'live' && view?.trading?.allowAuto && view?.trading?.connected;

  const onStart = useCallback(async (mode: 'paper' | 'live' | 'notify') => {
    setBusy(true);
    const r = await startAgent(mode, mode === 'live' ? livePhrase : undefined);
    setBusy(false);
    if (r.ok) {
      notify(true, mode === 'live'
        ? '🔴 SUPERINTELLIGENCE AGENT LIVE — wallet se real orders, max 3/day, auto entry+exit armed'
        : mode === 'notify'
          ? '🔔 Agent NOTIFY mode live — STRONG signals Telegram par pingenge, koi order nahi'
          : '🧠 Agent PAPER mode live — wallet-based sizing ke saath practice trades');
      // v9.7: honest start warning — equity floor etc. turant dikhe,
      // 3 din baad log me dhoondhna nahi padega.
      if ((r as { warning?: string }).warning) notify(false, `⚠️ ${(r as { warning?: string }).warning}`);
      setShowLive(false); setLivePhrase('');
      load();
    } else {
      notify(false, `⛔ ${r.error}`);
    }
  }, [livePhrase, notify, load]);

  const onStop = useCallback(async () => {
    setBusy(true);
    const r = await stopAgent();
    setBusy(false);
    if (r.ok) { notify(true, '⏹ Agent stopped — open positions watcher se manage honge'); load(); }
    else notify(false, `⛔ ${r.error}`);
  }, [notify, load]);

  if (!view) {
    if (viewFailed) {
      return (
        <div className="quantum-panel rounded-2xl p-6 text-center border border-amber-500/20">
          <div className="text-3xl mb-2">⚠️</div>
          <div className="text-xs text-amber-300 font-bold">Agent status unavailable</div>
          <div className="text-[11px] text-slate-500 mt-1">Server jagg raha hai ya network slow hai — har 30s me retry ho raha hai. Pehla response aane ke baad panel ms-level fast ho jata hai.</div>
          <button onClick={() => { setViewFailed(false); load(); }} className="mt-3 px-3 py-1.5 rounded-lg text-[10px] font-black quantum-btn-ghost">↻ Retry now</button>
        </div>
      );
    }
    return (
      <div className="quantum-panel rounded-2xl p-6 text-center">
        <div className="text-3xl mb-2 animate-float">🤖</div>
        <div className="text-xs text-slate-400 font-bold">Loading Superintelligence Agent…</div>
      </div>
    );
  }

  const statusChip = running
    ? (paused ? { text: `STOOD DOWN — ${paused.reason?.slice(0, 60)}`, cls: 'bg-amber-500/15 text-amber-300 border-amber-500/40' }
      : { text: `RUNNING · ${view.config.mode.toUpperCase()} · next scan ${view.state.nextScanInSec != null ? `${view.state.nextScanInSec}s` : '—'}`, cls: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/40 animate-pulse' })
    : { text: 'STOPPED', cls: 'bg-slate-600/20 text-slate-400 border-slate-600/30' };

  // v9.7: AGENT BLOCKERS — the "entry kyun nahi ho raha" strip. Hard
  // blockers red, soft wait-states (cooldown/no-signal/futures-margin)
  // slate. Ye panel hi wahi jagah hai jahan user ko reason turant
  // milta hai — pehle console log me chhupa tha.
  const blockers = view.blockers || [];
  const hardBlockers = blockers.filter(b => !b.soft);
  // v10.1: decision-quality strip (B1-B4) — quorum bar, dynamic windows,
  // rolling win-rate, correlation guard — the agent's accuracy state.
  const acc = view.accuracy;

  return (
    <div className="quantum-panel rounded-2xl p-4 bg-gradient-to-r from-cyan-500/[0.07] via-transparent to-amber-500/[0.05]">
      {/* v9.2.1: transient poll failure — old status stays, flagged */}
      {stalePoll && (
        <div className="mb-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-2.5 py-1.5 text-[10px] text-amber-300 font-semibold">
          ⚠️ Live status update fail — purana status dikh raha hai, har 30s auto-retry jaari
        </div>
      )}
      {/* header */}
      <div className="flex items-center gap-3 flex-wrap">
        <div className="flex items-center gap-2">
          <span className={`text-2xl ${running && !paused ? 'animate-float' : ''}`}>🤖</span>
          <div>
            <div className="flex items-center gap-2">
              <h3 className="text-sm font-black gradient-text-cyan tracking-wide">SUPERINTELLIGENCE AUTO-AGENT</h3>
              <span className="quantum-badge">v7.0 PRO</span>
              <span className="px-1.5 py-0.5 rounded text-[9px] font-black bg-gradient-to-r from-amber-500/20 to-emerald-500/20 text-amber-300 border border-amber-500/30" title="3-tier partial take-profit + breakeven lock + trailing runner">
                ⚡ PRO TRADER
              </span>
            </div>
            <div className="text-[10px] text-slate-500 mt-0.5">
              wallet-sizing · auto entry · 3-tier partial TP (T1 {cfg?.partialTpEnabled ? `${cfg?.tp1ClosePct ?? 40}%+BE-lock → T2 ${cfg?.tp2ClosePct ?? 40}% → runner ${cfg?.runnerPct ?? 20}%` : 'off'}) · {cfg?.maxTradesPerDay ?? 3} trades/day · time-exit · {view.state.tickSec ?? 30}s server loop{cfg?.manageManualPositions === false ? '' : ' · 🛡 trend-flip guards manual positions too'}
            </div>
            {/* v19.0 USER SPEC → v21.0.5: auto-trading desk scope —
                CoinDCX auto entries SIRF Global Futures (USDT margin) +
                Equity SIM (USDC) me. The SPOT desk itself is REMOVED
                from the tab (v21.0.5) — its scope chip went with it. */}
            <div className="flex items-center gap-1.5 mt-1 flex-wrap">
              <span className="text-[9px] text-slate-500 font-mono font-bold">AUTO SCOPE:</span>
              <span className={`px-1.5 py-0.5 rounded text-[9px] font-black font-mono border ${cfg?.desks?.futures !== false ? 'bg-emerald-500/15 text-emerald-300 border-emerald-500/40' : 'bg-slate-600/20 text-slate-500 border-slate-600/30'}`} title="CoinDCX margin futures — USDT-margined perps">
                FUTURES · USDT {cfg?.desks?.futures !== false ? 'ON' : 'OFF'}
              </span>
              <span className={`px-1.5 py-0.5 rounded text-[9px] font-black font-mono border ${cfg?.desks?.global !== false ? 'bg-emerald-500/15 text-emerald-300 border-emerald-500/40' : 'bg-slate-600/20 text-slate-500 border-slate-600/30'}`} title="Global equity futures SIM desk — USDC paper margin (Apple/Google/NVIDIA/SPACEX perps)">
                EQUITY SIM · USDC {cfg?.desks?.global !== false ? 'ON' : 'OFF'}
              </span>
              <span className={`px-1.5 py-0.5 rounded text-[9px] font-black font-mono border ${cfg?.desks?.india !== false ? 'bg-cyan-500/15 text-cyan-300 border-cyan-500/40' : 'bg-slate-600/20 text-slate-500 border-slate-600/30'}`} title="NSE India desk (Dhan/paper) — CoinDCX se alag desk">
                INDIA {cfg?.desks?.india !== false ? 'ON' : 'OFF'}
              </span>
              {/* v21.0.5: SPOT desk tab se REMOVE — ye chip sirf tabhi dikhe
                  jab kisi purane saved config ne spot explicitly ON rakha
                  ho (server ki v19.0 migration naye configs me default
                  OFF hi rakhti hai; chip honest disclosure hai). */}
              {cfg?.desks?.spot === true && (
                <span className="px-1.5 py-0.5 rounded text-[9px] font-black font-mono border bg-slate-600/20 text-slate-500 border-slate-600/30" title="v21.0.5: SPOT desk CoinDCX tab se REMOVE ho chuka hai — ye chip sirf purane saved-config disclosure ke liye hai">
                  SPOT DESK REMOVED (v21.0.5)
                </span>
              )}
            </div>
          </div>
        </div>
        <div className="ml-auto flex items-center gap-2 flex-wrap">
          <span className={`px-2.5 py-1 rounded-lg border text-[10px] font-black font-mono ${statusChip.cls}`} role="status">
            {statusChip.text}
          </span>
          {running ? (
            <button onClick={onStop} disabled={busy}
              className="px-4 py-2 rounded-xl text-xs font-black bg-red-500/15 text-red-300 border border-red-500/40 hover:bg-red-500/25 disabled:opacity-50">
              ⏹ STOP
            </button>
          ) : (
            <>
              <button onClick={() => onStart('paper')} disabled={busy}
                className="px-4 py-2 rounded-xl text-xs font-black bg-cyan-500/15 text-cyan-300 border border-cyan-500/40 hover:bg-cyan-500/25 disabled:opacity-50">
                ▶ START PAPER
              </button>
              <button onClick={() => onStart('notify')} disabled={busy}
                title="NOTIFY mode (v6.11) — agent STRONG signals dhoondhega aur Telegram par alert karega. Koi order/place position nahi — 3/day quota bhi nahi jalta."
                className="px-4 py-2 rounded-xl text-xs font-black bg-sky-500/15 text-sky-300 border border-sky-500/40 hover:bg-sky-500/25 disabled:opacity-50">
                🔔 START NOTIFY
              </button>
              <button onClick={() => setShowLive(s => !s)} disabled={busy || !liveArmed}
                className={`px-4 py-2 rounded-xl text-xs font-black border disabled:opacity-40 ${liveArmed ? 'bg-red-500/15 text-red-300 border-red-500/40 hover:bg-red-500/25' : 'bg-black/30 text-slate-500 border-slate-700/40'}`}
                title={liveArmed ? 'Real orders — typed LIVE confirmation' : 'Pehle Risk settings me mode LIVE (typed) + Auto-execution ON karo'}>
                🔴 START LIVE
              </button>
            </>
          )}
        </div>
      </div>

      {!liveArmed && !running && (
        <div className="text-[10px] text-slate-500 mt-2 font-mono">
          LIVE ke liye: Execution Console → Risk settings → mode LIVE (type "LIVE") + Auto-execution ON + CoinDCX connected. Agent LIVE start par bhi typed "LIVE" maangta hai.
        </div>
      )}

      {showLive && (
        <div className="mt-2 bg-red-500/[0.07] border border-red-500/30 rounded-xl p-3 flex items-center gap-2 flex-wrap">
          <span className="text-[10px] font-black text-red-300">TYPE "LIVE" TO ARM REAL ORDERS:</span>
          <input value={livePhrase} onChange={e => setLivePhrase(e.target.value)} placeholder="LIVE"
            className="bg-black/40 border border-red-500/30 rounded-lg px-2 py-1 text-xs font-mono w-28 text-slate-200" aria-label="live confirmation phrase" />
          <button onClick={() => onStart('live')} disabled={busy || livePhrase.trim().toUpperCase() !== 'LIVE'}
            className="px-3 py-1.5 rounded-lg text-[10px] font-black bg-red-500/25 text-red-200 border border-red-500/40 disabled:opacity-40">
            ARM REAL MONEY
          </button>
          <span className="text-[9px] text-slate-500">kill switch / caps / gauntlet sab apply hote hain — ye agent ke liye private koi bypass nahi hai</span>
        </div>
      )}

      {/* v9.7: AGENT BLOCKERS strip — live answer to "auto trade kyun nahi ho raha" */}
      {blockers.length > 0 && (
        <div className={`mt-2 rounded-xl border p-2.5 ${hardBlockers.length > 0 ? 'border-red-500/30 bg-red-500/[0.06]' : 'border-slate-600/30 bg-black/25'}`} data-testid="agent-blockers" aria-label="agent blockers">
          <div className="flex items-center gap-2 flex-wrap">
            <span className={`text-[10px] font-black tracking-wider ${hardBlockers.length > 0 ? 'text-red-300' : 'text-slate-400'}`}>
              {hardBlockers.length > 0 ? '🚧 AGENT BLOCKERS — entry ruka hua hai:' : '🛰 AGENT WAITING —'}
            </span>
            <span className="text-[9px] font-mono text-slate-500">scan every {view.state.tickSec ?? 30}s · scans: {view.state.scans}</span>
          </div>
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {blockers.map(b => (
              <span key={b.key} title={b.text}
                className={`px-2 py-1 rounded-lg text-[10px] font-bold border leading-snug ${b.soft
                  ? 'bg-black/30 border-slate-600/40 text-slate-400'
                  : 'bg-red-500/10 border-red-500/30 text-red-200'}`}>
                {b.text}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* v10.1: DECISION-QUALITY strip — the agent's accuracy upgrades at a glance */}
      {acc && (
        <div className="mt-2 rounded-xl border border-cyan-500/20 bg-cyan-500/[0.04] p-2.5" data-testid="agent-accuracy" aria-label="agent accuracy state">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-[10px] font-black tracking-wider text-cyan-300">🎯 DECISION QUALITY</span>
            {acc.quorumAwareEntry && (
              <span className="px-2 py-0.5 rounded-md text-[9px] font-mono border bg-black/30 border-cyan-500/30 text-cyan-300"
                title="Thin committees (<5 voters) need a HIGHER AI-score bar to touch money">
                quorum bar {acc.thinCommitteeMinAiScore}+ (thin) / {acc.effectiveMinAiScore}+ (full)
              </span>
            )}
            {acc.dynamicTimeExit && (
              <span className="px-2 py-0.5 rounded-md text-[9px] font-mono border bg-black/30 border-cyan-500/30 text-cyan-300"
                title="Time-exit windows adapt to each position's entry-time ATR% — fast movers cut sooner, slow movers get time">
                ATR time-exit {acc.openWindowOverrides?.length ? `· ${acc.openWindowOverrides.map(o => `${(String(o.pair).split('_')[0] || '').replace('B-', '') || o.pair}: ${o.windowMin}m`).join(', ')}` : '(base window)'}
              </span>
            )}
            <span className={`px-2 py-0.5 rounded-md text-[9px] font-mono border ${acc.rollingWinRate == null
              ? 'bg-black/30 border-slate-600/40 text-slate-500'
              : acc.rollingWinRate < acc.minRollingWinRate
                ? 'bg-red-500/10 border-red-500/30 text-red-200'
                : 'bg-emerald-500/10 border-emerald-500/30 text-emerald-200'}`}
              title={`Last ${acc.rollingWindow} closed agent trades — below ${acc.minRollingWinRate}% a LIVE agent self-downgrades to paper`}>
              rolling WR {acc.rollingWinRate == null ? `needs ${acc.rollingWindow} trades` : `${acc.rollingWinRate}%`}
              {acc.winRateDowngraded ? ' · DOWNGRADED→PAPER' : ''}
            </span>
            {acc.correlationGuard && (
              <span className="px-2 py-0.5 rounded-md text-[9px] font-mono border bg-black/30 border-cyan-500/30 text-cyan-300"
                title="A new entry |r|>0.7-correlated with an open position is the same bet twice — skipped">
                corr-guard |r|≤0.7
              </span>
            )}
            {/* v10.8: near-miss auto-trade chip */}
            <span className={`px-2 py-0.5 rounded-md text-[9px] font-mono border ${acc.nearMiss?.enabled
              ? 'bg-fuchsia-500/10 border-fuchsia-500/30 text-fuchsia-300'
              : 'bg-black/30 border-slate-600/40 text-slate-500'}`}
              title={acc.nearMiss?.enabled
                ? `Jab full bar koi clear na kare: highest AI-score near-miss (gap ≤ ${acc.nearMiss?.scoreGap}pt, conf ≥ ${acc.nearMiss?.minConfidence}%, 5+ voters) auto-entry lagta hai — ${acc.nearMiss?.usedToday}/${acc.nearMiss?.maxPerDay} aaj use ho chuke`
                : 'Near-miss auto-trade OFF hai — Agent Rules me enable karo'}>
              near-miss auto {acc.nearMiss?.enabled ? `≤${acc.nearMiss?.scoreGap}pt · ${acc.nearMiss?.usedToday ?? 0}/${acc.nearMiss?.maxPerDay ?? 1}` : 'OFF'}
            </span>
            {/* v10.8: winner-extension chip */}
            <span className={`px-2 py-0.5 rounded-md text-[9px] font-mono border ${acc.winnerExtension?.enabled
              ? 'bg-violet-500/10 border-violet-500/30 text-violet-300'
              : 'bg-black/30 border-slate-600/40 text-slate-500'}`}
              title={acc.winnerExtension?.enabled
                ? `Time-exit par profitable position ki window +${acc.winnerExtension?.extendPct}% extend hoti hai (max ${acc.winnerExtension?.max}×) + SL breakeven lock — losers original window par hi cut`
                : 'Winner extension OFF hai'}>
              win-extend {acc.winnerExtension?.enabled ? `+${acc.winnerExtension?.extendPct}% ×${acc.winnerExtension?.max}${acc.winnerExtension?.open?.length ? ` · ${acc.winnerExtension.open.map(o => `${o.pair.replace(/^B-/, '').replace('_USDT', '')}:${o.windowMin}m`).join(', ')}` : ''}` : 'OFF'}
            </span>
            {/* v10.8 PRO #4: frozen mandate chip */}
            {acc.mandate && (
              <span className="px-2 py-0.5 rounded-md text-[9px] font-mono border bg-amber-500/10 border-amber-500/30 text-amber-300"
                title={`MANDATE frozen at agent start (${new Date(acc.mandate.frozenAt).toLocaleString('en-IN')}) — mid-session risk-cap loosening ignore hoti hai; STOP+START par naya mandate freezes. Caps: ${Object.entries(acc.mandate.caps || {}).filter(([, v]) => v != null).map(([k, v]) => `${k}=${v}`).join(' · ')}`}>
                🔒 mandate {acc.mandate.mode?.toUpperCase()}
              </span>
            )}
            {acc.v2ModelsEnabled != null && (
              (() => {
                // v21.12.0: numbers ab server ke committee payload se —
                // hardcoded 16/13 strings ka end (user ka "sirf 13 models
                // dikha raha hai" confusion). Payload na ho to honest
                // fallback (v2ModelsEnabled se derive).
                const c = acc.committee;
                const voting = c?.voting ?? (acc.v2ModelsEnabled ? 16 : 13);
                const shadow = c?.shadow ?? (acc.v2ModelsEnabled ? 4 : 0);
                const tapeTxt = c?.tapeSeat === 'tape-mtf' ? `tape-MTF w${c.tapeWeight}` : c?.tapeSeat ? `tape w${c.tapeWeight}` : '';
                const metaTxt = c ? ` · META ${c.meta?.enabled ? 'ARMED' : 'OFF'}${c.meta?.enabled ? ` (${(c.meta.serviceUrl || '').replace(/^https?:\/\//, '')})` : ''}` : '';
                const winTxt = c ? ` · learning window ${c.learningWindow}` : '';
                return (
                  <span className={`px-2 py-0.5 rounded-md text-[9px] font-mono border ${acc.v2ModelsEnabled ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-300' : 'bg-black/30 border-slate-600/40 text-slate-500'}`}
                    title={acc.v2ModelsEnabled
                      ? `Full Superintelligence committee LIVE — ${voting} voting seats + ${shadow} mesh shadow (w0, evidence-collecting)${tapeTxt ? ` · ${tapeTxt}` : ''}${winTxt}${metaTxt}`
                      : 'V2 models disabled — AI_ACCURACY_SUITE=false (legacy A/B mode) ke bina ye kabhi off nahi hona chahiye; agar hai to .env check karo'}>
                    🧬 committee {voting} voting{shadow ? ` + ${shadow} shadow` : ''}{tapeTxt ? ` · ${tapeTxt}` : ''}
                  </span>
                );
              })()
            )}
          </div>
          {acc.lastNearMisses && acc.lastNearMisses.length > 0 && (
            <div className="mt-1.5 pt-1.5 border-t border-cyan-500/15 flex items-center gap-1.5 flex-wrap text-[9px] font-mono">
              <span className="text-amber-300 font-bold" title="Closest signals to the auto-entry bar — top score + high conf wale auto-trade ho jaate hain (jab tak daily near-miss budget baaki hai)">
                NEAR-MISSES {acc.nearMiss?.enabled ? '(auto-traded · best one)' : '(diagnostic only)'}:
              </span>
              {acc.lastNearMisses.map((nm) => (
                <span key={nm.pair} className="px-1.5 py-0.5 rounded bg-black/30 text-slate-300 border border-slate-700/40"
                  title={`${nm.symbol}: score ${nm.aiScore} (needed ${nm.needScore}), ${nm.voters} voters${nm.quorumCapped ? ' (QUORUM-CAPPED)' : ''}, ${nm.confidence}% conf`}>
                  {nm.symbol} {nm.aiScore}/{nm.needScore} ({nm.voters}v{nm.quorumCapped ? ' ⚠️' : ''})
                </span>
              ))}
            </div>
          )}
          {/* v10.8: today's near-miss auto-entries (audit strip) */}
          {acc.nearMiss?.todayEntries && acc.nearMiss.todayEntries.length > 0 && (
            <div className="mt-1 flex items-center gap-1.5 flex-wrap text-[9px] font-mono">
              <span className="text-fuchsia-300 font-bold">NEAR-MISS AUTO-ENTRIES TODAY:</span>
              {acc.nearMiss.todayEntries.map((e, i) => (
                <span key={`${e.symbol}-${e.ts}-${i}`} className="px-1.5 py-0.5 rounded bg-fuchsia-500/10 text-fuchsia-300 border border-fuchsia-500/30"
                  title={`${e.symbol}: AI ${e.aiScore} vs bar ${e.needScore} · conf ${e.confidence}% · ${e.voters} voters`}>
                  {e.symbol} AI {e.aiScore}/{e.needScore}
                </span>
              ))}
            </div>
          )}
        </div>
      )}

      {/* body grid */}
      <div className="grid gap-3 mt-3 lg:grid-cols-2">
        <div className="space-y-3">
          <WalletCard wallet={wallet || view.wallet} />
          <SizingPreviewCard preview={view.sizingPreview} />
          <ProStrategyCard cfg={view.config} />
          <TradeSlots
            used={view.today.tradesCount}
            total={view.today.maxTrades}
            pnlINR={view.today.realizedPnlINR}
            lossCapINR={view.today.lossCapINR} />
          <AgentConfigEditor cfg={view.config} onSaved={notify} />
        </div>
        <div className="space-y-3">
          <OpenPositions positions={view.openPositions} cfg={view.config} />
          <TodayTrades trades={view.today.trades} />
          <PickStrip title="🇮🇳 INDIA INTRADAY PICKS (agent watch)" picks={view.picks.INDIA} accent="text-orange-300" />
          <PickStrip title="⚡ FUTURES PICKS (auto-trade desk)" picks={view.picks.FUTURES} accent="text-amber-300" />
          {/* v21.0.5: SPOT desk removed — the third strip now shows the
              EQUITY SIM auto-trade picks (GLOBALFUTURES), which were
              previously invisible although the agent auto-trades them. */}
          <PickStrip title="🌍 EQUITY SIM PICKS (auto-trade desk)" picks={view.picks.GLOBALFUTURES} accent="text-sky-300" />
        </div>
      </div>

      <div className="mt-3">
        <LogFeed log={view.state.log} />
      </div>
    </div>
  );
});
