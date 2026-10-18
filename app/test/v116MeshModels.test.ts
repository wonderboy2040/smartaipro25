// ============================================================
// test/v116MeshModels.test.ts — v11.6 MESH-BACKED ENSEMBLE SEATS
// ------------------------------------------------------------
// Locks the four phases of the Superintelligence MCP upgrade:
//
//   Phase 1A — the registry: 4 new seats appear behind
//              AI_ENABLE_MESH_MODELS (flag OFF = byte-identical
//              legacy board; flag ON = 18-model committee).
//   Phase 1B — the honesty gate: stale-tagged mesh data, over-age
//              data, mesh gaps and cold caches all ABSTAIN with
//              reasons — a mesh seat never votes on stale data.
//   Phase 1C — the false-diversity guard: a seat whose recorded
//              votes correlate >0.85 with TrendMatrix/MomentumQuant
//              gets its weight halved; <20 overlapping votes refuses
//              to discount on noise.
//   Phase 2  — shadow-mode proving: fresh ledger → weight 0 +
//              journaled votes; 10 settled outcomes with a positive
//              when-voted vs when-abstained edge → promoted; no
//              edge → stays shadow; deep negative edge → retired.
//   Phase 3  — budget-aware warm: per-(cap,symbol) cadence guard
//              means a second immediate warm issues ZERO new mesh
//              queries; the per-tick batch is capped.
//   Phase 4  — the measurement layer: meshModelWeek /
//              meshModelAccountability / meshCorrelationView shapes
//              (what /api/ai/trust + weekly review render).
//
// Hermetic: the mesh itself is MOCKED (meshQuery) — the mesh's own
// suite covers its internals; fetch is stubbed offline anyway.
// ============================================================
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// hermetic data dir (ledger writes land here)
process.env.SMARTAI_DATA_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '../.test-data-v116mm');

// every raw network call → OFFLINE
vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline (test)'); }));

// ---- the mesh is mocked: controllable query surface ----
const { meshQueryMock } = vi.hoisted(() => ({ meshQueryMock: vi.fn() }));
vi.mock('../server/mcp/mesh.js', () => ({
  meshQuery: meshQueryMock,
  CAP_TIERS: { hot: 30_000, warm: 300_000, cold: 3_600_000 },
  MESH_TIMEOUT_MS: 8000,
}));

const {
  MESH_MODEL_IDS, MESH_MODEL_SEATS, meshModelsEnabled,
  instFlowProVote, techConsensusVote, fundaProPlusVote, cryptoOnChainProVote,
  applyMeshModelGating, meshModelAccountability, meshCorrelationView,
  meshModelWeek, meshModelsStatusView, warmMeshModels,
  __resetMeshModelsForTests, __setWarmedCapForTests, __testables,
} = await import('../server/ai/meshModels.js');

const { __setLedgerForTests, __ledgerRaw, recordExecution } = await import('../server/ai/ledger.js');
const { aggregateVotes } = await import('../server/ai/ensemble.js');

beforeEach(() => {
  __setLedgerForTests(null);
  __resetMeshModelsForTests();
  // v21.11: production default ab ON hai — 'flag OFF' legacy behaviour ke
  // liye explicit 'false' (delete karne se naya default true aa jata)
  process.env.AI_ENABLE_MESH_MODELS = 'false';
  meshQueryMock.mockReset();
  meshQueryMock.mockImplementation(async ({ capabilities }: { capabilities: string[] }) => {
    const cap = capabilities[0];
    const data = cap === 'news.sentiment'
      ? { items: [{ symbol: 'AAPL', sentiment: 'bull' }, { symbol: 'AAPL', sentiment: 'bull' }] }
      : { ok: 1 };
    return { ok: true, results: { [cap]: { data, agent: 'testagent', ts: Date.now(), stale: false } }, gaps: [], meta: {} };
  });
});

