# CDP 诊断脚本设计笔记

> 从 L5B-2 预观察工作中提炼的设计哲学、本质性发现和可复用模式。
>
> Author: Opus 4.7 | Date: 2026-05-13

---

## 1. 核心设计哲学

### 1.1 两阶段预观察模式

**问题**：浏览器扩展的端到端路径涉及多个独立系统（扩展、SPA、MCP proxy、外部 API），直接测试全路径会遇到大量失败点，难以定位。

**解决方案**：分离为两个独立阶段：

```
Phase 1 (Preflight): 全自动，验证基础设施就绪
  ├── 扩展发现与激活检测
  ├── DOM 注入信号检查
  ├── 输入/提交按钮存在性
  └── 页面上下文正确性

Phase 2 (Smoke Test): 需要配置开关
  ├── 发送测试 prompt
  ├── 监控拦截链
  ├── 验证外部副作用 (GitHub PR comment)
  └── Exactly-once 检查
```

**可复用性**：任何涉及多个独立系统的端到端测试都应采用此模式。

### 1.2 扩展感知的检测策略

**问题**：Content scripts 运行在隔离世界（isolated world），全局变量（如 `window.mcpClient`）无法从主世界访问。

**解决方案**：通过 DOM 注入信号间接检测扩展激活状态：

```javascript
// 不可靠：访问全局变量
const mcpClient = window.mcpClient;  // ❌ 隔离世界，不可访问

// 可靠：检测 DOM 注入信号
const mcpElements = document.querySelectorAll('[class*="mcp-"]').length;  // ✅
const mcpPopover = !!document.querySelector('.mcp-popover');  // ✅
```

**本质性发现**：Content scripts 的注入是 DOM 可见的，但其状态是不可见的。检测扩展激活只能依赖 DOM 信号，不能依赖全局状态。

### 1.3 运行时扩展发现

**问题**：硬编码扩展 ID（32 位哈希）会导致扩展更新后 ID 变化时测试失败。

**解决方案**：通过 manifest 运行时发现扩展 ID：

```javascript
// Strategy 1: Service Worker + Runtime.evaluate
const manifest = await chrome.runtime.getManifest();
if (manifest.name.includes('MCP SuperAssistant')) {
    return extensionId;
}

// Strategy 2: Extension page title
if (page.title.includes('MCP SuperAssistant')) {
    return extensionId;
}
```

**可复用性**：所有依赖特定扩展的脚本都应使用运行时发现，而非硬编码 ID。

---

## 2. 关键技术发现

### 2.1 SPA 导航不触发 Content Script 注入

**现象**：通过 `Page.navigate` 导航到新页面后，content scripts 不会被注入。

**原因**：Chrome 的 content script 注入只在以下情况触发：
- 页面首次加载
- 扩展安装/更新
- `chrome.scripting.executeScript` 调用

SPA 内部导航（如 Notion 的路由切换）不触发这些条件。

**解决方案**：导航后必须执行 `Page.reload`：

```javascript
// 导航到目标页面
ws.send(JSON.stringify({ id: 1, method: 'Page.navigate', params: { url: targetUrl } }));
await sleep(3000);

// 重新加载以触发 content script 注入
ws.send(JSON.stringify({ id: 1, method: 'Page.reload', params: { ignoreCache: false } }));
await sleep(8000);  // 等待 SPA 完全渲染
```

**可复用性**：所有需要 content script 激活的 CDP 脚本都必须在导航后执行 reload。

### 2.2 Notion /chat 页面 DOM 结构

**发现**（通过 `debug-notion-chat-dom.cjs` 探针）：

```javascript
// 输入框
const input = document.querySelector('div[role="textbox"][contenteditable="true"]');

// 提交按钮 - 关键发现：button[type="submit"] 没有 aria-label
const submitBtn = document.querySelector('button[type="submit"]');

// MCP 按钮
const mcpBtn = document.querySelector('[aria-label="MCP Settings - Active"]');

// 停止按钮（生成中）
const stopBtn = document.querySelector('[aria-label="停止"], [aria-label="Stop"]');
```

