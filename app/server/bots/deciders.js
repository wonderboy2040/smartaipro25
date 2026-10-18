// ============================================================
// server/bots/deciders.js — Jev Bot Lab v21.14.0
// ------------------------------------------------------------
// Plan §7.1: SAB ARMS, SAME CANDIDATES.
//   rules    — har candidate lo (baseline)
//   gated    — hand-written gates (CONTROL ARM — AI isi se compare hota
//              hai; plan ground rule #3)
//   jev      — Jev wahi candidates filter kare        (cloud)
//   auto     — AI provider (jev); down/error pe honest WAIT
// Deciders NEVER generate or mutate candidates — identical input
// set is what makes the A/B meaningful (plan §7.1: "Alag
// candidates = alag strategies, A/B bekar").
//
// v21.2.0 SAFETY (dual-provider plan §3.1 — koi bhi mode nahi todta):
//   • AI sirf ENTRY pe, flat position pe; side flip / sizing / SL/TP
//     kabhi nahi (createJev ke andar + yahan approves() — defense in
//     depth)
//   • error/timeout/exception = WAIT; 'rule' fallback sirf conscious
//     config (jev arm, JEV_FALLBACK=rule)
// v21.14.0 (Laya removal): laya/consensus arms removed — legacy
// state files botRunner availability-resolve se gated pe fall back
// karte hain (arm_fallback event ke saath).
// ============================================================

/**
 * rules arm: take everything.
 */
export function rulesDecider() {
  return async (_candidate, _row) => ({ action: 'take', arm: 'rules' });
}

/**
 * gated arm: strategy's hand-written gates, first veto wins.
 * Every gate returns a STABLE reason string (plan §6.1: "har ek
 * ek stable veto reason return kare") — veto breakdown reporting
 * depends on this.
 */
export function gatedDecider(strategy, { eventGuardCheck = null } = {}) {
  const gates = typeof strategy.gates === 'function' ? strategy.gates() : [];
  return async (candidate, row) => {
    const ctx = {
      features: candidate?.features || {},
      side: candidate?.side,
      frictionRiskR: candidate?.frictionRiskR,
      atr: row?.atr,
      emaFastSlope: row?.emaFastSlope,
    };
    // runtime event-day gate (needs live calendar) when provided
    if (eventGuardCheck) {
      try {
        const eg = eventGuardCheck({ symbol: candidate.symbol, desk: strategy.desk === 'india' ? 'INDIA' : 'CRYPTO' });
        if (eg?.blocked) ctx.eventDay = true;
      } catch { /* event guard failure must not fake a veto */ }
    }
    for (const g of gates) {
      let veto = null;
      try { veto = g(row, ctx); } catch { veto = `${g.name || 'gate'}:error`; }
      if (veto) return { action: 'wait', reason: veto, arm: 'gated' };
    }
    return { action: 'take', arm: 'gated' };
  };
}

/**
 * Snapshot + prompt build with the event-day context line — jevDecider
 * (v20.9.0 A3) wali logic, ab dono deciders share karte hain.
 */
function _snapPrompt(strategy, candidate, row, eventGuardCheck) {
  let snap = strategy.snapshot(candidate.symbol, row?.bar?.time ?? Date.now(), row, candidate);
  let eventDayLine = 'event_day: no';
  if (eventGuardCheck) {
    try {
      const eg = eventGuardCheck({ symbol: candidate.symbol, desk: strategy.desk === 'india' ? 'INDIA' : 'CRYPTO' });
      if (eg?.blocked) eventDayLine = `event_day: yes (${eg.label || 'blackout window'})`;
    } catch { /* event guard failure must not fake a veto */ }
  }
  if (typeof snap === 'string') snap = `${snap}\n${eventDayLine}`;
  else if (snap && typeof snap === 'object') snap.eventDay = eventDayLine;
  const prompt = strategy.jevPrompt();
  return { snap, prompt };
}

/**
 * jev arm: strategy proposes, Jev approves/vetoes.
 * NO side flips, NO sizing, NO SL/TP from Jev (ground rule #2).
 */
export function jevDecider({ jev, strategy, eventGuardCheck = null }) {
  return async (candidate, row) => {
    // v20.8.2 FIX (L — dead code): a gatedDecider instance used to be
    // built here but never called (the commented gatesInFront config
    // never existed) — removed; re-add BOTH together if that experiment
    // ever lands (plan: jev replaces gates, comparison is the point).
    const { snap, prompt } = _snapPrompt(strategy, candidate, row, eventGuardCheck);
    const v = await jev(snap, prompt);
    // v20.8.1 FIX (H1 — the Jev arm was a placebo): the Jev client
    // returns the RAW choice ('enter_long'|'enter_short'|'wait') but
    // BOTH consumers (engine.js + botRunner.js) gate on
    // verdict.action !== 'take' -> every Jev APPROVAL was treated as
    // a veto and the jev arm could never take a trade. Normalize to
    // the decider contract here ('take'|'wait') and keep the raw
    // choice as `jevChoice` for telemetry/decisionBreakdown.
    const verdict = {
      action: v.action === 'wait' ? 'wait' : 'take',
      reason: v.note || null,
      arm: 'jev',
      jev: { choice: v.action || null, probs: v.probs, confidence: v.confidence, cached: v.cached, latencyMs: v.latencyMs, aux: v.aux },
    };
    return verdict;
  };
}

