/**
 * Notion AI Stream Interceptor — Phase 1 + Phase 2
 *
 * Phase 1: Passive NDJSON observer (detect function_call, emit events)
 * Phase 2: Function-call cutoff (close frontend stream, drain background)
 *
 * Intercepts fetch requests to runInferenceTranscript, wraps the ReadableStream
 * with an observer that detects function_call signals in NDJSON chunks.
 * When cutoff is enabled and a structured function_call identity is found,
 * the frontend stream is closed and remaining chunks are drained in the background.
 *
 * References:
 * - Plan: plans/stream-pause-inject.md (PR #23)
 * - Phase 2 plan: plans/stream-intercept-phase2.md (PR #27)
 * - Evidence: scripts/temp/phase0-final-evidence.md
 */

import { createLogger } from '@extension/shared/lib/logger';
import { detectFunctionCall, extractFunctionCallIdentity } from './parser';
import type { StreamCutoffConfig, StreamEvent, StreamEventListener } from './types';

const logger = createLogger('StreamInterceptor');

/** Target endpoint confirmed by Phase 0 PoC */
const TARGET_ENDPOINT = 'runInferenceTranscript';

/** Listeners registered for stream events */
const listeners: Set<StreamEventListener> = new Set();

/** Whether the interceptor has been installed */
let installed = false;

/** Counter for generating unique stream IDs */
let streamCounter = 0;

/** Default cutoff configuration (Phase 2 disabled by default for safety) */
const DEFAULT_CUTOFF_CONFIG: StreamCutoffConfig = {
    enabled: false,
    mode: 'drain-drop',
    requireStructuredIdentity: true,
    maxDrainMs: 30000,
};

/** Active cutoff configuration */
let cutoffConfig: StreamCutoffConfig = { ...DEFAULT_CUTOFF_CONFIG };

/**
 * Configure the cutoff behavior. Call before installStreamInterceptor().
 */
export function configureCutoff(config: Partial<StreamCutoffConfig>): void {
    cutoffConfig = { ...cutoffConfig, ...config };
    logger.info('Cutoff configured:', cutoffConfig);
}

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
 * Drain the upstream reader in the background, discarding all chunks.
 * Used in drain-drop mode after closing the frontend stream.
 *
 * Tracks statistics (dropped chunks/bytes) and emits stream_drain_complete.
 * Respects maxDrainMs watchdog — force-cancels if drain takes too long.
 */
async function drainBackground(
    reader: ReadableStreamDefaultReader<Uint8Array>,
    maxDrainMs: number,
    streamId: string,
): Promise<void> {
    let droppedChunks = 0;
    let droppedBytes = 0;
    const drainStart = performance.now();
    let timedOut = false;

    // Watchdog timer
    const timeoutId = setTimeout(() => {
        timedOut = true;
        reader.cancel('drain watchdog timeout').catch(() => { });
    }, maxDrainMs);

    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            droppedChunks++;
            droppedBytes += value?.byteLength ?? 0;
        }
    } catch {
        // Reader was cancelled (watchdog or external), that's expected
    } finally {
        clearTimeout(timeoutId);
    }

    const drainDurationMs = performance.now() - drainStart;
    logger.info(
        `[${streamId}] Drain complete: ${droppedChunks} chunks, ${droppedBytes} bytes, ` +
        `${drainDurationMs.toFixed(0)}ms${timedOut ? ' (timed out)' : ''}`,
    );

    emit({
        type: 'stream_drain_complete',
        streamId,
        droppedChunks,
        droppedBytes,
        drainDurationMs,
        timedOut,
    });
}

