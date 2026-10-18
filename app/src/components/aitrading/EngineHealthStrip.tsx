// ============================================================
// aitrading/EngineHealthStrip — v18.7 AI ENGINE SENTINEL (UI)
// ------------------------------------------------------------
// Live health chips for every language engine + a RECHECK button.
// The "AI language engines offline" report becomes actionable:
//   • READY (green)      — engine answered recently
//   • COOLDOWN (amber)   — engine down, AUTO-RETRY in Ns (sentinel
//                          half-open; no restart needed)
//   • ERROR (red)        — last error shown on hover (e.g. 429 /
//                          invalid key)
//   • NO KEY (slate)     — engine not configured → Settings > AI Keys
//   • OLLAMA (violet)    — keyless local engine detected
// Data: GET /api/ai/engines (30s auto-refresh + refreshKey bump on
// every agent answer), POST /api/ai/engines/recheck (clears cooldowns
// NOW + re-probes ollama). Key values never reach the browser.
// ============================================================
import { memo, useCallback, useEffect, useState } from 'react';
import { apiFetch } from '../../utils/api';
import { RefreshCw, Zap } from 'lucide-react';

type EngineState = 'no-key' | 'idle' | 'cooldown' | 'ready' | 'tried';

interface EngineRow {
  provider: string;
  configured: boolean;
  state: EngineState;
  lastError?: string | null;
  cooldownRemainSec?: number;
  lastOkAgeSec?: number | null;
}

// v21.0: extended ollama status — GET /api/ai/engines ke { ollama } block
// me ab model/deepModel/visionModel/numCtx/keepAlive/ramGuard aate hain.
interface OllamaInfo {
  reachable?: boolean;
  model?: string;
  deepModel?: string | null;
  visionModel?: string | null;
  models?: string[];
  numCtx?: number;
  numCtxDeep?: number;
  keepAlive?: string;
  ramGuard?: { sysTotalGb?: number; ctxClamped?: boolean };
  checkedAgeSec?: number;
}

const LABEL: Record<string, string> = {
  gemini: 'GEMINI', groq: 'GROQ', cerebras: 'CEREBRAS',
  openrouter: 'OPENROUTER', huggingface: 'HUGGINGFACE', nvidia: 'NVIDIA',
  ollama: 'OLLAMA·LOCAL',
};

function chipClass(e: EngineRow): string {
  if (e.provider === 'ollama') {
    return e.configured
      ? 'bg-violet-500/15 border-violet-500/30 text-violet-300'
      : 'bg-white/[0.02] border-white/10 text-slate-600';
  }
  if (!e.configured) return 'bg-white/[0.02] border-white/10 text-slate-600';
  switch (e.state) {
    case 'ready': return 'bg-emerald-500/15 border-emerald-500/30 text-emerald-300';
    case 'cooldown': return 'bg-amber-500/15 border-amber-500/30 text-amber-300';
    case 'tried': return 'bg-red-500/10 border-red-500/25 text-red-300';
    default: return 'bg-white/[0.03] border-white/10 text-slate-400';
  }
}

// v21.0.3: model short-name — 'qwen3:8b' → 'QWEN3·8B', 'deepseek-r1:14b'
// → 'R1·14B', 'qwen2.5vl:7b' → 'Q2.5VL·7B' style compact chip text.
function modelShort(m?: string | null): string {
  if (!m) return '';
  const raw = String(m);
  const [f, v] = raw.split(':');
  if (!v) return raw.slice(0, 12).toUpperCase();
  let fam = f.replace(/[^a-zA-Z0-9.]/g, '').toUpperCase();
  if (fam.startsWith('DEEPSEEK')) fam = fam.includes('R1') ? 'R1' : 'DSEEK';
  else if (/^QWEN2\.?5?VL/.test(fam)) fam = 'Q2.5VL';
  else if (/^QWEN3.?VL/.test(fam)) fam = 'QWEN3VL'; // v21.0.6 [audit]: qwen3-vl:8b → QWEN3VL·8B (slice(6) se 'QWEN3V' ho raha tha)
  else if (fam.length > 6) fam = fam.slice(0, 6);
  return `${fam}·${v.toUpperCase()}`;
}

