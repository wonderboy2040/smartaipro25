// ============================================================
// server/bots/botRunner.js — Jev Bot Lab v20.8.0
// ------------------------------------------------------------
// Plan §9 Phase 5: Node live wiring. Har 5-min bar close pe, har
// bot, har symbol:
//   1. fresh candles fetch/stream + STALENESS check (purana feed
//      = no trade)
//   2. strategy.prepare (SAME feature code jo backtest me tha —
//      shared spec import, not a port)
//   3. candidate mila? snapshot banao
//   4. decider (rules/gated/jev) config se
//   5. botRisk.check() (hard rules, AI ke upar)
//   6. fee gate (p_win BACKTEST se, Jev ke claim se nahi)
//   7. execution — PaperPort default (mode PAPER hard-defaulted)
//   8. state + event log + Telegram
//
// Also: replay validation (plan §10.1) — same code path on past
// dates, decisions matched against engine records; mismatch = ek
// galat hai (usually live feature code drift, which the shared
// import now prevents by construction).
// ============================================================
import { loadAccount, saveAccount, applyTrade, accountStats } from './accounts.js';
import { loadBotState, saveBotState, appendEvent, readEvents, killSwitchActive, globalPauseActive, setKillSwitch } from './botState.js';
import { botRiskCheck, botRiskPreCheck, botRiskConfig, expectedGross, sizePosition, validatedPWin } from './botRisk.js';
import { makeDecider } from './deciders.js';
import { aiModeConfig } from './aiProviders.js';
import { runBacktest, ENGINE_DEFAULTS } from './core/engine.js';
import { nn, istDayKey } from './core/features.js';
import { istMinutes } from './core/engine.js';
import { estimateRoundTripCost } from '../ai/tradingCosts.js';
import { PaperPort } from '../exec/port.js';
import { eventGuardCheck } from '../ai/eventGuard.js';
import { regimeRoute } from './regimeRouter.js';
import { currentLossStreak } from '../risk/hardGate.js';
import { wilsonLowerBound as _wilsonLowerBound } from '../risk/hardGate.js';
import { sendTelegramMessage } from '../ai/secrets.js';
import { makeOrbCrypto } from './strategies/orbCrypto.js';
import { makeLvl } from './strategies/lvl.js';
import orbIn from './strategies/orbIn.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// v20.8.1 FIX (M — kill-switch safety): CWD-relative stateDir silently
// swapped state on alternate launch dirs (kill switches + accounts
// vanished -> a STOPPED bot resumed with reset equity). Absolute by
// default now; env BOT_STATE_DIR wins.
const DEFAULT_STATE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../data/bots');

export const STRATEGIES = {
  orb_in: { factory: () => orbIn, symbols: () => ['NIFTY'], universe: 'india' },
  orb_crypto_utc: { factory: () => makeOrbCrypto({ session: 'utc' }), symbols: () => ['BTC', 'ETH', 'SOL'], universe: 'crypto' },
  orb_crypto_london: { factory: () => makeOrbCrypto({ session: 'london' }), symbols: () => ['BTC', 'ETH'], universe: 'crypto' },
  orb_crypto_ny: { factory: () => makeOrbCrypto({ session: 'ny' }), symbols: () => ['BTC', 'ETH'], universe: 'crypto' },
  lvl: { factory: () => makeLvl({ desk: 'crypto' }), symbols: () => ['BTC', 'ETH'], universe: 'crypto' },
  lvl_in: { factory: () => makeLvl({ desk: 'india' }), symbols: () => ['NIFTY'], universe: 'india' },
};

export function botsEnabled(env = process.env) {
  const raw = env.BOTS_ENABLED;
  if (!raw) return ['orb_in', 'orb_crypto_utc', 'lvl'];
  return raw.split(',').map(s => s.trim()).filter(s => STRATEGIES[s]);
}

/** Candle provider contract: (symbol, desk) -> bars|null (oldest-first). */
export class BotRunner {
  constructor({
    stateDir = null,
    env = process.env,
    candleProvider = null,     // async (symbol, desk, botId) -> bars|null
    markPriceProvider = null,  // (symbol, desk) -> price|null (sync or async)
    jev = null,                // createJev(...) instance (BACK-COMPAT — ai.jev pe map hota hai)
    ai = null,                 // v21.14: { jev } provider registry (buildProviders se)
    execPort = null,           // PaperPort-like (open/setProtection/close)
    telegram = { enabled: false },
  } = {}) {
    this.stateDir = stateDir || env.BOT_STATE_DIR || DEFAULT_STATE_DIR;
    this.env = env;
    // v20.9.4 FIX (H2 — TG alerts silently dead in env-configured
    // deployments): sendTelegramMessage(text, env) ek {token, chatId}
    // OPTIONS object maangta hai (telegramConfig env.token/env.chatId
    // padhta hai) — pehle raw process.env pass hota tha jisme
    // env.token/env.chatId KABHI nahi hote → TG_TOKEN/TG_CHAT_ID wale
    // deployment me telegramConfig() null → har bot alert {ok:false,
    // 'telegram not configured'} tha jabki runner ko lagta tha TG ON hai
    // (telegramPush.js ka wahi bug-class jo v20.8 me fix hua tha —
    // botRunner miss ho gaya tha). Ab registerBotRoutes TG-shaped env
    // inject karta hai; nahi mile to purana env (UI-saved secrets path).
    this.tgEnv = (telegram?.env && (telegram.env.token || telegram.env.chatId))
      ? telegram.env
      : env;
    this.cfg = botRiskConfig(env);
    // v20.9.0 (A4): invalid env values (out-of-clamp / zero) ab ek baar
    // event-log me record hote hain — silent default-swap nahi.
    for (const w of this.cfg._envWarnings || []) {
      appendEvent(this.stateDir, 'orb_in', { kind: 'config_warning', reason: w });
    }
    this.candleProvider = candleProvider;
    this.markPriceProvider = markPriceProvider;
    // v21.2.0 (dual-provider plan Step-4): provider registry. Purana `jev`
    // param back-compat ke liye ai.jev pe map hota hai — existing callers
    // (tests, scripts) aise hi chalte rahenge. v21.14: laya removed.
    this.ai = {
      jev: (ai && ai.jev) || jev || null,
    };
    this.jev = this.ai.jev; // back-compat alias
    // v21.14: AI_PRIMARY / AI_SHADOW / AI_CONSENSUS_ON_DOWN (safe defaults:
    // primary=jev, shadow=off, onDown=wait).
    this.aiCfg = aiModeConfig(env);
    this.execPort = execPort;
    this.telegram = telegram;
    this.heartbeats = {};   // bot -> { at, bars, note }
    this._inTick = new Set();
    this._schedTimer = null;
    // v20.9.0 (E — alert dedupe): daily-loss / drawdown telegram alerts
    // din me ek baar per bot (har tick pe spam nahi).
    this._riskAlertedDay = {};
    // v20.8.4 FIX (H1 — settle double-book): the 60s scheduler interval
    // does NOT serialize with a still-running async settle (a run with
    // slow feeds can exceed 60s); two overlapping passes used to book the
    // SAME position's P&L twice into the account. Mirror of _inTick.
    this._inSettle = false;
  }

  strategyFor(botId) {
    const s = STRATEGIES[botId];
    if (!s) return null;
    if (!this._strategies) this._strategies = {};
    if (!this._strategies[botId]) this._strategies[botId] = s.factory();
    return this._strategies[botId];
  }

  armFor(botId) {
    const st = loadBotState(this.stateDir, botId) || {};
    return st.arm || this.env.BOTS_ARM || 'gated';
  }

