// ============================================================
// src/components/aitrading/LiveExecuteModal.tsx — v21.3.0 (Issue-4)
// ------------------------------------------------------------
// THE ONE-CLICK LIVE EXECUTE, UPGRADED. Pehle ⚡ EXECUTE LIVE ek click
// = REAL ORDER — no preview, no gate checklist, silent 1x/₹1000
// defaults, har rejection post-click toast me. Ab:
//   1. PRE-FLIGHT — the button opens THIS modal: server ka READ-ONLY
//      precheck (same gauntlet, dry-run) → gate checklist + the
//      would-be ticket (qty @ instrument precision, margin, leverage
//      sanity, liquidation, native SL+TP pair jo exchange pe arm hota hai).
//   2. HOLD-TO-CONFIRM — real order tab 1.2s PRESS-AND-HOLD se hi
//      jaata hai (accidental click-proof).
//   3. RESULT inline — order id / journal id / armed protection ya the
//      honest rejection, yahin dikhta hai.
// Paper one-click flow bilkul unchanged rehta hai (practice frictionless).
// ============================================================
import { useCallback, useEffect, useRef, useState } from 'react';
import { aiDecisionText } from './aiConfirmText';
import type { AISignal, FuturesPrecheckResult } from './types';

interface Props {
  signal: AISignal;
  onPrecheck: (s: AISignal, opts?: { marginUSDT?: number; leverage?: number }) => Promise<FuturesPrecheckResult | null>;
  onExecute: (s: AISignal, mode: 'live') => Promise<{ ok: boolean; error?: string; note?: string; position?: unknown; order?: unknown }>;
  onClose: () => void;
}

const HOLD_MS = 1200;

