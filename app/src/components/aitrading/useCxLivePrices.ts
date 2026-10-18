// ============================================================
// src/components/aitrading/useCxLivePrices.ts — v10.10
// ------------------------------------------------------------
// THE BUG: the CoinDCX tab's three desks (SPOT / GLOBAL FUTURES /
// EQUITY SIM USDC) rendered `signal.ltp` — a snapshot baked at
// board-generation time (server board cache 60-90s + upstream
// price caches up to 20s + frontend 30s poll). A "fresh" signal
// card could sit next to a price that was minutes old → wrong
// calls, wrong entries, wrong P&L intuition ("wrong signal show
// ho raha hai").
//
// THE FIX: one EventSource to /api/stream carrying all THREE
// CoinDCX domains in a single connection:
//   crypto=BTC,ETH,…   SPOT INR   (IN_ keys — 2s CoinDCX anchor
//                                  + ~1s Binance WS accelerator)
//   fut=BTC,SOL,…      USDT perps (FUT_ keys — v10.10 cxRtStream,
//                                  2s DIRECT CoinDCX RT)
//   glob=AAPL,NVDA,…   USDC perps (GLOB_ keys — 2s direct RT,
//                                  Yahoo fallback 10s)
//
// Render hygiene (the reason this is not a naive setState-per-tick):
//   • incoming ticks buffer in a ref; ONE batched flush every 800ms
//     → ≤1.25 renders/sec for the WHOLE desk instead of 10-20/sec
//   • document.hidden → flushes pause (zero background renders);
//     visibilitychange → instant flush so the tab paints live again
//   • status: 'live' | 'connecting' | 'down' for the command-bar honesty chip
//
// v13.2 (bandwidth plan B2+B4):
//   • HIDDEN-PARK: a tab hidden ≥30s CLOSES its EventSource — the server's
//     refcounted pollers park at zero clients (zero upstream + zero egress
//     for a tab nobody is looking at). Visible again → instant reconnect
//     + snapshot repaint. A briefly-switched-away tab (≤30s) keeps its
//     connection — the flush gate already renders nothing.
//   • EXPONENTIAL BACKOFF: errors close the socket and retry at
//     1s→2s→4s→… capped. A Render cold-start or network blip can no longer
//     stampede N tabs into a fixed-3s reconnect-each-refetch-full-snapshot
//     loop.
//
// v18.6.3 REALTIME NEVER STOPS (user: "realtime kabhi band nahi hona
// chahiye"):
//   • BACKOFF CAP 30s→5s — a dark feed heals in ≤5s, not half a minute
//     (the old 30s cap is exactly what made a transient server restart
//     look like a dead "live feed down — retrying" panel).
//   • NEVER-STOP WATCHDOG (10s): no socket + not parked + no pending
//     backoff → connect NOW. Any leaked/dead state self-heals in one
//     watchdog tick — the feed can no longer get STUCK down.
//   • ZOMBIE KILL (45s silence while VISIBLE): a half-dead TCP connection
//     (server restarted behind a NAT keepalive, OS socket wedged) keeps
//     status='live' with zero frames flowing — the old hook trusted the
//     socket forever. 3 missed 15s status frames → hard reconnect.
//   • 'parked' status: a hidden tab parking its socket is NOT an outage —
//     the command-bar chip now says "paused (tab background)" instead of
//     the alarming red "live feed down — retrying".
// ============================================================
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { getProxyBase, getSessionToken } from '../../utils/api';

export interface CxLiveTick {
  price: number;
  change: number;
  high?: number;
  low?: number;
  volume?: number;
  time: number;
  /** v10.11 (#1): which upstream actually served this tick — the server
   *  labels every liveFeed write (SSE wire field `source`) so the UI can
   *  badge CoinDCX RT vs Finnhub vs Yahoo-delayed honestly. */
  src?: string;
}

export type CxLiveStatus = 'connecting' | 'live' | 'down' | 'parked';

/** v10.14 (deep-recheck S2 #3): the cxRt WS accelerator health, mirrored
 *  from the SSE `status` frame's `cxRt` field (server cxRtWsStatus()).
 *  Lets the badge explain WHY the ultra-fast feed degraded instead of
 *  silently reverting to the 2s REST cadence. */
