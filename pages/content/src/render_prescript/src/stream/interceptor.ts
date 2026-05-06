/**
 * Notion AI Stream Interceptor — Phase 1: Passive NDJSON Observer
 *
 * Intercepts fetch requests to runInferenceTranscript, wraps the ReadableStream
 * with a passthrough observer that detects function_call signals in NDJSON chunks.
 *
 * Phase 1 is purely observational — it does NOT modify, pause, or abort the stream.
 * It emits events via a listener callback when function_call is detected.
 *
 * References:
 * - Plan: plans/stream-pause-inject.md (PR #23)
 * - Evidence: scripts/temp/phase0-final-evidence.md
 */

import { createLogger } from '@extension/shared/lib/logger';
import { detectFunctionCall } from './parser';
import type { StreamEvent, StreamEventListener } from './types';

const logger = createLogger('StreamInterceptor');

/** Target endpoint confirmed by Phase 0 PoC */
const TARGET_ENDPOINT = 'runInferenceTranscript';

/** Listeners registered for stream events */
const listeners: Set<StreamEventListener> = new Set();

/** Whether the interceptor has been installed */
let installed = false;

/** Counter for generating unique stream IDs */
let streamCounter = 0;

/**
 * Register a listener for stream events.
 */
export function onStreamEvent(listener: StreamEventListener): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/**
 * Emit a stream event to all registered listeners.
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

/**
 * Create an observer TransformStream that passes through all chunks unchanged
 * while scanning for function_call signals in the NDJSON text.
 */
function createObserverStream(
  originalBody: ReadableStream<Uint8Array>,
  streamId: string,
  url: string,
): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder();
  let chunkIndex = 0;
  let functionCallDetected = false;
  const startTime = performance.now();
  let buffer = '';

  return new ReadableStream<Uint8Array>({
    start(controller) {
      const reader = originalBody.getReader();

      const pump = (): Promise<void> =>
        reader.read().then(({ done, value }) => {
          if (done) {
            // Process any remaining buffer
            if (buffer.length > 0) {
              processLine(buffer, streamId, startTime, chunkIndex);
            }
            emit({ type: 'stream_end', streamId, url, totalChunks: chunkIndex });
            controller.close();
            return;
          }

          chunkIndex++;

          // Decode and scan for function_call (passive observation)
          if (!functionCallDetected && value) {
            const text = decoder.decode(value, { stream: true });
            buffer += text;

            // Process complete lines (NDJSON = one JSON object per line)
            const lines = buffer.split('\n');
            // Keep last incomplete line in buffer
            buffer = lines.pop() || '';

            for (const line of lines) {
              const trimmed = line.trim();
              if (trimmed.length === 0) continue;
              if (processLine(trimmed, streamId, startTime, chunkIndex)) {
                functionCallDetected = true;
                break;
              }
            }
          }

          // Pass through unchanged (Phase 1: no modification)
          controller.enqueue(value);
          return pump();
        }).catch(err => {
          emit({ type: 'stream_error', streamId, url });
          controller.error(err);
        });

      pump();
    },
  });
}

/**
 * Process a single NDJSON line, check for function_call.
 * Returns true if function_call was detected.
 */
function processLine(
  line: string,
  streamId: string,
  startTime: number,
  chunkIndex: number,
): boolean {
  if (detectFunctionCall(line)) {
    const elapsed = performance.now() - startTime;
    logger.info(
      `[${streamId}] function_call detected at chunk #${chunkIndex}, ${elapsed.toFixed(0)}ms`,
    );

    emit({
      type: 'function_call',
      chunk: line,
      chunkIndex,
      elapsedMs: elapsed,
      streamId,
    });
    return true;
  }
  return false;
}

/**
 * Install the fetch interceptor. Must be called early (document_start, MAIN world)
 * to override fetch before Notion's bundle caches it.
 *
 * Safe to call multiple times — only installs once.
 */
export function installStreamInterceptor(): void {
  if (installed) return;

  // Only install on notion.so
  if (!window.location.hostname.includes('notion.so')) return;

  const originalFetch = window.fetch;

  window.fetch = async function (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> {
    const url = typeof input === 'string'
      ? input
      : input instanceof URL
        ? input.href
        : input.url;

    // Only intercept the target endpoint
    if (!url.includes(TARGET_ENDPOINT)) {
      return originalFetch.call(window, input, init);
    }

    const streamId = `notion-ai-${++streamCounter}`;
    logger.info(`[${streamId}] Intercepting: ${url}`);
    emit({ type: 'stream_start', streamId, url });

    const response = await originalFetch.call(window, input, init);
    const contentType = response.headers.get('content-type') || '';

    // Only wrap NDJSON responses with a body
    if (!contentType.includes('ndjson') && !contentType.includes('json')) {
      return response;
    }

    if (!response.body) {
      return response;
    }

    // Wrap the body with our passive observer
    const observedBody = createObserverStream(response.body, streamId, url);

    return new Response(observedBody, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  };

  installed = true;
  logger.info('Stream interceptor installed (Phase 1: passive observer)');
}

/**
 * Check if the interceptor is active.
 */
export function isStreamInterceptorActive(): boolean {
  return installed;
}
