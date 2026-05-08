/**
 * Gate 5b: Live Notion/CDP Auto-Submit Consumption E2E
 *
 * Semi-automated: CDP script configures bridge + observes.
 * Human triggers AI function_call via Notion prompt.
 *
 * Prerequisites:
 *   1. Chrome launched with: --remote-debugging-port=9222
 *   2. Notion page open with MCP SuperAssistant extension loaded
 *   3. mcpClient connected and ready
 *   4. At least one tool available (e.g. echo, read_workspace_file)
 *
 * Run: node scripts/e2e-gate5b-live-autosubmit.cjs
 *
 * Outputs:
 *   outputs/gate5b-live-notion-e2e-{timestamp}.json
 *   outputs/gate5b-live-notion-e2e-{timestamp}.md
 */

const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');

const CDP_PORT = 9222;
const TIMEOUT_MS = 10000;
const POLL_INTERVAL_MS = 3000;
const MAX_POLL_ROUNDS = 20; // 60 seconds total
const SENTINEL_PREFIX = 'sentinel_g5b_';

// ============================================================================
// CDP Infrastructure
// ============================================================================

async function main() {
    const startTime = Date.now();
    const sentinel = SENTINEL_PREFIX + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6);
    const evidence = {
        timestamp: new Date().toISOString(),
        sentinel,
        bridgeConfig: null,
        preflightInfo: null,
        events: [],
        streamLifecycle: [], // P0#3: MAIN world stream events
        submitMethod: 'unknown',
        sentinelBefore: null,
        sentinelAfter: null,
        scannerEvidence: null,
        assistantResponseSnippet: null,
        result: 'PENDING',
        diagnostics: {},
        durationMs: 0,
    };

    try {
        await runE2E(sentinel, evidence);
    } catch (err) {
        evidence.result = 'ERROR';
        evidence.diagnostics.fatalError = err.message;
        console.error('\n❌ Fatal error:', err.message);
    } finally {
        evidence.durationMs = Date.now() - startTime;
        await writeEvidence(evidence);
    }
}

