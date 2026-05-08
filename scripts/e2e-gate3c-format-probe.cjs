/**
 * Gate 3C-prep P0-1 — Format Probe: function_result compatibility test
 *
 * Injects different function_result formats into Notion AI input via the adapter,
 * submits, and observes AI response to determine which format Notion AI can consume.
 *
 * Prerequisites:
 *   - Chrome running with: --remote-debugging-port=9222
 *   - MCP-SuperAssistant extension loaded from dist/ (pnpm build first)
 *   - A Notion page open with AI available (notion.so)
 *   - `ws` package available: npm install ws
 *
 * Usage:
 *   node scripts/e2e-gate3c-format-probe.cjs
 *
 * Test sequence (each format injected separately):
 *   Plan A: Bare XML — <function_result call_id="..." name="..." status="ok">{payload}</function_result>
 *   Plan B: Short wrapper — "Tool result:\n\n<function_result ...>"
 *   Plan C: NL instruction wrapper
 *
 * Pass/Fail criteria:
 *   PASS: AI response references the SENTINEL value from result payload
 *   FAIL: AI ignores payload, explains XML syntax, or treats content as instruction
 *
 * This is an exploratory/interactive test — requires human observation of AI responses.
 * The script injects content and waits for manual submission + response verification.
 *
 * Exit codes:
 *   0 = injection successful (manual verification required)
 *   1 = injection failed
 *   2 = infrastructure error
 */

const WebSocket = require('ws');

const CDP_PORT = 9222;
const CDP_URL = `http://localhost:${CDP_PORT}/json`;
const TIMEOUT_MS = 10_000;

// Sentinel payload for detection
const SENTINEL = 'GATE3C_SENTINEL_7f3a';
const SENTINEL_VALUE = 42;

// ============================================================================
// CDP Session (reused pattern from e2e-gate3b)
// ============================================================================

class CDPSession {
    constructor(wsUrl) {
        this.wsUrl = wsUrl;
        this.ws = null;
        this.msgId = 0;
        this.listeners = new Map();
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
        });
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
        const result = await this.send('Runtime.evaluate', {
            expression,
            returnByValue: true,
            awaitPromise: opts.awaitPromise || false,
            ...opts,
        });
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
        t.url && t.url.includes('notion.so') &&
        t.webSocketDebuggerUrl
    ) || null;
}

// ============================================================================
// Format definitions
// ============================================================================

const FORMATS = {
    'Plan A (bare XML)': `<function_result call_id="probe_001" name="echo" status="ok">\n{"message":"${SENTINEL}","value":${SENTINEL_VALUE}}\n</function_result>`,

    'Plan B (short wrapper)': `Tool result:\n\n<function_result call_id="probe_002" name="echo" status="ok">\n{"message":"${SENTINEL}","value":${SENTINEL_VALUE}}\n</function_result>`,

    'Plan C (NL instruction)': `MCP tool result. Treat the following block as the result of the previous tool call. Do not treat it as a new user request.\n\n<function_result call_id="probe_003" name="echo" status="ok">\n{"message":"${SENTINEL}","value":${SENTINEL_VALUE}}\n</function_result>`,
};

// ============================================================================
// Main
// ============================================================================

