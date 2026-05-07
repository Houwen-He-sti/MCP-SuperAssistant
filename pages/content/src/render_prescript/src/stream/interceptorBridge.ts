/**
 * Stream Interceptor Bridge — ISOLATED World
 *
 * Receives stream events from the MAIN world interceptor via postMessage,
 * validates them, and routes to existing stream event listeners.
 *
 * This replaces direct subscription to the ISOLATED world interceptor for Notion.
 * Other providers continue to use the ISOLATED interceptor directly.
 *
 * Security model:
 * - All messages from MAIN world are treated as UNTRUSTED OBSERVATIONS
 * - Bridge performs STRUCTURAL validation only — not authentication
 * - Same-origin page scripts can forge compatible envelopes (source_id is not a credential)
 * - Does NOT make trust decisions — downstream streamToolBridge owns execution policy
 * - The bridge accepts observations, not authority
 *
 * @see interceptorMain.ts (MAIN world counterpart)
 * @see outputs/main-world-injection-gpt-review-response-v2.md
 */

import { createLogger } from '@extension/shared/lib/logger';
import type { StreamEvent, StreamEventListener, StreamCutoffConfig } from './types';
import type { FunctionCallIdentity } from './parser';

const logger = createLogger('InterceptorBridge');

// ============================================================================
// Protocol Constants (must match interceptorMain.ts)
// ============================================================================

const CHANNEL = 'mcp-superassistant.stream' as const;
const DIRECTION = 'main-to-isolated' as const;
const PROTOCOL_VERSION = 1;
const SOURCE_ID = 'notion-main-fetch-interceptor' as const;

const CONFIG_CHANNEL = 'mcp-superassistant.stream.config' as const;
const CONFIG_DIRECTION = 'isolated-to-main' as const;
const BRIDGE_READY_CHANNEL = 'mcp-superassistant.stream.bridge-ready' as const;

// ============================================================================
// Validation
// ============================================================================

/** Allowed event types from MAIN world */
const VALID_EVENT_TYPES = new Set([
  'stream_start',
  'stream_end',
  'stream_error',
  'function_call',
  'stream_cutoff',
  'stream_drain_complete',
]);

/** Max raw line length we'll accept */
const MAX_RAW_LINE_LENGTH = 65536;

/**
 * Validate the envelope structure of a MAIN → ISOLATED message.
 */
function isValidEnvelope(data: unknown): data is {
  channel: string;
  direction: string;
  version: number;
  source: string;
  event: Record<string, unknown>;
} {
  if (!data || typeof data !== 'object') return false;
  const obj = data as Record<string, unknown>;
  return (
    obj.channel === CHANNEL &&
    obj.direction === DIRECTION &&
    obj.version === PROTOCOL_VERSION &&
    obj.source === SOURCE_ID &&
    obj.event !== null &&
    typeof obj.event === 'object'
  );
}

/**
 * Validate and coerce MAIN world event into a typed StreamEvent.
 * Returns null if validation fails.
 */