  /** v21.14: LIVE provider hot-swap (server restart ke bina) — jev-only.
   *  Partial patch: sirf diye gaye fields replace hote hain (tests ka
   *  opts.jev override kabhi overwrite nahi hota). Provider attach hone
   *  par har enabled bot ke event-stream me ek provider_attached event
   *  chhodta hai — user ko decision stream me HI dikhta hai (silent
   *  recovery nahi). */
  attachAiProviders(patch = {}) {
    const prevJev = !!this.ai.jev;
    if ('jev' in patch) {
      this.ai.jev = patch.jev || null;
      this.jev = this.ai.jev; // back-compat alias
    }
    if (!prevJev && !!this.ai.jev) {
      for (const botId of botsEnabled(this.env)) {
        try {
          appendEvent(this.stateDir, botId, {
            kind: 'provider_attached', provider: 'jev',
            note: 'AI provider attached — arms live',
          });
        } catch { /* best-effort */ }
      }
    }
    return { jev: !!this.ai.jev };
  }

  /** One bot's full cycle on the latest closed bars. */
  async tick(botId, { now = Date.now() } = {}) {
    if (this._inTick.has(botId)) return { skipped: 'already_running' };
    this._inTick.add(botId);
    try {
      const strategy = this.strategyFor(botId);
      if (!strategy) return { error: 'unknown_bot' };
      const meta = STRATEGIES[botId];

      // v20.9.1 [M — fail-closed]: lotSize>1 strategies BLOCKED — engine
      // ka qty convention (riskMoney/stopDist/lotSize) vs live settle ka
      // gross (qty-units, NO lotSize) sirf lotSize===1 pe aligned hai;
      // fees/slip lotSize se multiply hote hain → koi bhi lot>1 strategy
      // live pe costs ko gross se 75x scale karti. Convention unify hone
      // tak honest skip (event me reason stamped).
      if (strategy.lotSize && strategy.lotSize !== 1) {
        appendEvent(this.stateDir, botId, { kind: 'config_warning', key: 'lot_size_unsupported', lotSize: strategy.lotSize, reason: 'lot>1 sizing/settle convention unaligned — trading blocked until unified (all shipped strategies are lotSize 1)' });
        this.heartbeats[botId] = { at: now, bars: 0, note: 'lot_size_unsupported' };
        return { error: 'lot_size_unsupported' };
      }

      // v20.8.1 FIX (H2 — contract #1): PAPER mode must not run a live
      // exec port. The old one-directional guard only checked LIVE-mode
      // without a port; an injected live port under default PAPER mode
      // would execute REAL orders labeled PAPER.
      if (this.cfg.mode === 'PAPER' && this.execPort && this.execPort.mode && this.execPort.mode !== 'paper') {
        appendEvent(this.stateDir, botId, { kind: 'config_error', reason: 'paper_mode_with_live_port' });
        return { error: 'paper_mode_with_live_port' };
      }

      // v20.8.1 FIX (H2 — flow order): kill switch + global pause are
      // checked BEFORE any decider call (a kill-switched bot used to
      // still burn paid Jev API calls before botRisk blocked the order).
      if (globalPauseActive(this.stateDir) || killSwitchActive(this.stateDir, botId)) {
        this.heartbeats[botId] = { at: now, bars: 0, note: 'kill_switch' };
        return { skipped: 'kill_switch' };
      }

      let arm = this.armFor(botId);
      // v20.8.0 graceful degradation: arm=jev without a Jev instance
      // (no TYPESAFE_API_KEY) falls back to gated — loudly recorded in
      // the event log, never a silent behavior change.
      // v21.14 (Laya removal): availability-resolve ab HAR AI arm ke liye.
      // Legacy persisted arms ('laya'/'consensus') ab honest mappings pe
      // fall back hote hain — event file me hamesha record hota hai,
      // silent kabhi nahi.
      if (arm === 'jev' && !this.ai.jev) {
        appendEvent(this.stateDir, botId, { kind: 'arm_fallback', from: 'jev', to: 'gated', reason: 'no_jev_instance' });
        arm = 'gated';
      } else if (arm === 'laya') {
        // v21.14: laya provider removed — legacy state. AI intent preserve
        // karne ke liye jev pe map karo (jev configured hai to), warna gated.
        const to = this.ai.jev ? 'jev' : 'gated';
        appendEvent(this.stateDir, botId, { kind: 'arm_fallback', from: 'laya', to, reason: this.ai.jev ? 'laya_provider_removed_v21_14' : 'laya_provider_removed_no_jev' });
        arm = to;
      } else if (arm === 'consensus') {
        // v21.14: consensus needs two providers — single-provider world me
        // jev hi decide karega (trivial consensus), warna gated.
        const to = this.ai.jev ? 'jev' : 'gated';
        appendEvent(this.stateDir, botId, { kind: 'arm_fallback', from: 'consensus', to, reason: this.ai.jev ? 'consensus_retired_single_provider' : 'no_ai_providers' });
        arm = to;
      } else if (arm === 'auto') {
        if (!this.ai.jev) {
          appendEvent(this.stateDir, botId, { kind: 'arm_fallback', from: 'auto', to: 'gated', reason: 'no_ai_providers' });
          arm = 'gated';
        }
      }
      let decider;
      try {
        // v20.9.1 [M]: eventGuard fail-open ab AUDITABLE — decider ke andar
        // ka catch silently null return karta tha (blackout hard rule disarm
        // bina kisi signal ke). Wrapper event file me config_warning chhodta
        // hai (fail-open intent is DOCUMENTED, par ab dikhta hai).
        const _egWrapped = (a) => {
          try { return eventGuardCheck(a); }
          catch (e) {
            try { appendEvent(this.stateDir, botId, { kind: 'config_warning', key: 'event_guard_unavailable', error: String(e?.message || e).slice(0, 120), note: 'blackout fail-open (documented) — guard error ko veto nahi banaya' }); } catch { /* best-effort */ }
            return null;
          }
        };
        decider = makeDecider({ arm, strategy, jev: this.jev, providers: this.ai, primary: this.aiCfg.primary, shadow: this.aiCfg.shadow, onDown: this.aiCfg.onDown, eventGuardCheck: _egWrapped });
      } catch (e) {
        appendEvent(this.stateDir, botId, { kind: 'arm_fallback', from: arm, to: 'rules', reason: String(e?.message || e) });
        arm = 'rules';
        decider = makeDecider({ arm, strategy, jev: this.jev, providers: this.ai, eventGuardCheck });
      }

      // open-position counts (v20.8.1 FIX H1: getPositions is ASYNC —
      // the old sync call returned a Promise, so counts were NaN and
      // perBot was never populated; max_open caps never fired and a
      // 3-symbol bot could open 3 positions in one tick).
      const openCounts = await this.openCounts();
      // v20.9.0 FIX (L4/eslint no-const-assign — REAL BUG): `const myOpen`
      // tha aur tick ke andar `myOpen++` (v20.8.2 cap-within-tick fix) har
      // successful open pe TypeError phenkta tha — per-symbol catch usse
      // tick_error event me nigal jata tha, isliye position OPEN to hoti
      // thi par _persistPaperPositions + telegram + openCounts increment
      // SKIP ho jate the (restart pe position draft ho sakti thi).
      let myOpen = Number(openCounts.perBot[botId]) || 0;

      let processed = 0;
      // v20.8.1 FIX (H3): 'ordered' > 'blocked' > 'wait' — the old
      // last-symbol-wins made an order on BTC followed by a wait on ETH
      // report tookAction:'wait'.
      const RANK = { ordered: 3, blocked: 2, wait: 1 };
      const bumpAction = (a) => { if ((RANK[a] || 0) > (RANK[tookAction] || 0)) tookAction = a; };
      let tookAction = null;
      for (const symbol of meta.symbols()) {
        // v20.8.1 FIX (H2 — engine parity): the backtest engine skips
        // candidate detection entirely while a position is open
        // (nextFreeIdx). Live detect() on the last closed bar used to
        // run anyway — burning the one-attempt flag and running the
        // (paid) decider before botRisk blocked it, and producing a
        // live candidate set != backtest candidate set.
        // v20.9.3 FIX (L): the cap reads the ADVERTISED knob — the old
        // hardcoded `>= 1` made BOT_MAX_OPEN_PER_BOT (clamped 1-10 in
        // botRiskConfig, honored by botRiskCheck) a silent lie for any
        // operator value >1. Default stays 1 → engine parity untouched.
        const _maxOpen = Math.max(1, Math.floor(Number(this.cfg?.maxOpenPerBot) || 1));
        if (myOpen >= _maxOpen) {
          this.heartbeats[botId] = { at: now, bars: 0, note: 'position_open' };
          continue;
        }
        try {
          const bars = await (this.candleProvider?.(symbol, meta.universe, botId));
          if (!bars || bars.length < 60) {
            this.heartbeats[botId] = { at: now, bars: 0, note: 'no_data' };
            continue;
          }
          // staleness: FEED freshness = newest bar (forming included) must
          // be within staleFeedSeconds + one interval. v20.8.1 FIX (H2):
          // the old check compared against the newest bar's START with a
          // 90s window — feeds that include the forming candle were
          // vetoed ~75% of the time and closed-only feeds ALWAYS.
          const intervalMs = 5 * 60000;
          const lastT = bars[bars.length - 1]?.time || 0;
          const feedAgeSec = lastT ? Math.max(0, (now - lastT) / 1000) : null;
          if (feedAgeSec != null && feedAgeSec > this.cfg.staleFeedSeconds + intervalMs / 1000) {
            appendEvent(this.stateDir, botId, { kind: 'skip', symbol, reason: `stale_feed(${Math.round(feedAgeSec)}s)` });
            this.heartbeats[botId] = { at: now, bars: bars.length, note: 'stale_feed' };
            continue;
          }

          const rows = strategy.prepare(bars);
          // candidate detection only on the LAST CLOSED bar (index len-1
          // is the live bar for 5m feeds that include it — we walk back
          // to the last bar that is definitively closed)
          const iSig = this.lastClosedIndex(rows, now, strategy);
          if (iSig < 0) { this.heartbeats[botId] = { at: now, bars: bars.length, note: 'no_closed_bar' }; continue; }
          processed++;
          this.heartbeats[botId] = { at: now, bars: bars.length, note: 'ok' };

          // v20.8.1 FIX (H2 — decision freshness): the engine fills at
          // the NEXT bar's open (<= one interval after the signal close).
          // A live decision older than one interval past the signal bar's
          // close can no longer honestly fill at the signal price.
          const sigCloseTs = (rows[iSig].bar?.time || 0) + intervalMs;
          if (sigCloseTs && now - sigCloseTs > intervalMs + 5000) {
            appendEvent(this.stateDir, botId, { kind: 'skip', symbol, reason: `late_decision(${Math.round((now - sigCloseTs) / 1000)}s past close)` });
            continue;
          }

          // v20.8.1 FIX (H2 — one-attempt-per-day across ticks): the
          // strategy's shared attempt box lives inside ONE prepare()
          // pass; live re-prepares every tick, so the flag reset silently
          // and a re-break the same session could trade twice (backtest
          // suppresses it). Attempts are now persisted in bot state,
          // keyed by symbol+session, and pre-burned into the fresh box.
          const sess = strategy.sessionKey ? strategy.sessionKey(rows[iSig].bar) : null;
          const attemptKey = sess != null ? `${symbol}|${sess}` : null;
          const st = loadBotState(this.stateDir, botId) || {};
          const attempts = st.attempts || {};
          if (attemptKey && attempts[attemptKey] && rows[iSig]._attempt) {
            rows[iSig]._attempt.used = true;
          }

          const state = { droppedByNaN: [] };
          const cand = strategy.detect(rows, iSig, { state, symbol, cfg: this.strategyCfg(botId) });

          // persist the burned attempt box exactly when the strategy
          // burned it (candidate formed OR range-band veto) — mirrors
          // backtest semantics idempotently.
          if (attemptKey && rows[iSig]._attempt?.used && !attempts[attemptKey]) {
            attempts[attemptKey] = rows[iSig].bar?.time || now;
            const tooOld = Object.keys(attempts).length > 500;
            saveBotState(this.stateDir, botId, { ...st, attempts: tooOld ? Object.fromEntries(Object.entries(attempts).slice(-250)) : attempts });
          }

          if (!cand) continue;

          // v20.9.0 (C3 — regime-aware routing): ORB sirf TREND me, LVL
          // sirf CHOP me. PRE-DECIDER cheap check (Jev call se pehle) —
          // classifyRegime strategy ke hi prepared rows se nikalta hai
          // (last-closed row ka emaFastSlope/atr), koi extra feed nahi.
          // BOTS_REGIME_ROUTING=off se disarm.
          const rr = regimeRoute({ botId, row: rows[iSig], env: this.env });
          if (!rr.ok) {
            appendEvent(this.stateDir, botId, { kind: 'skip', symbol, reason: rr.reason });
            bumpAction('blocked');
            continue;
          }

          // v20.9.0 (C5 — NSE opening window): pehle 15 min me naya India
          // entry nahi (09:30-09:45). ORB-IN ka apna opening-range rule
          // is se pehle hi candidate nahi banata, par LVL-IN aur koi bhi
          // future India strategy opening chop me entry de sakti thi.
          if (strategy.desk === 'india') {
            const mins = istMinutes(now);
            if (mins != null && mins < 9 * 60 + 45) {
              appendEvent(this.stateDir, botId, { kind: 'skip', symbol, reason: `india_opening_window(${mins} < 09:45)` });
              continue;
            }
          }

          // v20.9.0 (A3 — event guard for ALL arms): pre-decider HARD rule.
          // Pehle sirf gated arm ke gates me ctx.eventDay tha; rules arm
          // hamesha 'take' karta tha, jev arm ko info hi nahi thi.
          let eventGuard = null;
          try {
            const eg = eventGuardCheck({ symbol, desk: strategy.desk === 'india' ? 'INDIA' : 'CRYPTO', now });
            if (eg?.blocked) eventGuard = { blocked: true, label: eg.label || eg.event || 'blackout' };
          } catch { /* guard failure must not fake a veto */ }

          // v20.8.4 FIX (H3 — paid-call burn): caps / cooldown / daily-loss
          // are knowable BEFORE the decider runs — a jev-armed bot past its
          // 4-trade cap used to spend a paid Jev API call per candidate and
          // THEN get vetoed by the hard layer (same class as the v20.8.2
          // staleness ordering fix). Account is loaded here once and reused
          // for sizing below.
          const acc = loadAccount(this.stateDir, botId);
          const pre = botRiskPreCheck({
            cfg: this.cfg, bot: botId, account: acc,
            openCounts: {
              perBot: openCounts.perBot, total: openCounts.total,
              totalTodayPnl: this.totalTodayPnl(acc.currency),
              totalTodayStartEq: this.totalTodayStartEq(acc.currency),
            },
            now,
            eventGuard,
            // v20.9.0 (A1): aaj ka consecutive-loss streak (tilt guard) —
            // pure hardGate helper, aaj ke settled events se.
            lossStreak: this.todayLossStreak(botId, now),
          });
          if (!pre.ok) {
            appendEvent(this.stateDir, botId, { kind: 'risk_block', symbol, reasons: pre.reasons, preDecider: true });
            this._alertRiskBlock(botId, pre.reasons);
            bumpAction('blocked');
            continue;
          }

          // 4. decider
          const verdict = await decider(cand, rows[iSig]);
          appendEvent(this.stateDir, botId, {
            kind: 'decision', symbol, arm,
            action: verdict.action, reason: verdict.reason || null,
            jev: verdict.jev || null,
            // v21.2.0 (dual-provider): per-provider telemetry — consensus/
            // auto/shadow analysis (agreement %, failover counts) isi se
            // hoti hai. e.jev compat field upar wale verdict.jev se aata hai.
            ai: verdict.ai || null,
            candidate: { side: cand.side, entry: cand.entry, stop: cand.stop, target: cand.target },
          });
          if (verdict.action !== 'take') { bumpAction('wait'); continue; }

          // 5+6. hard risk + fee gate
          // v20.8.4: `acc` is loaded pre-decider (see botRiskPreCheck) and
          // reused — same tick, single-threaded, no drift possible.
          // v20.8.1 (engine parity): sizing + costs on the FILL price
          // (forming bar's open), exactly like the engine sizes on the
          // fill-bar open — not on the signal close.
          const formingOpenSz = nn(rows[iSig + 1]?.bar?.open);
          const fillPx = formingOpenSz != null && formingOpenSz > 0 ? formingOpenSz : cand.entry;
          const size = sizePosition({
            equity: acc.equity, riskPerTradePct: this.cfg.riskPerTradePct,
            stopDistance: Math.abs(fillPx - cand.stop), price: fillPx,
            leverage: 3, maxLeverage: this.cfg.maxLeverageCrypto,
            qtyUnitMin: strategy.instrumentType === 'crypto' ? 0 : 1,
          });
          if (!size) { appendEvent(this.stateDir, botId, { kind: 'skip', symbol, reason: 'sizing_failed' }); continue; }
          if (size.skip) { appendEvent(this.stateDir, botId, { kind: 'skip', symbol, reason: size.skip, wouldRiskPct: size.wouldRiskPct }); continue; }
          const cost = estimateRoundTripCost({
            qty: size.qty, entryPrice: fillPx, exitPrice: cand.target,
            instrumentType: strategy.instrumentType, mult: strategy.lotSize,
          });
          // v20.9.0 (B3 — honest pWin): per-bot AND per-arm, OOS half se,
          // Wilson LB ke saath. Unvalidated → null → LIVE me fee-gate
          // fail-closed veto; PAPER me conservative 0.35 floor + honest
          // pwin_unvalidated stamp (audit: "ya bot ko PAPER-only rakho" —
          // default mode PAPER hi hai).
          const pWinValidated = validatedPWin(loadBotState(this.stateDir, botId) || {}, arm);
          const pWinUse = pWinValidated != null ? pWinValidated
            : (this.cfg.mode === 'PAPER' ? 0.35 : null);
          const eg = expectedGross({
            pWin: pWinUse,
            rewardMoney: Math.abs(cand.target - fillPx) * size.qty,
            riskMoney: Math.abs(fillPx - cand.stop) * size.qty,
          });
          const risk = botRiskCheck({
            cfg: this.cfg, bot: botId, account: acc,
            openCounts: { perBot: openCounts.perBot, total: openCounts.total, totalTodayPnl: this.totalTodayPnl(acc.currency), totalTodayStartEq: this.totalTodayStartEq(acc.currency) },
            feedAgeSec, now,
            // v20.8.2 FIX (H2): the SAME window the pre-check used — see
            // botRisk.js #8 (the old raw-90s hard veto burned candidates
            // AFTER the paid decider + attempt burn).
            feedMaxAgeSec: this.cfg.staleFeedSeconds + intervalMs / 1000,
            killSwitches: {
              active: globalPauseActive(this.stateDir) ? true : (killSwitchActive(this.stateDir, botId) ? [botId] : []),
              anyActive: globalPauseActive(this.stateDir),
            },
            feeGate: { expectedGross: eg, roundTripCost: cost?.total },
            eventGuard,
            lossStreak: this.todayLossStreak(botId, now),
          });
          if (!risk.ok) {
            appendEvent(this.stateDir, botId, { kind: 'risk_block', symbol, reasons: risk.reasons });
            this._alertRiskBlock(botId, risk.reasons);
            bumpAction('blocked');
            continue;
          }
          // v20.9.0 (B3): unvalidated-pWin PAPER trade — stamp it on the
          // order event (kabhi chhupana nahi; LIVE me yahan aa hi nahi
          // sakte — fee gate ne edge_uncomputable se rok diya hota).
          if (pWinValidated == null) {
            appendEvent(this.stateDir, botId, { kind: 'pwin_unvalidated', symbol, note: 'OOS backtest missing (n<30 ya kabhi run nahi) — PAPER me conservative 0.35 floor; LIVE blocked' });
          }

          // 7. execution (PAPER default; LIVE requires env BOTS_MODE=LIVE
          //    AND an execPort explicitly constructed for live)
          if (this.cfg.mode !== 'PAPER' && !this.execPort) {
            appendEvent(this.stateDir, botId, { kind: 'skip', symbol, reason: 'live_mode_without_port' });
            continue;
          }
          const port = this.execPort || this._ensurePaperPort(botId);
          const clientId = `${botId}-${cand.symbol}-${cand.side}-${rows[iSig].bar.time}`;
          // v20.8.1 FIX (H1 — honest paper fills): fillPrice computed above
          // from the FORMING bar's open (engine's next-bar-open model).
          // The old open() omitted price entirely, so the FIRST fill on
          // any pair defaulted to $100 (PaperPort._lastMarkPrice
          // fallback) — the entire paper book was fiction.
          const fillPrice = fillPx;
          if (port.setMarkPrice) { try { port.setMarkPrice(cand.symbol, fillPrice); } catch { /* best-effort */ } }
          const opened = await port.open({
            pair: cand.symbol, side: cand.side, qty: size.qty, leverage: size.leverage,
            type: 'market', price: fillPrice,
            sl: cand.stop, tp: cand.target, clientId,
            // v20.8.2 (H2 — engine parity): time-based exits the engine
            // enforces but live settle used to lack — carried on the
            // position so the settle loop can honor them after restarts.
            meta: {
              maxHoldBars: cand.maxHoldBars ?? null,
              squareOffIST: strategy.desk === 'india' ? '15:10' : null,
              desk: strategy.universe || (STRATEGIES[botId]?.universe) || 'crypto',
              // v21.2.0 (dual-provider): kis arm ne entry approve ki — settle
              // events per-arm calibration tables (botlab-calibrate) isi se
              // banati hain. Degraded arm bhi honest stamp hota hai.
              arm,
            },
          });
          appendEvent(this.stateDir, botId, {
            kind: 'order', symbol, mode: this.cfg.mode, ok: opened.ok,
            orderId: opened.orderId || null, clientId,
            fill: fillPrice,
            size: { qty: size.qty, leverage: size.leverage, achievedRiskPct: size.achievedRiskPct, riskShrunkByCap: size.riskShrunkByCap, riskInflatedByMinUnit: size.riskInflatedByMinUnit || false },
            candidate: { side: cand.side, entry: cand.entry, stop: cand.stop, target: cand.target },
          });
          if (opened.ok) {
            bumpAction('ordered');
            // v20.8.4 FIX (H2 — CORE RULE): ApiFuturesPort.open() ignores
            // sl/tp (no exchange-resident bracket on the order call), so a
            // live position's ONLY exit was the 60s mark-based settle —
            // violating exec/port.js's own "no live position valid without
            // exchange-resident SL". Protection-first: set the bracket right
            // after the fill; if the exchange rejects it, FLATTEN immediately
            // (never hold a naked leveraged position).
            if (port === this.execPort && (cand.stop != null || cand.target != null)) {
              try {
                const live = await port.getPositions();
                const pos = (Array.isArray(live) ? live : [])
                  .filter((q) => q.pair === cand.symbol && q.side === cand.side)
                  .sort((a, b) => (Number(b.qty) || 0) - (Number(a.qty) || 0))[0] || null;
                const prot = pos && typeof port.setProtection === 'function'
                  ? await port.setProtection({ positionId: pos.id, sl: cand.stop, tp: cand.target })
                  : { ok: false, error: 'live position not found after open' };
                if (prot?.ok) {
                  appendEvent(this.stateDir, botId, { kind: 'protection_set', symbol, sl: cand.stop, tp: cand.target });
                } else {
                  appendEvent(this.stateDir, botId, { kind: 'protection_failed', symbol, error: prot?.error || 'setProtection rejected' });
                  let closed = false;
                  if (pos) { try { const cl = await port.close({ positionId: pos.id }); closed = cl?.ok === true; } catch { /* best-effort */ } }
                  appendEvent(this.stateDir, botId, { kind: 'protection_flatten', symbol, closed });
                  if (this.telegram.enabled) {
                    sendTelegramMessage(`[${botId}] LIVE ${cand.side} ${cand.symbol} SL/TP exchange pe set NAHI hua — position flatten kar di (closed=${closed}).`, this.tgEnv).catch(() => {});
                  }
                }
              } catch (e) {
                appendEvent(this.stateDir, botId, { kind: 'protection_error', symbol, error: String(e?.message || e) });
                // v21.1.0 (Phase-2 audit fix #9): ye outer catch pehle SIRF
                // log karta tha — getPositions() throw hone par LIVE position
                // bina kisi exchange-resident stop ke naked reh jaati thi.
                // Ab best-effort flatten retry + honest telegram (closed=false
                // ho to user ko MANUAL CLOSE ka explicit kehna).
                try {
                  const live = await port.getPositions();
                  const pos = (Array.isArray(live) ? live : [])
                    .filter((q) => q.pair === cand.symbol && q.side === cand.side)
                    .sort((a, b) => (Number(b.qty) || 0) - (Number(a.qty) || 0))[0] || null;
                  let closed = false;
                  if (pos) { try { const cl = await port.close({ positionId: pos.id }); closed = cl?.ok === true; } catch { /* best-effort */ } }
                  appendEvent(this.stateDir, botId, { kind: 'protection_flatten', symbol, closed });
                  if (this.telegram.enabled) {
                    sendTelegramMessage(`[${botId}] LIVE ${cand.side} ${cand.symbol} protection sequence FAILED (${String(e?.message || e).slice(0, 100)}) — flatten attempt closed=${closed}. Agar closed=false hai to exchange app me TURANT MANUAL CLOSE karo!`, this.tgEnv).catch(() => {});
                  }
                } catch (e2) {
                  if (this.telegram.enabled) {
                    sendTelegramMessage(`[${botId}] LIVE ${cand.side} ${cand.symbol} NAKED POSITION (protection fail + flatten bhi fail: ${String(e2?.message || e2).slice(0, 100)}) — TURANT MANUAL CLOSE KARO!`, this.tgEnv).catch(() => {});
                  }
                }
              }
            }
            // v20.8.2 FIX (H2 — cap within one tick): openCounts was
            // snapshotted ONCE at tick start, so after a successful open
            // the remaining symbols of the SAME tick still saw the stale
            // counts — a 3-symbol crypto bot could open 3 positions in
            // one tick (3x the maxOpenPerBot=1 parity the engine keeps).
            myOpen++;
            openCounts.perBot[botId] = (openCounts.perBot[botId] || 0) + 1;
            openCounts.total++;
            // v20.8.2 FIX (H3 — ephemeral paper positions): persist the
            // open-position snapshot so a restart rehydrates instead of
            // silently deleting the position (unrealized trade lost).
            await this._persistPaperPositions(botId, port);
          }
          // v20.9.3 FIX (M): order telegram alert ab verdict-aware. Pehle ye
          // block if(opened.ok) ke BAHAR tha — port.open() ke har failure mode
          // (exchange reject / no-mark / insufficient margin) pe bhi operator
          // ko "[botId] LIVE LONG NIFTY qty … SL … TP …" jata tha — phantom
          // position announcement on the unattended-monitoring channel.
          if (this.telegram.enabled) {
            if (opened.ok) {
              sendTelegramMessage(`[${botId}] ${this.cfg.mode} ${cand.side} ${cand.symbol} qty ${size.qty} SL ${cand.stop} TP ${cand.target} (arm ${arm})`, this.tgEnv).catch(() => {});
            } else {
              sendTelegramMessage(`[${botId}] ${this.cfg.mode} ${cand.side} ${cand.symbol} OPEN FAILED — ${String(opened.error || 'unknown').slice(0, 140)} (koi position nahi bani)`, this.tgEnv).catch(() => {});
            }
          }
        } catch (e) {
          // v20.8.1 FIX (H3): per-symbol error isolation — one symbol's
          // decider/appendEvent throw used to abort the remaining symbols
          // of the bot for the tick.
          appendEvent(this.stateDir, botId, { kind: 'tick_error', symbol, error: String(e?.message || e) });
        }
      }
      return { processed, tookAction };
    } finally {
      this._inTick.delete(botId);
    }
  }

