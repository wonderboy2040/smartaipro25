// ============================================================
// test/aiFast.test.ts — v21.14.0 (layaFast lineage, Laya removed)
// ------------------------------------------------------------
// Locks the engine speed layers (ab jev-only world):
//   1. FIFO concurrency gate (jevEngine) — bursts queue hoti hain,
//      har wire call ko queue ke BAAD pura timeout budget milta
//      hai; cache-hits bypass; queueWaits telemetry.
//   2. retryOnTimeout policy — jev default ON (purana behaviour);
//      honest `timeout` note; off => single attempt.
//   3. boardAiConfirm SWRV — memo expire hone par bhi instant
//      stale verdict + background refresh; 2×TTL cap ke baad
//      blocking wire; AI_CONFIRM_SWRV=0 kill-switch.
// (v21.14: sidecar warmup section removed — layaSidecar.js deleted.)
// Hermetic: fake fetch (deferred-resolvable).
// ============================================================
import { describe, it, expect, beforeEach, vi } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { createJev, providerConfig } from '../server/bots/jevEngine.js';
import {
  confirmBoardSignals,
  __resetBoardAiConfirmForTests,
  __setProvidersForTests,
  __setMemoTtlForTests,
  __memoPeekForTests,
} from '../server/ai/boardAiConfirm.js';

const TMP = path.join(os.tmpdir(), `ai-fast-${process.pid}-${Date.now()}`);
const mkCfg = (over = {}) => ({ apiKey: 'k', cachePath: path.join(TMP, 'c.jsonl'), ...over });

// ---------- helpers: deferred fake fetch (abort-signal aware) ----------
function mkDeferredFetch() {
  const pending: any[] = [];
  let total = 0;
  const fetchImpl = (url: any, init: any) => new Promise((resolve, reject) => {
    total++;
    const slot: any = { url, init, resolve, reject, done: false };
    const settle = (fn: any, val: any) => {
      if (slot.done) return;
      slot.done = true;
      const i = pending.indexOf(slot);
      if (i >= 0) pending.splice(i, 1);
      try { fn(val); } catch { /* double-settle guard */ }
    };
    slot.settle = settle;
    pending.push(slot);
    // v21.5.0 contract: real fetch AbortSignal.timeout pe reject hota hai
    try {
      init?.signal?.addEventListener?.('abort', () => settle(reject, init.signal?.reason ?? TimeoutErr()));
    } catch { /* signal-less init */ }
  });
  const started = () => total;
  const resolveOne = (choice: string, p = { [choice]: 0.9, wait: 0.1 }) => {
    const s = pending.shift();
    if (!s) throw new Error('no pending fetch');
    s.resolve({
      ok: true, status: 200,
      json: async () => ({ answers: { action: { choice, probabilities: p, confidence: 0.9 } }, usage: null }),
    });
  };
  const rejectOne = (err: any) => {
    const s = pending.shift();
    if (!s) throw new Error('no pending fetch');
    s.reject(err);
  };
  return { fetchImpl, started, resolveOne, rejectOne, pending };
}

const flushN = async (n = 6) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); };

const TimeoutErr = () => {
  const e: any = new Error('The operation was aborted due to timeout');
  e.name = 'TimeoutError';
  return e;
};

const SNAP = (i: number) => ({
  proposed: 'enter_long',
  contextLines: [`ctx-${i}`],
  features: {},
});
const PROMPT = {
  instructions: 'test',
  criteria: { enter_long: 'L', enter_short: 'S', wait: 'W' },
};

beforeEach(() => {
  __resetBoardAiConfirmForTests();
});

