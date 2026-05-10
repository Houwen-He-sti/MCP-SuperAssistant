# Plan: Notion AI 原生对话入口 + 首次提示词注入

## 目的

将 SuperAssistant Bridge 的 Notion adapter 从当前的 `/ai` 页面（SuperAssistant 桥接按钮）切换到 **Notion AI 原生对话界面**（Notion AI 代理，face icon），并在首次对话时自动注入桥接协议提示词。

## 非目标

- 不修改其他 adapter（ChatGPT、Perplexity 等）
- 不改变 MCP proxy / background 消息路由逻辑
- 不改变 ToolResultRenderer 卡片渲染逻辑
- 不修改 SuperAssistant 桥接按钮本身（保留作为 fallback）

## 技术方案

### 1. 路由变更：从 `/ai` 到 Notion AI 原生页面

**当前：**
- `isSupported()` 只匹配 `/ai`、`/chat`、`/agent/` 路径
- 这是 Notion AI 的独立聊天面板，不是原生页面内嵌 AI

**变更后：**
- 扩展 `isSupported()` 匹配 Notion 页面 URL 模式（`/workspace/xxx`、`/doc/xxx` 等）
- 保留 `/ai` 作为 fallback 支持
- 新增 `isNativeAiPage()` 方法区分原生 AI 页面 vs 独立 `/ai` 面板

### 2. DOM 选择器更新

**当前选择器（`/ai` 面板）：**
```ts
CHAT_INPUT: 'div[role="textbox"][contenteditable="true"], div.content-editable-leaf-rtl[contenteditable="true"]'
SUBMIT_BUTTON: '[data-testid="agent-send-message-button"]'
CHAT_CONTENT: '.notion-app-inner'
BUTTON_INSERTION_CONTAINER: '[data-testid="unified-chat-plus-menu-button"]'
```

**目标选择器（Notion AI 原生界面）：**
需要 CDP 探索确认，预期模式：
- 输入框：Notion 页面内的 AI 输入区域（可能在页面底部或侧边栏）
- 发送按钮：Notion AI 原生的发送按钮
- 对话内容：Notion 页面内的 AI 回复区域

**策略：**
1. 先用 CDP 脚本探索 Notion AI 原生界面的 DOM 结构
2. 提取稳定选择器（优先 `data-testid`，其次 `role`/`aria-*`，最后 CSS class）
3. 在 adapter 中同时支持两套选择器（原生 + `/ai` fallback）

### 3. 首次对话检测 + 提示词注入

**需求：**
在第一次对话时，自动注入以下桥接协议提示词：

```
我本地运行了一个名为 SuperAssistant Bridge 的浏览器扩展。
这个桥接器主要用于本地代码 review：因为我（用户）没有 GitHub 管理员权限，无法装官方 GitHub MCP，所以用本地 MCP server 暴露只读 git 工具（git_status / git_diff / git_log / git_show / read_workspace_file 等），让你帮我读代码、找 bug、提改进建议。
它会从你回复的 DOM 中提取 `jsonl 代码块，发送到本地 MCP server 执行，执行结果会作为下一条用户消息回贴给你。请你作为这个桥接的协作端，按以下协议工作。
...（完整提示词见用户输入）
```

**实现方案：**

1. **首次对话检测：**
   - 在 adapter 中维护 `conversationMessageCount` 状态
   - 通过 MutationObserver 监听对话内容区域的变化
   - 当检测到新的 AI 回复时，递增计数器
   - 计数器为 0 时判定为首次对话

2. **提示词注入时机：**
   - 在 `insertText()` 方法中，如果是首次对话且输入框为空，先注入提示词
   - 或者在 `activate()` 时检测对话历史，如果为空则注入

3. **提示词存储：**
   - 将提示词文本存放在 adapter 的常量或配置中
   - 避免硬编码在方法体内

### 4. 代码变更范围

**文件：** `MCP-SuperAssistant/pages/content/src/plugins/adapters/notion.adapter.ts`

**变更点：**
1. 扩展 `isSupported()` 匹配更多 Notion URL 模式
2. 新增 `isNativeAiPage()` 方法
3. 扩展 `selectors` 对象，支持原生 AI 界面选择器
4. 修改 `insertText()` 支持首次对话提示词注入
5. 新增 `conversationMessageCount` 状态和检测逻辑
6. 新增 `BRIDGE_PROMPT` 常量存储提示词文本

**测试文件：** `MCP-SuperAssistant/pages/content/src/plugins/adapters/__tests__/notion.adapter.test.ts`（如存在）
- 更新选择器测试
- 新增首次对话检测测试
- 新增提示词注入测试

## 风险

1. **Notion AI 原生界面选择器不稳定：** Notion 使用 obfuscated CSS class names（Stylex），选择器可能随版本变化。对策：优先使用 `data-testid` 和 `role`/`aria-*` 属性。

2. **首次对话检测误判：** MutationObserver 可能触发多次。对策：使用 debounce 和状态机确保只注入一次。

3. **提示词注入干扰用户体验：** 如果用户已经在输入框中有草稿，不应覆盖。对策：只在输入框为空时注入。

4. **Notion 页面路由复杂：** Notion 是复杂 SPA，URL 模式可能不完整。对策：保留 `/ai` fallback，逐步扩展 URL 匹配。

## 验收标准

1. Adapter 能在 Notion AI 原生界面（face icon）上激活
2. 首次对话时自动注入桥接协议提示词
3. 后续对话不重复注入提示词
4. 输入框有草稿时不覆盖用户输入
5. 保留 `/ai` 面板的 fallback 支持
6. 单元测试覆盖新增逻辑
7. E2E 测试验证完整 round-trip

## 需要检查的文件/区域

1. `MCP-SuperAssistant/pages/content/src/plugins/adapters/notion.adapter.ts` — 主 adapter 文件
2. `MCP-SuperAssistant/pages/content/src/plugins/adapters/base.adapter.ts` — 基类接口
3. `MCP-SuperAssistant/pages/content/src/plugins/adapters/__tests__/` — 测试文件
4. CDP 探索脚本（临时）— 用于获取 Notion AI 原生界面 DOM 结构

## 假设或阻塞点

- **阻塞点：** 需要 CDP 探索 Notion AI 原生界面的 DOM 结构以获取稳定选择器。当前只有 `/ai` 面板的选择器。
- **假设：** Notion AI 原生界面有可识别的输入框和发送按钮元素。
- **假设：** 用户希望提示词作为第一条用户消息发送，而不是作为 system prompt（Notion AI 可能不支持 system prompt）。

## 最小可用的下一步

1. 编写 CDP 脚本探索 Notion AI 原生界面 DOM 结构
2. 提取稳定选择器
3. 更新 plan 文档中的选择器部分
4. 开始实现 adapter 修改
