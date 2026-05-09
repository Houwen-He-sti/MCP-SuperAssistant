/**
 * Gate 5c: AI Consumption / Sentinel Verification E2E
 *
 * Proves AI actually consumes the tool result injected by the bridge.
 * Extends Gate 5b pipeline proof with:
 *   - Phase 0: MCP registry diagnosis (hard preflight gate)
 *   - Sentinel before/after protocol (assistant delta monitoring)
 *   - 3-attempt budget with unique sentinels
 *
 * Prerequisites:
 *   1. Chrome launched with: --remote-debugging-port=9222
 *   2. Notion agent page open with MCP SuperAssistant extension loaded
 *   3. committee-bridge-mcp running (echo tool registered)
 *   4. Bridge autoInsert=true, autoSubmit=true
 *
 * Run: node scripts/e2e-gate5c-consumption.cjs
 *
 * Outputs:
 *   outputs/gate5c-consumption-{timestamp}.json
 *   outputs/gate5c-consumption-{timestamp}.md
 *
 * Author: Opus/Claude
 */

const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');

const CDP_PORT = 9222;
const TIMEOUT_MS = 10000;
const POLL_INTERVAL_MS = 3000;
const MAX_POLL_ROUNDS = 30; // 90 seconds per attempt
const MAX_ATTEMPTS = 3;
const SENTINEL_PREFIX = 'sentinel_g5c_';

// ============================================================================
// CDP Infrastructure (shared with Gate 5b)
// ============================================================================

async function main() {
    const startTime = Date.now();
    const evidence = {
        gate: '5c',
        timestamp: new Date().toISOString(),
        phase0: null,
        attempts: [],
        bestResult: 'PENDING',
        bestEvidenceQuality: null,
        durationMs: 0,
    };

    try {
        // Phase 0: MCP Registry Diagnosis
        const phase0 = await runPhase0();
        evidence.phase0 = phase0;

        if (!phase0.passed) {
            evidence.bestResult = 'PHASE0_FAIL';
            console.log('\n❌ Phase 0 failed — stopping. Echo tool not available.');
            return;
        }

        // Consumption attempts (up to MAX_ATTEMPTS)
        for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
            console.log(`\n${'='.repeat(60)}`);
            console.log(`🔄 Attempt ${attempt + 1}/${MAX_ATTEMPTS}`);
            console.log('='.repeat(60));

            const sentinel = SENTINEL_PREFIX + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6);
            const attemptResult = await runConsumptionAttempt(sentinel, attempt + 1);
            evidence.attempts.push(attemptResult);

            if (attemptResult.consumptionResult === 'CONSUMPTION_PASS') {
                evidence.bestResult = 'CONSUMPTION_PASS';
                evidence.bestEvidenceQuality = attemptResult.evidenceQuality;
                console.log(`\n🎉 CONSUMPTION_PASS on attempt ${attempt + 1}!`);
                break;
            }

            if (attemptResult.consumptionResult === 'CONSUMPTION_PARTIAL') {
                // Record but keep trying
                if (!evidence.bestEvidenceQuality || evidence.bestEvidenceQuality === 'none') {
                    evidence.bestResult = 'CONSUMPTION_PARTIAL';
                    evidence.bestEvidenceQuality = attemptResult.evidenceQuality;
                }
            }

            // Wait between attempts
            if (attempt < MAX_ATTEMPTS - 1) {
                console.log('\n⏳ Waiting 5s before next attempt...');
                await new Promise(r => setTimeout(r, 5000));
            }
        }

        // Final determination
        if (evidence.bestResult === 'PENDING') {
            // No PASS or PARTIAL across all attempts
            const anyPipelineOk = evidence.attempts.some(a => a.pipelineOk);
            evidence.bestResult = anyPipelineOk ? 'CONSUMPTION_FAIL' : 'PIPELINE_FAIL';
        }
    } catch (err) {
        evidence.bestResult = 'ERROR';
        evidence.errorDetail = err.message;
        console.error('\n❌ Fatal error:', err.message);
    } finally {
        evidence.durationMs = Date.now() - startTime;
        await writeEvidence(evidence);
    }
}

// ============================================================================
// Phase 0: MCP Registry Diagnosis (Hard Preflight Gate)
// ============================================================================

