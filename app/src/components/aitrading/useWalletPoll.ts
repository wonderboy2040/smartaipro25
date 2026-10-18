// ============================================================
// useWalletPoll — v20.2 SINGLETON wallet store
// ------------------------------------------------------------
// PROBLEM: WalletCard (CoinDcxTab), WalletStrip (OrderConsole) and
// PortfolioHeat (OrderConsole) each ran their OWN 60s poll of
// /api/ai/wallet → 3 concurrent pollers = 3 signed CoinDCX wallet
// calls per minute from ONE browser (rate-limit + key-abuse
// surface, and the audit counted them as independent timers).
//
// FIX: one module-level store, one interval, N subscribers.
// React's useSyncExternalStore keeps every component consistent
// with the SAME snapshot (a wallet refresh lands everywhere at
// once). The timer only runs while ≥1 subscriber is mounted and
// the tab is visible; the last unmount parks it completely.
// Late subscribers (mount >20s after the last fetch) trigger a
// fresh poll instead of showing stale data.
//
// v20.8.5: 60s → 25s cadence (user: "futures wallet bahut late
// read kar raha hai"). Server-side 10s snapshot mini-cache +
// single-flight ke saath milkar effective freshness ≈ 15-25s —
// CoinDCX signed API load 2.4 calls/min par hi rehta hai (3
// pollers ke purane 3/min se bhi KAM).
// ============================================================
import { useSyncExternalStore } from 'react';
import { fetchWallet } from './useAITrading';
import type { WalletView } from './types';

export interface WalletSnapshot {
  wallet: WalletView | null;
  failed: boolean;
  fetchedAt: number;
}

let snap: WalletSnapshot = { wallet: null, failed: false, fetchedAt: 0 };
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | null = null;
let inflight = false;
let lastFetchAt = 0;

const emit = () => { for (const l of listeners) { try { l(); } catch { /* dead listener */ } } };

async function poll(force = false): Promise<void> {
  if (inflight) return;
  const now = Date.now();
  // Shared-cache guard: a burst of mounts (or a refresh + timer race)
  // must not fan out into parallel wallet calls. v20.8.5: 30s → 20s
  // (server apna 10s mini-cache rakhta hai — double-guard)
  if (!force && snap.wallet && now - lastFetchAt < 20_000) return;
  inflight = true;
  lastFetchAt = now;
  try {
    const w = await fetchWallet();
    snap = { wallet: w || null, failed: !w, fetchedAt: Date.now() };
  } catch {
    snap = { wallet: null, failed: true, fetchedAt: Date.now() };
  } finally {
    inflight = false;
    emit();
  }
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  if (listeners.size === 1) {
    // First subscriber boots the shared cycle.
    void poll();
    if (timer == null) {
      timer = setInterval(() => {
        if (document.hidden || listeners.size === 0) return;
        void poll(true);
      }, 25_000);
    }
  } else if (Date.now() - lastFetchAt > 20_000) {
    // Late subscriber + stale cache → refresh soon (throttled by the
    // in-flight guard; the 20s staleness guard does not apply because there
    // is no wallet to show yet from this component's perspective).
    void poll(true);
  }
  return () => {
    listeners.delete(cb);
    if (listeners.size === 0 && timer != null) {
      clearInterval(timer);
      timer = null;
    }
  };
}

const getSnapshot = () => snap;

export function useWalletPoll(): WalletSnapshot & { refresh: () => void } {
  const s = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  return { ...s, refresh: () => { void poll(true); } };
}

// test hooks
export function __resetWalletStoreForTests() {
  listeners.clear();
  if (timer != null) { clearInterval(timer); timer = null; }
  snap = { wallet: null, failed: false, fetchedAt: 0 };
  inflight = false;
  lastFetchAt = 0;
}
export function __walletStoreInternalsForTests() {
  return { listeners: listeners.size, timerRunning: timer != null, inflight, lastFetchAt };
}
