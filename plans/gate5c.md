# Gate 5c: Success-Path Tool Execution + Same-Turn Consumption Boundary Discovery

> PR branch: `feat/gate-5c`
> PR: #22
> Issue: https://github.com/Houwen-He-sti/MCP-SuperAssistant/issues/20 (follow-up)
> Author: Opus/Claude
> Depends on: Gate 5b (PR #21, MERGED)
> **Status: CLOSED — Redefined as pipeline proof + architecture discovery**
> **Outcome: Same-turn consumption proved impossible. See retrospective at bottom.**

---

## 目标

验证 AI 实际**消费**了 bridge 注入的 tool result，完成 auto-submit loop 的最终闭环。

Gate 5b 已证明 bridge pipeline 正确工作（stream detect → callTool → insertText → submitForm）。Gate 5c 的目标是验证：

1. **Success path**: tool 调用成功返回结果（而非 error），result 被注入并提交
2. **AI consumption**: AI 在后续回复中引用/使用了注入的 tool result

---

## 非目标

- 不修改 bridge pipeline 代码（已在 Gate 5b 验证）
- 不追求 100% 确定性的 AI 行为断言（AI 行为本质上是非确定性的）
- 不实现自动化 prompt 注入（~~保持 semi-automated，人工触发 AI~~ 实际实现为全自动：CDP 注入 prompt 并提交，与 Gate 5b 一致）
- 不要求 multi-turn 验证（单次 tool call → consumption 即可）

---

## 前置条件

1. Gate 5b 已 merge（PR #21 ✅）
2. Chrome with `--remote-debugging-port=9222`
3. Notion agent page 打开
4. **MCP server 连接正常且 echo tool 已注册**（这是 Gate 5b 的 gap）
5. bridge 配置 autoInsert=true + autoSubmit=true

---

## Gate 5b 已知 Gap 分析

### Gap 1: echo tool 未注册

Gate 5b evidence 显示：
```
Tool "echo" is not registered in the current MCP tool registry
```

根源分析（需要在 E2E 前确认）：
- **假设 A**: mcpClient 连接的不是 committee-bridge-mcp（可能是其他 MCP server 或 proxy 配置错误）
- **假设 B**: tool 列表未完全加载（timing issue — preflight 检查通过但 tools 列表是空的或不完整的）
- **假设 C**: proxy (mcp-superassistant-proxy) 没有正确转发 echo tool

**解决方案**: Phase 0 preflight gate（见下方实施方案）— 先发现实际 runtime API surface，再选择可用的 tool 列表 API 或 fallback 到直接 probe。

### Gap 2: Error path vs Success path

Gate 5b 走的是 error-result path（echo 未注册 → 注入 error XML）。Gate 5c 需要走 success path（echo 注册 → 注入成功结果）。

区别：
| 场景 | 注入内容 | AI 行为 |
|------|---------|--------|
| Error path | `<error>Tool "echo" is not registered...</error>` | AI 可能提到错误但不会有有用信息 |
| Success path | `{"echo":"sentinel_xxx","timestamp":"..."}` | AI 应该能引用 echo 的返回值 |

---

## Sentinel Verification Protocol

### 设计

1. 生成唯一 sentinel: `sentinel_g5c_{timestamp}_{random}`
2. **Baseline snapshot**: 记录 prompt 前的 transcript / assistant message 状态
3. Prompt AI 调用 echo tool，参数包含 sentinel: `"请调用 echo 工具，参数为 {"message": "sentinel_g5c_xxx"}"`
4. Bridge 执行 echo → 返回 `{"echo": "sentinel_g5c_xxx", ...}` → 注入 → 提交
5. 记录 insertText payload，确认 success result 包含 sentinel
6. 等到 submitForm_result 成功后，记录 submit timestamp
7. **Post-submit delta**: 只在 submit 后的新 assistant response / transcript delta 中查 sentinel

### Consumption Evidence Levels

> GPT Review P1: body-level sentinel count 太弱，容易误判（sentinel 可能出现在 user prompt / injected XML / debug text）

三级 evidence quality：

| Level | 方法 | 可靠性 |
|-------|------|--------|
| `assistant_delta` | Submit 后监控新 assistant response，在 delta 文本中查 sentinel | ✅ 最可靠 |
| `transcript_diff` | 对比 submit 前后 transcript，在 diff 部分查 sentinel | 中等 |
| `body_count_only` | 全页面 body.innerText sentinel count | ⚠️ 仅作补充证据，不能单独作为 PASS |

### PASS 条件

> GPT Review P1: CONSUMPTION_PARTIAL 不能关闭 Gate 5c

```
CONSUMPTION_PASS 需要同时满足:
1. MCP runtime identity 和 tool registry 已记录
2. Sentinel-capable tool 在测试开始前已注册
3. Tool 调用成功返回 non-error result
4. insertText payload 是 success <function_results> block，包含 sentinel
5. adapter.submitForm 在 insertText 后成功
6. Submit 后的新 assistant response / transcript delta 中引用了 sentinel 或明确 cite 了 tool result
7. JSON + Markdown evidence artifact 包含 ordered events 和 response snippets
```

**尝试预算**: 最多 3 次尝试（每次使用不同 sentinel）：
- ≥1 次 assistant-delta-confirmed consumption → **CONSUMPTION_PASS**
- Success path 可工作但 AI 没引用 sentinel → **CONSUMPTION_PARTIAL**（不关闭 Gate 5c，记录 follow-up）
- Tool 执行/注入/提交失败 → **CONSUMPTION_FAIL**

### Evidence Artifact 结构

```json
{
  "sentinelBeforePrompt": 0,
  "sentinelAfterInsert": 1,
  "sentinelAfterSubmit": 1,
  "assistantDeltaAfterSubmit": "...",
  "assistantDeltaContainsSentinel": true,
  "consumptionEvidenceQuality": "assistant_delta | transcript_diff | body_count_only | manual_review_required"
}
```

---

## 实施方案

### Phase 0: MCP Registry Diagnosis (Preflight Gate)

> GPT Review P1: echo 未注册 root cause 需要成为明确 Phase 0 gate
> GPT Review P1: 不能假设 getAvailableTools() 存在

**Phase 0 必须在 consumption test 前完成。如果 Phase 0 失败则停止，不继续跑 consumption。**

```javascript
// Phase 0: Discover actual runtime API surface
const runtimeSurface = await evalIsolated(`(function() {
  const surface = {
    hasCallTool: typeof window.mcpClient?.callTool === 'function',
    hasIsReady: typeof window.mcpClient?.isReady === 'function',
    hasGetAvailableTools: typeof window.mcpClient?.getAvailableTools === 'function',
    hasGetTools: typeof window.mcpClient?.getTools === 'function',
    // Check if tool list can be discovered from sidebar/registry
    mcpClientKeys: window.mcpClient ? Object.keys(window.mcpClient) : [],
  };
  return surface;
})()`);

// If getAvailableTools exists, use it
if (runtimeSurface.hasGetAvailableTools) {
  const tools = await mcpClient.getAvailableTools();
  // Record tool list, check for echo
} else {
  // Fallback: try calling echo directly and inspect error
  // "not registered" = server reachable but tool missing
  // other error = different problem
}

// Confirm connected server identity
const serverInfo = await evalIsolated(`(function() {
  // Try to discover server identity from mcpClient internals
  // or call get_bridge_info if available
  return window.mcpClient?.serverInfo || null;
})()`);
```

**Phase 0 输出**:
- Connected server identity
- Available tool names
- Whether echo (or alternative sentinel tool) is registered
- If echo missing: exact diagnostic and stop

**Alternative sentinel tool**: 如果 echo 不可用，plan 需要一个替代方案：
- 任何 tool 只要 result 中包含 caller-controlled unique string 即可
- 例如: `get_bridge_info` 可能返回包含 request 参数的结果

### 基础: 复用 Gate 5b 脚本

Gate 5c E2E 脚本基于 `e2e-gate5b-live-autosubmit.cjs` 扩展：

1. 增加 **preflight tool 列表检查**（确认 echo 已注册）
2. 增加 **tool 列表诊断**（如果 echo 未注册，输出可用 tools 列表）
3. 将 result 判定改为 `CONSUMPTION_PASS/PARTIAL/FAIL/INCONCLUSIVE`
4. 增加 **sentinel before/after snapshot** 对比

### 新增 Sentinel Before/After Protocol (Post-Submit Delta)

```javascript
// Step 1: Generate unique sentinel
const sentinel = `sentinel_g5c_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;

// Step 2: Baseline snapshot (before prompt)
const baseline = await evalMain(`(function() {
  // Capture assistant message elements or transcript state
  const assistantMsgs = document.querySelectorAll('[data-assistant-message]');
  return {
    assistantMessageCount: assistantMsgs.length,
    lastAssistantText: assistantMsgs[assistantMsgs.length - 1]?.innerText?.slice(-200) || '',
    bodyTextLength: document.body.innerText.length,
    sentinelCountInBody: (document.body.innerText.match(/${sentinel}/g) || []).length,
  };
})()`);

// Step 3: ... prompt + bridge execution + insertText + submitForm ...

// Step 4: Post-submit delta monitoring
// Wait for new assistant response after submitForm_result
for (let round = 0; round < maxRounds; round++) {
  const postSubmit = await evalMain(`(function() {
    const assistantMsgs = document.querySelectorAll('[data-assistant-message]');
    const newCount = assistantMsgs.length;
    const lastText = assistantMsgs[newCount - 1]?.innerText || '';
    return {
      assistantMessageCount: newCount,
      lastAssistantText: lastText.slice(-500),
      sentinelInLastAssistant: lastText.includes('${sentinel}'),
      sentinelCountInBody: (document.body.innerText.match(/${sentinel}/g) || []).length,
      bodyTextLength: document.body.innerText.length,
    };
  })()`);

  if (postSubmit.assistantMessageCount > baseline.assistantMessageCount
      && postSubmit.sentinelInLastAssistant) {
    // CONSUMPTION_PASS: new assistant response references sentinel
    evidenceQuality = 'assistant_delta';
    break;
  }

  if (postSubmit.sentinelCountInBody > baseline.sentinelCountInBody + 1) {
    // Possible consumption, but only body-level evidence
    evidenceQuality = 'body_count_only'; // supplemental only, not PASS-worthy alone
  }
}
```

### Evidence Artifact

```json
{
  "gate": "5c",
  "timestamp": "...",
  "sentinel": "sentinel_g5c_xxx",
  "attempts": 1,
  "toolRegistration": {
    "phase0Passed": true,
    "echoRegistered": true,
    "availableTools": ["echo", "get_bridge_info", "..."],
    "totalTools": 29,
    "serverIdentity": "committee-bridge-mcp",
    "runtimeApiSurface": { "hasCallTool": true, "hasIsReady": true, "hasGetAvailableTools": false }
  },
  "toolExecution": {
    "name": "echo",
    "params": { "message": "sentinel_g5c_xxx" },
    "result": { "echo": "sentinel_g5c_xxx", "timestamp": "...", "server": "committee-bridge-mcp" },
    "error": null
  },
  "consumptionEvidence": {
    "sentinelBeforePrompt": 0,
    "sentinelAfterInsert": 1,
    "sentinelAfterSubmit": 2,
    "assistantDeltaAfterSubmit": "根据 echo 工具返回的结果，sentinel_g5c_xxx ...",
    "assistantDeltaContainsSentinel": true,
    "consumptionEvidenceQuality": "assistant_delta"
  },
  "result": "CONSUMPTION_PASS",
  "streamLifecycle": [...],
  "events": [...]
}
```

---

## 验收标准

- [ ] **Phase 0 preflight gate 通过**: MCP runtime identity 确认 + echo (或替代 sentinel tool) 注册
  - 如果 echo 未注册，脚本停止并输出完整诊断（available tools, server info）
- [ ] 工具 registry preflight 使用**实际 runtime API**（不假设 `getAvailableTools()` 存在）
- [ ] Tool 调用成功返回 success result（非 error）
- [ ] Result 注入 + 提交成功
- [ ] Post-submit assistant delta 对比显示 AI 引用了 tool result (sentinel)
- [ ] Evidence artifact 生成 (JSON + Markdown)，包含 `consumptionEvidenceQuality` level
- [ ] Result 为 **CONSUMPTION_PASS**（最多 3 次尝试中 ≥1 次 assistant-delta-confirmed）
  - CONSUMPTION_PARTIAL 只是诊断证据，**不关闭 Gate 5c**

### Stretch Goals

- [ ] Multi-turn consumption: AI 调用 tool A → 消费结果 → 调用 tool B → 消费结果
- [ ] 对比 success path vs error path 的 AI 行为差异

---

## 已知风险

| 风险 | 缓解 |
|------|------|
| MCP 连接不到 committee-bridge-mcp | Phase 0 preflight gate + 诊断输出 |
| echo 未注册 | Phase 0 hard gate：停止并诊断，不继续 consumption test |
| AI 不调用 echo tool | 人工触发 prompt，明确要求 |
| AI 不引用 sentinel | 最多 3 次尝试；仍未引用则 PARTIAL（不关闭 Gate 5c）|
| `getAvailableTools()` API 不存在 | Fallback: 直接调用 echo，根据 error type 判断注册状态 |
| Proxy 不稳定 | 检查 proxy status in preflight |
| Notion DOM 变化导致 adapter 失败 | 复用 Gate 5b 已验证的 adapter |

---

## 与 Gate 5b 的关系

```
Gate 5b (MERGED): Bridge Pipeline E2E
  ✅ stream detect → function_call → callTool → insertText → submitForm
  ✅ Error path works (tool not registered → error injected → submitted)
  ✅ Stream lifecycle captured
  
Gate 5c (THIS): AI Consumption Verification
  🎯 Success path works (tool registered → success result → submitted)
  🎯 AI consumes injected result (sentinel verification)
  🎯 Full loop: AI → tool → result → AI reads it → AI responds with knowledge
```

---

## 预估工作量

Gate 5c 的代码改动量很小：
1. 复制 `e2e-gate5b-live-autosubmit.cjs` 为 `e2e-gate5c-consumption.cjs`
2. 添加 preflight tool 检查（~20 行）
3. 修改 result 判定逻辑（~10 行）
4. 确保 MCP 连接正确（需要诊断 echo 未注册的根因）

**主要不确定性**: echo 未注册的根因——如果是 proxy 配置问题，可能需要额外调试。

---

## Retrospective: Outcome + Architecture Discovery (2026-05-11)

### Final Status: PIPELINE_SUCCESS + SAME_TURN_CONSUMPTION_UNSUPPORTED

Gate 5c originally aimed to prove AI consumption of tool results. After extensive testing (10+ E2E runs across sentinel and timestamp methods), we discovered:

**What was proven:**
1. ✅ callTool intercept works (~89% success; fails only when AI doesn't invoke tool)
2. ✅ Tool execution + result return: 100% (when callTool triggers)
3. ✅ callTool_result contains sentinel/timestamp: 100%

**What was disproven:**
4. ❌ Same-turn AI consumption of tool results: **architecturally impossible**

### Root Cause

The bridge injects results AFTER the AI finishes its current response. The AI can only see injected results in the NEXT turn. This is not a bug — it's the architecture of DOM next-turn injection.

### Evidence

- 5/5 timestamp verification attempts failed
- AI explicitly states: "目前尚未收到返回，因此无法编造 timestamp"
- Earlier sentinel PASS was AI echoing prompt text, not tool result consumption

### Redefinition

Gate 5c is now closed as:
- **Pipeline proof**: success-path callTool → execution → result return works
- **Boundary discovery**: same-turn consumption does not happen in this architecture
- **Pointer to #24**: true consumption verification requires cross-turn ACK (VSCode-Dir Issue #24)

### Follow-up

- Gate 5c.1: Bridge-level result handoff ACK (production bridge emits event)
- Gate 5d: Cross-turn model ACK (AI confirms receipt in next turn)
- Full retrospective: `VSCode-Dir/docs/investigations/2026-05-11-gate5c-retrospective-methodology-failure.md`

Author: Opus/Claude
