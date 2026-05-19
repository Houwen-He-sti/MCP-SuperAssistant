/**
 * NotionRuntimeBridge — Layer 4 coordinator for BH architecture.
 *
 * Wires all 4 layers together:
 *   Layer 4: ToolCallLoop (mcp-runtime)
 *   Layer 3: createNotionProviderAdapter (mcp-runtime)
 *   Layer HostBindings: createNotionHostBindings (new)
 *   Layer 2: NotionAdapterBridgeHost (BH-2/BH-3)
 *   Layer 1: NotionAdapter DOM (existing, passed as adapter)
 *
 * Lane gate:
 *   startNotionRuntimeBridgeIfEnabled(windowLike, deps)
 *   Checks window.__BH_RUNTIME_BRIDGE_ENABLED__ before starting.
 *   Returns null if disabled or mcpClient unavailable (fail-closed).
 *
 * Architecture principle: this module does NOT read window globals.
 * The window resolution + lane gate belong to NotionAdapter.activate() boundary.
 * The startNotionRuntimeBridgeIfEnabled helper captures that boundary logic here
 * to make it testable.
 *
 * BH-4 TDD: T-BH-19..T-BH-lane-3
 */

import type { Disposable } from '../../../../../../../mcp-runtime/src/lifecycle/disposable.ts';
import { createNotionProviderAdapter } from '../../../../../../../mcp-runtime/src/adapters/notion-provider-adapter.ts';
import { createToolCallLoop } from '../../../../../../../mcp-runtime/src/core/tool-call-loop.ts';
import { InMemoryToolRegistry } from '../../../../../../../mcp-runtime/src/core/in-memory-tool-registry.ts';
import { CfWorkerSchemaValidatorAdapter } from './cfworker-schema-validator-adapter.ts';
import { CfWorkerJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/cfworker';
import { NotionAdapterBridgeHost } from './notion-adapter-bridge-host.ts';
import { createNotionHostBindings, type NotionMcpClientLike } from './notion-host-bindings.ts';
import { normalizeToolDescriptors } from './notion-tool-shape-adapter.ts';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Minimal delegate needed from NotionAdapter (Layer 1). */
export interface NotionAdapterDelegate {
    insertText(text: string): Promise<boolean>;
    submitForm(): Promise<boolean>;
}

export interface NotionRuntimeBridgeDeps {
    adapter: NotionAdapterDelegate;
    mcpClient: NotionMcpClientLike;
    document: Document;
    MutationObserver: typeof MutationObserver;
    formatFunctionResult: (opts: {
        callId: string;
        name: string;
        status: 'success' | 'error';
        result: unknown;
    }) => string;
    logger?: Pick<Console, 'error' | 'warn'>;
    /** Slice I: optional InMemoryToolRegistry for pre-flight tool validation. */
    toolRegistry?: InMemoryToolRegistry;
}

export interface NotionRuntimeBridge {
    start(): Disposable;
}

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
// Controller (lifecycle guard)
// ---------------------------------------------------------------------------

class NotionRuntimeBridgeController implements NotionRuntimeBridge {
    private readonly deps: NotionRuntimeBridgeDeps;
    private disposable: Disposable | null = null;

    constructor(deps: NotionRuntimeBridgeDeps) {
        this.deps = deps;
    }

    start(): Disposable {
        // lifecycle guard: return existing disposable if already started
        if (this.disposable) return this.disposable;

        const bridgeHost = new NotionAdapterBridgeHost({
            adapter: this.deps.adapter,
            document: this.deps.document,
            MutationObserver: this.deps.MutationObserver,
        });
        const providerAdapter = createNotionProviderAdapter({ host: bridgeHost, observationMode: 'host-split' });
        const hostBindings = createNotionHostBindings({
            mcpClient: this.deps.mcpClient,
            formatFunctionResult: this.deps.formatFunctionResult,
            logger: this.deps.logger,
        });
        const loop = createToolCallLoop({
            adapter: providerAdapter,
            hostBindings,
            toolRegistry: this.deps.toolRegistry,
        });
        const inner = loop.start();

        let disposed = false;
        this.disposable = {
            dispose: async () => {
                if (disposed) return; // safe double-dispose
                disposed = true;
                await inner.dispose();
                this.disposable = null;
            },
        };
        return this.disposable;
    }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createNotionRuntimeBridge(deps: NotionRuntimeBridgeDeps): NotionRuntimeBridge {
    return new NotionRuntimeBridgeController(deps);
}

// ---------------------------------------------------------------------------
// Lane gate helper
//
// Tests the boolean flag + mcpClient presence.
// Returns Disposable if bridge was started, null if disabled or fail-closed.
//
// The caller (NotionAdapter.activate) must:
//   - Register DOM trigger listener when result === null
//   - NOT register DOM trigger listener when result !== null
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
    if (typeof mcpClient.getAvailableTools === 'function') {
        const schemaValidator = new CfWorkerSchemaValidatorAdapter(new CfWorkerJsonSchemaValidator());
        toolRegistry = new InMemoryToolRegistry({ schemaValidator });
        deps.onRegistryCreated?.(toolRegistry);
        // Async post-init populate — registry is empty until this resolves.
        // Early tool calls will return tool_not_found (accepted race — Slice J blocker).
        mcpClient.getAvailableTools().then(tools => {
            toolRegistry!.populate(normalizeToolDescriptors(tools));
        }).catch(err => {
            deps.logger?.warn?.('[NotionRuntimeBridge] getAvailableTools failed — registry remains empty', err);
        });
    } else {
        deps.logger?.warn?.('[NotionRuntimeBridge] getAvailableTools not available — skip registry wiring');
    }

    const bridge = createNotionRuntimeBridge({
        ...deps,
        mcpClient,
        toolRegistry,
    });
    return bridge.start();
}
