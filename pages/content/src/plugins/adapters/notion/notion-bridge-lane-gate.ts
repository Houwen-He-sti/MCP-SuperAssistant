/**
 * Notion Runtime Bridge — Lane Gate helper.
 *
 * Checks window.__BH_RUNTIME_BRIDGE_ENABLED__ + mcpClient shape before starting the bridge.
 * Returns Disposable if bridge was started, null if disabled or fail-closed.
 *
 * The caller (NotionAdapter.activate) must:
 *   - Register DOM trigger listener when result === null
 *   - NOT register DOM trigger listener when result !== null
 *
 * Architecture principle: this module does NOT read window globals directly.
 * The window resolution + lane gate belong to NotionAdapter.activate() boundary.
 * The startNotionRuntimeBridgeIfEnabled helper captures that boundary logic here
 * to make it testable.
 *
 * Slice Q: Extracted from notion-runtime-bridge.ts (mechanical move, zero behavior change).
 * Imports createNotionRuntimeBridge from notion-bridge-controller.ts — no ESM cycle.
 */

import type { Disposable } from '../../../../../../../mcp-runtime/src/lifecycle/disposable.ts';
import { InMemoryToolRegistry } from '../../../../../../../mcp-runtime/src/core/in-memory-tool-registry.ts';
import { CfWorkerSchemaValidatorAdapter } from './cfworker-schema-validator-adapter.ts';
import { CfWorkerJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/cfworker';
import { type NotionMcpClientLike } from './notion-host-bindings.ts';
import { NotionMcpToolCatalogSource } from './notion-mcp-tool-catalog-source.ts';
import { createNotionRuntimeBridge, type NotionRuntimeBridgeDeps } from './notion-bridge-controller.ts';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Window-like object used by the lane gate helper (testable without real window). */
export interface WindowLike {
    __BH_RUNTIME_BRIDGE_ENABLED__?: boolean;
    mcpClient?: unknown;
}

/** Optional test seam: invoked with the created registry for evidence capture in tests. */
export type NotionRuntimeBridgeLaneGateDeps = Omit<NotionRuntimeBridgeDeps, 'mcpClient'> & {
    /** Slice I test seam — called with the created InMemoryToolRegistry (if any). */
    onRegistryCreated?: (registry: InMemoryToolRegistry) => void;
};

// ---------------------------------------------------------------------------
// Lane gate helper
//
// Tests the boolean flag + mcpClient presence.
// Returns Disposable if bridge was started, null if disabled or fail-closed.
// ---------------------------------------------------------------------------

export function startNotionRuntimeBridgeIfEnabled(
    windowLike: WindowLike,
    deps: NotionRuntimeBridgeLaneGateDeps,
): Disposable | null {
    // Check feature flag
    if (windowLike.__BH_RUNTIME_BRIDGE_ENABLED__ !== true) {
        return null;
    }

    // Validate mcpClient (fail-closed if absent or malformed)
    const rawMcpClient = windowLike.mcpClient;
    if (!rawMcpClient || typeof (rawMcpClient as Record<string, unknown>).callTool !== 'function') {
        deps.logger?.warn?.('[NotionRuntimeBridge] mcpClient not available — BH path disabled');
        return null;
    }

    const mcpClient = rawMcpClient as NotionMcpClientLike;

    // Slice I: Wire InMemoryToolRegistry if mcpClient supports getAvailableTools
    let toolRegistry: InMemoryToolRegistry | undefined;
    let toolCatalogSource: NotionMcpToolCatalogSource | undefined;
    if (typeof mcpClient.getAvailableTools === 'function') {
        const schemaValidator = new CfWorkerSchemaValidatorAdapter(new CfWorkerJsonSchemaValidator());
        toolRegistry = new InMemoryToolRegistry({ schemaValidator });
        deps.onRegistryCreated?.(toolRegistry);
        // Slice M: create ToolCatalogSource — Controller.start() will coordinate populate.
        // Async post-init populate — registry is empty until Controller.start() resolves.
        // Early tool calls will return tool_not_found (accepted race — T-LOOP-I-08).
        toolCatalogSource = new NotionMcpToolCatalogSource(mcpClient);
    } else {
        deps.logger?.warn?.('[NotionRuntimeBridge] getAvailableTools not available — skip registry wiring');
    }

    const bridge = createNotionRuntimeBridge({
        ...deps,
        mcpClient,
        toolRegistry,
        toolCatalogSource,
    });
    return bridge.start();
}
