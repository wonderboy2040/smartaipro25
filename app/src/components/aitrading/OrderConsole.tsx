// ============================================================
// src/components/aitrading/OrderConsole.tsx
// ------------------------------------------------------------
// The execution console: live/paper positions with SL/TP tracking,
// daily risk meters, config editor (LIVE arming with typed
// confirmation), kill switch, and the full audit journal.
// ============================================================
import { memo, useState, useEffect, useCallback, useRef } from 'react';
import { clearClosedPositions } from './useAITrading';
import { useWalletPoll } from './useWalletPoll';
import type { DhanStatus, JournalEntry, JournalPosition, TradingConfig, TradingState } from './types';

const fmt = (n: number | null | undefined): string => {
  if (n == null || !Number.isFinite(n)) return '—';
  if (Math.abs(n) >= 1e5) return `₹${(n / 1e5).toFixed(2)}L`;
  return `₹${n.toLocaleString('en-IN', { maximumFractionDigits: 0 })}`;
};

const ago = (ts: number): string => {
  const m = Math.floor((Date.now() - ts) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
};

function RiskBar({ label, value, max, tone }: { label: string; value: number; max: number; tone: 'cyan' | 'red' | 'amber' }) {
  const pct = Math.max(0, Math.min(100, (value / Math.max(1, max)) * 100));
  const color = tone === 'red' ? 'bg-red-500' : tone === 'amber' ? 'bg-amber-500' : 'bg-cyan-500';
  return (
    <div className="flex-1 min-w-[120px]">
      <div className="flex justify-between text-[10px] font-bold mb-1">
        <span className="text-slate-500">{label}</span>
        <span className="text-slate-300 font-mono">{Math.round(value)}/{max}</span>
      </div>
      <div className="h-1.5 bg-black/40 rounded-full overflow-hidden">
        <div className={`h-full ${color} rounded-full transition-all`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

/** v6.8: live CoinDCX wallet strip — "wallet me kitna bacha hai" right in
 *  the execution console. v20.2: rides the SHARED useWalletPoll store
 *  (one 60s poller for WalletCard + WalletStrip + PortfolioHeat);
 *  degrades silently. */
function WalletStrip() {
  const { wallet: w } = useWalletPoll();
  if (!w) return null;
  const fut = w.futures?.usdt as { free?: number } | undefined;
  const futINR = w.futures?.inr as { free?: number } | undefined;
  const inr = w.spot?.inr as { free?: number } | undefined;
  const hasFutINR = (Number(futINR?.free) || 0) > 0;
  const hasFutUSDT = (Number(fut?.free) || 0) > 0;
  return (
    <div className="quantum-panel rounded-2xl p-3 mb-3 bg-gradient-to-r from-amber-500/[0.05] to-transparent">
      <div className="flex items-center gap-2 flex-wrap text-[10px] font-mono font-bold">
        <span className="text-amber-300 font-black tracking-wider">📱 COINDCX WALLET</span>
        <span className="text-emerald-300">equity {fmt(w.equityINR)}</span>
        <span className="text-slate-400">spot INR {fmt(inr?.free ?? 0)}</span>
        <span className="text-cyan-300">
          futures margin{' '}
          {hasFutINR && !hasFutUSDT
            ? `₹${(futINR?.free ?? 0).toLocaleString('en-IN', { maximumFractionDigits: 2 })} (INR)`
            : hasFutINR && hasFutUSDT
              ? `${(fut?.free ?? 0).toLocaleString('en-US', { maximumFractionDigits: 2 })} USDT + ₹${(futINR?.free ?? 0).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`
              : fut?.free != null
                ? `${fut.free.toLocaleString('en-US', { maximumFractionDigits: 2 })} USDT`
                : '—'}
        </span>
        <span className="text-slate-600">USD/₹ {w.usdInr ?? '—'}</span>
        <span className="ml-auto text-slate-600">{ago(w.fetchedAt)}</span>
      </div>
      {(w.spot?.error || w.futures?.error) && (
        <div className="text-[9px] text-amber-500/80 mt-1 font-mono">⚠ {w.spot?.error || w.futures?.error}</div>
      )}
    </div>
  );
}

/** v12.0 PORTFOLIO HEAT — the pro desk's total-open-risk meter.
 *  Kitna risk abhi khada hai (saare open positions ke SL-distance risks
 *  ka sum, USDT desks live FX se INR me), equity ke against % me, plus
 *  the two concentration warnings prop desks scream about:
 *    • NO-SL positions (risk = unbounded — red flag)
 *    • same-side pile-up (crypto sab BTC ke saath chalta hai)
 *  v20.2: rides the SHARED useWalletPoll store — WalletCard aur WalletStrip
 *  ke saath EK hi 60s poller (pehle 3 independent signed wallet calls/min
 *  jaate the). Silent degrade. */
function PortfolioHeat({ positions }: { positions: JournalPosition[] }) {
  const { wallet: w } = useWalletPoll();
  // v20.3 SIM SEPARATION (meter side): EQUITY SIM (USDC) paper rows are
  // practice money — summing their SL-distance against the user's REAL
  // wallet equity produced false HOT/DANGER bands + false "book risk
  // off" advice. The daily-stats separation (v20.2) now covers the heat
  // meter too. SIM rows still RENDER in the table (flagged · SIM).
  const open = positions.filter(p => p.status === 'OPEN' && !(p.isSim || (p.market === 'GLOBALFUTURES' && p.mode === 'paper')));
  if (open.length === 0) return null;
  let riskINR = 0;
  let noSl = 0;
  for (const p of open) {
    const sl = Number(p.sl);
    if (!(sl > 0)) { noSl += 1; continue; }
    const entry = Number(p.entryPrice);
    const qty = Number(p.qty) || 0;
    if (!(entry > 0) || !(qty > 0)) continue;
    const isFut = p.market === 'FUTURES' || p.market === 'GLOBALFUTURES';
    const fx = isFut ? (Number(p.usdInr) || Number(w?.usdInr) || 84) : 1;
    riskINR += Math.abs(entry - sl) * qty * fx;
  }
  const equity = Number(w?.equityINR) || null;
  const heatPct = equity != null && equity > 0 ? (riskINR / equity) * 100 : null;
  const longs = open.filter(p => p.side === 'LONG').length;
  const shorts = open.length - longs;
  const band = heatPct == null ? 'UNKNOWN'
    : heatPct < 3 ? 'COOL' : heatPct < 6 ? 'WARM' : heatPct < 10 ? 'HOT' : 'DANGER';
  const bandCls = band === 'COOL' ? 'bg-emerald-500/15 text-emerald-300 border-emerald-500/40'
    : band === 'WARM' ? 'bg-cyan-500/15 text-cyan-300 border-cyan-500/40'
    : band === 'HOT' ? 'bg-amber-500/15 text-amber-300 border-amber-500/40'
    : band === 'DANGER' ? 'bg-red-500/20 text-red-300 border-red-500/50 animate-pulse'
    : 'bg-slate-600/20 text-slate-400 border-slate-600/30';
  return (
    <div className="px-4 pt-3 pb-1 border-b border-white/[0.04] bg-black/20">
      <div className="flex items-center gap-2 flex-wrap text-[10px] font-mono font-bold">
        <span className="text-slate-400 font-black tracking-wider">🔥 PORTFOLIO HEAT</span>
        <span className={`px-2 py-0.5 rounded-lg border font-black ${bandCls}`} title="Total open risk (sab open positions ka SL-distance risk, live FX se INR) vs total equity">
          {heatPct != null ? `${heatPct.toFixed(2)}%` : '—'} · {band}{band === 'HOT' ? ' — no new full-size entries' : band === 'DANGER' ? ' — book risk off' : ''}
        </span>
        <span className="text-slate-400" title="Agar SAB SL hit hue (worst case, correlated) — utna ₹ jalega">risk {fmt(riskINR)}</span>
        {equity != null && <span className="text-slate-600" title="Total equity (spot + futures, live USD/₹)">vs equity {fmt(equity)}</span>}
        <span className="text-slate-600" title="Same-side concentration — crypto sab BTC ke saATH move karta hai">{longs}L/{shorts}S</span>
        {Math.max(longs, shorts) >= 3 && (
          <span className="px-1.5 py-0.5 rounded text-[9px] font-black bg-amber-500/15 text-amber-300 border border-amber-500/40"
            title="3+ positions ek hi side — ek BTC move par sab ek saath hit honge (correlated bet)">
            ⚠ SAME-SIDE PILE-UP
          </span>
        )}
        {noSl > 0 && (
          <span className="px-1.5 py-0.5 rounded text-[9px] font-black bg-red-500/15 text-red-300 border border-red-500/50 animate-pulse"
            title={`${noSl} position(s) bina SL ke — risk unbounded hai. SL lagao ya size kam karo.`}>
            🚨 {noSl} NO-SL POSITION{noSl > 1 ? 'S' : ''}
          </span>
        )}
      </div>
    </div>
  );
}

function ConfigEditor({ config, busy, onSave, state, venue }: {
  config: TradingConfig; busy?: boolean;
  onSave: (patch: Record<string, unknown>) => Promise<{ ok: boolean; error?: string }>;
  state: TradingState | null;
  /** v6.9: desk-scoped — India desk hides crypto arming/limits; CoinDCX
   *  desk hides India fields. undefined = full console (legacy). */
  venue?: 'INDIA' | 'COINDCX';
}) {
  const [minConf, setMinConf] = useState(String(config.minConfidence));
  const [maxOrder, setMaxOrder] = useState(String(config.maxOrderINR));
  const [indiaMaxOrder, setIndiaMaxOrder] = useState(String(config.indiaMaxOrderINR ?? 5000));
  const [dailyTrades, setDailyTrades] = useState(String(config.dailyMaxTrades));
  const [dailyLoss, setDailyLoss] = useState(String(config.dailyMaxLossINR));
  const [maxStop, setMaxStop] = useState(String(config.maxRiskPct ?? 5));
  const [trailArm, setTrailArm] = useState(String(config.trailArmR ?? 1));
  const [trailOff, setTrailOff] = useState(String(config.trailOffsetR ?? 1));
  const [maxLev, setMaxLev] = useState(String(config.cryptoLeverage ?? 1));
  const [maxOpen, setMaxOpen] = useState(String(config.maxOpenPositions ?? 5));
  const [phrase, setPhrase] = useState('');
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const rootRef = useRef<HTMLDivElement>(null); // v7.0.2: mid-edit resync guard
  // v10.18 (deep-recheck #3): timer-ref toast — a stale timer used to wipe
  // a newer save message early (two SET clicks inside 4s).
  const msgTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // v6.2: resync the number boxes whenever the SERVER config changes (60s
  // state poll, kill-switch auto-disarm, another device's SET) — the boxes
  // were initialized once and then showed stale values while the badges
  // above showed the real ones; clicking SET pushed the stale box back.
  // v7.0.2 FIX: the 60s poll creates a NEW config object identity even when
  // values are identical, so this effect re-fired every minute and silently
  // reverted a box the user was MID-TYPING in. Skip while any editor inside
  // this panel is focused; the user's blur/SET will resync on the next real
  // config change.
  const cfgKey = [
    config.minConfidence, config.maxOrderINR, config.indiaMaxOrderINR,
    config.dailyMaxTrades, config.dailyMaxLossINR, config.maxRiskPct,
    config.trailArmR, config.trailOffsetR, config.cryptoLeverage, config.maxOpenPositions,
  ].join('|');
  useEffect(() => {
    const root = rootRef.current;
    const activeEl = document.activeElement;
    if (root && activeEl instanceof HTMLElement && root.contains(activeEl)
      && (activeEl.tagName === 'INPUT' || activeEl.tagName === 'SELECT')) {
      return; // user is editing — don't clobber their half-typed value
    }
    setMinConf(String(config.minConfidence));
    setMaxOrder(String(config.maxOrderINR));
    setIndiaMaxOrder(String(config.indiaMaxOrderINR ?? 5000));
    setDailyTrades(String(config.dailyMaxTrades));
    setDailyLoss(String(config.dailyMaxLossINR));
    setMaxStop(String(config.maxRiskPct ?? 5));
    setTrailArm(String(config.trailArmR ?? 1));
    setTrailOff(String(config.trailOffsetR ?? 1));
    setMaxLev(String(config.cryptoLeverage ?? 1));
    setMaxOpen(String(config.maxOpenPositions ?? 5));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cfgKey]);

  const save = async (patch: Record<string, unknown>) => {
    const r = await onSave(patch);
    setMsg({ ok: r.ok, text: r.ok ? 'Saved ✓' : (r.error || 'failed') });
    if (msgTimer.current) clearTimeout(msgTimer.current);
    msgTimer.current = setTimeout(() => setMsg(null), 4000);
    return r;
  };

  useEffect(() => () => { if (msgTimer.current) clearTimeout(msgTimer.current); }, []);

  return (
    <div ref={rootRef} className="quantum-panel rounded-2xl p-4 space-y-3">
      <div className="flex items-center justify-between">
        <span className="text-xs font-black text-slate-200">🛡️ RISK & EXECUTION SETTINGS{venue === 'INDIA' ? ' — INDIA DESK' : venue === 'COINDCX' ? ' — COINDCX DESK' : ''}</span>
        {msg && <span className={`text-[10px] font-bold ${msg.ok ? 'text-emerald-400' : 'text-red-400'}`}>{msg.text}</span>}
      </div>

      {/* Mode arm/disarm (crypto LIVE — CoinDCX venue only) */}
      {venue !== 'INDIA' && (
      <div className="flex items-center gap-2 flex-wrap">
        <span className={`px-3 py-1.5 rounded-xl text-[11px] font-black border ${config.mode === 'live' ? 'bg-red-500/15 text-red-300 border-red-500/40 animate-pulse' : 'bg-cyan-500/15 text-cyan-300 border-cyan-500/30'}`}>
          {config.mode === 'live' ? '🔴 LIVE MODE — REAL ORDERS' : '🧪 PAPER MODE — SIMULATED'}
        </span>
        {config.mode === 'paper' ? (
          <div className="flex gap-1.5 items-center">
            <input value={phrase} onChange={e => setPhrase(e.target.value)} placeholder='type LIVE'
              className="quantum-input px-3 py-1.5 rounded-lg text-[11px] font-mono w-28" aria-label="LIVE confirmation phrase" />
            <button onClick={() => { save({ mode: 'live', liveConfirmPhrase: phrase }); setPhrase(''); }}
              disabled={busy || phrase.trim().toUpperCase() !== 'LIVE'}
              className="px-3 py-1.5 rounded-lg text-[11px] font-black bg-red-600/80 text-white hover:bg-red-600 disabled:opacity-40">
              ⚡ ARM LIVE
            </button>
          </div>
        ) : (
          <button onClick={() => save({ mode: 'paper' })} disabled={busy}
            className="px-3 py-1.5 rounded-lg text-[11px] font-black bg-slate-700 text-slate-200 hover:bg-slate-600">
            ✋ Disarm to Paper
          </button>
        )}
      </div>
      )}

      {/* Auto toggle (crypto — CoinDCX venue only) */}
      {venue !== 'INDIA' && (
      <div className="flex items-center gap-2 flex-wrap">
        <button onClick={() => save({ allowAuto: !config.allowAuto })}
          disabled={busy || config.mode !== 'live'}
          title="Auto-executor: every 90s, executes only STRONG signals that pass ALL gates"
          className={`px-3 py-1.5 rounded-xl text-[11px] font-black border disabled:opacity-40 ${config.allowAuto ? 'bg-emerald-500/15 text-emerald-300 border-emerald-500/40' : 'bg-slate-600/20 text-slate-400 border-slate-600/30'}`}>
          {config.allowAuto ? '🤖 AUTO-EXECUTE ON (STRONG only)' : '🤖 Auto-execute OFF'}
        </button>
        {state?.blocked.notConnected && <span className="text-[10px] text-amber-400/80 font-bold" title="v18.10 se app\.env me COINDCX_API_KEY + COINDCX_SECRET daalne par server khud connect ho jata hai (boot pe). Ya Portfolio tab → Connect CoinDCX.">⚠️ CoinDCX not connected — .env me COINDCX_API_KEY+COINDCX_SECRET ya Portfolio tab → Connect</span>}
      </div>
      )}

      {/* v6.5: TRAILING STOP-LOSS */}
      <div className="flex items-center gap-2 gap-y-1.5 flex-wrap bg-black/20 rounded-xl px-3 py-2.5">
        <button onClick={() => save({ trailEnabled: !config.trailEnabled })}
          disabled={busy}
          title="Winners run: SL locks breakeven at +1R, then trails peak − 1R. Ratchet-only — kabhi loose nahi hota. Dono desks (crypto + India)."
          className={`px-3 py-1.5 rounded-xl text-[11px] font-black border ${config.trailEnabled ? 'bg-amber-500/15 text-amber-300 border-amber-500/40' : 'bg-slate-600/20 text-slate-400 border-slate-600/30'}`}>
          🔗 TRAILING SL {config.trailEnabled ? 'ON' : 'OFF'}
        </button>
        <label className="flex items-center gap-1 text-[9px] font-black text-slate-500 tracking-wider">
          ARM AT
          <input value={trailArm} onChange={e => setTrailArm(e.target.value)} className="quantum-input px-1.5 py-1 rounded-lg text-[10px] font-mono w-14" inputMode="decimal" aria-label="trail arm in R" />
          <span className="text-slate-600">R</span>
        </label>
        {/* v20.7.8 [H-1]: the two trail SET buttons bypassed the v18.9 NaN
            guard — an EMPTY box posted trailArmR: 0 (breakeven lock fires
            at 0R — SL pinned to entry on every LIVE position) and garbage
            posted NaN → null → silently dropped while the toast said
            "Saved ✓". Same guard shape as the numeric fields below. */}
        <button onClick={() => save({ trailArmR: Number(trailArm) })}
          disabled={busy || !config.trailEnabled || trailArm.trim() === '' || !Number.isFinite(Number(trailArm)) || !(Number(trailArm) > 0)}
          title={trailArm.trim() === '' || !Number.isFinite(Number(trailArm)) || !(Number(trailArm) > 0) ? '0 se bada number chahiye' : undefined}
          className="quantum-btn-ghost px-2 py-1 rounded-lg text-[9px] font-black disabled:opacity-40">SET</button>
        <label className="flex items-center gap-1 text-[9px] font-black text-slate-500 tracking-wider">
          TRAIL OFFSET
          <input value={trailOff} onChange={e => setTrailOff(e.target.value)} className="quantum-input px-1.5 py-1 rounded-lg text-[10px] font-mono w-14" inputMode="decimal" aria-label="trail offset in R" />
          <span className="text-slate-600">R</span>
        </label>
        <button onClick={() => save({ trailOffsetR: Number(trailOff) })}
          disabled={busy || !config.trailEnabled || trailOff.trim() === '' || !Number.isFinite(Number(trailOff)) || !(Number(trailOff) > 0)}
          title={trailOff.trim() === '' || !Number.isFinite(Number(trailOff)) || !(Number(trailOff) > 0) ? '0 se bada number chahiye' : undefined}
          className="quantum-btn-ghost px-2 py-1 rounded-lg text-[9px] font-black disabled:opacity-40">SET</button>
        <span className="text-[9px] text-slate-600">profit ≥ {config.trailArmR ?? 1}R → SL = breakeven → peak − {config.trailOffsetR ?? 1}R</span>
      </div>

      {/* Numeric limits */}
      <div className="grid grid-cols-2 sm:grid-cols-6 gap-2">
        {[
          { label: 'Min conf %', val: minConf, set: setMinConf, key: 'minConfidence', hint: '50-95', venueOK: true, positive: true },
          { label: 'Max order ₹ (crypto)', val: maxOrder, set: setMaxOrder, key: 'maxOrderINR', hint: '≥100', venueOK: venue !== 'INDIA', positive: true },
          { label: 'India Max ₹', val: indiaMaxOrder, set: setIndiaMaxOrder, key: 'indiaMaxOrderINR', hint: '≥100', venueOK: venue !== 'COINDCX', positive: true },
          { label: 'Daily trades', val: dailyTrades, set: setDailyTrades, key: 'dailyMaxTrades', hint: '1-50', venueOK: true },
          { label: 'Daily loss ₹', val: dailyLoss, set: setDailyLoss, key: 'dailyMaxLossINR', hint: '≥50', venueOK: true },
          { label: 'Max stop %', val: maxStop, set: setMaxStop, key: 'maxRiskPct', hint: '1-20', venueOK: true, positive: true },
          { label: 'Max leverage × (crypto)', val: maxLev, set: setMaxLev, key: 'cryptoLeverage', hint: '1-10', venueOK: venue !== 'INDIA', positive: true },
          { label: 'Max open positions', val: maxOpen, set: setMaxOpen, key: 'maxOpenPositions', hint: '1-20', venueOK: true, positive: true },
        ].filter(f => f.venueOK).map(f => {
          /* v20.7.8 [H-2]: Number('') === 0 and isFinite(0) — a CLEARED box
            sailed through the v18.9 guard and SET the field to 0
            (minConfidence: 0, dailyMaxLossINR: 0, cryptoLeverage: 0 …
            corrupting the server-side risk envelope that gates LIVE
            orders). Empty must disable; 0 only passes where it is a
            legit explicit intent (daily caps). */
          const fNum = f.val.trim() === '' ? NaN : Number(f.val);
          const fBad = !Number.isFinite(fNum) || (f.positive ? !(fNum > 0) : fNum < 0);
          return (
          <div key={f.key}>
            <label className="text-[9px] text-slate-500 font-black tracking-wider block mb-1">{f.label.toUpperCase()}</label>
            <div className="flex gap-1">
              <input value={f.val} onChange={e => f.set(e.target.value)} className="quantum-input px-2 py-1.5 rounded-lg text-[11px] font-mono w-full" inputMode="numeric" />
              {/* v18.9: NaN guard — a non-numeric box used to POST null, the
                  server silently dropped it, the toast still said "Saved ✓"
                  and the 60s resync quietly reverted the value. */}
              <button onClick={() => save({ [f.key]: fNum })}
                disabled={busy || fBad}
                title={fBad ? 'sirf number valid hai' : undefined}
                className="quantum-btn-ghost px-2 rounded-lg text-[10px] font-black disabled:opacity-40">SET</button>
            </div>
          </div>
          );
        })}
      </div>
      <p className="text-[10px] text-slate-500 leading-relaxed">
        Gates enforced SERVER-SIDE on every order: STRONG grade (confidence + agreement), stop-distance ≤ {config.maxRiskPct ?? 5}%
        (v6.4: over-cap stops AUTO-FIT to this cap — SL tightened, targets re-derived; LIVE only fits mild overshoot ≤ 1.5×),
        daily trade/loss caps, one position per pair, 90s signal freshness. CoinDCX key needs trade permission for LIVE.
        v6.5: Trailing SL dono desks par watcher chalata hai (breakeven → peak-trail, ratchet-only).
        v6.6: Max leverage = crypto margin ceiling (1 = spot only) — ticket me leverage chips isi se clamp hoti hain; server-side bhi enforce. Liquidation-vs-SL sanity har order par check hota hai (PAPER auto-reduce, LIVE reject).
        v6.7: Max open positions = concentration guard — dono desks ka total open book isi par cap hota hai (default 5).
      </p>
    </div>
  );
}

// ---------------- v6.5: Dhan connect + India LIVE arming ----------------
function DhanPanel({ busy, onSave, dhan, indiaMode, onConnect, onDisconnect, onRefresh }: {
  busy?: boolean;
  onSave: (patch: Record<string, unknown>) => Promise<{ ok: boolean; error?: string }>;
  dhan: DhanStatus | null;
  indiaMode?: 'paper' | 'live';
  onConnect: (clientId: string, accessToken: string) => Promise<{ ok: boolean; error?: string }>;
  onDisconnect: () => Promise<{ ok: boolean; error?: string }>;
  onRefresh: () => void;
}) {
  const [clientId, setClientId] = useState('');
  const [accessToken, setAccessToken] = useState('');
  const [phrase, setPhrase] = useState('');
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const connected = !!dhan?.connected;
  // v10.18 (deep-recheck #3): timer-ref toast (stale timers wiped newer
  // connect/disconnect messages early).
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const flash = (ok: boolean, text: string) => {
    setMsg({ ok, text });
    if (flashTimer.current) clearTimeout(flashTimer.current);
    flashTimer.current = setTimeout(() => setMsg(null), 5000);
  };
  useEffect(() => () => { if (flashTimer.current) clearTimeout(flashTimer.current); }, []);

  const connect = useCallback(async () => {
    const r = await onConnect(clientId.trim(), accessToken.trim());
    flash(r.ok, r.ok ? '✅ Dhan connected — profile verified' : `⛔ ${r.error || 'connect failed'}`);
    if (r.ok) { setClientId(''); setAccessToken(''); onRefresh(); }
  }, [clientId, accessToken, onConnect, onRefresh]);

  const indiaArmed = indiaMode === 'live';

  return (
    <div className="quantum-panel rounded-2xl p-4 space-y-3" aria-label="Dhan broker panel">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-xs font-black text-slate-200">🇮🇳 INDIA BROKER — DHAN HQ (v6.5)</span>
        <span className={`px-2 py-0.5 rounded-lg text-[9px] font-black border ${connected ? 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30' : 'bg-slate-600/20 text-slate-500 border-slate-600/30'}`}>
          {connected ? `CONNECTED${dhan?.profile?.name ? ` · ${dhan.profile.name}` : ''}` : 'NOT CONNECTED'}
        </span>
        {msg && <span className={`text-[10px] font-bold ${msg.ok ? 'text-emerald-400' : 'text-red-400'}`}>{msg.text}</span>}
        {dhan?.scrips?.symbols ? <span className="text-[9px] text-slate-600 font-mono ml-auto">scrip master: {dhan.scrips.symbols.toLocaleString('en-IN')} symbols cached</span> : null}
      </div>

      {!connected ? (
        <>
          <div className="grid gap-2 sm:grid-cols-[130px_1fr_auto] items-end">
            <div>
              <label className="text-[9px] text-slate-500 font-black tracking-wider block mb-1">CLIENT ID</label>
              <input value={clientId} onChange={e => setClientId(e.target.value)} placeholder="1100xxxxx" inputMode="numeric"
                className="quantum-input px-3 py-1.5 rounded-lg text-[11px] font-mono w-full" autoComplete="off" aria-label="dhan client id" />
            </div>
            <div>
              <label className="text-[9px] text-slate-500 font-black tracking-wider block mb-1">ACCESS TOKEN (Dhan HQ web → Access Token)</label>
              <input value={accessToken} onChange={e => setAccessToken(e.target.value)} placeholder="paste long token" type="password"
                className="quantum-input px-3 py-1.5 rounded-lg text-[11px] font-mono w-full" autoComplete="off" spellCheck={false} aria-label="dhan access token" />
            </div>
            <button onClick={connect} disabled={busy || !clientId.trim() || !accessToken.trim()}
              className="px-3 py-1.5 rounded-lg text-[10px] font-black bg-gradient-to-r from-orange-600 to-amber-600 text-white disabled:opacity-40">
              🔗 CONNECT
            </button>
          </div>
          <p className="text-[10px] text-slate-500 leading-relaxed">
            Dhan app/web par <b>dhan.co → HQ section → APIs → Access Token</b> generate karo (validity: 24 ghante tak ya jab tak revoke na karo),
            wahi token yaha paste karo. Profile se <b>API segment enabled</b> hona chahiye. Token server-side encrypted backup me save hota hai —
            Render restart par bhi connected rehte ho. Zerodha Kite nahi hai kyunki uska session <b>daily OAuth</b> maangta hai — automation ke liye Dhan hi sahi hai.
          </p>
        </>
      ) : (
        <div className="flex items-center gap-2 flex-wrap">
          <button onClick={async () => { const r = await onDisconnect(); flash(r.ok, r.ok ? 'Disconnected' : `⛔ ${r.error}`); onRefresh(); }}
            disabled={busy} className="px-3 py-1.5 rounded-lg text-[10px] font-black bg-slate-700 text-slate-200 hover:bg-slate-600">
            ✋ Disconnect
          </button>
          <span className="text-[10px] text-slate-500">India execution: STRONG signals only · entry window 09:30–15:00 · square-off 15:15 IST · shared daily caps</span>
        </div>
      )}

      {/* India LIVE arming (separate from crypto) */}
      <div className="flex items-center gap-2 flex-wrap bg-black/20 rounded-xl px-3 py-2.5">
        <span className={`px-2.5 py-1 rounded-lg text-[10px] font-black border ${indiaArmed ? 'bg-red-500/15 text-red-300 border-red-500/40 animate-pulse' : 'bg-cyan-500/15 text-cyan-300 border-cyan-500/30'}`}>
          {indiaArmed ? '🔴 INDIA LIVE ARMED' : '🧪 INDIA PAPER MODE'}
        </span>
        {!indiaArmed ? (
          <div className="flex gap-1.5 items-center">
            <input value={phrase} onChange={e => setPhrase(e.target.value)} placeholder="type LIVE"
              className="quantum-input px-3 py-1.5 rounded-lg text-[11px] font-mono w-28" aria-label="India LIVE confirmation phrase" />
            <button onClick={async () => {
              const r = await onSave({ indiaMode: 'live', liveConfirmPhrase: phrase });
              flash(r.ok, r.ok ? '🔴 India LIVE armed — Dhan par ab STRONG India signals REAL orders de sakte hain' : `⛔ ${r.error}`);
              setPhrase('');
            }} disabled={busy || !connected || phrase.trim().toUpperCase() !== 'LIVE'}
              title={connected ? 'Typed LIVE required' : 'Dhan connect first'}
              className="px-3 py-1.5 rounded-lg text-[11px] font-black bg-red-600/80 text-white hover:bg-red-600 disabled:opacity-40">
              ⚡ ARM INDIA LIVE
            </button>
          </div>
        ) : (
          <button onClick={async () => { const r = await onSave({ indiaMode: 'paper' }); flash(r.ok, r.ok ? 'India disarmed to paper' : `⛔ ${r.error}`); }}
            disabled={busy}
            className="px-3 py-1.5 rounded-lg text-[11px] font-black bg-slate-700 text-slate-200 hover:bg-slate-600">
            ✋ Disarm India
          </button>
        )}
        <span className="text-[9px] text-slate-600">India arming ≠ crypto arming — dono alag, dono me typed LIVE chahiye</span>
      </div>
    </div>
  );
}

interface Props {
  state: TradingState | null;
  positions: JournalPosition[];
  entries: JournalEntry[];
  busy?: boolean;
  onClose: (id: string) => void;
  onSaveConfig: (patch: Record<string, unknown>) => Promise<{ ok: boolean; error?: string }>;
  /** v6.5: Dhan broker */
  dhan: DhanStatus | null;
  onDhanConnect: (clientId: string, accessToken: string) => Promise<{ ok: boolean; error?: string }>;
  onDhanDisconnect: () => Promise<{ ok: boolean; error?: string }>;
  onDhanRefresh: () => void;
  /** v6.9: desk scope — 'INDIA' = NSE positions + Dhan + India config;
   *  'COINDCX' = spot+futures positions + wallet + crypto config;
   *  undefined = the full console (legacy shared view). */
  venue?: 'INDIA' | 'COINDCX';
  /** v6.9: console heading override (per desk). */
  title?: string;
  /** v10.5.3: how the positions feed is being delivered — 'stream' =
   *  SSE diff-push (price-driven, sub-second on cached desks), 'poll'
   *  = REST fallback (5s), null = flat / connecting. Drives the honest
   *  LIVE dot on each open-position row. */
  positionsLive?: 'stream' | 'poll' | null;
  /** v10.17: called after the 🧹 CLEAR CLOSED sweep succeeds so the
   *  parent tab refetches positions (the SSE stream's structural
   *  push covers stream-connected clients; this covers everyone). */
  onPositionsChanged?: () => void;
}

export const OrderConsole = memo(function OrderConsole({ state, positions, entries, busy, onClose, onSaveConfig, dhan, onDhanConnect, onDhanDisconnect, onDhanRefresh, venue, title, positionsLive, onPositionsChanged }: Props) {
  const [tab, setTab] = useState<'positions' | 'journal'>('positions');
  // v10.17: CLEAR CLOSED — purges CLOSED rows server-side (ledger keeps
  // the permanent audit trail). Spinner + result chip while it runs.
  const [sweeping, setSweeping] = useState(false);
  const [sweepNote, setSweepNote] = useState<string | null>(null);
  // v10.18 (deep-recheck #3): timer-ref result chip (same toast-wipe fix)
  const sweepNoteTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onClearClosed = useCallback(async () => {
    if (sweeping) return;
    setSweeping(true);
    setSweepNote(null);
    const r = await clearClosedPositions();
    setSweeping(false);
    if (r.ok) {
      setSweepNote(r.removed ? `${r.removed} closed row${r.removed === 1 ? '' : 's'} cleared` : 'koi closed position tha hi nahi');
      onPositionsChanged?.();
    } else {
      setSweepNote(`⛔ ${r.error || 'clear-closed failed'}`);
    }
    if (sweepNoteTimer.current) clearTimeout(sweepNoteTimer.current);
    sweepNoteTimer.current = setTimeout(() => setSweepNote(null), 6000);
  }, [sweeping, onPositionsChanged]);
  useEffect(() => () => { if (sweepNoteTimer.current) clearTimeout(sweepNoteTimer.current); }, []);
  // v6.9: desk-scoped positions — India desk sees NSE rows only, CoinDCX
  // desk sees spot + futures rows only. Journal stays the FULL audit trail.
  const shown = venue === 'INDIA'
    ? positions.filter(p => p.market === 'INDIA')
    : venue === 'COINDCX'
      ? positions.filter(p => p.market !== 'INDIA')
      : positions;
  const open = shown.filter(p => p.status === 'OPEN');
  // v20.3: header count = REAL open rows (SIM flagged separately, same
  // honesty as the heat meter + daily stats).
  const openReal = open.filter(p => !(p.isSim || (p.market === 'GLOBALFUTURES' && p.mode === 'paper')));
  const simOpen = open.length - openReal.length;
  const closedCount = shown.filter(p => p.status === 'CLOSED').length;
  const cfg = state?.config;

  return (
    <section className="space-y-3" aria-label={title || 'Execution console'}>
      {/* v6.8: live CoinDCX wallet strip (spot + futures margin) — CoinDCX desk */}
      {venue !== 'INDIA' && <WalletStrip />}

      {/* Kill switch + risk meters */}
      <div className="quantum-panel rounded-2xl p-4">
        <div className="flex items-center gap-3 flex-wrap">
          <button
            onClick={() => onSaveConfig({ killSwitch: !cfg?.killSwitch })}
            disabled={busy}
            className={`px-4 py-2 rounded-xl text-xs font-black border-2 transition-all ${cfg?.killSwitch
              ? 'bg-red-600 text-white border-red-400 animate-pulse'
              : 'bg-red-500/10 text-red-300 border-red-500/40 hover:bg-red-500/20'}`}>
            ☠️ {cfg?.killSwitch ? 'KILL SWITCH ACTIVE — CLICK TO RELEASE' : 'KILL SWITCH'}
          </button>
          {state && (
            <div className="flex gap-4 flex-1 min-w-[240px]">
              <RiskBar label="Daily trades" value={state.stats.tradesCount} max={cfg?.dailyMaxTrades || 3} tone="cyan" />
              <RiskBar label="Daily loss ₹" value={Math.max(0, -(state.stats.realizedPnlINR || 0))} max={cfg?.dailyMaxLossINR || 500} tone="red" />
            </div>
          )}
          {/* v20.2 SIM DESK SEPARATION: the EQUITY SIM (USDC) desk ka
              trade-count + P&L ab alag dikhta hai — real caps me SIM
              kabhi gina nahi jata (server dailyStats me bhi excluded). */}
          {state?.stats && ((state.stats.simTradesCount ?? 0) > 0 || (state.stats.simRealizedPnlINR ?? 0) !== 0) && (
            <div className="flex items-center gap-2 text-[9px] font-mono font-bold text-slate-500">
              <span className="px-1.5 py-0.5 rounded border border-slate-600/40 bg-slate-700/20">EQUITY SIM (USDC) — alag book</span>
              <span>trades {state.stats.simTradesCount ?? 0} · P&amp;L ₹{state.stats.simRealizedPnlINR ?? 0}</span>
            </div>
          )}
        </div>
        {(state?.blocked.dailyTrades || state?.blocked.dailyLoss || state?.blocked.maxOpenPositions) && (
          <p className="text-[10px] text-red-400 font-bold mt-2">
            🚫 {state.blocked.dailyTrades ? 'Daily trade cap reached. ' : ''}{state.blocked.dailyLoss ? 'Daily loss cap breached. ' : ''}{state.blocked.maxOpenPositions ? 'Max open positions (concentration guard) hit. ' : ''}Resets at IST midnight.
          </p>
        )}
      </div>

      {/* Config editor */}
      {cfg && <ConfigEditor config={cfg} state={state} busy={busy} onSave={onSaveConfig} venue={venue} />}

      {/* v6.5: Dhan broker + India LIVE arming (India desk) */}
      {venue !== 'COINDCX' && (
        <DhanPanel busy={busy} onSave={onSaveConfig} dhan={dhan} indiaMode={cfg?.indiaMode} onConnect={onDhanConnect} onDisconnect={onDhanDisconnect} onRefresh={onDhanRefresh} />
      )}

      {/* Positions / Journal tabs */}
      <div className="quantum-panel rounded-2xl overflow-hidden">
        <div className="flex border-b border-white/5">
          {(['positions', 'journal'] as const).map(t => (
            <button key={t} onClick={() => setTab(t)}
              className={`px-4 py-2.5 text-[11px] font-black transition-all ${tab === t ? 'text-cyan-300 border-b-2 border-cyan-400 bg-cyan-500/5' : 'text-slate-500 hover:text-slate-300'}`}>
              {t === 'positions' ? `📋 POSITIONS (${openReal.length} open${simOpen > 0 ? ` + ${simOpen} SIM` : ''}${venue === 'INDIA' ? ' · 🇮🇳 NSE' : venue === 'COINDCX' ? ' · ₿ COINDCX' : ''})` : '📜 AUDIT JOURNAL'}
            </button>
          ))}
          {/* v10.5.3 FEED HONESTY — the old label claimed "ULTRA STREAM"
              while the rows were fed by a 5s REST poll. The badge now says
              exactly what is feeding them: SSE push (green, pulsing) vs
              REST poll fallback. */}
          {tab === 'positions' && open.length > 0 && (
            positionsLive === 'stream' ? (
              <span
                className="ml-auto self-center mr-3 flex items-center gap-1.5 text-[9px] font-black tracking-wider text-emerald-300"
                title="SSE diff-push (/api/ai/positions/stream) — server har price change par sirf usi row ka LTP/P&L push karta hai. Crypto/futures/global ~1s cadence, India market-hours cadence.">
                <span className="relative flex h-2 w-2" aria-hidden="true">
                  <span className="absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75 animate-ping" />
                  <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500" />
                </span>
                LIVE PUSH
              </span>
            ) : (
              <span
                className="ml-auto self-center mr-3 flex items-center gap-1.5 text-[9px] font-black tracking-wider text-slate-500"
                title={positionsLive === 'poll'
                  ? 'Stream down — REST fallback (5s poll). Connection wapas aane par push resume ho jayega.'
                  : 'Connecting — pehla snapshot aane tak REST poll chal raha hai.'}>
                <span className="inline-flex rounded-full h-1.5 w-1.5 bg-slate-500" aria-hidden="true" />
                {positionsLive === 'poll' ? 'POLL · 5s' : 'CONNECTING'}
              </span>
            )
          )}
          {/* v10.17 — 🧹 CLEAR CLOSED: purges the CLOSED rows from the
              console (server-side journal sweep; the tamper-evident ledger
              keeps the permanent audit trail). Only shown when there ARE
              closed rows cluttering this desk's list. */}
          {tab === 'positions' && closedCount > 0 && (
            <button
              onClick={onClearClosed}
              disabled={sweeping || busy}
              title={`journal me se ${closedCount} CLOSED row(s) sweep karo — audit trail (LEDGER + journal entries) intact rehta hai`}
              className="self-center mr-3 px-2.5 py-1 rounded-lg text-[9px] font-black bg-slate-700/60 text-slate-300 hover:bg-slate-600 border border-white/10 disabled:opacity-50">
              <span className={sweeping ? 'inline-block animate-spin' : ''}>🧹</span> CLEAR CLOSED ({closedCount})
            </button>
          )}
          {tab === 'positions' && sweepNote && (
            <span className="self-center mr-3 text-[9px] font-black text-cyan-300">{sweepNote}</span>
          )}
        </div>

        {tab === 'positions' && (
          <>
            {/* v12.0: total open-risk meter — heat %, no-SL flags, pile-up */}
            <PortfolioHeat positions={shown} />
            <div className="max-h-96 overflow-y-auto">
            {shown.length === 0 && (
              <div className="p-8 text-center text-slate-500 text-xs">
                {venue === 'INDIA'
                  ? 'No India positions yet — TOP 5 / Signal Board se 🚀 TRADE karo (PAPER always available)'
                  : venue === 'COINDCX'
                    ? 'No CoinDCX positions yet — crypto/futures signal ka ticket kholo (PAPER always available)'
                    : 'No positions yet — execute a STRONG signal (PAPER is always available)'}
              </div>
            )}
            {shown.map(p => {
              const upnl = p.unrealizedPnlINR ?? 0;
              const open = p.status === 'OPEN';
              const isIndia = p.market === 'INDIA';
              const isFut = p.market === 'FUTURES' || p.market === 'GLOBALFUTURES'; // v6.8/v10.4 — prices/P&L in the USDT domain
              const isGlobal = p.market === 'GLOBALFUTURES';
              // v7.0.2: null-guard every ₹-branch price — `SL ₹undefined`
              // used to render when a trailing/BE position nulled its SL.
              const pf = (n?: number | null, dp = 2) => isFut
                ? (n?.toLocaleString('en-US', { maximumFractionDigits: dp }) ?? '—')
                : (n == null ? '—' : `₹${n.toLocaleString('en-IN', { maximumFractionDigits: dp })}`);
              return (
                <div key={p.id} className="px-4 py-3 border-b border-white/[0.03] hover:bg-white/[0.02]">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-sm font-black font-mono text-white">{p.pair}</span>
                    {isIndia && <span className="px-1.5 py-0.5 rounded text-[9px] font-black bg-orange-500/15 text-orange-300">🇮🇳 NSE</span>}
                    {isGlobal && <span className="px-1.5 py-0.5 rounded text-[9px] font-black bg-sky-500/15 text-sky-300" title="CoinDCX Global Futures — USDC perps (app-parity live feed; Yahoo fallback; SPACEX synthetic)">🌍 GLOBAL {p.isSim ? '· SIM' : ''} · USDC</span>}
                    {p.market === 'FUTURES' && <span className="px-1.5 py-0.5 rounded text-[9px] font-black bg-violet-500/15 text-violet-300">⚡ PERP · USDT</span>}
                    {p.source === 'agent' && <span className="px-1.5 py-0.5 rounded text-[9px] font-black bg-cyan-500/15 text-cyan-300" title="Superintelligence Auto-Agent ka trade">🤖 AGENT</span>}
                    <span className={`text-[11px] font-black ${p.side === 'LONG' ? 'text-emerald-400' : 'text-red-400'}`}>{p.side}</span>
                    <span className={`px-1.5 py-0.5 rounded text-[9px] font-black ${p.mode === 'live' ? 'bg-red-500/15 text-red-300' : 'bg-cyan-500/15 text-cyan-300'}`}>{p.mode.toUpperCase()}</span>
                    {p.leverage != null && p.leverage > 1 && (
                      <span className="px-1.5 py-0.5 rounded text-[9px] font-black bg-violet-500/15 text-violet-300" title={isFut ? `margin ${p.marginUSDT} USDT · notional ${p.notionalUSDT} USDT` : `margin ${p.marginINR != null ? `₹${p.marginINR.toLocaleString('en-IN')}` : '—'} · notional ${p.notionalINR != null ? `₹${p.notionalINR.toLocaleString('en-IN')}` : '—'}`}>
                        {p.leverage}x {isFut ? 'LEV' : 'MARGIN'}
                      </span>
                    )}
                    {p.trailing && open && (
                      <span className="px-1.5 py-0.5 rounded text-[9px] font-black bg-amber-500/15 text-amber-300" title={`peak ${pf(p.peakPrice)} — ratchet-only`}>
                        🔗 {p.trailing === 'breakeven' ? 'BE LOCKED' : 'TRAILING'}
                      </span>
                    )}
                    {/* v7.0 PRO TRADER: exit-stage chip on partial-TP positions */}
                    {open && p.tp1Hit && (
                      <span className="px-1.5 py-0.5 rounded text-[9px] font-black bg-emerald-500/15 text-emerald-300" title={`3-tier exit: T1 ${p.tp1Hit ? 'booked' : '—'} · T2 ${p.tp2Hit ? 'booked' : '—'} · runner trailing`}>
                        {p.tp2Hit ? '⚡ RUNNER (80% booked)' : '🟡 T1 HIT (40% booked)'}
                      </span>
                    )}
                    {open && p.bookedPnlINR != null && (
                      <span className={`text-[10px] font-black font-mono ${(p.bookedPnlINR || 0) >= 0 ? 'text-emerald-400' : 'text-red-400'}`} title="realized via partial T1/T2 legs">
                        booked {p.bookedPnlINR >= 0 ? '+' : ''}{fmt(p.bookedPnlINR)}
                      </span>
                    )}
                    {!open && <span className="px-1.5 py-0.5 rounded text-[9px] font-black bg-slate-600/20 text-slate-400">{p.closeReason || 'CLOSED'}</span>}
                    <span className="ml-auto text-[11px] font-mono text-slate-400">{p.qty} @ {pf(p.entryPrice)}</span>
                    {/* v7.0.1: live LTP with source honesty — pulse dot when a
                        live feed drives it, ~TV tag on the USD-fallback path,
                        STALE tag only when every feed failed (frozen).
                        v10.5.3: the tooltip + dot colour now tell the TRUTH
                        about delivery too (SSE push vs REST poll) — the old
                        "5s ultra-stream" text claimed streaming that wasn't. */}
                    {open && p.ltp != null && (
                      <span
                        className="text-[11px] font-mono text-slate-300 flex items-center gap-1"
                        title={p.priceSource === 'coindcx-gf-rt'
                          ? 'CoinDCX Global Futures live feed (USDC) — the SAME LTP the CoinDCX app shows, ~1s fresh'
                          : p.priceSource === 'tv-usd-fallback'
                          ? 'CoinDCX feed unavailable — TradingView USD price × live USD/₹ (approx, live)'
                          : p.priceSource === 'global-sim'
                            ? 'SPACEX SIM — deterministic synthetic walk (clearly-labeled simulation, not a market price)'
                            : p.priceSource === 'entry-fallback'
                              ? 'No live feed reachable — price frozen at entry price'
                              : positionsLive === 'stream'
                                ? 'Live price — SSE diff-push (/api/ai/positions/stream): har change par server khud push karta hai'
                                : positionsLive === 'poll'
                                  ? 'Live price — REST poll fallback (5s) jab tak stream reconnect hota hai'
                                  : 'Live price — 5s refresh while position is open'}>
                        → {pf(p.ltp)}{isGlobal ? <span className="text-[8px] font-black text-sky-400"> USDC</span> : null}
                        {p.priceSource === 'tv-usd-fallback' && <span className="text-[8px] font-black text-amber-400">~TV</span>}
                        {p.priceSource === 'entry-fallback' && <span className="text-[8px] font-black text-red-400">STALE</span>}
                        {p.priceSource !== 'entry-fallback' && (
                          <span className="relative flex h-1.5 w-1.5" aria-hidden="true">
                            {positionsLive === 'stream'
                              ? <span className="absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-60 animate-ping" />
                              : null}
                            <span className={`relative inline-flex rounded-full h-1.5 w-1.5 ${positionsLive === 'stream' ? 'bg-emerald-500' : 'bg-cyan-500'}`} />
                          </span>
                        )}
                      </span>
                    )}
                    <span className={`text-xs font-black font-mono ${upnl >= 0 ? 'text-emerald-400' : 'text-red-400'}`} title={isFut ? `≈ ${p.unrealizedPnlUSDT != null ? `${p.unrealizedPnlUSDT >= 0 ? '+' : ''}${p.unrealizedPnlUSDT} USDT` : 'n/a'} @ USD/₹ ${p.usdInr ?? '—'}` : undefined}>
                      {upnl >= 0 ? '+' : ''}{fmt(upnl)}
                    </span>
                    {open && (
                      <button onClick={() => onClose(p.id)} disabled={busy}
                        className="quantum-btn-ghost px-2.5 py-1 rounded-lg text-[10px] font-black disabled:opacity-50">
                        CLOSE
                      </button>
                    )}
                  </div>
                  {open && (p.sl != null || p.tp != null || p.tp2 != null) && (
                    <div className="flex gap-3 mt-1.5 text-[10px] font-mono flex-wrap">
                      {p.sl != null && <span className="text-red-400/70">SL {pf(p.sl)}</span>}
                      {(p.tp != null || p.tp2 != null) && <span className="text-emerald-400/70">TP {pf(p.tp)} / {pf(p.tp2)}</span>}
                      {p.peakPrice != null && p.peakPrice > 0 && (
                        <span className="text-amber-400/70" title="best price since entry (trailing anchor)">🔺 peak {pf(p.peakPrice)}</span>
                      )}
                      {p.leverage != null && p.leverage > 1 && p.liquidation != null && (
                        <span className="text-violet-400/70" title={`estimated liquidation (${p.leverage}x, ~5% maintenance buffer${p.liquidationSource === 'exchange' ? ' — exchange-reported' : ''})`}>⚠ LIQ {pf(p.liquidation)}</span>
                      )}
                      <span className="text-slate-600">{isIndia ? 'watcher + 15:15 square-off' : isFut ? 'futures watcher + native TP/SL + agent time-exit' : 'watcher auto-closes on breach'}</span>
                    </div>
                  )}
                  <div className="text-[10px] text-slate-600 mt-1">
                    {p.signal?.grade && <span className="text-slate-500">from {p.signal.grade} signal ({p.signal.confidence}%) · </span>}
                    {ago(p.status === 'OPEN' ? p.openedAt : (p.closedAt || p.openedAt))}
                  </div>
                </div>
              );
            })}
            </div>
          </>
        )}

        {tab === 'journal' && (
          <div className="max-h-96 overflow-y-auto">
            {entries.length === 0 && <div className="p-8 text-center text-slate-500 text-xs">Empty — every execution attempt (approved or rejected) lands here</div>}
            {entries.map(e => {
              // v7.0 PRO TRADER: PARTIAL_TP legs render green (booked profit legs)
              const isPartial = e.kind === 'PARTIAL_TP';
              const chipCls = isPartial
                ? 'bg-emerald-500/15 text-emerald-300'
                : e.status === 'FILLED' || e.status === 'SUBMITTED' ? 'bg-emerald-500/15 text-emerald-300'
                : e.status === 'REJECTED' || e.status === 'FAILED' ? 'bg-red-500/15 text-red-300'
                : 'bg-slate-600/20 text-slate-400';
              return (
              <div key={e.id} className={`px-4 py-2.5 border-b border-white/[0.03] text-[11px] flex items-center gap-2 flex-wrap hover:bg-white/[0.02] ${isPartial ? 'bg-emerald-500/[0.03]' : ''}`}>
                <span className={`px-1.5 py-0.5 rounded text-[9px] font-black ${chipCls}`}>{isPartial ? `💰 PARTIAL ${e.stage || 'TP'}` : e.status}</span>
                <span className="font-mono text-slate-300 w-20">{e.pair || '—'}</span>
                <span className="font-mono text-slate-500">{e.side || ''} {e.qty || ''}</span>
                {e.pnlINR != null && <span className={`font-mono font-bold ${(e.pnlINR || 0) >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>{(e.pnlINR || 0) >= 0 ? '+' : ''}{fmt(e.pnlINR)}</span>}
                {isPartial && e.remainingQty != null && <span className="text-[9px] font-mono text-slate-500">runner {e.remainingQty}</span>}
                {e.reason && <span className="text-slate-500 truncate max-w-[300px]">{e.reason}</span>}
                <span className="ml-auto text-slate-600 font-mono text-[10px]">{ago(e.ts)}</span>
              </div>
              );
            })}
          </div>
        )}
      </div>
    </section>
  );
});
