# ⚠️ SUPERSEDED — Unified Label Architecture

> **This plan has been superseded.** See `plans/unified-label-architecture.md` in the workspace root (shared across repos).

## Key change from this (old) plan

The old plan stated:
> 不在扩展侧创建/管理标签（标签管理由 ai-web-agent-mcp 负责）

The new unified architecture is the **opposite**:
> **Extension is the sole label allocator.** Python (ai-web-agent-mcp) is a read-only consumer.

## Why this changed

After committee review, we reached consensus that:
1. The extension's content script runs inside the page — it can reliably read/write `window.name`
2. Having Python manage labels via CDP was fragile (timeout issues, race conditions with extension)
3. Single allocator (extension) + read-only consumer (Python) eliminates all synchronization issues

## Implementation status
- Extension: auto-allocates labels, manages `tabLabels` Map in background → **done**
- Python: deleted `TabLabelRegistry`, reads `window.name` only → **done** (branch `feat/unified-label-architecture` on VSCode-Dir)