**重要**：
- `/agent/` 路由已废弃，当前有效路由是 `/chat` 和 `/ai`
- 提交按钮 `button[type="submit"]` 没有 `aria-label`，只能通过 `type` 属性选择
- Enter 键可以作为提交的 fallback

### 2.3 CDP WebSocket 通信模式

**封装**：[`cdpSend()`](MCP-SuperAssistant/scripts/l5b2-obs-mcp-write-back.cjs:49) 函数封装了 CDP 消息的请求-响应模式：

```javascript
let _counter = 0;
function cdpSend(ws, method, params = {}) {
    const id = ++_counter;
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`CDP timeout: ${method}`)), 15000);
        const handler = (raw) => {
            const msg = JSON.parse(raw);
            if (msg.id === id) {
                ws.removeListener('message', handler);
                clearTimeout(timer);
                if (msg.error) reject(new Error(`CDP error: ${JSON.stringify(msg.error)}`));
                else resolve(msg.result);
            }
        };
        ws.on('message', handler);
        ws.send(JSON.stringify({ id, method, params }));
    });
}
```

**可复用性**：所有 CDP 脚本都应使用此模式，避免手动管理消息 ID 和回调。

---

## 3. 错误处理模式

### 3.1 分层失败检测

```
Level 1: 连接失败 (Chrome 未运行、端口未开放)
  → 明确错误信息：确保 Chrome 以 --remote-debugging-port=9222 启动

Level 2: 扩展未找到
  → 明确错误信息：扩展未安装或名称不匹配

Level 3: 页面未就绪
  → 明确错误信息：需要导航到 Notion AI 页面

Level 4: DOM 元素缺失
  → 明确错误信息：SPA 未完全渲染，需要等待

Level 5: 功能拦截失败
  → 明确错误信息：扩展未激活或 MCP proxy 未运行
```

### 3.2 超时与重试策略

```javascript
// 连接超时
const timer = setTimeout(() => reject(new Error(`CDP timeout: ${method}`)), 15000);

// SPA 渲染等待
await sleep(8000);  // reload 后等待

// 响应生成等待
const TIMEOUT_MS = 60000;  // Phase 2 最长等待
while (Date.now() - startTime < TIMEOUT_MS) {
    await sleep(3000);  // 每 3 秒检查一次
    // ...
}
```

---

## 4. 可复用组件

### 4.1 [`lib/cdp-preflight.cjs`](MCP-SuperAssistant/scripts/lib/cdp-preflight.cjs)

**职责**：
- 扩展发现 ([`resolveExtensionId()`](MCP-SuperAssistant/scripts/lib/cdp-preflight.cjs:89))
- 页面上下文确保 + 工作空间验证 ([`ensureAgentPage()`](MCP-SuperAssistant/scripts/lib/cdp-preflight.cjs:155))
- 完整预检 ([`preflight()`](MCP-SuperAssistant/scripts/lib/cdp-preflight.cjs:234))
- 工作空间配置读取 ([`readWorkspaceConfig()`](MCP-SuperAssistant/scripts/lib/cdp-preflight.cjs:30) → [`REQUIRED_WORKSPACE`](MCP-SuperAssistant/scripts/lib/cdp-preflight.cjs:65))

**工作空间配置优先级**：
```
NOTION_WORKSPACE 环境变量 > config/workspace.toml [notion].required_workspace > 硬编码 fallback
```

`config/workspace.toml` 中的 `[notion]` section 定义了所需工作空间：
```toml
[notion]
required_workspace = "sjzj030的工作空间"
```

**工作空间检测方式**：通过 CDP `Runtime.evaluate` 查询 Notion 侧边栏 DOM，搜索包含 `的工作空间` 的文本节点。Tab title 是扩展注入的标签（如 `[notion-tab-0] Notion AI | Notion`），不是工作空间标识。

DOM 观察证据（[`observe-workspace-dom.cjs`](MCP-SuperAssistant/scripts/observe-workspace-dom.cjs) 发现）：
```html
<div style="color: var(--c-texPri); font-weight: 500; white-space: nowrap; ...">sjzj030的工作空间</div>
```

如果 DOM 查询失败，回退到 tab title 检测（不可靠）。如果检测到工作空间不匹配，[`ensureAgentPage()`](MCP-SuperAssistant/scripts/lib/cdp-preflight.cjs:171) 会抛出异常并提示用户手动切换。

