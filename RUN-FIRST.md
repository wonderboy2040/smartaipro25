# ⚡ RUN-FIRST — SmartAI Pro kaise chalana hai (Windows)

Ye file zip extract karte hi sabse pehle padho. **Koi .exe nahi chahiye — sirf ek .bat file hai.**

---
## 🚀 v21.17.0 — MTF BOARD USDT PRICING + SUPERINTELLIGENCE CARD UI + PAPER TRADING UPGRADE

**Kuch bhi extra setup nahi — zip extract karo → `app\Start-SmartAI-Watchdog.bat` double-click.**

- **💵 Crypto MTF Signals Board ab USDT (`$`) me:**
  - CoinDCX desk (01d) ke MTF Signals Board par saare crypto prices/levels (`ENTRY · STOP · TARGETS`) ab **USDT** me aate hain (Binance USDT klines primary → CoinDCX INR ÷ USDINR honest scaled fallback; chhote mono me `≈ ₹...` cross-view). India desk ₹ (INR) me hi rehta hai.
- **🧠 Superintelligence Signal Board jaisa Card UI (`MTFDualBoardPanel.tsx`):**
  - 2-column `quantum-panel` card grid, SignalCard jaisa 4-box trade-plan (`⏱ ENTRY · 🛑 STOP · 🎯 TARGETS · ⏰ EXIT-BY`), tier pill + progress bar, `TF-FIT`, `COST R`, `netRR`, `P(WIN)`, `DUAL ✓ / TRIPLE ✓` badges, expandable `▸ why <score>?` fuse breakdown, aur har card par **`🧪 PAPER`** manual paper-trade button.
- **📈 Paper Trading Upgrade (`paperTrading.js` + `PaperTradePanel.tsx`):**
  - **24×7 USDT Perp (`FUTURES`) & USDC (`GLOBALFUTURES`) paper trades** (fractional qty 4dp, UTC day, no 15:10 IST EOD cut, crypto 0.05% taker-fee model, quote-domain guard taaki INR quote se USDT trade kabhi trigger na ho).
  - **Excursion & Exit-Quality Analytics:** Har trade par live **MFE / MAE (in R)**, **R-multiple** (`avgR`, `bestR`, `worstR`), **Capture %** (actual R ÷ MFE R), **Exit Mix** (`T1 / T2 / SL / BE-trail / EOD`), **Source Split** (`ui` vs `🧪 mtf-board-ui` vs `🔗 mtf-auto`), aur `PARTIAL (T1✓)` rows par manual `CLOSE` button.
- **Verification:** tsc clean · eslint clean · **vitest 207 files / 3844 tests PASS** · build stamped **21.17.0** · routes PASS.

---
## 🧠 v21.16.0 — MTF SIGNALS BOARD (DUAL-TIMEFRAME) + SUPERINTELLIGENCE + AUTO-LINK (75+ → PAPER)

**Kuch bhi setup nahi karna — extract → `Start-SmartAI-Watchdog.bat` double-click.** Naya panel dono desks par section **01d** me aa gaya hai.

- **🧠 Naya panel: MTF SIGNALS BOARD (Dual-Timeframe)** — India desk (01d) + CoinDCX desk (01d).
  Board ke signals par **dual-TF superintelligence**:
  - **⚡ 15m→5m** (15m deep context + 5m action trigger) · **🕐 1h→15m** (swing) · **⚡ 5m→1m** (15-20 min exits)
  - **Fused SUPER-SCORE** = 30% context trend + 25% trigger action + 20% plan confidence + 15% 1d+4h extended bias + 10% board base
    (+ dual/triple align bonus, P(win) EDGE +3; MISMATCH **cap 70**, counter-trend **cap 74** — 75+ bar shortcut se cross nahi hota)
  - Tier: **ELITE 85+ · STRONG 80+ · ACTION 65+ · WATCH 50+** · har row me C/T/E arrows, entry/SL/T1/T2, TF-fit + ratio, cost-in-R (netRR), exact auto-blocker reason.
- **🔗 AUTO-LINK (PAPER ONLY) — aapka spec: 75+ ACTION/STRONG signals paper trade se link.**
  - Qualify: **score ≥75 (bar adjustable) + trigger FIRED + TF-fit GOOD/OK + not counter-trend + dual-TF aligned + grade A/B + cost <0.5R + complete ticket.**
  - Execution: wahi paper engine (`openPaperTrade`) — risk-based qty (default ₹2000/trade), **T1 pe 50% book + runner BE-trail**, T2 full, SL/EOD watcher, **TIME-STOP** (plan window ke andar T1 na aaye to close).
  - Gates: NSE open + 15:00 cutoff (India) · trades/day quota · per-symbol cooldown 30m · max 6 open · **₹1 lakh notional budget** · kill-switch aware · **default OFF (ARM karke chalao)**.
  - UI: **PREVIEW** (dry-run — kaun ready hai + kyun nahi), **ARM/DISARM**, **RUN NOW** (manual tick), 📒 LINKED PAPER BOOK + 🧾 AUTO EVENTS.
  - **🔒 Ye live broker order KABHI nahi bhejta** — sirf paper engine. (Live auto ke liye alag SAPTA pro-trader auto hai.)
- **🔧 Pro-level recheck fixes (live data pe pakde, tests se band):** price-ladder collapse fix (sub-$1 pairs — DOGE/XRP class, `pRoundLadder`), cost ≥0.5R / micro-stop / negative-netRR rows ka **auto-block**, TradePlanPanel ka LTP refetch-storm fix, test-suite ka server/data pollution fix, `evaluatePaper` hardening, board build concurrency-4 (cold load tez), symbol normalization (BTCUSDT), day-bucket precision (IST/UTC).
- **Poora detail + live proof**: repo root me **`MTF-DUAL-BOARD-SUPERINTEL.md`** — kya-kya mila, kaise fix hua, fuse ka math, gates, aur real-data E2E (score 84 STRONG row → paper trade → T1 50% book → close ₹1040.81).
- **Verification**: tsc clean · eslint clean · **vitest 206 files / 3826 tests PASS** · build stamped **21.16.0** · routes PASS.

---
## 🎯 v21.15.0 — MTF TRADE PLAN (15m→5m · 1h→15m · 5m→1m) + MEASURED TF-FIT ENGINE

**Kuch bhi setup nahi karna — extract → `Start-SmartAI-Watchdog.bat` double-click. Panel khud deep-analysis modal me aa jaata hai.**

