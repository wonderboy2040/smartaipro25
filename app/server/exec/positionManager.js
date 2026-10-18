// ============================================================
// server/exec/positionManager.js — v20.7 PROTECTION-FIRST POSITION MANAGER
// ------------------------------------------------------------
// Phase 4 of the auto-trading plan (app/docs/audit.md §4). The state
// machine for: open → fill confirm → leverage mismatch close + alert
// → setProtection({sl, tp}) read-back confirm → flatten-on-fail. Plus
// the T1/T2/runner trail/give-back exit ladder. Plus tiered reversal
// (candle-close, not 30s tick).
//
// CORE RULE (audit doc §3): "Koi live position tab tak 'valid' nahi
// jab tak exchange-resident SL confirmed na ho." → the protection-
// first sequence (4a) is the ONLY entry path. If setProtection fails,
// the position is FLATTENED immediately (market close) + Telegram
// alert. No naked leveraged position is ever left open.
//
// EXIT LADDER (4b):
//   ENTRY  → SL on exchange (monitored)
//   T1     (≈1R or plan.target1) → 40% reduce, SL → breakeven + fees
//   T2     (≈2R / target2)        → 30% reduce, SL → T1 level
//   RUNNER (30%)                  → ATR chandelier trail (2.5×ATR(14) on
//                                  15m, ratchet-only via ratchetSl)
//   GIVE-BACK lock                 → peak unrealized ≥1.5R & retrace
//                                   >35% of peak → close runner
//   TIME STOP                      → N candles me T1 nahi mila → exit
//   FUNDING/EVENT                  → funding extreme ya eventGuard
//                                   window → size cut ya exit
//
// REVERSAL (4c, candle-close not tick):
//   1 evidence class → SL tighten to BE / lock profit
//   2 classes        → 50% reduce
//   3+ classes       → full close
//   SL/liq proximity → tick-level immediate (no candle wait)
//
// The manager NEVER throws. Every failure degrades to a safe action
// (flatten + alert). All actions go through the ExecutionPort so the
// same code path runs in api / browser / paper mode.
// ============================================================
import { ratchetSl } from '../ai/coindcxOrders.js';
import { computeSizing, liqDistancePct as _liqDistancePct, tierLeverage } from './sizing.js';

const r2 = (v) => (Number.isFinite(v) ? Math.round(v * 100) / 100 : null);
// Quantities use the instrument qty step (0.0001) — NEVER r2 (2 decimals would
// round a small BTC/ETH reduce-qty down to 0 and silently skip the exit).
const qtyR = (v) => (Number.isFinite(v) ? Math.floor(v * 10000 + 1e-9) / 10000 : 0);

const DEFAULTS = Object.freeze({
  // exit ladder (audit doc §4b — config-driven, defaults from the plan)
  exitT1R: 1.0,        exitT1Pct: 40,
  exitT2R: 2.0,        exitT2Pct: 30,
  trailAtrMult: 2.5,
  givebackArmR: 1.5,   givebackPct: 35,
  entryLimitTtlSec: 180,
  fillPollMs: 2000,     // v20.7.10: fill-confirm poll cadence (tests 0-1ms)
  timeStopCandles: 8,   // N candles (15m) — ~2h with no T1 → exit
  // reversal tiers (audit doc §4c)
  revCandleTf: '15m',
  revClassesReduce: 2,  revClassesClose: 3,
});

export class PositionManager {
  constructor({ port, ramGovernor = null, alertSink = null, cfg = {} } = {}) {
    if (!port) throw new Error('PositionManager: port is required');
    this._port = port;
    this._ram = ramGovernor; // { ramCanEnter, ramCanLLM } — gates
    this._alert = typeof alertSink === 'function' ? alertSink : null;
    this._cfg = { ...DEFAULTS, ...cfg };
    // in-memory position state (mirrors exchange but with our exit-stage + trail)
    this._state = new Map(); // id → { stage, peakUnrealizedR, trailSl, openedAt, candlesSeen, clientId }
  }

