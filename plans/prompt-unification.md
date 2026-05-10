# Plan: Prompt Unification — 系统提示词从硬编码迁移到配置文件

**分支**: `feat/tool-result-card-rendering`（与 Gate 6 card rendering 共用分支）  
**作者**: Opus/Claude  
**日期**: 2026-06-02

---

## 目标

1. 将所有硬编码的系统提示词/指令模板从 TypeScript 源码移到**外部模板文件**
2. 用 `<mcp-system-prompt>` 标签包裹整个注入到对话中的系统指令，使 UI 可检测并**渲染为折叠卡片**（视觉紧凑，而非一大段文字）
3. 统一 JSONL codeblock 协议格式——Notion 和非 Notion 平台共用同一套格式约定
4. 建立统一的折叠卡片 UI 模式，三类内容共用同一 UI 组件：
   - 系统指令 → `<mcp-system-prompt>` → 📋 折叠卡片
   - 工具调用输入 → ` ```jsonl ``` ` → 🔧 折叠卡片
   - 工具调用结果 → `<function_results>` → 📦 折叠卡片

## 非目标

- 不改变 stream interceptor 的 NDJSON 拦截逻辑（它处理 Notion 原生 function_call，与 prompt 无关）
- 不改变 DOM scanner/parser 的 JSONL codeblock 检测逻辑（只改提示词模板，不改检测代码）
- 不实现卡片渲染的 UI（本 plan 只做模板提取 + 标签包裹；卡片渲染是 Gate 6 的一部分）
- 不添加 UI 来编辑提示词模板（当前通过模板文件编辑；UI 是未来迭代）
- 不重构 InstructionManager 组件的 React 逻辑

## 已知与未知

### 已知
- **三处硬编码提示词**：
  1. `notion.adapter.ts` L18-116: `BRIDGE_PROMPT` — 用户定制的 Notion AI 桥接协议（中文）
  2. `instructionGeneratorJson.ts` L30-95: 通用系统提示词 — MCP-SA 上游的 JSONL 协议指令（英文）
  3. `website_specific_instruction/chatgpt.ts` 和 `gemini.ts`: 平台补充指令

- **两条独立通道**：
  - Stream interceptor (NDJSON fetch 拦截) — 处理 Notion 原生 function_call
  - DOM scanner (codeblock 扫描) — 处理 AI 输出的 JSONL codeblock
  
- **用户的 BRIDGE_PROMPT** 经过多次测试优化，与 Opus 4.7 配合良好

### 未知
- `<mcp-system-prompt>` 标签的渲染时机和方式（未来迭代，当前只做标签包裹）
- 配置文件放在 Chrome storage 还是扩展包内（需确认）

## 技术方案

### 架构：Template + Config 模式

```
┌──────────────────────────────────────────────────────┐
│  prompt-templates/                                    │
│  ├── base.jsonl-protocol.md    ← JSONL 协议格式规范   │
│  ├── notion-bridge.md          ← Notion 桥接协议      │
│  ├── chatgpt-supplement.md     ← ChatGPT 补充指令     │
│  └── gemini-supplement.md      ← Gemini 补充指令      │
│                                                       │
│  用 <mcp-system-prompt> 标签包裹系统指令              │
└──────────────────────────────────────────────────────┘
         ↓ 编译时 import 为字符串
┌──────────────────────────────────────────────────────┐
│  promptTemplateLoader.ts                              │
│  - loadTemplate(platform, tools) → string             │
│  - 替换变量: {{TOOL_LIST}}, {{TOOL_SCHEMAS}}          │
│  - 按平台组装: base + platform_supplement             │
└──────────────────────────────────────────────────────┘
         ↓
┌──────────────────────────────────────────────────────┐
│  instructionGeneratorJson.ts                          │
│  - 调用 promptTemplateLoader                          │
│  - 仍负责动态生成工具列表部分                         │
│  - 不再包含硬编码提示词字符串                         │
└──────────────────────────────────────────────────────┘
```

### `<mcp-system-prompt>` 标签用途

