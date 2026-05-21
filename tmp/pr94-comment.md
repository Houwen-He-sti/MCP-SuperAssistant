## Implementation Notes — UI-3 Self-Review

### Architecture decision recap (Option E)

After a full OO-PL-4CR-TDD debate (GPT, Gemini, Opus), consensus landed on **Option E (On-Demand Messaging)**:
- Background adds `chrome.runtime.sendMessage` alongside existing `tabs.sendMessage`
- Side panel fetches initial snapshot on mount, then listens for live broadcasts
- No new ports, no content script changes, no target filtering needed
  (`runtime.sendMessage` from background does **not** reach content scripts — only extension pages)

### Key design decisions

**Why local `Tool` type in stores/index.ts instead of importing from content page?**
Side panel (`@extension/side-panel`) and content page (`@extension/content-script`) are separate Vite bundles. Cross-package type imports would require a new shared package or circular dependency. The local `Tool` interface mirrors the content page shape exactly; if the canonical shape changes, TypeScript will catch mismatches at runtime message boundaries.

**Why no `chrome.runtime.sendMessage` for `broadcastConfigUpdateToContentScripts`?**
Config updates are triggered by user action in the popup/options page (which already has the updated state). The side panel's Settings tab is WIP (UI-4 scope) and doesn't need to react to config changes yet. Adding it later is a one-liner.

**Why `useEffect(..., [])` with eslint-disable?**
The effect is intentionally run once on mount. Zustand store getters (`useConnectionStore.getState()`) are stable references, not React state, so there are no missing deps. The disable comment is scoped to that specific line.

### What is NOT in this PR (deferred to later tasks)
- `broadcastConfigUpdateToContentScripts` → side panel (UI-4 scope)
- Prompt injection into AI chat interfaces (UI-4)
- Sidebar feature migration (UI-4)
- Settings tab real implementation (future)
- Unit tests for stores (Chrome API mocking infrastructure needed)