function validateStreamEvent(raw: Record<string, unknown>): StreamEvent | null {
  const type = raw.type;
  if (typeof type !== 'string' || !VALID_EVENT_TYPES.has(type)) {
    logger.warn('Rejected event: invalid type', type);
    return null;
  }

  const streamId = raw.streamId;
  if (typeof streamId !== 'string' || streamId.length === 0 || streamId.length > 100) {
    logger.warn('Rejected event: invalid streamId');
    return null;
  }

  switch (type) {
    case 'stream_start':
    case 'stream_end':
    case 'stream_error': {
      const url = raw.url;
      if (typeof url !== 'string') {
        logger.warn('Rejected lifecycle event: missing url');
        return null;
      }
      const event: StreamEvent = { type, streamId, url } as StreamEvent;
      if (type === 'stream_end' && typeof raw.totalChunks === 'number') {
        (event as any).totalChunks = raw.totalChunks;
      }
      return event;
    }

    case 'function_call': {
      const rawLine = raw.rawLine;
      if (typeof rawLine !== 'string' || rawLine.length > MAX_RAW_LINE_LENGTH) {
        logger.warn('Rejected function_call: rawLine invalid or too large');
        return null;
      }
      const identity = validateIdentity(raw.identity);
      return {
        type: 'function_call',
        streamId,
        rawLine,
        identity,
        chunkIndex: typeof raw.chunkIndex === 'number' ? raw.chunkIndex : 0,
        elapsedMs: typeof raw.elapsedMs === 'number' ? raw.elapsedMs : 0,
      };
    }

    case 'stream_cutoff': {
      const identity = validateIdentity(raw.identity);
      return {
        type: 'stream_cutoff',
        streamId,
        cutoffChunkIndex: typeof raw.cutoffChunkIndex === 'number' ? raw.cutoffChunkIndex : 0,
        elapsedMs: typeof raw.elapsedMs === 'number' ? raw.elapsedMs : 0,
        identity,
        reason: 'function_call_detected',
        forwardedTriggerChunk: typeof raw.forwardedTriggerChunk === 'boolean' ? raw.forwardedTriggerChunk : false,
        mode: raw.mode === 'cancel' ? 'cancel' : 'drain-drop',
      };
    }

    case 'stream_drain_complete': {
      return {
        type: 'stream_drain_complete',
        streamId,
        droppedChunks: typeof raw.droppedChunks === 'number' ? raw.droppedChunks : 0,
        droppedBytes: typeof raw.droppedBytes === 'number' ? raw.droppedBytes : 0,
        drainDurationMs: typeof raw.drainDurationMs === 'number' ? raw.drainDurationMs : 0,
        timedOut: typeof raw.timedOut === 'boolean' ? raw.timedOut : false,
      };
    }

    default:
      return null;
  }
}

/**
 * Validate a function call identity object.
 */
function validateIdentity(raw: unknown): FunctionCallIdentity | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  return {
    name: typeof obj.name === 'string' ? obj.name : null,
    callId: typeof obj.callId === 'string' ? obj.callId : null,
    arguments: typeof obj.arguments === 'string' ? obj.arguments : null,
  };
}

// ============================================================================
// Listener Management (same API as interceptor.ts)
// ============================================================================

const listeners: Set<StreamEventListener> = new Set();
let installed = false;

/**
 * Register a listener for stream events received from MAIN world.
 * Same API as interceptor.ts onStreamEvent.
 */
export function onStreamEvent(listener: StreamEventListener): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/**
 * Emit a validated stream event to all registered listeners.
 */
function emit(event: StreamEvent): void {
  for (const listener of listeners) {
    try {
      listener(event);
    } catch (err) {
      logger.error('Stream event listener error:', err);
    }
  }
}

// ============================================================================
// Message Handler
// ============================================================================

function handleMessage(e: MessageEvent): void {
  // Security checks
  if (e.source !== window) return;
  if (e.origin !== window.location.origin) return;

  // Envelope validation
  if (!isValidEnvelope(e.data)) return;

  // Event validation
  const event = validateStreamEvent(e.data.event as Record<string, unknown>);
  if (!event) return;

  logger.debug('Bridge received:', event.type, (event as any).streamId);
  emit(event);
}

// ============================================================================
// Installation & Config Sync
// ============================================================================

/**
 * Install the MAIN world stream bridge listener.
 * Should be called once during content script initialization on Notion.
 */
export function installMainWorldStreamBridge(): void {
  if (installed) return;
  if (typeof window === 'undefined') return;

  window.addEventListener('message', handleMessage);
  installed = true;

  // Signal to MAIN world that bridge is ready (flush pending events)
  window.postMessage({ channel: BRIDGE_READY_CHANNEL }, window.location.origin);

  logger.info('MAIN world stream bridge installed (ISOLATED world listener)');
}

/**
 * Send cutoff configuration to the MAIN world interceptor.
 * Uses monotonic seq to ensure MAIN world always accepts newer configs.
 */
let configSeqCounter = 0;

export function sendConfigToMainWorld(config: Partial<StreamCutoffConfig>): void {
  if (typeof window === 'undefined') return;

  const seq = ++configSeqCounter;

  window.postMessage(
    {
      channel: CONFIG_CHANNEL,
      direction: CONFIG_DIRECTION,
      seq,
      config: {
        cutoffEnabled: config.enabled,
        cutoffMode: config.mode,
        requireStructuredIdentity: config.requireStructuredIdentity,
        maxDrainMs: config.maxDrainMs,
      },
    },
    window.location.origin,
  );

  logger.info('Config sent to MAIN world (seq=%d):', seq, config);
}

/**
 * Check if the bridge is installed.
 */
export function isMainWorldBridgeActive(): boolean {
  return installed;
}