  /**
   * 4a. PROTECTION-FIRST ENTRY SEQUENCE.
   * Steps: pre-trade checks → computeSizing → port.open() → fill
   * confirm via port.getPositions() → leverage mismatch close + alert
   * → port.setProtection({sl, tp}) read-back confirm → flatten-on-fail.
   * Returns { ok: true, positionId } or { ok: false, error, stage }.
   * NEVER throws. Never leaves a naked position.
   */
  async protectionFirstEntry({ signal, plan, now = Date.now() }) {
    const log = (stage, msg) => { try { this._log(`[posmgr:${stage}] ${msg}`); } catch { /* mark refresh best-effort */ } };

    // ---- pre-trade gate: RAM governor (if armed) ----
    if (this._ram && typeof this._ram.ramCanEnter === 'function' && !this._ram.ramCanEnter()) {
      return { ok: false, stage: 'ram-gate', error: 'RAM governor is RED — new entries blocked' };
    }

    // ---- pre-trade gate: signal tier ----
    const tier = String(signal?.superIntel?.tier || signal?.grade || '').toUpperCase();
    if (!['STRONG', 'ELITE', 'ACTION'].includes(tier)) {
      return { ok: false, stage: 'tier-gate', error: `signal tier ${tier || '—'} below ACTION (no leverage bump)` };
    }

    // ---- 1. sizing (Phase 3 computeSizing + Phase 2 port.getEquity) ----
    const equity = await this._port.getEquity();
    if (!(equity?.freeUSDT > 0)) {
      return { ok: false, stage: 'equity', error: `insufficient free equity: ${equity?.freeUSDT ?? '—'} USDT` };
    }
    const entry = Number(plan?.entry || signal?.ltp);
    const stopLoss = Number(plan?.stopLoss);
    if (!(entry > 0) || !(stopLoss > 0) || stopLoss === entry) {
      return { ok: false, stage: 'plan', error: 'plan.entry + plan.stopLoss required (stopLoss !== entry)' };
    }
    const sizing = computeSizing({
      equity: equity.totalUSDT || equity.freeUSDT,
      freeUSDT: equity.freeUSDT,
      entry, stopLoss,
      riskPct: Number(signal?.__riskPct || 1),
      tierLeverage: this._tierLeverage(tier, signal),
      instrument: { qtyStep: 0.0001, minQty: 0.0001, maxLeverage: 10 },
    });
    if (sizing.verdict !== 'OK') {
      return { ok: false, stage: 'sizing', error: `${sizing.verdict}: ${sizing.reason || ''}` };
    }

    // ---- 2. open via port ----
    const clientId = `pm-${now}-${Math.random().toString(36).slice(2, 8)}`;
    // v20.7.12 [H2-5]: pre-open position snapshot — fill-confirm matcher
    // pehle (pair + |Δqty|<1%) par match karta tha, jo account me PEHLE SE
    // khuli same-pair position se bind ho sakta tha (setProtection us
    // PURANI position ke SL ko overwrite kar deta tha). Ab match sirf
    // OPEN ke BAAD naya (id pre-snapshot me nahi) rows me pehle dhundta
    // hai; legacy pair+qty fallback sirf tab jab koi naya row na mile.
    const preIds = new Set((await this._port.getPositions().catch(() => [])).map((p) => String(p.id)));
    const openRes = await this._port.open({
      pair: signal.pair || signal.symbol,
      side: signal.side,
      qty: sizing.qty,
      leverage: sizing.leverage,
      type: 'limit',
      price: entry,
      sl: stopLoss,
      tp: plan?.target1,
      clientId,
    });
    if (!openRes?.ok) {
      return { ok: false, stage: 'open', error: openRes?.error || 'port.open failed' };
    }

    // ---- 3. fill confirm via port.getPositions() ----
    // v20.7.10 FIX: pehle SINGLE re-read thi (~0ms baad) — limit order at
    // entry us waqt tak KABHI fill nahi hota tha → HAR entry 'fill-confirm'
    // fail + cancel (jo khud adapter-dependent stub hai — BrowserCdpPort
    // me aaj bhi real cancel nahi). Ab entryLimitTtlSec (180s default)
    // tak fillPollMs (2s) cadence se POLL karo — resting limit ko real
    // fill window milta hai.
    // v20.7.12 [M-3]: progressive backoff (2s → 2.6s → 3.4s → … cap 8s)
    // sirf PRODUCTION cadence (pollMs ≥ 1s) pe — tests 0-1ms exact-cadence
    // par chalte hain, unka timing intact rehta hai. ~90 private calls/entry
    // ab ~30 pe girte hain.
    const pairWant = signal.pair || signal.symbol;
    const ttlMs = Math.max(10, Number(this._cfg.entryLimitTtlSec) || 180) * 1000;
    const pollMs = Math.max(0, Number(this._cfg.fillPollMs ?? 2000));
    const deadline = Date.now() + ttlMs;
    let filled = null;
    let pollN = 0;
    while (true) {
      const positions = await this._port.getPositions();
      const pairRows = (positions || []).filter((p) => p.pair === pairWant);
      // v20.7.12 [H2-5]: NEW rows (post-open) get priority — partial fill
      // bhi pakda jata hai (qty ≠ planned, par NEW row hai → wahi hamara
      // fill hai; ladder actual qty pe chalti hai).
      filled = pairRows.find((p) => !preIds.has(String(p.id)) && p.qty > 0) || null;
      if (!filled) {
        // legacy fallback: same pair + qty within 1% (pre-existing position
        // ka risk — sirf tab jab koi naya row hi na aaya ho)
        filled = pairRows.find((p) => Math.abs(p.qty - sizing.qty) < sizing.qty * 0.01) || null;
      }
      if (filled || Date.now() >= deadline) break;
      if (pollMs > 0) {
        const wait = pollMs >= 1000 ? Math.min(8000, Math.round(pollMs * Math.pow(1.3, pollN))) : pollMs;
        pollN++;
        await new Promise((res) => setTimeout(res, wait));
      }
    }
    if (!filled) {
      // unfilled → cancel + exit (cancel primitive adapter-dependent —
      // honest note error me, exchange app manually verify karo)
      const cancelRes = await this._port.cancelOpenOrders({ pair: pairWant });
      return { ok: false, stage: 'fill-confirm', error: `limit order ${ttlMs / 1000}s me fill nahi hua — cancel attempted${cancelRes?.note ? ` (${cancelRes.note})` : ''}; exchange app me resting order manually verify karo`, cancel: cancelRes };
    }

    // ---- 4. leverage mismatch → close + alert ----
    if (Number(filled.leverage) > 0 && Math.abs(filled.leverage - sizing.leverage) >= 1) {
      log('leverage-mismatch', `planned ${sizing.leverage}x, exchange ${filled.leverage}x → flatten`);
      // v21.1.1 [audit B9]: flatten VERDICT check + retry — pehle close ka
      // result ignore hota tha aur alert unconditional "FLATTENED" bolta
      // tha. Close reject/time-out ho to message jhoot bolta tha aur position
      // naked reh jaati thi. Ab: retry ×2, phir HONEST failure alert.
      const levFlat = await this._flattenWithRetry(filled);
      if (levFlat.ok) {
        this._alertCall(`⚠️ LEVERAGE MISMATCH on ${filled.pair}: planned ${sizing.leverage}x, exchange ${filled.leverage}x. Position FLATTENED.`);
      } else {
        this._alertCall(`🚨 LEVERAGE MISMATCH on ${filled.pair}: planned ${sizing.leverage}x, exchange ${filled.leverage}x. FLATTEN FAILED (${levFlat.error}) — MANUAL CLOSE KARO, position abhi bhi khuli hai!`);
      }
      return { ok: false, stage: 'leverage-mismatch', error: `exchange leverage ${filled.leverage}x ≠ planned ${sizing.leverage}x — ${levFlat.ok ? 'flattened' : `flatten FAILED: ${levFlat.error}`}` };
    }

    // ---- 5. setProtection({sl, tp}) → read-back confirm ----
    const protRes = await this._port.setProtection({
      positionId: filled.id,
      sl: stopLoss,
      tp: plan?.target1,
    });
    if (!protRes?.ok) {
      // PROTECTION FAILED → flatten immediately (the CORE RULE)
      log('protection-fail', `setProtection failed: ${protRes?.error} → FLATTEN per core rule`);
      // v21.1.1 [audit B9]: verdict-checked flatten (upar wale jaisa hi)
      const protFlat = await this._flattenWithRetry(filled);
      if (protFlat.ok) {
        this._alertCall(`🚨 PROTECTION MISSING on ${filled.pair}: setProtection failed (${protRes?.error}). Position FLATTENED — no naked leveraged position left open.`);
      } else {
        this._alertCall(`🚨🚨 PROTECTION MISSING on ${filled.pair}: setProtection failed (${protRes?.error}) AUR FLATTEN BHI FAIL (${protFlat.error}) — NAKED LEVERAGED POSITION. MANUAL CLOSE KARO ABHI!`);
      }
      return { ok: false, stage: 'protection-fail', error: `setProtection failed: ${protRes?.error} — ${protFlat.ok ? 'flattened' : `flatten FAILED: ${protFlat.error}`}` };
    }

    // ---- 6. record state for the exit ladder ----
    // origRisk anchors the R-multiple ladder to the ORIGINAL stop distance.
    // (st.sl later moves to breakeven/T1 as the ladder progresses — deriving
    // R from the mutated SL would collapse the ladder math: T2 would trigger
    // at entry*1.001 instead of a true 2R. v20.7.3 fix.)
    this._state.set(filled.id, {
      stage: 'ENTRY',
      peakUnrealizedR: 0,
      trailSl: stopLoss,
      openedAt: now,
      candlesSeen: 0,
      clientId,
      pair: filled.pair,
      side: filled.side,
      entry: filled.avgPrice,
      sl: stopLoss,
      origRisk: Math.abs(Number(filled.avgPrice) - stopLoss),
      tp1: plan?.target1, tp2: plan?.target2,
      qty: filled.qty,
      leverage: filled.leverage,
      riskUSDT: sizing.riskUSDT,
    });

    return { ok: true, positionId: filled.id, sizing, clientId,
      // v20.9.3 FIX (M): fill facts for the journal row (routes.js /api/exec/enter
      // ab ek j.positions row likhta hai — restart ke baad PM hydration ke liye).
      fill: { price: Number(filled.avgPrice) || null, qty: Number(filled.qty) || null, leverage: Number(filled.leverage) || null } };
  }

