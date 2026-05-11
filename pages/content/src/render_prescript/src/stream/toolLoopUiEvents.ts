/**
 * Gate 6B: Tool-Loop UI Event Contract
 *
 * Normalizes raw bridge events (StreamToolExecutionEvent, BridgeHandoffAckEvent)
 * and ACK tracker events (ModelAckEvent) into stable, UI-safe lifecycle facts.
 *
 * Contract: normalizeToUiEvent() MUST NOT leak raw params/results.
 * It produces only the information needed for UI card rendering (Gate 6C).
 */

import type { BridgeEvent, StreamToolExecutionEvent, BridgeHandoffAckEvent, InjectOutcome } from './streamToolBridge.ts';
import type { ModelAckEvent } from './ackTracker.ts';

// --- Types ---

export type ToolLoopUiEventType =
  | 'tool_call_detected'
  | 'tool_execution_started'
  | 'tool_execution_succeeded'
  | 'tool_execution_failed'
  | 'tool_result_inserted'
  | 'tool_result_submitted'
  | 'tool_result_blocked'
  | 'tool_result_failed'
  | 'execution_blocked'
  | 'model_ack_confirmed'
  | 'model_ack_timeout'
  | 'bridge_handoff_ack';

export interface ToolLoopUiEvent {
  version: 1;
  type: ToolLoopUiEventType;
  timestamp: number;
  streamId?: string;
  callId?: string;
  toolName?: string;
  phase?: string;
  errorCode?: string;
  error?: string;
  injectOutcome?: InjectOutcome;
}

// --- Error codes that indicate pre-execution blocking ---

const EXECUTION_BLOCKED_CODES = new Set([
  'TOOL_NOT_ALLOWED',
  'CIRCUIT_BREAKER_OPEN',
  'ARGS_TOO_LARGE',
]);

// --- Normalizer ---

export type RawEvent = BridgeEvent | ModelAckEvent;

/**
 * Normalize a raw bridge or ACK event into a stable UI event.
 * Returns null for events that should not be rendered (duplicate, unknown).
 */
export function normalizeToUiEvent(raw: RawEvent): ToolLoopUiEvent | null {
  const timestamp = Date.now();

  // ModelAckEvent
  if (raw.type === 'model_ack_confirmed' || raw.type === 'model_ack_timeout') {
    const ack = raw as ModelAckEvent;
    return {
      version: 1,
      type: ack.type,
      timestamp,
      callId: ack.callId,
      toolName: ack.functionName,
    };
  }

  // BridgeHandoffAckEvent
  if (raw.type === 'bridge_handoff_ack') {
    const handoff = raw as BridgeHandoffAckEvent;
    return {
      version: 1,
      type: 'bridge_handoff_ack',
      timestamp: handoff.timestamp,
      streamId: handoff.streamId,
      callId: handoff.callId,
      toolName: handoff.functionName,
    };
  }

  // StreamToolExecutionEvent
  if (raw.type === 'stream_tool_execution') {
    const evt = raw as StreamToolExecutionEvent;
    const base: Pick<ToolLoopUiEvent, 'version' | 'timestamp' | 'streamId' | 'callId' | 'toolName'> = {
      version: 1,
      timestamp,
      streamId: evt.streamId,
      callId: evt.identity?.callId ?? undefined,
      toolName: evt.identity?.name ?? undefined,
    };

    switch (evt.status) {
      case 'reserved':
        return { ...base, type: 'tool_call_detected' };

      case 'executing':
        return { ...base, type: 'tool_execution_started' };

      case 'succeeded':
        return normalizeSucceeded(evt, base);

      case 'failed':
        return normalizeFailed(evt, base);

      case 'duplicate':
        return null;

      default:
        return null;
    }
  }

  return null;
}

// --- Internal helpers ---

function normalizeSucceeded(
  evt: StreamToolExecutionEvent,
  base: Pick<ToolLoopUiEvent, 'version' | 'timestamp' | 'streamId' | 'callId' | 'toolName'>,
): ToolLoopUiEvent {
  const outcome = evt.injectOutcome;

  if (!outcome) {
    return { ...base, type: 'tool_execution_succeeded' };
  }

  switch (outcome) {
    case 'RESULT_INJECTED':
      return { ...base, type: 'tool_result_inserted', injectOutcome: outcome };
    case 'RESULT_SUBMITTED':
      return { ...base, type: 'tool_result_submitted', injectOutcome: outcome };
    case 'INJECT_SKIPPED_NO_ADAPTER':
    case 'INJECT_SKIPPED_NO_INSPECT':
    case 'INJECT_SKIPPED_DRAFT':
      return { ...base, type: 'tool_result_blocked', injectOutcome: outcome };
    case 'INSERT_FAILED':
    case 'SUBMIT_FAILED':
      return { ...base, type: 'tool_result_failed', injectOutcome: outcome };
    default:
      // Fail-closed: unknown injectOutcome means injection was attempted
      // but result is unclassifiable. Do not report as succeeded.
      return { ...base, type: 'tool_result_failed', injectOutcome: outcome };
  }
}

function normalizeFailed(
  evt: StreamToolExecutionEvent,
  base: Pick<ToolLoopUiEvent, 'version' | 'timestamp' | 'streamId' | 'callId' | 'toolName'>,
): ToolLoopUiEvent {
  const isBlocked = evt.errorCode && EXECUTION_BLOCKED_CODES.has(evt.errorCode);

  return {
    ...base,
    type: isBlocked ? 'execution_blocked' : 'tool_execution_failed',
    phase: evt.phase ?? undefined,
    errorCode: evt.errorCode ?? undefined,
    error: evt.error ?? undefined,
  };
}
