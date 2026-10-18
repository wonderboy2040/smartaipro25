// ============================================================
// server/ai/accuracySuite.js — v21.12.0 MASTER ACCURACY SWITCH
// ------------------------------------------------------------
// USER REPORT (the "sirf 13 models dikha raha hai" bug):
// v21.11.0 ne teeno seat-flags (V2 / MTF / MESH) ka code-default
// ON kiya tha — par "explicit env value hamesha jeet-ta hai" waale
// semantics ki wajah se ek STALE .env (jin boxes ne kabhi A/B ke
// liye AI_ENABLE_V2_MODELS=false likha tha, ya purani install ka
// .env jisme ye keys galat spell/false padi thi) apne box ko
// hamesha 13-seat plain board pe pin kar deta tha. User ko ye
// "bug" lagta hai — aur hai bhi: shipped intent (16 voting + 4
// mesh shadow) ko ek purani config line override kar leti thi.
//
// v21.12.0 SEMANTICS — ek master switch, stale configs ke liye
// bulletproof:
//   • AI_ACCURACY_SUITE unset/empty (DEFAULT) → pura suite ON.
//     Teenon LEGACY per-flag env values (AI_ENABLE_V2_MODELS /
//     AI_ENABLE_MTF_CONFLUENCE / AI_ENABLE_MESH_MODELS) IGNORED
//     hote hain — chahe kuch bhi pade ho. 16 voting + 4 shadow
//     GUARANTEED out-of-the-box.
//   • AI_ACCURACY_SUITE=false → LEGACY A/B mode: teeno per-flag
//     env vars wapas apna purana semantics chalate hain (false =
//     13-seat board). Ye ek HI documented rollback path hai.
//
// Kyunki ye module leaf hai (kuch import nahi karta), ise models.js
// + meshModels.js dono bina cycle ke import kar sakte hain.
// ============================================================

const TRUTHY = ['true', '1', 'on', 'yes'];

/** Master switch — default ON. SIRF explicit OFF-spellings (false/0/off/no)
 *  legacy A/B mode kholti hain; koi bhi aur value (garbage/typo jaise
 *  'ture') ON hi treat hoti hai — typo se user ka box kabhi wapas
 *  13-seat board pe nahi girega. */
export function accuracySuiteEnabled() {
  const raw = String(process.env.AI_ACCURACY_SUITE ?? '').trim().toLowerCase();
  if (['false', '0', 'off', 'no'].includes(raw)) return false; // explicit rollback
  return true; // empty / true / garbage — shipped intent = ON
}

/** Legacy per-flag resolution — SIRF tab meaningful jab master OFF ho.
 *  Yeh wahi v9.x semantics hai jo v21.11 se pehle chal rahe the. */
export function legacyFlagEnabled(name) {
  const raw = String(process.env[name] ?? '').trim().toLowerCase();
  if (!raw) return false; // legacy default OFF (A/B gate era)
  return TRUTHY.includes(raw);
}
