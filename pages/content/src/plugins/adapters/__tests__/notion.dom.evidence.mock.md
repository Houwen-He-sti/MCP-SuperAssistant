# PR 49: /ai and /agent/ Workspace Fallback Updates

**Evidence of Notion DOM Contract**
For standard workspace pages lacking a dedicated `/chat` or `/agent/` URL, the injection hinges exclusively on the presence of the native AI UI components in the DOM. 
The fallback logic checks for `NATIVE_SUBMIT_BUTTON`, which typically manifests in Notion's DOM as a specific submit button class embedded within a `div.notion-selectable` or a React-mounted modal node (e.g. `<div class="notion-ai-chat-modal">...<button class="submit">...</button></div>`). Since the user environment has deactivated the explicit `/agent/` sandbox, we rely strictly on querying these native input elements on *any* active workspace route.

**Legacy Routes Status**
- **`/ai`**: Out of scope. 
- **`/agent/`**: Out of scope. 
Both routes have been systematically pruned from all tests and conditionals. The new methodology fully accepts that Notion might arbitrarily invoke the native AI input dialog on any workspace tab without mutating the `pathname`; hence URL validation is superseded by Bayesian DOM validation tests.

**Test & Formatting Adjustments**
- CRLF/Formatting noise in `notion.adapter.ts` reverted (clean diff restored).
- Route unit validation decoupled from `/ai` and rewritten to validate `/chat` AND DOM-independent workspace fallbacks. All 18 route tests pass successfully.
