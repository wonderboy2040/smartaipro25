// ============================================================
// server/ai/instFlow.js — V2 MODEL #13: InstFlow
// ------------------------------------------------------------
// Ensemble 11 → 14 upgrade, Phase 2. The committee gets a seat
// for WHERE THE BIG MONEY STANDS:
//
//   INDIA   — NSE's public FII/DII daily net buy/sell figures
//             (free, no key, published post-market). Read as a
//             market-wide regime tilt — same weight-class idea
//             as macroRegime, NOT a per-stock trigger.
//   CRYPTO  — CoinDCX orderbook depth imbalance, reusing the
//             SAME public getOrderbook() the OrderbookPanel /
//             /api/ai/orderbook endpoint already serves (no new
//             fetch path). A vote only fires on SUSTAINED
//             imbalance — >60% of top-N depth on one side across
//             the last 3 polls — otherwise honest abstain.
//
// Contract: instFlowVote(ctx) is synchronous; data is warmed by
//   refreshFiiDii()  (India, 6h cache — figures are daily)
//   warmInstFlow()    (crypto books, board-cadence polls)
// FUTURES desk: perp books aren't public on CoinDCX — the spot
// INR book votes as a PROXY (flagged in reasons, lower conf).
//
// Weight in MODELS[]: 0.8 — below median until adaptive.js
// earns it from ≥8 settled outcomes.
// ============================================================

import { getOrderbook } from './swing.js';

const clamp = (v, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, v));
const r1 = (v) => (Number.isFinite(v) ? Math.round(v * 10) / 10 : null);
const r2 = (v) => (Number.isFinite(v) ? Math.round(v * 100) / 100 : null);

function vote(dir, conf, reasons) {
  return { dir, conf: Math.round(clamp(conf)), reasons: reasons.filter(Boolean) };
}

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36';

// ---------------- India: NSE FII/DII (defensive, cached 6h) ----------------
const NSE_HOME = 'https://www.nseindia.com/';
const NSE_FIIDII = 'https://www.nseindia.com/api/fiidiiTradeReact';
const FII_TTL = 6 * 60 * 60 * 1000;

let _fii = null;      // { at, asOf, fiiNet, diiNet, combinedNet, rows }
let _fiiInflight = null;
let _nseCookies = null, _nseCookieAt = 0;

async function nseSessionCookies() {
  if (_nseCookies && Date.now() - _nseCookieAt < 30 * 60 * 1000) return _nseCookies;
  const r = await fetch(NSE_HOME, {
    headers: {
      'User-Agent': UA, Accept: 'text/html,application/xhtml+xml',
      'Accept-Language': 'en-US,en;q=0.9', 'Accept-Encoding': 'gzip, deflate, br',
    },
    signal: AbortSignal.timeout(8000),
  });
  const raw = r.headers.getSetCookie?.() || [];
  if (!raw.length) throw new Error('no cookies from NSE home');
  _nseCookies = raw.map(c => c.split(';')[0]).join('; ');
  _nseCookieAt = Date.now();
  return _nseCookies;
}

const parseCr = (s) => {
  // "12,345.67" / 1234.5 / "1,234" → number (₹ Crores)
  const n = Number(String(s ?? '').replace(/,/g, ''));
  return Number.isFinite(n) ? n : 0;
};

/** Fetch + parse the day's FII/DII figures. Tries today's default
 *  payload, then explicit dates for the last 3 sessions (weekends/
 *  holidays publish nothing). Column formats change occasionally —
 *  every field is defensive, failure = null = honest abstain. */
async function fetchFiiDii() {
  let cookies;
  try { cookies = await nseSessionCookies(); } catch { return null; }
  const dates = [null]; // default = latest
  const ist = new Date(Date.now() + 5.5 * 3600_000);
  for (let d = 1; d <= 3; d++) {
    const day = new Date(ist.getTime() - d * 86400_000);
    const dd = String(day.getUTCDate()).padStart(2, '0');
    const mm = String(day.getUTCMonth() + 1).padStart(2, '0');
    dates.push(`${dd}-${mm}-${day.getUTCFullYear()}`);
  }
  for (const date of dates) {
    try {
      const url = date ? `${NSE_FIIDII}?date=${encodeURIComponent(date)}` : NSE_FIIDII;
      const r = await fetch(url, {
        headers: {
          'User-Agent': UA, Accept: '*/*', Referer: NSE_HOME,
          'Accept-Language': 'en-US,en;q=0.9', Cookie: cookies,
        },
        signal: AbortSignal.timeout(9000),
      });
      if (!r.ok) continue;
      const rows = await r.json();
      if (!Array.isArray(rows) || rows.length === 0) continue;
      // v21.1.0 FIX (Phase-1.4, REAL DATA BUG): fiiBuy/fiiSell kabhi accumulate nahi
      // hote the — fiiBuyCr/fiiSellCr hamesha 0 return hote the. NSE FIIDII rows ka
      // buyValue/sellValue ab loop me proper accumulate hota hai.
      let fiiNet = 0, diiNet = 0, fiiBuy = 0, fiiSell = 0;
      let sawFii = false, sawDii = false;
      for (const row of rows) {
        const cat = String(row?.category || '').toUpperCase();
        const net = parseCr(row?.netValue ?? row?.net ?? row?.NetValue);
        const buy = parseCr(row?.buyValue ?? row?.buy ?? row?.BuyValue);
        const sell = parseCr(row?.sellValue ?? row?.sell ?? row?.SellValue);
        if (cat.startsWith('FII') || cat.startsWith('PRO')) { fiiNet += net; sawFii = true; fiiBuy += buy; fiiSell += sell; }
        else if (cat.startsWith('DII') || cat.startsWith('BII')) { diiNet += net; sawDii = true; }
      }
      if (!sawFii && !sawDii) continue; // parse produced nothing usable
      return {
        at: Date.now(),
        asOf: String(rows[0]?.date || date || 'latest'),
        fiiNet: r2(fiiNet), diiNet: r2(diiNet),
        combinedNet: r2(fiiNet + diiNet),
        fiiBuyCr: r2(fiiBuy), fiiSellCr: r2(fiiSell),
        categories: rows.map(x => String(x?.category || '')).filter(Boolean),
      };
    } catch { /* next date / honest abstain */ }
  }
  return null;
}

