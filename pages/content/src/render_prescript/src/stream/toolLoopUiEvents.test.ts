/**
 * TDD: Failing tests for Gate 6B normalizeToUiEvent() mapper.
 *
 * These tests define the event contract between:
 *   - MAIN world bridge events (StreamToolExecutionEvent, BridgeHandoffAckEvent, ModelAckEvent)
 *   - Content script UI consumption (ToolLoopUiEvent)
 *
 * Run: node --test --experimental-strip-types toolLoopUiEvents.test.ts
 * (from render_prescript/src/stream/ directory)
 *
 * All tests should FAIL until implementation exists.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  normalizeToUiEvent,
  type ToolLoopUiEvent,
  type ToolLoopUiEventType,
} from './toolLoopUiEvents.ts';
import type { BridgeEvent, StreamToolExecutionEvent, BridgeHandoffAckEvent, InjectOutcome } from './streamToolBridge.ts';
import type { ModelAckEvent } from './ackTracker.ts';

// --- Helpers ---

function makeStreamEvent(
  status: StreamToolExecutionEvent['status'],
  overrides: Partial<Omit<StreamToolExecutionEvent, 'type' | 'status'>> = {},
): StreamToolExecutionEvent {
  return {
    type: 'stream_tool_execution',
    streamId: 'stream-1',
    identity: { name: 'test_tool', callId: 'call-1', arguments: '{"key":"value"}' },
    status,
    ...overrides,
  };
}

function makeHandoffEvent(overrides: Partial<BridgeHandoffAckEvent> = {}): BridgeHandoffAckEvent {
  return {
    type: 'bridge_handoff_ack',
    streamId: 'stream-1',
    callId: 'call-1',
    functionName: 'test_tool',
    nonce: 'nonce-abc',
    timestamp: 1000,
    outcome: 'RESULT_SUBMITTED',
    ...overrides,
  };
}

function makeAckEvent(type: ModelAckEvent['type']): ModelAckEvent {
  return {
    type,
    nonce: 'nonce-abc',
    callId: 'call-1',
    functionName: 'test_tool',
    latencyMs: 150,
  };
}

// --- Tests ---

describe('normalizeToUiEvent — status mapping', () => {
  test('reserved → tool_call_detected', () => {
    const raw = makeStreamEvent('reserved');
    const result = normalizeToUiEvent(raw);
    assert.ok(result);
    assert.equal(result.type, 'tool_call_detected');
    assert.equal(result.version, 1);
    assert.equal(result.streamId, 'stream-1');
    assert.equal(result.callId, 'call-1');
    assert.equal(result.toolName, 'test_tool');
    assert.equal(typeof result.timestamp, 'number');
  });

  test('executing → tool_execution_started', () => {
    const raw = makeStreamEvent('executing');
    const result = normalizeToUiEvent(raw);
    assert.ok(result);
    assert.equal(result.type, 'tool_execution_started');
    assert.equal(result.version, 1);
  });

  test('succeeded (no injectOutcome) → tool_execution_succeeded', () => {
    const raw = makeStreamEvent('succeeded', { result: { data: 'secret' }, durationMs: 123 });
    const result = normalizeToUiEvent(raw);
    assert.ok(result);
    assert.equal(result.type, 'tool_execution_succeeded');
  });

  test('failed (generic) → tool_execution_failed', () => {
    const raw = makeStreamEvent('failed', {
      phase: 'tool_call',
      error: 'Network timeout',
      errorCode: 'TOOL_TIMEOUT',
    });
    const result = normalizeToUiEvent(raw);
    assert.ok(result);
    assert.equal(result.type, 'tool_execution_failed');
    assert.equal(result.phase, 'tool_call');
    assert.equal(result.errorCode, 'TOOL_TIMEOUT');
    assert.equal(result.error, 'Network timeout');
  });
});

describe('normalizeToUiEvent — injectOutcome mapping', () => {
  test('succeeded + RESULT_INJECTED → tool_result_inserted', () => {
    const raw = makeStreamEvent('succeeded', { injectOutcome: 'RESULT_INJECTED' as InjectOutcome });
    const result = normalizeToUiEvent(raw);
    assert.ok(result);
    assert.equal(result.type, 'tool_result_inserted');
    assert.equal(result.injectOutcome, 'RESULT_INJECTED');
  });

  test('succeeded + RESULT_SUBMITTED → tool_result_submitted', () => {
    const raw = makeStreamEvent('succeeded', { injectOutcome: 'RESULT_SUBMITTED' as InjectOutcome });
    const result = normalizeToUiEvent(raw);
    assert.ok(result);
    assert.equal(result.type, 'tool_result_submitted');
    assert.equal(result.injectOutcome, 'RESULT_SUBMITTED');
  });

  test('succeeded + INJECT_SKIPPED_* → tool_result_blocked', () => {
    const skippedOutcomes: InjectOutcome[] = [
      'INJECT_SKIPPED_NO_ADAPTER',
      'INJECT_SKIPPED_NO_INSPECT',
      'INJECT_SKIPPED_DRAFT',
    ];
    for (const outcome of skippedOutcomes) {
      const raw = makeStreamEvent('succeeded', { injectOutcome: outcome });
      const result = normalizeToUiEvent(raw);
      assert.ok(result, `Expected non-null for ${outcome}`);
      assert.equal(result.type, 'tool_result_blocked', `Expected tool_result_blocked for ${outcome}`);
      assert.equal(result.injectOutcome, outcome);
    }
  });

  test('succeeded + INSERT_FAILED/SUBMIT_FAILED → tool_result_failed', () => {
    const failOutcomes: InjectOutcome[] = ['INSERT_FAILED', 'SUBMIT_FAILED'];
    for (const outcome of failOutcomes) {
      const raw = makeStreamEvent('succeeded', { injectOutcome: outcome });
      const result = normalizeToUiEvent(raw);
      assert.ok(result, `Expected non-null for ${outcome}`);
      assert.equal(result.type, 'tool_result_failed', `Expected tool_result_failed for ${outcome}`);
      assert.equal(result.injectOutcome, outcome);
    }
  });
});

describe('normalizeToUiEvent — execution_blocked (pre-tool-call failures)', () => {
  test('failed + TOOL_NOT_ALLOWED → execution_blocked', () => {
    const raw = makeStreamEvent('failed', { errorCode: 'TOOL_NOT_ALLOWED', phase: 'reserve' });
    const result = normalizeToUiEvent(raw);
    assert.ok(result);
    assert.equal(result.type, 'execution_blocked');
    assert.equal(result.errorCode, 'TOOL_NOT_ALLOWED');
  });

  test('failed + CIRCUIT_BREAKER_OPEN → execution_blocked', () => {
    const raw = makeStreamEvent('failed', { errorCode: 'CIRCUIT_BREAKER_OPEN', phase: 'reserve' });
    const result = normalizeToUiEvent(raw);
    assert.ok(result);
    assert.equal(result.type, 'execution_blocked');
  });

  test('failed + ARGS_TOO_LARGE → execution_blocked', () => {
    const raw = makeStreamEvent('failed', { errorCode: 'ARGS_TOO_LARGE', phase: 'parse' });
    const result = normalizeToUiEvent(raw);
    assert.ok(result);
    assert.equal(result.type, 'execution_blocked');
  });
});

describe('normalizeToUiEvent — bridge_handoff_ack', () => {
  test('BridgeHandoffAckEvent → bridge_handoff_ack (normalized)', () => {
    const raw = makeHandoffEvent();
    const result = normalizeToUiEvent(raw);
    assert.ok(result);
    assert.equal(result.type, 'bridge_handoff_ack');
    assert.equal(result.version, 1);
    assert.equal(result.streamId, 'stream-1');
    assert.equal(result.callId, 'call-1');
    assert.equal(result.toolName, 'test_tool');
    assert.equal(typeof result.timestamp, 'number');
  });
});

describe('normalizeToUiEvent — ModelAckEvent', () => {
  test('model_ack_confirmed → model_ack_confirmed', () => {
    const raw = makeAckEvent('model_ack_confirmed');
    const result = normalizeToUiEvent(raw);
    assert.ok(result);
    assert.equal(result.type, 'model_ack_confirmed');
    assert.equal(result.version, 1);
    assert.equal(result.callId, 'call-1');
    assert.equal(result.toolName, 'test_tool');
  });

  test('model_ack_timeout → model_ack_timeout', () => {
    const raw = makeAckEvent('model_ack_timeout');
    const result = normalizeToUiEvent(raw);
    assert.ok(result);
    assert.equal(result.type, 'model_ack_timeout');
  });
});

describe('normalizeToUiEvent — null/filter cases', () => {
  test('duplicate status → null', () => {
    const raw = makeStreamEvent('duplicate');
    const result = normalizeToUiEvent(raw);
    assert.equal(result, null);
  });

  test('unknown status → null', () => {
    const raw = makeStreamEvent('unknown_garbage' as any);
    const result = normalizeToUiEvent(raw);
    assert.equal(result, null);
  });

  test('unknown injectOutcome → tool_result_failed (fail-closed)', () => {
    const raw = makeStreamEvent('succeeded', { injectOutcome: 'FUTURE_UNKNOWN_OUTCOME' as any });
    const result = normalizeToUiEvent(raw);
    assert.ok(result);
    assert.equal(result.type, 'tool_result_failed');
    assert.equal(result.injectOutcome, 'FUTURE_UNKNOWN_OUTCOME');
  });
});

describe('normalizeToUiEvent — failed + injectOutcome (P1 fix)', () => {
  test('failed + INSERT_FAILED → tool_result_failed with phase/errorCode', () => {
    const raw = makeStreamEvent('failed', {
      phase: 'inject',
      error: 'insertText failed',
      errorCode: 'INSERT_FAILED',
      injectOutcome: 'INSERT_FAILED' as InjectOutcome,
    });
    const result = normalizeToUiEvent(raw);
    assert.ok(result);
    assert.equal(result.type, 'tool_result_failed');
    assert.equal(result.phase, 'inject');
    assert.equal(result.errorCode, 'INSERT_FAILED');
    assert.equal(result.error, 'insertText failed');
    assert.equal(result.injectOutcome, 'INSERT_FAILED');
  });

  test('failed + SUBMIT_FAILED → tool_result_failed with phase/errorCode', () => {
    const raw = makeStreamEvent('failed', {
      phase: 'submit',
      error: 'submitForm failed',
      errorCode: 'SUBMIT_FAILED',
      injectOutcome: 'SUBMIT_FAILED' as InjectOutcome,
    });
    const result = normalizeToUiEvent(raw);
    assert.ok(result);
    assert.equal(result.type, 'tool_result_failed');
    assert.equal(result.phase, 'submit');
    assert.equal(result.errorCode, 'SUBMIT_FAILED');
    assert.equal(result.injectOutcome, 'SUBMIT_FAILED');
  });

  test('failed + INJECT_SKIPPED_NO_ADAPTER → tool_result_blocked', () => {
    const raw = makeStreamEvent('failed', {
      phase: 'inject',
      error: 'No adapter available for DOM injection',
      errorCode: 'ADAPTER_MISSING',
      injectOutcome: 'INJECT_SKIPPED_NO_ADAPTER' as InjectOutcome,
    });
    const result = normalizeToUiEvent(raw);
    assert.ok(result);
    assert.equal(result.type, 'tool_result_blocked');
    assert.equal(result.phase, 'inject');
    assert.equal(result.errorCode, 'ADAPTER_MISSING');
    assert.equal(result.injectOutcome, 'INJECT_SKIPPED_NO_ADAPTER');
  });

  test('failed + INJECT_SKIPPED_NO_INSPECT → tool_result_blocked', () => {
    const raw = makeStreamEvent('failed', {
      injectOutcome: 'INJECT_SKIPPED_NO_INSPECT' as InjectOutcome,
    });
    const result = normalizeToUiEvent(raw);
    assert.ok(result);
    assert.equal(result.type, 'tool_result_blocked');
    assert.equal(result.injectOutcome, 'INJECT_SKIPPED_NO_INSPECT');
  });

  test('failed + INJECT_SKIPPED_DRAFT → tool_result_blocked', () => {
    const raw = makeStreamEvent('failed', {
      injectOutcome: 'INJECT_SKIPPED_DRAFT' as InjectOutcome,
    });
    const result = normalizeToUiEvent(raw);
    assert.ok(result);
    assert.equal(result.type, 'tool_result_blocked');
    assert.equal(result.injectOutcome, 'INJECT_SKIPPED_DRAFT');
  });

  test('failed + RESULT_INJECTED → tool_result_inserted (boundary defense)', () => {
    const raw = makeStreamEvent('failed', {
      injectOutcome: 'RESULT_INJECTED' as InjectOutcome,
    });
    const result = normalizeToUiEvent(raw);
    assert.ok(result);
    assert.equal(result.type, 'tool_result_inserted');
    assert.equal(result.injectOutcome, 'RESULT_INJECTED');
  });

  test('failed + unknown_future_outcome → tool_result_failed (fail-closed)', () => {
    const raw = makeStreamEvent('failed', {
      injectOutcome: 'FUTURE_NEW_OUTCOME' as any,
    });
    const result = normalizeToUiEvent(raw);
    assert.ok(result);
    assert.equal(result.type, 'tool_result_failed');
    assert.equal(result.injectOutcome, 'FUTURE_NEW_OUTCOME');
  });

  test('failed + ADAPTER_MISSING but NO injectOutcome → tool_execution_failed (boundary lock)', () => {
    const raw = makeStreamEvent('failed', {
      phase: 'inject',
      errorCode: 'ADAPTER_MISSING',
      error: 'Some adapter error',
    });
    const result = normalizeToUiEvent(raw);
    assert.ok(result);
    assert.equal(result.type, 'tool_execution_failed');
    assert.equal(result.errorCode, 'ADAPTER_MISSING');
    assert.equal(result.phase, 'inject');
  });
});

describe('normalizeToUiEvent — security: no raw params leak', () => {
  test('does not expose raw arguments or result in output', () => {
    const raw = makeStreamEvent('succeeded', {
      result: { secret: 'api_key_12345', data: 'large payload' },
    });
    const result = normalizeToUiEvent(raw);
    assert.ok(result);
    const serialized = JSON.stringify(result);
    assert.ok(!serialized.includes('api_key_12345'), 'raw result should not be in normalized event');
    assert.ok(!serialized.includes('"key":"value"'), 'raw arguments should not be in normalized event');
  });
});
