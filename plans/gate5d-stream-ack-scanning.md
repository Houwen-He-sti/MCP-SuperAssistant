# Gate 5d: Cross-Turn ACK Stream Scanning

## 目标

让 ackTracker 在模型下一轮回复时自动扫描 NDJSON stream 文本，检测 ACK nonce 回显。

当前状态: Gate 5c.1 已将 nonce + ACK 指令注入到 function_result 中，并注册 pending nonce。但 pending nonce 只能超时——没有任何代码扫描模型的下一轮输出来确认 ACK。

## 非目标

- 不修改 ackTracker 核心注册/超时逻辑（已完成）
- 不修改 streamToolBridge 的工具执行路径
- 不追求 100% ACK 确认率——模型可能忽略 nonce
- 不做 DOM 扫描（NDJSON stream 扫描更可靠、更早）

## 关联

- PR #24 (已合并): Gate 5c.1 bridge handoff ACK + ackTracker foundation
- Issue #24 (VSCode-Dir): Browser MCP tool-loop state machine
- PR #47 (VSCode-Dir): Testing strategy

---

## 架构分析

### 当前数据流

```
Notion AI 后端
  ↓ NDJSON stream (runInferenceTranscript)
interceptorMain.ts (MAIN world)
  ↓ postMessage — events: function_call, stream_cutoff, lifecycle
interceptorBridge.ts (ISOLATED world)
  ↓ validated events
streamToolBridgeInit.ts → createStreamToolHandler
  ↓ only processes stream_cutoff → tool execution
```

**Gap**: NDJSON 文本内容不通过管道传递。ackTracker.scanText() 在生产环境中没有数据源。

### Gate 5d 数据流（新增）

```
interceptorMain.ts (MAIN world)
  ↓ postMessage — NEW: stream_chunk_text (raw NDJSON line)
interceptorBridge.ts (ISOLATED world)
  ↓ validated stream_chunk_text events
streamToolBridgeInit.ts — NEW: text scan listener
  ↓ calls ackTracker.scanRawText(text)
ackTracker.ts — NEW: scanRawText() (substring match for pending nonces)
  ↓ if nonce found → confirmAck() → emit model_ack_confirmed
```

---

## 技术方案

### 1. NDJSON 中的 JSON 转义问题

模型输出在 NDJSON 中是 JSON 编码的。引号被转义:

```
Model output:  <mcp_ack nonce="ack_call123_1a" />
NDJSON line:   {"type":"text","value":"<mcp_ack nonce=\"ack_call123_1a\" />"}
```

现有 `scanText()` 使用正则 `/<mcp_ack\s+nonce="([^"]+)"\s*\/>/g`，在 JSON 文本中不匹配（`"` 变成 `\"`）。

**解决方案**: 新增 `scanRawText(text)` 方法，做 pending nonce 子字符串搜索。

nonce 格式 `ack_[A-Za-z0-9_-]+_[a-z0-9]+` 全是 JSON-safe 字符，不会被 JSON 转义。所以 nonce 子字符串在 NDJSON 原始文本中原样出现。

```typescript
// ackTracker.ts — 新增方法
function scanRawText(text: string): void {
    for (const [nonce] of pending) {
        if (text.includes(nonce)) {
            confirmAck(nonce);
        }
    }
}
```

### 2. 新增事件类型: StreamChunkTextEvent

```typescript
// types.ts
export interface StreamChunkTextEvent {
    type: 'stream_chunk_text';
    streamId: string;
    /** Raw NDJSON line text (un-parsed) */
    text: string;
    chunkIndex: number;
}
```

### 3. interceptorMain.ts 改动

在 NDJSON line 处理循环中，对每个非空行 emit `stream_chunk_text`:

```typescript
// 在现有的 for (const line of lines) 循环中，function_call 检测之后：
emit({
    type: 'stream_chunk_text',
    streamId,
    text: trimmed.slice(0, MAX_RAW_LINE_LENGTH),
    chunkIndex,
});
```

**性能考量**: 每个 NDJSON line 生成一个 postMessage。典型模型响应可能有几十到几百行。同源 postMessage 很快（微秒级），不会造成可感知的延迟。

### 4. interceptorBridge.ts 改动

