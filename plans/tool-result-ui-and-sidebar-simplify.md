# Plan: 工具执行结果可视化 + Sidebar 精简

**Author**: Opus/Claude  
**Date**: 2025-07-23  
**Status**: Draft — GPT reviewed, consensus reached  
**GPT Review**: Request Changes → 4 P1 + 5 P2 → P1-2 降级为 P2 after discussion → **共识达成**

---

## 目标

1. **v1（本 PR）**：在 AI 对话流中内联显示工具执行结果，类似 ChatGPT 原生的工具调用结果框
2. **v2（后续 PR）**：砍掉 Sidebar，改用 extension popup 显示连接状态，配置文件化

本 plan 详细设计 v1，v2 只做方向记录。

## 非目标

- 不改变现有的 stream interception / tool execution 流程
- 不修改 MCP 通信协议
- 不重构 adapter 插件架构
- v1 不涉及 sidebar 的修改

---

## 背景

### 当前状态

工具执行结果的显示路径：

```
Stream NDJSON → parser → interceptor → stream_cutoff
  → streamToolBridge (onEvent callback)
    → MCP server 执行工具
      → CustomEvent 'mcp:tool-execution-complete'
        → AutomationService.handleToolExecutionComplete()
          → adapter.insertText(result) → 插入 AI 输入框
          → adapter.submitForm() → 自动提交
            → 结果作为纯文本 "用户消息" 出现在对话中
```

问题：
- 用户看不到格式化的工具执行结果
- 工具调用与普通用户消息混在一起，无法区分
- 没有执行状态指示（pending/success/error）
- `tool.store.ts` 有 `ToolExecution` 数据模型但没有 UI 消费者

### 目标状态

v1 是 **direct-listener MVP**：ToolResultRenderer 直接监听 `mcp:tool-execution-complete`。它只显示 tool execution completed 结果预览。不显示 submitted / ACK / timeout 等 Gate 5d 状态。

后续 Gate 6B 再引入 ToolResultUiEvent mapper：`BridgeEvent / AckEvent / legacy event → ToolResultUiEvent → renderer`。

```
工具执行完成后：
1. ToolResultRenderer（独立服务）在对话区域注入可视化结果块
2. AutomationService（不修改）继续执行 insertText + submitForm
两个服务并行监听 mcp:tool-execution-complete，互不依赖
```

用户看到：
```
┌──────────────────────────────────────┐
│ ⚙️ MCP tool completed          ✅   │  ← 标题：工具名 + 状态
│ ▸ Tool: read_file                    │  ← 可折叠
├──────────────────────────────────────┤
│ File contents:                       │  ← 展开后的结果预览
│ def hello():                         │
│     print("world")                   │
│ ...                                  │
└──────────────────────────────────────┘
```

**文案硬约束**：v1 card 只表达 "工具执行完成，结果可预览"。不得使用 "Tool result submitted" / "Model used this result" / "Used xxx_tool" 等暗示结果已被模型消费的文案。

---

## 技术方案

### 架构概览

```
  ┌─────────────────────────────────────────────────────┐
  │            mcp:tool-execution-complete               │
  │              (CustomEvent on document)                │
  └──────────────┬──────────────────────┬────────────────┘
                 │                      │
                 ▼                      ▼
  ┌──────────────────────┐  ┌────────────────────────────┐
  │  ToolResultRenderer  │  │    AutomationService       │
  │  (NEW, 独立服务)      │  │    (现有，不修改)           │
  │  显示可视化结果块     │  │  insertText + submitForm   │
  └──────────┬───────────┘  └────────────────────────────┘
             │
             ▼
  adapter.findToolResultMountPoint()
             │
             ▼
  注入 DOM 元素到对话区域
```

