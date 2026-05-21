# UI-5 OO 观察文档 — Settings + Prompt Write-Back

**阶段**: OO (Observation-Oriented)  
**日期**: 2026-05-21  
**背景**: UI-4 已实现只读 Settings + Prompt tab（PR #97 merged）。UI-5 目标：添加写入能力

---

## 一、目标范围

**Settings tab write-back**:
1. 编辑 MCP server URL（text input → `mcp:update-server-config` → background 重连）
2. 选择 connection type（select → `mcp:update-server-config`）
3. 切换 MCP Enabled（toggle → 写 `useUIStore`）
4. 切换 Debug Mode（toggle → 写 `useAppStore`）

**Prompt tab write-back**:
5. 编辑 Custom Instructions（textarea → 写 `useUIStore.preferences.customInstructions`）
6. 切换 Custom Instructions Enabled（toggle → 写 `useUIStore.preferences.customInstructionsEnabled`）

---

## 二、代码现状观察

### 2.1 Background write handler（已有）

`chrome-extension/src/background/index.ts` line 870：

```typescript
case 'mcp:update-server-config': {
  const { config } = payload;
  // validates uri
  // auto-detects connectionType from URI if not provided
  await chrome.storage.local.set({ mcpServerUrl: config.uri, mcpConnectionType: newType });
  updateServerConfig(config.uri, newType);
  broadcastConfigUpdateToContentScripts({ uri: config.uri, connectionType: newType });
  // starts async reconnection (non-blocking)
  forceReconnectToMcpServer(config.uri, newType);
  // after reconnect: broadcasts connection status + tools
}
```

**结论**：服务器配置写入路径已完备，只需从侧边栏发消息。

### 2.2 Content store write APIs（参考，不修改）

```typescript
// ui.store.ts (content side)
useUIStore.setMCPEnabled(enabled: boolean, reason?: string)
useUIStore.updatePreferences(prefs: Partial<UserPreferences>)

// app.store.ts (content side)
useAppStore.updateSettings(settings: Partial<GlobalSettings>)
```

### 2.3 Side panel stores（当前状态）

```typescript
// pages/side-panel/src/stores/index.ts

// useUIStore — 只有初始状态，无 action functions
export const useUIStore = create<UIStoreState>()(
  persist(
    () => uiInitialState,  // ← 无 setter
    { name: 'mcp-super-assistant-ui-store', ... }
  )
);

// useAppStore — 同上
export const useAppStore = create<AppStoreState>()(
  persist(
    () => appInitialState,  // ← 无 setter
    { name: 'mcp-super-assistant-app-store', ... }
  )
);

// useServerConfigStore — runtime-only（无 persistence）
export const useServerConfigStore = create<ServerConfigStoreState>()((set) => ({
  uri: '', connectionType: 'streamable-http', lastUpdatedAt: null,
  setServerConfig: ({ uri, connectionType }) => set({ ... }),
}));
```

**关键发现**：
- `useUIStore` 和 `useAppStore` 共享与 content scripts 相同的 `chrome.storage.local` key
- 从侧边栏写入这些 store → 自动触发 `chrome.storage.onChanged` → content script `subscribeChromeStorageRehydrate` 拾取变化
- 因此写入路径是：侧边栏 store.setState() → chrome.storage.local → content scripts 同步更新

### 2.4 chrome.storage 传播机制验证

```typescript
// chrome-extension/packages/storage/lib/createChromeStorageStateStorage.ts（推测）
// subscribeChromeStorageRehydrate — 监听 chrome.storage.onChanged，当 key 变化时触发 store rehydrate
```

侧边栏和内容脚本共用同一个 `chrome.storage.local` namespace，所以：
- 侧边栏写 → storage 变 → 内容脚本重新 hydrate（跨上下文实时同步）
- 这是现有设计的核心优势

---

## 三、架构设计选择

### 选择 A：在侧边栏 store 中添加 action functions

```typescript
// 修改 useUIStore creator：
export const useUIStore = create<UIStoreState>()(
  persist(
    (set) => ({
      ...uiInitialState,
      setMcpEnabled: (enabled: boolean) => set({ mcpEnabled: enabled }),
      updatePreferences: (prefs: Partial<UserPreferences>) =>
        set(state => ({ preferences: { ...state.preferences, ...prefs } })),
    }),
    { ... }
  )
);
```

- ✅ 简单，符合 Zustand 模式
- ✅ persist 中间件自动写 chrome.storage.local
- ❓ 需要更新 `UIStoreState` interface 增加 action fields（但 partialize 只序列化数据字段，actions 被排除）