- **Naya panel**: kisi signal card pe **🔬 deep analysis** kholo → **🎯 MTF TRADE PLAN** —
  - **⚡ 15m → 5m** (aapka intraday plan: 15m deep candles + 5m action)
  - **🕐 1h → 15m** (swing plan: 1h deep + 15m action — *recommended*)
  - **⚡ 5m → 1m** (jab **15-20 min** ka exit chahiye — isi TF pair me travel fit karta hai)
  - Hold chips **20 / 45 / 90 min** → **TF-FIT verdict** (GOOD / OK / STRETCH / MISMATCH) +
    suggested window. Ye honest verdict hai: 5m trigger + 20 min window par aksar STRETCH
    aata hai, kyunki 4 bars me price ka typical travel T1 se kam hota hai (measured).
  - Sath me: context read (EMA/Supertrend/ADX/structure/VWAP), trigger read (breakout bar,
    volume surge, body, RSI band), **entry zone + SL (structure ± ATR, 0.9×ATR floor) +
    T1=1R / T2=2R**, **net RR (cost ke baad)**, qty (leverage-capped), 9-point checklist,
    time-plan (BE rule · trail · time-stop · hard exit) aur warnings (COUNTER_TREND ·
    COST_HIGH · TF_HOLD_MISMATCH · LATE_SESSION · SIZE_CAPPED …).
- **Naya route**: `GET /api/ai/trade-plan/:symbol?market=&mode=&hold=&side=&ltp=&capital=&riskPct=`
  (+ `/api/ai/trade-plan/modes`). 30s cache, `fresh=1` bypass.
- **Naya research lab (offline)**: `node scripts/mtf-accuracy-lab.mjs --days=60` —
  22 symbols × 60 din real data par alignment / strategy / hold-window / cost study.
  Output: `lab-out/mtf-lab-results.md`. Site runtime par zero asar (sirf research).
- **Poora analysis**: repo root me **`MTF-TRADE-PLAN-ANALYSIS.md`** — aapke sawaal
  ("zyada TF = zyada accuracy?", "15-20 min me exit?", "1-1.5 hr me exit?") ka
  measured jawab, tables + math ke saath.
- **Safety**: kuch bhi purana nahi toota — panel add-only hai, aur data na mile to
  honest "plan unavailable" dikhata hai (koi fake numbers nahi).

---


## 🎯 v21.14.0 — LAYA LOCAL AI MODEL PERMANENTLY REMOVED (zero-impact removal)

**Laya (local laya-serve AI) ab codebase se poora hata diya gaya hai — site par ZERO asar.**

- **Kuch bhi karna nahi hai** — extract → `Start-SmartAI-Watchdog.bat` double-click, pehle jaisa.
- **Trading Signals bilkul unaffected** — signals ka generation AI-confirm layer se pehle hota hai;
  AI layer sirf score ± karta hai (kabhi side/SL/size nahi badalta). Provider na ho to layer
  silent-off rehta hai — board normal chalta hai.
- **Bot Lab**: arms ab `RULES / GATED / JEV / AUTO` (laya/consensus arms removed). Purane bot
  state me arm=laya/consensus pada ho to tick pe honest `arm_fallback` event ke saath jev/gated
  pe map ho jata hai — bots kabhi nahi rukte.
- **AI confirm ab sirf Jev (cloud)** — `TYPESAFE_API_KEY` .env me daalo to board signals par
  `🤖 AI ✓ (Jev ...)` chip direction + conviction ke saath dikhega.
- **Purane `LAYA_*` .env lines ignore hote hain** (safe to delete — kuch break nahi hota).
- Watchdog 10048 bind-war / `no_laya_instance` / `arm_fallback` laya wale messages ka poora
  surface hi khatam — watchdog ab SIRF site child manage karta hai.
- Neeche wale purane sections (v21.5/v21.4/v21.2 Laya setup) ab **historical archive** hain —
  unka koi step follow karne ki zaroorat nahi.

---

## 🎯 v21.6.0 — ULTRAFAST REALTIME MARKET FEEDS (India + CoinDCX + Binance + USA)

**Sab markets ab seedha site-load pe superfast live connect hote hain — bina kisi naye setup ke.**
Live-measured: SSE snapshot **+8ms** (saare India+US+crypto keys paint), crypto ticks instant,
US first tick +3.2s, India NSE hours me 1s loop. CoinDCX spot-WS 730 markets live verify.

**1) India ultrafast — 2 tiers (automatically best available):**
- **Default (zero setup):** Groww public feed cache **3s → 1.5s** + SSE poll **3s → 1s** —
  India cards ab 1Hz par tick karte hain. Intraday watcher (T1/T2/SL evaluation) **5s → 3s**.
- **Optional (fastest — 1s official):** Groww Trading API keys daalo:
  1. Groww app/web → **Profile → Settings → Trading APIs → Generate** (active subscription chahiye)
  2. `app\.env` me:
  ```env
  GROWW_API_KEY=your_key
  GROWW_API_SECRET=your_secret
  ```
  3. Restart — badge **Groww·API** (emerald) dikhega. ONE batched call = 50 symbols @ 1s
  freshness (limits 10 req/s). Token khud daily ~05:00 IST refresh hota hai — koi manual step nahi.
- **SACH YE HAI:** Groww ka koi websocket NAHI hai (live-probed — official Trading API bhi
  REST-only hai). Ye wala batched-LTP path hi sabse fast direct-Groww connection hai jo possible hai.

**2) CoinDCX + Binance crypto — already ultrafast (verified live):**
- Official CoinDCX spot WebSocket (`currentPrices@spot@1s`) — sub-second INR pushes
- Binance USDT WS accelerator — sub-second projected ticks (venue-anchored)
- Chain: REST anchor → spot-WS book → Binance×fx synth → deep-stale (kabhi dead nahi)

**3) USA ultrafast — FREE key se instant trades:**
- Default (zero setup): TradingView batch ~3s + Yahoo fallback — already live
- **Optional:** [finnhub.com](https://finnhub.com) pe FREE signup → `FINNHUB_API_KEY`
  `app\.env` me daalo → US symbols ab instant WebSocket trades par tick karenge

**4) Kya verify karna (2 min):**
- [ ] Site load → prices turant paint (snapshot <50ms)
- [ ] CoinDCX tab → ⚡ CoinDCX·RT badge, prices har second
- [ ] India tab (NSE hours) → Groww·live ya Groww·API badge, 1s ticks
- [ ] `/api/health` → `feeds.growwApi` field (armed/breaker status)

**5) Ye bhi fix hua (purana toota hua tha):**
- `npm run check` repair — cleanup commit ne scripts delete kar diye the jo package.json,
  supervisor (BACKUP_STATE_ON_BOOT) aur 4 test files use karte the — restore ho gaye
