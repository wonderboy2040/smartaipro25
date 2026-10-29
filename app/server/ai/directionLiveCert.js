// ============================================================
// server/ai/directionLiveCert.js — v21.23.11 LIVE DIRECTION CERTIFICATE
// ------------------------------------------------------------
// THE GAP THIS CLOSES (live-probe 2026-10-20):
//   v21.23.4 ka /api/ai/direction-selftest SYNTHETIC candles pe 13/13
//   PASS tha, sandbox board-probe (Binance leg) 17/20 AGREE tha — phir
//   bhi user ke LIVE India box pe SAB signals opposite the. Kyunki:
//     • selftest computation-layer prove karta hai — DATA WIRE nahi.
//     • Hermetic tests mock ko us SHAPE me banate hain jo code assume
//       karta hai — CoinDCX ka real wire drift kabhi catch nahi hota.
//     • Datacenter sandbox me CoinDCX Cloudflare-blocked hota hai →
//       wahan Binance leg chalti hai → bug reproduce hi nahi hota.
//   YE certificate REAL network calls se app ke APNE candle chains
//   ko live par unki REAL output ke liye audit karta hai:
//     1. reachable      — ≥30 canonical bars mili?
//     2. orientation    — series ASCENDING hai? (the MIRROR detector —
//                         CoinDCX newest-first wire ka silent mirror
//                         yahan FAIL hoga, chain ka naam lekar)
//     3. freshness      — last bar ki age sane hai?
//     4. ltp-agreement  — lastClose us chain ke LIVE ticker ke ±3%
//                         me hai? (scale/domain corruption pakadta hai)
//     5. dir-agreement  — _tfVote us series ke apne REALIZED 20-bar
//                         trend se agree karta hai? (systematic
//                         inversion ka LIVE ground-truth proof)
//
// WIRING: boot pe ek non-blocking log line + on-demand
//   /api/ai/direction-live-certificate (no-store).
// FAIL = data-chain issue EXACTLY named; synthetic selftest bhi saath
//   me — computation vs data ka separation ek jagah dikhta hai.
// ============================================================
import { fetchCoinDcxCandles, fetchBinanceKlines, isNseOpen } from './data.js';
import { fetchCoinDcxTickers } from '../cryptoStream.js';
import { fetchFuturesCandles, fetchMetalsFapiCandles, fetchMetalsPrices, fetchFuturesPrices } from './futures.js';
import { __tfVote } from './mtf.js';
import { seriesOrientation, candleCanonicalStats, canonicalizeCandles } from './lib/candles.js';
import { runDirectionSelfTest } from './directionSelfTest.js';

const TF_MS = { '15m': 900_000, '1h': 3_600_000 };
const LTP_AGREE_PCT = 0.03;       // lastClose vs live ticker tolerance
const TREND_FLOOR_PCT = 0.005;    // realized-trend significance floor (0.5%)

function realizedTrend(candles, lookback = 20) {
  if (!Array.isArray(candles) || candles.length < lookback + 2) return null;
  const last = Number(candles[candles.length - 1].close);
  const past = Number(candles[candles.length - 1 - lookback].close);
  if (!(past > 0) || !(last > 0)) return null;
  return (last - past) / past;
}

async function _binanceTickerPrice() {
  for (const host of ['https://api.binance.com', 'https://data-api.binance.vision']) {
    try {
      const r = await fetch(`${host}/api/v3/ticker/price?symbol=BTCUSDT`, { signal: AbortSignal.timeout(6000) });
      if (!r.ok) continue;
      const j = await r.json();
      const p = Number(j?.price);
      if (p > 0) return p;
    } catch { /* next host */ }
  }
  return null;
}

/**
 * Run one candle chain through the full live direction audit.
 * NEVER throws — a chain that cannot even fetch reports
 * { status:'UNREACHABLE', note } honestly (geo-block etc.).
 */
