// ============================================================
// src/components/aitrading/ModelRegistry.tsx
// ------------------------------------------------------------
// The "Superintelligence MCP model bus" — the full committee with
// role, weight, engine type and live online status. AI Council shows its
// provider (gemini/groq/cerebras) or an honest OFFLINE badge.
// v21.11: registry ab accuracy-suite seats bhi cover karti hai (V2
// Sentiment/InstFlow/FundaCheck + 4 mesh shadow seats + tape-MTF) —
// har known seat ka apna icon, unknown hi '🤖' fallback patra.
// ============================================================
import { memo } from 'react';
import type { ModelStatusRow } from './types';

const ICONS: Record<string, string> = {
  trend: '📐', momentum: '🚀', volatility: '📊', volume: '🌊',
  pattern: '🕯️', sr: '🎯', options: '🎲', regime: '🌍', aicouncil: '🧠',
  sentiment: '📰', instflow: '🏦', fundamentals: '🧾',
  // v21.11: seats jo pehle '🤖' fallback me gir rahe the
  tape: '📼', 'tape-mtf': '🎞️', macross: '✂️', smc: '🦈', structure: '🏗️',
  instflowpro: '🏛️', techconsensus: '🔭', fundaproplus: '📚', cryptoonchain: '⛓️',
};

export const ModelRegistry = memo(function ModelRegistry({ models }: { models: ModelStatusRow[] }) {
  const quant = models.filter(m => m.id !== 'aicouncil');
  const council = models.find(m => m.id === 'aicouncil');

  return (
    <section className="quantum-panel rounded-2xl p-4" aria-label="Model registry">
      <div className="flex items-center justify-between mb-3">
        <span className="text-xs font-black text-slate-200">🧬 SUPERINTELLIGENCE MODEL REGISTRY</span>
        <span className="text-[10px] text-slate-500 font-mono">{quant.filter(m => m.online).length + (council?.online ? 1 : 0)}/{models.length} online</span>
      </div>
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
        {models.map(m => (
          <div key={m.id} className={`rounded-xl p-3 border ${m.online
            ? (m.id === 'aicouncil' ? 'border-violet-500/30 bg-violet-500/5' : 'border-cyan-500/20 bg-cyan-500/[0.03]')
            : 'border-slate-600/20 bg-slate-600/5 opacity-60'}`}>
            <div className="flex items-center gap-2">
              <span className="text-lg">{ICONS[m.id] || '🤖'}</span>
              <div className="min-w-0 flex-1">
                <div className="text-[11px] font-black text-slate-100 truncate">{m.name}</div>
                <div className="text-[9px] text-slate-500 font-mono">w {m.weight} · {m.engine}</div>
              </div>
              <span className={`w-1.5 h-1.5 rounded-full ${m.online ? 'bg-emerald-400 animate-pulse-dot' : 'bg-slate-600'}`} />
            </div>
            <div className="text-[10px] text-slate-500 mt-1.5 leading-snug">{m.role}</div>
          </div>
        ))}
      </div>
      {council && !council.online && (
        <p className="text-[10px] text-amber-400/70 mt-2.5 leading-relaxed">
          ⚠️ AI Council offline — no LLM provider key configured (set GEMINI_API_KEY / GROQ_API_KEY / CEREBRAS_API_KEY on the server).
          The quant committee still produces full consensus; LLM verification layer engages automatically when a key is present.
        </p>
      )}
      {/* v21.11: mesh shadow seats (w 0) honest disclosure — user ko pata
          rahe ki ye seats consensus me weight nahi rakhti jab tak settled
          outcomes se accountability unhe promote nahi karta. */}
      {models.some(m => Number(m.weight ?? 0) === 0) && (
        <p className="text-[10px] text-slate-500 mt-2 leading-relaxed">
          ◌ Shadow seats (w 0): ye models abhi evidence collect kar rahe hain — settled outcomes se edge prove hote hi voting weight milti hai. Consensus par zero effect.
        </p>
      )}
    </section>
  );
});
