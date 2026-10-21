// ============================================================
// server/ai/directionLock.js — v21.23.0 Cross-Engine Direction Lock
// & Single Source of Truth Direction Resolver
// ------------------------------------------------------------
// Prevents multiple engines (Board Ensemble Auto-Agent, PRO AUTO,
// Crypto/India Agent, and MTF Auto-Link) from opening opposite-side
// (LONG vs SHORT) trades on the same symbol within the flip-cooldown
// window, and provides `resolveDirection()` as the single source of
// truth for cross-engine direction verification (MTF Plan vs Board
// Ensemble vs SVA Verifier vs AI Council).
// ============================================================

const DEFAULT_FLIP_LOCK_MIN = 240; // 4h flip-reentry cooldown (matches flipReentryBlockMin)
const _locks = new Map(); // normSym -> { symbol, side, at, source, active, cooldownMs }

export function normalizeLockSymbol(raw) {
  let s = String(raw || '').toUpperCase().trim();
  if (!s) return '';
  s = s.replace(/^B-/, '').replace(/^(FUT_|GLOB_)/, '');
  s = s.replace(/[._-](USDT|USDC|INR|USD|PERP|EQ|NS|BO)$/, '');
  const m = s.match(/^([A-Z0-9]{2,10}?)(USDT|USDC|INR|USD)$/);
  if (m && m[1].length >= 2) return m[1];
  return s;
}

/**
 * Acquires or refreshes a per-symbol direction lock when an engine opens a position.
 */
export function acquireDirectionLock({
  symbol,
  side,
  source = 'engine',
  cooldownMin = DEFAULT_FLIP_LOCK_MIN,
  active = true,
  now = Date.now(),
} = {}) {
  const norm = normalizeLockSymbol(symbol);
  const normSide = String(side || '').toUpperCase();
  if (!norm || (normSide !== 'LONG' && normSide !== 'SHORT')) return null;
  const cooldownMs = Math.max(60_000, (Number(cooldownMin) || DEFAULT_FLIP_LOCK_MIN) * 60_000);
  const entry = {
    symbol: norm,
    side: normSide,
    at: Number(now) || Date.now(),
    source: String(source || 'engine'),
    active: Boolean(active),
    cooldownMs,
  };
  _locks.set(norm, entry);
  return entry;
}

/**
 * Marks a symbol's active position as closed while keeping the post-entry flip cooldown
 * (or clearing immediately when `clearCooldown = true`).
 */
export function releaseDirectionLock(symbol, { clearCooldown = false, now = Date.now() } = {}) {
  const norm = normalizeLockSymbol(symbol);
  if (!norm) return false;
  const cur = _locks.get(norm);
  if (!cur) return false;
  if (clearCooldown) {
    _locks.delete(norm);
    return true;
  }
  cur.active = false;
  cur.closedAt = Number(now) || Date.now();
  _locks.set(norm, cur);
  return true;
}

/**
 * Checks whether `requestedSide` ('LONG' | 'SHORT') is allowed on `symbol`.
 * Blocks opposite-side entries while another engine holds an active lock or is within cooldown.
 */
export function checkDirectionLock(symbol, requestedSide, { now = Date.now() } = {}) {
  const norm = normalizeLockSymbol(symbol);
  const reqSide = String(requestedSide || '').toUpperCase();
  if (!norm || (reqSide !== 'LONG' && reqSide !== 'SHORT')) {
    return { allowed: true, conflict: false, symbol: norm || null };
  }
  const cur = _locks.get(norm);
  if (!cur) return { allowed: true, conflict: false, symbol: norm };
  const ageMs = Math.max(0, (Number(now) || Date.now()) - (Number(cur.at) || 0));
  const expired = !cur.active && ageMs >= (Number(cur.cooldownMs) || DEFAULT_FLIP_LOCK_MIN * 60_000);
  if (expired) {
    _locks.delete(norm);
    return { allowed: true, conflict: false, symbol: norm };
  }
  if (cur.side !== reqSide) {
    return {
      allowed: false,
      conflict: true,
      symbol: norm,
      requestedSide: reqSide,
      lockedSide: cur.side,
      lockedBy: cur.source,
      lockedAt: cur.at,
      active: cur.active,
      reason: `cross-engine direction lock: ${norm} is locked ${cur.side} by ${cur.source} — opposite ${reqSide} entry blocked`,
    };
  }
  return {
    allowed: true,
    conflict: false,
    symbol: norm,
    lockedSide: cur.side,
    lockedBy: cur.source,
  };
}

export function getDirectionLocks(now = Date.now()) {
  const out = [];
  for (const [sym, cur] of _locks.entries()) {
    const ageMs = Math.max(0, now - (Number(cur.at) || 0));
    if (!cur.active && ageMs >= (Number(cur.cooldownMs) || DEFAULT_FLIP_LOCK_MIN * 60_000)) {
      _locks.delete(sym);
      continue;
    }
    out.push({ ...cur, ageMin: Math.round(ageMs / 60_000) });
  }
  return out;
}

/**
 * v21.23.1 FIX (the "lock kabhi release nahi hota" bug): release-on-close sweeper.
 * `acquireDirectionLock()` ke baad `releaseDirectionLock()` kahin call nahi hota tha —
 * `checkDirectionLock()` me `active:true` wala lock KABHI expire nahi karta, isliye ek baar
 * koi engine symbol X par trade kholta hi opposite side process-restart tak block rehti thi.
 *
 * Ye central reconciler caller ko saaf lagata hai: caller (routes.js 60s watcher) ALL open
 * position books (paper engine + MTF book + shared journal + SAPTA journal) se normalized
 * open-symbol set banata hai; jo ACTIVE lock us set me nahi hai → uska position band ho
 * chuka hai → `releaseDirectionLock()` (post-entry flip cooldown PRESERVED — release ke
 * baad bhi opposite side `at + cooldownMs` tak blocked rehti hai, whipsaw flip safe).
 *
 * PURE-ish: sirf directionLock state mutate karta hai — position state read caller karta hai.
 */
