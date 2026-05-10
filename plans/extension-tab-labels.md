# Plan: Extension Tab Label Recognition

## 目标

让 MCP-SuperAssistant 浏览器扩展识别 ai-web-agent-mcp 注入的 tab 标签，并通过消息通道暴露给 MCP 工具调用。

## 非目标

- 不在扩展侧创建/管理标签（标签管理由 ai-web-agent-mcp 负责）
- 不修改 sidebar UI（后续可做，不在本 PR 范围）
- 不修改 MCP 工具路由逻辑（后续可做）

## 观察证据

### Probe 结果 (2026-05-10)

CDP probe (`scripts/probe-tab-labels.cjs`) 输出保存在 `outputs/probe-tab-labels-2026-05-10T07-15-26.json`。

**关键发现：**

1. **5 个 tab 中 4 个有 `[label]` title 前缀**：
   - `[gpt-tab-6] VSCode-Dir项目讨论专用...` (chatgpt.com)
   - `[notion-tab-0] Notion AI | Notion` (notion.so)
   - `[perplexity-tab-0] New Tab` (newtab)
   - `[perplexity-tab-1] Perplexity` (perplexity.ai)

2. **CDP `Runtime.evaluate` 超时** — 无法通过 CDP 外部验证 `window.name`，但 content script 直接运行在页面内部，可以读取。

3. **扩展的 content script 已在所有标记网站上运行** — manifest matches 覆盖 chatgpt.com、notion.so、perplexity.ai。

## 背景

ai-web-agent-mcp 的 `TabLabelRegistry` 为浏览器 tab 注入两种标识：
1. **`window.name`** = `__AIWEB__<label>`（如 `__AIWEB__gpt-tab-0`）
2. **`document.title`** 前缀 `[<label>]`（如 `[gpt-tab-0] ChatGPT`）

MCP-SuperAssistant 当前没有任何 tab 识别能力。本 PR 让扩展的 content script 在初始化时检测这些标识，上报给 background，形成 `tabId → label` 映射。

## 技术方案

### 1. Tab Label Detector 模块（Content Script 侧）

新文件 `pages/content/src/core/tab-label-detector.ts`：

```typescript
const AIWEB_PREFIX = '__AIWEB__';

export interface DetectedLabel {
  label: string;
  source: 'window-name' | 'title-prefix';
}

export function detectTabLabel(): DetectedLabel | null {
  // Primary: window.name
  if (window.name?.startsWith(AIWEB_PREFIX)) {
    const label = window.name.slice(AIWEB_PREFIX.length);
    if (label) return { label, source: 'window-name' };
  }
  // Fallback: title prefix [label]
  const match = document.title.match(/^\[([^\]]+)\]/);
  if (match?.[1]) return { label: match[1], source: 'title-prefix' };
  return null;
}
```

在 `main-initializer.ts` 的 `initializeApplicationState()` 末尾调用检测并上报。

### 2. Message Types

在 `pages/content/src/types/messages.ts` 新增：
- `TabLabelReport` 接口
- `TabLabelQueryResponse` 接口  
- `McpMessageType` 新增 `'mcp:tab-label-report'` 和 `'mcp:tab-label-query'`

### 3. Background 标签注册表

在 `chrome-extension/src/background/index.ts`：
- `Map<number, { label: string; source: string }>` 注册表
- 处理 `'mcp:tab-label-report'` 消息
- 处理 `'mcp:tab-label-query'` 消息
- `chrome.tabs.onRemoved` 清理
- `chrome.tabs.onUpdated` 被动检测 title 变化

### 4. 持续检测

Content script 用 MutationObserver 监听 `<title>` 变化 + 定期检查 `window.name`（每 5s），重新上报变化。

## 风险

1. **`window.name` 被网站覆盖** — `__AIWEB__` 前缀缓解
2. **Content script 初始化时序** — ai-web-agent-mcp 可能尚未注入标签。延迟重试 + MutationObserver 解决
3. **title prefix 被 SPA 覆盖** — ai-web-agent-mcp 已有 MutationObserver 保持前缀

## 验收标准

1. Content script 能正确检测 `window.name` 中的 `__AIWEB__` 标签
2. Content script 能正确检测 `document.title` 中的 `[label]` 前缀
3. Background 维护准确的 `tabId → label` 映射
4. Tab 关闭时映射被清理
5. SPA 导航后标签变化能被重新检测
6. 新消息类型不影响现有 MCP 通信

Author: Opus/Claude