- `start-laya.cmd` LF → CRLF (Windows .cmd strict) — watchdog ke Laya block ke liye zaroori tha

---

## 🎯 v21.5.0 — LAYA FAST UPGRADE (local AI speed — koi naya setup step NAHI)

**Local Laya model ab burst me bhi fast + stable rehta hai. Extract → bat double-click — bas.**

**1) Kya better hua (automatically live):**
- **Board AI-confirm bursts ab timeout-storm nahi karte** — pehle top-6 signals × 2 providers
  ek saat local server pe jaate the; queue ke aakhri requests timeout → **Laya breaker 10 min
  ke liye band** ho jaata tha (healthy server pe bhi). Ab FIFO gate (default 2 concurrent) —
  har request ko apna pura timeout budget milta hai.
- **Timeout pe retry band (local)** — timeout honest `timeout` note ke saath turant Jev pe
  failover (auto-arm). Retry line lambi karta tha, ab nahi.
- **Boot warmup** — Laya ready/adopted hote hi EK real inference chalta hai (cold-start penalty
  boot me hi khatam). Pehla board-confirm pehle se kaafi fast.
- **SWRV confirm** — memo expire hone par bhi turant stale verdict stamp + background refresh
  (board cycle kabhi Laya ka wait nahi karta; 10-min stale cap).

**2) Optional (laptop pe NVIDIA GPU ho to — ~10-50× faster inference):**
```env
LAYA_DEVICE=auto
```
- `nvidia-smi` probe khud chalta hai — GPU mila to `cuda`, warna `cpu` (fallback safe).
- Default `cpu` hi hai — kuch nahi badla to bhi sab upar wale fixes live hain.

**3) Tuning (optional — defaults already sane):**
- `LAYA_CONCURRENCY=2` — server proven parallel ho to 3-4 try karo
- `LAYA_TIMEOUT_MS=1500` — CPU inference lambi ho to 2500-3000
- `LAYA_WARMUP=0` — warmup band karna ho
- `AI_CONFIRM_SWRV=0` — hamesha-fresh confirm (thoda slow, max accuracy)

**4) Kya verify karna (2 min):**
- [ ] Watchdog window me `[laya] warmup done (...ms)` line (pehli ready ke baad)
- [ ] OpsHealthStrip → AI chip → Laya `queueWaits` badhta hai par `breakerOpen: false` rehta hai
- [ ] Board cycle latency — AI-confirm stamps ab instant/memo-hit (stale badge nahi)

---

## 🎯 v21.4.1 — TRADING-SIGNALS DEEP-RECHECK (accuracy + accountability fixes)

**Full-site line-by-line audit se NIKLE 12+ real bugs fix — koi naya setup step NAHI hai.**
Extract → bat double-click — sab pehle jaisa (v21.4.0 ka Laya sidecar setup bhi waisa hi).

**1) Signal accuracy fixes (automatically live):**
- **CHOP FILTER ab sach me kaam karta hai** — ADX<15 read ek object-shape bug se
  DEAD tha (v21.3.0 se). Ab board + deep + expert picks teeno pe ADX padha jaata hai —
  range-bound setup ka 2R target structurally unreachable hota hai isliye grade WATCH cap.
- **DEEP-PATH HARD VETO** — board pe v21.3.0 ka counter-HTF veto tha par DEEP path
  (jahan se LIVE execute ka signal aata hai) pe nahi tha. Ek board-vetoed signal deep
  re-run pe STRONG 85 ban ke execute gauntlet pass kar sakta tha — ab nahi (board == deep == live).
- **EXPERT PICKS blanket −25 penalty hataya** — har pick ko single-voter quorum penalty
  mil rahi thi (80+ STRONG bar unreachable, sab picks WATCH + kam score). Ab 8-factor
  composite ko board quorum ladder apply nahi hoti; regime/extension/counter-tape ladders
  pehle jaisi lagti hain. **Ab 80+ STRONG picks dikh sakte hain.**
- **Expert picks ≈ CHOP chip ab render hota hai** (cap 78 + AI-confirm bump use 80+ se paar nahi).
- Board pe vetoed cards ab **WHY dikhate hain**: ⛔ HTF VETO / ≈ CHOP / 🔒 SL FLOORED chips
  (pehle card bas WATCH + score ≤62 tha bina explanation).

**2) Track-record / PnL fixes (accountability):**
- **CRYPTO × FUTURES cross-desk collision** — BTC dono desks pe track hota hai (INR spot
  + USDT perp). Purane dedup se: (a) futures rows "refresh" me swallow → zero outcome feedback,
  (b) opposite direction pe INR row USDT price pe FLIP-close → fake catastrophic PnL.
  Ab har desk ki apni row + apne domain quotes.
- **Sub-cent prices ka fake full-loss ban** — SHIB/PEPE/BONK class exits 0.00 round hoti
  thi → full-qty loss book hota tha (−₹16,600 on a ₹600 trade). Ab 4-significant-digit round.
- Tracked crypto rows cap 14 → 40 (15th row se aage kabhi evaluate nahi hote the).

**3) Feed honesty fixes:**
- USDC candle cache ab stale-prune karta hai (90s+) — frozen prices pe SL/TP evaluation band.
- Yahoo frozen-close ab apna REAL timestamp leke aata hai (fresh dikhna jhooth tha).
- Futures precheck (LIVE modal) ab wahi strict fresh-signal source use karta hai jo real
  order karega + **Leverage sanity blocking gate** (liquidation SL se pehle fire karti ho).

**4) Kya verify karna (2 min):**
- [ ] Signal board khologe → jo card WATCH me demoted ho uske chips me wajah dikhegi
- [ ] Expert Picks panel → ab 80+ STRONG picks aa sakte hain (pehle sab ~75 WATCH)
- [ ] TOP 5 me CONFLICT signals kabhi nahi (pehle se tha — locked)
- [ ] LIVE EXECUTE modal → "Leverage sanity" gate red dikhega agar lev zyada ho

---

## 🎯 v21.4.0 — LAYA SIDECAR (Watchdog ke saath Laya auto-boot)

**1) Ab `Start-SmartAI-Watchdog.bat` double-click = site + Laya dono up.**
- `.env` me bas ye line confirm karo (template me already hai):
```env
LAYA_AUTOSTART=1
LAYA_HOME=C:\laya-env
```
- Supervisor ab Laya ko bhi waise hi manage karta hai jaise site ko:
  **adopt** (pehle se chal raha ho to double nahi) → **spawn** → `/health` ready-poll →
  **hang detect** (3 fail = force-kill + restart) → **crash backoff** (5s→60s) →
  **10 restarts/hour budget pause** → **Ctrl+C par clean tree-kill** (orphan process nahi bachta).
