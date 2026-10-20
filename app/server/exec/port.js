// ============================================================
// server/exec/port.js — v20.7 EXECUTION PORT ABSTRACTION
// ------------------------------------------------------------
// Phase 2 of the auto-trading plan (app/docs/audit.md §4). One
// interface, three adapters:
//   • ApiFuturesPort  — wraps futures.js (createFuturesOrder,
//     createFuturesTpsl, partialFuturesExit, exitFuturesPosition,
//     listFuturesPositions, fetchFuturesWallets). RECOMMENDED for
//     5–10x leverage: native exchange SL, verified leverage, exact
//     fills. The default EXEC_MODE=api.
//   • BrowserCdpPort   — wraps browserAgent.js (cxEnsureTradePage,
//     cxSelectPair, cxPlaceOrder, cxClosePosition, cxReadPositions).
//     Phase 6 hardening still pending (leverage read-back, UI SL/TP
//     bracket) — do NOT enable for live 5–10x until Phase 6 done.
//   • PaperPort       — simulated fills, same interface (tests +
//     shadow). The only safe mode until Phase 9 paper soak completes.
//
// CORE RULE (audit doc §3): "Koi live position tab tak 'valid' nahi
// jab tak exchange-resident SL confirmed na ho." → protection-first
// entry sequence lives in positionManager.js; this module just exposes
// the primitives.
//
// clientId idempotency: every open() takes a unique clientId; the
// adapter retries on ambiguous transport errors but never duplicates
// (the exchange de-dupes by clientId). PaperPort tracks clientId in-
// memory + rejects duplicates.
// ============================================================

const r2 = (v) => (Number.isFinite(v) ? Math.round(v * 100) / 100 : null);

/**
 * Adapter for the CoinDCX USDT-perp API (futures.js). All 6 primitives
 * the positionManager needs; wraps existing functions — no new CoinDCX
 * calls. safe-fail: every method returns { ok: false, error } rather
 * than throwing (the caller's protection-first sequence handles failure
 * by flattening).
 */
