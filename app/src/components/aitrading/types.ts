// ============================================================
// src/components/aitrading/types.ts — AI Trading Terminal types
// (mirrors the server/ai payload shapes 1:1)
// ============================================================

export type Side = 'LONG' | 'SHORT' | 'FLAT';
export type Grade = 'STRONG' | 'ACTION' | 'WATCH' | 'NEUTRAL';
export type MarketKind = 'INDIA' | 'CRYPTO' | 'FUTURES' | 'GLOBALFUTURES' | 'METALS'; // v10.4: global equity futures SIM desk · v21.8.0: METALS = GOLD XAU + SILVER XAG perps desk (board label — signals apne andar 'FUTURES' domain carry karte hain)

export interface ModelVote {
  id: string;
  name: string;
  role: string;
  weight: number;
  dir: number;          // -1 | 0 | +1
  conf: number;         // 0-100
  reasons: string[];
}

export interface TradePlan {
  entry: number;
  stopLoss: number;
  target1: number;
  target2: number;
  risk: number;
  riskPct: number;
  rewardRisk: number;
  atrUsed: number;
  planStyle: string;
  /** v6.4: structural ATR stop exceeded the risk cap → SL fitted to the
   *  cap and targets re-derived (honest display + audit trail). */
  riskClamped?: boolean;
  originalRiskPct?: number;
  /** v6.12: the SL sits behind a verified swing level (probrain). */
  structure?: { level: number | null; barsAgo: number | null };
  rrBelowFloor?: boolean;
  /** v21.3.0 (rendered v21.4.1): sub-noise stop floor laga tha — SL was
   *  tightened up to 0.6×ATR minimum so noise-wiggle stops don't fire.
   *  Chip renders on the card so the user knows the SL is floor-raised. */
  stopFloored?: boolean;
}

/** v6.12 PRO TRADER BRAIN — the honest quality layer on every signal:
 *  quorum, regime alignment, MTF phase, extension veto, session gate. */
export interface SignalQuality {
  quorum?: { voters: number; total: number };
  regime?: { aligned: boolean | null; counterTrend?: boolean; penaltyPct?: number };
  extension?: { veto: boolean; downgrade?: boolean };
  mtf?: { phase: string; aligned: boolean | null; available?: boolean; consensus?: string; agreementPct?: number; engine?: string };
  /** v9.3: counter-tape honesty — the 15m tape is against this trade
   *  (strong = momentum driving against it → WATCH-capped). */
  counterTape?: { strong?: boolean; ltfDir?: number };
  session?: { phase: string; tradeable: boolean };
  confAdj?: number;
  veto?: string | null;
  stopStyle?: string | null;
  reasons?: string[];
  /** v21.3.0 hard-veto stamps (rendered since v21.4.1 — pehle backend
   *  bhejta tha par UI kabhi nahi dikhati thi): counter-HTF veto = signal
   *  side 1d/4h consensus ke against → WATCH cap + aiScore ≤62. */
  counterHtfVeto?: boolean;
  /** chop filter laga — 6-TF SPLIT phase ya ADX<15 (range) → WATCH cap. */
  chopRange?: boolean;
}

/** v10.5 — one timeframe's compact tape read (5m / 15m / 1h). */
export interface MTFTapeRead {
  dir: 1 | 0 | -1;
  conf: number;
}

/** v10.5 MTF CONFLUENCE (Upgrade 1) — the 5m/15m/1h tape payload on
 *  India signals: per-TF direction + confidence and the 3-way
 *  agreement measured against the 15m trading timeframe.
 *  agreement < 0.67 → the server banned STRONG (grade cap). */
export interface MTFConfluence {
  m5: MTFTapeRead | null;
  m15: MTFTapeRead | null;
  h1: MTFTapeRead | null;
  /** matching dirs / 3 (vs the 15m anchor); null when the 15m read
   *  itself is neutral/coil. */
  agreement: number | null;
  /** v18.5 MTF-6 SUPER INTELLIGENCE — the full 6-timeframe read
   *  (1m/5m/15m/1h/4h/1d) from server/ai/mtf.js. Present on BOTH
   *  markets whenever the engine produced a read; the badge renders
   *  the 6-chip view with consensus/phase/timing when engine==='mtf6'. */
  engine?: 'mtf6';
  available?: boolean;
  tfs?: Array<{
    tf: string;
    dir: number | null;
    conf: number;
    /** v21.23.17: published vote strength (0 when structure-vetoed). */
    strength?: number;
    /** Pre-cap strength — lets the badge explain a 60% counter-structure cap. */
    rawStrength?: number | null;
    structureConflict?: boolean;
    counterStructureSuppressed?: boolean;
    reversal?: 'pump' | 'dump' | null;
  }>;
  consensus?: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
  alignment?: number;
  agreementPct?: number;
  phase?: string;
  htfBias?: 'BULLISH' | 'BEARISH' | 'NEUTRAL' | null;
  ltfTrigger?: 'BULLISH' | 'BEARISH' | 'NEUTRAL' | null;
  timing?: { quality: 'GOOD' | 'CAUTION' | 'POOR' | 'N/A'; note: string } | null;
}

/** v6.12: walk-forward edge stats (deep signal only) — the SAME
 *  ensemble replayed on recent LTF bars. Honest, disclaimer'd. */
export interface EdgeStats {
  trades: number;
  wins: number;
  losses: number;
  winRate: number | null;
  avgR: number | null;
  totalR: number;
  profitFactor: number | null;
  maxDDR: number;
  avgHoldBars: number | null;
  timeframe: string;
  bars: number;
  disclaimer: string;
}

/** v6.12: LTF (15m India / 1h crypto) indicator snapshot for MTF view. */
export interface LtfSnapshot {
  label: string;
  rsi: number | null;
  macdHist: number | null;
  ema20: number | null;
  ema50: number | null;
  atr: number | null;
}

export interface SessionPhaseInfo {
  phase: string;
  tradeable: boolean;
  note: string;
}

export interface AINote {
  verdict: string;
  note?: string;
  analysis?: string;
  model?: string | null;
}

/** v9 SUPERINTELLIGENCE PRO TRADER ENGINE — the complete trade ticket
 * that rides on every signal: entry zone + TIMING window, leverage
 * ladder (liquidation-aware), staged exit plan (40/40/20) and the EXIT
 * CLOCK (India: hard square-off; crypto: horizon-based wall-clock). */
export interface SuperIntelBlueprint {
  side: 'LONG' | 'SHORT';
  entry: number | null;
  entryZone: [number, number] | null;
  entryTiming: { mode: 'IMMEDIATE' | 'PULLBACK'; note: string } | null;
  stopLoss: number | null;
  targets: { t1: number | null; t2: number | null; t3: number | null };
  leverage: number;
  maxSaneLeverage: number;
  liquidation: number | null;
  leverageNote: string;
  exitPlan: { at: number | null; bookPct: number; action: string }[];
  exitBy: string;
  horizon: { label: string; hours: number; note: string };
  invalidation: string;
}

export interface SuperIntelFactor {
  key: string;
  label: string;
  value: number;
  weight: number;
}

/** v12.0 WIN-PROBABILITY ENGINE — the calibrated P(win) answer on every
 * scored signal: prior from the AI score, corrected by the signal
 * ledger's settled outcomes (trust calibration + LONG/SHORT split),
 * funding/positioning on perps, MTF confluence. P(need) = the R:R
 * breakeven; EDGE = pWin − pNeed; EV in R-multiples with a realistic
 * partial-book haircut. Hard-capped at 92% — never certainty. */
export interface WinProbView {
  pWin: number;
  pWinBand: [number, number];
  pNeed: number;
  edgePts: number;
  evR: number;
  evRealisticR: number;
  verdict: 'EDGE' | 'FAIR' | 'NO-EDGE';
  calibrated: boolean;
  drivers: string[];
  note: string;
}

/** v12.0 PERP POSITIONING INTELLIGENCE (wire payload) — funding /
 * open-interest 24h change / top-trader L-S ratio / taker aggression
 * + the derived positioning read. Binance fapi public reference. */
export interface PerpIntelWire {
  pair: string;
  markPrice: number | null;
  fundingBps8h: number | null;
  nextFundingTs: number | null;
  openInterest: number | null;
  oiValueUSDT: number | null;
  oiChangePct24h: number | null;
  change24hPct: number | null;
  topLongShortRatio: number | null;
  takerRatio24h: number | null;
  read: {
    bias: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
    score: number;
    label: string;
    matrix: 'LONGS_BUILDING' | 'SHORTS_BUILDING' | 'SHORT_SQUEEZE' | 'LONG_UNWIND' | 'FLAT' | null;
    crowdedLongs: boolean;
    crowdedShorts: boolean;
    confidence: 'full' | 'partial' | 'thin';
    reasons: string[];
  } | null;
}

