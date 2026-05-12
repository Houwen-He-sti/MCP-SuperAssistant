#!/usr/bin/env node
/**
 * L5-L11 Diagnostic Probe — Force-Enable Execution Pipeline
 *
 * Purpose: In a lab-only controlled environment, verify whether the L5→L11
 * execution pipeline can carry a real MCP tool call end-to-end:
 *   stream_cutoff → handler → allowlist → callTool → result → DOM inject
 *
 * Prerequisites:
 *   - Comet/Chrome with CDP on port 9222
 *   - MCP-SuperAssistant extension loaded
 *   - Notion AI page open (notion.so/agent/...)
 *   - mcp-superassistant-proxy running on localhost:3006/sse
 *     (connected to committee-bridge-mcp with echo tool)
 *
 * Safety constraints:
 *   - autoSubmit = false (human confirms before sending)
 *   - toolAllowlist = ['echo'] (only safe read-only tool)
 *   - Restores original config after probe
 *   - Does NOT modify production code
 *
 * Usage:
 *   node scripts/debug_l5-l11-diagnostic-probe.cjs
 *
 * Exit codes:
 *   0 = probe completed (check output for pass/fail)
 *   1 = infrastructure error
 */

const WebSocket = require('ws');
const { preflight, sleep } = require('./lib/cdp-preflight.cjs');
const { getTopFrameId, selectExtensionIsolatedContext } = require('./lib/context-selection.cjs');

const TIMEOUT_MS = 15_000;

// ============================================================================
// Helpers
// ============================================================================

function log(level, ...args) {
    const prefix = { info: '●', pass: '✅', fail: '❌', warn: '⚠', step: '→', section: '━' };
    const icon = prefix[level] || '·';
    console.log(`  ${icon} ${args.join(' ')}`);
}

// CDP session helper — thin wrapper for evaluate in ISOLATED / MAIN worlds
function createSession(ws, isolatedCtxId) {
    let msgId = 0;
    const send = (method, params) => new Promise((resolve, reject) => {
        const myId = ++msgId;
        const timeout = setTimeout(() => reject(new Error('CDP timeout: ' + method)), TIMEOUT_MS);
        const handler = raw => { const obj = JSON.parse(raw); if (obj.id === myId) { clearTimeout(timeout); ws.off('message', handler); resolve(obj); } };
        ws.on('message', handler);
        ws.send(JSON.stringify({ id: myId, method, params: params || {} }));
    });

    const evalIn = async (contextId, expression, opts = {}) => {
        const params = {
            expression,
            returnByValue: true,
            awaitPromise: opts.awaitPromise || false,
        };
        if (contextId != null) params.contextId = contextId;
        const r = await send('Runtime.evaluate', params);
        if (r.result?.exceptionDetails) {
            return { __exception: true, text: r.result.exceptionDetails.text, description: r.result.exceptionDetails.exception?.description };
        }
        return r.result?.result;
    };

    return {
        send,
        /** Evaluate in ISOLATED world */
        evaluate: (expr, opts) => evalIn(isolatedCtxId, expr, opts),
        /** Evaluate in MAIN world (default context) */
        evaluateMain: (expr, opts) => evalIn(undefined, expr, opts),
        close: () => ws.close(),
    };
}

// ============================================================================
// Phase 1: Preflight — Connection Verification
// ============================================================================