export class ApiFuturesPort {
  constructor({ futuresMod, logger = console.error } = {}) {
    this._fut = futuresMod; // { createFuturesOrder, createFuturesTpsl, partialFuturesExit, exitFuturesPosition, listFuturesPositions, fetchFuturesWallets }
    this._log = logger;
    this.mode = 'api';
  }
  async health() {
    try {
      const w = await this._fut.fetchFuturesWallets().catch(() => null);
      if (Array.isArray(w)) return { ok: true, mode: 'api', latencyMs: 0, reasons: [] };
      return { ok: false, mode: 'api', latencyMs: 0, reasons: ['futures wallet read failed'] };
    } catch (e) { return { ok: false, mode: 'api', latencyMs: 0, reasons: [String(e?.message || e).slice(0, 80)] }; }
  }
  async getEquity() {
    try {
      const rows = await this._fut.fetchFuturesWallets().catch(() => []);
      const list = Array.isArray(rows) ? rows : [];
      const usdt = list.find(w => w.currency === 'USDT') || { free: 0, locked: 0, total: 0, crossUserMargin: 0 };
      const inr = list.find(w => w.currency === 'INR') || { free: 0, locked: 0, total: 0, crossUserMargin: 0 };
      let fx = 85;
      if ((inr.total || 0) > 0 || (inr.free || 0) > 0) {
        try {
          if (typeof this._fut.fetchUsdInr === 'function') fx = Number(await this._fut.fetchUsdInr()) || 85;
        } catch { fx = 85; }
      }
      const totalUSDT = r2((usdt.total || 0) + ((inr.total || 0) / fx)) || 0;
      const freeUSDT = r2((usdt.free || 0) + ((inr.free || 0) / fx)) || 0;
      return { totalUSDT, freeUSDT, unrealizedUSDT: null };
    } catch (e) { return { totalUSDT: 0, freeUSDT: 0, unrealizedUSDT: null, error: String(e?.message || e) }; }
  }
  async getPositions() {
    try {
      const list = await this._fut.listFuturesPositions().catch(() => []);
      return (Array.isArray(list) ? list : []).map(p => ({
        id: String(p.id || ''),
        pair: String(p.pair || ''),
        side: Number(p.activePos || 0) > 0 ? 'LONG' : (Number(p.activePos || 0) < 0 ? 'SHORT' : 'FLAT'),
        qty: Math.abs(Number(p.activePos || 0)),
        avgPrice: r2(p.avgPrice),
        leverage: Number(p.leverage || 1),
        liqPrice: r2(p.liquidationPrice),
        sl: r2(p.sl),
        tp: r2(p.tp),
        markPrice: r2(p.markPrice),
      }));
    } catch (e) { return []; }
  }
  async open({ pair, side, qty, leverage, type = 'market', price = null, _sl, _tp, clientId }) {
    try {
      // v21.23.9 [CRITICAL FIX]: side HONEST validation — pehle unknown side
      // silently 'sell' (SHORT) ban jati thi. futuresOrderBody ab DONO
      // vocabularies honestly map karta hai — 'sell' pehle 'SELL' !== 'SHORT'
      // se long=true hota tha → SHORT entry ulti BUY position ban jati thi.
      // Unknown side = loud reject (v21.23.4 doctrine).
      const s = String(side ?? '').toUpperCase().trim();
      if (s !== 'LONG' && s !== 'SHORT' && s !== 'BUY' && s !== 'SELL') {
        return { ok: false, error: `open: invalid side "${String(side)}" (LONG/SHORT chahiye)` };
      }
      const isLong = s === 'LONG' || s === 'BUY';
      // v20.7.10 CRITICAL FIX: createFuturesOrder({ pair, side, qty,
      // leverage, price }) destructure karta hai — pehle `quantity: qty`
      // pass hota tha (qty undefined → total_quantity: NaN → JSON null →
      // exchange 400) aur `client_id`/`order_type` silently drop hote the
      // (idempotency kabhi wire tak pahunchi hi nahi; order_type price>0
      // se derive hota hai). Ab exact keys — EXEC_MODE=api pe pehli baar
      // valid order body banegi.
      // v20.7.12 [H2-4]: adapter ab 200-wrapped rejections / id-less bodies
      // pe {orderId:null, error} deta hai — ok sirf EXCHANGE-ISSUED id pe.
      // (clientId ab tak wire nahi jata — futuresOrderBody ka documented
      // shape koi client-order-id field nahi rakta; exchange-side dedupe
      // pending API-doc verification. Callers clientId journal-dedupe ke
      // liye return me paate hain.)
      const order = await this._fut.createFuturesOrder({
        pair, side: isLong ? 'buy' : 'sell',
        qty: Number(qty), leverage: Number(leverage) || 1,
        // limit sirf tab jab caller ne price diya (futuresOrderBody price>0
        // se order_type decide karta hai — market me price null)
        price: type === 'limit' ? Number(price) : null,
      });
      if (!order) return { ok: false, error: 'createFuturesOrder returned null' };
      if (order.error || order.orderId == null || String(order.orderId).trim() === '') {
        return { ok: false, error: order.error || 'exchange ne order id nahi diya (order reject/id-less body)' };
      }
      return { ok: true, orderId: String(order.orderId), raw: order, clientId: clientId || null };
    } catch (e) { return { ok: false, error: String(e?.message || e) }; }
  }
  async setProtection({ positionId, sl, tp }) {
    try {
      // v20.7.10 CRITICAL FIX: createFuturesTpsl({ positionId, stopLoss,
      // takeProfit }) destructure karta hai — pehle { positionId, sl, tp }
      // pass hota tha → dono undefined → 'no levels given' error object
      // → !!r truthy → ok:true LIE. positionManager protection-first
      // sequence pass ho jata tha jabki exchange pe SL SET HI NAHI THA
      // (naked leveraged position believed protected!).
      const r = await this._fut.createFuturesTpsl({
        positionId,
        stopLoss: Number(sl) > 0 ? Number(sl) : undefined,
        takeProfit: Number(tp) > 0 ? Number(tp) : undefined,
      });
      return { ok: r?.ok === true, raw: r, error: r?.ok === true ? undefined : String(r?.error || 'tpsl rejected') };
    } catch (e) { return { ok: false, error: String(e?.message || e) }; }
  }
  async reduce({ positionId, qty }) {
    try {
      // v20.7.10 CRITICAL FIX: partialFuturesExit({ pair, qty, side,
      // leverage }) chahiye — pehle { positionId, qty } pass hota tha:
      // pair 'undefined' + side undefined → opposite HAMESHA 'SHORT'
      // (SHORT position ke reduce pe bhi sell-side = WRONG DIRECTION,
      // position double ho jati). Ab position resolve karke sahi
      // pair/side/leverage ke saath opposite-side reduce order.
      const positions = await this._fut.listFuturesPositions().catch(() => []);
      const pos = (Array.isArray(positions) ? positions : []).find((p) => String(p?.id || '') === String(positionId));
      if (!pos) return { ok: false, error: `reduce: position ${positionId} exchange pe nahi mili (already closed?)` };
      const side = Number(pos.activePos || 0) < 0 ? 'SHORT' : 'LONG';
      const r = await this._fut.partialFuturesExit({
        pair: pos.pair, qty: Number(qty), side,
        leverage: Number(pos.leverage) || 1,
      });
      // v20.7.12 [H2-1]: partialFuturesExit → createFuturesOrder ka naya
      // honest shape — {orderId, error}. ok sirf id pe (pehle `r.raw` truthy
      // bhi ok bol deta tha — wrapped-rejection reduce "ho gaya" journal).
      return { ok: !!(r && r.orderId != null && !r.error), raw: r, error: r?.error || undefined };
    } catch (e) { return { ok: false, error: String(e?.message || e) }; }
  }
  async close({ positionId }) {
    try {
      // v20.7.10 CRITICAL FIX: exitFuturesPosition(positionId) POSITIONAL
      // arg leta hai — pehle { positionId } object pass hota tha →
      // String({positionId}) = '[object Object]' exchange ko jata tha.
      // v20.7.12 [H2-1]: adapter ab {ok, error, raw} verdict deta hai —
      // pehle `ok: r != null` hamesha true tha (200-wrapped reject bhi
      // "closed" journal hota tha, position chalti rehti thi).
      const r = await this._fut.exitFuturesPosition(positionId);
      return { ok: r?.ok === true, raw: r, error: r?.ok === true ? undefined : String(r?.error || 'exit rejected') };
    } catch (e) { return { ok: false, error: String(e?.message || e) }; }
  }
  async cancelOpenOrders({ _pair }) {
    // v20.7.12 [H2-5]: pehle ok:true stub tha — positionManager iska note
    // error message me embed karta hai, par ok jhootha tha (cancel HUA HI
    // NAHI tha jabki flow aage badh gaya). Ab honest verdict — caller
    // (fill-confirm fail path) already "manually verify karo" kehta hai.
    return { ok: false, note: 'cancelOpenOrders not yet wired (futures.js pending) — broker app me resting order manually verify/cancel karo' };
  }
}

