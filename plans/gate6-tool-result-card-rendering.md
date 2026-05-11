# Gate 6: Tool Result Card Rendering — 对话中的结果可视化

> PR branch: `feat/tool-result-card-rendering`
> Author: Opus/Claude
> Depends on: Gate 5d (MERGED), PR #40 (Gate 6A plan, MERGED)
> Status: Observation phase

---

## 目标

当 MCP 工具执行结果被自动提交到 Notion AI 对话后，在对话 UI 中将原始 XML function_result 渲染为可读的 card，而不是让用户看到一大段 XML。

核心需求：
1. **快速自动提交**：工具结果立即注入并提交（autoSubmit=true），延迟最小化，实现连续多轮 tool-loop
2. **结果 Card 渲染**：对话中出现的原始 XML function_result 用户消息，渲染为结构化 card（工具名、状态、可折叠预览）
3. 完整结果仍然发送给 AI 模型（不用 placeholder），AI 需要看到完整内容才能 reason

## 非目标

- 不修改结果注入格式（`formatFunctionResult()` 保持不变）
- 不修改 `streamToolBridge` 的执行逻辑
- 不做 placeholder/引用替换方案（AI 需要完整结果）
- 不做新的 adapter 平台适配（Notion 优先）
- 不做 ACK timeline 合并（Gate 6E 范畴）

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

### O1: 观察提交后的用户消息 DOM 结构

**目标**：了解 Notion AI 对话中，自动提交的 function_result 用户消息的 DOM 结构。

**观察点**：
1. 用户消息的 DOM 容器元素（class、tag、属性）
2. 消息文本是否在 `<p>`、`<pre>`、`<code>` 还是纯 textContent 中
3. 消息出现的时机（submitForm 后多久 DOM 更新）
4. React 是否会重渲染这些消息（导致注入的 card 消失）
5. `<function_results>` XML 在 DOM 中的具体呈现方式

**观察方法**：
- CDP 脚本观察 DOM 变化（MutationObserver）
- 在 Notion `/chat` 页面触发一次 MCP 工具调用
- 记录消息 DOM 结构快照

### O2: 观察 ToolResultRenderer 现有 card 的生存状态

**目标**：确认现有 v1 card 在 autoSubmit 后是否存活。

**观察点**：
1. v1 card 是否在 submitForm 后仍存在
2. AI 开始新回复时，v1 card 是否被 React 重渲染移除
3. card 和用户消息之间的位置关系

### O3: 观察结果消息的识别可行性

**目标**：确认能否可靠地从用户消息中检测 `<function_results>` XML。

**观察点**：
1. 消息 textContent 是否包含完整 XML
2. 是否有唯一属性可以标记为"工具结果消息"
3. 是否存在时序问题（card 注入 vs 消息 DOM 渲染）

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

- [ ] Observation 证据收集完成（O1/O2/O3）
- [ ] 基于观察选定技术方案
- [ ] 工具结果在对话中显示为 card 而非原始 XML
- [ ] Card 包含：工具名、状态图标、可折叠结果预览
- [ ] AI 仍然收到完整结果（不影响 reasoning）
- [ ] autoSubmit 延迟不增加（card 渲染不阻塞提交）
- [ ] React 重渲染后 card 存活
- [ ] Notion AI `/chat` 页面 E2E 验证通过

---

## 风险

| 风险 | 严重度 | 缓解 |
|------|--------|------|
| Notion DOM 结构变化导致检测失败 | 高 | 回退到显示原始 XML（现有行为） |
| 闪烁（先显示 XML 再替换） | 中 | 方案 2 预标记可以消除 |
| React 重渲染移除 card | 中 | MutationObserver 重注入 |
| submitForm 延迟增加 | 低 | card 渲染在 submit 之后异步执行 |

---

Author: Opus/Claude
Date: 2026-05-10