/** The composite AI SCORE (0-100): engine conviction × 7-factor expert
 * score × AI verdict, with the honest quality adjustments baked in.
 * Tier ladder: 85+ ELITE · 80+ STRONG (the desk's "80+" bar) · 65+ ACTION.
 * v12.0: + winProb (the calibrated P(win) + EV block) and perp (the
 * positioning intel wire payload on FUTURES signals). */
export interface SuperIntel {
  aiScore: number;
  tier: 'ELITE' | 'STRONG' | 'ACTION' | 'WATCH' | 'NEUTRAL';
  drivers: string[];
  factors?: SuperIntelFactor[] | null;
  blueprint: SuperIntelBlueprint | null;
  winProb?: WinProbView | null;
  perp?: PerpIntelWire | null;
}

// ---------------- v13.1 SIGNAL VERIFICATION AGENT (SVA-v1) ----------------
/** The senior pro-trader second opinion on a signal: a 10-point
 *  weighted checklist aggregated into ONE final call. Deep payloads
 *  carry the full checklist; board/manual stamps carry the compact
 *  wire (fails/warns instead of the array). */
export interface SignalVerification {
  agent: string;
  /** CONFIRM | CAUTION | FLIP | STAND_ASIDE */
  action: 'CONFIRM' | 'CAUTION' | 'FLIP' | 'STAND_ASIDE' | string;
  /** THE answer: LONG / SHORT / NO_TRADE (FLIP → opposite of side). */
  finalCall: 'LONG' | 'SHORT' | 'NO_TRADE' | string;
  /** 0-100 verification score. */
  score: number;
  /** pro-veto: chase HARD + RSI-extreme combo (the XRP-class burn). */
  veto?: boolean;
  /** 0 = no entry · 0.5 = half risk · 1 = full risk. */
  sizeHint?: number;
  /** opposite-side case strength (only when meaningful, ≥50). */
  flipScore?: number | null;
  /** one-line verdict (Hinglish). */
  verdict?: string;
  /** full checklist — deep payloads only. */
  checklist?: Array<{
    id: string; name: string;
    status: 'PASS' | 'WARN' | 'FAIL' | string;
    weight: number; points: number; detail: string;
  }>;
  /** compact wire: FAIL check ids + WARN count. */
  fails?: string[];
  warns?: number;
  proNote?: string;
  checkedAt?: number;
  /** v13.2 A2: the LLM second opinion — present ONLY on borderline
   *  (45-60% conf) signals, one ask per symbol per 15m candle.
   *  verdict CONFIRM / REJECT / FLIP + the provider's one-liner. */
  llm?: {
    verdict: 'CONFIRM' | 'REJECT' | 'FLIP' | string;
    confidence: number;
    reason: string;
    model: string | null;
    ts: number;
  };
}

/** v9: board-level Superintelligence meta — what got scanned, through
 * which price chain, how many signals cleared 80+/85+. */
export interface SuperIntelMeta {
  engine: string;
  universeSize: number;
  universeMode: string;
  priceSource: string | null;
  strongCount?: number;
  eliteCount?: number;
  scored?: number;
}

// ---------------- v20.9.2 ULTRAFAST CHART VERIFICATION (UCV-A1) ----------------
/** The deep AI superintelligence agent's verdict on the REALTIME
 *  ultrafast 1m chart: "ye LONG pakka long jayega? ye SHORT pakka
 *  short jayega?" Stamped on every 80+ AI-score / STRONG board
 *  signal + every deep-dive payload. REJECTED = the micro chart is
 *  actively moving AGAINST the signal (the direction-mismatch fix:
 *  aiScore capped 64 + grade demoted server-side). */
export interface UltrafastVerification {
  agent: string;
  /** CONFIRMED (direction verified) | PENDING (neutral/no data) | REJECTED (micro chart against). */
  verdict: 'CONFIRMED' | 'PENDING' | 'REJECTED' | string;
  confirmed: boolean;
  /** The realtime ultrafast chart's own direction: UP / DOWN / FLAT. */
  microDirection: 'UP' | 'DOWN' | 'FLAT' | string;
  /** |microScore| 0-100 — how hard the 1m tape is moving. */
  score: number;
  /** The direct Hinglish answer ("⚡ LONG PAKKA long — ultrafast chart UP hai"). */
  answer: string;
  /** micro read summary ("micro DOWN (−48/100 · 1 bull / 6 bear checks)"). */
  detail?: string | null;
  /** last-5m tape move % (null = unavailable). */
  momentumPct?: number | null;
  /** 1m bars the read is built on. */
  bars?: number;
  checkedAt?: number;
  /** FULL payloads (deep path) carry the 9-check micro checklist. */
  checks?: Array<{ id: string; label: string; status: string; detail: string }>;
  ownScore?: number;
  aiScoreAtCheck?: number | null;
  gradeAtCheck?: string | null;
}

// ---------------- v11.0 GLOBAL MARKET COUNCIL ----------------
/** One specialist seat's vote on the wire (compact). */
export interface CouncilAgentVote {
  role: string;
  name: string;
  direction: 'LONG' | 'SHORT' | 'NEUTRAL' | string;
  confidence: number;
}

/** The per-signal council stamp (board + deep paths). */
export interface CouncilStamp {
  model: string | null;
  freshness: 'live' | 'cached' | 'model' | string;
  direction: 'LONG' | 'SHORT' | 'NEUTRAL' | string;
  confidence: number;
  agreement: number;
  quorum: number;
  gate: 'PASSED' | 'SUPPRESSED' | string | null;
  /** v11.0.1: the gate's ACTUAL confidence bar (env-tuned + auto-tighten
   *  aware) — the UI marker used to hardcode 78 and could lie. */
  gateBar?: number | null;
  gateReasons: string[];
  eventHaircut?: number | null;
  agents: CouncilAgentVote[];
  agentReasons?: { role: string; reasons: string[]; veto?: string | null }[];
  levels?: { entry: number | null; stop: number | null; t1: number | null } | null;
  weightsUsed?: Record<string, number> | null;
  divergence?: { symbol: string; spreadPct: number; agents: string[]; degraded: boolean } | null;
  debate?: { bull: string | null; bear: string | null; judge: string | null; favours?: string | null } | null;
  nearMiss?: boolean;
  generatedAt: number;
}

/** Board-level council meta (payload.council). */
export interface CouncilBoardMeta {
  enabled: boolean;
  flag?: string;
  model?: string | null;
  stamped?: number;
  passed?: number;
  suppressed?: number;
  gate?: Record<string, number>;
  note?: string;
}

/** GET /api/ai/council/status view. */
export interface CouncilStatusView {
  ok: boolean;
  enabled: boolean;
  flag: string;
  debateRounds: number;
  roles: { id: string; name: string; baseWeight: number }[];
  gate: Record<string, number>;
  verdictCache: { entries: number; ttl: number; cap: number };
  nearMiss?: { total: number; last24h: number; byReason: [string, number][] };
  note?: string;
}

/** GET /api/ai/council/near-miss entry. */
export interface NearMissEntry {
  id: string;
  ts: number;
  market: string;
  symbol: string;
  side: string;
  score: number;
  confidence: number;
  agreement: number;
  quorum: number;
  gateReasons: string[];
  voters: CouncilAgentVote[];
  levels?: { entry: number | null; stop: number | null; t1: number | null } | null;
  plan?: { entry: number | null; stopLoss: number | null; target1: number | null } | null;
  regime?: string | null;
  model?: string | null;
}

/** GET /api/ai/council/calibration view (per-agent rows). */
export interface CouncilCalibrationView {
  ok: boolean;
  settled: number;
  sufficient: boolean;
  precision?: number | null;
  precision90d?: number | null;
  n90d?: number | null;
  brier?: number | null;
  brierVerdict?: string;
  agents?: {
    role: string;
    n: number;
    hitRate: number | null;
    wins: number;
    losses: number;
    directionSplit?: { LONG: { n: number; winRate: number | null }; SHORT: { n: number; winRate: number | null } };
  }[];
  weights?: Record<string, { mul: number; n: number; posterior: number | null; hitRate: number | null }>;
  note?: string;
}

/** v21.11.0 — per-provider AI decision detail (boardAiConfirm wire).
 *  `picked` = the side the provider ACTUALLY chose (enter_long/enter_short
 *  — null when the provider genuinely waited / errored); pLong/pShort/pWait
 *  = its probability split (0..1); `reason` = honest short bucket
 *  (wait / below-thr / slow / breaker / down / timeout / net-err …). */
