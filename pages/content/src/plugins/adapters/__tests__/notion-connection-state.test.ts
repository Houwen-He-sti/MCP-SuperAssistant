/**
 * NotionConnectionState — TDD tests
 *
 * T-N-01..03: NotionConnectionState.isConnected() maps store status → boolean
 *
 * Design: NotionConnectionState takes a getStatus() getter injection.
 * Tests pass a mock getter — no Zustand store needed.
 *
 * Slice N: ConnectionStatePort + Notion impl.
 * Plan: plans/slice-n-connection-state-port-plan.md
 * Committee: ENTER_TDD approved (Gemini OO + OPUS ReOO + GPT 4C + 2R)
 *
 * Run:
 *   node --test --experimental-strip-types \
 *     src/plugins/adapters/__tests__/notion-connection-state.test.ts
 * (from MCP-SuperAssistant/pages/content/)
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { NotionConnectionState } from '../notion/notion-connection-state.ts';
import type { ConnectionStatus } from '../../../types/stores.ts';

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

/** Creates a mutable status holder for pull-model tests. */
function makeStatusHolder(initial: ConnectionStatus): { status: ConnectionStatus; get: () => ConnectionStatus } {
    const holder = { status: initial, get() { return this.status; } };
    return holder;
}

// ---------------------------------------------------------------------------
// T-N-01: isConnected() = true when status = 'connected'
// ---------------------------------------------------------------------------

describe('T-N-01: NotionConnectionState.isConnected() when status = connected', () => {
    it('returns true when store status is connected', () => {
        const holder = makeStatusHolder('connected');
        const state = new NotionConnectionState(() => holder.get());

        assert.strictEqual(state.isConnected(), true);
    });
});

// ---------------------------------------------------------------------------
// T-N-02: isConnected() = false when status = 'disconnected'
// ---------------------------------------------------------------------------

describe('T-N-02: NotionConnectionState.isConnected() when status = disconnected', () => {
    it('returns false when store status is disconnected', () => {
        const holder = makeStatusHolder('disconnected');
        const state = new NotionConnectionState(() => holder.get());

        assert.strictEqual(state.isConnected(), false);
    });
});

// ---------------------------------------------------------------------------
// T-N-03: isConnected() = false for non-connected statuses
// ---------------------------------------------------------------------------

describe('T-N-03: NotionConnectionState.isConnected() for non-connected statuses', () => {
    const nonConnectedStatuses: ConnectionStatus[] = ['connecting', 'reconnecting', 'error'];

    for (const status of nonConnectedStatuses) {
        it(`returns false when store status is '${status}'`, () => {
            const holder = makeStatusHolder(status);
            const state = new NotionConnectionState(() => holder.get());

            assert.strictEqual(state.isConnected(), false,
                `Expected false for status '${status}'`);
        });
    }

    it('reflects real-time status changes (pull model)', () => {
        const holder = makeStatusHolder('disconnected');
        const state = new NotionConnectionState(() => holder.get());

        assert.strictEqual(state.isConnected(), false);

        holder.status = 'connected';
        assert.strictEqual(state.isConnected(), true);

        holder.status = 'reconnecting';
        assert.strictEqual(state.isConnected(), false);
    });
});