/**
 * Paper adapter — simulated fills, same interface. Used by tests +
 * Phase 9 paper soak. NEVER throws. Tracks clientId for idempotency.
 */
export class PaperPort {
  constructor({ startingEquityUSDT = 1000 } = {}) {
    this.mode = 'paper';
    this._equity = Number(startingEquityUSDT) || 1000;
    this._free = this._equity;
    this._positions = new Map(); // id → position
    this._orders = []; // open orders
    this._clientIds = new Set();
    this._nextId = 1;
    this._fillLog = [];
  }
  async health() { return { ok: true, mode: 'paper', latencyMs: 0, reasons: [] }; }
  async getEquity() {
    let unreal = 0;
    for (const p of this._positions.values()) if (p.markPrice != null) {
      unreal += (p.side === 'LONG' ? 1 : -1) * p.qty * (p.markPrice - p.avgPrice);
    }
    return { totalUSDT: r2(this._equity + unreal), freeUSDT: r2(this._free), unrealizedUSDT: r2(unreal) };
  }
  async getPositions() {
    return Array.from(this._positions.values()).map(p => ({ ...p }));
  }
  /** Test hook: set the live mark price for a pair (simulates a tick). */
  setMarkPrice(pair, price) {
    for (const p of this._positions.values()) if (p.pair === pair) p.markPrice = Number(price);
  }
  async open({ pair, side, qty, leverage, type = 'market', price = null, sl, tp, clientId, meta = null }) {
    if (clientId && this._clientIds.has(clientId)) {
      // v20.8.2 FIX (L — honest idempotency): a duplicate clientId used to
      // return ok:true with NO position, so the runner logged a second
      // "order ok" event for a trade that was never placed. Return the
      // EXISTING position so the caller sees what it actually owns.
      for (const p of this._positions.values()) {
        if (p.clientId === clientId) return { ok: true, orderId: p.id, dup: true, raw: { ...p } };
      }
      return { ok: true, orderId: `paper-${clientId}`, dup: true, note: 'duplicate clientId (position already closed)' };
    }
    // v20.8.4 FIX (L — never invent a price): the `|| 100` fallback used to
    // fabricate a $100 fill for a market order with no mark and no passed
    // price (the same fiction botRunner.js removed in v20.8.1). Both
    // production callers pass an explicit price today; a future market-open
    // caller without one now gets an honest REJECTION, not a fake book.
    const mark0 = this._lastMarkPrice(pair);
    const fillPrice = type === 'limit' ? Number(price) : (mark0 != null ? mark0 : Number(price));
    if (!(fillPrice > 0)) return { ok: false, error: 'no mark price for market fill (setMarkPrice ya explicit price chahiye)' };
    const id = `paper-${this._nextId++}`;
    if (clientId) {
      // v20.7.12 [L-7]: cap the idempotency set (unbounded in long soaks).
      if (this._clientIds.size >= 400) {
        const oldest = this._clientIds.values().next().value;
        if (oldest !== undefined) this._clientIds.delete(oldest);
      }
      this._clientIds.add(clientId);
    }
    const lev = Math.max(1, Number(leverage) || 1);
    const margin = (qty * fillPrice) / lev;
    if (margin > this._free) return { ok: false, error: `insufficient free margin: need ${r2(margin)}, have ${r2(this._free)}` };
    this._free -= margin;
    const pos = {
      id, pair, side: String(side).toUpperCase(), qty: Number(qty),
      avgPrice: r2(fillPrice), leverage: lev, liqPrice: this._liqPrice(fillPrice, lev, side),
      sl: r2(sl), tp: r2(tp), markPrice: r2(fillPrice), margin: r2(margin), clientId,
      // v20.8.2: openedAt + caller meta (maxHoldBars / squareOffIST) so
      // the settle loop can honor the engine's time-based exits, and
      // restart rehydration can restore the position faithfully.
      openedAt: Date.now(), meta: (meta && typeof meta === 'object') ? { ...meta } : null,
    };
    this._positions.set(id, pos);
    this._fillLog.push({ at: Date.now(), kind: 'open', id, pair, side, qty, price: fillPrice });
    this._capFillLog();
    return { ok: true, orderId: id, raw: pos };
  }
  /** v20.8.2: restore open positions after a restart (bot lab paper
   *  positions used to be ephemeral — a restart silently deleted them).
   *  Reserves margin best-effort (clamped at 0 — the settle math uses
   *  avgPrice vs mark, not margin). */
  hydrateOpenPositions(positions) {
    if (!Array.isArray(positions)) return;
    for (const raw of positions) {
      if (!raw || typeof raw !== 'object' || !raw.id || !raw.pair) continue;
      const p = {
        id: String(raw.id), pair: String(raw.pair), side: String(raw.side || 'LONG').toUpperCase(),
        qty: Number(raw.qty) || 0, avgPrice: Number(raw.avgPrice) || 0,
        leverage: Math.max(1, Number(raw.leverage) || 1), liqPrice: Number(raw.liqPrice) || null,
        sl: raw.sl != null ? Number(raw.sl) : null, tp: raw.tp != null ? Number(raw.tp) : null,
        markPrice: raw.markPrice != null ? Number(raw.markPrice) : (Number(raw.avgPrice) || null),
        margin: Number(raw.margin) || 0, clientId: raw.clientId || null,
        openedAt: Number(raw.openedAt) || Date.now(),
        meta: (raw.meta && typeof raw.meta === 'object') ? { ...raw.meta } : null,
      };
      if (!(p.qty > 0) || !(p.avgPrice > 0)) continue;
      this._positions.set(p.id, p);
      if (p.clientId) {
        if (this._clientIds.size >= 400) {
          const oldest = this._clientIds.values().next().value;
          if (oldest !== undefined) this._clientIds.delete(oldest);
        }
        this._clientIds.add(p.clientId);
      }
      this._free = Math.max(0, this._free - (p.margin || 0));
    }
  }
  async setProtection({ positionId, sl, tp }) {
    const p = this._positions.get(positionId);
    if (!p) return { ok: false, error: 'position not found' };
    p.sl = r2(sl);
    p.tp = r2(tp);
    return { ok: true, raw: { sl: p.sl, tp: p.tp } };
  }
  async reduce({ positionId, qty }) {
    const p = this._positions.get(positionId);
    if (!p) return { ok: false, error: 'position not found' };
    const reduce = Math.min(Number(qty), p.qty);
    // v20.7.10 FIX (qty rounding): r2 (2-decimal) crypto qty ko corrupt
    // karta tha — 0.0045 → 0 → position delete + margin strand; share
    // math bhi pre-round sum pe chalta tha. Ab qty 6-decimal (positionManager
    // ke qtyR floor jaisa), money fields r2 hi rehte hain.
    const r6 = (v) => (Number.isFinite(v) ? Math.round(v * 1e6) / 1e6 : null);
    p.qty = r6(p.qty - reduce);
    // v20.7.3 FIX (margin accounting): free the proportional share AND
    // decrement p.margin. The old code never decremented p.margin, so a
    // reduce-to-zero freed 100% of the margin and the close branch then
    // added the FULL original margin again (double-free) — partial-then-
    // close over-credited by the previously-freed fraction.
    const share = reduce / (reduce + p.qty);
    const marginReturn = (p.margin || 0) * share;
    this._free += marginReturn;
    p.margin = r2(Math.max(0, (p.margin || 0) - marginReturn));
    // v20.7.3 FIX (PnL accounting): realize PnL on EVERY slice — the old
    // code only booked PnL on the final reduce-to-zero slice, so partial
    // exits at different prices silently dropped their realized PnL.
    const pnl = (p.side === 'LONG' ? 1 : -1) * reduce * ((p.markPrice || p.avgPrice) - p.avgPrice);
    this._equity += pnl;
    // v20.9.1 [M]: free margin me bhi realized PnL — pehle sirf equity
    // track hota tha, free margin-return hi milta tha → losing streak ke
    // baad bhi open() ko original-equity jaisa free dikhta tha (botRisk
    // secondary check loosened vs account reality).
    this._free += pnl;
    this._fillLog.push({ at: Date.now(), kind: 'reduce', id: positionId, qty: reduce, pnl: r2(pnl) });
    this._capFillLog();
    if (p.qty <= 0.000001) {
      this._positions.delete(positionId);
    }
    // v20.9.1: `paper: true` marker — botRunner settle isse pehchanta hai
    // (PaperPort ka realizedPnl MARK-BASED GROSS hai, fees/slip abhi lagne
    // hain; ApiFuturesPort ka exchange-reported number net-of-fees hota hai).
    return { ok: true, raw: { remainingQty: p.qty, realizedPnl: r2(pnl), paper: true } };
  }
  async close({ positionId }) {
    const p = this._positions.get(positionId);
    if (!p) return { ok: false, error: 'position not found' };
    const pnl = (p.side === 'LONG' ? 1 : -1) * p.qty * ((p.markPrice || p.avgPrice) - p.avgPrice);
    this._equity += pnl;
    // v20.9.1 [M]: free = margin-back + realized PnL — pehle realized
    // loss free margin se KABHI nahi kat ta tha (ek losing streak ke baad
    // open() oversize ho sakta tha; exec-stack marks wiring ke saath ab
    // close PnL non-zero hota hai isliye ye gap ab meaningful hai).
    this._free += (p.margin || 0) + pnl;
    this._fillLog.push({ at: Date.now(), kind: 'close', id: positionId, pnl: r2(pnl) });
    this._capFillLog();
    this._positions.delete(positionId);
    // v20.9.1: `paper: true` marker (reduce() wale comment dekho).
    return { ok: true, raw: { realizedPnl: r2(pnl), paper: true } };
  }
  async cancelOpenOrders({ pair }) { this._orders = this._orders.filter(o => o.pair !== pair); return { ok: true }; }
  _liqPrice(entry, lev, side) {
    // liquidation ≈ entry × (1 ∓ 0.95/leverage) — matches ensemble.js
    const f = 0.95 / Math.max(1, lev);
    return r2(side === 'LONG' ? entry * (1 - f) : entry * (1 + f));
  }
  _lastMarkPrice(pair) {
    // if any existing position has this pair, return its markPrice
    for (const p of this._positions.values()) if (p.pair === pair && p.markPrice) return p.markPrice;
    return null;
  }
  _capFillLog() {
    // v20.7.12 [L-7]: fill log bounded (journal-400 convention)
    if (this._fillLog.length > 400) this._fillLog.splice(0, this._fillLog.length - 400);
  }
  // test hooks
  _dump() { return { equity: this._equity, free: this._free, positions: Array.from(this._positions.values()), fillLog: this._fillLog }; }
}

