// ============================================================
// src/components/aitrading/LiveSourceBadge.tsx — v10.11 (#1)
// ------------------------------------------------------------
// THE ASK (user plan #1): "source-transparency badge" — the live
// price pill next to every LTP should say WHICH upstream actually
// served that tick, not just "⚡ LIVE".
// The server labels every liveFeed write (SSE wire field `source`);
// this badge maps those labels to an honest 8px pill.
//
// v10.12 (India plan #1): the same pill now covers the INDIA desk —
// Groww·live (server SSE Groww feed) / TV·WS (browser TradingView
// socket) / Yahoo·delayed (index fallback) — reused verbatim by the
// intraday SignalCard so the look is consistent across desks.
//
// Never guesses: an unknown/missing source renders a neutral LIVE
// pill (the price IS live — the provenance just wasn't labeled).
// ============================================================

/** Map a liveFeed source label → badge presentation. Pure + exported
 *  for unit tests.
 *
 *  v10.12: the INDIA desk's three live paths map here too —
 *    'groww-live'    → Groww·live   (emerald — the app-parity NSE LTP)
 *    'tv-ws'         → TV·WS       (sky — browser TradingView socket)
 *    'yahoo-delayed' → Yahoo·delayed (amber — index fallback / Groww miss)
 *  'coindcx-inr' rides the existing coindcx* → CoinDCX·RT rule (the
 *  intraday stream's crypto watch symbols). */
