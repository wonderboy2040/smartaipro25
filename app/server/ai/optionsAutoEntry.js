// ============================================================
// server/ai/optionsAutoEntry.js — v21.0.2 OPTIONS AUTO-ENTRY
// ------------------------------------------------------------
// NIFTY/SENSEX options desk ka AUTO ENTRY engine (paper).
//
// CONTEXT: pehle options desk sirf DISPLAY + MANUAL paper button
// tha — koi auto-entry loop exist hi nahi karta tha (auto-exit
// watcher pehle se tha: SL/T1-book/T2/BE-trail/15:10 sqoff).
// User goal: "Nifty & Sensex Options Trading Auto Entry aur Auto
// Exit" — ye module entry side bolti hai; exit side intraday/
// stream.js watcher (5s) + evaluatePaper already sambhalta hai.
//
// FLOW (har 30s tick, NSE hours me):
//   getOptionSignalsView(deps, ['NIFTY','SENSEX'])
//     → cards (tradeable: STRONG/ACTION grade ya AI ≥75)
//     → [gates] enabled · NSE open + fresh-entry window · killSwitch
//             · quota/day · per-underlying cooldown · one-per-contract
//             · max 10 open paper (openPaperTrade ka apna guard)
//     → openPaperTrade({ assetKind:'OPTION', ... }) — 1 lot premium BUY
//     → watcher auto-exit (SL / T1 50% book / T2 / BE-trail / EOD sqoff
//        + expiry-day 14:30 — v21.0.2)
//
// EXIT PLAN (card ke displayed plan se EXACT match — v21.0.2 fix):
//   T1 = entry + 0.5×reward  → engine 50% book + trail-to-entry
//   T2 = entry + 1.0×reward  → engine baaki sab close
//   (Pehle T1=full-target bheja jata tha — card vs engine mismatch.)
//
// STATE: server/data/options-auto-config.json (user toggle + caps)
//        server/data/options-auto-state.json (quota/cooldown counters)
// ============================================================

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isNseMarketOpen, freshEntriesAllowedFor } from '../intraday/time.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(__dirname, '..', 'data');
const CFG_FILE = path.join(DATA_DIR, 'options-auto-config.json');
const STATE_FILE = path.join(DATA_DIR, 'options-auto-state.json');

const DEFAULT_CFG = {
  enabled: false,        // opt-in — user toggle karega (UI/API)
  quotaPerDay: 3,        // India agent jaisa hi trade quota
  cooldownMin: 20,       // same underlying pe agli entry itne min baad
  minAiScore: 75,        // auto-agent ki qualify bar ke barabar
  maxPerUnderlyingPerDay: 2, // NIFTY + SENSEX dono ko fair chance
};

const DEFAULT_STATE = { day: null, count: 0, perUnderlying: {}, lastEntryAt: {}, lastEntry: null };

// ---- NSE clock (intraday/time.js se — same source of truth; static
// import v21.0.6: status view ko bhi holiday-aware window chahiye) ----

function _nowISTMinutes() {
  const d = new Date(Date.now() + (5.5 * 3600_000));
  return d.getUTCHours() * 60 + d.getUTCMinutes();
}

function _todayIST() {
  return new Date(Date.now() + (5.5 * 3600_000)).toISOString().slice(0, 10);
}

// ---- config/state persistence (crash-safe, best-effort) ----
function _readJson(file, fallback) {
  try { return { ...fallback, ...JSON.parse(fs.readFileSync(file, 'utf8')) }; }
  catch { return { ...fallback }; }
}
function _writeJson(file, obj) {
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); fs.writeFileSync(file, JSON.stringify(obj, null, 2)); }
  catch { /* best-effort — runtime state hai, restart pe fresh */ }
}

export function loadOptionsAutoCfg() { return _readJson(CFG_FILE, DEFAULT_CFG); }
export function saveOptionsAutoCfg(cfg) { _writeJson(CFG_FILE, cfg); }
function _loadState() {
  const s = _readJson(STATE_FILE, DEFAULT_STATE);
  const today = _todayIST();
  if (s.day !== today) {
    // day rollover — counters reset
    return { ...DEFAULT_STATE, day: today, count: 0, perUnderlying: {}, lastEntryAt: {}, lastEntry: s.lastEntry || null };
  }
  return s;
}
function _saveState(s) { _writeJson(STATE_FILE, s); }

