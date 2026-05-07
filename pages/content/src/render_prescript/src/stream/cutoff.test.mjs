/**
 * Unit tests for Phase 2: Stream cutoff logic
 *
 * Tests the createObserverStream cutoff behavior using mock ReadableStreams.
 * Does NOT test the fetch interceptor (that requires a browser environment).
 *
 * Run: node cutoff.test.mjs
 * (from render_prescript/src/stream/ directory)
 */

// --- Inline helpers (matching parser.ts + interceptor.ts logic) ---

const FUNCTION_CALL_KEYWORDS = ['function_call', 'tool_use', 'tool_calls', 'name'];
const MIN_KEYWORD_MATCHES = 2;

function detectFunctionCall(line) {
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

function tryParseNDJSON(line) {
    try { return JSON.parse(line); } catch { return null; }
}

function extractFunctionCallIdentity(line) {
    const parsed = tryParseNDJSON(line);
    if (!parsed || typeof parsed !== 'object') return null;
    if (parsed.type === 'function_call') {
        return {
            name: typeof parsed.name === 'string' ? parsed.name : null,
            callId: typeof parsed.id === 'string' ? parsed.id : null,
            arguments: typeof parsed.arguments === 'string' ? parsed.arguments : null,
        };
    }
    if (parsed.function_call && typeof parsed.function_call === 'object') {
        const fc = parsed.function_call;
        return {
            name: typeof fc.name === 'string' ? fc.name : null,
            callId: typeof parsed.id === 'string' ? parsed.id : null,
            arguments: typeof fc.arguments === 'string' ? fc.arguments : null,
        };
    }
    if (Array.isArray(parsed.tool_calls) && parsed.tool_calls.length > 0) {
        const tc = parsed.tool_calls[0];
        const fn = tc.function;
        return {
            name: fn && typeof fn.name === 'string' ? fn.name : null,
            callId: typeof tc.id === 'string' ? tc.id : null,
            arguments: fn && typeof fn.arguments === 'string' ? fn.arguments : null,
        };
    }
    if (parsed.tool_use && typeof parsed.tool_use === 'object') {
        const tu = parsed.tool_use;
        return {
            name: typeof tu.name === 'string' ? tu.name : null,
            callId: typeof tu.id === 'string' ? tu.id : null,
            arguments: tu.input ? JSON.stringify(tu.input) : null,
        };
    }
    return { name: null, callId: null, arguments: null };
}

// --- Simulated createObserverStream (mirrors interceptor.ts logic) ---

function createObserverStream(originalBody, streamId, url, cutoffConfig, emitFn) {
    const decoder = new TextDecoder();
    let chunkIndex = 0;
    let functionCallDetected = false;
    const startTime = performance.now();
    let buffer = '';
    let reader;

    return new ReadableStream({
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
                    if (lastLine.length > 0 && !functionCallDetected && detectFunctionCall(lastLine)) {
                        const elapsed = performance.now() - startTime;
                        const identity = extractFunctionCallIdentity(lastLine);
                        emitFn({ type: 'function_call', rawLine: lastLine, identity, chunkIndex, elapsedMs: elapsed, streamId });
                    }
                    emitFn({ type: 'stream_end', streamId, url, totalChunks: chunkIndex });
                    controller.close();
                    return;
                }

                chunkIndex++;

                let shouldCutoff = false;
                let cutoffIdentity = null;

                if (!functionCallDetected && value) {
                    const text = decoder.decode(value, { stream: true });
                    buffer += text;

                    const lines = buffer.split('\n');
                    buffer = lines.pop() || '';

                    for (const line of lines) {
                        const trimmed = line.trim();
                        if (trimmed.length === 0) continue;

                        if (detectFunctionCall(trimmed)) {
                            const elapsed = performance.now() - startTime;
                            const identity = extractFunctionCallIdentity(trimmed);

                            emitFn({
                                type: 'function_call',
                                rawLine: trimmed,
                                identity,
                                chunkIndex,
                                elapsedMs: elapsed,
                                streamId,
                            });

                            functionCallDetected = true;

                            if (cutoffConfig.enabled) {
                                const hasStructuredIdentity = identity !== null && identity.name !== null;
                                if (!cutoffConfig.requireStructuredIdentity || hasStructuredIdentity) {
                                    shouldCutoff = true;
                                    cutoffIdentity = identity;
                                }
                            }
                            break;
                        }
                    }
                }

                if (shouldCutoff) {
                    const elapsed = performance.now() - startTime;

                    if (cutoffConfig.mode === 'cancel') {
                        controller.enqueue(value);
                        emitFn({
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
                        emitFn({ type: 'stream_end', streamId, url, totalChunks: chunkIndex });
                        return;
                    }

                    // drain-drop
                    controller.enqueue(value);
                    emitFn({
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
                    // Background drain
                    drainBackground(reader, cutoffConfig.maxDrainMs, streamId, emitFn).catch(() => {});
                    return;
                }

                controller.enqueue(value);
            } catch (err) {
                emitFn({ type: 'stream_error', streamId, url });
                controller.error(err);
            }
        },

        cancel(reason) {
            return reader.cancel(reason);
        },
    });
}

async function drainBackground(reader, maxDrainMs, streamId, emitFn) {
    let droppedChunks = 0;
    let droppedBytes = 0;
    const drainStart = performance.now();
    let timedOut = false;

    const timeoutId = setTimeout(() => {
        timedOut = true;
        reader.cancel('drain watchdog timeout').catch(() => {});
    }, maxDrainMs);

    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            droppedChunks++;
            droppedBytes += value?.byteLength ?? 0;
        }
    } catch {
        // cancelled
    } finally {
        clearTimeout(timeoutId);
    }

    const drainDurationMs = performance.now() - drainStart;
    emitFn({
        type: 'stream_drain_complete',
        streamId,
        droppedChunks,
        droppedBytes,
        drainDurationMs,
        timedOut,
    });
}

