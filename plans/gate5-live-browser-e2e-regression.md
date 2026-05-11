# Plan: Gate 5 Live Browser E2E Regression Suite

**Author**: GPT-5.5 Thinking  
**Status**: Draft / plan-only  
**Related**: PR #29, PR #21, PR #27, PR #28

---

## Summary

PR #29 completed the missing Gate 5 **integration-test layer** for the bridge core contract. That was the correct next step after the scanner / bridge / injection logic had grown beyond unit-test-only confidence.

This document records the next missing layer: a stable **live browser E2E regression suite** for Gate 5.

The goal is not to replace PR #29. The goal is to sit above it:

```text
unit tests
→ PR #29 integration tests
→ live browser E2E regression suite
```

PR #29 proves the module chain and bridge contract. The new E2E suite should prove the real browser/page path:

```text
Notion AI live page
→ MAIN-world stream interception
→ function_call detection
→ stream cutoff / drain behavior
→ streamToolBridge execution
→ result injection
→ auto submit
→ next assistant turn
→ model ACK confirmed or timeout
```

---

## Why this is needed after PR #29

PR #29 covers the core bridge contract and scanner-to-bridge integration, including:

- scanner → bridge pipeline;
- callTool → insertText → submitForm;
- duplicate guard;
- circuit breaker;
- controlled error paths;
- identity / parse validation;
- metadata false-positive guard coverage.

That is necessary, but it is not sufficient to prove the live browser runtime because the following layers remain outside PR #29:

1. actual Notion page DOM and route behavior;
2. MAIN-world interceptor installation and config propagation;
3. real streaming transport behavior;
4. real `CustomEvent` propagation between MAIN world / content script / bridge wiring;
5. real Notion input insertion and submit behavior;
6. cross-turn ACK confirmation from the next assistant response;
7. failure behavior when ACK does not arrive.

Gate 5 should therefore have a repeatable live-browser regression suite that runs against a real Chrome session with the extension loaded.

---

## Existing evidence / related PRs

| PR | Scope | What it proves | Remaining gap |
|----|-------|----------------|---------------|
| #21 | Gate 5b Live Notion/CDP Bridge Pipeline E2E | Early live browser bridge pipeline path | Not stable enough as a full regression suite |
| #27 | Gate 5d mocked E2E integration tests | `initStreamToolBridge → streamToolBridge → ackTracker` mocked pipeline | Does not include real Notion / live stream |
| #28 | Gate 5d live ACK scanning fix | Real Notion bug fix + live ACK evidence | Bugfix/evidence PR, not full regression suite |
| #29 | Gate 5 bridge core integration tests | Core contract and scanner → bridge integration | Does not cover live browser/page behavior |

This plan should reference #29 as the test-layer boundary: #29 is complete for integration tests; this follow-up is for browser E2E.

---

## Goals

### P0 goal

Create a small, repeatable live browser E2E regression suite for the Gate 5 Notion tool-loop runtime.

The suite should verify:

```text
function_call detected
→ tool execution starts
→ result submitted
→ next turn is observed
→ ACK confirmed or timeout state is recorded
```

### P1 goal

Make failures diagnosable enough that a future agent can tell which layer failed:

```text
interceptor not installed
scanner did not detect
bridge did not execute
adapter could not insert
submit failed
next turn did not start
ACK not found
```

### Non-goals

- Do not rewrite streamToolBridge.
- Do not change the Gate 5 runtime semantics.
- Do not add ChatGPT / DeepSeek live E2E in this PR.
- Do not require CI to access real Notion.
- Do not rely on manual screenshots as the only evidence.

---

## Proposed test target

Primary target:

```text
Notion AI live page
Chrome with extension loaded
CDP-controlled test runner
```

Why Notion first:

- Current MCP tool-loop proof work has been centered on Notion.
- Gate 5d live ACK evidence already exists from Notion.
- Notion adapter and stream behavior are the most exercised path.

---

## Minimal P0 test cases

### Test 1: Happy path — live tool loop reaches ACK confirmed

**Purpose**: prove the full live path works.

Expected event sequence:

```text
stream_start
→ function_call detected with structured identity
→ stream_cutoff or drain-drop path observed
→ stream_tool_execution executing
→ stream_tool_execution succeeded
→ RESULT_SUBMITTED
→ bridge_handoff_ack emitted with nonce
→ next assistant response observed
→ model_ack_confirmed
```

Required assertions:

- exactly one bridge execution for the callId;
- result insertion path returns `RESULT_SUBMITTED`;
- handoff ACK nonce is registered;
- next-turn scanning confirms the nonce;
- diagnostic output includes callId, functionName, nonce, streamId, and timestamps.

### Test 2: ACK timeout path

**Purpose**: prove timeout state is observable and does not masquerade as success.

Scenario:

```text
tool result submitted
→ nonce registered
→ no model ACK observed within configured timeout
→ model_ack_timeout emitted
```

