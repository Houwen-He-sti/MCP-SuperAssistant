/**
 * Gate 3C E2E — Adapter + DOM Injection + Draft Protection + Allowlist
 *
 * Tests the real Notion adapter: insertText, getInputContent, draft protection,
 * and the full bridge autoInsert path.
 *
 * Architecture:
 *   - Adapter lives in ISOLATED world (extension content script)
 *   - CDP evaluates in MAIN world by default → need contextId for ISOLATED
 *   - DOM is shared between worlds (P16 principle)
 *
 * Test Cases:
 *   P0-2a: Adapter-only insert (direct adapter.insertText in ISOLATED world)
 *   P0-2b: Full bridge autoInsert (stream_cutoff → bridge → mock mcpClient → adapter)
 *   P0-3:  Draft protection (non-empty input → insert skipped)
 *
 * Prerequisites:
 *   - Chrome running with: --remote-debugging-port=9222
 *   - MCP-SuperAssistant extension loaded from dist/
 *   - A Notion AI page open (notion.so/agent/...)
 *   - `ws` package available
 *
 * Usage:
 *   node scripts/e2e-gate3c-injection.cjs
 *
 * Exit codes:
 *   0 = all tests pass
 *   1 = test failure
 *   2 = infrastructure error
 */

const WebSocket = require('ws');

const CDP_PORT = 9222;
const CDP_URL = `http://localhost:${CDP_PORT}/json`;
const TIMEOUT_MS = 10_000;

// ============================================================================
// CDP Session
// ============================================================================

class CDPSession {
    constructor(wsUrl) {
        this.wsUrl = wsUrl;
        this.ws = null;
        this.msgId = 0;
        this.listeners = new Map();
        this.contexts = [];
        this.isolatedCtxId = null;
    }

    async connect() {
        this.ws = new WebSocket(this.wsUrl);
        await new Promise((resolve, reject) => {
            this.ws.on('open', resolve);
            this.ws.on('error', reject);
        });
        this.ws.on('message', (data) => {
            const msg = JSON.parse(data);
            if (msg.id && this.listeners.has(msg.id)) {
                this.listeners.get(msg.id)(msg);
                this.listeners.delete(msg.id);
            }
            if (msg.method === 'Runtime.executionContextCreated') {
                this.contexts.push(msg.params.context);
            }
        });
    }

    async findIsolatedContext() {
        await new Promise(r => setTimeout(r, 1000));
        for (const ctx of this.contexts) {
            if (ctx.name === 'MCP SuperAssistant') {
                const check = await this.send('Runtime.evaluate', {
                    contextId: ctx.id,
                    expression: `typeof window.pluginRegistry !== 'undefined'`,
                    returnByValue: true,
                });
                if (check.result?.result?.value === true) {
                    this.isolatedCtxId = ctx.id;
                    return ctx.id;
                }
            }
        }
        return null;
    }

    send(method, params = {}) {
        return new Promise((resolve) => {
            const id = ++this.msgId;
            this.listeners.set(id, resolve);
            this.ws.send(JSON.stringify({ id, method, params }));
            setTimeout(() => {
                if (this.listeners.has(id)) {
                    this.listeners.delete(id);
                    resolve({ error: { message: 'CDP timeout' } });
                }
            }, TIMEOUT_MS);
        });
    }

    async evaluate(expression, opts = {}) {
        const params = {
            expression,
            returnByValue: true,
            awaitPromise: opts.awaitPromise || false,
            ...opts,
        };
        if (this.isolatedCtxId && !opts.contextId) {
            params.contextId = this.isolatedCtxId;
        }
        const result = await this.send('Runtime.evaluate', params);
        if (result.result?.exceptionDetails) {
            const exc = result.result.exceptionDetails;
            return { __exception: true, text: exc.text, description: exc.exception?.description };
        }
        return result.result?.result;
    }

