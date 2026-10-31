// ============================================================
// test/perpIntelS4V21300.test.ts — v21.30.0 S4 PERP COVERAGE
// ------------------------------------------------------------
// Locks:
//   • real basis = (mark − index) / index, null when either leg is
//     missing (never a fabricated 0);
//   • perpIntelWire carries indexPrice + basisPct;
//   • getPerpIntelFor honours a hard deadline and returns cached values
//     instead of hanging the auto tick;
//   • the auto tick enriches crypto/FUTURES rows before the guards and
//     reports explicit perpCoverage / dataStatus telemetry.
// ============================================================
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  getPerpIntel, getPerpIntelFor, perpIntelWire,
  __resetPerpIntelForTests, __seedPerpIntelForTests,
} from '../server/ai/perpIntel.js';

const _routes = new Map<string, () => Promise<any> | any>();
global.fetch = vi.fn(async (url) => {
  const u = String(url);
  for (const [frag, handler] of _routes) {
    if (u.includes(frag)) {
      const payload = await handler();
      return { ok: true, status: 200, json: async () => payload };
    }
  }
  throw new Error('network blocked');
}) as unknown as typeof fetch;

beforeEach(() => { _routes.clear(); __resetPerpIntelForTests(); });
afterEach(() => { _routes.clear(); __resetPerpIntelForTests(); });

describe('v21.30.0 S4 — index / basis', () => {
  it('computes basis from premiumIndex mark vs index', async () => {
    _routes.set('premiumIndex?symbol=BTCUSDT', () => ({
      markPrice: '60600', indexPrice: '60000', lastFundingRate: '0.0001',
      nextFundingTime: Date.now() + 3_600_000,
    }));
    const out = await getPerpIntel('BTC');
    expect(out.ok).toBe(true);
    expect(out.markPrice).toBe(60600);
    expect(out.indexPrice).toBe(60000);
    expect(out.basisPct).toBeCloseTo(1, 5);
    expect(out.fundingBps8h).toBeCloseTo(1, 5);

    const wire = perpIntelWire(out);
    expect(wire.indexPrice).toBe(60000);
    expect(wire.basisPct).toBeCloseTo(1, 5);
  });

  it('negative basis is reported, not clamped', async () => {
    _routes.set('premiumIndex?symbol=ETHUSDT', () => ({
      markPrice: '1980', indexPrice: '2000', lastFundingRate: '-0.0002',
    }));
    const out = await getPerpIntel('ETH');
    expect(out.basisPct).toBeCloseTo(-1, 5);
    expect(out.fundingBps8h).toBeCloseTo(-2, 5);
  });

  it('missing index → basisPct null (honest, not 0)', async () => {
    _routes.set('premiumIndex?symbol=SOLUSDT', () => ({
      markPrice: '150', lastFundingRate: '0.0001',
    }));
    const out = await getPerpIntel('SOL');
    expect(out.ok).toBe(true);
    expect(out.markPrice).toBe(150);
    expect(out.indexPrice).toBeNull();
    expect(out.basisPct).toBeNull();
    const wire = perpIntelWire(out);
    expect(wire.basisPct).toBeNull();
  });

  it('batch returns already-cached values within the deadline', async () => {
    __seedPerpIntelForTests('BTC', {
      ok: true, base: 'BTC', pair: 'BTCUSDT', at: Date.now(),
      markPrice: 60000, indexPrice: 59900, basisPct: 0.17, fundingBps8h: 1,
      topLongShortRatio: 1.4,
    });
    _routes.set('premiumIndex?symbol=ETHUSDT', () => new Promise(() => { /* slow feed */ }));
    const t0 = Date.now();
    const map = await getPerpIntelFor(['BTC', 'ETH'], 40);
    const elapsed = Date.now() - t0;
    expect(elapsed).toBeLessThan(500);
    expect(map.has('BTC')).toBe(true);
    expect(map.get('BTC')?.basisPct).toBeCloseTo(0.17, 5);
    expect(map.has('ETH')).toBe(false);
  });

  it('deadline-bounded batch never hangs even with no cache', async () => {
    _routes.set('premiumIndex?symbol=XRPUSDT', () => new Promise(() => { /* slow feed */ }));
    const t0 = Date.now();
    const map = await getPerpIntelFor(['XRP'], 30);
    expect(Date.now() - t0).toBeLessThan(500);
    expect(map.size).toBe(0);
  });
});

describe('v21.30.0 S4 — auto-tick enrichment pins', () => {
  const root = process.cwd();
  const autoSrc = fs.readFileSync(path.join(root, 'server/ai/mtfAutoLink.js'), 'utf8');

  it('batch is fetched before the guard ladder with a hard deadline', () => {
    expect(autoSrc).toContain("import { getPerpIntelFor, perpIntelEnabled } from './perpIntel.js';");
    expect(autoSrc).toContain('getPerpIntelFor(perpBases, 1500)');
    expect(autoSrc.indexOf('getPerpIntelFor(perpBases')).toBeLessThan(autoSrc.indexOf('evaluateEntryGuards({'));
  });

  it('kill switch (AI_DISABLE_PERP_INTEL) prevents the network call', () => {
    expect(autoSrc).toContain('perpBases.length > 0 && perpIntelEnabled()');
  });

  it('rows are enriched with funding / ratio / basis + explicit dataStatus', () => {
    expect(autoSrc).toContain('fundingBps8h: perpIntel.fundingBps8h ?? null');
    expect(autoSrc).toContain('longShortRatio: perpIntel.topLongShortRatio ?? null');
    expect(autoSrc).toContain('basisPct: perpIntel.basisPct ?? null');
    expect(autoSrc).toContain("perp: 'ok'");
    expect(autoSrc).toContain("perp: isPerpRow ? (perpIntelMap ? 'unavailable' : 'not-requested') : 'not-applicable'");
    expect(autoSrc).toContain('row: { ...guardRow, execMarket: guardDesk }');
  });

  it('coverage telemetry counts candidates / enriched / per-field', () => {
    expect(autoSrc).toContain('out.perpCoverage = {');
    expect(autoSrc).toContain('byField: { funding: 0, positioning: 0, basis: 0 }');
    expect(autoSrc).toContain('out.perpCoverage.enriched += 1');
    expect(autoSrc).toContain('out.perpCoverage.byField.basis += 1');
  });
});
