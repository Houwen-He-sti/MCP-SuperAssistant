# Handoff — UI-4 Review + Merge

**日期**: 2026-05-21  
**来源**: 上一个 Copilot 会话（OO + PL 完成，4 reviewer APPROVED）  
**实际状态**: **UI-4 已实现并推送，PR #97 OPEN**

---

## ⚠️ 状态更新：实现已完成

**发现**：查看代码时发现 UI-4 的 3 个文件已经全部实现并提交。  
**分支**: `ui-4/settings-tab`（commit `48d0615`）  
**PR**: https://github.com/Houwen-He-sti/MCP-SuperAssistant/pull/97  
**Build**: `pnpm build` → 13/13 tasks successful ✅  
**Tests**: 33/33 pass（3 个空测试套件是 pre-existing，与 UI-4 无关）

**下一步：走 review 流程，然后 merge。**

---

## 一、当前状态（已完成）

### Review 链条
| Reviewer | 模型 | 阶段 | 结论 |
|----------|------|------|------|
| Gemini OO | Gemini 3.1 Pro | OO | ✅ |
| Opus OO | Opus 4.7 | OO | ✅ |
| Gemini Flash PL | Gemini 3.5 Flash | PL | ✅ APPROVED |
| GPT PL | GPT-5.5 | PL | ✅ ENTER_UI4_TDD |
| 实现 | — | TDD | ✅ 已实现（commit 48d0615）|

### 实现内容
1. `chrome-extension/src/background/index.ts` — broadcastConfigUpdateToContentScripts 加 [UI-4] runtime.sendMessage（1 行）
2. `pages/side-panel/src/stores/index.ts` — 新增 `useServerConfigStore`（runtime-only）+ `normalizeConnectionType`
3. `pages/side-panel/src/SidePanelApp.tsx` — 完整 Settings tab + Prompt tab，listener-before-snapshot 顺序，selector 模式

---

## 二、下一步（Review + Merge）

### Review 流程

**步骤 1：Gemini Code Review**

文案建议（简短，包含 PR 链接）：

```
PR: https://github.com/Houwen-He-sti/MCP-SuperAssistant/pull/97

UI-4 implements read-only Settings tab and Prompt tab for the side panel.
3 files changed:
1. background/index.ts: add runtime.sendMessage to broadcastConfigUpdateToContentScripts
2. stores/index.ts: add useServerConfigStore (runtime-only, like useConnectionStore)
3. SidePanelApp.tsx: Settings tab (server URL, connection type, mcpEnabled, debugMode) + Prompt tab (customInstructions read-only)

Please review for: correctness, architectural consistency with UI-3, and any regressions.
```

**步骤 2：GPT Code Review（同 PR 链接）**

**步骤 3：Merge PR #97**

```powershell
cd "C:\Users\houwen\Documents\VS Code Dir\MCP-SuperAssistant"
gh pr merge 97 --squash --auto --delete-branch
```

---

## 三、PR diff 摘要（审核用）

### background/index.ts 改动（1 行）
```typescript
// [UI-4] Also broadcast to extension pages (side panel, popup) via runtime.sendMessage
chrome.runtime.sendMessage(broadcastMessage).catch(() => {});
```

### stores/index.ts 新增内容
```typescript
type TransportType = 'sse' | 'websocket' | 'streamable-http';
const DEFAULT_SERVER_CONNECTION_TYPE: TransportType = 'streamable-http';
const isTransportType = (v: unknown): v is TransportType => ...
export const normalizeConnectionType = (v: unknown): TransportType => ...
export const useServerConfigStore = create<ServerConfigStoreState>()((set) => ({ ... }));
```

### SidePanelApp.tsx 改动（主要）
- import 添加 `useServerConfigStore`, `normalizeConnectionType`
- selector 模式（state => state.field）
- useEffect 重构：listener → snapshot 顺序
- Settings tab: server URL + connection type + mcpEnabled badge + debugMode badge
- Prompt tab: customInstructions readonly textarea（max-h-64 overflow cap）

---

## 四、关键技术事实（diff review 用）