async function phasePreflight(cdp) {
    console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('  PHASE 1: Preflight — Connection Verification');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

    // 1a. Check streamToolBridge availability
    const bridgeInfo = await cdp.evaluate(`
        (function() {
            if (typeof window.getStreamToolBridgeInfo !== 'function') return { error: 'getStreamToolBridgeInfo not available' };
            return window.getStreamToolBridgeInfo();
        })()
    `);

    if (bridgeInfo?.value?.error) {
        log('fail', 'Bridge not available:', bridgeInfo.value.error);
        return { pass: false, reason: bridgeInfo.value.error };
    }

    log('info', 'Bridge info:', JSON.stringify(bridgeInfo?.value?.config || {}, null, 2));

    // 1b. Check MCP connection status
    const mcpStatus = await cdp.evaluate(`
        (async function() {
            const client = window.mcpClient;
            if (!client) return { error: 'mcpClient not on window' };
            const tools = await client.getAvailableTools();
            const connStatus = await client.getConnectionStatus();
            const serverConfig = await client.getServerConfig();
            return {
                isReady: client.isReady(),
                connectionStatus: typeof connStatus === 'string' ? connStatus : JSON.stringify(connStatus),
                serverConfig: typeof serverConfig === 'string' ? serverConfig : JSON.stringify(serverConfig),
                toolCount: Array.isArray(tools) ? tools.length : 0,
                toolNames: Array.isArray(tools) ? tools.map(t => t.name || t).slice(0, 10) : [],
            };
        })()
    `, { awaitPromise: true });

    log('info', 'MCP status:', JSON.stringify(mcpStatus?.value || mcpStatus));

    const v = mcpStatus?.value || {};
    const connected = v.connectionStatus === 'connected';
    const hasEcho = Array.isArray(v.toolNames) && v.toolNames.some(n =>
        typeof n === 'string' && n.toLowerCase().includes('echo')
    );

    if (!connected) {
        log('fail', 'MCP not connected. connectionStatus:', v.connectionStatus);
        log('info', 'Hint: Start mcp-superassistant-proxy on localhost:3006, then wait 60s or refresh page');
        return { pass: false, reason: `connectionStatus=${v.connectionStatus}` };
    }
    log('pass', 'MCP connected');

    if (!hasEcho) {
        log('fail', 'echo tool not found in available tools');
        log('info', 'Available tools:', JSON.stringify(v.toolNames));
        return { pass: false, reason: 'echo tool not available' };
    }
    log('pass', `echo tool available (${v.toolCount} total tools)`);

    // 1c. Capture original config for restore
    const origConfig = await cdp.evaluate(`
        (function() {
            const info = window.getStreamToolBridgeInfo();
            return info.config;
        })()
    `);
    log('info', 'Original config (will restore):', JSON.stringify(origConfig?.value));

    return { pass: true, origConfig: origConfig?.value, mcpStatus: v, bridgeInfo: bridgeInfo?.value };
}

// ============================================================================
// Phase 2: Force-Enable Bridge
// ============================================================================

async function phaseForceEnable(cdp) {
    console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('  PHASE 2: Force-Enable Execution Bridge');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

    // 2a. Configure bridge
    log('step', 'Calling configureStreamToolBridge...');
    const configResult = await cdp.evaluate(`
        (function() {
            if (typeof window.configureStreamToolBridge !== 'function') {
                return { error: 'configureStreamToolBridge not available' };
            }
            window.configureStreamToolBridge({
                enabled: true,
                cutoffEnabled: true,
                autoInsert: true,
                autoSubmit: false,
                toolTimeoutMs: 30000,
                toolAllowlist: ['echo'],
            });
            const info = window.getStreamToolBridgeInfo();
            return { configured: true, config: info.config };
        })()
    `);

    if (configResult?.value?.error) {
        log('fail', 'Failed to configure bridge:', configResult.value.error);
        return { pass: false, reason: configResult.value.error };
    }

    const c = configResult?.value?.config || {};
    log('info', 'New config:', JSON.stringify(c));

    if (!c.enabled) {
        log('fail', 'config.enabled is still false after configureStreamToolBridge');
        return { pass: false, reason: 'enabled=false' };
    }
    log('pass', 'config.enabled = true');

    if (!c.cutoffEnabled) {
        log('fail', 'config.cutoffEnabled is still false');
        return { pass: false, reason: 'cutoffEnabled=false' };
    }
    log('pass', 'config.cutoffEnabled = true');

    // 2b. Verify MAIN world received config update
    // The config is sent via postMessage from ISOLATED to MAIN world
    // Give it a moment to propagate
    await new Promise(r => setTimeout(r, 500));

    const mainConfig = await cdp.evaluateMain(`
        (function() {
            // The MAIN world interceptor stores config in a module-scoped variable
            // accessible via __MCP_SA_FETCH_STATE or similar diagnostic hooks
            if (typeof window.__MCP_SA_FETCH_STATE === 'function') {
                const state = window.__MCP_SA_FETCH_STATE();
                return { cutoffEnabled: state.config?.cutoffEnabled, source: '__MCP_SA_FETCH_STATE' };
            }
            // Alternative: check if the config message was received
            return { source: 'no_diagnostic_hook', note: 'Cannot directly verify MAIN world config' };
        })()
    `);

    log('info', 'MAIN world config check:', JSON.stringify(mainConfig?.value));

    if (mainConfig?.value?.cutoffEnabled === true) {
        log('pass', 'MAIN world cutoffEnabled = true');
    } else if (mainConfig?.value?.source === 'no_diagnostic_hook') {
        log('warn', 'Cannot verify MAIN world config directly (no diagnostic hook). Proceeding on trust.');
    } else {
        log('warn', 'MAIN world cutoffEnabled may not be set. Probe may use background path instead of cutoff path.');
    }

    return { pass: true };
}

