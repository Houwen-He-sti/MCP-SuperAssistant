/**
 * Zustand StateStorage adapter backed by chrome.storage.local.
 *
 * Implements the Zustand `StateStorage` interface (from zustand/middleware),
 * providing async getItem/setItem/removeItem backed by chrome.storage.local.
 *
 * Optionally supports conservative migration from localStorage on first read:
 * - If chrome.storage.local[key] exists → return it
 * - Else if localStorage[key] exists → copy to chrome.storage.local, return it
 *   (does NOT delete localStorage — conservative migration)
 * - Else → return null
 *
 * @module
 */

export interface ChromeStorageStateStorageOptions {
  /** Storage area to use. Defaults to 'local'. */
  area?: 'local';
  /**
   * If true, attempts to migrate existing localStorage data to chrome.storage.local
   * on first read when chrome.storage.local doesn't have the key.
   * Only works in contexts where localStorage is available (content scripts).
   * Default: false.
   */
  migrateFromLocalStorage?: boolean;
}

export interface StateStorage {
  getItem(name: string): string | null | Promise<string | null>;
  setItem(name: string, value: string): unknown | Promise<unknown>;
  removeItem(name: string): unknown | Promise<unknown>;
}

/**
 * Creates a Zustand StateStorage backed by chrome.storage.local.
 */
export function createChromeStorageStateStorage(
  options?: ChromeStorageStateStorageOptions,
): StateStorage {
  const area = options?.area ?? 'local';
  const migrate = options?.migrateFromLocalStorage ?? false;

  const chromeStorage = (): typeof chrome.storage.local => {
    const c = (globalThis as { chrome?: typeof chrome }).chrome;
    if (!c?.storage?.[area]) {
      throw new Error(
        `chrome.storage.${area} is not available. ` +
          'Ensure the "storage" permission is declared in manifest.json and this code runs in an extension context.',
      );
    }
    return c.storage[area];
  };

  return {
    async getItem(name: string): Promise<string | null> {
      const store = chromeStorage();
      const result = await store.get(name);
      const value = (result as Record<string, unknown>)[name];
      if (value !== undefined) {
        return value as string;
      }

      // Conservative migration: copy from localStorage if available
      if (migrate) {
        try {
          const ls = (globalThis as { localStorage?: Storage }).localStorage;
          if (ls) {
            const localValue = ls.getItem(name);
            if (localValue !== null) {
              // Write to chrome.storage.local (do NOT delete from localStorage)
              await store.set({ [name]: localValue });
              return localValue;
            }
          }
        } catch {
          // localStorage may throw in certain contexts; treat as unavailable
        }
      }

      return null;
    },

    async setItem(name: string, value: string): Promise<void> {
      await chromeStorage().set({ [name]: value });
    },

    async removeItem(name: string): Promise<void> {
      await chromeStorage().remove(name);
    },
  };
}
