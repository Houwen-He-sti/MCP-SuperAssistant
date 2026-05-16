/**
 * Integration tests for Gate 5: Bridge contract + ACK Tracker wiring.
 *
 * Tests the production cooperation between:
 * - createStreamToolHandler (streamToolBridge.ts)
 * - injectResultIfSafe (streamToolBridge.ts)
 * - createFunctionCallScanner (functionCallScanner.ts)
 * - createAckTracker (ackTracker.ts)
 * - appendAckInstruction / formatFunctionResult (functionResultFormatter.ts)
 *
 * Covers test plan §5.1–5.4, §5.6, §5.8–5.11, §5.15–5.16 (bridge core, safety, scanner).
 *
 * Per testing-strategy.md §5: integration tests are required when
 * production modules call each other through injected dependencies.
 *
 * Run: node --test --experimental-strip-types streamToolBridge.integration.test.ts
 * (from render_prescript/src/stream/ directory)
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  createStreamToolHandler,
  injectResultIfSafe,
  type AdapterLike,
  type ExecutionGuardLike,
  type McpClientLike,
  type StorageLike,
  type StreamToolBridgeConfig,
  type BridgeEvent,
  type StreamToolExecutionEvent,
  type BridgeHandoffAckEvent,
  DEFAULT_MAX_TOOL_CALLS_PER_STREAM,
} from './streamToolBridge.ts';
import {
  createAckTracker,
  type ModelAckEvent,
  type AckTracker,
} from './ackTracker.ts';
import { createFunctionCallScanner } from './functionCallScanner.ts';

// --- Shared mock factories ---

function createMockMcpClient(result: unknown = { data: 'ok' }): McpClientLike {
  return {
    isReady: () => true,
    callTool: async () => result,
  };
}

function createMockGuard(): ExecutionGuardLike & { _reserved: string[] } {
  const reserved: string[] = [];
  let counter = 0;
  return {
    _reserved: reserved,
    reserveExecution: (input) => {
      const key = `key_${counter++}`;
      reserved.push(key);
      return key;
    },
    executionGuardStore: {
      markSucceeded: () => {},
      markFailed: () => {},
    },
  };
}

function createMockStorage(): StorageLike {
  return {
    storeExecutedFunction: () => {},
    generateContentSignature: (name, params) => `sig_${name}_${JSON.stringify(params)}`,
  };
}

function createMockAdapter(opts: { getInputContent?: string | null; insertOk?: boolean; submitOk?: boolean } = {}): () => AdapterLike {
  const { getInputContent = '', insertOk = true, submitOk = true } = opts;
  let insertedText = '';
  return () => ({
    insertText: async (text: string) => {
      insertedText = text;
      return insertOk;
    },
    submitForm: async () => submitOk,
    getInputContent: () => getInputContent,
    _getInsertedText: () => insertedText,
  } as AdapterLike & { _getInsertedText: () => string });
}

function makeConfig(overrides: Partial<StreamToolBridgeConfig> = {}): StreamToolBridgeConfig {
  return {
    enabled: true,
    autoInsert: true,
    autoSubmit: true,
    toolTimeoutMs: 5000,
    ...overrides,
  };
}

// --- Integration: Bridge + ACK Tracker ---

describe('Integration: streamToolBridge + ackTracker', () => {
  test('RESULT_SUBMITTED emits bridge_handoff_ack with nonce and registers in tracker', async () => {
    const bridgeEvents: BridgeEvent[] = [];
    const ackEvents: ModelAckEvent[] = [];

    const ackTracker = createAckTracker({
      timeoutMs: 5000,
      onEvent: (e) => ackEvents.push(e),
    });

    const handler = createStreamToolHandler({
      config: makeConfig(),
      mcpClient: () => createMockMcpClient(),
      guard: createMockGuard(),
      adapter: createMockAdapter(),
      storage: createMockStorage(),
      onEvent: (e) => bridgeEvents.push(e),
      ackTracker,
    });

    await handler({
      type: 'stream_cutoff',
      streamId: 'stream_1',
      identity: { name: 'get_weather', callId: 'call_1', arguments: '{"city":"Tokyo"}' },
    });

    // Should have: executing + succeeded + bridge_handoff_ack
    const handoffAck = bridgeEvents.find(e => e.type === 'bridge_handoff_ack') as BridgeHandoffAckEvent | undefined;
    assert.ok(handoffAck, 'Expected bridge_handoff_ack event');
    assert.equal(handoffAck!.callId, 'call_1');
    assert.equal(handoffAck!.functionName, 'get_weather');
    assert.equal(handoffAck!.outcome, 'RESULT_SUBMITTED');
    assert.ok(handoffAck!.nonce.startsWith('ack_'), `Nonce should start with ack_, got: ${handoffAck!.nonce}`);

    // Nonce should be registered as pending in tracker
    assert.ok(ackTracker.hasPending(handoffAck!.nonce), 'Nonce should be pending in tracker');
    assert.equal(ackTracker.getPendingCount(), 1);

    // Clean up
    ackTracker.dispose();
  });

  test('scanText on next-turn output confirms ACK and emits model_ack_confirmed', async () => {
    const bridgeEvents: BridgeEvent[] = [];
    const ackEvents: ModelAckEvent[] = [];

    const ackTracker = createAckTracker({
      timeoutMs: 5000,
      onEvent: (e) => ackEvents.push(e),
    });

    const handler = createStreamToolHandler({
      config: makeConfig(),
      mcpClient: () => createMockMcpClient(),
      guard: createMockGuard(),
      adapter: createMockAdapter(),
      storage: createMockStorage(),
      onEvent: (e) => bridgeEvents.push(e),
      ackTracker,
    });

    await handler({
      type: 'stream_cutoff',
      streamId: 'stream_2',
      identity: { name: 'search', callId: 'call_2', arguments: '{"q":"test"}' },
    });

    const handoffAck = bridgeEvents.find(e => e.type === 'bridge_handoff_ack') as BridgeHandoffAckEvent;
    assert.ok(handoffAck);
    const nonce = handoffAck.nonce;

    // Simulate next-turn model output containing the nonce
    const modelOutput = `Based on the search results, here are the findings. <mcp_ack nonce="${nonce}" /> The data shows...`;
    ackTracker.scanText(modelOutput);

    // Should have confirmed
    assert.equal(ackEvents.length, 1);
    assert.equal(ackEvents[0].type, 'model_ack_confirmed');
    assert.equal(ackEvents[0].nonce, nonce);
    assert.equal(ackEvents[0].callId, 'call_2');
    assert.equal(ackEvents[0].functionName, 'search');
    assert.ok(!ackTracker.hasPending(nonce), 'Nonce should no longer be pending');

    ackTracker.dispose();
  });

  test('no ackTracker → no bridge_handoff_ack emitted (backward compatible)', async () => {
    const bridgeEvents: BridgeEvent[] = [];

    const handler = createStreamToolHandler({
      config: makeConfig(),
      mcpClient: () => createMockMcpClient(),
      guard: createMockGuard(),
      adapter: createMockAdapter(),
      storage: createMockStorage(),
      onEvent: (e) => bridgeEvents.push(e),
      // No ackTracker
    });

    await handler({
      type: 'stream_cutoff',
      streamId: 'stream_3',
      identity: { name: 'tool_a', callId: 'call_3', arguments: '{}' },
    });

    const handoffAcks = bridgeEvents.filter(e => e.type === 'bridge_handoff_ack');
    assert.equal(handoffAcks.length, 0, 'No handoff ACK without tracker');

    // Should still succeed normally
    const succeeded = bridgeEvents.filter(e => e.type === 'stream_tool_execution' && (e as StreamToolExecutionEvent).status === 'succeeded');
    assert.equal(succeeded.length, 1, 'Should still emit succeeded');
  });

  test('autoSubmit=false → no nonce generated, no ACK event', async () => {
    const bridgeEvents: BridgeEvent[] = [];
    const ackEvents: ModelAckEvent[] = [];

    const ackTracker = createAckTracker({
      timeoutMs: 5000,
      onEvent: (e) => ackEvents.push(e),
    });

    const handler = createStreamToolHandler({
      config: makeConfig({ autoSubmit: false }),
      mcpClient: () => createMockMcpClient(),
      guard: createMockGuard(),
      adapter: createMockAdapter(),
      storage: createMockStorage(),
      onEvent: (e) => bridgeEvents.push(e),
      ackTracker,
    });

    await handler({
      type: 'stream_cutoff',
      streamId: 'stream_4',
      identity: { name: 'tool_b', callId: 'call_4', arguments: '{}' },
    });

    const handoffAcks = bridgeEvents.filter(e => e.type === 'bridge_handoff_ack');
    assert.equal(handoffAcks.length, 0, 'No ACK without autoSubmit');
    assert.equal(ackTracker.getPendingCount(), 0, 'No pending nonces');

    ackTracker.dispose();
  });

  test('nonce appears in injected text via appendAckInstruction', async () => {
    const bridgeEvents: BridgeEvent[] = [];
    const ackEvents: ModelAckEvent[] = [];
    let capturedText = '';

    const ackTracker = createAckTracker({
      timeoutMs: 5000,
      onEvent: (e) => ackEvents.push(e),
    });

    const adapter = (): AdapterLike => ({
      insertText: async (text: string) => {
        capturedText = text;
        return true;
      },
      submitForm: async () => true,
      getInputContent: () => '',
    });

    const handler = createStreamToolHandler({
      config: makeConfig(),
      mcpClient: () => createMockMcpClient({ result: 'sunny, 25°C' }),
      guard: createMockGuard(),
      adapter,
      storage: createMockStorage(),
      onEvent: (e) => bridgeEvents.push(e),
      ackTracker,
    });

    await handler({
      type: 'stream_cutoff',
      streamId: 'stream_5',
      identity: { name: 'get_weather', callId: 'call_5', arguments: '{"city":"Tokyo"}' },
    });

    const handoffAck = bridgeEvents.find(e => e.type === 'bridge_handoff_ack') as BridgeHandoffAckEvent;
    assert.ok(handoffAck);

    // Verify the injected text contains the nonce
    assert.ok(capturedText.includes(handoffAck.nonce), 'Injected text should contain the nonce');
    assert.ok(capturedText.includes('<result_nonce>'), 'Should have result_nonce tag');
    assert.ok(capturedText.includes('<instruction>'), 'Should have instruction tag');
    assert.ok(capturedText.includes('mcp_ack'), 'Should reference mcp_ack in instruction');

    ackTracker.dispose();
  });

  test('multiple tool calls each get independent nonces and ACKs', async () => {
    const bridgeEvents: BridgeEvent[] = [];
    const ackEvents: ModelAckEvent[] = [];

    const ackTracker = createAckTracker({
      timeoutMs: 5000,
      onEvent: (e) => ackEvents.push(e),
    });

    // Need unique guard keys per call
    let guardCounter = 0;
    const guard: ExecutionGuardLike = {
      reserveExecution: () => `key_${guardCounter++}`,
      executionGuardStore: {
        markSucceeded: () => {},
        markFailed: () => {},
      },
    };

    const handler = createStreamToolHandler({
      config: makeConfig(),
      mcpClient: () => createMockMcpClient(),
      guard,
      adapter: createMockAdapter(),
      storage: createMockStorage(),
      onEvent: (e) => bridgeEvents.push(e),
      ackTracker,
    });

    // Execute two tool calls
    await handler({
      type: 'stream_cutoff',
      streamId: 'stream_6',
      identity: { name: 'tool_x', callId: 'call_6a', arguments: '{"a":1}' },
    });
    await handler({
      type: 'stream_cutoff',
      streamId: 'stream_6',
      identity: { name: 'tool_y', callId: 'call_6b', arguments: '{"b":2}' },
    });

    const handoffAcks = bridgeEvents.filter(e => e.type === 'bridge_handoff_ack') as BridgeHandoffAckEvent[];
    assert.equal(handoffAcks.length, 2, 'Should have 2 handoff ACK events');
    assert.notEqual(handoffAcks[0].nonce, handoffAcks[1].nonce, 'Nonces must be unique');
    assert.equal(ackTracker.getPendingCount(), 2, 'Both nonces should be pending');

    // Confirm only the first one
    ackTracker.scanText(`<mcp_ack nonce="${handoffAcks[0].nonce}" />`);
    assert.equal(ackTracker.getPendingCount(), 1, 'One confirmed, one still pending');
    assert.equal(ackEvents.length, 1);
    assert.equal(ackEvents[0].nonce, handoffAcks[0].nonce);

    ackTracker.dispose();
  });

  test('ACK timeout fires after configured delay', async () => {
    const bridgeEvents: BridgeEvent[] = [];
    const ackEvents: ModelAckEvent[] = [];

    const ackTracker = createAckTracker({
      timeoutMs: 50, // short timeout for test
      onEvent: (e) => ackEvents.push(e),
    });

    const handler = createStreamToolHandler({
      config: makeConfig(),
      mcpClient: () => createMockMcpClient(),
      guard: createMockGuard(),
      adapter: createMockAdapter(),
      storage: createMockStorage(),
      onEvent: (e) => bridgeEvents.push(e),
      ackTracker,
    });

    await handler({
      type: 'stream_cutoff',
      streamId: 'stream_7',
      identity: { name: 'slow_tool', callId: 'call_7', arguments: '{}' },
    });

    const handoffAck = bridgeEvents.find(e => e.type === 'bridge_handoff_ack') as BridgeHandoffAckEvent;
    assert.ok(handoffAck);

    // Wait for timeout
    await new Promise(resolve => setTimeout(resolve, 80));

    assert.equal(ackEvents.length, 1);
    assert.equal(ackEvents[0].type, 'model_ack_timeout');
    assert.equal(ackEvents[0].nonce, handoffAck.nonce);
    assert.ok(!ackTracker.hasPending(handoffAck.nonce));

    ackTracker.dispose();
  });
});

// --- §5.1–5.4, §5.8–5.9: Bridge Core Contract ---

describe('Integration: bridge core contract (§5.1–5.4, §5.8–5.9)', () => {
  // --- Tracking helpers ---

  function createTrackingAdapter(opts: {
    insertOk?: boolean | (() => boolean);
    submitOk?: boolean | (() => boolean);
    getInputContent?: string | null;
    insertThrows?: Error;
    submitThrows?: Error;
  } = {}): {
    factory: () => AdapterLike;
    calls: { insertText: string[]; submitForm: number; getInputContent: number };
  } {
    const {
      insertOk = true,
      submitOk = true,
      getInputContent = '',
      insertThrows,
      submitThrows,
    } = opts;
    const calls = { insertText: [] as string[], submitForm: 0, getInputContent: 0 };
    const factory = (): AdapterLike => ({
      insertText: async (text: string) => {
        calls.insertText.push(text);
        if (insertThrows) throw insertThrows;
        return typeof insertOk === 'function' ? insertOk() : insertOk;
      },
      submitForm: async () => {
        calls.submitForm++;
        if (submitThrows) throw submitThrows;
        return typeof submitOk === 'function' ? submitOk() : submitOk;
      },
      getInputContent: () => {
        calls.getInputContent++;
        return getInputContent;
      },
    });
    return { factory, calls };
  }

  function createTrackingMcpClient(opts: {
    result?: unknown;
    throws?: Error;
    ready?: boolean;
  } = {}): { factory: () => McpClientLike; callCount: () => number } {
    const { result = { data: 'ok' }, throws, ready = true } = opts;
    let count = 0;
    const factory = (): McpClientLike => ({
      isReady: () => ready,
      callTool: async () => {
        count++;
        if (throws) throw throws;
        return result;
      },
    });
    return { factory, callCount: () => count };
  }

  function createTrackingGuard(): ExecutionGuardLike & {
    _reserved: string[];
    _succeeded: string[];
    _failed: Array<{ key: string; error?: string }>;
    _sigs: Set<string>;
  } {
    const reserved: string[] = [];
    const succeeded: string[] = [];
    const failed: Array<{ key: string; error?: string }> = [];
    const sigs = new Set<string>();
    let counter = 0;
    return {
      _reserved: reserved,
      _succeeded: succeeded,
      _failed: failed,
      _sigs: sigs,
      reserveExecution: (input) => {
        const sig = `${input.functionName}:${input.callId}`;
        if (sigs.has(sig)) return null; // duplicate
        sigs.add(sig);
        const key = `key_${counter++}`;
        reserved.push(key);
        return key;
      },
      executionGuardStore: {
        markSucceeded: (key) => { succeeded.push(key); },
        markFailed: (key, error) => { failed.push({ key, error }); },
      },
    };
  }

  function createTrackingStorage(): StorageLike & {
    _stored: Array<{ name: string; callId: string; params: Record<string, unknown> }>;
  } {
    const stored: Array<{ name: string; callId: string; params: Record<string, unknown> }> = [];
    return {
      _stored: stored,
      storeExecutedFunction: (name, callId, params) => { stored.push({ name, callId, params }); },
      generateContentSignature: (name, params) => `sig_${name}_${JSON.stringify(params)}`,
    };
  }

  function makeStreamEvent(overrides: Record<string, unknown> = {}) {
    return {
      type: 'stream_cutoff',
      streamId: 'stream_test',
      identity: { name: 'get_weather', callId: 'call_1', arguments: '{"city":"Tokyo"}' },
      ...overrides,
    };
  }

  // §5.1: Success path — tool result inserts and submits
  test('§5.1: success path — callTool → insertText → submitForm → succeeded', async () => {
    const events: BridgeEvent[] = [];
    const mcpClient = createTrackingMcpClient({ result: { temp: '25°C' } });
    const { factory: adapter, calls } = createTrackingAdapter();
    const guard = createTrackingGuard();
    const storage = createTrackingStorage();

    const handler = createStreamToolHandler({
      config: makeConfig(),
      mcpClient: mcpClient.factory,
      guard,
      adapter,
      storage,
      onEvent: (e) => events.push(e),
    });

    await handler(makeStreamEvent());

    // callTool called once
    assert.equal(mcpClient.callCount(), 1, 'callTool should be called exactly once');

    // insertText called with success payload
    assert.equal(calls.insertText.length, 1, 'insertText should be called once');
    assert.ok(calls.insertText[0].includes('function_results'), 'Should contain function_results');
    assert.ok(calls.insertText[0].includes('success'), 'Should contain success status');

    // submitForm called after insertText
    assert.equal(calls.submitForm, 1, 'submitForm should be called once');

    // Evidence: guard marked succeeded
    assert.equal(guard._succeeded.length, 1, 'Guard should mark succeeded');
    assert.equal(guard._failed.length, 0, 'Guard should not mark failed');

    // Evidence: storage recorded
    assert.equal(storage._stored.length, 1);
    assert.equal(storage._stored[0].name, 'get_weather');

    // Event: succeeded emitted
    const succeeded = events.filter(e => e.type === 'stream_tool_execution' && (e as StreamToolExecutionEvent).status === 'succeeded');
    assert.equal(succeeded.length, 1, 'Should emit succeeded event');
  });

  // §5.2: Error path — tool error inserts error result
  test('§5.2: error path — callTool throws → error result injected → failed event', async () => {
    const events: BridgeEvent[] = [];
    const mcpClient = createTrackingMcpClient({ throws: new Error('API rate limit exceeded') });
    const { factory: adapter, calls } = createTrackingAdapter();
    const guard = createTrackingGuard();
    const storage = createTrackingStorage();

    const handler = createStreamToolHandler({
      config: makeConfig(),
      mcpClient: mcpClient.factory,
      guard,
      adapter,
      storage,
      onEvent: (e) => events.push(e),
    });

    await handler(makeStreamEvent());

    // Guard should be marked failed (tool error)
    assert.equal(guard._failed.length, 1, 'Guard should mark failed');
    assert.ok(guard._failed[0].error?.includes('API rate limit'), 'Error message should propagate');

    // Error result should be injected for AI consumption
    assert.equal(calls.insertText.length, 1, 'Should inject error result');
    assert.ok(calls.insertText[0].includes('error'), 'Injected text should indicate error');

    // submitForm should be called (autoSubmit=true)
    assert.equal(calls.submitForm, 1, 'Should submit error result when autoSubmit=true');

    // Failed event with tool_call phase
    const toolCallFailed = events.find(
      e => e.type === 'stream_tool_execution'
        && (e as StreamToolExecutionEvent).status === 'failed'
        && (e as StreamToolExecutionEvent).phase === 'tool_call'
    ) as StreamToolExecutionEvent;
    assert.ok(toolCallFailed, 'Should emit failed event with phase=tool_call');
    assert.equal(toolCallFailed.errorCode, 'TOOL_ERROR');
  });

  // §5.3: insertText returns false — must not submit
  test('§5.3: insertText returns false → submitForm NOT called → INSERT_FAILED', async () => {
    const events: BridgeEvent[] = [];
    const mcpClient = createTrackingMcpClient();
    const { factory: adapter, calls } = createTrackingAdapter({ insertOk: false });
    const guard = createTrackingGuard();

    const handler = createStreamToolHandler({
      config: makeConfig(),
      mcpClient: mcpClient.factory,
      guard,
      adapter,
      storage: createTrackingStorage(),
      onEvent: (e) => events.push(e),
    });

    await handler(makeStreamEvent());

    // insertText was called
    assert.equal(calls.insertText.length, 1, 'insertText should be called');

    // submitForm must NOT be called
    assert.equal(calls.submitForm, 0, 'submitForm must NOT be called when insertText returns false');

    // Should emit failed event with INSERT_FAILED
    const failedEvent = events.find(
      e => e.type === 'stream_tool_execution'
        && (e as StreamToolExecutionEvent).status === 'failed'
        && (e as StreamToolExecutionEvent).errorCode === 'INSERT_FAILED'
    ) as StreamToolExecutionEvent;
    assert.ok(failedEvent, 'Should emit failed event with errorCode INSERT_FAILED');
  });

  // §5.4: insertText throws — must not submit
  test('§5.4: insertText throws → submitForm NOT called → INSERT_FAILED', async () => {
    const events: BridgeEvent[] = [];
    const mcpClient = createTrackingMcpClient();
    const { factory: adapter, calls } = createTrackingAdapter({
      insertThrows: new Error('DOM mutation failed'),
    });
    const guard = createTrackingGuard();

    const handler = createStreamToolHandler({
      config: makeConfig(),
      mcpClient: mcpClient.factory,
      guard,
      adapter,
      storage: createTrackingStorage(),
      onEvent: (e) => events.push(e),
    });

    await handler(makeStreamEvent());

    // insertText was attempted
    assert.equal(calls.insertText.length, 1, 'insertText should be attempted');

    // submitForm must NOT be called
    assert.equal(calls.submitForm, 0, 'submitForm must NOT be called when insertText throws');

    // Should emit failed event with INSERT_FAILED
    const failedEvent = events.find(
      e => e.type === 'stream_tool_execution'
        && (e as StreamToolExecutionEvent).status === 'failed'
        && (e as StreamToolExecutionEvent).errorCode === 'INSERT_FAILED'
    ) as StreamToolExecutionEvent;
    assert.ok(failedEvent, 'Should emit failed event with errorCode INSERT_FAILED');
    assert.ok(failedEvent!.error?.includes('DOM mutation'), 'Error message should propagate');
  });

  // §5.8: submitForm returns false — classify submit failure
  test('§5.8: submitForm returns false → SUBMIT_FAILED classification', async () => {
    const events: BridgeEvent[] = [];
    const mcpClient = createTrackingMcpClient();
    const { factory: adapter, calls } = createTrackingAdapter({ submitOk: false });
    const guard = createTrackingGuard();

    const handler = createStreamToolHandler({
      config: makeConfig(),
      mcpClient: mcpClient.factory,
      guard,
      adapter,
      storage: createTrackingStorage(),
      onEvent: (e) => events.push(e),
    });

    await handler(makeStreamEvent());

    // insertText called and succeeded
    assert.equal(calls.insertText.length, 1);

    // submitForm called but returned false
    assert.equal(calls.submitForm, 1, 'submitForm should be called');

    // Should emit SUBMIT_FAILED
    const failedEvent = events.find(
      e => e.type === 'stream_tool_execution'
        && (e as StreamToolExecutionEvent).status === 'failed'
        && (e as StreamToolExecutionEvent).errorCode === 'SUBMIT_FAILED'
    ) as StreamToolExecutionEvent;
    assert.ok(failedEvent, 'Should emit SUBMIT_FAILED');
    assert.equal(failedEvent.phase, 'submit');
  });

  // §5.9: submitForm throws — classify submit exception
  test('§5.9: submitForm throws → SUBMIT_FAILED with error message', async () => {
    const events: BridgeEvent[] = [];
    const mcpClient = createTrackingMcpClient();
    const { factory: adapter, calls } = createTrackingAdapter({
      submitThrows: new Error('Network timeout'),
    });
    const guard = createTrackingGuard();

    const handler = createStreamToolHandler({
      config: makeConfig(),
      mcpClient: mcpClient.factory,
      guard,
      adapter,
      storage: createTrackingStorage(),
      onEvent: (e) => events.push(e),
    });

    await handler(makeStreamEvent());

    // insertText succeeded
    assert.equal(calls.insertText.length, 1);
    // submitForm was attempted
    assert.equal(calls.submitForm, 1);

    // Should emit SUBMIT_FAILED with the error
    const failedEvent = events.find(
      e => e.type === 'stream_tool_execution'
        && (e as StreamToolExecutionEvent).status === 'failed'
        && (e as StreamToolExecutionEvent).errorCode === 'SUBMIT_FAILED'
    ) as StreamToolExecutionEvent;
    assert.ok(failedEvent, 'Should emit SUBMIT_FAILED');
    assert.ok(failedEvent.error?.includes('Network timeout'), 'Error message should propagate');
  });
});

// --- §5.6: getInputContent missing — fail-closed behavior ---

describe('Integration: getInputContent missing — fail-closed (§5.6)', () => {
  test('§5.6: adapter without getInputContent → INJECT_SKIPPED_NO_INSPECT', async () => {
    const events: BridgeEvent[] = [];

    // Adapter without getInputContent
    const adapterCalls = { insertText: 0, submitForm: 0 };
    const adapterFactory = (): AdapterLike => ({
      insertText: async () => { adapterCalls.insertText++; return true; },
      submitForm: async () => { adapterCalls.submitForm++; return true; },
      // getInputContent intentionally omitted
    });

    let guardCounter = 0;
    const handler = createStreamToolHandler({
      config: makeConfig(),
      mcpClient: () => ({ isReady: () => true, callTool: async () => 'ok' }),
      guard: {
        reserveExecution: () => `key_${guardCounter++}`,
        executionGuardStore: { markSucceeded: () => {}, markFailed: () => {} },
      },
      adapter: adapterFactory,
      storage: createMockStorage(),
      onEvent: (e) => events.push(e),
    });

    await handler({
      type: 'stream_cutoff',
      streamId: 'stream_6',
      identity: { name: 'tool_a', callId: 'call_6', arguments: '{}' },
    });

    // insertText and submitForm should NOT be called — fail-closed
    assert.equal(adapterCalls.insertText, 0, 'insertText should not be called without getInputContent');
    assert.equal(adapterCalls.submitForm, 0, 'submitForm should not be called without getInputContent');

    // Should still emit succeeded (tool worked, injection skipped)
    const succeeded = events.find(
      e => e.type === 'stream_tool_execution'
        && (e as StreamToolExecutionEvent).status === 'succeeded'
        && (e as StreamToolExecutionEvent).errorCode === 'INSERT_SKIPPED_NO_INSPECT'
    ) as StreamToolExecutionEvent;
    assert.ok(succeeded, 'Should emit succeeded with INSERT_SKIPPED_NO_INSPECT');
  });

  test('§5.6b: getInputContent returns null → INJECT_SKIPPED_NO_INSPECT', async () => {
    const events: BridgeEvent[] = [];
    const adapterCalls = { insertText: 0, submitForm: 0 };
    const adapterFactory = (): AdapterLike => ({
      insertText: async () => { adapterCalls.insertText++; return true; },
      submitForm: async () => { adapterCalls.submitForm++; return true; },
      getInputContent: () => null,
    });

    let guardCounter = 0;
    const handler = createStreamToolHandler({
      config: makeConfig(),
      mcpClient: () => ({ isReady: () => true, callTool: async () => 'ok' }),
      guard: {
        reserveExecution: () => `key_${guardCounter++}`,
        executionGuardStore: { markSucceeded: () => {}, markFailed: () => {} },
      },
      adapter: adapterFactory,
      storage: createMockStorage(),
      onEvent: (e) => events.push(e),
    });

    await handler({
      type: 'stream_cutoff',
      streamId: 'stream_6b',
      identity: { name: 'tool_a', callId: 'call_6b', arguments: '{}' },
    });

    assert.equal(adapterCalls.insertText, 0, 'insertText should not be called when getInputContent returns null');
    assert.equal(adapterCalls.submitForm, 0, 'submitForm should not be called');
  });

  test('§5.6c: getInputContent has draft text → INJECT_SKIPPED_DRAFT', async () => {
    const events: BridgeEvent[] = [];
    const adapterCalls = { insertText: 0, submitForm: 0 };
    const adapterFactory = (): AdapterLike => ({
      insertText: async () => { adapterCalls.insertText++; return true; },
      submitForm: async () => { adapterCalls.submitForm++; return true; },
      getInputContent: () => 'user is typing something...',
    });

    let guardCounter = 0;
    const handler = createStreamToolHandler({
      config: makeConfig(),
      mcpClient: () => ({ isReady: () => true, callTool: async () => 'ok' }),
      guard: {
        reserveExecution: () => `key_${guardCounter++}`,
        executionGuardStore: { markSucceeded: () => {}, markFailed: () => {} },
      },
      adapter: adapterFactory,
      storage: createMockStorage(),
      onEvent: (e) => events.push(e),
    });

    await handler({
      type: 'stream_cutoff',
      streamId: 'stream_6c',
      identity: { name: 'tool_a', callId: 'call_6c', arguments: '{}' },
    });

    assert.equal(adapterCalls.insertText, 0, 'insertText should not overwrite user draft');
    assert.equal(adapterCalls.submitForm, 0, 'submitForm should not be called');

    // Succeeded (tool worked, but injection skipped due to draft)
    const succeeded = events.find(
      e => e.type === 'stream_tool_execution' && (e as StreamToolExecutionEvent).status === 'succeeded'
    );
    assert.ok(succeeded, 'Should still emit succeeded');
  });
});

// --- §5.10: Duplicate execution guard ---

describe('Integration: execution guard deduplication (§5.10)', () => {
  test('§5.10: same callId twice → first executes, second is duplicate', async () => {
    const events: BridgeEvent[] = [];
    const mcpCalls: number[] = [];
    const adapterCalls = { insertText: 0, submitForm: 0 };

    let guardCounter = 0;
    const sigs = new Set<string>();
    const guard: ExecutionGuardLike = {
      reserveExecution: (input) => {
        const sig = `${input.functionName}:${input.callId}`;
        if (sigs.has(sig)) return null;
        sigs.add(sig);
        return `key_${guardCounter++}`;
      },
      executionGuardStore: { markSucceeded: () => {}, markFailed: () => {} },
    };

    const handler = createStreamToolHandler({
      config: makeConfig(),
      mcpClient: () => ({
        isReady: () => true,
        callTool: async () => { mcpCalls.push(1); return 'result'; },
      }),
      guard,
      adapter: () => ({
        insertText: async () => { adapterCalls.insertText++; return true; },
        submitForm: async () => { adapterCalls.submitForm++; return true; },
        getInputContent: () => '',
      }),
      storage: createMockStorage(),
      onEvent: (e) => events.push(e),
    });

    const event = {
      type: 'stream_cutoff',
      streamId: 'stream_dup',
      identity: { name: 'get_weather', callId: 'call_dup', arguments: '{"city":"Tokyo"}' },
    };

    // First call
    await handler(event);
    // Second call (duplicate)
    await handler(event);

    // callTool called once
    assert.equal(mcpCalls.length, 1, 'callTool should be called exactly once');
    // insertText called once
    assert.equal(adapterCalls.insertText, 1, 'insertText should be called once');
    // submitForm called once
    assert.equal(adapterCalls.submitForm, 1, 'submitForm should be called once');

    // Second should be duplicate
    const dupEvents = events.filter(
      e => e.type === 'stream_tool_execution' && (e as StreamToolExecutionEvent).status === 'duplicate'
    );
    assert.equal(dupEvents.length, 1, 'Second call should emit duplicate event');
  });
});

// --- §5.11: Circuit breaker ---

describe('Integration: circuit breaker (§5.11)', () => {
  test('§5.11: exceeding max calls per stream → CIRCUIT_BREAKER_OPEN', async () => {
    const events: BridgeEvent[] = [];
    const mcpCalls: number[] = [];

    let guardCounter = 0;
    const guard: ExecutionGuardLike = {
      reserveExecution: () => `key_${guardCounter++}`,
      executionGuardStore: { markSucceeded: () => {}, markFailed: () => {} },
    };

    const maxCalls = 3;
    const handler = createStreamToolHandler({
      config: makeConfig({ circuitBreaker: { maxToolCallsPerStream: maxCalls } }),
      mcpClient: () => ({
        isReady: () => true,
        callTool: async () => { mcpCalls.push(1); return 'ok'; },
      }),
      guard,
      adapter: createMockAdapter(),
      storage: createMockStorage(),
      onEvent: (e) => events.push(e),
    });

    const streamId = 'stream_breaker';

    // Fire maxCalls + 2 events (each with unique callId to avoid dedup)
    for (let i = 0; i < maxCalls + 2; i++) {
      await handler({
        type: 'stream_cutoff',
        streamId,
        identity: { name: 'tool_x', callId: `call_breaker_${i}`, arguments: '{}' },
      });
    }

    // Only maxCalls should have executed
    assert.equal(mcpCalls.length, maxCalls, `Only ${maxCalls} tool calls should execute`);

    // Should have CIRCUIT_BREAKER_OPEN events for the excess
    const breakerEvents = events.filter(
      e => e.type === 'stream_tool_execution'
        && (e as StreamToolExecutionEvent).errorCode === 'CIRCUIT_BREAKER_OPEN'
    );
    assert.equal(breakerEvents.length, 2, 'Should have 2 circuit breaker events');
  });

  test('§5.11b: different streams have independent counters', async () => {
    const events: BridgeEvent[] = [];
    const mcpCalls: number[] = [];

    let guardCounter = 0;
    const guard: ExecutionGuardLike = {
      reserveExecution: () => `key_${guardCounter++}`,
      executionGuardStore: { markSucceeded: () => {}, markFailed: () => {} },
    };

    const maxCalls = 2;
    const handler = createStreamToolHandler({
      config: makeConfig({ circuitBreaker: { maxToolCallsPerStream: maxCalls } }),
      mcpClient: () => ({
        isReady: () => true,
        callTool: async () => { mcpCalls.push(1); return 'ok'; },
      }),
      guard,
      adapter: createMockAdapter(),
      storage: createMockStorage(),
      onEvent: (e) => events.push(e),
    });

    // 2 calls on stream_A (should all succeed)
    for (let i = 0; i < maxCalls; i++) {
      await handler({
        type: 'stream_cutoff',
        streamId: 'stream_A',
        identity: { name: 'tool_x', callId: `call_A_${i}`, arguments: '{}' },
      });
    }

    // 2 calls on stream_B (should all succeed, independent counter)
    for (let i = 0; i < maxCalls; i++) {
      await handler({
        type: 'stream_cutoff',
        streamId: 'stream_B',
        identity: { name: 'tool_x', callId: `call_B_${i}`, arguments: '{}' },
      });
    }

    // All 4 should succeed
    assert.equal(mcpCalls.length, maxCalls * 2, 'Both streams should use their own counter');

    // No circuit breaker events
    const breakerEvents = events.filter(
      e => e.type === 'stream_tool_execution'
        && (e as StreamToolExecutionEvent).errorCode === 'CIRCUIT_BREAKER_OPEN'
    );
    assert.equal(breakerEvents.length, 0, 'No circuit breaker for independent streams');
  });
});

// --- §5.6 + §5.1 combined: injectResultIfSafe contract ---

describe('Integration: injectResultIfSafe contract', () => {
  test('no adapter → INJECT_SKIPPED_NO_ADAPTER', async () => {
    const result = await injectResultIfSafe({
      callId: 'call_x', name: 'tool_x', status: 'success',
      result: 'data', autoSubmit: true,
      adapter: () => null,
    });
    assert.equal(result.outcome, 'INJECT_SKIPPED_NO_ADAPTER');
  });

  test('getInputContent throws → INJECT_SKIPPED_NO_INSPECT', async () => {
    const result = await injectResultIfSafe({
      callId: 'call_x', name: 'tool_x', status: 'success',
      result: 'data', autoSubmit: true,
      adapter: () => ({
        insertText: async () => true,
        submitForm: async () => true,
        getInputContent: () => { throw new Error('DOM disconnected'); },
      }),
    });
    assert.equal(result.outcome, 'INJECT_SKIPPED_NO_INSPECT');
  });

  test('getInputContent transient null → retries before inserting', async () => {
    let inspectCalls = 0;
    let inserted = false;

    const result = await injectResultIfSafe({
      callId: 'call_retry', name: 'tool_retry', status: 'success',
      result: 'data', autoSubmit: false,
      inspectRetry: { attempts: 2, intervalMs: 0 },
      adapter: () => ({
        insertText: async () => { inserted = true; return true; },
        submitForm: async () => true,
        getInputContent: () => (++inspectCalls < 2 ? null : ''),
      }),
    });

    assert.equal(result.outcome, 'RESULT_INJECTED');
    assert.equal(inserted, true);
    assert.equal(inspectCalls, 2);
  });

  test('with nonce → ACK instruction appended to formatted result', async () => {
    let capturedText = '';
    const result = await injectResultIfSafe({
      callId: 'call_ack', name: 'ack_tool', status: 'success',
      result: { data: 'test' }, autoSubmit: true, nonce: 'ack_test_nonce',
      adapter: () => ({
        insertText: async (text: string) => { capturedText = text; return true; },
        submitForm: async () => true,
        getInputContent: () => '',
      }),
    });
    assert.equal(result.outcome, 'RESULT_SUBMITTED');
    assert.ok(capturedText.includes('ack_test_nonce'), 'Should include nonce');
    assert.ok(capturedText.includes('<result_nonce>'), 'Should include result_nonce tag');
    assert.ok(capturedText.includes('mcp_ack'), 'Should include mcp_ack instruction');
  });

  test('autoSubmit=false → RESULT_INJECTED (no submit)', async () => {
    let submitted = false;
    const result = await injectResultIfSafe({
      callId: 'call_no_submit', name: 'tool_ns', status: 'success',
      result: 'data', autoSubmit: false,
      adapter: () => ({
        insertText: async () => true,
        submitForm: async () => { submitted = true; return true; },
        getInputContent: () => '',
      }),
    });
    assert.equal(result.outcome, 'RESULT_INJECTED');
    assert.ok(!submitted, 'submitForm should not be called when autoSubmit=false');
  });
});

// --- §5.15–5.16: Scanner integration (function call identity validation) ---

describe('Integration: identity validation and parse edge cases (§5.15–5.16)', () => {
  test('§5.15: missing identity.name → failed with IDENTITY_INVALID', async () => {
    const events: BridgeEvent[] = [];

    const handler = createStreamToolHandler({
      config: makeConfig(),
      mcpClient: () => createMockMcpClient(),
      guard: createMockGuard(),
      adapter: createMockAdapter(),
      storage: createMockStorage(),
      onEvent: (e) => events.push(e),
    });

    await handler({
      type: 'stream_cutoff',
      streamId: 'stream_no_name',
      identity: { name: null, callId: 'call_no_name', arguments: '{}' },
    });

    const failed = events.find(
      e => e.type === 'stream_tool_execution'
        && (e as StreamToolExecutionEvent).errorCode === 'IDENTITY_INVALID'
    ) as StreamToolExecutionEvent;
    assert.ok(failed, 'Should fail with IDENTITY_INVALID');
    assert.equal(failed.phase, 'identity');
  });

  test('§5.15b: null arguments treated as empty object (no-arg tool)', async () => {
    const events: BridgeEvent[] = [];
    const mcpCalls: Array<{ name: string; params: Record<string, unknown> }> = [];

    const handler = createStreamToolHandler({
      config: makeConfig(),
      mcpClient: () => ({
        isReady: () => true,
        callTool: async (name: string, params: Record<string, unknown>) => {
          mcpCalls.push({ name, params });
          return 'ok';
        },
      }),
      guard: createMockGuard(),
      adapter: createMockAdapter(),
      storage: createMockStorage(),
      onEvent: (e) => events.push(e),
    });

    await handler({
      type: 'stream_cutoff',
      streamId: 'stream_null_args',
      identity: { name: 'get_status', callId: 'call_null_args', arguments: null },
    });

    // Should succeed — null args → defaults to {}
    const succeeded = events.find(
      e => e.type === 'stream_tool_execution' && (e as StreamToolExecutionEvent).status === 'succeeded'
    );
    assert.ok(succeeded, 'null arguments should be treated as empty object');
    assert.equal(mcpCalls.length, 1);
    assert.deepEqual(mcpCalls[0].params, {}, 'params should be empty object');
  });

  test('§5.16: invalid JSON arguments → PARSE_ERROR', async () => {
    const events: BridgeEvent[] = [];

    const handler = createStreamToolHandler({
      config: makeConfig(),
      mcpClient: () => createMockMcpClient(),
      guard: createMockGuard(),
      adapter: createMockAdapter(),
      storage: createMockStorage(),
      onEvent: (e) => events.push(e),
    });

    await handler({
      type: 'stream_cutoff',
      streamId: 'stream_bad_json',
      identity: { name: 'tool_x', callId: 'call_bad', arguments: '{invalid json}' },
    });

    const failed = events.find(
      e => e.type === 'stream_tool_execution'
        && (e as StreamToolExecutionEvent).errorCode === 'PARSE_ERROR'
    ) as StreamToolExecutionEvent;
    assert.ok(failed, 'Should fail with PARSE_ERROR');
    assert.equal(failed.phase, 'parse');
  });

  test('§5.16b: array arguments → ARGS_NOT_OBJECT', async () => {
    const events: BridgeEvent[] = [];

    const handler = createStreamToolHandler({
      config: makeConfig(),
      mcpClient: () => createMockMcpClient(),
      guard: createMockGuard(),
      adapter: createMockAdapter(),
      storage: createMockStorage(),
      onEvent: (e) => events.push(e),
    });

    await handler({
      type: 'stream_cutoff',
      streamId: 'stream_array_args',
      identity: { name: 'tool_x', callId: 'call_array', arguments: '[1,2,3]' },
    });

    const failed = events.find(
      e => e.type === 'stream_tool_execution'
        && (e as StreamToolExecutionEvent).errorCode === 'ARGS_NOT_OBJECT'
    ) as StreamToolExecutionEvent;
    assert.ok(failed, 'Should fail with ARGS_NOT_OBJECT for array args');
    assert.equal(failed.phase, 'parse');
  });

  test('§5.16c: oversized arguments → ARGS_TOO_LARGE', async () => {
    const events: BridgeEvent[] = [];

    const handler = createStreamToolHandler({
      config: makeConfig(),
      mcpClient: () => createMockMcpClient(),
      guard: createMockGuard(),
      adapter: createMockAdapter(),
      storage: createMockStorage(),
      onEvent: (e) => events.push(e),
    });

    const bigArgs = '{"data":"' + 'x'.repeat(70_000) + '"}';
    await handler({
      type: 'stream_cutoff',
      streamId: 'stream_big_args',
      identity: { name: 'tool_x', callId: 'call_big', arguments: bigArgs },
    });

    const failed = events.find(
      e => e.type === 'stream_tool_execution'
        && (e as StreamToolExecutionEvent).errorCode === 'ARGS_TOO_LARGE'
    ) as StreamToolExecutionEvent;
    assert.ok(failed, 'Should fail with ARGS_TOO_LARGE');
    assert.equal(failed.phase, 'parse');
  });

  test('§5.16d: tool not in allowlist → TOOL_NOT_ALLOWED', async () => {
    const events: BridgeEvent[] = [];

    const handler = createStreamToolHandler({
      config: makeConfig({ toolAllowlist: ['safe_tool', 'another_safe'] }),
      mcpClient: () => createMockMcpClient(),
      guard: createMockGuard(),
      adapter: createMockAdapter(),
      storage: createMockStorage(),
      onEvent: (e) => events.push(e),
    });

    await handler({
      type: 'stream_cutoff',
      streamId: 'stream_not_allowed',
      identity: { name: 'evil_tool', callId: 'call_evil', arguments: '{}' },
    });

    const failed = events.find(
      e => e.type === 'stream_tool_execution'
        && (e as StreamToolExecutionEvent).errorCode === 'TOOL_NOT_ALLOWED'
    ) as StreamToolExecutionEvent;
    assert.ok(failed, 'Should fail with TOOL_NOT_ALLOWED');
    assert.equal(failed.phase, 'identity');
  });

  test('§5.16e: mcpClient not ready → MCP_CLIENT_NOT_READY', async () => {
    const events: BridgeEvent[] = [];

    const handler = createStreamToolHandler({
      config: makeConfig(),
      mcpClient: () => ({ isReady: () => false, callTool: async () => 'should not be called' }),
      guard: createMockGuard(),
      adapter: createMockAdapter(),
      storage: createMockStorage(),
      onEvent: (e) => events.push(e),
    });

    await handler({
      type: 'stream_cutoff',
      streamId: 'stream_not_ready',
      identity: { name: 'tool_x', callId: 'call_not_ready', arguments: '{}' },
    });

    const failed = events.find(
      e => e.type === 'stream_tool_execution'
        && (e as StreamToolExecutionEvent).errorCode === 'MCP_CLIENT_NOT_READY'
    ) as StreamToolExecutionEvent;
    assert.ok(failed, 'Should fail with MCP_CLIENT_NOT_READY');
    assert.equal(failed.phase, 'mcp_client');
  });

  test('§5.16f: mcpClient is null → MCP_CLIENT_MISSING', async () => {
    const events: BridgeEvent[] = [];

    const handler = createStreamToolHandler({
      config: makeConfig(),
      mcpClient: () => null as unknown as McpClientLike,
      guard: createMockGuard(),
      adapter: createMockAdapter(),
      storage: createMockStorage(),
      onEvent: (e) => events.push(e),
    });

    await handler({
      type: 'stream_cutoff',
      streamId: 'stream_null_client',
      identity: { name: 'tool_x', callId: 'call_null_client', arguments: '{}' },
    });

    const failed = events.find(
      e => e.type === 'stream_tool_execution'
        && (e as StreamToolExecutionEvent).errorCode === 'MCP_CLIENT_MISSING'
    ) as StreamToolExecutionEvent;
    assert.ok(failed, 'Should fail with MCP_CLIENT_MISSING');
    assert.equal(failed.phase, 'mcp_client');
  });
});

// --- Scanner → Bridge integration (GPT P1 requirement) ---

describe('Integration: scanner → bridge pipeline', () => {
  /**
   * Helper: wire scanner + bridge together like production.
   * Scanner detects function calls from NDJSON lines;
   * on detection, fires bridge handler with stream_cutoff event.
   */
  function createScannerBridgePipeline(opts: {
    mcpCallLog: Array<{ name: string; params: Record<string, unknown> }>;
    events: BridgeEvent[];
  }) {
    const { mcpCallLog, events } = opts;

    const scanner = createFunctionCallScanner();
    let guardCounter = 0;
    const sigs = new Set<string>();

    const handler = createStreamToolHandler({
      config: makeConfig(),
      mcpClient: () => ({
        isReady: () => true,
        callTool: async (name: string, params: Record<string, unknown>) => {
          mcpCallLog.push({ name, params });
          return { status: 'ok' };
        },
      }),
      guard: {
        reserveExecution: (input) => {
          const sig = `${input.functionName}:${input.callId}`;
          if (sigs.has(sig)) return null;
          sigs.add(sig);
          return `key_${guardCounter++}`;
        },
        executionGuardStore: { markSucceeded: () => {}, markFailed: () => {} },
      },
      adapter: createMockAdapter(),
      storage: createMockStorage(),
      onEvent: (e) => events.push(e),
    });

    return { scanner, handler };
  }

  test('metadata patch false-positive must NOT reach bridge', async () => {
    // This is the Bug C scenario from Gate 5d:
    // A Notion metadata patch with "function_call" and "name" keywords in its metadata
    // (e.g., agent-inference block definitions) should NOT trigger bridge execution.
    const mcpCallLog: Array<{ name: string; params: Record<string, unknown> }> = [];
    const events: BridgeEvent[] = [];
    const { scanner, handler } = createScannerBridgePipeline({ mcpCallLog, events });

    // Realistic metadata patch: type:"patch", contains "function_call" and "name" in metadata
    // but text content does NOT contain function_call_start
    const metadataPatch = JSON.stringify({
      type: 'patch',
      v: [{
        o: 'a',
        p: '/blocks/abc123',
        v: {
          type: 'agent-inference',
          value: [{
            type: 'function_call',
            name: 'get_weather',
            content: '',
          }],
        },
      }],
    });

    const result = scanner.processLine(metadataPatch);

    // Scanner should NOT detect this as a function call
    assert.equal(result.detected, false, 'Metadata patch should not be detected as function call');
    assert.equal(result.accumulating, false, 'Should not start accumulation');

    // Even if we mistakenly fed it to bridge, verify bridge got 0 calls
    if (result.detected && result.identity) {
      await handler({
        type: 'stream_cutoff',
        streamId: 'stream_meta',
        identity: result.identity,
      });
    }

    assert.equal(mcpCallLog.length, 0, 'callTool must NOT be called for metadata patches');
    const executionEvents = events.filter(e => e.type === 'stream_tool_execution');
    assert.equal(executionEvents.length, 0, 'No bridge execution events for metadata patches');
  });

  test('cross-patch function call reaches bridge exactly once with correct identity', async () => {
    // Realistic Notion patch sequence:
    // 1. First patch: function_call_start with name and call_id
    // 2. Middle patch: parameter data
    // 3. Final patch: function_call_end
    const mcpCallLog: Array<{ name: string; params: Record<string, unknown> }> = [];
    const events: BridgeEvent[] = [];
    const { scanner, handler } = createScannerBridgePipeline({ mcpCallLog, events });

    // Patch 1: function_call_start
    const patch1 = JSON.stringify({
      type: 'patch',
      v: [{
        o: 'x',
        p: '/blocks/def456/content',
        v: '{"type":"function_call_start","name":"get_weather","call_id":"call_abc123"}\n',
      }],
    });

    // Patch 2: parameter
    const patch2 = JSON.stringify({
      type: 'patch',
      v: [{
        o: 'x',
        p: '/blocks/def456/content',
        v: '{"type":"parameter","key":"city","value":"Tokyo"}\n',
      }],
    });

    // Patch 3: function_call_end
    const patch3 = JSON.stringify({
      type: 'patch',
      v: [{
        o: 'x',
        p: '/blocks/def456/content',
        v: '{"type":"function_call_end","call_id":"call_abc123"}\n',
      }],
    });

    // Process all patches through scanner
    const r1 = scanner.processLine(patch1);
    assert.equal(r1.detected, false, 'Patch 1: should not detect yet');
    assert.equal(r1.accumulating, true, 'Patch 1: should start accumulating');

    const r2 = scanner.processLine(patch2);
    assert.equal(r2.detected, false, 'Patch 2: should not detect yet');
    assert.equal(r2.accumulating, true, 'Patch 2: still accumulating');

    const r3 = scanner.processLine(patch3);
    assert.equal(r3.detected, true, 'Patch 3: should detect function call');
    assert.equal(r3.accumulating, false, 'Patch 3: accumulation complete');
    assert.ok(r3.identity, 'Should have extracted identity');
    assert.equal(r3.identity!.name, 'get_weather');
    assert.equal(r3.identity!.callId, 'call_abc123');

    // Parse the arguments
    const parsedArgs = JSON.parse(r3.identity!.arguments!);
    assert.equal(parsedArgs.city, 'Tokyo');

    // Feed to bridge — should execute exactly once
    await handler({
      type: 'stream_cutoff',
      streamId: 'stream_cross_patch',
      identity: r3.identity!,
    });

    // Verify bridge executed once with correct identity
    assert.equal(mcpCallLog.length, 1, 'callTool should be called exactly once');
    assert.equal(mcpCallLog[0].name, 'get_weather', 'Tool name should be get_weather');
    assert.deepEqual(mcpCallLog[0].params, { city: 'Tokyo' }, 'Params should contain city:Tokyo');

    // Verify no duplicate
    const succeeded = events.filter(
      e => e.type === 'stream_tool_execution' && (e as StreamToolExecutionEvent).status === 'succeeded'
    );
    assert.equal(succeeded.length, 1, 'Should emit exactly one succeeded event');
    const duplicates = events.filter(
      e => e.type === 'stream_tool_execution' && (e as StreamToolExecutionEvent).status === 'duplicate'
    );
    assert.equal(duplicates.length, 0, 'Should have no duplicates');
  });

  test('metadata patch during accumulation does not abort cross-patch detection', async () => {
    // Interleaved scenario: function_call_start → metadata patch → parameter → function_call_end
    const mcpCallLog: Array<{ name: string; params: Record<string, unknown> }> = [];
    const events: BridgeEvent[] = [];
    const { scanner, handler } = createScannerBridgePipeline({ mcpCallLog, events });

    // Patch 1: function_call_start
    const patch1 = JSON.stringify({
      type: 'patch',
      v: [{
        o: 'x',
        p: '/blocks/ghi789/content',
        v: '{"type":"function_call_start","name":"search","call_id":"call_search_1"}\n',
      }],
    });

    // Patch 2: metadata-only patch (no extractable text content)
    const metaPatch = JSON.stringify({
      type: 'patch',
      v: [{
        o: 'r',
        p: '/blocks/ghi789/style',
        v: { color: 'blue' },
      }],
    });

    // Patch 3: parameter
    const patch3 = JSON.stringify({
      type: 'patch',
      v: [{
        o: 'x',
        p: '/blocks/ghi789/content',
        v: '{"type":"parameter","key":"query","value":"test search"}\n',
      }],
    });

    // Patch 4: function_call_end
    const patch4 = JSON.stringify({
      type: 'patch',
      v: [{
        o: 'x',
        p: '/blocks/ghi789/content',
        v: '{"type":"function_call_end","call_id":"call_search_1"}\n',
      }],
    });

    const r1 = scanner.processLine(patch1);
    assert.equal(r1.accumulating, true);

    const r2 = scanner.processLine(metaPatch);
    assert.equal(r2.accumulating, true, 'Metadata patch should not abort accumulation');

    const r3 = scanner.processLine(patch3);
    assert.equal(r3.accumulating, true);

    const r4 = scanner.processLine(patch4);
    assert.equal(r4.detected, true, 'Should detect after function_call_end');
    assert.equal(r4.identity!.name, 'search');

    // Feed to bridge
    await handler({
      type: 'stream_cutoff',
      streamId: 'stream_interleaved',
      identity: r4.identity!,
    });

    assert.equal(mcpCallLog.length, 1, 'callTool called once despite interleaved metadata');
    assert.equal(mcpCallLog[0].name, 'search');
  });
});