    /** Evaluate in MAIN world (contextId=undefined/default) */
    async evaluateMain(expression, opts = {}) {
        const params = {
            expression,
            returnByValue: true,
            awaitPromise: opts.awaitPromise || false,
            ...opts,
        };
        // Explicitly do NOT use isolatedCtxId
        const result = await this.send('Runtime.evaluate', params);
        if (result.result?.exceptionDetails) {
            const exc = result.result.exceptionDetails;
            return { __exception: true, text: exc.text, description: exc.exception?.description };
        }
        return result.result?.result;
    }

    close() {
        if (this.ws) this.ws.close();
    }
}

// ============================================================================
// Helpers
// ============================================================================

function log(level, ...args) {
    const prefix = { info: '●', pass: '✅', fail: '❌', warn: '⚠', step: '→' };
    console.log(`  ${prefix[level] || '·'} ${args.join(' ')}`);
}

async function findNotionTab() {
    const resp = await fetch(CDP_URL);
    const tabs = await resp.json();
    return tabs.find(t =>
        t.type === 'page' &&
        t.url &&
        t.url.includes('notion.so') &&
        (t.url.includes('/ai') || t.url.includes('/agent') || t.url.includes('/chat'))
    );
}

// ============================================================================
// Test Results
// ============================================================================

const results = [];
function assert(condition, testName, detail = '') {
    if (condition) {
        log('pass', testName);
        results.push({ test: testName, pass: true });
    } else {
        log('fail', testName, detail);
        results.push({ test: testName, pass: false, detail });
    }
}

// ============================================================================
// P0-2a: Adapter-Only Insert
// ============================================================================

async function testAdapterOnlyInsert(cdp) {
    console.log('\n━━━ P0-2a: Adapter-Only Insert ━━━');

    // 1. Check adapter availability via getStreamToolBridgeInfo
    log('step', 'Checking adapter via getStreamToolBridgeInfo()...');
    const info = await cdp.evaluate(`
        (function() {
            if (typeof window.getStreamToolBridgeInfo === 'function') {
                return window.getStreamToolBridgeInfo();
            }
            // Try via pluginRegistry
            if (window.pluginRegistry && window.pluginRegistry.getActivePlugin) {
                const plugin = window.pluginRegistry.getActivePlugin();
                return { adapterAvailable: !!plugin?.adapter, pluginName: plugin?.adapter?.name || null };
            }
            return { error: 'No bridge info or pluginRegistry found' };
        })()
    `);

    log('info', 'Bridge info:', JSON.stringify(info?.value || info, null, 2).substring(0, 200));
    assert(info?.value?.adapterAvailable || info?.value?.pluginName, 'Adapter is available');

    // 2. Clear input first
    log('step', 'Clearing Notion input...');
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

    // 3. Insert function_result via adapter
    const SENTINEL = `P02A_${Date.now().toString(36)}`;
    log('step', `Inserting function_result with sentinel: ${SENTINEL}`);

    const insertResult = await cdp.evaluate(`
        (async function() {
            // Get adapter from pluginRegistry
            const registry = window.pluginRegistry;
            if (!registry || !registry.getActivePlugin) return { error: 'No pluginRegistry' };
            const plugin = registry.getActivePlugin();
            if (!plugin || !plugin.adapter) return { error: 'No active adapter' };

            const text = '<function_result call_id="c-p02a-01" name="echo" status="ok">\\n{"message":"${SENTINEL}"}\\n</function_result>';
            const success = await plugin.adapter.insertText(text);
            return { success };
        })()
    `, { awaitPromise: true });

    log('info', 'Insert result:', JSON.stringify(insertResult?.value || insertResult));
    assert(insertResult?.value?.success === true, 'adapter.insertText() returned true');

    // 4. Verify content in DOM
    await new Promise(r => setTimeout(r, 500));
    const content = await cdp.evaluate(`
        (function() {
            const sel = 'div[role="textbox"][contenteditable="true"], div.content-editable-leaf-rtl[contenteditable="true"]';
            const el = document.querySelector(sel);
            return el ? el.textContent : null;
        })()
    `);

    const domContent = content?.value || '';
    log('info', 'DOM content (first 200):', domContent.substring(0, 200));
    assert(domContent.includes(SENTINEL), 'DOM contains sentinel after insert');
    assert(domContent.includes('function_result'), 'DOM contains function_result tag');

    // 5. Verify via getInputContent (if available)
    const inputContent = await cdp.evaluate(`
        (function() {
            const registry = window.pluginRegistry;
            if (!registry || !registry.getActivePlugin) return null;
            const plugin = registry.getActivePlugin();
            if (!plugin || !plugin.adapter) return null;
            if (typeof plugin.adapter.getInputContent === 'function') {
                return plugin.adapter.getInputContent();
            }
            return '__no_getInputContent__';
        })()
    `);

    if (inputContent?.value === '__no_getInputContent__') {
        log('warn', 'adapter.getInputContent not available — skipping');
    } else if (inputContent?.value) {
        assert(inputContent.value.includes(SENTINEL), 'getInputContent() returns sentinel');
    }

    // Cleanup: clear input
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
}