// --- Test helpers ---

const encoder = new TextEncoder();

function makeChunks(lines) {
    return lines.map(line => encoder.encode(line + '\n'));
}

function makeReadableStream(chunks) {
    let index = 0;
    return new ReadableStream({
        pull(controller) {
            if (index < chunks.length) {
                controller.enqueue(chunks[index++]);
            } else {
                controller.close();
            }
        }
    });
}

async function readAll(stream) {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    const chunks = [];
    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(decoder.decode(value, { stream: true }));
    }
    return chunks;
}

let passed = 0;
let failed = 0;

function assert(condition, msg) {
    if (condition) {
        passed++;
        console.log(`  ✅ ${msg}`);
    } else {
        failed++;
        console.error(`  ❌ FAIL: ${msg}`);
    }
}

function assertEq(actual, expected, msg) {
    const ok = JSON.stringify(actual) === JSON.stringify(expected);
    if (ok) {
        passed++;
        console.log(`  ✅ ${msg}`);
    } else {
        failed++;
        console.error(`  ❌ FAIL: ${msg}`);
        console.error(`    Expected: ${JSON.stringify(expected)}`);
        console.error(`    Actual:   ${JSON.stringify(actual)}`);
    }
}

// Delay helper for async drain tests
const delay = ms => new Promise(r => setTimeout(r, ms));

// --- Tests ---

console.log('=== Phase 2 Cutoff Tests ===\n');

// Test 1: No function_call — all chunks pass through (cutoff enabled)
console.log('Test 1: No function_call — full passthrough');
{
    const events = [];
    const lines = [
        '{"type":"text","value":"Hello"}',
        '{"type":"text","value":"World"}',
        '{"type":"done"}',
    ];
    const chunks = makeChunks(lines);
    const source = makeReadableStream(chunks);
    const config = { enabled: true, mode: 'drain-drop', requireStructuredIdentity: true, maxDrainMs: 5000 };
    const observed = createObserverStream(source, 'test-1', '/api', config, e => events.push(e));
    const output = await readAll(observed);

    assertEq(output.length, 3, 'All 3 chunks passed through');
    assert(!events.some(e => e.type === 'stream_cutoff'), 'No cutoff event');
    assert(events.some(e => e.type === 'stream_end'), 'stream_end emitted');
}

