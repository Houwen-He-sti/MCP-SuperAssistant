/**
 * NotionRuntimeBridgeController — Layer 4 BH architecture implementation.
 *
 * Wires all 4 layers together:
 *   Layer 4: ToolCallLoop (mcp-runtime)
 *   Layer 3: createNotionProviderAdapter (mcp-runtime)
 *   Layer HostBindings: createNotionHostBindings
 *   Layer 2: NotionAdapterBridgeHost (BH-2/BH-3)
 *   Layer 1: NotionAdapter DOM (existing, passed as adapter)
 *
 * Slice Q: Extracted from notion-runtime-bridge.ts (mechanical move, zero behavior change).
 * notion-runtime-bridge.ts is now a pure facade re-exporting from this file and notion-bridge-lane-gate.ts.
 */

import type { Disposable } from '../../../../../../../mcp-runtime/src/lifecycle/disposable.ts';
import { createNotionProviderAdapter } from '../../../../../../../mcp-runtime/src/adapters/notion-provider-adapter.ts';
import { createToolCallLoop } from '../../../../../../../mcp-runtime/src/core/tool-call-loop.ts';
import { InMemoryToolRegistry } from '../../../../../../../mcp-runtime/src/core/in-memory-tool-registry.ts';
import type { ToolCatalogSource } from '../../../../../../../mcp-runtime/src/core/tool-catalog-source.ts';
import { NotionAdapterBridgeHost } from './notion-adapter-bridge-host.ts';
import { createNotionHostBindings, type NotionMcpClientLike } from './notion-host-bindings.ts';
import { NotionRejectionHandler } from './notion-rejection-handler.ts';

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
    /** Slice M: optional ToolCatalogSource — Controller.start() calls getTools() → populates registry. */
    toolCatalogSource?: ToolCatalogSource;
}

export interface NotionRuntimeBridge {
    start(): Disposable;
}

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
        const rejectionHandler = new NotionRejectionHandler(this.deps.formatFunctionResult);
        const loop = createToolCallLoop({
            adapter: providerAdapter,
            hostBindings,
            toolRegistry: this.deps.toolRegistry,
            rejectionHandler,
        });
        const inner = loop.start();

        // Slice M: coordinate source → registry populate (fire-and-forget, Option Y+)
        if (this.deps.toolCatalogSource && this.deps.toolRegistry) {
            const registry = this.deps.toolRegistry;
            this.deps.toolCatalogSource.getTools()
                .then(tools => { registry.populate(tools); })
                .catch(err => {
                    this.deps.logger?.warn?.('[NotionBridgeController] getTools failed — registry remains empty', err);
                });
        }

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
