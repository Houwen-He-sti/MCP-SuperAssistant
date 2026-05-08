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
 * - Same-origin page scripts can forge compatible postMessage events
 * - ISOLATED world bridge performs structural validation only (not authentication)
 * - The actual execution trust boundary is in streamToolBridge (downstream)
 * - Config received via postMessage uses monotonic seq (newer seq always wins)
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
    let lastAppliedConfigSeq = 0; // Only accept configs with seq > lastAppliedConfigSeq

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

        // Config message from ISOLATED world (monotonic seq — strictly increasing)
        if (
            data.channel === CONFIG_CHANNEL &&
            data.direction === CONFIG_DIRECTION
        ) {
            const incomingSeq = data.seq;
            if (!Number.isSafeInteger(incomingSeq) || incomingSeq <= lastAppliedConfigSeq) return;

            const cfg = data.config;
            if (cfg && typeof cfg === 'object') {
                if (typeof cfg.cutoffEnabled === 'boolean') config.cutoffEnabled = cfg.cutoffEnabled;
                if (cfg.cutoffMode === 'drain-drop' || cfg.cutoffMode === 'cancel') config.cutoffMode = cfg.cutoffMode;
                if (typeof cfg.requireStructuredIdentity === 'boolean') config.requireStructuredIdentity = cfg.requireStructuredIdentity;
                if (typeof cfg.maxDrainMs === 'number' && cfg.maxDrainMs > 0) config.maxDrainMs = cfg.maxDrainMs;
                lastAppliedConfigSeq = incomingSeq;
                // eslint-disable-next-line no-console
                console.log('[MCP-SA/MAIN] Config applied (seq=%d):', lastAppliedConfigSeq, config);
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
    // Notion Patch Format — cross-patch accumulator for JSONL function calls
    //
    // Notion streams function_call as proprietary JSONL embedded in text content
    // patches (type:"patch", o:"x"), split across multiple NDJSON lines:
    //   {"type":"function_call_start","name":"...","call_id":"..."}
    //   {"type":"parameter","key":"...","value":"..."}
    //   {"type":"function_call_end","call_id":"..."}
    // ============================================================================

    /** Extract text content from a Notion patch line (o:"x" extend operations on content paths) */
    function extractPatchTextContent(line: string): string | null {
        try {
            const obj = JSON.parse(line);
            if (obj?.type !== 'patch' || !Array.isArray(obj.v)) return null;

            let text = '';
            for (const op of obj.v) {
                if (op.o === 'x' && typeof op.v === 'string' && typeof op.p === 'string' && op.p.endsWith('/content')) {
                    text += op.v;
                }
            }
            return text || null;
        } catch {
            return null;
        }
    }

    /** Parse a complete JSONL block to extract function call identity */
    function extractIdentityFromJsonlBlock(text: string): FunctionCallIdentity | null {
        const lines = text.split('\n');
        let name: string | null = null;
        let callId: string | null = null;
        const args: Record<string, string> = {};

        for (const rawLine of lines) {
            const trimmed = rawLine.trim();
            if (!trimmed.startsWith('{')) continue;
            try {
                const obj = JSON.parse(trimmed);
                if (obj.type === 'function_call_start') {
                    name = typeof obj.name === 'string' ? obj.name : null;
                    callId = typeof obj.call_id === 'string' ? obj.call_id : null;
                } else if (obj.type === 'parameter' && typeof obj.key === 'string') {
                    args[obj.key] = typeof obj.value === 'string' ? obj.value : JSON.stringify(obj.value);
                }
            } catch {
                continue;
            }
        }

        if (!name) return null;

        return {
            name,
            callId,
            arguments: Object.keys(args).length > 0 ? JSON.stringify(args) : null,
        };
    }

    interface ScanResult {
        /** Whether a function_call was fully detected (identity resolved or unrecoverable) */
        detected: boolean;
        /** Extracted identity (null if format unrecognized) */
        identity: FunctionCallIdentity | null;
        /** The NDJSON line that first triggered detection */
        rawLine: string;
        /** Whether the scanner is still accumulating cross-patch data */
        accumulating: boolean;
    }

    /**
     * Create a stateful function_call scanner that handles both standard JSON
     * formats and Notion's cross-patch JSONL format.
     *
     * Usage: call processLine() for each trimmed NDJSON line. Check result:
     * - accumulating=true: scanner needs more lines, don't emit yet
     * - detected=true: function_call fully resolved, emit event
     * - detected=false && !accumulating: line is not a function_call
     */
    function createFunctionCallScanner() {
        let patchContentBuffer = '';
        let isAccumulating = false;
        let firstDetectionLine = '';

        function processLine(trimmedLine: string): ScanResult {
            // If accumulating patch content for a cross-patch function_call
            if (isAccumulating) {
                const patchText = extractPatchTextContent(trimmedLine);
                if (patchText !== null) {
                    patchContentBuffer += patchText;
                    if (patchContentBuffer.includes('function_call_end')) {
                        const identity = extractIdentityFromJsonlBlock(patchContentBuffer);
                        const rawLine = firstDetectionLine;
                        reset();
                        return { detected: true, identity, rawLine, accumulating: false };
                    }
                    // Still accumulating — need more patches
                    return { detected: false, identity: null, rawLine: '', accumulating: true };
                }
                // Non-patch line while accumulating — abort accumulation, try best-effort
                const identity = extractIdentityFromJsonlBlock(patchContentBuffer);
                const rawLine = firstDetectionLine;
                reset();
                if (identity !== null) {
                    return { detected: true, identity, rawLine, accumulating: false };
                }
                // Fall through to normal detection on current line
            }

            if (!detectFunctionCall(trimmedLine)) {
                return { detected: false, identity: null, rawLine: '', accumulating: false };
            }

            // Try standard extraction first (ChatGPT, etc.)
            const identity = extractFunctionCallIdentity(trimmedLine);
            if (identity !== null) {
                return { detected: true, identity, rawLine: trimmedLine, accumulating: false };
            }

            // Try Notion patch format
            const patchText = extractPatchTextContent(trimmedLine);
            if (patchText !== null && patchText.includes('function_call_start')) {
                patchContentBuffer = patchText;
                firstDetectionLine = trimmedLine;
                if (patchText.includes('function_call_end')) {
                    // Complete in one line
                    const patchIdentity = extractIdentityFromJsonlBlock(patchContentBuffer);
                    reset();
                    return { detected: true, identity: patchIdentity, rawLine: trimmedLine, accumulating: false };
                }
                // Need to accumulate more patches
                isAccumulating = true;
                return { detected: false, identity: null, rawLine: '', accumulating: true };
            }

            // Unknown format — emit with null identity (legacy behavior)
            return { detected: true, identity: null, rawLine: trimmedLine, accumulating: false };
        }

        function reset() {
            patchContentBuffer = '';
            isAccumulating = false;
            firstDetectionLine = '';
        }

        return { processLine };
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
    // Background Observer (reads stream independently — always completes)
    // Returns a consumer ReadableStream that receives the same chunks via push.
    // If consumer stops reading or cancels, we continue reading for event emission.
    // ============================================================================

    function createObservedStreamWithBackground(
        originalBody: ReadableStream<Uint8Array>,
        streamId: string,
        url: string,
    ): ReadableStream<Uint8Array> {
        const decoder = new TextDecoder();
        const originalReader = originalBody.getReader();
        let chunkIndex = 0;
        let functionCallDetected = false;
        const startTime = performance.now();
        let buffer = '';
        let consumerActive = true;
        let streamController: ReadableStreamDefaultController<Uint8Array>;
        const scanner = createFunctionCallScanner();

        // Consumer-facing stream (push-based: we enqueue from our background loop)
        const consumerStream = new ReadableStream<Uint8Array>({
            start(controller) {
                streamController = controller;
            },
            cancel() {
                // Consumer abandoned — we keep reading in background for events
                consumerActive = false;
            },
        });

        // Background loop: reads original body to completion, emits events,
        // and pushes chunks to consumer (if still active)
        (async () => {
            try {
                while (true) {
                    const { done, value } = await originalReader.read();

                    if (done) {
                        const remaining = decoder.decode();
                        if (remaining) buffer += remaining;

                        const lastLine = buffer.trim();
                        if (lastLine.length > 0 && lastLine.length <= MAX_RAW_LINE_LENGTH && !functionCallDetected) {
                            const result = scanner.processLine(lastLine);
                            if (result.detected) {
                                const elapsed = performance.now() - startTime;
                                emit({
                                    type: 'function_call',
                                    rawLine: result.rawLine.slice(0, MAX_RAW_LINE_LENGTH),
                                    identity: result.identity,
                                    chunkIndex,
                                    elapsedMs: elapsed,
                                    streamId,
                                });
                            }
                        }
                        emit({ type: 'stream_end', streamId, url, totalChunks: chunkIndex });
                        if (consumerActive) {
                            try { streamController.close(); } catch { /* already closed */ }
                        }
                        return;
                    }

                    chunkIndex++;

                    // Push to consumer (best-effort — if they cancelled, we still continue)
                    if (consumerActive) {
                        try { streamController.enqueue(value); } catch { consumerActive = false; }
                    }

                    // Scan for function_call (scanner handles cross-patch accumulation)
                    if (!functionCallDetected && value) {
                        const text = decoder.decode(value, { stream: true });
                        buffer += text;

                        const lines = buffer.split('\n');
                        buffer = lines.pop() ?? '';

                        if (buffer.length > MAX_RAW_LINE_LENGTH * 2) {
                            buffer = '';
                        }

                        for (const line of lines) {
                            const trimmed = line.trim();
                            if (trimmed.length === 0) continue;
                            if (trimmed.length > MAX_RAW_LINE_LENGTH) continue;

                            const result = scanner.processLine(trimmed);
                            if (result.accumulating) continue; // Need more patches
                            if (result.detected) {
                                const elapsed = performance.now() - startTime;

                                emit({
                                    type: 'function_call',
                                    rawLine: result.rawLine.slice(0, MAX_RAW_LINE_LENGTH),
                                    identity: result.identity,
                                    chunkIndex,
                                    elapsedMs: elapsed,
                                    streamId,
                                });

                                functionCallDetected = true;
                                break;
                            }
                        }
                    }
                }
            } catch {
                emit({ type: 'stream_error', streamId, url });
                if (consumerActive) {
                    try { streamController.close(); } catch { /* ignore */ }
                }
            }
        })();

        return consumerStream;
    }

    // ============================================================================
    // Observer Stream with Cutoff (wraps response body — consumer drives reading)
    // Used when cutoffEnabled=true to allow closing the consumer stream on function_call.
    // ============================================================================

    function createObserverStreamWithCutoff(
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
        const scanner = createFunctionCallScanner();

        return new ReadableStream<Uint8Array>({
            start() {
                reader = originalBody.getReader();
            },

            async pull(controller) {
                try {
                    const { done, value } = await reader.read();

                    if (done) {
                        const remaining = decoder.decode();
                        if (remaining) buffer += remaining;

                        const lastLine = buffer.trim();
                        if (lastLine.length > 0 && lastLine.length <= MAX_RAW_LINE_LENGTH && !functionCallDetected) {
                            const result = scanner.processLine(lastLine);
                            if (result.detected) {
                                const elapsed = performance.now() - startTime;
                                emit({
                                    type: 'function_call',
                                    rawLine: result.rawLine.slice(0, MAX_RAW_LINE_LENGTH),
                                    identity: result.identity,
                                    chunkIndex,
                                    elapsedMs: elapsed,
                                    streamId,
                                });
                            }
                        }
                        emit({ type: 'stream_end', streamId, url, totalChunks: chunkIndex });
                        controller.close();
                        return;
                    }

                    chunkIndex++;

                    let shouldCutoff = false;
                    let cutoffIdentity: FunctionCallIdentity | null = null;

                    if (!functionCallDetected && value) {
                        const text = decoder.decode(value, { stream: true });
                        buffer += text;

                        const lines = buffer.split('\n');
                        buffer = lines.pop() ?? '';

                        if (buffer.length > MAX_RAW_LINE_LENGTH * 2) {
                            // eslint-disable-next-line no-console
                            console.warn('[MCP-SA/MAIN] Dropping oversized partial NDJSON line (%d chars)', buffer.length);
                            buffer = '';
                        }

                        for (const line of lines) {
                            const trimmed = line.trim();
                            if (trimmed.length === 0) continue;
                            if (trimmed.length > MAX_RAW_LINE_LENGTH) continue;

                            const result = scanner.processLine(trimmed);
                            if (result.accumulating) continue; // Need more patches

                            if (result.detected) {
                                const elapsed = performance.now() - startTime;

                                emit({
                                    type: 'function_call',
                                    rawLine: result.rawLine.slice(0, MAX_RAW_LINE_LENGTH),
                                    identity: result.identity,
                                    chunkIndex,
                                    elapsedMs: elapsed,
                                    streamId,
                                });

                                const hasStructuredIdentity = result.identity !== null && result.identity.name !== null;
                                if (!config.requireStructuredIdentity || hasStructuredIdentity) {
                                    functionCallDetected = true;
                                    shouldCutoff = true;
                                    cutoffIdentity = result.identity;
                                }
                                break;
                            }
                        }
                    }

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

                        // Drain-drop mode
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
                        drainBackground(reader, config.maxDrainMs, streamId).catch(() => { });
                        return;
                    }

                    controller.enqueue(value);
                } catch (err) {
                    emit({ type: 'stream_error', streamId, url });
                    controller.error(err);
                }
            },

            cancel(reason) {
                // Consumer abandoned the stream — emit stream_end so lifecycle is complete
                emit({ type: 'stream_end', streamId, url, totalChunks: chunkIndex, cancelled: true });
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

            if (config.cutoffEnabled) {
                // Cutoff path: wrap body with observer stream that can close consumer on function_call
                const observedBody = createObserverStreamWithCutoff(response.body, streamId, targetUrl.href);
                const headers = new Headers(response.headers);
                return new Response(observedBody, {
                    status: response.status,
                    statusText: response.statusText,
                    headers,
                });
            }

            // Non-cutoff path: background reader that always completes.
            // Consumer gets a push-based stream. If consumer abandons (e.g., SPA navigation),
            // we continue reading for event emission (stream_end always fires).
            const consumerBody = createObservedStreamWithBackground(response.body, streamId, targetUrl.href);

            // Reconstruct Response preserving metadata
            const headers = new Headers(response.headers);
            return new Response(consumerBody, {
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
