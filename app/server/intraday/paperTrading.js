// ============================================================
// intraday/paperTrading — virtual-trade simulator engine
// ------------------------------------------------------------
// Users open VIRTUAL positions from any scanner signal (or manual
// levels) with zero real money. The watcher in stream.js evaluates
// them against live prices and auto-manages them exactly like the
// site's published execution discipline:
//   • T1 hit  → book 50%, trail remaining to breakeven (entry)
//   • T2 hit  → close remaining (full target run)
//   • SL hit  → close remaining at stop
//   • 15:10 IST → hard square-off of whatever is left
// Manual close anytime at live LTP. All trades persist to
// server/data/paper-trades.json with realized + unrealized P&L.
// ============================================================
import { loadJSON, saveJSON } from './store.js';
import { istDayKey, istMinutes, dayKeyFor } from './time.js';
import { isCryptoSymbolBase } from './engine.js';
import { recordTradeClose } from './journal.js';
import { restoreBackup, backupConfigured } from './backup.js';
// v12.7 (recheck R3-HIGH-1): paper-trade state rides the ENCRYPTED durable
// channel (AES-256-GCM envelope → GitHub backup branch). The plaintext
// scheduleBackup push put symbols/qty/entries/P&L on a public repo branch
// while every other state file already rode durable.js's promise that "a
// public repo backup branch can never leak keys or holdings".
import { durablePut, decryptJSON } from '../mcp/durable.js';
import { pRound, pRoundLadder, pricePrecision } from '../ai/lib/priceRound.js';
import { bsPrice, yearsToExpiry } from '../ai/lib/blackScholes.js';
// v11.1 GAP 3 — real transaction costs (brokerage/STT/txn/GST/SEBI/stamp)
import { costsForPaperTrade } from '../ai/tradingCosts.js';
// v11.1 GAP 2 — adverse-circuit risk for open equity positions
import { adverseCircuitRisk } from '../ai/circuitGuard.js';

const FILE = 'paper-trades.json';
const MAX_TRADES = 500;
const PAPER_SQOFF_MIN = 15 * 60 + 10; // 15:10 IST hard square-off (NSE only)
// v21.0.2: EXPIRY-DAY EARLY SQUARE-OFF — option cards advertise
// "expiry-day 14:30" (optionsDesk exitPlan.timeExit), par engine flat
// 15:10 chalata tha — expiry-day pe option BUYER 40 extra min theta
// burn karta tha. Ab expiry wale OPTION trades aaj hi expire ho rahe
// hon to 14:30 pe square-off (PAPER_OPT_EXPIRY_SQOFF_MIN).
const PAPER_OPT_EXPIRY_SQOFF_MIN = 14 * 60 + 30; // 14:30 IST expiry-day
const _todayISTDateStr = () => new Date(Date.now() + (5.5 * 3600_000)).toISOString().slice(0, 10);
const _sqoffMinFor = (t) => (String(t?.assetKind || '').toUpperCase() === 'OPTION'
  && String(t?.expiry || '') === _todayISTDateStr())
  ? PAPER_OPT_EXPIRY_SQOFF_MIN
  : PAPER_SQOFF_MIN;

// Per-trade market: CRYPTO trades 24/7 with fractional units (0.0027 BTC);
// INDIA stays whole-share with the 15:10 IST square-off.
const _marketOfTrade = (t) => {
  const m = String(t?.market || '').toUpperCase();
  if (m === 'CRYPTO') return 'CRYPTO';
  // v21.17.0 UPGRADE: USDT-perp (FUTURES) aur USDC-perp (GLOBALFUTURES)
  // paper trades — pehle ye dono 'INDIA' me collapse ho jate the (Groww
  // quote routing / INR P&L = galat units, galat SL trigger).
  if (m === 'FUTURES') return 'FUTURES';
  if (m === 'GLOBALFUTURES') return 'GLOBALFUTURES';
  if (m === 'INDIA') return 'INDIA';
  return isCryptoSymbolBase(t?.symbol) ? 'CRYPTO' : 'INDIA';
};
// v21.17.0: 24/7 USD-domain desks (perps) — fractional qty, UTC day, no EOD.
const _isUsdDesk = (m) => m === 'CRYPTO' || m === 'FUTURES' || m === 'GLOBALFUTURES';

// Fractional-safe qty normalizer: INDIA → integer shares; CRYPTO → 4dp units.
// v21.17.0 DEEP AUDIT: trade ladder precision helper — jab ek ≥$1 coin
// (jaise DOT $1.09, XRP $1.36) par tight SL/T1 ladder 4-decimals me ho
// (`1.09 · 1.0949 · 1.0851`), to plain `pRound()` (2dp for ≥1) levels ko
// `1.09 · 1.09 · 1.09` me collapse kar deta tha (entry===SL → instant
// false SL_HIT). `pRoundLadder` open/restore pe distinct precision rakhta
// hai aur `_roundForTrade` live quote / exitPrice / MFE / MAE ko usi
// precision par round karta hai.
function _decPlaces(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 2;
  const s = String(Number(n.toFixed(8)));
  const dot = s.indexOf('.');
  return dot >= 0 ? s.length - dot - 1 : 0;
}
function _tradePrecision(t) {
  if (Number.isInteger(t?.precision) && t.precision >= 2) return t.precision;
  return Math.max(2, _decPlaces(t?.entry), _decPlaces(t?.stopLoss), _decPlaces(t?.target1), _decPlaces(t?.target2));
}
function _roundForTrade(v, t) {
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  const dp = Math.min(12, Math.max(pricePrecision(n), _tradePrecision(t)));
  return Number(n.toFixed(dp));
}

function _normQty(raw, market) {
  const n = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(n) || n <= 0) return 0;
  // v21.17.0: perp desks (USDT/USDC) bhi fractional-qty hain (4dp) —
  // pehle unke liye Math.floor chal raha tha (BTC 0.0038 → 0 qty reject).
  if (_isUsdDesk(String(market || '').toUpperCase())) return +n.toFixed(4);
  return Math.floor(n);
}

let _state = loadJSON(FILE, { trades: [], nextId: 1, dayKey: '' });
let _saveTimer = null;

function _persist() {
  if (_saveTimer) return;
  _saveTimer = setTimeout(() => {
    _saveTimer = null;
    saveJSON(FILE, _state);
    // DURABLE HISTORY: Render's free plan wipes server/data/ on every
    // restart — mirror the state (ENCRYPTED, v12.7) to the GitHub backup
    // branch so the paper-trading track record survives (see backup.js
    // + mcp/durable.js).
    try { durablePut(FILE, _state); } catch { /* backup optional */ }
  }, 1000);
  if (typeof _saveTimer.unref === 'function') _saveTimer.unref();
}

/** v9.1: synchronous flush for graceful shutdown — the 1s debounce loses
 *  the very last state change (an open/close, a T1 partial book) if the
 *  process dies inside the window (deploy/restart races).
 *  v12.7 (recheck R3-#4): the flush ALSO re-arms the durable push so the
 *  REMOTE copy rides index.js's flushBackupNow() in the same shutdown. */
export function flushPaperState() {
  if (_saveTimer) { clearTimeout(_saveTimer); _saveTimer = null; }
  saveJSON(FILE, _state);
  try { durablePut(FILE, _state); } catch { /* backup optional */ }
}

function _validateSym(sym) {
  // v21.0.3: 15 → 20 chars — BANKNIFTY51000CE (16) jaise F&O contract
  // ids ke liye headroom (BSE equities 10 + .NS bhi fit rehte hain).
  return typeof sym === 'string' && /^[A-Z0-9&-]{2,20}$/.test(sym.trim().toUpperCase());
}

/** v21.0.3 — defensive expiry normalization. Live NSE chain pehle DD-Mmm-YYYY
 *  bhejta tha (ab data.js source par ISO karta hai); agar kabhi koi layer
 *  raw format phir se leak kare to openPaperTrade usse ISO bana lega, reject
 *  nahi karega. ISO passthrough, unparseable → null. */
