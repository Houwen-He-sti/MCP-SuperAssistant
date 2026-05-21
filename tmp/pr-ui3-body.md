## Summary

Implements UI-3: connect the side panel to the background service worker via Chrome runtime messaging (Option E from architecture debate).

## Changes

### `chrome-extension/src/background/index.ts`
- Added `chrome.runtime.sendMessage(broadcastMessage)` to `broadcastConnectionStatusToContentScripts` and `broadcastToolsUpdateToContentScripts`
- Extension pages (side panel, popup) now receive the same broadcast as content scripts
- Errors silently ignored (side panel may not be open)

### `pages/content/src/types/messages.ts`
- Extended `BaseMessage.origin` union with `'side-panel'`
- Allows side panel to correctly identify itself as message sender

### `pages/side-panel/src/stores/index.ts`
- Replaced `useConnectionStore` stub with real runtime store (status, isConnected, error, lastUpdatedAt + setConnectionStatus action) — NOT persisted
- Added new `useToolStore` (tools[], lastUpdatedAt + setTools action) — NOT persisted
- Tool type defined locally to avoid cross-page imports

### `pages/side-panel/src/SidePanelApp.tsx`
- On mount: fetches initial snapshot via `mcp:get-connection-status` and `mcp:get-tools`
- Subscribes to `chrome.runtime.onMessage` for live `connection:status-changed` and `mcp:tool-update` broadcasts
- Tools tab renders tool list (name + description) instead of WIP placeholder

## Architecture

Option E (On-Demand Messaging): no new ports, no content script changes. Background broadcasts to `chrome.runtime.sendMessage` alongside existing `tabs.sendMessage`. Side panel subscribes on mount, cleans up on unmount.

## Build

13/13 tasks successful, no type errors.

Closes UI-3.