  /**
   * v20.9.3 FIX (M) — BOOT HYDRATION from the shared journal. PM ka _state
   * in-memory tha: ek restart ke baad /api/exec/enter wali positions LADDER
   * SE GHAT jaati thi (15m driver no-op — state khali; watchFuturesPositions
   * bhi unhe nahi dekhta tha kyunki route sirf ORDER entry likhta tha) —
   * sirf entry-armed native exchange SL/TP bacha rehta tha. Ab route ek
   * positions row (source 'exec-enter', execManaged:true) likhta hai aur
   * boot yahan se state wapas seed karta hai.
   */
  hydrateFromJournal(rows) {
    let n = 0;
    for (const p of (Array.isArray(rows) ? rows : [])) {
      if (!p || p.source !== 'exec-enter' || !p.execManaged) continue;
      if (!['OPEN', 'UNKNOWN'].includes(String(p.status || ''))) continue;
      const id = String(p.exchangePositionId || p.id || '');
      if (!id || this._state.has(id)) continue;
      const entry = Number(p.entryPrice) || 0;
      const sl = Number(p.sl) || 0;
      const qty = Number(p.qty) || 0;
      if (!(entry > 0) || !(qty > 0)) continue; // honest skip — ladder math needs these
      this._state.set(id, {
        stage: 'ENTRY', peakUnrealizedR: 0, candlesSeen: 0,
        clientId: 'hydrate-' + id.slice(0, 12),
        pair: p.pair, side: p.side,
        entry, sl: sl > 0 ? sl : entry, origRisk: sl > 0 ? Math.abs(entry - sl) : entry * 0.01,
        tp1: Number(p.tp) || null, tp2: Number(p.tp2) || null,
        qty, leverage: Number(p.leverage) || 1,
        riskUSDT: sl > 0 ? Math.abs(entry - sl) * qty : null,
        openedAt: Number(p.openedAt) || Date.now(),
      });
      n++;
    }
    if (n > 0) { try { this._log(`[posmgr:hydrate] ${n} exec-enter position(s) journal se ladder-state me wapas laayi`); } catch { /* log best-effort */ } }
    return n;
  }

