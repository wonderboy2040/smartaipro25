// ============================================================
// server/ai/tradingCosts.js — v11.1 GAP 3: REAL TRANSACTION-COST MODEL
// ------------------------------------------------------------
// THE GAP (India Intraday deep-analysis plan): every paper P&L number
// was GROSS — raw price move × qty. A real Indian intraday round trip
// pays brokerage + STT + exchange transaction charges + SEBI turnover
// fee + GST + stamp duty. These are small per trade but COMPOUND
// heavily for high-frequency intraday strategies: a healthy-looking
// paper win-rate can be net-negative after costs, and there was no
// way to see that. Every closed paper trade now stores BOTH:
//
//   grossPnl (the old number, semantics unchanged)
//   costs    (this module's round-trip estimate)
//   netPnl   (= gross − costs)  ← the displayed headline
//
// Statutory defaults (current published schedules, Oct-2024 levels;
// EVERY number env-overridable so the user can pin their own broker):
//   EQUITY INTRADAY : STT 0.025% sell · NSE txn 0.00297% both sides
//                     · SEBI 0.0001% both · stamp 0.003% buy
//   EQUITY FUTURES  : STT 0.02% sell · txn 0.00173% both
//                     · SEBI 0.0001% both · stamp 0.002% buy
//   OPTIONS         : STT 0.1% sell premium · txn 0.03503% premium both
//                     · SEBI 0.0001% premium both · stamp 0.003% buy premium
//   GST 18% on (brokerage + exchange txn + SEBI) in all India cases.
//   CRYPTO (CoinDCX-style): no STT/GST — an approximate taker fee % per
//   side (default 0.05%) so the net number stays honest there too.
//
// Brokerage: flat ₹/executed-order (default 20, Zerodha-style) OR
// percent-of-turnover (default 0.03%) — AI_TC_BROKERAGE_MODE switches.
// A trade that books in 2 parts = 3 executed orders (1 buy + 2 sells).
//
// All functions PURE. Honesty rules: unknown instrument → null
// breakdown fields, never a made-up fee; amounts rounded to 2dp at
// the OUTSIDE edge only (components keep full precision internally).
// ============================================================

const GST_PCT = 0.18; // 18% on (brokerage + txn + SEBI) — India

const RATES = {
  'equity-intraday': { sttSellPct: 0.025, txnPct: 0.00297, sebiPct: 0.0001, stampBuyPct: 0.003 },
  'equity-futures': { sttSellPct: 0.02, txnPct: 0.00173, sebiPct: 0.0001, stampBuyPct: 0.002 },
  options: { sttSellPct: 0.10, txnPct: 0.03503, sebiPct: 0.0001, stampBuyPct: 0.003 },
};

/** Env-overrideable numeric rate (returns the default when unset/garbage). */
function _rate(key, dflt) {
  const v = parseFloat(process.env[key]);
  return Number.isFinite(v) && v >= 0 ? v : dflt;
}

export function tradingCostsConfig() {
  return {
    brokerageMode: brokerageMode(),
    brokerageFlat: brokerageFlat(),
    brokeragePct: brokeragePct(),
    cryptoTakerPct: cryptoTakerPct(),
    gstPct: GST_PCT,
    rates: {
      'equity-intraday': _ratesFor('equity-intraday'),
      'equity-futures': _ratesFor('equity-futures'),
      options: _ratesFor('options'),
    },
    note: 'Round-trip cost model: brokerage (flat ₹/order or %) + STT (sell side) + exchange txn + SEBI + GST 18% (on brokerage+txn+SEBI) + stamp (buy side). Defaults = current published India schedules; env-overridable to match your broker.',
  };
}

function brokerageMode() {
  const m = String(process.env.AI_TC_BROKERAGE_MODE || '').trim().toLowerCase();
  return m === 'percent' ? 'percent' : 'flat';
}
function brokerageFlat() { return _rate('AI_TC_BROKERAGE_FLAT', 20); }
function brokeragePct() { return _rate('AI_TC_BROKERAGE_PCT', 0.03); }
function cryptoTakerPct() { return _rate('AI_TC_CRYPTO_FEE_PCT', 0.05); }

