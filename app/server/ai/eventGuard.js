// ============================================================
// server/ai/eventGuard.js — v10.15 GAP 2: SCHEDULED-EVENT GUARD
// ------------------------------------------------------------
// THE GAP (superintelligence upgrade plan): the desk will happily
// open a fresh position 5 minutes before an earnings print or an RBI
// policy announcement — the exact moment technical signals are least
// predictive and gap risk is highest. A pro trader's first question
// before entry is "is anything scheduled?"; the system never asked.
//
// THREE GRADED RESPONSES (not a blunt on/off):
//   • BLACKOUT  (T-30min)  → block NEW entries on the affected symbol
//     (existing positions untouched — the SL/T1/T2/trend-flip gauntlet
//     keeps managing them)
//   • HAIRCUT   (T-2h)     → allow entry but cut the size (a multiplier
//     fed into the risk sizing path)
//   • Pre-event exit OPTION → deliberately NOT auto-flattening: the
//     agents' existing partial-TP/breakeven ratchets already de-risk
//     into events; flattening a green runner on every CPI print is
//     churn, not protection. eventGuardStatus() surfaces the exposure
//     so the TRADER decides (per-desk config later if asked).
//
// The calendars (honesty first — every derived date is labeled):
//   • NSE/US EARNINGS: lifted from src/utils/earningsCalendar.ts's
//     table (the frontend's own data — one truth, no duplicate source
//     of dates), rolled FORWARD quarter-by-quarter until future.
//     Approximate (± days) — labeled as such.
//   • FOMC: the Fed's published 2026-2027 meeting schedule, decision
//     ~14:00 ET on day 2.
//   • RBI MPC: the published 2026 H1 dates + AI_EVENT_EXTRA_JSON for
//     H2 additions (invented H2 dates would cause FALSE blackouts —
//     missing data degrades honestly to "no event").
//   • INDIA CPI/IIP + US CPI: monthly release PATTERNS (approximate
//     windows — labeled), the only honest way to encode them without
//     a live calendar API.
//
// Scope: INDIA events affect the India desk; FOMC/US-CPI affect ALL
// desks (crypto is highly macro-sensitive); earnings affect the
// specific symbol (India desk + GLOBALFUTURES US names).
//
// Kill switch: AI_DISABLE_EVENT_GUARD=true (or =off semantics) turns
// the whole guard into a no-op — flag-off behavior is byte-identical.
// ============================================================

const DAY_MS = 24 * 60 * 60 * 1000;
const MIN_MS = 60 * 1000;

// ---- tunables (env) ----
const _num = (v, d) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : d; };
export function eventGuardTunables() {
  return {
    blackoutMin: _num(process.env.AI_EVENT_BLACKOUT_MIN, 30),
    haircutMin: _num(process.env.AI_EVENT_HAIRCUT_MIN, 120),
    haircutMul: Math.min(1, Math.max(0.1, Number(process.env.AI_EVENT_HAIRCUT_MUL) || 0.5)),
  };
}
export function eventGuardEnabled() {
  return !['true', '1', 'on', 'yes', 'off'].includes(String(process.env.AI_DISABLE_EVENT_GUARD || '').trim().toLowerCase())
    || String(process.env.AI_DISABLE_EVENT_GUARD || '').trim().toLowerCase() === 'false';
}

// ---------------------------------------------------------------
// The calendars
// ---------------------------------------------------------------
// EARNINGS — lifted from src/utils/earningsCalendar.ts (NSE + US
// tables; keep BOTH files in sync when dates are refreshed). The
// nextExpected dates there go stale; the guard rolls them forward in
// ~91-day steps until future, so the blackout always lands on the
// NEXT approximate print.
const NSE_EARNINGS = [
  { symbol: 'RELIANCE', nextExpected: '2026-07-18' },
  { symbol: 'TCS', nextExpected: '2026-07-10' },
  { symbol: 'HDFCBANK', nextExpected: '2026-07-15' },
  { symbol: 'INFY', nextExpected: '2026-07-12' },
  { symbol: 'ICICIBANK', nextExpected: '2026-07-18' },
  { symbol: 'BHARTIARTL', nextExpected: '2026-07-22' },
  { symbol: 'SBIN', nextExpected: '2026-07-25' },
  { symbol: 'BAJFINANCE', nextExpected: '2026-07-20' },
  { symbol: 'TATAMOTORS', nextExpected: '2026-07-15' },
  { symbol: 'LT', nextExpected: '2026-07-20' },
  { symbol: 'WIPRO', nextExpected: '2026-07-12' },
  { symbol: 'MARUTI', nextExpected: '2026-07-25' },
  { symbol: 'HCLTECH', nextExpected: '2026-07-12' },
  { symbol: 'TITAN', nextExpected: '2026-07-22' },
  { symbol: 'ADANIENT', nextExpected: '2026-07-18' },
];
const US_EARNINGS = [
  { symbol: 'NVDA', nextExpected: '2026-05-28' },
  { symbol: 'AAPL', nextExpected: '2026-05-01' },
  { symbol: 'MSFT', nextExpected: '2026-04-29' },
  { symbol: 'GOOGL', nextExpected: '2026-04-29' },
  { symbol: 'AMZN', nextExpected: '2026-05-01' },
  { symbol: 'META', nextExpected: '2026-04-30' },
  { symbol: 'TSLA', nextExpected: '2026-04-22' },
  { symbol: 'AVGO', nextExpected: '2026-06-05' },
];

