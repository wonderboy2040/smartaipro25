# AI Trio Verification Agents — Detailed Implementation Plan

**Status:** Phase 1 implemented — CLI bridge + sandbox + probe API + tests. Signal/scoring/execution paths untouched. Phase 2+ not started.  
**Plan version:** 1.1  
**Date:** 2026-10-25  
**Target:** `smartaipro25/app` (current baseline v21.24.0; Phase 1 adds 17 bridge tests)  
**Feature flag:** `AI_TRIO_MODE=off` by default — the existing board must behave exactly the same until the operator explicitly turns this on.

---

## 0. TL;DR (Hinglish)

Site ka current quant ensemble **source of truth** rahega. Upar se 3 bounded AI verifier agents lagenge:

1. **Momentum Guard (Fast)** — entry timing, trigger, micro-momentum, spread/extension.
2. **Structure Verifier (Deep)** — HTF structure, confluence, R:R, regime, invalidation.
3. **Risk Sentinel** — trap, opposing flow, event risk, cross-engine conflict, chart vision.

Har agent strict JSON verdict dega. Teen verdict aggregate honge:

- **2/3 ya 3/3 agree** → `CONFIRMED` → aiScore **+3** (cap 97).
- **2/3 ya 3/3 opposite/veto** → `CONFLICT` → aiScore **−8** (floor 45) + `STRONG → ACTION` demote + top-5 se exclude.
- Warna → `NEUTRAL` — koi score change nahi.

**Hard rule:** AI kabhi side, entry, SL, targets, leverage, size ya qty **nahi badlega**. Sirf verify, score, demote. Existing Jev confirm layer ke saath **mutually exclusive** chalega (double +3 nahi hoga).

Model choice:

- Local trio: `qwen3:8b` (fast) + `deepseek-r1:14b` (deep) + `qwen2.5vl:7b` (vision/sentinel).
- OpenCode free trio: `opencode/glm-5.3-flash-free` (fast) + `opencode/deepseek-v4.1-flash-free` (deep) + local `qwen2.5vl:7b` (vision) / GLM text fallback.
- Recommended default: **hybrid** — cloud-first for text reasoning, local-first for vision, automatic fallback to local/rule-based.

**OpenCode reality:** free models sirf OpenCode ke andar chalte hain. Direct HTTP API ko free models par **HTTP 403** milta hai. Isliye bridge `opencode run` CLI se banega (verified working). Paid models direct API se chal sakte hain — optional Phase 5.

**Rollout:** Phase 1 bridge + probe (no signal effects) → Phase 2 shadow logging → Phase 3 bounded effects → Phase 4 UI/status → Phase 5 paid fallback + calibration. Estimated **5–6 working days** for Phases 1–4.

### Decision summary (for approval)

| Decision | Recommendation | Why |
|---|---|---|
| Default mode | `AI_TRIO_MODE=off` | Zero behavior change until explicitly enabled |
| First live mode | `shadow` for 48–72h | Measure JSON success/latency/agreement before effects |
| Production mode | `hybrid` | Cloud reasoning + local vision + automatic fallback |
| Fast seat | `opencode/glm-5.3-flash-free` → `ollama:qwen3:8b` | Low latency, free, local fallback |
| Deep seat | `opencode/deepseek-v4.1-flash-free` → `ollama:deepseek-r1:14b` | Best reasoning per latency |
| Sentinel seat | `ollama:qwen2.5vl:7b` → `opencode/glm-5.3-flash-free` → rule | Vision stays local; text risk fallback |
| Effects | `+3` / `−8` / `NEUTRAL` | Mirrors the proven Jev layer |
| Side/SL/size changes | **Never** | Hard invariant, locked by tests |
| Jev interaction | Mutually exclusive | Prevent double `+3` |
| Render deployment | `off`/`local` or paid direct API | Free CLI is local-only |

---

## 1. What exactly are we building?

### 1.1 Three bounded verifier agents (not autonomous traders)

| Agent | Seat name | One-line mandate | Typical question |
|---|---|---|---|
| **A** | `fast` | Is the entry valid **right now**? | "Trigger fired? Momentum still alive? Too extended? Spread okay?" |
| **B** | `deep` | Is the **thesis structurally sound**? | "HTF aligned? At resistance? R:R honest? Regime supports it?" |
| **C** | `sentinel` | What can **go wrong**? | "Trap? Opposing flow? Event in 20 min? Cross-engine conflict? Chart says what?" |

Each agent is a **single LLM call with a fixed prompt and a strict JSON schema**. No tools, no browsing, no shell, no file access, no multi-step planning.

### 1.2 Hard invariants (non-negotiable)

These are enforced in code and locked by tests:

1. AI **never** changes `side`.
2. AI **never** changes `plan.entry`, `plan.stopLoss`, `plan.target1`, `plan.target2`.
3. AI **never** changes `leverage`, `size`, `qty`, `riskPerTradePct`.
4. AI **never** creates a trade or opens a position.
5. AI only:
   - adds/deducts a bounded `aiScore` amount,
   - demotes `STRONG → ACTION`,
   - sets `executable = false` on conflict,
   - stamps verification metadata for the UI.
6. If JSON is invalid, the model refuses, times out, or is unavailable → **abstain** (no effect). Never guess.
7. One AI evaluation per `(market, symbol, side, 15m bucket)` — reused by both the council vote and the confirm stamp. No double counting.

### 1.3 Why 3 agents instead of 1?

A single model asked "is this good?" tends to agree with the proposed side (anchoring). Three different mandates catch different failure modes:

- Fast catches **late entries** (price already moved).
- Deep catches **bad structure** (counter-trend, resistance, poor R:R).
- Sentinel catches **hidden risk** (trap, event, conflict).

The aggregate is deliberately conservative: one enthusiastic agent cannot confirm a trade alone; two negative agents can demote it.

### 1.4 Out of scope (do not build this by accident)

- Replacing the quant ensemble or letting AI choose the side.
- Letting AI place, size, or close orders.
- Feeding AI output into `riskPerTradePct`, leverage, or SL/target math.
- Putting live cloud calls into the MTF board's synchronous <50 ms path.
- Adding `opencode` free models to the legacy `OPENAI_COMPAT`/`councilAsk` chain (they 403).
- Training/fine-tuning on user trade data.
- Multi-step autonomous agents with tools, browsing, or shell access.

---

## 2. Reality check: OpenCode free models

### 2.1 The 403 constraint (verified)

OpenCode's free-tier chat models are only available **from inside OpenCode**. A normal HTTP client calling the inference endpoint with a free model gets:

```
POST https://opencode.ai/inference/openai/v1/chat/completions
Authorization: Bearer <key>
{ "model": "opencode/deepseek-v4.1-flash-free", ... }

→ HTTP 403
```

This is not a bug in our code. It is the documented free-tier restriction. OpenCode's Console docs state: **"Free-tier chat models require OpenCode; use paid models or Go from other clients."** Paid models and OpenCode Go work from other clients.

**Second gate (verified 2026-10-25, CLI path):** the same 403 also appears when the sandbox agent uses a wildcard deny-all rule (`{ "action": "*", "resource": "*", "effect": "deny" }`) — either at the top level of `opencode.json` or in the agent frontmatter. OpenCode's free-tier anti-abuse gate rejects that agent shape. Explicit per-action denies (`edit`, `shell`, `webfetch`, `websearch`, `subagent`, `external_directory`) pass the gate and still keep the agent tool-locked. The sandbox in §6.2 / Appendix B uses the explicit form. Symptom in the bridge: `opencode exit 1` / `provider.auth` 403 `FreeTierError`, while `opencode --version`, `models` and `auth list` still work.

**Consequence:** we cannot simply add `opencode` to `OPENAI_COMPAT` and call it with `fetch`. We need one of:

1. **CLI bridge** — `opencode run` (free, verified working, local machine only).
2. **Paid direct API** — `deepseek-v4.1-flash` / `glm-5.3-flash` with an API key (works from any client, costs money).
3. **OpenCode server API** — `opencode serve` + local HTTP API (Phase 5 optimization, more moving parts).

This plan uses **(1)** for Phases 1–4 and keeps **(2)** as an optional Phase 5 fallback.

### 2.2 Verified CLI bridge on this machine

Environment: `opencode v2.1.4`, Windows, Node v24.18.0.

Commands tested:

```powershell
opencode --version
# opencode v2.1.4

opencode models | Select-String "flash-free"
# opencode/deepseek-v4.1-flash-free
# opencode/glm-5.3-flash-free
# opencode/mimo-v2.6-flash-free
# opencode/nemotron-3.5-super-vl-free (also listed)
```

Strict-JSON smoke test (stdin prompt, no shell quoting problems):

```powershell
$p = 'Return STRICT JSON only: {"verdict":"CONFIRM|CAUTION","confidence":0-100,"reason":"<=8 words"} for BTCUSDT LONG score 78, RSI 61, ADX 24, aligned 6/8, RR 1.8. No markdown.'
$p | opencode run --format json --model opencode/deepseek-v4.1-flash-free
```

Observed result (JSONL, last `text` event):

```json
{"verdict":"CONFIRM","confidence":78,"reason":"Solid trend, moderate RSI, acceptable alignment and RR"}
```

Live bridge verification through the production code path (`probeOpenCodeSeats`, 2026-10-25):

| Seat | Model | Verdict | Latency |
|---|---|---|---|
| fast | `opencode/glm-5.3-flash-free` | `CONFIRM` 75 | 5.8 s |
| deep | `opencode/deepseek-v4.1-flash-free` | `LONG` 75 | 3.7 s |
| sentinel | `opencode/glm-5.3-flash-free` | `CLEAR` 75 | 7.2 s |

All three calls used stdin prompts, the `signal-verifier` agent, the sandbox cwd, and a secret-free child env.

### 2.3 Model smoke-test results

