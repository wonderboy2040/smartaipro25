// ============================================================
// src/components/aitrading/AlertsPanel.tsx — v6.5
// ------------------------------------------------------------
// Telegram alert setup (no Render env needed) + AI Council keys
// (the 9th model). Values are typed once, stored server-side,
// mirrored to the encrypted backup, and NEVER read back raw —
// only a masked tail (…abcd) confirms what's saved.
// ============================================================
import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { desktopNotify, desktopNotifyPermission, desktopNotifySupported, requestDesktopNotifyPermission } from '../../utils/desktopNotify';
import type { AlertsStatus, MaskedSecret } from './types';

function StatusChip({ label, s }: { label: string; s?: MaskedSecret }) {
  return (
    <span className={`px-2 py-0.5 rounded-lg text-[9px] font-black border ${s?.configured ? 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30' : 'bg-slate-600/20 text-slate-500 border-slate-600/30'}`}>
      {label} {s?.configured ? `✓ ${s.tail}` : 'not set'}
    </span>
  );
}

interface Props {
  fetchAlertsStatus: () => Promise<AlertsStatus | null>;
  saveAlertsConfig: (patch: Record<string, string | null>) => Promise<{ ok: boolean; error?: string }>;
  testAlert: () => Promise<{ ok: boolean; error?: string }>;
  busy?: boolean;
  notify: (ok: boolean, text: string) => void;
}

