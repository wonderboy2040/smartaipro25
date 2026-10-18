/// <reference types="vite/client" />

// v20.7.11 DEAD-CODE PURGE: trimmed to the env vars the bundle actually
// reads. Removed stale declarations for the deleted v1-era client features
// (Telegram alerts VITE_TG_*, client-side API token, Tavily search key,
// client-side PIN) — the server-side .env equivalents are unaffected.
interface ImportMetaEnv {
  readonly VITE_API_PROXY: string;
  readonly VITE_ENCRYPTION_KEY: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
