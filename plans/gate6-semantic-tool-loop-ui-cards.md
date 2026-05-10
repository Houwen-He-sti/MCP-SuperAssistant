# Gate 6-UI-A: Semantic Tool-loop UI Cards

> **命名说明**：Gate 6 分为两条并行轨道：
> - **Gate 6-R**: Runtime Extraction / Provider Generalization
> - **Gate 6-UI**: Semantic Tool-loop UI Cards
>
> 本文档是 Gate 6-UI 的 Phase A（plan），后续 Phase B 为实现。
> 详见 `plans/gate6-and-notion-mcp-plan.md` 中的命名约定。

## 目标

把 MCP-SuperAssistant 当前默认的 tool call / tool result 渲染框，重构为一套**按状态机语义区分的 UI card renderer**。

Gate 5 系列已经把 browser MCP tool-loop 从“检测 tool call”推进到：

```text
function_call detected
→ tool execution
→ function_result DOM next-turn injection
→ bridge handoff ACK nonce
→ cross-turn model ACK confirmed / timeout
```

随着状态变多，旧的默认框已经不适合长期调试和真实使用。Gate 6 的目标不是“做漂亮皮肤”，而是让 UI 明确表达系统状态：不同反应、不同风险、不同确认层级，用不同 card 渲染。

---

## 背景

当前 UI 的主要问题：

1. **状态语义不清**：tool detected、running、submitted、blocked、error、ACK confirmed、ACK timeout 容易混在一起。
2. **调试成本高**：用户和开发者无法一眼判断 tool-loop 现在走到哪一步。
3. **Gate 5d 后状态复杂度上升**：`RESULT_SUBMITTED` 和 `MODEL_ACK_CONFIRMED` 是完全不同的状态，必须视觉上区分。
4. **默认 MCP-SuperAssistant card 太粗糙**：适合 demo，不适合多轮自动 tool-loop 和长期工程调试。

核心原则：

```text
UI 不只是展示文本；UI 是 tool-loop 状态机的可视化层。
```

---

## 非目标

- 不在本 PR 修改生产 UI 代码；本 PR 是 plan-only。
- 不生成图片、不引入图像资产。
- 不重写所有平台 adapter。
- 不改变 Gate 5 的执行、注入、ACK 逻辑。
- 不在第一版做复杂动画、主题系统、拖拽 layout。
- 不把 UI card 作为执行信任边界；执行安全仍由 streamToolBridge / policy / allowlist / guard 决定。

---

## 设计原则

### 1. 状态优先，不是颜色优先

先定义状态语义，再定义视觉样式。

```text
BridgeEvent / StreamEvent / AckEvent
→ normalized ToolLoopUiEvent
→ SemanticCardRenderer
```

### 2. 不同反应，不同 card

至少区分：

- detected / pending
- running
- submitted
- acknowledged
- timeout / warning
- blocked
- controlled tool error
- fatal / unexpected error

### 3. ACK 是单独的一等状态

`MODEL_ACK_CONFIRMED` 不是普通 success。它表示模型下一轮确实看到了注入结果。

`MODEL_ACK_TIMEOUT` 也不是普通 fatal error。它表示结果已提交，但模型未在窗口内回显 nonce；可能是 prompt compliance 问题，也可能是扫描链路问题。

### 4. 可折叠 raw detail

默认展示短摘要；高级调试信息放入 expandable detail。

默认层：

- title
- status
- toolName
- callId
- nonce / ack state
- elapsed / latency
- short preview

展开层：

- raw args
- raw result preview
- event payload
- error stack / code
- streamId / chunkIndex

### 5. 不扩大泄漏面

UI preview 必须限长；raw result / raw text 不默认展开。尤其是 Gate 5d 的 `stream_chunk_text` 不应直接完整展示给普通用户。

---

## 建议状态模型

```typescript
export type ToolLoopUiEventType =
  | 'tool_call_detected'
  | 'tool_execution_started'
  | 'tool_execution_succeeded'
  | 'tool_execution_failed'
  | 'tool_result_inserted'
  | 'tool_result_submitted'
  | 'bridge_handoff_ack'
  | 'model_ack_confirmed'
  | 'model_ack_timeout'
  | 'execution_blocked'
  | 'policy_rejected'
  | 'adapter_unavailable'
  | 'mcp_client_unavailable'
  | 'unexpected_error';

export type ToolLoopCardTone =
  | 'neutral'
  | 'pending'
  | 'success'
  | 'acknowledged'
  | 'warning'
  | 'blocked'
  | 'error';

export interface ToolLoopUiEvent {
  type: ToolLoopUiEventType;
  tone: ToolLoopCardTone;
  title: string;
  summary: string;
  toolName?: string;
  callId?: string;
  streamId?: string;
  nonce?: string;
  elapsedMs?: number;
  latencyMs?: number;
  preview?: string;
  details?: Record<string, unknown>;
}
```

---

## Card 分类

### 1. Tool Call Detected

语义：模型发出了 tool call，但执行尚未开始。

Tone: `neutral` / `pending`

展示：

```text
Tool call detected
Tool: get_bridge_info
Call ID: call_123
Args: {}
```

---

### 2. Tool Execution Running

语义：工具正在执行中。

Tone: `pending`

展示：

```text
Executing tool
Tool: search_files
Elapsed: 1.2s
```

---

### 3. Tool Result Submitted

语义：工具结果已经插入并提交给下一轮模型上下文。