// ============================================================================
// Phase 3: Execution Probe — Inject JSONL + Observe Lifecycle
// ============================================================================

async function phaseExecutionProbe(cdp) {
    console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('  PHASE 3: Execution Probe — JSONL Injection');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

    const NONCE = `diag_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    log('info', `Probe nonce: ${NONCE}`);

    // 3a. Set up event listener in ISOLATED world to capture execution events
    log('step', 'Installing event listener in ISOLATED world...');
    await cdp.evaluate(`
        (function() {
            window.__L5_PROBE_EVENTS = [];
            // Listen for stream_tool_execution events from the bridge
            // The bridge emits these via onEvent callback
            // We can observe them by hooking into the event bus or checking bridge info after
        })()
    `);

    // 3b. Clear Notion input field
    log('step', 'Clearing Notion input field...');
    await cdp.evaluate(`
        (async function() {
            const sel = 'div[role="textbox"][contenteditable="true"], div.content-editable-leaf-rtl[contenteditable="true"]';
            const el = document.querySelector(sel);
            if (el) {
                el.focus();
                const s = window.getSelection();
                if (s) { const r = document.createRange(); r.selectNodeContents(el); s.removeAllRanges(); s.addRange(r); }
                document.execCommand('delete', false);
            }
        })()
    `, { awaitPromise: true });
    await new Promise(r => setTimeout(r, 300));

    // 3c. Inject JSONL probe in MAIN world (like positive-a but with echo tool)
    log('step', 'Injecting JSONL probe in MAIN world...');

    // The JSONL payload simulates Notion AI producing a function_call for echo
    const probeResult = await cdp.evaluateMain(`
        (async function() {
            const NONCE = '${NONCE}';

            // Build NDJSON payload: normal text chunks + function_call
            const lines = [
                JSON.stringify({ type: "text", text: "Let me call the echo tool for you. " }),
                JSON.stringify({ type: "text", text: "I'll use the MCP echo function. " }),
                JSON.stringify({
                    type: "function_call",
                    name: "echo",
                    id: NONCE,
                    arguments: JSON.stringify({ message: "diagnostic-probe-" + NONCE })
                }),
            ];
            const body = lines.map(l => l + '\\n').join('');
            const encoder = new TextEncoder();
            const encoded = encoder.encode(body);

            // Create a ReadableStream that feeds chunks
            let chunkIndex = 0;
            const chunkSize = 64;
            const stream = new ReadableStream({
                pull(controller) {
                    if (chunkIndex >= encoded.length) {
                        controller.close();
                        return;
                    }
                    const end = Math.min(chunkIndex + chunkSize, encoded.length);
                    controller.enqueue(encoded.slice(chunkIndex, end));
                    chunkIndex = end;
                },
            });

            // Create a fake Response with proper headers
            const fakeResp = new Response(stream, {
                status: 200,
                headers: {
                    'content-type': 'application/x-ndjson',
                    'transfer-encoding': 'chunked',
                },
            });

            // Intercept: replace the real fetch temporarily
            const realFetch = window.__mcpsa_originalFetch || window.fetch;
            const probeUrl = 'https://www.notion.so/api/v3/runAgentIteration';

            // Directly call the patched fetch to trigger interception
            // The interceptor wraps fetch globally — so we call fetch() with the right URL
            try {
                const resp = await fetch(probeUrl, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ probeNonce: NONCE }),
                });

                // The interceptor should have wrapped this response
                // Read the body to trigger stream processing
                const reader = resp.body.getReader();
                let totalBytes = 0;
                while (true) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    totalBytes += value ? value.length : 0;
                }

                return {
                    success: true,
                    status: resp.status,
                    totalBytes,
                    note: 'Real fetch to Notion API — interceptor should process response stream',
                };
            } catch (e) {
                return {
                    success: false,
                    error: e.message,
                    note: 'Fetch to Notion API failed — expected if not authenticated',
                };
            }
        })()
    `, { awaitPromise: true });

    log('info', 'Probe injection result:', JSON.stringify(probeResult?.value));

    // 3d. Wait for execution pipeline to process
    log('step', 'Waiting for execution pipeline (5s)...');
    await new Promise(r => setTimeout(r, 5000));

    // 3e. Check bridge state after probe
    log('step', 'Checking bridge state after probe...');
    const postInfo = await cdp.evaluate(`
        (function() {
            const info = window.getStreamToolBridgeInfo();
            return {
                enabled: info.config?.enabled,
                cutoffEnabled: info.config?.cutoffEnabled,
                subscribed: info.subscribed,
                bridgeHandlerReady: info.bridgeHandlerReady,
                mcpClientReady: info.mcpClientReady,
                adapterAvailable: info.adapterAvailable,
                // Check execution guard for recent executions
                executionGuardStore: info.executionGuardStoreSize || 0,
                ackTrackerActive: info.ackTrackerActive,
            };
        })()
    `);
    log('info', 'Post-probe bridge info:', JSON.stringify(postInfo?.value));

    // 3f. Check DOM for injected result
    log('step', 'Checking DOM for injected tool result...');
    const domCheck = await cdp.evaluate(`
        (function() {
            const sel = 'div[role="textbox"][contenteditable="true"], div.content-editable-leaf-rtl[contenteditable="true"]';
            const el = document.querySelector(sel);
            const text = el ? el.textContent || '' : '';
            return {
                hasContent: text.length > 0,
                contentLength: text.length,
                contentPreview: text.substring(0, 300),
                containsNonce: text.includes('${NONCE}'),
                containsFunctionResult: text.includes('function_result'),
                containsEcho: text.includes('echo'),
            };
        })()
    `);
    log('info', 'DOM check:', JSON.stringify(domCheck?.value));

    return {
        nonce: NONCE,
        probeResult: probeResult?.value,
        postBridgeInfo: postInfo?.value,
        domCheck: domCheck?.value,
    };
}

// ============================================================================
// Phase 3-ALT: Direct stream_cutoff Event Injection
// If the fetch-based probe doesn't trigger execution (e.g., Notion API returns
// error), we can directly inject a stream_cutoff event via postMessage.
// This bypasses L1-L4 and tests only L5-L11.
// ============================================================================

async function phaseDirectCutoffInjection(cdp) {
    console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('  PHASE 3-ALT: Direct stream_cutoff Injection');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

    const NONCE = `diag_direct_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    log('info', `Direct probe nonce: ${NONCE}`);

    // Clear input
    await cdp.evaluate(`
        (async function() {
            const sel = 'div[role="textbox"][contenteditable="true"], div.content-editable-leaf-rtl[contenteditable="true"]';
            const el = document.querySelector(sel);
            if (el) {
                el.focus();
                const s = window.getSelection();
                if (s) { const r = document.createRange(); r.selectNodeContents(el); s.removeAllRanges(); s.addRange(r); }
                document.execCommand('delete', false);
            }
        })()
    `, { awaitPromise: true });
    await new Promise(r => setTimeout(r, 300));

    // Inject stream_cutoff event via postMessage from MAIN to ISOLATED
    log('step', 'Sending stream_cutoff event via postMessage (MAIN → ISOLATED)...');
    const injectResult = await cdp.evaluateMain(`
        (function() {
            const NONCE = '${NONCE}';
            const event = {
                type: 'stream_cutoff',
                streamId: 'diag-stream-' + NONCE,
                cutoffChunkIndex: 3,
                elapsedMs: 150,
                identity: {
                    name: 'echo',
                    callId: NONCE,
                    arguments: JSON.stringify({ message: 'diagnostic-probe-' + NONCE }),
                },
                reason: 'function_call_detected',
                forwardedTriggerChunk: true,
                mode: 'cancel',
            };

            // Send via postMessage using MCP-SuperAssistant protocol
            window.postMessage({
                channel: 'mcp-superassistant.stream',
                direction: 'main-to-isolated',
                version: 1,
                source: 'notion-main-fetch-interceptor',
                event: event,
            }, '*');

            return { sent: true, nonce: NONCE, eventType: event.type };
        })()
    `);

    log('info', 'postMessage sent:', JSON.stringify(injectResult?.value));

    // Wait for execution pipeline
    log('step', 'Waiting for execution pipeline (8s)...');
    await new Promise(r => setTimeout(r, 8000));

    // Check bridge state
    const postInfo = await cdp.evaluate(`
        (function() {
            const info = window.getStreamToolBridgeInfo();
            return {
                enabled: info.config?.enabled,
                cutoffEnabled: info.config?.cutoffEnabled,
                bridgeHandlerReady: info.bridgeHandlerReady,
                mcpClientReady: info.mcpClientReady,
                adapterAvailable: info.adapterAvailable,
                executionGuardStoreSize: info.executionGuardStoreSize || 0,
            };
        })()
    `);
    log('info', 'Post-probe bridge info:', JSON.stringify(postInfo?.value));

    // Check DOM
    const domCheck = await cdp.evaluate(`
        (function() {
            const sel = 'div[role="textbox"][contenteditable="true"], div.content-editable-leaf-rtl[contenteditable="true"]';
            const el = document.querySelector(sel);
            const text = el ? el.textContent || '' : '';
            return {
                hasContent: text.length > 0,
                contentLength: text.length,
                contentPreview: text.substring(0, 500),
                containsNonce: text.includes('${NONCE}'),
                containsFunctionResult: text.includes('function_result'),
                containsDiagnostic: text.includes('diagnostic-probe'),
            };
        })()
    `);
    log('info', 'DOM check:', JSON.stringify(domCheck?.value));

    return {
        nonce: NONCE,
        injectResult: injectResult?.value,
        postBridgeInfo: postInfo?.value,
        domCheck: domCheck?.value,
    };
}

