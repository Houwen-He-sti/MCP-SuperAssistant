# UI-4 OO Review Request — Side Panel Settings Tab

**Context**: MCP-SuperAssistant Chrome Extension, MV3, TypeScript/React/Zustand.

We are following the OO-PL-4CR-TDD process. This is the OO (Observation-Oriented) consultation phase. UI-4 is the next planned increment. Please read the observations below and give your independent assessment.

---

## UI Track So Far

| Step | Content | Status |
|------|---------|--------|
| UI-1 | chrome.storage Zustand adapter + side panel stores | ✅ merged PR #92 |
| UI-2b | side panel manifest + basic SidePanelApp | ✅ merged PR #90/#91 |
| UI-3 | runtime message bridge (connection status + tools) | ✅ merged PR #94 |
| UI-4 | ??? | pending |

---

## Current Side Panel State (`main 2e8c6a8`)

### `SidePanelApp.tsx` — 3 tabs

| Tab | Content |
|-----|---------|
| Tools | ✅ Real-time tools list (from `useToolStore`, fed by `chrome.runtime.onMessage`) |
| Prompt | ❌ `<div>Prompt Panel (WIP)</div>` |
| Settings | ❌ `<div>Settings Panel (WIP)</div>` |

Header: live connection status dot + text (`useConnectionStore`).

### Stores available to side panel (all in `pages/side-panel/src/stores/index.ts`):

1. **`useUIStore`** (persisted via `chrome.storage.local`):
   - `preferences.autoSubmit` / `autoInsert` / `autoExecute` (boolean)
   - `preferences.autoInsertDelay` / `autoExecuteDelay` / `autoSubmitDelay` (number, seconds)
   - `preferences.isPushMode` (boolean)
   - `preferences.customInstructions` / `customInstructionsEnabled`
   - `preferences.theme` / `preferences.language`
   - `mcpEnabled` (boolean)
   - `sidebar.width` / `sidebar.position` / `sidebar.isVisible` / `sidebar.isMinimized`

2. **`useAppStore`** (persisted):
   - `globalSettings.theme` / `debugMode` / `autoSubmit` / etc.

3. **`useConfigStore`** (persisted):
   - `featureFlags`, `userProperties`, `userSegment` — mostly complex/opaque data

4. **`useConnectionStore`** (runtime, UI-3): connection status + error
5. **`useToolStore`** (runtime, UI-3): live tool list

### What's NOT in any side panel store:

- **MCP server URL** (`mcpServerUrl`): stored in `chrome.storage.local` but not mapped to any side panel store
- **MCP connection type** (`mcpConnectionType`): same

The side panel CAN read these directly via `chrome.storage.local.get(['mcpServerUrl', 'mcpConnectionType'])` without needing a background message.

### Background broadcast functions (from `background/index.ts`):

| Function | Broadcast via | UI-3 change |
|----------|--------------|-------------|
| `broadcastConnectionStatusToContentScripts` | `tabs.sendMessage` + **`runtime.sendMessage`** | ✅ updated |
| `broadcastToolsUpdateToContentScripts` | `tabs.sendMessage` + **`runtime.sendMessage`** | ✅ updated |
| `broadcastConfigUpdateToContentScripts` | `tabs.sendMessage` only (type: `mcp:server-config-updated`) | ❌ deferred |

The `broadcastConfigUpdateToContentScripts` was intentionally NOT updated in UI-3 (deferred to UI-4).

---

## UI-4 Candidate Scopes

### Option A — Settings tab (read-only, persisted data only)
- Render `autoSubmit`, `autoInsert`, `autoExecute`, `isPushMode`, `mcpEnabled`, `debugMode` from existing persisted stores
- No new message passing, no background changes
- Files: `SidePanelApp.tsx` only
- Complexity: Low

### Option B — Option A + MCP server URL display
- Read `mcpServerUrl` + `mcpConnectionType` from `chrome.storage.local.get` directly (not through background)
- Show in Settings tab: "Server: http://localhost:8000 (SSE)" style
- Subscribe to `chrome.storage.onChanged` for live updates when user changes server
- Files: `SidePanelApp.tsx` (+ maybe small store addition)
- Complexity: Medium

### Option C — Option A + config broadcast (symmetric with UI-3)
- Add `chrome.runtime.sendMessage` to `broadcastConfigUpdateToContentScripts` (same pattern as UI-3)
- Add handler in SidePanelApp.tsx for `mcp:server-config-updated` message type
- Add `useServerConfigStore` (runtime-only) to side panel stores
- Files: `background/index.ts`, `stores/index.ts`, `SidePanelApp.tsx`
- Complexity: Medium-high

---

## Questions for Gemini

1. **Scope**: Which option makes the most sense for UI-4? Is Option B sufficient without the full broadcast (Option C)?

2. **Write-back**: Should Settings tab be read-only display first, or should it support toggling `autoSubmit`/`autoInsert`/`autoExecute` (which would require writing back to `chrome.storage.local` and the content store)?

3. **chrome.storage.onChanged vs runtime.sendMessage**: For MCP server URL, reading from `chrome.storage.local.get` on mount + subscribing `chrome.storage.onChanged` is simpler than adding a new broadcast path. Is this a valid approach, or does it break the "all state via message bridge" consistency of UI-3?

4. **Prompt tab**: Any thoughts on what belongs there? (Currently WIP — could be the custom instructions editor?)

5. **Arch risk**: Any concerns about the side panel reading from `chrome.storage.local` directly (bypassing the background message pattern)?

---

## Our Current Assessment (for your independent review)

- Option B is our current preference: it shows the most useful info (server URL) without complexity
- Settings should be **read-only first** — write-back is a separate concern (UX interaction design needed)
- `chrome.storage.onChanged` subscription in side panel is acceptable — it's what the content store itself uses for rehydration
- Prompt tab → custom instructions editor seems natural but is separate from UI-4 scope

Please share your independent assessment of these options and any observations we may have missed.
