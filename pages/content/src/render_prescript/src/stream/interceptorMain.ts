/**
 * Notion AI Stream Interceptor — MAIN World
 *
 * This script runs in the MAIN world (shared with Notion's page JS) via
 * manifest content_scripts with `world: "MAIN"` and `run_at: "document_start"`.
 *
 * Responsibilities (minimal — sensor only):
 * - Patch window.fetch before Notion caches it
 * - Detect runInferenceTranscript NDJSON streams
 * - Parse NDJSON lines, detect function_call signals
 * - Cutoff frontend stream when configured
 * - Emit structured events via window.postMessage to ISOLATED world
 *
 * Does NOT contain: mcpClient, storage, tool execution, UI, chrome APIs.
 *
 * Security model:
 * - Events emitted are UNTRUSTED OBSERVATIONS, not trusted commands
 * - ISOLATED world bridge must validate everything
 * - Config received via postMessage is locked after first application
 *
 * @see plans/main-world-interceptor-injection.md
 * @see outputs/main-world-injection-gpt-review-response-v2.md
 */

// ============================================================================
// Install Guard — prevent multiple injection (SPA navigation / re-inject)
// ============================================================================

const INSTALL_KEY = '__MCP_SA_NOTION_STREAM_INTERCEPTOR_INSTALLED_V1__';

