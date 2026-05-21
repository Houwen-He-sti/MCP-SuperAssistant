# Slice P — OO Synthesis + Plan

**Date**: 2025-01-XX
**Basis**: Gemini OO + OPUS ReOO + GPT OO
**Decision**: TDD — YES

---

## 3-Model OO Synthesis

| 点 | Gemini | OPUS | GPT | 最终 |
|----|--------|------|-----|------|
| refreshRegistry 局部函数 | ✅ 推荐提取 | ✅ 局部函数 | ✅ | ✅ |
| in-flight 处理 | last-writer-wins OK | refreshInFlight drop flag | **P1: queue semantics** | ✅ queue |
| Subscribe 条件 (source && registry both) | ✅ | ✅ | ✅ | ✅ |
| Closure dispose pattern | ✅ | ✅ | ✅ | ✅ |
| mcp-runtime 不动 | ✅ | ✅ | ✅ | ✅ |
| T-P-06 (dispose during in-flight) | ✅ | ✅ | ✅ | ✅ |
| T-P-07 (rapid toggling) | ✅ | optional | ✅ | ✅ (queue 场景下有意义) |

---

## GPT P1: Queue Semantics

GPT 要求升级 in-flight 处理从 "drop" 改为 "queue"：

**理由（我认同）**：
- drop 语义在 getTools() 失败时有问题：如果第一次 reconnect 触发 getTools() 失败，第二次 reconnect 事件被 drop → registry 永久 stale
- queue 语义处理了这个场景：in-flight 完成（无论成功/失败）后，若有 pending，立即重试

```typescript
let refreshInFlight = false;
let refreshPending = false;

const refreshRegistry = () => {
    if (disposed) return;
    if (refreshInFlight) {
        refreshPending = true;
        return;
    }
    refreshInFlight = true;
    source.getTools()
        .then(tools => { if (!disposed) registry.populate(tools); })
        .catch(err => { warn; })
        .finally(() => {
            refreshInFlight = false;
            if (refreshPending && !disposed) {
                refreshPending = false;
                refreshRegistry();
            }
        });
};
```

---

## Final Implementation (Slice P)

```typescript
// In start(), before this.disposable assignment:
let connectionChangeSubscription: Disposable | undefined;

if (this.deps.toolCatalogSource && this.deps.toolRegistry) {
    const registry = this.deps.toolRegistry;
    const source = this.deps.toolCatalogSource;

    let refreshInFlight = false;
    let refreshPending = false;

    const refreshRegistry = () => {
        if (disposed) return;
        if (refreshInFlight) {
            refreshPending = true;
            return;
        }
        refreshInFlight = true;
        source.getTools()
            .then(tools => { if (!disposed) registry.populate(tools); })
            .catch(err => {
                this.deps.logger?.warn?.('[NotionBridgeController] registry refresh failed', err);
            })
            .finally(() => {
                refreshInFlight = false;
                if (refreshPending && !disposed) {
                    refreshPending = false;
                    refreshRegistry();
                }
            });
    };

    // Slice M: initial populate (via shared refreshRegistry)
    refreshRegistry();

    // Slice P: reconnect refresh
    if (this.deps.connectionState?.onConnectionChange) {
        connectionChangeSubscription = this.deps.connectionState.onConnectionChange(
            (connected) => { if (connected) refreshRegistry(); }
        );
    }
}

// In dispose():
dispose: async () => {
    if (disposed) return;
    disposed = true;
    await connectionChangeSubscription?.dispose();
    await inner.dispose();
    this.disposable = null;
},
```

---

## TDD Test Plan

### PR-P1 (MCP-SA only — no mcp-runtime change)

**T-P-01**: `onConnectionChange` fires `true` → `refreshRegistry` called → `getTools()` → `registry.populate()`

**T-P-02**: `onConnectionChange` fires `false` → `refreshRegistry` NOT called

**T-P-03**: `dispose()` called before reconnect callback fires → `disposed` guard prevents populate

**T-P-04**: `connectionState` absent → no subscribe, no crash; initial populate still works

**T-P-05**: `getTools()` rejects on reconnect → warn logged, registry preserves previous state

**T-P-06**: `dispose()` called while getTools() in-flight → `!disposed` guard prevents populate

**T-P-07**: two rapid `true` events → second fires while first in-flight → `refreshPending=true` → queue fires second refresh after first completes

---

## Scope

| 文件 | 变更 |
|------|------|
| `notion-bridge-controller.ts` | +refreshRegistry, +connectionChangeSubscription, +dispose cleanup |
| `notion.runtime-bridge.test.ts` | +T-P-01..07 |
| mcp-runtime | 无变更 |

---

## Test Baseline

- 142/142 GREEN (before Slice P)
- Expected after: 142 + 7 = ~149/149 GREEN
