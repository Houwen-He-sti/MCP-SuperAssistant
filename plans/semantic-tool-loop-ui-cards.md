# Semantic Tool-loop UI Cards — Evidence Audit & Redesign Plan

> **PR 关联**：MCP-SuperAssistant PR #30（Tool Result UI v1）、PR #33（UI mount 修复）、PR #34（UI layout 修复）
> **前置文档**：`plans/tool-result-ui-and-sidebar-simplify.md`（v1 plan）。本 PR 取代之前未落库的 Gate 6 plan 草稿。
> **状态**：Draft — 待 committee review

---

## 1. 目标

对 PR #30 / #33 / #34 引入的 Tool Result UI 进行一次**基于证据的重新审视**，产出：

1. **Evidence audit**：哪些旧证据仍然有效、哪些局部有效、哪些已失效；
2. **新 UI 状态机定义**：从 v1 的单一 `tool_execution_completed` 扩展到覆盖完整 tool-loop 生命周期；
3. **分平台 mount 策略**：Notion / ChatGPT / DeepSeek 各自的 mount point 选择器和回退链；
4. **E2E 观察要求**：按 OO-PL-TDD 规则，每个状态必须有可观测的 DOM 证据；
5. **明确不做什么**：不继续补丁式修旧 UI，不引入无关视觉资产。

---

## 2. 非目标

- 不在本 PR 修改生产 UI 代码；本 PR 是 plan-only。
- 不生成图片、不引入图像资产。
- 不重写所有平台 adapter 的 mount point 实现（只定义契约）。
- 不改变 Gate 5 的执行、注入、ACK 逻辑。
- 不在第一版做复杂动画、主题系统、拖拽 layout。
- 不把 UI card 作为执行信任边界；执行安全仍由 `streamToolBridge` / policy / allowlist / guard 决定。

---

## 3. Evidence Audit：PR #30 / #33 / #34

### 3.1 PR #30 — Tool Result UI v1

**内容**：把 MCP 工具执行结果渲染成 inline card，支持工具名、状态、可折叠结果预览。

**生产代码现状**（已 merge）：
- [`tool-result-renderer.ts`](pages/content/src/services/tool-result-renderer.ts) — 独立服务，监听 `mcp:tool-execution-complete` 事件
- [`tool-result-renderer-utils.ts`](pages/content/src/services/tool-result-renderer-utils.ts) — 纯工具函数
- [`tool-result-ui.ts`](pages/content/src/types/tool-result-ui.ts) — 类型定义（`ToolResultUiEvent`、`ToolResultMountPoint`、`ToolResultRenderData`）
- CSS 注入：`STYLE_TAG_ID = 'mcp-tool-result-renderer-styles'`，`.mcp-tool-result-*` 前缀
- 卡片 DOM：`data-mcp-tool-result-card="true"` + `data-mcp-call-id` 幂等 key
- 宽度约束：`width: min(100%, 820px)`（PR #34 修复）

**仍然有效的证据**：
| 证据 | 有效性 | 说明 |
|------|--------|------|
| `mcp:tool-execution-complete` CustomEvent 事件源 | ✅ 完全有效 | 事件协议未变，AutomationService 仍在派发 |
| `findToolResultMountPoint()` adapter 契约 | ✅ 完全有效 | BaseAdapterPlugin 已定义，各 adapter 已实现 |
| 幂等 key `data-mcp-call-id` | ✅ 完全有效 | 防止重复注入的核心机制 |
| `textContent` 安全策略（不用 `innerHTML`） | ✅ 完全有效 | XSS 防护，不可妥协 |
| 样式单次注入（`STYLE_TAG_ID`） | ✅ 完全有效 | 防止 CSS 重复注入 |
| `.mcp-tool-result-*` 前缀 | ✅ 完全有效 | 避免与宿主样式冲突 |
| 宽度约束 `min(100%, 820px)` | ✅ 完全有效 | PR #34 修复后已解决 full-width 问题 |
| 折叠/展开交互（chevron toggle） | ✅ 完全有效 | 用户交互模式已验证 |
| `prefers-color-scheme: dark` 暗色适配 | ✅ 完全有效 | CSS 变量方案工作正常 |

**局部有效的证据**：
| 证据 | 有效性 | 说明 |
|------|--------|------|
| `tool_execution_completed` 单一事件类型 | ⚠️ 局部有效 | v1 只覆盖这一个状态，不覆盖 submitted / ACK / timeout |
| `ToolResultUiEvent` 类型定义 | ⚠️ 局部有效 | 定义了 4 种类型但只有 1 种被使用，其余 3 种未接入 |
| Notion mount point | ⚠️ 局部有效 | PR #33 修复了 Notion mount 选择器，但仅针对当时 DOM 结构 |
| ChatGPT / DeepSeek mount point | ⚠️ 局部有效 | 标记为 EXPERIMENTAL，E2E 未验证 |