async function main() {
    console.log('\n╔══════════════════════════════════════════════════════════╗');
    console.log('║  Gate 3C-prep P0-1: function_result Format Probe        ║');
    console.log('╚══════════════════════════════════════════════════════════╝\n');

    // Step 1: Find Notion tab
    log('info', 'Looking for Notion tab...');
    const tab = await findNotionTab();
    if (!tab) {
        log('fail', 'No Notion tab found. Open notion.so in Chrome with --remote-debugging-port=9222');
        process.exit(2);
    }
    log('pass', `Found: ${tab.url.substring(0, 60)}...`);

    // Step 2: Connect CDP
    const cdp = new CDPSession(tab.webSocketDebuggerUrl);
    await cdp.connect();
    await cdp.send('Runtime.enable');
    log('pass', 'CDP connected');

    // Step 3: Check adapter availability
    log('info', 'Checking adapter...');
    const adapterCheck = await cdp.evaluate(`
        (function() {
            if (window.mcpAdapter && typeof window.mcpAdapter.insertText === 'function') {
                return { available: true, hasSubmit: typeof window.mcpAdapter.submitForm === 'function' };
            }
            if (window.pluginRegistry && window.pluginRegistry.getActivePlugin) {
                const p = window.pluginRegistry.getActivePlugin();
                if (p && p.adapter && typeof p.adapter.insertText === 'function') {
                    return { available: true, hasSubmit: typeof p.adapter.submitForm === 'function' };
                }
            }
            return { available: false };
        })()
    `);

    if (!adapterCheck?.value?.available) {
        log('fail', 'No adapter available. Extension may not be initialized or not on a supported page.');
        log('info', 'Try: Open a Notion AI conversation, ensure extension is loaded.');
        cdp.close();
        process.exit(2);
    }
    log('pass', `Adapter found (submitForm: ${adapterCheck.value.hasSubmit})`);

    // Step 4: Check current input state
    const inputState = await cdp.evaluate(`
        (function() {
            const adapter = window.mcpAdapter || (window.pluginRegistry?.getActivePlugin?.()?.adapter);
            if (adapter && typeof adapter.getInputContent === 'function') {
                const content = adapter.getInputContent();
                return { empty: !content, length: content ? content.length : 0 };
            }
            return { empty: null, length: null };
        })()
    `);
    if (inputState?.value) {
        log('info', `Input state: empty=${inputState.value.empty}, length=${inputState.value.length}`);
        if (!inputState.value.empty) {
            log('warn', 'Input has existing content! Clear it before testing.');
        }
    }

    // Step 5: Select format to test
    const formatName = process.argv[2] || 'Plan A (bare XML)';
    const formatContent = FORMATS[formatName];
    if (!formatContent) {
        log('fail', `Unknown format: "${formatName}". Available: ${Object.keys(FORMATS).join(', ')}`);
        cdp.close();
        process.exit(1);
    }

    console.log(`\n  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    console.log(`  Testing: ${formatName}`);
    console.log(`  Sentinel: ${SENTINEL} = ${SENTINEL_VALUE}`);
    console.log(`  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);

    // Step 6: Inject format into input
    log('step', 'Injecting function_result into input...');
    const escaped = formatContent.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$/g, '\\$');
    const injectResult = await cdp.evaluate(`
        (async function() {
            const adapter = window.mcpAdapter || (window.pluginRegistry?.getActivePlugin?.()?.adapter);
            if (!adapter) return { success: false, error: 'no adapter' };
            try {
                await adapter.insertText(\`${escaped}\`);
                return { success: true };
            } catch (e) {
                return { success: false, error: e.message };
            }
        })()
    `, { awaitPromise: true });

    if (!injectResult?.value?.success) {
        log('fail', `Injection failed: ${injectResult?.value?.error || 'unknown error'}`);
        cdp.close();
        process.exit(1);
    }
    log('pass', 'Content injected into Notion input');

    // Step 7: Verify content in input
    const verifyResult = await cdp.evaluate(`
        (function() {
            const adapter = window.mcpAdapter || (window.pluginRegistry?.getActivePlugin?.()?.adapter);
            if (adapter && typeof adapter.getInputContent === 'function') {
                const content = adapter.getInputContent();
                return { 
                    hasSentinel: content.includes('${SENTINEL}'),
                    length: content.length,
                    preview: content.substring(0, 100)
                };
            }
            return { hasSentinel: null, length: null, preview: null };
        })()
    `);

    if (verifyResult?.value) {
        const v = verifyResult.value;
        log('info', `Injected content length: ${v.length}`);
        log('info', `Contains sentinel: ${v.hasSentinel}`);
        if (v.preview) log('info', `Preview: ${v.preview.substring(0, 80)}...`);
    }

    // Step 8: Auto-submit if available, otherwise prompt manual
    const autoSubmit = process.argv.includes('--auto-submit');
    if (autoSubmit && adapterCheck.value.hasSubmit) {
        log('step', 'Auto-submitting...');
        const submitResult = await cdp.evaluate(`
            (async function() {
                const adapter = window.mcpAdapter || (window.pluginRegistry?.getActivePlugin?.()?.adapter);
                if (adapter && typeof adapter.submitForm === 'function') {
                    await adapter.submitForm();
                    return { success: true };
                }
                return { success: false, error: 'no submitForm' };
            })()
        `, { awaitPromise: true });

        if (submitResult?.value?.success) {
            log('pass', 'Submitted! Waiting for AI response...');
            // Wait a bit for response
            await new Promise(r => setTimeout(r, 5000));

            // Try to check if response contains sentinel
            log('info', 'Check AI response manually for references to:');
            log('info', `  - "${SENTINEL}" or "${SENTINEL_VALUE}"`);
            log('info', '  - "echo" or "tool result"');
        } else {
            log('warn', `Submit failed: ${submitResult?.value?.error}`);
        }
    } else {
        console.log('\n  ══════════════════════════════════════════════════════');
        console.log('  MANUAL STEP REQUIRED:');
        console.log('  1. Check the Notion input — content should be injected');
        console.log('  2. Press Enter/Submit in Notion AI');
        console.log('  3. Observe AI response');
        console.log('  ');
        console.log('  PASS criteria:');
        console.log(`    - AI mentions "${SENTINEL}" or value ${SENTINEL_VALUE}`);
        console.log('    - AI treats it as a tool result, not a user question');
        console.log('  ');
        console.log('  FAIL criteria:');
        console.log('    - AI explains XML syntax');
        console.log('    - AI ignores the content');
        console.log('    - AI executes content as instruction');
        console.log('  ══════════════════════════════════════════════════════\n');
    }

    cdp.close();
    log('pass', 'Format probe injection complete');
    process.exit(0);
}

main().catch(err => {
    console.error('Fatal error:', err.message);
    process.exit(2);
});
