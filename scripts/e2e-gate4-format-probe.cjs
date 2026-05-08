/**
 * Gate 4 P0-1a: Format Compatibility Probe
 * Classification: PROBE / DEBUG HELPER — not a production-path test.
 *
 * Tests whether Notion AI can consume different function_result formats.
 * Injects format candidates directly via CDP adapter (not through production bridge).
 * This is a semi-automated test: the script injects result text and submits,
 * then waits for AI to respond. Human verifies consumption in browser.
 *
 * Candidate formats:
 *   A: Current bare XML (already verified in Gate 3C-prep) — baseline
 *   B: Protocol spec wrapper with CDATA
 *   C: Bare XML + NL preamble
 *
 * Prerequisites:
 *   - Chrome running with: --remote-debugging-port=9222
 *   - MCP-SuperAssistant extension loaded from dist/
 *   - A Notion AI agent page open with an active conversation
 *   - The AI should have just output a function_call (or user manually prompts)
 *   - `ws` package available
 *
 * Usage:
 *   node scripts/e2e-gate4-format-probe.cjs [A|B|C]
 *
 *   If no format specified, probes all three sequentially with pauses.
 *
 * Exit codes:
 *   0 = injection completed (check browser for AI response)
 *   1 = infrastructure error
 */

const WebSocket = require('ws');

const CDP_PORT = 9222;
const CDP_URL = `http://localhost:${CDP_PORT}/json`;
const TIMEOUT_MS = 10_000;

// ============================================================================
// Candidate Formats
// ============================================================================

