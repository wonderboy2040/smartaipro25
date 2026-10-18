// ============================================================
// server/ai/meshModels.js — v11.6 MESH-BACKED ENSEMBLE SEATS
// ------------------------------------------------------------
// The v11.0 MCP mesh (10 agents) was only ever wired into council.js
// (narration) and weeklyReview.js — it NEVER voted on which trades
// get suggested. This module fixes exactly that: 4 new committee
// seats whose votes come from REAL mesh data, with the same honesty
// discipline the repo already demands everywhere else:
//
//   15. InstFlowPro     0.8  quiver altdata.congress + altdata.insider
//                            (GLOBALFUTURES desk — US institutional
//                            positioning; the India desk abstains:
//                            Quiver covers US tickers only)
//   16. TechConsensus   0.7  tradingcentral news.sentiment
//                            (an INDEPENDENT second opinion — computed
//                            by a different methodology than our own
//                            14-model TA stack)
//   17. FundaProPlus    0.55 alphavantage stocks.fundamentals +
//                            massive fundamentals.profile
//                            (deepens FundaCheck — India SWING/deep
//                            path + GLOBALFUTURES board)
//   18. CryptoOnChainPro 0.6 coingecko crypto.onchain + coinapi
//                            crypto.tick (on-chain/community/dev
//                            context for the crypto desks)
//
// PHASE 1B — HONESTY GATE: a mesh-backed model ABSTAINS whenever its
// underlying data is tagged stale (mesh stale-while-revalidate), too
// old for its cap class, or simply absent (budget-exhausted agent /
// open breaker). Acting on stale institutional data is worse than
// not having it — the vote never fakes fresh confirmation.
//
// PHASE 1C — CROSS-CORRELATION: before a new seat's vote carries full
// weight, its recorded votes are correlated against TrendMatrix /
// MomentumQuant over the ledger. corr > 0.85 → weight ×0.5,
// > 0.70 → ×0.75 (a seat that just restates existing models is
// correlated noise dressed as diversification).
//
// PHASE 2 — SHADOW-MODE PROVING: seats ship SHADOW (weight 0 — the
// vote is journaled in the tamper-evident ledger via recordExecution
// but counts toward NO entry decision) until the trust system's
// MIN_SETTLED (10) settled outcomes prove an edge: trades where the
// model voted must win MORE often than trades where it abstained.
// No edge → stays shadow. n ≥ 30 with edge ≤ −5 → retired.
// Everything is a PURE function of the ledger (no stored state —
// Render restarts can't lose or fake promotion).
//
// PHASE 3 — TIERED BUDGET-AWARE USAGE: warmMeshModels() runs at T3
// cadence for the TOP slice only (never the full universe at board
// cadence — free-tier buckets would be gone in minutes). Re-query
// gaps ALIGN with the mesh's own cache tiers (hot 30s / warm 5min /
// cold 60min), conservatively stretched (2min / 30min / 4h) so the
// per-agent token buckets (quiver 50/day, alphavantage 20/day, …)
// survive the day. When a bucket empties, the mesh returns a gap,
// the vote abstains, and the status views SAY SO.
//
// Contract (models.js bus, identical to Sentiment/InstFlow/
// FundaCheck): the VOTE is synchronous; data is warmed by
// warmMeshModels(market, symbols) before the model loop runs.
// Cold cache → honest abstain, never an invented number.
// ============================================================
import { meshQuery } from '../mcp/mesh.js';
import { __ledgerRaw } from './ledger.js';
// v21.12.0 master accuracy switch (see accuracySuite.js header)
import { accuracySuiteEnabled, legacyFlagEnabled } from './accuracySuite.js';

const clamp = (v, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, v));
const r1 = (v) => (Number.isFinite(v) ? Math.round(v * 10) / 10 : null);
const r2 = (v) => (Number.isFinite(v) ? Math.round(v * 100) / 100 : null);

function vote(dir, conf, reasons, na = false) {
  return { dir, conf: Math.round(clamp(conf)), reasons: reasons.filter(Boolean), ...(na ? { na: true } : {}) };
}

// ---------------- the seats ----------------
export const MESH_MODEL_IDS = ['instflowpro', 'techconsensus', 'fundaproplus', 'cryptoonchain'];

export const MESH_MODEL_SEATS = [
  { id: 'instflowpro', name: 'InstFlowPro', weight: 0.8, caps: ['altdata.congress', 'altdata.insider'], markets: ['GLOBALFUTURES'] },
  { id: 'techconsensus', name: 'TechConsensus', weight: 0.7, caps: ['news.sentiment'], markets: ['GLOBALFUTURES', 'INDIA'] },
  { id: 'fundaproplus', name: 'FundaProPlus', weight: 0.55, caps: ['stocks.fundamentals', 'fundamentals.profile'], markets: ['INDIA', 'GLOBALFUTURES'] },
  { id: 'cryptoonchain', name: 'CryptoOnChainPro', weight: 0.6, caps: ['crypto.onchain', 'crypto.tick'], markets: ['CRYPTO', 'FUTURES'] },
];

