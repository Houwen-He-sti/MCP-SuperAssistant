# Notion MCP Tool Discovery Mismatch Evidence

Author: GitHub Copilot
Date: 2026-05-15
Scope: Observation evidence plus TDD mitigation record. No full write-back, no `BRIDGE_ENABLE_WRITES=true`.

## Goal

Record the current Notion / MCP-SuperAssistant / local proxy runtime state before TDD mitigation work for Notion AI review via MCP-SuperAssistant prompt injection.

The current target is to make Notion AI able to act like a local reviewer by emitting tool calls that MCP-SuperAssistant can execute locally and insert back into the conversation.

## Current Verdict

```text
CSP_UNSAFE_EVAL_TOOL_SCHEMA_VALIDATOR
```

The local proxy and direct backend MCP session are reachable, but the MCP-SuperAssistant extension-side tool discovery / registry chain exposed zero tools to the Notion runtime during observation.

This blocks the full Notion AI tool loop. It should fail closed before any full review-loop smoke or write-back attempt.

Supplemental service-worker observation narrowed the mismatch further: tool discovery reaches the SSE plugin and backend metadata path, but schema validation attempts to compile tool output schemas with `new Function`, which violates the extension Content Security Policy and causes `getPrimitives` / `get-tools` to fail closed with an empty tool list.

## Non-Goals

- No `--full` smoke.
- No `BRIDGE_ENABLE_WRITES=true`.
- No GitHub write or PR comment.
- No prompt-template modification.
- No assumption that `config/mcp-servers.json` is the root cause.

## Observed Environment

### Proxy Process

Observed process command line:

```text
node packages/proxy/dist/index.js --stdio C:\temp\bridge.cmd --port 3006 --host 0.0.0.0 --ssePath /sse --messagePath /message
```

### Bridge Command

`C:\temp\bridge.cmd`:

```batch
@echo off
cd /d "C:\Users\houwen\Documents\VS Code Dir\committee-bridge-mcp"
set BRIDGE_WORKSPACE_ROOT=c:/Users/houwen/Documents/VS Code Dir
set BRIDGE_ENABLE_WRITES=false
uv run committee-bridge-mcp --transport stdio
```

### Backend Tool Server

`committee-bridge-mcp/src/committee_bridge_mcp/server.py` currently defines the minimal tools:

```text
echo
get_bridge_info
get_task_status
```

## Endpoint Observations

### SSE Endpoint

Command:

```powershell
curl.exe --max-time 2 -i http://127.0.0.1:3006/sse
```

Observed:

```text
HTTP/1.1 200 OK
Content-Type: text/event-stream

event: endpoint
data: /message?sessionId=2cd150fa-724a-47f9-bef8-b917db3e2d5b

curl: (28) Operation timed out after 2009 milliseconds with 79 bytes received
```

Interpretation: `/sse` is alive. The timeout is expected for a long-lived SSE stream.

### Streamable HTTP Endpoint

Command:

```powershell
curl.exe --max-time 5 -i http://127.0.0.1:3006/mcp
```

Observed:

```text
HTTP/1.1 404 Not Found
Cannot GET /mcp
```

Interpretation: current proxy mode is SSE `/sse` plus POST `/message?sessionId=...`, not streamable HTTP `/mcp`.

## Direct Backend MCP Inventory

Using direct SSE protocol:

```text
GET /sse -> endpoint /message?sessionId=...
POST initialize
POST notifications/initialized
POST tools/list
POST tools/call get_bridge_info
```

Observed:

```json
{
  "initialize": {
    "serverInfo": {
      "name": "committee-bridge-mcp",
      "version": "1.27.1"
    }
  },
  "tools": ["echo", "get_bridge_info", "get_task_status"],
  "get_bridge_info": {
    "name": "committee-bridge-mcp",
    "version": "0.1.0",
    "transport": "stdio",
    "workspace_root": "c:/Users/houwen/Documents/VS Code Dir  ",
    "writes_enabled": "false  "
  }
}
```

Interpretation: direct backend inventory works and can list minimal read-only tools. This is sufficient for bridge-runtime evidence using `echo` / `get_bridge_info`, but not sufficient for full reviewer capability claims.

## Extension Background Observations

Queried from a Notion tab isolated extension context with `chrome.runtime.sendMessage`.

### Server Config

