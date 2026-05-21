## GPT-5.5 PL Review — UI-4

**模型**: GPT-5.5  
**阶段**: PL（Planning）review  
**日期**: 2026-05-21  
**Verdict**: REVISE → 修完两个 P1 后 ENTER_UI4_TDD

---

### P1 问题（必须修，已采纳）

**P1-1: mcpEnabled selector 路径错误**

```typescript
// 错误：mcpEnabled 不在 preferences 里
const mcpEnabled = useUIStore(state => state.preferences.mcpEnabled); // ❌

// 正确：mcpEnabled 是 UIStoreState 的 top-level field
const mcpEnabled = useUIStore(state => state.mcpEnabled); // ✅
```

**P1-2: connectionType 默认值错误**

```typescript
// 错误：background 的 DEFAULT_CONNECTION_TYPE 是 'streamable-http'，不是 'sse'
connectionType: 'sse' // ❌

// 正确：与 background/index.ts 保持一致
connectionType: 'streamable-http' // ✅
```

两个 P1 已修正到 PL 文档。

---

### Q1-5 回答摘要

| # | GPT 判断 |
|---|----------|
| Q1 | useServerConfigStore runtime-only 完全正确，不应绕过 background 直接读 raw storage |
| Q2 | broadcast 包装合理；`.catch(()=>{})` 关键；注释建议改为 "content scripts and extension pages" |
| Q3 | 强烈同意 read-only scope，write-back 有多层副作用链 |
| Q4 | Prompt tab read-only 安全（React 自动 escape）；需加 overflow cap |
| Q5 | P2 建议见下 |

---

### P2 建议（已采纳）

1. **listener-before-snapshot 顺序**：先注册 `onMessage.addListener`，再发 snapshot sendMessage，消除竞态窗口
2. **type guard**：`normalizeConnectionType()` 确保 runtime payload 不会写入非法值到 store
3. **overflow cap**：`max-h-64 overflow-y-auto` 防止超长 customInstructions 撑坏 side panel
4. **broadcastConfigUpdate 注释**：改为 "Broadcast server config update to content scripts and extension pages"

---

### P2 建议（暂不采纳，留 UI-5）

- **useSidePanelBridge() hook**：抽取大 useEffect，UI-4 暂不做
- **dark mode badge classes**：依赖整体 dark mode 策略，UI-4 暂不做