function _normExpiryISO(v) {
  const t = String(v || '').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return t;
  const m = t.match(/^(\d{1,2})[-\s]+([A-Za-z]{3})[-\s]+(\d{4})$/);
  if (m) {
    const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const mi = MON.findIndex(x => x.toLowerCase() === m[2].toLowerCase());
    if (mi >= 0) return `${m[3]}-${String(mi + 1).padStart(2, '0')}-${String(parseInt(m[1], 10)).padStart(2, '0')}`;
  }
  return null;
}

// ------------------------------------------------------------
// v9.5 F&O OPTION PAPER TRADES — "Nifty50 15Sep 23400 CE" cards
// can now be paper-traded through the SAME engine. An option buy is
// a premium-LONG position (BUY CE on a LONG index consensus, BUY PE
// on SHORT): the card's Entry/Target/SL are premium levels, so the
// existing LONG level-sanity (SL < E < T1 < T2) holds as-is.
//   qty      = LOTS (integer); P&L multiplies by lotSize
//   pricing  = the watcher injects a live BS-model premium quote
//              per tick (spot via Yahoo ^NSEI/^BSESN — see
//              injectOptionPaperQuotes below), so SL/T1/T2/EOD
//              auto-management + P&L work exactly like equities
// ------------------------------------------------------------
const OPTION_UNDERLYINGS = new Set(['NIFTY', 'BANKNIFTY', 'FINNIFTY', 'MIDCPNIFTY', 'NIFTYNXT50', 'SENSEX']);
const RISK_FREE = 0.069; // matches optionsDesk.js (v21.0.6 audit: aligned 0.065→0.069)

function _isOptionTrade(t) { return t?.assetKind === 'OPTION'; }

// ------------------------------------------------------------
// v21.0.6 [audit B1] — LIVE-CHAIN premium re-pricing (desk parity).
// Desk jo chain ladder dikhata hai (direct NSE / Groww mirror / BSE),
// paper exits (SL/T1/T2/BE-trail/EOD) + P&L bhi VAHI premium use
// karte hain. Pehle SL/T1 engine sirf BS-model premium pe act karta
// tha jabki desk live premium dikha raha tha — SL model pe hit ho
// sakta tha jab live chain ne chhua tak nahi (IV-crush/microstructure
// invisible). BS model ab SIRF fallback hai (chain down / contract
// row missing) — wahi pura spot+IV math neeche intact hai.
// fetchChain(underlying) → NSE-normalized chain {rows:[{strike,
// expiry, callLTP, putLTP…}], lotSize, source, via} | null — stream.js
// the real data.js ladder passes karta hai; tests fake ya omit karte
// hain (hermetic BS fallback path).
// ------------------------------------------------------------
const _chainQuoteCache = new Map(); // underlying → { chain, at }
const OPT_CHAIN_QUOTE_TTL = 30 * 1000; // watcher 5s; chain refresh 30s (desk-rate parity)

async function _chainFor(underlying, fetchChain) {
  const u = String(underlying || '').toUpperCase();
  const c = _chainQuoteCache.get(u);
  if (c && Date.now() - c.at < OPT_CHAIN_QUOTE_TTL) return c.chain;
  if (typeof fetchChain !== 'function') return c?.chain || null;
  try {
    const chain = await fetchChain(u);
    if (chain && Array.isArray(chain.rows) && chain.rows.length >= 5) {
      _chainQuoteCache.set(u, { chain, at: Date.now() });
      return chain;
    }
  } catch { /* live path down — stale-cache/BS degrade */ }
  // v21.1.1 [audit C1]: stale fallback ab AGE-BOUNDED (5 min). Pehle
  // whatever-old chain serve hota tha fresh ts stamp ke saath — Groww
  // outage me SL/T1/T2/EOD exits FROZEN premiums pe evaluate hote the
  // jabki desk khud BS synthetic pe degrade chuka hota (desk aur paper
  // engine visibly disagree). 5-min se purani chain ab null return hoti
  // hai → neeche ka BS honest fallback (fresh Yahoo spot) chalta hai.
  if (c && Date.now() - c.at < 5 * 60_000) return c.chain;
  return null;
}

function _chainLtpFor(chain, t) {
  if (!chain) return null;
  const k = Number(t.strike);
  const iso = String(t.expiry || '').slice(0, 10);
  const row = (chain.rows || []).find(r => Number(r.strike) === k && String(r.expiry || '').slice(0, 10) === iso);
  if (!row) return null;
  const ltp = t.optType === 'CE' ? Number(row.callLTP) : Number(row.putLTP);
  return Number.isFinite(ltp) && ltp > 0 ? ltp : null;
}

/** v9.5 — called by the watcher tick BEFORE evaluatePaper(): for every
 * open OPTION paper trade, re-price the premium. v21.0.6 [audit B1]:
 * LIVE chain LTP first (the SAME ladder the desk displays — stream.js
 * passes the data.js fetcher); Black-Scholes (entry IV held fixed, spot
 * via Yahoo ^NSEI/^BSESN — see below) is now the honest FALLBACK when
 * the live chain is unreachable or the contract row is missing.
 * Injected into the quotes map, so evaluatePaper()/closePaperTrade()
 * need zero changes. */
export async function injectOptionPaperQuotes(quotes, fetchIndexSpot, fetchChain) {
  const open = _state.trades.filter(t => _isOptionTrade(t) && t.status !== 'CLOSED');
  if (open.length === 0) return;
  const canModel = typeof fetchIndexSpot === 'function';
  const canLive = typeof fetchChain === 'function';
  if (!canLive && !canModel) return;
  const spotCache = new Map();
  for (const t of open) {
    try {
      // v21.0.6: LIVE chain premium FIRST — desk parity (exits + P&L
      // wahi premium dekhte hain jo card/chain pe dikhta hai).
      const live = _chainLtpFor(await _chainFor(t.underlying, fetchChain), t);
      if (live != null) {
        quotes[t.symbol] = { price: pRound(live), change: 0, ts: Date.now() };
        continue;
      }
      if (!canModel) continue;
      if (!spotCache.has(t.underlying)) {
        const q = await fetchIndexSpot(t.underlying);   // {price} | null
        if (q?.price > 0) spotCache.set(t.underlying, q.price);
      }
      const spot = spotCache.get(t.underlying);
      if (!(spot > 0)) continue;
      // T: expiry 15:30 IST; clamp to [0, ∞). T=0 → intrinsic value.
      const T = Math.max(0, yearsToExpiry(`${t.expiry}T15:30:00+05:30`));
      const intrinsic = t.optType === 'CE'
        ? Math.max(0, spot - t.strike)
        : Math.max(0, t.strike - spot);
      // t.iv is stored in PERCENT (e.g. 13.2) — bsPrice wants the decimal
      // sigma (0.132), clamped to the same [6%, 60%] band as the card desk.
      const sigma = Math.min(0.60, Math.max(0.06, (Number(t.iv) || 13) / 100));
      const prem = T > 0
        ? Math.max(0.05, bsPrice(spot, t.strike, T, RISK_FREE, sigma, t.optType))
        : intrinsic;
      quotes[t.symbol] = { price: +prem.toFixed(2), change: 0, ts: Date.now() };
    } catch { /* skip this trade this tick */ }
  }
}

/** Underlying index symbols the watcher must fetch when OPTION paper
 * trades are open (quotes for the CONTRACT itself don't exist on any
 * equity feed — the premium is model-priced from the index spot). */
export function optionUnderlyingsForWatcher() {
  return [...new Set(
    _state.trades
      .filter(t => _isOptionTrade(t) && t.status !== 'CLOSED')
      .map(t => String(t.underlying || '').toUpperCase())
      .filter(u => OPTION_UNDERLYINGS.has(u))
  )];
}