// ---------------- Phase 1A: registry ----------------
describe('v11.6 Phase 1A — registry seats behind AI_ENABLE_MESH_MODELS', () => {
  it('flag OFF → zero mesh seats (byte-identical legacy board)', async () => {
    vi.resetModules();
    const { MODELS } = await import('../server/ai/models.js');
    const meshSeats = MODELS.filter(m => (MESH_MODEL_IDS as string[]).includes(m.id));
    expect(meshSeats).toHaveLength(0);
    expect(meshModelsEnabled()).toBe(false);
  });

  it('flag ON → the 4 seats with their honest starting weights', async () => {
    process.env.AI_ENABLE_MESH_MODELS = 'true';
    vi.resetModules();
    const { MODELS } = await import('../server/ai/models.js');
    const seats = MODELS.filter(m => (MESH_MODEL_IDS as string[]).includes(m.id));
    expect(seats.map(s => s.id).sort()).toEqual(['cryptoonchain', 'fundaproplus', 'instflowpro', 'techconsensus']);
    const byId = Object.fromEntries(seats.map(s => [s.id, s]));
    expect(byId.instflowpro.weight).toBe(0.8);
    expect(byId.techconsensus.weight).toBe(0.7);
    expect(byId.fundaproplus.weight).toBe(0.55);
    expect(byId.cryptoonchain.weight).toBe(0.6);
    for (const s of seats) expect(typeof s.fn).toBe('function');
    // the seats follow the proven V2 pattern exactly: {dir, conf, reasons}
    for (const s of seats) {
      const v = (s.fn as (c: unknown) => { dir: number; conf: number; reasons: string[] })({ market: 'INDIA', symbol: 'X' });
      expect(v).toHaveProperty('dir');
      expect(v).toHaveProperty('conf');
      expect(Array.isArray(v.reasons)).toBe(true);
    }
  });

  it('seat table declares the mesh caps + served markets', () => {
    const ids = MESH_MODEL_SEATS.map(s => s.id);
    expect(ids).toHaveLength(4);
    const ifp = MESH_MODEL_SEATS.find(s => s.id === 'instflowpro')!;
    expect(ifp.caps).toEqual(['altdata.congress', 'altdata.insider']);
    expect(ifp.markets).toEqual(['GLOBALFUTURES']);
    const cop = MESH_MODEL_SEATS.find(s => s.id === 'cryptoonchain')!;
    expect(cop.markets).toEqual(['CRYPTO', 'FUTURES']);
  });
});

// ---------------- Phase 1B: the honesty gate ----------------
describe('v11.6 Phase 1B — honesty gate (stale data NEVER votes)', () => {
  it('mesh stale-while-revalidate tag → abstain, reason says STALE', () => {
    __setWarmedCapForTests('GLOBALFUTURES', 'AAPL', 'altdata.congress', {
      data: { trades: [{ transaction: 'Buy', daysAgo: 2 }, { transaction: 'Buy', daysAgo: 4 }] },
      stale: true,
    });
    __setWarmedCapForTests('GLOBALFUTURES', 'AAPL', 'altdata.insider', {
      data: { transactions: [{ transaction: 'Buy', daysAgo: 1 }] },
      stale: true,
    });
    const v = instFlowProVote({ market: 'GLOBALFUTURES', symbol: 'AAPL' });
    expect(v.dir).toBe(0);
    expect(v.conf).toBe(0);
    expect(v.reasons.join(' ')).toMatch(/STALE/i);
  });

  it('over-age data (past the cap-class staleness cap) → abstain', () => {
    // crypto.onchain cap = 2h; 3h-old data must not vote
    __setWarmedCapForTests('CRYPTO', 'BTC', 'crypto.onchain', {
      data: { athChangePct: -3, developer: { lastCommitDays: 2 } },
    }, 3 * 60 * 60_000);
    __setWarmedCapForTests('CRYPTO', 'BTC', 'crypto.tick', null); // unwarmed
    const v = cryptoOnChainProVote({ market: 'CRYPTO', symbol: 'BTC' });
    expect(v.dir).toBe(0);
    expect(v.reasons.join(' ')).toMatch(/honesty gate|abstain/i);
  });

  it('mesh gap (budget-exhausted / breaker-open agent) → abstain, reason visible', () => {
    __setWarmedCapForTests('GLOBALFUTURES', 'NVDA', 'news.sentiment', { ok: false, reason: 'all-agents-failed' });
    const v = techConsensusVote({ market: 'GLOBALFUTURES', symbol: 'NVDA' });
    expect(v.dir).toBe(0);
    expect(v.reasons.join(' ')).toMatch(/unavailable.*budget-exhausted|all-agents-failed/i);
  });

  it('cold cache (never warmed) → honest abstain, never an invented number', () => {
    const v = fundaProPlusVote({ market: 'INDIA', symbol: 'RELIANCE' });
    expect(v.dir).toBe(0);
    expect(v.conf).toBe(0);
    expect(v.reasons.join(' ')).toMatch(/not warmed|abstain/i);
  });
});