/** Rollout flag — same A/B discipline as AI_ENABLE_V2_MODELS.
 *  v21.11.0: DEFAULT ON. Seats SHADOW mode me hote hain
 *  (applyMeshModelGating → weight 0) — consensus math par zero effect,
 *  sirf ledger evidence collect hota hai jab tak meshModelAccountability
 *  settled outcomes se seat promote kare. Ye the designed zero-risk
 *  upgrade path hai.
 *  v21.12.0 (master switch): AI_ACCURACY_SUITE (default ON) ke ON hone
 *  par mesh seats UNCONDITIONALLY ON — stale AI_ENABLE_MESH_MODELS=false
 *  ab ignored (v21.11.0 tak explicit false jeet-ta tha, isi se user ke
 *  box pe 13-seat pin ho gaya tha). Legacy A/B: AI_ACCURACY_SUITE=false. */
export function meshModelsEnabled() {
  if (accuracySuiteEnabled()) return true;
  return legacyFlagEnabled('AI_ENABLE_MESH_MODELS');
}

// ---------------- Phase 3: tiered, budget-aware warm ----------------
/** Re-query gaps per cap class — mesh-cache-aligned, budget-stretched. */
const REQ_GAP_MS = {
  hot: 2 * 60_000,          // crypto.tick — aligns with the 30s hot cache, stretched 2min
  warm: 30 * 60_000,        // news.sentiment — aligns with the 5min warm cache, stretched 30min
  cold: 4 * 60 * 60_000,    // altdata/fundamentals/onchain — aligns with the 60min cold cache, stretched 4h
};

/** Phase 1B honesty-gate staleness caps (how old warmed data may be
 *  before the vote abstains — independent of the mesh's own tags). */
export const MESH_CAP_STALENESS_MS = {
  'crypto.tick': 90_000,            // hot — 90s
  'news.sentiment': 15 * 60_000,    // warm — 15min
  'altdata.congress': 2 * 60 * 60_000,   // cold — 2h
  'altdata.insider': 2 * 60 * 60_000,
  'stocks.fundamentals': 2 * 60 * 60_000,
  'fundamentals.profile': 2 * 60 * 60_000,
  'crypto.onchain': 2 * 60 * 60_000,
};

const CAP_CLASS = {
  'crypto.tick': 'hot',
  'news.sentiment': 'warm',
  'altdata.congress': 'cold', 'altdata.insider': 'cold',
  'stocks.fundamentals': 'cold', 'fundamentals.profile': 'cold',
  'crypto.onchain': 'cold',
};

const TOP_N = () => Math.max(4, Math.min(20, Number(process.env.AI_MESH_T3_TOP_N) || 12));
const BATCH_N = () => Math.max(2, Math.min(12, Number(process.env.AI_MESH_T3_BATCH) || 8));

/** market → the caps each desk's mesh seats consume. */
function capsForMarket(mkt) {
  if (mkt === 'CRYPTO' || mkt === 'FUTURES') return ['crypto.onchain', 'crypto.tick'];
  if (mkt === 'GLOBALFUTURES') return ['altdata.congress', 'altdata.insider', 'stocks.fundamentals', 'fundamentals.profile', 'news.sentiment'];
  if (mkt === 'INDIA') return ['stocks.fundamentals', 'fundamentals.profile', 'news.sentiment'];
  return [];
}

/** India NSE names ride Alpha Vantage's BSE suffix (RELIANCE → RELIANCE.BSE). */
const meshSymbolFor = (mkt, sym) => (mkt === 'INDIA' ? `${sym}.BSE` : sym);

// store: `${mkt}|${sym}` → { at, caps: { cap → {ok, data?, agent?, ts?, stale?, reason?} } }
const _store = new Map();
// cadence guard: `${cap}|${mkt}|${sym}` → last real mesh query ts
const _lastQueryAt = new Map();
const _warmStats = { warmTicks: 0, queriesIssued: 0, capsServed: 0, gaps: 0 };

/**
 * PHASE 3 warm — T3 slice only. Fire-and-forget safe: never throws,
 * per-(cap,symbol) cadence guard, per-tick batch cap, and the mesh's
 * own token buckets / breakers are the hard limiter (a gap comes back
 * as {ok:false} and the vote honestly abstains — visibly).
 *
 * @param {string} market INDIA | CRYPTO | FUTURES | GLOBALFUTURES
 * @param {string[]} symbols the desk's TOP slice (top-N by turnover /
 *        rank — never the full universe at board cadence)
 */