export function openPaperTrade(input) {
  const {
    symbol, direction, entry, qty,
    stopLoss, target1, target2, market,
    // v9.5 F&O option fields (optional):
    assetKind, underlying, strike, optType, expiry, iv, lotSize, label,
  } = input || {};

  if (!_validateSym(symbol)) return { error: 'Invalid symbol format.' };
  const sym = symbol.trim().toUpperCase();
  const isOption = String(assetKind || '').toUpperCase() === 'OPTION';
  // v21.0.3: expiry ko pehle ISO me normalize karo (DD-Mmm-YYYY /
  // DD Mmm YYYY accept) — validation ISO hi rehti hai, magar live-chain
  // formats ab reject nahi honge ("paper trade show nahi hua" fix).
  const expiryISO = isOption ? _normExpiryISO(expiry) : null;
  if (isOption) {
    const u = String(underlying || '').trim().toUpperCase();
    if (!OPTION_UNDERLYINGS.has(u)) {
      return { error: `Option paper trade: unsupported underlying "${u || '—'}" (supported: NIFTY, SENSEX, BANKNIFTY, FINNIFTY, MIDCPNIFTY, NIFTYNXT50).` };
    }
    const k = Number(strike);
    if (!(Number.isFinite(k) && k > 0)) return { error: 'Option paper trade: valid strike required.' };
    const ot = String(optType || '').toUpperCase();
    if (ot !== 'CE' && ot !== 'PE') return { error: 'Option paper trade: optType must be CE or PE.' };
    // v21.0.3: expiryISO normalize ho chuka hai (ISO/DD-Mmm-YYYY dono
    // accept); yahan sirf valid-ISO check rehta hai.
    if (!expiryISO) return { error: 'Option paper trade: expiry (YYYY-MM-DD) required.' };
    const ivn = Number(iv);
    if (!(Number.isFinite(ivn) && ivn > 0)) return { error: 'Option paper trade: IV required for premium re-pricing.' };
    const ls = Number(lotSize);
    if (!(Number.isFinite(ls) && ls >= 1 && ls <= 10000)) return { error: 'Option paper trade: lotSize (1..10000) required.' };
    // Option BUY = premium LONG, always. A SHORT/PE-consensus card is
    // still a premium-LONG position — the direction arg must agree.
    if (String(direction || '').toUpperCase() !== 'LONG') {
      return { error: 'Option paper trades are premium-BUY (LONG). Pass direction "LONG".' };
    }
  }
  // v21.17.0 FIX (test-caught): perp desks (FUTURES USDT / GLOBALFUTURES
  // USDC) ab first-class hain — pehle ye whitelist me nahi the, isliye ek
  // `market:'FUTURES'` paper trade CHUPKE se CRYPTO (INR) desk par land
  // karta tha → USDT levels INR quotes se evaluate hote (cross-domain
  // false SL). Ab: whitelist + per-desk validation honest hai.
  const MKT_OK = new Set(['INDIA', 'CRYPTO', 'FUTURES', 'GLOBALFUTURES']);
  const mkt = MKT_OK.has(String(market || '').toUpperCase())
    ? String(market).toUpperCase()
    : (isCryptoSymbolBase(sym) ? 'CRYPTO' : 'INDIA');
  if (isOption && mkt !== 'INDIA') return { error: 'Option paper trades are INDIA-market only.' };
  const dir = direction === 'SHORT' ? 'SHORT' : 'LONG';
  const n = (v) => (typeof v === 'number' && isFinite(v) && v > 0) ? v : null;
  const e = n(entry), sl = n(stopLoss);
  const t1 = n(target1), t2 = n(target2);
  const q = _normQty(n(qty) || 0, mkt);
  if (!e) return { error: 'Valid entry price required.' };
  // v21.17.0: USD-perp desks fractional hain (BTC 0.05) — min 0.0001, 4dp.
  if (!q || q < (_isUsdDesk(mkt) ? 0.0001 : 1) || q > 100000) {
    return { error: _isUsdDesk(mkt)
      ? 'Qty must be ≥0.0001 (max 100000, 4dp).'
      : 'Qty must be 1..100000.' };
  }
  if (!sl) return { error: 'Valid stop-loss required.' };
  // Level sanity — direction-consistent ordering.
  if (dir === 'LONG' && (sl >= e || (t1 && t1 <= e) || (t2 && t2 <= e))) {
    return { error: 'LONG levels must satisfy SL < entry < T1 < T2.' };
  }
  if (dir === 'SHORT' && (sl <= e || (t1 && t1 >= e) || (t2 && t2 >= e))) {
    return { error: 'SHORT levels must satisfy SL > entry > T1 > T2.' };
  }
  // Risk guard: max 1 lakh units / trade and max 10 concurrent open trades.
  const today = dayKeyFor(mkt);
  if (_state.dayKey !== today) _state.dayKey = today;
  const openNow = _state.trades.filter(t => t.status === 'OPEN' || t.status === 'PARTIAL');
  if (openNow.length >= 10) return { error: 'Max 10 open paper trades.' };
  if (openNow.some(t => t.symbol === sym && t.direction === dir && _marketOfTrade(t) === mkt)) {
    return { error: `Paper trade already open for ${sym} ${dir}.` };
  }

  const trade = {
    id: _state.nextId++,
    symbol: sym, market: mkt, direction: dir,
    // v21.17.0 AUDIT: kis raaste se khula — 'ui' (manual button) |
    // 'mtf-auto' (MTF Dual board auto-link) | 'agent' | 'api'. Board auto
    // entries ka poora trail (kaun-sa signal, kitna score) audit ke liye.
    source: String(input?.source || 'ui').slice(0, 20),
    leverage: Number(input?.leverage) > 0 ? Number(input.leverage) : null,
    feeBreakevenPrice: Number(input?.feeBreakevenPrice) > 0 ? Number(input.feeBreakevenPrice) : null,
    sourceMeta: (input?.sourceMeta && typeof input.sourceMeta === 'object') ? {
      score: Number(input.sourceMeta.score) || null,
      tier: String(input.sourceMeta.tier || '').slice(0, 10) || null,
      mode: String(input.sourceMeta.mode || '').slice(0, 12) || null,
      holdMin: Number(input.sourceMeta.holdMin) || null,
      superSymbol: String(input.sourceMeta.superSymbol || '').slice(0, 20) || null,
      leverage: Number(input.sourceMeta.leverage) || null,
      walletINR: Number(input.sourceMeta.walletINR) || null,
      feeBreakevenPrice: Number(input.sourceMeta.feeBreakevenPrice) || null,
    } : null,
    ...(() => {
      const tList = [t1, t2].filter(x => x != null && x > 0);
      const lad = pRoundLadder({ side: dir, entry: e, stopLoss: sl, targets: tList });
      return {
        entry: lad.entry,
        stopLoss: lad.stopLoss,
        target1: t1 ? lad.targets[0] : null,
        target2: t2 ? lad.targets[t1 ? 1 : 0] : null,
        precision: lad.precision,
        lastPrice: lad.entry,
      };
    })(),
    qty: q,
    remainingQty: q,
    t1Hit: false,
    status: 'OPEN',           // OPEN | PARTIAL | CLOSED
    openedAt: Date.now(),
    closedAt: null, closeReason: null,
    realizedPnl: 0,
    unrealizedPnl: 0,
    parts: [],                // [{qty, exitPrice, ts, reason}]
    dayKey: today,
    capital: +(q * e).toFixed(2), // notionally deployed
  };
  if (isOption) {
    // v9.5 F&O: contract identity + re-pricing inputs + lot multiplier.
    trade.assetKind = 'OPTION';
    trade.underlying = String(underlying).trim().toUpperCase();
    trade.strike = Number(strike);
    trade.optType = String(optType).toUpperCase();
    trade.expiry = expiryISO; // v21.0.3 normalized ISO (10 chars)
    trade.iv = Number(iv);                 // entry IV, held fixed
    trade.lotSize = Number(lotSize);       // P&L multiplier (qty = lots)
    trade.label = String(label || '').slice(0, 40) || null; // "Nifty50 15Sep 23400 CE"
    trade.capital = +(q * trade.lotSize * e).toFixed(2);     // 1 lot premium × lots
  }
  _state.trades.push(trade);
  if (_state.trades.length > MAX_TRADES) {
    _state.trades = _state.trades.slice(_state.trades.length - MAX_TRADES);
  }
  _persist();
  return { ok: true, trade };
}

