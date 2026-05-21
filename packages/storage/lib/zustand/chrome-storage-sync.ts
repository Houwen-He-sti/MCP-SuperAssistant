/**
 * Cross-context rehydration helper for Zustand stores backed by chrome.storage.local.
 *
 * When chrome.storage.local changes for a specific key, calls
 * `store.persist.rehydrate()` so the Zustand store picks up the latest value
 * written by another extension context (e.g., content script ↔ side panel).
 *
 * Note: Zustand's StateStorage interface has no subscribe mechanism,
 * so rehydration must be triggered externally via this helper.
 *
 * @module
 */

export interface ChromeStorageSyncOptions {
  /** The persist key to watch (must match the `name` passed to Zustand persist). */
  key: string;
  /** The Zustand store with a persist API (from zustand/middleware). */
  store: { persist: { rehydrate: () => Promise<void> | void } };
  /** Storage area to watch. Defaults to 'local'. */
  area?: 'local';
}

/**
 * Subscribes to chrome.storage.onChanged for a specific key+area.
 * When a matching change fires, calls `store.persist.rehydrate()`.
 *
 * @returns An unsubscribe function. Call it to remove the listener.
 */
export function subscribeChromeStorageRehydrate(options: ChromeStorageSyncOptions): () => void {
  const { key, store, area = 'local' } = options;

  const c = (globalThis as { chrome?: typeof chrome }).chrome;
  if (!c?.storage?.onChanged) {
    // Test environment or non-extension context — return a no-op unsubscribe
    return () => {};
  }

  const listener = (
    changes: Record<string, { oldValue?: unknown; newValue?: unknown }>,
    areaName: string,
  ): void => {
    if (areaName !== area) return;
    if (!(key in changes)) return;
    // Fire-and-forget: rehydrate may return a Promise, errors should not propagate
    Promise.resolve(store.persist.rehydrate()).catch(() => {});
  };

  c.storage.onChanged.addListener(listener);

  return () => {
    c.storage.onChanged.removeListener(listener);
  };
}
