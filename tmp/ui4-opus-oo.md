# UI-4 OO Review Request — Side Panel Settings Tab (Opus)

**Context**: MCP-SuperAssistant Chrome Extension, MV3, TypeScript/React/Zustand.  
**Phase**: OO (Observation-Oriented) — please form your own independent assessment from the raw code below.

---

## Source File 1: `pages/side-panel/src/stores/index.ts` (full, 241 lines)

```typescript
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

type Theme = 'light' | 'dark' | 'system';
type Position = 'left' | 'right';

interface SidebarPersistedShape {
  width: number;
  position: Position;
  isVisible: boolean;
  isMinimized: boolean;
}

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

interface GlobalSettings {
  theme: Theme;
  autoSubmit: boolean;
  debugMode: boolean;
  sidebarWidth: number;
  isPushMode: boolean;
  language: string;
  notifications: boolean;
}

// --- UI Store ---
interface UIStoreState {
  sidebar: SidebarPersistedShape;
  preferences: UserPreferences;
  theme: Theme;
  mcpEnabled: boolean;
}

export const useUIStore = create<UIStoreState>()(
  persist(
    () => ({
      sidebar: { width: 320, position: 'left', isVisible: true, isMinimized: false },
      preferences: {
        autoSubmit: false, autoInsert: false, autoExecute: false,
        autoInsertDelay: 2, autoSubmitDelay: 2, autoExecuteDelay: 2,
        notifications: true, theme: 'system', language: 'en',
        isPushMode: false, sidebarWidth: 320, isMinimized: false,
        customInstructions: '', customInstructionsEnabled: false,
      },
      theme: 'system',
      mcpEnabled: true,
    }),
    {
      name: 'mcp-super-assistant-ui-store',
      storage: createJSONStorage(() => createChromeStorageStateStorage({ area: 'local' })),
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

// --- App Store ---
interface AppStoreState {
  globalSettings: GlobalSettings;
}

export const useAppStore = create<AppStoreState>()(
  persist(
    () => ({
      globalSettings: {
        theme: 'system', autoSubmit: false, debugMode: false,
        sidebarWidth: 320, isPushMode: false, language: 'en', notifications: true,
      },
    }),
    {
      name: 'mcp-super-assistant-app-store',
      storage: createJSONStorage(() => createChromeStorageStateStorage({ area: 'local' })),
      partialize: (state) => ({ globalSettings: state.globalSettings }),
    },
  ),
);

subscribeChromeStorageRehydrate({ key: 'mcp-super-assistant-app-store', store: useAppStore });

// --- Config Store ---
interface ConfigStoreState {
  featureFlags: Record<string, unknown>;
  userProperties: Record<string, unknown>;
  userSegment: string;
  notificationConfig: Record<string, unknown>;
  shownNotifications: string[];
  notificationHistory: Array<{ id: string; shownAt: number; action?: string }>;
  lastFetchTime: number | null;
}

export const useConfigStore = create<ConfigStoreState>()(
  persist(
    () => ({
      featureFlags: {}, userProperties: {}, userSegment: 'new',
      notificationConfig: {}, shownNotifications: [], notificationHistory: [], lastFetchTime: null,
    }),
    {
      name: 'config-store',
      storage: createJSONStorage(() => createChromeStorageStateStorage({ area: 'local' })),
      partialize: (state) => ({
        featureFlags: state.featureFlags, userProperties: state.userProperties,
        userSegment: state.userSegment, notificationConfig: state.notificationConfig,
        shownNotifications: state.shownNotifications, notificationHistory: state.notificationHistory,
        lastFetchTime: state.lastFetchTime,
      }),
    },
  ),
);

subscribeChromeStorageRehydrate({ key: 'config-store', store: useConfigStore });

// --- Connection Store (UI-3) ---
type ConnectionStatus = 'connected' | 'disconnected' | 'connecting' | 'reconnecting' | 'error';

interface ConnectionStoreState {
  status: ConnectionStatus;
  isConnected: boolean;
  error: string | undefined;
  lastUpdatedAt: number | null;
  setConnectionStatus: (payload: { status: ConnectionStatus; isConnected: boolean; error?: string }) => void;
}

export const useConnectionStore = create<ConnectionStoreState>()((set) => ({
  status: 'disconnected', isConnected: false, error: undefined, lastUpdatedAt: null,
  setConnectionStatus: ({ status, isConnected, error }) =>
    set({ status, isConnected, error: error ?? undefined, lastUpdatedAt: Date.now() }),
}));

// --- Tool Store (UI-3) ---
interface Tool {
  name: string;
  description: string;
  input_schema: unknown;
  schema?: unknown;
}

interface ToolStoreState {
  tools: Tool[];
  lastUpdatedAt: number | null;
  setTools: (tools: Tool[]) => void;
}

export const useToolStore = create<ToolStoreState>()((set) => ({
  tools: [],
  lastUpdatedAt: null,
  setTools: (tools) => set({ tools, lastUpdatedAt: Date.now() }),
}));
```

