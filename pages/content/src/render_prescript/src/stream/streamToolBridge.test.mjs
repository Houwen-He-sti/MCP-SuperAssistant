/**
 * Unit tests for Phase 3: streamToolBridge
 *
 * Tests the bridge logic between stream_cutoff events and MCP tool execution.
 * Uses mocks for mcpClient, executionGuard, adapter, and storeExecutedFunction.
 *
 * Run: node streamToolBridge.test.mjs
 * (from render_prescript/src/stream/ directory)
 *
 * TDD: Tests written FIRST — all should FAIL until streamToolBridge.ts is implemented.
 */

import assert from 'node:assert/strict';
import { test, describe, beforeEach, mock } from 'node:test';

// --- Mock infrastructure ---

/** Creates a mock mcpClient with configurable behavior */
function createMockMcpClient(options = {}) {
  const {
    isReady = true,
    callToolResult = { content: 'tool result' },
    callToolError = null,
    callToolDelay = 0,
  } = options;

  const calls = [];
  return {
    isReady: () => isReady,
    callTool: async (name, params) => {
      calls.push({ name, params });
      if (callToolDelay > 0) {
        await new Promise(r => setTimeout(r, callToolDelay));
      }
      if (callToolError) throw new Error(callToolError);
      return callToolResult;
    },
    _calls: calls,
  };
}

/** Creates a mock adapter */
function createMockAdapter(options = {}) {
  const { insertTextResult = true, submitFormResult = true, hasContent = false } = options;
  const calls = { insertText: [], submitForm: [] };
  return {
    insertText: async (text) => {
      calls.insertText.push(text);
      return insertTextResult;
    },
    submitForm: async () => {
      calls.submitForm.push(true);
      return submitFormResult;
    },
    getInputContent: () => hasContent ? 'existing user draft' : '',
    capabilities: ['text-insertion', 'form-submission'],
    _calls: calls,
  };
}

/** Creates mock executionGuard functions */
function createMockGuard(options = {}) {
  const { reserveResult = 'mock-key-123' } = options;
  const calls = { reserve: [], markSucceeded: [], markFailed: [] };
  return {
    reserveExecution: (input) => {
      calls.reserve.push(input);
      return reserveResult;
    },
    executionGuardStore: {
      markSucceeded: (key) => { calls.markSucceeded.push(key); },
      markFailed: (key, error) => { calls.markFailed.push({ key, error }); },
    },
    _calls: calls,
  };
}

/** Creates mock storeExecutedFunction */
function createMockStorage() {
  const calls = [];
  return {
    storeExecutedFunction: (name, callId, params, sig) => {
      calls.push({ name, callId, params, sig });
      return { functionName: name, callId, params, contentSignature: sig, executedAt: Date.now() };
    },
    generateContentSignature: (name, params) => {
      // Simple deterministic mock hash
      const content = JSON.stringify({ name, params });
      let hash = 0;
      for (let i = 0; i < content.length; i++) {
        hash = (hash << 5) - hash + content.charCodeAt(i);
        hash = hash & hash;
      }
      return hash.toString(16);
    },
    _calls: calls,
  };
}

// --- Test event helpers ---

function makeCutoffEvent(overrides = {}) {
  return {
    type: 'stream_cutoff',
    streamId: 'stream-001',
    identity: {
      name: 'mcp__web_search',
      callId: 'call_abc123',
      arguments: '{"query":"test search"}',
    },
    ...overrides,
  };
}

function makeNonCutoffEvent() {
  return {
    type: 'stream_end',
    streamId: 'stream-001',
  };
}

// --- StreamToolBridge import ---
// Will fail until implementation exists
let bridge;
try {
  bridge = await import('./streamToolBridge.mjs');
} catch (e) {
  // Expected to fail during TDD red phase
  console.log('⚠️  streamToolBridge.mjs not found — expected during TDD red phase');
  console.log('   All tests will fail with import error.');
  console.log('   Create streamToolBridge.mjs to make tests pass.\n');
  
  // Define a placeholder so tests can at least attempt to run
  bridge = null;
}

// --- Tests ---

