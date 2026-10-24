// ============================================================
// server/ai/opencodeBridge.js — v21.24.0 · AI TRIO PHASE 1
// ------------------------------------------------------------
// The ONLY supported way to call OpenCode's free-tier models from
// this server: `opencode run` through the local CLI.
//
// Why a bridge instead of fetch?
//   • OpenCode free models are available only inside OpenCode.
//     A direct HTTP call to the inference endpoint with a
//     `*-free` model gets HTTP 403 (verified 2026-10-25).
//   • Paid direct API is a Phase 5 option; this module stays free
//     and local-only.
//
// Phase 1 scope:
//   • spawn `opencode run --format json` with the prompt on stdin
//   • parse the JSONL event stream with the shared tryParseJson()
//   • timeout + kill tree, bounded stdout, concurrency semaphore
//   • per-minute / per-day rate limits
//   • per-model circuit breaker
//   • cached CLI health probe (`--version`, `models`, `auth list`)
//   • tiny per-seat JSON probes for /api/ai/trio/probe
//
// NO signal, score, grade, side, SL, target, leverage or size logic
// lives here. Phase 2/3 will consume this bridge; this file must not
// import signals.js or boardAiConfirm.js.
//
// Windows note: `opencode` is a .cmd shim. Spawning it directly gives
// EINVAL. We spawn `cmd.exe /d /s /c` with a fully controlled command
// string and send the prompt through stdin, never through the shell.
// ============================================================
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tryParseJson } from './llmChain.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.resolve(__dirname, '..', '..');
const DEFAULT_SANDBOX_DIR = path.resolve(__dirname, 'opencode-sandbox');
const AGENT_NAME = 'signal-verifier';
const IS_WIN = process.platform === 'win32';
const PROMPT_MAX_CHARS = 12_000;
const STDERR_KEEP_CHARS = 4_000;

export const OPENCODE_SEATS = ['fast', 'deep', 'sentinel'];

const DEFAULT_SEAT_CHAINS = {
  fast: 'opencode:glm-5.3-flash-free,ollama:qwen3:8b',
  deep: 'opencode:deepseek-v4.1-flash-free,ollama:deepseek-r1:14b',
  sentinel: 'ollama:qwen2.5vl:7b,opencode:glm-5.3-flash-free,rule',
};

// Model IDs after the optional `opencode/` prefix. Deliberately strict:
// this value is embedded in the Windows cmd.exe command string.
const MODEL_RE = /^[a-z0-9][a-z0-9.-]{1,64}$/;

const PROBE_PROMPTS = {
  fast: [
    'You are the MOMENTUM GUARD for a trading desk. This is a connection probe.',
    'Return STRICT JSON only, no markdown, no prose:',
    '{"action":"CONFIRM|WAIT|REJECT","confidence":0-100,"flags":[],"note":"<=12 words"}',
    'Use action CONFIRM, confidence 75, and note "probe ok".',
  ].join('\n'),
  deep: [
    'You are the STRUCTURE VERIFIER for a trading desk. This is a connection probe.',
    'Return STRICT JSON only, no markdown, no prose:',
    '{"verdict":"LONG|SHORT|AVOID","confidence":0-100,"flags":[],"note":"<=12 words"}',
    'Use verdict LONG, confidence 75, and note "probe ok".',
  ].join('\n'),
  sentinel: [
    'You are the RISK SENTINEL for a trading desk. This is a connection probe.',
    'Return STRICT JSON only, no markdown, no prose:',
    '{"risk":"CLEAR|CAUTION|VETO","confidence":0-100,"flags":[],"note":"<=12 words"}',
    'Use risk CLEAR, confidence 75, and note "probe ok".',
  ].join('\n'),
};

export class OpenCodeBridgeError extends Error {
  constructor(message, code = 'error', meta = {}) {
    super(String(message || code));
    this.name = 'OpenCodeBridgeError';
    this.code = String(code || 'error');
    if (meta.retryAfterMs != null) this.retryAfterMs = Number(meta.retryAfterMs);
  }
}