| Model | Result | End-to-end latency (warm CLI) | Notes |
|---|---|---|---|
| `opencode/deepseek-v4.1-flash-free` | ✅ strict JSON | ~1–3.5 s | Best deep-reasoning seat. Clean JSON. |
| `opencode/glm-5.3-flash-free` | ✅ valid JSON | ~2.3–5.7 s | Fast seat. Sometimes wraps JSON in a code fence — parser handles it. |
| `opencode/mimo-v2.6-flash-free` | ❌ refused role-play JSON prompt | — | Do not use for verification. |
| `opencode/nemotron-3.5-super-vl-free` | ⚠️ timed out at 120 s on a simple text prompt | — | Do not make it the default vision seat until a dedicated vision test passes. |

**Decision:** cloud fast = GLM, cloud deep = DeepSeek. Vision stays local (`qwen2.5vl:7b`). If cloud vision is needed later, test Nemotron VL separately with an actual chart image before enabling.

**Limited-time warning:** OpenCode's own docs describe these free models as free "for a limited time." Treat the model IDs as configuration, not as a permanent contract. The seat chains and `opencode models` probe exist so a removed model degrades to the next link instead of breaking the board.

### 2.4 What this means for deployment

| Deployment | Free OpenCode CLI | Paid direct API | Local Ollama |
|---|---|---|---|
| User's Windows laptop (current site) | ✅ works | ✅ works with key | ✅ works |
| Render / cloud container | ❌ CLI not installed | ✅ works with key | ❌ usually not available |
| CI / tests | ❌ never call real CLI | ❌ never call real API | ❌ mocked |

So:

- `AI_TRIO_MODE=hybrid` or `opencode` is a **local/self-hosted** feature.
- On Render, the same code must degrade to `local` (if Ollama exists) or `off` (existing chain).
- The bridge must **detect** the CLI at boot and report `available: false` instead of throwing.

---

## 3. Current system (as-is)

### 3.1 Signal flow (simplified)

```
Universe scan
  → 14-model quant ensemble votes
  → MTF / tape / UCV enrichment
  → aiCouncilVerify(top 6)          ← 9th ensemble vote (LLM)
  → final signal objects
  → computeTopFive / rank
  → Jev confirm layer (top 6, 75+)  ← post-board score stamp (+3 / −8)
  → board payload / UI
```

### 3.2 Existing AI layers

| Layer | File | What it does | Can it change side? |
|---|---|---|---|
| Shared provider chain | `server/ai/llmChain.js` | Cloud → local Ollama fallback; `councilAsk`, `councilAskDeep`, `councilAskVision` | No |
| Engine sentinel | `server/ai/llmSentinel.js` | Health, cooldowns, Ollama probe, MTF trio rule guard | No |
| AI Council (9th vote) | `server/ai/signals.js` → `aiCouncilVerify` | Bull/bear debate or single-shot verdict per symbol | No (one vote among many) |
| Jev confirm | `server/ai/boardAiConfirm.js` | AGREE +3, DISAGREE −8 + STRONG→ACTION | **No** (hard rule) |
| Borderline validator | `server/ai/llmValidator.js` | Second opinion only in 45–60% band | No |
| SVA checklist | `server/ai/signalVerifier.js` | Deterministic 10-point rule engine | No |
| MTF trio guard | `server/ai/llmSentinel.js` → `evaluateMtfRowWithOllamaTrio` | Sync rule-based 3-seat guard + background live note | No |

**Important:** `boardAiConfirm.js` is the pattern to copy. It already implements the exact safe effect policy we need. The new trio layer must mirror it, not invent a new risk model.

### 3.3 Exact integration points (as of v21.23.9)

| File | Line | What happens there |
|---|---|---|
| `server/ai/signals.js` | 1147 | `aiCouncilVerify(candidates, deps, market, opts)` |
| `server/ai/signals.js` | 1151 | Offline guard: `aiKeysPresent(...) || ollamaProbe()` |
| `server/ai/signals.js` | 1152 | Debate mode (3 LLM calls) |
| `server/ai/signals.js` | 1185 | Legacy single-shot `councilAsk` |
| `server/ai/signals.js` | 2122–2124 | Board calls `aiCouncilVerify(top 6)` and awaits it |
| `server/ai/signals.js` | 2732–2736 | Jev confirm block (`_boardAiConfirmActive`) |
| `server/ai/signals.js` | 2747–2758 | Final rank sort |
| `server/ai/signals.js` | 2799 | `computeTopFive` — excludes `aiConfirm.verdict === 'CONFLICT'` |
| `server/ai/boardAiConfirm.js` | 317–418 | `confirmBoardSignals` + effects |
| `server/ai/llmChain.js` | 64 | `tryParseJson` (reuse for bridge) |
| `server/ai/llmChain.js` | 88 | `askOllamaNative` (local seat) |
| `server/ai/llmChain.js` | 256 | `councilAsk` |
| `server/ai/llmSentinel.js` | 75 | `SENTINEL_PROVIDERS` |
| `server/ai/llmSentinel.js` | 318–331 | `getOllamaTrioModels` |
| `server/ai/llmSentinel.js` | 333–442 | `evaluateMtfRowWithOllamaTrio` |
| `server/ai/routes.js` | 457 | `GET /api/ai/engines` |
| `server/ai/routes.js` | 467 | `POST /api/ai/engines/recheck` |
| `server/ai/routes.js` | 479 | `GET /api/ai/status` |
| `src/components/aitrading/EngineHealthStrip.tsx` | 133–219 | Engine chips |
| `src/components/aitrading/MTFDualBoardPanel.tsx` | 636, 654, 1162 | Hardcoded "3-MODEL OLLAMA" labels |
| `src/components/aitrading/SignalCard.tsx` | 36 | `AiConfirmBadge` |
| `src/components/aitrading/types.ts` | 430, 484 | `AiProviderDecision`, `aiConfirm` shape |
| `src/components/aitrading/aiConfirmText.ts` | 32 | `ConfirmLike` (Jev only) |

---

## 4. Target architecture

### 4.1 One evaluation, two consumers

```
                    ┌──────────────────────────────────────────┐
                    │  aiTrioVerify(top 6 candidates)           │
                    │                                          │
                    │  fast seat ──┐                            │
                    │  deep seat ──┼─→ aggregate → verdicts     │
                    │  sentinel ───┘        │                   │
                    └───────────────────────┼───────────────────┘
                                            │
              ┌─────────────────────────────┴─────────────────────────────┐
              ▼                                                           ▼
   aiCouncilVerify (9th vote)                              aiTrioConfirm (post-board)
   verdicts feed the ensemble                             reads SAME cache, stamps
   exactly like today                                     CONFIRMED / CONFLICT / NEUTRAL
```

**Why this shape?**

- The council call already happens once per board cycle for the top 6. We reuse its verdicts for the confirm stamp. No second LLM bill.
- The confirm layer only reads the cache. If the cache is cold, it does nothing this cycle (next cycle is warm). This preserves the board's latency contract.
- The existing Jev layer is skipped when the trio is active, so a signal can never get +3 twice.

### 4.2 Mode matrix

| `AI_TRIO_MODE` | Council 9th vote | Confirm stamp | Board latency impact | Use case |
|---|---|---|---|---|
| `off` (default) | existing chain | existing Jev | zero | Production baseline / rollback |
| `shadow` | existing chain | existing Jev | ~0 ms (background) | 24–72h A/B logging |
| `local` | trio with Ollama seats | trio stamp | same as today's local path | Offline / zero cloud |
| `opencode` | trio with OpenCode seats | trio stamp | +2–6 s (cached, background) | Free cloud experiment |
| `hybrid` | trio with per-seat chains | trio stamp | +2–6 s (cached, background) | **Recommended** |

`shadow` never changes score/grade. It only writes `sig.aiTrioShadow` + ledger rows for comparison.

**Local mode caveat:** on a 16 GB CPU laptop, `deepseek-r1:14b` can take 2–3 minutes. `local` mode therefore uses `qwen3:8b` for the fast and sentinel text seats on the board path, and reserves R1 for the deep single-symbol path (`opts.deep`). If you want R1 on the board, expect the 4.5 s deadline to miss and the verdict to arrive via cache on the next cycle.

### 4.3 Seat chains (first healthy link wins)

Default chains:

```env
# hybrid (recommended)
AI_TRIO_FAST_CHAIN=opencode:glm-5.3-flash-free,ollama:qwen3:8b
AI_TRIO_DEEP_CHAIN=opencode:deepseek-v4.1-flash-free,ollama:deepseek-r1:14b
AI_TRIO_SENTINEL_CHAIN=ollama:qwen2.5vl:7b,opencode:glm-5.3-flash-free,rule
```

```env
# opencode-only
AI_TRIO_FAST_CHAIN=opencode:glm-5.3-flash-free,opencode:deepseek-v4.1-flash-free
AI_TRIO_DEEP_CHAIN=opencode:deepseek-v4.1-flash-free,opencode:glm-5.3-flash-free
AI_TRIO_SENTINEL_CHAIN=opencode:glm-5.3-flash-free,opencode:deepseek-v4.1-flash-free,rule
```

```env
# local-only
AI_TRIO_FAST_CHAIN=ollama:qwen3:8b
AI_TRIO_DEEP_CHAIN=ollama:deepseek-r1:14b
AI_TRIO_SENTINEL_CHAIN=ollama:qwen2.5vl:7b,rule
```

Link syntax:

- `opencode:<model-id>` — model ID **without** the `opencode/` prefix; the bridge adds it and validates against `opencode models`.
- `ollama:<model>` — must be installed; resolved via `ollamaStatus()`.
- `rule` — deterministic fallback (the existing `evaluateMtfRowWithOllamaTrio` vote math, or a simple score/flag heuristic). Always available.

Unknown/uninstalled links are skipped with a warning. If all links fail → seat abstains.

### 4.4 Model role matrix

| Seat | Local | OpenCode free | Why |
|---|---|---|---|
| Fast | `qwen3:8b` | `glm-5.3-flash-free` | Low latency, good instruction following |
| Deep | `deepseek-r1:14b` | `deepseek-v4.1-flash-free` | Best reasoning per latency |
| Sentinel (text) | `qwen3:8b` | `glm-5.3-flash-free` | Risk flags, conflict detection |
| Sentinel (vision) | `qwen2.5vl:7b` | not enabled yet | Local vision is reliable; Nemotron VL timed out |