  /**
   * 4b. EXIT LADDER TICK. Called on every candle-close (15m default)
   * with the live mark price for each open position.
   * Returns the list of actions taken (for journal + UI).
   */
  async tick({ pricesByPair, now: _now = Date.now(), atrByPair = {} }) {
    const actions = [];
    const positions = await this._port.getPositions();
    for (const p of positions) {
      const st = this._state.get(p.id);
      if (!st) continue; // orphan — reconcile loop adopts
      const mark = Number(pricesByPair[p.pair] ?? p.markPrice);
      if (!(mark > 0)) continue;
      // v20.9.1 [H3]: exec-stack PaperPort ka mark REFRESH — pehle sirf
      // Bot-Lab apne port pe setMarkPrice karta tha; resolveExecutionPort()
      // wala port entry-price mark pe frozen rehta tha → paper close/reduce
      // HAMESHA ~0 PnL book karta tha (realized/equity-unrealized garbage).
      try { this._port.setMarkPrice?.(p.pair, mark); } catch { /* best-effort */ }
      st.candlesSeen = (st.candlesSeen || 0) + 1;
      const r = this._unrealizedR(st, mark);
      st.peakUnrealizedR = Math.max(st.peakUnrealizedR || 0, r);

      // ---- v20.9.1 [L]: pending SL-move RETRY — pehle 'retry next candle'
      // alert jhooth bolta tha (koi retry tha hi nahi); ab bePending stamp
      // hota hai aur har candle pe protect dobara try hota hai jab tak set
      // na ho jaye (exchange-resident original SL beech-beech me guard hai).
      if (st.bePending != null && (st.stage === 'T1_HIT' || st.stage === 'RUNNER')) {
        const protRes = await this._port.setProtection({ positionId: p.id, sl: st.bePending, tp: st.tp2 });
        if (protRes?.ok) { st.sl = st.bePending; st.bePending = null; actions.push({ id: p.id, kind: 'protect-retry', newSl: st.sl }); }
      }

      // ---- time stop (Phase 4b) ----
      if (st.stage === 'ENTRY' && st.candlesSeen > this._cfg.timeStopCandles) {
        const res = await this._port.close({ positionId: p.id });
        // v20.7.10 FIX: failed close pe state delete MAT karo — position
        // exchange pe zinda hai, PM ka ladder usse agla candle phir pakad
        // lega (pehle failed close = position abandoned, koi retry nahi).
        if (res?.ok) { actions.push({ id: p.id, kind: 'time-stop', close: res }); this._state.delete(p.id); }
        else { actions.push({ id: p.id, kind: 'time-stop:failed', close: res }); this._alertCall(`⚠️ TIME-STOP close FAILED on ${p.pair}: ${res?.error || 'unknown'} — retry next candle, exchange app check karo.`); }
        continue;
      }

      // ---- T1 hit (≈1R) ----
      if (st.stage === 'ENTRY' && this._hitT1(st, mark)) {
        const reduceQty = qtyR(st.qty * (this._cfg.exitT1Pct / 100));
        // v20.9.1 [H3]: sub-precision qty pe reduceQty 0 round hota hai —
        // PaperPort no-op 'ok' deta tha aur stage PHANTOM advance (40%
        // de-risk journal jo hua hi nahi + full-size BE ride); API port
        // infinite reject-retry. Ab: split possible nahi → T1 pe FULL exit
        // (proTraderAuto ka hi 'qty too small to split' rule).
        if (!(reduceQty > 0)) {
          const res = await this._port.close({ positionId: p.id });
          if (res?.ok) { actions.push({ id: p.id, kind: 't1-full-exit', why: 'qty too small to split', close: res }); this._state.delete(p.id); }
          else { actions.push({ id: p.id, kind: 't1-full-exit:failed', close: res }); this._alertCall(`⚠️ T1 full-exit FAILED on ${p.pair}: ${res?.error || 'unknown'} — retry next candle, exchange app check karo.`); }
          continue;
        }
        const redRes = await this._port.reduce({ positionId: p.id, qty: reduceQty });
        // v20.7.10 FIX: reduce fail → stage ADVANCE MAT (pehle phantom
        // 40% trim journal hota tha — jo kabhi hua hi nahi — aur SL BE
        // pe move ho jata tha; runner ladder phantom qty pe chalti thi).
        // Agla candle phir try hoga.
        if (!redRes?.ok) {
          actions.push({ id: p.id, kind: 't1:reduce-failed', reduceQty, close: redRes });
          this._alertCall(`⚠️ T1 reduce FAILED on ${p.pair}: ${redRes?.error || 'unknown'} — ladder retry next candle.`);
          continue;
        }
        // SL → breakeven + fees (rough: breakeven = entry; fees ~0.05%)
        const be = st.side === 'LONG' ? st.entry * 1.0005 : st.entry * 0.9995;
        const newSl = st.side === 'LONG' ? Math.max(st.sl, be) : Math.min(st.sl, be);
        const protRes = await this._port.setProtection({ positionId: p.id, sl: newSl, tp: st.tp2 });
        if (!protRes?.ok) {
          // v20.7.10: SL→BE move fail ho sakta hai — position ke paas PURANA
          // (original) SL abhi bhi exchange-resident hai, ye naked nahi hai.
          // Stage advance karo (trim ho chuka), SL tight retry next candle.
          // v20.9.1: retry ab REAL hai (bePending stamp → tick-top retry).
          actions.push({ id: p.id, kind: 't1:protect-failed', newSl, close: protRes });
          st.bePending = newSl;
          this._alertCall(`⚠️ T1 SL→BE move FAILED on ${p.pair} (${protRes?.error || 'unknown'}) — original SL active, retry next candle.`);
        } else { st.sl = newSl; }
        st.qty = Math.max(0, st.qty - reduceQty); // v20.7.10: local qty bhi trim
        st.stage = 'T1_HIT';
        actions.push({ id: p.id, kind: 't1', reduceQty, newSl: protRes?.ok ? newSl : st.sl });
      }
      // ---- T2 hit (≈2R) ----
      else if (st.stage === 'T1_HIT' && this._hitT2(st, mark)) {
        const reduceQty = qtyR(st.qty * (this._cfg.exitT2Pct / 100));
        // v20.9.1 [H3]: T2 me bhi wahi sub-precision guard — 0-qty reduce
        // phantom RUNNER advance hota tha. Full close instead.
        if (!(reduceQty > 0)) {
          const res = await this._port.close({ positionId: p.id });
          if (res?.ok) { actions.push({ id: p.id, kind: 't2-full-exit', why: 'qty too small to split', close: res }); this._state.delete(p.id); }
          else { actions.push({ id: p.id, kind: 't2-full-exit:failed', close: res }); this._alertCall(`⚠️ T2 full-exit FAILED on ${p.pair}: ${res?.error || 'unknown'} — retry next candle.`); }
          continue;
        }
        const redRes = await this._port.reduce({ positionId: p.id, qty: reduceQty });
        if (!redRes?.ok) {
          actions.push({ id: p.id, kind: 't2:reduce-failed', reduceQty, close: redRes });
          this._alertCall(`⚠️ T2 reduce FAILED on ${p.pair}: ${redRes?.error || 'unknown'} — ladder retry next candle.`);
          continue;
        }
        // SL → T1 level (1R from the ORIGINAL stop distance — see _rLevel)
        const t1Level = this._rLevel(st, 1);
        const protRes = await this._port.setProtection({ positionId: p.id, sl: t1Level, tp: st.tp2 });
        if (!protRes?.ok) {
          actions.push({ id: p.id, kind: 't2:protect-failed', newSl: t1Level, close: protRes });
          st.bePending = t1Level;
          this._alertCall(`⚠️ T2 SL→T1 move FAILED on ${p.pair} (${protRes?.error || 'unknown'}) — BE SL active, retry next candle.`);
        } else { st.sl = t1Level; }
        st.qty = Math.max(0, st.qty - reduceQty); // v20.7.10: local qty bhi trim
        st.stage = 'RUNNER';
        actions.push({ id: p.id, kind: 't2', reduceQty, newSl: protRes?.ok ? t1Level : st.sl });
      }
      // ---- RUNNER: ATR chandelier trail (ratchet-only) ----
      else if (st.stage === 'RUNNER') {
        const atr = Number(atrByPair[p.pair] || (st.entry * 0.012));
        const trail = st.side === 'LONG'
          ? mark - this._cfg.trailAtrMult * atr
          : mark + this._cfg.trailAtrMult * atr;
        const newSl = ratchetSl(st.side, st.sl, trail);
        if (newSl !== st.sl) {
          const protRes = await this._port.setProtection({ positionId: p.id, sl: newSl, tp: null });
          if (protRes?.ok) { st.sl = newSl; actions.push({ id: p.id, kind: 'trail', newSl }); }
          else actions.push({ id: p.id, kind: 'trail:failed', newSl, close: protRes }); // v20.7.10: retry next candle
        }
        // ---- give-back lock (peak ≥1.5R & retrace >35% of peak) ----
        if (st.peakUnrealizedR >= this._cfg.givebackArmR && r < st.peakUnrealizedR * (1 - this._cfg.givebackPct / 100)) {
          const res = await this._port.close({ positionId: p.id });
          if (res?.ok) { actions.push({ id: p.id, kind: 'giveback', peakR: r2(st.peakUnrealizedR), nowR: r2(r) }); this._state.delete(p.id); }
          else { actions.push({ id: p.id, kind: 'giveback:failed', close: res }); this._alertCall(`⚠️ GIVE-BACK close FAILED on ${p.pair}: ${res?.error || 'unknown'} — retry next candle.`); }
          continue;
        }
      }

      // ---- SL hit (tick-level immediate, no candle wait) ----
      if (this._slHit(st, mark)) {
        const res = await this._port.close({ positionId: p.id });
        if (res?.ok) { actions.push({ id: p.id, kind: 'sl-hit', sl: st.sl, mark }); this._state.delete(p.id); }
        else { actions.push({ id: p.id, kind: 'sl-hit:failed', sl: st.sl, mark, close: res }); this._alertCall(`🚨 SL-HIT close FAILED on ${p.pair}: ${res?.error || 'unknown'} — NATIVE exchange SL backstop pe bharosa + retry next tick. Exchange app check karo!`); }
      }
    }
    return actions;
  }

