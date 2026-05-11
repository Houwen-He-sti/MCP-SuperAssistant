/**
 * Gate 6B OO Probe: CustomEvent.detail cross-world delivery verification
 *
 * Verifies whether a CustomEvent dispatched from MAIN world (page script context)
 * can be received by isolated world (content script context) with detail intact.
 *
 * This is a critical observation for Gate 6B transport decision:
 * - If detail is readable → keep CustomEvent transport
 * - If detail is null/broken → switch to window.postMessage
 *
 * Run: node scripts/gate6b-crossworld-customevent-probe.cjs
 * Requires: Chrome with --remote-debugging-port=9222, Notion agent page open
 */
const http = require('http');
const WebSocket = require('ws');

const CDP_PORT = process.env.CDP_PORT || 9222;

function getTargets() {
    return new Promise((resolve, reject) => {
        http.get(`http://127.0.0.1:${CDP_PORT}/json`, res => {
            let d = '';
            res.on('data', c => d += c);
            res.on('end', () => resolve(JSON.parse(d)));
        }).on('error', reject);
    });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

let _counter = 0;
function cdpSend(ws, method, params = {}) {
    const id = ++_counter;
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`CDP timeout: ${method}`)), 10000);
        const handler = (raw) => {
            const msg = JSON.parse(raw.toString());
            if (msg.id === id) {
                ws.removeListener('message', handler);
                clearTimeout(timer);
                if (msg.error) reject(new Error(`CDP error: ${JSON.stringify(msg.error)}`));
                else resolve(msg.result);
            }
        };
        ws.on('message', handler);
        ws.send(JSON.stringify({ id, method, params }));
    });
}

async function main() {
    console.log('=== Gate 6B: CustomEvent.detail Cross-World Probe ===\n');

    // Step 1: Find Notion tab
    const targets = await getTargets();
    const notionTab = targets.find(t =>
        t.type === 'page' && t.url.includes('notion.so')
    );
    if (!notionTab) {
        console.error('❌ No Notion tab found. Open Notion in Chrome with --remote-debugging-port=9222');
        process.exit(1);
    }
    console.log(`✓ Found Notion tab: ${notionTab.url.substring(0, 60)}...`);

    // Step 2: Connect via CDP
    const ws = new WebSocket(notionTab.webSocketDebuggerUrl);
    await new Promise((r, e) => { ws.on('open', r); ws.on('error', e); });
    console.log('✓ CDP connected\n');

    // Step 3: Collect execution contexts (listen BEFORE enabling to catch initial events)
    const contexts = [];
    const contextHandler = (raw) => {
        const msg = JSON.parse(raw.toString());
        if (msg.method === 'Runtime.executionContextCreated') {
            contexts.push(msg.params.context);
        }
    };
    ws.on('message', contextHandler);

    // Enable Runtime — this triggers executionContextCreated for all existing contexts
    await cdpSend(ws, 'Runtime.enable');
    await sleep(500);
    ws.removeListener('message', contextHandler);

    // Find isolated world context (extension content script)
    // Extension content scripts have origin starting with chrome-extension://
    // or have a name containing the extension
    console.log(`Found ${contexts.length} execution contexts:`);
    for (const ctx of contexts) {
        const label = ctx.name || ctx.origin || '(unnamed)';
        console.log(`  - id=${ctx.id} origin="${ctx.origin}" name="${ctx.name}" auxData=${JSON.stringify(ctx.auxData || {})}`);
    }

    // Strategy: Find the content script context by looking for:
    // 1. auxData.type === 'isolated' with frameId matching main frame
    // 2. or origin matching chrome-extension://
    const isolatedCtx = contexts.find(ctx =>
        ctx.origin === 'chrome-extension://hkjclekhnaffnhldgpmjnohihjmblbpj' &&
        ctx.name === 'MCP SuperAssistant'
    ) || contexts.find(ctx =>
        ctx.auxData?.type === 'isolated' ||
        (ctx.origin && ctx.origin.startsWith('chrome-extension://'))
    );

    const mainCtx = contexts.find(ctx =>
        ctx.auxData?.isDefault === true &&
        ctx.auxData?.type === 'default' &&
        ctx.auxData?.frameId === isolatedCtx?.auxData?.frameId
    ) || contexts.find(ctx =>
        ctx.auxData?.isDefault === true || ctx.auxData?.type === 'default'
    );

    if (!isolatedCtx) {
        console.log('\n⚠️  No isolated world context found. Falling back to same-context test.');
        console.log('    This tests CustomEvent mechanics but NOT cross-V8-isolate delivery.');
        console.log('    For true cross-world test, ensure MCP-SuperAssistant extension is loaded.\n');

        // Fallback: test in same context (still useful — tests event propagation)
        await testSameContext(ws);
    } else {
        console.log(`\n✓ Found isolated world context: id=${isolatedCtx.id} origin="${isolatedCtx.origin}"`);
        if (mainCtx) {
            console.log(`✓ Found main world context: id=${mainCtx.id}`);
        }
        await testCrossWorld(ws, mainCtx?.id, isolatedCtx.id);
    }

    ws.close();
}

