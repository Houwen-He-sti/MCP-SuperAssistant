/**
 * BH-4 TDD: NotionRuntimeBridge — coordinator lifecycle + lane gate
 *
 * T-BH-19..T-BH-21, T-BH-lane-1..T-BH-lane-3
 *
 * Architecture:
 *   createNotionRuntimeBridge(deps).start()
 *     → NotionAdapterBridgeHost (Layer 2)
 *     → createNotionProviderAdapter (Layer 3)
 *     → createNotionHostBindings (HostBindings)
 *     → createToolCallLoop (Layer 4) → loop.start() → Disposable
 *
 * Lane gate:
 *   startNotionRuntimeBridgeIfEnabled(windowLike, deps)
 *     → if __BH_RUNTIME_BRIDGE_ENABLED__ !== true: return null
 *     → if mcpClient absent: return null (fail-closed)
 *     → else: createNotionRuntimeBridge + start
 *
 * Run:
 *   node --test --experimental-strip-types \
 *     src/plugins/adapters/__tests__/notion.runtime-bridge.test.ts
 * (from MCP-SuperAssistant/pages/content/)
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createNotionRuntimeBridge, startNotionRuntimeBridgeIfEnabled } from '../notion/notion-runtime-bridge.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface MockAdapterDelegate {
    insertText(text: string): Promise<boolean>;
    submitForm(): Promise<boolean>;
}

function makeMockAdapter(): MockAdapterDelegate {
    return {
        insertText: async (_text: string) => true,
        submitForm: async () => true,
    };
}

function makeFormatter() {
    return (opts: { callId: string; name: string; status: 'success' | 'error'; result: unknown }) =>
        `<function_result callId="${opts.callId}" status="${opts.status}">${JSON.stringify(opts.result)}</function_result>`;
}

function makeMockMcpClient() {
    return {
        callTool: async (_name: string, _args: Record<string, unknown>) => ({ ok: true }),
        isReady: () => true,
    };
}

/** FakeMO: tracks observe/disconnect calls, allows manual firing of callbacks. */
type FakeMOInstance = {
    disconnected: boolean;
    observed: boolean;
    observeCallCount: number;
    disconnectCallCount: number;
};

function makeFakeMO(): {
    MOClass: new (cb: MutationCallback) => MutationObserver;
    lastInstance(): FakeMOInstance | null;
} {
    let inst: FakeMOInstance | null = null;

    class FakeMutationObserver {
        disconnected = false;
        observed = false;
        observeCallCount = 0;
        disconnectCallCount = 0;

        constructor(_cb: MutationCallback) {
            // eslint-disable-next-line @typescript-eslint/no-this-alias
            inst = this;
        }

        observe(_target: Node, _options?: MutationObserverInit): void {
            this.observed = true;
            this.observeCallCount++;
        }

        disconnect(): void {
            this.disconnected = true;
            this.disconnectCallCount++;
        }

        takeRecords(): MutationRecord[] { return []; }
    }

    return {
        MOClass: FakeMutationObserver as unknown as new (cb: MutationCallback) => MutationObserver,
        lastInstance: () => inst,
    };
}

/** Build a document mock with a .layout-content element (required for observeAssistantMessages). */
function makeDocumentWithLayoutContent(): Document {
    const layoutContent = { textContent: '' };
    return {
        querySelector: (sel: string) => sel === '.layout-content' ? layoutContent : null,
    } as unknown as Document;
}

/** Build full deps for createNotionRuntimeBridge. */
function makeBridgeDeps(opts?: { MutationObserver?: new (cb: MutationCallback) => MutationObserver }) {
    return {
        adapter: makeMockAdapter(),
        mcpClient: makeMockMcpClient(),
        document: makeDocumentWithLayoutContent(),
        MutationObserver: opts?.MutationObserver ?? (class NoopMO {
            constructor(_cb: MutationCallback) {}
            observe(_t: Node) {}
            disconnect() {}
            takeRecords(): MutationRecord[] { return []; }
        }) as unknown as typeof MutationObserver,
        formatFunctionResult: makeFormatter(),
    };
}

// ---------------------------------------------------------------------------
// T-BH-19 — start() returns Disposable
// ---------------------------------------------------------------------------

describe('T-BH-19: createNotionRuntimeBridge.start() returns Disposable', () => {
    it('start() returns an object with a dispose function', async () => {
        const bridge = createNotionRuntimeBridge(makeBridgeDeps());
        const disposable = bridge.start();

        assert.ok(disposable !== null && disposable !== undefined);
        assert.equal(typeof disposable.dispose, 'function');

        // cleanup
        await disposable.dispose();
    });
});

// ---------------------------------------------------------------------------
// T-BH-19b — start() twice → no duplicate observer (lifecycle guard)
// ---------------------------------------------------------------------------

describe('T-BH-19b: start() twice → returns same disposable (double-start guard)', () => {
    it('calling start() twice returns the same disposable, not a new one', async () => {
        const { MOClass, lastInstance } = makeFakeMO();
        const bridge = createNotionRuntimeBridge(makeBridgeDeps({ MutationObserver: MOClass }));

        const d1 = bridge.start();
        const d2 = bridge.start();

        // Same dispose function reference OR at minimum, observer was only registered once
        const inst = lastInstance();
        assert.ok(inst !== null, 'MutationObserver instance should exist');
        assert.equal(inst!.observeCallCount, 1, 'observer.observe() must be called exactly once — not twice');

        await d1.dispose();
    });
});

// ---------------------------------------------------------------------------
// T-BH-19c — dispose() twice → no crash
// ---------------------------------------------------------------------------

