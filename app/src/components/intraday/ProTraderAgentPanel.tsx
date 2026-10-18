// ============================================================
// intraday/ProTraderAgentPanel — PRO TRADER MCP AGENT chat
// ------------------------------------------------------------
// Interactive agentic chat with 8 intraday-specialized MCP tools
// (live signals, deep setup scan, quotes, regime, track-record,
// paper positions, news, position sizing). Shows the tool-call
// trace so the user sees exactly which live data the agent used.
// ============================================================
import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { apiFetch } from '../../utils/api';
import { describeApiError } from '../../utils/apiError';
import { Send, Bot, User, Wrench, ChevronDown, Loader2, Trash2, Sparkles, Volume2, Square } from 'lucide-react';
// v18.7 ENGINE SENTINEL — live engine health chips + RECHECK.
import { EngineHealthStrip } from '../aitrading/EngineHealthStrip';

interface AgentMessage {
  role: 'user' | 'assistant';
  content: string;
  toolsUsed?: string[];
  toolCalls?: number;
  engine?: string;
  ts: number;
  error?: boolean;
  degraded?: boolean;
}

const QUICK_PROMPTS = [
  { icon: '📋', label: 'Desk Briefing', prompt: 'Aaj ka complete desk briefing do — market regime, top setups aur risk notes ke saath.' },
  { icon: '🎯', label: 'Top Setups', prompt: 'Top 3 high-conviction setups deep analysis ke saath — entry, SL, targets, qty aur reasons.' },
  { icon: '🛡️', label: 'Risk Check', prompt: 'Mere open paper positions ka risk review karo — kahan SL tighten karna chahiye?' },
  { icon: '📊', label: 'Performance', prompt: 'Signal track record review karo — win rate kaisa hai aur kaunse trades improve karne chahiye?' },
];

// Lightweight markdown-ish renderer: **bold**, bullets, numbered lines.
function renderRich(text: string) {
  return text.split('\n').map((line, i) => {
    const trimmed = line.trim();
    if (!trimmed) return <div key={i} className="h-2" />;
    const isBullet = /^[-•*]\s+/.test(trimmed) || /^\d+[.)]\s+/.test(trimmed);
    const content = trimmed.replace(/^[-•*]\s+/, '').replace(/^\d+[.)]\s+/, '');
    const parts = content.split(/(\*\*[^*]+\*\*)/g).map((p, j) =>
      p.startsWith('**') && p.endsWith('**')
        ? <b key={j} className="text-slate-100">{p.slice(2, -2)}</b>
        : <span key={j}>{p}</span>,
    );
    return isBullet ? (
      <div key={i} className="flex gap-1.5">
        <span className="text-cyan-400/70 shrink-0">▸</span>
        <div className="flex-1">{parts}</div>
      </div>
    ) : (
      <div key={i} className={/^#{1,3}\s/.test(trimmed) ? 'font-bold text-slate-100 pt-1' : ''}>
        {parts}
      </div>
    );
  });
}

const TOOL_LABEL: Record<string, string> = {
  get_live_intraday_signals: '📡 Live Signals',
  analyze_setup: '🔍 Deep Scan',
  get_intraday_quote: '💰 Quote',
  get_market_regime: '🌍 Regime',
  get_track_record: '📊 Track Record',
  get_paper_positions: '📝 Positions',
  search_market_news: '📰 News',
  calculate_position_size: '🧮 Sizing',
};