async function _auditChain({ label, tf, fetchCandles, tickerPrice }) {
  const base = { chain: label, status: null, note: null, bars: 0, orientation: null, ageMin: null, lastClose: null, ticker: null, trend20: null, vote: null, checks: {} };
  let candles = null;
  try { candles = await fetchCandles(); } catch { candles = null; }
  if (!Array.isArray(candles) || candles.length < 30) {
    return { ...base, status: 'UNREACHABLE', note: 'candle chain down / thin / geo-blocked (honest skip — no verdict)' };
  }
  const orientation = seriesOrientation(candles);
  const last = candles[candles.length - 1];
  const ageMin = Math.round((Date.now() - Number(last.time)) / 60000);
  const trend = realizedTrend(candles);
  const vote = __tfVote(candles, tf);
  const ticker = await tickerPrice().catch(() => null);

  const checks = {};
  checks.orientation_ascending = orientation === 'asc';
  const tfMs = TF_MS[tf] ?? 900_000;
  checks.freshness_sane = ageMin >= 0 && ageMin <= (3 * tfMs) / 60000 + 10;
  let ltpAgree = null;
  if (Number(ticker) > 0 && Number(last.close) > 0) {
    ltpAgree = Math.abs(Number(last.close) - Number(ticker)) / Number(ticker) <= LTP_AGREE_PCT;
  }
  checks.ltp_vs_live_ticker = ltpAgree; // null = ticker unavailable (honest)
  let dirAgree = null;
  if (trend != null && Math.abs(trend) >= TREND_FLOOR_PCT && vote && (vote.dir === 1 || vote.dir === -1)) {
    dirAgree = (trend > 0 && vote.dir === 1) || (trend < 0 && vote.dir === -1);
  }
  checks.vote_vs_realized_trend = dirAgree; // null = flat market or no vote

  const hardFails = Object.entries(checks)
    .filter(([, v]) => v === false)
    .map(([k]) => k);
  return {
    ...base,
    status: hardFails.length === 0 ? 'PASS' : 'FAIL',
    note: hardFails.length === 0 ? 'live chain direction-clean' : `FAILED: ${hardFails.join(', ')} (wire-format/shape drift inspect karo — MIRROR class)`,
    bars: candles.length, orientation, ageMin,
    lastClose: Number(last.close), ticker: Number(ticker) || null,
    trend20: trend != null ? Math.round(trend * 10000) / 100 : null, // %
    vote: vote && (vote.dir === 1 || vote.dir === -1) ? (vote.dir === 1 ? 'BULL' : 'BEAR') : (vote ? 'FLAT' : 'n/a'),
    checks,
  };
}

/**
 * The live certificate — REAL data through the app's OWN chains.
 * @param {{skipNetwork?:boolean}} [opts]
 */
