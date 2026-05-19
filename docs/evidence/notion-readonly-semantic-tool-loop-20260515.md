# Notion Read-Only Semantic Tool Loop Evidence - 2026-05-15

## Context

Goal: observe the next thin slice after read-only tool discovery: Notion AI should naturally emit one `echo` tool call, MCP-SuperAssistant should execute it, and the result should be inserted with `autoSubmit=false`.

Committee update used before this run: GPT returned `REVISE`, recommending S0/S1 before any autoSubmit/final ACK slice.

## Scope

In scope:

- S0 page/runtime/preference/tool inventory observation.
- S1 natural-language-only prompt asking for one `echo` call.
- `autoInsert=true`, `autoSubmit=false`, preferences restored in `finally`.
- Read-only tools only: `echo`, `get_bridge_info`, `get_task_status`.

Out of scope:

- `autoSubmit`.
- second-round ACK.
- Notion/MCP-SuperAssistant production prompt/template edits.
- write-capable bridge tools or GitHub write-back.

## Attempt 1 - Environment Preflight

Script created outside the repo as a one-off observation artifact:

```text
C:\Users\houwen\AppData\Local\Temp\notion-mcp-semantic-s1-smoke-20260515.cjs
```

The script attempted to:

1. Verify backend SSE inventory through `/sse` and `/message`.
2. Resolve MCP-SuperAssistant extension service worker through CDP.
3. If present, reload extension, inspect Notion content context, set `autoInsert=true` and `autoSubmit=false`, submit a natural-language `echo` request, then restore preferences.

Command:

```powershell
Set-Location "C:\Users\houwen\Documents\VS Code Dir\MCP-SuperAssistant"; $env:NODE_PATH=(Resolve-Path node_modules).Path; node "C:\Users\houwen\AppData\Local\Temp\notion-mcp-semantic-s1-smoke-20260515.cjs"
```

Result:

```text
Error: Extension worker not found for MCP SuperAssistant
```

Exit code: `1`.

## Follow-Up Observations

CDP `9222` is currently owned by Perplexity Comet, not Google Chrome:

```text
127.0.0.1:9222 -> C:\Users\houwen\AppData\Local\Perplexity\Comet\Application\comet.exe --remote-debugging-port=9222
```

Current extension/service-worker targets on that endpoint:

```text
iCloud 密码
MetaMask Offscreen Page
comet-agent
Dark Reader (Comet)
Comet
```

No `MCP SuperAssistant` manifest name was visible among extension targets, and the Notion execution contexts contained Playwright utility worlds plus Notion frames, but no MCP-SuperAssistant isolated content-script context.

Chrome profile preference search also found no `MCP`, `SuperAssistant`, or previous extension id `hkjclekhnaffnhldgpmjnohihjmblbpj` in `Google\Chrome\User Data` preference files.

## Current Verdict

Superseded: `BLOCKED_AT_S0_ENVIRONMENT` was resolved by restarting Comet with the unpacked extension loaded from `MCP-SuperAssistant\dist`.

## Attempt 2 - S0/S1 After Loading Extension

Comet was restarted with:

```powershell
Start-Process -FilePath "$env:LOCALAPPDATA\Perplexity\Comet\Application\comet.exe" -ArgumentList @('--remote-debugging-port=9222', "--load-extension=C:\Users\houwen\Documents\VS Code Dir\MCP-SuperAssistant\dist", 'https://www.notion.so/chat')
```

Extension target was then visible:

```text
chrome-extension://hkjclekhnaffnhldgpmjnohihjmblbpj/background.js -> MCP SuperAssistant
```

The S1 smoke script needed two observation fixes before the real run:

- skip CDP-unresponsive Notion tabs;
- choose the MCP-SuperAssistant isolated context on the main `https://www.notion.so/chat` frame, not the `identity.notion.so` iframe.

S0 result:

```json
{
	"directBackendTools": ["echo", "get_bridge_info", "get_task_status"],
	"extensionId": "hkjclekhnaffnhldgpmjnohihjmblbpj",
	"extensionStatus": "connected",
	"extensionTools": ["echo", "get_bridge_info", "get_task_status"],
	"contentFrame": "https://www.notion.so/chat",
	"inputCount": 1
}
```

S1 result:

```json
{
	"toolNonce": "S1_ECHO_1778849755998",
	"baselineToolCallCount": 1,
	"toolCallDelta": 0,
	"resultDelta": 0,
	"inputHasFunctionResult": false,
	"inputHasNonce": false,
	"pageHasNonce": true,
	"serviceWorkerBadLogs": []
}
```

Notion AI responded in natural language instead of emitting the requested JSONL bridge call. Tail excerpt:

```text
none exposes a generic echo tool anyway.
If you're smoke-testing your SuperAssistant Bridge, you'll want to run the test in the surface where that bridge actually intercepts the model's output (your browser-extension setup), not in this Notion AI thread.
```

Preferences were changed only for the run (`autoInsert=true`, `autoSubmit=false`) and restored to their original values (`mcpEnabled=true`, `autoInsert=true`, `autoSubmit=true`). The script's boolean `preferencesRestored=false` was caused by comparing the restored preference summary to the earlier summary object that also contained `hasStore`; the preference values themselves match.

## Current Verdict

`S0_PASS_S1_MODEL_DID_NOT_EMIT_TOOL_CALL`: backend and extension read-only tool discovery are healthy in the real Comet/Notion runtime, and the service worker showed no unsafe-eval/AJV errors. The semantic loop failed because Notion AI interpreted the request through its native Notion MCP/connector model and did not output a JSONL bridge tool call.

This is not evidence that the CSP-safe validator fix regressed. It shows the next blocker is prompt/protocol alignment for Notion AI: the bridge parser had no assistant JSONL to execute.

## Next Safe Options

1. Revise the S1 prompt so it explicitly says this is text protocol output for a browser extension, not Notion native MCP/connected apps.
2. Keep the prompt natural-language-only: no executable JSONL sample in the user message.
3. Rerun S1 with `autoSubmit=false` and the same read-only inventory guard.
4. If Notion AI still refuses to emit JSONL, escalate to committee review before touching production prompt templates.

## Committee Review After S1 No-Sample Failures

GPT-5.5 reviewed the two no-sample failures and recommended option `B`: run a controlled-pollution S1c with a minimal echo example, while naming it differently from no-sample natural tool-call evidence.

Required S1c boundaries from GPT:

- only list read-only tools;
- example call/message must not contain the run nonce;
- pass oracle must bind to current run `call_id` and nonce;
- do not use whole-pageText as pass condition;
- keep `autoSubmit=false` and restore preferences;
- do not modify production parser or production prompt templates in this slice.

## Attempt 3 - S1c Minimal Echo Example

The temp smoke runner was updated to use a minimal read-only prompt containing only an `echo` format example with `EXAMPLE_DO_NOT_EXECUTE`, then a current task with nonce-bound call id:

```text
CALL_S1_ECHO_1778850411882
S1_ECHO_1778850411882
```

Observation from run `S1-1778850411882`:

```json
{
	"toolCallDelta": 4,
	"resultDelta": 2,
	"inputHasFunctionResult": true,
	"inputHasNonce": true,
	"inputPreview": "<mcp-system-prompt>...",
	"pageTail": "<function_result call_id=\"CALL_S1_ECHO_1778850411882\">S1_ECHO_1778850411882</function_result>",
	"serviceWorkerBadLogs": [],
	"preferencesRestored": true
}
```

Interpretation:

- The minimal-template prompt successfully made Notion AI emit a nonce-bearing JSONL bridge call at least once.
- MCP-SuperAssistant executed `echo` and inserted a matching `<function_result>` into the composer.
- `autoSubmit=false` held: the composer retained the function result instead of submitting a second turn.
- The script still exited `1` because the attempted `mcp-superassistant:tool-loop-event` recorder saw no events from the isolated context. The inserted composer result is still strong runtime evidence of execution/insertion, but the event oracle needs improvement if we want this smoke to be a repeatable automated gate.

Important risk discovered:

- The inserted result is prefixed by the current production Notion bridge prompt template, which still lists stale/write-capable tools such as `comment_on_pr`, `merge_pr`, `git_commit`, and `git_push`.
- In this S1c run that content was not auto-submitted, so it did not leave the browser as a new user message.
- This blocks any safe S2 autoSubmit attempt under the current safety boundary unless the injected prompt is scoped/sanitized first.

Repeatability note:

- A later rerun with the same S1c runner did not produce a JSONL response within the observation window. That means S1c is observed as possible, not yet stable as an automated regression.