function chipText(e: EngineRow, ol?: OllamaInfo | null): string {
  if (e.provider === 'ollama') {
    if (!e.configured) return 'OLLAMA —';
    // v21.0.3: chip par SCAN + DEEP dono models (accurate attribution):
    // 'QWEN3·8B ↗R1·14B' — scan boards/chat ke liye, ↗ deep (🔬 deep
    // ensemble) ke liye. Vision tooltip me (chart 👁 button pe model
    // verdict ke saath khud aata hai).
    const scan = modelShort(ol?.model);
    const deep = modelShort(ol?.deepModel);
    const same = !deep || deep === scan;
    return scan ? (same ? scan : `${scan} ↗${deep}`) : 'OLLAMA LOCAL';
  }
  if (!e.configured) return `${LABEL[e.provider] || e.provider} NO-KEY`;
  switch (e.state) {
    case 'ready': return `${LABEL[e.provider] || e.provider} ✓`;
    case 'cooldown': return `${LABEL[e.provider] || e.provider} ↻${e.cooldownRemainSec ?? 0}s`;
    case 'tried': return `${LABEL[e.provider] || e.provider} ✗`;
    default: return `${LABEL[e.provider] || e.provider} ·`;
  }
}

function chipTitle(e: EngineRow, ol?: OllamaInfo | null): string {
  if (e.provider === 'ollama') {
    if (!e.configured) return 'Ollama install karo (localhost:11434) to get a keyless local language engine';
    const parts = [
      'keyless local engine (127.0.0.1:11434)',
      `scan (board/chat/council): ${ol?.model || '?'}`,
      `deep (🔬 deep ensemble): ${ol?.deepModel || 'same as scan'}`,
      ol?.visionModel ? `vision (👁 chart button): ${ol.visionModel}` : 'vision: NOT installed (ollama pull qwen2.5vl:7b)',
      // v21.0.6 [audit]: scan vs deep ctx alag-alag dikho jab env ne alag
      // set kiya ho (OLLAMA_NUM_CTX vs OLLAMA_NUM_CTX_DEEP) — pehle sirf
      // scan ctx dikhta tha.
      ol?.numCtxDeep && ol.numCtxDeep !== ol.numCtx
        ? `ctx ${ol.numCtx ?? '?'} (deep ${ol.numCtxDeep}) · keep_alive ${ol?.keepAlive || '5m'}`
        : `ctx ${ol?.numCtx ?? '?'} · keep_alive ${ol?.keepAlive || '5m'}`,
      ol?.ramGuard?.ctxClamped ? `RAM guard ON (${ol.ramGuard.sysTotalGb}GB system → ctx clamped)` : undefined,
      ol?.models?.length ? `installed: ${ol.models.slice(0, 6).join(', ')}` : undefined,
      ol?.checkedAgeSec != null ? `probed ${ol.checkedAgeSec.toFixed(0)}s pehle` : undefined,
    ].filter(Boolean);
    return parts.join(' · ');
  }
  if (!e.configured) return 'key configured nahi hai — Settings > AI Keys me free key daalo';
  switch (e.state) {
    case 'ready': return `engine ONLINE (last ok ${e.lastOkAgeSec ?? '?'}s pehle)`;
    case 'cooldown': return `down — AUTO-RETRY ${e.cooldownRemainSec ?? 0}s me (sentinel half-open) · last: ${e.lastError || '?'}`;
    case 'tried': return `last error: ${e.lastError || 'no response'}`;
    default: return 'armed — abhi koi attempt nahi hua';
  }
}

