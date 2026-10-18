// v21.1.0 Phase-1.4: empty catches → swallow() (dev-only debug, behaviour same).
import { swallow } from './swallow';

const ENCRYPTION_KEY = import.meta.env.VITE_ENCRYPTION_KEY;
if (!ENCRYPTION_KEY) {
  console.warn('VITE_ENCRYPTION_KEY not set — secureStorage encryption is disabled');
}

const SENSITIVE_KEYS = [
  'WEALTH_AI_KEYS',
  'WEALTH_AI_GROQ',
  'WEALTH_AI_TAVILY',
  'TG_TOKEN',
  'TG_CHAT_ID'
];

const ALGORITHM = 'AES-GCM';
const KEY_LENGTH = 256;
const ITERATIONS = 600000;
const SALT_LENGTH = 16;
const IV_LENGTH = 12;

// FIX (audit M9): PBKDF2 with 600k iterations takes ~100-300ms of CPU on
// mobile. Previously EVERY getItemAsync/setItem re-derived the AES key from
// scratch (the alert watcher reads 2 keys every 20s; updateAiKeys writes 5).
// Cache derived CryptoKeys keyed by the salt bytes instead.
const _keyCache = new Map<string, CryptoKey>();

function saltCacheKey(salt: Uint8Array): string {
  let s = ''; for (let i = 0; i < salt.length; i++) s += salt[i].toString(16).padStart(2, '0');
  return s;
}

function isCryptoAvailable(): boolean {
  return typeof crypto !== 'undefined' && !!crypto.subtle;
}

async function deriveKey(salt: Uint8Array): Promise<CryptoKey> {
  const cacheKey = saltCacheKey(salt);
  const cached = _keyCache.get(cacheKey);
  if (cached) return cached;
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    enc.encode(ENCRYPTION_KEY || ''),
    'PBKDF2',
    false,
    ['deriveKey']
  );
  const saltBuf = new ArrayBuffer(salt.length);
  new Uint8Array(saltBuf).set(salt);
  const key = await crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: saltBuf, iterations: ITERATIONS, hash: 'SHA-256' },
    keyMaterial,
    { name: ALGORITHM, length: KEY_LENGTH },
    false,
    ['encrypt', 'decrypt']
  );
  // Bound the cache — a long session with many writes could otherwise grow it
  // indefinitely (each setItem generates a fresh random salt).
  if (_keyCache.size > 32) _keyCache.clear();
  _keyCache.set(cacheKey, key);
  return key;
}

async function encryptData(data: string): Promise<string> {
  if (!ENCRYPTION_KEY || !isCryptoAvailable()) return data;
  const salt = crypto.getRandomValues(new Uint8Array(SALT_LENGTH));
  const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
  const key = await deriveKey(salt);
  const enc = new TextEncoder();
  const ciphertext = await crypto.subtle.encrypt(
    { name: ALGORITHM, iv },
    key,
    enc.encode(data)
  );
  const combined = new Uint8Array(SALT_LENGTH + IV_LENGTH + ciphertext.byteLength);
  combined.set(salt, 0);
  combined.set(iv, SALT_LENGTH);
  combined.set(new Uint8Array(ciphertext), SALT_LENGTH + IV_LENGTH);
  let bin = ''; for (let i = 0; i < combined.length; i++) bin += String.fromCharCode(combined[i]);
  return btoa(bin);
}

async function decryptData(encrypted: string): Promise<string | null> {
  if (!ENCRYPTION_KEY || !isCryptoAvailable()) return encrypted;
  try {
    const combined = Uint8Array.from(atob(encrypted), c => c.charCodeAt(0));
    const salt = combined.slice(0, SALT_LENGTH);
    const iv = combined.slice(SALT_LENGTH, SALT_LENGTH + IV_LENGTH);
    const ciphertext = combined.slice(SALT_LENGTH + IV_LENGTH);
    const key = await deriveKey(salt);
    const decrypted = await crypto.subtle.decrypt(
      { name: ALGORITHM, iv },
      key,
      ciphertext
    );
    return new TextDecoder().decode(decrypted) || null;
  } catch {
    return null;
  }
}

function legacyDecrypt(encrypted: string): string | null {
  try {
    const CryptoJS = (window as any).CryptoJS;
    if (!CryptoJS || !ENCRYPTION_KEY) return null;
    const bytes = CryptoJS.AES.decrypt(encrypted, ENCRYPTION_KEY);
    const text = bytes.toString(CryptoJS.enc.Utf8);
    return text || null;
  } catch {
    return null;
  }
}

// FIX C7: `migrationDone` was a single global flag shared across all keys, so
// after the first key was migrated every subsequent key skipped the legacy
// decrypt branch and silently returned null. Track per-key instead.
const _migratedKeys = new Set<string>();

function isSensitive(key: string): boolean {
  return SENSITIVE_KEYS.includes(key);
}