const _state = {
  probe: {
    checkedAt: 0,
    checking: null,
    available: false,
    version: null,
    loggedIn: null,
    models: [],
    lastError: null,
  },
  breaker: new Map(),
  rate: {
    minuteStart: 0,
    minuteCount: 0,
    dayKey: '',
    dayCount: 0,
  },
  active: 0,
  queue: [],
};

// Test seams: production always uses node:child_process.spawn and the
// platform kill-tree implementation.
let _spawnImpl = spawn;
let _killTreeImpl = null;

// ---------------- small helpers ----------------

function _num(name, fallback) {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function _opencodeBin() {
  return String(process.env.OPENCODE_BIN || 'opencode');
}

function _sandboxDir() {
  const raw = String(process.env.OPENCODE_SANDBOX_DIR || '').trim();
  if (!raw) return DEFAULT_SANDBOX_DIR;
  return path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(APP_ROOT, raw);
}

function _maxBufferBytes() {
  return Math.max(64 * 1024, Math.round(_num('OPENCODE_MAX_BUFFER_MB', 4) * 1024 * 1024));
}

function _probeTtlMs() {
  return _num('OPENCODE_PROBE_TTL_MS', 300_000);
}

function _rateConfig() {
  return {
    maxPerMin: Math.floor(_num('OPENCODE_MAX_CALLS_PER_MIN', 12)),
    maxPerDay: Math.floor(_num('OPENCODE_MAX_CALLS_PER_DAY', 1_500)),
  };
}

function _localDayKey(now) {
  const d = new Date(now);
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

function _sanitizeError(value) {
  let s = String(value || '').replace(/[\r\n\t]+/g, ' ').trim();
  s = s
    .replace(/(?:bearer\s+)[a-z0-9._~+/=-]+/gi, 'Bearer [redacted]')
    .replace(/\b(?:sk|gsk|AIza|hf|xoxb)[-_a-z0-9]{8,}\b/gi, '[redacted]')
    .replace(/\b(?:api[_-]?key|token|secret)\s*[:=]\s*\S+/gi, '[redacted]');
  return s.slice(0, 220);
}

function _sanitizePrompt(prompt) {
  // Strip control chars without a control-character regex literal (ESLint
  // no-control-regex): keep tab/newline/CR, replace everything else.
  const s = Array.from(String(prompt ?? '')).map((ch) => {
    const code = ch.codePointAt(0) ?? 0;
    const control = code === 0 || (code < 32 && code !== 9 && code !== 10 && code !== 13) || code === 127;
    return control ? ' ' : ch;
  }).join('');
  if (!s.trim()) throw new OpenCodeBridgeError('opencode empty prompt', 'bad-prompt');
  if (s.length > PROMPT_MAX_CHARS) {
    throw new OpenCodeBridgeError('opencode prompt too large', 'bad-prompt');
  }
  return s;
}

/** Strip an optional `opencode/` prefix and validate the model ID. */
export function normalizeOpenCodeModelId(model) {
  const raw = String(model || '').trim().replace(/^opencode\//i, '');
  if (!MODEL_RE.test(raw)) {
    throw new OpenCodeBridgeError('invalid opencode model id', 'bad-model');
  }
  return raw;
}

function _seatChain(seat) {
  const key = `AI_TRIO_${String(seat || '').toUpperCase()}_CHAIN`;
  return String(process.env[key] || DEFAULT_SEAT_CHAINS[seat] || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
}

/**
 * Resolve the first `opencode:` link in a seat chain. Returns a bare
 * model ID (no `opencode/` prefix) or null when the chain has no
 * usable OpenCode link. Never accepts a model from the browser.
 */
export function resolveSeatModel(seat) {
  const s = String(seat || '').toLowerCase();
  if (!OPENCODE_SEATS.includes(s)) return null;
  for (const link of _seatChain(s)) {
    const m = /^opencode:(.+)$/i.exec(link);
    if (!m) continue;
    try { return normalizeOpenCodeModelId(m[1]); } catch { /* skip malformed link */ }
  }
  return null;
}

// ---------------- child environment ----------------

// No full process.env inheritance. Exchange keys, Telegram tokens and
// AI provider keys must never reach the OpenCode child process.
const SAFE_ENV_KEYS = [
  'PATH', 'Path', 'PATHEXT',
  'HOME', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH',
  'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP', 'TMPDIR',
  'SystemRoot', 'windir', 'ComSpec',
  'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME',
  'LANG', 'LC_ALL', 'USERNAME', 'USER',
];
const SAFE_OPENCODE_ENV = new Set([
  'OPENCODE_BIN', 'OPENCODE_SANDBOX_DIR',
  'OPENCODE_TIMEOUT_MS', 'OPENCODE_DEEP_TIMEOUT_MS',
  'OPENCODE_MAX_CONCURRENCY', 'OPENCODE_MAX_CALLS_PER_MIN',
  'OPENCODE_MAX_CALLS_PER_DAY', 'OPENCODE_MAX_BUFFER_MB',
  'OPENCODE_PROBE_TTL_MS', 'OPENCODE_STANDALONE',
]);

function _childEnv() {
  const env = { NO_COLOR: '1', TERM: 'dumb' };
  for (const key of SAFE_ENV_KEYS) {
    if (process.env[key] != null) env[key] = process.env[key];
  }
  for (const key of SAFE_OPENCODE_ENV) {
    if (process.env[key] != null) env[key] = process.env[key];
  }
  return env;
}

// ---------------- Windows command construction ----------------

function _winQuote(value) {
  const s = String(value ?? '');
  if (/^[A-Za-z0-9_./:@#=+-]+$/.test(s)) return s;
  return `"${s.replace(/"/g, '""')}"`;
}

function _winCommand(argv) {
  // The executable is always quoted; every arg is allowlisted/static or
  // a validated model ID. The prompt is NOT part of this string.
  return [_winQuote(_opencodeBin()), ...argv.map(_winQuote)].join(' ');
}

// ---------------- process spawn / timeout / kill tree ----------------

function _defaultKillTree(child) {
  try {
    if (IS_WIN) {
      if (!child?.pid) { try { child?.kill?.('SIGKILL'); } catch { /* best effort */ } return; }
      const killer = spawn(process.env.ComSpec || 'cmd.exe', [
        '/d', '/s', '/c',
        `taskkill /pid ${Number(child.pid)} /T /F`,
      ], { windowsHide: true, stdio: 'ignore' });
      killer.on('error', () => { /* taskkill unavailable — the direct kill below is best effort */ });
      return;
    }
    if (child?.pid) process.kill(-child.pid, 'SIGKILL');
    else child?.kill?.('SIGKILL');
  } catch {
    try { child?.kill?.('SIGKILL'); } catch { /* process already gone */ }
  }
}

function _normalizeSpawnError(err) {
  const code = String(err?.code || '');
  if (code === 'ENOENT') return new OpenCodeBridgeError('opencode missing', 'missing');
  if (code === 'EACCES') return new OpenCodeBridgeError('opencode not executable', 'missing');
  return new OpenCodeBridgeError(`opencode spawn failed: ${_sanitizeError(err?.message || err)}`, 'spawn');
}

function _spawnCli(argv, { stdinText = null, timeoutMs, maxBufferBytes = _maxBufferBytes() } = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      if (IS_WIN) {
        child = _spawnImpl(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', _winCommand(argv)], {
          cwd: _sandboxDir(),
          windowsHide: true,
          env: _childEnv(),
          stdio: ['pipe', 'pipe', 'pipe'],
        });
      } else {
        child = _spawnImpl(_opencodeBin(), argv, {
          cwd: _sandboxDir(),
          windowsHide: true,
          env: _childEnv(),
          stdio: ['pipe', 'pipe', 'pipe'],
          detached: true,
        });
      }
    } catch (e) {
      reject(_normalizeSpawnError(e));
      return;
    }

    let stdout = '';
    let stderr = '';
    let bytes = 0;
    let settled = false;
    let timer = null;

    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      try { child?.stdin?.destroy?.(); } catch { /* pipe already closed */ }
      fn(value);
    };

    const killTree = () => {
      if (_killTreeImpl) _killTreeImpl(child);
      else _defaultKillTree(child);
    };

    const budget = Math.max(1, Number(timeoutMs) || 25_000);
    timer = setTimeout(() => {
      finish(reject, new OpenCodeBridgeError('opencode timeout', 'timeout'));
      killTree();
    }, budget);

    child.stdout?.on('data', (chunk) => {
      if (settled) return;
      bytes += chunk?.length || 0;
      if (bytes > maxBufferBytes) {
        finish(reject, new OpenCodeBridgeError('opencode output too large', 'output-too-large'));
        killTree();
        return;
      }
      stdout += chunk.toString('utf8');
    });
    child.stderr?.on('data', (chunk) => {
      if (stderr.length < STDERR_KEEP_CHARS) stderr += chunk.toString('utf8').slice(0, STDERR_KEEP_CHARS - stderr.length);
    });
    child.on('error', (err) => finish(reject, _normalizeSpawnError(err)));
    child.on('close', (code) => {
      if (settled) return;
      if (code === 0) {
        finish(resolve, { stdout, stderr, code });
        return;
      }
      const tail = _sanitizeError(stderr);
      if (/\b(401|403)\b|unauthor|forbidden|not logged|login required/i.test(tail)) {
        finish(reject, new OpenCodeBridgeError(`opencode auth failed${tail ? `: ${tail}` : ''}`, 'auth'));
      } else if (/\b429\b|rate limit|too many/i.test(tail)) {
        finish(reject, new OpenCodeBridgeError(`opencode rate-limited${tail ? `: ${tail}` : ''}`, 'rate-limited'));
      } else {
        finish(reject, new OpenCodeBridgeError(`opencode exit ${code}${tail ? `: ${tail}` : ''}`, 'exit'));
      }
    });

    try {
      child.stdin?.on?.('error', () => { /* EPIPE when the CLI exits before stdin is consumed */ });
      child.stdin?.end?.(stdinText == null ? '' : String(stdinText));
    } catch (e) {
      finish(reject, new OpenCodeBridgeError(`opencode stdin failed: ${_sanitizeError(e?.message || e)}`, 'spawn'));
      killTree();
    }
  });
}

// ---------------- concurrency + rate limits ----------------

async function _acquireSlot(timeoutMs) {
  const max = Math.floor(_num('OPENCODE_MAX_CONCURRENCY', 2));
  if (_state.active < max) {
    _state.active++;
    return;
  }
  if (_state.queue.length >= max * 2) {
    throw new OpenCodeBridgeError('opencode busy', 'busy');
  }
  await new Promise((resolve, reject) => {
    const item = { resolve, reject, timer: null };
    item.timer = setTimeout(() => {
      const i = _state.queue.indexOf(item);
      if (i >= 0) _state.queue.splice(i, 1);
      reject(new OpenCodeBridgeError('opencode busy', 'busy'));
    }, Math.min(10_000, Math.max(1, timeoutMs)));
    _state.queue.push(item);
  });
}

function _releaseSlot() {
  const next = _state.queue.shift();
  if (next) {
    clearTimeout(next.timer);
    next.resolve();
  } else {
    _state.active = Math.max(0, _state.active - 1);
  }
}

function _consumeRate(now) {
  const cfg = _rateConfig();
  const dayKey = _localDayKey(now);
  if (_state.rate.dayKey !== dayKey) {
    _state.rate.dayKey = dayKey;
    _state.rate.dayCount = 0;
  }
  if (!_state.rate.minuteStart || now - _state.rate.minuteStart >= 60_000) {
    _state.rate.minuteStart = now;
    _state.rate.minuteCount = 0;
  }
  if (_state.rate.minuteCount >= cfg.maxPerMin) {
    const waitMs = Math.max(0, 60_000 - (now - _state.rate.minuteStart));
    throw new OpenCodeBridgeError(
      `opencode rate-limited (${Math.ceil(waitMs / 1000)}s)`,
      'rate-limited',
      { retryAfterMs: waitMs },
    );
  }
  if (_state.rate.dayCount >= cfg.maxPerDay) {
    throw new OpenCodeBridgeError('opencode daily call limit reached', 'rate-limited');
  }
  _state.rate.minuteCount++;
  _state.rate.dayCount++;
}

// ---------------- per-model breaker ----------------

function _breakerRecord(model) {
  if (!_state.breaker.has(model)) {
    _state.breaker.set(model, {
      consecFails: 0,
      cooldownUntil: 0,
      lastErr: null,
      lastErrAt: 0,
      lastOkAt: 0,
      calls: 0,
    });
  }
  return _state.breaker.get(model);
}

function _cooldownRemain(model, now) {
  const rec = _state.breaker.get(model);
  return rec ? Math.max(0, rec.cooldownUntil - now) : 0;
}

function _recordSuccess(model, now) {
  const rec = _breakerRecord(model);
  rec.consecFails = 0;
  rec.cooldownUntil = 0;
  rec.lastOkAt = now;
  rec.calls++;
}

function _recordFailure(model, err, now) {
  const rec = _breakerRecord(model);
  rec.calls++;
  rec.consecFails++;
  rec.lastErrAt = now;
  rec.lastErr = _sanitizeError(err?.message || err);
  const code = String(err?.code || '');
  const msg = String(err?.message || '');
  let cooldownMs = 0;
  if (code === 'auth' || /\b(401|403)\b|unauthor|forbidden|not logged/i.test(msg)) {
    cooldownMs = 900_000;
  } else if (code === 'rate-limited' || /\b429\b|rate limit|too many/i.test(msg)) {
    cooldownMs = 90_000;
  } else if (code === 'missing') {
    cooldownMs = 300_000;
  } else if (code === 'bad-json' || code === 'no-text' || code === 'bad-shape') {
    cooldownMs = 60_000;
  } else if (code === 'timeout') {
    // A single timeout is not an outage; the second consecutive one
    // starts the 30s → 60s → 120s → 300s ladder.
    if (rec.consecFails >= 2) cooldownMs = [30_000, 60_000, 120_000, 300_000][Math.min(rec.consecFails - 2, 3)];
  } else if (rec.consecFails >= 2) {
    cooldownMs = [30_000, 60_000, 120_000, 300_000][Math.min(rec.consecFails - 2, 3)];
  }
  if (cooldownMs > 0) rec.cooldownUntil = now + cooldownMs;
}

function _breakerView(now) {
  const out = {};
  for (const [model, rec] of _state.breaker.entries()) {
    out[model] = {
      cooldownRemainSec: Math.max(0, Math.ceil((rec.cooldownUntil - now) / 1000)),
      lastError: rec.lastErr || null,
      consecFails: rec.consecFails,
      calls: rec.calls,
      lastOkAgeSec: rec.lastOkAt ? Math.max(0, Math.round((now - rec.lastOkAt) / 1000)) : null,
    };
  }
  return out;
}

// ---------------- JSONL parser ----------------

function _extractEventError(ev) {
  return ev?.error?.message
    || ev?.error?.data?.message
    || ev?.error?.data
    || ev?.message
    || ev?.part?.text
    || ev?.part?.error
    || 'unknown error';
}

/**
 * Parse `opencode run --format json` output.
 *
 * Rules (locked by test/opencodeBridge.test.ts):
 *   • ignore blank/non-JSON lines
 *   • join every `type:"text"` part in order
 *   • a `type:"error"` event is fatal (sanitized message)
 *   • parse the last balanced JSON object with the shared tryParseJson
 *   • no text → `no-text`; invalid JSON → `bad-json`
 */
export function parseOpenCodeJsonl(stdout) {
  const lines = String(stdout || '').split(/\r?\n/);
  const texts = [];
  let eventError = null;
  for (const line of lines) {
    const raw = line.trim();
    if (!raw) continue;
    let ev;
    try { ev = JSON.parse(raw); } catch { continue; }
    if (!ev || typeof ev !== 'object') continue;
    if (ev.type === 'error') {
      eventError = _extractEventError(ev);
      continue;
    }
    if (ev.type !== 'text') continue;
    const text = typeof ev.text === 'string'
      ? ev.text
      : (typeof ev.part?.text === 'string' ? ev.part.text : '');
    if (text) texts.push(text);
  }
  if (eventError) {
    throw new OpenCodeBridgeError(`opencode error: ${_sanitizeError(eventError)}`, 'opencode-error');
  }
  if (!texts.length) throw new OpenCodeBridgeError('opencode no-text', 'no-text');
  const text = texts.join('\n');
  const json = tryParseJson(text);
  if (!json || typeof json !== 'object' || Array.isArray(json)) {
    throw new OpenCodeBridgeError('opencode bad-json', 'bad-json');
  }
  return { json, text };
}

// ---------------- model call ----------------

function _retryable(err) {
  return ['bad-json', 'no-text'].includes(String(err?.code || ''));
}

function _runArgs(model) {
  const standalone = String(process.env.OPENCODE_STANDALONE || '').toLowerCase() === '1'
    || String(process.env.OPENCODE_STANDALONE || '').toLowerCase() === 'true';
  return [
    'run',
    ...(standalone ? ['--standalone'] : []),
    '--format', 'json',
    '--model', `opencode/${model}`,
    '--agent', AGENT_NAME,
  ];
}

/**
 * One bounded model call. The prompt is sent through stdin, never as a
 * shell argument. Returns `{ json, text, model, latencyMs, attempts }`.
 * Rejects with OpenCodeBridgeError on any failure. Never logs the prompt.
 */
export async function askOpenCode(prompt, opts = {}) {
  const model = normalizeOpenCodeModelId(opts.model);
  const deep = !!opts.deep;
  const cleanPrompt = _sanitizePrompt(prompt);
  const timeoutMs = Math.max(1, Number(opts.timeoutMs)
    || _num(deep ? 'OPENCODE_DEEP_TIMEOUT_MS' : 'OPENCODE_TIMEOUT_MS', deep ? 45_000 : 25_000));
  const started = Date.now();
  const remain = _cooldownRemain(model, started);
  if (remain > 0) {
    throw new OpenCodeBridgeError(`opencode cooldown ${Math.ceil(remain / 1000)}s`, 'cooldown', { retryAfterMs: remain });
  }

  await _acquireSlot(timeoutMs);
  let lastErr = null;
  try {
    const argv = _runArgs(model);
    for (let attempt = 0; attempt < 2; attempt++) {
      _consumeRate(Date.now());
      try {
        const out = await _spawnCli(argv, { stdinText: cleanPrompt, timeoutMs });
        const parsed = parseOpenCodeJsonl(out.stdout);
        _recordSuccess(model, Date.now());
        return {
          json: parsed.json,
          text: parsed.text,
          model: `opencode/${model}`,
          latencyMs: Date.now() - started,
          attempts: attempt + 1,
        };
      } catch (e) {
        lastErr = e;
        if (!_retryable(e) || attempt === 1) break;
      }
    }
    _recordFailure(model, lastErr, Date.now());
    throw lastErr;
  } finally {
    _releaseSlot();
  }
}

// ---------------- health probe ----------------

function _parseVersion(text) {
  const m = /v?(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)/.exec(String(text || ''));
  return m ? m[1] : null;
}

function _parseModels(text) {
  const seen = new Set();
  const ansiSgr = new RegExp(String.fromCharCode(27) + '\\[[0-9;]*m', 'g');
  for (const line of String(text || '').split(/\r?\n/)) {
    const clean = line.replace(ansiSgr, '').trim();
    const m = /^(opencode\/[a-z0-9][a-z0-9.-]{1,64})\b/i.exec(clean);
    if (m) seen.add(m[1]);
  }
  return [...seen];
}

function _parseAuth(text) {
  const s = String(text || '').toLowerCase().trim();
  if (!s) return false;
  if (/\b(no credentials|not logged in|no auth|0 credentials|no api key)\b/.test(s)) return false;
  if (/\b(stored|logged in|api key|oauth|credential)\b/.test(s)) return true;
  return null;
}

async function _probeCommand(argv, timeoutMs) {
  const out = await _spawnCli(argv, { timeoutMs });
  return out.stdout;
}

function _probeView(now) {
  const cfg = _rateConfig();
  const dayKey = _localDayKey(now);
  const callsToday = _state.rate.dayKey === dayKey ? _state.rate.dayCount : 0;
  const callsPerMin = now - _state.rate.minuteStart < 60_000 ? _state.rate.minuteCount : 0;
  return {
    phase: 1,
    available: !!_state.probe.available,
    probed: _state.probe.checkedAt > 0,
    bin: _opencodeBin(),
    version: _state.probe.version,
    loggedIn: _state.probe.loggedIn,
    models: [..._state.probe.models],
    agent: AGENT_NAME,
    callsToday,
    callsPerMin,
    maxCallsPerMin: cfg.maxPerMin,
    maxCallsPerDay: cfg.maxPerDay,
    breaker: _breakerView(now),
    lastProbeAgeSec: _state.probe.checkedAt ? Math.max(0, Math.round((now - _state.probe.checkedAt) / 1000)) : null,
    lastError: _state.probe.lastError,
  };
}

/**
 * Cached health probe. Never calls a model. `opencode --version` (2.5s),
 * `opencode models` (5s), `opencode auth list` (5s). Cache TTL is
 * OPENCODE_PROBE_TTL_MS (default 5 min). Never throws.
 */
export async function opencodeProbe(force = false, now = Date.now()) {
  if (!force && _state.probe.checkedAt && now - _state.probe.checkedAt < _probeTtlMs()) {
    return _probeView(now);
  }
  if (_state.probe.checking) return _state.probe.checking;

  const run = (async () => {
    const next = {
      checkedAt: now,
      available: false,
      version: null,
      loggedIn: null,
      models: [],
      lastError: null,
    };
    try {
      const versionOut = await _probeCommand(['--version'], 2_500);
      next.version = _parseVersion(versionOut) || _sanitizeError(versionOut).slice(0, 40) || null;
      next.available = true;
    } catch (e) {
      next.lastError = _sanitizeError(e?.message || e);
    }
    if (next.available) {
      try {
        next.models = _parseModels(await _probeCommand(['models'], 5_000));
      } catch (e) {
        next.lastError = _sanitizeError(e?.message || e);
      }
      try {
        next.loggedIn = _parseAuth(await _probeCommand(['auth', 'list'], 5_000));
      } catch {
        next.loggedIn = null; // auth command shape varies by version — not fatal
      }
    }
    _state.probe.checkedAt = next.checkedAt;
    _state.probe.available = next.available;
    _state.probe.version = next.version;
    _state.probe.loggedIn = next.loggedIn;
    _state.probe.models = next.models;
    _state.probe.lastError = next.lastError;
    return _probeView(now);
  })();

  _state.probe.checking = run;
  try {
    return await run;
  } finally {
    _state.probe.checking = null;
  }
}

/** Synchronous cached view for /api/ai/engines. Never probes. */
export function opencodeStatus(now = Date.now()) {
  return _probeView(now);
}

/** Clear all per-model cooldowns (the RECHECK button). */
export function opencodeClearCooldowns() {
  for (const rec of _state.breaker.values()) {
    rec.cooldownUntil = 0;
    rec.consecFails = 0;
  }
}

// ---------------- per-seat probe ----------------

function _probeShape(seat, json) {
  if (!json || typeof json !== 'object' || Array.isArray(json)) return null;
  const confidence = Number(json.confidence);
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 100) return null;
  if (seat === 'fast') {
    const action = String(json.action || '').toUpperCase();
    if (!['CONFIRM', 'WAIT', 'REJECT'].includes(action)) return null;
    return { action, confidence: Math.round(confidence) };
  }
  if (seat === 'deep') {
    const verdict = String(json.verdict || '').toUpperCase();
    if (!['LONG', 'SHORT', 'AVOID'].includes(verdict)) return null;
    return { verdict, confidence: Math.round(confidence) };
  }
  const risk = String(json.risk || '').toUpperCase();
  if (!['CLEAR', 'CAUTION', 'VETO'].includes(risk)) return null;
  return { risk, confidence: Math.round(confidence) };
}