export type AiProviderDecision = {
  v: 'AGREE' | 'DISAGREE' | 'NEUTRAL';
  picked: 'enter_long' | 'enter_short' | null;
  pLong: number | null;
  pShort: number | null;
  pWait: number | null;
  confidence: number | null;
  note: string | null;
  latencyMs: number | null;
  cached: boolean | null;
  reason: string;
};

export interface AISignal {
  symbol: string;
  market: MarketKind;
  side: Side;
  grade: Grade;
  confidence: number;
  agreement: number;
  participation?: number | null; // v6.3: voting-weight quorum (0-1)
  participating: number;
  /** v6.12: models that actually cast a non-abstain vote. */
  voters?: number | null;
  totalModels: number;
  bullWeight?: number | null;
  bearWeight?: number | null;
  ltp: number | null;
  changePct: number | null;
  plan: TradePlan | null;
  /** v6.12 PRO TRADER BRAIN: quorum/regime/MTF/extension/session verdict. */
  quality?: SignalQuality | null;
  /** v9 SUPERINTELLIGENCE: AI SCORE (0-100) + the full trade blueprint. */
  superIntel?: SuperIntel | null;
  /** v13.1 SIGNAL VERIFICATION AGENT: the pro-trader final verdict
   *  (compact on board signals, full checklist on deep payloads). */
  verify?: SignalVerification | null;
  /** v20.9.2 ULTRAFAST CHART VERIFICATION AGENT (UCV-A1): the realtime
   *  1m-chart direction verdict — "LONG pakka long jayega?". Stamped on
   *  80+ AI-score / STRONG signals; REJECTED ones are already demoted
   *  (aiScore ≤ 64, grade WATCH) server-side before they reach the card. */
  ultrafast?: UltrafastVerification | null;
  /** v10.5 MTF CONFLUENCE: the 5m/15m/1h tape read (India signals,
   *  AI_ENABLE_MTF_CONFLUENCE=true). agreement < 0.67 → the server
   *  already banned STRONG; the badge makes the conflict visible. */
  mtf?: MTFConfluence | null;
  /** v21.3.0 (Issue-5) lineage — JEV AI CONFIRMATION: the provider
   *  verdict on this signal: AGREE → CONFIRMED (+3 aiScore); provider
   *  ulta side → CONFLICT (−8 + STRONG→ACTION). NEUTRAL = abstain/wait.
   *  Present only when the provider is configured (AI_BOARD_CONFIRM).
   *  v21.11.0: `detail` me provider ka RAW decision milta hai — picked
   *  side (LONG/SHORT), probabilities (pLong/pShort/pWait), confidence,
   *  aur honest reason (wait / below-thr / slow / breaker / down).
   *  v21.14.0: Laya removed — jev-only. */
  aiConfirm?: {
    jev: 'AGREE' | 'DISAGREE' | 'NEUTRAL' | null;
    verdict: 'CONFIRMED' | 'CONFLICT' | 'NEUTRAL';
    at?: number;
    /** v21.5.0: SWRV serve — verdict 2×TTL ke andar ka purana stamp hai
     *  (instant serve + background refresh). Confirm layer sirf score ±
     *  karta hai isliye 5-min-stale acceptable; UI isko internal
     *  telemetry maan sakta hai (abhi koi visual badge nahi). */
    stale?: boolean;
    /** v21.11.0: per-provider decision detail (direction transparency). */
    detail?: {
      jev?: AiProviderDecision | null;
    } | null;
  } | null;
  /** v10.15 GAP 2 EVENT GUARD: the next scheduled event for this
   *  symbol/desk (⚠ Earnings in 2h / ⚠ FOMC 30m) — same truth the
   *  auto-agent's entry gauntlet vets entries against. */
  event?: {
    kind: string;
    label: string;
    inMin: number;
    approximate?: boolean;
    blocked?: boolean;
    haircut?: number | null;
  } | null;
  /** v11.0 GLOBAL MARKET COUNCIL stamp (AI_ENABLE_GLOBAL_COUNCIL):
   *  6 specialist seats' weighted verdict + precision-gate decision.
   *  Analysis layer — execution authority stays with the gauntlets. */
  council?: CouncilStamp | null;
  /** v12.4 SIGNAL AGE — how long ago the AI FIRST called this
   *  direction (firstSeenAt, client-computed live) + last board
   *  confirmation + 24h flip count. Answers "ye signal kitna purana
   *  hai?" before you enter on it. */
  signalAge?: {
    /** epoch ms when this side's signal first appeared */
    firstSeenAt: number;
    /** epoch ms of the last board cycle that confirmed this side */
    lastSeenAt: number;
    /** server-computed age snapshot (ms) — client recomputes from firstSeenAt for a live tick */
    ageMs: number;
    /** direction flips in the last 24h (whipsaw thermometer) */
    flips24h: number;
  } | null;
  /** v12.4 OB/OS GUARD — the overbought/oversold suppression verdict:
   *  a LONG card at RSI ≥ 70 (SHORT at RSI ≤ 30) is grade-capped to
   *  WATCH and confidence-floored — chase protection. */
  obOs?: { tag: 'OVERBOUGHT' | 'OVERSOLD'; rsi: number; extreme?: boolean } | null;
  /** v12.4 FLIP COOLDOWN — the side JUST flipped (< 5m): unstable,
   *  grade capped to WATCH. The anti-whipsaw verdict. */
  freshFlip?: { from: string; to: string; ageSec: number } | null;
  /** v12.5 CHASE GUARD — the structural extension verdict (the
   *  "direction galat" fix): price stretched N×ATR from its mean
   *  (EMA20 / session VWAP on India) and/or a vertical one-way candle
   *  run. HARD → entry suppressed (grade WATCH + conf cap); SOFT →
   *  haircut (retrace entry better). Never flips the side. */
  chasing?: {
    side: string;
    extAtr: number | null;
    ref: string | null;
    runBars: number;
    runAtr: number | null;
    severity: 'HARD' | 'SOFT' | null;
    reason: string | null;
  } | null;
  /** v12.6 entry-quality band — PULLBACK (boost) / EXTENDED (haircut) */
  entryQuality?: {
    band: 'PULLBACK' | 'EXTENDED';
    extAtr: number | null;
    ref: string | null;
    note: string | null;
  } | null;
  /** v12.4 HOLDING — an OPEN position exists on this symbol (journal
   *  auto/desk trades + manual tracker): the card is the live context
   *  for money already on the line. */
  holding?: {
    side: string;
    entryPrice: number | null;
    qty: number;
    mode: string | null;
    source: string | null;
    openedAt: number | null;
    via: string;
    ageMs?: number;
  } | null;
  /** v12.4 — true when this card EXISTS only because an open position
   *  pinned it back onto the board (it fell out of the top-N cut). */
  holdingOnly?: boolean;
  /** v12.7 — the AI's CURRENT directional view on a pinned holding card
   *  (can be the OPPOSITE of the position side — the card's own side is
   *  the POSITION side; this view renders as a sub-chip so a held LONG
   *  can never display as a SHORT card). */
  aiView?: {
    side: 'LONG' | 'SHORT';
    grade: string | null;
    conf: number | null;
    fresh: boolean;
  } | null;
  votes: ModelVote[];
  summary: string;
  aiNote: AINote | null;
  executable: boolean;
  /** v21.23.4 — data-degradation stamp. "FRESH-TAPE-ABSENT": 15m fresh
   *  tape missing, committee sirf lagging 1h trend seats se bana
   *  (replay-proven 29% WR degenerate mode) — auto-trade BLOCKED,
   *  sirf reference signal. "INTRADAY-TF-UNAVAILABLE": aise signals
   *  board se hi REMOVE hote hain (yahan kabhi nahi aane chahiye —
   *  agar aaya to server/client version mismatch hai). */
  dataDegraded?: string | null;
  /** v21.23.4 — the human-readable reason chip text for dataDegraded. */
  degradedReason?: string | null;
  generatedAt: number;
}

export interface ModelStatusRow {
  id: string;
  name: string;
  role: string;
  weight: number;
  online: boolean;
  engine: string; // 'quant' | provider name
}

export interface MarketBreadth {
  bull: number;
  bear: number;
  flat: number;
  avgConf: number;
}

/** v6.9: a TOP-5 ranked pick — the same AISignal payload plus the
 *  composite score, medal rank and the Hinglish rank reason. */
export interface TopPick extends AISignal {
  rank: number;
  score: number;
  rankReason: string;
}

