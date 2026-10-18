# v20.6 Audit — Auto-Trading Reimplementation Plan (Local Ollama · Wallet-sized 5–10x · Browser-driven)

**Repo:** `wonderboy2040/smarttest` (commit `80ac1d6` "Update expert picks and coindcx mcp", 1 Oct 2026)
**Target machine:** 16GB RAM laptop, sab kuch local (Chrome tabs + Node server + Ollama)
**Plan source:** user-supplied 9-phase `SUPERINTELLIGENCE_PLAN.md` replacement

This document is the Phase 0 audit pass. It maps what's already built, what's been fixed in v20.6, and what remains as deferred work for the later phases.

---

## 0. What was read (and what wasn't)

**Read (code-level):** `proTraderAuto.js` (full), `browserAgent.js` (header + order/leverage), `futures.js` (header, wallet, TPSL, execution gauntlet, position watcher), `coindcxOrders.js` (header/config/trailing), `ensemble.js` (leverage/trail), `llmChain.js`, `llmSentinel.js` (Ollama), `ml-service/app/main.py`, `Start-AutoBrowser.bat`, `.env.example`, the auto-trade-plan investigator's full report (Task ID `inv-auto-trade-plan`).

**Not read / verify in Phase 0+:** `signals.js` (full), `superIntel.js`, `council.js` (full), `cryptoAgent.js`, `agent.js`, `routes.js` (full), UI components (other than SelfImprovementPanel mount), `reversalEngine.js` internals, `browserAgent.js` selectors live-DOM match. App not run; tests not executed against live CoinDCX/Dhan DOM.

---

## 1. What's already there (the existing asset map)

| Area | Existing | File:line |
|---|---|---|
| Browser auto-trader "SAPTA" | CDP-driven logged-in Chrome tabs (CoinDCX + Dhan); paper default, LIVE via typed `LIVE`; global kill-switch; CLOSE_UNKNOWN retry 8x | `proTraderAuto.js`, `browserAgent.js`, `Start-AutoBrowser.bat` |
| Entry gates | aiScore ≥ 75, conf ≥ 65, verified ≥ 90, grade STRONG, verify=CONFIRM & finalCall=side | `proTraderAuto.js:154` (`proTraderGate`) |
| API futures engine | CoinDCX USDT perps: wallets, positions, create order, **native exchange TP/SL** (`createFuturesTpsl`), partial exit, wallet-margin sizing, leverage sanity, trailing SL, liquidation watch, **exchange reconcile** | `futures.js:858` (`createFuturesTpsl`), `:849` (`partialFuturesExit`), `:893` (`executeFuturesSignal`), `:1267` (`watchFuturesPositions`), `:596` (`fetchFuturesWallets`), `:792` (`listFuturesPositions`) |
| Leverage math | `maxSaneLeverage` (default cap 10), `computeLeverageView` (liq ≈ entry×(1∓0.95/L)), `computeTrailSl` | `ensemble.js:786`, `:811`, `:683` |
| Exit stages | `ENTRY → T1_HIT → RUNNER → CLOSED`, partial TP | `coindcxOrders.js:1408` (`exitStageOf`), `:1401` (`ratchetSl`) |
| Reversal recovery | ₹ loss-cap cut → stop-and-reverse → ₹ target booking (opt-in) | `reversalEngine.js` |
| Risk guards | daily trades/loss caps, concentration (5 open), event guard, global risk-off, circuit guard, wick filter, correlation | `coindcxOrders.js`, `eventGuard.js`, `globalRisk.js`, `wickFilter.js`, `correlation.js` |
| Approval flow | Telegram `/trade` → Approve → PIN → execute | `tradeApproval.js` |
| Local LLM | Ollama wired (chain ke aakhir me), probe, sentinel/cooldown, 90s timeout | `llmChain.js:119` (`councilAsk`), `llmSentinel.js:157` (`ollamaProbe`), `:185` (`ollamaCompatCfg`), `:36` (default `'llama3.1:8b'`) |
| Tests | 153 files / 2737+ tests | `test/` |

---

## 2. Real GAPS (code-level confirmed)

