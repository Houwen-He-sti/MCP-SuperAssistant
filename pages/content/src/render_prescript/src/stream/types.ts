/**
 * Types for Notion AI stream interception (Phase 1+)
 */

/** Event emitted when a function_call is detected in the NDJSON stream */
export interface StreamFunctionCallEvent {
    type: 'function_call';
    /** Raw NDJSON line string containing the function_call signal */
    rawLine: string;
    /** Index of the chunk in the stream */
    chunkIndex: number;
    /** Milliseconds since stream started */
    elapsedMs: number;
    /** Unique identifier for this stream session */
    streamId: string;
}

/** Event emitted for stream lifecycle */
export interface StreamLifecycleEvent {
    type: 'stream_start' | 'stream_end' | 'stream_error';
    streamId: string;
    url: string;
    /** Total chunks received (for stream_end) */
    totalChunks?: number;
}

export type StreamEvent = StreamFunctionCallEvent | StreamLifecycleEvent;

export type StreamEventListener = (event: StreamEvent) => void;
