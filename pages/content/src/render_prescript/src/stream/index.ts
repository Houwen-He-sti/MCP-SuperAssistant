/**
 * Stream module — Notion AI NDJSON stream interception
 *
 * Phase 1: Passive observer (detect function_call, emit events, no modification)
 * Phase 2: Will add cutoff (abort/drain-drop) — see plans/stream-pause-inject.md
 */

export { installStreamInterceptor, onStreamEvent, isStreamInterceptorActive } from './interceptor';
export { detectFunctionCall, tryParseNDJSON, extractTextFromChunk } from './parser';
export type { StreamEvent, StreamFunctionCallEvent, StreamLifecycleEvent, StreamEventListener } from './types';
