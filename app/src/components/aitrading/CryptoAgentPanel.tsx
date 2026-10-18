// ============================================================
// aitrading/CryptoAgentPanel — CRYPTO DESK MCP AGENT chat (v10.1)
// ------------------------------------------------------------
// The CoinDCX tab's conversational agent — the mirror of the proven
// intraday ProTraderAgentPanel: same chat shell, tool-trace chips,
// quick prompts (crypto-flavoured). Backend: POST /api/crypto-agent
// (18 tools: signals, deep coin scan, global stocks, wallet,
// positions, regime, track-record, sizing, agent status + v10.5
// funding-rate, risk-status and P&L + v12.0 perp-positioning and
// win-probability + accuracy-plan Phase 3.3 news search + v13.1
// verify_signal (SVA pro-trader final verdict — "XRP long ya short?"
// ka auditable answer) — full tool parity with the intraday agent).
// Answers follow the strict FULL-TICKET format
// enforced server-side — now with P(win) + EV on every ticket.
// ============================================================
import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { apiFetch } from '../../utils/api';
import { describeApiError } from '../../utils/apiError';
import { Send, Bot, User, Wrench, ChevronDown, Loader2, Trash2, Sparkles } from 'lucide-react';
// v18.7 ENGINE SENTINEL — live engine health chips + RECHECK.
import { EngineHealthStrip } from './EngineHealthStrip';

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
  { icon: '📋', label: 'Desk Briefing', prompt: 'Aaj ka desk briefing do — BTC regime, top spot+futures setups risk notes ke saath.' },
  { icon: '🛡', label: 'Verify Signal', prompt: 'XRP ka signal verify karo — SVA pro-trader checklist ke saath FINAL batao: long jana hai ya short?' },
  { icon: '💰', label: 'Wallet + Risk', prompt: 'Mera wallet, open positions aur risk status dikhao — kahan SL tighten karna chahiye?' },
  { icon: '🔍', label: 'Coin Deep-Dive', prompt: 'SOL ka deep analysis karo — entry, SL, leverage sab exact numbers me.' },
  { icon: '📈', label: 'P&L Review', prompt: 'Mera last 7 din ka P&L batao — realized + unrealized, win-rate ke saath.' },
  { icon: '🎯', label: 'Win Probability', prompt: 'BTC ka win probability batao — P(win) vs breakeven, EV in R, aur positioning read ke saath.' },
];

// Lightweight markdown-ish renderer (same as the intraday panel).
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
  get_live_crypto_signals: '📡 Live Signals',
  analyze_coin: '🔍 Deep Scan',
  analyze_global_stock: '🌍 Global Stock',
  get_wallet: '💰 Wallet',
  get_open_positions: '📝 Positions',
  get_market_regime: '🌍 Regime',
  get_track_record: '📊 Track Record',
  calculate_position_size: '🧮 Sizing',
  get_agent_status: '🤖 Agent',
  get_funding_rate: '💸 Funding',
  get_perp_intel: '🛰️ Perp Positioning',
  get_win_probability: '🎯 Win Probability',
  get_risk_status: '🛑 Risk',
  get_pnl: '📈 P&L',
  // v20.2: the 4 tools that previously rendered raw snake_case in the
  // tool-trace chips (14/18 labelled → 18/18).
  backtest_custom_strategy: '🧪 Strategy Replay',
  search_market_news: '📰 News Search',
  verify_signal: '🛡️ Verify Signal',
  get_model_consensus: '🧠 Model Consensus',
};

