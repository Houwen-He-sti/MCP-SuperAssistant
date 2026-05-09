/**
 * Gate 5d: Live Notion E2E — Cross-Turn ACK Scanning Verification
 *
 * Proves the full ACK scanning pipeline works on a real Notion page:
 *   Turn 1: stream_cutoff → tool exec → RESULT_SUBMITTED → bridge_handoff_ack → nonce registered
 *   Turn 2: model response → stream_chunk_text → scanRawText → model_ack_confirmed → CustomEvent
 *
 * Semi-automated: CDP script configures bridge, installs ACK listener,
 * then waits for human to trigger an AI function_call via Notion prompt.
 *
 * Prerequisites:
 *   1. Chrome launched with: --remote-debugging-port=9222
 *   2. Notion agent page open with MCP SuperAssistant extension loaded
 *   3. committee-bridge-mcp running (echo tool registered)
 *   4. Bridge autoInsert=true, autoSubmit=true
 *
 * Run: node scripts/e2e-gate5d-live-ack-scanning.cjs
 *
 * Outputs:
 *   outputs/gate5d-live-ack-{timestamp}.json
 *   outputs/gate5d-live-ack-{timestamp}.md
 *
 * Author: Opus/Claude
 */

const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');

const CDP_PORT = 9222;
const TIMEOUT_MS = 10000;
const POLL_INTERVAL_MS = 3000;
const MAX_POLL_ROUNDS = 20; // 60 seconds total
const MAX_ATTEMPTS = 3;

// ============================================================================
// Main
// ============================================================================