// ---------------- vote correctness (fresh mesh data DOES vote) ----------------
describe('v11.6 — the four seats vote on fresh, honest mesh data', () => {
  it('InstFlowPro: congressional + insider buying → LONG (recency-weighted)', () => {
    __setWarmedCapForTests('GLOBALFUTURES', 'AAPL', 'altdata.congress', {
      data: { trades: [
        { transaction: 'Buy', daysAgo: 5 }, { transaction: 'Buy', daysAgo: 10 },
        { transaction: 'Buy', daysAgo: 2 }, { transaction: 'Sell', daysAgo: 40 },
      ] },
    });
    __setWarmedCapForTests('GLOBALFUTURES', 'AAPL', 'altdata.insider', {
      data: { transactions: [{ transaction: 'Buy', daysAgo: 3 }, { transaction: 'Buy', daysAgo: 8 }] },
    });
    const v = instFlowProVote({ market: 'GLOBALFUTURES', symbol: 'AAPL' });
    expect(v.dir).toBe(1);
    expect(v.conf).toBeGreaterThanOrEqual(42);
    expect(v.conf).toBeLessThanOrEqual(60); // honest alt-data range
    expect(v.reasons.join(' ')).toMatch(/Congress flow/i);
  });

  it('InstFlowPro abstains off the global desk (Quiver = US tickers only)', () => {
    const v = instFlowProVote({ market: 'INDIA', symbol: 'RELIANCE' });
    expect(v.dir).toBe(0);
    expect(v.reasons.join(' ')).toMatch(/abstains/i);
  });

  it('TechConsensus: independent bull read → LONG', () => {
    __setWarmedCapForTests('GLOBALFUTURES', 'NVDA', 'news.sentiment', {
      data: { items: [
        { symbol: 'NVDA', sentiment: 'bull' }, { symbol: 'NVDA', sentiment: 'bull' },
        { symbol: 'NVDA', sentiment: 'bull' }, { symbol: 'NVDA', sentiment: 'bear' },
      ] },
    });
    const v = techConsensusVote({ market: 'GLOBALFUTURES', symbol: 'NVDA' });
    expect(v.dir).toBe(1);
    expect(v.reasons.join(' ')).toMatch(/Independent vendor consensus/i);
  });

  it('TechConsensus: split read (no consensus edge) → abstain', () => {
    __setWarmedCapForTests('GLOBALFUTURES', 'NVDA', 'news.sentiment', {
      data: { items: [{ symbol: 'NVDA', sentiment: 'bull' }, { symbol: 'NVDA', sentiment: 'bear' }] },
    });
    const v = techConsensusVote({ market: 'GLOBALFUTURES', symbol: 'NVDA' });
    expect(v.dir).toBe(0);
    expect(v.reasons.join(' ')).toMatch(/split|abstain/i);
  });

  it('FundaProPlus: forward P/E < trailing + strong margin → LONG', () => {
    __setWarmedCapForTests('INDIA', 'RELIANCE', 'stocks.fundamentals', {
      data: { peRatio: 25, forwardPE: 20, profitMargin: 0.2, beta: 1.1 },
    });
    __setWarmedCapForTests('INDIA', 'RELIANCE', 'fundamentals.profile', {
      data: { peRatio: 26, sector: 'Energy' },
    });
    const v = fundaProPlusVote({ market: 'INDIA', symbol: 'RELIANCE' });
    expect(v.dir).toBe(1);
    expect(v.conf).toBeLessThanOrEqual(55); // slow context, never a loud vote
    expect(v.reasons.join(' ')).toMatch(/earnings expected to GROW/i);
  });

  it('FundaProPlus abstains on the crypto desks', () => {
    const v = fundaProPlusVote({ market: 'CRYPTO', symbol: 'BTC' });
    expect(v.dir).toBe(0);
  });

  it('CryptoOnChainPro: near ATH + alive repo + buy-aggressive ticks → LONG', () => {
    __setWarmedCapForTests('CRYPTO', 'BTC', 'crypto.onchain', {
      data: {
        athChangePct: -5, totalVolumeUsd: 5e10,
        developer: { lastCommitDays: 3, stars: 4000 },
        community: { twitterFollowers: 900000 },
      },
    });
    __setWarmedCapForTests('CRYPTO', 'BTC', 'crypto.tick', {
      data: { trades: [{ price: 100 }, { price: 100.1 }, { price: 100.5 }, { price: 100.6 }] },
    });
    const v = cryptoOnChainProVote({ market: 'CRYPTO', symbol: 'BTC' });
    expect(v.dir).toBe(1);
    expect(v.reasons.join(' ')).toMatch(/repo ALIVE/i);
    expect(v.reasons.join(' ')).toMatch(/buy aggression/i);
  });

  it('CryptoOnChainPro abstains on the equity desks', () => {
    const v = cryptoOnChainProVote({ market: 'GLOBALFUTURES', symbol: 'AAPL' });
    expect(v.dir).toBe(0);
  });
});

