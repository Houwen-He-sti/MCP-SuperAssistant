# Gate 3C: Adapter + DOM Injection + Allowlist

> PR branch: `feat/gate-3c`
> Issue: https://github.com/Houwen-He-sti/MCP-SuperAssistant/issues/14
> Author: Opus/Claude
> Depends on: Gate 3C-prep (MERGED, PR #15)

---

## 目标

在真实 Notion AI 环境中验证完整的 tool result injection 流程：
1. adapter 解析正确
2. `function_result` 正确插入 DOM 输入框
3. Draft protection 正常工作
4. Tool allowlist 过滤非授权工具

> **Note**: Consumption proof (P0-4) deferred to Gate 4 — requires autoSubmit + AI interaction, scope too large for 3C.

## 非目标

- 不实现 autoSubmit=true 循环（Gate 5）
- 不实现 circuit breaker 运行时逻辑（Gate 5）
- 不做多轮验证（Gate 4 edge cases）
- 不做 error result consumption 验证（Gate 4）
- ~~不做 consumption proof~~（moved to Gate 4）

---

## 技术方案

### P0-0: Triage NotionAdapter `emitExecutionFailed` undefined

**背景**: Gate 3C-prep format probe 中暴露 `adapter.emitExecutionFailed` 为 undefined（NotionAdapter 缺少该方法）。

**目标**: 确认这个 bug 是否影响 Gate 3C 的 `adapter.insertText` 路径。

**行动**:
1. 检查 `insertText` 内部是否调用 `emitExecutionFailed`
2. 如果调用了 → 必须修复后再继续
3. 如果不调用（只在 error path / legacy path 中使用）→ 记录为 known issue，不阻塞 Gate 3C

**验收标准**:
- [ ] 确认 `insertText` 路径不触发 `emitExecutionFailed`
- [ ] 或修复该 bug
- [ ] 记录结论

---

### P0-1: Tool Allowlist

**接口变更** (`streamToolBridge.ts`):
```typescript
export interface StreamToolBridgeConfig {
  enabled: boolean;
  autoInsert: boolean;
  autoSubmit: boolean;
  toolTimeoutMs: number;
  circuitBreaker?: { maxToolCallsPerStream?: number };
  // NEW: Gate 3C
  toolAllowlist?: string[];  // undefined/empty = allow all (backward compatible)
}
```

**实现位置**: `createStreamToolHandler` 内，Step 1 (identity validation) 之后、Step 2 (parse) 之前插入：

```typescript
// Step 1b: Tool allowlist check
if (config.toolAllowlist && config.toolAllowlist.length > 0) {
  if (!config.toolAllowlist.includes(identity.name)) {
    emit(streamId, identity, 'failed', {
      phase: 'identity',
      error: `Tool "${identity.name}" not in allowlist`,
      errorCode: 'TOOL_NOT_ALLOWED',
    });
    return;
  }
}
```

**设计决策**:
- `undefined` 或 `[]` → 允许所有工具（向后兼容）
- 精确字符串匹配（不支持 glob/regex — YAGNI）
- 在 parse 之前检查（节省 JSON.parse 开销）
- `phase: 'identity'` 因为这是身份验证层面的拒绝

**验收标准**:
- [ ] `undefined` allowlist → 允许所有工具
- [ ] `[]` allowlist → 允许所有工具
- [ ] `['echo']` + echo → 正常执行
- [ ] `['echo']` + read_file → emit `TOOL_NOT_ALLOWED`，不 reserve
- [ ] `configureStreamToolBridge({ toolAllowlist: ['echo'] })` → `getStreamToolBridgeInfo().config.toolAllowlist` 返回 `['echo']`
- [ ] 单元测试覆盖以上 5 种情况

### P0-2a: E2E CDP — Adapter-Only Insert (低层诊断)

**目标**: 验证 adapter 本身能在 Notion 上工作（排除 bridge 层问题）。

**脚本**: `scripts/e2e-gate3c-injection.cjs`

**测试步骤**:
1. 连接 CDP (port 9222)
2. 发现 ISOLATED world contextId
3. 调用 `getStreamToolBridgeInfo()` 验证 adapter 状态
4. 直接在 ISOLATED world 调用 `formatFunctionResult` + `adapter.insertText`
5. 调用 `adapter.getInputContent()` 验证内容

**验收标准**:
- [ ] adapter resolution 在 Notion `/agent` 页面返回有效 adapter
- [ ] `insertText(formattedResult)` 后 `getInputContent()` 包含 function_result XML

---

### P0-2b: E2E CDP — Full Bridge autoInsert Path (Gate 3C 核心验收)

**目标**: 验证完整的 stream_cutoff → bridge → mcpClient → formatter → adapter.insertText 路径。

**脚本**: `scripts/e2e-gate3c-injection.cjs`（追加测试用例）

**测试步骤**:
1. 在 ISOLATED world 配置:
   ```javascript
   configureStreamToolBridge({ enabled: true, autoInsert: true, autoSubmit: false, toolAllowlist: ['echo'] })
   ```
2. 设置 mock mcpClient:
   ```javascript
   window.mcpClient = { callTool: async (name, params) => params, isReady: () => true }
   ```
3. 从 MAIN world 发送 stream_cutoff event（通过 postMessage bridge）
4. 等待 bridge 处理
5. 检查:
   - `callTool` 被调用一次
   - Notion 输入框包含 `<function_result ...>`
   - `autoSubmit` 未触发（用户看到结果在输入框）

**验收标准**:
- [ ] Full bridge path: stream_cutoff → tool execution → DOM injection
- [ ] autoSubmit=false 时不自动提交
- [ ] Allowlist 生效（非 echo 工具被拒绝）

> **重要**: Adapter-only E2E (P0-2a) 通过不足以关闭 Gate 3C。至少一条 full bridge E2E (P0-2b) 必须通过。

### P0-3: E2E CDP — Draft Protection

**脚本**: 同 `scripts/e2e-gate3c-injection.cjs`（不同测试用例）

**测试步骤**:
1. 先用 adapter/execCommand 在输入框写入 "用户草稿文本"
2. 通过 full bridge path 触发 stream_cutoff + tool execution
3. 验证输入框内容未被覆盖（仍是 "用户草稿文本"）
4. 捕获 bridge event

**验收标准**:
- [ ] `mcpClient.callTool` 被执行（tool 本身成功运行）
- [ ] `adapter.insertText` **未**被调用
- [ ] 输入框内容仍为 "用户草稿文本"
- [ ] 事件状态为 `succeeded`（tool 执行成功，insert 跳过因 draft exists）

### P0-4: ~~Consumption Proof~~ (Deferred to Gate 4)

> **Moved to Gate 4**: Consumption proof requires autoSubmit + AI interaction.
> This is beyond Gate 3C scope (injection + allowlist + draft protection).
> See Issue #14 for Gate 4 planning.

### (P0-5 已合并到 P0-1 和 P0-2b)

---

## 实施顺序

```
0. P0-0 (triage emitExecutionFailed) — 确认不阻塞，或修复
1. P0-1 (allowlist) — 最小代码改动 + 5 个单元测试
2. P0-2a (adapter-only E2E) — 快速验证 DOM 层
3. P0-2b (full bridge E2E) — Gate 3C 核心验收
4. P0-3 (draft protection E2E) — 同脚本追加
5. P0-4 (consumption proof) — 最后，需要 AI 交互
```

## 风险

| 风险 | 影响 | 缓解 |
|------|------|------|
| Notion adapter DOM 选择器失效 | P0-2 失败 | 先跑 `getStreamToolBridgeInfo()` 诊断 |
| Notion AI 不引用 function_result | P0-4 失败 | 格式已在 3C-prep format probe 验证过，可重复测试 |
| mcpClient 在 E2E 中不可用 | 完整 bridge 路径无法测 | P0-2b 用 mock mcpClient 注入 ISOLATED world |
| execCommand 在新 Notion 版本失效 | insertText 失败 | 监控 Notion 更新日志，adapter 本身有降级路径 |
| SPA 导航在测试中途触发 | 结果不稳定 | CDP 脚本在稳定状态等待后再测 |
| Adapter-only E2E 通过但 full bridge 失败 | 误判 Gate 通过 | P0-2b 是核心验收，不能只靠 P0-2a |
| `emitExecutionFailed` bug 影响真实 adapter path | DOM injection 失败 | P0-0 前置 triage |
| Consumption proof 非确定性 | 误判格式不稳定 | 使用 sentinel，保留 transcript，3 次多数 |

## 测试策略

- **P0-0**: 代码审查 + 确认（无测试）
- **P0-1**: 纯单元测试 (`streamToolBridge.test.ts`) — 5 个用例
- **P0-2a**: CDP real-browser adapter-only (`scripts/e2e-gate3c-injection.cjs`)
- **P0-2b**: CDP real-browser full bridge (`scripts/e2e-gate3c-injection.cjs`)
- **P0-3**: CDP real-browser draft protection (`scripts/e2e-gate3c-injection.cjs`)
- **P0-4**: CDP real-browser consumption (`scripts/e2e-gate3c-consumption.cjs`)

## Dependencies

- Chrome with Notion AI tab (port 9222)
- Extension loaded (`hkjclekhnaffnhldgpmjnohihjmblbpj`)
- Content script active (ISOLATED world)
- Adapter functional on current page

## TDD Flow

```
For P0-1 (allowlist):
  1. Write 3 unit tests (allow, reject, empty=allow-all)
  2. Confirm FAIL
  3. Implement allowlist check
  4. Confirm PASS

For P0-2/P0-3 (E2E):
  1. Write CDP script with assertions
  2. Run against live Notion — observe failures
  3. Fix any discovered issues
  4. Re-run until PASS
```

## Definition of Done

- [x] P0-0: `emitExecutionFailed` triaged — fixed (added to NotionAdapter)
- [x] Allowlist implemented with 5 unit tests passing
- [x] E2E: adapter resolves on Notion (P0-2a)
- [x] E2E: **full bridge** autoInsert path works (P0-2b) — 不能只靠 adapter-only
- [x] E2E: draft protection prevents overwrite (P0-3)
- [ ] ~~E2E: AI consumption proof~~ (deferred to Gate 4)
- [x] `toolAllowlist` config visible in `getStreamToolBridgeInfo()`
- [x] All existing tests still pass (55/55 via `node --test --experimental-strip-types`)
- [x] PR created, sent to GPT review