Observed `mcp:get-server-config`:

```json
{
  "payload": {
    "uri": "http://localhost:3006/sse",
    "connectionType": "sse"
  },
  "success": true,
  "origin": "background"
}
```

### Connection Status

Observed `mcp:get-connection-status`:

```json
{
  "payload": {
    "status": "connected",
    "isConnected": true
  },
  "success": true,
  "origin": "background"
}
```

### Force Reconnect

Observed `mcp:force-reconnect`:

```json
{
  "payload": {
    "isConnected": true,
    "message": "Reconnection completed"
  },
  "success": true,
  "origin": "background"
}
```

### Tools List

Observed `mcp:get-tools` with `forceRefresh=true`:

```json
{
  "type": "mcp:get-tools:response",
  "payload": [],
  "success": true,
  "origin": "background"
}
```

### Background Tool Call

Observed direct background message call:

```json
{
  "type": "mcp:call-tool:response",
  "error": "Tool \"echo\" is not registered on the current MCP server",
  "success": false,
  "origin": "background"
}
```

Interpretation: background reports connected but returns zero tools and cannot call `echo`.

### Service Worker Error Logs

Supplemental CDP observation attached to the MCP-SuperAssistant service worker:

```text
chrome-extension://hkjclekhnaffnhldgpmjnohihjmblbpj/background.js
```

The trigger chain in the same observation was:

```json
{
  "config": {
    "uri": "http://localhost:3006/sse",
    "connectionType": "sse"
  },
  "tools": {
    "success": true,
    "len": 0
  },
  "callTool": {
    "success": false,
    "error": "Tool \"echo\" is not registered on the current MCP server"
  }
}
```

The service-worker console repeatedly emitted this root error:

```text
[SSEPlugin] Failed to get primitives: EvalError: Evaluating a string as JavaScript violates the following Content Security Policy directive because 'unsafe-eval' is not an allowed source of script: script-src 'self' 'wasm-unsafe-eval' 'inline-speculation-rules' http://localhost:* http://127.0.0.1:*".

    at new Function (<anonymous>)
    at c._compileSchemaEnv (.../background.js:9714:67)
    at c.compile (.../background.js:9501:35)
    at O_.getValidator (.../background.js:11423:119)
    at q_.cacheToolMetadata (.../background.js:11948:45)
    at q_.listTools (.../background.js:11963:17)
    at async Pu.getPrimitives (.../background.js:13334:14)
    at async Ka.getPrimitives (.../background.js:14403:17)
```

Matching logs were emitted by `[McpClient]`, `[BACKGROUND] Error getting tools`, and `[BACKGROUND] Error fetching tools after reconnect`.

Interpretation: the current evidence no longer points only to a generic registry synchronization issue. The first observed failure inside the extension-side discovery chain is an AJV / schema-validator CSP violation while caching MCP tool metadata from the SSE tool list.

## Content Runtime Observations

Two MCP-SuperAssistant isolated contexts were observed on the Notion tab.

One context exposed `chrome.runtime` but not `window.mcpClient`.

Another context exposed `window.mcpClient` and these globals:

```json
{
  "hasMcpClient": true,
  "globals": {
    "availableTools": 0,
    "mcpToolNames": [],
    "mcpAvailableToolsLen": 0
  },
  "isReady": true,
  "getAvailableTools": {
    "len": 0,
    "preview": []
  },
  "echo": {
    "error": "Tool \"echo\" is not registered in the current MCP tool registry"
  }
}
```

Interpretation: content runtime is ready but its tool registry is empty.

## Bayesian Update

The earlier coarse statement "bridge MCP not reachable at localhost:3006" should be revised.

Current evidence supports:

```text
backend SSE/proxy/MCP session reachable
direct backend tools/list returns minimal tools
extension background config/status points to the same SSE endpoint and says connected
extension background/content tool registries are empty
extension-side callTool cannot call echo
```

Therefore, the first confirmed blocker is:

```text
extension-side MCP tool discovery / registry convergence failure
```

The likely root cause after supplemental observation is:

```text
AJV outputSchema validator compilation violates extension CSP during tool metadata caching.
```

This explains why direct backend `tools/list` succeeds while extension `mcp:get-tools` returns an empty list and `callTool('echo')` is rejected as unregistered.

## Source-Level Observation