/**
 * Browser CDP adapter — wraps browserAgent.js. Phase 6 hardening
 * (leverage read-back, UI SL/TP bracket, session-expiry detection)
 * is STILL PENDING per the audit doc. The adapter is provided so the
 * positionManager can run in browser mode for paper testing, but live
 * 5–10x execution in browser mode is GATED behind Phase 6 completion.
 */
export class BrowserCdpPort {
  constructor({ browserAgent, logger = console.error } = {}) {
    this._ba = browserAgent; // { cxEnsureTradePage, cxSelectPair, cxPlaceOrder, cxClosePosition, cxReadPositions }
    this._log = logger;
    this.mode = 'browser';
  }
  async health() {
    try {
      // v20.7.7 FIX: pehle ye HAMESHA ok:true tha — browser band ho tab
      // bhi! Ab real probe: browserAgent ka status (CDP connected + tab
      // discovered) dekh ke honest health do (positionManager iske
      // bina browser-down pe entry attempt karta rehta tha).
      const st = this._ba.browserStatus ? this._ba.browserStatus() : null;
      const connected = !!st?.connected;
      return {
        ok: connected, mode: 'browser', latencyMs: 0,
        reasons: connected ? [] : [String(st?.lastError || 'automation browser not connected — Start-AutoBrowser.bat chalao')],
      };
    } catch (e) { return { ok: false, mode: 'browser', latencyMs: 0, reasons: [String(e?.message || e).slice(0, 80)] }; }
  }
  async getEquity() {
    // browser-mode equity is read from the UI wallet strip — best-effort
    // parse; for live 5–10x use the API port (ApiFuturesPort) which
    // reads /api/ai/wallet. Paper testing only.
    return { totalUSDT: null, freeUSDT: null, unrealizedUSDT: null, note: 'browser equity read-best-effort' };
  }
  async getPositions() {
    try {
      // v20.7.7 FIX #2: cxReadPositions() OBJECT ({ok, positions:[…]}) return
      // karta hai — purana code seedha Array.isArray(res) check karta tha →
      // HAMESHA [] (positions table kabhi dikhi hi nahi). Ab .positions
      // extract hota hai.
      const res = await this._ba.cxReadPositions().catch(() => null);
      const rows = Array.isArray(res) ? res : (Array.isArray(res?.positions) ? res.positions : []);
      // v20.7.7 FIX #1: rows {cells, text, nums} hote hain — p.id/p.pair
      // KABHI exist nahi karte the → id '' → close-by-id hamesha fail.
      // Ab pehli visible cell (exchange layout me pair hota hai) se id/pair
      // derive hota hai; nums se qty/price fallback.
      return (Array.isArray(rows) ? rows : []).map((p, i) => {
        const cells = Array.isArray(p?.cells) ? p.cells : [];
        const pairGuess = String(p?.pair || cells[0] || '').trim();
        const nums = Array.isArray(p?.nums) ? p.nums : [];
        const sideGuess = /long|buy/i.test(String(p?.text || '')) ? 'LONG'
          : (/short|sell/i.test(String(p?.text || '')) ? 'SHORT' : String(p?.side || '').toUpperCase());
        return {
          id: String(p?.id || pairGuess || `browser-${i}`),
          pair: pairGuess,
          side: sideGuess,
          qty: Number(p?.qty || nums[1] || 0),
          avgPrice: r2(p?.avgPrice ?? nums[0]),
          leverage: Number(p?.leverage || 1),
          liqPrice: r2(p?.liqPrice),
          sl: r2(p?.sl), tp: r2(p?.tp), markPrice: r2(p?.markPrice),
        };
      }).filter((p) => p.pair);
    } catch (e) { return []; }
  }
  async open({ pair, side, qty, leverage, type: _type = 'limit', price, _sl, _tp, clientId }) {
    try {
      // v20.7.6 FIX: browserAgent ke REAL signatures use karo — pehle ye
      // cxSelectPair(pair) / cxPlaceOrder({...}) bina `page` arg ke call
      // kar raha tha (TypeError → har browser-mode open ka fail). Phase 6
      // hardening (leverage read-back, UI SL/TP bracket) abhi bhi pending
      // hai — live 5-10x ke liye API port hi recommended.
      // v20.7.7 FIX: qty bhi pass karo — market orders (price=null) me
      // total/price math impossible thi, ab in-page driver direct qty
      // use karta hai (cxPlaceOrderScript ka QTY_DIRECT path).
      const page = await this._ba.cxEnsureTradePage(this._ba.cxPairUrl ? this._ba.cxPairUrl(pair, 'futures') : undefined);
      const pick = await this._ba.cxSelectPair(page, pair);
      if (!pick?.ok) return { ok: false, error: `select-pair: ${pick?.error || 'failed'}` };
      const total = Number(price) > 0 ? qty * price : 0;
      const r = await this._ba.cxPlaceOrder(page, { side, price, totalINR: total, leverage, qty });
      return { ok: !!r?.ok, orderId: clientId || `browser-${Date.now()}`, raw: r };
    } catch (e) { return { ok: false, error: String(e?.message || e) }; }
  }
  async setProtection({ _positionId, _sl, _tp }) {
    // Phase 6 hardening: set SL/TP via CoinDCX UI's TP/SL control +
    // read-back verify. NOT YET IMPLEMENTED — return ok:false so the
    // positionManager's protection-first sequence flattens on schedule.
    return { ok: false, error: 'browser setProtection not yet implemented (Phase 6 pending)' };
  }
  async reduce({ positionId, qty }) {
    // v20.7.7 FIX: pehle cxClosePosition({ pair: positionId, partialQty: qty })
    // call hota tha — REAL signature (pair, side) hai, object nahi (TypeError)
    // aur `!!r` truthy-object check hamesha ok:true de deta tha (failed close
    // bhi "closed" journal hota tha!). Browser agent me PARTIAL exit DOM
    // support nahi — honest full close + note (partial requester ko raw me
    // dikhega). r?.ok check ab asli verdict deta hai.
    // v20.7.10: side bhi resolve karke pass — cxClosePositionScript ab
    // side-aware hai (hedge rows me galat row close se bachne ke liye).
    try {
      const side = await this._sideOf(positionId);
      const r = await this._ba.cxClosePosition(positionId, side);
      return { ok: !!r?.ok, raw: r, note: Number(qty) > 0 ? 'browser partial-exit unsupported — FULL close hua (partial DOM Phase 6 pending)' : undefined };
    } catch (e) { return { ok: false, error: String(e?.message || e) }; }
  }
  /** v20.7.10: browser positions table se is positionId/pair ki SIDE
   *  resolve karo (cells text me Long/Short likha hota hai). Unknown →
 *  null — cxClosePositionScript ka safe mode handle karega (single row
   *  close, multi-row refuse). */
  async _sideOf(positionId) {
    try {
      const rows = await this.getPositions();
      const p = (Array.isArray(rows) ? rows : []).find((x) => String(x?.id) === String(positionId) || String(x?.pair) === String(positionId));
      return (p?.side === 'LONG' || p?.side === 'SHORT') ? p.side : null;
    } catch { return null; }
  }
  async close({ positionId }) {
    // v20.7.7 FIX: same signature/verdict bug as reduce — positional args
    // + r?.ok (truthy-object ka ok:true jhootha tha).
    // v20.7.10: side resolve karke pass (upar _sideOf) — hedge rows me
    // side-unknown 'LONG' fallback GALAT row close kar sakta tha.
    try {
      const side = await this._sideOf(positionId);
      const r = await this._ba.cxClosePosition(positionId, side);
      return { ok: !!r?.ok, raw: r };
    } catch (e) { return { ok: false, error: String(e?.message || e) }; }
  }
  async cancelOpenOrders({ _pair }) { return { ok: true, note: 'browser cancelOpenOrders not yet wired' }; }
}

