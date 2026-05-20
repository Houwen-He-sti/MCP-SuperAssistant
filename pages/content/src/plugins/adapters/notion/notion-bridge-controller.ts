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

import { createNotionProviderAdapter } from '../../../../../../../mcp-runtime/src/adapters/notion-provider-adapter.ts';
import { InMemoryToolRegistry } from '../../../../../../../mcp-runtime/src/core/in-memory-tool-registry.ts';
import { createToolCallLoop } from '../../../../../../../mcp-runtime/src/core/tool-call-loop.ts';
import type { ToolCatalogSource } from '../../../../../../../mcp-runtime/src/core/tool-catalog-source.ts';
import type { ConnectionStatePort } from '../../../../../../../mcp-runtime/src/core/connection-state-port.ts';
import type { Disposable } from '../../../../../../../mcp-runtime/src/lifecycle/disposable.ts';
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
    /** Slice N: optional ConnectionStatePort — authoritative connection gate (D6 guard). */
    connectionState?: ConnectionStatePort;
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
            connectionState: this.deps.connectionState,
        });
        const rejectionHandler = new NotionRejectionHandler(this.deps.formatFunctionResult);
        const loop = createToolCallLoop({
            adapter: providerAdapter,
            hostBindings,
            toolRegistry: this.deps.toolRegistry,
            rejectionHandler,
        });
        const inner = loop.start();

        // Δ-028-B: declare disposed BEFORE fire-and-forget so the .then() closure can guard against
        // populate() being called after dispose() has already run.
        let disposed = false;

        // Slice M + P: coordinate source → registry populate + reconnect refresh
        let connectionChangeSubscription: Disposable | undefined;

        if (this.deps.toolCatalogSource && this.deps.toolRegistry) {
            const registry = this.deps.toolRegistry;
            const source = this.deps.toolCatalogSource;

            // Queue semantics: if a refresh is already in-flight and another reconnect fires,
            // mark refreshPending=true; after the in-flight request completes (success or failure),
            // a pending refresh is executed. This ensures the most recent reconnect always
            // triggers a refresh, even if the previous fetch was slow or failed.
            let refreshInFlight = false;
            let refreshPending = false;

            const refreshRegistry = () => {
                if (disposed) return;
                if (refreshInFlight) {
                    refreshPending = true;
                    return;
                }
                refreshInFlight = true;
                source.getTools()
                    .then(tools => {
                        if (!disposed) {
                            registry.populate(tools);
                        }
                    })
                    .catch(err => {
                        this.deps.logger?.warn?.('[NotionBridgeController] registry refresh failed', err);
                    })
                    .finally(() => {
                        refreshInFlight = false;
                        if (refreshPending && !disposed) {
                            refreshPending = false;
                            refreshRegistry();
                        }
                    });
            };

            // Slice M: initial populate (same refreshRegistry path)
            refreshRegistry();

            // Slice P: subscribe to reconnect events
            if (this.deps.connectionState?.onConnectionChange) {
                connectionChangeSubscription = this.deps.connectionState.onConnectionChange(
                    (connected) => { if (connected) refreshRegistry(); }
                );
            }
        }

        this.disposable = {
            dispose: async () => {
                if (disposed) return; // safe double-dispose
                disposed = true;
                await connectionChangeSubscription?.dispose();
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