  strategyCfg(_botId) { return undefined; } // strategies' own defaults

  lastClosedIndex(rows, now, _strategy) {
    if (!rows?.length) return -1;
    // A 5m bar is closed when now >= bar.time + 5min (+grace)
    for (let i = rows.length - 1; i >= Math.max(0, rows.length - 3); i--) {
      const t = rows[i].bar?.time || 0;
      if (t && now >= t + 5 * 60000 + 5000) return i;
    }
    return -1;
  }

  /** v20.8.1 FIX (H1): async open-position counts with REAL per-bot
   *  attribution. PaperPort.getPositions is async — the old sync call
   *  returned a Promise (counts NaN, perBot never filled), so
   *  max_open_per_bot/max_open_total could never fire. */
  async openCounts() {
    const counts = { perBot: {}, total: 0 };
    // v20.9.1 [H3]: FRESH-RESTART hydration — pehle _paperPorts null tha
    // (paper mode, pehla tick) to counts {perBot:{}} reh jate the jabki
    // disk pe persisted open positions mote the → pehle tick pe
    // maxOpenPerBot bypass ho kar DUPLICATE position khul sakti thi
    // (settleOpenTrades ka orphan-hydration pattern yahan ported).
    if (!this._paperPorts && !this.execPort) {
      let any = false;
      for (const bid of Object.keys(STRATEGIES)) {
        try {
          const st = loadBotState(this.stateDir, bid) || {};
          if (Array.isArray(st.paperPositions) && st.paperPositions.length) { this._ensurePaperPort(bid); any = true; }
        } catch { /* best-effort */ }
      }
      if (any) this._paperPorts = this._paperPorts || {};
    }
    const ports = [];
    if (this._paperPorts) for (const [bid, p] of Object.entries(this._paperPorts)) ports.push([bid, p]);
    else if (this.execPort) ports.push(['*', this.execPort]);
    for (const [bid, p] of ports) {
      try {
        const ps = p.getPositions ? await p.getPositions() : [];
        if (!Array.isArray(ps)) continue;
        for (const q of ps) {
          // live/shared port: attribute via clientId prefix ("<botId>-<sym>-...")
          const owner = q.clientId ? String(q.clientId).split('-')[0] : (bid !== '*' ? bid : '?');
          counts.perBot[owner] = (counts.perBot[owner] || 0) + 1;
          counts.total++;
        }
      } catch { /* best-effort */ }
    }
    return counts;
  }