// Test 2: Cutoff disabled — function_call detected but all chunks pass through
console.log('\nTest 2: Cutoff disabled — function_call event emitted but no cutoff');
{
    const events = [];
    const lines = [
        '{"type":"text","value":"Hello"}',
        '{"type":"function_call","name":"search","id":"c1","arguments":"{}"}',
        '{"type":"text","value":"hallucination 1"}',
        '{"type":"text","value":"hallucination 2"}',
    ];
    const chunks = makeChunks(lines);
    const source = makeReadableStream(chunks);
    const config = { enabled: false, mode: 'drain-drop', requireStructuredIdentity: true, maxDrainMs: 5000 };
    const observed = createObserverStream(source, 'test-2', '/api', config, e => events.push(e));
    const output = await readAll(observed);

    assertEq(output.length, 4, 'All 4 chunks passed through (cutoff disabled)');
    assert(events.some(e => e.type === 'function_call'), 'function_call event still emitted');
    assert(!events.some(e => e.type === 'stream_cutoff'), 'No cutoff event');
}

// Test 3: Drain-drop mode — function_call triggers cutoff
console.log('\nTest 3: Drain-drop mode — cutoff triggered, hallucination dropped');
{
    const events = [];
    const lines = [
        '{"type":"text","value":"Before"}',
        '{"type":"function_call","name":"mcp__search","id":"call_abc","arguments":"{\\"q\\":\\"test\\"}"}',
        '{"type":"text","value":"hallucination 1"}',
        '{"type":"text","value":"hallucination 2"}',
        '{"type":"text","value":"hallucination 3"}',
    ];
    const chunks = makeChunks(lines);
    const source = makeReadableStream(chunks);
    const config = { enabled: true, mode: 'drain-drop', requireStructuredIdentity: true, maxDrainMs: 5000 };
    const observed = createObserverStream(source, 'test-3', '/api', config, e => events.push(e));
    const output = await readAll(observed);

    // Should get chunk 1 (before) + chunk 2 (trigger) only
    assertEq(output.length, 2, 'Only 2 chunks forwarded (before + trigger)');
    assert(output[0].includes('Before'), 'First chunk is "Before"');
    assert(output[1].includes('function_call'), 'Second chunk contains function_call');

    const cutoffEvent = events.find(e => e.type === 'stream_cutoff');
    assert(cutoffEvent !== undefined, 'stream_cutoff event emitted');
    assertEq(cutoffEvent?.mode, 'drain-drop', 'Cutoff mode is drain-drop');
    assertEq(cutoffEvent?.reason, 'function_call_detected', 'Reason is function_call_detected');
    assert(cutoffEvent?.forwardedTriggerChunk === true, 'forwardedTriggerChunk is true');
    assertEq(cutoffEvent?.identity?.name, 'mcp__search', 'Identity name is mcp__search');

    // Wait for background drain to complete
    await delay(100);
    const drainEvent = events.find(e => e.type === 'stream_drain_complete');
    assert(drainEvent !== undefined, 'stream_drain_complete event emitted');
    assertEq(drainEvent?.droppedChunks, 3, '3 chunks dropped in drain');
    assert(drainEvent?.droppedBytes > 0, 'Dropped bytes > 0');
    assert(drainEvent?.timedOut === false, 'Drain did not time out');
}