export function reconcileDirectionLocks(openSymbols, { now = Date.now() } = {}) {
  const openSet = new Set();
  for (const s of (Array.isArray(openSymbols) ? openSymbols : [])) {
    const norm = normalizeLockSymbol(s);
    if (norm) openSet.add(norm);
  }
  const released = [];
  for (const cur of getDirectionLocks(now)) {
    if (!cur.active) continue;               // already released (cooldown chal raha hai)
    if (openSet.has(cur.symbol)) continue;   // position abhi bhi kahin khula hai — hold
    if (releaseDirectionLock(cur.symbol, { now })) released.push(cur.symbol);
  }
  return { released, heldActive: getDirectionLocks(now).filter(l => l.active).length };
}

export function __resetDirectionLocksForTests() {
  _locks.clear();
}

/**
 * Single Source of Truth Direction Resolver (`resolveDirection`):
 * Evaluates MTF trade plan direction against Board Ensemble side, SVA Verifier action/finalCall,
 * AI Council verdict, MTF-6 snapshot, and active cross-engine symbol lock.
 */
export function resolveDirection({
  plan = null,
  boardSig = null,
  sva = null,
  council = null,
  mtf6 = null,
  symbol = null,
  dualAligned = null,
  worldAligned8Count = null,
  trapVeto = false,
  zoneWallVeto = false,
  reversalRisk = false,
} = {}) {
  const side = plan?.side === 'LONG' || plan?.side === 'SHORT' ? plan.side : null;
  const dir = side === 'LONG' ? 1 : side === 'SHORT' ? -1 : 0;

  const boardSideRaw = String(boardSig?.side || '').toUpperCase();
  const boardOpposes = (boardSideRaw === 'LONG' || boardSideRaw === 'SHORT')
    && (side === 'LONG' || side === 'SHORT')
    && boardSideRaw !== side;

  const svaObj = sva || boardSig?.verify || boardSig?.sva || null;
  const svaAct = String(svaObj?.action || '').toUpperCase();
  const svaFinal = String(svaObj?.finalCall || '').toUpperCase();
  const svaOpposes = Boolean(svaObj) && (
    svaAct === 'FLIP'
    || ((svaFinal === 'LONG' || svaFinal === 'SHORT') && (side === 'LONG' || side === 'SHORT') && svaFinal !== side)
  );

  const councilObj = council || boardSig?.aiCouncil || boardSig?.aiConfirm || null;
  const councilV = String(typeof councilObj === 'string' ? councilObj : (councilObj?.verdict || '')).toUpperCase();
  const councilHardNo = councilV === 'AVOID' || councilV === 'DISAGREE' || councilV === 'SKIP'
    || ((councilV === 'LONG' || councilV === 'SHORT') && (side === 'LONG' || side === 'SHORT') && councilV !== side);

  const mtf6Bias = String(mtf6?.htfBias || mtf6?.consensus || '').toUpperCase();
  const mtf6Opposes = (side === 'LONG' && mtf6Bias === 'BEARISH' && Number(mtf6?.agreementPct) >= 75)
    || (side === 'SHORT' && mtf6Bias === 'BULLISH' && Number(mtf6?.agreementPct) >= 75);

  const symKey = symbol || plan?.symbol || boardSig?.symbol || null;
  const lockCheck = symKey && side ? checkDirectionLock(symKey, side) : { allowed: true, conflict: false };
  const lockConflict = Boolean(lockCheck && !lockCheck.allowed);

  const conflicts = [];
  if (boardOpposes) conflicts.push(`board ensemble side ${boardSideRaw} ≠ MTF side ${side} (direction conflict)`);
  if (svaOpposes) conflicts.push('SVA verifier says FLIP / opposite side');
  if (councilHardNo) conflicts.push(`AI council ${councilV} (hard disagree)`);
  if (mtf6Opposes) conflicts.push(`MTF-6 bias ${mtf6Bias} against ${side} (${mtf6?.agreementPct}% agreement)`);
  if (lockConflict && lockCheck.reason) conflicts.push(lockCheck.reason);

  const alignedOk = dualAligned != null ? Boolean(dualAligned) : Boolean(plan?.alignedWithContext !== false);
  const indCount = worldAligned8Count != null
    ? Number(worldAligned8Count)
    : Number(plan?.worldIndicators?.aligned8Count ?? plan?.worldIndicators?.alignedCount ?? 0);
  const baseVerified = Boolean(
    (side === 'LONG' || side === 'SHORT')
    && alignedOk
    && !plan?.counterTrend
    && !reversalRisk
    && !trapVeto
    && !zoneWallVeto
    && indCount >= 6
  );
  const verified = Boolean(baseVerified && !boardOpposes && !svaOpposes && !councilHardNo && !mtf6Opposes && !lockConflict);
  const hasConflict = Boolean(boardOpposes || svaOpposes || councilHardNo || mtf6Opposes || lockConflict);
  const label = verified
    ? `PAKKA ${side}`
    : side
      ? (hasConflict ? `CONFLICT-${side}` : `WAIT-${side}`)
      : 'NEUTRAL';

  return {
    side,
    dir,
    verified,
    label,
    conflicts,
    boardSide: boardSideRaw || null,
    boardOpposes,
    svaAct: svaAct || null,
    svaFinal: svaFinal || null,
    svaOpposes,
    councilVerdict: councilV || null,
    councilHardNo,
    mtf6Opposes,
    lockConflict,
    lockCheck,
  };
}