1. `mcpEnabled` 是 UIStoreState top-level 字段，**不在** `preferences` 里
2. `connectionType` 默认值 `'streamable-http'`（matches background DEFAULT_CONNECTION_TYPE）
3. listener-before-snapshot 顺序（防止竞态）
4. `normalizeConnectionType` guard 防止非法值写入 store
5. 全部 read-only — 写回留 UI-5

---

## 五、文件位置参考

| 文件 | 路径 |
|------|------|
| PR #97 | https://github.com/Houwen-He-sti/MCP-SuperAssistant/pull/97 |
| Issue #95 | https://github.com/Houwen-He-sti/MCP-SuperAssistant/issues/95 |
| SidePanelApp.tsx | `pages/side-panel/src/SidePanelApp.tsx` |
| stores/index.ts | `pages/side-panel/src/stores/index.ts` |
| background/index.ts | `chrome-extension/src/background/index.ts` |
| chatgpt-send 命令 | `cd "C:\Users\houwen\Documents\VS Code Dir\ai-web-agent-mcp"; uv run chatgpt-send --auto-confirm --use-label gpt-tab-0 --file <file> --timeout 300` |

---

## 一、当前状态

### 已完成
- ✅ PR #94 merged（UI-3: side panel message bridge）
- ✅ main 在 `2e8c6a8`，tests 165/165 GREEN
- ✅ Issue #95 创建 + 4 个 reviewer 都 APPROVED
- ✅ PL 文档：`MCP-SuperAssistant/tmp/ui4-pl.md`（最终版，含所有 P1 修正）

### OO/PL Review 结论
| Reviewer | 模型 | 结论 |
|----------|------|------|
| Gemini OO | Gemini 3.1 Pro | ✅ |
| Opus OO | Opus 4.7 | ✅ |
| Gemini Flash PL | Gemini 3.5 Flash | ✅ APPROVED |
| GPT PL | GPT-5.5 | ✅ ENTER_UI4_TDD |

---

## 二、UI-4 改动范围（3 个文件）

### 文件 1：`chrome-extension/src/background/index.ts`

在 `broadcastConfigUpdateToContentScripts` 函数末尾（`chrome.tabs.query` loop 之后）加 1 行：

```typescript
// [UI-4] Also broadcast to extension pages (side panel, popup) via runtime.sendMessage
chrome.runtime.sendMessage(broadcastMessage).catch(() => {});
```

顺便更新该函数上方的 JSDoc 注释：
```typescript
// 旧: Broadcast server config update to all content scripts
// 新: Broadcast server config update to content scripts and extension pages
```

### 文件 2：`pages/side-panel/src/stores/index.ts`

在文件末尾（`useToolStore` 之后）添加：

```typescript
// --- Server Config Store (UI-4, runtime-only) ---
type TransportType = 'sse' | 'websocket' | 'streamable-http'; // mirrors chrome-extension TransportType

const DEFAULT_SERVER_CONNECTION_TYPE: TransportType = 'streamable-http'; // matches background DEFAULT_CONNECTION_TYPE

const isTransportType = (v: unknown): v is TransportType =>
  v === 'sse' || v === 'websocket' || v === 'streamable-http';

export const normalizeConnectionType = (v: unknown): TransportType =>
  isTransportType(v) ? v : DEFAULT_SERVER_CONNECTION_TYPE;

interface ServerConfigStoreState {
  uri: string;
  connectionType: TransportType;
  lastUpdatedAt: number | null;
  setServerConfig: (payload: { uri: string; connectionType: TransportType }) => void;
}

export const useServerConfigStore = create<ServerConfigStoreState>()((set) => ({
  uri: '',
  connectionType: DEFAULT_SERVER_CONNECTION_TYPE,
  lastUpdatedAt: null,
  setServerConfig: ({ uri, connectionType }) =>
    set({ uri, connectionType, lastUpdatedAt: Date.now() }),
}));
```

### 文件 3：`pages/side-panel/src/SidePanelApp.tsx`

**A) 修改 import**（在现有 imports 行上，替换为）：

```typescript
import { useAppStore, useConfigStore, useConnectionStore, normalizeConnectionType, useServerConfigStore, useToolStore, useUIStore } from '@src/stores';
```

**B) 扩展 useEffect（listener-before-snapshot 顺序）**：

