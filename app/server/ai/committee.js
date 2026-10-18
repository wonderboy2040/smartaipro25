// ============================================================
// server/ai/committee.js — v21.12.0 COMMITTEE VISIBILITY
// ------------------------------------------------------------
// USER REPORT: "sirf 13 models hi bata raha hai 16 models nhi" —
// user ko site par committee ka ASLI composition dikhna chahiye
// (voting seats / mesh shadow / tape weight / learning window /
// META armed) taaki "kitne models chal rahe hain" kabhi andhera
// na rahe. Ye module EK source-of-truth snapshot banata hai jo:
//   • boot banner (server console) — supervisor/watchdog logs me
//   • agent accuracy payloads (AgentPanel chip) — UI me
//   • /health (ops endpoint) — dashboards me
// sab jagah SAME numbers dikhata hai.
// ============================================================
import { MODELS, v2ModelsEnabled, mtfConfluenceEnabled } from './models.js';
import { meshModelsEnabled, MESH_MODEL_IDS } from './meshModels.js';
import { metaEnsembleEnabled, metaServiceUrl } from './ensemble.js';
import { ledgerWindowEntries } from './ledger.js';
import { accuracySuiteEnabled } from './accuracySuite.js';

/** Committee composition snapshot — pure, cheap, no IO. */
export function committeeInfo() {
  // Registry me aicouncil (LLM seat) bhi voting hota hai (w 1.5); mesh
  // seats registry weight rakhte hain par applyMeshModelGating unhe
  // shadow (effective 0) rakhta hai jab tak accountability promote na
  // kare — isliye shadow count = registry me present mesh seats.
  const meshOn = meshModelsEnabled();
  const shadow = meshOn ? MESH_MODEL_IDS.length : 0;
  const total = MODELS.length;
  const voting = Math.max(0, total - shadow);
  const tape = MODELS.find((m) => m.id === 'tape-mtf' || m.id === 'tape') || null;
  return {
    total,
    voting,
    shadow,
    tapeSeat: tape ? tape.id : null,
    tapeWeight: tape ? tape.weight : null,
    learningWindow: ledgerWindowEntries(),
    accuracySuite: accuracySuiteEnabled(),
    v2Models: v2ModelsEnabled(),
    mtfConfluence: mtfConfluenceEnabled(),
    meshModels: meshOn,
    meta: {
      enabled: metaEnsembleEnabled(),
      serviceUrl: metaServiceUrl(),
    },
  };
}

/** One-line boot banner (Hinglish, watchdog log style). */
export function committeeBanner(info = committeeInfo()) {
  const seats = `${info.voting} voting + ${info.shadow} mesh shadow`;
  const tape = info.tapeSeat === 'tape-mtf'
    ? `tape-MTF w${info.tapeWeight}`
    : `tape w${info.tapeWeight} (legacy)`;
  const meta = info.meta.enabled
    ? `META ARMED (${info.meta.serviceUrl})`
    : 'META OFF';
  const mode = info.accuracySuite ? 'accuracy-suite ON' : 'LEGACY A/B mode';
  return `[superintel] 🧬 committee: ${seats} · ${tape} · window ${info.learningWindow} · ${meta} · ${mode}`;
}
