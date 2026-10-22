// ============================================================
// intraday/types — shared intraday tab types (v3)
// ============================================================
import type { SuperIntel, SuperIntelMeta, MTFConfluence, MTFTapeRead } from '../aitrading/types';

export type { SuperIntel, SuperIntelMeta };

/** v10.5 MTF CONFLUENCE (Upgrade 1) — re-exported from the AI board's
 *  type module (single source of truth; the intraday scanner pipeline
 *  does not produce it, so IntradaySignal.mtf stays undefined there). */
export type { MTFConfluence, MTFTapeRead };

export interface IntradaySignal {
  symbol: string;
  ltp: number;
  changePct: number;
  direction: 'LONG' | 'SHORT';
  confidence: number;
  quantConfidence: number;
  aiConfidence: number | null;
  aiModel: string;
  aiNote: string;
  market?: 'INDIA' | 'CRYPTO';
  exchange?: 'NSE' | 'BSE' | 'BINANCE' | 'COINDCX';
  entry: number;
  entryZoneLow?: number;
  entryZoneHigh?: number;
  stopLoss: number;
  target1: number;
  target2: number;
  trailingSL?: number;
  trailAfterT1?: number;
  qtyPerLakh?: number;
  trendStrength?: string;
  freshEntriesAllowed?: boolean;
  sqOffBy?: string;
  marketPhase?: string;
  gapPct?: number;
  adx?: number;
  vwapDist?: number;
  rr: number;
  atr: number;
  vwap: number;
  rsi: number;
  volumeRatio: number;
  reasons: string[];
  // v3 additions
  orbMode?: 'LIVE' | 'PROXY';
  counterTrend?: boolean;
  slippage?: number;
  effRR?: number;
  /** v11.1 GAP 2 (circuit guard): the day's price band from the live
   *  Groww quote — present only when the band is known. `nearCircuit`
   *  flags the same-direction entry-risk case (LONG→upper / SHORT→
   *  lower circuit), which is also pushed into `reasons`. */
  circuitRisk?: { band: 'UPPER' | 'LOWER' | null; distPct: number | null; upper: number; lower: number } | null;
  nearCircuit?: boolean;
  // v4 DUAL-AI EXPERT additions
  grade?: 'A+' | 'A' | 'B';
  tradeType?: 'SCALP' | 'MOMENTUM' | 'SWING' | null;
  entryQuality?: number | null; // 1-10 AI entry-timing score
  aiReasoning?: string;         // full Gemini+Groq reasoning chain
  riskFactors?: string[];
  geminiVerdict?: { confidence: number; note: string } | null;
  groqVerdict?: { confidence: number; note: string } | null;
  aiAdjustedSL?: number | null;
  aiAdjustedEntry?: number | null;
  /** v9 SUPERINTELLIGENCE: AI SCORE (0-100) + the full trade blueprint
   *  (entry timing · leverage ladder · staged exit · exit clock). */
  superIntel?: SuperIntel | null;
  /** v10.5 MTF CONFLUENCE (Upgrade 1): the 5m/15m/1h tape read —
   *  per-TF direction + confidence and the 3-way agreement (0..1,
   *  measured vs the 15m trading timeframe). Present only when the
   *  server's AI_ENABLE_MTF_CONFLUENCE flag is ON and the tapes
   *  resolved. */
  mtf?: MTFConfluence | null;
}

export interface MarketRegime {
  market?: 'INDIA' | 'CRYPTO';
  regime: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
  vix: number | null;
  vixLevel: 'LOW' | 'ELEVATED' | 'HIGH' | null;
  niftyChange: number;
  niftyVwapDist: number;
  niftyRsi?: number | null;
  // CRYPTO regime payload (BTC-based) — mirrored keys.
  btcChange?: number;
  btcVwapDist?: number;
  btcRsi?: number | null;
  asOf?: string;
}

export interface IntradayAlertsStatus {
  enabled: boolean;
  telegramConfigured: boolean;
  cooldownMinutes: number;
  maxPerDay: number;
  sentToday: number;
}

export interface ScannerResponse {
  market?: 'INDIA' | 'CRYPTO';
  marketOpen: boolean;
  istTime?: string;
  weekday?: string;
  asOf?: string;
  scanned?: number;
  universe?: number;
  minConfidence?: number;
  aiVerified?: boolean;
  aiModel?: string;
  aiConsensus?: string;
  aiEngine?: string;
  engine?: string;
  /** v9 SUPERINTELLIGENCE meta — engine + 80+/85+ counts. */
  superIntelMeta?: SuperIntelMeta;
  sources?: { tradingView?: number; groww?: number; coindcx?: number };
  marketRegime?: MarketRegime | null;
  freshEntriesAllowed?: boolean;
  deadZone?: boolean;
  signals: IntradaySignal[];
  message?: string;
  error?: string;
  retryAfterSeconds?: number;
  disclaimer?: string;
}

export interface LiveQuote {
  price: number;
  change?: number;
  ts?: number;
  /** v10.12 (#1): which upstream served this quote — 'groww-live' |
   *  'groww-api' (v21.6 official Trading-API tier) |
   *  'yahoo-delayed' (indices) | 'coindcx-inr' (crypto watch symbols).
   *  Rendered as the Groww·live / Groww·API / Yahoo·delayed / CoinDCX·RT pill by
   *  LiveSourceBadge on the signal cards. */
  src?: string;
  /** v11.1 GAP 2: the day's price band (upper/lower circuit) when the
   *  upstream serves it (Groww equity quotes). Absent → guard inert. */
  upperCircuit?: number;
  lowerCircuit?: number;
}