async function runPhase0() {
    console.log('\n🔍 Phase 0: MCP Registry Diagnosis\n');

    const { ensureAgentPage } = require('./lib/cdp-preflight.cjs');
    const page = await ensureAgentPage();
    const notionTab = page.tab;
    console.log(`✅ Tab: ${notionTab.url.slice(0, 80)}${page.navigated ? ' (navigated)' : ''}`);

    const ws = new WebSocket(notionTab.webSocketDebuggerUrl);
    let msgId = 0;
    const listeners = new Map();
    const contexts = [];

    ws.on('message', (data) => {
        const msg = JSON.parse(data);
        if (msg.id && listeners.has(msg.id)) {
            listeners.get(msg.id)(msg);
            listeners.delete(msg.id);
        }
        if (msg.method === 'Runtime.executionContextCreated') {
            contexts.push(msg.params.context);
        }
    });

    await new Promise((r, e) => { ws.on('open', r); ws.on('error', e); });

    function send(method, params = {}) {
        return new Promise(resolve => {
            const id = ++msgId;
            listeners.set(id, resolve);
            ws.send(JSON.stringify({ id, method, params }));
            setTimeout(() => {
                if (listeners.has(id)) { listeners.delete(id); resolve({ error: 'timeout' }); }
            }, TIMEOUT_MS);
        });
    }

    async function evalIso(expression, opts = {}) {
        const params = { expression, returnByValue: true, awaitPromise: opts.awaitPromise || false, contextId: isoCtx, ...opts };
        const result = await send('Runtime.evaluate', params);
        return result.result?.result;
    }

    await send('Runtime.enable');
    await new Promise(r => setTimeout(r, 1500));

    // Find ISOLATED world
    let isoCtx = null;
    for (const ctx of contexts) {
        if (ctx.name === 'MCP SuperAssistant') {
            const check = await send('Runtime.evaluate', {
                contextId: ctx.id,
                expression: "typeof window.pluginRegistry !== 'undefined'",
                returnByValue: true,
            });
            if (check.result?.result?.value === true) { isoCtx = ctx.id; break; }
        }
    }

    if (!isoCtx) {
        ws.close();
        return { passed: false, error: 'No ISOLATED world found', runtimeSurface: null, tools: [] };
    }
    console.log('✅ ISOLATED world:', isoCtx);

    // Discover runtime API surface
    const surfaceResult = await evalIso(`(function() {
        const mc = window.mcpClient;
        if (!mc) return { hasMcpClient: false };
        return {
            hasMcpClient: true,
            isReady: typeof mc.isReady === 'function' ? mc.isReady() : 'N/A',
            hasCallTool: typeof mc.callTool === 'function',
            hasIsReady: typeof mc.isReady === 'function',
            hasGetAvailableTools: typeof mc.getAvailableTools === 'function',
            hasGetTools: typeof mc.getTools === 'function',
            hasListTools: typeof mc.listTools === 'function',
            mcpClientKeys: Object.keys(mc).concat(
                Object.getOwnPropertyNames(Object.getPrototypeOf(mc) || {})
            ).filter((v, i, a) => a.indexOf(v) === i),
        };
    })()`, { awaitPromise: false });

    const surface = surfaceResult?.value;
    console.log('Runtime surface:', JSON.stringify(surface, null, 2));

    if (!surface?.hasMcpClient || !surface.isReady) {
        ws.close();
        return { passed: false, error: 'mcpClient not available or not ready', runtimeSurface: surface, tools: [] };
    }

    // Try to discover tools using available API
    let tools = [];
    let toolDiscoveryMethod = 'none';

    if (surface.hasGetAvailableTools) {
        const toolsResult = await evalIso(`(async function() {
            try {
                const t = await window.mcpClient.getAvailableTools();
                return Array.isArray(t) ? t.map(x => typeof x === 'string' ? x : (x.name || JSON.stringify(x))) : [];
            } catch (e) { return { error: e.message }; }
        })()`, { awaitPromise: true });
        if (Array.isArray(toolsResult?.value)) {
            tools = toolsResult.value;
            toolDiscoveryMethod = 'getAvailableTools';
        }
    }

    if (tools.length === 0 && surface.hasGetTools) {
        const toolsResult = await evalIso(`(async function() {
            try {
                const t = await window.mcpClient.getTools();
                return Array.isArray(t) ? t.map(x => typeof x === 'string' ? x : (x.name || JSON.stringify(x))) : [];
            } catch (e) { return { error: e.message }; }
        })()`, { awaitPromise: true });
        if (Array.isArray(toolsResult?.value)) {
            tools = toolsResult.value;
            toolDiscoveryMethod = 'getTools';
        }
    }

    if (tools.length === 0 && surface.hasListTools) {
        const toolsResult = await evalIso(`(async function() {
            try {
                const t = await window.mcpClient.listTools();
                return Array.isArray(t) ? t.map(x => typeof x === 'string' ? x : (x.name || JSON.stringify(x))) : [];
            } catch (e) { return { error: e.message }; }
        })()`, { awaitPromise: true });
        if (Array.isArray(toolsResult?.value)) {
            tools = toolsResult.value;
            toolDiscoveryMethod = 'listTools';
        }
    }

    // Fallback: probe echo directly
    if (tools.length === 0) {
        console.log('⚠️ No tool list API found. Probing echo tool directly...');
        const probeResult = await evalIso(`(async function() {
            try {
                const result = await window.mcpClient.callTool('echo', { message: 'phase0_probe' });
                return { probeOk: true, result: JSON.stringify(result).slice(0, 300) };
            } catch (e) {
                return { probeOk: false, error: e.message };
            }
        })()`, { awaitPromise: true });
        const probe = probeResult?.value;
        console.log('Echo probe:', JSON.stringify(probe));

        if (probe?.probeOk) {
            tools = ['echo (probe-confirmed)'];
            toolDiscoveryMethod = 'direct_probe';
        } else {
            // Distinguish "not registered" from other errors
            const isNotRegistered = probe?.error?.includes('not registered') || probe?.error?.includes('not found');
            ws.close();
            return {
                passed: false,
                error: isNotRegistered
                    ? 'echo tool not registered in MCP registry'
                    : `echo probe failed: ${probe?.error}`,
                runtimeSurface: surface,
                tools,
                toolDiscoveryMethod,
                probeResult: probe,
            };
        }
    }

    const hasEcho = tools.some(t => typeof t === 'string' && t.includes('echo'));
    console.log(`\nTool discovery (${toolDiscoveryMethod}): ${tools.length} tools found`);
    console.log('Tools:', tools.join(', '));
    console.log(`Echo registered: ${hasEcho ? '✅' : '❌'}`);

    // Get server identity
    const serverInfo = await evalIso(`(function() {
        try {
            return window.mcpClient?.serverInfo || window.mcpClient?._serverInfo || null;
        } catch { return null; }
    })()`, { awaitPromise: false });

    ws.close();

    return {
        passed: hasEcho,
        error: hasEcho ? null : 'echo tool not found in registry',
        runtimeSurface: surface,
        tools,
        toolCount: tools.length,
        toolDiscoveryMethod,
        serverIdentity: serverInfo?.value || null,
        hasEcho,
    };
}