- **Site kabhi Laya ka intezaar nahi karti** — Laya band ho to bhi site 100% normal
  (Bot Lab `laya` arm WAIT, `auto` arm Jev failover, board AI-confirm NEUTRAL).
- Watchdog window me `[laya] ...` lines = Laya ka relay output (API key kabhi nahi dikhti).

**2) Rollout (plan ke phased steps):**
- **P0 (already included):** bat me Laya start-block — `.env` me `LAYA_AUTOSTART` off ho
  ya sidecar kisi wajah se na chale, tab bhi `start "Laya AI" /min` fallback Laya chala dega
  (health-check ke baad — double start kabhi nahi).
- **P1 (already included):** supervisor-managed sidecar + full test-suite.
- **P2 — Soak 48h checklist:**
  - [ ] Bat double-click → Laya + site dono up; `[laya] READY` log dikhe
  - [ ] Haath se chalayi Laya window pehle se ho → `laya-adopted`, double process nahi
  - [ ] Task Manager me `laya-serve.exe` kill → auto-restart (~1 min)
  - [ ] Watchdog Ctrl+C → Laya bhi band (Task Manager me nahi bachna chahiye)
  - [ ] Laptop sleep→resume → dono recover
  - [ ] Laya band rehte Bot Lab `laya` arm WAIT — trading/risk gates normal
- **P3 (optional):** `Win+R` → `shell:startup` → bat ka shortcut ("Start in" = app folder).

**3) Sidecar env-knobs** (sab optional, defaults sahi hain):
`LAYA_SERVE_CMD` (exe override) · `LAYA_THREADS` (empty = physical cores − 2) ·
`LAYA_READY_TIMEOUT_MS=900000` (pehli baar weights) · `LAYA_PROBE_MS=30000` ·
`LAYA_DEVICE=cpu` · `LAYA_MODELS=english`

**4) Troubleshooting:**
- `[laya] laya-serve nahi mila (...)` → `dir C:\laya-env\Scripts\laya-serve.exe` check karo;
  path alag ho to `LAYA_HOME` (ya `LAYA_SERVE_CMD`) set karo.
- `[laya] LAYA_BASE_URL non-loopback hai — REFUSED` → security: autostart sirf 127.0.0.1.
- Windows Ctrl+C shared-console: soak me confirm karo ki Laya bhi band hua (nahi to
  Task Manager se band karo — next boot me sidecar khud handle karega).
- **Rollback:** `LAYA_AUTOSTART=0` (ya line delete) → supervisor purane behaviour par;
  Laya haath se `app\start-laya.cmd` se chalao. Site/Bot Lab code unchanged.

---

## 🎯 v21.3.0 — 7-ISSUE FIXES (server down · board accuracy · AI confirm · live pre-flight · equity prices)

**1) Server stability (Issue-1)**
- Render/free-dyno par auto-detect: memory limits + exit-on-fatal ab platform-aware. **Laptop pe koi change nahi.**
- **Render free tier 24x7 chahiye toh UptimeRobot (free) set karo → URL `https://<app>.onrender.com/api/ping`, har 5 min.** Ye code se possible nahi (Render ToS).
- `server/data/BOOT-REFUSED.txt` — agar watchdog chal raha hai par site nahi khulti, ye file reason batayegi (APP_PIN missing etc.).

**2) Signal Board accuracy (Issue-3 — "sab SL hit")**
- **HTF VETO:** 1d/4h against signal → WATCH + score ≤62. **CHOP:** range/ADX<15 → WATCH. Off karna ho: `AI_VETO_COUNTER_HTF=0`, `AI_VETO_CHOP=0`.
- **Stop floor:** SL ab kabhi 0.6×ATR se tight nahi hoga (`AI_MIN_STOP_ATR_FRACTION`).
- FUTURES/GLOBALFUTURES board signals ab **track-record** me jaate hain — Track Record panel me in desks ka win-rate ab sach me dikhega.

**3) Laya/Jev AI confirm (Issue-5)** — .env me `LAYA_ENABLED=1` + `LAYA_API_KEY` (ya `TYPESAFE_API_KEY`) hone par board ke top signals dono AI se confirm hote hain — card pe `🤖 AI ✓ (Jev ✓ · Laya ✓)` chip. Keys nahi hain toh layer silent off hai.

**4) ⚡ EXECUTE LIVE (Issue-4)** — button ab pre-flight modal kholta hai: gate checklist + would-be ticket + **1.2s hold-to-confirm**. Real order tabhi lagta hai jab poora 1.2s dabao.

**5) Equity SIM USDC (Issue-6)** — AAPL/MSFT/GOOGL ab RT fail hone par bhi CoinDCX candlestick endpoint se **24/7 perp price** lete hain (Yahoo frozen-close se pehle). Desk pe 🇺🇸 US market phase badge + FEED strip. `FINNHUB_API_KEY` (free) daalne se ek aur fallback milta hai.
---

## 🎯 v21.2.0 — LAYA + JEV DUAL-PROVIDER AI (Bot Lab)

**1) Bot Lab me ab 6 arms hain** (per-bot dropdown): `Rules / Gated / Jev / Laya / Both (consensus) / Auto`
- Jev = cloud (TYPESAFE_API_KEY) · Laya = **local, free** (tumhare laptop pe `laya-serve`)
- Consensus = dono take bolein tabhi entry · Auto = primary provider, down pe dusra
- AI sirf entry approve/veto karta hai — **side flip / sizing / SL/TP kabhi nahi**; hard risk sab se upar

**2) Laya local install (ek baar, PowerShell — repo ke bahar):**
```powershell
python -m venv laya-env ; .\laya-env\Scripts\Activate.ps1
python -m pip install "laya[serve]==<pinned>"     # pehle: pip index versions laya
$env:LAYA_DEVICE="cpu"; $env:LAYA_PRELOAD="1"; $env:LAYA_MODELS="english"
$env:LAYA_HOST="127.0.0.1"; $env:LAYA_PORT="8000"; $env:LAYA_API_KEY="<32+ char random>"
laya-serve
```
Phir `app/.env` me (naya section template me hai):
```env
LAYA_ENABLED=1
LAYA_BASE_URL=http://127.0.0.1:8000
LAYA_API_KEY=<wahi 32+ char key jo laya-serve ko di>
```
**Verify:** `node scripts/laya-ping.mjs` → `VERDICT: PASS` (choice + probabilities + latency)

