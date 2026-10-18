// ============================================================
// src/utils/desktopNotify.ts — v20.2 DESKTOP NOTIFICATIONS
// ------------------------------------------------------------
// In-app push: STRONG/ELITE signals pop a NATIVE OS notification
// (Notification API — no FCM/VAPID server needed) while the tab is
// open in the background. Telegram stays the out-of-browser channel;
// this covers "browser khol ke dusre kaam kar raha hoon" — the most
// common trading posture.
//
// Honest limits: only works while the page is open (a Service Worker
// push would need VAPID keys + a push server — documented, not
// faked). Permission is requested ONLY from a user click (browser
// policy), never on page load.
// ============================================================

let _lastNotifiedAt = 0;
const THROTTLE_MS = 30_000;

export function desktopNotifySupported(): boolean {
  return typeof window !== 'undefined' && 'Notification' in window;
}

export function desktopNotifyPermission(): NotificationPermission | 'unsupported' {
  if (!desktopNotifySupported()) return 'unsupported';
  return Notification.permission;
}

/** Request permission — MUST be called from a user gesture (click). */
export async function requestDesktopNotifyPermission(): Promise<NotificationPermission | 'unsupported'> {
  if (!desktopNotifySupported()) return 'unsupported';
  try { return await Notification.requestPermission(); } catch { return Notification.permission; }
}

/** Fire a notification (throttled, permission-checked, never throws). */
export function desktopNotify(title: string, body: string, opts: { force?: boolean } = {}): boolean {
  if (!desktopNotifySupported()) return false;
  if (Notification.permission !== 'granted') return false;
  const now = Date.now();
  if (!opts.force && now - _lastNotifiedAt < THROTTLE_MS) return false;
  _lastNotifiedAt = now;
  try {
    const n = new Notification(title, {
      body,
      tag: 'smartai-signal',
      icon: '/icon.svg', // v21.1.1 [audit D10]: favicon.ico exist nahi karta — public/ me icon.svg hai
    });
    // Focus the tab when the user clicks the toast.
    n.onclick = () => { try { window.focus(); n.close(); } catch { /* noop */ } };
    return true;
  } catch { return false; }
}

/** Test hook — reset the throttle between cases. */
export function __resetDesktopNotifyForTests() { _lastNotifiedAt = 0; }