| # | Gap | Evidence | Risk @ 5–10x |
|---|---|---|---|
| **G1** | Browser path me SL sirf software-side (30s tick check); exchange par koi resident stop nahi | `proTraderReversalCheck`; native TPSL sirf `futures.js` me | Laptop sleep / Chrome freeze / Node crash / internet drop = **unprotected leveraged position** |
| **G2** | Browser leverage best-effort DOM hai; read-back verify nahi | `browserAgent.js:383-396` ("slider best-effort cosmetic") | 5x plan, exchange par 20x ya 1x |
| **G3** | Sizing fixed `stakeINR` (default ₹500, clamp ₹100–1,00,000); wallet/equity ya SL-distance se nahi | `proTraderAuto.js:60` (`PROTRADER_DEFAULTS.stakeINR`) | Wallet badhe/ghate to risk% badalta rehta hai |
| **G4** | Browser path me profit booking nahi: tp/tp2 store hote hain par close sirf SL-hit ya reversal-flip par. Partial TP, breakeven, trailing, give-back lock absent | `_monitorPositions` (grep trail/partial/breakeven = 0 matches) | Profit wapas market ko chala jata hai |
| **G5** | Entry plan.entry par LIMIT; actual fill price/qty exchange se read nahi hota | `_tryEntry`, `_pnlOf` | Journal ≠ exchange truth; unfilled order cancel nahi |
| **G6** | Reversal confirm = 2 consecutive 30s ticks, candle-close nahi; ensemble flip 60s-cached board se | `REVERSAL_CONFIRM_NEEDED = 2` | Whipsaw me galat exit ya late exit |
| **G7** | Do alag engines, do journals (`protrader-auto-journal.json` vs `ai-trading-journal.json`). SAPTA sirf `killSwitch` padhta hai; `dailyMaxLossINR`, `maxOpenPositions`, concentration caps **apply nahi** hote | `proTraderTick` | Caps bypass; double exposure |
| **G8** | Ollama cloud engines ke baad aakhri me hai; koi RAM governor nahi; ml-service ke optional HF models RAM se compete kar sakte hain | `councilAsk`, `hf_models.py` | 16GB me swap/freeze → bot hang |
| **G9** | CDP browser + Ollama sirf laptop par hain. Render copy inhe use nahi kar sakti; agar dono jagah auto ON hua to **duplicate orders** | `browserAgent.js` | Double execution |
| **G10** | `Start-AutoBrowser.bat` me background-throttling flags nahi the | `.bat:54` (pre-v20.6) | Minimized/background tab me timers slow → late reaction |

---

## 3. v20.6 fixes shipped in this pass (the explicit asks + the most impactful Phases)

### Critical: Self-Improvement Engine / Super Intelligence Loop — REMOVED FROM DEFAULT RUNTIME

**User explicit ask:** "Self-Improvement Engine — Super Intelligence Loop isko site se completely remove kardo kyun ki isse jyada load ho raha hai trade signal pe effect ho raha hai and site cleanup kardo".

**Strategy (do NOT delete loop modules — `council.js` dynamically `await import('./lessonsEngine.js')` for the lessonsBlock prompt; deleting would crash that path):**

1. **Default `SELFIMPROVE_ENABLED=false`** in `.env.example` — the loop never arms on a fresh install. The flag stays for opt-in users.
2. **Loop intervals gated behind the flag** in `server/index.js:3007-3087` — even if someone flips the flag to `true`, the heavy loop is opt-in; the default log line announces "DISABLED by default".
3. **SelfImprovementPanel unmounted from `CoinDcxTab.tsx`** (line 432) — no UI load; no 60s polling of `/api/ai/self/status` + `/api/ai/self/proposals`; the panel file stays in place so external imports don't crash.
4. **The 14 `/api/ai/self/*` routes stay mounted** in `routes.js:1670-1736` — they're inert without the loop, available for manual one-shot ops.
5. **Modules LEFT IN PLACE (touching them breaks signal generation):**
   - `adaptive.js` (v6.7, NOT v19.0) — `applyAdaptiveWeights` runs every board tick in `signals.js`; **DO NOT TOUCH**.
   - `signalMemory.js` (v12.4) — `applySignalTrustGuards` is the per-signal OB/OS + flip-cooldown gate; INDEPENDENT of the loop.
   - `selfHeal.js` (v19.1) — server stability watchdog (uncaught exception + memory + event-loop monitor); INDEPENDENT.
   - `boardAccountability.js` (v20.2) — board→trackRecord bridge; route-layer only; INDEPENDENT.
   - `mlHealth.js` (v18.1) — cached ml-service reachability probe; INDEPENDENT.