export const AlertsPanel = memo(function AlertsPanel({ fetchAlertsStatus, saveAlertsConfig, testAlert, busy, notify }: Props) {
  const [status, setStatus] = useState<AlertsStatus | null>(null);
  const [tgToken, setTgToken] = useState('');
  const [tgChat, setTgChat] = useState('');
  const [geminiKey, setGeminiKey] = useState('');
  const [groqKey, setGroqKey] = useState('');
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const reload = useCallback(async () => {
    const s = await fetchAlertsStatus();
    setStatus(s);
  }, [fetchAlertsStatus]);

  useEffect(() => { reload(); }, [reload]);

  // v10.18 (deep-recheck #3): timer-ref message (a stale timer wiped a
  // newer save message early).
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (flashTimer.current) clearTimeout(flashTimer.current); }, []);
  const flash = (ok: boolean, text: string) => {
    setMsg({ ok, text });
    notify(ok, text);
    if (flashTimer.current) clearTimeout(flashTimer.current);
    flashTimer.current = setTimeout(() => setMsg(null), 5000);
  };

  const save = async (patch: Record<string, string | null>) => {
    const r = await saveAlertsConfig(patch);
    if (r.ok) { flash(true, '✅ Saved — server + encrypted backup (restart-safe)'); reload(); }
    else flash(false, `⛔ ${r.error || 'save failed'}`);
    return r;
  };

  const tgReady = status?.telegram?.configured;
  const tokenLooksSet = status?.status?.telegramBotToken?.configured;
  const chatLooksSet = status?.status?.telegramChatId?.configured;

  // v20.2 DESKTOP NOTIFICATIONS — native OS toasts for NEW STRONG
  // signals while the tab is hidden. Permission can ONLY be requested
  // from this click (browser policy). Works browser-kholne par; Telegram
  // out-of-browser channel hai.
  const [deskPerm, setDeskPerm] = useState(desktopNotifyPermission());
  const deskSupported = desktopNotifySupported();
  const enableDesktop = async () => {
    const p = await requestDesktopNotifyPermission();
    setDeskPerm(p);
    if (p === 'granted') {
      desktopNotify('✅ SmartAI desktop alerts ON', 'Naye STRONG signals ab OS notification me aayenge (tab background me ho tab).', { force: true });
      flash(true, '✅ Desktop notifications ON — naye STRONG signals ab OS toast me aayenge');
    } else if (p === 'denied') {
      flash(false, '⛔ Browser ne notification permission block ki — site settings me allow karo');
    }
  };

  return (
    <div className="quantum-panel rounded-2xl p-4 space-y-3" aria-label="Alerts and AI keys panel">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-xs font-black text-slate-200">🔔 ALERTS &amp; AI COUNCIL KEYS</span>
        {msg && <span className={`text-[10px] font-bold ${msg.ok ? 'text-emerald-400' : 'text-red-400'}`}>{msg.text}</span>}
        <span className={`ml-auto px-2 py-0.5 rounded-lg text-[9px] font-black border ${tgReady ? 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30' : 'bg-slate-600/20 text-slate-500 border-slate-600/30'}`}>
          {tgReady ? `TELEGRAM LIVE (${status?.telegram?.source || 'env'})` : 'TELEGRAM OFF'}
        </span>
      </div>

      {/* ---- Telegram ---- */}
      <div className="grid gap-2 sm:grid-cols-[1fr_150px_auto_auto] items-end">
        <div>
          <label className="text-[9px] text-slate-500 font-black tracking-wider block mb-1">TELEGRAM BOT TOKEN (@BotFather se)</label>
          <input value={tgToken} onChange={e => setTgToken(e.target.value)} placeholder="123456789:AAE...token"
            className="quantum-input px-3 py-1.5 rounded-lg text-[11px] font-mono w-full" autoComplete="off" spellCheck={false}
            aria-label="telegram bot token" />
        </div>
        <div>
          <label className="text-[9px] text-slate-500 font-black tracking-wider block mb-1">CHAT ID (@userinfobot)</label>
          <input value={tgChat} onChange={e => setTgChat(e.target.value)} placeholder="123456789" inputMode="numeric"
            className="quantum-input px-3 py-1.5 rounded-lg text-[11px] font-mono w-full" autoComplete="off"
            aria-label="telegram chat id" />
        </div>
        <button onClick={() => save({ telegramBotToken: tgToken.trim() || null, telegramChatId: tgChat.trim() || null })}
          disabled={busy || (!tgToken.trim() && !tgChat.trim())}
          className="px-3 py-1.5 rounded-lg text-[10px] font-black bg-gradient-to-r from-cyan-600 to-indigo-600 text-white disabled:opacity-40">
          💾 SAVE
        </button>
        <button onClick={async () => {
          const r = await testAlert();
          flash(r.ok, r.ok ? '✅ Test message sent — Telegram check karo' : `⛔ ${r.error || 'send failed'}`);
        }} disabled={busy || !tgReady}
          title={tgReady ? 'Send a test message now' : 'Save a valid token + chat id first'}
          className="px-3 py-1.5 rounded-lg text-[10px] font-black bg-slate-700 text-slate-200 hover:bg-slate-600 disabled:opacity-40">
          📨 TEST
        </button>
      </div>
      <div className="flex gap-1.5 flex-wrap">
        <StatusChip label="token" s={status?.status?.telegramBotToken} />
        <StatusChip label="chat id" s={status?.status?.telegramChatId} />
        <span className="text-[9px] text-slate-600 self-center ml-1">
          Alerts: ★ STRONG signals (dono desks), fills/closes, auto-executions, watch failures. Same symbol+side 30 min silence.
        </span>
      </div>
      {(tokenLooksSet || chatLooksSet) && (
        <button onClick={() => save({ telegramBotToken: null, telegramChatId: null })} disabled={busy}
          className="text-[9px] font-black text-red-400/80 hover:text-red-300 underline underline-offset-2">
          clear saved telegram config
        </button>
      )}

      {/* ---- v20.2 Desktop notifications ---- */}
      <div className="pt-1 border-t border-white/5">
        <div className="flex items-center gap-2 flex-wrap mt-1.5">
          <div className="text-[10px] font-black text-slate-400 tracking-wider">🖥️ DESKTOP NOTIFICATIONS — browser background me tab tab OS toast</div>
          {deskSupported ? (
            <>
              <span className={`px-2 py-0.5 rounded-lg text-[9px] font-black border ${deskPerm === 'granted' ? 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30' : 'bg-slate-600/20 text-slate-500 border-slate-600/30'}`}>
                {deskPerm === 'granted' ? 'ENABLED' : deskPerm === 'denied' ? 'BLOCKED (browser settings)' : 'NOT ENABLED'}
              </span>
              {deskPerm !== 'granted' && (
                <button onClick={() => void enableDesktop()}
                  className="px-2.5 py-1 rounded-lg text-[9px] font-black bg-gradient-to-r from-cyan-600 to-indigo-600 text-white">
                  🔔 ENABLE
                </button>
              )}
            </>
          ) : (
            <span className="text-[9px] text-slate-600">is browser me Notification API nahi hai</span>
          )}
          <span className="text-[9px] text-slate-600 self-center ml-auto">Naya STRONG signal + tab hidden → OS notification (page khuli rehna chahiye; Telegram out-of-browser hai)</span>
        </div>
      </div>

      {/* ---- AI Council keys ---- */}
      <div className="pt-1 border-t border-white/5">
        <div className="text-[10px] font-black text-slate-400 tracking-wider mb-1.5 mt-1.5">🧠 AI COUNCIL — 9th model ko app se hi online karo (Render env ki zaroorat nahi)</div>
        <div className="grid gap-2 sm:grid-cols-[1fr_1fr_auto] items-end">
          <div>
            <label className="text-[9px] text-slate-500 font-black tracking-wider block mb-1">GEMINI API KEY (aistudio.google.com — FREE)</label>
            <input value={geminiKey} onChange={e => setGeminiKey(e.target.value)} placeholder="AIza..."
              className="quantum-input px-3 py-1.5 rounded-lg text-[11px] font-mono w-full" autoComplete="off" spellCheck={false}
              aria-label="gemini api key" />
          </div>
          <div>
            <label className="text-[9px] text-slate-500 font-black tracking-wider block mb-1">GROQ API KEY (console.groq.com — FREE)</label>
            <input value={groqKey} onChange={e => setGroqKey(e.target.value)} placeholder="gsk_..."
              className="quantum-input px-3 py-1.5 rounded-lg text-[11px] font-mono w-full" autoComplete="off" spellCheck={false}
              aria-label="groq api key" />
          </div>
          <button onClick={async () => {
            const r = await save({ geminiApiKey: geminiKey.trim() || null, groqApiKey: groqKey.trim() || null });
            if (r.ok) { setGeminiKey(''); setGroqKey(''); }
          }} disabled={busy || (!geminiKey.trim() && !groqKey.trim())}
            className="px-3 py-1.5 rounded-lg text-[10px] font-black bg-gradient-to-r from-violet-600 to-fuchsia-600 text-white disabled:opacity-40">
            💾 SAVE KEYS
          </button>
        </div>
        <div className="flex gap-1.5 flex-wrap mt-1.5">
          <StatusChip label="gemini" s={status?.status?.geminiApiKey} />
          <StatusChip label="groq" s={status?.status?.groqApiKey} />
          <span className="text-[9px] text-slate-600 self-center ml-1">
            Save karne ke 30-60s me 9th model board par vote karna shuru karega (key sirf server par rehti hai — browser me kabhi wapas nahi aati).
          </span>
        </div>
      </div>
    </div>
  );
});