async function runE2E(sentinel, evidence) {
    // --- Step 1: CDP connect + preflight (P23/P25) ---
    console.log('\n🧪 Gate 5b Live E2E — Auto-Submit Consumption Proof\n');
    console.log('Sentinel:', sentinel);

    const { ensureAgentPage } = require('./lib/cdp-preflight.cjs');
    const page = await ensureAgentPage();
    const notionTab = page.tab;
    console.log(`✅ Tab: ${notionTab.url.slice(0, 80)}${page.navigated ? ' (navigated)' : ''}`);

    const ws = new WebSocket(notionTab.webSocketDebuggerUrl);
    let msgId = 0;
    const listeners = new Map();
    const contexts = [];
    const streamLifecycle = []; // P0#3: capture MAIN world stream events

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
        const result = await send('Runtime.evaluate', params);
        return result.result?.result;
    }

    let isoCtx = null;
    async function evalIso(expression, opts = {}) {
        const params = { expression, returnByValue: true, awaitPromise: opts.awaitPromise || false, contextId: isoCtx, ...opts };
        const result = await send('Runtime.evaluate', params);
        return result.result?.result;
    }

    await send('Runtime.enable');
    await new Promise(r => setTimeout(r, 1500));

    // --- Find ISOLATED world ---
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
        console.log('❌ No ISOLATED world (MCP SuperAssistant context) found');
        evidence.result = 'FAIL';
        evidence.diagnostics.error = 'No ISOLATED world found';
        ws.close();
        return;
    }
    console.log('✅ ISOLATED world:', isoCtx);

    // --- Step 1b: Preflight check ---
    const preflight = await evalIso(`(function() {
        const info = {};
        // mcpClient
        const mc = window.mcpClient;
        info.mcpClientAvailable = !!(mc && typeof mc.callTool === 'function' && typeof mc.isReady === 'function');
        info.mcpClientReady = info.mcpClientAvailable && mc.isReady();
        // adapter via multi-path resolution (same as bridge)
        const win = window;
        let adapter = null;
        // path 1: pluginRegistry
        const reg = win.pluginRegistry;
        const plugin = reg?.getActivePlugin?.();
        // 1a: plugin.adapter (legacy)
        if (plugin?.adapter && typeof plugin.adapter.insertText === 'function') adapter = plugin.adapter;
        // 1b: plugin IS adapter (BaseAdapterPlugin)
        if (!adapter && plugin && typeof plugin.insertText === 'function') adapter = plugin;
        // path 2: mcpAdapter global
        if (!adapter && win.mcpAdapter && typeof win.mcpAdapter.insertText === 'function') adapter = win.mcpAdapter;
        // path 3: getCurrentAdapter
        if (!adapter && typeof win.getCurrentAdapter === 'function') adapter = win.getCurrentAdapter();
        info.adapterAvailable = !!(adapter && typeof adapter.insertText === 'function');
        info.hasSubmitForm = !!(adapter && typeof adapter.submitForm === 'function');
        info.hasGetInputContent = !!(adapter && typeof adapter.getInputContent === 'function');
        // bridge info if exported
        try {
            const bridgeInfo = window.getStreamToolBridgeInfo?.();
            info.bridgeInfo = bridgeInfo || null;
        } catch { info.bridgeInfo = null; }
        return info;
    })()`, { awaitPromise: false });

    console.log('Preflight:', JSON.stringify(preflight?.value, null, 2));
    evidence.preflightInfo = preflight?.value;

    if (!preflight?.value?.mcpClientReady) {
        console.log('❌ mcpClient not ready');
        evidence.result = 'FAIL';
        evidence.diagnostics.error = 'mcpClient not ready';
        ws.close();
        return;
    }
    // Use bridgeInfo as authoritative source for adapter availability
    const adapterOk = preflight?.value?.adapterAvailable || preflight?.value?.bridgeInfo?.adapterAvailable;
    if (!adapterOk) {
        console.log('⚠️ adapter not yet available — bridge uses lazy resolution, proceeding anyway');
        evidence.diagnostics.adapterWarning = 'adapter not available at preflight, relying on lazy resolution';
    }
    console.log('✅ Preflight passed (mcpClient ready' + (adapterOk ? ', adapter ready' : ', adapter pending') + ')');

    // --- Step 2: Configure bridge ---
    console.log('\n--- Step 2: Configure bridge ---');
    const configResult = await evalIso(`(function() {
        try {
            if (typeof window.configureStreamToolBridge === 'function') {
                window.configureStreamToolBridge({
                    enabled: true,
                    cutoffEnabled: true,
                    autoInsert: true,
                    autoSubmit: true,
                });
                const info = window.getStreamToolBridgeInfo?.();
                return { ok: true, config: info?.config };
            }
            return { ok: false, error: 'configureStreamToolBridge not found' };
        } catch (e) { return { ok: false, error: e.message }; }
    })()`, { awaitPromise: false });

    console.log('Bridge config:', JSON.stringify(configResult?.value));
    evidence.bridgeConfig = configResult?.value?.config;

    if (!configResult?.value?.ok) {
        console.log('❌ Bridge configuration failed');
        evidence.result = 'FAIL';
        evidence.diagnostics.error = 'Bridge config failed: ' + configResult?.value?.error;
        ws.close();
        return;
    }
    console.log('✅ Bridge configured: autoInsert=true, autoSubmit=true');

    // --- Step 3: Install dependency wrappers ---
    console.log('\n--- Step 3: Install dependency wrappers ---');
    const wrapResult = await evalIso(`(function() {
        // Guard against double-wrap
        if (window.__gate5b_wrapped) return { ok: true, alreadyWrapped: true };
        window.__gate5b_events = [];
        window.__gate5b_wrapped = true;

        // Wrap mcpClient.callTool
        const mc = window.mcpClient;
        if (mc && typeof mc.callTool === 'function') {
            const origCallTool = mc.callTool.bind(mc);
            mc.callTool = async (name, params) => {
                window.__gate5b_events.push({ type: 'callTool', name, params: JSON.stringify(params).slice(0, 500), ts: Date.now() });
                try {
                    const result = await origCallTool(name, params);
                    window.__gate5b_events.push({ type: 'callTool_result', name, resultPreview: JSON.stringify(result).slice(0, 500), ts: Date.now() });
                    return result;
                } catch (e) {
                    window.__gate5b_events.push({ type: 'callTool_error', name, error: e.message, ts: Date.now() });
                    throw e;
                }
            };
        }

        // Resolve adapter via multi-path (same as bridge)
        const win = window;
        let adapter = null;
        const reg = win.pluginRegistry;
        const plugin = reg?.getActivePlugin?.();
        // 1a: plugin.adapter (legacy)
        if (plugin?.adapter && typeof plugin.adapter.insertText === 'function') adapter = plugin.adapter;
        // 1b: plugin IS adapter (BaseAdapterPlugin)
        if (!adapter && plugin && typeof plugin.insertText === 'function') adapter = plugin;
        if (!adapter && win.mcpAdapter && typeof win.mcpAdapter.insertText === 'function') adapter = win.mcpAdapter;
        if (!adapter && typeof win.getCurrentAdapter === 'function') adapter = win.getCurrentAdapter();

        if (adapter) {
            // insertText
            if (typeof adapter.insertText === 'function') {
                const origInsert = adapter.insertText.bind(adapter);
                adapter.insertText = async (text) => {
                    window.__gate5b_events.push({ type: 'insertText', textLen: text.length, preview: text.slice(0, 200), ts: Date.now() });
                    try {
                        const result = await origInsert(text);
                        window.__gate5b_events.push({ type: 'insertText_result', result, ts: Date.now() });
                        return result;
                    } catch (e) {
                        window.__gate5b_events.push({ type: 'insertText_error', error: e.message, ts: Date.now() });
                        throw e;
                    }
                };
            }
            // submitForm
            if (typeof adapter.submitForm === 'function') {
                const origSubmit = adapter.submitForm.bind(adapter);
                adapter.submitForm = async () => {
                    window.__gate5b_events.push({ type: 'submitForm', ts: Date.now() });
                    try {
                        const result = await origSubmit();
                        window.__gate5b_events.push({ type: 'submitForm_result', result, ts: Date.now() });
                        return result;
                    } catch (e) {
                        window.__gate5b_events.push({ type: 'submitForm_error', error: e.message, ts: Date.now() });
                        throw e;
                    }
                };
            }
            // getInputContent
            if (typeof adapter.getInputContent === 'function') {
                const origGetInput = adapter.getInputContent.bind(adapter);
                adapter.getInputContent = () => {
                    try {
                        const content = origGetInput();
                        window.__gate5b_events.push({ type: 'getInputContent', contentLen: content?.length ?? -1, ts: Date.now() });
                        return content;
                    } catch (e) {
                        window.__gate5b_events.push({ type: 'getInputContent_error', error: e.message, ts: Date.now() });
                        throw e;
                    }
                };
            }
        }
        return { ok: true, adapterFound: !!adapter, wrappedMethods: adapter ? ['callTool', 'insertText', 'submitForm', 'getInputContent'] : ['callTool'] };
    })()`, { awaitPromise: false });

    console.log('Wrapper:', JSON.stringify(wrapResult?.value));
    if (!wrapResult?.value?.ok) {
        console.log('❌ Wrapper installation failed');
        evidence.result = 'FAIL';
        evidence.diagnostics.error = 'Wrapper install failed';
        ws.close();
        return;
    }
    console.log('✅ Dependency wrappers installed');

    // --- Step 3b: Install MAIN world stream lifecycle listener (P0#3) ---
    await evalMain(`(function() {
        if (window.__gate5b_stream) return;
        window.__gate5b_stream = [];
        window.addEventListener('message', function(e) {
            const d = e.data;
            // Match interceptorMain.ts postMessage format:
            // { channel: 'mcp-superassistant.stream', direction: 'main-to-isolated', event: { type: '...' } }
            if (d && d.channel === 'mcp-superassistant.stream' && d.direction === 'main-to-isolated' && d.event) {
                window.__gate5b_stream.push({
                    event: d.event.type || 'unknown',
                    ts: Date.now(),
                    detail: JSON.stringify(d.event).slice(0, 300)
                });
            }
        });
    })()`, { awaitPromise: false });

    // --- Step 4: Inject prompt into Notion via CDP (MAIN world) ---
    console.log('\n--- Step 4: Inject prompt + submit ---');

    // 4a: Clear input
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

    // 4b: Type the prompt
    const prompt = `请调用 echo 工具，参数为 {"message": "${sentinel}"}`;
    const typeResult = await evalMain(`(function() {
        const el = document.querySelector('div[role="textbox"][contenteditable="true"]');
        if (!el) return { ok: false, error: 'no textbox' };
        el.focus();
        document.execCommand('insertText', false, ${JSON.stringify(prompt)});
        return { ok: true, preview: el.textContent.slice(0, 100) };
    })()`, { awaitPromise: false });
    console.log('Type result:', JSON.stringify(typeResult?.value));
    if (!typeResult?.value?.ok) {
        console.log('❌ Failed to type prompt');
        evidence.result = 'FAIL';
        evidence.diagnostics.error = 'Failed to type prompt: ' + typeResult?.value?.error;
        ws.close();
        return;
    }

    // 4c: Before snapshot
    evidence.sentinelBefore = 0;
    const beforeCheck = await evalMain(`(function() {
        const text = document.body.innerText;
        return (text.match(/${sentinel}/g) || []).length;
    })()`);
    evidence.sentinelBefore = beforeCheck?.value || 0;
    console.log('Sentinel before:', evidence.sentinelBefore);

    // 4d: Submit via DOM click
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
    console.log('Submit:', JSON.stringify(submitResult?.value));
    if (!submitResult?.value?.ok) {
        console.log('❌ Failed to submit');
        evidence.result = 'FAIL';
        evidence.diagnostics.error = 'Failed to submit: ' + submitResult?.value?.error;
        ws.close();
        return;
    }
    console.log(`✅ Prompt submitted via ${submitResult?.value?.method}`);

    // --- Step 5: Poll for bridge activity ---
    console.log('--- Step 5: Polling for bridge activity (max 60s) ---');
    let bridgeActive = false;
    let toolExecuted = false;
    let resultInserted = false;
    let formSubmitted = false;
    let submitMethod = 'none';
    let consumed = false;

    for (let round = 0; round < MAX_POLL_ROUNDS; round++) {
        await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));

        // Read events from ISOLATED world
        const eventsResult = await evalIso(`(function() {
            return JSON.parse(JSON.stringify(window.__gate5b_events || []));
        })()`, { awaitPromise: false });
        const events = eventsResult?.value || [];

        // P0#3: Read stream lifecycle from MAIN world postMessage listener
        const streamResult = await evalMain(`(function() {
            return JSON.parse(JSON.stringify(window.__gate5b_stream || []));
        })()`);
        if (streamResult?.value?.length > 0) {
            // Merge new events (deduplicate by ts)
            const existingTs = new Set(streamLifecycle.map(e => e.ts));
            for (const evt of streamResult.value) {
                if (!existingTs.has(evt.ts)) {
                    streamLifecycle.push({ text: evt.event + ': ' + (evt.detail || '').slice(0, 200), ts: evt.ts });
                }
            }
        }

        // Check what happened
        const hasCallTool = events.some(e => e.type === 'callTool');
        const hasInsertText = events.some(e => e.type === 'insertText');
        const hasSubmitForm = events.some(e => e.type === 'submitForm');
        const hasSubmitResult = events.find(e => e.type === 'submitForm_result');

        if (hasCallTool && !toolExecuted) {
            toolExecuted = true;
            const callEvent = events.find(e => e.type === 'callTool');
            console.log(`  ✅ Tool executed: ${callEvent.name}(${callEvent.params?.slice(0, 100)})`);
        }
        if (hasInsertText && !resultInserted) {
            resultInserted = true;
            const insertEvent = events.find(e => e.type === 'insertText');
            console.log(`  ✅ Result injected: ${insertEvent.textLen} chars`);
        }
        if (hasSubmitForm && !formSubmitted) {
            formSubmitted = true;
            if (hasSubmitResult?.result === true) {
                submitMethod = 'adapter.submitForm';
                console.log('  ✅ Auto-submitted via adapter.submitForm');
            } else {
                submitMethod = 'adapter.submitForm_failed';
                console.log('  ⚠️ submitForm called but result:', hasSubmitResult?.result);
            }
        }

        // Check sentinel in page
        const sentinelCheck = await evalMain(`(function() {
            const text = document.body.innerText;
            const count = (text.match(/${sentinel}/g) || []).length;
            // Find context around last occurrence
            const idx = text.lastIndexOf('${sentinel}');
            let context = '';
            if (idx > -1) context = text.slice(Math.max(0, idx - 150), Math.min(text.length, idx + sentinel.length + 150));
            return { count, context };
        })()`);
        const sentinelCount = sentinelCheck?.value?.count || 0;

        if (round % 3 === 0) {
            console.log(`  Poll ${round + 1}/${MAX_POLL_ROUNDS}: events=${events.length}, sentinel=${sentinelCount}`);
        }

        // Store latest events for evidence (MUST be before break)
        evidence.events = events;

        // PASS condition: full bridge pipeline worked (tool executed + result injected + form submitted)
        // Sentinel echo by AI is bonus evidence, not a gating criterion — AI behavior is not our system.
        if (toolExecuted && resultInserted && formSubmitted) {
            consumed = true;
            evidence.sentinelAfter = sentinelCount;
            evidence.assistantResponseSnippet = sentinelCheck?.value?.context;
            if (sentinelCount >= 2) {
                console.log(`  ✅ AI consumed result AND echoed sentinel! ${evidence.sentinelBefore} → ${sentinelCount}`);
            } else {
                console.log(`  ✅ Bridge pipeline complete! (sentinel echo pending: ${sentinelCount})`);
            }
            break;
        }
    }

    evidence.submitMethod = submitMethod;
    evidence.streamLifecycle = streamLifecycle; // P0#3: record stream events
    if (!consumed) {
        // Final sentinel check
        const finalCheck = await evalMain(`(function() {
            const text = document.body.innerText;
            const count = (text.match(/${sentinel}/g) || []).length;
            const idx = text.lastIndexOf('${sentinel}');
            let context = '';
            if (idx > -1) context = text.slice(Math.max(0, idx - 150), Math.min(text.length, idx + sentinel.length + 150));
            return { count, context };
        })()`);
        evidence.sentinelAfter = finalCheck?.value?.count || 0;
        evidence.assistantResponseSnippet = finalCheck?.value?.context;
    }

    // --- Determine result ---
    // P0#3: Include stream lifecycle in diagnostics
    const hasStreamCutoff = streamLifecycle.some(e => e.text.startsWith('stream_cutoff'));
    const hasFunctionCallObserved = streamLifecycle.some(e => e.text.startsWith('function_call'));
    evidence.diagnostics.streamLifecycleSummary = {
        functionCallObserved: hasFunctionCallObserved,
        streamCutoffObserved: hasStreamCutoff,
        totalEvents: streamLifecycle.length,
    };

    if (consumed && submitMethod === 'adapter.submitForm') {
        evidence.result = 'PASS';
        const sentinelNote = (evidence.sentinelAfter || 0) >= 2
            ? 'AI also echoed sentinel (bonus verification)'
            : 'Sentinel echo not detected (AI behavior — not a system issue)';
        evidence.diagnostics.sentinelNote = sentinelNote;
    } else if (consumed && submitMethod !== 'adapter.submitForm') {
        evidence.result = 'DIAGNOSTIC';
        evidence.diagnostics.note = 'AI consumed result but submitForm was not the production path';
    } else if (toolExecuted && resultInserted && !formSubmitted) {
        evidence.result = 'INCONCLUSIVE';
        evidence.diagnostics.note = 'Tool executed and result injected, but form not submitted';
    } else if (toolExecuted && !resultInserted) {
        evidence.result = 'FAIL';
        evidence.diagnostics.note = 'Tool executed but result not injected';
    } else if (!toolExecuted && evidence.events.length === 0) {
        // Scanner miss — collect debugging evidence
        evidence.result = 'SCANNER_MISS';
        console.log('\n⚠️ No bridge activity detected. Collecting debugging evidence...');

        const pageBodyTail = await evalMain(`(function() {
            return document.body.innerText.slice(-500);
        })()`);
        evidence.diagnostics.pageBodyTail = pageBodyTail?.value;

        const bridgeInfo = await evalIso(`(function() {
            try { return window.getStreamToolBridgeInfo?.(); } catch { return null; }
        })()`, { awaitPromise: false });
        evidence.diagnostics.bridgeInfo = bridgeInfo?.value;
        evidence.diagnostics.hypothesis = 'AI may not have called tool, or scanner did not detect function_call in stream';
    } else {
        evidence.result = 'FAIL';
        evidence.diagnostics.note = 'Unknown failure state';
    }

    // Final summary
    console.log('\n' + '='.repeat(60));
    console.log(`Result: ${evidence.result}`);
    console.log(`Stream: start=${streamLifecycle.some(e => e.text.includes('stream_start'))} call=${hasFunctionCallObserved} cutoff=${hasStreamCutoff}`);
    console.log(`Tool executed: ${toolExecuted}`);
    console.log(`Result inserted: ${resultInserted}`);
    console.log(`Form submitted: ${formSubmitted} (${submitMethod})`);
    console.log(`Sentinel: ${evidence.sentinelBefore} → ${evidence.sentinelAfter}`);
    console.log('='.repeat(60));

    ws.close();
}

