## OO Planning Issue for UI-4

This issue tracks the OO (Observation-Oriented) planning and committee review for UI-4.

**Background**: UI-1/2b/3 merged. Side panel has live connection status + tools. Settings tab is WIP.

---

## Gemini OO Review

_Review by Gemini Code Assist_

**Gemini verdict**: Option B (direct storage) > Option C (broadcast). mcpServerUrl is persisted config, not runtime state — adding broadcast would create dual-track sync confusion.

Key Gemini recommendation: Create a `useServerConfigStore` with Zustand persist for mcpServerUrl. Read-only first for Settings tab.

Full Gemini notes:
- UIStore/AppStore/ConfigStore use createChromeStorageStateStorage + subscribeChromeStorageRehydrate
- broadcastConfigUpdateToContentScripts only targets tabs (content scripts), not runtime (side panel)
- Option B is more consistent with existing persist architecture
- Settings should be read-only first (TDD minimum closure)
- Prompt tab -> Custom Instructions editor (future)

---

## Copilot OO Assessment (independent)

**Agrees with Gemini**:
- Option B > Option C (no broadcast needed for config state)
- Read-only first
- Prompt tab = Custom Instructions future scope

**Disagrees on Zustand persist for mcpServerUrl**:

Background writes raw chrome.storage keys:

```typescript
await chrome.storage.local.set({
  mcpServerUrl: config.uri,
  mcpConnectionType: newType,
});
```

Zustand persist format is `{ state: {...}, version: 0 }` — incompatible with raw keys. Creating a persist store would read `undefined` without also changing how background stores the data.

**Proposed approach**: For mcpServerUrl/connectionType — local React `useState` + `chrome.storage.local.get` on mount + `chrome.storage.onChanged` subscription. No new store needed.

**Final UI-4 plan**:
- Files: `SidePanelApp.tsx` only
- No background changes
- No new stores
- Settings tab content:
  1. MCP server URL + connection type (local state from chrome.storage.local.get)
  2. 4 read-only status flags: autoSubmit, autoInsert, autoExecute, isPushMode (from useUIStore)
  3. mcpEnabled display (from useUIStore)

---

_Awaiting Opus review before proceeding to PL phase._
