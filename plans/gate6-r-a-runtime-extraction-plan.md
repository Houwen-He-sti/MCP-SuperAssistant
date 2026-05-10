# Gate 6-R-A: Runtime Extraction / Provider Generalization Plan

> **Author**: Opus/Claude
> **Created**: 2026-05-10
> **Status**: Draft — pending GPT review
> **Parent**: `plans/gate6-and-notion-mcp-plan.md` (consensus document, commit `9a300f1` on main)
> **PR**: [#37](https://github.com/Houwen-He-sti/MCP-SuperAssistant/pull/37)
> **GPT Review**: LGTM with comments (comment ID 4414241534)

---

## 1. 目标

Gate 6-R 的目标不是"重写 Notion adapter"，而是把已经被 Notion 跑通的 tool-loop 能力沉淀成 provider-neutral runtime，使 Notion 成为第一个 reference provider，而不是唯一实现。

Gate 6-R-A 是 plan phase：
- 完成 runtime boundary audit（代码实况盘点）
- 定义 interface split（StreamProviderAdapter / DomConversationAdapter / ToolLoopRuntimeCore）
- 列出 migration sequence（按 PR 粒度）
- 明确风险和验收标准

**本 PR 不修改任何生产代码。**

---

## 2. 现状评估

### 2.1 关键发现：大部分代码已经是 provider-neutral

经过完整代码盘点（54 个文件，~9,500 行），现状是：

- **~75% 的代码已经是 provider-neutral**：tool-loop 核心（streamToolBridge, functionCallScanner, executionGuard, ackTracker）、观察器层、渲染器层、核心基础设施
- **Provider-specific 代码集中在 3 个位置**：
  1. 16 个 adapter 插件（DOM selectors, routes, prompts）— 已有 `BaseAdapterPlugin` 抽象
  2. Notion MAIN world interceptor（`interceptorMain.ts`, 540 行）— stream 层无通用抽象
  3. Notion interceptor bridge（`interceptorBridge.ts`, 270 行）— MAIN ↔ ISOLATED 通信

### 2.2 真正需要泛化的是 stream interceptor 层

| 层 | 现状 | 泛化难度 |
|----|------|----------|
| **Stream Interceptor** | `interceptorMain.ts` 是 Notion-specific（硬编码 `runInferenceTranscript` endpoint detection）。`interceptor.ts` 是 generic 但只做 ISOLATED world 被动观察 | **中** — 需要定义 provider-aware endpoint matching |
| **Function Call Scanner** | `functionCallScanner.ts` 已 100% generic（支持 standard JSON + Notion JSONL-in-markdown-in-patch） | 无需改动 |
| **Tool Execution Bridge** | `streamToolBridge.ts` 已 100% generic | 无需改动 |
| **ACK Tracker** | `ackTracker.ts` 已 100% generic | 无需改动 |
| **Execution Guard** | `executionGuard.ts` 已 100% generic | 无需改动 |
| **Observer Layer** | `mutationObserver.ts` 等已 generic | 无需改动 |
| **Adapter Layer** | `BaseAdapterPlugin` 已定义 DOM adapter 接口，16 个 provider adapter 已实现 | 接口可能需扩展，不需重写 |

**结论**：Gate 6-R 的工作量比预期小。核心抽象目标是 stream interceptor 层（~810 行），不是整个 runtime。

---

## 3. Runtime Boundary Audit

### 3.1 模块分类表

> Source of truth: 基于 main branch (commit `9a300f1`) 的完整文件盘点。

| 模块 | 文件 | 行数 | 职责 | Provider-specific? | Gate 6-R 处理 |
|------|------|------|------|-------------------|--------------|
| **Stream Interceptor** |
| interceptor.ts | 380 | ISOLATED world 被动 stream observer + cutoff | ❌ Generic | 保留，可能作为 non-Notion provider 的 default |
| interceptorMain.ts | 540 | MAIN world fetch interceptor (Notion NDJSON) | ✅ **Notion-specific** | **抽取** endpoint matcher + stream format 为配置 |
| interceptorBridge.ts | 270 | MAIN → ISOLATED postMessage bridge | ✅ **Notion-specific** (bridge pattern) | **泛化** 为通用 world bridge protocol |
| **Function Call Detection** |
| functionCallScanner.ts | 360 | 跨 patch JSONL/JSON 解析 | ❌ Generic | 保留不动 |
| parser.ts | ~50 | 遗留/辅助 | ❌ Generic | 保留 |
| **Tool Execution Pipeline** |
| streamToolBridge.ts | 720 | Tool-loop hub: event → MCP → inject → ACK | ❌ Generic | 保留不动 |
| streamToolBridgeInit.ts | ~100 | 初始化配置 | ❌ Generic | 保留 |
| ackTracker.ts | 160 | 跨 turn nonce 追踪 | ❌ Generic | 保留 |
| functionResultFormatter.ts | ~100 | 结果格式化 + ACK 指令 | ❌ Generic | 保留 |
| **Execution Guard** |
| executionGuard.ts | 180 | Session-level 去重 | ❌ Generic | 保留 |
| storage.ts | ~120 | 持久化执行历史 | ❌ Generic | 保留 |
| **Observer Layer** |
| mutationObserver.ts | ~300 | MutationObserver for function blocks | ❌ Generic | 保留 |
| functionResultObserver.ts | ~250 | Result block detection | ❌ Generic | 保留 |
| streamObserver.ts | ~800 | XML streaming detection (Gemini 等) | ❌ Generic | 保留 |
| stalledStreamHandler.ts | ~150 | Stream watchdog | ❌ Generic | 保留 |
| **Renderer** |
| tool-result-renderer.ts | ~300 | Visual result card injection | ❌ Generic | 保留 |
| functionResult.ts | ~200 | Result card 格式化 | ❌ Generic | 保留 |
| functionBlock.ts | ~150 | Function call block UI | ❌ Generic | 保留 |
| **Adapter Layer** |
| base.adapter.ts | 160 | Abstract base class | ❌ Generic | 可能扩展接口 |
| notion.adapter.ts | ~250 | Notion DOM adapter | ✅ Notion | 保留为 reference adapter |
| notion.routes.ts | ~80 | Notion route detection | ✅ Notion | 保留 |
| chatgpt.adapter.ts | ~200 | ChatGPT DOM adapter | ✅ ChatGPT | 保留 |
| (13 other adapters) | ~150 each | Various providers | ✅ Various | 保留 |
| default.adapter.ts | ~120 | Fallback generic adapter | ❌ Generic | 保留 |
| **Core Infrastructure** |
| mcp-client.ts | ~700 | MCP client wrapper | ❌ Generic | 保留 |
| context-bridge.ts | ~300 | Extension messaging | ❌ Generic | 保留 |
| circuit-breaker.ts | ~200 | MCP 断路器 | ❌ Generic | 保留 |
| main-initializer.ts | ~350 | Boot orchestration | ❌ Generic | 可能需调整初始化逻辑 |
| **Entry Points** |
| render_prescript/src/index.ts | ~450 | 渲染脚本入口 | ⚠️ 含 Notion 特定逻辑 | **需清理** Notion 硬编码 |

### 3.2 需要泛化的代码量

| 分类 | 文件数 | 行数 | 工作量 |
|------|--------|------|--------|
| 需要抽取/泛化 | 3 | ~1,260 | 主要工作 |
| 需要小幅清理 | 2 | ~500 | 次要工作 |
| 不需要改动 | 49 | ~7,740 | 零 |
| **合计** | 54 | ~9,500 | |

---

## 4. Interface Split 提案

基于 `gate6-and-notion-mcp-plan.md` 的共识，定义三个核心接口。

### 4.1 StreamProviderAdapter — Stream 层 Provider 适配

```typescript
/**
 * Provider-specific stream detection and interception configuration.
 * Each web AI provider has different API endpoints, stream formats,
 * and fetch interception requirements.
 */
export interface StreamProviderAdapter {
  /** Unique identifier, e.g. 'notion', 'chatgpt', 'claude' */
  readonly providerId: string;

  /**
   * Determine if a fetch URL should be intercepted for tool-call scanning.
   * Example: Notion intercepts URLs containing 'runInferenceTranscript'.
   */
  shouldInterceptUrl(url: string): boolean;
  // NOTE: 后续 R-F+ 可能需要扩展为 shouldIntercept(request: {url, method, contentType})
  // 以支持 ChatGPT/Claude SSE 等需要检查 method/headers 的场景。
  // R-C 阶段只需 URL match（Notion 足够），不提前抽象。

  /**
   * Extract readable content from a stream chunk.
   * Different providers encode tool calls differently:
   * - Notion: NDJSON patches with markdown-embedded jsonl
   * - ChatGPT: SSE with JSON delta objects
   * - Claude: SSE with content_block_delta
   */
  extractContent(chunk: string): StreamChunkContent | null;

  /**
   * Determine if this chunk signals a function call that should trigger cutoff.
   * Delegates to functionCallScanner internally, but provider may need
   * pre-processing (e.g. Notion's patch text extraction).
   */
  detectFunctionCall(content: StreamChunkContent): FunctionCallIdentity | null;

  /**
   * Provider-specific stream format configuration.
   */
  readonly streamFormat: StreamFormat;
}

export type StreamFormat = 'ndjson' | 'sse' | 'websocket' | 'chunked-json';

export interface StreamChunkContent {
  text: string;
  /** Provider-specific metadata */
  meta?: Record<string, unknown>;
}
```

### 4.2 DomConversationAdapter — DOM 层 Provider 适配

已有 `BaseAdapterPlugin` 基本覆盖此接口。需要检查是否缺少：
- `injectResult(envelope: ToolResultEnvelope): Promise<boolean>` — 结果注入
- `findToolResultMountPoint(): HTMLElement | null` — UI mount point
- Provider-specific preflight

> 设计原则：尽量扩展现有 `BaseAdapterPlugin`，不创建平行体系。

### 4.3 ToolLoopRuntimeCore — Provider-neutral 编排

已有 `streamToolBridge.ts` 基本实现此角色。Gate 6-R 不需要创建新的 runtime core class，只需：
1. 确保 streamToolBridge 不直接依赖任何 provider-specific import
2. 初始化时通过依赖注入接收 provider adapter

### 4.4 Architecture Notes (from GPT review)

#### Scanner State Ownership

`functionCallScanner` 本身是无状态的（每次调用传入 text）。但 `interceptorMain.ts` 内部**累积 patch text** 并管理跨 patch 的解析状态。

- **R-C**：state 先由 provider adapter 持有（行为等价优先）
- **R-D+**：考虑迁移到 core 按 stream-id 持有（使 provider adapter 更薄）
- 不在 R-B/R-C 阶段做 state 迁移，避免同时改接口和改状态

#### MAIN World Bundle Architecture

`StreamProviderAdapter` 有方法（不可 JSON 序列化），因此不通过 `postMessage` 传递。架构决策：

- 每个 provider 编译自己的 MAIN world bundle（已有 webpack entry 模式）
- Provider adapter 在 MAIN world 内部实例化，不跨 world 传递
- ISOLATED world 通过 `postMessage` 只接收 serializable 的 `StreamChunkContent` / `FunctionCallIdentity`
- `interceptorBridge.ts` 泛化时保持 serializable 消息协议不变

---

## 5. 与 Gate 6-UI-A 的关系

```text
StreamProviderAdapter → interceptor → functionCallScanner
         ↓
   ToolLoopRuntimeCore (streamToolBridge)
         ↓                    ↓
   ToolLoopRuntimeEvent    MCP callTool
         ↓                    ↓
   UI Event Mapper ←── ToolResultEnvelope
         ↓
   SemanticToolCard (Gate 6-UI)
```

**边界规则**：
- Gate 6-R 输出 normalized `ToolLoopRuntimeEvent`
- Gate 6-UI 消费 normalized UI events
- R 不关心 card 样式
- UI 不直接读取 provider DOM 或 MCP result raw object

---

## 6. Migration Sequence

### Phase R-A (本 PR): Plan + Inventory

- 本文档
- 不修改代码

### Phase R-B: Stream Provider Type Definitions

- 定义 `StreamProviderAdapter` 接口和 `StreamFormat` 类型
- 定义 `StreamChunkContent` 和 `FunctionCallIdentity` 类型
- 不改行为，只加类型
- 预计 1 个文件新增 + 0 个文件修改

### Phase R-C: Extract Notion Stream Provider

- 从 `interceptorMain.ts` 提取 Notion endpoint matching → `notion.stream.ts`
- 从 `interceptorMain.ts` 提取 Notion content extraction → `notion.stream.ts`
- `interceptorMain.ts` 改为接受 `StreamProviderAdapter` 配置
- **行为等价**：所有现有 Notion 测试必须不变
- 预计 1 个文件新增 + 2 个文件修改

### Phase R-D: Generalize Interceptor Bridge

- `interceptorBridge.ts` 泛化为通用 MAIN → ISOLATED world bridge
- Provider ID 作为 postMessage 路由键
- 预计 0-1 个文件新增 + 1 个文件修改

### Phase R-E: Clean Entry Point

- 清理 `render_prescript/src/index.ts` 中的 Notion 硬编码
- 基于 provider detection 结果选择 StreamProviderAdapter
- 预计 1-2 个文件修改

### Phase R-F: ChatGPT SSE Stream Provider (Optional)

- 实现 ChatGPT SSE 的 `StreamProviderAdapter`
- 利用现有 `chatgpt.adapter.ts` 的 DOM adapter
- 验证 ChatGPT 页面的 tool-loop E2E
- 依赖 R-C/R-D 稳定后

### 预计总工作量

| Phase | 新增文件 | 修改文件 | 行数估算 |
|-------|---------|---------|---------|
| R-B | 1 | 0 | ~100 |
| R-C | 1 | 2 | ~200 |
| R-D | 0-1 | 1 | ~100 |
| R-E | 0 | 1-2 | ~50 |
| R-F | 1 | 1 | ~200 |
| **合计** | 3-4 | 5-6 | ~650 |

---

## 7. 风险

| 风险 | 为什么危险 | 缓解 |
|------|----------|------|
| 抽象过早 | 只有 Notion 验证过 stream interceptor，接口可能太宽或太窄 | Notion 作为 reference provider，接口只抽已验证的行为 |
| Selector 泄漏进 core | Runtime core 变成 "Notion core" | 所有 DOM selector 只留 adapter，CI 检查 core 无 provider import |
| Prompt injection 绑死 provider | ChatGPT/Claude 不一定用同样的 bridge prompt | Prompt policy 做 provider capability，不硬编码在 runtime |
| ACK 与 injection 耦合 | 不同 provider 的 next-turn 机制不同 | ACK tracker 用 generic nonce/event |
| E2E 难定位失败 | Provider/runtime/UI 同时改会混乱 | **每个 PR 只移动一层**，保持 regression matrix |
| `interceptorMain.ts` 改动影响 Notion 稳定性 | 540 行核心文件，改错就全断 | TDD + 行为等价约束 + 现有 E2E 必须持续 pass |

---

## 8. 验收标准

### 硬性要求

- [ ] 不改变现有 Notion native `/chat` 行为
- [ ] 不改变 Gate 5 tool execution / result injection / ACK 语义
- [ ] Provider-specific selectors 不进入 runtime core
- [ ] Runtime core 不直接 `import` 任何 Notion/ChatGPT-specific 模块
- [ ] 所有 extracted tests 直接 `import` production code，不复制表达式
- [ ] 现有测试全部保持通过：
  - notion.adapter: 37/37
  - functionCallScanner: 44/44
  - interceptorBridge: 33/33
  - tool-result-renderer: 59/59
  - streamToolBridge integration: 35/35
  - E2E (Notion + CDP): 8/8
  - **总计: 216/216**

### 每个 extraction PR 必须证明"行为等价"

不允许在 extraction PR 中顺手优化行为。行为变更必须独立 PR。

### TDD

所有实现 PR (R-B through R-F) 必须遵循 TDD：先写测试 → 确认 FAIL → 写实现 → 确认 PASS。

---

## 9. 非目标

- 不在本 plan 范围内创建新 provider adapter（ChatGPT SSE 是 optional stretch goal）
- 不重构 `BaseAdapterPlugin` 层级结构
- 不改变 MCP client / context-bridge / circuit-breaker
- 不做动画、主题、拖拽等 UI 工作（属于 Gate 6-UI）
- 不做 Notion MCP 知识库接入（独立轨道）

---

## 10. 依赖

| 依赖 | 状态 |
|------|------|
| PR #34 (Tool Result UI) | ✅ merged |
| PR #36 (Notion Native AI Entry) | ✅ merged |
| PR #26 (Gate 6-UI-A plan) | 独立轨道，不阻塞 |
| `gate6-and-notion-mcp-plan.md` (consensus) | ✅ on main |
