// ============================================================
// intraday/committee — TRADER COMMITTEE DEBATE (Phase 2)
// ------------------------------------------------------------
// World-class desk pattern: three specialist personas analyse the
// SAME top setups from different lenses and debate; a judge pass
// synthesizes the FINAL desk verdict.
//
//   ⚡ SCALPER     — fast in-and-out, tight stops, ORB/first-hour
//   📈 MOMENTUM    — trend + volume confirmation, ride winners
//   🛡️ RISK GUARDIAN — capital protection, veto weak structures
//
// Flow: 3 parallel persona calls (askLLM) → 1 judge synthesis.
// Total 4 AI calls per debate — cost-bounded and cached 10 min.
// ============================================================
import { askLLM } from './agent.js';
import { getISTParts, marketPhase, isNseMarketOpen } from './time.js';

const PERSONAS = [
  {
    id: 'SCALPER',
    icon: '⚡',
    label: 'The Scalper',
    system: `You are "THE SCALPER" — an elite NSE intraday scalper (15 yrs, prop-desk). You live on the 1-5 min charts: ORB-15 breakouts, VWAP reclaims, first-hour momentum bursts, quick 0.5-1R scalps with TIGHT stops. You LOVE velocity: relative volume >1.5x, ADX >25, price extensions you can fade or join fast. You HATE slow grinding ranges and late-day entries. Debate style: punchy, 3-4 tight bullets per setup. Vote TRADE (with your scalper-optimized levels) or PASS per setup. Hinglish, max 15 words per bullet.`,
  },
  {
    id: 'MOMENTUM',
    icon: '📈',
    label: 'The Momentum Rider',
    system: `You are "THE MOMENTUM RIDER" — an elite NSE intraday trend trader (15 yrs, prop-desk). You want the CLEANEST trends: EMA10>EMA20 stack, price holding above VWAP, ADX >22, volume expanding, RSI 55-70 not exhausted. You let winners run to T2 (2.6R) and trail AFTER T1 — you'd rather miss 10 trades than take 1 choppy one. You HATE counter-trend and low-ADX chop. Debate style: 3-4 bullets per setup on trend quality. Vote TRADE (full plan to T2) or PASS. Hinglish, max 15 words per bullet.`,
  },
  {
    id: 'RISK_GUARDIAN',
    icon: '🛡️',
    label: 'The Risk Guardian',
    system: `You are "THE RISK GUARDIAN" — the desk's capital-protection officer (20 yrs, survived 2008/2020). You are the DEVIL'S ADVOCATE: for every setup you list what can go WRONG — counter-regime risk, gap traps, exhaustion entries, sector crowding, event risk, VIX spikes. You only approve setups where risk is structurally contained (clean stop placement, sane RR, no counter-NIFTY fight). You have VETO power: if structure is weak, say VETO. Debate style: 2-3 bullets of risk per setup. Vote APPROVE or VETO with one-line reason. Hinglish, max 15 words per bullet.`,
  },
];

function buildDebatePrompt(setups, regime) {
  const setupLines = setups.map(s =>
    `${s.symbol} ${s.direction} | conf ${s.confidence}% | LTP ${s.ltp} (${s.changePct >= 0 ? '+' : ''}${s.changePct}%) | entry ${s.entry} | SL ${s.stopLoss} | T1 ${s.target1} | T2 ${s.target2} | RR 1:${s.rr} | RSI ${s.rsi} | ADX ${s.adx} | vol ${s.volumeRatio}x | VWAP-dist ${s.vwapDist}% | trend ${s.trendStrength}${s.counterTrend ? ' | COUNTER-REGIME' : ''}`
  ).join('\n');
  const regimeLine = regime
    ? `Market regime: NIFTY ${regime.regime} (${regime.niftyChange >= 0 ? '+' : ''}${regime.niftyChange}%), VIX ${regime.vix ?? 'n/a'} (${regime.vixLevel ?? 'n/a'})`
    : 'Market regime: n/a';
  return `TODAY'S TOP INTRADAY SETUPS (quant engine + AI consensus):\n${setupLines}\n\n${regimeLine}\n\nAs your persona, give your desk take on EACH setup (max 3-4 tight bullets each). End with a "VOTES:" line in STRICT format:\nVOTES: SYMBOL=TRADE|PASS|VETO:reason(≤10 words); SYMBOL=...`;
}

const JUDGE_SYSTEM = `You are the HEAD OF DESK — the final authority of an elite NSE intraday trading committee. You receive three specialist opinions (Scalper ⚡ / Momentum 📈 / Risk Guardian 🛡️) on the same setups. Your job: FINAL DESK VERDICT per setup.

Rules:
- 2+ TRADE votes with no VETO → APPROVED (confidence high)
- Any VETO with a structural reason (counter-regime, exhaustion, weak stop) → downgrade or REJECT
- 1 TRADE + 1 PASS + 1 VETO → REJECT unless the TRADE vote is overwhelming
- Risk Guardian's structural vetoes OVERRIDE bullish enthusiasm

Output format (STRICT, per setup):
### SYMBOL — VERDICT (APPROVED / REJECTED / CAUTION)
- One-line desk reason (Hinglish)
- Final levels: Entry / SL / T1 / T2 / Qty per ₹1L (use committee's consensus, adjust if Guardian flagged risk)
Then a final section "DESK SUMMARY" with: max trades to take today, sector notes, one risk line.`;