标签包裹**整个**注入到对话的系统指令。目的是让 MCP-SA 的 DOM observer 检测到后，将其渲染为一个**折叠的卡片**：

```
对话 UI 效果：
┌──────────────────────────────┐
│ 📋 SuperAssistant 系统指令    │  ← 折叠的卡片
│ ▶ 点击展开查看详情            │
└──────────────────────────────┘
│ 帮我看一下 PR #42 的 diff     │  ← 用户的实际问题
```

同样的 UI 模式也用于工具调用和结果：
```
┌──────────────────────────────┐
│ 🔧 read_workspace_file       │  ← 工具调用卡片
│ ▶ path: src/index.ts          │
└──────────────────────────────┘
┌──────────────────────────────┐
│ 📦 read_workspace_file (结果) │  ← 结果卡片
│ ▶ 点击展开查看详情            │
└──────────────────────────────┘
```

**注意**: 卡片渲染的 UI 实现是 Gate 6 的范畴。本 plan 只负责：
- 把提示词从代码移到模板文件
- 用 `<mcp-system-prompt>` 包裹注入的系统指令
- 为 Gate 6 卡片渲染做好数据准备

### 配置存储

**方案：扩展包内静态模板 + Chrome storage 覆盖**

1. 默认模板放在扩展包内（`prompt-templates/` 目录），作为 raw string 在构建时 inline
2. 用户可通过 Chrome storage（或未来 UI）覆盖模板
3. InstructionManager 优先读 Chrome storage 覆盖，fallback 到默认模板

### Notion BRIDGE_PROMPT 处理

`notion.adapter.ts` 的 `BRIDGE_PROMPT` 是用户专门定制的。处理方式：
- 把它移到 `prompt-templates/notion-bridge.md`
- notion.adapter 从模板加载器获取
- 同样用 `<mcp-system-prompt>` 包裹

## 实施步骤

### Step 1: 创建模板文件

把三处硬编码提示词提取到 `prompt-templates/` 目录的 `.md` 文件中。

### Step 2: 创建 promptTemplateLoader

纯函数模块：
- `loadBaseProtocol(): string` — 加载 JSONL 协议基础模板
- `loadPlatformSupplement(platform: string): string` — 加载平台补充
- `loadNotionBridgePrompt(): string` — 加载 Notion 桥接协议
- `assembleInstructions(platform, tools, customInstructions?): string` — 组装完整指令

### Step 3: 重构 instructionGeneratorJson.ts

- 删除硬编码字符串
- 改为调用 `promptTemplateLoader`
- 保留工具列表动态生成逻辑

### Step 4: 重构 notion.adapter.ts

- 删除 `BRIDGE_PROMPT` 常量
- 改为从模板加载器获取

### Step 5: 测试

- 单元测试：promptTemplateLoader 正确加载和组装
- 单元测试：`<mcp-system-prompt>` 标签包裹正确
- 集成验证：生成的指令内容与重构前功能等价

## 验收标准

1. 源码中不再有超过 3 行的硬编码提示词字符串
2. 所有提示词模板在 `prompt-templates/` 目录中可读可编辑
3. `<mcp-system-prompt>` 标签包裹注入到对话的系统指令
4. `instructionGeneratorJson.ts` 生成的指令功能等价
5. `notion.adapter.ts` 的 BRIDGE_PROMPT 从模板加载
6. 现有 DOM scanner 和 stream interceptor 不受影响（不改检测逻辑）

## 风险

| 风险 | 影响 | 缓解 |
|------|------|------|
| `<mcp-system-prompt>` 标签被 AI 误解 | AI 可能尝试模仿或"回应"标签 | 使用 `mcp-` 前缀降低冲突；实测验证主流模型行为 |
| 模板加载时序问题 | 扩展启动时模板可能还没加载 | 用同步 import（构建时 inline） |
| Chrome storage 读写竞态 | 多 tab 同时修改覆盖模板 | 当前阶段不实现 storage 覆盖，只用静态模板 |