async function testSameContext(ws) {
    console.log('--- Same-context CustomEvent test ---\n');

    // Install listener
    await cdpSend(ws, 'Runtime.evaluate', {
        expression: `
            window.__GATE6B_PROBE_RESULT__ = null;
            window.addEventListener('mcp-superassistant:tool-loop-event', (event) => {
                const detail = event.detail;
                window.__GATE6B_PROBE_RESULT__ = {
                    received: true,
                    hasDetail: detail != null,
                    detailType: typeof detail,
                    type: detail?.type,
                    version: detail?.version,
                    timestamp: detail?.timestamp,
                    streamId: detail?.streamId,
                    nestedOk: detail?.nested?.ok === true,
                    stringified: (() => { try { return JSON.stringify(detail); } catch(e) { return 'ERROR:' + e.message; } })(),
                };
            });
            'listener installed'
        `,
        returnByValue: true,
    });

    // Dispatch event
    await cdpSend(ws, 'Runtime.evaluate', {
        expression: `
            window.dispatchEvent(new CustomEvent('mcp-superassistant:tool-loop-event', {
                detail: {
                    version: 1,
                    type: 'tool_call_detected',
                    timestamp: Date.now(),
                    streamId: 'probe-stream-001',
                    callId: 'probe-call-001',
                    toolName: 'probe_tool',
                    nested: { ok: true, deep: { value: 42 } }
                }
            }));
            'dispatched'
        `,
        returnByValue: true,
    });

    await sleep(100);

    // Read result
    const result = await cdpSend(ws, 'Runtime.evaluate', {
        expression: 'JSON.stringify(window.__GATE6B_PROBE_RESULT__)',
        returnByValue: true,
    });

    const probeResult = JSON.parse(result.result.value);
    printResults(probeResult, 'Same-context');
}

async function testCrossWorld(ws, mainCtxId, isolatedCtxId) {
    console.log('--- Cross-world CustomEvent test (MAIN → isolated) ---\n');

    // Step A: Install listener in ISOLATED world
    const listenerResult = await cdpSend(ws, 'Runtime.evaluate', {
        expression: `
            window.__GATE6B_PROBE_RESULT__ = null;
            window.addEventListener('mcp-superassistant:tool-loop-event', (event) => {
                const detail = event.detail;
                window.__GATE6B_PROBE_RESULT__ = {
                    received: true,
                    hasDetail: detail != null,
                    detailType: typeof detail,
                    type: detail?.type,
                    version: detail?.version,
                    timestamp: detail?.timestamp,
                    streamId: detail?.streamId,
                    callId: detail?.callId,
                    toolName: detail?.toolName,
                    nestedOk: detail?.nested?.ok === true,
                    stringified: (() => { try { return JSON.stringify(detail); } catch(e) { return 'ERROR:' + e.message; } })(),
                };
            });
            'listener installed in isolated world'
        `,
        contextId: isolatedCtxId,
        returnByValue: true,
    });
    console.log(`  Listener install: ${listenerResult.result?.value}`);

    // Step B: Dispatch event from MAIN world
    const dispatchParams = {
        expression: `
            window.dispatchEvent(new CustomEvent('mcp-superassistant:tool-loop-event', {
                detail: {
                    version: 1,
                    type: 'tool_call_detected',
                    timestamp: Date.now(),
                    streamId: 'probe-stream-001',
                    callId: 'probe-call-001',
                    toolName: 'probe_tool',
                    nested: { ok: true, deep: { value: 42 } }
                }
            }));
            'dispatched from main world'
        `,
        returnByValue: true,
    };
    if (mainCtxId) dispatchParams.contextId = mainCtxId;
    const dispatchResult = await cdpSend(ws, 'Runtime.evaluate', dispatchParams);
    console.log(`  Event dispatch: ${dispatchResult.result?.value}`);

    await sleep(200);

    // Step C: Read result from ISOLATED world
    const readResult = await cdpSend(ws, 'Runtime.evaluate', {
        expression: 'JSON.stringify(window.__GATE6B_PROBE_RESULT__)',
        contextId: isolatedCtxId,
        returnByValue: true,
    });

    const probeResult = readResult.result?.value ? JSON.parse(readResult.result.value) : null;
    printResults(probeResult, 'Cross-world (MAIN → isolated)');
}

function printResults(probeResult, label) {
    console.log(`\n=== ${label} Results ===\n`);

    if (!probeResult) {
        console.log('❌ FAIL: No probe result — event not received at all');
        console.log('\n📋 DECISION: Switch to window.postMessage transport');
        return;
    }

    const checks = [
        ['received', probeResult.received === true],
        ['hasDetail', probeResult.hasDetail === true],
        ['detailType === "object"', probeResult.detailType === 'object'],
        ['type === "tool_call_detected"', probeResult.type === 'tool_call_detected'],
        ['version === 1', probeResult.version === 1],
        ['timestamp is number', typeof probeResult.timestamp === 'number'],
        ['streamId readable', probeResult.streamId === 'probe-stream-001'],
        ['nested.ok === true', probeResult.nestedOk === true],
        ['JSON.stringify works', probeResult.stringified && !probeResult.stringified.startsWith('ERROR:')],
    ];

    let allPass = true;
    for (const [name, pass] of checks) {
        console.log(`  ${pass ? '✅' : '❌'} ${name}`);
        if (!pass) allPass = false;
    }

    console.log(`\nRaw result: ${JSON.stringify(probeResult, null, 2)}`);

    if (allPass) {
        console.log('\n📋 DECISION: CustomEvent.detail works cross-world. Keep current transport.');
    } else {
        console.log('\n📋 DECISION: CustomEvent.detail broken cross-world. Switch to window.postMessage.');
    }
}

main().catch(err => {
    console.error('Fatal:', err.message);
    process.exit(1);
});
