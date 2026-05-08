/**
 * Unit tests for Phase 3: streamToolBridge.ts (production module)
 *
 * Tests the bridge logic between stream_cutoff events and MCP tool execution.
 * Uses mocks for mcpClient, executionGuard, adapter, and storeExecutedFunction.
 *
 * Run: node --test --experimental-strip-types streamToolBridge.test.ts
 * (from render_prescript/src/stream/ directory)
 *
 * This file imports the production .ts module directly — no .mjs duplication.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  createStreamToolHandler,
  getAdapterDiagnostic,
  type AdapterLike,
  type ExecutionGuardLike,
  type McpClientLike,
  type StorageLike,
  type StreamEvent,
  type StreamToolExecutionEvent
} from './streamToolBridge.ts';

// --- Mock infrastructure ---

interface MockMcpClientOptions {
  isReady?: boolean;
  callToolResult?: unknown;
  callToolError?: string | null;
  callToolDelay?: number;
}

function createMockMcpClient(options: MockMcpClientOptions = {}): McpClientLike & { _calls: Array<{ name: string; params: Record<string, unknown> }> } {
  const {
    isReady = true,
    callToolResult = { content: 'tool result' },
    callToolError = null,
    callToolDelay = 0,
  } = options;

  const calls: Array<{ name: string; params: Record<string, unknown> }> = [];
  return {
    isReady: () => isReady,
    callTool: async (name: string, params: Record<string, unknown>) => {
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

interface MockAdapterOptions {
  hasContent?: boolean;
  hasGetInputContent?: boolean;
  insertThrows?: string | null;
  submitThrows?: string | null;
}

function createMockAdapter(options: MockAdapterOptions = {}): AdapterLike & { _calls: { insertText: string[]; submitForm: boolean[] } } {
  const { hasContent = false, hasGetInputContent = true, insertThrows = null, submitThrows = null } = options;
  const calls = { insertText: [] as string[], submitForm: [] as boolean[] };

  const adapter: AdapterLike & { _calls: typeof calls } = {
    insertText: async (text: string) => {
      if (insertThrows) throw new Error(insertThrows);
      calls.insertText.push(text);
    },
    submitForm: async () => {
      if (submitThrows) throw new Error(submitThrows);
      calls.submitForm.push(true);
    },
    _calls: calls,
  };

  if (hasGetInputContent) {
    adapter.getInputContent = () => hasContent ? 'existing user draft' : '';
  }
  // If hasGetInputContent is false, getInputContent is undefined (fail-closed scenario)

  return adapter;
}

interface MockGuardOptions {
  reserveResult?: string | null;
}

function createMockGuard(options: MockGuardOptions = {}): ExecutionGuardLike & { _calls: { reserve: unknown[]; markSucceeded: string[]; markFailed: Array<{ key: string; error?: string }> } } {
  const { reserveResult = 'mock-key-123' } = options;
  const calls = {
    reserve: [] as unknown[],
    markSucceeded: [] as string[],
    markFailed: [] as Array<{ key: string; error?: string }>,
  };
  return {
    reserveExecution: (input) => {
      calls.reserve.push(input);
      return reserveResult;
    },
    executionGuardStore: {
      markSucceeded: (key: string) => { calls.markSucceeded.push(key); },
      markFailed: (key: string, error?: string) => { calls.markFailed.push({ key, error }); },
    },
    _calls: calls,
  };
}

function createMockStorage(): StorageLike & { _calls: Array<{ name: string; callId: string; params: Record<string, unknown>; sig: string }> } {
  const calls: Array<{ name: string; callId: string; params: Record<string, unknown>; sig: string }> = [];
  return {
    storeExecutedFunction: (name, callId, params, sig) => {
      calls.push({ name, callId, params, sig });
    },
    generateContentSignature: (name, params) => {
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

function makeCutoffEvent(overrides: Partial<StreamEvent> = {}): StreamEvent {
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

function makeNonCutoffEvent(): StreamEvent {
  return {
    type: 'stream_end',
    streamId: 'stream-001',
  };
}

// --- Tests ---

describe('streamToolBridge', () => {

  test('1. bridge disabled — event does not trigger execution', async () => {
    const mockClient = createMockMcpClient();
    const mockGuard = createMockGuard();
    const mockAdapter = createMockAdapter();
    const mockStorage = createMockStorage();

    const events: StreamToolExecutionEvent[] = [];
    const handler = createStreamToolHandler({
      config: { enabled: false, autoInsert: true, autoSubmit: false, toolTimeoutMs: 30000 },
      mcpClient: () => mockClient,
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
    const mockClient = createMockMcpClient({ callToolResult: { content: 'search results' } });
    const mockGuard = createMockGuard({ reserveResult: 'key-abc' });
    const mockAdapter = createMockAdapter();
    const mockStorage = createMockStorage();

    const events: StreamToolExecutionEvent[] = [];
    const handler = createStreamToolHandler({
      config: { enabled: true, autoInsert: true, autoSubmit: false, toolTimeoutMs: 30000 },
      mcpClient: () => mockClient,
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
    assert.ok(mockAdapter._calls.insertText[0].includes('<function_result call_id="call_abc123" name="mcp__web_search" status="ok">'));
    assert.ok(mockAdapter._calls.insertText[0].includes('search results'));

    // Verify succeeded event emitted
    const successEvent = events.find(e => e.status === 'succeeded');
    assert.ok(successEvent, 'succeeded event should be emitted');
  });

  test('3. identity.name null — skip execution', async () => {
    const mockClient = createMockMcpClient();
    const mockGuard = createMockGuard();
    const mockStorage = createMockStorage();

    const events: StreamToolExecutionEvent[] = [];
    const handler = createStreamToolHandler({
      config: { enabled: true, autoInsert: true, autoSubmit: false, toolTimeoutMs: 30000 },
      mcpClient: () => mockClient,
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

  test('4. identity.arguments null — treated as empty args, execution proceeds', async () => {
    const mockClient = createMockMcpClient({ callToolResult: { content: 'no-arg result' } });
    const mockGuard = createMockGuard({ reserveResult: 'key-null-args' });
    const mockStorage = createMockStorage();

    const events: StreamToolExecutionEvent[] = [];
    const handler = createStreamToolHandler({
      config: { enabled: true, autoInsert: true, autoSubmit: false, toolTimeoutMs: 30000 },
      mcpClient: () => mockClient,
      guard: mockGuard,
      adapter: () => createMockAdapter(),
      storage: mockStorage,
      onEvent: (evt) => events.push(evt),
    });

    await handler(makeCutoffEvent({ identity: { name: 'get_bridge_info', callId: 'c1', arguments: null } }));

    // Should proceed with empty args
    assert.strictEqual(mockClient._calls.length, 1, 'callTool should be called');
    assert.deepStrictEqual(mockClient._calls[0].params, {}, 'params should be empty object');
    assert.strictEqual(mockGuard._calls.reserve.length, 1);

    const successEvent = events.find(e => e.status === 'succeeded');
    assert.ok(successEvent, 'should emit succeeded event');
  });

  test('5. arguments JSON parse fails — emit failed, guard NOT reserved', async () => {
    const mockClient = createMockMcpClient();
    const mockGuard = createMockGuard();
    const mockStorage = createMockStorage();

    const events: StreamToolExecutionEvent[] = [];
    const handler = createStreamToolHandler({
      config: { enabled: true, autoInsert: true, autoSubmit: false, toolTimeoutMs: 30000 },
      mcpClient: () => mockClient,
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
    const mockClient = createMockMcpClient();
    const mockGuard = createMockGuard({ reserveResult: null });
    const mockStorage = createMockStorage();

    const events: StreamToolExecutionEvent[] = [];
    const handler = createStreamToolHandler({
      config: { enabled: true, autoInsert: true, autoSubmit: false, toolTimeoutMs: 30000 },
      mcpClient: () => mockClient,
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
    const mockGuard = createMockGuard({ reserveResult: 'key-x' });
    const mockStorage = createMockStorage();

    const events: StreamToolExecutionEvent[] = [];
    const handler = createStreamToolHandler({
      config: { enabled: true, autoInsert: true, autoSubmit: false, toolTimeoutMs: 30000 },
      mcpClient: () => null,
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
    const mockClient = createMockMcpClient({ isReady: false });
    const mockGuard = createMockGuard({ reserveResult: 'key-y' });
    const mockStorage = createMockStorage();

    const events: StreamToolExecutionEvent[] = [];
    const handler = createStreamToolHandler({
      config: { enabled: true, autoInsert: true, autoSubmit: false, toolTimeoutMs: 30000 },
      mcpClient: () => mockClient,
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
    const mockClient = createMockMcpClient({ callToolDelay: 500, callToolResult: 'late' });
    const mockGuard = createMockGuard({ reserveResult: 'key-timeout' });
    const mockStorage = createMockStorage();

    const events: StreamToolExecutionEvent[] = [];
    const handler = createStreamToolHandler({
      config: { enabled: true, autoInsert: true, autoSubmit: false, toolTimeoutMs: 50 },
      mcpClient: () => mockClient,
      guard: mockGuard,
      adapter: () => createMockAdapter(),
      storage: mockStorage,
      onEvent: (evt) => events.push(evt),
    });

    await handler(makeCutoffEvent());

    assert.strictEqual(mockGuard._calls.markFailed.length, 1);
    assert.strictEqual(mockGuard._calls.markFailed[0].key, 'key-timeout');
    assert.ok(mockGuard._calls.markFailed[0].error!.includes('timeout'), 'error should mention timeout');

    const failEvent = events.find(e => e.status === 'failed');
    assert.ok(failEvent);
    assert.strictEqual(failEvent.phase, 'tool_call');
    assert.strictEqual(failEvent.errorCode, 'TIMEOUT');
  });

  test('10. late result after timeout — ignored (no inject, no markSucceeded)', async () => {
    const mockClient = createMockMcpClient({ callToolDelay: 100, callToolResult: 'late result' });
    const mockGuard = createMockGuard({ reserveResult: 'key-late' });
    const mockAdapter = createMockAdapter();
    const mockStorage = createMockStorage();

    const events: StreamToolExecutionEvent[] = [];
    const handler = createStreamToolHandler({
      config: { enabled: true, autoInsert: true, autoSubmit: false, toolTimeoutMs: 20 },
      mcpClient: () => mockClient,
      guard: mockGuard,
      adapter: () => mockAdapter,
      storage: mockStorage,
      onEvent: (evt) => events.push(evt),
    });

    await handler(makeCutoffEvent());

    // Wait for the late result to resolve
    await new Promise(r => setTimeout(r, 150));

    assert.strictEqual(mockGuard._calls.markSucceeded.length, 0, 'late result must NOT markSucceeded');
    assert.strictEqual(mockAdapter._calls.insertText.length, 0, 'late result must NOT insert');
    assert.strictEqual(mockStorage._calls.length, 0, 'late result must NOT store');
  });

  test('11. callTool returns error — emit failed + markFailed', async () => {
    const mockClient = createMockMcpClient({ callToolError: 'Server unavailable' });
    const mockGuard = createMockGuard({ reserveResult: 'key-err' });
    const mockAdapter = createMockAdapter();
    const mockStorage = createMockStorage();

    const events: StreamToolExecutionEvent[] = [];
    const handler = createStreamToolHandler({
      config: { enabled: true, autoInsert: true, autoSubmit: false, toolTimeoutMs: 30000 },
      mcpClient: () => mockClient,
      guard: mockGuard,
      adapter: () => mockAdapter,
      storage: mockStorage,
      onEvent: (evt) => events.push(evt),
    });

    await handler(makeCutoffEvent());

    assert.strictEqual(mockGuard._calls.markFailed.length, 1);
    assert.strictEqual(mockGuard._calls.markFailed[0].key, 'key-err');
    assert.ok(mockGuard._calls.markFailed[0].error!.includes('Server unavailable'));

    assert.strictEqual(mockGuard._calls.markSucceeded.length, 0);
    assert.strictEqual(mockAdapter._calls.insertText.length, 0, 'should NOT insert on error');
    assert.strictEqual(mockStorage._calls.length, 0, 'should NOT store on error');

    const failEvent = events.find(e => e.status === 'failed');
    assert.ok(failEvent);
    assert.strictEqual(failEvent.phase, 'tool_call');
  });

  test('12. autoInsert=true — result inserted via adapter.insertText', async () => {
    const mockClient = createMockMcpClient({ callToolResult: { data: 'hello' } });
    const mockGuard = createMockGuard({ reserveResult: 'key-ins' });
    const mockAdapter = createMockAdapter();
    const mockStorage = createMockStorage();

    const events: StreamToolExecutionEvent[] = [];
    const handler = createStreamToolHandler({
      config: { enabled: true, autoInsert: true, autoSubmit: false, toolTimeoutMs: 30000 },
      mcpClient: () => mockClient,
      guard: mockGuard,
      adapter: () => mockAdapter,
      storage: mockStorage,
      onEvent: (evt) => events.push(evt),
    });

    await handler(makeCutoffEvent());

    assert.strictEqual(mockAdapter._calls.insertText.length, 1);
    const inserted = mockAdapter._calls.insertText[0];
    assert.ok(inserted.startsWith('<function_result call_id="call_abc123" name="mcp__web_search" status="ok">'));
    assert.ok(inserted.endsWith('</function_result>'));
    assert.strictEqual(mockAdapter._calls.submitForm.length, 0, 'submitForm should NOT be called');
  });

  test('13. autoInsert=true + user has existing draft — skip insert', async () => {
    const mockClient = createMockMcpClient({ callToolResult: 'result' });
    const mockGuard = createMockGuard({ reserveResult: 'key-draft' });
    const mockAdapter = createMockAdapter({ hasContent: true });
    const mockStorage = createMockStorage();

    const events: StreamToolExecutionEvent[] = [];
    const handler = createStreamToolHandler({
      config: { enabled: true, autoInsert: true, autoSubmit: false, toolTimeoutMs: 30000 },
      mcpClient: () => mockClient,
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

    // Event should still indicate success
    const successEvent = events.find(e => e.status === 'succeeded');
    assert.ok(successEvent);
  });

  test('14. autoSubmit=true — adapter.submitForm called after insert', async () => {
    const mockClient = createMockMcpClient({ callToolResult: 'result' });
    const mockGuard = createMockGuard({ reserveResult: 'key-submit' });
    const mockAdapter = createMockAdapter();
    const mockStorage = createMockStorage();

    const events: StreamToolExecutionEvent[] = [];
    const handler = createStreamToolHandler({
      config: { enabled: true, autoInsert: true, autoSubmit: true, toolTimeoutMs: 30000 },
      mcpClient: () => mockClient,
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
    const mockClient = createMockMcpClient();
    const mockGuard = createMockGuard();
    const mockStorage = createMockStorage();

    const events: StreamToolExecutionEvent[] = [];
    const handler = createStreamToolHandler({
      config: { enabled: true, autoInsert: true, autoSubmit: false, toolTimeoutMs: 30000 },
      mcpClient: () => mockClient,
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

    const events: StreamToolExecutionEvent[] = [];
    const handler = createStreamToolHandler({
      config: { enabled: true, autoInsert: true, autoSubmit: false, toolTimeoutMs: 30000 },
      mcpClient: () => mockClient,
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
    const mockClient = createMockMcpClient({ callToolResult: 'persisted' });
    const mockGuard = createMockGuard({ reserveResult: 'key-persist' });
    const mockAdapter = createMockAdapter();
    const mockStorage = createMockStorage();

    const events: StreamToolExecutionEvent[] = [];
    const handler = createStreamToolHandler({
      config: { enabled: true, autoInsert: true, autoSubmit: false, toolTimeoutMs: 30000 },
      mcpClient: () => mockClient,
      guard: mockGuard,
      adapter: () => mockAdapter,
      storage: mockStorage,
      onEvent: (evt) => events.push(evt),
    });

    await handler(makeCutoffEvent());

    assert.strictEqual(mockStorage._calls.length, 1);
    const stored = mockStorage._calls[0];
    assert.strictEqual(stored.name, 'mcp__web_search');
    assert.strictEqual(stored.callId, 'call_abc123');
    assert.deepStrictEqual(stored.params, { query: 'test search' });
    assert.strictEqual(typeof stored.sig, 'string');
    assert.ok(stored.sig.length > 0, 'signature should be non-empty');
  });

  // --- NEW: P0-3 fail-closed test ---
  test('18. getInputContent not available — fail-closed, skip insert', async () => {
    const mockClient = createMockMcpClient({ callToolResult: 'result' });
    const mockGuard = createMockGuard({ reserveResult: 'key-fc' });
    const mockAdapter = createMockAdapter({ hasGetInputContent: false }); // no getInputContent method
    const mockStorage = createMockStorage();

    const events: StreamToolExecutionEvent[] = [];
    const handler = createStreamToolHandler({
      config: { enabled: true, autoInsert: true, autoSubmit: false, toolTimeoutMs: 30000 },
      mcpClient: () => mockClient,
      guard: mockGuard,
      adapter: () => mockAdapter,
      storage: mockStorage,
      onEvent: (evt) => events.push(evt),
    });

    await handler(makeCutoffEvent());

    // Tool should execute and succeed
    assert.strictEqual(mockGuard._calls.markSucceeded.length, 1);
    assert.strictEqual(mockStorage._calls.length, 1);

    // But insert should be skipped (fail-closed)
    assert.strictEqual(mockAdapter._calls.insertText.length, 0, 'should NOT insert when cannot inspect input');

    // Event should still indicate succeeded (with errorCode about skipped insert)
    const successEvent = events.find(e => e.status === 'succeeded');
    assert.ok(successEvent);
    assert.strictEqual(successEvent.errorCode, 'INSERT_SKIPPED_NO_INSPECT');
  });

  // --- NEW: P0-4 insertText throws ---
  test('19. insertText throws — emit failed with phase=inject', async () => {
    const mockClient = createMockMcpClient({ callToolResult: 'result' });
    const mockGuard = createMockGuard({ reserveResult: 'key-if' });
    const mockAdapter = createMockAdapter({ insertThrows: 'DOM element detached' });
    const mockStorage = createMockStorage();

    const events: StreamToolExecutionEvent[] = [];
    const handler = createStreamToolHandler({
      config: { enabled: true, autoInsert: true, autoSubmit: false, toolTimeoutMs: 30000 },
      mcpClient: () => mockClient,
      guard: mockGuard,
      adapter: () => mockAdapter,
      storage: mockStorage,
      onEvent: (evt) => events.push(evt),
    });

    await handler(makeCutoffEvent());

    const failEvent = events.find(e => e.status === 'failed' && e.phase === 'inject');
    assert.ok(failEvent, 'should emit failed event with phase=inject');
    assert.strictEqual(failEvent.errorCode, 'INSERT_FAILED');
    assert.ok(failEvent.error!.includes('DOM element detached'));
  });

  // --- NEW: P0-4 submitForm throws ---
  test('20. submitForm throws — emit failed with phase=submit', async () => {
    const mockClient = createMockMcpClient({ callToolResult: 'result' });
    const mockGuard = createMockGuard({ reserveResult: 'key-sf' });
    const mockAdapter = createMockAdapter({ submitThrows: 'Network timeout' });
    const mockStorage = createMockStorage();

    const events: StreamToolExecutionEvent[] = [];
    const handler = createStreamToolHandler({
      config: { enabled: true, autoInsert: true, autoSubmit: true, toolTimeoutMs: 30000 },
      mcpClient: () => mockClient,
      guard: mockGuard,
      adapter: () => mockAdapter,
      storage: mockStorage,
      onEvent: (evt) => events.push(evt),
    });

    await handler(makeCutoffEvent());

    const failEvent = events.find(e => e.status === 'failed' && e.phase === 'submit');
    assert.ok(failEvent, 'should emit failed event with phase=submit');
    assert.strictEqual(failEvent.errorCode, 'SUBMIT_FAILED');
    assert.ok(failEvent.error!.includes('Network timeout'));
  });

  // --- NEW: P1 adapter() returns null ---
  test('21. adapter returns null — emit failed with ADAPTER_MISSING', async () => {
    const mockClient = createMockMcpClient({ callToolResult: 'result' });
    const mockGuard = createMockGuard({ reserveResult: 'key-an' });
    const mockStorage = createMockStorage();

    const events: StreamToolExecutionEvent[] = [];
    const handler = createStreamToolHandler({
      config: { enabled: true, autoInsert: true, autoSubmit: false, toolTimeoutMs: 30000 },
      mcpClient: () => mockClient,
      guard: mockGuard,
      adapter: () => null, // no adapter available
      storage: mockStorage,
      onEvent: (evt) => events.push(evt),
    });

    await handler(makeCutoffEvent());

    // Tool executed and succeeded in guard
    assert.strictEqual(mockGuard._calls.markSucceeded.length, 1);

    const failEvent = events.find(e => e.status === 'failed' && e.phase === 'inject');
    assert.ok(failEvent, 'should emit failed event with phase=inject');
    assert.strictEqual(failEvent.errorCode, 'ADAPTER_MISSING');
  });

  // --- Phase 3 consensus additions (Opus + GPT PR #5) ---

  test('22. cutoff mode (cancel vs drain-drop) does not affect execution behavior', async () => {
    // streamToolBridge should behave identically regardless of how MAIN world handled the stream.
    // cutoff mode is a transport concern; execution behavior must be independent.
    const mockClient = createMockMcpClient({ callToolResult: 'tool-result' });
    const mockStorage = createMockStorage();
    const events: StreamToolExecutionEvent[] = [];

    // Test with cancel mode
    const mockGuard1 = createMockGuard({ reserveResult: 'key-cancel' });
    const handler1 = createStreamToolHandler({
      config: { enabled: true, autoInsert: false, autoSubmit: false, toolTimeoutMs: 30000 },
      mcpClient: () => mockClient,
      guard: mockGuard1,
      adapter: () => null,
      storage: mockStorage,
      onEvent: (evt) => events.push(evt),
    });

    const cancelEvent: StreamEvent = {
      type: 'stream_cutoff',
      streamId: 'stream-cancel',
      identity: { name: 'echo', callId: 'call-cancel', arguments: '{"msg":"hello"}' },
      mode: 'cancel',
    } as StreamEvent & { mode: string };
    await handler1(cancelEvent);

    // Test with drain-drop mode (same identity but different streamId)
    const mockGuard2 = createMockGuard({ reserveResult: 'key-drain' });
    const events2: StreamToolExecutionEvent[] = [];
    const handler2 = createStreamToolHandler({
      config: { enabled: true, autoInsert: false, autoSubmit: false, toolTimeoutMs: 30000 },
      mcpClient: () => mockClient,
      guard: mockGuard2,
      adapter: () => null,
      storage: mockStorage,
      onEvent: (evt) => events2.push(evt),
    });

    const drainEvent: StreamEvent = {
      type: 'stream_cutoff',
      streamId: 'stream-drain',
      identity: { name: 'echo', callId: 'call-drain', arguments: '{"msg":"hello"}' },
      mode: 'drain-drop',
    } as StreamEvent & { mode: string };
    await handler2(drainEvent);

    // Both should succeed with same tool call behavior
    const success1 = events.find(e => e.status === 'succeeded');
    const success2 = events2.find(e => e.status === 'succeeded');
    assert.ok(success1, 'cancel mode should succeed');
    assert.ok(success2, 'drain-drop mode should succeed');
    assert.strictEqual(mockGuard1._calls.markSucceeded.length, 1);
    assert.strictEqual(mockGuard2._calls.markSucceeded.length, 1);
  });

  test('23. executionGuard lifecycle: reserve → execute → markSucceeded on success', async () => {
    const mockClient = createMockMcpClient({ callToolResult: 'ok' });
    const mockGuard = createMockGuard({ reserveResult: 'lifecycle-key' });
    const mockStorage = createMockStorage();
    const events: StreamToolExecutionEvent[] = [];

    const handler = createStreamToolHandler({
      config: { enabled: true, autoInsert: false, autoSubmit: false, toolTimeoutMs: 30000 },
      mcpClient: () => mockClient,
      guard: mockGuard,
      adapter: () => null,
      storage: mockStorage,
      onEvent: (evt) => events.push(evt),
    });

    await handler(makeCutoffEvent());

    // Verify full lifecycle
    assert.strictEqual(mockGuard._calls.reserve.length, 1, 'should reserve once');
    assert.strictEqual(mockGuard._calls.markSucceeded.length, 1, 'should mark succeeded');
    assert.strictEqual(mockGuard._calls.markSucceeded[0], 'lifecycle-key');
    assert.strictEqual(mockGuard._calls.markFailed.length, 0, 'should not mark failed');
  });

  test('24. executionGuard lifecycle: reserve → execute → markFailed on tool error', async () => {
    const mockClient = createMockMcpClient({ callToolError: new Error('tool crashed') });
    const mockGuard = createMockGuard({ reserveResult: 'fail-key' });
    const mockStorage = createMockStorage();
    const events: StreamToolExecutionEvent[] = [];

    const handler = createStreamToolHandler({
      config: { enabled: true, autoInsert: false, autoSubmit: false, toolTimeoutMs: 30000 },
      mcpClient: () => mockClient,
      guard: mockGuard,
      adapter: () => null,
      storage: mockStorage,
      onEvent: (evt) => events.push(evt),
    });

    await handler(makeCutoffEvent());

    // Verify failure lifecycle
    assert.strictEqual(mockGuard._calls.reserve.length, 1, 'should reserve once');
    assert.strictEqual(mockGuard._calls.markSucceeded.length, 0, 'should not mark succeeded');
    assert.strictEqual(mockGuard._calls.markFailed.length, 1, 'should mark failed');
    assert.strictEqual(mockGuard._calls.markFailed[0].key, 'fail-key');
    assert.ok(mockGuard._calls.markFailed[0].error!.includes('tool crashed'));
  });

  // --- Gate 3B: Parameter validation (type checking + size limits) ---

  test('25. arguments=\'[]\' (array) — reject with ARGS_NOT_OBJECT before reserve', async () => {
    const mockClient = createMockMcpClient();
    const mockGuard = createMockGuard();
    const mockStorage = createMockStorage();
    const events: StreamToolExecutionEvent[] = [];

    const handler = createStreamToolHandler({
      config: { enabled: true, autoInsert: false, autoSubmit: false, toolTimeoutMs: 30000 },
      mcpClient: () => mockClient,
      guard: mockGuard,
      adapter: () => null,
      storage: mockStorage,
      onEvent: (evt) => events.push(evt),
    });

    await handler(makeCutoffEvent({ identity: { name: 'tool', callId: 'c1', arguments: '[]' } }));

    assert.strictEqual(mockClient._calls.length, 0);
    assert.strictEqual(mockGuard._calls.reserve.length, 0, 'reserve should NOT be called');
    const failEvent = events.find(e => e.status === 'failed');
    assert.ok(failEvent);
    assert.strictEqual(failEvent.errorCode, 'ARGS_NOT_OBJECT');
    assert.ok(failEvent.error!.includes('array'));
  });

  test('26. arguments=\'123\' (number) — reject with ARGS_NOT_OBJECT before reserve', async () => {
    const mockClient = createMockMcpClient();
    const mockGuard = createMockGuard();
    const mockStorage = createMockStorage();
    const events: StreamToolExecutionEvent[] = [];

    const handler = createStreamToolHandler({
      config: { enabled: true, autoInsert: false, autoSubmit: false, toolTimeoutMs: 30000 },
      mcpClient: () => mockClient,
      guard: mockGuard,
      adapter: () => null,
      storage: mockStorage,
      onEvent: (evt) => events.push(evt),
    });

    await handler(makeCutoffEvent({ identity: { name: 'tool', callId: 'c2', arguments: '123' } }));

    assert.strictEqual(mockGuard._calls.reserve.length, 0);
    const failEvent = events.find(e => e.status === 'failed');
    assert.ok(failEvent);
    assert.strictEqual(failEvent.errorCode, 'ARGS_NOT_OBJECT');
    assert.ok(failEvent.error!.includes('number'));
  });

  test('27. arguments=\'null\' (JSON null) — reject with ARGS_NOT_OBJECT before reserve', async () => {
    const mockClient = createMockMcpClient();
    const mockGuard = createMockGuard();
    const mockStorage = createMockStorage();
    const events: StreamToolExecutionEvent[] = [];

    const handler = createStreamToolHandler({
      config: { enabled: true, autoInsert: false, autoSubmit: false, toolTimeoutMs: 30000 },
      mcpClient: () => mockClient,
      guard: mockGuard,
      adapter: () => null,
      storage: mockStorage,
      onEvent: (evt) => events.push(evt),
    });

    await handler(makeCutoffEvent({ identity: { name: 'tool', callId: 'c3', arguments: 'null' } }));

    assert.strictEqual(mockGuard._calls.reserve.length, 0);
    const failEvent = events.find(e => e.status === 'failed');
    assert.ok(failEvent);
    assert.strictEqual(failEvent.errorCode, 'ARGS_NOT_OBJECT');
  });

  test('28. arguments=\'"string"\' (JSON string) — reject with ARGS_NOT_OBJECT before reserve', async () => {
    const mockClient = createMockMcpClient();
    const mockGuard = createMockGuard();
    const mockStorage = createMockStorage();
    const events: StreamToolExecutionEvent[] = [];

    const handler = createStreamToolHandler({
      config: { enabled: true, autoInsert: false, autoSubmit: false, toolTimeoutMs: 30000 },
      mcpClient: () => mockClient,
      guard: mockGuard,
      adapter: () => null,
      storage: mockStorage,
      onEvent: (evt) => events.push(evt),
    });

    await handler(makeCutoffEvent({ identity: { name: 'tool', callId: 'c4', arguments: '"hello"' } }));

    assert.strictEqual(mockGuard._calls.reserve.length, 0);
    const failEvent = events.find(e => e.status === 'failed');
    assert.ok(failEvent);
    assert.strictEqual(failEvent.errorCode, 'ARGS_NOT_OBJECT');
  });

  test('29. oversized arguments — reject with ARGS_TOO_LARGE before reserve', async () => {
    const mockClient = createMockMcpClient();
    const mockGuard = createMockGuard();
    const mockStorage = createMockStorage();
    const events: StreamToolExecutionEvent[] = [];

    const handler = createStreamToolHandler({
      config: { enabled: true, autoInsert: false, autoSubmit: false, toolTimeoutMs: 30000 },
      mcpClient: () => mockClient,
      guard: mockGuard,
      adapter: () => null,
      storage: mockStorage,
      onEvent: (evt) => events.push(evt),
    });

    // Create oversized args (> 64KB)
    const bigValue = 'x'.repeat(70_000);
    const oversizedArgs = JSON.stringify({ data: bigValue });
    await handler(makeCutoffEvent({ identity: { name: 'tool', callId: 'c5', arguments: oversizedArgs } }));

    assert.strictEqual(mockGuard._calls.reserve.length, 0, 'reserve should NOT be called for oversized args');
    assert.strictEqual(mockClient._calls.length, 0);
    const failEvent = events.find(e => e.status === 'failed');
    assert.ok(failEvent);
    assert.strictEqual(failEvent.errorCode, 'ARGS_TOO_LARGE');
  });

  test('30. arguments=\'{}\' (empty object string) — treated as empty args, execution proceeds', async () => {
    const mockClient = createMockMcpClient({ callToolResult: 'ok' });
    const mockGuard = createMockGuard({ reserveResult: 'key-empty' });
    const mockStorage = createMockStorage();
    const events: StreamToolExecutionEvent[] = [];

    const handler = createStreamToolHandler({
      config: { enabled: true, autoInsert: false, autoSubmit: false, toolTimeoutMs: 30000 },
      mcpClient: () => mockClient,
      guard: mockGuard,
      adapter: () => null,
      storage: mockStorage,
      onEvent: (evt) => events.push(evt),
    });

    await handler(makeCutoffEvent({ identity: { name: 'echo', callId: 'c6', arguments: '{}' } }));

    assert.strictEqual(mockClient._calls.length, 1);
    assert.deepStrictEqual(mockClient._calls[0].params, {});
    const successEvent = events.find(e => e.status === 'succeeded');
    assert.ok(successEvent);
  });

  test('31. parameterized execution — echo(message=\'hello\') receives correct params', async () => {
    const mockClient = createMockMcpClient({ callToolResult: { echoed: 'hello' } });
    const mockGuard = createMockGuard({ reserveResult: 'key-echo' });
    const mockStorage = createMockStorage();
    const events: StreamToolExecutionEvent[] = [];

    const handler = createStreamToolHandler({
      config: { enabled: true, autoInsert: false, autoSubmit: false, toolTimeoutMs: 30000 },
      mcpClient: () => mockClient,
      guard: mockGuard,
      adapter: () => null,
      storage: mockStorage,
      onEvent: (evt) => events.push(evt),
    });

    await handler(makeCutoffEvent({
      identity: { name: 'echo', callId: 'call-echo-1', arguments: '{"message":"hello"}' },
    }));

    assert.strictEqual(mockClient._calls.length, 1);
    assert.strictEqual(mockClient._calls[0].name, 'echo');
    assert.deepStrictEqual(mockClient._calls[0].params, { message: 'hello' });
    const successEvent = events.find(e => e.status === 'succeeded');
    assert.ok(successEvent);
    assert.deepStrictEqual(successEvent.result, { echoed: 'hello' });
  });

  test('32. complex parameterized execution — nested object params preserved', async () => {
    const mockClient = createMockMcpClient({ callToolResult: 'done' });
    const mockGuard = createMockGuard({ reserveResult: 'key-complex' });
    const mockStorage = createMockStorage();
    const events: StreamToolExecutionEvent[] = [];

    const handler = createStreamToolHandler({
      config: { enabled: true, autoInsert: false, autoSubmit: false, toolTimeoutMs: 30000 },
      mcpClient: () => mockClient,
      guard: mockGuard,
      adapter: () => null,
      storage: mockStorage,
      onEvent: (evt) => events.push(evt),
    });

    const complexArgs = JSON.stringify({
      query: 'test',
      options: { limit: 10, offset: 0 },
      tags: ['a', 'b'],
    });

    await handler(makeCutoffEvent({
      identity: { name: 'search', callId: 'call-complex', arguments: complexArgs },
    }));

    assert.strictEqual(mockClient._calls.length, 1);
    assert.deepStrictEqual(mockClient._calls[0].params, {
      query: 'test',
      options: { limit: 10, offset: 0 },
      tags: ['a', 'b'],
    });
  });

  test('33. arguments=\'"hello"\' (JSON string) → ARGS_NOT_OBJECT rejection', async () => {
    const mockClient = createMockMcpClient({ callToolResult: 'ok' });
    const mockGuard = createMockGuard({ reserveResult: 'key-str' });
    const mockStorage = createMockStorage();
    const events: StreamToolExecutionEvent[] = [];

    const handler = createStreamToolHandler({
      config: { enabled: true, autoInsert: false, autoSubmit: false, toolTimeoutMs: 30000 },
      mcpClient: () => mockClient,
      guard: mockGuard,
      adapter: () => null,
      storage: mockStorage,
      onEvent: (evt) => events.push(evt),
    });

    await handler(makeCutoffEvent({ identity: { name: 'tool', callId: 'c-str', arguments: '"hello"' } }));

    assert.strictEqual(mockClient._calls.length, 0);
    assert.strictEqual(mockGuard._calls.reserve.length, 0);
    const failEvent = events.find(e => e.status === 'failed');
    assert.ok(failEvent);
    assert.strictEqual(failEvent.errorCode, 'ARGS_NOT_OBJECT');
  });

  test('34. arguments=\'null\' (JSON null literal) → ARGS_NOT_OBJECT rejection', async () => {
    const mockClient = createMockMcpClient({ callToolResult: 'ok' });
    const mockGuard = createMockGuard({ reserveResult: 'key-null-str' });
    const mockStorage = createMockStorage();
    const events: StreamToolExecutionEvent[] = [];

    const handler = createStreamToolHandler({
      config: { enabled: true, autoInsert: false, autoSubmit: false, toolTimeoutMs: 30000 },
      mcpClient: () => mockClient,
      guard: mockGuard,
      adapter: () => null,
      storage: mockStorage,
      onEvent: (evt) => events.push(evt),
    });

    await handler(makeCutoffEvent({ identity: { name: 'tool', callId: 'c-null-str', arguments: 'null' } }));

    assert.strictEqual(mockClient._calls.length, 0);
    assert.strictEqual(mockGuard._calls.reserve.length, 0);
    const failEvent = events.find(e => e.status === 'failed');
    assert.ok(failEvent);
    assert.strictEqual(failEvent.errorCode, 'ARGS_NOT_OBJECT');
  });

  test('35. arguments at exactly MAX_ARGS_SIZE boundary → accepted', async () => {
    const mockClient = createMockMcpClient({ callToolResult: 'ok' });
    const mockGuard = createMockGuard({ reserveResult: 'key-boundary' });
    const mockStorage = createMockStorage();
    const events: StreamToolExecutionEvent[] = [];

    const handler = createStreamToolHandler({
      config: { enabled: true, autoInsert: false, autoSubmit: false, toolTimeoutMs: 30000 },
      mcpClient: () => mockClient,
      guard: mockGuard,
      adapter: () => null,
      storage: mockStorage,
      onEvent: (evt) => events.push(evt),
    });

    // Create args exactly at MAX_ARGS_SIZE (65536) code units
    // {"x":"AAA..."} — key "x" takes 5 chars for {"x":"}, closing "} takes 2, value fills the rest
    const overhead = '{"x":"'.length + '"}'.length; // 6 + 2 = 8
    const valueLen = 65_536 - overhead;
    const boundaryArgs = '{"x":"' + 'A'.repeat(valueLen) + '"}';
    assert.strictEqual(boundaryArgs.length, 65_536);

    await handler(makeCutoffEvent({ identity: { name: 'tool', callId: 'c-boundary', arguments: boundaryArgs } }));

    assert.strictEqual(mockClient._calls.length, 1, 'should proceed — not over limit');
    assert.strictEqual(mockClient._calls[0].params.x.length, valueLen);
    const failEvent = events.find(e => e.status === 'failed' && e.errorCode === 'ARGS_TOO_LARGE');
    assert.strictEqual(failEvent, undefined, 'should NOT get ARGS_TOO_LARGE at boundary');
  });

  test('36. arguments at MAX_ARGS_SIZE + 1 → ARGS_TOO_LARGE rejection', async () => {
    const mockClient = createMockMcpClient({ callToolResult: 'ok' });
    const mockGuard = createMockGuard({ reserveResult: 'key-over' });
    const mockStorage = createMockStorage();
    const events: StreamToolExecutionEvent[] = [];

    const handler = createStreamToolHandler({
      config: { enabled: true, autoInsert: false, autoSubmit: false, toolTimeoutMs: 30000 },
      mcpClient: () => mockClient,
      guard: mockGuard,
      adapter: () => null,
      storage: mockStorage,
      onEvent: (evt) => events.push(evt),
    });

    // Create args at MAX_ARGS_SIZE + 1
    const overhead = '{"x":"'.length + '"}'.length; // 8
    const valueLen = 65_536 - overhead + 1;
    const overArgs = '{"x":"' + 'A'.repeat(valueLen) + '"}';
    assert.strictEqual(overArgs.length, 65_537);

    await handler(makeCutoffEvent({ identity: { name: 'tool', callId: 'c-over', arguments: overArgs } }));

    assert.strictEqual(mockClient._calls.length, 0);
    assert.strictEqual(mockGuard._calls.reserve.length, 0);
    const failEvent = events.find(e => e.status === 'failed');
    assert.ok(failEvent);
    assert.strictEqual(failEvent.errorCode, 'ARGS_TOO_LARGE');
  });

  // --- P0-4: circuitBreaker interface reservation tests ---

  test('37. config with circuitBreaker field — handler still works normally', async () => {
    const mockClient = createMockMcpClient({ callToolResult: { content: 'ok' } });
    const mockGuard = createMockGuard({ reserveResult: 'key-cb' });
    const mockAdapter = createMockAdapter();
    const mockStorage = createMockStorage();
    const events: StreamToolExecutionEvent[] = [];

    const handler = createStreamToolHandler({
      config: {
        enabled: true,
        autoInsert: true,
        autoSubmit: false,
        toolTimeoutMs: 30000,
        circuitBreaker: { maxToolCallsPerStream: 10 },
      },
      mcpClient: () => mockClient,
      guard: mockGuard,
      adapter: () => mockAdapter,
      storage: mockStorage,
      onEvent: (evt) => events.push(evt),
    });

    await handler(makeCutoffEvent());

    // Should execute normally — circuitBreaker is reserved, no runtime enforcement
    assert.strictEqual(mockClient._calls.length, 1);
    const successEvent = events.find(e => e.status === 'succeeded');
    assert.ok(successEvent, 'Should succeed with circuitBreaker in config');
  });

  test('38. config with circuitBreaker undefined — backward compatible', async () => {
    const mockClient = createMockMcpClient({ callToolResult: { content: 'ok' } });
    const mockGuard = createMockGuard({ reserveResult: 'key-compat' });
    const mockAdapter = createMockAdapter();
    const mockStorage = createMockStorage();
    const events: StreamToolExecutionEvent[] = [];

    const handler = createStreamToolHandler({
      config: {
        enabled: true,
        autoInsert: true,
        autoSubmit: false,
        toolTimeoutMs: 30000,
        // No circuitBreaker field — should work identically
      },
      mcpClient: () => mockClient,
      guard: mockGuard,
      adapter: () => mockAdapter,
      storage: mockStorage,
      onEvent: (evt) => events.push(evt),
    });

    await handler(makeCutoffEvent());

    assert.strictEqual(mockClient._calls.length, 1);
    const successEvent = events.find(e => e.status === 'succeeded');
    assert.ok(successEvent, 'Should succeed without circuitBreaker in config');
  });

  // --- P0-3: adapter diagnostic tests ---

  test('39. getAdapterDiagnostic — null adapter → input_not_found', () => {
    const diag = getAdapterDiagnostic(null);
    assert.strictEqual(diag.adapterAvailable, false);
    assert.strictEqual(diag.adapterStatus, 'input_not_found');
    assert.strictEqual(diag.inputEmpty, null);
    assert.strictEqual(diag.inputTextLength, null);
  });

  test('40. getAdapterDiagnostic — full adapter, empty input → ok, inputEmpty=true, length=0', () => {
    const adapter: AdapterLike = {
      insertText: async () => {},
      submitForm: async () => {},
      getInputContent: () => '',
    };
    const diag = getAdapterDiagnostic(adapter);
    assert.strictEqual(diag.adapterAvailable, true);
    assert.strictEqual(diag.adapterStatus, 'ok');
    assert.strictEqual(diag.inputEmpty, true);
    assert.strictEqual(diag.inputTextLength, 0);
  });

  test('41. getAdapterDiagnostic — full adapter, input has content → ok, inputEmpty=false', () => {
    const adapter: AdapterLike = {
      insertText: async () => {},
      submitForm: async () => {},
      getInputContent: () => 'user draft text here',
    };
    const diag = getAdapterDiagnostic(adapter);
    assert.strictEqual(diag.adapterAvailable, true);
    assert.strictEqual(diag.adapterStatus, 'ok');
    assert.strictEqual(diag.inputEmpty, false);
    assert.strictEqual(diag.inputTextLength, 20);
  });

  test('42. getAdapterDiagnostic — adapter without getInputContent → ok, input fields null', () => {
    const adapter: AdapterLike = {
      insertText: async () => {},
      submitForm: async () => {},
      // no getInputContent
    };
    const diag = getAdapterDiagnostic(adapter);
    assert.strictEqual(diag.adapterAvailable, true);
    assert.strictEqual(diag.adapterStatus, 'ok');
    assert.strictEqual(diag.inputEmpty, null);
    assert.strictEqual(diag.inputTextLength, null);
  });

  test('43. getAdapterDiagnostic — adapter without submitForm → submit_not_found', () => {
    const adapter: AdapterLike = {
      insertText: async () => {},
      getInputContent: () => 'draft',
      // no submitForm
    };
    const diag = getAdapterDiagnostic(adapter);
    assert.strictEqual(diag.adapterAvailable, true);
    assert.strictEqual(diag.adapterStatus, 'submit_not_found');
    assert.strictEqual(diag.inputEmpty, false);
    assert.strictEqual(diag.inputTextLength, 5);
  });

  test('44. getAdapterDiagnostic — getInputContent throws → input fields null gracefully', () => {
    const adapter: AdapterLike = {
      insertText: async () => {},
      submitForm: async () => {},
      getInputContent: () => { throw new Error('DOM detached'); },
    };
    const diag = getAdapterDiagnostic(adapter);
    assert.strictEqual(diag.adapterAvailable, true);
    assert.strictEqual(diag.adapterStatus, 'ok');
    assert.strictEqual(diag.inputEmpty, null);
    assert.strictEqual(diag.inputTextLength, null);
  });

});