function _ratesFor(instrumentType) {
  const base = RATES[instrumentType];
  if (!base) return null;
  return {
    sttSellPct: _rate(`AI_TC_STT_${instrumentType.replace(/-/g, '_').toUpperCase()}`, base.sttSellPct),
    txnPct: _rate(`AI_TC_TXN_${instrumentType.replace(/-/g, '_').toUpperCase()}`, base.txnPct),
    sebiPct: _rate(`AI_TC_SEBI_${instrumentType.replace(/-/g, '_').toUpperCase()}`, base.sebiPct),
    stampBuyPct: _rate(`AI_TC_STAMP_${instrumentType.replace(/-/g, '_').toUpperCase()}`, base.stampBuyPct),
  };
}

const _r2 = (v) => Number.isFinite(v) ? Math.round(v * 100) / 100 : null;

/**
 * Brokerage for the executed orders on the given TOTAL turnover.
 * Flat mode charges per ORDER (partial bookings = more sell orders);
 * percent mode is turnover-based (a split sell books the same total
 * sell value, so order count doesn't change it).
 */
function brokerageFor(orders, turnover) {
  if (brokerageMode() === 'percent') {
    return turnover > 0 ? turnover * (brokeragePct() / 100) : 0;
  }
  return (orders > 0 ? orders : 0) * brokerageFlat();
}

/**
 * PURE: the FULL round-trip cost of one trade.
 *
 * @param {object} a
 *   qty            units traded (shares; LOTS for options — see mult)
 *   entryPrice     buy price per unit
 *   exitPrice      sell price per unit (per-part sells aggregate the
 *                  same turnover, so callers can pass the avg exit)
 *   instrumentType 'equity-intraday' | 'equity-futures' | 'options' | 'crypto'
 *   mult           P&L multiplier (options: lotSize — qty is lots;
 *                  everything else 1)
 *   sellOrders     executed sell orders (default 1; a T1+T2 two-part
 *                  booking is 2)
 *   buyOrders      executed buy orders (default 1)
 * @returns breakdown + total, or null when inputs don't sanity-check
 */
export function estimateRoundTripCost({ qty, entryPrice, exitPrice, instrumentType, mult = 1, sellOrders = 1, buyOrders = 1 }) {
  const q = Number(qty), ep = Number(entryPrice), xp = Number(exitPrice), m = Number(mult);
  if (!(q > 0) || !(ep > 0) || !(xp > 0) || !(m >= 1)) return null;
  const type = String(instrumentType || '').toLowerCase();
  const orders = Math.max(0, Math.floor(Number(sellOrders) || 0)) + Math.max(0, Math.floor(Number(buyOrders) || 0));
  const buyTurnover = q * ep * m;
  const sellTurnover = q * xp * m;

  if (type === 'crypto') {
    // CoinDCX-style: approximate taker fee per side on turnover. No
    // STT/GST/SEBI/stamp — those are India-equity instruments only.
    const feePct = cryptoTakerPct();
    const fee = (buyTurnover + sellTurnover) * (feePct / 100);
    return {
      instrumentType: type,
      buyTurnover: _r2(buyTurnover), sellTurnover: _r2(sellTurnover),
      orders: 0,
      brokerage: 0, stt: 0, exchangeTxn: 0, sebi: 0, gst: 0, stampDuty: 0,
      takerFee: _r2(fee),
      total: _r2(fee),
      note: `approx taker fee ${feePct}% per side (CoinDCX-style) — no STT/GST on crypto`,
    };
  }

  const rates = _ratesFor(type);
  if (!rates) return null;

  const brokerage = brokerageFor(orders, buyTurnover + sellTurnover);
  const stt = sellTurnover * (rates.sttSellPct / 100);
  const exchangeTxn = (buyTurnover + sellTurnover) * (rates.txnPct / 100);
  const sebi = (buyTurnover + sellTurnover) * (rates.sebiPct / 100);
  const gst = (brokerage + exchangeTxn + sebi) * GST_PCT;
  const stampDuty = buyTurnover * (rates.stampBuyPct / 100);
  const total = brokerage + stt + exchangeTxn + sebi + gst + stampDuty;

  return {
    instrumentType: type,
    buyTurnover: _r2(buyTurnover), sellTurnover: _r2(sellTurnover),
    orders,
    brokerage: _r2(brokerage),
    stt: _r2(stt),
    exchangeTxn: _r2(exchangeTxn),
    sebi: _r2(sebi),
    gst: _r2(gst),
    stampDuty: _r2(stampDuty),
    total: _r2(total),
    rates,
    note: `brokerage ${brokerageMode() === 'flat' ? `₹${brokerageFlat()}/order × ${orders}` : `${brokeragePct()}%/order`} · STT ${rates.sttSellPct}% sell · txn ${rates.txnPct}% both · SEBI ${rates.sebiPct}% both · stamp ${rates.stampBuyPct}% buy · GST 18%`,
  };
}

