# Gate 5: Auto-Submit Loop + Error Auto-Injection + Circuit Breaker

> PR branch: `feat/gate-5`
> PR: https://github.com/Houwen-He-sti/MCP-SuperAssistant/pull/19
> Issue: https://github.com/Houwen-He-sti/MCP-SuperAssistant/issues/14
> Author: Opus/Claude
> Depends on: Gate 4 (MERGED, PR #18)
> GPT Review: PR comment #4404995239 — Approve direction, request plan refinement

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

### Shared Infrastructure: `injectResultIfSafe()` Helper

**动机**（GPT Review Finding #2）：success path（Step 9-10）和 error path 共享相同的 safe-injection 逻辑。抽出共享函数避免语义漂移。

```typescript
interface InjectResultParams {
  streamId: string;
  identity: FunctionCallIdentityLike;
  callId: string;
  name: string;
  status: 'success' | 'error';
  result: unknown;
  startTime: number;
  config: StreamToolBridgeConfig;
  adapter: () => AdapterLike | null;
  emit: (...) => void;
}

type InjectOutcome =
  | 'RESULT_INJECTED'       // insertText succeeded
  | 'RESULT_SUBMITTED'      // insertText + submitForm both succeeded
  | 'INJECT_SKIPPED_NO_ADAPTER'
  | 'INJECT_SKIPPED_NO_INSPECT'
  | 'INJECT_SKIPPED_DRAFT'
  | 'INSERT_FAILED'
  | 'SUBMIT_FAILED';
```

该 helper 封装以下步骤：
1. resolve adapter → null check
2. check `getInputContent` is function → fail-closed
3. check `getInputContent()` !== null → fail-closed
4. check input empty → skip if draft
5. `formatFunctionResult({ callId, name, status, result })`
6. `insertText(formatted)` → check `=== false`
7. if `autoSubmit` → `submitForm()` → check `=== false`

**所有步骤返回 structured `InjectOutcome`**，由调用方决定是否 emit event。

---

### P0-1: Circuit Breaker Runtime Enforcement

> 实施顺序调整（GPT Review Finding #8）：先实现 breaker 保护，再开启 autoSubmit/error loop。

**问题**：`circuitBreaker.maxToolCallsPerStream` 已在 config 中预留，但没有运行时逻辑。无限循环 tool-call 可能导致：
- 无限 API 费用
- 浏览器卡死
- Notion 限流

**默认值**（GPT Review Finding #3）：

```typescript
const DEFAULT_MAX_TOOL_CALLS_PER_STREAM = 5;

// Resolution logic:
const maxCalls = config.circuitBreaker?.maxToolCallsPerStream ?? DEFAULT_MAX_TOOL_CALLS_PER_STREAM;
// maxCalls <= 0 means disabled (no limit) — explicit escape hatch only
```

- `undefined` → 默认 5（安全默认）
- 显式设为 `0` 或负数 → 无限制（escape hatch）
- 当 `autoSubmit=true` 且 `maxCalls` 为无限制 → 发出 warning log

**计数位置**（GPT Review Finding #4）：在 `reserveExecution` 成功（非 duplicate）之后、`mcpClient` 调用之前计数。只有 valid + reserved + non-duplicate 的执行尝试才消耗 budget：

```
1. stream_cutoff + enabled check
2. identity validation
3. allowlist check
4. args parse + type validation
5. callId generation
6. reserveExecution → if null (duplicate) → return
7. ⬇️ CIRCUIT BREAKER CHECK + COUNT ⬇️
8. mcpClient resolve + ready check
9. callTool execution
```

**清理**（GPT Review Finding #5）：Map 不会自然 evict。实现 TTL-based cleanup：

```typescript
interface StreamCallEntry {
  count: number;
  lastAccess: number;
}
const streamCallCounts = new Map<string, StreamCallEntry>();
const STREAM_CALL_TTL_MS = 10 * 60 * 1000; // 10 minutes

// On each handleStreamEvent entry, sweep expired entries:
function sweepExpired() {
  const now = Date.now();
  for (const [id, entry] of streamCallCounts) {
    if (now - entry.lastAccess > STREAM_CALL_TTL_MS) {
      streamCallCounts.delete(id);
    }
  }
}
```

如果后续接入 `stream_end` 事件，可以直接 `delete(streamId)`。TTL 是 fallback。

**验收标准**：
- [ ] maxToolCallsPerStream=3 → 第 4 次 valid + reserved 调用被拒绝 (CIRCUIT_BREAKER_OPEN)
- [ ] maxToolCallsPerStream=undefined → 默认 5
- [ ] maxToolCallsPerStream=0 → 无限制（escape hatch）
- [ ] 不同 streamId 独立计数
- [ ] parse failure / duplicate / allowlist reject 不消耗 budget
- [ ] 10 分钟无活动的 streamId entry 被清理
- [ ] autoSubmit=true + maxCalls 无限制 → warning log
- [ ] Unit tests: ≥6 new tests

---

### P0-2: Error Result Auto-Injection (Bridge Production Path)

**问题**：当前 bridge 中 `callTool()` 抛错时，只 emit failed event + markFailed。不会将 error result 注入 DOM。AI 看不到错误反馈。

**变更位置**：`streamToolBridge.ts` Step 6 catch block（TOOL_ERROR 和 TIMEOUT 两个 catch 路径）

**Structured Outcomes**（GPT Review Finding #1）：error path 必须有和 success path 一样的结构化语义：

| Error Code | 含义 |
|------------|------|
| `TOOL_ERROR` | callTool 抛错（现有） |
| `TIMEOUT` | 执行超时（现有） |
| `ERROR_RESULT_INJECTED` | error result 成功注入 DOM |
| `ERROR_RESULT_SUBMITTED` | error result 注入 + 提交成功 |
| `ERROR_INSERT_SKIPPED_NO_INSPECT` | fail-closed: 无法检查 input |
| `ERROR_INSERT_SKIPPED_DRAFT` | 用户有 draft，跳过注入 |
| `ERROR_INSERT_FAILED` | insertText 返回 false 或 throws |
| `ERROR_SUBMIT_FAILED` | submitForm 返回 false 或 throws |

**实现**：调用 `injectResultIfSafe()` helper：

```typescript
catch (e) {
  guard.executionGuardStore.markFailed(reservedKey, (e as Error).message);
  emit(streamId, identity, 'failed', { phase: 'tool_call', error: ... });

  // NEW: inject error result using shared safe-injection logic
  if (config.autoInsert) {
    const outcome = await injectResultIfSafe({
      streamId, identity, callId, name: identity.name!,
      status: 'error',
      result: (e as Error).message,
      startTime, config, adapter, emit,
    });
    // outcome provides structured errorCode for event emission
  }
  return;
}
```

**验收标准**：
- [ ] callTool throws + autoInsert=true + empty input → `ERROR_RESULT_INJECTED` event
- [ ] callTool throws + autoSubmit=true → `ERROR_RESULT_SUBMITTED` event
- [ ] callTool throws + user draft → `ERROR_INSERT_SKIPPED_DRAFT` event
- [ ] callTool throws + autoInsert=false → no injection (same as before)
- [ ] Timeout → same error injection pattern
- [ ] 所有 outcome 都有 structured errorCode（不 silently swallow）
- [ ] Unit tests: ≥5 new tests for error injection paths

---

### P0-3: Auto-Submit Production Path

**问题**：`autoSubmit=true` 的代码路径已存在（Gate 3C Step 10），但从未在 E2E 中验证。

**E2E 验证要求**（GPT Review Finding #6）：

E2E 测试**必须通过 production bridge path**，不能直接调用 adapter：

1. 配置 `streamToolBridge` with `enabled=true, autoInsert=true, autoSubmit=true`
2. 通过 `stream_cutoff` event 或真实 Notion stream 触发
3. 测试不直接调用 `adapter.insertText/submitForm`（仅观测）
4. 断言 `submitForm` 由 bridge 路径调用
5. AI response 消费 sentinel 无需人工 submit

**submitForm binding 问题**：Gate 4 发现 CDP 调用 submitForm 有 binding 错误。如果 production bridge context 中仍然存在：
- 必须在 **adapter/bridge production code** 中实现 fallback
- 不能只在 E2E 脚本里绕过

**Fallback 策略**：在 adapter 的 `submitForm()` 实现中添加 arrow function binding，或在 bridge 中包装调用：
```typescript
const submitFn = currentAdapter.submitForm.bind(currentAdapter);
await submitFn();
```

**验收标准**：
- [ ] autoSubmit=true → AI 收到 result 无需人工介入
- [ ] 全程通过 bridge production path（不直接调 adapter）
- [ ] 如果 submitForm 有 binding 问题 → 在 production code 中修复
- [ ] E2E: ≥2/3 次 AI 回复包含 sentinel

---

### P0-4: Scanner Reset Verification

**问题**：Gate 4 P1 "scanner 状态重置" 未被观测到。在 Gate 5 autoSubmit 闭环中，multi-turn tool loop 变成可能，scanner reset 成为关键。

**纯逻辑单元测试**（GPT Review Finding #7）：不完全依赖 AI 行为。添加 scanner 单元测试：

```typescript
// Test: createFunctionCallScanner detects function_call A → reset → detects function_call B
test('scanner detects second function_call after reset', () => {
  const scanner = createFunctionCallScanner();
  // Feed function_call A chunks
  scanner.feed(chunk_A_start);
  scanner.feed(chunk_A_end);
  expect(scanner.getResult()).toMatchObject({ name: 'echo' });
  
  // Reset scanner (simulate new stream)
  scanner.reset();
  
  // Feed function_call B chunks
  scanner.feed(chunk_B_start);
  scanner.feed(chunk_B_end);
  expect(scanner.getResult()).toMatchObject({ name: 'add' });
});
```

如果 scanner 已有类似测试，plan 引用即可。

**E2E 验证**（observation）：
1. 配置 autoSubmit=true
2. 触发 AI 调用 echo tool → bridge 执行 → result 注入 → 自动提交
3. 如果 AI 再次调用 tool → 验证 scanner 检测到第二次 function_call
4. 如果 AI 不再调用 → 记录为 P1

**验收标准**：
- [ ] Scanner 单元测试：reset 后能检测新 function_call
- [ ] E2E: 如果 multi-turn 自然发生 → scanner 检测 = PASS
- [ ] E2E: 如果 multi-turn 不自然发生 → 记录为 P1（不阻塞 merge）
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

> 调整原因（GPT Review）：开启 autoSubmit/error loop 之前，先要有 breaker 保护。

```
1. Shared infra: injectResultIfSafe() helper — 抽取 success/error 共用的 safe-injection 逻辑
2. P0-1 (circuit breaker) — per-stream 计数器 + TTL cleanup + unit tests
3. P0-2 (error auto-injection) — 使用 injectResultIfSafe() + structured outcomes + unit tests
4. Refactor: success path 也改用 injectResultIfSafe() — 保持 success/error 语义一致
5. P0-3 (autoSubmit E2E) — CDP 脚本验证 production bridge 全自动闭环
6. P0-4 (scanner reset) — 纯逻辑单元测试 + E2E observation
7. P1 (multi-turn) — stretch goal，如果 P0-3 自然触发
```

---

## 风险

| 风险 | 影响 | 缓解 |
|------|------|------|
| submitForm binding issue in production bridge | autoSubmit 不工作 | 在 production code 中 `.bind()` 或 arrow function；不在 E2E 脚本中绕过 |
| Scanner 不 reset 跨轮 | 第二轮 function_call 检测不到 | 纯逻辑单元测试验证 reset；记录 Issue，Gate 6 修复 |
| Notion 限流 | autoSubmit 导致请求被拒 | circuit breaker 默认 max=5 |
| 无限循环 | 浏览器/API 资源耗尽 | circuit breaker（默认 5）+ timeout 双保险 |
| Error injection 后 AI 仍然重试同一工具 | 循环不收敛 | circuit breaker 兜底；dedup guard 已有 |
| streamCallCounts Map 内存泄漏 | 长时间运行后 Map 过大 | TTL 10min sweep；后续接入 stream_end 可直接 delete |

---

## GPT Review Findings 处理记录

### Round 2 (Plan review)

| # | Finding | 处理 |
|---|---------|------|
| 1 | Error injection 不能 silent best-effort | ✅ 添加 structured outcomes 表 |
| 2 | 抽取 shared safe-injection logic | ✅ 新增 `injectResultIfSafe()` helper |
| 3 | Circuit breaker 默认值矛盾 (5 vs Infinity) | ✅ 统一为默认 5，`<=0` 为 escape hatch |
| 4 | Breaker 计数位置太早 | ✅ 移到 reserveExecution 成功后 |
| 5 | Map 不会自然淘汰 | ✅ 添加 TTL 10min sweep |
| 6 | AutoSubmit E2E 必须 production path | ✅ 明确不直接调 adapter |
| 7 | Scanner reset 需纯逻辑测试 | ✅ 已有 + 新增 multi-turn test |
| 8 | 实施顺序：breaker first | ✅ 调整为 breaker → error injection → autoSubmit |

### Round 3 (Code review, commit 188e74c)

| # | Finding | Severity | 处理 |
|---|---------|----------|------|
| 1 | `'error_inject'` not in phase union type | P0 | ✅ 已修复 |
| 2 | E2E missing from current diff | P0 (scope) | ⏳ 后续 commit |
| 3 | `getInputContent()` could throw in `injectResultIfSafe` | P1 | ✅ try/catch → INJECT_SKIPPED_NO_INSPECT |
| 4 | Plan naming inconsistency (ERROR_RESULT_INJECTED vs error_inject) | P1 | 🔄 见下方说明 |
| 5 | Extra test coverage for edge cases | P2 | ✅ test 69, 70 added |

**Naming note**: Plan 使用 outcome name `ERROR_RESULT_INJECTED`；实现使用 `phase='error_inject'` + `InjectOutcome` enum。两者表达同一语义，phase 是 event lifecycle 层面的标识，outcome 是 injection 结果层面的标识。保持当前设计不变。

---

## Author

Opus/Claude