function _closePart(trade, qty, price, reason) {
  const use = Math.min(qty, trade.remainingQty);
  if (use <= 0) return;
  const sign = trade.direction === 'LONG' ? 1 : -1;
  const mult = _isOptionTrade(trade) ? (trade.lotSize || 1) : 1; // v9.5: lots × lotSize
  trade.remainingQty -= use;
  trade.realizedPnl += use * (price - trade.entry) * sign * mult;
  trade.parts.push({ qty: use, exitPrice: _roundForTrade(price, trade), ts: Date.now(), reason });
  // v11.1 GAP 3: re-annotate gross/costs/net on every part close — the
  // numbers are derived deterministically from (qty, entry, parts), so
  // recomputing is idempotent and works for restored/legacy trades too.
  try {
    const costs = costsForPaperTrade(trade);
    if (costs && costs.total != null) {
      trade.grossPnl = +(+trade.realizedPnl).toFixed(2);
      trade.costs = +(costs.total).toFixed(2);
      trade.netPnl = +(trade.realizedPnl - costs.total).toFixed(2);
      trade.costsBreakdown = {
        instrumentType: costs.instrumentType,
        brokerage: costs.brokerage ?? 0, stt: costs.stt ?? 0,
        exchangeTxn: costs.exchangeTxn ?? 0, sebi: costs.sebi ?? 0,
        gst: costs.gst ?? 0, stampDuty: costs.stampDuty ?? 0,
        takerFee: costs.takerFee ?? null, orders: costs.orders ?? null,
        ...(costs.note ? { note: costs.note } : {}),
      };
    }
  } catch { /* costs optional — gross stays the honest fallback */ }
  if (trade.remainingQty <= 0) {
    trade.status = 'CLOSED';
    trade.closedAt = Date.now();
    trade.closeReason = reason;
    trade.unrealizedPnl = 0;
    // AUTO TRADE JOURNAL — every close path (SL/T1/T2/trail/EOD/
    // manual/stale) lands here exactly once. Pure data capture;
    // the AI review runs later (EOD cron / on-demand endpoint).
    try { recordTradeClose(trade); } catch { /* journal optional */ }
  }
}

// ------------------------------------------------------------
// Live evaluation — called by the watcher with fresh quotes.
// ------------------------------------------------------------
// v21.17.0 QUOTE DOMAIN GUARD — per-desk quote resolution. India/CRYPTO
// apne plain key pe evaluate hote hain; USD-perp desks (FUTURES/
// GLOBALFUTURES) SIRF qualified key (`FUTURES|BTC`) ya non-INR-src plain
// key use karte hain — warna CRYPTO bucket ki INR quote se USDT trade ka
// SL trigger ho jata (cross-domain false fill).
function _quoteFor(t, quotes, mkt, byMarket = null) {
  const qk = byMarket?.[`${mkt}|${t.symbol}`] || quotes?.[`${mkt}|${t.symbol}`];
  if (qk?.price > 0) return qk;
  const plain = quotes?.[t.symbol];
  if (mkt === 'CRYPTO' || mkt === 'INDIA') return plain?.price > 0 ? plain : null;
  // USD desks: plain key tabhi jab src INR-denominated na ho
  if (plain?.price > 0 && !/inr/i.test(String(plain.src || ''))) return plain;
  return null;
}

export function evaluatePaper(quotes, events = [], byMarket = null) {
  // v21.16.0 HARDEN (deep recheck): events array optional karo — exported
  // API ko bina events ke call karna pehle TypeError se crash karta tha
  // (live E2E me pakda). Real caller (intraday/stream.js) events deta hai;
  // ye default sirf API robustness hai, behavior unchanged.
  const m = istMinutes();
  let changed = false;

  for (const t of _state.trades) {
    if (t.status === 'CLOSED') continue;
    const mkt = _marketOfTrade(t);
    // v18.9 DAY-ROLLOVER GUARD — the boot/restore path had the stale-day
    // check but the PER-TICK loop did not: if the quote feed stayed dead
    // through the 15:10 square-off (watcher backs off when got===0) and the
    // process kept running, a non-CRYPTO trade survived into the NEXT
    // session and got auto-managed against next-day prices (two sessions
    // mixed into one P&L — the "NEVER carry intraday overnight" rule
    // broken). Mirrors trackRecord's v11.4 reconcileStale fix.
    if (!_isUsdDesk(mkt) && t.dayKey && t.dayKey !== dayKeyFor(mkt)) {
      const lastPx = Number(t.lastPrice) > 0 ? Number(t.lastPrice) : Number(t.entry);
      _closePart(t, t.remainingQty, lastPx, 'STALE_SQOFF');
      events.push({ type: 'PAPER_CLOSE', symbol: t.symbol, direction: t.direction, price: lastPx, pnl: t.realizedPnl, pnlNet: t.netPnl ?? null, note: 'Paper: stale-day square-off (feed was down at EOD, position was carried)' });
      changed = true;
      continue;
    }
    // NSE hard square-off 15:10 IST (expiry-day options: 14:30) — crypto
    // is 24/7, no EOD (it rolls at the UTC day boundary via the
    // boot/restore stale checks).
    const sqOffMin = _sqoffMinFor(t);
    const afterSqOff = !_isUsdDesk(mkt) && m >= sqOffMin;
    // v21.17.0: per-desk quote domain guard (upar _quoteFor)
    const q = _quoteFor(t, quotes, mkt, byMarket);
    const price = q?.price;
    if (price > 0) t.lastPrice = _roundForTrade(price, t);
    const p = t.lastPrice;
    if (!(p > 0)) continue;

    const isLong = t.direction === 'LONG';
    // v21.17.0 PAPER UPGRADE — MFE/MAE tracking (peak-favourable / max-
    // adverse excursion in price units) + R-multiple bookkeeping. Ye wahi
    // "exit quality" numbers hain jo manual-trade tracker dikhata hai:
    // trade ne kitna diya (MFE) vs kitna maanga (MAE) vs kitna capture
    // hua (netPnl/R). Har tick par update — zero extra fetch.
    const _risk0 = Math.abs(Number(t.entry) - Number(t.stopLoss)) || null;
    if (t.mfePrice == null || (isLong ? p > t.mfePrice : p < t.mfePrice)) t.mfePrice = _roundForTrade(p, t);
    if (t.maePrice == null || (isLong ? p < t.maePrice : p > t.maePrice)) t.maePrice = _roundForTrade(p, t);
    if (_risk0) {
      t.mfeR = +(((isLong ? (t.mfePrice - t.entry) : (t.entry - t.mfePrice)) / _risk0)).toFixed(2);
      t.maeR = +(((isLong ? (t.maePrice - t.entry) : (t.entry - t.maePrice)) / _risk0)).toFixed(2);
    }
    const hitSL = isLong ? p <= t.stopLoss : p >= t.stopLoss;
    const hitT1 = t.target1 && !t.t1Hit && (isLong ? p >= t.target1 : p <= t.target1);
    const hitT2 = t.target2 && (isLong ? p >= t.target2 : p <= t.target2);

    if (t.status === 'OPEN') {
      if (hitSL) {
        // v20.9.1 [H3]: SL gap-through fill TRADED price pe — trigger level
        // (t.stopLoss) decide karta hai KAB band hona hai; fill wahi hota hai
        // jo market order ko milega (LTP gap karke SL ke paar gaya ho to
        // worst-side price, engine ke gap-through-stop fix jaisa). Pehle
        // level pe book hota tha → violent bars pe systematically flattered
        // track-record.
        const slFill = isLong ? Math.min(p, t.stopLoss) : Math.max(p, t.stopLoss);
        _closePart(t, t.remainingQty, slFill, 'SL_HIT');
        events.push({ type: 'PAPER_CLOSE', symbol: t.symbol, direction: t.direction, price: slFill, pnl: t.realizedPnl, pnlNet: t.netPnl ?? null, note: 'Paper trade SL hit' });
        changed = true; continue;
      }
      if (hitT2) {
        _closePart(t, t.remainingQty, t.target2, 'T2_HIT');
        events.push({ type: 'PAPER_CLOSE', symbol: t.symbol, direction: t.direction, price: t.target2, pnl: t.realizedPnl, pnlNet: t.netPnl ?? null, note: 'Paper trade T2 hit' });
        changed = true; continue;
      }
      if (hitT1) {
        t.t1Hit = true;
        // Fractional-safe T1 booking: half the position (4dp for crypto).
        const half = _isUsdDesk(_marketOfTrade(t))
          ? +((t.qty / 2).toFixed(4))
          : Math.ceil(t.qty / 2);
        // v21.0.6 [audit B2]: a 1-unit position (option cards qty=1 lot)
        // SPLIT Nahi HO SAKTI — half===remaining poora trade close kar
        // deta tha, isliye advertised "T1 50% book → trail / T2" KABHI
        // run nahi hota tha (har option trade flat +0.5R pe khatam —
        // track record structurally capped). Ab: qty jo split nahi ho
        // sakti us T1 pe SIRF stopLoss ko entry (breakeven) pe le aata hai
        // — runner T2/BE tak ride karta hai, wahi discipline jo card
        // advertise karta hai. Multi-lot (qty≥2) ab bhi 50% book karta hai.
        if (half > 0 && half < t.remainingQty) {
          _closePart(t, half, t.target1, 'T1_BOOK');
          if (t.status !== 'CLOSED') t.status = 'PARTIAL';
          events.push({ type: 'PAPER_CLOSE', symbol: t.symbol, direction: t.direction, price: t.target1, pnl: t.realizedPnl, pnlNet: t.netPnl ?? null, note: 'Paper: booked 50% at T1, trail to entry' });
        } else {
          t.stopLoss = t.entry; // BE-protect the un-splittable runner
          events.push({ type: 'PAPER_T1_BE', symbol: t.symbol, direction: t.direction, price: t.target1, pnl: 0, pnlNet: null, note: 'Paper: T1 touched — 1 lot split nahi hota, SL breakeven pe shifted (runner T2/BE tak)' });
        }
        changed = true; continue;
      }
    } else if (t.status === 'PARTIAL') {
      if (hitSL) {
        // v20.9.1 [H3]: trail-stop me bhi wahi gap-through honesty.
        const slFill2 = isLong ? Math.min(p, t.stopLoss) : Math.max(p, t.stopLoss);
        _closePart(t, t.remainingQty, slFill2, 'SL_TRAIL_HIT');
        events.push({ type: 'PAPER_CLOSE', symbol: t.symbol, direction: t.direction, price: slFill2, pnl: t.realizedPnl, pnlNet: t.netPnl ?? null, note: 'Paper trade trail-stop hit' });
        changed = true; continue;
      }
      if (hitT2) {
        _closePart(t, t.remainingQty, t.target2, 'T2_HIT');
        events.push({ type: 'PAPER_CLOSE', symbol: t.symbol, direction: t.direction, price: t.target2, pnl: t.realizedPnl, pnlNet: t.netPnl ?? null, note: 'Paper trade T2 hit' });
        changed = true; continue;
      }
      const hitTrail = isLong ? p <= t.entry : p >= t.entry;
      if (hitTrail) {
        // v20.9.1 [H3]: BE-trail bhi gap-through worst-side fill pe.
        const beFill = isLong ? Math.min(p, t.entry) : Math.max(p, t.entry);
        _closePart(t, t.remainingQty, beFill, 'BE_TRAIL');
        events.push({ type: 'PAPER_CLOSE', symbol: t.symbol, direction: t.direction, price: beFill, pnl: t.realizedPnl, pnlNet: t.netPnl ?? null, note: 'Paper: breakeven trail exit' });
        changed = true; continue;
      }
    }

    if (afterSqOff && t.status !== 'CLOSED') {
      _closePart(t, t.remainingQty, p, 'EOD_SQOFF');
      events.push({ type: 'PAPER_CLOSE', symbol: t.symbol, direction: t.direction, price: p, pnl: t.realizedPnl, pnlNet: t.netPnl ?? null, note: `Paper: ${sqOffMin === PAPER_OPT_EXPIRY_SQOFF_MIN ? 'expiry-day 14:30' : '15:10'} auto square-off` });
      changed = true;
    }
  }

  // Refresh unrealized P&L for still-open trades.
  for (const t of _state.trades) {
    if (t.status === 'CLOSED') continue;
    const sign = t.direction === 'LONG' ? 1 : -1;
    const mult = _isOptionTrade(t) ? (t.lotSize || 1) : 1; // v9.5 option lots
    t.unrealizedPnl = +(t.remainingQty * (t.lastPrice - t.entry) * sign * mult).toFixed(2);
  }
  if (changed) _persist();
  return changed;
}

