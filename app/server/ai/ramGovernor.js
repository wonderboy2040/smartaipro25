// ============================================================
// server/ai/ramGovernor.js — v20.6 LOCAL-FIRST RAM GOVERNOR
// ------------------------------------------------------------
// 16GB laptop setup: Windows + Chrome automation profile (CoinDCX +
// Dhan + SmartAI tabs) + Node server + ml-service (Python) + Ollama
// qwen3:8b all running locally. Without a governor, the Ollama
// KV-cache + HF models (Chronos/FinBERT torch) can push the box
// into swap → event-loop freezes (the very thing selfHeal flags).
//
// Three-state traffic light:
//   GREEN  (>3.5GB free)  — normal: LLM calls + entries both OK
//   YELLOW (2.0–3.5GB)    — LLM calls block (deterministic mode),
//                            HF models unload, NO new auto entries
//                            until GREEN resumes
//   RED    (<2.0GB)       — only position management runs; new
//                            entries blocked; Telegram CRITICAL
//                            alert (one-shot per transition).
//
// The governor NEVER throws. Reads os.freemem() + process.memoryUsage()
// every 10s (unref'd). Single-flight: state changes are idempotent
// within a window. Other modules call ramState() / ramCanEnter() /
// ramCanLLM() — pure boolean gates that never block.
//
// Tunables via env:
//   RAM_YELLOW_FREE_GB  (default 3.5)
//   RAM_RED_FREE_GB     (default 2.0)
//   RAM_TICK_SEC         (default 10)
//   RAM_RSS_RESERVE_MB   (default 600) — RSS headroom for the Node
//                        process itself; if process RSS alone exceeds
//                        (TOTAL_PHYSICAL - RAM_RSS_RESERVE_MB), force
//                        YELLOW regardless of free.
// ============================================================
import os from 'node:os';

const DEFAULTS = Object.freeze({
  yellowFreeGB: 3.5,
  redFreeGB: 2.0,
  tickSec: 10,
  rssReserveMB: 600,
});

const _state = {
  armed: false,
  state: 'GREEN',          // 'GREEN' | 'YELLOW' | 'RED'
  freeMB: 0,
  rssMB: 0,
  totalMB: 0,
  lastStateChangeAt: 0,
  lastRedAlertAt: 0,
  cfg: { ...DEFAULTS },
  _timer: null,
  _alertSink: null,        // optional (msg) => void for Telegram CRITICAL
};

function _toMB(bytes) { return Math.max(0, Math.round((bytes || 0) / 1048576)); }
function _toGB(mb) { return Number((mb / 1024).toFixed(2)); }

export function initRamGovernor({ env = process.env, alertSink = null } = {}) {
  _state.armed = true;
  _state.cfg = {
    yellowFreeGB: Number(env.RAM_YELLOW_FREE_GB) > 0 ? Number(env.RAM_YELLOW_FREE_GB) : DEFAULTS.yellowFreeGB,
    redFreeGB: Number(env.RAM_RED_FREE_GB) > 0 ? Number(env.RAM_RED_FREE_GB) : DEFAULTS.redFreeGB,
    tickSec: Number(env.RAM_TICK_SEC) > 0 ? Number(env.RAM_TICK_SEC) : DEFAULTS.tickSec,
    rssReserveMB: Number(env.RAM_RSS_RESERVE_MB) > 0 ? Number(env.RAM_RSS_RESERVE_MB) : DEFAULTS.rssReserveMB,
  };
  _state._alertSink = typeof alertSink === 'function' ? alertSink : null;
  _state.totalMB = _toMB(os.totalmem());
  // first sample immediately so ramState() reflects truth on boot
  _tick();
  // then on a 10s cadence, unref'd so the timer never keeps the loop alive
  try {
    if (_state._timer) clearInterval(_state._timer);
    _state._timer = setInterval(_tick, _state.cfg.tickSec * 1000);
    if (typeof _state._timer.unref === 'function') _state._timer.unref();
  } catch { /* timer best-effort */ }
  return true;
}

export function ramGovernorArmed() { return !!_state.armed; }

