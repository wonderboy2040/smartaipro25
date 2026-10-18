// ============================================================
// src/components/aitrading/deepAnalysisExtras.tsx — v20.7.9
// ------------------------------------------------------------
// THE DEEP ENSEMBLE ANALYSIS ACCURACY UPGRADE (the user's "deep
// analysis galat / purana info dikhati hai" fix, superintelligence
// edition). Three pieces, shared by BOTH desks' deep modals:
//
//  1. useDeepAutoRecheck — while the modal is open, the analysis
//     RE-RUNS ITSELF every 15s (cache-riding, the user's "every
//     15 sec recheck" ask applied to the open analysis itself).
//     Grade/side/confidence transitions land in a visible log —
//     "STRONG LONG 82% → ACTION LONG 71%" is now SEEN, not felt.
//  2. DeepFreshnessChip — "RECHECKED Xs ago · AUTO 15s" — the
//     data's age is a first-class citizen (the #1 source of
//     "inaccurate" reads was a 30s-old answer next to a live
//     price, with no way to tell).
//  3. DeepIndicatorGrid — the FULL transparency snapshot: the
//     classic stack (RSI/ADX/MACD/EMA/Bollinger/ATR/VWAP/…) AND
//     the v20.7.4 confluence stack (Fib golden pocket · Volume
//     Profile POC/VAH/VAL · chart patterns · supply/demand zones
//     · price-action stats · EMA100/200). Every number the 12
//     committee seats voted on, on the table.
// ============================================================
import { memo, useCallback, useEffect, useState } from 'react';
import type { AISignal, MarketKind } from './types';
import type { DeepSignalResult } from './useAITrading';

const DEEP_RECHECK_SEC = 15;

export interface DeepModalState {
  loading: boolean;
  signal?: AISignal;
  /** v20.7.9: the EXACT board signal the user clicked 🔬 on — pinned
   *  so the deep modal renders the original card + a LIVE re-verification
   *  comparison instead of silently swapping in a drifted re-run (the
   *  "Signal Board ka data alag" complaint). */
  pinned?: AISignal | null;
  /** v20.7.9: when the pin happened (click time, epoch ms) — drives the
   *  "BOARD CARD age" label in the compare block. */
  pinnedAt?: number | null;
  indicators?: Record<string, unknown>;
  narrative?: DeepSignalResult['narrative'];
  ltf?: DeepSignalResult['ltf'];
  edge?: DeepSignalResult['edge'];
  error?: string;
  /** v20.7.5: server compute stamp of the payload being viewed. */
  recheckedAt?: number | null;
}

export interface DeepLogEntry { at: number; note: string; tone: 'bad' | 'good' | 'info'; }

const GRADE_RANK: Record<string, number> = { NEUTRAL: 0, WATCH: 1, ACTION: 2, STRONG: 3 };
const num = (v: unknown): number | null => (v != null && Number.isFinite(Number(v)) ? Number(v) : null);
const fmt = (v: number | null | undefined, d = 2): string => (v == null ? '—' : v.toFixed(d));

// ------------------------------------------------------------
// v20.7.9: the PIN gate — only a REAL board signal (side + grade +
// numeric confidence) is worth pinning. The Expert/Top-picks stubs
// ({symbol, market} casts) render nothing useful as a card, so those
// deep dives stay pin-less (fresh run only, exactly the old UX).
// ------------------------------------------------------------
export function isPinnableSignal(s: AISignal | null | undefined): boolean {
  return !!(s && s.symbol && s.side && s.grade && typeof s.confidence === 'number' && Number.isFinite(s.confidence));
}

export interface DeepPinVerdict {
  verdict: 'CONFIRMED' | 'DRIFTED' | 'FLIPPED' | 'UNKNOWN';
  sameSide: boolean;
  side: string | null;
  grade: string | null;
  gradeDir: 'up' | 'down' | 'flat' | null;
  confDrift: number | null;
  aiScorePinned: number | null;
  aiScoreLive: number | null;
  aiScoreDrift: number | null;
  planPinned: { entry: number | null; sl: number | null; t1: number | null; t2: number | null } | null;
  planLive: { entry: number | null; sl: number | null; t1: number | null; t2: number | null } | null;
  note: string;
}

