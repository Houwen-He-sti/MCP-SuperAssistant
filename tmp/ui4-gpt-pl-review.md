# UI-4 PL Review Request for GPT

**Context**: MCP-SuperAssistant Chrome Extension, MV3 TypeScript/React/Zustand.  
**Phase**: PL (Planning) — pre-implementation review.  
**OO reviewers**: Gemini 2.5 Pro + Claude Opus 4.7 (both completed).

---

## Background: what UI-4 is

The side panel has 3 tabs: Tools (live, UI-3 done), Prompt (WIP), Settings (WIP).  
UI-4 fills in Settings tab + Prompt tab with read-only content.

---

## Key architectural facts (confirmed in code)

1. **Persisted stores** (`useUIStore`, `useAppStore`): backed by `chrome.storage.local` via `createChromeStorageStateStorage`. Auto-sync across side panel + content script via `subscribeChromeStorageRehydrate`.

2. **Runtime stores** (UI-3 pattern, `useConnectionStore`): no persistence. Fed by:
   - `chrome.runtime.sendMessage(...)` on mount (initial snapshot)
   - `chrome.runtime.onMessage.addListener` (broadcast updates)

3. **MCP server config** (`mcpServerUrl`, `mcpConnectionType`): stored in `chrome.storage.local` as **raw keys** (NOT inside a Zustand persist blob). Background has:
   - `mcp:get-server-config` handler → returns `{ uri, connectionType }` via `res.payload`
   - `mcp:update-server-config` handler → write + reconnect
   - `broadcastConfigUpdateToContentScripts` → currently only `tabs.sendMessage` (no `runtime.sendMessage` yet)

4. **UI-3 pattern for runtime data**: mount → `sendMessage('mcp:get-connection-status')` → `onMessage` listens for `connection:status-changed`. We propose the same for server config.

---

## Proposed UI-4 changes (3 files)

### File 1: `chrome-extension/src/background/index.ts` — 1 line

Add `chrome.runtime.sendMessage` to `broadcastConfigUpdateToContentScripts` (same as UI-3 added it to connection + tools broadcasts):

```typescript
// At the end of broadcastConfigUpdateToContentScripts, after the tabs loop:
// [UI-4] Also broadcast to extension pages via runtime.sendMessage
chrome.runtime.sendMessage(broadcastMessage).catch(() => {});
```

### File 2: `pages/side-panel/src/stores/index.ts` — new store

```typescript
// --- Server Config Store (UI-4, runtime-only) ---
type TransportType = 'sse' | 'websocket' | 'streamable-http'; // mirrors chrome-extension/src/mcpclient/types/plugin.ts

interface ServerConfigStoreState {
  uri: string;
  connectionType: TransportType;
  lastUpdatedAt: number | null;
  setServerConfig: (payload: { uri: string; connectionType: TransportType }) => void;
}

export const useServerConfigStore = create<ServerConfigStoreState>()((set) => ({
  uri: '',
  connectionType: 'sse',
  lastUpdatedAt: null,
  setServerConfig: ({ uri, connectionType }) =>
    set({ uri, connectionType, lastUpdatedAt: Date.now() }),
}));
```

### File 3: `pages/side-panel/src/SidePanelApp.tsx` — main changes

**A) Extend existing useEffect (UI-3 block) to also fetch server config:**

```typescript
// After the tools sendMessage call, add:
chrome.runtime.sendMessage(
  { type: 'mcp:get-server-config', origin: 'side-panel', timestamp: Date.now() },
  (res) => {
    if (chrome.runtime.lastError) return;
    if (res?.success && res.payload) {
      useServerConfigStore.getState().setServerConfig({
        uri: res.payload.uri ?? '',
        connectionType: res.payload.connectionType ?? 'sse',
      });
    }
  },
);
```

**B) Extend handleMessage to handle config updates:**

```typescript
if (msg.type === 'mcp:server-config-updated' && msg.payload?.config) {
  useServerConfigStore.getState().setServerConfig({
    uri: msg.payload.config.uri ?? '',
    connectionType: msg.payload.config.connectionType ?? 'sse',
  });
}
```

**C) Settings tab content (read-only, using selectors to avoid unnecessary re-renders):**

```tsx
// Selector pattern — subscribes only to needed fields
const uri = useServerConfigStore(state => state.uri);
const connectionType = useServerConfigStore(state => state.connectionType);
const mcpEnabled = useUIStore(state => state.preferences.mcpEnabled);
const debugMode = useAppStore(state => state.globalSettings.debugMode);

// In Settings tab div:
<div className="space-y-4">
  <div>
    <p className="text-xs font-medium text-slate-500 uppercase tracking-wide">MCP Server</p>
    <p className="text-sm mt-1 font-mono break-all">{uri || '(not set)'}</p>
    <p className="text-xs text-slate-500 mt-0.5">{connectionType}</p>
  </div>
  <div className="flex items-center justify-between">
    <span className="text-sm">MCP Enabled</span>
    <span className={`text-xs px-2 py-0.5 rounded-full ${mcpEnabled ? 'bg-emerald-100 text-emerald-700' : 'bg-slate-100 text-slate-500'}`}>
      {mcpEnabled ? 'On' : 'Off'}
    </span>
  </div>
  <div className="flex items-center justify-between">
    <span className="text-sm">Debug Mode</span>
    <span className={`text-xs px-2 py-0.5 rounded-full ${debugMode ? 'bg-amber-100 text-amber-700' : 'bg-slate-100 text-slate-500'}`}>
      {debugMode ? 'On' : 'Off'}
    </span>
  </div>
</div>
```

**D) Prompt tab content (read-only):**

```tsx
const customInstructions = useUIStore(state => state.preferences.customInstructions);
const customInstructionsEnabled = useUIStore(state => state.preferences.customInstructionsEnabled);

// In Prompt tab div:
<div className="space-y-3">
  <div className="flex items-center justify-between">
    <span className="text-sm font-medium">Custom Instructions</span>
    <span className={`text-xs px-2 py-0.5 rounded-full ${customInstructionsEnabled ? 'bg-blue-100 text-blue-700' : 'bg-slate-100 text-slate-500'}`}>
      {customInstructionsEnabled ? 'Enabled' : 'Disabled'}
    </span>
  </div>
  <div className="text-sm text-slate-600 bg-slate-50 rounded p-3 min-h-16 whitespace-pre-wrap break-words">
    {customInstructions || <span className="text-slate-400 italic">No custom instructions set.</span>}
  </div>
</div>
```

---

## Questions for GPT

1. **Architecture consistency**: Is the `useServerConfigStore` (runtime-only, like `useConnectionStore`) the right pattern here, or would you handle server config differently?

2. **broadcast wrapping**: Adding `chrome.runtime.sendMessage` to `broadcastConfigUpdateToContentScripts` — any edge cases we're missing? (UI-3 used the same pattern for connection status and tools without issues.)

3. **read-only scope**: We're deferring all write-back (toggle autoSubmit, etc.) to UI-5, because write-back requires handling content script side effects. Does this phasing make sense?

4. **Prompt tab scope**: Showing `customInstructions` as read-only in UI-4, editable in UI-5. Any concern with showing the raw text before we have a proper editor?

5. **Any other risks** in the 3-file plan we should address before implementation?
