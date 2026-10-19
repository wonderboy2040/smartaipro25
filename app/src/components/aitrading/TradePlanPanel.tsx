// ============================================================
// src/components/aitrading/TradePlanPanel.tsx — v21.15.0
// ------------------------------------------------------------
// "MTF TRADE PLAN" — the user's exact spec ka executable panel:
//
//   ⚡ 15m → 5m   (INTRADAY)  — 15m deep candle read (context) +
//                              5m action read (entry/SL/TP timing)
//   🕐 1h → 15m   (SWING)     — 1h deep read + 15m action
//   ⚡ 5m → 1m    (SCALP)     — jab 15-20 min ka EXIT window chahiye
//                              (measured: isi TF-pair me travel fit
//                              karta hai — dekho TF-FIT chip)
//
// Panel har mode ke liye server ke plan engine (server/ai/
// tradePlanner.js) se ye dikhata hai:
//   1. CONTEXT read  — candles kya keh rahe hain (EMA/Supertrend/
//      ADX/structure/VWAP side) + score
//   2. TRIGGER read  — action kab (breakout bar, volume surge, body,
//      RSI band, overextended-ness) + score
//   3. PLAN          — entry zone (pullback + breakout trigger),
//      SL (structure ± ATR, 0.9×ATR floor), T1 = 1R, T2 = 2R,
//      net RR (cost ke baad), qty/risk
//   4. TF-FIT VERDICT— kya aapka hold window (15-20 min / 1-1.5 hr)
//      is timeframe ke saath FIT hai — HONEST, colour-coded
//   5. CHECKLIST     — ✓/✗ 9 conditions (confluence table)
//   6. TIME PLAN     — kab BE karo, kab trail, kab time-stop exit
//   7. COST REALITY  — round-trip cost kitne R kha raha hai
//   8. WARNINGS      — counter-trend / cost / late session / RSI
//
// Sab data server se (yahi numbers site ke baaki engines use karte
// hain) — ye panel kuch bhi khud "guess" nahi karta.
// ============================================================
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { RefreshCw, AlertTriangle, CheckCircle2, XCircle, Timer, Target, ShieldAlert } from 'lucide-react';
import { fetchTradePlan, type TradePlanView, type TradePlanModeId } from './useAITrading';
import type { MarketKind } from './types';

interface Props {
  symbol: string;
  market: MarketKind;
  /** Board signal ka side (optional) — plan usi side ka banega. */
  side?: 'LONG' | 'SHORT' | null;
  /** Optional live LTP (panel ke bharosemand plan ke liye). */
  ltp?: number | null;
  /** Optional capital + risk% (qty suggestion ke liye). */
  capital?: number | null;
  riskPctPerTrade?: number | null;
}

const MODES: Array<{ id: TradePlanModeId; label: string; tf: string; hint: string; hold: number }> = [
  { id: 'INTRADAY', label: '⚡ 15m → 5m', tf: '15m deep + 5m action', hint: 'Intraday momentum — hold 45-60 min', hold: 45 },
  { id: 'SWING', label: '🕐 1h → 15m', tf: '1h deep + 15m action', hint: 'Swing-style intraday — hold 1-1.5 hr', hold: 90 },
];

const HOLD_CHIPS: number[] = [45, 90, 120]; // minutes — intraday & swing hold windows

const fitCls = (v?: string) =>
  v === 'GOOD' ? 'text-emerald-300 bg-emerald-500/10 border-emerald-500/30'
    : v === 'OK' ? 'text-cyan-300 bg-cyan-500/10 border-cyan-500/30'
      : v === 'STRETCH' ? 'text-amber-300 bg-amber-500/10 border-amber-500/30'
        : 'text-red-300 bg-red-500/10 border-red-500/30';

const gradeCls = (g?: string) =>
  g === 'A' ? 'text-emerald-300 border-emerald-500/40' : g === 'B' ? 'text-cyan-300 border-cyan-500/40' : 'text-slate-300 border-slate-500/40';

// v21.17.0 DEEP AUDIT: jab `d` omit ho (price levels: entry/SL/T1/T2/ltp),
// server ke `pRoundLadder` ki adaptive precision (2..8dp) preserve karo —
// warna DOT ($1.09, SL 1.0949, T1 1.0851) ya WLD ($0.47, SL 0.4716) UI me
// `.toFixed(2)` se `1.09 · 1.09 · 1.09` me collapse ho jaate the!
const fmt = (v: unknown, d?: number) => {
  const n = Number(v);
  if (v == null || !Number.isFinite(n)) return '—';
  if (typeof d === 'number') return n.toFixed(d);
  const clean = Number(n.toFixed(8));
  const s = String(clean);
  const dot = s.indexOf('.');
  const actualDp = dot >= 0 ? s.length - dot - 1 : 0;
  const a = Math.abs(clean);
  const minDp = a === 0 ? 2 : a >= 1 ? 2 : a >= 0.01 ? 4 : a >= 0.0001 ? 6 : 8;
  return clean.toFixed(Math.min(8, Math.max(minDp, actualDp)));
};

