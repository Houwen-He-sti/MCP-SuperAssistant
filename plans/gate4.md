# Gate 4: Manual Result Injection — Consumption Proof

> PR branch: `feat/gate-4`
> Issue: https://github.com/Houwen-He-sti/MCP-SuperAssistant/issues/14
> Author: Opus/Claude
> Depends on: Gate 3C (MERGED, PR #16)
> Review: GPT-5.5 (PR #18 comment 4404590892)

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
- 不强制默认 NL preamble — preamble 作为候选格式，由 probe 结果决定

---

## 前置条件

| 条件 | 状态 | 说明 |
|------|------|------|
| Gate 3C merged | ✅ | PR #16 |
| `adapter.insertText()` 在 Notion 上工作 | ✅ | Gate 3C E2E 16/16 |
| `formatFunctionResult()` 模块存在 | ✅ | Gate 3C-prep |
| Format probe 初步数据 | ✅ | Gate 3C-prep P0-1（裸 XML 可用） |
| 协议规范定义 | ✅ | VSCode-Dir 根 `docs/mcp-superassistant-tool-protocol.md` §2 |

---

## 技术方案

### P0-1: Format Compatibility Decision (Probe → Choose → Implement)

> **GPT Review 共识**：不能直接改 formatter 格式。先 probe 候选格式的 Notion AI 兼容性，基于 probe 结果做决策，再修改 runtime formatter。

**现状**：当前 `functionResultFormatter.ts` 输出简化格式：
```xml
<function_result call_id="c1" name="echo" status="ok">
{"message":"hello"}
</function_result>
```

**候选格式**（按 probe 顺序）：

| # | 格式 | 说明 |
|---|------|------|
| A | 当前裸 XML（已验证可用） | Gate 3C-prep probe 通过 |
| B | 协议规范格式（CDATA wrapper） | 更完整，但未验证 Notion AI 兼容性 |
| C | 裸 XML + NL preamble | 中间方案 |

**协议规范格式**（`docs/mcp-superassistant-tool-protocol.md` §2.1/§2.2）：
```xml
<function_results>
  <result call_id="c1" name="echo" status="success">
    <content type="application/json"><![CDATA[
{"message":"hello"}
    ]]></content>
  </result>
</function_results>
```

**步骤**：

1. **Probe**：用 CDP 脚本向 Notion AI 注入格式 B 和 C，观察 AI 回复是否引用 result
2. **Decision**：基于 probe 结果选择默认格式
   - 如果格式 B 通过 → 采用协议规范格式
   - 如果格式 B 不通过、C 通过 → 采用裸 XML + preamble
   - 如果只有 A 通过 → 保持现状（不改 formatter）
3. **Implement**：修改 `functionResultFormatter.ts` 到选中格式
4. **Regression**：修改后必须 rerun Gate 3C E2E（16/16 regression）

**Interface 变更**（仅当选择格式 B 时）：
```typescript
export interface FormatResultOptions {
  callId: string;
  name: string;
  status: 'success' | 'error';  // ← 从 'ok' | 'error' 改为 'success' | 'error'
  result: unknown;
}
```

**验收标准**：
- [ ] Probe 结果记录（至少测格式 B 和 C 各 1 次）
- [ ] 格式决策有 probe 证据支撑
- [ ] 若改 formatter：输出格式 match 选中候选
- [ ] 若改 formatter：所有现有 unit tests 更新并通过
- [ ] 若改 formatter：`streamToolBridge.ts` 调用点更新
- [ ] Gate 3C E2E regression 通过（16/16）

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

### P0-3: Error Consumption Proof (Manual/Direct Injection Only)

**目标**：验证 Notion AI 能理解并合理回应**手动注入的** error result block。

> **Scope 说明**：P0-3 仅验证 error-format 的 consumption（AI 能理解错误 XML），
> **不验证** production bridge 的 tool-failure → error-result auto-injection 路径。
> Production error-result auto-injection 属于 Gate 5 scope（与 autoSubmit 同层 bridge 行为增强）。

**测试步骤**：
1. 构造 error-format function_result block（协议 §2.2 格式）
2. 通过 CDP adapter 脚本直接注入输入框
3. 通过 DOM click send button 提交
4. 观察 AI 回复

**期望行为**：
- AI 回显或引用 error ID / error message
- AI 不忽略错误内容

**验收标准**：
- [ ] Error result 格式正确（协议 §2.2）
- [ ] AI 回复中提到了错误 ID 或错误内容
- [ ] 3/3 次 AI 回显了 error ID = PASS

---

### P1: Scanner 状态重置观测 (Non-blocking — defer hard requirement to Gate 5)

> **GPT Review 共识**：Scanner 重置不应作为 Gate 4 P0 blocker。在 consumption proof 过程中**观测**即可，发现问题则记录，hard fix defer 到 Gate 5 prep。

**目标**：在 P0-2 consumption proof 过程中，观测 scanner 是否在第二轮正常工作。

**背景**：`functionCallScanner.ts` 在跨 patch 累积时使用内部 buffer。第一轮结束后（stream_end），如果 AI 在第二轮再次输出 function_call，scanner 是否能正确重置并重新检测？

**测试方法**：
1. 在 P0-2 过程中观察 console/CDP 输出
2. 如果 AI 自发调用第二个工具 → 记录 scanner 是否检测到
3. 如果没有自然发生 → 仅记录 "未观测到"，不强制构造

**验收标准**：
- [ ] 记录观测结论（detected / not observed / failed）
- [ ] 如果 failed → 创建 Issue，标记为 Gate 5 prep blocker
- [ ] **不阻塞 Gate 4 merge**

---

## 实施顺序

```
1. P0-1a (format probe) — CDP 脚本测格式 B/C，不修改 runtime 代码
2. P0-1b (format decision + implement) — 基于 probe 修改 formatter（如有必要）
3. P0-regression (Gate 3C E2E) — 若改了 formatter，rerun 16/16
4. P0-2 (success consumption proof) — 真实 Notion + Chrome
5. P0-3 (error consumption proof) — 同上
6. P1 (scanner 观测) — 在 P0-2 过程中顺便观察
```

---

## 风险

| 风险 | 影响 | 缓解 |
|------|------|------|
| Notion AI 不理解 CDATA 语法 | 格式 B 不可用 | Probe 先测；回退到格式 A 或 C |
| Notion AI 忽略 function_result 整块 | P0-2 失败 | 尝试 NL preamble wrapper；如全部不通过 → 重新调研 Notion prompt 约定 |
| Consumption proof 非确定性 | 误判格式有效/无效 | 3 次 majority 判定 + sentinel 值 |
| Formatter 改动导致 Gate 3C regression | 基础失效 | P0-1 后立即跑 Gate 3C E2E 回归 |
| SPA 导航在 submit 后改变页面状态 | 第二轮观测失败 | CDP 在稳定等待后再读取 |
| `status: 'ok'` → `'success'` 改名破坏调用方 | 现有代码报错 | 全局搜索替换所有调用点 |

---

## 测试策略

| 项 | 测试类型 | 工具 |
|----|---------|------|
| P0-1a | CDP probe 脚本 | `scripts/e2e-gate4-format-probe.cjs` |
| P0-1b | 单元测试 | `functionResultFormatter.test.ts` — 更新/新增 |
| P0-regression | E2E regression | `scripts/e2e-gate3c-injection.cjs` — rerun |
| P0-2 | CDP real-browser 半自动 | `scripts/e2e-gate4-consumption.cjs` |
| P0-3 | CDP real-browser 半自动 | 同 P0-2 脚本，error path |
| P1 | CDP 观测 | 在 P0-2 过程中观察 console |

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
  1. Probe: run CDP script with formats B and C against live Notion
  2. Decision: choose format based on probe results
  3. If changing formatter:
     a. Update existing unit tests to expect new format
     b. Add tests: CDATA wrapping (if applicable), error format, special chars
     c. Confirm ALL FAIL
     d. Update formatFunctionResult() implementation
     e. Update status type and all callers
     f. Confirm ALL PASS
     g. Run Gate 3C E2E regression (16/16)

For P0-2/P0-3 (consumption proof):
  1. Write CDP test script with sentinel assertions
  2. Run against live Notion — human submits
  3. Capture AI response
  4. Verify sentinel presence
  5. Record transcript
```

---

## Definition of Done

- [ ] Format probe completed (at least formats B and C tested)
- [ ] Format decision documented with probe evidence
- [ ] If formatter changed: output matches chosen format
- [ ] If formatter changed: all unit tests updated and passing
- [ ] If formatter changed: Gate 3C E2E regression passes (16/16)
- [ ] All existing tests still pass (`node --test --experimental-strip-types`)
- [ ] E2E: success consumption proof — sentinel referenced by AI (≥2/3)
- [ ] E2E: error consumption proof — AI acknowledges error (≥1/1)
- [ ] P1: scanner second-turn observation recorded
- [ ] Transcripts saved as Gate 4 evidence
- [ ] PR created and sent to GPT review