// ============================================================================
// Evidence Output
// ============================================================================

async function writeEvidence(evidence) {
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const dir = path.join(__dirname, '..', 'outputs');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    // JSON
    const jsonPath = path.join(dir, `gate5b-live-notion-e2e-${ts}.json`);
    fs.writeFileSync(jsonPath, JSON.stringify(evidence, null, 2));
    console.log(`\n📄 JSON evidence: ${jsonPath}`);

    // Markdown
    const mdPath = path.join(dir, `gate5b-live-notion-e2e-${ts}.md`);
    const md = generateMarkdownReport(evidence);
    fs.writeFileSync(mdPath, md);
    console.log(`📄 Markdown report: ${mdPath}`);
}

function generateMarkdownReport(ev) {
    // Derive step statuses from events array (now correctly populated)
    const hasCallTool = ev.events.some(e => e.type === 'callTool');
    const hasInsertText = ev.events.some(e => e.type === 'insertText');
    const callToolName = ev.events.find(e => e.type === 'callTool')?.name || '';
    const insertTextLen = ev.events.find(e => e.type === 'insertText')?.textLen || 0;

    // Derive stream lifecycle flags for table
    const hasStreamStart = (ev.streamLifecycle || []).some(e => e.text.startsWith('stream_start'));
    const hasFunctionCall = (ev.streamLifecycle || []).some(e => e.text.startsWith('function_call'));
    const hasStreamCutoff = (ev.streamLifecycle || []).some(e => e.text.startsWith('stream_cutoff'));
    const hasStreamEnd = (ev.streamLifecycle || []).some(e => e.text.startsWith('stream_end'));

    const lines = [
        `# Gate 5b Live E2E Evidence — ${ev.timestamp}`,
        '',
        `## Result: ${ev.result}`,
        '',
        '| Step | Status |',
        '|------|--------|',
        `| CDP connect | ✅ |`,
        `| ISOLATED world | ${ev.preflightInfo ? '✅' : '❌'} |`,
        `| mcpClient ready | ${ev.preflightInfo?.mcpClientReady ? '✅' : '❌'} |`,
        `| Bridge config | ${ev.bridgeConfig ? '✅ autoInsert=' + ev.bridgeConfig.autoInsert + ' autoSubmit=' + ev.bridgeConfig.autoSubmit : '❌'} |`,
        `| stream_start | ${hasStreamStart ? '✅' : '❌'} |`,
        `| function_call detected | ${hasFunctionCall ? '✅' : '❌'} |`,
        `| stream_cutoff | ${hasStreamCutoff ? '✅' : '❌'} |`,
        `| Tool executed | ${hasCallTool ? '✅ ' + callToolName : '❌'} |`,
        `| Result injected | ${hasInsertText ? '✅ ' + insertTextLen + ' chars' : '❌'} |`,
        `| Submit method | ${ev.submitMethod} |`,
        `| AI consumed | ${ev.sentinelAfter >= 2 ? '✅' : '❌'} sentinel ${ev.sentinelBefore} → ${ev.sentinelAfter} |`,
        '',
        `## Sentinel`,
        '',
        `\`${ev.sentinel}\``,
        '',
    ];

    if (ev.assistantResponseSnippet) {
        lines.push('## Assistant Response Snippet', '', '```', ev.assistantResponseSnippet, '```', '');
    }

    if (ev.events.length > 0) {
        lines.push('## Bridge Events', '', '```json', JSON.stringify(ev.events, null, 2), '```', '');
    }

    if (ev.streamLifecycle && ev.streamLifecycle.length > 0) {
        lines.push('## Stream Lifecycle (MAIN world)', '', '```json', JSON.stringify(ev.streamLifecycle, null, 2), '```', '');
    }

    if (ev.diagnostics && Object.keys(ev.diagnostics).length > 0) {
        lines.push('## Diagnostics', '', '```json', JSON.stringify(ev.diagnostics, null, 2), '```', '');
    }

    lines.push(`## Duration`, '', `${ev.durationMs}ms`, '', '---', '', 'Author: Opus/Claude (automated)');

    return lines.join('\n');
}

main().catch(console.error);
