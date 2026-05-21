# Opus 4.7 Review — PR #94 (UI-3: side panel message bridge)

> OO 观察完成，所有证据已收集。独立 review。

**模型**: Claude Opus 4.7
**PR**: https://github.com/Houwen-He-sti/MCP-SuperAssistant/pull/94
**审查范围**: 4 文件，111 行增 / 6 行删

---

## Verdict: APPROVE with P1 follow-up

核心实现与 4CR 讨论的 Option E 方案一致。改动精准、范围合理。

---

## 一、逐文件审查

### 1. `chrome-extension/src/background/index.ts` — Broadcast 旁路 ✅（有 P1）

两个 broadcast 函数末尾各加 `chrome.runtime.sendMessage(broadcastMessage).catch(() => {})` — 实现正确，与 4CR Option E 方案一致。

**P1: Content script 会收到双重消息。**
`chrome.runtime.sendMessage` from background SW → 所有同 extension 接收者都收到，包括 content scripts。当前 content script handler（index.ts:542）只处理 `command: 'getStats'`、`command: 'toggleSidebar'` 等旧式 command 消息，不处理 `type: 'connection:status-changed'` 这种新式消息——所以 content script 收到后走 `else` 分支 fall through（`return false`），当前**不造成实际 bug**。

但这是**脆弱的**——未来有人在 content script handler 里添加对这些类型的处理时，会触发双重处理。建议在 background broadcast message 里加 `target: 'extension-page'` 字段，content script handler 顶部过滤。**P1 follow-up（UI-4 前修）。**

### 2. `pages/content/src/types/messages.ts` — origin 扩展 ✅

`origin: 'content' | 'background' | 'popup' | 'options' | 'side-panel'` — 类型安全正确。

### 3. `pages/side-panel/src/stores/index.ts` — Real runtime stores ✅

- ConnectionStore: runtime-only (NOT persisted) ✅
- ToolStore: runtime-only (NOT persisted) ✅
- `lastUpdatedAt` 用于调试和 stale detection ✅
- Tool 类型本地定义，注释说明 shape-compatible ✅

### 4. `pages/side-panel/src/SidePanelApp.tsx` — Mount fetch + subscribe ✅

`sendMessage` 回调格式已验证：background 的 `handleMcpMessage` 包装为 `{ success: true, payload: result }` — 与 `res?.success && res.payload` 匹配。

**P2: useEffect 中先发请求后注册 listener。** 建议先注册 listener 后发请求，但实际风险极低（几微秒窗口 + 最终一致性）。

**P2: 初始 fetch 拿不到 `connecting`/`reconnecting` 状态。** background handler 只返回 `connected`/`disconnected`。用户感知 < 1s，可接受。

---

## 二、回答 4 个问题

### Q1: sendMessage 行为边界
当前不会双重处理（content script handler 不处理 broadcast 类型）。但**脆弱**——建议 UI-4 前加 target 过滤。**P1。**

### Q2: useEffect 顺序
建议先注册 listener 后发请求，以消除极低概率的 broadcast 遗漏窗口。**P2，不改也行。**

### Q3: Tool 类型本地定义 vs @extension/shared
**推荐本地定义（Interface-first）。** 当 third consumer 出现（如 popup 也需展示 tool list）时再提取。当前 2 个 consumer 本地定义已够用。建议加 TODO 注释。**P2。**

### Q4: 4CR 遗漏盲点
1. `broadcastConfigUpdateToContentScripts` 未包装（UI-4 Settings Panel 需要）——建议标记 TODO
2. Background handler 不检查 origin——不是问题（已验证可行）

---

## 三、P1/P2 清单

| 级别 | 问题 | 建议 |
|---|---|---|
| **P1** | broadcast 消息无 target 过滤，content script 潜在双重处理 | 加 `target: 'extension-page'` 字段 + content script 顶部过滤（UI-4 前修）|
| P2 | useEffect listener 注册顺序 | 先注册 listener 后发请求 |
| P2 | 初始 fetch 拿不到 connecting/reconnecting 状态 | 可接受，用户感知 < 1s |
| P2 | broadcastConfigUpdate 未包装 | 标记 TODO for UI-4 |
| P2 | Tool type 本地定义未来可能不同步 | 标记 TODO + source-contract test |
| Info | 响应格式假设（success + payload）| 已验证正确 |

**Verdict: APPROVE with P1 follow-up** — 可以 merge，P1 在 UI-4 前修复。
