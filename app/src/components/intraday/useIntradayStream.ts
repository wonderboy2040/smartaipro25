// ============================================================
// intraday/useIntradayStream — SSE live-quote/outcome stream hook
// ------------------------------------------------------------
// Connects to GET /api/intraday-stream (AUTHENTICATED — ?session=
// token; it is NOT a public path) and receives:
//   event: quotes        → { SYMBOL: { price, change, ts } }
//   event: outcome       → { type, symbol, price, pnl, ... }
//   event: regime        → NIFTY/VIX regime (India market)
//   event: crypto-regime → BTC regime (crypto market)
//   event: status        → watcher heartbeat (keepalive)
// Auto-reconnects (native EventSource + capped manual backoff after a
// sustained error streak). Falls back silently when the stream is
// unavailable — the tab still works via 60s polling.
// v13.2 (bandwidth plan B2): HIDDEN-PARK — a tab hidden ≥30s closes its
// EventSource (the server watcher idles to 30s at zero clients); visible
// again → instant reconnect. Live quotes keep flowing for brief switches.
// v18.5 FIX: no token → DON'T connect at all (a bare URL 401s and the
// native ~3s retry loop hammers the server); a 1s token poll waits for
// login instead, then connects once the token exists.
// ============================================================
import { useEffect, useRef, useState } from 'react';
import { getSessionToken, getProxyBase } from '../../utils/api';
import type { LiveQuote, MarketRegime, OutcomeEvent } from './types';

// v9.1 FIX: resolve the backend the SAME way apiFetch does (localStorage
// override → env → mirror-host detection) — the raw env-only read could
// point SSE at a different backend than every REST call. And append the
// ?session= token: /api/intraday-stream is NOT a public path, so a bare
// EventSource 401'd cross-origin (Vercel → Render can't send cookies) and
// the Paper Desk live P&L never ticked.
// v10.13 (deep-recheck M3/M5): the base is resolved LIVE inside the effect
// (a runtime backend switch used to leave the stream on the OLD server),
// and a sustained error streak now falls back to a capped manual reconnect
// that RE-READS the session token — an expired token otherwise left the
// browser auto-retrying the same doomed URL every ~3s for the session's
// lifetime while the tab degraded to 60s polling.
// v20.7.12 [H3-4]: useCxLivePrices-parity guards — (a) MOUNT-WHILE-HIDDEN
// park (pehle sirf visibilitychange EVENT pe hota tha — bg tab me mount
// hua socket hamesha hot rehta tha), (b) 10s NEVER-STOP WATCHDOG (no
// socket + no pending retry → connect NOW — leaked/dead state self-heal)
// + 45s ZOMBIE KILL (connected + zero frames = half-dead TCP jo pehle
// hamesha 'connected' dikhta tha).

export interface StreamState {
  livePrices: Record<string, LiveQuote>;
  regime: MarketRegime | null;
  cryptoRegime: MarketRegime | null;
  outcomes: OutcomeEvent[];
  connected: boolean;
  lastQuoteAt: number;
}

