// ============================================================
// server/ai/aiMode.js — site-wide LOCAL / CLOUD engine mode
// ------------------------------------------------------------
// LOCAL  = local Ollama only.
// CLOUD  = OpenCode free models first (GLM scan / DeepSeek deep),
//          then Ollama fallback. Paid cloud keys are NOT used by
//          the v1 Council / deep / validator lanes.
//
// The mode is server-wide, persisted atomically at
// server/data/ai-mode.json, and read fresh on every AI call — the
// header switch therefore applies without a server restart and
// survives restarts.
//
// Precedence: an explicit runtime switch wins; otherwise the
// persisted file; otherwise AI_MODE; otherwise LLM_LOCAL_ONLY seeds
// LOCAL; otherwise the safe default LOCAL. LLM_LOCAL_ONLY is only
// a first-boot seed — it never overrides a saved/runtime mode.
// ============================================================
import { loadJSON, saveJSON } from '../lib/store.js';

export const AI_MODES = ['local', 'cloud'];
export const AI_MODE_FILE = 'ai-mode.json';
const DEFAULT_MODE = 'local';

let _runtimeMode = null;

/** Normalize a user/env value. Returns 'local' | 'cloud' | null. */
export function normalizeAiMode(value) {
  const mode = String(value ?? '').trim().toLowerCase();
  return AI_MODES.includes(mode) ? mode : null;
}

function _truthy(value) {
  return ['1', 'true', 'on', 'yes', 'enable', 'enabled'].includes(String(value ?? '').trim().toLowerCase());
}

/** First-boot default from env. Never overrides a persisted mode. */
function _envMode() {
  const explicit = normalizeAiMode(process.env.AI_MODE);
  if (explicit) return { mode: explicit, source: 'env' };
  if (_truthy(process.env.LLM_LOCAL_ONLY)) return { mode: 'local', source: 'env-local-only' };
  return { mode: DEFAULT_MODE, source: 'default' };
}

function _persisted() {
  const data = loadJSON(AI_MODE_FILE, {});
  const mode = normalizeAiMode(data?.mode);
  if (!mode) return null;
  return {
    mode,
    updatedAt: Number.isFinite(Number(data?.updatedAt)) ? Number(data.updatedAt) : null,
  };
}

/** The effective mode. Runtime switch > persisted file > env > default. */
export function getAiMode() {
  return getAiModeStatus().mode;
}

/** Full status view for the API/UI (never contains secrets). */
export function getAiModeStatus() {
  if (_runtimeMode) {
    const saved = _persisted();
    return {
      mode: _runtimeMode,
      source: 'runtime',
      persisted: !!saved && saved.mode === _runtimeMode,
      updatedAt: saved?.mode === _runtimeMode ? saved.updatedAt : null,
      modes: [...AI_MODES],
    };
  }
  const saved = _persisted();
  if (saved) {
    return {
      mode: saved.mode,
      source: 'file',
      persisted: true,
      updatedAt: saved.updatedAt,
      modes: [...AI_MODES],
    };
  }
  const env = _envMode();
  return {
    mode: env.mode,
    source: env.source,
    persisted: false,
    updatedAt: null,
    modes: [...AI_MODES],
  };
}

export function isLocalMode() {
  return getAiMode() === 'local';
}

export function isCloudMode() {
  return getAiMode() === 'cloud';
}

/**
 * Switch the site mode now. Applies to this process immediately even
 * when the filesystem is read-only (`persisted:false` reports that
 * honestly); a writable server/data/ai-mode.json makes it restart-safe.
 */
export function setAiMode(value) {
  const mode = normalizeAiMode(value);
  if (!mode) {
    return { ok: false, mode: null, persisted: false, error: 'mode must be "local" or "cloud"' };
  }
  _runtimeMode = mode;
  const persisted = saveJSON(AI_MODE_FILE, { mode, updatedAt: Date.now() });
  return { ok: true, mode, persisted };
}

/** Test hook — drop the in-process override (file/env are re-read). */
export function __resetAiModeForTests() {
  _runtimeMode = null;
}