  /**
   * 4c. TIERED REVERSAL (candle-close, not tick). Caller passes the
   * list of independent evidence classes that fired for each position.
   *   1 class → SL tighten to BE / lock profit
   *   2 classes → 50% reduce
   *   3+ classes → full close
   */
  async reversalCheck({ evidenceByPair, now: _now = Date.now() }) {
    const actions = [];
    const positions = await this._port.getPositions();
    for (const p of positions) {
      const st = this._state.get(p.id);
      if (!st) continue;
      const evList = evidenceByPair[p.pair] || [];
      const n = Array.isArray(evList) ? evList.length : 0;
      if (n >= this._cfg.revClassesClose) {
        const res = await this._port.close({ positionId: p.id });
        // v20.7.10: failed close → state rakho (retry next candle + alert);
        // pehle close fail pe bhi state delete → position abandoned.
        if (res?.ok) { actions.push({ id: p.id, kind: 'reversal-close', classes: n }); this._state.delete(p.id); }
        else { actions.push({ id: p.id, kind: 'reversal-close:failed', classes: n, close: res }); this._alertCall(`🚨 REVERSAL close FAILED on ${p.pair}: ${res?.error || 'unknown'} — retry next candle, exchange app check karo!`); }
      } else if (n >= this._cfg.revClassesReduce) {
        // 50% of what is STILL open (T1/T2 may already have trimmed the position)
        // v21.1.1 [audit B18]: qty>0 guard — sub-precision rounding 0 de sakti
        // thi (T1/T2 ke baad tiny book) → reduce({qty:0}) invalid call.
        const reduceQty = qtyR((Number(p.qty) > 0 ? Number(p.qty) : st.qty) * 0.5);
        if (!(reduceQty > 0)) {
          actions.push({ id: p.id, kind: 'reversal-reduce:skip', classes: n, note: 'reduceQty rounded to 0 (dust book) — SL-tighten hi guard hai' });
          continue;
        }
        const res = await this._port.reduce({ positionId: p.id, qty: reduceQty });
        if (res?.ok) { st.qty = Math.max(0, st.qty - reduceQty); actions.push({ id: p.id, kind: 'reversal-reduce', classes: n, reduceQty }); }
        else { actions.push({ id: p.id, kind: 'reversal-reduce:failed', classes: n, reduceQty, close: res }); this._alertCall(`⚠️ REVERSAL reduce FAILED on ${p.pair}: ${res?.error || 'unknown'} — retry next candle.`); }
      } else if (n >= 1) {
        // tighten SL to breakeven + fees
        const be = st.side === 'LONG' ? st.entry * 1.0005 : st.entry * 0.9995;
        const newSl = st.side === 'LONG' ? Math.max(st.sl, be) : Math.min(st.sl, be);
        if (newSl !== st.sl) {
          const res = await this._port.setProtection({ positionId: p.id, sl: newSl, tp: null });
          if (res?.ok) { st.sl = newSl; actions.push({ id: p.id, kind: 'reversal-tighten', classes: n, newSl }); }
          else actions.push({ id: p.id, kind: 'reversal-tighten:failed', classes: n, newSl, close: res });
        }
      }
    }
    return actions;
  }