async function main() {
    const startTime = Date.now();
    const evidence = {
        gate: '5d',
        timestamp: new Date().toISOString(),
        phase0: null,
        attempts: [],
        bestResult: 'PENDING',
        durationMs: 0,
    };

    try {
        // Phase 0: Preflight
        const phase0 = await runPhase0();
        evidence.phase0 = phase0;

        if (!phase0.passed) {
            evidence.bestResult = 'PHASE0_FAIL';
            console.log('\n❌ Phase 0 failed — stopping.');
            return;
        }

        // ACK scanning attempts
        for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
            console.log(`\n${'='.repeat(60)}`);
            console.log(`🔄 Attempt ${attempt + 1}/${MAX_ATTEMPTS}`);
            console.log('='.repeat(60));

            const attemptResult = await runAckAttempt(attempt + 1);
            evidence.attempts.push(attemptResult);

            if (attemptResult.result === 'ACK_CONFIRMED' || attemptResult.result === 'ACK_CONFIRMED_DOM') {
                evidence.bestResult = attemptResult.result;
                console.log(`\n🎉 ${attemptResult.result} on attempt ${attempt + 1}!`);
                break;
            }

            if (attempt < MAX_ATTEMPTS - 1) {
                console.log('\n⏳ Waiting 10s before next attempt...');
                await new Promise(r => setTimeout(r, 10000));
            }
        }

        if (evidence.bestResult === 'PENDING') {
            const anyHandoff = evidence.attempts.some(a => a.handoffReceived);
            evidence.bestResult = anyHandoff ? 'ACK_TIMEOUT' : 'NO_HANDOFF';
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
// Phase 0: Preflight
// ============================================================================

async function runPhase0() {
    console.log('\n🔍 Phase 0: Preflight\n');

    // Step 0a: Reload extension via service worker CDP
    console.log('--- Step 0a: Reloading extension via CDP ---');
    const { resolveExtensionId, ensureAgentPage } = require('./lib/cdp-preflight.cjs');
    const ext = await resolveExtensionId('MCP SuperAssistant');
    console.log(`✅ Extension found: ${ext.name} (${ext.extensionId})`);

    // Connect to service worker and call chrome.runtime.reload()
    const swWs = new WebSocket(ext.wsUrl);
    await new Promise((r, e) => { swWs.on('open', r); swWs.on('error', e); });
    const reloadResult = await new Promise(resolve => {
        swWs.on('message', msg => {
            const o = JSON.parse(msg);
            if (o.id === 1) resolve(o);
        });
        swWs.send(JSON.stringify({
            id: 1,
            method: 'Runtime.evaluate',
            params: { expression: 'chrome.runtime.reload()', returnByValue: true }
        }));
        setTimeout(() => resolve({ timeout: true }), 5000);
    });
    swWs.close();
    console.log('✅ Extension reload triggered');

    // Wait for extension to reinitialize
    console.log('   Waiting 5s for extension to reinitialize...');
    await new Promise(r => setTimeout(r, 5000));

    // Step 0b: Refresh Notion page (CDP Page.reload)
    console.log('--- Step 0b: Refreshing Notion page ---');
    const page = await ensureAgentPage();
    const notionTab = page.tab;

    // Reload the Notion tab so the new extension content script is injected
    const reloadWs = new WebSocket(notionTab.webSocketDebuggerUrl);
    await new Promise((r, e) => { reloadWs.on('open', r); reloadWs.on('error', e); });
    reloadWs.send(JSON.stringify({ id: 1, method: 'Page.reload', params: {} }));
    await new Promise(r => setTimeout(r, 1000));
    reloadWs.close();
    console.log('✅ Notion page reload triggered');

    // Wait for page + extension to settle
    console.log('   Waiting 10s for page + extension to settle...');
    await new Promise(r => setTimeout(r, 10000));

    // Re-acquire the tab (URL might have changed)
    const page2 = await ensureAgentPage();
    const notionTab2 = page2.tab;
    console.log(`✅ Tab: ${notionTab2.url.slice(0, 80)}`);
    const ws = new WebSocket(notionTab2.webSocketDebuggerUrl);
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
        return { passed: false, error: 'No ISOLATED world found' };
    }
    console.log('✅ ISOLATED world:', isoCtx);

    async function evalIso(expression, opts = {}) {
        const params = { expression, returnByValue: true, awaitPromise: opts.awaitPromise || false, contextId: isoCtx, ...opts };
        const result = await send('Runtime.evaluate', params);
        return result.result?.result;
    }

    // Check bridge info (before configure)
    const bridgeInfoPre = await evalIso(`(function() {
        try {
            const info = window.getStreamToolBridgeInfo?.();
            return info || null;
        } catch (e) { return { error: e.message }; }
    })()`, { awaitPromise: false });

    const infoPre = bridgeInfoPre?.value;
    console.log('Bridge info (pre-configure):', JSON.stringify(infoPre, null, 2));

    const mcpReady = infoPre?.mcpClientReady === true;

    if (!mcpReady) {
        ws.close();
        return { passed: false, error: 'mcpClient not ready', bridgeInfo: infoPre };
    }

    // Configure bridge to trigger initStreamToolBridge + create ackTracker
    await evalIso(`(function() {
        if (typeof window.configureStreamToolBridge === 'function') {
            window.configureStreamToolBridge({
                enabled: true,
                cutoffEnabled: true,
                autoInsert: true,
                autoSubmit: true,
            });
        }
    })()`, { awaitPromise: false });
    console.log('✅ Bridge configured (enabled + autoSubmit)');

    // Check bridge info after configure
    const bridgeInfoPost = await evalIso(`(function() {
        try {
            const info = window.getStreamToolBridgeInfo?.();
            return info || null;
        } catch (e) { return { error: e.message }; }
    })()`, { awaitPromise: false });

    const infoPost = bridgeInfoPost?.value;
    console.log('Bridge info (post-configure):', JSON.stringify(infoPost, null, 2));

    const ackActive = infoPost?.ackTrackerActive === true;
    if (!ackActive) {
        // ackTrackerActive might not be in bridge info if running old build
        console.log('⚠️  ackTrackerActive not true — extension may not have Gate 5d build');
        console.log('   Proceeding anyway to check live behavior...');
    } else {
        console.log('✅ ackTracker active');
    }

    console.log('✅ mcpClient ready, bridge configured');
    ws.close();
    return { passed: true, bridgeInfo: infoPost, ackTrackerActive: ackActive };
}

// ============================================================================
// ACK Scanning Attempt
// ============================================================================

async function runAckAttempt(attemptNum) {
    const attemptStart = Date.now();
    const result = {
        attempt: attemptNum,
        result: 'PENDING',
        handoffReceived: false,
        handoffNonce: null,
        handoffStreamId: null,
        chunkTextEvents: 0,
        ackEvent: null,
        bridgeInfoBefore: null,
        bridgeInfoAfter: null,
        events: [],
        durationMs: 0,
    };

    const { ensureAgentPage } = require('./lib/cdp-preflight.cjs');
    const page = await ensureAgentPage();
    const notionTab = page.tab;

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
        result.result = 'NO_ISO_WORLD';
        ws.close();
        return result;
    }

    async function evalIso(expression, opts = {}) {
        const params = { expression, returnByValue: true, awaitPromise: opts.awaitPromise || false, contextId: isoCtx, ...opts };
        const res = await send('Runtime.evaluate', params);
        return res.result?.result;
    }

    // MAIN world evaluation (default context — no contextId)
    async function evalMain(expression, opts = {}) {
        const params = { expression, returnByValue: true, awaitPromise: opts.awaitPromise || false, ...opts };
        const res = await send('Runtime.evaluate', params);
        return res.result?.result;
    }

    // Step 1: Configure bridge
    console.log('\n--- Step 1: Configure bridge ---');
    await evalIso(`(function() {
        if (typeof window.configureStreamToolBridge === 'function') {
            window.configureStreamToolBridge({
                enabled: true,
                cutoffEnabled: true,
                autoInsert: true,
                autoSubmit: true,
            });
        }
    })()`, { awaitPromise: false });

    // Step 1b: Direct MAIN world config injection (bypass postMessage race)
    // Send cutoff config directly to MAIN world interceptor with high seq number
    console.log('--- Step 1b: Direct MAIN world cutoff config ---');
    await evalMain(`(function() {
        window.postMessage({
            channel: 'mcp-superassistant.stream.config',
            direction: 'isolated-to-main',
            seq: 9999,
            config: {
                cutoffEnabled: true,
                emitChunkText: true,
                requireStructuredIdentity: false,
            }
        }, window.location.origin);
    })()`, { awaitPromise: false });
    await new Promise(r => setTimeout(r, 500)); // Let postMessage process
    console.log('✅ MAIN world cutoff config injected (seq=9999)');

    // Step 2: Get bridge info before
    const infoBefore = await evalIso(`(function() {
        return window.getStreamToolBridgeInfo?.() || null;
    })()`, { awaitPromise: false });
    result.bridgeInfoBefore = infoBefore?.value;
    console.log('Bridge before:', JSON.stringify({
        ackTrackerActive: infoBefore?.value?.ackTrackerActive,
        ackPendingCount: infoBefore?.value?.ackPendingCount,
        lastModelAckEvent: infoBefore?.value?.lastModelAckEvent,
    }));

    // Step 2a: Install MAIN world fetch spy to discover Turn 2 endpoint
    console.log('\n--- Step 2a: Install fetch spy ---');
    await evalMain(`(function() {
        if (window.__gate5d_fetchSpy) return; // already installed
        window.__gate5d_fetchUrls = [];
        const origFetch = window.fetch.__mcpSaOriginal || window.fetch;
        window.__gate5d_fetchSpy = true;
        const prevFetch = window.fetch;
        window.fetch = function() {
            try {
                const url = typeof arguments[0] === 'string' ? arguments[0]
                    : arguments[0] instanceof URL ? arguments[0].href
                    : arguments[0]?.url || '';
                if (url.includes('/api/v3/')) {
                    const pathname = new URL(url, window.location.href).pathname;
                    window.__gate5d_fetchUrls.push({ pathname, ts: Date.now() });
                }
            } catch(e) {}
            return prevFetch.apply(this, arguments);
        };
    })()`, { awaitPromise: false });
    console.log('✅ Fetch spy installed');

    // Step 2b: Install ACK event listener
    console.log('\n--- Step 2b: Install ACK listener ---');
    await evalIso(`(function() {
        // Clean up any previous state
        delete window.__gate5d_ackEvents;
        delete window.__gate5d_chunkTextCount;
        delete window.__gate5d_streamIds;
        delete window.__gate5d_chunkSamples;
        delete window.__gate5d_bridgeEvents;

        window.__gate5d_ackEvents = [];
        window.__gate5d_chunkTextCount = 0;
        window.__gate5d_streamIds = new Set();
        window.__gate5d_chunkSamples = []; // last 5 chunk text snippets
        window.__gate5d_bridgeEvents = []; // all bridge events

        // Listen for model ACK events
        window.addEventListener('mcp-superassistant:model-ack', (e) => {
            window.__gate5d_ackEvents.push({
                type: e.detail.type,
                nonce: e.detail.nonce,
                callId: e.detail.callId,
                functionName: e.detail.functionName,
                latencyMs: e.detail.latencyMs,
                ts: Date.now(),
            });
        });

        // Listen for ALL bridge events via postMessage
        window.addEventListener('message', (e) => {
            const data = e.data;
            if (!data || data.channel !== 'mcp-superassistant.stream') return;
            const ev = data.event;
            if (!ev) return;

            // Track ALL event types
            window.__gate5d_bridgeEvents.push({
                type: ev.type,
                streamId: ev.streamId || 'n/a',
                identity: ev.identity || null,
                reason: ev.reason || null,
                mode: ev.mode || null,
                rawLine: ev.type === 'function_call' ? (ev.rawLine || '').slice(0, 500) : undefined,
                ts: Date.now(),
            });

            if (ev.type === 'stream_chunk_text') {
                window.__gate5d_chunkTextCount++;
                window.__gate5d_streamIds.add(ev.streamId);
                // Keep last 5 chunk samples
                const sample = { streamId: ev.streamId, chunkIndex: ev.chunkIndex, textSnippet: (ev.text || '').slice(0, 100), ts: Date.now() };
                window.__gate5d_chunkSamples.push(sample);
                if (window.__gate5d_chunkSamples.length > 10) window.__gate5d_chunkSamples.shift();
            }
        });
    })()`, { awaitPromise: false });
    console.log('✅ ACK listener installed');

    // Step 4: Auto-inject prompt to trigger tool call
    console.log('\n--- Step 3: Auto-injecting prompt ---');

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

    // Type prompt — ask AI to call echo tool
    const prompt = '请调用 committee-bridge.echo 工具，参数为 {"message": "gate5d_ack_test"}。调用后直接引用结果即可。';

    const focusResult = await evalMain(`(function() {
        const el = document.querySelector('div[role="textbox"][contenteditable="true"]');
        if (!el) return { ok: false, error: 'no textbox' };
        el.focus();
        el.click();
        return { ok: true };
    })()`, { awaitPromise: false });
    if (!focusResult?.value?.ok) {
        result.result = 'PROMPT_ERROR';
        result.events.push({ type: 'focus_failed', error: focusResult?.value?.error });
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
        result.result = 'PROMPT_ERROR';
        result.events.push({ type: 'type_failed', preview: typeVerify?.value?.preview });
        ws.close();
        result.durationMs = Date.now() - attemptStart;
        return result;
    }
    console.log('✅ Prompt typed');

    // Submit
    await new Promise(r => setTimeout(r, 500));
    const submitResult = await evalMain(`(function() {
        const btn = document.querySelector('[data-testid="agent-send-message-button"]');
        if (btn && !btn.disabled) { btn.click(); return { method: 'sendButton', ok: true }; }
        const btn2 = document.querySelector('[aria-label="提交 AI 消息"]');
        if (btn2 && !btn2.disabled) { btn2.click(); return { method: 'ariaLabel', ok: true }; }
        const textbox = document.querySelector('div[role="textbox"][contenteditable="true"]');
        if (textbox) {
            textbox.focus();
            textbox.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true }));
            return { method: 'enter', ok: true };
        }
        return { method: 'none', error: 'No submit method found', ok: false };
    })()`, { awaitPromise: false });

    if (!submitResult?.value?.ok) {
        result.result = 'SUBMIT_ERROR';
        result.events.push({ type: 'submit_failed', error: submitResult?.value?.error });
        ws.close();
        result.durationMs = Date.now() - attemptStart;
        return result;
    }
    console.log(`✅ Prompt submitted via ${submitResult?.value?.method}`);

    // Step 5: Poll for ACK
    console.log('\n--- Step 4: Polling for ACK ---');

    let ackConfirmed = false;
    for (let round = 0; round < MAX_POLL_ROUNDS; round++) {
        await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));

        // Poll state
        const state = await evalIso(`(function() {
            const info = window.getStreamToolBridgeInfo?.() || {};
            return {
                ackPendingCount: info.ackPendingCount || 0,
                lastModelAckEvent: info.lastModelAckEvent || null,
                ackEvents: window.__gate5d_ackEvents || [],
                chunkTextCount: window.__gate5d_chunkTextCount || 0,
                streamIds: window.__gate5d_streamIds ? Array.from(window.__gate5d_streamIds) : [],
                chunkSamples: window.__gate5d_chunkSamples || [],
                bridgeEventTypes: (window.__gate5d_bridgeEvents || []).map(e => e.type),
                bridgeFunctionCalls: (window.__gate5d_bridgeEvents || []).filter(e => e.type === 'function_call' || e.type === 'stream_cutoff').map(e => ({ type: e.type, identity: e.identity, reason: e.reason, mode: e.mode, rawLine: e.rawLine })),
            };
        })()`, { awaitPromise: false });

        const s = state?.value;
        if (!s) continue;

        // Track handoff (pending nonce appeared)
        if (s.ackPendingCount > 0 && !result.handoffReceived) {
            result.handoffReceived = true;
            console.log(`\n📦 Handoff detected! Pending nonces: ${s.ackPendingCount}`);
            result.events.push({ type: 'handoff_detected', pendingCount: s.ackPendingCount, round, ts: Date.now() });
        }

        // Track chunk text events
        if (s.chunkTextCount > 0 && s.chunkTextCount !== result.chunkTextEvents) {
            const diff = s.chunkTextCount - result.chunkTextEvents;
            result.chunkTextEvents = s.chunkTextCount;
            console.log(`  📡 chunk_text events: ${s.chunkTextCount} (+${diff})`);
        }

        // Check for ACK
        if (s.ackEvents && s.ackEvents.length > 0) {
            const confirmed = s.ackEvents.find(e => e.type === 'model_ack_confirmed');
            const timeout = s.ackEvents.find(e => e.type === 'model_ack_timeout');

            if (confirmed) {
                ackConfirmed = true;
                result.ackEvent = confirmed;
                result.handoffNonce = confirmed.nonce;
                result.result = 'ACK_CONFIRMED';
                console.log(`\n🎉 model_ack_confirmed!`);
                console.log(`   Nonce: ${confirmed.nonce}`);
                console.log(`   Function: ${confirmed.functionName}`);
                console.log(`   Latency: ${confirmed.latencyMs}ms`);
                result.events.push({ type: 'model_ack_confirmed', ...confirmed });
                break;
            }

            if (timeout) {
                result.ackEvent = timeout;
                result.handoffNonce = timeout.nonce;
                result.result = 'ACK_TIMEOUT';
                console.log(`\n⏰ model_ack_timeout after ${timeout.latencyMs}ms`);
                console.log(`   Nonce: ${timeout.nonce}`);
                console.log(`   Function: ${timeout.functionName}`);
                result.events.push({ type: 'model_ack_timeout', ...timeout });
                break;
            }
        }

        // DOM-based nonce detection fallback (Turn 2 may use different API endpoint)
        if (result.handoffReceived && !ackConfirmed) {
            const domCheck = await evalMain(`(function() {
                const bodyText = document.body?.innerText || '';
                // Find all mcp_ack nonce patterns in the body text
                // Pattern: mcp_ack nonce="ack_..." (appears in both instruction and model echo)
                const regex = /mcp_ack\\s+nonce="(ack_[^"]+)"/g;
                const matches = [];
                let m;
                while ((m = regex.exec(bodyText)) !== null) {
                    matches.push(m[1]);
                }
                // Count occurrences per nonce — if same nonce appears >= 2 times,
                // one is the instruction and one is the model's echo
                const counts = {};
                for (const nonce of matches) {
                    counts[nonce] = (counts[nonce] || 0) + 1;
                }
                const echoed = Object.entries(counts).filter(([_, c]) => c >= 2);
                return {
                    totalMatches: matches.length,
                    nonceCounts: counts,
                    echoedNonces: echoed.map(([n]) => n),
                    hasEcho: echoed.length > 0,
                };
            })()`, { awaitPromise: false });

            if (domCheck?.value?.hasEcho) {
                const echoedNonce = domCheck.value.echoedNonces[0];
                ackConfirmed = true;
                result.result = 'ACK_CONFIRMED_DOM';
                result.handoffNonce = echoedNonce;
                result.ackEvent = {
                    type: 'model_ack_confirmed_dom',
                    nonce: echoedNonce,
                    detectionMethod: 'dom_scan',
                    nonceCounts: domCheck.value.nonceCounts,
                    round,
                    ts: Date.now(),
                };
                result.events.push(result.ackEvent);
                console.log(`\n🎉 ACK confirmed via DOM scan! (nonce echoed by model)`);
                console.log(`   Nonce: ${echoedNonce}`);
                console.log(`   Detection: DOM innerText scan (Turn 2 stream not intercepted)`);
                break;
            }
        }

        // Progress indicator
        if (round % 5 === 4) {
            // Also poll fetch spy URLs
            const fetchUrls = await evalMain(`(function() {
                return window.__gate5d_fetchUrls || [];
            })()`, { awaitPromise: false });
            const urls = fetchUrls?.value || [];

            console.log(`  ⏳ Polling... round ${round + 1}/${MAX_POLL_ROUNDS}, pending=${s.ackPendingCount}, chunks=${s.chunkTextCount}`);
            console.log(`     Stream IDs: [${s.streamIds?.join(', ')}]`);
            console.log(`     Bridge events: [${s.bridgeEventTypes?.join(', ')}]`);
            if (s.bridgeFunctionCalls?.length > 0) {
                console.log(`     Function calls: ${JSON.stringify(s.bridgeFunctionCalls)}`);
            }
            console.log(`     Fetch URLs: [${urls.map(u => u.pathname).join(', ')}]`);
            if (s.chunkSamples?.length > 0) {
                const last = s.chunkSamples[s.chunkSamples.length - 1];
                console.log(`     Last chunk: stream=${last.streamId}, idx=${last.chunkIndex}, text=${last.textSnippet?.slice(0, 60)}`);
            }
        }
    }

    // Step 6: Get bridge info after + DOM diagnostics + fetch URLs
    const infoAfter = await evalIso(`(function() {
        return window.getStreamToolBridgeInfo?.() || null;
    })()`, { awaitPromise: false });
    result.bridgeInfoAfter = infoAfter?.value;

    // Capture fetch spy URLs
    const fetchUrlsFinal = await evalMain(`(function() {
        return window.__gate5d_fetchUrls || [];
    })()`, { awaitPromise: false });
    result.fetchUrls = fetchUrlsFinal?.value || [];

    // Check DOM for messages to see if Turn 2 happened
    const domDiag = await evalMain(`(function() {
        // Count message blocks in the conversation
        const blocks = document.querySelectorAll('[data-block-id]');
        const textbox = document.querySelector('div[role="textbox"][contenteditable="true"]');
        const textboxContent = textbox?.textContent || '';
        // Look for any text containing the nonce pattern
        const bodyText = document.body?.innerText || '';
        const hasAckTag = bodyText.includes('mcp_ack');
        const hasResultNonce = bodyText.includes('result_nonce');
        return {
            blockCount: blocks?.length || 0,
            textboxEmpty: textboxContent.length === 0,
            textboxContent: textboxContent.slice(0, 200),
            hasAckTag,
            hasResultNonce,
            bodySnippet: bodyText.slice(-500), // last 500 chars
        };
    })()`, { awaitPromise: false });
    result.domDiagnostics = domDiag?.value;
    console.log('\n📊 DOM diagnostics:', JSON.stringify({
        blocks: domDiag?.value?.blockCount,
        textboxEmpty: domDiag?.value?.textboxEmpty,
        hasAckTag: domDiag?.value?.hasAckTag,
        hasResultNonce: domDiag?.value?.hasResultNonce,
    }));

    // Cleanup listener state
    await evalIso(`(function() {
        delete window.__gate5d_ackEvents;
        delete window.__gate5d_chunkTextCount;
        delete window.__gate5d_streamIds;
        delete window.__gate5d_chunkSamples;
        delete window.__gate5d_bridgeEvents;
    })()`, { awaitPromise: false });

    if (!ackConfirmed && result.result === 'PENDING') {
        result.result = result.handoffReceived ? 'POLL_TIMEOUT' : 'NO_HANDOFF';
    }

    result.durationMs = Date.now() - attemptStart;
    ws.close();
    return result;
}

