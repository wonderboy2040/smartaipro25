// ============================================================
// test/mcpAudit.test.ts — v13.2 A5 MCP TOOL GOVERNANCE
// ------------------------------------------------------------
// LOCKED HERE (plan A5: "Rate-limit + audit-log every MCP tool
// call, especially placeOrder"):
//   • Every call is audited: desk, tool, ok, ms, arg digest
//   • Errors surface as { error } payloads AND land in the ring
//   • Per-desk rolling-minute rate limit → structured
//     'rate-limited' answer the model can READ
//   • placeOrder-class tool names are FLAGGED in the audit view
//   • Arg digests truncate long values (sensitive sizing stays short)
//   • The ring is bounded (300) and the view bounded (120 recent)
//   • byTool aggregates calls / errors / avgMs
// ============================================================
import { describe, it, expect, beforeEach } from 'vitest';
import {
  withMcpAudit, mcpAuditView, __resetMcpAuditForTests, __testables,
} from '../server/ai/mcpAudit.js';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

describe('A5 MCP tool governance', () => {
  beforeEach(() => __resetMcpAuditForTests());

  it('audits a successful call with duration + arg digest', async () => {
    const out = await withMcpAudit('crypto', 'get_live_crypto_signals', { market: 'SPOT' }, async () => ({ signals: [1, 2] }));
    expect(out).toEqual({ signals: [1, 2] });
    const v = mcpAuditView();
    expect(v.ringSize).toBe(1);
    expect(v.recent[0]).toMatchObject({ desk: 'crypto', tool: 'get_live_crypto_signals', ok: true });
    expect(v.recent[0].args).toEqual({ market: 'SPOT' });
    expect(v.recent[0].ms).toBeGreaterThanOrEqual(0);
  });

  it('an { error } tool result counts as a failed call', async () => {
    await withMcpAudit('intraday', 'analyze_setup', { symbol: 'FAKE' }, async () => ({ error: 'no data' }));
    const v = mcpAuditView();
    expect(v.recent[0].ok).toBe(false);
    expect(v.recent[0].error).toBe('no data');
  });

  it('a thrown tool error is caught, audited, and returned as { error }', async () => {
    const out = await withMcpAudit('crypto', 'get_wallet', {}, async () => { throw new Error('boom'); });
    expect(out).toEqual({ error: 'boom' });
    const v = mcpAuditView();
    expect(v.recent[0].ok).toBe(false);
  });

  it('rate-limits per desk after 60 calls in a rolling minute', async () => {
    const quick = async () => ({ ok: true });
    for (let i = 0; i < 60; i++) await withMcpAudit('crypto', 't', {}, quick);
    const limited = await withMcpAudit('crypto', 't', {}, quick);
    expect(limited).toMatchObject({ error: 'rate-limited' });
    // another desk is unaffected (per-desk budget)
    const other = await withMcpAudit('intraday', 't', {}, quick);
    expect(other).toEqual({ ok: true });
    // the rate-limited call IS audited (ok:false, error rate-limited)
    const v = mcpAuditView();
    const rl = v.recent.find(r => r.error === 'rate-limited');
    expect(rl).toBeTruthy();
  });

  it('placeOrder-class tools are flagged in the view', async () => {
    await withMcpAudit('crypto', 'place_order', { symbol: 'XRP', qty: 300 }, async () => ({ ok: true }));
    const v = mcpAuditView();
    expect(v.recent[0].orderClass).toBe(true);
    expect(v.byTool['crypto:place_order'].orderClass).toBe(true);
    expect(v.byTool['crypto:place_order'].calls).toBe(1);
  });

  it('arg digest truncates long values to 40 chars', () => {
    const d = __testables._digest({ symbol: 'XRP', note: 'y'.repeat(200) });
    expect(d.symbol).toBe('XRP');
    expect(d.note.length).toBe(40);
    expect(d.note.endsWith('...')).toBe(true);
    expect(Object.keys(d).length).toBeLessThanOrEqual(4);
  });

  it('ring is bounded at 300, view recent bounded at 120', async () => {
    for (let i = 0; i < 320; i++) {
      await withMcpAudit('crypto', `tool_${i % 5}`, {}, async () => ({}));
    }
    const v = mcpAuditView();
    expect(v.ringSize).toBe(300);
    expect(v.recent.length).toBeLessThanOrEqual(120);
    expect(v.recent[0].tool).toBe('tool_4'); // newest first
  });

  it('byTool aggregates calls, errors, avgMs', async () => {
    await withMcpAudit('crypto', 'a', {}, async () => ({}));
    await withMcpAudit('crypto', 'a', {}, async () => ({ error: 'x' }));
    await sleep(2);
    await withMcpAudit('crypto', 'a', {}, async () => ({}));
    const agg = mcpAuditView().byTool['crypto:a'];
    expect(agg.calls).toBe(3);
    expect(agg.errors).toBe(1);
    expect(agg.avgMs).toBeGreaterThanOrEqual(0);
  });
});