**3) Kaise use kare:**
- Bot Lab kholo → bot card me arm dropdown → `LAYA (local · $0)` (ya `BOTH (consensus)` / `AUTO`)
- Laya panel (Jev panel ke side me) me model/threshold/calls/p95/rejects/breaker dikhta hai; "Local · $0"
- OpsHealthStrip me `AI: L ✓ · J ✓` chip — breaker open = red, not-configured = grey
- Arm change **bina server restart** kaam karta hai (state file me persist)

**4) Recommended rollout (PAPER pehle, hamesha):**
- `AI_SHADOW=laya` + arm=`gated` chalao → dono providers ke decisions log hote hain (trade pe zero asar) → `npm run calibrate` me per-ARM table dekho → jo arm `gated` se behtar ho tabhi uspe switch karo *(v21.11: `botlab-backtest.mjs` script retire ho chuka — per-provider analysis ledger settle-events + calibrate table se)*

**5) Troubleshooting:**
- Arm dropdown me Laya disabled + "409 provider_unavailable" → `LAYA_ENABLED`/`LAYA_API_KEY`/`laya-serve` teeno check
- `laya-ping` me 422 → payload contract mismatch (model name / criteria shape) — `LAYA_MODEL=` khaali rakho (field omit, safe default)
- Laptop band = Laya down → `auto` arm Jev pe failover karta hai; single `laya` arm WAIT (trade nahi)
- **Rollback:** `LAYA_ENABLED=0` → Laya arms `gated` pe degrade (event log me record) — jev arm + purana flow bilkul unchanged

---

## 🎯 v21.1.0 — PHASE 1-4 RELIABILITY UPGRADE (user plan implemented)

**1) LIVE trading ab GO-LIVE GATE ke peeche hai (sabse zaroori change):**
- LIVE entries tabhi fire hongi jab **PAPER track-record qualify** kare:
  100+ settled paper trades + positive expectancy + max drawdown limit ke andar.
- Dono desks (India + CoinDCX) me **STRATEGY HEALTH panel** dikhega —
  LIVE LOCKED/UNLOCKED chip + progress bar + exact counters.
- Tunable: `GO_LIVE_MIN_TRADES=100`, `GO_LIVE_MIN_EXPECTANCY_R=0`,
  `GO_LIVE_MAX_DD_R=8` (env se).
- **Per-strategy auto-pause**: kisi strategy ki rolling 30-trade expectancy
  negative ho gayi to wo khud pause ho jaati hai (naye entries honest reason
  se reject; recover hone par auto-resume). Telegram pe 🛑 notification.

**2) Naya /api/health + OPS strip:**
- Dono tabs ke top par **OPS** strip: feeds ka last-tick age, WS health,
  teeno kill layers, exec heartbeat, disk status — 30s refresh.
- Server har 60s check karta hai — koi feed 90s+ stale / WS down / kill
  arm / heartbeat gap / disk problem → **Telegram health alert** (15-min throttle).

**3) dist/ ab git me nahi aata:**
- `Start-SmartAI-Watchdog.bat` pehle hi **dist missing/stale hone par auto
  build** karta hai (`ensureFrontend`) — kuch nahi karna.
- Render deploy: **Build Command** me `npm ci && npm run build` rakho.
- GitHub pe CI (Actions) har push pe build+test verify karta hai.

**4) proxy-addr security fix:** npm audit ab **0 vulnerabilities** (pehle 1
critical IP-spoofing). Telegram-bot lockfile bhi patched.

**5) LIVE-CHECKLIST:** `app/PHASE-2-LIVE-CHECKLIST.md` kholo — real feeds,
Telegram, Dhan, Render flows ke manual test items (PASS/FAIL log ke saath).

**6) Logs kam shor karne ke liye:** `.env` me `LOG_LEVEL=warn` daal sakte ho
(sirf warnings+errors dikhen ge). Default `info` (pehle jaisa).

---

## 🎯 v21.0.6 — ADVANCE-PRO FULL AUDIT FIXES (8 major + 4 medium)

**1) Options paper trading ab aur bhi ACCURATE:**
- Paper option trades ke exits (SL/T1/T2/BE/15:10) ab **wahi LIVE premium use
  karte hain jo Options Desk pe dikhta hai** — pehle ye Black-Scholes model
  premium pe chalte the. Ab jab tak live chain (NSE/BSE/Groww) available hai,
  trade usi ke LTP pe manage hoga — desk aur engine me koi difference nahi.
- **1 lot ka trade ab T1 pe poora band NAHI hota**: pehle 1-lot trade T1 chhote
  hi 100% close ho jata tha (T2/breakeven-trail kabhi run nahi hote the).
  Ab T1 aane par SL **entry (breakeven)** pe shift ho jata hai aur runner
  T2 tak ride karta hai — jaisa card advertise karta hai.
- Auto-entry cooldown ab **per-underlying** hai (NIFTY entry se SENSEX 20 min
  nhi rukta), aur holiday pe "window open" jhooth nahi bolta.

**2) CoinDCX tab — FUTURES USDT auto-trade ab chhote wallet pe bhi:**
Paper mode me connected wallet chhota ho (₹300-500) to pehle futures entries
"margin too small" se skip ho jati thi jabki equity-sim chalta rehta tha.
Ab **paper mode me futures bhi practice equity (₹10,000) pe size hota hai** —
dono desks fair. LIVE mode me pehle jaisa wallet-floor (safety untouched).
"Sirf SPOT desk se entry hoga" wala purana message bhi hata (spot desk to
v21.0.5 me hi remove ho gaya tha).

**3) AI engines:**
- 🔬 Deep Advance Pro modal ka council ab **sach me deep model
  (deepseek-r1:14b)** pe chalta hai (pehle chip dikhata R1 tha par debate
  scan model qwen3:8b pe chalta tha).
- 👁 Vision AI failures ab board ke scan seat ko cooldown me nahi daalte.
- Vision cache ab chart-timeframe aware (15m ka verdict 1d pe serve nahi hota).

**Update kaise karein**: purane folder pe ye naya zip extract karo →
`Start-SmartAI-Watchdog.bat` chalao → browser me **Ctrl+Shift+R** (service
worker cache clear). Login badge pe **v21.0.6** dikhna chahiye.

---

## 🎯 v21.0.5 — NIFTY REALTIME FIX + COINDCX SPOT DESK HATA DIYA

