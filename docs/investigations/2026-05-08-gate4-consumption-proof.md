# Gate 4: Consumption Proof Evidence

> Date: 2026-05-08
> Author: Opus/Claude
> PR: https://github.com/Houwen-He-sti/MCP-SuperAssistant/pull/18
> Branch: `feat/gate-4`

---

## Format Variant Chosen

**Format B** — Protocol spec §2.1/§2.2 (CDATA wrapper)

```xml
<function_results>
  <result call_id="..." name="..." status="success">
    <content type="application/json"><![CDATA[
{"message":"..."}
    ]]></content>
  </result>
</function_results>
```

### Probe Results (P0-1a)

All 3 candidate formats injected successfully into Notion AI input:

| Format | Description | Injected | Sentinel |
|--------|------------|----------|----------|
| A | Bare XML (status=ok) | ✅ | sentinel_mowmhzwn_0ccs |
| B | Protocol CDATA (status=success) | ✅ | sentinel_mowmi41a_40a9 |
| C | Bare XML + NL preamble | ✅ | sentinel_mowmi89l_ek66 |

Decision: Format B chosen (protocol-compliant, CDATA prevents escaping issues).

---

## Success Consumption (P0-2)

Script: `scripts/e2e-gate4-auto-submit-v2.cjs`
Method: CDP → ISOLATED world adapter.insertText() → DOM click `[data-testid="agent-send-message-button"]` → wait for AI response → check sentinel count in page.

| Attempt | Sentinel | AI Echoed | Result |
|---------|----------|-----------|--------|
| 1 | sentinel_g4_mowmq2qr_94lo | ✅ count=2 | PASS |
| 2 | sentinel_g4_mowmqddj_ythq | ✅ count=2 | PASS |
| 3 | sentinel_g4_mowmqnj0_1t49 | ✅ count=2 | PASS |

**Result: 3/3 PASS** — AI consumed success results and echoed sentinel values.

---

## Error Consumption (P0-3)

> **Scope**: P0-3 verifies that Notion AI can understand a **manually/directly injected** error result block. It does NOT verify production bridge behavior for tool-call failure → error-result auto-injection. Production error-result auto-injection is deferred to Gate 5.

Script: `scripts/e2e-gate4-error-submit.cjs`
Method: CDP → construct error-format XML → adapter.insertText() → DOM click send button → wait for AI response → check error ID in page.

Error format injected:
```xml
<function_results>
  <result call_id="err_probe" name="echo" status="error">
    <error type="ToolExecutionError"><![CDATA[
Tool execution failed: err_XXXXX — simulated connection refused
    ]]></error>
  </result>
</function_results>
```

| Attempt | Error ID | AI Echoed | Result |
|---------|----------|-----------|--------|
| 1 | err_mowmrpfi_378c | ✅ | PASS |
| 2 | err_mowms1re_use3 | ✅ | PASS |
| 3 | err_mowmsaze_54cd | ✅ | PASS |

**Result: 3/3 PASS** — AI acknowledged error content and echoed error IDs.

---

## Gate 3C Regression (P0-regression)

Script: `scripts/e2e-gate3c-injection.cjs`

| Section | Tests | Result |
|---------|-------|--------|
| P0-2a Adapter-Only Insert | 6/6 | ✅ |
| P0-2b Full Bridge autoInsert | 6/6 | ✅ |
| P0-3 Draft Protection | 4/4 | ✅ |
| **Total** | **16/16** | **✅ PASS** |

---

## Unit Tests

| File | Tests | Result |
|------|-------|--------|
| functionResultFormatter.test.ts | 10/10 | ✅ |
| streamToolBridge.test.ts | 55/55 | ✅ |
| **Total** | **65/65** | **✅ PASS** |

---

## Scanner Observation (P1)

During P0-2 consumption tests, scanner behavior was observed to be normal.
No anomalies detected in console output. Second-round scanner detection was not naturally triggered (AI did not call a second tool spontaneously).

**Conclusion**: Not observed (no failure). Defer hard requirement to Gate 5.

---

## Known Limitations

1. **adapter.insertText() throws** `this.emitExecutionFailed is not a function` when called from CDP (binding issue) — but DOM operations succeed before the throw. Non-blocking.
2. **adapter.submitForm() also throws** same binding error — solved by clicking send button via DOM selector directly.
3. **Production error auto-injection** not implemented — error results must be manually injected. Deferred to Gate 5.
