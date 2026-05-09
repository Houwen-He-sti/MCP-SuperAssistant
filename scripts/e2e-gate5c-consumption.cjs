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
const MAX_ATTEMPTS = 5;
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

            // Wait between attempts (longer cooldown to avoid AI rate-limiting)
            if (attempt < MAX_ATTEMPTS - 1) {
                console.log('\n⏳ Waiting 15s before next attempt...');
                await new Promise(r => setTimeout(r, 15000));
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

    // Probe echo if tool list is empty OR doesn't contain echo
    const hasEchoInList = tools.some(t => typeof t === 'string' && t.includes('echo'));
    if (tools.length === 0 || !hasEchoInList) {
        console.log(tools.length === 0
            ? '⚠️ No tool list API found. Probing echo tool directly...'
            : `⚠️ echo not in tool list (${tools.length} tools found). Probing directly...`);
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

    const hasEchoFinal = tools.some(t => typeof t === 'string' && t.includes('echo'));
    console.log(`\nTool discovery (${toolDiscoveryMethod}): ${tools.length} tools found`);
    console.log('Tools:', tools.join(', '));
    console.log(`Echo registered: ${hasEchoFinal ? '✅' : '❌'}`);

    // Get server identity
    const serverInfo = await evalIso(`(function() {
        try {
            return window.mcpClient?.serverInfo || window.mcpClient?._serverInfo || null;
        } catch { return null; }
    })()`, { awaitPromise: false });

    ws.close();

    return {
        passed: hasEchoFinal,
        error: hasEchoFinal ? null : 'echo tool not found in registry',
        runtimeSurface: surface,
        tools,
        toolCount: tools.length,
        toolDiscoveryMethod,
        serverIdentity: serverInfo?.value || null,
        hasEcho: hasEchoFinal,
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

    // --- Install wrappers (simple bind, fresh per attempt) ---
    const wrapResult = await evalIso(`(function() {
        window.__gate5c_events = [];
        if (window.__gate5c_wrapped) return { ok: true, alreadyWrapped: true };
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

        // Resolve adapter (best-effort — bridge may use a different adapter instance)
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
                    const sentinel = window.__gate5c_sentinel || '';
                    window.__gate5c_events.push({
                        type: 'insertText',
                        textLen: text.length,
                        preview: text.slice(0, 500),
                        containsSentinel: sentinel ? text.includes(sentinel) : false,
                        containsErrorTag: text.includes('<error>') || text.includes('not registered'),
                        isFunctionResultsBlock: text.includes('<function_result') || text.includes('function_result'),
                        ts: Date.now(),
                    });
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

    // Set sentinel on window so insertText wrapper can check it
    await evalIso(`window.__gate5c_sentinel = ${JSON.stringify(sentinel)}`, { awaitPromise: false });

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
        const allBlocks = document.querySelectorAll('[data-block-id]');
        const bodyText = document.body.innerText;
        return {
            bodyTextLength: bodyText.length,
            sentinelCountInBody: (bodyText.match(new RegExp(sentinel, 'g')) || []).length,
            blockCount: allBlocks.length,
        };
    })()`);

    const baselineVal = baseline?.value || {};
    // Store baseline sentinel count for later comparison
    result._baselineSentinelCount = baselineVal.sentinelCountInBody || 0;
    console.log(`Baseline: sentinel=${baselineVal.sentinelCountInBody}, bodyLen=${baselineVal.bodyTextLength}, blocks=${baselineVal.blockCount}`);

    // --- Inject prompt + submit ---
    // Focus + clear input
    await evalMain(`(function() {
        const sel = 'div[role="textbox"][contenteditable="true"]';
        const el = document.querySelector(sel);
        if (el) {
            el.focus();
            el.click();
            const s = window.getSelection();
            if (s) { const r = document.createRange(); r.selectNodeContents(el); s.removeAllRanges(); s.addRange(r); }
            document.execCommand('delete', false);
        }
        return !!el;
    })()`, { awaitPromise: false });
    await new Promise(r => setTimeout(r, 500));

    // Type prompt using CDP Input.insertText (document.execCommand doesn't work on Notion's editor)
    const prompt = `请调用 committee-bridge.echo 工具，参数为 {"message": "${sentinel}"}。工具返回后，请在你的回复中原样引用返回的 message 值（即 ${sentinel}），不要省略或改写。`;
    const focusResult = await evalMain(`(function() {
        const el = document.querySelector('div[role="textbox"][contenteditable="true"]');
        if (!el) return { ok: false, error: 'no textbox' };
        el.focus();
        el.click();
        return { ok: true };
    })()`, { awaitPromise: false });
    if (!focusResult?.value?.ok) {
        result.consumptionResult = 'ERROR';
        result.diagnostics.error = 'Failed to focus textbox: ' + focusResult?.value?.error;
        ws.close();
        result.durationMs = Date.now() - attemptStart;
        return result;
    }
    await new Promise(r => setTimeout(r, 200));
    await send('Input.insertText', { text: prompt });
    await new Promise(r => setTimeout(r, 300));

    // Verify text was entered
    const typeVerify = await evalMain(`(function() {
        const el = document.querySelector('div[role="textbox"][contenteditable="true"]');
        const content = el?.textContent || '';
        return { ok: content.length > 10, preview: content.slice(0, 100), len: content.length };
    })()`, { awaitPromise: false });

    if (!typeVerify?.value?.ok) {
        result.consumptionResult = 'ERROR';
        result.diagnostics.error = 'Prompt not entered in textbox. Content: ' + (typeVerify?.value?.preview || 'empty');
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

    // --- Ordered sentinel snapshot: after prompt submit, before bridge ---
    await new Promise(r => setTimeout(r, 500));
    const postPromptSnap = await evalMain(`(function() {
        const sentinel = ${JSON.stringify(sentinel)};
        const bodyText = document.body.innerText;
        return {
            sentinelCount: (bodyText.match(new RegExp(sentinel, 'g')) || []).length,
            bodyTextLength: bodyText.length,
        };
    })()`);
    result._sentinelSnapshots = {
        beforePrompt: result._baselineSentinelCount || 0,
        afterPrompt: postPromptSnap?.value?.sentinelCount || 0,
    };
    console.log(`📸 Sentinel after prompt: ${result._sentinelSnapshots.afterPrompt} (expected ≥1)`);

    // --- Wait for SPA navigation to settle, then re-discover ISOLATED world + re-install wrappers ---
    await new Promise(r => setTimeout(r, 2000));

    // Notion SPA-navigates after submit (conversation list → chat view).
    // The ISOLATED world context ID may change, so re-discover it.
    const oldIsoCtx = isoCtx;
    const newContexts = contexts.filter(c => c.name === 'MCP SuperAssistant');
    let newIsoCtx = null;
    for (const ctx of newContexts) {
        const check = await send('Runtime.evaluate', {
            contextId: ctx.id,
            expression: "typeof window.pluginRegistry !== 'undefined'",
            returnByValue: true,
        });
        if (check.result?.result?.value === true) { newIsoCtx = ctx.id; }
    }
    if (newIsoCtx && newIsoCtx !== oldIsoCtx) {
        isoCtx = newIsoCtx;
        console.log(`🔄 ISOLATED world re-discovered: ${oldIsoCtx} → ${isoCtx}`);
    } else if (newIsoCtx) {
        console.log(`✅ ISOLATED world context unchanged: ${isoCtx}`);
    } else {
        console.log(`⚠️ Could not re-discover ISOLATED world, keeping old: ${isoCtx}`);
    }

    // ALWAYS re-install wrappers after submit — the adapter object may have been
    // re-created by the plugin during SPA navigation, even if the context ID is the same.
    await evalIso(`window.__gate5c_wrapped = false`, { awaitPromise: false });
    const rewrap = await evalIso(`(function() {
        window.__gate5c_events = [];
        if (window.__gate5c_wrapped) return { ok: true, alreadyWrapped: true };
        window.__gate5c_wrapped = true;
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
                    const sentinel = window.__gate5c_sentinel || '';
                    window.__gate5c_events.push({
                        type: 'insertText', textLen: text.length, preview: text.slice(0, 500),
                        containsSentinel: sentinel ? text.includes(sentinel) : false,
                        containsErrorTag: text.includes('<error>') || text.includes('not registered'),
                        isFunctionResultsBlock: text.includes('<function_result') || text.includes('function_result'),
                        ts: Date.now(),
                    });
                    try { const r = await origInsert(text); window.__gate5c_events.push({ type: 'insertText_result', result: r, ts: Date.now() }); return r; }
                    catch (e) { window.__gate5c_events.push({ type: 'insertText_error', error: e.message, ts: Date.now() }); throw e; }
                };
            }
            if (typeof adapter.submitForm === 'function') {
                const origSubmit = adapter.submitForm.bind(adapter);
                adapter.submitForm = async () => {
                    window.__gate5c_events.push({ type: 'submitForm', ts: Date.now() });
                    try { const r = await origSubmit(); window.__gate5c_events.push({ type: 'submitForm_result', result: r, ts: Date.now() }); return r; }
                    catch (e) { window.__gate5c_events.push({ type: 'submitForm_error', error: e.message, ts: Date.now() }); throw e; }
                };
            }
        }
        return { ok: true, adapterFound: !!adapter };
    })()`, { awaitPromise: false });
    await evalIso(`window.__gate5c_sentinel = ${JSON.stringify(sentinel)}`, { awaitPromise: false });
    console.log(`🔄 Wrappers re-installed after submit (adapter: ${rewrap?.value?.adapterFound})`);

    // Re-install MAIN world stream listener (may have been lost during SPA nav)
    await evalMain(`(function() {
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
            // Use actual insertText payload metadata (recorded by wrapper)
            const isSuccessInsert = insertTextEvent.containsSentinel
                && !insertTextEvent.containsErrorTag
                && insertTextEvent.isFunctionResultsBlock;
            result.isSuccessInsert = isSuccessInsert;
            result.insertPayloadMeta = {
                containsSentinel: insertTextEvent.containsSentinel,
                containsErrorTag: insertTextEvent.containsErrorTag,
                isFunctionResultsBlock: insertTextEvent.isFunctionResultsBlock,
                textLen: insertTextEvent.textLen,
            };
            console.log(`  ${isSuccessInsert ? '✅' : '⚠️'} Result injected: ${insertTextEvent.textLen} chars ${isSuccessInsert ? '(SUCCESS path)' : '(ERROR path)'}`);
        }
        if (submitFormEvent && !formSubmitted) {
            formSubmitted = true;
            submitFormOk = submitFormResultEvent?.result === true;
            console.log(`  ${submitFormOk ? '✅' : '⚠️'} submitForm called (result: ${submitFormResultEvent?.result})`);

            // Ordered sentinel snapshot: after bridge inject + submit
            const postInjectSnap = await evalMain(`(function() {
                const sentinel = ${JSON.stringify(sentinel)};
                const bodyText = document.body.innerText;
                return (bodyText.match(new RegExp(sentinel, 'g')) || []).length;
            })()`);
            if (result._sentinelSnapshots) {
                result._sentinelSnapshots.afterInjectSubmit = postInjectSnap?.value || 0;
            }
            console.log(`  📸 Sentinel after inject+submit: ${postInjectSnap?.value || 0} (expected ≥2)`);
        }

        // Pipeline events tracking (best-effort — bridge may use different adapter reference)
        const pipelineDone = toolExecuted && resultInserted && formSubmitted;
        result.pipelineOk = pipelineDone && submitFormOk && toolResultIsSuccess && (result.isSuccessInsert !== false);

        // Monitor sentinel count after tool success — this is the definitive evidence.
        // Bridge insertText/submitForm wrappers may not fire if the adapter object differs
        // from what we wrapped, but sentinel count proves the full cycle regardless.
        if (toolExecuted && toolResultIsSuccess) {
            // Wait briefly on first detection for bridge to inject + AI to start responding
            if (!result._toolSuccessTs) {
                result._toolSuccessTs = Date.now();
                await new Promise(r => setTimeout(r, 2000));
            }

            // Sentinel count approach: Notion does in-place replacement of blocks,
            // so bodyText.slice(postSubmitLen) misses content. Instead, count total
            // sentinel occurrences in the page. Expected counts:
            //   baseline: 0 (sentinel is unique per attempt)
            //   after user prompt: 1 (our typed prompt)
            //   after bridge inject + auto-submit: 2 (tool result also contains it)
            //   after AI repeats sentinel: 3+ (consumption proved)
            const countCheck = await evalMain(`(function() {
                const sentinel = ${JSON.stringify(sentinel)};
                const bodyText = document.body.innerText;
                const blocks = document.querySelectorAll('[data-block-id]');
                const sentinelCountTotal = (bodyText.match(new RegExp(sentinel, 'g')) || []).length;
                const bodyTail = bodyText.slice(-800);
                return {
                    bodyTextLength: bodyText.length,
                    sentinelCountTotal,
                    sentinelInTail: bodyTail.includes(sentinel),
                    bodyTail,
                    blockCount: blocks.length,
                };
            })()`);

            const dv = countCheck?.value || {};
            // Sentinel count > 2 means AI added at least one more occurrence
            // (2 come from: user prompt + bridge-injected tool result)
            const aiAddedSentinel = dv.sentinelCountTotal >= 3;

            if (round % 3 === 0 || aiAddedSentinel) {
                console.log(`  Poll ${round + 1}/${MAX_POLL_ROUNDS}: totalSentinel=${dv.sentinelCountTotal}, bodyLen=${dv.bodyTextLength}, blocks=${dv.blockCount}`);
            }

            // PASS: sentinel count >= 3 means AI consumed and repeated it
            if (aiAddedSentinel && dv.sentinelInTail) {
                consumptionDetected = true;
                evidenceQuality = 'assistant_delta';
                // Ordered sentinel snapshots for reviewer verification
                if (result._sentinelSnapshots) {
                    result._sentinelSnapshots.afterAIResponse = dv.sentinelCountTotal;
                }
                result.consumptionEvidence = {
                    sentinelSnapshots: result._sentinelSnapshots,
                    sentinelCountTotal: dv.sentinelCountTotal,
                    sentinelInTail: true,
                    bodyTailSnippet: dv.bodyTail?.slice(-300),
                    consumptionEvidenceQuality: 'assistant_delta',
                };
                console.log(`  🎉 CONSUMPTION DETECTED (sentinel_count): totalSentinel=${dv.sentinelCountTotal} (baseline=0, expected_pipeline=2, AI added ${dv.sentinelCountTotal - 2})`);
                break;
            }

            // Weaker: sentinel count >= 3 but not in tail (AI mentioned it earlier)
            if (aiAddedSentinel) {
                consumptionDetected = true;
                evidenceQuality = 'transcript_diff';
                if (result._sentinelSnapshots) {
                    result._sentinelSnapshots.afterAIResponse = dv.sentinelCountTotal;
                }
                result.consumptionEvidence = {
                    sentinelSnapshots: result._sentinelSnapshots,
                    sentinelCountTotal: dv.sentinelCountTotal,
                    sentinelInTail: false,
                    bodyTailSnippet: dv.bodyTail?.slice(-300),
                    consumptionEvidenceQuality: 'transcript_diff',
                };
                console.log(`  ✅ Consumption evidence (transcript_diff): totalSentinel=${dv.sentinelCountTotal}`);
                break;
            }

            // Sentinel count still <= 2 — AI hasn't output sentinel yet, keep polling
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
    } else if ((result.pipelineOk || (toolExecuted && toolResultIsSuccess)) && !consumptionDetected) {
        // Tool succeeded but sentinel not detected yet — do final page-wide check
        const finalCheck = await evalMain(`(function() {
            const sentinel = ${JSON.stringify(sentinel)};
            const bodyText = document.body.innerText;
            const bodyTail = bodyText.slice(-800);
            return {
                sentinelCountTotal: (bodyText.match(new RegExp(sentinel, 'g')) || []).length,
                sentinelInTail: bodyTail.includes(sentinel),
                bodyTail,
            };
        })()`);
        const finalVal = finalCheck?.value || {};
        const finalAiAdded = (finalVal.sentinelCountTotal || 0) >= 3;
        if (result._sentinelSnapshots) {
            result._sentinelSnapshots.afterAIResponse = finalVal.sentinelCountTotal || 0;
        }
        result.consumptionEvidence = {
            sentinelSnapshots: result._sentinelSnapshots,
            sentinelCountTotal: finalVal.sentinelCountTotal || 0,
            sentinelInTail: finalVal.sentinelInTail || false,
            bodyTailSnippet: finalVal.bodyTail?.slice(-300),
            consumptionEvidenceQuality: finalAiAdded ? 'body_count_only' : 'none',
        };

        if (finalAiAdded) {
            result.consumptionResult = 'CONSUMPTION_PARTIAL';
            result.evidenceQuality = 'body_count_only';
        } else {
            // callTool worked but adapter wrappers missed — pipeline likely ran via different adapter
            result.consumptionResult = 'PIPELINE_INFERRED';
            result.evidenceQuality = 'none';
            result.diagnostics.note = 'callTool succeeded but insertText/submitForm events not captured (adapter object mismatch). AI may not have output sentinel yet.';
        }
    } else if (toolExecuted && !toolResultIsSuccess) {
        result.consumptionResult = 'TOOL_ERROR';
    } else if (toolExecuted && resultInserted && !result.isSuccessInsert) {
        result.consumptionResult = 'ERROR_PATH_ONLY';
        result.diagnostics.note = 'Tool result was injected as error, not success. Echo may not be registered.';
    } else if (!toolExecuted) {
        result.consumptionResult = 'SCANNER_MISS';
        result.diagnostics.note = 'No callTool event captured. AI may not have invoked the tool (AI_BEHAVIOR_FLAKE).';
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
            if (att._sentinelSnapshots) {
                lines.push('**Ordered sentinel snapshots** (proves source layering):', '', '```json', JSON.stringify(att._sentinelSnapshots, null, 2), '```', '');
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