---

## Source File 2: `pages/side-panel/src/SidePanelApp.tsx` (full, 181 lines)

```tsx
import { useAppStore, useConfigStore, useConnectionStore, useToolStore, useUIStore } from '@src/stores';
import { useEffect, useState } from 'react';

const useHydration = () => {
    const [isHydrated, setIsHydrated] = useState(false);
    useEffect(() => {
        const check = () => {
            if (
                useUIStore.persist.hasHydrated() &&
                useAppStore.persist.hasHydrated() &&
                useConfigStore.persist.hasHydrated()
            ) { setIsHydrated(true); }
        };
        check();
        const timeoutId = setTimeout(() => {
            console.warn('[SidePanel] Hydration timeout after 3s');
            setIsHydrated(true);
        }, 3000);
        const unsubUI = useUIStore.persist.onFinishHydration(check);
        const unsubApp = useAppStore.persist.onFinishHydration(check);
        const unsubConfig = useConfigStore.persist.onFinishHydration(check);
        return () => { clearTimeout(timeoutId); unsubUI(); unsubApp(); unsubConfig(); };
    }, []);
    return isHydrated;
};

const getStatusDotClass = (status: string) => {
    switch (status) {
        case 'connected': return 'bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.6)]';
        case 'error':
        case 'disconnected': return 'bg-rose-500 shadow-[0_0_8px_rgba(244,63,94,0.6)]';
        case 'connecting':
        case 'reconnecting': return 'bg-amber-500 animate-pulse';
        default: return 'bg-slate-400';
    }
};

export const SidePanelApp = () => {
    const [activeTab, setActiveTab] = useState<'tools' | 'prompt' | 'settings'>('tools');
    const { status } = useConnectionStore();
    const { tools } = useToolStore();
    const isHydrated = useHydration();

    // [UI-3] Fetch initial snapshot + subscribe to runtime broadcasts
    useEffect(() => {
        chrome.runtime.sendMessage(
            { type: 'mcp:get-connection-status', origin: 'side-panel', timestamp: Date.now() },
            (res) => {
                if (chrome.runtime.lastError) return;
                if (res?.success && res.payload) {
                    useConnectionStore.getState().setConnectionStatus({
                        status: res.payload.status ?? 'disconnected',
                        isConnected: res.payload.isConnected ?? false,
                        error: res.payload.error,
                    });
                }
            },
        );
        chrome.runtime.sendMessage(
            { type: 'mcp:get-tools', origin: 'side-panel', timestamp: Date.now() },
            (res) => {
                if (chrome.runtime.lastError) return;
                if (res?.success && Array.isArray(res.payload)) {
                    useToolStore.getState().setTools(res.payload);
                }
            },
        );
        const handleMessage = (msg: { type?: string; payload?: any }) => {
            if (msg.type === 'connection:status-changed' && msg.payload) {
                useConnectionStore.getState().setConnectionStatus({
                    status: msg.payload.status ?? 'disconnected',
                    isConnected: msg.payload.isConnected ?? false,
                    error: msg.payload.error,
                });
            }
            if (msg.type === 'mcp:tool-update' && Array.isArray(msg.payload?.tools)) {
                useToolStore.getState().setTools(msg.payload.tools);
            }
        };
        chrome.runtime.onMessage.addListener(handleMessage);
        return () => { chrome.runtime.onMessage.removeListener(handleMessage); };
    }, []);

    if (!isHydrated) {
        return (
            <div className="flex flex-col items-center justify-center h-full min-h-screen">
                <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div>
                <span className="mt-4 text-sm text-slate-500 animate-pulse">Loading workspace...</span>
            </div>
        );
    }

    return (
        <div className="flex flex-col h-full min-h-screen bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 font-sans">
            <header className="flex items-center justify-between p-4 border-b shrink-0 sticky top-0 z-10">
                <h1 className="font-semibold text-lg">MCP SuperAssistant</h1>
                <div className="flex items-center gap-2">
                    <span className="text-xs text-slate-500 capitalize">{status}</span>
                    <div className={`w-2.5 h-2.5 rounded-full ${getStatusDotClass(status)}`} />
                </div>
            </header>
            <nav className="flex border-b shrink-0">
                {(['tools', 'prompt', 'settings'] as const).map((tab) => (
                    <button key={tab} onClick={() => setActiveTab(tab)}
                        className={`flex-1 py-3 text-sm font-medium ${activeTab === tab ? 'text-blue-600 border-b-2 border-blue-600' : 'text-slate-500'}`}>
                        {tab.charAt(0).toUpperCase() + tab.slice(1)}
                    </button>
                ))}
            </nav>
            <main className="flex-1 overflow-y-auto relative">
                <div className={`absolute inset-0 p-4 ${activeTab === 'tools' ? 'block' : 'hidden'}`}>
                    {tools.length > 0 ? (
                        <ul className="space-y-1">
                            {tools.map((tool) => (
                                <li key={tool.name} className="text-sm py-1 px-2 rounded">
                                    <span className="font-medium">{tool.name}</span>
                                    {tool.description && (
                                        <span className="ml-2 text-xs text-slate-500 truncate max-w-xs">{tool.description}</span>
                                    )}
                                </li>
                            ))}
                        </ul>
                    ) : (
                        <div className="text-sm text-slate-500">No tools available. Connect to an MCP server.</div>
                    )}
                </div>
                <div className={`absolute inset-0 p-4 ${activeTab === 'prompt' ? 'block' : 'hidden'}`}>
                    <div className="text-sm text-slate-500">Prompt Panel (WIP)</div>
                </div>
                <div className={`absolute inset-0 p-4 ${activeTab === 'settings' ? 'block' : 'hidden'}`}>
                    <div className="text-sm text-slate-500">Settings Panel (WIP)</div>
                </div>
            </main>
        </div>
    );
};
```

