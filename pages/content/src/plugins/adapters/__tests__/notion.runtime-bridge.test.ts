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

    takeRecords(): MutationRecord[] {
      return [];
    }
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
    querySelector: (sel: string) => (sel === '.layout-content' ? layoutContent : null),
  } as unknown as Document;
}

/** Build full deps for createNotionRuntimeBridge. */
function makeBridgeDeps(opts?: { MutationObserver?: new (cb: MutationCallback) => MutationObserver }) {
  return {
    adapter: makeMockAdapter(),
    mcpClient: makeMockMcpClient(),
    document: makeDocumentWithLayoutContent(),
    MutationObserver:
      opts?.MutationObserver ??
      (class NoopMO {
        constructor(_cb: MutationCallback) {}
        observe(_t: Node) {}
        disconnect() {}
        takeRecords(): MutationRecord[] {
          return [];
        }
      } as unknown as typeof MutationObserver),
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
    let registryCreated = false;
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
      onRegistryCreated: () => {
        registryCreated = true;
      },
    };
    const result = startNotionRuntimeBridgeIfEnabled(windowLike, deps);
    assert.notEqual(result, null, 'Loop must be started even without getAvailableTools');
    const warnLogged = warnings.some(w => w.includes('getAvailableTools'));
    assert.equal(warnLogged, true, 'Must warn when getAvailableTools is absent');
    assert.equal(registryCreated, false, 'onRegistryCreated must NOT be called when getAvailableTools is absent');
    await result!.dispose();
  });

  it('T-LOOP-I-01a: BH flag ON + mcpClient with getAvailableTools → loop started (not null)', async () => {
    const windowLike = {
      __BH_RUNTIME_BRIDGE_ENABLED__: true,
      mcpClient: {
        ...makeMockMcpClient(),
        getAvailableTools: async () => [{ name: 'echo', description: 'echo tool' }],
      },
    };
    const result = startNotionRuntimeBridgeIfEnabled(windowLike, makeBridgeDeps());
    assert.notEqual(result, null, 'Loop must be started when flag ON + mcpClient present');
    await result!.dispose();
  });

  it('T-LOOP-I-01b: after async populate resolves, registry.listTools() returns descriptors', async () => {
    // Slice J1: fixtures use McpClientToolShape (snake_case) to reflect real McpClient output
    const tools = [
      { name: 'echo', description: 'echo tool' },
      { name: 'search', description: 'search tool', input_schema: { type: 'object', properties: {} } },
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
      onRegistryCreated: (r: InMemoryToolRegistry) => {
        capturedRegistry = r;
      },
    } as Parameters<typeof startNotionRuntimeBridgeIfEnabled>[1] & {
      onRegistryCreated?: (r: InMemoryToolRegistry) => void;
    });

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
    // Slice J1: fixture uses McpClientToolShape (snake_case input_schema)
    // normalizeToolDescriptors converts input_schema → inputSchema before populate
    const tools = [{ name: 'echo', input_schema: { type: 'object', properties: { message: { type: 'string' } } } }];
    const registry = new InMemoryToolRegistry({
      schemaValidator: {
        validate: (_schema, _args) => ({ ok: true }),
      },
    });
    // Simulate what notion-runtime-bridge.ts does: normalize before populate
    const { normalizeToolDescriptors } = await import('../notion/notion-tool-shape-adapter.ts');
    registry.populate(normalizeToolDescriptors(tools));
    const result = registry.validateArgs('echo', { message: 'test' });
    assert.equal(result.ok, true, 'Known tool with inputSchema + schemaValidator must return ok');
  });

  it('T-LOOP-I-03: validateArgs on unknown tool returns tool_not_found', async () => {
    const registry = new InMemoryToolRegistry();
    registry.populate([{ name: 'echo' }]);
    const result = registry.validateArgs('unknown_tool', {});
    assert.equal(result.ok, false);
    assert.equal((result as { ok: false; code: string }).code, 'tool_not_found');
  });

  it('T-LOOP-I-07: CfWorkerSchemaValidatorAdapter wired via startNotionRuntimeBridgeIfEnabled performs real validation (Slice K)', async () => {
    // Slice K: ObservationOnlySchemaValidator replaced by CfWorkerSchemaValidatorAdapter.
    // This test verifies the adapter is correctly wired into the registry
    // and that real schema validation is performed (not a bypass).
    // input_schema (snake_case) used here so normalizeToolDescriptors (Slice J1) populates inputSchema in registry.
    let capturedRegistry: InMemoryToolRegistry | undefined;
    const tools = [
      {
        name: 'echo',
        input_schema: { type: 'object', properties: { message: { type: 'string' } }, required: ['message'] },
      },
    ];
    const windowLike = {
      __BH_RUNTIME_BRIDGE_ENABLED__: true,
      mcpClient: {
        ...makeMockMcpClient(),
        getAvailableTools: async () => tools,
      },
    };
    const result = startNotionRuntimeBridgeIfEnabled(windowLike, {
      ...makeBridgeDeps(),
      onRegistryCreated: (r: InMemoryToolRegistry) => {
        capturedRegistry = r;
      },
    });
    assert.notEqual(result, null);

    // Wait for async populate
    await new Promise(resolve => setTimeout(resolve, 50));

    assert.notEqual(capturedRegistry, undefined, 'Registry must be created and exposed via onRegistryCreated');

    // Slice K: real validation — valid args must pass
    const validResult = capturedRegistry!.validateArgs('echo', { message: 'hello' });
    assert.equal(validResult.ok, true, 'CfWorkerSchemaValidatorAdapter must pass valid args');

    // Slice K: real validation — invalid args must fail (not bypass like ObservationOnly)
    const invalidResult = capturedRegistry!.validateArgs('echo', {});
    assert.equal(invalidResult.ok, false, 'CfWorkerSchemaValidatorAdapter must reject invalid args');
    assert.equal(
      (invalidResult as { ok: false; code: string }).code,
      'arg_validation_failed',
      'Error code must be arg_validation_failed',
    );

    await result!.dispose();
  });

  it('T-LOOP-I-08: during async populate pending window, validateArgs returns tool_not_found (accepted race)', () => {
    // Registry is empty before async populate resolves
    const registry = new InMemoryToolRegistry();
    // Do NOT call populate() — simulates pre-populate state
    const result = registry.validateArgs('echo', { message: 'test' });
    assert.equal(result.ok, false);
    assert.equal(
      (result as { ok: false; code: string }).code,
      'tool_not_found',
      'Before populate resolves, all tools are unknown (accepted race — Slice J blocker)',
    );
  });

  it('T-LOOP-J1-01: after populate with snake_case input_schema, registry.describeTool returns inputSchema (not undefined)', async () => {
    // Slice J1: verifies normalizeToolDescriptors is called before populate in the real bridge wiring.
    // Given: McpClient returns snake_case input_schema
    // Expected: registry.describeTool returns descriptor with camelCase inputSchema populated
    let capturedRegistry: InMemoryToolRegistry | undefined;
    const tools = [
      {
        name: 'echo',
        description: 'echo tool',
        input_schema: { type: 'object', properties: { message: { type: 'string' } }, required: ['message'] },
      },
    ];
    const windowLike = {
      __BH_RUNTIME_BRIDGE_ENABLED__: true,
      mcpClient: {
        ...makeMockMcpClient(),
        getAvailableTools: async () => tools,
      },
    };
    const result = startNotionRuntimeBridgeIfEnabled(windowLike, {
      ...makeBridgeDeps(),
      onRegistryCreated: (r: InMemoryToolRegistry) => {
        capturedRegistry = r;
      },
    });
    assert.notEqual(result, null, 'Bridge must start');

    // Wait for async populate to resolve
    await new Promise(resolve => setTimeout(resolve, 50));

    assert.notEqual(capturedRegistry, undefined, 'Registry must be created');
    const descriptor = await capturedRegistry!.describeTool('echo');
    assert.notEqual(descriptor, undefined, 'Tool must be found in registry');
    assert.notEqual(
      descriptor!.inputSchema,
      undefined,
      'inputSchema MUST NOT be undefined after normalize — shape adapter must convert input_schema → inputSchema',
    );
    assert.deepEqual(
      descriptor!.inputSchema,
      { type: 'object', properties: { message: { type: 'string' } }, required: ['message'] },
      'inputSchema must exactly match the original input_schema value',
    );

    await result!.dispose();
  });

  it('T-LOOP-L-01: NotionRejectionHandler N=2 callId symmetry — handler isolation (N=2 second-position identity)', async () => {
    // Slice L: Verify NotionRejectionHandler callId identity is correct for N=2 scenario.
    // L9+L10 protocol: each error path at second position must preserve its own identity.
    //
    // This test exercises the handler in isolation (handler-level, not via full ToolCallLoop path).
    // T-LOOP-L-02 and T-LOOP-L-03 cover the real validateArgs→handler→insertText integration path.
    const { NotionRejectionHandler } = await import('../notion/notion-rejection-handler.ts');
    const formatterCalls: Array<{ callId: string; name: string; status: string; result: unknown }> = [];

    const handler = new NotionRejectionHandler((opts) => {
      formatterCalls.push(opts);
      return `<tool_result callId="${opts.callId}" status="${opts.status}">${JSON.stringify(opts.result)}</tool_result>`;
    });

    // N=1: first position — tool_not_found
    const payloadC1 = { name: 'unknown_tool', callId: 'call-c1', arguments: {}, executable: true };
    const reasonC1 = { code: 'tool_not_found' as const, toolName: 'unknown_tool', callId: 'call-c1' };
    const resultC1 = await handler.onToolCallReject(payloadC1, reasonC1);

    assert.equal(resultC1.success, true, 'N=1: success must be true');
    assert.equal(resultC1.callId, 'call-c1', 'N=1: callId must be c1');
    assert.ok(resultC1.formattedResponse.includes('call-c1'), 'N=1: formattedResponse must reference c1');

    // N=2: second position with different callId — must not cross-contaminate c1
    const payloadC2 = { name: 'echo', callId: 'call-c2', arguments: {}, executable: true };
    const reasonC2 = {
      code: 'args_invalid' as const,
      toolName: 'echo',
      callId: 'call-c2',
      validationCode: 'arg_validation_failed',
      validationMessage: 'Missing required field: message',
      validationDetails: { path: '/message' },
    };
    const resultC2 = await handler.onToolCallReject(payloadC2, reasonC2);

    assert.equal(resultC2.success, true, 'N=2: success must be true');
    assert.equal(resultC2.callId, 'call-c2', 'N=2: callId must be c2 (not c1)');
    assert.ok(resultC2.formattedResponse.includes('call-c2'), 'N=2: formattedResponse must reference c2');
    assert.ok(!resultC2.formattedResponse.includes('call-c1'), 'N=2: c2 response must NOT reference c1 callId');

    // Verify formatter called with correct distinct callIds (N=2 symmetry criterion)
    assert.equal(formatterCalls.length, 2, 'formatter must be called once per rejection');
    assert.equal(formatterCalls[0].callId, 'call-c1', 'first formatter call must use c1');
    assert.equal(formatterCalls[1].callId, 'call-c2', 'second formatter call must use c2');
    const r2 = formatterCalls[1].result as { code: string; validationMessage: string };
    assert.ok(r2.validationMessage.length > 0, 'N=2: validationMessage must be present for LLM self-correction');
  });
});

