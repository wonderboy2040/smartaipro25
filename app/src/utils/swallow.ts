// ============================================================
// utils/swallow — explicit silent-catch helper (v21.1.0, Phase-1.4)
// ------------------------------------------------------------
// Pehle 16 jagah `} catch {}` empty blocks the (api.ts / db.ts /
// secureStorage.ts) — failures completely invisible thi. Ye helper
// BEHAVIOUR SAME rakhta hai (kabhi rethrow nahi, return value nahi
// badalta) — bas dev mode me console.debug karke dikha deta hai ki
// kya fail hua tha. Production build me `import.meta.env.DEV` false
// ho jata hai, to zero runtime cost.
//
// USAGE:
//   import { swallow } from '../utils/swallow';
//   try { localStorage.setItem(k, v); }
//   catch (err) { swallow('secureStorage.setItem', err); }
// ============================================================

export function swallow(tag: string, err?: unknown): void {
  // Dev-only debug line — production me tree-shaken condition ke saath
  // poora call no-op rehta hai (aur Vite `import.meta.env.DEV` ko
  // statically `false` se replace kar deta hai).
  if (import.meta.env.DEV) {
     
    console.debug(`[swallow:${tag}]`, err instanceof Error ? `${err.message}` : (err ?? 'no-error-object'));
  }
}