// ------------------------------------------------------------
// v11.1 GAP 2 — CIRCUIT-LIMIT WATCH for open equity paper positions.
// Called by the stream watcher on every tick (after evaluatePaper):
// a LONG drifting into the LOWER circuit / a SHORT into the UPPER
// circuit is approaching a state where the EXIT itself cannot fill —
// the usual "tighten the stop" playbook is useless there. Emits
// URGENT CIRCUIT_RISK events (distinct from SL-approach warnings)
// with a per-symbol 10-min cooldown. NSE equities only — crypto has
// no circuits and option premiums are not band-bound.
// ------------------------------------------------------------
const _circuitAlertAt = new Map(); // `${symbol}:${direction}` → last-alert ts
export function paperCircuitWatch(quotes, events, opts = {}) {
  const cooldownMs = Number(opts.cooldownMs) > 0 ? Number(opts.cooldownMs) : 10 * 60 * 1000;
  const now = Date.now();
  let fired = 0;
  for (const t of _state.trades) {
    if (t.status === 'CLOSED') continue;
    if (_marketOfTrade(t) !== 'INDIA') continue;
    if (_isOptionTrade(t)) continue;
    const q = quotes?.[t.symbol];
    if (!q || !(Number(q.price) > 0)) continue;
    const risk = adverseCircuitRisk({ side: t.direction }, q);
    if (!risk || !risk.adverse) continue;
    const key = `${t.symbol}:${t.direction}`;
    if (now - (_circuitAlertAt.get(key) || 0) < cooldownMs) continue;
    _circuitAlertAt.set(key, now);
    events.push({
      type: 'CIRCUIT_RISK',
      symbol: t.symbol,
      direction: t.direction,
      price: Number(q.price),
      band: risk.band,
      frozen: !!risk.frozen,
      distPct: risk.distPct,
      note: risk.note,
    });
    fired++;
  }
  return fired;
}

export function closePaperTrade(id, quotes) {
  const t = _state.trades.find(x => x.id === id && x.status !== 'CLOSED');
  if (!t) return { error: 'Open paper trade not found.' };
  const q = _quoteFor(t, quotes || {}, _marketOfTrade(t));
  const price = (q?.price > 0) ? q.price : t.lastPrice;
  if (!(price > 0)) return { error: 'No live price available — try again shortly.' };
  _closePart(t, t.remainingQty, price, 'MANUAL');
  _persist();
  return { ok: true, trade: t };
}

/** v21.23.0 ULTRA-FAST REALTIME SL TRAIL SYNC:
 *  Ratchets `t.stopLoss` on an open paper trade (by id or symbol) strictly in the
 *  favorable direction (LONG: higher SL only; SHORT: lower SL only). */
export function updatePaperTradeStopLoss(idOrSymbol, newStopLoss) {
  const sl = Number(newStopLoss);
  if (!(sl > 0)) return { ok: false, error: 'Invalid stopLoss' };
  const symUp = String(idOrSymbol || '').trim().toUpperCase();
  const t = _state.trades.find(x =>
    x.status !== 'CLOSED' && (x.id === idOrSymbol || String(x.id) === String(idOrSymbol) || String(x.symbol || '').toUpperCase() === symUp)
  );
  if (!t) return { ok: false, error: 'Open paper trade not found' };
  const isLong = t.direction === 'LONG';
  const curSl = Number(t.stopLoss) || 0;
  const rounded = _roundForTrade(sl, t);
  const improved = !(curSl > 0) || (isLong ? rounded > curSl : rounded < curSl);
  if (improved) {
    if (t.initialStopLoss == null) t.initialStopLoss = curSl;
    t.stopLoss = rounded;
    t.slTrailedAt = Date.now();
    _persist();
  }
  return { ok: true, updated: improved, stopLoss: t.stopLoss, trade: t };
}