export interface SignalBoard {
  ok: boolean;
  market: MarketKind;
  marketOpen?: boolean;
  reason?: string;
  /** v6.12: NSE session gate — when fresh intraday entries are safe. */
  sessionPhase?: SessionPhaseInfo;
  regime?: { niftyChange?: number | null; indiaVix?: number | null; btcChange?: number | null; niftyTrend?: string | null; btcTrend?: string | null };
  breadth?: MarketBreadth;
  /** v21.23.4 WRONG-SIGNAL-REMOVAL: data-degraded (daily-fallback
   *  "90% opposite" disease class) symbols ka signal board se REMOVE
   *  hua — count + reasons UI banner isi se banata hai. 0 = sab fresh. */
  degraded?: { count: number; symbols: Array<{ symbol: string; reason: string; market?: string }>; note: string | null };
  /** v9 SUPERINTELLIGENCE: what got scanned + the 80+/85+ counts. */
  superIntelMeta?: SuperIntelMeta;
  /** v6.9: full-universe composite TOP-5 (ranked, scored, reason'd). */
  topFive?: TopPick[];
  /** v11.0: council meta — enabled/model/stamped + gate thresholds. */
  council?: CouncilBoardMeta | null;
  /** v6.4: the user's max-stop% the board plans were built within. */
  riskCap?: number;
  scanned?: number;
  signals: AISignal[];
  models: ModelStatusRow[];
  generatedAt: number;
}

export interface OptionRow {
  strike: number;
  expiry: string;
  callOI: number;
  callOIChange: number;
  callIV: number | null;
  callLTP: number;
  callVolume: number;
  putOI: number;
  putOIChange: number;
  putIV: number | null;
  putLTP: number;
  putVolume: number;
  callGreeks?: { delta: number | null; gamma: number | null; theta: number | null; vega: number | null };
  putGreeks?: { delta: number | null; gamma: number | null; theta: number | null; vega: number | null };
}

export interface StrategyLeg {
  action: 'BUY' | 'SELL';
  type: 'CE' | 'PE';
  strike: number;
  premium: number;
  iv: number | null;
  delta: number | null;
  theta: number | null;
}

/** v6.13: one broker-ready leg of an options order ticket. */
export interface TicketLeg {
  action: 'BUY' | 'SELL';
  type: 'CE' | 'PE';
  strike: number;
  ltp: number;
  /** LIMIT price at the NSE ₹0.05 tick (BUY slightly above LTP, SELL slightly below — fill-friendly). */
  limit: number;
  qtyPerLot: number;
}

/** v6.13: server-computed step-by-step guide — KAB lena · konsa EXPIRY ·
 *  LIMIT order kaise lagana hai · kab EXIT karna hai · lots sizing. */
export interface OrderTicket {
  kind: 'debit' | 'credit';
  dte: number | null;
  expiryDay: boolean;
  whenText: string;
  sessionPhase: string;
  sessionTradeable: boolean;
  expiryText: string;
  legs: TicketLeg[];
  lotRows: { lots: number; maxLoss: number }[];
  perLotLoss: number | null;
  exit: { sl: string; target: string; time: string };
}

export interface Strategy {
  id: string;
  name: string;
  bias: string;
  conviction: string;
  rationale: string;
  legs: StrategyLeg[];
  netDebit?: number | null;
  netCredit?: number | null;
  maxProfit: number | null;
  maxLoss: number | null;
  breakevens: number[] | null;
  netDelta?: number | null;
  netTheta?: number | null;
  perLot?: { maxProfit: number | null; maxLoss: number | null };
  /** v6.7: probability-of-profit % at expiry (lognormal N(d2) of breakevens) */
  pop?: number | null;
  /** v6.7: sampled expiry payoff curve (per share) for the SVG chart */
  payoff?: { s: number; pnl: number }[];
  /** v6.13: step-by-step order ticket (null when data insufficient — honest) */
  orderTicket?: OrderTicket | null;
  exitPlan: string;
}

/** v9.4 — F&O OPTION SIGNAL CARD. One concrete, fully-priced option
 * contract distilled from the ensemble's INDEX consensus, in the
 * user's exact requested display format:
 *   Stock name : Nifty50 17Sep 23400 CE
 *   Target     : 110.00   (premium)
 *   Entry (Buy): 86.50    (premium)
 *   Stop Loss  : 77.00    (premium)
 * LONG → BUY the ATM CE · SHORT → BUY the ATM PE. Target/SL are the
 * option re-priced at the index plan's target1/stopLoss (BS, IV+expiry
 * held fixed) — the premium translation of the desk's index levels. */

/** v11.1 NSE+SENSEX addendum — chain/premium source honesty:
 *  'nse' / 'bse'                 live exchange chain premiums
 *  'bs-model'                    legacy tag (kept for back-compat)
 *  'bs-model-nifty-fallback'     NIFTY-family model mode — RECOVERABLE
 *                                (NSE temporarily blocked from this host)
 *  'bs-model-sensex-always'      SENSEX model mode — PERMANENT/structural
 *                                (BSE blocks datacenter IPs by design) */
export type OptionSource = 'nse' | 'bse' | 'bs-model' | 'bs-model-nifty-fallback' | 'bs-model-sensex-always';
export const isLiveOptionSource = (s: string | null | undefined): boolean => s === 'nse' || s === 'bse';

export interface OptionSignalCard {
  kind: 'option-signal';
  /** "Nifty50 15Sep 23400 CE" — display name + DDMon + strike + type */
  name: string;
  symbol: string;
  type: 'CE' | 'PE';
  strike: number;
  direction: 'LONG' | 'SHORT';
  expiry: string;
  expiryLabel: string | null;
  dte: number | null;
  entry: number;
  target: number;
  stopLoss: number;
  ltp: number | null;
  delta: number | null;
  theta: number | null;
  iv: number | null;
  lotSize: number;
  perLotCost: number;
  perLotRisk: number;
  perLotReward: number;
  rr: number | null;
  /** v9.6 superintelligence layer — AI score 0-100 + tier + pro metrics */
  aiScore?: number | null;
  tier?: 'ELITE' | 'STRONG' | 'ACTION' | 'WATCH' | string | null;
  pop?: number | null;
  breakeven?: number | null;
  expectedMovePct?: number | null;
  strikeBias?: 'ATM' | 'ITM' | 'OTM' | string;
  trendTag?: string | null;
  exitPlan?: {
    t1?: number; t1Note?: string;
    t2?: number; t2Note?: string;
    hardStop?: number;
    timeExit?: string;
  } | null;
  machineNote?: string | null;
  consensus: { side: string; confidence: number | null; grade: string; agreement?: number | null };
  /** v9.4 pro discipline kept, AI-score aware — STRONG/ACTION grade
   * YA 75+ AI score; a NEUTRAL/WATCH card renders with a loud
   * "entry MAT karo" warning. */
  tradeable: boolean;
  basis: { target: string; stopLoss: string };
  indexLevels: { spot: number; target1?: number; stopLoss?: number };
  source: OptionSource;
  /** v11.1: raw score + the SENSEX structural haircut when the card is
   *  model-only with no live-market cross-check possible. */
  aiScoreRaw?: number;
  structuralDiscount?: number;
  note: string;
}

/** v9.4 — combined NIFTY + SENSEX option-card view (GET /api/ai/option-signals). */
export interface OptionSignalsView {
  ok: boolean;
  asOf: number;
  /** v9.6 — the merged TOP-4 cards by AI score (Nifty50 + Sensex). */
  cards?: OptionSignalCard[];
  topCount?: number;
  methodology?: string | null;
  desks: Array<{
    symbol: string;
    ok: boolean;
    reason?: string;
    spot?: number;
    dte?: number | null;
    expiry?: string;
    expiryLabel?: string | null;
    lotSize?: number;
    source?: OptionSource;
    consensus?: { side: string; confidence: number; grade: string };
    cards: OptionSignalCard[];
    noCardReason?: string | null;
  }>;
}

/** v10.17 — whole-F&O OPTIONS SCANNER view (GET /api/ai/options-scan). */
export interface OptionsScanRow {
  symbol: string;
  kind: 'index' | 'stock';
  ok: boolean;
  reason?: string;
  spot?: number;
  changePct?: number | null;
  dte?: number | null;
  expiry?: string;
  expiryLabel?: string | null;
  source?: OptionSource;
  synthetic?: boolean;
  lotSize?: number;
  atmIV?: number | null;
  pcr?: number | null;
  maxPain?: number | null;
  oiSkew?: number | null;
  ivPercentile?: number | null;
  skewValue?: number | null;
  skewRead?: string | null;
  flowRead?: string | null;
  oiLean?: number | null;
  callPutVolRatio?: number | null;
  expectedMovePct?: number | null;
  expectedMoveBand?: { low: number; high: number } | null;
  gammaFlip?: number | null;
  callWall?: number | null;
  putWall?: number | null;
  totalNetGex?: number | null;
  gexRegimeNote?: string | null;
  directionPts?: number;
  direction?: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
  directionWhy?: string[];
  scanScore?: number;
  verdict?: string;
}