// ---------------- Phase 2: shadow-mode + promotion ----------------
describe('v11.6 Phase 2 — shadow-mode proving (weight earned, never assumed)', () => {
  const VOTE = (id: string, dir = 1) => ({ id, name: id, weight: 0.6, dir, conf: 50, reasons: ['t'] });

  it('fresh ledger → every mesh seat votes SHADOW (weight 0, journaled, no influence)', () => {
    process.env.AI_ENABLE_MESH_MODELS = 'true';
    const votes = MESH_MODEL_IDS.map(id => VOTE(id));
    const gated = applyMeshModelGating(votes);
    for (const v of gated) {
      expect(v.weight).toBe(0);
      expect(v.shadow).toBe(true);
      expect(v.meshMode).toBe('shadow');
    }
    // the committee verdict is UNCHANGED by shadow votes (aggregateVotes
    // ignores weight-0 rows — the entry decision never sees them)
    const base = [VOTE('trend'), VOTE('momentum')];
    expect(aggregateVotes([...base]).confidence).toBe(aggregateVotes([...base, ...votes]).confidence);
  });

  it('shadow votes are still JOURNALED by recordExecution (the proving data)', () => {
    const shadowVote = { ...VOTE('cryptoonchain'), weight: 0, shadow: true };
    const e = recordExecution({
      symbol: 'BTC', market: 'CRYPTO', side: 'LONG', grade: 'ACTION', confidence: 60,
      votes: [VOTE('trend'), shadowVote],
    }, { mode: 'paper' });
    expect(e).toBeTruthy();
    expect(e.votes.cryptoonchain).toEqual({ dir: 1, conf: 50 });
    expect(e.votes.trend).toEqual({ dir: 1, conf: 50 });
  });

  it('10 settled outcomes with a positive edge → PROMOTED to voting weight', () => {
    process.env.AI_ENABLE_MESH_MODELS = 'true';
    // 10 wins where cryptoonchain voted LONG on LONG trades +
    // 2 losses where it abstained → whenVoted 100% vs whenAbstained 0%
    const entries = [];
    for (let i = 0; i < 10; i++) {
      entries.push({
        id: `w${i}`, ts: Date.now() - i * 1000, market: 'CRYPTO', symbol: 'BTC', side: 'LONG',
        votes: { trend: { dir: 1, conf: 50 }, cryptoonchain: { dir: 1, conf: 50 } },
        outcome: { ts: Date.now() - i * 500, r: 1.5, pnlINR: 100 },
      });
    }
    for (let i = 0; i < 2; i++) {
      entries.push({
        id: `l${i}`, ts: Date.now() - i * 1000, market: 'CRYPTO', symbol: 'ETH', side: 'LONG',
        votes: { trend: { dir: 1, conf: 50 } },
        outcome: { ts: Date.now() - i * 500, r: -1, pnlINR: -50 },
      });
    }
    __setLedgerForTests({ entries });

    const acc = meshModelAccountability();
    const co = acc.models.find(m => m.id === 'cryptoonchain')!;
    expect(co.n).toBe(10);
    expect(co.mode).toBe('voting');
    expect(co.edge).toBe(100);
    expect(co.effectiveWeight).toBe(co.baseWeight);

    // the gated vote now carries real weight
    const gated = applyMeshModelGating([VOTE('cryptoonchain')]);
    expect(gated[0].weight).toBe(0.6);
    expect(gated[0].meshMode).toBe('voting');
    expect(gated[0].shadow).toBeUndefined();
  });

  it('no measurable edge → stays shadow (more data ≠ better signals)', () => {
    process.env.AI_ENABLE_MESH_MODELS = 'true';
    const entries = [];
    // 6 wins / 4 losses where it voted (60%) vs 10/10 wins when it abstained (100%) → edge -40
    for (let i = 0; i < 10; i++) {
      const win = i < 6;
      entries.push({
        id: `v${i}`, ts: Date.now() - i * 1000, market: 'CRYPTO', symbol: 'BTC', side: 'LONG',
        votes: { cryptoonchain: { dir: 1, conf: 50 } },
        outcome: { ts: Date.now(), r: win ? 1 : -1 },
      });
    }
    for (let i = 0; i < 10; i++) {
      entries.push({
        id: `a${i}`, ts: Date.now() - i * 1000, market: 'CRYPTO', symbol: 'ETH', side: 'LONG',
        votes: {},
        outcome: { ts: Date.now(), r: 1 },
      });
    }
    __setLedgerForTests({ entries });
    const acc = meshModelAccountability();
    const co = acc.models.find(m => m.id === 'cryptoonchain')!;
    expect(co.n).toBe(10);
    expect(co.mode).toBe('shadow');
    expect(co.effectiveWeight).toBe(0);
  });

  it('deep negative edge at n≥30 → RETIRED', () => {
    process.env.AI_ENABLE_MESH_MODELS = 'true';
    const entries = [];
    // 30 voted entries: 10 wins / 20 losses (33%) vs abstained 100% → edge -66.7
    for (let i = 0; i < 30; i++) {
      const win = i < 10;
      entries.push({
        id: `v${i}`, ts: Date.now() - i * 1000, market: 'CRYPTO', symbol: 'BTC', side: 'LONG',
        votes: { cryptoonchain: { dir: 1, conf: 50 } },
        outcome: { ts: Date.now(), r: win ? 1 : -1 },
      });
    }
    for (let i = 0; i < 4; i++) {
      entries.push({
        id: `a${i}`, ts: Date.now() - i * 1000, market: 'CRYPTO', symbol: 'ETH', side: 'LONG',
        votes: {},
        outcome: { ts: Date.now(), r: 1 },
      });
    }
    __setLedgerForTests({ entries });
    const co = meshModelAccountability().models.find(m => m.id === 'cryptoonchain')!;
    expect(co.mode).toBe('retired');
    expect(co.effectiveWeight).toBe(0);
    const gated = applyMeshModelGating([VOTE('cryptoonchain')]);
    expect(gated[0].weight).toBe(0);
    expect(gated[0].meshMode).toBe('retired');
  });

  it('flag OFF → applyMeshModelGating is a no-op (A/B safety)', () => {
    // v21.11: explicit 'false' — production default ab ON hai
    process.env.AI_ENABLE_MESH_MODELS = 'false';
    const votes = [VOTE('cryptoonchain')];
    expect(applyMeshModelGating(votes)).toBe(votes);
  });
});

