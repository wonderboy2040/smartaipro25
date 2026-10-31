import '@testing-library/jest-dom';
import path from 'node:path';
import os from 'node:os';
import { mkdtempSync } from 'node:fs';

// ============================================================
// v20.3 TEST-INFRA HYGIENE: one hermetic data dir for EVERY suite.
// ------------------------------------------------------------
// 8 test files (futures, mandateFreeze, trailing, v70-pro-trader,
// aiSecrets, agent, indiaAgent, clearClosedPositions) imported the
// real store WITHOUT an override — running the suite ERASED the
// developer's live server/data journal/config on every run (and that
// polluted state then shipped inside the v20.2 zip). store.js honors
// SMARTAI_DATA_DIR; setting it HERE (before any test imports a server
// module) makes every suite hermetic by default. Per-file overrides
// (the 28 that already set their own) keep winning — they set the env
// before THEY import the store.
// ============================================================
if (!process.env.SMARTAI_DATA_DIR) {
  try {
    process.env.SMARTAI_DATA_DIR = mkdtempSync(path.join(os.tmpdir(), 'smartai-test-data-'));
  } catch { /* best-effort: fall back to default resolution */ }
}

// ============================================================
// v21.24.0 TEST-INFRA HYGIENE (MTF AUTO): mtfAutoLink ka apna
// MTF_AUTO_DATA_DIR override hai — SMARTAI_DATA_DIR isse nahi bachata.
// siteRecheck212312/212313 + directionConflict jaise suites
// __resetMtfAutoForTests() real server/data par chala kar LIVE book
// (open XRP position) aur Phase 0 config WIPE kar dete the. Har suite
// ke liye hermetic default; per-file overrides (jo apna env set karte
// hain) pehle ki tarah jeet-te hain.
// ============================================================
if (!process.env.MTF_AUTO_DATA_DIR) {
  try {
    process.env.MTF_AUTO_DATA_DIR = mkdtempSync(path.join(os.tmpdir(), 'smartai-test-mtf-'));
  } catch { /* best-effort: fall back to default resolution */ }
}

// ============================================================
// v21.11 TEST-STABILITY PIN: Superintelligence accuracy suite ab
// PRODUCTION DEFAULT ON hai (AI_ENABLE_V2_MODELS / MESH / MTF —
// models.js + meshModels.js). Saare legacy suites (202 files) in
// flags ke unset-default-off assumption pe likhe gaye the — unhe
// yahan explicit 'false' pin karke byte-identical behaviour milta
// hai. Naya default `test/v2111SuperIntelUpgrade.test.ts` me
// subprocess-spawn se test hota hai (env sanitize karke).
// Files jo khud flag set/delete karti hain (v116MeshModels,
// v2Models, mtfAB, intradayMtfConfluence, v118FullCommittee) apne
// value ke saath jeetti hain — ??= sirf unset case pe lagta hai.
// ============================================================
process.env.AI_ENABLE_V2_MODELS ??= 'false';
process.env.AI_ENABLE_MESH_MODELS ??= 'false';
process.env.AI_ENABLE_MTF_CONFLUENCE ??= 'false';

// ============================================================
// v21.12 TEST-STABILITY PIN (master switch): AI_ACCURACY_SUITE ab
// DEFAULT ON hai aur uske ON hone par upar wale teeno legacy pins
// IGNORED ho jaate hain — isliye legacy suites ke liye MASTER ko
// bhi explicit 'false' pin karna zaroori hai (warna 202 files
// phir se 20-seat registry dekh lenge). AI_ENABLE_META_ENSEMBLE
// bhi v21.12 se DEFAULT ON hai — aggregateVotesWithMeta callers
// (v2094 etc.) 'flag OFF by default in test env' assumption pe
// likhe hain. Naye defaults `test/v2112MasterSwitch.test.ts` +
// updated v2111 suite me subprocess-se test hote hain.
// ============================================================
process.env.AI_ACCURACY_SUITE ??= 'false';
process.env.AI_ENABLE_META_ENSEMBLE ??= 'false';

// ============================================================
// v21.30.0 TEST-STABILITY PIN (external feeds): the S4 perp enrichment
// calls Binance fapi on every crypto tick. A test gate must never depend
// on the live network (unreliable + it overwrote deterministic fixture
// values such as context.fundingBps8h). Pin the kill switch here; the
// perpIntel suites call getPerpIntel() directly with a mocked fetch and
// are unaffected. Production default remains ON.
// ============================================================
process.env.AI_DISABLE_PERP_INTEL ??= 'true';

// ============================================================
// v21.11 TEST-LEAK CLEANUP (permanent) — 34 suites app/ root me
// `.test-data-*` dirs chhod jaati thi (user ke box pe 15 dirs / 260KB
// junk jam gaya tha). vitest 4 me globalTeardown option nahi hai, isliye
// setup-file ka afterAll use hota hai — har test FILE ke baad LIFO me
// chalta hai (file ke apne afterAll pehle, ye cleanup sabse aakhri me).
// fileParallelism:false hai — koi concurrent file apna dir use nahi kar
// raha hota cleanup ke waqt.
// v21.12 FIX: `path` duplicate-import + `afterAll` bina-import (v21.11
// leak-cleanup block ke saath aaya, typecheck us waqt re-run nahi hua).
// ============================================================
import { readdirSync, rmSync } from 'node:fs';
import { afterAll } from 'vitest';

afterAll(() => {
  try {
    for (const name of readdirSync(process.cwd())) {
      if (name.startsWith('.test-data-')) {
        try {
          rmSync(path.join(process.cwd(), name), { recursive: true, force: true });
        } catch { /* never fail the suite on cleanup */ }
      }
    }
  } catch { /* cwd unreadable — skip */ }
});
