# Slice R OO Observations (Gemini)

## 1. Option B 是否最优？
**是，Option B 是最优解。**
- **Option A** 污染了全局 `window` 对象，这在 Chrome Extension / content script 环境中是危险的（可能与其他扩展冲突，或者引发不必要的副作用）。
- **Option C** 直接删除 flag 检查会导致失去 fail-closed 能力（即如果依赖项不满足时无法安全回退）。
- **Option D** 引入外部存储（localStorage/chrome.storage）过于复杂，仅仅为了一个开关没有必要。
- **Option B** 采用依赖注入的思想，仅在 `startNotionRuntimeBridgeIfEnabled` 的局部调用上下文中模拟了启用的 `WindowLike` 对象，既安全地开启了功能，又没有副作用，非常优雅。只需注意 TypeScript 类型断言即可：`{ __BH_RUNTIME_BRIDGE_ENABLED__: true, mcpClient: (window as any).mcpClient } as unknown as WindowLike`。

## 2. formatFunctionResult 兼容性
**两者等价，不是阻塞点。**
通过对比 `mcp-runtime/src/core/function-result-formatter.ts` 和 `MCP-SuperAssistant/pages/content/src/render_prescript/src/stream/functionResultFormatter.ts`，两者的实现完全一致（均包含 `escapeXmlAttr`、`escapeCdata`、`serializeResult` 以及超过 100K 截断等逻辑），输出格式均为带有 CDATA 的 `<function_results>` XML。
由于格式完全相同，对 Notion AI 的输出影响一致，因此这不是 Slice R 的阻塞点。

## 3. TDD 范围
**只改这几行的话，现有的单元测试（149/149 GREEN）足够了。**
这是环境/入口级别的开关改动（feature flag toggle），核心业务逻辑（`ToolCallLoop`、`InMemoryToolRegistry`、`ConnectionStatePort` 等）在之前的 Slice 均已有完备的测试。
入口点的这个改动可以通过手动集成测试来验证。如果为了绝对严谨，可以在 adapter 的测试中加一个 case 验证 "当启用时正确调用了 startNotionRuntimeBridgeIfEnabled"，但并非强制要求。

## 4. 回滚策略
**只需 revert commit 即可快速禁用。**
因为 `startNotionRuntimeBridgeIfEnabled` 内部已经写好了完整的降级/保护逻辑（返回 null 时会继续走到 legacy 的 stream bridge 初始化代码）。如果生产出现重大问题，只需将 `__BH_RUNTIME_BRIDGE_ENABLED__` 改回 `false` 或 revert Option B 的 commit，即可无缝切回 `legacy stream bridge`。

## 5. 总体结论
**ACCEPT Slice R = Option B**。
建议按照 Option B 的方案实现并提交。