Required assertions:

- pending nonce enters timeout;
- timeout event includes nonce and callId;
- no duplicate execution occurs while waiting;
- test report marks this as controlled timeout, not infrastructure crash.

### Test 3: Duplicate / replay guard

**Purpose**: prevent real streaming replay or DOM observer replay from executing the same tool twice.

Scenario:

```text
same function_call / same identity appears more than once
→ bridge reserves first execution
→ duplicate is blocked
→ callTool count remains 1
```

Required assertions:

- exactly one `callTool` call for the content signature / callId;
- duplicate event is logged as duplicate/blocked;
- no second result injection or submit occurs.

---

## P1 follow-up test cases

These can be separate PRs after the P0 suite exists.

### Test 4: Metadata false-positive live regression

Related to PR #28 and PR #29.

Purpose:

```text
Notion metadata patches that contain words like function_call / name
must not reach bridge execution.
```

Required assertions:

- scanner reports `detected=false` or no executable identity;
- bridge callTool count remains 0;
- no UI result card / no auto submit occurs.

### Test 5: Draft protection live regression

Purpose:

```text
If user draft exists in the input area,
result injection must fail closed and not overwrite it.
```

Expected outcome:

```text
INSERT_SKIPPED_DRAFT
no submitForm
user draft remains intact
```

### Test 6: Adapter unavailable / input missing regression

Purpose:

```text
If adapter cannot resolve input or submit button,
Gate 5 must fail with explicit structured outcome.
```

Expected outcomes:

```text
INSERT_SKIPPED_NO_INSPECT
INSERT_FAILED
SUBMIT_FAILED
```

---

## Test runner direction

Recommended location:

```text
scripts/e2e-gate5-live-browser-regression.cjs
```

Recommended runtime:

```text
Node.js + CDP WebSocket
Chrome launched manually with extension loaded
Notion session already authenticated
```

This follows the existing project pattern for live browser verification while avoiding a CI dependency on real Notion credentials.

---

## Evidence output format

Each run should write a JSON evidence file under:

```text
outputs/gate5-live-browser-e2e-<timestamp>.json
```

Required fields:

```json
{
  "runId": "...",
  "startedAt": "...",
  "endedAt": "...",
  "target": "notion-ai",
  "extensionId": "...",
  "url": "...",
  "tests": [
    {
      "name": "happy_path_ack_confirmed",
      "status": "passed|failed|skipped",
      "events": [],
      "diagnostics": {},
      "failureReason": null
    }
  ],
  "summary": {
    "passed": 0,
    "failed": 0,
    "skipped": 0
  }
}
```

Important: stale extension / stale page / missing login should be `skipped` with reason, not fake pass.

---

## Diagnostics requirements

The E2E runner should capture at least:

- browser console logs from content script and MAIN-world script;
- bridge events;
- ACK tracker events;
- `mcp:tool-execution-complete` events;
- DOM state for input content and submit button availability;
- active adapter name and `getStreamToolBridgeInfo()` output when available;
- final URL and page readiness diagnostics.

---

## Acceptance criteria

P0 PR can merge when:

1. a live browser E2E runner exists;
2. the runner has at least Happy Path and ACK Timeout scenarios;
3. duplicate / replay guard is either implemented or explicitly deferred with rationale;
4. evidence JSON is generated for each run;
5. stale environment detection produces `skipped`, not success;
6. README / plan text explains how to run it manually;
7. PR body references PR #29 as the integration-test baseline.

---

## Recommended PR split

### PR A — this plan

Plan-only document. No runtime behavior changed.

### PR B — P0 live browser runner

Add:

```text
scripts/e2e-gate5-live-browser-regression.cjs
```

Include Happy Path and ACK Timeout.

### PR C — duplicate / replay / metadata false-positive live cases

Add live regression cases for:

```text
duplicate guard
metadata false-positive
```

### PR D — draft protection / adapter failure live cases

Add live regression cases for:

```text
INSERT_SKIPPED_DRAFT
INSERT_SKIPPED_NO_INSPECT
SUBMIT_FAILED
```

---

## Risk notes

| Risk | Mitigation |
|------|------------|
| Notion DOM changes | Collect DOM diagnostics and mark selector failures clearly |
| Notion login/session unavailable | Skip with explicit environment reason |
| AI does not emit requested function_call | Retry with bounded attempts; report as controlled failure |
| ACK wording varies | Use nonce-based ACK detection, not semantic text matching |
| Live E2E is flaky | Keep core contract in PR #29 integration tests; use live E2E for browser regression only |
| Stale extension loaded | Preflight extension ID/version and fail/skip if mismatch |

---

## Final note

PR #29 should remain the authoritative integration-test baseline for Gate 5 bridge behavior. This plan adds the missing browser E2E layer above it so that future changes can be validated against real Notion streaming, real DOM insertion, and real cross-turn model ACK behavior.