The extension creates the MCP SDK `Client` in `chrome-extension/src/mcpclient/core/McpClient.ts` with only capabilities:

```ts
this.client = new Client(
  {
    name: `mcp-client-${type}`,
    version: '1.0.0',
  },
  { capabilities: {} },
);
```

The installed SDK is `@modelcontextprotocol/sdk@1.25.2`. Its `ClientOptions` allow overriding the JSON schema validator:

```ts
jsonSchemaValidator?: jsonSchemaValidator;
```

The SDK default is `new AjvJsonSchemaValidator()`, and `AjvJsonSchemaValidator.getValidator()` calls `this._ajv.compile(schema)`. The SDK `Client.listTools()` calls `cacheToolMetadata(result.tools)`, and `cacheToolMetadata()` pre-compiles validators for each tool `outputSchema`.

The SDK also ships a `CfWorkerJsonSchemaValidator` provider intended for runtimes that restrict `eval` / `new Function`, but it requires the optional peer dependency `@cfworker/json-schema`. Current workspace observation found that peer dependency is not installed.

Current implication: because the extension does not provide a CSP-safe validator, the SDK default AJV path is used inside the extension service worker and fails under MV3 CSP when tools contain `outputSchema`.

## Committee Review Summary

GPT committee review response: `REVISE, then enter TDD`.

Accepted review points after independent evaluation:

- The blocker wording should be narrowed from a content sync issue to an extension-side tool discovery / registry chain mismatch.
- A structured investigation evidence record should be preserved before TDD.
- The next test should be a diagnostic fail-closed preflight, not a complete review-loop orchestration test.

Independent GitHub Copilot judgment:

- I agree with the revision. The evidence does not isolate the bug to content sync because background `mcp:get-tools` also returns an empty list.
- I do not accept any direct implementation or config fix yet. The evidence identifies a mismatch, not the root cause.
- TDD should only begin after the remaining minimal observations below are collected.

## Remaining Minimal Observations Before TDD

1. Confirm the smallest red test boundary: pure unit test for a CSP-safe JSON schema validator adapter, diagnostic preflight test, or both.
2. Confirm whether a no-op / permissive validator is acceptable for current extension-side tool discovery, or whether adding a real CSP-safe validator dependency such as `@cfworker/json-schema` is the correct dependency change.
3. Confirm whether preserving output validation semantics is required before full write-capable review loops.

## Proposed TDD Target

Next failing test should target a diagnostic preflight contract, not production behavior.

Expected diagnostic output when backend inventory succeeds but extension registry is empty:

```json
{
  "ok": false,
  "verdict": "MCP_TOOL_DISCOVERY_MISMATCH",
  "should_continue_review_loop": false,
  "should_attempt_full": false,
  "should_attempt_write": false,
  "backend": {
    "reachable": true,
    "tools": ["echo", "get_bridge_info", "get_task_status"]
  },
  "background": {
    "server_config_uri": "http://localhost:3006/sse",
    "connectionType": "sse",
    "connected": true,
    "tools": []
  },
  "content": {
    "mcpClient_present": true,
    "available_tools": [],
    "mcpToolNames": []
  },
  "callTool_echo": {
    "success": false,
    "error": "Tool echo is not registered"
  }
}
```

## Commands Run

The following commands were run during observation. Outputs are summarized above.

```powershell
curl.exe --max-time 2 -i http://127.0.0.1:3006/sse
curl.exe --max-time 5 -i http://127.0.0.1:3006/mcp
node scripts/test-tools-discovery.cjs
Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match '3006|mcp-superassistant|packages\\proxy|packages/proxy|committee-bridge|web-research-mcp|ai-web-agent' } | Select-Object ProcessId,Name,CommandLine | Format-List
uv run chatgpt-send --list-labels
uv run chatgpt-send --project "VSCode-Dir项目讨论专用" --file "..\%TEMP%\notion-mcp-bridge-oo-pl-4c2r-review-20260515.md" --output "..\%TEMP%\notion-mcp-bridge-oo-pl-4c2r-gpt-response-20260515.md" --timeout 600
```

Additional CDP observation snippets were run through `node -` without creating debug scripts, to avoid adding duplicate one-off scripts.

## TDD Mitigation Record

```text
RED -> GREEN COMPLETE FOR MINIMAL UNIT SEAM
```

Implemented after committee review and houwen approval:

