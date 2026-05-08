# Gate 5 Integration Test Plan

> Branch: `test/gate5-integration-test-plan`
> PR: TBD
> Status: Draft plan for review
> Related: PR #19, PR #21, PR #22

## 1. Purpose

Gate 5 currently has unit tests and live/browser E2E evidence, but it lacks a dedicated integration-test layer between them.

This plan defines that missing layer so Gate 5c does not rely only on live Notion E2E to discover bridge/adapter contract breaks.

The integration tests should verify production modules wired together with controlled fakes:

```text
stream cutoff event
  -> streamToolBridge
  -> execution guard / storage boundary
  -> mcpClient.callTool
  -> result formatting / injection decision
  -> adapter.insertText
  -> adapter.submitForm
  -> evidence / result classification
```

The tests should not open real Notion, should not call a real MCP server, and should not depend on model behavior.

## 2. Problem Statement

Current risk pattern:

- Unit tests can prove a single helper is correct.
- Live E2E can prove the real browser path works, but failures are slow and hard to localize.
- Missing integration tests mean boundary regressions are only caught during live Notion runs.

Gate 5c specifically exposed this gap around:

1. `getInputContent` missing while insert/submit continues.
2. `insertText` lifecycle callback errors vs real insertion failure.
3. `streamToolBridgeInit` adapter resolution.
4. Success-path `callTool -> insert -> submit` contract.
5. Evidence classification quality for consumption tests.

## 3. Scope

In scope:

- Plan a deterministic integration test suite for Gate 5 bridge/runtime contracts.
- Define required test cases before expanding Gate 5c implementation.
- Keep production behavior unchanged in this PR.
- Keep live Notion E2E separate from integration tests.

Out of scope:

- Implementing the tests in this PR.
- Changing `streamToolBridge` production behavior.
- Changing `NotionAdapter` production behavior.
- Running real Notion / real browser / real MCP server.
- Proving AI consumption. That remains Gate 5c E2E.

## 4. Proposed Test Files

Recommended files:

```text
pages/content/src/render_prescript/src/stream/streamToolBridge.integration.test.ts
pages/content/src/render_prescript/src/stream/streamToolBridgeInit.integration.test.ts
pages/content/src/plugins/adapters/notion.adapter.integration.test.ts
```

If existing package test layout prefers `__tests__`, use:

```text
pages/content/src/render_prescript/src/stream/__tests__/streamToolBridge.integration.test.ts
pages/content/src/render_prescript/src/stream/__tests__/streamToolBridgeInit.integration.test.ts
pages/content/src/plugins/adapters/__tests__/notion.adapter.integration.test.ts
```

Use the repository's existing test runner and conventions. Do not introduce a new test framework unless unavoidable.

## 5. Required Integration Test Cases

### 5.1 Success path: tool result inserts and submits

Given:

- a detected tool call with valid name, call id, and arguments;
- guard reservation succeeds;
- `mcpClient.callTool` returns a success result containing a sentinel;
- adapter exposes `insertText`, `submitForm`, and optionally `getInputContent`;

Expect:

```text
callTool called once
insertText called with success <function_results> payload
submitForm called after insertText succeeds
evidence records success path
```

This is the baseline integration proof missing between unit tests and live E2E.

### 5.2 Error path: tool error inserts error result and submits only if configured

Given `mcpClient.callTool` returns or throws a tool error.

Expect:

```text
error <function_results> payload is formatted
insertText is called if safe injection policy allows it
submit behavior follows Gate 5 autoSubmit policy
error classification is explicit
```

This protects the Gate 5b behavior while adding success-path coverage.

### 5.3 insertText returns false: must not submit

Given:

```text
adapter.insertText returns false
```

Expect:

```text
adapter.submitForm is not called
result classified as injection_failed or equivalent
evidence records insertText=false
```

This prevents false-positive autoSubmit after failed insertion.

### 5.4 insertText throws: must not submit

Given:

```text
adapter.insertText throws an exception
```

Expect:

```text
adapter.submitForm is not called
exception is captured in evidence / error classification
```

This is distinct from lifecycle callback errors inside the adapter.

### 5.5 lifecycle callback throws after actual insertion: may continue

Given:

- adapter implementation actually mutates the input successfully;
- lifecycle callback such as `emitExecutionCompleted` throws after the mutation;
- adapter catches that lifecycle callback error and returns true;

Expect:

```text
streamToolBridge treats insertText result=true as insertion success
submitForm may proceed
lifecycle callback failure is not treated as insertion failure
```

This documents the intended distinction:

```text
real insertion failure => no submit
non-critical lifecycle callback failure after mutation => submit may continue
```

### 5.6 getInputContent missing: allowed fallback, downgraded evidence

Given:

```text
adapter.getInputContent is undefined
insertText returns true
submitForm returns true
```

