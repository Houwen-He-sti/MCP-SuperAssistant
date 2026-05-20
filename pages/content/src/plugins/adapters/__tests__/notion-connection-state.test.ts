/**
 * NotionConnectionState — TDD tests
 *
 * T-N-01..03: NotionConnectionState.isConnected() maps store status → boolean
 * T-N-07..10: NotionConnectionState.onConnectionChange() push subscription (Slice O)
 *
 * Design: NotionConnectionState takes a getStatus() getter injection.
 * Tests pass a mock getter — no Zustand store needed.
 *
 * Slice N: isConnected() pull model.
 * Slice O: onConnectionChange? push subscription.
 * Plan: plans/slice-o-connection-state-push-plan.md
 * Committee: Gemini OO ✅ + OPUS ReOO ✅ + GPT OO ✅
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
import type { Disposable } from '../../../../../../../mcp-runtime/src/lifecycle/disposable.ts';

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

// ---------------------------------------------------------------------------
// T-N-07: onConnectionChange — callback fires true when status → 'connected'
// ---------------------------------------------------------------------------

describe('T-N-07: NotionConnectionState.onConnectionChange fires true on connected', () => {
    it('notifies true when subscribeStatus emits connected', () => {
        const subscribers: Array<(status: ConnectionStatus) => void> = [];
        const subscribeStatus = (cb: (status: ConnectionStatus) => void): Disposable => {
            subscribers.push(cb);
            return { dispose: () => { const i = subscribers.indexOf(cb); if (i !== -1) subscribers.splice(i, 1); } };
        };
        const state = new NotionConnectionState(() => 'disconnected', subscribeStatus);

        const received: boolean[] = [];
        state.onConnectionChange!((connected) => received.push(connected));

        subscribers[0]!('connected');
        assert.deepStrictEqual(received, [true]);
    });
});

// ---------------------------------------------------------------------------
// T-N-08: onConnectionChange — callback fires false when status → 'disconnected'
// ---------------------------------------------------------------------------

describe('T-N-08: NotionConnectionState.onConnectionChange fires false on disconnected', () => {
    it('notifies false when subscribeStatus emits disconnected', () => {
        const subscribers: Array<(status: ConnectionStatus) => void> = [];
        const subscribeStatus = (cb: (status: ConnectionStatus) => void): Disposable => {
            subscribers.push(cb);
            return { dispose: () => { const i = subscribers.indexOf(cb); if (i !== -1) subscribers.splice(i, 1); } };
        };
        const state = new NotionConnectionState(() => 'connected', subscribeStatus);

        const received: boolean[] = [];
        state.onConnectionChange!((connected) => received.push(connected));

        subscribers[0]!('disconnected');
        subscribers[0]!('error');
        subscribers[0]!('reconnecting');
        subscribers[0]!('connected');
        assert.deepStrictEqual(received, [false, false, false, true]);
    });
});

// ---------------------------------------------------------------------------
// T-N-09: onConnectionChange — Disposable unsubscribes the callback
// ---------------------------------------------------------------------------

describe('T-N-09: NotionConnectionState.onConnectionChange Disposable stops notifications', () => {
    it('no more notifications after dispose()', () => {
        const subscribers: Array<(status: ConnectionStatus) => void> = [];
        const subscribeStatus = (cb: (status: ConnectionStatus) => void): Disposable => {
            subscribers.push(cb);
            return { dispose: () => { const i = subscribers.indexOf(cb); if (i !== -1) subscribers.splice(i, 1); } };
        };
        const state = new NotionConnectionState(() => 'disconnected', subscribeStatus);

        const received: boolean[] = [];
        const sub: Disposable = state.onConnectionChange!((connected) => received.push(connected));

        subscribers[0]!('connected'); // fires — [true]
        sub.dispose();
        subscribers.forEach((cb) => cb('disconnected')); // not fired

        assert.deepStrictEqual(received, [true]);
        assert.strictEqual(subscribers.length, 0);
    });
});

// ---------------------------------------------------------------------------
// T-N-10: onConnectionChange — returns noopDisposable when subscribeStatus absent
// ---------------------------------------------------------------------------

describe('T-N-10: NotionConnectionState.onConnectionChange returns noopDisposable when no subscribeStatus', () => {
    it('onConnectionChange is callable and returns Disposable even without subscribeStatus', () => {
        const state = new NotionConnectionState(() => 'connected');

        const received: boolean[] = [];
        const sub: Disposable = state.onConnectionChange!((connected) => received.push(connected));

        // subscribeStatus not provided → no notifications
        assert.deepStrictEqual(received, []);
        // dispose is safe (noopDisposable)
        assert.doesNotThrow(() => sub.dispose());
        assert.doesNotThrow(() => sub.dispose());
    });
});