// ---- status view (API + UI ke liye) ----
export function optionsAutoStatus() {
  const cfg = loadOptionsAutoCfg();
  const s = _loadState();
  // v21.0.6 [audit]: holiday-AWARE window (isNseMarketOpen calendar +
  // fresh-entry cutoff 15:00) — pehle holiday-blind 09:15–15:00 clock
  // tha jo AUTO ON ko holiday pe bhi "window open" bata deta tha.
  const m = _nowISTMinutes();
  const nseOpen = (() => {
    try { return isNseMarketOpen() && m >= 555 && m < 900; } catch { return m >= 555 && m < 900; }
  })();
  return {
    ok: true,
    enabled: !!cfg.enabled,
    cfg: { quotaPerDay: cfg.quotaPerDay, cooldownMin: cfg.cooldownMin, minAiScore: cfg.minAiScore, maxPerUnderlyingPerDay: cfg.maxPerUnderlyingPerDay },
    day: s.day,
    entriesToday: s.count,
    quotaLeft: Math.max(0, Number(cfg.quotaPerDay) - Number(s.count || 0)),
    cooldownRemainingMin: (() => {
      const last = Math.max(0, ...Object.values(s.lastEntryAt || {}).map(Number));
      if (!last) return 0;
      const left = Number(cfg.cooldownMin) - Math.floor((Date.now() - last) / 60000);
      return Math.max(0, left);
    })(),
    // v21.1.1 [audit C7]: cooldown ab PER-UNDERLYING map bhi deta hai —
    // pehle sirf global max dikhta tha: "cooldown 17min" (NIFTY cooling)
    // padh ke lagta tha SENSEX bhi block hai (jalda free hai).
    cooldownRemainingByUnderlying: (() => {
      const out = {};
      for (const [u, at] of Object.entries(s.lastEntryAt || {})) {
        const left = Number(cfg.cooldownMin) - Math.floor((Date.now() - Number(at || 0)) / 60000);
        if (left > 0) out[u] = left;
      }
      return out;
    })(),
    lastEntry: s.lastEntry || null,
    windowOpen: nseOpen,
  };
}

export function setOptionsAutoEnabled(enabled) {
  const cfg = loadOptionsAutoCfg();
  cfg.enabled = !!enabled;
  saveOptionsAutoCfg(cfg);
  return optionsAutoStatus();
}

// ---- the tick (30s loop se call hota hai) ----
let _tickBusy = false; // v21.0.6 [audit]: re-entrancy guard — overlapping ticks double-open se bachaate hain
export async function optionsAutoTick(deps, sendTelegram) {
  if (_tickBusy) return { ok: true, idle: 'busy' };
  _tickBusy = true;
  try {
    return await _optionsAutoTickInner(deps, sendTelegram);
  } finally {
    _tickBusy = false;
  }
}

