# SMARTAI PRO — PHASE-2 LIVE FLOW CHECKLIST (v21.2.0)

> Ye wo manual verification items hain jo **sirf aapke laptop/Render pe, real
> network + real keys ke saath** ho sakte hain (sandbox me impossible).
> Har item ke saath result likho: **PASS / FAIL / FIX-NEEDED**.
> Sab kuch **PAPER mode me** pehle — LIVE sirf go-live gate clear hone ke baad.

---

## A. Boot (local)

- [ ] `APP_PIN=<8+ digit> BOTS_MODE=PAPER npm start` — server boot ho
  - Expected: `[health] v21.1.0 health monitor armed` line boot log me
  - Expected: `[smartai] server on :<port>` + version banner `v21.1.0`
- [ ] `curl localhost:8080/api/ping` → `{"pong":true,...,"v":"21.1.0"}`
- [ ] Placeholder PIN behavior: `APP_PIN=1234 npm start` → server **refuse to boot**
  (validateEnv error — documented/guessable values block hote hain) — **VERIFIED SANDBOX ME (code path)**
- [ ] Weak PIN warning: 6-digit PIN → boot pe warning (block nahi hota)

## B. Login / Rate limits

- [ ] Galat PIN 5 baar → 6th attempt **429** — **VERIFIED SANDBOX ME (live curl)**
- [ ] Sahi PIN ke saath phir login ho jaye
- [ ] **Render (important)**: `TRUST_PROXY=1` env SET hai ya nahi check karo.
  v21.1.0 se PaaS auto-detect hai (`RENDER` env) — XFF automatically honor
  hota hai, per-user rate limit milta hai. Verify: `/api/health` → do different
  networks se login, dono ka alag bucket. (`TRUST_PROXY=0` explicitly off kar sakta ho)

## C. Data feeds (har source ka status)

- [ ] CoinDCX futures WS: `/api/health` → `feeds.ws.coindcxFutures.healthy: true` + ageSec < 5
- [ ] **v21.1.2 WS idle-vs-down**: `armed:false` socket = IDLE (grey, normal — koi subscriber
  nahi), DOWN nahi. Red sirf `healthy:false && armed!==false`. OS strip WS chip
  tooltip me ab `cooldownReason` / `failStreak` / `cooldownRemainMs` seedha dikhta hai
- [ ] **CoinDCX "WS Down" kabhi dikhe to (v21.11 update — probe script retired, in-build diagnosis)**:
  OS strip WS chip pe hover karo → tooltip me `cooldownReason` / `failStreak` /
  `cooldownRemainMs` seedha dikhega. Deep-dive: `GET /api/feed-status`.
  Reason ka action-matrix (wahi jo probe deta tha):
  | Reason/Verdict | Matlab | Action |
  |---|---|---|
  | grey "N idle" | Koi subscriber nahi | NORMAL — down nahi, kuch mat karo |
  | `handshake-streak` (403/451) | Host IP/region WAF-reject | Server region badlo (Render: Singapore / Oracle Mumbai) |
  | DNS-FAIL / TIMEOUT | Egress blocked | `wss://stream.coindcx.com:443` allow karo |
  | `silent-contract` / NO-NS-ACK | Protocol/upstream degraded | CoinDCX status + docs check |
  | `glob-quiet` / SILENT-CHANNEL | Joined par zero ticks | Channel docs verify; GLOB off-hours quiet ho sakta |
  (Historical: v21.1.2 sandbox se LIVE verify HEALTHY tha — 114 ticks/30s)
- [ ] Binance futures WS: `feeds.ws.binanceFutures.healthy` (agar accelerator on hai)
- [ ] India Groww 3s poller: market hours me `feeds.sources['groww-nse-realtime'].live: true`
- [ ] Finnhub US (agar key hai): `feeds.sources['finnhub-stream'].live: true`
- [ ] Dhan 5-min historical: Bot Lab me backtest/calibrate chala ke candle data aata hai?
  (Dhan abhi **unverified** hai — ye test Phase-2 ka part hai)
- [ ] Feed down hone pe UI me honest "stale/down" state — `/api/health` me
  `staleSources` array + OPS strip ka FEEDS chip red — **VERIFIED SANDBOX ME (endpoint live)**

## D. Signal → paper trade → ledger (MARKET HOURS ME)

- [ ] Ek signal entry lo (`/api/ai/execute` paper mode) — **VERIFIED SANDBOX ME (BTC live price)**
- [ ] Position UI me dikhe, SL/TP watcher ke hits simulate/actual ho
- [ ] Close hone par `/api/ai/ledger` me outcome stamp ho (r + pnlINR)
- [ ] `/api/ai/strategy-health` me us strategy ka rolling window update ho
- [ ] 30 trades ke baad rolling expectancy dikhna shuru ho

## E. Bots (ORB-IN / ORB-crypto / LVL)

