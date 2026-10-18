// ============================================================
// src/components/aitrading/ProPanels.tsx — v6.7 + v6.11 PRO PANELS
// ------------------------------------------------------------
// Read-only intelligence layers (glama-inspired):
//   • MorningBriefPanel  — one call, the whole desk (+ next-actions)
//   • SwingDeskPanel     — 3–8 day multi-factor setups (no execution)
//   • WhaleRadarPanel    — volume-spike footprints (2.5x+ vs 20-bar)
//   • SignalLedgerPanel  — SHA-256 tamper-evident track record
//   • OrderbookPanel     — CoinDCX depth + imbalance + walls
// v6.11 (glama Tier-2/3):
//   • TrustLayerPanel    — calibration + Brier + monthly trend + p-values
//   • PerfAnalyticsPanel — MDD/Sharpe/Sortino/Calmar on ledger R-series
//   • CorrelationPanel   — cross-asset 60d matrix + BTC↔NIFTY risk link
//   • SectorMapPanel     — sector sentiment + macro context chain + F-Score
// ============================================================
import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { fetchMorningBrief, fetchSwingBoard, fetchWhales, fetchLedger, fetchOrderbook, fetchTrust, fetchPerf, fetchCorrelations, fetchSectors } from './useAITrading';
import type { MarketKind, MorningBrief, SwingBoard, WhaleRadar, LedgerView, OrderbookView, TrustView, PerfView, CorrView, SectorView } from './types';

const inr = (v: number | null | undefined, dp = 0) =>
  v == null || !Number.isFinite(v) ? '—' : `₹${v.toLocaleString('en-IN', { maximumFractionDigits: dp })}`;

function PanelShell({ title, tag, onRefresh, loading, children }: {
  title: string; tag?: string; onRefresh?: () => void; loading?: boolean; children: React.ReactNode;
}) {
  return (
    <div className="quantum-panel rounded-2xl p-4">
      <div className="flex items-center justify-between gap-2 mb-3">
        <span className="text-xs font-black text-slate-200">{title}</span>
        <div className="flex items-center gap-2">
          {tag && <span className="px-2 py-0.5 rounded-md text-[9px] font-black bg-cyan-500/10 text-cyan-300 border border-cyan-500/20">{tag}</span>}
          {onRefresh && (
            <button onClick={onRefresh} className="quantum-btn-ghost px-2 py-1 rounded-lg text-[10px] font-bold" aria-label={`Refresh ${title}`}>
              <span className={loading ? 'inline-block animate-spin' : ''}>🔄</span>
            </button>
          )}
        </div>
      </div>
      {children}
    </div>
  );
}

function EmptyNote({ children }: { children: React.ReactNode }) {
  return <div className="py-5 text-center text-[11px] text-slate-500">{children}</div>;
}