export interface CxWsHealth {
  enabled: boolean;
  connected: boolean;
  healthy: boolean;
  cooldownActive: boolean;
  cooldownRemainMs: number;
  cooldownReason: string | null;
  failStreak: number;
  domains?: { fut: number; glob: number };
  premarketBudget?: number | null;
  /** v10.15: the Binance futures WS accelerator tier — sub-second FUT
   *  pushes while the CoinDCX socket is dark. */
  binanceFut?: {
    enabled: boolean;
    connected: boolean;
    healthy: boolean;
    lastTickAt: number | null;
    streams: number;
    wantOpen: boolean;
    cooldownActive: boolean;
    cooldownRemainMs: number;
    failStreak: number;
  } | null;
  /** v18.10: the OFFICIAL CoinDCX SPOT socket tier — servable = the INR
   *  book is WS-owned and direct sub-2s pushes are live. */
  spotWs?: {
    enabled: boolean;
    connected: boolean;
    servable: boolean;
    freshMarkets: number;
    markets: number;
    ageMs: number | null;
    cooling: boolean;
  } | null;
}

function toWsHealth(raw: Record<string, unknown> | null | undefined): CxWsHealth | null {
  if (!raw || typeof raw !== 'object') return null;
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  const bnRaw = raw.binanceFut as Record<string, unknown> | null | undefined;
  const spRaw = raw.spotWs as Record<string, unknown> | null | undefined;
  return {
    enabled: raw.enabled !== false,
    connected: raw.connected === true,
    healthy: raw.healthy === true,
    cooldownActive: raw.cooldownActive === true,
    cooldownRemainMs: num(raw.cooldownRemainMs),
    cooldownReason: typeof raw.cooldownReason === 'string' ? raw.cooldownReason : null,
    failStreak: num(raw.failStreak),
    domains: raw.domains && typeof raw.domains === 'object'
      ? { fut: num((raw.domains as Record<string, unknown>).fut), glob: num((raw.domains as Record<string, unknown>).glob) }
      : undefined,
    premarketBudget: typeof raw.premarketBudget === 'number' ? raw.premarketBudget : null,
    binanceFut: bnRaw && typeof bnRaw === 'object' ? {
      enabled: bnRaw.enabled !== false,
      connected: bnRaw.connected === true,
      healthy: bnRaw.healthy === true,
      lastTickAt: typeof bnRaw.lastTickAt === 'number' ? bnRaw.lastTickAt : null,
      streams: num(bnRaw.streams),
      wantOpen: bnRaw.wantOpen === true,
      cooldownActive: bnRaw.cooldownActive === true,
      cooldownRemainMs: num(bnRaw.cooldownRemainMs),
      failStreak: num(bnRaw.failStreak),
    } : null,
    spotWs: spRaw && typeof spRaw === 'object' ? {
      enabled: spRaw.enabled !== false,
      connected: spRaw.connected === true,
      servable: spRaw.servable === true,
      freshMarkets: num(spRaw.freshMarkets),
      markets: num(spRaw.markets),
      ageMs: typeof spRaw.ageMs === 'number' ? spRaw.ageMs : null,
      cooling: spRaw.cooling === true,
    } : null,
  };
}

const FLUSH_MS = 800;
const MAX_SYMS_PER_DOMAIN = 40; // parseSyms server-cap is 60; stay polite
const HIDDEN_PARK_MS = 30_000;  // v13.2 B2: hidden ≥30s → close the socket
const BACKOFF_MIN_MS = 1_000;   // v13.2 B4: 1s → 2s → 4s → …
const BACKOFF_MAX_MS = 5_000;   // v18.6.3: … capped at 5s (was 30s) — never-stop
const WATCHDOG_MS = 10_000;     // v18.6.3: the never-stop self-heal loop
const SILENCE_KILL_MS = 45_000; // v18.6.3: 3 missed 15s status frames → zombie kill

