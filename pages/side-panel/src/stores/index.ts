/**
 * Side Panel store stubs for UI-2b-lite.
 *
 * These provide the minimal interface required by SidePanelApp.tsx.
 * They will be replaced by real chrome.storage-backed stores in UI-1.
 *
 * Design notes:
 * - persist.hasHydrated() returns true immediately (no async storage yet)
 * - persist.onFinishHydration() is a no-op (no real hydration event)
 * - useConnectionStore returns 'disconnected' status (not yet bridged to content script)
 */

import { create } from 'zustand';

// --- Minimal persist API stub ---

const immediatePersist = {
  hasHydrated: () => true,
  onFinishHydration: (_fn: (state: unknown) => void) => () => {},
  rehydrate: async () => {},
};

// --- UI Store stub ---

interface UIStoreState {
  mcpEnabled: boolean;
}

// TODO: [UI-1] Replace with shared chrome.storage-backed ui store
export const useUIStore = Object.assign(
  create<UIStoreState>(() => ({
    mcpEnabled: false,
  })),
  { persist: immediatePersist },
);

// --- App Store stub ---

interface AppStoreState {
  isInitialized: boolean;
}

// TODO: [UI-1] Replace with shared chrome.storage-backed app store
export const useAppStore = Object.assign(
  create<AppStoreState>(() => ({
    isInitialized: false,
  })),
  { persist: immediatePersist },
);

// --- Config Store stub ---

interface ConfigStoreState {
  serverUrl: string;
}

// TODO: [UI-1] Replace with shared chrome.storage-backed config store
export const useConfigStore = Object.assign(
  create<ConfigStoreState>(() => ({
    serverUrl: '',
  })),
  { persist: immediatePersist },
);

// --- Connection Store stub ---

type ConnectionStatus = 'connected' | 'disconnected' | 'connecting' | 'reconnecting' | 'error';

interface ConnectionStoreState {
  status: ConnectionStatus;
}

// TODO: [UI-3] Replace with real store backed by chrome.runtime message bridge from content script
export const useConnectionStore = create<ConnectionStoreState>(() => ({
  status: 'disconnected',
}));