export async function warmMeshModels(market, symbols) {
  const mkt = String(market || '').toUpperCase();
  const caps = capsForMarket(mkt);
  if (caps.length === 0) return;
  const syms = (Array.isArray(symbols) ? symbols : [])
    .map(s => String(s || '').toUpperCase().replace(/[^A-Z0-9.-]/g, ''))
    .filter(Boolean)
    .filter(s => mkt !== 'INDIA' || !s.endsWith('.BSE'))
    .slice(0, TOP_N());
  if (syms.length === 0) return;
  _warmStats.warmTicks += 1;

  // v20.1 FIX (deep audit): age-sweep the warm-seat store — _store and
  // _lastQueryAt never evicted, so every symbol that ever entered a warm
  // tick (rotating CoinDCX pairs + full India F&O discovery) lived for the
  // process lifetime. Symbols nobody re-queried for 30 min now drop out
  // (the data.js candle-cache hygiene pattern).
  try {
    const sweepNow = Date.now();
    const SWEEP_MS = 30 * 60_000;
    for (const [k, rec] of _store) if (sweepNow - (rec?.at || 0) > SWEEP_MS) _store.delete(k);
    for (const [k, ts] of _lastQueryAt) if (sweepNow - ts > SWEEP_MS) _lastQueryAt.delete(k);
  } catch { /* sweep never breaks the warm */ }

  // which (cap,symbol) pairs actually need a real mesh query this tick?
  const now = Date.now();
  const needed = [];
  for (const sym of syms) {
    for (const cap of caps) {
      const key = `${cap}|${mkt}|${sym}`;
      const last = _lastQueryAt.get(key) || 0;
      const gap = REQ_GAP_MS[CAP_CLASS[cap] || 'warm'];
      if (now - last >= gap) needed.push({ cap, sym, key });
    }
  }
  // oldest-first round robin — budget spreads across ticks instead of
  // burning every bucket in the first warm of the day
  needed.sort((a, b) => ((_lastQueryAt.get(a.key) || 0) - (_lastQueryAt.get(b.key) || 0)));
  const batch = needed.slice(0, BATCH_N());
  for (const { cap: _cap, sym: _sym, key } of batch) _lastQueryAt.set(key, now);
  if (batch.length > 0) _warmStats.queriesIssued += batch.length;

  await Promise.allSettled(batch.map(async ({ cap, sym }) => {
    const result = await meshQuery({ capabilities: [cap], symbols: [meshSymbolFor(mkt, sym)] });
    const rec = _store.get(`${mkt}|${sym}`) || { at: now, caps: {} };
    rec.at = now;
    const r = result?.results?.[cap];
    if (r) {
      rec.caps[cap] = { ok: true, data: r.data ?? null, agent: r.agent ?? null, ts: r.ts ?? now, stale: r.stale === true };
      _warmStats.capsServed += 1;
    } else {
      const gap = (result?.gaps || []).find(g => g.cap === cap);
      rec.caps[cap] = { ok: false, reason: gap?.reason || result?.reason || 'no honest data' };
      _warmStats.gaps += 1;
    }
    _store.set(`${mkt}|${sym}`, rec);
  }));
}

// ---------------- Phase 1B: the honesty gate ----------------
/**
 * Read one warmed (cap,symbol) through the honesty gate.
 * @returns {{ok:true, data, agent, ts, ageMs} | {ok:false, reason}}
 */
function readGuarded(mkt, sym, cap) {
  const rec = _store.get(`${mkt}|${sym}`);
  const capRec = rec?.caps?.[cap];
  if (!rec || !capRec) return { ok: false, reason: `${cap} not warmed for ${sym} yet — model abstains (honest degrade)` };
  if (capRec.ok !== true) return { ok: false, reason: `${cap} unavailable for ${sym} (${capRec.reason || 'mesh gap'} — budget-exhausted or breaker-open agent?) — model abstains` };
  if (capRec.stale === true) {
    return { ok: false, reason: `${cap} for ${sym} tagged STALE by the mesh (serving cached fallback) — honesty gate: model abstains rather than vote on stale data` };
  }
  const age = Date.now() - (Number(capRec.ts) || 0);
  const capMs = MESH_CAP_STALENESS_MS[cap] || 15 * 60_000;
  if (!(age >= 0) || age > capMs) {
    return { ok: false, reason: `${cap} for ${sym} is ${Math.max(0, Math.round(age / 60000))}min old (cap ${Math.round(capMs / 60000)}min) — honesty gate: model abstains` };
  }
  return { ok: true, data: capRec.data, agent: capRec.agent, ts: capRec.ts, ageMs: age };
}

const abstain = (reasons, na = false) => vote(0, 0, reasons, na);

// ---------------- 15. InstFlowPro — quiver institutional flow ----------------
/** Recency weight: a trade filed this week matters ~4× one from a month ago. */
const recencyW = (daysAgo) => (daysAgo == null || !Number.isFinite(daysAgo) ? 0.5 : 1 / (1 + Math.max(0, daysAgo) / 14));