  /** v20.8.1 FIX (H2): per-CURRENCY daily-P&L aggregate — the old sum
   *  mixed INR and USDT bots and divided by the CURRENT bot's starting
   *  equity (an INR bot's loss could trip off a crypto bot's kill).
   *  Also fixed: loadAccount returns the account itself, so the old
   *  `?.account` deref was always undefined (sum always 0). */
  totalTodayPnl(currency = null) {
    let sum = 0;
    for (const b of botsEnabled(this.env)) {
      const acc = loadAccount(this.stateDir, b);
      if (!acc) continue;
      if (currency != null && acc.currency && acc.currency !== currency) continue;
      const tp = acc.todayPnl;
      const net = typeof tp === 'number' ? tp : Number(tp?.net);
      if (Number.isFinite(net)) sum += net;
    }
    return sum;
  }

  /** v20.8.4 FIX (M — honest total-daily-loss denominator): aggregate
   *  STARTING equity of all enabled bots in the given currency. Paired
   *  with totalTodayPnl so botRisk normalizes the combined daily loss by
   *  the combined base (a 100k bot's loss must not be measured against a
   *  10k bot's equity). */
  totalTodayStartEq(currency = null) {
    let sum = 0;
    for (const b of botsEnabled(this.env)) {
      const acc = loadAccount(this.stateDir, b);
      if (!acc) continue;
      if (currency != null && acc.currency && acc.currency !== currency) continue;
      const se = Number(acc.startingEquity);
      if (Number.isFinite(se) && se > 0) sum += se;
    }
    return sum;
  }