// ---------------- Phase 1C: cross-correlation guard ----------------
describe('v11.6 Phase 1C — false-diversity correlation guard', () => {
  const entry = (id: string, meshDir: number, refDir: number, win = true) => ({
    id, ts: Date.now(), market: 'CRYPTO', symbol: 'BTC', side: refDir > 0 ? 'LONG' : 'SHORT',
    votes: { trend: { dir: refDir, conf: 50 }, techconsensus: { dir: meshDir, conf: 50 } },
    outcome: { ts: Date.now(), r: win ? 1 : -1 },
  });

  it('corr 1.0 vs TrendMatrix over 20+ entries → weight ×0.5 (redundant restatement)', () => {
    const entries = [];
    for (let i = 0; i < 24; i++) entries.push(entry(`e${i}`, i % 3 === 0 ? 1 : -1, i % 3 === 0 ? 1 : -1)); // identical dirs
    __setLedgerForTests({ entries });
    const view = meshCorrelationView();
    const tc = view.seats.techconsensus;
    expect(tc.corr).toBeGreaterThan(0.85);
    expect(tc.discount).toBe(0.5);
    expect(tc.verdict).toBe('redundant');
  });

  it('corr 0.7-0.85 → weight ×0.75', () => {
    // 22 pairs, both series varying: 10 (1,1) + 10 (-1,-1) + 1 (1,-1) + 1 (-1,1)
    // → pearson = (20−2)/22 = 0.818 — inside the soft band
    const pairs: [number, number][] = [];
    for (let i = 0; i < 10; i++) pairs.push([1, 1]);
    for (let i = 0; i < 10; i++) pairs.push([-1, -1]);
    pairs.push([1, -1], [-1, 1]);
    const entries = pairs.map(([md, rd], i) => entry(`e${i}`, md, rd));
    __setLedgerForTests({ entries });
    const tc = meshCorrelationView().seats.techconsensus;
    expect(tc.corr).toBeGreaterThan(0.7);
    expect(tc.corr).toBeLessThanOrEqual(0.85);
    expect(tc.discount).toBe(0.75);
  });

  it('<20 overlapping votes → NO discount (refuse to tune on noise)', () => {
    const entries = [];
    for (let i = 0; i < 12; i++) entries.push(entry(`e${i}`, 1, 1));
    __setLedgerForTests({ entries });
    const tc = meshCorrelationView().seats.techconsensus;
    expect(tc.discount).toBe(1);
    expect(tc.verdict).toBe('insufficient-overlap');
  });

  it('gating applies the discount to a PROMOTED seat (weight halved)', () => {
    process.env.AI_ENABLE_MESH_MODELS = 'true';
    const entries = [];
    // 24 VOTED entries (overlap 24 ≥ 20 → corr guard engages; tech dir
    // always == trend dir → corr 1.0 → ×0.5), 20 wins / 4 losses →
    // whenVotedWR 83.3%; plus 10 ABSTAINED entries 3W/7L → 30% → edge
    // +53.3 → promoted. Voting weight × 0.5 discount = 0.35.
    for (let i = 0; i < 24; i++) {
      const refDir = i % 2 === 0 ? 1 : -1;
      const win = i < 20;
      entries.push({
        id: `e${i}`, ts: Date.now() - i * 1000, market: 'CRYPTO', symbol: 'BTC',
        side: refDir > 0 ? 'LONG' : 'SHORT',
        votes: { trend: { dir: refDir, conf: 50 }, techconsensus: { dir: refDir, conf: 50 } },
        outcome: { ts: Date.now(), r: win ? 1 : -1 },
      });
    }
    for (let i = 0; i < 10; i++) {
      const win = i < 3;
      entries.push({
        id: `a${i}`, ts: Date.now() - i * 1000, market: 'CRYPTO', symbol: 'ETH', side: 'LONG',
        votes: { trend: { dir: 1, conf: 50 } },
        outcome: { ts: Date.now(), r: win ? 1 : -1 },
      });
    }
    __setLedgerForTests({ entries });
    const gated = applyMeshModelGating([{ id: 'techconsensus', name: 'TechConsensus', weight: 0.7, dir: 1, conf: 50, reasons: [] }]);
    expect(gated[0].meshMode).toBe('voting');
    expect(gated[0].weight).toBe(0.35); // 0.7 × 0.5
    expect(gated[0].corrDiscount).toBe(0.5);
  });
});

