## Opus 4.7 OO Review — UI-4 架构选择

**模型**: Claude Opus 4.7  
**阶段**: OO（Observation-Oriented）  
**日期**: 2026-05-21

---

### 一、关键事实观察

**事实 1：mcpServerUrl/mcpConnectionType 的存储模型**  
Background 把 server config 存在 chrome.storage.local 的原始 key 里，不在任何 Zustand persist blob 中。

**事实 2：background 已有完整的 get/set handler**  
- `mcp:get-server-config`（line 855）→ 返回 `{ uri, connectionType }`  
- `mcp:update-server-config`（line 870）→ 写入 + 重连 + broadcast

**事实 3：broadcastConfigUpdateToContentScripts 未包装（UI-3 遗留 P2）**  
只有 tabs.sendMessage，没有 runtime.sendMessage。

**事实 4：setMCPEnabled 的副作用链**  
Content script 的 setMCPEnabled 有 hide sidebar + event emit 副作用。Side panel 的 useUIStore 没有 setMCPEnabled action，直接 setState() 不会触发副作用链。

**事实 5：customInstructions 在 side panel store 中已有**  
UIStoreState.preferences 含 `customInstructions` 和 `customInstructionsEnabled`。

---

### 二、独立判断（回答 6 个问题）

| # | 问题 | Opus 回答 |
|---|------|-----------|
| Q1 | Option B 读取方式？ | 推荐 B1：mount 时 sendMessage('mcp:get-server-config') 拉取，onMessage 监听 mcp:server-config-updated 更新 |
| Q2 | B 够还是需要 C？ | 需要 Option C 子集：broadcastConfigUpdate 加 runtime.sendMessage（1 行）+ useEffect 监听 |
| Q3 | chrome.storage.onChanged 在组件中可行？ | 技术可行，但与 UI-3 架构不一致，不推荐 |
| Q4 | B2 persist store 能处理 raw keys？ | 不能：background 写 raw string，Zustand persist 期望 JSON blob，格式不兼容 |
| Q5 | Settings tab 写回范围？ | read-only + mcpEnabled toggle + server config write，其余留 UI-5 |
| Q6 | Prompt tab 显示什么？ | customInstructions textarea + customInstructionsEnabled toggle |

---

### 三、推荐方案：Option C（精确版）

| 文件 | 改动 |
|------|------|
| background/index.ts | broadcastConfigUpdateToContentScripts 末尾加 runtime.sendMessage（1 行） |
| stores/index.ts | 新增 useServerConfigStore（runtime-only，与 useConnectionStore 同模式） |
| SidePanelApp.tsx | useEffect 加 get-server-config 拉取 + server-config-updated 监听；Settings tab 内容 |

**Settings tab 功能**：
- MCP server URL（read + edit → sendMessage mcp:update-server-config）
- Connection type（read-only）
- mcpEnabled toggle（useUIStore.setState()）
- Connection status（已有，UI-3）

**Prompt tab 功能**：
- customInstructions textarea（read/write）
- customInstructionsEnabled toggle

---

### 四、Confess + Critique

**Confess**：
- 未验证 useUIStore.setState() 写入后 content script 的 subscribeChromeStorageRehydrate 是否真的同步（需实测）

**Critique**：
- Gemini 三选项边界不清晰：Option C 本质是 Option B + 1 行 broadcast 包装
- broadcastConfigUpdate 的 broadcast 包装是 UI-4 的硬前置——跳过会导致 Settings tab server URL 不实时更新