export const secureStorage = {
  // Synchronous — for non-sensitive data (theme, portfolio, plannerSettings)
  getItem(key: string): string | null {
    try {
      const item = localStorage.getItem(key);
      if (!item) return null;

      if (item.startsWith('enc:')) {
        const payload = item.slice(4);
        // FIX C7: per-key migration flag + synchronous legacy decrypt only.
        // WebCrypto cannot run synchronously, so encrypted values are returned
        // as null here and callers must use getItemAsync() to read them.
        if (!_migratedKeys.has(key)) {
          const plain = legacyDecrypt(payload);
          if (plain !== null) {
            // Fire-and-forget re-encryption to WebCrypto format; mark migrated
            // immediately so concurrent reads don't trigger a second re-encrypt.
            _migratedKeys.add(key);
            encryptData(plain).then(reEnc => {
              try { localStorage.setItem(key, `enc:${reEnc}`); } catch (err) { swallow('secureStorage.getItem.reEncrypt', err); }
            }).catch(() => { _migratedKeys.delete(key); });
            return plain;
          }
          _migratedKeys.add(key); // not legacy either — skip on next call
        }
        // WebCrypto AES-GCM is async-only; callers must use getItemAsync().
        return null;
      }

      return item;
    } catch {
      return null;
    }
  },

  // Async — for sensitive data (API keys, tokens)
  async getItemAsync(key: string): Promise<string | null> {
    try {
      const item = localStorage.getItem(key);
      if (!item) return null;

      if (item.startsWith('enc:')) {
        const payload = item.slice(4);

        // FIX C7: per-key migration flag — each key gets its own legacy-check
        // pass so one migrated key doesn't block decryption of the others.
        if (!_migratedKeys.has(key)) {
          const legacy = legacyDecrypt(payload);
          if (legacy !== null) {
            _migratedKeys.add(key);
            try {
              const reEnc = await encryptData(legacy);
              localStorage.setItem(key, `enc:${reEnc}`);
            } catch { _migratedKeys.delete(key); }
            return legacy;
          }
          _migratedKeys.add(key);
        }

        const decrypted = await decryptData(payload);
        if (decrypted === null) {
          // FIX (audit C3): previously an undecryptable value was DELETED from
          // localStorage. Combined with the never-loaded CryptoJS legacy path,
          // users upgrading builds silently lost their API keys / Telegram
          // credentials on the first failed read. Preserve the ciphertext under
          // a side key so it can be recovered later (e.g. after re-entering the
          // correct encryption key) instead of destroying it.
          try {
            const backupKey = `${key}_undecryptable`;
            if (!localStorage.getItem(backupKey)) {
              localStorage.setItem(backupKey, item);
            }
            localStorage.removeItem(key);
          } catch (err) { swallow('secureStorage.getItemAsync.backupPreserve', err); } // v21.1.0: undecryptable backup preserve failure ab dikhta hai
          return null;
        }
        return decrypted;
      }

      return item;
    } catch {
      return null;
    }
  },

  // Fire-and-forget — most callers don't need to await
  setItem(key: string, value: string): void {
    if (isSensitive(key) && ENCRYPTION_KEY && isCryptoAvailable()) {
      // v10.13 (deep-recheck L2): .catch added — a rare WebCrypto failure
      // surfaced as an unhandled promise rejection on every write.
      encryptData(value).then(encrypted => {
        try { localStorage.setItem(key, `enc:${encrypted}`); } catch (err) { swallow('secureStorage.setItem.enc', err); }
      }).catch(() => {
        // Encryption failed — persist PLAINTEXT rather than silently losing
        // the write entirely (same degradation setItemAsync already uses).
        try { localStorage.setItem(key, value); } catch (err) { swallow('secureStorage.setItem.plainFallback', err); }
      });
    } else {
      try { localStorage.setItem(key, value); } catch (err) { swallow('secureStorage.setItem.plain', err); }
    }
  },

  // Fire-and-forget set, returns value for chaining convenience
  setItemPlain(key: string, value: string): void {
    try { localStorage.setItem(key, value); } catch (err) { swallow('secureStorage.setItemPlain', err); }
  },

  // Awaitable set — for flushCache-style rewrites where the page RELOADS
  // right after the writes: a fire-and-forget encryptData().then() can
  // lose the race against window.location.reload() (the clear() already
  // wiped the old value) and destroy the very keys being preserved.
  async setItemAsync(key: string, value: string): Promise<void> {
    if (isSensitive(key) && ENCRYPTION_KEY && isCryptoAvailable()) {
      try {
        const encrypted = await encryptData(value);
        localStorage.setItem(key, `enc:${encrypted}`);
      } catch {
        try { localStorage.setItem(key, value); } catch (err) { swallow('secureStorage.setItemAsync.plainFallback', err); }
      }
    } else {
      try { localStorage.setItem(key, value); } catch (err) { swallow('secureStorage.setItemAsync.plain', err); }
    }
  },

  removeItem(key: string): void {
    try { localStorage.removeItem(key); } catch (err) { swallow('secureStorage.removeItem', err); }
  },

  clear(): void {
    try { localStorage.clear(); } catch (err) { swallow('secureStorage.clear', err); }
  }
};
