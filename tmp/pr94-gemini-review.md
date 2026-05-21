## Gemini Review — UI-3 (feat: side panel message bridge)

> **Verdict: APPROVE** — 代码质量极高，完美落地了 Option E 架构。

---

### 1. `chrome.runtime.sendMessage` 使用是否正确？
**正确，且非常巧妙。**

`chrome.runtime.sendMessage` 从 background 发出时，所有同 extension 的接收者（包括 content scripts 和 side panel）都会收到。但这没有问题，原因在于：content script 的 `chrome.runtime.onMessage` 逻辑是基于 `message.type` 精确匹配的，对于 `connection:status-changed` 和 `mcp:tool-update` 这两个 type，content script 没有注册对应 handler，会安全地走到 fallback（`return false`），不会引起副作用。

### 2. `useEffect` cleanup 是否正确？
**完全正确。** 使用了具名函数 `handleMessage` 确保 `addListener` 和 `removeListener` 引用同一函数实例；`[]` 依赖数组配合 eslint-disable 合理（只需 mount 时注册一次）。

### 3. Tool 类型本地定义是否合理？
**非常合理，这是最佳实践。** Side panel 是独立 package，从 `pages/content/src/types` 跨包导入会破坏包边界。本地定义最小化接口（Duck Typing）完全满足显示需求，且降低了耦合度。

### 4. `broadcastConfigUpdateToContentScripts` 未修改是否合理？
**合理 (Deferred)。** Config 更新通常由 Side Panel 主动发起（UI-4 Settings Panel 任务），Side Panel 自身知道最新配置，不需要 background 广播回来。推迟到 UI-4 符合 PR 原子性原则。

### 5. 边界情况 / 安全隐患
**发现一个微小的边界情况（非阻塞）：**

初始拉取与实时广播之间存在极低概率的竞态条件：如果 background 在处理 `mcp:get-connection-status` 的瞬间连接状态恰好变化，广播可能先于初始响应到达，然后被稍后的旧初始响应覆盖。

缓解：由于连接状态变化是极低频事件，实际中几乎不可能发生。已有 `lastUpdatedAt` 字段为未来的时间戳比较做好准备，完全可以接受。

### 视觉建议（非阻塞）
工具描述可能很长，建议给 `description` span 加 `truncate` 或 `line-clamp-2` 类：

```tsx
// 建议改为：
<span className="ml-2 text-xs text-slate-500 dark:text-slate-400 truncate">
  {tool.description}
</span>
```

---

**总结**：Zustand runtime store 设计干净，`chrome.runtime.sendMessage` 使用恰到好处，`useEffect` cleanup 正确。**APPROVE。**
