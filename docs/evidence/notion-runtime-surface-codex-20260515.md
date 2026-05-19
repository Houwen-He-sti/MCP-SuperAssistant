# Notion MCP-SuperAssistant Runtime Surface Observation - Codex - 2026-05-15

## Scope

Read-only runtime observation after the architecture source-of-truth split.

No navigation, no prompt submission, no preference mutation, no write-capable bridge mode, and no GitHub write-back.

## Commands

```powershell
node scripts\temp\notion-mcpsa-runtime-observation-20260515.cjs
```

First run failed before observation because the temporary script had an invalid JavaScript regex. The regex was fixed and the script was rerun.

Successful run:

```text
verdict=runtime_surface_present
extension_found=true
notion_tabs=3
proxy_3006_health_ok=false
proxy_3006_sse=timeout
evidence=C:\Users\houwen\Documents\VS Code Dir\MCP-SuperAssistant\scripts\temp\notion-mcpsa-runtime-observation-20260515T131438Z.json
```

Supplemental endpoint identity check:

```text
GET /health -> 404 Cannot GET /health
GET / -> 404 Cannot GET /
GET /sse -> timeout after receiving SSE-style long-lived response
GET /mcp -> 404 Cannot GET /mcp
```

Interpretation: `/health` is not a valid health endpoint for this proxy. `/sse` timeout is consistent with a live long-running SSE endpoint. Current proxy mode should be treated as SSE `/sse` plus message endpoint, not GET `/mcp`.

## Observed Runtime Surface

CDP found the MCP-SuperAssistant extension service worker:

```text
MCP SuperAssistant
chrome-extension://hkjclekhnaffnhldgpmjnohihjmblbpj/background.js
```

Three current Notion `/chat` tabs were inspected. Each had an MCP-SuperAssistant isolated context with `mcpClientReady=true`.

Representative active context:

```json
{
  "name": "MCP SuperAssistant",
  "origin": "chrome-extension://hkjclekhnaffnhldgpmjnohihjmblbpj",
  "mcpReady": true,
  "automationState": {
    "autoInsert": true,
    "autoSubmit": false,
    "autoExecute": false
  },
  "keys": [
    "configureStreamToolBridge",
    "getStreamToolBridgeInfo",
    "mcpClient",
    "__mcpAutomationState",
    "pluginRegistry",
    "__mcpAvailableTools",
    "__mcpToolNames",
    "availableTools"
  ]
}
```

## Current Judgment

This closes one open architecture fact: MCP-SuperAssistant is active on the current Notion `/chat` runtime surface.

This does not prove the second-round semantic tool loop. It only proves current runtime surface presence and readiness signals. Existing adjacent evidence in `notion-readonly-semantic-tool-loop-20260515.md` still governs the next boundary: read-only discovery is healthy, but the semantic S1 loop did not produce a JSONL bridge tool call.

## Evidence Files

- Raw observation JSON: `scripts/temp/notion-mcpsa-runtime-observation-20260515T131438Z.json`
- Supplemental evidence: `docs/evidence/notion-readonly-semantic-tool-loop-20260515.md`
- Tool discovery evidence: `docs/evidence/notion-mcp-tool-discovery-mismatch-20260515.md`