**已失效的假设**：
| 假设 | 失效原因 |
|------|----------|
| "v1 直接监听 `mcp:tool-execution-complete` 就够了" | Gate 5d 引入了 `bridge_handoff_ack` / `model_ack_confirmed` / `model_ack_timeout`，需要新的事件源 |
| "单一 card 样式覆盖所有状态" | 不同状态需要不同 tone（neutral / success / acknowledged / warning / blocked / error） |
| "card 文案 'Tool completed' 足够" | 需要区分 "detected" / "executing" / "submitted" / "ACK confirmed" / "ACK timeout" / "blocked" |
| "mount point 选择器一次写好就稳定" | SPA 页面 DOM 结构会随平台更新变化，需要回退链 |

### 3.2 PR #33 — UI Mount 修复

**内容**：修 Notion 页面里 tool result card 的挂载点选择器。

**仍然有效的证据**：
- Notion `/chat` 页面结构（PR #33 修复的选择器）
- `findToolResultMountPoint()` 的 fail-soft + warn 策略

**局部有效的证据**：
- 具体选择器字符串可能随 Notion 更新失效，需要 E2E 重新验证

### 3.3 PR #34 — UI Layout 修复

**内容**：约束 Notion card 宽度、避免渲染成页面底部 full-width block，并支持 event alias。同时重构了 Notion 的 mount point 策略。

**仍然有效的证据**：
- `width: min(100%, 820px)` 约束
- `margin: 8px auto` 居中
- Notion mount point 策略：先找 `.notion-app-inner`，再向上找 narrow chat column，使用 `append` 模式；失败时才 fallback 到 scroll container / root。

**局部有效的证据**：
- event alias 支持的具体实现方式可能需要随新状态机调整

---

## 4. 新 UI 状态机定义

基于 Gate 5d 产出的完整 tool-loop 生命周期，定义以下状态：

### 4.1 状态枚举

```typescript
export type ToolLoopUiEventType =
  // 检测阶段
  | 'tool_call_detected'       // 模型发出了 tool call，执行尚未开始
  // 执行阶段
  | 'tool_execution_started'   // 工具正在执行中
  | 'tool_execution_succeeded' // 工具执行成功
  | 'tool_execution_failed'    // 工具执行失败（受控失败）
  // 注入/提交阶段
  | 'tool_result_inserted'     // 结果已插入输入框（未提交）
  | 'tool_result_submitted'    // 结果已提交给下一轮模型
  // ACK 阶段（Gate 5d）
  | 'bridge_handoff_ack'       // Bridge handoff ACK nonce 已生成
  | 'model_ack_confirmed'      // 模型下一轮回显了 nonce
  | 'model_ack_timeout'        // 模型未在 timeout 窗口内回显 nonce
  // 异常阶段
  | 'execution_blocked'        // 安全策略或前置条件阻止执行
  | 'policy_rejected'          // tool allowlist / circuit breaker 拒绝
  | 'adapter_unavailable'      // adapter 不可用
  | 'mcp_client_unavailable'   // MCP client 不可用
  | 'unexpected_error';        // 非预期的 runtime 错误
```

### 4.2 Tone 映射

```typescript
export type ToolLoopCardTone =
  | 'neutral'      // detected
  | 'pending'      // started
  | 'success'      // succeeded / inserted / submitted
  | 'acknowledged' // ack_confirmed
  | 'warning'      // ack_timeout
  | 'blocked'      // blocked / policy_rejected
  | 'error';       // failed / adapter_unavailable / mcp_client_unavailable / unexpected_error
```

### 4.3 每个状态的触发事件

> **注意**：当前 `streamToolBridge.ts` 的事件契约尚未完全覆盖以下所有细分状态（例如，当前代码在 reserve 成功后并未 emit `reserved`，且注入结果主要折叠为 `succeeded`）。
> **Gate 6B 的前置要求**：必须先扩展 `BridgeEvent` 契约，新增真正的 `detected`/`reserved` 以及细分的 inject outcome UI event，然后才能完成以下映射。

