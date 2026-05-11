# Plan: Multi-Tool Call Support — 支持一次响应中多个工具调用

**分支**: `feat/tool-result-card-rendering`  
**作者**: Opus/Claude  
**日期**: 2026-05-11  
**状态**: Concept LGTM with revisions (GPT + Opus 共识)  
**相关测试原则**: [Provider DOM Contract Testing](provider-dom-contract-testing.md)

---

## 目标

1. 允许 AI 在**一次响应中输出多个独立工具调用**（每个 call 一个独立 jsonl codeblock）
2. **串行执行**所有检测到的工具调用（MVP；并行化为 P2）
3. **收集所有结果后合并为一条消息**提交给 AI（而非逐个提交）
4. 每个工具调用的输入和输出都**独立渲染为卡片**

## 非目标

- 不重写 DOM scanner 或 stream interceptor 的检测逻辑（它们已支持多 codeblock）
- 不改变 ExecutionGuard 的防重机制
- 不改变 ToolResultRenderer 的卡片渲染逻辑
- 不实现工具调用之间的依赖关系解析（依赖型调用由 prompt 规则约束，不 batch）
- 不在单个 codeblock 内放多个 call（保持 1 codeblock = 1 call 不变量）
- 不引入 batch wrapper XML 格式（MVP 用多个并列 `<function_results>` block）
- 不改变单工具调用的核心行为（向后兼容）

## 测试原则：Mocked DOM 不等于真实 Provider DOM Contract

本计划中的 mocked DOM E2E 只能证明 scanner / batch / handler 逻辑在一个假定 DOM 结构下成立。它不能证明真实 provider 页面（ChatGPT、Notion、Copilot、Gemini 等）仍然满足这些 selector、message boundary、codeblock parent tracing、input/submit 结构假设。

因此，任何依赖 provider DOM selector 或 assistant message boundary 的实现，进入 production-ready 状态前必须补充真实 provider DOM contract observation 或 regression。详见 [`plans/provider-dom-contract-testing.md`](provider-dom-contract-testing.md)。

对本 multi-tool 功能，Provider DOM Contract 至少要验证：

1. 同一条 assistant message 中的多个 codeblock 能追溯到同一个 message container；
2. 不同 assistant message 的 codeblock 不会被错误聚合；
3. message id 或 fallback id 足够稳定，可用于 dedupeKey；
4. input / submit selector 支持一次性插入 merged results 并提交一次。

## 已知与未知

### 已知

**检测层已支持多 codeblock**：
- DOM scanner (`mutationObserver.ts`) 用 `querySelectorAll` 扫描页面所有 codeblock，每个独立处理
- Stream scanner (`functionCallScanner.ts`) 逐行解析，每检测到一组完整的 `function_call_start..function_call_end` 就 emit 事件
- ExecutionGuard (`executionGuard.ts`) 按 `callId + contentSignature` 独立防重
- ToolResultRenderer 按 `callId` 独立渲染卡片

**执行层现状**：
- MCP client 支持单次 `callTool()` 调用
- AutomationService 监听 `mcp:tool-execution-complete` DOM 事件
- 每个结果独立触发 auto-insert → auto-submit 流程
- submit queue 串行执行，间隔 1.5s

**提示词现状**：
- `base-jsonl-protocol.md`: "MAKE SURE TO INVOKE ONLY ONE FUNCTION AT A TIME", "NEVER invoke multiple functions in a single response"
- `notion-bridge.md`: "一次只调一个"
- 这些规则阻止 AI 输出多个工具调用

### 未知

- AI（Notion AI / Claude / ChatGPT / Gemini）在被允许后能否可靠地输出多个独立 jsonl codeblock？
- 不同平台的输入框是否支持插入长文本（多个 `<function_results>` 合并后可能很长）？
- 多工具串行执行时的总延迟是否可接受？（并行化是 P2）
- MutationObserver 重扫同一 assistant message 的去重问题（dedupeKey 设计）

## 协议设计（Opus + GPT 共识）

### AI 输出侧