找到现有 UI-3 useEffect（约 line 50）。重构顺序为：
1. 先定义 `handleMessage`
2. 先注册 `chrome.runtime.onMessage.addListener(handleMessage)` 
3. 再发 snapshot sendMessage 请求（connection status + tools + server config）

新增 server config 拉取（在 tools sendMessage 之后）：

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

在 `handleMessage` 中加：

```typescript
if (msg.type === 'mcp:server-config-updated' && msg.payload?.config) {
  useServerConfigStore.getState().setServerConfig({
    uri: msg.payload.config.uri ?? '',
    connectionType: normalizeConnectionType(msg.payload.config.connectionType),
  });
}
```

**C) Selectors（组件顶部）**：

```typescript
const { status } = useConnectionStore();
const { tools } = useToolStore();
const isHydrated = useHydration();
// [UI-4] Settings + Prompt selectors
const uri = useServerConfigStore(state => state.uri);
const connectionType = useServerConfigStore(state => state.connectionType);
const mcpEnabled = useUIStore(state => state.mcpEnabled); // ← top-level, NOT preferences.mcpEnabled
const debugMode = useAppStore(state => state.globalSettings.debugMode);
const customInstructions = useUIStore(state => state.preferences.customInstructions);
const customInstructionsEnabled = useUIStore(state => state.preferences.customInstructionsEnabled);
```

**D) Settings tab content**（替换 `<div className="text-sm text-slate-500">Settings Panel (WIP)</div>`）：

```tsx
<div className="space-y-4">
  <div>
    <p className="text-xs font-medium text-slate-500 uppercase tracking-wide mb-1">MCP Server</p>
    <p className="text-sm font-mono break-all">{uri || '(not set)'}</p>
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

**E) Prompt tab content**（替换 `<div className="text-sm text-slate-500">Prompt Panel (WIP)</div>`）：

```tsx
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

## 三、关键技术事实

1. **response format**: `mcp:get-server-config` 返回 `{ success: true, payload: { uri, connectionType }, ... }` — 用 `res?.success && res.payload`
2. **mcpEnabled** 是 `useUIStore` 的 **top-level** 字段（不在 `preferences` 里）
3. **connectionType 默认值**: `'streamable-http'`（background 的 DEFAULT_CONNECTION_TYPE）
4. **listener 注册顺序**: 先注册 `onMessage.addListener`，再发 snapshot sendMessage（防止竞态）
5. **NO write-back** in UI-4 — 全部 read-only，写回留 UI-5

---

## 四、TDD 流程

```powershell
# 1. 新建分支
cd "C:\Users\houwen\Documents\VS Code Dir\MCP-SuperAssistant"
git checkout main
git checkout -b ui-4/settings-tab

# 2. 实现（3 个文件）

# 3. 验证
cd "C:\Users\houwen\Documents\VS Code Dir\MCP-SuperAssistant"
pnpm build    # TypeScript + bundle 必须 pass
pnpm test     # 165 tests GREEN

# 4. 最终审核 diff 后 commit
```

---

## 五、PR 计划

- Branch: `ui-4/settings-tab`
- Base: `main`
- PR title: `[UI-4] Settings tab + Prompt tab + server config display`
- Closes: #95
- Review 顺序: Gemini → GPT → merge

---

## 六、文件位置参考

| 文件 | 绝对路径 |
|------|---------|
| PL 文档（完整） | `C:\Users\houwen\Documents\VS Code Dir\MCP-SuperAssistant\tmp\ui4-pl.md` |
| stores/index.ts | `C:\Users\houwen\Documents\VS Code Dir\MCP-SuperAssistant\pages\side-panel\src\stores\index.ts` |
| SidePanelApp.tsx | `C:\Users\houwen\Documents\VS Code Dir\MCP-SuperAssistant\pages\side-panel\src\SidePanelApp.tsx` |
| background/index.ts | `C:\Users\houwen\Documents\VS Code Dir\MCP-SuperAssistant\chrome-extension\src\background\index.ts` |
| Issue #95 | https://github.com/Houwen-He-sti/MCP-SuperAssistant/issues/95 |
| chatgpt-send 命令 | `cd "C:\Users\houwen\Documents\VS Code Dir\ai-web-agent-mcp"; uv run chatgpt-send --auto-confirm --use-label gpt-tab-0 --file <file> --timeout 300` |