**关键设计决策（GPT review 共识）**：
- ToolResultRenderer **不嵌入** AutomationService 主流程（P1-1）
- 使用 `findToolResultMountPoint()` 而非 `findLastMessageElement()`（P1-3）
- 每个注入块必须带幂等 key `data-mcp-call-id`（P1-3）
- mount point 为 null 时 fail-soft + logger.warn（P1-4）
- 只使用 `textContent`，不使用 `innerHTML`（P2-1）

### 新增组件

#### 1. `ToolResultRenderer` 服务

**位置**：`pages/content/src/services/tool-result-renderer.ts`

**职责**：
- 独立初始化，自己订阅 `mcp:tool-execution-complete` 事件
- 在对话区域注入可视化结果块 DOM 元素
- 管理结果块的生命周期（创建、折叠、清理）
- 与 AutomationService 完全解耦

**关键接口**：

```ts
interface ToolResultRenderData {
  callId: string;                // 幂等 key
  functionName: string;          // 工具名称
  status: 'success' | 'error';
  resultPreview: string;         // 截断后的预览文本
  rawResult?: string;            // 完整结果（折叠区域）
  error?: string;                // 错误信息
  timestamp: number;
}

interface ToolResultMountPoint {
  container: HTMLElement;        // 注入容器
  anchor?: HTMLElement;          // 锚点元素
  mode: 'append' | 'after';     // 插入模式
}

class ToolResultRenderer {
  private static instance: ToolResultRenderer | null = null;
  
  static getInstance(): ToolResultRenderer;
  
  // 初始化：注入 CSS，注册事件监听
  initialize(): void;
  
  // 清理：移除事件监听
  cleanup(): void;
  
  // 内部：校验 + 提取渲染数据
  private extractRenderData(detail: ToolExecutionCompleteDetail): ToolResultRenderData | null;
  
  // 内部：注入 DOM 元素
  private injectResultBlock(data: ToolResultRenderData): boolean;
  
  // 内部：注入 CSS（只注入一次，固定 id）
  private ensureStylesInjected(): void;
  
  // 内部：序列化结果
  private stringifyToolResult(result: unknown): string;
}
```

#### 2. 结果序列化策略

```ts
function stringifyToolResult(result: unknown): string {
  if (typeof result === 'string') return result;
  if (result === null || result === undefined) return '';
  try {
    return JSON.stringify(result, null, 2);
  } catch {
    // circular reference / BigInt fallback
    return String(result);
  }
}

const MAX_PREVIEW_LENGTH = 500;
const MAX_RAW_LENGTH = 10000;

function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength) + '\n... (truncated)';
}
```

#### 3. ToolResultUiEvent 类型（future contract）

**位置**：`pages/content/src/types/tool-result-ui-event.ts`

```ts
/**
 * Future normalized UI event contract.
 *
 * v1 ToolResultRenderer listens directly to `mcp:tool-execution-complete`.
 * This type is reserved for later Gate 5d / bridge ACK integration:
 * - bridge_handoff_ack
 * - model_ack_confirmed
 * - model_ack_timeout
 */
export type ToolResultUiEventType =
  | 'tool_execution_completed'
  | 'tool_result_submitted'
  | 'model_ack_confirmed'
  | 'model_ack_timeout';

export interface ToolResultUiEvent {
  type: ToolResultUiEventType;
  functionName?: string;
  callId?: string;
  preview?: string;
  nonce?: string;
  latencyMs?: number;
  details?: unknown;
}
```

v1 不实现 mapper 层。ToolResultRenderer 内部直接从 `ToolExecutionCompleteDetail` 提取数据。

#### 4. BaseAdapterPlugin 扩展

**新增方法**：

```ts
// base.adapter.ts
abstract class BaseAdapterPlugin {
  // ...existing methods...
  
  /**
   * 查找工具结果注入点
   * adapter 决定注入位置和方式
   */
  findToolResultMountPoint(event?: { callId?: string }): ToolResultMountPoint | null {
    // 默认实现：尝试通用选择器
    const container = document.querySelector('main') 
        || document.querySelector('[role="main"]');
    if (!container) return null;
    return { container: container as HTMLElement, mode: 'append' };
  }
}
```