export function instFlowProVote(ctx) {
  const mkt = String(ctx?.market || '').toUpperCase();
  const sym = String(ctx?.symbol || '').toUpperCase();
  if (mkt !== 'GLOBALFUTURES') {
    // v11.8 `na: true` — structural: Quiver alt-data covers US tickers only.
    return abstain(['InstFlowPro abstains — Quiver congressional/insider alt-data covers US tickers (global desk only)'], true);
  }
  const congress = readGuarded(mkt, sym, 'altdata.congress');
  const insider = readGuarded(mkt, sym, 'altdata.insider');
  if (!congress.ok && !insider.ok) {
    return abstain([congress.ok ? null : congress.reason, insider.ok ? null : insider.reason].filter(Boolean).slice(0, 2));
  }

  const pts = [];
  let score = 0;
  let nTrades = 0;

  if (congress.ok && Array.isArray(congress.data?.trades)) {
    let cScore = 0, buys = 0, sells = 0;
    for (const t of congress.data.trades) {
      const tx = String(t?.transaction || '').toUpperCase();
      if (!tx.includes('BUY') && !tx.includes('SELL')) continue;
      const w = recencyW(t.daysAgo);
      const s = tx.includes('BUY') ? 1 : -1;
      cScore += s * w;
      if (s > 0) buys++; else sells++;
      nTrades++;
    }
    if (buys + sells > 0) {
      score += cScore * 0.8;
      pts.push(`Congress flow (${congress.agent}): ${buys} buys vs ${sells} sells, recency-weighted ${cScore >= 0 ? '+' : ''}${r1(cScore)}`);
    }
  }
  if (insider.ok && Array.isArray(insider.data?.transactions)) {
    let iScore = 0, buys = 0, sells = 0;
    for (const t of insider.data.transactions) {
      const tx = String(t?.transaction || '').toUpperCase();
      if (!tx.includes('BUY') && !tx.includes('SELL')) continue;
      const w = recencyW(t.daysAgo);
      // classic read: insider BUYING is informative (they only buy when
      // they believe); routine SELLING is noisy (compensation cash-outs)
      const s = tx.includes('BUY') ? 1 : -0.5;
      iScore += s * w;
      if (s > 0) buys++; else sells++;
      nTrades++;
    }
    if (buys + sells > 0) {
      score += iScore * 1.2; // insiders know the company best
      pts.push(`Insider flow (${insider.agent}): ${buys} buys vs ${sells} sells (sells half-weighted — comp cash-outs are noise)`);
    }
  }

  if (nTrades < 2) {
    return abstain([`Quiver flow for ${sym}: only ${nTrades} usable transaction(s) — below the 2-trade floor, model abstains`]);
  }
  const dir = score > 1.2 ? 1 : score < -1.2 ? -1 : 0;
  if (dir === 0) {
    return abstain([`Institutional flow mixed for ${sym} (net ${r1(score)} across ${nTrades} transactions) — no edge, model abstains`]);
  }
  const conf = clamp(42 + Math.min(16, (Math.abs(score) - 1.2) * 8));
  pts.push(`net smart-money footprint ${dir > 0 ? 'supportive' : 'distributive'} — ${nTrades} recent transactions`);
  return vote(dir, conf, pts);
}

// ---------------- 16. TechConsensus — tradingcentral independent read ----------------
export function techConsensusVote(ctx) {
  const mkt = String(ctx?.market || '').toUpperCase();
  const sym = String(ctx?.symbol || '').toUpperCase();
  if (mkt !== 'GLOBALFUTURES' && mkt !== 'INDIA') {
    // v11.8 `na: true` — structural: the vendor read serves equity desks only.
    return abstain(['TechConsensus abstains — the independent vendor read serves the equity desks (global/India)'], true);
  }
  const sent = readGuarded(mkt, sym, 'news.sentiment');
  if (!sent.ok) return abstain([sent.reason]);
  const items = Array.isArray(sent.data?.items) ? sent.data.items : [];
  if (items.length === 0) {
    return abstain([`TradingCentral served no sentiment rows for ${sym} — model abstains`]);
  }

  // the vendor aggregates per-symbol; keep only this symbol's rows (or
  // all rows when the vendor omits the symbol field)
  const mine = items.filter(i => !i.symbol || String(i.symbol).toUpperCase() === sym);
  const rows = mine.length > 0 ? mine : items;

  let score = 0, bulls = 0, bears = 0;
  for (const i of rows) {
    const s = String(i?.sentiment || '').toLowerCase();
    let sgn = 0;
    if (s.includes('bull') || s.includes('buy') || s === 'positive') sgn = 1;
    else if (s.includes('bear') || s.includes('sell') || s === 'negative') sgn = -1;
    const sc = Number(i?.score);
    if (sgn === 0 && Number.isFinite(sc) && sc !== 0) sgn = sc > 0 ? 1 : -1;
    if (sgn === 0) continue;
    score += sgn;
    if (sgn > 0) bulls++; else bears++;
  }
  if (bulls + bears === 0) {
    return abstain([`TradingCentral sentiment rows for ${sym} carry no readable direction — model abstains`]);
  }
  const dir = score > 1 ? 1 : score < -1 ? -1 : 0;
  if (dir === 0) {
    return abstain([`Independent vendor read split for ${sym} (${bulls} bull vs ${bears} bear rows) — no consensus edge, model abstains`]);
  }
  // deliberately modest conf: this is a SECOND opinion, not a primary
  // signal — its value is agreement/divergence with our own stack
  const conf = clamp(40 + Math.min(14, Math.abs(score) * 3));
  return vote(dir, conf, [
    `Independent vendor consensus (${sent.agent}): ${bulls} bull vs ${bears} bear rows for ${sym}`,
    `a methodology OUTSIDE our own ${'TA'} stack — agreement with the committee is real diversification, disagreement is a flag`,
  ]);
}