export function LiveExecuteModal({ signal, onPrecheck, onExecute, onClose }: Props) {
  const [pre, setPre] = useState<FuturesPrecheckResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const [executing, setExecuting] = useState(false);
  // hold-to-confirm state
  const [holdPct, setHoldPct] = useState(0);
  const holdTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const holdDone = useRef(false);
  const sideLong = signal.side === 'LONG';

  useEffect(() => {
    let alive = true;
    setLoading(true);
    onPrecheck(signal).then((r) => { if (alive) { setPre(r); setLoading(false); } });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signal.symbol, signal.side]);

  const stopHold = useCallback(() => {
    if (holdTimer.current) { clearInterval(holdTimer.current); holdTimer.current = null; }
    setHoldPct(0);
  }, []);

  useEffect(() => () => stopHold(), [stopHold]);

  const fire = useCallback(async () => {
    if (executing) return;
    setExecuting(true);
    try {
      const r = await onExecute(signal, 'live');
      setResult({
        ok: !!r?.ok,
        text: r?.ok
          ? (r.note || 'LIVE order placed — native SL/TP armed, watcher active.')
          : (r?.error || 'order failed'),
      });
    } catch (e) {
      setResult({ ok: false, text: String((e as Error)?.message || e) });
    } finally {
      setExecuting(false);
      stopHold();
    }
  }, [executing, onExecute, signal, stopHold]);

  const startHold = useCallback(() => {
    if (result || !pre?.ok || executing) return;
    holdDone.current = false;
    const t0 = Date.now();
    if (holdTimer.current) clearInterval(holdTimer.current);
    holdTimer.current = setInterval(() => {
      const p = Math.min(100, ((Date.now() - t0) / HOLD_MS) * 100);
      setHoldPct(p);
      if (p >= 100 && !holdDone.current) {
        holdDone.current = true;
        stopHold();
        void fire();
      }
    }, 60);
  }, [result, pre, executing, fire, stopHold]);

  const t = pre?.ticket;
  const blocking = (pre?.gates || []).filter(g => !g.pass && g.blocking !== false) || [];
  const canExec = pre?.ok && blocking.length === 0 && !result;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm" role="dialog" aria-modal="true" data-testid="live-execute-modal">
      <div className="quantum-panel w-full max-w-lg rounded-2xl p-5 bg-slate-950 border border-slate-700/60 max-h-[88vh] overflow-y-auto">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h3 className="text-sm font-black text-white">⚡ LIVE EXECUTE — PRE-FLIGHT</h3>
            <p className="text-[11px] text-slate-400 mt-0.5">
              {signal.symbol} · {sideLong ? <span className="text-emerald-400 font-bold">▲ LONG</span> : <span className="text-red-400 font-bold">▼ SHORT</span>}
              {' · '}{signal.grade ?? '—'} · score {signal.superIntel?.aiScore ?? '—'}
              {signal.aiConfirm?.verdict === 'CONFIRMED' && <span className="text-cyan-300 font-bold"> · AI ✓</span>}
              {signal.aiConfirm?.verdict === 'CONFLICT' && <span className="text-red-300 font-bold"> · AI ✗</span>}
            </p>
            {/* v21.11.0 (decision transparency): live execute ke FINAL
                pre-flight screen par Jev ka actual directional read —
                "Jev: ULTA — SHORT chuna (p 68%)" jaisi lines. Pehle sirf
                ✓/✗ dikhta tha, direction ka pata nahi chalta tha. */}
            {signal.aiConfirm?.detail && (
              <div className="mt-1.5 space-y-0.5" data-testid="live-ai-decision">
                {(['jev'] as const).map((key) => {
                  const d = signal.aiConfirm?.detail?.[key];
                  if (!d) return null;
                  const line = aiDecisionText('Jev', d);
                  const tone = d.v === 'AGREE' ? 'text-cyan-300/90' : d.v === 'DISAGREE' ? 'text-red-300' : 'text-slate-400';
                  return <div key={key} className={`text-[10px] font-mono ${tone}`}>{d.v === 'AGREE' ? '✓' : d.v === 'DISAGREE' ? '✗' : '○'} {line}</div>;
                })}
              </div>
            )}
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-white px-2 text-lg leading-none" aria-label="Close">✕</button>
        </div>

        {loading && (
          <div className="py-8 text-center text-xs text-slate-400">Gauntlet dry-run chal raha hai… (no order)</div>
        )}

        {/* v21.4.1 [D4]: precheck UNAVAILABLE — server ne answer nahi diya
            (500/timeout/network). Pehle empty checklist + disabled button
            dikhta tha — ab honest error. Live order kabhi bhi bina
            precheck ke nahi jaata, isliye ye modal band hone tak block hai. */}
        {!loading && !pre && !result && (
          <div className="mt-4 rounded-xl border border-red-500/40 bg-red-500/10 px-4 py-4 text-center" data-testid="precheck-unavailable">
            <div className="text-xl mb-1">📡</div>
            <div className="text-[11px] text-red-300 font-bold">Pre-flight check unavailable</div>
            <div className="text-[10px] text-slate-500 mt-1 leading-relaxed">Server ne precheck ka answer nahi diya (network/timeout). Live order is modal se nahi ja sakta — dobara kholo ya console check karo.</div>
          </div>
        )}

        {!loading && pre && !result && (
          <>
            {/* gate checklist */}
            <div className="mt-4 space-y-1.5" data-testid="precheck-gates">
              {(pre?.gates || []).map((g) => (
                <div key={g.name} className="flex items-center gap-2 text-[11px]">
                  <span className={g.pass ? 'text-emerald-400' : 'text-red-400'}>{g.pass ? '✔' : '✘'}</span>
                  <span className="font-bold text-slate-300">{g.name}</span>
                  <span className="text-slate-500 truncate">{g.detail}</span>
                </div>
              ))}
            </div>

            {/* warnings */}
            {(pre?.warnings || []).length > 0 && (
              <div className="mt-3 rounded-xl border border-amber-500/40 bg-amber-500/10 px-3 py-2 space-y-1">
                {(pre?.warnings || []).map((w, i) => (
                  <div key={i} className="text-[11px] text-amber-300 font-bold">⚠ {w}</div>
                ))}
              </div>
            )}

            {/* ticket */}
            {t && (
              <div className="mt-4 rounded-xl bg-black/40 border border-slate-700/50 p-3">
                <div className="text-[9px] font-black text-slate-500 tracking-widest mb-2">WOULD-BE TICKET (REAL ORDER NAHI — dry-run)</div>
                <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-[11px] font-mono">
                  <Row label="Entry" value={fmt(t.price)} accent="text-cyan-300" />
                  <Row label="Stop-loss" value={fmt(t.stopLoss)} accent="text-red-300" />
                  <Row label="Target 1" value={fmt(t.target1)} accent="text-amber-300" />
                  <Row label="Target 2 (native TP)" value={fmt(t.target2)} accent="text-emerald-300" />
                  <Row label="Quantity" value={t.qty != null ? String(t.qty) : '—'} accent="text-white" />
                  <Row label="Leverage" value={`${t.leverage}x${t.maxSaneLeverage != null && t.leverageRequested > t.maxSaneLeverage ? ` (req ${t.leverageRequested}x, sane ${t.maxSaneLeverage}x)` : ''}`} accent="text-violet-300" />
                  <Row label="Margin" value={t.marginUsedUSDT != null ? `${t.marginUsedUSDT} USDT${t.marginINR != null ? ` · ₹${t.marginINR}` : ''}` : '—'} accent="text-white" />
                  <Row label="Notional" value={t.notionalUSDT != null ? `${t.notionalUSDT} USDT` : '—'} accent="text-white" />
                  <Row label="Liq. est." value={fmt(t.liquidation)} accent="text-red-300" />
                  <Row label="Risk" value={t.riskPct != null ? `${t.riskPct}% (R:R 1:${t.rewardRisk ?? '—'})` : '—'} accent="text-slate-300" />
                </div>
                {t.nativeProtection && (
                  <div className="mt-2 text-[10px] text-slate-500 leading-relaxed">
                    Exchange pe arm hone wala NATIVE protection: SL {fmt(t.nativeProtection.stopLoss)} + TP {fmt(t.nativeProtection.takeProfit)} (TP arm fail ho toh system position ko PROTECTION-FIRST flatten karta hai).
                  </div>
                )}
              </div>
            )}

            {/* actions */}
            <div className="mt-4 flex items-center gap-2">
              <button
                disabled={!canExec || executing}
                onMouseDown={startHold}
                onMouseUp={stopHold}
                onMouseLeave={stopHold}
                onTouchStart={startHold}
                onTouchEnd={stopHold}
                className="relative overflow-hidden flex-1 px-4 py-3 rounded-xl text-xs font-black text-white transition-opacity disabled:opacity-40 disabled:cursor-not-allowed select-none"
                style={{ background: 'linear-gradient(to right, #059669, #0d9488)' }}
                title={canExec ? 'REAL ORDER ke liye 1.2s TAK DABAKE RAKHO' : (blocking.length > 0 ? 'Gates fail — pehle unhe clear karo' : (pre ? '…' : 'precheck unavailable'))}
                data-testid="hold-to-confirm"
              >
                <span
                  className="absolute inset-y-0 left-0 bg-emerald-700/80"
                  style={{ width: `${holdPct}%`, transition: 'width 60ms linear' }}
                />
                <span className="relative">
                  {executing ? 'ORDER JA RAHA HAI…' : holdPct > 0 ? `DABAKE RAKHO… ${Math.round(holdPct)}%` : '🔒 HOLD 1.2s = REAL LIVE ORDER'}
                </span>
              </button>
              <button onClick={onClose} className="px-4 py-3 rounded-xl text-xs font-black border border-slate-600 text-slate-300 hover:bg-slate-800/60">
                Cancel
              </button>
            </div>
            {pre?.error && (
              <p className="mt-2 text-[10px] text-red-300/90 font-bold">Server error: {pre.error}</p>
            )}
            {blocking.length > 0 && (
              <p className="mt-2 text-[10px] text-red-300/90">
                {blocking.length} blocking gate(s): {blocking.map(g => g.name).join(', ')} — inhe clear karne ke baad hi live order possible hai.
              </p>
            )}
            <p className="mt-2 text-[9px] text-slate-500 leading-relaxed">
              Pre-flight READ-ONLY hai — is modal ne abhi tak koi order NAHI lagaya. Server-side bhi saare gates (kill switch, go-live track-record, strategy health, LIVE arming, connection, fresh STRONG signal, side-match, risk caps) order ke waqt DOBARA verify hote hain.
            </p>
          </>
        )}

        {/* result */}
        {result && (
          <div className={`mt-4 rounded-xl border px-4 py-4 text-center ${result.ok ? 'border-emerald-500/40 bg-emerald-500/10' : 'border-red-500/40 bg-red-500/10'}`} data-testid="live-execute-result">
            <div className="text-2xl mb-1">{result.ok ? '✅' : '❌'}</div>
            <p className={`text-xs font-bold leading-relaxed ${result.ok ? 'text-emerald-300' : 'text-red-300'}`}>{result.text}</p>
            <button onClick={onClose} className="mt-3 px-4 py-2 rounded-lg text-xs font-black bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-600">
              Band karo
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function Row({ label, value, accent }: { label: string; value: string; accent: string }) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <span className="text-[9px] font-black text-slate-500 tracking-wider">{label.toUpperCase()}</span>
      <span className={`font-black ${accent}`}>{value}</span>
    </div>
  );
}

function fmt(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '—';
  return n >= 100 ? n.toFixed(1) : n >= 1 ? n.toFixed(2) : n.toFixed(5);
}
