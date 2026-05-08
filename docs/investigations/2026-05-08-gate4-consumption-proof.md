# Gate 4 Investigation Report: Result Format Upgrade + Consumption Proof

> **Date**: 2026-05-08
> **Duration**: ~6 hours — implementation, 3 rounds of GPT review
> **Outcome**: PR #18 squash-merged (`260d489`). Gate 4 PASS — all P0 items verified.
> **Key insights**: Scope precision in plan/PR language is critical for review efficiency; CDP adapter binding issues are cosmetic (DOM ops succeed before throw); Notion send button selector `[data-testid="agent-send-message-button"]` is more reliable than `adapter.submitForm()` in CDP context.

---

## 0. Session Timeline

```
~00:00  Goal: Implement Gate 4 — format upgrade + consumption proof
        Branch: feat/gate-4, based on main (after gate3c merged)

~00:30  Plan created (plans/gate4.md), committed, PR #18 opened
        GPT review Round 1: Requested plan refinement (scope, probe-before-implement)

~01:00  Plan revised per GPT feedback, committed
        GPT review Round 2: LGTM for plan

~01:30  P0-1a: Format probe (e2e-gate4-format-probe.cjs)
        - First run: all 3 formats showed "Failed to insert" — false negative
        - Root cause: adapter.insertText returns undefined (not true/false)
          Script checked `!ok` which was falsy for undefined → false positive failure
        - Fix: check `error` field instead of `!ok`
        - Second run: 3/3 formats inject successfully

~02:30  P0-1b: Formatter upgrade
        - functionResultFormatter.ts: bare XML → protocol spec CDATA
        - status: 'ok' → 'success', escapeXmlBody → escapeCdata
        - 10/10 unit tests updated and passing
        - streamToolBridge.ts: caller updated
        - 55/55 bridge tests updated and passing

~03:00  P0-regression: Gate 3C E2E — 16/16 PASS

~03:30  P0-2: Success consumption proof
        - First attempt (e2e-gate4-auto-submit.cjs): adapter.submitForm() throws
          binding error → submit fails
        - Root cause: adapter methods throw `this.emitExecutionFailed is not a function`
          when called from CDP (binding issue). DOM operations succeed before throw.
        - Fix (v2): click send button via DOM selector directly
          `[data-testid="agent-send-message-button"]`
        - Second attempt: initial INCONCLUSIVE (sentinel count=1, tab title changed)
        - Fix: broader tab URL matching (notion.so, not just /agent/)
        - Third attempt: 3/3 PASS

~04:30  P0-3: Error consumption proof
        - 3/3 PASS (error IDs echoed by AI)

~05:00  GPT code review Round 3: "Request changes"
        P0: error path mismatch — bridge doesn't auto-inject error results
        Decision: Option B (scope narrowing, not Option A implementation)
        Rationale: Gate 4 title is "Manual Result Injection" — production
        error auto-injection belongs to Gate 5

~05:30  Fix: plan/PR scope clarified, evidence doc created, script headers added
        GPT re-review: LGTM

~06:00  Squash merge to main (260d489)
```

---

## 1. Project Principle: Scope Precision in Plan Language

### The Problem

Plan P0-3 originally said:
> "配置一个会失败的 MCP tool → bridge 执行 → 工具返回 error → 注入输入框"

This implied the production bridge handles error-result injection. But the E2E test actually did direct injection (bypassing the bridge). GPT correctly flagged the mismatch.

### The Fix

Rewrote P0-3 to explicitly say "Manual/Direct Injection Only":
> "P0-3 仅验证 error-format 的 consumption（AI 能理解错误 XML），**不验证** production bridge 的 tool-failure → error-result auto-injection 路径。"

### Reusable Principle

> **Plan language must precisely describe the test path, not just the outcome.** "AI consumes error result" is ambiguous — it could mean manual injection or production bridge. Write "AI consumes a **directly injected** error result block" to prevent scope creep during review.

> **Corollary**: When a reviewer says "this P0 item doesn't match your implementation," the first question is whether the plan wording is too broad, not whether the implementation is too narrow. Scope narrowing (Option B) is often the correct response.

---