export function liveSourceBadge(src?: string | null): { label: string; cls: string; title: string } {
  const s = String(src || '');
  // v20.7.8 [M2]: DEGRADED CoinDCX legs FIRST — these start with 'coindcx'
  // and must never ride the green venue-live pill. A stale REST cache row
  // is still venue data, but NOT realtime; the 3-min deep-stale leg and
  // the Binance×fx synthetic rows are approximations.
  if (s === 'coindcx-rest-stale') {
    return {
      label: 'CoinDCX·stale',
      cls: 'bg-amber-500/15 text-amber-300 border-amber-500/40',
      title: 'CoinDCX REST cache serving stale rows (upstream outage) — venue data, but not realtime; levels par dhyan rakho',
    };
  }
  if (s === 'coindcx-rest-deep-stale') {
    return {
      label: 'CoinDCX·3m-old',
      cls: 'bg-amber-500/15 text-amber-300 border-amber-500/40',
      title: 'CoinDCX deep-stale fallback — up to 3 minutes old official data served to keep the board alive (not realtime)',
    };
  }
  if (s === 'binance-fx-synth') {
    return {
      label: 'Binance·fx-synth',
      cls: 'bg-amber-500/15 text-amber-300 border-amber-500/40',
      title: 'Binance/Bybit USDT price projected to INR at the live fx rate — synthetic approximation, no India premium, venue-confirm nahi hua',
    };
  }
  if (s.startsWith('coindcx')) {
    return {
      label: 'CoinDCX·RT',
      cls: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30',
      title: 'DIRECT CoinDCX realtime — REST 2s poll + WS event push (the app-parity feed)',
    };
  }
  if (s === 'groww-live') {
    return {
      label: 'Groww·live',
      cls: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30',
      title: 'Groww NSE live quote — genuine exchange last-traded price (stocks & ETFs)',
    };
  }
  // v21.6: the OFFICIAL Groww Trading-API tier — 1s-fresh batched LTP
  // (50 symbols/call) via the user's own GROWW_API_KEY/SECRET. Emerald
  // (venue-direct, paid tier) — distinct label from the public CDN tier.
  if (s === 'groww-api') {
    return {
      label: 'Groww·API',
      cls: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30',
      title: 'Groww Trading API — official batched LTP at 1s freshness (the ultrafast direct-Groww tier)',
    };
  }
  if (s === 'tv-ws') {
    return {
      label: 'TV·WS',
      cls: 'bg-sky-500/15 text-sky-300 border-sky-500/30',
      title: 'TradingView browser WebSocket — sub-second push, no API key',
    };
  }
  if (s === 'finnhub-global-rt' || s === 'finnhub-rest') {
    return {
      label: 'Finnhub·RT',
      cls: 'bg-sky-500/15 text-sky-300 border-sky-500/30',
      title: 'Finnhub REST quote — fallback #1 (US-desk shared key, 55/min rate-limited, staleness-gated)',
    };
  }
  if (s === 'finnhub-stream') {
    return {
      label: 'Finnhub·WS',
      cls: 'bg-sky-500/15 text-sky-300 border-sky-500/30',
      title: 'Finnhub WebSocket trade stream — instant push for covered symbols',
    };
  }
  if (s === 'binance-fut-ws') {
    return {
      label: 'Binance·WS',
      cls: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30',
      title: 'Binance futures WebSocket — SUB-SECOND push (the accelerator tier while the CoinDCX socket is dark; same USDT-perp domain, honestly labeled)',
    };
  }
  // v20.2 divergence guard: the Binance→INR PROJECTION drifted >0.3%
  // beyond the CoinDCX anchor — this price is extrapolated, not
  // venue-confirmed. Amber, never green.
  if (s === 'binance-proj-drift') {
    return {
      label: 'Binance·PROJ',
      cls: 'bg-amber-500/15 text-amber-300 border-amber-500/40',
      title: 'Binance→INR projection drifted >0.3% beyond the CoinDCX anchor — extrapolated price (venue abhi confirm nahi hua), levels par dhyan rakho',
    };
  }
  // v20.9.3 FIX (L): the spot WS ACCELERATOR gets its own branch — it runs
  // WHILE CoinDCX streams (projecting Binance USDT to INR sub-second), so
  // the generic startsWith('binance') perp-fallback tooltip ("dono dark
  // hain") was contextually wrong for this leg.
  if (s === 'binance-crypto-ws') {
    return {
      label: 'Binance·ACC',
      cls: 'bg-sky-500/15 text-sky-300 border-sky-500/30',
      title: 'Binance spot WS accelerator — CoinDCX stream ke SAATH chalta hai (USDT→INR projection, sub-second); venue anchor CoinDCX hi hai',
    };
  }
  if (s.startsWith('binance')) {
    return {
      label: 'Binance·RT',
      cls: 'bg-sky-500/15 text-sky-300 border-sky-500/30',
      title: 'Binance perp fallback (REST, ~5s) — CoinDCX RT and the Binance WS accelerator are both dark right now; same USDT domain, honestly labeled',
    };
  }
  if (s === 'yahoo-delayed' || s === 'yahoo-global-rt' || s === 'yahoo-us-fallback') {
    return {
      label: 'Yahoo·delayed',
      cls: 'bg-amber-500/15 text-amber-300 border-amber-500/40',
      title: 'Yahoo Finance — fallback source (Groww miss / index fallback / Finnhub failed or rate-limited)',
    };
  }
  if (s === 'tv-us-batch') {
    return {
      label: 'TV·batch',
      cls: 'bg-sky-500/15 text-sky-300 border-sky-500/30',
      title: 'TradingView scanner batch — one request for every gap symbol (~3s cadence)',
    };
  }
  if (s === 'global-sim-rt') {
    return {
      label: 'SIM·synthetic',
      cls: 'bg-slate-600/20 text-slate-400 border-slate-500/30',
      title: 'Deterministic synthetic walk — no public price exists for this name (labeled SIM everywhere)',
    };
  }
  // v10.13 (deep-recheck M6): unknown/missing source → NEUTRAL pill, not a
  // green LIVE. The old default painted every unmapped label (misspelled,
  // future source strings, 'yahoo-us-fallback' before this fix) as a green
  // "LIVE" — a label sink that silently laundered delayed/unknown feeds into
  // realtime-looking pills. Unknown provenance must LOOK unknown.
  return {
    label: 'LIVE',
    cls: 'bg-slate-600/20 text-slate-400 border-slate-500/30',
    title: 'Live price stream (source unlabeled)',
  };
}

/** The 8px provenance pill — render next to a live LTP. */
export function LiveSourceBadge({ src }: { src?: string | null }) {
  const b = liveSourceBadge(src);
  return (
    <span className={`px-1 py-0.5 rounded text-[8px] font-black border tracking-wider ${b.cls}`} title={b.title}>
      {b.label}
    </span>
  );
}