**1) NIFTY options ab laptop + server dono pe REAL data:**
SENSEX wala fix (v21.0.4) ab NIFTY pe bhi lag gaya hai. Aapke laptop pe
jahan NSE seedha chalta hai wahan **`LIVE NSE CHAIN`** (volume + saari
expiries ke saath) pehle jaisa hi milega. Jahan NSE block karta hai
(VPS/Render/cloud) wahan app **Groww public mirror** se REAL NIFTY chain
serve karega — chip **`LIVE NSE CHAIN · GROWW`** (emerald). Dono paths
fail hone par hi model chain + amber banner (rare, auto-retry chalu).
BANKNIFTY/FINNIFTY waise hi sirf direct NSE pe hain.

**2) CoinDCX tab me ab sirf 2 desks:**
User spec ke hisaab se **₿ SPOT desk poori tarah remove** ho gaya hai —
desk switcher me ab sirf **⚡ GLOBAL FUTURES (USDT)** aur **🌍 EQUITY SIM**
hain (default: FUTURES). Crypto-spot wali analytics sections (Swing Desk,
Whale Radar, Orderbook, crypto Backtest/ModelPerf) bhi hata di gayi hain.
Wallet card, Execution Console, Auto-Agent, Reversal, Mesh — sab intact.
Auto-agent me ab **🌍 EQUITY SIM PICKS** strip bhi dikhti hai (agent us
desk pe bhi auto-trade karta hai).

---

## 🎯 v21.0.4 — SENSEX OPTIONS AB REAL LIVE DATA (bada fix)

**1) "SENSEX premiums are model-estimated" warning khatam — ab REAL chain:**
Pehle SENSEX options ke liye koi public live feed available nahi tha (BSE
apne datacenter IPs ko block karta hai), isliye app Black-Scholes MODEL
premiums dikha raha tha. **v21.0.4 me Groww ka public page mirror lag
gaya** — ab SENSEX desk pe:
- Chip **`LIVE BSE CHAIN · GROWW`** (teal) = real BSE premiums
- Real **LTP / OI / IV / Greeks / PCR / Max Pain / Gamma walls** (model nahi!)
- Real weekly expiry list (Thursday) + lot size 20
- Ye **datacenter/VPS pe bhi kaam karta hai** (Render/cloud deploy included)

**2) SENSEX pe warning kabhi dikhe to (rare case):**
Agar Groww mirror AUR direct BSE dono down ho jayein, tabhi honest model
chain dikhega with rose banner "auto-retry chalu rehta hai" — kuch minutes
me khud wapas live ho jata hai. Isko bina refresh ke ignore kar sakte ho.

**3) NIFTY/BANKNIFTY pe raat/weekend ko "BS MODEL" chip:**
NSE band hone pe (09:15–15:30 IST ke bahar) NIFTY-family model chain
dikhti hai (honest amber label) — market khulte hi **LIVE NSE CHAIN**
wapas. SENSEX/Groww bhi market hours me sabse fresh data deta hai.

---

## 🎯 v21.0.3 — OPTIONS + PAPER DESK + OLLAMA MODEL (kya fix hua)

**1) Options Trading abhi bhi galat dikhe to:**
NSE live chain sirf market hours (09:15–15:30 IST) me aata hai. NSE band ho
to app **honest label** ke saath Black-Scholes MODEL chain dikhata hai
("BS MODEL CHAIN — NSE BLOCKED" chip). Ye galat nahi hai — model estimate
hai. Live chain wapas aate hi chip **"LIVE NSE CHAIN"** ho jata hai aur
premiums exchange se aate hain. Expiry ab hamesha **13-Oct-2026 jaisa
sahi nearest weekly** hoga + Greeks/DTE/GEX live.

**2) Option paper trade kholo — Paper Desk me turant dikhega:**
- 🧪 PAPER TRADE button (F&O card pe) dabao → toast confirmation + **Paper
  Desk section me trade turant** (SIMPLE view me bhi — pehle sirf PRO me tha)
- NSE band ho (raat/weekend/15:00 ke baad) to naya paper entry **reject**
  hota hai with clear message — ye jaan-bujh kar hai (entries sirf live
  session me), crypto paper 24×7 chalta hai
- Max 10 open paper trades + same contract duplicate entry block

**3) Konsa Ollama model use ho raha hai — dono tabs me top par chip:**
India Intraday aur CoinDCX dono desk par ab **AI ENGINES strip** hamesha
dikhti hai. Ollama chalu ho to chip me **`QWEN3·8B ↗R1·14B`** (scan model
+ deep model) dikhta hai; hover par vision model, ctx, RAM guard, installed
models sab details. Ollama band ho to **`OLLAMA —`** (slate, honest).
🔬 deep analysis modal me "AI COUNCIL · ollama:deepseek-r1:14b" — ab
REAL model name, sirf "ollama" nahi. Model change kiya ho to **RECHECK**
button dabao (naya probe turant).

---

## 🚀 v21.0.2 — LOCAL AI (OLLAMA) SETUP (naya, 16GB laptop)

Aapke paas **Ollama + deepseek-r1:14b + qwen3:8b** already hai — bas
`app/.env` me ye lines daalo (ya .env.example se copy karo):

```env
LLM_LOCAL_ONLY=1
OLLAMA_MODEL=qwen3:8b
OLLAMA_DEEP_MODEL=deepseek-r1:14b
```

**Vision seat (optional, chart screenshot AI):**
```bash
ollama pull qwen2.5vl:7b
```
Phir chart kholo → **"👁 Vision AI"** button → screenshot ko local model
analyze karega (trend/patterns/risk verdict).

**Ollama service tuning (16GB ke liye — Windows System Environment
Variables me daalo ya `ollama serve` se pehle set karo):**
```
OLLAMA_MAX_LOADED_MODELS=1
OLLAMA_NUM_PARALLEL=1
OLLAMA_KEEP_ALIVE=5m
OLLAMA_KV_CACHE_TYPE=q8_0
```
(Isse 14B + 8B dono ek saath load NAHI honge = OOM nahi; Node server +
browser ko RAM milegi.)

**Kaise kaam karta hai**: scan/council seat = qwen3:8b (fast), deep
single-symbol analysis = deepseek-r1:14b (best reasoning), chart
screenshots = qwen2.5vl:7b (vision). Cloud keys ki zaroorat NAHI —
`LLM_LOCAL_ONLY=1` pe sab local chalta hai. Koi vision model install
na ho to bhi sab kuch chalta hai — sirf Vision AI button 503 dega.

---

## 🔔 v21.0.2 — TELEGRAM FIX (notifications nahi aa rahe the?)