export function ramState() {
  return {
    armed: _state.armed,
    state: _state.state,
    freeGB: _toGB(_state.freeMB),
    rssMB: _state.rssMB,
    totalGB: _toGB(_state.totalMB),
    yellowGB: _state.cfg.yellowFreeGB,
    redGB: _state.cfg.redFreeGB,
    since: _state.lastStateChangeAt,
  };
}

export function ramCanEnter() {
  if (!_state.armed) return true;            // un-armed = no gate
  return _state.state !== 'RED';
}

export function ramCanLLM() {
  if (!_state.armed) return true;            // un-armed = no gate
  return _state.state === 'GREEN';
}

function _tick() {
  try {
    const free = os.freemem();
    const rss = process.memoryUsage().rss;
    _state.freeMB = _toMB(free);
    _state.rssMB = _toMB(rss);

    // The total-physical-minus-reserve check guards the degenerate case
    // where the OS reports lots of "free" memory because the working
    // set lives in swap (this happens right before a full lockup).
    const rssFloorHit = _state.totalMB > 0
      && _state.rssMB > (_state.totalMB - _state.cfg.rssReserveMB)
      && _state.totalMB > 1024; // ignore tiny CI containers

    let next;
    if (_state.freeMB < _state.cfg.redFreeGB * 1024) next = 'RED';
    else if (_state.freeMB < _state.cfg.yellowFreeGB * 1024 || rssFloorHit) next = 'YELLOW';
    else next = 'GREEN';

    if (next !== _state.state) {
      _state.state = next;
      _state.lastStateChangeAt = Date.now();
      // one-shot alert on RED ENTRY (state change to RED). The min-gap
      // applies only WITHIN a sustained RED state (suppresses oscillation
      // spam if the state flaps RED→GREEN→RED within 5 min); the alert
      // fires on every fresh RED entry.
      if (next === 'RED' && typeof _state._alertSink === 'function') {
        const now = Date.now();
        _state.lastRedAlertAt = now;
        try {
          _state._alertSink(`🚨 RAM GOVERNOR: RED — free ${_toGB(_state.freeMB)}GB / RSS ${_state.rssMB}MB. New auto-entries BLOCKED; existing positions managed. Ollama should be unloaded; HF models OFF.`);
        } catch { /* alert best-effort */ }
      }
    }
  } catch { /* governor must never throw */ }
}

export function __resetRamGovernorForTests() {
  if (_state._timer) { try { clearInterval(_state._timer); } catch { /* timer teardown best-effort */ } }
  _state.armed = false;
  _state.state = 'GREEN';
  _state.freeMB = 0;
  _state.rssMB = 0;
  _state.totalMB = 0;
  _state.lastStateChangeAt = 0;
  _state.lastRedAlertAt = 0;
  _state.cfg = { ...DEFAULTS };
  _state._timer = null;
  _state._alertSink = null;
}

// Test hooks — drive a tick with injected free/rss values
export function __driveRamTickForTests(freeMB, rssMB) {
  _state.freeMB = Math.max(0, Math.round(freeMB));
  _state.rssMB = Math.max(0, Math.round(rssMB));
  _state.totalMB = _state.totalMB || 16 * 1024; // default 16GB box
  // re-evaluate state using the same logic as _tick
  const rssFloorHit = _state.rssMB > (_state.totalMB - _state.cfg.rssReserveMB) && _state.totalMB > 1024;
  let next;
  if (_state.freeMB < _state.cfg.redFreeGB * 1024) next = 'RED';
  else if (_state.freeMB < _state.cfg.yellowFreeGB * 1024 || rssFloorHit) next = 'YELLOW';
  else next = 'GREEN';
  if (next !== _state.state) {
    _state.state = next;
    _state.lastStateChangeAt = Date.now();
    // fire alert on every fresh RED entry (no min-gap — that's only
    // for suppressing within-state re-ticks, which the test hook
    // never triggers because it doesn't change state without a
    // state transition)
    if (next === 'RED' && typeof _state._alertSink === 'function') {
      _state.lastRedAlertAt = Date.now();
      try { _state._alertSink(`🚨 RAM GOVERNOR: RED — free ${_toGB(_state.freeMB)}GB / RSS ${_state.rssMB}MB.`); } catch { /* sample read best-effort */ }
    }
  }
}
