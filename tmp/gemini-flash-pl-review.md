## Gemini 3.5 Flash PL Review — UI-4

**模型**: Gemini 3.5 Flash  
**阶段**: PL（Planning）review  
**日期**: 2026-05-21

---

### 总体评估

APPROVED — 架构一致，改动范围克制，与 UI-3 设计模式高度一致。Option C（精确版）的职责分离非常清晰。

---

### Q1: useServerConfigStore（runtime-only）

完全正确且最干净的方案。Background 必须在 React 加载前就读取 raw keys 建立 MCP 连接，因此 raw key 存储不可避免。Side panel 使用 runtime-only store，mount 时拉取快照，运行时订阅 `mcp:server-config-updated`，与 UI-3 的 connection/tools 数据同步完全一致。避免了 chrome.storage.onChanged 第二同步链路和 Zustand persist 格式冲突。

### Q2: broadcastConfigUpdate 加 runtime.sendMessage

改动合理。注意两个边界情况：
1. Side panel 未打开时 `chrome.runtime.sendMessage` 会抛 "No receiver" 错误 → `.catch(()=>{})` **关键且正确**，已在方案中
2. 潜在竞态：mount 时 sendMessage 回调 和 broadcast 事件可能乱序。（判断：UI-4 read-only 场景下此风险极低，暂不处理）

### Q3: read-only scope 划分

强烈赞同。写入 MCP 配置会触发 background 断连/重连/tools 广播的复杂副作用链；mcpEnabled 写回会触发 content script 的 hide sidebar 等副作用链。UI-4 专注单向数据打通，UI-5 处理写回。

### Q4: Prompt tab read-only 展示

无技术风险。read-only 展示同时验证了 `subscribeChromeStorageRehydrate` 在 side panel 的同步效果。美学建议：可以在 UI-5 为 textarea 加 Copy 图标等细节。

### Q5: 代码级优化建议（已采纳）

**优化 1 — Selector 模式（防止不必要 re-render）**：

```typescript
// 不推荐（整个 store 解构会订阅所有字段变化）
const { uri, connectionType } = useServerConfigStore();

// 推荐（只订阅需要的字段）
const uri = useServerConfigStore(state => state.uri);
const connectionType = useServerConfigStore(state => state.connectionType);
const mcpEnabled = useUIStore(state => state.preferences.mcpEnabled);
const debugMode = useAppStore(state => state.globalSettings.debugMode);
```

**优化 2 — connectionType 类型安全**：

```typescript
// 将 string 收敛为字面量联合类型，与 background/mcpclient 一致
connectionType: 'sse' | 'websocket' | 'streamable-http';
```

两个优化已合并到 PL 文档。