---

## Source File 3: Relevant excerpts from `chrome-extension/src/background/index.ts`

```typescript
// How background stores server config (raw chrome.storage keys):
await chrome.storage.local.set({
  mcpServerUrl: config.uri,
  mcpConnectionType: newType,
});

// broadcastConfigUpdateToContentScripts — NOT updated in UI-3:
function broadcastConfigUpdateToContentScripts(config: { uri: string; connectionType?: string }) {
  const broadcastMessage = {
    type: 'mcp:server-config-updated',
    payload: { config },
    origin: 'background',
    timestamp: Date.now(),
  };
  // Only tabs.sendMessage — does NOT call chrome.runtime.sendMessage
  chrome.tabs.query({}, tabs => {
    tabs.forEach(tab => {
      if (tab.id) {
        chrome.tabs.sendMessage(tab.id, broadcastMessage).catch(() => {});
      }
    });
  });
}

// For comparison — UI-3 updated these two to also call runtime.sendMessage:
function broadcastConnectionStatusToContentScripts(isConnected: boolean, error?: string) {
  // ... tabs.sendMessage loop ...
  // [UI-3] Also broadcast to extension pages via runtime.sendMessage
  chrome.runtime.sendMessage(broadcastMessage).catch(() => {});
}

function broadcastToolsUpdateToContentScripts(tools: any[]) {
  // ... tabs.sendMessage loop ...
  // [UI-3] Also broadcast to extension pages via runtime.sendMessage
  chrome.runtime.sendMessage(broadcastMessage).catch(() => {});
}
```

---

## Three Options for UI-4

### Option A — Settings tab, read-only, from existing persisted stores only
- Render `autoSubmit`, `autoInsert`, `autoExecute`, `isPushMode`, `mcpEnabled`, `debugMode` from `useUIStore` / `useAppStore`
- These are already in side panel stores and auto-synced via `subscribeChromeStorageRehydrate`
- No background changes, no new stores
- Files: `SidePanelApp.tsx` only

### Option B — Option A + show MCP server URL + connection type
- `mcpServerUrl` / `mcpConnectionType` live in `chrome.storage.local` as raw keys (not under any Zustand persist blob)
- The side panel needs a way to read and keep these values live
- Sub-option B1: local React `useState` + `chrome.storage.local.get` + `chrome.storage.onChanged` in `SidePanelApp.tsx`
- Sub-option B2: new Zustand store with persist (works only if format matches what background writes)
- Files: `SidePanelApp.tsx`; possibly `stores/index.ts`

### Option C — Option A + complete the deferred config broadcast (symmetric with UI-3)
- Add `chrome.runtime.sendMessage` to `broadcastConfigUpdateToContentScripts`
- Add `mcp:server-config-updated` message handler in `SidePanelApp.tsx`
- Add a new runtime-only store (like `useConnectionStore`) for server config
- Files: `background/index.ts`, `stores/index.ts`, `SidePanelApp.tsx`

---

## Questions

1. For Option B: what is the right way to read `mcpServerUrl`/`mcpConnectionType` in the side panel? (B1 raw storage, B2 new persist store, or C broadcast)

2. Is Option B sufficient for UI-4, or is Option C needed for architectural consistency?

3. For B1: does using `chrome.storage.onChanged` directly in a React component create any concerns in this codebase?

4. For B2: note that background writes raw keys (`mcpServerUrl: "..."`) not Zustand-format blobs. Would `createChromeStorageStateStorage` work with raw keys, or would it need modification?

5. Should Settings tab support write-back (toggle `autoSubmit` etc.) in UI-4, or read-only first?

6. What should the Prompt tab show in UI-4? (`customInstructions` / `customInstructionsEnabled` are in `useUIStore`)