export function paperSymbolsForWatcher() {
  return [...new Set(
    _state.trades.filter(t => t.status === 'OPEN' || t.status === 'PARTIAL').map(t => t.symbol)
  )];
}

// 2026-09 multi-market: watch set classified per market so the watcher
// routes INDIA → Groww and CRYPTO → CoinDCX quotes.
export function paperSymbolsByMarket() {
  const india = [];
  const crypto = [];
  const futures = [];       // v21.17.0: USDT-perp paper rows → USDT quotes
  const global = [];        // v21.17.0: USDC-perp paper rows → USDC quotes
  for (const t of _state.trades) {
    if (t.status !== 'OPEN' && t.status !== 'PARTIAL') continue;
    const mkt = _marketOfTrade(t);
    if (mkt === 'CRYPTO') crypto.push(t.symbol);
    else if (mkt === 'FUTURES') futures.push(t.symbol);
    else if (mkt === 'GLOBALFUTURES') global.push(t.symbol);
    else india.push(t.symbol);
  }
  return {
    india: [...new Set(india)], crypto: [...new Set(crypto)],
    futures: [...new Set(futures)], global: [...new Set(global)],
  };
}

export function getPaperSummary() {
  // v11.4 recheck: compare each trade against ITS OWN market day — INDIA
  // rows bucket on the IST day, CRYPTO rows on the UTC day. The old
  // single IST-day filter dropped every crypto trade opened (and closed)
  // in the 00:00–05:30 IST window from closedToday/dayRealizedPnl/dayNetPnl.
  const open = _state.trades.filter(t => t.status === 'OPEN' || t.status === 'PARTIAL');
  const closedToday = _state.trades.filter(
    t => t.dayKey === dayKeyFor(_marketOfTrade(t)) && t.status === 'CLOSED'
  );
  const allClosed = _state.trades.filter(t => t.status === 'CLOSED');
  const sum = (arr, f) => arr.reduce((s, t) => s + (f(t) || 0), 0);
  // v11.1 GAP 3: costs are derived per trade (pure, deterministic) — the
  // same numbers _publicTrade serves, so summary and rows always agree.
  const costsOf = (t) => {
    try { return costsForPaperTrade(t)?.total ?? 0; } catch { return 0; }
  };

  // v21.17.0 PAPER UPGRADE — richer, honest stats: exit-reason mix,
  // R-multiple distribution, avg MFE/MAE capture, best/worst, per-source
  // split (manual vs mtf-auto). Sab closed trades ke derived fields se —
  // koi naya upstream nahi.
  const rOf = (t) => {
    const risk = Math.abs(Number(t.entry) - Number(t.stopLoss));
    if (!(risk > 0)) return null;
    const sign = t.direction === 'SHORT' ? -1 : 1;
    return +((((Number(t.lastPrice) - Number(t.entry)) * sign * (t.remainingQty ?? t.qty)) + Number(t.realizedPnl)) / (risk * (t.qty || 1))).toFixed(2);
  };
  const rVals = allClosed.map(rOf).filter(v => v != null);
  const byReason = {};
  for (const t of allClosed) {
    const k = String(t.closeReason || 'UNKNOWN').replace(/_HIT$|_BOOK$|_SQOFF$|_TRAIL$/, '');
    byReason[k] = (byReason[k] || 0) + 1;
  }
  const bySource = {};
  for (const t of allClosed.concat(open)) {
    const k = String(t.source || 'ui');
    bySource[k] = bySource[k] || { n: 0, wins: 0, pnl: 0 };
    bySource[k].n += t.status === 'CLOSED' ? 1 : 0;
    if (t.status === 'CLOSED') {
      bySource[k].pnl = +(bySource[k].pnl + Number(t.realizedPnl || 0)).toFixed(2);
      if (Number(t.realizedPnl) > 0) bySource[k].wins += 1;
    }
  }
  const mfeVals = allClosed.map(t => Number(t.mfeR)).filter(Number.isFinite);
  const maeVals = allClosed.map(t => Number(t.maeR)).filter(Number.isFinite);
  const avg = (a) => (a.length ? +(a.reduce((x, y) => x + y, 0) / a.length).toFixed(2) : null);

  return {
    open: open.map(_publicTrade),
    closedToday: closedToday.slice(-15).reverse().map(_publicTrade),
    stats: {
      openCount: open.length,
      dayRealizedPnl: +sum(closedToday, t => t.realizedPnl).toFixed(2),
      dayUnrealizedPnl: +sum(open, t => t.unrealizedPnl).toFixed(2),
      totalRealizedPnl: +sum(allClosed, t => t.realizedPnl).toFixed(2),
      wins: allClosed.filter(t => t.realizedPnl > 0).length,
      losses: allClosed.filter(t => t.realizedPnl < 0).length,
      // v11.1 GAP 3: net-of-costs variants (costs = brokerage + STT +
      // exchange txn + SEBI + GST + stamp — env-tunable to your broker)
      dayCosts: +sum(closedToday, costsOf).toFixed(2),
      dayNetPnl: +sum(closedToday, t => t.realizedPnl - costsOf(t)).toFixed(2),
      totalCosts: +sum(allClosed, costsOf).toFixed(2),
      totalNetPnl: +sum(allClosed, t => t.realizedPnl - costsOf(t)).toFixed(2),
      // ---- v21.17.0 upgrade block ----
      closedTotal: allClosed.length,
      winRatePct: allClosed.length ? +((allClosed.filter(t => t.realizedPnl > 0).length / allClosed.length) * 100).toFixed(1) : null,
      avgR: avg(rVals), bestR: rVals.length ? Math.max(...rVals) : null, worstR: rVals.length ? Math.min(...rVals) : null,
      avgMfeR: avg(mfeVals), avgMaeR: avg(maeVals),
      // capture% = actual R ÷ MFE R (kitna potential actually capture hua)
      capturePct: (() => {
        const pairs = allClosed.map(t => [rOf(t), Number(t.mfeR)]).filter(([r, m]) => r != null && Number.isFinite(m) && m > 0.2);
        if (!pairs.length) return null;
        const capped = pairs.map(([r, m]) => Math.max(-1, Math.min(1.2, r / m)));
        return +((capped.reduce((x, y) => x + y, 0) / capped.length) * 100).toFixed(0);
      })(),
      exitMix: byReason,
      bySource,
      openRisk: +open.reduce((a, t) => {
        const risk = Math.abs(Number(t.entry) - Number(t.stopLoss)) * (t.remainingQty ?? t.qty);
        return a + (Number.isFinite(risk) ? risk : 0);
      }, 0).toFixed(2),
    },
  };
}