// ============================================================
// 1. FIFO concurrency gate
// ============================================================
describe('aiFast — jevEngine FIFO concurrency gate', () => {
  it('concurrency=2: 3 parallel wire calls me se sirf 2 fetch start; 3rd queue me', async () => {
    const f = mkDeferredFetch();
    const jev = createJev(mkCfg({ concurrency: 2, retries: 0, fetchImpl: f.fetchImpl }));
    const p = [0, 1, 2].map((i) => jev(SNAP(i), PROMPT));
    await flushN();
    expect(f.started()).toBe(2);           // gate hold kar raha hai
    expect(jev.stats().queueWaits).toBe(1); // teesra request queue me
    f.resolveOne('enter_long');
    await flushN();
    expect(f.started()).toBe(3);            // slot free -> next start
    f.resolveOne('enter_long');
    f.resolveOne('enter_long');
    const v = await Promise.all(p);
    expect(v.every((x) => x.action === 'enter_long')).toBe(true);
  });

  it('concurrency=0 (cloud default): sab turant start — gate nahi', async () => {
    const f = mkDeferredFetch();
    const jev = createJev(mkCfg({ concurrency: 0, retries: 0, fetchImpl: f.fetchImpl }));
    const p = [0, 1, 2].map((i) => jev(SNAP(i), PROMPT));
    await flushN();
    expect(f.started()).toBe(3);
    f.resolveOne('enter_long'); f.resolveOne('enter_long'); f.resolveOne('enter_long');
    await Promise.all(p);
  });

  it('cache-hit semaphore ko bypass karta hai (koi naya fetch nahi)', async () => {
    const f = mkDeferredFetch();
    const jev = createJev(mkCfg({ concurrency: 1, retries: 0, fetchImpl: f.fetchImpl }));
    const first = jev(SNAP(0), PROMPT);
    await flushN();
    f.resolveOne('enter_long');
    await first;
    const calls = jev.stats().calls;
    const wireTotal = f.started();
    const again = await jev(SNAP(0), PROMPT); // same payload -> cache
    expect(again.cached).toBe(true);
    expect(jev.stats().calls).toBe(calls);    // wire call nahi hua
    expect(f.started()).toBe(wireTotal);     // koi naya fetch start nahi hua
    expect(jev.stats().cacheHits).toBe(1);
  });

  it('stats(): queueWaits + concurrency expose hote hain', async () => {
    const f = mkDeferredFetch();
    const jev = createJev(mkCfg({ concurrency: 2, retries: 0, fetchImpl: f.fetchImpl }));
    const s0 = jev.stats();
    expect(s0.queueWaits).toBe(0);
    expect(s0.concurrency).toBe(2);
    const p = [0, 1, 2].map((i) => jev(SNAP(i), PROMPT));
    await flushN();
    f.resolveOne('enter_long');
    await flushN(); // slot release -> teesra start
    f.resolveOne('enter_long');
    f.resolveOne('enter_long');
    await Promise.all(p);
    expect(jev.stats().queueWaits).toBe(1); // teesra queue me tha
  });
});

// ============================================================
// 2. retryOnTimeout policy + timeout note
// ============================================================
describe('aiFast — retryOnTimeout + honest timeout note', () => {
  it('retryOnTimeout=false: timeout pe retry NAHI — 1 hi fetch, note "timeout"', async () => {
    const f = mkDeferredFetch();
    const jev = createJev(mkCfg({ concurrency: 2, retryOnTimeout: false, retries: 1, timeoutMs: 50, fetchImpl: f.fetchImpl }));
    const v = await jev(SNAP(0), PROMPT);
    expect(v.action).toBe('wait');
    expect(v.note).toBe('timeout');
    expect(f.started()).toBe(1); // retry nahi hua (queue amplification ban)
    expect(jev.stats().errors).toBe(1);
  });

  it('jev default (retryOnTimeout=true): timeout bhi retry karta hai', async () => {
    const f = mkDeferredFetch();
    const jev = createJev(mkCfg({ retries: 1, retryOnTimeout: true, fetchImpl: f.fetchImpl }));
    const v = jev(SNAP(0), PROMPT);
    await flushN();
    expect(f.started()).toBe(1);
    f.rejectOne(TimeoutErr()); // first attempt timeout
    // retry backoff 300ms (real) — cloud path ka purana behaviour
    await new Promise((r) => setTimeout(r, 420));
    expect(f.started()).toBe(2); // retry hua (cloud behaviour unchanged)
    f.resolveOne('enter_long');
    const out = await v;
    expect(out.action).toBe('enter_long');
  });

  it('providerConfig: jev defaults concurrency=0 + retryOnTimeout=true; env override', () => {
    const j = providerConfig('jev', {});
    expect(j.concurrency).toBe(0);
    expect(j.retryOnTimeout).toBe(true); // cloud purana behaviour
    const o = providerConfig('jev', { JEV_CONCURRENCY: '4', JEV_RETRY_ON_TIMEOUT: '0' });
    expect(o.concurrency).toBe(4);
    expect(o.retryOnTimeout).toBe(false);
  });
});