// ---------------- 17. FundaProPlus — alphavantage + massive deep fundamentals ----------------
export function fundaProPlusVote(ctx) {
  const mkt = String(ctx?.market || '').toUpperCase();
  const sym = String(ctx?.symbol || '').toUpperCase();
  if (mkt !== 'INDIA' && mkt !== 'GLOBALFUTURES') {
    // v11.8 `na: true` — structural: fundamentals serve equity desks only.
    return abstain(['FundaProPlus abstains — fundamentals serve the equity desks (India swing / global)'], true);
  }
  const av = readGuarded(mkt, sym, 'stocks.fundamentals');
  const massive = readGuarded(mkt, sym, 'fundamentals.profile');
  if (!av.ok && !massive.ok) {
    return abstain([av.ok ? null : av.reason, massive.ok ? null : massive.reason].filter(Boolean).slice(0, 2));
  }
  // merge: alphavantage OVERVIEW is the richer payload; massive is the
  // independent second read (cross-validated where both serve)
  const f = {};
  for (const src of [massive.ok ? massive.data : null, av.ok ? av.data : null]) {
    if (!src) continue;
    f.peRatio = Number.isFinite(Number(src.peRatio)) ? Number(src.peRatio) : f.peRatio ?? null;
    f.forwardPE = Number.isFinite(Number(src.forwardPE)) ? Number(src.forwardPE) : f.forwardPE ?? null;
    f.profitMargin = Number.isFinite(Number(src.profitMargin)) ? Number(src.profitMargin) : f.profitMargin ?? null;
    f.beta = Number.isFinite(Number(src.beta)) ? Number(src.beta) : f.beta ?? null;
    f.dividendYield = Number.isFinite(Number(src.dividendYield)) ? Number(src.dividendYield) : f.dividendYield ?? null;
    f.sector = f.sector || src.sector || null;
  }

  const pts = [];
  let score = 0;
  let factors = 0;
  const sources = [av.ok ? av.agent : null, massive.ok ? massive.agent : null].filter(Boolean).join(' + ');

  // earnings trajectory: forward < trailing × 0.9 → street expects
  // growth (the classic value+momentum hybrid read)
  if (f.peRatio != null && f.peRatio > 0 && f.forwardPE != null && f.forwardPE > 0) {
    const ratio = f.forwardPE / f.peRatio;
    if (ratio < 0.9) { score += 1.2; pts.push(`forward P/E ${r1(f.forwardPE)} < trailing ${r1(f.peRatio)} — earnings expected to GROW`); }
    else if (ratio > 1.1) { score -= 1.2; pts.push(`forward P/E ${r1(f.forwardPE)} > trailing ${r1(f.peRatio)} — earnings deteriorating`); }
    else pts.push(`P/E stable (${r1(f.peRatio)} → ${r1(f.forwardPE)})`);
    factors++;
  }
  // earnings quality: margin is the survivability gauge
  if (f.profitMargin != null) {
    if (f.profitMargin > 0.15) { score += 0.6; pts.push(`profit margin ${Math.round(f.profitMargin * 100)}% — high-quality earner`); }
    else if (f.profitMargin > 0) pts.push(`profit margin ${Math.round(f.profitMargin * 100)}% — thin but positive`);
    else { score -= 0.8; pts.push(`negative profit margin — burning cash`); }
    factors++;
  }
  if (f.beta != null && f.beta > 1.6) {
    pts.push(`beta ${r1(f.beta)} — high-vol name, fundamentals matter less`);
  }
  if (factors === 0) {
    return abstain([`Fundamentals for ${sym} arrived without usable P/E / margin fields (${sources || 'no source'}) — model abstains`]);
  }
  const dir = score > 0.8 ? 1 : score < -0.8 ? -1 : 0;
  if (dir === 0) {
    return abstain([`Fundamental picture neutral for ${sym} (net ${r1(score)}) — model abstains`]);
  }
  // fundamentals are SLOW context: never a loud vote, never an
  // intraday trigger — conf stays in the honest 40-54 band
  const conf = clamp(40 + Math.min(14, (Math.abs(score) - 0.8) * 9));
  pts.push(`sources: ${sources} (mesh, cross-validated where both serve)`);
  return vote(dir, conf, pts);
}