if ((window as any)[INSTALL_KEY]) {
    // Already installed — bail silently
} else {
    Object.defineProperty(window, INSTALL_KEY, {
        value: true,
        writable: false,
        configurable: false,
    });

    // ============================================================================
    // Protocol Constants
    // ============================================================================

    const CHANNEL = 'mcp-superassistant.stream' as const;
    const DIRECTION = 'main-to-isolated' as const;
    const PROTOCOL_VERSION = 1 as const;
    const SOURCE_ID = 'notion-main-fetch-interceptor' as const;

    const CONFIG_CHANNEL = 'mcp-superassistant.stream.config' as const;
    const CONFIG_DIRECTION = 'isolated-to-main' as const;
    const BRIDGE_READY_CHANNEL = 'mcp-superassistant.stream.bridge-ready' as const;

    // Target endpoint — use precise URL matching
    const TARGET_PATHNAME = '/api/v3/runInferenceTranscript';

    // ============================================================================
    // Types (inline — no external imports in MAIN world)
    // ============================================================================

    interface FunctionCallIdentity {
        name: string | null;
        callId: string | null;
        arguments: string | null;
    }

    type StreamEventType =
        | 'stream_start'
        | 'stream_end'
        | 'stream_error'
        | 'function_call'
        | 'stream_cutoff'
        | 'stream_drain_complete';

    interface StreamEventPayload {
        type: StreamEventType;
        streamId: string;
        [key: string]: unknown;
    }

    interface MainToIsolatedMessage {
        channel: typeof CHANNEL;
        direction: typeof DIRECTION;
        version: typeof PROTOCOL_VERSION;
        source: typeof SOURCE_ID;
        event: StreamEventPayload;
    }

    interface CutoffConfig {
        cutoffEnabled: boolean;
        cutoffMode: 'drain-drop' | 'cancel';
        requireStructuredIdentity: boolean;
        maxDrainMs: number;
    }

    // ============================================================================
    // State
    // ============================================================================

    let streamCounter = 0;
    let bridgeReady = false;
    let configLocked = false;

    const pendingEvents: StreamEventPayload[] = [];
    const MAX_PENDING_EVENTS = 100;

    // Default config — conservative (cutoff disabled)
    let config: CutoffConfig = {
        cutoffEnabled: false,
        cutoffMode: 'drain-drop',
        requireStructuredIdentity: true,
        maxDrainMs: 30000,
    };

    // ============================================================================
    // Emit: postMessage to ISOLATED world (with bounded queue)
    // ============================================================================

    function emit(event: StreamEventPayload): void {
        if (!bridgeReady) {
            if (pendingEvents.length < MAX_PENDING_EVENTS) {
                pendingEvents.push(event);
            }
            return;
        }
        postEvent(event);
    }

    function postEvent(event: StreamEventPayload): void {
        const message: MainToIsolatedMessage = {
            channel: CHANNEL,
            direction: DIRECTION,
            version: PROTOCOL_VERSION,
            source: SOURCE_ID,
            event,
        };
        window.postMessage(message, window.location.origin);
    }

    // ============================================================================
    // Bridge Ready Listener + Config Receiver
    // ============================================================================

    window.addEventListener('message', (e: MessageEvent) => {
        // Only accept messages from same window & origin
        if (e.source !== window) return;
        if (e.origin !== window.location.origin) return;

        const data = e.data;
        if (!data || typeof data !== 'object') return;

        // Bridge ready signal from ISOLATED world
        if (data.channel === BRIDGE_READY_CHANNEL) {
            bridgeReady = true;
            // Flush pending events
            for (const event of pendingEvents.splice(0)) {
                postEvent(event);
            }
            return;
        }

        // Config message from ISOLATED world (locked after first application)
        if (
            data.channel === CONFIG_CHANNEL &&
            data.direction === CONFIG_DIRECTION &&
            !configLocked
        ) {
            const cfg = data.config;
            if (cfg && typeof cfg === 'object') {
                if (typeof cfg.cutoffEnabled === 'boolean') config.cutoffEnabled = cfg.cutoffEnabled;
                if (cfg.cutoffMode === 'drain-drop' || cfg.cutoffMode === 'cancel') config.cutoffMode = cfg.cutoffMode;
                if (typeof cfg.requireStructuredIdentity === 'boolean') config.requireStructuredIdentity = cfg.requireStructuredIdentity;
                if (typeof cfg.maxDrainMs === 'number' && cfg.maxDrainMs > 0) config.maxDrainMs = cfg.maxDrainMs;
                configLocked = true;
                // eslint-disable-next-line no-console
                console.log('[MCP-SA/MAIN] Config applied (locked):', config);
            }
            return;
        }
    });

    // ============================================================================
    // NDJSON Parser (inline — no external dependencies)
    // ============================================================================

    const FUNCTION_CALL_KEYWORDS = ['function_call', 'tool_use', 'tool_calls', 'name'];
    const MIN_KEYWORD_MATCHES = 2;
    const MAX_RAW_LINE_LENGTH = 65536; // 64KB cap per line

    function detectFunctionCall(line: string): boolean {
        if (!line || line.length < 10) return false;
        let matches = 0;
        for (const keyword of FUNCTION_CALL_KEYWORDS) {
            if (line.includes(keyword)) {
                matches++;
                if (matches >= MIN_KEYWORD_MATCHES) return true;
            }
        }
        return false;
    }

    function extractFunctionCallIdentity(line: string): FunctionCallIdentity | null {
        try {
            const obj = JSON.parse(line);
            if (!obj || typeof obj !== 'object') return null;

            // Format: { type: "function_call", name: "...", id: "...", arguments: "..." }
            if (obj.type === 'function_call') {
                return {
                    name: typeof obj.name === 'string' ? obj.name : null,
                    callId: typeof obj.id === 'string' ? obj.id : null,
                    arguments: typeof obj.arguments === 'string' ? obj.arguments : null,
                };
            }

            // Format: { function_call: { name: "...", arguments: "..." } }
            if (obj.function_call && typeof obj.function_call === 'object') {
                const fc = obj.function_call;
                return {
                    name: typeof fc.name === 'string' ? fc.name : null,
                    callId: typeof obj.id === 'string' ? obj.id : null,
                    arguments: typeof fc.arguments === 'string' ? fc.arguments : null,
                };
            }

            // Format: { tool_calls: [{ id: "...", function: { name: "...", arguments: "..." } }] }
            if (Array.isArray(obj.tool_calls) && obj.tool_calls.length > 0) {
                const tc = obj.tool_calls[0];
                const fn = tc.function;
                return {
                    name: fn && typeof fn.name === 'string' ? fn.name : null,
                    callId: typeof tc.id === 'string' ? tc.id : null,
                    arguments: fn && typeof fn.arguments === 'string' ? fn.arguments : null,
                };
            }

            // Format: { tool_use: { name: "...", input: {...} } }
            if (obj.tool_use && typeof obj.tool_use === 'object') {
                const tu = obj.tool_use;
                return {
                    name: typeof tu.name === 'string' ? tu.name : null,
                    callId: typeof tu.id === 'string' ? tu.id : null,
                    arguments: tu.input ? JSON.stringify(tu.input) : null,
                };
            }

            return null;
        } catch {
            return null;
        }
    }

    // ============================================================================
    // Background Drain (Phase 2)
    // ============================================================================

    async function drainBackground(
        reader: ReadableStreamDefaultReader<Uint8Array>,
        maxDrainMs: number,
        streamId: string,
    ): Promise<void> {
        let droppedChunks = 0;
        let droppedBytes = 0;
        const drainStart = performance.now();
        let timedOut = false;

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
            // Reader cancelled (watchdog or external) — expected
        } finally {
            clearTimeout(timeoutId);
        }

        const drainDurationMs = performance.now() - drainStart;
        emit({
            type: 'stream_drain_complete',
            streamId,
            droppedChunks,
            droppedBytes,
            drainDurationMs,
            timedOut,
        });
    }

    // ============================================================================
    // Observer Stream (wraps original response body)
    // ============================================================================

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

            async pull(controller) {
                try {
                    const { done, value } = await reader.read();

                    if (done) {
                        // Flush decoder
                        const remaining = decoder.decode();
                        if (remaining) buffer += remaining;

                        // Process remaining buffer
                        const lastLine = buffer.trim();
                        if (lastLine.length > 0 && lastLine.length <= MAX_RAW_LINE_LENGTH && !functionCallDetected && detectFunctionCall(lastLine)) {
                            const elapsed = performance.now() - startTime;
                            const identity = extractFunctionCallIdentity(lastLine);
                            emit({
                                type: 'function_call',
                                rawLine: lastLine.slice(0, MAX_RAW_LINE_LENGTH),
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
                    let cutoffIdentity: FunctionCallIdentity | null = null;

                    if (!functionCallDetected && value) {
                        const text = decoder.decode(value, { stream: true });
                        buffer += text;

                        // Process complete NDJSON lines (handle chunk boundaries correctly)
                        const lines = buffer.split('\n');
                        buffer = lines.pop() ?? ''; // Keep incomplete line in buffer

                        for (const line of lines) {
                            const trimmed = line.trim();
                            if (trimmed.length === 0) continue;
                            if (trimmed.length > MAX_RAW_LINE_LENGTH) continue; // Skip oversized lines

                            if (detectFunctionCall(trimmed)) {
                                const elapsed = performance.now() - startTime;
                                const identity = extractFunctionCallIdentity(trimmed);

                                emit({
                                    type: 'function_call',
                                    rawLine: trimmed.slice(0, MAX_RAW_LINE_LENGTH),
                                    identity,
                                    chunkIndex,
                                    elapsedMs: elapsed,
                                    streamId,
                                });

                                // Check if cutoff should trigger
                                if (config.cutoffEnabled) {
                                    const hasStructuredIdentity = identity !== null && identity.name !== null;
                                    if (!config.requireStructuredIdentity || hasStructuredIdentity) {
                                        functionCallDetected = true;
                                        shouldCutoff = true;
                                        cutoffIdentity = identity;
                                    }
                                    // else: identity gate not met, continue scanning
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

                        if (config.cutoffMode === 'cancel') {
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
                        // Background drain — fire-and-forget
                        drainBackground(reader, config.maxDrainMs, streamId).catch(() => { });
                        return;
                    }

                    // Normal passthrough
                    controller.enqueue(value);
                } catch (err) {
                    emit({ type: 'stream_error', streamId, url });
                    controller.error(err);
                }
            },

            cancel(reason) {
                return reader.cancel(reason);
            },
        });
    }

    // ============================================================================
    // Fetch Patch — the core interception
    // ============================================================================

    const originalFetch = window.fetch;

    // Guard: don't wrap if already wrapped
    if (!(originalFetch as any).__mcpSaWrapped) {
        const wrappedFetch = async function (
            input: RequestInfo | URL,
            init?: RequestInit,
        ): Promise<Response> {
            // Precise URL matching (not includes())
            let targetUrl: URL;
            try {
                const rawUrl = typeof input === 'string'
                    ? input
                    : input instanceof URL
                        ? input.href
                        : input.url;
                targetUrl = new URL(rawUrl, window.location.href);
            } catch {
                return originalFetch.call(window, input, init);
            }

            // Only intercept requests to the target endpoint on same origin
            if (
                targetUrl.origin !== window.location.origin ||
                targetUrl.pathname !== TARGET_PATHNAME
            ) {
                return originalFetch.call(window, input, init);
            }

            const streamId = `notion-ai-${++streamCounter}`;

            const response = await originalFetch.call(window, input, init);
            const contentType = response.headers.get('content-type') || '';

            // Only wrap NDJSON/JSON responses with a body
            if (!contentType.includes('ndjson') && !contentType.includes('json')) {
                return response;
            }

            if (!response.body) {
                return response;
            }

            // Emit stream_start only after confirming we will wrap
            emit({ type: 'stream_start', streamId, url: targetUrl.href });

            // Wrap the body with our observer
            const observedBody = createObserverStream(response.body, streamId, targetUrl.href);

            // Reconstruct Response preserving metadata
            const headers = new Headers(response.headers);
            return new Response(observedBody, {
                status: response.status,
                statusText: response.statusText,
                headers,
            });
        };

        Object.defineProperty(wrappedFetch, '__mcpSaWrapped', {
            value: true,
            writable: false,
            configurable: false,
        });

        // Preserve original fetch properties
        Object.defineProperty(wrappedFetch, 'name', { value: 'fetch' });

        window.fetch = wrappedFetch as typeof window.fetch;

        // eslint-disable-next-line no-console
        console.log('[MCP-SA/MAIN] Stream interceptor installed (MAIN world, document_start)');
    }
}