// --- P2: DEFAULT_MAX_TOOL_CALLS_PER_STREAM usage ---

describe('Integration: default circuit breaker constant', () => {
  test('default max tool calls per stream matches production constant', async () => {
    const events: BridgeEvent[] = [];
    const mcpCalls: number[] = [];

    let guardCounter = 0;
    const handler = createStreamToolHandler({
      // No circuitBreaker config → should use DEFAULT_MAX_TOOL_CALLS_PER_STREAM
      config: makeConfig(),
      mcpClient: () => ({
        isReady: () => true,
        callTool: async () => { mcpCalls.push(1); return 'ok'; },
      }),
      guard: {
        reserveExecution: () => `key_${guardCounter++}`,
        executionGuardStore: { markSucceeded: () => {}, markFailed: () => {} },
      },
      adapter: createMockAdapter(),
      storage: createMockStorage(),
      onEvent: (e) => events.push(e),
    });

    // Fire DEFAULT_MAX + 1 events on the same stream
    for (let i = 0; i < DEFAULT_MAX_TOOL_CALLS_PER_STREAM + 1; i++) {
      await handler({
        type: 'stream_cutoff',
        streamId: 'stream_default_breaker',
        identity: { name: 'tool_x', callId: `call_default_${i}`, arguments: '{}' },
      });
    }

    // Exactly DEFAULT_MAX should execute
    assert.equal(mcpCalls.length, DEFAULT_MAX_TOOL_CALLS_PER_STREAM,
      `Should execute exactly ${DEFAULT_MAX_TOOL_CALLS_PER_STREAM} calls (default)`);

    // The extra one should be blocked
    const breakerEvents = events.filter(
      e => e.type === 'stream_tool_execution'
        && (e as StreamToolExecutionEvent).errorCode === 'CIRCUIT_BREAKER_OPEN'
    );
    assert.equal(breakerEvents.length, 1, 'Should have 1 circuit breaker event for the excess call');
  });
});