| UI 状态 | 触发事件源 (Gate 6B 扩展后) | 触发条件 |
|---------|-----------|----------|
| `tool_call_detected` | `streamToolBridge.onEvent` | `stream_tool_execution` status=`reserved` (需新增 emit) |
| `tool_execution_started` | `streamToolBridge.onEvent` | `stream_tool_execution` status=`executing` |
| `tool_execution_succeeded` | `streamToolBridge.onEvent` | `stream_tool_execution` status=`succeeded` |
| `tool_execution_failed` | `streamToolBridge.onEvent` | `stream_tool_execution` status=`failed` |
| `tool_result_inserted` | `streamToolBridge.onEvent` | `stream_tool_execution` status=`succeeded` 且 outcome=`RESULT_INJECTED` (需扩展 payload) |
| `tool_result_submitted` | `streamToolBridge.onEvent` | `bridge_handoff_ack` event |
| `bridge_handoff_ack` | `streamToolBridge.onEvent` | `bridge_handoff_ack` event |
| `model_ack_confirmed` | `ackTracker` | nonce 在 stream 中被回显 (通过 `mcp-superassistant:model-ack` 暴露) |
| `model_ack_timeout` | `ackTracker` | nonce 在 timeout 窗口内未被回显 (通过 `mcp-superassistant:model-ack` 暴露) |
| `execution_blocked` | `streamToolBridge.onEvent` | `stream_tool_execution` status=`succeeded` 且 outcome=`INJECT_SKIPPED_DRAFT` |
| `policy_rejected` | `streamToolBridge.onEvent` | tool allowlist denied / circuit breaker open / args too large |
| `adapter_unavailable` | `streamToolBridge.onEvent` | `stream_tool_execution` status=`failed` 且 outcome=`INJECT_SKIPPED_NO_ADAPTER` |
| `mcp_client_unavailable` | `streamToolBridge.onEvent` | mcpClient not available / not ready |
| `unexpected_error` | 任何未捕获异常 | 非预期错误 |

### 4.4 每个状态的最小 DOM 表现

所有 card 共享基础结构：

```html
<div class="mcp-tool-loop-card" data-mcp-call-id="..." data-mcp-tone="...">
  <div class="mcp-tool-loop-header">
    <span class="mcp-tool-loop-chevron">▸</span>
    <span class="mcp-tool-loop-title">...</span>
    <span class="mcp-tool-loop-status">...</span>
  </div>
  <div class="mcp-tool-loop-preview" data-visible="false">
    <pre>...</pre>
  </div>
</div>
```

各状态的最小差异：

| 状态 | Title 文案 | Status 图标 | Tone CSS 变量 |
|------|-----------|------------|--------------|
| `tool_call_detected` | `Tool: {name}` | 🔍 | `--mcp-tone-neutral: #6b7280` |
| `tool_execution_started` | `Executing: {name}` | ⏳ | `--mcp-tone-pending: #3b82f6` |
| `tool_execution_succeeded` | `Tool: {name}` | ✅ | `--mcp-tone-success: #10b981` |
| `tool_execution_failed` | `Tool error: {name}` | ❌ | `--mcp-tone-error: #ef4444` |
| `tool_result_inserted` | `Result inserted` | 📝 | `--mcp-tone-success` |
| `tool_result_submitted` | `Result submitted` | 📤 | `--mcp-tone-success` |
| `bridge_handoff_ack` | `ACK pending` | ⏳ | `--mcp-tone-pending` |
| `model_ack_confirmed` | `Model ACK confirmed` | ✅ | `--mcp-tone-acknowledged: #8b5cf6` |
| `model_ack_timeout` | `Model ACK timeout` | ⚠️ | `--mcp-tone-warning: #f59e0b` |
| `execution_blocked` | `Execution blocked` | 🚫 | `--mcp-tone-blocked: #6b7280` |
| `policy_rejected` | `Policy rejected` | 🚫 | `--mcp-tone-blocked` |
| `adapter_unavailable` | `Adapter unavailable` | ❌ | `--mcp-tone-error` |
| `mcp_client_unavailable` | `MCP client unavailable` | ❌ | `--mcp-tone-error` |
| `unexpected_error` | `Unexpected error` | ❌ | `--mcp-tone-error` |

**可折叠 detail**（所有状态共享）：
- 默认折叠
- 展开后显示：raw args（限长）、raw result preview（限长）、event payload、error stack / code、streamId / chunkIndex、nonce / ack state、elapsed / latency

---

## 5. 分平台 Mount 策略

### 5.1 契约

每个 adapter 必须实现 `findToolResultMountPoint()`，返回 `ToolResultMountPoint | null`。

```typescript
interface ToolResultMountPoint {
  container: HTMLElement;
  anchor?: HTMLElement;
  mode: 'append' | 'after';
}
```

### 5.2 Notion