/**
 * Run a tiny strict-JSON prompt through one configured seat. Used only
 * by the manual setup endpoint. Returns an honest result object; never
 * throws. `knownModels` (from opencodeProbe) is an optional allowlist.
 */
export async function probeOpenCodeSeat(seat, opts = {}) {
  const s = String(seat || '').toLowerCase();
  if (!OPENCODE_SEATS.includes(s)) {
    return { ok: false, seat: s, code: 'bad-seat', error: 'unknown seat' };
  }
  const model = resolveSeatModel(s);
  if (!model) {
    return { ok: false, seat: s, code: 'no-model', error: 'no opencode link in seat chain' };
  }
  const full = `opencode/${model}`;
  if (Array.isArray(opts.knownModels) && opts.knownModels.length && !opts.knownModels.includes(full)) {
    return { ok: false, seat: s, model: full, code: 'model-unavailable', error: `${full} not listed by opencode models` };
  }
  try {
    const out = await askOpenCode(PROBE_PROMPTS[s], {
      model,
      deep: s === 'deep',
      timeoutMs: opts.timeoutMs,
    });
    const verdict = _probeShape(s, out.json);
    if (!verdict) {
      const err = new OpenCodeBridgeError('opencode bad-shape', 'bad-shape');
      _recordFailure(model, err, Date.now());
      throw err;
    }
    return {
      ok: true,
      seat: s,
      model: full,
      latencyMs: out.latencyMs,
      verdict,
      at: Date.now(),
    };
  } catch (e) {
    return {
      ok: false,
      seat: s,
      model: full,
      code: e?.code || 'error',
      error: _sanitizeError(e?.message || e),
    };
  }
}

