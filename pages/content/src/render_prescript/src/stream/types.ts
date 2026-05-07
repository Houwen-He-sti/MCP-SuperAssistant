/**
 * Types for Notion AI stream interception (Phase 1 + Phase 2)
 */

import type { FunctionCallIdentity } from './parser';

/** Event emitted when a function_call is detected in the NDJSON stream */
export interface StreamFunctionCallEvent {
  type: 'function_call';
  /** Raw NDJSON line string containing the function_call signal */
  rawLine: string;
  /** Structured identity extracted from the line (may be partial) */
  identity: FunctionCallIdentity | null;
  /** Chunk index where the function_call was detected */
  chunkIndex: number;
  /** Milliseconds elapsed since stream start */
  elapsedMs: number;
  /** Unique identifier for this stream session */
  streamId: string;
}

/** Event emitted when stream cutoff is triggered (Phase 2) */
export interface StreamCutoffEvent {
  type: 'stream_cutoff';
  streamId: string;
  /** Chunk index where cutoff was triggered */
  cutoffChunkIndex: number;
  /** Milliseconds elapsed since stream start */
  elapsedMs: number;
  /** Function call identity that triggered cutoff */
  identity: FunctionCallIdentity | null;
  /** Reason for cutoff */
  reason: 'function_call_detected';
  /** Whether the trigger chunk was forwarded to UI */
  forwardedTriggerChunk: boolean;
  /** Cutoff mode used */
  mode: 'drain-drop' | 'cancel';
}

/** Event emitted when background drain completes (Phase 2, drain-drop mode) */
export interface StreamDrainCompleteEvent {
  type: 'stream_drain_complete';
  streamId: string;
  /** Number of chunks dropped during drain */
  droppedChunks: number;
  /** Total bytes dropped during drain */
  droppedBytes: number;
  /** Duration of drain in milliseconds */
  drainDurationMs: number;
  /** Whether drain was terminated by watchdog timeout */
  timedOut: boolean;
}

/** Event emitted for stream lifecycle */
export interface StreamLifecycleEvent {
    type: 'stream_start' | 'stream_end' | 'stream_error';
    streamId: string;
    url: string;
    /** Total chunks received (for stream_end) */
    totalChunks?: number;
}

/** Configuration for Phase 2 stream cutoff */
export interface StreamCutoffConfig {
  /** Whether cutoff is enabled */
  enabled: boolean;
  /** 'drain-drop': close frontend + drain background
   *  'cancel': cancel the reader and close the stream immediately */
  mode: 'drain-drop' | 'cancel';
  /** Only trigger cutoff when identity.name is non-null. Default: true */
  requireStructuredIdentity: boolean;
  /** Max milliseconds to drain background stream before force-cancel. Default: 30000 */
  maxDrainMs: number;
}

export type StreamEvent = StreamFunctionCallEvent | StreamCutoffEvent | StreamDrainCompleteEvent | StreamLifecycleEvent;

export type StreamEventListener = (event: StreamEvent) => void;
