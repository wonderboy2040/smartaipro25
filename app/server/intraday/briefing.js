// ============================================================
// intraday/briefing — DAILY DESK BRIEFING (Phase 2)
// ------------------------------------------------------------
// • generateDailyBriefing() — agent-grade morning briefing built
//   from live scan + regime + track-record (used for BOTH the
//   in-app voice briefing and the Telegram push).
// • generateVoiceBriefing() — short spoken-word version for the
//   browser speechSynthesis voice panel.
// • Cron (node-cron): 09:10 IST Mon-Fri → Telegram briefing.
// ============================================================
import { askLLM } from './agent.js';
import { getISTParts, marketPhase as _marketPhase, isNseMarketOpen, istDayKey } from './time.js';
import { loadJSON, saveJSON } from './store.js';

const BRIEFING_FILE = 'last-briefing.json';
let _last = loadJSON(BRIEFING_FILE, { text: null, voiceText: null, dayKey: '', ts: 0 });

const BRIEFING_SYSTEM = `You are the HEAD OF DESK at an elite NSE intraday trading firm, writing the MORNING DESK BRIEFING (pre-open / early session). Your traders (Indian retail, Hinglish speakers) will act on this.

Structure (STRICT):
**Market Regime** — NIFTY/VIX read + what it means for trade bias today (2-3 lines)
**Top Setups** — per setup: SYMBOL (direction) — entry zone, SL, T1/T2, one-line why (use ONLY the data provided, do NOT invent)
**Desk Priorities** — 2-3 bullets: what to attack first hour, what to avoid
**Risk Radar** — 2 bullets: regime risk, event/sector risk
**Discipline Line** — one hard rule for today

Tone: crisp desk-trader Hinglish, no waffle, no disclaimers beyond one risk line at the end. Max 220 words.`;

const VOICE_SYSTEM = `Convert the desk briefing into a SPOKEN voice briefing for text-to-speech (Hindi-English mix, Roman script). Rules:
- 80-100 words MAX (about 40 seconds of speech)
- No markdown, no symbols, no numbers lists — speak naturally
- Say amounts like "sawan assi" style numerals are NOT needed — use normal digits spoken-friendly ("eight hundred level")
- Structure: greeting → regime in one line → top 2 setups (symbol, direction, one reason each) → one risk reminder → sign off "Jai Hind, trade discipline ke saath."
- Plain text only, ready for speechSynthesis.`;

export function getLastBriefing() {
  return _last && _last.text ? { ..._last, fresh: _last.dayKey === istDayKey() } : null;
}

// In-flight dedup: cron + manual endpoints can hit the generator at the same
// second (09:10 cron vs ?fresh=1 vs /push) — without this guard every
// concurrent call fires its own 2 LLM calls (duplicate cost + TG pushes).
let _inflight = null;

export async function generateDailyBriefing(deps) {
  if (_inflight) return _inflight;
  _inflight = _generateBriefing(deps).finally(() => { _inflight = null; });
  return _inflight;
}