// Test 4: Cancel mode — function_call triggers immediate cancellation
console.log('\nTest 4: Cancel mode — stream immediately cancelled');
{
    const events = [];
    const lines = [
        '{"type":"text","value":"Before"}',
        '{"type":"function_call","name":"tool","id":"c2","arguments":"{}"}',
        '{"type":"text","value":"hallucination"}',
    ];
    const chunks = makeChunks(lines);
    const source = makeReadableStream(chunks);
    const config = { enabled: true, mode: 'cancel', requireStructuredIdentity: true, maxDrainMs: 5000 };
    const observed = createObserverStream(source, 'test-4', '/api', config, e => events.push(e));
    const output = await readAll(observed);

    assertEq(output.length, 2, 'Only 2 chunks forwarded');
    const cutoffEvent = events.find(e => e.type === 'stream_cutoff');
    assert(cutoffEvent !== undefined, 'stream_cutoff event emitted');
    assertEq(cutoffEvent?.mode, 'cancel', 'Cutoff mode is cancel');
    assert(events.some(e => e.type === 'stream_end'), 'stream_end emitted');
    assert(!events.some(e => e.type === 'stream_drain_complete'), 'No drain event in cancel mode');
}

// Test 5: Identity gate — keyword match but no structured identity
console.log('\nTest 5: Identity gate — keyword match but name is null, no cutoff');
{
    const events = [];
    const lines = [
        '{"type":"text","value":"Before"}',
        '{"type":"function_call","name":null}',   // 2 keywords match but name is not a string
        '{"type":"text","value":"continues"}',
    ];
    const chunks = makeChunks(lines);
    const source = makeReadableStream(chunks);
    const config = { enabled: true, mode: 'drain-drop', requireStructuredIdentity: true, maxDrainMs: 5000 };
    const observed = createObserverStream(source, 'test-5', '/api', config, e => events.push(e));
    const output = await readAll(observed);

    assertEq(output.length, 3, 'All 3 chunks passed through (identity gate blocked cutoff)');
    assert(events.some(e => e.type === 'function_call'), 'function_call event still emitted');
    assert(!events.some(e => e.type === 'stream_cutoff'), 'No cutoff event (identity gate)');
}

// Test 6: Identity gate disabled — keyword match without name still triggers cutoff
console.log('\nTest 6: requireStructuredIdentity=false — cutoff on keyword match alone');
{
    const events = [];
    const lines = [
        '{"type":"text","value":"Before"}',
        '{"type":"function_call","name":null}',   // 2 keywords match, name not a string
        '{"type":"text","value":"hallucination"}',
    ];
    const chunks = makeChunks(lines);
    const source = makeReadableStream(chunks);
    const config = { enabled: true, mode: 'drain-drop', requireStructuredIdentity: false, maxDrainMs: 5000 };
    const observed = createObserverStream(source, 'test-6', '/api', config, e => events.push(e));
    const output = await readAll(observed);

    assertEq(output.length, 2, 'Only 2 chunks (cutoff triggered without structured identity)');
    assert(events.some(e => e.type === 'stream_cutoff'), 'Cutoff event emitted');
    await delay(50);
}

// Test 7: Same-chunk tail (accepted risk — entire trigger chunk is forwarded)
console.log('\nTest 7: Same-chunk tail — trigger chunk includes hallucination lines');
{
    const events = [];
    // Simulate a single chunk that contains both function_call and hallucination
    const combinedChunk = encoder.encode(
        '{"type":"function_call","name":"search","id":"c3","arguments":"{}"}\n' +
        '{"type":"text","value":"hallucination in same chunk"}\n'
    );
    const beforeChunk = encoder.encode('{"type":"text","value":"Before"}\n');
    const afterChunk = encoder.encode('{"type":"text","value":"After chunk"}\n');

    const source = makeReadableStream([beforeChunk, combinedChunk, afterChunk]);
    const config = { enabled: true, mode: 'drain-drop', requireStructuredIdentity: true, maxDrainMs: 5000 };
    const observed = createObserverStream(source, 'test-7', '/api', config, e => events.push(e));
    const output = await readAll(observed);

    // Before + combined chunk (includes hallucination tail — accepted risk)
    assertEq(output.length, 2, '2 chunks forwarded (before + combined trigger)');
    assert(output[1].includes('hallucination in same chunk'), 'Same-chunk tail is forwarded (accepted risk)');
    assert(events.some(e => e.type === 'stream_cutoff'), 'Cutoff event emitted');
    await delay(50);
    const drainEvent = events.find(e => e.type === 'stream_drain_complete');
    assertEq(drainEvent?.droppedChunks, 1, '1 after-chunk dropped in drain');
}