function _publicTrade(t) {
  // v11.1 GAP 3: live-derived cost annotation — works for legacy and
  // restored trades too (pure function of qty/entry/parts).
  let costs = null;
  try { costs = costsForPaperTrade(t); } catch { /* gross fallback */ }
  return {
    id: t.id, symbol: t.symbol, market: _marketOfTrade(t), direction: t.direction,
    entry: t.entry, qty: t.qty, remainingQty: t.remainingQty,
    stopLoss: t.stopLoss, target1: t.target1, target2: t.target2,
    status: t.status, t1Hit: t.t1Hit, dayKey: t.dayKey,
    openedAt: t.openedAt, closedAt: t.closedAt, closeReason: t.closeReason,
    lastPrice: t.lastPrice, realizedPnl: +(+t.realizedPnl).toFixed(2),
    unrealizedPnl: +(+t.unrealizedPnl).toFixed(2),
    parts: t.parts, capital: t.capital,
    // v21.17.0: excursion + provenance + currency domain
    mfeR: t.mfeR ?? null, maeR: t.maeR ?? null,
    mfePrice: t.mfePrice ?? null, maePrice: t.maePrice ?? null,
    source: t.source || 'ui', sourceMeta: t.sourceMeta || null,
    ccy: _isUsdDesk(_marketOfTrade(t)) ? (t.market === 'GLOBALFUTURES' ? 'USDC' : 'USDT') : 'INR',
    ...(costs && costs.total != null ? {
      grossPnl: +(+t.realizedPnl).toFixed(2),
      costs: +(costs.total).toFixed(2),
      netPnl: +(t.realizedPnl - costs.total).toFixed(2),
      costsBreakdown: {
        instrumentType: costs.instrumentType,
        brokerage: costs.brokerage ?? 0, stt: costs.stt ?? 0,
        exchangeTxn: costs.exchangeTxn ?? 0, sebi: costs.sebi ?? 0,
        gst: costs.gst ?? 0, stampDuty: costs.stampDuty ?? 0,
        takerFee: costs.takerFee ?? null, orders: costs.orders ?? null,
      },
    } : {}),
    // v9.5 F&O option identity (absent on equity/crypto rows). iv is
    // included — the device-mirror restore needs it to re-price.
    ...(t.assetKind === 'OPTION' ? {
      assetKind: 'OPTION', underlying: t.underlying, strike: t.strike,
      optType: t.optType, expiry: t.expiry, lotSize: t.lotSize,
      iv: t.iv, label: t.label || null,
    } : {}),
  };
}

// Boot-time cleanup: anything left open from a previous day (per-market
// day key) gets squared off at its last known price. Crypto rolls at
// UTC midnight; NSE at IST midnight.
export function initPaperTrading() {
  const events = [];
  for (const t of _state.trades) {
    if (t.dayKey !== dayKeyFor(_marketOfTrade(t)) && t.status !== 'CLOSED') {
      _closePart(t, t.remainingQty, t.lastPrice || t.entry, 'STALE_SQOFF');
      events.push({ type: 'PAPER_CLOSE', symbol: t.symbol, direction: t.direction, price: t.lastPrice || t.entry, pnl: t.realizedPnl, note: 'Stale paper trade squared off on restart' });
    }
  }
  _persist();

  // DURABLE HISTORY — Render free plan wipes server/data/ on restart.
  // If local state came up empty, pull the last remote backup and
  // merge it back BEFORE the first client sees a wiped history.
  if (_state.trades.length === 0 && backupConfigured()) {
    _bootRestore();
  }
  return events;
}

let _bootRestoring = false;
async function _bootRestore() {
  if (_bootRestoring) return;
  _bootRestoring = true;
  try {
    const remote = await restoreBackup(FILE);
    // v12.7: the remote copy is now an AES-256-GCM durable envelope; a
    // legacy plaintext blob still restores (migration grace — whichever
    // form the branch holds, the fresher trades win).
    const remoteState = remote && remote.alg === 'aes-256-gcm' ? decryptJSON(remote) : remote;
    const remoteTrades = Array.isArray(remoteState?.trades) ? remoteState.trades : [];
    if (remoteTrades.length > _state.trades.length) {
      _mergeRestoredState(remoteState);
      _persist();
      console.log(`[paper] boot-restore: recovered ${remoteTrades.length} trades from remote backup`);
    }
  } catch (e) {
    console.warn('[paper] boot-restore failed:', e?.message || e);
  } finally {
    _bootRestoring = false;
  }
}

// ------------------------------------------------------------
// HISTORY — full cross-day track record for the accuracy audit.
// Day-grouped closed trades + win-rate stats, so the user can see
// whether the paper-trading signal testing was actually accurate.
// ------------------------------------------------------------
export function getPaperHistory(days = 90) {
  const windowDays = Math.max(1, Math.min(365, Math.floor(days) || 90));
  const cutoff = Date.now() - windowDays * 24 * 60 * 60 * 1000;

  const closed = _state.trades
    .filter(t => t.status === 'CLOSED' && (t.closedAt || t.openedAt) >= cutoff)
    .sort((a, b) => (b.closedAt || b.openedAt) - (a.closedAt || a.openedAt));

  // Day buckets (newest first).
  const byDay = new Map();
  for (const t of closed) {
    const key = t.dayKey || istDayKey(new Date(t.openedAt || Date.now()));
    if (!byDay.has(key)) byDay.set(key, []);
    byDay.get(key).push(t);
  }

  const groups = [...byDay.entries()].map(([dayKey, list]) => {
    const wins = list.filter(t => t.realizedPnl > 0).length;
    const losses = list.filter(t => t.realizedPnl < 0).length;
    const dayCosts = list.reduce((s, t) => {
      try { return s + (costsForPaperTrade(t)?.total ?? 0); } catch { return s; }
    }, 0);
    const dayGross = +list.reduce((s, t) => s + (t.realizedPnl || 0), 0).toFixed(2);
    return {
      dayKey,
      trades: list.length,
      wins, losses,
      winRate: list.length ? +((wins / list.length) * 100).toFixed(1) : 0,
      realizedPnl: dayGross,
      // v11.1 GAP 3: the honest net line (costs deducted)
      costs: +dayCosts.toFixed(2),
      netPnl: +(dayGross - dayCosts).toFixed(2),
    };
  }).sort((a, b) => (a.dayKey < b.dayKey ? 1 : -1));

  const wins = closed.filter(t => t.realizedPnl > 0);
  const losses = closed.filter(t => t.realizedPnl < 0);
  const grossWin = wins.reduce((s, t) => s + t.realizedPnl, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.realizedPnl, 0));
  const totalPnl = +(grossWin - grossLoss).toFixed(2);
  // v11.1 GAP 3: all-time net + total costs (the "is this strategy
  // real-money viable or only paper-viable" number)
  const totalCosts = +closed.reduce((s, t) => {
    try { return s + (costsForPaperTrade(t)?.total ?? 0); } catch { return s; }
  }, 0).toFixed(2);

  let bestDay = null, worstDay = null;
  for (const g of groups) {
    if (!bestDay || g.realizedPnl > bestDay.pnl) bestDay = { dayKey: g.dayKey, pnl: g.realizedPnl };
    if (!worstDay || g.realizedPnl < worstDay.pnl) worstDay = { dayKey: g.dayKey, pnl: g.realizedPnl };
  }

  return {
    days: windowDays,
    totalClosed: closed.length,
    groups,
    overall: {
      totalTrades: closed.length,
      wins: wins.length,
      losses: losses.length,
      winRate: closed.length ? +((wins.length / closed.length) * 100).toFixed(1) : 0,
      avgWin: wins.length ? +(grossWin / wins.length).toFixed(2) : 0,
      avgLoss: losses.length ? +(-grossLoss / losses.length).toFixed(2) : 0,
      profitFactor: grossLoss > 0 ? +(grossWin / grossLoss).toFixed(2) : (grossWin > 0 ? null : 0),
      totalPnl,
      // v11.1 GAP 3: net-of-costs view
      totalCosts,
      totalNetPnl: +(totalPnl - totalCosts).toFixed(2),
      costsPctOfGrossProfit: grossWin > 0 ? +((totalCosts / grossWin) * 100).toFixed(1) : null,
      bestDay, worstDay,
    },
    // Full closed-trade list (newest first) — the client mirrors this
    // into IndexedDB so a wiped server can be auto-restored from it.
    trades: closed.map(_publicTrade),
  };
}