function cleanList(list: string[] | undefined | null): string[] {
  if (!Array.isArray(list)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of list) {
    const s = String(raw || '').trim().toUpperCase();
    if (!s || seen.has(s)) continue;
    seen.add(s);
    out.push(s);
    if (out.length >= MAX_SYMS_PER_DOMAIN) break;
  }
  return out;
}

function toTick(t: Record<string, unknown>): CxLiveTick | null {
  const price = Number(t.price);
  if (!(price > 0)) return null;
  return {
    price,
    change: typeof t.change === 'number' ? t.change : 0,
    high: t.high != null ? Number(t.high) : undefined,
    low: t.low != null ? Number(t.low) : undefined,
    volume: t.volume != null ? Number(t.volume) : undefined,
    time: Number(t.time) || Date.now(),
    src: typeof t.source === 'string' ? t.source : undefined,
  };
}

export function useCxLivePrices(active: boolean, spot: string[], fut: string[], glob: string[], india?: string[]) {
  const [ticks, setTicks] = useState<Record<string, CxLiveTick>>({});
  const [status, setStatus] = useState<CxLiveStatus>('connecting');
  const [lastAt, setLastAt] = useState(0);
  // v10.14: WS accelerator health (null until the first status frame lands)
  const [wsHealth, setWsHealth] = useState<CxWsHealth | null>(null);
  // v18.5 FIX (dead-band honesty): status frames arrive every 15s on a
  // healthy connection — their freshness is the feed-alive signal that
  // keeps a FLAT (<0.05% dead-band) coin's ⚡ live LTP from decaying to
  // the stale board snapshot at 30s (used to look like a feed outage).
  const lastStatusAtRef = useRef(0);
  // v18.6.3: the zombie-kill clock — ANY server frame (tick / snapshot /
  // status) bumps it; 45s of total silence on an OPEN socket means the
  // connection is half-dead (the old hook showed 'live' forever).
  const lastFrameAtRef = useRef(0);

  // v18.5 FIX (SSE churn): the joined keys are SORTED — the board re-ranks
  // symbol order every 30s, and an order-sensitive key tore down/rebuilt
  // the EventSource (snapshot+refcount churn) on every re-rank. Sorted →
  // same set, same key, zero reconnects.
  const spotKey = cleanList(spot).sort().join(',');
  const futKey = cleanList(fut).sort().join(',');
  const globKey = cleanList(glob).sort().join(',');
  // v12.9: NSE equities ride the SAME SSE via the in= param (Groww/Yahoo
  // IN_ namespace) — the manual-trade tracker's realtime LTP source.
  const indiaKey = cleanList(india).sort().join(',');
  // v20.7.12 [H3-5]: PER-DOMAIN watch sets — pehle ek union `keySet` tha:
  // forSignal('FUTURES','BTC') ka in-watch check `keySet.has('BTC')` SPOT
  // list se bhi pass ho jata tha (BTC futures list se nikal gaya par spot
  // me hai) → FUT_BTC tick 30s gate + 120s hard cap tak ⚡ LIVE badge
  // jhootha dikha sakta tha (stale-price-as-live class). Ab har domain
  // apne set se check hota hai; IN_ namespace spot+india dono ka hai.
  const domainSets = useMemo(() => {
    const mk = (k: string) => new Set(k ? k.split(',') : []);
    return { spot: mk(spotKey), fut: mk(futKey), glob: mk(globKey), india: mk(indiaKey) };
  }, [spotKey, futKey, globKey, indiaKey]);

  // v20.7.12 [H2-2]: DROPPED-SYMBOL PRUNING — pehle symbol-set CHANGE pe
  // cleanup setTicks({}) chalata tha: board re-rank (top-10 in/out, volatile
  // days pe har 30-60s) par SAB ticks wipe → har card ka ⚡ live LTP 60-90s
  // purane board snapshot pe flash-back + EventSource teardown/rebuild ka
  // connection churn. Ab sirf jo keys AB watch me nahi hain wahi prune
  // hote hain (namespace-aware); connection to tabhi rebuild hota hai jab
  // set hi badla ho (sorted keys already ensure reorder pe nahi hota).
  useEffect(() => {
    setTicks(prev => {
      if (!prev || Object.keys(prev).length === 0) return prev;
      const inSet = (ns: string, s: string) => domainSets[ns as 'spot' | 'fut' | 'glob' | 'india'].has(s);
      const keep: Record<string, CxLiveTick> = {};
      let dropped = 0;
      for (const [k, v] of Object.entries(prev)) {
        const ns = k.slice(0, k.indexOf('_'));
        const sym = k.slice(k.indexOf('_') + 1);
        const ok = ns === 'FUT' ? inSet('fut', sym)
          : ns === 'GLOB' ? inSet('glob', sym)
            : inSet('spot', sym) || inSet('india', sym); // IN_ namespace shared
        if (ok) keep[k] = v; else dropped++;
      }
      return dropped > 0 ? keep : prev;
    });
  }, [domainSets]);

  useEffect(() => {
    if (!active) return;
    if (!spotKey && !futKey && !globKey && !indiaKey) return; // nothing to watch yet

    // v20.1 FIX (deep audit): URL is now built PER CONNECT ATTEMPT, not
    // once at effect setup — the token used to be baked into `url` on
    // mount, so after a session expiry every reconnect retried the SAME
    // dead 401 URL forever (useIntradayStream solved this exact bug by
    // re-reading the token inside its buildUrl; parity now).
    const buildUrl = () => {
      const params = new URLSearchParams();
      if (spotKey) params.set('crypto', spotKey);
      if (futKey) params.set('fut', futKey);
      if (globKey) params.set('glob', globKey);
      if (indiaKey) params.set('in', indiaKey);
      // SECURITY: EventSource can't send headers cross-origin — the server's
      // auth middleware accepts ?session=<token> as the SSE fallback.
      const session = getSessionToken();
      if (session) params.set('session', session);
      return `${getProxyBase()}/api/stream?${params.toString()}`;
    };

    let es: EventSource | null = null;
    let disposed = false;
    let backoffMs = BACKOFF_MIN_MS;
    let backoffTimer: ReturnType<typeof setTimeout> | undefined;
    let parkTimer: ReturnType<typeof setTimeout> | undefined;
    let parked = false;

    // ---- buffered ingestion (the render-storm guard) ----
    const buffer = new Map<string, CxLiveTick>();
    let dirty = false;
    const flush = () => {
      if (!dirty || document.hidden) return; // background tab → zero renders
      dirty = false;
      const incoming = new Map(buffer);
      setTicks(prev => {
        const next = { ...prev };
        for (const [k, v] of incoming) next[k] = v;
        return next;
      });
      setLastAt(Date.now());
    };
    const flushTimer = setInterval(flush, FLUSH_MS);

    const ingest = (key: string, raw: Record<string, unknown>) => {
      const t = toTick(raw);
      if (!t) return;
      buffer.set(key, t);
      dirty = true;
    };

    const attach = (src: EventSource) => {
      src.onopen = () => { setStatus('live'); backoffMs = BACKOFF_MIN_MS; lastFrameAtRef.current = Date.now(); };
      // v13.2 B4: WE own the retry cadence — close before native retry fires,
      // then back off exponentially. Cold-start storms die in ≤2 rounds.
      // v18.6.3: the cap is 5s (was 30s) + the 10s watchdog below forces a
      // fresh attempt if this path ever leaks — "live feed down — retrying"
      // is now a ≤5s state, never a permanent one.
      src.onerror = () => {
        setStatus('down');
        try { src.close(); } catch { /* already gone */ }
        if (es === src) es = null;
        if (!disposed && !parked) scheduleReconnect();
      };
      src.addEventListener('status', (e: MessageEvent) => {
        lastStatusAtRef.current = Date.now();
        lastFrameAtRef.current = Date.now();
        try {
          const frame = JSON.parse(e.data) as Record<string, unknown>;
          // v20.7.12 [L-5]: identity-stable set — har 15s status frame naya
          // object bana ke extra tab render trigger karta tha chahe content
          // same ho. Shallow-compare ke baad hi naya identity.
          setWsHealth(prev => {
            const next = toWsHealth(frame?.cxRt as Record<string, unknown> | undefined);
            if (prev === next) return prev;
            if (prev && next && JSON.stringify(prev) === JSON.stringify(next)) return prev;
            return next;
          });
        } catch { /* malformed frame */ }
      });
      src.addEventListener('snapshot', (e: MessageEvent) => {
        lastFrameAtRef.current = Date.now();
        try {
          const map = JSON.parse(e.data) as Record<string, Record<string, unknown>>;
          for (const [k, v] of Object.entries(map)) ingest(k, v);
          flush(); // first paint — don't wait the 800ms
        } catch { /* malformed frame */ }
      });
      src.addEventListener('tick', (e: MessageEvent) => {
        try {
          const t = JSON.parse(e.data) as Record<string, unknown>;
          if (t && typeof t.key === 'string') { lastFrameAtRef.current = Date.now(); ingest(t.key, t as Record<string, unknown>); }
        } catch { /* malformed frame */ }
      });
    };

    const connect = () => {
      if (disposed || es) return;
      try {
        es = new EventSource(buildUrl());
        attach(es);
      } catch {
        setStatus('down');
        scheduleReconnect();
      }
    };

    const scheduleReconnect = () => {
      if (disposed || parked || backoffTimer) return;
      // v18.6.4: ±300ms jitter — ek event-loop stall (>45s) ke baad SAARE
      // visible tabs ek hi tick par reconnect karte the (stampede).
      const wait = backoffMs + Math.floor(Math.random() * 300);
      backoffMs = Math.min(BACKOFF_MAX_MS, backoffMs * 2);
      backoffTimer = setTimeout(() => {
        backoffTimer = undefined;
        connect();
      }, wait);
    };

    // v13.2 B2: hidden ≥30s → park (close; server pollers go idle at zero
    // clients). Visible → reconnect NOW (no backoff — the user is waiting)
    // + flush whatever arrived while briefly hidden.
    // v18.6.3: parked ≠ down — the chip says "paused (tab background)",
    // not the red "live feed down — retrying" (a parked socket is our OWN
    // bandwidth choice, not an outage).
    const onVis = () => {
      if (document.hidden) {
        if (parkTimer) return;
        parkTimer = setTimeout(() => {
          parkTimer = undefined;
          if (disposed || parked) return;
          parked = true;
          try { es?.close(); } catch { /* noop */ }
          es = null;
          setStatus('parked');
        }, HIDDEN_PARK_MS);
      } else {
        if (parkTimer) { clearTimeout(parkTimer); parkTimer = undefined; }
        if (parked || !es) {
          parked = false;
          connect(); // user came back — immediate, snapshot repaints the desk
        } else {
          flush();
        }
      }
    };
    document.addEventListener('visibilitychange', onVis);
    // v18.6.4: component jo HIDDEN tab me mount hua hai (bg tab restore /
    // lazy mount) park hoke start karo — pehle sirf visibilitychange EVENT
    // par park hota tha, mount-hidden socket hamesha hot raha tha.
    if (typeof document !== 'undefined' && document.hidden) onVis();

    // v18.6.3 REALTIME NEVER STOPS — the self-heal loop. Every 10s:
    //   (a) no socket + not parked + no pending backoff → connect NOW
    //       (any leaked dead state heals in one tick — the feed can
    //       never get STUCK down, whatever broke it)
    //   (b) parked but the tab is VISIBLE again (a missed
    //       visibilitychange — hidden before mount, event during a
    //       render) → unpark + connect (the old hook sat here FOREVER)
    //   (c) OPEN socket + tab VISIBLE + 45s of total silence → the
    //       connection is a zombie → close + reconnect immediately
    //       (resets backoff — a healthy server answers instantly)
    const watchdog = setInterval(() => {
      if (disposed) return;
      if (!parked && !es && !backoffTimer) connect();
      if (parked && !document.hidden) { parked = false; connect(); }
      if (es && !document.hidden
        && lastFrameAtRef.current > 0
        && Date.now() - lastFrameAtRef.current > SILENCE_KILL_MS) {
        try { es.close(); } catch { /* already gone */ }
        es = null;
        backoffMs = BACKOFF_MIN_MS;
        setStatus('connecting');
        connect();
      }
    }, WATCHDOG_MS);

    connect();

    return () => {
      disposed = true;
      clearInterval(flushTimer);
      clearInterval(watchdog);
      if (backoffTimer) { clearTimeout(backoffTimer); backoffTimer = undefined; }
      if (parkTimer) { clearTimeout(parkTimer); parkTimer = undefined; }
      document.removeEventListener('visibilitychange', onVis);
      try { es?.close(); } catch { /* noop */ }
      es = null;
      // v18.6.4: teardown honest-state reset — re-mount (desk switch,
      // React 18 remount) pe purana 'live' status + last-frame clock
      // bleed nahi karta tha (45s tak zombie-show ho sakta tha).
      // v20.7.12 [H2-2]: setTicks({}) HATA diya — ye cleanup sirf UNMOUNT
      // pe state-drop ke liye theek tha, par dep-change (board re-rank) pe
      // bhi chalta tha aur poore board ka live-price flash-back karta tha.
      // Dep-change pruning ab upar wale dedicated pruning effect me hai
      // (namespace-aware, sirf dropped keys); unmount pe React state waise
      // bhi destroy ho jati hai.
      setStatus('connecting');
      lastFrameAtRef.current = 0;
      lastStatusAtRef.current = 0;
    };
     
  }, [active, spotKey, futKey, globKey, indiaKey]);

  /** Live tick lookup for a signal: market → key namespace.
   *  v10.18 (deep-recheck #3): a stale tick is NOT live — when the board
   *  re-ranks and a symbol drops out of the watched key set, its last
   *  tick used to keep rendering with the ⚡ live marker (a frozen price
   *  presented as realtime, the exact "wrong signal" complaint v10.10
   *  fixed). Older than 30s → null → the card falls back to its board
   *  snapshot honestly. */
  const forSignal = useCallback((market: string, symbol: string): CxLiveTick | null => {
    const sym = String(symbol || '').trim().toUpperCase();
    if (!sym) return null;
    const key = market === 'FUTURES' ? `FUT_${sym}` : market === 'GLOBALFUTURES' ? `GLOB_${sym}` : `IN_${sym}`;
    const t = ticks[key] || null;
    if (!t) return null;
    // v18.5 FIX (dead-band honesty): a symbol whose price is FLAT gets NO
    // server ticks (the |Δ|<0.05% dead-band suppresses them) — the old
    // 30s hard gate nulled its ⚡ live LTP and fell back to the 60-90s-old
    // board snapshot while the feed was perfectly healthy (looked like an
    // outage). Now a tick stays live while BOTH hold: (a) the symbol is
    // still in the watched key set, and (b) status frames are flowing
    // (<45s old). Dropped-out symbols / a dead feed still decay after
    // 30s.
    // v20.7.10: hard cap 10min → 120s. Server ab FLAT-PRICE HEARTBEAT
    // bhejta hai (suppressed tick ke 45s baad force-send) — isliye feed
    // alive ho to t.time kabhi 45s se zyada stale NAHI hota; 120s+ age
    // matlab genuinely dead leg (pehle 10 min tak ⚡ jhootha dikhta tha). */
    const age = typeof t.time === 'number' ? Date.now() - t.time : Infinity;
    if (age > 30_000) {
      // v20.7.12 [H3-5]: domain-correct in-watch check (pehle cross-domain
      // union set tha — spot me bacha hua BTC futures tick ko 'watched'
      // bol deta tha).
      const dom = market === 'FUTURES' ? domainSets.fut
        : market === 'GLOBALFUTURES' ? domainSets.glob
          : null; // CRYPTO/INDIA → IN_ namespace (spot ∪ india)
      const inWatch = dom ? dom.has(sym) : (domainSets.spot.has(sym) || domainSets.india.has(sym));
      const feedAlive = (Date.now() - lastStatusAtRef.current) < 45_000;
      if (!(inWatch && feedAlive) || age > 120_000) return null;
    }
    return t;
  }, [ticks, domainSets]);

  return { ticks, status, lastAt, forSignal, wsHealth };
}