function parseVotes(text) {
  const votes = {};
  const m = String(text || '').match(/VOTES:\s*([^\n]+)/i);
  if (!m) return votes;
  for (const part of m[1].split(';')) {
    const v = part.trim().match(/^([A-Z0-9&-]+)\s*=\s*(TRADE|PASS|VETO)\s*:?\s*(.*)$/i);
    if (v) votes[v[1].toUpperCase()] = { vote: v[2].toUpperCase(), reason: v[3].trim().slice(0, 80) };
  }
  return votes;
}

// Cache: debate is expensive — serve the same result for 10 min.
// Failed debates are negatively cached for 90s (anti retry-storm).
let _cache = { data: null, ts: 0, inflight: null, failTs: 0, failResult: null };

export async function runCommitteeDebate(deps) {
  const { getLastScan, triggerScan, getMarketRegime, KEYS, OPENAI_COMPAT } = deps || {};
  if (_cache.data && Date.now() - _cache.ts < 10 * 60 * 1000) return _cache.data;
  if (_cache.failResult && Date.now() - _cache.failTs < 90 * 1000) return _cache.failResult;
  if (_cache.inflight) return _cache.inflight;

  _cache.inflight = (async () => {
    try {
      let scan = getLastScan?.();
      let setups = (scan?.signals || []).slice(0, 3);
      // Stale/empty cache (60s TTL) → trigger a fresh scan, same as agent &
      // briefing paths. Without this the committee returns "no setups" on
      // the first request after every cache expiry / server restart.
      if (setups.length === 0) {
        try { scan = (await triggerScan?.()) || scan; } catch { /* optional */ }
        setups = (scan?.signals || []).slice(0, 3);
      }
      if (setups.length === 0) {
        return { ok: false, error: 'Live setups nahi mil rahe — pehle scan complete hone dein (market hours me auto hota hai).' };
      }

      let regime = scan.marketRegime || null;
      if (!regime) {
        try { regime = await getMarketRegime?.(); } catch { /* optional */ }
      }

      const prompt = buildDebatePrompt(setups, regime);
      const llmDeps = { KEYS, OPENAI_COMPAT };

      // 3 personas in PARALLEL — one call each.
      const personaResults = await Promise.all(PERSONAS.map(async (p) => {
        const r = await askLLM(p.system, prompt, llmDeps, { temperature: 0.5, maxTokens: 1800 });
        return r
          ? { id: p.id, icon: p.icon, label: p.label, take: r.text, votes: parseVotes(r.text), engine: r.engine }
          : { id: p.id, icon: p.icon, label: p.label, take: null, votes: {}, engine: null };
      }));

      const anyTake = personaResults.some(p => p.take);
      if (!anyTake) {
        return { ok: false, error: 'AI engines unavailable — committee debate abhi nahi ho sakta.' };
      }
      // v18.9 PERSONA QUORUM — 2 of 3 personas must actually answer. The
      // old gate accepted a single responder: 2 silent failures still
      // published a "committee" verdict where the judge weighed one real
      // opinion against two "(no response)" placeholders.
      const takes = personaResults.filter(p => p.take).length;
      if (takes < 2) {
        return { ok: false, error: `Committee quorum fail — sirf ${takes}/3 personas ne jawab diya (debate postpone, honest degrade).` };
      }

      // Judge synthesis — one call with all opinions.
      const opinions = personaResults.map(p =>
        `${p.icon} ${p.label}:\n${p.take || '(no response)'}`
      ).join('\n\n---\n\n');
      const judge = await askLLM(
        JUDGE_SYSTEM,
        `SETUPS:\n${setups.map(s => `${s.symbol} ${s.direction} conf ${s.confidence}% (SL ${s.stopLoss}, T1 ${s.target1}, T2 ${s.target2})`).join('\n')}\n\nCOMMITTEE OPINIONS:\n${opinions}\n\nGive the FINAL DESK VERDICT.`,
        llmDeps,
        { temperature: 0.3, maxTokens: 2200 },
      );

      const { hour, minute } = getISTParts();
      const result = {
        ok: true,
        asOf: new Date().toISOString(),
        istTime: `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')} IST`,
        marketPhase: marketPhase(),
        marketOpen: isNseMarketOpen(),
        regime,
        setups: setups.map(s => ({
          symbol: s.symbol, direction: s.direction, confidence: s.confidence,
          ltp: s.ltp, entry: s.entry, stopLoss: s.stopLoss,
          target1: s.target1, target2: s.target2, rr: s.rr,
        })),
        personas: personaResults,
        verdict: judge ? judge.text : null,
        verdictEngine: judge?.engine || null,
        disclaimer: 'Educational committee simulation — not investment advice.',
      };
      _cache.data = result;
      _cache.ts = Date.now();
      _cache.failTs = 0; _cache.failResult = null;
      return result;
    } catch (e) {
      // Negative cache: a failed debate (AI down, etc.) must not trigger a
      // retry storm — each retry costs up to 3 persona + 1 judge LLM calls.
      // Cache the failure for 90s so polling clients back off naturally.
      _cache.failTs = Date.now();
      _cache.failResult = { ok: false, error: `Committee debate failed: ${e?.message || e}` };
      return _cache.failResult;
    } finally {
      _cache.inflight = null;
    }
  })();

  return _cache.inflight;
}

export function clearCommitteeCache() {
  _cache = { data: null, ts: 0, inflight: null, failTs: 0, failResult: null };
}
