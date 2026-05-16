# Notion Workspace Tree Policy Handoff Evidence (2026-05-16)

## Goal

Move toward using Notion AI, through MCP-SuperAssistant prompt injection, to handle local read-only workspace file tasks. Keep the increment simple, bounded, and testable.

## Principle

Use simple, agile increments: widen one axis at a time, preserve safety boundaries, and record live blockers instead of hiding them behind fallbacks.

## Increment

Added `workspace_tree_policy`, a smoke mode that asks Notion AI to choose the requested workspace-relative path from a bounded allowed path set:

- Base fixture: `MCP-SuperAssistant/scripts/temp/tree-smoke-fixture`
- Policy target fixture: `MCP-SuperAssistant/scripts/temp/tree-smoke-fixture-alt`
- Expected policy entries: `gamma.txt`, `nested`, `nested/delta.md`
- Tool: `get_child_item`
- Safety: read-only, workspace-relative, no `..`, no absolute paths, no drive paths, no UNC paths, no URLs, no writes, no exec, no network.

## Observation

Earlier policy runs proved path selection but failed final handoff:

- `WORKSPACE_TREE_POLICY_1778945533875`: Notion selected `tree-smoke-fixture-alt`, bridge returned `gamma.txt` and `nested/delta.md`, but final JSON was missing.
- `WORKSPACE_TREE_1778945445227`: fixed baseline also failed final JSON, so the blocker was broader than the new policy contract.
- A reinsert fallback was tried and rejected because it can create duplicate tool calls.

New diagnostics showed the handoff failure state more precisely:

- The function result was inserted.
- The send button click returned ok.
- The composer was cleared.
- The bridge emitted `bridge_handoff_ack`.
- Only one `runInferenceTranscript` resource existed, so the second-turn request did not reach the observed fetch stream.

## Fixes

1. `scripts/reload-extension.cjs` now respects explicit extension ID priority. This prevents `MCP_SUPERASSISTANT_EXTENSION_ID=hkj...` from accidentally reloading `mcj...` when Chrome target order differs.
2. The closed-loop runner now records `postSubmitNoStream` diagnostics when a result submit does not produce a second stream.
3. The runner calls `Page.bringToFront` before the smoke begins and records the result. This is a runtime activation step, not a prompt workaround.

## Live Result

`WORKSPACE_TREE_POLICY_1778947678724` passed after the runtime activation change:

- One `get_child_item` call.
- One inserted `<function_results>` payload.
- One result submit.
- A second `runInferenceTranscript` stream appeared.
- Final fenced JSON included:
  - `status: done`
  - `path: MCP-SuperAssistant/scripts/temp/tree-smoke-fixture-alt`
  - `entries: [gamma.txt, nested, nested/delta.md]`
- Validator result: PASS.

Important nuance: the PASS evidence still recorded `pageBringToFront.visibilityState` as `hidden`, so the exact browser visibility mechanism is not fully proven. The defensible conclusion is that explicit runtime activation correlated with restoring the second-turn stream, while prompt changes and result reinsertion were not needed.

## Review

This is progress toward the final target, not a detail loop, because Notion AI now demonstrates a bounded local-path selection workflow rather than a fixed-path fixture only. The next increment should keep the same safety model and move from directory listing toward bounded file reading or local review context, with tests first.

## Real Workflow Follow-up

User workflow: ask Notion AI `MCP-SuperAssistant/scripts 下有什么呢?`. Notion AI emitted the expected `get_child_item` JSONL, but no local result appeared.

Root causes found:

- The stream scanner did not handle Notion's newer `o:"a"` direct text append shape where the text is in `op.v.content`.
- Later Notion `record-map` snapshots can include historical function-call text and caused a false `identity: null` cutoff.
- The live provider exposed only `echo`, `get_bridge_info`, `get_task_status`, and `read_workspace_file`; `get_child_item` existed only in smoke shims.
- After reload, the stream bridge also respected `autoExecute: false`, so runtime execution remains intentionally disabled until the UI preference enables it.

Fixes and validation:

- Added scanner support for direct text append and ignored Notion `record-map` snapshots.
- Added a real read-only provider tool `get_child_item(Path, Depth, max_results)` with workspace-relative path enforcement and bounded results.
- Added `get_child_item` and `read_workspace_file` to the Notion bridge read-only prompt surface.
- Synced stream bridge startup and MCP popover toggles with UI preferences: execution is enabled only when `mcpEnabled && autoExecute`.
- Verified live tools include `get_child_item`.
- Verified `window.mcpClient.callTool('get_child_item', { Path: 'MCP-SuperAssistant/scripts', Depth: 1 })` returns directory entries.
- Verified preference-driven stream cutoff execution inserts `<function_results>` into the Notion input when `autoExecute` and `autoInsert` are enabled, while `autoSubmit` remains a separate safety toggle.

Follow-up hardening:

- Added `window.getStreamToolBridgeTrace()` and `getStreamToolBridgeInfo().recentEvents` so a live page can show the latest safe lifecycle facts: status, phase, tool name, call id, error code, elapsed time, and duration.
- Stream bridge events now carry `timestamp`, `elapsedMs`, `toolDurationMs`, and `durationMs` where available. For final `inject` or `submit` events, `durationMs` covers tool execution through result delivery into the input/submit path, while `toolDurationMs` covers only `callTool`.
- Provider responses now include `operation_duration_ms`, structured `status`, path policy, and safety fields; read/list filesystem exceptions return structured errors instead of surfacing as opaque MCP failures.
- Current increment remains simple and agile: read-only directory listing first, observability next, then bounded file/review workflows after the real chain is inspectable.

Live trace smoke after the hardening produced a final event like:

- `phase: inject`
- `status: succeeded`
- `toolDurationMs: 21`
- `durationMs: 75`
- `elapsedMs: 76`
- `injectOutcome: RESULT_INJECTED`

The smoke inserted a result into the input and then cleared that inserted draft. This confirms that final trace events can answer "where did it stop" and "how long did it take to deliver into the input" without relying on provider-local `operation_duration_ms`.
