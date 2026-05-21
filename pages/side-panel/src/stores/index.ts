/**
 * Side Panel stores for UI-1.
 *
 * Persistent stores (ui / app / config) are backed by chrome.storage.local,
 * using the same persist keys as the content script stores so that the two
 * contexts share state.
 *
 * Persisted shapes exactly match the content store `partialize` output to
 * prevent partial-write clobber (P1 risk documented in the UI-1 plan).
 *
 * connection store remains a stub until UI-3 (message bridge).
 */

import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import { createChromeStorageStateStorage, subscribeChromeStorageRehydrate } from '@extension/storage';

// ─── Shared type shapes (must be shape-compatible with content stores) ────────

type Theme = 'light' | 'dark' | 'system';
type Position = 'left' | 'right';

/** Shape: content ui.store SidebarState (persisted subset) */
interface SidebarPersistedShape {
  width: number;
  position: Position;
  isVisible: boolean;
  isMinimized: boolean;
}

/** Shape: content ui.store UserPreferences */
interface UserPreferences {
  autoSubmit: boolean;
  autoInsert: boolean;
  autoExecute: boolean;
  autoInsertDelay: number;
  autoSubmitDelay: number;
  autoExecuteDelay: number;
  notifications: boolean;
  theme: Theme;
  language: string;
  isPushMode: boolean;
  sidebarWidth: number;
  isMinimized: boolean;
  customInstructions: string;
  customInstructionsEnabled: boolean;
}

/** Shape: content app.store GlobalSettings */
interface GlobalSettings {
  theme: Theme;
  autoSubmit: boolean;
  debugMode: boolean;
  sidebarWidth: number;
  isPushMode: boolean;
  language: string;
  notifications: boolean;
}

// ─── UI Store ─────────────────────────────────────────────────────────────────

interface UIStoreState {
  /** Persisted subset: mirrors ui.store.ts partialize output */
  sidebar: SidebarPersistedShape;
  preferences: UserPreferences;
  theme: Theme;
  mcpEnabled: boolean;
}

const uiInitialState: UIStoreState = {
  sidebar: { width: 320, position: 'left', isVisible: true, isMinimized: false },
  preferences: {
    autoSubmit: false,
    autoInsert: false,
    autoExecute: false,
    autoInsertDelay: 2,
    autoSubmitDelay: 2,
    autoExecuteDelay: 1,
    notifications: true,
    theme: 'system',
    language: 'en',
    isPushMode: false,
    sidebarWidth: 320,
    isMinimized: false,
    customInstructions: '',
    customInstructionsEnabled: false,
  },
  theme: 'system',
  mcpEnabled: false,
};

// [UI-1] Real chrome.storage-backed UI store — same persist key as content ui.store.ts
export const useUIStore = create<UIStoreState>()(
  persist(
    () => uiInitialState,
    {
      name: 'mcp-super-assistant-ui-store',
      storage: createJSONStorage(() => createChromeStorageStateStorage({ area: 'local' })),
      // Match content store partialize to prevent partial-write clobber
      partialize: (state) => ({
        sidebar: state.sidebar,
        preferences: state.preferences,
        theme: state.theme,
        mcpEnabled: state.mcpEnabled,
      }),
    },
  ),
);

subscribeChromeStorageRehydrate({ key: 'mcp-super-assistant-ui-store', store: useUIStore });

// ─── App Store ────────────────────────────────────────────────────────────────

interface AppStoreState {
  /** Persisted subset: mirrors app.store.ts partialize output */
  globalSettings: GlobalSettings;
}

const appInitialState: AppStoreState = {
  globalSettings: {
    theme: 'system',
    autoSubmit: false,
    debugMode: false,
    sidebarWidth: 320,
    isPushMode: false,
    language: 'en',
    notifications: true,
  },
};

// [UI-1] Real chrome.storage-backed App store — same persist key as content app.store.ts
export const useAppStore = create<AppStoreState>()(
  persist(
    () => appInitialState,
    {
      name: 'mcp-super-assistant-app-store',
      storage: createJSONStorage(() => createChromeStorageStateStorage({ area: 'local' })),
      partialize: (state) => ({ globalSettings: state.globalSettings }),
    },
  ),
);

subscribeChromeStorageRehydrate({ key: 'mcp-super-assistant-app-store', store: useAppStore });

// ─── Config Store ─────────────────────────────────────────────────────────────

/**
 * Config store persisted shape mirrors config.store.ts partialize output.
 * Complex types (FeatureFlag, UserProperties, NotificationConfig) are kept as
 * `unknown` here — the side panel only needs the hydration gate, not these values.
 */
interface ConfigStoreState {
  featureFlags: Record<string, unknown>;
  userProperties: Record<string, unknown>;
  userSegment: string;
  notificationConfig: Record<string, unknown>;
  shownNotifications: string[];
  notificationHistory: Array<{ id: string; shownAt: number; action?: string }>;
  lastFetchTime: number | null;
}

const configInitialState: ConfigStoreState = {
  featureFlags: {},
  userProperties: {},
  userSegment: 'new',
  notificationConfig: {},
  shownNotifications: [],
  notificationHistory: [],
  lastFetchTime: null,
};

// [UI-1] Real chrome.storage-backed Config store — same persist key as content config.store.ts
export const useConfigStore = create<ConfigStoreState>()(
  persist(
    () => configInitialState,
    {
      name: 'config-store',
      storage: createJSONStorage(() => createChromeStorageStateStorage({ area: 'local' })),
      // Match content store partialize to prevent partial-write clobber
      partialize: (state) => ({
        featureFlags: state.featureFlags,
        userProperties: state.userProperties,
        userSegment: state.userSegment,
        notificationConfig: state.notificationConfig,
        shownNotifications: state.shownNotifications,
        notificationHistory: state.notificationHistory,
        lastFetchTime: state.lastFetchTime,
      }),
    },
  ),
);

subscribeChromeStorageRehydrate({ key: 'config-store', store: useConfigStore });

// ─── Connection Store (stub — UI-3) ──────────────────────────────────────────

type ConnectionStatus = 'connected' | 'disconnected' | 'connecting' | 'reconnecting' | 'error';

interface ConnectionStoreState {
  status: ConnectionStatus;
}

// TODO: [UI-3] Replace with real store backed by chrome.runtime message bridge from content script
export const useConnectionStore = create<ConnectionStoreState>(() => ({
  status: 'disconnected',
}));