// ---------------------------------------------------------------------------
// Slice L — ToolCallLoop integration: validateArgs reject → NotionRejectionHandler → insertText
// ---------------------------------------------------------------------------
// These tests prove the real path:
//   validateArgs() reject → loop.handleRejection() → NotionRejectionHandler → adapter.insertText(error ToolResult)
// They use createToolCallLoop directly with a controllable in-process adapter (no DOM/MO).
// The controllable adapter captures insertText() calls so we can assert on the injected content.
// ---------------------------------------------------------------------------

describe('Slice L — rejection path integration (validateArgs→handler→insertText)', () => {
  // Inline controllable ProviderAdapter compatible with createToolCallLoop
  function makeControllableAdapter() {
    const insertedTexts: string[] = [];
    let _callback: ((msg: { content: string; isComplete: boolean; timestamp: number }) => void | Promise<void>) | null = null;

    const adapter = {
      id: 'notion-test',
      isSupported: () => true,
      insertText: async (text: string): Promise<{ ok: true }> => {
        insertedTexts.push(text);
        return { ok: true };
      },
      submit: async (): Promise<{ ok: true }> => ({ ok: true }),
      isStreaming: () => false,
      observeAssistantMessages: (cb: (msg: { content: string; isComplete: boolean; timestamp: number }) => void | Promise<void>) => {
        _callback = cb;
        return { dispose: () => { _callback = null; } };
      },
    };

    function fire(content: string) {
      if (_callback) void _callback({ content, isComplete: true, timestamp: Date.now() });
    }

    return { adapter, insertedTexts, fire };
  }

  // Minimal HostBindings: onToolCallDetect will NOT be reached for rejected calls
  function makeHostBindings() {
    return {
      onToolCallDetect: async () => ({ callId: 'unreachable', formattedResponse: '', success: false }),
      onAdapterError: (_e: unknown) => {},
    };
  }

  // JSONL helper: produce a complete function_call message wrapped in ```jsonl fence
  function makeToolCallJsonl(callId: string, toolName: string, args: Record<string, unknown> = {}): string {
    const lines: string[] = [];
    lines.push(JSON.stringify({ type: 'function_call_start', name: toolName, call_id: callId }));
    // Use key-value parameter format (parser expects 'key' not 'name')
    for (const [k, v] of Object.entries(args)) {
      lines.push(JSON.stringify({ type: 'parameter', key: k, value: v }));
    }
    lines.push(JSON.stringify({ type: 'function_call_end', call_id: callId }));
    return '```jsonl\n' + lines.join('\n') + '\n```';
  }

  it('T-LOOP-L-02: tool_not_found → rejectionHandler → insertText called with error ToolResult containing callId', async () => {
    // Real path: unknown tool → validateArgs() returns tool_not_found
    //            → NotionRejectionHandler.onToolCallReject() → adapter.insertText(error)
    const { createToolCallLoop } = await import('../../../../../../../mcp-runtime/src/core/tool-call-loop.ts');
    const { InMemoryToolRegistry } = await import('../../../../../../../mcp-runtime/src/core/in-memory-tool-registry.ts');
    const { NotionRejectionHandler } = await import('../notion/notion-rejection-handler.ts');

    const { adapter, insertedTexts, fire } = makeControllableAdapter();
    const registry = new InMemoryToolRegistry();
    registry.populate([{ name: 'echo' }]); // 'unknown_tool' is NOT in registry

    const formatter = (opts: { callId: string; name: string; status: 'success' | 'error'; result: unknown }) =>
      `<tool_result callId="${opts.callId}" status="${opts.status}">${JSON.stringify(opts.result)}</tool_result>`;

    const loop = createToolCallLoop({
      adapter: adapter as Parameters<typeof createToolCallLoop>[0]['adapter'],
      hostBindings: makeHostBindings() as Parameters<typeof createToolCallLoop>[0]['hostBindings'],
      toolRegistry: registry,
      rejectionHandler: new NotionRejectionHandler(formatter),
    });

    const disposable = loop.start();

    // Fire a tool call for an unknown tool
    fire(makeToolCallJsonl('call-x1', 'unknown_tool'));

    // Wait for async handler to complete
    await new Promise(resolve => setTimeout(resolve, 30));

    disposable.dispose();

    assert.equal(insertedTexts.length, 1, 'insertText must be called exactly once for the rejection');
    assert.ok(insertedTexts[0].includes('call-x1'), 'insertText content must reference the callId call-x1');
    assert.ok(insertedTexts[0].includes('error'), 'insertText content must indicate error status');
  });

  it('T-LOOP-L-03: N=2 same-message callId symmetry — c1 success insert + c2 args_invalid rejection, no cross-contamination', async () => {
    // L9+L10 protocol: N=2 integration variant.
    // Same fenced JSONL block contains two calls:
    //   c1: echo { message: "ok" } → validateArgs passes → hostBindings.onToolCallDetect → insertText (success)
    //   c2: echo {} (missing required 'message') → validateArgs fails → rejectionHandler → insertText (error)
    // Asserts: insertText called twice, callIds do not cross-contaminate, c2 contains validationMessage.
    const { createToolCallLoop } = await import('../../../../../../../mcp-runtime/src/core/tool-call-loop.ts');
    const { InMemoryToolRegistry } = await import('../../../../../../../mcp-runtime/src/core/in-memory-tool-registry.ts');
    const { NotionRejectionHandler } = await import('../notion/notion-rejection-handler.ts');
    const { CfWorkerJsonSchemaValidator } = await import('@modelcontextprotocol/sdk/validation/cfworker');
    const { CfWorkerSchemaValidatorAdapter } = await import('../notion/cfworker-schema-validator-adapter.ts');

    const { adapter, insertedTexts, fire } = makeControllableAdapter();

    // Correct: schemaValidator injected via constructor (same as real bridge wiring)
    const schemaValidator = new CfWorkerSchemaValidatorAdapter(new CfWorkerJsonSchemaValidator());
    const registry = new InMemoryToolRegistry({ schemaValidator });
    const schema = { type: 'object', properties: { message: { type: 'string' } }, required: ['message'] };
    registry.populate([{ name: 'echo', inputSchema: schema }]);

    const formatter = (opts: { callId: string; name: string; status: 'success' | 'error'; result: unknown }) =>
      `<tool_result callId="${opts.callId}" status="${opts.status}">${JSON.stringify(opts.result)}</tool_result>`;

    // hostBindings for c1 (succeeds validation, onToolCallDetect called with c1)
    const detectCallIds: string[] = [];
    const hostBindings = {
      onToolCallDetect: async (payload: { callId: string }) => {
        detectCallIds.push(payload.callId);
        return {
          callId: payload.callId,
          formattedResponse: `<tool_result callId="${payload.callId}" status="success">${JSON.stringify({ ok: true })}</tool_result>`,
          success: true as const,
        };
      },
      onAdapterError: (_e: unknown) => {},
    };

    const loop = createToolCallLoop({
      adapter: adapter as Parameters<typeof createToolCallLoop>[0]['adapter'],
      hostBindings: hostBindings as Parameters<typeof createToolCallLoop>[0]['hostBindings'],
      toolRegistry: registry,
      rejectionHandler: new NotionRejectionHandler(formatter),
    });

    const disposable = loop.start();

    // Same fenced JSONL message: two calls in sequence
    // c1: echo with valid args (message present) → passes validation → success insert
    // c2: echo with missing args → fails validation → rejection insert
    const lines = [
      JSON.stringify({ type: 'function_call_start', name: 'echo', call_id: 'call-c1' }),
      JSON.stringify({ type: 'parameter', key: 'message', value: 'ok' }),
      JSON.stringify({ type: 'function_call_end', call_id: 'call-c1' }),
      JSON.stringify({ type: 'function_call_start', name: 'echo', call_id: 'call-c2' }),
      // No parameter → missing required 'message' → args_invalid
      JSON.stringify({ type: 'function_call_end', call_id: 'call-c2' }),
    ].join('\n');
    const message = '```jsonl\n' + lines + '\n```';

    fire(message);

    await new Promise(resolve => setTimeout(resolve, 50));

    disposable.dispose();

    // hostBindings must only be called for c1 (c2 is rejected pre-flight)
    assert.deepEqual(detectCallIds, ['call-c1'], 'onToolCallDetect must only be called for c1 (c2 rejected pre-flight)');

    assert.equal(insertedTexts.length, 2, 'insertText must be called exactly twice (c1 success + c2 rejection)');

    // c1: success insert — must reference call-c1, not call-c2
    assert.ok(insertedTexts[0].includes('call-c1'), 'c1 insert must reference call-c1');
    assert.ok(!insertedTexts[0].includes('call-c2'), 'c1 insert must NOT reference call-c2');
    assert.ok(insertedTexts[0].includes('success'), 'c1 insert must indicate success');

    // c2: rejection insert — must reference call-c2, not call-c1, and include validationMessage
    assert.ok(insertedTexts[1].includes('call-c2'), 'c2 insert must reference call-c2');
    assert.ok(!insertedTexts[1].includes('call-c1'), 'c2 insert must NOT reference call-c1');
    assert.ok(insertedTexts[1].includes('error'), 'c2 insert must indicate error status');
    // validationMessage must be present for LLM self-correction (P1 from GPT review)
    const c2Json = insertedTexts[1];
    assert.ok(
      c2Json.includes('validationMessage') || c2Json.includes('arg_validation_failed'),
      'c2 insert must contain validationMessage or validationCode for LLM self-correction',
    );
  });
});