- [ ] Har bot ka **separate paper account** (`/api/bots/status` me accounts)
- [ ] Kill switch: `POST /api/bots/stop/<bot>` → bot TURANT ruke (heartbeat me kill_switch)
- [ ] Global STOP_ALL → sab bots pause
- [ ] Max daily loss trigger: chhoti equity pe bot chala ke loss limit hit karo —
  bot `daily_loss` reason se block ho (botRisk fail-closed)
- [ ] Max position size: config se 1 pe set karke verify
- [ ] **Go-live gate (v21.1.0 naya)**: LIVE mode on karne se PEHLI paper stats
  (100+ trades, +expectancy, DD limit) — `StrategyHealthPanel` me LIVE LOCKED/UNLOCKED chip

## E2. AI provider — Jev cloud (v21.14: Laya REMOVED)

- [ ] **R0 Jev key**: [typesafe.ai](https://typesafe.ai) se TYPESAFE_API_KEY
  → `app\.env` me daalo → restart → Bot Lab me JEV option ENABLED +
  OpsHealthStrip `AI: J ✓`
- [ ] **Arm switch live**: dropdown se `JEV` / `AUTO` — bina restart, state persist
- [ ] **409 check**: key ke bina `JEV` chunna → UI me disabled + direct API pe
  409 `provider_unavailable {provider: "jev"}`
- [ ] **Provider-down drill**: arm=JEV/AUTO + TYPESAFE endpoint band →
  decisions honest WAIT mode me (provider_down reason events stream me);
  OpsHealthStrip AI chip red; rules/gated arms unaffected
- [ ] **Board AI-confirm**: `AI_BOARD_CONFIRM=auto` + key → top board signals
  `🤖 AI ✓/✗/○ (Jev ...)` chip ke saath (tooltip me direction + conviction)
- [ ] **v21.14 NOTE**: Laya local AI model PERMANENTLY REMOVED — purane
  LAYA_* .env lines ab ignore hote hain (safe to delete); laya/consensus
  arms removed; legacy bot-state arm=laya/consensus tick pe jev/gated pe
  arm_fallback event ke saath map ho jate hain
## F. Restart persistence

- [ ] Server restart → open positions, ledger, bot state wapas aaye —
  **VERIFIED SANDBOX ME (openPositions: 1 after restart)**
- [ ] **Render ki ephemeral disk ke liye**: `GITHUB_BACKUP_TOKEN + GITHUB_BACKUP_REPO`
  env set karo (backup.js durable restore) — Render restart ke baad
  journal/ledger GitHub backup branch se restore hote hain. YE TEST RENDER PE
  ZAROOR KARO (sandbox me durable NOT configured tha — boot log me line dikhi thi)

## G. Telegram

- [ ] `TG_TOKEN + TG_CHAT_ID` env — boot pe `[telegram-selftest]` PASS
- [ ] `/api/telegram` relay se test message
- [ ] Webhook: `POST /api/telegram/webhook` (secret-token header) — approval flow
- [ ] Health alerting (v21.1.0 naya): koi feed 90s+ stale karo (net disconnect) →
  15 min throttled 🩺 HEALTH telegram message aaye

## H. Execution code paths (code-level — v21.1.0 me fix + test-locked)

In sab ka code-level fix ho chuka hai (unit tests ke saath); LIVE pe ek baar
sanity check karo:

- [ ] Ambiguous entry (net kill karte ho order ke beech me) → UNKNOWN position
  book hota hai, duplicate re-entry BLOCK — journal me `AMBIGUOUS ENTRY` entry
- [ ] Futures tpsl-fail → position flatten (`PROTECTION-FIRST FLATTEN` journal)
- [ ] Spot partial-TP ambiguous → 5-min retry hold (double-sell guard)
- [ ] Reconciler kill (L1/L2/L3) → AI-desk + agent dono entries block
- [ ] L2/L3 flatten fail → Telegram 🚨 alert + next-12s-tick retry

## I. API keys (CoinDCX)

- [ ] Key permissions: **view + trade ON, withdrawal OFF**
- [ ] IP whitelist ON (jahan server IP fixed hai — Render pe static outbound IP
  ke liye paid plan chahiye; laptop pe home IP)
- [ ] `mcp-coindcx.json` gitignored hai (verify: `git status` me kabhi na dikhe)

---

## Result log

| Section | Result | Notes |
|---------|--------|-------|
| A. Boot | | |
| B. Login/rates | | |
| C. Feeds | | |
| D. Signal→trade | | |
| E. Bots | | |
| F. Persistence | | |
| G. Telegram | | |
| H. Exec paths | | |
| I. API keys | | |

Koi bhi FAIL aaye to screenshot + journal entry (`server/data/ai-trading-journal.json`
ka relevant `kind`) ke saath bhejo — fix kar denge.