describe('streamToolBridge', () => {

  test('1. bridge disabled — event does not trigger execution', async () => {
    assert.ok(bridge, 'streamToolBridge module must be importable');
    
    const mockClient = createMockMcpClient();
    const mockGuard = createMockGuard();
    const mockAdapter = createMockAdapter();
    const mockStorage = createMockStorage();
    
    const events = [];
    const handler = bridge.createStreamToolHandler({
      config: { enabled: false, autoInsert: true, autoSubmit: false, toolTimeoutMs: 30000 },
      mcpClient: mockClient,
      guard: mockGuard,
      adapter: () => mockAdapter,
      storage: mockStorage,
      onEvent: (evt) => events.push(evt),
    });
    
    await handler(makeCutoffEvent());
    
    assert.strictEqual(mockClient._calls.length, 0, 'callTool should not be called when disabled');
    assert.strictEqual(mockGuard._calls.reserve.length, 0, 'reserve should not be called when disabled');
  });

  test('2. happy path — cutoff → parse → reserve → execute → succeed → insert', async () => {
    assert.ok(bridge, 'streamToolBridge module must be importable');
    
    const mockClient = createMockMcpClient({ callToolResult: { content: 'search results' } });
    const mockGuard = createMockGuard({ reserveResult: 'key-abc' });
    const mockAdapter = createMockAdapter();
    const mockStorage = createMockStorage();
    
    const events = [];
    const handler = bridge.createStreamToolHandler({
      config: { enabled: true, autoInsert: true, autoSubmit: false, toolTimeoutMs: 30000 },
      mcpClient: mockClient,
      guard: mockGuard,
      adapter: () => mockAdapter,
      storage: mockStorage,
      onEvent: (evt) => events.push(evt),
    });
    
    await handler(makeCutoffEvent());
    
    // Verify execution chain
    assert.strictEqual(mockGuard._calls.reserve.length, 1, 'reserve should be called once');
    assert.deepStrictEqual(mockGuard._calls.reserve[0], {
      functionName: 'mcp__web_search',
      callId: 'call_abc123',
      params: { query: 'test search' },
    });
    
    assert.strictEqual(mockClient._calls.length, 1, 'callTool should be called once');
    assert.strictEqual(mockClient._calls[0].name, 'mcp__web_search');
    assert.deepStrictEqual(mockClient._calls[0].params, { query: 'test search' });
    
    // Verify guard marked succeeded
    assert.strictEqual(mockGuard._calls.markSucceeded.length, 1);
    assert.strictEqual(mockGuard._calls.markSucceeded[0], 'key-abc');
    
    // Verify storeExecutedFunction called
    assert.strictEqual(mockStorage._calls.length, 1);
    assert.strictEqual(mockStorage._calls[0].name, 'mcp__web_search');
    assert.strictEqual(mockStorage._calls[0].callId, 'call_abc123');
    
    // Verify adapter.insertText called with formatted result
    assert.strictEqual(mockAdapter._calls.insertText.length, 1);
    assert.ok(mockAdapter._calls.insertText[0].includes('<function_result call_id="call_abc123">'));
    assert.ok(mockAdapter._calls.insertText[0].includes('search results'));
    
    // Verify succeeded event emitted
    const successEvent = events.find(e => e.status === 'succeeded');
    assert.ok(successEvent, 'succeeded event should be emitted');
    assert.strictEqual(successEvent.phase, undefined); // no phase on success
  });

  test('3. identity.name null — skip execution', async () => {
    assert.ok(bridge, 'streamToolBridge module must be importable');
    
    const mockClient = createMockMcpClient();
    const mockGuard = createMockGuard();
    const mockStorage = createMockStorage();
    
    const events = [];
    const handler = bridge.createStreamToolHandler({
      config: { enabled: true, autoInsert: true, autoSubmit: false, toolTimeoutMs: 30000 },
      mcpClient: mockClient,
      guard: mockGuard,
      adapter: () => createMockAdapter(),
      storage: mockStorage,
      onEvent: (evt) => events.push(evt),
    });
    
    await handler(makeCutoffEvent({ identity: { name: null, callId: 'c1', arguments: '{}' } }));
    
    assert.strictEqual(mockClient._calls.length, 0);
    assert.strictEqual(mockGuard._calls.reserve.length, 0);
    
    const failEvent = events.find(e => e.status === 'failed');
    assert.ok(failEvent, 'failed event should be emitted');
    assert.strictEqual(failEvent.phase, 'identity');
  });

  test('4. identity.arguments null — skip execution', async () => {
    assert.ok(bridge, 'streamToolBridge module must be importable');
    
    const mockClient = createMockMcpClient();
    const mockGuard = createMockGuard();
    const mockStorage = createMockStorage();
    
    const events = [];
    const handler = bridge.createStreamToolHandler({
      config: { enabled: true, autoInsert: true, autoSubmit: false, toolTimeoutMs: 30000 },
      mcpClient: mockClient,
      guard: mockGuard,
      adapter: () => createMockAdapter(),
      storage: mockStorage,
      onEvent: (evt) => events.push(evt),
    });
    
    await handler(makeCutoffEvent({ identity: { name: 'tool', callId: 'c1', arguments: null } }));
    
    assert.strictEqual(mockClient._calls.length, 0);
    assert.strictEqual(mockGuard._calls.reserve.length, 0);
    
    const failEvent = events.find(e => e.status === 'failed');
    assert.ok(failEvent);
    assert.strictEqual(failEvent.phase, 'identity');
  });

  test('5. arguments JSON parse fails — emit failed, guard NOT reserved', async () => {
    assert.ok(bridge, 'streamToolBridge module must be importable');
    
    const mockClient = createMockMcpClient();
    const mockGuard = createMockGuard();
    const mockStorage = createMockStorage();
    
    const events = [];
    const handler = bridge.createStreamToolHandler({
      config: { enabled: true, autoInsert: true, autoSubmit: false, toolTimeoutMs: 30000 },
      mcpClient: mockClient,
      guard: mockGuard,
      adapter: () => createMockAdapter(),
      storage: mockStorage,
      onEvent: (evt) => events.push(evt),
    });
    
    await handler(makeCutoffEvent({ identity: { name: 'tool', callId: 'c1', arguments: 'not-valid-json{{{' } }));
    
    assert.strictEqual(mockClient._calls.length, 0);
    assert.strictEqual(mockGuard._calls.reserve.length, 0, 'reserve should NOT be called if parse fails');
    assert.strictEqual(mockGuard._calls.markFailed.length, 0, 'markFailed should NOT be called (guard never reserved)');
    
    const failEvent = events.find(e => e.status === 'failed');
    assert.ok(failEvent);
    assert.strictEqual(failEvent.phase, 'parse');
  });

  test('6. executionGuard returns null (duplicate) — do not execute', async () => {
    assert.ok(bridge, 'streamToolBridge module must be importable');
    
    const mockClient = createMockMcpClient();
    const mockGuard = createMockGuard({ reserveResult: null }); // blocked
    const mockStorage = createMockStorage();
    
    const events = [];
    const handler = bridge.createStreamToolHandler({
      config: { enabled: true, autoInsert: true, autoSubmit: false, toolTimeoutMs: 30000 },
      mcpClient: mockClient,
      guard: mockGuard,
      adapter: () => createMockAdapter(),
      storage: mockStorage,
      onEvent: (evt) => events.push(evt),
    });
    
    await handler(makeCutoffEvent());
    
    assert.strictEqual(mockClient._calls.length, 0, 'callTool should NOT be called for duplicate');
    assert.strictEqual(mockGuard._calls.reserve.length, 1, 'reserve should be attempted');
    
    const dupEvent = events.find(e => e.status === 'duplicate');
    assert.ok(dupEvent, 'duplicate event should be emitted');
    assert.strictEqual(dupEvent.phase, 'reserve');
  });

  test('7. mcpClient not available — emit failed + markFailed', async () => {
    assert.ok(bridge, 'streamToolBridge module must be importable');
    
    const mockGuard = createMockGuard({ reserveResult: 'key-x' });
    const mockStorage = createMockStorage();
    
    const events = [];
    const handler = bridge.createStreamToolHandler({
      config: { enabled: true, autoInsert: true, autoSubmit: false, toolTimeoutMs: 30000 },
      mcpClient: null, // not available
      guard: mockGuard,
      adapter: () => createMockAdapter(),
      storage: mockStorage,
      onEvent: (evt) => events.push(evt),
    });
    
    await handler(makeCutoffEvent());
    
    assert.strictEqual(mockGuard._calls.markFailed.length, 1);
    assert.strictEqual(mockGuard._calls.markFailed[0].key, 'key-x');
    
    const failEvent = events.find(e => e.status === 'failed');
    assert.ok(failEvent);
    assert.strictEqual(failEvent.phase, 'mcp_client');
  });

  test('8. mcpClient.isReady() false — emit failed + markFailed', async () => {
    assert.ok(bridge, 'streamToolBridge module must be importable');
    
    const mockClient = createMockMcpClient({ isReady: false });
    const mockGuard = createMockGuard({ reserveResult: 'key-y' });
    const mockStorage = createMockStorage();
    
    const events = [];
    const handler = bridge.createStreamToolHandler({
      config: { enabled: true, autoInsert: true, autoSubmit: false, toolTimeoutMs: 30000 },
      mcpClient: mockClient,
      guard: mockGuard,
      adapter: () => createMockAdapter(),
      storage: mockStorage,
      onEvent: (evt) => events.push(evt),
    });
    
    await handler(makeCutoffEvent());
    
    assert.strictEqual(mockClient._calls.length, 0, 'callTool should NOT be called when not ready');
    assert.strictEqual(mockGuard._calls.markFailed.length, 1);
    assert.strictEqual(mockGuard._calls.markFailed[0].key, 'key-y');
    
    const failEvent = events.find(e => e.status === 'failed');
    assert.ok(failEvent);
    assert.strictEqual(failEvent.phase, 'mcp_client');
  });

  test('9. callTool timeout — emit failed + markFailed', async () => {
    assert.ok(bridge, 'streamToolBridge module must be importable');
    
    // callTool takes 500ms, timeout is 50ms
    const mockClient = createMockMcpClient({ callToolDelay: 500, callToolResult: 'late' });
    const mockGuard = createMockGuard({ reserveResult: 'key-timeout' });
    const mockStorage = createMockStorage();
    
    const events = [];
    const handler = bridge.createStreamToolHandler({
      config: { enabled: true, autoInsert: true, autoSubmit: false, toolTimeoutMs: 50 },
      mcpClient: mockClient,
      guard: mockGuard,
      adapter: () => createMockAdapter(),
      storage: mockStorage,
      onEvent: (evt) => events.push(evt),
    });
    
    await handler(makeCutoffEvent());
    
    assert.strictEqual(mockGuard._calls.markFailed.length, 1);
    assert.strictEqual(mockGuard._calls.markFailed[0].key, 'key-timeout');
    assert.ok(mockGuard._calls.markFailed[0].error.includes('timeout'), 'error should mention timeout');
    
    const failEvent = events.find(e => e.status === 'failed');
    assert.ok(failEvent);
    assert.strictEqual(failEvent.phase, 'tool_call');
    assert.ok(failEvent.errorCode === 'TIMEOUT' || failEvent.error.includes('timeout'));
  });

  test('10. late result after timeout — ignored (no inject, no markSucceeded)', async () => {
    assert.ok(bridge, 'streamToolBridge module must be importable');
    
    // callTool takes 100ms, timeout is 20ms
    const mockClient = createMockMcpClient({ callToolDelay: 100, callToolResult: 'late result' });
    const mockGuard = createMockGuard({ reserveResult: 'key-late' });
    const mockAdapter = createMockAdapter();
    const mockStorage = createMockStorage();
    
    const events = [];
    const handler = bridge.createStreamToolHandler({
      config: { enabled: true, autoInsert: true, autoSubmit: false, toolTimeoutMs: 20 },
      mcpClient: mockClient,
      guard: mockGuard,
      adapter: () => mockAdapter,
      storage: mockStorage,
      onEvent: (evt) => events.push(evt),
    });
    
    await handler(makeCutoffEvent());
    
    // Wait for the late result to resolve
    await new Promise(r => setTimeout(r, 150));
    
    // Should NOT have markSucceeded
    assert.strictEqual(mockGuard._calls.markSucceeded.length, 0, 'late result must NOT markSucceeded');
    // Should NOT have inserted
    assert.strictEqual(mockAdapter._calls.insertText.length, 0, 'late result must NOT insert');
    // Should NOT have stored
    assert.strictEqual(mockStorage._calls.length, 0, 'late result must NOT store');
  });

  test('11. callTool returns error — emit failed + markFailed', async () => {
    assert.ok(bridge, 'streamToolBridge module must be importable');
    
    const mockClient = createMockMcpClient({ callToolError: 'Server unavailable' });
    const mockGuard = createMockGuard({ reserveResult: 'key-err' });
    const mockAdapter = createMockAdapter();
    const mockStorage = createMockStorage();
    
    const events = [];
    const handler = bridge.createStreamToolHandler({
      config: { enabled: true, autoInsert: true, autoSubmit: false, toolTimeoutMs: 30000 },
      mcpClient: mockClient,
      guard: mockGuard,
      adapter: () => mockAdapter,
      storage: mockStorage,
      onEvent: (evt) => events.push(evt),
    });
    
    await handler(makeCutoffEvent());
    
    assert.strictEqual(mockGuard._calls.markFailed.length, 1);
    assert.strictEqual(mockGuard._calls.markFailed[0].key, 'key-err');
    assert.ok(mockGuard._calls.markFailed[0].error.includes('Server unavailable'));
    
    assert.strictEqual(mockGuard._calls.markSucceeded.length, 0);
    assert.strictEqual(mockAdapter._calls.insertText.length, 0, 'should NOT insert on error');
    assert.strictEqual(mockStorage._calls.length, 0, 'should NOT store on error');
    
    const failEvent = events.find(e => e.status === 'failed');
    assert.ok(failEvent);
    assert.strictEqual(failEvent.phase, 'tool_call');
  });

  test('12. autoInsert=true — result inserted via adapter.insertText', async () => {
    assert.ok(bridge, 'streamToolBridge module must be importable');
    
    const mockClient = createMockMcpClient({ callToolResult: { data: 'hello' } });
    const mockGuard = createMockGuard({ reserveResult: 'key-ins' });
    const mockAdapter = createMockAdapter();
    const mockStorage = createMockStorage();
    
    const events = [];
    const handler = bridge.createStreamToolHandler({
      config: { enabled: true, autoInsert: true, autoSubmit: false, toolTimeoutMs: 30000 },
      mcpClient: mockClient,
      guard: mockGuard,
      adapter: () => mockAdapter,
      storage: mockStorage,
      onEvent: (evt) => events.push(evt),
    });
    
    await handler(makeCutoffEvent());
    
    assert.strictEqual(mockAdapter._calls.insertText.length, 1);
    const inserted = mockAdapter._calls.insertText[0];
    assert.ok(inserted.startsWith('<function_result call_id="call_abc123">'));
    assert.ok(inserted.endsWith('</function_result>'));
    assert.strictEqual(mockAdapter._calls.submitForm.length, 0, 'submitForm should NOT be called');
  });

  test('13. autoInsert=true + user has existing draft — skip insert', async () => {
    assert.ok(bridge, 'streamToolBridge module must be importable');
    
    const mockClient = createMockMcpClient({ callToolResult: 'result' });
    const mockGuard = createMockGuard({ reserveResult: 'key-draft' });
    const mockAdapter = createMockAdapter({ hasContent: true }); // user has draft
    const mockStorage = createMockStorage();
    
    const events = [];
    const handler = bridge.createStreamToolHandler({
      config: { enabled: true, autoInsert: true, autoSubmit: false, toolTimeoutMs: 30000 },
      mcpClient: mockClient,
      guard: mockGuard,
      adapter: () => mockAdapter,
      storage: mockStorage,
      onEvent: (evt) => events.push(evt),
    });
    
    await handler(makeCutoffEvent());
    
    // Tool should still execute and succeed
    assert.strictEqual(mockGuard._calls.markSucceeded.length, 1);
    assert.strictEqual(mockStorage._calls.length, 1);
    
    // But insert should be skipped
    assert.strictEqual(mockAdapter._calls.insertText.length, 0, 'should NOT insert over user draft');
    
    // Event should indicate inject was skipped
    const successEvent = events.find(e => e.status === 'succeeded');
    assert.ok(successEvent);
  });

  test('14. autoSubmit=true — adapter.submitForm called after insert', async () => {
    assert.ok(bridge, 'streamToolBridge module must be importable');
    
    const mockClient = createMockMcpClient({ callToolResult: 'result' });
    const mockGuard = createMockGuard({ reserveResult: 'key-submit' });
    const mockAdapter = createMockAdapter();
    const mockStorage = createMockStorage();
    
    const events = [];
    const handler = bridge.createStreamToolHandler({
      config: { enabled: true, autoInsert: true, autoSubmit: true, toolTimeoutMs: 30000 },
      mcpClient: mockClient,
      guard: mockGuard,
      adapter: () => mockAdapter,
      storage: mockStorage,
      onEvent: (evt) => events.push(evt),
    });
    
    await handler(makeCutoffEvent());
    
    assert.strictEqual(mockAdapter._calls.insertText.length, 1);
    assert.strictEqual(mockAdapter._calls.submitForm.length, 1, 'submitForm should be called');
  });

  test('15. non-stream_cutoff event — ignored completely', async () => {
    assert.ok(bridge, 'streamToolBridge module must be importable');
    
    const mockClient = createMockMcpClient();
    const mockGuard = createMockGuard();
    const mockStorage = createMockStorage();
    
    const events = [];
    const handler = bridge.createStreamToolHandler({
      config: { enabled: true, autoInsert: true, autoSubmit: false, toolTimeoutMs: 30000 },
      mcpClient: mockClient,
      guard: mockGuard,
      adapter: () => createMockAdapter(),
      storage: mockStorage,
      onEvent: (evt) => events.push(evt),
    });
    
    await handler(makeNonCutoffEvent());
    
    assert.strictEqual(mockClient._calls.length, 0);
    assert.strictEqual(mockGuard._calls.reserve.length, 0);
    assert.strictEqual(events.length, 0, 'no events should be emitted for non-cutoff');
  });

  test('16. rapid consecutive cutoffs — second is duplicate', async () => {
    assert.ok(bridge, 'streamToolBridge module must be importable');
    
    let reserveCallCount = 0;
    const mockClient = createMockMcpClient({ callToolResult: 'result' });
    const mockGuard = createMockGuard();
    // Override: first call returns key, second returns null
    mockGuard.reserveExecution = (input) => {
      mockGuard._calls.reserve.push(input);
      reserveCallCount++;
      return reserveCallCount === 1 ? 'key-first' : null;
    };
    const mockAdapter = createMockAdapter();
    const mockStorage = createMockStorage();
    
    const events = [];
    const handler = bridge.createStreamToolHandler({
      config: { enabled: true, autoInsert: true, autoSubmit: false, toolTimeoutMs: 30000 },
      mcpClient: mockClient,
      guard: mockGuard,
      adapter: () => mockAdapter,
      storage: mockStorage,
      onEvent: (evt) => events.push(evt),
    });
    
    // Fire two cutoff events rapidly
    await Promise.all([
      handler(makeCutoffEvent()),
      handler(makeCutoffEvent()),
    ]);
    
    // Only one should execute
    assert.strictEqual(mockClient._calls.length, 1, 'only first should execute');
    assert.strictEqual(mockGuard._calls.reserve.length, 2, 'both should attempt reserve');
    
    const dupEvent = events.find(e => e.status === 'duplicate');
    assert.ok(dupEvent, 'second should emit duplicate event');
  });

  test('17. success calls storeExecutedFunction for persistent dedup', async () => {
    assert.ok(bridge, 'streamToolBridge module must be importable');
    
    const mockClient = createMockMcpClient({ callToolResult: 'persisted' });
    const mockGuard = createMockGuard({ reserveResult: 'key-persist' });
    const mockAdapter = createMockAdapter();
    const mockStorage = createMockStorage();
    
    const events = [];
    const handler = bridge.createStreamToolHandler({
      config: { enabled: true, autoInsert: true, autoSubmit: false, toolTimeoutMs: 30000 },
      mcpClient: mockClient,
      guard: mockGuard,
      adapter: () => mockAdapter,
      storage: mockStorage,
      onEvent: (evt) => events.push(evt),
    });
    
    await handler(makeCutoffEvent());
    
    // Verify storeExecutedFunction called with correct params
    assert.strictEqual(mockStorage._calls.length, 1);
    const stored = mockStorage._calls[0];
    assert.strictEqual(stored.name, 'mcp__web_search');
    assert.strictEqual(stored.callId, 'call_abc123');
    assert.deepStrictEqual(stored.params, { query: 'test search' });
    assert.strictEqual(typeof stored.sig, 'string');
    assert.ok(stored.sig.length > 0, 'signature should be non-empty');
  });

});

// --- Run summary ---
console.log('\n✅ All 17 test cases defined for streamToolBridge Phase 3');
console.log('   If tests fail with "streamToolBridge module must be importable",');
console.log('   create streamToolBridge.mjs to begin green phase.\n');
