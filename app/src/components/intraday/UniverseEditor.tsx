// ============================================================
// intraday/UniverseEditor — custom scanner watchlist manager
// ------------------------------------------------------------
// Add extra symbols to the scan universe (max 50), remove any base
// symbol you never want scanned, restore removed ones. Persisted
// server-side per MARKET (NSE / CRYPTO) — survives restarts.
// ============================================================
import { useCallback, useEffect, useState } from 'react';
import { apiFetch } from '../../utils/api';
import type { UniverseInfo } from './types';

export function UniverseEditor({ market, onClose, onChanged }: {
  market?: 'INDIA' | 'CRYPTO'; onClose: () => void; onChanged: () => void;
}) {
  const mkt = market === 'CRYPTO' ? 'CRYPTO' : 'INDIA';
  const query = mkt === 'CRYPTO' ? '?market=CRYPTO' : '';
  const [info, setInfo] = useState<UniverseInfo | null>(null);
  const [input, setInput] = useState('');
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await apiFetch(`/api/intraday-universe${query}`, { signal: AbortSignal.timeout(8000) });
      if (res.ok) setInfo(await res.json());
    } catch { /* offline */ }
  }, [query]);

  useEffect(() => { load(); }, [load]);

  const mutate = async (body: Record<string, unknown>) => {
    setBusy(true);
    try {
      const res = await apiFetch(`/api/intraday-universe${query}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(8000),
      });
      const j = await res.json().catch(() => ({}));
      if (res.ok) {
        setInfo(j);
        onChanged();
        setMsg({ ok: true, text: 'Watchlist updated ✓' });
      } else {
        setMsg({ ok: false, text: j?.error?.message || `HTTP ${res.status}` });
      }
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : 'network error' });
    } finally {
      setBusy(false);
    }
  };

  const add = () => {
    const syms = input.split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
    if (!syms.length) return;
    setInput('');
    mutate({ add: syms });
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-6 bg-black/80 backdrop-blur-sm" onClick={onClose}>
      <div
        className="quantum-panel rounded-2xl border border-white/10 w-full max-w-lg max-h-[85vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-white/10 bg-black/30">
          <div>
            <div className="text-sm font-black text-white">
              ⚙ Scanner Universe {mkt === 'CRYPTO' && <span className="text-amber-300">· CRYPTO</span>}
            </div>
            <div className="text-[10px] font-mono text-slate-500">
              {info ? `${info.effectiveCount} symbols scanned (${info.baseCount} base + ${info.custom.length} custom${info.removedBase.length ? `, ${info.removedBase.length} removed` : ''})` : 'loading…'}
            </div>
          </div>
          <button onClick={onClose} className="quantum-btn-ghost px-3 py-1.5 rounded-xl text-xs font-black">✕</button>
        </div>

        <div className="p-4 space-y-4">
          {/* Add custom */}
          <div>
            <div className="text-[10px] uppercase font-bold text-slate-400 tracking-wider mb-1.5">Add Custom Symbols (max 50)</div>
            <div className="flex gap-2">
              <input
                value={input}
                onChange={(e) => setInput(e.target.value.toUpperCase())}
                onKeyDown={(e) => { if (e.key === 'Enter') add(); }}
                placeholder={mkt === 'CRYPTO' ? 'e.g. LTC, TRX, ATOM…' : 'e.g. TATAPOWER, DMART, PNB…'}
                className="flex-1 bg-black/40 border border-white/10 rounded-xl px-3 py-2 text-xs font-mono text-slate-200 placeholder:text-slate-600 focus:border-cyan-500/50 focus:outline-none"
                disabled={busy}
              />
              <button onClick={add} disabled={busy || !input.trim()} className="quantum-btn px-4 py-2 rounded-xl text-xs font-black disabled:opacity-40">
                ADD
              </button>
            </div>
            <p className="text-[9px] text-slate-600 mt-1 font-mono">
              {mkt === 'CRYPTO'
                ? 'CoinDCX INR pair symbols only (A-Z, 0-9, & , -). Next scan se include honge.'
                : 'NSE cash symbols only (A-Z, 0-9, & , -). Next scan se include honge.'}
            </p>
          </div>

          {/* Custom list */}
          {info && info.custom.length > 0 && (
            <div>
              <div className="text-[10px] uppercase font-bold text-slate-400 tracking-wider mb-1.5">Custom Symbols</div>
              <div className="flex flex-wrap gap-1.5">
                {info.custom.map(sym => (
                  <button
                    key={sym}
                    onClick={() => mutate({ remove: [sym] })}
                    disabled={busy}
                    className="px-2 py-1 rounded-lg text-[10px] font-mono font-bold bg-cyan-500/10 border border-cyan-500/25 text-cyan-300 hover:bg-red-500/15 hover:border-red-500/30 hover:text-red-300 transition-colors"
                    title="Remove"
                  >
                    {sym} ✕
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Removed base */}
          {info && info.removedBase.length > 0 && (
            <div>
              <div className="text-[10px] uppercase font-bold text-slate-400 tracking-wider mb-1.5">Removed Base Symbols (click to restore)</div>
              <div className="flex flex-wrap gap-1.5">
                {info.removedBase.map(sym => (
                  <button
                    key={sym}
                    onClick={() => mutate({ restore: [sym] })}
                    disabled={busy}
                    className="px-2 py-1 rounded-lg text-[10px] font-mono font-bold bg-red-500/10 border border-red-500/25 text-red-300 hover:bg-emerald-500/15 hover:border-emerald-500/30 hover:text-emerald-300 transition-colors"
                    title="Restore to scan universe"
                  >
                    ↺ {sym}
                  </button>
                ))}
              </div>
            </div>
          )}

          {msg && (
            <div className={`text-[11px] font-mono ${msg.ok ? 'text-emerald-400' : 'text-red-400'}`}>{msg.text}</div>
          )}
        </div>
      </div>
    </div>
  );
}
