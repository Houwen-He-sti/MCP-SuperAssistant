/**
 * NotionConnectionState — Notion implementation of the ConnectionStatePort.
 *
 * Reads MCP connection status via injected getter + optional subscribe functions.
 *
 * Design (getter + subscribe injection — GPT 4C P1-2 / Slice O extension):
 *   - Constructor takes:
 *       getStatus: () => ConnectionStatus     — pull model (Slice N)
 *       subscribeStatus?: (cb) => Disposable  — push model (Slice O)
 *   - Reason: connection.store.ts imports '../events' (directory), which causes ERR_UNSUPPORTED_DIR_IMPORT
 *     in Node.js ESM test environment. Injection avoids top-level side effects in test env.
 *   - Production binding: notion.adapter.ts provides both getter and eventBus subscribe.
 *   - Tests: pass plain functions — no Zustand / eventBus import required.
 *
 * Fail-closed contract (GPT 4C P1-2):
 *   - Only 'connected' maps to isConnected() = true.
 *   - If getStatus() throws → isConnected() returns false (fail-closed, no crash).
 *
 * Pull model (D6): getStatus() is called on every isConnected() invocation.
 * Push model (Slice O): onConnectionChange? wraps subscribeStatus, converts ConnectionStatus → boolean.
 *
 * Slice N: isConnected() pull model.
 * Slice O: onConnectionChange? push subscription.
 * Plan: plans/slice-o-connection-state-push-plan.md
 * Committee: Gemini OO ✅ + OPUS ReOO ✅ + GPT OO ✅
 */

import type { ConnectionStatePort } from '../../../../../../../mcp-runtime/src/core/connection-state-port.ts';
import type { Disposable } from '../../../../../../../mcp-runtime/src/lifecycle/disposable.ts';
import type { ConnectionStatus } from '../../../types/stores.ts';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Injected subscribe function — wraps eventBus.on('connection:status-changed', ...) */
export type SubscribeConnectionStatus = (cb: (status: ConnectionStatus) => void) => Disposable;

/** No-op Disposable for when subscribeStatus is not provided. */
const noopDisposable: Disposable = { dispose: () => {} };

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

export class NotionConnectionState implements ConnectionStatePort {
    private readonly getStatus: () => ConnectionStatus;
    private readonly subscribeStatus: SubscribeConnectionStatus | undefined;

    constructor(getStatus: () => ConnectionStatus, subscribeStatus?: SubscribeConnectionStatus) {
        this.getStatus = getStatus;
        this.subscribeStatus = subscribeStatus;
    }

    isConnected(): boolean {
        try {
            return this.getStatus() === 'connected';
        } catch {
            // Fail-closed: if the getter throws for any reason, treat as not connected.
            return false;
        }
    }

    onConnectionChange(cb: (connected: boolean) => void): Disposable {
        if (!this.subscribeStatus) {
            return noopDisposable;
        }
        return this.subscribeStatus((status) => cb(status === 'connected'));
    }
}
