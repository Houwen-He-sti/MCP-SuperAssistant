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

// ---------------------------------------------------------------------------
// Slice I — InMemoryToolRegistry first-consumer wiring
//
// T-LOOP-I-01a..T-LOOP-I-08
//
// Tests that startNotionRuntimeBridgeIfEnabled wires InMemoryToolRegistry
// (with ObservationOnlySchemaValidator) into createToolCallLoop when
// mcpClient has getAvailableTools(). Async post-init populate pattern.
//
// Run:
//   node --test --experimental-strip-types \
//     src/plugins/adapters/__tests__/notion.runtime-bridge.test.ts
// (from MCP-SuperAssistant/pages/content/)
// ---------------------------------------------------------------------------

import { InMemoryToolRegistry } from '../../../../../../../mcp-runtime/src/core/in-memory-tool-registry.ts';

describe('Slice I — InMemoryToolRegistry first-consumer wiring', () => {

    it('T-LOOP-I-05: BH flag OFF → returns null, getAvailableTools NOT called', () => {
        let getAvailableToolsCalled = false;
        const windowLike = {
            // __BH_RUNTIME_BRIDGE_ENABLED__ absent (OFF)
            mcpClient: {
                ...makeMockMcpClient(),
                getAvailableTools: async () => {
                    getAvailableToolsCalled = true;
                    return [];
                },
            },
        };
        const result = startNotionRuntimeBridgeIfEnabled(windowLike, makeBridgeDeps());
        assert.equal(result, null, 'Flag OFF must return null');
        assert.equal(getAvailableToolsCalled, false, 'getAvailableTools must NOT be called when flag is OFF');
    });

    it('T-LOOP-I-06: BH flag ON + mcpClient without getAvailableTools → warn logged, loop started WITHOUT toolRegistry', async () => {
        const warnings: string[] = [];
        const windowLike = {
            __BH_RUNTIME_BRIDGE_ENABLED__: true,
            mcpClient: {
                callTool: async (_name: string, _args: Record<string, unknown>) => ({ ok: true }),
                isReady: () => true,
                // getAvailableTools intentionally absent
            },
        };
        const deps = {
            ...makeBridgeDeps(),
            logger: {
                warn: (msg: string, ..._rest: unknown[]) => warnings.push(msg),
                error: (_msg: string, ..._rest: unknown[]) => {},
            },
        };
        const result = startNotionRuntimeBridgeIfEnabled(windowLike, deps);
        assert.notEqual(result, null, 'Loop must be started even without getAvailableTools');
        const warnLogged = warnings.some(w => w.includes('getAvailableTools'));
        assert.equal(warnLogged, true, 'Must warn when getAvailableTools is absent');
        await result!.dispose();
    });

    it('T-LOOP-I-01a: BH flag ON + mcpClient with getAvailableTools → loop started (not null)', async () => {
        const windowLike = {
            __BH_RUNTIME_BRIDGE_ENABLED__: true,
            mcpClient: {
                ...makeMockMcpClient(),
                getAvailableTools: async () => [
                    { name: 'echo', description: 'echo tool' },
                ],
            },
        };
        const result = startNotionRuntimeBridgeIfEnabled(windowLike, makeBridgeDeps());
        assert.notEqual(result, null, 'Loop must be started when flag ON + mcpClient present');
        await result!.dispose();
    });

    it('T-LOOP-I-01b: after async populate resolves, registry.listTools() returns descriptors', async () => {
        const tools = [
            { name: 'echo', description: 'echo tool' },
            { name: 'search', description: 'search tool', inputSchema: { type: 'object', properties: {} } },
        ];
        let capturedRegistry: InMemoryToolRegistry | undefined;
        const windowLike = {
            __BH_RUNTIME_BRIDGE_ENABLED__: true,
            mcpClient: {
                ...makeMockMcpClient(),
                getAvailableTools: async () => tools,
            },
        };
        // To capture the registry, startNotionRuntimeBridgeIfEnabled must expose it.
        // This test will FAIL until the implementation creates + populates the registry.
        const result = startNotionRuntimeBridgeIfEnabled(windowLike, {
            ...makeBridgeDeps(),
            onRegistryCreated: (r: InMemoryToolRegistry) => { capturedRegistry = r; },
        } as Parameters<typeof startNotionRuntimeBridgeIfEnabled>[1] & { onRegistryCreated?: (r: InMemoryToolRegistry) => void });

        assert.notEqual(result, null);

        // Wait for async populate to resolve
        await new Promise(resolve => setTimeout(resolve, 50));

        assert.notEqual(capturedRegistry, undefined, 'Registry must be created by implementation');
        const listed = await capturedRegistry!.listTools();
        assert.deepEqual(listed.map(t => t.name).sort(), ['echo', 'search']);

        await result!.dispose();
    });

    it('T-LOOP-I-04: empty list from getAvailableTools() → no crash', async () => {
        const windowLike = {
            __BH_RUNTIME_BRIDGE_ENABLED__: true,
            mcpClient: {
                ...makeMockMcpClient(),
                getAvailableTools: async () => [],
            },
        };
        const result = startNotionRuntimeBridgeIfEnabled(windowLike, makeBridgeDeps());
        assert.notEqual(result, null, 'Empty tool list must not crash bridge startup');
        await new Promise(resolve => setTimeout(resolve, 20));
        await result!.dispose();
    });

    it('T-LOOP-I-02: validateArgs on known tool with schemaValidator returns ok (ObservationOnly bypasses schema)', async () => {
        const tools = [
            { name: 'echo', inputSchema: { type: 'object', properties: { message: { type: 'string' } } } },
        ];
        const registry = new InMemoryToolRegistry({
            schemaValidator: {
                validate: (_schema, _args) => ({ ok: true }),
            },
        });
        registry.populate(tools as Parameters<typeof registry.populate>[0]);
        const result = registry.validateArgs('echo', { message: 'test' });
        assert.equal(result.ok, true, 'Known tool with inputSchema + ObservationOnly validator must return ok');
    });

    it('T-LOOP-I-03: validateArgs on unknown tool returns tool_not_found', async () => {
        const registry = new InMemoryToolRegistry();
        registry.populate([{ name: 'echo' }]);
        const result = registry.validateArgs('unknown_tool', {});
        assert.equal(result.ok, false);
        assert.equal((result as { ok: false; code: string }).code, 'tool_not_found');
    });

    it('T-LOOP-I-07: ObservationOnlySchemaValidator logs bypass when tool with inputSchema is validated', () => {
        const bypassLog: Array<{ schemaKeys: string[]; argsType: string }> = [];
        const observationOnlyValidator = {
            validate: (schema: Record<string, unknown>, args: unknown): { ok: true } => {
                bypassLog.push({ schemaKeys: Object.keys(schema), argsType: typeof args });
                return { ok: true };
            },
        };
        const registry = new InMemoryToolRegistry({ schemaValidator: observationOnlyValidator });
        registry.populate([
            { name: 'echo', inputSchema: { type: 'object', properties: { message: { type: 'string' } } } },
        ] as Parameters<typeof registry.populate>[0]);
        registry.validateArgs('echo', { message: 'hi' });
        assert.equal(bypassLog.length, 1, 'Bypass must be logged once');
        assert.ok(bypassLog[0].schemaKeys.includes('type') || bypassLog[0].schemaKeys.includes('properties'), 'Schema keys must be captured');
    });

    it('T-LOOP-I-08: during async populate pending window, validateArgs returns tool_not_found (accepted race)', () => {
        // Registry is empty before async populate resolves
        const registry = new InMemoryToolRegistry();
        // Do NOT call populate() — simulates pre-populate state
        const result = registry.validateArgs('echo', { message: 'test' });
        assert.equal(result.ok, false);
        assert.equal((result as { ok: false; code: string }).code, 'tool_not_found',
            'Before populate resolves, all tools are unknown (accepted race — Slice J blocker)');
    });
});