**ChatGPT adapter 实现**：

```ts
// chatgpt.adapter.ts
findToolResultMountPoint(): ToolResultMountPoint | null {
  // 找到最后一个 assistant turn 外层后面
  const turns = document.querySelectorAll('[data-testid^="conversation-turn-"]');
  if (turns.length > 0) {
    const lastTurn = turns[turns.length - 1] as HTMLElement;
    return { container: lastTurn.parentElement!, anchor: lastTurn, mode: 'after' };
  }
  // fallback
  const main = document.querySelector('main .flex.flex-col');
  if (main) return { container: main as HTMLElement, mode: 'append' };
  return null;
}
```

**DeepSeek adapter 实现**：

```ts
// deepseek.adapter.ts
findToolResultMountPoint(): ToolResultMountPoint | null {
  const container = document.querySelector('.chat-message-list')
      || document.querySelector('[class*="chat-messages"]');
  if (!container) return null;
  
  const messages = container.children;
  if (messages.length > 0) {
    const lastMsg = messages[messages.length - 1] as HTMLElement;
    return { container: container as HTMLElement, anchor: lastMsg, mode: 'after' };
  }
  return { container: container as HTMLElement, mode: 'append' };
}
```

#### 5. 样式

v1 使用内联 CSS 注入（与 mcpPopover 相同模式）。**只注入一次**，style tag 使用固定 id `mcp-tool-result-renderer-styles`。

**所有 class 统一使用 `.mcp-tool-result-*` 前缀**（不使用泛化 `.mcp-card` 等可能撞名的 class）。

```css
.mcp-tool-result-card {
  margin: 8px 0;
  border: 1px solid var(--mcp-tr-border, #e5e7eb);
  border-radius: 8px;
  overflow: hidden;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
  font-size: 14px;
  background: var(--mcp-tr-bg, #f9fafb);
}

.mcp-tool-result-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  cursor: pointer;
  user-select: none;
}

.mcp-tool-result-header:hover {
  background: var(--mcp-tr-hover, #f3f4f6);
}

.mcp-tool-result-title { flex: 1; font-weight: 500; }
.mcp-tool-result-status { font-size: 16px; }
.mcp-tool-result-chevron { transition: transform 0.2s; }
.mcp-tool-result-chevron[data-expanded="true"] { transform: rotate(90deg); }

.mcp-tool-result-preview {
  display: none;
  padding: 12px;
  border-top: 1px solid var(--mcp-tr-border, #e5e7eb);
  max-height: 400px;
  overflow-y: auto;
}

.mcp-tool-result-preview[data-visible="true"] { display: block; }

.mcp-tool-result-preview pre {
  margin: 0;
  white-space: pre-wrap;
  word-break: break-word;
  font-family: 'Menlo', 'Monaco', 'Consolas', monospace;
  font-size: 13px;
  line-height: 1.5;
}

/* 暗色主题适配 */
@media (prefers-color-scheme: dark) {
  .mcp-tool-result-card {
    --mcp-tr-border: #374151;
    --mcp-tr-bg: #1f2937;
    --mcp-tr-hover: #374151;
  }
}
```

**v1 使用 scoped CSS；若宿主样式污染严重，升级到 Shadow DOM。**

#### 6. DOM 注入策略

