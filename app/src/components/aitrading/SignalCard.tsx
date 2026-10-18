// ============================================================
// src/components/aitrading/SignalCard.tsx
// ------------------------------------------------------------
// One consensus signal, expanded: confidence gauge, trade plan,
// every model's vote with reasons, AI Council note.
//
// v6.6 SIMPLE TRADE —
//   • 🚀 TRADE button on every actionable card opens the SIMPLE TRADE
//     TICKET: one screen with everything pre-computed to TAKE the
//     trade — size input, qty, ₹ risk @ SL, ₹ reward @ T2, R:R — and
//     one-click PAPER / LIVE execute. The math MIRRORS the server
//     (qty = budget÷price, leverage notional, liquidation est.) so the
//     preview you see is the position you get.
//   • CRYPTO LEVERAGE: chips 1x..10x (server-clamped ceiling),
//     liquidation estimate + "liquidation fires before your SL"
//     warning with the max-sane-leverage hint, honest ₹-risk scaling.
//   • v6.4 features kept: India manual-broker trade slip, crypto order
//     preview, risk-auto-fit transparency chips.
// ============================================================
import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { MTFConfluenceBadge } from '../intraday/MTFConfluenceBadge';
import { CandleChart } from './CandleChart';
import { DepthLadder } from './DepthLadder';
import { LiveSourceBadge } from './LiveSourceBadge';
import { LiveExecuteModal } from './LiveExecuteModal';
import { liveInvalidationCheck } from './liveInvalidation';
import type { AISignal, Side, SuperIntel, SignalVerification, UltrafastVerification } from './types';

/** v21.3.0 (Issue-5) lineage: Jev AI confirmation chip — the board
 *  signal's verdict from the AI provider (Jev cloud).
 *  v21.11.0 (decision transparency): provider ka bit ab apna DIRECTION
 *  dikhaata hai — "Jev ✓ LONG" / "Jev ✗ SHORT 68%" / "Jev ○ SHORT-lean
 *  29%" / "Jev ○ slow" — pehle hollow ○ hi dikhta tha. Legacy payloads
 *  (bina detail ke) purane ✓/✗/○ me render hote hain.
 *  v21.14.0: Laya removed — jev-only. */
function AiConfirmBadge({ v }: { v: NonNullable<AISignal['aiConfirm']> }) {
  const confirmed = v.verdict === 'CONFIRMED';
  const conflict = v.verdict === 'CONFLICT';
  const sideOf = (p?: string | null) => (p === 'enter_short' ? 'SHORT' : p === 'enter_long' ? 'LONG' : null);
  const pct = (x?: number | null) => (x != null && Number.isFinite(x) ? `${Math.round(x * 100)}%` : null);
  // one provider's bit: symbol + direction + conviction (jab available)
  const bit = (key: 'jev', label: string): string | null => {
    const vs = v[key];
    if (!vs) return null;
    const d = v.detail?.[key];
    if (!d) {
      // legacy wire (koi detail nahi) — direction unknown, symbol only
      return `${label} ${vs === 'AGREE' ? '✓' : vs === 'DISAGREE' ? '✗' : '○'}`;
    }
    const side = sideOf(d.picked);
    const pOfPicked = d.picked === 'enter_short' ? d.pShort : d.picked === 'enter_long' ? d.pLong : null;
    if (d.v === 'AGREE') {
      return `${label} ✓${side ? ` ${side}` : ''}${pct(pOfPicked) ? ` ${pct(pOfPicked)}` : ''}`;
    }
    if (d.v === 'DISAGREE') {
      // provider ULTA side pe hai — uski picked side + conviction
      return `${label} ✗${side ? ` ${side}` : ''}${pct(pOfPicked) ? ` ${pct(pOfPicked)}` : ''}`;
    }
    // NEUTRAL — lean (below-threshold pick) ya honest reason
    if (side) {
      return `${label} ○ ${side}-lean${pct(pOfPicked) ? ` ${pct(pOfPicked)}` : ''}`;
    }
    return `${label} ○ ${d.reason || 'wait'}`;
  };
  const bits = [
    bit('jev', 'Jev'),
  ].filter(Boolean).join(' · ');
  // tooltip: provider ka full story — kya chuna, kitna conviction,
  // kyu (note/reason) + board effect
  const tipBits = (['jev'] as const).map((key) => {
    const label = 'Jev (cloud)';
    const vs = v[key];
    if (!vs) return null;
    const d = v.detail?.[key];
    if (!d) {
      return `${label}: ${vs === 'AGREE' ? ' isi side pe AGREE' : vs === 'DISAGREE' ? ' ULTA side (DISAGREE)' : ' abstain/wait'}`;
    }
    const side = sideOf(d.picked);
    const p = d.picked === 'enter_short' ? d.pShort : d.picked === 'enter_long' ? d.pLong : null;
    const probs = [d.pLong != null ? `LONG ${pct(d.pLong)}` : null, d.pShort != null ? `SHORT ${pct(d.pShort)}` : null, d.pWait != null ? `wait ${pct(d.pWait)}` : null].filter(Boolean).join(' / ');
    const head = d.v === 'AGREE'
      ? `${label}: ${side ?? 'same side'} APPROVE kiya${pct(p) ? ` (p ${pct(p)})` : ''}`
      : d.v === 'DISAGREE'
        ? `${label}: ULTA — ${side ?? 'opposite side'} chuna${pct(p) ? ` (p ${pct(p)})` : ''}`
        : side
          ? `${label}: ${side} ki taraf LEAN${pct(p) ? ` (p ${pct(p)})` : ''} par threshold ke neeche — entry nahi kaha`
          : `${label}: entry nahi li (reason: ${d.reason || 'wait'})`;
    const tail = [
      probs ? `probs ${probs}` : null,
      d.confidence != null ? `conf ${d.confidence}` : null,
      d.latencyMs != null ? `${d.latencyMs}ms` : null,
      d.note ? `note ${d.note}` : null,
    ].filter(Boolean).join(' · ');
    return tail ? `${head} — ${tail}` : head;
  }).filter(Boolean).join('\n');
  return (
    <span
      className={`px-1.5 py-0.5 rounded text-[9px] font-black border font-mono ${confirmed ? 'bg-cyan-500/15 text-cyan-300 border-cyan-500/40' : conflict ? 'bg-red-500/15 text-red-300 border-red-500/40' : 'bg-slate-700/40 text-slate-300 border-slate-600/40'}`}
      title={`Jev (cloud) AI decision — ${bits || 'no verdict'}\n\n${tipBits}\n\nBoard effect: ${confirmed ? 'provider ne ye side APPROVE kiya (+3 score)' : conflict ? 'provider ULTA side chuna (−8 score, STRONG→ACTION demote)' : 'abstain/wait — score untouched'}. AI kabhi side/size/SL nahi badalta — sirf confirm ya demote karta hai.`}
    >
      {confirmed ? `🤖 AI ✓ (${bits})` : conflict ? `🤖 AI ✗ (${bits})` : `🤖 AI ○ (${bits})`}
    </span>
  );
}

const fmt = (n: number | null | undefined, dp = 2): string => {
  if (n == null || !Number.isFinite(n)) return '—';
  if (Math.abs(n) >= 1e7) return `₹${(n / 1e7).toFixed(2)}Cr`;
  if (Math.abs(n) >= 1e5) return `₹${(n / 1e5).toFixed(2)}L`;
  return `₹${n.toLocaleString('en-IN', { maximumFractionDigits: dp })}`;
};

/** v9.2 ADAPTIVE PRICE FORMAT — sub-1 instruments (DOGE 0.0848, SHIB
 *  0.00085, PEPE micro-ticks) must never collapse to "0.08"/"0.00"
 *  in a plan or ticket: a stop that displays ON the entry is an
 *  instant-stop-out lie. 4-8 decimals kick in below ₹1/USDT 1. */
const pxFmt = (v: number | null | undefined): string => {
  if (v == null || !Number.isFinite(v)) return '—';
  const a = Math.abs(v);
  const dp = a >= 1 ? 2 : a >= 0.01 ? 4 : a >= 0.0001 ? 6 : 8;
  return v.toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp });
};
/** v10.5.3 CURRENCY TAGS — the old boolean helper only branched on
 *  `futures`, so GLOBALFUTURES (global equity SIM) cards priced their
 *  ENTRY/SL/TARGETS in ₹. Now every desk formats distinctly:
 *    'inr'  → ₹178.32   (India desk, NSE)
 *    'usdt' → 63,120.50 USDT (CoinDCX USDT-margined perp domain)
 *    'usdc' → USDC 178.32   (v10.7: CoinDCX Global Futures — USDC-
 *                           margined equity perps, the EXACT domain the
 *                           app shows; NOT USDT margin like crypto perps,
 *                           so the two are never visually conflated) */
export type CurrencyTag = 'inr' | 'usdt' | 'usdc';
const px = (v: number | null | undefined, cur: CurrencyTag = 'inr'): string => {
  if (v == null || !Number.isFinite(v)) return '—';
  if (cur === 'inr') return `₹${pxFmt(v)}`;
  const s = pxFmt(v);
  return cur === 'usdc' ? `USDC ${s}` : `${s} USDT`;
};
/** The currency tag for a market — the ONE place desks resolve their unit. */
const curFor = (market: string): CurrencyTag =>
  market === 'FUTURES' ? 'usdt' : market === 'GLOBALFUTURES' ? 'usdc' : 'inr';

/** v10.10 LIVE LTP TEXT — renders the direct-CoinDCX 2s stream price with
 *  a 600ms green/red flash on every tick (trading-terminal feel). Falls
 *  back to the board-snapshot text when no live tick has arrived yet —
 *  the card NEVER shows a blank price while the stream connects. */
function LivePriceText({ value, fallback, format }: { value: number | null; fallback: string; format: (n: number) => string }) {
  const [dir, setDir] = useState<'' | 'up' | 'down'>('');
  const prev = useRef<number | null>(value);
  useEffect(() => {
    if (value == null || !(value > 0)) { prev.current = null; return; }
    const before = prev.current;
    if (before != null && before > 0) {
      if (value > before) setDir('up');
      else if (value < before) setDir('down');
    }
    prev.current = value;
    const t = setTimeout(() => setDir(''), 600);
    return () => clearTimeout(t);
  }, [value]);
  if (value == null || !(value > 0)) return <>{fallback}</>;
  return <span className={dir === 'up' ? 'text-emerald-300' : dir === 'down' ? 'text-red-300' : 'text-slate-100'}>{format(value)}</span>;
}

const sideColor = (side: Side | string) =>
  side === 'LONG' ? 'text-emerald-400' : side === 'SHORT' ? 'text-red-400' : 'text-slate-400';

const gradeBadge = (grade: string) => {
  switch (grade) {
    case 'STRONG': return { cls: 'bg-emerald-500/15 text-emerald-300 border border-emerald-500/40', label: '★ STRONG' };
    case 'ACTION': return { cls: 'bg-cyan-500/15 text-cyan-300 border border-cyan-500/40', label: 'ACTION' };
    case 'WATCH': return { cls: 'bg-amber-500/15 text-amber-300 border border-amber-500/40', label: 'WATCH' };
    default: return { cls: 'bg-slate-500/15 text-slate-400 border border-slate-500/30', label: 'NEUTRAL' };
  }
};

function ConfidenceGauge({ value, side }: { value: number; side: string }) {
  const r = 26, c = 2 * Math.PI * r;
  const pct = Math.max(0, Math.min(100, value)) / 100;
  const stroke = side === 'LONG' ? '#34d399' : side === 'SHORT' ? '#f87171' : '#94a3b8';
  return (
    <div className="relative w-16 h-16 shrink-0" role="img" aria-label={`confidence ${value}%`}>
      <svg viewBox="0 0 64 64" className="w-16 h-16 -rotate-90">
        <circle cx="32" cy="32" r={r} fill="none" stroke="rgba(148,163,184,0.15)" strokeWidth="6" />
        <circle cx="32" cy="32" r={r} fill="none" stroke={stroke} strokeWidth="6" strokeLinecap="round"
          strokeDasharray={`${c * pct} ${c}`} className="transition-all duration-700" />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span className={`text-sm font-black font-mono ${sideColor(side)}`}>{value}</span>
        <span className="text-[8px] text-slate-500 font-bold tracking-wider">CONF</span>
      </div>
    </div>
  );
}

/** v9 SUPERINTELLIGENCE — the AI SCORE ring (0-100): engine conviction ×
 *  7-factor expert score × AI verdict. 85+ ELITE (gold), 80+ STRONG
 *  (emerald), 65+ ACTION (cyan) — the ring colour IS the tier. */
function SuperIntelRing({ score, tier }: { score: number; tier: string }) {
  const r = 26, c = 2 * Math.PI * r;
  const pct = Math.max(0, Math.min(100, score)) / 100;
  const gold = tier === 'ELITE';
  const strong = tier === 'STRONG';
  const action = tier === 'ACTION';
  const stroke = gold ? '#fbbf24' : strong ? '#34d399' : action ? '#22d3ee' : '#64748b';
  return (
    <div className="relative w-16 h-16 shrink-0" role="img" aria-label={`AI score ${score} ${tier}`}>
      <svg viewBox="0 0 64 64" className="w-16 h-16 -rotate-90">
        <circle cx="32" cy="32" r={r} fill="none" stroke="rgba(148,163,184,0.15)" strokeWidth="6" />
        <circle cx="32" cy="32" r={r} fill="none" stroke={stroke} strokeWidth="6" strokeLinecap="round"
          strokeDasharray={`${c * pct} ${c}`} className="transition-all duration-700"
          style={gold ? { filter: 'drop-shadow(0 0 5px rgba(251,191,36,0.7))' } : undefined} />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span className={`text-sm font-black font-mono ${gold ? 'text-amber-300' : strong ? 'text-emerald-300' : action ? 'text-cyan-300' : 'text-slate-400'}`}>{score}</span>
        <span className="text-[8px] text-slate-500 font-bold tracking-wider">AI SCORE</span>
      </div>
    </div>
  );
}

const superTierBadge = (tier: string) => {
  switch (tier) {
    case 'ELITE': return { cls: 'bg-gradient-to-r from-amber-400/25 to-yellow-500/25 text-amber-300 border border-amber-400/50 shadow-[0_0_12px_rgba(251,191,36,0.25)]', label: '🧠 ELITE 85+' };
    case 'STRONG': return { cls: 'bg-emerald-500/15 text-emerald-300 border border-emerald-500/40', label: '🔥 STRONG 80+' };
    case 'ACTION': return { cls: 'bg-cyan-500/15 text-cyan-300 border border-cyan-500/40', label: '⚡ ACTION 65+' };
    case 'WATCH': return { cls: 'bg-amber-500/15 text-amber-300 border border-amber-500/40', label: 'WATCH 50+' };
    default: return { cls: 'bg-slate-500/15 text-slate-400 border border-slate-500/30', label: 'NEUTRAL' };
  }
};

/** v13.1 SIGNAL VERIFICATION AGENT (SVA-v1) — THE final-call badge.
 *  The senior pro-trader second opinion: CONFIRM (same side, full
 *  risk) / CAUTION (half risk) / FLIP → opposite side (the XRP-class
 *  top-chase trap) / STAND ASIDE (no trade). This is the chip the
 *  user reads FIRST — "long jana hai ya short" ka seedha jawab. */
function VerifyBadge({ v, side }: { v: SignalVerification; side: string }) {
  const confirm = v.action === 'CONFIRM';
  const caution = v.action === 'CAUTION';
  const flip = v.action === 'FLIP';
  const opp = side === 'LONG' ? 'SHORT' : 'LONG';
  const label = confirm ? `🛡 VERIFIED ${side}`
    : caution ? `🛡 CAUTION ${side}`
      : flip ? `🛡 FLIP → ${v.finalCall === opp ? opp : v.finalCall}`
        : '🛡 STAND ASIDE';
  const cls = confirm ? 'bg-emerald-500/15 text-emerald-300 border-emerald-500/50 shadow-[0_0_10px_rgba(52,211,153,0.25)]'
    : caution ? 'bg-amber-500/15 text-amber-300 border-amber-500/50'
      : flip ? 'bg-rose-500/15 text-rose-300 border-rose-500/50 shadow-[0_0_10px_rgba(244,63,94,0.3)] animate-pulse'
        : 'bg-slate-600/25 text-slate-300 border-slate-500/50';
  const tip = [
    v.verdict || `${v.action} — score ${v.score}/100`,
    v.proNote || null,
    v.veto ? 'PRO VETO: chase+RSI-extreme combo — top-tick entry class.' : null,
    v.sizeHint != null ? `Size hint: ${v.sizeHint === 1 ? 'full risk' : v.sizeHint === 0.5 ? 'half risk' : 'NO entry'}` : null,
    v.llm ? `LLM second opinion (${v.llm.model || 'chain'}): ${v.llm.verdict} ${v.llm.confidence}% — ${v.llm.reason}` : null,
  ].filter(Boolean).join('\n\n');
  return (
    <span
      className={`px-2 py-0.5 rounded-md text-[10px] font-black tracking-wider border font-mono ${cls}`}
      title={tip}
    >
      {label} {v.score}{v.llm ? <span className="ml-1 opacity-75" title={`LLM: ${v.llm.verdict}`}>·{v.llm.verdict === 'CONFIRM' ? '🤖✓' : v.llm.verdict === 'REJECT' ? '🤖✕' : '🤖⇄'}</span> : null}
    </span>
  );
}