export interface OptionsScanView {
  ok: boolean;
  asOf: number;
  scanned?: number;
  liveCount?: number;
  modelCount?: number;
  failedCount?: number;
  rows: OptionsScanRow[];
  failed?: Array<{ symbol: string; reason: string }>;
  methodology?: string;
  note?: string | null;
  error?: string;
}

export interface OptionsDesk {
  ok: boolean;
  symbol: string;
  spot: number;
  spotChangePct?: number | null;
  vix?: number | null;
  expiry: string;
  /** v6.13: days to expiry (0 = expiry-day) */
  dte?: number | null;
  source: OptionSource;
  /** v21.0.4: which live relay served the chain ('groww' public mirror
   *  vs a direct exchange fetch) — null for synthetic/model chains. */
  sourceVia?: string | null;
  syntheticNote?: string | null;
  lotSize: number;
  analytics: {
    pcr: number | null;
    maxPain: number | null;
    atmIV: number | null;
    ivPercentile: number | null;
    oiSkew: number | null;
    callOI: number;
    putOI: number;
    /** v6.7: gamma-exposure profile (real OI chains only) */
    gex?: GexProfile;
    /** v6.11: OTM put-vs-call IV skew + volume/OI flow (real chains only) */
    skew?: { putIV: number | null; callIV: number | null; value: number | null; read: string };
    flow?: { callVolume: number; putVolume: number; callPutVolRatio: number | null; oiLean: number | null; oiLeanRead: string; read: string };
  } | null;
  consensus?: { side: Side; confidence: number; agreement: number; grade: Grade };
  strategies: Strategy[];
  rows: OptionRow[];
  fetchedAt: number;
  reason?: string;
}

export interface TradingConfig {
  mode: 'paper' | 'live';
  indiaMode: 'paper' | 'live';
  minConfidence: number;
  minAgreement: number;
  maxOrderINR: number;
  indiaMaxOrderINR: number;
  dailyMaxTrades: number;
  dailyMaxLossINR: number;
  onePositionPerPair: boolean;
  allowAuto: boolean;
  killSwitch: boolean;
  maxRiskPct: number;
  liveConfirmedAt: number | null;
  indiaLiveConfirmedAt: number | null;
  /** v6.5 trailing stop-loss */
  trailEnabled: boolean;
  trailArmR: number;
  trailOffsetR: number;
  /** v6.6: crypto margin leverage ceiling (1-10; 1 = spot only) */
  cryptoLeverage?: number;
  /** v6.7: concentration guard — max simultaneous open positions (both desks) */
  maxOpenPositions?: number;
}

export interface JournalPosition {
  id: string;
  pair: string;
  symbol?: string;
  market?: 'CRYPTO' | 'INDIA' | 'FUTURES' | 'GLOBALFUTURES';
  side: Side;
  mode: 'paper' | 'live';
  qty: number;
  entryPrice: number;
  notionalINR: number;
  sl: number | null;
  tp: number | null;
  tp2: number | null;
  /** v6.5 trailing state */
  peakPrice?: number | null;
  initialRisk?: number | null;
  trailing?: 'breakeven' | 'trail' | null;
  signal?: { grade: string; confidence: number; agreement: number; summary?: string };
  openedAt: number;
  status: 'OPEN' | 'CLOSED' | 'UNKNOWN';
  closedAt?: number;
  closePrice?: number;
  pnlINR?: number;
  closeReason?: string;
  ltp?: number | null;
  unrealizedPnlINR?: number | null;
  exchangeOrderId?: string | null;
  slOrderId?: string | null;
  /** v6.6: leverage fields (margin positions only; spot positions omit) */
  leverage?: number;
  marginINR?: number;
  liquidation?: number | null;
  marginPair?: string | null;
  /** v6.8: GLOBAL FUTURES fields (USDT domain) */
  notionalUSDT?: number | null;
  marginUSDT?: number | null;
  pnlUSDT?: number | null;
  closePriceUSDT?: number | null;
  unrealizedPnlUSDT?: number | null;
  usdInr?: number | null;
  exchangePositionId?: string | null;
  source?: string | null;
  /** v6.8: 'exchange' when the liquidation level came from CoinDCX itself */
  liquidationSource?: string | null;
  /** v7.0 PRO TRADER: 3-tier partial take-profit state */
  tp1Hit?: boolean;
  tp2Hit?: boolean;
  partialTpOff?: boolean;
  originalQty?: number | null;
  bookedPnlINR?: number | null;
  bookedPnlUSDT?: number | null;
  /** v10.4: GLOBAL desk — true when the instrument is a synthetic SIM (SPACEX). */
  isSim?: boolean;
  exitStage?: 'ENTRY' | 'T2_HIT' | 'RUNNER' | 'CLOSED' | string | null;
  /** v7.0.1: where the current ltp tick came from — 'coindcx' | 'tv-india' |
   *  'futures-rt' | 'tv-usd-fallback' | 'global-sim' | 'yahoo' | 'entry-fallback' (frozen price). */
  priceSource?: string | null;
}

export interface JournalEntry {
  id: string;
  ts: number;
  kind: string;
  day: string;
  pair?: string;
  side?: string;
  mode?: string;
  market?: string;
  source?: string;
  status: string;
  reason?: string;
  qty?: number;
  price?: number;
  notionalINR?: number;
  notionalUSDT?: number;
  marginUSDT?: number;
  leverage?: number;
  pnlINR?: number;
  pnlUSDT?: number;
  closePrice?: number;
  signal?: { grade?: string; conf?: number; agreement?: number };
  /** v7.0 PRO TRADER: PARTIAL_TP leg fields */
  stage?: 'T1' | 'T2' | string;
  remainingQty?: number;
  bookedPnlINR?: number;
  exitStage?: string;
}

export interface TradingState {
  ok: boolean;
  config: TradingConfig;
  stats: { day: string; tradesCount: number; realizedPnlINR: number; simTradesCount?: number; simRealizedPnlINR?: number };
  openPositions: number;
  blocked: { killSwitch: boolean; dailyTrades: boolean; dailyLoss: boolean; notConnected: boolean; maxOpenPositions?: boolean };
}

// ---------------- v6.5: Backtest ----------------
export interface BacktestTrade {
  symbol: string;
  side: Side;
  grade: Grade;
  confidence: number;
  entry: number | null;
  exit: number | null;
  sl: number | null;
  tp2: number | null;
  r: number | null;
  pnlINR: number | null;
  reason: string;
  holdBars: number | null;
  planStyle?: string;
}

export interface BacktestStats {
  trades: number;
  wins: number;
  losses: number;
  winRate: number | null;
  avgR: number | null;
  totalR: number | null;
  profitFactor: number | null;
  maxDDR: number | null;
  avgHoldBars: number | null;
  pnlINR: number | null;
  symbols?: number;
}

export interface BacktestResult {
  ok: boolean;
  market: MarketKind;
  params?: { minGrade?: string; capitalPerTradeINR?: number; maxRiskPct?: number; maxHoldBars?: number; slippagePct?: number };
  scannedSymbols?: number;
  perSymbol?: { symbol: string; ok: boolean; reason?: string; stats?: BacktestStats }[];
  stats: BacktestStats;
  gradeDist?: Record<string, number>;
  exitDist?: Record<string, number>;
  equity?: { i: number; cumR: number; symbol: string; r: number | null }[];
  trades?: BacktestTrade[];
  /** v6.7: backtest-learned gate recommendation (read-only; user applies) */
  learned?: {
    perGrade: Record<string, { n: number; winRate: number | null; avgR: number | null }>;
    currentMinConfidence: number;
    suggestedMinConfidence: number | null;
    recommendation: string;
    changed: boolean;
    disclaimer?: string;
  };
  /** v21.1.1 [audit A5]: walk-forward mode (?walkForward=1) — 70/30
   * train/test split + overfit verdict per symbol (server shape:
   * walkForwardSymbol() ka {split, train, test, verdict}). */
  walkForward?: {
    perSymbol?: { symbol: string; split?: { trainBars?: number; testBars?: number; trainPct?: number; learnedBar?: number; currentBar?: number }; train?: { atLearnedBar?: BacktestStats | null }; test?: { learnedBar?: BacktestStats | null }; verdict?: { overfit?: string; degradationPct?: number | null; comparisonBasis?: string } }[];
    summary?: { symbols: number; high: number; moderate: number; calibrated: number } | null;
  };
  disclaimer?: string;
  generatedAt?: number;
}