function generateSentinel() {
    return `sentinel_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
}

function formatA(sentinel) {
    // Current bare XML (Gate 3C-prep verified)
    return `<function_result call_id="probe_1" name="echo" status="ok">\n{"message":"${sentinel}"}\n</function_result>`;
}

function formatB(sentinel) {
    // Protocol spec: <function_results> wrapper + CDATA
    return `<function_results>\n  <result call_id="probe_1" name="echo" status="success">\n    <content type="application/json"><![CDATA[\n{"message":"${sentinel}"}\n    ]]></content>\n  </result>\n</function_results>`;
}

function formatC(sentinel) {
    // Bare XML + NL preamble
    return `MCP tool result for the previous function call. Continue using this result.\nDo not call the same function again unless the result is insufficient.\n\n<function_result call_id="probe_1" name="echo" status="ok">\n{"message":"${sentinel}"}\n</function_result>`;
}

const FORMATS = { A: formatA, B: formatB, C: formatC };

// ============================================================================
// CDP Session (reused from gate3c)
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

    close() {
        if (this.ws) this.ws.close();
    }
}

// ============================================================================
// Helpers
// ============================================================================

function log(level, ...args) {
    const prefix = { info: '●', pass: '✅', fail: '❌', warn: '⚠', step: '→', probe: '🔬' };
    console.log(`  ${prefix[level] || '·'} ${args.join(' ')}`);
}

async function findNotionTab() {
    const resp = await fetch(CDP_URL);
    const tabs = await resp.json();
    const notionTabs = tabs.filter(t =>
        t.type === 'page' && t.url && t.url.includes('notion.so')
    );
    return notionTabs.find(t => t.url && t.url.includes('/agent/')) || notionTabs[0];
}

// ============================================================================
// Probe: Inject format into Notion input and submit
// ============================================================================

async function probeFormat(cdp, formatKey, formatFn) {
    const sentinel = generateSentinel();

    console.log(`\n━━━ Probe Format ${formatKey} ━━━`);
    log('info', `Sentinel: ${sentinel}`);

    const formatted = formatFn(sentinel);
    log('info', `Format preview (first 200 chars):\n    ${formatted.slice(0, 200).replace(/\n/g, '\n    ')}`);

    // 1. Clear input
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

    // 2. Insert formatted result
    log('step', 'Inserting formatted result into input...');
    const escapedFormatted = JSON.stringify(formatted);
    const insertResult = await cdp.evaluate(`
    (async function() {
      const text = ${escapedFormatted};
      // Try adapter first
      let adapter = null;
      const reg = window.pluginRegistry;
      if (reg && reg.getActivePlugin) {
        const plugin = reg.getActivePlugin();
        if (plugin && plugin.adapter) adapter = plugin.adapter;
      }
      if (!adapter && window.mcpAdapter) adapter = window.mcpAdapter;

      if (adapter && typeof adapter.insertText === 'function') {
        try {
          const ok = await adapter.insertText(text);
          return { method: 'adapter', ok: ok !== false };
        } catch (e) {
          // insertText may throw after writing to DOM (known issue)
          return { method: 'adapter', ok: true, threw: e.message };
        }
      }

      // Fallback: direct DOM
      const sel = 'div[role="textbox"][contenteditable="true"], div.content-editable-leaf-rtl[contenteditable="true"]';
      const el = document.querySelector(sel);
      if (el) {
        el.focus();
        document.execCommand('insertText', false, text);
        return { method: 'execCommand', ok: true };
      }
      return { method: 'none', ok: false, error: 'No input element found' };
    })()
  `, { awaitPromise: true });

    log('info', `Insert result: ${JSON.stringify(insertResult?.value)}`);

    if (insertResult?.value?.error) {
        log('fail', `Format ${formatKey}: Failed to insert text — ${insertResult.value.error}`);
        return { format: formatKey, sentinel, injected: false };
    }

    // 3. Verify input content
    const inputContent = await cdp.evaluate(`
    (function() {
      const sel = 'div[role="textbox"][contenteditable="true"], div.content-editable-leaf-rtl[contenteditable="true"]';
      const el = document.querySelector(sel);
      if (!el) return null;
      return el.textContent || '';
    })()
  `);

    const contentPreview = (inputContent?.value || '').slice(0, 100);
    log('info', `Input content preview: ${contentPreview}`);

    const hasSentinel = (inputContent?.value || '').includes(sentinel);
    if (hasSentinel) {
        log('pass', `Format ${formatKey}: Sentinel found in input`);
    } else {
        log('warn', `Format ${formatKey}: Sentinel NOT found in input (may have been sanitized)`);
    }

    // 4. DO NOT auto-submit — human reviews and submits manually
    log('probe', `Format ${formatKey} injected. Sentinel: ${sentinel}`);
    log('probe', 'MANUAL STEP: Review input in browser, then click Submit.');
    log('probe', 'After AI responds, check if AI references the sentinel value.');
    log('probe', `Expected: AI reply should contain "${sentinel}" or reference the echo result.`);

    return { format: formatKey, sentinel, injected: true };
}

// ============================================================================
// Main
// ============================================================================

async function main() {
    const arg = process.argv[2]?.toUpperCase();
    const formatKeys = arg && FORMATS[arg] ? [arg] : ['A', 'B', 'C'];

    console.log('━━━ Gate 4 P0-1a: Format Compatibility Probe ━━━');
    console.log(`  Formats to probe: ${formatKeys.join(', ')}`);

    let cdp;
    try {
        // Find Notion tab
        const tab = await findNotionTab();
        if (!tab) {
            log('fail', 'No Notion tab found. Open notion.so/agent/ in Chrome with --remote-debugging-port=9222');
            process.exit(1);
        }
        log('info', `Found Notion tab: ${tab.url.slice(0, 60)}...`);

        // Connect CDP
        cdp = new CDPSession(tab.webSocketDebuggerUrl);
        await cdp.connect();
        await cdp.send('Runtime.enable');
        await cdp.findIsolatedContext();

        if (!cdp.isolatedCtxId) {
            log('warn', 'No ISOLATED world found. Using MAIN world (adapter may not be available).');
        } else {
            log('pass', `ISOLATED world found: contextId=${cdp.isolatedCtxId}`);
        }

        // Probe each format
        const probeResults = [];
        for (const key of formatKeys) {
            const result = await probeFormat(cdp, key, FORMATS[key]);
            probeResults.push(result);

            // If probing multiple formats, pause between them
            if (formatKeys.length > 1 && key !== formatKeys[formatKeys.length - 1]) {
                console.log(`\n  ⏸  Pausing 5s before next format. Submit current one manually now.`);
                await new Promise(r => setTimeout(r, 5000));
            }
        }

        // Summary
        console.log('\n━━━ PROBE SUMMARY ━━━');
        for (const r of probeResults) {
            console.log(`  Format ${r.format}: injected=${r.injected}, sentinel=${r.sentinel}`);
        }
        console.log('\n  After all formats are submitted and AI responds:');
        console.log('  Record which sentinels appeared in AI responses.');
        console.log('  This determines the format for P0-1b.');

    } catch (err) {
        log('fail', `Infrastructure error: ${err.message}`);
        process.exit(1);
    } finally {
        if (cdp) cdp.close();
    }
}

main();
