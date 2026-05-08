# Gate 4: Manual Result Injection — Consumption Proof

> PR branch: `feat/gate-4`
> Issue: https://github.com/Houwen-He-sti/MCP-SuperAssistant/issues/14
> Author: Opus/Claude
> Depends on: Gate 3C (MERGED, PR #16)

---

## 目标

验证完整的 tool-loop 闭环：**AI 输出 function_call → 工具执行 → result 注入输入框 → 人工提交 → AI 消费 result 并给出有意义回复**。

Gate 3C 已证明 DOM 注入（insertText）能工作。Gate 4 补全最后一环：**AI 真的理解并消费了注入的 function_result**。

---

## 非目标

- 不实现 `autoSubmit=true`（Gate 5）
- 不实现 circuit breaker / 熔断器（Gate 5）
- 不实现多 provider 适配（Gate 6）
- 不做超过 2 轮的 multi-turn loop 验证（Gate 5 范围）
- 不修改 MAIN world interceptor 或 scanner 逻辑

---

## 前置条件

| 条件 | 状态 | 说明 |
|------|------|------|
| Gate 3C merged | ✅ | PR #16 |
| `adapter.insertText()` 在 Notion 上工作 | ✅ | Gate 3C E2E 16/16 |
| `formatFunctionResult()` 模块存在 | ✅ | Gate 3C-prep |
| Format probe 初步数据 | ✅ | Gate 3C-prep P0-1 |
| 协议规范定义 | ✅ | `docs/mcp-superassistant-tool-protocol.md` §2 |

---

## 技术方案

### P0-1: functionResultFormatter 对齐协议规范

**现状**：当前 `functionResultFormatter.ts` 输出简化格式：
```xml
<function_result call_id="c1" name="echo" status="ok">
{"message":"hello"}
</function_result>
```

**协议要求**（`mcp-superassistant-tool-protocol.md` §2.1/§2.2）：
```xml
<function_results>
  <result call_id="c1" name="echo" status="success">
    <content type="application/json"><![CDATA[
{"message":"hello"}
    ]]></content>
  </result>
</function_results>
```

**变更点**：

1. 外层包裹 `<function_results>` wrapper
2. `status` 值从 `ok` → `success`（对齐协议）
3. Body 用 `<content type="application/json"><![CDATA[...]]></content>` 包裹
4. Error result 用 `<error type="ToolExecutionError"><![CDATA[...]]></error>`
5. 添加 NL preamble（协议 §2.3）：
   ```
   MCP tool result for the previous function call. Continue using this result.
   Do not call the same function again unless the result is insufficient.
   ```

**决策点**：
- Gate 3C-prep format probe 测试了裸 XML 可用。但协议规范格式更完整，需要验证 Notion AI 是否同样理解。
- 如果 Notion AI 不理解 CDATA 语法 → 回退到简化格式（但仍加 wrapper）
- **先写测试，再改代码**（TDD）

**Interface 变更**：
```typescript
export interface FormatResultOptions {
  callId: string;
  name: string;
  status: 'success' | 'error';  // ← 从 'ok' | 'error' 改为 'success' | 'error'
  result: unknown;
}
```

**向后兼容**：`streamToolBridge.ts` 中调用 `formatFunctionResult()` 的位置需要同步更新 status 值。检查并更新所有调用点。

**验收标准**：
- [ ] 输出格式 match 协议 §2.1（success case）
- [ ] 输出格式 match 协议 §2.2（error case）
- [ ] NL preamble 自动添加
- [ ] CDATA 正确包裹 body（含特殊字符如 `<`, `>`, `]]>`）
- [ ] 截断逻辑不变（32KB max）
- [ ] 所有现有 unit tests 更新并通过
- [ ] `streamToolBridge.ts` 调用点 status 值更新

---

### P0-2: Success Consumption Proof (Gate 4 核心验收)

**目标**：证明 Notion AI 在收到 `<function_results>` 后能理解并引用 result 内容。

**方法**：CDP real-browser 半自动测试。

**测试步骤**：
1. 在 Notion AI `/agent` 页面打开对话
2. 通过 CDP 注入 system prompt 工具指令（如果 Notion 支持），或手动确保 AI 知道 echo 工具
3. 触发 AI 输出 `echo(message="hello")` function_call
4. 等待 stream interceptor 检测 + bridge 执行 + `formatFunctionResult()` 格式化
5. `adapter.insertText()` 将 result 注入输入框
6. **人工确认输入框内容正确后，手动点击 submit**
7. 观察 AI 的下一轮回复

**验证逻辑**（使用 sentinel）：
```
注入的 result: {"message":"sentinel_abc123"}
验证: AI 回复中包含 "sentinel_abc123" 或明确引用了 echo 的结果
```

**判定规则**：
- 运行 3 次，majority pass（≥2/3 次 AI 引用 sentinel）= PASS
- 保留所有 transcript 作为 Gate 证据

**验收标准**：
- [ ] AI 在至少 2/3 次中引用了 sentinel 值
- [ ] Transcript 保存到 `docs/investigations/` 或 `outputs/`
- [ ] 格式化后的 result 在输入框中可读（人工目视确认）

---

### P0-3: Error Consumption Proof

**目标**：验证 AI 收到 error result 后的行为合理（不陷入循环、不忽略错误）。

**测试步骤**：
1. 配置一个会失败的 MCP tool（或 mock callTool 返回 error）
2. AI 调用该工具 → bridge 执行 → 工具返回 error
3. `formatFunctionResult({ status: 'error', result: 'Connection refused' })` 格式化
4. 注入输入框 → 人工提交
5. 观察 AI 回复

**期望行为**：
- AI 解释错误（"工具执行失败"）
- 或提供替代方案
- **不期望**：AI 再次调用同一工具（但不阻塞——Gate 5 熔断器处理循环）

**验收标准**：
- [ ] Error result 格式正确（协议 §2.2）
- [ ] AI 回复中提到了错误（不是无视）
- [ ] 1 次成功即可（error 场景确定性更高）

---

### P0-4: Scanner 状态重置验证

**目标**：验证在第一轮 tool loop 完成后，scanner 能正确检测第二轮的 function_call。

**背景**：`functionCallScanner.ts` 在跨 patch 累积时使用内部 buffer。第一轮结束后（stream_end），如果 AI 在第二轮再次输出 function_call，scanner 是否能正确重置并重新检测？

**测试方法**：
1. 完成一次完整的 consumption proof（P0-2）
2. 在 AI 第二轮回复中，如果 AI 自发调用另一个工具 → 观察是否被检测
3. 如果 AI 没有自发调用 → 手动构造 scenario：在第二轮注入新的工具调用 prompt

**验收标准**：
- [ ] 第二轮 function_call 被 scanner 正确检测
- [ ] `stream_start` / `stream_end` 生命周期在第二轮正常触发
- [ ] executionGuard 允许新的 callId 执行（不被旧轮的 guard 阻塞）

**说明**：如果此项测试发现 scanner 不重置 → 成为 Gate 4 P0 blocker，需要修复后才能通过。如果 scanner 正常工作 → 仅记录结论，不做额外代码变更。

---

## 实施顺序

```
1. P0-1 (formatter 对齐协议) — 纯代码 + 单元测试，不需要浏览器
2. P0-2 (success consumption proof) — 需要真实 Notion + Chrome
3. P0-3 (error consumption proof) — 同上
4. P0-4 (scanner 重置) — 在 P0-2 的测试过程中顺便验证
```

---

## 风险

| 风险 | 影响 | 缓解 |
|------|------|------|
| Notion AI 不理解 CDATA 语法 | P0-1 格式需降级 | 先测协议格式，不通过则回退到裸 XML + wrapper |
| Notion AI 忽略 function_result 整块 | P0-2 失败 | 尝试 NL preamble wrapper（协议 §2.3）；如全部不通过 → 重新调研 Notion prompt 约定 |
| Consumption proof 非确定性 | 误判格式有效/无效 | 3 次 majority 判定 + sentinel 值 |
| Scanner 不重置 | P0-4 blocker | 检查 `functionCallScanner.ts` 的 `reset()` 逻辑，必要时手动在 stream_end 后调用 |
| SPA 导航在 submit 后改变页面状态 | 第二轮观测失败 | CDP 在稳定等待后再读取 |
| Gate 3C 代码 regression | 基础失效 | 先跑 Gate 3C E2E 回归 |
| `status: 'ok'` → `'success'` 改名破坏调用方 | 现有代码报错 | 全局搜索替换所有调用点 |

---

## 测试策略

| P0 | 测试类型 | 工具 |
|----|---------|------|
| P0-1 | 单元测试 | `functionResultFormatter.test.ts` — 更新现有 + 新增 CDATA/error 用例 |
| P0-2 | CDP real-browser 半自动 | `scripts/e2e-gate4-consumption.cjs` — inject + verify sentinel |
| P0-3 | CDP real-browser 半自动 | 同 P0-2 脚本，error path |
| P0-4 | CDP real-browser 观测 | 在 P0-2 过程中观察第二轮 scanner 行为 |

---

## Dependencies

- Chrome with Notion AI tab (port 9222)
- Extension loaded with latest build (post-Gate 3C)
- MCP server running with `echo` tool available
- Content script active (ISOLATED world)

---

## TDD Flow

```
For P0-1 (formatter):
  1. Update existing unit tests to expect new format
  2. Add tests: CDATA wrapping, error format, preamble, special chars in body
  3. Confirm ALL FAIL
  4. Update formatFunctionResult() implementation
  5. Update status type and all callers
  6. Confirm ALL PASS

For P0-2/P0-3 (consumption proof):
  1. Write CDP test script with sentinel assertions
  2. Run against live Notion — human submits
  3. Capture AI response
  4. Verify sentinel presence
  5. Record transcript
```

---

## Definition of Done

- [ ] `functionResultFormatter.ts` output matches protocol §2.1 / §2.2
- [ ] NL preamble added per protocol §2.3
- [ ] All existing formatter tests updated and passing
- [ ] New tests for: CDATA, error format, special chars, preamble
- [ ] `streamToolBridge.ts` callers updated (`status: 'success'`)
- [ ] All existing tests still pass (`node --test --experimental-strip-types`)
- [ ] E2E: success consumption proof — sentinel referenced by AI (≥2/3)
- [ ] E2E: error consumption proof — AI acknowledges error (≥1/1)
- [ ] E2E: scanner resets for second-turn function_call
- [ ] Transcripts saved as Gate 4 evidence
- [ ] PR created and sent to GPT review