**Local deep caveat:** `deepseek-r1:14b` can take 2–3 minutes on a 16 GB CPU laptop. It is suitable for the deep single-symbol path, **not** for a 4.5 s board confirm. Hybrid therefore uses cloud DeepSeek for the board's deep seat and keeps local R1 as an offline fallback only.

---

## 5. Agent contracts

### 5.1 Common JSON envelope

Every seat returns exactly this shape (no markdown, no prose outside JSON):

```json
{
  "verdicts": {
    "BTCUSDT": {
      "verdict": "LONG",
      "confidence": 72,
      "action": "CONFIRM",
      "risk": "CLEAR",
      "flags": [],
      "note": "trend aligned, pullback entry",
      "analysis": "Higher-timeframe trend is up and the pullback held EMA20; R:R is acceptable."
    }
  }
}
```

Field usage by seat:

| Field | Fast | Deep | Sentinel |
|---|---|---|---|
| `verdict` | optional | **required** (`LONG/SHORT/AVOID`) | optional |
| `confidence` | required 0–100 | required 0–100 | required 0–100 |
| `action` | **required** (`CONFIRM/WAIT/REJECT`) | optional | optional |
| `risk` | optional | optional | **required** (`CLEAR/CAUTION/VETO`) |
| `flags` | optional array | optional array | **required** array |
| `note` | ≤12 words | ≤12 words | ≤12 words |
| `analysis` | ≤2 sentences | ≤2 sentences | ≤2 sentences |

Allowed flags (closed set):

```
TRAP, OVEREXTENDED, LATE_ENTRY, COUNTER_TREND, EVENT_IMMINENT,
THIN_BOOK, CROSS_ENGINE_CONFLICT, OPPOSING_FLOW, NEWS_RISK, DATA_MISSING
```

Unknown flags are dropped (not trusted). `EVENT_IMMINENT`, `TRAP`, `CROSS_ENGINE_CONFLICT` are **hard flags**: they cap the aggregate at `NEUTRAL` (never `CONFIRMED`).

### 5.2 Agent A — Momentum Guard (fast)

System intent:

> You are the Momentum Guard. You do not decide the trade direction. You only judge whether the proposed entry is valid **now**. Reject late/chasing entries, dead triggers, thin books, and spreads that invalidate the plan.

Prompt skeleton:

```
You are the MOMENTUM GUARD for a trading desk.
The quant ensemble has already chosen the side. Your ONLY job: judge entry timing NOW.

For each symbol:
- Is the trigger still valid, or has price already run?
- Is momentum alive (body, volume, ROC), or exhausted?
- Is price too extended from the entry (chase)?
- Is the book/spread acceptable?

Return STRICT JSON only:
{"verdicts":{"SYM":{"action":"CONFIRM|WAIT|REJECT","confidence":0-100,"flags":[],"note":"<=12 words"}}}

Rules:
- Never change the side.
- Never invent prices or indicators not given.
- If data is missing, use action WAIT and flag DATA_MISSING.
- No markdown, no explanation outside JSON.

DATA:
<compact candidates>
```

### 5.3 Agent B — Structure Verifier (deep)

System intent:

> You are the Structure Verifier. Independently derive the best side from the data, then compare it with the proposed side. Check HTF alignment, S/R, regime, R:R, and invalidation. You may disagree.

Prompt skeleton:

```
You are the STRUCTURE VERIFIER for a trading desk.
First derive the best side from the data alone. Then compare it with the proposed side.

For each symbol check:
- Higher-timeframe trend/regime alignment.
- Price at meaningful support/resistance or mid-range?
- Is the stop behind structure, or in the noise?
- Is R:R honest after fees/slippage?
- Is the thesis confluence-driven, not single-factor?

Return STRICT JSON only:
{"verdicts":{"SYM":{"verdict":"LONG|SHORT|AVOID","confidence":0-100,"flags":[],"note":"<=12 words","analysis":"<=2 sentences"}}}

Rules:
- You may return the opposite side; that is a valid verdict.
- AVOID when the structure is unclear or R:R is poor.
- Never invent data.
- No markdown.
```

**Anchoring control:** the deep prompt receives the proposed side but explicitly asks for an independent derivation first. The aggregator uses its raw side verdict, not a "confirm/veto" label.

### 5.4 Agent C — Risk Sentinel

System intent:

> You are the Risk Sentinel. Assume the trade can fail. Find traps, opposing flow, event risk, cross-engine conflict, and data problems. You are allowed to veto, but a single veto only blocks confirmation — it does not flip the side.

Prompt skeleton:

```
You are the RISK SENTINEL for a trading desk.
Your job is to find reasons the proposed trade FAILS.

Check:
- Trap / failed breakout / stop-hunt structure.
- Opposing flow, divergence, or cross-engine conflict.
- Scheduled event or news risk in the next 60 minutes.
- Thin book / wide spread / stale data.
- Chart screenshot (if attached): does it contradict the plan?

Return STRICT JSON only:
{"verdicts":{"SYM":{"risk":"CLEAR|CAUTION|VETO","confidence":0-100,"flags":[],"note":"<=12 words"}}}

Rules:
- VETO only with a concrete reason in flags/note.
- Do not change the side or the plan.
- If data is missing, CAUTION + DATA_MISSING.
- No markdown.
```

**Vision is optional, not automatic.** The board path runs the sentinel text-only. If `opts.images` is provided (a chart screenshot from the deep/manual path), the sentinel uses the local `qwen2.5vl:7b` seat first. Images are never sent to the cloud free models by default. This keeps the board fast and avoids unpredictable multimodal latency.

### 5.5 Aggregation truth table

Map each seat to a vote for the **proposed side**:

| Seat | Output | Vote |
|---|---|---|
| Fast | `CONFIRM` | **+1** |
| Fast | `WAIT` | 0 |
| Fast | `REJECT` | **−1** |
| Deep | verdict == proposed side | **+1** |
| Deep | verdict == opposite side | **−1** |
| Deep | `AVOID` | 0 |
| Sentinel | `CLEAR` | **+1** |
| Sentinel | `CAUTION` | 0 |
| Sentinel | `VETO` | **−1** |

Aggregate:

```js
let sum = fastVote + deepVote + sentinelVote;
if (hardFlag) sum = Math.min(sum, 0);   // never CONFIRMED on a hard risk flag

if (sum >= 2)       aggregate = 'CONFIRMED';  // 2/3 or 3/3
else if (sum <= -2) aggregate = 'CONFLICT';   // 2/3 or 3/3 against
else                aggregate = 'NEUTRAL';
```

**Coverage rule:** a symbol is emitted only when **at least 2 of the 3 seats** returned a valid verdict. A single seat can never confirm or conflict. If only one seat answered, the symbol is omitted from the council verdicts and the confirm layer abstains (no effect). This prevents a lone model from moving the board.

Examples:

| Fast | Deep | Sentinel | Sum | Result |
|---|---|---|---|---|
| CONFIRM | same | CLEAR | +3 | CONFIRMED (3/3) |
| CONFIRM | same | CAUTION | +2 | CONFIRMED (2/3) |
| WAIT | same | CLEAR | +2 | CONFIRMED (2/3) |
| CONFIRM | opposite | CLEAR | +1 | NEUTRAL |
| REJECT | opposite | VETO | −3 | CONFLICT (3/3) |
| REJECT | same | VETO | −1 | NEUTRAL |
| CONFIRM | same | VETO (hard TRAP) | +1 → capped 0 | NEUTRAL |
| WAIT | AVOID | CAUTION | 0 | NEUTRAL |

Confidence:

```js
const avg = mean([fast.confidence, deep.confidence, sentinel.confidence]);
const confidence = clamp(Math.round(50 + sum * 12 + (avg - 50) * 0.25), 30, 92);
```

For the council's 9th vote:

| Sum | Council verdict |
|---|---|
| ≥ +2 | proposed side (`LONG`/`SHORT`) |
| ≤ −2 | opposite side |
| else | `AVOID` (abstain) |

This is intentionally conservative. The trio can disagree, but it cannot flip the ensemble's side; it only casts one vote.

### 5.6 Effects policy (mirrors Jev)

| Aggregate | aiScore | Grade | Other |
|---|---|---|---|
| `CONFIRMED` | **+3**, cap 97 (expert picks +2, cap 99) | unchanged | `aiConfirm.verdict = CONFIRMED`, `detail.trio = {v:'AGREE',...}` |
| `CONFLICT` | **−8**, floor 45 | `STRONG → ACTION` | `executable = false`, `aiConflict = true`, summary append `· AI-TRIO-CONFLICT (2/3 ulta)` |
| `NEUTRAL` | no change | unchanged | `aiConfirm.verdict = NEUTRAL`, `detail.trio` with honest reason |

Eligibility (same as Jev):

- top `AI_TRIO_CONFIRM_N` (default 6) signals,
- `grade` is `STRONG` or `ACTION`,
- `aiScore >= AI_TRIO_MIN_SCORE` (default 75),
- side is `LONG` or `SHORT`,
- `plan` exists with a finite entry.

Skip everything else. Never throw — the board must survive any AI failure.

---

## 6. OpenCode bridge design

### 6.1 Process invocation (stdin, not shell args)

The prompt is sent via **stdin**. This avoids Windows `cmd.exe` quoting/injection problems entirely.

```js
// server/ai/opencodeBridge.js (sketch)
import { spawn } from 'node:child_process';

// On Windows, `opencode` is a .cmd shim; spawning it directly gives EINVAL.
// Use cmd.exe with a fully controlled command string (model ID is allowlisted).
const isWin = process.platform === 'win32';
const cmd = `${OPENCODE_BIN} run --format json --model opencode/${modelId} --agent signal-verifier`;
const bin = isWin ? (process.env.ComSpec || 'cmd.exe') : OPENCODE_BIN;
const args = isWin ? ['/d', '/s', '/c', cmd] : ['run', '--format', 'json', '--model', `opencode/${modelId}`, '--agent', 'signal-verifier'];

const child = spawn(bin, args, {
  cwd: SANDBOX_DIR,
  windowsHide: true,
  env: childEnv(),                      // minimal env, no exchange keys
  stdio: ['pipe', 'pipe', 'pipe'],
});

child.stdin.end(prompt);                // prompt never touches the shell
```

