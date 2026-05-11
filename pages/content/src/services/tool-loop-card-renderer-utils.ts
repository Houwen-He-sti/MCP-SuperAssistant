/**
 * Gate 6C: Pure utility functions for ToolLoopCardRenderer.
 *
 * Zero external dependencies — safe for direct Node.js test runner.
 * All DOM-related and logger-dependent code stays in tool-loop-card-renderer.ts.
 */

import type { ToolLoopUiEvent, ToolLoopUiEventType } from '../render_prescript/src/stream/toolLoopUiEvents.ts';

// --- Types ---

export type ToolLoopCardTone =
  | 'neutral'
  | 'pending'
  | 'success'
  | 'acknowledged'
  | 'warning'
  | 'blocked'
  | 'error';

export interface TimelineEntry {
  type: ToolLoopUiEventType;
  timestamp: number;
  phase?: string;
  errorCode?: string;
  error?: string;
  injectOutcome?: string;
}

export interface ToolLoopCardState {
  callId: string;
  toolName: string;
  currentType: ToolLoopUiEventType;
  currentTone: ToolLoopCardTone;
  title: string;
  statusIcon: string;
  timeline: TimelineEntry[];
}

// --- Pure Functions ---

const TONE_MAP: Record<ToolLoopUiEventType, ToolLoopCardTone> = {
  tool_call_detected: 'neutral',
  tool_execution_started: 'pending',
  tool_execution_succeeded: 'success',
  tool_execution_failed: 'error',
  tool_result_inserted: 'success',
  tool_result_submitted: 'success',
  tool_result_blocked: 'warning',
  tool_result_failed: 'error',
  execution_blocked: 'blocked',
  model_ack_confirmed: 'acknowledged',
  model_ack_timeout: 'warning',
  bridge_handoff_ack: 'pending',
};

export function mapEventToTone(type: ToolLoopUiEventType): ToolLoopCardTone {
  return TONE_MAP[type] ?? 'neutral';
}

const TITLE_PREFIX_MAP: Record<ToolLoopUiEventType, string> = {
  tool_call_detected: 'Tool',
  tool_execution_started: 'Executing',
  tool_execution_succeeded: 'Tool',
  tool_execution_failed: 'Tool error',
  tool_result_inserted: 'Result inserted',
  tool_result_submitted: 'Result submitted',
  tool_result_blocked: 'Result blocked',
  tool_result_failed: 'Result failed',
  execution_blocked: 'Blocked',
  model_ack_confirmed: 'ACK confirmed',
  model_ack_timeout: 'ACK timeout',
  bridge_handoff_ack: 'ACK pending',
};

export function getCardTitle(event: ToolLoopUiEvent): string {
  const prefix = TITLE_PREFIX_MAP[event.type] ?? 'Tool';
  const name = event.toolName || 'unknown';
  return `${prefix}: ${name}`;
}

const ICON_MAP: Record<ToolLoopCardTone, string> = {
  neutral: '🔍',
  pending: '⏳',
  success: '✅',
  acknowledged: '✅',
  warning: '⚠️',
  blocked: '🚫',
  error: '❌',
};

export function getCardStatusIcon(tone: ToolLoopCardTone): string {
  return ICON_MAP[tone];
}

// --- State Store ---

export class ToolLoopCardStateStore {
  private states = new Map<string, ToolLoopCardState>();

  apply(event: ToolLoopUiEvent): ToolLoopCardState | null {
    const callId = event.callId;
    if (!callId) return null;

    const existing = this.states.get(callId);
    const tone = mapEventToTone(event.type);
    const title = getCardTitle(event);
    const statusIcon = getCardStatusIcon(tone);

    const entry: TimelineEntry = {
      type: event.type,
      timestamp: event.timestamp,
      phase: event.phase,
      errorCode: event.errorCode,
      error: event.error,
      injectOutcome: event.injectOutcome,
    };

    if (existing) {
      existing.currentType = event.type;
      existing.currentTone = tone;
      existing.title = title;
      existing.statusIcon = statusIcon;
      existing.timeline.push(entry);
      return existing;
    }

    const state: ToolLoopCardState = {
      callId,
      toolName: event.toolName || 'unknown',
      currentType: event.type,
      currentTone: tone,
      title,
      statusIcon,
      timeline: [entry],
    };
    this.states.set(callId, state);
    return state;
  }

  get(callId: string): ToolLoopCardState | null {
    return this.states.get(callId) ?? null;
  }
}