// FOMC — the Fed's published schedule (decision ~14:00 ET on day 2).
// Times below are the DECISION epochs in UTC.
const FOMC_DECISIONS_UTC = [
  '2026-01-28T19:00:00Z', '2026-03-18T18:00:00Z', '2026-04-29T18:00:00Z',
  '2026-06-17T18:00:00Z', '2026-07-29T18:00:00Z', '2026-09-16T18:00:00Z',
  '2026-10-28T18:00:00Z', '2026-12-09T19:00:00Z',
  '2027-01-27T19:00:00Z', '2027-03-17T18:00:00Z', '2027-04-28T18:00:00Z',
  '2027-06-16T18:00:00Z', '2027-07-28T18:00:00Z', '2027-09-15T18:00:00Z',
  '2027-10-27T18:00:00Z', '2027-12-08T19:00:00Z',
];

// RBI MPC — published 2026 H1 decision days (10:00 IST announcements);
// H2 additions via AI_EVENT_EXTRA_JSON (invented dates = false blackouts,
// so missing H2 honestly degrades to "no event").
const RBI_DECISIONS_IST = [
  '2026-02-06T10:00:00+05:30',
  '2026-04-03T10:00:00+05:30',
];

/** Extra user-supplied events (AI_EVENT_EXTRA_JSON):
 *  [{ kind: 'RBI'|'FOMC'|'US_CPI'|'EARNINGS', at: 'ISO', symbol?: 'X',
 *     desks?: ['INDIA'|'CRYPTO'|'ALL'] }] — appends to the calendar. */
function extraEvents() {
  const raw = process.env.AI_EVENT_EXTRA_JSON;
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.filter(e => e && e.at) : [];
  } catch { return []; }
}

// ---------------------------------------------------------------
// Date helpers (pure)
// ---------------------------------------------------------------
const parseIso = (s) => { const t = Date.parse(String(s)); return Number.isFinite(t) ? t : null; };

/** NSE earnings print time-of-day: after market close (~16:00 IST) for
 *  the classic post-market reporters the table models. */
function nseEarningsAt(dateStr) {
  const day = parseIso(`${dateStr}T00:00:00+05:30`);
  return day != null ? day + 16 * 60 * MIN_MS : null;
}
/** US earnings: pre/post-market — 16:00 UTC (post-market) default. */
function usEarningsAt(dateStr) {
  const day = parseIso(`${dateStr}T00:00:00Z`);
  return day != null ? day + 16 * 60 * MIN_MS : null;
}

/** Roll a stale nextExpected forward in ~91-day steps until it is in
 *  the future (quarterly cadence — approximate, labeled). PURE. */
export function rollQuarterlyForward(expectedMs, nowMs, stepDays = 91) {
  let t = expectedMs;
  let guard = 0;
  while (t <= nowMs && guard++ < 40) t += stepDays * DAY_MS;
  return t;
}

/** The next approximate earnings epoch for a symbol. PURE. */
export function nextEarningsFor(symbol, nowMs = Date.now()) {
  const sym = String(symbol || '').toUpperCase();
  const row = NSE_EARNINGS.find(r => r.symbol === sym) || US_EARNINGS.find(r => r.symbol === sym);
  if (!row) return null;
  const isNse = NSE_EARNINGS.some(r => r.symbol === sym);
  const base = isNse ? nseEarningsAt(row.nextExpected) : usEarningsAt(row.nextExpected);
  if (base == null) return null;
  return { at: rollQuarterlyForward(base, nowMs), symbol: sym, approximate: true, market: isNse ? 'IN' : 'US' };
}