export const EngineHealthStrip = memo(function EngineHealthStrip({ refreshKey = 0 }: { refreshKey?: number }) {
  const [rows, setRows] = useState<EngineRow[]>([]);
  // v21.0: extended ollama info (scan/deep/vision models + ctx + ramGuard)
  const [ollama, setOllama] = useState<OllamaInfo | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await apiFetch('/api/ai/engines', { signal: AbortSignal.timeout(8000) });
      if (!res.ok) { setFailed(true); return; }
      const d = await res.json().catch(() => ({}));
      if (Array.isArray(d?.engines)) { setRows(d.engines); setFailed(false); }
      // v21.0: extended ollama block (model/deep/vision/ctx/ramGuard)
      setOllama(d?.ollama && typeof d.ollama === 'object' ? d.ollama : null);
    } catch { setFailed(true); /* silent — strip is auxiliary */ }
  }, []);

  const recheck = useCallback(async () => {
    setBusy(true);
    try {
      const res = await apiFetch('/api/ai/engines/recheck', { method: 'POST', signal: AbortSignal.timeout(12000) });
      if (res.ok) {
        const d = await res.json().catch(() => ({}));
        if (Array.isArray(d?.engines)) setRows(d.engines);
        if (d?.ollama && typeof d.ollama === 'object') setOllama(d.ollama);
      }
    } catch { /* silent */ } finally { setBusy(false); }
  }, []);

  useEffect(() => {
    load();
    // v20.2 D16: visibility-gated — hidden tab pe network poll band.
    const t = setInterval(() => { if (!document.hidden) load(); }, 30_000);
    return () => clearInterval(t);
  }, [load, refreshKey]);

  if (!rows.length) return null;

  const anyCloudKey = rows.some(e => e.provider !== 'ollama' && e.configured);
  const anyAlive = rows.some(e => e.configured && (e.state === 'ready' || e.state === 'idle'));
  const ol = rows.find(e => e.provider === 'ollama');
  const cloudRows = rows.filter(e => e.provider !== 'ollama');

  return (
    <div className="flex items-center gap-1.5 px-3 pb-2 flex-wrap">
      <span className="flex items-center gap-1 text-[9px] font-black font-mono text-slate-500" title="AI language engine health — v18.7 sentinel. Offline engine auto-retry karta hai; RECHECK abhi try karta hai.">
        <Zap size={10} /> AI ENGINES
      </span>
      {cloudRows.map(e => (
        <span
          key={e.provider}
          className={`px-1.5 py-0.5 rounded-md text-[9px] font-mono font-bold border ${chipClass(e)}`}
          title={chipTitle(e, ollama)}
        >
          {chipText(e, ollama)}
        </span>
      ))}
      {ol && (
        <span
          className={`px-1.5 py-0.5 rounded-md text-[9px] font-mono font-bold border ${chipClass(ol)}`}
          title={chipTitle(ol, ollama)}
        >
          {chipText(ol, ollama)}
        </span>
      )}
      <button
        onClick={recheck}
        disabled={busy}
        className="ml-auto flex items-center gap-1 px-1.5 py-0.5 rounded-md text-[9px] font-black font-mono border border-cyan-500/30 bg-cyan-500/10 text-cyan-300 hover:border-cyan-400/60 hover:text-cyan-200 transition-all disabled:opacity-40"
        title="cooldowns clear karo + har engine ko abhi dobara try karo (half-open)"
      >
        <RefreshCw size={9} className={busy ? 'animate-spin' : ''} /> {busy ? 'CHECKING…' : 'RECHECK'}
      </button>
      {!anyCloudKey && !ol?.configured && !failed && (
        <span className="w-full text-[9px] text-amber-400/80 font-mono leading-relaxed pt-0.5">
          koi language-engine key configured nahi — Settings &gt; AI Keys me free Gemini ya Groq key daalo (engine turant engage hoga), ya Ollama install karo (localhost:11434, keyless).
        </span>
      )}
      {anyCloudKey && !anyAlive && (
        <span className="w-full text-[9px] text-amber-400/80 font-mono leading-relaxed pt-0.5">
          sab cloud engines cooldown/down hain — auto-retry chalu hai (↻Ns), RECHECK dabao ya key check karo (red chip par hover = exact reason).
        </span>
      )}
    </div>
  );
});