/** v20.9.2 ULTRAFAST CHART VERIFICATION AGENT (UCV-A1) — the
 *  "pakka" badge. The deep AI agent that reads the REALTIME
 *  ultrafast 1m chart (+ 5m + live tick) and answers the user's
 *  exact question: "ye LONG pakka long jayega? ye SHORT pakka short
 *  jayega?" CONFIRMED = micro tape moving WITH the signal; REJECTED
 *  = micro tape actively AGAINST (the long-bola-par-short-gaya class
 *  — already demoted server-side, this chip explains WHY); PENDING =
 *  neutral/no-data. */
function UltrafastBadge({ v, side }: { v: UltrafastVerification; side: string }) {
  const confirmed = v.verdict === 'CONFIRMED';
  const rejected = v.verdict === 'REJECTED';
  const withDir = v.microDirection === 'UP' || v.microDirection === 'DOWN';
  const label = confirmed ? `⚡ UC ✓ ${side} PAKKA`
    : rejected ? `⚡ UC ✗ ULTA (${v.microDirection === 'UP' ? 'LONG' : 'SHORT'} risk)`
      : '⚡ UC PENDING';
  const cls = confirmed ? 'bg-cyan-500/15 text-cyan-200 border-cyan-400/50 shadow-[0_0_10px_rgba(34,211,238,0.25)]'
    : rejected ? 'bg-rose-500/15 text-rose-300 border-rose-500/60 shadow-[0_0_10px_rgba(244,63,94,0.35)] animate-pulse'
      : 'bg-slate-600/25 text-slate-300 border-slate-500/50';
  const tip = [
    v.answer || `${v.verdict} — micro ${v.microDirection} ${v.score}/100`,
    v.detail ? `Ultrafast read: ${v.detail}` : null,
    v.momentumPct != null ? `Last 5m tape move: ${v.momentumPct >= 0 ? '+' : ''}${v.momentumPct}%` : null,
    v.bars ? `${v.bars} × 1m bars + 5m confirmation + live tick` : null,
    rejected ? 'Server ne is signal ka AI score 64 pe cap + grade WATCH pe demote kar diya hai — ye direction ULTA ja sakta hai, trade mat karo.'
      : confirmed ? 'Realtime 1m chart direction ke SAATH chal raha hai — entry timing ke liye green signal.'
        : '1m ultrafast tape neutral hai — breakout ya confirmation ka wait karo.',
  ].filter(Boolean).join('\n');
  return (
    <span
      className={`px-2 py-0.5 rounded-md text-[10px] font-black tracking-wider border font-mono ${cls}`}
      title={tip}
    >
      {label}{withDir ? ` ${v.score}` : ''}
    </span>
  );
}

/** v20.9.2 — the FULL UCV-A1 micro checklist (deep payloads carry it):
 *  the 9-check ultrafast chart audit — fast EMA stack, recent run,
 *  HH/HL structure, volume pressure, wicks, RSI(7), 5m confirm, live
 *  tick velocity, acceleration.
 *  v20.9.3 FIX (M): EXPORTED — the deep modals render it from the LIVE
 *  payload (deep.signal.ultrafast) independently of the pinned display
 *  card, because the pinned board card carries only the COMPACT wire
 *  (no `checks`) → the checklist was unreachable in the primary
 *  board-click dive flow (only DRIFTED/pin-less dives ever showed it). */
