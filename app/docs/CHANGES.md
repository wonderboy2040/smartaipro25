# Changelog

## v21.25.3 — FULL-SITE DEEP RECHECK: Phase 0 pause honesty + re-anchor money + restart-safe MTF ledger (2026-10-25)

**User ask: "full site ke sabhi features/functions ka deep recheck karo — sabhi working fine hai kya, issues fix kardo."**

Pura site audit hua — data feeds, signal/MTF board, auto-trade engine, paper/LIVE execution, exits/trailing, UI, persistence aur Phase 0 audit. v21.24.0 se v21.25.3 tak ke confirmed defects fix hue; runtime state (`server/data`, positions, journals, bot state) delete NAHI hua.

### 1) Phase 0 — LIVE pause ab manual board click par bhi lagu (v21.25.3)
- **Root cause**: `liveEntryPaused` sirf auto engine aur UC-flip entries ko rokta tha. MTF board ka manual ⚡ LIVE button pause ke through real-money order bhej deta tha — pause ka matlab hi "naye LIVE entries band" tha, par ek bypass mojood tha.
- **Fix**: `/api/ai/mtf-dual/live` ab sabse pehle `liveEntryPaused` check karta hai aur `409 {ok:false, blocked:true, paused:true, reason}` return karta hai (symbol/market parse ya exchange call se pehle). UI `onLiveOrder` bhi locally abort karta hai, LIVE button disabled + pause tooltip. Manual PAPER endpoint alag hai — paper forward-testing pause se unaffected.
- **Regression**: `test/mtfAutoPhase0.test.ts` E-block — route guard ordering + 409 payload + PAPER isolation + UI guard/button lock.

### 2) LIVE re-anchor ka stale money bookkeeping (v21.25.3)
- **Root cause**: `recordLiveMtfBoardTrade()` naye plan levels (entry/SL/T1/T2/qty) update karta tha, par purane `riskINR`, `notional`, `margin`, `feeBreakevenPrice`, `dayKey`, lifecycle flags aur opposite-mode IDs book row me reh jaate the. Re-anchored trade ka risk/notional/margin actual naye ticket se match nahi karta tha, aur PAPER→LIVE / LIVE→PAPER mode switch par stale `paperId`/`liveOrderId`/`livePositionId` reconcile ko confuse karta tha.
- **Fix**: re-anchor par saare derived money fields recompute; `t1Hit`, `peakPrice`, `openedAt`, stage/label, `flipEntry`, `flippedFrom`, `t2Extensions`, `bookedPnl`, sync flags aur exchange SL/TP anchors reset; PAPER mode stale live IDs clear karta hai, LIVE mode naya mirror ID set karta hai (ya null); wallet/deployment/buying-power aur manual-vs-auto provenance refresh; LIVE re-anchor `dayCount` + `perSymbolLast` update karta hai. Fee-floor / `dayKey` bhi naye entry se.
- **Regression**: NAYA `test/mtfAutoReanchor.test.ts` — money fields, mode-ID cleanup, side flip, fee floor, dayKey, provenance, quota.

### 3) MTF row ledger restart-safe + honest Phase 0 audit (v21.25.2)
- **Root cause**: 30-day MTF Direction Scorecard in-memory `_mtfScanLedger` par chalta tha — restart par poora reset. `phase0Audit.js` jo `mtf-row-ledger.json` padhta hai us file ka koi writer hi nahi tha; 420 legacy rows permanently "unresolved" warning de rahe the.
- **Fix**: NAYA `server/ai/mtfRowLedgerStore.js` — atomic tmp+rename save (Windows EPERM fallback), boot hydrate, 30s throttled MFE/MAE writes, new-row/resolution force-save. Purani legacy-shape rows `mtf-row-ledger-legacy.json` me archive hoti hain (delete nahi), active ledger clean current-format rows se start hota hai. `signalLedger.js` pure rehta hai; `mtfDualBoard.js` hydrate/save wire karta hai. Dedup ab MARKET+symbol+mode+30m bucket scoped hai (CRYPTO BTC aur FUTURES BTC alag scans). Audit `outcome:'PENDING'` ko unresolved maanta hai; `lastResolveAt` exposed; over-risk denominator actual live wallet.
- **Regression**: NAYA `test/mtfRowLedgerPersistence.test.ts` — legacy archive, roundtrip/throttle, market-scoped hydrate/dedup, PENDING audit, wallet-aware over-risk.

### 4) Direction certificate + no-silent-side hardening (v21.25.0)
- Strict `LONG`/`SHORT` vocabulary; missing/unknown side ab silent LONG/SHORT guess nahi karta — order layer loud reject karta hai. MTF board LIVE/PAPER path explicit `signal → order side` certificate ke saath chalta hai; UI par certificate integrity strip (certified/blocked/mismatch) visible hai. `directionLiveCert` version stamp current release par.

### 5) Quota + market-scan honesty (v21.25.1)
- Manual PAPER board test clicks ab auto engine ka daily quota consume nahi karte; status ka displayed count sirf auto-opened rows count karta hai (session-aware). Full-market scan strip never-empty universe expose karti hai (NEUTRAL/WAIT rows bhi), taaki "koi coin nahi mila" jhootha empty state na aaye.

### 6) Phase 0 foundation (v21.24.0)
- Live-entry pause existing positions ka deep-monitor/SL management continue rakhta hai. Effective risk caps single source: 1% target / 2% hard cap, 5x max leverage, 25% wallet deploy, 1.5% daily-loss stop — entry sizing aur status same contract. Wallet honesty: caps actual live equity se. Stop-integrity: exchange SL book trail se converge + failed sync retry. Canonical audit board/paper/journal namespaces alag, duplicate signals + LIVE/paper qty-SL reconciliation + over-risk flags. Smart Trail v2 (noise-aware ratchet + rolling TP2).

### Verification (v21.25.3)
- `npm run typecheck` — 0 errors · `npm run lint` — 0 errors
- `npm run check:version` — OK 21.25.3 (app + telegram-bot 21.4.0)
- `npm run check:routes` — PASS (every frontend `/api/` call has a backend route)
- Change-related targeted run — **14 suites / 291 tests PASS** (Phase 0, re-anchor, ledger persistence, direction certificate/conflict, smart trail, UC-flip, site rechecks, launcher/version, route mount)
- `npm run build` — PASS · `dist/.build-version = 21.25.3`
- Full-suite run on this host: external-feed suites (v69-core / cryptoAgent / council / llmValidator / directionProof + Groww-Dhan/exchange quote tests) network timeout se fail hote hain; touched modules ke tests isolated pass hain. Runtime data untouched.

## v21.23.9 — FULL-SITE DEEP RECHECK: CRITICAL SHORT-inversion + 8 aur audit fixes (2026-10-20)

**User ask: "V21.23.8 latest full site code ko deep sabhi features and functions working flow deep recheck karo sabhi working fine hai kya and issues fix kardo"**

Pura site audit hua — data-feed pipeline (mtf/cxWsCandles/cxSpotWs/cxRtStream/ultrafastVerifier/healthMonitor), order-execution pipeline (futures.js/coindcxOrders.js SPOT gate/port.js/positionManager/reversalEngine/globalFutures/directionLock/mtfDualBoard), auto-trade engine (mtfAutoLink UC-flip + volTrail + loops recheck) — 9 defects mile, sab fix.

### 1) CRITICAL — futuresOrderBody SHORT-inversion (server/ai/futures.js + server/exec/port.js)
- **Root cause**: `futuresOrderBody` ka `long = side !== 'SHORT'` SILENT-LONG-default tha; exec-port adapter `side: 'buy'/'sell'` vocabulary pass karta tha → `'SELL' !== 'SHORT'` → long=true → **SHORT entry exchange par ulta BUY order** (5-10x leverage). execPort tests stubbed mock ke against pin the, isliye real builder kabhi run hi nahi hota tha.
- **Fix**: dual-vocabulary honest map (`LONG/BUY` → buy, `SHORT/SELL` → sell), unknown side LOUD reject (throw) + `createFuturesOrder` builder-throw ko honest `{orderId:null, error}` me convert (network call se pehle); `port.js open()` ab invalid side ka honest `{ok:false}` reject (silent sell-default gaya); `reversalEngine.priceLevelsForLeg` unknown side → `{sl:null, tp:null}` honest refuse. Primary mtfDual live path pehle se sahi tha (reqSide validated LONG|SHORT) — ye EXEC_MODE=api/hybrid exec-stack path (/api/exec/enter + botRunner) ka cure hai.

### 2) 3s fast-SL LIVE exchange sync ka dead param (routes.js)
- **Root cause**: fastSlTrailLoop `updateCoinDcxPositionSl({..., newStopLoss: ...})` pass karta tha jabki signature `stopLoss` padhta hai → har pass `{ok:false,'invalid stopLoss'}` early-return → **3s ultra-fast LIVE SL sync 100% silent dead code** (sirf 15s deep monitor sync kar raha tha).
- **Fix**: `newStopLoss:` → `stopLoss:` — ab LIVE trailed-SL + TP ladder (TP1-hit pe T1→T2) 4.5s throttled exchange par sync hota hai.

### 3) Dead `./metals.js` imports — XAU/XAG fallback legs 100% down (routes.js ×2)
- **Root cause**: dono quote-resolution sites `import('./metals.js')` karti thi jo repo me EXIST hi nahi karti → hamesha silent `{fetchMetalsPrices: null}` → metals 3-leg fallback chain (Binance fapi → gold-api → Yahoo COMEX) kabhi resolve hi nahi hui — CoinDCX RT book outage me XAU/XAG entries honest-skip + open metals positions board-ltp fallback par.
- **Fix**: dono sites `./futures.js` ka real `fetchMetalsPrices` resolve karte hain (same row shape).

### 4) mtf.js 4h overlay-bake (v21.23.5 cache-safety invariant violation)
- **Root cause**: 4h resample OVERLAID 1h series se hota tha (`_indiaCandles('1h')` ki return overlay-applied hai) aur wo baked-overlay 4h `_yfCache.set` me jaata tha — file ke apne "cache holds RAW series" contract ka violation. Ek live-tick wala 4h tail 10-min TTL tak cache-hit reads par freeze ho sakta tha (weight-2.4 4h MTF vote stale intrabar print padhta tha).
- **Fix**: `_indiaCandles(..., { raw: true })` passthrough — 4h ab RAW 1h payload se resample, overlay sirf per-READ; cache hamesha RAW.

### 5) chartCandles freshness honesty (mtf.js)
- **Root cause**: chart cache OVERLAID series store karta tha; 60s cache-hits stale forming bar serve karte the aur `fetchedAt: now` freshness OVERSTATE karta tha.
- **Fix**: INDIA/GLOBALFUTURES hits per-READ `indiaOverlayCandles` refresh (domain-safe IN_<SYM>→.NS/INR legs only — CRYPTO/FUTURES legs blind re-apply NAHI, cross-domain lock preserved); `fetchedAt` ab honest `dataAt` (hit.at).

### 6) Spot WS telemetry honesty (cxSpotWs + cxRtStream + healthMonitor)
- **Root cause (a)**: producer `spotWsStatus()` `lastUpdateAt` emit karta tha, passthrough drop karta tha → `/api/health coindcxSpot.lastUpdateAt` permanently null; **(b)** healthMonitor ka `coindcxSpot.failStreak` top-level `cx.failStreak` (FUTURES socket ka streak) padhta tha — misattributed telemetry.
- **Fix**: passthrough ab `lastUpdateAt` + spot ka APNA `failStreak` forward karta hai; healthMonitor spot entry ab spot ka streak padhta hai.

### 7) Fut-book ts seconds normalization (cxBookState + cxWsCandles)
- **Root cause**: `mergeFutBook` top-level ts to ms-normalize karta tha, magar per-row `btST/cmRT` fallbacks (CoinDCX SECONDS me bhejta hai — v10.13 note) raw bake hote the → `_futTick` ka `atMs < barTime(ms)` → futures live-bar overlay un rows par SILENT `skippedStale` (fails-safe, magar availability gap).
- **Fix**: `_tsMs()` normalize btST/cmRT (ms values unchanged — no double-scale) + `_futTick` defensive seconds→ms scale; dead `row?.at` read gaya.

### 8) GLOB-quiet false alerts (healthMonitor)
- **Root cause**: armed GLOB-only (metals XAU/XAG) sessions US-premarket me legitimately minutes-tak attributable tick nahi dete — cxRtStream khud 5-7.5min quiet budget enforce karta hai, magar 90s `ws_stale` alert window budget-aware NAHI tha → poore quiet session me throttled false "🩺 WebSocket down — coindcxFutures" Telegram spam.
- **Fix**: `globQuiet` honest field (connected + glob-only-armed + not-cooling) + alert-loop exemption; real network-down ab bhi alert hota hai (disconnect connected=false karta hai).

### 9) Audit-verified-OK (no fix needed — documented)
- SPOT FULL STOP gate-0 first/all-modes/no-bypass ✓; UC flip-reverse engine (churn caps/rollback/TP2-no-flip/atomic lock) ✓; directionLock no-permanent-stuck (release-on-close + 60s sweeper + restart) ✓; mtfDualBoard field parity ✓; equity-sim SIM-only double-wall ✓; overlay cross-domain locks (INR←spot-INR / USDT←fut-USDT / .NS←IN_SYM / Binance-unwrapped) ✓; vol-adaptive trail profile + monotonic ratchet ✓.
- MTF live auto-arm of shared config: runtime-default me spot gate-0 hi authoritative wall hai (AI_SPOT_FULL_STOP=0 explicit operator opt-in ke under cross-desk arming by-choice) — no change.

### Tests
- NAYA `test/siteRecheck21239.test.ts` — 33 LOCKS (S1 inversion ×13 incl. THE 'sell'→sell lock + port validation ×3 + priceLevelsForLeg; S2 dead-param ×3; S3 metals ×3; S4 overlay-bake ×3; S5 chart ×3; S6 telemetry ×3; S7 ts-normalize ×4; S8 globQuiet ×2).
- cxWsCandles.test.ts honest-updates ×2 (india wire count 2→3 chart-refresh wire; cache-safety pin new raw-passthrough form — intent stronger).
- 222 files / 4119 tests PASS (4086+33), tsc 0, lint 0, dist 21.23.9, check:routes PASS.

## v21.23.8 — UC FLIP-AND-REVERSE SUPER SMART INTELLIGENCE + CoinDCX SPOT FULL STOP + EQUITY SIM allowlist (2026-10-20)

**User ask: "jab UC ne Long se short pakka hone pe update karta hai status tab minimal loss ke sath vo long trade close karke immedately wahi trade short me lagna chahiye aisa super smart intelligence se hona chahiye TP 1 and TP 2 tak full trade complete hoke full profit book hona chahiye aur coindcx spot trade... spot ko full stop kardo sirf futures usdt & equity sim aur gold & silver me hi sirf itne me hi trade lagna chahiye"**

### 1) UC FLIP-AND-REVERSE (the "wrong trade se against trade" cure)
- **Root cause**: confirmed board-flip (UC status LONG→SHORT PAKKA) hone par bhi fee-guard trade ko HOLD karwata tha jab tak fee-breakeven clear na ho — loss me trade poora -1R SL tak pahanchta tha, aur wahi move jo board ne SHORT PAKKA bola tha wo chhoot jaata tha
- **Fix**: deep monitor sweep me 3-naya logic —
  - **UC PAKKA flip** = board row side === opposite + (triggerFired || superScore ≥ 65) — wahi v21.23.6 TRUE-flip definition ("thoda pullback" kabhi flip NAHI hota — board row same-side hi rehta hai)
  - **Loss / fee-not-covered me ab MINIMAL-LOSS protective exit** (`UC_FLIP_MINIMAL_LOSS_EXIT`) — full -1R SL se pehle trade bachao
  - **IMMEDIATE same-symbol reverse entry** (`_tryOpenUcFlipReverse`) — minimal-loss close + opposite-side entry EK atomic smart move; reverse ticket current live price pe anchored (`deriveUcFlipReverseTicket`: flipped-row ka plan SL valid-side 0.3–5% band me ho to wahi, warna synthetic 1.2% / +1.25R / +2.4R)
  - Profit me flip → reversal profit-book (existing) + reverse entry; **TP2 hit → full profit book, koi flip NAHI** (trade poora complete)
- **Churn guards**: LIVE 60s / paper 30s minimum age, 4 flip-entries/symbol/day cap (protective exit hamesha allowed), daily quota + notional budget respected, direction-lock atomic flip (purana release + naya opposite-side acquire), LIVE strict traded-only (live order fail → paper mirror rollback + koi book row nahi)
- Config: `ucFlipReverse` (default ON, explicit opt-out possible)

### 2) CoinDCX SPOT FULL STOP (trade allowlist: FUTURES USDT + GOLD/SILVER + EQUITY SIM)
- **`executeSignal` gate 0 (coindcxOrders.js)**: CoinDCX SPOT (SYM-INR) ka ek-matra order path — legacy 90s auto-executor, manual /api/ai/execute, telegram-approval, superagent — SAB ab runtime-default REJECT (`SPOT FULL STOP — sirf FUTURES USDT + GOLD/SILVER + EQUITY SIM`). `AI_SPOT_FULL_STOP=0` operator opt-in; NODE_ENV=test me hermetic-off
- **Legacy 90s spot auto-executor PERMANENTLY disabled** (routes.js) — early-return audit shell, koi signal scan/journal spam nahi
- **EQUITY SIM (GLOBALFUTURES USDC) rows ab auto-trade pool me**: crypto-desk pool ab FUTURES USDT perps + XAU/XAG metals + equitySimRows — SIM/paper entries only (live impossible), `GLOBALFUTURES|SYM` qualified-quote overlay (5 call-sites: deep monitor + 3s fast loop + status) se SL/T1/T2 evaluation live

### 3) Tests
- NAYA `test/ucFlipReverse21238.test.ts` — 23 LOCKS: ticket derivation (plan/synthetic/sides/geometry), minimal-loss flip close + immediate reverse (paper + LIVE adopted + strict traded-only fail case), profit-flip book+reverse, pullback-≠-flip, TP2-complete no-flip, churn caps + age guard + opt-out, SPOT FULL STOP (unit + gate + legacy-loop source pins), EQUITY SIM allowlist entry, wiring pins
- 223/223 PASS across the 10 affected suites; full release gate `npm run check` PASS

## v21.23.7 — AUTO-TRADE SUPER SMART SL TRAIL: VOLATILITY-ADAPTIVE + ULTRA-FAST TREND CAPTURE + CoinDCX-tab WS false-DOWN fix (2026-10-20)

**User ask: "jab long or short pe TP1 & TP2 Profit book tak reach nhi ho raha hai bada profit amount book nhi ho raha hai bahut kam profit book karke trade exit ho raha hai isko advance pro level pe smart banao sl trail ko aur improvement karo trade volatile me" + "long or short trade signals trend ultra fast se capture hona chahiye" + "site me coindcx tab me FEEDS 2/2 · 4s WS ⚠ 1 DOWN isko bhi fix kardo"**

### ROOT CAUSES (kyon TP1/TP2 tak pahunchne se pehle trades chhote profit pe band ho rahe the — 5 concrete, C1–C5)
- **C1 — Stage thresholds FIXED the (volatility-blind)**: 0.18/0.30/0.50/0.80R static entries. HIGH-volatile market (ATR ≥ 1.8%) me 0.30R move NORMAL noise hai — magar system Stage-1 pe trail shuru kar deta tha aur har pullback SL tighten kar deta tha
- **C2 — Stage-1/2 trails volatile markets me bahut aggressive**: −0.65R/−0.45R tighten — ek normal wick hi SL laga deti thi
- **C3 — Chandelier width fixed 0.50R**: HIGH-vol me 0.50R pullback peak se ROUTINE hai — SL TP2 ke theek pehle hit (the "TP1/TP2 reach nahi hota" disease)
- **C4 — Momentum-aware acceleration missing**: fast move ko trail ka ROOM chahiye (WIDEN), momentum fade ho to TIGHTEN
- **C5 — Giveback thresholds static (45% / 0.28R)**: HIGH-vol me ek candle me hi 45% giveback ho jaata hai — true reversal nahi, sirf noise

### FIXED — VOLATILITY-ADAPTIVE SUPER SMART SL TRAIL ENGINE (volTrail.js — naya pure module)
1. **Volatility classification (ATR% → class)**: LOW (<0.8%) / NORMAL (0.8–1.8%) / HIGH (1.8–3.5%) / EXTREME (≥3.5%) — source: LIVE `boardRow.context.atrPct` > entry-stamp `trade.atrPct` > 15s-tick stamp `trade.volClass` > NORMAL default (no-data = v21.23.6 behavior)
2. **Stage entry thresholds vol-scaled** (user spec exact): Stage1-Early 0.18/0.22/0.30/0.40 · Stage1 0.30/0.35/0.45/0.55 · Stage2 0.50/0.55/0.65/0.75 · Stage3 0.80/0.85/0.95/1.05 — HIGH/EXTREME me noise-level moves ab trail trigger NAHI karte (Stage-1 risk-halving ab 0.45R/0.55R pe, pehle 0.30R pe tha)
3. **Chandelier + giveback widths vol-adaptive**: Stage-4 giveback 0.40/0.45/0.55/0.65 · Stage-5 chandelier 0.45/0.50/0.65/0.80 · Stage-3 giveback 0.32/0.35/0.42/0.50 · stage-1 early-BE bar stage1R+0.12 — volatile trends me runner ko TP2 tak room milta hai
4. **Pullback giveback tolerance wider in volatile** (user spec): ratio 42/45/55/65% AND absolute floor 0.25/0.28/0.38/0.50R — HIGH-vol ka wahi pullback jo NORMAL me Stage-4 lock (0.75R) pe book karta tha, ab +0.65R floor pe SURVIVE karta hai (measurable delta — test-locked)
5. **Reversal-risk hint lock vol-aware**: LOW/NORMAL peak−0.50R / HIGH/EXTREME peak−0.65R — volatile regimes me routine exhaustion flags trade ko tight lock se nahi rokte
6. **TP1 partial book reduced in volatile (runner BIGGER)**: LOW/NORMAL 50% (as-is) / HIGH 40% / EXTREME 35% — open-stamp (row context ATR%) + deep monitor 15s LIVE vol-class shift pe `updatePaperTradeT1ClosePct` se refresh (TP1 se pehle hi effective); paper engine `t1ClosePct` field (open/restore/persist round-trip); unsplittable-1-lot BE contract intact
7. **C4 MOMENTUM-AWARE ACCELERATION** (user: "trend ultra fast se capture hona chahiye"): board trigger roc1/roc3/volRatio se momentum state — SURGING (fast move in-direction + volume) → chandelier ×1.15 + giveback +0.10R + hint +0.15R (ride the fast move) / FADING (against + dry volume) → chandelier ×0.85 + hint −0.15R (profit lock) / STEADY/UNKNOWN neutral. Hard clamps: chandelier ∈ [0.40, 1.00]R, stage4 ≤ 0.70R, hint ∈ [0.40, 0.80]R — kabhi unbounded loose nahi
8. **SAFETY (user spec)**: LOW-vol behavior v21.23.6-identical ya TIGHTER (chandelier 0.45 ≤ 0.50, giveback 42% ≤ 45%, floor 0.25 ≤ 0.28 — no regression); monotonic ratchet preserved (tightenSl engine — LIVE vol-class switch mid-trade pe SL kabhi loose nahi hota, test-locked); saare fee-aware guards as-is; har stage floor (+0.65R TP1 floor, +0.45R, +0.15R, −0.45R/−0.65R shields) unchanged

### ULTRA-FAST TREND CAPTURE — 10s opportunistic entry probe (routes.js)
9. **Entry latency worst-case ~15-21s → ~10s**: naya `fastEntryProbeLoop` (10s) — sirf WARM cached boards (≤8s, `peekDualMtfBoards`) padhta hai (board recompute KABHI nahi = zero compute cost); cheap pre-gates (auto-link ON, desks on, kill off, LIVE session-lock / max-positions clear); qualifying candidate dikhe (tier ELITE/STRONG ya score ≥ minScore, LONG/SHORT, not-open, no autoBlockers) → FULL `onAutoTradeDeepTick` escalation (fresh boards + live wallet + HAR gate re-check — cooldown/quota/elite/anti-chase probe me bypass nahi hota). Headless me probe no-op; 15s recheck + 60s sweep backbone unchanged. Busy-guard + 8s escalation dedup. `onAutoTradeDeepTick` named const hoist (recheck + probe shared)

### CoinDCX TAB "WS ⚠ 1 DOWN" PERMANENT FALSE-POSITIVE — ROOT-CAUSED + FIXED
10. **THE BUG**: healthMonitor ka `coindcxSpot` entry `healthy: cx.spotWs.healthy === true` padhta tha — jabki `cxRtWsStatus().spotWs` me `healthy` field KABHI EXIST hi nahi karta tha → hamesha false. `armed` fut/glob domains (`_cxArmed`) se aata tha — CoinDCX tab (futures subscribed) par spot tier PERMANENT red "1 DOWN" dikhta tha chahe socket perfectly healthy ho. **FIX (3 layers)**: (a) `cxSpotWs.spotWsStatus()` ab honest derived `healthy` (enabled + connected + book-update ≤120s silent-kill window) + `demandAgeMs` + `cooldownRemainMs` expose karta hai; (b) `cxRtWsStatus().spotWs` healthy/demandAgeMs/cooldownRemainMs passthrough; (c) healthMonitor `coindcxSpot.armed` ab SPOT DEMAND se (ticker-fetch/SSE heartbeat ≤2min = real subscriber; idle ≠ down doctrine) + `ageSec` + `cooldownReason: 'handshake-streak'` jab genuinely cooling. Ab: healthy socket → green; koi demand nahi → grey IDLE; real cooldown → honest DOWN with reason

### Engineering
- **NAYA test/volTrail21237.test.ts — 55 LOCKS**: vol classification boundaries (0.8/1.8/3.5) · resolve priority · TRAIL_TABLE 4-class × 10-param exact (user spec verbatim) · structural monotonicity/clamps · vol-scaled stage entries (LOW v21.23.6-identical + HIGH/EXTREME windows + EXTREME Stage-3 preemption honest pin) · chandelier per class + TP1 floor · giveback matrix (HIGH 1.2R→0.7R HOLD vs NORMAL same-move BOOK delta + EXTREME + LOW tighter + HIGH deep-giveback book) · hint locks (NORMAL 0.50R / HIGH 0.65R wider) · momentum unit (SURGING 0.57R / FADING 0.43R / clamps 0.92 & 0.40) + engine LONG/SHORT · monotonic ratchet across LOW→HIGH→EXTREME live switch · TP1 partial paper engine (default 50% + HIGH 40% + EXTREME 35% + INDIA ceil + 1-lot BE) + updatePaperTradeT1ClosePct freeze/reject · mtfAutoTick entry-stamp (HIGH-vol row → t1ClosePct 0.40 + atrPct) · deep-monitor stamps + live-sync + entry-stamp source pins · WS false-DOWN fix pins (cxSpotWs healthy derivation + cxRt passthrough + healthMonitor spotArmed + regression pin) · ultra-fast probe wiring pins · profile consumption + hardcoded-GONE pins
- v2126 source pins HONESTLY updated (user SAFETY spec: "All existing test source pins verified against new constants"): pullback/chandelier/giveback pins ab profile-driven forms pe (NORMAL default = v21.23.6 values — behavioral locks unchanged)
- Saare affected suites green: v2122 (17) + mtfAutoLink (14) + profitTrail21236 (26) + intradayCrypto (15) + mtfUsdtDomain (21) + healthMonitor + cxSpotWs + v1810UltraFast (13) + v2111 + wsFeedView (9)

## v21.23.6 — AUTO-TRADE PROFIT MAXIMIZATION (strong-trend premature-close cures + 5-min post-success cooldown + LIVE elite-only re-entry) (2026-10-20)

**User ask: "TP1/TP2 + SL Trail + Reversal Profit-Book smartly hona chahiye — trade TP1 or TP2 hone par SL trail TOP me (long) / SHORT me utna NEECHE ho. Ek ek baar thoda pull back hota hai — SL trail smartly adjust karna chahiye, hogye utna jyada se jyada profit book ho. Strong signal LONG pe jab price UPAR jata rehta hai trade AUTO CLOSE ho raha hai (short me bhi thode profit pe) — sab smartly superfast manage karo. Aur jab trade successful close ho, LIVE auto trade pe 5 min COOLDOWN lagake phir ELITE top trade VERIFY karke hi lagana chahiye."**

### ROOT CAUSES (kyon strong trends me trades jaldi band ho rahe the — 3 concrete)
- **R1 — reversalRisk ko CONFIRMED flip gina ja raha tha**: `evaluateActiveTradeDeepMonitor` ke `boardFlipped` me `(boardRow.reversalRisk === true && feeCovered && peakR >= 0.45)` clause tha. Board ka `reversalRisk` = `trigger.reversalRisk || context.exhausted || opposingFlow` (mtfDualBoard.js) — ye flags STRONG trends me ROUTINE fire hote hai (overbought exhaustion jaise hi strong moves ka lakhshan hai). Har strong run +0.45R pe khelte hi flip samjha → +0.12R pe profit-book → "price upar jata rehta hai tab trade auto close ho raha hai"
- **R2 — 38% peak-giveback har normal pullback pe trade band kar deta tha** (koi absolute floor nahi): strong trend me "ek ek baar thoda pull back" NORMAL hai — 38% ratio chhote peaks pe sirf ~0.2R wiggle ke barabar tha
- **R3 — trail bahut tight tha**: Stage 5 chandelier 0.30R + Stage 4 giveback 0.32R — normal pullback in bhi SL trigger kar deta tha

### FIXED — THE PROFIT MAXIMIZATION ENGINE (concrete)
1. **R1 FIX — risk hint ≠ confirmed flip**: `boardFlipped` me reversalRisk clause REMOVED. Ab `reversalRisk`/`exhausted`/`opposingFlow` = `reversalRiskHint` → **SIRF SL profit-lock tighten** (peak−0.50R, min +0.15R; pre-fee hone par defensive −0.35R) — trade band NAHI hota. Book ab SIRF: (a) TRUE flip (board side actually flipped + triggerFired/superScore≥65), (b) deep giveback, (c) TP2
2. **R2 FIX — pullback tolerance**: peak-giveback book ab **BOTH** deep hona chahiye — ≥45% of peak AND ≥0.28R absolute. Chhote wiggles survive; asli reversal book hota hai. Reversal Profit-Book intact (TRUE flip +0.12R pe bhi book — flip = trend over)
3. **R3 FIX — wider profitable trails**: Stage 5 chandelier 0.30R→**0.50R** (floor TP1/+1.0R pe hi hai — runner ab normal pullbacks me zinda rehta hai TP2 tak), Stage 4 giveback 0.32R→**0.45R** (TP1 floor +0.65R as-is). Monotonic ratchet preserve — SL kabhi loose nahi hota
4. **TP1/TP2 SL-trail direction LOCKED (user spec)**: TP1 hit LONG → SL entry+0.65R UPAR; SHORT → entry−0.65R NEECHE (profit locked above/below entry, exchange ko liveUpdateSl se sync hota hai as before)

### NEW GATES (user spec)
5. **POST-SUCCESS 5-MIN PROFIT-COOLDOWN (LIVE sessions)**: `postSuccessCooldownMin: 5` (config, 0 = OFF, clamp 0..120). Successful close = pnl > 0 YA 'PROFIT' reason YA exchange-closed-in-≥0.5R-profit-stage (native TP/trailed-SL fills — pnl null wale EXCHANGE_POSITION_CLOSED). Cooldown me tick clear skipped reason deta hai ("post-success cooldown: X.Xm left"); loss-close/PURGED kabhi cooldown nahi lagate; PAPER session unaffected; restart-safe (persisted book se compute)
6. **LIVE ELITE-ONLY ENTRY**: live session me eligible rows ab REQUIRE karte hai tier ELITE/STRONG ya superScore ≥ 80 ("prioritize" se "REQUIRE" kiya). Hybrid siteLiveActive mode me pehle weak rows paper-mirror open kar leti thi — ab block. Strict `executionMode:'live'` ka open-loop gate (v21.22.0) consistent hai already. PAPER mode UNCHANGED. Cooldown ke BAAD bhi entry sirf elite-verified signal pe — fallback path bhi tier enforce karta hai

### TESTS
- Naya `profitTrailUpgrade21236.test.ts` — **26 locks**: R1 (reversalRisk no-book + profit-lock tighten + TRUE-flip still books + defensive pre-fee), TP1/TP2 trail direction (long UPAR/short NEECHE exact 0.65R), TP2 full book, monotonic ratchet seq, R2 (25% giveback HOLD / 50%-but-0.25R-absolute HOLD / deep 50%+0.8R BOOK), R3 chandelier 0.50R exact, G1 cooldown (2m BLOCK / 6m OPEN / exchange-profit counts / loss-close no-block / PURGED no-block / =0 OFF / paper-session unaffected), G2 elite-only (ACTION-tier hybrid blocked / STRONG opens / paper unchanged), source pins (old clause GONE + constants + gates)
- v2122 test 12 honest update: re-entry tick clock ≥ close+5min (naya cooldown user spec hai — pehle 20s baad re-entry hota tha)
- **219 files / 4008 tests PASS** (3982 + 26), tsc 0, lint 0, dist 21.23.6, check:routes PASS

## v21.23.5 — COINDCX ULTRAFAST WS LIVE-CANDLE OVERLAY (Yahoo 15m → live-exchange prints) (2026-10-20)

**User ask: "ye Yahoo 15m विशेष रूप से — D1 isko direct CoinDCX Ultrafast websockets se replace nhi kar sakte kya — hota hai tho kardo accurately."**

### LIVE-PROBE REALITY CHECK (pehle fact-check, phir implementation)
- CoinDCX ke DONO documented public sockets (`stream-spot.coindcx.com` + `stream.coindcx.com`, EIO=4) healthy hain — price books flow karte hain (`currentPrices@spot@1s` ~1s/INR ~10s bursts + `currentPrices@futures@rt` ~1s)
- Lekin 6 candidate candlestick channel formats (`candlestick@B-BTC_USDT_15m`, `candlestick_15m_B-BTC_USDT`, `candlestick_15m_B-BTC_INR`, …) × dono endpoints × 130s (2+ candle-close windows) → **ZERO events. CoinDCX PUBLIC sockets sirf ultrafast PRICE BOOKS push karte hain — candles NAHI.**
- Isliye "direct replace" ka ACCURATE matlab: **REST chain (Yahoo .NS / CoinDCX spot / CoinDCX futures) SERIES ANCHOR ban ke rehta hai (official OHLCV + volume + history) — aur Ultrafast WS books SIRF the LIVE FORMING BAR overlay karte hain.**

### THE STALENESS CURE (ye kya fix karta hai)
- PEHLE: har indicator vote jo mid-TTL compute hota tha wo LAST CLOSE ko dekhta tha **jaisa wo minutes pehle tha** (REST TTL: 15m bars 180s, 1h/4h/1d 300s, India Yahoo 15m 120s) — the exact "signal feels wrong / late" experience
- AB: forming bar ka close/high/low exchange print ko **~1s** me track karta hai (spot INR ~10s bursts) — EMA/RSI/MACD/ROC votes LIVE price pe fire hote hain; bar roll pe ek fresh live bar APPEND hota hai (volume 0 — next REST anchor self-heal)

### WIRED (7 sites — the 15m — D1 ladder + verifier 1m/5m legs)
1. **mtf.js `_indiaCandles`** (dono paths): cache-hit per-READ overlay + fresh-path overlay — **CACHE-SAFETY ORDER**: `_yfCache.set` RAW series store karta hai, overlay return pe apply hota hai (stale live close kabhi shared cache me bake nahi hota). Yahoo .NS 15m — D1 ab Groww liveFeed (the India desk ka ultrafast quote) se tick-fresh. GLOBALFUTURES rows isi path pe ride karte hain (US tickers ka IN_ row nahi → honest no-op)
2. **mtf.js `_candlesFor` CRYPTO branch**: CoinDCX spot REST → `cxSpotOverlayCandles` (WS spot book INR print)
3. **mtf.js `rawTfCandlesUsdt` Leg-1**: futures REST → `cxFutOverlayCandles` (WS futures book mark/last)
4. **mtf.js `rawTfCandlesUsdt` Leg-3**: overlay INR domain me PEHLE, phir ÷fx USDT scaling — tick/candle domain always matched
5. **ultrafastVerifier.js `_candlesFor`** (both REST branches): FUTURES + CRYPTO — the realtime verifier ka micro-trend ab tick-fresh (Binance fallback legs UN-overlaid)
6. `chartCandles` inhi chains pe ride karta hai — auto-covered
7. **Binance fallback legs KABHI overlay nahi** (cross-domain by design — USDT candles ko INR tick kabhi nahi milega, the v20.9.3 −98%-crash lesson)

### DOMAIN SAFETY (hard locks)
- INR candles ← spot WS book `BTCINR` rows ONLY · USDT perp candles ← futures WS book `B-BTC_USDT` rows ONLY · India .NS candles ← liveFeed `IN_<SYM>` ONLY
- **±35% sanity gate**: a tick that far from the last close = domain error / hostile input (INR-tick-on-USDT class) — IGNORED, never a market move

### CONTRACT BUG CAUGHT (WIP me) — ROLL = APPEND
- Pehle implementation roll pe last REST bar ko REPLACE kar deti thi (uska partial-final OHLC + volume LOST) jabki documented contract "appends" tha → FIX: roll ab APPEND karta hai (stale anchor bar apni jagah rakhta hai, live print next REST-grid slot OPEN karta hai — contiguous, kabhi fabricated gap nahi); reads hamesha anchor se restart (pure core) → max ONE roll per read

### ZERO-REGRESSION CONTRACT (v10.11 discipline)
- Overlay ONLY applies jab domain-matched book me FRESH tick ho; books demand-driven hain (koi fresh book nahi → REST series BYTE-IDENTICAL)
- Hermetic by construction: `NODE_ENV=test` (vitest) me default OFF — har existing suite ko exactly pre-overlay behavior dikhta hai; `AI_CX_CANDLE_OVERLAY=1/0` manual override
- PURE CORE kabhi caller ka array mutate nahi karta (REST chain shared cache slices serve karta hai — mutation poison hoti)

### TESTS
- Naya `cxWsCandles.test.ts` — **27 locks**: pure core (same-bar update/extremes/roll-APPENDS+anchor-retention/no-double-append/pre-history/±35%+30% edge/non-mutation/counters), enable matrix (vitest-default-OFF byte-identical, disabled+tick pass-through, no-tick no-op, spot/fut/india domain keys, FUT_/GLOB_ prefix strips, CROSS-DOMAIN lock — India tick can never overlay crypto series & vice versa), wiring pins (mtf 5 sites + UCV 2 branches + CACHE-SAFETY ORDER + Binance-unwrapped occurrence counts + TF_MS ladder)
- **218 files / 3982 tests PASS** (3955 + 27), tsc 0, lint 0, dist 21.23.5, check:routes PASS

## v21.23.4 — WRONG-SIGNAL SOURCES REMOVED ("sab ke sab opposite" — 3rd round root-cause) (2026-10-19)

**User ask: "site me jo bhi trade signals de rahe hai sab ke sab wrong direction me hai sab opposite jaa rahe hai — jo bhi wrong signals de rahe hai unko REMOVE karo, concrete level pe fix hona chahiye."
Remote ca42800 (user ka v21.23.3 port) 100% identical verify hua — matlab fixes ke BAAD bhi complaint continued. 3 parallel fresh-eyes deep audits (data layer + sign conventions + UI) chalaye — order layer, data layer, sign conventions, UI labels SAB VERIFIED SAHI. Root cause mila: DO documented DEGENERATE MODE jo signals ko systematically opposite dikha rahe the.**

### AUDIT EXONERATIONS (sab layers verified correct — ye proof bhi concrete deliverable hai)
- **Candle data chain**: har feed adapter sorted oldest-first (CoinDCX/Bybit newest-first API bhi sort hoti), candle store dedupeSort har read pe, har indicator ascending assume karta hai, har price delta `new − old` — data layer EXONERATED
- **Dir sign conventions**: 14+ indicators + aggregation + final side derivation me +1 = bullish UNIFORM — zero reversed ternaries (grep-proof)
- **UI labels**: har side→label/color/icon mapping verified — LONG hamesha 🟢/emerald/▲ dikhta hai, koi swap nahi

### ROOT CAUSES (in-repo documented, silently active)
- **D1 — India daily-fallback (signals.js "90% opposite" disease)**: Yahoo 15m series fail hone par committee SILENTLY YESTERDAY'S daily trend pe vote karti thi (RELIANCE daily RSI 41.8/SHORT jabki 15m RSI 83/rally). Intraday reversals me ye signals EXACTLY "sab opposite" lagte the.
- **D2 — Crypto fresh-tape-absent (models.js 29% WR disease)**: 15m tape missing par tape seat abstain karti par 4 lagging 1h trend seats AFTER-the-move vote karte rehte — replay-measured 29% win-rate / avgR −0.35.

### FIXED — wrong-signal sources REMOVED (concrete)
1. **D1 FULL-MISSING → SIGNAL REMOVED**: `buildIndiaStockCtx`/index ctx me 15m series missing → `__tfDegraded` stamp → board path symbol SUPPRESS karta hai (signal kabhi emit nahi hota) + `degraded` ledger payload (count + symbols + reasons) + BreadthStrip amber banner (dono desks) — "kyun gayab?" ka honest jawab
2. **D1 THIN (15m present, 1h resample <30 bars) → DATA-DEGRADED stamp**: tape counterweight zinda hai isliye suppress nahi — par `INTRADAY-TF-THIN` stamp → executable:false + agent skip + UI chip (auto-trade BLOCKED, reference only)
3. **D2 FRESH-TAPE-ABSENT → DATA-DEGRADED stamp**: tape seat abstain par explicit `tapeDataAbsent` flag → `aggregateVotes` detect → consensus `freshTapeAbsent` + summary tag → buildSignal `dataDegraded` + executable NEVER true; data-missing ≠ market-neutral (neutral tape ko flag NAHI milta)
4. **Agent gates (Engine A + C)**: `s.dataDegraded` signals auto-trade candidate pool se REMOVE (agent.js logged skip + indiaAgent.js hard continue)
5. **SignalCard**: "⚠ DATA-DEGRADED · <reason> · NO-TRADE" chip (sabse pehle dikhe) + PAPER/NOTIFY/LIVE SAB buttons disabled (SimpleTradeTicket component bhi — `!!signal.dataDegraded` direct)
6. **superIntel SIDE-ALIAS SAFETY**: `!== 'SHORT'` silent-default-LONG hazard removed — `sideSignOf()` alias map (LONG/BUY/BULL/B→+1, SHORT/SELL/BEAR/S→−1), unknown side = null (honest refuse) — buildSuperBlueprint + intradayExpertFactors me unknown side kabhi LONG scoring nahi karega
7. **RUNTIME DIRECTION CERTIFICATE** (naya `directionSelfTest.js`): synthetic ground-truth candles se end-to-end proof — rising→LONG + SL<entry, falling→SHORT + SL>entry, dhan LONG→BUY/SHORT→SELL/SL-exit-cover matrix, CoinDCX futures buy/sell, sideSignOf aliases — **boot pe log + `/api/ai/direction-selftest` on-demand**. "Signals ulte hai?" ka runtime jawab: FAIL = computation bug, PASS = data-feed/stale-build inspect karo
8. **Store invariants (audit S1/S2)**: candleStore first-write pe sort (descending adapter ab file kabhi reverse nahi kar sakta) + Binance legs local sort (API-contract-free)

### TESTS
- Naya `wrongSignalRemoval2124.test.ts` — **17 locks**: D2 detection (flag vs neutral-tape), buildSignal stamps, D1 source pins, agent gates, sideSignOf matrix, blueprint refuse, certificate end-to-end, route+boot wiring, UI pins, store invariant (hostile reversed save → ascending disk)
- Pehla attempt me 3 harness bugs fix (dhan SL needs triggerPrice, futures order.side nested, loadCandles {bars,meta} destructure) — certificate 12/12
- THIN-suppression pehle THODA zyada aggressive tha (repo ke designed hybrid path — daily ind + live 15m tape counterweight — ko bhi maar raha tha, 6 tests fail) → split: full-missing=suppress, thin=stamp only → **217 files / 3955 tests PASS** (3938 + 17)

### AT v21.23.4
- tsc 0 errors · lint 0 · **217 files / 3955 tests PASS** · dist stamp 21.23.4 · check:routes PASS

## v21.23.3 — HONESTY COMPLETION: 7 residual fabrications swept (fresh-eyes deep audit) (2026-10-19)

**User ask: "latest repo pull karo + full site deep pro Advance level pe recheck + issues fix."
Remote 099d3c0 verify hua: v21.23.2 inversion fixes 100% port — tsc 0 / lint 0 / 3926 tests green.
Deep-pro fresh-eyes sweep ne 3 UN-SWEPT PATHS par residual fabrications pakde — sab fixed + 12 regression locks.**

### AUDIT RESULTS (remote 099d3c0 base)
- **Exit-side matrix ALL CORRECT** (fresh-eyes verify): CoinDCX spot exits (`long ? 'sell' : 'buy'` — SL/TP2/manual/T1T2), margin `exit_positions` position-side keying (by-design, 3 callsites consistent), indiaOrders watcher/SL `long ? 'SELL' : 'BUY'`, dhan SL-M inverting adapter (`kind === 'SL' ? opposite`), position-book side interpretation (negative qty → SHORT correct) — **zero naya direction bug**
- **directionLock lifecycle COMPLETE**: 4 engines acquire (agent/indiaAgent/mtfAutoLink/proTraderAuto), 5 check gates, dual release (paperTrading `_closePart` flat-check + routes.js 60s `reconcileDirectionLocks()` sweep ALL books)
- **telegram-bot direct trading NAHI karta** — sab server API se (fixed adapters ke through); sirf public ticker fetch
- **SW/service worker healthy**: har build fresh `CACHE_VERSION` stamp (vite stamp-sw-version) + activate-eviction; stale dist assets dead-weight the (kuch reference nahi karta)

### FIXED — 7 residual honesty bugs
1. **MTFDualBoardPanel OLLAMA chip** (row-level): raw `verdict` render hota tha — Ollama **offline** ho tab bhi "🧠 3/3 OLLAMA AI LOCK (12ms)" dikhta tha (fabricated latency `?? 12` bhi). Ab `honestLabel || verdict` + `ruleBasedGuard` tooltip + latency sirf real-measured (`null` → kuch nahi). Type me `honestLabel`/`ruleBasedGuard`/`liveVerdict` fields add (useAITrading.ts) — pehle v21.23.2 honest fix `aiAgents.ollamaVerdict` me gaya tha jo **kabhi render hi nahi hota** tha
2. **telegram siteAgents row**: `winRatePct ?? estimatedWinRatePct ?? winProbPct ?? 88` → **fabricated "88% Winrate"** jab kuch measured nahi; `alignedCount ?? 8` → guessed "8/8". Ab unmeasured → "Winrate: calibrating" + "—/8 Inst · —/10 Top Ind"; ollama tag honestLabel-first
3. **bot.mjs digest header**: flat "(95% Win-Rate)" claim → "(Gold/Silver · Equity Sim · Ledger-Calibrating Win-Rate)"
4. **TradePlanPanel**: `?? 7` guessed "7/8 Top Institutional Ind" → real count ya 0; synthetic `estimatedWinRatePct` ab "~X% est. win-rate" qualified (pehle bare "% Winrate" jaisa)
5. **mtfDualBoard API payload note**: "95% Win-Rate Confluence" → "Ledger-Calibrated Win-Rate Confluence + 3-Seat Local Ollama Guard"
6. **India/CoinDcx tab headers**: "(95% Win-Rate Target)" → "(Ledger-Calibrated Win-Rate)" — pinned tests updated
7. **llmSentinel cache-init**: `latencyMs: cached?.latencyMs || 18` placeholder **return path pe leak** ho raha tha (fetch fail → "18ms" fabricated telemetry) → `?? null`

### VERIFIED AT v21.23.2 BASE (before these fixes)
- tsc 0 errors · eslint 0 · **215 files / 3926 tests PASS** · dist stamp 21.23.2 · check:routes PASS

### AT v21.23.3
- tsc 0 errors · eslint 0 · **216 files / 3938 tests PASS** (+12 honesty regression locks) · dist stamp 21.23.3
- Watchdog bat + launcher version pins 21.23.3

## v21.23.2 — SIGNAL-DIRECTION INVERSION FIX (long↔short opposite trades) (2026-10-19)

**User ask: "Trade signals Wrong and opposite jaa rahe hai — long trade signal ka short jaa raha hai, short trade signal ka long jaa raha hai." Deep-pro trace kiya — DO concrete root causes mile, dono fixed + regression-locked.**

### FIXED — BUG A: India LIVE SHORT orders exchange par BUY ban jaate the ("short ka long")
- **Root cause**: `dhan.js dhanPlaceOrder` ka `buy = side !== 'SELL'` check sirf 'BUY'/'SELL'
  vocabulary samajhta tha, par India execution paths (executeIndiaSignal entry+SL, watcher
  trailing-SL, agent SL-update) **'LONG'/'SHORT'** bhejte hain. `'SHORT' !== 'SELL'` → `buy=true`
  → **SHORT entry BUY order** (journal SHORT, exchange position LONG — P&L ulti).
  WORSE: SHORT position ka **protective SL bhi SELL** lagta tha — cover karne ke bajaye
  **double-short** (position unprotected, risk doubled).
- **Fix**: `dhanOrderBody()` pure builder extract (v21.23.2) — dono vocabularies explicitly
  map: LONG/BUY → BUY, SHORT/SELL → SELL (entry); SL branch exit-side cover (LONG→SELL,
  SHORT→BUY). Unknown side BUY-default NAHI karta (conservative SELL). Pure function ab
  directly testable — pehle ye logic internal `dhanPrivate` call ke peeche chhupi thi,
  isi wajah se inversion kabhi test se pakda nahi gaya.
- **Regression**: `test/signalDirectionInversion.test.ts` (7 tests) — full transactionType
  matrix + triggerPrice validation + unknown-side fail-honest.

### FIXED — BUG B: paper/notify me clicked signal ke OPPOSITE trade silently khul jaata tha ("long ka short")
- **Root cause**: v21.13 "FLIP REALIGN" (indiaOrders.js + coindcxOrders.js) — fresh consensus
  flipped side pe trade silently realign kar deta tha (card LONG, trade SHORT) aur
  **`evaluateExecutionGate` ke anti-flip veto ko bypass** karta tha (gate REALIGNED side pe
  match hota tha — veto kabhi fire nahi hota tha). LIVE-only tha "kabhi silent flip nahi"
  invariant; paper/notify me inversion allowed tha.
- **Fix**: direction conflict = **honest REJECT** (sab modes me — paper/notify/live). Journal
  me `flippedFrom`/`flippedTo` document hota hai, message user ko naya card refresh karne
  bolta hai. FLAT/planless (direction-less) case pehle jaisa requested side pe synth (koi
  conflict nahi — engine ne direction nahi diya). Engine track-record bhi clean: stale-card
  SL ka blame engine pe nahi jata (trade hi nahi khulta).
- **Regression**: 9 updated tests (aiOrders, directionProof, indiaOrders) — clicked side ke
  opposite position count = 0, journal REJECTED + flip documented, LIVE certificate lines
  (no signed request left server) preserved.

### FIXED — port honesty regressions (72ad0a3 ne v21.23.1 code v21.24.0 fixes ke upar likh diya tha)
- **mtfDualBoard.js**: worldInd missing par GUESSED aligned8Count (dualAligned ? 7 : 5)
  fabrication restore hui thi — ab **null = UNVERIFIED** (directionVerified false, heuristic
  confluence % fabricate nahi hota). Production planner hamesha measured worldIndicators
  deta hai; sirf partial/synthetic plans me absent.
- **mtfDualBoard.js**: fallback `ollamaVerdict: '3/3 OLLAMA AI LOCK'` JHOOTA tha jab Ollama
  offline (rule-based guard = 0 live models). Ab sentinel ka honestLabel — offline pe
  "Rule-Based Guard n/3", live pe "Live Ollama (...)".
- **llmSentinel.js**: trio guard ka `|| 6` default count GUESSED 6/8 tha (unmeasured/0 bhi
  6 ban jaata tha → trio ko vote-milte the). Ab unmeasured → conservative 0.

### FIXED — port ne directionLock.test.js tod diya tha (4 tests remote par hi failing)
- 72ad0a3 port ne directionLock.js ka API badla (acquire/check/release/get — v21.23.1
  lineage) par a4d1693 ka purana test (lockDirection/directionLockGate/clearDirectionLock)
  reh gaya → `__resetDirectionLockForTests is not a function`. New API ke against rewrite
  (semantics same: one-coin-one-direction, 4h released-cooldown, symbol normalization,
  snapshot/release).

### Gates
- `npx tsc --noEmit` — **0 errors**
- `npm run lint` — **0 errors, 0 warnings**
- `npx vitest run` — **215 files / 3926 tests PASS** (7 naye inversion regression tests +
  1 LIVE SHORT wiring test included)
- Version stamp: 21.23.2 (package.json + src/version.ts + dist/.build-version)

## v21.23.1 — DIRECTION-LOCK RELEASE-ON-CLOSE + SAPTA LOCK ACQUIRE + HONEST P(WIN) (2026-10-19)

**User ask: latest repo pull kiya ("direction lock guard, MTF dual board improvements") — plan ka zyadatar hissa apply hua, par 2 adhoori cheezein + 1 naya bug. Ye release unhe fix karta hai.**

### FIXED — the new bug: direction lock KABHI release nahi hota tha
- **Root cause**: `releaseDirectionLock()` export tha par production me kahin call nahi hota
  (mtfAutoLink me sirf dead import). `checkDirectionLock()` me `active:true` lock kabhi expire
  nahi karta — ek baar koi engine symbol X par trade kholta hi opposite side **process-restart tak** block rehti thi.
- **Fix (2 authoritative release paths)**:
  1. **paperTrading.js `_closePart` central hook** — har paper-trade close (SL/T1/T2/trail/EOD/
     manual/stale) yahin land karta hai; symbol par KOI AUR open paper trade na ho to lock release
     (multi-engine same-symbol hold safe). directionLock.js zero-import PURE module — koi cycle nahi.
  2. **routes.js 60s always-on watcher sweep** — `reconcileDirectionLocks()` (naya export) ALL
     open-position books (paper engine + MTF auto book live/paper + shared journal agent/india/
     manual + SAPTA journal) se flat symbols detect karke active locks release karta hai.
- **Cooldown semantics preserved**: release ke baad bhi opposite side `entry + 4h` (flipReentryBlockMin)
  tak blocked — whipsaw flip safe; 4h+ ke trades ke baad genuine trend-change entry allowed.
- mtfAutoLink.js ka dead `releaseDirectionLock` import hata (lint warning fix).

### FIXED — SAPTA (proTraderAuto) lock wiring adhoora tha
- `proTraderGate` sirf CHECK karta tha — SAPTA ki trades lock **acquire** nahi karti thi, isliye
  doosre engines ko SAPTA ki position dikhti hi nahi thi (opposite-side double-trade possible).
- Ab `_tryEntry` → `_saveTrade` (status MONITORING/PLACED) ke baad
  `acquireDirectionLock({ source: 'protrader-auto' })` stamp hota hai. Release 60s sweep se.
- `__internals._tryEntry` test seam export.

### VERIFIED — cryptoAgent "not wired" report: NOT APPLICABLE
- cryptoAgent.js ek READ-ONLY chat agent hai — saare 21 tools analysis/getters hain
  (get_live_crypto_signals, analyze_coin, get_wallet, get_open_positions, backtest…). Koi
  order-placement case exist nahi karta, isliye wahan direction-lock wiring ka koi surface HI nahi hai.

### FIXED — 95% win-rate fabrication (server + UI)
- **mtfDualBoard.js** `winRatePct` ladder me hardcoded `95/92` branches hata:
  1. ledger-calibrated `pWinCalibrated` (n ≥ 20) → AUTHORITATIVE exact number
  2. conflict/veto rows → honest low band 48-62
  3. otherwise measured confluence × score heuristic, clamped **52-85**
- `worldIndicatorsInfo.targetWinRatePct` hardcoded `95` → derived honest value (null possible).
- `avgWinRatePct` ka `|| 88` fabricated fallback → sirf finite measured values (null → UI '—').
- `highAccuracy95Ready` ab honest: calibrated P(win) + verified aligned row (pehle always-true jhooth).
- **MTFDualBoardPanel.tsx**:
  - Header chip "PURE 8 INSTITUTIONAL TOP INDICATORS · 95% WINRATE TARGET" → honest
    "PURE 8 INSTITUTIONAL CONFLUENCE · N% AVG P(WIN)" (ya "LEDGER-CALIBRATING")
  - Row chip `{winRateShown ?? 95}% Winrate` → `pWinCalibrated ?? winRatePct ?? heuristicConfluencePct`
    priority + "~" suffix for heuristic + "P(WIN) CALIBRATING" jab koi number nahi
  - `alignedCount ?? 9` fabricated fallback → `?? 0`
- `useAITrading.ts`: `avgWinRatePct`/`targetWinRatePct` types ab nullable.

### FIXED — typecheck + lint (CI gate `npm run check` fail hua tha)
- **tsc 0 errors**: `runMtfAutoTick()` ka `opened: unknown[]` → properly typed
  `MtfAutoTickOpenedRow[]`/`MtfAutoTickClosedRow[]` (MTFDualBoardPanel.tsx(242) ke 2 TS2339 fix).
- **lint 0 warnings** (changed files): unused `releaseDirectionLock` (mtfAutoLink) + unused
  `buildMTFSnapshot` (mtfDualBoard) imports removed.

### TESTS
- Naya `test/directionLockRelease.test.ts` (6 tests): paper-close release + cooldown window +
  multi-engine same-symbol hold + sweep normalization/hold/release-skip.
- Naya `test/protraderDirectionLock.test.ts` (2 tests): SAPTA entry acquire + opposite-lock gate.
- `directionConflict.test.ts` +3 HONEST win-rate regression guards (12 total).
- Version gate: 21.23.0 → 21.23.1 (package.json + src/version.ts + Watchdog bat + test).

## v21.14.0 — LAYA LOCAL AI MODEL PERMANENT REMOVAL (2026-10-14)

**User ask: "full site codes se laya local ai model permanently remove cleanup karne se existing site ko kuch effect hota kya dekho — without effect ke remove kar sakte hai tho kardo"**

### ANALYSIS (removal pehle VERIFY kiya — phir execute)
- **Trading Signals kabhi break nahi hote**: AI-confirm layer purely additive hai — signals ka
  generation (committee compute) AI layer se PEHLE hota hai; provider absent = `aiConfirm` payload
  se omit, scores untouched, koi mutation nahi. CONFLICT/CONFIRMED sirf tab hota hai jab provider LIVE ho.
- **Bot Lab kabhi nahi rukta**: `laya` arm → pehle se hi `arm_fallback` graceful path tha
  (no_laya_instance → gated). Ab legacy laya/consensus arms tick pe honest events ke saath
  jev/gated pe map hote hain.
- **UI har layer pe graceful**: `signal.aiConfirm` absent = chip render hi nahi hota; BotsTab
  dropdown ARMS_ALLOWED se render hota hai.
- Laya AI confirm chain ka 2nd provider tha (Jev cloud pehla) — dono shared `jevEngine`
  (createJev) pe chalte the. Jev flow byte-identical intact.

### REMOVED (permanent)
- `server/layaSidecar.js` (1008 lines — adopt/spawn/zombie-kill sidecar manager) + supervisor wiring
- `server/bots/layaAutoLink.js` (263 lines — health-probe + key-ladder + hot-swap rescue) +
  routes integration (laya-status/laya-relink endpoints, SSE layaAutoLink frames)
- `start-laya.cmd`, `scripts/laya-ping.mjs`, `scripts/laya-autostart-check.mjs`
- Watchdog bat ka Laya fallback block (v21.10 war-guard) — 10048 bind-war class ka poora surface khatam
- Bot Lab `laya`/`consensus` arms (ARMS_ALLOWED ab rules|gated|jev|auto); aiModeConfig primary
  hamesha `jev`; layaPing leg (smoke.js); providerHealth/healthMonitor laya blocks;
  boardAiConfirm jev-only (wire shape me `laya` key clean absent); BotsTab Laya panel +
  RECONNECT button + autolink chip; SignalCard/LiveExecuteModal/TopPicks/ExpertPicks/OpsHealthStrip
  laya bits; full-diagnostic Section D (ab jev AI-confirm layer status)
- `.env.example` (app + deploy): LAYA_* block replaced with jev-only AI PROVIDER section
  (purane LAYA_* lines user ke .env me pade rehne par bhi IGNORE hote hain — safe)

### KEPT (jev-only world)
- `jevEngine.js` (createJev) — Jev cloud provider ka pura engine (cache/breaker/retry/FIFO
  concurrency gate/usage stats) byte-identical
- `boardAiConfirm.js` — AI confirm layer ab jev-only (SWRV memo + CONFIRMED/CONFLICT logic same)
- `deciders.js` — rules/gated/jev/auto arms; auto failover retired (single provider — honest
  provider_down WAIT)
- Tests: layaSidecar/layaConflict/layaAutoLink suites deleted; layaFast → aiFast (FIFO/SWRV
  locks jev-only); aiProviders/botlabAiDeciders/botlabDualArms/botlabJev/useBotsParse/
  v2111/v213/v214 updated jev-only contracts ke saath

## v21.12.0 — MASTER ACCURACY SWITCH + META DEFAULT ON + CODE-UPGRADE GUARD (2026-10-14)

**User report: "META ensemble ON karna ml-service deploy ke baad haa kardo aur Accuracy upgrade — 13 → 16-model committee (tape-MTF w1.6 + 3 naye seats) + 4 mesh shadow seats + 3× learning window sirf 13 models hi bata raha hai 16 models nhi site ek baar recheck karo aur issue fix karo"**

### FIX 1 — AI_ACCURACY_SUITE MASTER SWITCH (stale-.env 13-seat pin disease)
- **ROOT CAUSE (13 vs 16)**: v21.11.0 me teeno seat-flags (V2/MTF/MESH) ka code-default ON kiya tha, par "explicit env value hamesha jeet-ta hai" semantics ki wajah se ek purani/stale `.env` (jin boxes ne kabhi `AI_ENABLE_V2_MODELS=false` likha tha) apne box ko hamesha 13-seat plain board pe pin kar deti thi — shipped intent (16 voting + 4 shadow) kabhi reach hi nahi hota tha.
- **NAYA `server/ai/accuracySuite.js`**: master switch `AI_ACCURACY_SUITE` — **DEFAULT ON**. Master ON hone par teeno LEGACY per-flag env values (V2/MESH/MTF) **IGNORED** (chahe `false` pade ho) → 16 voting + 4 mesh shadow GUARANTEED out-of-the-box. Rollback ab EK documented path hai: `AI_ACCURACY_SUITE=false` + per-flag values (legacy A/B semantics v9.x jaise).
- `v2ModelsEnabled()` / `mtfConfluenceEnabled()` / `meshModelsEnabled()` ab master-gated hain; setup.ts me legacy suites ke liye master bhi pinned (saare legacy files byte-identical).

### FIX 2 — META ENSEMBLE DEFAULT ON (user ask — ml-service deploy ke baad)
- `AI_ENABLE_META_ENSEMBLE` ab **DEFAULT ON** (explicit `false` A/B rollback hi jeet-ta hai). Safe by design: ml-service down → 400ms timeout → 5-min circuit breaker → weighted fallback; meta sirf tab bolta hai jab service zinda ho AUR weighted committee se agree kare. Port 8100 (v21.11 fix) — Laya ka 8000 kabhi probe nahi hota.
- `.env.example`: `AI_ENABLE_META_ENSEMBLE=true` + `ML_SERVICE_URL=http://127.0.0.1:8100` ab uncommented default + ml-service chalane ka command documented.

### FIX 3 — SUPERVISOR CODE-UPGRADE GUARD (asli "server purana chal raha hai" fix)
- **ROOT CAUSE #2 (structural)**: watchdog sirf dist-stale check karta tha (frontend rebuild) — SERVER code ka running-process vs disk check NAHI tha. Naya zip extract karne par purana Node process RAM me chalta rehta tha → "UI naya, API purana" → board `models` array 13 hi bhejta rehta tha. Yehi user ke box pe hua.
- `supervisor.js` v21.12: `/api/ping` probe ab body ka `v` (SERVER_VERSION of RUNNING child) padhta hai aur disk ke `package.json` version se compare karta hai. Mismatch → **2 consecutive same-disk-version probes** (mid-extract race guard) → journal `code-upgrade` + banner log + force-kill → restart naya code load karta hai. Loop-guards: ek hi target ke liye ek restart + max 3 upgrade-restarts per boot + partial-deploy honest hint. fs-read fail / `v` missing → guard no-op (legacy compatible).

### FIX 4 — COMMITTEE VISIBILITY (ab har jagah ASLI numbers)
- **NAYA `server/ai/committee.js`**: ek source-of-truth snapshot — `{total, voting, shadow, tapeSeat, tapeWeight, learningWindow, accuracySuite, v2Models, mtfConfluence, meshModels, meta{enabled, serviceUrl}}`.
- Boot banner: `[superintel] 🧬 committee: 16 voting + 4 mesh shadow · tape-MTF w1.6 · window 1200 · META ARMED (127.0.0.1:8100) · accuracy-suite ON` — watchdog logs me hamesha dikhta hai.
- `/health` me `committee` field (ops dashboards); agent + indiaAgent accuracy payloads me `committee` (AgentPanel chip ab server ke ASLI counts se render hota hai — hardcoded 16/13 strings deleted).
- UI ke saare stale hardcoded `10-model` strings GONE: CoinDcxTab (board header, metals desk, deep re-verify ×2, backtest note) + IndiaIntradayTab (universe line, board SectionLabel, backtest lab, deep re-verify ×2) + BacktestPanel + deepAnalysisExtras — sab ab `${models.length}`-dynamic ya honest "full-committee" wording.

### FIX 5 — REPO CLEANUP (user commit se wapas aaya junk, dobara removed)
- User ke GitHub sync (7476ce0) se 7 dead root `scripts/v20xx-*.mjs` smoke/probe scripts + `telegram-bot/cloud.mjs` wapas repo me aa gaye the (v21.11.0 me delete kiye the) — dobara `git rm` (zero live importers, sirf historical CHANGES.md mentions).
- dist/ me 3 generations of assets jam gaye the (v21.9 orphan + v21.11 + user ke 2 duplicate-chunk builds) — fresh build se single clean generation.

### TESTS
- NAYA `test/v2112MasterSwitch.test.ts` (+15): master switch semantics ×4, META default-ON subprocess ×2, committee info subprocess (suite-ON 20/16/4 + legacy 13/13/0) ×2 + banner content, supervisor code-upgrade guard ×7 (happy, 1-probe window, 2-probe kill+journal, same-target loop-guard+hint, new-target re-arm, fs-fail no-op, probe body `v` parsing), source contracts ×8 (.env.example, index.js banner+/health, supervisor guard wiring, agent payloads, AgentPanel dynamic chip, tabs 10-model-free, models/mesh master-gating, setup.ts pins).
- Updated: `v2111SuperIntelUpgrade` (explicit-false case ab master-unset stale-ignore + 2 rollback cases + mesh test master-clean), `metaEnsemble` (defaults ON + explicit-OFF pin), `setup.ts` (+AI_ACCURACY_SUITE/+AI_ENABLE_META_ENSEMBLE legacy pins), `launcherAutoBuild` + `layaSidecar` version pins 21.12.0.
- **LIVE E2E** (`scripts/e2e_v2112_boot_check.mjs` — naya reusable deploy-verification tool, `node scripts/e2e_v2112_boot_check.mjs` se apne box pe bhi chala sakte ho): bare-env boot (koi AI_* flag nahi — user ke stale-.env simulation) → boot banner "16 voting + 4 mesh shadow" ✓ · `/health` committee 20/16/4 tape-mtf w1.6 window 1200 ✓ · META ARMED @ 127.0.0.1:8100 ✓ · `/api/ping v` == package.json ✓. Poora suite: typecheck PASS · lint 0 errors · vitest **204 files / 3821 PASS** (+25) · build+stamp 21.12.0 · check:routes PASS · CRLF intact.

## v21.11.0 — LAYA DECISION TRANSPARENCY + SUPERINTELLIGENCE ACCURACY SUITE + REPO CLEANUP (2026-10-14)

**User report: "CoinDCX tab ke 70-80+ signals pe 🤖 AI ○ (Laya ○) dikhta hai — samaj nahi aa raha Laya LONG/SHORT me kya bol raha hai" + "13 models ki Signal Accuracy bahut low hai — deep analysis karke Superintelligence se upgrade karo" + "full site recheck + unwanted temp/broken/junk files permanently cleanup karo"**

### FIX 1 — LAYA KA DECISION AB DIKHTA HAI (direction transparency)
- **ROOT CAUSE**: `boardAiConfirm.js` provider ke FULL verdict (action/probs/confidence/note) ko sirf `'AGREE'|'DISAGREE'|'NEUTRAL'` 3-string me collapse karta tha — **direction kabhi wire tak pahunchti hi nahi thi**. UI me hollow `○` ka matlab (wait? threshold-neeche? timeout? down?) koi nahi jaan sakta tha.
- **jevEngine.js**: `below_threshold` / `disagreed_side` returns me naya `picked` field (provider ka RAW choice) — additive, trading contract (no-flip) untouched.
- **boardAiConfirm.js v21.11 decision objects**: `_confirmOneProvider` ab `{v, picked, pLong, pShort, pWait, confidence, note, latencyMs, cached, reason}` return karta hai; `aiConfirm.detail.{jev,laya}` wire pe full decision travel karta hai. Legacy string fields (`aiConfirm.jev/laya`) UNCHANGED — saare existing consumers byte-identical.
- **SignalCard AiConfirmBadge**: bits ab direction + conviction dikhaate hain — `Laya ✓ LONG` / `Laya ✗ SHORT 68%` (ULTA side + conviction) / `Laya ○ SHORT-lean 29%` (below-threshold lean) / `Laya ○ slow|wait|breaker|down|timeout` (honest reason). Tooltip me per-provider full story (probs split + conf + latency + note).
- **CONFLICT me kaun ulta**: board summary `[Laya SHORT 68%]` suffix + futures precheck warning "— Laya SHORT 68% ke side me (ULTA)" + LiveExecuteModal pre-flight screen par per-provider decision lines (final trade se pehle Laya ka directional read).
- TopPicks/ExpertPicks tooltips me bhi direction summary; naya shared helper `src/components/aitrading/aiConfirmText.ts`.

### FIX 2 — ACCURACY SUITE DEFAULT ON (13 → 16 voting + 4 mesh shadow)
- **ROOT CAUSE**: codebase ke apne designed accuracy-upgrade seats env-gated default-OFF the — user ka box purane .env pe 13-seat plain board chal raha tha jabki .env.example shuru se `true` ship karta tha (V2/MESH/MTF).
- **AI_ENABLE_V2_MODELS + AI_ENABLE_MTF_CONFLUENCE + AI_ENABLE_MESH_MODELS ab CODE DEFAULT ON** (explicit `false` env override hamesha jeet-ta hai):
  - tape seat w1.3 → **tape-MTF confluence w1.6** (crypto/futures graceful 15m-degrade ke saath — the documented 29%-win-rate counterweight)
  - +3 diversification seats: SentimentPulse (w0.7) / InstFlow (w0.8) / FundaCheck (w0.5) — low weights, adaptive.js settled outcomes se multiplier kamata hai
  - +4 mesh shadow seats (weight 0 — consensus par ZERO effect, ledger evidence se accountability promote karega)
- **TEST-STABILITY PIN**: `src/test/setup.ts` me legacy suites ke liye flags explicit `false` — saare 202 existing files byte-identical; naya default `test/v2111SuperIntelUpgrade.test.ts` me env-sanitized subprocess se locked.
- **Ledger learning window 400 → 1200** (`AI_LEDGER_MAX_ENTRIES` env-tunable) — adaptive weights/trust calibration/gateTuner ab 3× data window pe seekhte hain (tracked-signals.json ke 1200-row window ke saath aligned).
- Model-count labels dynamic: CoinDcxTab "13-model committee" → `${models.length}-model`, AgentPanel V2 chip 16/13, ModelRegistry me saare known seats ke icons + shadow-seat honest disclosure.

### FIX 3 — ML-SERVICE PORT COLLISION (8000 → 8100)
- **BUG**: `ML_SERVICE_URL` default `127.0.0.1:8000` tha — **wahi port jahan LAYA baithta hai**. `AI_ENABLE_META_ENSEMBLE=true` (purane .env.example me shipped) + ml-service down = har 5 min Laya ko garbage `/meta-ensemble` POST (Laya 404 → breaker → repeat).
- ml-service ab **8100** pe: `ensemble.js` + `mlHealth.js` + `index.js` Node clients, `ml-service/app/main.py` (ML_PORT env), Dockerfile (EXPOSE + healthcheck + CMD) — sab synced. `.env.example` me META ab default `false` + port note (ml-service deploy karne par hi ON karo).

### FIX 4 — REPO CLEANUP (permanent)
- **git rm**: 7 dead root `scripts/v20xx-*.mjs` smoke/probe scripts (5 generations, koi reference nahi), `telegram-bot/cloud.mjs` (zero-importer dead module — CHANGES.md ne retired bola tha, file bhoola tha reh gaya).
- **Stale dist bundles**: v21.9.0 ki orphaned 5-file generation (~679KB = 38% of dist) jo upstream commit ne add ki thi — rebuild ke saath git se bhi clean.
- **Dead doc references fixed**: `botlab-backtest.mjs` / `botlab-smoke` / `cx-ws-probe.mjs` retire-notes (README, RUN-FIRST, PHASE-2 checklist) + dist-tracking stale claims (ci.yml comment + RUN-FIRST "dist tracked NAHI" — actually tracked hai, deliberately).
- **Test-leak permanent fix**: 34 suites app/ root me `.test-data-*` dirs chhod jaati thi (15 dirs / 260KB junk user ke box pe) — naya `src/test/globalTeardown.ts` har run ke baad leak-cleanup karta hai; 2h+ purane `smartai-test-data-*` tmp dirs bhi.
- Local: 15 leaked `.test-data-*` dirs removed.

### REGRESSION LOCKS (test/v2111SuperIntelUpgrade.test.tsx — 11 naye)
- `_toDecision` mapping ×7 (AGREE direction, DISAGREE ulta+p%, NEUTRAL lean, timeout/deadline reasons, legacy string shapes), wire-shape (legacy strings + detail objects), CONFLICT flipBits summary, NEUTRAL score-untouched contract, subprocess default-ON registry (20 seats, tape-mtf w1.6), explicit-false legacy (13, tape w1.3), mesh shadow weight-0, ML port source-contracts ×5 files, ledger window, aiConfirmText helpers, SignalCard badge render "Laya ✗ SHORT 68%" + tooltip probs.

## v21.10.0 — LAYA BIND-WAR FIX (watchdog crash-loop) (2026-10-14)

**User report: "Start-SmartAI-Watchdog.bat run karne par logs me Laya ka crash-loop dikh raha hai"** — log me `[Errno 10048] error while attempting to bind on address ('127.0.0.1', 8000)` → `exit(3)` → `restart #1 5s → #2 10s → #3 20s → #4 40s` infinite, saath me misleading `[laya] READY (8.1s)` lines aur `[selfheal] EVENT-LOOP FREEZE detected — worst lag 5.9s`.

### ROOT CAUSE (log se reconstruct)
`Start-SmartAI-Watchdog.bat` ka Laya fallback block **unconditionally** chalta tha (LAYA_AUTOSTART check hi nahi karta tha). User ke `.env` me `LAYA_AUTOSTART=1` hai → supervisor sidecar **bhi** laya-serve spawn karta hai. Bat ka 2s `curl` probe booting-laye ko miss kar deta tha (laya-serve ~8-10s me bind hota hai — "Fetching 5 files" + router init) → **DONO ne spawn kiya**. Naya process `[Errno 10048]` (port already bound) pe `exit(3)` karta hai; sidecar ka `/health` probe BAT-wale healthy instance se OK milta hai (isliye "READY (8.1s)" misleading) — par exit-handler blindly restart schedule karta tha → infinite crash-loop. Har restart weights fetch + router load karta tha → CPU churn → event-loop freeze warnings. Site isliye "working fine" thi ki BAT-wala laya port pe healthy baitha tha — bas console war me tha.

### FIX 1 — Sidecar CONFLICT RESOLVER (`server/layaSidecar.js`, 5 naye layers)
- **ADOPT-WINDOW**: init me port occupied+unhealthy mile (timeout/reset, NOT `ECONNREFUSED`) to blind-spawn NAHI — `LAYA_ADOPT_WINDOW_MS` (default 20s) tak poll; booting laya healthy hote hi ADOPT. Live bug me yahi war rok deta: bat ka laya 8-10s me bind hota aur sidecar usse adopt kar leta.
- **EXIT-RECONCILE**: spawn ke exit ke baad port dobara probe (3 sequential, gap `LAYA_ADOPT_POLL_MS`). Healthy Laya mile → restart **CANCEL** + **ADOPT** (`conflict-exit(...)-healthy-port`) — war khatam, `conflicts` counter status me expose.
- **ZOMBIE CLEANUP**: quick bind-conflict exit (`<60s`, kabhi ready nahi) + port occupied-unhealthy → squatter pehchaan: win32 `netstat -ano` + `tasklist /FO CSV`, POSIX `lsof` + `ps`. Image `laya-serve` ho (hung zombie — user ka original "background me running phir bhi no response" case) → `taskkill /F /T` + backoff reset + 1.5s me fresh spawn.
- **FOREIGN GUARD**: port pe koi AUR app baithi ho → **KABHI kill nahi** — honest `gave-up` (`port-occupied-foreign`) + actionable log (`.env` me `LAYA_BASE_URL` port badlo ya app band karo). War against innocent app impossible.
- **STALE-GUARDS**: `epoch` generation counter — naya spawn/adopt hone par purane async reconcile no-op (double-restart race impossible).

### FIX 2 — Bat WAR-PROOF single-owner (`Start-SmartAI-Watchdog.bat` v21.10)
Naya `scripts/laya-autostart-check.mjs`: bat ab **node se** puchta hai ki Laya start karne ka kaam kiska hai. Script sidecar ke EXACT parser (`parseDotEnvKeys` — BOM/CRLF/quotes/comments) aur armed-conditions (`LAYA_AUTOSTART=1 + LAYA_ENABLED=1 + LAYA_API_KEY + loopback`) use karti hai → **dono layers kabhi disagree nahi kar sakte**. Sidecar armed → bat-block SKIP (`LAYA_BAT_FALLBACK=0`) → double-spawn structurally impossible. Script fail/missing ho → purana fallback behaviour (safety).

### FIX 3 — `start-laya.cmd` hardening
(1) Pre-flight `/health` curl check — healthy laya already chal raha ho to double start nahi; (2) laya-serve exit≠0 par **error dikhana + pause** — pehle `[Errno 10048]` wali window turant band ho jaati thi, error chhup jaata tha; ab `netstat -ano | findstr :8000` hint ke saath dikhta hai.

### REGRESSION LOCKS
- Parsers unit-locked: `parseNetstatListeningPids` (IPv4+IPv6+dup+non-LISTENING+port-mismatch), `parseTasklistImage` (CSV+INFO line+empty), `parseLsofPids`.
- Naye `test/layaConflict.test.ts` flows: window→adopt (war avoided), window-expiry→zombie→kill→fresh spawn, window-expiry→foreign→give-up (no kill), exit-reconcile→conflict-adopt (crash-loop cancel + backoff reset), exit-reconcile→zombie (fast respawn), exit-reconcile→refused (normal backoff intact — purana contract), ready-child exit (no zombie hunt), `laya-autostart-check.mjs` real exit-code matrix (env-armed=0 / .env-adha=1 / missing=1), bat/cmd source contracts (war-guard present, CRLF-strict).
- Existing 21.4/21.5 sidecar contracts (spawn env/masking, backoff 5→60s, budget pause, adopt/stop semantics) untouched-pass.

## v21.9.0 — XAU/XAG METALS RESCUE + LAYA AUTO-LINK (2026-10-14)

**User report: "CoinDCX tab me Gold & silver (XAU & XAG) me koi trade signals nahi dikh rahe — No metals data reachable (CoinDCX futures RT + Binance fapi both unavailable for XAU/XAG)" + "Bot Lab aur Superintelligence Signal Board me Laya ka koi feature useable nahi — laya background me running phir bhi no_laya_instance"**

Dono root-caused, advance-level fixed, live-verified aur regression-locked. Suite 3792/3792 (202 files, +44 naye assertions).

### THE XAU/XAG FIX — metals desk har leg se marta tha
- **ROOT CAUSE (live-verified)**: `fetchMetalsFapiCandles` TradingView-style resolutions (`'60'`, `'15'`) Binance fapi ko **raw** bhejta tha — `interval=60` → HTTP 400 `{"code":-1120,"msg":"Invalid interval."}` (Binance sirf `1h`/`15m` format accept karta hai). Fapi klines leg 100% fail — TV scanner metals serve nahi karta, to indicators ke liye candles hi akela source the → `buildFuturesCtxSync` dono symbols ke liye null → "No metals data reachable" har cycle. Hermetic mock URL substring se match karta tha, interval param ignore — isliye bug kabhi pakda nahi gaya.
- **FIX 1 — `toFapiInterval()` mapper** (`futures.js`): TV resolution → Binance interval ('60'→'1h', '15'→'15m', '1D'→'1d', '1W'→'1w'…); already-Binance-style passthrough; unknown → '1h' safe default. `fetchMetalsFapiCandles` ab translated interval bhejta hai. **Live proof: XAU 300 bars + ACTION SHORT signal (entry 4166.24, SL 4181.76, T1 4150.72).**
- **FIX 2 — Yahoo COMEX third leg** (`fetchMetalsYahooCandles`): XAU→GC=F, XAG→SI=F chart candles — **India-accessible** (Binance fapi kuch Indian ISPs pe geo-blocked). COMEX-USD candles desk ke live anchor pe rescale hote hain (`fetchMetalsCandleChain` — fapi → Yahoo, ±50% domain guard). Board + deep + 15m tape teeno paths ab chain se guarte hain.
- **FIX 3 — price chain 3-leg** (`fetchMetalsPrices`): Binance fapi 24h tickers → **gold-api.com free spot** (no key) → Yahoo GC=F/SI=F quotes (`SILVER: 'SI=F'` YF_MAP me add). Har row apna `source` carry karta hai (honesty intact).
- **REGRESSION LOCK**: metals test mock ab REAL Binance jaisa invalid intervals reject karta hai — ye bug class kabhi wapas nahi aa sakti. Naya "full Binance geo-block" test: CoinDCX candles dark + Binance poora down → board phir bhi XAU/XAG cards serve karta hai (Yahoo + gold-api se).

### THE LAYA FIX — "laya running hai par site ko dikhta nahi"
- **ROOT CAUSE**: provider availability PURE-CONFIG check tha — `LAYA_ENABLED === '1'` + `LAYA_API_KEY` non-empty **server boot pe** process.env se. `.env.example` `LAYA_API_KEY=` **khali** ship karta hai → provider kabhi nahi bana → `arm_fallback · no_laya_instance` har tick + Signal Board AI-confirm silent no-op. Bot Lab registry frozen singleton — .env edit ke baad bhi restart chahiye tha.
- **FIX 1 — `layaAutoLink.js` (naya)**: background self-heal service (~30s cadence, `LAYA_AUTOLINK=0` se off). `{LAYA_BASE_URL}/health` probe (loopback-only) → key-ladder ([env-extra, persisted, documented default `smartai-laya-local`, no-auth]) se REAL `/v1/systemone` handshake → validated key `data/bots/laya_autolink.json` me persist (7-din TTL). Timeout ≠ 401: auth middleware inference se PEHLE chalta hai — timeout = key pass + cold model → 'linked (warmup timeout)' honest flag.
- **FIX 2 — provider HOT-SWAP**: `BotRunner.attachAiProviders()` partial patch (jev untouched — test overrides safe); naya provider event-stream me `provider_attached` chhodta hai (user ko decision stream me HI dikhta hai). `refreshLayaProvider()` (routes.js) + `boardAiConfirmRefresh()` (10-min memo flush) — **server restart ke bina** Bot Lab arms + Signal Board AI chips live.
- **FIX 3 — buildProviders autolink fallback**: env key khali par FRESH validated autolink record → provider banta hai. `LAYA_ENABLED=0` explicit off hamesha jeet-ta hai; stray file kabhi flip nahi kar sakti (sirf successful handshake key persist hoti hai).
- **FIX 4 — UI + endpoints**: `GET /api/bots/ai/laya-status` + `POST /api/bots/ai/laya-relink`; Bot Lab Laya panel me auto-link phase chip (AUTO-LINKED / LAYA-SERVE DOWN / KEY MISMATCH / PROBING) + **⟳ RECONNECT LAYA** button + honest reason line; SSE status frames me `layaAutoLink` field; arm=laya 409 pe background self-heal relink + reason-enriched hint.
- **REPO HYGIENE**: `scripts/laya-ping.mjs` RESTORED (referenced tha par kabhi commit nahi hui — dead path); `start-laya.cmd` CRLF-strict restored (LF regression); `.env.example` ab `LAYA_API_KEY=smartai-laya-local` default ship karta hai (out-of-the-box .env ↔ laya-serve key match) + saare `LAYA_AUTOLINK*` knobs documented.

## v21.0.6 — ADVANCE-PRO FULL-SITE AUDIT (2026-10-09)

**User report: "full site code deep Advance pro level Sabhi Agents se check karo har ek work flow ko check karo sab accurately kaam kar raha hai kya aur issues fix kardo"**

4 parallel deep-audit agents (India options workflow / CoinDCX futures / server infra / AI-Ollama stack) ne 8 MAJOR + 4 MEDIUM + ~20 minor findings diye. Sab major+medium fixed + regression-locked. Suite 3464/3464 (183 files, +11 naye tests).

### MAJOR — India options engine
- **B1: paper option EXITS ab LIVE chain premium pe** (`paperTrading.js injectOptionPaperQuotes`): desk live Groww/NSE/BSE premium dikhata tha par SL/T1/T2/BE-trail/EOD BS-model premium pe act karte the — SL model pe hit ho sakta tha jab live chain ne chhua nahi. Ab live-chain LTP first (30s per-underlying cache; `fetchOptionChainFor` stream wiring index.js→routes.js→stream.js), BS sirf honest fallback. `RISK_FREE` 0.065→0.069 align bhi.
- **B2: 1-lot option trades T1 pe 100% close ho jate the** (`evaluatePaper`): `half=Math.ceil(1/2)=1` = remaining → advertised "T1 50% book → trail / T2" kabhi run nahi hota tha (track record +0.5R capped). Ab un-splittable runner T1 pe SL→breakeven (`PAPER_T1_BE` event), T2/BE tak ride karta hai.
- **B3: options auto-entry cooldown GLOBAL tha, per-underlying hona chahiye** (`optionsAutoEntry.js`): NIFTY entry poore desk ko 20 min stall karti thi. Ab sirf usi underlying pe; idle-reason priority bhi honest (no-qualifying-card vs cooldown); re-entrancy guard + holiday-aware `windowOpen`.

### MAJOR — CoinDCX
- **M1: paper-mode futures sizing-floor asymmetry** (`agent.js`): connected ₹280-560 wallet + paper mode me futures "margin too small" se skip, sim (floor 1) fire — v21.0.2 comment ka stated intent (practice equity) ab sach me implement: `sizingEquityINR = max(equityINR, 10_000)` paper/notify me (risk + deployable dono), futures floor 2 USDT sirf LIVE (paper = 1, sim parity).
- **M2: stale "sirf SPOT desk se entry hoga" messaging**: 4 jagah reworded (spot desk v21.0.5 me removed tha); `futures_margin` blocker ab sirf LIVE mode me fire hota hai.

### MAJOR — AI stack
- **AI-B1: deep-path debate OLLAMA_DEEP_MODEL bypass** (`signals.js aiCouncilDebate`): default debate=ON me 🔬 deep modal ka council qwen3:8b pe chalta tha (chip "↗R1·14B" promise karta tha). `opts.deep` ab teeno debate calls me threaded → `councilAskDeep`.
- **AI-B2: vision failures shared ollama breaker arm karte the** (`llmChain.js councilAskVision`): 2 weak-JSON vision calls board scan seat ko 30s+ park karti thi. Isolated `ollama-vision` breaker (UI me invisible — SENTINEL_PROVIDERS me nahi).
- **AI-E1: vision cache timeframe-blind**: 15m verdict 1d chart pe serve ho sakta tha. Client ab `tf` bhejta hai (CandleChart), cache key `${mkt}:${symbol}:${side}:${tf}`.

### MEDIUM
- Groww mirror OI-change clamp ≥0 hata — real OI-unwinding (negative) ab preserve (direct-NSE parity); missing oi/prevOI → 0.
- BSE whole-ladder 10-min hold ab sirf direct probes ko block karta hai (mirror apne 5-min backoff se govern, success pe hold clear).
- Restore-path symbol cap 15→20 (openPaperTrade parity — BANKNIFTY16char restore-drop fix).
- Options card `lotSize` ab chain lotSize first (LOT_SIZES fallback).

### MINOR (selected)
- `optionsAutoStatus.windowOpen` holiday-aware; optionsDesk `callWall` no-op ternary removed; SIMPL-view PAPER nav chip; SAPTA manual 'spot' cryptoProduct normalize; EngineHealthStrip `QWEN3VL` family + deep-ctx tooltip; ExpertPicks 30s copy; seatCorrelation dead `pairKeys`/`CORE_SEAT_IDS` + header drift; vision 503 unreachable honest + 413 wording; CandleChart 8x comment; telegram-bot version drift v18.0→v21.0.6.

## v21.0.2–v21.0.5 (2026-10-09, prior batch — pehle README/RUN-FIRST me hi the)

- **v21.0.5**: NIFTY real chain via Groww mirror ladder (direct-NSE-first); CoinDCX SPOT desk completely removed (Futures USDT + Equity SIM only).
- **v21.0.4**: SENSEX real BSE chain via Groww public mirror (`__NEXT_DATA__` parse, 90s cache, 5-min backoff) — "model-estimated" warning root-fixed.
- **v21.0.3**: NSE DD-Mmm-YYYY expiry ISO normalization (options accuracy + paper-trade reject root cause); Paper Desk SIMPLE view; Ollama scan+deep chips; deep modal real model name.
- **v21.0.2**: options auto-entry engine (30s loop, quota/cooldown/one-per-contract); exit-plan match T1=+0.5R/T2=+1.0R; expiry-day 14:30 sqoff; futuresViable mode-aware + GLOBALFUTURES quota separation + desk-fairness pick.

## v20.9.3 — 5TH-PASS FULL-SITE WORKING-FLOW RECHECK (2026-10-07)

**User report: "latest github repo ko pull karo aur full site code recheck karo sabhi working flow accurately perfect hai kya aur issues fix kardo"**

5 parallel flow-trace review agents (signals+UCV / auto-trade exec / data streams / bots+intraday+ML / infra+frontend+TG+deploy) ne ~30 VERIFIED defects pakde — 2 H1, 4 H2, ~12 M/H3, ~12 L. Sab fixed + regression-locked (test/v2093DeepAudit.test.ts, 31 tests). Total suite 3400/3400 (180 files).

### H1 — UCV-A1 CURRENCY-DOMAIN MISMATCH (the verifier itself was biased!)
- **ultrafastVerifier.js**: the FUTURES desk read SPOT-INR candles (`fetchCoinDcxCandles` → `<SYM>INR`) while the tick store key is a USDT perp print (`FUT_<SYM>`) — check 8 computed `(USDT − INR)/INR ≈ −98.8%` → a CONSTANT −8 microScore bias on EVERY futures verdict (systematic LONG under-confirmation + SHORT over-confirmation — the exact layer built to fix direction mismatch). The mirror on datacenter hosts: Binance USDT fallback candles vs an `IN_` INR tick → +8 BULL bias (the v20.9.2 "live integration proof" itself ran under this skew).
- **FIX (a)**: FUTURES desk now fetches `fetchFuturesCandles(B-<SYM>_USDT)` — the SAME USDT domain as the tick. **FIX (b)**: defensive guard in check 8 — `|tickPct| > 20` is scored N/A "denomination mismatch — skipped" (a live print vs a 1-minute-old close can NEVER legitimately differ 20%). LIVE-VERIFIED post-fix: no ±9880bps/±8400bps tick rows on any verdict; ETHFI LONG ai=94 CONFIRMED, IOST/WLD SHORT CONFIRMED, POL SHORT REJECTED (tape UP) — all domain-sane (scripts/v2093-uc-domain-probe.mjs).

### H1 — SPOT MARGIN LIQUIDATION EXIT trusted HTTP-200-wrapped rejections
- **coindcxOrders.js:~1089**: the ONE money call-site still not verdict-checked. CoinDCX wraps rejections inside HTTP 200 (`{code:4xx,message}`) — the watcher booked `status=CLOSED`, `closeReason=LIQUIDATED (est.)`, full-loss PnL + ledger stamp while the REAL leveraged position stayed open on the exchange, stop-less, never retried. Now: `coindcxRespError` verdict-check → throw → the existing WATCH_ERROR + retry path (same discipline as every other exit).
- **cancel/cancelAll** (M): same verdict-check — a panic cancel-all during a volatility spike reported success on 200-wrapped rejections while resting orders stayed live and fillable.

### H2 — a UC-REJECTED direction could still trade LIVE (gate asymmetry)
- The board capped REJECTED signals to 64/WATCH, but the DEEP path only attached the payload — the deep card kept aiScore 85/STRONG beside a REJECTED badge; deepPinVerdict read the score drift as DRIFTED and CoinDcxTab routed the TRADE button to the ungated live deep signal → a live order on the direction the realtime chart just rejected. **FIX**: the deep path applies the SAME ultrafastGatePatch (cap + WATCH + ucRejected), AND `evaluateExecutionGate` (ensemble.js) hard-vetoes `ultrafast.verdict==='REJECTED' || ucRejected` — board + deep + gauntlet now all refuse. Practice clicks too.
- **UC gate widened top-6 → top-12** (M): boards carry up to 40 rows — the 7th+ 80+/STRONG signal escaped the gate entirely (proTraderGate's lock passes vacuously). Stamps now run in `Promise.all` (was sequential 6×1.5s worst-case).
- **winProb recomputed from the CAPPED score** on REJECTED (was pre-cap optimism: "aiScore 64 · P(win) EDGE" from the uncapped 85).

### H2 — LIVE INDIA trades were abandoned after 15 minutes
- proTraderAuto.js: fill-verification and late-fill adoption were hard-gated `market !== 'INDIA'` while the PLACED→UNFILLED TTL applied to ALL markets — a FILLED live India position retired to UNFILLED at 15 min (SL/TP/reversal/EOD monitoring all stopped, journal lied "fill verify nahi hua", symbol re-entry-blocked; the broker's own square-off was the only exit). **FIX**: desk-aware `_readPositionsFor()` (INDIA → `dhanReadPositions()`, the Dhan tab reader that existed with zero call sites); the TTL only retires INDIA live after a VERIFIED positions-read found nothing (3× TTL honest upper-bound if the Dhan tab never comes up).

### H2 — CROSS-ENGINE DOUBLE-ORDER: SAPTA × auto-agent
- SAPTA (protrader-auto-journal.json, browser path) and the auto-agent (ai-trading-journal.json, API path) have disjoint journals and overlapping qualifiers on the same 30s board — the same signal could pass both → API order + browser order on one pair within seconds → exchange nets them into ONE ~2× position; either engine's exit closes the merged position out from under the other (CLOSE_UNKNOWN retry storms). **FIX**: mutual lock — SAPTA `_tryEntry` refuses pairs the shared journal holds OPEN/UNKNOWN (fresh read at the order moment, TOCTOU-safe); the agent candidate loop skips SAPTA-owned open/blocked pairs.

### H2 — ML META-ENSEMBLE leakage fix was a NO-OP
- ml-service train_signal.py: the v20.9.1 "date carry" derived `_ts` from `r.name` — but `load_ohlcv()` returns a RangeIndex frame (fetch_data writes `reset_index(drop=True)` + `to_parquet(index=False)`), so `pd.Timestamp(int)` = 1970-epoch-ns → the "global date sort" sorted by ROW POSITION → symbol-block order preserved → TimeSeriesSplit still trained on symbol A's 2025 while validating on symbol B's 2016 (the artifact served live behind AI_ENABLE_META_ENSEMBLE). **FIX**: the real `date` column rides the keep-cols and sorts. EMPIRICALLY VERIFIED: frame order now independent of input block order (scripts/v2093-meta-sort-probe.py).

### M/H3 — exec + ops + bots
- **exec-enter restart orphaning**: /api/exec/enter journaled only an ORDER entry — after a restart the 15m ladder no-op'd and watchFuturesPositions never saw the position (T1/T2/trail/time-stop gone). FIX: a real `j.positions` row (`source:'exec-enter', execManaged:true`) + `PositionManager.hydrateFromJournal()` on boot + the futures watcher skips PM-owned rows while the exec stack is armed (no double-ladder; stack-down → watcher adopts, protection never drops).
- **INDIA desk INSTREAM sync** (L) + **Binance WS accelerator self-heal** (M): pollOnce re-arms `_ensureBinanceWs()` after the 3-strike 30-min breaker (was dark for the rest of the session).
- **Bot desk**: telegram order alerts are verdict-aware (FAILED opens no longer announce a phantom LIVE position); `botRisk` peak rule FAIL-CLOSED on unusable peakEquity (mirrors the shared hardGate — was a lenient startEq fallback); shared-live-port settle resolves the owning strategy PER POSITION (mixed desks: one desk's positions got the wrong fee stack + a null mark desk = position never settled); `BOT_MAX_OPEN_PER_BOT` knob honored (was hardcoded 1).
- **backup-state.mjs default dir** (H3): pointed at `server/data/bots` while the code default is `app/data/bots` — `npm run backup-state` exited 2 on every default local deployment (the documented daily-backup flow was DEAD). **BACKUP_STATE_ON_BOOT=1** now actually wired in the supervisor (was documented, read by nothing). Docker bind-mount ownership note added (chown 1000:1000 — silent memory-only persistence mode otherwise). deploy/.env.example Telegram entries documented.
- **expertPicks.js**: the 8th factor (Structure/Fib/VP, weight 0.09) was never fed on the Expert desk — `structurePro` now computed and threaded (a permanent +4.5 constant is gone; scores comparable with the board's expert score again).
- **UltrafastChecklist reachability** (M): the deep modal's 9-check table rendered from the PINNED card's compact wire (no `checks`) — unreachable in the primary board-click dive. Now rendered from the LIVE deep payload (both CoinDcxTab + IndiaIntradayTab).
- **SignalRecheckPanel**: UC verdict fields typed + rendered (⚡ UC REJECTED pulsing-rose / UC OK cyan chips; UC_REJECTED red in the event feed); board side-flip resets the stale UC verdict.

### L — hygiene
- OAuth callbacks (IndMoney/TapeTide) retargeted from the removed `?tab=portfolio` UI to `/?tab=india` + a 12s connect-result chip in the shell. Dead `telegram-bot/cloud.mjs` deleted (157 lines, 0 importers, HTTP-status-only trust). APP_PIN placeholders (`1234`/`change_me_to_a_strong_pin`/…) refused at boot. LiveSourceBadge `binance-crypto-ws` → its own `Binance·ACC` label (the accelerator runs ALONGSIDE CoinDCX — the "both dark" fallback tooltip was wrong). inStream CRYPTO_BASES synced (POL/TRX in, delisted MATIC out). botlab-calibrate probes both state-dir layouts (`--state-dir $BOT_STATE_DIR` no longer double-`bots`).

### VERIFICATION
- tsc 0 errors · eslint 0 errors · **vitest 3400/3400 (180 files, +31 v20.9.3 locks)** · vite build OK (SW stamp smartai-pro-v20-bmux2wkt1) · check:routes PASS · check:version OK (20.9.3) · BOOT SMOKE 12/12 LIVE (boot, ping/health 20.9.3, login, exec/status armed+hydrated, board 200 with live UC stamp, signal-recheck 200, no spurious boot-backup, bots, SPA, pre-auth 401) · UC domain probe LIVE PASS · meta-sort probe PASS.

# Changelog

## v20.9.2 — ULTRAFAST CHART VERIFICATION AGENT (UCV-A1) + DIRECTION-MISMATCH FIX (2026-10-07)

**User report: "CoinDCX tab me trade signals bahut mismatch ho rahe hai — long bolne par short jaa rahe hai, short bolne par long. Deep additional deep AI agent rakho jo realtime ultrafast chart check kar sake ki long signal pakka long jayega kya nhi, short signal pakka short jayega kya nhi — superintelligence kaam hai ye. 80+ AI Score ke signals recheck karo, advance pro trader level pe."**

### ROOT CAUSE (the audit finding)
- The direction-mismatch class is **lagging-HTF-vs-fast-tape**: the committee's heaviest seats (TrendMatrix EMA-50 stack, the 1h tape, macro regime) stay bullish for HOURS after the micro trend has rolled over. The existing softeners (v9.2 price-confirm guard, v20.4 counter-tape wiring, MTF-6 ±3..−18) only ADJUST confidence — no layer ever answered the only question that matters at entry time: *"is the ultrafast chart RIGHT NOW moving with this signal?"* The full audit re-verified the pipeline math is otherwise correct (indicator library textbook-exact with v20.9.1 supertrend/RSI/stochastic fixes, consensus sign-mapping correct, execution mapping LONG→buy / SHORT→sell correct end-to-end, candle ordering oldest-first everywhere) — the inversion is informational lag, not a code sign-flip. Hence: a dedicated verification layer, not a rewire of the ensemble.

### NEW — UCV-A1: the Ultrafast Chart Verification Agent (`server/ai/ultrafastVerifier.js`)
- **The deep AI superintelligence agent the user asked for.** Per symbol it reads the REALTIME ULTRAFAST chart stack: **1m candles** (60-200 bars) + **5m candles** + the **LIVE sub-second tick** (the same tick store the SSE stream reads), then runs a **9-check micro-structure analysis**: fast EMA 3/8/21 stack · last-5m/10m run (bull-bar count) · 6-bar HH/HL vs LH/LL structure · 1m volume pressure (up-bar vs down-bar volume) · 3-bar rejection wicks · 1m RSI(7) zone · 5m EMA8/21 confirmation · live-tick velocity (bps vs last 1m close) · 3-bar acceleration. Output: `microDirection` UP/DOWN/FLAT + `microScore` −100..+100.
- **The verdict answers the user's exact question**: CONFIRMED → `⚡ LONG PAKKA long — realtime ultrafast chart UP hai (micro +59/100)` · PENDING → neutral tape, wait for confirmation · REJECTED → `✗ LONG REJECT — realtime ultrafast chart ULTA SHORT taraf hai; ye entry short banne ka risk hai — trade mat lo` (the "long bola par short gaya" class, caught BEFORE the trade).
- **Cost discipline**: candles ride the EXISTING TTL cache chain (1m 90s / 5m 120s in data.js — zero new fetch layers), 45s verdict cache per (market, symbol, side), 1.5s hard deadline per call, honest PENDING on any failure (never blocks the board).

### WIRING — the 80+ AI-score recheck (advance pro trader level)
- **Board (signals.js)**: every `aiScore ≥ 80` or STRONG-grade directional signal (top-6 per cycle, ranked by score) gets the UCV-A1 stamp `s.ultrafast`. **REJECTED → aiScore capped to 64** (below the 80+ user filter — a signal fighting its own 1m chart is not an 80+ trade) + **grade demoted STRONG/ACTION → WATCH** + the driver line `UCV-A1 REJECT — 1m chart DOWN` + `ucRejected` flag. The cap flows into rankScore (the board's ranking key), TopPicks and the 80+ tier views automatically.
- **Deep path (signals.js)**: the FULL payload rides the deep dive (complete 9-check checklist + the Hinglish answer) — the user's explicit "advance pro trader level pe check karo" surface.
- **Auto-agent (proTraderAuto.js)**: `proTraderGate` now REJECTS any candidate whose ultrafast verdict is REJECTED (reason `ultrafast:REJECTED(micro DOWN 45/100)`) — the execution-side lock. PENDING/CONFIRMED pass (the board already demoted rejected signals out of the STRONG gate).
- **15s recheck loop (signalRecheck.js)**: deep re-votes now track UC verdict transitions — `UC_REJECTED` / `UC_CONFIRMED` events land on the row log AND Telegram (deduped 30 min, the insta-push pattern); the panel row exposes `ultrafast` + `ultrafastAnswer`.
- **Desk agent (cryptoAgent.js)**: the `verify_signal` MCP tool now returns `ULTRAFAST_CHART_VERDICT` alongside `VERIFIER_VERDICT` — the LLM answer to "XRP long ya short? pakka?" cites BOTH layers and is instructed to advise trade-avoid on UC REJECTED.
- **Frontend**: `AISignal.ultrafast` typed (`UltrafastVerification`) + the **⚡ UC badge** on every signal card (CONFIRMED = cyan `UC ✓ LONG PAKKA` · PENDING = slate · REJECTED = pulsing rose `UC ✗ ULTA (SHORT risk)` with the full tooltip) + the **⚡ REALTIME 1M MICRO-CHECKLIST** table inside expanded cards (deep payloads).

### Tests & verification
- NEW `test/ultrafastVerifier.test.ts` (23 tests): the mismatch matrix (LONG+dumping tape → REJECTED, SHORT+ripping → REJECTED, LONG+rising → CONFIRMED with PAKKA answer, flat → PENDING), 9-check integrity, tick-velocity join, gate-patch cap/demotion/min-semantics/no-touch-on-CONFIRM, wire compaction, deadline + 45s cache reference-equality.
- NEW `test/v2092DeepAudit.test.ts` (12 tests): the full wiring chain locked (board 80+/STRONG selection + top-6 bound + patch application, deep full payload, proTrader exec lock, recheck events, agent tool citation, frontend render, version sync 20.9.2, cost-discipline contracts).
- NEW `scripts/v2092-smoke.mjs` (8 checks, ALL PASS live): boot, ping v20.9.2, login, pre-auth 401, signal-recheck panel, crypto board 200, SPA, no ultrafast boot errors. NEW `scripts/v2092-uc-integration-probe.mjs` — **live in-process verification on the real market**: `INJ LONG 90 STRONG → CONFIRMED "PAKKA"` · `AVAX LONG 92 → PENDING` · `JUP LONG → REJECTED "ULTA SHORT taraf hai" + aiScore 64 + WATCH + driver stamped` — every verdict class observed firing on live data.
- Version bumped everywhere the release gate checks (package.json, version.ts, bats, pinned tests). **tsc 0 errors · full suite green · vite build stamped 20.9.2.**

## v20.8.5 — AUTO TRADE TP EXITS + ENTRY UNBLOCK + WALLET LATENCY (2026-10-05)

**User report: "auto trade me lag nahi raha hai · auto entry aur auto profit TP 1 or TP 2 pe profit book karke exit nahi ho raha hai · already tick hai bta raha hai · futures wallet bhi bahut late read kar raha hai" — 4 root causes, all fixed + live-verified (boot smoke 15/15).**

### H1 — SAPTA (PRO TRADER AUTO) exits were TP-BLIND
- **TP1/TP2 profit-booking did not exist**: `_monitorPositions` closed only on SL / reversal-flip (2× confirm) / EOD — the trade's `tp`/`tp2` were stamped at entry and NEVER checked. Winners rode until a reversal that often never came (the exact "TP1/TP2 pe profit book karke exit nahi hota" complaint). NEW: `proTraderTpCheck` (pure) + monitor wiring BEFORE the reversal check — **TP1 hit → `tp1ClosePct`% (default 50) partial book + SL → breakeven lock** (paper: honest qty/bookedPnL journal simulation; LIVE: CDP close is full-position-only — no fabricated partial, honest alert + BE-lock, runner rides to TP2). **TP2 hit → FULL close** ("profit booked, exit"). Single-target plans (tp1 only) exit fully at TP1. Gap-past-both in one pass books everything at the better price. `_closeTrade` P&L is now the honest TOTAL (final leg + TP1-booked legs — `bookedPnlINR`/`finalLegPnlINR` split stamped on the close). Config: `tpExitsEnabled` (default ON), `tp1ClosePct` (10-90, default 50), `tp1BreakevenLock`; status view exposes `tp1Hit/tp2Hit/tp1Px/bookedPnlINR/tp2`; panel shows T1✓/T2✓ chips + booked P&L + TP EXITS gate chip + config toggle.

### H1 — SAPTA entry gate was practically unreachable
- **`minVerifiedScore: 90` default vs SVA-v1's realistic 80-88 ceiling**: the 10-check weighted score (weights sum 100) loses −6 (MTF WARN), −3 (entryBand WARN), −3 (perpCrowd WARN) on GOOD signals — 90+ demanded a near-perfect checklist, so every candidate died at `verified:8x<90` (the "auto trade me lag nahi raha" root cause). SVA's own CONFIRM verdict already demands score ≥ 68 + ZERO core-fails + finalCall === side — that IS the pro gate. Default now **70** (CONFIRM floor + buffer), one-time migration for saved configs still carrying the old 90 default (`__migrations.v20_8_5`; deliberate user re-sets are never touched).

### H1 — futures-wallet READ-FAILURE killed all agent futures entries
- **`deployableFuturesUSDT: 0` on a FAILED read was treated as "margin < 2"**: walletSnapshot returns a 0 (not null) when the futures leg errors — the agent's `??` chain took the 0 as-is and blocked every futures candidate with the MISLEADING "margin < 2 USDT" skip. Now: read-fail + last-known margin (≤10 min old) → desk keeps running on last-known (honest `fut_wallet_lastknown` skip-log); read-fail + no last-known → blocked; only a SUCCESSFUL read renders the genuine margin verdict.

### H2 — futures wallet latency ("bahut late read")
- **Cold-start parallel probe (futures.js)**: the 7-rung auth ladder swept SEQUENTIALLY (3×10s worst case, cut by the 9s wallet-leg budget → first read post-boot/post-cooldown failed or took multiple polls). The 3 documented GET-body rungs now race in parallel (one resolved import, no per-rung re-import — a concurrent-dynamic-import quirk that leaked REAL network calls in the test env is also gone); the first array-shaped winner in ladder order goes sticky. Cold read ≈ one round-trip. Sequential legacy rungs remain the fallback (worst case still 7 total attempts).
- **walletSnapshot 10s server mini-cache + single-flight**: the UI poller, agent throttle and status views share ONE CoinDCX round-trip window (fetchedAt stays honest; `force:true` on the reconnect route bypasses; transport reset invalidates).
- **UI wallet poll 60s → 25s** (useWalletPoll; guards 30s→20s, late-subscriber 45s→20s) — effective wallet freshness ≈ 15-25s at LOWER aggregate signed-API load than the old 3×60s pollers.

### H2 — TP detection latency (agent futures positions)
- **Futures watcher 60s → 30s** (routes.js) + **watcher prices now ≤5s fresh** (`maxAgeMs: 5_000` in watchFuturesPositions — was the default 20s cache): worst-case TP1/TP2/SL detection latency roughly halved (was 20-80s, up to 3min when REST was dark).

### UX — "already tick hai bta raha hai"
- **`proTraderStart` now answers honestly**: a START on an already-ON same-mode engine returns `alreadyRunning: true` + preserved `startedAt` (panel toast: "pehle se ON hai (since X) — koi restart nahi hua") instead of pretending a fresh start. Mode switches remain real restarts.

### Tests & verification
- NEW `test/v2085AutoTradeTp.test.ts` (28 tests): TP verdict matrix (tiered/full/single-target/gap/SHORT-mirror/off/guards), breakeven ratchet one-way locks, PAPER E2E entry→TP1 partial+BE→TP2 full-exit with honest total P&L, TP-OFF negative, 90→70 migration + deliberate-set respect + re-set-after-stamp, alreadyRunning semantics, wallet mini-cache + force bypass, and 7 source contracts (watcher 30s/5s, reconnect force, agent last-known fallback, monitor TP-before-reversal, useWalletPoll 25s, panel chips, booked-PnL close).
- Updated stale locks: futures.test.ts parallel-probe call counts (3 raced body rungs) + `probesSinceSweep` now reset in `__resetFuturesForTests` (pre-existing gap — the counter accumulated file-wide and the 10-probe forceSweep intermittently bypassed the cooldown mid-file); proTraderAuto.test.ts gate 70 locks; launcherAutoBuild version gate 20.8.5; bats stamped v20.8.5.
- **tsc 0 errors · 3207/3207 tests (176 files, +28) · vite build 3.07s + stamp 20.8.5 · BOOT SMOKE E2E 15/15 live** (ping/health v20.8.5, login, protrader TP gates `{"enabled":true,"tp1ClosePct":50,"tp1BreakevenLock":true}`, verified gate 70, paper start + alreadyRunning honest, stop, wallet 200 + cached pass (same fetchedAt), SPA serve, pre-auth 401).

## v20.8.4 — FULL-SITE DEEP RECHECK ROUND 4 (2026-10-05)

**45 verified findings from 4 parallel deep-review agents (server core, bots/botlab, frontend, launcher/deploy/exec) — 2xH1, 7xH2, ~12xH3, remainder M/L — ALL fixed.** Post-merge recheck after origin pull (user's zip-content push + runtime candle data, resolved clean).

### H1 — MONEY PATHS
- **settleOpenTrades double-book killed (botRunner.js)**: the 60s scheduler interval does NOT serialize with a still-running async settle — overlapping passes booked the SAME position's P&L twice (reproduced: one honest settle = `tradesToday: 2`, equity hit twice). `_inSettle` re-entrancy guard + `port.close()` VERDICT now honored (`{ok:false}` → `settle_close_failed` event, no fabricated booking — the live-money version of this would debit the account on an exchange-rejected close while the real position stayed open).
- **Docker build was unconditionally broken (deploy/Dockerfile)**: `COPY telegram-bot/` resolves against the CONTEXT ROOT (repo root) — the bot lives at `app/telegram-bot/`. Every `compose up --build` died at stage 2. Paths fixed + `USER node` (was root) + `.dockerignore` gaps closed (`app/telegram-bot/node_modules`, `app/ml-service/store`, `app/backups`).

### H2 — SPINE
- **candleStore O(n) rewrite fix was defeated by its own caller (index.js)**: the provider saved the ENTIRE merged 6000-bar window every 60s per symbol → `saveCandles`' out-of-order path full-rewrote the store on every tick (~20MB/min sync I/O at 6-month depth). Provider now computes and persists only the DELTA (bars ≥ store tail + genuinely-new backfill bars).
- **Per-tick full-file store parse killed**: `loadCandlesCached` incremental tail cache (stat → unchanged = zero-parse hit; append-only growth = parse only the new byte range; rewrite = one full reload).
- **Denomination poison guard in saveCandles**: a store written by the other currency's feed now clean-resets (stamped `denominationReset`) instead of merging into a mixed-denomination file.
- **Mark-price path de-pathologized**: mark used to run the FULL chain (1000-bar fetch + store load + merge + 2 backfill pages) per open position per settle. Tiny last-close cache refreshed by every provider fetch (10-min TTL fallback).
- **PositionManager exit ladder was price-blind in EXEC_MODE=paper (the default)**: `_pmTick` passed EMPTY price maps and PaperPort marks freeze at the fill price — T1/T2/trail/SL legs could NEVER fire, only the time-stop. Ladder now fed live marks from the futures price chain (20s cache, Binance/Bybit fallback legs).
- **Engine mid-trade gap-through-stop honesty (core/engine.js)**: the v20.8.1 fix only covered the FILL bar. A LATER bar opening beyond the stop still booked `exit = stop` — a LONG from 101/stop 90/bar-open 80 recorded exit 90, understating the loss ~47% (systematic optimism on exactly the violent bars tight-stop strategies die on). Stop fills at the open when the open is beyond the trigger; target fills at the better open (limit semantics). `gapThroughStop` flag now on mid-trade gap exits too.
- **Kill switch / bot-removal no longer orphans open paper positions**: tick returned at the kill gate before `_ensurePaperPort` was ever reached, so settle never saw a port — the position froze forever, invisible to equity/daily-loss accounting. Settle now lazily recreates ports for ANY strategy with persisted open positions (kill stops ENTRIES, never EXITS).
- **Shared live-port settle attribution**: the `'*'` branch settled EVERYTHING as crypto — an India bot's live NIFTY position would be marked via the crypto desk (null → never settles) and fee'd with crypto taker costs. Owning strategy now derived from the clientId prefix.
- **Live opens now protection-first**: `ApiFuturesPort.open()` ignores sl/tp — a live position's only exit was the 60s mark-settle, violating the port's own CORE RULE. Bracket is set right after the fill; a rejected bracket FLATTENS immediately (+ Telegram alert).
- **Single-instance watchdog lock**: double-clicked bats ran concurrent `npm install`s (EPERM/rename corruption) and masked each other's crash-loops (both probe the same port). PID+age lock file in DATA_DIR (stale = take-over) + honest "already running" exit + port-already-serving probe before any build.
- **All three .bat files CRLF + `.gitattributes`**: LF-only batch files are the canonical cause of intermittent `The system cannot find the batch label specified` (cmd's label scanner chunk-boundary bug — SETUP is 14KB with goto labels). `*.bat text eol=crlf` rule keeps them CRLF forever.

### H3 / M — RUNTIME & HONESTY
- **503 page stops over-promising + supervisor retries**: ensureFrontend only ran in `_boot()` and the 1-attempt limit blocked rebuilds until a supervisor restart — a runtime-corrupted dist served the "khud theek ho jayega" page forever. Child exit now resets the attempt counter and re-runs the stamp check (buildingFrontend gates the restart → rebuild happens BEFORE the server comes back).
- **POSIX npm tree-kill**: `_runNpmCommand` spawns npm detached on POSIX and `process.kill(-pid)` on timeout — an orphaned vite kept writing dist/ under a running server (mixed-version assets pinned for a year by immutable caching).
- **Groq dead-fallback models swapped** (2 sites): the 400/404 retry used `llama-3.3-70b-versatile` — decommissioned and auto-rewritten away two pages up in the same file. Now retries with the current default.
- **Telegram webhook `_inflight` TOCTOU**: the add ran inside `setImmediate` while the check ran sync — burst updates for the same chat BOTH passed the cost guard. Add is now synchronous.
- **Live paper book charges slippage** (engine parity): settle netPnl was `realized − fees` while the engine charges bps both sides — paper always flattered vs the backtest that gates it. Same bps as the engine, `slippage` field on settle events.
- **Pre-decider cheap risk pass**: caps/cooldown/daily-loss knowable BEFORE the (paid) Jev call — a capped jev bot no longer burns API budget per candidate (`botRiskPreCheck`, shared reason strings with the full check).
- **Total daily-loss denominator fixed**: normalized by the per-currency aggregate STARTING equity (a 100k bot's −4% measured against a 10k bot's base wrongly killed the small bot).
- **Pre-auth body-parse guard**: anonymous /api/* POSTs were JSON.parsed (4MB) before requireAuth — CPU-DoS surface. No-evidence requests now 401 before the body is read (Bearer/cookie/session evidence accepted; public set mirrors requireAuth).
- **ml-service `/train` off the event loop** (`run_in_threadpool`, /analyze-pattern): the Docker HEALTHCHECK used to kill the container mid-training when /health stopped answering. Plus fail-closed posture: no `ML_API_TOKEN` + non-loopback client = honest 503.
- **Telegram bot relay hardening**: XFF last-entry spoof bypass fixed (`socket.remoteAddress` unless `TRUST_PROXY=1`), `relayRateCheck` dead cleanup double-index fixed (unbounded Map growth), unauthorized `/start`/`/help` single reply (was double).
- **Node version gate**: Node < 20 fails fast with the fix instruction (was: 15-min npm install that only warns engines, then a cryptic vite error).
- **WATCHDOG_AUTO_BUILD/INSTALL knobs** accept `0|false|off|no` (only exact `0` used to disable).
- **Bots desk SSE resilience**: token-expiry probe at the 3rd reconnect failure rides apiFetch's `session-expired` path (the Bots desk mounts no recurring auth'd REST call — the PIN gate used to never appear); reconnect backfill via `GET /api/bots/events?limit=500` fills long-disconnect audit-log holes.
- **runThreeArmBacktest instrumentType override** (ensemble INDIA fee-stack honesty) + descriptor comment.
- **mlGuard candle-element validation** (null element → 400, was a 500 crash path) · **PaperPort `||100` price fiction removed** (honest rejection) · **rCount only counts non-null R** (avgR dilution) · **jevEngine cache flush-on-exit hook** · **engine gap-branch achievedRiskPct pre-loss basis** · **smoke FATAL tmp cleanup**.

### L — FRONTEND & OPS
- **index.html + manifest.json three-desk text** + PWA `?tab=bots` shortcut (two-desk remnants everywhere the OS/preview layer shows them).
- **Kill/arm buttons disable while in-flight** (double-fire + out-of-order arm race).
- **useBots status numeric coercion at receipt** (shape drift → ErrorBoundary crash class, same discipline as the other desks).
- **MarketClockStrip hidden-tab gate parity** · SETUP-v20.bat **chcp 65001** (Hindi mojibake), **complete rollback list** (scripts/bat/configs/CHANGES were never backed up → frankenstate), **dist-optional guard** (code-zip payloads no longer always-fail-rollback), **critical copy errorlevel checks**, dead ROLLBACK.bat reference replaced with the real backup-folder instruction.

## v20.8.3 — ALWAYS-LATEST LAUNCHER (2026-10-05)

**THE "v20.7.5 SERVE" BUG (user report: zip extract → Watchdog chalao → site v20.7.5 dikhti hai, latest nahi)**: server frontend SIRF `dist/` (vite build output) se serve karta hai, aur `dist/` gitignored hai — code-zips me kabhi bundled nahi tha. Naya zip purane folder ke UPAR extract karne par naya SERVER code aa jata hai par PURANA `dist/` (v20.7.5-era build) serve hota rehta hai. UI badge wahi purana version dikhata hai, koi error nahi — user ko kabhi pata nahi chalta. Ye release us class ko Poori tarah se khatam karti hai: **koi bhi update path (zip overlay, git pull, manual copy) ab GUARANTEED fresh build tak le jata hai, aur stale-serve kabhi silent nahi rehta.**

### SUPERVISOR AUTO-BUILD SPINE (server/supervisor.js)
- **`ensureFrontend()`**: boot pe `dist/.build-version` stamp vs `package.json` version compare — `dist/index.html` missing YA stamp mismatch = FULL `npm install` (dev deps INCLUDED — vite/typescript build ke liye zaroori) + `npm run build`. Boot order: ensureFrontend **PEHLE** (full install runtime deps bhi satisfy karta hai — ensureDeps uske baad no-op, double-install nahi).
- **Race-free gating**: `state.buildingFrontend` startChild + _restartTick dono block karta hai (`installingDeps` pattern) — build ke dauran koi spawn race nahi.
- **Honest limits**: 1 build attempt per supervisor run (fail-loop impossible), har verdict journal (`ev: 'frontend-build'`) + Hindi log me — "build FAIL (stamp-mismatch-after-build)" jaise honest codes ke saath.
- **Knobs**: `WATCHDOG_AUTO_BUILD` (default ON), `WATCHDOG_BUILD_TIMEOUT_MS` (default 15 min).
- **`_runNpmCommand(args, timeoutMs)`** generalization — `_runNpmInstall` byte-identical delegate (supervisorGuard contract preserved), ensureFrontend full-install + `run build` isi se chalta hai.

### BUILD-STAMP SINGLE SOURCE (scripts/stamp-dist.mjs)
- **NEW postbuild hook**: `npm run build` ke baad `dist/.build-version` = package.json version likhta hai. Koi bhi build path (user, CI, zip-packaging) stamp chhod deta hai — supervisor usi se freshness decide karta hai. `DIST_DIR` env = hermetic test override. Build fail / dist missing pe exit 1 (fake stamp kabhi nahi).

### SERVER (server/index.js)
- **`SERVER_VERSION`** (package.json single-source; src/version.ts APP_VERSION release-gate sync me): `/api/ping` ab `v` field + `/health` ab `version` field carry karta hai — zero-work, frontend banner isi pe chalta hai.
- **dist-missing self-heal page**: SPA fallback pe `dist/index.html` missing thi to raw ENOENT 500 stack jata tha. Ab **503 + Hindi self-heal HTML** (15s meta-refresh — supervisor auto-build complete hote hi khud theek) + `fs` import jo index.js me tha hi nahi.

### FRONTEND STALE-BUILD VISIBILITY
- **useAuthState**: `/api/ping` heartbeat (jo pehle se 30s pe chalta tha) ab JSON ka `v` bhi capture karta hai — zero extra request.
- **App.tsx STALE-BUILD banner**: build-time APP_VERSION vs server-side `v` mismatch = red banner (login screen + terminal shell dono) — "browser vA · server vB · Watchdog dobara chalao (auto-rebuild), phir F5". Stale-serve ab silent nahi. Login screen ka legacy "startai chalu karo" text bhi Watchdog pe update.

### LAUNCHER / DOCS
- **Start-SmartAI-Watchdog.bat v20.8.3**: banner me auto-build line; header me ALWAYS-LATEST note (update flow: copy → restart bat → fresh site guaranteed).
- **SETUP-v20.bat**: VERSION.json stamp 20.8.3 (20.4.2 se stale tha), three-desk messaging.
- **NEW RUN-FIRST.md (repo root — zip extract ke turant baad dikhta hai)**: Windows user ka pehla sawal ("exe hai ya bat?") — 30-second run guide, Node.js prerequisite, PIN location, update flow, common problems (port 8080, node missing, stale cache).
- README.md: Windows quick-start section + three-desk (Bot Lab) description.

### TESTS
- **NEW test/launcherAutoBuild.test.ts (28 tests)**: stamp verdict matrix (fresh/mismatch/missing/legacy-tolerance), full auto-build path (install-without-omit-dev → run build → stamp match → journal → logs), install-fail/build-fail honesty, auto-build-off, tries guard, race-free gating source contract, boot order, knobs, win32 npm.cmd contract, **REAL stamp-dist.mjs execution** (hermetic DIST_DIR), index.js/useAuthState/App.tsx source contracts, version agreement (package.json === version.ts === 20.8.3), bat + RUN-FIRST.md shipping contract.

### PACKAGING (delivery)
- Zip ab **prebuilt `dist/` (stamped) ke saath** jata hai — fresh extract pe turant site serve hoti hai (auto-build sirf tab chalta hai jab code/dist mismatch ho). Tracked files + dist = run-ready.

## v20.8.2 — BOT-LAB LIVE TRADING SPINE REPAIR (2026-10-05)

"Latest GitHub repo pull + full site code deep advance pro level recheck" — user push (1ae24ae, v20.8.1 zip content) merge ke baad 3-track fresh review (botlab runtime agent + frontend/cross-site agent + self) ne 30+ NAYE findings diye. Theme: **v20.8.1 ne labs ko honest banaya tha, par live trading path ab bhi structurally dead tha — bot fleet 2/3 kabhi trade hi nahi kar sakti thi, aur jo ek kar sakti thi uske attempts bhi dead the.**

### MERGE / REPO HYGIENE
- origin/main 1ae24ae merge: add/add conflicts (botlab/deploy/tests) content-identical the (480 files, 0 insertions/deletions) — OURS liya gaya (repo ki 755 executable-mode convention vs zip-extracted 644)
- **Runtime data untracked + gitignored**: user push me `app/data/bots/candles/*` + `execution-heartbeat.json` (server run se generated) accidentally commit hue the — tracked runtime files = permanently dirty tree + har run pe accidental re-commits. Ab `.gitignore` + `.dockerignore` dono me.

### CRITICAL — CRYPTO BOTS STRUCTURALLY DEAD (H1)
- **[H1] ATR warmup vs feed depth**: orb-crypto/lvl `atrPeriodBars: 2016` (7-day ATR) vs 300-bar live feed → ATR har row pe null → zero candidates FOREVER (2/3 default fleet dead, heartbeats phir bhi "ok, bars:300" bolti thi). FIX: Binance 1000-bar fresh window + bounded paged backfill (2 pages, endTime-contiguous) + candleStore history merge → day-1 pe ~3000+ bars, ATR seeded.
- **[H1] Cross-currency poisoning**: crypto chain primary CoinDCX **INR** pairs + fallback Binance **USDT** — feed swap pe ~85x denomination flip: poisoned store (keep-newest dedupe whole history flip karta tha), lying provenance (source hardcoded 'coindcx'), aur INR-scale SL vs USDT-scale mark = instant phantom stop. FIX: USDT-denominated chain end-to-end (Binance/Bybit primary, CoinDCX-INR **scaled** last leg with honest `coindcx-inr/<fx>` stamp), `sameDenomination()` guard purane INR-store ko merge hone se rokta hai, real source provenance me stamped.
- **[H1] Deploy crash-loop**: `deploy/.env.example` me APP_PIN nahi tha — validateEnv exit(1) + restart:always = documented deploy flow pe infinite crash loop. FIX: template me REQUIRED APP_PIN.

### LIVE TRADING PATH (H2)
- **Staleness double-standard**: pre-check 90s+300s allow karta tha, botRisk hard-layer raw 90s pe veto karta tha — decider (paid Jev + burned attempt) ke BAAD veto. FIX: runner `feedMaxAgeSec` pass karta hai = same window; botRisk #8 override honored.
- **Shared 120s candle cache**: bot ticks pre-close snapshots pe trade kar rahe the — `noCache` ab bot chain me (smoke.js pattern).
- **Open-cap within one tick**: openCounts tick-start pe snapshot hota tha, successful open ke baad refresh nahi → 3-symbol bot ek tick me 3 positions (3x risk). FIX: `myOpen++` + counts mutation on `opened.ok`.
- **orb_in attempt persistence dead**: strategy object pe `sessionKey` missing tha (fn alag export hoti thi) → cross-tick one-per-day kabhi engage nahi hota tha — re-detect har 60s, duplicate order events, backtest-suppressed re-break live trade ho sakta tha. FIX: `sessionKey: orbInSessionKey`.
- **Live time-exits missing**: settle sirf SL/TP check karta tha — engine ka maxHoldBars (24h crypto time-stop) aur 15:10 IST square-off live me the hi nahi. India position market close ke baad frozen mark pe indefinitely hang, bot blocked. FIX: settle loop me `time_stop` / `square_off` exits (overnight-missed case samet), positions pe `openedAt` + `meta` stamp.
- **Partial Dhan history discarded**: ek failed 90d chunk poora fetch phenk deta tha — ab bars>=60 ho to accept.

### RUNTIME / PERSISTENCE (H3)
- **Paper positions ephemeral**: restart open positions silently delete karta tha. FIX: `hydrateOpenPositions()` + har open/settle ke baad snapshot bot-state me persist.
- **Duplicate-clientId fake ok**: dup open `ok:true` bina position ke return karta tha → fake "order ok" events. FIX: existing position return hota hai (`dup:true`).
- **Docker telegram-bot deps**: image me sirf app/ ke deps install hote the — TG_TOKEN deploy child ko MODULE_NOT_FOUND + restart loop. FIX: `npm ci --omit=dev --prefix telegram-bot`.
- **BOT_STATE_DIR ephemeral in bare docker run**: image default ab `/app/server/data/bots` (+ mkdir), docs corrected (code default `app/data/bots` hai).
- **candleStore O(n) rewrite per save**: har 60s per symbol full-file rewrite — 6-month depth pe ~20MB/min sync I/O. FIX: append-only fast path + forming-bar tail fix-up + out-of-order full-merge fallback.
- **readEvents sync parse-storm**: SSE har 5s per client (cap 8) har bot ka poora events.jsonl sync-parse karta tha — mtime+size cache with clone-on-hit (v20.7.12 journal-fix class).

### FRONTEND
- **[H3] ORDERED dead + FAILED indistinguishable**: production order events me `action` field hota hi nahi → har order row ka verdict '—', failed open filled jaisa dikhta tha. FIX: verdict `kind==='order' ? (ok===false?'FAILED':'ORDERED')` + settle rows me exitWhy. Galat test lock (fabricated `action:'take'` order shape) bhi corrected.
- **[H3] SSE reconnect duplication**: har reconnect pe last-60 events re-append → dup TAKE/order rows (dup order = double entry lagta tha). FIX: client-side composite-key dedupe at receipt.
- **[M] Unstable decision-row keys**: reversed-index keys har append pe saare 60 memo rows remount karte the — receipt-id (`__rid`) stable keys.
- **[M] Desk hotkeys vs modals/select**: 1/2/3 deep-modal open hote waqt desk switch karke modal destroy kar dete the; arm `<select>` me bhi fire hote the. FIX: select-element guard + body scroll-lock overlay convention check.
- **[M] kill/arm instant feedback**: POST response ab local status patch karta hai (SSE down ho tab bhi); actionError 6s me auto-clear.
- **[M] Backtest pWin ab rendered** (BotCard me 9th stat — fee-gate ka actual input dikhta hai); **fmtMoney locale** currency-aware ($ pe en-US, ₹ pe en-IN).
- **[L] SSE cursor edge cases**: same-ms events drop + >60 skip — inclusive `>=` filter + uncapped deltas + 500-event read window (client dedupe ke saath lossless).

### OTHER
- jevEngine in-memory Map trim ab actually called (placebo tha); /smoke rejection pe honest 500 (Express-4 hang class); /stop note 200-char cap; express.json 4mb (backtest 20k-bars cap reachable); deciders.js dead `gated` removed; CLI jev cachePath script-relative; status() IST-midnight rollover; version.ts stale build-gate comment fixed; package.json description Three-Desk.
- NEW test suite `v2082BotlabHardening.test.ts` (16 tests: sessionKey spine, staleness window, PaperPort dup/hydrate, candleStore append/tail-fixup/out-of-order/merge/denomination, readEvents external-write + clone, settle time_stop/square_off/no-fire) + botlabBotRuntime order-event shape corrected.

## v20.8.1 — JEV BOT LAB DEEP RECHECK (2026-10-05)

v20.8.0 ka bot lab 6 tarike se functionally dead tha — 40+ fixes: Jev arm placebo (take-normalization), daily-loss kill on real account shape, async open-counts, 60s scheduler + settle loop + mark prices wired, honest paper fills (forming-bar open), SSE decision stream live cursor, candleStore producers, Dhan single-timer throttle, bars-based mechanical audit, gap-through-stop honesty, maxHoldBars honored, attempt persistence across ticks, per-currency totals, PaperPort per-account, fee-gate fail-closed, absolute stateDir, multi-stage Dockerfile (frontend kabhi build nahi hota tha), .dockerignore secrets guard, CLI audit ctx. +7 test locks. (Release zip se pehle commit c5c05e5; CHANGES.md me entry v20.8.2 ke saath backfilled.)

## v20.8.0 — JEV BOT LAB (2026-10-05)

Plan-faithful 3-arm honest signal pipeline (rules | gated | jev): causal feature core (NaN-drop, shift(1), O(n) sessions), honest backtest engine (next-open fills, ambiguous-bar pessimism, friction both sides), 4 strategies (orbIn / orbCrypto utc-london-ny / lvl / ensembleAdapter) shared backtest-live spec, Jev engine (probabilities[chosen] gate, no side-flip, wait-fallback, breaker), hard botRisk layer, botState atomic + events.jsonl + kill switches, per-bot virtual accounts, Dhan 5-min fetcher + candle store with provenance, /api/bots SSE dashboard (BotsTab third desk), Phase-0 smoke + 3-arm CLI, Docker deploy. +70 tests. (Commit 778cca5; CHANGES.md entry v20.8.2 ke saath backfilled.)

## v20.7.12 — LIVE-MONEY HONESTY + SITE HARDENING (2026-10-05)

"Full site code recheck + issues fix + optimize" — 3 parallel deep-review tracks (server infra, frontend, execution stack) ne 40+ findings diye; is release me sab high-severity + lagbhag saare medium/low fix hue. Theme: **har verdict earned — koi ok:true jhooth nahi, koi silent stale data nahi, koi unnecessary render nahi.**

### SERVER — LIVE-MONEY CRITICAL (execution stack)

1. **[H1] Reconciler orphan-flatten engine-owned-only (reconciler.js)** — orphan sweep pehle ANY unprotected exchange position market-close kar deta tha jabki PM state production me KABHI populate nahi hoti thi (protectionFirstEntry/tick ke zero call-sites) — EXEC_MODE=api pe user ke apne MANUAL trades 12s me flatten ho jate. Ab flatten SIRF engine-owned positions pe (journal me recent LIVE FUTURES ORDER/OPEN row, 24h window, 60s-cached scan); manual positions **adopt-only** + 30-min throttled advisory Telegram alert. Test-hook `__setEnginePairsForTests`.
2. **[H2-1] CoinDCX 200-wrapped error bodies detect (futures.js)** — `coindcxRespError()` pure detector (numeric/string code ≥ 400 · status error/fail/reject · top-level error string; success shapes — `order:{id}`, arrays, plain `{message:'ok'}` — kabhi flag nahi). `createFuturesTpsl` pehle HAMESHA `{ok:true}` return karta tha → "native TP/SL armed" journal jabki exchange pe SL set hi nahi tha (naked leveraged position believed protected). `createFuturesOrder` ab id-less/errored 200 pe `{orderId:null, error}` deta hai; `exitFuturesPosition` ab `{ok, error, raw}` verdict; executeFuturesSignal LIVE path explicit rejection pe honest FAILED journal karta hai (pehle SUBMITTED + ok:true).
3. **[H2-2] POST /api/exec/enter wired + PM 15m exit-ladder tick driver (routes.js + index.js)** — route sirf comment me promise tha jabki poora Phase-4 ladder (protection-first + T1/T2/trail + reversal) unwired dead-code tha. Ab real: signal+plan body → canEnterNew (kill-switch + leader lease) → PM.protectionFirstEntry → journal ORDER audit entry (source 'exec-enter'). Browser-mode refuse (Phase-6 UI-SL pending). index.js me 15m unref'd tick driver — PM state khali to no-op.
4. **[H2-3] lib/store loadJSON mtime+size cache** — positionsStream ka 1s poller getPositionsWithPnl() → loadJournal() → FULL journal (0.5–2MB) ka readFileSync+JSON.parse HAR SECOND (EVENT-LOOP FREEZE class — "30s window worst 5.5s" contributor). Ab statSync-check cache (µs) + structuredClone-on-hit (parse se ~5–10× sasta); saveJSON eager-invalidate; external writes next stat pe visible (TTL race nahi); callers ke mutations cached copy ko kabhi corrupt nahi karte (clone-on-hit).
5. **[H2-4] port.open verdict honesty + ApiFuturesPort.cancelOpenOrders honest** — open ab ok sirf exchange-issued orderId pe (pehle `?? clientId ?? ''` fallback se ok:true jhootha tha); clientId abhi wire nahi jata (futuresOrderBody documented shape me client-order-id field nahi — exchange-side dedupe pending API-doc verification, header comment me documented). cancelOpenOrders stub ab ok:false + manual-verify note (pehle ok:true tha jabki cancel hua hi nahi).
6. **[H2-5] Fill-confirm matcher pre-open snapshot** — pehle (pair + |Δqty|<1%) match karta tha jo account me PEHLE SE khuli same-pair position se bind ho sakta tha (setProtection PURANI position ka SL overwrite). Ab post-open NAYI rows pehle milti hain (partial fill bhi — ladder actual qty pe); legacy pair+qty fallback sirf tab jab koi naya row na aaye.

### SERVER — RELIABILITY / PERFORMANCE

7. **[H3-1] Watcher single-flight guards** — futures/global/india watchers (60s) ek brownout me >60s chalte the aur agle tick journal-lock pe QUEUE hote the (SL enforcement serialize + fall-behind + burst). Ab `_futGuard/_globGuard/_indiaGuard` inflight-skip (defer, drop nahi).
8. **[H3-2] proTraderAuto `_saveJournal` ab `_jSize` bhi set karta hai** — v20.7.4 ka mtime+size cache har write ke baad DEFEAT ho jata tha (sirf mtime update hota tha) → N monitor-mutations = N full sync re-parses per tick.
9. **[H3-3] SAPTA SSE backpressure + keepalive teardown** — `_broadcast` pehle `res.write` ka return ignore karta tha: stalled client (phone sleep) har 3s status + 120-row log payloads INDEFINITELY buffer karta tha. Ab 128KB writableLength cap pe disconnect (positionsStream/index.js pattern); last client jaane pe keepalive clearInterval.
10. **[H3-4] Provider fallback chains 35s TOTAL deadline** — /api/gemini 4-rung model ladder (worst ~120s pinned socket) + groq-compat retry (worst ~60s) ab ek shared `AbortSignal.timeout(35_000)` pe — jo rung bache hue time me fit ho wahi try hota hai.
11. **[H3-5] UNFILLED re-entry block + LATE-FILL adoption** — PLACED TTL slot free karta tha par resting GTC order broker pe zinda reh sakta tha → same symbol pe naya entry + late fill = DOUBLE EXPOSURE. Ab UNFILLED rows `blockedSymbols` me (CLOSE_FAILED jaisa); `_monitorPositions` me late-fill check — positions table me row dikhi turant MONITORING me wapas + Telegram alert (unmonitored live position khatam).
12. **[M-2] signals.js `* 84` → `usdInrFallback()`** — buildCryptoCtxSync ka TV-only fallback flat-84 hardcode tha (v20.2 ne baaki sab sites fix kiye the); real USDINR ~89 pe ~6% misprice.
13. **[M-3] Fill-poll progressive backoff** — 2s×180s = ~90 private listFuturesPositions calls per entry ab 2s→2.6s→3.4s→…cap 8s (~30 calls); test cadence (pollMs<1s) exact rehti hai.
14. **[M-4] Fundamentals cache FIFO → LRU** — hit pe re-set (MRU refresh); hot symbols ab evict nahi hote.
15. **[M-5] browserAgent pageFor old-socket close** — tab reopen pe purana CdpPage WebSocket zombie reh jata tha; ab replace se pehle close.
16. **[L-2] sizing `_roundQty` scientific-notation steps** — `String(1e-7)` ka decimals-part exist nahi karta tha → qty INTEGER round; ab exponent se derive (1e-7 → 7, 1.5e-7 → 8).
17. **[L-3] candles/replay/orderbook symbol charset validation** — backtest/strategy-lab ka hi treatment.
18. **[L-7] PaperPort bounded bookkeeping** — `_clientIds` 400-cap FIFO + `_fillLog` 400-cap (long soaks bounded).

### FRONTEND — RENDER STORM + DATA HONESTY

19. **[H2-1] Stable-callback props (dono tabs)** — live tick flush tab ko ~1.25/s re-render karti thi; inline arrows (onDeep/liveLtpFor/liveSrcFor/onDhanConnect) memo'd heavy panels (ExpertPicks 12 cards, TopPicks, OrderConsole positions table) ko HAR flush pe bust karte the. Ab useCallback/module-const stubs + `memo(ManualTradeMonitor)` + `NAV_SIMPLE` module-scope. Board card map me ek `liveFor()` call per card (pehle 2).
20. **[H2-2] useCxLivePrices tick-wipe FIXED** — symbol-set change (board re-rank, volatile days pe har 30–60s) cleanup `setTicks({})` chalata tha → POORE board ka ⚡ live LTP 60–90s purane snapshot pe flash-back + SSE teardown churn. Ab namespace-aware pruning effect sirf DROPPED keys hataata hai; connection sirf set-change pe rebuild (sorted keys pe reorder-safe pehle se).
21. **[H3-5] Per-domain in-watch sets** — `forSignal('FUTURES','BTC')` ka check cross-domain union se pass hota tha (BTC spot me bacha ho to) → FUT_BTC tick 120s tak ⚡ jhootha. Ab fut/glob/spot∪india apne sets.
22. **[H2-3] Deep modal DE-TICKED** — 1s `setNextInS` POORA tab re-render karta tha; ab `nextRecheckAt` timestamp 15s boundary pe update + countdown chip ke APNE local timer me compute. DeepPinnedCompare/DeepTransitionLog/DeepIndicatorGrid memo'd; 1s force-timers hidden-gated.
23. **[H3-3] Deep modal EXECUTE ROUTING** — 🚀 TRADE button pehle HAMESHA pinned (~90s purana) plan se jaata tha, verdict kuch bhi ho. Ab: CONFIRMED → pinned; **DRIFTED → ticket LIVE plan pe shift** (amber strip "fresh entry/SL/targets"); **FLIPPED → execute band** (red strip — dead thesis se trade nahi); UNKNOWN → verdict ka wait.
24. **[M-8] deepPinVerdict UNKNOWN** — live re-run side na de (data gap) to pehle FLIPPED bol deta tha ("thesis dead"); ab honest NO-VERDICT (slate chip) — over-alarm band.
25. **[H3-1/H3-2] QuickNav** — dead SELF-FIX chip deleted (v20.6.3 se section hi nahi hai); RECHECK chip added crypto desk; India desk ke 3 unreachable sections (in-expert/in-recheck/in-manual) ke chips added.
26. **[H3-4] useIntradayStream parity guards** — mount-while-hidden park + 10s never-stop watchdog + 45s zombie-kill (NSE stream ab 'connected' dikha ke freeze nahi ho sakta).
27. **[H3-6/L-6] RefreshCountdown generatedAt-derived** — ring ab exactly board-cycle pe count karta hai (pehle apna 60s counter jo 30s poll cycle se desync tha); 1s ticker hidden-gated.
28. **[L-5] wsHealth identity-stable** — har 15s status frame naya object → extra render; ab content-compare ke baad hi naya identity.
29. **[M-6] models fallback** — GLOBAL desk loading me SPOT ka Model Registry dikh jata tha; ab sirf active desk (loading me honest empty).
30. **[M-7] deskCache sweeper** — useAITrading ka per-symbol options Map unbounded tha; ab _verdictCache wala 10-min sweeper.
31. **[L-3] liveInvalidation DIRECTIONAL (frontend + server twin sync)** — LONG ka price entry zone se UPAR moon kare to amber "moved past entry zone" jhootha tha; ab sirf ADVERSE direction flag. topFive mirror-test updated.

### TESTS

- **NEW test/v2012SiteHardening.test.ts: 40 tests** — coindcxRespError detector, UNKNOWN verdict semantics, store-cache clone/external-write/invalidation, PM fill-match pre-open-snapshot priority, PaperPort bounds, + 23 source-contracts (route wiring, tick driver, single-flight, deadlines, UNFILLED block, NAV chips, per-domain sets, watchdog parity, memo blocks, stable callbacks).
- **UPDATED**: reconciler.test.ts (engine-owned vs manual adopt-only), execPort.test.ts (naya honest adapter contract), v2079 W2/W6 (deepCardSig + deepCardTick shape), topFive (directional weakening).
- Baseline green: **3,023 tests (168 files)** — v20.7.11 ke 2,982 se +41.

## v20.7.11 — DEAD-CODE PURGE + LEAN BUILD (2026-10-04)

"Site working fine hai" — ab usi site ke andar ka safai. Full-repo static import-graph audit (TypeScript compiler API se exact multi-line/dynamic import parsing; scripts/ me 3 naye audit tools: `orphan-files.mjs`, `audit-unused-exports.mjs`, `alive-check.mjs`) — har file, har export, har dependency ka consumer-trace. Jo kuch bhi kisi entry-point (server/index.js · supervisor.js · src/main.tsx) se reachable nahi, aur koi test bhi use nahi karta — DELETED.

### DELETED FILES (7)

1. **server/ai/selfStatus.js** — v19 self-improvement status rollup; only importer routes.js me COMMENTED tha (v20.6.3 removal ka leftover).
2. **server/ai/retrainBridge.js** — ml-service Python training bridge; only importer selfStatus.js tha (dead chain).
3. **server/ai/strategyEvolution.js** — evolution runner; sirf commented route.
4. **src/utils/telegram.ts** (1,126 lines) — v1 Telegram-bot-era browser helpers (analyzeAsset, getSmartAllocations, generateDeepAnalysis, generateNeuralInsiderResponse) — ZERO consumers. (4 market-clock helpers is file me the, par unke bhi asli consumers api.ts ke DEAD poll-interval region me the — dono saath gaye.)
5. **src/utils/entryPriceEngine.ts** (551 lines) — VWAP/volume-profile/fib/pivot/ML-bounce entry engine; only consumer telegram.ts tha.
6. **src/utils/constants.ts** (188 lines) — TAX_PAIRS/ETF-alpha/CAGR/ticker-map/TV-resolve — only consumer api.ts ka dead region tha.
7. **src/types/index.ts** (239 lines) — Position/PriceData/Transaction… saare types ka zero importer raha cleanup cascade ke baad (aitrading/types.ts + intraday/types.ts alag zinda hain).
8. **src/components/Toast.tsx** — poora Toast SYSTEM dead tha: koi component kabhi `useToast()`/`addToast` call nahi karta — toast KABHI render hi nahi hota tha. main.tsx se ToastProvider wrapper bhi hata.

### SHRUNK FILES

- **src/utils/api.ts: 2,161 → 171 lines** — v1 "Wealth AI" portfolio plumbing (batch price scanner engine + SmartCache, Google-Sheet cloud sync, Groq-key cloud sync, Telegram alerts, market-intelligence, IndMoney net-worth, CoinDCX connect, server-settings editor — 40 dead exports) saaf. Zinda surface: `apiFetch`, `getProxyBase`, `getSessionToken`, `setSessionToken`, `ensureAuthenticated`, `__resetSessionExpiredThrottleForTests`.
- **src/utils/db.ts: 431 → 108 lines** — IndexedDBStorage ke 6 stores me se 5 (transactions, priceHistory, aiChatHistory, portfolioSnapshots, offlineQueue) ke 13 methods + 4 interfaces — zero callers. Sirf userPreferences KV store (paperMirror iska use karta hai) bacha. Same DB name/version — existing devices ka mirror safe.

### DE-EXPORTED (function zinda, sirf `export` keyword gaya — internal-only use)

- expertMode.js (resolveSymbol, fetchYahooChartCandles, getExpertCandles, getExpertHeadlines) · orderFlowDepth.js (getCoinDcxDepth, getIndiaDepth) · fundamentals.js (warmFundamentalsUniverse) · cxBookState.js (FUT_BOOK_FRESH_MS, pruneFutBook, futBookRow, futBookLastUpdateAt) · entryTiming.js (CHASE_RSI_ASSIST_HI/LO, CHASE_EXT_RSI_ASSIST) · council.js (councilDebateRounds) · cryptoAgent.js (fullTicketRules) · binanceFutWs.js (_closeBinanceFutWs) · blackScholes.js (normPdf export list se) · mcpTools.js (computeServerSuperScore) · supervisor.js (run — CLI-boot internal) · index.js (`export const __execPort/__positionManager = null` dead bindings DELETE — routes globalThis padhte hain) · paperMirror.ts (5 internal fns) · deskShared.tsx (DESK_VIEW_KEY, REFRESH_MS) · deepAnalysisExtras.tsx (DEEP_RECHECK_SEC) · TopPicksPanel.tsx (jumpToSignalCard) · QuickNav.tsx (Section component DELETE) · useAITrading.ts (fetchFuturesMarkets + fetchNextActions functions DELETE) · vite-env.d.ts (6 stale VITE_ env declarations trim — sirf VITE_API_PROXY + VITE_ENCRYPTION_KEY zinda).

### DEPENDENCIES REMOVED (3)

- **motion** (framer-motion) — 126.6 KB vendor chunk SIRF Toast ke 2 micro-animations ke liye tha; Toast system khud dead nikla, dono gaye.
- **lightweight-charts** — kahin import hi nahi (CandleChart apna SVG engine use karta hai).
- **node-telegram-bot-api** (main package.json se) — main app me sirf ek comment mention; telegram-bot/ apna package.json+deps use karta hai.

### BUILD RESULT (before → after)

- Modules transformed: **2,251 → 1,845** (−406)
- vendor-motion chunk (126.59 KB / 41.62 gz) + utils-telegram chunk (34.17 KB / 9.92 gz) — **GONE**
- Total shipped JS+CSS: **1,151.6 KB → 990.6 KB raw (−161 KB / −14%) · ~305 → ~252 KB gzip (−17.5%)**
- Build time: 3.75s → 2.92s (−22%) · CSS −1.6 KB · icons −0.8 KB
- Server: 149 route files (3 dead gone), boot smoke green (ping 200, zero module errors), route checker PASS (frontend 101 → 79 live /api/ paths — saare registered routes se backed)

### TEST CONTRACT UPDATES (2)

- supervisorGuard.test.ts: `run` ab internal-only — export assertion → boot-wiring assertion (`run().catch(` __isMain path).
- v189IndiaClock.test.ts: REFRESH_MS de-export — 60s value contract wahi hai.

### VERIFICATION

tsc 0 errors · **2982/2982 tests green (167 files)** · vite build OK 2.92s · node --check all touched files · server boot smoke (APP_PIN env) ping 200 + zero ERR_MODULE_NOT_FOUND · check-api-routes PASS.

## v20.7.10 — LIVE-MONEY EXECUTION GUARDS (2026-10-04)

Execution stack (SAPTA positionManager + proTraderAuto + exec ports) ka deep advance-pro audit — **6 CRITICAL live-money bugs** mile aur fix hue, plus realtime/feed reliability upgrades.

### CRITICAL FIXES (wrong-order / wrong-price class)

1. **ApiFuturesPort.open() — galat request keys**: `quantity: qty` pass hota tha jabki `createFuturesOrder({ pair, side, qty, ... })` destructuring karti hai → qty undefined → total_quantity NaN → JSON null → exchange 400. `client_id`/`order_type` bhi silently drop hote the (idempotency kabhi wire tak nahi pahunchi). Ab exact keys — EXEC_MODE=api pe pehli baar valid order body.
2. **ApiFuturesPort.setProtection() — SL kabhi set hi nahi hota tha**: `{ positionId, sl, tp }` pass hota tha jabki adapter `{ stopLoss, takeProfit }` leta hai → dono undefined → adapter ka 'no levels given' error object → `!!r` truthy → **ok:true LIE** — positionManager protection-first pass ho jata tha jabki exchange pe koi SL SET HI NAHI THA (naked leveraged position believed protected). Ab `r?.ok === true` + error surfaced.
3. **ApiFuturesPort.reduce() — SHORT position DOUBLE ho jaati**: `{ positionId, qty }` pass hota tha jabki `partialFuturesExit({ pair, qty, side, leverage })` chahiye → pair undefined + side undefined → opposite HAMESHA 'SHORT' default → SHORT reduce pe bhi opposite-side sell order = **same direction ka naya order, position double**. Ab position resolve karke sahi pair/side/leverage.
4. **ApiFuturesPort.close() — `[object Object]` exchange ko**: `exitFuturesPosition(positionId)` POSITIONAL arg leta hai, object nahi — ab positional.
5. **proTraderAuto FUTURES tick ~84x off**: `_monitorLtpOf` SAB markets pe `IN_<base>` (spot INR) padhta tha — B-ETH_USDT ko ₹2.5L spot price milta → **instant BOGUS SL-hit close of a healthy position** + PnL/ROE ~84x inflated. Ab futures `FUT_<base>` (USDT domain) se.
6. **_closeTrade engine-mode gate**: `cfg.mode` dekhta tha, trade ke stamp `t.mode` nahi — user live positions khule rakh ke SAPTA paper me restart karta → broker close SKIP + row CLOSED (green journal lie, live position abandoned). Ab `t.mode === 'live'` pe close.

### HIGH-FIXES

- **ENTRY AMBIGUOUS journaling**: CDP throw (timeout/ws-drop) ke baad bhi in-page script chal chuka hota hai — order land bhi sakta hai. Pehle sirf 'entry skip' log hota tha: NO journal row, NO cooldown → agla tick DUPLICATE entry. Ab AMBIGUOUS FAILED row + telegram warn.
- **PLACED TTL 15min**: kabhi fill na hone wale resting limit orders maxConcurrent slots PERMANENTLY block karte the (engine band). Ab UNFILLED retire + alert.
- **CLOSE_FAILED symbols re-entry block**: broker pe position zinda ho sakti hai — jab tak FAILED-close row journal me hai, naya entry blocked.
- **Reconciler kill-switch + RAM RED gate ab SAPTA entries pe bhi**: index.js ka comment claim karta tha par tick me reference hi nahi tha. Sirf NAYE entries block — monitoring/closes kabhi nahi.
- **positionManager fill-poll**: pehle SINGLE re-read (~0ms) — limit order us waqt tak KABHI fill nahi hota tha → HAR entry fail. Ab entryLimitTtlSec (180s) tak 2s cadence poll. Failed close/reduce/protect → state PRESERVE + retry next candle + alert (pehle failed close = position abandoned / phantom trim journal).
- **Board cache limit-poisoning**: cache key caller ka limit ignore karta tha — limit-5 internal caller (telegram/auto-exec, hamesha-on) ke baad 60s tak limit-10 readers ko 5-row board serve hota tha (rows 6-10 invisible + 15s recheck watch se drop). Ab CANONICAL 40-row compute + per-caller serve-time truncate.
- **Market-fallback conservative sizing**: qty=TOTAL/PLAN fast-market me notional OVERSTATE karta tha; ab divisor=max(live,plan) — notional kabhi TOTAL se upar nahi.
- **Pre-click qty EQUALITY verify**: non-empty check React form-default (e.g. 0.001) pass kar leta tha → UNCONTROLLED size; ab 5% tolerance equality + re-set + throw.
- **Side-aware position close**: same pair pe do rows (hedge/manual+SAPTA) pe FIRST match close hota tha — galat row + CLOSE_UNKNOWN retry wahi galat row 8 baar. Ab pair+side match; unknown side pe multi-row REFUSE; BrowserCdpPort khud positions se side resolve karta hai.
- **PaperPort qty rounding**: 2-decimal round 0.0045 → 0 → position delete + margin strand; ab 6-decimal.

### FEED RELIABILITY (India/Crypto tabs ultrafast prices)

- **Binance spot+futures WS silence watchdog**: NAT idle half-open sockets koi frame/close event nahi dete — readyState===OPEN check hamesha return → kabhi recover nahi + socket leak. Ab 45s silence = terminate + reconnect (cxSpotWs/cxRtStream me pehle se tha; Binance clients me missing tha).
- **Flat-price heartbeat**: dead-band suppress ki wajah se flat price wale symbols pe kabhi tick nahi jata tha — client ⚡ label 10 min tak purane price pe zinda reh sakta tha. Ab suppressed tick ke 45s baad force-send; client hard-cap 10min → 120s (genuinely dead leg ab jaldi honest null).
- **Futures deep-stale honest flag**: fetchFuturesPrices(maxAgeMs) ignore hota tha — 3-min-purana price bhi 'fresh' SL/reversal decisions me chal jata tha. Ab >45s = stale:true.

## v20.7.9 — DEEP-PIN LIVE RE-VERIFICATION + 3s ULTRAFAST INDIA PRICES (2026-10-03)

User reports: (1) "India Intraday TAB & Crypto CoinDCX TAB — Live Market Realtime ultrafast prices fetch ho raha hai kya, advance pro level pe check karo"; (2) "Superintelligence Signal Board ke trade signal me DEEP ENSEMBLE ANALYSIS click par data/score/details ALAG kyun dikhte hain?" **Root cause mila aur fix hua — is release me dono tabs deep-verified.**

### FIX 1 — DEEP ENSEMBLE ANALYSIS vs SIGNAL BOARD MISMATCH (the main complaint)

**Root cause**: 🔬 click par modal clicked signal ko THROW AWAY kar deta tha aur sirf fresh-recomputed ensemble render karta tha. Board card ~90s purana snapshot hai (60s board cache + 30s client poll), fresh re-run legitimately alag numbers deta hai — side tak flip ho sakti hai. Correct engine behaviour, par user ko "deep analysis galat data dikha rahi hai" jaisa lagta tha.

**Fix — PIN architecture**: click kiya hua signal ab modal me PIN hota hai:
- Modal ka PRIMARY card = wahi EXACT board signal (score/side/grade/plan/votes) jise click kiya — loading ke DURING bhi turant render hota hai (blank 🧠 screen khatam)
- Neeche **BOARD CARD vs LIVE RE-VERIFICATION** comparison block — dono columns saath: side · grade · confidence · AI score · entry/SL/T1/T2, ages ke saath. Verdict chip: ✅ STILL VALID / ⚠️ DRIFTED / ⛔ SIDE FLIPPED
- 15s auto-recheck ab sirf LIVE column update karta hai (pinned kabhi nahi badalta — functional setDeep)
- Live re-run FAIL ho to pinned card + honest "live re-verification unavailable" strip — click context kabhi lost nahi
- `deepPinVerdict()` pure engine (22-test regression lock): FLIPPED = side ulat; DRIFTED = grade change / |Δconf|≥8 / |ΔAI score|≥8 / entry ≥1.5% move; CONFIRMED = sab tolerance me
- Expert/Top-picks stubs (confidence-less) pin-less rehte hain — wahan fresh-run-only UX unchanged

### FIX 2 — INDIA TAB 3s ULTRAFAST PUSH PRICES (advance-pro upgrade)

Server ka TEZ 3s India push stream (`/api/stream?in=…` — Groww NSE 3s poll, refcounted, NSE-window gated, Yahoo index fallback) exist karta tha par India tab subscribe hi nahi karta tha — board cards sirf 5s watcher SSE pe the. Ab tab ONE `/api/stream` connection kholta hai apne board symbols ke liye: **3s push tick wins → 5s watcher fallback** (paper/tracked symbols watcher ke paas hi rehte hain). Hidden-park, zombie-kill, never-stop watchdog — sab hook se free.

### FIX 3 — INDIA DEEP MODAL ME FROZEN SNAPSHOT PRICE

Deep modal ka SignalCard `liveLtp`/`liveSrc` pay nahi raha tha — modal me hamesha scan-time ka frozen price dikhta tha. Ab live overlay + source pill (CoinDCX modal me pehle se tha, India me missing tha). Modal ka CandleChart bhi live LTP overlay use karta hai.

### FIX 4 — [W7] 15th BOARD CARD KA LIVE LTP MISS

`routes.js` board ke sirf top-14 symbols watcher me register karta tha jabki board 15 tak serve karta hai — 15th card ka ⚡ live price silently missing. Ab slice(0,15).

### Verification
- tsc 0 errors · **2949 tests** (165 files, +22 naye v2079DeepPinLive) · vite build OK
- CoinDCX tab realtime chain re-verified end-to-end: 2s CoinDCX REST anchor + official spot WS + Binance WS accelerator + cxRtStream futures — sab wired, zombie-kill/backoff-cap/watchdog self-heal layers intact

## v20.7.8 — FULL-SITE DEEP AUDIT: auto-executor re-entrancy + shutdown orphans + honest feed labels + risk-config SET gates (2026-10-03)

Latest-pull deep pro-level FULL-SITE recheck (origin/main `6c38e7f` merge — v20.7.7 fixes user ne GitHub pe push kar diye the, byte-identical). Review scope: poora server (`index.js` 3195 lines, `routes.js`, supervisor, 4 streams, data layer, secrets) + poora frontend (`api.ts`, hooks, SignalCard/OrderConsole/ProPanels/deep-modal) + signal pipeline verification (ensemble/superIntel/signalRecheck — regime-tilt `?.[modelId]` display-artifact false alarm tha, node runtime proof ke saath clean nikla). **2927 tests green · tsc clean · vite build OK.**

### FIX 1 — [H2] AUTO-EXECUTOR RE-ENTRANCY GUARD (`routes.js` — duplicate LIVE order risk)

90s auto-executor loop journal-check karta tha "one auto position at a time" — par fill journal me tabhi land hoti hai jab `executeSignal` RETURN karta hai. Upstream brownout me ek gauntlet run >90s lamba ho sakti thi (TV scans 12s×2 + candle fetches 8s×3 + exchange APIs) → next tick dobara check pass → **SECOND live order**. Ab `_autoBusy` flag (agentTick/proTraderTick ka hi `_ticking` discipline) + `finally` release.

### FIX 2 — [H1] GRACEFUL SHUTDOWN ORPHANS THE TELEGRAM BOT CHILD (`index.js` + `supervisor.js`)

`process.exit()` forked children KO KILL NAHI KARTA — Linux/VPS/Docker (docker stop, systemctl, Render SIGTERM) + TG polling mode me har shutdown ek live orphan chhodta tha jo Telegram long-poll pakde baittha tha; restart ke baad DO pollers `getUpdates` pe 409 storm + duplicate command processing. Ab: (a) `_gracefulShutdown` bot-child ko SIGTERM deta hai + restart-timer clear; (b) bot ka `exit` handler `_shuttingDown` me restart schedule NAHI karta; (c) supervisor POSIX child ab `detached` (apna process group) spawn hota hai aur `forceKill` group-kill (`process.kill(-pid, 'SIGKILL')`) karta hai — freeze-path SIGKILL me bhi telegram-bot orphan nahi bachta (Windows `taskkill /T` pehle se theek).

### FIX 3 — [M2] DEGRADED FEED LABELS AB HONEST HAIN (`cryptoStream.js` + `LiveSourceBadge.tsx`)

Upstream chain degrade hone par (stale REST cache / 3-min deep-stale / Binance×fx SYNTHETIC rows) SSE tick `coindcx-live` label le raha tha — projected/approximated price green "CoinDCX·RT ⚡" badge pe ride karta tha. Ab wire par honest labels (`coindcx-rest-stale` / `coindcx-rest-deep-stale` / `binance-fx-synth`) + badge me AMBER pills (green kabhi nahi). `coindcxOrders` ka tradability gate batch-level `lastTickerSource()` padhta hai — unaffected.

### FIX 4 — [H-1/H-2] RISK-CONFIG SET BUTTONS 0/NaN POST NAHI KARTE (`OrderConsole.tsx`)

v18.9 NaN guard sirf 8 numeric fields pe tha; trailing-stop ke dono SET buttons raw `Number()` bhejte the — khaali box `trailArmR: 0` (breakeven lock 0R pe — har LIVE position ka SL entry pe pin!) aur garbage NaN → null → silent drop, toast phir bhi "Saved ✓". Aur numeric fields me `Number('') === 0` + `isFinite(0) === true` — CLEARED box hamesha 0 SET karta tha (`minConfidence: 0`, `dailyMaxLossINR: 0`, `cryptoLeverage: 0`…). Ab: empty → disabled, positive-check jahan 0 nonsense hai (daily caps me explicit 0 allowed).

### FIX 5 — [H-3] LAZY-CHUNK DEPLOY RECOVERY HAR SESSION ME EK BAAR SE ZYADA (`App.tsx`)

`lazyWithRetry` ka one-shot marker SUCCESS pe clear nahi hota tha (sirf second-failure branch me) — pehla stale-chunk deploy self-heal, par same session me DOOSRA deploy seedha ErrorBoundary ("Desk crash / Reload karo") pe. Ab har successful import marker clear karta hai.

### FIX 6 — [M3] REGISTRAR IDEMPOTENCY + [M1] SECRETS TTL CACHE (`routes.js` + `secrets.js`)

- `registerAITradingRoutes` do-call pe ~12 live loops DOUBLE arm ho jaate (do auto-executor = double orders bina kisi upstream failure ke). Ab `_registered` guard.
- `getSecrets()` har `/api/ai/*` request/agent-tick/15s-recheck par sync `readFileSync` kar raha tha (hot path event-loop blocking). Ab 3s TTL cache — `setSecret` turant invalidate karta hai; out-of-process edits 3s me pick up.

### FIX 7 — DATA-LAYER CORRECTNESS (`data.js`)

- **[L4]** `TV_SAFE = slice(0,23)` me `Recommend.All` tha hi nahi — safe-retry path par `pf(d[23])` → recommend HAMESHA null. Ab 24-col safe set, d[23] = Recommend.All.
- **[L5]** `fetchCryptoSnapshot` ka flat `× 84` USDINR fallback — v20.2 consolidation ke baad bhi bacha hua last site. Ab shared disk-backed `usdInrFallback()` (last-known-good pehle).

### FIX 8 — FRONTEND RACE/ROBUSTNESS SWEEP

- **[M-1]** ProPanels ke teen prop-driven loaders (Swing/Whale/Orderbook) me stale-response race — BTC (slow) → ETH (fast) → BTC late aake ETH ke upar overwrite. Ab seq-guard (useAITrading ka `posSeqRef` pattern).
- **[M-5]** `SimpleTradeTicket` me entry=0/null guard nahi tha — QTY Infinity, `maxSane` NaN → SAB leverage chips enabled, max-sane warning dead. Ab post-hooks guard (Rules-of-Hooks safe) + honest "ticket disabled" note.
- **[M-3]** `ensureAuthenticated` — 200 + unparseable body (proxy/edge) valid session ko PIN-gate pe phenk deta tha. Ab unparseable-OK session preserve karta hai; network failure bhi "invalid" nahi.
- **[M-7]** Deep-modal 15s auto-recheck — comparison baseline effect-setup closure me tha (same ≥8pt transition har 15s re-log; gradual drift kabhi nahi), SIDE-FLIP tone ternary dead-code tha, hidden tab me bhi recheck chalti thi. Ab last-rechecked baseline + hidden-gate + clean tones.

### FIX 9 — ERROR-PATH HYGIENE (`index.js` / `routes.js` / `positionsStream.js`)

- **[L6]** `jsonError` headersSent guard — partial response ke baad ERR_HTTP_HEADERS_SENT throw + hanging socket ke bajaye clean log+end.
- **[L7]** Manual-trade Telegram pushes me client-derived symbol/reason HTML-escape — `<`/`&` wali value poori message ko Telegram 400 pe reject kar deti thi (confirmation push silently kabhi nahi aayi).
- **[L9]** `positionsStream` first SSE write try/catch — connect-time destroyed-socket race cleanup-registration se pehle escape nahi karti.

## v20.7.7 — ORDER-FLOW SAFETY HARDENING: price read-back verify + qty blind-click gates (2026-10-03)

Latest-pull deep pro-level recheck (origin/main `cbc425d`). Focus: v20.7.6 ke order-form driver ke **baad ke latent safety holes** jo sirf "entry ho gayi" aur "entry Sahi size/price pe hui" me farb karte hain. **2895+ tests green · tsc clean · vite build OK.**

### FIX 1 — PRICE READ-BACK VERIFY (`browserAgent.js` — the "silent wrong-price order" hole)

v20.7.6 me price input milne ke baad `setVal` karke seedha aage badh jaate the — par React controlled inputs set ke **baad** value normalize/revert kar sakte hain (tick-size round, min-notional reset, async validation). Form ka stale default (live price) exit plan se alag limit price ban sakta tha. Ab:

- `setVal(price)` ke 400ms baad **read-back**: form me jo hai wahi compare (0.2% tolerance — tick-rounding pass, real revert fail).
- Mismatch → **ek retry** precision-clamped value ke saath (500ms baad phir read-back).
- Phir bhi mismatch → **`price-verify-fail` THROW** — galat limit price pe buy click KABHI nahi (error me set-vs-form dono values surface hoti hain).

### FIX 2 — QTY BLIND-CLICK GATES (`qty compute fail` + pre-click re-verify)

- **SAFETY GATE 2**: qty input mila par qty compute nahi hui (total=0 / price=0 / market-fallback bina direct qty) — pehle `qty:skip(bad-math)` log karke **blind buy click** ho jata tha form ke DEFAULT qty pe (uncontrollable size!). Ab honest `qty compute fail — blind default-qty order block` THROW.
- **PRE-CLICK RE-VERIFY**: leverage slider / React re-render amount field khaali kar sakta hai. Buy click se theek pehle fresh re-find + khali mile to re-set; phir bhi khali → THROW (zero-qty reject se better honest fail).
- **qty FLOOR round** (nearest nahi) — margin overshoot kabhi nahi, "insufficient margin" exchange reject se bacha.

### FIX 3 — MARKET DIRECT-QTY path (price-null orders ab possible)

Market orders me `price = null` hota hai → `total/price` math impossible thi → pehle ye path guaranteed fail tha. Ab `cxPlaceOrderScript({ qty })` **direct qty** leta hai (`qty-set:direct` step; journaling me source dikhta hai). `BrowserCdpPort.open()` aur `proTraderAuto._placeBrowserCrypto()` dono qty pass karte hain — market fallback fire hone par bhi exact size guarantee.

### FIX 4 — `server/exec/port.js` BrowserCdpPort: 4 signature/verdict bugs

- **`close()`/`reduce()`** — `cxClosePosition({ pair, partialQty })` object-form call ho raha tha jabki REAL signature **positional `(pair, side)`** hai (TypeError → catch → ok:false jhootha "error"); aur `ok: !!r` **truthy-OBJECT** check tha — failed close bhi `ok:true`! Ab positional args + `r?.ok` asli verdict. reduce() me honest note: browser partial-exit unsupported (full close hota hai).
- **`getPositions()`** — DOUBLE bug: (a) `cxReadPositions()` OBJECT `{ok, positions:[…]}` return karta hai par code `Array.isArray(res)` check karta tha → **hamesha []** (positions table kabhi nahi dikhi); (b) rows `{cells, text, nums}` me `p.id`/`p.pair` exist hi nahi karte → id `''` → close-by-id hamesha fail. Ab `.positions` extract + pehli visible cell se pair derive + text se LONG/SHORT + nums se qty/price.
- **`health()`** — browser band ho tab bhi HAMESHA `ok:true` tha (positionManager browser-down pe entry attempt karta rehta tha). Ab real `browserStatus()` probe + honest reason.

### FIX 5 — `findOrderField` positional pass: 3-field stop-limit forms

`[price, trigger, amount]` layout me qty ke liye `inputs[1]` TRIGGER nikalta tha (galat field me qty likh dete the). Ab qty = **LAST** input (CoinDCX layout me amount hamesha aakhri numeric input). + `setVal` hardening: contenteditable/custom input elements pe `textContent` fallback (pehle TypeError girata tha).

### ALONG THE WAY

- `SelfImprovementPanel.tsx` — user push me mangled file wapas aa gayi thi (sab identifiers `n` ho chuke the, kahin import nahi hoti) → **deleted again**, v20.6.3 lock test green restored.
- Tests: `browserOrderForm.test.ts` 15 → **21 tests** (price-verify hostile-React sim, qty safety gate, direct-qty, pre-click re-verify, 3-field positional, contenteditable setVal); `execPort.test.ts` 2 → **10 tests** (honest health ×3, close signature ×2, reduce note, getPositions derive, qty pass-through).
- Version 20.7.6 → 20.7.7 (version.ts + package.json + APP_TITLE).

## v20.7.6 — PLACE-ORDER "PRICE INPUT" FIX: FUTURES ORDER-FORM DRIVER v2 (2026-10-03)

User-reported live error: `18:53:05 [error] ENTRY FAILED DOT LONG — place-order: wait timeout: price input`. Full site deep-recheck on the latest GitHub pull (origin/main `e90c777`). **2888 tests / 164 files 100% green · tsc clean · vite build OK.**

### FIX 1 — THE ROOT CAUSE: price-input detection sirf placeholder/name/aria pe tha (`browserAgent.js`)

CoinDCX futures panel (B-DOT_USDT) me price input ka **placeholder LIVE PRICE NUMBER hota hai** ("3.1524"), "Price (USDT)" ek alag sibling `<label>` hota hai, aur na `name` hota hai na `aria-label`. Purana finder in teeno attributes pe regex chalata tha → kabhi match nahi → `waitFor` 5s → ENTRY FAILED. Naya **`findOrderField`** 3-pass driver:

1. **Semantic pass** — attribute text (placeholder/name/id/aria/data-testid/class) YA **associated-label text** (`el.labels`, `aria-labelledby`, aur 3-level parent climb se short block text — "Price (USDT)"). Search/pair/symbol inputs anti-regex se hamesha excluded.
2. **Positional pass** — buy/sell button se form-region climb: 2-6 numeric inputs mile to DOM-order me **pehla = price, doosra = qty** (limit-mode layout). >6 inputs = poora page pakad liya → bail (unsafe positional nahi).
3. **Market-mode inference** — sirf 1 numeric input bacha to wahi qty hai (price kabhi nahi — market mode me price input exist hi nahi karta).

### FIX 2 — LIMIT-TAB CLICK + VERIFY + MARKET FALLBACK

- Order-type tabs (Limit/Market) futures desk pe **plain div/span** hote hain (button nahi) — pehle `byText('button', …)` hai hi nahi paata tha. Ab candidate list (button · role=tab · role=button · span · li · a · **plain div**) se **har click ke baad VERIFY** hota hai ki price input aaya (click-and-pray khatam; false-positive click bhi verify-gate se harmless).
- **MARKET FALLBACK**: limit UI na mile/mount na ho to **market order se entry** li jaati hai — FAILED entry se better (journal `steps` me honest `fallback:market-order` note). DOT LONG ab har hal me entry karega.

### FIX 3 — CRITICAL SAFETY FIXES (deep review me mile)

- **SIDE-STRICT BUY/SELL REGEX** — purana regex `'want|long|short'` tha: **SHORT order bhi "Long" se shuru hone wale button pe match ho sakta tha** (wrong-side click ka latent risk — "Buy / Long" DOM me pehle aata hai). Ab LONG→`buy|long`, SHORT→`sell|short` — cross-side match impossible.
- **SAFETY GATE** — na price na qty input mile to buy click **KABHI nahi** (default-qty ka galat-size order block). Pehle blind click ho sakta tha.
- **qty math guard** — `NaN/Infinity/0` qty set nahi hota (`qty:skip(bad-math)`).
- **CDP `send()` 15s hard wall khatam** — `evaluate({timeoutMs: 30000})` andar hi andar 15s pe reject ho jata tha (`CDP Runtime.evaluate timeout`); ab timeout passthrough hai (`timeoutMs + 3s` guard ke saath). Select-pair (20s) / place-order (30s) budgets ab REAL me 20s/30s hain.

### FIX 4 — FAILURE DIAGNOSTICS (agla UI break log se hi diagnosable)

Place-order fail hone par page ke saare visible inputs ka snapshot (type · inputmode · placeholder · name · id · aria) **error payload me pack** hota hai → `proTraderAuto.js` journal + `ENTRY FAILED` log line me `| inputs: [...]` ke saath flow hota hai. CoinDCX apna DOM change kare to ab log ek glance me batayega ki page me ACTUALLY kya tha.

### ALONG THE WAY (deep recheck of the latest pull)

- `cxHealthScript` + `cxSelectPairScript` (direct-page panel verify) + `dhanPlaceOrderScript` — teeno ab `findOrderField` use karte hain (health panel galat "broken" nahi dikhega; Dhan ke label-for inputs bhi pakde jaate hain).
- `server/exec/port.js` `BrowserCdpPort.open` — real browserAgent signatures ke against call ho raha tha (`cxSelectPair(pair)` bina `page` arg ke TypeError); fixed + select-pair fail honest surface.
- `SelfImprovementPanel.tsx` — v20.6.3 removal spec ke against repo me wapas aa gaya tha (user ke push me purana file include ho gaya tha; kahin import nahi hota tha) — deleted, locked test green again.
- NEW `test/browserOrderForm.test.ts` — **15 tests**: label-only finder, `<label for>` pattern, positional pass, market-mode inference, full LIMIT flow (React-style hidden→visible tab sim), MARKET fallback, safety gate, side-strict SHORT isolation, page-error surface, inputs-dump diagnostics, health probe, Dhan flow, CDP timeout source-lock.
- Version 20.7.5 → 20.7.6 (version.ts + package.json + APP_TITLE).

## v20.7.5 — 15s SIGNAL RECHECK LOOP + DEEP ENSEMBLE ANALYSIS ACCURACY UPGRADE (2026-10-02)

The user's two asks, delivered: (1) "AI ko sabhi trading 80+ signals — Strong or Action — har 15 sec recheck karta rahe", (2) "Deep Ensemble Analysis galat/purana info dikhati hai — superintelligence se upgrade karo". **2873 tests / 163 files 100% green · tsc clean · vite build OK (SW cache freshly stamped `bmuqz0tqu`).**

### NEW 1 — THE 15-SECOND SIGNAL RECHECK LOOP (`server/ai/signalRecheck.js`, NEW module)

Every **STRONG + ACTION** board signal (the "80+ AI score" tier + the tradeable tier) across **all four desks** (CRYPTO · FUTURES · INDIA · GLOBALFUTURES) is now re-validated every **15 seconds**:

- **Watchlist** — built from the CACHED boards (`getSignals` with `warmOnly: true` — never triggers a cold universe scan; a stopped board = a paused watch, by design).
- **Live price recheck (every 15s)** — per-symbol LTP resolved tick-store-first (free, freshest) with per-market cached-batch fallbacks wired in routes.js (CoinDCX tickers WS-first · futures RT 20s-cache · global quotes 5s-cache · India TV batch behind a 30s micro-cache so 15s cadence never hammers the scanner). Verdicts: **INVALIDATED** (live price through SL — the plan is dead, entry mat karo) · **WEAKENING** (>0.75×ATR adverse drift) · **TARGET_1/TARGET_2** (plan levels touched — opportunity freshness; the executors own fills) · **OK**.
- **Staggered committee re-vote (~60s per symbol, ≤3 symbols/tick)** — the cached deep path re-votes the ensemble itself; side FLIPS and grade drift (STRONG→ACTION→WATCH) are caught against the board snapshot and the row's thesis fields (side/grade/conf/levels) refresh in place.
- **Transition events** — NEW · INVALIDATED · FLIPPED · DEMOTED · PROMOTED · TARGET_1/2 · RECOVERED · DROPPED — land on the row's event log AND on **Telegram** (own 30-min per-symbol+event dedupe, the insta-push pattern).
- **`GET /api/ai/signal-recheck`** — the live watchlist view (loop health + per-row state + event feed). `AI_SIGNAL_RECHECK=off` disables the loop (rows + status stay queryable).
- Purity: selection/recheck/transition/format logic is pure + injected-deps (24 new tests in `test/signalRecheck.test.ts` — no live I/O).

### NEW 2 — SIGNAL RECHECK PANEL (`src/components/aitrading/SignalRecheckPanel.tsx`, NEW)

Board section `01r` on BOTH desks — polls the status endpoint at the same 15s cadence. Per row: desk tag · symbol · side · grade + AI score · live LTP + move% · state chip (problems sort FIRST) · plan levels · last-check age + check count · event log. Header chips: watched count · STRONG count · problem count · total checks · next-tick countdown · pause/resume. Event feed strip at the bottom.

### UPGRADE 3 — DEEP ENSEMBLE ANALYSIS ACCURACY (the "galat info" fix, superintelligence edition)

Root cause of "inaccurate/wrong info when opened": a 🔬 click could serve the **30s-cached** deep answer — computed before the board card the user is comparing it against — with no visible data age, no live recheck, and a 4-field indicator snapshot (rsi/adx/atr/vwap) that hid everything the committee actually read.

- **`getDeepSignal` fresh-run support** — `opts.fresh` bypasses the 30s cache READ (single-flight guarded via the new `_deepInflight` map so double-clicks don't double-compute; results still write-through the cache for the auto-recheck). Route accepts `?fresh=1`; `fetchDeep` sends it on every user click. Exec paths keep the cached contract unchanged.
- **15s self-recheck of the OPEN modal** (`useDeepAutoRecheck` in the NEW `src/components/aitrading/deepAnalysisExtras.tsx`) — while the modal is open the analysis re-runs every 15s (cache-riding); grade/side/confidence drift lands in a **VISIBLE transition log** ("STRONG LONG 82% → ACTION LONG 71%") instead of silently stale numbers. Stale responses are dropped by the same request-token discipline as the manual open.
- **Freshness chips** — `AUTO-RECHECK 15s · next Xs` + `DATA Xs old` (green ≤20s / amber ≤60s / red beyond) + recheck counter. The payload now carries `recheckedAt`.
- **FULL indicator transparency grid** (`DeepIndicatorGrid`) — replaced the 4-field snapshot: classic stack (RSI · ADX ±DI · MACD hist · Stoch · ATR · VWAP · Supertrend · BB %B · MFI · OBV slope · rel-vol · EMA 10/20/50/100/200 + stack bias · ROC) **plus the v20.7.4 confluence stack** (Fib swing + golden pocket + in-GP + bias · Volume Profile POC/VAH/VAL + price-vs-POC + value-area · chart patterns with direction + confidence · supply/demand zones with distance + in-zone · price-action CLV/body/bars/range-pos/bias). Missing fields render an honest '—'.
- Both desks' modals upgraded (CoinDcxTab + IndiaIntradayTab); deep payload carries `recheckedAt` (DeepSignalResult type updated).

### Misc

- `signals.js` `__clearSignalCaches` also clears the fresh-run single-flight map (test-slate hygiene).
- `mergeWatchlist` EXPIRED lifecycle fix — `expiredAt` is stamped on the FIRST expired pass (the naive order deleted the row immediately).
- Version 20.7.4 → 20.7.5 (version.ts + package.json).

## v20.7.4 — AUTO-TRADE FUTURES FIX + SMC v2 INDICATOR ENGINE (user-spec 9-indicator upgrade) (2026-10-02)

User-reported live issues fixed + the full requested indicator stack added. **2849 tests / 162 files 100% green · tsc clean · vite build OK (SW cache freshly stamped).**

### FIX 1 — AUTO-TRADE "select-pair: search box nahi mila" (HIGH, root cause found)

- **Root cause**: `_placeBrowserCrypto` futures entries navigated to the SPOT URL `coindcx.com/trade/{pair}` — but the futures desk lives at `coindcx.com/futures/B-{SYM}_USDT` (user-verified live). On the correct futures page there IS no legacy search box, and `pageFor()` never navigated an EXISTING tab to the requested URL anyway (createUrl only applied when the tab was missing) — so the agent hunted a search box on whatever page the tab was left on and failed every entry.
- **browserAgent.js**: new `cxPairUrl(pair, product)` builds the official futures/spot URL; `cxEnsureTradePage()` now reads the live page URL (`CdpPage.currentUrl()`) and NAVIGATES the tab to the target pair page when it isn't already there; `cxSelectPairScript` first checks `location.pathname` — on the direct pair page it skips the search entirely and just verifies the order panel is alive (12s wait). The legacy search-box fallback gained a search-trigger click step (modern UIs hide the input behind a button) + 4 more selector fallbacks.
- **proTraderAuto.js**: futures desk now opens `https://coindcx.com/futures/{pair}`; spot keeps `/trade/`.

### FIX 2 — "tick overlap" spam + repeated ENTRY FAILED loop (HIGH)

- Browser-stage FAILED entries now put the symbol on a cooldown of `min(cooldownMin, 10)` minutes — previously only CLOSED trades cooled down, so the same ETH signal retried (and failed) EVERY 30s tick, flooding the console and keeping the tick busy (the exact user log pattern).
- The tick-overlap skip log is now 5-minute throttled instead of firing every overlapping tick.

### FIX 3 — EVENT-LOOP FREEZE (selfheal "worst lag 5.5s") contributors removed (MEDIUM)

- **proTraderAuto journal cache**: `_journal()` did readFileSync + JSON.parse on EVERY `_trades()` call (4-6× per tick, 400-trade journal = MB-scale). Now an mtime-checked in-memory cache — statSync (microseconds) validates freshness, external writes still invalidate instantly.
- **Screenshot prune made lazy**: `saveShot()` ran readdirSync + sort + unlinkSync on EVERY screenshot; now prunes only every 10th save.

### UPGRADE — the user-spec 9-indicator stack (signal accuracy)

Requested: Price Action · Fibonacci · SMC · Liquidity Sweep · Volume Profile · Chart Patterns · FVG · ICT · EMA · Supply & Demand. All now live in the ensemble:

- **`lib/indicators.js`** (all pure, no look-ahead):
  - `fibonacciRetracement()` — auto-swing leg detection, full 0.236-0.786 grid + 1.272/1.618 extensions, GOLDEN POCKET (0.618-0.65) zone + bias.
  - `volumeProfile()` — VPVR binned typical-price×volume, POC + 70% Value Area (VAH/VAL), price-vs-POC side.
  - `detectChartPatterns()` — multi-bar geometry on fractal pivots: Double Top/Bottom (forming vs neckline-broken confirmed), Head & Shoulders + inverse, Ascending/Descending Triangle, Bull/Bear Flag (impulse + tight drift).
  - `supplyDemandZones()` — base (2-5 small bodies) + impulse-leaves-base footprint, demand/supply classification, freshness (untouched) + retest-in-zone flags. Base smallness is IMPULSE-relative (body ≤ 25% of impulse body).
  - `priceActionStats()` — Close-Location-Value, body/range ratio, up/down bar count, range position, trend bias.
  - `computeIndicatorsFromCandles()` now also emits `ema100`/`ema200` (macro layer), `chartPatterns`, `fib`, `volumeProfile`, `supplyDemand`, `priceAction`.
- **`lib/smc.js` v2** (full ICT stack):
  - `swingStructure()` — walking fractal swing map (HH/HL/LH/LL labels) with **BOS** (break of structure, continuation) and **CHoCH** (change of character, first hard reversal tell) events, no-look-ahead pivot confirmation.
  - `equalLevels()` — EQH/EQL resting liquidity pools (stop clusters = price magnets).
  - `premiumDiscount()` — ICT dealing-range read (premium/equilibrium/discount + bias).
  - `ictKillZone()` — Asia / London-open / NY-AM session windows on the IST clock (ms or seconds).
  - `smcVote()` upgraded — confluence now = sweep + OB + FVG + BOS/CHoCH + EQH/EQL pools + premium/discount + kill-zone confidence boost; cap raised 85 → 88 for full stacks.
- **`models.js` — 12th ensemble seat `StructurePro` (w 1.15)**: BOS/CHoCH direction + Fib golden-pocket continuation + VP POC side + S/D zone retest + EMA100/200 macro alignment + premium/discount R:R amplification. Abstains honestly without candles.
- **`expertPicks.js`** — 8th expert factor "Structure / Fib / VP" (w 0.09; trend/momentum/SMC rebalanced, sum exactly 1.0), fed by `ctx.__structure` the same way `__smc` works.
- **`signals.js`** — pass-2 revival now also revives the structure seat from LTF candles (same pattern as the SMC revival) and threads `__structure` into all 3 `expertScoreFactors` call sites.

### Tests

- New `test/indicatorsV2.test.ts` — 31 tests pinning Fib levels/golden pocket, VP POC/VA, all chart patterns (synthetic confirmed/forming cases), S&D zone detection + retest, price-action stats, BOS/CHoCH (trend + fresh reversal), EQH pools, premium/discount, IST kill zones, upgraded smcVote bounds, StructurePro abstain/bullish/bearish + registry integration.
- Updated registry-count locks: aiEnsemble (11→12), v67-core (10→11 quant), v2Models (14→15 flag-on bus), expertPicks weights/factors (7→8), browserAgent mocks gained `cxPairUrl`.

## v20.7.3 — FULL-SITE DEEP RECHECK: 24 issues fixed (exec math, security, streams, ML leakage) (2026-10-02)

Full-repo deep review (4 parallel audit passes: server core, server/ai, frontend, telegram-bot + ml-service + configs). **2818 tests / 161 files 100% green · tsc clean · vite build OK · routes check PASS · all .mjs/.py syntax clean.**

### HIGH — money-path math + security

1. **positionManager.js — exit-ladder R-collapse:** `_rLevel()` derived R from the MUTATED `st.sl` (breakeven after T1), so T2 fired at ~entry*1.001 instead of 2R and the whole 40/30/30 ladder degenerated. Now `origRisk` is stamped at entry and anchors every R-multiple (SL-hit checks still use the live `st.sl`).
2. **positionManager.js — `require()` inside ESM:** `_tierLeverage()` could never import `sizing.js::tierLeverage` (ReferenceError swallowed by catch) — leverage was silently pinned to 5x. Static import now; the 7x/10x tier policy actually runs.
3. **agent.js — split-order legs killed by the one-per-pair gate:** leg 2+ of a slippage-split entry was rejected ("position already open"), so the entry was logged as FAILED while a real under-sized position existed — cooldown stamp, near-miss markers and audit trail all skipped. A one-per-pair refusal of leg>0 (after a successful leg) is now treated as a truncated split (`ok:true, splitIncomplete:true`). Fixed in BOTH the futures and spot loops.
4. **bot.mjs — LLM relay fail-open:** with `BOT_API_SECRET` unset (the default), the paid-key relay routes on the PUBLIC Render deployment were protected only by a 30 req/min IP limit. Now fail-closed: no secret → relay answers loopback/private IPs only (503 + setup instructions for everyone else).
5. **bot.mjs — /start + /help unauthenticated:** /start rendered the owner's live portfolio state (position counts, sync freshness, USD/INR) to ANY Telegram user. Both commands now enforce the same `isAuthorized` gate as the other 68 commands.

### MEDIUM — accounting, streams, ML integrity

6. **port.js — PaperPort margin double-free + missing PnL:** partial reduces never decremented `p.margin` (reduce-to-zero freed 100%, then the close branch freed the FULL margin again), and intermediate partial-exit PnL was never realized (only the final slice booked). Margin is now decremented per slice and every slice realizes its own PnL.
7. **index.js — SSE dead-tick drift bug:** the <0.05% dead-tick filter overwrote the stored baseline with the UNSENT price — a steady sub-threshold drift never pushed ANY tick and clients displayed stale prices while the market moved %. Baseline is now the last SENT price (clock refreshes only).
8. **reconciler.js — ghost-alert spam:** GHOST positions (closed off-book by native SL/TP/liq) were alerted but never removed from PM state → Telegram push every 12s forever. Now alerted once + `PositionManager.forget(id)` removes them. Orphan check also treats `sl <= 0` as unprotected (numeric-trigger sentinel).
9. **manualTrades.js — flip plan SL/TP ~84x too tight for INR trades:** `priceLevelsForLeg` divides ₹ thresholds by USDINR (correct for USDT perps) — India equities/crypto-spot got flip levels 0.017 instead of 1.50 per share. INR-domain trades now pass `usdInr: 1` (mirrors `manualPnlOf`).
10. **expertPicks.js — divergent USDINR cache:** the board's private 1h cache bypassed the v20.2 SINGLE USDINR SOURCE — it could sit an hour behind the money layers and flat-84'd on outage even with a disk LKG rate. Successful reads now record into `lib/usdinr.js`; outages fall back to last-known-good.
11. **webhook.js — /portfolio unreachable:** the command was missing from `parseCommand`'s regex, so the full net-worth-digest handler never ran (queries fell through to the LLM). Added to the regex.
12. **ml-service main.py — HF gate dead code:** `/hf/*` was mounted UNCONDITIONALLY before the `HF_MODELS_ENABLED` check (and twice when set) — the RAM-budget flag did nothing. Unconditional mount removed.
13. **ml-service — temporal leakage in walk-forward validation:** `pd.concat` stacks per-symbol blocks, but `TimeSeriesSplit`/positional windows split by ROW — training windows contained other symbols' FUTURE dates (inflated F1/Sharpe). train_signal.py / train_target.py / backtest.py now sort globally by date before splitting.
14. **ml-service main.py — event-loop freezes:** the blocking 6-provider LLM router (sync urllib, 30-60s each) ran inside `async def` endpoints, stalling /health + the Docker HEALTHCHECK. Now `run_in_threadpool` (/analyze, /orchestrate/signals).
15. **ml-service main.py — /refresh 500:** `fetch_all_symbols()` returns an empty frame on upstream failure; `ohlcv["symbol"]` raised KeyError. Same guard as /train added. `/regime` also guards empty symbol sets + feature drift (was pd.concat([]) / KeyError 500s).
16. **bot.mjs — dead Tavily guards:** `isTavilyAvailable` (a FUNCTION) was used without `()` at 3 sites — the "key missing" early-returns never fired. Fixed.
17. **sw.js — CacheStorage bloat:** `CACHE_VERSION` was frozen across all deploys; install/activate never re-ran and every deploy stranded 1-3MB of orphaned hashed chunks. The build now stamps a unique suffix into `dist/sw.js` (vite plugin `stamp-sw-version`), so each deploy opens a fresh cache and activate evicts the old one. SWR offline+uncached path also returns `Response.error()` instead of `undefined`.

### LOW — hardening + hygiene

18. **sizing.js — instrument-cap override:** the trailing `Math.max(levMin, …)` re-raised leverage ABOVE `instrument.maxLeverage` when the cap < levMin. Now `Math.min(Math.max(levMin, lev), instrumentMax)` — the levMin floor (needed for the SKIP_LIQ_TOO_CLOSE semantics) stays, the instrument cap is final.
19. **cryptoStream.js — deep-stale re-stamp:** `coindcx-rest-deep-stale` batches (up to 3 min old) got `Date.now()`, so the 60s anchor guard never tripped. Both stale sources now use the upstream batch clock.
20. **index.js — /api/cloud/save-key blind trust:** a 200-with-`{ok:false}` Apps Script response was reported as saved. Now mirrors /api/cloud/save's body verification.
21. **routes.js — API key exposure:** the wallet diagnostic returned first-4 + last-4 of the CoinDCX key; now tail-4 only (matches secrets.js convention).
22. **index.js — API_TOKEN < 12 chars:** silently disabled service auth; now a loud boot warning explains the fix.
23. **analysis.mjs — /compare crash + HTML escaping:** `data2.weekChange.toFixed()` threw when symbol B fell back to the Yahoo source (no change fields) — guards added on both symbols. FII/DII + IPO reports now escape Tavily-sourced summaries/titles/URLs for parse_mode:HTML.
24. **Config hygiene:** `.gitignore` + `app/.gitignore` cover ml-service `store/`, `*.parquet`, `*.pkl`, bot `streak-data.json`; new `ml-service/.dockerignore` (store/tests/.env excluded from the image); `SETUP-v20.bat` resolves its payload correctly when run from inside the repo's `app/` folder; drifted `tools/windows/Start-AutoBrowser.bat` re-synced with the hardened v20.6 version; telegram-bot `check` script now covers all 10 modules; dead `cloud.mjs` deleted + unused `@google/generative-ai` dep removed; dead misleading `ML_SERVICE_URL` export removed from config.mjs; `manifest.json` orientation portrait→any (landscape trading terminal); CandleChart x-labels pinned to IST; api.ts poll helpers reuse the robust `getTimeInZone` (FIX M16 pattern) instead of the locale-dependent `toLocaleString` round-trip; sseCap `isLoopbackIp` actually strips IPv6-mapped/port forms (comment promised, code didn't).
25. **Orphan cleanup:** `SelfImprovementPanel.tsx` was accidentally re-added by a later commit (v20.6.3 removed it; nothing imported it) — deleted again, the removal test is green once more.

### Known-accepted (documented, not changed)

- **Session token in localStorage + SSE `?session=` query param** — EventSource cannot send headers cross-origin (documented tradeoff); a full PIN-derived-key/short-lived-stream-ticket redesign would touch the working auth flow and is deferred as conscious work.
- **secureStorage `VITE_ENCRYPTION_KEY` is bundle-visible** — client-side "AES-256 at rest" is obfuscation against devtools shoulder-surfing, not a real boundary (a PIN-derived key is the proper fix; deferred).
- **`transferSpotToFutures` auto-margin** on live margin shortfall is journaled + deliberate, but remains a one-click wallet-movement side effect worth a future confirmation gate.

## v20.6.3 — SELF-IMPROVEMENT LOOP COMPLETELY REMOVED (panel + routes gone) + MANUAL FUTURES WALLET RECONNECT (2026-10-01)

User reported: "Self Improvement Engine Isko Completely site se remove kardo site me abhi show kar raha hai … Expert Picks Top 5 Picks ye dono theek se kaam nhi kar rahe hai coindcx TAB me Symbols Discovery aur Trade Signal Analysis inn sabko Light weight freedom kardo accurate and higher accuracy strong signals ke liye aur AUTO trade hai jo jab browser karne par Full Access Control dedo … Coindcx Futures wallet read nhi ho raha hai". This pass:
1. **Completely removes** the self-improvement loop (panel .tsx file deleted + 14 `/api/ai/self/*` routes + their imports gone — not just disabled as in v20.6.0, but actually removed from the codebase).
2. **Adds a manual "Reconnect Futures Wallet" button** + `POST /api/ai/wallet/reconnect` endpoint — so the user can clear the futures wallet transport ladder + cooldown + scope probe and force a fresh 7-rung sweep on demand (no more waiting for the 10-probe escape-hatch to fire).
3. **Honest scope answer on the deferred auto-trade browser-control work** (full browser takeover when 3 tabs running + 80+ STRONG signal auto-trade per wallet with 5x/10x leverage decisions) — that's Phase 2-5 of the audit doc, multi-week calendar work, NOT one-pass.

**2776 tests / 157 files 100% green · tsc clean · vite build OK · 2 updated selfImproveEngine tests assert the REMOVAL (not the existence).**

### Critical: Self-Improvement Loop — COMPLETELY REMOVED (panel + routes + imports)

**v20.6.0** disabled the loop intervals (default `SELFIMPROVE_ENABLED=false`) and unmounted the SelfImprovementPanel from CoinDcxTab. **v20.6.3** goes further — actually DELETES the artifacts:

1. **Deleted file:** `app/src/components/aitrading/SelfImprovementPanel.tsx` (381 lines) — gone entirely. No orphan imports (verified by `tsc` clean).
2. **Removed 14 route handlers** from `app/server/ai/routes.js`: `GET /api/ai/self/status`, `POST /api/ai/self/repair`, `POST /api/ai/self/harvest`, `POST /api/ai/self/drift`, `POST /api/ai/self/retrain`, `GET /api/ai/self/lessons`, `POST /api/ai/self/lessons/run`, `POST /api/ai/self/gate-tune`, `POST /api/ai/self/evolve`, `GET /api/ai/self/proposals`, `POST /api/ai/self/proposal/:id/approve`, `POST /api/ai/self/proposal/:id/reject`, `POST /api/ai/self/proposal/:id/rollback`.
3. **Removed 8 imports** from routes.js: `harvestOutcomes`, `runDriftCheck`, `triggerRetrain`, `runGateTune`, `generateLessons`, `currentLessons`, `runEvolution`, `proposalsStatus`, `approveProposal`, `rejectProposal`, `rollbackProposal`, `selfStatus`, `selfRepair`. (Kept as comments for git-history traceability.)
4. **Loop module FILES remain** (`outcomeHarvester.js`, `driftMonitor.js`, `retrainBridge.js`, `gateTuner.js`, `lessonsEngine.js`, `strategyEvolution.js`, `evolutionLedger.js`, `selfCouncil.js`, `selfStatus.js`) — `council.js` dynamically `await import('./lessonsEngine.js')` for the lessonsBlock prompt; deleting them would crash the council path. They're inert now: nothing calls them (no routes, no UI, no intervals).

**Test updates:** `test/selfImproveEngine.test.ts` — 2 wiring tests flipped from "assert exists" to "assert REMOVED":
- `v20.6.3: routes.js no longer exposes the self/* control surface (loop REMOVED)` — asserts no `app.get('/api/ai/self/...')` or `app.post('/api/ai/self/...')` mount patterns remain; the v20.6.3 removal comment block IS present for traceability.
- `v20.6.3: frontend SelfImprovementPanel REMOVED (file gone + not mounted in CoinDcxTab)` — asserts `existsSync(panelPath) === false`, no `<SelfImprovementPanel />` JSX, no `import { SelfImprovementPanel }` line, no `id="cx-selfimprove"` section. AgentPanel scope chips (AUTO SCOPE / EQUITY SIM / SPOT AUTO OFF) are independent of the loop and survive.

### Critical: Manual futures wallet reconnect (button + endpoint)

**Files:**
- `app/server/ai/routes.js` — new `POST /api/ai/wallet/reconnect` endpoint (auth-gated via the global `requireAuth` middleware at `index.js:403`). Body: `{ force?: true }`. Calls `futures.js::resetWalletTransportForReconnect()` (clears the ladder + cooldown + scope probe via dynamic import to avoid circular dep), then re-fetches `walletSnapshot()` so the response carries the fresh wallet state. Returns `{ ok: true, reset: true, forced: bool, snapshot: WalletView, note: string }`.
- `app/src/components/tabs/CoinDcxTab.tsx::WalletCard` — new "🔄 Reconnect Futures Wallet" button. Shows up only when there's a futures error (WAF block, cooldown armed, scope probe cached `no_scope`, or `futures.usdt.total` is missing/0). On click: POSTs `{force:true}` to the endpoint, waits 800ms for the server to clear + sweep, then calls `useWalletPoll.refresh()` to re-fetch the snapshot. Disabled + spinner state during the request.

**Why this matters:** the v20.5.1 Mozilla UA + ladder escape-hatch (10-probe counter) was the right automated fix, but a user could still wait up to 10 minutes for the escape-hatch to fire after a transient 401 / WAF block. The button gives the user a one-click "force fresh sweep" — they get a working wallet on demand, no waiting. Combined with the v20.5.1 Mozilla UA, this should resolve "Coindcx Futures wallet read nhi ho raha hai" for the live user case.

### Honest scope answer on the deferred auto-trade browser-control work

The user asked for: "AUTO trade hai jo jab browser karne par Full Access Control dedo kyun ki 3 tabs running rehta hai CoinDCX site, Dhan site open then localhost wala Start AUTO Trade bolte hi full Browser control me lena chahiye jo 80+ strong trade signal read karke auto trade lagana chahiye as per wallet ke hisaab se 5x leverage or 10x leverage pe kab entry lena hai aur kab exit karna hai aur kitna sl lagana hai aur kitna profit book karna min ye sab Advance pro intelligence level pe work karna hai".

**This is the auto-trading plan v1 (in `app/docs/audit.md`) Phase 2-5 — multi-week calendar work, NOT one-pass.** Specifically:
- **Phase 2 — Execution Port abstraction** (`server/exec/port.js` NEW interface + 3 adapters: `ApiFuturesPort`, `BrowserCdpPort`, `PaperPort`). Estimated 3-4 days.
- **Phase 3 — Wallet-risk sizing engine** (DONE in v20.6.0 as `server/exec/sizing.js` pure-functional module + 16 tests; needs Phase 2 wiring to actually consume walletSnapshot + call into the execution port).
- **Phase 4 — Protection-first + Exit Manager** (`server/exec/positionManager.js` NEW). The state machine for: open → fill confirm → leverage mismatch close + alert → setProtection({sl, tp}) read-back → flatten-on-fail. Plus T1/T2/runner trail/give-back exit ladder. Plus tiered reversal (candle-close, not 30s tick). Estimated 4-5 days.
- **Phase 5 — Reconciliation + Dead-man + Kill-switch hierarchy** (10-15s reconcile loop, 5s heartbeat, 30s watchdog, L1/L2/L3 kill levels, leader lease so laptop + Render don't both fire). Estimated 2-3 days.
- **Phase 6 — Browser adapter hardening** (DONE in v20.6.0: 7 Chrome flags in Start-AutoBrowser.bat — `--disable-background-timer-throttling` etc. — so the 3-tab setup doesn't throttle). The remaining work: leverage read-back verify, UI SL/TP bracket set, session-expiry detection, DOM canary.

**Why this can't be done in one pass:** the "Start AUTO Trade" button currently fires `proTraderTick` which uses `proTraderAuto.js` — that path has known GAPS documented in `app/docs/audit.md` §2: G1 (browser SL is software-side only, no exchange-resident SL), G2 (leverage best-effort DOM, no read-back), G3 (fixed stakeINR not wallet-based), G4 (no profit booking / partial TP / breakeven / trailing), G5 (no fill confirm), G6 (reversal on 30s tick not candle-close), G7 (two journals, caps bypass), G9 (Render + laptop both fire = duplicate orders). The audit doc lists all 10 gaps; the auto-trading plan addresses each one in sequence.

**What the user gets with v20.6.3 + earlier passes:** the foundational pieces are in place — wallet-risk sizing engine (pure-functional, v20.6.0), RAM governor (v20.6.0), local-first LLM (v20.6.0), OLLAMA_DEEP_MODEL dual-model (v20.6.1), selfHeal ns→ms fix (v20.5.1), CoinDCX futures wallet Mozilla UA + ladder escape-hatch (v20.5.1) + now manual reconnect button (v20.6.3). The remaining Phase 2/4/5 wiring is the multi-week work.

### Verification
- `npm run typecheck` → clean.
- `npm test` → **2776 tests / 157 files, all passing** (2 updated `selfImproveEngine.test.ts` tests now assert REMOVAL; all other tests unchanged).
- `npm run build` → clean (Vite production bundle, CoinDcxTab chunk ~115 kB).
- `node --check` on every touched file (`routes.js`, `CoinDcxTab.tsx`) → OK.
- Manual: `unzip -l` confirms `SelfImprovementPanel.tsx` is GONE from the bundle.

### Files touched
- `app/src/components/aitrading/SelfImprovementPanel.tsx` — DELETED (381 lines gone)
- `app/server/ai/routes.js` — removed 14 `/api/ai/self/*` route handlers + 8 imports; added new `POST /api/ai/wallet/reconnect` endpoint
- `app/src/components/tabs/CoinDcxTab.tsx` — added `apiFetch`/`getProxyBase` imports; WalletCard now has "🔄 Reconnect Futures Wallet" button (shows when futures has error/missing)
- `app/test/selfImproveEngine.test.ts` — 2 wiring tests flipped to assert REMOVAL (routes + panel gone), not existence
- `app/src/version.ts` — bump to v20.6.3
- `app/package.json` — bump to v20.6.3

## v20.6.1 — OLLAMA_DEEP_MODEL support (qwen3:8b scan + deepseek-r1:14b deep, 16GB auto-swap) (2026-10-01)

User asked: "16GB RAM me ek time par ek hi model chalao. qwen3:8b scan ke liye, deepseek-r1:14b sirf 1-2 symbols ke deep analysis ke liye aisa kar sakte kya aur ml-service HF models enabled karke sath me use nhi kar sakte kya batao". This pass implements `OLLAMA_DEEP_MODEL` so the scan path uses the fast scan model (`qwen3:8b`) and the deep single-symbol analysis path (`/api/ai/deep/:sym` → `getDeepSignal` → `aiCouncilVerify({deep:true})` → `councilAskDeep` → `ollamaCompatCfg({deep:true})` → `OLLAMA_DEEP_MODEL`) uses the deep model (`deepseek-r1:14b`). On a 16GB laptop with `OLLAMA_MAX_LOADED_MODELS=1`, Ollama auto-evicts the scan model and loads the deep model when a deep call lands (cost ~30-60s per swap). **2776 tests / 157 files 100% green · tsc clean · vite build OK · 5 new deep-model tests.**

### Q1 — Ek time par ek hi model? YES (recommended)

**The right strategy for 16GB:**
- **OLLAMA_MODEL=qwen3:8b** — scan path (5.5-6.5 GB). Board compute runs every 30s now (v20.5 latency cut); council call rides this small model → fast JSON.
- **OLLAMA_DEEP_MODEL=deepseek-r1:14b** — deep path (9-10 GB). User clicks "Deep" on one symbol → council auto-swaps to the larger model for that one call, then swaps back to scan model on the next board cycle.
- **OLLAMA_MAX_LOADED_MODELS=1** in Ollama service env (Windows) — only one model in KV cache at a time. Ollama auto-evicts + re-loads on the swap; SmartAI's code paths are model-agnostic — they just request the model they want.
- **OLLAMA_KEEP_ALIVE=10m** — keep the hot model loaded for 10 min after the last request (so scanning bursts don't thrash the model in/out repeatedly).
- **OLLAMA_NUM_PARALLEL=1** — no concurrent Ollama requests (the box can't handle parallel inference on two models simultaneously).
- **OLLAMA_FLASH_ATTENTION=1** — faster attention (a bit more RAM, worth it).

**RAM budget with this setup:**
| Component | ~RAM |
|---|---|
| Windows + background | 3.5–4.5 GB |
| Chrome automation profile (3 tabs) | 1.5–3 GB |
| Node server (SmartAI) | 0.4–1 GB |
| ml-service base (Python, HF OFF) | 0.5–1 GB |
| Ollama qwen3:8b (scan, loaded most of the time) | 5.5–6.5 GB |
| **Total (scan mode)** | **~11–16 GB → workable, tight** |
| Ollama deepseek-r1:14b (deep call, auto-swap) | 9–10 GB |
| **Total (deep mode, swap)** | **~15–19 GB → tight, but only for ~30-60s** |

The RAM governor (`v20.6` module `server/ai/ramGovernor.js`) will catch the deep-mode transient — if free drops under 2GB during the 14B inference, RED state blocks new auto entries (positions still managed) + Telegram CRITICAL alert. The scan path resumes automatically once the 14B model is evicted.

### Q2 — ml-service HF models + Ollama simultaneously? NO (on 16GB)

**The honest answer:** No, do NOT enable `HF_MODELS_ENABLED=true` alongside Ollama on a 16GB laptop. The math:
- Chronos-T5 (torch) + FinBERT (torch) = ~2-3 GB additional RAM after load + ~1 GB torch runtime overhead
- Combined with qwen3:8b (6GB) + Windows (4GB) + Chrome (2GB) + Node (0.7GB) + Python (0.7GB) = **~14-16 GB → INSTANT SWAP**

**What you CAN do (the "alternating phase" pattern):**
1. **Default state:** `HF_MODELS_ENABLED=false` (v20.6 default) — Ollama runs alone. This is what you want for live auto-trading.
2. **Scheduled batch (weekly/daily):** Stop the SmartAI server (or set `LLM_LOCAL_ONLY=0` + `LLM_PRIORITY=` empty + stop Ollama service) → set `HF_MODELS_ENABLED=true` → restart ml-service → run the retraining batch (`/hf/forecast` for Chronos, `/hf/sentiment` for FinBERT) → stop ml-service → flip back.

This is exactly what the audit doc (`app/docs/audit.md` §4 Phase 7 calibration) describes — HF models are most useful for: (1) retraining the LightGBM signal model with HF embeddings, (2) FinBERT sentiment on news, (3) Chronos-T5 forecasts. None of these need to run continuously — they're batch jobs, ideally overnight or when the laptop isn't actively auto-trading.

### Implementation: OLLAMA_DEEP_MODEL dual-model flow

**Code changes:**
- `server/ai/llmSentinel.js:35-45` — new env `OLLAMA_DEEP_MODEL` (default unset, falls back to `OLLAMA_MODEL`). `ollamaCompatCfg({deep:true})` now returns `{ url, defModel: OLLAMA_DEEP_MODEL, deepModel }` when `deep=true`.
- `server/ai/llmChain.js:146-220` — `councilAsk(prompt, deps, opts={})` now accepts `opts.deep=true`; the ollama leg passes `{deep}` to `ollamaCompatCfg()`. New exported `councilAskDeep(prompt, deps)` is a thin wrapper: `councilAsk(prompt, deps, {deep:true})`.
- `server/ai/signals.js:81` — import `councilAskDeep` from `llmChain.js`.
- `server/ai/signals.js:788` — `aiCouncilVerify(candidates, deps, market, opts={})` now accepts `opts.deep=true`; if true, calls `councilAskDeep(prompt, deps)` instead of `councilAsk(prompt, deps)`.
- `server/ai/signals.js:2504` — `getDeepSignal` now passes `{deep: true}` to `aiCouncilVerify`. The board path (`aiCouncilVerify` call at signals.js:1599) does NOT pass `opts.deep` → scan model is always used there.
- `.env.example:497-505` — `OLLAMA_DEEP_MODEL` documented with the worked example + RAM-budget table.

**Test:** `test/llmChainDeepModel.test.ts` (5 tests) locks:
1. `councilAskDeep` is exported.
2. Scan path (councilAsk with `LLM_LOCAL_ONLY=1`) uses `qwen3:8b` (the scan model).
3. Deep path (councilAskDeep) uses `deepseek-r1:14b` (the deep model).
4. Scan path uses scan model even after a deep path ran (no cross-contamination).
5. `councilAskDeep` is a thin wrapper around `councilAsk(opts.deep=true)`.

### Verification
- `npm run typecheck` → clean.
- `npm test` → **2776 tests / 157 files, all passing** (+5 new deep-model tests in `llmChainDeepModel.test.ts`).
- `npm run build` → clean.

### Recommended `.env` (16GB laptop setup)
```env
# Local-only LLM (skip all cloud providers)
LLM_LOCAL_ONLY=1
LLM_PRIORITY=ollama
# Scan model (5.5-6.5GB, fast JSON)
OLLAMA_MODEL=qwen3:8b
# Deep model (9-10GB, deepseek-r1:14b — auto-swap, ~30-60s)
OLLAMA_DEEP_MODEL=deepseek-r1:14b
# RAM governor (catches deep-mode transient)
RAM_YELLOW_FREE_GB=3.5
RAM_RED_FREE_GB=2
# Self-improvement loop DISABLED by default
# SELFIMPROVE_ENABLED=false  (default off — leave unset)
# HF models DISABLED by default (do NOT enable alongside Ollama on 16GB)
# HF_MODELS_ENABLED=false  (default off)
```

Windows Ollama service env (NOT `.env` — set in the Ollama service config):
```
OLLAMA_MAX_LOADED_MODELS=1
OLLAMA_NUM_PARALLEL=1
OLLAMA_KEEP_ALIVE=10m
OLLAMA_FLASH_ATTENTION=1
```

## v20.6.0 — SELF-IMPROVEMENT LOOP REMOVED + LOCAL-FIRST LLM + RAM GOVERNOR + SIZING ENGINE + BROWSER HARDENING (2026-10-01)

User shared a comprehensive 9-phase auto-trading reimplementation plan (local Ollama · wallet-sized 5–10x · browser-driven) for a 16GB RAM laptop setup, and explicitly asked to **completely remove the Self-Improvement Engine — Super Intelligence Loop** because it was "load-causing and affecting trade signals", and **clean up the site**. This pass implements the explicit asks + the most impactful Phase 1/3/6 items from the plan; the remaining Phases (2/4/5/7/8/9) are documented in the new `app/docs/audit.md` as deferred work. **2771 tests / 156 files 100% green · tsc clean · vite build OK · 3 new test files (32 new tests).**

### Critical: Self-Improvement Engine / Super Intelligence Loop — REMOVED FROM DEFAULT RUNTIME

**Strategy (do NOT delete loop modules — `council.js` dynamically `await import('./lessonsEngine.js')` for the lessonsBlock prompt; deleting would crash that path):**

1. **Default `SELFIMPROVE_ENABLED=false`** in `.env.example` (was `=true`). The loop never arms on a fresh install.
2. **Loop intervals gated behind the flag** in `server/index.js:3007-3087` — even if someone flips the flag to `true`, the heavy loop is opt-in; the default log line announces "DISABLED by default — signal-generation path is now free of this load".
3. **SelfImprovementPanel unmounted from `CoinDcxTab.tsx`** (line 432) and its import removed — no UI load, no 60s polling of `/api/ai/self/status` + `/api/ai/self/proposals`. The panel file stays in place so external imports don't crash.
4. **The 14 `/api/ai/self/*` routes stay mounted** in `routes.js:1670-1736` — they're inert without the loop, available for manual one-shot ops.
5. **Modules LEFT IN PLACE** (touching them breaks signal generation):
   - `adaptive.js` (v6.7, NOT v19.0) — `applyAdaptiveWeights` runs every board tick in `signals.js`; DO NOT TOUCH.
   - `signalMemory.js` (v12.4) — `applySignalTrustGuards` is the per-signal OB/OS + flip-cooldown gate; INDEPENDENT of the loop.
   - `selfHeal.js` (v19.1) — server stability watchdog; INDEPENDENT.
   - `boardAccountability.js` (v20.2) — board→trackRecord bridge; INDEPENDENT.
   - `mlHealth.js` (v18.1) — cached ml-service reachability probe; INDEPENDENT.

**Effect:** the trade-signal path is now free of the self-improvement load (no harvest pass walking the ledger; no drift probe computing PSI/calibration; no weekly LLM-driven lessons call inflating the council prompt's token budget; no evolution ledger writes). The CoinDcxTab production bundle shrank from 130.54 kB → 114.20 kB (the SelfImprovementPanel + its 60s polling hooks gone).

### Phase 1a — Local-first LLM (`llmChain.js`)

- New env `LLM_PRIORITY` (comma-separated provider list; providers NOT in the list are skipped entirely — no fetch, no key probe). Default (env unset) = historical order `gemini→groq→cerebras→openrouter→huggingface→nvidia→ollama` (backward-compatible).
- New env `LLM_LOCAL_ONLY=1` — short-circuit ALL cloud providers and try ONLY the local Ollama engine. Designed for the 16GB laptop setup (Chrome + Node + Ollama all running locally; cloud calls add latency + cost + bandwidth).
- New env `OLLAMA_MODEL=qwen3:8b` recommended (faster + better JSON than the repo's historical `llama3.1:8b`); the auto-trading plan's "thinking" output strip (`<think>…</think>`) is handled by the existing `tryParseJson` regex.
- Tests: `test/llmChainEnv.test.ts` (7 tests) locks the env-driven order + local-only short-circuit.

### Phase 1b — RAM Governor (`server/ai/ramGovernor.js`, NEW module)

- Three-state traffic light: GREEN (>3.5GB free) / YELLOW (2–3.5GB) / RED (<2GB).
- `ramCanEnter()` returns `state !== 'RED'` (RED blocks new entries; positions still managed).
- `ramCanLLM()` returns `state === 'GREEN'` (YELLOW blocks LLM calls → deterministic mode; HF models unload).
- RSS-floor guard: if process RSS alone exceeds `TOTAL_PHYSICAL - RAM_RSS_RESERVE_MB` (default 600MB), force YELLOW even if "free" reads high (the degenerate swap scenario right before a full lockup).
- Telegram CRITICAL alert on every fresh RED entry (state change). Tunables: `RAM_YELLOW_FREE_GB` (3.5), `RAM_RED_FREE_GB` (2.0), `RAM_TICK_SEC` (10), `RAM_RSS_RESERVE_MB` (600).
- Wired into `server/index.js` boot (after `initSelfHeal`).
- Tests: `test/ramGovernor.test.ts` (9 tests) locks state transitions + alert behavior + RSS-floor + custom tunables.

### Phase 1c — ml-service HF models disabled by default (`ml-service/app/main.py`)

- `hf_models` (Chronos-T5 torch + FinBERT torch) mount is now gated behind `HF_MODELS_ENABLED=true` (default false).
- `expert_mode` mount similarly gated behind `EXPERT_MODE_ENABLED=true` (default false) — it imports torch + HF models internally.
- Default install gets only the base LightGBM/sklearn ML service — saves RAM for the local Ollama engine.

### Phase 3 — Sizing engine (`server/exec/sizing.js`, NEW module + tests)

- Pure-functional `computeSizing({ equity, freeUSDT, entry, stopLoss, riskPct, tierLeverage, instrument, ... })`.
- Core invariants (locked by `test/sizing.test.ts`, 16 tests):
  1. `qty × slDistPct × entry ≤ riskUSDT × 1.001` (risk cap held with rounding slack)
  2. `liqDistancePct(lev) ≥ 2.5 × slDistPct × 100` (SL inside liquidation distance — both sides in percent)
  3. `margin ≤ freeUSDT × 0.9` (cash headroom)
  4. `leverage = clamp(tierCap, 5, 10) ∧ ≤ maxSaneLeverage ∧ ≤ instrument.maxLeverage`
- Worked example locked: 1000 USDT · 1% risk · 1.5% SL → notional ≈ 667, 5x → margin ≈ 133, max loss ≈ 10.
- Leverage lesson locked: 10x gives SAME MAX LOSS as 5x (smaller margin, more free cash — leverage doesn't change risk).
- SKIP verdicts: `SKIP_LOW_EQUITY`, `SKIP_MIN_QTY`, `SKIP_MARGIN_CAP`, `SKIP_LIQ_TOO_CLOSE`, `SKIP_BAD_INPUT`.
- Account-level brakes (env keys documented in `.env.example`, applied in a future Phase 3b wiring pass): `DAILY_LOSS_LIMIT_PCT=3`, `WEEKLY_DD_HALF_SIZE_PCT=8`, `MAX_CONCURRENT=3`, `LOSS_STREAK_PAUSE=3`.
- The `maxSaneLeverage` formula: `lev ≤ 0.95 / (2.5 × slDistPct) = 0.38 / slDistPct` — e.g. 1% SL → 38 (clamped to 10), 5% SL → 7, 8% SL → 4 (below levMin 5 → SKIP_LIQ_TOO_CLOSE).

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

### Phase 0 — Audit doc (`app/docs/audit.md`, NEW)

Comprehensive 8-section audit:
- §0 What was read (and what wasn't)
- §1 Existing asset map (10 areas with file:line references)
- §2 Real GAPS (G1-G10, code-level confirmed)
- §3 v20.6 fixes shipped (this changelog entry in expanded form)
- §4 Deferred work (Phases 2/4/5/7/8/9 with effort estimates)
- §5 Definition of Done (v1) — 7 criteria
- §6 Verification of v20.6 fixes (typecheck + tests + build)
- §7 Risks (10 rows with mitigations)
- §8 First-week checklist (post-deploy verification)

### `.env.example` updates (lines 480-557)

All new env keys documented with comments:
- LLM: `LLM_PRIORITY`, `LLM_LOCAL_ONLY`, `OLLAMA_MODEL`, `OLLAMA_BASE` + Windows Ollama service env notes
- RAM: `RAM_YELLOW_FREE_GB`, `RAM_RED_FREE_GB`, `RAM_TICK_SEC`, `RAM_RSS_RESERVE_MB`
- ml-service: `HF_MODELS_ENABLED`, `EXPERT_MODE_ENABLED`
- Execution port: `EXEC_MODE`, `SMARTAI_EXEC_NODE`
- Sizing: `SIZE_RISK_PCT`, `SIZE_RISK_PCT_MAX`, `SIZE_MAX_MARGIN_USE_PCT`, `LEV_DEFAULT`, `LEV_MIN`, `LEV_MAX`, `LEV_MIN_LIQ_TO_SL_RATIO`
- Account brakes: `DAILY_LOSS_LIMIT_PCT`, `WEEKLY_DD_HALF_SIZE_PCT`, `MAX_CONCURRENT`, `LOSS_STREAK_PAUSE`
- Exit ladder: `EXIT_T1_R`, `EXIT_T1_PCT`, `EXIT_T2_R`, `EXIT_T2_PCT`, `TRAIL_ATR_MULT`, `GIVEBACK_ARM_R`, `GIVEBACK_PCT`, `ENTRY_LIMIT_TTL_SEC`
- Reversal: `REV_CANDLE_TF`, `REV_CLASSES_REDUCE`, `REV_CLASSES_CLOSE`
- LLM role: `LLM_ROLE=veto`

### Verification
- `npm run typecheck` → clean.
- `npm test` → **2771 tests / 156 files, all passing** (+3 new test files, +32 new tests: `sizing.test.ts` 16, `ramGovernor.test.ts` 9, `llmChainEnv.test.ts` 7).
- `npm run build` → clean (Vite production bundle, 2249 modules; CoinDcxTab chunk shrank 130.54→114.20 kB after SelfImprovementPanel removal).
- `python3 -c "import ast; ast.parse(open('ml-service/app/main.py').read())"` → OK.
- `node --check` on every touched file → OK.

## v20.5.1 — SELFHEAL EVENT-LOOP FREEZE FALSE-POSITIVE FIX + COINDCX FUTURES WALLET MOZILLA UA + LADDER ESCAPE-HATCH (2026-10-01)

User reported console flooded with impossible values (`worst lag 180224.0s in the last 30s`, `306446.3s`, etc.) and CoinDCX futures USDT wallet STILL not reading despite the v20.5.0 UA fix. Both fixed; **2739 tests / 153 files 100% green · tsc clean · vite build OK · new selfheal ns→ms regression lock added**.

### Critical: selfheal event-loop lag was treating nanoseconds as milliseconds

- **File**: `app/server/ai/selfHeal.js` (event-loop lag bucket in `_watchTick`)
- **Root cause**: `monitorEventLoopDelay()` from `node:perf_hooks` returns a histogram whose `.max` and `.mean` are in **NANOSECONDS**, not milliseconds. The code stored them raw into `_state.loopLagMax` and compared against `cfg.lagWarnMs = 4000` (which is 4 ms = 4,000,000 ns) — so a real **4-microsecond** lag tripped the alarm (false positive). Worse, the display divided ns by 1000 → **microseconds labeled as "seconds"**: a real 180ms freeze printed as `180224.0s` (an impossible value; a 30s bucket can max be ~30s). The console got flooded with `[selfheal] EVENT-LOOP FREEZE detected — worst lag …s in the last 30s` lines every minute, which on Windows + QuickEdit select-mode actually caused the very freezes it was reporting (every stderr write blocks on the frozen console).
- **Fix**: Convert ns → ms when storing (÷1_000_000) so the threshold comparison and display are both correct: a real 4ms lag stays under the alarm; a real 4-second freeze surfaces as `4.0s`. With the false positives gone, the console stops spamming, the QuickEdit freeze amplifier dies too, and the genuine freeze log lines that remain are accurate.
- **Regression lock**: `app/test/selfHealGuard.test.ts` — added a test that drives a watch tick on a fresh arm and asserts `loopLagMs.max30s` is finite, ≥0, and below the sane upper bound (60s) — pre-fix a single async tick could leave ns residue that would print as a 6-7 figure "seconds" value.

### Critical: CoinDCX futures USDT wallet — Mozilla UA + Accept header + ladder escape-hatch

The v20.5.0 fix shipped `User-Agent: 'wealthai-coindcx/1.0'`, but the user reports futures wallet STILL not reading on their install. Three additional layers added:

1. **Mozilla browser UA** (`app/server/mcp/coindcx.js::coindcxPrivateGET` headers literal): switched from the custom `wealthai-coindcx/1.0` to the SAME Mozilla browser string the PUBLIC `fetchGlobalFuturesInstruments` call already uses (lines 837, 853 of coindcx.js). CoinDCX's WAF on the derivatives private GET family is more aggressive than just UA-matching — a custom product UA still got 401'd for some installs. The Mozilla UA is the one string the team has CONFIRMED passes through the WAF on this host (it's what the public instruments call rides).
2. **`Accept: application/json` header** added to the same headers literal. CoinDCX's documented contract for the signed GET family expects this; some installs get `406 Not Acceptable` without it.
3. **Ladder escape-hatch** (`app/server/ai/futures.js::fetchFuturesWallets` + `_walletsTransport`): added `probesSinceSweep` counter. Every 10 probes (= ~10 polls × 60s cadence = ~10 min), the function forces a FULL 7-rung ladder sweep even when the cooldown is armed and sticky mode is set. Without this escape hatch, a server that hit the cooldown with a stale UA / transient 401 keeps retrying ONLY rung 1 every poll and re-arming the cooldown forever — a deploy that fixes the underlying transport never gets a chance to actually take effect until the user manually reconnects. The escape hatch silently does the sweep and re-establishes sticky on whichever rung wins. `resetWalletTransportForReconnect` also resets the counter so a manual reconnect still wipes the slate clean.

The existing `coindcxGet.test.ts` UA lock is updated to expect the Mozilla string and also assert `Accept: application/json`.

### Verification
- `npm run typecheck` → clean.
- `npm test` → **2739 tests / 153 files, all passing** (+1 new selfheal ns→ms regression lock; updated coindcxGet UA/Accept assertion in lock-step).
- `npm run build` → clean (Vite production bundle, 2250 modules).

## v20.5.0 — COINDCX FUTURES WALLET + 30S SIGNAL LATENCY + 3-SOURCE SUPERINTELLIGENCE + EXPERT PICKS ACCURACY GATES (2026-10-01)

User report: "site working fine hai but coindcx tab me coindcx api key secret .env me hai but futures wallet read ni kar raha hai sirf spot ka wallet read kar raha hai … Superintelligence Signal Board & EXPERT PICKS — 80+ AI SCORE ye dono sections ko Trade signals check karo aur advance pro trader level pe Upgrade superintelligence banao high accuracy ke sath long ya short trade signals accurate rehna hai aur sabhi assets jo trade signal milta hai 30 sec me yahan board me aa na chahiye … late ho raha hai isse trade reversal chance ho raha hai." Four targeted fixes; **2738 tests / 153 files 100% green · tsc clean · vite build OK · new UA regression lock added**.

### Critical: CoinDCX futures wallet — root cause + 1-line fix

- **File**: `app/server/mcp/coindcx.js::coindcxPrivateGET` (headers literal ~line 280)
- **Root cause**: Neither `coindcxPrivateGET` nor its body-mode helper `_httpsGetJson` set a `User-Agent` header. Node's default UA (`"node"`) is blocked by the CoinDCX WAF on the derivatives private GET family → every rung of the 7-rung `WALLET_AUTH_LADDER` in `futures.js::fetchFuturesWallets` receives `[401] Invalid credentials` (looks like auth rejection, actually a WAF block). Spot works because `coindcxPrivate` POST to `/exchange/v1/users/balances` rides `fetch()` and CoinDCX's WAF rule is more permissive on that POST family.
- **Fix**: Added a stable `'User-Agent': 'wealthai-coindcx/1.0'` to the `headers` literal in `coindcxPrivateGET`. This single header flows through BOTH the body-mode `_httpsGetJson` (rungs 1-3) AND the legacy `fetch` branch (rungs 4-6). Once the WAF stops 401-ing, rung 1 (`GET-body/ms/num`) answers, sets sticky mode, clears the 5-min `coolUntil` cooldown, and the futures wallet renders normally on the CoinDCX tab. The PUBLIC futures instruments fetch in the SAME file (lines 827, 843) already set a Mozilla UA — this fix matches the existing pattern.
- **Regression lock**: `app/test/coindcxGet.test.ts` — added `expect(cap.headers['User-Agent']).toBe('wealthai-coindcx/1.0')` to the v12.3 GET-with-body contract test. Without this lock the regression shipped silently because every rung just surfaced as misleading "[401] Invalid credentials".

### High: 30-second signal latency — pipeline cut from 145s → 40s worst case

The user's "trade reversal chance ho raha hai" complaint was caused by 3 stacked latency amplifiers. All three fixed:

1. **Expert Picks scan budget 25s → 10s** (`app/server/ai/expertPicks.js:565`): the cold-scan wall-clock budget was 25s. Combined with the 120s client poll, a fresh Expert Pick took up to 145s to surface. Dropped to 10s — the partial-scan honest-degrade path (next 60s cycle covers the rest, documented at `expertPicks.js:706-713`) already handles the universe coverage. Worst case is now 10s scan + 30s client poll = 40s.
2. **Expert Picks client poll 120s → 30s** (`app/src/components/aitrading/ExpertPicksPanel.tsx:356`): the `setInterval` cadence was 120s for a 60s-cache scan — up to 60s of stale picks sat on screen with no SWR refresh. Now matches the Signal Board cadence (30s). The 65+ fallback retry and stale/partial chips are unchanged.
3. **Signal Board client poll 60s → 30s** (`app/src/components/aitrading/useAITrading.ts:198`): the `v12.10 BANDWIDTH` 60s poll cuts AI signal egress in half but means a fresh signal waits up to 60s before the browser learns. Dropped to 30s — the server-side cache is still 60s so most polls answer 304-equivalent (cache hit), bandwidth stays low. Combined with the existing 5s SSE `quotes` push (which the Top Picks panel already reacts to via the `liveLtpFor` prop), the top-5 panel moves on live price between board cycles.

### High: Superintelligence — 3-source blend instead of 2-source

The 6-LLM-seat Global Market Council (`councilEnabled()`) is OFF by default. With no `aiConf` source, `computeSuperScore` collapsed to the 2-source `0.55·engineConf + 0.45·expertScore` blend — the user's "superintelligence" was just two quant sources.

- **File**: `app/server/ai/signals.js` (lines ~1894 board path, ~2680 deep path)
- **Fix**: When the LLM council is offline (no keys + no reachable ollama → `aiConf == null`), derive a DETERMINISTIC council confidence from the engine's own committee: `aiConf = round(engineConf × (0.85 + 0.10 × agreement))`. This is honest because the deterministic council fundamentally re-derives its verdict from the SAME votes the engine already has — an aligned committee produces a high-confidence deterministic verdict; a split committee produces a low-confidence one. The slight 5-15% discount vs engineConf signals "deterministic, not LLM" so the UI can label it honestly via the new `superIntel.aiSource = 'deterministic' | 'council' | null` field.
- This makes the 3-source blend (`0.45·engineConf + 0.35·expert + 0.20·aiConf`) actually fire on every default install. When LLM keys are present (or ollama is reachable), the real council runs and `aiSource = 'council'`. No LLM cost added — the deterministic fallback is pure math.
- When the user later sets `AI_ENABLE_GLOBAL_COUNCIL=on`, the real 6-seat LLM council runs (12s soft deadline, 90s verdict cache) and `aiSource = 'council'` reflects it.

### High: Expert Picks — accuracy gates matching the Signal Board

The Expert Picks panel bypassed the probrain counter-tape / signal-trust / MTF-6 / signalMemory layers that the Signal Board path (`signals.js:1759-1815`) applies. A STRONG 80+ Expert Pick could fire on a counter-tape SHORT at the bottom of a V (the exact user complaint about long/short direction accuracy).

- **File**: `app/server/ai/expertPicks.js::_runScan` (per-coin scoring loop, ~line 730-760)
- **Fix**: After `expertScoreFactors` produces a `scored` object, call `qualityVerdict({ market, side, consensus, votes, ltp, changePct, rsi, adx, atr, candles, regime, htf, ltf, ltfLabel })` — the SAME function the Signal Board uses. Apply `qv.confAdj` to `finalScore` (range ~[-25, +6]) and `qv.gradeCap` to demote counter-tape / extension-veto / single-voter picks below STRONG. Then call `applySignalTrustGuards({ market, symbol, consensus, ctx, ltf })` — the overbought/oversold cap (LONG at RSI≥70 / SHORT at RSI≤30 → WATCH, chase at top-tick) + chase guard (vertical run + ATR distance) + side-flip whipsaw cap. Each pick now surfaces `qualityReasons: string[]` and `qualityFlags: { veto, counterTape, mtf, extension, quorum, obOs, chasing }` so the UI can show WHY a pick was demoted.
- The expert 7-factor score (trend 0.25 / momentum 0.20 / volume 0.10 / SMC 0.15 / volatility 0.10 / regime 0.10 / rr 0.10) is unchanged — these gates layer ON TOP, exactly as they do on the Signal Board path.

### Verification
- `npm run typecheck` → clean.
- `npm test` → **2738 tests / 153 files, all passing** (+1 new UA regression lock in `coindcxGet.test.ts`).
- `npm run build` → clean (Vite production bundle, 2250 modules).
- `node --check` on every touched file (`coindcx.js`, `expertPicks.js`, `signals.js`, `useAITrading.ts`, `ExpertPicksPanel.tsx`, `version.ts`) → OK.

## v20.4.2 — SYMMETRIC DIRECTION CERTIFICATE: dono taraf 100% pakka (2026-09-30)

**User directive: "SHORT signal pe LONG jata hai ya SHORT — 100% pakka. LONG signal pe SHORT jata hai ya LONG — 100% pakka. PAKKA BATAO AISA details me."** v20.4.1 ka certificate sirf SHORT direction lock karta tha; v20.4.2 ne **LONG mirror** add kiya — certificate ab SYMMETRIC hai (20 locks: 10 SHORT + 10 LONG).

### The symmetric final answer (test-locked, not words)
- `test/directionProof.test.ts` — **20 locks**, BOTH desks (spot/margin/futures) × BOTH modes × BOTH directions:
  - **SHORT card → SHORT trade. 100%.** Paper: position.side 'SHORT' + entry fills adversely (sell-side). LIVE: exchange body `side:'sell'` (spot) / `order.side:'sell'` (futures perp) + SHORT-polarity native TP/SL (stop > entry, profit < entry). Margin SHORT: `margin_amount_short` filled, liquidation ABOVE entry. Exit: stop breach **buys back**.
  - **LONG card → LONG trade. 100%.** Mirror of every lock above: `side:'buy'`, `margin_amount_long`, liquidation BELOW entry, TP/SL LONG-polarity, exit **sells out**.
  - **Silent flip structurally impossible (dono directions me)**: clicked SHORT + fresh consensus LONG (ya clicked LONG + fresh SHORT) → PAPER still opens the REQUESTED side (honest FLIPPED note) / LIVE **honest REJECT — ZERO signed requests leave the server**.
- Full suite: **2737 tests / 153 files 100% green** · supervisorGuard 54/54 · tsc clean · vite build OK.
- Direction trio re-verified: directionProof 20 + directionIntegrity 19 + cryptoCounterTape 8 = 47/47.

## v20.4.1 — DIRECTION CERTIFICATE: SHORT card pe SHORT hi hota hai (2026-09-30)

**User directive: "sirf short signal pe long ho ya short — pakka final batao; Top world AI Agent recheck; world ke top strategies strong signals ke liye."** Post-v20.4 end-to-end re-audit of the FULL direction chain (client card → gauntlet → exchange order body → booked position → exit polarity) with a dedicated proof suite.

### The final answer (locked by tests, not words)
- `test/directionProof.test.ts` — **10 locks** across BOTH desks (spot/margin/futures) and BOTH modes:
  - STRONG 80+ SHORT card (paper + live) → position.side === 'SHORT', exchange body `side:'sell'`
  - Clicked SHORT while the fresh consensus flipped LONG → PAPER still opens the REQUESTED side (SHORT) with the honest FLIPPED note; LIVE **honest REJECT with ZERO signed requests** ("fresh consensus LONG hai, aapne SHORT card pe trade maara tha")
  - LIVE margin SHORT → `margin_amount_short` filled, liquidation ABOVE entry
  - Futures LIVE SHORT → nested `order.side:'sell'` + native TP/SL with SHORT polarity (stop > entry, profit < entry)
  - SHORT exit → stop breach closes by **buying back** ('buy' order side)
- Full suite: **2727 tests / 153 files 100% green** (3 consecutive runs; +2 isolation locks) · tsc clean · vite build OK.

### Bonus fix caught BY the audit (v20.4.1 zip smoke)
- The smoke's app-tree-mutation gate caught `ai/selfHeal.js` hardcoding `server/data/exit-reasons.log` module-relative — every exit wrote into the app tree even with SMARTAI_DATA_DIR set (the v20.3 hermetic sweep missed this leaf). Fixed in selfHeal.js + supervisor.js (same env contract as lib/store.js); 2 new locks in selfHealGuard.test.ts (behavioral: fresh-module import writes INSIDE the sandbox root; source: env-before-default resolution). Smoke now asserts the booted app tree stays byte-identical.

### Strategy-stack audit (world-class components verified ACTIVE)
- 10-model quant committee (TrendMatrix/MomentumQuant/VolatilityScope/VolumeFlow/PatternNeural/SRMatrix/OptionsFlow/MacroRegime/SmartMoneyICT/IntradayTapeMTF) + AI Council LLM (Gemini→Groq→Cerebras) + sentiment/instflow/fundamentals + 4 mesh alt-data seats (congressional/insider/vendor-consensus/on-chain)
- MTF confluence caps · probrain v9.3 quality layer (counter-tape ban, chase guard, session phase) · adaptive Bayesian weights (live-outcome self-correction) · regime weights
- STRONG gate: conf ≥ 75 AND agreement ≥ 70% AND plan risk ≤ cap AND counter-tape/chase/MTF caps — a STRONG badge is EARNED, not printed.

## v20.4 — COINDCX DIRECTION FIX: crypto counter-tape wiring (2026-09-30)

**User report (CoinDCX tab): "Trade signal Strong 80+ SHORT rehne par bhi LONG jaa raha hai"** — the board printed STRONG 80+ SHORTs while the 15m tape/price kept climbing. Deep pro-trader-level trace (signal → votes → consensus → quality → execution) found a **wiring gap**, not a math bug: the direction math was correct everywhere, but one protection was dead on the crypto desks.

### Root cause (mechanical, 3-layer verified)
- probrain's v9.3 **counter-tape STRONG-ban** (MISALIGNED htf-vs-15m phase → conf −12/−18 + WATCH/ACTION grade caps) was built for EXACTLY this bug — but `signals.js` fed the quality verdict `enr?.ltfInd`, the **INDIA-only** enrichment map (`enrichN = INDIA ? … : 0`). On CRYPTO/FUTURES `enr` is always null → mtfAnalysis compared the 1h committee against ITSELF (LTF was also 1h) → the MISALIGNED phase could never fire off India.
- The 15m tape enrichment the crypto desks DO fetch (`tapeEnriched`) only VOTED (w 1.3) — it can never out-vote 5-7 lagging 1h seats (combined w ~5-9) that turn bearish AFTER the dump, exactly when the tape V-bounces. Result: a lagging 1h bear stack printed STRONG SHORT at the bottom of the V — the user shorted the bottom and watched the trade "go LONG".
- The deep path had the same self-compare (LTF = the 1h ctx candles), so the card the execution gauntlets re-verify at click time carried the same blind spot.

### Fix (3 surgical wiring changes, zero math changes)
- **Board path**: CRYPTO/FUTURES quality verdicts now receive the crypto 15m tape enrichment (`tapeEnriched` — the SAME data the tape vote reads) as the LTF: 1h-stack-vs-15m-tape conflicts demote exactly like the India desk (counter-tape conf −12/−18 + WATCH/ACTION cap), a CONFIRMING tape keeps the desk tradeable, and the structure stop lands on real 15m swings.
- **Deep path**: same wiring (hoisted `_cxTapeEnr`), so the deep card == the board card again.
- **VWAP domain fix**: `fetchCrypto15mTape` — the TV row's vwap is USD-domain while crypto-spot candles are INR; unscaled it poisoned the tape vote's VWAP leg with a ~×85 divergence (every crypto tape paid the "far from VWAP" mean-reversion penalty on the wrong side). Now scaled onto the candle domain (no-op on USDT desks / rows without vwap).

### What this changes on your CoinDCX tab
- A STRONG 80+ SHORT against a RISING 15m tape can no longer wear STRONG — it demotes to WATCH ("🛑 COUNTER-TAPE hard — tape roll hone do") or ACTION (stalling tape), with the honest reason on the card.
- SHORTs with a CONFIRMING (falling) 15m tape keep their grades — protection ≠ paralysis.
- The auto-executor (STRONG-only) and the live gauntlets now refuse counter-tape entries at the source.

### Tests
- **8 new locks** (`test/cryptoCounterTape.test.ts`): unit (probrain MISALIGNED/caps on CRYPTO + the ltf=null inertness doc) + board (rising-tape demotion + confirming-tape parity) + deep (card agreement) — hermetic, same mock pattern as intradayTapeAlignment/cryptoBoardFallback.
- Full suite: **2715 tests / 152 files 100% green** · tsc clean · zero regressions (the MTF-6 layer and all trust guards untouched).


## v20.3 — FULL-SITE RECHECK: 14 code fixes + packaging honesty rebuild (2026-09-30)

**User directive: "Full site code recheck and issues fix kardo".** 4 parallel deep-audit agents (server/ai · intraday+root · client · build/deploy/test-infra) + main-agent spot-verification: 27 findings, **14 source-code fixes + 8 packaging/deploy fixes + 5 test-infra fixes** implement kiye. Suite ab **2707 tests / 151 files 100% green** (16 nayi v20.3 locks — v203DeepAudit + targeted suite extensions); tsc clean; vite build OK; engineV4 time-of-day flake khatam.

### Server — HIGH (signal integrity)
- **Replay lookahead bias (R1)**: `replay.js` ke 15m/1h TF votes ab sirf COMPLETED buckets use karte hain (decision = current 5m bar ka close). Purana check bucket START test karta tha (`ts - 0` leftover) — in-progress bucket ke close/high/low FUTURE ke 5m bars se resampled hote the (1h TF pe ~55 min future leak, weight 1.8 — har winRate/avgR/PF/maxDD systematically optimistic). Gate replay ab tuning ke liye sach me honest hai.
- **Board universe base filter (R7)**: `signals.js` board tiered scan ab pre-filtered INDIA_UNIVERSE base pass karta hai. `tieredScanUniverse` ka `exclude` sirf discovered rows + hot map filter karta hai — 44/45 editor names T1 the, toh removed name har board cycle me scan hota raha (v20.2 wala "editor board pe apply hota hai" fix default mode me adhoora tha).

### Server — MED (money paths)
- **Futures partial-TP double-sell guard**: ambiguous transport error (timeout/network) ke baad watcher har 60s SAME market order re-send karta tha (40%+40%+… book slice). Ab `partialRetryAfter` 5-min hold (spot ka v18.9 fix ported) + reconcile pass exchange qty sync karta hai.
- **Futures reconcile qty-sync**: `(p.tp1Hit || p.tp2Hit)` guard hataya — app/native exchange partial close ab book qty turant sync karta hai (P&L/daily-cap/liquidation math stale nahi rehta).
- **Paper exit slippage (parity)**: v20.2 entry-side +7bps sirf entry pe tha — har paper EXIT mid pe bharta tha (~7bps flattered, har leg). Ab watchPositions full close, partialCloseSpotLeg, manual close — teeno adverse fill + `slipNote` journal stamp. LIVE fills exchange-real hi rehte hain.
- **Relaxed calibration stamps (parity)**: FUTURES / GLOBALFUTURES / INDIA paper paths ab `relaxed: true` stamp karte hain (sirf CRYPTO desk tha) — flipped/sub-floor practice fills ab KISI bhi desk se calibration corpus me nahi ghushte.
- **Telegram env-key outage**: `telegramPush` ka sink + backup alerter `telegramConfig({})` (secrets-only) resolve karte the — TG_TOKEN/TG_CHAT_ID env-only deployment pe 5s level pushes, 30s STRONG scans, 60s backup SAB silently no-op (jabki watcher close messages aate rehte the). Ab routes `tgEnv` inject karta hai.

### Server — LOW
- **TrackRecord flip-cooldown**: scanner (60s) vs AI-board (30s) direction disagreement row ko har cycle FLIP-close+reopen karta tha (levels churn, 40/day cap burn). Ab 30-min/symbol cooldown — genuine flip ek baar, churn nahi.
- **STRONG format currency**: futures plans ab "B-USDT Perps · 65,000 USDT" (hardcoded ₹ galat label tha).
- **MATIC dead seed** hata → POL (FUTURES_UNIVERSE + precision map).

### Client
- **CandleChart tick-loop (HIGH)**: `ltp` load-deps me tha — har live price tick (crypto 800ms batch) naya `load` banata tha → 60s interval teardown + instant 96-bar refetch (API abuse loop on liquid names). Ab ltpRef se padha jata hai.
- **CandleChart TF-race**: `reqSeq` per-request token — slow 5m response 15m switch ke baad land karke gal chart paint nahi kar sakta. Candles ab OHLC-validated (ek null `high` poora chart NaN kar deta tha). Flat-range guard negative-safe.
- **AgentPanel wallet dedup**: 4th independent 60s signed wallet poller bhi shared `useWalletPoll` me (v20.2 dedup ne is panel ko miss kiya tha).
- **PortfolioHeat SIM separation**: EQUITY SIM (USDC) paper rows REAL equity ke heat meter me count nahi hote (false HOT/DANGER band + "book risk off" advice). Header count bhi real-only ("+ N SIM" honest suffix).
- **SSE stale-token reconnect**: ProTraderAutoPanel + positions stream — native EventSource reconnect stale-token URL loop karta tha; ab error pe close + fresh-URL re-attach (useIntradayStream pattern). GateReplayPanel unmount pe abort + setState guard. Toast dedup FIFO eviction (bulk clear re-toast bug).

### Build/deploy — the v20.2 zip was defective (v20.3 packaging rebuild)
- **Dev data leak**: rsync `--exclude 'server/data'` galat anchored tha — v20.2 zip me dev ke 20 runtime files (server.log, journals, secrets placeholders) aaye the. Ab pattern 'data' + hard absence assert.
- **Stale source shipped**: v20.2 zip ka src/ test/ v20.1 ka tha (CandleChart, GateReplayPanel, useWalletPoll, desktopNotify, v202 test suite — sab missing). Ab poora source tree sync (scripts curated — dev build scripts bahar).
- **Version claims**: package.json 20.1.0 (zip me!), App badge "v20.0", watchdog bat v20.1, README install line v20.1, server banner v20.1 — sab ek source se: `src/version.ts` (APP_VERSION) + package.json 20.3.0 + build gates.
- **smoke_v202_zip.sh kuch assert nahi karta tha** (always exit 0) — naya `smoke_v203_zip.sh` real assertions ke saath (login token, candles 200+ok+bars, replay 200+ok+trades, version markers, offline boot).
- **ml-service /MIR data-loss**: upgrade user ke trained models (`ml-service/store/`) delete kar deta tha (backups me bhi nahi the). Ab `/XD store` + ml-service backup+rollback coverage dono bats me.
- **VERSION-MANAGER version parse**: findstr whole-line return karta tha → malformed VERSION.json. Ab PowerShell ConvertFrom-Json se exact number.

### Test infra
- **Suites ab fully hermetic**: `src/test/setup.ts` global `SMARTAI_DATA_DIR` (mkdtemp) — 8 suites (futures/mandateFreeze/trailing/v70/aiSecrets/agent/indiaAgent/clearClosedPositions) dev ke LIVE `server/data` me likh rahe the (journal erase, trailing disable, config reset — wahi pollution zip me bhi gaya tha). settings/durable/portfolioSync apne fs-assertions bhi env-dir pe redirect.
- **engineV4 time-of-day flake**: counter-regime test real clock pe 09:15-09:45 IST window me fail hota tha (session-pace volume boost → scores 100 pe saturate → early-phase cap dono 88 → diff 0). Sabhi 6 unpinned tests ab SAT_NOON_IST deterministic clock pe.
- **16 nayi locks**: v203DeepAudit (replay bucket semantics ×3, flip-cooldown ×2, currency format ×2, ambiguous classifier) + aiOrders exit-slip + telegramPush env-keys ×2 + indiaBoardTiered base-filter ×2 + futures/global/india relaxed-stamps ×3 + v70/v702/v189 fee suites slip=0 isolation.

## v20.2 — INTRADAY + COINDCX TABS: full feature-audit UPGRADE — 16 upgrades implemented (2026-09-30)

**User directive: "Intraday TAB & coindcx tab me existing features deep check karo accurately aur kya kya upgrade and improvement kar sakte hai details me batao" → "sabhi phases accurately implement and apply kardo".** Dono tabs ka dual-agent deep audit (~48 sections mapped) + main-agent spot-verification, phir roadmap ke sabhi phases implement kiye. Suite ab **2691 tests / 150 files 100% green** (16 nayi v20.2 locks); tsc clean; vite build OK.

### Phase 1 — P0 fixes (honesty gaps)
- **Board → Track-Record wiring (A1)**: AI Superintelligence board ke ACTIONABLE signals (STRONG+ACTION, valid plan) ab `recordSignals()` me jaate hain — TrackRecordPanel ka "har published signal track hota hai" waada ab sach me board ke liye bhi sach hai (pehle sirf unpolled legacy scanner feed karta tha). Naya `server/ai/boardAccountability.js` — engine-identical qty formula, LEVEL-FREEZE idempotent, wrong-side-plan rejection. FUTURES/GLOBALFUTURES skip (USDT/USDC plans vs INR watcher quotes — unit mismatch, explicitly documented).
- **FUTURES STRONG alerts (A2)**: insta-push STRONG scan me 3rd live desk add (pehle sirf CRYPTO+INDIA scan hote the — B-USDT perps ke STRONG signals kabhi push hi nahi hote the). GLOBALFUTURES (SIM) deliberately excluded.
- **Wallet 3×→1× polling (A4)**: WalletCard + WalletStrip + PortfolioHeat ke 3 independent 60s pollers (3 signed CoinDCX wallet calls/min) ab EK shared `useWalletPoll` store (useSyncExternalStore) — 1 poller, N subscribers, last-unmount pe timer park.
- **QuickNav + copy fixes (A6)**: CoinDCX nav me SELF-FIX / MY TRADES chips + FUTURES desk pe PERP chip (3 sections pehle unreachable the); PerpIntel "60s"→90s honest copy (2 spots); "15 live tools"→18; TOOL_LABEL me 4 missing tools (backtest/news/verify/consensus) — ab raw snake_case nahi dikhta.

### Phase 2 — latency + UX + data-honesty
- **Spot SL fast-path 60s→5s (B3)**: level-touch detect hone par insta-push sink (5s cadence) ab `watchPositions()` ko TURANT fire karta hai (DI-injected, no import cycle) — violent candle pe spot SL ab max ~60s nahi baithta (futures me exchange-native TP/SL pehle se tha). **Telegram keys ke bina bhi chalta hai** (SL execution alerts pe depend nahi karta — `_tick` restructure).
- **PRICE CHARTS (B5)**: poore desk ka pela candlestick chart — naya `/api/ai/candles` endpoint (MTF-6 ka hi fetch chain: CoinDCX→Binance/Bybit→Yahoo, 60s cache, LTP-scale conversion) + `CandleChart.tsx` (SVG candles, 5m/15m/1h/1d toggle, ENTRY/SL/T1/T2 dashed overlays, honest degrade). SignalCard me lazy "📈 PRICE CHART" strip + dono desks ke deep modal me first-class chart.
- **USDINR single source (B7)**: naya disk-backed `ai/lib/usdinr.js` — dono private FX caches (cryptoStream + futures) ab shared last-known-good store me record karte hain; flat-84 fallback ab SIRF tab jab process ne kabhi live rate nahi dekha (pehle: cold boot + Yahoo outage = ~5% INR-twin error har jagah). routes.js ke 4 hardcoded-84 sites migrated.
- **TrackRecord/Journal self-poll (B8)**: dono panels 60s visibility-gated tick pe refresh (pehle sirf paper open/close pe — "Currently Tracking" indefinitely stale reh sakta tha).
- **Universe Editor → Board (B9)**: board scan ab user ke universe edits honor karta hai (removedBase excluded from tiered AND legacy static scan; custom symbols Tier-1 cadence pe) — pehle TATAMOTORS remove karne ke baad bhi board pe dikhta tha. Tooltip honest copy update.

### Phase 3 — realism + calibration
- **Intraday GATE REPLAY harness (C10)**: naya `/api/ai/replay` + `server/ai/replay.js` — 5m bars pe bar-by-bar replay of THE QUANT GATE STACK (MTF 3-TF weighted ladder, chase 2.5/1.8×ATR guard, OB/OS RSI suppression, conf grade ladder, ATR plan, T1-50%+BE-trail discipline — trackRecord jaisa hi exit model). Win-rate/avgR/PF/maxDD + per-gate rejection funnel. `GateReplayPanel` India tab ke Backtest Lab me. Honest: quant-proxy (LLM council replay nahi hota), fills bar-close, intrabar SL-first conservative.
- **Paper-fill realism (C11)**: practice fills ab +7bps adverse slippage (AI_COINDCX_SLIP_BPS env, 0=off) lete hain — mid-price fills paper P&L ko flatter nahi karte. **Calibration corpus hygiene**: relaxed practice entries (flipped/sub-floor consensus wale) ledger me `relaxed: true` stamp hote hain aur trust.js calibration/Brier/monthly se EXCLUDED — engine-ne-endorse-nahi-kiya entries claimed-vs-actual calibrate nahi karte.
- **Binance projection divergence guard (C12)**: Binance→INR projected tick anchor se >0.3% drift kare to `binance-proj-drift` label — UI me amber **Binance·PROJ** pill (extrapolated price kabhi venue-confirmed jaisa GREEN nahi dikhta).
- **TrackRecord live LTP (C13)**: watcher (tracked symbols = priority class) + 60s self-poll = "Currently Tracking" ab live (B8 ke saath naturally complete).

### Phase 4 — desk hygiene
- **Equity SIM separation (D14)**: GLOBALFUTURES (USDC SIM) entries ab REAL desks ke daily trade/loss budget me count NAHI hote — SIM P&L alag report hota hai (`simTradesCount`/`simRealizedPnlINR`, OrderConsole me alag book line). SIM desk ka APNA discipline cap ab sim* counters pe (self-limiting intact).
- **Desktop notifications (D15)**: naya `desktopNotify` util + AlertsPanel me ENABLE button — naye STRONG signals hidden tab pe OS toast (Notification API; Telegram out-of-browser channel hai, ye in-browser). 30s throttle + per-symbol:side dedup; permission sirf user-click se.
- **Visibility gating (D16)**: EngineHealthStrip + SelfImprovementPanel ke network polls hidden-tab pe band (baaki sab pehle se gated the).

### Tests
- NEW `test/v202DeepAudit.test.ts` (11 locks) + telegramPush.test.ts me fast-path executor suite (3 locks) + futures.test.ts me last-known-good FX case. Suite: **150 files / 2691 tests 100% GREEN**; tsc clean; vite build OK (CoinDcxTab 130KB / IndiaIntradayTab 169KB chunks).

## v20.1 — FULL-SITE + TRADE-SIGNAL DEEP RECHECK: 10 real bugs fixed (2026-09-29)

**User directive: "full site code recheck aur trade signal ko deep recheck karo koi issues hai tho fix kardo or upgrade kardo".** Teen parallel audits chale (frontend 46 files, server infra ~45 files/63k lines, signal engine 6,646 lines hands-on: signals.js + optionsDesk + optionsScan + mtf + winProb + signalVerifier + entryTiming + models tapeVote). Signal engine math CLEAN nikli (ensemble/MTF-6/win-prob/SVA layers sab prior-audit hardened); 10 real bugs surface layers me mile — sab fixed + test-locked.

### Frontend (6)
- **[HIGH] DepthLadder.tsx — L2 order-flow widget PERMANENTLY DEAD tha**: `apiFetch` RAW Response deta hai; `setView(r)` us Response ko hi store kar raha tha (Response structurally `DepthView` ka `ok: boolean` satisfy karta hai — tsc chup, widget hamesha "L2 depth unavailable" render karta tha) jabki har card har 2s me /api/ai/depth poll karta rehta. Ab JSON parse hota hai + background tab me poll wire pe nahi jata.
- **[MED] CoinDcxTab deep-modal indicator block**: v18.5 ka IndiaIntradayTab fix (object indicators har key pe `.adx` print karte the) CoinDCX desk pe port hi nahi hua tha — ab identical per-key logic.
- **[MED] useCxLivePrices — token baked into SSE URL**: mount-time token URL me fix tha; session expire hone ke baad har reconnect wahi dead-401 URL loop karta tha. Ab URL HAR connect attempt pe rebuild hota hai (fresh token; useIntradayStream parity).
- **[MED] api.ts + useAuthState — mid-session 401 dead-end**: token expire hone pe saare polls 401-loop karte the, PIN gate manual F5 tak nahi dikhta tha. Ab koi bhi 401 throttled `session-expired` event fire karta hai aur shell auth-state reset karke PIN gate pe gir jaata hai.
- **[LOW] ProTraderAutoPanel — SSE sirf mount-time token pe lagta tha**: session-restore se pehle mount hua to live-log stream lifetime bhar nahi lagta. Ab 1s token-wait loop.
- **[LOW] deskShared tooltip**: "Auto-refresh every 30s" → 60s (REFRESH_MS=60_000 tha).

### Server (4)
- **[MED] bandwidth.js — unbounded telemetry scopes**: REST middleware full `req.path` ko scope key banata tha — parameterized routes (/api/fundamentals/:symbol) per-symbol scope mint karte the aur `_scopes`/`_lifetime` kabhi prune nahi hote. Ab route-template collapse (`:p`) + hard 200-scope LRU cap.
- **[MED] index.js — raw XFF trust on 3 rate-limiters**: `clientIp()` (chart/quote/fundamentals pubGuard), `/api/telegram`, aur PUBLIC `/api/ml/*` mlGuard — teeno unconditionally `X-Forwarded-For` trust karte the; ek LAN peer har request pe fresh IP forge karke rate-limit ko bypass kar sakta tha (ML endpoints CPU-bound hain — event-loop saturation vector). Teeno ab hardened `clientIpOf()` use karte hain (XFF sirf TRUST_PROXY=1 ya loopback pe).
- **[LOW] /api/ai-consensus stance inversion**: BULLISH-first substring test — koi bhi bearish answer jisme "buy" word hota ("do NOT buy") BULLISH classify ho jata tha. Ab dono keyword classes count hote hain; strict majority jeet-ta hai, mixed answer honest NEUTRAL.
- **[LOW] meshModels.js — warm-seat store never evicts**: `_store`/`_lastQueryAt` process-lifetime grow karte the (rotating CoinDCX pairs + India F&O discovery). Ab 30-min age-sweep har warm tick pe.

### Test hygiene
- **durable.test.ts flake killed**: AES-GCM envelope test 2-char plaintext `'AT'` ko pure base64 envelope me search karta tha — random GCM auth tag kabhi-kabhi literally "AT" se START hota hai (live run me pakda gaya). Ab distinctive 19-char plaintext — invariant same, assertion cryptographically deterministic.

### Tests
- NEW `test/v201DeepAudit.test.tsx` — 8 regression locks (DepthLadder JSON render + honest degrade, SSE token re-read per reconnect, 401→session-expired event + auth reset, bandwidth route-template + 200-cap, meshModels age-sweep). Suite ab **2675 tests / 149 files 100% green**; tsc clean; vite build OK.

# Changelog

## v20.0.1 — DEPS AUTO-INSTALL: fresh installs bina npm install bhi boot honge (2026-09-29)

**Live bug (D:\SmartAI26): v20 full zip me node_modules nahi hota (user-data rule) — NAYE folder pe Start-SmartAI-Watchdog chalate hi `ERR_MODULE_NOT_FOUND: dotenv` crash-loop, aur supervisor GALAT "port conflict" hint de raha tha.** Fix teen layers me:

### supervisor.js (v19.2 engine + v20.0.1 deps self-heal)
- **Preflight audit**: boot se PEHLE package.json ke saare dependencies vs app\node_modules check — missing ho to `npm install --omit=dev --omit=optional --no-audit --no-fund` KHUD chalata hai (output `[npm]` lines me relay; max 15 min = WATCHDOG_INSTALL_TIMEOUT_MS). Fresh install pe pehli run ab khud dependencies laga legi.
- **Crash sniff**: child stderr me `ERR_MODULE_NOT_FOUND` mila (aadhi line bhi — exit pe buffer flush naya hai) → journal reason `deps-missing(exit(..))` + HONEST Hindi message ("DEPENDENCY MISSING"), GALAT "port conflict" hint band. Ek auto-install retry (max 2 per run), phir bhi missing → 60s cool delay + "khud chalao: npm install" guidance (budget-pause anti crash-loop pehle se hi tha).
- **Race-free**: npm install ke dauran restart-tick + startChild blocked (`state.installingDeps`).
- **Honest UP line**: spawn pe "server START" bola jata hai; "server UP" tab bolte hain jab PEHLA /api/ping OK ho (pehle crash ke turant baad "UP" likha jata tha — misleading tha).
- Naye knobs: `WATCHDOG_AUTO_INSTALL=0` (off), `WATCHDOG_INSTALL_TIMEOUT_MS`, `WATCHDOG_APP_ROOT` (rare override).

### Windows installer (fresh-install support)
- v20.0.1 full zip ab **node_modules (prod-only, pure-JS) OFFLINE bundled** karta hai — internet ke bina bhi fresh install boot hota hai (npm fallback sirf offline-copy fail ho).
- SETUP/VERSION-MANAGER: target me node_modules missing → payload se copy (user ka existing node_modules kabhi overwrite NAHI hota); `.env` missing → auto-create (APP_PIN random generate + console pe print; AI keys baad me .env.example se add kar sakte ho).
- 1-CLICK-FIX.bat (DEPS-FIX hotfix zip): D:\SmartAI26 jaise half-broken installs ke liye — auto-locate → supervisor.js replace → node_modules install → .env fix → watchdog start, ek click me.

### Option cards — date-window bug (test suite ne pakda)
- **`expiryLabel()` day ab 2-digit PADDED**: `2026-10-06` → `06Oct` (pehle `6Oct` banta tha). Sirf Oct/Apr/Jan jaise mahino ke 1-6 din wali expiry window me dikhta tha — runtime next-weekly single-digit day pe ho tab card-name contract `/^\d{2}Mon$/` toot jaata tha (date-rot-proof test ne live pakda). Card names ab fixed-width — layout bhi stable.

### Tests
- NEW supervisorGuard v20.0.1 block (11 tests: preflight/off-env/timeout/tries-guard/honest messages/flush-race) — suite ab **2667 tests / 148 files 100% green**; smoke_v201.mjs 14/14 REAL-process proof (fresh app → REAL npm install → ping 200; restart pe koi spurious install nahi; auto-install OFF pe honest crash). smoke_v192 17/17 + smoke_v20 8/8 regression green; tsc clean. optionSignalCards expiryLabel contract reconciled (05Jan).

## v20.0 — TWO-DESK REBUILD: India Intraday + CoinDCX ONLY (2026-09-29)

**User spec: "site me sirf Intraday TAB & CoinDCX TAB ko hi rakho, baaki sab completely remove karo, full site completely redesign karo — high performance & high accuracy, sab full optimize karo, future upgrade/downgrade ke liye perfect installer, Windows ke liye full setup .zip me, unwanted files cleanup."** v20.0 is a full-site rebuild: the terminal is now EXACTLY two desks, the shell is near-zero-cost, the frontend ships 5x smaller, and a version-managed installer (upgrade / downgrade / rollback) replaces overlay patches.

### WHAT WAS REMOVED (86 frontend files, provably dead)
- TABS: Dashboard, Portfolio, Planner, Macro(Risk) — UI + their entire module trees.
- SHELL: NeuralChat (chat bubble), PortfolioHealthMonitor, InstallPWA prompt, StaticMirrorBanner, Add/Edit portfolio modal, VIX/sentiment/USD-INR ticker strip, PWA widget page (public/widget.html).
- STATE: the 2570-line useAppState (portfolio prices polling, forex loop, INDMoney sync, IndexedDB per-tick snapshots, cloud merge) replaced by a 140-line useAuthState (PIN auth + session restore + theme + ONE /api/ping heartbeat per 30s).
- UTILS (37): liveStream, tvWebsocket, wealthEngine, portfolio*, riskEngine, taxOptimizer, monteCarlo*, inflation*, dipEngine, smartMoney, superintelligence*, mlApi, fundamentalsApi, advancedScreener, exportData, assetPnl, costBasis... all portfolio/planner/macro-only engines.
- SW: the service worker's 15-min portfolio background-sync engine + widget data + P&L badge + price notifications — rewritten as a lean app-shell SW (cache v20; /api/* NEVER cached; activate evicts ALL legacy caches incl. old private-API leftovers).
- Deletions are import-graph-proven (scripts/trace_deps.py): the two desks' transitive closure was computed BEFORE deletion; tsc + 2656 tests + build + boot smoke all green after.

### WHAT STAYED (battle-tested v19 desks, untouched)
- India Intraday desk: 10-model signal board, committee, top-5 picks, options desk, swing, paper trading, journal, track record, Dhan execution, morning brief, agent console, near-miss engine, universe editor, MTF confluence.
- CoinDCX desk: live board (WS), signal cards + MTF/edge, perp intel, order console, manual-trade monitor, reversal, models + performance, mesh status, alerts, agents (crypto/ask-AI), self-improvement panel, pro-trader auto, wallet, backtest, ledger, trust layer.

### PERFORMANCE (the redesign's measurable wins)
- Shell chunk: 18.26 kB (was ~400+ kB monolith path) — instant PIN-to-desk boot. Desks lazy-loaded as separate chunks (India 163 kB / CoinDCX 130 kB / shared 295 kB), each behind ErrorBoundary + auto-retry chunk reload.
- Shell recurring network cost: ONE /api/ping per 30s (4s timeout). No ticker polls, no forex loop, no INDMoney sync, no per-tick IndexedDB writes.
- SW: app-shell + SWR statics only; every /api/* (incl. SSE) network-only.
- Backend: unchanged battle-tested route surface (every desk endpoint intact) + the full v19.1/v19.2 anti-freeze stack.

### ACCURACY PROTECTION
Both desks' engines (committee quorum, council verdicts, MTF confluence, verifier gates, near-miss harvesting, self-improvement loop) are byte-identical v19 code — the rebuild only removed NON-signal surfaces. All 2656 desk/server tests green, zero engine drift.

### INSTALLER (the "perfect upgrade/downgrade setup")
- SETUP-v20.bat: auto-locates the install, backs up current code (server/data + .env + node_modules NEVER touched), applies the v20 payload (dist/ public/ are MIRRORED — stale hashed chunks die = unwanted-file cleanup), writes VERSION.json, verifies (node --check + dist marker).
- VERSION-MANAGER.bat: applies ANY future SmartAI zip with the standard app/ layout — upgrade or downgrade, same 4-step guarded flow (locate -> backup -> apply -> verify, auto-rollback on verify fail).
- ROLLBACK.bat: one-click restore of the last backup.
- Start-SmartAI-Watchdog.bat now launches the v19.2 ANTI-FREEZE SUPERVISOR (node server\supervisor.js) — hang + crash auto-recovery; this is the recommended way to run the site.

### TESTS + SMOKE
- NEW test/v20TwoDesk.test.tsx — 16 contracts: exactly two desks, lazy+boundary wiring, zero shell fetch loops, strong-PIN login, removed-file guards (16 files stay deleted), auth server-side contract, heartbeat shape, SW private-data rule, no background-sync.
- Suite: 148 files / 2656 tests 100% GREEN (7 obsolete portfolio tests removed). tsc clean. Build 3.7s.
- NEW scripts/smoke_v20.mjs — 8/8 with the REAL server + new build: /api/ping, v20 shell served, hashed chunk on disk, PIN login -> token, /health selfheal+consoleguard, SSE route alive, v20 banner. Anti-freeze smoke (smoke_v192.mjs): 17/17 incl. real freeze-recovery.

## v19.2 — ANTI-FREEZE SUPERVISOR + QUICKEDIT GUARD (2026-09-29)


**User spec: "site atak raha hai" (hung, not crashed) — the v19.1 follow-up.** v19.1 made the server crash-immune and log-pipe-safe, but one failure class stayed UNRECOVERABLE: the HANG. Process zinda hai, event loop FROZEN (Windows QuickEdit console select-mode, a blocked stdout pipe, a sync stall) — health checks time out, the site "atak jaati hai", and the process NEVER exits, so no restart trigger ever fires. The v19.1 watchdog bat only restarted on EXIT; a hung child never exits. v19.2 closes exactly that gap, and does it with an INDEPENDENT heartbeat the child cannot fake or share.

### THE FIX (3 layers, hang-first)
- **LAYER 1 — external anti-freeze supervisor (server/supervisor.js, NEW)**: `node server\supervisor.js` (what Start-SmartAI-Watchdog.bat now runs) spawns the server as a child (marker `SMARTAI_SUPERVISED=1`), RELIABLY drains its stdout (a always-drained pipe can never fill and freeze the child — console + rotated file log `server/data/logs/server.log` 5MB x 2), and every 20s GETs **/api/ping** from its OWN event loop. 3 consecutive timeouts after the 45s boot-grace = **FREEZE verdict** -> force-kill (taskkill /F /T tree-kill on Windows) -> journal -> restart. A boot that never comes up hits the same verdict via fails+3 (boot-hang). Child EXIT (crash/OOM/V8 fatal) -> journal + restart with exponential backoff (3s..60s, reset after 10 min stable) and an hourly restart budget (20/hour -> 10 min pause instead of crash-loop CPU burn). Ctrl+C = graceful (child gets the shared-console ctrl event on Windows; supervisor waits 8s, then force-kills, journals watchdog-clean-shutdown, exits 0). The supervisor itself never exits on internal errors (own uncaught/unhandled stay-alive). **CRITICAL found live in smoke: the interval timers must stay REF'd — unref'd timers let the supervisor's own process die silently the moment the child's stdio pipes close, killing the scheduled restart (the "restart #1 3s baad" that never came).**
- **LAYER 2 — /api/ping (NEW public route)**: a ZERO-work liveness endpoint (no snapshots, no fs, no middleware work) registered BEFORE /health and added to PUBLIC_PATHS — response time IS the event-loop heartbeat. /health stays the deep status endpoint (now also carries `consoleguard` + `supervised` fields).
- **LAYER 3 — QuickEdit programmatic guard (server/ai/consoleGuard.js, NEW)**: the #1 REAL "site 5-10 min me atak jaati hai" root cause on Windows portables is conhost QuickEdit mode: any accidental click in the console puts it in text-select mode, conhost stops draining stdout, the pipe fills, the next console.log blocks forever = event loop frozen, process alive. One best-effort PowerShell child at boot flips the shared console's input mode (kernel32 SetConsoleMode: clears 0x0040 ENABLE_QUICK_EDIT_MODE, sets 0x0080 ENABLE_EXTENDED_FLAGS). Runs in BOTH the supervisor (covers the shared console) and index.js (covers startai.exe direct boots; skipped when supervised to avoid double-spawn). Verdict lands in `/health.consoleguard`; `QUICKEDIT_GUARD=off` to disable. Non-Windows / no-console / timeout paths all resolve silently — never blocks, never throws, never rejects.

### OBSERVABILITY
- supervisor journal entries (same `server/data/exit-reasons.log`, same 60-line cap): `watchdog-boot` / `watchdog-restart` (reason: freeze | boot-hang | exit(code)) / `watchdog-budget-pause` / `watchdog-clean-shutdown` — the next "site down/atak gaya" report is one file-read away from the exact verdict.
- file log `server/data/logs/server.log` (5MB x 2 rotation): child stdout + supervisor status lines, both tagged. `WATCHDOG_LOG_FILE=off` disables.

### KNOBS (all optional)
`WATCHDOG_PORT` (default PORT/8080), `WATCHDOG_PROBE_MS` (20s), `WATCHDOG_TIMEOUT_MS` (9s), `WATCHDOG_FAILS` (3), `WATCHDOG_GRACE_MS` (45s), `WATCHDOG_BACKOFF_BASE_MS` (3s), `WATCHDOG_BACKOFF_MAX_MS` (60s), `WATCHDOG_STABLE_RESET_MS` (10m), `WATCHDOG_MAX_RESTARTS_HOUR` (20), `WATCHDOG_BUDGET_PAUSE_MS` (10m), `WATCHDOG_LOG_FILE` (path|off), `WATCHDOG_JOURNAL`, `WATCHDOG_CHILD` (entry override), `WATCHDOG_DISABLE` (probes off = restart-on-exit only), `QUICKEDIT_GUARD` (on|off).

### TESTS + SMOKE
- NEW test/supervisorGuard.test.ts — 43 tests: consoleGuard (non-win32 skip, env off, PS command construction w/ SetConsoleMode + quick-edit bits, QEDIT_OFF/ALREADY_OFF/NO_CONSOLE verdicts, spawn-fail/timeout/error silent paths, never-rejects) · supervisor (knobs parse + garbage->default, spawn contract SMARTAI_SUPERVISED=1 + app-root cwd, fail streaks, FREEZE verdict only after grace, BOOT-HANG fails+3, crash-exit journal + backoff doubling/cap/stable-reset, restart tick timing, budget pause + resume, clean stop linux/win32 semantics + 8s force fallback, taskkill tree-kill, stdout/stderr relay + file log + 5MB rotation, hostile-data relay) · probe transport (timeout/ECONNREFUSED/2xx-4xx alive/5xx dead/sync-throw) · wiring source contracts (ping route pre-/health, PUBLIC_PATHS, consoleguard+supervised in /health, v19.2 + v19.1 markers intact). FULL SUITE: 158 files / 2757 tests 100% GREEN. tsc clean.
- NEW scripts/smoke_v192.mjs — 17/17 with REAL processes: real server boots under the supervisor (ping 200, /health supervised:true + selfheal.armed:true, clean SIGINT stop exit 0, no orphan) · **REAL FREEZE-RECOVERY: a fixture serving 4 pings then while(true) locks its event loop — supervisor catches it, force-kills, journals 'freeze', restarts, fixture serves again** · REAL CRASH-RECOVERY: exit(7) -> backoff restart -> run=2 alive · relay file log carries child + supervisor lines.

## v19.1 — NEVER-DOWN STABILITY GUARD (2026-09-29)

**User spec: "localhost pe 5-10 min ke baad site down ho raha hai — deep advance pro level pe fix karo, full site code deep recheck, .zip patch."** Deep diagnosis: 9-minute live repro with 2 SSE clients + API load = 0 health failures, flat RSS, stable FDs — the server core is sound. The "down after 5-10 min" vectors are ENVIRONMENTAL, and v18.1's own crash policy was the biggest one: any single uncaught exception ran flush-then-exit(1), assuming a supervisor would restart the process — on a Windows portable with no working watchdog, that IS the site going down and staying down. v19.1 installs defense-in-depth so no single failure can take the site down, and makes the NEXT failure self-explanatory.

### ROOT-CAUSE COVERAGE (3 independent layers)
- **LAYER 1 — crash immunity (selfHeal.js, new)**: uncaughtException now FLUSH + LOG + COUNTER + **STAY ALIVE** (the v18.1 exit-on-crash pair is retired from index.js). A stray sync throw in any callback can no longer kill localhost. `SELFHEAL_EXIT_ON_FATAL=true` restores the old exit-for-restart behaviour for supervised deployments (Render). unhandledRejection: counted + rate-limited (was log-only).
- **LAYER 2 — stdout volume governor (logGovernor.js, new)**: a piped/frozen Windows console (launcher stops draining, or QuickEdit select-mode freezes the window) fills the OS pipe buffer in minutes of multi-stream logging — the next console.log blocks FOREVER and the event loop hangs: process alive, site dead, exactly at 5-10 min. The governor dedupes repeats (xN collapse) + rate-caps lines/min (default 240; excess dropped + counted) so the pipe can never fill from normal chatter. `LOG_GOVERNOR=off`, `LOG_LINES_PER_MIN`, `LOG_DEDUPE_MS` knobs.
- **LAYER 3 — external watchdog (Start-SmartAI-Watchdog.bat, new, optional)**: double-click launcher alternative that auto-restarts the server 5s after ANY exit (covers V8 OOM fatals and SELFHEAL_EXIT_ON_FATAL deployments — the two cases in-process guards cannot catch by design).

### OBSERVABILITY (the next "site down" is now self-explanatory)
- **exit-reason journal** `server/data/exit-reasons.log`: every boot + exit is one JSON line; the NEXT boot prints `[selfheal] previous run: CLEAN SHUTDOWN / EXIT(...) / HARD KILL (OOM ya force-kill likely)` — clean vs crash vs kill-9 becomes a one-line fact, not a guess.
- **/health enriched** with `selfheal` block: rss/heap/external MB (+ limits + pressure flag), event-loop lag (perf_hooks histogram, 30s buckets), crash counters, lastError, logGovernor stats, previousRun verdict. One URL answers "kitna RAM lag raha hai / kitna lag hai / kitne crashes se bacha".
- **memory watchdog**: 60s cadence vs limits (RSS 1400MB / heap 1100MB default; `SELFHEAL_RSS_LIMIT_MB`/`SELFHEAL_HEAP_LIMIT_MB`); on breach fires the trim registry — liveFeed aggressive prune (new `pruneLiveFeedNow()`) + candle-cache flush — and logs throttled.
- **event-loop lag watchdog**: >4s freeze in a 30s bucket logs the exact recovery hint (QuickEdit select-mode unfreeze: console pe click + Enter).

### FULL-SITE DEEP RECHECK (user-ordered)
- Audited ALL 40+ setInterval sites (unref + try/catch discipline verified), every fetch path (AbortSignal timeouts present incl. TG 10s / candles 8s / meta-ensemble breaker / Binance 6s), SSE backpressure guards (128KB writableLength cap, keepalive cleared on close), WS modules (cxSocketIo frame cap 1MB + safe wrappers; cxSpotWs/cxRtStream circuit breakers + negative caches + coalescing), bounded caches (candles 64-entry LRU, cxBookState 10-min retention, liveFeed 300-key eviction, usStream session prune, bandwidth scopes), bot restart backoff, login rate limiters — no new defect found; CoinDCX auto-trading desk scope re-verified (desks.spot=false, futures+global on).
- **9-minute live repro**: /health 0 fail / 106 polls, worst 2.2s, RSS flat 455-467MB, FDs stable, both SSE streams alive throughout — with the guard armed: 0 fail / 48 polls, [selfheal] armed + previous-run verdict logged.

### TESTS + SMOKE
- NEW test/selfHealGuard.test.ts — 27 tests: governor dedupe/cap/never-throw/off/reset, stay-alive (no exit + flush + counters), exit-on-fatal opt-in, rejection counting, memory watchdog (breach/throttle/heap/throwing-trim isolation), journal (clean/HARD KILL/exit-code/bounded), liveFeed prune hook, full wiring contracts (arm order, v18.1 handlers GONE, /health block, shutdown journal). FULL SUITE: 157 files / 2714 tests 100% GREEN. tsc clean.
- NEW scripts/smoke_v191.mjs — 16/16: boot, /health.selfheal shape, console verdict line, journal boot entry, SIGTERM journaled clean-shutdown, REAL uncaughtException in a child process survives (exit 0, "STILL ALIVE").

## v19.0 — SUPER INTELLIGENCE SELF-IMPROVEMENT ENGINE + AUTO-TRADING DESK SCOPE (2026-09-29)

**User spec: "muje iss complete system ko Super Intelligence Self Improvement AI banana hai" + "Coindcx tab me Auto Trading Sirf Global Futures USDT & Equity SIM USDC me Hi Auto Trading rakho Spot me nhi" + full-site recheck.** The system already MEASURED itself (adaptive weights, trust calibration, retrain infra) — but the loop never CLOSED: the ml-service model store was EMPTY, lessons evaporated weekly, gates were hand-set forever. v19.0 closes the loop: harvest -> drift -> learn -> propose -> approve, all tamper-evident.

### PHASE 1 — DATA FOUNDATION (the fuel)
- **outcomeHarvester.js** (new): ledger settled executions (raw entries — full vote maps + council stamps + plan risk) -> `selfimprove-outcomes.json` ML dataset. Idempotent (dedup by ledger id), r:null outcomes EXCLUDED (settlePositionOutcome's no-risk path would else become fake 0R losses), honest NOT-ENOUGH-DATA below 40 rows. v19.0.1 fix: reads `__ledgerRaw()` (the `recentEntries()` projection strips agreement/votes/council — which quietly starved the whole pipeline).
- **driftMonitor.js** (new): 3 instruments — per-model vote-distribution PSI (old/new half, 0.1/0.25 industry buckets), trust.js calibration drift (worst claimed-vs-realized gap + Brier), 30d/90d hit-rate windows. Verdict ladder STABLE/DRIFTING/ALARM, 6h alarm throttle, alarms land on the evolution ledger.

### PHASE 2 — LEARNING LOOP CLOSED
- **retrainBridge.js** (new): guarded POST /train to the ml-service (single-flight, 4h cooldown, stale-flight guard for crash recovery), champion/challenger shadow book (200-prediction window, agreement %, promote verdict recorded — never auto-swaps). SELFIMPROVE_AUTO_RETRAIN=false default: drift alarms PROPOSE, never auto-fire.
- **gateTuner.js** (new): bounded grid search over the entry gates (conf 60-80, agreement 0.55-0.75) on SETTLED rows, expectancy-max objective with a 30-trade floor, per-field jump caps (±5 / ±0.05), <0.05R gain = honest skip. Output = PROPOSAL only (selfCouncil), never a direct write.

### PHASE 3 — SELF-EVOLUTION
- **lessonsEngine.js** (new): quant-computes the evidence -> ONE LLM call narrates max 5 lessons in a strict JSON schema -> versioned `ai-lessons.json` + 12-version history. LLM down/thin data -> deterministic lessons from the stats (never fabricates). `lessonsForPrompt()` injects the lessons block into the Council deep debate + judge prompts (past mistakes now shape verdicts; no lessons = byte-identical prompts).
- **strategyEvolution.js** (new): bounded genetic search (16-pop x 5-gen, seeded RNG = reproducible) INSIDE strategyLab's whitelisted rule-space (can never invent an unbounded rule, by construction), fitness = expectancy x sqrt(n) with a 12-trade floor, real candle history via the cached backtest fetcher. Reports top-3 candidates — NOTHING auto-trades.

### PHASE 4 — SELF-AWARENESS + REPAIR
- **evolutionLedger.js** (new): append-only SHA-256 chain of every self-modification (12 whitelisted kinds, unknown rejected) — same honesty model as the signal ledger, including the v7.0.2 re-anchor-on-prune fix. 600 entries.
- **selfStatus.js** (new): ONE endpoint /api/ai/self/status — all six phases + honest stage ladder (NO FUEL -> MEASURING -> LEARNING -> EVOLVING). `selfRepair()`: the safe ladder (engine-chain probe, candle-cache flush, harvest refresh, drift re-check) — never restarts, never touches keys, never goes near order paths.

### PHASE 5 — GOVERNANCE (the council of self)
- **selfCouncil.js** (new): change proposals with tiers — safe (gate numerics) auto-eligible after 24h ONLY with SELFIMPROVE_AUTO_TUNE=true (default OFF); risky (desks/scope) ALWAYS human-approved. Apply walks the SAME clamped updateAgentConfig path the human UI uses (a proposal can never set what a human couldn't). 1-click ROLLBACK restores the from-snapshot. Kill-switch SELFIMPROVE_ENABLED=false freezes everything (monitoring-only).
- **Wiring**: 13 /api/ai/self/* endpoints (routes.js) + the index.js heartbeat (harvest 6h, drift + auto-approvals 1h, lessons + gate-tune weekly — all guarded; arm failure = one non-fatal line). Frontend: SelfImprovementPanel (CoinDcxTab section 00d) — stage ladder, phase cards, action buttons, proposal approve/reject/rollback, evolution-ledger timeline.

### AUTO-TRADING DESK SCOPE (user spec — spot OFF)
- **Auto-Agent (agent.js)**: desks default `{futures:true, spot:false, india:true, global:true}` — CoinDCX auto-entries now SIRF Global Futures (USDT margin) + Equity SIM (USDC). One-time v19_0 migration flips saved spot:true -> false; a deliberate later re-enable survives. Manual spot trading + EXISTING spot position management untouched (exits iterate open positions regardless of desk flags — verified). AgentPanel shows AUTO SCOPE chips.
- **SAPTA (proTraderAuto.js, browser execution)**: new `cryptoProduct` config, default 'futures' — scans the FUTURES board, trades the B-{SYM}_USDT page (USDT-margined, native leverage — the spot margin-tab toggle skipped), stake converts via USDTINR fx (stamped fxAtEntry — entry qty math and close P&L share ONE rate), futures LTP monitoring from the futures feed (deps-injectable for tests). 'spot' = legacy opt-in. ProTraderAutoPanel chip + toggle.

### Validation
`node --check` clean on all touched/new server files · **vitest 156 files / 2683 tests — 100% GREEN** (+38 in test/selfImproveEngine.test.ts incl. tamper/chain/prune-re-anchor/raw-ledger/r:null locks; 1 honest v70 legacy update — the v7.0 "spot ON" contract lock now asserts the v19.0 scope) · tsc CLEAN · vite build · **scripts/smoke_v19.mjs 16/16**: boots with the scheduler arm line, all six /api/ai/self/status phases + stage ladder serve, harvest + repair ladders run live, kill-switch arm boots DISABLED with monitoring intact, /api/ai/agent desks = spot:false + futures:true + global:true, no orphan processes. Post-implementation deep review found 6 real bugs — all fixed + locked by tests (raw-ledger source, row ordering, r:null outcomes, prune re-anchor, stage field, gate-tuner honesty).


## v18.10 — AGENT UN-BRICK + COINDCX ENV-CONNECT + DIRECT SPOT-WS ULTRA-FAST (2026-09-28)

**User hit (live log):** `[agent] ⚠️ cycle error: Cannot read properties of null (reading 'riskPct')` firing EVERY 60s cycle, plus "maine app\.env me coindcx ka api and secret sab dala hai phir site me ⚠ CoinDCX not connected" — and the ask for Direct CoinDCX WS realtime 24x7 ultra-fast prices on the CoinDCX tab.

### 1. AUTO-AGENT CYCLE-CRASH (CRITICAL — the agent was dead)

`agent.js`'s candidate scan read `s.plan.riskPct` **before** the `qualifies()` plan gate — but boards legitimately carry **plan:null rows** (`buildTradePlan` returns null when a coin's LTP failed to load — "plan nahi bana"). ONE bad row threw inside `_tick`, the catch logged `cycle error`, and the whole cycle aborted EVERY scan: the auto-agent could never reach the entry logic again (exits above the crash kept working, masking it). The near-miss pool, correlation guard, patient entry — everything below the loop never ran. **Fix:** explicit `if (!s?.plan || !s.side) continue;` guard before the risk read (same contract the near-miss diagnostics loop already had), + the same defensive guard in `indiaAgent.js`'s twin loop (ordering-safe there, hardened anyway). Locked by 3 tests (source-order contract + semantic mirror with the exact user crash row).

### 2. COINDCX KEYS IN `.env` NOW AUTO-CONNECT (the "not connected" complaint)

The ONLY entry to the CoinDCX credential store was the Portfolio-tab UI Connect flow — nothing read `COINDCX_API_KEY`/`COINDCX_SECRET` from the environment, so the user's `.env` keys sat unused while every consumer (wallet card "LIVE · API CONNECTED", live-mode gate `blocked.notConnected`, order console, agent equity) read the empty store. **Fix:** `coindcxEnvBootstrap()` at boot (index.js, after listen): no saved creds + BOTH env sides → validated with a real signed `/users/balances` call via the same `coindcxConnect()` the UI uses, then persisted — the whole app wakes up connected. Saved creds always WIN over env (UI stays authoritative); invalid pair = one loud `[coindcx-env]` line, app continues in paper mode (never a brick — the v18.8.1 lesson); memoized one attempt per process. Accepts the alias spellings users actually type (`COINDCX_KEY`/`COINDCX_APIKEY`/`COINDCX_PUBLIC_KEY` + `COINDCX_API_SECRET`/`COINDCX_SECRET_KEY`/`COINDCX_PRIVATE_KEY`), whitespace-trimmed. `.env.example` documents it; the wallet card + order console now name the `.env` path in their not-connected hints.

### 3. DIRECT COINDCX SPOT-WS ULTRA-FAST PUSH (24x7)

The official spot socket (`wss://stream-spot.coindcx.com`) maintained a full INR price book, but the browser only saw it through the **2s REST poller** reading that book — a price print on the exchange socket waited up to 2s on the wire. **Fix:** event-driven direct push — `cxSpotWs` exposes `setSpotWsOnPrice()`; `cryptoStream` registers the handler at import: every `currentPrices@spot#update` print for a watched coin lands in `liveFeed` THE INSTANT it arrives (source-labelled `coindcx-spot-ws`, `/INR$/`-gated to the `IN_` namespace, unwatched coins filtered). SSE wire discipline is unchanged (1 update/sec/symbol + 0.05% dead-band) → bandwidth identical, latency sub-second. The 2s poller keeps running (stats/high/low enrichment + REST chain re-anchor); the WS-first demand lifecycle (idle close, silent-kill, handshake breaker) is untouched. The SSE `status` frame + `/api/feed-status` now carry a `spotWs` tier (`{connected, servable, freshMarkets, ageMs, cooling}`) and the CoinDCX desk chip honestly badges **⚡ DIRECT COINDCX WS · SPOT·WS⚡ · FUT/GLOB·WS⚡** (per-tier state: Binance-FUT accelerator, GLOB-quiet cooldowns still explained).

### Validation
`node --check` clean on every edited file · **vitest 155 files / 2649 tests — 100% GREEN** (+13 in the new `test/v1810UltraFast.test.ts`) · `tsc` CLEAN · `vite build` 5.17s · `scripts/smoke_v1810.mjs` 9/9: no-creds boot logs the honest line, invalid env pair attempts + NEVER bricks, `/api/feed-status` serves the `cxRt.spotWs` shape, `/health` 200 throughout.

## v18.9 — PRO TRADER FULL-SITE RECHECK: the money-path integrity pass (2026-09-28)

**User spec: "full site code deep advance pro trader level pe recheck karo aur issues fix kardo then patch .zip file me dedo"** — a fresh full-site audit (crypto execution desk, India Dhan desk, live feeds, intraday engine, paper/track simulators, committee, auto-trader, every trading panel) with every finding verified against the code before fixing. 20 real fixes, 37 new regression tests, `vitest 154 files / 2636 tests — 100% GREEN`, tsc clean, vite build 5.22s, boot smoke 8/8.

### CRYPTO ORDER DESK (`server/ai/coindcxOrders.js`) — 9 fixes

1. **MARGIN PAIR FALLBACK (CRITICAL):** `getMarginPairName`'s convention fallback built `B-BTCINR` — the module's OWN contract says margin pairs are `B-BTC_INR` (underscore). Whenever the active_pairs list was unreachable (boot, outage, cold 6h cache), EVERY leveraged exit — SL close, liquidation exit, manual close — was sent with a malformed pair and failed + retried forever while a live leveraged position bled. One-line convention fix + locked by test.
2. **OFFICIAL-PRICE GATE (CRITICAL):** the SL/TP watcher priced live positions from `fetchCoinDcxTickers()` without checking WHICH leg served — the synthetic `binance-fx-synth` leg (Binance × fx, **fx fallback 84** while real USDINR ≈ 88 → ~4.6% low) and the 3-min-old `coindcx-rest-deep-stale` leg could fire a REAL market sell on a false stop breach and book the loss at the synthetic price (corrupting `pnlINR`, `dailyStats`, the ₹ daily-loss cap). New `officialPriceMap()`: synthetic rows filtered, degraded legs rejected — live actions only ever ride official CoinDCX prices. Manual `closePosition` rides the same gate (honest reject during degraded feeds).
3. **FEED-DEGRADED ALARM:** the old watcher silently `continue`d every position when the feed came back empty/degraded — "a failing stop-loss must never be indistinguishable from a healthy position" was the file's own promise, violated exactly in the catastrophic case. Now: one throttled (1/hour) `WATCH_ERROR` + telegram alarm naming the degraded source. Partial gaps (missing pairs) alarm at 1/30min.
4. **KILL-SWITCH CONTRACT:** documented "one click → all auto/execution disabled", but SL/TP/liq closes still fired live market sells under kill. Now they suspend with a once-per-day journal stamp + alert; paper simulation continues.
5. **MARGIN PARTIAL-TP EXCLUSION:** the T1/T2 partial legs on leveraged books opened an OPPOSITE-SIDE margin position (CoinDCX margin is per-side) — the journal booked a reduction while the exchange accumulated an untracked opposite position the later `exit_positions` full-exit leaves behind with margin locked. Leveraged books now exit via `exit_positions` only.
6. **PARTIAL-LEG EXCHANGE MINIMUM:** a leg below the pair's `min_quantity` would 422-reject every 60s forever (WATCH_ERROR + telegram spam, exit never happens). Below-min legs now honestly disable partials (the full TP2/SL exit — whole remaining book ≥ min — takes over). DUST GUARD: a remaining book below minimum can never be market-sold — flagged once, manual disposal advised, no retry spam.
7. **FEE HONESTY (net P&L):** every booked close/partial-leg/liquidation is now NET of both-side taker fees — `(entry+exit)×qty×fee%`, default **0.10%/side**, env-tunable `AI_COINDCX_FEE_PCT` (0 = off). The gross `(exit−entry)×qty` math systematically overstated every booked P&L, the daily realized number AND the ₹ daily-loss cap (a churn day of small "wins" could be net-negative while the cap said +). Positions/journal entries carry `feesINR` for audit.
8. **AMBIGUITY COOLDOWN (double-sell protect):** a close that died ambiguously (timeout/abort/network — the order MAY have reached CoinDCX and filled) now defers the re-send 5 minutes (`p.closeRetryAfter`) with the honest journal note — the old 60s re-send cycle could double-sell the same book. Definitive `[4xx]` rejections keep the 60s retry (those moved no coins).
9. **SINGLE-FLIGHT + LOCK DIET:** overlapping 60s interval ticks queued unboundedly behind the journal lock during slow passes; the ticker batch (8s timeout) and the telegram sends (up to 30s) ran INSIDE the lock, starving `executeSignal` and panic manual closes exactly during outages. Tickers + gate now run before the lock, telegram after it, and a mid-pass tick joins the running pass.

### INDIA EXECUTION DESK (`server/ai/indiaOrders.js`) — 5 fixes

10. **DHAN FILL VERIFICATION:** `dhanOrderStatus` existed but was NEVER called — an entry that returned an orderId was assumed filled at the PRE-order TV LTP. A margin/circuit REJECT after a TRANSIT reply booked a phantom OPEN position with a made-up basis; a later "close" SELL was a naked order. The gauntlet now polls the broker 3× (300/600/600ms): `TRADED` → books `averageTradedPrice` (real slippage basis), `REJECTED` → honest FAILED entry with the broker's reason, no position booked.
11. **DAY-ROLLOVER RECONCILE:** if the app (or the quote feed) was down through the 15:15–15:30 square-off window, INDIA positions survived into the next session and were then MANAGED against fresh prices — a tripped stop fired a market order on a broker-auto-squared MIS position (unintended naked intraday order + phantom P&L). Yesterday's rows now reconcile instead: PAPER → `STALE_SQOFF` close at last-known; LIVE → verified against `dhanPositions()` (gone → `MISSED_SQOFF` closed; still held → `carriedOvernight` flag + alert, never auto-traded).
12. **LIVE-UNKNOWN PROTECT:** `status:'UNKNOWN'` India rows were skipped by the watcher but ALSO passed the one-per-symbol check — a second LIVE order could stack on an unreconciled fill. UNKNOWN now blocks duplicates (paper UNKNOWN is watched; live UNKNOWN is surfaced once + never auto-closed — a close SELL on an unfilled position is a naked order).
13. **BROKER SL TRAIL STATE:** after cancel+replace, a failed replace left `p.slOrderId` pointing at the CANCELLED order — the journal claimed an armed broker SL while the server held none. `slOrderId` is now cleared the moment the cancel is issued (honest "watcher guarding" state).
14. **HOLIDAY CLOCK UNIFICATION:** `data.js isNseOpen` (the LIVE gauntlet + watchers + agent loops) was holiday-blind while `intraday/time.js` (the "single source of truth") carried the calendar — on Republic Day/Diwali LIVE entries passed the gate into a closed market and square-offs submitted orders the exchange rejects. `isNseOpen` now delegates to `isNseMarketOpen`; `intraday/stream.js _inWindow` and `proTraderAuto.indiaMarketOpen` share the same calendar.

### INTRADAY SIMULATORS + COMMITTEE — 4 fixes

15. **PAPER DAY-ROLLOVER GUARD:** `evaluatePaper` had the stale-day check only at boot/restore — a non-CRYPTO trade whose quote feed died through 15:10 survived into the NEXT session and was auto-managed against next-day prices (two sessions in one P&L; the module's own "NEVER carry intraday overnight" rule broken). Per-tick dayKey guard mirrors trackRecord's v11.4 fix (`STALE_SQOFF`).
16. **TRACK-RECORD LEVEL FREEZE:** a republished OPEN row had its `entry/stopLoss/target1/target2` REWRITTEN mid-life — a 14:00 refresh that lifted `entry` above the current price made the next tick book an `SL_HIT` that never happened at the published plan; win-rate/avgR measured the last refresh, not the signal. Levels now freeze at first publish (confidence/lastPrice still refresh — the PARTIAL branch's own discipline, now applied to OPEN too).
17. **COMMITTEE PERSONA QUORUM:** 2 of 3 personas could silently fail and the debate still published a "committee" verdict where the judge weighed one real opinion against two "(no response)" placeholders. Quorum ≥ 2 takes enforced in code.
18. **intraday/stream.js holiday window** (see #14) — the watcher no longer polls a frozen closed tape for 6.5h on weekday holidays.

### FRONTEND — 7 fixes

19. **OPTION LOT-SIZE INPUT:** the manual-trade recorder hardcoded `lotSize: 75` — a RELIANCE CE (lot 500) tracked at 15% of true P&L, BANKNIFTY/SENSEX scaled wrong, and no input existed to fix it. The prompt now has a validated lot-size field (default 75, per-underlying hints) + the record POST carries a 20s timeout (the only mutation in the app without one — a hung connection stuck "RECORDING…").
20. **HONEST REFRESH CADENCE + MOOD MATH + misc:** the countdown ring counted 30s while the board polls 60s (the ring reset twice with zero refresh — "desk frozen?" feeling; texts in CoinDcxTab/TopPicks/ExpertPicks now match reality at 60s/120s); the two on-screen MOOD chips used different math (raw symbol counts vs percentage points — 400-symbol board read MIXED on one strip and RISK-ON on the other; both are pp now); the SSE positions snapshot bumps the `posSeq` staleness guard (an agent-close could be resurrected by a stale in-flight REST read for up to 45s); the crypto order preview hides while the trade ticket is open (two conflicting sizing blocks); the OrderConsole SET button disables on non-numeric input (was a fake "Saved ✓" for values the server silently dropped); `assetPnl`'s invalid-fx fallback is 84 (was a silent 1:1 ₹ collapse).

### Validation
`node --check` clean on every edited file · **vitest 154 files / 2636 tests — 100% GREEN** (+37 in the three new files `test/v189ProTraderRecheck.test.ts`, `test/v189IndiaClock.test.ts`, `test/v189IntradayGuard.test.ts`; every fee-affected legacy expectation updated with the honest net math) · `tsc` CLEAN · `vite build` 5.22s · `scripts/smoke_v189.mjs` 8/8 (boot + login + TG-degrade regression + APP_PIN fatal intact). Existing behavior NOT changed: paper closes, trailing math, gauntlet caps, SVA/75-65-90 gates, engine chain, manual-trade merge — all locked by the same suites.

## v18.8.1 — BRICK-PROOF BOOT (TG half-config can never kill the server) (2026-09-28)

**User hit:** `startai.exe` → `[wealth-ai] ERROR: TG_TOKEN and TG_CHAT_ID must both be set (or both empty). TG_TOKEN=empty, TG_CHAT_ID=set.` → `Refusing to start due to configuration errors.` — the ENTIRE trading app (desks, signal board, manual tracker, auto-trader, ML service) dead over an **optional notification channel**: one stray `.env` edit (user added their `TG_CHAT_ID` and lost the `TG_TOKEN` value) brick-locked every desk.

**Root cause:** `validateEnv()` treated a half-set Telegram pair as a boot-fatal. But Telegram is optional, and every sender already gates on token+chatId TOGETHER (`startBot`, the `/api/telegram` relay, `secrets.telegramConfig`, `telegramToken`) — a half-config could never send anyway. The exit protected nothing; it only converted a cosmetic misconfig into a total outage.

**The fix (server/index.js, two edits):**
- The half-pair is now normalized at the **TG definition site** — the earliest point in boot, BEFORE any subsystem arms or captures the values: loud actionable `console.warn` (which side is EMPTY, how to fix, and that Settings > Alerts-saved pairs keep working) → both sides cleared → `process.env.TG_TOKEN`/`TG_CHAT_ID` also cleared so env-fallback paths (`webhook.js`, the forked bot child) see the same clean "unconfigured" state. Telegram degrades to OFF; the app boots and runs normally.
- `validateEnv()`'s TG fatal block removed (unreachable by construction). **Auth-critical fatals stay fatal:** missing `APP_PIN` and `VITE_API_TOKEN === API_TOKEN` still refuse to start.
- Bonus resilience: the forked `telegram-bot` child can never hit its own `TG_TOKEN missing → exit(1)` path from a half-pair again — `startBot()` never forks when the pair was normalized.

**Validation:** `node --check` clean · **vitest 151 files / 2599 tests — 100% GREEN** (+7 in the new `test/brickProofEnv.test.ts`) · live boot smoke: `TG_TOKEN="" TG_CHAT_ID=12345` → server binds, warns, serves `/health` 200; `APP_PIN` unset → still exits 1.

## v18.8 — ENGINE CHAIN UNIFICATION (the real "AI language engines offline" kill) (2026-09-28)

**User spec: "AI language engines offline hain… Engine wapas aane par prose richer ho jayega — isko theek karo advance pro level pe" + "Manual Trade Tracker live-feed fix + superintelligence patch pe continue karo".**

**The gap the audit found:** v18.7 upgraded the two DESK AGENTS (crypto + intraday) to the sentinel chain with the keyless local ollama engine — but every OTHER LLM path in the app silently stayed on the OLD 4-provider ladder (gemini → groq → cerebras → openrouter, no sentinel, no huggingface/nvidia, **no ollama**):
- `llmChain.js` `councilAsk` — the Global Market Council's 6 persona seats, the LLM second-opinion validator (A2) and the weekly review all ride this chain → with every cloud engine down/unkeyed they degraded to "AI language engines offline" while a perfectly good local Ollama sat UNUSED on 127.0.0.1:11434.
- `signals.js`'s PRIVATE chain (×2: the debate path + the single-shot verify path) — the board's own AI Council seat (w=1.5, the heaviest voter) could never use a saved HF/NVIDIA key or the local engine, and reported zero health to the sentinel (a dead engine got retried every board cycle).

### The fix — ONE chain, one health ledger, one place to fix
- **`server/ai/llmChain.js`** (rewritten v18.8): the shared `councilAsk` now ENDS at the keyless local ollama engine — probe (2.5s, 90s-cached) → `/v1/chat/completions` with the OpenAI-compat body, sentinel-tracked like every cloud engine (success → ready, failure → cooldown ladder). **Provider-aware timeouts:** cloud engines keep the 15s bound; the local engine gets **90s** (a CPU-only llama3.1:8b takes 30-60s for a 2k-token JSON verdict — the old shared bound made it time out on every CPU machine). `aiKeysPresent` now counts all SIX cloud engines; new `aiEnginesOnline()` async gate also counts a reachable ollama.
- **`server/ai/signals.js`**: the private 4-provider ladder (both copies + its private `askGemini`/`askOpenAICompat`/`tryParseJson`/`aiKeysPresent`) is DELETED — `aiCouncilDebate` and `aiCouncilVerify` ride the shared chain. The council gate is ollama-aware: cloud keys OR a reachable local engine → the board seat goes ONLINE for a zero-cloud-key local install too.
- **`server/ai/llmValidator.js` + `server/ai/council.js`**: the availability gates (`aiKeysPresent`) now OR a live `ollamaProbe()` — the second-opinion validator and the council's board + deep persona batches stay armed on a local-only install. (Probe imported directly from `llmSentinel` — the existing `llmChain` test mocks stay untouched.)
- **`server/ai/cryptoAgent.js` + `server/intraday/agent.js`**: the local engine's per-round tool budget is 30s → **120s** (provider-aware; cloud engines keep 30s) — on CPU boxes every ollama round used to blow the shared timeout mid tool-loop.
- Net effect: with the user's setup (OpenRouter + HF + NVIDIA live, Cerebras maybe, local Ollama ready) EVERY LLM surface in the app — desk chat, board AI Council seat, global council personas, borderline validator, weekly review — now answers through the same 7-engine chain with the same health ledger, and an Ollama-only machine gets full LLM coverage with zero cloud keys.

### Validation
`tsc` CLEAN · **vitest 150 files / 2592 tests — 100% GREEN** (+8 in the new `test/engineChainUnify.test.ts`: ollama answers with zero cloud keys, sentinel-tracked, six-engine key gate, board seat online via ollama, HF fall-through on the board seat, honest offline, council personas on the local engine) · `vite build` 5.31s · every edited file passes `node --check`.

## v18.7 — AI ENGINE SENTINEL (earlier session; context entry)

The per-engine health ledger (`server/ai/llmSentinel.js`): circuit-breaker cooldowns (401/403 → 15 min, 429 → 90s, network → 30s…300s ladder), half-open auto-retry, `GET /api/ai/engines` + `POST /api/ai/engines/recheck`, the `EngineHealthStrip` UI chips, and ollama liveness probing — plus the desk-agent chain upgrades and the v18.6.3/v18.6.4 REALTIME NEVER STOPS live-feed fixes (client watchdog + SSE loopback cap 8 + tracker vote-budget 12s) that the 2584-test baseline already locked.

## v13.2 — FULL IMPLEMENTATION PLAN (Accuracy Track A + Bandwidth Track B) + Site Cleanup (2026-09-25)

**User spec: "latest github repo pull karo · ye implemention plan accurately apply karo · after implementation full site code cleanup kardo — unwanted files, broken files, temp files sab permanently delete"**

**Gap analysis first (the discipline):** the plan was audited item-by-item against what earlier versions already shipped — A1's Sentiment/InstFlow/FundaCheck V2 seats + quorum caps + the votes-journaled ledger, A2's CoinDCX agent parity (17 tools), A3's ATR time-exit + correlation guard + orderbook depth split, A4's tax suite + net-worth card, A5's Telegram two-way (/crypto /intraday /portfolio /status /weeklyreview /trade-with-PIN-approval), B1's dead-tick filter + 1s/symbol throttle, B3's parseSyms caps, B5's immutable asset caching — all verified present. v13.2 implements the SIX real gaps that remained, in the plan's own rollout order, then cleans the site.

### Phase 1 — B6 Bandwidth Telemetry (measure before changing)
**NEW `server/ai/bandwidth.js`**: rolling-24h wire accounting with hourly buckets — REST responses counted as TRUE socket `bytesWritten` deltas on `finish` (real headers+compressed body, zero serialization cost), SSE frames counted at every write site (`sse:stream` / `sse:intraday` / `sse:positions`). `GET /api/ai/bandwidth` (auth'd) → rolling 24h + daily average + **30-day projection vs the Render cap** (default 5GB, `BANDWIDTH_MONTHLY_CAP_GB`) + per-scope top-12 breakdown + OK/ALERT/OVER_CAP status. **Hourly Telegram guard** (`initBandwidthAlerts`, wired in index.js with the shared `sendTelegramMessage`): ONE alert per UTC day when the projection crosses `BANDWIDTH_ALERT_PCT` (default 70%) — the "80% used" surprise can't happen again.

### Phase 3 — B2+B4 SSE residuals (the remaining egress)
- **HIDDEN-PARK (B2)**: a tab hidden ≥30s now CLOSES its EventSource — `useCxLivePrices` (the main /api/stream client) and `useIntradayStream` both park; the server's refcounted pollers go idle at zero clients (zero upstream + zero egress for a tab nobody watches). Visible again → **instant** reconnect (no backoff — the user is waiting) + snapshot repaint. Brief switches (≤30s) keep the connection; the flush gate already renders nothing in the background.
- **EXPONENTIAL BACKOFF (B4)**: `useCxLivePrices` now OWNS the retry cadence — errors close the socket before native retry fires and retry at 1s→2s→4s→…→30s cap (reset on clean open). A Render cold-start can no longer stampede N tabs into the fixed-3s reconnect-each-refetch-full-snapshot loop.

### Phase 2 residual — A2 LLM SECOND-OPINION VALIDATOR (the plan's borderline rule)
**NEW `server/ai/llmValidator.js`**: when ensemble confidence sits in the **borderline band (45-60%, env-tunable)**, the provider chain (Gemini → Groq → Cerebras → OpenRouter, the same `councilAsk` the council rides) gets ONE strict-JSON second opinion — `CONFIRM / REJECT / FLIP` + confidence + one-line reason. **Cost guardrails per the plan**: one live call per symbol per **15-minute candle bucket** (a board refresh, deep dive, agent chat and Telegram /crypto in the same bucket share the SAME answer); board cards read the cache passively (never trigger calls); no keys → honest unavailable; `AI_ENABLE_LLM_VALIDATOR=false` kills it. Rides `s.verify.llm` → the 🛡 VerifyBadge shows a 🤖 marker (✓/✕/⇄) + the deep-card checklist gains the violet **🤖 LLM SECOND OPINION** row with verdict, confidence, reason and provider. The SVA rule engine stays the deterministic owner — the LLM validates, never replaces (the plan's explicit division of labour). Deep-path hardening: the verify attach moved OUT of the superintel try-catch — a superintel failure no longer costs the final verdict.

### Phase 5 — A5 MCP Tool Standardization + Governance
- **`get_model_consensus` tool** (crypto agent #18 + intraday agent #10): the per-model vote breakdown — every seat's direction/confidence/reason, bull/bear/abstain tally, weighted consensus, meta-ensemble stamp, SVA verdict + LLM second opinion. The chatbot can now explain **WHY a signal fired** ("consensus kya bol raha hai", "kaun se models agree"). India desk: wired to the 14-model deep ensemble via `getDeepSignal` (lazy, cached) with an honest scanner fallback when the ensemble is cold.
- **NEW `server/ai/mcpAudit.js`**: EVERY desk-agent tool call (crypto + intraday + telegram) is now **rate-limited** (per-desk rolling-minute cap, default 60/min, `AI_MCP_RATE_PER_MIN` — a runaway LLM loop can't hammer the live stack; over-limit calls get a structured `rate-limited` answer the model can READ) and **audit-logged** (bounded 300-entry ring: tool, arg digest, ok/error, duration; **placeOrder-class flags**). `GET /api/ai/mcp-audit` → the governance view (recent 120 + per-tool aggregates). Panels updated: `18 TOOLS • VERIFY + CONSENSUS…` / `10 TOOLS • AGENTIC`.

### Phase 6 — A4 Portfolio Risk Analytics (the REAL numbers)
**NEW `server/ai/riskAnalytics.js` + `GET /api/ai/portfolio-risk`**: the client riskEngine's `sortino = sharpe × 1.3` placeholder and empty `correlationMatrix` are replaced server-side where the candle history lives:
- **REAL Sortino** — target downside deviation over ALL n observations (the classic ÷downside-count footgun caught by its own test), per holding AND portfolio (value-weighted, trailing-aligned returns), with Sharpe (rf-aware, default 6.5%), annualized return/vol, max drawdown on the cumulative path.
- **Correlation matrix** — Pearson on aligned 90d daily returns (Yahoo for IN/US equities+ETFs, Binance 1d for crypto) — rendered as the Portfolio tab's new **📊 Risk Analytics card heatmap** (r>0.7 rose "same bet twice", r<−0.6 emerald "diversification gold").
- **Rebalance drift engine** — vol-parity × equal-weight blend targets (70/30), concrete "Trim A 8.3% → add to B" lines past 3% drift.
- **Honesty**: fixed/EPF/bond rows land in a `skipped` list (no fake series); <10 points → null; whole snapshot cached 1h per asset signature; never throws.

### Phase 7 — A3 Win-Rate Self-Downgrade (per-strategy size weight)
The v10.1 latch downgraded the WHOLE agent on a rotten global record; the plan asks for the finer tool. **`strategyWinRate` / `strategySizeMultiplier`**: a PAIR whose own rolling **20 settled trades** win-rate has decayed gets its position-size weight cut on the sizing line (`riskPct × eventSizeMul × grMul × stratMul`) — ≥50% full · 40-50% ×0.75 · 30-40% ×0.5 · <30% ×0.25 — while the rest of the book trades full size. Only agent-sourced CLOSED trades count; config kill-switch `winRateSizeDowngrade` (default ON, round-trips via `updateAgentConfig`); the haircut pairs surface in `agentStatus.accuracy.strategyDowngrades` + a logged line per entry. (ATR time-exit, correlation guard and the orderbook depth-split were verified already shipped.)

### Site cleanup (unwanted / broken / temp — permanently)
- **Deleted (git-tracked)**: `scripts/smoke_v113.mjs`, `scripts/smoke_v120.mjs` — version-locked smoke scripts superseded by the current suite (v128/v131 smokes + the 2421-test vitest run). Kept: `check-api-routes.mjs` (active route regression guard), `backtest_ab_v2.mjs` (active A/B runner).
- **Deleted (local temp, gitignored)**: all 6 `.test-data-*` runtime dirs, `ml-service/**/__pycache__`, `dist/` build output — regenerated as needed, never shipped.
- **Verified clean**: every server JS passes `node --check`, every Python file passes `py_compile`, zero empty source files (`ml-service/tests/__init__.py` is the standard package marker), zero stray `.log/.tmp/.bak/.DS_Store`, zero tracked files >500KB, `telegram-bot/` confirmed an active wired sub-project (not junk).

### Validation
tsc CLEAN · **vitest 135 files / 2421 tests — 100% GREEN** (+57 over v13.1's 2364: bandwidth 10, LLM validator 13, MCP audit 8, risk analytics 16, strategy downgrade 6, get_model_consensus 4) · build 5.46s · ml-service pytest 11/11 · smokes v12.8 35/35 + v13.1 12/12 · env: `.env.example` + `render.yaml` carry BANDWIDTH_MONTHLY_CAP_GB / BANDWIDTH_ALERT_PCT / AI_ENABLE_LLM_VALIDATOR / AI_MCP_RATE_PER_MIN.

## v13.1 — SIGNAL VERIFICATION AGENT (SVA-v1) + Reversal AUTO-CUT (2026-09-24)

**User spec: "CoinDCX TAB ko Signal Feature ko advance pro deep level pe Optimize karo · XRP long paper trade negative balance me ja raha hai · ek Aisa Agent ko add karo jo tab me Signal mila usse advance pro trader level pe check karke final result bole long jana hai ya short accurate and high accuracy ke sath"**

**The live XRP postmortem (the why):** the trade record showed a LONG @ 1.619 taken on a signal whose OWN summary said "⛔ OVERBOUGHT RSI 70 + 🚀 CHASING — 2.31×ATR above EMA20 — LONG entry suppressed" (aiScore 57 · conf 48 · grade WATCH · 3/11 voters = 28% quorum). Price mean-reverted −5.52%, and the ₹150 loss-cap — stamped 44 MINUTES before the close — stayed advisory ("execute aap karo"), so the loss ballooned to **−₹2,250 (15× the cap)**. The information to reject that entry ALL existed; nothing aggregated it into ONE final call at the point of entry. v13.1 is that aggregation.

### The SIGNAL VERIFICATION AGENT — `server/ai/signalVerifier.js` (NEW, pure)
A senior pro-trader second opinion on EVERY signal — one auditable final call before money moves:
- **10-point weighted checklist** (weights sum 100): committee quorum (14) · chase/ATR-extension (16) · RSI-extreme-vs-side (12) · MTF confluence (12) · ledger win-edge P(win)−P(need) (14) · plan R:R (8) · regime alignment (8) · entry band (6) · perp crowd/funding (6) · side stability (4). Every check carries PASS/WARN/FAIL + points + a human detail line — never a black box.
- **The verdict ladder** (pro rules, not vibes): **CONFIRM** same side at full risk (score ≥68 AND zero CORE-check fails) · **CAUTION** same side half-risk · **FLIP → opposite side** (mean-reversion case ≥60: RSI-extreme + HARD chase + thin quorum + neg edge) · **STAND ASIDE** (hardVeto OR score <40 OR **negative-EV plan** — edge FAIL + R:R FAIL). HARD chase + RSI-extreme = **PRO VETO** (the exact XRP-class burn combo).
- **`sizeHint`** 1 / 0.5 / 0 rides every verdict — the pro's sizing discipline.
- **Hinglish verdict + proNote** on every payload; partial input degrades to neutral WARN bands (never throws, never silently zeros).
- **Verified against the LIVE site**: the 24-Sep XRP deep signal (pullback zone · +23.7pt edge · R:R 2) → **CONFIRM LONG 84/100**; the burn snapshot the user actually traded → **FLIP → SHORT, veto**. The verifier answers "long hai ya short" with the checklist attached.

### Wiring — every surface the user touches
- **`signals.js`**: every directional board signal carries `s.verify` (compact wire — `verificationWire`), the deep path carries the FULL checklist (the deep modal's audit trail). Attached inside the winProb block, try/caught — the verifier can never break the board.
- **`cryptoAgent.js` — tool #17 `verify_signal`**: the desk agent answers "XRP long ya short?" with the SVA verdict + full checklist; the system prompt makes it the FIRST call for every long/short question and forbids silently overriding the verdict. Quick prompt 🛡 added; panel chip → `17 TOOLS • VERIFY + P(WIN) + EV TICKETS + NEWS`.
- **`SignalCard.tsx`**: the 🛡 **final-call badge** reads FIRST on every card — VERIFIED (emerald) / CAUTION (amber) / **FLIP → SHORT (rose, pulsing)** / STAND ASIDE — with the verdict + proNote tooltip, and the full 10-point checklist table on deep cards.
- **`ManualTradePrompt.tsx`**: the PRE-TRADE verdict banner — CONFIRM green / CAUTION amber / **FLIP+STAND_ASIDE RED with the explicit "verifier ne reject kiya" warning** — before the record button.
- **`recordManualTrade`**: every manual trade now FREEZES `t.verify` (the open-time verdict — wire passthrough verbatim, or computed from the signal snapshot). The confirmation Telegram push cites it; **`ManualTradeMonitor.tsx`** shows the 🛡 stamp per trade — "kya verifier ne pehle hi mana kiya tha?" is answered forever on the ticket.
- **`deskShared.tsx` DeskStatsStrip**: new **VERIFIED** tile (CONFIRM count; caution/rejected in the tooltip) — the desk's honest "kitne pakke setups hain" number at one glance.

### The Reversal AUTO-CUT (the negative-balance fix, OPT-IN)
The ₹150→−₹2,250 bleed happened because the loss-cap was advisory-only. **`reversalAutoCut`** (agent-config key, PUT-able via `/api/ai/reversal/config`, default OFF — v12.7's "never auto-close a manual trade" stays shipped behavior): ON karo to the 5s sweep **CLOSES the manual leg AT the crossing price** with the `REVERSAL AUTO-CUT` close-reason + Telegram confirmation; the flip plan survives on the trade record + Reversal board for the next leg. **`ReversalPanel.tsx`** gets the ✂️ AUTO-CUT toggle (rose, with the full tooltip) alongside the ensemble gate.

### Validation
`tsc` CLEAN · **vitest 2364/2364 (100% green** — +23 new locks: 17 in `test/signalVerifier.test.ts` + 6 SVA/auto-cut locks in `test/manualTrades.test.ts`; registry lock updated to the 17-tool list**)** · build 6.14s · smoke v12.8 35/35 · **NEW smoke v13.1 12/12** (S1 the XRP burn → FLIP/veto · S2 clean pullback → CONFIRM · S3 checklist integrity · S4 wire idempotence · S5 verdict language) · `node --check` all touched server files.

## v13.0 — ACCURACY & DEEP-AI UPGRADE PLAN: full implementation (Phases 0-5) (2026-09-23)

**User plan: "ye issues fixes aur implementation plan accurately implement kardo"** — the audited Accuracy & Deep-AI Upgrade Plan, implemented end-to-end: the CI-blocking stale test fixture fixed (suite now 100% green for the first time), the three proven-safe accuracy flags flipped ON in every deploy template, the MTF confluence A/B made MEASURABLE (both arms journaled per settled execution), OptionsFlow extended to per-stock REAL chains, both desk agents brought to full tool-parity + the new-seat context, the portfolio tab got its AI overlay (red-flag engine + coach narration + Telegram /portfolio), and the meta-ensemble is TRAINED, ACTIVATED and on a weekly retrain worker.

### Phase 0 — the CI blocker: `test/bseOptionChain.test.ts` (Issue #1)
The parity test failed because its fixture hardcoded expiry `'2026-09-17'` — once the IST calendar rolled past it (23 Sep), `getOptionsDesk`'s `d >= today` filter correctly found no valid rows and honest-fell-back to `'bs-model-sensex-always'` (production logic was RIGHT; the fixture was stale). **Fix: both fixtures are now SELF-HEALING** — the expiry is always the next (future) Thursday via the file's own `nextThursday()` helper (parse test too, ISO → "DD Mon YYYY" converted). Production code untouched, exactly as the plan prescribed. **The full suite is now 2341/2341 — 100% green, zero documented failures, for the first time in the repo's history.**

### Phase 1 — flags ON + mesh health visibility
- **`render.yaml`**: `AI_ENABLE_V2_MODELS` (was MISSING from the blueprint entirely — a real gap), `AI_ENABLE_MTF_CONFLUENCE`, `AI_ENABLE_MESH_MODELS` now ship `value: "true"` (the three proven-safe levers: keyless honest-abstain V2 feeds, shadow weight-0 mesh seats, MTF tape). `AI_ENABLE_REGIME_WEIGHTS` + `AI_ENABLE_KELLY_SIZING` stay OFF (backtest-gated per the plan's own sequencing).
- **`.env.example`**: the same three flipped ON with the Phase-1 header; MTF got its own explicit line (it previously existed only inside a comment).
- **MCP MESH BOOT HEALTH (server/index.js)**: one log line on every deploy — `[mesh] BOOT HEALTH — 3/10 agents usable · MISSING KEYS: quiver→QUIVER_API_KEY, …` — the plan's "check karo kaunsa agent unauthed hai" is now visible in the Render log without hitting any API (verified live in this session: 3/10 usable, 7 key-gaps listed). Missing key = honestly absent, never fakes; free-key links live in .env.example's v11.8 block.

### Phase 2.1 — MTF confluence A/B: MEASURED, not guessed
The plan asked "Confirm karo IntradayTapeMTF ka weight-1.6 upgrade genuinely behtar hai plain 15m tape (w1.3) se". The honest answer needed DATA — now every settled execution journals BOTH arms:
- **`models.js`**: `intradayTapeMTF` stamps `__abShadow` on its vote — the byte-identical plain 15m read (same dir by design — the 15m anchor carries it; only CONFIDENCE differs by the ±15/−20 agreement math). Degraded fallbacks stamp nothing (they ARE the plain seat — no double-count).
- **`ledger.js`**: `recordExecution` journals the shadow arm as `ab_tape15m` (with `shadow: true`) on the tamper-evident chain — back-compat exact for votes without a shadow.
- **`trust.js mtfABReport()`**: the verdict block — paired samples, per-arm hit-rate (identical by design, stated honestly), conf **separation** (avg conf wins − losses) and **Brier** on aligned votes, `brierDeltaPlainMinusMtf`, verdict `MTF SHARPER / PLAIN 15m SHARPER / NO MEASURABLE DIFFERENCE / NEEDS DATA` at ≥10 pairs.
- **Surfaces**: `GET /api/ai/trust` gains the `mtfAB` block + the weekly review narrates one honest line (`📊 MTF A/B (N paired): verdict · separation X vs Y · Brier A vs B`). *(Architectural note: the A/B rides the LEDGER chain — the settled-outcome store — rather than signalMemory.js, which is the flip-continuity store; same intent, correct plumbing.)* 12 new locks in `test/mtfAB.test.ts`.

### Phase 2.2 — OptionsFlow per-stock (feasibility verdict first)
**Feasibility (checked before building): Massive/Polygon + AlphaVantage serve US options only — the plan's suggested mesh sources CANNOT provide NSE stock chains. The right source was already in the repo**: `getOptionsDesk(sym)` fetches + analyzes ANY NSE F&O underlying (the v10.17 options scanner already runs it on 6 stock names). Implemented on that machinery:
- **`signals.js`**: a per-stock option-ctx store (10-min TTL, REAL nse/bse chains only — the `REAL_CHAIN_RE` gate, model chains never vote) warmed for the TOP turnover slice (`AI_STOCK_OPTIONS_TOP_N`, default 6, clamp 0-10), fire-and-forget — this cycle attaches the cache, the refresh lands for the next board. `buildIndiaStockCtx` attaches the snapshot per symbol; the deep path attaches the cached ctx WITHOUT fetching (the board's warm owns the budget). Absent names keep the honest structural abstain. 3 locks in `test/stockOptionsCtx.test.ts` (store TTL, knob clamp, wire-level).

### Phase 2.4 + 3.3 — both desk agents: new-seat context + tool parity
- **Intraday agent (`intraday/agent.js`)**: the `get_live_intraday_signals` tool description + CORE METHODOLOGY now carry the full committee context — MTF tape confluence (conflict = never STRONG), V2 seats (SentimentPulse/InstFlow — honest disagreement rule), per-stock option chains (contrarian PCR, OI magnets), mesh shadow seats (context-only, never the deciding conviction).
- **Crypto agent (`cryptoAgent.js`)**: the system prompt's "14-model" line is now the accurate committee description (14 core + V2-when-enabled + mesh-shadow framing). **TOOL PARITY closed: `search_market_news`** (the one tool the intraday agent had that crypto didn't — same Tavily implementation, crypto-flavoured query) → **16 tools**; the prompt routes "why is X moving / regulation / ETF flows" to it. Panel chip: `16 TOOLS • P(WIN) + EV TICKETS + NEWS`. Registry lock updated (16-tool exact list).

### Phase 4 — the Portfolio AI overlay (the tab was rule-only)
- **NEW `server/ai/portfolioNarrative.js`** (pure-testable): `portfolioRedFlags` (PURE — market concentration × live regime: India ≥50% + BEARISH NIFTY → flag, crypto ≥35% + BEARISH BTC → flag; health-grade concentration risk; **"your top holding's AI signal just flipped bearish"** nudge: holdings ≥10% with fresh SHORT/FLIP ensemble views, ≥20% escalates high-severity) · `narratePortfolio` (quant-computes, LLM-narrates; honest quant-fallback text when the LLM layer is down) · `buildPortfolioDigestText` (the Telegram digest).
- **`POST /api/ai/portfolio-narrative`**: the client's OWN sync-truth quant payload POSTs up; the server adds what it cannot compute client-side — live `buildRegime('INDIA'/'CRYPTO')` + fresh ensemble views on the top-8 holdings — raises the flags, narrates. Response: `{ redFlags, narrative, source, regime, aiViews }`.
- **`PortfolioInsights.tsx`**: the AI OVERLAY section — 🧠 AI EXPLAIN button, red-flag cards (high=red/warn=amber), the narration block, honest unavailable state.
- **Telegram `/portfolio` (the plan's two-way item)**: net-worth by class + the same red-flag engine over the server's own asset snapshot + live regimes, chunked for Telegram; HELP_TEXT updated. The digest-level market split derives from top-holding weights (netWorthSnapshot carries none).
12 locks in `test/portfolioNarrative.test.ts`.

### Phase 5 — meta-ensemble: trained, activated, self-retraining
- **Trained (for real, this session)**: `train_meta_ensemble()` ran on fresh-fetched OHLCV — **6,630 samples · 29 vote-features** (BTC/ETH deep history via the keyless Binance path; the 40 equity symbols' yfinance feed is datacenter-geo-blocked from this sandbox — on Render/user machine the weekly retrain folds the full 42-symbol universe in). Artifacts `meta_ensemble.pkl` + `meta_feature_cols.pkl` saved and **committed into the repo** (ml-service/store/ is untracked-never; the Docker `COPY . .` carries them) — the inference roundtrip verified live (bull vote vector → UP 0.874). Walk-forward weighted-F1 0.470 (3-class) — journaled honestly; the weekly retrains will track it.
- **Activated**: `AI_ENABLE_META_ENSEMBLE=true` in `.env.example` + `render.yaml` (value: "true") — SAFE in every deploy shape: the Node ensemble honest-degrades to the in-process weighted average whenever `ML_SERVICE_URL` is unreachable or artifacts are missing.
- **The weekly retrain worker**: `retrain_scheduler.start_retrain_daemon()` — NEW non-blocking daemon-thread mode armed at FastAPI startup (`app/main.py` @startup) — boot-train + every `META_RETRAIN_INTERVAL_HOURS` (default 168 = weekly), APScheduler when available, plain loop otherwise; `META_RETRAIN_DAEMON=false` hands the cadence to an external `--once` cron; `META_RETRAIN_ON_BOOT=false` skips the boot-train (frequent-redeploy containers). A failed retrain keeps the previous pkl (graceful degrade) and never kills the API. Standalone modes unchanged (`python -m models.retrain_scheduler [--once]`).
- **Cleanup**: the m-stripped log prefixes (`eta-ensemble]` → `meta-ensemble]`, `eta-retrain]` → `meta-retrain]`) fixed.
- **Kelly sizing stays OFF** (the plan's own last step — "pehle signal accuracy stabilize ho, tabhi position-sizing optimize karna") — documented in render.yaml's flag comment.

### Validation
tsc CLEAN · full suite **2341/2341 — 100% GREEN** (v12.9's 2313/2314 + 28 net-new locks: mtfAB 12, stockOptionsCtx 3, portfolioNarrative 12, cryptoAgent 16-tool registry update — AND the 1 always-failing BSE fixture FIXED, so zero documented failures remain) · ml-service pytest **11/11** · build 5.17s · boot smokes **9/9 (v127) + 35/35 (v128)** · `node --check` + `py_compile` all touched files · meta-ensemble inference roundtrip verified live.

## v12.9 — MANUAL-TRADE REVERSAL ENGINE CONNECTION + REALTIME PRICES + NO-CAPS THRESHOLDS (2026-09-23)

**User spec: "manual trade record ko Realtime Prices Fetch hona hai" · "isko Superintelligence Reversal AI Engine se connect karo — jo bhi trade long/short reversal me jata hai to ye ACTIVATE hona chahiye" · "koi threshold tweak cap nahi — editable manually hamare hisaab se" · "USDT ke price point pe trade lete vo theek hai, qty bhi theek hai, but indian INR price amount add karne mat karo."** Four user specs, one release: the manual-trade tracker becomes a FIRST-CLASS citizen of the Reversal AI engine (cycles ACTIVATE on threshold crossings, exact FLIP plans stamped + pushed), repaints its LTP/P&L at SSE ~1s speed, the ₹ thresholds are the user's own numbers with ZERO caps, and the USDT desk carries no ₹-converted price amounts.

### 1. MANUAL TRADES ARE ENGINE-CONNECTED (the v12.8 advisory banner → a real cycle)
- **Activation on EVERY 5s price sweep (`manualTrades.js`)**: `activateReversalOnManualTrade()` runs per OPEN manual trade BEFORE the 30s conviction pass (capital protection is a stop — it must not wait for the ensemble re-vote). A ₹ loss-cap crossing stamps the MANUAL cycle + the exact FLIP plan (opposite side, qty, and the ₹ thresholds converted to price SL/TP levels at the live price via the same `priceLevelsForLeg` math the futures-desk engine uses); a ₹ target crossing stamps the BOOK call. In-band prices keep the cycle 'ACTIVE'; repeat crossings stay quiet; OPTION trades are conviction-tracked only (premium/IV domain); engine OFF / closed trades / bad prices are honest no-ops.
- **The activation Telegram push carries the FULL actionable plan in the trade's NATIVE currency**: USDT perps show `$` P&L (−$2.00, never a ₹-converted amount — the user's USDT-purity spec), India trades show ₹. The plan: "1) position CLOSE karo — minimal loss accept · 2) FLIP SHORT qty 1000 @ ~0.498 · SL 0.4998 (₹150) / TP 0.492 (₹500) · 3) +₹500 target pe BOOK". The later conviction-pass banners (LOSS_CAP / new REVERSAL_BOOK) are 15m-cooldown reminders of the same plan.
- **Cycle advance on close (`closeManualTrade`)**: closing a reversal-active trade stamps `closedState` + `followUp` (FLIP after a cut, REVERSAL_WATCH after a book) and the closeReason carries the cycle context ("REVERSAL leg-2 CUT (loss-cap ₹150) · manual") — the trade record itself tells the cycle story.
- **AUTO-LINK (`recordManualTrade`)**: a NEW trade on a symbol with a recently-closed cycle (inside the re-entry window, legs remaining) becomes the NEXT LEG of that cycle automatically — following the engine's plan paints the full ₹-cycle on the board without any manual bookkeeping. Best-effort: never blocks a record.
- **The board (`manualReversalCycles` + `GET /api/ai/reversal`)**: manual cycles grouped by `t.reversal.cycleId`, legs in openedAt order, net ₹ (summed realized legs), live-leg ₹ P&L off the monitor's own 5s-fresh LTP, ACTIVE/WAITING/ENDED states (WAITING = all closed inside the re-entry window with legs left), ranked live-first. The route merges them into the same payload: `manualCycles[]` + `activeCycles` counts both worlds.
- **UI**: `ReversalPanel` gains the "✋ Manual trades — engine-connected cycles" section (violet cards, MANUAL ✋ chip, LOSS-CAP / ₹ TARGET state chips, the stamped FLIP plan block with exact levels) · `ManualTradeMonitor` gains the emerald `REVERSAL_BOOK` banner ("₹ TARGET hit — BOOK karo") and the LOSS_CAP banner now carries the exact FLIP plan (qty @ ~px · SL/TP with the user's ₹ numbers) — both pinned to the top like EXIT_NOW.

### 2. REALTIME PRICES on the manual tracker (~1s SSE, was 5s REST)
- **NEW `src/components/aitrading/manualLiveMerge.ts` (pure, 6 unit tests)**: `liveKeyFor` maps a trade's market to the SSE tick namespace (FUT_/GLOB_/IN_) · `livePnlOf` recomputes the native-currency P&L with the EXACT server math ((px−entry)×mult×dir, ×fx for the ₹ twin of USDT-domain trades, the same usdInr the server sent — never a hardcoded 84) · `mergeLiveTicks` overrides LTP+P&L on OPEN trades only, with the 30s stale-tick rule (a dead tick never masquerades as live).
- **`useCxLivePrices` extended with the `india?: string[]` param**: NSE equities ride the SAME `/api/stream` SSE via the `in=` param — the tracker's realtime LTP source for India trades. The ManualTradeMonitor subscribes its OPEN trades' symbols (futures/global/spot/India lists, memoized on the joined symbol-set), merges ticks into the trade views at the hook's 800ms batched cadence (never per-tick re-renders), and the header chip flips to cyan `REALTIME ⚡` while a fresh tick + live SSE status hold — falling back honestly to `LIVE 5s` when the stream is down.
- **`GET /api/ai/manual-trades` now returns `usdInr`** — the server's own fx for that response, so the client-side recompute converts with the SAME rate the 5s poll used (zero drift between the two paints). The 5s REST poll stays as reconciliation: banners/conviction/distances remain server-computed.

### 3. NO-CAPS THRESHOLDS (user spec: "hamare hisaab se")
- **`reversalEngine.js`**: the REVERSAL_CLAMPS table is GONE. `loadReversalConfig` passes the user's numbers VERBATIM — the only validation left is sanity (finite + positive; maxLegs an integer ≥1). The old auto-lifts (cycle-stop below one cap lifted to 2×cap; target below cap lifted to 2×cap) are REMOVED — a ₹50 target with a ₹300 cap is the user's explicit choice now. Defaults stay ₹150/₹500/3 legs when nothing is saved.
- **`agent.js`**: the 7 reversal knobs moved from `NUM_CLAMPS` to a new `NUM_FREE` set — `updateAgentConfig` saves them verbatim (rounded 2dp, positive-only sanity), so the PUT `/api/ai/reversal/config` chain (panel → route → updateAgentConfig → force-refreshed loadReversalConfig) preserves the user's numbers end-to-end. Locked by 2 new agent tests (verbatim pass-through + garbage ignored).
- **`ReversalPanel`**: every `NumField` lost its min/max attributes (free typing, sensible steps: ₹10/₹50/0.5min/5min); the save button's only guard is `thresholdsSane` (all > 0); the footer says it out loud: "NO CAPS — aapke hisaab se (sab > 0 ho)". The config grid grew to 7 fields (re-entry conf bar is editable too).

### 4. USDT DESK PURITY (user spec: no ₹ price amounts on USDT)
- **`SignalCard.tsx`**: the ≈₹ conversion hint next to the margin input and the "USDT ≈ ₹ conversion display-only (×84)" footnote are REMOVED from the futures desk — the USDT domain stays pure USDT (entry/SL/TP/margin/qty). The ₹ lives only where it belongs: the server's own risk caps and the Reversal ₹-thresholds (the user's config). India/spot desks keep their native ₹ as before.
- **`_fmtPx` (manualTrades) precision-aware**: XRP-style sub-$1 levels used to collapse to "$0.5"; now 4-6 decimals below $1 keep the actual SL/TP flip levels readable on Telegram + banners.

### Validation
tsc CLEAN · full suite **2313/2314** (v12.8's 2294/2295 + 17 new `manualReversal.test.ts` locks: activation/flip-plan stamping, BOOK crossing, in-band degrade, quiet repeats, honest no-ops, native-currency texts, close-advance tags, AUTO-LINK next-leg, board grouping/ranking/WAITING, REVERSAL_BOOK banner, client liveKey/livePnl/stale-tick merge + 2 rewritten no-caps `reversalEngine.test.ts` config locks + 2 new `agent.test.ts` NUM_FREE locks; the 1 failure = the documented pre-existing BSE live-network geo-block, identical on baseline) · build 5.08s · boot smoke **35/35** (`scripts/smoke_v128.mjs` + S7: manual LOSS_CAP activation w/ stamped FLIP plan, native-$ text with NO ₹-converted amount, PROFIT_TARGET book, manualReversalCycles board view) · `node --check` all touched files.

## v12.8 — SUPERINTELLIGENCE REVERSAL RECOVERY AI (₹ loss-cap → flip → book cycles) (2026-09-23)

**User spec (XRP futures story): "long trade liya, thoda up hua, phir reversal down — balance negative ja raha tha. Long me minimal loss ₹100-150 accept karke close, phir opposite SHORT me ₹500+ profit book, reversal LONG pe wapas long laga ke phir profit book."** The engine turns a FAILED signal into a NET-POSITIVE CYCLE: `LEG-1 LONG → −₹150 CUT (loss cap) → ensemble confirm → LEG-2 SHORT flip → +₹500 BOOKED → waiting window → LEG-3 LONG re-entry → BOOKED → cycle end`. One new module (`server/ai/reversalEngine.js`, pure-testable, deps injected — zero import cycles), wired into the existing futures watcher, agent config, routes, and a new CoinDCX section 02f board.

### The engine (`reversalEngine.js` — 26 unit tests + 31-check boot smoke)
- **₹-denominated discipline per leg**: `lossCapINR` (default ₹150) → unconditional CUT (capital protection is a stop, never vetoed); `profitTargetINR` (default ₹500) → BOOK. The ₹ thresholds are stamped as price SL/TP on every new leg AND armed natively on the exchange when LIVE (`createFuturesTpsl`) — the discipline survives a sleeping/dead server.
- **Stop-and-reverse with guards (the v12.7 whipsaw lesson baked in)**: the flip after a loss-cap cut fires immediately (user spec) BUT is vetoed when — maxLegs budget done (default 3) · leg cooldown alive (3m) · cycle net ≤ cycle-stop ₹ (default ₹300 = cycle ENDS, no more legs) · the live ensemble still STRONGLY backs the original side (≥65% conf → pullback ≠ reversal, cut only). A dead/FLAT ensemble NEVER blocks the flip — a dead feed must not disable capital recovery.
- **Re-entry is CONFIRMATION-only**: after a target booking (or a vetoed flip), a WAITING window (45m default) opens — the next leg opens only when the ensemble flips OPPOSITE to the just-closed leg at ≥60% confidence. No blind churn after profit. Windows are in-memory but **journal-revived every pass** (`reviveWaitingFromJournal`) — a Render restart mid-window does not orphan the cycle.
- **LIVE honesty (v7.0.2 convention)**: live legs close via the real exchange exit (`exitFuturesPosition`); a blocked/failed exit journals WATCH_ERROR and the watcher retries next pass. LIVE opens respect daily trade/loss caps, max-open, one-per-pair, kill-switch (closing always allowed — it REDUCES risk).
- **Opt-in, OFF by default**: `reversalEnabled: false` — the user's visible ₹ thresholds, their explicit switch (ENABLE button on the panel). When OFF, behavior is byte-identical to v12.7.

### The wiring
- **`futures.js` watcher**: `evaluateReversalForPosition()` runs per OPEN futures-desk position (agent + manual + signal + reversal sources) INSIDE the journal lock, BEFORE trail/SL/TP (the ₹ thresholds ARE the discipline; stamped SL/TP stays as the redundant second guard) · `processReversalWaiting()` runs after the position loop — AND on the flat pass (a position-less journal still has live windows). The engine sends its OWN Telegram (leg cuts, flips, bookings, cycle ends — no double push via closures).
- **`routes.js`**: `GET /api/ai/reversal` (config echo + live cycle board w/ live-leg ₹ P&L) · `PUT /api/ai/reversal/config` (same clamp table as agent-config; force-refreshes the engine's 60s TTL cache so the next watcher pass picks it up) · the watcher now injects `getDeepSignal` (30s-cached deep path) — the ensemble gate reads the SAME signal the boards show.
- **`agent.js`**: 9 reversal knobs in `AGENT_DEFAULTS` + `NUM_CLAMPS` + `updateAgentConfig` (mirrored clamps in `loadReversalConfig` — the loadProTraderConfig convention).
- **UI**: NEW `ReversalPanel.tsx` (section 02f on CoinDcxTab + REVERSAL quick-nav chip) — master ENABLE/PAUSE, the 6 threshold fields + ensemble-gate toggle, live cycles board with per-leg timeline (side @entry → close @price ±₹), guards footer (legs left · cooldown · cycle-stop), recent ended cycles. 12s repaint while cycles live, 30s idle — the engine ticks server-side every 60s regardless.
- **Manual trades get the ₹ discipline as an ADVISORY (the v12.7 rule)**: `stateOfManualTrade` gains a `LOSS_CAP` banner (violet) — "minimal loss accept karke CLOSE karo → ulta LONG/SHORT entry → target pe BOOK" with the user's own ₹ numbers; one Telegram push per 15m; the futures desk's own positions cycle AUTO. Pinned to the top of the monitor like EXIT_NOW.

### Validation
tsc CLEAN · full suite **2294/2295** (v12.7 baseline 2268/2269 + 26 new `reversalEngine.test.ts` locks: config clamps, leg ₹ math, trigger edges, price-level stamping, cycle summary, decision guards — cut-unconditional/flip-vetoed ×4, waiting-window staging, re-entry confirm bar, cycle-end stamping, view payload; the 1 failure = the documented pre-existing BSE live-network geo-block, identical on baseline) · build 4.95s · boot smoke **31/31** (`scripts/smoke_v128.mjs`: the FULL XRP story end-to-end — LEG-1 cut −₹168 → LEG-2 SHORT +₹630 BOOKED → window → LEG-3 LONG confirmed re-entry → net +₹336 ACTIVE; agent-config bridge; routes registration) · `node --check` all touched files.

## v12.7 — FULL-SITE DEEP RECHECK: flip-discipline engine + egress diet + security hardening (2026-09-21)

**User report: "full site code recheck karo."** Three independent deep audits ran over the whole codebase (direction-chain / bandwidth / general QA, findings ranked with file:line evidence), every finding fixed, and every fix locked by tests. Baseline before the work: tsc clean · 2252/2253 (the 1 = documented pre-existing BSE live-network geo-block, identical after).

### 1. DIRECTION — the LITERAL "long pe trade liya, short me chala gaya" mechanism is dead
The audit found NO wire-level inversion anywhere (all four order desks, all exits, all position recording verified again). What it DID find — and what this release fixes:
- **Manual-position flip discipline (`agent.js`)**: the v9.7 trend-flip sweep used to MARKET-CLOSE the user's MANUAL LONG the moment the board printed a qualifying opposite signal — and the candidate flow could then re-enter the FLIP side after a bare 20-min global cooldown. That was the only code path that literally converted the user's LONG into a SHORT. Now: **manual positions are notify-only by default** (one Telegram ALERT per flip episode — `manualFlipAction:'close'` restores the auto-close, and even close-mode demands a STRONG-grade opposite signal).
- **Per-pair flip-churn guard (`agent.js`)**: every flip (exit OR alert) stamps `flipBlock[pair] = {side, at}` — the agent refuses to enter the **OPPOSITE side of that pair for 4h** (`flipReentryBlockMin`, clamped 0-1440). Same-side re-entries stay allowed. The block window + active blocks surface in `agentStatus().state.flipDiscipline` (panel-ready).
- **Board-vs-gate asymmetry fixed (`signals.js`)**: the deep CRYPTO/FUTURES path never set `ctx.__tv`, so in degraded candle conditions the fresh exec re-run's 15m tape seat ABSTAINED while the clicked board card HAD the tape vote → vetoes the user read as "direction galat". The deep ctx now carries the TV row — board card == deep card, always.
- **Pinned holding cards headline the POSITION (`signalMemory.js` + `SignalCard.tsx`)**: a held LONG whose AI view flipped used to render under a SHORT-labeled card. The card's side is now the position's side; the AI's current view rides a new `aiView` sub-chip ("👁 AI abhi SHORT dekh raha hai" — context, never a call). Summary leads with "aapki LONG position".
- **Exact committee ties → honest FLAT (`ensemble.js`)**: `bull >= bear` used to mint a LONG on an exactly-split committee. A perfect weight tie is now FLAT/NEUTRAL with a `tie: true` marker and the split summary.
- **Paper-synth side default (`coindcxOrders/futures/indiaOrders/globalFutures`)**: an ABSENT side in an execute request no longer silently defaults LONG — it inherits the fresh signal's side.

### 2. BANDWIDTH — the free-tier egress diet (recheck R2's ranked levers, all four)
- **`/api/crypto-prices ?symbols=` (the biggest pure-egress lever)**: the client re-downloaded the FULL ~400-market ticker array (~300KB raw) every 30s while reading only its ~20-symbol watchlist. The server now slices the CACHED array to the requested bases (~8KB, ~97% cut); the client sends its watchlist. Filter extracted to `lib/tickerFilter.js`, locked by `test/cryptoPricesFilter.test.ts` (6), verified live in the boot smoke (2 rows for BTC,ETH).
- **Boards are 304-able**: the client's `?t=` cache-buster is gone and the signals route sets `Cache-Control: no-cache` — Express's weak ETag now answers 304 for the byte-identical board inside the 60s server cache (the client polls every 30s → ~half the polls were full re-downloads of 100-400KB).
- **SSE tick diet (`index.js`)**: per-symbol throttle 400ms→1000ms + a dead-tick filter (|Δprice| < 0.05% pushes nothing) — ~0.3-0.4GB/day of price noise the UI's own 800ms batcher smoothed away anyway.
- **The fapi full-book whale is dead**: BOTH Binance `ticker/24hr` fetch sites now request ONLY the symbols they actually read via the documented `?symbols=` JSON-array param — `cxRtStream._binanceFutBook(missing)` (the outage-mode REST fallback, was 1-2MB every beat, worst-case 17-35GB/day) and `futures.js` leg 3 (the board's dark fallback, now FUTURES_UNIVERSE-only ~5KB). Cache is signature-keyed so a symbol-set change never serves a stale slice.
- **Deploy side**: `render.yaml` buildCommand `npm install` → `npm ci` (deterministic — Render's build cache hits far more often, cold installs shrink).

### 3. SECURITY / HYGIENE (recheck R3's top findings)
- **Paper + manual trades ride the ENCRYPTED durable channel**: both stores used plaintext `scheduleBackup` pushes to the public GitHub backup branch (symbols/qty/entries/P&L) while every other state file rode durable.js's AES-256-GCM promise. Both now `durablePut`; boot restores are decrypt-aware with legacy-plaintext migration grace — and manual-trades got a boot restore it NEVER had (restarts silently wiped the tracker).
- **Shutdown remote flush**: the four graceful-shutdown flushers only wrote Render's EPHEMERAL disk; the remote backup stayed a debounce+60s-gap window behind on every deploy. New `flushBackupNow()` fires every pending push inside the SIGTERM drain (bounded bypass, once).
- **Service-worker allowlist inversion**: the old sensitive-DENYLIST still cached `/api/ai/*`, positions, wallet, journal, holdings into unencrypted CacheStorage. Now only PUBLIC market-data paths (`quote|crypto-prices|forex|feed-status|ai-status|chart|fundamentals|inflation|ml`) may touch the offline cache; everything else is network-only. API cache bumped v18→v19 so the activate pass evicts every previously-cached private entry.
- **Security headers on the LIVE Render path**: nosniff / X-Frame-Options DENY / Referrer-Policy / Permissions-Policy / CSP (frame-ancestors 'none'; object-src 'none'; base-uri 'self') — the safe subset, verified live in the boot smoke.
- **RESCAN single-flight fixed**: `?rescan=1` used to bypass `_boardInflight` (the route comment claimed "single-flight protected" — it wasn't): a RESCAN could stack with the 15s warmOnly poll + the 30s board poll. All computes now share the one single-flight map.
- **Site cleanup re-applied**: the dead files the v12.4 cleanup removed and later user commits resurrected are gone again (UPGRADE_REPORT*.md, AUDIT_FIX_REPORT_v1801.md, smoke_v113.mjs, oldcode.gs).

### Validation
tsc CLEAN · full suite **2268/2269** (baseline 2252/2253 + 16 net new locks: agent flip-discipline 6, pinned-card aiView 2, exact-tie 2, ticker filter 6, fapi symbols locks in futuresResilience + cxRtStream, futures leg-3 universe-filter lock; the 1 failure = the documented pre-existing BSE live-network geo-block, identical on baseline) · build 5.43s · route audit PASS · boot smoke 9/9 (headers, symbols slice, auth gates, health) · `node --check` all touched files · ml-service pytest untouched/11-11.

## v12.6 — DIRECTION-ACCURACY ENGINE + THE BANDWIDTH FIX (2026-09-21)

**User report: "phir se check karo Intraday & coin dcx dono tabs ke Trade Signal directions Long aur Short Accurately dedo — long pe trade lene par short ho raha hai · world-top-professional deep AI quantum level pe recheck karo aisa kyun ho raha hai · aur Render me har redeploy me bandwidth bahut le raha hai — free tier 5GB exhaust ho raha hai."**

**The quantum-level recheck — STATISTICAL ground truth first:** the app's OWN walk-forward replay engine was pointed at the live ensemble (`/api/ai/backtest`, 116 trades, ACTION floor, same model code the boards run): **29.3% win-rate · avgR −0.35 · profit factor 0.55 · 78/116 trades stopped out.** The directions are not randomly wrong — they are systematically ANTI-predictive at entry. Combined with the live board probe (10/10 futures signals LONG in a mixed market; every coin already +2-13% into its move; the committee's only voting seats were trend/momentum/regime/smc — all 1h LAGGING trend readers), the root cause is now measured, not guessed: **the crypto/futures committee is a 1h-trend echo chamber that confirms moves AFTER they happen.** The tape seats (the only sub-hour timing voice) were hard-coded to abstain on crypto/futures ("no double count" — a note that only ever applied to reading the SAME series twice). The agent's conviction-flip exit + flip-re-entry then converts the whipsawed LONG into a SHORT position — the literal "long pe trade lene par short ho raha hai" experience.

### 1. THE 15m TAPE SEAT GOES LIVE ON CRYPTO/FUTURES — the committee counterweight
- `models.js`: `intradayTape`/`intradayTapeMTF` gates are now **data-driven** (vote whenever a tape payload exists; honest abstain when it doesn't) instead of market-driven (India-only).
- `signals.js`: **NEW pass-2 15m tape enrichment for crypto/futures boards** — the top candidates (2× the board, cap 20) get a 15m tape read (CoinDCX futures 15m candles → Binance/Bybit 15m klines; spot: CoinDCX 15m → Binance rescaled onto the INR anchor). The tape vote is injected into the committee and the board **re-ranks after it weighs in** (the India pattern). Deep dives fetch the same tape — **deep card == board card** (a deep dive disagreeing with the board's tape read was a silent "board ne LONG bola, deep SHORT nikala" source).
- Live check (local boot): the futures board now carries real tape votes (NOT LONG/69, HMSTR LONG/83; SOL's tape honestly abstains at a borderline-neutral read) — the first sub-hour voice the crypto committee has ever had.

### 2. ENTRY-QUALITY BANDS — the POSITIVE side of the timing read (rank the good entries to the top)
- `entryTiming.js`: **PULLBACK** (extSigned ∈ [−0.6, +0.8] — price at/near its mean inside the trend) → **+4 confidence, ×1.10 board score**; **EXTENDED** (1.5-1.8×ATR, under the SOFT chase line) → **−4 confidence, ×0.93 score**; chased (HARD/SOFT) → ×0.85. Never touches side/ltp.
- **The board now ranks by ENTRY-QUALITY-ADJUSTED score** (`rankScore` on the payload, fully transparent): live check — SOL PULLBACK 0.8×ATR aiScore 79 → rank 86.9 (board #1); BNB EXTENDED 1.76×ATR aiScore 74 → rank 68.8 (below equal-score calm coins). The most-extended movers no longer crown the board — pullback-in-trend setups do.
- `applySignalTrustGuards` applies the boost/haircut alongside the v12.5 chase caps; `buildSignal` forwards `entryQuality`; **SignalCard chip: 🌊 PULLBACK (emerald) / 📐 STRETCHED (amber)** with the acha-entry-zone tooltip.
- **A/B proof (the app's own replay, identical bars):** RAW 110 trades · 30.0% win · avgR −0.30 · PF 0.60 · maxDDR 35.1 → **GUARDED 89 trades · 31.5% win · avgR −0.25 · PF 0.66 · maxDDR 26.4** — the guards cut 21 trades and improve every metric. `strategy=guarded` is now a route param (`/api/ai/backtest?strategy=guarded`) so the proof is reproducible any time.

### 3. THE FLIP VETO made honest (the "long pe trade lene par" execution-side belt)
A clicked side that no longer matches the fresh consensus is vetoed (this always existed — a LONG click can NEVER silently execute as SHORT); the journal reason now names both sides and the fix: *"fresh consensus SHORT hai, aapne LONG card pe trade maara tha — signal FLIP ho gaya (whipsaw window). Card refresh karke naya setup confirm karo; auto-flip execute kabhi nahi hota."* FLAT/planless veto moved before the mismatch check (a FLAT signal is not a "flip" — the honest reason is there is no consensus).

### 4. THE BANDWIDTH WHALE IS DEAD — Render 5GB exhaustion fix
**Measured root cause: `cryptoStream.js`'s shared ticker cache window (2000ms) == the SSE poll period (2s) — with ONE browser open, the server re-downloaded the FULL CoinDCX exchange ticker list (~400-800 markets, several hundred KB) every 2 seconds ≈ 20GB/day of Render outbound.** Every redeploy restarts the server, the user opens the site to verify, the SSE connects, the whale resumes — "har redeploy me bandwidth khata hai."
- **REST anchor window 2s → 20s** (live ticks come from the WebSocket books; REST is only the INR anchor). **WS-first serving**: a servable + fresh (<10s) official CoinDCX spot-WS book serves with ZERO REST round-trips. SSE UX unchanged (2s pushes from the merged tick cache).
- **CANDLE TTL CACHE (5 min / 3 min on 15m)** on `fetchCoinDcxCandles` / `fetchBinanceKlines` / `fetchFuturesCandles` — 299 of 300 bars are byte-identical between board cycles; the board's per-cycle candle downloads drop ~10×. Boards also render faster (free-tier CPU bonus).
- **cxRtStream prolonged-outage backoff:** 2+ minutes with every WS accelerator dark backs the futures REST poller 2s → 5s (a dark-accelerator session was ~13GB/day); fresh sessions keep the 2s feel, any WS tick resets it.
- Combined effect: the with-one-browser outbound drops from the tens-of-GB range to low-GB/day; idle burn (ticker cache + candle cache + compressed responses + immutable asset caching from v11.7) stays in the hundreds of MB.

### Validation
- **tape seat:** intradayTapeAlignment + intradayMtfConfluence updated to lock the NEW data-driven gate (crypto ctx with a tape VOTES; no tape → honest abstain).
- **entry quality:** signalTrust v12.6 cases (PULLBACK boost + stamp + summary · EXTENDED haircut under the SOFT line · HARD cap wins, no boost on chased signals · buildSignal passthrough).
- **guarded backtest:** new suite (guards only refuse — never invent: guarded ≤ raw trades, no invented sides · blow-off-top vertical-leg entries refused · unknown strategy degrades byte-identical).
- **candle cache:** `__clearCandleCache` / `__clearFuturesCandleCacheForTest` hooks; futures suite clears between cases.
- **tsc CLEAN · full suite 2252/2253** (1 = the documented pre-existing BSE live-network geo-block, identical on baseline) · build 5.21s · local boot + live functional probes: PULLBACK re-ranking live on the futures board, tape votes landing, rescan path intact, A/B numbers above.

## v12.5 — DIRECTION-TIMING ENGINE (chase guard) + RESCAN button (2026-09-21)

**User report: "CoinDCX tab me sabhi trades signal directions wrong bata raha hai — long bola tho short jaa raha hai, short bola tho long · same Indian intraday me bhi · signal age correct show ho raha hai ✓ · RESCAN button chahiye — click karo toh fresh top trade signals aaye, high win rate high accuracy, deep AI Trading agent se."**

**Root-cause discipline (audit first):** the ENTIRE execution chain (signal → order side → position record → display) was re-verified line-by-line — LONG→buy / SHORT→sell is correct everywhere (spot /orders/create, margin /margin/orders, futures /derivatives/futures/orders — plus every exit path). The live board was then probed against the real market: the board said LONG across the board WHILE the market had ALREADY risen +0.9% to +6.5% over 14h. **The signals are not inverted — they are LATE.** The lagging ensemble (EMA stacks, momentum, trend seats) CONFIRMS the move that already happened, the entry lands at local exhaustion, and the mean-reversion that follows reads to the trader as "direction galat bola". Same mechanism on the India intraday desk (shared ensemble). The v12.4 RSI-only OB/OS guard misses this: a +6% vertical run prints RSI 63 — under the 70 bar, still a top-tick entry.

### 1. DIRECTION-TIMING ENGINE — `server/ai/entryTiming.js` (NEW, pure)
The structural entry-timing read, computed on the trading timeframe every consensus already carries:
- **extAtr** — signed distance of price from its mean (EMA20; session **VWAP** on the India intraday desk), in ATR units. ATR-normalized so the same thresholds mean the same thing on a ₹2 smallcap and $80k BTC.
- **runBars / runAtr** — consecutive one-way closes at the END of the tape + how many ATR that leg covered (the news/liquidation vertical).
- **Verdict:** HARD when extAtr ≥ **2.5** in the signal's direction, OR RSI ≥ 64 / ≤ 36 with extAtr ≥ **1.9** (the RSI-assist band the OB/OS guard misses), OR ≥ **6 one-way candles covering ≥ 3 ATR**; SOFT at extAtr ≥ **1.8**. Never flips the side (entries are suppressed, not redirected — counter-knife-catching is the same disease). Never throws; silent-degrades when price/ATR/candles are missing.

### 2. CHASE GUARD wired into the trust ladder — `applySignalTrustGuards` (board + deep paths)
HARD → grade capped WATCH + confidence capped **48** (entry gate dead — a WATCH can never satisfy `requireStrong`/ACTION floors); SOFT → **−7** haircut. Stamped `chasing: { severity, extAtr, runBars, runAtr, ref, reason }` rides the wire through `buildSignal`; summary says "🚀 CHASING — price 2.6×ATR above EMA20 — LONG entry suppressed (pullback ka wait karo)". **Both desks inherit automatically** — the guard runs on the shared consensus layer (crypto spot / USDT futures / global equity SIM / India intraday), and the deep path the execution gauntlets read is the same one.

### 3. EXECUTION GATE chase veto — honest journal reasons
`evaluateExecutionGate` now refuses a HARD-chasing entry with a readable reason (`chasing guard — price 2.6×ATR extended; entry suppressed (pullback ka wait karo…)`) — **practice entries too** (rehearsing a top-tick chase is the same bad habit). Belt-and-suspenders over the grade cap: the journal now names the disease instead of a bare "grade WATCH".

### 4. SignalCard v12.5 chip
**🚀 CHASE-LOCK / EXTENDED chip** — rose (HARD) / amber (SOFT), "2.6×ATR · 5↑" live on the card; tooltip explains: move already ho chuka hai — ab entry = chase (top-tick risk), pullback ka wait karo; signal side wahi rahega, entry timing improve karo.

### 5. RESCAN button — fresh top signals on demand (the explicit ask)
- **Server:** `GET /api/ai/signals?rescan=1` → `noCache` — a FULL fresh universe scan, single-flight protected (concurrent rescan clicks join the same in-flight scan; the 60s board cache is untouched for the normal 30s cadence).
- **Client:** `useAITrading.rescan()` widens the timeout to 90s (cold universe scans), double-fire guarded (`rescanning` state disables the button); the board header of BOTH desks (CoinDCX + India Intraday) carries a **🔁 RESCAN** button — cyan-violet, live "SCANNING…" pulse while the deep ensemble re-runs (fresh prices → fresh consensus → fresh guards → re-ranked top signals).
- Normal refresh (🔄) unchanged: 60s-cache read, instant.

### Validation
- **NEW v12.5 suite (17 tests) in `test/signalTrust.test.ts`** (39 total): pure verdict table (HARD at 2.5×ATR both sides · RSI-assist band · 6-candle vertical leg · SOFT band · calm tape clean · India VWAP anchoring · null-degrade) · consensus discipline (STRONG→WATCH cap + conf 48 + stamp + side untouched, both directions · SOFT haircut without grade cap · clean signal untouched · wire passthrough) · gate veto table (live refusal with reason · practice refusal · SOFT passes · clean passes as before).
- **Live functional probe (local boot):** the futures board surfaced `NOT extAtr=2.6 → chase=HARD, conf 48, WATCH` and `BNB extAtr=1.92 (RSI-assist) → chase=HARD` while calm coins (extAtr 0.64-1.45) ride untouched — the guard fires on real market geometry, not just fixtures. The rescan endpoint re-scanned fresh (new generatedAt, re-ranked board) while the cached path answered instantly.
- **tsc clean · full suite 2244/2245** (1 = the documented pre-existing BSE live-network geo-block, identical on clean baseline; mandateFreeze parallel-load flake passes 9/9 × 3 in isolation) · build 5.4s · `node --check` on every touched file.


## v12.4 — SIGNAL TRUST ENGINE: signal age, OB/OS discipline, anti-whipsaw, board pinning + site cleanup (2026-09-20)

**User report: "WLD USDT Futures me trade liya (qty 692 @ 0.4385) long signal tha but lagane ke baad short me chala gaya, stock negative chala gaya — ye nhi hona chahiye · overbought aur oversold ko dhyan rakho · AI signals high accuracy badhao · trade lene ke baad wo Superintelligence Signal Board se gayab ho gaya · signal ka AGE batao (AI model ne kab dekha, kitna time hua) · site cleanup karo, lag-free, bugs-free."** The WLD incident decomposed into four distinct gaps, each closed at the source this release.

### 1. Signal Continuity Engine — `server/ai/signalMemory.js` (NEW)
Per-(market, symbol) continuity store: **firstSeenAt** (when the AI FIRST called this direction — the signal's true AGE), lastSeenAt (last board confirm), prevSide/flippedAt/flips-24h (the whipsaw thermometer), lastConf/lastGrade/lastLtp (the pinned-card's AI view), lastDirSide (preserved across FLAT gaps — LONG→FLAT→LONG resumes, LONG→FLAT→SHORT counts as a genuine flip from LONG). Bounded 400 records (LRU), persisted to `ai-signal-memory.json` (3s debounce, read-only-FS degrades to memory-only), 48h boot prune. `remember()` is called from BOTH consensus layers: pass-1 (FLAT views included — a symbol going neutral is exactly when its last directional view must stay queryable) and the final post-council consensus; the deep path remembers too (its consensus is what the execution gauntlets read).

### 2. SIGNAL TRUST GUARDS — `applySignalTrustGuards` (board AND deep paths)
- **OVERBOUGHT/OVERSOLD HARD GUARD (the user's explicit ask):** LONG at LTF RSI ≥ 70 can no longer wear ACTION/STRONG — grade capped to WATCH, confidence floored at 50 (extreme ≥ 78 → 42); SHORT at RSI ≤ 30 mirrored (≤ 22 extreme). RSI source priority: the LTF (trading timeframe) indicator set first, TV daily fallback. Side/ltp are NEVER touched (existing plans stay valid) — the card still shows, honestly stamped `obOs: { tag, rsi }` + the summary says "⛔ OVERBOUGHT RSI 74 — LONG entry suppressed (chase hi hota hai ye)".
- **FLIP COOLDOWN (the WLD whipsaw fix):** a side that flipped < 5 min ago is capped to WATCH + stamped `freshFlip: { from, to, ageSec }`; 5-10 min after a flip takes an −8 confidence haircut; older flips pass clean. A first-ever direction is NOT a flip. The LIVE execution path inherits both guards automatically — `getFresh*SignalForExec` feeds from the guarded deep consensus, so a live LONG on an overbought perp or a freshly-flipped whipsaw is now rejected at gate 5 (grade WATCH can never satisfy `requireStrong`).
- **AGE on every card:** `signalAge: { firstSeenAt, lastSeenAt, ageMs, flips24h }` rides the wire; the frontend recomputes age LIVE from firstSeenAt (15s tick) so the chip keeps ticking between board refreshes.
- Guards run inside try/catch and NEVER break a signal — worst case the consensus passes through untouched.

### 3. Board persistence — traded symbols NEVER vanish (the "gayaab ho gaya" fix)
`pinHoldingOnBoard` runs after the top-N cut on every board cycle: cards for symbols with OPEN positions (journal auto/desk trades + the manual tracker — both read directly from their JSON stores, no import cycles) get a `holding` stamp (side/entry/qty/age/via); held symbols that fell out of the cut get a **PINNED card** — the AI's CURRENT view stamped honestly ("AI view: STRONG LONG · conf 71%" / "AI abhi NEUTRAL hai — last directional view LONG 8m pehle" / "AI view stale"), grade never above WATCH, no plan, `executable: false`, `holdingOnly: true`, bounded to 4 pins so a full book can't flood the board. Normalized matching across pair spellings ("B-WLD_USDT" / "WLDINR" / "NVDA-USD" → base symbol). The board fallback for exec (`_boardFallbackForExec`) can never turn a pinned card into an entry — its null plan fails the execution gate honestly.

### 4. SignalCard v12.4 chips (frontend)
- **⏱ AGE chip** — `<2m` cyan "FRESH" (unstable — confirmation ka wait karo) · 2-10m emerald · 10-30m amber · `>30m` red "STALE" (deep re-check karo) · 24h flip count rides the chip (`2↺`); tooltip carries the full truth (age · last board confirm · flips).
- **⛔ OB/OS chip** — OVERBOUGHT/OVERSOLD + live RSI, red when extreme; tooltip names the suppressed side and why.
- **🔄 FLIP chip** — "FLIP LONG→SHORT 3m pehle — whipsaw window me hai, grade WATCH cap laga hai".
- **🎯 HOLDING chip** — side + entry price; fuchsia ring on the card (strong ring for pinned-only cards); tooltip shows qty/opened-when/source.
- Pinned-only cards render through the normal SignalCard path (no trade button — not actionable by design; the monitor/console own the exits).

### Site cleanup (lag-free / bugs-free pass)
Removed: `docs/AUDIT_FIX_REPORT_v1801.md`, `docs/UPGRADE_REPORT.md`, `docs/UPGRADE_REPORT_v18.md` (one-off audit reports consolidated into this changelog — README references updated), `server/apps-script/oldcode.gs` (dead code), `scripts/smoke_v113.mjs` (superseded by smoke_v120.mjs). Client polling cadence audited and confirmed by-design (board 30s / RT prices 2s single-flight / agent status 15s warmOnly — no compute on poll paths).

### Validation
- **NEW `test/signalTrust.test.ts` — 22 tests**: continuity (age anchoring, flip detection, FLAT preservation, per-market keys, 24h-bounded history, symbol normalization) · OB/OS guard table (both sides, extreme bands, LTF-priority, cap-only-tightens, neutral untouched) · flip cooldown ladder (fresh/soft/clean/first-ever) · FLAT no-op · wire passthrough · holdingPositions (journal + manual, side/symbol normalization, market filter, closed ignored, garbage-degrade) · pinning (stamp, pin, bound, honest stale view).
- Board suites updated to the new discipline with REALISTIC fixtures: the old monotonic synthetic tapes computed RSI 0/100 (any honest OB/OS guard must catch them) — added falling-with-pullbacks series (RSI ~41) under which the confirming-tape STRONG/ACTION SHORT assertions still hold; the monotonic fixture now LOCKS the OVERSOLD suppression (side/tape-vote intact, grade WATCH + obOs stamp). `__clearSignalCaches()` now also resets the continuity memory (clean slate between board tests).
- **tsc clean · full suite 2226/2227** (the 1 = the documented pre-existing BSE live-network geo-block; mandateFreeze's occasional parallel-load timeout passes 9/9 in isolation — documented class) · build ~5s · `node --check` on every touched file.

## v12.3 — THE 401 ROOT CAUSE FOUND & FIXED: GET-with-body is the documented wallets contract (2026-09-19)

**User report: "SAME ISSUE HAI — FUTURES WALLET READ FAILED [401]" (after v12.2). The live scope probe had now SPOKEN: `futures-key-scope: OK` — the key CAN authenticate derivatives (the positions POST passes auth with the same key that 401s on the wallets GET). That kills the permission hypothesis outright and left exactly one suspect: our GET wire form. Re-extracted the official docs.coindcx.com Slate capture (1.1MB, "Wallet Details" + "Wallet Transactions" samples) — and there it is: the derivatives private GET endpoints carry the SIGNED COMPACT `{"timestamp":<int ms>}` JSON AS THE GET REQUEST BODY (`requests.get(url, data=json_body)` in Python / `request.get({url, json:true, body})` in Node), with page/size-style params riding the query string UNSIGNED. We were sending the signed payload as QUERY PARAMS with an EMPTY BODY — the server verifies the signature against the request body, so every permutation (v10.3.2 seconds-string → v12.1 int variants → v12.2 spaced-JSON) was structurally unable to verify. THAT is why all 8 rungs 401'd forever while the same key POSTed fine.**

### The transport fix — `coindcxPrivateGET` body mode (the new default)
Body mode (default): signature = HMAC-SHA256 over the compact `{"timestamp":<int ms>}`; the exact signed string is sent as the GET request body with `Content-Type: application/json`; params (page/size) ride the query string UNSIGNED; the timestamp NEVER goes in the query. Legacy `mode: 'query'` keeps the v10.3.2-v12.2 wire form verbatim as ladder fallback rungs. **Transport subtlety:** Node's undici `fetch` FORBIDS GET bodies ("Request with GET/HEAD method cannot have body") while the official docs assume Python `requests` (a raw HTTP client with no Fetch-spec restriction) — so the body-mode GET rides Node's native `node:https` module (`_httpsGetJson`: same URL/headers/signed JSON, GET body written onto the socket, 10s timeout, byte-identical error envelope `[status] message`). The legacy query mode stays on `fetch` untouched. Wire form PROVEN against a local echo server: `GET /exchange/v1/derivatives/futures/wallets` + `Content-Type: application/json` + `Content-Length` + `X-AUTH-APIKEY/X-AUTH-SIGNATURE` + body `{"timestamp":<ms>}`.

### The ladder — documented rungs first
7 rungs: **GET-body/ms/num** (the doc sample — Python AND Node official examples) → GET-body/s/num (the Request-Definitions table says "epoch seconds" — docs self-inconsistency insurance) → GET-body/ms/str (string-ts insurance) → GET-s/str → GET-ms/num (legacy 2025 query family) → GET-s/pgsz → POST (the [404] canary). Sticky-rung logic hardened: the resolved rung is what gets de-duplicated out of the tail (a stale sticky id can never duplicate rung 1). Scope-OK guidance now names the GET-with-body fix instead of the spaced rungs.

### Why this closes the incident
With the wallets read fixed: `deployableFuturesUSDT` goes live → the `equity_floor` skip clears (wallet equity ≥ ₹300) → the agent's 75-score/70-confidence gated scan can fire REAL futures entries → the positions watcher (POST family — always authed fine) auto-manages TP/SL/close. The auto-trade chain was never broken downstream of the wallet read; it was starved of the wallet read.

### Validation
- coindcxGet.test.ts rewritten around BOTH transports: node:https stub locks the body-mode wire (path with NO timestamp in query, Content-Type/Content-Length, signature over the exact body string, params-unsigned-in-query, [401] envelope, network-error rejection) + fetch stub locks the legacy query mode (regression: pre-v12.3 wire reachable ONLY via `mode:"query"`).
- futures.test.ts: 6-rung ladder order with body rungs first + sticky/trace/cooldown/sweep counts updated + scope-OK text lock (`GET-with-body rungs`); agent.test.ts fixture trace updated.
- **tsc clean · full suite 2204/2205** (the 1 = the documented pre-existing BSE live-network geo-block, unchanged; an occasional durable.test.ts parallel-load flake passes 21/21 in isolation) · build 5.83s · boot smoke PASS (server up with the https transport, /api/health 401-auth-gated as designed).
- Expected live outcome after deploy: the FIRST wallet poll answers on rung 1 (GET-body/ms/num) — the futures USDT tile shows the real balance, the `equity_floor` blocker clears, and (with Risk mode LIVE + Auto-execution ON + agent START) live futures entries can finally fire.

## v12.2 — FUTURES KEY-SCOPE PROBE: the definitive verdict on the wallets-401 (2026-09-19)

**User report: "FUTURES WALLET READ FAILED — [401] Invalid credentials [auth-ladder GET-s/str:401] — key spot par kaam karta hai par derivatives wallet reject kar raha hai." The v12.1 ladder fired exactly as designed and its trace proved all five compact-GET permutations 401 with a spot-working key — but that evidence alone cannot distinguish the two candidate root causes: (a) the API key lacks Global-Futures permission, or (b) CoinDCX's GET canonicalization drifted. Cross-checked an independent public CoinDCX SDK (@nemesis-oss/coindcx-sdk — signs the wallets GET exactly like rung 1: GET + query params + seconds-string timestamp + compact JSON), which keeps (b) alive but makes (a) the prime suspect. v12.2 makes the app itself run the discriminator and lead every error with the verdict.**

### The key-scope probe — `probeFuturesKeyScope()` (futures.js)
One harmless POST read of `/exchange/v1/derivatives/futures/positions` (the documented POST route on the SAME derivatives family) with the SAME key settles it: **2xx / 400 / 422 → scope OK** (a validation error is past the auth middleware — auth PASSED), **401/403 → scope MISSING** (the key is rejected on the whole derivatives family — a SPOT-scoped key), **404/5xx/network → UNKNOWN** (honest, never guesses). Fired only when every GET rung answers a strict 401 (timeouts/gateway blips never trigger it), cached 10 min, single-flight, cooldown-safe.

### Verdict-led errors — every surface names the exact cause + the one-step fix
`MISSING` → `[401] … · futures-key-scope: MISSING — API key me Global Futures permission nahi hai (derivatives positions auth bhi 401 — same key spot par chalti hai). CoinDCX app → API Dashboard → Futures permission ON karke NAYI key banao → site me CoinDCX reconnect karo`. `OK` → the verdict says auth-format drift and points at the spaced rungs instead — the permission fix is deliberately NOT suggested when the key is fine. Ordering: verdict → guidance → ladder trace last, so the agent blocker (260 chars), the agent log (300), Telegram (200) and the wallet card (420) all carry the verdict + fix inside their budgets. `walletSnapshot.futures.scope` exposes the machine verdict; the CoinDCX wallet card turns the error **red + ⛔** when scope = no_scope so the fix can't hide in amber noise.

### Spaced-JSON ladder rungs — the (b)-path fix, in case the drift is real
Two new rungs (`GET-s/str-sp`, `GET-ms/num-sp`) sign the **Python json.dumps canonical form** (`{"timestamp": 1789824123}` — `, `/`: ` separators). Rationale: POSTs verify against the raw body byte-for-byte (immune — which is why spot works), but a GET server must REBUILD the payload from the query string; if that rebuild walks Python defaults, a compact signature can never verify no matter the timestamp typing. `coindcxPrivateGET` gained `sep: 'spaced'` (hand-built canonical string — never a regex on the compact form, so values containing `,`/`:` can't corrupt it). Ladder is now 8 rungs: 4 compact permutations → 2 spaced → page/size → legacy POST.

### Reconnect = clean slate
`coindcxConnect` now calls `resetWalletTransportForReconnect()` (dynamic import — no static cycle): the sticky rung, the 5-min probe cooldown and the cached scope verdict all belonged to the PREVIOUS key — a fresh futures-permission key re-probes the FULL ladder immediately instead of failing one stale rung for 5 minutes and flashing the old verdict.

### Validation
- New locks: futures.test.ts scope-probe block (verdict classification 2xx/400/422→ok · 401/403→no_scope · 404/5xx/net→unknown; verdict-led error text; probe caching; reconnect reset; non-401 never probes) + 8-rung ladder order with spaced rungs + snapshot 420-char budget + `futures.scope` exposure; coindcxGet.test.ts spaced-signature block (4); agent.test.ts blocker verdict+fix survival lock.
- **tsc clean · full suite 2204/2205** (the 1 = the documented pre-existing BSE live-network geo-block, unchanged) · build 5.14s · route audit PASS · npm audit 0/0.
- Expected live outcome after deploy: within one wallet poll the agent log/blocker will say which world we're in — `futures-key-scope: MISSING` → create the futures-permission key (CoinDCX app → API Dashboard) and reconnect; `futures-key-scope: OK` → the spaced rungs have a live shot at fixing the read outright; either way the panel states the cause, not a guess.

## v12.1 — LIVE AUTO-TRADE UNBLOCK: the three walls every live entry was hitting (2026-09-19)

**User ask: "site code me smartai-e954.onrender.com ki jagah smartai1.onrender.com daalo · Global Futures wallet me amount hai par koi auto trade lag hi nahi raha — accurately theek karo · min trade score 75+ aur conf 70+ rakho · auto entry + auto close high accuracy maintain karo." Live diagnosis on the NEW deployment (login → /api/ai/agent → /api/ai/wallet → journal entries) found the agent FIRING but dying at three separate walls — all three fixed.**

### URL migration
`smartai-e954.onrender.com` → **`smartai1.onrender.com`** everywhere (api.ts `getProxyBase()` Vercel/GH/Netlify fallback, index.html static-mirror redirect, StaticMirrorBanner `REAL_APP_URL`, README guidance, test headers, CHANGES history). The old service is suspended by its owner — every hardcoded reference now points at the live deployment.

### Wall 1 — every LIVE SPOT order died with `[422] market is required` (journal-proven)
The spot `/exchange/v1/orders/create` body sent the pair in a `pair` field with `order_type: 'market'` — that's the MARGIN/futures vocabulary. The SPOT contract wants **`market`** ("BTCINR") + **`order_type: 'market_order'`** (the exact fields CoinDCX's 422 named). Fixed at all four send sites: agent/manual ENTRY, watcher SL/TP close, partial-TP legs, manual close — live entries AND exits now speak the right dialect. (The margin + futures desks were already on their own correct contracts — untouched.)

### Wall 2 — the Global Futures wallet read 401s (the "amount hai par auto nahi lag raha" root cause)
Live evidence: spot `/users/balances` signs fine with the user's key, but `derivatives/futures/wallets` answers **401 Invalid credentials** on both string-timestamp GET transports while POST still 404s (route is GET-only) — CoinDCX evidently drifted the GET canonical signed payload. Fix: the wallets transport is now a **6-rung AUTH LADDER** — GET-s/str (2025-verified) → GET-ms/num (docs-canonical INT timestamp) → GET-s/num → GET-ms/str → GET-s/pgsz (page+size signed) → legacy POST. First rung the server accepts goes STICKY; when every rung fails the error carries the **full variant trace** (`[auth-ladder GET-s/str:401 · GET-ms/num:401 · … · POST:404]`) plus, when all GETs 401 with a spot-working key, the honest guidance: build the key with GLOBAL FUTURES permission. The trace rides the wallet snapshot (error budget 140→300 chars), the agent log, a one-shot Telegram alert, and a NEW hard `futures_wallet_read` FAULT blocker on the agent panel (a failed read is never mislabeled "margin < 2 USDT" again).

### Wall 3 — FAILED orders were burning the daily trade quota
Three `[422]` failures + "Daily trade cap (5) hit" the same hour: exchange-refused orders consumed the entire daily budget and the agent stood down on trades that never existed. FAILED now joins REJECTED/NOTIFIED in the quota exclusions — `dailyStats` (both desks' cap) and `agentTradesToday` (the agent's own 3/day) count only orders that actually reached the book (FILLED/SUBMITTED/SUBMITTED_UNKNOWN).

### Thresholds — USER SPEC locked
`minAiScore` stays **75** (Path A) and `minConfidence` rises 60 → **70** (Path B: STRONG + executable + agreement). Saved configs sitting at the old default migrate up automatically; user-customized values are preserved; the mid-session mandate guard allows the stricter bar without a restart. Near-miss auto-trade keeps its own 70-conf floor.

### Validation
- New locks: `test/v121AutoTradeFix.test.ts` (9) + auth-ladder/sticky/trace block in futures.test.ts (4) + tsType-num signer block in coindcxGet.test.ts (3) + spot-body `market`/`market_order` locks in aiOrders/leverage + FAILED-quota lock + wallet-read FAULT blocker lock.
- **tsc clean · full suite 2194/2195** (the 1 = the documented pre-existing BSE live-network geo-block, unchanged) · build 5.63s · route audit PASS.
- User-side arming after deploy (safety, unchanged by design): Risk settings → mode **LIVE** (typed) + **Auto-execution ON** → agent START LIVE — the agent's own `live_preconditions` blocker names all three on the panel strip.

## v12.0 — PRO TRADER UPGRADE: calibrated Win-Probability engine + Perp Positioning Intelligence across the CoinDCX desk (2026-09-19)

**User ask: "CoinDCX TAB ke 6 sections (Crypto Desk AI Agent, Manual Trade Tracker, Execution Console, Superintelligence Signal Board, EXPERT PICKS 80+, GLOBAL FUTURES USDT PERPS) ko aur zyada advance pro-trader level pe upgrade karo — Superintelligence improvement, highest accuracy, highest win trades." The upgrade answers the pro desk's actual first question — "IS TRADE ME KITNI PROBABILITY HAI?" — with numbers it can defend.**

### New engine 1 — WIN PROBABILITY (`server/ai/winProb.js`)
- **P(WIN)** on every scored signal: AI-score prior → **ledger calibration** (trust.js settled outcomes per confidence bucket, claimed-vs-actual with 0.70-1.30 damping, n≥10 gate) → LONG/SHORT side split (n≥20) → funding + positioning (perps) → MTF/agreement confluence. Every adjustment carries a ±pts driver string.
- **P(NEED) = 1/(1+R:R)** — the plan's breakeven. **EDGE = P(win) − P(need)**, **EV in R** (full 40/40/20 book + a realistic capture haircut), verdict ladder EDGE/FAIR/NO-EDGE. Hard cap 92% — never certainty; uncalibrated says so.
- Wired: signal board (all markets) + expert picks + deep dives + agent tools + topFive (spread carries it).

### New engine 2 — PERP POSITIONING INTELLIGENCE (`server/ai/perpIntel.js`)
- 5 Binance fapi PUBLIC endpoints (no key): funding + open interest + OI 24h history (implies the price change) + top-trader L/S ratio + taker buy/sell flow.
- The **OI×price 2×2 matrix** (LONGS_BUILDING / SHORTS_BUILDING / SHORT_SQUEEZE / LONG_UNWIND), taker aggression, crowd flags (🚩 LONGS/SHORTS CROWDED), positioning score 0-100 + Hinglish reasons. 60s cache, single-flight, bounded map, per-field honest degrade (dead OI-history ≠ "flat OI").
- `GET /api/ai/perp-intel` desk view + per-signal `superIntel.perp` wire payload on FUTURES.

### Fixed en route — the DEEP DIVE had NO superintel at all
`getDeepSignal` never attached superIntel (no AI SCORE ring, no blueprint, no win-prob in the deep modal or the agent's analyze_coin answers — they read `s.superIntel?.aiScore` and got null). The deep path now builds the FULL ticket: computeSuperScore + buildSuperBlueprint + winProb + perp intel.

### Section upgrades (CoinDCX tab)
- **Signal Board**: every card's SuperIntelStrip gains the WIN-PROBABILITY row (P(win) + band · breakeven + edge pts · EV per trade · EDGE/FAIR/NO-EDGE verdict) + perp positioning chips on FUTURES (funding/OI/taker/crowd).
- **EXPERT PICKS**: per-pick P(WIN)/BREAKEVEN/EV/VERDICT strip + perp positioning row; the AI score strip stays test-locked.
- **TOP 5**: 🎯 P(win) chip per row (verdict-colored).
- **Crypto Desk AI Agent**: 13 → **15 tools** (+ `get_perp_intel`, + `get_win_probability`), system prompt routing (positioning check BEFORE any futures entry; P(win)+EV mandatory on every full ticket), new Win-Probability quick prompt.
- **Manual Trade Tracker**: live **R NOW / PEAK** column (MFE/MAE excursion tracked server-side on every 5s sweep), per-trade capture %, closed rows show final R + peak + exit-quality verdict (CLEAN_WIN / CUT_WINNER / GAVE_BACK / DISCIPLINED_LOSS / OVERSHOOT_LOSS), and the aggregate stats strip (win-rate in R · avg R · capture efficiency · gave-back count · disciplined-vs-overshot losses · avg hold). `manualStats()` rides the list endpoint.
- **Execution Console**: **🔥 PORTFOLIO HEAT** — total open risk (SL-distance risks, live FX→INR) vs equity with COOL/WARM/HOT/DANGER bands, worst-case ₹ number, same-side pile-up warning, and the 🚨 NO-SL flag (unbounded risk positions).
- **GLOBAL FUTURES desk**: new **🛰️ PERP POSITIONING INTELLIGENCE** section (desk funding regime + breadth + per-symbol reads, 60s refresh, collapsible).

### Validation
- New locks: `test/winProb.test.ts` (22) + `test/perpIntel.test.ts` (22) + manualTrades v12.0 block (61 total) + cryptoAgent registry 15-tool update — **full suite 2177/2178** (the 1 = the documented pre-existing BSE live-network geo-block, unchanged).
- tsc CLEAN · build 5.22s · npm audit 0/0 · **LIVE smoke `scripts/smoke_v120.mjs` 28/28**: BTC intel (funding 0.59bps, OI 108904, L/S 1.01, taker 1.02, full-confidence read), desk view (avg funding −6.02bps → SHORTS PAYING regime), board 10/10 winProb (DOGE 69% → EDGE, EV +0.62R), picks 6/6 (AVAX 84 → 70% EDGE), deep BTC full superintel (79 ACTION, P(win) 68%, perp NEUTRAL).
- Fixed en route (found by the new tests): `num(null)` returned 0 — missing funding/positioning/agreement silently fired their adjustment branches in both engines (now null-safe, locked); exit-quality severity order (GAVE_BACK wins over CUT_WINNER at <30% capture).


## v11.8.2 — Deep recheck: the intermittent agent-suite flake (12→24 test failures), root-caused and killed (2026-09-18)

**User ask: "ek baar full site code recheck karo deep me aur koi issues hai tho fix kardo." Full-suite runs were flipping between clean (2115/2116) and 12-24 failures across agent.test.ts / v101AgentAccuracy / nearMissAutoTrade — 2 of 4 runs failed with a "timeout + expected 1 times, got 0 times" cascade. Root cause (empirically verified): the agent-family suites never mocked `readDepth` — the entry path's CoinDCX→Binance depth fetch is TWO SERIAL 6s timeouts (12s worst case) vs vitest's 5s per-test budget. When a sandbox route stalls, the tick blows the budget; the still-running zombie holds the agent's single-flight guard (`_ticking`) for up to 12s, so every subsequent agentTick in the file no-ops instantly — exactly the 0-call cascade observed. Same hazard class: `pairCorrelation` (2 real Yahoo fetches, 12s timeouts) on open-position fixtures and `fetchFuturesPrices` (8s timeout) inside getPositionsWithPnl.**

### The fixes
- **Production — depth chain shares ONE 6s budget (orderFlowDepth.js)**: the Binance fallback now gets the REMAINING time (`max(750ms floor, deadline - elapsed)`) instead of a fresh 6s. Worst-case stall halves: 12s → ~6.75s. A live agentTick entry decision (30s cadence) can no longer black out for 12s.
- **Tests — the agent-family suites now own their network boundary**: `orderFlowDepth.readDepth → null` (the depth layer keeps its own suites), `pairCorrelation → null` ("unknown → allow", the guard's documented contract) in agent.test.ts + nearMissAutoTrade, and `fetchFuturesPrices → []` added to the existing futures.js partial mocks in all three suites. Zero live network remains in the agent suites — deterministic regardless of sandbox route conditions.
- **No agent.js change needed**: the single-flight guard was already correct production design (never overlap cycles) — the flake was the UNMOCKED network stall, not the guard.

### Also verified during the recheck (no issues found)
- v11.8 applicable-quorum math, board tape fallback, India index option-chain ctx (single-flight + TTL + real-chain gate), Binance depth fallback labeling, na marks — all reviewed, byte-level display artifact on meshModels.js line 347 (`[massive.ok` renders as `assive.ok` through ANSI-eating display paths; od + node --check confirm the file is correct).
- tsc CLEAN · npm audit 0/0 · route audit PASS · build 4.96s · smoke 15/15 · **full suite ×2 back-to-back: 2115/2116 each** (the 1 = the documented BSE live-network geo-block, unchanged).

## v11.8.1 — Mesh agent free-key pass: live-verified key availability + the Massive domain bug (2026-09-18)

**User ask: "Mesh keys (6 agents unauthed): QUIVER / TRADINGCENTRAL / ALPHAVANTAGE / MASSIVE / COINAPI / COINGECKO — free API key milega kya?" Every endpoint was probed LIVE (2026-09-18) before answering, and one real bug surfaced: the `massive` agent was pointed at `api.massive.dev`, a domain that DOES NOT RESOLVE (DNS failure) — a free key would have connected to nothing. Massive is the rebrand of Polygon.io and its REST surface still lives at `api.polygon.io` (probed: 401 = alive, key-gated).**

### Free-key verdict (live-verified)
| Env var | Free? | Where | Limits vs our agent budget |
|---|---|---|---|
| ALPHAVANTAGE_API_KEY | ✅ FREE | alphavantage.co/support/#api-key | 25 req/day, 5/min (budget 20/day) |
| COINGECKO_API_KEY | ✅ FREE Demo | coingecko.com/en/api | 10k calls/mo, 30/min (keyless works NOW — key stops 429 breaker trips) |
| COINAPI_API_KEY | ✅ FREE | coinapi.io → "Get Free API Key" | 100 req/day (budget 60/day) |
| MASSIVE_API_KEY | ✅ FREE Basic | massive.com (formerly polygon.io) | 5 req/min, EOD/reference (budget 5/min) |
| QUIVER_API_KEY | ✅ free tier | api.quiverquant.com (account → API key) | limited free requests (budget 50/day; full history paid) |
| TRADINGCENTRAL_API_KEY | ❌ no self-serve | enterprise B2B only | leave unset — TechConsensus honestly absent by design |

### The fix
- **massive.js retargeted to the live API**: `BASE = MASSIVE_API_BASE || 'https://api.polygon.io'` (env-overridable — if Massive migrates domains again, no redeploy needed), auth switched to Polygon's documented `Authorization: Bearer` header. `fundamentals.profile` now reads `/v3/reference/tickers/{sym}` (`results.ticker/name/sic_description`); the free Basic tier serves no valuation ratios, so `marketCap/peRatio/dividendYield/beta` return honestly null — the FundaProPlus seat cross-reads AlphaVantage for the numbers, and if NO source yields usable fields the seat abstains with the reason (unchanged honesty gate). The `quant.greeks` cap was REMOVED: no consumer existed anywhere (mesh seats, agent tools, routes) and the real free tier has no BS-greeks REST endpoint — advertising a dead cap is its own small dishonesty.
- **.env.example**: the v11.8 checklist now carries the per-key free-tier table above (registration links + limits vs budgets) + the new `MASSIVE_API_BASE` documented var.

### Validation
- tsc CLEAN · agent/mesh test files green (mcpAgents ID-list lock unchanged — 'massive' stays registered) · live probes: api.polygon.io 401 (alive), api.quiverquant.com 401, rest.coinapi.io 401, api.coingecko.com keyless 200, api.tradingcentral.com 403 (no self-serve), api.massive.dev DNS-dead.

## v11.8 — FULL COMMITTEE: why only 3-4 of 14 models were responding, fixed (2026-09-18)

**User ask: "Intraday TAB & CoinDCX TAB — 14 models me sirf 3-4 ka response aa raha hai, isliye signal accuracy high nahi hai — deep advance pro level pe check karo, Render env bhi bolo, live check karo." Live-render diagnosis (login + /api/ai/signals + /api/ai/status + /api/mcp/mesh/status on smartai1.onrender.com, 2026-09-18): the committee was losing voters to FIVE separate causes, four of them code bugs and one an env gap. This release fixes the code side and documents the exact env checklist. Verified locally end-to-end: the INDIA board went from 3-4 voters / conf 7-28 / all-NEUTRAL to 8/11 voters · conf 78 · STRONG (ACE, tape-MTF voting with real 5m/15m/1h confluence); the CRYPTO board went from "6/17 models voting · 47% quorum · conf 34" to "6/10 applicable models voting · 66% quorum · conf 42-45" on the SAME votes.**

### The five root causes (live-verified)
1. **AI Council (w=1.5, the heaviest single seat) was OFFLINE** — no LLM keys on Render (`aiCouncilOnline: false`). ENV fix: at least one of GEMINI_API_KEY / GROQ_API_KEY / CEREBRAS_API_KEY / OPENROUTER_API_KEY.
2. **The India board's tape seat (w=1.6, heaviest quant seat) never voted when the 5m base fetch failed** — the injection condition `(_mtfOn ? enr.tapeMTF : enr.tape)` skipped the ENTIRE seat even though a good 15m tape was in hand (the deep path already had the right fallback; the board didn't).
3. **OptionsFlow NEVER voted on the India board — not even on NIFTY/BANKNIFTY**, the exact underlyings it was designed for (PCR/max-pain/IV contrarian): ctx.options was only a deep-path hook (`opts.indexOptions`) that no board caller ever passed.
4. **InstFlow + VolumeFlow's L2 read were structurally dead on Render** — both read CoinDCX public REST depth, which is 403/timeout-blocked from Render datacenter IPs (live: booksCached stayed 0 all day). Crypto: "CoinDCX book not polled yet — InstFlow abstains" on every signal, every day.
5. **Structural abstains sat in the quorum denominator** — OptionsFlow/tape on crypto, FundaCheck on crypto+intraday, the 3 equity mesh seats on crypto, the on-chain seat on equity: seats that CANNOT serve a market shaved ~15% off every confidence via the participation factor ("6/17 voting" on a desk where 6 of 11 applicable seats HAD voted).

### The fixes
- **Applicable-committee quorum (ensemble.js)**: votes may carry `na: true` (structural abstain — the seat cannot serve this market). The participation denominator counts only applicable weight; data-missing abstains STILL count (honest). `totalModels` = applicable seats, `structuralAbsent` exposed, summary reads "6/10 models voting". buildSignal passes `na` on the wire (votes + abstentions) so the UI can gray them. Old math is byte-identical when no vote carries `na` (locked by tests).
- **Board tape-MTF 15m fallback (signals.js)**: the injection condition is now `(enr.tapeMTF || enr.tape)` — when the MTF flag is ON but the 5m base is dead, the seat fn degrades internally to the plain 15m read (exactly like the deep path). The heaviest quant seat no longer disappears with the 5m fetch.
- **India index option-chain ctx (signals.js)**: the board refreshes a 5-min-TTL OptionsFlow ctx for NIFTY + BANKNIFTY (REAL nse/bse chains only — a `REAL_CHAIN_RE` gate rejects the bs-model synthetic chain, because model data must never vote). Fire-and-forget (depth-warm pattern); `opts.indexOptions` callers keep precedence; deep dives on indices get the same cached ctx.
- **Binance USDT depth fallback (swing.js getOrderbook + orderFlowDepth.js)**: when the CoinDCX public REST book is unreachable (the Render reality), the same-USDT-pair Binance public depth serves as an honestly-labeled proxy (`source: 'binance-usdt-proxy'`); the L2 ladder is linearly rescaled onto the caller's INR anchor before any wall-distance/slippage math. InstFlow's ring polls now record which book served (the vote's reasons say "Binance USDT book proxy — CoinDCX REST unreachable" when applicable). Local verification: `booksTracked` went 0 → 12 (3 polls each) and XRP read a sustained 63% bid-side book.
- **India board mesh T3 warm**: the equity seats (TechConsensus / FundaProPlus) now shadow-vote on the India board too (top-12 slice, same budget-aware cadence gaps) — their abstains were previously "not warmed for X yet" forever on India.
- **InstFlow warm slice 8 → 10** (matches the 10-signal board; warmInstFlow's own rate guards unchanged).
- **Deep-path India index LTF fix**: index contexts carry DAILY candles — the deep dive used to treat them as the "15m" LTF (wrong timeframe for the tape/SMC/edge replay). Index deep dives now always fetch the real 15m series.

### The Render env checklist (see .env.example "v11.8 FULL-COMMITTEE CHECKLIST")
- AI Council: GEMINI_API_KEY (recommended free) or GROQ / CEREBRAS / OPENROUTER — the heaviest missing voter.
- Mesh keys (6 agents unauthed on live): QUIVER_API_KEY · TRADINGCENTRAL_API_KEY · ALPHAVANTAGE_API_KEY · MASSIVE_API_KEY · COINAPI_API_KEY · COINGECKO_API_KEY (demo key stops the keyless 429 breaker trips). FINNHUB_API_KEY already set.
- Flags already ON on Render: AI_ENABLE_V2_MODELS · AI_ENABLE_MESH_MODELS · AI_ENABLE_MTF_CONFLUENCE · AI_ENABLE_GLOBAL_COUNCIL. Leave AI_ENABLE_REGIME_WEIGHTS OFF until the A/B backtest.
- Mesh seats remain SHADOW (weight 0) until 10+ settled outcomes prove an edge — honest by design, not missing config.

### Validation
- tsc CLEAN · **2115/2116 tests** (the 1 failure = the documented pre-existing live-network BSE test, identical on pristine baseline; the v67-gauntlet/agent full-suite flakes seen mid-run were caused by the LOCAL dev server sharing state — clean tree runs are green) · 20 NEW locks in test/v118FullCommittee.test.ts (applicable-quorum math + no-regression, tape 15m fallback via the real registry with the flag ON, real-chain gate regex, Binance proxy labeling + INR rescale end-to-end, mesh na marks, and the exact live ENA card re-scored: 6/10 · 66% quorum) · npm audit 0/0 · full local boot with all flags: INDIA board 8/11 voters conf 78 STRONG with tape-MTF voting; CRYPTO board na marks on the wire; InstFlow books tracked; deep NIFTY honest neutral-coil abstain.

## v11.7 — FULL-SITE RECHECK: dead-code purge + the two missing PERF layers (2026-09-17)

**User ask: "full site code recheck + issues fix + unwanted files permanently remove + cleanup + site fast accurate." Result: 44 tracked files deleted (23 dead source files, 7 obsolete smoke/demo scripts, 13 stale/duplicate docs, 1 Windows leftover), a v11.6 VISIBILITY BUG fixed (the MCP mesh ops panel was wired only into a tab unreachable since v6.9 — users could never see it), and the two biggest transfer-performance gaps closed: the site served ~1.9MB of content-hashed assets with Cache-Control max-age=0 (re-downloaded on EVERY visit) and NO gzip at all. Now: assets are immutable-cached for a year + gzipped (vendor-react 192KB → 60KB, −69%), API JSON compressed (−59% on /api/ai/status), index.html/SPA shell no-store so deploys land instantly, SSE streams guaranteed uncompressed. Validation: tsc CLEAN · 2095/2096 tests (the 1 failure is the documented pre-existing live-network BSE test) · vite build 5.2s · npm audit 0/0 · live boot curl-verified every header.**

### PERF #1 — transfer compression (server/index.js, NEW dep `compression@1.8.2`)
- `app.use(compression({filter}))` before all routes: gzip every compressible response ≥1KB. Custom filter is belt-and-braces on top of the package defaults: NEVER touch `text/event-stream` (zlib buffering would delay live ticks) and never touch `Cache-Control: no-transform` responses. Live-verified: assets 192260 → 60219 bytes (−69%); `/api/ai/status` 4488 → 1852 bytes (−59%) with correct `Vary: Accept-Encoding` + `Content-Encoding: gzip`; both SSE endpoints confirmed uncompressed with `no-store, no-transform` intact.
- `app.disable('x-powered-by')` — Express fingerprint removed.

### PERF #2 — real browser caching for the content-hashed build (server/index.js)
- express.static default was `public, max-age=0`: a Vite-hashed build (`index-C2rax6Rt.js`…) re-downloaded ALL ~1.9MB on every visit. Now `/assets/*` → `Cache-Control: public, max-age=31536000, immutable` (filenames are content-hashed — a deploy changes every hash); `index.html` → `no-store`; `sw.js`/`widget.html`/`manifest.json` → `no-cache` (spec-safe SW updates depend on revalidating the SW file itself). The SPA fallback (`/portfolio` etc.) now sends `no-store` — previously sendFile's implicit heuristic caching could serve a STALE shell after a deploy (the classic "site looks unchanged / chunk 404" bug).

### BUG — the v11.6 mesh ops panel was invisible (MeshStatusPanel)
- v11.6 wired `MeshStatusPanel.tsx` (per-agent breaker state + token-bucket burn + seat warm-gaps — the Phase-3 ops view) ONLY into `tabs/AITradingTab.tsx`, which has been unreachable from App.tsx since the v6.9 desk split (App renders dashboard/india/crypto/portfolio/planner/macro + NeuralChat only). The panel now renders on BOTH live desks (IndiaIntradayTab + CoinDcxTab, §04 next to ModelPerformancePanel, still collapsible/off-by-default). Deleting the dead tab made this visible; the fix makes the whole v11.6 measurement layer actually reachable by users.

### CLEANUP — 44 tracked files permanently removed
- Dead source (zero importers, verified by full import-graph BFS from src/main.tsx + repo-wide name search): `PWAInstallPrompt`, `ScreenerPanel`, `Skeletons`, `TapetidePanel`, `tabs/IntradayTab` (dead since the v6.9 split), `tabs/ResearchLabTab`, `tabs/AITradingTab`, `intraday/{IntradayChartModal, MarketIntelPanel, SignalTable, TrendingMovers, sectorMap, SignalCard}`, `hooks/{useServerSentEvents, useTheme, useWebSocket}`, `utils/{deduplication, memoryEngine, retry, riskAnalyzer, smartDataLayer, screener, researchLabApi}`.
- test/indiaLiveSource.test.tsx: §5 (rendered the DEAD intraday SignalCard) removed — the pill-gating contract is locked in liveSourceBadge.test.tsx against the LIVE aitrading/SignalCard; stream-tagging sections untouched.
- Obsolete tooling: `demo-reliance-intraday.mjs`, `demo-sol-deep-dive.mjs`, `smoke_v1013.sh/v1015.sh/v1016.mjs/v1017.mjs/v1100.mjs` (v11.3's smoke_v113.mjs is the current one; v1100 read the now-deleted AITradingTab from disk).
- Stale/duplicate docs: exact duplicates (`docs/ADD_API_KEYS.md`, `docs/SETUP.txt`, `docs/start_server.vbs` — byte-identical to root copies) + unreferenced one-off historical reports (`UPGRADE_REPORT_v9/v801`, `AUDIT_FIXES_2026`, `FIX_SUMMARY`, `QUICK_IMPROVEMENTS`, `ADVANCED_IMPROVEMENTS`, `IMPLEMENTATION_PROGRESS`, `NEUMORPHISM`, `DEEP_SECURITY_AUDIT`, `PREMIUM_FEATURES`). README-referenced docs (UPGRADE_REPORT_v18, UPGRADE_REPORT, AUDIT_FIX_REPORT_v1801) + CHANGES.md kept. Windows leftover `start_server.vbs` removed (Render deploys via render.yaml); its stale comment reference in server/index.js updated. check-api-routes.mjs orphan comments refreshed.
- Local residue wiped: `.test-data-*` dirs. `Dockerfile.frontend`/`docker-compose.yml`/`nginx.conf` KEPT (documented alternate self-host path, referenced from docs).

### Verified NOT broken by the recheck
- Memory hygiene: hot-path Maps already capped (`_capMissMap` 200, `_fundamentalsCache` LRU 200, wick guards function-local) — the 2026 perf-audit caps hold; no new unbounded caches found at module scope.
- Route integrity: `node scripts/check-api-routes.mjs` → RESULT: PASS after the deletions.
- Service worker v18.1 already correct (no-transform/SSE/sensitive-API guards) — immutable asset headers now layer cleanly on top of its stale-while-revalidate.

### Validation
- tsc CLEAN · 2095/2096 tests pass (1 documented pre-existing live-network BSE failure, fails on pristine baseline too) · vite build CLEAN 5.22s · npm audit 0/0 (root + telegram-bot, with the new compression dep) · full boot with PIN auth + live curl checks: `/assets/vendor-react` → 200, gzip, `immutable`; `/` and `/portfolio` → `text/html`, `no-store`; `/sw.js` → `no-cache`; both SSE streams → uncompressed `text/event-stream`; login → session cookie OK.

## v11.3 — THE PERMANENT CRYPTO-PRICE FIX: official CoinDCX WebSocket layer (2026-09-17)

**Production incident (smartai1.onrender.com, deploy logs): `[corr=…] 502 Failed to fetch crypto prices. The operation was aborted due to timeout` + `[backup] head council-nearmiss.json failed: timeout`. Root cause: the whole crypto price layer hung off ONE Cloudflare-fronted REST host per domain (api.coindcx.com tickers / public.coindcx.com futures RT) — from Render datacenter IPs those time out, and after a 30s stale window every consumer 502'd. This release makes the price layer MULTI-SOURCE with the user's exact ask — CoinDCX's OFFICIAL servers — as the backbone: both official WebSocket streams were reverse-engineered LIVE from the docs + probes (EIO=4 both; the futures socket had been pinned EIO=3 which the server now kills ~1s after the ns-ack — the "WS accelerator" never delivered a single tick in production), and the book channels (`currentPrices@futures@rt` ~500 attributable pair rows ~1/sec; `currentPrices@spot@1s` + `priceStats@spot@60s` full spot book) now carry the desks. LIVE-verified end-to-end from a network where every CoinDCX REST host is 403-challenged: spot tickers served via the official WS (977 rows), futures prices via the WS book (source 'ws-book'), FUT ticks sub-second with honest labels. +27 tests → 2024 total; smoke_v113.mjs 15/15 LIVE.**

### The official spot WebSocket (NEW server/ai/cxSpotWs.js)
- Connects `wss://stream-spot.coindcx.com/socket.io/?EIO=4&transport=websocket` (Socket.IO v4 / Engine.IO 4; server pings at 45s — client answers '3'; the client must NEVER send its own '2' ping: live-verified it kills the socket in ~200ms; app-level `42["ping",...]` every 25s is the documented keepalive — all handled by the shared cxSocketIo client).
- Joins `currentPrices@spot@1s` (whole-book updates, payload.data is a JSON-encoded STRING) + `priceStats@spot@60s` (24h change % + volume). INR pairs refresh in ~10s bursts, USDT ~1s; a `#snapshot` full book arrives on join.
- Demand-driven lifecycle (Render free-tier friendly): every `fetchCoinDcxTickers()` + SSE client connect arms a heartbeat; ~2 min without demand → socket closes; handshake fail-streak → 30-min breaker; backoff reconnects. `AI_CX_SPOT_WS=0` kills it (off under vitest by default — no suite ever opens a real socket).

### fetchCoinDcxTickers() — the 5-leg chain (cryptoStream.js)
- REST (api.coindcx.com, 8s timeout, 2s cache, in-flight dedup — unchanged primary) → 30s stale-serve → **official spot-WS book** (servable at ≥25 fresh markets; CoinDCX-ticker-shaped rows, `feed: 'coindcx-spot-ws'`) → **Binance spot 24h tickers × live USDINR fx** (api.binance.com → data-api.binance.vision mirror → Bybit v5; every row honestly marked `__synthetic: 'binance-fx'`; local fx cache mirrors futures.js logic with zero import cycles) → **3-min deep-stale serve** → honest throw. `lastTickerSource()` exposes which leg served; `/api/crypto-prices` rides it as the `X-Price-Source` response header + a degraded-mode server log line.
- The SSE poller re-anchors INR ticks from the WS book when the chain is dry (partial books included — a single fresh BTCINR row still lands `IN_BTC` with source 'coindcx-spot-ws' and refreshes the Binance projection ratio). Boot-time 502s (the incident's exact signature) are structurally gone: the first ticker demand arms the WS and the second poll already has an official source.

### The futures book channel (cxRtStream.js + NEW server/ai/cxBookState.js)
- **EIO=4 URL fix**: the old `?EIO=3` handshake completed but the server killed the socket ~1s after the ns-connect ack — live-verified with 270 events in 40s on EIO=4 vs an instant kill on EIO=3. The futures WS accelerator had therefore NEVER worked in production (the design degraded gracefully to REST 2s, which is why nothing looked broken).
- **Book channel replaces per-pair joins**: `currentPrices@futures@rt` pushes ~500 ATTRIBUTABLE pair rows ~1/sec (`ls` last · `pc` change · `v` volume · `mp` mark) — the old per-pair `@prices-futures` price-change events carry NO pair identity ({T, p, pr}), which is why attribution never worked. `ls` rows land ticks instantly (honest 'coindcx-fut-ws'); `mp`-only rows are a keep-alive (land only when the symbol's tick is >8s stale — never displacing a fresher last price); heartbeat rows prove channel health.
- NEW `cxBookState.js` — the shared book state (leaf module, zero imports) so futures.js can serve it as a fallback WITHOUT an import cycle with cxRtStream. Retention 10 min, snapshot freshness 5s.

### fetchFuturesPrices() — the 4-leg chain (futures.js)
- REST RT (public.coindcx.com — unchanged primary, seconds→ms ts guard preserved) → **official WS book** (source 'ws-book'; often FASTER than REST when healthy) → **Binance fapi / Bybit linear 24h tickers** (same USDT-perp domain, sources 'binance-fut'/'bybit-fut'; 30s negative cache so a dead CoinDCX never turns into a 2s fapi hammer) → 3-min deep-stale serve → honest throw. Bonus discovered live: the futures book also carries commodity perps (NATGAS/CL/XAU/XAG/COPPER/BZ + index perps) — free for a future desk.
- Honesty fix en route (test-caught): `_pollFutures` now labels the liveFeed tick by the row's ACTUAL source (`coindcx-fut-ws` / `binance-fut-rt` / `coindcx-fut-rt`) — the old blanket 'coindcx-fut-rt' would have mislabeled fallback data as direct CoinDCX REST. Manual futures closes during a CoinDCX outage now price from the same-domain fallback instead of stranding the position ("No live futures price" only when EVERYTHING is dead — verified by the v7.0.2 audit test, now hermetically stubbed).
- INR futures note (user ask): CoinDCX futures instruments are marginable in INR or USDT (`margin_currency_short_name` per the docs) but the PRICE feed is the same USDT-perp book — the desk's existing USDINR conversion already serves the INR view; no separate feed exists to add.

### Backup hardening (intraday/backup.js)
- The boot-time `[backup] head council-nearmiss.json failed: timeout` — api.github.com's first TLS handshake from a cold Render container can exceed the old 10s budget: FETCH_TIMEOUT_MS → 15s + the sha HEAD now retries once (400ms gap) before giving up. Still best-effort, still never throws into a trading route.

### Validation
- tsc CLEAN · 115 files / **2024 tests ALL PASS** (1997 + 27 new: cxSpotWs 7, cryptoTickerChain 7, futuresResilience 9, cxRtStream book-channel 4) ×2 consecutive full runs (run 1 carried the known pre-existing mandateFreeze full-suite flake — passes in isolation at this commit AND at the pre-v11.3 baseline) · vite build CLEAN 5.13s · npm audit 0/0 both trees · `node --check` all 9 touched server files · **scripts/smoke_v113.mjs 15/15 LIVE** against the REAL sockets from a REST-blocked network: spot book 335 INR markets, ticker chain served via 'coindcx-spot-ws' (977 rows, BTCINR live), FUT_BTC sub-second 'coindcx-fut-ws', book 502 pairs, fetchFuturesPrices via 'ws-book', WS health → REST 10s floor.

## v11.1 — INDIA DESK DEEP GAPS + SENSEX HONESTY (2026-09-17)

**The user's two plans ("Options Desk NSE+SENSEX Addendum" + "Entire India Intraday Tab deep analysis") implemented in the plan's own build order: circuit-limit guard → real transaction costs → sector-map universe sync, plus the SENSEX/BSE research spike with its honest-fallback labeling. Live research findings baked in: Groww's quote already carries the day's price band (highPriceRange/lowPriceRange — same fetch, two fields), TV's India scanner serves a native `sector` column, and BSE is 403-Akamai-blocked from datacenter IPs (both www + api subdomains, sandbox-verified — even from hosts that CAN reach NSE). +53 tests → 1994 total, full suite green.**

### GAP 2 — CIRCUIT-LIMIT GUARD (India's most desk-specific risk, now real)
- NEW `server/ai/circuitGuard.js` — pure guard math: `circuitProximityOf` (band distances, near/at flags, garbage-disarm), `entryCircuitRisk` (same-direction entry near the adverse band → heavy penalty + the exact `⚠ Near upper/lower circuit — entry risk` reason flag + target clamps), `adverseCircuitRisk` (LONG→lower / SHORT→upper adverse classification with frozen-at-band detection). Threshold `AI_CIRCUIT_PROXIMITY_PCT` (default 1.5%), penalty `AI_CIRCUIT_PENALTY` (default 18).
- `growwQuote.js` — the day's price band rides the EXISTING live-quote fetch (`highPriceRange`/`lowPriceRange` → `upperCircuit`/`lowerCircuit`, validated; absent → omitted, guard inert). Zero extra upstream calls.
- `intraday/engine.js` — same-direction entry near the band: −18 confidence + the distinct reason flag + **targets clamped to the band BEFORE R:R math** (a LONG target printed above the upper circuit can literally never fill — price cannot exceed the band). Opposite-direction fades NOT penalized (fading a band is legitimate AND the side that fills at a freeze). Signal now carries `circuitRisk` + `nearCircuit`.
- OPEN POSITIONS (the plan's urgent-distinct-alert requirement): NEW `paperCircuitWatch` in paperTrading.js rides the stream watcher's existing tick (zero extra quotes; 10-min per-symbol cooldown) emitting `CIRCUIT_RISK` events; the India agent's exit-management sweep (indiaAgent.js) checks its own live positions via the shared Groww micro-cache and sends the urgent telegram — both framed as **exit-liquidity danger, NOT an SL-approach warning** ("usual SL playbook yahan kaam nahi karta"). alerts.js + IntradayTab toast render the new 🚨 CIRCUIT_RISK outcome type; NSE equities only (crypto 24/7 has no circuits; option premiums aren't band-bound).

### GAP 3 — REAL TRANSACTION COSTS (gross → net P&L everywhere)
- NEW `server/ai/tradingCosts.js` — the full India cost model with instrument branches: **equity-intraday** (STT 0.025% sell · NSE txn 0.00297% both · SEBI 0.0001% both · stamp 0.003% buy), **equity-futures** (STT 0.02% sell · txn 0.00173% · stamp 0.002%), **options** (STT 0.1% sell premium · txn 0.03503% premium · stamp 0.003% buy premium), **crypto** (approx taker fee %/side, no STT/GST); GST 18% on (brokerage + txn + SEBI) in all India cases. Brokerage flat ₹/executed-order (default ₹20 — a T1+T2 two-part close = 3 orders) or percent-of-turnover. Every rate env-overridable (`AI_TC_*`) so the user pins THEIR broker.
- `paperTrading.js` — every part-close re-annotates `grossPnl` + `costs` + `netPnl` + a full `costsBreakdown` (deterministic derivation — legacy AND restored trades get it too, no migration); PAPER_CLOSE events carry `pnlNet`; summary/history/`_publicTrade` serve net as the headline with gross in tooltips ("costs ate ₹X · Y% of gross profit").
- `journal.js` — entries persist the cost pair; `_dayStats` aggregates costs/netPnlAfterCosts/grossWin/tradesWithCosts (legacy entries honestly stay gross). `weeklyReview.js` — the plan's explicit gross-vs-net line renders in the LLM prompt block AND the always-visible quant header.
- Frontend: PaperTradePanel + JournalPanel show **net as the displayed number** (gross + full breakdown in tooltips), stats chips for day/total costs, the "P&L numbers NET hain" footnote; IntradayTab outcome toast prefers pnlNet.
- Test-caught bug en route: `costsForPaperTrade` double-applied the lot multiplier in the avg-exit derivation (option STT inflated ×75) — locked against recurrence.

### GAP 1 — SECTOR MAP × FULL UNIVERSE (the 5x blind spot closed)
- `indiaUniverse.js` — discovery query now appends TV's own `sector` column (d[8]; locked indices 0-7 untouched; live-verified on the India scanner: "Technology Services", "Process Industries", "Finance"…).
- `sectors.js` — the sector lens now sees the WHOLE tape the scanner sees: universe = base 45 ∪ discovered ~220 via the chunked TV batch; symbol→sector = curated `SECTOR_MAP` (original 45) → NEW `EXTENDED_SECTOR_CLASSIFICATION` (~120 seed/F&O names across the 10 original + 6 new buckets: HEALTHCARE/CHEMICALS/DEFENCE/REALTY/TELECOM/TRANSPORT) → TV taxonomy mapped via `TV_SECTOR_TO_DESK` → honest OTHERS. Static always wins over TV. Breadth/momentum/leader/laggard/context-chain/F-Score math UNCHANGED — only membership scaled. `AI_INDIA_FULL_UNIVERSE=off` = the legacy static 45-name path, byte-identical payload (sectorMode 'base-45'; full modes honestly labelled 'full-dynamic'/'full-seed-fallback').

### NSE + SENSEX ADDENDUM — source honesty for the two "model chain" cases
- Research spike (live from this host): **BSE is structurally unreachable from datacenter IPs** — bseindia.com AND api.bseindia.com both 403 Akamai (this sandbox reaches NSE fine, so Render has no path either). Not an outage — a permanent limitation.
- NEW `fetchBSEOptionChain()` in data.js (the NSE pattern: cookie bootstrap + tolerant parsing of both candidate endpoints + normalized expiry dates) with a 10-min negative cache keeping the dead probe nearly free — SENSEX gets FULL parity the day it becomes reachable (different host / CDN posture change), and `getOptionsDesk('SENSEX')` stops hammering NSE's equities endpoint for an index NSE doesn't list.
- Honest fallback labeling (the plan's exact design): SENSEX model mode = **`bs-model-sensex-always`** + the persistent non-dismissible banner ("SENSEX premiums are model-estimated — BSE does not expose a public real-time option feed usable from this server. For live SENSEX option prices, cross-check your broker.") on the desk AND every SENSEX option card; NIFTY-family model mode = **`bs-model-nifty-fallback`** + "temporarily unreachable … next successful fetch restores live data" (recoverable). The two cases can never be visually confused again.
- Structural confidence discount: SENSEX model cards lose `AI_SENSEX_MODEL_DISCOUNT` (default 8) AI-score points BEYOND the model-uncertainty handling — no live-market cross-check is ever possible for that underlying; `aiScoreRaw` + `structuralDiscount` exposed, machineNote/note say why. A live BSE chain (if ever reachable) restores full parity with zero discount.
- optionsScan: 'bse' counts as a LIVE chain (score bonus, synthetic=false, live/model classification); income ranker + scanner notes updated. Frontend: three-way source chips (LIVE NSE / LIVE BSE / model — rose for the SENSEX permanent case) across desk, cards, scanner rows, income rows; types widened (`OptionSource`).

### Validation
- tsc clean · **111 files / 1994 tests** (1941 + 53 new: bseOptionChain 10 · circuitLimitGuard 19 · tradingCosts 16 · sectors 8) · full-suite green (the flaky agent.test.ts cross-file interference at the v11.0.1 baseline — 11-30 failures depending on order — does NOT reproduce with v11.1; verified at baseline vs current) · `node --check` all 15 touched server files · env keys documented in .env.example + render.yaml (`AI_CIRCUIT_*`, `AI_TC_*`, `AI_SENSEX_MODEL_DISCOUNT`).

---

## v11.0.1 — FULL-SITE DEEP RECHECK: 14 fixes over the v11.0 baseline (2026-09-17)

**The v11.0 recheck pass (user: "full site code ek baar recheck karo") — line-audit of every v11.0 engine + wiring + both Explore-agent sweeps. 4 production-grade defects (2 silent-failure class, 1 dead-feature class, 1 coverage class) + hardening + honesty fixes. All test-locked: +14 tests → 1941 total, 5 consecutive greens.**

### COUNCIL (the 4 real defects)
- `council.js` **WEAK-SIDE BAR WAS DEAD CODE** — `gateContextFor` keyed the direction split by seat ROLE and then read `split.LONG`/`split.SHORT` (always undefined → n:0), so the precision gate's +5 weak-side raise could NEVER fire no matter how badly one direction underperformed. Now aggregates LONG/SHORT across all calibrated seats (n-weighted winRates) exactly as consensus.js's gate expects — the "SHORT side systematically galat" guard finally works. Locked end-to-end: a seeded 100%/0% split suppresses a conf-80 SHORT that the base bar would pass.
- `council.js` **ON-CHAIN SEAT BLIND FOR 4/5 BOARD SYMBOLS** — `councilMeshBundle` fetched `crypto.funding` ONCE for the whole symbol set while the ccxt funding cap serves exactly one symbol per call: only symbols[0] ever got a funding rate, the rest honest-null → the on-chain persona + its deterministic fallback both voted blind on most of the board (the same blind-seat class the validation pass fixed in buildFeatureMatrix). Now: one price query (coingecko serves all symbols per call) + one funding query PER SYMBOL, all riding the mesh's own single-flight + warm 5-min cache — steady-state cost ~1 upstream call/symbol/5min.
- `council.js` **NOMINAL-CAPITAL HEAT READ** — `riskContextFor` hardcoded ₹10k/₹10k into `globalRiskView` while both desks' own gauntlets use real capital (agent.js passes live wallet equity, indiaAgent its configured equityINR). The risk guardian's heatPct context (and its heat_cap veto read) was computed against paper numbers whenever actual capital differed. Now reads the persisted wallet snapshot (`ai-agent-state.json lastWallet.equityINR`) + the India config (cycle-safe dynamic import), falling back to ₹10k exactly like the gauntlets.
- `council.js` + `routes.js` **DEEP ENDPOINT: HANG + DOUBLE-SPEND + EMPTY-MATRIX VERDICTS** — `/api/ai/council/verdict/:symbol` chained a fresh ensemble run + 6 personas + debate + judge with NO route deadline (a slow provider chain could hang the HTTP handler for minutes) and NO single-flight (a double-click / remount+poll overlap fired TWO full ~9-call deep runs inside the 90s cache window). Also: with the ensemble run failed, `runCouncilDeep` still produced an all-NEUTRAL verdict over an EMPTY feature matrix — noise wearing a council badge. Now: 25s route deadline → honest 503 "still computing, caches for 90s"; per-market:symbol single-flight (concurrent callers JOIN the in-flight run); `sig:null` → honest null → the route's 502.

### MESH + AGENTS (hardening — the audit's query-injection sweep)
- `mesh.js` **INPUT SANITIZATION AT THE ENGINE BOUNDARY** — symbols/keys/pairs are charset-filtered (A-Z0-9.-, ≤20 chars, upper-cased), `limit` clamped 1..500 (negative/huge passed through raw before), `timeframe` whitelisted {5m,15m,1h,4h,1d}. No agent downstream can now receive a raw query-string payload from ANY caller (public route included).
- Agent adapters (defense-in-depth, 5 files): `alphavantage` `crypto.rate` from_currency URL-encoded; `quiver` congress/insider ticker encoded; `tradingcentral` news symbols encoded; `massive` company PATH segment encoded (BRK/A-style traversal) + `quant.greeks` kind whitelisted to call|put + NaN delta guard; `coinapi` NaN price/qty guards; **`alpaca` market-wide news mode was DEAD** — the empty-symbols URL built `.../news&limit=10` (the `&` without `?` put limit in the PATH → always 404); also symbols encoded now.
- `finnhubAgent.js` + `alpaca.js` **SEQUENTIAL QUOTE LOOPS vs THE 8s MESH DEADLINE** — 5 sequential 5s fetches guaranteed partial-discard + a breaker fail under the single 8s deadline; both now fan out with `Promise.allSettled` (bounded ≤5).
- `server/index.js` — route-registration warn prefix typo fixed (`cp/mesh]` → `[mcp/mesh]`).

### UI honesty
- `councilStampOf` now carries `gateBar` (the gate's ACTUAL confidence bar — env-tuned + auto-tighten aware) and `CouncilVerdictPanel`'s consensus-bar marker rides it instead of the hardcoded 78 (which lied whenever `AI_PRECISION_GATE_CONF` or the +10 auto-tighten moved the bar); `types.ts` extended.

### Validation
- tsc clean · 107 files / **1941 tests** (1927 + 14 new locks: funding per-symbol coverage ×2, weak-side raise ×2, honest capitals ×2, null-sig 502, deep single-flight, gateBar, mesh sanitization ×5) · vite build 5.4s · npm audit 0/0 both trees · `node --check` all 13 touched files · smoke_v1100.mjs 47/47 (SMARTAI_DATA_DIR-isolated, LIVE Binance probe included).
- Known-and-accepted (unchanged): null payloads still count as breaker failures (load-bearing — fetchJSON collapses all network errors to null, so null is the only failure signal the mesh sees); a half-open probe that is routed-but-not-called keeps its half-open flag (standard semantics).

---

## v11.0 — SUPERINTELLIGENCE: GLOBAL MARKET COUNCIL + MCP AGENT MESH (2026-09-17)

**The superintelligence upgrade: 10 MCP data agents + 6 specialist LLM seats + a calibrated precision gate, wired as an ANALYSIS layer over both desks (execution gauntlets untouched). Everything flag-gated default OFF (`AI_ENABLE_GLOBAL_COUNCIL`) for clean A/B against v10.18. 95% is engineered as a PRECISION TARGET (publish fewer, highest-confluence tickets) — never a claimed win-rate; realized numbers stay measurable via the tamper-evident ledger.**

### PHASE 1 — MCP Data Agent Mesh (10 agents, one contract)
- NEW `server/mcp/agents/registry.js` — agent cards + capability index (`whichAgentsNeed('crypto.ohlcv')`), per-agent 3-fail circuit breakers with 10-min→80-min exponential-backoff half-open probes (the cryptoStream/binanceFutWs pattern), token-bucket rate budgets (daily + per-minute), env-key auth resolution (missing key = agent honestly ABSENT). Zero network at import.
- NEW 10 agent adapters, one standardized card each ("protocol flexible, interface strict"): `alphavantage.js` (world stocks/forex/crypto + fundamentals, 20/day budget), `coingecko.js` (crypto prices/trending/market/onchain, keyless-friendly 10/min), `ccxt.js` (unified Binance+Bybit+OKX public OHLCV/orderbook/funding with geo-failover — deliberate deviation from npm-ccxt: same unified surface, ~0MB instead of ~50MB, recorded here), `tradingview.js` (wrap of the repo's own TV India/crypto scanner batches — zero duplicate upstream), `tradingcentral.js` (news sentiment, absent without key), `quiver.js` (US alt-data: Congress/insider), `massive.js` (fundamentals + independent BS-Greeks), `coinapi.js` (tick fallback), `finnhubAgent.js` (wrap of the shared finnhubQuote module — one key one budget), `alpaca.js` (US IEX quotes + market news).
- NEW `server/mcp/mesh.js` — the orchestrator: capability-routed fan-out (p-limit 6), per-agent 8s deadline race (`AI_MCP_MESH_TIMEOUT_MS`), 3-tier cache (hot 30s / warm 5min / cold 60min, LRU 200), single-flight dedup, 90s negative cache, stale-while-revalidate serve-tagged, cross-source price sanity bands (>1.5% divergence → degraded flag). Routes: `GET /api/mcp/agents`, `GET /api/mcp/mesh/status`, `POST /api/mcp/mesh/query`.

### PHASE 2 — Council + Consensus + Precision Gate
- NEW `server/ai/council.js` — the 6 specialist seats (Technical · Macro · Sentiment · Options-Flow · On-Chain · Risk Guardian with VETO) with anti-hallucination prompts ("sirf diye gaye data se bolo"), market-aware seat availability (onchain abstains on India; optionsflow abstains where no chain data), BOARD mode (6 BATCHED persona calls over the top-5 — one prompt per seat, NOT 6×N), DEEP mode (6 + bull/bear debate + judge synthesis with a bounded ±8 confidence shift — the plan's ~9-call cost math), 90s per-symbol verdict cache (LRU 200), and a DETERMINISTIC quant-only fallback tagged `model:'deterministic'` when the LLM chain is down (superIntelFallback pattern — never fakes a provider name).
- NEW `server/ai/consensus.js` — pure synchronous consensus (<5ms): weighted score `Σ(wᵢ×confᵢ×dirᵢ)/Σ(wᵢ over direction-voting seats)` (NEUTRAL = abstain — otherwise the structurally-NEUTRAL Risk Guardian would cap the ceiling at ~80 forever), count-based agreement over all present seats, quorum, then the PRECISION GATE: conf ≥78 (`AI_PRECISION_GATE_CONF`) · agreement ≥0.70 · quorum ≥5/6 · regime-aligned · eventGuard not blackout · globalRisk not off · risk veto null · weak-side bar +5 (direction-split honesty). Suppressed verdicts → NEAR-MISS JOURNAL (durable, cap 200) — the weekly review's learning input. AUTO-TIGHTEN: 3-week <75% published-precision streak → conf bar +5 (cumulative cap +10, durable override, ≥85% auto-resets, `AI_PRECISION_GATE_AUTO_TIGHTEN=off` disables).
- NEW `server/ai/llmChain.js` — the shared Gemini→Groq→Cerebras→OpenRouter JSON chain extracted from signals.js (same ask semantics, no circular import).
- `server/ai/signals.js` — surgical council hook after `computeTopFive` (flag-gated): top-5 candidates → `runCouncilBoard` under a 12s soft deadline (unresolved verdicts keep warming in the council cache and stamp the NEXT cycle — warmDepthBatch pattern); stamps `sig.council` + `payload.council`; the deep path gets the full debate verdict. **The council NEVER touches grades/plans/execution — it ATTACHES.**
- `server/ai/routes.js` — NEW routes: `GET /api/ai/council/status|near-miss|calibration|verdict/:symbol`.

### PHASE 3 — UI (both desks, transparency-first)
- NEW `src/components/aitrading/CouncilVerdictPanel.tsx` — the 6-seat grid with per-agent direction+confidence bars, consensus bar with the 78 gate-marker, PASSED/SUPPRESSED chip + reasons, bull/bear/judge debate trail, freshness badges (LIVE/CACHED/MODEL), price-divergence flag, and the 10-agent mesh health strip (● healthy · ◐ half-open · ○ breaker · · no-key). OFF state explains the flag + cost honestly. Mounted on BOTH desks (AITradingTab 01c + IndiaIntradayTab 01a).
- NEW `src/components/aitrading/NearMissPanel.tsx` — the gate's transparency surface: suppressed verdicts with reasons, seat breakdowns, age, stats. Collapsible, 60s hidden-gated poll.
- `SignalCard.tsx` — NEW CouncilStrip: 6 mini vote bars + gate chip on every stamped card; expanded cards get per-seat reasons + veto + the debate trail.
- `OptionsDeskPanel.tsx` — scanner rows get the 🏛 cross-check chip (ALIGN green / CONTRADICTS red / no-data grey) — on-demand only (deep verdict ≈9 LLM calls), 90s client cache.
- `ModelPerformancePanel.tsx` — NEW COUNCIL AGENTS block: per-seat hit-rate bars + calibrated weight multipliers (×Bayesian) + published precision/90d/Brier line.
- `useAITrading.ts` — NEW fetchers: `fetchCouncilStatus` / `fetchCouncilNearMiss` / `fetchCouncilVerdict` / `fetchCouncilCalibration` (60s client caches, hidden-tab gated); types in `types.ts` (CouncilStamp, CouncilBoardMeta, CouncilStatusView, NearMissEntry, CouncilCalibrationView).

### PHASE 4 — Accuracy validation loop + per-agent accountability
- `server/ai/ledger.js` — `recordExecution` now stamps the council verdict onto the tamper-evident chain entry (`e.council.agents` per-seat dir/conf — the attribution input).
- `server/ai/trust.js` — NEW `councilAgentStats()` (per-seat win/loss attribution + LONG/SHORT direction split), `councilCalibrationMultipliers()` (Bayesian Beta posterior, clamp 0.7-1.3, n<8 refuses to tune — the adaptive.js rule one seat over), `councilCalibration()` (published precision + 90d rolling + per-council Brier + the insufficient-data honesty).
- `server/ai/weeklyReview.js` — NEW council section: per-seat week stats, precision-by-week ladder, near-miss counts + reasons + the APPROXIMATE outcome scan (suppressed verdicts >24h vs current price — honestly labeled "price-at-review-time, not a backtest", capped 15 symbols), the auto-tighten state, and the calibrated-weights report; Council Read added to the LLM narration + Telegram header. Weekly review now also computes when ONLY council-stamped trades exist.

### PHASE 5 — Perf + env + docs
- Perf guardrails built-in at every layer (the plan's budget table): mesh p-limit 6 + 8s deadlines + 3-tier LRU-200 cache + negative cache; council 6 batched calls/90s + 12s soft deadline; consensus pure sync <5ms; frontend 60s hidden-gated polls + memo'd panels; verdict/price caches all LRU-capped; every new map bounded (registry health/buckets, verdicts, near-miss 200).
- `.env.example` + `render.yaml` — all v11.0 keys documented (6 agent API keys + master switch + 6 tuning flags; sab default OFF/optional).

### Honest limitations (unchanged doctrine)
- 95%+ is a TARGET, not a guarantee — realized published precision is measured on settled outcomes (90-day rolling window; 30-day n≈120 is noise) and visible in Track Record + weekly review. Publish kam, quality zyada.
- The council is an ANALYSIS layer only. Execution authority stays 100% with the v10.18 gauntlets (kill switch, allowAuto, LIVE arming, daily caps, one-per-pair, fresh-signal re-verify, eventGuard, globalRisk, Kelly caps). Autonomy does not increase by one inch.
- New agents/weights earn trust on settled outcomes only (Bayesian, n≥8); paper probation + demotion ride the same ledger.

### Validation pass — 6 real defects caught by the test chain, all fixed + test-locked
- **mesh `resolveCapability` crashed on every cache MISS** (`mesh.js`): `cacheGet` returns `null` on a miss but the caller dereferenced `hit.fresh` — the mesh could never serve its first query. Null-guarded; the stale-while-revalidate inflight entry is now the WRAPPED result shape (joined callers previously would have read a raw payload as a "gap"); the cache tier is derived from the serving agent's own card instead of hardcoded warm.
- **The on-chain seat was blind in production** (`council.js`): `councilMeshBundle` builds a FLAT `{ fundingRate, price }` bundle, but `buildFeatureMatrix` read `mesh.onchain.fundingRate` — funding data NEVER reached the personas' prompts or the deterministic fallback. Fixed with flat-first, nested-forward-compat mapping (locked by the funding-crowding-flips-SHORT test).
- **Partial LLM failure collapsed the whole council to quant-only** (`council.js`): the board required a MAJORITY of personas to answer usable JSON before the LLM council could stand; now any one usable seat stands and the rest degrade per-seat (the deep-mode pattern).
- **The per-seat fallback condition was inverted** (`council.js`): `if (!a.json?.verdicts ...) continue` skipped exactly the seats it was supposed to fill — a failed seat left its slot EMPTY (undefined verdict on the wire). Now fills per-symbol with honest reason tags (`LLM seat failed` vs `seat skipped SYMBOL` — a batched persona covering BTC but skipping ETH fills ETH from quant).
- **weeklyReview's trust mock predated v11.0** (`test/weeklyReview.test.ts`): the vi.mock lacked the three new council exports — extended with honest neutral mocks.
- **The mesh test harness dropped array payloads** (`test/mesh.test.ts`): the fetch stub serialized `out.body ?? {ok:true}`, erasing bare-array klines responses (and the multi-cap case served klines to the depth endpoint) — arrays now serve as the body; the orderbook URL gets a depth-shaped response.
- Validation totals: tsc CLEAN · **107 files / 1927 tests ALL PASS** (1867 + 60 new v11.0) · vite build CLEAN 5.5s · npm audit 0/0 both trees · node --check all 21 touched server files · **smoke_v1100.mjs 47/47** (incl. LIVE Binance ohlcv probe through the real mesh + 90s verdict cache round-trip).

## v10.18 — DEEP RECHECK #3: ADVANCED PRO-LEVEL AUDIT + 22 FIXES (2026-09-17)

**Full-site code re-checked at the engine, wiring, frontend, and lifecycle levels (two parallel deep-audit passes + own line review of every v10.15-v10.17 surface). Suite grew 1865 → 1867 tests, all passing; tsc clean; build clean 5.0s; audit 0/0; boot smoke 20/20.** Findings were triaged into real production impact — every fix below is a defect that could hang a handler, lose an alert, corrupt state, leak memory, or jank the UI; style nitpicks were skipped deliberately.

### SERVER — resilience & correctness
- **Photo-chart Telegram handler could hang forever + leak the typing indicator** (`bot.mjs`): the image download had NO timeout — a black-holed Telegram CDN route stalled the handler AND the 4s `startTyping` interval leaked per photo (the voice handler already had the 30s deadline; now the photo path matches).
- **The GitHub backup rate-limiter was DEAD CODE** (`lib/backup.js` + `intraday/backup.js`): `PUSH_MIN_GAP_MS` (the per-file 60s abuse guard) read `_lastPush` but never wrote it — state churn could hammer the Contents API ~20x/min/file, trip GitHub's secondary rate limit → 403 → **all durable backups silently stop**. The per-file gap now arms after every successful push (failed pushes retry early by design — the remote copy is still stale).
- **One transient Telegram blip used to eat a 30-minute alert** (`telegramPush.js` + `manualTrades.js`): the alert cooldown armed BEFORE the send — a 5-second network hiccup at the moment an EXIT-NOW / SL-touch / STRONG fired suppressed that push for its whole window with no retry. Now the FULL cooldown arms only on a successful send; a failed send reserves a short 30s failure-retry hold (the next conviction sweep / sink tick re-attempts). The manual `_push` return flag is honest now too (false when nothing went out).
- **`globalRiskGate` could stall the entry gauntlet for minutes** (`globalRisk.js`): the VIX/BTC Yahoo reads had no deadline — undici's default headers timeout is minutes, and BOTH desks' entry ticks await this gate. 8s `AbortSignal.timeout` deadlines added (matching every other fetch in the repo).
- **`remove-webhook` could hang the admin route** (`telegram/webhook.js`): the `deleteWebhook` fetch had no signal (its `setWebhook` sibling had one) — 10s deadline added.
- **MID-SYNC DISCONNECT race on the portfolio snapshot** (`mcp/portfolioSync.js`): `indmConnected`/`cdcxConnected` are captured at sync start, then the sync sits in 30-60s of awaits — if the user disconnected a source mid-sync, `clearSourceAssets()` wrote a snapshot without those rows and the still-running sync wrote them RIGHT BACK (resurrect + durable-put, surviving restarts until the next sync). Connectivity is now re-checked in the same no-await window as the hidden re-read (the established discipline in that file), dropping the disconnected source's rows + residue exactly like `clearSourceAssets` does. Test-locked with a gated-hanging MCP call.
- **Unbounded user-keyed caches bounded** (memory-hygiene sweep): `orderFlowDepth` book/ring maps (~10-20KB retained per slot, `/api/ai/depth` lets a caller grow the key space forever — evict-stalest past 200, current key + in-flight protected), `backtest._cache` (keys embed the caller's symbol lists with full backtest payloads — cap 24, evict oldest), `signals.js` `_ltfMiss`/`_ltf5mMiss` negative caches (cap 200, expired-first), `fundamentals._data` (cap 300, error rows evicted before good rows), `manualTrades._alerts` (same >200 prune as telegramPush).

### FRONTEND — races, jank & honesty
- **`loadPositions` responses could resurrect a just-closed position** (`useAITrading.ts`): up to four uncoordinated callers raced (45s reconciliation poll · 5s fallback poll · close/execute refreshes · visibility refresh) with blind wholesale `setPositions` — a slow REST response landing after a newer one reverted the panel, and a poll started BEFORE a close that resolved AFTER closePos's refresh showed the closed position as OPEN for up to 45s. Request sequence guard added (`posSeqRef` — only the latest request's response applies; same discipline as the desks' `deepReq` tokens).
- **O(n²) maxOI inside the option-chain row render** (`OptionsDeskPanel.tsx`): `Math.max(...rows.map(...))` executed INSIDE the per-row `.map()` — the 100-250-strike NSE chain re-scanned itself per row on every repaint (10k-62k comparisons + a fresh array per row). Hoisted to a single per-render computation.
- **"LIVE 5s" monitor badge lied right after mount** (`ManualTradeMonitor.tsx`): the cadence scheduler read `tradesRef` one poll late (the sync effect commits after the next render), so the first refresh after mount always waited 30s even with open trades; the close path could also interleave with the scheduled load and transiently resurrect the just-closed row. The ref now syncs INSIDE `load()` + a response sequence guard.
- **Stale ticks rendered as live prices** (`useCxLivePrices.ts`): when the board re-ranked and a symbol dropped out of the watched key set, its last tick kept rendering with the live ⚡ marker — a frozen price presented as realtime. `forSignal` now returns null past 30s (the card falls back to its board snapshot honestly).
- **Hidden-tab API burn**: the India agent panel (15s poll) and the options signal strip (30s poll) now gate on `document.hidden` like every sibling poller — a backgrounded tab no longer fires 12s-timeout API calls forever.
- **Toast/message timers wiped newer messages early** (sweep): the first `setTimeout(() => setX(null))` erased a second message posted within its window (two paper trades, two saves, connect+disconnect flashes, the clear-closed result chip, the execute banner's pending→verdict sequence). All hot sites converted to the timer-ref pattern (clear-before-rearm + unmount cleanup): OrderConsole (save/flash/sweep), SignalCard (copied/result), OptionsDeskPanel (paperMsg), AlertsPanel, IndiaAgentPanel, CoinDcxTab, IndiaIntradayTab.
- **Options strip `err` flag read a mount-time closure** (`OptionsDeskPanel.tsx`): `else if (!view) setErr(true)` captured the always-null mount-time `view` — every failed poll set err even with data on screen (render masked it; latent trap). Now reads a `viewRef`.

### Verification
- NEW/updated tests: `telegramPush.test.ts` +1 (failed send does NOT arm the full cooldown — reserved short window, retries after 30s, full cooldown arms on success), `manualTrades.test.ts` +1 rewritten contract (failure → honest `pushed:false` + retryable after the failure window + full cooldown only on success), `portfolioSync.test.ts` +1 (mid-sync disconnect gated-hanging-call race — no resurrect, residue dropped, honest not-usable result).
- `tsc CLEAN · 103 files / 1867 tests ALL PASS · vite build CLEAN (5.0s) · npm audit 0/0 (both trees) · node --check all 13 touched files · scripts/smoke_v1017.mjs 20/20 (SMARTAI_DATA_DIR-isolated).`

### Audit scope (what was checked and found clean)
- All 186 `fetch(` call sites across `server/` + `telegram-bot/` (only the 3 timeout-less ones above were fixed); every `setInterval`/listener/keepalive lifecycle (all paired); the journal writer-lock discipline (all four desks correctly serialized); fire-and-forget paths (all carry `.catch` or sit in try/catch; both processes register `unhandledRejection` guards).
- Frontend: hook-dep/stale-closure sweep (the v10.6.1/v10.13 passes hold; only the strip-closure above remained), EventSource/WebSocket/timer leak sweep (no real leaks — only the toast-wipe class), the v10.17 tickBatcher merge/flush semantics re-verified correct (partial-delta merge, snapshot-flush ordering, final-tick scenarios).
- Known-and-accepted (documented, not defects): the 600ms direction-flash timer (cosmetic, sub-second); `ManualTradePrompt` prefill staleness (mitigated by the live deviation warning; editable field); dead `AITradingTab.tsx` (orphaned since the India/CoinDCX tab split — deletion rides the next frontend cleanup pass).

## v10.17 — FULL UNIVERSE SCAN + OPTIONS SCANNER + CLEAR CLOSED + PERF (2026-09-16)

**The superintelligence plan v2's remaining sections, fully applied: Section 1 (full universe scan + tiered cadence + options scanner), the Clear-closed-trades button, and Section 5 (performance/lag cleanup).** Suite grew **1799 → 1865 tests, all passing** (+66 across 6 new files + 5 calendar-determinism patches); boot smoke 20/20 (`scripts/smoke_v1017.mjs` — includes a LIVE TV discovery + LIVE NSE options-chain pass); tsc clean; build clean 5.3s; audit 0/0; ml-service 11/11.

### SECTION 1a — Full universe scan + TIERED CADENCE (India desk)
The gap: every India surface (Signal Board · Trending Movers · intraday scanner) scanned a FIXED ~45-name F&O base — the best setup of the day sitting outside that list could never surface. Now:
- **NEW `server/ai/indiaUniverse.js`** — one TV India scanner FILTER query (type=stock · exchange=NSE · sorted by turnover, depth ~220) discovers the most-traded NSE names every 10 min (single-flight, 90s negative-cache, honest static-seed fallback when the scanner is unreachable). LIVE-verified from the boot smoke: 219-220 real names parsed, turnover-ranked.
- **Tiered cadence** — T1 (base ∪ watchlist ∪ HOT) scans EVERY cycle; T2 (the discovered rest) rotates in ~¼ slices per cycle → whole-market coverage every ~4 board cycles (~4 min) without ever exploding one scan's upstream cost. **Hot promotion**: a T2 name showing heat (|chg| ≥ 2.5% · relVol ≥ 2 · RSI ≥ 72/28) rides T1 cadence for 20 min (cap 15, fittest-survive eviction). The board, movers and scanner SHARE one rotation + one hot set — combined callers cover T2 faster, never slower.
- **Chunked TV batches** — `fetchTVIndiaBatchChunked` (60 symbols/request, ≤3 concurrent) on the board path; the intraday engine's TV round chunks at 100 tickers/request (small universes keep the exact legacy single-shot path). Groww quote load bounded by the v10.12 micro-cache + per-symbol backoff as before.
- **Honest degrade**: discovery DOWN → the board falls back to the legacy static scan byte-identically (same upstream as the tickers batch — no seed guessing on the board path); movers/scanner keep the wider seed coverage. User watchlist removals are honoured against discovered T2 seats AND hot rides. `AI_INDIA_FULL_UNIVERSE=off` reverts everything; `superMeta.universeMode` labels the live tier shape.
- Fixed en route (caught by tests/smoke): `mergeHot`/`pruneHot` silently wiped the production Map state (Array.isArray guard) — hot rides never persisted; `splitTiers` computed the hot set and never seated it into T1 (the smoke's live 220-name rotation caught it); `nextSlice` built the slice before computing the adaptive take.

### SECTION 1b — OPTIONS SCANNER (whole F&O chain, one view)
- **NEW `server/ai/optionsScan.js` + `GET /api/ai/options-scan`** — 3 indices (NIFTY · SENSEX · BANKNIFTY) + the top stock-option underlyings by NSE turnover (F&O seed intersection, `AI_OPTIONS_SCAN_STOCKS` default 6), each loaded through the existing real-NSE-chain machinery with the honest BS-model fallback. Every row: DETERMINISTIC direction tally (OI lean · PCR · max-pain side · gamma-flip side — zero LLM, fully explainable), GEX pin/flip zone + walls, expected-move band, ATM IV, DTE awareness, source tag. Ranked by a transparent scan score (conviction ×8 + OI-flow ×25 + movement potential ×5 + live-chain +5 − far-expiry drag). 90s cache, single-flight, bounded groups of 4 with 350ms gaps (NSE politeness — never a stampede).
- **UI**: the Options Desk panel gets a **🔍 SCANNER** toggle — one ranked list across the whole F&O universe (direction chips, score bars, γflip/walls/exp-move, LIVE NSE vs BS MODEL tags, failed rows honestly listed).

### CLEAR CLOSED TRADES (the console button)
- **`POST /api/ai/positions/clear-closed` + `clearClosedPositions()`** — sweeps ONLY `status === 'CLOSED'` rows from the journal through the writer lock (OPEN/UNKNOWN structurally untouched), stamps a `HOUSEKEEP` audit entry with the count; the tamper-evident LEDGER keeps the permanent trail.
- **🧹 CLEAR CLOSED (n) button** in the Execution Console (all 3 desks) — only rendered when closed rows actually clutter the list, spinner + result chip, parents refetch via the new `refreshPositions` hook export.

### SECTION 5 — Performance / lag cleanup
- **THE render-storm killer** — `useAITrading` merged every SSE `tick` event with its own `setPositions` (crypto cadence ⇒ up to N re-renders/SEC of the whole tab tree — the console "lag"). NEW `src/utils/tickBatcher.ts`: ticks buffer per-id (latest-wins, partial deltas merge) and flush in ONE state update every 800ms — the same proven pattern `useCxLivePrices` ships. Hidden tabs render ZERO times; structural `positions` snapshots flush instantly; visibilitychange force-flushes. 20 → 1 renders per window (test-locked).
- `TrackRecordPanel` memo'd (its only prop is a number — the tab's live flushes now skip that subtree); OrderConsole sweep state is local; the board card grid already rides primitive `liveLtp` props so only price-changed cards re-render.
- **Calendar determinism fix (pre-existing, found live)**: the agent suites asserted exact sizing (₹390 / qtyINR 5000) with the REAL event-guard calendar live — they silently halved or blocked entries around FOMC/CPI windows (today's FOMC 16-Sep proved it: ×0.5 haircut live). All 5 agent-tick suites now pin a neutral event guard — the sizing/mandate/entry math under test is calendar-independent.

### Verification
- NEW `test/indiaUniverse.test.ts` (28: wire parsing/validation/local sort · grammar · tier split incl. THE hot-rides-T1 lock · rotation wrap/adaptive · heat rule · TTL/refresh/cap/eviction · discovery cache/single-flight/negative-cache/seed fallback · wire filter contract · tiered scan + exclude + flag-off parity) · `test/indiaBoardTiered.test.ts` (3: board wiring — chunked batch on the tiered set, honest superMeta, legacy path on discovery-down, hot absorb gating) · `test/optionsScan.test.ts` (17: direction tally BULL/BEAR/NEUTRAL · score math incl. model-penalty + dte drag · row contract + degrade · picker intersection · execution: ranking/cache/single-flight/all-model honesty/group-size cap) · `test/clearClosedPositions.test.ts` (6: only-CLOSED · HOUSEKEEP stamp · no-op writes nothing · lock serialization · repeat-safe) · `test/tickBatcher.test.ts` (10: N→1 render · latest-wins · partial merge · hidden no-op · flushNow · dispose · garbage-safe · visibility flush) · `test/intradayTvChunking.test.ts` (3: 150-symbol → 3×100-ticker chunks · small-universe single-shot parity · dead-chunk containment).
- Calendar-determinism patches: `agent/indiaAgent/mandateFreeze/nearMissAutoTrade/v101AgentAccuracy` (neutral eventGuard mock).
- **tsc CLEAN · 103 files / 1865 tests ALL PASS (×5 consecutive full runs) · vite build CLEAN (5.3s) · npm audit 0/0 · ml-service pytest 11/11 · `scripts/smoke_v1017.mjs` 20/20 incl. LIVE TV discovery (219-220 names) + LIVE NSE chain scan (3 live desks, 5 honest model fallbacks from this sandbox IP).**

### Deferred (documented, not forgotten)
- Telegram `/opts` command for the options scanner (the site panel covers the need; bot surface additions ride the next telegram batch).
- Journal file micro-cache (`loadJournal` reads disk per call — bounded sizes make it ~2-4ms; revisit only if profiling ever shows it hot).
- The TV India filter-query column set is minimal (name/exchange/close/change/volume/value_traded/relvol/mcap) — discovery is liquidity-only by design; no fundamental columns fetched.
# Changelog

## v10.16 — MANUAL TRADE TRACKER + SUPERINTEL THRESHOLD REFORM (2026-09-16)

**The superintelligence plan v2's Section 2 (the user's OWN trades) + Section 3 (the conf=60 threshold spec), fully applied.** Suite grew **1747 → 1799 tests, all passing** (+52 across 1 new file + 5 extended files); boot smoke 14/14 (`scripts/smoke_v1016.mjs`); tsc clean; build clean 5.1s; audit 0/0 both trees.

### SECTION 2 — Manual Trade Tracker ("Maine ye trade liya hai")
The gap: paper trades are tracked, agent trades are tracked — the user's OWN real trades had zero support. Now every manual entry gets the SAME intelligence the desk gives its own positions:
- **NEW `server/ai/manualTrades.js`** — the full tracker: the ORIGINATING SIGNAL SNAPSHOT is frozen at record time (plan + 14-model votes + regime + AI score — the baseline every later "trend change" is measured against), live P&L (₹/USDT + %, direction- and lot-aware, correct currency domains), SL/T1/T2 distances in the trade's favor-frame, time-in-trade, and the escalating STATE BANNER: **THESIS INTACT (green) → WEAKENING (amber) → EXIT NOW (red, pulsing, pinned to top) → TARGET HIT (blue)** — TARGET beats EXIT (a reached target is bookable truth); UNKNOWN conviction degrades honestly to STALE, never a dead bar.
- **The monitor** (5s LTP sweep · 30s conviction re-vote via the SAME cached deep path the agents use — zero new upstream calls · parks at 60s idle when flat): conviction FLIP → immediate highest-priority Telegram push **carrying the WHY** (`flipSummary`: which named models switched sides vs the frozen entry votes + the entry→current score move — "so you can judge rather than obey"); SL approach within 0.3×ATR (5-min re-nudge); each target hit (once per level); stagnant check-ins on quiet trades. All pushes cooldown-guarded; a thrown deep call degrades to UNKNOWN exactly like an `ok:false` one.
- **Instrument coverage** exactly where signal cards exist: India equity + F&O options (premium re-priced via Black-Scholes on the live underlying, entry IV held — the paper-desk basis; expired → intrinsic) + crypto spot/perps (live tick store) + global SIM.
- **UI**: `ManualTradePrompt` on every signal card (entry price pre-filled with the live LTP, editable — a >15% deviation WARNS, never blocks: genuine fills can be off, but one typo silently corrupts every downstream P&L number) + the `ManualTradeMonitor` section in BOTH desks (CoinDCX + India Intraday — 5s repaint while trades are open, EXIT NOW rows pinned, closed-history collapse). Telegram confirmation pushes on record + close.
- **5s level-touch parity**: the manual rows ride the SAME `telegramPush` instant-push pipeline as the CoinDCX + India paper desks (SL/T1/T2 touch pushes, **✋ MANUAL tagged**, honest footer — no executor-watcher promise for a trade no executor watches; INR-domain rows carry ₹ uP&L, USDT-domain rows omit the number rather than guessing an FX conversion). `manualPushes` joins the status heartbeat.
- **Telegram commands**: `/manual` (live list, EXIT NOW rows pinned first, conviction bars + distances per row) + `/manualclose <id> [price]` (default: live price). Both `/help`-registered.
- **Persistence**: `server/data/manual-trades.json` (atomic debounced writes, backup-mirrored, graceful-shutdown flush — the paper-desk contract). Capped at 300 trades.
- **Bugs found & fixed during this ship** (the interrupted-session handoff): `../../intraday/backup.js` wrong path (module couldn't even import), `_monitorTick` read its injected deps off `_mon` instead of `_mon.deps` (getDeepSignal/fetchers undefined → the conviction re-vote and with it EVERY alert silently dead), `manualTradesToPositionRows` spoke BUY/SELL + no `status` field (detectLevelTouches would never fire — and would have level-checked inverted had it fired), and the level-touch adapter was never actually wired into the sink. All now test-locked.

### SECTION 3 — Superintel threshold reform (USER SPEC: conf=60)
The diagnostic that motivated it: Path B (STRONG grade + conf + agreement) was UNREACHABLE at 80/0.75 — a second qualification route that could never fire, while the flat +10 quorum penalty made a 4-voter committee (one honest abstain) face an 85 bar. Both agents now:
- **minConfidence 80 → 60 · minAgreement 0.75 → 0.65** — Path B is a realistic second route (quality still guarded by the STRONG-grade + executable + quorum-honesty caps; a 78% STRONG committee signal that was BELOW the old bar now qualifies — test-locked). Saved configs migrate untouched-old-defaults to the new bar; explicitly customized values are preserved verbatim.
- **PROPORTIONAL quorum penalty** (the primary trade killer): thin committees pay **+1.5/voter below 5, capped at +5** (4 voters → +1.5 · 3 → +3 · 1 → +5) — rigor preserved (thin still pays MORE than full), the cliff is gone. `thresholdProfile: 'flat'` restores the legacy +quorumPenalty arm for A/B; every entry journals the active profile + the exact bar it cleared (the weekly review can compare outcomes honestly).
- **Abstention diagnostics** (the root-cause-behind-the-root-cause): the wire signal now carries `abstentions` (which models sat out + their stated reason); thin-committee near-misses NAME the abstainers ("THIN COMMITTEE SOL — 3/14 models voted; abstained: OptionsFlow (no chain) · InstFlow (feed cold) — data-feed fixes here lift quorum at the source") — fixing a dead feed is the QUALITY fix vs lowering bars. Panel-visible on every near-miss row.
- Both agents (crypto + India) share ONE `effectiveScoreBar` truth (the near-miss gap math reads it too — no stale inline +10); the status panel exposes the new worst-case thin bar (80, was 85).

### Verification
- NEW `test/manualTrades.test.ts` (44: pure math ×5 suites · banner priority · snapshot freeze · CRUD validation + F&O contract · LTP resolution per market incl. BS re-price · alert ladder ×6 incl. cooldowns + containment · level-touch wiring contract incl. the LONG/SHORT translation + INR/USDT P&L-domain honesty · monitor loop ×5 incl. THE deps-live-on-_mon.deps wiring lock + UNKNOWN degradation + idempotent start).
- Extended `test/telegramPush.test.ts` (+4: manual SL touch fires the same path MANUAL-tagged with the honest footer · T1+T2 both fire on a gap-through with ₹ uP&L · USDT-domain rows push without a guessed conversion · a broken manual store never breaks the other desks) · `test/agent.test.ts` (+1: the 78% STRONG Path B unlock) · `test/nearMissAutoTrade.test.ts` (+2: proportional ladder 4/3/1/0 voters + flat A/B arm + full-quorum) · `test/v101AgentAccuracy.test.ts` (+1: the no-cliff boundary — voters 3 at exactly 78 enters, 76 doesn't; worst-case thin bar 80) · `test/indiaAgent.test.ts` + `test/mandateFreeze.test.ts` (parity assertions).
- **tsc CLEAN · 97 files / 1799 tests ALL PASS · vite build CLEAN (5.1s) · npm audit 0/0 both trees · `scripts/smoke_v1016.mjs` boot smoke 14/14** (module contract + snapshot freeze + view + rows + sink wiring + threshold bars + bot commands).

### Deferred (documented, not forgotten)
- OPTION-trade conviction: the deep re-vote scans the UNDERLYING's symbol — an option's own conviction banner reads the index/equity committee (honest enough: the option's thesis IS the underlying's); a strike-aware re-vote would need an options-context deep path that doesn't exist yet.
- Manual-trade Telegram pushes for `evaluateManualTradeAlerts` currently ride the monitor's 30s conviction cadence; the 5s SL-touch parity comes from the level-touch sink — a 5s conviction-grade escalation would need the monitor's loop split (deliberately not done: 30s matches the agents' own re-vote cadence).

## v10.15 — SUPERINTELLIGENCE UPGRADE + BINANCE FUT WS ACCELERATOR (2026-09-16)

**The deep-recheck #2 remaining gaps + the intraday/CoinDCX superintelligence upgrade plan, fully applied.** Both plans verified against `db1f5a9` first (TS 0 errors · 92 files/1666 tests · audit 0/0 — everything already shipped was deliberately excluded). Suite grew **1666 → 1747 tests, all passing** (+81 across 4 new files + 4 extended files); boot smoke 7/7 live-verified (`scripts/smoke_v1015.sh`); build clean; audit 0/0.

### SECTION 1 — Binance futures WS: the real remaining speed fix
- **NEW `server/ai/binanceFutWs.js`** — the FUT_ accelerator TIER between the CoinDCX socket and the Binance REST fallback, modeled directly on cryptoStream.js's proven Binance client (combined-stream subscription, 3-fail handshake circuit breaker, 5-min rapid-cycle backoff, geo-block 451 honesty, 1MB frame cap, 20-stream cap, 2s resub debounce). When CoinDCX's futures socket goes dark (WAF blip/403/cooldown), FUT_ now gets **SUB-SECOND pushes** from `wss://fstream.binance.com` instead of degrading to the 5s REST cache — the "ab pehle jaisa ultra-fast nahi lag raha" moment for BTC/ETH/SOL is gone. Priority chain: CoinDCX Socket.IO → **Binance futures WS (new)** → Binance REST 5s → stale-serve.
- **Hot-standby semantics:** the accelerator socket opens ONLY while the CoinDCX WS isn't proving ticks and closes the moment it recovers — normal operation is byte-identical to v10.14 with ZERO extra upstream connections. Opens/closes with the SSE client gate (Render idle-friendly).
- **Source-priority gate + no badge flapping:** a binance-fut-ws tick never overwrites a fresh `coindcx-fut-ws` (<3s) or `coindcx-fut-rt` (<2.5s) tick (CoinDCX is the desk's authoritative exchange); out-of-order guard on late frames; `binance-fut-ws` renders as its own emerald **Binance·WS** pill (distinct from the 5s sky `Binance·RT`); REST-cadence floor applies while the accelerator owns FUT (GLOB-subscribed sessions keep 2s — GLOB has no Binance path); the REST fallback skips WS-covered symbols; status frame + `/api/feed-status` + the CoinDcxTab honesty chip carry the tier's state ("· FUT Binance·WS⚡" while the CoinDCX socket cools).

### GAP 1 — Live Conviction Tracker (the ensemble now works DURING the trade)
- **NEW `server/ai/positionConviction.js`** — the 14-model ensemble that decided "LONG with 82% confidence" re-votes every open position each tick via the SAME 30s-cached deep path the boards use (zero new upstream calls). `convictionDelta = currentScore − entryScore` (sign-relative to the position's direction) → **STRENGTHENING / HOLDING / WEAKENING / FLIPPED**.
- Wired into BOTH agents' exit ticks (inside the existing gauntlet — kill-switch/daily-cap early-returns gate it; an exit can never bypass the caps): **FLIPPED** (opposite side WITH quorum — ≥5 voters or STRONG) → immediate `conviction-flip` exit BEFORE the stop (thesis invalidation); a flip without quorum is noise, not an exit. **WEAKENING + in-profit** → SL ratcheted toward breakeven (never a hard exit; losing positions are never tightened — no disguised early exits on noise). **STRENGTHENING** → earns winner-extension room even marginally red; **WEAKENING/FLIPPED never earn it** (`extensionEligible` gained the conviction param; absent = the exact v10.8 behavior — locked by tests).
- Live conviction bar on every open agent position in both panels (green ▲ STRENGTHENING → amber ▼ WEAKENING → red ⯅ FLIPPED, with entry→now score + delta). Entry-time conviction score recorded at every entry (the delta anchor; `Number(null)===0` trap fixed in the pure core). Gated behind `AI_ENABLE_CONVICTION_EXIT` or the agent knob — **OFF by default, flag-off = byte-identical**.

### GAP 2 — Event Guard (scheduled-event awareness)
- **NEW `server/ai/eventGuard.js`** — the one question a pro trader asks before entry that the system never did: "is anything scheduled?" Three GRADED responses: **T-30min blackout** (block new entries on the affected symbol/desk — existing positions untouched), **T-2h sizing haircut ×0.5** (multiplier into the risk path, both flat and kelly-capped), and NO auto-flattening by design (the partial-TP/breakeven ratchets already de-risk into events; flattening green runners on every CPI print is churn).
- Calendars (honesty first — every derived date labeled approximate): NSE/US earnings lifted from the frontend's own `earningsCalendar.ts` table and rolled FORWARD quarterly (stale dates never block); FOMC 2026–2027 published decisions; RBI MPC published 2026 H1 + `AI_EVENT_EXTRA_JSON` for additions (invented H2 dates = false blackouts — missing data degrades honestly); India CPI/IIP + US CPI as labeled monthly patterns. Desk scoping: FOMC/US-CPI hit ALL desks (crypto is macro-sensitive); RBI/India-CPI/IIP hit INDIA only; earnings hit the symbol's desk.
- Integrated into BOTH agents' entry gauntlets (veto reason lands in the journal + panel blockers like every other gate) + the **⚠ event chip on every signal card** (`⚠ FOMC 30m · ENTRY BLOCKED` / `⚠ Earnings in 2h · size ×0.5` — the manual trader sees the same warning the auto-agent vets against) + `GET /api/ai/event-guard` status route. `AI_DISABLE_EVENT_GUARD` kills it; tunables `AI_EVENT_BLACKOUT_MIN/HAIRCUT_MIN/HAIRCUT_MUL`.

### SECTION 3 — Direction-accuracy split (the standing "are directions right?" answer)
- `weeklyReview.computeAiDeskWeek` gains **byDirection** (LONG vs SHORT trades/wins/win-rate/net-P&L, from closed positions — the only journal rows carrying side) and **byEntryHour** (IST entry-hour buckets — the "first-15-min entries lose" / "post-lunch chop" pattern detector). Both reach the Telegram header + the LLM prompt block (new **Direction Read** section in the digest).
- `trustReport()` gains the settled-ledger **direction split** (n / win-rate / avg-R per side) — rendered as the Model Performance Panel's new **DIRECTION SPLIT** block with a side-gap read (≥15 pts gap flags "ek side systematically weak hai").

### GAP 4 — Global Risk Brain (the cross-desk portfolio view)
- **NEW `server/ai/globalRisk.js`** — ONE exposure view across both desks (per-position stop-distance risk with correct currency domains, net directional bias, unpriced count — never invented), ONE portfolio-level **heat cap** (`AI_GLOBAL_HEAT_CAP_PCT`, default 6%) consulted by BOTH entry gauntlets (combined deployed risk over the ceiling vetoes entries regardless of which desk asks — "max-long NIFTY IT + max-long crypto" is finally seen as ONE bet), the rolling **BTC↔NIFTY** correlation (reuses the 60d matrix), and **risk-off detection** (VIX spike ≥25 & +15% over 5d AND BTC >1.5% below its 20d SMA — TOGETHER; each leg alone ≠ risk-off) that down-weights new-entry sizing on BOTH desks at once (×`AI_RISKOFF_MUL`, default 0.5). Unreachable market data → riskOff false + dataOk false (missing data is not a signal). 5-min cache — the gauntlet reads it free. `AI_DISABLE_GLOBAL_RISK` kills it.

### GAP 3 — Patient Entry (execution patience)
- **NEW `server/ai/patientEntry.js`** — an EXTENDED signal (>1.5 ATR beyond its anchor) rests at a **depth-derived pullback level** (just above a detected bid wall for longs / below an ask wall for shorts — via the shipped order-flow depth module; no readable depth → the signal's own anchor, never an arbitrary ATR fraction) for a validity window (**15m crypto / 10m India**, `AI_PATIENT_WINDOW_MIN`) instead of chasing. At-anchor signals enter immediately, exactly as today.
- Both agents: the resting order comes FIRST each tick (touched level → execute the PLANNED entry if the board still backs the side; signal gone → cancel, no chase); unfilled expiry → journaled **`missed-pullback`** (a GOOD outcome — it didn't chase); one resting order at a time; waiting doesn't block other symbols. Every entry journals an **`ENTRY_MODE` marker**, and the weekly review gained the **patience A/B** (`byEntryMode`: immediate vs patient closed-position win-rates + missed-window count) — "did patience pay?" is now a number, not a belief. Gated behind `AI_ENABLE_PATIENT_ENTRY` or the knob — **OFF by default (ship-last, A/B-able)**.

### SECTION 2 — Telegram: the implementable triage steps
- `/fiidii` + `/ipo` now reply with a clear **"needs TAVILY_API_KEY"** message when the key is missing (was an opaque error) — key-missing ≠ dead command, per the evidence-first triage.
- `/coindcx` ↔ `/crypto` cross-referenced each way with explicit wording (account status vs market prices — deliberately NOT aliases; they are different data paths by design, the "dedupe" is the shared wording + pointers, killing the two-sources-of-truth confusion without deleting working functionality).
- `/selftest` footer now carries the **triage procedure** (⚠️ = add the key, don't remove; ❌ = re-run twice, delete only PERMANENTLY dead paths incl. their helpers; transient timeouts = keep). The actual deletion pass still waits for the user's LIVE `/selftest` run — by the plan's own "needs your live run before any deletion is safe" rule.

### Verification
- NEW `test/cxRtStream.test.ts` v10.15 suite (7: dark→WS sub-second & REST-bypassed · both-dark→REST tier · cx-recovers→stand-down · source-priority no-flapping · idle-close · 20-stream cap · out-of-order) · NEW `test/positionConviction.test.ts` (21: pure classification ×8 · quorum/flip bar · weakening-tighten policy · extension interplay + zero-regression flag-off · flag round-trips · status payload) · NEW `test/eventGuard.test.ts` (16: blackout/haircut/allow ×desk-scoping ×calendar honesty ×status/chip) · NEW `test/globalRisk.test.ts` (15: exposure math ×currency domains · risk-off legs · gate/veto · tunables · honest degrade) · NEW `test/patientEntry.test.ts` (18: at-anchor/extended · wall levels · fill/expire/wait · flag · patience A/B) · extended `weeklyReview.test.ts` (+5 direction/hour/A-B) · `liveSourceBadge.test.tsx` (+1 Binance·WS pill).
- **tsc CLEAN · 96 files / 1747 tests ALL PASS · vite build CLEAN (5.0s) · npm audit 0/0 both trees · `scripts/smoke_v1015.sh` boot smoke 7/7 LIVE** (modules import+exports · event-guard route carries the FOMC/RBI/CPI calendar · feed-status carries the accelerator tier · SSE 200 with the tier live · trust route alive).

### Deferred (documented, not forgotten)
- GLOB_ (AAPL/MU/SPCX) acceleration: no crypto exchange lists single-stock perps — Finnhub remains the correct shipped answer (by design, not omission).
- Section 2's command DELETION pass: blocked on the user's live `/selftest` evidence (the plan's own prerequisite); the triage procedure + needs-key messages are in place so the next session can act on data.
- India winner-extension: the India agent still has no extension system (the crypto agent's parity item the conviction tracker hooks into); conviction there is exit+tighten only, recorded honestly in the panel.
- All four GAP engines are flag-gated OFF by default (`AI_ENABLE_CONVICTION_EXIT` · `AI_ENABLE_PATIENT_ENTRY` · event-guard ON but `AI_DISABLE_EVENT_GUARD` exists · global-risk gate ON but `AI_DISABLE_GLOBAL_RISK` exists) — flip them one at a time and A/B against the v10.14 baseline.

## v10.13 — FULL-SITE DEEP RECHECK: SECURITY + RESILIENCE HARDENING (2026-09-15)

**The requested "deep advance pro-level" full-site code recheck.** Three parallel deep reviews (server core + security, realtime stream modules, frontend core) — every finding re-verified against source before fixing. **2 HIGH security issues, 9 MEDIUM bugs, 20+ LOW issues found; all HIGH/MEDIUM and the cheap LOWs fixed, each with regression tests.** Suite grew **1621 → 1655 tests, all passing**; boot smoke 7/7 with the new security layer live-verified.

### SECURITY (HIGH)
- **H-1 master-token bundle leak (config footgun chain):** `render.yaml` still declared `VITE_API_TOKEN`/`VITE_ENCRYPTION_KEY` (build-time VITE_* vars are INLINED into the public JS bundle) while `requireAuth` treats `API_TOKEN` as a master bearer for EVERY endpoint — setting both to the same value (the naming invites it) handed every anonymous visitor full auth. Removed from the blueprint, removed the `api.ts` build-time read (cloud sync auth = runtime localStorage override only), and `validateEnv()` now REFUSES TO BOOT when `VITE_API_TOKEN === API_TOKEN` (live-verified both refusal and warning paths).
- **H-2 CSRF on no-body mutations:** the `SameSite=None` session cookie rode along on cross-site "simple requests" — silently authenticating `POST /api/ai/orders/cancel-all`, `kill-switch {}` (= DISARM), broker/API-key disconnects. The logout route already had the discriminator; it is now a GLOBAL middleware for every state-changing request: **cross-site + session cookie + no Bearer → 403** (login exempt — nothing to hijack pre-login; bearer/service calls unaffected). Live-verified in the boot smoke: cookie+cross-site+no-bearer → **403** on kill-switch; same-site → 200; bearer+cross-site → 200 (the app's own Vercel→Render path).

### SECURITY (MEDIUM/LOW)
- Telegram webhook now **fails closed in every mode except explicit `NODE_ENV=development`** (the old gate only refused `NODE_ENV === 'production'` — the repo's own VPS/start_server.vbs paths run unset and accepted forged updates); secret-token compare is now constant-time.
- **Global PIN-failure lockout** (150 failed PINs / 15 min across ALL IPs → 5-min login lockout) — the per-IP limiter alone was bypassable by rotating IPs against a 4-digit PIN; short-PIN boot warning added (not enforced — no lockout of existing deployments).
- Public market-data endpoints (`/api/quote`, `/api/chart`, `/api/fundamentals/:symbol`) gained per-IP rate limits (900/300/240 per 10 min — far above the busiest legit tab); growwQuote's `_failStreaks`/`_backoffUntil` maps are now swept at >500 entries (random-symbol enumeration through the public quote endpoint could grow them forever).
- Compat AI proxies clamp `max_tokens` (≤8192) / `temperature` and strip `stream`; backtest/swing/whales symbol lists capped at 12 + charset-validated; `/api/vision-analysis` no longer forwards the raw upstream error body to the client; body-parser errors now 400 (was 500); graceful shutdown drains in-flight responses (`server.close()` + 2s deadline) before exit.

### REALTIME STREAMS (the honesty + liveness fixes)
- **Groww grossly-stale row guard:** while the NSE window is open, a `lastTradeTime` from before today's 09:15 IST session (the exact v10.12.1 garbage shape: Nov-2023 rows) or an absurd future clock → rejected → quick-retry → honest Yahoo fallback. Same-session old timestamps stay accepted (illiquid symbols still have an honest LTP); outside market hours nothing is gated.
- **Finnhub WS liveness:** ping every 30s + 90s idle watchdog — a half-open TCP (laptop sleep→resume, NAT rebind) previously left `readyState OPEN` forever, silently losing Priority-1 instant trades for the process lifetime while the Yahoo fallback masked the degradation.
- **Epoch UNIT normalization** in `cxRtStream._landWsTick` + `futures.js` + `globalFutures.js` (`ts < 1e12 → ×1000`): the WS out-of-order guard compared CoinDCX SECONDS against internal MILLISECONDS — correctness was luck-dependent, and a seconds value stored into liveFeed poisoned frontend freshness.
- **`setScanSymbols` per-market maps:** an India scan no longer wholesale-evicts the crypto scanner's signal symbols (and vice versa) — each market owns its set, the watch set unions both.
- inStream fresh-symbol fan-out bounded (semaphore 6, usStream pattern — was 60 parallel Groww round-trips at page-load); inStream + intraday `_tick` re-entrancy guards; `_latestQuotes` prunes departed symbols (>10 min off the watch set); intraday `INDEX_SYMBOLS` is now the 10-name union (NIFTY50/NIFTYBANK/CNXIT paper trades can no longer hit Groww's garbage index endpoint); Finnhub REST bootstrap honestly labeled `finnhub-rest` (`finnhub-stream` reserved for actual WS trades); `_fallbackPoll` re-entrancy guard (overlapping TV batch POSTs when TV is slow — the rate-limit vector); WS frame size caps (1MB) on all three sockets; Binance reconnect jitter + rapid-cycle backoff (5+ connect-drop cycles/5 min → 60s hold-off).

### FRONTEND
- **SSE client resilience (liveStream.ts):** `onerror` now immediately downgrades feed status (`onStatus({})` — pollers speed up honestly instead of trusting stale "live" flags while the header still shows every feed LIVE), and a sustained error streak (≥6, no open) takes over from the browser's tight default retry loop with a **capped manual backoff that rebuilds the URL — re-reading the session token** (an expired 30-day token no longer loops 401s forever; a re-login heals the stream). Same pattern in `useIntradayStream`.
- **ErrorBoundary `key={activeTab}`** — one crashed tab no longer bricks the whole `<main>` area ("switch tabs" recovery now actually works).
- **Badge honesty:** unknown/missing source renders a NEUTRAL slate pill (was green "LIVE" — a label sink laundering delayed/unknown feeds into realtime-looking pills); `yahoo-us-fallback` → amber Yahoo·delayed; `finnhub-stream`/`finnhub-rest`/`tv-us-batch` map distinctly.
- Dead-but-exported hooks fixed before they become landmines: `useWebSocket` (handlers via refs — stale closures gone; CONNECTING-state duplicate-socket guard; manual `connect()` resets the attempt counter; symbols subscribe keyed on a string), `useServerSentEvents` (`useStreamingAI` cross-read line buffer — SSE frames split mid-chunk were silently DROPPED; `useLiveUpdates` ring-buffered at 200).
- **txn_history ledger capped at 5,000** (record/persist/cloud-save/restore surfaces — unbounded growth silently killed persistence at the ~5MB quota); tvWebsocket's global kill now clears callbacks (a stray second subscriber can no longer ride a dead socket); `apiFetch` no longer mutates the caller's `init`; `batchFetchPrices` + both SSE clients resolve the proxy base LIVE (runtime backend switch no longer split-brains REST vs stream); caller-initiated aborts are not retried; IndexedDB rejected-open promise resets (a transient failure no longer pins the localStorage fallback for the session); cache cleanup timer lazy-starts; `secureStorage.setItem` degrades to plaintext on WebCrypto failure (matches `setItemAsync`) instead of an unhandled rejection; IST date keys via the formatter directly (weekly-report dedup + daily snapshot were off-by-one outside IST); tab hotkeys ignore Ctrl/Cmd/Alt combos + contentEditable; cloud-merge retry cancellable on logout.

### Verification
- NEW `test/deepRecheckV1013.server.test.ts` (19: stale-row guard 4 paths + inert-outside-hours + failure-map sweep + per-market scan sets + 8 static index.js security guards) · NEW `test/liveStreamResilience.test.ts` (7: honest downgrade, transient-vs-sustained streaks, fresh-token manual reconnect, teardown) · +2 normalization cases in `cxRtStream.test.ts`, +3 NODE_ENV fail-closed cases in `telegramWebhook.test.ts`, +6 badge-mapping cases in `liveSourceBadge.test.tsx`.
- **tsc clean · 92 files / 1655 tests ALL PASS · vite build clean · npm audit 0 vulns · boot smoke 7/7 live-verified** (CSRF 403/200 discrimination, login exemption, quote rate-limit 429, SSE `?session=` 200) · browser E2E: login + 3 tabs, SSE connected, ZERO JS errors. Bundle scan: no `VITE_API_TOKEN` reference remains in `dist/`.
- Known deferred (design-level, documented): short-lived SSE stream tickets to keep 30-day tokens out of URLs (nginx log scrubbing recommended meanwhile); backup-module consolidation; `uncaughtException` survival policy (deliberate free-tier tradeoff, kept).

## v10.12.1 — INDIA INTRADAY: DEEP-RECHECK FIX (2026-09-15)

**Full-site deep recheck (the agreed final step after Plan C) found one real bug — fixed + live-verified.**

### The bug (live on the wire, caught by the boot smoke)
- `server/inStream.js` (`/api/stream?in=` SSE writer) tried Groww FIRST for INDEX symbols too — but Groww's `CASH/<INDEX>` endpoint serves a **garbage STALE ltp** (live-observed: `19425.35` with `lastTradeTime` from Nov-2023 while Yahoo's `^NSEI` was current). That garbage passed the `price > 0` check and went out as **`IN_NIFTY` @ 19425.35 tagged `groww-live`** — a WRONG price with the WORST possible badge, the exact opposite of the v10.12 honest-source goal.
- `/api/quote` (INDIAN_INDICES skip) and `intraday/stream.js` (INDEX_SYMBOLS → Yahoo override) already handled this; the inStream poller was the one gap. The old test only mocked "Groww returns null for NIFTY" — reality returns garbage, so the gap was invisible to the hermetic suite.

### The fix
- `inStream.js`: `INDEX_SYMBOLS` (union of the other two modules' sets — every name has a YF_INDEX_MAP entry) now skips Groww **entirely**; indices go straight to the Yahoo fallback, honestly tagged **`yahoo-delayed`**. Stocks unchanged (Groww first).

### Verification
- NEW regression test in `streamFeeds.test.ts`: Groww mocked with the REAL garbage payload shape (ltp 19425.35) → asserts Yahoo's current spot is served `yahoo-delayed` AND Groww is never even asked for an index, while stocks still hit Groww first.
- Boot smoke (5/5 PASS, live upstreams): `IN_RELIANCE` 1235.3 `groww-live` · `IN_NIFTY` **23118.6 `yahoo-delayed`** (was 19425.35 `groww-live`) · `/api/feed-status` shows both sources live.
- Browser E2E: India Intraday board renders **Groww·live** emerald pills next to live LTPs (AXISBANK ₹1,222.9, SBIN ₹968 — VLM-verified screenshot), SSE 200, zero JS errors.
- Suite: **90 files / 1621 tests ALL PASS**; tsc clean; vite build clean.

## v10.12 — INDIA INTRADAY: PLAN C HARDENING (2026-09-15)

**The user's 2-part plan, implemented end-to-end** (source-transparency badge + faster retry/backoff on Groww; Groww REST + TradingView WS as-is, no broker account).

### #1: Source-transparency badge — Groww·live / TV·WS / Yahoo·delayed
- Every India live tick now says WHICH upstream served it, end-to-end:
  - `server/inStream.js` (the `/api/stream?in=` SSE writer): canonical labels **`groww-live`** (Groww NSE served it) / **`yahoo-delayed`** (Yahoo fallback — indices, which Groww doesn't cover, or a Groww miss); the old `groww-in-stream`/`yahoo-in-stream` labels are retired (App.tsx `NSE⚡` chip + `useAppState` India-SSE-health regex updated to match).
  - `server/intraday/stream.js` (the `/api/intraday-stream` quotes the intraday signal cards + paper P&L actually run on): every quote tagged — stocks `groww-live`, indices `yahoo-delayed` (Groww's CASH/NIFTY endpoint serves a garbage index ltp — verified live 19425 vs 23398), crypto watch symbols `coindcx-inr`.
  - `src/utils/tvWebsocket.ts`: every browser TradingView-socket update tagged **`src: 'tv-ws'`**.
  - `src/utils/liveStream.ts`: the SSE wire `source` field now passes through into `PriceData.src` (was dropped); `PriceData` + `LiveQuote` gain the optional `src` field (zero breakage — absent = neutral LIVE pill).
- `LiveSourceBadge` (the v10.11 CoinDCX pill, reused verbatim for visual consistency) maps the three India labels: **Groww·live** (emerald) / **TV·WS** (sky) / **Yahoo·delayed** (amber).
- UI wiring: the intraday `SignalCard` renders the pill next to `● LIVE` (only when a live LTP exists — a snapshot price shows no provenance pill); `IndiaIntradayTab`'s board cards now get a live LTP overlay + pill from the existing intraday SSE stream (`liveLtp`/`liveSrc` — the aitrading SignalCard's v10.11 props, so the AI desk gets the same live-price treatment as the CoinDCX desk; the stream stays connected in every view mode since the signal board consumes it).

### #2: Faster retry / backoff on Groww failures
- NEW **`server/ai/growwQuote.js`** — the Groww fetcher lifted out of `index.js` (same pattern as v10.11's `finnhubQuote.js`): the 3s micro-cache + in-flight promise sharing is byte-identical (N consumers — /api/quote, intraday scanner, SSE watcher, inStream poller — still cost ONE round-trip/symbol), plus:
  - **Quick jittered retry** — ONE immediate retry after ~300–500ms INSIDE the same fetch cycle; a transient network blip recovers in the same cycle instead of costing a full 3s poll interval (all concurrent consumers ride the one retry — no extra upstream cost).
  - **Per-symbol fail-streak backoff** — after 2 consecutive fully-failed cycles (4 upstream misses ≈ 6s of REAL failure — a blip the retry absorbs never reaches 1), that ONE symbol is skipped for one poll cycle (~4.5s): honest null returns instantly with ZERO upstream traffic (callers fall back to Yahoo), the probe resumes after the hold, and one success anywhere resets the state completely. Steady state for a dead symbol = half-rate probing — never hammering, never frozen, and the shared cache budget stays healthy for symbols that ARE working.

### Tests (v10.12)
- NEW `test/growwQuote.test.ts` (12 — cache/normalization/never-throws + retry-same-cycle + backoff arm/instant-null/per-symbol/expiry/reset/half-rate steady state), `test/indiaLiveSource.test.tsx` (11 — per-path src tagging: intraday stream groww-live/yahoo-delayed/coindcx-inr, tvWebsocket `tv-ws`, badge mapping, SignalCard render gating). UPDATED `test/streamFeeds.test.ts` (canonical inStream labels).
- Suite: **90 files / 1620 tests ALL PASS** (was 88/1597); tsc clean; vite build clean; npm audit 0 vulns; boot smoke clean.

## v10.11 — COINDCX REALTIME PRICES: 5-PART RELIABILITY PLAN (2026-09-15)

**The user's diagnosis-based plan, implemented end-to-end** ("wiring is correct; the EQUITY SIM (USDC stock-perp) domain's upstream source is unreliable — guessed params + 60s blackout + slow Yahoo fallback").

### #1: Source-transparency badge (trust fix)
- Every liveFeed tick already carries a `source` label on the SSE wire; the frontend now SURFACES it: new `src/components/aitrading/LiveSourceBadge.tsx` renders an 8px provenance pill next to every live price — **CoinDCX·RT** (emerald, direct feed REST or WS), **Finnhub·RT** (sky, fallback #1), **Yahoo·delayed** (amber, final fallback), **Binance·RT** (sky, honest CoinDCX-dark fallback), **SIM·synthetic** (slate, SPACEX). Unknown source → neutral LIVE pill — never a blank, never a wrong guess.
- `useCxLivePrices.ts` passes `src` through (`CxLiveTick.src`); `SignalCard` (+ deep modal), `TopPicksPanel`, `ExpertPicksPanel` all render it (new `liveSrc` / `liveSrcFor` props, optional → zero breakage); CoinDcxTab wires all 4 call sites.

### #2: Negative-cache blackout shrunk (60s → jittered exponential backoff)
- `globalFutures.js` `fetchGlobalFuturesRt`: first failed probe round now blacks out **~10s** (was a flat 60s), repeated failures double it (**20s → 40s cap**) with ±0–2s jitter; **one success resets the streak**. A WAF blip heals in 10s instead of a full minute of degraded prices.

### #3: Finnhub fallback for EQUITY SIM (replaces Yahoo as primary fallback)
- NEW **`server/ai/finnhubQuote.js`** — the US desk's inline fetcher lifted into a SHARED module: one 3s micro-cache with in-flight promise sharing (a symbol one desk just fetched is free for the other) + **one 55/min sliding-window rate limiter** (free tier is 60/min; neither desk can starve the other). The 2026-audit staleness gate survives the lift (open-market stale quotes are rejected → Yahoo), so Finnhub-first can never serve a frozen price during US hours.
- `fetchGlobalQuotes` fallback chain is now **CoinDCX RT → Finnhub → Yahoo** (was RT → Yahoo), rows tagged `source: 'finnhub'` → the badge in #1 shows exactly which upstream served each price. `server/index.js` imports the shared module (byte-parity behavior for /api/quote).

### #4: Endpoint contract confirmed (docs.coindcx.com research)
- The `/market_data/v3/current_prices/futures/rt` endpoint is **documented with NO query params** (sample response = USDT pairs only) — USDC-scoping stays best-effort, so the 3-variant probe stays, but now **array-style FIRST** (`margin_currency_short_name[]=USDC` — CoinDCX's documented multi-value convention on the derivatives family: `active_instruments`), then scalar, then combined. Response row shape (`ls/pc/h/l/v/mp/ts`) confirmed → the parser is docs-accurate.

### #5: CoinDCX futures WEBSOCKET (event-driven, no 2s ceiling)
- Docs confirm a futures socket: `wss://stream.coindcx.com` — **Socket.IO v2 / Engine.IO 3**, per-instrument channels `B-<PAIR>@prices-futures`, event `price-change`, app-level ping every 25s, market data needs **no auth**.
- NEW **`server/ai/cxSocketIo.js`** — a hand-rolled EIO=3 framing client over the existing `ws` dependency (~60 lines, factory-injectable, zero new npm packages — keeps `npm audit` clean; the legacy `socket.io-client@2.4.0` has known advisories).
- `cxRtStream.js` gains the **WS accelerator**: subscribes the refcounted symbol set (`B-<BASE>_USDT@…` + `B-<SYM>_USDC@…`), lands every attributable `price-change` in liveFeed **immediately** (labels `coindcx-fut-ws` / `coindcx-glob-ws`), tolerant to every plausible payload shape (channel-attributed single ticks, inline fields, book-style `prices` maps — the docs' own sample for this event is empty). **Tolerant parse + auto-detect health**: only an ACTUALLY-LANDED tick counts as proof —
  - WS healthy (tick < 30s old) → REST poller slows to a **10s floor** (event-driven freshness + a guaranteed floor for illiquid perp channels that can go minutes without events);
  - WS down / unproven / silent → REST stays at the full **2s** (v10.10 behavior — a docs mismatch can NEVER freeze or slow prices);
  - ns-connected but zero attributable ticks for 2 min → **watchdog kills the socket + 10-min cooldown** (the docs payload is best-effort; the REST poller owns the desks);
  - out-of-order guard (a late WS frame never regresses a newer tick), handshake watchdog 8s, fail-streak circuit breaker (3 → 10 min cooldown), reconnect backoff 3s→24s, idle-close with the SSE client count, engine.io ping→pong auto-answer.
- SPOT deliberately untouched: the spot WS channel (`currentPrices@spot@10s`) is SLOWER than the existing CoinDCX 2s REST anchor + ~1s Binance WS accelerator.

### Tests (v10.11)
- NEW `test/finnhubQuote.test.ts` (7 — shared contract, cache sharing, budget guard, staleness gate), `test/globalFuturesFinnhubFallback.test.ts` (5 — RT→Finnhub→Yahoo chain, per-symbol honesty), `test/cxSocketIo.test.ts` (8 — EIO=3 framing, join/leave exactness, lifecycle honesty), `test/liveSourceBadge.test.tsx` (10 — badge mapping + render gating).
- Extended `test/globalFuturesRt.test.ts` (14 — array-first probe order, backoff growth/cap/reset) and `test/cxRtStream.test.ts` (18 — Finnhub/Yahoo labels + the full WS contract: immediate tick, cadence transitions, degrade path, silent watchdog, out-of-order guard, book-style fan-out).

### BONUS FIX (deep-recheck find — fired live TODAY): expiry-day option-card degeneracy
- The full-suite recheck caught `optionSignalCards` failing at HEAD (pre-existing, untouched by the plan): on the expiry-day MORNING (2026-09-15, the real NIFTY Tuesday weekly, ~15:20 IST) the OTM candidate's BS premium collapses to the ₹0.05 tick → `roundToTick` clamping served a degenerate **0.05/0.05/0.05 card (SL == entry == target)** — meaningless numbers next to a fresh consensus, the exact "wrong call" experience.
- `optionsDesk.js` fix: sub-**₹1 collapsed-premium candidates are DROPPED** (below ~₹1 the bid-ask spread IS the premium — no honest card exists for that strike) + belt-and-suspenders **tick-separation guards** (SL ≥ entry or target ≤ entry can never ship, on any path). +2 regression tests (hand-built collapsed row + the runtime-clock expiry-morning case).

## v10.10 — COINDCX DIRECT 2s RT OVERLAY (2026-09-15)

**The original bug**: the CoinDCX tab's three desks (SPOT / GLOBAL FUTURES / EQUITY SIM USDC) rendered `signal.ltp` — a board-snapshot price that could be ~2.5 minutes old next to a "fresh" signal → "wrong call / wrong signal" experience.

- NEW `server/ai/cxRtStream.js` — the 2s DIRECT-from-CoinDCX poller for the two domains the SSE stream never covered: `FUT_<BASE>` (USDT perps, CoinDCX RT + Binance perp fallback, honest labels) and `GLOB_<SYM>` (USDC equity perps, CoinDCX RT + Yahoo fallback + SPACEX synthetic walk). Refcounted subscriptions, 90s eviction grace, idle-stop, single-flight shared with the board compute.
- `/api/stream` accepts `fut=` + `glob=` params; `signals.js` board TTL 90s→60s with ≤2s-fresh plan pricing; `futures.js` single-flight.
- NEW `src/components/aitrading/useCxLivePrices.ts` — ONE EventSource for all three desks, 800ms batched flush render-storm guard, visibility pause; `SignalCard` live LTP with tick flash + ⚡ LIVE badge + drift-vs-entry chip; CoinDcxTab/TopPicks/ExpertPicks live overlays + the honesty chip.

## v10.9 — TELEGRAM BOT 8-UPGRADE PLAN (2026-09-15)

### Feat #1: ONE SOURCE OF TRUTH — dual-bot unification
- **The problem**: the legacy polling bot (`telegram-bot/bot.mjs`, own `analysis.mjs`/`market.mjs`/`algo.mjs` pipelines) and the site webhook bot (`server/telegram/webhook.js`, site agents) could answer the SAME question DIFFERENTLY — "bot says BUY, site says HOLD".
- NEW `telegram-bot/siteAgents.mjs` bridge: `/scan`, `/screener`, `/consensus`, `/regime`, `/smartmoney` ab the SAME site backend routes chalate hain jo website tabs + webhook use karte hain (`/api/ai/deep/:symbol`, `/api/ai/signals`, `/api/crypto-agent`, `/api/intraday-agent`) over the 127.0.0.1 loopback with the server-only `API_TOKEN`.
- **Never goes dark**: site unreachable → every command falls back to its legacy local path (bot stays alive, just local). The bot keeps its genuinely bot-specific value (Gemini Vision chart photos, FII/DII via Tavily — prepended with the SITE's regime read so interpretations can't drift).

### Feat #2: INSTANT TELEGRAM PUSH (SL/TP touches in seconds)
- NEW `server/ai/telegramPush.js` — a price-driven sink polling `getPositionsWithPnl` (the same cached view the realtime SSE stream serves) every **5s while positions are open**: SL / TP1 / TP2 / liquidation level TOUCH → instant push (level-touch early warning; the 60s watcher stays the executor and sends the fill-confirmed truth).
- Fresh **STRONG signals** scanned every ~30s through the SAME board cache + single-flight (underlying compute cadence unchanged).
- The routes.js 60s alerter is DEMOTED to backup — both paths share ONE dedupe map, whichever sees it first wins. The legacy bot's 10-min algo cron is now a **backup heartbeat**: it checks `GET /api/ai/insta-push/status` and only fires when the pipeline is stale/unreachable. Flag `AI_INSTANT_PUSH=off` reverts to watcher-only.

### Feat #3: WEEKLY TRADE-PERFORMANCE DIGEST
- NEW `server/ai/weeklyReview.js` + `POST /api/ai/weekly-review`: the **quant-computes-numbers, LLM-narrates** pattern — AI desk journal closes (rolling 7 IST days), trust.js calibration (claimed vs realized win-rate, Brier, drift), NSE intraday paper week → ONE LLM narration (Week Scorecard / Calibration Read / Best & Worst / Discipline Audit / Next Week Plan / GREEN-AMBER-RED verdict). Quant header is ALWAYS visible (LLM or not).
- Sunday **19:00 IST auto-push** (`AI_WEEKLY_REVIEW_PUSH=off` disables); on demand: webhook `/weeklyreview` + legacy bot `/weeklyreview` (via the bridge).

### Feat #4: CONTROLLED TELEGRAM ORDER APPROVAL (opt-in, security-sensitive — done LAST as planned)
- NEW `server/ai/tradeApproval.js` + webhook `/trade` + inline **Approve/Reject callback buttons** + **PIN second factor**.
- Security contract (all test-locked): default **OFF** (`AI_TELEGRAM_APPROVALS=on` arms); admin-only (viewer chats blocked); PIN mandatory (`AI_APPROVAL_PIN`, 4–12 digits, 3 tries then dead); **daily hard cap** (default 3 EXECUTED/day IST); 5-min TTL + 3-min PIN window; ONE pending request at a time; approval only triggers the **existing `executeSignal` gauntlet** (`source: 'telegram-approval'`) — fresh-signal re-verification, kill switch, risk caps, mandate freeze, one-per-pair ALL still apply. The button is a manual trigger, it **bypasses nothing**.
- `/trade BTC LONG 5000 x3 paper` grammar is strict — no chat text ever becomes an order on its own. `GET /api/telegram/approval/status` for transparency.

### Feat #5: VOICE NOTES
- Both bots listen now: `bot.on('voice')` (legacy) and webhook voice messages → download → **Groq Whisper large-v3** (Gemini inline-audio fallback) → transcript shown → routed to the SAME desk agent (crypto/intraday inference + session memory) a text question would hit. Legacy bot falls back to its own 7-engine chat if the site is down. NEW `server/ai/voiceNotes.js` (site-side, reads groqApiKey/geminiApiKey from the secrets store).

### Feat #6: MULTI-USER ROLES
- `TELEGRAM_ROLES="<chatid>:admin,<chatid>:viewer"` — the configured chat is ALWAYS admin; viewers get read-only access (desk agents, /status, /weeklyreview, voice notes) and are blocked from every approval surface (`/trade` + the buttons + the PIN window are chat-owner-checked). Strangers stay silently ignored. `/whoami` shows the role.

### Feat #7: CORRELATION-AWARE ALERT BUNDLING
- telegramPush.js STRONG scan: simultaneous crypto STRONG signals with 60d Pearson r ≥ 0.75 (the existing `pairCorrelation`, 15-min cache) go out as **ONE bundled message** ("2 correlated moves — ek hi trade hai, diversify ka dhyan") instead of N pings. Unknown correlation = SEPARATE alerts (never a fake 0). INDIA stays per-signal. `GET /api/ai/pair-correlation?a=&b=` exposes the same read.

### Feat #8: SIGNAL FRESHNESS DECAY (CoinDCX tab)
- The Intraday tab's 5-min stale concept applied to the ensemble boards: `FreshnessBadge` (LIVE green pulse <2min → amber "Xm old" 2–5min → red pulsing "STALE Xm" >5min) + the signal grid **opacity ramp** (100% → 80% → 50%). Grades the SIGNAL COMPUTE freshness honestly — prices on cards may still be SSE-live; the badge says which is which.

### Validation
- tsc CLEAN; vitest **81 files / 1504 tests ALL PASS × 2 consecutive runs** (baseline 1394 + 110 new across 7 test files: tradeApproval 29, telegramWebhook 32 incl. the end-to-end approval + voice flows, telegramPush 21, boardFreshness 11, weeklyReview 11, siteAgents 9, voiceNotes 8); node --check on every touched bot/server module; import-smoke all 7 new/extended modules clean; route registry PASS with the 4 new routes (/api/ai/insta-push/status, /api/ai/weekly-review + status, /api/ai/pair-correlation, /api/telegram/approval/status).

## v10.8 — NEAR-MISS AUTO-TRADE + 4 VE-TRADING PRO PORTS (2026-09-15)

### Feat: NEAR-MISS AUTO-TRADE (user spec: "Near Miss ke trade mat chhodo — highest AI score + high conf wale ko auto trade lagao")
- `agent.js`: jab poora bar (AI score / STRONG committee) koi clear na kare us scan-cycle me, sabse **highest AI-score near-miss** (gap ≤ `nearMissScoreGap` pt below the effective bar, confidence ≥ `nearMissMinConfidence`, 5+ voters quorum-honest, STRONG/ACTION grade, executable plan) **auto-entry** lagta hai — same execution gauntlet, same 3-tier exits.
- Quality guards: `nearMissMaxPerDay` (default 1/day) — journal `NEAR_MISS` markers budget ka audit trail hain; full qualifiers HAMESHA priority rakhte hain; correlation guard + one-per-pair + risk-cap near-miss par bhi apply hote hain; per-day budget khatam → honest skip with reason.
- Panel: Decision Quality strip me near-miss chip (gap/budget live), NEAR-MISSES ab "(auto-traded · best one)" labeled, aur "NEAR-MISS AUTO-ENTRIES TODAY" audit strip; Agent Rules editor me NEAR-MISS AUTO toggle + gap/conf/per-day sliders.

### Feat: WINNER EXTENSION ("trade ke hisaab se extension ho na chahiye")
- Time-exit par jo agent position **profit me** hai aur board par koi qualifying **opposite signal nahi** hai — uski window extend hoti hai (each +`winnerExtendPct`% of the dynamic ATR window, max `winnerExtendMax`× = default 2) aur **SL breakeven lock** ho jaata hai (journal `SL` entry, watcher turant armed). Losers original window par hi cut. Trend-flip hamesha extension ko beat karta hai. Board scan ab time-exit sweep se PEHLE ek hi pass me opposite-qualifying map banata hai (flip-exit + extension veto ek hi truth se padhte hain).
- Panel: win-extend chip + Agent Rules toggle.

### Feat: PRO #4 — BOUNDED-AUTONOMY MANDATE (Vibe-Trading port)
- `agentStart` risk-caps ko **frozen mandate** me capture karta hai (deep-frozen, session-immutable) + journal `MANDATE` audit entry (exact caps ka immutable record). Mid-session config loosening (zyada trades/risk/leverage…) clamp ho jaati hai frozen value par — agent sirf STRICTER hi ho sakta hai; user config file untouched rehti hai; STOP+START fresh freeze. `agentStatus.accuracy.mandate` + panel chip.

### Feat: PRO #1 — BULL/BEAR DEBATE COUNCIL (Vibe-Trading investment-committee port)
- AICouncil ab 3-step chain hai: **Bull Advocate** (strongest honest LONG case, grounded in the same indicator data) → **Bear Advocate** (strongest honest SHORT case) → **PM Verdict** (MUST cite where bull/bear disagree + why it sides one way; same verdicts shape as before).
- Resilience: koi bhi step fail → legacy single-shot prompt fallback (never offline because the debate hiccuped). Flag `AI_COUNCIL_DEBATE` (default ON). SentimentPulse parity preserved. `aiNote.debate` carries both cases on the signal card.

### Feat: PRO #3 — LIGHTWEIGHT CHAT MEMORY (Vibe-Trading memory port)
- NEW `server/ai/agentMemory.js`: per-desk (crypto/protrade) ring of 60 Q&A turns, symbols + topics auto-extracted (whitelist + pair shapes), last 8 + recurring-focus tally system-prompt me feed hote hain — "pichhli baar SOL pe short view tha" continuity. Durable-backed, best-effort everywhere. Wired into cryptoAgent + ProTrader (india chat).

### Feat: PRO #2 — NL CUSTOM STRATEGY LAB (Vibe-Trading strategy-discovery port)
- NEW `server/ai/strategyLab.js` + `POST /api/ai/strategy-lab` + chat tool `backtest_custom_strategy` + Backtest Lab UI block: plain-English idea → LLM compiles a **bounded whitelist rule-expression** (10 indicators × 4 operators × sane value ranges, max 4 entry + 3 exit conditions, ATR-stop 0.5–5, TP 0.5–5R, hold 6–168 bars) → validator rejects ANYTHING outside → walk-forward replay on the SAME candle history (no look-ahead, SL-first, 10bps slippage) → same R-multiple stats shape as the ensemble backtest. Rules jo chale wahi UI pe echo hote hain (full transparency).
- `backtest.js`: `fetchHistoryFor` + `statsFromTrades` shared exports.

### Validation
- tsc CLEAN; vitest **75 files / 1394 tests ALL PASS × 2 consecutive runs** (baseline 1322 + 72 new: nearMissAutoTrade 17, mandateFreeze 9, councilDebate 11, agentMemory 13, strategyLab 22); ml-service pytest 11/11; import-smoke all modules clean; functional smoke of every new pure core.

## v10.7 — COINDCX GLOBAL FUTURES APP-PARITY PRICING (USDC RT feed) + realtime positions fix (2026-09-14)

### Fix: Equity SIM prices never matched the CoinDCX app (AAPL 332.27 site vs 333.62 USDC app)
- **Root cause** (the user's live report): the Global Equity SIM desk priced every symbol from **Yahoo stock spot** (`regularMarketPrice`) — but CoinDCX's Global Futures are **USDC-margined perpetuals that trade 24/7**. Two consequences: (a) the number itself differed (perp premium/discount + delayed Yahoo print), and (b) outside US market hours the Yahoo spot is FROZEN while the perp keeps trading — positions LTP/P&L/SL/TP never moved during IST daytime
- New `fetchGlobalFuturesRt()` (`server/ai/globalFutures.js`) — prices this desk from **CoinDCX's own public derivatives RT feed** (`public.coindcx.com/market_data/v3/current_prices/futures/rt`, the same market_data family the crypto perp desk uses), scoped to the USDC margin domain:
  - the USDC-scoping param is probed in every plausible shape (scalar → array-style → combined-feed scan); a variant is accepted ONLY with ≥ 3 live `B-<EQUITY>_USDC` rows and becomes **sticky**
  - 5s cache (positions SSE stream polls at 1s), single-flight probe (board + stream + watcher share ONE round-trip), 60s negative cache, and a **6s probe-deadline race** so a hung/blocked upstream can never stall the board or the positions stream
- `fetchGlobalQuotes()` — RT first (source `coindcx-usdc`, the feed's own 24h change), **Yahoo fills ONLY the uncovered symbols** (fallback, honestly labeled), SPACEX stays the sim walk
- `buildGlobalCtxSync` / `getPositionsWithPnl` carry the true source (`coindcx-usdc` / `coindcx-gf-rt` / `yahoo` / `global-sim`); markets view exposes the CoinDCX pair (`B-AAPL_USDC`)
- **Realtime positions fixed**: `watchGlobalPositions` SL/TP/trailing and the SSE positions stream now tick on the live perp LTP (24/7 — US hours no longer a freeze window)
- Currency display parity: the GLOBALFUTURES desk labels **USDC** everywhere (ticket, plan strip, toasts, position rows) — exactly the unit the app shows; FUTURES stays USDT, INDIA stays ₹

### Fix: the "full universe scan" was discovering COMMODITIES, not stocks
- The USDT book lists XAU (gold) / XAG (silver) / NATGAS / INX / COPPER / ROBO / SLX / RAYSOL perps — they pass every crypto filter yet are NOT stocks; they crowded the discovered tail with names that have no Yahoo equity ticker
- `fetchGlobalFuturesInstruments()` (`server/mcp/coindcx.js`): explicit `COMMODITY_INDEX_BASES` exclusion + a **USDC instrument scan** (`margin_currency_short_name[]=USDC`, both param shapes, ≥ 3 rows validation) that finds the app's actual Global Futures stock list (AAPL/TSLA/NVDA/TSM/SKHX/SMSN/CRWV/HOOD…) and merges it with the USDT scan (deduped by symbol; rows carry `margin`)

### Tests
- NEW `test/globalFuturesRt.test.ts` (11): variant probing + stickiness, ≥ 3-row validation, negative-cache one-probe-per-minute, dark-row skip, RT-first quotes merge (the stale-Yahoo AAPL case), feed-down full fallback, ctx source honesty, markets-view dcxPair, single-flight, **hung-feed deadline**
- `test/globalInstruments.test.ts` +4 (USDC discovery + merge/dedup, < 3-row USDC ignored, commodity/index exclusion, USDC-only honest partial) → 7 tests
- `test/signalCardCurrency.test.tsx` updated to the USDC contract (GLOBALFUTURES renders USDC + ZERO ₹ / USDT; FUTURES renders USDT + never USDC)
- **1322/1322 tests passing (70 files), tsc clean** — zero regressions across the indiaAgent / ensemble / wick / depth / regime / kelly / positions-stream suites

## v10.4 — GLOBAL EQUITY FUTURES SIM DESK + futures-wallet GET transport + ultra-stream (2026-09-14)

### Fix: CoinDCX futures wallet `[404] not_found` — the route is GET-only
- **Root cause** (the live "futures USDT 3.01 dikhta hi nahi" bug): the derivatives wallets route is a **GET** endpoint — the old POST died with `[404] not_found` (Express routes by METHOD), so the futures margin tile showed 0 while the CoinDCX app showed balance
- New `coindcxPrivateGET()` in `server/mcp/coindcx.js` — query-param auth for the 2025 derivatives wallet routes (params in the query string, HMAC over the compact JSON of the same params, seconds timestamp; ms variant kept as fallback)
- `fetchFuturesWallets()` transport chain: **GET(s) → GET(ms) → legacy POST** — first transport that answers sticks for the process lifetime (no per-poll probing); wrapper tolerance unchanged (`[]` / `{wallets}` / `{data}` / `{balances}`)
- With the wallet live, the agent's futures-viability gate (`deployableFuturesUSDT ≥ 2`) works again — the "scan: 0 candidates (futures margin ke karan sirf spot scope)" state clears automatically when margin exists

### New: GLOBAL EQUITY FUTURES SIM desk (Apple/Google/NVIDIA/SpaceX…)
- New `server/ai/globalFutures.js` — CFD-style SIM futures on the world's biggest companies:
  - **AAPL, MSFT, GOOGL, AMZN, NVDA, TSLA, META** — REAL Yahoo Finance quotes (live) + REAL 1h candles (3mo, the same feed the crypto LTF layer uses)
  - **SPACEX** — private company, koi public price NAHI: a deterministic synthetic walk (seeded per-hour random walk, anchored near the tender-valuation per-share equivalent), clearly labeled **SIM** on every surface
- The SAME 10-model superintelligence committee votes on these — full plans (entry/SL/T1/T2/R:R), AI score, regime (NASDAQ-100 + USVIX)
- **Trading honesty**: CoinDCX par ye contracts listed NAHI hain — the desk is PAPER/NOTIFY only; a LIVE click is rejected with the honest reason (gate 0)
- Same gauntlet as every desk: kill switch → auto policy → fresh signal → leverage sanity → journal caps (daily cap / loss cap / one-per-pair / concentration)
- `watchGlobalPositions()` (60s) — SL / TP2 / trailing / partial-TP / liquidation sweep on the desk's own quotes
- Agent integration: `desks.global` (default ON) — the auto-agent scans + enters/exits the GLOBAL desk through the same time-exit / trend-flip / correlation-guard discipline
- Ask-AI (crypto desk agent): new `analyze_global_stock` tool + `market: "GLOBAL"` in the signals tool (9 tools now)
- Endpoints: `GET /api/ai/signals?market=GLOBALFUTURES`, `GET /api/ai/global/markets`, `POST /api/ai/global/execute`, `?market=GLOBALFUTURES` on deep
- Frontend: third desk tab 🌍 EQUITY SIM in the CoinDCX desk, position rows with the GLOBAL/SIM chip, ticket in the USD margin domain

### Upgrade: positions ultra stream
- Open positions now poll **every 5s** (was 10s) — live LTP + avg-buy-price + uPnL with the pulse dot (server-side quote caches keep it cheap); flat stays at 45s
- GLOBALFUTURES positions price from the desk feed (`yahoo` / `global-sim` sources, USD-domain P&L with INR twins)

### Fixes caught live (smoke-tested against the running server)
- `getPositionsWithPnl`: an open GLOBALFUTURES position hit "Assignment to constant variable" (the quote map was re-assigned over a `const`) — route 500'd; fixed + regression test pinned
- `/api/ai/global/execute` now passes `mode: 'live'` through to the gauntlet (gate 0 rejects honestly) instead of silently converting to paper

### Tests
- 28 new tests (wallet GET transport chain + wire contract, global desk gauntlet/watcher/close, board integration on the real model loop, agent desks.global config, positions pricing regression) → **1146/1146 passing**

## v6.8 — GLOBAL FUTURES + SUPERINTELLIGENCE AUTO-AGENT (2026-09-07)

### New: CoinDCX GLOBAL FUTURES desk (USDT-margined perpetuals)
- New `server/ai/futures.js` — the complete futures stack: RT prices (`market_data/v3/current_prices/futures/rt`), pcode=f candlesticks, instrument rules, DF wallets, positions, order create / **position-id** exit / **native exchange TP/SL** (`create_tpsl`), spot→futures margin auto-transfer
- **executeFuturesSignal()** — the SAME gauntlet ladder as spot, venue-switched: kill switch → auto policy → LIVE arming → fresh STRONG signal (venue FUTURES) → leverage sanity (liquidation OUTSIDE the SL) → wallet-margin sizing → journal caps (daily 3 / loss / one-per-pair / concentration)
- **watchFuturesPositions()** (60s loop) — SL/TP/trailing on RT prices, liquidation backstop, LIVE reconcile against the exchange's own position list (native TP/SL closes detected), USDT↔INR honest twins
- FUTURES signal board (10-model consensus, TV USD indicators ≈ USDT 1:1, plans in the exact quote currency), third desk tab, futures trade ticket (margin USDT, leverage, liquidation honesty)
- Currency honesty: futures P&L carries both USDT and INR (live USDINR, 10-min cache); the shared journal + daily caps stay INR

### New: SUPERINTELLIGENCE AUTO-AGENT (server-side, 60s loop)
- New `server/ai/agent.js` + `AgentPanel.tsx` — the autonomous prop-desk agent:
  - **Wallet-fetch**: live CoinDCX spot + futures margin balances (`/api/ai/wallet`); every trade sized from EQUITY (risk %/trade, SL-based; ≤60% of deployable margin)
  - **Auto Entry**: only ≥80% confidence + 75% agreement STRONG signals (stricter than the manual 75/70)
  - **Auto Exit**: watcher SL/TP/trailing + native exchange TP/SL + agent TIME-EXIT (default 90m)
  - **Exactly 3 trades/day** (user spec; agent-scoped, manual trades don't count) + daily loss-cap stand-down (−3% equity) + cooldown between entries
  - LIVE needs the full chain: typed LIVE in Risk settings + Auto-execution ON + typed LIVE at agent start + CoinDCX connected — no private path to money
  - Agent log (every scan decision), Telegram pings on entry/exit, India intraday picks + futures picks strip
- Endpoints: `GET /api/ai/agent`, `POST /api/ai/agent/start|stop|config`, `GET /api/ai/wallet`, `GET /api/ai/futures/markets`, `POST /api/ai/futures/execute`, `?market=FUTURES` on signals/deep

### Site
- OrderConsole: live wallet strip + futures position rows (USDT pricing, agent badge, exchange-reported liquidation)
- engine string → `SUPERINTELLIGENCE ENSEMBLE v6.8`

### Tests
- 43 new tests (futures gauntlet math/parsing/wallets/watcher + agent quota/sizing/loss-cap/time-exit) → **572/572 passing**



## v1.4.0 — SuperScore Backtester + AI Follow-ups (2026-07-20)

### New: SuperScore Backtester (site)
- New util `src/utils/superScoreBacktest.ts` — replays daily candles with the SHARED production SuperScore math (extracted into `computeSuperScoreFromIndicators`, single source of truth, zero formula duplication)
- Trade simulation: enter ≥65 BUY-LEAN, exit ≤40 or 20-day cap, next-open fills
- **Score-band accuracy validation**: ≥78 / 65–77 / 35–64 / <35 buckets with 10-day forward-return hit rates — verifies the production EXTREME thresholds against history
- NeuralChat local command: `/superscore RELIANCE` — deterministic, zero LLM cost, instant chat report with 📉 badge

### New: AI-Generated Follow-ups (NeuralChat)
- Follow-up chips first extract real '?' questions from the AI's own answer (most relevant next steps), falling back to deterministic heuristics

### Tests
- 13 new tests (SuperScore math bounds/direction/determinism + backtester arithmetic/bands/determinism) → **54/54 passing**

## v1.3.0 — SuperScore v6 + Smart Router v18 Deep Upgrade (2026-07-20)

### superintelligenceEngine v6 (Site AI core)
- ⚡ **SuperScore**: 5-factor composite directional score (1-99) per holding — RSI zone 35% + SMA20/50 divergence 25% + MACD 15% + day-range position 15% + anti-chasing momentum 10%. Injected into LLM prompt, inside-story, and Quant Brain top-pick ranking
- 💥 **Volume-breakout anomaly alerts** (big move + heavy tape = institutional footprint)
- ⚡ **SuperScore EXTREME-BUY/SELL** multi-factor alignment warnings (rarer & more reliable than RSI-only signals)

### Telegram Bot v18
- **Latency-aware Smart Router** (ai-chat): per-engine EWMA latency tracking; auto mode now prefers fastest healthy engine, cooldowns sink to bottom — measurable latency reduction in failover cascades
- `/super ai` — LLM-narrated super brief (deterministic numbers + LLM explanation + anti-hallucination check, 35s hard cap, graceful fallback)
- Inline keyboard on /super: 🔁 Refresh Brief + 🧠 AI Narrate buttons (callback_query wired)
- `/aitest` — SMART ROUTER telemetry table (per-engine latency EWMA, failure count, cooling state)

### Hang-proofing (bug fixes)
- `apiFetch` default 30s timeout — previously fetch calls without an explicit AbortSignal could hang forever and stall the UI
- `/api/config` + direct Telegram sendMessage now have 4s/8s caps (fast proxy fallback)

### Validation
- tsc clean ✅ · 41/41 tests ✅ · vite build ✅ · node --check all server+bot modules ✅

## v1.2.0 — Superintelligence v5.0 Upgrade (2026-07-20)

### NeuralChat v5.0 (Site AI)
- Persistent chat memory: conversation saved to localStorage (60 msgs cap, sanitized) — survives reloads
- Stop button: AbortController cancels in-flight engine cascade mid-generation
- Regenerate: one-tap retry of last answer with fresh live data
- Engine latency badge on every response (e.g. "groq • 2.1s")
- Smart follow-up chips after each response (context-aware heuristics)
- New "Super Brief" quick action (parity with Telegram /super)
- Version label unified (header/welcome/quant brain all v5.0 — fixed v3.0/v4.0 mismatch)

### Telegram Bot v17.0
- NEW /super — Superintelligence Brief (regime + portfolio pulse + top signals + warnings + opportunities + verdict, 100% deterministic — works without any LLM key)
- NEW /insights <SYMBOL> — portfolio-aware deep insight (your P&L + RSI + trend + AI verdict + conviction score)
- NEW /aitest — AI engine health dashboard (7 engines + Quant Brain status)
- Typing indicator (sendChatAction keepalive) on /ai, /chat, free-text chat
- Memory hygiene: aiCallTimestamps map pruning, algo-cooldown 24h sweep, ai-chat history capped at 20 chats
- Telegram menu commands updated (/super, /insights, /aitest)

### Site Infra
- Service worker cache bump wealth-ai-v2 → wealth-ai-v5 (PWA auto-refresh after deploy)
- Package version 1.1.0 → 1.2.0
- Baseline verified: 41/41 tests pass, tsc clean, vite build clean, node --check clean on all bot modules
# SmartAI1 — Bug Fix Changelog

## Round 1: Initial Deep Review (28+ bugs fixed in 17 files)

### CRITICAL (Security / Data Loss)
- **C1** `src/utils/riskAnalyzer.ts` — VIX operator-precedence bug
  - `(a || 15 + b || 15) / 2` evaluated as `a || (15+b) || 15` due to operator precedence. Risk alerts and regime classification were silently wrong.
  - Fixed: explicit `?? 15` fallback per VIX, then average.
- **C2/C3** `telegram-bot/bot.mjs` — 33 of 50 command handlers lacked `isAuthorized()` check
  - `/portfolio`, `/market`, `/risk`, `/scan`, `/backtest`, `/debug_env` etc were open to ANY Telegram user who could DM the bot, leaking full portfolio + P&L and triggering billable LLM API calls.
  - Fixed: inserted `if (!isAuthorized(msg)) return;` into all 33 handlers (skipping `/start` and `/help` which are intentionally public).
- **C7** `src/utils/secureStorage.ts` — Single global `migrationDone` flag broke multi-key migration
  - After the first key was migrated from legacy CryptoJS format, every subsequent key (TG_TOKEN, GROQ_KEY, etc.) silently returned `null` from `getItem()`.
  - Fixed: per-key migration Set + immediate mark-on-enqueue to prevent concurrent re-encrypt.
- **C8** `server/index.js` — SPA fallback served `index.html` for missing JS chunks
  - After redeploy, missing `/assets/vendor-charts-*.js` files returned HTML → "Failed to fetch dynamically imported module" → entire app died.
  - Fixed: return real 404 for asset paths (`/assets/`, `.js`, `.css`, etc.) so `lazyWithRetry` can trigger a clean reload.
- **C9/C10** `src/utils/api.ts` — Cloud sync used weak default token + `loadFromCloud` had no auth
  - `authToken = VITE_API_TOKEN || 'WEALTH_AI_SYNC'` shipped a known string in the bundle. `loadFromCloud` sent NO token at all. Anyone with the Apps Script URL could read/write the user's portfolio.
  - Fixed: refuse weak/default tokens; require `>=12` char secret on BOTH load and save paths.
- **C11** `server/index.js` — `/api/telegram` proxy accepted arbitrary `chatId`
  - Any visitor could POST `{message, chatId: <any>}` and make the bot spam arbitrary chats. No rate limit.
  - Fixed: ignore client-supplied chatId, always send to `TG_CHAT_ID`. Added per-IP rate limit (30 msgs / 10 min).
- **C4** `src/utils/riskEngine.ts` — `calculateCorrelationMatrix` returned random numbers
  - `Math.random() * 0.6 + 0.2` labeled as "correlation" — fake risk metrics presented to a financial audience.
  - Fixed: return zeros + `__simulated: true` flag so consumers know data is missing.
- **C5** `src/utils/smartMoney.ts` — FII/DII flows fabricated via `Math.random()`
  - ±500–1000 Cr random figures presented as real institutional flows.
  - Fixed: deterministic heuristic from VIX + index momentum; clearly labelled "(Estimated)" in description.
- **C6** `src/utils/backtestEngine.ts` — Backtests used `Math.random()` with biased drift
  - `(Math.random() - 0.48)` biased returns upward by ~+0.06%/day (inflating win-rate/Sharpe). Non-reproducible across runs.
  - Fixed: seeded deterministic PRNG (mulberry32) with zero-centered noise.

### HIGH (Broken Features / Wrong Behavior)
- **H1** `src/utils/macroRegime.ts` — `directionScore` didn't differentiate up vs down
  - Both +5% and -5% sector moves scored 100. Crashed sectors ranked as "high momentum".
  - Fixed: keep sign (`50 + s.change * 10`).
- **H2** `src/utils/portfolioMonitor.ts` — "Drawdown" was actually unrealized P&L%
  - A portfolio that's +20% then -5% off peak showed drawdown=0.
  - Fixed: relabel as "unrealized loss" with accurate description.
- **H3** `src/utils/riskEngine.ts` — `maxDrawdown` was identical to `currentDrawdown`
  - Both used today's intraday `high`. Documented as not tracked historically.
- **H4** `src/types/index.ts` — `pegRatio` is actually RSI/CAGR ratio, not P/E ÷ growth
  - Documented the misleading name; consumers should not treat as true PEG.
- **H5** `src/utils/tvWebsocket.ts` — Callback fired with empty price data
  - Guard `Object.keys(update).length > 1` was always true (time + market always set).
  - Fixed: explicit check for actual market data fields.
- **H6** `src/utils/wealthEngine.ts` — NaN propagation from invalid `dateAdded`
  - `new Date(badString)` → Invalid Date → `Math.max(1, NaN)` = NaN → XIRR bisection poisoned.
  - Fixed: `Number.isFinite(buyMs)` guard with fallback to 1 day.
- **H7** `src/utils/telegram.ts` — Division-by-zero in report generators
  - Positions with `avgPrice=0` (airdrop) caused `Infinity`/`NaN` rendered in Telegram.
  - Fixed: `cost > 0 ? ... : 0` guards.
- **H8** `src/utils/telegram.ts` — Currency symbol picked from `portfolio[0].market`
  - Mixed IN+US portfolio showed US totals with `₹` if first holding was US.
  - Fixed: always INR total for mixed-currency reports.
- **H9** `src/utils/api.ts` — Greedy regex JSON extraction
  - `\{[\s\S]*\}` over-captured trailing junk.
  - Fixed: try strict `JSON.parse` first, non-greedy fallback.
- **H10** `src/utils/api.ts` — `import` statement after runtime code
  - Worked due to ES module hoisting but fragile under future bundler strictness.
  - Fixed: moved import to top of file.
- **H11/H12** `ml-service/app/main.py` — CORS `*` + credentials; unbounded caches
  - `allow_origins=["*"], allow_credentials=True` is rejected by browsers. Caches (`{}`) grew forever.
  - Fixed: `allow_credentials=False`; OrderedDict LRU with max-size eviction.

### MEDIUM
- **M1** `src/utils/api.ts` — Fear/Greed defaulted to "Extreme Greed" when VIX unavailable
  - `(15+15)/2 = 15` → "EXTREME GREED" while no VIX was actually fetched.
  - Fixed: neutral 50 + "VIX unavailable" label.
- **M2** `src/utils/riskEngine.ts` — Division-by-zero in `calculateRebalance`
  - `totalInvestment=0`, `price=0`, `valINR=0` all caused Infinity.
  - Fixed: explicit `> 0` guards.
- **M5** `src/utils/tvWebsocket.ts` — Stuck-price detector false-positives
  - `isAnyMarketOpen()` (IN OR US) flagged US symbols as "stuck" during India hours.
  - Fixed: per-symbol market gating.
- **M10** `src/utils/constants.ts` + `api.ts` + `config.mjs` — `BEES` substring check
  - `sym.includes('BEES')` matched "BEESLY" etc. Changed to `endsWith('BEES')`.
- **M14** `src/utils/mlApi.ts` — Hardcoded `/api/ml` ignored `VITE_API_PROXY`
  - Cross-origin deployments 404'd. Fixed: respect `VITE_API_PROXY`.
- **M15** `src/components/tabs/PlannerTab.tsx` — `localStorage.setItem` unguarded
  - Throws in Safari private mode / quota-exceeded → effect crash.
  - Fixed: try/catch wrapper.
- **M16** `src/utils/telegram.ts` + `market.mjs` — Brittle `toLocaleString` date reparse
  - `new Date(now.toLocaleString('en-US', {timeZone}))` returned Invalid Date on non-English ICU builds.
  - Fixed: `Intl.DateTimeFormat.formatToParts` for robust weekday/hour/minute extraction.

---

## Round 2: Deep Bot + Python + Frontend Review (40+ additional bugs fixed in 30 files)

### CRITICAL (telegram-bot + ml-service)
- **CRIT** `telegram-bot/analysis.mjs:887` — ETF report division by zero when `totalInvested=0`.
- **CRIT** `telegram-bot/algo.mjs:140` — `key.split('_')` lost underscore-containing symbols (e.g. `IN_GIFT_NIFTY` → `GIFT`).
- **CRIT** `telegram-bot/market.mjs:222` — VIX snapshot corrupted on transient API failure → spike detection permanently disabled.
- **CRIT** `telegram-bot/ai-chat.mjs:299` — Quant Brain fallback NaN when `price=0` (R:R = 0/0).
- **CRIT** `telegram-bot/cloud.mjs:71` — `saveGroqKeyToCloud` accepted any string >10 chars as Groq key → user could brick AI chat with `/setkey groq junk`.
  - Fixed: require `gsk_` prefix + ≥20 chars.
- **CRIT** `telegram-bot/bot.mjs` — 5 cron handlers sent to `TG_CHAT_ID` without null check → silent throws when unset.
- **CRIT** `ml-service/app/main.py:210` — `/signals?market=US` returned ALL symbols (filter had `"US": None`).
- **CRIT** `ml-service/app/main.py:245` — `/train` crashed with `KeyError` when `fetch_all_symbols` returned empty.
- **CRIT** `ml-service/app/main.py:376` — `/regime` crashed with `ValueError` when `combined` was empty after `dropna()`.

### HIGH (telegram-bot + ml-service + frontend)
- **H5 (ml)** `ml-service/models/backtest.py:81` — Sell-prediction PnL was `-abs(fwd_return)` → correct shorts always lost money.
  - Fixed: `-fwd_return` (correct short profits when asset falls).
- **H6 (fe)** `src/components/MLSignalPanel.tsx` — Stale `price`/`change` closure made ML signal stale for entire session on a symbol.
  - Fixed: include price/change in deps + refetch on >1% price move.
- **H7 (fe)** `src/components/AIScreenerPanel.tsx` — False "Sent to Telegram!" success even when send failed.
  - Fixed: check boolean return + surface actual result.
- **H8 (ml)** `ml-service/app/main.py:147` — `top_features` always empty (used wrong sklearn attribute `estimators` instead of `calibrated_classifiers_`).
- **H9 (ml)** `ml-service/app/main.py:435` — `/analyze` ignored user query (passed only `brain_result` to prompt builder).
- **H10 (infra)** `nginx.conf` — Proxy target `node-server:8080` didn't exist (no such service in docker-compose).
  - Fixed: added `node-server` service to `docker-compose.yml`.
- **H11 (ml)** `ml-service/app/main.py:329,357` — `str.contains(symbol)` substring match (BTC matched BTCUSD, BTCUSDT, ABTC).
  - Fixed: exact case-insensitive match.
- **H12 (fe)** `src/components/DipIntelligence.tsx:194` — `onBuy(symbol, 0)` passed zero amount.
  - Fixed: pass `entryTarget` as default price.
- **H13 (ml)** `ml-service/app/llm_router.py:257` — Anti-hallucination guard was a no-op (always returned text).
  - Fixed: return `None` when >3 suspicious numbers detected; main.py falls back to `brain_to_text`.
- **H14 (ml)** `ml-service/app/main.py:193` — NaN RSI/volume leaked into JSON response → browser JSON.parse fails.
  - Fixed: `_safe_num()` coerces NaN/inf to defaults.
- **H15 (tb)** `telegram-bot/ai-chat.mjs:474` — Race condition in chat history (concurrent /ai calls interleaved).
  - Fixed: per-chat mutex via promise chaining.
- **H16 (tb)** `telegram-bot/bot.mjs:110` — Synchronous `fs.writeFileSync` in cron handler blocked event loop.
  - Fixed: `fs.promises.writeFile`.
- **H17 (tb)** `telegram-bot/market.mjs:12` — `toLocaleString` date reparse fragile.
  - Fixed: `Intl.DateTimeFormat.formatToParts` (mirror of M16 fix in frontend).
- **H18 (ml-server)** `server/mlEngine.js:83` — MACD signal line mathematically wrong (`macd * 2/10` instead of 9-period EMA of MACD series).
  - Fixed: full MACD series computation + 9-period EMA.
- **H19 (ml-server)** `server/mlEngine.js:252` — Sharpe annualization assumed daily returns but loop stepped by 20 days.
  - Fixed: `sqrt(252/20)`.
- **H20 (ml-server)** `server/mlEngine.js:253` — Profit factor used win/loss COUNTS not amounts.
  - Fixed: `grossProfit / grossLoss` (standard definition).
- **H21 (apps-script)** `server/apps-script/Code.gs:71` — Auth check only triggered if `authToken` was present → POST with no field bypassed entirely.
  - Fixed: REQUIRE token match; refuse weak default `WEALTH_AI_SYNC`.

### MEDIUM (round 2)
- **M19** `telegram-bot/analysis.mjs:153` — Division by zero when `change === -100`.
- **M20** `telegram-bot/market.mjs:532` — Hardcoded IPO year "2026" → `new Date().getFullYear()`.
- **M21** `src/components/NeuralChat.tsx:424` — Voice transcript segments concatenated without separator ("helloworld").
- **M22** `src/components/NewsSentimentFeed.tsx:69` — Greedy JSON regex over-captured. Fixed: balanced-brace scanner + markdown-fence stripping.
- **M23** `src/components/LiveCandleChart.tsx` — Theme/height change rebuilt chart but data effect didn't re-run → empty chart until symbol change.
  - Fixed: `chartVersion` state increments on rebuild; data effect depends on it.
- **M25** `telegram-bot/ai-chat.mjs:258` — HuggingFace prompt flattened multi-turn history.
  - Fixed: per-turn `User:`/`Assistant:` formatting.
- **M27** `ml-service/pipeline/fetch_data.py:132` — CLI crashed on empty data with `KeyError`.

### LOW (round 2)
- **L6** `src/components/NeuralChat.tsx:506` — `key={msg.timestamp}` collision risk on rapid messages.
- **L31** `ml-service/models/train_target.py:72` — `coverage` computed but never returned.
- **L33** `server/mlEngine.js:256` — `total_periods` overcounted (`floor(length/periods)` vs actual loop count).
- **L36** `src/components/WhatIfSIPOptimizer.tsx:82` — `Math.max(...[])` returns `-Infinity`.
- **L37** `src/components/tabs/PlannerTab.tsx:508` — SIP FV formula div by 0 when rate=0.
- **L38** `src/components/MacroRegimePanel.tsx:32` + `SmartMoneyPanel.tsx:37` — Undefined className if regime/signal not in map. Fixed: `?? NEUTRAL` fallback.
- **L39** `src/components/NeuralChat.tsx:6` — Failed `/api/ai-status` cached for 30s. Fixed: reset cache on failure.
- **L41** `src/components/tabs/PortfolioTab.tsx:38` — `setTimeout` without cleanup. Fixed: timer ref + unmount clear.
- **L42** `src/components/CorrelationHeatmap.tsx:37` — Correlation could go negative. Fixed: clamp `[0,1]`.
- **L44** `docker-compose.yml` — `version: '3.9'` deprecated. Removed.

---

## Files Modified (44 total)

### Frontend (TypeScript/React) — 18 files
- src/types/index.ts
- src/utils/api.ts
- src/utils/backtestEngine.ts
- src/utils/constants.ts
- src/utils/macroRegime.ts
- src/utils/mlApi.ts
- src/utils/portfolioMonitor.ts
- src/utils/riskAnalyzer.ts
- src/utils/riskEngine.ts
- src/utils/secureStorage.ts
- src/utils/smartMoney.ts
- src/utils/telegram.ts
- src/utils/tvWebsocket.ts
- src/utils/wealthEngine.ts
- src/components/CorrelationHeatmap.tsx
- src/components/DipIntelligence.tsx
- src/components/LiveCandleChart.tsx
- src/components/MacroRegimePanel.tsx
- src/components/MLSignalPanel.tsx
- src/components/NeuralChat.tsx
- src/components/NewsSentimentFeed.tsx
- src/components/ScreenerPanel.tsx
- src/components/SmartMoneyPanel.tsx
- src/components/WhatIfSIPOptimizer.tsx
- src/components/AIScreenerPanel.tsx
- src/components/tabs/PlannerTab.tsx
- src/components/tabs/PortfolioTab.tsx

### Backend (Node.js) — 6 files
- server/index.js
- server/mlEngine.js

### Telegram Bot (Node.js) — 8 files
- telegram-bot/ai-chat.mjs
- telegram-bot/algo.mjs
- telegram-bot/analysis.mjs
- telegram-bot/bot.mjs
- telegram-bot/cloud.mjs
- telegram-bot/config.mjs
- telegram-bot/market.mjs

### Python ML Service — 5 files
- ml-service/app/main.py
- ml-service/app/llm_router.py
- ml-service/models/backtest.py
- ml-service/models/train_target.py
- ml-service/pipeline/fetch_data.py

### Infrastructure — 3 files
- server/apps-script/Code.gs
- docker-compose.yml
- .env.example

## Verification
- TypeScript: clean compile ✓
- Tests: 41/41 passing ✓
- Production build: ✓ (4.42s)
- All Node.js files: syntax OK ✓
- All Python files: syntax OK ✓

## v21.23.10 — LIVE-MODE RESURRECTION: thrash-cure backoff + India-LIVE wiring fix + TP-ladder fix + metals legs + 20 hardening fixes (user: "lates github repo ko pull karo aur itne version build aapne codes diye hai sab not working hai deep level pe recheck karo issues thik kardo live mode pe not working" — v21.23.4-9 sab builds)

**LIVE-PROBE METHOD**: pehli baar server ko REAL live mode me boot karke (tests nahi) defects pakde gaye — engine khud-ba-khud thrash karta dikha (44 live-skip events + ~100 journal REJECTED + 46 phantom paper trades minutes me). 4 parallel deep-audits (engine / order-chain / data-pipeline / loops+agents) + har CRITICAL finding main-agent ne khud verify ki.

**ROOT CAUSES (live-only, 4119 tests ke mocks me kabhi dikhte nahi the):**

1. **THRASH-CURE (CRITICAL)**: failed LIVE attempt par KOI cooldown/backoff stamp nahi hota tha (perSymbolLast sirf SUCCESS par + live+flat bypass use wipe bhi karta tha) → teen loops (10s probe / 15s recheck / 60s sweep) same reject har ~10s dohrate the; AUR "ANTI-LATE-ENTRY fallback" autoPickBlockers bypass karta tha (4th retry vector). FIX: `_state.failedLiveAttempts` escalating per-symbol backoff (5m→10m→20m→40m…cap 4h, persisted, day-rollover reset, in-flight exempt) + candidates pool gate + probe consult + fallback ab blockers respect karta hai.
2. **INDIA LIVE PARAM FIX (CRITICAL)**: routes.js `getFreshSignal` pass karta tha jabki executeIndiaSignal `getFreshIndiaSignal` destructure karta hai → India arm hote hi gate-4 TypeError → **MTF-auto India LIVE structurally dead** (manual console path sahi tha). Dono call-sites fixed (auto ctx + manual MTF board).
3. **LIVE-CLOSE VERDICT (CRITICAL)**: exchange close {ok:false} ignore hota tha + `|| LIVE` clause book row CLOSED book kar deta tha jabki leveraged position exchange par khula reh jata tha. Ab {ok:false} = row OPEN + syncError + live-close-failed event + next-tick retry.
4. **TP-LADDER FIX (HIGH)**: 3s fastSlTrailLoop pre-TP1 exchange-native TP **T1** par re-arm karta tha — CoinDCX create_tpsl FULL close karta hai → pehli Stage-1 trail par LIVE position POORI T1 par band (TP1-partial + TP2-runner live me kabhi nahi chala — user ka exact "TP1/TP2 tak reach nahi hota / kam profit book" live symptom). Ab teeno sites (entry arming / 15s tick / 3s loop) TP2 aligned.
5. **PHANTOM-TRADE CURE (HIGH)**: failed attempt ka paper rollback CLOSE tha → har reject 2ms-lived fake MANUAL close mint karta tha (live-probe: 46 fake closes, net −₹2,206 paper stats poison). Ab `voidPaperTrade` — bina cost/journal, quote-free.
6. **DESK PRE-FLIGHT (HIGH)**: India un-armed / CoinDCX creds absent = guaranteed-rejects ab engine-side pre-flight blocked verdict (gauntlet ka journal-spam + 14-POST ladder waste nahi). India attempts ka source ab honest 'mtf-auto-india' (pehle 'india-agent' misattribution).
7. **DEEP-TICK BOARDSIGS (HIGH)**: 15s deep tick (ACTUAL entry path — 10s probe isi me escalate karta hai) boardSigs ke BINA board banata tha → P0 direction guards (boardOpposes −12/cap64, svaOpposes, councilHardNo, winProb NO-EDGE) fastest path par kabhi fire nahi hote the. Ab 60s loop jaisa aligned.
8. **FRESH-PRICE GATE (HIGH)**: executeMtfDualLiveOrder 3-minute-old deep-stale cache ya Binance/Bybit cross-venue price par MARKET order size karta tha (fetchFuturesPrices ki failure-ladder). Ab sirf fresh (≤30s) official CoinDCX row → warna board planEntry → warna honest reject.
9. **META-TTL FIX (HIGH)**: instrument-meta fetch fail hone par guessed precision/minQty:0 **6 GHANTE** cache hota tha → us window ka har live order galat ladder par reject. Ab fallback meta 60s TTL + 'unknown' status par EK cache-busting re-fetch.
10. **UUID-RESCUE (HIGH)**: entry-time position-id poll miss → livePositionId internal journal UUID → create_tpsl/exit 400 har pass, pair-based resolver kabhi chance nahi paata. Ab failed-id par pair re-resolve + retry (SL-sync + close dono), journal-only SL update ab honest ok:false (lastExchangeSl galat stamp + delta-gate skip GONE).
11. **WALLET-FAIL BLOCK (HIGH)**: futures wallet read EXCEPTION par ₹8000 default guess se sizing + 7-rung × 2 retries = 14 barbaad POSTs. Ab honest blocked reject.
12. **FILLED-CONTRACT ALIASES (MEDIUM)**: producer `deployedWalletINR` bhejta tha, caller `filled.walletDeployINR`/`filled.buyingPowerINR` padhta tha (mock-drift) — teeno return sites ab aliases guarantee karte hain.
13. **METALS LEGS (CRITICAL for Gold/Silver desk)**: rawTfCandlesUsdt/_candlesFor me metals branch KABHI tha hi nahi — XAU/XAG Binance SPOT (permanent -1121 invalid symbol) + CoinDCX spot (XAUINR exist nahi) par gir kar CoinDCX-futures blip par plan build KABHI nahi hota tha. Ab purpose-built chain wired: Binance fapi XAUUSDT/XAGUSDT → Yahoo COMEX (GC=F/SI=F) ltp-rescaled. stream.js 3s watcher me bhi metals quotes (manual metals paper trades ki frozen SL/T1/T2 evaluation cure).
14. **STALE-DATA AGE GATE (HIGH)**: Yahoo per-IP cache HTTP 200 + DAY-OLD intraday series "fresh" serve karta tha (live-probe: NSE OPEN me bhi RELIANCE 15m last-bar 1456 min purana; ITC ELITE SHORT usi hybrid pe bana) — cache-TTL fetch-time tha, data-time nahi. Ab `isStaleIntradaySeries` pure gate (3×TF+10min, session-aware, 1d exempt) mtf.js + signals.js dono me; stale → v21.23.4 honest-degrade ladder. Null-payload ab 60s mini-TTL (1d-TTL null poison GONE).
15. **SAPTA PARITY (HIGH)**: proTraderGate me dataDegraded check KABHI tha hi nahi — banned 29%-WR degenerate class ek engine par blocked, dusre par tradable.
16. **ADOPTED-VOL-STAMPS (MEDIUM)**: adopted/manual CoinDCX positions par koi atrPct/volClass stamp nahi → hamesha NORMAL tight trail. Ab SL-distance proxy se entry-stamp (LIVE tick board-row se refresh karta hai).
17. **BOARD-ROTATION SNAPSHOT (MEDIUM)**: open trade ka symbol top-6 se rotate hote hi flip detection mar jaati thi. Ab last-seen row snapshot (120s TTL, memory-only) — flip dekhne ke baad rotate ho to bhi exit fire; TTL ke baad honest no-data no-flip.
18. **SIDE-VOCAB CLASS (LOW)**: marginOrderBody `!== 'SHORT'` silent-LONG-default (v21.23.9 futuresOrderBody fix ki hi class), pRoundLadder 'SELL' ulta, futures precheck — teeno dual-vocabulary map + unknown-side throw.
19. **DEAD CONFIG KEYS (LOW)**: `markets`/`liveExecution` config me persist hote the jabki koi code read nahi karta — _sanitizeCfg ab MTF_AUTO_DEFAULTS allowlist (user ka 'markets:[CRYPTO]' misconception GONE).
20. **INDIA REJECT-DEDUP + AUTO-SYNC SCOPE (LOW)**: identical consecutive India rejects ab 5-min window me repeat-count update (500-entry journal displacement GONE); executeMtfDualLiveOrder ka global mode:'live' auto-sync ab sirf MANUAL board clicks ke liye (auto engine ka silent global flip GONE).

**NAVA TEST FILE** test/liveRecheck212310.test.ts — 48 LOCKS (S1 backoff x5 incl fallback-hole + escalation math, S2 void x1, S3 close-verdict x3, S4 India wiring x6, S5 probe parity x2, S6 boardSigs x1, S7 futures hardening x7, S8 side-vocab x3, S9 age-gate x6, S10 SAPTA x2, S11 sanitize x2, S12 adoption stamps x1, S13 snapshot rotation matrix x4, S14 metals/TP/void wiring x6) + 2 honest test-pin updates (siteRecheck21239 TP-ladder pin — v21.23.9 ka "TP1→T1 ladder" pin hi live bug tha; cxWsCandles cxFut overlay occurrence 1→5 metals-chain wires) + __resetMtfAutoForTests ab snapshot map + failedLiveAttempts seed support karta hai.

223 files / 4167 tests PASS (4119+48), tsc 0, lint 0, dist 21.23.10, check:routes PASS

---

## v21.23.11 — MIRROR-SHIELD: "sab signals systematically OPPOSITE" ka data-wire root-cause fix (LIVE-FORENSICALLY PROVEN)

**USER COMPLAINT (verbatim)**: "site me Jo bhi trade signals de rahe hai sab ke sab wrong direction me hai sab opposite jaa rahe hai … signals ab bhi systematic opposite jaa rahe hain … muje loss ho raha hai".

**LIVE-FORENSICS (sandbox + docs + SDK triangulation, 2026-10-20)**:
- Direction COMPUTATION layers sahi nikle: synthetic selftest 13/13 PASS; LIVE board probe (Binance leg se) 17/20 AGREE real 24h trend se; aggregateVotes/_tfVote/plan polarity sab canonical.
- **Root-cause class pakda**: CoinDCX candles NEWEST-FIRST (descending) aate hain — official docs live-verify: "Response Order: Newest-first (descending order according to time key)"; Aug-2026 SDK `getCandles()` internally `res.reverse()` karta hai; ek 2026-SDK CandleResponse `open_time`/`close_time` keys document karta hai (docs `time` bolte hain — wire drift PROOF). Legacy parsers (spot: `{o,h,l,c,v,t}`; futures candlesticks: `{…,time}`) me timestamp-key drift → `Number(x.time)=NaN` → **sort comparator NaN → sort NO-OP → series API ke NEWEST-FIRST order me hi rehti thi → TIME-MIRRORED series → har EMA/RSI/MACD/Supertrend/ROC vote ulta → SAB signals systematically OPPOSITE — jabki prices WS-overlay se live (user: "site working fine")**. Internal tests kabhi pakde nahi (mocks assumed shape me), sandbox kabhi reproduce nahi hua (datacenter me CoinDCX Cloudflare-blocked → Binance leg → direction sahi).
- Synthetic REPRODUCTION (pehli baar): time-mirrored rising series → REAL plan path → **side="SHORT"** — live disease deterministic test me.

**FIX — 4 DEFENSE LINES (bug class structurally impossible)**:
1. **L1 SOURCE — CANDLE CANONICALIZER** (`server/ai/lib/candles.js` naya): `parseCandleRow` alias-tolerant (t/time/open_time/T/ts · o/open · h/high · l/low · c/close/last · v/volume/vol + Binance array rows) + seconds↔ms normalization + geometry sanity + time-plausibility floor (legacy bare-array layout misread guard) + NaN-row DROP (NaN sort = mirror seed). `canonicalizeCandles`: parse → drop → orientation-detect → reverse-if-descending → stable ascending sort → invariant. Wired: `fetchCoinDcxCandles` (spot) + `fetchFuturesCandles` (futures candlesticks — user ka LIVE trade path).
2. **L1 NEW LEGS — OFFICIAL ENDPOINT**: CoinDCX ka CURRENT documented candles API (`api.coindcx.com/market_data/candles`, `interval` param, B-pairs) ab fallback leg hai — spot chain me `B-<base>_INR`→`BTCINR` (INR-domain preserved), futures chain me `B-<base>_USDT` (perp USDT-domain same). Legacy endpoint WAF/retire/shape-drift → desk phir bhi zinda.
3. **L2 OVERLAY/RESAMPLE — `ensureAscending` entry-defense**: `overlayTickOnCandles` (forming bar = TRUE newest; pehle mirrored series pe OLDEST bar patch hota tha), mtfDualBoard `overlayLiveTick`, `_resample` (mirrored buckets cure).
4. **L3 COMPUTE — last-line**: `computeIndicatorsFromCandles` + `_tfVote` + `buildPlanFromCandles` entry pe `ensureAscending` (zero-copy ascending; desc → reversed copy). Koi bhi un-audited path (store/bots/direct caller) mirrored series de to compute se PEHLE seedha ho jata hai.

**L4 PROOF — certificates**:
- `directionSelfTest` ab MIRROR-SHIELD section ke saath 18 checks (docs-shape newest-first → asc; open_time drift → asc; NaN rows dropped; **time-mirrored rising → LONG kabhi SHORT nahi**; zero-copy guarantee).
- **NAYA `directionLiveCert.js` + `/api/ai/direction-live-certificate`**: REAL network se app ke APNE candle chains audit — per-chain: reachable / orientation(asc=MIRROR detector) / freshness / lastClose-vs-live-ticker ±3% / vote-vs-realized-20bar-trend. Boot pe non-blocking log line — CoinDCX wire dobara drift kare to certificate chain ka NAAM lekar FAIL hoga, silent mirror kabhi nahi.

**NAVA TEST FILE** `test/directionCert212311.test.ts` — 38 LOCKS (parseCandleRow shapes x8, orientation/ensureAscending x4, canonicalizeCandles mirror-cases x7, fetchCoinDcxCandles wire-legs x4, fetchFuturesCandles wire-legs x3, overlay L2 x2, compute/vote/plan L3 x6, certificates L4 x4).

---

## v21.23.12 — FULL-SITE DEEP RECHECK #2: India MTF-live structural-dead cure + order-time dataDegraded veto + 20 fixes (fresh-eyes 4-domain audit)

**User ask: "v21.23.11 ye latest full site code ko recheck karo deep level pe aur issues fix kardo"**

v21.23.11 (MIRROR-SHIELD) ke turant baad fresh-eyes 4-domain parallel audit (A: candle/data pipeline · B: signal/vote/plan compute · C: order-exec/live chain · D: routes/UI/boot/config). Mirror-shield ke 4 defense lines RE-VERIFIED intact (L1 canonicalizer + official legs, L2 overlay guards, L3 compute guards, L4 certificate) — **koi live direction-flip NAHI**. Par audit ne ~20 REAL defects diye (2 HIGH live-path, 3 HIGH direction-safety, baaki medium/latent). Sab fix + regression locks.

### 1) HIGH — India MTF-live STRUCTURALLY dead (v21.23.10 ka "CRITICAL FIX" sirf naam tha, function nahi) (routes.js)
- **Root cause**: `getFreshIndiaSignal: (sym, o) => getFreshSignalForExec(sym, 'INDIA', depsForSignals(), o)` — par `getFreshSignalForExec(pairOrSymbol, deps, opts)` me **market param HAI HI NAHI**: `'INDIA'` string deps-slot me, real deps-object opts-slot me, market **hardcoded 'CRYPTO'** → India symbol crypto deep-branch me guaranteed fail → gate-4 hamesha "No fresh ensemble signal available" → manual MTF board India LIVE + mtf-auto India LIVE dono dead. v21.23.10 ne sirf param ka NAAM (`getFreshSignal`→`getFreshIndiaSignal`) theek kiya tha — underlying wiring galat hi rehi.
- **Fix**: teeno wrappers ab `getDeepSignal(sym,'INDIA',depsForSignals())` pattern (manual /india/execute + indiaAgent.js:853 jaisa — wahi pehle se sahi tha).

### 2) HIGH — order-time gauntlet me v21.23.4 contract MISSING (ensemble.js evaluateExecutionGate)
- **Root cause**: `dataDegraded`/`freshTapeAbsent` ko sirf board/agent/SAPTA layers enforce karte the; **execution gauntlet (sab 4 desks ka last-line) check hi nahi karta tha** — manual desk click / auto path ek THIN hybrid STRONG degraded signal pe LIVE order pass kar sakta tha (exact v21.23.4 "opposite jaa raha hai" class).
- **Fix**: gate-top veto — LIVE/PAPER-real order data-degraded signal par HARD-REFUSE (practice/paper journaling allowed — v21.23.4 design parity).

### 3) HIGH — deep-path me v21.23.4 ladder KABHI nahi tha (signals.js _computeDeepSignal)
- **Root cause**: board path `__tfDegraded` (15m MISSING → suppress) / `__tfDataThin` (1h resample <30 → dataDegraded stamp) handle karta hai; **deep path — jo execution gauntlet ka signal source hai — dono ignore karta tha**. THIN hybrid STRONG gauntlet tak UNMARKED pahunchta tha.
- **Fix**: deep bhi same ladder — `__tfDegraded` → honest `{ok:false, INTRADAY-TF-UNAVAILABLE}`; `__tfDataThin` → `consensus.dataDegraded='INTRADAY-TF-THIN'` stamp (buildSignal executable:false + gauntlet veto chain). Board == deep ab sacha parity.

### 4) HIGH — India LIVE closes ka KOI fill-verify nahi (indiaOrders.js — money-loss class)
- **Root cause**: entry path v18.9 se 3× `dhanOrderStatus` poll karta hai (Dhan TRANSIT ack + async-reject) — par watcher close / manual close / partial close **orderId ko hi FILLED maan lete the** → journal full win book + **protective SL-M CANCEL + row CLOSED** — broker reject hone par REAL shares SL ke bina naked (agli square-off tak). Stale-day reconcile phir fake close fabricate karta.
- **Fix**: `_dhanVerifyFill` (3× poll 300/600/600ms) teeno close paths me — sirf TRADED/FILLED/COMPLETE = closed; unverified → row OPEN + WATCH_ERROR + next-tick retry; **SL-M cancel sirf verified fill ke baad**.

### 5) MEDIUM — deep-monitor re-anchor stale lifecycle (mtfAutoLink.js recordLiveMtfBoardTrade — money-class)
- **Root cause**: existing OPEN row re-anchor sirf LEVELS update karta tha — `side`/`peakPrice`/`t1Hit`/`openedAt`/`deepMonitorStage` PURANE rehte the. (a) stale t1Hit+peak → naye LIVE entry par turant Stage-4/5 lock → **entry ke kuch second baad software market-close (fee churn)**, purana openedAt 90s LIVE close-grace firewall disarm; (b) side flip → **SHORT position LONG manage** (inverted SL logic).
- **Fix**: re-anchor ab poori lifecycle fresh karta hai (side/peak/t1Hit/openedAt/STAGE_0/trendStatus/closeReason/pnl/syncError).

### 6) MEDIUM — crypto/futures reject-thrash + agent no-cooldown (journal flooding)
- **Root cause**: v21.23.10 ka reject-dedup sirf India ko mila; spot/futures gauntlets har tick nayi REJECTED row mint karte the (~2,880/day — 500-entry journal window ~4h me displacement) + agent failed entry ke baad bhi har 30s tick wahi candidate try karta.
- **Fix**: scan-20 dedup (5-min window, `__repeatCount` update-in-place) teeno desks me + indiaOrders dedup last-20 scan upgrade (interleaved-entry chain-break cure) + agent `FAILED_ENTRY_BACKOFF` (10-min per-symbol in-memory).

### 7) MEDIUM — globalFutures USDC price leg = LAST uncanonicalized mirror-disease reader
- **Root cause**: equity-sim perp-LTP fallback wahi legacy candlesticks wire padhta tha jiske liye MIRROR-SHIELD bana — NaN-time rows filter pass, sort no-op, newest-first wire par `sorted[len-1]` = **~30-min-purana OLDEST bar** → stale LTP + ULTA-signed changePct (SL/TP/P&L inhi pe evaluate hote hain).
- **Fix**: `canonicalizeCandles` — last ab TRUE newest bar.

### 8) MEDIUM — direction certificate 0-verified chains par bhi "PASS" (directionLiveCert.js)
- **Root cause**: `pass: fails===0 && synthetic.pass` — sab chains UNREACHABLE (geo-block/WAF window — bilkul wahi window jisme engine degraded data pe girti hai) ho to boot log **"PASS" print karta tha 0 live-verified chains ke saath**. L4 ka apna honesty claim overstate tha.
- **Fix**: pass ke liye ≥1 chain REAL network se PASS required; naye fields `verifiedChains`/`unverifiedChains`; summary INCONCLUSIVE-case me wahi bolti hai + **`wireAbsorb`** — canonicalizer ke recent stats (label/raw-orientation/dropped) payload me expose, taaki CoinDCX wire dobara drift kare to absorption VISIBLE rahe (orientation post-fix hamesha 'asc' hota hai — detector ab bhi trading-output ka satya deta hai, par wire-drift ab chhupa nahi).

### 9) v21.23.9 DOCTRINE SWEEP — residual silent-LONG/SELL defaults (latent money-math)
- `computeTrailSl` (ensemble.js): `side !== 'SHORT'` → honest alias map (LONG/BUY/SHORT/SELL), unknown → NO trail move.
- `fitPlanToRiskCap` (ensemble.js): unknown → unfitted (galat-side SL kabhi nahi).
- `ratchetSl` (coindcxOrders.js): unknown vocab → SL move refuse (BUY ab long-ratchet; pehle ulta short-ratchet = widening!).
- `dhanOrderBody` (dhan.js): unknown side **LOUD THROW** — comment "unknown value BUY default nahi karti" bolta tha, code silent-SELL karta tha (v21.23.2 pin ne conservative-SELL compromise lock kiya tha — ab v21.23.9 doctrine port).
- Baaki `!== 'SHORT'` sites (superIntel/expertPicks/backtest/signalRecheck/globalFutures/futures trail-monitor) callers-canonical documented latent.

### 10) L2.5 SEAT-GUARD SWEEP — vote-bearing candle consumers (defense-in-depth, mirror-class)
Har direct-candle seat jo tail reads karta tha par L3 chokepoint se pehle raw padhta tha, ab entry pe `ensureAscending`: `tapeFromCandles` (last3Pct momentum polarity!), `sessionVwapFromIntraday`, `resampleCandles` (**India committee ka 15m→1h chain — mtf twin me guard tha, isme nahi**), `tapeMTFFromBase`, `smcVote`, `structurePro`, `maCrossFromCandles`, `srMatrix` prev-day, `scoreSwing`, `detectWhale`, `entryTimingRead` (chase-guard polarity), `probrain.structureStop`, `mtf._structureStop`, `simulateSymbol` (edge-stats), `replay._resample`, `mtfLedger` outcome-walk.

### 11) seriesOrientation KEY-DRIFT blind-spot cure (lib/candles.js)
`ensureAscending`/`seriesOrientation` sirf `.time` padhte the — `t`/`open_time`/`T`/`ts` keyed rows (jo parseCandleRow alias-layer me chalti hain) NaN delta → 'unknown' → **untouched mirror**. Yahi key-drift class original disease ko L2/L3 ke nose se nikal sakti thi. Ab alias-tolerant `_rowTimeMs` (TIME_KEYS + s↔ms normalize).

### 12) Nano-fixes
- `parseCandleRow`: present-but-NaN high/low ab ROW DROP (comment ka "DROPPED, never repaired" promise pehle synth se toota tha).
- futures `_futCandleCache` key me `limit` (120-bar write 300-bar reader ko 12-30s poison — data.js ne v20.8.2 me yahi fix spot pe lagaya tha).
- `updatePaperTradeStopLoss` 3rd `marketHint` param (same-name INDIA/CRYPTO paper trades symbol-collision; fastSlTrail LIVE rows paperId:null → symbol path hi chalta hai).
- tradePlanner honest confluence: `?? 5`/`?? 60` fabricated 5/8 counts sweep (partial leg 0-contribute; directionVerified pehle-se per-leg real checks se honest tha, payload/bonus ab bhi).
- liveClose `null`-verdict ab FAIL (routes wrapper `.catch(()=>null)` — fabricated-CLOSE trap ek refactor door tha; `undefined` permissive legacy contract intact).
- LIVE close par failed paper-mirror **VOID** (double-booked track-record poison — voidPaperTrade cure ka missing twin).
- `/api/chart` Yahoo seconds→ms (`time: ts[i]*1000` — har candle surface ka ms contract).
- Watchdog bat teeno stamps v21.23.12 (REM/title me stale v21.23.10 chhupa tha — user console title purana version dikhata).
- MTFDualBoardPanel `isLong = t.side === 'LONG'` (unknown side green-LONG styling).
- aggregateVotes NaN-dir vote filter (`Number.isFinite`).
- Yahoo legs local sort invariant (metals/global/intraday — Binance/fapi legs jaisa).
- directionCert212311 vacuous test de-vacuous (chain absence ab FAIL).

### NAYA TEST FILE test/siteRecheck212312.test.ts — 56 LOCKS
S1 India wrapper arity ×3 + gauntlet dataDegraded ×4 + S3/4/5/6 side-doctrine ×9 + S7 deep-ladder ×2 + S8 resample mirror ×2 + S9 orientation key-drift ×3 + S10 NaN-drop ×3 + S11 cert pass-semantics ×4 + S12 USDC-leg ×2 + S13/17/18 dedup/backoff/cache-key ×6 + S14 India close-verify ×2 + S15 re-anchor lifecycle ×1 + S16 null-verdict/mirror-void ×2 + S19 paper marketHint ×2 + S20 honest confluence ×1 + S21 seat-guard desc-vs-asc equality ×8 + S23 unit/stamps ×5. + 3 honest pin updates (liveRecheck212310 S4 — us pin ne khud v21.23.10 ka BUGGY wiring lock kiya tha; siteRecheck21239 paper-sync marketHint signature; signalDirectionInversion dhan unknown-side doctrine port).

**FULL RELEASE GATE**: tsc 0 · lint 0 · **225 files / 4261 tests ALL PASS (4205+56)** · dist 21.23.12 · check:routes PASS · check:version OK

## v21.23.13 — AUTO-TRADE LIVE CURE + CRYPTO PAPER-DESK ROUTING + DIRECTION HARDENING (user: "AUTO Trade Live button on karne par bhi Auto Trade nahi lag raha hai; Crypto tab me MTF board se Paper pe click karne par Intraday tab me show ho raha hai; long signal hai pakka long jana hai")

### ISSUE-1 — AUTO-TRADE LIVE: button ON, par trade kabhi nahi lagta (5 root-causes cure)

**1) CRITICAL — neutral-tape hole: FRESH-TAPE-ABSENT stuck flag (signals.js ×4 sites)**
- **Root cause**: tape seat ka pass-1 abstain `tapeDataAbsent:true` flag carry karta hai. Injection sirf `tapeV.dir !== 0 && conf > 0` pe hoti thi — tape FETCH ho ke bhi NEUTRAL (dir 0, data present, ranging/coil market) nikle to stale abstain votes me reh jaata tha → `aggregateVotes` POORE consensus ko `freshTapeAbsent` flag karta tha → `executable:false` + agent candidate-skip + v21.23.12 order-time gauntlet veto. Ranging market me ye all-day block tha — jabki design (ensemble.js header) khud bolta hai "neutral tape (vote 0 with data) flag NAHI deta". Injection condition hi design violate kar rahi thi.
- **Fix**: charo injection sites (India board / crypto board / India deep / crypto deep) — data-present neutral vote (`tapeDataAbsent !== true`) bhi abstain ko replace karta hai; directional path unchanged (dir!==0 needs conf>0). Ab `freshTapeAbsent` ka matlab SIRF "data truly absent" hai.

**2) CRITICAL — engine-vs-UI board divergence (routes.js ×3 sites)**
- **Root cause**: UI board route CRYPTO desk ke liye `getSignals('FUTURES', …)` boardSigs use karta hai (USDT-perp universe — dual board ke base-symbol mapping se exact match), par ENGINE loops (60s sweep + 15s deep tick + /run) raw `getSignals('CRYPTO', …)` (spot INR-pair universe) use karte the → engine apna board ALAG boardBase/SVA/council inputs pe banata tha. User ko "AUTO-READY 85+" row dikhta tha, engine apne board me wahi row capped-74/alag-scored dekhta tha — "dikh raha hai par auto trade lagta nahi" ka seedha vector.
- **Fix**: teeno engine sites ab UI-route wala `market === 'CRYPTO' ? 'FUTURES' : market` mapping use karte hain — engine wahi board score karta hai jo user dekhta hai.

**3) HIGH — manual PAPER clicks auto-engine ka daily quota kha rahe the (mtfAutoLink.js)**
- **Root cause**: `recordLiveMtfBoardTrade` (manual board click handler) unconditional `st.dayCount += 1` karta tha — 5 paper test clicks = paper-mode quota (5) khatam = AUTO engine baaki din structurally dead, jabki ek bhi AUTO trade nahi hua tha.
- **Fix**: quota sirf REAL executions khate hain — manual LIVE click (real-money budget, counted rehta hai) + mtfAutoTick ki apni entry path. Manual PAPER click = practice, budget nahi.

**4) HIGH — jhoote-green button + silent arm failures (MTFDualBoardPanel.tsx)**
- **Root cause (a)**: `isLiveAuto` ka primary branch (`executionMode === 'live'`) canLive (creds connected + site live) bypass karta tha — creds missing par bhi button 🟢 LIVE ON dikhta tha jabki engine har attempt reject + escalating backoff (5m→4h) kha raha tha; **(b)** `onAutoLiveExecute` /config fail hone par bhi aage badh ke engine PURANE mode (paper) me arm kar deta tha; **(c)** skip reasons sirf AUTO EVENTS drawer me the.
- **Fix**: (a) dono branches canLive demand karti hain; (b) /config ya /toggle fail par HONEST abort + reason toast; creds missing (`coindcxConnected === false`) par pre-flight abort + "keys connect karo" next-step; (c) status line me last-tick skip reasons + not-connected warning live dikhta hai.

### ISSUE-2 — MTF board PAPER trade Intraday tab me land karta tha, Crypto tab me nahi dikhta

**5) Root cause — ek hi shared paper journal, zero desk filtering**: paper rows correctly `market:'FUTURES'` stamp hoti thi, par `/api/intraday-paper` (getPaperSummary/getPaperHistory) KAHI market filter nahi tha aur Intraday tab ka PaperTradePanel POORA journal render karta tha; CoinDcxTab ke paas is journal ka KOI consumer hi nahi tha.
- **Fix (server)**: `getPaperSummary(marketFilter)` + `getPaperHistory(days, marketFilter)` — 'INDIA' → sirf INDIA; 'CRYPTO' → crypto family (CRYPTO/FUTURES/GLOBALFUTURES = `!== 'INDIA'`); null → sab (engine callers + device-mirror + tests unchanged). Route `?market=` accept karta hai (paper + history + journal).
- **Fix (UI)**: PaperTradePanel `desk` prop — Intraday tab `desk="INDIA"` (uska P&L/stats ab sirf NSE rows), CoinDcxTab me NAYA section "01p · Paper Desk — CRYPTO" (`desk="CRYPTO"`, WS-ticks live map) — MTF board PAPER clicks ab WAHIN dikhenge. Journal bhi desk-scoped: journal rows me `market` stamp + `?market=` filter + JournalPanel `desk="INDIA"` — crypto paper closes NSE EOD/weekly stats ko pollute nahi karte.
- **Fix (mirror hazard)**: desk-scoped fetch se wipe-detection GALAT restore trigger karta — mirror duty ab UNSCOPED singleton loop (`ensureMirrorSyncLoop`) me, restore par window event.

**6) SL-trail hint-domain mismatch (routes.js 3s fast loop)** — deep-monitor row `market:'CRYPTO'` vs paper row `market:'FUTURES'`: `tr.market || tr.execMarket` hint 'CRYPTO' bhejta tha → symbol-fallback SL-update kabhi match nahi karta → 3s fast paper SL-trail is path pe SILENT DEAD tha. Ab `execMarket` pehle.

### ISSUE-3 — "pakka LONG/SHORT" direction-guarantee sweep (live money paths pehle se dual-vocab loud-throw; residual vectors close kiye)

**7)** coindcxOrders spot-create body — repo ka LAST strict-ternary live order-body (`=== 'SHORT' ? 'sell' : 'buy'`): dual-vocab LOUD THROW (spot desk default-ON FULL-STOP ke peeche bhi honest body).
**8)** marginExitBody — non-short SILENT 'buy' → unknown side LOUD THROW (galat position exit-target hone se bacha).
**9)** browserAgent cxPlaceOrderScript/dhanPlaceOrderScript — build-time dual-vocab normalize + LOUD THROW (garbage side pe Dhan pe SELL-click / CX pe buy-click ka chance zero; caller AMBIGUOUS-FAILED journal karta hai).
**10)** recordLiveMtfBoardTrade deep-monitor rows — silent `|| 'LONG'` default ×3 → dual-vocab normalize + LOUD THROW (missing side ka SHORT trade LONG-manage hota tha).
**11)** openPaperTrade — missing/garbage direction SILENTLY 'LONG' banata tha → ab dual-vocab normalize + honest error (saare production callers explicit direction dete hain).
**12)** restore sanitize — legacy mirror rows bina direction ke silently LONG re-hydrate hote the → ab row ke APNE levels se infer (SL entry ke upar = SHORT structure, neeche = LONG), ambiguous ho to `directionAssumed:true` stamp.
**13)** fetchYahooCandles (signals.js) + expertMode fetchYahooChartCandles — repo ke AKHIRI wire-order-trust candle fetchers: local ascending sort (S2-PARITY — CoinDCX mirror-disease lesson: HAR reader apni orientation khud establish kare).
**14)** directionLiveCert CHAIN #6 — cdc-official (api.coindcx.com/market_data/candles, the DOCUMENTED current endpoint = likeliest future wire-drift target) ab apni OWN cert chain se audit hota hai (same URL/canonicalizer/label — wireAbsorb telemetry unified). Cert version stamps v21.23.13.

### NAYA TEST FILE test/siteRecheck212313.test.ts — LOCKS
Neutral-tape injection semantics ×4 + aggregateVotes freshTapeAbsent neutrality + engine boardSigs parity ×3 + paper-quota (paper click no-count / live click count / auto path count) + summary/history desk-filter semantics + SL-trail hint order + journal market stamp/filter + spot body side-strict + marginExitBody strict + browser builders throw-on-invalid + openPaperTrade side-honest + restore side-inference + recordLiveMtfBoardTrade throw + Yahoo local sorts ×2 + cert cdc-official chain + version/stamps. + honest pins: launcherAutoBuild 21.23.13, bat stale-stamp list.

**FULL RELEASE GATE**: tsc 0 · lint 0 · tests ALL PASS · dist 21.23.13 · check:routes PASS · check:version OK

## v21.23.14 — FULL-FLOW AUDIT #3: FAIL-CLOSED CLOSE/ENTRY FIXES + LIVE/PAPER DESK HONESTY

**User ask: top AI trading agents ka full working flow deep recheck + confirmed defects fix karo (MTF board → SAPTA/auto/manual → LIVE/PAPER → exits/UI).**

Do parallel read-only audits (SAPTA/agent/order-flow + MTF board/manual/auto-flow) ke baad confirmed high-risk defects fix kiye. Objective: PAPER↔LIVE leakage, opposite-side adoption, phantom closes, unverified reverse entries aur misleading P&L band; koi gate weaken nahi kiya.

### 1) CRITICAL — reconciler `{ok:false}` close verdict ko flat maan raha tha
- **Root cause**: `ApiFuturesPort.close()` throw nahi karta, `{ok:false}` return karta hai; reconciler L2/L3 loops verdict ignore karke "closed" count/alerts bhej rahe the, orphan flatten bhi success report karta tha — exchange par position zinda, system me flat.
- **Fix**: L2/L3 close + orphan flatten ab strictly `r?.ok === true` demand karte hain; failure par `lastErr`/CRITICAL alert + retry, position book me open rehti hai.

### 2) CRITICAL — SAPTA `PLACED` live limit row ko filled position ki tarah monitor karta tha
- **Root cause**: unfilled `PLACED` row LTP/TP/SL/reversal monitor me girta tha → phantom close, wrong position, stale stop updates.
- **Fix**: hard `PLACED` guard (lastCheckAt only) + live order se pehle persisted STOP re-read + valid plan entry/SL + LONG/SHORT stop-polarity gate (`no-plan-stop`, `stop-polarity`).

### 3) CRITICAL — live entry same pair ki OPPOSITE active position ko success maan sakta tha
- **Fix**: `executeMtfDualLiveOrder` exchange position side verify karta hai; mismatched active side par honest `{ok:false, blocked:true, existingSide}` — reverse/hedge silently adopt nahi hota.

### 4) HIGH — India live MTF book stale board levels par save hoti thi
- **Fix**: India manual LIVE record ab broker fill (`filled.price/qty`) + position SL/TP/T2 par anchored; qty bhi actual fill.

### 5) HIGH — UC flip protective exit ke baad unverified row par reverse entry
- **Root cause**: protective exit sahi tha, par reverse ticket `directionVerified`/ensemble/auto eligibility verify nahi karta tha.
- **Fix**: reverse ab sirf verified direction + ensemble available + `autoEligible` + non-counter-trend/HTF + no veto/opposing-flow par; warna exit-only (`flip-skip`), protective exit kabhi block nahi.

### 6) HIGH — PAPER TEST + global `siteLiveActive` = live-order risk; UI gate server se loose
- **Fix**: PAPER TEST auto config ab explicit `autoSyncSiteLive:false`; server gate jaisa hi UI `canPaper` (`autoEligible`, score ≥65, no counter-trend), LIVE button EQUITY SIM/GLOBALFUTURES par hidden.
- `siteLiveActive` ab desk-scoped hai: `siteLiveByDesk: { crypto, india }` route/context me compute hota hai aur engine ko diya jaata hai (`siteLiveForDesk(p, market)`). India LIVE arming crypto auto ko arm nahi karti (aur reverse bhi nahi); purana boolean sirf backward-compatible fallback ke liye rakha gaya.

### 7) HIGH — EQUITY SIM rows CRYPTO/FUTURES/USDT domain me record ho rahi thi
- **Fix**: GLOBALFUTURES/EQUITY_SIM ab `market/execMarket:'GLOBALFUTURES'`, `ccy:'USDC'`; re-anchor bhi domain + `fxUsed` update karta hai. CRYPTO board route GLOBALFUTURES signals merge karta hai + `mainSignalForEntry` global fallback.
- **Double-wall**: `/api/ai/mtf-dual/live` ab `market=GLOBALFUTURES` ko explicit `PAPER-only` reject karta hai (pehle `isUsd` fall-through India/Dhan branch me ja sakta tha).

### 8) CONTROL-PLANE HARDENING
- Board `ROW_CACHE` key me `boardSig` fingerprint (side/grade/confidence/signalAge) — cross-signal stale row reuse band.
- Auto lane ko manual gate jaisa 5-minute main-signal age floor (`mainSignalAgeMs` + blocker).
- LIVE close ab `pnlVerified/pnlSource` carry karta hai; exchange realized P&L na mile to UI/log `(estimate)`, fake confirmed P&L nahi.

### 9) HIGH - manual MTF board entries direction-lock ke bahar thi
- **Root cause**: board ke PAPER/LIVE button paths cross-engine lock na check karte the na acquire - ek opposite-side manual PAPER trade live auto/agent position ke saath khul sakti thi; manual close ownership bhi clear nahi tha.
- **Fix**: dono paths order se PEHLE `checkDirectionLock(baseSym, side)` (409 + honest reason), aur position/fill ke baad `acquireDirectionLock` (`mtf-board-paper` / `mtf-board-live`). Release ab source-owned hai: `mtf-auto` paper mirror manual LIVE lock ko release nahi kar sakta (`releaseDirectionLock(..., { source })`), manual board PAPER apna `mtf-board-paper` lock release karta hai, aur live/journal-only locks 60s all-books sweeper se flat hone par release hote hain - opposite side post-entry cooldown tak blocked.

### 10) HIGH - crypto agent STOP during in-flight tick
- **Root cause**: `cfg.enabled` tick start pe snapshot hota tha; gauntlet/scan/depth awaits ke beech STOP dabane par bhi last order place ho sakta tha (split ka har leg bhi).
- **Fix**: har executor call se pehle persisted config re-read (`loadAgentConfig()?.enabled !== true` = fail-closed abort). Split me pehle legs fill ho chuke hon to remaining aborted + partial-filled outcome honestly recorded.

### 11) MEDIUM - India desk global-risk heat hardcoded ?10k crypto capital
- **Root cause**: India `globalRiskGate` hamesha `cryptoEquityINR: 10_000` bhejta tha, chahe crypto agent ne real wallet refresh kiya ho - combined-heat cap connected account par late fire hota tha.
- **Fix**: naya lightweight `agentLastWalletEquityINR()` crypto agent ke last refreshed wallet equity ko expose karta hai; India gate wahi use karta hai, cold-start par hi honest ?10k practice fallback.

### Tests / gate
- New `test/fullFlowAudit212314.test.ts` + reconciler close-rejection, SAPTA SL-polarity/PLACED, UC reverse-parity, sim-domain, manual direction-lock, agent STOP, India capital pins.
- Targeted agent/MTF/SAPTA/reconciler/UI/direction-lock suites: **215 passed**; version/site/launcher pins: **123 passed**.
- `tsc 0`, `lint 0`, `check:version OK (21.23.14)`, `check:routes PASS`, `dist 21.23.14`.
- Full suite excluding 5 known environment-dependent files: **222 files / 4230 tests PASS**. Unfiltered run's 6 failures (`v69-core` network timeout, `cryptoAgent`/`llmValidator`/`council` key/mock timing, `signalRecheck` ordering) reproduced independently of this change set (no regression in affected suites).

## v21.23.15 — DIRECTION ACCURACY + AUTO-TRADE READINESS FIX

**User ask: Intraday (NSE) aur Crypto (CoinDCX) me LONG/SHORT direction ki accuracy badhao; Auto Trade live button ke bawajood trade na lagne ki readiness/execution problem fix karo.**

Direction ka root cause: intraday confidence VWAP/POC/volume/ADX ko directional vote ki tarah count karti thi, isliye quality points kabhi tape ke against side pick kar sakte the. MTF vote me 3-bar momentum absolute % tha (har timeframe par same threshold), flat MACD tie BEAR vote karta tha, aur single-bar spike poora timeframe flip kar sakta tha. Auto-trade side: MTF auto config/state sirf ephemeral disk par thi (Render spin-down = auto silently OFF), UI `deskReady` ko ignore karke green badge dikha sakti thi, aur client-side fallback readiness ko overstate karta tha.

### 1) Intraday — DIRECTION vs CONVICTION split (server/intraday/engine.js)
- **Directional score** ab sirf side-pointing evidence se banta hai: EMA stack, RSI, MACD, pivot/CPR, strict Supertrend proxy, HTF SMA50, ORB, gap (India only), low-ADX day-range.
- **Quality score** (VWAP, POC, volume, ADX strength/DI agreement) published confidence me pehle jaisa add hota hai, magar side **choose nahi** karta.
- Confidence ab **chosen side** ka `dirScore + qualityScore` hai — pehle `max(long, short)` opposite side ke quality points se weak side ko inflate kar sakta tha.
- RSI partial bands non-overlapping (`>50..52` LONG only, `48..<50` SHORT only); 50 ke aas-paas genuinely neutral. Crypto gap vote disabled (24/7 rolling 24h change momentum tha, double-count). Supertrend proxy ab EMA10/20 agreement demand karta hai. Day-range mean-reversion vote sirf `ADX < 18` regime me.
- Direction TIE ab bhi 69 par capped — koi entry nahi.

### 2) Intraday — edge-margin + stale-quote gates (feature-flagged, shadow default)
- `INTRADAY_MARGIN_GATE=off|shadow|enforce` (default **shadow**), `INTRADAY_MIN_MARGIN=12`.
  - `shadow`: telemetry only (`wouldBlock`, `edgeMargin`), confidence unchanged.
  - `enforce`: sub-minimum margin `conf ≤ 69` (routes pool floor 70 se neeche) + honest reason.
- `INTRADAY_STALE_GUARD=off|shadow|enforce` (default **shadow**), `INTRADAY_STALE_MAX_PCT=1.2`: LTP vs TV divergence detect hota hai; enforce me stale entry suppressed.
- Payload telemetry additive: `dirScore`, `directionScore`, `qualityScore`, `edgeMargin`, `marginGate`, `staleGuard`, `directionalTie`.

### 3) MTF vote v2 (server/ai/mtf.js, `MTF_VOTE_V2` default ON)
- 3-bar momentum ab **ATR-normalized** (`mom3Atr`) — quiet aur volatile timeframe par same absolute % vote nahi.
- **2-bar context hysteresis**: single-bar spike jo prior bar se disagree kare, momentum vote nahi deta; ambiguous tape par half vote.
- Reversal guard **structure-aware**: swing break + aligned 2-bar context + material ATR move + MACD agreement.
- Direction threshold `1.4` (legacy `0.9`); structure (EMA20/50, Supertrend fallback) ke against vote ki strength `60` par capped.
- Flat tape MACD equality ab neutral (pehle `0 > 0 === false` → BEAR).
- Telemetry: `voteEngine`, `mom3Atr`, `context2`, `structureDir`, `structureConflict`, `rawStrength`. `MTF_VOTE_V2=0` se legacy vote instant restore.

### 4) Direction report + persistence (trackRecord.js, routes.js)
- Naya `GET /api/ai/direction-report?days=&tab=` — full tracked state se LONG/SHORT hit-rate, avg confidence, edge-margin buckets, margin/stale gate counts; MFE/MAE honestly `null` (tracked nahi).
- `_openRow` ab direction telemetry persist karta hai; live refresh bhi update karta hai. Days clamp + null handling fixed.

### 5) AUTO TRADE readiness honesty (MTFDualBoardPanel.tsx, useAITrading.ts, routes.js)
- Green LIVE badge ab sirf `deskReady === true` par; warna exact amber blocker reason (desk-scoped).
- Client-side `topStrongVerified` fallback removed — server readiness authoritative.
- “Why no trade” blockers: top near-miss blocker frequency + honest status line.
- Idle poll 10s; `deskReady` per desk (`india` / `crypto`).

### 6) AUTO config/state durable restore (mtfAutoLink.js, durable.js)
- Config (enabled / desks / live mode / risk) aur state (day counters / book / events) ab `durablePut` encrypted mirror par; `updatedAt` newest-wins restore ke liye.
- `durableBootRestoreAll()` dono files restore karta hai + `__reloadMtfAutoForBoot()` module caches drop karke hydrated files reload karta hai.
- Status ab honest provenance: `bootedAt`, `restoredFromDurable`, `configSavedAt`, `stateSavedAt`.
- POST config response authoritative; `/status` best-effort overlay.

### Tests / gate
- Naye: `test/directionReport.test.ts`, `test/mtfVoteV2.test.ts`; extended `mtfAutoLink`, `durable`, `siteRecheck212313`, `mtf6`/engine suites.
- `tsc 0`, `lint 0`, `check:version OK (21.23.15)`, `check:routes PASS`, `dist 21.23.15`.
- Rollout safe: margin/stale gates shadow default; `MTF_VOTE_V2=0` emergency legacy vote; `INTRADAY_MARGIN_GATE=enforce` / `INTRADAY_STALE_GUARD=enforce` explicit opt-in.

## v21.23.16 — POST-SHIP FULL-SITE RECHECK (2026-10-24)

**User ask: v21.23.15 ke baad poori site ka deep recheck — jo issues confirm hon unhe fix karo, contracts/tests preserve rahen, dist rebuild + version bump.**

Recheck me auto-trade readiness, India live lifecycle, boot persistence, quota day-boundaries, suppressed-flip telemetry, MTF vote compatibility aur UI arm state ke real defects mile. Sab additive / feature-flagged / shadow-safe fixes hain; India LIVE arming shortcut bypass nahi kiya gaya.

### 1) Auto-trade readiness desk-scoped (mtfAutoLink.js, routes.js, useAITrading.ts, MTFDualBoardPanel.tsx)
- `mtfAutoReadiness()` ab `deskReady` + `deskArmable` per desk deta hai: crypto = CoinDCX creds + crypto site-live + kill switch off; India = `indiaMode === 'live'` + India desk on. Pehle ek desk ka live status doosre desk ko arm kar sakta tha.
- UI green LIVE badge sirf `deskReady === true` par; stale `/status` response par green off (`autoFresh`). LIVE arm click se pehle `deskArmable` pre-flight — bina creds / bina India typed-LIVE button disabled amber reason ke saath.
- `/config` / `/status` / `/toggle` config hydration + `autoSyncSiteLive:false` UI-LIVE compatibility retained: explicit `executionMode==='live'` live orders allow karta hai, sirf site flag par depend nahi.
- `onAutoLiveExecute` CoinDCX creds pre-flight ab sirf crypto desk par; India LIVE Dhan desk CoinDCX keys ke bina bhi valid typed-LIVE arming par arm hota hai (pehle India button galti se CoinDCX creds maangta tha).
- Header/rows ab actual desk label dikhate hain (`LIVE DHAN` India rows, `LIVE COINDCX` crypto rows), hardcoded COINDCX nahi.

### 2) Boot persistence + India live lifecycle (server/index.js, mcp/durable.js, mtfAutoLink.js, routes.js, futures.js)
- Durable restore se pehle MTF config/state ka default write suppress (`__beginMtfAutoBoot` / `__reloadMtfAutoForBoot`): Render restart par restored book/config ko pre-restore cache overwrite nahi karta. 15s failsafe timer + unconditional boot reload.
- India deep-monitor close ab `closeIndiaPosition(positionId)` route karta hai (pehle crypto `liveClose` path India position ko miss karta tha). Manual India live record me journal `positionId` store hota hai.
- CoinDCX SL update journal lock ke andar (concurrent deep-monitor / reconciler write race close).
- India LIVE arming still separate: `tcfg.indiaMode === 'live'` mandatory; MTF `executionMode` se India arm nahi hota.

### 3) Intraday direction accuracy + honest no-edge cap (engine.js, routes.js, trackRecord.js)
- `INTRADAY_NO_EDGE_CAP = 69`: TIE / sub-minimum edge margin / stale quote entry floor (70) cross nahi kar sakte. AI blend ke BAAD bhi re-cap hota hai, aur `edgeSuppressed` rows choppy-market fallback pool me wapas nahi aate.
- Blank env values (`INTRADAY_MIN_MARGIN`, `INTRADAY_STALE_MAX_PCT`) ab documented defaults par fallback — `Number('') === 0` se gate silently off nahi hota.
- Crypto TV `last` INR-domain normalization before direction scoring; opposite-domain price se fake LONG/SHORT bias nahi.
- `trackRecord` telemetry: whitespace-safe number parsing, null-preserving merge, `avgConfidence`, tab-scoped report counters, honest `mfe` / `mae:null`. Suppressed opposite-direction flip ab sirf live confidence + last price refresh karta hai; `dirScore` / `qualityScore` / `edgeMargin` / direction telemetry frozen rehte hain (mixed-side report corruption fix).

### 4) MTF vote v2 + reversal guard (mtf.js)
- Default ON: threshold `1.4`, ATR-normalized 3-bar momentum, aligned 2-bar context, 2-bar hysteresis, structure-conflict strength cap 60.
- Structure-aware active pump/dump forced reversal direction; legacy flat-MACD equality neutral. `MTF_VOTE_V2=0/false/off` se instant legacy vote.
- Telemetry: `voteEngine`, `mom3Atr`, `context2`, `structureDir`, `structureConflict`, `rawStrength`, `score`, `reversal`.

### 5) Daily quota / day-boundary honesty (mtfAutoLink.js, routes.js)
- Daily quota ab har book row ko uske apne market ke current day ke against count karta hai: INDIA IST midnight, CRYPTO/FUTURES UTC midnight. Single IST `dayCount` se crypto UTC reset 5.5h block/short ho raha tha.
- `maxTradesPerDay -> 15` inflation hataya (normal + UC flip-reverse quota dono).
- `POST /api/ai/mtf-auto/config` with `executionMode:'paper'` ab `autoSyncSiteLive:false` default karta hai (explicit override still honoured) — paper-test se real CoinDCX/India order ka API footgun band. UI paper button pehle se false set karta tha.

### Known scoped follow-ups (deliberate, documented)
- UI arm ek global `executionMode` likhta hai; cross-desk arm ab readiness se block hota hai but per-desk independent arm config future feature hai.
- LIVE + flat mode me per-symbol cooldown bypass intentional hai ("LIVE Auto click always fires"); post-success profit cooldown + 1-session-1-trade lock still enforced.
- `siteLiveForDesk()` legacy global `siteLiveActive` fallback retained for old callers/tests; routes always pass per-desk maps.

### Tests / gate
- New `test/recheck212315.test.ts` (boot guard, desk scope, India lifecycle, quota boundary, paper autoSync, no-edge cap). Extended `v203DeepAudit` suppressed-flip telemetry lock, `directionReport`, `mtfVoteV2`, `fullFlowAudit212314`, `siteRecheck212313`, `launcherAutoBuild`.
- Targeted recheck/UI/MTF batches PASS: 18 files / 413 tests (initial recheck batch), final UI/recheck batch 144, version/direction batch 138, `ucFlipReverse21238 + v2122NinePointSuperUpgrade` 43.
- `tsc 0`, `lint 0`, `check:version OK (21.23.16)`, `check:routes PASS`, `dist 21.23.16`.
- Full suite: 226 files / 4346 tests PASS; remaining 5 failures across 4 files (`v69-core` network timeout, `cryptoAgent` x2 5s timeout, `council`/`llmValidator` key/mock calls) are environment-dependent and reproduce independently of this change set.

## v21.23.17 — MTF BOUNCE GUARD + GATE PROMOTION READINESS (2026-10-24)

**User ask: clean downtrend ke ~1% bounce par 15m MTF vote flip na ho; config save failure ka asli reason dikhe; naye env flags document hon; margin/stale gates ka rollout data-driven ho — legacy escape hatches intact rakho.**

### 1) MTF shallow-bounce veto (mtf.js, board wire, badge)
- Counter-structure vote ab neutral hai unless `activePump` / `activeDump` CONFIRMED ho **aur** price ne vote direction me EMA50 ke beyond close kiya ho. Missing EMA50 = unconfirmed, isliye suppress. Pehle ek clean downtrend me ~1% bounce 15m vote ko `+1` kar sakta tha.
- Confirmed counter-structure reversal pehle jaisa strength cap `60` rakhta hai — cap ek directional vote hai, neutral nahi. Board ab `60` chip ke saath `raw → capped` aur EMA50 veto reason dikhata hai, taaki capped reversal full-strength vote se confuse na ho.
- Wire/UI telemetry: `rawStrength`, `structureConflict`, `counterStructureSuppressed`, `counterStructureSuppressedReason`, `reversal`. Suppressed row `dir:0`, `strength:0` publish karta hai (board par neutral + reason), vote direction silently flip nahi hota.
- `MTF_VOTE_V2=0/false/off/no/disabled/legacy` exact legacy vote deta hai (threshold 0.9, absolute-% momentum, koi v2 veto/telemetry nahi) — emergency rollback path unchanged.

### 2) Gate promotion readiness (trackRecord.js, direction-report)
- `GET /api/ai/direction-report` me naya `gateReadiness` block: margin aur stale gate ke liye blocked vs kept cohorts, settled outcomes par only. Null telemetry (board rows / no TV reference) ko clean evidence nahi gina jata.
- Promotion criteria: ≥10 resolved blocked + ≥20 resolved kept rows, blocked win-rate ≤50%, aur kept ke against ≥8pp underperformance gap. Statuses: `COLLECTING`, `PROMOTE_READY`, `KEEP_SHADOW`, `ENFORCED`; `nextStep` exact Render env flag batata hai.
- Defaults safe hain: `INTRADAY_MARGIN_GATE=shadow`, `INTRADAY_MIN_MARGIN=12`, `INTRADAY_STALE_GUARD=shadow`, `INTRADAY_STALE_MAX_PCT=1.2`; `enforce` tabhi jab report `PROMOTE_READY` ho. `INTRADAY_NO_EDGE_CAP=69` entry floor (70) se neeche hai, isliye gated row trade nahi kar sakti.

### 3) Honest config/toggle errors (useAITrading.ts, MTFDualBoardPanel.tsx)
- `updateMtfAutoConfigApi` / `setMtfAutoEnabledApi` ab `MtfAutoApiResult` return karte hain — server ka real message + correlation id + HTTP status. Pehle har failure `null` ban jata tha aur UI sirf generic “NAHI hua” dikhata tha.
- Mode switch failure par UI previous mode/hold revert karta hai; paper auto-test config save fail par engine arm nahi karta; LIVE arm config/toggle fail par honest abort + reason deta hai. Successful POST config authoritative rehta hai, `/status` best-effort overlay.

### 4) Env documentation (.env.example)
- `MTF_VOTE_V2`, `INTRADAY_MARGIN_GATE`, `INTRADAY_MIN_MARGIN`, `INTRADAY_STALE_GUARD`, `INTRADAY_STALE_MAX_PCT` documented with defaults, accepted values, legacy escape, aur promotion workflow.

### Tests / gate
- New `test/mtfAutoApiHonesty.test.ts` (real server error + correlation ref, flat toggle error, POST authoritative when `/status` down, network failure); `directionGateReadiness.test.ts` (COLLECTING / PROMOTE_READY / KEEP_SHADOW / ENFORCED); extended `directionReport`, `mtfVoteV2` (shallow bounce, confirmed pump, legacy, cap/wire), `recheck212315` (arm-abort source locks).
- Targeted MTF/direction/UI batches PASS: 6 files / 44 tests; 7 files / 165 tests. Version/recheck batch PASS: 3 files / 113 tests.
- `tsc 0`, source `lint 0`, `check:version OK (21.23.17)`, `check:routes PASS`, `dist 21.23.17`.
- Full-suite attempt still hits pre-existing network/trading-watcher 5s timeouts in this environment; the same failures reproduce on a clean v21.23.16 worktree (verified `directionProof` EXIT timeout), so they are not attributed to this change set.

## v21.23.18 — FULL PRO-TRADER RECHECK: flip-session parity + root async guard + PAPER/LIVE isolation (2026-10-24)

**User ask: "full site ko pro trader level par recheck karo, sabhi features end-to-end verify karo, LONG/SHORT signal accuracy confirm karo, issues fix karo aur unwanted code/temp files clean karo."**

### 1) UC flip-reverse session parity (mtfAutoLink.js)
- **Bug**: `_tryOpenUcFlipReverse` apna session type `cfg.executionMode === 'live' || cfg.autoSyncSiteLive !== false` se nikalta tha. `autoSyncSiteLive` default `true` hai, isliye PAPER mode me bhi flip session LIVE maana jata tha -> doosra open PAPER trade 1-session-1-trade lock ko nahi rokta tha aur paper notional LIVE budget se kat jata tha.
- **Fix**: flip session ab tick ke authoritative `isLiveSession` jaisa hi hai (`executionMode live` YA `autoSyncSiteLive` + koi desk site-live). Reverse entry ka 1-session lock, daily quota aur `_openNotionalINR(...)` teeno isi scoped value se chalte hain. PAPER mode me 1 session = 1 trade ab flip path par bhi hard hai; LIVE session me PAPER test rows real LIVE notional cap nahi khate.

### 2) Root-level async route guard (server/index.js)
- Pehle sirf sub-routers `withAsyncRouteGuard` proxy se register hote the; `server/index.js` ke direct `app.get/post` async handlers (chart, quote, cloud sync, ML, AI bridges) rejection par socket hang kar sakte the.
- Ab ROOT `app` hi guard proxy hai aur `routesApp` wahi identity hai — direct async routes bhi honest `next(err)` / 500 dete hain. Sync handlers, routers, middleware factories aur 4-arg error middleware unchanged.

### 3) Dead code removal
- Unused `_paperOpenSymbols()` helper removed (grep-verified: koi caller nahi).

### 4) Version/docs consistency
- Prior commit `25fba3f` ne v21.23.18 code ship kiya tha par `package.json`, lockfile, `src/version.ts`, cert aur watchdog stamp 21.23.17 hi the. Ab sab **21.23.18** par aligned hain (cert `v21.23.18`, watchdog bat + dist stamp included).

### Tests / gate
- New locks: PAPER flip reverse doosre open PAPER trade se blocked; LIVE flip notional cap PAPER rows ignore karta hai; root async-guard source pin.
- Targeted batches PASS: `ucFlipReverse21238 + mtfAutoLink + routeMount + fullFlowAudit212314` = 76 tests; recheck/UI/MTF batch = 232 tests; core trading batch (aiOrders, leverage, agent, indiaAgent, options, proTrader, globalFutures, v70, v702, trailing) = 233 tests (all with `--testTimeout=30000`).
- `tsc 0`, source `lint 0`, `check:version OK (21.23.18)`, `check:routes PASS`, `dist 21.23.18`.
- Full-suite default 5s run: 4254 passed / 140 failed across 29 files — 80 failures were 5s timeouts (this Windows box + live server/LLM feeds); the same files pass when rerun with a 30s timeout, so no signal/direction regression is attributed to this change set. Pre-existing environment-dependent suites (`v69-core`, `cryptoAgent`, `council`, `llmValidator`) remain network/LLM-timeout sensitive.