- Added `chrome-extension/src/mcpclient/core/jsonSchemaValidator.ts` to create SDK client options with `CfWorkerJsonSchemaValidator`.
- Updated `chrome-extension/src/mcpclient/core/McpClient.ts` so extension-side SDK `Client` construction uses that CSP-safe validator instead of the SDK default AJV provider.
- Added `@cfworker/json-schema` to `chrome-extension/package.json` and `pnpm-lock.yaml`.
- Added `chrome-extension/tests/mcpclient/jsonSchemaValidator.node-test.ts` covering the exact MV3 CSP risk by blocking `globalThis.Function` while compiling a tool `outputSchema`.
- Added `classifyToolDiscoveryPreflight()` to `scripts/lib/l5b2-writeback-preflight.cjs`, with test coverage for the `CSP_UNSAFE_EVAL_TOOL_SCHEMA_VALIDATOR` fail-closed verdict.

Validation commands run after the mitigation:

```powershell
node --test --experimental-strip-types chrome-extension/tests/mcpclient/jsonSchemaValidator.node-test.ts
pnpm -F chrome-extension type-check
node -e "const assert=require('assert/strict'); const { classifyToolDiscoveryPreflight } = require('./scripts/lib/l5b2-writeback-preflight.cjs'); const verdict=classifyToolDiscoveryPreflight({ backendTools:['echo','get_bridge_info'], extensionTools:[], backgroundConnected:true, errors:['EvalError: unsafe-eval is not an allowed source of script','at cacheToolMetadata','at AjvJsonSchemaValidator.getValidator'] }); assert.equal(verdict.verdict,'CSP_UNSAFE_EVAL_TOOL_SCHEMA_VALIDATOR'); assert.equal(verdict.ok,false); assert.equal(verdict.shouldAttemptFull,false); console.log('targeted tool discovery preflight classifier passed');"
git diff --check -- chrome-extension/package.json chrome-extension/src/mcpclient/core/McpClient.ts chrome-extension/src/mcpclient/core/jsonSchemaValidator.ts chrome-extension/tests/mcpclient/jsonSchemaValidator.node-test.ts pnpm-lock.yaml scripts/lib/l5b2-writeback-preflight.cjs scripts/test-l5b2-writeback-preflight.cjs
```

Additional validation after committee follow-up: `node scripts/test-l5b2-writeback-preflight.cjs` now passes with 108 assertions after aligning the existing happy-path verdict expectation to `PASS_HAPPY_PATH_ONLY`.

## Read-Only Runtime Smoke

After building the extension, a read-only Chrome MV3 runtime smoke was run through CDP. The smoke reloaded MCP-SuperAssistant and the existing Notion tab, then checked only backend inventory, extension config/status, extension `mcp:get-tools`, and read-only `echo`. It did not run a full Notion review loop, did not enable writes, and did not modify Notion prompts/templates.

Command:

```powershell
$env:NODE_PATH=(Resolve-Path node_modules).Path; node "C:\Users\houwen\AppData\Local\Temp\notion-mcp-readonly-smoke-20260515.cjs"
```

Sanitized result excerpt:

```json
{
  "directBackend": {
    "serverName": "committee-bridge-mcp",
    "tools": ["echo", "get_bridge_info", "get_task_status"]
  },
  "extension": {
    "name": "MCP SuperAssistant",
    "url": "chrome-extension://hkjclekhnaffnhldgpmjnohihjmblbpj/background.js"
  },
  "background": {
    "config": {
      "uri": "http://localhost:3006/sse",
      "connectionType": "sse"
    },
    "status": {
      "status": "connected",
      "isConnected": true
    },
    "toolNames": ["echo", "get_bridge_info", "get_task_status"],
    "callTool": {
      "success": true,
      "structuredContent": {
        "result": "readonly smoke from GitHub Copilot"
      }
    }
  },
  "content": {
    "origin": "chrome-extension://hkjclekhnaffnhldgpmjnohihjmblbpj",
    "name": "MCP SuperAssistant"
  },
  "serviceWorkerBadLogs": [],
  "ok": true
}
```

Runtime implication: the code-level mitigation now has real service-worker evidence for read-only tool discovery. The remaining unproven boundary is the full Notion AI semantic review loop and any write-capable bridge path; those remain explicitly out of scope for this step.