// ============================================================================
// Phase 4: Restore
// ============================================================================

async function phaseRestore(cdp, origConfig) {
    console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('  PHASE 4: Restore Original Config');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

    if (!origConfig) {
        log('warn', 'No original config to restore');
        return;
    }

    const restoreResult = await cdp.evaluate(`
        (function() {
            if (typeof window.configureStreamToolBridge !== 'function') {
                return { error: 'configureStreamToolBridge not available' };
            }
            window.configureStreamToolBridge({
                enabled: ${origConfig.enabled || false},
                cutoffEnabled: ${origConfig.cutoffEnabled || false},
                autoInsert: ${origConfig.autoInsert !== undefined ? origConfig.autoInsert : true},
                autoSubmit: ${origConfig.autoSubmit || false},
                toolTimeoutMs: ${origConfig.toolTimeoutMs || 30000},
            });
            const info = window.getStreamToolBridgeInfo();
            return { restored: true, config: info.config };
        })()
    `);

    if (restoreResult?.value?.restored) {
        log('pass', 'Config restored:', JSON.stringify(restoreResult.value.config));
    } else {
        log('warn', 'Restore may have failed:', JSON.stringify(restoreResult?.value));
    }
}

// ============================================================================
// Main
// ============================================================================

(async () => {
    console.log('╔════════════════════════════════════════════════════╗');
    console.log('║  L5-L11 Diagnostic Probe — Execution Pipeline     ║');
    console.log('╚════════════════════════════════════════════════════╝');

    // Use proven preflight helper
    const pf = await preflight();
    log('info', `Extension: ${pf.extensionName} (${pf.extensionId})`);
    log('info', `Notion tab: ${pf.tab.url.substring(0, 80)}`);

    // Connect CDP
    const ws = new WebSocket(pf.tab.webSocketDebuggerUrl);
    await new Promise(r => ws.on('open', r));

    const contexts = [];
    ws.on('message', raw => {
        const obj = JSON.parse(raw);
        if (obj.method === 'Runtime.executionContextCreated') {
            contexts.push(obj.params.context);
        }
    });

    // Temp send for enable commands
    let tmpMsgId = 0;
    const tmpSend = (method, params) => new Promise((resolve) => {
        const myId = ++tmpMsgId;
        const timeout = setTimeout(() => resolve({ error: 'timeout' }), 10000);
        const handler = raw => { const obj = JSON.parse(raw); if (obj.id === myId) { clearTimeout(timeout); ws.off('message', handler); resolve(obj); } };
        ws.on('message', handler);
        ws.send(JSON.stringify({ id: myId, method, params: params || {} }));
    });

    await tmpSend('Runtime.enable');
    await tmpSend('Page.enable');
    let topFrameId = null;
    try {
        const ft = await tmpSend('Page.getFrameTree');
        topFrameId = getTopFrameId(ft);
    } catch { }
    await sleep(1500);

    // Find ISOLATED world context using proven helper
    const extCtx = selectExtensionIsolatedContext(contexts, pf.extensionId, topFrameId);
    if (!extCtx) {
        console.error('ERROR: Cannot find MCP SuperAssistant ISOLATED world context');
        console.log('  Available contexts:', contexts.map(c => ({ id: c.id, name: c.name, origin: c.origin?.substring(0, 50) })));
        ws.close();
        process.exit(1);
    }
    log('pass', `ISOLATED world context: ${extCtx.id} (frameId: ${extCtx.auxData?.frameId})`);

    // Create session with correct context
    const cdp = createSession(ws, extCtx.id);

    let origConfig = null;

    try {
        // Phase 1: Preflight
        const preflightResult = await phasePreflight(cdp);
        if (!preflightResult.pass) {
            console.log('\n⛔ PREFLIGHT FAILED:', preflightResult.reason);
            console.log('   Cannot proceed with execution probe.');
            ws.close();
            process.exit(1);
        }
        origConfig = preflightResult.origConfig;

        // Phase 2: Force-enable
        const enable = await phaseForceEnable(cdp);
        if (!enable.pass) {
            console.log('\n⛔ FORCE-ENABLE FAILED:', enable.reason);
            ws.close();
            process.exit(1);
        }

        // Phase 3: Execution probe (fetch-based)
        const execResult = await phaseExecutionProbe(cdp);

        // Phase 3-ALT: If fetch-based probe didn't trigger execution, try direct injection
        const fetchWorked = execResult.domCheck?.containsFunctionResult || execResult.domCheck?.containsNonce;
        if (!fetchWorked) {
            log('warn', 'Fetch-based probe did not produce DOM result. Trying direct stream_cutoff injection...');
            const directResult = await phaseDirectCutoffInjection(cdp);

            // Final summary
            console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
            console.log('  RESULTS SUMMARY');
            console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

            console.log('Phase 3 (fetch-based):');
            log(execResult.domCheck?.containsFunctionResult ? 'pass' : 'fail',
                'DOM function_result:', execResult.domCheck?.containsFunctionResult);
            log(execResult.domCheck?.containsNonce ? 'pass' : 'fail',
                'DOM nonce:', execResult.domCheck?.containsNonce);

            console.log('\nPhase 3-ALT (direct injection):');
            log(directResult.domCheck?.containsFunctionResult ? 'pass' : 'fail',
                'DOM function_result:', directResult.domCheck?.containsFunctionResult);
            log(directResult.domCheck?.containsNonce ? 'pass' : 'fail',
                'DOM nonce:', directResult.domCheck?.containsNonce);
            log(directResult.domCheck?.containsDiagnostic ? 'pass' : 'fail',
                'DOM diagnostic:', directResult.domCheck?.containsDiagnostic);

            if (directResult.domCheck?.contentLength > 0) {
                console.log('\nDOM content preview:');
                console.log('  ', directResult.domCheck.contentPreview);
            }
        } else {
            // Fetch-based probe worked
            console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
            console.log('  RESULTS SUMMARY');
            console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

            log('pass', 'Fetch-based probe produced DOM result!');
            log(execResult.domCheck?.containsFunctionResult ? 'pass' : 'fail',
                'DOM function_result:', execResult.domCheck?.containsFunctionResult);
            log(execResult.domCheck?.containsNonce ? 'pass' : 'fail',
                'DOM nonce:', execResult.domCheck?.containsNonce);

            if (execResult.domCheck?.contentLength > 0) {
                console.log('\nDOM content preview:');
                console.log('  ', execResult.domCheck.contentPreview);
            }
        }

    } finally {
        // Phase 4: Always restore
        await phaseRestore(cdp, origConfig);
        ws.close();
    }

    console.log('\n● Probe complete.');
})().catch(e => {
    console.error('FATAL:', e.message);
    process.exit(1);
});