async function _optionsAutoTickInner(deps, sendTelegram) {
  const cfg = loadOptionsAutoCfg();
  if (!cfg.enabled) return { ok: true, idle: 'disabled' };

  // NSE session gate — same rules jo manual paper entry route lagata hai
  // (09:15–15:00 fresh entries; holidays honored by time.js).
  if (!isNseMarketOpen()) return { ok: true, idle: 'nse-closed' };
  if (!freshEntriesAllowedFor('INDIA')) return { ok: true, idle: 'past-fresh-entry-window' };

  // kill switch (shared trading config — India agent jaisa)
  try {
    const { loadConfig } = await import('./coindcxOrders.js');
    const trading = loadConfig();
    if (trading?.killSwitch) return { ok: true, idle: 'kill-switch' };
  } catch { /* config unavailable — continue (paper-only engine) */ }

  // quota + cooldown state
  const s = _loadState();
  if (Number(s.count || 0) >= Number(cfg.quotaPerDay)) return { ok: true, idle: 'quota-done' };
  const now = Date.now();

  // option signal cards
  let view;
  try {
    const { getOptionSignalsView } = await import('./optionsDesk.js');
    view = await getOptionSignalsView(deps, ['NIFTY', 'SENSEX']);
  } catch { return { ok: true, idle: 'view-error' }; }
  if (!view?.ok || !Array.isArray(view.cards)) return { ok: true, idle: 'no-cards' };

  // already-open contracts (paper watcher one-per-contract guard hai,
  // par pre-filter se openPaperTrade ka error-loop avoid hota hai)
  let openSyms = new Set();
  try {
    const { getPaperSummary } = await import('../intraday/paperTrading.js');
    const sum = getPaperSummary();
    openSyms = new Set((sum?.open || []).map(t => String(t.symbol || '').toUpperCase()));
  } catch { /* summary unavailable — openPaperTrade khud guard karega */ }

  // best tradeable card (view already AI-score sorted)
  // v21.0.6 [audit B3]: cooldown ab PER-UNDERLYING hai — pehle GLOBAL 20m
  // tha (koi bhi underlying enter kare to NIFTY+SENSEX dono 20m ke liye
  // stall) jabki config spec "same underlying pe agli entry itne min
  // baad" hai. Quota 3/day ke saath global cooldown ek underlying ko
  // pura starve kar sakta tha. Idle-reason priority: pehle qualifying
  // cards check (warna cooling underlying bhi "no-qualifying-card" jaisa
  // hi sach hai), phir cooldown filter.
  const inCooldownFor = (u) => {
    const at = Number((s.lastEntryAt || {})[String(u || '').toUpperCase()] || 0);
    return at > 0 && (now - at) < Number(cfg.cooldownMin) * 60000;
  };
  const qualifies = (c) => c?.tradeable
    && Number(c.aiScore ?? 0) >= Number(cfg.minAiScore)
    && Number(c.entry) > 0 && Number(c.stopLoss) > 0 && Number(c.target) > Number(c.entry)
    && Number((s.perUnderlying || {})[String(c.symbol || '').toUpperCase()] || 0) < Number(cfg.maxPerUnderlyingPerDay)
    && !openSyms.has(String(`${c.symbol}${Math.round(c.strike)}${c.type}`).toUpperCase());
  const qualifying = view.cards.filter(qualifies);
  if (qualifying.length === 0) return { ok: true, idle: 'no-qualifying-card' };
  const pick = qualifying.find(c => !inCooldownFor(c.symbol));
  if (!pick) {
    const cooling = [...new Set(qualifying.filter(c => inCooldownFor(c.symbol)).map(c => c.symbol))];
    return { ok: true, idle: `cooldown-${cooling.join('+')}` };
  }

  // ---- OPEN the paper trade (card plan ke EXACT displayed levels) ----
  const entry = Number(pick.entry);
  // v21.1.1 [audit C5]: LIVE-PREMIUM CROSS-CHECK — card 30s cache + chain
  // 90s TTL ho sakta hai; fast move pe entry us level pe khulti thi jo
  // market 1-2 min pehle chhod chuka hai (first watcher tick pe phantom
  // gain/loss). Same data.js ladder se contract LTP dobara padho —
  // >5% deviation → skip (agle pass fresh card banegi).
  try {
    const u = String(pick.symbol || '').toUpperCase();
    const { fetchNSEOptionChain, fetchBSEOptionChain } = await import('./data.js');
    const chain = u === 'SENSEX'
      ? await fetchBSEOptionChain('SENSEX').catch(() => null)
      : await fetchNSEOptionChain(u).catch(() => null);
    const row = (chain?.rows || []).find(r => Number(r.strike) === Math.round(Number(pick.strike))
      && String(r.expiry || '').slice(0, 10) === String(pick.expiry || '').slice(0, 10));
    const ltp = row ? Number(pick.type === 'CE' ? row.callLTP : row.putLTP) : null;
    if (ltp != null && ltp > 0 && entry > 0) {
      const dev = Math.abs(ltp - entry) / entry;
      if (dev > 0.05) {
        const liveR = Math.round(ltp * 100) / 100;
        return { ok: true, idle: `stale-card-skip — ${pick.symbol}${Math.round(pick.strike)}${pick.type} premium ${Math.round(dev * 100)}% move kar gaya (card ₹${entry} vs live ₹${liveR}); fresh card agle pass` };
      }
    }
  } catch { /* ladder unavailable — card levels hi use karo (paper engine) */ }
  const reward = Number(pick.target) - entry; // R
  const t1 = +(entry + reward * 0.5).toFixed(2);  // card t1 — 50% book halfway
  const t2 = +(entry + reward * 1.0).toFixed(2); // card t2 — full target pe runner
  const sl = Number(pick.stopLoss);

  const { openPaperTrade } = await import('../intraday/paperTrading.js');
  const res = openPaperTrade({
    symbol: `${pick.symbol}${Math.round(pick.strike)}${pick.type}`, // NIFTY23400CE
    direction: 'LONG',                                  // premium BUY
    entry, qty: 1,                                      // 1 lot
    stopLoss: sl, target1: t1, target2: t2,
    market: 'INDIA',
    assetKind: 'OPTION', underlying: pick.symbol,
    strike: Number(pick.strike), optType: pick.type, expiry: pick.expiry,
    iv: Number(pick.iv) > 0 ? Number(pick.iv) : 13,     // BS fallback IV — card builder jaisa
    lotSize: Number(pick.lotSize) || 1,
    label: `${pick.name} · AUTO`,                        // marker: UI me auto-entry pehchana jaye
  });
  if (res?.error) return { ok: false, error: res.error };

  // state update (quota/cooldown)
  const u = String(pick.symbol || '').toUpperCase();
  s.count = Number(s.count || 0) + 1;
  s.perUnderlying = { ...(s.perUnderlying || {}), [u]: Number((s.perUnderlying || {})[u] || 0) + 1 };
  s.lastEntryAt = { ...(s.lastEntryAt || {}), [u]: now };
  s.lastEntry = { at: now, contract: `${pick.symbol}${Math.round(pick.strike)}${pick.type}`, underlying: u, aiScore: pick.aiScore, entry, t1, t2, sl };
  _saveState(s);

  const line = `🪜 <b>OPTIONS AUTO-ENTRY (paper)</b> — ${pick.name}\n` +
    `Entry ₹${entry} · SL ₹${sl} · T1 ₹${t1} (SL→breakeven) · T2 ₹${t2}\n` +
    `AI ${pick.aiScore}/100 · lot ${pick.lotSize} · quota ${s.count}/${cfg.quotaPerDay}`;
  try { if (sendTelegram) await sendTelegram(line); } catch { /* notify best-effort */ }
  return { ok: true, opened: s.lastEntry };
}