Tone: `success`

展示：

```text
Tool result submitted
Tool: get_bridge_info
Call ID: call_123
ACK nonce: ack_call123_0
```

注意：这个状态只说明结果已经交给下一轮，不说明模型已经读到。

---

### 4. Model ACK Confirmed

语义：模型下一轮 stream 中回显了 nonce，cross-turn ACK 成功。

Tone: `acknowledged`

展示：

```text
Model ACK confirmed
Nonce: ack_call123_0
Latency: 1840ms
```

这是 Gate 5d 后必须单独突出的 card。

---

### 5. Model ACK Timeout

语义：结果已提交，但模型没有在 timeout 窗口内回显 nonce。

Tone: `warning`

展示：

```text
Model ACK timeout
Nonce: ack_call123_0
Timeout: 30000ms
Possible causes: model ignored ACK instruction / next turn not triggered / stream scan missed text
```

不要渲染成 fatal error。

---

### 6. Tool Error Submitted

语义：工具执行失败，但错误结果已按协议注入/提交给模型。

Tone: `error` 或 `warning`，取决于是否受控失败。

展示：

```text
Tool error submitted
Tool: read_file
Error code: TOOL_ERROR
Error ID: err_abc
```

这是 controlled failure，不等价于 runtime crash。

---

### 7. Execution Blocked

语义：安全策略或前置条件阻止执行。

典型原因：

- allowlist denied
- arguments invalid
- args too large
- circuit breaker open
- draft protection
- adapter unavailable
- mcp client unavailable

Tone: `blocked`

展示：

```text
Execution blocked
Reason: DRAFT_NOT_EMPTY
No tool side effect occurred.
```

---

## 第一版实施范围

建议第一版只做最小闭环：

1. 新增 `toolLoopUiEvents.ts`
   - 定义 `ToolLoopUiEvent`
   - 从现有 BridgeEvent / AckEvent 映射到 UI event

2. 新增 `SemanticToolCard.tsx`
   - 根据 `tone` 渲染不同 card 样式
   - 默认 summary + 可折叠 detail

3. 替换或包裹现有 tool card renderer
   - 不破坏现有手动 RUN 按钮
   - 不改变 autoExecute / autoSubmit 行为

4. 最少支持 5 种 tone
   - neutral
   - success
   - acknowledged
   - warning
   - blocked/error

5. 添加测试
   - event-to-card mapping unit tests
   - snapshot-like structural tests, not pixel-perfect tests
   - blocked / timeout / ack confirmed 必须覆盖

---

## 与 Gate 5d 的关系

Gate 5d 产出的 `model_ack_confirmed` / `model_ack_timeout` 应直接映射为 UI card。

推荐映射：

| Gate 5d event | UI card |
|---|---|
| `bridge_handoff_ack` | Tool Result Submitted / ACK Pending |
| `model_ack_confirmed` | Model ACK Confirmed |
| `model_ack_timeout` | Model ACK Timeout |
| `stream_chunk_text` | 默认不直接显示；仅 debug detail 可观察计数 |

---

## 风险与缓解

| 风险 | 严重度 | 缓解 |
|---|---:|---|
| UI 改动破坏手动执行按钮 | 高 | 第一版包裹现有 renderer，不先删除行为逻辑 |
| 视觉状态与真实状态不一致 | 高 | 所有 card 只能由 normalized event 驱动，不靠 DOM 文案猜测 |
| 暴露 raw result / raw stream text | 中 | 默认 preview 限长，raw detail 需要展开 |
| CSS 污染宿主网站 | 中 | 使用 scoped class / shadow boundary / existing extension container |
| 状态过多导致 UI 噪音 | 中 | 默认合并同一 callId 的 card timeline，避免刷屏 |

---

## 测试计划

Unit:

- `mapBridgeEventToUiEvent()`
- `mapAckEventToUiEvent()`
- blocked/error reason tone mapping
- preview truncation
- raw detail redaction/limit

Component:

- success card renders toolName/callId
- ACK confirmed card renders nonce/latency
- ACK timeout card renders warning tone
- blocked card shows no side effect message
- expandable details hidden by default

Manual / E2E:

- Real Notion: function call detected card appears
- Auto-submit: result submitted card appears
- Gate 5d: ACK confirmed / timeout card appears
- Tool policy rejection: blocked card appears

---

## 建议后续 PR 拆分

1. **Gate 6A — plan + event taxonomy**
   - 本 PR。

2. **Gate 6B — normalized UI event mapper**
   - 无视觉大改，只加类型、mapper、测试。

3. **Gate 6C — SemanticToolCard component**
   - 新组件并在 dev path 中启用。

4. **Gate 6D — replace default card renderer**
   - 替换默认 MCP-SuperAssistant card。

5. **Gate 6E — ACK timeline integration**
   - 同一 callId 下合并 submitted / ack confirmed / timeout timeline。

---

## Acceptance Criteria

- 不同 tool-loop 状态能映射到不同 card tone。
- `RESULT_SUBMITTED` 与 `MODEL_ACK_CONFIRMED` 在 UI 上明确区分。
- `MODEL_ACK_TIMEOUT` 作为 warning，而不是 fatal error。
- blocked / rejected 状态明确显示“未产生 tool side effect”。
- preview 默认限长，raw detail 默认折叠。
- 不改变现有执行安全边界。

---

Author: GPT-5.5 Thinking