- 一条 assistant response 可以包含多个独立工具调用
- 每个工具调用**必须**放在独立的 ` ```jsonl ``` ` codeblock 中
- **不允许**在同一个 codeblock 内放多个 function call
- 所有 call 必须有唯一递增的 `call_id`
- **只有独立的调用才能 batch**；依赖型调用（B 需要 A 的结果）必须分轮执行

### Scanner 侧

- DOM scanner 扫描同一条 assistant message 内的所有 jsonl codeblock
- 每个有效 codeblock 解析为一个 `ToolCall`
- 同一条 assistant message 的所有 ToolCall 共享一个 `batchId`
- `expectedCallIds = calls.map(call => call.callId)`
- **去重约束**: `dedupeKey = messageId + callId`，防止 MutationObserver 重扫重执行

### Execution 侧

- MVP 按原始 DOM 顺序**串行执行**
- 每个 call settle 为 success/error
- Partial failure **不阻塞** batch（失败的 call 也产出结果）
- Flush 条件（优先级从高到低）：
  1. `expectedCallIds` 已知 → 全部 settled 后立即 flush
  2. Response/stream 已结束 → 短 debounce（300-800ms）后 flush
  3. 无法确定结束 → idle timeout（3-5s）fallback
  4. Hard max timeout（15-30s）→ 强制 flush 已有结果

### Result 侧

- 结果消息包含多个 `<function_results>` block，每个 call 一个
- Block 按**原始调用顺序**排列（不按完成顺序）
- 每个 block 包含 `call_id`、工具名、状态、结果/错误
- **不引入 batch wrapper XML**（MVP；如需 UI batch card 或 telemetry，P2 引入）

### Result 格式示例

> **注意**：MVP 复用现有 `formatFunctionResult()`（`functionResultFormatter.ts`）的 XML 格式输出。
> 下面是概念示例，实际输出格式见 `functionResultFormatter.ts` 中的 `formatSuccess()` / `formatError()`。
> 每个 call 独立调用 `formatFunctionResult()` 生成一个 `<function_results>` block，然后按原始调用顺序拼接。

```
Tool execution results for batch b123 (2 calls):

<function_results>
  <result call_id="c1" name="git_status" status="success">
    <content type="application/json"><![CDATA[
On branch main
Changes not staged for commit:
  modified: src/index.ts
    ]]></content>
  </result>
</function_results>

<function_results>
  <result call_id="c2" name="git_diff" status="success">
    <content type="application/json"><![CDATA[
diff --git a/src/index.ts b/src/index.ts
...
    ]]></content>
  </result>
</function_results>
```

## 架构分析

### 当前数据流（单工具）

```
AI 回复
  ↓
DOM/Stream 检测到 1 个 jsonl codeblock
  ↓
Parser 解析出 function_call
  ↓
ExecutionGuard.reserve(key) → 防重
  ↓
MCP Client.callTool() → 执行
  ↓
dispatch CustomEvent('mcp:tool-execution-complete', { result, callId, functionName })
  ↓  ↓
  ↓  ToolResultRenderer → 渲染结果卡片
  ↓
AutomationService.handleToolExecutionComplete()
  ↓
auto-insert: 插入结果到输入框
  ↓
auto-submit: 提交输入框 → AI 收到结果
```

### 目标数据流（多工具）

```
AI 回复
  ↓
DOM/Stream 检测到 N 个 jsonl codeblock            ← 无需改（已支持）
  ↓
Parser 解析出 N 个 function_call                  ← 无需改
  ↓
ExecutionGuard.reserve() × N                       ← 无需改
  ↓
for (call of calls) await MCP.callTool(call)        ← 需改：串行执行（MVP）
  ↓                                                   （P2: 对 read-only tools 可选并行）
dispatch N 个 tool-execution-complete 事件          ← 无需改
  ↓  ↓
  ↓  ToolResultRenderer × N → N 张结果卡片         ← 无需改
  ↓
BatchCollector 收集 N 个结果                        ← 新增组件
  ↓ （全部完成 or 超时）
合并为一条消息: <function_results>A</function_results><function_results>B</function_results>
  ↓
auto-insert: 一次性插入合并消息
  ↓
auto-submit: 提交一次                               ← 关键变化：只 submit 一次
```

## 技术方案

### Phase 1: 提示词修改（前置条件）