/** Warm the FII/DII cache (6h TTL, single-flight). */
export async function refreshFiiDii() {
  if (_fii && Date.now() - _fii.at < FII_TTL) return _fii;
  if (_fiiInflight) return _fiiInflight;
  _fiiInflight = (async () => {
    try {
      const fresh = await fetchFiiDii();
      if (fresh) _fii = fresh;
      return fresh;
    } catch { return null; }
    finally { _fiiInflight = null; }
  })();
  return _fiiInflight;
}

// ---------------- Crypto: orderbook depth polls ----------------
// Per-base ring of the last 3 polls (each a {ts, depthShare, imbalancePct,
// spreadPct} from the SAME public getOrderbook() the desk panel uses).
const POLLS_KEPT = 3;
const POLL_MIN_GAP = 40 * 1000;   // don't hammer the public endpoint
const POLL_WINDOW = 12 * 60 * 1000; // a poll older than this stops counting
const _books = new Map();        // base → [{ts, depthShare, imbalancePct, spreadPct}]
const _pollAt = new Map();       // base → last poll ts (rate guard)
const _inflight = new Map();     // base → promise

/**
 * Poll orderbooks for the given bases (top-of-universe by turnover —
 * the board hands us its most liquid slice). Fire-and-forget safe:
 * per-base rate guard + in-flight guard; a dead public endpoint
 * just leaves the history cold (vote abstains).
 */
export async function warmInstFlow(bases) {
  const list = (Array.isArray(bases) ? bases : [])
    .map(b => String(b || '').toUpperCase().replace(/[^A-Z0-9]/g, ''))
    .filter(Boolean).slice(0, 10);
  await Promise.allSettled(list.map(async (base) => {
    const last = _pollAt.get(base) || 0;
    if (Date.now() - last < POLL_MIN_GAP) return; // rate guard
    if (_inflight.has(base)) return _inflight.get(base);
    const p = (async () => {
      _pollAt.set(base, Date.now());
      try {
        const ob = await getOrderbook(base);
        if (!ob?.ok || !Number.isFinite(ob.bidVol) || !Number.isFinite(ob.askVol)) return;
        const total = ob.bidVol + ob.askVol;
        if (!(total > 0)) return;
        const spreadPct = Number(ob.spreadPct);
        if (Number.isFinite(spreadPct) && spreadPct > 1.5) return; // thin book — noise
        const ring = (_books.get(base) || []).filter(p => Date.now() - p.ts < POLL_WINDOW);
        ring.push({
          ts: Date.now(),
          depthShare: ob.bidVol / total,          // share of top-N depth on the bid side
          imbalancePct: Number(ob.imbalancePct),
          spreadPct: Number.isFinite(spreadPct) ? spreadPct : null,
          // v11.8: which book served this poll (CoinDCX INR or the
          // Binance USDT proxy when CoinDCX REST is unreachable from
          // this host) — surfaces in the vote's reasons.
          source: ob.source || 'coindcx-inr',
        });
        _books.set(base, ring.slice(-POLLS_KEPT));
      } catch { /* honest degrade */ }
      finally { _inflight.delete(base); }
    })();
    _inflight.set(base, p);
    return p;
  }));
}

function sustainedRead(base) {
  const ring = (_books.get(base) || []).filter(p => Date.now() - p.ts < POLL_WINDOW);
  if (ring.length < 2) return { enough: false, ring };
  const bidHeavy = ring.filter(p => p.depthShare > 0.60).length;
  const askHeavy = ring.filter(p => p.depthShare < 0.40).length;
  const avgShare = ring.reduce((s, p) => s + p.depthShare, 0) / ring.length;
  if (bidHeavy === ring.length) return { enough: true, dir: 1, avgShare, ring };
  if (askHeavy === ring.length) return { enough: true, dir: -1, avgShare, ring };
  return { enough: false, dir: 0, avgShare, ring };
}