Expect:

```text
bridge may continue for compatibility
input verification quality is downgraded
Gate 5c evidence cannot claim high-confidence composer verification from this path alone
```

This is safe only if the evidence model clearly distinguishes:

```text
verified_input_contains_sentinel
vs
insert_submit_attempted_without_input_readback
```

### 5.7 getInputContent exists but does not contain sentinel: must fail before submit or downgrade hard

Given:

- `insertText` returns true;
- `getInputContent` exists;
- readback does not contain sentinel / injected payload marker;

Expected policy must be explicit before implementation:

Option A, preferred for Gate 5c:

```text
do not submit
classify as input_readback_mismatch
```

Option B, compatibility fallback:

```text
submit may continue only if explicitly allowed, but evidence quality is downgraded and cannot close Gate 5c
```

Gate 5c should prefer Option A for sentinel verification runs.

### 5.8 submitForm returns false: classify submit failure

Given:

```text
insertText succeeds
submitForm returns false
```

Expect:

```text
result classified as submit_failed
no AI consumption check is attempted
```

### 5.9 submitForm throws: classify submit exception

Given:

```text
insertText succeeds
submitForm throws
```

Expect:

```text
exception captured
result classified as submit_failed / submit_exception
```

### 5.10 duplicate execution guard blocks repeated call

Given the same call id / content signature arrives twice.

Expect:

```text
first event reserves and executes
second event is skipped
callTool called once
insertText called once
submitForm called once
```

### 5.11 circuit breaker blocks runaway loop

Given repeated tool call events exceed configured threshold.

Expect:

```text
new executions are blocked
no additional callTool / insertText / submitForm calls occur after breaker opens
classification is circuit_breaker_open
```

### 5.12 adapter resolution: explicit adapter wins

For `streamToolBridgeInit`, when an explicit adapter dependency is provided or exposed through the expected runtime surface, it should be used before generic fallbacks.

Expect:

```text
resolved adapter === explicit Notion adapter
```

### 5.13 adapter resolution: active plugin registry Notion adapter

Given a plugin registry / adapter store state with active Notion adapter.

Expect:

```text
streamToolBridgeInit resolves the Notion adapter
required methods exist: insertText, submitForm
optional methods detected: getInputContent if present
```

### 5.14 adapter resolution failure is explicit

Given no usable adapter is available.

Expect:

```text
bridge initialization fails or disables auto-injection explicitly
no silent no-op adapter
no false success evidence
```

## 6. Test Harness Requirements

The integration test harness should provide controlled fakes for:

```text
mcpClient.callTool
mcpClient.isReady
adapter.insertText
adapter.submitForm
adapter.getInputContent optional
window / document event dispatch where needed
execution guard store reset
storage reset
clock / timestamp control where needed
```

Tests must reset global state between cases:

```text
window globals
document body
execution guard store
storage/dedup state
circuit breaker counters
mock calls
```

## 7. Acceptance Criteria

This plan is complete when it is reviewed and merged as the testing roadmap for Gate 5 integration coverage.

The future implementation PR is complete when:

1. Required cases in section 5 have automated tests or explicitly documented deferrals.
2. Tests run in CI or the repository's normal local test command.
3. Success path and failure path are both covered.
4. Adapter resolution is covered.
5. `insertText=false` and `insertText throws` are proven to prevent submit.
6. Lifecycle callback throw after actual mutation is proven not to mask insertion success.
7. Missing `getInputContent` behavior is explicitly classified as downgraded evidence.
8. Type-check regressions introduced by the integration test implementation are fixed.

## 8. Relationship to Gate 5c

Gate 5c remains responsible for live AI consumption proof:

```text
submitForm success
  -> new assistant response / transcript delta
  -> sentinel appears in post-submit assistant output
```

Integration tests do not prove AI consumption. They prove that the production bridge, adapter, and injection contracts are internally consistent before live E2E.

Therefore recommended ordering is:

```text
1. Review current Gate 5c implementation PR.
2. Merge this integration-test plan.
3. Add integration tests for bridge/adapter contracts.
4. Re-run Gate 5c live E2E with clearer failure localization.
```

## 9. Non-Goals

Do not turn integration tests into browser automation tests.

Do not depend on Notion DOM stability beyond small adapter-level controlled DOM fixtures.

Do not make integration tests assert model behavior.

Do not treat body-level sentinel count as AI consumption proof.

## 10. Conclusion

Gate 5 has enough moving parts that unit tests plus live E2E are not sufficient.

A dedicated integration-test layer is required to prevent false positives around:

- insertion success;
- submit ordering;
- adapter resolution;
- optional readback quality;
- guard/dedup/circuit breaker behavior;
- success vs error result path classification.

This plan adds that missing layer without changing production behavior.