// ---------------- 18. CryptoOnChainPro — coingecko on-chain context + coinapi ticks ----------------
export function cryptoOnChainProVote(ctx) {
  const mkt = String(ctx?.market || '').toUpperCase();
  const sym = String(ctx?.symbol || '').toUpperCase();
  if (mkt !== 'CRYPTO' && mkt !== 'FUTURES') {
    // v11.8 `na: true` — structural: on-chain context serves crypto desks only.
    return abstain(['CryptoOnChainPro abstains — on-chain/dev context serves the crypto desks'], true);
  }
  const onchain = readGuarded(mkt, sym, 'crypto.onchain');
  const tick = readGuarded(mkt, sym, 'crypto.tick');
  if (!onchain.ok && !tick.ok) {
    return abstain([onchain.ok ? null : onchain.reason, tick.ok ? null : tick.reason].filter(Boolean).slice(0, 2));
  }

  const pts = [];
  let score = 0;
  let factors = 0;

  if (onchain.ok) {
    const d = onchain.data || {};
    // distance from ATH — cycle-position context
    const ath = Number(d.athChangePct);
    if (Number.isFinite(ath)) {
      if (ath > -15) { score += 0.4; pts.push(`${r1(ath)}% from ATH — near cycle highs (strength)`); factors++; }
      else if (ath < -70) { score -= 0.4; pts.push(`${r1(ath)}% from ATH — deep decay territory`); factors++; }
      else pts.push(`${r1(ath)}% from ATH — mid-cycle`);
    }
    // developer activity — the single most-predictive on-chain health
    // metric CoinGecko serves (falling-star repos bleed for quarters)
    const lcd = Number(d.developer?.lastCommitDays);
    if (Number.isFinite(lcd)) {
      if (lcd <= 7) { score += 0.5; pts.push(`last commit ${lcd}d ago — repo ALIVE`); factors++; }
      else if (lcd >= 60) { score -= 0.7; pts.push(`last commit ${lcd}d ago — repo effectively DEAD`); factors++; }
      else pts.push(`last commit ${lcd}d ago — normal cadence`);
    }
    // 24h volume in USD — participation context
    const vol = Number(d.totalVolumeUsd);
    if (Number.isFinite(vol) && vol > 0) {
      pts.push(`24h volume $${(vol / 1e6).toFixed(0)}M (${onchain.agent})`);
    }
    if (d.community?.twitterFollowers != null) {
      pts.push(`community: ${Number(d.community.twitterFollowers).toLocaleString('en')} X followers`);
    }
  }
  if (tick.ok) {
    // tick drift: the last N prints' direction — an aggression proxy
    // (domain-free ratio, works on USD/USDT/INR books alike)
    const trades = Array.isArray(tick.data?.trades) ? tick.data.trades : [];
    const prices = trades.map(t => Number(t?.price)).filter(p => Number.isFinite(p) && p > 0);
    if (prices.length >= 2) {
      const drift = (prices[prices.length - 1] - prices[0]) / prices[0] * 100;
      if (drift > 0.15) { score += 0.3; pts.push(`last ${prices.length} prints drift +${r2(drift)}% — buy aggression (${tick.agent})`); factors++; }
      else if (drift < -0.15) { score -= 0.3; pts.push(`last ${prices.length} prints drift ${r2(drift)}% — sell aggression (${tick.agent})`); factors++; }
    }
  }

  if (factors === 0) {
    return abstain([`On-chain context for ${sym} arrived without readable fields — model abstains`]);
  }
  const dir = score > 0.6 ? 1 : score < -0.6 ? -1 : 0;
  if (dir === 0) {
    return abstain([`On-chain context mixed for ${sym} (net ${r1(score)}) — model abstains`]);
  }
  // context-grade seat: on-chain data is genuinely NEW information vs
  // price/volume technicals, but its directional power is modest — the
  // conf band says so honestly
  const conf = clamp(40 + Math.min(12, (Math.abs(score) - 0.6) * 10));
  return vote(dir, conf, pts);
}

// ---------------- Phase 2: shadow-mode promotion (pure ledger fn) ----------------
/** Same threshold concept the trust system uses (trust.js MIN_SETTLED). */
export const MESH_MIN_SETTLED = 10;
export const MESH_RETIRE_N = 30;
export const MESH_RETIRE_EDGE = -5;

function _settledEntries() {
  return (__ledgerRaw()?.entries || []).filter(e => e?.outcome && e.outcome.r != null);
}

const _winRate = (rows) => (rows.length > 0
  ? Math.round((rows.filter(e => (e.outcome.r ?? 0) > 0).length / rows.length) * 1000) / 10
  : null);

/**
 * The promotion ledger: per mesh seat, trades where it VOTED (non-zero
 * dir) vs trades where it ABSTAINED — the plan's exact question ("did
 * trades where this model agreed actually win more?"). PURE — restart
 * can't lose it, tamper-evident chain feeds it.
 */
export function meshModelAccountability({ settled = _settledEntries() } = {}) {
  const models = MESH_MODEL_SEATS.map(seat => {
    const voted = settled.filter(e => e.votes?.[seat.id] && e.votes[seat.id].dir !== 0);
    const abstained = settled.filter(e => !e.votes?.[seat.id] || e.votes[seat.id].dir === 0);
    const whenVotedWR = _winRate(voted);
    const whenAbstainedWR = _winRate(abstained);
    const edge = (whenVotedWR != null && whenAbstainedWR != null) ? Math.round((whenVotedWR - whenAbstainedWR) * 10) / 10 : null;
    // own attribution hit-rate (the modelStats rule — a model "wins"
    // when its recorded dir matched the settled outcome)
    let wins = 0, losses = 0;
    for (const e of voted) {
      const win = (e.outcome.r ?? 0) > 0;
      const alignedWithSide = (e.votes[seat.id].dir > 0) === (e.side !== 'SHORT');
      if (alignedWithSide === win) wins++; else losses++;
    }
    const n = wins + losses;

    // ---- the promotion ladder (Phase 2) ----
    let mode = 'shadow';
    let note = `shadow-mode: ${n}/${MESH_MIN_SETTLED} attributed settled outcomes — vote journaled, weight 0 until proven`;
    if (n >= MESH_MIN_SETTLED && edge != null) {
      if (edge > 0) {
        mode = 'voting';
        note = `promoted: trades with this seat voting won ${whenVotedWR}% vs ${whenAbstainedWR}% when it abstained (edge +${edge} pts over ${n} outcomes)`;
      } else if (n >= MESH_RETIRE_N && edge <= MESH_RETIRE_EDGE) {
        mode = 'retired';
        note = `retired: edge ${edge} pts over ${n} outcomes — kept shadow-journaled for re-review but carries no weight`;
      } else {
        mode = 'shadow';
        note = `no measurable edge yet (${edge != null ? `${edge > 0 ? '+' : ''}${edge} pts over ${n} outcomes) — stays shadow` : 'insufficient paired data'}`;
      }
    }
    return {
      id: seat.id,
      name: seat.name,
      meshCaps: seat.caps,
      markets: seat.markets,
      baseWeight: seat.weight,
      mode,
      effectiveWeight: mode === 'voting' ? seat.weight : 0,
      n,
      hitRate: n > 0 ? Math.round((wins / n) * 1000) / 10 : null,
      whenVotedWR,
      whenAbstainedWR,
      edge,
      note,
    };
  });
  return {
    ok: true,
    minSettled: MESH_MIN_SETTLED,
    retireN: MESH_RETIRE_N,
    models,
    settledTotal: settled.length,
    note: 'Mesh-backed seats earn voting weight ONLY on settled outcomes: trades where the seat voted must win more often than trades where it abstained (the Phase-2 proving rule). Shadow votes are journaled in the tamper-evident ledger but carry weight 0. More data ≠ better signals until the numbers say so.',
  };
}