// ---------------- the VOTE (sync, models.js contract) ----------------
/**
 * InstFlow — ensemble seat #13.
 * INDIA: FII+DII combined daily net (₹Cr) — market-wide tilt.
 * CRYPTO/FUTURES: sustained CoinDCX book imbalance (spot proxy
 * for the futures desk).
 */
export function instFlowVote(ctx) {
  const mkt = String(ctx?.market || '').toUpperCase();
  const symbol = String(ctx?.symbol || '').toUpperCase();

  if (mkt === 'INDIA') {
    if (!_fii) {
      return vote(0, 0, ['NSE FII/DII figures unavailable — InstFlow abstains (honest degrade)']);
    }
    const net = _fii.combinedNet;
    const reasons = [
      `FII/DII (${_fii.asOf}): FII net ₹${r1(_fii.fiiNet)}Cr · DII net ₹${r1(_fii.diiNet)}Cr`,
    ];
    const dir = net >= 1500 ? 1 : net <= -1500 ? -1 : 0;
    if (dir === 0) {
      reasons.push(net >= 500 ? 'mild institutional net-buy — below conviction threshold' : net <= -500 ? 'mild institutional net-sell — below conviction threshold' : 'institutions balanced');
      return vote(0, 0, reasons);
    }
    const conf = 42 + Math.min(14, (Math.abs(net) - 1500) / 500); // 42-56: honest regime-tilt range
    reasons.push(`combined ₹${r1(net)}Cr ${dir > 0 ? 'net-buy' : 'net-sell'} — institutional ${dir > 0 ? 'support' : 'distribution'} for the India tape`);
    return vote(dir, conf, reasons);
  }

  if (mkt === 'CRYPTO' || mkt === 'FUTURES') {
    const read = sustainedRead(symbol);
    const proxy = mkt === 'FUTURES' ? ' (spot-book proxy — perp depth not public)' : '';
    if (!read.enough || read.dir === 0) {
      const have = read.ring.length;
      return vote(0, 0, [
        have === 0
          ? `CoinDCX book not polled yet${proxy} — InstFlow abstains`
          : `book depth ${Math.round(read.avgShare * 100)}% bid-side across ${have} poll${have === 1 ? '' : 's'} — no sustained ≥60% side${proxy}`,
      ]);
    }
    const conf = 44 + Math.min(14, Math.abs(read.avgShare - 0.5) * 40) - (mkt === 'FUTURES' ? 5 : 0);
    const side = read.dir > 0 ? 'bid' : 'ask';
    // v11.8: name the book that served the polls (Binance USDT proxy
    // when CoinDCX REST is unreachable from this host — Render).
    const via = read.ring.some(p => p.source === 'binance-usdt-proxy') ? ' (Binance USDT book proxy — CoinDCX REST unreachable)' : '';
    return vote(read.dir, Math.round(conf), [
      `CoinDCX ${symbol} book: bids hold ${Math.round(read.avgShare * 100)}% of depth across ${read.ring.length} polls${via}${proxy}`,
      `sustained ${side}-heavy book — ${read.dir > 0 ? 'buyers absorbing offers' : 'sellers pressing the bid'}`,
    ]);
  }

  return vote(0, 0, ['InstFlow: unknown market — abstains']);
}

// ---------------- transparency ----------------
export function instFlowStatus() {
  const books = {};
  for (const [base, ring] of _books.entries()) {
    const live = ring.filter(p => Date.now() - p.ts < POLL_WINDOW);
    if (live.length) books[base] = {
      polls: live.length,
      bidDepthPct: Math.round((live.reduce((s, p) => s + p.depthShare, 0) / live.length) * 100),
    };
  }
  return {
    enabled: true,
    india: _fii ? {
      ageH: Math.round((Date.now() - _fii.at) / 3600000 * 10) / 10,
      asOf: _fii.asOf, fiiNetCr: _fii.fiiNet, diiNetCr: _fii.diiNet, combinedNetCr: _fii.combinedNet,
      // v21.1.1 [audit C6]: v21.1.0 ka fiiBuyCr/fiiSellCr accumulation fix
      // parse me sahi hai par status consumer tak pahunchta hi nahi tha
      // (dead payload). Ab exposed — vote reason/UI me use ho sakta hai.
      fiiBuyCr: _fii.fiiBuyCr ?? null,
      fiiSellCr: _fii.fiiSellCr ?? null,
    } : null,
    crypto: {
      booksTracked: Object.keys(books).length,
      sustainedThreshold: 0.60,
      books,
    },
  };
}

export const __testables = {
  _books, _fii, parseCr, sustainedRead,
  __setFii(entry) { _fii = { at: Date.now(), ...entry }; },
  __clearFii() { _fii = null; },
  __pushBook(base, polls) { _books.set(base, polls.map(p => ({ ts: Date.now(), ...p }))); },
  __clearBooks() { _books.clear(); _pollAt.clear(); _inflight.clear(); },
};