// ============================================================================
// P0-2b: Full Bridge autoInsert Path
// ============================================================================

async function testFullBridgeInsert(cdp) {
    console.log('\n━━━ P0-2b: Full Bridge autoInsert Path ━━━');

    const SENTINEL = `P02B_${Date.now().toString(36)}`;

    // 1. Configure bridge: enabled, autoInsert=true, autoSubmit=false
    log('step', 'Configuring bridge...');
    const configResult = await cdp.evaluate(`
        (function() {
            if (typeof window.configureStreamToolBridge !== 'function') {
                return { error: 'configureStreamToolBridge not available' };
            }
            window.configureStreamToolBridge({
                enabled: true,
                autoInsert: true,
                autoSubmit: false,
                toolAllowlist: ['echo'],
            });
            const info = window.getStreamToolBridgeInfo();
            return { configured: true, config: info.config };
        })()
    `);

    log('info', 'Config result:', JSON.stringify(configResult?.value || configResult).substring(0, 200));
    if (configResult?.value?.error) {
        log('warn', 'Bridge config not available in this world — trying alternate approach');
        // The bridge functions may only be in ISOLATED world
        // This is expected — skip P0-2b if bridge not accessible
        assert(false, 'Bridge functions accessible in ISOLATED world', configResult?.value?.error);
        return;
    }
    assert(configResult?.value?.configured === true, 'Bridge configured successfully');

    // 2. Set up mock mcpClient
    log('step', 'Setting up mock mcpClient...');
    await cdp.evaluate(`
        (function() {
            window.mcpClient = {
                callTool: async function(name, params) {
                    window.__lastCallTool = { name, params };
                    return { message: "${SENTINEL}" };
                },
                isReady: function() { return true; }
            };
        })()
    `);

    // 3. Clear input
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

    // 4. Trigger stream_cutoff event through the bridge
    log('step', 'Sending stream_cutoff event via postMessage...');
    // The MAIN world bridge sends events via window.postMessage
    await cdp.evaluateMain(`
        window.postMessage({
            type: 'MCP_SA_STREAM_EVENT',
            payload: {
                type: 'stream_cutoff',
                streamId: 'gate3c-test-01',
                identity: {
                    name: 'echo',
                    callId: 'c-gate3c-01',
                    arguments: '{"message":"${SENTINEL}"}'
                }
            }
        }, '*');
    `);

    // 5. Wait for async processing
    await new Promise(r => setTimeout(r, 2000));

    // 6. Check if callTool was invoked
    const callToolResult = await cdp.evaluate(`
        window.__lastCallTool || null
    `);
    log('info', 'callTool invoked:', JSON.stringify(callToolResult?.value));
    assert(callToolResult?.value?.name === 'echo', 'mcpClient.callTool called with "echo"');

    // 7. Check DOM for function_result
    const content = await cdp.evaluate(`
        (function() {
            const sel = 'div[role="textbox"][contenteditable="true"], div.content-editable-leaf-rtl[contenteditable="true"]';
            const el = document.querySelector(sel);
            return el ? el.textContent : null;
        })()
    `);
    const domContent = content?.value || '';
    log('info', 'DOM after bridge (first 300):', domContent.substring(0, 300));
    assert(domContent.includes('function_result'), 'DOM contains function_result after bridge');
    assert(domContent.includes(SENTINEL), 'DOM contains sentinel from tool result');

    // 8. Verify autoSubmit was NOT triggered (form not submitted)
    // If submit happened, the input would be cleared
    assert(domContent.length > 0, 'autoSubmit=false: input NOT cleared (content still present)');

    // 9. Allowlist test: send non-allowed tool
    log('step', 'Testing allowlist rejection...');
    await cdp.evaluateMain(`
        window.postMessage({
            type: 'MCP_SA_STREAM_EVENT',
            payload: {
                type: 'stream_cutoff',
                streamId: 'gate3c-test-02',
                identity: {
                    name: 'read_file',
                    callId: 'c-gate3c-02',
                    arguments: '{"path":"/etc/passwd"}'
                }
            }
        }, '*');
    `);
    await new Promise(r => setTimeout(r, 500));

    const callTool2 = await cdp.evaluate(`window.__lastCallTool`);
    // __lastCallTool should still be the echo call, NOT read_file
    assert(callTool2?.value?.name === 'echo', 'Allowlist blocked read_file (callTool not called for it)');

    // Cleanup
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
            // Reset bridge config
            if (typeof window.configureStreamToolBridge === 'function') {
                window.configureStreamToolBridge({ enabled: false });
            }
            delete window.mcpClient;
            delete window.__lastCallTool;
        })()
    `, { awaitPromise: true });
}

// ============================================================================
// P0-3: Draft Protection
// ============================================================================

async function testDraftProtection(cdp) {
    console.log('\n━━━ P0-3: Draft Protection ━━━');

    const DRAFT_TEXT = '这是用户正在编辑的草稿内容 🖊️';
    const SENTINEL = `P03_${Date.now().toString(36)}`;

    // 1. Insert draft text into input
    log('step', 'Writing draft into input...');
    await cdp.evaluate(`
        (async function() {
            const sel = 'div[role="textbox"][contenteditable="true"], div.content-editable-leaf-rtl[contenteditable="true"]';
            const el = document.querySelector(sel);
            if (el) {
                el.focus();
                const s = window.getSelection();
                if (s) { const r = document.createRange(); r.selectNodeContents(el); s.removeAllRanges(); s.addRange(r); }
                document.execCommand('insertText', false, '${DRAFT_TEXT}');
            }
        })()
    `, { awaitPromise: true });
    await new Promise(r => setTimeout(r, 300));

    // Verify draft is present
    const draftCheck = await cdp.evaluate(`
        (function() {
            const sel = 'div[role="textbox"][contenteditable="true"], div.content-editable-leaf-rtl[contenteditable="true"]';
            const el = document.querySelector(sel);
            return el ? el.textContent : '';
        })()
    `);
    assert((draftCheck?.value || '').includes('草稿'), 'Draft text present in input');

    // 2. Configure bridge and set up mock mcpClient
    log('step', 'Configuring bridge with mock mcpClient...');
    await cdp.evaluate(`
        (function() {
            if (typeof window.configureStreamToolBridge === 'function') {
                window.configureStreamToolBridge({
                    enabled: true,
                    autoInsert: true,
                    autoSubmit: false,
                });
            }
            window.__callToolCount = 0;
            window.mcpClient = {
                callTool: async function(name, params) {
                    window.__callToolCount++;
                    return { message: "${SENTINEL}" };
                },
                isReady: function() { return true; }
            };
        })()
    `);

    // 3. Trigger stream_cutoff
    log('step', 'Sending stream_cutoff (should be blocked by draft protection)...');
    await cdp.evaluateMain(`
        window.postMessage({
            type: 'MCP_SA_STREAM_EVENT',
            payload: {
                type: 'stream_cutoff',
                streamId: 'gate3c-draft-01',
                identity: {
                    name: 'echo',
                    callId: 'c-draft-01',
                    arguments: '{"message":"${SENTINEL}"}'
                }
            }
        }, '*');
    `);
    await new Promise(r => setTimeout(r, 1000));

    // 4. Verify: tool was called (tool execution succeeds)
    const callCount = await cdp.evaluate(`window.__callToolCount`);
    log('info', 'callTool count:', callCount?.value);
    // Note: in current implementation, callTool IS called but insertText is skipped
    // This is by design: tool executes, result is produced, but inject is skipped

    // 5. Verify: input still has draft (NOT overwritten with function_result)
    const afterContent = await cdp.evaluate(`
        (function() {
            const sel = 'div[role="textbox"][contenteditable="true"], div.content-editable-leaf-rtl[contenteditable="true"]';
            const el = document.querySelector(sel);
            return el ? el.textContent : '';
        })()
    `);
    const afterText = afterContent?.value || '';
    log('info', 'Input after bridge:', afterText.substring(0, 100));
    assert(afterText.includes('草稿'), 'Draft NOT overwritten — still present');
    assert(!afterText.includes('function_result'), 'function_result NOT injected (draft protection active)');

    // Cleanup
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
            if (typeof window.configureStreamToolBridge === 'function') {
                window.configureStreamToolBridge({ enabled: false });
            }
            delete window.mcpClient;
            delete window.__callToolCount;
        })()
    `, { awaitPromise: true });
}