4 root-causes fix hue:
1. **telegram-bot/node_modules ab watchdog khud install karta hai**
   (pehle bot crash-loop karta tha — isliye koi digest/alert nahi aata tha)
2. **Boot self-test**: har start pe getMe + test message — 401 (galat
   token) / 403 (bot ko /start nahi bheja) / 400 (galat chat id) —
   EXACT reason console me dikhega
3. **Agar bhi nahi aa rahe**: Telegram me apna bot kholo → **/start
   bhejo** (one time) → Watchdog restart karo
4. **Delivery health**: `/api/ai/insta-push/status` me `delivery` block
   (24h me kitne sent/failed + lastError)

**Localhost golden rules**: `TG_TOKEN` + `TG_CHAT_ID` DONO set karo
(aadha pair = dono silently off) · `TELEGRAM_WEBHOOK_SECRET` KHAALI
rakho (webhook mode hosted deployments ke liye hai).

---

## ✅ 30-second me chalao

1. **Node.js install karo** (ek baar, agar pehle se nahi hai)
   - https://nodejs.org se **LTS version** (v20+) download karke install karo
   - Check: `cmd` kholo → `node -v` → `v20.x.x` dikhna chahiye

2. **Zip ko kahin bhi extract karo** (e.g. `D:\SmartAI`)

3. **`app` folder ke andar jao** → **`Start-SmartAI-Watchdog.bat` double-click karo**

4. **Pehli baar** watchdog khud sab karega (internet chahiye):
   - `node_modules` install (agar missing) — 1-3 min
   - Frontend build (`vite build`) — 2-5 min
   - "frontend build COMPLETE" line dikhne tak wait karo

5. **Browser me kholo**: http://localhost:8080

6. **PIN**: `.env` file me `APP_PIN=...` likha hai (app folder me).
   `.env` nahi hai to `SETUP-v20.bat` chalao — naya PIN bana dega.

Bas. Window khuli/minimized rakho — ye anti-freeze supervisor hai,
site hang ho to khud restart karta hai.

---

## 👁 v21.0.1 — VISION AI BUTTON KAHAAN HAI? (button nahi dikh raha?)

**Vision AI button chart ke header row me hai** — `📈 SYMBOL · CANDLES` label
ke saath wahi row me (fuchsia/purple button). Ye dono jagah dikhta hai:

- **Deep Ensemble Analysis** kholo (signal card pe 🔬 button) → andar
  price chart ke upar header row me **👁 Vision AI** button
- **AI Trading board** ke signal card me 📈 PRICE CHART toggle karo →
  wahi header row me button

**Button nahi dikh raha?** Matlab browser me PURANA build chal raha hai:

1. Login screen pe dekho — **v21.0.1** likha hona chahiye (v20/v21.0.0 = purana)
2. Server window me dekho — boot pe `⚠ dist STALE` warning aayegi
3. Fix: Watchdog window **Ctrl+C** karke **`Start-SmartAI-Watchdog.bat`**
   dobara chalao (auto npm install + rebuild, 2-5 min, internet chahiye) →
   browser me **Ctrl+Shift+R** (hard refresh)
4. v21.0.1 se **dist/ ab repo me tracked hai** — `git pull` karne pe fresh
   frontend khud aa jata hai, rebuild ki zarurat sirf tab jab tumne khud
   source code badla ho

**Button click karne pe kya hota hai**: chart ka screenshot local Ollama
vision model (`qwen2.5vl:7b` — `ollama pull qwen2.5vl:7b` se install) ko
jata hai, 20-40s baad 👁 VISION VERDICT (agree/disagree + patterns + risk)
chart ke neeche dikhta hai. Vision model installed nahi hai to honest
error aata hai — fake verdict kabhi nahi.

---

## 🔄 Naya code update karo (zip/copy se) — v20.8.3 ALWAYS-LATEST

Purane folder me naye files copy/extract karo (ya naya zip usi folder pe
extract karo), phir:

1. Watchdog window me **Ctrl+C** (ya window close)
2. **`Start-SmartAI-Watchdog.bat` dobara double-click**
3. Watchdog khud pakad lega ki dist/ (frontend build) stale hai →
   **npm install + build KHUD chalega** → fresh site serve hogi
4. Browser me **F5**

**Guarantee**: `dist/.build-version` stamp vs `package.json` version —
mismatch = auto rebuild. "Purana version serve ho raha hai" wala bug
ab ho hi nahi sakta. Agar kabhi bhi browser me **red STALE-BUILD banner**
dikhe (site vA · server vB), wahi karo: Watchdog restart + F5.

---

## 🛡️ v20.9.0 — HARD RISK GATE (naya, zaroori janko)

Ye version SAPTA (Pro Trader Auto) aur Bot Lab dono ko **ek shared hard
risk gate** se guzarta hai — AI ke UPAR wale rules jo koi config override
nahi kar sakta:

| Rule | Default | Matlab |
|---|---|---|
| Daily loss halt | ₹1500 (3 x stake ₹500) | Aaj itna loss = naye entries band |
| Consecutive losses | 3 | 3 loss lagataar = aaj ke liye pause |
| Drawdown kill | 10% (peak se) | Profit peak se 10% giraya = band |
| Event-day blackout | auto | Result/RBI/FOMC din pe entries block |
| Max concurrent | 3 | Ek waqt pe 3 positions |

- **Stake clamp**: ab max ₹5,000 per trade (pehle ₹1,00,000 tha).
  Zyada chahiye? `.env` me `SAPTA_MAX_STAKE_INR=20000` likho (explicit opt-in).
- **Leverage clamp**: max 5x (pehle 10x). Override: `SAPTA_MAX_LEVERAGE=8`.
- Bot Lab env knobs: `BOT_MAX_DRAWDOWN_KILL_PCT`, `BOT_MAX_CONSECUTIVE_LOSSES`,
  `BOT_STALE_FEED_SECONDS`, `BOT_MIN_EDGE_OVER_COST_MULT` (sab clamped).
- **Regime routing** (Bot Lab): ORB sirf trend me, LVL sirf chop me.
  Band karna ho: `BOTS_REGIME_ROUTING=off`.

## 🔒 v20.9.1 — MONEY-PATH HONESTY (deep-recheck, zaroori janko)

Is version me 4th-pass full-site audit ke **~50 verified fixes** hain. Jo
aapke paisa/copy se seedha khelte hain:

- **Exchange rejection ka pakka jawab**: CoinDCX kabhi HTTP 200 ke andar
  error bhejta tha — pehle aise "close" ko success maan liya jata tha
  (journal me fake CLOSE + P&L, jabki position exchange pe khuli rehti
  thi). Ab har close/partial/entry ka verdict check hota hai (spot +
  futures + reversal teeno desks).
