/**
 * Stream module — Notion AI NDJSON stream interception
 *
 * Phase 1: Passive observer (detect function_call, emit events)
 * Phase 2: Function-call cutoff (close frontend, drain background)
 */

export { configureCutoff, installStreamInterceptor, isStreamInterceptorActive, onStreamEvent } from './interceptor';
export { detectFunctionCall, extractFunctionCallIdentity, extractTextFromChunk, tryParseNDJSON } from './parser';
export type { FunctionCallIdentity } from './parser';
export type {
    StreamCutoffConfig,
    StreamCutoffEvent,
    StreamDrainCompleteEvent,
    StreamEvent,
    StreamEventListener,
    StreamFunctionCallEvent,
    StreamLifecycleEvent,
} from './types';