Why stdin:

- `opencode run` reads the message from stdin when no message argument is present — verified on this machine (Node `spawn` + `stdin.end`, Windows, exit 0, clean JSON).
- Model IDs and agent name are from a validated allowlist, so the Windows `cmd.exe` string is safe.
- No prompt escaping, no newline problems, no `&|<>` injection.
- Avoid `shell: true` with args: Node v24 emits `DEP0190` (args are concatenated, not escaped). The `cmd.exe /d /s /c` form keeps the command string fully controlled and avoids the warning.

`OPENCODE_BIN` can override the executable:

```env
# Windows default: opencode (resolved from PATH; .cmd shim)
OPENCODE_BIN=opencode
# If PATH is unreliable:
# OPENCODE_BIN=C:\Users\<user>\AppData\Roaming\npm\opencode.cmd
```

**Sandbox path resolution:** resolve `OPENCODE_SANDBOX_DIR` relative to the module, not the process cwd:

```js
const SANDBOX_DIR = process.env.OPENCODE_SANDBOX_DIR
  ? path.resolve(process.env.OPENCODE_SANDBOX_DIR)
  : path.resolve(__dirname, 'opencode-sandbox');
```

**Shared service vs standalone:** by default `opencode run` uses the shared background service (fast, warm). If the shared service ignores the sandbox working directory or leaks another project's instructions, set `OPENCODE_STANDALONE=1` to add `--standalone` — a private server per call. It costs ~1–2 s extra but guarantees the sandbox config. Start with shared; switch only if isolation tests fail.

### 6.2 Sandbox agent (explicit denies, one step)

Create a dedicated sandbox so OpenCode never sees the trading repo:

```
app/server/ai/opencode-sandbox/
  opencode.json
  .opencode/agents/signal-verifier.md
```

`opencode.json`:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "default_agent": "signal-verifier",
  "instructions": []
}
```

`.opencode/agents/signal-verifier.md`:

```md
---
description: Bounded trade-signal verifier. No edits, no shell, no network.
mode: primary
steps: 1
permissions:
  - action: edit
    resource: "*"
    effect: deny
  - action: shell
    resource: "*"
    effect: deny
  - action: webfetch
    resource: "*"
    effect: deny
  - action: websearch
    resource: "*"
    effect: deny
  - action: subagent
    resource: "*"
    effect: deny
  - action: external_directory
    resource: "*"
    effect: deny
---

