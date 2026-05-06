/**
 * Stream module — Notion AI NDJSON stream interception
 *
 * Phase 1: Passive observer (detect function_call, emit events, no modification)
 * Phase 2: Will add cutoff (abort/drain-drop) — see plans/stream-pause-inject.md
 */

export { installStreamInterceptor, isStreamInterceptorActive, onStreamEvent } from './interceptor';
export { detectFunctionCall, extractFunctionCallIdentity, extractTextFromChunk, tryParseNDJSON } from './parser';
export type { FunctionCallIdentity } from './parser';
export type { StreamEvent, StreamEventListener, StreamFunctionCallEvent, StreamLifecycleEvent } from './types';