// ---------------- Phase 3: budget-aware warm ----------------
describe('v11.6 Phase 3 — T3-only, cadence-guarded warm', () => {
  it('warm issues at most BATCH_N mesh queries per tick (top-slice only)', async () => {
    // GLOBALFUTURES: 5 caps × 12 symbols = 60 needed pairs → batch cap 8
    await warmMeshModels('GLOBALFUTURES', ['AAPL', 'NVDA', 'MSFT', 'GOOGL', 'AMZN', 'TSLA', 'META', 'MU', 'INTC', 'AMD', 'QCOM', 'SPACEX']);
    expect(meshQueryMock).toHaveBeenCalledTimes(8);
    expect(meshQueryMock.mock.calls.every(c => Array.isArray(c[0]?.capabilities) && c[0].capabilities.length === 1)).toBe(true);
    // the warmed store served honest results
    const view = __testables._store.get('GLOBALFUTURES|AAPL');
    expect(view?.caps['news.sentiment']?.ok).toBe(true);
  });

  it('an immediate second warm issues ZERO new queries (cadence guard honors the cache tiers)', async () => {
    await warmMeshModels('CRYPTO', ['BTC', 'ETH']);
    const after = meshQueryMock.mock.calls.length;
    await warmMeshModels('CRYPTO', ['BTC', 'ETH']);
    expect(meshQueryMock.mock.calls.length).toBe(after);
  });

  it('mesh gap → honest {ok:false} in the store (the abstention the vote will show)', async () => {
    meshQueryMock.mockImplementationOnce(async () => ({ ok: false, results: {}, gaps: [{ cap: 'crypto.onchain', reason: 'all-agents-failed' }], meta: {} }));
    await warmMeshModels('CRYPTO', ['SOL']);
    const rec = __testables._store.get('CRYPTO|SOL');
    expect(rec?.caps['crypto.onchain']?.ok).toBe(false);
    expect(String(rec?.caps['crypto.onchain']?.reason)).toMatch(/all-agents-failed/);
    const v = cryptoOnChainProVote({ market: 'CRYPTO', symbol: 'SOL' });
    expect(v.dir).toBe(0);
  });

  it('warm never throws on a rejecting mesh (fire-and-forget safe)', async () => {
    meshQueryMock.mockRejectedValue(new Error('mesh exploded'));
    await expect(warmMeshModels('CRYPTO', ['DOGE'])).resolves.toBeUndefined();
  });

  it('India symbols get the .BSE suffix Alpha Vantage needs', async () => {
    await warmMeshModels('INDIA', ['RELIANCE']);
    const call = meshQueryMock.mock.calls.find((c: unknown[]) => (c[0] as { capabilities: string[] }).capabilities[0] === 'stocks.fundamentals');
    expect(call).toBeTruthy();
    expect((call![0] as { symbols: string[] }).symbols).toEqual(['RELIANCE.BSE']);
  });
});

