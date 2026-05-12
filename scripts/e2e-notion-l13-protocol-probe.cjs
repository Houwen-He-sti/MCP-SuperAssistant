#!/usr/bin/env node
/**
 * L13 Protocol Probe — End-to-end dataflow verification for MCP-SuperAssistant
 * Notion pipeline.
 *
 * Modes:
 *   negative-a    Normal message, no JSONL — expects 0 scanner detections
 *   negative-b    Contains protocol keywords but explicitly forbids tool calls
 *   positive-a    Copy-exact JSONL block — tests if pipeline can process JSONL
 *   positive-b    Intent-to-JSONL — tests if Notion AI can generate tool calls
 *
 * Usage:
 *   node scripts/e2e-notion-l13-protocol-probe.cjs [negative-a|negative-b|positive-a|positive-b]
 *
 * Each probe run:
 *   1. Connects to Notion tab via CDP
 *   2. Verifies frame tree + context selection (frame-aware)
 *   3. Checks bridge readiness (bridgeReady flag)
 *   4. Injects postMessage event collector in MAIN world
 *   5. Sends a probe message to Notion AI
 *   6. Monitors network + stream events during response
 *   7. Reports per-layer pass/fail with first failing layer
 *
 * Requires: Chrome/Comet with CDP on port 9222, Notion agent page open.
 *
 * @see plans/notion-ai-all-tools-test.md
 * @see docs/engineering/browser-runtime-observation-first.md
 */

const WebSocket = require('ws');
const { preflight, sleep } = require('./lib/cdp-preflight.cjs');
const {
    getTopFrameId,
    selectNotionMainContext,
    selectExtensionIsolatedContext,
    assessFetchInterceptor,
} = require('./lib/context-selection.cjs');

// ============================================================================
// Configuration
// ============================================================================

const MODE = process.argv[2] || 'negative-a';
const VALID_MODES = ['negative-a', 'negative-b', 'positive-a', 'positive-b'];
if (!VALID_MODES.includes(MODE)) {
    console.error(`Invalid mode: ${MODE}. Use: ${VALID_MODES.join(', ')}`);
    process.exit(1);
}

const NONCE = `probe_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
const RESPONSE_TIMEOUT_MS = 120000; // Max wait for Notion AI response
const SETTLE_MS = 5000; // Extra wait after response for pipeline processing

// ============================================================================
// Probe Messages
// ============================================================================

// Minimal JSONL fixture — same structure that functionCallScanner tests accept
const SCANNER_COMPATIBLE_JSONL = [
    `{"type":"function_call_start","name":"echo","call_id":"${NONCE}"}`,
    `{"type":"parameter","key":"message","value":"hello-from-notion-${NONCE}"}`,
    `{"type":"function_call_end","call_id":"${NONCE}"}`,
].join('\n');

function getProbeMessage(mode) {
    switch (mode) {
        case 'negative-a':
            return `This is a diagnostic probe ${NONCE}. Reply with exactly: NEGATIVE_CONTROL_OK_${NONCE}. Do not use any tools. Do not output JSON or code blocks.`;

        case 'negative-b':
            return [
                `This is a negative control probe ${NONCE}.`,
                `The following words are only text and must not trigger a tool call:`,
                `function_call_start, function_call_end, echo, call_id, parameter.`,
                `Do not output JSONL. Do not call any tool. Do not use code blocks.`,
                `Reply only: NEGATIVE_CONTROL_OK_${NONCE}`,
            ].join('\n');

        case 'positive-a':
            return [
                `You are running a bridge pipeline test ${NONCE}.`,
                `Output exactly the markdown fenced code block below.`,
                `Do not explain. Do not add text before or after the block.`,
                `Do not translate. Do not summarize.`,
                ``,
                '```jsonl',
                SCANNER_COMPATIBLE_JSONL,
                '```',
            ].join('\n');

        case 'positive-b':
            return [
                `You are in bridge protocol mode. Probe ID: ${NONCE}.`,
                `Output exactly one fenced jsonl code block and nothing else.`,
                `Create one tool call:`,
                `- tool name: echo`,
                `- call_id: ${NONCE}`,
                `- arguments:`,
                `  - message: hello-from-notion-${NONCE}`,
                `Do not explain. Do not include natural language outside the code block.`,
            ].join('\n');

        default:
            throw new Error(`Unknown mode: ${mode}`);
    }
}