  backtestPWin(botId) {
    // v20.9.0 (B3): DEPRECATED as a gate input — kept for status display
    // compatibility. The fee gate now uses validatedPWin (per-arm OOS
    // Wilson LB). A legacy whole-period in-sample pWin is NOT trusted.
    const st = loadBotState(this.stateDir, botId) || {};
    const v = validatedPWin(st, this.armFor(botId));
    if (v != null) return v;
    const pw = Number(st.backtest?.pWin);
    return Number.isFinite(pw) ? pw : 0.35; // display-only conservative default
  }

  /** v20.9.0 (A1): aaj ke settled trades ka trailing loss-streak.
   *  v20.9.1 [H3]: ACCOUNT-BASED primary path — events window (400-line
   *  cap + readEvents 200) busy din pe subah ke settle rows ko digest
   *  kar sakta tha → streak 0 → max_consecutive_losses gate (sabse
   *  pehla brake: 3×0.5% = 1.5% vs 2% daily kill) SILENTLY disarm ho
   *  jata tha. applyTrade ab lossStreakToday maintain karta hai (day
   *  rollover-safe); events scan sirf legacy-state fallback hai. */
  todayLossStreak(botId, now = Date.now()) {
    try {
      const acc = loadAccount(this.stateDir, botId, { now: new Date(now) });
      if (Number.isFinite(Number(acc.lossStreakToday))) return Number(acc.lossStreakToday);
    } catch { /* fall through to legacy events scan */ }
    try {
      const dayStart = istDayKey(now);
      const settled = readEvents(this.stateDir, botId, 200)
        .filter((e) => e?.kind === 'settle' && istDayKey(Date.parse(e.at) || Number(e.ts) || 0) === dayStart)
        .map((e) => ({ closedTs: Date.parse(e.at) || Number(e.ts) || 0, netPnl: Number(e.netPnl) }));
      return currentLossStreak({ settled, sinceTs: 0 });
    } catch { return 0; }
  }