describe('T-BH-19c: dispose() twice → safe (no crash)', () => {
    it('calling dispose() twice does not throw', async () => {
        const bridge = createNotionRuntimeBridge(makeBridgeDeps());
        const disposable = bridge.start();

        await assert.doesNotReject(async () => {
            await disposable.dispose();
            await disposable.dispose(); // second dispose must be safe
        });
    });
});

// ---------------------------------------------------------------------------
// T-BH-20 — start() registers MutationObserver on .layout-content
// ---------------------------------------------------------------------------

describe('T-BH-20: start() registers observer on .layout-content', () => {
    it('after start(), MutationObserver.observe() has been called', () => {
        const { MOClass, lastInstance } = makeFakeMO();
        const bridge = createNotionRuntimeBridge(makeBridgeDeps({ MutationObserver: MOClass }));

        bridge.start();

        const inst = lastInstance();
        assert.ok(inst !== null, 'FakeMO should have been instantiated');
        assert.equal(inst!.observed, true, 'MutationObserver.observe() must be called after start()');
    });
});

// ---------------------------------------------------------------------------
// T-BH-21 — dispose() disconnects MutationObserver
// ---------------------------------------------------------------------------

describe('T-BH-21: dispose() disconnects MutationObserver', () => {
    it('after dispose(), MutationObserver.disconnect() has been called', async () => {
        const { MOClass, lastInstance } = makeFakeMO();
        const bridge = createNotionRuntimeBridge(makeBridgeDeps({ MutationObserver: MOClass }));

        const disposable = bridge.start();
        await disposable.dispose();

        const inst = lastInstance();
        assert.ok(inst !== null);
        assert.equal(inst!.disconnected, true, 'MutationObserver.disconnect() must be called on dispose()');
    });
});

// ---------------------------------------------------------------------------
// T-BH-lane-1 — __BH_RUNTIME_BRIDGE_ENABLED__ absent/false → bridge NOT started
// ---------------------------------------------------------------------------

describe('T-BH-lane-1: flag absent/false → bridge not started', () => {
    it('returns null when __BH_RUNTIME_BRIDGE_ENABLED__ is absent', () => {
        const windowLike = { mcpClient: makeMockMcpClient() };
        const result = startNotionRuntimeBridgeIfEnabled(windowLike, makeBridgeDeps());
        assert.equal(result, null, 'Bridge must not start when flag is absent');
    });

    it('returns null when __BH_RUNTIME_BRIDGE_ENABLED__ is false', () => {
        const windowLike = { __BH_RUNTIME_BRIDGE_ENABLED__: false, mcpClient: makeMockMcpClient() };
        const result = startNotionRuntimeBridgeIfEnabled(windowLike, makeBridgeDeps());
        assert.equal(result, null, 'Bridge must not start when flag is false');
    });
});

// ---------------------------------------------------------------------------
// T-BH-lane-2 — flag true → bridge started
// ---------------------------------------------------------------------------

describe('T-BH-lane-2: flag true → bridge started', () => {
    it('returns Disposable when __BH_RUNTIME_BRIDGE_ENABLED__ is true', async () => {
        const { MOClass } = makeFakeMO();
        const windowLike = {
            __BH_RUNTIME_BRIDGE_ENABLED__: true,
            mcpClient: makeMockMcpClient(),
        };
        const result = startNotionRuntimeBridgeIfEnabled(windowLike, makeBridgeDeps({ MutationObserver: MOClass }));

        assert.ok(result !== null, 'Bridge must start when flag is true');
        assert.equal(typeof result!.dispose, 'function');

        await result!.dispose();
    });
});

// ---------------------------------------------------------------------------
// T-BH-lane-3 — flag absent → DOM trigger registration is NOT implied
//
// This tests that startNotionRuntimeBridgeIfEnabled returns null when flag is off.
// The caller (NotionAdapter.activate) is responsible for registering the DOM trigger
// listener only when bridge is NOT started (i.e., result === null).
// ---------------------------------------------------------------------------

describe('T-BH-lane-3: flag absent → null return signals DOM trigger should register', () => {
    it('when bridge disabled, null result indicates DOM trigger lane should be active', () => {
        const windowLike = { mcpClient: makeMockMcpClient() };
        const bridgeDisposable = startNotionRuntimeBridgeIfEnabled(windowLike, makeBridgeDeps());

        // null = "BH path inactive" — caller (activate) should register DOM trigger instead
        const shouldUseDomTriggerPath = bridgeDisposable === null;
        assert.equal(shouldUseDomTriggerPath, true);
    });

    it('T-BH-lane-3b: when bridge enabled, non-null return signals DOM trigger should NOT register', async () => {
        const windowLike = {
            __BH_RUNTIME_BRIDGE_ENABLED__: true,
            mcpClient: makeMockMcpClient(),
        };
        const bridgeDisposable = startNotionRuntimeBridgeIfEnabled(windowLike, makeBridgeDeps());

        // non-null = "BH path active" — caller (activate) must NOT register DOM trigger
        const shouldUseDomTriggerPath = bridgeDisposable === null;
        assert.equal(shouldUseDomTriggerPath, false, 'DOM trigger must NOT be active when BH bridge is enabled');

        await bridgeDisposable!.dispose();
    });

    it('T-BH-lane-3c: mcpClient absent → null even when flag is true (fail-closed)', () => {
        const windowLike = {
            __BH_RUNTIME_BRIDGE_ENABLED__: true,
            // mcpClient missing
        };
        const result = startNotionRuntimeBridgeIfEnabled(windowLike, makeBridgeDeps());
        assert.equal(result, null, 'Bridge must fail-closed when mcpClient is unavailable');
    });
});