// v21.2.0: notes jo AUTO-FAILOVER trigger karte hain. 4xx
// (http_422/400/401) is list me NAHI hain — bad request dusre
// provider pe bhi waisa hi fail hoga. no_answer/no_probability bhi
// nahi — wo malformed-response hai provider-down nahi. 'timeout'
// included — failover turant hona chahiye (network_error ka wait nahi).
const _FAILOVER_NOTES = new Set(['breaker_open', 'network_error', 'provider_unavailable', 'timeout']);
const _isFailoverNote = (note) => !!note
  && (_FAILOVER_NOTES.has(note) || /^http_5\d\d$/.test(String(note)));

const _pack = (v) => ({
  choice: v?.action || null,
  probs: v?.probs ?? null,
  confidence: v?.confidence ?? null,
  cached: !!v?.cached,
  latencyMs: v?.latencyMs ?? null,
  note: v?.note ?? null,
});

/**
 * v21.14 — AI DECIDER (jev provider, plan §3.1 lineage).
 *
 *   mode='jev'  : single provider approve/veto
 *   mode='auto' : jev call; provider down/error pe honest WAIT
 *                 (v21.14: failover target tha Laya — removed; auto
 *                 ab jev-only hai, note me failover intent dikhta hai)
 *
 * Verdict: { action:'take'|'wait', reason, arm:mode,
 *            ai:{ jev:{...}|null },
 *            jev: <deciding provider ka compat block> }
 */
export function aiDecider({ providers, mode, primary: _primary = 'jev', shadow: _shadow = 'off', onDown: _onDown = 'wait', strategy, eventGuardCheck = null }) {
  const P = providers || {};
  return async (candidate, row) => {
    try {
      const { snap, prompt } = _snapPrompt(strategy, candidate, row, eventGuardCheck);
      const ai = { jev: null };
      const call = async (name) => {
        const inst = P[name];
        if (!inst) return { action: 'wait', note: 'provider_unavailable', cached: false, latencyMs: 0 };
        try { return await inst(snap, prompt); }
        catch (e) {
          // provider exception = WAIT, kabhi crash nahi (plan: koi bhi
          // exception -> wait)
          return { action: 'wait', note: 'provider_exception', error: String(e?.message || e).slice(0, 120), cached: false, latencyMs: 0 };
        }
      };
      // approve = raw provider choice EXACTLY proposed side pe (side flip
      // createJev ke andar bhi banned hai — ye second layer hai)
      const approves = (v) => v?.action === snap.proposed;

      let action = 'wait';
      let reason = null;
      let deciderProvider = null;

      if (mode === 'auto') {
        const v = await call('jev');
        ai.jev = _pack(v);
        deciderProvider = 'jev';
        if (!approves(v) && _isFailoverNote(v.note)) {
          // v21.14: koi failover target nahi bacha — honest provider-down
          // WAIT (failover intent reason me)
          action = 'wait';
          reason = `provider_down(jev): ${v.note} — auto failover v21.14 me retired (single-provider)`;
        } else {
          action = approves(v) ? 'take' : 'wait';
          reason = v.note || (approves(v) ? null : (v.action || 'wait'));
        }
      } else {
        // single-provider mode: 'jev'
        const v = await call(mode);
        ai[mode] = _pack(v);
        deciderProvider = mode;
        action = approves(v) ? 'take' : 'wait';
        reason = v.note || (approves(v) ? null : (v.action || 'wait'));
      }

      return {
        action,
        reason,
        arm: mode,
        ai,
        // compat: botRunner event write + purana UI `verdict.jev` padhte
        // hain — deciding provider ka telemetry yahan baithta hai
        jev: deciderProvider ? { ...ai[deciderProvider] } : null,
      };
    } catch (e) {
      // koi bhi exception -> WAIT (plan ground rule: AI failure kabhi
      // trade nahi karta, aur kabhi crash bhi nahi karta)
      return { action: 'wait', reason: `ai_decider_error: ${String(e?.message || e).slice(0, 120)}`, arm: mode, ai: { jev: null }, jev: null };
    }
  };
}

/**
 * Decider factory by arm name (plan §9 flow step 4).
 *
 * Provider missing ho to THROW — botRunner usse pakad ke arm_fallback
 * event ke saath gated pe girta hai (silent nahi), routes 409 dete hain.
 * v21.14: laya/consensus arms REMOVED — legacy bot-state files me
 * arm='laya'/'consensus' ho to botRunner availability-resolve pehle
 * hi unhe gated/jev pe fall back kar deta hai.
 */
export function makeDecider({ arm, strategy, jev = null, providers = null, primary = 'jev', shadow = 'off', onDown = 'wait', eventGuardCheck = null }) {
  if (arm === 'rules') return rulesDecider();
  if (arm === 'gated') return gatedDecider(strategy, { eventGuardCheck });
  if (arm === 'jev') {
    const inst = providers?.jev || jev;
    if (!inst) throw new Error('deciders: jev arm needs a jev instance');
    // jev arm aiDecider se hi hota hai (ek hi code path) — approves()
    // side-flip defense. Purana verdict contract (arm:'jev',
    // jev.{choice,probs,cached,latencyMs}, take|wait) same.
    const provs = { ...(providers || {}), jev: inst };
    return aiDecider({ providers: provs, mode: 'jev', primary, shadow, onDown, strategy, eventGuardCheck });
  }
  if (arm === 'auto') {
    const provs = providers || { jev: jev || null };
    if (!provs.jev) throw new Error('deciders: auto arm needs a jev provider');
    return aiDecider({ providers: provs, mode: 'auto', primary, shadow, onDown, strategy, eventGuardCheck });
  }
  // v21.14: 'laya'/'consensus' retired — legacy persisted state
  // botRunner resolve me handle hota hai; yahan pahunch gaya hai to
  // unknown arm (upstream 400/409 paths se bhi filtered).
  throw new Error(`deciders: unknown arm '${arm}'`);
}