/**
 * v20.7.9 PURE verdict engine — ORIGINAL (pinned) vs LIVE re-run.
 * Exported for the regression suite; the modal renders DeepPinnedCompare
 * from this. Thresholds:
 *   UNKNOWN  — live re-run ne side hi nahi diya (data gap / neutral
 *              no-call) — over-alarm NAHI (v20.7.12 [M-8]: pehle empty
 *              live side FLIPPED bol deta tha — "thesis dead" jabki sirf
 *              recheck incomplete tha)
 *   FLIPPED  — opposite side (the original thesis is dead)
 *   DRIFTED  — same side but (grade changed OR |Δconf| ≥ 8 OR
 *              |Δ AI score| ≥ 8 OR plan entry moved ≥ 1.5%)
 *   CONFIRMED — same side, everything within tolerance
 */
export function deepPinVerdict(pinned: AISignal, live: AISignal): DeepPinVerdict {
  const sideP = String(pinned.side || '').toUpperCase();
  const sideL = String(live.side || '').toUpperCase();
  const confP = num(pinned.confidence);
  const confL = num(live.confidence);
  const confDrift = confP != null && confL != null ? confL - confP : null;
  const aiP = num(pinned.superIntel?.aiScore);
  const aiL = num(live.superIntel?.aiScore);
  const aiDrift = aiP != null && aiL != null ? aiL - aiP : null;
  const grP = GRADE_RANK[pinned.grade] ?? 0;
  const grL = GRADE_RANK[live.grade] ?? 0;
  const gradeDir = grL > grP ? 'up' : grL < grP ? 'down' : 'flat';
  const planOf = (s: AISignal): DeepPinVerdict['planPinned'] => {
    const p = s.plan;
    if (!p) return null;
    return { entry: num(p.entry), sl: num(p.stopLoss), t1: num(p.target1), t2: num(p.target2) };
  };
  const planP = planOf(pinned);
  const planL = planOf(live);
  let entryMovedPct: number | null = null;
  if (planP?.entry != null && planL?.entry != null && planP.entry > 0) {
    entryMovedPct = Math.abs((planL.entry - planP.entry) / planP.entry) * 100;
  }
  const drifted = gradeDir !== 'flat'
    || (confDrift != null && Math.abs(confDrift) >= 8)
    || (aiDrift != null && Math.abs(aiDrift) >= 8)
    || (entryMovedPct != null && entryMovedPct >= 1.5);
  // v20.7.12 [M-8]: live side MISSING → UNKNOWN (honest "no verdict"),
  // FLIPPED nahi. sirf EXPLICIT opposite side hi FLIPPED hai.
  const verdict: DeepPinVerdict['verdict'] = !sideL || !sideP
    ? 'UNKNOWN'
    : sideP !== sideL ? 'FLIPPED' : drifted ? 'DRIFTED' : 'CONFIRMED';
  const sameSide = !!sideP && !!sideL && sideP === sideL;
  const note = verdict === 'UNKNOWN'
    ? 'LIVE re-run ne abhi side nahi diya (data gap / neutral no-call) — board card reference bana rahe, entry se pehle recheck aane do.'
    : !sameSide
      ? `LIVE re-run ne side ulat di (${sideP} → ${sideL}) — original thesis ab valid NAHI hai, entry mat karo.`
      : verdict === 'DRIFTED'
        ? 'Same side, par numbers hil gaye — entry/SL/targets LIVE column se lo, board card purana tha.'
        : 'Same side, same levels — original signal abhi bhi VALID hai.';
  return {
    verdict, sameSide, side: sideL || null, grade: live.grade || null, gradeDir,
    confDrift, aiScorePinned: aiP, aiScoreLive: aiL, aiScoreDrift: aiDrift,
    planPinned: planP, planLive: planL, note,
  };
}

/**
 * The 15s self-recheck of an OPEN deep modal.
 * - every 15s re-fetches the analysis (server cache rides ~50% of
 *   calls; the other half is a fresh ensemble run)
 * - side/grade/confidence transitions append to the visible log
 * - a stale response (modal closed / re-opened mid-flight) is dropped
 *   by the SAME request-token discipline the manual open uses
 * - v20.7.12 [H2-3]: DE-TICKED — pehle 1s setNextInS POORE TAB ko har
 *   second re-render karta tha (hook tab-level state me tha). Ab sirf
 *   `nextRecheckAt` TIMESTAMP 15s boundary pe update hota hai; countdown
 *   ki per-second display DeepFreshnessChip ke APNE local force-timer
 *   me compute hoti hai (chhota subtree, tab nahi).
 */
