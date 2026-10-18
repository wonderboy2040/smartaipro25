// ============================================================
// src/components/aitrading/CandleChart.tsx — v20.2
// ------------------------------------------------------------
// THE PRICE CHART the desk never had: lightweight SVG candlesticks
// from /api/ai/candles (the SAME fetch chain MTF-6 uses — CoinDCX →
// Binance/Bybit → Yahoo, LTP-scale converted). Entry/SL/T1/T2 from
// the signal's plan draw as dashed overlay lines so the setup is
// VISUAL, not just numbers.
//
// Honest degrade: source down / thin symbol → a text note, never a
// fake chart. 60s auto-refresh while mounted and the tab is visible.
// Fully self-contained (own fetch + state) — SignalCard embeds it
// lazily behind an "open chart" toggle; the deep modal renders it
// directly.
// ============================================================
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { apiFetch } from '../../utils/api';

export interface ChartPlan {
  entry?: number | null;
  stopLoss?: number | null;
  target1?: number | null;
  target2?: number | null;
}

interface Candle { time: number; open: number; high: number; low: number; close: number; volume: number }
interface CandlesResp { ok: boolean; candles?: Candle[]; error?: string; bars?: number; scaled?: { note?: string } | null }

// v21.0 VISION SEAT verdict shape (/api/ai/vision-check)
interface VisionVerdict {
  ok: boolean; cached?: boolean; model?: string;
  visualTrend?: 'UP' | 'DOWN' | 'SIDEWAYS';
  agreesWithSignal?: boolean;
  confidence?: number;
  patterns?: string[];
  risk?: string | null;
  notes?: string | null;
  error?: string;
}

const TFS = ['5m', '15m', '1h', '1d'] as const;
type Tf = typeof TFS[number];
const REFRESH_MS = 60_000;

const px = (v: number) => {
  if (!Number.isFinite(v)) return '—';
  const a = Math.abs(v);
  if (a >= 10000) return v.toLocaleString('en-IN', { maximumFractionDigits: 0 });
  if (a >= 100) return v.toFixed(1);
  if (a >= 1) return v.toFixed(2);
  return v.toFixed(4);
};