You are a bounded trade-signal verification agent.
You have no tools. You cannot read files, run commands, browse, or edit anything.
Answer only with the strict JSON object requested by the user message.
Never ask questions. Never add markdown. Never add prose outside JSON.
```

Notes:

- `steps: 1` prevents multi-step tool loops.
- Explicit per-action denies cover `edit`, `shell`, `webfetch`, `websearch`, `subagent`, `external_directory`.
- **Never use a wildcard `action: "*"` deny-all rule** — top level or agent. Verified 2026-10-25: it triggers OpenCode's free-tier 403 (`FreeTierError`). Explicit denies pass and are equally strict for the tools that matter. `read`/`glob`/`grep` stay at the base `ask` default, but `steps: 1` plus the bounded prompt means the agent answers JSON without tool calls; the probe rejects any non-JSON output.
- The sandbox has no `AGENTS.md`, no project skills, no MCP servers.
- Do **not** put a `model` in the agent file; the bridge passes `--model` per call.
- Do **not** use `--auto`.
- **Never assume the agent was applied.** If the sandbox config is not discovered, `opencode run` may fall back to the default agent. The probe must assert the JSON contract; a non-JSON/agent-chatter response is a failure, not a verdict. This is also why the bridge parses the last balanced JSON object instead of trusting the first line.

### 6.3 JSONL parser

`opencode run --format json` emits one JSON object per line. Relevant event:

```json
{"type":"text","part":{"type":"text","text":"{\"verdicts\":{...}}"}}
```

Parser rules:

1. Split stdout by lines.
2. Ignore non-JSON lines and blank lines.
3. Collect `part.text` for every `type === "text"` event, in order.
4. Join with `\n`.
5. Run `tryParseJson()` from `llmChain.js` (handles code fences, thinking blocks, trailing commas, last-balanced-object scan).
6. If `type === "error"` appears → throw a sanitized error (no prompt in the message).
7. If no text events → throw `opencode no-text`.
8. If JSON parses but the envelope is wrong → throw `opencode bad-shape`.

Do **not** take only the last text event. Some models narrate first ("Here is the JSON:") and then emit the object. Join, then parse the last balanced object.

### 6.4 Timeouts, kill tree, concurrency, rate limit

| Control | Default | Env |
|---|---|---|
| Fast seat timeout | 25 s | `OPENCODE_TIMEOUT_MS` |
| Deep seat timeout | 45 s | `OPENCODE_DEEP_TIMEOUT_MS` |
| Max concurrent CLI processes | 2 | `OPENCODE_MAX_CONCURRENCY` |
| Max calls per minute | 12 | `OPENCODE_MAX_CALLS_PER_MIN` |
| Max calls per day | 1,500 | `OPENCODE_MAX_CALLS_PER_DAY` |
| Max stdout buffer | 4 MB | `OPENCODE_MAX_BUFFER_MB` |
| Probe cache | 5 min | `OPENCODE_PROBE_TTL_MS` |

Timeout handling:

- Start a timer when the child spawns.
- On timeout: kill the **process tree**:
  - Windows: `taskkill /pid <pid> /T /F`
  - POSIX: `process.kill(-pid, 'SIGKILL')` with `detached: true`
- Reject with `opencode timeout`.
- Never leave orphan `opencode` processes.

Concurrency:

- A simple semaphore (promise queue) around the spawn.
- Two seats can run in parallel; the third waits. This keeps CPU/RAM predictable on a 16 GB laptop.
- If the queue is longer than `2 × maxConcurrency`, fail fast with `opencode busy` (abstain) instead of building a backlog.

Rate limit:

- Token bucket per minute and a daily counter persisted in memory (reset at local midnight).
- Exceeding the limit → `opencode rate-limited` → seat falls back to the next chain link.
- The daily counter is exposed in `/api/ai/trio/status`.

### 6.5 Health probe and breaker

`opencodeProbe(force = false)`:

1. `opencode --version` (2.5 s timeout) → `available`, `version`.
2. `opencode models` (5 s timeout) → parse `opencode/*` IDs; cache 10 min.
3. Optional auth check: `opencode auth list` (5 s) → `loggedIn` boolean. If the command shape differs by version, treat failure as `unknown`, not fatal.
4. Cache result for `OPENCODE_PROBE_TTL_MS` (5 min). Never call a model on every `/api/ai/engines` poll.

Breaker (per model, inside the bridge — do not couple to `llmSentinel`):

| Failure | Cooldown |
|---|---|
| 401/403 / auth | 15 min |
| 429 / rate limit | 90 s |
| timeout | 30 s → 60 s → 120 s → 300 s (2nd+ consecutive) |
| invalid JSON | 60 s (after one retry) |
| CLI missing | 5 min (then re-probe) |

`opencodeStatus()` returns:

```json
{
  "available": true,
  "bin": "opencode",
  "version": "2.1.4",
  "loggedIn": true,
  "models": ["opencode/glm-5.3-flash-free", "opencode/deepseek-v4.1-flash-free"],
  "callsToday": 42,
  "callsPerMin": 2,
  "breaker": { "glm-5.3-flash-free": { "cooldownRemainSec": 0, "lastError": null } },
  "lastProbeAgeSec": 12
}
```

### 6.6 Security checklist

- **No full `process.env` inheritance.** Child env contains only:
  `PATH`, `Path`, `HOME`, `USERPROFILE`, `APPDATA`, `LOCALAPPDATA`, `TEMP`, `TMP`, `SystemRoot`, `ComSpec`, `XDG_CONFIG_HOME`, `XDG_DATA_HOME`, `OPENCODE_*` (non-secret).
- No exchange API keys, no Telegram token, no Gemini/Groq keys in the child env.
- Prompt contains only market data + numeric indicators. No account balances, no order IDs, no keys.
- Prompt text is sanitized: strip control chars, cap length (e.g. 12k chars), reject `\0`.
- Symbol allowlist: `^[A-Z0-9._-]{2,24}$`.
- Model allowlist: `^[a-z0-9][a-z0-9.-]{1,64}$` after stripping `opencode/`.
- Agent name is hardcoded (`signal-verifier`).
- Working directory is the sandbox, never the repo root.
- Logs never include the raw prompt or full stdout; log model, latency, verdict, and a sanitized error.
- `maxBuffer` prevents a runaway model from exhausting memory.

### 6.7 Optional paid direct API (Phase 5)

Add `server/ai/opencodeDirect.js`:

```js
POST https://opencode.ai/inference/openai/v1/chat/completions
Authorization: Bearer <OPENCODE_API_KEY>
{
  "model": "deepseek-v4.1-flash",   // paid ID; verify with /v1/models
  "messages": [{ "role": "system", "content": "..." }, { "role": "user", "content": prompt }],
  "temperature": 0.2,
  "max_tokens": 1024,
  "response_format": { "type": "json_object" }
}
```

- Free model IDs (`*-free`) are rejected with 403 → never use them here.
- Paid IDs: `deepseek-v4.1-flash` ($0.30/M in, $1.20/M out), `glm-5.3-flash` ($0.15/M in, $0.50/M out).
- Add `opencodeApiKey` to `server/ai/secrets.js` (masked status only, same pattern as Gemini/Groq).
- Use this link only when `OPENCODE_API_KEY` is present and the seat chain explicitly includes `opencode-direct:<model>`.
- This is the only OpenCode path that works on Render.

---

## 7. Caching, latency, and failure handling

### 7.1 Cache key and TTL

```
key = `${market}|${symbol}|${side}|${Math.floor(now / 15min)}`
```

| Setting | Default | Env |
|---|---|---|
| Fresh TTL | 15 min | `AI_TRIO_CACHE_TTL_MS` |
| Stale-while-revalidate | 30 min | `AI_TRIO_SWR_MS` |
| Max entries | 500 | `AI_TRIO_CACHE_MAX` |
| Single-flight | on | — |

Behavior:

- Fresh hit → return instantly (0 ms).
- Stale hit within SWR → return instantly + refresh in background.
- Miss → run seats (bounded by deadline); if the deadline wins, return `null` and let the next cycle warm the cache.
- Duplicate calls for the same key share one promise (single-flight).
- Cache is in-memory only. The JSONL ledger is for audit, not for serving.

### 7.2 Soft deadline

The board must never wait for AI. Use the Jev pattern:

```js
const verdict = await Promise.race([
  aiTrioConfirm(signals, market),
  sleep(AI_TRIO_DEADLINE_MS).then(() => null), // default 4500 ms
]);
```

If the deadline wins:

- No stamp this cycle.
- The in-flight promise continues in the background and fills the cache.
- The next board cycle (60 s later) stamps from cache.

### 7.3 Fallback matrix

| Situation | Fast seat | Deep seat | Sentinel | Overall |
|---|---|---|---|---|
| OpenCode CLI missing | next link (local) | next link (local) | local vision / rule | `local`-ish |
| OpenCode timeout | next link | next link | next link / rule | partial |
| Invalid JSON | one retry, then next link | one retry, then next link | one retry, then rule | partial |
| Rate limited | next link | next link | next link / rule | partial |
| All seats fail | rule | rule | rule | `NEUTRAL` (no effect) |
| `AI_TRIO_MODE=off` | — | — | — | existing Jev only |
| Trio active but no verdict at all | — | — | — | optional Jev fallback (`AI_TRIO_FALLBACK_TO_JEV=1`) |

**Jev fallback rule:** if the trio is active but produced **zero** usable verdicts for the whole board, and `AI_TRIO_FALLBACK_TO_JEV=1` (default), run the existing Jev layer for that cycle. This keeps confirmation coverage. If the trio produced even one verdict, do not mix providers in the same cycle.

### 7.4 Circuit breaker interaction

- The trio's breaker is independent of `llmSentinel`'s cloud/Ollama breakers.
- A dead OpenCode CLI must not park Gemini/Groq/Ollama.
- A dead Ollama must not park OpenCode.
- The existing `/api/ai/engines/recheck` clears the sentinel breakers; add `opencodeProbe(true)` and `opencodeClearCooldowns()` to the same endpoint.

---

## 8. Verdict ledger and calibration

### 8.1 Record shape (JSONL)

`server/data/ai-trio-YYYY-MM-DD.jsonl`:

```json
{
  "ts": 1792873400000,
  "market": "FUTURES",
  "symbol": "BTCUSDT",
  "side": "LONG",
  "bucket": 119524893,
  "mode": "hybrid",
  "seats": {
    "fast": { "model": "opencode/glm-5.3-flash-free", "action": "CONFIRM", "confidence": 71, "flags": [], "latencyMs": 2310, "ok": true },
    "deep": { "model": "opencode/deepseek-v4.1-flash-free", "verdict": "LONG", "confidence": 78, "flags": [], "latencyMs": 3520, "ok": true },
    "sentinel": { "model": "ollama:qwen2.5vl:7b", "risk": "CAUTION", "confidence": 60, "flags": ["OVEREXTENDED"], "latencyMs": 0, "ok": false, "error": "vision model offline" }
  },
  "sum": 2,
  "aggregate": "CONFIRMED",
  "confidence": 74,
  "effects": { "scoreDelta": 3, "gradeFrom": "STRONG", "gradeTo": "STRONG", "executable": true }
}
```

Rules:

- Append-only; never rewrite.
- One line per symbol per evaluation.
- No prompts, no keys, no account data.
- Rotate daily; keep 30 days (configurable).
- Async write queue; if the disk is slow, drop oldest pending rows and increment a `dropped` counter (never block the board).

### 8.2 Calibration metrics (Phase 5)

Join ledger rows with the existing trade journal / signal ledger:

| Metric | Definition | Target |
|---|---|---|
| JSON success rate | valid JSON / calls | ≥ 98% |
| Coverage | symbols with ≥2 seat verdicts / eligible | ≥ 90% |
| p95 latency | per seat | fast < 5 s, deep < 8 s |
| Confirm precision | CONFIRMED trades that hit T1 before SL | ≥ 55% |
| Conflict value | CONFLICT trades that would have lost | ≥ 55% |
| Seat accuracy | deep side correct over N≥30 | ≥ 52% |
| Agreement with Jev | same verdict / overlapping signals | informational |

### 8.3 Auto-demote rules (optional, off by default)

`AI_TRIO_AUTOTUNE=1`:

- If a seat's JSON success rate < 90% over 50 calls → disable that model for 1 hour.
- If deep seat accuracy < 48% over 100 settled signals → demote it to shadow-only and alert.
- If a model is removed from `opencode models` → drop it from all chains immediately.
- Never auto-enable a model; only auto-disable. A human re-enables.

---

## 9. File-by-file change map

### 9.1 New files

| File | Purpose | Est. LOC | Risk |
|---|---|---|---|
| `server/ai/opencodeBridge.js` | Spawn `opencode run`, stdin prompt, JSONL parse, timeout/kill, semaphore, rate limit, probe, per-model breaker, `opencodeStatus()` | ~260 | Medium |
| `server/ai/aiTrio.js` | Mode resolution, seat chains, prompts, seat execution, normalization, aggregation, cache/SWR, `aiTrioVerify`, `aiTrioConfirm`, `trioStatus` | ~420 | High (core logic) |
| `server/ai/trioLedger.js` | Async JSONL append, daily rotation, basic stats | ~140 | Low |
| `server/ai/opencodeDirect.js` | Optional paid direct API (Phase 5) | ~120 | Low |
| `server/ai/opencode-sandbox/opencode.json` | Sandbox config (no wildcard deny) | ~12 | Low |
| `server/ai/opencode-sandbox/.opencode/agents/signal-verifier.md` | Bounded agent prompt | ~15 | Low |
| `test/opencodeBridge.test.ts` | Parser, timeout, semaphore, breaker, env isolation | ~180 | Low |
| `test/aiTrio.test.ts` | Aggregation truth table, cache/SWR, mode resolution, fallbacks | ~260 | Medium |
| `test/aiTrioEffects.test.ts` | +3/−8/demote, no side/SL/size mutation, top-5 exclusion | ~180 | High value |
| `test/aiTrioIntegration.test.ts` | `aiCouncilVerify` + `aiTrioConfirm` wiring, Jev exclusivity | ~160 | Medium |

### 9.2 Modified files

| File | Change | Risk |
|---|---|---|
| `server/ai/llmChain.js` | Export a small `askOllamaSeat(prompt, { model, deep, timeoutMs })` wrapper around `askOllamaNative`; keep `councilAsk` behavior unchanged. Export `tryParseJson` already exported. | Low |
| `server/ai/signals.js` | Import `aiTrioVerify`, `aiTrioConfirm`, `trioActive`, `trioShadow`; branch in `aiCouncilVerify`; add trio confirm block; skip Jev when trio active; attach `aiTrio` metadata. | Medium |
| `server/ai/boardAiConfirm.js` | No behavior change. Optionally export a shared `applyVerdictEffects` helper in Phase 3; otherwise trio uses its own copy. | Low |
| `server/ai/routes.js` | Add `opencode` block to `/api/ai/engines`; add `trio` block to `/api/ai/status`; add `/api/ai/trio/status`, `/api/ai/trio/probe`, `/api/ai/trio/stats`; recheck calls `opencodeProbe(true)`. | Medium |
| `server/ai/secrets.js` | Optional `opencodeApiKey` validator + masked status (Phase 5). | Low |
| `server/index.js` | Read `OPENCODE_API_KEY` only if Phase 5; do not add free models to `OPENAI_COMPAT`. | Low |
| `src/components/aitrading/EngineHealthStrip.tsx` | Render OpenCode chip from `d.opencode`; include it in the "any engine alive" logic; tooltip with models/latency/breaker. | Low |
| `src/components/aitrading/MTFDualBoardPanel.tsx` | Replace hardcoded "3-MODEL OLLAMA" with dynamic `board.aiTrio.label` / models; fallback to current text. | Low |
| `src/components/aitrading/SignalCard.tsx` | Add `trio` bit to `AiConfirmBadge` (`AI3 ✓ LONG 72%`). | Low |
| `src/components/aitrading/aiConfirmText.ts` | Extend `ConfirmLike` + `aiDirSummary` to include `trio`. | Low |
| `src/components/aitrading/LiveExecuteModal.tsx` | Show trio detail line. | Low |
| `src/components/aitrading/types.ts` | Add `trio` to `aiConfirm` and `detail`; add optional `aiTrio` / `aiTrioShadow` fields. | Low |
| `src/components/aitrading/AlertsPanel.tsx` | Read-only OpenCode status block (free tier needs no key); optional paid key field in Phase 5. | Low |
| `.env.example` | Document all `AI_TRIO_*` / `OPENCODE_*` vars; explain `LLM_LOCAL_ONLY` precedence. | Low |
| `docs/CHANGES.md` | Changelog entry per phase. | Low |

### 9.3 Exact code hooks

#### `signals.js` — council branch

```js
export async function aiCouncilVerify(candidates, deps, market, opts = {}) {
  const trioOn = trioActive(); // mode !== off && mode !== shadow

  if (!candidates?.length) return { verdicts: {}, model: null, online: false };
  if (!trioOn && !(aiKeysPresent(deps?.KEYS) || !!(await ollamaProbe().catch(() => false)))) {
    return { verdicts: {}, model: null, online: false };
  }

  if (trioOn) {
    const trio = await aiTrioVerify(candidates, { market, deep: !!opts.deep, deps }).catch(() => null);
    if (trio?.online) return trio;
    // fall through to the existing chain — never worse than today
  }

  if (councilDebateEnabled()) { /* existing */ }
  /* existing single-shot path */
}
```

#### `signals.js` — confirm block

```js
// Replace the Jev-only block with a mutually exclusive branch:
if (trioActive()) {
  try {
    aiConfirmMeta = await aiTrioConfirm(signals, mkt, { deadlineMs: AI_TRIO_DEADLINE_MS });
  } catch { /* never breaks the board */ }
  if ((!aiConfirmMeta || aiConfirmMeta.stamped === 0) && AI_TRIO_FALLBACK_TO_JEV && _boardAiConfirmActive()) {
    try { aiConfirmMeta = await _confirmBoardSignals(signals, mkt); } catch { /* noop */ }
  }
} else if (_boardAiConfirmActive()) {
  try { aiConfirmMeta = await _confirmBoardSignals(signals, mkt); } catch { /* noop */ }
}

