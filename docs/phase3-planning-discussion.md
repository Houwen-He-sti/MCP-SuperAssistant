# Phase 3 Planning Discussion: Stream Tool Bridge Implementation

> **Related Phases:**
> - Phase 1: PR #4 — `feat(stream): MAIN world fetch interceptor for Notion AI` (MERGED)
> - Phase 2: Cutoff code已包含在PR #4中 (`cutoffEnabled=false`)
> - Phase 3 Plan: [`plans/stream-intercept-phase3.md`](../../plans/stream-intercept-phase3.md)
> - Phase 2 Plan: [`plans/stream-intercept-phase2.md`](../../plans/stream-intercept-phase2.md)

## 背景

PR #4 merge 后，我们已经拥有：
- MAIN world fetch 拦截 (interceptorMain.ts)
- MAIN → ISOLATED world bridge (interceptorBridge.ts)
- Cutoff 完整代码实现（drain-drop + cancel 模式，但 `cutoffEnabled=false`）
- E2E 验证通过（6 项测试全部通过）

## 核心讨论问题

### 问题 1: Phase 2 是否需要单独验证 PR？

**结论：跳过，直接做 Phase 3。**

理由：
- Phase 2 的代码实现已在 PR #4 中完成
- 启用 cutoff 只需将 `cutoffEnabled` 设为 `true`
- 真正的验证依赖 Notion AI stream with function_call（当前 Notion 服务有问题）
- Phase 3 的 E2E 测试自然覆盖 cutoff 行为

### 问题 2: 事件路由架构适配

Phase 3 plan 基于 upstream PR #25 的 `onStreamEvent()` 回调 API。
PR #4 使用不同的架构：

```
MAIN world (interceptorMain.ts)
    → postMessage
    → ISOLATED world (interceptorBridge.ts)
    → structural validation
    → 路由事件
```

**适配方案选项：**
| 方案 | 描述 | 优劣 |
|------|------|------|
| A | interceptorBridge.ts 直接调用 streamToolBridge 处理函数 | 简单直接，但耦合 |
| B | interceptorBridge.ts 通过 CustomEvent 广播，streamToolBridge 订阅 | 解耦，可扩展 |
| C | interceptorBridge.ts expose `onStreamEvent()` 回调注册 API | 兼容原 Phase 3 plan |

### 问题 3: 已有基础设施确认

Phase 3 plan 依赖的组件（需确认在 fork 中可用）：
- `executionGuard` (reserveExecution)
- `executionGuardStore` (markSucceeded/markFailed)
- `storeExecutedFunction`
- `generateContentSignature`
- `window.mcpClient` (callTool, isReady)
- `window.pluginRegistry` (getActivePlugin)
- `adapter` (insertText, submitForm)

### 问题 4: 实施策略

**选项 B 胜出（Opus + GPT 共识）：直接实现 Phase 3**

---

## GPT 分析：3 Gate 模型

GPT 将 Phase 3 分解为 3 个验收门槛：

### Gate 1: stream_cutoff → streamToolBridge 跑通

```
Notion stream 出现 function_call
    ↓
MAIN interceptor 检测到
    ↓
cutoffEnabled=true → 发出 stream_cutoff
    ↓
streamToolBridge 收到事件
```

### Gate 2: 安全 MCP 工具执行一次 (Exactly Once)

- 使用安全工具验收：`echo`, `get_bridge_info`, `read_resource`
- 核心要求：executionGuard 保证 exactly-once 执行
- 验收：function_call → MCP tool 执行 → function_result 返回

### Gate 3: 结果回注到 Notion 输入框

- MCP 返回结果 → 格式化为 `<function_result>` → 插入 Notion 输入框
- **autoSubmit 默认 false**（自动插入，人工发送）
- 这是最安全的最小可用版本

---

## GPT 的 5 步实施计划

1. 启用 cutoff smoke test
2. stream_cutoff 驱动 streamToolBridge
3. 执行 safe MCP tool
4. function_result 插入 Notion 输入框
5. 用 GitHub read-only 工具读取 PR diff

**这 5 步完成 → Notion AI 可以做"只读代码审阅"**

---

## 可用性层级

| Level | 描述 | 需要完成 |
|-------|------|---------|
| **Level 1** | 最小可用 Demo | stream_cutoff → MCP tool → function_result 插入 |
| **Level 2** | 实际可用的代码审阅助手 | PR diff 分块、文件按需读取、结果结构化 |
| **Level 3** | 稳定的委员会审稿成员 | 多模型互相 review、回写 PR comment、多轮修复 |

---

## 关键风险

1. Notion AI 是否稳定输出我们能识别的 function_call 格式
2. Notion 输入框 adapter 是否稳定插入 function_result
3. stream_cutoff 后 Notion UI 是否表现正常
4. MCP tool result 是否能被 Notion AI 正确续接理解

---

## 最终共识

**Opus + GPT 一致同意：**
- 跳过单独的 Phase 2 验证 PR
- 直接实现 Phase 3（包含启用 cutoff）
- 目标：一个 Phase 3 PR + 一次真实 E2E + 一次 read-only review demo = Level 1 最小可用版本
- Notion AI 将从"网页聊天对象"变成委员会里的真实执行成员

## Next Steps

- [ ] 确认 fork 中 executionGuard 等基础设施可用性
- [ ] 确定事件路由方案（A/B/C）
- [ ] 创建 `feat/phase-3-stream-tool-bridge` 分支
- [ ] 实现 streamToolBridge.ts（含 TDD 测试）
- [ ] E2E 验收
