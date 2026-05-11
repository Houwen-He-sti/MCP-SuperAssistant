# Phase 1B: autoSubmit Full Loop Verification

## 背景

Phase 1A 已验证 `autoInsert` 在 Notion AI 上正常工作。
Phase 1B 目标：验证 `autoSubmit` 开启后的完整闭环。

## OO（第一手观察 — Phase 1A 结果）

### 已验证事实

| # | 事实 | 证据 |
|---|------|------|
| 1 | autoInsert 正常工作 | input 0→2778 chars，CDP 实测 |
| 2 | 完整 B-route 管道通 | AI→jsonl→scanner→execute→event→autoInsert |
| 3 | 必须用 clipboard+Ctrl+V | execCommand('insertText') 无效 |
| 4 | autoInsert 格式 | `<mcp-system-prompt>...</mcp-system-prompt>\n<function_result>...</function_result>` |
| 5 | autoSubmit=false 时结果停在输入框 | 实测 |
| 6 | Notion AI 理解 jsonl 协议 | 成功输出 function_call_start |
| 7 | Echo tool 参数错误 | AI 调 echo 没传 message（不影响 autoInsert 验证）|
| 8 | 无 loop breaker / max-turn guard | 代码搜索确认 |
| 9 | Zustand persist + localStorage | 改 localStorage + reload = 重新 hydrate |

### 被降级的假设

- MAIN→ISOLATED event 失败 → ❌ 已排除
- adapter 未 ready → ❌ 已排除
- BatchAwareHandler 路由问题 → 极低概率

## PL（计划）

### 目标

验证 autoSubmit 开启后完整闭环：
```
AI emits jsonl → tool executes → autoInsert → autoSubmit → AI receives result → AI responds
```

### 验收标准

1. autoInsert detected（input 出现 function_result）
2. autoSubmit detected（input 被自动清空 = 提交）
3. submit exactly-once（submitCount <= 1）
4. AI 收到结果后自然语言响应
5. 无无限循环（toolCallCount <= 3）
6. Kill switch NOT triggered

### 测试策略

- **使用 echo success prompt**（明确指示 AI 传 message 参数）
- **不用 error 做主线**
- **CDP 脚本内置 guard**：maxToolCalls=3, maxSubmits=2, maxDuration=90s
- **Kill switch**：超限立即关闭 autoSubmit

## 4C

### Communicate
- 与 GPT 完成 review，达成共识

### Confirm
- autoInsert baseline 已确认（Phase 1A）
- localStorage + reload 方案确认
- 测试 guard 方案确认

### Confess
- 不确定 autoSubmit 是否 exactly-once
- 不确定 AI 看到 error 后是否重试
- 不确定 autoSubmitDelay:2 是否足够等 insert 完成
- CDP 无法直接验证 ISOLATED world 的 Zustand state（只能间接通过行为验证）

### Critique
- 最大风险：无限循环（代码无 loop breaker）
- 缓解：echo 场景下 AI 不太可能持续调工具
- 缓解：测试脚本有外部 guard + kill switch
- 不能依赖"AI 大概率自然终止"作为安全机制

## R1（Reflect）

确认：
- Phase 1B 是受控观察，不是生产部署
- 测试脚本必须有 guard，不允许裸开 autoSubmit
- localStorage 修改后 reload 重新 hydrate

行动：
1. 运行 Phase 1B 测试
2. 观察结果
3. 成功则沉淀 E2E regression

## R2（Review — GPT 共识）

### GPT 关键纠正（已采纳）

1. **localStorage vs live store**：仅改 localStorage 不够，需 reload 重新 hydrate Zustand
2. **测试 guard 必须有**：不能只靠 60s timeout + 人工监控
3. **echo success prompt**：不要用 validation error 做主线
4. **风险缓解不能依赖模型行为预测**：必须用测试 runner guard

### GPT 建议的验收标准（已纳入）

| Check | Pass 条件 |
|-------|-----------|
| autoInsert | function_result 曾进入 input |
| autoSubmit | input 之后被清空 |
| exactly-once | function_result user message 只提交 1 次 |
| AI response | Notion AI 后续自然语言响应 |
| no loop | 无第二轮不必要 tool call |
| no leftover draft | 最终 input 为空 |

### GPT 建议的 guard limits

```javascript
const limits = {
    maxDurationMs: 90_000,
    maxToolCalls: 3,
    maxSubmittedFunctionResults: 2,
    maxAutoSubmitClicks: 2,
};
```

## 测试脚本

`scripts/notion-phase1b-auto-submit.cjs`

## 执行方法

```bash
cd MCP-SuperAssistant/scripts
node notion-phase1b-auto-submit.cjs
```

前提条件：
- Chrome 打开 notion.so/ai
- CDP 端口 9222
- MCP proxy 运行在 3006
- 扩展已加载