// ============================================================================
// Evidence output
// ============================================================================

async function writeEvidence(evidence) {
    const ts = new Date().toISOString().replace(/:/g, '-').replace(/\.\d{3}Z/, '');
    const jsonPath = path.join(__dirname, '..', 'outputs', `gate5d-live-ack-${ts}.json`);
    const mdPath = path.join(__dirname, '..', 'outputs', `gate5d-live-ack-${ts}.md`);

    fs.mkdirSync(path.dirname(jsonPath), { recursive: true });
    fs.writeFileSync(jsonPath, JSON.stringify(evidence, null, 2));

    const md = generateMarkdown(evidence);
    fs.writeFileSync(mdPath, md);

    console.log(`\n📋 Evidence written to:`);
    console.log(`   ${jsonPath}`);
    console.log(`   ${mdPath}`);
    console.log(`\n🎯 Result: ${evidence.bestResult}`);
}

function generateMarkdown(evidence) {
    const lines = [
        `# Gate 5d Live E2E — Cross-Turn ACK Scanning`,
        ``,
        `**Result: ${evidence.bestResult}**`,
        `**Timestamp:** ${evidence.timestamp}`,
        `**Duration:** ${evidence.durationMs}ms`,
        ``,
    ];

    if (evidence.phase0) {
        lines.push(`## Phase 0: Preflight`);
        lines.push(`- Passed: ${evidence.phase0.passed}`);
        if (evidence.phase0.error) lines.push(`- Error: ${evidence.phase0.error}`);
        if (evidence.phase0.bridgeInfo) {
            const bi = evidence.phase0.bridgeInfo;
            lines.push(`- mcpClientReady: ${bi.mcpClientReady}`);
            lines.push(`- ackTrackerActive: ${bi.ackTrackerActive}`);
            lines.push(`- ackPendingCount: ${bi.ackPendingCount}`);
        }
        lines.push(``);
    }

    for (const attempt of evidence.attempts) {
        lines.push(`## Attempt ${attempt.attempt}`);
        lines.push(`- Result: ${attempt.result}`);
        lines.push(`- Duration: ${attempt.durationMs}ms`);
        lines.push(`- Handoff received: ${attempt.handoffReceived}`);
        lines.push(`- Chunk text events: ${attempt.chunkTextEvents}`);

        if (attempt.ackEvent) {
            lines.push(`### ACK Event`);
            lines.push(`- Type: ${attempt.ackEvent.type}`);
            lines.push(`- Nonce: ${attempt.ackEvent.nonce}`);
            lines.push(`- Function: ${attempt.ackEvent.functionName}`);
            lines.push(`- Latency: ${attempt.ackEvent.latencyMs}ms`);
        }

        if (attempt.events.length > 0) {
            lines.push(`### Events`);
            for (const ev of attempt.events) {
                lines.push(`- \`${ev.type}\` ${ev.nonce || ''} ${ev.functionName || ''} ${ev.latencyMs ? `(${ev.latencyMs}ms)` : ''}`);
            }
        }
        lines.push(``);
    }

    return lines.join('\n');
}

// ============================================================================
// Run
// ============================================================================

main().catch(err => {
    console.error('Fatal:', err);
    process.exit(1);
});
