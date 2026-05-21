# UI-4 PL (Planning) — Settings Tab + MCP Server Config Display

**阶段**: PL（Planning）  
**日期**: 2026-05-21  
**基于**: Gemini OO review + Opus OO review + Copilot 独立判断

---

## 一、OO 阶段共识

### 三方共同结论
| 结论 | Gemini | Opus | Copilot |
|------|--------|------|---------|
| 先做 read-only | ✅ | ✅ | ✅ |
| B2 Zustand persist 不能处理 raw keys | 未说明（推荐 persist 但有问题） | ✅ 明确反对 | ✅ 明确反对 |
| broadcastConfigUpdate 需加 runtime.sendMessage | ✅（Option C） | ✅（硬前置） | ✅ |
| Prompt tab = customInstructions | ✅ | ✅ | ✅ |

### 关键分歧：读取 mcpServerUrl 的方式
| 方案 | Gemini | Opus | Copilot |
|------|--------|------|---------|
| B1 直接 chrome.storage.onChanged | ✅ 推荐 | ❌ 与 UI-3 模式不一致 | 中立（两者都可）|
| C sendMessage('mcp:get-server-config') | ❌ 不必要 | ✅ 推荐 | ✅ 推荐（更一致）|

**Copilot 判断**：采用 Opus/Copilot 意见 —— 用 `sendMessage('mcp:get-server-config')` 而不是直接读 chrome.storage。理由：
1. background 已有完整的 `mcp:get-server-config` handler，语义更清晰（不绕过 background）
2. 与 UI-3 的 `mcp:get-connection-status` 完全对称
3. 未来写回也走同一条消息通道（`mcp:update-server-config`）

---

## 二、UI-4 范围确定

**Option C（精确版）**：

### 文件改动清单

| 文件 | 改动类型 | 详情 |
|------|---------|------|
| `chrome-extension/src/background/index.ts` | 1 行加法 | `broadcastConfigUpdateToContentScripts` 末尾加 `chrome.runtime.sendMessage(broadcastMessage).catch(() => {})` |
| `pages/side-panel/src/stores/index.ts` | 新增 store | `useServerConfigStore`（runtime-only，与 `useConnectionStore` 同模式） |
| `pages/side-panel/src/SidePanelApp.tsx` | 主要改动 | useEffect 加 config 拉取 + 监听；Settings tab + Prompt tab 内容 |

### Settings Tab 功能

| 字段 | 来源 | 模式 |
|------|------|------|
| MCP Server URL | `useServerConfigStore`（via sendMessage） | read-only 展示 |
| Connection Type | `useServerConfigStore` | read-only 展示 |
| Connection Status | `useConnectionStore`（已有 UI-3） | read-only |
| mcpEnabled | `useUIStore.preferences.mcpEnabled` | read-only（暂不做 toggle，留 UI-5） |
| debugMode | `useAppStore.globalSettings.debugMode` | read-only |

> **决定**：UI-4 Settings tab 全部 read-only（包括 mcpEnabled）。写回有副作用链风险（Opus 指出），全量写回留 UI-5。

### Prompt Tab 功能

| 字段 | 来源 | 模式 |
|------|------|------|
| Custom Instructions | `useUIStore.preferences.customInstructions` | read-only textarea（暂不编辑，留 UI-5） |
| Enabled toggle | `useUIStore.preferences.customInstructionsEnabled` | read-only（暂不 toggle） |

> **决定**：UI-4 Prompt tab 也 read-only 展示，UI-5 做编辑交互。原因：先让展示 pass review，再加写回逻辑。

---

## 三、实现计划

### Step 0：新建分支
```
git checkout main; git checkout -b ui-4/settings-tab
```

### Step 1：background/index.ts — 1 行改动

在 `broadcastConfigUpdateToContentScripts` 函数末尾，`tabs.sendMessage` 循环之后加：
```typescript
// [UI-4] Also broadcast to extension pages via runtime.sendMessage
chrome.runtime.sendMessage(broadcastMessage).catch(() => {});
```

### Step 2：stores/index.ts — 新增 useServerConfigStore

```typescript
// --- Server Config Store (UI-4, runtime-only) ---
type TransportType = 'sse' | 'websocket' | 'streamable-http'; // mirrors chrome-extension/src/mcpclient/types/plugin.ts

const DEFAULT_CONNECTION_TYPE: TransportType = 'streamable-http'; // matches background/index.ts DEFAULT_CONNECTION_TYPE

const isTransportType = (v: unknown): v is TransportType =>
  v === 'sse' || v === 'websocket' || v === 'streamable-http';

const normalizeConnectionType = (v: unknown): TransportType =>
  isTransportType(v) ? v : DEFAULT_CONNECTION_TYPE;

interface ServerConfigStoreState {
  uri: string;
  connectionType: TransportType;
  lastUpdatedAt: number | null;
  setServerConfig: (payload: { uri: string; connectionType: TransportType }) => void;
}

export const useServerConfigStore = create<ServerConfigStoreState>()((set) => ({
  uri: '',
  connectionType: DEFAULT_CONNECTION_TYPE,
  lastUpdatedAt: null,
  setServerConfig: ({ uri, connectionType }) =>
    set({ uri, connectionType, lastUpdatedAt: Date.now() }),
}));
```