**当前 mount point**（PR #34 修复后）：
- 优先选择器：先找 `.notion-app-inner`，再从输入框向上找 narrow chat column
- 回退选择器：scroll container / root
- 插入模式：`append` 到 chat column

**E2E 观察要求**：
- 在 Notion `/chat` 页面执行一次工具调用，验证 card 出现在正确位置
- 验证 React re-render 后 card 不消失、不重复
- 验证 card 宽度不超过 820px

### 5.3 ChatGPT

**当前 mount point**：
> 现有 experimental implementation 是：优先选择器 `[data-testid^="conversation-turn-"]` 最后一个 turn 的父级，回退 `main .flex.flex-col`，插入模式 `after`。
> Gate 6 observation 必须验证或重设该 fallback chain。

**E2E 观察要求**：
- 在 ChatGPT 页面执行一次工具调用，验证 card 出现
- 验证 SPA 路由切换后 card 不消失
- 验证 card 不与 ChatGPT 原生 tool call UI 冲突

### 5.4 DeepSeek

**当前 mount point**：
> 现有 experimental implementation 是：优先选择器 `.chat-message-list` / `[class*="chat-messages"]`，回退 `main` / `[role="main"]`，插入模式 `after`。
> Gate 6 observation 必须验证或重设该 fallback chain。

**E2E 观察要求**：
- 在 DeepSeek 页面执行一次工具调用，验证 card 出现
- 验证 card 不与 DeepSeek 原生 UI 冲突

### 5.5 回退链

```
adapter.findToolResultMountPoint()
  → 返回有效 mount point → 注入 card
  → 返回 null → logger.warn → card 不显示（fail-soft）
```

---

## 6. 事件流整合

### 6.1 当前事件流（v1）

```
mcp:tool-execution-complete (CustomEvent)
  → ToolResultRenderer.handleToolExecutionComplete()
    → extractRenderData()
    → injectResultBlock()
      → buildCardElement()
```

### 6.2 目标事件流（v2）

```
streamToolBridge.onEvent (BridgeEvent)
  → normalizeToUiEvent()
    → ToolLoopCardRenderer.render()
      → buildCardElement()

ackTracker (AckEvent)
  → normalizeToUiEvent()
    → ToolLoopCardRenderer.render()
      → buildCardElement()

mcp:tool-execution-complete (legacy, 向后兼容)
  → normalizeToUiEvent()
    → ToolLoopCardRenderer.render()
      → buildCardElement()
```

### 6.3 向后兼容

- v1 的 `mcp:tool-execution-complete` 事件继续被监听
- 新事件源（`streamToolBridge.onEvent`、`ackTracker`）逐步接入
- `ToolResultUiEvent` 类型作为统一中间层

---

## 7. E2E 观察要求

按 OO-PL-TDD 规则，每个状态的 UI 表现必须有可观测的 DOM 证据：

### 7.1 观察脚本

> Gate 6 默认扩展 `scripts/e2e-tool-result-renderer.cjs`；只有当 lifecycle / timeline assertion 结构明显不同，才新建独立 CJS 脚本，并复用 `scripts/lib/` helper。

如果需要新建，在 `MCP-SuperAssistant/scripts/` 下创建 E2E 观察脚本：

```
e2e-ui-state-observation.cjs
```

**观察内容**：
1. 在 Notion `/chat` 页面触发一次工具调用
2. 记录每个 UI 状态对应的 DOM 元素出现
3. 验证 card 的 `data-mcp-tone` 属性正确
4. 验证 card 的 title 文案正确
5. 验证 card 的 status 图标正确
6. 验证 card 的宽度约束
7. 验证折叠/展开交互
8. 验证 React re-render 后 card 不消失

### 7.2 观察日志格式

```json
{
  "timestamp": 1715345678901,
  "eventType": "tool_call_detected",
  "callId": "call_123",
  "toolName": "get_bridge_info",
  "cardFound": true,
  "cardTone": "neutral",
  "cardTitle": "Tool: get_bridge_info",
  "cardStatus": "🔍",
  "cardWidth": 820,
  "cardVisible": true
}
```

### 7.3 观察证据保存

- 结构化日志 excerpts 保存在 PR comment 中
- 原始日志不提交（可能包含敏感信息）
- 关键事件序列摘要保存在 plan 文档中

---

## 8. 实施范围建议

### 8.1 Phase A（本 PR）— Plan + Evidence Audit

- 本文档
- 提交 PR 获取 committee review

### 8.2 Phase B — 事件映射层

- 新增 `toolLoopUiEvents.ts`
  - 定义 `ToolLoopUiEvent`（扩展现有 `ToolResultUiEvent`）
  - 从 `BridgeEvent` / `AckEvent` / legacy event 映射到 UI event
  - unit tests：event-to-card mapping