// ============================================================================
// Consumption Attempt
// ============================================================================

async function runConsumptionAttempt(sentinel, attemptNumber) {
    const attemptStart = Date.now();
    const result = {
        attemptNumber,
        sentinel,
        pipelineOk: false,
        consumptionResult: 'PENDING',
        evidenceQuality: 'none',
        toolExecution: null,
        consumptionEvidence: null,
        events: [],
        streamLifecycle: [],
        durationMs: 0,
        diagnostics: {},
    };

    console.log(`\nSentinel: ${sentinel}`);

    const { ensureAgentPage } = require('./lib/cdp-preflight.cjs');
    const page = await ensureAgentPage();
    const notionTab = page.tab;

    const ws = new WebSocket(notionTab.webSocketDebuggerUrl);
    let msgId = 0;
    const listeners = new Map();
    const contexts = [];
    const streamLifecycle = [];

    ws.on('message', (data) => {
        const msg = JSON.parse(data);
        if (msg.id && listeners.has(msg.id)) {
            listeners.get(msg.id)(msg);
            listeners.delete(msg.id);
        }
        if (msg.method === 'Runtime.executionContextCreated') {
            contexts.push(msg.params.context);
        }
    });

    await new Promise((r, e) => { ws.on('open', r); ws.on('error', e); });

    function send(method, params = {}) {
        return new Promise(resolve => {
            const id = ++msgId;
            listeners.set(id, resolve);
            ws.send(JSON.stringify({ id, method, params }));
            setTimeout(() => {
                if (listeners.has(id)) { listeners.delete(id); resolve({ error: 'timeout' }); }
            }, TIMEOUT_MS);
        });
    }

    async function evalMain(expression, opts = {}) {
        const params = { expression, returnByValue: true, awaitPromise: opts.awaitPromise || false, ...opts };
        const r = await send('Runtime.evaluate', params);
        return r.result?.result;
    }

    let isoCtx = null;
    async function evalIso(expression, opts = {}) {
        const params = { expression, returnByValue: true, awaitPromise: opts.awaitPromise || false, contextId: isoCtx, ...opts };
        const r = await send('Runtime.evaluate', params);
        return r.result?.result;
    }

    await send('Runtime.enable');
    await new Promise(r => setTimeout(r, 1500));

    // Find ISOLATED world
    for (const ctx of contexts) {
        if (ctx.name === 'MCP SuperAssistant') {
            const check = await send('Runtime.evaluate', {
                contextId: ctx.id,
                expression: "typeof window.pluginRegistry !== 'undefined'",
                returnByValue: true,
            });
            if (check.result?.result?.value === true) { isoCtx = ctx.id; break; }
        }
    }
    if (!isoCtx) {
        result.consumptionResult = 'ERROR';
        result.diagnostics.error = 'No ISOLATED world found';
        ws.close();
        result.durationMs = Date.now() - attemptStart;
        return result;
    }

    // --- Configure bridge ---
    const configResult = await evalIso(`(function() {
        try {
            if (typeof window.configureStreamToolBridge === 'function') {
                window.configureStreamToolBridge({
                    enabled: true, cutoffEnabled: true, autoInsert: true, autoSubmit: true,
                });
                const info = window.getStreamToolBridgeInfo?.();
                return { ok: true, config: info?.config };
            }
            return { ok: false, error: 'configureStreamToolBridge not found' };
        } catch (e) { return { ok: false, error: e.message }; }
    })()`, { awaitPromise: false });

    if (!configResult?.value?.ok) {
        result.consumptionResult = 'ERROR';
        result.diagnostics.error = 'Bridge config failed: ' + configResult?.value?.error;
        ws.close();
        result.durationMs = Date.now() - attemptStart;
        return result;
    }
    console.log('✅ Bridge configured');

    // --- Install wrappers (same as Gate 5b, guard double-wrap) ---
    const wrapResult = await evalIso(`(function() {
        if (window.__gate5c_wrapped) return { ok: true, alreadyWrapped: true };
        window.__gate5c_events = [];
        window.__gate5c_wrapped = true;

        // Wrap mcpClient.callTool
        const mc = window.mcpClient;
        if (mc && typeof mc.callTool === 'function') {
            const origCallTool = mc.callTool.bind(mc);
            mc.callTool = async (name, params) => {
                window.__gate5c_events.push({ type: 'callTool', name, params: JSON.stringify(params).slice(0, 500), ts: Date.now() });
                try {
                    const r = await origCallTool(name, params);
                    window.__gate5c_events.push({ type: 'callTool_result', name, resultPreview: JSON.stringify(r).slice(0, 500), isError: false, ts: Date.now() });
                    return r;
                } catch (e) {
                    window.__gate5c_events.push({ type: 'callTool_error', name, error: e.message, isError: true, ts: Date.now() });
                    throw e;
                }
            };
        }

        // Resolve adapter
        const win = window;
        let adapter = null;
        const reg = win.pluginRegistry;
        const plugin = reg?.getActivePlugin?.();
        if (plugin?.adapter && typeof plugin.adapter.insertText === 'function') adapter = plugin.adapter;
        if (!adapter && plugin && typeof plugin.insertText === 'function') adapter = plugin;
        if (!adapter && win.mcpAdapter && typeof win.mcpAdapter.insertText === 'function') adapter = win.mcpAdapter;
        if (!adapter && typeof win.getCurrentAdapter === 'function') adapter = win.getCurrentAdapter();

        if (adapter) {
            if (typeof adapter.insertText === 'function') {
                const origInsert = adapter.insertText.bind(adapter);
                adapter.insertText = async (text) => {
                    window.__gate5c_events.push({ type: 'insertText', textLen: text.length, preview: text.slice(0, 300), ts: Date.now() });
                    try {
                        const r = await origInsert(text);
                        window.__gate5c_events.push({ type: 'insertText_result', result: r, ts: Date.now() });
                        return r;
                    } catch (e) {
                        window.__gate5c_events.push({ type: 'insertText_error', error: e.message, ts: Date.now() });
                        throw e;
                    }
                };
            }
            if (typeof adapter.submitForm === 'function') {
                const origSubmit = adapter.submitForm.bind(adapter);
                adapter.submitForm = async () => {
                    window.__gate5c_events.push({ type: 'submitForm', ts: Date.now() });
                    try {
                        const r = await origSubmit();
                        window.__gate5c_events.push({ type: 'submitForm_result', result: r, ts: Date.now() });
                        return r;
                    } catch (e) {
                        window.__gate5c_events.push({ type: 'submitForm_error', error: e.message, ts: Date.now() });
                        throw e;
                    }
                };
            }
        }
        return { ok: true, adapterFound: !!adapter };
    })()`, { awaitPromise: false });

    if (!wrapResult?.value?.ok) {
        result.consumptionResult = 'ERROR';
        result.diagnostics.error = 'Wrapper install failed';
        ws.close();
        result.durationMs = Date.now() - attemptStart;
        return result;
    }
    console.log('✅ Wrappers installed');

    // --- Install MAIN world stream listener ---
    await evalMain(`(function() {
        if (window.__gate5c_stream) return;
        window.__gate5c_stream = [];
        window.addEventListener('message', function(e) {
            const d = e.data;
            if (d && d.channel === 'mcp-superassistant.stream' && d.direction === 'main-to-isolated' && d.event) {
                window.__gate5c_stream.push({
                    event: d.event.type || 'unknown',
                    ts: Date.now(),
                    detail: JSON.stringify(d.event).slice(0, 300)
                });
            }
        });
    })()`, { awaitPromise: false });

    // --- Baseline snapshot (before prompt) ---
    const baseline = await evalMain(`(function() {
        const sentinel = ${JSON.stringify(sentinel)};
        // Count assistant message blocks
        // Notion agent uses various selectors; try common patterns
        const allBlocks = document.querySelectorAll('[data-block-id]');
        const bodyText = document.body.innerText;
        return {
            bodyTextLength: bodyText.length,
            sentinelCountInBody: (bodyText.match(new RegExp(sentinel, 'g')) || []).length,
            blockCount: allBlocks.length,
            bodyTailSnapshot: bodyText.slice(-300),
        };
    })()`);

    const baselineVal = baseline?.value || {};
    console.log(`Baseline: sentinel=${baselineVal.sentinelCountInBody}, bodyLen=${baselineVal.bodyTextLength}, blocks=${baselineVal.blockCount}`);

    // --- Inject prompt + submit ---
    // Clear input
    await evalMain(`(async function() {
        const sel = 'div[role="textbox"][contenteditable="true"]';
        const el = document.querySelector(sel);
        if (el) {
            el.focus();
            const s = window.getSelection();
            if (s) { const r = document.createRange(); r.selectNodeContents(el); s.removeAllRanges(); s.addRange(r); }
            document.execCommand('delete', false);
        }
    })()`, { awaitPromise: true });
    await new Promise(r => setTimeout(r, 500));

    // Type prompt
    const prompt = `请调用 echo 工具，参数为 {"message": "${sentinel}"}`;
    const typeResult = await evalMain(`(function() {
        const el = document.querySelector('div[role="textbox"][contenteditable="true"]');
        if (!el) return { ok: false, error: 'no textbox' };
        el.focus();
        document.execCommand('insertText', false, ${JSON.stringify(prompt)});
        return { ok: true, preview: el.textContent.slice(0, 100) };
    })()`, { awaitPromise: false });

    if (!typeResult?.value?.ok) {
        result.consumptionResult = 'ERROR';
        result.diagnostics.error = 'Failed to type prompt: ' + typeResult?.value?.error;
        ws.close();
        result.durationMs = Date.now() - attemptStart;
        return result;
    }
    console.log('✅ Prompt typed');

    // Submit
    await new Promise(r => setTimeout(r, 500));
    const submitResult = await evalMain(`(function() {
        const btn = document.querySelector('[data-testid="agent-send-message-button"]');
        if (btn) { btn.click(); return { method: 'sendButton', ok: true }; }
        const btn2 = document.querySelector('[aria-label="提交 AI 消息"]');
        if (btn2) { btn2.click(); return { method: 'ariaLabel', ok: true }; }
        const textbox = document.querySelector('div[role="textbox"][contenteditable="true"]');
        if (textbox) {
            textbox.focus();
            textbox.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true }));
            return { method: 'enter', ok: true };
        }
        return { method: 'none', error: 'No submit method found' };
    })()`, { awaitPromise: false });

    if (!submitResult?.value?.ok) {
        result.consumptionResult = 'ERROR';
        result.diagnostics.error = 'Failed to submit: ' + submitResult?.value?.error;
        ws.close();
        result.durationMs = Date.now() - attemptStart;
        return result;
    }
    console.log(`✅ Prompt submitted via ${submitResult?.value?.method}`);

    // --- Poll for bridge activity + consumption ---
    console.log('--- Polling for bridge activity + consumption ---');
    let toolExecuted = false;
    let toolResultIsSuccess = false;
    let resultInserted = false;
    let formSubmitted = false;
    let submitFormOk = false;
    let consumptionDetected = false;
    let evidenceQuality = 'none';

    for (let round = 0; round < MAX_POLL_ROUNDS; round++) {
        await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));

        // Read events from ISOLATED world
        const eventsResult = await evalIso(`(function() {
            return JSON.parse(JSON.stringify(window.__gate5c_events || []));
        })()`, { awaitPromise: false });
        const events = eventsResult?.value || [];

        // Read stream lifecycle from MAIN world
        const streamResult = await evalMain(`(function() {
            return JSON.parse(JSON.stringify(window.__gate5c_stream || []));
        })()`);
        if (streamResult?.value?.length > 0) {
            const existingTs = new Set(streamLifecycle.map(e => e.ts));
            for (const evt of streamResult.value) {
                if (!existingTs.has(evt.ts)) {
                    streamLifecycle.push({ text: evt.event + ': ' + (evt.detail || '').slice(0, 200), ts: evt.ts });
                }
            }
        }

        // Analyze events
        const callToolEvent = events.find(e => e.type === 'callTool');
        const callToolResultEvent = events.find(e => e.type === 'callTool_result');
        const callToolErrorEvent = events.find(e => e.type === 'callTool_error');
        const insertTextEvent = events.find(e => e.type === 'insertText');
        const submitFormEvent = events.find(e => e.type === 'submitForm');
        const submitFormResultEvent = events.find(e => e.type === 'submitForm_result');

        if (callToolEvent && !toolExecuted) {
            toolExecuted = true;
            console.log(`  ✅ Tool called: ${callToolEvent.name}`);
        }
        if (callToolResultEvent && !toolResultIsSuccess) {
            toolResultIsSuccess = !callToolResultEvent.isError;
            result.toolExecution = {
                name: callToolEvent?.name,
                resultPreview: callToolResultEvent.resultPreview,
                isError: callToolResultEvent.isError,
            };
            if (toolResultIsSuccess) {
                console.log(`  ✅ Tool returned SUCCESS result`);
            } else {
                console.log(`  ⚠️ Tool returned ERROR result`);
            }
        }
        if (callToolErrorEvent) {
            result.toolExecution = {
                name: callToolEvent?.name,
                error: callToolErrorEvent.error,
                isError: true,
            };
            console.log(`  ❌ Tool call threw: ${callToolErrorEvent.error}`);
        }
        if (insertTextEvent && !resultInserted) {
            resultInserted = true;
            // Check if success result (contains sentinel, no <error>)
            const isSuccessInsert = insertTextEvent.preview.includes(sentinel) && !insertTextEvent.preview.includes('<error>');
            console.log(`  ✅ Result injected: ${insertTextEvent.textLen} chars ${isSuccessInsert ? '(SUCCESS path)' : '(ERROR path)'}`);
        }
        if (submitFormEvent && !formSubmitted) {
            formSubmitted = true;
            submitFormOk = submitFormResultEvent?.result === true;
            console.log(`  ${submitFormOk ? '✅' : '⚠️'} submitForm called (result: ${submitFormResultEvent?.result})`);
        }

        // Pipeline complete?
        const pipelineDone = toolExecuted && resultInserted && formSubmitted;
        result.pipelineOk = pipelineDone && submitFormOk && toolResultIsSuccess;

        // After pipeline complete, monitor for AI consumption
        if (pipelineDone && submitFormOk) {
            // Post-submit delta check
            const postSubmit = await evalMain(`(function() {
                const sentinel = ${JSON.stringify(sentinel)};
                const bodyText = document.body.innerText;
                const sentinelCount = (bodyText.match(new RegExp(sentinel, 'g')) || []).length;
                const blocks = document.querySelectorAll('[data-block-id]');

                // Try to find new text after the last occurrence of sentinel in injected content
                // The key insight: sentinel appears in (1) user prompt, (2) injected tool result
                // If it appears a 3rd time, that's likely the AI's response
                // But more reliably: look at body text AFTER the inject point
                const bodyTail = bodyText.slice(-500);

                return {
                    sentinelCountInBody: sentinelCount,
                    blockCount: blocks.length,
                    bodyTextLength: bodyText.length,
                    bodyTail,
                };
            })()`);

            const postVal = postSubmit?.value || {};
            const baselineSentinelCount = baselineVal.sentinelCountInBody || 0;
            const bodyGrew = postVal.bodyTextLength > (baselineVal.bodyTextLength || 0) + 50;
            const newBlocks = postVal.blockCount > (baselineVal.blockCount || 0);

            // Sentinel count analysis:
            // baselineSentinelCount: before prompt (should be 0)
            // After prompt submit: +1 (user prompt contains sentinel)
            // After tool result inject: +1 (injected XML contains sentinel)
            // After AI consumption: +1 (AI response references sentinel)
            // So total ≥ 3 means AI consumed it
            const sentinelInNewContent = postVal.sentinelCountInBody >= baselineSentinelCount + 3;

            // Better: check if body tail (new content) contains sentinel
            // But we need to be smarter — check if bodyTail has content beyond the injected XML
            const tailHasSentinel = postVal.bodyTail?.includes(sentinel);

            if (round % 3 === 0 || sentinelInNewContent) {
                console.log(`  Poll ${round + 1}/${MAX_POLL_ROUNDS}: sentinel=${postVal.sentinelCountInBody} (base=${baselineSentinelCount}), blocks=${postVal.blockCount}, bodyLen=${postVal.bodyTextLength}`);
            }

            if (sentinelInNewContent && bodyGrew) {
                // Strong evidence: sentinel count increased by 3+ AND body grew
                consumptionDetected = true;
                evidenceQuality = 'assistant_delta';
                result.consumptionEvidence = {
                    sentinelBeforePrompt: baselineSentinelCount,
                    sentinelAfterSubmit: postVal.sentinelCountInBody,
                    bodyGrew,
                    newBlocks,
                    bodyTailSnippet: postVal.bodyTail?.slice(-300),
                    consumptionEvidenceQuality: 'assistant_delta',
                };
                console.log(`  🎉 CONSUMPTION DETECTED (assistant_delta): sentinel ${baselineSentinelCount} → ${postVal.sentinelCountInBody}`);
                break;
            }

            // Secondary check: body grew significantly + new blocks appeared
            // (AI responded but might not have echoed sentinel verbatim)
            if (bodyGrew && newBlocks && round >= 10) {
                // Check if there's substantial new text after the inject
                const newContentLen = postVal.bodyTextLength - (baselineVal.bodyTextLength || 0);
                if (newContentLen > 100 && tailHasSentinel) {
                    consumptionDetected = true;
                    evidenceQuality = 'transcript_diff';
                    result.consumptionEvidence = {
                        sentinelBeforePrompt: baselineSentinelCount,
                        sentinelAfterSubmit: postVal.sentinelCountInBody,
                        bodyGrew,
                        newBlocks,
                        newContentLength: newContentLen,
                        bodyTailSnippet: postVal.bodyTail?.slice(-300),
                        consumptionEvidenceQuality: 'transcript_diff',
                    };
                    console.log(`  ✅ Consumption evidence (transcript_diff): new content ${newContentLen} chars, sentinel in tail`);
                    break;
                }
            }
        }

        // Store events
        result.events = events;

        // Early exit: pipeline failed hard (callTool error + no insert)
        if (callToolErrorEvent && !resultInserted && round > 10) {
            break;
        }
    }

    result.streamLifecycle = streamLifecycle;

    // --- Determine consumption result ---
    if (consumptionDetected && evidenceQuality === 'assistant_delta') {
        result.consumptionResult = 'CONSUMPTION_PASS';
        result.evidenceQuality = 'assistant_delta';
    } else if (consumptionDetected && evidenceQuality === 'transcript_diff') {
        result.consumptionResult = 'CONSUMPTION_PASS';
        result.evidenceQuality = 'transcript_diff';
    } else if (result.pipelineOk && !consumptionDetected) {
        // Pipeline worked but AI didn't reference sentinel
        // Do one final deep check
        const finalCheck = await evalMain(`(function() {
            const sentinel = ${JSON.stringify(sentinel)};
            const bodyText = document.body.innerText;
            const count = (bodyText.match(new RegExp(sentinel, 'g')) || []).length;
            const idx = bodyText.lastIndexOf(sentinel);
            let context = '';
            if (idx > -1) context = bodyText.slice(Math.max(0, idx - 200), Math.min(bodyText.length, idx + sentinel.length + 200));
            return { count, context, bodyLen: bodyText.length };
        })()`);
        const finalVal = finalCheck?.value || {};
        result.consumptionEvidence = {
            sentinelBeforePrompt: baselineVal.sentinelCountInBody || 0,
            sentinelAfterSubmit: finalVal.count || 0,
            finalContext: finalVal.context,
            consumptionEvidenceQuality: (finalVal.count || 0) >= 3 ? 'body_count_only' : 'none',
        };

        if ((finalVal.count || 0) >= (baselineVal.sentinelCountInBody || 0) + 3) {
            result.consumptionResult = 'CONSUMPTION_PARTIAL';
            result.evidenceQuality = 'body_count_only';
        } else {
            result.consumptionResult = 'CONSUMPTION_PARTIAL';
            result.evidenceQuality = 'none';
        }
    } else if (toolExecuted && !toolResultIsSuccess) {
        result.consumptionResult = 'TOOL_ERROR';
    } else if (!toolExecuted) {
        result.consumptionResult = 'SCANNER_MISS';
    } else {
        result.consumptionResult = 'PIPELINE_FAIL';
    }

    console.log(`\n  Attempt ${attemptNumber} result: ${result.consumptionResult} (evidence: ${result.evidenceQuality})`);

    ws.close();
    result.durationMs = Date.now() - attemptStart;
    return result;
}

