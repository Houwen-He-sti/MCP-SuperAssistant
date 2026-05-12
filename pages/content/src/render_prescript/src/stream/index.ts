/**
 * Stream module — Notion AI NDJSON stream interception
 *
 * Phase 1: Passive observer (detect function_call, emit events)
 * Phase 2: Function-call cutoff (close frontend, drain background)
 * Phase 3: Stream → Tool execution bridge
 */

export { configureCutoff, installStreamInterceptor, isStreamInterceptorActive, onStreamEvent } from './interceptor';
export { detectFunctionCall, extractFunctionCallIdentity, extractTextFromChunk, tryParseNDJSON } from './parser';
export type { FunctionCallIdentity } from './parser';
export { createStreamToolHandler, MAX_ARGS_SIZE } from './streamToolBridge';
export type {
    AdapterLike,
    ExecutionGuardLike,
    McpClientLike,
    StorageLike,
    StreamToolBridgeConfig,
    StreamToolBridgeDeps,
    StreamToolExecutionEvent
} from './streamToolBridge';
export { configureStreamToolBridge, getStreamToolBridgeInfo, initStreamToolBridge } from './streamToolBridgeInit';
export type {
    StreamCutoffConfig,
    StreamCutoffEvent,
    StreamDrainCompleteEvent,
    StreamEvent,
    StreamEventListener,
    StreamFunctionCallEvent,
    StreamLifecycleEvent
} from './types';
export type {
    InterceptRequestContext,
    StreamChunkContent,
    StreamFormat,
    StreamProviderAdapter,
    StreamProviderRegistration
} from './stream-provider.types';