### 8.3 Phase C — Semantic Card Renderer

- 新增 `SemanticToolCard.ts`（或重构现有 `buildCardElement()`）
  - 根据 `tone` 渲染不同 card 样式
  - 默认 summary + 可折叠 detail
  - 不破坏现有手动 RUN 按钮
  - 不改变 autoExecute / autoSubmit 行为

### 8.4 Phase D — 替换默认 card renderer

- 替换现有 `buildCardElement()` 为 semantic renderer
- 保留向后兼容的 legacy event 处理

### 8.5 Phase E — ACK timeline integration

- 同一 `callId` 下合并 submitted / ack confirmed / timeout timeline
- 避免 card 刷屏

---

## 9. 风险与缓解

| 风险 | 严重度 | 缓解 |
|------|--------|------|
| UI 改动破坏手动执行按钮 | 高 | 第一版包裹现有 renderer，不先删除行为逻辑 |
| 视觉状态与真实状态不一致 | 高 | 所有 card 只能由 normalized event 驱动，不靠 DOM 文案猜测 |
| 暴露 raw result / raw stream text | 中 | 默认 preview 限长，raw detail 需要展开 |
| CSS 污染宿主网站 | 中 | 使用 scoped class（`.mcp-tool-loop-*`）+ CSS 变量隔离 |
| 状态过多导致 UI 噪音 | 中 | 默认合并同一 callId 的 card timeline，避免刷屏 |
| SPA DOM 重建导致 card 消失 | 中 | 幂等 key + mount point 回退链 + 事件重放支持 |
| 平台 DOM 结构变化导致 mount point 失败 | 中 | fail-soft + `logger.warn()` + 定期 E2E 验证 |

---

## 10. 测试计划

### 10.1 Unit Tests

- `mapBridgeEventToUiEvent()` — BridgeEvent → ToolLoopUiEvent 映射
- `mapAckEventToUiEvent()` — AckEvent → ToolLoopUiEvent 映射
- blocked/error reason tone mapping
- preview truncation
- raw detail redaction/limit
- legacy event backward compatibility

### 10.2 Component Tests

- success card renders toolName/callId
- ACK confirmed card renders nonce/latency
- ACK timeout card renders warning tone
- blocked card shows no side effect message
- expandable details hidden by default
- tone CSS variables applied correctly

### 10.3 E2E Tests（Observation-Oriented）

- Real Notion: function call detected card appears
- Auto-submit: result submitted card appears
- Gate 5d: ACK confirmed / timeout card appears
- Tool policy rejection: blocked card appears
- React re-render: card survives
- SPA navigation: card survives or gracefully disappears

---

## 11. 明确不做什么

1. **不继续补丁式修旧 UI** — 不再针对单个平台 DOM 变化打选择器补丁，而是建立回退链 + E2E 观察机制
2. **不引入视觉资产** — 不使用图片、图标库、动画库
3. **不改变执行安全边界** — UI 只是可视化层，不改变 streamToolBridge / policy / allowlist / guard 的执行逻辑
4. **不做像素级完美** — 测试关注结构正确性，不关注像素级渲染
5. **不在第一版做主题系统** — 只支持 light/dark 通过 CSS 变量 + `prefers-color-scheme`
6. **不做拖拽 layout** — card 位置由 mount point 决定，不支持用户拖拽

---

## 12. Acceptance Criteria

- [ ] Evidence audit 完成，明确哪些旧证据有效、哪些局部有效、哪些已失效
- [ ] 新 UI 状态机定义完成，覆盖完整 tool-loop 生命周期
- [ ] 每个状态有明确的触发事件、tone 映射、最小 DOM 表现
- [ ] Notion / ChatGPT / DeepSeek 分平台 mount 策略定义完成
- [ ] E2E 观察要求定义完成，包含观察脚本、日志格式、证据保存方式
- [ ] 明确不做什么，避免 scope creep
- [ ] Plan 获得 committee review LGTM

---

## 13. 建议后续 PR 拆分

| PR | 内容 | 范围 |
|----|------|------|
| Gate 6A | Plan + evidence audit（本 PR） | Plan-only |
| Gate 6B | 事件映射层 `toolLoopUiEvents.ts` | 类型 + mapper + unit tests |
| Gate 6C | Semantic card renderer | 新组件 + dev path 启用 |
| Gate 6D | 替换默认 card renderer | 替换 + 向后兼容 |
| Gate 6E | ACK timeline integration | 同一 callId 合并 timeline |

---

Author: Qwen3.6-plus
Date: 2026-05-10
