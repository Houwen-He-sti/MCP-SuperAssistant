# Slice P — OO (Observation-Oriented) Observations

**Date**: 2025-01-XX
**Branch basis**: MCP-SA `main` at `f96a7d1` (post Slice O merge)
**Observer**: GitHub Copilot (Claude Sonnet 4.6)

---

## 1. Observed State: NotionRuntimeBridgeController.start()

```typescript
// Slice M: coordinate source → registry populate (fire-and-forget, Option Y+)
if (this.deps.toolCatalogSource && this.deps.toolRegistry) {
    const registry = this.deps.toolRegistry;
    this.deps.toolCatalogSource.getTools()
        .then(tools => {
            if (!disposed) {
                registry.populate(tools);
            }
        })
        .catch(err => {
            this.deps.logger?.warn?.('[NotionBridgeController] getTools failed — registry remains empty', err);
        });
}

this.disposable = {
    dispose: async () => {
        if (disposed) return;
        disposed = true;
        await inner.dispose();
        this.disposable = null;
    },
};
return this.disposable;
```

**观察**：
- `toolCatalogSource.getTools()` 只在 `start()` 时触发一次（fire-and-forget）
- `connectionState` 被注入到 deps 但**从未被 start() 使用来触发 refresh**
- `dispose()` 只清理了 `inner`（loop），没有清理任何 connection state 订阅
- `disposed` flag 存在并被 fire-and-forget guard 正确使用

---

## 2. Observed State: ConnectionStatePort.onConnectionChange (Slice O)

```typescript
// mcp-runtime/src/core/connection-state-port.ts
export interface ConnectionStatePort {
  isConnected(): boolean;
  onConnectionChange?(cb: (connected: boolean) => void): Disposable;
}
```

```typescript
// notion-connection-state.ts
onConnectionChange(cb: (connected: boolean) => void): Disposable {
    if (!this.subscribeStatus) {
        return noopDisposable;
    }
    return this.subscribeStatus((status) => cb(status === 'connected'));
}
```

```typescript
// notion.adapter.ts (production wiring)
connectionState: new NotionConnectionState(
    () => useConnectionStore.getState().status,
    (cb) => {
        const unsubscribe = eventBus.on('connection:status-changed', ({ status }) => cb(status));
        return { dispose: unsubscribe };
    },
),
```

**观察**：
- `onConnectionChange` seam 已经存在且运行正确
- Production: `eventBus.on('connection:status-changed', ...)` 会在连接状态变化时触发
- **但 Controller 没有任何地方调用 `connectionState.onConnectionChange()`**

---

## 3. The Gap

```
connection:status-changed → eventBus → NotionConnectionState.subscribeStatus callback
                                                    ↓
                                    onConnectionChange(cb) → cb(connected: boolean)
                                                    ↓
                                           [NOTHING — seam unused]
```

**缺失的行为**：当 `connected=true` 时（即从断开 → 重新连接），工具目录不会刷新。
如果连接断开后重连，`InMemoryToolRegistry` 保持上次的工具列表（可能是 stale 的）。

---

## 4. Design Questions for Committee

### Q1: 在哪里订阅？

**Option A**: Controller.start() 内
- 与 initial populate 并列，同样 fire-and-forget
- 订阅返回的 Disposable 存入局部变量，在 controller dispose 时 dispose

**Option B**: 在独立的 refreshRegistry() 方法中
- 明确分离初始化与刷新逻辑
- 代码更清晰但增加一个方法

**我的观察**：Option A 更简单，与现有 Slice M pattern 一致（fire-and-forget）。

---

### Q2: 是否需要 in-flight dedup？

场景：onConnectionChange fires → getTools() in-flight → onConnectionChange fires again。

**Option A（最简单）**：不 dedup，两个 getTools() 并发进行，后完成的覆盖 registry
- 风险：如果网络抖动导致快速多次重连，会触发多次 getTools()
- 影响：registry populate 被并发调用；`InMemoryToolRegistry.populate()` 是否幂等？

