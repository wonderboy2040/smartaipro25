// ============================================================
// server/ai/directionSelfTest.js — v21.23.4 RUNTIME DIRECTION CERTIFICATE
// ------------------------------------------------------------
// WHY THIS EXISTS (user: "sab ke sab signals opposite jaa rahe hai —
// accurately fix karo, concrete level pe"):
//   Poore direction chain ke 20+ locks test-suite me the, par user
//   ke RUNNING BUILD ko kabhi bhi khud certify karne ka RASTA nahi
//   tha. Ye module server BOOT pe chalta hai + /api/ai/direction-
//   selftest se on-demand milta hai. Ye RAW CANDLES se lekar
//   exchange ORDER BODY tak ka poora chain SYNTHETIC ground-truth
//   pe prove karta hai — rising market → LONG → BUY order; falling
//   market → SHORT → SELL order. INTERNAL-CONSISTENCY nahi —
//   GROUND-TRUTH assertion (yahi wo blind spot tha jisse "sab
//   signals opposite" live reproduce hote rahe par tests green
//   rehte the).
//
// DESIGN CONTRACTS:
//   * Pure/deterministic — koi network/API call nahi (sirf pure
//     builders: buildPlanFromCandles, dhanOrderBody,
//     futuresOrderBody, sideSignOf).
//   * FAIL-LOUD: koi bhi check fail → pass:false + har check ka
//     detail. Boot pe console log + API response dono me dikhta hai.
//   * Ye certificate ye ANSWER deta hai: "mera build direction
//     ulti compute kar raha hai ya nahi?" — FAIL = code/data issue,
//     PASS = direction computation sahi hai (agar live me phir bhi
//     ulta dikhe to data-feed ya stale-build, computation nahi).
// ============================================================
import { buildPlanFromCandles } from './tradePlanner.js';
import { dhanOrderBody } from './dhan.js';
import { futuresOrderBody } from './futures.js';
import { sideSignOf } from './superIntel.js';

// ---- synthetic ground-truth candle generators (deterministic) ----
function makeRisingCandles(count = 90, start = 100, stepPct = 0.003, intervalMs = 300_000) {
  const out = [];
  let px = start;
  const t0 = Date.now() - count * intervalMs;
  for (let i = 0; i < count; i++) {
    const drift = 1 + (stepPct * (0.6 + (i % 7 === 0 ? 0.5 : 0))); // small pullback bars, net up
    px = px * drift;
    const wick = px * 0.002;
    out.push({
      time: t0 + i * intervalMs,
      open: +(px * (1 - stepPct / 2)).toFixed(4),
      high: +(px + wick).toFixed(4),
      low: +(px * (1 - 0.004) - wick).toFixed(4),
      close: +px.toFixed(4),
      volume: 100 + (i % 11) * 7,
    });
  }
  return out;
}

function makeFallingCandles(count = 90, start = 100, stepPct = 0.003, intervalMs = 300_000) {
  const out = [];
  let px = start;
  const t0 = Date.now() - count * intervalMs;
  for (let i = 0; i < count; i++) {
    const drift = 1 - (stepPct * (0.6 + (i % 7 === 0 ? 0.5 : 0))); // small bounce bars, net down
    px = px * drift;
    const wick = px * 0.002;
    out.push({
      time: t0 + i * intervalMs,
      open: +(px * (1 + stepPct / 2)).toFixed(4),
      high: +(px * (1 + 0.004) + wick).toFixed(4),
      low: +(px - wick).toFixed(4),
      close: +px.toFixed(4),
      volume: 100 + (i % 11) * 7,
    });
  }
  return out;
}

function planSideOf(candles) {
  const p = buildPlanFromCandles({
    symbol: 'BTC', market: 'CRYPTO', mode: 'INTRADAY',
    ctxCandles: candles, trigCandles: candles,
  });
  return p;
}

/**
 * The end-to-end runtime direction certificate.
 * @returns {{ pass: boolean, ranAt: number, version: string, checks: Array<{name:string, ok:boolean, detail:string}> }}
 */
