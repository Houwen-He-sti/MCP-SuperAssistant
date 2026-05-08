/**
 * Gate 3A — Real Browser E2E Test
 *
 * Validates the FULL bridge activation + tool execution pipeline via CDP.
 * Unlike Gate 3B (which tests parameter validation at boundary), this tests:
 *   1. getStreamToolBridgeInfo() — preflight diagnostic
 *   2. configureStreamToolBridge() — activation
 *   3. Real stream_cutoff → callTool execution
 *   4. Duplicate dedup via executionGuard
 *   5. Config propagation to MAIN world
 *
 * Prerequisites:
 *   - Chrome running with: --remote-debugging-port=9222
 *   - MCP-SuperAssistant extension loaded from dist/ (pnpm build first)
 *   - A Notion page open (notion.so)
 *   - `ws` package available: npm install ws
 *
 * Usage:
 *   node scripts/e2e-gate3a-bridge.cjs
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
// CDP Session (same as gate3b script)
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

async function findExtensionContext(cdp) {
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

  await cdp.send('Runtime.disable');
  await cdp.send('Runtime.enable');
  await contextPromise;

  const mainPageCtx = contexts.find(c =>
    c.auxData?.type === 'default' &&
    c.origin && c.origin.includes('www.notion.so')
  );
  const mainFrameId = mainPageCtx?.auxData?.frameId;

  const mcpCtxs = contexts.filter(c =>
    c.origin && c.origin.includes('chrome-extension://') &&
    (c.name === 'MCP SuperAssistant' || c.name.includes('MCP')) &&
    (!mainFrameId || c.auxData?.frameId === mainFrameId)
  );

  // Probe for configureStreamToolBridge (handles stale contexts after reload)
  for (const ctx of mcpCtxs) {
    const result = await cdp.evaluate('typeof window.configureStreamToolBridge', { contextId: ctx.id });
    if (result?.value === 'function') return ctx.id;
  }

  if (mcpCtxs.length > 0) return mcpCtxs[0].id;
  return null;
}

// ============================================================================
// Main Test
// ============================================================================

async function main() {
  console.log('\n=== Gate 3A Real Browser E2E — Bridge Activation & Execution ===\n');

  const tab = await findNotionTab();
  if (!tab) {
    log('fail', 'No Notion tab found.');
    process.exit(2);
  }
  log('info', `Tab: ${tab.title.substring(0, 50)} (${tab.url.substring(0, 60)})`);

  const cdp = new CDPSession(tab.webSocketDebuggerUrl);
  await cdp.connect();
  await cdp.send('Runtime.enable');

  const extContextId = await findExtensionContext(cdp);
  if (!extContextId) {
    log('fail', 'Extension isolated world context not found.');
    cdp.close();
    process.exit(2);
  }
  log('info', `Extension context ID: ${extContextId}`);

  async function evalExt(expression, opts = {}) {
    return cdp.evaluate(expression, { ...opts, contextId: extContextId });
  }

  let passed = 0;
  let failed = 0;
  const total = 10;

  // ===== Test 1: Interceptor installed =====
  const interceptorCheck = await cdp.evaluate(
    'window.__MCP_SA_NOTION_STREAM_INTERCEPTOR_INSTALLED_V1__'
  );
  if (interceptorCheck?.value === true) {
    log('pass', '1. Stream interceptor installed (main world)');
    passed++;
  } else {
    log('fail', '1. Interceptor NOT installed.');
    cdp.close();
    process.exit(2);
  }

  // ===== Test 2: getStreamToolBridgeInfo — preflight =====
  const infoResult = await evalExt(`
    (function() {
      if (typeof window.getStreamToolBridgeInfo !== 'function') return 'NOT_AVAILABLE';
      return JSON.stringify(window.getStreamToolBridgeInfo());
    })()
  `);
  const infoStr = infoResult?.value;
  if (infoStr && infoStr !== 'NOT_AVAILABLE') {
    const info = JSON.parse(infoStr);
    if (info.bridgeHandlerReady && info.mcpClientAvailable) {
      log('pass', '2. getStreamToolBridgeInfo() reports deps ready');
      passed++;
    } else {
      log('fail', `2. Bridge deps not ready: ${JSON.stringify(info)}`);
      failed++;
    }
  } else {
    log('fail', '2. getStreamToolBridgeInfo not available on window');
    failed++;
  }

  // ===== Test 3: Setup mocks + configure bridge =====
  const setupResult = await evalExt(`
    (function() {
      window.__gate3a_toolCalls = [];
      window.__gate3a_events = [];

      window.__gate3a_origClient = window.mcpClient;
      window.mcpClient = {
        isReady: function() { return true; },
        callTool: async function(name, params) {
          window.__gate3a_toolCalls.push({ name, params });
          return { content: [{ type: 'text', text: JSON.stringify({ status: 'ok' }) }] };
        }
      };

      window.__gate3a_origAdapter = window.mcpAdapter;
      window.mcpAdapter = {
        insertText: async function(t) { window.__gate3a_events.push('insert:' + t); },
        submitForm: async function() { window.__gate3a_events.push('submit'); },
        getInputContent: function() { return ''; }
      };

      window.__gate3a_warns = [];
      window.__gate3a_origWarn = console.warn;
      console.warn = function() {
        var msg = Array.prototype.join.call(arguments, ' ');
        window.__gate3a_warns.push(msg);
        window.__gate3a_origWarn.apply(console, arguments);
      };

      if (typeof window.configureStreamToolBridge === 'function') {
        window.configureStreamToolBridge({ enabled: true, cutoffEnabled: true, autoInsert: false });
        return 'OK';
      }
      return 'ERROR: configureStreamToolBridge not found';
    })()
  `);
  if (setupResult?.value === 'OK') {
    log('pass', '3. Bridge configured (enabled=true, cutoffEnabled=true, autoInsert=false)');
    passed++;
  } else {
    log('fail', '3. Setup failed: ' + (setupResult?.value || 'unknown'));
    cdp.close();
    process.exit(2);
  }

  // Helper to send cutoff and check
  async function sendCutoffAndCheck(toolName, callId, args) {
    await evalExt(`
      window.__gate3a_toolCalls = [];
      window.__gate3a_warns = [];
      window.__gate3a_events = [];
    `);

    const argsStr = args === null ? 'null' : JSON.stringify(args);
    await cdp.evaluate(`
      window.postMessage({
        channel: 'mcp-superassistant.stream',
        direction: 'main-to-isolated',
        version: 1,
        source: 'notion-main-fetch-interceptor',
        event: {
          type: 'stream_cutoff',
          streamId: 'gate3a-e2e-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8),
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

    await new Promise(res => setTimeout(res, 300));

    const results = await evalExt(`
      JSON.stringify({
        toolCalls: window.__gate3a_toolCalls,
        warns: window.__gate3a_warns,
        events: window.__gate3a_events
      })
    `);
    return JSON.parse(results?.value || '{"toolCalls":[],"warns":[],"events":[]}');
  }

  // ===== Test 4: Basic execution — get_bridge_info(null) → callTool =====
  const t4 = await sendCutoffAndCheck('get_bridge_info', 'call_3a_basic_001', null);
  if (t4.toolCalls.length === 1 && t4.toolCalls[0].name === 'get_bridge_info') {
    log('pass', '4. stream_cutoff(get_bridge_info, args=null) → callTool executed');
    passed++;
  } else {
    log('fail', `4. Expected 1 callTool, got ${t4.toolCalls.length}: ${JSON.stringify(t4)}`);
    failed++;
  }

  // ===== Test 5: Params forwarded correctly =====
  const t5 = await sendCutoffAndCheck('echo', 'call_3a_params_001', '{"msg":"hello","n":42}');
  if (t5.toolCalls.length === 1 &&
      t5.toolCalls[0].name === 'echo' &&
      t5.toolCalls[0].params.msg === 'hello' &&
      t5.toolCalls[0].params.n === 42) {
    log('pass', '5. Params forwarded correctly: echo({msg:"hello", n:42})');
    passed++;
  } else {
    log('fail', `5. Params mismatch: ${JSON.stringify(t5.toolCalls)}`);
    failed++;
  }

  // ===== Test 6: Duplicate dedup — same callId blocked =====
  const t6 = await sendCutoffAndCheck('get_bridge_info', 'call_3a_basic_001', null);
  if (t6.toolCalls.length === 0) {
    log('pass', '6. Duplicate callId blocked by executionGuard');
    passed++;
  } else {
    log('fail', `6. Expected dedup but got ${t6.toolCalls.length} calls`);
    failed++;
  }

  // ===== Test 7: Different callId executes =====
  const t7 = await sendCutoffAndCheck('get_bridge_info', 'call_3a_second_001', null);
  if (t7.toolCalls.length === 1) {
    log('pass', '7. Different callId → new execution succeeds');
    passed++;
  } else {
    log('fail', `7. Expected 1 call with new callId, got ${t7.toolCalls.length}`);
    failed++;
  }

  // ===== Test 8: autoInsert=false — no adapter calls =====
  // Check that none of the above tests triggered insertText
  const adapterEvents = await evalExt(`
    JSON.stringify(window.__gate3a_events || [])
  `);
  const evts = JSON.parse(adapterEvents?.value || '[]');
  if (evts.length === 0) {
    log('pass', '8. autoInsert=false — adapter.insertText never called');
    passed++;
  } else {
    log('fail', `8. Expected 0 adapter events, got ${evts.length}: ${JSON.stringify(evts)}`);
    failed++;
  }

  // ===== Test 9: Config propagation — cutoff config posted to main world =====
  // Install a capture in main world for config messages
  await cdp.evaluate(`
    window.__gate3a_configMsgs = [];
    window.__gate3a_configListener = function(e) {
      if (e.source !== window) return;
      if (e.data && e.data.channel === 'mcp-superassistant.stream.config') {
        window.__gate3a_configMsgs.push(e.data);
      }
    };
    window.addEventListener('message', window.__gate3a_configListener);
  `);

  // Reconfigure to trigger a new config message
  await evalExt(`
    window.configureStreamToolBridge({ enabled: true, cutoffEnabled: false, autoInsert: false });
  `);
  await new Promise(res => setTimeout(res, 200));

  const configMsgs = await cdp.evaluate(`JSON.stringify(window.__gate3a_configMsgs)`);
  const configs = JSON.parse(configMsgs?.value || '[]');
  if (configs.length > 0 && configs[configs.length - 1].config.cutoffEnabled === false) {
    log('pass', '9. Config change propagated to main world (cutoffEnabled=false)');
    passed++;
  } else {
    log('fail', `9. No config message received in main world: ${JSON.stringify(configs)}`);
    failed++;
  }

  // Cleanup main world listener
  await cdp.evaluate(`
    window.removeEventListener('message', window.__gate3a_configListener);
    delete window.__gate3a_configMsgs;
    delete window.__gate3a_configListener;
  `);

  // ===== Test 10: Disable bridge — cutoff no longer triggers execution =====
  await evalExt(`
    window.configureStreamToolBridge({ enabled: false, cutoffEnabled: false, autoInsert: false });
  `);
  const t10 = await sendCutoffAndCheck('echo', 'call_3a_disabled_001', '{"x":1}');
  if (t10.toolCalls.length === 0) {
    log('pass', '10. Bridge disabled → stream_cutoff does NOT trigger execution');
    passed++;
  } else {
    log('fail', `10. Expected no calls when disabled, got ${t10.toolCalls.length}`);
    failed++;
  }

  // ===== Cleanup =====
  await evalExt(`
    if (window.__gate3a_origClient) window.mcpClient = window.__gate3a_origClient;
    if (window.__gate3a_origAdapter) window.mcpAdapter = window.__gate3a_origAdapter;
    if (window.__gate3a_origWarn) console.warn = window.__gate3a_origWarn;
    if (typeof window.configureStreamToolBridge === 'function') {
      window.configureStreamToolBridge({ enabled: false, cutoffEnabled: false });
    }
    delete window.__gate3a_toolCalls;
    delete window.__gate3a_events;
    delete window.__gate3a_warns;
    delete window.__gate3a_origClient;
    delete window.__gate3a_origAdapter;
    delete window.__gate3a_origWarn;
  `);

  cdp.close();

  // ===== Summary =====
  console.log('\n' + '─'.repeat(50));
  console.log(`  Results: ${passed}/${total} passed, ${failed} failed`);
  if (failed === 0) {
    console.log('\n  ✅ Gate 3A bridge activation & execution verified in real browser!\n');
  } else {
    console.log('\n  ❌ Some tests failed.\n');
  }
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(e => {
  console.error('Fatal:', e.message);
  process.exit(2);
});