```ts
private injectResultBlock(data: ToolResultRenderData): boolean {
  // 1. 幂等检查：已存在相同 callId 的 card 则跳过
  const existing = document.querySelector(
    `[data-mcp-tool-result-card="true"][data-mcp-call-id="${data.callId}"]`
  );
  if (existing) {
    logger.debug('[ToolResultRenderer] Card already exists for callId:', data.callId);
    return true;
  }

  // 2. 获取 adapter 和 mount point
  const adapter = this.getActiveAdapter();
  const mountPoint = adapter?.findToolResultMountPoint({ callId: data.callId });
  
  if (!mountPoint) {
    logger.warn('[ToolResultRenderer] mount point not found', {
      adapterName: adapter?.name,
      functionName: data.functionName,
      callId: data.callId,
    });
    return false;
  }

  // 3. 创建 DOM 元素
  const card = document.createElement('div');
  card.className = 'mcp-tool-result-card';
  card.setAttribute('data-mcp-tool-result-card', 'true');
  card.setAttribute('data-mcp-call-id', data.callId);
  card.setAttribute('data-mcp-event-type', 'tool_execution_completed');

  // Header（使用 textContent，不用 innerHTML）
  const header = document.createElement('div');
  header.className = 'mcp-tool-result-header';
  // ... build header with textContent ...

  // Preview body（使用 textContent）
  const preview = document.createElement('div');
  preview.className = 'mcp-tool-result-preview';
  const pre = document.createElement('pre');
  pre.textContent = data.resultPreview; // 安全：不解析 HTML
  preview.appendChild(pre);

  card.appendChild(header);
  card.appendChild(preview);

  // 4. 注入到 mount point
  if (mountPoint.mode === 'after' && mountPoint.anchor) {
    mountPoint.anchor.after(card);
  } else {
    mountPoint.container.appendChild(card);
  }

  return true;
}
```

---

## 实施步骤

### Step 1: 类型定义

1. 创建 `pages/content/src/types/tool-result-ui-event.ts`（future contract）
2. 在 `base.adapter.ts` 定义 `ToolResultMountPoint` 接口

### Step 2: 创建 ToolResultRenderer

1. 创建 `pages/content/src/services/tool-result-renderer.ts`
2. 实现独立初始化 + 事件订阅
3. 实现 `extractRenderData()` + `stringifyToolResult()`
4. 实现 DOM 注入 + 幂等检查
5. 包含内联 CSS 注入（固定 id，只注入一次）

### Step 3: 扩展 adapter 契约

1. 在 `base.adapter.ts` 新增 `findToolResultMountPoint()`
2. 在 `chatgpt.adapter.ts` 实现 ChatGPT 特定的 mount point
3. 在 `deepseek.adapter.ts` 实现 DeepSeek 特定的 mount point

### Step 4: 初始化整合

1. 在 `services/index.ts` 中初始化 ToolResultRenderer（与 AutomationService 并行）
2. 确保两个服务独立运行，互不影响

### Step 5: 测试

自动化测试：
1. `mcp:tool-execution-complete` → `ToolResultRenderData` 映射
2. `stringifyToolResult()`：string/object/circular/BigInt/null
3. preview truncation
4. textContent 安全：HTML/XML 不被渲染
5. mount point null → no throw + warn
6. same callId event replay → 不重复插入
7. collapsed details 默认关闭
8. adapter method missing → renderer disabled

手动验证：
1. ChatGPT 页面工具执行完成后出现 card
2. card 不影响输入框 insertText/submitForm
3. 切换 dark/light 不刺眼
4. React re-render 后不会无限重复插入

---

## 平台支持优先级

| 优先级 | 平台 | adapter 文件 | 备注 |
|--------|------|-------------|------|
| P0 | ChatGPT | `chatgpt.adapter.ts` | 必做 |
| P0 | DeepSeek | `deepseek.adapter.ts` | adapter 已存在，实现 mount point |
| P1 | Gemini | `gemini.adapter.ts` | v1 后续 |
| P1 | Perplexity | `perplexity.adapter.ts` | v1 后续 |
| P2 | 其他所有 | `base.adapter.ts` 默认实现兜底 | |

---

## 风险