// Shadow mode: existing Jev runs normally; trio logs in the background.
// `top` is the same top-6 candidate slice already computed above.
if (trioShadow()) {
  void aiTrioVerify(top, { market: mkt, shadow: true }).catch(() => {});
}
```

#### `signals.js` — `aiTrioConfirm` eligibility

```js
const eligible = signals
  .filter(s => s && (s.side === 'LONG' || s.side === 'SHORT'))
  .filter(s => ['STRONG', 'ACTION'].includes(String(s.grade || '').toUpperCase()))
  .filter(s => Number(s.superIntel?.aiScore ?? s.score) >= AI_TRIO_MIN_SCORE)
  .filter(s => s.plan && Number.isFinite(Number(s.plan.entry)))
  .sort((a, b) => scoreOf(b) - scoreOf(a))
  .slice(0, AI_TRIO_CONFIRM_N);
```

#### `aiTrioConfirm` cache-only behavior

```js
// Default: never trigger a live call from the post-board path.
const cached = trioVerdictFor(symbol, side, market);
if (!cached) continue; // next cycle will be warm
```

If `AI_TRIO_CONFIRM_LIVE=1`, allow at most 2 live calls for the highest-ranked signals without a cache entry.

### 9.4 Env reference

```env
# ============================================================
# AI TRIO VERIFICATION AGENTS
# ============================================================
# off | shadow | local | opencode | hybrid
# off = existing behavior (default, safe)
# shadow = log trio verdicts, never change score/grade
# local = Ollama seats only
# opencode = OpenCode free CLI seats only
# hybrid = per-seat chains below (recommended)
AI_TRIO_MODE=off

# Seat chains: comma-separated, first healthy link wins.
# opencode:<model-id> (no "opencode/" prefix)
# ollama:<installed-model>
# rule (deterministic fallback, always available)
AI_TRIO_FAST_CHAIN=opencode:glm-5.3-flash-free,ollama:qwen3:8b
AI_TRIO_DEEP_CHAIN=opencode:deepseek-v4.1-flash-free,ollama:deepseek-r1:14b
AI_TRIO_SENTINEL_CHAIN=ollama:qwen2.5vl:7b,opencode:glm-5.3-flash-free,rule

# Effects (mirror Jev)
AI_TRIO_CONFIRM_N=6
AI_TRIO_MIN_SCORE=75
AI_TRIO_CONFIRM_AGREE_BUMP=3
AI_TRIO_CONFIRM_CONFLICT_PENALTY=8
AI_TRIO_DEADLINE_MS=4500
AI_TRIO_FALLBACK_TO_JEV=1
AI_TRIO_CONFIRM_LIVE=0

# Cache
AI_TRIO_CACHE_TTL_MS=900000
AI_TRIO_SWR_MS=1800000
AI_TRIO_CACHE_MAX=500

# Ledger
AI_TRIO_LEDGER=1
AI_TRIO_LEDGER_DAYS=30
AI_TRIO_AUTOTUNE=0

# OpenCode CLI bridge
OPENCODE_BIN=opencode
OPENCODE_SANDBOX_DIR=server/ai/opencode-sandbox
OPENCODE_TIMEOUT_MS=25000
OPENCODE_DEEP_TIMEOUT_MS=45000
OPENCODE_MAX_CONCURRENCY=2
OPENCODE_MAX_CALLS_PER_MIN=12
OPENCODE_MAX_CALLS_PER_DAY=1500
OPENCODE_MAX_BUFFER_MB=4
OPENCODE_PROBE_TTL_MS=300000
# 1 = pass --standalone (private server per call; isolated but slower)
OPENCODE_STANDALONE=0