/**
 * Create an observer stream that detects function_call signals in NDJSON text.
 *
 * Phase 1 (cutoff disabled): passes through all chunks unchanged.
 * Phase 2 (cutoff enabled): after detecting a function_call with structured identity,
 * forwards the trigger chunk, closes the frontend stream, and drains background.
 *
 * Uses pull-based semantics to preserve backpressure from downstream consumer.
 * cancel() is propagated to the original reader.
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
    let reader: ReadableStreamDefaultReader<Uint8Array>;

    return new ReadableStream<Uint8Array>({
        start() {
            reader = originalBody.getReader();
        },

        // pull() is called by the downstream consumer when it wants more data.
        // This preserves natural backpressure — we only read from upstream
        // when downstream is ready to receive.
        async pull(controller) {
            try {
                const { done, value } = await reader.read();

                if (done) {
                    // Flush the decoder (handle any remaining partial multi-byte sequences)
                    const remaining = decoder.decode();
                    if (remaining) {
                        buffer += remaining;
                    }
                    // Process any remaining buffer for function_call detection
                    const lastLine = buffer.trim();
                    if (lastLine.length > 0 && !functionCallDetected && detectFunctionCall(lastLine)) {
                        const elapsed = performance.now() - startTime;
                        const identity = extractFunctionCallIdentity(lastLine);
                        emit({
                            type: 'function_call',
                            rawLine: lastLine,
                            identity,
                            chunkIndex,
                            elapsedMs: elapsed,
                            streamId,
                        });
                    }
                    emit({ type: 'stream_end', streamId, url, totalChunks: chunkIndex });
                    controller.close();
                    return;
                }

                chunkIndex++;

                // Decode and scan for function_call
                let shouldCutoff = false;
                let cutoffIdentity = null;

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

                        if (detectFunctionCall(trimmed)) {
                            const elapsed = performance.now() - startTime;
                            const identity = extractFunctionCallIdentity(trimmed);

                            logger.info(
                                `[${streamId}] function_call detected at chunk #${chunkIndex}, ${elapsed.toFixed(0)}ms` +
                                (identity?.name ? ` — ${identity.name}` : ''),
                            );

                            emit({
                                type: 'function_call',
                                rawLine: trimmed,
                                identity,
                                chunkIndex,
                                elapsedMs: elapsed,
                                streamId,
                            });

                            // Phase 2: check if cutoff should trigger
                            if (cutoffConfig.enabled) {
                                const hasStructuredIdentity = identity !== null && identity.name !== null;
                                if (!cutoffConfig.requireStructuredIdentity || hasStructuredIdentity) {
                                    functionCallDetected = true;
                                    shouldCutoff = true;
                                    cutoffIdentity = identity;
                                } else {
                                    // Identity gate failed — do NOT set functionCallDetected
                                    // so future chunks can still trigger cutoff if a valid
                                    // structured function_call arrives later.
                                    logger.info(
                                        `[${streamId}] Cutoff skipped: identity gate not met (requireStructuredIdentity=true)`,
                                    );
                                    continue;
                                }
                            } else {
                                functionCallDetected = true;
                            }
                            break;
                        }
                    }
                }

                // Phase 2: execute cutoff
                if (shouldCutoff) {
                    const elapsed = performance.now() - startTime;

                    if (cutoffConfig.mode === 'cancel') {
                        // Cancel mode: forward trigger chunk, cancel reader, close stream
                        controller.enqueue(value);
                        emit({
                            type: 'stream_cutoff',
                            streamId,
                            cutoffChunkIndex: chunkIndex,
                            elapsedMs: elapsed,
                            identity: cutoffIdentity,
                            reason: 'function_call_detected',
                            forwardedTriggerChunk: true,
                            mode: 'cancel',
                        });
                        await reader.cancel('function_call cutoff');
                        controller.close();
                        emit({ type: 'stream_end', streamId, url, totalChunks: chunkIndex });
                        return;
                    }

                    // Drain-drop mode: forward trigger chunk, close frontend, drain background
                    controller.enqueue(value);
                    emit({
                        type: 'stream_cutoff',
                        streamId,
                        cutoffChunkIndex: chunkIndex,
                        elapsedMs: elapsed,
                        identity: cutoffIdentity,
                        reason: 'function_call_detected',
                        forwardedTriggerChunk: true,
                        mode: 'drain-drop',
                    });
                    controller.close();
                    emit({ type: 'stream_end', streamId, url, totalChunks: chunkIndex });
                    // Background drain — fire-and-forget (errors logged inside)
                    drainBackground(reader, cutoffConfig.maxDrainMs, streamId).catch((err) => {
                        logger.error(`[${streamId}] Background drain error:`, err);
                    });
                    return;
                }

                // Normal passthrough
                controller.enqueue(value);
            } catch (err) {
                emit({ type: 'stream_error', streamId, url });
                controller.error(err);
            }
        },

        // Propagate cancel to the original reader
        cancel(reason) {
            return reader.cancel(reason);
        },
    });
}

/**
 * Install the fetch interceptor. Must be called early (document_start, MAIN world)
 * to override fetch before Notion's bundle caches it.
 *
 * Safe to call multiple times — only installs once.
 * No-ops in non-browser environments (Node/test).
 */
export function installStreamInterceptor(): void {
    if (installed) return;

    // Browser guard: skip in Node/test environments
    if (typeof window === 'undefined' || typeof window.fetch !== 'function') return;

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

        const response = await originalFetch.call(window, input, init);
        const contentType = response.headers.get('content-type') || '';

        // Only wrap NDJSON responses with a body
        if (!contentType.includes('ndjson') && !contentType.includes('json')) {
            return response;
        }

        if (!response.body) {
            return response;
        }

        // Emit stream_start only after confirming we will wrap the stream
        emit({ type: 'stream_start', streamId, url });

        // Wrap the body with our passive observer
        const observedBody = createObserverStream(response.body, streamId, url);

        return new Response(observedBody, {
            status: response.status,
            statusText: response.statusText,
            headers: response.headers,
        });
    };

    installed = true;
    logger.info(
        `Stream interceptor installed (cutoff ${cutoffConfig.enabled ? 'enabled' : 'disabled'}, mode=${cutoffConfig.mode})`,
    );
}

/**
 * Check if the interceptor is active.
 */
export function isStreamInterceptorActive(): boolean {
    return installed;
}