  /** v20.9.0 (E — ops alerts): daily-loss / drawdown / event-day blocks
   *  pe telegram alert — DIN me ek baar per bot (har tick spam nahi).
   *  Sirf paisa-bachaane wale reasons alert karte hain (cooldown/max-open
   *  jaise routine caps nahi). */
  _alertRiskBlock(botId, reasons = []) {
    const ALERTABLE = /daily_loss|max_drawdown|equity_floor|consecutive_losses|event_day/;
    if (!reasons.some((r) => ALERTABLE.test(String(r)))) return;
    if (!this.telegram?.enabled) return;
    const day = istDayKey(Date.now());
    if (this._riskAlertedDay[botId] === day) return;
    // v20.9.1 [M]: dedupe key sirf SUCCESSFUL send pe burn hota hai —
    // pehle send-fail bhi din ka ek-alert quota kha jata tha (telegram
    // outage = risk-halt kabhi notify nahi). 3 failed tries ke baad key
    // burn (infinite per-tick retry spam se bachne ke liye).
    // v20.9.4 FIX (H2 sub-bug — dead retry logic): sendTelegramMessage
    // FAILURE pe REJECT nahi karta, {ok:false} RESOLVE karta hai — pehle
    // .then() bina check ke dedupe key burn kar deta tha (telegram outage
    // = us din ka risk-halt alert hamesha ke liye khatam) aur .catch()
    // wala 3-strike retry counter unreachable dead code tha. Ab verdict
    // check: ok hi ho to burn, warna retry++ (3 fail ke baad hi burn).
    sendTelegramMessage(
      `[${botId}] RISK HALT — ${reasons.filter((r) => ALERTABLE.test(String(r))).join('; ')}. Aaj ke naye entries block (open positions manage hote rahenge).`,
      this.tgEnv,
    ).then((r) => {
      if (r?.ok) {
        this._riskAlertedDay[botId] = day;
      } else {
        this._riskAlertFail = this._riskAlertFail || {};
        this._riskAlertFail[botId] = (this._riskAlertFail[botId] || 0) + 1;
        if (this._riskAlertFail[botId] >= 3) this._riskAlertedDay[botId] = day;
      }
    }).catch(() => {
      this._riskAlertFail = this._riskAlertFail || {};
      this._riskAlertFail[botId] = (this._riskAlertFail[botId] || 0) + 1;
      if (this._riskAlertFail[botId] >= 3) this._riskAlertedDay[botId] = day;
    });
  }

  _ensurePaperPort(botId) {
    if (!this._paperPorts) this._paperPorts = {};
    if (!this._paperPorts[botId]) {
      // v20.8.1 FIX (H2): the port now mirrors the BOT's own account
      // (INR bots were getting a 10k-USDT port — lakh-sized sizing
      // always failed the margin check, so INR bots could never trade).
      // PaperPort math is currency-agnostic; the label stays USDT.
      const acc = loadAccount(this.stateDir, botId);
      const port = new PaperPort({ startingEquityUSDT: acc.equity });
      // v20.8.2 FIX (H3 — ephemeral paper positions): rehydrate the
      // open-position snapshot from bot state — a restart used to
      // silently delete open positions (unrealized trade never settled,
      // _clientIds reset -> duplicate-clientId guard disarmed).
      const st = loadBotState(this.stateDir, botId) || {};
      if (Array.isArray(st.paperPositions) && st.paperPositions.length) {
        try { port.hydrateOpenPositions(st.paperPositions); } catch { /* best-effort */ }
      }
      this._paperPorts[botId] = port;
    }
    return this._paperPorts[botId];
  }

  /** v20.8.2: persist the port's open positions into bot state so a
   *  restart can rehydrate them (see _ensurePaperPort). */
  async _persistPaperPositions(botId, port) {
    try {
      const ps = await port.getPositions();
      const st = loadBotState(this.stateDir, botId) || {};
      saveBotState(this.stateDir, botId, { ...st, paperPositions: ps });
    } catch { /* best-effort */ }
  }

  /** v20.8.1 NEW: the 5-min bar-close scheduler (plan §9 Phase 5 —
   *  "har 5-min bar close pe"). v20.8.0 shipped the tick path but
   *  NOTHING ever called it (heartbeats stayed null forever, open
   *  positions never settled). Runs every 60s; the late_decision +
   *  attempt-persistence guards make re-checks idempotent. unref'd so
   *  tests/CLI exit cleanly. */
  startScheduler({ intervalMs = 60_000 } = {}) {
    if (this._schedTimer) return this._schedTimer;
    const run = async () => {
      for (const botId of botsEnabled(this.env)) {
        try { await this.tick(botId); } catch { /* per-bot isolation inside tick */ }
      }
      try { await this.settleOpenTrades(); } catch { /* best-effort */ }
    };
    this._schedTimer = setInterval(() => { run().catch(() => {}); }, intervalMs);
    if (typeof this._schedTimer.unref === 'function') this._schedTimer.unref();
    return this._schedTimer;
  }