// ---------------- Phase 4: the measurement layer ----------------
describe('v11.6 Phase 4 — accountability + weekly contribution views', () => {
  it('meshModelsStatusView carries seats + warm state (the /api/ai/status block)', () => {
    const view = meshModelsStatusView();
    expect(view.flag).toBe('AI_ENABLE_MESH_MODELS');
    expect(view.enabled).toBe(false);
    expect(view.seats.map(s => s.id)).toHaveLength(4);
    expect(view.seats.every(s => s.mode === 'shadow')).toBe(true); // fresh ledger
    expect(view.warm.requeryGaps).toEqual({ hot: '2min', warm: '30min', cold: '4h' });
  });

  it('meshModelWeek: this-week attribution + the all-time promotion math', () => {
    const now = Date.now();
    const entries = [];
    for (let i = 0; i < 6; i++) {
      entries.push({
        id: `wk${i}`, ts: now - i * 3600_000, market: 'CRYPTO', symbol: 'BTC', side: 'LONG',
        votes: { cryptoonchain: { dir: 1, conf: 50 } },
        outcome: { ts: now - i * 3600_000 + 600_000, r: i < 5 ? 1 : -1 },
      });
    }
    __setLedgerForTests({ entries });
    const week = meshModelWeek({ now });
    expect(week.week.cryptoonchain.n).toBe(6);
    expect(week.week.cryptoonchain.hitRate).toBe(83.3);
    expect(week.allTime.models.find((m: { id: string }) => m.id === 'cryptoonchain')?.n).toBe(6);
    // the note answers the plan's exact question honestly
    expect(week.note).toMatch(/did adding|contribution|honest/i);
  });

  it('accountability refuses to invent numbers on an empty ledger', () => {
    const acc = meshModelAccountability();
    expect(acc.settledTotal).toBe(0);
    for (const m of acc.models) {
      expect(m.n).toBe(0);
      expect(m.hitRate).toBeNull();
      expect(m.edge).toBeNull();
      expect(m.mode).toBe('shadow');
    }
  });
});
