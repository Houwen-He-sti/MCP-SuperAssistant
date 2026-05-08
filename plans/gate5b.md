# Gate 5b: Live Notion/CDP Bridge Pipeline E2E

> PR branch: `feat/gate-5b`
> PR: #21
> Issue: https://github.com/Houwen-He-sti/MCP-SuperAssistant/issues/20
> Author: Opus/Claude
> Depends on: Gate 5 (PR #19, MERGED)
> Scope: Bridge pipeline verification (stream detect → callTool → insertText → submitForm)
> Note: AI consumption / sentinel verification is deferred to Gate 5c

---

## 目标

验证 Gate 5 auto-submit loop 在 **真实 Notion 浏览器环境** 中端到端工作。

Gate 5 证明了 runtime 代码的正确性（112 tests, mocked integration）。Gate 5b 的目标是补充 **live evidence**：从 AI 输出 function_call → stream_cutoff → bridge 执行 tool → 注入 result → 自动提交，全流程在真实浏览器中观测。

> **Rescope note (PR #21 review consensus)**：Gate 5b 验证的是"我们的代码"（extension bridge pipeline）的正确性。AI 是否消费注入结果属于 AI 行为验证，不在 extension 系统边界内，归入 Gate 5c。

---

## 非目标

- 不修改 runtime 代码（已在 Gate 5 完成）
- ~~不修改 scanner / interceptor 逻辑~~ → **Accepted exception**: 发现 scanner 只处理 `o:'x'` 而遗漏 `o:'a'` 补丁，这是阻塞 E2E 的 root cause，必须修复 (详见 VSCode-Dir repo: `docs/investigations/2026-05-11-gate5b-live-e2e-scanner-fix.md`)
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

### Step 3: 安装 dependency wrapper 观测器

> GPT Review: 不要只靠 console intercept + DOM polling。在 ISOLATED world 包一层真实依赖。

在 ISOLATED world 中 wrap 真实 adapter 和 mcpClient 方法，记录调用：

```javascript
window.__gate5b_events = [];
window.__gate5b_sentinel = 'sentinel_g5b_' + Date.now().toString(36);

// Wrap mcpClient.callTool
const origCallTool = window.mcpClient.callTool.bind(window.mcpClient);
window.mcpClient.callTool = async (name, params) => {
  window.__gate5b_events.push({ type: 'callTool', name, params, ts: Date.now() });
  const result = await origCallTool(name, params);
  window.__gate5b_events.push({ type: 'callTool_result', name, result, ts: Date.now() });
  return result;
};

// Wrap adapter methods via pluginRegistry
const adapter = pluginRegistry.getActivePlugin()?.adapter;
if (adapter) {
  const origInsert = adapter.insertText.bind(adapter);
  adapter.insertText = async (text) => {
    window.__gate5b_events.push({ type: 'insertText', textLen: text.length, preview: text.slice(0, 200), ts: Date.now() });
    const result = await origInsert(text);
    window.__gate5b_events.push({ type: 'insertText_result', result, ts: Date.now() });
    return result;
  };

  const origSubmit = adapter.submitForm?.bind(adapter);
  if (origSubmit) {
    adapter.submitForm = async () => {
      window.__gate5b_events.push({ type: 'submitForm', ts: Date.now() });
      const result = await origSubmit();
      window.__gate5b_events.push({ type: 'submitForm_result', result, ts: Date.now() });
      return result;
    };
  }

  const origGetInput = adapter.getInputContent?.bind(adapter);
  if (origGetInput) {
    adapter.getInputContent = () => {
      const content = origGetInput();
      window.__gate5b_events.push({ type: 'getInputContent', contentLen: content?.length ?? -1, ts: Date.now() });
      return content;
    };
  }
}
```

**不修改 runtime 代码**，只在 test 期间 wrap。

### DOM Click Fallback 策略

> GPT Review: DOM click fallback 不能算 production autoSubmit PASS。

- 如果 `adapter.submitForm()` 成功 → **PASS** (production path)
- 如果 `adapter.submitForm()` 失败但 DOM click 成功 → **DIAGNOSTIC**（记录为 known issue，需修复 production adapter）
- 如果两者都失败 → **FAIL**

```
Evidence report 中必须明确标注 submit 方式：
  submit_method: 'adapter.submitForm' | 'dom_click_fallback' | 'failed'
```
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
| callTool invoked | `__gate5b_events` array | tool 被 bridge 调用 |
| insertText invoked | `__gate5b_events` array | result 被注入 DOM |
| submitForm invoked | `__gate5b_events` array | 自动提交触发 |
| stream lifecycle | MAIN world postMessage | stream_start/function_call/stream_cutoff |

> **Note**: AI consumption (sentinel echo) 验证属于 Gate 5c scope。Gate 5b 的 PIPELINE_PASS 条件为：callTool + insertText + submitForm 全部成功。

### Step 6: Durable Evidence Artifact

> GPT Review: 必须输出 durable evidence artifact。

脚本自动生成两个文件：

**JSON 原始数据** (`outputs/gate5b-live-notion-e2e-{timestamp}.json`):
```json
{
  "timestamp": "2026-05-10T12:00:00Z",
  "bridgeConfig": { "enabled": true, "autoInsert": true, "autoSubmit": true },
  "sentinel": "sentinel_g5b_xxx",
  "events": [
    { "type": "callTool", "name": "echo", "ts": 1234567890 },
    { "type": "insertText", "textLen": 150, "ts": 1234567891 },
    { "type": "submitForm", "ts": 1234567892 },
    { "type": "submitForm_result", "result": true, "ts": 1234567893 }
  ],
  "submitMethod": "adapter.submitForm",
  "sentinelBefore": 0,
  "sentinelAfter": 2,
  "scannerEvidence": null,
  "result": "PIPELINE_PASS"
}
```

**Markdown 报告** (`outputs/gate5b-live-notion-e2e-{timestamp}.md`):
```markdown
# Gate 5b Live E2E Evidence — {timestamp}

## Result: PASS/FAIL/DIAGNOSTIC

| Step | Status |
|------|--------|
| CDP connect | ✅ |
| ISOLATED world | ✅ |
| Bridge config | ✅ autoInsert + autoSubmit |
| Tool executed | ✅ echo({"message": "sentinel_xxx"}) |
| Result injected | ✅ 150 chars |
| Auto-submitted | ✅ adapter.submitForm |
| Stream lifecycle | ✅ start→call→cutoff→end |
```

### Scanner Miss Debugging Evidence

> GPT Review: scanner miss 要保留 debugging evidence。

如果 60 秒内没有检测到 bridge 活动：

1. 检查 MAIN world console 是否有 `[StreamInterceptor]` 日志
2. 检查 ISOLATED world `__gate5b_events` 是否有任何 event
3. 如果 events 为空 → scanner 可能未检测到 function_call
4. 保存以下 debugging data：
   - MAIN world console log (last 50 lines)
   - ISOLATED world console log (last 50 lines)
   - stream lifecycle 状态
   - page body last 500 chars（检查 AI 是否输出了 function_call 但 scanner 未识别）

```json
{
  "result": "SCANNER_MISS",
  "debugging": {
    "mainConsole": ["..."],
    "isoConsole": ["..."],
    "pageBodyTail": "...",
    "hypothesis": "AI output function_call but scanner did not detect"
  }
}
```

---

## 验收标准

- [ ] CDP 脚本成功连接 Notion + ISOLATED world
- [ ] Bridge 配置为 autoInsert=true + autoSubmit=true
- [ ] Dependency wrapper 安装成功 (callTool, insertText, submitForm, getInputContent)
- [ ] AI 输出 function_call → bridge 自动执行 tool (verified via `__gate5b_events`)
- [ ] Result 注入到 input textbox (verified via `__gate5b_events` insertText)
- [ ] **adapter.submitForm** 自动触发成功 (不是 DOM click fallback)
- [ ] Stream lifecycle 完整捕获 (stream_start → function_call → stream_cutoff → stream_end)
- [ ] Durable evidence artifact 生成 (JSON + Markdown)

### Gate 5c Scope (deferred)

- [ ] AI 在回复中引用注入的 result (sentinel before/after protocol)
- [ ] Multi-turn: AI 调用 tool A → bridge 处理 → AI 再调用 tool B → bridge 再处理

### Stretch Goals

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
3. Dependency wrapper 安装 (callTool, insertText, submitForm, getInputContent)
4. 手动触发 + 自动观测 (sentinel before/after)
5. Durable evidence artifact 生成 (JSON + Markdown)
6. Scanner miss debugging evidence (if no bridge activity)
```

---

## GPT Review Findings 处理记录

### Round 1 (Plan review, PR comment #4405613476)

| # | Finding | 处理 |
|---|---------|------|
| 1 | 不要只靠 console intercept，用 dependency wrapper | ✅ Step 3 改为 wrap 真实 adapter/mcpClient 方法 |
| 2 | DOM click fallback 不算 production PASS | ✅ 明确 submitForm vs DOM click 的 PASS/DIAGNOSTIC 区分 |
| 3 | Sentinel 验证要 before/after snapshot | ✅ Step 5 添加 before/after protocol |
| 4 | 必须输出 durable evidence artifact | ✅ Step 6 定义 JSON + Markdown 输出 |
| 5 | Scanner miss 要保留 debugging evidence | ✅ 添加 scanner miss debugging section |

---

## Author

Opus/Claude