export function UltrafastChecklist({ v }: { v: UltrafastVerification }) {
  const list = v.checks || [];
  if (list.length === 0) return null;
  const stBg = (s: string) => s === 'BULL' ? 'bg-emerald-500/15 border-emerald-500/30' : s === 'BEAR' ? 'bg-rose-500/15 border-rose-500/30' : 'bg-slate-600/25 border-slate-500/30';
  return (
    <div className="mt-2 rounded-xl border border-cyan-500/25 bg-cyan-500/[0.04] p-3 space-y-1.5">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[10px] font-black text-cyan-300 tracking-wider">⚡ ULTRAFAST CHART AGENT — REALTIME 1M MICRO-CHECKLIST</span>
        <span className="text-[10px] font-mono font-black text-slate-200">micro {v.microDirection} · {v.score}/100</span>
      </div>
      <div className="text-[10px] text-slate-300/90 leading-relaxed border-l-2 border-cyan-500/40 pl-2">{v.answer}</div>
      <div className="grid gap-1">
        {list.map(c => (
          <div key={c.id} className="flex items-center gap-2 text-[10px] font-mono">
            <span className={`px-1.5 py-0.5 rounded border font-black w-12 text-center ${stBg(c.status)}`}>{c.status}</span>
            <span className="text-slate-300 w-36 shrink-0 truncate" title={c.label}>{c.label}</span>
            <span className="text-slate-400 truncate flex-1" title={c.detail}>{c.detail}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

/** v13.1 — the full SVA checklist table (deep payloads carry it):
 *  every check's PASS/WARN/FAIL + points earned + the detail line.
 *  Renders inside the expanded card — the audit trail behind the
 *  final call. */
function VerifyChecklist({ v }: { v: SignalVerification }) {
  const list = v.checklist || [];
  if (list.length === 0) return null;
  const stBg = (s: string) => s === 'PASS' ? 'bg-emerald-500/15 border-emerald-500/30' : s === 'FAIL' ? 'bg-rose-500/15 border-rose-500/30' : 'bg-amber-500/15 border-amber-500/30';
  return (
    <div className="mt-2 rounded-xl border border-cyan-500/25 bg-cyan-500/[0.04] p-3 space-y-1.5">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[10px] font-black text-cyan-300 tracking-wider">🛡 SIGNAL VERIFICATION AGENT — 10-POINT PRO CHECKLIST</span>
        <span className="text-[10px] font-mono font-black text-slate-200">{v.score}/100</span>
      </div>
      {v.proNote && <div className="text-[10px] text-slate-300/90 leading-relaxed border-l-2 border-cyan-500/40 pl-2">{v.proNote}</div>}
      {v.llm && (
        <div className={`flex items-center gap-2 rounded-lg border px-2 py-1.5 text-[10px] font-mono ${v.llm.verdict === 'CONFIRM' ? 'bg-violet-500/10 border-violet-500/30' : v.llm.verdict === 'FLIP' ? 'bg-rose-500/10 border-rose-500/30' : 'bg-slate-500/10 border-slate-500/30'}`}>
          <span className="font-black text-violet-300 shrink-0">🤖 LLM SECOND OPINION</span>
          <span className={`font-black shrink-0 ${v.llm.verdict === 'CONFIRM' ? 'text-emerald-300' : v.llm.verdict === 'FLIP' ? 'text-rose-300' : 'text-amber-300'}`}>{v.llm.verdict} {v.llm.confidence}%</span>
          <span className="text-slate-400 truncate flex-1" title={v.llm.reason}>{v.llm.reason}</span>
          <span className="text-slate-500 shrink-0" title="provider chain: Gemini → Groq → Cerebras → OpenRouter">{v.llm.model || 'chain'}</span>
        </div>
      )}
      <div className="grid gap-1">
        {list.map(c => (
          <div key={c.id} className="flex items-center gap-2 text-[10px] font-mono">
            <span className={`px-1.5 py-0.5 rounded border font-black w-12 text-center ${stBg(c.status)}`}>{c.status}</span>
            <span className="text-slate-300 w-36 shrink-0 truncate" title={c.name}>{c.name}</span>
            <span className="text-slate-500 w-12 shrink-0">{c.points}/{c.weight}pt</span>
            <span className="text-slate-400 truncate flex-1" title={c.detail}>{c.detail}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

/** v9 SUPERINTELLIGENCE BLUEPRINT STRIP — the complete pro-trader
 *  ticket in one row: entry window (timing), leverage (liquidation-aware
 *  ladder), staged exit plan (40/40/20) and the EXIT CLOCK. This is the
 *  "kab entry · kitna leverage · kab exit" answer on every card.
 *  v12.0: + the WIN-PROBABILITY row (calibrated P(win) vs the R:R
 *  breakeven + EV in R + EDGE verdict) and, on perps, the positioning
 *  intel chips (funding / OI build / taker aggression). */
function SuperIntelStrip({ signal, si }: { signal: AISignal; si: SuperIntel }) {
  const bp = si.blueprint;
  const wp = si.winProb ?? null;
  const perp = si.perp ?? null;
  if (!bp && !wp && !perp) return null;
  // v10.5.3: currency-tag aware (was FUTURES-only — global cards printed ₹)
  const cur = curFor(signal.market);
  const px = (v: number | null | undefined) =>
    v == null || !Number.isFinite(v) ? '—'
      : cur === 'inr' ? `₹${v.toLocaleString('en-IN', { maximumFractionDigits: Math.abs(v) < 1 ? 6 : 2 })}`
        : cur === 'usdc' ? `USDC ${v.toLocaleString('en-US', { maximumFractionDigits: 4 })}`
          : `${v.toLocaleString('en-US', { maximumFractionDigits: 4 })} USDT`;
  const zone = bp?.entryZone && bp.entryZone[0] != null && bp.entryZone[1] != null ? `${px(bp.entryZone[0])}–${px(bp.entryZone[1])}` : '—';
  const t = bp?.targets ?? { t1: null, t2: null, t3: null };
  const verdictCls = wp?.verdict === 'EDGE'
    ? 'bg-emerald-500/15 text-emerald-300 border border-emerald-500/40'
    : wp?.verdict === 'FAIR'
      ? 'bg-amber-500/15 text-amber-300 border border-amber-500/40'
      : 'bg-red-500/15 text-red-300 border border-red-500/40';
  const fmtR = (v: number | null | undefined) => (v == null || !Number.isFinite(v) ? '—' : `${v > 0 ? '+' : ''}${v.toFixed(2)}R`);
  return (
    <div className="mt-2.5 rounded-xl border border-cyan-500/15 bg-gradient-to-r from-cyan-500/[0.05] via-transparent to-violet-500/[0.05] p-2.5">
      {/* header: tier badge + drivers */}
      <div className="flex items-center gap-2 flex-wrap">
        {bp && <span className={`px-2 py-0.5 rounded-md text-[10px] font-black tracking-wider ${superTierBadge(si.tier).cls}`}>{superTierBadge(si.tier).label}</span>}
        {si.drivers.slice(0, 3).map((d, i) => (
          <span key={i} className="text-[9px] text-slate-500 font-semibold" title={d}>· {d}</span>
        ))}
      </div>
      {/* the four pro-trader answers */}
      {bp && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-1.5 mt-2">
          <div className="bg-black/30 rounded-lg px-2 py-1.5" title={bp.entryTiming?.note || ''}>
            <div className="text-[8px] text-slate-500 font-black tracking-wider">⏱ ENTRY WINDOW</div>
            <div className={`text-[11px] font-mono font-bold ${bp.entryTiming?.mode === 'IMMEDIATE' ? 'text-emerald-300' : 'text-amber-300'}`}>
              {bp.entryTiming?.mode || '—'} · {zone}
            </div>
            {/* v18.6.1 Fix 5 — PULLBACK semantics, EXPLICIT: a recovering
                (green) candle run on a SHORT-pullback plan is NOT a
                reversal against the signal — that bounce IS the entry
                trigger (sell into the rally). One line prevents the exact
                misread from the board-review case. */}
            {bp.entryTiming?.mode === 'PULLBACK' && (
              <p data-testid="pullback-entry-note" className="text-[9px] text-amber-300/80 mt-0.5 leading-snug">
                ⓘ Ye {signal.side === 'LONG' ? 'dip' : 'bounce'} hi entry trigger hai — {signal.side === 'LONG' ? 'dip BUY' : 'rally SELL'} karna hai · SL {px(signal.plan?.stopLoss ?? null)} break hone tak thesis intact
              </p>
            )}
          </div>
          <div className="bg-black/30 rounded-lg px-2 py-1.5" title={bp.leverageNote}>
            <div className="text-[8px] text-slate-500 font-black tracking-wider">⚡ LEVERAGE</div>
            <div className="text-[11px] font-mono font-bold text-violet-300">
              {bp.leverage}×{bp.liquidation != null ? ` · liq ${px(bp.liquidation)}` : ''}
            </div>
          </div>
          <div className="bg-black/30 rounded-lg px-2 py-1.5" title={(bp.exitPlan || []).map(e => e.action).join(' · ')}>
            <div className="text-[8px] text-slate-500 font-black tracking-wider">🎯 EXIT PLAN</div>
            <div className="text-[11px] font-mono font-bold text-emerald-300">
              40% {px(t.t1)} · 40% {px(t.t2)} · 20% {px(t.t3)}
            </div>
          </div>
          <div className="bg-black/30 rounded-lg px-2 py-1.5" title={bp.horizon?.note || ''}>
            <div className="text-[8px] text-slate-500 font-black tracking-wider">⏰ EXIT BY</div>
            <div className="text-[11px] font-mono font-bold text-amber-300">
              {bp.exitBy} · {bp.horizon?.label || ''}
            </div>
          </div>
        </div>
      )}
      {/* v12.0 WIN PROBABILITY — the "kitni probability hai" answer:
          calibrated P(win) vs the R:R breakeven + EV in R + the verdict */}
      {wp && (
        <div className="mt-2 grid grid-cols-2 sm:grid-cols-4 gap-1.5" title={(wp.drivers || []).join('\n')}>
          <div className="bg-gradient-to-r from-emerald-500/10 to-cyan-500/10 rounded-lg px-2 py-1.5 border border-emerald-500/20">
            <div className="text-[8px] text-slate-400 font-black tracking-wider">
              🎯 P(WIN){wp.calibrated ? ' · LEDGER-CALIBRATED' : ' · UNCALIBRATED'}
            </div>
            <div className="text-[11px] font-mono font-black text-emerald-300">
              {wp.pWin}% <span className="text-[9px] font-bold text-slate-500 font-sans">({wp.pWinBand[0]}–{wp.pWinBand[1]}%)</span>
            </div>
          </div>
          <div className="bg-black/30 rounded-lg px-2 py-1.5" title="P(need) = 1/(1+R:R) — isi win-rate se trade breakeven hota hai">
            <div className="text-[8px] text-slate-500 font-black tracking-wider">⚖ BREAKEVEN</div>
            <div className={`text-[11px] font-mono font-black ${wp.edgePts > 0 ? 'text-emerald-300' : 'text-red-300'}`}>
              {wp.pNeed}% <span className="text-[9px] font-bold text-slate-500">need · edge {wp.edgePts > 0 ? '+' : ''}{wp.edgePts}pts</span>
            </div>
          </div>
          <div className="bg-black/30 rounded-lg px-2 py-1.5" title={`Full-book EV ${fmtR(wp.evR)} · realistic (40/40/20 partial capture) ${fmtR(wp.evRealisticR)}`}>
            <div className="text-[8px] text-slate-500 font-black tracking-wider">📈 EXPECTED VALUE</div>
            <div className={`text-[11px] font-mono font-black ${wp.evRealisticR > 0 ? 'text-emerald-300' : 'text-red-300'}`}>
              {fmtR(wp.evRealisticR)} <span className="text-[9px] font-bold text-slate-500">/ trade</span>
            </div>
          </div>
          <div className={`rounded-lg px-2 py-1.5 ${verdictCls}`} title={wp.note}>
            <div className="text-[8px] font-black tracking-wider opacity-80">🧠 EDGE VERDICT</div>
            <div className="text-[11px] font-black tracking-wide">
              {wp.verdict === 'EDGE' ? '✅ EDGE — take with size' : wp.verdict === 'FAIR' ? '⚖ FAIR — half size' : '⛔ NO EDGE — skip'}
            </div>
          </div>
        </div>
      )}
      {/* v12.0 PERP POSITIONING — funding/OI/taker/crowding chips (FUTURES) */}
      {perp?.read && (
        <div className="mt-1.5 flex items-center gap-1.5 flex-wrap text-[9px] font-mono">
          <span className={`px-1.5 py-0.5 rounded border font-black tracking-wider ${perp.read.bias === 'BULLISH' ? 'bg-emerald-500/10 text-emerald-300 border-emerald-500/30' : perp.read.bias === 'BEARISH' ? 'bg-red-500/10 text-red-300 border-red-500/30' : 'bg-slate-600/20 text-slate-400 border-slate-600/30'}`}
            title={(perp.read.reasons || []).join('\n')}>
            {perp.read.label}{perp.read.matrix ? ` · ${perp.read.matrix === 'LONGS_BUILDING' ? 'OI↑P↑ NEW LONGS' : perp.read.matrix === 'SHORTS_BUILDING' ? 'OI↑P↓ NEW SHORTS' : perp.read.matrix === 'SHORT_SQUEEZE' ? 'OI↓P↑ SQUEEZE' : perp.read.matrix === 'LONG_UNWIND' ? 'OI↓P↓ UNWIND' : 'FLAT'}` : ''}
          </span>
          {perp.fundingBps8h != null && (
            <span className={`px-1.5 py-0.5 rounded border font-bold ${perp.fundingBps8h > 10 ? 'bg-red-500/10 text-red-300 border-red-500/30' : perp.fundingBps8h < -3 ? 'bg-emerald-500/10 text-emerald-300 border-emerald-500/30' : 'bg-slate-600/20 text-slate-400 border-slate-600/30'}`}
              title="8h funding (Binance fapi reference). Positive = longs pay shorts.">
              FUNDING {perp.fundingBps8h > 0 ? '+' : ''}{perp.fundingBps8h}bps/8h
            </span>
          )}
          {perp.oiChangePct24h != null && (
            <span className={`px-1.5 py-0.5 rounded border font-bold ${perp.oiChangePct24h > 1.5 ? 'bg-cyan-500/10 text-cyan-300 border-cyan-500/30' : perp.oiChangePct24h < -1.5 ? 'bg-amber-500/10 text-amber-300 border-amber-500/30' : 'bg-slate-600/20 text-slate-400 border-slate-600/30'}`}
              title="Open interest 24h change — naya paisa aa raha hai ya nikal raha hai">
              OI 24h {perp.oiChangePct24h > 0 ? '+' : ''}{perp.oiChangePct24h}%
            </span>
          )}
          {perp.takerRatio24h != null && (
            <span className={`px-1.5 py-0.5 rounded border font-bold ${perp.takerRatio24h >= 1.03 ? 'bg-emerald-500/10 text-emerald-300 border-emerald-500/30' : perp.takerRatio24h <= 0.97 ? 'bg-red-500/10 text-red-300 border-red-500/30' : 'bg-slate-600/20 text-slate-400 border-slate-600/30'}`}
              title="Taker buy/sell ratio 24h — aggressive flow ka side">
              TAKER {perp.takerRatio24h}×
            </span>
          )}
          {(perp.read.crowdedLongs || perp.read.crowdedShorts) && (
            <span className="px-1.5 py-0.5 rounded border font-black bg-amber-500/15 text-amber-300 border-amber-500/40 animate-pulse"
              title="Crowded side — ek opposite print par squeeze possible hai">
              🚩 {perp.read.crowdedLongs ? 'LONGS CROWDED' : 'SHORTS CROWDED'}
            </span>
          )}
        </div>
      )}
      {bp && (
        <div className="mt-1.5 text-[9px] text-slate-500 font-semibold leading-relaxed">
          🛑 {bp.invalidation}
        </div>
      )}
    </div>
  );
}

/** v6.12 PRO TRADER BRAIN — one honest chips row: quorum, MTF, regime,
 *  extension veto, session gate, stop style. The WHY behind the grade. */
function QualityChips({ quality, voters, total, stopFloored }: { quality: NonNullable<AISignal['quality']>; voters: number | null | undefined; total: number; stopFloored?: boolean }) {
  const chips: Array<{ label: string; cls: string; title: string }> = [];
  const v = voters ?? 0;
  // quorum
  chips.push(v <= 1
    ? { label: `⚠ QUORUM ${v}/${total}`, cls: 'bg-red-500/10 text-red-300 border-red-500/30', title: `sirf ${v} model vote kar raha hai — single-factor, consensus NAHI` }
    : v === 2
      ? { label: `QUORUM ${v}/${total} weak`, cls: 'bg-amber-500/10 text-amber-300 border-amber-500/30', title: 'sirf 2 models voting — weak quorum' }
      : { label: `QUORUM ${v}/${total}`, cls: 'bg-emerald-500/10 text-emerald-300 border-emerald-500/30', title: `${v} models ne directional vote diya` });
  // MTF
  const mtf = quality.mtf;
  if (mtf?.available) {
    if (mtf.phase === 'ALIGNED') chips.push({ label: `MTF ✓ (${mtf.phase === 'ALIGNED' ? 'HTF+LTF' : mtf.phase})`, cls: 'bg-emerald-500/10 text-emerald-300 border-emerald-500/30', title: 'daily trend + intraday dono align — continuation entry OK' });
    else if (mtf.phase === 'COUNTER_HTF') chips.push({ label: 'MTF ⚠ COUNTER', cls: 'bg-red-500/10 text-red-300 border-red-500/30', title: 'daily trend ke AGAINST — counter-trend, sirf strong reversal pe' });
    else if (mtf.phase === 'MISALIGNED') {
      // v9.3: the exact "wrong trend" screenshot case — daily committee
      // said SHORT but the 15m tape was rising. Show it LOUD, not as a
      // generic amber MTF conflict.
      const ct = quality.counterTape;
      chips.push(ct?.strong
        ? { label: '🛑 COUNTER-TAPE (15m against)', cls: 'bg-red-500/15 text-red-300 border-red-500/40', title: '15m tape momentum trade ke against DRIVE kar raha hai — STRONG/ACTION banned, tape roll hone do (sirf WATCH)' }
        : { label: '⚠ COUNTER-TAPE (15m)', cls: 'bg-amber-500/10 text-amber-300 border-amber-500/30', title: '15m tape against hai par stall ho raha — STRONG banned, ACTION max (reversal practice only)' });
    }
    else chips.push({ label: `MTF ⚠ ${mtf.phase}`, cls: 'bg-amber-500/10 text-amber-300 border-amber-500/30', title: 'timeframes conflict — timing risk' });
  } else {
    chips.push({ label: 'MTF n/a', cls: 'bg-slate-600/20 text-slate-400 border-slate-600/30', title: 'LTF candles unavailable — MTF check skip (honest)' });
  }
  // regime
  const rg = quality.regime;
  if (rg?.aligned === true) chips.push({ label: 'REGIME ✓', cls: 'bg-emerald-500/10 text-emerald-300 border-emerald-500/30', title: 'market regime trade ke sapt hai' });
  else if (rg?.aligned === false) chips.push({ label: `REGIME ⚠ against${rg.penaltyPct ? ` −${rg.penaltyPct}%` : ''}`, cls: 'bg-red-500/10 text-red-300 border-red-500/30', title: 'BTC/NIFTY regime ke against trade — penalty laga hai' });
  // extension veto
  if (quality.extension?.veto) chips.push({ label: '🚫 EXTENSION VETO', cls: 'bg-red-500/15 text-red-300 border-red-500/40', title: 'move already extended / RSI exhaustion — chase mat karo' });
  else if (quality.extension?.downgrade) chips.push({ label: 'EXT ⚠ extended', cls: 'bg-amber-500/10 text-amber-300 border-amber-500/30', title: 'entry thodi extended hai' });
  // v21.4.1: v21.3.0 ke HARD-VETO stamps — backend pehle se bhejta tha par
  // board pe kabhi render nahi hote the (card WATCH + score ≤62 bina kisi
  // explanation ke dikhta tha). Expert picks panel me ≈ CHOP chip hai — ab
  // board bhi wahi honesty dikhata hai.
  if (quality.counterHtfVeto) chips.push({ label: '⛔ HTF VETO (1d/4h against)', cls: 'bg-red-500/15 text-red-300 border-red-500/40', title: 'Daily/4H consensus is signal ke AGAINST — hard veto: WATCH cap + AI score ≤62, TOP-5/LIVE se bahar' });
  if (quality.chopRange) chips.push({ label: '≈ CHOP (range)', cls: 'bg-amber-500/15 text-amber-300 border-amber-500/40', title: '6-TF SPLIT ya ADX<15 — range-bound, 2R target structurally unreachable. WATCH cap + score ≤62' });
  // v21.4.1: sub-noise stop floor — SL 0.6×ATR minimum tak floor hua tha
  // (v21.3.0 accuracy fix ka UI promise, ab poora).
  if (stopFloored) chips.push({ label: '🔒 SL FLOORED', cls: 'bg-cyan-500/10 text-cyan-300 border-cyan-500/30', title: 'structure stop sub-noise (0.6×ATR) se neeche tha — SL floor tak utha hua hai taki random wick SL na uda de' });
  // session (India only)
  const ses = quality.session;
  if (ses && !ses.tradeable) chips.push({ label: `⏰ ${ses.phase}`, cls: 'bg-amber-500/10 text-amber-300 border-amber-500/30', title: 'abhi fresh entry ka window nahi (opening noise / square-off / closed)' });
  // structure stop
  if (quality.stopStyle) chips.push({ label: `🔒 ${quality.stopStyle === 'swing-structure' ? 'SWING SL' : 'ATR SL'}`, cls: 'bg-cyan-500/10 text-cyan-300 border-cyan-500/30', title: quality.stopStyle === 'swing-structure' ? 'SL last swing level ke piche — structure-aware, noise pad ke saath' : 'ATR-based stop' });
  return (
    <div className="flex flex-wrap gap-1.5 mt-2">
      {chips.map((c, i) => (
        <span key={i} className={`px-1.5 py-0.5 rounded text-[9px] font-black border tracking-wide ${c.cls}`} title={c.title}>{c.label}</span>
      ))}
      {(quality.reasons || []).length > 0 && (
        <span className="px-1.5 py-0.5 rounded text-[9px] font-black border tracking-wide bg-slate-600/20 text-slate-300 border-slate-600/30" title={(quality.reasons || []).join('\n')}>⋯ {quality.reasons?.length} reasons</span>
      )}
    </div>
  );
}

function VoteChip({ vote }: { vote: AISignal['votes'][number] }) {
  const dir = vote.dir > 0 ? 'BULL' : vote.dir < 0 ? 'BEAR' : 'FLAT';
  const cls = vote.dir > 0
    ? 'bg-emerald-500/10 text-emerald-300 border-emerald-500/25'
    : vote.dir < 0
      ? 'bg-red-500/10 text-red-300 border-red-500/25'
      : 'bg-slate-600/20 text-slate-400 border-slate-600/30';
  return (
    <div className={`px-2 py-1 rounded-lg border text-[10px] font-bold ${cls} flex items-center gap-1.5`} title={vote.role}>
      <span className="font-mono">{vote.name.split(' ')[0]}</span>
      <span className="opacity-60">w{vote.weight}</span>
      <span className="font-mono">{dir === 'FLAT' ? '·' : dir === 'BULL' ? '▲' : '▼'}{vote.conf || '—'}</span>
    </div>
  );
}

// ---------------- v6.4: INDIA TRADE SLIP ----------------
const RISK_KEY = 'ai-india-risk-inr';
const loadRiskBudget = (): number => {
  try {
    const v = Number(localStorage.getItem(RISK_KEY));
    return Number.isFinite(v) && v >= 50 && v <= 1_000_000 ? v : 500;
  } catch { return 500; }
};

function IndiaTradeSlip({ signal }: { signal: AISignal }) {
  const plan = signal.plan!;
  const long = signal.side === 'LONG';
  // v7.0.1: free-typing risk input (raw string) — same fix as the trade
  // ticket: the old Math.max(50, …) on every keystroke made the box
  // impossible to clear/edit. Clamp now happens on blur only.
  const [budgetRaw, setBudgetRaw] = useState<string>(String(loadRiskBudget()));
  const [copied, setCopied] = useState(false);
  // v10.18 (deep-recheck #3): timer-ref copied chip (stale timer wiped a
  // newer copy flash early).
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (copiedTimer.current) clearTimeout(copiedTimer.current); }, []);
  const budgetNum = Number(budgetRaw);
  const typedOk = budgetRaw.trim() !== '' && Number.isFinite(budgetNum);
  const budget = typedOk ? budgetNum : 0;

  const stopDist = Math.abs(plan.entry - plan.stopLoss);
  const t1Dist = Math.abs(plan.target1 - plan.entry);
  const t2Dist = Math.abs(plan.target2 - plan.entry);
  const qty = stopDist > 0 ? Math.floor(budget / stopDist) : 0;
  const capital = qty * plan.entry;
  const actualRisk = qty * stopDist;
  const profitT1 = qty * t1Dist;
  const profitT2 = qty * t2Dist;
  const bandLo = plan.entry * 0.9985, bandHi = plan.entry * 1.0015;

  const onBudget = (v: string) => {
    setBudgetRaw(v);
    const n = Number(v);
    if (v.trim() !== '' && Number.isFinite(n) && n >= 50 && n <= 1_000_000) {
      try { localStorage.setItem(RISK_KEY, String(Math.round(n))); } catch { /* private mode */ }
    }
  };
  const onBudgetBlur = () => {
    const n = Math.max(50, Math.min(1_000_000, Math.round(Number(budgetRaw) || 0)));
    setBudgetRaw(String(n));
    try { localStorage.setItem(RISK_KEY, String(n)); } catch { /* private mode */ }
  };
  const pickRisk = (n: number) => { setBudgetRaw(String(n)); try { localStorage.setItem(RISK_KEY, String(n)); } catch { /* private mode */ } };

  const slipText = [
    `🇮🇳 NSE TRADE SLIP — ${signal.symbol} (${signal.side})`,
    `Signal: ${signal.grade} ${signal.confidence}% conf · ${signal.totalModels}-model ensemble · ${Math.round((signal.agreement || 0) * 100)}% agreement`,
    `── ORDER ──`,
    `${long ? 'BUY' : 'SELL'} ${qty} qty @ ₹${plan.entry.toFixed(2)} (limit band ₹${bandLo.toFixed(2)}–₹${bandHi.toFixed(2)})`,
    `Stop-loss: SL-M trigger ₹${plan.stopLoss.toFixed(2)} (risk ${fmt(actualRisk)} · ${plan.riskPct?.toFixed(2)}%)`,
    `Target 1: ₹${plan.target1.toFixed(2)} → ${profitT1 >= 0 ? '+' : ''}${fmt(profitT1)}`,
    `Target 2: ₹${plan.target2.toFixed(2)} → ${profitT2 >= 0 ? '+' : ''}${fmt(profitT2)}`,
    `Capital needed: ~${fmt(capital)} · risk budget ${fmt(budget)}`,
    `── RULES ──`,
    `• Intraday: square-off by 15:15 IST (bracket/cover order at broker)`,
    `• Entry window 09:30–14:30 — avoid 09:15–09:30 opening chop`,
    `• SL is non-negotiable: trigger hit = exit at market`,
    `• Book 50% at T1, trail rest to T2 / cost-to-cost`,
    `Generated by SmartAI ensemble · verify levels on your broker terminal before placing`,
  ].join('\n');

  const copy = useCallback(() => {
    navigator.clipboard?.writeText(slipText).then(() => {
      setCopied(true);
      if (copiedTimer.current) clearTimeout(copiedTimer.current);
      copiedTimer.current = setTimeout(() => setCopied(false), 2500);
    }).catch(() => { /* clipboard blocked */ });
  }, [slipText]);

  const enough = qty >= 1;

  return (
    <div className="mt-2.5 rounded-xl border border-orange-500/25 bg-gradient-to-b from-orange-500/[0.07] to-transparent p-3" aria-label="India trade slip">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-[10px] font-black text-orange-300 tracking-wider">📋 TRADE SLIP — MANUAL BROKER FLOW (NSE)</span>
        <span className="text-[9px] text-slate-500">sizing = risk ₹ ÷ stop distance</span>
        <label className="ml-auto flex items-center gap-1.5 text-[9px] font-black text-slate-500 tracking-wider">
          RISK / TRADE
          <input
            type="number" min={50} max={1000000} step={50}
            value={budgetRaw} onChange={e => onBudget(e.target.value)} onBlur={onBudgetBlur}
            placeholder="₹"
            className="quantum-input px-2 py-1 rounded-lg text-[11px] font-mono font-bold text-orange-200 w-24"
            aria-label="risk per trade in rupees — apna amount type karo" />
        </label>
      </div>

      {/* v7.0.1 quick-risk chips */}
      <div className="flex items-center gap-1 flex-wrap mt-1.5" role="group" aria-label="quick risk presets">
        <span className="text-[8px] font-black text-slate-600 tracking-wider">QUICK:</span>
        {[200, 500, 1000, 2000].map(a => (
          <button key={a} onClick={() => pickRisk(a)}
            title={`Risk ₹${a.toLocaleString('en-IN')} per trade`}
            className={`px-2 py-0.5 rounded-lg text-[10px] font-black font-mono border transition-colors ${typedOk && budgetNum === a
              ? 'bg-orange-500/25 text-orange-200 border-orange-400/60'
              : 'bg-black/30 text-slate-400 border-slate-600/40 hover:bg-orange-500/10'}`}>
            ₹{a >= 1000 ? `${a / 1000}k` : a}
          </button>
        ))}
      </div>

      {enough ? (
        <>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-1.5 mt-2">
            {[
              { l: 'QTY (risk-sized)', v: `${qty} shares`, c: 'text-orange-300' },
              { l: 'CAPITAL NEEDED', v: fmt(capital), c: 'text-cyan-300' },
              { l: '₹ AT RISK (SL)', v: fmt(actualRisk), c: 'text-red-300' },
              { l: 'PROFIT @ T1', v: `+${fmt(profitT1)}`, c: 'text-emerald-300' },
              { l: 'PROFIT @ T2', v: `+${fmt(profitT2)}`, c: 'text-emerald-400' },
              { l: 'LIMIT BAND', v: `₹${bandLo.toFixed(0)}–${bandHi.toFixed(0)}`, c: 'text-slate-300' },
            ].map(x => (
              <div key={x.l} className="bg-black/30 rounded-lg px-2 py-1.5 text-center">
                <div className="text-[8px] text-slate-500 font-black tracking-wider">{x.l}</div>
                <div className={`text-xs font-mono font-bold ${x.c}`}>{x.v}</div>
              </div>
            ))}
          </div>
          <div className="mt-2 text-[10px] text-slate-400 leading-relaxed bg-black/20 rounded-lg px-2.5 py-2">
            <span className="font-black text-slate-300">Order placement (Zerodha/Upstox/Angel sab par yahi):</span>{' '}
            ① <b>{long ? 'BUY' : 'SELL'} {qty}</b> · LIMIT @ <b>₹{plan.entry.toFixed(2)}</b> (band ₹{bandLo.toFixed(2)}–₹{bandHi.toFixed(2)}) →{' '}
            ② SL-M/bracket trigger <b className="text-red-300">₹{plan.stopLoss.toFixed(2)}</b> →{' '}
            ③ targets <b className="text-emerald-300">₹{plan.target1.toFixed(2)}</b> / <b className="text-emerald-300">₹{plan.target2.toFixed(2)}</b> →{' '}
            ④ intraday square-off <b>15:15 IST</b> tak khud.
          </div>
          <button onClick={copy}
            className={`mt-2 px-3 py-1.5 rounded-lg text-[10px] font-black border transition-colors ${copied
              ? 'bg-emerald-500/15 text-emerald-300 border-emerald-500/40'
              : 'bg-orange-500/10 text-orange-300 border-orange-500/30 hover:bg-orange-500/20'}`}>
            {copied ? '✓ SLIP COPIED — broker terminal me paste karo' : '📋 COPY FULL ORDER SLIP'}
          </button>
        </>
      ) : (
        <div className="mt-2 text-[10px] text-amber-300/90 font-bold bg-amber-500/5 border border-amber-500/20 rounded-lg px-2.5 py-2">
          ⚠️ Risk budget {fmt(budget)} is too small for this stop (₹{stopDist.toFixed(2)}/share) — even 1 share risks more than the budget.
          Either raise RISK/TRADE, pick a tighter-stop signal, or trade this via the Options Desk (smaller ticket).
        </div>
      )}
    </div>
  );
}

// ---------------- v6.4: CRYPTO ORDER PREVIEW ----------------
function CryptoOrderPreview({ signal, budgetINR }: { signal: AISignal; budgetINR?: number }) {
  const plan = signal.plan;
  if (!plan || !(plan.entry > 0) || !budgetINR || !(budgetINR >= 100)) return null;
  const stopDist = Math.abs(plan.entry - plan.stopLoss);
  const t2Dist = Math.abs(plan.target2 - plan.entry);
  const qty = budgetINR / plan.entry;
  const riskINR = qty * stopDist;
  const rewardT2 = qty * t2Dist;
  const rr = riskINR > 0 ? rewardT2 / riskINR : 0;
  return (
    <div className="mt-2 flex items-center gap-2 flex-wrap text-[10px] font-mono font-bold" aria-label="order preview">
      <span className="text-slate-500 tracking-wider">ORDER PREVIEW</span>
      <span className="px-1.5 py-0.5 rounded bg-black/30 text-cyan-300">budget {fmt(budgetINR, 0)}</span>
      <span className="px-1.5 py-0.5 rounded bg-black/30 text-slate-300">≈ {qty < 1 ? qty.toFixed(6) : qty.toFixed(4)} units</span>
      <span className="px-1.5 py-0.5 rounded bg-red-500/10 text-red-300">risk @SL −{fmt(riskINR, 0)}</span>
      <span className="px-1.5 py-0.5 rounded bg-emerald-500/10 text-emerald-300">T2 +{fmt(rewardT2, 0)}</span>
      <span className="px-1.5 py-0.5 rounded bg-black/30 text-amber-300">R:R 1:{rr.toFixed(1)}</span>
      <span className="text-slate-600">(budget = Max order ₹ setting)</span>
    </div>
  );
}

// ---------------- v6.6: THE SIMPLE TRADE TICKET ----------------
// One screen. Everything pre-computed. One click.
// The math MIRRORS the server execute path so the preview IS the fill:
//   crypto:  qty = (margin ₹ × leverage) / entry
//   futures: qty = (margin USDT × leverage) / entry  (v6.8 — wallet USDT)
//   india:   qty = floor(budget / price)             [whole shares]
type ExecHandler = (signal: AISignal, mode: 'paper' | 'live' | 'notify', opts?: { qtyINR?: number; marginUSDT?: number; leverage?: number }) => Promise<{ ok?: boolean; error?: string; note?: string } | void> | void;

interface TicketProps {
  signal: AISignal;
  busy?: boolean;
  /** v18.6.4: the STALE-paper gate from the parent card — the ticket's
   *  PAPER button used to bypass it (v18.6.1 Fix 3b sidestepped via
   *  the 🚀 TRADE ticket). */
  gatePaper?: (act: () => void) => void;
  onExecute?: ExecHandler;          // crypto gauntlet
  onExecuteIndia?: ExecHandler;     // india gauntlet
  onExecuteFutures?: ExecHandler;   // global-futures gauntlet (v6.8)
  onExecuteGlobal?: ExecHandler;    // GLOBAL equity-futures SIM gauntlet (v10.4)
  canLive?: boolean;
  canLiveIndia?: boolean;
  /** v6.6: server config cryptoLeverage (the hard ceiling) */
  maxLeverage?: number;
  /** default margin (crypto) / capital budget (india) from server config */
  defaultBudgetINR?: number;
  /** v7.0.1: server per-order cap (crypto maxOrderINR / india indiaMaxOrderINR)
   *  — the preview stays an honest twin of the fill even when the user
   *  types a bigger amount. Futures are wallet-limited (no cap). */
  serverCapINR?: number;
}

function SimpleTradeTicket({ signal, busy, gatePaper, onExecute, onExecuteIndia, onExecuteFutures, onExecuteGlobal, canLive, canLiveIndia, maxLeverage = 1, defaultBudgetINR = 1000, serverCapINR }: TicketProps) {
  const plan = signal.plan!;
  const crypto = signal.market === 'CRYPTO';
  const futures = signal.market === 'FUTURES';
  const global = signal.market === 'GLOBALFUTURES'; // v10.4 SIM desk (v10.7: USDC margin domain — CoinDCX app parity)
  // v10.5.3: one shared currency decision for every price/amount label in
  // the ticket — the old `futures ?` checks let the global SIM desk fall
  // through to the ₹ branch in a dozen places.
  const cur: CurrencyTag = global ? 'usdc' : futures ? 'usdt' : 'inr';
  const unit = global ? 'USDC' : 'USDT';       // display unit (global USDC ≠ crypto USDT!)
  const usdDenominated = futures || global;    // shared boolean per the fix plan
  const leveraged = crypto || futures || global; // v6.8/v10.4: futures + SIM desk are natively leveraged
  const india = signal.market === 'INDIA';
  const long = signal.side === 'LONG';
  const cap = Math.max(1, Math.min(10, Math.floor(maxLeverage || 1)));

  // futures ticket works in the WALLET's own unit (USDT margin); the
  // others in ₹. Server re-derives everything — this is a preview twin.
  // v7.0.1 BUDGET BOX FIX: the input is now FREE-TYPING (raw string).
  // The old code clamped to ≥100 on EVERY keystroke — the box could
  // never be cleared or edited freely ("100 clear hi nahi hota").
  // Validation now happens on blur + execute only.
  const lo = futures ? 2 : global ? 2 : 100;
  const defaultMargin = Math.max(futures || global ? 5 : 100, Math.round(defaultBudgetINR));
  const [marginRaw, setMarginRaw] = useState<string>(String(defaultMargin));
  const [lev, setLev] = useState<number>(futures || global ? 3 : 1);
  const [result, setResult] = useState<{ ok: boolean; text: string; pending?: boolean } | null>(null);
  // v10.18 (deep-recheck #3): timer-ref result banner — a pending→verdict
  // sequence and rapid retries used to let an older timer clear the
  // newer verdict early (the 8s banner vanished mid-read).
  const resultTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const armResultTimer = () => {
    if (resultTimer.current) clearTimeout(resultTimer.current);
    resultTimer.current = setTimeout(() => setResult(null), 8000);
  };
  useEffect(() => () => { if (resultTimer.current) clearTimeout(resultTimer.current); }, []);

  // v20.7.8 [M-5]: malformed plan guard — CryptoOrderPreview already bails on
  // !(plan.entry > 0), the ticket didn't. entry 0/null → QTY Infinity,
  // slDistPct NaN → maxSane NaN → `l > NaN` always false → EVERY leverage
  // chip stayed enabled with the max-sane warning dead. Placed AFTER the
  // hooks (early-return above them would break the Rules of Hooks when a
  // live refresh swaps a good plan for a malformed one).
  if (!(plan.entry > 0)) return (
    <div className="mt-2 text-[10px] font-mono font-bold text-amber-400/90 bg-amber-500/5 border border-amber-500/20 rounded-lg px-2 py-1.5">
      ⚠️ Plan math unavailable (entry price missing) — ticket disabled for safety
    </div>
  );

  const marginNum = Number(marginRaw);
  const typedValid = marginRaw.trim() !== '' && Number.isFinite(marginNum);
  // honest twin: server clamps crypto/india orders to the per-order cap
  // (Risk settings) — preview shows the fill you will actually get.
  const orderCap = !futures && !global && serverCapINR && serverCapINR > 0 ? serverCapINR : null;
  const margin = typedValid ? (orderCap != null ? Math.min(marginNum, orderCap) : marginNum) : 0;
  const overCapTyped = typedValid && orderCap != null && marginNum > orderCap;
  const belowMin = typedValid && marginNum < lo;
  const invalid = !typedValid || belowMin;

  const clampMargin = (v: string | number): number => {
    const n = Math.round((Number(v) || 0) * 100) / 100;
    let c = Math.max(lo, Math.min(1_000_000, n));
    if (orderCap != null && c > orderCap) c = Math.min(orderCap, Math.max(lo, orderCap));
    return c;
  };
  const onMargin = (v: string) => { setMarginRaw(v); setResult(null); };
  const onMarginBlur = () => {
    if (!typedValid) { setMarginRaw(String(defaultMargin)); setResult(null); return; }
    const n = clampMargin(marginRaw);
    if (String(n) !== marginRaw.trim()) setMarginRaw(String(n));
  };
  const pickAmount = (n: number) => { setMarginRaw(String(n)); setResult(null); };

  // --- math (mirror of the server execute paths) ---
  const notional = leveraged ? margin * lev : margin;
  const qtyRaw = leveraged ? notional / plan.entry : margin / plan.entry;
  const qty = leveraged ? Math.round(qtyRaw * 1e6) / 1e6 : Math.floor(qtyRaw); // india: whole shares (server)
  const stopDist = Math.abs(plan.entry - plan.stopLoss);
  const t1Dist = Math.abs(plan.target1 - plan.entry);
  const t2Dist = Math.abs(plan.target2 - plan.entry);
  const riskUnits = qty * stopDist;              // USDT (futures) / ₹ (others)
  const rewardT1 = qty * t1Dist;
  const rewardT2 = qty * t2Dist;
  const rr = riskUnits > 0 ? rewardT2 / riskUnits : 0;
  const liquidation = leveraged && lev > 1 ? plan.entry * (long ? 1 - 0.95 / lev : 1 + 0.95 / lev) : null;
  const liqDistPct = liquidation != null ? (Math.abs(plan.entry - liquidation) / plan.entry) * 100 : null;
  const slDistPct = (stopDist / plan.entry) * 100;
  const liqBeforeSl = liqDistPct != null && liqDistPct < slDistPct;
  const maxSane = Math.max(1, Math.min(cap, Math.floor(95 / slDistPct)));
  const effRiskOnMargin = leveraged ? slDistPct * lev : null;

  const pickLev = (l: number) => { setLev(l); setResult(null); };

  const fmtU = (n: number, dp = 0) => usdDenominated
    ? `${n.toLocaleString('en-US', { maximumFractionDigits: dp || 2 })} ${unit}`
    : fmt(n, dp);
  // v12.9 USER SPEC: the ≈₹ INR conversion hints are REMOVED from the
  // USDT desk — "USDT ke price point pe trade lete vo theek hai, qty
  // bhi theek hai, but indian INR price amount add karne mat karo."
  // The USDT domain stays pure USDT; the ₹ lives only on the server's
  // own risk caps and the Reversal ₹-thresholds (the user's config).

  const exec = async (mode: 'paper' | 'live' | 'notify') => {
    // v18.6.4: STALE signal pe paper bhi gated — same confirm bar jo
    // full card ke paper buttons par hai (v18.6.1 Fix 3b).
    if (mode === 'paper' && gatePaper) {
      const run = () => { void execInner(mode); };
      gatePaper(run);
      return;
    }
    return execInner(mode);
  };
  const execInner = async (mode: 'paper' | 'live' | 'notify') => {
    const handler = global ? onExecuteGlobal : futures ? onExecuteFutures : crypto ? onExecute : onExecuteIndia;
    if (!handler) return;
    if (invalid) {
      setResult({ ok: false, text: `⚠ Pehle amount daalo — minimum ${usdDenominated ? `${lo} ${unit} margin` : `₹${lo}`}${orderCap != null ? ` (server cap ${futures || global ? '' : '₹'}${orderCap.toLocaleString('en-IN')})` : ''}. Box khali/clear karke apna amount type karo, blur par apne aap valid ho jayega.` });
      armResultTimer();
      return;
    }
    const sendMargin = clampMargin(marginRaw); // final safety clamp (cap incl.)
    const opts = futures || global
      ? { marginUSDT: sendMargin, ...(lev > 1 ? { leverage: lev } : {}) }
      : crypto
        ? { qtyINR: sendMargin, ...(lev > 1 ? { leverage: lev } : {}) }
        : { qtyINR: sendMargin };
    // v7.0.2 HONEST RESULT: the banner used to claim "position opened"
    // BEFORE the gauntlet answered — a kill-switch / daily-cap / network
    // rejection then showed a green success banner next to the parent's
    // red error toast. Now we await the server verdict.
    setResult({ ok: true, pending: true, text: '⏳ Order request gauntlet ko gaya — server gates (kill switch, caps, wallet) check ho rahe hain…' });
    let r: { ok?: boolean; error?: string; note?: string } | void;
    try { r = await handler(signal, mode, opts); }
    catch { r = { ok: false, error: 'request failed — network error' }; }
    if (r && typeof r === 'object' && r.ok === false) {
      setResult({ ok: false, text: `⛔ ${r.error || 'Gauntlet ne order reject kiya — toast/console me reason dekho'}` });
    } else {
      setResult({ ok: true, text: mode === 'live'
        ? `⚡ LIVE order executed — ${qty < 1 ? qty.toFixed(6) : qty} ${global ? 'shares' : futures ? 'contracts' : crypto ? 'units' : 'shares'} @ ${usdDenominated ? `${plan.entry} ${unit}` : `₹${plan.entry}`}${leveraged && lev > 1 ? ` · ${lev}x` : ''} (console me position confirm karo)`
        : mode === 'notify'
          ? `🔔 NOTIFY-only — gauntlet chala, alert + journal audit likha. Koi order/position NAHI bana.`
          : `🧪 PAPER position khula — ${qty < 1 ? qty.toFixed(6) : qty} ${global ? 'shares' : futures ? 'contracts' : crypto ? 'units' : 'shares'} @ ${usdDenominated ? `${plan.entry} ${unit}` : `₹${plan.entry}`}${leveraged && lev > 1 ? ` · ${lev}x margin` : ''} · watcher SL/TP manage karega` });
    }
    armResultTimer();
  };

  const canLiveHere = global ? canLive : futures ? canLive : crypto ? canLive : canLiveIndia;

  return (
    <div className={`mt-2.5 rounded-xl border p-3 ${futures
      ? 'border-violet-500/30 bg-gradient-to-b from-violet-500/[0.08] to-transparent'
      : crypto
        ? 'border-cyan-500/30 bg-gradient-to-b from-cyan-500/[0.08] to-transparent'
        : 'border-orange-500/30 bg-gradient-to-b from-orange-500/[0.08] to-transparent'}`} aria-label="simple trade ticket">
      <div className="flex items-center gap-2 flex-wrap">
        <span className={`text-[10px] font-black tracking-wider ${futures ? 'text-violet-300' : crypto ? 'text-cyan-300' : global ? 'text-sky-300' : 'text-orange-300'}`}>
          🚀 SIMPLE TRADE TICKET — {signal.symbol} {signal.side}
        </span>
        <span className="text-[9px] text-slate-500">{futures ? 'margin USDT (perp wallet se)' : global ? 'margin USDC (CoinDCX Global Futures SIM — practice)' : crypto ? 'margin ₹ (leverage apni lag raha hai)' : 'capital budget ₹'}</span>
      </div>

      {/* size + leverage inputs — v7.0.1 FREE-TYPING budget box */}
      <div className="flex items-center gap-2 flex-wrap mt-2">
        <label className="flex items-center gap-1.5 text-[9px] font-black text-slate-500 tracking-wider">
          {futures ? 'MARGIN USDT' : global ? 'MARGIN USDC' : crypto ? 'MARGIN ₹' : 'BUDGET ₹'}
          <input
            type="number" min={usdDenominated ? 2 : 100} max={1000000} step={usdDenominated ? 1 : 50}
            value={marginRaw} onChange={e => onMargin(e.target.value)} onBlur={onMarginBlur}
            placeholder={usdDenominated ? unit : '₹'}
            className={`quantum-input px-2 py-1 rounded-lg text-[11px] font-mono font-bold text-white w-28 ${invalid ? 'border-amber-500/50' : ''}`}
            aria-label={usdDenominated ? `margin in ${unit} — apna amount type karo` : 'budget in rupees — apna amount type karo'} />
          {/* v12.9: the ≈ ₹ conversion hint is GONE (user spec) — the USDT
              desk shows pure USDT; no INR price amounts are added. */}
          {invalid && <span className="text-[9px] font-black text-amber-400">amount daalo (min {usdDenominated ? `${lo} ${unit}` : `₹${lo}`})</span>}
        </label>
        {/* v7.0.1 quick-amount chips — one-tap sizing, no typing needed */}
        <div className="flex items-center gap-1 flex-wrap" role="group" aria-label="quick amount presets">
          {(usdDenominated ? [5, 10, 25, 50, 100] : [500, 1000, 2500, 5000, 10000]).map(a => (
            <button key={a} onClick={() => pickAmount(a)}
              title={`Quick-set ${usdDenominated ? `${a} ${unit} margin` : `₹${a.toLocaleString('en-IN')} budget`}`}
              className={`px-2 py-1 rounded-lg text-[10px] font-black font-mono border transition-colors ${typedValid && Number(marginRaw) === a
                ? 'bg-cyan-500/25 text-cyan-200 border-cyan-400/60'
                : 'bg-black/30 text-slate-400 border-slate-600/40 hover:bg-cyan-500/10'}`}>
              {usdDenominated ? (global ? `$${a}` : `${a}U`) : a >= 1000 ? `₹${a / 1000}k` : `₹${a}`}
            </button>
          ))}
          {orderCap != null && (
            <button onClick={() => pickAmount(orderCap)}
              title={`Server per-order cap — Execution Console → Risk settings me badha sakte ho`}
              className="px-2 py-1 rounded-lg text-[10px] font-black font-mono border border-amber-500/40 bg-amber-500/10 text-amber-300 hover:bg-amber-500/20 transition-colors">
              MAX ₹{orderCap.toLocaleString('en-IN')}
            </button>
          )}
        </div>
        {leveraged && (
          <div className="flex items-center gap-1" role="group" aria-label="leverage selector">
            <span className="text-[9px] font-black text-slate-500 tracking-wider">LEVERAGE</span>
            {[1, 2, 3, 5, 10].filter(l => l <= cap).map(l => (
              <button key={l} onClick={() => pickLev(l)} disabled={l > maxSane && l > 1}
                title={l > maxSane && l > 1 ? `${l}x par liquidation SL se pehle fire hogi (max sane ${maxSane}x)` : `${l}x — notional ${usdDenominated ? `${(margin * l).toFixed(0)} ${unit}` : fmt(margin * l, 0)}`}
                className={`px-2 py-1 rounded-lg text-[10px] font-black font-mono border transition-colors disabled:opacity-30 ${lev === l
                  ? 'bg-cyan-500/25 text-cyan-200 border-cyan-400/60'
                  : 'bg-black/30 text-slate-400 border-slate-600/40 hover:bg-cyan-500/10'}`}>
                {l}x
              </button>
            ))}
            {cap < 10 && <span className="text-[9px] text-slate-600">(max {cap}x — Risk settings)</span>}
          </div>
        )}
      </div>

      {/* v7.0.1 honest-cap + validation warnings (below the inputs) */}
      {overCapTyped && (
        <div className="mt-1.5 px-2.5 py-1.5 rounded-lg bg-amber-500/[0.07] border border-amber-500/25 text-[10px] font-bold text-amber-300/90 leading-relaxed">
          ⚠ Tumne {usdDenominated ? '' : '₹'}{Math.round(marginNum).toLocaleString('en-IN')} daala, par server per-order cap <b>₹{orderCap!.toLocaleString('en-IN')}</b> hai — order/calculations upar <b>₹{orderCap!.toLocaleString('en-IN')}</b> par hi jayenge (preview wahi dikhata hai).
          Cap badhana hai to Execution Console → Risk settings me <b>"Max order ₹"</b> badhao, ya upar <b>MAX</b> chip dabao.
        </div>
      )}
      {belowMin && typedValid && (
        <div className="mt-1.5 px-2.5 py-1.5 rounded-lg bg-amber-500/[0.07] border border-amber-500/25 text-[10px] font-bold text-amber-300/90 leading-relaxed">
          ⚠ {futures ? `Margin ${marginRaw} USDT` : global ? `Margin ${marginRaw} USDC` : `Budget ₹${marginRaw}`} minimum {usdDenominated ? `${lo} ${unit}` : `₹${lo}`} se kam hai — execute nahi hoga. Amount badhao (blur par apne aap clamp ho jayega).
        </div>
      )}

      {/* the pre-computed numbers — preview IS the fill */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-1.5 mt-2">
        {[
          { l: 'QTY', v: qty < 1 ? qty.toFixed(6) : String(qty), c: 'text-white' },
          { l: leveraged ? 'NOTIONAL' : 'CAPITAL USED', v: usdDenominated ? `${(qty * plan.entry).toLocaleString('en-US', { maximumFractionDigits: 2 })} ${unit}` : fmt(qty * plan.entry, 0), c: 'text-cyan-300' },
          { l: usdDenominated ? `${unit} RISK @ SL` : '₹ RISK @ SL', v: `−${fmtU(riskUnits, 2)}`, c: 'text-red-300' },
          { l: usdDenominated ? `${unit} PROFIT @ T2` : '₹ PROFIT @ T2', v: `+${fmtU(rewardT2, 2)}`, c: 'text-emerald-300' },
        ].map(x => (
          <div key={x.l} className="bg-black/30 rounded-lg px-2 py-1.5 text-center">
            <div className="text-[8px] text-slate-500 font-black tracking-wider">{x.l}</div>
            <div className={`text-xs font-mono font-bold ${x.c}`}>{x.v}</div>
          </div>
        ))}
      </div>
      {/* v12.9: the "USDT ≈ ₹ conversion display-only" footnote removed —
          the USDT desk carries no INR price amounts (user spec). */}
      <div className="flex items-center gap-3 mt-1.5 text-[10px] font-mono font-bold flex-wrap">
        <span className="text-slate-500">ENTRY <span className="text-cyan-300">{px(plan.entry, cur)}</span></span>
        <span className="text-slate-500">SL <span className="text-red-300">{px(plan.stopLoss, cur)}</span> (−{slDistPct.toFixed(2)}%)</span>
        <span className="text-slate-500">T1 <span className="text-emerald-300">+{fmtU(rewardT1, 2)}</span></span>
        <span className="text-slate-500">T2 <span className="text-emerald-300">+{fmtU(rewardT2, 2)}</span></span>
        <span className="text-amber-300">R:R 1:{rr.toFixed(1)}</span>
      </div>

      {/* leverage honesty block */}
      {leveraged && lev > 1 && (
        <div className="mt-2 space-y-1.5">
          <div className="flex gap-2 flex-wrap text-[10px] font-mono font-bold">
            <span className="px-1.5 py-0.5 rounded bg-black/30 text-cyan-300">{lev}x · margin {usdDenominated ? `${margin} ${unit}` : fmt(margin, 0)} → notional {usdDenominated ? `${(margin * lev).toFixed(0)} ${unit}` : fmt(margin * lev, 0)}</span>
            {liquidation != null && <span className="px-1.5 py-0.5 rounded bg-violet-500/10 text-violet-300">≈ LIQUIDATION {px(liquidation, cur)} (−{liqDistPct!.toFixed(1)}%)</span>}
            {effRiskOnMargin != null && <span className="px-1.5 py-0.5 rounded bg-amber-500/10 text-amber-300">SL hit = −{effRiskOnMargin.toFixed(0)}% of margin</span>}
          </div>
          {liqBeforeSl ? (
            <div className="px-2.5 py-1.5 rounded-lg bg-red-500/10 border border-red-500/30 text-[10px] font-bold text-red-300 leading-relaxed">
              ⚠️ {lev}x par liquidation (−{liqDistPct!.toFixed(1)}%) tumhare SL (−{slDistPct.toFixed(1)}%) se <b>PEHLE</b> fire hogi — plan ka SL kabhi execute hi nahi hoga.
              LIVE reject hoga; PAPER me server leverage auto-reduce kar dega. Max sane: <b>{maxSane}x</b>.
            </div>
          ) : (
            <div className="px-2.5 py-1.5 rounded-lg bg-black/20 text-[10px] font-bold text-slate-400 leading-relaxed">
              ✅ Liquidation (−{liqDistPct!.toFixed(1)}%) SL (−{slDistPct.toFixed(1)}%) se door hai — SL pehle fire hoga, plan kaam karega.
            </div>
          )}
        </div>
      )}
      {crypto && lev > 1 && (
        <div className="mt-1 text-[9px] text-slate-600 leading-relaxed">
          LIVE mode me {lev}x order CoinDCX MARGIN API (B-pair) se jaata hai — exit watcher <b>margin exit_positions</b> se karega. Liquidation estimate hai (maintenance ~5% buffer) — exact level exchange tiers par depend karta hai.
        </div>
      )}
      {futures && (
        <div className="mt-1 text-[9px] text-slate-600 leading-relaxed">
          ⚡ GLOBAL FUTURES: LIVE order CoinDCX <b>derivatives/futures</b> API se jaata hai (USDT margin, native TP/SL exchange par bhi armed). LIVE par margin kam padne se <b>spot → futures auto-transfer</b> ho jaata hai. Exit watcher + time-exit agent dono guard karte hain.
        </div>
      )}
      {india && qty < 1 && (
        <div className="mt-2 px-2.5 py-1.5 rounded-lg bg-amber-500/5 border border-amber-500/20 text-[10px] font-bold text-amber-300/90">
          ⚠️ Budget ₹{margin} par 1 share bhi nahi aati (₹{plan.entry.toLocaleString('en-IN')}/share) — PAPER me server 1-share practice position bana dega, LIVE honestly reject karega. Budget badhao ya India Max ₹ settings me.
        </div>
      )}

      {/* ONE-CLICK execute — v7.0.1: disabled while the budget box is
          empty/below-min so a half-typed amount can never fire */}
      <div className="mt-3 flex flex-wrap gap-2">
        <button onClick={() => exec('paper')} disabled={busy || invalid}
          className={`quantum-btn-primary px-4 py-2 rounded-xl text-xs font-black disabled:opacity-50 ${futures ? 'bg-gradient-to-r from-violet-600 to-fuchsia-600' : crypto ? 'bg-gradient-to-r from-cyan-600 to-indigo-600' : 'bg-gradient-to-r from-orange-600 to-amber-600'}`}>
          🧪 PAPER EXECUTE{leveraged && lev > 1 ? ` · ${lev}x` : ''}
        </button>
        <button onClick={() => exec('notify')} disabled={busy || invalid}
          title="NOTIFY (v6.11) — poora gauntlet chalega, par output sirf Telegram alert + journal audit hoga. Koi order nahi, koi position nahi."
          className="px-4 py-2 rounded-xl text-xs font-black bg-gradient-to-r from-sky-600 to-blue-600 text-white hover:from-sky-500 hover:to-blue-500 disabled:opacity-50 transition-colors">
          🔔 NOTIFY
        </button>
        {signal.grade === 'STRONG' && (leveraged ? signal.executable : true) && (
          <button onClick={() => exec('live')} disabled={busy || !canLiveHere || invalid}
            title={canLiveHere ? 'REAL order — saare gates server-side re-verify honge' : 'STRONG hai — console me LIVE arm karo (Dhan connect for India)'}
            className="px-4 py-2 rounded-xl text-xs font-black bg-gradient-to-r from-emerald-600 to-teal-600 text-white hover:from-emerald-500 hover:to-teal-500 disabled:opacity-40 disabled:cursor-not-allowed transition-colors">
            ⚡ LIVE EXECUTE{leveraged && lev > 1 ? ` · ${lev}x` : ''}
          </button>
        )}
        {signal.grade !== 'STRONG' && (
          <span className="text-[10px] text-slate-500 self-center px-1">LIVE locked — needs STRONG (75%+ conf, 70%+ agreement)</span>
        )}
      </div>

      {result && (
        <div className={`mt-2 px-2.5 py-2 rounded-lg text-[10px] font-bold leading-relaxed ${result.pending ? 'bg-slate-500/10 border border-slate-500/30 text-slate-300 animate-pulse' : result.ok ? 'bg-emerald-500/10 border border-emerald-500/30 text-emerald-300' : 'bg-red-500/10 border border-red-500/30 text-red-300'}`}>
          {result.text}
        </div>
      )}

      {/* v6.13 — 4-STEP ORDER GUIDE: ① KAB ② LIMIT kaise ③ EXIT kab ④ MANAGE.
          User ka seedha sawaal: "kab lena · limit kaise lagana · kab exit" —
          yeh block wahi jawab deta hai, venue ke hisaab se. */}
      <div className="mt-2 rounded-lg bg-black/25 border border-white/5 px-2.5 py-2.5 space-y-1.5" aria-label="order guide 4 steps">
        <div className="text-[9px] font-black text-cyan-300 tracking-wider">📋 ORDER GUIDE — {futures ? 'COINDCX FUTURES' : global ? 'GLOBAL EQUITY · SIM DESK' : crypto ? 'COINDCX SPOT' : 'DHAN / BROKER'} · 4 STEP</div>
        <div className="text-[10px] text-slate-300 leading-relaxed">
          <b className="text-white">① KAB:</b>{' '}
          {india
            ? (signal.quality?.session
              ? (signal.quality.session.tradeable
                ? <>abhi <b className="text-emerald-300">{signal.quality.session.phase}</b> window chal raha hai — entry OK. Best windows: <b>9:30–10:30</b> (MORNING) aur <b>13:30–15:15</b> (AFTERNOON/POWER). <b className="text-red-300">9:15–9:30 opening noise</b> aur <b className="text-red-300">15:15 ke baad entry NAHI</b>.</>
                : <>abhi phase <b className="text-amber-300">{signal.quality.session.phase}</b> hai — fresh entry <b>wait</b> karo. Tradeable window: <b>9:30–10:30</b> ya <b>13:30–15:15</b> (Mon–Fri).</>)
              : <>best windows <b>9:30–10:30</b> (MORNING) ya <b>13:30–15:15</b> (AFTERNOON/POWER); <b className="text-red-300">9:15–9:30 noise me entry nahi</b>, <b className="text-red-300">15:15 ke baad sirf square-off</b>.</>)
            : futures
              ? '24/7 USDT perp market — kabhi bhi. Par weekend/holiday pe liquidity thin hoti hai: size aadha, limit order zaroori.'
              : global
                ? 'US market hours (≈ 21:30–04:00 IST winter / 20:30–03:30 summer) me quotes + volume live; baaki time board last-close par chalta hai. SIM desk — practice sizing wahi rahe.'
                : '24/7 crypto market — kabhi bhi. Weekend pe spread wide — LIMIT order hi lagao, MARKET nahi.'}
        </div>
        <div className="text-[10px] text-slate-300 leading-relaxed">
          <b className="text-white">② LIMIT ORDER kaise lagana hai:</b>{' '}
          {futures
            ? <>CoinDCX app me <b>{signal.symbol}</b> perp kholo → <b>BUY/LIMIT</b> select → price me <b className="text-cyan-300">{px(plan.entry, 'usdt')}</b> → amount <b>{qty < 1 ? qty.toFixed(6) : qty} contracts</b>{leveraged && lev > 1 ? ` · ${lev}x leverage · margin mode` : ''}. </>
            : global
              ? <>SIM desk — prices CoinDCX Global Futures (USDC) se aate hain, koi broker order NAHI jata. Ticket se <b>PAPER EXECUTE</b> karo (sizing USDC margin se), watcher SL/TP/trailing khud manage karega. Entry reference <b className="text-cyan-300">{px(plan.entry, 'usdc')}</b>. </>
              : crypto
                ? <>CoinDCX app me <b>{signal.symbol}</b> pair kholo → <b>{long ? 'BUY' : 'SELL'} / LIMIT</b> → price me <b className="text-cyan-300">{px(plan.entry)}</b> → amount <b>{qty < 1 ? qty.toFixed(6) : qty} {long ? 'buy' : 'sell'}</b>. </>
                : <>broker me <b>{signal.symbol}</b> search karo → <b>{long ? 'BUY' : 'SELL'} · LIMIT</b> select → price me <b className="text-cyan-300">₹{plan.entry.toLocaleString('en-IN')}</b> (band {`₹${(plan.entry * 0.9985).toFixed(2)}–₹${(plan.entry * 1.0015).toFixed(2)}`}) → qty <b>{qty}</b> · product <b>MIS</b>. </>}
          <b className="text-red-300">MARKET order kabhi mat lagao</b> — spread slip entry ka edge kha jaata hai. Fill nahi mile to limit ±0.2% adjust karo, price chase nahi.
        </div>
        <div className="text-[10px] text-slate-300 leading-relaxed">
          <b className="text-white">③ EXIT kab:</b>{' '}
          SL <b className="text-red-300">{px(plan.stopLoss, cur)}</b> (−{slDistPct.toFixed(2)}%) · T1/T2 watcher khud track karega{futures ? ' (trailing + native exchange TP/SL)' : crypto ? ' (trailing SL ON)' : ' (trailing + 15:15 auto square-off)'}.
          {' '}App ke saath broker me bhi SL laga do{india ? ' (SL-M / bracket)' : futures ? ' (stop-market on the perp)' : ' (stop-limit)'} — <b>double guard</b>: app watcher + exchange dono.
        </div>
        <div className="text-[10px] text-slate-300 leading-relaxed">
          <b className="text-white">④ MANAGE:</b> position <b>03 Execution Console</b> me dikhega — P&L live, <b>CLOSE</b> button kabhi bhi. Exit ka rule: SL aaye → nikal jao, andekha mat karo; T2 hit → profit book.
        </div>
      </div>
    </div>
  );
}

interface Props {
  signal: AISignal;
  busy?: boolean;
  onExecute?: (signal: AISignal, mode: 'paper' | 'live' | 'notify', opts?: { qtyINR?: number; leverage?: number }) => Promise<{ ok?: boolean; error?: string; note?: string } | void> | void;
  onExecuteIndia?: (signal: AISignal, mode: 'paper' | 'live' | 'notify', opts?: { qtyINR?: number; leverage?: number }) => Promise<{ ok?: boolean; error?: string; note?: string } | void> | void;
  onExecuteFutures?: (signal: AISignal, mode: 'paper' | 'live' | 'notify', opts?: { qtyINR?: number; marginUSDT?: number; leverage?: number }) => Promise<{ ok?: boolean; error?: string; note?: string } | void> | void;
  onExecuteGlobal?: (signal: AISignal, mode: 'paper' | 'live' | 'notify', opts?: { qtyINR?: number; marginUSDT?: number; leverage?: number }) => Promise<{ ok?: boolean; error?: string; note?: string } | void> | void;
  onDeep?: (signal: AISignal) => void;
  canLive?: boolean;
  canLiveIndia?: boolean;
  isNew?: boolean; // v6.3: freshly-appeared actionable signal → flash ring
  /** v6.4: crypto order preview budget (server config maxOrderINR). */
  orderBudgetINR?: number;
  /** v6.4: the risk cap the board plans were built within. */
  riskCapPct?: number;
  /** v6.6: crypto leverage ceiling from server config (default 1). */
  maxLeverage?: number;
  /** v6.6: India default capital budget (indiaMaxOrderINR). */
  indiaBudgetINR?: number;
  /** v9.1 PAPER DESK BRIDGE: open this signal as a server-managed Paper
   *  Desk position (/api/intraday-paper — T1 50% book, breakeven trail,
   *  SL/T2/EOD auto-exit) instead of the quick journal paper fill. */
  onPaperTrade?: (signal: AISignal) => void;
  /** v9.1: the Paper Desk already has an open trade on this symbol →
   *  show the ✓ PAPER OPEN state (server also blocks duplicates). */
  paperOpenForSymbol?: boolean;
  /** v10.10: LIVE direct-CoinDCX LTP (2s RT stream — /api/stream fut=/
   *  glob=/crypto= overlay). null = no live tick yet → snapshot ltp shows. */
  liveLtp?: number | null;
  /** v10.11 (#1): which upstream served the live tick (server source label:
   *  'coindcx-fut-rt' | 'coindcx-fut-ws' | 'finnhub-global-rt' |
   *  'yahoo-global-rt' | 'binance-fut-rt' | …) → the provenance pill. */
  liveSrc?: string | null;
  /** v21.3.0 (Issue-4): READ-ONLY pre-flight for the ⚡ EXECUTE LIVE
   *  modal (dry-run gauntlet + would-be ticket). Injected from the desk
   *  (useAITrading.futuresPrecheck); absent → the old direct-execute
   *  behaviour (paper flow untouched). */
  onPrecheckFutures?: (signal: AISignal, opts?: { marginUSDT?: number; leverage?: number }) => Promise<import('./types').FuturesPrecheckResult | null>;
}

// ---------------- v11.0: GLOBAL MARKET COUNCIL strip ----------------
/** The 6-seat verdict row: stamp chip (gate decision) + per-agent
 *  mini confidence bars; expanded cards get per-agent reasons + the
 *  bull/bear debate trail. Renders NOTHING when the council is OFF
 *  (the stamp is absent — honest degrade, zero clutter). */
function CouncilStrip({ council, expanded }: { council: NonNullable<AISignal['council']>; expanded: boolean }) {
  const bull = (council.agents || []).filter(a => a.direction === 'LONG').length;
  const bear = (council.agents || []).filter(a => a.direction === 'SHORT').length;
  const passed = council.gate === 'PASSED';
  const reasonByRole = new Map((council.agentReasons || []).map(r => [r.role, r]));
  return (
    <div className="bg-black/25 rounded-lg border border-white/5 px-2.5 py-2 space-y-1.5">
      <div className="flex items-center gap-1.5 flex-wrap text-[9px] font-mono font-black">
        <span className="text-slate-400">🏛️ COUNCIL {council.quorum}/6</span>
        <span className={council.direction === 'LONG' ? 'text-emerald-300' : council.direction === 'SHORT' ? 'text-red-300' : 'text-slate-500'}>
          {council.direction === 'LONG' ? '▲' : council.direction === 'SHORT' ? '▼' : '—'} {council.direction} {Math.round(council.confidence)}
        </span>
        <span className="text-slate-600">{bull}▲ {bear}▼ · agree {Math.round(council.agreement * 100)}%</span>
        <span
          className={`px-1.5 py-0.5 rounded border ${passed
            ? 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30'
            : 'bg-amber-500/15 text-amber-300 border-amber-500/30'}`}
          title={(council.gateReasons || []).join(' · ') || 'precision gate pass'}
        >
          {passed ? '✓ GATE PASSED' : '⊘ SUPPRESSED'}
        </span>
        <span className="ml-auto text-slate-600">{council.freshness === 'model' ? 'MODEL' : council.model || ''}</span>
      </div>
      <div className="grid grid-cols-3 sm:grid-cols-6 gap-1">
        {(council.agents || []).map(a => (
          <div key={a.role} className="bg-black/30 rounded px-1.5 py-1" title={`${a.name}: ${a.direction} ${Math.round(a.confidence)}${reasonByRole.get(a.role)?.reasons?.length ? '\n' + reasonByRole.get(a.role)!.reasons.join('\n') : ''}`}>
            <div className="text-[8px] text-slate-500 truncate font-black tracking-wide">{a.name.split(' ')[0].toUpperCase()}</div>
            <div className="flex items-center gap-1">
              <span className={`text-[9px] font-black ${a.direction === 'LONG' ? 'text-emerald-300' : a.direction === 'SHORT' ? 'text-red-300' : 'text-slate-600'}`}>{a.direction === 'LONG' ? '▲' : a.direction === 'SHORT' ? '▼' : '—'}</span>
              <div className="flex-1 h-1 bg-black/40 rounded overflow-hidden">
                <div className={`h-full ${a.direction === 'LONG' ? 'bg-emerald-500/60' : a.direction === 'SHORT' ? 'bg-red-500/60' : 'bg-slate-600/60'}`} style={{ width: `${Math.min(100, a.confidence)}%` }} />
              </div>
            </div>
          </div>
        ))}
      </div>
      {expanded && (council.agentReasons || []).length > 0 && (
        <div className="space-y-0.5 text-[9px] leading-relaxed text-slate-500">
          {(council.agentReasons || []).map(r => (
            <div key={r.role} className="flex gap-1.5">
              <span className="text-slate-400 font-black w-[86px] shrink-0 truncate">{r.role}</span>
              <span className="truncate" title={(r.reasons || []).join(' · ')}>{(r.reasons || []).join(' · ') || '—'}{r.veto ? ` · VETO: ${r.veto}` : ''}</span>
            </div>
          ))}
        </div>
      )}
      {expanded && council.debate && (council.debate.bull || council.debate.bear) && (
        <div className="grid gap-1 sm:grid-cols-2 text-[9px] leading-relaxed">
          {council.debate.bull && <div className="bg-emerald-500/5 border border-emerald-500/15 rounded px-1.5 py-1 text-emerald-200/80"><b className="text-emerald-300">BULL:</b> {council.debate.bull}</div>}
          {council.debate.bear && <div className="bg-red-500/5 border border-red-500/15 rounded px-1.5 py-1 text-red-200/80"><b className="text-red-300">BEAR:</b> {council.debate.bear}</div>}
          {council.debate.judge && <div className="sm:col-span-2 bg-cyan-500/5 border border-cyan-500/15 rounded px-1.5 py-1 text-cyan-200/80"><b className="text-cyan-300">JUDGE:</b> {council.debate.judge}</div>}
        </div>
      )}
    </div>
  );
}

// ---------------- v12.4 SIGNAL TRUST CHIPS ----------------
// The WLD incident, closed at the card level: the age of the signal
// (kitna purana hai), the OB/OS suppression verdict, the fresh-flip
// whipsaw warning, and the HOLDING stamp for money already on the
// line. Each chip is context the pro trader needs BEFORE entering.

/** Ticking clock for live age display (15s granularity is plenty). */
function useNowTicked(intervalMs = 15_000) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}

function fmtAge(ms: number): string {
  if (!(ms >= 0)) return '—';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h ${m % 60}m` : `${Math.floor(h / 24)}d ${h % 24}h`;
}

/**
 * ⏱ SIGNAL AGE — "AI model ne ye direction kab pakda?" The age is
 * recomputed LIVE from firstSeenAt (not a frozen server snapshot), so
 * the chip keeps ticking between board refreshes.
 *   < 2m  → cyan FRESH (unstable — signal abhi bana hai)
 *   2-10m → emerald (confirmed young)
 *   10-30m→ amber (aging)
 *   > 30m → red STALE (entry se pehle re-check karo)
 * Title carries the full truth: age · last confirm · 24h flips.
 */
function SignalAgeChip({ age }: { age: NonNullable<AISignal['signalAge']> }) {
  const now = useNowTicked();
  const ageMs = Number(age.firstSeenAt) > 0 ? now - Number(age.firstSeenAt) : Number(age.ageMs) || 0;
  const lastConfirmMs = Number(age.lastSeenAt) > 0 ? now - Number(age.lastSeenAt) : null;
  const flips = Number(age.flips24h) || 0;
  const fresh = ageMs < 2 * 60_000;
  const stale = ageMs > 30 * 60_000;
  const cls = fresh
    ? 'bg-cyan-500/15 text-cyan-300 border-cyan-500/40'
    : stale
      ? 'bg-red-500/15 text-red-300 border-red-500/40'
      : ageMs > 10 * 60_000
        ? 'bg-amber-500/15 text-amber-300 border-amber-500/40'
        : 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30';
  const label = fresh ? 'FRESH' : stale ? 'STALE' : 'AGE';
  return (
    <span
      className={`px-1.5 py-0.5 rounded text-[9px] font-black border font-mono ${cls}`}
      title={`AI ne ye direction ${fmtAge(ageMs)} pehle pakda hai · last board confirm ${lastConfirmMs != null ? `${fmtAge(lastConfirmMs)} pehle` : '—'} · 24h me ${flips} flip${flips === 1 ? '' : 's'}${fresh ? ' · signal abhi bana hai — confirmation ka wait karo' : ''}${stale ? ' · entry se pehle deep re-check karo' : ''}`}
    >
      ⏱ {fmtAge(ageMs)} {label}{flips > 0 ? ` · ${flips}↺` : ''}
    </span>
  );
}

export const SignalCard = memo(function SignalCard({ signal, busy, onExecute, onExecuteIndia, onExecuteFutures, onExecuteGlobal, onDeep, canLive, canLiveIndia, isNew, orderBudgetINR, riskCapPct, maxLeverage, indiaBudgetINR, onPaperTrade, paperOpenForSymbol, liveLtp, liveSrc, onPrecheckFutures }: Props) {
  const [expanded, setExpanded] = useState(false);
  const [slipOpen, setSlipOpen] = useState(false);
  const [ticketOpen, setTicketOpen] = useState(false);
  // v21.3.0 (Issue-4): the ⚡ EXECUTE LIVE pre-flight modal state.
  const [liveModalOpen, setLiveModalOpen] = useState(false);
  // v20.2: the price chart — lazy (fetch + render only when the user opens it)
  const [chartOpen, setChartOpen] = useState(false);
  // v18.6.1 Fix 3b — STALE paper-trade confirmation: jab board ne 30m+ se
  // is side ko re-confirm nahi kiya, paper buttons seedha fire NAHI hote —
  // confirm bar khulta hai (Recheck karo → onDeep / Proceed anyway).
  const [pendingPaper, setPendingPaper] = useState<null | (() => void)>(null);
  const g = gradeBadge(signal.grade);
  const long = signal.side === 'LONG';
  const actionable = signal.grade === 'STRONG' || signal.grade === 'ACTION';
  const plan = signal.plan;
  const overCap = !!(plan && riskCapPct && plan.riskPct > riskCapPct);
  const si = signal.superIntel ?? null; // v9 SUPERINTELLIGENCE
  // v18.6.1 Fix 3 — STALEness with teeth: 30m+ since the LAST board
  // re-confirm (lastSeenAt) → grade badge display-downgrade + paper
  // buttons need explicit confirm. The underlying signal.grade stays
  // untouched (server contract change ZERO).
  const staleAgeMs = signal.signalAge
    ? (Number(signal.signalAge.lastSeenAt) > 0 ? Date.now() - Number(signal.signalAge.lastSeenAt) : Number(signal.signalAge.ageMs) || 0)
    : 0;
  const isStale = staleAgeMs > 30 * 60_000;
  const gLabel = isStale && signal.grade === 'ACTION' ? 'ACTION · STALE' : g.label;
  const gatePaper = (act: () => void) => {
    if (isStale) { setPendingPaper(() => act); return; }
    act();
  };

  return (
    <div id={`sig-${signal.market}-${signal.symbol}`} className={`quantum-panel rounded-2xl p-4 transition-colors hover:border-cyan-500/20 border-l-4 ${long ? 'border-l-emerald-500/60' : 'border-l-red-500/60'} scroll-mt-24
      ${signal.grade === 'STRONG' ? 'ring-1 ring-emerald-500/40' : ''}
      ${(si?.aiScore ?? 0) >= 80 ? 'ring-1 ring-cyan-400/40' : ''}
      ${signal.holdingOnly ? 'ring-2 ring-fuchsia-500/50' : signal.holding ? 'ring-1 ring-fuchsia-500/30' : ''}
      ${isNew ? 'ring-2 ring-cyan-400/60 animate-pulse' : ''}`}>
      {/* Header row */}
      <div className="flex items-center gap-3 flex-wrap">
        <ConfidenceGauge value={signal.confidence} side={signal.side} />
        {/* v9: the SUPERINTELLIGENCE AI SCORE ring — the board's ranking
            number (80+ = STRONG, 85+ = ELITE). */}
        {si && <SuperIntelRing score={si.aiScore} tier={si.tier} />}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-base font-black text-white font-mono tracking-wide">{signal.symbol}</span>
            {isNew && <span className="px-1.5 py-0.5 rounded bg-cyan-500/15 text-cyan-300 text-[9px] font-black border border-cyan-500/30">NEW</span>}
            <span className={`text-sm font-black ${sideColor(signal.side)}`}>{long ? '▲ LONG' : '▼ SHORT'}</span>
            <span className={`px-2 py-0.5 rounded-md text-[10px] font-black tracking-wider ${isStale && signal.grade === 'ACTION' ? 'bg-amber-500/15 text-amber-300 border border-amber-500/40' : g.cls}`}>{gLabel}</span>
            {/* v13.1 SVA-v1 — THE final-call chip. Reads FIRST, before
                every other badge: the pro-trader verdict (CONFIRM /
                CAUTION / FLIP / STAND ASIDE + score). */}
            {signal.verify && <VerifyBadge v={signal.verify} side={signal.side} />}
            {/* v20.9.2 UCV-A1 — the "pakka" chip: realtime ultrafast 1m
                chart ne direction verify ki ya nahi (CONFIRMED / PENDING /
                REJECTED — the long-bola-par-short-gaya mismatch guard). */}
            {signal.ultrafast && <UltrafastBadge v={signal.ultrafast} side={signal.side} />}
            {/* v21.3.0 (Issue-5): AI confirmation — CONFIRMED /
                CONFLICT / abstain, per-provider chips ke saath. */}
            {signal.aiConfirm && <AiConfirmBadge v={signal.aiConfirm} />}
            {(() => {
              // v10.2.1: guard like TopPicksPanel — a stale/partial signal
              // without voters would render an "undefined/undefined votes"
              // badge. Hide the badge instead of showing garbage.
              const vc = signal.voters ?? signal.participating;
              if (vc == null || !signal.totalModels) return null;
              const capped = vc < 5;
              return (
                <span
                  className={`px-1.5 py-0.5 rounded text-[9px] font-bold border ${capped ? 'bg-amber-500/15 text-amber-300 border-amber-500/40' : 'bg-slate-700/40 text-slate-300 border-slate-600/40'}`}
                  title={capped ? 'Thin committee (<5 voters) — AI score bar raised by quorum penalty' : `${vc} models cast a directional vote`}
                >
                  {vc}/{signal.totalModels} votes{capped ? ' ⚠️ capped' : ''}
                </span>
              );
            })()}
            {(signal.market === 'CRYPTO' || signal.market === 'FUTURES') && signal.executable && (
              <span className={`px-1.5 py-0.5 rounded text-[9px] font-bold border ${signal.market === 'FUTURES' ? 'bg-violet-500/15 text-violet-300 border-violet-500/30' : 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30'}`}>⚡ {signal.market === 'FUTURES' ? 'FUTURES-ELIGIBLE' : 'EXECUTION-ELIGIBLE'}</span>
            )}
            {signal.market === 'INDIA' && signal.grade === 'STRONG' && (
              <span className="px-1.5 py-0.5 rounded bg-violet-500/15 text-violet-300 text-[9px] font-bold border border-violet-500/30">🎯 OPTIONS STRATEGY</span>
            )}
            {/* v12.4 SIGNAL TRUST chips — age / OB-OS / flip / holding.
                Context the pro trader needs BEFORE entering: kitna purana
                signal hai, kya RSI guard lagi hai, side abhi flip to
                nahi hua, aur kya position already open hai. */}
            {signal.signalAge && <SignalAgeChip age={signal.signalAge} />}
            {signal.obOs && (
              <span
                className={`px-1.5 py-0.5 rounded text-[9px] font-black border font-mono ${signal.obOs.extreme ? 'bg-red-500/15 text-red-300 border-red-500/40' : 'bg-amber-500/15 text-amber-300 border-amber-500/40'}`}
                title={`${signal.obOs.tag} — RSI ${signal.obOs.rsi}${signal.obOs.tag === 'OVERBOUGHT' ? ` ≥ 70: LONG entry SUPPRESSED hai (grade WATCH cap, chase protection)` : ` ≤ 30: SHORT entry SUPPRESSED hai (grade WATCH cap, chase protection)`}. Pullback ka wait karo ya counter setup dekho.`}>
                ⛔ {signal.obOs.tag} RSI {Math.round(signal.obOs.rsi)}
              </span>
            )}
            {signal.freshFlip && (
              <span
                className="px-1.5 py-0.5 rounded bg-orange-500/15 text-orange-300 text-[9px] font-black border border-orange-500/40 font-mono"
                title={`Signal ${Math.round((signal.freshFlip.ageSec || 0) / 60)}m pehle FLIP hua tha (${signal.freshFlip.from} → ${signal.freshFlip.to}) — whipsaw window me hai, grade WATCH cap laga hai. Confirmation (2-3 board cycles) ka wait karo.`}>
                🔄 FLIP {signal.freshFlip.from}→{signal.freshFlip.to} {fmtAge((signal.freshFlip.ageSec || 0) * 1000)} pehle
              </span>
            )}
            {/* v12.5 CHASE GUARD — the structural extension verdict. RSI
                guard ke saath ye dono milke "LONG bola tha par top pe
                entry karwa di" class ka poora coverage dete hain. */}
            {signal.chasing && signal.chasing.severity && (
              <span
                className={`px-1.5 py-0.5 rounded text-[9px] font-black border font-mono ${signal.chasing.severity === 'HARD' ? 'bg-rose-500/15 text-rose-300 border-rose-500/40' : 'bg-amber-500/15 text-amber-300 border-amber-500/40'}`}
                title={`${signal.chasing.severity === 'HARD' ? 'ENTRY SUPPRESSED' : 'EXTENDED (light haircut)'} — ${signal.chasing.reason || `price ${signal.chasing.extAtr}×ATR from ${signal.chasing.ref}`}${signal.chasing.runBars >= 4 ? ` · ${signal.chasing.runBars} one-way candles` : ''}. Move already ho chuka hai — ab entry = chase (top-tick risk). Pullback/retrace ka wait karo; signal side wahi rahega, entry timing improve karo.`}>
                🚀 {signal.chasing.severity === 'HARD' ? 'CHASE-LOCK' : 'EXTENDED'}{signal.chasing.extAtr != null ? ` ${signal.chasing.extAtr}×ATR` : ''}{signal.chasing.runBars >= 4 ? ` · ${signal.chasing.runBars}↑` : ''}
              </span>
            )}
            {/* v12.6 ENTRY-QUALITY chips — the POSITIVE side of the timing
                read: a pullback-in-trend entry (confidence boost + board
                rank boost) vs a stretched one. The user asked "accurate
                directions" — this shows WHERE the good entries live. */}
            {signal.entryQuality && !signal.chasing?.severity && (
              <span
                className={`px-1.5 py-0.5 rounded text-[9px] font-black border font-mono ${signal.entryQuality.band === 'PULLBACK' ? 'bg-emerald-500/15 text-emerald-300 border-emerald-500/40' : 'bg-amber-500/15 text-amber-300 border-amber-500/40'}`}
                title={signal.entryQuality.note || (signal.entryQuality.band === 'PULLBACK'
                  ? `price ${signal.entryQuality.extAtr}×ATR from ${signal.entryQuality.ref} — pullback zone, trend intact. ACHHA entry location (confidence + rank boost mila hai).`
                  : `price ${signal.entryQuality.extAtr}×ATR from ${signal.entryQuality.ref} — stretched; retrace entry better.`)}>
                {signal.entryQuality.band === 'PULLBACK' ? '🌊 PULLBACK' : '📐 STRETCHED'}{signal.entryQuality.extAtr != null ? ` ${signal.entryQuality.extAtr}×ATR` : ''}
              </span>
            )}
            {signal.holding && (
              <span
                className="px-1.5 py-0.5 rounded bg-fuchsia-500/15 text-fuchsia-300 text-[9px] font-black border border-fuchsia-500/40 font-mono"
                title={`OPEN POSITION already hai: ${signal.holding.side} ${signal.holding.qty > 0 ? `${signal.holding.qty} qty ` : ''}${signal.holding.entryPrice != null && signal.holding.entryPrice > 0 ? `@ ${signal.holding.entryPrice} ` : ''}${signal.holding.openedAt ? `· opened ${fmtAge(Date.now() - signal.holding.openedAt)} pehle ` : ''}(${signal.holding.via === 'manual' ? 'manual tracker' : signal.holding.mode || 'journal'})${signal.holdingOnly ? ' · ye card board se nikal gaya tha — position open hai isliye PIN kiya gaya' : ''}`}>
                🎯 HOLDING {signal.holding.side}{signal.holding.entryPrice != null && signal.holding.entryPrice > 0 ? ` @${signal.holding.entryPrice}` : ''}
              </span>
            )}
            {/* v12.7 AI-VIEW chip — on pinned holding cards the card's side
                is the POSITION side; the AI's CURRENT view (which may be
                the OPPOSITE side) shows HERE so a held LONG never renders
                as a SHORT card. It reads as context, never as a call. */}
            {signal.holdingOnly && signal.aiView && signal.aiView.side !== signal.holding?.side && (
              <span
                className={`px-1.5 py-0.5 rounded text-[9px] font-black border font-mono ${signal.aiView.side === 'LONG' ? 'bg-sky-500/15 text-sky-300 border-sky-500/40' : 'bg-amber-500/15 text-amber-300 border-amber-500/40'}`}
                title={`AI ka CURRENT view is pair pe ${signal.aiView.side} hai (${signal.aiView.grade || '—'}${signal.aiView.conf != null ? ` · conf ${signal.aiView.conf}%` : ''}${signal.aiView.fresh ? '' : ' · stale'}) — ye sirf CONTEXT hai, trade call NAHI. Aapki ${signal.holding?.side} position khud decide karo: exit / hold / average.`}>
                👁 AI abhi {signal.aiView.side} dekh raha hai
              </span>
            )}
          </div>
          <div className="flex items-center gap-3 mt-1 text-xs text-slate-400 flex-wrap">
            <span className="font-mono font-bold text-slate-200 flex items-center gap-1.5">
              {/* v10.10: DIRECT CoinDCX 2s live LTP (flash on tick) with the
                  board snapshot as the honest fallback — stale prices next
                  to fresh signals were the "wrong call" experience. */}
              <LivePriceText
                value={liveLtp != null && liveLtp > 0 ? liveLtp : null}
                fallback={signal.market === 'FUTURES'
                  ? (signal.ltp != null ? `${signal.ltp.toLocaleString('en-US', { maximumFractionDigits: 4 })} USDT` : '—')
                  : signal.market === 'GLOBALFUTURES'
                    ? (signal.ltp != null ? `USDC ${signal.ltp.toLocaleString('en-US', { maximumFractionDigits: 4 })}` : '—')
                    : fmt(signal.ltp)}
                format={signal.market === 'FUTURES'
                  ? (v => `${pxFmt(v)} USDT`)
                  : signal.market === 'GLOBALFUTURES'
                    ? (v => `USDC ${pxFmt(v)}`)
                    : (v => fmt(v))} />
              {liveLtp != null && liveLtp > 0 && (
                <span className="px-1 py-0.5 rounded bg-emerald-500/15 text-emerald-300 text-[8px] font-black border border-emerald-500/30 tracking-wider"
                  title="Direct CoinDCX RT feed — 2s direct poll / WS event push (board snapshot nahi)">⚡ LIVE</span>
              )}
              {/* v10.11 (#1): source-transparency — WHICH upstream is serving
                  this live price right now (CoinDCX·RT / Finnhub·RT /
                  Yahoo·delayed / Binance·RT / SIM·synthetic). */}
              {liveLtp != null && liveLtp > 0 && <LiveSourceBadge src={liveSrc} />}
            </span>
            {signal.changePct != null && (
              <span className={`font-mono font-bold ${(signal.changePct ?? 0) >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                {(signal.changePct ?? 0) >= 0 ? '+' : ''}{signal.changePct?.toFixed(2)}%
              </span>
            )}
            {/* v10.10: live price vs plan-entry distance — the honest "is the
                call still fresh" check. Plan entry is a LIMIT level; if live
                has drifted, the chip says by how much (amber ≥0.5%, red ≥1.5%). */}
            {(() => {
              if (liveLtp == null || !(liveLtp > 0) || !plan || !(plan.entry > 0)) return null;
              const d = (liveLtp / plan.entry - 1) * 100;
              if (Math.abs(d) < 0.25) return null; // noise floor
              const cls = Math.abs(d) >= 1.5
                ? 'bg-red-500/15 text-red-300 border-red-500/40'
                : Math.abs(d) >= 0.5
                  ? 'bg-amber-500/15 text-amber-300 border-amber-500/40'
                  : 'bg-slate-700/40 text-slate-300 border-slate-600/40';
              return (
                <span className={`px-1.5 py-0.5 rounded text-[9px] font-bold border font-mono ${cls}`}
                  title={`Live price plan entry se ${d >= 0 ? '+' : ''}${d.toFixed(2)}% door hai. Entry ek LIMIT level hai — ticket me wahi price use hota hai; plan 60s cadence par refresh hota hai.`}>
                  ⚡ live {d >= 0 ? '+' : ''}{d.toFixed(2)}% vs entry
                </span>
              );
            })()}
            <span className="text-slate-500">·</span>
            <span>{signal.participating}/{signal.totalModels} models</span>
            <span className="text-slate-500">·</span>
            <span>{Math.round((signal.agreement || 0) * 100)}% agree</span>
            {signal.participation != null && (
              <>
                <span className="text-slate-500">·</span>
                <span title="share of committee weight that cast a directional vote">{Math.round(signal.participation * 100)}% quorum</span>
              </>
            )}
          </div>
        </div>
        <div className="flex gap-1.5">
          {(onExecute || onExecuteIndia || onExecuteFutures || onExecuteGlobal) && plan && actionable && (
            <button onClick={() => setTicketOpen(v => !v)}
              title={signal.market === 'GLOBALFUTURES'
                ? 'Size, USDC risk/reward, leverage — sab pre-computed, one-click execute'
                : signal.market === 'FUTURES'
                  ? 'Size, USDT risk/reward, leverage — sab pre-computed, one-click execute'
                  : signal.market === 'CRYPTO'
                    ? 'Size, ₹ risk/reward, leverage — sab pre-computed, one-click execute'
                    : 'Size, ₹ risk/reward — sab pre-computed, one-click execute'}
              className={`px-2.5 py-1.5 rounded-lg text-[11px] font-black border-2 transition-all ${ticketOpen
                ? 'bg-cyan-500/25 text-cyan-200 border-cyan-400/60'
                : 'bg-gradient-to-r from-cyan-600/80 to-indigo-600/80 text-white border-cyan-400/40 hover:from-cyan-500 hover:to-indigo-500'}`}
              aria-expanded={ticketOpen}>
              {ticketOpen ? '▲ Ticket' : '🚀 TRADE'}
            </button>
          )}
          {signal.market === 'INDIA' && plan && (
            <button onClick={() => setSlipOpen(v => !v)} disabled={!actionable && !slipOpen}
              title={actionable ? 'Risk-sized order slip with entry/SL/targets — copy to your broker terminal' : 'Trade slips are for ACTION/STRONG signals'}
              className={`quantum-btn-ghost px-2.5 py-1.5 rounded-lg text-[11px] font-black ${actionable ? '' : 'opacity-50'}`}
              aria-expanded={slipOpen}>
              {slipOpen ? '▲ Slip' : '📋 Slip'}
            </button>
          )}
          <button onClick={() => setExpanded(v => !v)}
            className="quantum-btn-ghost px-2.5 py-1.5 rounded-lg text-[11px] font-bold"
            aria-expanded={expanded}>
            {expanded ? '▲ Less' : '▼ Models'}
          </button>
          {onDeep && (
            <button onClick={() => onDeep(signal)} className="quantum-btn-ghost px-2.5 py-1.5 rounded-lg text-[11px] font-bold" title="Deep analysis">🔬</button>
          )}
        </div>
      </div>

      {/* v6.12 PRO TRADER BRAIN — quality chips: the honest WHY behind the grade */}
      {signal.quality && <QualityChips quality={signal.quality} voters={signal.voters ?? signal.participating} total={signal.totalModels} stopFloored={signal.plan?.stopFloored} />}

      {/* v10.5 MTF CONFLUENCE (Upgrade 1) — the 5m/15m/1h tape reads
          + agreement % (India signals with the flag ON; renders nothing
          when the payload is absent — honest degrade). */}
      {signal.mtf && <div className="mt-1.5"><MTFConfluenceBadge mtf={signal.mtf} /></div>}

      {/* v10.15 GAP 2 — the EVENT CHIP: ⚠ Earnings in 2h / ⚠ FOMC 30m.
          The same eventGuard truth the auto-agent's entry gauntlet uses;
          red when the entry would be BLOCKED, amber when sized down. */}
      {signal.event && (
        <div className="mt-1.5 flex items-center gap-1.5">
          <span
            className={`px-1.5 py-0.5 rounded border text-[9px] font-black ${signal.event.blocked
              ? 'bg-red-500/15 text-red-300 border-red-500/40'
              : 'bg-amber-500/15 text-amber-300 border-amber-500/40'}`}
            title={`${signal.event.label} in ${signal.event.inMin}m${signal.event.approximate ? ' (approximate date)' : ''}${signal.event.blocked ? ' — agent entries BLOCKED (pre-event blackout)' : signal.event.haircut != null ? ` — agent sizing ×${signal.event.haircut}` : ''} — manual trader ko same warning milta hai jo auto-agent ko milta hai`}
          >
            ⚠ {signal.event.label} {signal.event.inMin >= 60 ? `${Math.round(signal.event.inMin / 60)}h` : `${signal.event.inMin}m`}{signal.event.approximate ? '~' : ''}{signal.event.blocked ? ' · ENTRY BLOCKED' : signal.event.haircut != null ? ` · size ×${signal.event.haircut}` : ''}
          </span>
        </div>
      )}

      {/* v11.0 GLOBAL MARKET COUNCIL — the 6 specialist seats' verdict
          + precision-gate chip (renders only when AI_ENABLE_GLOBAL_COUNCIL
          stamped this signal; suppressed verdicts carry their reasons). */}
      {signal.council && <div className="mt-1.5"><CouncilStrip council={signal.council} expanded={expanded} /></div>}

      {/* v13.1 SIGNAL VERIFICATION AGENT — the full 10-point pro checklist
          (deep payloads carry it; board-level compact wire has fails/warns
          only, which renders the badge above but not the checklist). */}
      {expanded && signal.verify && <VerifyChecklist v={signal.verify} />}
      {/* v20.9.2 — the deep-dive ultrafast micro-checklist (full payload
          rides the DEEP path; board wires carry the compact chip only). */}
      {expanded && signal.ultrafast && <UltrafastChecklist v={signal.ultrafast} />}

      {/* v10.6 ORDER-FLOW DEPTH (Pro Upgrade #1) — the L2 ladder the
          VolumeFlow seat read: top-5 book, two-band imbalance, walls,
          spoof flag. 2s live poll while the card is rendered (the
          server's 2s cache dedupes N viewers into one upstream call).
          GLOBALFUTURES has no CoinDCX book — no widget there. */}
      {(signal.market === 'INDIA' || signal.market === 'CRYPTO' || signal.market === 'FUTURES') && (
        <div className="mt-1.5">
          {/* v10.10: ladder anchors on the LIVE direct-CoinDCX LTP when the stream has a tick (snapshot fallback). */}
          <DepthLadder market={signal.market} symbol={signal.symbol} ltp={(liveLtp != null && liveLtp > 0 ? liveLtp : signal.ltp)} />
        </div>
      )}

      {/* v9 SUPERINTELLIGENCE BLUEPRINT — entry window · leverage ·
          staged exit · exit clock: the complete pro-trader ticket. */}
      {si && <SuperIntelStrip signal={signal} si={si} />}

      {/* v20.2 PRICE CHART — the plan, VISUALLY: candles + entry/SL/T1/T2
          overlay lines (5m/15m/1h/1d toggle). Lazy — fetch + render only
          when the user opens it, so a 10-card board stays light. */}
      {plan && (
        <div className="mt-2">
          <button onClick={() => setChartOpen(v => !v)}
            className={`w-full text-left px-2 py-1 rounded-lg text-[9px] font-black border transition-colors ${chartOpen ? 'bg-cyan-500/15 text-cyan-200 border-cyan-400/40' : 'bg-slate-800/40 text-slate-400 border-slate-700/40 hover:text-slate-200'}`}>
            📈 {chartOpen ? 'HIDE CHART' : 'PRICE CHART — candles + plan levels (5m/15m/1h/1d)'}
          </button>
          {chartOpen && (
            <div className="mt-1.5">
              <CandleChart symbol={signal.symbol} market={signal.market} ltp={(liveLtp != null && liveLtp > 0 ? liveLtp : signal.ltp)} plan={plan} compact side={signal.side} />
            </div>
          )}
        </div>
      )}

      {/* Trade plan strip */}
      {plan && (
        <>
          <div className="grid grid-cols-2 sm:grid-cols-5 gap-1.5 mt-3">
            {[
              { l: 'ENTRY', v: px(plan.entry, curFor(signal.market)), c: 'text-cyan-300' },
              { l: `STOP ${plan.riskPct != null ? `(${plan.riskPct.toFixed(2)}%)` : ''}`, v: px(plan.stopLoss, curFor(signal.market)), c: 'text-red-300' },
              { l: 'TARGET 1', v: px(plan.target1, curFor(signal.market)), c: 'text-emerald-300' },
              { l: 'TARGET 2', v: px(plan.target2, curFor(signal.market)), c: 'text-emerald-400' },
              { l: 'R:R', v: `1:${plan.rewardRisk}`, c: 'text-amber-300' },
            ].map(x => (
              <div key={x.l} className="bg-black/30 rounded-lg px-2 py-1.5 text-center">
                <div className="text-[8px] text-slate-500 font-black tracking-wider">{x.l}</div>
                <div className={`text-xs font-mono font-bold ${x.c}`}>{x.v}</div>
              </div>
            ))}
          </div>
          {/* v6.4 risk-fit transparency */}
          {plan.riskClamped && (
            <div className="mt-1.5 px-2.5 py-1.5 rounded-lg bg-amber-500/[0.07] border border-amber-500/25 text-[10px] font-bold text-amber-300/90 leading-relaxed">
              ⚙️ Auto-fitted: structural ATR stop was {plan.originalRiskPct?.toFixed(2)}% (over the {riskCapPct ?? 5}% cap) → SL tightened to {plan.riskPct?.toFixed(2)}%, targets re-derived. Execute par SL server-side fir se fit hota hai — koi reject nahi.
            </div>
          )}
          {!plan.riskClamped && overCap && (
            <div className="mt-1.5 px-2.5 py-1.5 rounded-lg bg-amber-500/[0.07] border border-amber-500/25 text-[10px] font-bold text-amber-300/90 leading-relaxed">
              ⚙️ Stop {plan.riskPct?.toFixed(2)}% &gt; {riskCapPct}% cap — PAPER pe click karne par server isse auto-fit kar dega (SL cap pe, targets re-derived). LIVE me mild overshoot hi fit hota hai.
            </div>
          )}
        </>
      )}

      {/* v18.6.1 Fix 4 — BETWEEN-CYCLE live-price invalidation: the SSE
          liveLtp (already freshness-gated: ticks >30s old are dropped by
          useCxLivePrices) is checked against the frozen plan on EVERY
          tick — the board recompute is ~60s, fast adverse moves get
          caught immediately. INVALIDATED = live price already through SL
          (red) · WEAKENING = >0.5×ATR past the far entry-zone edge
          (amber). Informative only — honest degrade, never fake-block. */}
      {(() => {
        if (!(liveLtp != null && liveLtp > 0) || !plan) return null;
        const zone = si?.blueprint?.entryZone;
        const inv = liveInvalidationCheck({
          side: signal.side,
          liveLtp,
          stopLoss: plan.stopLoss,
          entryZoneLow: zone && zone[0] != null ? zone[0] : null,
          entryZoneHigh: zone && zone[1] != null ? zone[1] : null,
          atr: Number.isFinite(plan.atrUsed) && plan.atrUsed > 0 ? plan.atrUsed : null,
        });
        if (inv.status === 'ok') return null;
        const hard = inv.status === 'invalidated';
        return (
          <div data-testid="live-invalidation-strip"
            title="Ye check har live tick par chalta hai (board recompute ka ~60s wait nahi). Entry zone = pullback window ka adverse edge — price usse 0.5×ATR+ door = plan ka entry window guzar chuka hai. Trade buttons informative-warn ke saath ON hain — final call aapka."
            className={`mt-1.5 px-2.5 py-1.5 rounded-lg border text-[10px] font-bold leading-relaxed ${hard ? 'bg-red-500/[0.09] border-red-500/40 text-red-300' : 'bg-amber-500/[0.07] border-amber-500/30 text-amber-300/90'}`}>
            {hard ? '⛔ PLAN INVALIDATED' : '⚠ Plan weakening'} — {inv.reason} · live {px(liveLtp, curFor(signal.market))} vs SL {px(plan.stopLoss, curFor(signal.market))} · next board cycle (≤60s) re-plan karega.
          </div>
        );
      })()}

      {/* v6.6: SIMPLE TRADE TICKET (all desks) */}
      {ticketOpen && plan && actionable && (onExecute || onExecuteIndia || onExecuteFutures || onExecuteGlobal) && (
        <SimpleTradeTicket
          signal={signal} busy={busy} gatePaper={gatePaper}
          onExecute={onExecute} onExecuteIndia={onExecuteIndia} onExecuteFutures={onExecuteFutures} onExecuteGlobal={onExecuteGlobal}
          canLive={canLive} canLiveIndia={canLiveIndia}
          maxLeverage={signal.market === 'INDIA' ? 1 : (maxLeverage ?? 1)}
          defaultBudgetINR={signal.market === 'CRYPTO' ? orderBudgetINR : signal.market === 'FUTURES' || signal.market === 'GLOBALFUTURES' ? 10 : (indiaBudgetINR ?? 5000)}
          serverCapINR={signal.market === 'CRYPTO' ? (orderBudgetINR ?? 1000) : signal.market === 'FUTURES' || signal.market === 'GLOBALFUTURES' ? undefined : (indiaBudgetINR ?? 5000)} />
      )}

      {/* v6.4: India trade slip (manual broker flow) */}
      {signal.market === 'INDIA' && slipOpen && plan && (
        <IndiaTradeSlip signal={signal} />
      )}

      {/* v6.4: crypto order preview (v18.9: hidden while the trade ticket
          is open — budget@1× preview + margin×lev ticket on the same card
          showed two conflicting qty/₹ blocks) */}
      {signal.market === 'CRYPTO' && onExecute && !ticketOpen && (
        <CryptoOrderPreview signal={signal} budgetINR={orderBudgetINR} />
      )}

      {/* Model votes */}
      {expanded && (
        <div className="mt-3 space-y-2.5">
          <div className="flex flex-wrap gap-1.5">
            {signal.votes.map(v => <VoteChip key={v.id} vote={v} />)}
          </div>
          <div className="max-h-48 overflow-y-auto space-y-1.5 pr-1">
            {signal.votes.filter(v => v.dir !== 0 || v.reasons.length).map(v => (
              <div key={v.id} className="bg-black/20 rounded-lg px-3 py-2">
                <div className="flex items-center gap-2">
                  <span className="text-[11px] font-bold text-slate-200">{v.name}</span>
                  <span className={`text-[10px] font-black ${sideColor(v.dir > 0 ? 'LONG' : v.dir < 0 ? 'SHORT' : 'FLAT')}`}>
                    {v.dir > 0 ? 'BULL' : v.dir < 0 ? 'BEAR' : 'ABSTAIN'} {v.conf}%
                  </span>
                </div>
                {v.reasons.length > 0 && (
                  <ul className="mt-1 text-[11px] text-slate-400 leading-relaxed">
                    {v.reasons.map((r, i) => <li key={i}>• {r}</li>)}
                  </ul>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* AI Council note */}
      {signal.aiNote && (
        <div className="mt-2.5 bg-gradient-to-r from-violet-500/10 to-transparent rounded-xl px-3 py-2 border border-violet-500/20">
          <div className="flex items-center gap-2 text-[10px] font-black text-violet-300 tracking-wider">
            🧠 AI COUNCIL · {signal.aiNote.model || 'LLM'} — {signal.aiNote.verdict}
          </div>
          {signal.aiNote.analysis && <p className="text-[11px] text-slate-300 mt-1 leading-relaxed">{signal.aiNote.analysis}</p>}
        </div>
      )}

      {/* v18.6.1 Fix 3b — STALE paper-trade confirm bar: stale signal ka
          paper click yahan rukta hai. Recheck karo → deep re-analysis
          (onDeep); Proceed anyway → original action fires. Fresh signals
          seedha chalte hain (zero friction). */}
      {pendingPaper && (
        <div data-testid="stale-confirm-bar" className="mt-3 flex items-center gap-2 flex-wrap rounded-xl border border-amber-500/40 bg-amber-500/10 px-3 py-2">
          <span className="text-[11px] font-bold text-amber-300 leading-snug">
            ⏱ Board ne ye signal {fmtAge(staleAgeMs)} se re-confirm NAHI kiya — purana hai. Entry se pehle deep re-check karo.
          </span>
          <button onClick={() => { setPendingPaper(null); onDeep?.(signal); }}
            title="Deep re-analysis abhi chalao — fresh 14-model vote + MTF-6 + SVA verdict"
            className="px-2.5 py-1 rounded-lg text-[11px] font-black bg-gradient-to-r from-cyan-600 to-indigo-600 text-white hover:from-cyan-500 hover:to-indigo-500">🔬 Recheck karo</button>
          <button onClick={() => { const act = pendingPaper; setPendingPaper(null); act?.(); }}
            title="Confirm karke paper trade chalao (purane levels par hi)"
            className="px-2.5 py-1 rounded-lg text-[11px] font-black border border-amber-500/50 text-amber-200 hover:bg-amber-500/20">Proceed anyway →</button>
          <button onClick={() => setPendingPaper(null)} className="text-[11px] text-slate-500 hover:text-slate-300 px-1" title="Cancel">✕</button>
        </div>
      )}

      {/* Execution buttons (crypto — CoinDCX gauntlet) */}
      {signal.market === 'CRYPTO' && onExecute && !ticketOpen && (
        <div className="mt-3 flex flex-wrap gap-2">
          <button
            onClick={() => gatePaper(() => onExecute(signal, 'paper'))}
            disabled={busy}
            className="quantum-btn-primary px-4 py-2 rounded-xl text-xs font-black bg-gradient-to-r from-cyan-600 to-indigo-600 disabled:opacity-50">
            🧪 PAPER TRADE
          </button>
          {signal.grade === 'STRONG' && signal.executable && (
            <button
              onClick={() => onExecute(signal, 'live')}
              disabled={busy || !canLive}
              title={canLive ? 'Place a REAL CoinDCX order (all gates re-verified server-side)' : 'Signal is STRONG — enable LIVE mode in the console to arm execution'}
              className="px-4 py-2 rounded-xl text-xs font-black bg-gradient-to-r from-emerald-600 to-teal-600 text-white hover:from-emerald-500 hover:to-teal-500 disabled:opacity-40 disabled:cursor-not-allowed transition-colors">
              ⚡ EXECUTE LIVE ₹
            </button>
          )}
          {signal.grade !== 'STRONG' && (
            <span className="text-[10px] text-slate-500 self-center px-1">LIVE execution locked — needs STRONG (75%+ conf, 70%+ agreement)</span>
          )}
        </div>
      )}

      {/* Execution buttons (global futures — CoinDCX perps gauntlet, v9.0.2
          one-click PAPER added: futures cards had NO quick paper button, only
          the sized ticket — paper practice should always be one click away).
          v21.3.0 (Issue-4): ⚡ EXECUTE LIVE ab PRE-FLIGHT MODAL kholta hai
          (dry-run gauntlet + would-be ticket + hold-to-confirm) — accidental
          click se real order kabhi nahi lagta; paper flow frictionless hi hai. */}
      {signal.market === 'FUTURES' && onExecuteFutures && !ticketOpen && (
        <div className="mt-3 flex flex-wrap gap-2">
          <button
            onClick={() => gatePaper(() => onExecuteFutures(signal, 'paper'))}
            disabled={busy}
            className="quantum-btn-primary px-4 py-2 rounded-xl text-xs font-black bg-gradient-to-r from-violet-600 to-fuchsia-600 disabled:opacity-50">
            🧪 PAPER TRADE
          </button>
          {signal.grade === 'STRONG' && signal.executable && (
            <button
              onClick={() => {
                if (onPrecheckFutures) setLiveModalOpen(true); // v21.3.0: pre-flight modal
                else onExecuteFutures(signal, 'live'); // fallback: no precheck wired → direct (legacy)
              }}
              disabled={busy || !canLive}
              title={canLive ? 'Pre-flight checklist + would-be ticket dekho — hold-to-confirm se REAL order jaata hai' : 'Signal is STRONG — enable LIVE mode in the console to arm execution'}
              data-testid="execute-live-btn"
              className="px-4 py-2 rounded-xl text-xs font-black bg-gradient-to-r from-emerald-600 to-teal-600 text-white hover:from-emerald-500 hover:to-teal-500 disabled:opacity-40 disabled:cursor-not-allowed transition-colors">
              ⚡ EXECUTE LIVE ₮
            </button>
          )}
          {signal.grade !== 'STRONG' && (
            <span className="text-[10px] text-slate-500 self-center px-1">LIVE execution locked — needs STRONG (75%+ conf, 70%+ agreement)</span>
          )}
        </div>
      )}

      {/* v21.3.0 (Issue-4): the LIVE pre-flight modal — dry-run gauntlet +
          would-be ticket + hold-to-confirm. Unmounts on close (state reset). */}
      {liveModalOpen && onExecuteFutures && signal.market === 'FUTURES' && (
        <LiveExecuteModal
          signal={signal}
          onPrecheck={onPrecheckFutures || (async () => null)}
          onExecute={async (s) => {
            const r = await onExecuteFutures(s, 'live');
            const o = (r && typeof r === 'object') ? r : {};
            return { ok: o.ok === true, error: o.error, note: o.note };
          }}
          onClose={() => setLiveModalOpen(false)}
        />
      )}

      {signal.market === 'GLOBALFUTURES' && onExecuteGlobal && !ticketOpen && (
        <div className="mt-3 flex flex-wrap gap-2 items-center">
          <button
            onClick={() => gatePaper(() => onExecuteGlobal(signal, 'paper'))}
            disabled={busy}
            title="Practice journal position on the SIM desk — watcher SL/TP + trailing + partial-TP se manage hota hai (Yahoo quotes; SPACEX synthetic)"
            className="quantum-btn-primary px-4 py-2 rounded-xl text-xs font-black bg-gradient-to-r from-sky-600 to-blue-600 disabled:opacity-50">
            🧪 PAPER TRADE
          </button>
          <button
            onClick={() => onExecuteGlobal(signal, 'notify')}
            disabled={busy}
            title="Notify-only: gauntlet pass → Telegram alert + journal audit, koi position nahi"
            className="px-4 py-2 rounded-xl text-xs font-black bg-gradient-to-r from-amber-600 to-orange-600 text-white hover:from-amber-500 hover:to-orange-500 disabled:opacity-50 transition-colors">
            🔔 NOTIFY
          </button>
          <span className="text-[10px] text-slate-500 self-center px-1" title="CoinDCX par AAPL/MSFT/GOOGL/NVDA/TSLA/META/SPACEX contracts listed nahi hain — ye SIM desk hai: signals REAL data par, execution paper/notify only">🌍 SIM desk — signals real data par · execution PAPER only</span>
        </div>
      )}

      {/* Execution buttons (India — Dhan gauntlet, v6.5; v9.0.2: PAPER
          always visible — the old actionable gate hid the paper button on
          WATCH cards and dead-ended India practice entirely).
          v9.1: 📈 DESK PAPER — same levels, but opened in the server-managed
          Paper Desk simulator (T1 50% book + breakeven trail + SL/T2/EOD
          auto-exit, tracked in the 08 PAPER DESK section). */}
      {signal.market === 'INDIA' && onExecuteIndia && !ticketOpen && (
        <div className="mt-3 flex flex-wrap gap-2">
          <button
            onClick={() => gatePaper(() => onExecuteIndia(signal, 'paper'))}
            disabled={busy}
            title="Practice journal position — watcher SL/TP + trailing se manage hota hai"
            className="quantum-btn-primary px-4 py-2 rounded-xl text-xs font-black bg-gradient-to-r from-orange-600 to-amber-600 disabled:opacity-50">
            🧪 PAPER TRADE
          </button>
          {onPaperTrade && plan && (
            <button
              onClick={() => gatePaper(() => onPaperTrade(signal))}
              disabled={busy || paperOpenForSymbol}
              title={paperOpenForSymbol
                ? 'Is symbol par already ek Paper Desk trade khula hai — duplicate server-side blocked hai (08 PAPER DESK me dekho/close karo)'
                : 'Paper Desk simulator me kholo — server-managed: T1 par 50% book + breakeven trail + SL/T2/EOD auto-exit · position 08 PAPER DESK section me track hogi (live P&L + history)'}
              className="px-4 py-2 rounded-xl text-xs font-black bg-gradient-to-r from-purple-600 to-fuchsia-600 text-white hover:from-purple-500 hover:to-fuchsia-500 disabled:opacity-40 disabled:cursor-not-allowed transition-colors">
              {paperOpenForSymbol ? '✓ PAPER OPEN' : '📈 DESK PAPER'}
            </button>
          )}
          {signal.grade === 'STRONG' && (
            <button
              onClick={() => onExecuteIndia(signal, 'live')}
              disabled={busy || !canLiveIndia}
              title={canLiveIndia ? 'REAL Dhan order: market entry + broker SL-M, square-off 15:15 IST (all gates re-verified server-side)' : 'STRONG hai — Dhan connect + India LIVE arm console me karo'}
              className="px-4 py-2 rounded-xl text-xs font-black bg-gradient-to-r from-emerald-600 to-teal-600 text-white hover:from-emerald-500 hover:to-teal-500 disabled:opacity-40 disabled:cursor-not-allowed transition-colors">
              ⚡ EXECUTE LIVE ₹
            </button>
          )}
          {signal.grade !== 'STRONG' && (
            <span className="text-[10px] text-slate-500 self-center px-1">India LIVE = STRONG signals only · PAPER hamesha open (practice plan @ live price par)</span>
          )}
        </div>
      )}
    </div>
  );
});