// ---------------- v10.8: NL Custom Strategy Lab ----------------
export interface StrategyLabCondition {
  indicator: string;
  operator?: string;
  value: number | string;
}

export interface StrategyLabResult {
  ok: boolean;
  stage?: 'compile' | 'done';
  error?: string;
  market?: MarketKind;
  description?: string;
  /** the EXACT validated rules that ran — full transparency */
  rules?: {
    name: string;
    direction: 'LONG' | 'SHORT';
    entry: StrategyLabCondition[];
    exit?: StrategyLabCondition[];
    stopLossAtr: number;
    takeProfitR: number;
    maxHoldBars: number;
  };
  params?: { capitalPerTradeINR?: number; slippagePct?: number; warmupBars?: number };
  scannedSymbols?: number;
  perSymbol?: { symbol: string; ok: boolean; reason?: string | null; stats?: BacktestStats }[];
  stats: BacktestStats;
  exitDist?: Record<string, number>;
  equity?: { i: number; cumR: number; symbol: string; r: number | null }[];
  trades?: BacktestTrade[];
  disclaimer?: string;
  generatedAt?: number;
}

// ---------------- v6.5: Alerts + AI keys + Dhan ----------------
export interface MaskedSecret {
  configured: boolean;
  tail: string | null;
}

export interface AlertsStatus {
  ok: boolean;
  status: {
    telegramBotToken: MaskedSecret;
    telegramChatId: MaskedSecret;
    geminiApiKey: MaskedSecret;
    groqApiKey: MaskedSecret;
  };
  telegram: { configured: boolean; source?: string | null };
}

export interface DhanStatus {
  ok: boolean;
  connected: boolean;
  scrips?: { cached?: boolean; symbols?: number; updatedAt?: number | null };
  profile?: { name?: string | null; clientId?: string | null } | null;
}

// ---------------- v6.7: GEX · swing · whales · ledger · brief ----------------
export interface GexProfile {
  perStrike: { strike: number; netGex: number; cumGex: number }[];
  gammaFlip: number | null;
  callWall: number | null;
  putWall: number | null;
  totalNetGex: number;
  expectedMove: { abs: number | null; pct: number | null; low: number; high: number; method: string };
  regimeNote: string;
}

export interface SwingIdea {
  symbol: string;
  market: MarketKind;
  side: Side;
  grade: 'A' | 'B';
  score: number;
  ltp: number | null;
  rsi: number | null;
  atr: number | null;
  plan: { entry: number; stopLoss: number; target1: number; target2: number; riskPct: number; rewardRisk: number } | null;
  holdDays: string;
  reasons: string[];
  source?: string;
}

export interface SwingBoard {
  ok: boolean;
  market: MarketKind;
  horizon: string;
  ideas: SwingIdea[];
  scanned: number;
  disclaimer?: string;
  generatedAt?: number;
}

export interface WhaleAlert {
  symbol: string;
  market: MarketKind;
  spike: number;
  changePct: number | null;
  ltp: number | null;
  direction: 'ACCUMULATION' | 'DISTRIBUTION';
  obvSlope: number | null;
  note: string;
}

export interface WhaleRadar {
  ok: boolean;
  market: MarketKind;
  whales: WhaleAlert[];
  scanned: number;
  note?: string;
  generatedAt?: number;
}

export interface LedgerEntryLite {
  id: string;
  ts: number;
  market: string;
  symbol: string;
  side: string;
  grade: string | null;
  confidence: number | null;
  mode: string;
  plan: { entry: number; stopLoss: number; target2: number } | null;
  outcome: { ts: number; r: number | null; pnlINR: number | null; reason: string | null; exit: number | null } | null;
  hash: string;
  prevHash: string | null;
}

export interface LedgerView {
  ok: boolean;
  entries: number;
  settled: number;
  open: number;
  wins: number;
  losses: number;
  winRate: number | null;
  headHash: string | null;
  verified: boolean;
  brokenAt: number | null;
  verify?: { ok: boolean; entries: number; brokenAt: number | null };
  recent: LedgerEntryLite[];
}

export interface AdaptiveModelStatus {
  model: string;
  mul: number;
  n: number;
  posterior: number | null;
  hitRate: number | null;
}

export interface MorningBrief {
  ok: boolean;
  asOf: string;
  nseOpen: boolean;
  market: { nifty: number | null; niftyChangePct: number | null; indiaVix: number | null; btc: number | null; btcChangePct: number | null };
  topSignals: {
    india: { symbol: string; side: Side; grade: Grade; confidence: number; ltp: number | null; plan: { entry: number; stopLoss: number; target2: number } | null }[];
    crypto: { symbol: string; side: Side; grade: Grade; confidence: number; ltp: number | null; plan: { entry: number; stopLoss: number; target2: number } | null }[];
  };
  swingTop: { symbol: string; side: Side; grade: string; score: number; ltp: number | null }[];
  whales: WhaleAlert[];
  book: {
    openPositions: { market: string; symbol: string; side: string; mode: string; qty: number; uPnl: number | null; sl: number | null }[];
    todayRealized: number | null;
    tradesToday: number;
    caps: { dailyMaxTrades: number; dailyMaxLossINR: number; maxOpenPositions: number; blocked: Record<string, boolean> };
  };
  ledger?: { entries: number; settled: number; winRate: number | null; verified: boolean };
  adaptive?: { enabled: boolean; learning: AdaptiveModelStatus[] };
  /** v6.11: context-aware "ab kya karein" suggestions (glama oneqaz). */
  nextActions?: NextActionItem[];
  note?: string;
}

export interface OrderbookView {
  ok: boolean;
  symbol: string;
  pair: string;
  bestBid: number;
  bestAsk: number;
  spreadPct: number | null;
  bidVol: number;
  askVol: number;
  imbalancePct: number | null;
  bidWall: { price: number; qty: number };
  askWall: { price: number; qty: number };
  read: string;
  error?: string;
}

// ---------------- v6.8: GLOBAL FUTURES + AGENT + WALLET ----------------

export interface WalletRow {
  currency: string;
  free: number;
  locked: number;
  total: number;
  crossUserMargin?: number | null;
}

export interface WalletView {
  ok: boolean;
  connected: boolean;
  usdInr: number;
  spot: {
    inr: WalletRow | { free: number; locked: number; total: number };
    usdt: WalletRow | { free: number; locked: number; total: number };
    error: string | null;
    rows: WalletRow[];
  };
  futures: {
    usdt: WalletRow | { free: number; locked: number; total: number; crossUserMargin?: number | null };
    inr?: WalletRow | { free: number; locked: number; total: number; crossUserMargin?: number | null };
    error: string | null;
    scope?: 'no_scope' | 'ok' | 'unknown' | null;
    rows?: WalletRow[];
  };
  equityINR: number;
  deployableFuturesUSDT: number;
  deployableFuturesINR?: number;
  deployableFuturesCombinedUSDT?: number;
  futuresMarginCurrency?: 'INR' | 'USDT';
  deployableSpotINR: number;
  fetchedAt: number;
  error?: string;
}

export interface FuturesMarketRow {
  pair: string;
  base: string;
  last: number;
  mark: number;
  changePct: number | null;
  high: number | null;
  low: number | null;
  volumeUSDT: number | null;
}

export interface FuturesMarketsView {
  ok: boolean;
  count: number;
  markets: FuturesMarketRow[];
  fetchedAt: number;
  error?: string;
}

export interface AgentTradeToday {
  ts: number;
  pair: string;
  side: string;
  mode: string;
  market: string;
  status: string;
  qty: number | null;
  price: number | null;
  leverage: number | null;
  marginUSDT: number | null;
  reason: string | null;
}

export interface AgentLogLine {
  ts: number;
  level: 'info' | 'entry' | 'exit' | 'skip' | 'error' | string;
  text: string;
}