  // ---- helpers ----

  /**
   * v21.1.1 [audit B9]: verdict-checked flatten with one retry.
   * Pehle call-sites `await this._port.close()` ka result ignore karti
   * thi aur unconditional "FLATTENED" alert bhejti thi. Paper/ApiPort ka
   * close {ok:false, error} return kar sakta hai (200-wrapped rejection /
   * timeout) — us case me position naked reh jaati thi aur message jhoot
   * bolta tha. Retry ×2 (1s gap), phir honest verdict.
   */
  async _flattenWithRetry(filled, { retries = 1, log: _log = () => {} } = {}) {
    let lastErr = 'unknown';
    for (let i = 0; i <= retries; i++) {
      try {
        const res = await this._port.close({ positionId: filled.id });
        if (res?.ok !== false) return { ok: true, res };
        lastErr = String(res?.error || 'wrapped rejection');
      } catch (e) { lastErr = String(e?.message || e); }
      if (i < retries) await new Promise(r => setTimeout(r, 1000));
    }
    return { ok: false, error: lastErr };
  }
  _tierLeverage(tier, signal) {
    // map signal tier + verifiedScore + regimeAligned + slDistPct + fundingNormal → 5/7/10x
    // (delegates to sizing.js::tierLeverage — static import; the old dynamic
    // require() could never run inside an ES module and silently pinned
    // leverage to 5x. v20.7.3 fix.)
    try {
      return tierLeverage({
        tier,
        verifiedScore: signal?.verifiedScore ?? signal?.__verifiedScore,
        regimeAligned: signal?.__regimeAligned,
        slDistPct: signal?.__slDistPct,
        fundingNormal: signal?.__fundingNormal,
      }) || 5;
    } catch { return 5; }
  }
  _unrealizedR(st, mark) {
    const pnl = (st.side === 'LONG' ? 1 : -1) * st.qty * (mark - st.entry);
    const risk = st.riskUSDT || (st.qty * Math.abs(st.entry - st.sl));
    return risk > 0 ? pnl / risk : 0;
  }
  _hitT1(st, mark) {
    const t1 = this._rLevel(st, 1);
    return st.side === 'LONG' ? mark >= t1 : mark <= t1;
  }
  _hitT2(st, mark) {
    const t2 = this._rLevel(st, 2);
    return st.side === 'LONG' ? mark >= t2 : mark <= t2;
  }
  _rLevel(st, rMultiple) {
    // R multiples anchor to the ORIGINAL risk (entry → initial stop), NOT the
    // live st.sl — after T1 the SL sits at breakeven, so |entry − st.sl| ≈ 0.05%
    // of entry and the ladder would collapse (T2 would fire one candle after
    // T1 at essentially the same price). v20.7.3 fix.
    const risk = st.origRisk ?? Math.abs(st.entry - st.sl);
    return st.side === 'LONG' ? st.entry + rMultiple * risk : st.entry - rMultiple * risk;
  }
  _slHit(st, mark) {
    return st.side === 'LONG' ? mark <= st.sl : mark >= st.sl;
  }
  _log(msg) { try { console.error(msg); } catch { /* close best-effort — verdict checked by caller */ } }
  _alertCall(msg) { if (this._alert) try { this._alert(msg); } catch { /* close best-effort — verdict checked by caller */ } }

  /**
   * Forget a position from manager state (the reconciler calls this for
   * GHOSTS — positions the exchange no longer returns, i.e. closed
   * off-book by native SL/TP/liq/manual). Without this the ghost sat in
   * _state forever and re-alerted every reconcile tick. v20.7.3.
   */
  forget(positionId) { return this._state.delete(positionId); }

  // test hooks
  _stateForTests() { return Array.from(this._state.entries()).map(([id, s]) => ({ id, ...s })); }
}

// Re-export ratchetSl from coindcxOrders (the trail uses this)
export { ratchetSl };
