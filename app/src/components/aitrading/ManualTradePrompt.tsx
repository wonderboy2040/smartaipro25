// ============================================================
// src/components/aitrading/ManualTradePrompt.tsx
// ------------------------------------------------------------
// v10.16 SECTION 2A — "Maine ye trade liya hai"
// On signal cards: one compact form to record the user's OWN (real)
// trade against the signal — entry price pre-filled with the live LTP
// (editable), qty/lots, entry time (defaults now), and for F&O:
// strike + expiry. The entry is validated against the live LTP — a
// wild deviation WARNS (never blocks; a genuine fill can be off) —
// because one typo here silently corrupts every downstream P&L
// number the tracker shows.
//
// The originating signal's FULL SNAPSHOT (plan, 14-model votes,
// regime, AI score) is frozen server-side at record time — the
// baseline the conviction tracker measures "trend change" against.
// ============================================================
import { useEffect, useMemo, useState } from 'react';
import { apiFetch, getProxyBase } from '../../utils/api';
import type { AISignal } from './types';

interface Props {
  signal: AISignal;
  /** v10.10 live direct LTP (RT stream) — preferred over snapshot ltp. */
  liveLtp?: number | null;
  /** notify(true/false, text) — the tab toast hook. */
  notify?: (ok: boolean, text: string) => void;
  onDone?: () => void;
}

const pxFmt = (v: number | null | undefined): string => {
  if (v == null || !Number.isFinite(v)) return '—';
  const a = Math.abs(v);
  const dp = a >= 1 ? 2 : a >= 0.01 ? 4 : a >= 0.0001 ? 6 : 8;
  return v.toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp });
};