export function runDirectionSelfTest() {
  const checks = [];
  const add = (name, ok, detail) => checks.push({ name, ok: !!ok, detail: String(detail) });

  // ---- 1) RAW CANDLES → SIGNAL DIRECTION (ground truth, not consistency) ----
  const up = planSideOf(makeRisingCandles());
  add(
    'RISING market → signal LONG',
    up?.ok && up?.side === 'LONG',
    `rising 90-bar series → plan ${up?.ok ? 'ok' : 'REJECTED'}, side=${JSON.stringify(up?.side ?? null)}`,
  );
  if (up?.ok) {
    // LONG geometry: SL below entry, targets above (polarity proof)
    add(
      'LONG plan polarity (SL < entry < targets)',
      up.plan?.stopLoss != null && up.plan?.stopLoss < (up.plan?.entry ?? up.ltp) && (up.plan?.t1 ?? 0) > (up.plan?.entry ?? up.ltp),
      `entry=${up.plan?.entry} sl=${up.plan?.stopLoss} t1=${up.plan?.t1}`,
    );
  }

  const down = planSideOf(makeFallingCandles());
  add(
    'FALLING market → signal SHORT',
    down?.ok && down?.side === 'SHORT',
    `falling 90-bar series → plan ${down?.ok ? 'ok' : 'REJECTED'}, side=${JSON.stringify(down?.side ?? null)}`,
  );
  if (down?.ok) {
    add(
      'SHORT plan polarity (SL > entry > targets)',
      down.plan?.stopLoss != null && down.plan?.stopLoss > (down.plan?.entry ?? down.ltp) && (down.plan?.t1 ?? 0) < (down.plan?.entry ?? down.ltp),
      `entry=${down.plan?.entry} sl=${down.plan?.stopLoss} t1=${down.plan?.t1}`,
    );
  }

  // ---- 2) SIGNAL → EXCHANGE ORDER BODY (vocabulary proof) ----
  // dhan (India LIVE — the v21.23.2 BUG A class): LONG entry = BUY,
  // SHORT entry = SELL; protective SL exit = OPPOSITE side.
  try {
    const dhLong = dhanOrderBody({ symbol: 'RELIANCE', securityId: '1234', side: 'LONG', quantity: 1, kind: 'ENTRY' });
    const dhShort = dhanOrderBody({ symbol: 'RELIANCE', securityId: '1234', side: 'SHORT', quantity: 1, kind: 'ENTRY' });
    const tt = (b) => String(b?.transactionType || '').toUpperCase();
    add('dhan LONG entry → BUY transaction', tt(dhLong) === 'BUY', `transactionType=${tt(dhLong)}`);
    add('dhan SHORT entry → SELL transaction', tt(dhShort) === 'SELL', `transactionType=${tt(dhShort)}`);
    const dhSLonLong = dhanOrderBody({ symbol: 'RELIANCE', securityId: '1234', side: 'LONG', quantity: 1, kind: 'SL', triggerPrice: 98.5 });
    const dhSLonShort = dhanOrderBody({ symbol: 'RELIANCE', securityId: '1234', side: 'SHORT', quantity: 1, kind: 'SL', triggerPrice: 101.5 });
    add('dhan LONG protective SL → SELL (exit-cover)', tt(dhSLonLong) === 'SELL', `transactionType=${tt(dhSLonLong)}`);
    add('dhan SHORT protective SL → BUY (exit-cover)', tt(dhSLonShort) === 'BUY', `transactionType=${tt(dhSLonShort)}`);
  } catch (e) {
    add('dhan order body matrix', false, `threw: ${e?.message || e}`);
  }

  // CoinDCX futures: LONG entry = buy, SHORT entry = sell
  try {
    const fLong = futuresOrderBody({ pair: 'B-BTC_USDT', side: 'LONG', qty: 0.001, leverage: 3, price: 100000, marginCurrency: 'USDT' });
    const fShort = futuresOrderBody({ pair: 'B-BTC_USDT', side: 'SHORT', qty: 0.001, leverage: 3, price: 100000, marginCurrency: 'USDT' });
    const fs = (b) => String(b?.order?.side || '').toLowerCase();
    add('CoinDCX futures LONG → buy', fs(fLong) === 'buy', `order.side=${fs(fLong)}`);
    add('CoinDCX futures SHORT → sell', fs(fShort) === 'sell', `order.side=${fs(fShort)}`);
  } catch (e) {
    add('CoinDCX futures order body matrix', false, `threw: ${e?.message || e}`);
  }

  // ---- 3) SIDE-ALIAS SAFETY (v21.23.4) ----
  add("sideSignOf('LONG') = +1 / sideSignOf('SHORT') = −1",
    sideSignOf('LONG') === 1 && sideSignOf('SHORT') === -1,
    `LONG=${sideSignOf('LONG')} SHORT=${sideSignOf('SHORT')}`);
  add("sideSignOf('BUY') = +1 / sideSignOf('SELL') = −1 (exchange vocab alias)",
    sideSignOf('BUY') === 1 && sideSignOf('SELL') === -1,
    `BUY=${sideSignOf('BUY')} SELL=${sideSignOf('SELL')}`);
  add('sideSignOf(unknown) = null (honest refuse, no silent LONG)',
    sideSignOf('FLAT') == null && sideSignOf(undefined) == null && sideSignOf('') == null,
    `FLAT=${sideSignOf('FLAT')} undefined=${sideSignOf(undefined)}`);

  const pass = checks.every(c => c.ok);
  return {
    pass,
    ranAt: Date.now(),
    version: 'v21.23.4',
    passed: checks.filter(c => c.ok).length,
    total: checks.length,
    checks,
  };
}

/** Boot-time one-shot — logs the certificate result. */
export function logDirectionSelfTestAtBoot(log = null) {
  try {
    const r = runDirectionSelfTest();
    const line = `[direction-selftest] ${r.pass ? 'PASS' : 'FAIL'} ${r.passed}/${r.total} — rising→LONG/BUY · falling→SHORT/SELL certificate ${r.pass ? 'INTACT' : 'BROKEN (direction computation inspect karo!)'}`;
    if (typeof log === 'function') log(r.pass ? 'info' : 'error', line);
    else console.log(line);
    if (!r.pass) {
      const failed = r.checks.filter(c => !c.ok).map(c => `  ✗ ${c.name}: ${c.detail}`);
      const dump = failed.join('\n');
      if (typeof log === 'function') log('error', `[direction-selftest] failed checks:\n${dump}`);
      else console.error(`[direction-selftest] failed checks:\n${dump}`);
    }
    return r;
  } catch (e) {
    const msg = `[direction-selftest] CRASH: ${e?.message || e}`;
    if (typeof log === 'function') log('error', msg); else console.error(msg);
    return { pass: false, ranAt: Date.now(), version: 'v21.23.4', checks: [{ name: 'selftest-crash', ok: false, detail: String(e?.message || e) }] };
  }
}