添加 `stream_chunk_text` 到 `VALID_EVENT_TYPES`，并添加验证逻辑:

```typescript
case 'stream_chunk_text': {
    const text = raw.text;
    if (typeof text !== 'string' || text.length > MAX_RAW_LINE_LENGTH) {
        logger.warn('Rejected stream_chunk_text: invalid text');
        return null;
    }
    return {
        type: 'stream_chunk_text',
        streamId,
        text,
        chunkIndex: typeof raw.chunkIndex === 'number' ? raw.chunkIndex : 0,
    };
}
```

### 5. streamToolBridgeInit.ts 改动

注册第二个事件 listener 专门处理文本扫描:

```typescript
// In initStreamToolBridge():
let unsubscribeTextScan: (() => void) | null = null;

// Text scan listener — only active when there are pending nonces
const textScanHandler = (event: unknown) => {
    const e = event as { type?: string; text?: string };
    if (e?.type !== 'stream_chunk_text' || typeof e.text !== 'string') return;
    if (ackTrackerInstance && ackTrackerInstance.getPendingCount() > 0) {
        ackTrackerInstance.scanRawText(e.text);
    }
};

if (isNotionHost()) {
    unsubscribeTextScan = onStreamEventBridge(textScanHandler);
} else {
    unsubscribeTextScan = onStreamEventIsolated(textScanHandler);
}
```

---

## 文件改动清单

| 文件 | 层 | 改动 | 风险 |
|------|---|------|------|
| `ackTracker.ts` | 生产 | +scanRawText() 方法 | 低 — 纯逻辑 |
| `ackTracker.test.ts` | 测试 | +scanRawText 单元测试 | 无 |
| `types.ts` | 类型 | +StreamChunkTextEvent | 低 |
| `interceptorMain.ts` | 生产 (MAIN) | emit stream_chunk_text | 中 — 触及 Phase 1/2 核心 |
| `interceptorBridge.ts` | 生产 (ISOLATED) | 验证 stream_chunk_text | 低 |
| `streamToolBridgeInit.ts` | 生产 | 文本扫描 listener | 低 |
| `*.integration.test.ts` | 测试 | 端到端扫描测试 | 无 |

---

## 测试矩阵

Unit tests:
- `ackTracker.test.ts`: +scanRawText 测试
  - JSON-escaped text 中找到 nonce → confirmAck
  - 原始 text 中找到 nonce → confirmAck
  - 无 nonce → no-op
  - 多个 pending nonces，只匹配一个
  - 无 pending nonces → no-op (快速返回)

Integration tests:
- bridge + ackTracker + text scanning 协作
  - RESULT_SUBMITTED → nonce registered → stream_chunk_text with nonce → model_ack_confirmed
  - stream_chunk_text without nonce → no effect
  - Multiple streams, nonce in second stream → confirmed

E2E / smoke tests:
- 待 interceptor 改动部署后用真实 Notion AI 验证

Manual verification:
- `getStreamToolBridgeInfo()` 确认 ackPendingCount 变化

Known gaps / deferred tests:
- interceptorMain unit tests — 该文件是 IIFE，不容易直接 unit test。依赖 E2E 验证。
- 性能测试 — 大量 postMessage 的实际影响。初步判断可接受。

---

## 风险评估

| 风险 | 严重度 | 缓解 |
|------|--------|------|
| interceptor 修改导致 stream 中断 | 高 | emit 是 fire-and-forget，不影响 stream 数据流 |
| postMessage 性能 | 低 | 同源 postMessage 微秒级；可后续添加 config 开关 |
| 误匹配（nonce 子字符串偶然出现在文本中）| 极低 | nonce 含 callId + counter，20+ 字符随机组合 |
| bridge 拒绝新事件类型 | 低 | 添加到 VALID_EVENT_TYPES 白名单 |

---

## 实现顺序 (TDD)

1. 写 `scanRawText` 失败测试
2. 实现 `scanRawText` → 测试通过
3. 添加 `StreamChunkTextEvent` 类型
4. 修改 `interceptorMain.ts` emit 文本事件
5. 修改 `interceptorBridge.ts` 验证文本事件
6. 修改 `streamToolBridgeInit.ts` 注册文本扫描 listener
7. 集成测试
8. 全量回归测试

---

Author: Opus/Claude