修改 `base-jsonl-protocol.md` 和 `notion-bridge.md`：

```diff
- MAKE SURE TO INVOKE ONLY ONE FUNCTION AT A TIME
- NEVER invoke multiple functions in a single response
+ You may output multiple independent tool calls in one response.
+ Each tool call must be placed in its own separate ```jsonl code block.
+ Do not put more than one function call in the same code block.
+ Each call must have a unique call_id.
+ Only batch independent calls. If one call depends on another call's result,
+ invoke only the first call and wait for results.
+ Prefer at most 3 calls per response unless the user explicitly asks for a broader batch.
```

平台测试注意点：
- **Notion**: DOM codeblock 是否被拆块、是否保留 jsonl fence
- **ChatGPT**: 多个 call_id 是否被 scanner 识别为同一 assistant turn
- **Gemini**: 可能输出 json 而非 jsonl，prompt 需继续强制 jsonl
- **DeepSeek/Qwen**: 可能把多个调用写成 JSON array，需测试

### Phase 2: Assistant Message 级 Batch 聚合

在 DOM scanner 层添加 assistant message 级别的 batch 聚合：

```typescript
interface ToolCallBatch {
  batchId: string;                // 基于 assistant message 元素 ID
  sourceMessageId: string;        // DOM 元素标识
  source: 'dom' | 'stream';
  calls: ToolCall[];
  expectedCallIds: string[];
}

// scanner 输出变化：
// 当前: scanCodeblock() → single ToolCall → execute
// 改后: scanAssistantMessage() → ToolCallBatch → executeAll → collectResults
```

核心 parser 不变（`parseCodeBlock(text) → ToolCall`），只在外层聚合。

### Phase 3: BatchCollector — 结果收集器

新增 `services/batch-collector.ts`：

```typescript
interface BatchContext {
  batchId: string;
  expectedCallIds: string[];
  results: Map<string, ToolExecutionCompleteDetail>;
  startTime: number;
  flushReason?: 'all_settled' | 'stream_end' | 'idle_timeout' | 'max_timeout';
}

class BatchCollector {
  private activeBatches: Map<string, BatchContext> = new Map();

  // Flush 条件（优先级从高到低）：
  // 1. expectedCallIds 全部 settled → 立即 flush
  // 2. stream/message 结束信号 → debounce 300-800ms → flush
  // 3. idle timeout 3-5s → flush
  // 4. hard max timeout 15-30s → 强制 flush
}
```

**关键设计**：单工具调用不等待额外时间。当 `expectedCallIds.length === 1` 且 result 已到达时，立即 flush。

### Phase 4: AutomationService 改造

修改 `automation.service.ts`：

```typescript
// 当前：每个结果独立 insert → submit
// 改为：收集模式

private async handleBatchComplete(results: ToolExecutionCompleteDetail[]) {
  // 按原始调用顺序排列
  const orderedResults = this.orderByCallSequence(results);
  
  // 合并为一条消息
  const mergedResult = this.mergeResults(orderedResults);
  
  // 一次性 insert + submit
  await this.handleAutoInsert({ result: mergedResult });
  await this.handleAutoSubmit({});
}