## 2. Engineering Pattern: CDP Adapter Binding Issues Are Cosmetic

### The Problem

Calling `adapter.insertText()` from CDP (ISOLATED world, via `Runtime.evaluate`) works at the DOM level but throws:
```
this.emitExecutionFailed is not a function
```

This happens because the adapter instance loses its `this` binding to the bridge context when called from CDP's evaluate sandbox.

### Key Insight

**The DOM operations succeed before the throw.** The text is inserted, the cursor is positioned, the content is correct. The throw happens in the post-operation lifecycle callback (`emitExecutionFailed`/`emitExecutionCompleted`), which is bridge plumbing, not DOM manipulation.

### Practical Consequence

For CDP E2E tests, you can safely ignore the binding error and use a fallback for submit:
```javascript
// Insert: use adapter (works despite throw)
const result = await adapter.insertText(text);
// result.threw exists but DOM is correct

// Submit: DON'T use adapter.submitForm() — use DOM click
const btn = document.querySelector('[data-testid="agent-send-message-button"]');
btn?.click();
```

### Reusable Principle

> **When a method throws after completing its side effect, check whether the throw is from the core operation or from lifecycle plumbing.** If plumbing, the operation succeeded — use alternative methods for the parts that failed.

---

## 3. Engineering Pattern: adapter.insertText() Return Value Semantics

### The Problem

Gate 3C established `insertText() → Promise<boolean>`, but older adapter implementations return `Promise<void>` (i.e., `undefined`). The format probe script checked:

```javascript
if (!ok) { console.log('Failed'); }  // ❌ undefined → !undefined → true → false negative
```

### The Fix

```javascript
const result = await adapter.insertText(text);
if (result.error) { console.log('Failed'); }  // ✅ check error field, not truthiness
```

### Connection to Gate 3C `=== false` Pattern

This is the same backward-compat issue from Gate 3C (§1 of that investigation). The bridge uses `=== false`, probe scripts should also avoid truthiness checks on void-compatible returns.

---

## 4. Test Results

### Format Probe (P0-1a)

| Format | Description | Injected | Sentinel |
|--------|------------|----------|----------|
| A | Bare XML (status=ok) | ✅ | sentinel_mowmhzwn_0ccs |
| B | Protocol CDATA (status=success) | ✅ | sentinel_mowmi41a_40a9 |
| C | Bare XML + NL preamble | ✅ | sentinel_mowmi89l_ek66 |

Decision: Format B chosen (protocol-compliant, CDATA prevents escaping issues).

### Success Consumption (P0-2)

| Attempt | Sentinel | AI Echoed | Result |
|---------|----------|-----------|--------|
| 1 | sentinel_g4_mowmq2qr_94lo | ✅ count=2 | PASS |
| 2 | sentinel_g4_mowmqddj_ythq | ✅ count=2 | PASS |
| 3 | sentinel_g4_mowmqnj0_1t49 | ✅ count=2 | PASS |

### Error Consumption (P0-3 — Direct Injection Only)

| Attempt | Error ID | AI Echoed | Result |
|---------|----------|-----------|--------|
| 1 | err_mowmrpfi_378c | ✅ | PASS |
| 2 | err_mowms1re_use3 | ✅ | PASS |
| 3 | err_mowmsaze_54cd | ✅ | PASS |

Note: Error results were directly injected via CDP adapter, NOT through the production bridge tool-failure path. Production error auto-injection is deferred to Gate 5.

### Gate 3C Regression (P0-regression)

16/16 PASS (adapter-only insert 6/6, full bridge 6/6, draft protection 4/4).

### Unit Tests

65/65 PASS (functionResultFormatter 10/10, streamToolBridge 55/55).

### Scanner Observation (P1)

Not observed (AI did not spontaneously call a second tool). Defer to Gate 5.

---

## 5. Deferred Items

| Item | Severity | Target |
|------|----------|--------|
| Production error-result auto-injection | P0 for Gate 5 | Bridge: callTool throws → formatFunctionResult({status:'error'}) → insertText |
| Formatter hardening (BigInt, circular, post-escape truncation) | P1 | Follow-up issue |
| Scanner reset verification | P1 | Gate 5 |