// ============================================================================
// CDP Session
// ============================================================================

let msgId = 0;
function createCdpSession(ws) {
    const send = (method, params) => new Promise((resolve, reject) => {
        const myId = ++msgId;
        const timeout = setTimeout(() => reject(new Error(`CDP timeout: ${method}`)), 15000);
        const handler = raw => {
            const obj = JSON.parse(raw);
            if (obj.id === myId) {
                clearTimeout(timeout);
                ws.off('message', handler);
                resolve(obj);
            }
        };
        ws.on('message', handler);
        ws.send(JSON.stringify({ id: myId, method, params: params || {} }));
    });
    const evalIn = async (contextId, expression) => {
        const r = await send('Runtime.evaluate', { contextId, expression, returnByValue: true });
        if (r.result?.exceptionDetails) {
            throw new Error(`Eval error: ${r.result.exceptionDetails.text}`);
        }
        return r.result?.result?.value;
    };
    return { send, evalIn };
}

// ============================================================================
// Report
// ============================================================================

const report = {};
let firstFail = null;

function record(layer, pass, detail) {
    const status = pass === true ? 'PASS' : pass === false ? 'FAIL' : 'UNKNOWN';
    report[layer] = { status, detail };
    if (status === 'FAIL' && !firstFail) firstFail = layer;
}

function printReport() {
    console.log('\n' + '='.repeat(80));
    console.log(`L13 PROTOCOL PROBE REPORT — Mode: ${MODE}, Nonce: ${NONCE}`);
    console.log('='.repeat(80));

    const layers = Object.keys(report).filter(k => !k.startsWith('_'));
    for (const layer of layers) {
        const r = report[layer];
        const icon = r.status === 'PASS' ? '✅' : r.status === 'FAIL' ? '❌' : '❓';
        console.log(`${icon} ${layer}: ${r.status}`);
        console.log(`   ${r.detail}`);
    }

    console.log('─'.repeat(80));
    if (firstFail) {
        console.log(`⛔ FIRST FAILING LAYER: ${firstFail}`);
    } else {
        const hasUnknown = layers.some(l => report[l].status === 'UNKNOWN');
        console.log(hasUnknown
            ? '⚠️  No failures, but some layers could not be verified'
            : '✅ ALL LAYERS PASSED');
    }
    console.log('='.repeat(80));
}

// ============================================================================
// Main
// ============================================================================