// Memoized — the CoinDCX tab re-renders on every board poll; this panel
// takes no changing props so memo short-circuits the conversation
// re-render + markdown re-parse (2026 perf audit M4 pattern).
export const CryptoAgentPanel = memo(function CryptoAgentPanel() {
  const [messages, setMessages] = useState<AgentMessage[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [greeted, setGreeted] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

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
      const res = await apiFetch('/api/crypto-agent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: convo }),
        signal: AbortSignal.timeout(90000),
      });
      const data = await res.json().catch(() => ({}));
      // v10.10 [object Object] fix — jsonError() responds {error:{message,correlationId}};
      // describeApiError unwraps every shape + appends the server log ref.
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
    if (expanded && !greeted && messages.length === 0) setGreeted(true);
  }, [expanded, greeted, messages.length]);

  return (
    <div className="quantum-panel rounded-2xl border border-cyan-500/20 overflow-hidden bg-black/40">
      {/* Header */}
      <button
        onClick={() => setExpanded(e => !e)}
        className="w-full flex items-center justify-between gap-2 px-4 py-3 hover:bg-white/[0.02]"
      >
        <div className="flex items-center gap-2 flex-wrap">
          <span className="flex items-center gap-1.5 text-xs font-black text-transparent bg-clip-text bg-gradient-to-r from-cyan-300 to-emerald-300">
            <Bot size={14} className="text-cyan-400" /> CRYPTO DESK AI AGENT
          </span>
          <span className="px-2 py-0.5 rounded-md text-[9px] font-black font-mono border bg-cyan-500/15 text-cyan-300 border-cyan-500/30">
            18 TOOLS • VERIFY + CONSENSUS + P(WIN) + EV TICKETS + NEWS
          </span>
          {busy && (
            <span className="px-2 py-0.5 rounded-md text-[9px] font-black font-mono border bg-emerald-500/15 text-emerald-300 border-emerald-500/30 animate-pulse">
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
          {/* Quick prompts */}
          <div className="flex gap-1.5 px-3 pb-2 flex-wrap">
            {QUICK_PROMPTS.map(q => (
              <button
                key={q.label}
                onClick={() => send(q.prompt)}
                disabled={busy}
                className="px-2.5 py-1 rounded-xl text-[10px] font-bold font-mono border bg-white/[0.03] border-white/10 text-slate-300 hover:border-cyan-500/40 hover:text-cyan-200 transition-all disabled:opacity-40"
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
                <div className="w-12 h-12 rounded-2xl bg-cyan-500/15 border border-cyan-500/30 flex items-center justify-center">
                  <Sparkles size={20} className="text-cyan-300" />
                </div>
                <div className="text-xs font-bold text-slate-300">Elite CoinDCX Desk Trader</div>
                <div className="text-[11px] text-slate-500 max-w-xs leading-relaxed">
                  Live spot + futures signals, wallet, positions, sizing aur track-record — sab tools ke saath.
                  Har recommendation poora ticket: <span className="text-slate-400">entry / SL / targets / size / window</span>.
                </div>
              </div>
            )}

            {messages.map((m, i) => (
              <div key={i} className={`flex gap-2 ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                {m.role === 'assistant' && (
                  <div className="w-7 h-7 rounded-xl bg-cyan-500/15 border border-cyan-500/30 flex items-center justify-center shrink-0 mt-0.5">
                    <Bot size={14} className="text-cyan-300" />
                  </div>
                )}
                <div className={`max-w-[85%] rounded-2xl px-3 py-2.5 text-[11.5px] leading-relaxed ${
                  m.role === 'user'
                    ? 'bg-emerald-500/15 border border-emerald-500/25 text-emerald-50'
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
                  <div className="w-7 h-7 rounded-xl bg-emerald-500/15 border border-emerald-500/30 flex items-center justify-center shrink-0 mt-0.5">
                    <User size={14} className="text-emerald-300" />
                  </div>
                )}
              </div>
            ))}

            {busy && (
              <div className="flex gap-2">
                <div className="w-7 h-7 rounded-xl bg-cyan-500/15 border border-cyan-500/30 flex items-center justify-center shrink-0 mt-0.5">
                  <Loader2 size={14} className="text-cyan-300 animate-spin" />
                </div>
                <div className="rounded-2xl px-3 py-2.5 bg-white/[0.04] border border-white/10 text-[11px] text-slate-400 font-mono">
                  desk tools check kar raha hu<span className="animate-pulse">…</span>
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
              placeholder="Poocho: SOL ka deep analysis do? / Aaj kya buy karu?"
              disabled={busy}
              className="flex-1 bg-black/40 border border-white/10 rounded-xl px-3 py-2 text-[12px] text-slate-200 placeholder:text-slate-600 focus:outline-none focus:border-cyan-500/50 disabled:opacity-50"
            />
            <button
              onClick={() => send(input)}
              disabled={busy || !input.trim()}
              className="px-3.5 py-2 rounded-xl bg-cyan-500/20 border border-cyan-500/40 text-cyan-200 font-bold text-[12px] hover:bg-cyan-500/30 transition-all disabled:opacity-30 flex items-center gap-1.5"
            >
              <Send size={13} /> {busy ? '…' : 'Send'}
            </button>
          </div>
        </>
      )}
    </div>
  );
});