export interface AgentConfig {
  enabled: boolean;
  mode: 'paper' | 'live' | string;
  /** v19.0 — global (Equity SIM USDC) desk flag added; spot auto-entry
   * default OFF (user spec: auto trading sirf Global Futures USDT +
   * Equity SIM USDC me — manual spot trading unaffected). */
  desks: { futures: boolean; spot: boolean; india: boolean; global?: boolean };
  maxTradesPerDay: number;
  /** v9.6 — 75+ AI score → auto entry (user spec) */
  minAiScore?: number;
  minConfidence: number;
  minAgreement: number;
  riskPerTradePct: number;
  maxLeverage: number;
  cooldownMin: number;
  maxHoldMin: number;
  dailyLossCapPct: number;
  minEquityINR: number;
  /** v7.0 PRO TRADER: 3-tier partial take-profit */
  partialTpEnabled: boolean;
  tp1ClosePct: number;
  tp2ClosePct: number;
  runnerPct: number;
  breakEvenAfterTp1: boolean;
  /** v9.7 — trend-flip exit protects manual positions too (user spec, default ON) */
  manageManualPositions?: boolean;
  /** v10.2 — thin committee (<5 voters) AI score bump (default 10, range 0-15) */
  quorumPenalty?: number;
  /** v10.8 — near-miss auto-trade (user spec: highest-score near-misses with high conf get entered) */
  nearMissAutoTrade?: boolean;
  nearMissScoreGap?: number;
  nearMissMinConfidence?: number;
  nearMissMaxPerDay?: number;
  /** v10.8 — winner extension at time-exit (profitable positions get window + SL→BE) */
  winnerExtendEnabled?: boolean;
  winnerExtendPct?: number;
  winnerExtendMax?: number;
}

/** v7.0: what the agent WOULD invest on the next STRONG signal. */
export interface AgentSizingPreview {
  desk: 'FUTURES' | 'SPOT' | null | string;
  symbol?: string;
  riskINR: number;
  riskPct: number;
  equityINR: number;
  usdInr: number;
  entry?: number | null;
  stopLoss?: number | null;
  stopDist?: number | null;
  qty?: number;
  leverage?: number;
  marginUSDT?: number;
  marginINR?: number;
  deployableUSDT?: number;
  capped?: boolean;
  budgetINR?: number;
  deployableSpotINR?: number;
  note: string;
}

export interface AgentOpenPosition {
  id: string;
  pair: string;
  market: string;
  side: string;
  mode: string;
  qty: number;
  entryPrice: number;
  sl: number | null;
  tp?: number | null;
  tp2: number | null;
  leverage: number | null;
  marginUSDT: number | null;
  openedAt: number;
  ageMin: number | null;
  maxHoldMin: number;
  /** v7.0 PRO TRADER: 3-tier exit state */
  tp1Hit?: boolean;
  tp2Hit?: boolean;
  bookedPnlINR?: number | null;
  bookedPnlUSDT?: number | null;
  remainingQty?: number | null;
  originalQty?: number | null;
  exitStage?: 'ENTRY' | 'T1_HIT' | 'T2_HIT' | 'RUNNER' | 'CLOSED' | string;
  /** v10.15 GAP 1: the live conviction re-vote (null when the tracker is
   *  OFF or no fresh re-vote has landed yet). */
  conviction?: {
    state: 'STRENGTHENING' | 'HOLDING' | 'WEAKENING' | 'FLIPPED' | 'UNKNOWN' | string;
    delta: number | null;
    currentScore: number | null;
    entryScore: number | null;
    side?: string | null;
    at?: number;
  } | null;
}

export interface AgentPick {
  symbol: string;
  side: Side;
  grade: string;
  confidence: number;
  /** v9.6 — superintelligence AI score (75+ = auto-entry bar) */
  aiScore?: number | null;
  ltp: number | null;
  pair: string;
  /** v10.2: models casting directional votes / total models */
  voters?: number | null;
  totalModels?: number | null;
  plan: { entry: number; stopLoss: number; target2: number; riskPct: number } | null;
}

export interface AgentView {
  ok: boolean;
  engine: string;
  config: AgentConfig;
  trading: { mode: string; allowAuto: boolean; killSwitch: boolean; connected: boolean };
  state: {
    running: boolean;
    runningSince: number | null;
    lastScanAt: number | null;
    scans: number;
    lastEntryAt: number | null;
    lastEntryPair: string | null;
    pausedToday: { day: string; reason: string } | null;
    lastWallet: { equityINR: number; usdInr: number; deployableFuturesUSDT: number; deployableSpotINR: number; at: number } | null;
    /** v9.7 — loop cadence + countdown + latest wait/blocker reason */
    tickSec?: number;
    nextScanInSec?: number | null;
    lastSkip?: { key: string; text: string; at: number } | null;
    log: AgentLogLine[];
  };
  /** v9.7 — "entry kyun nahi ho raha" strip: hard blockers + soft wait reasons */
  blockers?: Array<{ key: string; text: string; soft?: boolean }>;
  /** v10.1 — decision-quality state (B1 quorum bar · B2 dynamic windows ·
   *  B3 rolling win-rate · B4 correlation guard) */
  accuracy?: {
    quorumAwareEntry: boolean;
    quorumPenalty?: number;
    effectiveMinAiScore: number;
    thinCommitteeMinAiScore: number;
    dynamicTimeExit: boolean;
    openWindowOverrides: Array<{ pair: string; atrPct: number | null; windowMin: number }>;
    rollingWinRate: number | null;
    rollingWindow: number;
    minRollingWinRate: number;
    winRateDowngraded: { at: number; winRate: number; trades: number } | null;
    correlationGuard: boolean;
    /** v10.2 Step 1: near-miss diagnostics */
    lastNearMisses?: Array<{
      pair: string;
      symbol: string;
      aiScore: number;
      needScore: number;
      voters: number;
      quorumCapped: boolean;
      confidence: number;
      agreement: number;
    }>;
    /** v10.2 Step 1: V2 models flag (Sentiment, InstFlow, Fundamentals) */
    v2ModelsEnabled?: boolean;
    /** v21.12.0 — full committee composition (server /health + agent
     *  accuracy payload se). UI hardcoded 16/13 ke bajaye isse render
     *  karta hai: voting/shadow seat counts, tape seat, learning window,
     *  META armed state. */
    committee?: {
      total: number;
      voting: number;
      shadow: number;
      tapeSeat: string | null;
      tapeWeight: number | null;
      learningWindow: number;
      accuracySuite: boolean;
      v2Models: boolean;
      mtfConfluence: boolean;
      meshModels: boolean;
      meta: { enabled: boolean; serviceUrl: string };
    } | null;
    /** v10.8 — near-miss auto-trade state */
    nearMiss?: {
      enabled: boolean;
      scoreGap: number;
      minConfidence: number;
      maxPerDay: number;
      usedToday: number;
      todayEntries: Array<{ ts: number; symbol: string; aiScore: number | null; needScore: number | null; confidence: number | null; voters: number | null }>;
    };
    /** v10.8 — winner-extension state ("trade ke hisaab se extension") */
    winnerExtension?: {
      enabled: boolean;
      extendPct: number;
      max: number;
      open: Array<{ pair: string; extensions: number; windowMin: number; lastExtendAt: number | null }>;
    };
    /** v10.8 PRO #4 — the frozen mandate (null = agent stopped) */
    mandate?: { frozenAt: number; mode: string; caps: Record<string, number | null> } | null;
  };
  today: {
    day: string;
    trades: AgentTradeToday[];
    tradesCount: number;
    maxTrades: number;
    realizedPnlINR: number;
    lossCapINR: number;
    paused: { day: string; reason: string } | null;
  };
  openPositions: AgentOpenPosition[];
  wallet: WalletView | null;
  picks: Partial<Record<'INDIA' | 'FUTURES' | 'CRYPTO' | 'GLOBALFUTURES', AgentPick[]>>;
  /** v7.0 PRO TRADER: next-trade sizing preview */
  sizingPreview?: AgentSizingPreview | null;
}

// ============================================================
// v6.11 — glama Tier-2/3 feature types
// ------------------------------------------------------------

/** Calibration bucket: claimed confidence vs realized win-rate. */
export interface CalibrationBucket {
  bucket: string;
  claimed: number;
  n: number;
  winRate: number | null;
  gap: number | null;
}

export interface MonthlyTrendRow {
  month: string;
  n: number;
  winRate: number;
  avgR: number;
}

export interface TrustReport {
  ok: boolean;
  settled: number;
  sufficient: boolean;
  calibration: CalibrationBucket[];
  brier: number | null;
  brierVerdict: string | null;
  monthly: MonthlyTrendRow[];
  drift?: number | null;
  overall?: { winRate: number; avgConfidence: number };
  note?: string;
}

export interface GovernanceRow {
  model: string;
  n: number;
  hitRate: number | null;
  baseRate: number;
  pValue: number;
  verdict: 'SIGNIFICANT' | 'BORDERLINE' | 'NOISE' | 'NEEDS DATA';
  edge: number | null;
}

export interface GovernanceView {
  ok: boolean;
  settled: number;
  baseRate: number;
  method: string;
  minN: number;
  models: GovernanceRow[];
  note?: string;
}