/** India CPI releases: ~12th of each month, 17:30 IST. Approximate. */
export function nextIndiaCpi(nowMs) {
  return nextIstMonthly(nowMs, 12, 17.5);
}
/** India IIP: ~last day of each month, 17:30 IST. Approximate. */
export function nextIndiaIip(nowMs) {
  const d = new Date(nowMs);
  for (let i = 0; i < 3; i++) {
    const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + i + 1, 0)); // last day of month i
    const at = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + i, last.getUTCDate(), 12, 0); // 17:30 IST = 12:00 UTC
    if (at > nowMs) return { at, approximate: true };
  }
  return null;
}
/** US CPI: 12th–15th of each month at 08:30 ET (12:30/13:30 UTC). The
 *  window is the honest encoding — the exact day shifts monthly. */
export function nextUsCpiWindow(nowMs) {
  const d = new Date(nowMs);
  for (let i = 0; i < 3; i++) {
    for (let day = 12; day <= 15; day++) {
      const at = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + i, day, 12, 30);
      if (at > nowMs) return { at, approximate: true };
    }
  }
  return null;
}
/** Next occurrence of a monthly IST pattern: `dayOfMonth` at
 *  `istHourDecimal` (e.g. 17.5 = 17:30 IST). 17:30 IST = 12:00 UTC. */
function nextIstMonthly(nowMs, dayOfMonth, istHourDecimal) {
  const utcHourMs = (istHourDecimal - 5.5) * 60 * MIN_MS; // IST → UTC offset math
  const d = new Date(nowMs);
  for (let i = 0; i < 3; i++) {
    const at = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + i, dayOfMonth) + utcHourMs;
    if (at > nowMs) return { at, approximate: true };
  }
  return null;
}

// ---------------------------------------------------------------
// The guard check — GRADED, pure
// ---------------------------------------------------------------
/**
 * The graded response for one (symbol, desk) entry attempt. PURE.
 * @param {object} a { symbol, desk: 'INDIA'|'CRYPTO'|'FUTURES'|'GLOBALFUTURES', now }
 * @returns {{action:'allow'}|
 *           {action:'blackout', reason:string, event:{kind,label,at,minutesUntil,approximate?}}|
 *           {action:'haircut', multiplier:number, reason:string, event:{...}}}
 */
export function eventGuardCheck({ symbol, desk, now = Date.now() } = {}) {
  if (!eventGuardEnabled()) return { action: 'allow' };
  const { blackoutMin, haircutMin, haircutMul } = eventGuardTunables();
  const deskN = String(desk || '').toUpperCase();
  const nowMs = Number(now) || Date.now();

  const candidates = []; // { kind, label, at, approximate?, desks }

  // 1) symbol earnings (India desk symbols + GLOBALFUTURES US names)
  const sym = String(symbol || '').toUpperCase();
  if (sym) {
    const er = nextEarningsFor(sym, nowMs);
    if (er && (deskN === 'INDIA' ? er.market === 'IN' : deskN === 'GLOBALFUTURES' ? er.market === 'US' : false)) {
      candidates.push({ kind: 'EARNINGS', label: `${sym} earnings`, at: er.at, approximate: true });
    }
  }

  // 2) macro events by desk scope
  const allDesks = ['INDIA', 'CRYPTO', 'FUTURES', 'GLOBALFUTURES'];
  for (const t of FOMC_DECISIONS_UTC) {
    const at = parseIso(t);
    if (at != null && at > nowMs - DAY_MS) candidates.push({ kind: 'FOMC', label: 'FOMC decision', at, desks: allDesks });
  }
  for (const t of RBI_DECISIONS_IST) {
    const at = parseIso(t);
    if (at != null && at > nowMs - DAY_MS) candidates.push({ kind: 'RBI', label: 'RBI policy', at, desks: ['INDIA'] });
  }
  const icpi = nextIndiaCpi(nowMs);
  if (icpi) candidates.push({ kind: 'INDIA_CPI', label: 'India CPI', at: icpi.at, approximate: true, desks: ['INDIA'] });
  const iip = nextIndiaIip(nowMs);
  if (iip) candidates.push({ kind: 'INDIA_IIP', label: 'India IIP', at: iip.at, approximate: true, desks: ['INDIA'] });
  const ucpi = nextUsCpiWindow(nowMs);
  if (ucpi) candidates.push({ kind: 'US_CPI', label: 'US CPI', at: ucpi.at, approximate: true, desks: allDesks });

  // 3) user extras
  for (const e of extraEvents()) {
    const at = parseIso(e.at);
    if (at == null) continue;
    const desks = Array.isArray(e.desks) && e.desks.length ? e.desks.map(d => String(d).toUpperCase()) : allDesks;
    if (e.kind === 'EARNINGS' && e.symbol && String(e.symbol).toUpperCase() !== sym) continue;
    candidates.push({ kind: String(e.kind || 'EVENT'), label: e.label || String(e.kind || 'event'), at, desks });
  }

  // the SOONEST relevant event for this (symbol, desk)
  let soonest = null;
  for (const c of candidates) {
    if (c.desks && !c.desks.includes(deskN) && !c.desks.includes('ALL')) continue;
    const minutesUntil = (c.at - nowMs) / MIN_MS;
    if (minutesUntil < -30 || minutesUntil > 6 * 60) continue; // past events / >6h away: no interference
    if (!soonest || c.at < soonest.at) soonest = { ...c, minutesUntil: Math.round(minutesUntil) };
  }
  if (!soonest) return { action: 'allow' };

  if (soonest.minutesUntil <= blackoutMin) {
    return {
      action: 'blackout',
      reason: `${soonest.label} in ${Math.max(0, soonest.minutesUntil)}m${soonest.approximate ? ' (approx date)' : ''} — pre-event blackout, fresh entry blocked`,
      event: soonest,
    };
  }
  if (soonest.minutesUntil <= haircutMin) {
    return {
      action: 'haircut',
      multiplier: haircutMul,
      reason: `${soonest.label} in ${soonest.minutesUntil}m${soonest.approximate ? ' (approx date)' : ''} — sizing haircut ×${haircutMul}`,
      event: soonest,
    };
  }
  return { action: 'allow', event: soonest };
}