private mergeResults(results: ToolExecutionCompleteDetail[]): string {
  // MVP: 复用现有 formatFunctionResult() 输出格式（XML schema）
  // 每个 call 独立调用 formatFunctionResult() 生成一个 <function_results> block
  // 然后按原始调用顺序拼接。不引入新的 result schema。
  // 见 functionResultFormatter.ts 的真实 XML 格式。
  const header = `Tool execution results for batch (${results.length} calls):\n\n`;
  const blocks = results.map(r =>
    formatFunctionResult({ callId: r.callId, name: r.functionName, status: r.status, result: r.result })
  );
  return header + blocks.join('\n\n');
}
```

### Phase 5: MCP 执行并行化（P2 可选优化）

默认保持串行执行。只对明确 read-only / safe tools 开启并行：

```typescript
const results = await Promise.allSettled(
  readOnlyCalls.map(call => mcpClient.callTool(call))
);
```

注意：
- MCP stdio transport 天然串行，并行化需 SSE/streamable-http
- 写操作（commit、push、merge 等）**必须保持串行**
- 需要工具元数据标记 read-only vs write

## 实施步骤

### Step 1: 写 plan → GPT review → 达成共识 ✅
### Step 2: 修改提示词模板

- `base-jsonl-protocol.md`: 删除单工具限制，添加多工具规则和示例
- `notion-bridge.md`: 删除"一次只调一个"，添加多工具说明
- 保持每个 call 一个独立 codeblock 的约束

### Step 3: Assistant Message 级 Batch 聚合

- 在 DOM scanner 层添加 `scanAssistantMessage()` → `ToolCallBatch`
- 核心 parser 不变
- 添加 dedupeKey（`messageId + callId`）防止 MutationObserver 重执行

### Step 4: 实现 BatchCollector

- 新建 `services/batch-collector.ts`
- 实现多级 flush 策略（expectedCallIds / stream_end / idle timeout / max timeout）
- 单工具场景：结果到达即 flush（无额外等待）
- 单元测试：单结果 / 多结果 / 超时 / 部分失败

### Step 5: 改造 AutomationService

- 集成 BatchCollector
- 实现 mergeResults（按原始调用顺序输出多个 `<function_results>` block）
- 保持单工具调用向后兼容（无额外延迟）

### Step 6: 端到端测试

- Mocked DOM E2E：验证 scanner / batch / handler 逻辑
- Provider DOM Contract：验证真实 provider 页面仍满足 message boundary、codeblock tracing、input/submit selector 假设
- Full Pipeline Integration：验证 extension → proxy → MCP server → extension → merged insert/submit
- Manual AI Smoke：验证真实模型能输出多个独立工具调用，并能理解 merged results
- 验证卡片渲染正确
- 验证结果合并和提交正确
- 验证单工具调用无性能退化

## 向后兼容

- 单工具调用场景：BatchCollector 的 `expectedCallIds.length === 1`，result 到达即 flush，**无额外等待**
- 老提示词场景：AI 仍然只输出一个 call，行为与当前完全一致
- Parser 不变：1 codeblock = 1 call 的不变量保持
- **无行为变化**：单工具调用路径无性能退化

## 风险

| 风险 | 影响 | 缓解 |
|------|------|------|
| AI 输出格式不可靠（多 codeblock 合并为一个等） | 工具调用解析失败 | 提示词明确约束；实测各 AI 平台 |
| Mocked DOM 与真实 provider DOM 偏离 | mock 测试绿但生产 scanner / grouping / input / submit 失败 | Provider DOM Contract observation / regression |
| MutationObserver 重扫同一 message 导致重复执行 | 工具被执行多次 | dedupeKey = messageId + callId |
| MCP server 不支持并发 | 并行执行失败 | MVP 串行执行；Phase 5 可选并行 |
| 合并消息过长 | 输入框截断或 AI 上下文溢出 | 截断策略；大结果压缩 |
| 依赖型调用被错误 batch | 执行顺序错误，结果无意义 | prompt 明确禁止；不做运行时依赖检测 |
| 部分工具超时 | batch 永不完成 | hard max timeout 15-30s；partial flush |

## 验收标准

1. AI 输出 2+ 个 jsonl codeblock 时，所有工具调用都被检测和执行
2. 所有结果渲染为独立的折叠卡片
3. 所有结果合并为一条消息提交给 AI（一次 submit，不是 N 次）
4. 结果按原始调用顺序排列
5. 单工具调用场景无性能退化（无额外等待）
6. BatchCollector 有完整单元测试
7. 超时场景（部分工具未返回）优雅处理（partial flush）
8. MutationObserver 重扫不导致重复执行
9. Mocked DOM E2E 不单独作为 provider compatibility evidence；至少需要 provider DOM contract observation / regression

## Review 记录

### 2026-06-02 GPT Pre-review
- 初版 plan 用 5s idle window 作为主完成信号 → GPT 反对，建议用 assistant message lifecycle + expectedCallIds 为主
- Opus 建议多个独立 codeblock（而非单 codeblock 多 call） → GPT 同意
- Opus 建议多个并列 `<function_results>`（而非 batch wrapper） → GPT 同意
- 最终共识：Concept LGTM with revisions