# Optional paid direct API (Phase 5; free models still 403)
# OPENCODE_API_KEY=
# OPENCODE_DIRECT_BASE=https://opencode.ai/inference/openai/v1
# OPENCODE_PAID_MODEL_FAST=glm-5.3-flash
# OPENCODE_PAID_MODEL_DEEP=deepseek-v4.1-flash
```

**Precedence with `LLM_LOCAL_ONLY`:**

- `LLM_LOCAL_ONLY=1` controls the **legacy** `councilAsk` chain only.
- `AI_TRIO_MODE=opencode|hybrid` is an explicit opt-in and **still runs** even if `LLM_LOCAL_ONLY=1`.
- If the trio falls back to the legacy chain, `LLM_LOCAL_ONLY=1` still applies there.
- Document this in `.env.example` so the two flags are not confused.

---

## 10. API and UI changes

### 10.1 Endpoints

| Method | Path | Response |
|---|---|---|
| `GET` | `/api/ai/engines` | add `opencode: opencodeStatus()` |
| `POST` | `/api/ai/engines/recheck` | also `opencodeProbe(true)` + `opencodeClearCooldowns()` |
| `GET` | `/api/ai/status` | add `trio: trioStatus()` |
| `GET` | `/api/ai/trio/status` | mode, seats, chains, cache stats, calls today, breaker |
| `POST` | `/api/ai/trio/probe` | run a tiny JSON prompt through each seat (manual setup test) |
| `GET` | `/api/ai/trio/stats?days=7` | ledger counts, JSON success, latency, agreement |

`/api/ai/trio/probe` must be rate-limited (e.g., 1 request / 10 s) and must not accept arbitrary model IDs or prompts from the browser. It uses the configured chains only.

### 10.2 EngineHealthStrip

Add a separate chip (do not force OpenCode into `SENTINEL_PROVIDERS`):

```tsx
const oc = data?.opencode;
{oc && (
  <span className={chipClassForOpencode(oc)} title={opencodeTitle(oc)}>
    {oc.available ? `OPENCODE ✓ ${oc.mode}` : 'OPENCODE —'}
  </span>
)}
```

Display:

- `OPENCODE ✓ HYBRID` (green) — CLI available, at least one model healthy.
- `OPENCODE ↻30s` (amber) — breaker cooldown.
- `OPENCODE ✗` (red) — last error.
- `OPENCODE —` (slate) — CLI not installed / not logged in.

Tooltip:

```
opencode v2.1.4 · logged in · models: glm-5.3-flash-free, deepseek-v4.1-flash-free
mode: hybrid · calls today 42/1500 · last probe 12s ago
breaker: none
```

Also update the "no engine configured" warning: OpenCode counts as a keyless engine.

### 10.3 MTF Dual Board panel

Current hardcoded text:

- Line 636: `... · 3-MODEL OLLAMA AI`
- Line 654: `🤖 3-MODEL OLLAMA TURBO: qwen3:8b + deepseek-r1:14b + qwen2.5vl:7b`
- Line 1164: `🧠 {r.ollamaTrio.honestLabel ...}`

Change to read a new payload field:

```json
"aiTrio": {
  "mode": "hybrid",
  "label": "AI TRIO · GLM + DEEPSEEK + LOCAL-VL",
  "models": ["glm-5.3-flash-free", "deepseek-v4.1-flash-free", "qwen2.5vl:7b"],
  "verdict": "2/3 CONFIRMED",
  "honest": true
}
```

Fallback to the current Ollama label when `aiTrio` is absent. This keeps old payloads and `AI_TRIO_MODE=off` visually unchanged.

**Do not** replace `evaluateMtfRowWithOllamaTrio`'s sync vote math with live cloud calls. The MTF board's <50 ms contract must stay. Phase 4 only changes labels and optionally reads the trio cache (`trioVerdictFor`) for the `liveNote`.

### 10.4 Signal card / modal

`AiConfirmBadge` currently renders only `jev`. Add:

```tsx
const bits = [
  bit('trio', 'AI3'),
  bit('jev', 'Jev'),
].filter(Boolean).join(' · ');
```

Wire shape:

```json
"aiConfirm": {
  "trio": "AGREE",
  "jev": null,
  "verdict": "CONFIRMED",
  "detail": {
    "trio": {
      "v": "AGREE",
      "picked": "enter_long",
      "pLong": 0.72,
      "pShort": 0.18,
      "pWait": 0.10,
      "confidence": 72,
      "latencyMs": 3520,
      "reason": "wait",
      "note": "trend aligned, pullback entry"
    }
  }
}
```

`aiConfirmText.ts`:

- Extend `ConfirmLike.detail` with `trio`.
- `aiDirSummary` returns lines for both `AI3` and `Jev` when present.
- Legacy payloads (no `detail.trio`) render exactly as today.

### 10.5 AlertsPanel / Settings

Add a compact read-only block:

```
🧠 AI TRIO — 3 verifier agents
[OPENCODE ✓ v2.1.4 · HYBRID] [LOCAL OLLAMA ✓ qwen3:8b]
Free tier: no key needed (CLI must be installed where the server runs).
Paid fallback: [OPENCODE API KEY] [SAVE]
```

Phase 1–4 only needs the status block. The paid key input is Phase 5.

---

## 11. Test plan

### 11.1 Unit tests

**`opencodeBridge.test.ts`**

- Parses a fixture with `step_start`, multiple `text`, `step_finish`.
- Joins multiple text events and parses the last balanced JSON.
- Handles code-fenced JSON.
- Ignores `reasoning` events.
- Throws on `type:"error"` with a sanitized message.
- Timeout kills the child and rejects with `opencode timeout`.
- Semaphore never exceeds `maxConcurrency` (use a fake spawn).
- Rate limiter returns `opencode rate-limited` after the bucket is empty.
- Child env contains no `GEMINI_API_KEY`, `GROQ_API_KEY`, `TG_TOKEN`, `COINDcx_*`.
- Model ID validation rejects `../../evil`, spaces, `;`, backticks.

**`aiTrio.test.ts`**

- Truth table: all 27 combinations of fast/deep/sentinel votes → expected aggregate.
- Hard flag caps `CONFIRMED` to `NEUTRAL`.
- Deep opposite + fast/sentinel confirm → `NEUTRAL` (sum +1).
- Deep opposite + one negative → `CONFLICT` (sum −2).
- Low confidence does not accidentally confirm.
- Missing symbol / malformed envelope → abstain.
- Mode resolution: `off`, `shadow`, `local`, `opencode`, `hybrid`.
- Chain fallback: opencode fails → ollama called; ollama fails → rule.
- Cache: fresh hit, stale SWR, single-flight, expiry.
- `AI_TRIO_MODE=off` → zero bridge calls, zero Ollama calls.

**`aiTrioEffects.test.ts`**

- CONFIRMED: +3, cap 97.
- CONFLICT: −8, floor 45, `STRONG → ACTION`, `executable=false`, `aiConflict=true`.
- NEUTRAL: no score change.
- **Immutability lock:** snapshot `side`, `plan.entry`, `plan.stopLoss`, `plan.target1`, `plan.target2`, `leverage`, `size`, `qty` before/after; assert unchanged.
- Top-5 exclusion: a CONFLICT signal is not in `computeTopFive`.
- Jev exclusivity: with trio active, `_confirmBoardSignals` is not called; with trio off, it is.

### 11.2 Integration tests

**`aiTrioIntegration.test.ts`**

- Mock `opencodeBridge` to return valid JSON; call `aiCouncilVerify` with `AI_TRIO_MODE=opencode`; assert the returned `verdicts` shape matches `aiCouncilVoteFromVerdict`.
- Call `aiTrioConfirm` with the same cache; assert `aiConfirm` stamped once, not twice.
- Mock bridge failure; assert fallback to `councilAsk` (existing chain) and board still returns.
- Mock `AI_TRIO_MODE=shadow`; assert no score/grade change and a ledger row written.
- Mock `AI_TRIO_MODE=off`; assert byte-for-byte existing behavior (same number of provider calls as the baseline test).

### 11.3 Regression gate

Run from `app/`:

```powershell
npm run typecheck
npm run lint
npm run check:version
npm test
npm run build
npm run check:routes
```

Acceptance: all existing 222 files / 4119 tests still pass, plus the new tests. `tsc` 0 errors, lint 0 errors, build succeeds, route check passes.

### 11.4 Manual acceptance checklist

- [ ] `AI_TRIO_MODE=off`: board loads, no OpenCode chip, no new calls in logs.
- [ ] `POST /api/ai/trio/probe`: each seat returns a valid verdict or an honest error.
- [ ] `AI_TRIO_MODE=shadow` for 24h: ledger rows present, zero score/grade changes, board latency unchanged.
- [ ] `AI_TRIO_MODE=hybrid`: CONFIRMED/CONFLICT badges appear; no side/SL/size changes in the payload.
- [ ] Kill the OpenCode CLI mid-cycle: board still loads; chip shows cooldown; fallback local/rule.
- [ ] Set `LLM_LOCAL_ONLY=1` + `AI_TRIO_MODE=hybrid`: trio still runs; legacy fallback stays local.
- [ ] Windows: no orphan `opencode` processes after 20 timeouts (`Get-Process opencode`).
- [ ] Browser: chip tooltip shows the correct models and mode.

---

## 12. Phased rollout

| Phase | Scope | Est. | Exit criteria |
|---|---|---|---|
| **0** | Spike + smoke tests + 403 finding (done) | 0.5 d | CLI bridge proven; model roles chosen |
| **1** | `opencodeBridge.js` + sandbox agent + `opencodeStatus()` + `/api/ai/trio/probe` + tests. **No signal integration.** | 1–1.5 d | Probe works; `AI_TRIO_MODE=off` behavior unchanged; bridge tests pass |
| **2** | `aiTrio.js` + prompts + aggregation + cache + ledger. `AI_TRIO_MODE=shadow` only. | 1 d | 24h shadow rows; zero score/grade changes; JSON success ≥98% |
| **3** | Active integration: council branch + `aiTrioConfirm` + effects + Jev exclusivity + tests. | 1–1.5 d | CONFIRMED/CONFLICT correct; immutability tests pass; top-5 exclusion works |
| **4** | UI/status: EngineHealthStrip chip, MTF label, SignalCard badge, AlertsPanel status, `.env.example`, CHANGES. | 1 d | `npm run check` green; UI shows accurate status |
| **5** | Optional: paid direct API, `opencode serve` sidecar, vision seat test, calibration/autotune, session pruning. | 1–2 d | Cost caps work; calibration report; no orphan sessions |

### 12.1 Phase 1 — Bridge only

Deliverables:

- `server/ai/opencodeBridge.js`
- `server/ai/opencode-sandbox/*`
- `GET /api/ai/engines` → `opencode` block
- `POST /api/ai/trio/probe`
- `test/opencodeBridge.test.ts`

No changes to `signals.js`, `boardAiConfirm.js`, or any scoring path. This phase is safe to ship even if the trio is never enabled.

### 12.2 Phase 2 — Shadow

Deliverables:

- `server/ai/aiTrio.js` (verify + cache + ledger)
- `server/ai/trioLedger.js`
- `test/aiTrio.test.ts`
- `AI_TRIO_MODE=shadow` branch in `signals.js` (background only)

Run for 24–72 hours. Review:

- JSON success rate per seat.
- Latency p50/p95.
- Agreement/disagreement with Jev.
- Any model refusals or timeouts.
- Whether the trio's `CONFIRMED`/`CONFLICT` labels look sane on real signals.

Do **not** enable effects until this review passes.

### 12.3 Phase 3 — Bounded effects

Deliverables:

- `aiTrioConfirm` + effects
- Jev exclusivity
- `test/aiTrioEffects.test.ts`
- `test/aiTrioIntegration.test.ts`

Enable on a small scope first:

```env
AI_TRIO_MODE=hybrid
AI_TRIO_CONFIRM_N=2
AI_TRIO_MIN_SCORE=80
```

Then widen to `N=6`, `MIN_SCORE=75` after a clean week.

### 12.4 Phase 4 — UI/status

Deliverables:

- OpenCode chip
- Dynamic MTF label
- `AI3` badge
- AlertsPanel status
- `.env.example` + CHANGES

### 12.5 Phase 5 — Optional

- Paid direct API fallback (Render-compatible).
- `opencode serve` sidecar for lower latency / fewer process spawns.
- Vision seat test with a real chart image.
- Calibration report + auto-demote.
- Session pruning script.

### 12.6 Rollback

1. Set `AI_TRIO_MODE=off` (or remove it).
2. Restart the server (env is read at boot; if the implementation reads it dynamically, no restart needed).
3. Jev confirm layer resumes automatically.
4. No data migration needed; the ledger is append-only and can be ignored.
5. If a bridge process is stuck, `taskkill /IM opencode.exe /F` on Windows (or `pkill -f "opencode run"` on POSIX). The timeout kill-tree should prevent this.

---

## 13. Cost model

### 13.1 Free tier

- OpenCode free models: **$0**.
- Constraint: only through the OpenCode CLI on a machine where OpenCode is installed and logged in.
- Unknown daily caps; the bridge's cache and call caps are the guard.
- Recommended hybrid usage: 2 cloud calls per 15-min bucket (fast + deep) + local vision = ~192 calls/day worst case, well below the 1,500/day cap.

### 13.2 Paid direct API (Phase 5 estimates)

Assumptions per board cycle (6 candidates, 3 seats):

| Seat | Input tokens | Output tokens |
|---|---|---|
| Fast (GLM) | ~1,200 | ~400 |
| Deep (DeepSeek) | ~1,500 | ~400 |
| Sentinel (GLM) | ~1,000 | ~300 |
| **Total** | **~3,700** | **~1,100** |

At 15-min cache (96 cycles/day):

| Model | Tokens/day | Cost/day | Cost/month |
|---|---|---|---|
| GLM 5.3 Flash ($0.15/M in, $0.50/M out) | ~0.21M in / 0.07M out | ~$0.065 | ~$2.00 |
| DeepSeek V4.1 Flash ($0.30/M in, $1.20/M out) | ~0.14M in / 0.04M out | ~$0.089 | ~$2.70 |
| **Total** | | **~$0.15** | **~$4.70** |

At 60-second cycles (1,440 cycles/day), multiply by ~15 → **~$2.30/day / ~$70/month**. This is why the cache and `AI_TRIO_CONFIRM_N` matter. Start with 15-min buckets and only the top 6.

These are order-of-magnitude estimates, not a billing guarantee. Real token counts depend on the prompt size, the number of candidates, and how often the cache misses. Measure the first week with the ledger before setting a budget.

### 13.3 Budget guards

```env
AI_TRIO_MAX_CALLS_PER_DAY=1500
AI_TRIO_MAX_USD_PER_DAY=2.00      # paid mode only; estimate from tokens
AI_TRIO_BUDGET_ALERT_PCT=80
```

- At 80% → log a warning + UI amber chip.
- At 100% → hard stop cloud seats; fall back to local/rule for the rest of the day.
- The counter resets at local midnight.
- Free tier: only the call caps apply.

---

## 14. Risks and mitigations

| # | Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|---|
| 1 | OpenCode free-tier policy/API changes | High | Medium | Bridge is isolated; fallback to local; pin OpenCode version; document as unofficial |
| 2 | CLI not installed on Render | High | High | `opencodeStatus.available=false`; mode `off`/`local`; paid direct API in Phase 5 |
| 3 | Model refusal / non-JSON | Medium | Medium | Strict prompt, one retry, schema validation, breaker, abstain |
| 4 | Latency spikes (CLI cold start) | Medium | Medium | Cache/SWR, soft deadline, background warm, concurrency 2 |
| 5 | Orphan `opencode` processes | Low | High | Timeout kill-tree, semaphore, `maxBuffer`, process audit test |
| 6 | Prompt injection via symbol/note | Low | High | Symbol allowlist, sanitization, explicit-deny agent, no tools, sandbox |
| 7 | Secrets leak to child process | Low | High | Minimal child env; no exchange/Telegram/LLM keys |
| 8 | Double-counting AI (+3 twice) | Medium | High | One evaluation, two consumers; Jev skipped when trio active |
| 9 | AI accidentally flips side/SL | Low | Critical | Effects-only design; immutability tests; code review |
| 10 | Calibration drift / overfitting | Medium | Medium | Shadow period, ledger, min sample, auto-demote off by default |
| 11 | Cost overrun (paid) | Medium | Medium | Daily caps, cache, top-N, local fallback, alert at 80% |
| 12 | Windows `.cmd` spawn failure | High | Medium | stdin prompt, `shell:true` with controlled args, `OPENCODE_BIN` override |
| 13 | Session data accumulation | Low | Low | Weekly prune script (Phase 5) |
| 14 | Model deprecation (`*-free`) | Medium | Medium | `opencode models` probe, env-configured chains, fallback |
| 15 | `LLM_LOCAL_ONLY` confusion | Medium | Low | Document precedence; separate `AI_TRIO_MODE` switch |

---

## 15. Acceptance criteria

A phase is done only when all of these are true:

1. `AI_TRIO_MODE=off` produces the same signal behavior as v21.23.9 (no new calls, no score changes).
2. `npm run check` is green (typecheck, lint, version, tests, build, routes).
3. New tests cover the aggregation truth table, fallback chains, cache, and immutability.
4. No AI path can mutate `side`, entry, SL, targets, leverage, size, or qty.
5. A dead OpenCode CLI, a timeout, a refusal, and invalid JSON all degrade to `NEUTRAL` without breaking the board.
6. `/api/ai/engines` shows an accurate OpenCode chip (available/cooldown/error/no-cli).
7. Shadow mode writes ledger rows but changes no score/grade.
8. Active mode stamps CONFIRMED/CONFLICT exactly once per signal per cycle.
9. A CONFLICT signal is excluded from the top-5.
10. The rollback (`AI_TRIO_MODE=off`) is documented and tested.

---

## 16. Open questions / decisions needed

1. **Free tier only, or paid fallback too?** Free = $0 but local-only and unofficial. Paid = works on Render, roughly **$5/month at 15-min cache** (see §13.2; ~$70/month at 60-second cycles). Recommend free for Phases 1–4, paid only if Render deployment is required.
2. **Where does the server run?** The OpenCode CLI must be installed on the same machine as the Node server. If the site is on Render, `hybrid`/`opencode` cannot use free models there.
3. **Shadow duration?** Recommend 48–72 hours before enabling effects. 24 hours is the minimum.
4. **Replace Jev or run both?** Recommend mutually exclusive: trio active → Jev off for the confirm stamp. Running both would double-count.
5. **Vision seat?** Keep `qwen2.5vl:7b` local for now. Test `nemotron-3.5-super-vl-free` separately with a real chart image before making it a default.
6. **MTF board integration depth?** Phase 4 only changes labels. Do not put live cloud calls in the <50 ms MTF path.
7. **Auto-demote?** Keep `AI_TRIO_AUTOTUNE=0` until there is enough settled-trade data (N≥100).

---

## Appendix A — Verified commands and outputs

### A.1 OpenCode version and models

```powershell
opencode --version
# opencode v2.1.4

opencode models | Select-String "^opencode/"
# opencode/beam-free
# opencode/big-pickle
# opencode/deepseek-v4.1-flash-free
# opencode/flint-40b-free
# opencode/glm-5.3-flash-free
# opencode/mimo-v2.6-flash-free
# opencode/nemotron-3-ultra-free
# opencode/nemotron-3.5-lightning-free
# opencode/nemotron-3.5-super-vl-free
```

### A.2 DeepSeek strict JSON (stdin)

```powershell
$p = 'Return STRICT JSON only: {"verdict":"CONFIRM|CAUTION","confidence":0-100,"reason":"<=8 words"} for BTCUSDT LONG score 78, RSI 61, ADX 24, aligned 6/8, RR 1.8. No markdown.'
$p | opencode run --format json --model opencode/deepseek-v4.1-flash-free
```

Observed `text` event:

```json
{"verdict":"CONFIRM","confidence":78,"reason":"Solid trend, moderate RSI, acceptable alignment and RR"}
```

### A.3 GLM strict JSON (stdin)

```powershell
$p = 'Return STRICT JSON only: {"verdict":"CONFIRM|CAUTION","confidence":0-100,"reason":"<=8 words"} for BTCUSDT LONG score 78, RSI 61, ADX 24, aligned 6/8, RR 1.8. No markdown.'
$p | opencode run --format json --model opencode/glm-5.3-flash-free
```

Observed `text` event:

```json
{"verdict":"CONFIRM","confidence":72,"reason":"Strong score, aligned, moderate RR"}
```

End-to-end wall time: ~2.3 s (GLM), ~3.5 s (DeepSeek) on a warm CLI.

### A.4 Direct API 403 (why we need the bridge)

```powershell
# Free model through a normal HTTP client:
POST https://opencode.ai/inference/openai/v1/chat/completions
Authorization: Bearer <key>
{"model":"opencode/deepseek-v4.1-flash-free", ...}

# → HTTP 403
```

Do not add free models to `OPENAI_COMPAT`. The CLI bridge is the supported path for free models.

---

## Appendix B — Sandbox files

### B.1 `server/ai/opencode-sandbox/opencode.json`

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "default_agent": "signal-verifier",
  "instructions": []
}
```

No wildcard deny-all rule here. Verified 2026-10-25: a top-level `{ "action": "*", "resource": "*", "effect": "deny" }` makes every free-model call fail with 403 `FreeTierError`.

### B.2 `server/ai/opencode-sandbox/.opencode/agents/signal-verifier.md`

```md
---
description: Bounded trade-signal verifier. No edits, no shell, no network.
mode: primary
steps: 1
permissions:
  - action: edit
    resource: "*"
    effect: deny
  - action: shell
    resource: "*"
    effect: deny
  - action: webfetch
    resource: "*"
    effect: deny
  - action: websearch
    resource: "*"
    effect: deny
  - action: subagent
    resource: "*"
    effect: deny
  - action: external_directory
    resource: "*"
    effect: deny
---

You are a bounded trade-signal verification agent.
You have no tools. You cannot read files, run commands, browse, or edit anything.
Answer only with the strict JSON object requested by the user message.
Never ask questions. Never add markdown. Never add prose outside JSON.
```

Agent-level wildcard deny-all also triggers the 403. Keep the explicit per-action form.

### B.3 Bridge invocation (final shape)

```js
const isWin = process.platform === 'win32';
const cmd = `${OPENCODE_BIN} run --format json --model opencode/${modelId} --agent signal-verifier`;
const bin = isWin ? (process.env.ComSpec || 'cmd.exe') : OPENCODE_BIN;
const args = isWin
  ? ['/d', '/s', '/c', cmd]
  : ['run', '--format', 'json', '--model', `opencode/${modelId}`, '--agent', 'signal-verifier'];

const child = spawn(bin, args, {
  cwd: SANDBOX_DIR,
  windowsHide: true,
  env: childEnv(),
  stdio: ['pipe', 'pipe', 'pipe'],
});

child.stdin.end(prompt);
```

---

## Appendix C — Sample aggregated verdict payload

```json
{
  "symbol": "BTCUSDT",
  "side": "LONG",
  "market": "FUTURES",
  "mode": "hybrid",
  "seats": {
    "fast": {
      "model": "opencode/glm-5.3-flash-free",
      "action": "CONFIRM",
      "confidence": 71,
      "flags": [],
      "latencyMs": 2310
    },
    "deep": {
      "model": "opencode/deepseek-v4.1-flash-free",
      "verdict": "LONG",
      "confidence": 78,
      "flags": [],
      "latencyMs": 3520
    },
    "sentinel": {
      "model": "ollama:qwen2.5vl:7b",
      "risk": "CAUTION",
      "confidence": 60,
      "flags": ["OVEREXTENDED"],
      "latencyMs": 0,
      "ok": false,
      "error": "vision model offline"
    }
  },
  "sum": 2,
  "aggregate": "CONFIRMED",
  "confidence": 74,
  "effects": {
    "scoreDelta": 3,
    "gradeFrom": "STRONG",
    "gradeTo": "STRONG",
    "executable": true
  },
  "cached": false,
  "at": 1792873400000
}
```

---

## Appendix D — Quick implementation order (for the coding session)

1. Create the sandbox files.
2. Implement `opencodeBridge.js` (spawn, stdin, parse, timeout, semaphore, probe).
3. Add `GET /api/ai/engines` → `opencode` block + `POST /api/ai/trio/probe`.
4. Write `test/opencodeBridge.test.ts`; run it.
5. Implement `aiTrio.js` prompts + normalization + aggregation (no signal wiring yet).
6. Write `test/aiTrio.test.ts`; run it.
7. Implement `trioLedger.js`.
8. Wire `aiCouncilVerify` + `aiTrioConfirm` behind `AI_TRIO_MODE`.
9. Write `test/aiTrioEffects.test.ts` + `test/aiTrioIntegration.test.ts`.
10. Add UI chip + badge + dynamic MTF label.
11. Update `.env.example` + `docs/CHANGES.md`.
12. Run `npm run check`.
13. Shadow for 48–72h; review ledger; then enable effects.

---

**End of plan.**