/**
 * The upcoming-events view for the UI strip / the signal-card chip.
 * PURE — the next N events affecting a desk (or a symbol's own event).
 */
export function eventGuardStatus({ desk, days = 7, now = Date.now() } = {}) {
  const nowMs = Number(now) || Date.now();
  if (!eventGuardEnabled()) {
    // off means OFF — the strip disappears, no half-alive calendar
    return { ok: true, enabled: false, tunables: eventGuardTunables(), upcoming: [], note: 'Event guard disabled (AI_DISABLE_EVENT_GUARD) — no blackouts, no haircuts, no strip.' };
  }
  const horizon = nowMs + days * DAY_MS;
  const deskN = desk ? String(desk).toUpperCase() : null;
  const out = [];
  for (const t of FOMC_DECISIONS_UTC) {
    const at = parseIso(t);
    if (at != null && at >= nowMs - 30 * MIN_MS && at <= horizon) out.push({ kind: 'FOMC', label: 'FOMC decision', at, desks: ['ALL'] });
  }
  for (const t of RBI_DECISIONS_IST) {
    const at = parseIso(t);
    if (at != null && at >= nowMs - 30 * MIN_MS && at <= horizon) out.push({ kind: 'RBI', label: 'RBI policy', at, desks: ['INDIA'] });
  }
  const icpi = nextIndiaCpi(nowMs);
  if (icpi && icpi.at <= horizon) out.push({ kind: 'INDIA_CPI', label: 'India CPI (approx)', at: icpi.at, approximate: true, desks: ['INDIA'] });
  const iip = nextIndiaIip(nowMs);
  if (iip && iip.at <= horizon) out.push({ kind: 'INDIA_IIP', label: 'India IIP (approx)', at: iip.at, approximate: true, desks: ['INDIA'] });
  const ucpi = nextUsCpiWindow(nowMs);
  if (ucpi && ucpi.at <= horizon) out.push({ kind: 'US_CPI', label: 'US CPI (approx window)', at: ucpi.at, approximate: true, desks: ['ALL'] });
  for (const e of extraEvents()) {
    const at = parseIso(e.at);
    if (at == null || at < nowMs - 30 * MIN_MS || at > horizon) continue;
    out.push({ kind: String(e.kind || 'EVENT'), label: e.label || String(e.kind || 'event'), at, desks: Array.isArray(e.desks) ? e.desks.map(String) : ['ALL'] });
  }
  const list = out.sort((a, b) => a.at - b.at)
    .filter(e => !deskN
      || e.desks.includes('ALL')
      || e.desks.map(d => String(d).toUpperCase()).includes(deskN));
  return {
    ok: true,
    enabled: eventGuardEnabled(),
    tunables: eventGuardTunables(),
    upcoming: list.slice(0, 10).map(e => ({ ...e, inMin: Math.max(0, Math.round((e.at - nowMs) / MIN_MS)) })),
    note: 'Graded guard: T-30m blackout on new entries · T-2h sizing haircut ×0.5. Earnings/macro dates approximate where labeled. AI_DISABLE_EVENT_GUARD=true kills it.',
  };
}

// ---------------- test hooks ----------------
export function __eventGuardTestables() {
  return { NSE_EARNINGS, US_EARNINGS, FOMC_DECISIONS_UTC, RBI_DECISIONS_IST };
}
