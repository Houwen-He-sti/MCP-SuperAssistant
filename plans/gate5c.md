# Gate 5c: AI Consumption / Sentinel Verification E2E

> PR branch: TBD
> PR: TBD
> Issue: https://github.com/Houwen-He-sti/MCP-SuperAssistant/issues/20 (follow-up)
> Author: Opus/Claude
> Depends on: Gate 5b (PR #21, MERGED)

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
- 不实现自动化 prompt 注入（保持 semi-automated，人工触发 AI）
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

**解决方案**: 在 E2E 脚本的 preflight 阶段加入 tool 列表检查：
```javascript
// Preflight: 确认 echo tool 已注册
const tools = await mcpClient.getAvailableTools();
const hasEcho = tools.some(t => t.name === 'echo');
if (!hasEcho) {
  console.error('echo tool not found. Available tools:', tools.map(t => t.name));
  // 尝试 force refresh
  const refreshed = await mcpClient.getAvailableTools(true);
  // ...
}
```

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
2. Prompt AI 调用 echo tool，参数包含 sentinel: `"请调用 echo 工具，参数为 {"message": "sentinel_g5c_xxx"}"`
3. Bridge 执行 echo → 返回 `{"echo": "sentinel_g5c_xxx", ...}` → 注入 → 提交
4. Poll AI 回复，检查是否包含 sentinel

### PASS 条件

```
CONSUMPTION_PASS 条件:
  - tool 调用成功 (非 error)
  - result 注入成功
  - submitForm 成功
  - AI 回复中 sentinel 出现次数 >= 2 (user message + AI echo)
    OR AI 回复中明确引用了 tool result 的内容
```

### 观测策略

由于 AI 行为不确定，采用**观测而非断言**策略：

- `CONSUMPTION_PASS`: sentinel count ≥ 2，或 AI 明确引用 tool result
- `CONSUMPTION_PARTIAL`: tool 执行成功 + 注入成功 + 提交成功，但 AI 未引用 sentinel
- `CONSUMPTION_FAIL`: tool 执行失败，或注入失败，或提交失败
- `CONSUMPTION_INCONCLUSIVE`: tool 成功但 AI 行为无法判断

---

## 实施方案

### 基础: 复用 Gate 5b 脚本

Gate 5c E2E 脚本基于 `e2e-gate5b-live-autosubmit.cjs` 扩展：

1. 增加 **preflight tool 列表检查**（确认 echo 已注册）
2. 增加 **tool 列表诊断**（如果 echo 未注册，输出可用 tools 列表）
3. 将 result 判定改为 `CONSUMPTION_PASS/PARTIAL/FAIL/INCONCLUSIVE`
4. 增加 **sentinel before/after snapshot** 对比

### 新增 Preflight 检查

```javascript
// Step 0b: Verify echo tool is registered
const toolsResult = await evalIsolated(`(function() {
  if (!window.mcpClient || !window.mcpClient.getAvailableTools) {
    return { error: 'mcpClient.getAvailableTools not available' };
  }
  return window.mcpClient.getAvailableTools().then(tools => ({
    count: tools.length,
    names: tools.map(t => t.name),
    hasEcho: tools.some(t => t.name === 'echo'),
  }));
})()`);

if (!toolsResult?.value?.hasEcho) {
  console.error('❌ echo tool not registered');
  console.log('Available tools:', toolsResult?.value?.names);
  // Diagnostic: check MCP connection status
  // ...
}
```

### Sentinel Before/After Protocol

```javascript
// Before: record sentinel count in page body
const sentinel = `sentinel_g5c_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
const beforeCount = await evalMain(`(function() {
  return (document.body.innerText.match(/${sentinel}/g) || []).length;
})()`);

// ... prompt + bridge execution ...

// After: poll for sentinel appearance
for (let round = 0; round < maxRounds; round++) {
  const afterCount = await evalMain(`(function() {
    return (document.body.innerText.match(/${sentinel}/g) || []).length;
  })()`);
  if (afterCount >= 2) {
    // CONSUMPTION_PASS: user message (1) + AI echo (1+)
    break;
  }
}
```

### Evidence Artifact

```json
{
  "gate": "5c",
  "timestamp": "...",
  "sentinel": "sentinel_g5c_xxx",
  "toolRegistration": {
    "echoRegistered": true,
    "availableTools": ["echo", "get_bridge_info", "..."],
    "totalTools": 29
  },
  "toolExecution": {
    "name": "echo",
    "params": { "message": "sentinel_g5c_xxx" },
    "result": { "echo": "sentinel_g5c_xxx", "timestamp": "...", "server": "committee-bridge-mcp" },
    "error": null
  },
  "sentinelBefore": 0,
  "sentinelAfter": 2,
  "aiResponse": "根据 echo 工具返回的结果...",
  "result": "CONSUMPTION_PASS",
  "streamLifecycle": [...],
  "events": [...]
}
```

---

## 验收标准

- [ ] Preflight 确认 echo tool 已注册
- [ ] Tool 调用成功返回 success result（非 error）
- [ ] Result 注入 + 提交成功
- [ ] Sentinel before/after 对比显示 AI 引用了 tool result
- [ ] Evidence artifact 生成 (JSON + Markdown)
- [ ] Result 为 `CONSUMPTION_PASS` 或 `CONSUMPTION_PARTIAL`

### Stretch Goals

- [ ] Multi-turn consumption: AI 调用 tool A → 消费结果 → 调用 tool B → 消费结果
- [ ] 对比 success path vs error path 的 AI 行为差异

---

## 已知风险

| 风险 | 缓解 |
|------|------|
| MCP 连接不到 committee-bridge-mcp | Preflight 检查 + 诊断输出 |
| AI 不调用 echo tool | 人工触发 prompt，明确要求 |
| AI 不引用 sentinel | 使用 PARTIAL 而非 FAIL |
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

Author: Opus/Claude
