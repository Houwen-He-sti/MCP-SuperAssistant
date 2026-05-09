/**
 * Integration tests for Gate 5c.1 + 5d: Bridge → ACK Tracker wiring.
 *
 * Tests the production cooperation between:
 * - createStreamToolHandler (streamToolBridge.ts)
 * - createAckTracker (ackTracker.ts)
 * - appendAckInstruction (functionResultFormatter.ts)
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
  type AdapterLike,
  type ExecutionGuardLike,
  type McpClientLike,
  type StorageLike,
  type StreamToolBridgeConfig,
  type BridgeEvent,
  type StreamToolExecutionEvent,
  type BridgeHandoffAckEvent,
} from './streamToolBridge.ts';
import {
  createAckTracker,
  type ModelAckEvent,
  type AckTracker,
} from './ackTracker.ts';

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