### 选择 B：直接调用 `useUIStore.setState()`（外部写）

```typescript
// 在组件里直接：
useUIStore.setState({ mcpEnabled: newValue });
```

- ✅ 无需修改 store interface
- ✅ persist 中间件同样会写 chrome.storage.local
- ❓ 与 Zustand 文档推荐的 action 模式不一致

### 选择 C：直接写 `chrome.storage.local`（绕过 store）

```typescript
await chrome.storage.local.set({
  'mcp-super-assistant-ui-store': { state: { mcpEnabled: newValue, ... } }
});
```

- ❌ 需要知道完整的 zustand persist 格式（`{ state: {...}, version: N }`）
- ❌ 脆弱，依赖内部结构
- ❌ 不推荐

**推荐：选择 A**（添加 action functions）— 正确的 Zustand 模式，持久化由中间件处理

---

## 四、服务器配置写入的特殊性

与其他字段不同，server URL/connectionType 写入需要：
1. 发送 `mcp:update-server-config` 消息 → background 触发重连
2. **不能**直接写 `useServerConfigStore`（runtime-only，非持久化）
3. 写入后，background 会 broadcast `mcp:server-config-updated` → side panel store 自动更新

### 需要额外的 UI 状态管理（editing state）

问题：用户正在输入 URL 时，不能每个 keystroke 就触发重连。

解决方案：
- 使用 **local React state** 存 editing buffer（URI text input）
- 用户点击 "Save" 按钮 → 发送 `mcp:update-server-config`
- connection type select 变化 → 立即发送（无需防抖，因为是有限选项）

---

## 五、待探索问题

1. **`UIStoreState` partialize 兼容性**：添加 action 后，`partialize` 必须继续排除 actions（只序列化数据字段）。现有 `partialize` 已经这样做了（明确列出 `sidebar, preferences, theme, mcpEnabled`），所以安全。

2. **`AppStoreState` 是否有 `debugMode` 的 setter**？当前 AppStore 没有 actions。需要添加。

3. **写入后的 toast 反馈**：应该有成功/失败提示吗？暂定 UI-5 阶段不做 toast（保持简单）。

4. **server URL 验证**：应该本地验证 URL 格式，防止发送无效 URI 到 background。

5. **connection type 和 URI 的联动**：background 已有 auto-detect 逻辑（根据 URI 推断 connectionType），侧边栏是否允许手动覆盖？建议允许（用户可能知道自己的 server 类型）。

---

## 六、风险评估

| 风险 | 概率 | 影响 | 缓解 |
|------|------|------|------|
| chrome.storage 写入竞态（侧边栏和内容脚本同时写） | 低 | 中 | 设计上只有侧边栏写 preferences/flags；content script 通常只读取这些 |
| `mcp:update-server-config` 发送到 background 失败（无接收者） | 低 | 中 | chrome.runtime.lastError 检查，显示错误状态 |
| partialize 序列化意外包含 action functions | 低 | 低 | 现有 partialize 明确列举字段，新 actions 不在列表中 |
| 用户频繁切换 connection type 导致多次重连 | 低 | 低 | 每次发送 update-server-config 后，background 异步处理，可接受 |

---

## 七、OO 问题清单（给 reviewer）

1. 选择 A（在 store 中加 actions）vs 其他方案，是否有遗漏的考量？
2. Server URL 编辑是否需要 "Save" 按钮，还是用 debounce onBlur 触发更新？
3. 是否需要在 UI-5 做 toast/snackbar 反馈，还是留到更晚？
4. `UIStoreState` 接口修改（添加 setters）是否有破坏当前测试的风险？
5. 写入 `chrome.storage.local` 后，什么时候会同步到 content scripts？是实时的吗？

---

## 八、文件影响范围预估

| 文件 | 类型 | 改动 |
|------|------|------|
| `pages/side-panel/src/stores/index.ts` | 修改 | 添加 action setters 到 UIStoreState 和 AppStoreState |
| `pages/side-panel/src/SidePanelApp.tsx` | 修改 | Settings tab：input + select + toggles；Prompt tab：editable textarea + toggle |
| 新增测试文件（可能） | 新增 | action setter 的单元测试 |

---

**结论**：UI-5 架构清晰，依赖路径已验证。关键选择是 Action A（store 内加 setters），写入机制通过 persist 中间件 + chrome.storage 同步自动处理，无需额外 bridge。服务器配置是唯一特殊路径（通过 background message）。