function Row({ label, value, cls, title }: { label: string; value: React.ReactNode; cls?: string; title?: string }) {
  return (
    <div className="flex items-baseline justify-between gap-2 py-0.5" title={title}>
      <span className="text-[10px] text-slate-500 uppercase tracking-wide">{label}</span>
      <span className={`text-[11px] font-mono font-bold ${cls || 'text-slate-200'}`}>{value}</span>
    </div>
  );
}

function Card({ title, icon, children, tone = 'slate' }: { title: string; icon?: React.ReactNode; children: React.ReactNode; tone?: 'slate' | 'emerald' | 'red' | 'cyan' | 'amber' }) {
  const toneCls = {
    slate: 'border-slate-500/20 bg-slate-500/[0.04]',
    emerald: 'border-emerald-500/25 bg-emerald-500/[0.05]',
    red: 'border-red-500/25 bg-red-500/[0.05]',
    cyan: 'border-cyan-500/25 bg-cyan-500/[0.05]',
    amber: 'border-amber-500/25 bg-amber-500/[0.05]',
  }[tone];
  return (
    <div className={`border rounded-xl p-2.5 ${toneCls}`}>
      <div className="text-[10px] font-black text-slate-300 tracking-wider mb-1.5 flex items-center gap-1.5">{icon}{title}</div>
      {children}
    </div>
  );
}