export function useDeepAutoRecheck(
  deep: DeepModalState | null,
  setDeep: React.Dispatch<React.SetStateAction<DeepModalState | null>>,
  fetchDeep: (symbol: string, market: MarketKind, opts?: { fresh?: boolean }) => Promise<DeepSignalResult>,
  reqRef: React.MutableRefObject<number>,
  market: MarketKind,
) {
  const [log, setLog] = useState<DeepLogEntry[]>([]);
  const [nextRecheckAt, setNextRecheckAt] = useState<number | null>(null);
  const [rechecks, setRechecks] = useState(0);
  const sig = deep?.signal && !deep.loading ? deep.signal : null;

  // reset when a NEW analysis opens
  useEffect(() => {
    if (deep?.loading) { setLog([]); setRechecks(0); setNextRecheckAt(null); }
  }, [deep?.loading, sig?.symbol, sig?.market]);  

  const appendLog = useCallback((note: string, tone: DeepLogEntry['tone']) => {
    setLog(l => [{ at: Date.now(), note, tone }, ...l].slice(0, 5));
  }, []);

  useEffect(() => {
    if (!sig) return;
    const symbol = sig.symbol;
    let cancelled = false;
    let elapsed = 0;
    // v20.7.8 [M-7]: compare against the LAST RECHECKED snapshot, not the
    // effect-setup closure. `const prev = sig` measured every recheck
    // against the ORIGINAL open-time signal: the same ≥8pt confidence
    // transition re-logged every 15s, and gradual drift (80→76→72) never
    // logged at all. Now the baseline advances with every applied recheck.
    let last = sig;
    // the recheck pass (fires immediately when the countdown hits 0)
    const run = async () => {
      const id = reqRef.current;
      const r = await fetchDeep(symbol, market, { fresh: false });
      if (cancelled || reqRef.current !== id || !r.ok || !r.signal) return;
      const prev = last;
      const now = r.signal;
      // transitions the user should SEE (the "wrong info" complaint was
      // often the analysis silently drifting while the modal sat open)
      if (prev.side !== now.side) {
        // v20.7.8 [M-7]: the old `now.side === prev.side ? 'info' : 'bad'`
        // ternary was dead code inside this very branch — unreachable.
        // A flip kills the open thesis: always 'bad'.
        appendLog(`SIDE FLIP: ${prev.side} → ${now.side} ${now.grade} ${now.confidence ?? '?'}%`, 'bad');
      } else {
        const pr = GRADE_RANK[prev.grade] ?? 0, nr = GRADE_RANK[now.grade] ?? 0;
        if (nr < pr) appendLog(`GRADE ↓ ${prev.grade} ${prev.confidence ?? '?'}% → ${now.grade} ${now.confidence ?? '?'}%`, 'bad');
        else if (nr > pr) appendLog(`GRADE ↑ ${prev.grade} → ${now.grade} ${now.confidence ?? '?'}%`, 'good');
        else if (Math.abs((now.confidence ?? 0) - (prev.confidence ?? 0)) >= 8) {
          appendLog(`conf ${prev.confidence ?? '?'}% → ${now.confidence ?? '?'}%`, (now.confidence ?? 0) < (prev.confidence ?? 0) ? 'info' : 'good');
        }
      }
      last = now; // v20.7.8 [M-7]: advance the comparison baseline
      setRechecks(n => n + 1);
      // v20.7.9: FUNCTIONAL update — the recheck must never drop the
      // pinned signal (a plain replacement object here would un-pin the
      // modal on the first 15s recheck and re-create the exact board-vs-
      // deep mismatch this upgrade fixes).
      setDeep(prev => prev ? {
        ...prev,
        loading: false,
        signal: now,
        indicators: r.indicators,
        narrative: r.narrative,
        ltf: r.ltf,
        edge: r.edge,
        recheckedAt: r.recheckedAt ?? Date.now(),
      } : prev);
      setNextRecheckAt(Date.now() + DEEP_RECHECK_SEC * 1000);
    };
    // 1s ticker: fires the pass at each 15s boundary (countdown display
    // ab chip ke local timer me — tab-level per-second setState NAHI)
    const timer = setInterval(() => {
      // v20.7.8 [M-7]: hidden tab = no rechecks (the one polling pattern
      // this codebase otherwise enforces everywhere — useAITrading,
      // AgentPanel, EngineHealthStrip). The countdown resumes on return;
      // the DATA-age chip honestly shows the staleness until then.
      if (document.hidden) return;
      elapsed += 1;
      if (elapsed % DEEP_RECHECK_SEC === 0) { run().catch(() => {}); }
    }, 1000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [sig?.symbol, sig?.market, sig?.side, sig?.grade, market, fetchDeep, setDeep, appendLog]); // eslint-disable-line react-hooks/exhaustive-deps

  return { log, nextRecheckAt, rechecks };
}

/** "RECHECKED Xs ago · AUTO 15s" — freshness as a first-class chip.
 *  v20.7.12 [H2-3]: countdown ab yahI compute hota hai (nextRecheckAt
 *  timestamp + local 1s force) — poore tab ko har second re-render karne
 *  ki zaroorat khatam. */
export const DeepFreshnessChip = memo(function DeepFreshnessChip({ recheckedAt, nextRecheckAt, rechecks }: { recheckedAt?: number | null; nextRecheckAt: number | null; rechecks: number }) {
  const [, force] = useState(0);
  useEffect(() => {
    const t = setInterval(() => { if (!document.hidden) force(n => n + 1); }, 1000);
    return () => clearInterval(t);
  }, []);
  const ageS = recheckedAt ? Math.max(0, Math.round((Date.now() - recheckedAt) / 1000)) : null;
  const nextInS = nextRecheckAt != null ? Math.max(0, Math.ceil((nextRecheckAt - Date.now()) / 1000)) : null;
  return (
    <div className="flex items-center gap-1.5" title="Deep ensemble analysis khud ko har 15s me recheck karti hai — fresh ensemble run + live transitions ka log. Data ki age hamesha visible hai.">
      <span className="flex items-center gap-1 px-2 py-0.5 rounded-lg text-[9px] font-black border bg-cyan-500/10 text-cyan-300 border-cyan-500/30">
        <span className="w-1.5 h-1.5 rounded-full bg-cyan-400 animate-pulse" />
        AUTO-RECHECK 15s{nextInS != null ? ` · next ${nextInS}s` : ''}
      </span>
      {ageS != null && (
        <span className={`px-2 py-0.5 rounded-lg text-[9px] font-black border ${ageS <= 20 ? 'bg-emerald-500/10 text-emerald-300 border-emerald-500/30' : ageS <= 60 ? 'bg-amber-500/10 text-amber-300 border-amber-500/30' : 'bg-red-500/10 text-red-300 border-red-500/30'}`}>
          DATA {ageS}s old
        </span>
      )}
      {rechecks > 0 && <span className="px-2 py-0.5 rounded-lg text-[9px] font-black border bg-slate-600/20 text-slate-400 border-slate-600/30">↻ {rechecks}</span>}
    </div>
  );
});

/** The visible transition history of the open analysis.
 *  v20.7.12 [H2-3]: memo — tab ke 1.25Hz tick re-renders pe ye subtree
 *  skip hota hai (props stable rehte rechecks ke beech). */
export const DeepTransitionLog = memo(function DeepTransitionLog({ log }: { log: DeepLogEntry[] }) {
  if (!log.length) return null;
  const toneCls = (t: DeepLogEntry['tone']) => t === 'bad' ? 'text-red-300' : t === 'good' ? 'text-emerald-300' : 'text-cyan-300';
  return (
    <div className="mt-3 bg-black/25 rounded-xl p-2.5" aria-label="auto-recheck transitions">
      <div className="text-[10px] font-black text-slate-500 tracking-wider mb-1.5">AUTO-RECHECK TRANSITIONS — khud badla hua analysis, live dikhta hai</div>
      <ul className="space-y-1">
        {log.map((l, i) => (
          <li key={`${l.at}-${i}`} className="flex items-center gap-2 text-[10px] font-mono">
            <span className="text-slate-600">{new Date(l.at).toLocaleTimeString('en-IN', { hour12: false })}</span>
            <span className={toneCls(l.tone)}>{l.note}</span>
          </li>
        ))}
      </ul>
    </div>
  );
});

// ---------------- v20.7.9: the ORIGINAL-vs-LIVE comparison block ----------------

const VERDICT_STYLE: Record<DeepPinVerdict['verdict'], { chip: string; label: string; icon: string }> = {
  CONFIRMED: { chip: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/40', label: 'STILL VALID', icon: '✅' },
  DRIFTED: { chip: 'bg-amber-500/15 text-amber-300 border-amber-500/40', label: 'DRIFTED', icon: '⚠️' },
  FLIPPED: { chip: 'bg-red-500/15 text-red-300 border-red-500/40', label: 'SIDE FLIPPED', icon: '⛔' },
  UNKNOWN: { chip: 'bg-slate-600/20 text-slate-300 border-slate-600/40', label: 'NO VERDICT YET', icon: '❔' },
};

function CompareRow({ k, pinnedV, liveV, tone }: { k: string; pinnedV: string; liveV: string; tone?: 'good' | 'bad' }) {
  const cls = tone === 'good' ? 'text-emerald-300' : tone === 'bad' ? 'text-red-300' : 'text-slate-200';
  return (
    <div className="grid grid-cols-[86px_1fr_1fr] items-center gap-1.5 text-[10px] font-mono">
      <span className="text-slate-500 uppercase truncate">{k}</span>
      <span className="text-slate-400 text-right truncate">{pinnedV}</span>
      <span className={`${cls} text-right truncate font-bold`}>{liveV}</span>
    </div>
  );
}

/**
 * v20.7.9 — the answer to "board ka signal aur deep analysis ka data
 * alag kyun?" rendered ON the modal. The ORIGINAL (pinned) column is
 * the exact card the user clicked; the LIVE column is the fresh
 * re-verification ensemble run (and every 15s auto-recheck refreshes
 * ONLY the live column). One verdict chip on top: STILL VALID /
 * DRIFTED / SIDE FLIPPED.
 */
export const DeepPinnedCompare = memo(function DeepPinnedCompare({ pinned, pinnedAt, live, recheckedAt }: {
  pinned: AISignal;
  pinnedAt?: number | null;
  live: AISignal;
  recheckedAt?: number | null;
}) {
  const v = deepPinVerdict(pinned, live);
  const st = VERDICT_STYLE[v.verdict];
  const [, force] = useState(0);
  useEffect(() => {
    // v20.7.12 [H2-3/L-4]: local force + hidden-gate (age display ke liye
    // hi hai — chhupa tab refresh karke koi fayda nahi)
    const t = setInterval(() => { if (!document.hidden) force(n => n + 1); }, 1000);
    return () => clearInterval(t);
  }, []);
  const pinAgeS = pinnedAt ? Math.max(0, Math.round((Date.now() - pinnedAt) / 1000)) : null;
  const liveAgeS = recheckedAt ? Math.max(0, Math.round((Date.now() - recheckedAt) / 1000)) : null;
  const gradeArrow = v.gradeDir === 'up' ? ' ↑' : v.gradeDir === 'down' ? ' ↓' : '';
  const confTxt = (p: number | null, l: number | null) => {
    if (p == null && l == null) return ['—', '—'];
    const drift = v.confDrift != null && Math.abs(v.confDrift) >= 8 ? ` (${v.confDrift > 0 ? '+' : ''}${Math.round(v.confDrift)})` : '';
    return [p != null ? `${Math.round(p)}%` : '—', l != null ? `${Math.round(l)}%${drift}` : '—'];
  };
  const [confP, confL] = confTxt(pinned.confidence ?? null, live.confidence ?? null);
  const aiTxt = (p: number | null, l: number | null) => {
    if (p == null && l == null) return ['—', '—'];
    const drift = v.aiScoreDrift != null && Math.abs(v.aiScoreDrift) >= 8 ? ` (${v.aiScoreDrift > 0 ? '+' : ''}${Math.round(v.aiScoreDrift)})` : '';
    return [p != null ? String(Math.round(p)) : '—', l != null ? `${Math.round(l)}${drift}` : '—'];
  };
  const [aiP, aiL] = aiTxt(v.aiScorePinned, v.aiScoreLive);
  const px = (n: number | null | undefined) => n != null ? n.toLocaleString('en-IN', { maximumFractionDigits: 2 }) : '—';
  return (
    <div className="mt-3 bg-black/25 border border-slate-700/40 rounded-xl p-3" aria-label="board vs live comparison" data-testid="deep-pinned-compare">
      <div className="flex items-center justify-between gap-2 flex-wrap mb-2">
        <div className="text-[10px] font-black text-slate-400 tracking-wider">
          BOARD CARD vs LIVE RE-VERIFICATION <span className="text-slate-600">— dono ek saath, koi confusion nahi</span>
        </div>
        <span className={`px-2 py-0.5 rounded-lg text-[9px] font-black border tracking-wider ${st.chip}`}>
          {st.icon} {st.label}
        </span>
      </div>
      <div className="grid grid-cols-[86px_1fr_1fr] gap-1.5 text-[9px] font-black text-slate-600 tracking-wider mb-1">
        <span />
        <span className="text-right">BOARD (jise click kiya{pinAgeS != null ? ` · ${pinAgeS}s ago` : ''})</span>
        <span className="text-right">LIVE RE-RUN{liveAgeS != null ? ` · ${liveAgeS}s ago` : ''}</span>
      </div>
      <div className="space-y-1">
        <CompareRow k="side" pinnedV={String(pinned.side || '—')} liveV={String(live.side || '—')} tone={v.sameSide ? 'good' : 'bad'} />
        <CompareRow k="grade" pinnedV={String(pinned.grade || '—')} liveV={`${String(live.grade || '—')}${gradeArrow}`} tone={v.gradeDir === 'down' ? 'bad' : v.gradeDir === 'up' ? 'good' : undefined} />
        <CompareRow k="confidence" pinnedV={confP} liveV={confL} tone={v.confDrift != null && v.confDrift <= -8 ? 'bad' : undefined} />
        <CompareRow k="ai score" pinnedV={aiP} liveV={aiL} tone={v.aiScoreDrift != null && v.aiScoreDrift <= -8 ? 'bad' : undefined} />
        <CompareRow k="entry" pinnedV={px(v.planPinned?.entry)} liveV={px(v.planLive?.entry)} />
        <CompareRow k="stop-loss" pinnedV={px(v.planPinned?.sl)} liveV={px(v.planLive?.sl)} />
        <CompareRow k="target 1" pinnedV={px(v.planPinned?.t1)} liveV={px(v.planLive?.t1)} />
        <CompareRow k="target 2" pinnedV={px(v.planPinned?.t2)} liveV={px(v.planLive?.t2)} />
      </div>
      <div className={`text-[10px] mt-2 font-bold leading-relaxed ${v.verdict === 'FLIPPED' ? 'text-red-300' : v.verdict === 'DRIFTED' ? 'text-amber-300' : v.verdict === 'UNKNOWN' ? 'text-slate-400' : 'text-emerald-300'}`}>
        {st.icon} {v.note}
      </div>
      <div className="text-[9px] text-slate-600 mt-1 leading-relaxed">
        Board card scan-time ka snapshot hai; LIVE re-run abhi ka fresh full-committee ensemble (har 15s auto-refresh). Numbers hilna normal hai — isliye dono columns saath me dikhte hain.
      </div>
    </div>
  );
});

// ---------------- the full transparency grid ----------------
type Rec = Record<string, unknown>;
const asRec = (v: unknown): Rec | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Rec) : null);

function Cell({ k, v, tone }: { k: string; v: string; tone?: 'good' | 'bad' | 'warn' }) {
  const cls = tone === 'good' ? 'text-emerald-300' : tone === 'bad' ? 'text-red-300' : tone === 'warn' ? 'text-amber-300' : 'text-slate-200';
  return (
    <div className="flex justify-between bg-black/30 rounded px-2 py-1 gap-1.5">
      <span className="text-slate-500 uppercase truncate">{k}</span>
      <span className={`${cls} text-right`}>{v}</span>
    </div>
  );
}

/**
 * EVERY indicator the committee seats read — the classic stack +
 * the v20.7.4 confluence stack (Fib · Volume Profile · patterns ·
 * S/D zones · price action · EMA100/200). Missing fields render
 * an honest '—' (feed-level honesty, never a fake number).
 * v20.7.12 [H2-3]: memo — tab ke 1.25Hz tick re-renders pe skip.
 */
export const DeepIndicatorGrid = memo(function DeepIndicatorGrid({ ind }: { ind?: Record<string, unknown> | null }) {
  if (!ind) return null;
  const i = ind;
  const adx = asRec(i.adx);
  const st = asRec(i.stochastic);
  const macd = asRec(i.macd);
  const bb = asRec(i.bollinger);
  const superTrend = asRec(i.supertrend);
  const fib = asRec(i.fib);
  const vp = asRec(i.volumeProfile);
  const sd = asRec(i.supplyDemand);
  const pa = asRec(i.priceAction);
  const patterns = Array.isArray(i.chartPatterns) ? (i.chartPatterns as Rec[]) : [];
  const rsi = num(i.rsi);
  const ema = (k: string) => num(i[k]);
  const emaStack = [ema('ema10'), ema('ema20'), ema('ema50'), ema('ema100'), ema('ema200')];
  const stackKnown = emaStack.filter(v => v != null).length >= 3;
  const stackBull = stackKnown && emaStack.slice(0, 3).every((v, idx, arr) => v != null && (arr[idx - 1] == null || v < (arr[idx - 1] as number))) && (ema('ema10') ?? 0) > (ema('ema20') ?? 0) && (ema('ema20') ?? 0) > (ema('ema50') ?? 0);
  const stackBear = stackKnown && (ema('ema10') ?? 0) < (ema('ema20') ?? 0) && (ema('ema20') ?? 0) < (ema('ema50') ?? 0);

  return (
    <div className="mt-3 bg-black/25 rounded-xl p-3">
      <div className="text-[10px] font-black text-slate-500 tracking-wider mb-2">FULL INDICATOR SNAPSHOT — jo committee ne padha, wahi aap padho</div>

      {/* classic momentum/trend block */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-1.5 text-[10px] font-mono">
        <Cell k="rsi" v={rsi == null ? '—' : fmt(rsi, 1)} tone={rsi == null ? undefined : rsi >= 70 ? 'warn' : rsi <= 30 ? 'warn' : undefined} />
        <Cell k="adx" v={adx ? `${fmt(num(adx.adx), 1)}` : '—'} tone={adx && (num(adx.adx) ?? 0) >= 25 ? 'good' : undefined} />
        <Cell k="di" v={adx && num(adx.plusDI) != null ? `+${fmt(num(adx.plusDI), 1)}/−${fmt(num(adx.minusDI), 1)}` : '—'} />
        <Cell k="macd-h" v={macd && num(macd.hist) != null ? fmt(num(macd.hist), 4) : '—'} tone={macd && (num(macd.hist) ?? 0) > 0 ? 'good' : macd && (num(macd.hist) ?? 0) < 0 ? 'bad' : undefined} />
        <Cell k="stoch" v={st && num(st.k) != null ? `${fmt(num(st.k), 0)}/${fmt(num(st.d), 0)}` : '—'} />
        <Cell k="atr" v={fmt(num(i.atr), 4)} />
        <Cell k="vwap" v={fmt(num(i.vwap), 2)} />
        <Cell k="supertrend" v={superTrend ? (num(superTrend.direction) === 1 ? 'BULL' : num(superTrend.direction) === -1 ? 'BEAR' : '—') : '—'} tone={superTrend && num(superTrend.direction) === 1 ? 'good' : superTrend && num(superTrend.direction) === -1 ? 'bad' : undefined} />
        <Cell k="bb %b" v={(() => { const b = num(bb?.percentB); return b == null ? '—' : `${fmt(b * 100, 0)}%`; })()} />
        <Cell k="mfi" v={fmt(num(i.mfi), 0)} />
        <Cell k="obv-slope" v={num(i.obvSlope) == null ? '—' : (num(i.obvSlope) as number) > 0 ? '↗ accum' : '↘ dist'} tone={num(i.obvSlope) == null ? undefined : (num(i.obvSlope) as number) > 0 ? 'good' : 'bad'} />
        <Cell k="rel-vol" v={num(i.relVolume) == null ? '—' : `${fmt(num(i.relVolume), 2)}×`} tone={num(i.relVolume) != null && (num(i.relVolume) as number) >= 1.5 ? 'good' : undefined} />
        <Cell k="ema10/20" v={ema('ema10') != null && ema('ema20') != null ? `${fmt(ema('ema10'), 2)}/${fmt(ema('ema20'), 2)}` : '—'} />
        <Cell k="ema50" v={fmt(ema('ema50'), 2)} />
        <Cell k="ema100" v={fmt(ema('ema100'), 2)} />
        <Cell k="ema200" v={fmt(ema('ema200'), 2)} />
        <Cell k="ema-stack" v={stackBull ? 'BULL 10>20>50' : stackBear ? 'BEAR 10<20<50' : stackKnown ? 'MIXED' : '—'} tone={stackBull ? 'good' : stackBear ? 'bad' : undefined} />
        <Cell k="roc-10" v={fmt(num(i.roc), 2) + '%'} tone={num(i.roc) == null ? undefined : (num(i.roc) as number) > 0 ? 'good' : 'bad'} />
      </div>

      {/* v20.7.4 confluence stack — the deep in "deep ensemble analysis" */}
      <div className="text-[10px] font-black text-amber-400/80 tracking-wider mt-3 mb-1.5">CONFLUENCE STACK — Fib · Volume Profile · Patterns · S/D · Price Action</div>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-1.5 text-[10px] font-mono">
        <Cell
          k="fib swing"
          v={fib ? `${String(fib.direction).toUpperCase()} · ${fmt(num(fib.positionPct), 0)}%` : '—'}
          tone={fib ? (String(fib.direction) === 'up' ? 'good' : 'bad') : undefined}
        />
        <Cell
          k="golden pocket"
          v={fib && asRec(fib.goldenPocket) ? `${fmt(num(asRec(fib.goldenPocket)?.low), 2)}–${fmt(num(asRec(fib.goldenPocket)?.high), 2)}` : '—'}
          tone={fib?.inGoldenPocket ? 'warn' : undefined}
        />
        <Cell k="in-gp" v={fib ? (fib.inGoldenPocket ? 'YES ✓' : 'no') : '—'} tone={fib?.inGoldenPocket ? 'warn' : undefined} />
        <Cell k="fib bias" v={fib ? (num(fib.bias) === 1 ? 'BULL' : num(fib.bias) === -1 ? 'BEAR' : 'neutral') : '—'} tone={num(fib?.bias) === 1 ? 'good' : num(fib?.bias) === -1 ? 'bad' : undefined} />
        <Cell k="vp poc" v={fmt(num(vp?.poc), 2)} tone={vp ? (vp.priceVsPoc === 'above' ? 'good' : 'bad') : undefined} />
        <Cell k="vp va" v={vp ? `${fmt(num(vp.vah), 2)} / ${fmt(num(vp.val), 2)}` : '—'} />
        <Cell k="price vs poc" v={vp ? String(vp.priceVsPoc).toUpperCase() : '—'} tone={vp?.priceVsPoc === 'above' ? 'good' : vp?.priceVsPoc === 'below' ? 'bad' : undefined} />
        <Cell k="in value-area" v={vp ? (vp.inValueArea ? 'YES ✓' : 'no') : '—'} />
        {patterns.length > 0 ? patterns.slice(0, 2).map((p, idx) => (
          <Cell key={`pat-${idx}`} k={idx === 0 ? 'pattern' : '+'} v={`${String(p.name)} · ${num(p.confidence) ?? '?'}%`} tone={num(p.dir) === 1 ? 'good' : 'bad'} />
        )) : <Cell k="patterns" v="—" />}
        {patterns.length > 0 && patterns.length < 2 && <Cell k="patterns" v="1 found" />}
        <Cell
          k="demand zone"
          v={sd && asRec(sd.demand) ? `${fmt(num(asRec(sd.demand)?.bottom), 2)}–${fmt(num(asRec(sd.demand)?.top), 2)}${asRec(sd.demand)?.inZone ? ' · IN' : ` · ${fmt(num(asRec(sd.demand)?.nearPct), 1)}%`}` : '—'}
          tone={asRec(sd?.demand)?.inZone ? 'good' : undefined}
        />
        <Cell
          k="supply zone"
          v={sd && asRec(sd.supply) ? `${fmt(num(asRec(sd.supply)?.bottom), 2)}–${fmt(num(asRec(sd.supply)?.top), 2)}${asRec(sd.supply)?.inZone ? ' · IN' : ` · ${fmt(num(asRec(sd.supply)?.nearPct), 1)}%`}` : '—'}
          tone={asRec(sd?.supply)?.inZone ? 'bad' : undefined}
        />
        <Cell k="sd zones" v={sd ? `${String(sd.count)} scanned` : '—'} />
        <Cell k="pa clv" v={pa ? fmt(num(pa.clv), 2) : '—'} tone={pa && (num(pa.clv) ?? 0) > 0.3 ? 'good' : pa && (num(pa.clv) ?? 0) < -0.3 ? 'bad' : undefined} />
        <Cell k="pa bars" v={pa ? `${String(pa.upBars)}↑ / ${String(pa.downBars)}↓` : '—'} />
        <Cell k="pa body" v={(() => { const b = num(pa?.bodyRatio); return b == null ? '—' : `${fmt(b * 100, 0)}%`; })()} />
        <Cell k="pa range-pos" v={pa ? `${fmt(num(pa.rangePositionPct), 0)}%` : '—'} tone={pa && (num(pa.rangePositionPct) ?? 50) >= 70 ? 'good' : pa && (num(pa.rangePositionPct) ?? 50) <= 30 ? 'bad' : undefined} />
        <Cell k="pa bias" v={pa ? (num(pa.trendBias) === 1 ? 'BULL' : num(pa.trendBias) === -1 ? 'BEAR' : 'flat') : '—'} tone={num(pa?.trendBias) === 1 ? 'good' : num(pa?.trendBias) === -1 ? 'bad' : undefined} />
      </div>
      <div className="text-[9px] text-slate-600 mt-2 leading-relaxed">
        Ye values wahi hain jo 12+ committee models (TrendMatrix · Momentum · Volume · SMC · StructurePro · Tape …) ne vote dete waqt padhi thin. Model-wise reasoning signal card ke votes section me hai.
      </div>
    </div>
  );
});
