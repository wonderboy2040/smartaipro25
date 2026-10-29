// ============================================================
// src/components/AiModeSwitch.tsx — v21.27 LOCAL / CLOUD switch
// ------------------------------------------------------------
// One site-wide engine mode, controlled from the header:
//   LOCAL → local Ollama only (no cloud calls at all)
//   CLOUD → OpenCode free models first (GLM scan / DeepSeek deep),
//           then the local Ollama fallback. No paid APIs.
// The server persists the choice (server/data/ai-mode.json) and
// re-reads it on every AI call, so switching needs NO restart and
// survives one. Scope: AI Council, deep analysis, global council,
// borderline LLM validator (v1).
// ============================================================
import { memo, useCallback, useEffect, useState } from 'react';
import { apiFetch } from '../utils/api';

type AiMode = 'local' | 'cloud';

interface AiModeStatus {
  mode: AiMode;
  source: string;
  persisted: boolean;
  updatedAt: number | null;
}

const SOURCE_LABEL: Record<string, string> = {
  runtime: 'runtime switch (applied now)',
  file: 'saved server/data/ai-mode.json',
  env: 'AI_MODE env seed',
  'env-local-only': 'LLM_LOCAL_ONLY env seed',
  default: 'safe default',
};

function modeTitle(mode: AiMode | null): string {
  if (mode === 'cloud') {
    return 'CLOUD — OpenCode free models first (GLM scan / DeepSeek deep), then local Ollama fallback. No paid APIs. Applies to AI Council, deep analysis, global council and the borderline validator.';
  }
  if (mode === 'local') {
    return 'LOCAL — local Ollama only. Zero cloud calls. Applies to AI Council, deep analysis, global council and the borderline validator.';
  }
  return 'AI engine mode — loading…';
}

export const AiModeSwitch = memo(function AiModeSwitch() {
  const [status, setStatus] = useState<AiModeStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const [tick, setTick] = useState(0);

  const load = useCallback(async () => {
    try {
      const res = await apiFetch('/api/ai/mode', { signal: AbortSignal.timeout(8000) });
      if (!res.ok) { setFailed(true); return; }
      const d = await res.json().catch(() => null);
      if (d?.mode === 'local' || d?.mode === 'cloud') {
        setStatus({
          mode: d.mode,
          source: String(d.source || ''),
          persisted: !!d.persisted,
          updatedAt: Number.isFinite(Number(d.updatedAt)) ? Number(d.updatedAt) : null,
        });
        setFailed(false);
      }
    } catch { setFailed(true); /* header control is auxiliary — never block the shell */ }
  }, []);

  useEffect(() => {
    load();
    // Slow poll keeps a second browser tab in sync; hidden tabs stay quiet.
    const t = setInterval(() => { if (!document.hidden) load(); }, 60_000);
    return () => clearInterval(t);
  }, [load, tick]);

  const setMode = useCallback(async (mode: AiMode) => {
    if (busy || status?.mode === mode) return;
    setBusy(true);
    try {
      const res = await apiFetch('/api/ai/mode', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode }),
        signal: AbortSignal.timeout(8000),
      });
      const d = await res.json().catch(() => null);
      if (res.ok && d?.ok && (d.mode === 'local' || d.mode === 'cloud')) {
        setStatus({
          mode: d.mode,
          source: String(d.source || 'runtime'),
          persisted: !!d.persisted,
          updatedAt: Number.isFinite(Number(d.updatedAt)) ? Number(d.updatedAt) : null,
        });
        setFailed(false);
        setTick(x => x + 1);
      } else {
        setFailed(true);
      }
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  }, [busy, status?.mode]);

  const mode = status?.mode ?? null;
  const source = status ? (SOURCE_LABEL[status.source] || status.source || 'unknown') : 'loading…';
  const persisted = status ? (status.persisted ? 'restart-safe (saved)' : 'NOT saved — read-only filesystem, runtime only') : '';
  const title = `${modeTitle(mode)}${status ? `\nSource: ${source} · ${persisted}` : ''}${failed ? '\nStatus endpoint unreachable — last known mode shown.' : ''}`;

  return (
    <div
      className="flex items-center gap-1 quantum-panel p-1 rounded-xl"
      role="group"
      aria-label="AI engine mode"
      title={title}
    >
      <span className={`px-1 text-[9px] font-black font-mono ${failed ? 'text-red-400' : 'text-slate-500'}`}>AI</span>
      {(['local', 'cloud'] as const).map(m => {
        const active = mode === m;
        return (
          <button
            key={m}
            type="button"
            onClick={() => void setMode(m)}
            disabled={busy || !status}
            aria-pressed={active}
            title={modeTitle(m)}
            className={`px-2 py-1 rounded-lg text-[9px] font-black font-mono tracking-wider transition-all disabled:opacity-40 ${
              active
                ? m === 'cloud'
                  ? 'bg-cyan-500/20 text-cyan-200 border border-cyan-400/40'
                  : 'bg-violet-500/20 text-violet-200 border border-violet-400/40'
                : 'text-slate-500 hover:text-slate-300 hover:bg-white/[0.04] border border-transparent'
            }`}
          >
            {m.toUpperCase()}
          </button>
        );
      })}
      {busy && <span className="px-1 text-[9px] font-mono text-cyan-300 animate-pulse">…</span>}
    </div>
  );
});