export const TradePlanPanel = memo(function TradePlanPanel({ symbol, market, side, ltp, capital, riskPctPerTrade }: Props) {
  const [mode, setMode] = useState<TradePlanModeId>('INTRADAY');
  const [holdMin, setHoldMin] = useState<number>(45);
  const [plan, setPlan] = useState<TradePlanView | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(true);

  // v21.16.0 FIX (pro-level recheck): ltp har price-tick par badalta hai —
  // use load() deps me rakhne se panel HAR tick par refetch karta tha
  // (server 30s cache ke bawajood request storm + UI flicker). LTP ko ref
  // me le jaate hain: fetch call ke waqt fresh value milti hai, par effect
  // sirf REAL config changes (symbol/mode/hold/side/capital/risk) par chalta hai.
  const ltpRef = useRef<number | null>(ltp ?? null);
  useEffect(() => { ltpRef.current = ltp ?? null; }, [ltp]);
  const load = useCallback(async () => {
    if (!symbol) return;
    setLoading(true); setError(null);
    const r = await fetchTradePlan(symbol, market, { mode, holdMin, side: side ?? undefined, ltp: ltpRef.current ?? undefined, capital: capital ?? undefined, riskPctPerTrade: riskPctPerTrade ?? undefined });
    if (r?.ok) setPlan(r);
    else { setPlan(null); setError(r?.error || 'plan unavailable (data source down)'); }
    setLoading(false);
  }, [symbol, market, mode, holdMin, side, capital, riskPctPerTrade]);

  useEffect(() => { void load(); }, [load]);

  // mode switch → us mode ka sensible default hold window
  const pickMode = useCallback((m: TradePlanModeId) => {
    setMode(m);
    setHoldMin(MODES.find(x => x.id === m)?.hold ?? 45);
  }, []);

  const ctx = plan?.context;
  const trig = plan?.trigger;
  const pl = plan?.plan;
  const dirArrow = (d?: number | null) => (d == null ? '·' : d > 0 ? '▲' : d < 0 ? '▼' : '·');

  const biasChip = useMemo(() => {
    if (!plan?.side) return { txt: '⏸ WAIT — clear setup nahi', cls: 'text-amber-300 bg-amber-500/10 border-amber-500/30' };
    const long = plan.side === 'LONG';
    if (String(plan.bias).startsWith('WAIT')) return { txt: `⏸ WAIT ${plan.side} — trigger pending`, cls: 'text-amber-300 bg-amber-500/10 border-amber-500/30' };
    return { txt: `${long ? '🟢 LONG' : '🔴 SHORT'} — trigger fired`, cls: long ? 'text-emerald-300 bg-emerald-500/10 border-emerald-500/30' : 'text-red-300 bg-red-500/10 border-red-500/30' };
  }, [plan]);

  return (
    <div className="mt-3 bg-cyan-500/[0.04] border border-cyan-500/20 rounded-xl p-3" aria-label="mtf trade plan">
      {/* header */}
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <button onClick={() => setOpen(o => !o)} className="flex items-center gap-1.5 text-[11px] font-black text-cyan-300 tracking-wider">
          🎯 MTF TRADE PLAN <span className="text-slate-500 font-normal normal-case">{open ? '(hide)' : '(show)'}</span>
        </button>
        <div className="flex items-center gap-1.5 flex-wrap">
          {plan && <span className={`px-1.5 py-0.5 rounded text-[9px] font-black border ${biasChip.cls}`}>{biasChip.txt}</span>}
          {plan?.directionVerified && plan?.side && (
            <span className={`px-1.5 py-0.5 rounded text-[9px] font-black border ${plan.side === 'LONG' ? 'text-emerald-100 bg-emerald-500/20 border-emerald-400/50' : 'text-rose-100 bg-rose-500/20 border-rose-400/50'}`}>
              🔒 PAKKA {plan.side} VERIFIED
            </span>
          )}
          {plan?.worldIndicators && (
            <span className="px-1.5 py-0.5 rounded text-[9px] font-black border border-emerald-500/40 bg-emerald-500/15 text-emerald-200">
              🏆 {(plan.worldIndicators.aligned8Count ?? plan.worldIndicators.alignedCount ?? 0)}/8 Top Institutional Ind{plan.worldIndicators.estimatedWinRatePct != null ? ` (~${plan.worldIndicators.estimatedWinRatePct}% est. win-rate)` : ''}
            </span>
          )}
          {plan && <span className={`px-1.5 py-0.5 rounded text-[9px] font-black border ${gradeCls(plan.grade)}`} title="Grade = context+trigger confluence">GRADE {plan.grade} · {plan.confidence}%</span>}
          <button onClick={() => void load()} className="p-1 rounded border border-slate-500/30 hover:border-cyan-500/50" title="Plan refresh (server 30s cache)">
            <RefreshCw size={11} className={loading ? 'animate-spin text-cyan-300' : 'text-slate-400'} />
          </button>
        </div>
      </div>

      {open && (
        <>
          {/* mode + hold controls */}
          <div className="mt-2 flex items-center gap-1.5 flex-wrap">
            {MODES.map(m => (
              <button key={m.id} onClick={() => pickMode(m.id)} title={m.hint}
                className={`px-2 py-0.5 rounded text-[10px] font-black border ${mode === m.id ? 'border-cyan-400/60 text-cyan-200 bg-cyan-500/10' : 'border-slate-500/30 text-slate-400 hover:border-slate-400/50'}`}>
                {m.label}
              </button>
            ))}
            <span className="text-[9px] text-slate-500 ml-1">HOLD:</span>
            {HOLD_CHIPS.map(h => (
              <button key={h} onClick={() => setHoldMin(h)}
                className={`px-1.5 py-0.5 rounded text-[10px] font-black border ${holdMin === h ? 'border-amber-400/60 text-amber-200 bg-amber-500/10' : 'border-slate-500/30 text-slate-400'}`}
                title={`Exit window ${h} min`}>
                {h}m
              </button>
            ))}
          </div>
          <div className="text-[9px] text-slate-500 mt-1">
            {MODES.find(m => m.id === mode)?.tf} · hold window {holdMin} min · {plan ? <>server: {plan.dataAge?.ctxBars ?? 0}×{plan.contextTf} + {plan.dataAge?.trigBars ?? 0}×{plan.triggerTf} candles @ {plan.dataAge?.istTime ?? '—'}</> : 'loading…'}
          </div>

          {error && !loading && (
            <div className="mt-2 text-[10px] text-amber-400 font-bold flex items-center gap-1.5"><AlertTriangle size={11} /> {error} — plan tabhi banega jab context + trigger dono candles available hon.</div>
          )}
          {loading && !plan && <div className="mt-2 text-[10px] text-slate-400 animate-pulse">MTF plan compute ho raha hai…</div>}

          {plan?.ok && (
            <>
              {/* TF-FIT — sabse pehle, kyunki yahi user ka core sawaal hai */}
              <div className={`mt-2 border rounded-xl px-2.5 py-2 ${fitCls(plan.tfFit?.verdict)}`}>
                <div className="flex items-center gap-1.5 text-[10px] font-black tracking-wider">
                  <Timer size={12} /> TF-FIT VERDICT: {plan.tfFit?.verdict} <span className="font-mono">({fmt(plan.tfFit?.ratioT1, 2)}×)</span>
                </div>
                <div className="text-[10px] mt-1 leading-relaxed">{plan.tfFit?.note}</div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 mt-2">
                {/* CONTEXT */}
                <Card title={`DEEP READ — ${plan.contextTf} (candles)`} tone="cyan" icon={<CheckCircle2 size={11} />}>
                  <Row label="bias" value={`${dirArrow(ctx?.dir)} ${ctx?.trend ?? '—'} · ${ctx?.score ?? 0}/100`} cls={ctx?.dir === 1 ? 'text-emerald-300' : ctx?.dir === -1 ? 'text-red-300' : 'text-amber-300'} />
                  <Row label="structure" value={ctx?.structure ?? '—'} />
                  <Row label="EMA20 / 50" value={`${fmt(ctx?.ema20)} / ${fmt(ctx?.ema50)}`} />
                  <Row label="supertrend" value={ctx?.supertrend ?? '—'} cls={ctx?.supertrend === 'up' ? 'text-emerald-300' : ctx?.supertrend === 'down' ? 'text-red-300' : ''} />
                  <Row label="ADX / RSI" value={`${fmt(ctx?.adx, 0)} / ${fmt(ctx?.rsi, 0)} (${ctx?.rsiRead ?? 'n/a'})`} />
                  <Row label="ATR%" value={`${fmt(ctx?.atrPct)}%`} title="Har candle ka typical range — isi se SL/target ka size decide hota hai" />
                  <Row label="VWAP dist" value={`${fmt(ctx?.vwapDistPct)}%`} />
                  <div className="text-[9px] text-slate-400 mt-1 leading-relaxed">{ctx?.note}</div>
                </Card>

                {/* TRIGGER */}
                <Card title={`ACTION READ — ${plan.triggerTf} (kab entry)`} tone="emerald" icon={<Target size={11} />}>
                  <Row label="trigger fired" value={plan.triggerFired ? '✅ YES' : '⏸ pending'} cls={plan.triggerFired ? 'text-emerald-300' : 'text-amber-300'} />
                  <Row label="trigger level" value={(() => {
                    const lvl = plan.side === 'SHORT' ? trig?.prevBar?.low ?? null : trig?.prevBar?.high ?? null;
                    return lvl == null ? '—' : `${plan.side === 'SHORT' ? 'below' : 'above'} ${fmt(lvl)}`;
                  })()} title="Is level ke us paar close = action" />
                  <Row label="volume" value={`${fmt(trig?.volRatio)}× avg`} cls={(trig?.volRatio ?? 0) >= 1.2 ? 'text-emerald-300' : 'text-slate-400'} />
                  <Row label="body / RSI" value={`${fmt(trig?.bodyPct, 0)}% / ${fmt(trig?.rsi, 0)}`} />
                  <Row label="MACD hist" value={`${fmt(trig?.macdHist, 3)}`} cls={(trig?.macdHist ?? 0) > 0 ? 'text-emerald-300' : 'text-red-300'} />
                  <Row label="overextended" value={trig?.overextended ? '⚠ yes — pullback wait' : 'no'} cls={trig?.overextended ? 'text-amber-300' : 'text-slate-200'} />
                  {!!trig?.patterns?.length && <Row label="patterns" value={trig.patterns.join(' · ')} />}
                </Card>
              </div>

              {/* TRADE TICKET */}
              <div className="mt-2">
                <Card title="TRADE TICKET (entry · SL · T1 · T2)" tone="slate" icon={<ShieldAlert size={11} />}>
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                    <div>
                      <div className="text-[9px] text-slate-500 uppercase">Entry zone</div>
                      <div className="text-[11px] font-mono font-black text-cyan-200">{fmt(pl?.entryZoneLow)} – {fmt(pl?.entryZoneHigh)}</div>
                      <div className="text-[9px] text-slate-500">pullback {fmt(pl?.pullbackEntry)} · breakout {fmt(pl?.breakoutEntry)}</div>
                    </div>
                    <div>
                      <div className="text-[9px] text-slate-500 uppercase">Stop loss</div>
                      <div className="text-[11px] font-mono font-black text-red-300">{fmt(pl?.stopLoss)} ({fmt(pl?.stopPct)}%)</div>
                      <div className="text-[9px] text-slate-500">{pl?.stopBasis}</div>
                    </div>
                    <div>
                      <div className="text-[9px] text-slate-500 uppercase">T1 = 1R</div>
                      <div className="text-[11px] font-mono font-black text-emerald-300">{fmt(pl?.t1)}</div>
                      <div className="text-[9px] text-slate-500">60% book · net RR {fmt(pl?.netRR?.t1)}</div>
                    </div>
                    <div>
                      <div className="text-[9px] text-slate-500 uppercase">T2 = 2R</div>
                      <div className="text-[11px] font-mono font-black text-emerald-300">{fmt(pl?.t2)}</div>
                      <div className="text-[9px] text-slate-500">runner · net RR {fmt(pl?.netRR?.t2)}</div>
                    </div>
                  </div>
                  <div className="mt-1.5 flex items-center gap-2 flex-wrap text-[9px] text-slate-400">
                    <span>gross RR 1 : {fmt(pl?.grossRR?.t1, 1)} / {fmt(pl?.grossRR?.t2, 1)}</span>
                    <span>· cost ≈ {fmt(plan.costs?.roundTripPct, 3)}% ({fmt(plan.costs?.costR, 2)}R)</span>
                    {pl?.nearestStructureTarget != null && <span>· next structure target {fmt(pl?.nearestStructureTarget)}</span>}
                    {pl?.qty != null && <span>· qty {pl.qty}{pl.qtyCapped ? ` (raw ${pl.qtyRaw} → ${pl.leverage}× cap)` : ''} (risk {plan.quoteCcy === 'USDT' || plan.quoteCcy === 'USDC' ? '$' : '₹'}{fmt(pl.riskInr, 2)} @ {pl.riskPctPerTrade}%)</span>}
                  </div>
                  {pl?.wideStopNote && <div className="text-[9px] text-amber-300/80 mt-1">{pl.wideStopNote}</div>}
                </Card>
              </div>

              {/* TIME PLAN + CHECKLIST */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 mt-2">
                <Card title={`TIME PLAN (${plan.holdMin} min window)`} tone="amber" icon={<Timer size={11} />}>
                  <ul className="space-y-1">
                    <li className="text-[10px] text-slate-300 leading-relaxed">• {plan.timePlan?.beRule}</li>
                    <li className="text-[10px] text-slate-300 leading-relaxed">• {plan.timePlan?.t1Rule}</li>
                    <li className="text-[10px] text-slate-300 leading-relaxed">• {plan.timePlan?.trailRule}</li>
                    <li className="text-[10px] text-amber-200/90 leading-relaxed">• {plan.timePlan?.timeStopRule}</li>
                    <li className="text-[10px] text-slate-400 leading-relaxed">• {plan.timePlan?.hardExitRule}</li>
                  </ul>
                </Card>
                <Card title="CONFLUENCE CHECKLIST" tone="slate">
                  <ul className="space-y-0.5">
                    {plan.checklist?.map(c => (
                      <li key={c.id} className="flex items-start gap-1.5" title={c.detail}>
                        {c.ok ? <CheckCircle2 size={11} className="text-emerald-400 mt-0.5 shrink-0" /> : <XCircle size={11} className="text-slate-500 mt-0.5 shrink-0" />}
                        <span className="text-[10px] leading-relaxed">
                          <span className={c.ok ? 'text-slate-200' : 'text-slate-500'}>{c.label}</span>
                          <span className="text-slate-500"> — {c.detail}</span>
                        </span>
                      </li>
                    ))}
                  </ul>
                </Card>
              </div>

              {/* WARNINGS */}
              {!!plan.warnings?.length && (
                <div className="mt-2 border border-amber-500/25 bg-amber-500/[0.05] rounded-xl px-2.5 py-2">
                  <div className="text-[10px] font-black text-amber-300 tracking-wider flex items-center gap-1.5"><AlertTriangle size={11} /> WARNINGS ({plan.warnings.length})</div>
                  <ul className="mt-1 space-y-1">
                    {plan.warnings.map((w, i) => (
                      <li key={i} className="text-[10px] text-amber-200/90 leading-relaxed">• [{w.code}] {w.text}</li>
                    ))}
                  </ul>
                </div>
              )}

              {/* HONESTY FOOTER */}
              <div className="mt-2 text-[9px] text-slate-500 leading-relaxed">
                {plan.notes?.map((n, i) => <div key={i}>• {n}</div>)}
                <div className="mt-1 text-slate-400">
                  Measured (scripts/mtf-accuracy-lab.mjs, 22 symbols · 60 din · ~21k trades): 20 min me median favourable move = 0.57R, T1(1R) sirf 29.6% trades me pahunchta hai — isliye 15-20 min window me 2R target chase karna (quant me) lagbhag impossible hai. Cost ≈ 0.2-0.35R per round trip.
                </div>
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
});