export interface ModelPerfRow {
  model: string;
  name: string;
  n: number;
  hitRate: number | null;
}

export interface ModelPerfWindows {
  ok: boolean;
  windows: string[];
  settledTotal: number;
  d30?: ModelPerfRow[];
  d90?: ModelPerfRow[];
  note?: string;
}

export interface RegimeReweightState {
  enabled: boolean;
  label: 'TRENDING' | 'CHOPPY' | 'HIGH_VOL' | 'LOW_VOL' | null;
  note: string;
  downWeighted: { id: string; name: string; mul: number }[];
  upWeighted: { id: string; name: string; mul: number }[];
}

export interface TrustView {
  ok: boolean;
  calibration: TrustReport;
  governance: GovernanceView;
  /** v10.6 Pro Upgrade #5: rolling per-model windows. */
  windows?: ModelPerfWindows;
  /** v10.6 Pro Upgrade #4: live regime reweight state per desk. */
  regimeReweight?: { INDIA?: RegimeReweightState; CRYPTO?: RegimeReweightState };
  /** v11.6: mesh-backed seats — accountability + correlation guard. */
  meshModels?: MeshModelsTrustView;
}

// ---------------- v11.6 mesh-backed seats ----------------
export interface MeshSeatAccountabilityRow {
  id: string;
  name: string;
  meshCaps: string[];
  markets: string[];
  baseWeight: number;
  mode: 'shadow' | 'voting' | 'retired';
  effectiveWeight: number;
  n: number;
  hitRate: number | null;
  whenVotedWR: number | null;
  whenAbstainedWR: number | null;
  edge: number | null;
  note: string;
}

export interface MeshCorrelationRow {
  corr: number | null;
  vs: string | null;
  overlapN: number;
  discount: number;
  verdict: 'independent' | 'insufficient-overlap' | 'partially-redundant' | 'redundant';
  note: string;
}

export interface MeshModelsTrustView {
  accountability: {
    ok: boolean;
    minSettled: number;
    retireN: number;
    settledTotal: number;
    models: MeshSeatAccountabilityRow[];
    note: string;
  };
  correlation: {
    ok: boolean;
    minOverlap: number;
    hard: number;
    soft: number;
    seats: Record<string, MeshCorrelationRow>;
    note: string;
  };
}

export interface MeshAgentCard {
  id: string;
  name: string;
  kind: string;
  capabilities: { cap: string; tier: string }[];
  envKey: string | null;
  authRequired: boolean;
  authed: boolean;
  priority: number;
  budget: { perDay: number; perMinute: number };
  health: {
    state: 'closed' | 'open' | 'half-open';
    consecutiveFails: number;
    lastOkAt: number | null;
    lastFailAt: number | null;
    lastError: string | null;
    breakerProbes: number;
    backoffMs: number | null;
  };
  budgetUsed: { perDay: number; usedToday: number; perMinute: number; usedMinute: number };
  note: string;
}

export interface MeshStatusView {
  ok: boolean;
  agents: MeshAgentCard[];
  agentCount: number;
  authedAgents: number;
  cache: {
    entries: number;
    cap: number;
    inflight: number;
    negative: number;
    stats: { queries: number; cacheHits: number; upstream: number; negativeHits: number; gaps: number };
  };
  timeoutMs: number;
  note: string;
}

export interface MeshSeatsStatusView {
  enabled: boolean;
  flag: string;
  seats: {
    id: string;
    name: string;
    mode: 'shadow' | 'voting' | 'retired';
    baseWeight: number;
    effectiveWeight: number;
    markets: string[];
    meshCaps: string[];
    n: number;
    hitRate: number | null;
    edge: number | null;
  }[];
  warm: {
    topN: number;
    batchPerTick: number;
    requeryGaps: { hot: string; warm: string; cold: string };
    stats: { warmTicks: number; queriesIssued: number; capsServed: number; gaps: number };
    byMarket: Record<string, { symbols: number; capsServed: number; capsGapped: number; staleCapped: number }>;
    note: string;
  };
}

export interface PerfView {
  ok: boolean;
  settled: number;
  sufficient: boolean;
  expectancy?: number | null;
  winRate?: number;
  totalR?: number | null;
  totalPnlINR?: number | null;
  mdd?: { r: number; note: string | null };
  sharpe?: { perTrade: number | null; note?: string };
  sortino?: { perTrade: number | null };
  calmar?: { expectancyOverMdd: number | null; note?: string | null };
  streaks?: { win: number; loss: number };
  profitFactor?: number | null;
  avgWinR?: number | null;
  avgLossR?: number | null;
  equityCurveR?: number[];
  byMarket?: Record<string, { n: number; winRate: number; avgR: number | null; totalR: number | null } | null>;
  byMode?: Record<string, { n: number; winRate: number; avgR: number | null; totalR: number | null } | null>;
  note?: string;
}

export interface CorrAsset { key: string; label: string; group: string }

export interface CorrView {
  ok: boolean;
  window: number;
  assets: CorrAsset[];
  skipped: string[];
  matrix: (number | null)[][];
  top: { mostPositive: { a: string; b: string; r: number }[]; mostNegative: { a: string; b: string; r: number }[] };
  riskLink: { pair: string; r: number; read: string } | null;
  note: string;
}

export interface SectorRow {
  sector: string;
  symbols: number;
  breadth: number;
  avgChangePct: number;
  avgRsi: number;
  mood: 'BULLISH' | 'NEUTRAL' | 'BEARISH';
  indexChangePct: number | null;
  leader: { symbol: string; changePct: number } | null;
  laggard: { symbol: string; changePct: number } | null;
}

export interface ContextChain {
  macro: { niftyChangePct: number | null; vix: number | null; vixRegime: string | null; dollar: number | null; crude: number | null; gold: number | null; bias: string };
  read: string;
  strongest: { sector: string; mood: string; breadth: number; top: { symbol: string; changePct: number; fscore: number }[] }[];
}

export interface FScoreRow {
  symbol: string;
  ltp?: number | null;
  score: number;
  grade: 'A' | 'B' | 'C';
  rsi?: number | null;
  pos52?: number | null;
  adx?: number | null;
}

export interface SectorView {
  ok: boolean;
  universe?: number;
  sectors: SectorRow[];
  chain: ContextChain | null;
  fscore?: {
    top: FScoreRow[];
    bottom: FScoreRow[];
    distribution: { A: number; B: number; C: number };
    disclaimer?: string;
  };
  error?: string;
  note?: string;
}

export interface IncomeRow {
  symbol: string;
  name: string;
  id: string;
  credit: number;
  creditPct: number;
  pop: number | null;
  maxLoss: number | null;
  riskReward: number | null;
  score: number | null;
  breakevens: number[];
  source: string;
  expiry: string;
  exitPlan?: string;
}

export interface IncomeView {
  ok: boolean;
  count: number;
  desksLoaded?: number;
  top: IncomeRow[];
  methodology: string;
  note: string;
}

export interface NextActionItem {
  id: string;
  label: string;
  kind: string;
  market?: string;
  symbol?: string;
}

export interface NextActionsView {
  ok: boolean;
  nseOpen: boolean;
  actions: NextActionItem[];
  followups: string[];
  note?: string;
}

/** Deep-scan regime story (glama explain_ticker). */
export interface NarrativeView {
  title: string;
  story: string[];
  watch: string;
  asOf?: number;
}

// ============================================================
// v21.3.0 (Issue-4) — ONE-CLICK LIVE EXECUTE PRE-FLIGHT types
// ============================================================
export interface PrecheckGate {
  name: string;
  pass: boolean;
  detail: string | null;
  blocking?: boolean;
}

export interface PrecheckTicket {
  pair: string;
  symbol: string;
  side: string | null;
  price: number | null;
  stopLoss: number | null;
  target1: number | null;
  target2: number | null;
  riskPct: number | null;
  rewardRisk: number | null;
  leverage: number;
  leverageRequested: number;
  maxSaneLeverage: number | null;
  marginUSDT: number;
  marginUsedUSDT: number;
  marginINR: number | null;
  qty: number;
  notionalUSDT: number;
  notionalINR: number | null;
  liquidation: number | null;
  grade: string | null;
  confidence: number | null;
  aiScore: number | null;
  aiConfirm: string | null;
  nativeProtection: { stopLoss: number; takeProfit: number } | null;
  minQty: number | null;
  qtyPrecision: number | null;
}

export interface FuturesPrecheckResult {
  ok: boolean;
  symbol: string;
  pair?: string;
  side?: string | null;
  gates: PrecheckGate[];
  ticket: PrecheckTicket | null;
  warnings: string[];
  error?: string;
}