// ------------------------------------------------------------
// RESTORE — rebuild state after a server filesystem wipe, from the
// client's device mirror (POST /api/intraday-paper/restore) or the
// remote GitHub backup (boot path). Merge-by-id keeps any trades
// the still-running instance already knows about.
// ------------------------------------------------------------
function _num(v, fallback = 0) {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function _sanitizeRestoredTrade(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const id = Number.isInteger(raw.id) ? raw.id : parseInt(raw.id, 10);
  if (!Number.isInteger(id) || id < 1 || id > 1e9) return null;
  const symbol = typeof raw.symbol === 'string' ? raw.symbol.trim().toUpperCase() : '';
  // v21.0.6 [audit]: 15 → 20 — openPaperTrade _validateSym ke saath align
  // (BANKNIFTY51000CE 16-char contract restore pe silently drop ho raha tha).
  if (!/^[A-Z0-9&-]{2,20}$/.test(symbol)) return null;
  const direction = raw.direction === 'SHORT' ? 'SHORT' : 'LONG';
  const market = (['INDIA', 'CRYPTO', 'FUTURES', 'GLOBALFUTURES'].includes(String(raw.market || '').toUpperCase())
    ? String(raw.market).toUpperCase()
    : (isCryptoSymbolBase(symbol) ? 'CRYPTO' : 'INDIA'));
  const entry = _num(raw.entry); if (!(entry > 0)) return null;
  const qty = _normQty(_num(raw.qty), market); if (!(qty >= (_isUsdDesk(market) ? 0.0001 : 1)) || qty > 100000) return null;
  const status = ['OPEN', 'PARTIAL', 'CLOSED'].includes(raw.status) ? raw.status : 'CLOSED';
  const openedAt = _num(raw.openedAt, Date.now());
  const parts = Array.isArray(raw.parts)
    ? raw.parts.slice(0, 20).map(p => ({
        qty: _normQty(_num(p?.qty, 1), market) || (_isUsdDesk(market) ? 0.0001 : 1),
        exitPrice: pRound(_num(p?.exitPrice, entry)),
        ts: _num(p?.ts, openedAt),
        reason: String(p?.reason || 'RESTORE').slice(0, 20),
      }))
    : [];
  const remainingQty = status === 'CLOSED'
    ? 0
    : Math.min(qty, _normQty(_num(raw.remainingQty, qty), market));
  const realizedPnl = +_num(raw.realizedPnl).toFixed(2);
  const t = {
    id, symbol, market, direction,
    ...(() => {
      const rSl = _num(raw.stopLoss, entry);
      const rT1 = _num(raw.target1) > 0 ? _num(raw.target1) : null;
      const rT2 = _num(raw.target2) > 0 ? _num(raw.target2) : null;
      const tList = [rT1, rT2].filter(x => x != null && x > 0);
      const lad = pRoundLadder({ side: direction, entry, stopLoss: rSl, targets: tList });
      return {
        entry: lad.entry,
        stopLoss: lad.stopLoss,
        target1: rT1 ? lad.targets[0] : null,
        target2: rT2 ? lad.targets[rT1 ? 1 : 0] : null,
        precision: lad.precision,
      };
    })(), qty,
    remainingQty,
    t1Hit: !!raw.t1Hit,
    status,
    openedAt,
    closedAt: status === 'CLOSED' ? _num(raw.closedAt, openedAt) : null,
    closeReason: status === 'CLOSED' ? String(raw.closeReason || 'RESTORED').slice(0, 20) : null,
    realizedPnl,
    unrealizedPnl: status === 'CLOSED' ? 0 : +_num(raw.unrealizedPnl).toFixed(2),
    lastPrice: pRound(_num(raw.lastPrice, entry)),
    parts,
    dayKey: /^\d{4}-\d{2}-\d{2}$/.test(String(raw.dayKey)) ? raw.dayKey : dayKeyFor(market, new Date(openedAt)),
    capital: +_num(raw.capital, qty * entry).toFixed(2),
    // v21.17.0: excursion + audit provenance restore round-trip me bhi
    mfePrice: _num(raw.mfePrice) > 0 ? pRound(_num(raw.mfePrice)) : null,
    maePrice: _num(raw.maePrice) > 0 ? pRound(_num(raw.maePrice)) : null,
    mfeR: Number.isFinite(Number(raw.mfeR)) ? Number(raw.mfeR) : null,
    maeR: Number.isFinite(Number(raw.maeR)) ? Number(raw.maeR) : null,
    source: String(raw.source || 'restored').slice(0, 20),
    sourceMeta: (raw.sourceMeta && typeof raw.sourceMeta === 'object') ? raw.sourceMeta : null,
  };
  // v9.5: option fields survive the device-mirror/backup round-trip.
  if (raw.assetKind === 'OPTION' && OPTION_UNDERLYINGS.has(String(raw.underlying || '').toUpperCase())) {
    const k = _num(raw.strike, 0), ls = Math.round(_num(raw.lotSize, 0));
    const ot = String(raw.optType || '').toUpperCase();
    if (k > 0 && ls >= 1 && (ot === 'CE' || ot === 'PE') && /^\d{4}-\d{2}-\d{2}$/.test(String(raw.expiry || '')) && _num(raw.iv, 0) > 0) {
      t.assetKind = 'OPTION';
      t.underlying = String(raw.underlying).trim().toUpperCase();
      t.strike = k; t.optType = ot;
      t.expiry = String(raw.expiry).slice(0, 10);
      t.iv = _num(raw.iv);
      t.lotSize = ls;
      t.label = typeof raw.label === 'string' && raw.label.trim() ? raw.label.trim().slice(0, 40) : null;
    }
  }
  return t;
}

function _mergeRestoredState(remote) {
  const incoming = (Array.isArray(remote?.trades) ? remote.trades : [])
    .map(_sanitizeRestoredTrade)
    .filter(Boolean)
    .sort((a, b) => a.openedAt - b.openedAt)
    .slice(0, MAX_TRADES);

  const known = new Map(_state.trades.map(t => [t.id, t])); // server copy wins
  let restored = 0;
  for (const t of incoming) {
    if (!known.has(t.id)) { known.set(t.id, t); restored++; }
  }
  _state.trades = [...known.values()].sort((a, b) => a.openedAt - b.openedAt);
  if (_state.trades.length > MAX_TRADES) {
    _state.trades = _state.trades.slice(_state.trades.length - MAX_TRADES);
  }
  const maxId = _state.trades.reduce((m, t) => Math.max(m, t.id), 0);
  _state.nextId = Math.max(_state.nextId || 1, maxId + 1);
  return restored;
}

export function restorePaperTrades(input) {
  const incoming = Array.isArray(input?.trades) ? input.trades : [];
  if (incoming.length === 0) return { error: 'trades[] required (device mirror payload).' };
  if (incoming.length > MAX_TRADES + 100) return { error: `Too many trades (max ${MAX_TRADES}).` };

  // Nothing to do? A wiped-and-restarted server should accept, but a
  // server that already knows MORE than the mirror is the source of
  // truth — ignore stale mirrors (idempotent client retry safety).
  const knownIds = new Set(_state.trades.map(t => t.id));
  const missing = incoming.filter(t => {
    const id = Number.isInteger(t?.id) ? t.id : parseInt(t?.id, 10);
    return Number.isInteger(id) && !knownIds.has(id);
  });
  if (missing.length === 0) {
    return { ok: true, restored: 0, alreadyKnown: _state.trades.length, summary: getPaperSummary() };
  }

  const restored = _mergeRestoredState({ trades: incoming });

  // Restored trades left "open" from a PREVIOUS day are stale by the
  // same per-market rule as boot-time — square them off at last price.
  for (const t of _state.trades) {
    if (t.dayKey !== dayKeyFor(_marketOfTrade(t)) && t.status !== 'CLOSED') {
      _closePart(t, t.remainingQty, t.lastPrice || t.entry, 'STALE_SQOFF');
    }
  }
  _persist();
  return { ok: true, restored, summary: getPaperSummary() };
}

// Test-only: swap in a clean/seeded state (vitest).
export function _resetForTests(seed) {
  if (_saveTimer) { clearTimeout(_saveTimer); _saveTimer = null; }
  _state = structuredClone(seed || { trades: [], nextId: 1, dayKey: istDayKey() });
  _circuitAlertAt.clear();
  _chainQuoteCache.clear(); // v21.0.6: live-chain reprice cache (fake timers me TTL freeze hota hai)
}

/** v21.1.1 test hook: chain-cache entries ko X ms "age" karo — stale-bound
 * behavior (5-min) verify karne ke liye (audit C1 test). */
export function __ageChainCacheForTests(ms) {
  for (const [k, v] of _chainQuoteCache.entries()) {
    _chainQuoteCache.set(k, { chain: v.chain, at: (v.at || Date.now()) - Math.max(0, Number(ms) || 0) });
  }
}
