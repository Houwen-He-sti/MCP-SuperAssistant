# Gate 5b: Live Notion/CDP Auto-Submit Consumption E2E

> PR branch: `feat/gate-5b`
> PR: 待确认
> Issue: https://github.com/Houwen-He-sti/MCP-SuperAssistant/issues/20
> Author: Opus/Claude
> Depends on: Gate 5 (PR #19, MERGED)

---

## 目标

验证 Gate 5 auto-submit loop 在 **真实 Notion 浏览器环境** 中端到端工作。

Gate 5 证明了 runtime 代码的正确性（112 tests, mocked integration）。Gate 5b 的目标是补充 **live evidence**：从 AI 输出 function_call → stream_cutoff → bridge 执行 tool → 注入 result → 自动提交 → AI 消费 result，全流程在真实浏览器中观测。

---

## 非目标

- 不修改 runtime 代码（已在 Gate 5 完成）
- 不修改 scanner / interceptor 逻辑
- 不实现 UI 面板
- 不要求 100% 自动化通过（AI 行为不确定性 → observation 而非 assertion）

---

## 前置条件

1. Gate 5 已 merge（PR #19 ✅）
2. Chrome with `--remote-debugging-port=9222`
3. Notion 页面打开（notion.so/... ）
4. MCP SuperAssistant extension loaded（pluginRegistry 可用）
5. mcpClient ready (有至少一个 tool 可用，如 `echo` 或 `read_workspace_file`)

---

## 现有基础设施

Gate 4 已有多个 CDP E2E 脚本可复用：

| Script | 做了什么 | 可复用部分 |
|--------|---------|-----------|
| `e2e-gate4-auto-submit-v2.cjs` | 直接 inject Format B + DOM click submit + poll sentinel | CDP 连接、ISOLATED world 查找、sentinel polling |
| `e2e-gate4-consumption.cjs` | 验证 AI 消费 injected result | consumption verification pattern |
| `e2e-gate3c-injection.cjs` | adapter.insertText() 验证 | adapter injection pattern |

**关键差异**：Gate 4 scripts **直接注入** result text（绕过 bridge）。Gate 5b 需要通过 **production bridge path** 触发：配置 autoInsert=true + autoSubmit=true → 让 AI 自然输出 function_call → bridge 自动处理。

---

## 实施方案

### Approach A: Semi-Automated (推荐)

1. CDP script 配置 bridge（autoInsert=true, autoSubmit=true）
2. **人工** 在 Notion 发送 prompt 触发 AI 调用 tool（如 "请调用 echo tool 输出 hello"）
3. CDP script **观测**：
   - stream_cutoff event 是否被 bridge 接收
   - tool 是否被 callTool 执行
   - result 是否被 insertText 注入
   - submitForm 是否被调用
   - AI 回复中是否包含 sentinel

**优点**：不需要自动化触发 AI 行为（AI prompt engineering 不确定性太大），focus 在观测 bridge production path。

### Approach B: Fully Automated (stretch)

1. CDP 直接在 Notion 输入框注入 prompt text + 自动提交
2. 等待 AI response → stream_cutoff → bridge → auto-submit → AI 再次消费
3. 全自动验证

**风险**：AI 可能不调用 tool（prompt engineering 不确定），或 Notion DOM 结构变化导致提交失败。

### 建议

先实现 **Approach A**（semi-automated），如果成功且 AI 行为稳定，可以扩展到 Approach B。

---

## 详细步骤 (Approach A)

### Step 1: CDP 连接 + 环境检查

复用 gate4 pattern：
```javascript
// 1. 连接 Chrome DevTools
// 2. 找到 Notion tab
// 3. 找到 ISOLATED world (MCP SuperAssistant context)
// 4. 检查 preflight:
//    - mcpClient.isReady()
//    - pluginRegistry 可用
//    - adapter.insertText 存在
//    - adapter.submitForm 存在
//    - adapter.getInputContent 存在
```

### Step 2: 配置 bridge (autoInsert + autoSubmit)

```javascript
// 在 ISOLATED world 中执行：
configureStreamToolBridge({
  enabled: true,
  cutoffEnabled: true,
  autoInsert: true,
  autoSubmit: true,
});

// 验证配置：
const info = getStreamToolBridgeInfo();
// assert: info.config.enabled === true
// assert: info.config.autoInsert === true
// assert: info.config.autoSubmit === true
```

### Step 3: 安装 event 观测器

```javascript
// 在 ISOLATED world 注入 event listener:
window.__gate5b_events = [];
// Hook into bridge handler onEvent
// 方案：通过 configureStreamToolBridge 重新初始化后，
// 读取 event log（bridge 已有 console.log/warn output）
```

**问题**：`onEvent` callback 在 `createStreamToolHandler` 内部，不容易从外部 hook。

**替代方案**：
- **Console intercept**: 在 ISOLATED world 中 monkey-patch `console.debug` 和 `console.warn`，捕获 `[StreamToolBridge]` 前缀的日志
- **Bridge info polling**: 定期调用 `getStreamToolBridgeInfo()` 检查状态变化
- **DOM observation**: 在 MAIN world 观测 input textbox 内容变化（result 被 insert 时内容会变）

### Step 4: 人工触发 (prompt)

脚本打印提示：
```
📝 请在 Notion 中输入以下 prompt：
   "请调用 echo 工具，参数为 {"message": "sentinel_xxx"}"

   等待 AI 开始 streaming...
   脚本将自动检测 bridge 活动。
```

### Step 5: 观测 + 验证

Poll 以下信号（最多等待 60 秒）：

| Signal | 检测方式 | 含义 |
|--------|---------|------|
| Bridge event logs | console intercept | stream_cutoff → executing → succeeded/failed |
| Input content change | DOM polling (MAIN world) | result 被 insertText 注入 |
| Submit trigger | DOM observation (send button state) | submitForm 被调用 |
| AI response | sentinel polling (body.innerText) | AI 消费了注入的 result |

### Step 6: 结果报告

```
=== Gate 5b E2E Results ===
✅ stream_cutoff received: YES
✅ Tool executed: echo({"message": "sentinel_xxx"})
✅ Result injected: <function_results>...</function_results>
✅ Auto-submitted: YES
✅ AI consumed result: sentinel count = 2 (user + AI echo)
```

---

## 验收标准

- [ ] CDP 脚本成功连接 Notion + ISOLATED world
- [ ] Bridge 配置为 autoInsert=true + autoSubmit=true
- [ ] AI 输出 function_call → bridge 自动执行 tool
- [ ] Result 注入到 input textbox
- [ ] submitForm 自动触发（或 DOM click fallback）
- [ ] AI 在回复中引用注入的 result（sentinel 验证）

### Stretch Goals

- [ ] Multi-turn: AI 调用 tool A → bridge 处理 → AI 再调用 tool B → bridge 再处理
- [ ] Error path: AI 调用不存在的 tool → bridge 注入 error result → AI 处理错误

---

## 已知风险

1. **submitForm binding issue**: Gate 4 CDP scripts 发现 `adapter.submitForm()` 有时因为 `this` binding 问题失败，fallback 到 DOM click。Gate 5b 可能需要同样的 fallback。

2. **AI 不调用 tool**: 即使 prompt 要求调用 tool，AI 可能直接回答问题而不调用。需要精心设计 prompt。

3. **Notion DOM 变化**: Notion 可能更新 DOM 结构，导致 send button selector 失效。

4. **stream_cutoff timing**: MAIN world interceptor 的 cutoff 检测依赖 scanner，如果 AI 的 function_call 格式变化，scanner 可能未检测到。

---

## 实施计划

```
1. CDP infra: 连接 + ISOLATED world 发现 + preflight check
2. Bridge 配置: autoInsert=true, autoSubmit=true
3. Event 观测器: console intercept + DOM polling
4. 手动触发 + 观测
5. 结果报告生成
```

---

## Author

Opus/Claude