export interface OutcomeEvent {
  type: 'OPEN' | 'FLIP' | 'T1_HIT' | 'T2_HIT' | 'SL_HIT' | 'BE_TRAIL_EXIT' | 'EOD_EXIT' | 'PAPER_CLOSE' | 'CIRCUIT_RISK';
  symbol: string;
  direction?: 'LONG' | 'SHORT';
  price?: number;
  pnl?: number;
  /** v11.1 GAP 3: post-cost P&L (brokerage + STT + txn + GST + SEBI +
   *  stamp deducted) — present when the cost model ran. */
  pnlNet?: number | null;
  rMultiple?: number;
  qty?: number;
  note?: string;
  confidence?: number;
  /** v11.1 GAP 2 (CIRCUIT_RISK events): the adverse band + proximity. */
  band?: 'UPPER' | 'LOWER';
  frozen?: boolean;
  distPct?: number;
}

export interface PaperTrade {
  id: number;
  symbol: string;
  market?: 'INDIA' | 'CRYPTO' | 'FUTURES' | 'GLOBALFUTURES';
  direction: 'LONG' | 'SHORT';
  entry: number;
  qty: number;
  remainingQty: number;
  stopLoss: number;
  target1: number | null;
  target2: number | null;
  status: 'OPEN' | 'PARTIAL' | 'CLOSED';
  t1Hit: boolean;
  dayKey?: string;
  openedAt: number;
  closedAt: number | null;
  closeReason: string | null;
  lastPrice: number;
  realizedPnl: number;
  unrealizedPnl: number;
  parts: { qty: number; exitPrice: number; ts: number; reason: string }[];
  capital: number;
  /** v11.1 GAP 3 — real transaction-cost model: gross stays available
   *  as the secondary figure, NET (post brokerage + STT + exchange txn
   *  + SEBI + GST + stamp) is the displayed headline. Derived live by
   *  the server (works for legacy/restored trades too). */
  grossPnl?: number;
  costs?: number;
  netPnl?: number;
  /** v21.17.0: excursion (MFE/MAE in R), audit provenance, ccy domain. */
  mfeR?: number | null;
  maeR?: number | null;
  mfePrice?: number | null;
  maePrice?: number | null;
  source?: string;
  sourceMeta?: { score?: number | null; tier?: string | null; mode?: string | null; holdMin?: number | null; superSymbol?: string | null } | null;
  ccy?: 'USDT' | 'USDC' | 'INR';
  costsBreakdown?: {
    instrumentType: string;
    brokerage: number;
    stt: number;
    exchangeTxn: number;
    sebi: number;
    gst: number;
    stampDuty: number;
    takerFee?: number | null;
    orders?: number | null;
    note?: string;
  };
  /** v9.5 F&O option rows — present only on option paper trades. */
  assetKind?: 'OPTION';
  underlying?: string;
  strike?: number;
  optType?: 'CE' | 'PE';
  expiry?: string;
  lotSize?: number;
  /** "Nifty50 15Sep 23400 CE" — the card name this trade came from. */
  label?: string | null;
}

export interface PaperSummary {
  open: PaperTrade[];
  closedToday: PaperTrade[];
  stats: {
    openCount: number;
    dayRealizedPnl: number;
    dayUnrealizedPnl: number;
    totalRealizedPnl: number;
    wins: number;
    losses: number;
    /** v11.1 GAP 3: net-of-costs variants. */
    dayCosts?: number;
    dayNetPnl?: number;
    totalCosts?: number;
    totalNetPnl?: number;
    /** v21.17.0 paper analytics: R-distribution + excursion + provenance. */
    closedTotal?: number;
    winRatePct?: number | null;
    avgR?: number | null;
    bestR?: number | null;
    worstR?: number | null;
    avgMfeR?: number | null;
    avgMaeR?: number | null;
    capturePct?: number | null;
    exitMix?: Record<string, number>;
    bySource?: Record<string, { n: number; wins: number; pnl: number }>;
    openRisk?: number;
  };
}

export interface PaperDayStats {
  dayKey: string;
  trades: number;
  wins: number;
  losses: number;
  winRate: number;
  realizedPnl: number;
  /** v11.1 GAP 3: the honest net line. */
  costs?: number;
  netPnl?: number;
}

export interface PaperHistory {
  days: number;
  totalClosed: number;
  groups: PaperDayStats[];
  overall: {
    totalTrades: number;
    wins: number;
    losses: number;
    winRate: number;
    avgWin: number;
    avgLoss: number;
    profitFactor: number | null;
    totalPnl: number;
    bestDay: { dayKey: string; pnl: number } | null;
    worstDay: { dayKey: string; pnl: number } | null;
    /** v11.1 GAP 3: the "real-money viable or only paper-viable" view. */
    totalCosts?: number;
    totalNetPnl?: number;
    costsPctOfGrossProfit?: number | null;
  };
  trades: PaperTrade[];
}

export interface TrackRecordData {
  days: number;
  totalTracked: number;
  openCount: number;
  excludedCount?: number;
  resolved: number;
  wins: number;
  losses: number;
  winRate: number | null;
  avgR: number | null;
  disciplinedPnlPerLakh: number;
  byStatus: Record<string, number>;
  open: {
    symbol: string; direction: string; entry: number; stopLoss: number;
    target1: number; target2: number; status: string; lastPrice: number;
    confidence: number; openedAt: number; t1Hit: boolean;
  }[];
  history: {
    symbol: string; direction: string; dayKey: string; entry: number;
    exitPrice: number | null; status: string; confidence: number;
    t1Hit: boolean; pnl: number | null; rMultiple: number | null;
    openedAt: number; closedAt: number | null;
  }[];
}

export interface UniverseInfo {
  market?: 'INDIA' | 'CRYPTO';
  baseCount: number;
  removedBase: string[];
  custom: string[];
  effectiveCount: number;
  effective: string[];
}