  stopScheduler() {
    if (this._schedTimer) { clearInterval(this._schedTimer); this._schedTimer = null; }
  }

  /** Settle open paper positions against mark prices -> accounts. */
  async settleOpenTrades({ now = Date.now() } = {}) {
    // v20.8.4 FIX (H2 — orphaned risk, part 1): a FRESH runner (post-
    // restart) whose bots are all kill-switched/disabled has NO ports in
    // memory — the old `!this._paperPorts && !this.execPort` early-return
    // made settle a no-op while persisted open positions sat frozen. Only
    // bail when NO strategy has persisted open positions either.
    if (!this._paperPorts && !this.execPort) {
      const orphaned = Object.keys(STRATEGIES).some((bid) => {
        try {
          const st = loadBotState(this.stateDir, bid) || {};
          return Array.isArray(st.paperPositions) && st.paperPositions.length > 0;
        } catch { return false; }
      });
      if (!orphaned) return [];
      this._paperPorts = {};
    }
    // v20.8.4 FIX (H1 — settle double-book): re-entrancy guard. Overlapping
    // settle passes (60s interval vs >60s runs) double-booked P&L.
    if (this._inSettle) return [];
    this._inSettle = true;
    try {
    const settled = [];
    // v20.8.4 FIX (H2 — orphaned risk, part 2): kill switch / removal from
    // BOTS_ENABLED used to freeze open paper positions FOREVER (tick
    // returned at the kill gate before _ensurePaperPort was ever reached,
    // so settle never saw a port for that bot). A kill switch must stop
    // ENTRIES, never EXITS — lazily re-create ports for ANY strategy with
    // persisted open positions so the settle loop can reach them.
    if (this._paperPorts) {
      for (const bid of Object.keys(STRATEGIES)) {
        if (this._paperPorts[bid]) continue;
        try {
          const st = loadBotState(this.stateDir, bid) || {};
          if (Array.isArray(st.paperPositions) && st.paperPositions.length) {
            this._ensurePaperPort(bid); // hydrateOpenPositions inside
          }
        } catch { /* best-effort */ }
      }
    }
    const ports = this._paperPorts ? Object.entries(this._paperPorts) : [['*', this.execPort]];
    for (const [botId, port] of ports) {
      let positions = [];
      try { positions = await port.getPositions(); } catch { continue; }
      if (!Array.isArray(positions)) continue;
      // v20.8.4 FIX (H2 — shared live port): the '*' branch fell back to
      // instrumentType 'crypto' for EVERY position — an India bot's live
      // NIFTY position would be marked via the crypto desk (null → never
      // settles) and fee'd with crypto taker costs. Attribute the OWNING
      // strategy via the clientId prefix (same convention openCounts uses).
      // v20.9.3 FIX (H3): per-POSITION resolution. Pehle ownerAttr sirf
      // PEHLI matching position se pick hota tha aur usi ka strategy/
      // instrumentType SAB positions pe lag jata tha — mixed desks
      // (orb_in NIFTY + orb_crypto BTC ek shared port pe) me ek desk ki
      // positions galat fee stack (estimateRoundTripCost) + galat mark
      // desk (botMarkPrice → null → continue → position KABHI settle
      // nahi hoti, SL/TP kabhi fire nahi karta) pati thi.
      const _owningStrategyOf = (p) => {
        if (botId !== '*') return this.strategyFor(botId);
        const own = p?.clientId ? String(p.clientId).split('-')[0] : null;
        return own && STRATEGIES[own] ? STRATEGIES[own].factory() : null;
      };
      for (const p of positions) {
        const strategy = _owningStrategyOf(p);
        const instrumentType = strategy?.instrumentType || 'crypto';
        // v20.8.1 FIX (H2 crash): getPositions() is ASYNC — the old
        // port.getPositions().find(...) threw TypeError on a Promise.
        // Marks now come from the provider (awaited) and the in-memory
        // snapshot is re-read after setMarkPrice.
        let price = p.markPrice;
        try {
          const mark = this.markPriceProvider
            ? await this.markPriceProvider(p.pair, strategy?.universe || (STRATEGIES[botId]?.universe) || 'crypto')
            : null;
          if (mark != null && port.setMarkPrice) port.setMarkPrice(p.pair, mark);
          price = (mark != null ? mark : p.markPrice);
        } catch { /* keep existing mark */ }
        if (price == null) continue;
        const stopHit = p.sl != null && (p.side === 'LONG' ? price <= p.sl : price >= p.sl);
        const tpHit = p.tp != null && (p.side === 'LONG' ? price >= p.tp : price <= p.tp);
        // v20.8.2 FIX (H2 — engine parity): time-based exits. The engine
        // honors maxHoldBars (orb-crypto 24h time-stop) and the 15:10 IST
        // India square-off; live settle only ever checked SL/TP, so an
        // India paper position sat on a frozen mark past market close and
        // crypto positions could hang for days, blocking the bot forever.
        const holdBars = p.openedAt ? Math.floor((now - p.openedAt) / (5 * 60000)) : 0;
        const mh = Number(p.meta?.maxHoldBars);
        const timeStop = Number.isFinite(mh) && mh > 0 && holdBars >= mh;
        let squareOff = false;
        if (p.meta?.squareOffIST && p.openedAt) {
          const [hh, mm] = String(p.meta.squareOffIST).split(':').map(Number);
          const sqMin = Number.isFinite(hh) && Number.isFinite(mm) ? hh * 60 + mm : null;
          const todayKey = istDayKey(now);
          const openKey = istDayKey(p.openedAt);
          // fire when today's square-off time has passed, OR the position
          // is from an earlier day (the 15:10 close was missed — e.g. the
          // server was down — and the position must not ride overnight)
          squareOff = sqMin != null && todayKey != null && openKey != null
            && (todayKey !== openKey || (istMinutes(now) ?? -1) >= sqMin);
        }
        if (!stopHit && !tpHit && !timeStop && !squareOff) continue;
        const owner = p.clientId ? String(p.clientId).split('-')[0] : botId;
        const accOwner = STRATEGIES[owner] ? owner : botId;
        const r = await port.close({ positionId: p.id });
        // v20.8.4 FIX (H1 — verdict-blind booking): port.close() can
        // REJECT (position not found / exchange reject). The old code
        // never checked r.ok and booked a fabricated P&L anyway — the
        // moment a live execPort is wired, an exchange-rejected close
        // would debit the account while the real position stayed open.
        if (!r?.ok) {
          appendEvent(this.stateDir, accOwner, {
            kind: 'settle_close_failed', symbol: p.pair,
            error: r?.error || 'close_rejected',
          });
          continue;
        }
        const dir = p.side === 'LONG' ? 1 : -1;
        const gross = dir * (price - p.avgPrice) * p.qty;
        // v20.8.1 FIX (H2): instrumentType from the OWNING strategy — the
        // old hardcode settled INR bots with crypto taker fees.
        const cost = estimateRoundTripCost({ qty: p.qty, entryPrice: p.avgPrice, exitPrice: price, instrumentType, mult: strategy?.lotSize || 1 });
        const fees = cost?.total || 0;
        // v20.8.4 FIX (H3 — live/backtest parity): the engine charges
        // slippageBps on BOTH sides; the live paper book charged fees
        // only, so paper always flattered vs the backtest that gates it
        // (~8-10 bps/trade systematic optimism). Same bps as the engine.
        const slipBps = instrumentType === 'crypto' ? ENGINE_DEFAULTS.slippageBpsCrypto : ENGINE_DEFAULTS.slippageBpsIndia;
        const slip = ((p.avgPrice * slipBps / 10000) + (price * slipBps / 10000)) * p.qty * (strategy?.lotSize || 1);
        const riskPerUnit = p.sl != null ? Math.abs(p.avgPrice - p.sl) * p.qty : null;
        // v20.9.1 [H3]: exchange realizedPnl (ApiFuturesPort live fill) ALREADY
        // net-of-fees hota hai — us se modeled fees+slip DOBARA subtract karna
        // live bookings pe double-charge tha. PaperPort bhi raw.realizedPnl
        // deta hai par wo MARK-BASED GROSS hai (fees/slip lagne hain) — isliye
        // `paper:true` marker se discriminate hota hai (v20.9.1 port fix).
        const _exRealized = Number(r?.raw?.realizedPnl);
        const _isExchangeNumber = Number.isFinite(_exRealized) && r?.raw && r.raw.paper !== true;
        const netPnl = _isExchangeNumber ? _exRealized : gross - fees - slip;
        const trade = {
          grossPnl: gross, netPnl, fees, slippage: slip,
          // v20.8.1 FIX: no SL on the position -> R undefined (null),
          // never a fabricated /1 R.
          rNet: riskPerUnit > 0 ? netPnl / riskPerUnit : null,
        };
        let acc = loadAccount(this.stateDir, accOwner);
        acc = applyTrade(acc, trade, { now: new Date(now) });
        saveAccount(this.stateDir, acc);
        appendEvent(this.stateDir, accOwner, {
          kind: 'settle', symbol: p.pair,
          exitWhy: stopHit ? 'stop' : tpHit ? 'target' : timeStop ? 'time_stop' : 'square_off',
          // v21.2.0 (dual-provider): arm jo entry leta tha (position meta se
          // — restart-safe). Purane positions me null (calibrate gracefully
          // 'unknown' bucket me daalta hai).
          arm: p.meta?.arm || null,
          ...trade,
        });
        settled.push({ botId: accOwner, symbol: p.pair, ...trade });
        // v20.8.2 (H3): keep the persisted position snapshot in sync —
        // a restart must not rehydrate a position that just settled.
        if (botId !== '*') await this._persistPaperPositions(botId, port);
      }
    }
    return settled;
    } finally {
      this._inSettle = false;
    }
  }