export const CandleChart = memo(function CandleChart({
  symbol, market, ltp, plan, compact = false, defaultTf = '15m', side = null,
}: {
  symbol: string; market: string; ltp?: number | null; plan?: ChartPlan | null;
  compact?: boolean; defaultTf?: Tf; side?: string | null;
}) {
  // v21.0: normalize side — deep-signal types me side: string hai; vision
  // check ko sirf LONG/SHORT chahiye (warna undefined pass hota).
  const sideNorm = side === 'LONG' || side === 'SHORT' ? side : null;
  const [tf, setTf] = useState<Tf>((TFS as readonly string[]).includes(defaultTf) ? defaultTf : '15m');
  const [candles, setCandles] = useState<Candle[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  // v21.0 VISION SEAT — local Ollama vision model (qwen2.5vl) chart
  // screenshot analysis state. svgWrapRef se SVG ko PNG me render karke
  // /api/ai/vision-check ko bhejte hain, verdict yahin dikhta hai.
  const svgWrapRef = useRef<SVGSVGElement | null>(null);
  const [vision, setVision] = useState<VisionVerdict | null>(null);
  const [visionBusy, setVisionBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const aliveRef = useRef(true);
  // v20.3 RACE + TICK-LOOP FIX:
  // (1) `ltp` LEFT the load deps — it fed from the live SSE tick (800ms
  //     batches on the crypto desk, ~5s on India), so every price change
  //     rebuilt `load`, tore down the 60s interval and refetched the
  //     candles IMMEDIATELY (a 96-bar request per ~1-2s on liquid names,
  //     loading flicker, interval that never survived 60s). It is only a
  //     scale-conversion anchor — read through a ref at call time.
  // (2) `reqSeq` — a per-request token: a slow 5m response can no longer
  //     land AFTER a 15m switch and paint the wrong chart under the 15m
  //     label (aliveRef alone re-arms on every effect re-run, so it only
  //     ever guarded unmount).
  const ltpRef = useRef<number | null | undefined>(ltp);
  useEffect(() => { ltpRef.current = ltp; }, [ltp]);
  const reqSeq = useRef(0);

  const load = useCallback(async (tfArg: Tf) => {
    const seq = ++reqSeq.current;
    try {
      const q = new URLSearchParams({ symbol, market, tf: tfArg, bars: compact ? '72' : '96' });
      const lp = ltpRef.current;
      if (lp != null && Number.isFinite(lp) && lp > 0) q.set('ltp', String(lp));
      const r = await apiFetch(`/api/ai/candles?${q.toString()}`, { signal: AbortSignal.timeout(15000) });
      const j: CandlesResp = await r.json().catch(() => ({ ok: false, error: 'bad response' }));
      if (!aliveRef.current || seq !== reqSeq.current) return;
      if (j?.ok && Array.isArray(j.candles)) {
        // v20.3: validate every OHLC field — the endpoint has a 3-source
        // fallback chain and one malformed row (null high) used to poison
        // min/max → NaN → every SVG coordinate (whole chart blank).
        const clean = j.candles.filter((c) => c && [c.open, c.high, c.low, c.close].every((v) => Number.isFinite(v)));
        if (clean.length >= 20) { setCandles(clean); setErr(null); }
        else { setCandles(null); setErr(j?.error || 'candles unavailable'); }
      } else {
        setCandles(null); setErr(j?.error || 'candles unavailable');
      }
    } catch {
      if (aliveRef.current && seq === reqSeq.current) { setCandles(null); setErr('chart feed unreachable'); }
    } finally {
      if (aliveRef.current && seq === reqSeq.current) setLoading(false);
    }
  }, [symbol, market, compact]);

  useEffect(() => {
    aliveRef.current = true;
    setLoading(true);
    void load(tf);
    const t = setInterval(() => {
      if (document.hidden) return; // D16: hidden tab → skip (battery/API budget)
      void load(tf);
    }, REFRESH_MS);
    // v21.1.0: ref OBJECT ko local const me capture karke cleanup me use
    // karte hain — cleanup-time .current read pe exhaustive-deps warning
    // aati thi (ref identity stable hai, semantics same).
    const seqRef = reqSeq;
    return () => { aliveRef.current = false; seqRef.current++; clearInterval(t); };
  }, [tf, load]);

  const H = compact ? 150 : 210;
  const W = 100; // viewBox width % — scales with container

  const view = useMemo(() => {
    if (!candles || candles.length < 2) return null;
    const levels: Array<[string, number]> = [];
    if (plan?.entry != null && Number.isFinite(plan.entry)) levels.push(['ENTRY', plan.entry]);
    if (plan?.stopLoss != null && Number.isFinite(plan.stopLoss)) levels.push(['SL', plan.stopLoss]);
    if (plan?.target1 != null && Number.isFinite(plan.target1)) levels.push(['T1', plan.target1]);
    if (plan?.target2 != null && Number.isFinite(plan.target2)) levels.push(['T2', plan.target2]);
    if (ltp != null && Number.isFinite(ltp)) levels.push(['LTP', ltp]);
    let min = Infinity, max = -Infinity;
    for (const c of candles) { min = Math.min(min, c.low); max = Math.max(max, c.high); }
    for (const [, v] of levels) { min = Math.min(min, v); max = Math.max(max, v); }
    if (!(max > min)) { max = min + Math.max(Math.abs(min) * 0.001, 0.0001); } // v20.3: negative-safe flat guard
    const pad = (max - min) * 0.06;
    min -= pad; max += pad;
    return { candles, levels, min, max };
  }, [candles, plan, ltp]);

  const lvlColor = (name: string) => name === 'SL' ? '#f87171' : name === 'ENTRY' ? '#e2e8f0'
    : name === 'LTP' ? '#fbbf24' : '#34d399';

  // v21.0 VISION AI — SVG ko PNG me raster karke local Ollama vision
  // model (qwen2.5vl:7b) ko bhejo. serializeSvg → blob URL → canvas →
  // toDataURL('image/png') → POST /api/ai/vision-check. 120s timeout —
  // 16GB CPU pe vision call 20-40s lagta hai.
  const runVisionCheck = useCallback(async () => {
    const svgEl = svgWrapRef.current;
    if (!svgEl || visionBusy) return;
    setVisionBusy(true);
    setVision(null);
    try {
      const clone = svgEl.cloneNode(true) as SVGSVGElement;
      clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
      // dark background warna transparent PNG vision model confuse karti
      const bg = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
      bg.setAttribute('x', '0'); bg.setAttribute('y', '0');
      bg.setAttribute('width', '100%'); bg.setAttribute('height', '100%');
      bg.setAttribute('fill', '#0f172a');
      clone.insertBefore(bg, clone.firstChild);
      const xml = new XMLSerializer().serializeToString(clone);
      const svgUrl = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(xml);
      const img = new Image();
      await new Promise<void>((res, rej) => {
        img.onload = () => res();
        img.onerror = () => rej(new Error('svg raster fail'));
        img.src = svgUrl;
      });
      const scale = 4; // viewBox chhota hai (100×~210) — canvas 8x effective (scale × min-floor ×2)
      const cv = document.createElement('canvas');
      cv.width = Math.max(600, Math.round((svgEl.viewBox.baseVal.width || 100) * scale * 2));
      cv.height = Math.max(400, Math.round((svgEl.viewBox.baseVal.height || 210) * scale * 2));
      const ctx = cv.getContext('2d');
      if (!ctx) throw new Error('canvas unavailable');
      ctx.fillStyle = '#0f172a';
      ctx.fillRect(0, 0, cv.width, cv.height);
      ctx.drawImage(img, 0, 0, cv.width, cv.height);
      const dataUrl = cv.toDataURL('image/png');
      // v21.0.6 [audit E1]: active tf POST body me — server cache key
      // tf-aware hai, warna 15m verdict 1d chart pe serve ho sakta tha.
      const r = await apiFetch('/api/ai/vision-check', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ symbol, market, side: sideNorm || undefined, tf, image: dataUrl }),
        signal: AbortSignal.timeout(120_000),
      });
      const j: VisionVerdict = await r.json().catch(() => ({ ok: false, error: 'bad response' }));
      setVision(j?.ok ? j : { ok: false, error: j?.error || `vision check failed (HTTP ${r.status})` });
    } catch (e) {
      setVision({ ok: false, error: String((e as Error)?.message || e).slice(0, 160) });
    } finally {
      setVisionBusy(false);
    }
  }, [symbol, market, sideNorm, tf, visionBusy]);

  // X labels: 4 sparse time marks along the series.
  // v20.7.3 FIX: pin the label timezone to IST — 'en-IN' only sets the
  // FORMAT locale, so non-IST users saw candle stamps in their local tz
  // next to the IST-canonical session clock (09:15 open showed as 04:45).
  const timeLabel = (t: number) => {
    const d = new Date(t);
    return tf === '1d' ? d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', timeZone: 'Asia/Kolkata' })
      : d.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Kolkata' });
  };

  return (
    <div className="bg-slate-950/40 border border-slate-700/40 rounded-xl p-2" aria-label={`price chart ${symbol}`}>
      <div className="flex items-center gap-1.5 flex-wrap mb-1.5">
        <span className="text-[10px] font-black text-cyan-300 tracking-wider">📈 {symbol} · CANDLES</span>
        {TFS.map(f => (
          <button key={f} onClick={() => setTf(f)}
            className={`px-1.5 py-0.5 rounded text-[9px] font-black border ${tf === f ? 'bg-cyan-500/20 text-cyan-200 border-cyan-400/40' : 'bg-slate-800/40 text-slate-400 border-slate-700/40 hover:text-slate-200'}`}>
            {f}
          </button>
        ))}
        {loading && <span className="text-[9px] text-slate-500">loading…</span>}
        {!loading && err && <span className="text-[9px] text-amber-500/80" title={err}>⚠ {err}</span>}
        {candles && <span className="ml-auto text-[9px] text-slate-600 font-mono">{candles.length} bars · {tf} · refresh 60s</span>}
        <button onClick={runVisionCheck} disabled={visionBusy || !view}
          title="👁 Vision AI — chart screenshot ko local Ollama vision model (qwen2.5vl) se analyze karo"
          className={`px-1.5 py-0.5 rounded text-[9px] font-black border ${visionBusy ? 'bg-slate-800/40 text-slate-500 border-slate-700/40' : 'bg-fuchsia-500/15 text-fuchsia-300 border-fuchsia-400/40 hover:bg-fuchsia-500/25'}`}>
          {visionBusy ? '👁 analyzing…' : '👁 Vision AI'}
        </button>
      </div>
      {view ? (
        <svg ref={svgWrapRef} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="w-full block" style={{ height: H }} role="img" aria-label={`${symbol} ${tf} candlestick chart`}>
          {(() => {
            const { candles: cs, min, max, levels } = view;
            const n = cs.length;
            const y = (v: number) => H - 8 - ((v - min) / (max - min)) * (H - 22);
            const cw = (W - 2) / n;
            const bodyW = Math.max(cw * 0.6, 0.45);
            const out = [];
            for (let i = 0; i < n; i++) {
              const c = cs[i];
              const x = 1 + i * cw + cw / 2;
              const up = c.close >= c.open;
              const col = up ? '#34d399' : '#f87171';
              const yO = y(c.open), yC = y(c.close), yH = y(c.high), yL = y(c.low);
              out.push(<line key={`w${i}`} x1={x} y1={yH} x2={x} y2={yL} stroke={col} strokeWidth={0.28} opacity={0.85} />);
              const top = Math.min(yO, yC);
              const hgt = Math.max(Math.abs(yC - yO), 0.5);
              out.push(<rect key={`b${i}`} x={x - bodyW / 2} y={top} width={bodyW} height={hgt} fill={col} opacity={up ? 0.9 : 0.85} stroke={col} strokeWidth={0.15} />);
            }
            // plan overlays — dashed horizontal lines + right-edge labels
            for (const [name, v] of levels) {
              const yy = y(v);
              if (yy < 0 || yy > H) continue;
              out.push(<line key={`l${name}`} x1={1} y1={yy} x2={W - 1} y2={yy} stroke={lvlColor(name)} strokeWidth={0.3} strokeDasharray={name === 'LTP' ? '1.4 1' : '2 1.2'} opacity={0.9} />);
              out.push(<text key={`t${name}`} x={W - 1} y={Math.max(yy - 1.2, 5)} textAnchor="end" fontSize={3.4} fill={lvlColor(name)} fontFamily="monospace" fontWeight="bold">
                {`${name} ${px(v)}`}
              </text>);
            }
            // sparse time marks
            for (let k = 1; k <= 3; k++) {
              const idx = Math.floor((n * k) / 4);
              const c = cs[Math.min(idx, n - 1)];
              if (!c) continue;
              out.push(<text key={`x${k}`} x={1 + idx * cw} y={H - 1} textAnchor="middle" fontSize={3.2} fill="#64748b" fontFamily="monospace">
                {timeLabel(c.time)}
              </text>);
            }
            return out;
          })()}
        </svg>
      ) : !loading ? (
        <div className="text-[10px] text-slate-500 py-3 text-center">candles unavailable — koi fake chart nahi dikhta (source down ya thin symbol)</div>
      ) : (
        <div className="text-[10px] text-slate-500 py-3 text-center">loading candles…</div>
      )}
      {vision && (
        <div className={`mt-1.5 rounded-lg border p-2 text-[10px] ${vision.ok
          ? (vision.agreesWithSignal === false ? 'bg-amber-500/10 border-amber-500/30' : 'bg-emerald-500/10 border-emerald-500/30')
          : 'bg-rose-500/10 border-rose-500/30'}`}>
          {vision.ok ? (
            <div className="space-y-1">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="font-black text-fuchsia-300">👁 VISION VERDICT</span>
                <span className="text-slate-300 font-mono">{vision.visualTrend}</span>
                {vision.confidence != null && <span className="text-slate-400">conf {vision.confidence}%</span>}
                {sideNorm && (
                  <span className={`font-black ${vision.agreesWithSignal ? 'text-emerald-400' : 'text-amber-400'}`}>
                    {vision.agreesWithSignal ? `✓ agrees with ${sideNorm}` : `✗ disagrees with ${sideNorm}`}
                  </span>
                )}
                <span className="ml-auto text-slate-600 font-mono">{vision.model}{vision.cached ? ' · cached' : ''}</span>
              </div>
              {vision.patterns && vision.patterns.length > 0 && (
                <div className="text-slate-400">patterns: {vision.patterns.join(' · ')}</div>
              )}
              {vision.risk && <div className="text-amber-400/80">risk: {vision.risk}</div>}
              {vision.notes && <div className="text-slate-400 italic">{vision.notes}</div>}
            </div>
          ) : (
            <span className="text-rose-300">👁 {vision.error || 'vision check failed'}</span>
          )}
        </div>
      )}
    </div>
  );
});