### Step 3：SidePanelApp.tsx — useEffect 扩展

**重要**：先注册 listener，再发送快照请求（避免「请求期间广播已到达但 listener 尚未挂上」的微小窗口）。实现顺序：
1. 定义 `handleMessage`
2. `chrome.runtime.onMessage.addListener(handleMessage)` ← 先注册
3. 再发送 snapshot sendMessage 请求
```typescript
// [UI-4] Fetch initial server config snapshot
chrome.runtime.sendMessage(
  { type: 'mcp:get-server-config', origin: 'side-panel', timestamp: Date.now() },
  (res) => {
    if (chrome.runtime.lastError) return;
    if (res?.success && res.payload) {
      useServerConfigStore.getState().setServerConfig({
        uri: res.payload.uri ?? '',
        connectionType: normalizeConnectionType(res.payload.connectionType),
      });
    }
  },
);
```

在 handleMessage 中加：
```typescript
if (msg.type === 'mcp:server-config-updated' && msg.payload?.config) {
  useServerConfigStore.getState().setServerConfig({
    uri: msg.payload.config.uri ?? '',
    connectionType: normalizeConnectionType(msg.payload.config.connectionType),
  });
}
```

### Step 4：SidePanelApp.tsx — Settings tab 内容

```tsx
// Use selectors to avoid unnecessary re-renders when unrelated store fields change
const uri = useServerConfigStore(state => state.uri);
const connectionType = useServerConfigStore(state => state.connectionType);
const mcpEnabled = useUIStore(state => state.mcpEnabled); // top-level field, NOT state.preferences.mcpEnabled
const debugMode = useAppStore(state => state.globalSettings.debugMode);

// Settings tab content:
<div className="space-y-4">
  <div>
    <label className="text-xs font-medium text-slate-500 uppercase tracking-wide">MCP Server</label>
    <p className="text-sm mt-1 font-mono break-all">{uri || '(not set)'}</p>
    <p className="text-xs text-slate-500 mt-0.5">{connectionType}</p>
  </div>
  <div className="flex items-center justify-between">
    <span className="text-sm">MCP Enabled</span>
    <span className={`text-xs px-2 py-0.5 rounded-full ${mcpEnabled ? 'bg-emerald-100 text-emerald-700' : 'bg-slate-100 text-slate-500'}`}>
      {mcpEnabled ? 'On' : 'Off'}
    </span>
  </div>
  <div className="flex items-center justify-between">
    <span className="text-sm">Debug Mode</span>
    <span className={`text-xs px-2 py-0.5 rounded-full ${debugMode ? 'bg-amber-100 text-amber-700' : 'bg-slate-100 text-slate-500'}`}>
      {debugMode ? 'On' : 'Off'}
    </span>
  </div>
</div>
```

### Step 5：SidePanelApp.tsx — Prompt tab 内容

```tsx
const customInstructions = useUIStore(state => state.preferences.customInstructions);
const customInstructionsEnabled = useUIStore(state => state.preferences.customInstructionsEnabled);

// Prompt tab content:
<div className="space-y-3">
  <div className="flex items-center justify-between">
    <span className="text-sm font-medium">Custom Instructions</span>
    <span className={`text-xs px-2 py-0.5 rounded-full ${customInstructionsEnabled ? 'bg-blue-100 text-blue-700' : 'bg-slate-100 text-slate-500'}`}>
      {customInstructionsEnabled ? 'Enabled' : 'Disabled'}
    </span>
  </div>
  <div className="text-sm text-slate-600 bg-slate-50 rounded p-3 min-h-16 max-h-64 overflow-y-auto whitespace-pre-wrap break-words">
    {customInstructions || <span className="text-slate-400 italic">No custom instructions set.</span>}
  </div>
</div>
```

---

## 四、TDD 检查计划

### 现有测试基准
- 165/165 GREEN（main `2e8c6a8`）

### UI-4 需要验证的测试项
1. `pnpm build` 通过（TypeScript + bundle）
2. `pnpm test` 165 tests GREEN（不应有回归）
3. 手动验证：
   - Settings tab 展示 server URL / connection type
   - Settings tab 展示 mcpEnabled / debugMode badge
   - Prompt tab 展示 custom instructions
   - 改变服务器 URL 后 Settings tab 实时更新
   - broadcastConfigUpdateToContentScripts 的 runtime.sendMessage 不影响 content script

---

## 五、待确认项（4CR 残余）

1. **Opus Confess**：`useUIStore.setState()` 写入后 content script 是否真的 rehydrate — UI-4 全 read-only 不涉及此问题，但 UI-5 实现写回前需确认
2. **background `mcp:get-server-config` 返回格式**：已确认 → `sendResponse({ success: true, payload: { uri, connectionType }, ... })`，与 UI-3 的 `mcp:get-connection-status` 完全对称，用 `res?.success && res.payload` 访问

---

## 六、分支 + PR 计划

- Branch: `ui-4/settings-tab`
- PR title: `[UI-4] Settings tab + server config display`
- PR body: 描述 3 文件改动 + 功能列表
- Review 顺序: Gemini → GPT → merge