| 风险 | 影响 | 缓解 |
|------|------|------|
| AI 平台 DOM 结构变化导致 mount point 失败 | 结果块不显示 | fail-soft + `logger.warn()` + diagnostic state 可查 |
| 注入的 DOM 被平台框架覆盖（React/Vue re-render） | 结果块消失 | 幂等 `data-mcp-call-id` key + 安全位置注入（turn 外层后面） |
| CSS 与平台样式冲突 | 显示异常 | `.mcp-tool-result-*` 前缀 + CSS 变量隔离；v2 可升级 Shadow DOM |
| 暗色主题检测不准确 | 颜色不协调 | CSS 变量 + `prefers-color-scheme` + 平台 body class 检测 |
| event replay / stream replay 导致重复 card | UI 混乱 | 注入前 `querySelector` 幂等检查 |
| ToolResultRenderer 异常影响 AutomationService | 自动化流程中断 | 两个服务完全独立，renderer 异常不传播 |

---

## GPT Review 记录

### 初始 Review: Request Changes

| 级别 | 内容 | 最终状态 |
|------|------|---------|
| P1-1 | ToolResultRenderer 不应嵌入 AutomationService 主流程 | ✅ 采纳：独立服务 |
| P1-2 | mcp:tool-execution-complete 不能作为唯一事件源 → 加 mapper | ⚠️ 降级为 P2：v1 直接监听，保留类型定义 |
| P1-3 | findLastMessageElement 抽象太粗 → findToolResultMountPoint + 幂等 key | ✅ 采纳 |
| P1-4 | 返回 null 静默失败不够 → fail-soft + warn | ✅ 采纳 |
| P2-1 | 样式约束（单次注入、前缀、无 innerHTML） | ✅ 采纳 |
| P2-2 | 定义 stringifyToolResult 序列化策略 | ✅ 采纳 |
| P2-3 | 不叫 "Used xxx_tool"，改文案 | ✅ 采纳 |
| P2-4 | DeepSeek adapter 确认 | ✅ 已确认存在 |
| P2-5 | 不混 v1/v2 | ✅ 已分离 |

### P1-2 讨论记录

**Opus 反驳**：v1 只有一个事件源，加 mapper 层是过度设计；BridgeEvent 在 MAIN world 中，content script 拿不到。

**GPT 回复**：接受折中。v1 直接监听可以，保留 ToolResultUiEvent 类型定义，后续 Gate 6B 引入 mapper。文案必须严格限定语义。

**共识**：v1 direct-listener MVP + future type contract。

---

## v2 规划（Sidebar 精简）

> 仅作方向记录，不在本 PR 实施

### 目标
- 砍掉 `pages/content/src/components/sidebar/` 整个组件树
- 创建 `pages/popup/`（Chrome extension popup page）仅显示 MCP 连接状态
- 将以下配置移入配置文件（`mcp-superassistant.config.json`）：
  - 工具启用/禁用列表
  - 自动化设置（autoInsert, autoSubmit, autoExecute）
  - 延迟参数
  - Instruction 生成规则
- 保留 mcpPopover 作为页面内的快捷开关

### 需要决策的问题
1. 配置文件格式：JSON vs TOML？
2. 配置文件存储位置：`chrome.storage.local` vs 本地文件？
3. 是否保留 InputArea 的手动输入功能？

---

## 验收标准

1. ✅ 在 ChatGPT 页面上，工具执行完成后，对话区域内出现可视化结果 card
2. ✅ Card 显示工具名称和执行状态（completed / error）
3. ✅ Card 可折叠/展开，默认折叠
4. ✅ 展开后以 `<pre>` + `textContent` 显示结果预览
5. ✅ 结果预览有长度截断（MAX_PREVIEW_LENGTH）
6. ✅ 现有的 autoInsert + autoSubmit 流程不受影响
7. ✅ ToolResultRenderer 异常不影响 AutomationService
8. ✅ 暗色主题下正常显示
9. ✅ 在 DeepSeek 页面上同样工作
10. ✅ 同一 callId 不重复注入 card
11. ✅ mount point 不存在时 fail-soft + warn 日志