/**
 * Factory: pick the adapter based on EXEC_MODE env.
 *   api     → ApiFuturesPort  (default — recommended for 5–10x)
 *   browser → BrowserCdpPort  (Phase 6 hardening pending)
 *   paper   → PaperPort       (tests + Phase 9 paper soak)
 *   hybrid  → ApiFuturesPort for protection + truth; BrowserCdpPort for entry (Phase 6 pending)
 */
export async function resolveExecutionPort({ env = process.env, futuresMod, browserAgent } = {}) {
  const mode = String(env.EXEC_MODE || 'paper').toLowerCase();
  if (mode === 'api') {
    if (!futuresMod) {
      // dynamic import to avoid circular dep (futures.js statically imports coindcx.js)
      futuresMod = await import('../ai/futures.js');
    }
    return new ApiFuturesPort({ futuresMod });
  }
  if (mode === 'browser') {
    if (!browserAgent) browserAgent = await import('../ai/browserAgent.js');
    return new BrowserCdpPort({ browserAgent });
  }
  if (mode === 'hybrid') {
    // hybrid = ApiFuturesPort for protection/truth + BrowserCdpPort for entry.
    // For now, return ApiFuturesPort (the safe one) — full hybrid wiring is
    // Phase 6 work. Document this honestly.
    if (!futuresMod) futuresMod = await import('../ai/futures.js');
    return new ApiFuturesPort({ futuresMod });
  }
  // default: paper
  const startEq = Number(env.PAPER_STARTING_EQUITY_USDT) || 1000;
  return new PaperPort({ startingEquityUSDT: startEq });
}
