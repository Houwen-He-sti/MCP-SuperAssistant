# Gate 6: Function Result Rendering Fix + Batch Enhancement

> PR branch: `feat/tool-result-card-rendering`
> Author: Opus/Claude
> Depends on: Gate 5d (MERGED), PR #40 (Gate 6A plan, MERGED)
> Status: **Observation complete (Lane A)** — parser contract mismatch identified

---

## Critical Finding (2026-05-11)

**Extension already has function_result rendering!** The `render_prescript/src/renderer/functionResult.ts` (upstream, since 2025-05-18 commit `c83b0b5`) already processes user messages containing `<function_result>` XML and renders them as structured cards with expand/collapse, tool name, and content areas.

However, **the renderer's parser does not match the current output format**:

| | Old format (renderer expects) | New format (formatter outputs) |
|---|---|---|
| Root tag | `<function_result>` (singular) | `<function_results>` (plural) |
| Result wrapper | none | `<result call_id name status>` |
| Content | inline | `<content type><![CDATA[...]]></content>` |
| Multiple results | one per message | multiple `<result>` in one `<function_results>` |

**Consequences observed via Lane A probe:**
- Content area renders **empty** (regex `/<function_result[^>]*>([\s\S]*?)<\/function_result>/` doesn't match)
- Merged payload (2 `<function_results>` blocks) → **only 1st block rendered, 2nd lost** (`replaceBlockContent` swallows entire message)
- Call ID extracted from first result only

**Two existing renderer systems (do NOT build a 3rd):**
1. `render_prescript/src/renderer/functionResult.ts` — DOM post-processor for submitted user messages
2. `services/tool-result-renderer.ts` (PR #30) — event-driven inline card for tool execution

---

## Revised Scope

~~从零构建 result card rendering~~ →

**审计、修复并增强既有 `functionResult.ts` renderer，使其支持 canonical `<function_results><result ...>` batch 格式。**

核心范围：
1. **Parser fix**: 支持 `<function_results><result ...>` 新格式 (P0)
2. **Batch support**: 多个 `<result>` entries in one message (P0, Phase 4 需要)
3. **Content rendering**: 修复空内容区域 (P0)
4. **Batch card UI**: 一个 batch card 显示多个 result rows (P1)
5. **Provider verification**: ChatGPT Lane A + Notion Lane B (P1)
6. **Test coverage**: 对现有渲染逻辑补充 TDD 测试 (P0)

## 非目标

- 不修改结果注入格式（`formatFunctionResult()` 保持不变）
- 不修改 `streamToolBridge` 的执行逻辑
- 不做 placeholder/引用替换方案（AI 需要完整结果）
- 不做 ACK timeline 合并（Gate 6E 范畴）
- **不新建第三套 renderer** — 修复现有 `functionResult.ts`

## Provider Observation Lanes

Gate 6 observation has two provider lanes:

### Lane A: ChatGPT (first — CDP probe infra exists)
- **目的**: 复用已有 CDP probe 基础设施，快速验证 submit 后用户消息 DOM、function_results 呈现、card detection 可行性
- **同时覆盖**: Phase 4 minimal scratch submit smoke（merged text insert + one-submit verdict）
- **probe 分级**:
  - A0: draft-only — insert synthetic payload, 不 submit, 验证 composer 能否承载
  - A1: submitted — submit + bounded polling snapshot, 观察 user message DOM

### Lane B: Notion (required for original Gate 6 scope)
- **目的**: 满足 Gate 6 原始 scope，验证 Notion /chat 的真实 DOM 和 React 重渲染行为
- **不应从 ChatGPT 结果外推**: ChatGPT evidence 降低不确定性，但不能替代 Notion contract

## 贝叶斯方案选择

### Prior (工程经验)

| 方案 | Prior | 理由 |
|------|-------|------|
| 方案 1: DOM 后处理 | 0.45 | 最少侵入，不改插入格式 |
| 方案 2: 预标记 | 0.30 | 检测更稳，但改 insertText 有风险 |
| 方案 3: 事件驱动 | 0.25 | 架构优雅，但时序关联复杂 |

### Observation → Update 规则

| Evidence | 增强 | 降低 |
|----------|------|------|
| user message textContent 完整包含 `<function_results>` | 方案1 ↑ | 方案2 ↓ |
| XML-like 内容被 escape 但 textContent 仍完整 | 方案1 ↑ | — |
| code/CDATA 被拆成复杂 codeblock DOM | 方案1 ↓ | 方案2 ↑ |
| submitted message DOM 难定位边界 | 方案3 ↑ | 方案1 ↓ |
| extension 有 reliable lifecycle event | 方案3 ↑ | 方案1 ↓ |

### Posterior (待 observation 后更新)

_TBD — 等 Lane A evidence_

---

## 当前状态

### 现有数据流

```
streamToolBridge:
  1. mcpClient.callTool() → 获得结果
  2. formatFunctionResult() → XML <function_results> 格式
  3. adapter.insertText(XML) → 注入 Notion AI 输入框
  4. adapter.submitForm() → 自动提交
  5. AI 收到完整 XML 作为用户消息，继续 reasoning

同时:
  6. emit('mcp:tool-execution-complete') → ToolResultRenderer
  7. ToolResultRenderer.injectResultBlock() → 在对话区注入 card
```

### 用户看到的问题

```
[对话区域]
  AI: 我来帮你读取文件...
  [ToolResultRenderer card: ✅ Tool: read_file ▸]  ← 当前 v1 card
  用户消息（自动提交的）:                            ← 问题在这里
    <function_results>
      <result call_id="c1" name="read_file" status="success">
        <content type="application/json"><![CDATA[
          def hello():
              print("world")
        ]]></content>
      </result>
    </function_results>
    <result_nonce>ack_c1_0</result_nonce>
    <instruction>In your next response, include verbatim: ...</instruction>
  AI: 好的，我看到了文件内容...
```

用户看到原始 XML 很混乱。期望效果：

```
[对话区域]
  AI: 我来帮你读取文件...
  [Card: ✅ read_file — 点击展开查看结果预览]
  AI: 好的，我看到了文件内容...
```

---

## OO-PL-TDD Phase 1: Observation Plan

### O1: 观察提交后的用户消息 DOM 结构（provider-agnostic）

**目标**：了解 AI 对话中，自动提交的 function_result 用户消息的 DOM 结构。

**观察点**：
1. 用户消息的 DOM 容器元素（class、tag、属性）
2. 消息文本是否在 `<p>`、`<pre>`、`<code>` 还是纯 textContent 中
3. 消息出现的时机（submitForm 后多久 DOM 更新）
4. React/SPA 是否会重渲染这些消息（导致注入的 card 消失）
5. `<function_results>` XML 在 DOM 中的具体呈现方式

**观察方法**：
- Lane A (ChatGPT): CDP probe, bounded polling after submit
- Lane B (Notion): CDP 脚本 + MutationObserver

### O2: 观察 ToolResultRenderer 现有 card 的生存状态

**目标**：确认现有 v1 card 在 autoSubmit 后是否存活。

**观察点**：
1. v1 card 是否在 submitForm 后仍存在
2. AI 开始新回复时，v1 card 是否被 React/SPA 重渲染移除
3. card 和用户消息之间的位置关系

### O3: 观察结果消息的识别可行性

**目标**：确认能否可靠地从用户消息中检测 `<function_results>` XML。

**观察点**：
1. 消息 textContent 是否包含完整 XML
2. 是否有唯一属性可以标记为"工具结果消息"
3. 是否存在时序问题（card 注入 vs 消息 DOM 渲染）

### Observation Probe 分级 (Lane A: ChatGPT)

| Step | 名称 | Submit? | 目的 |
|------|------|---------|------|
| A0 | draft-only | 否 | 验证 composer 能否承载 synthetic payload |
| A1 | submitted | 是 | 观察提交后 user message DOM + Phase 4 smoke |

### Evidence 输出结构

```json
{
  "provider": "chatgpt",
  "lane": "A0|A1",
  "payloadKind": "merged-2-cdata-code",
  "payloadSha256": "...",
  "submit": { "composerFound": true, "submitButtonFound": true, "submitted": true },
  "timing": { "baselineMessageCount": 12, "newUserMessageFoundMs": 1100 },
  "newUserMessage": {
    "rootSelectorCandidate": "...",
    "textContentIncludesPayloadMarker": true,
    "functionResultsPreserved": true,
    "codeBlockCount": 0,
    "rawTextLength": 1234,
    "mountCandidates": ["..."]
  },
  "verdict": {
    "submitPathOk": true,
    "domContractUsable": true,
    "parserRisk": "low|medium|high"
  }
}
```

---

## 技术方案候选（待 observation 验证后确认）

### 方案 1: DOM 后处理 — 检测并替换用户消息

```
MutationObserver 监听对话容器
  → 新的用户消息 DOM 出现
  → 检查 textContent 是否包含 <function_results>
  → 是：隐藏原始文本，注入 card overlay
  → 否：不处理
```

优点：完全解耦，不改现有流程
缺点：依赖 DOM 结构，可能有闪烁（先显示 XML 再替换成 card）

### 方案 2: 预标记 — insertText 时添加标记

```
insertText 时在消息前/后加隐藏标记（data attribute 或 zero-width char）
  → 提交后，扫描带标记的消息
  → 渲染为 card
```

优点：检测更可靠
缺点：需要改 insertText 逻辑

### 方案 3: 事件驱动 — 用已有事件时序

```
streamToolBridge emit('succeeded') 时记录 callId
  → submitForm 完成后，等待用户消息 DOM 出现
  → 用 callId 关联消息和工具调用
  → 渲染为 card
```

优点：利用已有事件系统
缺点：时序匹配复杂

---

## 验收标准

- [ ] Lane A (ChatGPT) observation 证据收集完成（O1/O2/O3）
- [ ] Lane B (Notion) observation 证据收集完成（O1/O2/O3）
- [ ] 基于观察的贝叶斯更新选定技术方案
- [ ] 工具结果在对话中显示为 card 而非原始 XML
- [ ] Card 包含：工具名、状态图标、可折叠结果预览
- [ ] AI 仍然收到完整结果（不影响 reasoning）
- [ ] autoSubmit 延迟不增加（card 渲染不阻塞提交）
- [ ] SPA 重渲染后 card 存活
- [ ] E2E 验证通过

---

## Test Fixture 分层

### Layer 1: Parser / Detector unit fixtures
输入: raw text, 输出: normalized ToolResultBatch / ToolResultCardModel

| Case | 描述 |
|------|------|
| single | 单个 `<function_results>` block |
| merged-2 | 合并的 2 个 `<function_results>` blocks |
| mixed-status | 1 success + 1 error |
| cdata-code | CDATA 中包含 code / JSON / angle brackets |

### Layer 2: Renderer model fixtures
输入: parser 输出的 normalized model, 输出: card DOM

### Layer 3: Provider DOM contract fixtures
输入: 观察到的真实 user message container DOM snapshot

---

## 风险

| 风险 | 严重度 | 缓解 |
|------|--------|------|
| Provider DOM 结构变化导致检测失败 | 高 | 回退到显示原始 XML（现有行为） |
| 闪烁（先显示 XML 再替换） | 中 | 方案 2 预标记可以消除 |
| SPA 重渲染移除 card | 中 | MutationObserver 重注入 |
| submitForm 延迟增加 | 低 | card 渲染在 submit 之后异步执行 |
| ChatGPT evidence 不适用于 Notion | 中 | Lane B 独立验证 |

---

Author: Opus/Claude
Date: 2026-05-10
Updated: 2026-05-11 (添加 Lane A/B, 贝叶斯方案选择, fixture 分层)