/** Instrument branch for a paper-trade-shaped object. */
export function instrumentTypeOfTrade(t) {
  if (!t || typeof t !== 'object') return null;
  if (String(t.assetKind || '').toUpperCase() === 'OPTION') return 'options';
  const m = String(t.market || '').toUpperCase();
  // v21.17.0 DEEP RECHECK FIX: FUTURES (USDT perp) aur GLOBALFUTURES (USDC
  // perp) paper trades bhi crypto taker-fee domain me hain — pehle ye
  // 'equity-intraday' me fall-through hote the (₹20/order flat brokerage +
  // Indian STT/SEBI/stamp USDT units me lag raha tha).
  if (m === 'CRYPTO' || m === 'FUTURES' || m === 'GLOBALFUTURES') return 'crypto';
  return 'equity-intraday';
}

/**
 * PURE: full cost picture for a paper trade from its own shape.
 *   buy turnover  = qty × entry × mult        (the one buy order)
 *   sell turnover = Σ parts qty × exitPrice × mult
 *   orders        = 1 buy + parts.length sells
 * Works for OPEN trades too (parts may be empty → buy side only) —
 * that's the honest "costs already locked in" number. Returns null
 * when the trade shape doesn't sanity-check.
 */
export function costsForPaperTrade(t) {
  const type = instrumentTypeOfTrade(t);
  if (!type) return null;
  const q = Number(t?.qty), ep = Number(t?.entry);
  if (!(q > 0) || !(ep > 0)) return null;
  const m = t?.assetKind === 'OPTION' ? (Number(t.lotSize) || 1) : 1;
  const parts = Array.isArray(t?.parts) ? t.parts : [];
  const validParts = parts.filter(p => Number(p?.qty) > 0 && Number(p?.exitPrice) > 0);
  if (validParts.length === 0) {
    // OPEN trade: entry side costs + one buy order are already spent.
    const buyTurnover = q * ep * m;
    if (type === 'crypto') {
      const fee = buyTurnover * (cryptoTakerPct() / 100);
      return { ..._openCostsBase(type, buyTurnover), takerFee: _r2(fee), total: _r2(fee) };
    }
    const rates = _ratesFor(type);
    if (!rates) return null;
    const brokerage = brokerageFor(1, buyTurnover);
    const txn = buyTurnover * (rates.txnPct / 100);
    const sebi = buyTurnover * (rates.sebiPct / 100);
    const gst = (brokerage + txn + sebi) * GST_PCT;
    const stamp = buyTurnover * (rates.stampBuyPct / 100);
    return {
      ..._openCostsBase(type, buyTurnover),
      brokerage: _r2(brokerage), stt: 0, exchangeTxn: _r2(txn), sebi: _r2(sebi),
      gst: _r2(gst), stampDuty: _r2(stamp),
      total: _r2(brokerage + txn + sebi + gst + stamp),
      note: 'entry-side costs so far (position still open)',
    };
  }
  // Aggregate the parts into ONE estimateRoundTripCost call: qty stays
  // the full position, exit price = turnover-weighted average PRICE PER
  // UNIT of the parts (identical sell turnover), sellOrders = number of
  // parts. NB: sellTurnover already carries the multiplier — divide it
  // back out for the per-unit average exit price (double-applying mult
  // would inflate every turnover-based fee by lotSize).
  const sellTurnover = validParts.reduce((s, p) => s + Number(p.qty) * Number(p.exitPrice) * m, 0);
  const soldQty = validParts.reduce((s, p) => s + Number(p.qty), 0);
  const avgExit = sellTurnover / (soldQty * m);
  // remaining (still-open) qty: approximate its exit at lastPrice so
  // the number is complete-but-labelled (only for PARTIAL trades).
  const remaining = Math.max(0, q - soldQty);
  const out = estimateRoundTripCost({
    qty: soldQty, entryPrice: ep, exitPrice: avgExit,
    instrumentType: type, mult: m,
    sellOrders: validParts.length, buyOrders: 1,
  });
  if (!out) return null;
  // v20.9.1 [M]: remaining entry-side costs HAMESHA count hote hain —
  // pehle `lastPrice > 0` gate tha, jabki ye costs entry pe PEHLE SE hi
  // spent hain (lastPrice sirf exit-side ESTIMATE ke kaam ka hota, jo
  // yahan compute hi nahi hota). lastPrice-less trade shapes ka net P&L
  // systematically flattered hota tha.
  if (remaining > 0) {
    // remaining entry-side costs are already counted in the OPEN branch
    // shape? No — estimateRoundTripCost(qty=soldQty) charged only the
    // sold portion's buy side. The remaining portion's buy side is real
    // and already spent: add it (txn + sebi + stamp on remaining buy
    // turnover; brokerage already counted the 1 buy order).
    if (type !== 'crypto') {
      const rates = _ratesFor(type);
      const remBuy = remaining * ep * m;
      out.exchangeTxn = _r2((out.exchangeTxn || 0) + remBuy * (rates.txnPct / 100));
      out.sebi = _r2((out.sebi || 0) + remBuy * (rates.sebiPct / 100));
      out.stampDuty = _r2((out.stampDuty || 0) + remBuy * (rates.stampBuyPct / 100));
      out.gst = _r2((out.gst || 0) + remBuy * ((rates.txnPct + rates.sebiPct) / 100) * GST_PCT);
      out.buyTurnover = _r2((out.buyTurnover || 0) + remBuy);
      out.total = _r2((out.total || 0) + remBuy * ((rates.txnPct + rates.sebiPct) / 100) * (1 + GST_PCT) + remBuy * (rates.stampBuyPct / 100));
    } else {
      const remFee = remaining * ep * m * (cryptoTakerPct() / 100);
      out.takerFee = _r2((out.takerFee || 0) + remFee);
      out.total = _r2((out.total || 0) + remFee);
    }
    out.note = `partial close: sold ${soldQty}/${q} units; remaining ${remaining} ke entry-side costs included, exit cost abhi pending`;
  }
  return out;
}

function _openCostsBase(type, buyTurnover) {
  return {
    instrumentType: type,
    buyTurnover: _r2(buyTurnover), sellTurnover: 0, orders: 1,
  };
}

/**
 * Convenience: net P&L of a paper trade (gross minus costs). PURE.
 * Returns { grossPnl, costs, netPnl, breakdown } or null when the
 * trade shape is unusable. grossPnl = realizedPnl + unrealizedPnl
 * exactly as the desk has always computed it.
 */
export function netPnlOfTrade(t) {
  const gross = Number(t?.realizedPnl ?? 0) + Number(t?.unrealizedPnl ?? 0);
  if (!Number.isFinite(gross)) return null;
  const breakdown = costsForPaperTrade(t);
  if (!breakdown) return null;
  return {
    grossPnl: _r2(gross),
    costs: breakdown.total ?? 0,
    netPnl: _r2(gross - (breakdown.total ?? 0)),
    breakdown,
  };
}