(async () => {
    console.log(`\n🔬 L13 Protocol Probe — Mode: ${MODE}, Nonce: ${NONCE}\n`);

    // ── Preflight ──────────────────────────────────────────────────────────
    let ext, tab;
    try {
        const pf = await preflight();
        ext = { id: pf.extensionId, name: pf.extensionName };
        tab = pf.tab;
        record('L-2 Preflight', true, `${ext.name}, page: ${tab.url.slice(0, 60)}`);
    } catch (e) {
        record('L-2 Preflight', false, e.message);
        printReport();
        process.exit(1);
    }

    // ── CDP Connection ─────────────────────────────────────────────────────
    const ws = new WebSocket(tab.webSocketDebuggerUrl);
    await new Promise(r => ws.on('open', r));
    const cdp = createCdpSession(ws);

    // ── Frame tree + context selection ──────────────────────────────────────
    const contexts = [];
    ws.on('message', raw => {
        const obj = JSON.parse(raw);
        if (obj.method === 'Runtime.executionContextCreated') {
            contexts.push(obj.params.context);
        }
    });
    await cdp.send('Runtime.enable');
    await cdp.send('Page.enable');

    let topFrameId = null;
    try {
        const ftResult = await cdp.send('Page.getFrameTree');
        topFrameId = getTopFrameId(ftResult);
    } catch (e) {
        console.log(`⚠️  Frame tree unavailable: ${e.message}`);
    }

    await sleep(1000);

    const mainCtx = selectNotionMainContext(contexts, topFrameId);
    const extCtx = selectExtensionIsolatedContext(contexts, ext.id, topFrameId);

    if (!mainCtx) {
        record('L1 Context Selection', false, 'No top frame MAIN context found');
        printReport();
        ws.close();
        process.exit(1);
    }
    record('L1 Context Selection', true,
        `MAIN ctx=${mainCtx.id} (frameId=${mainCtx.auxData?.frameId}), ` +
        `Isolated ctx=${extCtx?.id || 'none'} (frameId=${extCtx?.auxData?.frameId || 'none'})`);

    // ── L1: Fetch interceptor status ───────────────────────────────────────
    const fetchState = JSON.parse(await cdp.evalIn(mainCtx.id, `
        JSON.stringify({
            installKey: !!window['__MCP_SA_NOTION_STREAM_INTERCEPTOR_INSTALLED_V1__'],
            fetchWrapped: !!window.fetch?.__mcpSaWrapped,
            fetchIsNative: window.fetch?.toString()?.includes('[native code]') || false,
        })
    `) || '{}');
    const fetchAssess = assessFetchInterceptor(fetchState);
    record('L1 Fetch Interceptor', fetchAssess.status === 'PASS', `[${fetchAssess.tier}] ${fetchAssess.detail}`);

    // ── Bridge readiness ───────────────────────────────────────────────────
    // Check if the MAIN world interceptor has received bridge-ready signal
    // We can't directly access the bridgeReady variable (it's closure-scoped),
    // but we can check if pending events queue length is 0 (indirect evidence)
    // For now, just note this as UNKNOWN and proceed.
    record('L2 Bridge Ready', null, 'Cannot directly verify bridgeReady flag (closure-scoped). Will be observed via stream events.');

    // ── Inject event collector ─────────────────────────────────────────────
    // Add a postMessage listener in MAIN world to capture all stream events
    await cdp.evalIn(mainCtx.id, `
        (function() {
            if (window.__mcpProbeEvents) return; // Already injected
            window.__mcpProbeEvents = [];
            window.__mcpProbeNonce = '${NONCE}';
            window.addEventListener('message', function(e) {
                if (e.source !== window) return;
                var d = e.data;
                if (!d || typeof d !== 'object') return;
                if (d.channel === 'mcp-superassistant.stream' && d.direction === 'main-to-isolated') {
                    window.__mcpProbeEvents.push({
                        type: d.event?.type,
                        streamId: d.event?.streamId,
                        url: d.event?.url,
                        totalChunks: d.event?.totalChunks,
                        ts: Date.now()
                    });
                }
            });
        })()
    `);

    // Also inject in isolated world to capture tool execution events
    if (extCtx) {
        await cdp.evalIn(extCtx.id, `
            (function() {
                if (window.__mcpProbeIsolatedEvents) return;
                window.__mcpProbeIsolatedEvents = [];
                window.__mcpProbeNonce = '${NONCE}';
                window.addEventListener('message', function(e) {
                    if (e.source !== window) return;
                    var d = e.data;
                    if (!d || typeof d !== 'object') return;
                    if (d.channel === 'mcp-superassistant.stream' && d.direction === 'main-to-isolated') {
                        window.__mcpProbeIsolatedEvents.push({
                            type: d.event?.type,
                            streamId: d.event?.streamId,
                            functionName: d.event?.identity?.name,
                            callId: d.event?.identity?.callId,
                            ts: Date.now()
                        });
                    }
                });
            })()
        `);
    }

    // ── Enable network monitoring ──────────────────────────────────────────
    // Track runInferenceTranscript requests
    await cdp.send('Network.enable');
    const networkRequests = [];
    ws.on('message', raw => {
        const obj = JSON.parse(raw);
        if (obj.method === 'Network.requestWillBeSent') {
            const url = obj.params?.request?.url || '';
            if (url.includes('runInferenceTranscript')) {
                networkRequests.push({
                    requestId: obj.params.requestId,
                    url,
                    ts: Date.now(),
                });
            }
        }
    });

    // ── Send probe message ─────────────────────────────────────────────────
    const probeMsg = getProbeMessage(MODE);
    console.log(`📤 Sending probe message (mode=${MODE})...`);
    console.log(`   First 80 chars: ${probeMsg.slice(0, 80)}...`);

    // Wait for chat input to be ready (may need time after SPA navigation)
    let chatReady = false;
    const domWaitStart = Date.now();
    while (!chatReady && Date.now() - domWaitStart < 30000) {
        const check = await cdp.evalIn(mainCtx.id, `
            JSON.stringify({
                chatInput: !!document.querySelector('div[role="textbox"][contenteditable="true"]'),
                submitBtn: !!document.querySelector('[data-testid="agent-send-message-button"]'),
            })
        `);
        const cs = JSON.parse(check || '{}');
        if (cs.chatInput) {
            chatReady = true;
            break;
        }
        await sleep(1000);
    }

    if (!chatReady) {
        record('L10 Message Send', false, 'Chat input not found after 30s wait');
        printReport();
        ws.close();
        process.exit(1);
    }

    // Type into chat input and submit
    const sendResult = await cdp.evalIn(mainCtx.id, `
        (function() {
            var input = document.querySelector('div[role="textbox"][contenteditable="true"]');
            if (!input) return JSON.stringify({ error: 'No chat input found' });

            // Focus and set content
            input.focus();
            input.textContent = '';

            // Use execCommand for contenteditable compatibility
            document.execCommand('insertText', false, ${JSON.stringify(probeMsg)});

            // Small delay then click submit
            return JSON.stringify({ typed: true, textLength: input.textContent.length });
        })()
    `);
    const sendState = JSON.parse(sendResult || '{}');
    if (sendState.error) {
        record('L10 Message Send', false, sendState.error);
        printReport();
        ws.close();
        process.exit(1);
    }

    // Click submit button
    await sleep(300);
    const clickResult = await cdp.evalIn(mainCtx.id, `
        (function() {
            var btn = document.querySelector('[data-testid="agent-send-message-button"]');
            if (!btn) return JSON.stringify({ error: 'No submit button found' });
            btn.click();
            return JSON.stringify({ clicked: true });
        })()
    `);
    const clickState = JSON.parse(clickResult || '{}');
    if (clickState.error) {
        record('L10 Message Send', false, clickState.error);
        printReport();
        ws.close();
        process.exit(1);
    }

    record('L10 Message Send', true, `Typed ${sendState.textLength} chars, submitted`);

    // ── Wait for response ──────────────────────────────────────────────────
    console.log(`⏳ Waiting for Notion AI response (max ${RESPONSE_TIMEOUT_MS / 1000}s)...`);

    // Wait for runInferenceTranscript request
    const networkStart = Date.now();
    while (networkRequests.length === 0 && Date.now() - networkStart < 15000) {
        await sleep(500);
    }

    if (networkRequests.length > 0) {
        record('L1 Stream Capture', true, `runInferenceTranscript request detected (${networkRequests.length} request(s))`);
    } else {
        record('L1 Stream Capture', false, 'No runInferenceTranscript request detected within 15s');
    }

    // Wait for stream events to arrive
    const streamStart = Date.now();
    let streamComplete = false;
    while (!streamComplete && Date.now() - streamStart < RESPONSE_TIMEOUT_MS) {
        const events = JSON.parse(await cdp.evalIn(mainCtx.id,
            'JSON.stringify(window.__mcpProbeEvents || [])') || '[]');

        const hasStreamEnd = events.some(e => e.type === 'stream_end');
        if (hasStreamEnd) {
            streamComplete = true;
            break;
        }
        await sleep(1000);
    }

    // Extra settle time for pipeline processing
    console.log(`⏳ Settling (${SETTLE_MS / 1000}s)...`);
    await sleep(SETTLE_MS);

    // ── Collect results ────────────────────────────────────────────────────
    // MAIN world events
    const mainEvents = JSON.parse(await cdp.evalIn(mainCtx.id,
        'JSON.stringify(window.__mcpProbeEvents || [])') || '[]');

    // Isolated world events
    let isolatedEvents = [];
    if (extCtx) {
        isolatedEvents = JSON.parse(await cdp.evalIn(extCtx.id,
            'JSON.stringify(window.__mcpProbeIsolatedEvents || [])') || '[]');
    }

    // ── Analyze stream events ──────────────────────────────────────────────
    const streamStarts = mainEvents.filter(e => e.type === 'stream_start');
    const streamEnds = mainEvents.filter(e => e.type === 'stream_end');
    const chunkTexts = mainEvents.filter(e => e.type === 'stream_chunk_text');

    if (streamStarts.length > 0) {
        record('L1 Stream Events', true,
            `stream_start=${streamStarts.length}, stream_end=${streamEnds.length}, ` +
            `stream_chunk_text=${chunkTexts.length}, total events=${mainEvents.length}`);

        // Stream lifecycle is healthy if we got start+end
        if (streamEnds.length > 0) {
            record('L1 Stream Lifecycle', true,
                `Complete lifecycle: start→end. totalChunks=${streamEnds[0].totalChunks || 'unknown'}`);
        } else {
            record('L1 Stream Lifecycle', false,
                `stream_start fired but no stream_end within timeout`);
        }
    } else {
        record('L1 Stream Events', false,
            `No stream events captured. bridgeReady may be false, or Sentry consumed the body.`);
        record('L1 Stream Lifecycle', false, 'No stream events');
    }

    // ── Check for function call detections ─────────────────────────────────
    // The isolated world events would contain function_call_detected if scanner found one
    const isolatedFunctionCalls = isolatedEvents.filter(e =>
        e.type === 'function_call_detected' || e.functionName
    );

    // Also check if any tool result cards appeared in DOM
    let toolResultCards = 0;
    let toolResultDetail = '';
    if (extCtx) {
        try {
            const domCheck = await cdp.evalIn(extCtx.id, `
                (function() {
                    var cards = document.querySelectorAll('[data-mcp-tool-result], [class*="tool-result"], [data-testid*="tool-result"]');
                    var sidebar = document.querySelector('#mcp-sidebar-shadow-host');
                    var shadowCards = [];
                    if (sidebar && sidebar.shadowRoot) {
                        shadowCards = sidebar.shadowRoot.querySelectorAll('[data-mcp-tool-result], [class*="tool-result"]');
                    }
                    return JSON.stringify({
                        mainCards: cards.length,
                        shadowCards: shadowCards.length,
                    });
                })()
            `);
            const dc = JSON.parse(domCheck || '{}');
            toolResultCards = (dc.mainCards || 0) + (dc.shadowCards || 0);
            toolResultDetail = `mainCards=${dc.mainCards}, shadowCards=${dc.shadowCards}`;
        } catch (e) {
            toolResultDetail = `DOM check error: ${e.message}`;
        }
    }

    // ── Per-mode assertions ────────────────────────────────────────────────
    if (MODE === 'negative-a' || MODE === 'negative-b') {
        // Negative control: expect 0 scanner detections, 0 bridge executions, 0 tool results
        const detections = isolatedFunctionCalls.length;
        record('L3 Scanner Detection', detections === 0,
            detections === 0
                ? 'CORRECT: 0 scanner detections (negative control passed)'
                : `FALSE POSITIVE: ${detections} scanner detections in negative control!`);

        record('L11 Tool Result', toolResultCards === 0,
            toolResultCards === 0
                ? 'CORRECT: 0 tool result cards (negative control passed)'
                : `FALSE POSITIVE: ${toolResultCards} tool result cards! ${toolResultDetail}`);
    } else {
        // Positive control: expect >= 1 detection with our nonce
        const nonceDetections = isolatedFunctionCalls.filter(e =>
            e.callId && e.callId.includes(NONCE)
        );
        const anyDetections = isolatedFunctionCalls.length;

        if (nonceDetections.length > 0) {
            record('L3 Scanner Detection', true,
                `Detected ${nonceDetections.length} tool call(s) with probe nonce`);
        } else if (anyDetections > 0) {
            record('L3 Scanner Detection', null,
                `${anyDetections} detection(s) but none match probe nonce ${NONCE}`);
        } else {
            record('L3 Scanner Detection', false,
                `0 scanner detections. Stream events: ${mainEvents.length}. ` +
                `Possible causes: bridge not ready, scanner format mismatch, or model didn't output JSONL`);
        }

        record('L11 Tool Result', toolResultCards > 0,
            toolResultCards > 0
                ? `${toolResultCards} tool result card(s) rendered. ${toolResultDetail}`
                : `0 tool result cards. ${toolResultDetail}. Pipeline may have failed at scanner/bridge/MCP stage.`);
    }

    // ── L13 Model Protocol Assessment ──────────────────────────────────────
    // Check if the assistant response contains our nonce (proves model received and responded)
    let assistantResponse = '';
    try {
        assistantResponse = await cdp.evalIn(mainCtx.id, `
            (function() {
                // Find the last assistant message in the chat
                var messages = document.querySelectorAll('[data-testid*="message"], [class*="message-content"]');
                if (messages.length === 0) {
                    // Try broader selector
                    messages = document.querySelectorAll('.notion-app-inner div[contenteditable="false"]');
                }
                var lastFew = Array.from(messages).slice(-5).map(function(el) { return el.textContent; }).join('\\n---\\n');
                return lastFew.slice(0, 2000);
            })()
        `) || '';
    } catch (e) {
        assistantResponse = `DOM read error: ${e.message}`;
    }

    const responseContainsNonce = assistantResponse.includes(NONCE);
    const responseContainsJsonl = assistantResponse.includes('function_call_start') ||
        assistantResponse.includes('jsonl');

    record('L13 Model Response', responseContainsNonce || assistantResponse.length > 50,
        responseContainsNonce
            ? `Response contains probe nonce ${NONCE.slice(0, 20)}...`
            : `Response length=${assistantResponse.length}. First 200 chars: ${assistantResponse.slice(0, 200)}`);

    if (MODE === 'positive-a' || MODE === 'positive-b') {
        record('L13 JSONL in Response', responseContainsJsonl,
            responseContainsJsonl
                ? 'Response contains function_call_start or jsonl markers'
                : 'Response does NOT contain JSONL markers — model may not support tool call format');
    }

    // ── Cleanup ────────────────────────────────────────────────────────────
    // Remove injected collectors
    await cdp.evalIn(mainCtx.id, 'delete window.__mcpProbeEvents; delete window.__mcpProbeNonce;').catch(() => { });
    if (extCtx) {
        await cdp.evalIn(extCtx.id, 'delete window.__mcpProbeIsolatedEvents; delete window.__mcpProbeNonce;').catch(() => { });
    }

    await cdp.send('Network.disable');
    await cdp.send('Runtime.disable');
    ws.close();

    // ── Summary ────────────────────────────────────────────────────────────
    printReport();

    // Print raw data for debugging
    console.log('\n📊 Raw Data:');
    console.log(`   Network requests: ${networkRequests.length}`);
    console.log(`   MAIN world events: ${mainEvents.length}`);
    console.log(`   Isolated world events: ${isolatedEvents.length}`);
    if (mainEvents.length > 0) {
        console.log('   MAIN events:', JSON.stringify(mainEvents, null, 2));
    }
    if (isolatedEvents.length > 0) {
        console.log('   Isolated events:', JSON.stringify(isolatedEvents, null, 2));
    }
    console.log(`   Assistant response (first 500): ${assistantResponse.slice(0, 500)}`);

    process.exit(firstFail ? 1 : 0);
})().catch(e => {
    console.error('Fatal error:', e);
    process.exit(2);
});
