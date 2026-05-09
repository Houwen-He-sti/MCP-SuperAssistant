# Gate 5c.1 + 5d: Cross-Turn ACK for Browser MCP Tool-Loop

## 目标

证明 AI 模型在下一轮回复中**实际消费了**注入的 tool result。  
Gate 5c 已证明 bridge pipeline 能 submit result，但无法确认 model 是否真的基于该 result 继续推理。

## 非目标

- 不修改 stream pause/resume（PR #23 范畴）
- 不修改当前 function call 检测逻辑
- 不要求 same-turn consumption（Gate 5c 已证明不可能）
- 不追求 100% ACK 率——模型可能忽略 nonce，这属于预期的 partial failure

## 关联

- Issue #24 (VSCode-Dir): 状态机设计
- PR #22 (已合并): Gate 5c success-path + boundary discovery
- 状态机阶段覆盖: `SUBMITTING_RESULT` → `ASSISTANT_CONTINUING` → `FINAL`

---

## 架构设计

### Gate 5c.1: Bridge Handoff ACK Event

**新增事件类型**: `bridge_handoff_ack`

当 `injectResultIfSafe()` 返回 `RESULT_SUBMITTED` 后，bridge 额外 emit 一个结构化的 handoff 事件：

```typescript
interface BridgeHandoffAckEvent {
  type: 'bridge_handoff_ack';
  streamId: string;
  callId: string;
  functionName: string;
  nonce: string;         // 注入到 result 文本中的唯一标识
  timestamp: number;
  outcome: 'RESULT_SUBMITTED';
}
```

**Nonce 生成**: `ack_${callId}_${Date.now().toString(36)}`

**注入位置**: 在 `formatFunctionResult()` 的输出中追加 ACK instruction block：

```text
<result_nonce>ack_call123_abc</result_nonce>
<instruction>In your next response, include verbatim: <mcp_ack nonce="ack_call123_abc" /></instruction>
```

### Gate 5d: Cross-Turn Model ACK Verification

**观察目标**: 模型下一轮回复是否包含 `<mcp_ack nonce="..." />`

**实现方式**:
1. Bridge emit `bridge_handoff_ack` 时，将 nonce 注册到 pending ACK 队列
2. 下一轮 stream 输出中，scan for `<mcp_ack nonce="..." />`
3. 如果找到匹配 nonce → emit `model_ack_confirmed` 事件
4. 如果在超时（30s）内未找到 → emit `model_ack_timeout` 事件

**新增接口**:

```typescript
interface ModelAckEvent {
  type: 'model_ack_confirmed' | 'model_ack_timeout';
  nonce: string;
  callId: string;
  functionName: string;
  latencyMs: number;      // 从 submit 到 ack 的时间
}
```

---

## 技术方案

### 文件修改

| 文件 | 变更 |
|------|------|
| `streamToolBridge.ts` | 在 RESULT_SUBMITTED 后 emit handoff ACK + nonce |
| `functionResultFormatter.ts` | 新增 `appendAckInstruction(formatted, nonce)` helper |
| `streamToolBridgeInit.ts` (新建或修改) | ACK 监听器 — 注册 pending nonces + scan next-turn output |
| `ackTracker.ts` (新建) | Pending nonce registry + timeout management |

### 改动最小化策略

1. **不修改 `injectResultIfSafe` 签名** — nonce 在调用点生成，append 到 formatted result 后再传入
2. **不修改 `createStreamToolHandler` 签名** — handoff ACK 通过现有 `onEvent` channel emit，只是新增事件 type
3. **ACK tracker 独立模块** — 不耦合 bridge core 逻辑

### 关键约束

- Nonce 长度 < 50 字符（避免占 token）
- ACK instruction 用 XML tag 标记，便于正则匹配
- 不依赖模型一定输出 ACK — timeout 是正常路径
- ACK scan 只检查 bridge submit 后的 **下一个** stream（不跨多轮）

---

## 风险

| 风险 | 缓解 |
|------|------|
| 模型忽略 ACK instruction | 这是预期行为，timeout 路径处理 |
| Notion AI 过滤 XML tag | 使用 inline text fallback: `[ACK: nonce]` |
| 多个 tool call 在同一轮 | 每个 call 独立 nonce，独立 ACK |
| ACK scan regex 误匹配 | Nonce 包含 callId + timestamp，collision 概率极低 |

---

## 验收标准

### Gate 5c.1

1. ✅ `RESULT_SUBMITTED` 后 emit `bridge_handoff_ack` 事件
2. ✅ Nonce 被 append 到注入的 result text 中
3. ✅ 单元测试覆盖: nonce 生成 + 事件 emit
4. ✅ 不影响现有 `succeeded`/`failed` 事件流

### Gate 5d

5. ✅ ACK tracker 注册 pending nonce
6. ✅ 下一轮 stream 输出中检测到 nonce → emit `model_ack_confirmed`
7. ✅ 超时后 → emit `model_ack_timeout`
8. ✅ E2E: 用真实 Notion AI 验证 ACK 出现率

---

## 实现顺序 (TDD)

1. **单元测试**: `ackTracker.test.ts` — nonce 生成、注册、超时
2. **单元测试**: `streamToolBridge.test.ts` — handoff ACK 事件 emit
3. **实现**: `ackTracker.ts`
4. **实现**: `functionResultFormatter.ts` 追加 ACK instruction
5. **实现**: `streamToolBridge.ts` 在 RESULT_SUBMITTED 后 emit + 注册 nonce
6. **集成测试**: E2E script 验证真实 ACK

---

Author: Opus/Claude
