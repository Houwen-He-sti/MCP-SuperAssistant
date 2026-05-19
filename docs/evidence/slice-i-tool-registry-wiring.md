# Slice I Evidence — InMemoryToolRegistry First-Consumer Wiring

Date: 2026-05-22  
Author: GitHub Copilot  
Status: Captured at implementation time — live proxy evidence to be added when BH flag enabled

---

## 1. OO Findings (At Implementation)

### F1. `NotionMcpClientLike` — extended with optional `getAvailableTools?`

Before Slice I:
```ts
export interface NotionMcpClientLike {
    callTool(name: string, args: Record<string, unknown>): Promise<unknown>;
    isReady?: () => boolean;
}
```

After Slice I:
```ts
export interface NotionMcpClientLike {
    callTool(name: string, args: Record<string, unknown>): Promise<unknown>;
    isReady?: () => boolean;
    getAvailableTools?: () => Promise<Array<{ name: string; description?: string; inputSchema?: Record<string, unknown> }>>;
}
```

### F2. `createNotionProviderAdapter` was missing `observationMode: 'host-split'`

Pre-existing bug discovered: `NotionRuntimeBridgeController.start()` called `createNotionProviderAdapter({ host: bridgeHost })` without `observationMode`, causing `Invalid observation mode: "undefined"` error. This caused ALL existing T-BH-19..T-BH-lane-3 tests to fail.

Fixed in Slice I: `createNotionProviderAdapter({ host: bridgeHost, observationMode: 'host-split' })`

**Pre-Slice-I test baseline:** 9 failing tests (pre-existing observationMode bug)  
**Post-Slice-I test count:** 20/20 PASS (existing 11 + 9 new Slice I tests)

### F3. Import paths (relative, not package.json)

```ts
import { InMemoryToolRegistry } from '../../../../../../../mcp-runtime/src/core/in-memory-tool-registry.ts';
import type { SchemaValidatorPort } from '../../../../../../../mcp-runtime/src/core/schema-validator.ts';
import type { RuntimeResult } from '../../../../../../../mcp-runtime/src/bridge/runtime-result.ts';
```

---

## 2. Implementation Summary

### Files Modified

| File | Change |
|------|--------|
| `notion/notion-host-bindings.ts` | Added `getAvailableTools?()` to `NotionMcpClientLike` |
| `notion/notion-runtime-bridge.ts` | +`ObservationOnlySchemaValidator`, +`toolRegistry` in deps, registry wiring in `startNotionRuntimeBridgeIfEnabled`, fixed `observationMode` |
| `__tests__/notion.runtime-bridge.test.ts` | Added T-LOOP-I-01a..08 (9 new tests) |
| `plans/slice-i-tool-registry-wiring-plan.md` | Plan (plan-only PR prior, now closed; implementation in this commit) |

### Architecture

```
startNotionRuntimeBridgeIfEnabled(windowLike, deps)
  ├── flag OFF → return null
  ├── mcpClient missing → return null + error
  ├── mcpClient present, NO getAvailableTools:
  │     → warn logged
  │     → createNotionRuntimeBridge({ ...deps, mcpClient, toolRegistry: undefined })
  └── mcpClient present, HAS getAvailableTools:
        → new ObservationOnlySchemaValidator(logger)
        → new InMemoryToolRegistry({ schemaValidator })
        → deps.onRegistryCreated?.(registry)   ← test seam
        → createNotionRuntimeBridge({ ...deps, mcpClient, toolRegistry: registry })
        → async post-init: mcpClient.getAvailableTools()
            .then(tools => registry.populate(tools))
            .catch(err => logger.warn(...))
```

---

## 3. ObservationOnlySchemaValidator

```ts
class ObservationOnlySchemaValidator implements SchemaValidatorPort {
    validate(schema, args): RuntimeResult {
        logger?.warn('[Slice I ObservationOnlySchemaValidator] schema validation bypassed', {
            schemaKeys: Object.keys(schema),
            argsType: typeof args,
        });
        return { ok: true };
    }
}
```

**Hard constraints:**
- Evidence-only purpose, NOT production validator
- Must be replaced by CSP-safe validator before BH flag activation (Slice J blocker)
- Deliberately named for audit visibility

---

## 4. ToolDescriptor Shape (Live Evidence — TODO)

**Status: Pending — requires BH flag to be enabled and a real Notion AI session with MCP proxy running.**

Shape expected from MCP proxy tools/list:
```ts
type ToolDescriptor = {
    name: string;
    description?: string;
    inputSchema?: Record<string, unknown>;  // JSON Schema
}
```

Known Notion MCP tools (from committee-bridge-mcp schema):
- `committee-bridge.echo` — has `inputSchema` with `message` property
- Additional tools depend on MCP server configuration

**Action required:** When BH flag is manually enabled for testing, capture:
1. Full `getAvailableTools()` output shape
2. `inputSchema` presence ratio (how many tools have schemas)
3. Schema complexity (object/nested/array/$ref patterns)

This evidence is needed before Slice J (BH flag activation).

---

## 5. Async Race Condition (Accepted Risk)

During the window between `startNotionRuntimeBridgeIfEnabled()` returning and `getAvailableTools()` promise resolving, all tool calls return `tool_not_found` from the empty registry.

**Mitigation plan for Slice J:** Options include:
- Await populate before starting loop (sync-init pattern)
- Start loop only after populate resolves (delayed start)
- Accept early `tool_not_found` rejections and rely on retry logic

**Current state:** Accepted risk, documented in T-LOOP-I-08. BH path is OFF by default.

---

## 6. Test Results

```
mcp-runtime:          215/215 PASS
MCP-SA runtime-bridge: 20/20 PASS (11 pre-existing + 9 new Slice I)
```
