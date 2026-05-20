/**
 * NotionConnectionState — Notion implementation of the ConnectionStatePort.
 *
 * Reads MCP connection status via an injected getter function.
 *
 * Design (getter injection — GPT 4C P1-2 / P2-2):
 *   - Constructor takes `getStatus: () => ConnectionStatus` rather than importing useConnectionStore directly.
 *   - Reason: connection.store.ts imports '../events' (directory), which causes ERR_UNSUPPORTED_DIR_IMPORT
 *     in Node.js ESM test environment. Getter injection avoids top-level side effects in test env.
 *   - Production binding: notion.adapter.ts provides `() => useConnectionStore.getState().status`.
 *   - Tests: pass a plain `() => status` function — no Zustand import required.
 *
 * Fail-closed contract (GPT 4C P1-2):
 *   - Only 'connected' maps to isConnected() = true.
 *   - All other statuses ('disconnected', 'connecting', 'reconnecting', 'error') → false.
 *   - If getStatus() throws for any reason → isConnected() returns false (fail-closed, no crash).
 *
 * Pull model (D6): getStatus() is called on every isConnected() invocation.
 * Real-time status is always reflected — no stale cache.
 *
 * Slice N: ConnectionStatePort + Notion impl.
 * Plan: plans/slice-n-connection-state-port-plan.md
 * Committee: Gemini OO ✅ + OPUS ReOO ✅ + GPT 4C ACCEPT_WITH_REVISE ✅ + Gemini/OPUS 2R ✅
 */

import type { ConnectionStatePort } from '../../../../../../../mcp-runtime/src/core/connection-state-port.ts';
import type { ConnectionStatus } from '../../../types/stores.ts';

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

export class NotionConnectionState implements ConnectionStatePort {
    private readonly getStatus: () => ConnectionStatus;

    constructor(getStatus: () => ConnectionStatus) {
        this.getStatus = getStatus;
    }

    isConnected(): boolean {
        try {
            return this.getStatus() === 'connected';
        } catch {
            // Fail-closed: if the getter throws for any reason, treat as not connected.
            // The production getter (useConnectionStore.getState().status) is synchronous
            // and will not throw, but defensive handling prevents a getter bug from
            // allowing tool calls through.
            return false;
        }
    }
}