export function ManualTradePrompt({ signal, liveLtp, notify, onDone }: Props) {
  const ltp = liveLtp ?? signal.ltp ?? null;
  const isUsd = signal.market === 'FUTURES' || signal.market === 'GLOBALFUTURES';
  const cur = isUsd ? (signal.market === 'GLOBALFUTURES' ? 'USDC' : 'USDT') : '₹';
  // v13.1 SVA — the pro-trader verdict on the signal being traded.
  const vfy = signal.verify ?? null;
  const vfyReject = vfy && (vfy.action === 'FLIP' || vfy.action === 'STAND_ASIDE');
  const [entryPrice, setEntryPrice] = useState<string>(ltp != null ? String(ltp) : '');
  const [qty, setQty] = useState<string>('');
  const [entryTime, setEntryTime] = useState<string>(() => {
    // local time "now", minute precision — editable (aapne 10 min pehle liya tha?)
    const d = new Date();
    d.setSeconds(0, 0);
    return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  });
  const [isOption, setIsOption] = useState(false);
  const [strike, setStrike] = useState<string>('');
  const [optType, setOptType] = useState<'CE' | 'PE'>(
    signal.side === 'LONG' ? 'CE' : 'PE',
  );
  const [expiry, setExpiry] = useState<string>('');
  const [lotSize, setLotSize] = useState<string>('75'); // v18.9: per-underlying lot (RELIANCE 500, SENSEX 20, …) — hardcoded 75 ne stock-option P&L scale kharab kiya tha
  const [busy, setBusy] = useState(false);
  const [warn, setWarn] = useState<string | null>(null);

  // live-LTP deviation check (warn, don't block — plan's spec)
  useEffect(() => {
    const e = Number(entryPrice);
    if (!(e > 0) || !(ltp != null && ltp > 0)) { setWarn(null); return; }
    const dev = Math.abs(e - ltp) / ltp * 100;
    setWarn(dev > 15 ? `Entry price live LTP (${pxFmt(ltp)}) se ${dev.toFixed(1)}% door hai — typo check karo. (Recorded anyway — genuine fill ho sakta hai.)` : null);
  }, [entryPrice, ltp]);

  const plan = signal.plan;
  const lotNum = Number(lotSize);
  const lotValid = Number.isFinite(lotNum) && lotNum > 0;
  const canSubmit = useMemo(() => {
    const e = Number(entryPrice);
    const q = Number(qty);
    if (!(e > 0) || !(q > 0)) return false;
    if (isOption) return Number(strike) > 0 && /^\d{4}-\d{2}-\d{2}$/.test(expiry) && lotValid;
    return true;
  }, [entryPrice, qty, isOption, strike, expiry, lotValid]);

  const submit = async () => {
    if (!canSubmit || busy) return;
    setBusy(true);
    try {
      const body = {
        market: signal.market,
        symbol: signal.symbol,
        side: signal.side === 'SHORT' ? 'SELL' : 'BUY',
        entryPrice: Number(entryPrice),
        qty: Number(qty),
        entryTime: new Date(entryTime).getTime() || Date.now(),
        ltp,
        ...(isOption ? {
          strike: Number(strike),
          optType,
          expiry,
          iv: 13, // desk default (server re-prices on the live spot; entry IV fixed)
          // v18.9: LOT SIZE ab user-editable hai (NIFTY 75, BANKNIFTY 30/35,
          // SENSEX 20, stock options 100-500…). Pehle hardcoded 75 tha —
          // RELIANCE CE (500) ka P&L 15% pe scale hota tha, BANKNIFTY ~2.5×.
          lotSize: lotValid ? Math.round(lotNum) : 75,
        } : {}),
        // the FULL signal snapshot — frozen server-side as the baseline
        signal: {
          symbol: signal.symbol,
          market: signal.market,
          side: signal.side,
          grade: signal.grade,
          confidence: signal.confidence,
          agreement: signal.agreement,
          voters: signal.voters ?? signal.participating,
          generatedAt: signal.generatedAt,
          // v10.16: the wire signal carries quality.regime as a STRUCT
          // ({ aligned, counterTrend }) — derive the human label the
          // server freezes into origin.regime from it.
          regime: signal.quality?.regime?.aligned == null ? null
            : signal.quality.regime.aligned ? 'REGIME ALIGNED' : 'COUNTER-TREND',
          superIntel: signal.superIntel ? { aiScore: signal.superIntel.aiScore } : null,
          plan: plan ? {
            entry: plan.entry ?? ltp,
            stopLoss: plan.stopLoss ?? null,
            target1: plan.target1 ?? null,
            target2: plan.target2 ?? null,
            riskPct: plan.riskPct ?? null,
            atr: plan.atrUsed ?? null,
          } : null,
          votes: (signal.votes || []).map(v => ({ id: v.id, name: v.name, dir: v.dir, conf: v.conf })),
          summary: signal.summary,
          // v13.1: the SVA verdict rides the snapshot — the server stamps
          // it on the trade (t.verify) as the open-time verdict.
          ...(signal.verify ? { verify: signal.verify } : {}),
        },
      };
      const r = await apiFetch(`${getProxyBase()}/api/manual-trade`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(20_000), // v18.9: hung connection me RECORDING… stuck hota tha
      }).then(x => x.json()).catch(() => ({ ok: false, error: 'network error' }));
      if (r.ok) {
        notify?.(true, `✅ Manual trade recorded — ${signal.symbol} ${signal.side} @ ${pxFmt(Number(entryPrice))} · live conviction tracking ON (flip hote hi EXIT NOW push + banner)`);
        onDone?.();
      } else {
        notify?.(false, `⛔ ${r.error || 'record failed'}`);
      }
    } finally {
      setBusy(false);
    }
  };

  const label = 'text-[10px] uppercase tracking-wider text-slate-500 font-bold';
  const input = 'w-full bg-slate-900/80 border border-slate-700/60 rounded-lg px-2.5 py-1.5 text-sm text-slate-100 focus:border-cyan-500/60 focus:outline-none';

  return (
    <div className="space-y-2.5">
      <div className="text-[11px] text-slate-400 leading-relaxed">
        <span className="text-cyan-300 font-bold">MANUAL TRACK</span> — aapka REAL trade is signal ke against record hoga.
        Entry ke waqt ka <b>14-model snapshot</b> freeze ho jayega; phir ensemble har 30s re-vote karega —
        thesis flip hote hi <b className="text-red-400">EXIT NOW</b> banner + Telegram push (WHY ke saath).
      </div>

      {/* v13.1 SVA PRE-TRADE VERDICT — the final gate before the user
          records the trade. CONFIRM = green go; CAUTION = amber half-risk;
          FLIP/STAND_ASIDE = RED — the verifier is telling them NOT to take
          this trade (the exact XRP case: entered on a chase-suppressed
          WATCH call and bled −5.5%). */}
      {vfy && (
        <div className={`rounded-lg px-2.5 py-2 text-[11px] leading-relaxed border ${
          vfy.action === 'CONFIRM' ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-200'
            : vfy.action === 'CAUTION' ? 'bg-amber-500/10 border-amber-500/30 text-amber-200'
              : 'bg-rose-500/10 border-rose-500/40 text-rose-200'}`}>
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-black">🛡 SVA VERDICT: {vfy.action} — <b>{vfy.finalCall}</b></span>
            <span className="font-mono font-bold">{vfy.score}/100</span>
            {vfy.veto && <span className="px-1.5 py-0.5 rounded bg-rose-500/20 border border-rose-500/40 text-[9px] font-black">PRO VETO</span>}
            {vfy.sizeHint != null && vfy.sizeHint < 1 && <span className="px-1.5 py-0.5 rounded bg-slate-600/30 border border-slate-500/40 text-[9px] font-black">SIZE: {vfy.sizeHint === 0.5 ? 'HALF' : 'SKIP'}</span>}
          </div>
          {(vfy.verdict || vfy.proNote) && (
            <div className="mt-1 text-slate-300/90">{vfy.verdict || vfy.proNote}</div>
          )}
          {vfyReject && (
            <div className="mt-1 font-bold">
              ⛔ Verifier ne is {signal.side} entry ko REJECT kiya hai — agar phir bhi loge to size chhota rakho aur SL entry ke paas.
            </div>
          )}
        </div>
      )}

      <div className="grid grid-cols-2 gap-2.5">
        <div>
          <div className={label}>Entry price ({cur})</div>
          <input className={input} inputMode="decimal" value={entryPrice}
            onChange={e => setEntryPrice(e.target.value)} placeholder={ltp != null ? String(ltp) : '0.00'} />
        </div>
        <div>
          <div className={label}>{isOption ? 'Lots' : 'Qty'}</div>
          <input className={input} inputMode="decimal" value={qty}
            onChange={e => setQty(e.target.value)} placeholder={isOption ? '2' : '10'} />
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2.5">
        <div>
          <div className={label}>Entry time</div>
          <input type="datetime-local" className={input} value={entryTime}
            onChange={e => setEntryTime(e.target.value)} />
        </div>
        <div className="flex items-end">
          <label className="flex items-center gap-2 text-[11px] text-slate-300 select-none cursor-pointer pb-1.5">
            <input type="checkbox" checked={isOption} onChange={e => setIsOption(e.target.checked)}
              className="accent-cyan-500 w-3.5 h-3.5" />
            F&O option (CE/PE)
          </label>
        </div>
      </div>

      {isOption && (
        <div className="grid grid-cols-3 gap-2.5">
          <div>
            <div className={label}>Strike</div>
            <input className={input} inputMode="numeric" value={strike}
              onChange={e => setStrike(e.target.value)} placeholder="24500" />
          </div>
          <div>
            <div className={label}>Type</div>
            <select className={input} value={optType} onChange={e => setOptType(e.target.value as 'CE' | 'PE')}>
              <option value="CE">CE</option>
              <option value="PE">PE</option>
            </select>
          </div>
          <div>
            <div className={label}>Expiry</div>
            <input type="date" className={input} value={expiry}
              onChange={e => setExpiry(e.target.value)} />
          </div>
        </div>
      )}

      {isOption && (
        <div>
          <div className={label}>Lot size <span className="text-slate-500 font-medium">(NIFTY 75 · BANKNIFTY 30/35 · SENSEX 20 · stock options 100-500)</span></div>
          <input className={`${input} ${lotValid ? '' : 'border-red-500/60'}`} inputMode="numeric" value={lotSize}
            onChange={e => setLotSize(e.target.value)} placeholder="75" />
          {!lotValid && <div className="text-[10px] text-red-400 mt-1">Lot size 0 se bada hona chahiye (P&amp;L = qty × lot × Δprice)</div>}
        </div>
      )}

      {warn && (
        <div className="text-[11px] text-amber-300 bg-amber-500/10 border border-amber-500/30 rounded-lg px-2.5 py-1.5">
          ⚠️ {warn}
        </div>
      )}

      {plan && (
        <div className="text-[10px] text-slate-500 flex flex-wrap gap-x-3 gap-y-0.5">
          <span>Signal plan — SL: {plan.stopLoss != null ? pxFmt(plan.stopLoss) : '—'}</span>
          <span>T1: {plan.target1 != null ? pxFmt(plan.target1) : '—'}</span>
          <span>T2: {plan.target2 != null ? pxFmt(plan.target2) : '—'}</span>
        </div>
      )}

      <button
        onClick={submit}
        disabled={!canSubmit || busy}
        className={`w-full py-2 rounded-xl text-xs font-black tracking-wide transition-all
          ${canSubmit && !busy
            ? 'bg-gradient-to-r from-cyan-600 to-blue-600 hover:from-cyan-500 hover:to-blue-500 text-white shadow-lg shadow-cyan-900/40'
            : 'bg-slate-800/60 text-slate-500 cursor-not-allowed'}`}>
        {busy ? 'RECORDING…' : '✓ TRADE RECORDED KARO — TRACKING ON'}
      </button>
    </div>
  );
}