// 2026 perf audit (M4): memoized — IntradayTab re-renders on every SSE quote
// tick (~5s); this panel takes no changing props so memo short-circuits the
// full conversation re-render + markdown re-parse.
export const ProTraderAgentPanel = memo(function ProTraderAgentPanel({ onOpen }: { onOpen?: () => void }) {
  const [messages, setMessages] = useState<AgentMessage[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [greeted, setGreeted] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  // ---- VOICE BRIEFING (browser speechSynthesis — free, offline) ----
  const [voiceBusy, setVoiceBusy] = useState(false);
  const [voicePlaying, setVoicePlaying] = useState(false);
  const voiceTextRef = useRef<string>('');

  useEffect(() => () => {
    // Stop speech on unmount.
    try { window.speechSynthesis?.cancel(); } catch { /* noop */ }
  }, []);

  const playVoice = useCallback(async () => {
    const synth = window.speechSynthesis;
    if (!synth) return;
    // Toggle OFF if already playing.
    if (voicePlaying) {
      synth.cancel();
      setVoicePlaying(false);
      return;
    }
    setVoiceBusy(true);
    try {
      // Today's cached briefing first; regenerate only if missing.
      let text = voiceTextRef.current;
      if (!text) {
        const res = await apiFetch('/api/intraday-briefing', { signal: AbortSignal.timeout(90000) });
        const d = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(describeApiError(d, res.status, 'briefing unavailable'));
        text = d?.briefing?.voiceText || d?.briefing?.text || '';
        voiceTextRef.current = text as string;
      }
      if (!text) throw new Error('briefing empty');

      const u = new SpeechSynthesisUtterance(text.slice(0, 1200));
      // Prefer an Indian voice if available (hi-IN / en-IN).
      const voices = synth.getVoices();
      const indian = voices.find(v => /^hi-IN/i.test(v.lang)) || voices.find(v => /^en-IN/i.test(v.lang));
      if (indian) u.voice = indian;
      u.lang = indian?.lang || 'hi-IN';
      u.rate = 1.02;
      u.pitch = 1;
      u.onend = () => setVoicePlaying(false);
      u.onerror = () => setVoicePlaying(false);
      synth.cancel();
      synth.speak(u);
      setVoicePlaying(true);
    } catch (e) {
      const err = e as { message?: string };
      setMessages(prev => [...prev, {
        role: 'assistant', ts: Date.now(), error: true,
        content: `🎙️ Voice briefing start nahi ho payi: ${err?.message || 'error'}`,
      }]);
    } finally {
      setVoiceBusy(false);
    }
  }, [voicePlaying]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages, busy]);

  const send = useCallback(async (text: string) => {
    const q = text.trim();
    if (!q || busy) return;
    setInput('');
    setBusy(true);
    const userMsg: AgentMessage = { role: 'user', content: q, ts: Date.now() };
    setMessages(prev => [...prev, userMsg]);

    try {
      const convo = [...messages, userMsg].map(m => ({ role: m.role, content: m.content }));
      // v10.3.1: 150s (was 90s) — the agent's first question after a
      // cold boot walks the Gemini→Groq→Cerebras chain with live tool
      // calls; 90s cut off mid-chain and showed "Agent timeout" even
      // though an answer was one retry away. Tools themselves are now
      // 20s-bounded server-side, so 150s is the honest outer budget.
      const res = await apiFetch('/api/intraday-agent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: convo }),
        signal: AbortSignal.timeout(150000),
      });
      const data = await res.json().catch(() => ({}));
      // v10.10 [object Object] fix — the route's jsonError() nests the
      // message inside {error:{message}}; unwrap it properly.
      if (!res.ok) throw new Error(describeApiError(data, res.status, `agent error ${res.status}`));
      setMessages(prev => [...prev, {
        role: 'assistant',
        content: data.text || '(empty response)',
        toolsUsed: data.toolsUsed || [],
        toolCalls: data.toolCalls || 0,
        engine: data.engine || '',
        degraded: !!data.degraded,
        ts: Date.now(),
      }]);
    } catch (e) {
      const err = e as { name?: string; message?: string };
      const msg = err?.name === 'AbortError'
        ? 'Agent timeout — AI engine slow hai, dobara try karein.'
        : (err?.message || 'Agent unavailable');
      setMessages(prev => [...prev, { role: 'assistant', content: `⚠️ ${msg}`, ts: Date.now(), error: true }]);
    } finally {
      setBusy(false);
    }
  }, [messages, busy]);

  // Greeting hint on first expand.
  useEffect(() => {
    if (expanded && !greeted && messages.length === 0) {
      setGreeted(true);
      onOpen?.();
    }
  }, [expanded, greeted, messages.length, onOpen]);

  return (
    <div className="quantum-panel rounded-2xl border border-purple-500/20 overflow-hidden bg-black/40">
      {/* Header */}
      <button
        onClick={() => setExpanded(e => !e)}
        className="w-full flex items-center justify-between gap-2 px-4 py-3 hover:bg-white/[0.02]"
      >
        <div className="flex items-center gap-2 flex-wrap">
          <span className="flex items-center gap-1.5 text-xs font-black text-transparent bg-clip-text bg-gradient-to-r from-purple-300 to-cyan-300">
            <Bot size={14} className="text-purple-400" /> PRO TRADER MCP AGENT
          </span>
          <span className="px-2 py-0.5 rounded-md text-[9px] font-black font-mono border bg-purple-500/15 text-purple-300 border-purple-500/30">
            10 TOOLS • AGENTIC
          </span>
          {busy && (
            <span className="px-2 py-0.5 rounded-md text-[9px] font-black font-mono border bg-cyan-500/15 text-cyan-300 border-cyan-500/30 animate-pulse">
              THINKING…
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          {messages.length > 0 && (
            <span
              onClick={(e) => { e.stopPropagation(); setMessages([]); }}
              className="p-1.5 rounded-lg hover:bg-white/10 text-slate-500 hover:text-slate-300 transition-colors"
              title="Clear chat"
            >
              <Trash2 size={13} />
            </span>
          )}
          <ChevronDown size={15} className={`text-slate-500 transition-transform ${expanded ? 'rotate-180' : ''}`} />
        </div>
      </button>

      {expanded && (
        <>
          {/* Quick prompts + voice briefing */}
          <div className="flex gap-1.5 px-3 pb-2 flex-wrap">
            <button
              onClick={playVoice}
              disabled={voiceBusy}
              className={`px-2.5 py-1 rounded-xl text-[10px] font-bold font-mono border transition-all disabled:opacity-40 flex items-center gap-1 ${voicePlaying
                ? 'bg-orange-500/20 border-orange-500/40 text-orange-200 animate-pulse'
                : 'bg-orange-500/10 border-orange-500/30 text-orange-300 hover:bg-orange-500/20'}`}
              title={voicePlaying ? 'Stop voice briefing' : 'Morning desk briefing — suniye (AI voice)'}
            >
              {voiceBusy ? <Loader2 size={11} className="animate-spin" /> : voicePlaying ? <Square size={11} /> : <Volume2 size={11} />}
              {voiceBusy ? 'LOADING…' : voicePlaying ? 'STOP' : 'VOICE BRIEFING'}
            </button>
            {QUICK_PROMPTS.map(q => (
              <button
                key={q.label}
                onClick={() => send(q.prompt)}
                disabled={busy}
                className="px-2.5 py-1 rounded-xl text-[10px] font-bold font-mono border bg-white/[0.03] border-white/10 text-slate-300 hover:border-purple-500/40 hover:text-purple-200 transition-all disabled:opacity-40"
              >
                {q.icon} {q.label}
              </button>
            ))}
          </div>

          {/* v18.7: engine health chips + RECHECK — refreshed after every answer */}
          <EngineHealthStrip refreshKey={messages.filter(m => m.role === 'assistant').length} />

          {/* Messages */}
          <div ref={scrollRef} className="h-[320px] md:h-[380px] overflow-y-auto px-3 pb-2 space-y-3 scroll-thin">
            {messages.length === 0 && (
              <div className="h-full flex flex-col items-center justify-center text-center gap-2 py-8">
                <div className="w-12 h-12 rounded-2xl bg-purple-500/15 border border-purple-500/30 flex items-center justify-center">
                  <Sparkles size={20} className="text-purple-300" />
                </div>
                <div className="text-xs font-bold text-slate-300">Elite NSE Intraday Desk Trader</div>
                <div className="text-[11px] text-slate-500 max-w-xs leading-relaxed">
                  Live scanner, deep setup scan, regime, track-record aur news — sab tools ke saath.
                  Kuch bhi poochiye: <span className="text-slate-400">"RELIANCE me entry le sakta hu?"</span>
                </div>
              </div>
            )}

            {messages.map((m, i) => (
              <div key={i} className={`flex gap-2 ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                {m.role === 'assistant' && (
                  <div className="w-7 h-7 rounded-xl bg-purple-500/15 border border-purple-500/30 flex items-center justify-center shrink-0 mt-0.5">
                    <Bot size={14} className="text-purple-300" />
                  </div>
                )}
                <div className={`max-w-[85%] rounded-2xl px-3 py-2.5 text-[11.5px] leading-relaxed ${
                  m.role === 'user'
                    ? 'bg-cyan-500/15 border border-cyan-500/25 text-cyan-50'
                    : m.error
                      ? 'bg-red-500/10 border border-red-500/25 text-red-200'
                      : 'bg-white/[0.04] border border-white/10 text-slate-300'
                }`}>
                  <div className="space-y-0.5 whitespace-pre-wrap break-words">{renderRich(m.content)}</div>

                  {/* Tool trace */}
                  {m.role === 'assistant' && !m.error && m.toolsUsed && m.toolsUsed.length > 0 && (
                    <div className="flex items-center gap-1 flex-wrap mt-2 pt-2 border-t border-white/5">
                      <Wrench size={10} className="text-slate-500" />
                      {m.toolsUsed.map(t => (
                        <span key={t} className="px-1.5 py-0.5 rounded-md text-[9px] font-mono font-bold bg-cyan-500/10 border border-cyan-500/25 text-cyan-300">
                          {TOOL_LABEL[t] || t}
                        </span>
                      ))}
                      {m.engine && (
                        <span
                          className={`ml-auto px-1.5 py-0.5 rounded-md text-[9px] font-mono font-bold border ${m.degraded ? 'bg-amber-500/15 border-amber-500/30 text-amber-300' : 'text-slate-600'}`}
                          title={`engine: ${m.engine}${m.degraded ? ' — deterministic mode (LLM engines offline, auto-retry ON)' : ''}`}
                        >
                          {m.degraded ? '⚡ DETERMINISTIC' : (m.engine.split('/').pop()?.slice(0, 18) || '')}
                        </span>
                      )}
                    </div>
                  )}
                </div>
                {m.role === 'user' && (
                  <div className="w-7 h-7 rounded-xl bg-cyan-500/15 border border-cyan-500/30 flex items-center justify-center shrink-0 mt-0.5">
                    <User size={14} className="text-cyan-300" />
                  </div>
                )}
              </div>
            ))}

            {busy && (
              <div className="flex gap-2">
                <div className="w-7 h-7 rounded-xl bg-purple-500/15 border border-purple-500/30 flex items-center justify-center shrink-0 mt-0.5">
                  <Loader2 size={14} className="text-purple-300 animate-spin" />
                </div>
                <div className="rounded-2xl px-3 py-2.5 bg-white/[0.04] border border-white/10 text-[11px] text-slate-400 font-mono">
                  tools check kar raha hu<span className="animate-pulse">…</span>
                </div>
              </div>
            )}
          </div>

          {/* Input */}
          <div className="flex gap-2 p-3 border-t border-white/5">
            <input
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(input); } }}
              placeholder="Poocho: TATAMOTORS ka setup kaisa hai? / Aaj kya trade karu?"
              disabled={busy}
              className="flex-1 bg-black/40 border border-white/10 rounded-xl px-3 py-2 text-[12px] text-slate-200 placeholder:text-slate-600 focus:outline-none focus:border-purple-500/50 disabled:opacity-50"
            />
            <button
              onClick={() => send(input)}
              disabled={busy || !input.trim()}
              className="px-3.5 py-2 rounded-xl bg-purple-500/20 border border-purple-500/40 text-purple-200 font-bold text-[12px] hover:bg-purple-500/30 transition-all disabled:opacity-30 flex items-center gap-1.5"
            >
              <Send size={13} /> {busy ? '…' : 'Send'}
            </button>
          </div>
        </>
      )}
    </div>
  );
});