export async function runLiveDirectionCertificate(opts = {}) {
  const ranAt = Date.now();
  if (opts?.skipNetwork) {
    return { pass: true, ranAt, version: 'v21.27.2', chains: [], synthetic: null, note: 'network skipped' };
  }
  const chains = [];
  try {
    chains.push(await _auditChain({
      label: 'coindcx-spot-inr (BTCINR 15m)', tf: '15m',
      fetchCandles: () => fetchCoinDcxCandles('BTC', '15m', { noCache: true }),
      tickerPrice: async () => {
        const rows = await fetchCoinDcxTickers();
        const t = (Array.isArray(rows) ? rows : []).find(x => x?.market === 'BTCINR');
        return Number(t?.last_price) || null;
      },
    }));
  } catch (e) { chains.push({ chain: 'coindcx-spot-inr (BTCINR 15m)', status: 'UNREACHABLE', note: String(e?.message || e) }); }
  try {
    chains.push(await _auditChain({
      label: 'coindcx-fut-usdt (B-BTC_USDT 15m)', tf: '15m',
      fetchCandles: () => fetchFuturesCandles('B-BTC_USDT', '15', 240),
      tickerPrice: async () => {
        const rows = await fetchFuturesPrices({ maxAgeMs: 0 });
        const r = (Array.isArray(rows) ? rows : []).find(x => x?.pair === 'B-BTC_USDT');
        return Number(r?.last) || null;
      },
    }));
  } catch (e) { chains.push({ chain: 'coindcx-fut-usdt (B-BTC_USDT 15m)', status: 'UNREACHABLE', note: String(e?.message || e) }); }
  // v21.23.13 [CHAIN #6 — cdc-official]: CoinDCX ka CURRENT DOCUMENTED
  // candles endpoint (api.coindcx.com/market_data/candles) ab apni OWN cert
  // chain se audit hota hai. Ye endpoint sabse likely FUTURE wire-drift
  // target hai (docs ke drift history ki wajah se hi MIRROR-SHIELD bana),
  // aur iski leg fetchCoinDcxCandles ke ANDAR embedded fallback hai — pehle
  // legacy leg PASS ho jata to official leg ki orientation/freshness ka
  // koi alag proof nahi tha. Same URL, same canonicalizer, same
  // `cdc-official:` label — wireAbsorb telemetry bhi unified rehti hai.
  try {
    chains.push(await _auditChain({
      label: 'cdc-official (api.coindcx.com BTCINR 15m)', tf: '15m',
      fetchCandles: async () => {
        for (const opair of ['B-BTC_INR', 'BTCINR']) {
          try {
            const r = await fetch(
              `https://api.coindcx.com/market_data/candles?pair=${encodeURIComponent(opair)}&interval=15m&limit=240`,
              { headers: { 'User-Agent': 'Mozilla/5.0 (WealthAI direction-live-cert)' }, signal: AbortSignal.timeout(8000) },
            );
            if (!r.ok) continue;
            const raw = await r.json();
            if (!Array.isArray(raw) || raw.length === 0) continue;
            const candles = canonicalizeCandles(raw, { label: 'cdc-official:BTC:15m' });
            if (candles && candles.length >= 30) return candles;
          } catch { /* next pair leg */ }
        }
        return null;
      },
      tickerPrice: async () => {
        const rows = await fetchCoinDcxTickers();
        const t = (Array.isArray(rows) ? rows : []).find(x => x?.market === 'BTCINR');
        return Number(t?.last_price) || null;
      },
    }));
  } catch (e) { chains.push({ chain: 'cdc-official (api.coindcx.com BTCINR 15m)', status: 'UNREACHABLE', note: String(e?.message || e) }); }
  try {
    chains.push(await _auditChain({
      label: 'metals-fapi (XAUUSDT 15m)', tf: '15m',
      fetchCandles: () => fetchMetalsFapiCandles('XAU', '15', 240),
      tickerPrice: async () => {
        const rows = await fetchMetalsPrices();
        const r = (Array.isArray(rows) ? rows : []).find(x => x?.base === 'XAU');
        return Number(r?.last) || null;
      },
    }));
  } catch (e) { chains.push({ chain: 'metals-fapi (XAUUSDT 15m)', status: 'UNREACHABLE', note: String(e?.message || e) }); }
  try {
    chains.push(await _auditChain({
      label: 'binance-usdt (BTCUSDT 15m)', tf: '15m',
      fetchCandles: () => fetchBinanceKlines('BTC', '15m', { noCache: true }),
      tickerPrice: _binanceTickerPrice,
    }));
  } catch (e) { chains.push({ chain: 'binance-usdt (BTCUSDT 15m)', status: 'UNREACHABLE', note: String(e?.message || e) }); }

  // India Yahoo chain — NSE band ho to honest SKIP (stale-gate by design)
  if (isNseOpen()) {
    try {
      const { rawTfCandles } = await import('./mtf.js');
      chains.push(await _auditChain({
        label: 'india-yahoo (RELIANCE 15m)', tf: '15m',
        fetchCandles: () => rawTfCandles('RELIANCE', 'INDIA', '15m'),
        tickerPrice: async () => null, // Groww liveFeed row — ticker optional (null = honest skip)
      }));
    } catch (e) { chains.push({ chain: 'india-yahoo (RELIANCE 15m)', status: 'UNREACHABLE', note: String(e?.message || e) }); }
  } else {
    chains.push({ chain: 'india-yahoo (RELIANCE 15m)', status: 'SKIP', note: 'NSE closed — stale-age gate by design (v21.23.10)' });
  }

  const fails = chains.filter(c => c.status === 'FAIL');
  const passCount = chains.filter(c => c.status === 'PASS').length;
  const unreachable = chains.filter(c => c.status === 'UNREACHABLE' || c.status === 'SKIP').length;
  const synthetic = runDirectionSelfTest();
  // v21.23.12 [PASS-SEMANTICS HONESTY]: pehle `fails===0` hi pass tha — agar
  // SAB chains UNREACHABLE ho (geo-block/WAF window — bilkul wahi window
  // jisme engine degraded/daily data pe girti hai) to boot log "PASS"
  // print karta tha 0 verified chains ke saath. Ab pass ke liye ≥1 chain
  // REAL network se PASS chahiye; warna honest INCONCLUSIVE (pass:false —
  // boot line FAIL-shaped dikhega, reason me saaf likha hoga).
  const pass = fails.length === 0 && passCount > 0 && synthetic.pass;
  // v21.23.12 [WIRE-DRIFT VISIBILITY]: certificate chains apne aap
  // canonical fetchers se chalti hain — wire drift ho to canonicalizer
  // use ABSORB karta hai (orientation post-fix hamesha 'asc' — mirror
  // kabhi nahi). Absorption INVISIBLE nahi hona chahiye: canonicalizer
  // ke recent-stats (label/dropped/raw-orientation) yahan expose hote
  // hain — CoinDCX wire dobara drift kare to dropped>0/reversed count
  // yahan dikhega, chahe trading output clean rahe.
  const recent = (candleCanonicalStats().recent || []).filter(r => /^cdc-|coindcx/i.test(String(r.label || '')));
  const wireAbsorb = recent.slice(-8);
  return {
    pass,
    verifiedChains: passCount,
    unverifiedChains: unreachable,
    ranAt,
    version: 'v21.27.2',
    chains,
    wireAbsorb,
    synthetic: { pass: synthetic.pass, passed: synthetic.passed, total: synthetic.total },
    summary: `${passCount} chain PASS · ${fails.length} FAIL · ${unreachable} unreachable/skip · synthetic ${synthetic.passed}/${synthetic.total}${passCount === 0 ? ' · INCONCLUSIVE: koi chain live-verify nahi hua (sab unreachable) — data-chain par passive verdict nahi' : ''}${wireAbsorb.length ? ` · wire-absorb events: ${wireAbsorb.length} (last: ${wireAbsorb[wireAbsorb.length - 1].label} raw=${wireAbsorb[wireAbsorb.length - 1].orientation} dropped=${wireAbsorb[wireAbsorb.length - 1].dropped})` : ''}`,
  };
}

/** Boot-time non-blocking one-shot. */
export function logLiveDirectionCertAtBoot(log = null) {
  (async () => {
    try {
      const r = await runLiveDirectionCertificate();
      const line = `[direction-live-cert] ${r.pass ? 'PASS' : 'FAIL'} — ${r.summary}`;
      if (typeof log === 'function') log(r.pass ? 'info' : 'error', line); else console.log(line);
      for (const c of r.chains) {
        if (c.status === 'FAIL') {
          const m = `[direction-live-cert] ✗ ${c.chain}: ${c.note} (bars=${c.bars} orientation=${c.orientation} lastClose=${c.lastClose} ticker=${c.ticker})`;
          if (typeof log === 'function') log('error', m); else console.error(m);
        }
      }
      return r;
    } catch (e) {
      const m = `[direction-live-cert] CRASH: ${e?.message || e}`;
      if (typeof log === 'function') log('error', m); else console.error(m);
    }
  })().catch(() => { /* boot never blocked */ });
}