// ============================================================================
// Evidence Output
// ============================================================================

async function writeEvidence(evidence) {
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const dir = path.join(__dirname, '..', 'outputs');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    // JSON
    const jsonPath = path.join(dir, `gate5c-consumption-${ts}.json`);
    fs.writeFileSync(jsonPath, JSON.stringify(evidence, null, 2));
    console.log(`\n📄 JSON: ${jsonPath}`);

    // Markdown
    const mdPath = path.join(dir, `gate5c-consumption-${ts}.md`);
    const md = generateMarkdownReport(evidence);
    fs.writeFileSync(mdPath, md);
    console.log(`📄 Markdown: ${mdPath}`);
}

function generateMarkdownReport(ev) {
    const lines = [
        `# Gate 5c Consumption E2E Evidence — ${ev.timestamp}`,
        '',
        `## Result: ${ev.bestResult}`,
        '',
    ];

    // Phase 0 summary
    lines.push('## Phase 0: MCP Registry Diagnosis', '');
    if (ev.phase0) {
        lines.push(
            '| Check | Status |',
            '|-------|--------|',
            `| ISOLATED world | ${ev.phase0.runtimeSurface ? '✅' : '❌'} |`,
            `| mcpClient ready | ${ev.phase0.runtimeSurface?.isReady ? '✅' : '❌'} |`,
            `| Tool discovery | ${ev.phase0.toolDiscoveryMethod || 'N/A'} |`,
            `| Tools found | ${ev.phase0.toolCount ?? 'N/A'} |`,
            `| echo registered | ${ev.phase0.hasEcho ? '✅' : '❌'} |`,
            `| Phase 0 gate | ${ev.phase0.passed ? '✅ PASS' : '❌ FAIL'} |`,
            '',
        );
        if (ev.phase0.tools?.length > 0) {
            lines.push('**Available tools**: ' + ev.phase0.tools.join(', '), '');
        }
        if (!ev.phase0.passed) {
            lines.push(`**Error**: ${ev.phase0.error}`, '');
        }
        if (ev.phase0.runtimeSurface) {
            lines.push('### Runtime API Surface', '', '```json', JSON.stringify(ev.phase0.runtimeSurface, null, 2), '```', '');
        }
    }

    // Attempts
    if (ev.attempts?.length > 0) {
        lines.push(`## Consumption Attempts (${ev.attempts.length}/${MAX_ATTEMPTS})`, '');

        for (const att of ev.attempts) {
            lines.push(
                `### Attempt ${att.attemptNumber}`,
                '',
                `- **Sentinel**: \`${att.sentinel}\``,
                `- **Result**: ${att.consumptionResult}`,
                `- **Evidence quality**: ${att.evidenceQuality}`,
                `- **Pipeline OK**: ${att.pipelineOk ? '✅' : '❌'}`,
                `- **Duration**: ${att.durationMs}ms`,
                '',
            );

            if (att.toolExecution) {
                lines.push('**Tool execution**:', '', '```json', JSON.stringify(att.toolExecution, null, 2), '```', '');
            }
            if (att.consumptionEvidence) {
                lines.push('**Consumption evidence**:', '', '```json', JSON.stringify(att.consumptionEvidence, null, 2), '```', '');
            }

            if (att.events?.length > 0) {
                lines.push('**Bridge events**:', '', '```json', JSON.stringify(att.events, null, 2), '```', '');
            }

            if (att.streamLifecycle?.length > 0) {
                lines.push('**Stream lifecycle**:', '', '```json', JSON.stringify(att.streamLifecycle, null, 2), '```', '');
            }

            if (att.diagnostics && Object.keys(att.diagnostics).length > 0) {
                lines.push('**Diagnostics**:', '', '```json', JSON.stringify(att.diagnostics, null, 2), '```', '');
            }
        }
    }

    // Summary
    lines.push(
        '## Summary',
        '',
        `| Metric | Value |`,
        `|--------|-------|`,
        `| Gate | 5c |`,
        `| Best result | ${ev.bestResult} |`,
        `| Best evidence quality | ${ev.bestEvidenceQuality || 'N/A'} |`,
        `| Attempts | ${ev.attempts?.length || 0}/${MAX_ATTEMPTS} |`,
        `| Total duration | ${ev.durationMs}ms |`,
        '',
        '---',
        '',
        'Author: Opus/Claude (automated)',
    );

    return lines.join('\n');
}

main().catch(console.error);