- **LIVE + exchange disconnected = kabhi paper-book nahi**: TP1 partial
  ke "book ho gaya" journal entries ab sirf tab banti hain jab exchange
  ne sach me qty move ki ho.
- **INR-margined futures wallet ab chalta hai**: pehle sirf USDT-leg
  ginti thi — aapke jaise INR margin wallet pe poora futures desk
  "margin < 2" jhothe reason se mar jata tha. Ab dono legs jud ke
  viability/caps dete hain.
- **paperMirror restore ab kaam karta hai**: Render wipe hone par
  browser apni history wapas bhejta tha — par mirror pehle hi wipe se
  overwrite ho jata tha (restore kabhi fire nahi hota tha). Fix ho gaya.
- **Lint gate repair**: `npm run lint` ab TSX bhi check karta hai
  (pehle 66 parse errors chhupe hue the) aur `npm run check` me wired.
- **Calibration leakage fix** (ml-service): meta-ensemble ab date-sorted
  trains hota hai (cross-symbol future-leakage band).
- **Indicators**: Supertrend ab asli trailing-band hai (pehle sirf
  "last bar up/down?" tha), RSI flat symbol pe 50 (100 nahi), stochastic
  %D sahi smoothing se.
- **Bot Lab**: orb_in ka trend-gate double-normalize bug fix (gated arm
  permanent no-trade tha); lvl ka friction ab REAL costs se (backtest
  proof: rules arm 0% win / feeDrag 53R — gate hi bachata hai);
  risk-block telegram alerts ab production me wired.
- Retired: `POST /api/ml/signals` (har symbol hardcoded HOLD-30 deta
  tha) — real signal `/api/ml/predict` se lo.

## 📊 Signal calibration (naya tool)

`npm run calibrate` — SAPTA/Bot Lab ke closed trades ka bucket report
(win-rate, Wilson lower bound, avg R per score bucket) + data-driven
threshold recommendation. **Report only** — config kabhi auto-change
nahi hota. Threshold change walk-forward validate hone ke baad hi karo.

## 💾 Daily state backup (naya)

- Manual: `npm run backup-state`
- Docker: backup sidecar automatic (14-din rotation)
- Windows Task Scheduler:
  `schtasks /create /tn "SmartAI Backup" /tr "node C:\SmartAI\app\scripts\backup-state.mjs" /sc daily /st 23:30`

## 🧪 Honest ML (v20.9.0)

`/api/ml/*` ab deterministic hai (same input = same output) aur har
response `model: "heuristic-v1"` + disclaimer carry karta hai — ye
rule-based heuristic hai, calibrated probability model NAHI. AI chat me
bhi wahi label dikhega.

---

## 🧰 Kaunsi file kya hai

| File | Kaam |
|------|------|
| `Start-SmartAI-Watchdog.bat` | **MAIN LAUNCHER** — anti-freeze supervisor + auto-install + auto-build |
| `SETUP-v20.bat` | Fresh install / in-place upgrade (backup + verify + PIN setup) |
| `Start-AutoBrowser.bat` | Pro-Trader-Auto automation browser (CDP 9222) — optional |
| `server/index.js` | Backend server (ye watchdog khud chalata hai) |
| `dist/` | Built frontend (server isi se site serve karta hai) |

**Note**: `npm start` / `npm run dev` developer flow hai — normal use ke
liye Watchdog bat kaafi hai.

## ⚠️ Common problems

- **"node nahi mila"** → Node.js install karo (step 1), ya `node.exe` ko
  app folder me rakho (portable node)
- **Port 8080 pe kuch aur chal raha hai** → `netstat -ano | findstr :8080`
  se PID nikaalo, Task Manager se band karo
- **Build fail** → Node version check karo (>= 20), internet on karo,
  Watchdog window ka output padho (`[npm]` lines me asli reason aata hai)
- **Site purani lag rahi hai** → hard refresh: `Ctrl+Shift+R` (service
  worker cache). Banner aa gaya to Watchdog restart karo.

---

## 🆕 v21.1.2 — REPORT PHASE-1 (WS-Down fix + probe + lint zero)

**IMPORTANT — 2 naya/updated kaam:**
1. **CoinDCX tab "WS DOWN" dikhe to** pehle OS strip pe hover karo — tooltip me
   `cooldownReason`/`failStreak`/`cooldownRemainMs` dikhega. Grey "N idle" = koi
   subscriber nahi (NORMAL, down nahi). WS deep-dive ke liye `/api/feed-status`
   use karo. *(v21.11: `cx-ws-probe.mjs` script retire ho chuka — OS-strip tooltip
   + feed-status wahi diagnosis dete hain)*
2. **Render deploy**: dist git me tracked HAI (deliberately — watchdog bina
   5-min rebuild ke serve kare, `ensureFrontend` sirf version-stamp mismatch
   pe rebuild karta hai). Render pe bhi Build Command `npm ci && npm run build`
   recommended hai — pushed dist se newer source ho to stamp guard khud pakad lega

**Kya naya hai:** WS idle-vs-down UI fix (armed:false = grey idle, red sirf
armed+unhealthy), `/api/health` me WS cooldown reason/streak/remaining, process
exit-listener cross-registry hardening, **eslint 128 → 0 warnings** (scope-aware
renames), 10 naye tests (3505/3505 green).

---

## 🆕 v21.1.1 — RECHECK RELEASE (advance-pro full-site audit)

**IMPORTANT — pehle ye 3 kaam karo:**
1. **Render pe Build Command**: `npm ci && npm run build` (dist ab git me nahi aata)
2. **`/api/exec/kill` disarm**: level 0 ke liye body me `{"level":0,"confirm":"CLEAR-KILL"}` bhejo (accidental disarm protect)
3. **Bot Lab / exec API users**: kill-ab "exits enforced" semantics hai — kill ON bhi SL/TP closes chalte hain (sirf naye entries block)

**Kya naya hai:** restart-safe kill levels (L1 L1 hi rehta hai — mass-flatten nahi),
futures positions ab protection-missing pe har pass TP/SL re-arm karta hai, spot dust
guard order se pehle check hota hai, India LIVE bhi go-live gate ke peeche, walk-forward
toggle Backtest panel me visible, health alerts ab idle feeds pe false nahi bajte,
watcher Telegram spam 30-min throttled, SETUP bat rollback bug fix.
**Test**: 3495/3495 green · npm audit 0 · CI har push pe verify karega.
