// ============================================================
// intraday/MTFConfluenceBadge — v10.5 (Upgrade 1) → v18.5 (MTF-6)
// ------------------------------------------------------------
// v18.5 SUPER INTELLIGENCE view: when the payload carries the
// mtf6 engine marker, this badge renders the FULL six-timeframe
// read — 1m / 5m / 15m / 1h / 4h / 1d chips, the weighted
// consensus (BULLISH/BEARISH/NEUTRAL), the agreement %, the phase
// (TREND-ALIGNED / MIXED / RANGE), HTF bias (1d+4h), LTF trigger
// (1m+5m) and the entry-timing quality. The 6-TF engine (server/
// ai/mtf.js) also gates the final signal: counter-consensus sides
// lose conf and STRONG; aligned sides gain it.
//
// Legacy fallback: payloads without the mtf6 marker render the
// v10.5 three-chip 5m/15m/1h view unchanged (flag-gated India wire).
// Renders NOTHING when no payload is present (honest degrade).
// ============================================================
import { memo } from 'react';
import type { MTFConfluence, MTFTapeRead } from '../aitrading/types';

const TF_META: Array<{ key: 'm5' | 'm15' | 'h1'; label: string; title: string }> = [
  { key: 'm5', label: '5m', title: '5-minute tape — entry timing' },
  { key: 'm15', label: '15m', title: '15-minute tape — THE trading timeframe (the vote anchor)' },
  { key: 'h1', label: '1h', title: '1-hour tape — the intraday trend' },
];

const TF6_ORDER = ['1m', '5m', '15m', '1h', '4h', '1d'];
const TF6_TITLE: Record<string, string> = {
  '1m': '1-minute — micro trigger / scalp timing leg',
  '5m': '5-minute — entry trigger leg',
  '15m': '15-minute — THE trading timeframe',
  '1h': '1-hour — intraday trend leg',
  '4h': '4-hour — swing bias leg (HTF)',
  '1d': 'daily — the big trend (heaviest vote ×3.0)',
};

function chipCls(dir: number | null | undefined): string {
  if (dir == null) return 'bg-slate-600/20 text-slate-500 border-slate-600/30';
  if (dir > 0) return 'bg-emerald-500/15 text-emerald-300 border-emerald-500/40';
  if (dir < 0) return 'bg-red-500/15 text-red-300 border-red-500/40';
  return 'bg-slate-600/20 text-slate-400 border-slate-600/30';
}

function TfChip({ label, read, title }: { label: string; read: MTFTapeRead | null; title: string }) {
  const dir: number | null = read?.dir ?? null;
  const arrow = dir == null ? '·' : dir > 0 ? '▲' : dir < 0 ? '▼' : '·';
  return (
    <span
      className={`px-1.5 py-0.5 rounded text-[9px] font-black font-mono border tracking-wide ${chipCls(dir)}`}
      title={read ? `${title} — ${dir != null && dir > 0 ? 'bull' : dir != null && dir < 0 ? 'bear' : 'neutral'} read, ${read.conf}% conf` : `${title} — no data`}
    >
      {label} {arrow}
    </span>
  );
}

function Tf6Chip({ tf, dir, conf }: { tf: string; dir: number | null; conf: number }) {
  const arrow = dir == null ? '·' : dir > 0 ? '▲' : dir < 0 ? '▼' : '·';
  const title = `${TF6_TITLE[tf] || tf} — ${dir != null && dir > 0 ? 'bull' : dir != null && dir < 0 ? 'bear' : 'neutral'}${conf ? `, ${Math.round(conf)}% strength` : ''}`;
  return (
    <span
      className={`px-1.5 py-0.5 rounded text-[9px] font-black font-mono border tracking-wide ${chipCls(dir)}`}
      title={title}
    >
      {tf} {arrow}
    </span>
  );
}

function agreementBadgeCls(agreement: number): string {
  if (agreement >= 1) return 'bg-emerald-500/15 text-emerald-300 border-emerald-500/40';
  if (agreement >= 0.67) return 'bg-cyan-500/10 text-cyan-300 border-cyan-500/30';
  return 'bg-amber-500/15 text-amber-300 border-amber-500/40';
}

function consensusCls(c?: string): string {
  if (c === 'BULLISH') return 'bg-emerald-500/15 text-emerald-300 border-emerald-500/40';
  if (c === 'BEARISH') return 'bg-red-500/15 text-red-300 border-red-500/40';
  return 'bg-slate-600/20 text-slate-400 border-slate-600/30';
}

function timingCls(q?: string): string {
  if (q === 'GOOD') return 'text-emerald-300';
  if (q === 'CAUTION') return 'text-amber-300';
  if (q === 'POOR') return 'text-red-300';
  return 'text-slate-500';
}