/** Fast seat-state lookup for the vote path. */
function _seatModes() {
  const out = {};
  for (const m of meshModelAccountability().models) out[m.id] = m.mode;
  return out;
}

// ---------------- Phase 1C: cross-correlation guard (pure ledger fn) ----------------
export const MESH_CORR_MIN_N = 20;
export const MESH_CORR_HARD = 0.85;
export const MESH_CORR_SOFT = 0.70;

function _pearsonDirs(pairs) {
  const n = pairs.length;
  if (n < 2) return null;
  const xs = pairs.map(p => p.a), ys = pairs.map(p => p.b);
  const mx = xs.reduce((s, v) => s + v, 0) / n;
  const my = ys.reduce((s, v) => s + v, 0) / n;
  let num = 0, dx = 0, dy = 0;
  for (let i = 0; i < n; i++) {
    const a = xs[i] - mx, b = ys[i] - my;
    num += a * b; dx += a * a; dy += b * b;
  }
  if (dx <= 0 || dy <= 0) return null;
  return num / Math.sqrt(dx * dy);
}

/**
 * Correlate each mesh seat's recorded votes against TrendMatrix and
 * MomentumQuant (the two seats the plan names as the redundancy risk).
 * corr > 0.85 → ×0.5 weight; > 0.70 → ×0.75; overlap < 20 entries →
 * refuse to discount on noise (discount 1.0, verdict 'insufficient-overlap').
 */
export function meshCorrelationView({ entries = (__ledgerRaw()?.entries || []) } = {}) {
  const out = {};
  for (const seat of MESH_MODEL_SEATS) {
    let best = { vs: null, corr: null, n: 0 };
    for (const ref of ['trend', 'momentum']) {
      const pairs = [];
      for (const e of entries) {
        const a = e?.votes?.[seat.id]?.dir;
        const b = e?.votes?.[ref]?.dir;
        if (Number.isFinite(a) && a !== 0 && Number.isFinite(b) && b !== 0) pairs.push({ a, b });
      }
      const corr = _pearsonDirs(pairs);
      if (corr != null && (best.corr == null || Math.abs(corr) > Math.abs(best.corr))) {
        best = { vs: ref, corr: Math.round(corr * 1000) / 1000, n: pairs.length };
      }
    }
    let discount = 1;
    let verdict = 'independent';
    if (best.n < MESH_CORR_MIN_N || best.corr == null) {
      verdict = 'insufficient-overlap';
    } else if (best.corr > MESH_CORR_HARD) {
      discount = 0.5;
      verdict = 'redundant';
    } else if (best.corr > MESH_CORR_SOFT) {
      discount = 0.75;
      verdict = 'partially-redundant';
    }
    out[seat.id] = {
      corr: best.corr,
      vs: best.vs,
      overlapN: best.n,
      discount,
      verdict,
      note: verdict === 'redundant'
        ? `votes correlate ${best.corr} with ${best.vs} — restating existing models, weight halved (false-diversity guard)`
        : verdict === 'partially-redundant'
          ? `votes correlate ${best.corr} with ${best.vs} — weight ×0.75 pending more overlap`
          : verdict === 'insufficient-overlap'
            ? `only ${best.n} overlapping votes vs ${best.vs || 'trend/momentum'} — refuse to discount on noise`
            : `independent of trend/momentum (corr ${best.corr ?? 'n/a'}) — real diversification`,
    };
  }
  return {
    ok: true,
    minOverlap: MESH_CORR_MIN_N,
    hard: MESH_CORR_HARD,
    soft: MESH_CORR_SOFT,
    seats: out,
    note: 'False-diversity guard: a new seat that just restates TrendMatrix/MomentumQuant inflates apparent confidence without adding information. corr > 0.85 → ×0.5, > 0.70 → ×0.75, < 20 overlapping votes → no discount (honest).',
  };
}

// ---------------- the vote-path gate (Phases 1C + 2 combined) ----------------
/**
 * Apply mesh-seat gating to a votes array (COPY — input never mutated).
 *   shadow/retired → weight 0 + shadow marker (vote stays for the
 *                    journal + UI; aggregateVotes ignores weight 0)
 *   voting         → base weight × correlation discount (1C)
 * Flag OFF → votes returned as-is (no seats exist anyway).
 */
