// ============================================================
// server/bots/smoke.js — Jev Bot Lab v20.8.0
// ------------------------------------------------------------
// Plan §4 Phase 0: teeno smoke tests + decision matrix.
//   4.1 Dhan 5-min data (bars aaye? ~1500/month? IST parse sahi?)
//   4.2 Jev ping (choice/probabilities/usage/latency)
//   4.3 CoinDCX / crypto candles (5-min, >=6 mahine — actual depth
//       reported honestly; Binance fallback checked too)
// Decision matrix (plan §4.4) is printed by smokeAll verdict().
// NO CREDS => SKIPPED (honest), never a fake pass.
// v21.14: layaPing leg removed (Laya provider retired).
// ============================================================
import { smokeDhan5m } from './core/dhanFetch.js';
import { jevPing } from './jevEngine.js';
import { fetchCoinDcxCandles, fetchBinanceKlines } from '../ai/data.js';

/** 4.3 crypto candle depth check. */
export async function smokeCryptoCandles({ base = 'BTC' } = {}) {
  const t0 = Date.now();
  const sources = [];
  let bars = null, source = null;
  try {
    const cdc = await fetchCoinDcxCandles(base, '5m', { noCache: true });
    if (cdc?.length) { bars = cdc; source = 'coindcx'; }
    sources.push(`coindcx:${cdc ? cdc.length : 0}`);
  } catch (e) { sources.push(`coindcx:err:${String(e?.message || e).slice(0, 40)}`); }
  if (!bars) {
    try {
      const bk = await fetchBinanceKlines(base, '5m');
      if (bk?.length) { bars = bk; source = 'binance'; }
      sources.push(`binance:${bk ? bk.length : 0}`);
    } catch (e) { sources.push(`binance:err:${String(e?.message || e).slice(0, 40)}`); }
  }
  if (!bars) return { name: 'crypto_candles', status: 'FAIL', reason: 'no source produced candles', sources };
  const first = new Date(bars[0].time), last = new Date(bars[bars.length - 1].time);
  const days = (last - first) / 86400000;
  return {
    name: 'crypto_candles', status: days >= 180 ? 'PASS' : 'PARTIAL',
    source, bars: bars.length, days: Math.round(days),
    from: first.toISOString(), to: last.toISOString(),
    note: days >= 180 ? '>=6 months OK' : `only ${Math.round(days)} days — plan §4.4: ab se roz store karo (candleStore), backtest tab tak deferred`,
    sources, latencyMs: Date.now() - t0,
  };
}

/** Run all smokes + the plan §4.4 decision matrix. */
export async function smokeAll({ dhanRange } = {}) {
  const [dhan, jev, crypto] = await Promise.all([
    smokeDhan5m(dhanRange || {}).catch(e => ({ name: 'dhan_5m', status: 'FAIL', reason: String(e?.message || e) })),
    jevPing().catch(e => ({ name: 'jev_ping', status: 'FAIL', reason: String(e?.message || e) })),
    smokeCryptoCandles().catch(e => ({ name: 'crypto_candles', status: 'FAIL', reason: String(e?.message || e) })),
  ]);
  const results = [dhan, jev, crypto];
  const verdict = {
    indiaDesk: dhan.status === 'PASS'
      ? (dhan.bars >= 1200 ? 'India desk full backtest (Phase 3)' : 'Limited days — candleStore se roz accumulate karo, daily fallback')
      : (dhan.status === 'SKIPPED' ? 'Dhan creds absent — rules vs gated chalao (AI-independent)' : 'Dhan fail — Data API plan / creds check karo'),
    jevArm: jev.status === 'PASS'
      ? 'Jev arm ON (paper) — threshold sweep Phase 4'
      : 'Jev unavailable — rules vs gated chalao; key/endpoint check',
    cryptoDesk: crypto.status === 'PASS'
      ? 'Crypto desk full backtest'
      : 'Crypto candles thin — accumulate via candleStore daily',
  };
  return { results, verdict, at: new Date().toISOString() };
}
