# Gate 5: Auto-Submit Loop + Error Auto-Injection + Circuit Breaker

> PR branch: `feat/gate-5`
> Issue: https://github.com/Houwen-He-sti/MCP-SuperAssistant/issues/14
> Author: Opus/Claude
> Depends on: Gate 4 (MERGED, PR #18)

---

## 目标

实现**完全自动化的 tool-loop 闭环**：AI 输出 function_call → stream cutoff → bridge 执行工具 → 格式化 result → 注入 DOM → **自动提交** → AI 消费 result → 可能再次 function_call → 循环。

Gate 4 证明了 AI 能消费注入的 result（手动提交）。Gate 5 补全自动化：**autoSubmit + error auto-injection + 循环保护**。

---

## 非目标

- 不实现多 provider 适配（Gate 6）
- 不修改 MAIN world interceptor 或 scanner 逻辑（除 scanner reset 验证）
- 不实现 UI 面板 / status indicator
- 不修改 Notion adapter 核心逻辑（仅使用现有 insertText + submitForm）
- 不处理超过单个 tool-call per stream 的并发场景（deferred）

---

## 前置条件

| 条件 | 状态 | 说明 |
|------|------|------|
| Gate 4 merged | ✅ | PR #18, squash `260d489` |
| Format B consumption verified | ✅ | Gate 4 P0-2 3/3 |
| Error format consumption verified | ✅ | Gate 4 P0-3 3/3 |
| `autoSubmit` config field | ✅ | Gate 3C-prep, 存在但未启用 |
| `circuitBreaker` config field | ✅ | Gate 3C-prep reserved, 未实现运行时逻辑 |
| adapter.submitForm() | ✅ | Gate 3C, 已有 try/catch + `=== false` |

---

## 技术方案

### P0-1: Error Result Auto-Injection (Bridge Production Path)

**问题**：当前 bridge 中 `callTool()` 抛错时，只 emit failed event + markFailed。不会将 error result 注入 DOM。AI 看不到错误反馈。

**变更位置**：`streamToolBridge.ts` Step 6 catch block

**当前行为**：
```typescript
catch (e) {
  guard.executionGuardStore.markFailed(reservedKey, (e as Error).message);
  emit(streamId, identity, 'failed', { phase: 'tool_call', error: ... });
  return;  // ← 直接 return，不注入
}
```

**目标行为**：
```typescript
catch (e) {
  guard.executionGuardStore.markFailed(reservedKey, (e as Error).message);
  emit(streamId, identity, 'failed', { phase: 'tool_call', error: ... });

  // NEW: inject error result for AI consumption (if autoInsert enabled)
  if (config.autoInsert) {
    const currentAdapter = adapter();
    if (currentAdapter && typeof currentAdapter.getInputContent === 'function') {
      const existingContent = currentAdapter.getInputContent();
      if (existingContent !== null && !existingContent) {
        // Input empty → safe to inject error result
        const formattedError = formatFunctionResult({
          callId,
          name: identity.name!,
          status: 'error',
          result: (e as Error).message,
        });
        try {
          await currentAdapter.insertText(formattedError);
          // If autoSubmit, submit the error result too
          if (config.autoSubmit && typeof currentAdapter.submitForm === 'function') {
            await currentAdapter.submitForm();
          }
        } catch {
          // Best-effort — error injection failure is non-fatal
        }
      }
    }
  }
  return;
}
```

**验收标准**：
- [ ] callTool throws + autoInsert=true + empty input → error result injected
- [ ] callTool throws + user draft → error result NOT injected
- [ ] callTool throws + autoInsert=false → no injection (same as before)
- [ ] Timeout → error result injected (same pattern)
- [ ] Unit tests: ≥3 new tests for error injection paths

---

### P0-2: Auto-Submit Production Path

**问题**：`autoSubmit=true` 的代码路径已经存在（Gate 3C Step 10），但从未在 E2E 中验证。需要证明：

1. bridge 成功执行工具 → insertText → submitForm → AI 收到 result
2. 整个流程无需人工介入

**当前代码**（已存在，无需修改）：
```typescript
if (config.autoSubmit && typeof currentAdapter.submitForm === 'function') {
  const submitOk = await currentAdapter.submitForm();
  // ... error handling
}
```

**验证方法**：CDP E2E 测试。

**注意**：Gate 4 E2E 发现 `adapter.submitForm()` 在 CDP 调用时有 binding 问题（`this.emitExecutionFailed is not a function`）。这是 CDP 沙箱的限制，production bridge 中 adapter 的 `this` 绑定是正确的。但需要验证。

**测试策略**：

1. 通过 CDP 配置 bridge: `enabled=true, autoInsert=true, autoSubmit=true`
2. 设置 mock mcpClient（echo tool）
3. 通过 postMessage 发送 stream_cutoff 事件
4. 观察 bridge 是否执行 insertText + submitForm
5. 观察 AI 是否收到 result 并回复

如果 submitForm 在 production bridge context 中仍然 throws binding error：
- 需要调查 adapter instance 的 this 绑定
- 或在 bridge 中添加 fallback: DOM click send button

**验收标准**：
- [ ] autoSubmit=true → AI 收到 result 无需人工介入
- [ ] 如果 submitForm 有 binding 问题 → 实现 fallback
- [ ] E2E: ≥2/3 次 AI 回复包含 sentinel

---

### P0-3: Circuit Breaker Runtime Enforcement

**问题**：`circuitBreaker.maxToolCallsPerStream` 已在 config 中预留，但没有运行时逻辑。无限循环 tool-call 可能导致：
- 无限 API 费用
- 浏览器卡死
- Notion 限流

**实现**：在 `createStreamToolHandler` 中添加 per-stream 计数器。

```typescript
// In createStreamToolHandler:
const streamCallCounts = new Map<string, number>();

// Inside handleStreamEvent, after checking enabled:
const currentCount = streamCallCounts.get(streamId) || 0;
const maxCalls = config.circuitBreaker?.maxToolCallsPerStream ?? Infinity;
if (currentCount >= maxCalls) {
  emit(streamId, identity, 'failed', {
    phase: 'reserve',
    error: `Circuit breaker: max ${maxCalls} tool calls per stream exceeded`,
    errorCode: 'CIRCUIT_BREAKER_OPEN',
  });
  return;
}
streamCallCounts.set(streamId, currentCount + 1);
```

**默认值**：`maxToolCallsPerStream = 5`（合理的单轮对话工具调用上限）。

**清理**：stream_end 事件时清除对应 streamId 的计数。如果暂时没有 stream_end 接入，则不做清理（Map 自然淘汰旧 streamId）。

**验收标准**：
- [ ] maxToolCallsPerStream=3 → 第 4 次调用被拒绝 (CIRCUIT_BREAKER_OPEN)
- [ ] maxToolCallsPerStream=undefined → 不限制（向后兼容）
- [ ] 不同 streamId 独立计数
- [ ] Unit tests: ≥4 new tests

---

### P0-4: Scanner Reset Verification

**问题**：Gate 4 P1 "scanner 状态重置" 未被观测到（AI 没有自发调用第二个工具）。在 Gate 5 autoSubmit 闭环中，multi-turn tool loop 变成可能，scanner reset 成为关键。

**验证方法**：

1. 配置 autoSubmit=true
2. 触发 AI 调用 echo tool → bridge 执行 → result 注入 → 自动提交
3. 如果 AI 再次调用 echo tool → 验证 scanner 检测到第二次 function_call
4. 如果 AI 不再调用 → 记录 "需要 prompt engineering" 引导 AI 多轮调用

**验收标准**：
- [ ] 如果 multi-turn 自然发生 → scanner 检测第二次 function_call = PASS
- [ ] 如果 multi-turn 不自然发生 → 记录为 P1（不阻塞 merge）
- [ ] 如果 scanner 未检测到 → 创建 Issue 并标记 blocker

---

### P1: Multi-Turn Loop E2E (Stretch Goal)

**目标**：证明 2+ 轮 tool-call loop 全自动工作。

**方法**：设计一个 prompt + tool 组合，使 AI 自发调用 tool 两次。例如：

```
System: You have access to echo(message) and add(a, b) tools.
User: First echo "hello", then add 2+3.
```

如果 AI 输出两个 function_call → scanner 检测到两次 → bridge 执行两次 → AI 两次消费 → 验证。

**验收标准**：
- [ ] 2 轮 tool-call loop 全自动完成
- [ ] 或记录为 Gate 6 defer（不阻塞 Gate 5 merge）

---

## 实施顺序

```
1. P0-1 (error auto-injection) — 修改 bridge catch block + 新 unit tests
2. P0-3 (circuit breaker) — 添加 per-stream 计数器 + unit tests
3. P0-2 (autoSubmit E2E) — CDP 脚本验证全自动闭环
4. P0-4 (scanner reset) — 在 P0-2 过程中观测
5. P1 (multi-turn) — stretch goal，如果 P0-2 自然触发
```

---

## 风险

| 风险 | 影响 | 缓解 |
|------|------|------|
| submitForm binding issue in production bridge | autoSubmit 不工作 | 调查 this 绑定；fallback 到 DOM click |
| Scanner 不 reset 跨轮 | 第二轮 function_call 检测不到 | 记录 Issue，Gate 6 修复 scanner reset |
| Notion 限流 | autoSubmit 导致请求被拒 | circuit breaker 默认 max=5 |
| 无限循环 | 浏览器/API 资源耗尽 | circuit breaker + timeout 双保险 |
| Error injection 后 AI 仍然重试同一工具 | 循环不收敛 | circuit breaker 兜底；Gate 6 可以加 prompt hint |

---

## Author

Opus/Claude