/** Probe one or more seats in parallel (bridge semaphore still applies). */
export async function probeOpenCodeSeats(seats = OPENCODE_SEATS, opts = {}) {
  const list = (Array.isArray(seats) ? seats : [seats]).map(s => String(s || '').toLowerCase());
  const results = await Promise.all(list.map(s => probeOpenCodeSeat(s, opts)));
  return Object.fromEntries(results.map((r, i) => [list[i], r]));
}

// ---------------- test hooks ----------------

export function __setSpawnForTests(fn) {
  _spawnImpl = typeof fn === 'function' ? fn : spawn;
}

export function __setKillTreeForTests(fn) {
  _killTreeImpl = typeof fn === 'function' ? fn : null;
}

export function __resetOpenCodeForTests() {
  _state.probe.checkedAt = 0;
  _state.probe.checking = null;
  _state.probe.available = false;
  _state.probe.version = null;
  _state.probe.loggedIn = null;
  _state.probe.models = [];
  _state.probe.lastError = null;
  _state.breaker.clear();
  _state.rate.minuteStart = 0;
  _state.rate.minuteCount = 0;
  _state.rate.dayKey = '';
  _state.rate.dayCount = 0;
  _state.active = 0;
  _state.queue.length = 0;
}

export const __testables = {
  _childEnv,
  _winCommand,
  _probeView,
  _state,
  _parseVersion,
  _parseModels,
  _parseAuth,
  _sanitizeError,
};