export function applyMeshModelGating(votes, { seats = _seatModes(), corr = null } = {}) {
  if (!meshModelsEnabled()) return votes;
  const corrMap = corr || meshCorrelationView().seats;
  return (votes || []).map(v => {
    if (!v || !MESH_MODEL_IDS.includes(v.id)) return v;
    const mode = seats[v.id] || 'shadow';
    if (mode !== 'voting') {
      return { ...v, weight: 0, shadow: true, meshMode: mode };
    }
    const disc = corrMap[v.id]?.discount;
    if (Number.isFinite(disc) && disc > 0 && disc < 1) {
      return {
        ...v,
        weight: Math.round(v.weight * disc * 1000) / 1000,
        meshMode: 'voting',
        corrDiscount: disc,
      };
    }
    return { ...v, meshMode: 'voting' };
  });
}

// ---------------- Phase 3: warm/ops status view ----------------
export function meshModelsWarmView() {
  const byMarket = {};
  for (const [key, rec] of _store.entries()) {
    const [mkt, _sym] = key.split('|');
    if (!byMarket[mkt]) byMarket[mkt] = { symbols: 0, capsServed: 0, capsGapped: 0, staleCapped: 0 };
    byMarket[mkt].symbols += 1;
    for (const [cap, c] of Object.entries(rec.caps || {})) {
      if (c.ok === true) {
        byMarket[mkt].capsServed += 1;
        const age = Date.now() - (Number(c.ts) || 0);
        if (age > (MESH_CAP_STALENESS_MS[cap] || 15 * 60_000)) byMarket[mkt].staleCapped += 1;
      } else {
        byMarket[mkt].capsGapped += 1;
      }
    }
  }
  return {
    topN: TOP_N(),
    batchPerTick: BATCH_N(),
    requeryGaps: { hot: '2min', warm: '30min', cold: '4h' },
    stats: { ..._warmStats },
    byMarket,
    note: 'T3-only mesh usage: the top slice warms at budget-aware cadence (mesh cache tiers × stretched gaps); the mesh token buckets are the hard limiter — a budget-exhausted agent shows up as capsGapped + honest abstentions.',
  };
}

/** /api/ai/status block — seats + warm state in one honest view. */
export function meshModelsStatusView() {
  return {
    enabled: meshModelsEnabled(),
    flag: 'AI_ENABLE_MESH_MODELS',
    seats: meshModelAccountability().models.map(m => ({
      id: m.id, name: m.name, mode: m.mode, baseWeight: m.baseWeight,
      effectiveWeight: m.effectiveWeight, markets: m.markets, meshCaps: m.meshCaps,
      n: m.n, hitRate: m.hitRate, edge: m.edge,
    })),
    warm: meshModelsWarmView(),
  };
}

// ---------------- Phase 4: the weekly contribution report ----------------
/**
 * Mesh-model contribution over the rolling week: each seat's own
 * settled attribution (n / hit-rate) plus the standing promotion math
 * (when-voted vs when-abstained win-rates). This is the number that
 * answers "did adding Quiver/TradingCentral/etc. actually help?"
 */
export function meshModelWeek({ now = Date.now(), days = 7 } = {}) {
  const since = now - days * 86_400_000;
  const settled = _settledEntries().filter(e => (e.outcome.ts || e.ts || 0) >= since);
  const allTime = meshModelAccountability();
  const week = {};
  for (const seat of MESH_MODEL_SEATS) {
    let wins = 0, losses = 0;
    for (const e of settled) {
      const v = e.votes?.[seat.id];
      if (!v || v.dir === 0) continue;
      const win = (e.outcome.r ?? 0) > 0;
      const alignedWithSide = (v.dir > 0) === (e.side !== 'SHORT');
      if (alignedWithSide === win) wins++; else losses++;
    }
    const n = wins + losses;
    week[seat.id] = {
      n,
      wins, losses,
      hitRate: n > 0 ? Math.round((wins / n) * 1000) / 10 : null,
    };
  }
  return {
    ok: true,
    days,
    week,
    allTime,
    note: 'Mesh-model contribution: per-seat settled attribution this week + the all-time promotion math (trades with the seat voting vs without). A seat that shows no edge stays shadow — that is the honest answer, not a failure.',
  };
}

// ---------------- test hooks ----------------
export function __resetMeshModelsForTests() {
  _store.clear();
  _lastQueryAt.clear();
  Object.assign(_warmStats, { warmTicks: 0, queriesIssued: 0, capsServed: 0, gaps: 0 });
}

/** Inject a warmed cap result (age-controlled) — resilience tests. */
export function __setWarmedCapForTests(mkt, sym, cap, payload, ageMs = 0) {
  const key = `${String(mkt).toUpperCase()}|${String(sym).toUpperCase()}`;
  const rec = _store.get(key) || { at: Date.now(), caps: {} };
  const ts = Date.now() - Math.max(0, Number(ageMs) || 0);
  rec.caps[cap] = payload && payload.ok !== false
    ? { ok: true, data: payload.data ?? null, agent: payload.agent ?? 'test', ts, stale: payload.stale === true }
    : { ok: false, reason: payload?.reason || 'test gap' };
  rec.at = ts;
  _store.set(key, rec);
}

export const __testables = {
  _store, _lastQueryAt, readGuarded, capsForMarket, meshSymbolFor,
  REQ_GAP_MS, CAP_CLASS, recencyW, _pearsonDirs, _seatModes,
};