  /**
   * REPLAY VALIDATION (plan §10.1): run the LIVE decision path over
   * historical bars for a date and compare with the ENGINE records.
   * Mismatch = ek galat hai (common cause: live feature code alag —
   * impossible now: both import the same strategy modules).
   */
  async replay(botId, bars, { arm = null } = {}) {
    const strategy = this.strategyFor(botId);
    if (!strategy) return { error: 'unknown_bot' };
    const useArm = arm || this.armFor(botId);
    const decider = makeDecider({ arm: useArm, strategy, jev: this.jev, providers: this.ai, primary: this.aiCfg.primary, shadow: this.aiCfg.shadow, onDown: this.aiCfg.onDown, eventGuardCheck });
    const out = [];
    const state = { droppedByNaN: [] };
    const rows = strategy.prepare(bars);
    for (let i = 0; i < rows.length; i++) {
      const cand = strategy.detect(rows, i, { state, symbol: 'REPLAY', cfg: this.strategyCfg(botId) });
      if (!cand) continue;
      const v = await decider(cand, rows[i]);
      out.push({ i, ts: rows[i].bar.time, action: v.action, reason: v.reason || null, arm: useArm, side: cand.side });
    }
    return { decisions: out, dropped: state.droppedByNaN.length };
  }

  /** Status snapshot for /api/bots/status + SSE. */
  status() {
    const bots = [];
    for (const botId of botsEnabled(this.env)) {
      const st = loadBotState(this.stateDir, botId) || {};
      // v20.8.2 FIX (M): route the account through loadAccount's IST
      // day-rollover — the raw st.account showed YESTERDAY's "today P&L"
      // after midnight until the first settle of the new day saved.
      // (No save here — read-only rollover view.)
      const acc = st.account ? loadAccount(this.stateDir, botId) : null;
      bots.push({
        bot: botId,
        arm: st.arm || this.env.BOTS_ARM || 'gated',
        mode: this.cfg.mode,
        killSwitch: killSwitchActive(this.stateDir, botId),
        heartbeat: this.heartbeats[botId] || null,
        account: acc ? accountStats(acc) : null,
        backtest: st.backtest || null,
      });
    }
    return {
      mode: this.cfg.mode,
      globalPause: globalPauseActive(this.stateDir),
      scheduler: this._schedTimer ? 'running' : 'stopped',
      // v21.14: per-provider stats. Purana `jev` field compat ke liye
      // untouched (UI/purane consumers).
      ai: {
        jev: this.ai.jev?.stats?.() || null,
      },
      aiMode: { ...this.aiCfg },
      jev: this.jev?.stats?.() || null,
      bots,
      at: new Date().toISOString(),
    };
  }

  events(limit = 100) {
    const all = [];
    for (const botId of botsEnabled(this.env)) {
      for (const e of readEvents(this.stateDir, botId, limit)) all.push(e);
    }
    return all.sort((a, b) => String(a.at).localeCompare(String(b.at))).slice(-limit);
  }

  toggleKillSwitch(botId, on, note = '') {
    return setKillSwitch(this.stateDir, botId, on, note);
  }
}

/**
 * Backtest one strategy over bars with all three arms (plan §7.1).
 * costFn wired to the REAL tradingCosts (friction honesty).
 * v21.2.0 (dual-provider): runArmsBacktest() ka thin wrapper — purane
 * callers (routes /api/bots/backtest, tests) untouched chalte hain.
 */
export async function runThreeArmBacktest({ strategy, bars, symbol = '?', jev = null, cfg = {}, instrumentType = null, lotSize = null }) {
  return runArmsBacktest({
    strategy, bars, symbol, cfg, instrumentType, lotSize,
    providers: { jev: jev || null },
    arms: ['rules', 'gated', ...(jev ? ['jev'] : [])],
  });
}

/**
 * v21.2.0 (dual-provider plan Step-7): N-arm backtest harness.
 * v21.14: default arms rules, gated + jev (jab configured ho) —
 * `--arm auto` CLI se explicitly maanga ja sakta hai.
 */
export async function runArmsBacktest({ strategy, bars, symbol = '?', providers = null, jev = null, arms = null, cfg = {}, instrumentType = null, lotSize = null, primary = 'jev', shadow = 'off', onDown = 'wait' }) {
  const costFn = (a) => estimateRoundTripCost(a) || { total: 0 };
  const provs = providers || { jev: jev || null };
  // v20.8.4 FIX (M — fee-model honesty): allow the CALLER to override
  // instrumentType/lotSize. The ensemble adapter's descriptor hardcodes
  // 'crypto' while its candidates carry the market-correct type — an
  // INDIA-market run through the descriptor silently charged crypto taker
  // fees instead of the India cost stack (STT/txn/GST/stamp).
  const iType = instrumentType || strategy.instrumentType;
  const lSize = lotSize != null ? lotSize : strategy.lotSize;
  const armList = arms || [
    'rules', 'gated',
    ...(provs.jev ? ['jev'] : []),
  ];
  const out = {};
  for (const arm of armList) {
    const decider = makeDecider({ arm, strategy, jev: provs.jev || undefined, providers: provs, primary, shadow, onDown, eventGuardCheck });
    out[arm] = await runBacktest({
      rows: strategy.prepare(bars), strategy, decider, costFn, symbol,
      instrumentType: iType, lotSize: lSize,
      squareOff: strategy.desk === 'india' ? { enabled: true, ist: '15:10' } : null,
      cfg,
    });
  }
  return out;
}