// ============================================================================
// Main
// ============================================================================

async function main() {
    console.log('╔══════════════════════════════════════════════╗');
    console.log('║  Gate 3C E2E: Injection + Draft Protection  ║');
    console.log('╚══════════════════════════════════════════════╝\n');

    // Find Notion tab
    log('step', 'Finding Notion AI tab...');
    const tab = await findNotionTab();
    if (!tab) {
        log('fail', 'No Notion AI tab found on CDP port', String(CDP_PORT));
        process.exit(2);
    }
    log('info', `Tab: ${tab.title} — ${tab.url.substring(0, 60)}`);

    // Connect CDP
    const cdp = new CDPSession(tab.webSocketDebuggerUrl);
    await cdp.connect();
    await cdp.send('Runtime.enable');
    await cdp.send('Page.enable');
    log('pass', 'CDP connected');

    // Find ISOLATED world
    log('step', 'Finding ISOLATED world (MCP SuperAssistant)...');
    const ctxId = await cdp.findIsolatedContext();
    if (!ctxId) {
        log('fail', 'ISOLATED world not found — extension not loaded?');
        cdp.close();
        process.exit(2);
    }
    log('pass', `ISOLATED world found (contextId=${ctxId})`);

    // Run tests
    try {
        await testAdapterOnlyInsert(cdp);
        await testFullBridgeInsert(cdp);
        await testDraftProtection(cdp);
    } catch (err) {
        log('fail', 'Unexpected error:', err.message);
        console.error(err);
    }

    // Summary
    console.log('\n━━━ SUMMARY ━━━');
    const passed = results.filter(r => r.pass).length;
    const failed = results.filter(r => !r.pass).length;
    console.log(`  Total: ${results.length} | Pass: ${passed} | Fail: ${failed}`);

    if (failed > 0) {
        console.log('\n  Failed tests:');
        results.filter(r => !r.pass).forEach(r => {
            console.log(`    ❌ ${r.test}${r.detail ? ` — ${r.detail}` : ''}`);
        });
    }

    cdp.close();
    process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => {
    console.error('Fatal:', err);
    process.exit(2);
});
