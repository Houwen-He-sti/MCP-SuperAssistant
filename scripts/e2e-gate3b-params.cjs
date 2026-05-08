/**
 * Gate 3B — Real Browser E2E Test
 *
 * Validates parameter validation in the REAL extension via CDP.
 * Tests both valid and invalid arguments through the full pipeline.
 *
 * Prerequisites:
 *   - Chrome running with: --remote-debugging-port=9222
 *   - MCP-SuperAssistant extension loaded from dist/ (pnpm build first)
 *   - A Notion page open (notion.so)
 *   - `ws` package available: npm install ws
 *
 * Usage:
 *   node scripts/e2e-gate3b-params.cjs
 *
 * What it tests (in the extension's MAIN world via postMessage):
 *   1. Bridge is operational (interceptor installed, config accessible)
 *   2. configureStreamToolBridge({ enabled: true, cutoffEnabled: true })
 *   3. stream_cutoff with valid params → callTool receives correct params
 *   4. stream_cutoff with '[]' → ARGS_NOT_OBJECT rejection
 *   5. stream_cutoff with '123' → ARGS_NOT_OBJECT rejection
 *   6. stream_cutoff with oversized → ARGS_TOO_LARGE rejection
 *   7. stream_cutoff with malformed JSON → PARSE_ERROR rejection
 *   8. stream_cutoff with null args → callTool receives {}
 *   9. stream_cutoff with '"hello"' (JSON string) → ARGS_NOT_OBJECT
 *  10. stream_cutoff with 'null' (JSON null string) → ARGS_NOT_OBJECT
 *  11. args at exactly MAX_ARGS_SIZE (65536) → accepted
 *  12. args at MAX_ARGS_SIZE + 1 (65537) → ARGS_TOO_LARGE
 *  13. nested object + inner array → params preserved
 *
 * Exit codes:
 *   0 = all tests passed
 *   1 = test failure
 *   2 = infrastructure error (no Chrome, no tab, no extension)
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
    const prefix = { info: '●', pass: '✅', fail: '❌', warn: '⚠' };
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
// Test Suite
// ============================================================================

async function findExtensionContext(cdp) {
    // The extension content script runs in an isolated world.
    // We need to find its execution context ID on the MAIN page frame (www.notion.so).
    // There may be multiple MCP SuperAssistant contexts (stale + fresh after reload).

    const contexts = [];
    const contextPromise = new Promise((resolve) => {
        const collectContexts = (data) => {
            const msg = JSON.parse(data);
            if (msg.method === 'Runtime.executionContextCreated') {
                contexts.push(msg.params.context);
            }
        };
        cdp.ws.on('message', collectContexts);
        setTimeout(() => {
            cdp.ws.removeListener('message', collectContexts);
            resolve(contexts);
        }, 2000);
    });

    // Disable + re-enable Runtime to trigger fresh context notifications
    await cdp.send('Runtime.disable');
    await cdp.send('Runtime.enable');
    await contextPromise;

    // Find the main page frame (www.notion.so default context)
    const mainPageCtx = contexts.find(c =>
        c.auxData?.type === 'default' &&
        c.origin && c.origin.includes('www.notion.so')
    );
    const mainFrameId = mainPageCtx?.auxData?.frameId;

    // Find all MCP SuperAssistant contexts on the main frame
    const mcpCtxs = contexts.filter(c =>
        c.origin && c.origin.includes('chrome-extension://') &&
        (c.name === 'MCP SuperAssistant' || c.name.includes('MCP')) &&
        (!mainFrameId || c.auxData?.frameId === mainFrameId)
    );

    // When multiple MCP contexts exist (after extension reload), find the one with configureStreamToolBridge
    for (const ctx of mcpCtxs) {
        const result = await cdp.evaluate('typeof window.configureStreamToolBridge', { contextId: ctx.id });
        if (result?.value === 'function') return ctx.id;
    }

    // Fallback: return first MCP context on main frame
    if (mcpCtxs.length > 0) return mcpCtxs[0].id;

    // Last fallback: any extension context
    const extCtxs = contexts.filter(c => c.origin && c.origin.includes('chrome-extension://'));
    if (extCtxs.length > 0) return extCtxs[0].id;
    return null;
}

async function main() {
    console.log('\n=== Gate 3B Real Browser E2E — Parameter Validation ===\n');

    // --- Find Notion tab ---
    const tab = await findNotionTab();
    if (!tab) {
        log('fail', 'No Notion tab found. Open a Notion page in Chrome (--remote-debugging-port=9222)');
        process.exit(2);
    }
    log('info', `Tab: ${tab.title.substring(0, 50)} (${tab.url.substring(0, 60)})`);

    const cdp = new CDPSession(tab.webSocketDebuggerUrl);
    await cdp.connect();
    await cdp.send('Runtime.enable');

    // Find extension's isolated world context
    const extContextId = await findExtensionContext(cdp);
    if (!extContextId) {
        log('fail', 'Extension isolated world context not found.');
        log('info', '   Reload extension + refresh Notion tab.');
        cdp.close();
        process.exit(2);
    }
    log('info', `Extension context ID: ${extContextId}`);

    // Helper to evaluate in the extension's isolated world
    async function evalExt(expression, opts = {}) {
        return cdp.evaluate(expression, { ...opts, contextId: extContextId });
    }

    let passed = 0;
    let failed = 0;
  const total = 13;
    // Interceptor flag is in MAIN world (it's the fetch wrapper)
    const interceptorCheck = await cdp.evaluate(
        'window.__MCP_SA_NOTION_STREAM_INTERCEPTOR_INSTALLED_V1__'
    );
    if (interceptorCheck?.value === true) {
        log('pass', '1. Stream interceptor installed (main world)');
        passed++;
    } else {
        log('fail', '1. Interceptor NOT installed. Build + reload extension first.');
        log('info', '   Run: pnpm clean:bundle && pnpm exec turbo build');
        log('info', '   Then reload the extension and refresh the Notion tab.');
        cdp.close();
        process.exit(2);
    }

    // ===== Test 2: Setup — mock mcpClient + enable bridge in ISOLATED world =====
    const setupResult = await evalExt(`
    (function() {
      // Capture tool calls and bridge events
      window.__gate3b_toolCalls = [];
      window.__gate3b_events = [];

      // Mock mcpClient in isolated world
      window.__gate3b_origClient = window.mcpClient;
      window.mcpClient = {
        isReady: function() { return true; },
        callTool: async function(name, params) {
          window.__gate3b_toolCalls.push({ name, params });
          return { content: [{ type: 'text', text: JSON.stringify({ echo: params }) }] };
        }
      };

      // Mock adapter (autoInsert=false, should not be called)
      window.__gate3b_origAdapter = window.mcpAdapter;
      window.mcpAdapter = {
        insertText: async function(t) { window.__gate3b_events.push('insertText:' + t); },
        submitForm: async function() { window.__gate3b_events.push('submitForm'); },
        getInputContent: function() { return ''; }
      };

      // Capture console.warn for error code verification
      window.__gate3b_warns = [];
      window.__gate3b_origWarn = console.warn;
      console.warn = function() {
        var msg = Array.prototype.join.call(arguments, ' ');
        window.__gate3b_warns.push(msg);
        window.__gate3b_origWarn.apply(console, arguments);
      };

      // Enable bridge with cutoff
      if (typeof window.configureStreamToolBridge === 'function') {
        window.configureStreamToolBridge({ enabled: true, cutoffEnabled: true, autoInsert: false });
        return 'OK';
      } else {
        return 'ERROR: configureStreamToolBridge not found on window (isolated world)';
      }
    })()
  `);
    if (setupResult?.value === 'OK') {
        log('pass', '2. Bridge enabled + mocks installed');
        passed++;
    } else {
        log('fail', '2. Setup failed: ' + (setupResult?.value || setupResult?.__exception && setupResult.description || 'unknown'));
        cdp.close();
        process.exit(2);
    }

    // Helper: send a stream_cutoff event via postMessage and check result
    async function sendCutoffAndCheck(testName, toolName, callId, args, expectation) {
        // Clear captures in ISOLATED world
        await evalExt(`
      window.__gate3b_toolCalls = [];
      window.__gate3b_warns = [];
    `);

        // Send the stream_cutoff postMessage from MAIN world
        // (simulating MAIN world interceptor posting to isolated world)
        const argsStr = args === null ? 'null' : JSON.stringify(args);
        await cdp.evaluate(`
      window.postMessage({
        channel: 'mcp-superassistant.stream',
        direction: 'main-to-isolated',
        version: 1,
        source: 'notion-main-fetch-interceptor',
        event: {
          type: 'stream_cutoff',
          streamId: 'gate3b-e2e-' + Date.now(),
          cutoffChunkIndex: 5,
          elapsedMs: 1000,
          identity: {
            name: ${JSON.stringify(toolName)},
            callId: ${JSON.stringify(callId)},
            arguments: ${argsStr}
          },
          reason: 'function_call_detected',
          forwardedTriggerChunk: true,
          mode: 'drain-drop'
        }
      }, '*');
    `);

        // Wait for async processing (message goes main→isolated→bridge handler)
        await new Promise(res => setTimeout(res, 300));

        // Read results from ISOLATED world
        const results = await evalExt(`
      JSON.stringify({
        toolCalls: window.__gate3b_toolCalls,
        warns: window.__gate3b_warns
      })
    `);

        const data = JSON.parse(results?.value || '{"toolCalls":[],"warns":[]}');

        if (expectation.type === 'success') {
            if (data.toolCalls.length === 1 &&
                data.toolCalls[0].name === toolName &&
                JSON.stringify(data.toolCalls[0].params) === JSON.stringify(expectation.expectedParams)) {
                log('pass', testName);
                return true;
            } else {
                log('fail', testName);
                log('info', `   Expected: callTool(${toolName}, ${JSON.stringify(expectation.expectedParams)})`);
                log('info', `   Got: ${JSON.stringify(data.toolCalls)}`);
                return false;
            }
        } else if (expectation.type === 'rejection') {
            if (data.toolCalls.length === 0 && data.warns.some(w => w.includes(expectation.errorCode))) {
                log('pass', testName);
                return true;
            } else {
                log('fail', testName);
                log('info', `   Expected: no toolCalls + ${expectation.errorCode} in warns`);
                log('info', `   Got: toolCalls=${data.toolCalls.length}, warns=${JSON.stringify(data.warns)}`);
                return false;
            }
        }
        return false;
    }

    // Each test uses a unique callId, so no dedup issues.
    // No need to clear guard between tests.

    // ===== Test 3: Valid params — echo({"message":"hello"}) =====
    if (await sendCutoffAndCheck(
        '3. echo({"message":"hello"}) → callTool receives correct params',
        'echo', 'call_echo_3b_001', '{"message":"hello"}',
        { type: 'success', expectedParams: { message: 'hello' } }
    )) passed++; else failed++;

    // ===== Test 4: Invalid — arguments='[]' → ARGS_NOT_OBJECT =====
    if (await sendCutoffAndCheck(
        '4. arguments="[]" → ARGS_NOT_OBJECT rejection',
        'echo', 'call_arr_3b_001', '[]',
        { type: 'rejection', errorCode: 'ARGS_NOT_OBJECT' }
    )) passed++; else failed++;

    // ===== Test 5: Invalid — arguments='123' → ARGS_NOT_OBJECT =====
    if (await sendCutoffAndCheck(
        '5. arguments="123" → ARGS_NOT_OBJECT rejection',
        'echo', 'call_num_3b_001', '123',
        { type: 'rejection', errorCode: 'ARGS_NOT_OBJECT' }
    )) passed++; else failed++;

    // ===== Test 6: Invalid — oversized → ARGS_TOO_LARGE =====
    const oversized = '{"x":"' + 'A'.repeat(70000) + '"}';
    if (await sendCutoffAndCheck(
        '6. oversized args (>64KB) → ARGS_TOO_LARGE rejection',
        'echo', 'call_big_3b_001', oversized,
        { type: 'rejection', errorCode: 'ARGS_TOO_LARGE' }
    )) passed++; else failed++;

    // ===== Test 7: Invalid — malformed JSON → PARSE_ERROR =====
    if (await sendCutoffAndCheck(
        '7. malformed JSON → PARSE_ERROR rejection',
        'echo', 'call_bad_3b_001', '{invalid json',
        { type: 'rejection', errorCode: 'PARSE_ERROR' }
    )) passed++; else failed++;

    // ===== Test 8: null args → callTool receives {} =====
    if (await sendCutoffAndCheck(
        '8. arguments=null → callTool receives {}',
        'get_info', 'call_null_3b_001', null,
        { type: 'success', expectedParams: {} }
    )) passed++; else failed++;
  // ===== Test 9: arguments='"hello"' (JSON string) → ARGS_NOT_OBJECT =====
  if (await sendCutoffAndCheck(
      '9. arguments=\'"hello"\' (JSON string) → ARGS_NOT_OBJECT rejection',
      'echo', 'call_str_3b_001', '"hello"',
      { type: 'rejection', errorCode: 'ARGS_NOT_OBJECT' }
  )) passed++; else failed++;

  // ===== Test 10: arguments='null' (JSON null literal string) → ARGS_NOT_OBJECT =====
  if (await sendCutoffAndCheck(
      '10. arguments=\'null\' (JSON null string) → ARGS_NOT_OBJECT rejection',
      'echo', 'call_nullstr_3b_001', 'null',
      { type: 'rejection', errorCode: 'ARGS_NOT_OBJECT' }
  )) passed++; else failed++;

  // ===== Test 11: arguments at MAX_ARGS_SIZE boundary (65536) → accepted =====
  const overhead = '{"x":"'.length + '"}'.length; // 8
  const boundaryArgs = '{"x":"' + 'A'.repeat(65536 - overhead) + '"}';
  if (await sendCutoffAndCheck(
      '11. args at MAX_ARGS_SIZE (65536 chars) → accepted',
      'echo', 'call_boundary_3b_001', boundaryArgs,
      { type: 'success', expectedParams: { x: 'A'.repeat(65536 - overhead) } }
  )) passed++; else failed++;

  // ===== Test 12: arguments at MAX_ARGS_SIZE + 1 → ARGS_TOO_LARGE =====
  const overBoundaryArgs = '{"x":"' + 'A'.repeat(65536 - overhead + 1) + '"}';
  if (await sendCutoffAndCheck(
      '12. args at MAX_ARGS_SIZE+1 (65537 chars) → ARGS_TOO_LARGE rejection',
      'echo', 'call_over_3b_001', overBoundaryArgs,
      { type: 'rejection', errorCode: 'ARGS_TOO_LARGE' }
  )) passed++; else failed++;

  // ===== Test 13: nested object with inner array → preserved =====
  const nestedArgs = JSON.stringify({ query: 'test', opts: { limit: 5 }, tags: ['a', 'b'] });
  if (await sendCutoffAndCheck(
      '13. nested object + inner array → params preserved',
      'search', 'call_nested_3b_001', nestedArgs,
      { type: 'success', expectedParams: { query: 'test', opts: { limit: 5 }, tags: ['a', 'b'] } }
  )) passed++; else failed++;
    // ===== Cleanup =====
    await evalExt(`
    // Restore originals
    if (window.__gate3b_origClient) window.mcpClient = window.__gate3b_origClient;
    if (window.__gate3b_origAdapter) window.mcpAdapter = window.__gate3b_origAdapter;
    if (window.__gate3b_origWarn) console.warn = window.__gate3b_origWarn;
    // Disable bridge
    if (typeof window.configureStreamToolBridge === 'function') {
      window.configureStreamToolBridge({ enabled: false, cutoffEnabled: false });
    }
    // Clean up test globals
    delete window.__gate3b_toolCalls;
    delete window.__gate3b_events;
    delete window.__gate3b_warns;
    delete window.__gate3b_origClient;
    delete window.__gate3b_origAdapter;
    delete window.__gate3b_origWarn;
  `);

    cdp.close();

    // ===== Summary =====
    console.log('\n' + '─'.repeat(50));
    console.log(`  Results: ${passed}/${total} passed, ${failed} failed`);
    if (failed === 0) {
        console.log('\n  ✅ Gate 3B parameter validation verified in real browser!\n');
    } else {
        console.log('\n  ❌ Some tests failed. Check extension build and reload.\n');
    }
    process.exit(failed > 0 ? 1 : 0);
}

main().catch(e => {
    console.error('Fatal:', e.message);
    process.exit(2);
});