// ---------------- Morning Brief ----------------
export const MorningBriefPanel = memo(function MorningBriefPanel() {
  const [brief, setBrief] = useState<MorningBrief | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    const b = await fetchMorningBrief();
    setBrief(b);
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  const m = brief?.market;
  const book = brief?.book;
  return (
    <PanelShell title="☀️ Morning Brief — poora desk ek nazar me" tag="v6.7" onRefresh={load} loading={loading}>
      {!brief && <EmptyNote>{loading ? 'Desk assemble ho raha hai…' : 'Brief unavailable — retry in 30s.'}</EmptyNote>}
      {brief && (
        <div className="space-y-3">
          {/* market strip */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-1.5">
            <div className="bg-black/30 rounded-xl px-2 py-1.5 text-center">
              <div className="text-[8px] text-slate-500 font-black tracking-wider">NIFTY</div>
              <div className="text-xs font-mono font-black text-slate-200">{m?.nifty?.toLocaleString('en-IN', { maximumFractionDigits: 0 }) ?? '—'}</div>
              <div className={`text-[9px] font-mono ${(m?.niftyChangePct ?? 0) >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>{m?.niftyChangePct != null ? `${m.niftyChangePct >= 0 ? '+' : ''}${m.niftyChangePct.toFixed(2)}%` : ''}</div>
            </div>
            <div className="bg-black/30 rounded-xl px-2 py-1.5 text-center">
              <div className="text-[8px] text-slate-500 font-black tracking-wider">INDIA VIX</div>
              <div className="text-xs font-mono font-black text-slate-200">{m?.indiaVix?.toFixed(1) ?? '—'}</div>
            </div>
            <div className="bg-black/30 rounded-xl px-2 py-1.5 text-center">
              <div className="text-[8px] text-slate-500 font-black tracking-wider">BTC</div>
              <div className="text-xs font-mono font-black text-slate-200">{m?.btc ? '$' + m.btc.toLocaleString('en-US', { maximumFractionDigits: 0 }) : '—'}</div>
              <div className={`text-[9px] font-mono ${(m?.btcChangePct ?? 0) >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>{m?.btcChangePct != null ? `${m.btcChangePct >= 0 ? '+' : ''}${m.btcChangePct.toFixed(2)}%` : ''}</div>
            </div>
            <div className="bg-black/30 rounded-xl px-2 py-1.5 text-center">
              <div className="text-[8px] text-slate-500 font-black tracking-wider">NSE</div>
              <div className={`text-xs font-black ${brief.nseOpen ? 'text-emerald-400' : 'text-slate-500'}`}>{brief.nseOpen ? 'OPEN' : 'CLOSED'}</div>
            </div>
          </div>

          {/* top signals */}
          <div className="grid sm:grid-cols-2 gap-2">
            {(['india', 'crypto'] as const).map(k => (
              <div key={k} className="bg-black/25 rounded-xl p-2.5">
                <div className="text-[9px] font-black text-slate-500 tracking-wider mb-1.5">{k === 'india' ? '🇮🇳 TOP NSE SIGNALS' : '₿ TOP CRYPTO SIGNALS'}</div>
                {(brief.topSignals[k] || []).length === 0 && <div className="text-[10px] text-slate-600">koi STRONG/ACTION nahi — silence is a signal</div>}
                {(brief.topSignals[k] || []).map((s, i) => (
                  <div key={i} className="flex items-center gap-2 text-[11px] font-mono py-0.5">
                    <span className={`font-black ${s.side === 'LONG' ? 'text-emerald-400' : 'text-red-400'}`}>{s.side}</span>
                    <span className="text-slate-200 font-bold">{s.symbol}</span>
                    <span className="text-slate-500">{s.grade} {s.confidence}%</span>
                    {s.plan && <span className="text-slate-600 ml-auto text-[10px]">SL {s.plan.stopLoss} · T2 {s.plan.target2}</span>}
                  </div>
                ))}
              </div>
            ))}
          </div>

          {/* book + caps */}
          <div className="grid sm:grid-cols-2 gap-2">
            <div className="bg-black/25 rounded-xl p-2.5">
              <div className="text-[9px] font-black text-slate-500 tracking-wider mb-1.5">📋 OPEN BOOK</div>
              {(book?.openPositions || []).length === 0 && <div className="text-[10px] text-slate-600">flat — no open positions</div>}
              {(book?.openPositions || []).map((p, i) => (
                <div key={i} className="flex items-center gap-2 text-[11px] font-mono py-0.5">
                  <span className="text-slate-600">{p.market === 'INDIA' ? '🇮🇳' : '₿'}</span>
                  <span className={`font-black ${p.side === 'LONG' ? 'text-emerald-400' : 'text-red-400'}`}>{p.side}</span>
                  <span className="text-slate-200">{p.symbol}</span>
                  <span className="text-slate-500">{p.mode}</span>
                  <span className={`ml-auto ${(p.uPnl ?? 0) >= 0 ? 'text-emerald-300' : 'text-red-300'}`}>{inr(p.uPnl, 0)}</span>
                </div>
              ))}
              <div className="mt-1.5 pt-1.5 border-t border-white/5 flex justify-between text-[10px] font-mono text-slate-500">
                <span>Today: {book?.tradesToday ?? 0}/{book?.caps?.dailyMaxTrades ?? '—'} trades</span>
                <span className={(book?.todayRealized ?? 0) >= 0 ? 'text-emerald-400' : 'text-red-400'}>{inr(book?.todayRealized ?? null)}</span>
              </div>
            </div>
            <div className="bg-black/25 rounded-xl p-2.5">
              <div className="text-[9px] font-black text-slate-500 tracking-wider mb-1.5">🛡️ GUARDS</div>
              <div className="grid grid-cols-2 gap-1 text-[10px] font-mono">
                {Object.entries(book?.caps?.blocked || {}).filter(([, v]) => v).length === 0
                  ? <div className="col-span-2 text-emerald-400">✅ sab clear — no cap breached</div>
                  : Object.entries(book?.caps?.blocked || {}).filter(([, v]) => v).map(([k2]) => (
                    <div key={k2} className="text-amber-300">⚠ {k2 === 'dailyTrades' ? 'daily trade cap' : k2 === 'dailyLoss' ? 'daily loss cap' : k2 === 'maxOpenPositions' ? 'max open positions' : k2}</div>
                  ))}
                <div className="col-span-2 text-slate-600 mt-1">open positions: {book?.openPositions?.length ?? 0} / {book?.caps?.maxOpenPositions ?? '—'} max</div>
              </div>
              {brief.ledger && (
                <div className="mt-1.5 pt-1.5 border-t border-white/5 flex items-center gap-2 text-[10px] font-mono text-slate-500">
                  <span>{brief.ledger.verified ? '🔒' : '⛔'} ledger {brief.ledger.entries} entries</span>
                  {brief.ledger.winRate != null && <span className={brief.ledger.winRate >= 50 ? 'text-emerald-400' : 'text-red-400'}>{brief.ledger.winRate}% WR</span>}
                </div>
              )}
            </div>
          </div>

          {/* v6.11: next-actions — the "ab kya karein" chips (glama oneqaz) */}
          {(brief.nextActions || []).length > 0 && (
            <div className="bg-cyan-500/[0.06] border border-cyan-500/15 rounded-xl p-2.5">
              <div className="text-[9px] font-black text-slate-500 tracking-wider mb-1.5">🎯 NEXT ACTIONS</div>
              <div className="space-y-1">
                {(brief.nextActions || []).slice(0, 5).map(a => (
                  <div key={a.id} className="flex items-start gap-1.5 text-[10px] leading-relaxed">
                    <span className={a.kind === 'warning' ? 'text-amber-400' : a.kind === 'signal' ? 'text-emerald-400' : a.kind === 'book' ? 'text-cyan-400' : 'text-slate-600'}>▸</span>
                    <span className="text-slate-300">{a.label}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </PanelShell>
  );
});

// ---------------- Swing Desk ----------------
export const SwingDeskPanel = memo(function SwingDeskPanel({ market }: { market: MarketKind }) {
  const [board, setBoard] = useState<SwingBoard | null>(null);
  const [loading, setLoading] = useState(false);
  // v20.7.8 [M-1]: stale-response guard — a slow OLD-market response used
  // to overwrite the NEW market's board (BTC slow → ETH fast → BTC lands
  // last and wins). Same seq discipline as useAITrading's posSeqRef.
  const seqRef = useRef(0);

  const load = useCallback(async () => {
    const seq = ++seqRef.current;
    setLoading(true);
    const v = await fetchSwingBoard(market);
    if (seq !== seqRef.current) return; // a newer market switch owns the panel
    setBoard(v);
    setLoading(false);
  }, [market]);

  useEffect(() => { load(); }, [load]);

  return (
    <PanelShell title={`🎣 Swing Desk — ${market === 'INDIA' ? '3–8 din ke setups (NSE)' : '2–6 din ke setups (crypto)'}`} tag="analysis only" onRefresh={load} loading={loading}>
      {!board?.ok && <EmptyNote>{loading ? 'Daily candles padh raha hai…' : 'No aligned swing setups right now — trend + momentum + structure sab align hona chahiye.'}</EmptyNote>}
      {board?.ok && (
        <>
          <div className="grid gap-2 lg:grid-cols-2">
            {board.ideas.map(i => (
              <div key={i.symbol} className={`bg-black/25 rounded-xl p-3 ${i.side === 'LONG' ? 'border-l-2 border-l-emerald-500/50' : 'border-l-2 border-l-red-500/50'}`}>
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-xs font-black text-white">{i.symbol}</span>
                  <span className={`px-1.5 py-0.5 rounded text-[9px] font-black ${i.side === 'LONG' ? 'bg-emerald-500/15 text-emerald-300' : 'bg-red-500/15 text-red-300'}`}>{i.side}</span>
                  <span className={`px-1.5 py-0.5 rounded text-[9px] font-black ${i.grade === 'A' ? 'bg-cyan-500/15 text-cyan-300' : 'bg-slate-600/20 text-slate-300'}`}>grade {i.grade} · {i.score}/100</span>
                  <span className="text-[11px] font-mono text-slate-400 ml-auto">{inr(i.ltp)}</span>
                </div>
                {i.plan && (
                  <div className="mt-2 grid grid-cols-4 gap-1 text-[10px] font-mono text-center">
                    <div className="bg-black/30 rounded px-1 py-1"><div className="text-slate-600 text-[8px]">ENTRY</div><div className="text-slate-200">{i.plan.entry}</div></div>
                    <div className="bg-red-500/5 rounded px-1 py-1"><div className="text-red-400/70 text-[8px]">STOP</div><div className="text-red-300">{i.plan.stopLoss}</div></div>
                    <div className="bg-emerald-500/5 rounded px-1 py-1"><div className="text-emerald-400/70 text-[8px]">T1</div><div className="text-emerald-300">{i.plan.target1}</div></div>
                    <div className="bg-emerald-500/5 rounded px-1 py-1"><div className="text-emerald-400/70 text-[8px]">T2 (3R)</div><div className="text-emerald-300">{i.plan.target2}</div></div>
                  </div>
                )}
                <ul className="mt-1.5 space-y-0.5">
                  {(i.reasons || []).slice(0, 3).map((r, k) => <li key={k} className="text-[9px] text-slate-500">• {r}</li>)}
                </ul>
                <div className="text-[9px] text-slate-600 mt-1 font-mono">hold: {i.holdDays} · RSI {i.rsi ?? '—'} · risk {i.plan?.riskPct ?? '—'}%</div>
              </div>
            ))}
          </div>
          <p className="text-[9px] text-slate-600 mt-2 italic">⚠️ {board.disclaimer}</p>
        </>
      )}
    </PanelShell>
  );
});

// ---------------- Whale Radar ----------------
export const WhaleRadarPanel = memo(function WhaleRadarPanel({ market }: { market: MarketKind }) {
  const [radar, setRadar] = useState<WhaleRadar | null>(null);
  const [loading, setLoading] = useState(false);
  const seqRef = useRef(0); // v20.7.8 [M-1]: stale-response guard (see SwingDeskPanel)

  const load = useCallback(async () => {
    const seq = ++seqRef.current;
    setLoading(true);
    const v = await fetchWhales(market);
    if (seq !== seqRef.current) return;
    setRadar(v);
    setLoading(false);
  }, [market]);

  useEffect(() => { load(); }, [load]);

  return (
    <PanelShell title={`🐋 Whale Radar — ${market === 'INDIA' ? 'NSE volumes' : 'crypto volumes'}`} tag="flow hints" onRefresh={load} loading={loading}>
      {(!radar || radar.whales.length === 0) && <EmptyNote>{loading ? 'Tape scan ho raha hai…' : (radar?.note || 'No volume anomalies right now — quiet tape.')}</EmptyNote>}
      {radar && radar.whales.length > 0 && (
        <div className="grid gap-1.5 sm:grid-cols-2">
          {radar.whales.map((w, i) => (
            <div key={i} className={`bg-black/25 rounded-xl px-3 py-2 ${w.direction === 'ACCUMULATION' ? 'border-l-2 border-l-emerald-500/50' : 'border-l-2 border-l-red-500/50'}`}>
              <div className="flex items-center gap-2 text-[11px] font-mono">
                <span className="font-black text-white">{w.symbol}</span>
                <span className="text-cyan-300 font-black">{w.spike}×</span>
                <span className="text-slate-500 text-[10px]">vol</span>
                <span className={`ml-auto font-bold ${(w.changePct ?? 0) >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>{(w.changePct ?? 0) >= 0 ? '+' : ''}{w.changePct?.toFixed(2) ?? '—'}%</span>
              </div>
              <div className="text-[9px] text-slate-500 mt-0.5">{w.note}</div>
            </div>
          ))}
        </div>
      )}
      {radar && radar.whales.length > 0 && <p className="text-[9px] text-slate-600 mt-2 italic">⚠️ {radar.note}</p>}
    </PanelShell>
  );
});

// ---------------- Signal Ledger (tamper-evident) ----------------
export const SignalLedgerPanel = memo(function SignalLedgerPanel() {
  const [ledger, setLedger] = useState<LedgerView | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setLedger(await fetchLedger(20));
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  return (
    <PanelShell title="🔒 Signal Ledger — tamper-evident track record (SHA-256 hash chain)" tag="v6.7" onRefresh={load} loading={loading}>
      {!ledger && <EmptyNote>{loading ? 'Chain verify ho raha hai…' : 'Ledger unavailable'}</EmptyNote>}
      {ledger && (
        <div className="space-y-2">
          <div className="flex flex-wrap gap-1.5 text-[10px] font-mono">
            <span className={`px-2 py-1 rounded-lg font-black ${ledger.verified ? 'bg-emerald-500/10 text-emerald-300 border border-emerald-500/25' : 'bg-red-500/10 text-red-300 border border-red-500/25'}`}>
              {ledger.verified ? `✅ CHAIN INTACT — ${ledger.entries} entries` : `⛔ BROKEN @ ${ledger.brokenAt}`}
            </span>
            <span className="px-2 py-1 rounded-lg bg-black/30 text-slate-400">head <span className="text-cyan-300">{ledger.headHash || '—'}</span></span>
            <span className="px-2 py-1 rounded-lg bg-black/30 text-slate-400">settled {ledger.settled} · open {ledger.open}</span>
            <span className={`px-2 py-1 rounded-lg bg-black/30 ${ledger.winRate != null && ledger.winRate >= 50 ? 'text-emerald-300' : 'text-amber-300'}`}>
              {ledger.wins}W / {ledger.losses}L{ledger.winRate != null ? ` · ${ledger.winRate}%` : ''}
            </span>
          </div>
          <div className="text-[9px] text-slate-600 leading-relaxed">
            Har executed signal hash-chain me stamped hai — history koi (admin bhi) edit nahi kar sakta. Outcome close hone par hash ke andar hi settle hota hai — jo signal us waqt aisa tha, wahi proof hai.
          </div>
          {(ledger.recent || []).length > 0 && (
            <div className="overflow-x-auto max-h-64 overflow-y-auto">
              <table className="w-full text-[10px] font-mono">
                <thead className="sticky top-0 bg-[#0d1424]">
                  <tr className="text-[8px] text-slate-500 font-black tracking-wider">
                    <th className="px-1.5 py-1.5 text-left">TIME</th>
                    <th className="px-1.5 py-1.5 text-left">SYM</th>
                    <th className="px-1.5 py-1.5 text-left">SIDE</th>
                    <th className="px-1.5 py-1.5 text-left">GRADE</th>
                    <th className="px-1.5 py-1.5 text-left">MODE</th>
                    <th className="px-1.5 py-1.5 text-right">R</th>
                    <th className="px-1.5 py-1.5 text-left">HASH</th>
                  </tr>
                </thead>
                <tbody>
                  {ledger.recent.map((e, i) => (
                    <tr key={e.id} className={`border-t border-white/[0.03] ${i === 0 ? 'bg-cyan-500/5' : ''}`}>
                      <td className="px-1.5 py-1 text-slate-500">{new Date(e.ts).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false })}</td>
                      <td className="px-1.5 py-1 text-slate-200 font-bold">{e.symbol}</td>
                      <td className={`px-1.5 py-1 font-black ${e.side === 'LONG' ? 'text-emerald-400' : 'text-red-400'}`}>{e.side}</td>
                      <td className="px-1.5 py-1 text-slate-500">{e.grade || '—'}</td>
                      <td className="px-1.5 py-1 text-slate-600">{e.mode}</td>
                      <td className={`px-1.5 py-1 text-right font-black ${e.outcome == null ? 'text-slate-600' : (e.outcome.r ?? 0) > 0 ? 'text-emerald-300' : 'text-red-300'}`}>
                        {e.outcome == null ? 'open' : `${(e.outcome.r ?? 0) > 0 ? '+' : ''}${e.outcome.r?.toFixed(2) ?? '—'}`}
                      </td>
                      <td className="px-1.5 py-1 text-cyan-500/70">{e.hash}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </PanelShell>
  );
});

// ---------------- Orderbook (crypto only) ----------------
const BOOK_SYMBOLS = ['BTC', 'ETH', 'BNB', 'SOL', 'XRP', 'DOGE'];
export const OrderbookPanel = memo(function OrderbookPanel() {
  const [symbol, setSymbol] = useState('BTC');
  const [view, setView] = useState<OrderbookView | null>(null);
  const [loading, setLoading] = useState(false);
  const seqRef = useRef(0); // v20.7.8 [M-1]: symbol-switch race — BTC (slow) then ETH (fast) used to leave BTC's late book rendered under the highlighted ETH chip

  const load = useCallback(async (sym: string) => {
    const seq = ++seqRef.current;
    setLoading(true);
    const v = await fetchOrderbook(sym);
    if (seq !== seqRef.current) return;
    setView(v);
    setLoading(false);
  }, []);

  useEffect(() => { load(symbol); }, [symbol, load]);

  const imb = view?.imbalancePct ?? 0;
  return (
    <PanelShell title="📖 Orderbook Depth — CoinDCX live book" tag="crypto" onRefresh={() => load(symbol)} loading={loading}>
      <div className="flex gap-1 flex-wrap mb-2.5">
        {BOOK_SYMBOLS.map(s => (
          <button key={s} onClick={() => setSymbol(s)} aria-pressed={symbol === s}
            className={`px-2.5 py-1 rounded-lg text-[10px] font-black transition-all ${symbol === s ? 'bg-cyan-500/20 text-cyan-300 border border-cyan-500/30' : 'text-slate-500 hover:text-slate-300 bg-black/20'}`}>
            {s}
          </button>
        ))}
      </div>
      {!view?.ok && <EmptyNote>{loading ? 'Book fetch ho raha hai…' : (view?.error || 'Orderbook unreachable from this host')}</EmptyNote>}
      {view?.ok && (
        <div className="space-y-2">
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-1.5 text-center">
            <div className="bg-emerald-500/5 rounded-xl px-2 py-1.5 border border-emerald-500/15">
              <div className="text-[8px] text-emerald-400/70 font-black tracking-wider">BEST BID</div>
              <div className="text-xs font-mono font-black text-emerald-300">{inr(view.bestBid)}</div>
            </div>
            <div className="bg-red-500/5 rounded-xl px-2 py-1.5 border border-red-500/15">
              <div className="text-[8px] text-red-400/70 font-black tracking-wider">BEST ASK</div>
              <div className="text-xs font-mono font-black text-red-300">{inr(view.bestAsk)}</div>
            </div>
            <div className="bg-black/30 rounded-xl px-2 py-1.5">
              <div className="text-[8px] text-slate-500 font-black tracking-wider">SPREAD</div>
              <div className="text-xs font-mono font-black text-slate-200">{view.spreadPct != null ? `${view.spreadPct}%` : '—'}</div>
            </div>
            <div className="bg-black/30 rounded-xl px-2 py-1.5">
              <div className="text-[8px] text-slate-500 font-black tracking-wider">IMBALANCE</div>
              <div className={`text-xs font-mono font-black ${imb > 15 ? 'text-emerald-300' : imb < -15 ? 'text-red-300' : 'text-slate-200'}`}>{imb > 0 ? '+' : ''}{imb}%</div>
            </div>
          </div>
          <div className="flex h-6 rounded-lg overflow-hidden border border-white/5">
            <div className="bg-emerald-500/25 flex items-center px-2 text-[9px] font-mono text-emerald-300" style={{ width: `${Math.max(4, 50 + Math.min(45, imb / 2))}%` }}>BID {view.bidVol?.toFixed(1)}</div>
            <div className="bg-red-500/25 flex items-center justify-end px-2 text-[9px] font-mono text-red-300 ml-auto" style={{ width: `${Math.max(4, 50 - Math.min(45, imb / 2))}%` }}>{view.askVol?.toFixed(1)} ASK</div>
          </div>
          <div className="grid grid-cols-2 gap-1.5 text-[10px] font-mono">
            <div className="bg-black/25 rounded-lg px-2 py-1.5 flex justify-between"><span className="text-slate-600">🧱 bid wall</span><span className="text-slate-300">{view.bidWall.price} ({view.bidWall.qty})</span></div>
            <div className="bg-black/25 rounded-lg px-2 py-1.5 flex justify-between"><span className="text-slate-600">🧱 ask wall</span><span className="text-slate-300">{view.askWall.price} ({view.askWall.qty})</span></div>
          </div>
          <div className="text-[10px] text-slate-400 bg-cyan-500/5 border border-cyan-500/15 rounded-lg px-2.5 py-1.5">{view.read}</div>
        </div>
      )}
    </PanelShell>
  );
});

// ---------------- Trust Layer (v6.11 — calibration + governance) ----------------
export const TrustLayerPanel = memo(function TrustLayerPanel() {
  const [view, setView] = useState<TrustView | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setView(await fetchTrust());
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  const cal = view?.calibration;
  const gov = view?.governance;
  return (
    <PanelShell title="🎯 Trust Layer — engine ki confidence kitni sahi hai?" tag="v6.11" onRefresh={load} loading={loading}>
      {!view && <EmptyNote>{loading ? 'Ledger outcomes padh raha hai…' : 'Trust report unavailable'}</EmptyNote>}
      {view && (!cal?.sufficient) && (
        <EmptyNote>{cal?.note || 'Insufficient settled outcomes — track record gather hone do, phir calibration yahan milegi.'}</EmptyNote>
      )}
      {view && cal?.sufficient && (
        <div className="space-y-3">
          {/* Brier + overall */}
          <div className="grid grid-cols-3 gap-1.5 text-center">
            <div className="bg-black/30 rounded-xl px-2 py-1.5">
              <div className="text-[8px] text-slate-500 font-black tracking-wider">BRIER ↓</div>
              <div className={`text-xs font-mono font-black ${(cal.brier ?? 1) <= 0.2 ? 'text-emerald-300' : (cal.brier ?? 1) <= 0.25 ? 'text-amber-300' : 'text-red-300'}`}>{cal.brier ?? '—'}</div>
            </div>
            <div className="bg-black/30 rounded-xl px-2 py-1.5">
              <div className="text-[8px] text-slate-500 font-black tracking-wider">REALIZED WR</div>
              <div className={`text-xs font-mono font-black ${cal.overall && cal.overall.winRate >= 50 ? 'text-emerald-300' : 'text-red-300'}`}>{cal.overall?.winRate ?? '—'}%</div>
            </div>
            <div className="bg-black/30 rounded-xl px-2 py-1.5">
              <div className="text-[8px] text-slate-500 font-black tracking-wider">AVG CLAIM</div>
              <div className="text-xs font-mono font-black text-slate-200">{cal.overall?.avgConfidence ?? '—'}%</div>
            </div>
          </div>
          <div className="text-[9px] text-slate-500 leading-relaxed">{cal.brierVerdict} · Brier: 0 = perfect, 0.25 = coin-flip.</div>

          {/* calibration buckets */}
          <div>
            <div className="text-[9px] font-black text-slate-500 tracking-wider mb-1">CALIBRATION — bola vs hua</div>
            <div className="grid gap-1">
              {(cal.calibration || []).map(b => (
                <div key={b.bucket} className="flex items-center gap-2 text-[10px] font-mono">
                  <span className="text-slate-500 w-14">{b.bucket}</span>
                  <span className="text-slate-400">n={b.n}</span>
                  <div className="flex-1 h-2 bg-black/40 rounded overflow-hidden relative">
                    <div className="absolute top-0 bottom-0 w-px bg-slate-500" style={{ left: `${Math.min(98, b.claimed)}%` }} title={`claimed ${b.claimed}%`} />
                    <div className={`h-full ${b.winRate != null && b.winRate >= b.claimed ? 'bg-emerald-500/50' : 'bg-amber-500/50'}`} style={{ width: `${Math.min(100, b.winRate ?? 0)}%` }} />
                  </div>
                  <span className={`w-16 text-right font-black ${b.gap == null ? 'text-slate-600' : b.gap >= 0 ? 'text-emerald-300' : 'text-amber-300'}`}>
                    {b.winRate ?? '—'}%{b.gap != null ? ` (${b.gap > 0 ? '+' : ''}${b.gap})` : ''}
                  </span>
                </div>
              ))}
            </div>
          </div>

          {/* monthly trend */}
          {(cal.monthly || []).length > 0 && (
            <div>
              <div className="text-[9px] font-black text-slate-500 tracking-wider mb-1">MONTHLY TREND</div>
              <div className="flex items-end gap-1 h-12">
                {(cal.monthly || []).map(m => (
                  <div key={m.month} className="flex-1 flex flex-col items-center justify-end h-full" title={`${m.month}: ${m.n} trades · ${m.winRate}% WR · avg ${m.avgR}R`}>
                    <div className={`w-full rounded-t ${m.winRate >= 50 ? 'bg-emerald-500/40' : 'bg-red-500/40'}`} style={{ height: `${Math.max(6, m.winRate)}%` }} />
                    <span className="text-[7px] text-slate-600 mt-0.5">{m.month.slice(2)}</span>
                  </div>
                ))}
              </div>
              {cal.drift != null && (
                <div className={`text-[9px] mt-0.5 ${cal.drift >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                  last month vs prior: {cal.drift > 0 ? '+' : ''}{cal.drift}pp {cal.drift <= -10 ? '⚠️ accuracy gir rahi hai — size kam karo' : ''}
                </div>
              )}
            </div>
          )}

          {/* governance */}
          {(gov?.models || []).length > 0 && (
            <div>
              <div className="text-[9px] font-black text-slate-500 tracking-wider mb-1">MODEL GOVERNANCE — p-values</div>
              <div className="overflow-x-auto max-h-40 overflow-y-auto">
                <table className="w-full text-[10px] font-mono">
                  <thead className="sticky top-0 bg-[#0d1424]">
                    <tr className="text-[8px] text-slate-500 font-black tracking-wider">
                      <th className="px-1.5 py-1 text-left">MODEL</th>
                      <th className="px-1.5 py-1 text-right">N</th>
                      <th className="px-1.5 py-1 text-right">HIT</th>
                      <th className="px-1.5 py-1 text-right">EDGE</th>
                      <th className="px-1.5 py-1 text-right">p</th>
                      <th className="px-1.5 py-1 text-left">VERDICT</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(gov?.models || []).map(m => (
                      <tr key={m.model} className="border-t border-white/[0.03]">
                        <td className="px-1.5 py-1 text-slate-300">{m.model}</td>
                        <td className="px-1.5 py-1 text-right text-slate-500">{m.n}</td>
                        <td className="px-1.5 py-1 text-right text-slate-200">{m.hitRate ?? '—'}%</td>
                        <td className={`px-1.5 py-1 text-right ${(m.edge ?? 0) > 0 ? 'text-emerald-300' : 'text-red-300'}`}>{m.edge != null ? `${m.edge > 0 ? '+' : ''}${m.edge}` : '—'}</td>
                        <td className="px-1.5 py-1 text-right text-slate-500">{m.pValue}</td>
                        <td className={`px-1.5 py-1 font-black ${m.verdict === 'SIGNIFICANT' ? 'text-emerald-300' : m.verdict === 'NEEDS DATA' ? 'text-slate-500' : m.verdict === 'BORDERLINE' ? 'text-amber-300' : 'text-slate-600'}`}>{m.verdict}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="text-[8px] text-slate-600 mt-1 leading-relaxed">{gov?.note}</div>
            </div>
          )}
        </div>
      )}
    </PanelShell>
  );
});

// ---------------- Perf Analytics (v6.11 — MDD/Sharpe/Sortino/Calmar) ----------------
export const PerfAnalyticsPanel = memo(function PerfAnalyticsPanel() {
  const [view, setView] = useState<PerfView | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setView(await fetchPerf());
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  // equity-curve sparkline (cumulative R)
  const curve = view?.equityCurveR || [];
  const max = curve.length ? Math.max(1, ...curve) : 1;
  const min = curve.length ? Math.min(0, ...curve) : 0;
  const span = Math.max(1e-9, max - min);
  return (
    <PanelShell title="📈 Performance Lab — R-multiple analytics" tag="v6.11" onRefresh={load} loading={loading}>
      {!view && <EmptyNote>{loading ? 'Settled outcomes aggregate ho rahe hain…' : 'Perf report unavailable'}</EmptyNote>}
      {view && !view.sufficient && <EmptyNote>{view.note}</EmptyNote>}
      {view && view.sufficient && (
        <div className="space-y-3">
          <div className="grid grid-cols-3 sm:grid-cols-4 gap-1.5 text-center">
            {[
              { l: 'EXPECTANCY', v: `${(view.expectancy ?? 0) > 0 ? '+' : ''}${view.expectancy ?? '—'}R`, c: (view.expectancy ?? 0) > 0 ? 'text-emerald-300' : 'text-red-300' },
              { l: 'TOTAL R', v: `${(view.totalR ?? 0) > 0 ? '+' : ''}${view.totalR ?? '—'}`, c: (view.totalR ?? 0) > 0 ? 'text-emerald-300' : 'text-red-300' },
              { l: 'MAX DD', v: `−${view.mdd?.r ?? 0}R`, c: 'text-red-300' },
              { l: 'PROFIT FACT', v: `${view.profitFactor ?? '—'}`, c: (view.profitFactor ?? 0) >= 1.5 ? 'text-emerald-300' : 'text-amber-300' },
              { l: 'SHARPE /trade', v: `${view.sharpe?.perTrade ?? '—'}`, c: 'text-slate-200' },
              { l: 'SORTINO /trade', v: `${view.sortino?.perTrade ?? '—'}`, c: 'text-slate-200' },
              { l: 'CALMAR', v: view.calmar?.expectancyOverMdd != null ? `${view.calmar.expectancyOverMdd}` : '—', c: 'text-slate-200' },
              { l: 'STREAK W/L', v: `${view.streaks?.win ?? 0}/${view.streaks?.loss ?? 0}`, c: 'text-slate-200' },
            ].map(x => (
              <div key={x.l} className="bg-black/30 rounded-xl px-2 py-1.5">
                <div className="text-[8px] text-slate-500 font-black tracking-wider">{x.l}</div>
                <div className={`text-xs font-mono font-black ${x.c}`}>{x.v}</div>
              </div>
            ))}
          </div>

          {/* equity curve */}
          {curve.length > 1 && (
            <div>
              <div className="text-[9px] font-black text-slate-500 tracking-wider mb-1">CUMULATIVE R EQUITY CURVE</div>
              <svg viewBox={`0 0 ${Math.max(60, curve.length)} 24`} className="w-full h-12" preserveAspectRatio="none" role="img" aria-label="cumulative R equity curve">
                {curve.map((r, i) => i === 0 ? null : (
                  <line key={i} x1={i - 1} x2={i}
                    y1={22 - ((curve[i - 1] - min) / span) * 20} y2={22 - ((r - min) / span) * 20}
                    stroke={(r ?? 0) >= 0 ? '#34d399' : '#f87171'} strokeWidth="0.6" />
                ))}
                <line x1="0" x2={Math.max(60, curve.length)} y1={22 - ((0 - min) / span) * 20} y2={22 - ((0 - min) / span) * 20} stroke="#475569" strokeWidth="0.25" strokeDasharray="1 1" />
              </svg>
            </div>
          )}

          {/* desk split */}
          <div className="grid sm:grid-cols-2 gap-2 text-[10px] font-mono">
            {(['india', 'crypto', 'futures'] as const).map(k => {
              const g = view.byMarket?.[k];
              return (
                <div key={k} className="bg-black/25 rounded-xl px-2.5 py-1.5 flex justify-between items-center">
                  <span className="text-slate-500">{k === 'india' ? '🇮🇳 INDIA' : k === 'crypto' ? '₿ CRYPTO' : '⚡ FUTURES'}</span>
                  {g ? <span className={((g.totalR ?? 0) > 0) ? 'text-emerald-300' : 'text-red-300'}>{g.n} trades · {g.winRate}% WR · {((g.totalR ?? 0) > 0 ? '+' : '')}${g.totalR}R</span>
                    : <span className="text-slate-600">no settled trades</span>}
                </div>
              );
            })}
          </div>
          <div className="text-[8px] text-slate-600 leading-relaxed">{view.note} · {view.sharpe?.note}</div>
        </div>
      )}
    </PanelShell>
  );
});

// ---------------- Correlation Matrix (v6.11) ----------------
const corrColor = (r: number | null) => {
  if (r == null) return 'bg-slate-800/40';
  const a = Math.min(0.85, Math.abs(r) * 0.85 + 0.08);
  return r >= 0 ? `rgba(16,185,129,${a})` : `rgba(248,113,113,${a})`;
};
export const CorrelationPanel = memo(function CorrelationPanel() {
  const [view, setView] = useState<CorrView | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setView(await fetchCorrelations());
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  return (
    <PanelShell title="🔗 Cross-Asset Correlations — 60d returns" tag="v6.11" onRefresh={load} loading={loading}>
      {!view?.ok && <EmptyNote>{loading ? 'Daily closes fetch ho rahe hain…' : 'Correlation data unavailable'}</EmptyNote>}
      {view?.ok && (
        <div className="space-y-2.5">
          {view.riskLink && (
            <div className="bg-cyan-500/[0.06] border border-cyan-500/15 rounded-xl px-2.5 py-1.5 text-[10px] leading-relaxed">
              <b className="text-cyan-300">{view.riskLink.pair}: {view.riskLink.r}</b> — {view.riskLink.read}
            </div>
          )}
          <div className="grid sm:grid-cols-2 gap-2">
            {(['mostPositive', 'mostNegative'] as const).map(k => (
              <div key={k} className="bg-black/25 rounded-xl p-2">
                <div className="text-[8px] font-black text-slate-500 tracking-wider mb-1">{k === 'mostPositive' ? '🤝 MOST POSITIVE' : '↔️ MOST NEGATIVE'}</div>
                {(view.top[k] || []).map((p, i) => (
                  <div key={i} className="flex items-center gap-1.5 text-[10px] font-mono py-0.5">
                    <span className="text-slate-300">{p.a}↔{p.b}</span>
                    <span className={`ml-auto font-black ${p.r >= 0 ? 'text-emerald-300' : 'text-red-300'}`}>{p.r}</span>
                  </div>
                ))}
              </div>
            ))}
          </div>
          {/* the matrix */}
          <div className="overflow-x-auto">
            <table className="text-[8px] font-mono border-separate" style={{ borderSpacing: '1px' }}>
              <thead>
                <tr>
                  <th className="px-1" />
                  {view.assets.map(a => <th key={a.key} className="px-1 text-slate-500 font-black" title={a.label}>{a.key.slice(0, 5)}</th>)}
                </tr>
              </thead>
              <tbody>
                {view.matrix.map((row, i) => (
                  <tr key={view.assets[i].key}>
                    <td className="px-1 text-slate-500 font-black whitespace-nowrap">{view.assets[i].key}</td>
                    {row.map((v, j) => (
                      <td key={j} className={`px-1 py-0.5 text-center font-bold ${j === i ? 'text-white' : v == null ? 'text-slate-700' : v >= 0.6 ? 'text-emerald-200' : v <= -0.4 ? 'text-red-200' : 'text-slate-300'}`}
                        style={{ background: j === i ? 'rgba(148,163,184,0.18)' : (corrColor(v) as string) }}
                        title={v == null ? 'insufficient overlap' : `${view.assets[i].key} ↔ ${view.assets[j].key}: ${v}`}>
                        {j === i ? '·' : v == null ? '—' : v.toFixed(1).replace('0.', '.').replace('-', '−')}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="text-[8px] text-slate-600 leading-relaxed">
            {view.note}{view.skipped?.length ? ` · skipped (host-block): ${view.skipped.join(', ')}` : ''}
          </div>
        </div>
      )}
    </PanelShell>
  );
});

// ---------------- Sector Map + Context Chain + F-Score (v6.11) ----------------
export const SectorMapPanel = memo(function SectorMapPanel() {
  const [view, setView] = useState<SectorView | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setView(await fetchSectors());
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  const moodColor = (m: string) => m === 'BULLISH' ? 'text-emerald-300 bg-emerald-500/10 border-emerald-500/25'
    : m === 'BEARISH' ? 'text-red-300 bg-red-500/10 border-red-500/25'
    : 'text-slate-400 bg-slate-500/10 border-slate-500/20';
  return (
    <PanelShell title="🗺️ Sector Map + Context Chain — macro→sector→symbol" tag="v6.11" onRefresh={load} loading={loading}>
      {!view?.ok && <EmptyNote>{loading ? '45-stock universe sector-wise padh raha hai…' : (view?.error || 'Sector map unavailable')}</EmptyNote>}
      {view?.ok && (
        <div className="space-y-3">
          {/* context chain */}
          {view.chain && (
            <div className="bg-black/25 rounded-xl p-2.5">
              <div className="flex items-center gap-1.5 flex-wrap text-[10px] font-mono mb-1">
                <span className="text-[8px] font-black text-slate-500 tracking-wider">MACRO</span>
                <span className={`px-1.5 py-0.5 rounded font-black ${view.chain.macro.bias === 'RISK-ON' ? 'bg-emerald-500/15 text-emerald-300' : view.chain.macro.bias === 'RISK-OFF' ? 'bg-red-500/15 text-red-300' : 'bg-slate-500/15 text-slate-300'}`}>
                  {view.chain.macro.bias}
                </span>
                {view.chain.macro.vixRegime && <span className="px-1.5 py-0.5 rounded bg-black/30 text-slate-400">VIX {view.chain.macro.vixRegime}</span>}
                {view.chain.macro.dollar != null && <span className={`px-1.5 py-0.5 rounded bg-black/30 ${view.chain.macro.dollar >= 0 ? 'text-red-300' : 'text-emerald-300'}`}>DXY {view.chain.macro.dollar > 0 ? '+' : ''}{view.chain.macro.dollar}%</span>}
                {view.chain.macro.crude != null && <span className={`px-1.5 py-0.5 rounded bg-black/30 ${view.chain.macro.crude >= 0 ? 'text-amber-300' : 'text-emerald-300'}`}>CRUDE {view.chain.macro.crude > 0 ? '+' : ''}{view.chain.macro.crude}%</span>}
                <span className="text-slate-600">→ SECTOR → SYMBOL</span>
              </div>
              <div className="text-[10px] text-slate-400 leading-relaxed">{view.chain.read}</div>
              <div className="grid sm:grid-cols-3 gap-1.5 mt-1.5">
                {(view.chain.strongest || []).slice(0, 3).map(s => (
                  <div key={s.sector} className="bg-black/30 rounded-lg px-2 py-1.5">
                    <div className="flex items-center gap-1 text-[9px] font-black">
                      <span className="text-slate-300">{s.sector}</span>
                      <span className={s.mood === 'BULLISH' ? 'text-emerald-400' : 'text-slate-500'}>{s.mood}</span>
                      <span className="text-slate-600 ml-auto">{s.breadth}% up</span>
                    </div>
                    {(s.top || []).map(t => (
                      <div key={t.symbol} className="text-[9px] font-mono text-slate-400 flex justify-between">
                        <span>{t.symbol} <span className="text-cyan-400/80">F{t.fscore}</span></span>
                        <span className={t.changePct >= 0 ? 'text-emerald-300' : 'text-red-300'}>{t.changePct > 0 ? '+' : ''}{t.changePct}%</span>
                      </div>
                    ))}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* sector rows */}
          <div className="grid sm:grid-cols-2 gap-1.5">
            {(view.sectors || []).map(s => (
              <div key={s.sector} className="bg-black/25 rounded-xl px-2.5 py-2">
                <div className="flex items-center gap-1.5 flex-wrap">
                  <span className="text-[10px] font-black text-white">{s.sector}</span>
                  <span className={`px-1.5 py-0.5 rounded text-[8px] font-black border ${moodColor(s.mood)}`}>{s.mood}</span>
                  <span className="text-[9px] font-mono text-slate-500 ml-auto">{s.symbols} stocks{' · '}<span className={s.indexChangePct == null ? 'text-slate-600' : s.indexChangePct >= 0 ? 'text-emerald-400' : 'text-red-400'}>{s.indexChangePct != null ? `${s.indexChangePct > 0 ? '+' : ''}${s.indexChangePct}% idx` : ''}</span></span>
                </div>
                <div className="mt-1.5 flex items-center gap-2 text-[10px] font-mono">
                  <div className="flex-1 h-1.5 bg-black/40 rounded overflow-hidden" title={`${s.breadth}% stocks above EMA20`}>
                    <div className={`h-full ${s.breadth >= 60 ? 'bg-emerald-500/60' : s.breadth <= 40 ? 'bg-red-500/60' : 'bg-amber-500/50'}`} style={{ width: `${s.breadth}%` }} />
                  </div>
                  <span className={`font-bold ${s.avgChangePct >= 0 ? 'text-emerald-300' : 'text-red-300'}`}>{s.avgChangePct > 0 ? '+' : ''}{s.avgChangePct}%</span>
                </div>
                <div className="mt-1 flex justify-between text-[8px] font-mono text-slate-600">
                  <span>⬆ {s.leader?.symbol ?? '—'} {s.leader ? `${s.leader.changePct > 0 ? '+' : ''}${s.leader.changePct}%` : ''}</span>
                  <span>⬇ {s.laggard?.symbol ?? '—'} {s.laggard ? `${s.laggard.changePct > 0 ? '+' : ''}${s.laggard.changePct}%` : ''}</span>
                </div>
              </div>
            ))}
          </div>

          {/* F-Score board */}
          {view.fscore && (
            <div>
              <div className="text-[9px] font-black text-slate-500 tracking-wider mb-1">F-SCORE BOARD — trend quality (0-9)</div>
              <div className="grid sm:grid-cols-2 gap-1.5">
                <div className="bg-black/25 rounded-xl p-2">
                  <div className="text-[8px] text-emerald-400/70 font-black tracking-wider mb-1">TOP QUALITY</div>
                  {(view.fscore.top || []).slice(0, 6).map(f => (
                    <div key={f.symbol} className="flex items-center gap-1.5 text-[10px] font-mono py-0.5">
                      <span className="text-slate-200 font-bold">{f.symbol}</span>
                      <span className={`px-1 rounded text-[8px] font-black ${f.grade === 'A' ? 'bg-cyan-500/15 text-cyan-300' : 'bg-slate-600/20 text-slate-300'}`}>{f.score}/9</span>
                      {f.rsi != null && <span className="text-slate-600 text-[8px]">RSI {f.rsi}</span>}
                      {f.pos52 != null && <span className="text-slate-600 text-[8px] ml-auto">52w {f.pos52}%</span>}
                    </div>
                  ))}
                </div>
                <div className="bg-black/25 rounded-xl p-2">
                  <div className="text-[8px] text-red-400/70 font-black tracking-wider mb-1">DISTRIBUTION + BOTTOM</div>
                  <div className="flex gap-1.5 text-[9px] font-mono mb-1.5">
                    <span className="px-1.5 py-0.5 rounded bg-cyan-500/10 text-cyan-300 font-black">A: {view.fscore.distribution.A}</span>
                    <span className="px-1.5 py-0.5 rounded bg-slate-500/10 text-slate-300 font-black">B: {view.fscore.distribution.B}</span>
                    <span className="px-1.5 py-0.5 rounded bg-red-500/10 text-red-300 font-black">C: {view.fscore.distribution.C}</span>
                  </div>
                  {(view.fscore.bottom || []).map(f => (
                    <div key={f.symbol} className="flex items-center gap-1.5 text-[10px] font-mono py-0.5">
                      <span className="text-slate-400">{f.symbol}</span>
                      <span className="px-1 rounded text-[8px] font-black bg-red-500/10 text-red-300">{f.score}/9</span>
                    </div>
                  ))}
                </div>
              </div>
              <div className="text-[8px] text-slate-600 mt-1 leading-relaxed">⚠️ {view.fscore.disclaimer}</div>
            </div>
          )}
          <div className="text-[8px] text-slate-600 leading-relaxed">{view.note}</div>
        </div>
      )}
    </PanelShell>
  );
});