async function _generateBriefing(deps) {
  const { getLastScan, getMarketRegime, getTrackRecord, KEYS, OPENAI_COMPAT } = deps || {};
  try {
    let scan = getLastScan?.();
    if (!scan || !scan.signals?.length) {
      scan = (await deps?.triggerScan?.()) || scan;
    }

    // CRITICAL (financial correctness): never present a stale (yesterday's)
    // scan as TODAY'S setups. At 09:10 pre-open the 60s cache can still hold
    // the previous session's scan — day-old LTPs/levels would be briefed as
    // live and stored as today's briefing all day.
    const scanIsToday = !!(scan?.asOf && istDayKey(new Date(scan.asOf)) === istDayKey());
    const signals = scanIsToday ? (scan?.signals || []).slice(0, 5) : [];

    let regime = scan?.marketRegime || null;
    if (!regime) {
      try { regime = await getMarketRegime?.(); } catch { /* optional */ }
    }

    let perf = null;
    try {
      const tr = getTrackRecord?.(7);
      if (tr && tr.totalTracked > 0) {
        perf = {
          winRate: tr.winRate, avgR: tr.avgR, resolved: tr.resolved,
          totalTracked: tr.totalTracked, disciplinedPnlPerLakh: tr.disciplinedPnlPerLakh,
        };
      }
    } catch { /* optional */ }

    const { hour, minute, weekday } = getISTParts();
    const dataBlock = `DATE: ${weekday} ${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')} IST | Market: ${isNseMarketOpen() ? 'OPEN' : 'PRE-OPEN/CLOSED'}
REGIME: ${regime ? `NIFTY ${regime.regime} ${regime.niftyChange >= 0 ? '+' : ''}${regime.niftyChange}% | VIX ${regime.vix ?? 'n/a'} (${regime.vixLevel ?? 'n/a'})` : 'unavailable — say regime data pending, trade light'}
${perf ? `TRACK RECORD (7d): win-rate ${perf.winRate?.toFixed(1) ?? 'n/a'}%, avg ${perf.avgR != null ? (perf.avgR >= 0 ? '+' : '') + perf.avgR + 'R' : 'n/a'}, ${perf.resolved}/${perf.totalTracked} resolved, P&L/₹1L ₹${perf.disciplinedPnlPerLakh?.toFixed(0) ?? 0}` : 'TRACK RECORD: no data yet'}
${signals.length ? `LIVE TOP SETUPS (today's scan):\n${signals.map(s => `${s.symbol} ${s.direction} conf ${s.confidence}% | LTP ${s.ltp} | entry ${s.entryZoneLow ?? s.entry}-${s.entryZoneHigh ?? s.entry} | SL ${s.stopLoss} | T1 ${s.target1} | T2 ${s.target2} | RR 1:${s.rr} | ${s.reasons?.slice(0, 2).join(', ') || ''}`).join('\n')}` : 'LIVE SETUPS: scanner warm-up me hai (pre-open / stale cache cleared) — desk ko bolo first 15 min observation only'}`;

    const r = await askLLM(BRIEFING_SYSTEM, dataBlock, { KEYS, OPENAI_COMPAT }, { temperature: 0.4, maxTokens: 1600 });
    if (!r) return { ok: false, error: 'AI engines unavailable — briefing generate nahi ho payi.' };

    // Voice version (short, spoken-word) — best-effort, time-boxed so a slow
    // provider can never block the briefing route/cron (was: fully awaited
    // in the critical path adding up to 20-30s).
    let voiceText = null;
    try {
      const v = await Promise.race([
        askLLM(VOICE_SYSTEM, r.text, { KEYS, OPENAI_COMPAT }, { temperature: 0.4, maxTokens: 500, timeout: 20000 }),
        new Promise(resolve => setTimeout(() => resolve(null), 22000)),
      ]);
      if (v) voiceText = v.text;
    } catch { /* voice is optional */ }

    _last = {
      text: r.text,
      voiceText,
      dayKey: istDayKey(),
      ts: Date.now(),
      engine: r.engine,
      regime, perf,
      setupsUsed: signals.length,
    };
    saveJSON(BRIEFING_FILE, _last);
    return { ok: true, briefing: _last };
  } catch (e) {
    return { ok: false, error: `Briefing failed: ${e?.message || e}` };
  }
}

// Telegram push — cron entry point (09:10 IST Mon-Fri).
export async function pushMorningBriefingToTelegram(deps) {
  const { sendTelegramRaw, escapeHtml } = deps || {};
  if (typeof sendTelegramRaw !== 'function') return false;

  const result = await generateDailyBriefing(deps);
  if (!result.ok) {
    console.warn('[briefing-cron]', result.error);
    return false;
  }

  const esc = escapeHtml || (x => String(x));
  // Telegram HTML: strip **bold** markdown → <b>, keep it compact.
  const html = result.briefing.text
    .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
    .replace(/^###?\s*(.+)$/gm, '<b>$1</b>')
    .split('\n').map(l => l.trim() ? esc(l).replace(/&lt;b&gt;|&lt;\/b&gt;/g, m => m === '&lt;b&gt;' ? '<b>' : '</b>') : '')
    .join('\n');

  const msg = `<b>🎙️ MORNING DESK BRIEFING</b>\n<code>━━━━━━━━━━━━━━━━━━━━━</code>\n\n${html}\n\n<code>━━━━━━━━━━━━━━━━━━━━━</code>\n⏰ ${new Date().toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour12: false })} IST • PRO TRADER AGENT — not investment advice.`;

  try {
    const ok = await sendTelegramRaw(msg);
    if (ok) console.log('[briefing-cron] Morning briefing pushed to Telegram');
    return ok;
  } catch (e) {
    console.warn('[briefing-cron] Telegram push failed:', e?.message);
    return false;
  }
}