**使用方式**：
```javascript
const { preflight, sleep, getTargets, REQUIRED_WORKSPACE } = require('./lib/cdp-preflight.cjs');

const { tab, extensionId, extensionName } = await preflight();
console.log(`Required workspace: ${REQUIRED_WORKSPACE}`);
```

**测试**：
```bash
node scripts/test-cdp-preflight-workspace.cjs  # 工作空间配置读取 + 优先级链测试
```

### 4.2 [`debug-notion-chat-dom.cjs`](MCP-SuperAssistant/scripts/debug-notion-chat-dom.cjs)

**用途**：一次性 DOM 探针，发现 Notion /chat 页面的按钮和输入框选择器。

**可复用性**：如果 Notion 更新 DOM 结构，可以重新运行此脚本发现新的选择器。

### 4.3 [`l5b2-obs-mcp-write-back.cjs`](MCP-SuperAssistant/scripts/l5b2-obs-mcp-write-back.cjs)

**职责**：两阶段预观察脚本，验证 Notion AI → MCP-SuperAssistant → committee-bridge → GitHub API 端到端路径。

**可复用性**：
- Phase 1 的 DOM 检测逻辑可以复用到其他 Notion 测试
- Phase 2 的 console 监控模式可以复用到其他 MCP 拦截测试
- PR comment 验证逻辑（`gh CLI` + ACK marker）可以复用到其他 write-back 测试

---

## 5. 常见陷阱与解决方案

### 5.1 导航后 DOM 检查过早

**现象**：导航后立即检查 DOM，返回空结果。

**原因**：SPA 需要时间渲染，Content script 注入需要 reload。

**解决方案**：导航 + reload 后等待 8 秒，再检查 DOM。

### 5.2 Submit 按钮选择器错误

**现象**：使用 `[aria-label="Send"]` 找不到按钮。

**原因**：Notion /chat 页面的 submit 按钮没有 aria-label。

**解决方案**：使用 `button[type="submit"]` 作为主要选择器，aria-label 作为 fallback。

### 5.3 隔离世界状态访问

**现象**：`window.mcpClient` 返回 `undefined`。

**原因**：Content scripts 运行在隔离世界，主世界无法访问。

**解决方案**：通过 DOM 注入信号（如 `[class*="mcp-"]`）间接检测扩展状态。

### 5.4 Agent 路由废弃

**现象**：导航到 `/agent/` 页面后找不到 AI 输入框。

**原因**：Notion 已废弃 `/agent/` 路由，当前有效路由是 `/chat` 和 `/ai`。

**解决方案**：更新所有 URL 和路由检查，使用 `/chat` 作为默认路由。

---

## 6. 未来改进方向

### 6.1 自动化 Phase 2 配置切换

当前 Phase 2 需要手动设置 `BRIDGE_ENABLE_WRITES=true`，未来可以：
- 使用环境变量临时覆盖
- 或通过 MCP proxy 的 API 端点动态切换

### 6.2 更精确的响应检测

当前通过 input 空 + stop 按钮消失判断 Notion AI 完成，未来可以：
- 监控特定的 "完成" 信号（如 `[data-status="complete"]`）
- 使用 MutationObserver 监听 DOM 变化

### 6.3 多 Provider 支持

当前脚本只针对 Notion AI，未来可以扩展到：
- ChatGPT (通过 `chatgpt.py`)
- Perplexity
- DeepSeek

---

## 7. 总结

本轮工作的核心贡献：

1. **发现 SPA 导航不触发 content script 注入** — 必须 reload
2. **发现 Notion /chat 页面 submit 按钮无 aria-label** — 使用 `button[type="submit"]`
3. **建立两阶段预观察模式** — 分离基础设施检查和功能验证
4. **封装 CDP 通信模式** — [`cdpSend()`](MCP-SuperAssistant/scripts/l5b2-obs-mcp-write-back.cjs:49) 可复用
5. **建立运行时扩展发现机制** — 避免硬编码扩展 ID

这些发现和模式可以复用到未来的浏览器扩展测试工作中。