export function useIntradayStream(enabled: boolean, onOutcome?: (ev: OutcomeEvent) => void): StreamState {
  const [livePrices, setLivePrices] = useState<Record<string, LiveQuote>>({});
  const [regime, setRegime] = useState<MarketRegime | null>(null);
  const [cryptoRegime, setCryptoRegime] = useState<MarketRegime | null>(null);
  const [outcomes, setOutcomes] = useState<OutcomeEvent[]>([]);
  const [connected, setConnected] = useState(false);
  const [lastQuoteAt, setLastQuoteAt] = useState(0);
  const outcomeCbRef = useRef(onOutcome);
  outcomeCbRef.current = onOutcome;

  useEffect(() => {
    if (!enabled) {
      setConnected(false);
      return;
    }
    let es: EventSource | null = null;
    let closed = false;
    let errStreak = 0;
    let manualRetryTimer: ReturnType<typeof setTimeout> | null = null;
    let parkTimer: ReturnType<typeof setTimeout> | null = null;
    let tokenWaitTimer: ReturnType<typeof setTimeout> | null = null;
    let parked = false;
    // v20.7.12 [H3-4]: zombie-kill clock — ANY frame (quotes/regime/
    // outcome/status) bumps it; 45s silence on an OPEN socket = half-dead
    // connection jo pehle hamesha connected=true dikhati thi.
    let lastFrameAt = 0;

    const buildUrl = () => {
      // SECURITY: EventSource cannot send the Bearer header, and httpOnly
      // cookies don't travel cross-origin — requireAuth accepts a
      // ?session=<token> query param for exactly this case (same pattern as
      // utils/liveStream.ts → /api/stream). Re-read FRESH every attempt so
      // a re-login heals the stream instead of looping 401s forever.
      const session = getSessionToken();
      const base = getProxyBase();
      return session
        ? `${base}/api/intraday-stream?session=${encodeURIComponent(session)}`
        : '';
    };

    const connect = () => {
      if (closed || es) return;
      const url = buildUrl();
      // v18.5 FIX: without a session token the SSE endpoint 401s — the
      // browser's native ~3s retry loop would hammer it all session.
      // Instead: poll for a token every 1s (cheap) and connect the moment
      // login provides one.
      if (!url) {
        if (tokenWaitTimer || closed) return;
        tokenWaitTimer = setTimeout(() => { tokenWaitTimer = null; connect(); }, 1000);
        return;
      }
      try {
        es = new EventSource(url);
      } catch {
        return;
      }
      attach(es);
    };

    const scheduleManualRetry = () => {
      if (closed || manualRetryTimer || es) return;
      const attempt = Math.min(errStreak - 5 + 1, 6);
      manualRetryTimer = setTimeout(() => {
        manualRetryTimer = null;
        connect();
      }, Math.min(60000, 5000 * attempt));
    };

    const attach = (src: EventSource) => {
      src.onopen = () => { if (!closed) { setConnected(true); errStreak = 0; lastFrameAt = Date.now(); } };

      src.addEventListener('quotes', (e) => {
        if (closed) return;
        lastFrameAt = Date.now();
        try {
          const data = JSON.parse((e as MessageEvent).data) as Record<string, LiveQuote>;
          setLivePrices(prev => ({ ...prev, ...data }));
          setLastQuoteAt(Date.now());
        } catch { /* malformed frame */ }
      });

      src.addEventListener('regime', (e) => {
        if (closed) return;
        lastFrameAt = Date.now();
        try {
          setRegime(JSON.parse((e as MessageEvent).data) as MarketRegime);
        } catch { /* malformed frame */ }
      });

      src.addEventListener('crypto-regime', (e) => {
        if (closed) return;
        lastFrameAt = Date.now();
        try {
          setCryptoRegime(JSON.parse((e as MessageEvent).data) as MarketRegime);
        } catch { /* malformed frame */ }
      });

      src.addEventListener('outcome', (e) => {
        if (closed) return;
        lastFrameAt = Date.now();
        try {
          const ev = JSON.parse((e as MessageEvent).data) as OutcomeEvent;
          setOutcomes(prev => [ev, ...prev].slice(0, 30));
          outcomeCbRef.current?.(ev);
        } catch { /* malformed frame */ }
      });

      src.addEventListener('status', () => { if (!closed) { setConnected(true); lastFrameAt = Date.now(); } });

      src.onerror = () => {
        // EventSource auto-reconnects; just reflect the drop in the UI.
        // v10.13: after a SUSTAINED streak (6+ failures, no open), take
        // over with a capped manual backoff + freshly built URL (the
        // browser loop would otherwise retry a dead/expired token URL
        // every ~3s forever).
        if (closed) return;
        setConnected(false);
        errStreak++;
        if (errStreak >= 6) {
          try { src.close(); } catch { /* noop */ }
          if (es === src) es = null;
          scheduleManualRetry();
        }
      };
    };

    // v13.2 B2: hidden ≥30s → park the stream (zero egress for a tab
    // nobody is watching); visible → reconnect immediately.
    const onVis = () => {
      if (document.hidden) {
        if (parkTimer) return;
        parkTimer = setTimeout(() => {
          parkTimer = null;
          if (closed || parked) return;
          parked = true;
          try { es?.close(); } catch { /* noop */ }
          es = null;
          setConnected(false);
        }, 30_000);
      } else {
        if (parkTimer) { clearTimeout(parkTimer); parkTimer = null; }
        if (parked || (!es && !manualRetryTimer && !tokenWaitTimer)) {
          parked = false;
          errStreak = 0; // user is waiting — give native reconnect a fresh chance
          connect();
        }
      }
    };
    document.addEventListener('visibilitychange', onVis);
    // v20.7.12 [H3-4]: MOUNT-WHILE-HIDDEN park (useCxLivePrices parity) —
    // bg tab restore/lazy mount pe pehle socket hamesha hot jata tha jab
    // tak ek visibilitychange event nahi aata tha.
    if (typeof document !== 'undefined' && document.hidden) onVis();

    // v20.7.12 [H3-4]: NEVER-STOP WATCHDOG (10s) — (a) no socket + not
    // parked + koi pending retry nahi → connect ABHI (koi bhi leaked
    // dead state ek tick me self-heal), (b) parked + tab phir VISIBLE →
    // unpark + connect (missed event pehle hamesha ke liye park rakhta
    // tha), (c) OPEN socket + VISIBLE + 45s silence → zombie → reconnect.
    const watchdog = setInterval(() => {
      if (closed) return;
      if (!parked && !es && !manualRetryTimer && !tokenWaitTimer) connect();
      if (parked && !document.hidden) { parked = false; connect(); }
      if (es && !document.hidden && lastFrameAt > 0 && Date.now() - lastFrameAt > 45_000) {
        try { es.close(); } catch { /* already gone */ }
        es = null;
        errStreak = 0;
        setConnected(false);
        connect();
      }
    }, 10_000);

    connect();

    return () => {
      closed = true;
      clearInterval(watchdog);
      if (manualRetryTimer) clearTimeout(manualRetryTimer);
      if (parkTimer) clearTimeout(parkTimer);
      if (tokenWaitTimer) clearTimeout(tokenWaitTimer);
      document.removeEventListener('visibilitychange', onVis);
      try { es?.close(); } catch { /* noop */ }
      es = null;
    };
  }, [enabled]);

  return { livePrices, regime, cryptoRegime, outcomes, connected, lastQuoteAt };
}