// Test 8: maxDrainMs watchdog timeout
console.log('\nTest 8: maxDrainMs watchdog — drain times out and cancels reader');
{
    const events = [];
    // Create a stream that delays chunks
    let chunkIdx = 0;
    const slowChunks = [
        encoder.encode('{"type":"text","value":"Before"}\n'),
        encoder.encode('{"type":"function_call","name":"slow","id":"c4","arguments":"{}"}\n'),
    ];
    // Add a never-ending source to test watchdog
    const source = new ReadableStream({
        async pull(controller) {
            if (chunkIdx < slowChunks.length) {
                controller.enqueue(slowChunks[chunkIdx++]);
            } else {
                // Simulate slow upstream — each chunk takes 200ms
                await new Promise(r => setTimeout(r, 200));
                controller.enqueue(encoder.encode('{"type":"text","value":"slow data"}\n'));
            }
        }
    });

    const config = { enabled: true, mode: 'drain-drop', requireStructuredIdentity: true, maxDrainMs: 300 };
    const observed = createObserverStream(source, 'test-8', '/api', config, e => events.push(e));
    const output = await readAll(observed);

    assertEq(output.length, 2, '2 chunks forwarded before cutoff');

    // Wait for watchdog to fire (300ms + margin)
    await delay(600);
    const drainEvent = events.find(e => e.type === 'stream_drain_complete');
    assert(drainEvent !== undefined, 'stream_drain_complete event emitted');
    assert(drainEvent?.timedOut === true, 'Drain timed out (watchdog fired)');
}

// Test 9: Drain statistics accuracy
console.log('\nTest 9: Drain statistics — droppedChunks and droppedBytes are accurate');
{
    const events = [];
    const lines = [
        '{"type":"function_call","name":"test","id":"c5","arguments":"{}"}',
        '{"type":"text","value":"drop1"}',
        '{"type":"text","value":"drop2_longer_text"}',
    ];
    const chunks = makeChunks(lines);
    const source = makeReadableStream(chunks);
    const config = { enabled: true, mode: 'drain-drop', requireStructuredIdentity: true, maxDrainMs: 5000 };
    const observed = createObserverStream(source, 'test-9', '/api', config, e => events.push(e));
    const output = await readAll(observed);

    assertEq(output.length, 1, 'Only trigger chunk forwarded');
    await delay(100);
    const drainEvent = events.find(e => e.type === 'stream_drain_complete');
    assert(drainEvent !== undefined, 'stream_drain_complete event emitted');
    assertEq(drainEvent?.droppedChunks, 2, '2 chunks dropped');
    // Each line + '\n' encoded as UTF-8
    const expectedBytes = encoder.encode(lines[1] + '\n').byteLength + encoder.encode(lines[2] + '\n').byteLength;
    assertEq(drainEvent?.droppedBytes, expectedBytes, `Dropped bytes = ${expectedBytes}`);
    assert(drainEvent?.drainDurationMs >= 0, 'drainDurationMs is non-negative');
}

// Test 10: function_call in last buffer line (stream end)
console.log('\nTest 10: function_call in trailing buffer at stream end');
{
    const events = [];
    // Chunk without trailing newline — will be in buffer at stream end
    const chunk = encoder.encode('{"type":"function_call","name":"late","id":"c6","arguments":"{}"}');
    const source = makeReadableStream([chunk]);
    const config = { enabled: false, mode: 'drain-drop', requireStructuredIdentity: true, maxDrainMs: 5000 };
    const observed = createObserverStream(source, 'test-10', '/api', config, e => events.push(e));
    const output = await readAll(observed);

    assertEq(output.length, 1, '1 chunk forwarded');
    assert(events.some(e => e.type === 'function_call'), 'function_call event emitted from trailing buffer');
}

// === Summary ===

console.log(`\nResults: ${passed} passed, ${failed} failed, ${passed + failed} total`);

if (failed > 0) {
    process.exit(1);
}