**Effect:** the trade-signal path is now free of the self-improvement load (no harvest pass walking the ledger; no drift probe computing PSI/calibration; no weekly LLM-driven lessons call inflating the council prompt's token budget; no evolution ledger writes).

### Phase 1a — Local-first LLM (`llmChain.js`)

- New env `LLM_PRIORITY` (comma-separated provider list; providers NOT in the list are skipped entirely — no fetch, no key probe). Default (env unset) = historical order `gemini→groq→cerebras→openrouter→huggingface→nvidia→ollama` (backward-compatible).
- New env `LLM_LOCAL_ONLY=1` — short-circuit ALL cloud providers and try ONLY the local Ollama engine. Designed for the 16GB laptop setup (Chrome + Node + Ollama all running locally; cloud calls add latency + cost + bandwidth).
- New env `OLLAMA_MODEL=qwen3:8b` recommended (faster + better JSON than the repo's historical `llama3.1:8b`); the auto-trading plan's "thinking" output strip (`<think>…</think>`) is handled by the existing `tryParseJson` regex.
- Tests: `test/llmChainEnv.test.ts` locks the env-driven order + local-only short-circuit.

### Phase 1b — RAM Governor (`server/ai/ramGovernor.js`, NEW module)

- Three-state traffic light: GREEN (>3.5GB free) / YELLOW (2–3.5GB) / RED (<2GB).
- `ramCanEnter()` returns `state !== 'RED'` (RED blocks new entries; positions still managed).
- `ramCanLLM()` returns `state === 'GREEN'` (YELLOW blocks LLM calls → deterministic mode; HF models unload).
- RSS-floor guard: if process RSS alone exceeds `TOTAL_PHYSICAL - RAM_RSS_RESERVE_MB` (default 600MB), force YELLOW even if "free" reads high (the degenerate swap scenario right before a full lockup).
- Telegram CRITICAL alert on RED entry, 5-min min-gap (no spam).
- Tunables: `RAM_YELLOW_FREE_GB` (3.5), `RAM_RED_FREE_GB` (2.0), `RAM_TICK_SEC` (10), `RAM_RSS_RESERVE_MB` (600).
- Wired into `server/index.js` boot (after `initSelfHeal`).
- Tests: `test/ramGovernor.test.ts` locks state transitions + alert behavior.

### Phase 1c — ml-service HF models disabled by default (`ml-service/app/main.py`)

- `hf_models` (Chronos-T5 torch + FinBERT torch) mount is now gated behind `HF_MODELS_ENABLED=true` (default false).
- `expert_mode` mount similarly gated behind `EXPERT_MODE_ENABLED=true` (default false) — it imports torch + HF models internally.
- Default install gets only the base LightGBM/sklearn ML service — saves RAM for the local Ollama engine.

### Phase 3 — Sizing engine (`server/exec/sizing.js`, NEW module + tests)

- Pure-functional `computeSizing({ equity, freeUSDT, entry, stopLoss, riskPct, tierLeverage, instrument, ... })`.
- Core invariants (locked by `test/sizing.test.ts`):
  1. `qty × slDistPct × entry ≤ riskUSDT × 1.001` (risk cap held with rounding slack)
  2. `liqDistancePct(lev) ≥ 2.5 × slDistPct` (SL inside liquidation distance)
  3. `margin ≤ freeUSDT × 0.9` (cash headroom)
  4. `leverage = clamp(tierCap, 5, 10) ∧ ≤ maxSaneLeverage ∧ ≤ instrument.maxLeverage`
- Worked example locked: 1000 USDT · 1% risk · 1.5% SL → notional ≈ 667, 5x → margin ≈ 133, max loss ≈ 10.
- Leverage lesson locked: 10x gives SAME MAX LOSS as 5x (smaller margin, more free cash — leverage doesn't change risk).
- SKIP verdicts: `SKIP_LOW_EQUITY`, `SKIP_MIN_QTY`, `SKIP_MARGIN_CAP`, `SKIP_LIQ_TOO_CLOSE`, `SKIP_BAD_INPUT`.
- Account-level brakes (env keys documented, applied in a future Phase 3b wiring pass): `DAILY_LOSS_LIMIT_PCT=3`, `WEEKLY_DD_HALF_SIZE_PCT=8`, `MAX_CONCURRENT=3`, `LOSS_STREAK_PAUSE=3`.

### Phase 6 — Browser hardening (`Start-AutoBrowser.bat`)

Added 7 Chrome flags:
- `--disable-background-timer-throttling` — minimized/background tab `setInterval`/`setTimeout` slow nahi hota; signal-reaction latency (PROTRADER_TICK_SEC=30) minimized.
- `--disable-renderer-backgrounding` — background tab compositor pause nahi hota; page repaint fresh.
- `--disable-backgrounding-occluded-windows` — covered-by-other-window Chrome tab throttle nahi hota.
- `--disable-features=CalculateNativeWinOcclusion` — same, for newer Chrome (post-126).
- `--disable-hang-monitor` — "Page unresponsive" prompt suppressed.
- `--disable-popup-blocking` — automation alerts block na ho.
- `--disable-component-update` — silent extension updates restart nahi kar sakte.

Power-plan guidance in `.bat` comments: Sleep OFF, Hibernate OFF, "Plugged in" only.

---

## 4. Deferred work (the remaining Phases — calendar time, not code)

### Phase 2 — Execution Port abstraction (`server/exec/port.js`, NEW interface + 4 adapters)

`ApiFuturesPort` ← wraps `futures.js` (`createFuturesOrder`, `createFuturesTpsl`, `partialFuturesExit`, `exitFuturesPosition`, `listFuturesPositions`, `fetchFuturesWallets`). **All pieces ready in `futures.js`.**
`BrowserCdpPort` ← wraps `browserAgent.js` (`cxEnsureTradePage`, `cxSelectPair`, `cxPlaceOrder`, `cxClosePosition`, `cxReadPositions`) + Phase 6 hardening (leverage read-back, UI SL/TP bracket).
`PaperPort` ← simulated fills, same interface.
Contract test suite that runs the same scenarios across all three adapters. **Estimated 3-4 days.**

### Phase 4 — Protection-first + Exit Manager (`server/exec/positionManager.js`, NEW)

4a. Protection-first entry sequence: `open()` → fill confirm via `getPositions()` → leverage mismatch → close + alert; `setProtection({sl, tp})` → read-back confirm; protection fail → **flatten immediately**.
4b. Exit state machine (existing stages `ENTRY → T1_HIT → RUNNER → CLOSED` reuse): T1 (40% reduce, SL → BE+fees) → T2 (30% reduce, SL → T1 level) → RUNNER (30%, ATR chandelier trail 2.5×ATR(14) on 15m, ratchet-only via `ratchetSl`) → Give-back lock (peak unrealized ≥1.5R & retrace >35% of peak → runner close) → Time stop (N candles me T1 nahi mila → exit) → Funding/Event (size cut ya exit). **Estimated 4-5 days.**
4c. Reversal detection tiered, candle-close: 1 class → SL tighten; 2 classes → 50% reduce; 3+ classes → full close. Tick-level checks sirf hard stops ke liye (G6 fix). LLM = sirf tie-breaker.
4d. Fast price feed: REST 20-60s cache ki jagah existing WebSocket feeds (`cxRtStream`, `binanceFutWs`, `cxBookState`) se 1-2s price.

### Phase 5 — Reconciliation, Dead-man Switch, Kill-switch hierarchy

10-15s reconcile loop: `getPositions()` = truth; orphan adopt + protection check; ghost close with honest reason; qty sync. Heartbeat 5s + watchdog (heartbeat >30s stale AND open position → Telegram CRITICAL). Kill-switch L1/L2/L3 (no new entries / reduce-only / flatten + disable). Leader lease (`SMARTAI_EXEC_NODE=laptop`) — Render par `PROTRADER_AUTO` force-off. Startup recovery: `getPositions()` → protection verify → phir hi naya entry. **Estimated 2-3 days.**

### Phase 7 — Signal quality & calibration (3-4 days + ongoing)

Verify gates (75/65/90 + CONFIRM) against ledger bucket-wise win-rate/expectancy (R); if "verified ≥ 90" edge not visible, re-tune via `gateTuner.js` / `driftMonitor.js` reuse (min sample ≥ 100 closed trades). New filters: regime, spread/depth/liquidity, funding cost, `eventGuard`, `globalRisk` risk-off, correlation bucket. LLM veto (Ollama): strict JSON `{verdict: GO|NO_GO|REDUCE, reasons[], red_flags[]}`; only downgrades. Shadow mode 2-4 weeks. Stop-and-reverse OFF in leveraged mode.

### Phase 8 — UI & Telegram

ProTrader panel: execution mode badge (PAPER/LIVE, API/BROWSER), protection status (SL on exchange ✔/✘), live R-multiple, stage (T1/Runner), liq distance, wallet equity/margin use, RAM governor state, Ollama status/latency, kill-switch L1/L2/L3 buttons. Telegram: entry/T1/T2/trail/close alerts, `/halt`, `/reduce`, `/status`, "PROTECTION MISSING" CRITICAL. Daily/weekly report. **Estimated 2-3 days.**

### Phase 9 — Replay, Paper Soak, Staged Go-Live (calendar: 6-8 weeks)

1. Replay/backtest: recorded candles on position manager (exits) — LLM ke bina (deterministic) + sampled LLM replay.
2. Paper soak 3-4 weeks (PaperPort, real feeds, real RAM load: Chrome + Ollama + server).
3. Live micro: min size, 1-2x, 2 weeks, one pair.
4. Ramp: 5x (risk 0.5% → 1%), ek-ek step jab pichla stage clean ho.
5. 7-10x sirf jab: ≥100 live closed trades, expectancy fees ke baad positive, max DD limit ke andar, protection-miss = 0, reconcile mismatch = 0.

---

## 5. Definition of Done (v1)

1. Live mode me **har position par exchange-resident SL** (verified), warna entry hoti hi nahi.
2. Size **wallet equity × risk%** se; leverage exchange par **read-back verified**.
3. T1/T2/runner/trail/give-back + tiered reversal (candle-close) automated + tested.
4. Reconcile loop + dead-man alert + kill-switch L1-L3 chaos-tested.
5. Ollama (8B) + Chrome + server **16GB me stable** (RAM governor ke saath 8+ ghante soak).
6. Ek journal, ek caps-set; Render par auto OFF.
7. 3-4 hafte paper + 2 hafte micro-live ke metrics dashboard par.

---

## 6. Verification of v20.6 fixes shipped

- `npm run typecheck` → clean (tsc --noEmit).
- `npm test` → all green (153 files + new `sizing.test.ts` + `ramGovernor.test.ts` + `llmChainEnv.test.ts`).
- `npm run build` → clean (Vite production bundle, 2250 modules).
- SelfImprovementPanel import in CoinDcxTab.tsx removed (TS6133 unused-flag clean).
- ml-service `main.py` ast.parse clean.
- `Start-AutoBrowser.bat` line-length sane (single-line `start` command).
- All new env keys documented in `.env.example` (lines 480-557).

---

## 7. Risks (seedhi baat)

| Risk | Mitigation |
|---|---|
| 5-10x par chhoti galti = bada nuksan; liquidation | risk%-based sizing, liq ≥ 2.5×SL, daily/weekly brakes, staged ramp |
| Naked position (SL exchange par nahi) | protection-first rule + flatten-on-fail (Phase 4 — DEFERRED) |
| Laptop sleep/crash/internet drop | native SL, dead-man alert, startup recovery, power-plan |
| Browser DOM change | canary + selector overrides + auto-halt (Phase 6 — DEFERRED) |
| Ollama slow / RAM pressure | veto-only role, queue=1, RAM governor (DONE v20.6) |
| Overfitting (gate/weights tuning) | min 100 trades, out-of-sample, shadow compare |
| Duplicate execution (Render + laptop) | leader lease (Phase 5 — DEFERRED) |
| Signal edge hi na ho | Phase 7 calibration — data bolega |
| Exchange ToS / regulatory / tax | live se pehle current rules khud verify; API ko prefer |
| Over-trust | PAPER/LIVE badge, metrics hamesha visible |

---

## 8. First week checklist (post-v20.6 deploy)

- [ ] Confirm `[selfimprove] v20.6 SELF-IMPROVEMENT ENGINE DISABLED by default` log line on boot.
- [ ] Confirm `[ram-governor] v20.6 armed` log line.
- [ ] Confirm `[ml-service] hf models DISABLED by default` log line.
- [ ] Set `.env`: `LLM_LOCAL_ONLY=1`, `OLLAMA_MODEL=qwen3:8b`, `RAM_YELLOW_FREE_GB=3.5`, `RAM_RED_FREE_GB=2`.
- [ ] Paper mode me SAPTA 1 din chalao; check no `[selfimprove]` lines in console (loop disarmed).
- [ ] Check CoinDcxTab: Self-Improvement Engine section GONE (panel unmounted).
- [ ] Check the `sizing.test.ts` + `ramGovernor.test.ts` + `llmChainEnv.test.ts` green.
- [ ] (Optional) Set `SELFIMPROVE_ENABLED=true` to re-arm the loop for manual one-shot ops via `/api/ai/self/*`.

---

**Build order:** ~~Audit~~ (DONE v20.6) → Port → Sizing (DONE pure-fn, needs Phase 2 wiring) → Protection-first/Exit manager → Reconcile/Kill → ~~LLM local+RAM~~ (DONE v20.6) → ~~Browser hardening flags~~ (DONE v20.6) → Calibration → UI → Paper soak → Micro-live → Ramp.

This audit + Phase 1/3/6 work is research/engineering, not financial advice. Leveraged auto-trading me poori capital ka nuksan possible hai — sirf wahi paisa lagao jo gawane ki capacity ho.
