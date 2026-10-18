// ============================================================
// userPrefs — IndexedDB key/value preferences store (lean)
// ------------------------------------------------------------
// v20.7.11 DEAD-CODE PURGE: the old 431-line IndexedDBStorage carried
// six stores from the removed v1 portfolio app (transactions, price
// history, AI chat, portfolio snapshots, offline queue) — none had a
// single caller. The only live consumer is paperMirror.ts, which uses
// the userPreferences KV store (localStorage fallback) for the
// paper-trade history mirror. Same DB name + version, so existing
// devices keep their mirror; unused stores simply stop being touched.
// ============================================================

// v21.1.0 Phase-1.4: empty catch → swallow() (dev-only debug, behaviour same).
import { swallow } from './swallow';

const DB_NAME = 'wealthai_idb_v18';
const DB_VERSION = 1;

class UserPrefsStore {
  private dbPromise: Promise<IDBDatabase> | null = null;
  private isAvailable: boolean = typeof window !== 'undefined' && 'indexedDB' in window;

  private async getDB(): Promise<IDBDatabase> {
    if (!this.isAvailable) {
      throw new Error('IndexedDB not available in current environment');
    }

    if (this.dbPromise) {
      return this.dbPromise;
    }

    this.dbPromise = new Promise((resolve, reject) => {
      try {
        const request = window.indexedDB.open(DB_NAME, DB_VERSION);

        request.onupgradeneeded = (event) => {
          const db = (event.target as IDBOpenDBRequest).result;
          // User preferences & profile (the one live store; devices that
          // already carry the old schema keep their extra stores untouched).
          if (!db.objectStoreNames.contains('userPreferences')) {
            db.createObjectStore('userPreferences', { keyPath: 'key' });
          }
        };

        request.onsuccess = () => resolve(request.result);
        request.onerror = () => {
          // v10.13 (deep-recheck M7): reset the cached promise on failure —
          // a transient open failure (private mode, blocked upgrade, quota)
          // used to leave the REJECTED promise cached forever, so every call
          // this session took the localStorage fallback even after IndexedDB
          // recovered.
          this.dbPromise = null;
          reject(request.error);
        };
        request.onblocked = () => {
          console.warn('[IndexedDB] Database upgrade blocked');
          this.dbPromise = null; // v10.13: allow a retry once the blocker clears
        };
      } catch (err) {
        reject(err);
      }
    });

    return this.dbPromise;
  }

  async setUserPreference<T>(key: string, value: T): Promise<void> {
    try {
      const db = await this.getDB();
      return new Promise((resolve, reject) => {
        const tx = db.transaction('userPreferences', 'readwrite');
        const store = tx.objectStore('userPreferences');
        const req = store.put({ key, value, updatedAt: Date.now() });
        req.onsuccess = () => resolve();
        req.onerror = () => reject(req.error);
      });
    } catch {
      try {
        localStorage.setItem(`pref_${key}`, JSON.stringify(value));
      } catch (err) { swallow('db.setUserPreference.localFallback', err); } // v21.1.0 Phase-1.4: pehle invisible tha
    }
  }

  async getUserPreference<T>(key: string, defaultValue: T): Promise<T> {
    try {
      const db = await this.getDB();
      return new Promise((resolve) => {
        const tx = db.transaction('userPreferences', 'readonly');
        const store = tx.objectStore('userPreferences');
        const req = store.get(key);
        req.onsuccess = () => {
          if (req.result && req.result.value !== undefined) {
            resolve(req.result.value as T);
          } else {
            resolve(defaultValue);
          }
        };
        req.onerror = () => resolve(defaultValue);
      });
    } catch {
      try {
        const item = localStorage.getItem(`pref_${key}`);
        return item ? JSON.parse(item) : defaultValue;
      } catch {
        return defaultValue;
      }
    }
  }
}

export const appDB = new UserPrefsStore();