// ============================================================
// 3. boardAiConfirm SWRV
// ============================================================
describe('aiFast — boardAiConfirm SWRV (stale-while-revalidate)', () => {
  const mkSig = (sym: string, score = 88) => ({
    symbol: sym, side: 'LONG', score, grade: 'STRONG', superIntel: { aiScore: score }, ltp: 100,
  });

  it('fresh memo: wire call ek baar, CONFIRMED stamp, stale=false', async () => {
    const call = vi.fn(async () => ({ action: 'enter_long', probs: { enter_long: 0.9 }, confidence: 0.9 }));
    __setProvidersForTests({ jev: call });
    const s = mkSig('BTC');
    const meta = await confirmBoardSignals([s], 'CRYPTO');
    expect(meta.stamped).toBe(1);
    expect(meta.confirmed).toBe(1);
    expect(s.aiConfirm.verdict).toBe('CONFIRMED');
    expect(s.aiConfirm.stale).toBe(false);
    expect(call).toHaveBeenCalledTimes(1); // jev only
  });

  it('memo expire par SWRV: instant stale verdict + background refresh', async () => {
    let flavour = 0;
    const call = vi.fn(async () => {
      flavour++;
      return { action: flavour > 1 ? 'wait' : 'enter_long', probs: { enter_long: 0.9 }, confidence: 0.9 };
    });
    __setProvidersForTests({ jev: call });
    __setMemoTtlForTests(30); // 30ms TTL
    const s1 = mkSig('BTC');
    const m1 = await confirmBoardSignals([s1], 'CRYPTO');
    expect(m1.stale).toBe(0);
    expect(call).toHaveBeenCalledTimes(1);

    await new Promise((r) => setTimeout(r, 60)); // memo expire, stale-cap (max(60, 1030)=1030ms) ke andar
    const s2 = mkSig('BTC');
    const t0 = Date.now();
    const m2 = await confirmBoardSignals([s2], 'CRYPTO');
    const elapsed = Date.now() - t0;
    expect(elapsed).toBeLessThan(25);          // instant serve — provider wait nahi
    expect(m2.stale).toBe(1);
    expect(s2.aiConfirm.verdict).toBe('CONFIRMED'); // stale copy turant
    expect(s2.aiConfirm.stale).toBe(true);
    // background refresh chal raha hai (wire calls badh gaye)
    await new Promise((r) => setTimeout(r, 30));
    expect(call.mock.calls.length).toBeGreaterThan(1);
  });

  it('stale-cap (2×TTL) ke baad: SWRV nahi — blocking fresh wire', async () => {
    const call = vi.fn(async () => ({ action: 'enter_long', probs: { enter_long: 0.9 }, confidence: 0.9 }));
    __setProvidersForTests({ jev: call });
    __setMemoTtlForTests(40); // stale cap = max(80, 1040) = 1040ms
    const s1 = mkSig('ETH');
    await confirmBoardSignals([s1], 'CRYPTO');
    expect(call).toHaveBeenCalledTimes(1);

    await new Promise((r) => setTimeout(r, 1200)); // stale cap paar
    const before = call.mock.calls.length;
    const s2 = mkSig('ETH');
    const m2 = await confirmBoardSignals([s2], 'CRYPTO');
    expect(m2.stale).toBe(0);                    // stale serve NAHI hua
    expect(call.mock.calls.length).toBeGreaterThan(before); // fresh wire hua
  });

  it('memo fresh: doosra cycle wire call hi nahi karta', async () => {
    const call = vi.fn(async () => ({ action: 'enter_long', probs: { enter_long: 0.9 }, confidence: 0.9 }));
    __setProvidersForTests({ jev: call });
    __setMemoTtlForTests(60_000);
    await confirmBoardSignals([mkSig('SOL')], 'CRYPTO');
    const before = call.mock.calls.length;
    const m2 = await confirmBoardSignals([mkSig('SOL')], 'CRYPTO');
    expect(call.mock.calls.length).toBe(before); // memo hit — zero wire
    expect(m2.stamped).toBe(1);
    expect(m2.stale).toBe(0);
    expect(__memoPeekForTests().size).toBe(1);
  });

  it('v21.14: wire shape me laya key absent + detail.jev only', async () => {
    const call = vi.fn(async () => ({ action: 'enter_long', probs: { enter_long: 0.9 }, confidence: 0.9 }));
    __setProvidersForTests({ jev: call });
    const s = mkSig('BTC');
    await confirmBoardSignals([s], 'CRYPTO');
    expect(s.aiConfirm.jev).toBe('AGREE');
    expect('laya' in s.aiConfirm).toBe(false);
    expect(s.aiConfirm.detail?.jev?.v).toBe('AGREE');
    expect('laya' in (s.aiConfirm.detail || {})).toBe(false);
  });
});