**Option B**：flag `isRefreshing`，in-flight 时跳过新的 refresh 请求
- 更安全，减少不必要的 MCP 调用
- 增加一个 flag 变量

**需要确认**：`InMemoryToolRegistry.populate()` 是原子性的吗？是否安全并发？

---

### Q3: Dispose 时取消订阅的位置？

当前 dispose():
```typescript
dispose: async () => {
    if (disposed) return;
    disposed = true;
    await inner.dispose();
    this.disposable = null;
},
```

需要添加：
```typescript
dispose: async () => {
    if (disposed) return;
    disposed = true;
    connectionChangeSubscription?.dispose();   // NEW
    await inner.dispose();
    this.disposable = null;
},
```

**观察**：这是 Slice P 的正确 dispose 责任归属位置（Controller 拥有订阅生命周期）。

---

### Q4: `connectionState?.onConnectionChange` 不存在时的行为？

如果 `connectionState` 注入了但没有实现 `onConnectionChange`（pull-only impl）：
- 不 subscribe（skip），保持 Slice M 的 one-time populate 行为
- 正确 — pull-only impl 不支持 refresh，这是有意的

---

### Q5: `toolCatalogSource` 或 `toolRegistry` absent 时？

如果 `onConnectionChange` 可用但 `toolCatalogSource` / `toolRegistry` absent：
- Subscribe 但 callback 内 guard 返回（noop）
- 或者：只在两者都 present 时才 subscribe

**我的偏好**：只在 `toolCatalogSource && toolRegistry` 都 present 时才 subscribe。
避免订阅一个永远 noop 的 callback。

---

## 5. Initial Implementation Shape（草稿，待 committee review）

```typescript
// In start(), after initial populate fire-and-forget:
let connectionChangeSubscription: Disposable | undefined;

if (
    this.deps.connectionState?.onConnectionChange &&
    this.deps.toolCatalogSource &&
    this.deps.toolRegistry
) {
    const registry = this.deps.toolRegistry;
    const source = this.deps.toolCatalogSource;
    connectionChangeSubscription = this.deps.connectionState.onConnectionChange(
        (connected) => {
            if (!connected || disposed) return;
            source.getTools()
                .then(tools => {
                    if (!disposed) { registry.populate(tools); }
                })
                .catch(err => {
                    this.deps.logger?.warn?.(
                        '[NotionBridgeController] reconnect refresh failed', err
                    );
                });
        }
    );
}

// In dispose():
dispose: async () => {
    if (disposed) return;
    disposed = true;
    connectionChangeSubscription?.dispose();  // ← NEW
    await inner.dispose();
    this.disposable = null;
},
```

---

## 6. Questions for Committee OO

1. Q1 的答案：Option A（inline）还是独立方法？
2. Q2 的答案：需要 in-flight dedup（isRefreshing flag）吗？
3. `InMemoryToolRegistry.populate()` 并发安全性如何？
4. 有没有我遗漏的 edge case？
5. Slice P 的 scope 边界：只做 Controller 订阅，还是应该同时做其他事？

---

## 7. 确认：InMemoryToolRegistry.populate() 并发行为

已读取 `InMemoryToolRegistry.populate()` 实现：

```typescript
populate(tools: ToolDescriptor[]): void {
    const next = new Map<string, ToolDescriptor>();
    for (const tool of tools) {
        next.set(tool.name, tool);
    }
    this.catalog = next;  // ← 原子性赋值
}
```

**结论**：
- 完全同步，O(n) 创建新 Map 后原子替换 `this.catalog`
- JavaScript 单线程：两个并发的 `getTools()` Promise 的 `.then()` 回调会顺序执行，不会真正并发
- 安全：最后完成的 `.then()` 覆盖 registry — "last writer wins"
- 风险极低：在网络抖动场景下，两次 getTools() 结果几乎相同（都是 fresh MCP tools/list）

**Q2 答案**：**不需要 in-flight dedup flag**。populate() 原子替换，JS 单线程，最坏情况是两次 getTools() 都成功并都 populate，结果幂等。
