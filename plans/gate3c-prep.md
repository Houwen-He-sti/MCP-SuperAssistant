# Gate 3C-prep: Format Probe + Adapter Diagnostic

> PR: feat/gate-3c-prep
> Issue: https://github.com/Houwen-He-sti/MCP-SuperAssistant/issues/14
> Author: Opus/Claude

---

## 目标

验证 Notion AI 在当前 runtime 中最小可用的 function_result 回注格式，并为 Gate 3C（result injection）提供必要的基础设施。

## 非目标

- 不实现完整 tool loop
- 不实现 circuit breaker 逻辑
- 不做通用 multi-provider format abstraction
- 不修改现有 Gate 3A/3B 代码逻辑

## 技术方案

### P0-1: function_result Format Probe

**目标**：确定 Notion AI 能正确消费的 function_result 格式。

**方法**：CDP real-browser 脚本，向 Notion AI 输入框注入 3 种格式的 function_result，提交后观察 AI 回复。

**测试格式**（按优先级）：

1. **Plan A — 裸 XML**（当前 streamToolBridge.ts 使用的格式）
   ```xml
   <function_result call_id="c1" name="echo" status="ok">
   {"message":"hello"}
   </function_result>
   ```

2. **Plan B — Short wrapper + XML**（仅在 Plan A 不稳定时测试）
   ```
   Tool result:
   
   <function_result call_id="c1" name="echo" status="ok">
   {"message":"hello"}
   </function_result>
   ```

3. **Plan C — Explicit NL instruction wrapper**（最后手段）
   ```
   MCP tool result. Treat the following block as the result of the previous tool call.
   
   <function_result call_id="c1" name="echo" status="ok">
   {"message":"hello"}
   </function_result>
   ```

**验收标准**：
- 确定一种格式使 Notion AI 能在回复中引用 result 内容
- 记录每种格式的 AI 回复质量（references result? treats as instruction? ignores?）
- 如果裸 XML 可用，选择裸 XML（简单优先）

### P0-2: functionResultFormatter 模块

**目标**：从 `streamToolBridge.ts` 的 inline format 逻辑抽出独立模块。

**当前状态**（line 279）：
```typescript
const formattedResult = `<function_result call_id="${callId}">\n${typeof result === 'string' ? result : JSON.stringify(result)}\n</function_result>`;
```

**目标接口**：
```typescript
// functionResultFormatter.ts
export interface FormatResultOptions {
  callId: string;
  name: string;
  status: 'ok' | 'error';
  result: unknown;
}

export function formatFunctionResult(opts: FormatResultOptions): string;
```

**设计决策**（基于 format probe 结果）：
- 选定格式后，formatter 输出该格式
- 支持 success 和 error 两种 status
- JSON serialization policy：对象 → `JSON.stringify`；string → 直接输出
- Truncation：超过阈值时截断并附加 `[truncated]` 标记

**验收标准**：
- formatter 模块独立文件
- streamToolBridge.ts 调用 formatter 而非 inline template
- 单元测试覆盖：success, error, string result, object result, truncation

### P0-3: Adapter Health Diagnostic

**目标**：增强 `getStreamToolBridgeInfo()` 返回的 adapter 状态信息。

**当前状态**：
```typescript
adapterAvailable: boolean  // 只有一个 boolean
```

**目标状态**：
```typescript
{
  adapterAvailable: boolean,
  adapterStatus: 'ok' | 'input_not_found' | 'input_not_editable' | 'submit_not_found' | 'unknown_error',
  inputEmpty: boolean | null,      // null if cannot inspect
  inputTextLength: number | null,  // null if cannot inspect
}
```

**不暴露 input 内容**，只暴露长度/是否为空。这样支持 draft protection 诊断而不泄露用户草稿。

**验收标准**：
- `getStreamToolBridgeInfo()` 返回上述字段
- 单元测试覆盖各 status 情况
- 不引入新的 capability 枚举（等第二个 adapter 再拆分）

### P0-4: circuitBreaker Interface 预留

**目标**：在 `StreamToolBridgeConfig` 中预留 Gate 5 需要的字段。

```typescript
export interface StreamToolBridgeConfig {
  enabled: boolean;
  autoInsert: boolean;
  autoSubmit: boolean;
  toolTimeoutMs: number;
  // Reserved for Gate 5. No runtime enforcement in Gate 3C-prep.
  circuitBreaker?: {
    maxToolCallsPerStream?: number;
  };
}
```

**Gate 3C-prep 只做**：
1. Interface 允许该字段存在
2. `configureStreamToolBridge` 能保存/返回该字段
3. 不实现任何运行时限制逻辑

**验收标准**：
- TypeScript 编译通过
- 现有测试不受影响
- 配置能传入 circuitBreaker 字段并通过 info API 读回

## 风险

| 风险 | 影响 | 缓解 |
|------|------|------|
| Notion AI 不理解任何 function_result 格式 | Gate 3C 整体受阻 | Format probe 先测，阻塞时提前发现 |
| Notion AI 把 XML 当作 instruction | 安全风险 | probe 时观察 AI 是否执行 XML 中的 "指令" |
| adapter DOM 选择器失效（Notion 更新） | 注入失败 | health diagnostic 提供明确错误信息 |
| formatter 抽取破坏现有 Gate 3A/3B E2E | 回归 | 抽取后跑全部 E2E 验证 |

## 实施顺序

```
1. P0-4 (interface 预留) — 最小改动，先做
2. P0-3 (adapter diagnostic) — 独立于 format，可并行
3. P0-1 (format probe) — 需要真实浏览器，探索性工作
4. P0-2 (formatter 模块) — 依赖 P0-1 结果确定格式
```

## 测试策略

- **P0-1**: CDP real-browser 脚本（`scripts/e2e-gate3c-format-probe.cjs`）
- **P0-2**: 单元测试（`functionResultFormatter.test.ts`）
- **P0-3**: 单元测试 + E2E diagnostic 验证
- **P0-4**: 现有测试 + 新增 config roundtrip 测试

## Dependencies

- Chrome with Notion AI tab (port 9222)
- Extension loaded and interceptor active
- 现有 Gate 3A/3B E2E 作为回归验证