export const MTFConfluenceBadge = memo(function MTFConfluenceBadge({ mtf }: { mtf?: MTFConfluence | null }) {
  // ---------------- v18.5 MTF-6 SUPER INTELLIGENCE view ----------------
  if (mtf?.engine === 'mtf6') {
    const tfs = Array.isArray(mtf.tfs) ? mtf.tfs : [];
    if (!tfs.length && !mtf.m5 && !mtf.m15 && !mtf.h1) return null;
    const agreement = mtf.agreementPct != null ? mtf.agreementPct
      : (mtf.agreement != null ? Math.round(mtf.agreement * 100) : null);
    const hasAny = tfs.length > 0;
    const title = [
      'MTF-6 SUPER INTELLIGENCE — 1m/5m/15m/1h/4h/1d full confluence',
      `consensus: ${mtf.consensus ?? '—'} · alignment ${mtf.alignment ?? 0} · phase ${mtf.phase ?? '—'}`,
      `HTF bias (1d+4h): ${mtf.htfBias ?? '—'} · LTF trigger (1m+5m): ${mtf.ltfTrigger ?? '—'}`,
      mtf.timing ? `timing: ${mtf.timing.quality} — ${mtf.timing.note}` : '',
      'weights: 1d ×3.0 · 4h ×2.4 · 1h ×1.8 · 15m ×1.3 · 5m ×1.0 · 1m ×0.6',
      'counter-consensus trade → server −7/−10 conf + STRONG banned; aligned → +3/+5',
    ].filter(Boolean).join('\n');
    return (
      <div className="flex items-center gap-1 flex-wrap" title={title}>
        {hasAny
          ? TF6_ORDER
            .filter(tf => tfs.some(x => x.tf === tf))
            .map(tf => {
              const v = tfs.find(x => x.tf === tf);
              return <Tf6Chip key={tf} tf={tf} dir={v?.dir ?? null} conf={v?.conf ?? 0} />;
            })
          : TF_META.map(({ key, label, title: t }) => (
            <TfChip key={key} label={label} read={mtf[key]} title={t} />
          ))}
        {mtf.consensus && (
          <span className={`px-1.5 py-0.5 rounded text-[9px] font-black font-mono border tracking-wide ${consensusCls(mtf.consensus)}`} title={`6-TF weighted consensus — ${mtf.consensus}`}>
            {mtf.consensus === 'BULLISH' ? '6TF▲' : mtf.consensus === 'BEARISH' ? '6TF▼' : '6TF·'}
          </span>
        )}
        {agreement != null && (
          <span
            className={`px-1.5 py-0.5 rounded text-[9px] font-black font-mono border tracking-wide ${agreementBadgeCls(agreement / 100)}`}
            title={`${agreement}% of TF weight agrees with the consensus${agreement < 67 ? ' — DISAGREEING timeframes (server: conf penalty + STRONG banned)' : agreement >= 72 ? ' — TREND-ALIGNED (server: conviction boost)' : ' — partial confluence'}`}
          >
            MTF {agreement}%
          </span>
        )}
        {mtf.timing && mtf.timing.quality !== 'N/A' && (
          <span
            className={`px-1.5 py-0.5 rounded text-[9px] font-black font-mono border tracking-wide bg-black/30 border-slate-600/40 ${timingCls(mtf.timing.quality)}`}
            title={`Entry timing (1m/5m RSI gate): ${mtf.timing.quality} — ${mtf.timing.note}`}
          >
            ⏱ {mtf.timing.quality}
          </span>
        )}
      </div>
    );
  }

  // ---------------- legacy v10.5 5m/15m/1h view ----------------
  if (!mtf || (!mtf.m5 && !mtf.m15 && !mtf.h1)) return null;
  const agreement = mtf.agreement;
  const pct = agreement != null ? Math.round(agreement * 100) : null;
  return (
    <div className="flex items-center gap-1 flex-wrap" title="MTF confluence — 5m / 15m / 1h tape reads; agreement is measured against the 15m trading timeframe">
      {TF_META.map(({ key, label, title }) => (
        <TfChip key={key} label={label} read={mtf[key]} title={title} />
      ))}
      {pct != null && (
        <span
          className={`px-1.5 py-0.5 rounded text-[9px] font-black font-mono border tracking-wide ${agreementBadgeCls(agreement!)}`}
          title={
            agreement! >= 1
              ? 'ALL 3 timeframes aligned — full confluence (server: +15 conviction boost)'
              : agreement! < 0.67
                ? 'Timeframes DISAGREE (< 67%) — server: -20 conviction penalty + STRONG banned'
                : '2 of 3 timeframes aligned — partial confluence'
          }
        >
          MTF {pct}%
        </span>
      )}
    </div>
  );
});
