// ============================================================
// src/components/aitrading/QuickNav.tsx — v6.9
// ------------------------------------------------------------
// Sticky quick-jump chip bar: one chip per section, smooth
// scrollIntoView to the section anchor. Stays visible while
// the (long) desk page scrolls — the "simple navigation"
// upgrade so nothing feels buried.
// ============================================================
import { memo } from 'react';

export interface QuickNavItem {
  id: string;
  label: string;
  emoji?: string;
}

export const QuickNav = memo(function QuickNav({ items }: { items: QuickNavItem[] }) {
  const go = (id: string) => {
    try {
      const el = document.getElementById(id);
      el?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch { /* non-fatal */ }
  };
  return (
    <div className="sticky top-2 z-30 quantum-panel rounded-2xl px-2.5 py-2 flex gap-1.5 overflow-x-auto scrollbar-hide backdrop-blur-md" role="navigation" aria-label="Section quick nav">
      {items.map(it => (
        <button key={it.id} onClick={() => go(it.id)}
          className="px-2.5 py-1.5 rounded-xl text-[10px] font-black whitespace-nowrap text-slate-400 hover:text-cyan-300 hover:bg-cyan-500/10 border border-transparent hover:border-cyan-500/25 transition-colors"
          title={`Jump to ${it.label}`}>
          {it.emoji && <span className="mr-1">{it.emoji}</span>}{it.label}
        </button>
      ))}
    </div>
  );
});