## Updated Verdict

`S1C_OBSERVED_ONCE_NOT_STABLE`: read-only detection -> execution -> insertion was observed once in the real Comet/Notion runtime with a minimal echo example and `autoSubmit=false`. However, no-sample natural tool-call remains failed, the event oracle did not fire in the isolated recorder, repeatability is not established, and the existing autoInsert prompt prefix contains stale/write-capable tool names.

## Next Safe Options After S1c

1. Do not proceed to S2 autoSubmit while autoInsert prefixes stale/write-capable tools.
2. Improve the smoke oracle to capture MAIN-world tool-loop events or rely explicitly on nonce-bound composer `<function_result>` as the accepted insertion oracle.
3. Decide whether a minimal read-only injection template can be tested as a temporary observation-only override without modifying production templates, or whether production prompt sanitization must become the next planned/TDD slice.

## Prompt Prefix Sanitization TDD - 2026-05-15

Committee review of the S1c blocker selected `A'`: a minimal production fix for the Notion native first-conversation prompt prefix.

Implemented scope:

- Added `pages/content/src/components/sidebar/Instructions/notionBridgePromptBuilder.ts`.
- Added `pages/content/src/components/sidebar/Instructions/notionBridgePromptBuilder.test.ts`.
- Updated `pages/content/src/plugins/adapters/notion.adapter.ts` so the native first-conversation prefix uses `buildReadOnlyNotionBridgePrompt()` instead of `assembleNotionBridgePrompt()` / `notion-bridge.md`.

TDD red check:

```powershell
cd MCP-SuperAssistant/pages/content
node --test --experimental-strip-types src/components/sidebar/Instructions/notionBridgePromptBuilder.test.ts
```

Initial result before implementation:

```text
ERR_MODULE_NOT_FOUND: Cannot find module ... notionBridgePromptBuilder.ts
exit code 1
```

Post-implementation focused test:

```text
tests 4
pass 4
fail 0
exit code 0
```

Build validation:

```powershell
pnpm -F @extension/content-script build
```

Result: passed; `dist/content/index.iife.js` and `dist/content/stream-interceptor-main.iife.js` rebuilt.

Runtime prefix smoke:

```powershell
node "$env:TEMP\notion-prefix-sanitization-runtime-smoke-20260515.cjs"
```

Result: passed after selecting the MCP SuperAssistant isolated world that had `mcpClient`, `pluginRegistry`, and the Notion chat input.

Observed facts:

```json
{
	"ok": true,
	"includesExpected": {
		"echo": true,
		"get_bridge_info": true,
		"get_task_status": true
	},
	"includesForbidden": {
		"comment_on_pr": false,
		"submit_pr_review": false,
		"merge_pr": false,
		"git_commit": false,
		"git_push": false,
		"create_pr": false,
		"create_issue": false,
		"update_issue": false,
		"read_workspace_file": false,
		"post_mailbox_message": false
	},
	"includesFunctionResult": true
}
```

Runtime smoke caveat: attempts that reloaded the extension and immediately navigated Notion hit context races (`NO_ADAPTER`, then `NO_INPUT`, then `No main Notion context`). Reusing the already loaded Notion tab and selecting the context by observed facts produced the stable pass above. Because the adapter intentionally injects the first-conversation prefix only once, repeat smoke runs reset `bridgePromptInjected=false` and `conversationMessageCount=0` in the adapter instance before calling `insertText()`.

Type-check note:

```powershell
pnpm -F @extension/content-script type-check
```

Result: failed on pre-existing `streamToolBridge.test.ts` type errors around `BridgeEvent` vs `StreamToolExecutionEvent` and adapter mock return types. No errors were reported by VS Code diagnostics for the new builder, new test, or updated Notion adapter files.

Current status after this slice:

- The production first-conversation prefix path is now read-only/minimal by source and focused test.
- S2 is still not executed in this slice.
- The runtime prefix smoke confirmed the composer prefix no longer contains stale/write-capable tool names after the extension content bundle was rebuilt and loaded in the current Notion tab.

## Safety Notes

- No write-capable bridge mode was enabled.
- No GitHub write-back was attempted.
- No S2 auto-submit run was attempted.
- The legacy `notion-bridge.md` template was not expanded in this slice; the native first-conversation path now uses the read-only builder instead.
