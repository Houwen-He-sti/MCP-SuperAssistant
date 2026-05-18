/**
 * MCP-SuperAssistant Stream Interceptor — E2E Gate 2 Verification
 *
 * Verifies the full stream interception pipeline:
 *   1. Extension loaded → interceptor installed → fetch wrapped
 *   2. Notion AI request → stream_start emitted
 *   3. function_call detected in NDJSON stream → function_call event
 *   4. (Optional) stream_cutoff triggered → stream_end → drain_complete
 *
 * Prerequisites:
 *   - Chrome running with: --remote-debugging-port=9222
 *   - MCP-SuperAssistant extension loaded from dist/ (pnpm build first)
 *   - A Notion AI agent tab open (notion.so/agent/* or notion.so/chat*)
 *   - `ws` package available: npm install ws (or run from project root)
 *
 * Usage:
 *   node scripts/e2e-stream-interceptor.js [--cutoff-test]
 *
 * Flags:
 *   --cutoff-test   Also verify stream_cutoff by temporarily disabling identity gate
 *
 * Exit codes:
 *   0 = all tests passed
 *   1 = test failure
 *   2 = infrastructure error (no Chrome, no tab, no extension)
 */

const WebSocket = require('ws');

// ============================================================================
// Configuration
// ============================================================================

const CDP_PORT = 9222;
const CDP_URL = `http://localhost:${CDP_PORT}/json`;
const TIMEOUT_MS = 60_000;
const POLL_INTERVAL_MS = 2000;
const STABILITY_THRESHOLD = 3; // consecutive stable polls = done

// ============================================================================
// CDP Helper
// ============================================================================

class CDPSession {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.ws = null;
    this.msgId = 0;
    this.listeners = new Map();
    this.eventHandlers = [];
  }

  async connect() {
    this.ws = new WebSocket(this.wsUrl);
    await new Promise((resolve, reject) => {
      this.ws.on('open', resolve);
      this.ws.on('error', reject);
    });
    this.ws.on('message', (data) => this._onMessage(JSON.parse(data)));
  }

  _onMessage(msg) {
    if (msg.id && this.listeners.has(msg.id)) {
      this.listeners.get(msg.id)(msg);
      this.listeners.delete(msg.id);
    }
    if (msg.method) {
      for (const handler of this.eventHandlers) {
        handler(msg);
      }
    }
  }

  onEvent(handler) {
    this.eventHandlers.push(handler);
    return () => {
      this.eventHandlers = this.eventHandlers.filter(h => h !== handler);
    };
  }

  send(method, params = {}) {
    return new Promise((resolve) => {
      const id = ++this.msgId;
      this.listeners.set(id, resolve);
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate(expression, opts = {}) {
    const result = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: opts.awaitPromise || false,
      ...opts,
    });
    return result.result?.result;
  }

  close() {
    if (this.ws) this.ws.close();
  }
}

// ============================================================================
// Helpers
// ============================================================================

// The Notion AI chat page URL (current route after PR #49 deprecated /agent)
const NOTION_CHAT_URL = process.env.NOTION_CHAT_URL || 'https://www.notion.so/chat';
// Deprecated: NOTION_AGENT_URL alias kept for backward compat only
const NOTION_AGENT_URL = NOTION_CHAT_URL;

async function findNotionTab() {
  const resp = await fetch(CDP_URL);
  const tabs = await resp.json();
  // Prefer an existing /chat tab with interceptor installed (current route; /agent was deprecated by PR #49)
  const chatTabs = tabs.filter(t => t.url && t.url.includes('notion.so/chat') && !t.url.includes('_assets'));

  // Check each /chat candidate for interceptor install to find the best one
  for (const tab of chatTabs) {
    try {
      const ws = new WebSocket(tab.webSocketDebuggerUrl);
      await new Promise((resolve, reject) => {
        ws.on('open', resolve);
        ws.on('error', reject);
      });
      const checkMsg = JSON.stringify({
        id: 1, method: 'Runtime.evaluate', params: {
          expression: 'window.__MCP_SA_NOTION_STREAM_INTERCEPTOR_INSTALLED_V1__',
          returnByValue: true,
        }
      });
      ws.send(checkMsg);
      const result = await new Promise(resolve => {
        ws.on('message', (data) => {
          const msg = JSON.parse(data);
          if (msg.id === 1) resolve(msg);
        });
      });
      ws.close();
      if (result.result?.result?.value === true) return tab;
    } catch { /* skip */ }
  }

  // Fallback: return first /chat tab (even without interceptor — verifyInterceptorInstalled() will check)
  return chatTabs[0] || null;
}

function log(level, ...args) {
  const prefix = { info: '●', pass: '✓', fail: '✗', warn: '⚠' };
  console.log(`${prefix[level] || '·'} ${args.join(' ')}`);
}

// ============================================================================
// Test Steps
// ============================================================================

async function verifyInterceptorInstalled(cdp) {
  const installed = await cdp.evaluate('window.__MCP_SA_NOTION_STREAM_INTERCEPTOR_INSTALLED_V1__');
  if (installed?.value !== true) {
    throw new Error('Interceptor not installed. Is the extension loaded and tab reloaded?');
  }

  // Verify fetch is our wrapped version (check toString for our code patterns)
  // Minified code contains: instanceof URL, new URL, .location.href, .origin, .pathname
  const fetchStr = await cdp.evaluate('window.fetch.toString().substring(0, 300)');
  const str = fetchStr?.value || '';
  const isWrapped = str.includes('instanceof URL') && str.includes('new URL') && str.includes('location.href');
  if (!isWrapped) {
    throw new Error('Fetch does not appear to be wrapped by our interceptor. Got: ' + str.substring(0, 80));
  }

  return true;
}

async function installEventCapture(cdp) {
  await cdp.evaluate(`
    window.__mcpSaStreamEvents = [];
    if (window.__mcpSaEventListener) window.removeEventListener('message', window.__mcpSaEventListener);
    window.__mcpSaEventListener = function(e) {
      if (e.source !== window) return;
      if (!e.data || typeof e.data !== 'object') return;
      if (e.data.channel === 'mcp-superassistant.stream' && e.data.direction === 'main-to-isolated') {
        window.__mcpSaStreamEvents.push({
          ts: Date.now(),
          type: e.data.event.type,
          streamId: e.data.event.streamId,
          detail: e.data.event
        });
      }
    };
    window.addEventListener('message', window.__mcpSaEventListener);
  `);
}

async function sendNotionMessage(cdp, message) {
  // Focus and clear the input
  const focusResult = await cdp.evaluate(`
    (function() {
      const input = document.querySelector('div[contenteditable="true"]');
      if (!input) return 'ERROR: no input element found';
      input.focus();
      // Clear existing content via selection
      const sel = window.getSelection();
      sel.selectAllChildren(input);
      if (input.textContent) document.execCommand('delete');
      return 'OK';
    })()
  `);
  if (focusResult?.value?.startsWith('ERROR')) {
    throw new Error(focusResult.value);
  }

  await new Promise(res => setTimeout(res, 200));

  // Insert text via execCommand (triggers React's synthetic events)
  const typeResult = await cdp.evaluate(`
    (function() {
      const input = document.querySelector('div[contenteditable="true"]');
      if (!input) return 'ERROR: input lost focus';
      input.focus();
      document.execCommand('insertText', false, ${JSON.stringify(message)});
      // Dispatch input event to ensure React picks it up
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return 'typed:' + input.textContent.substring(0, 30);
    })()
  `);
  if (typeResult?.value?.startsWith('ERROR')) {
    throw new Error(typeResult.value);
  }

  // Wait for React state to update and enable submit button
  await new Promise(res => setTimeout(res, 800));

  // Click submit (with retry if still disabled)
  for (let attempt = 0; attempt < 3; attempt++) {
    const submitResult = await cdp.evaluate(`
      (function() {
        const btn = document.querySelector('[aria-label="提交 AI 消息"]') ||
                    document.querySelector('[aria-label="Submit AI message"]');
        if (!btn) return 'ERROR: submit button not found';
        if (btn.getAttribute('aria-disabled') === 'true') return 'DISABLED';
        btn.click();
        return 'OK';
      })()
    `);

    if (submitResult?.value === 'OK') return;
    if (submitResult?.value?.startsWith('ERROR')) throw new Error(submitResult.value);

    // If disabled, wait and retry
    await new Promise(res => setTimeout(res, 500));
  }

  // Final attempt: force dispatch Enter key on input
  await cdp.send('Input.dispatchKeyEvent', {
    type: 'keyDown', key: 'Enter', code: 'Enter',
    windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13,
  });
  await cdp.send('Input.dispatchKeyEvent', {
    type: 'keyUp', key: 'Enter', code: 'Enter',
    windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13,
  });
}

async function waitForEvents(cdp, minExpected = 2) {
  const startTime = Date.now();
  let lastCount = 0;
  let stableCount = 0;

  while (Date.now() - startTime < TIMEOUT_MS) {
    await new Promise(res => setTimeout(res, POLL_INTERVAL_MS));
    const countResult = await cdp.evaluate('window.__mcpSaStreamEvents.length');
    const count = countResult?.value || 0;

    if (count >= minExpected && count === lastCount) {
      stableCount++;
      if (stableCount >= STABILITY_THRESHOLD) break;
    } else {
      stableCount = 0;
    }
    lastCount = count;
  }

  const eventsResult = await cdp.evaluate('JSON.stringify(window.__mcpSaStreamEvents)');
  return JSON.parse(eventsResult?.value || '[]');
}

async function cleanupEventCapture(cdp) {
  await cdp.evaluate(`
    if (window.__mcpSaEventListener) {
      window.removeEventListener('message', window.__mcpSaEventListener);
      delete window.__mcpSaEventListener;
    }
    delete window.__mcpSaStreamEvents;
  `);
}

// ============================================================================
// Main Test Runner
// ============================================================================

async function main() {
  const args = process.argv.slice(2);
  const testCutoff = args.includes('--cutoff-test');

  console.log('=== MCP-SuperAssistant Stream Interceptor E2E ===\n');

  // Find Notion tab
  const tab = await findNotionTab();
  if (!tab) {
    log('fail', 'No Notion AI tab found. Open a Notion agent/chat page first.');
    process.exit(2);
  }
  log('info', `Tab: ${tab.title} (${tab.id})`);

  // Connect
  const cdp = new CDPSession(tab.webSocketDebuggerUrl);
  await cdp.connect();
  await cdp.send('Runtime.enable');
  await cdp.send('Network.enable');

  // Navigate to Notion AI chat page if not already there
  const currentUrl = await cdp.evaluate('window.location.href');
  if (!currentUrl?.value?.includes('notion.so/chat')) {
    log('info', 'Navigating to Notion AI chat page...');
    await cdp.send('Page.navigate', { url: NOTION_CHAT_URL });
    // Wait for SPA to fully render — check for input selector
    let ready = false;
    for (let i = 0; i < 15; i++) {
      await new Promise(res => setTimeout(res, 1000));
      const check = await cdp.evaluate(
        '!!document.querySelector("div[contenteditable=\\"true\\"]") || !!document.querySelector("[aria-label=\\"提交 AI 消息\\"]")');
      if (check?.value === true) { ready = true; break; }
    }
    if (!ready) {
      log('fail', 'Notion AI chat page did not load within 15s');
      process.exit(2);
    }
    log('info', 'Notion AI chat page loaded');
  }

  // Preflight: log /chat selector status
  const preflight = await cdp.evaluate(`
    (function() {
      const input = document.querySelector('div[contenteditable="true"]') ||
                    document.querySelector('div[role="textbox"][contenteditable="true"]');
      const submit = document.querySelector('[aria-label="\u63d0\u4ea4 AI \u6d88\u606f"]') ||
                     document.querySelector('[aria-label="Submit AI message"]') ||
                     document.querySelector('[data-testid="agent-send-message-button"]');
      return JSON.stringify({
        url: window.location.href.slice(0, 60),
        inputSelectorMatched: !!input,
        submitSelectorMatched: !!submit,
        insertMethod: 'execCommand',
        submitMethod: submit ? 'button click' : 'Enter fallback'
      });
    })()
  `);
  if (preflight?.value) {
    log('info', '[/chat preflight] ' + preflight.value);
  }

  // Track network requests
  let inferenceCount = 0;
  cdp.onEvent((msg) => {
    if (msg.method === 'Network.requestWillBeSent') {
      if (msg.params.request.url.includes('runInferenceTranscript')) {
        inferenceCount++;
      }
    }
  });

  const results = { passed: 0, failed: 0, tests: [] };

  function assert(name, condition, detail = '') {
    if (condition) {
      results.passed++;
      results.tests.push({ name, status: 'pass' });
      log('pass', name);
    } else {
      results.failed++;
      results.tests.push({ name, status: 'fail', detail });
      log('fail', `${name}${detail ? ': ' + detail : ''}`);
    }
  }

  try {
    // Test 1: Interceptor installed
    log('info', 'Checking interceptor installation...');
    try {
      await verifyInterceptorInstalled(cdp);
      assert('Interceptor installed', true);
    } catch (e) {
      assert('Interceptor installed', false, e.message);
      throw new Error('Cannot continue without interceptor');
    }

    // Test 2: Basic stream interception (simple message)
    log('info', 'Testing basic stream interception...');
    await installEventCapture(cdp);
    await sendNotionMessage(cdp, '你好');

    const basicEvents = await waitForEvents(cdp, 2);
    const basicTypes = basicEvents.map(e => e.type);

    assert('stream_start emitted', basicTypes.includes('stream_start'));
    assert('stream_end emitted', basicTypes.includes('stream_end'));
    assert('runInferenceTranscript called', inferenceCount > 0,
      `count=${inferenceCount}`);

    if (basicEvents.length > 0) {
      const endEvent = basicEvents.find(e => e.type === 'stream_end');
      if (endEvent) {
        log('info', `  Stream: ${endEvent.detail.totalChunks} chunks`);
      }
    }

    // Test 3: function_call detection (tool-triggering message)
    log('info', 'Testing function_call detection...');

    // After the first message, re-navigate to /chat if needed
    const url3 = await cdp.evaluate('window.location.href');
    if (!url3?.value?.includes('notion.so/chat')) {
      log('info', '  Re-navigating to Notion AI chat page...');
      await cdp.send('Page.navigate', { url: NOTION_CHAT_URL });
      let ready3 = false;
      for (let i = 0; i < 15; i++) {
        await new Promise(res => setTimeout(res, 1000));
        const check = await cdp.evaluate('!!document.querySelector("[aria-label=\\"\u63d0\u4ea4 AI \u6d88\u606f\\"]")') ;
        if (check?.value === true) { ready3 = true; break; }
      }
      if (!ready3) {
        log('warn', '  Chat page did not reload — skipping function_call test');
        assert('function_call detected', false, 'could not navigate back to Notion AI chat page');
        throw new Error('skip-remaining');
      }
    }

    await installEventCapture(cdp); // Reset capture
    await sendNotionMessage(cdp, '请帮我查看当前有哪些可用的工具');

    const toolEvents = await waitForEvents(cdp, 2);
    const toolTypes = toolEvents.map(e => e.type);

    assert('function_call detected', toolTypes.includes('function_call'),
      toolTypes.length > 0 ? `events: ${toolTypes.join(',')}` : 'no events captured');

    if (!toolTypes.includes('function_call') && toolTypes.length === 0) {
      // Bounded parser failure diagnostics (P1-4)
      // Privacy: metadata only, no raw content
      const diag = await cdp.evaluate(`
        (function() {
          const interceptor = window.__MCP_SA_NOTION_STREAM_INTERCEPTOR_INSTALLED_V1__;
          const streamStats = window.__mcpSaStreamStats || {};
          return JSON.stringify({
            interceptorInstalled: !!interceptor,
            requestCount: streamStats.requestCount || 0,
            contentTypesSeen: streamStats.contentTypes || [],
            eventTypesEmitted: streamStats.eventTypes || [],
            streamStartSeen: (streamStats.eventTypes || []).includes('stream_start'),
            streamEndSeen: (streamStats.eventTypes || []).includes('stream_end'),
            scannerPatchLinesSeen: streamStats.patchLineCount || 0,
            functionCallStartSeen: streamStats.functionCallStartSeen || false,
          });
        })()
      `);
      if (diag?.value) {
        log('warn', '[parser diagnostics] ' + diag.value);
      }
    }

    if (toolTypes.includes('function_call')) {
      const fcEvent = toolEvents.find(e => e.type === 'function_call');
      log('info', `  rawLine (50): ${(fcEvent.detail.rawLine || '').substring(0, 50)}...`);
      log('info', `  identity: ${JSON.stringify(fcEvent.detail.identity)}`);
      log('info', `  elapsedMs: ${fcEvent.detail.elapsedMs?.toFixed(0)}`);
    }

    // Test 4 (optional): stream_cutoff with relaxed identity
    if (testCutoff) {
      log('info', 'Testing stream_cutoff (requireStructuredIdentity=false)...');

      // After function_call test, re-navigate to /chat if needed
      const url4 = await cdp.evaluate('window.location.href');
      if (!url4?.value?.includes('notion.so/chat')) {
        log('info', '  Re-navigating to Notion AI chat page...');
        await cdp.send('Page.navigate', { url: NOTION_CHAT_URL });
        let ready4 = false;
        for (let i = 0; i < 15; i++) {
          await new Promise(res => setTimeout(res, 1000));
          const check = await cdp.evaluate('!!document.querySelector("[aria-label=\\"\u63d0\u4ea4 AI \u6d88\u606f\\"]")') ;
          if (check?.value === true) { ready4 = true; break; }
        }
        if (!ready4) {
          log('warn', '  Chat page did not reload — skipping cutoff test');
          assert('stream_cutoff triggered (relaxed)', false, 'could not navigate back to Notion AI chat page');
          throw new Error('skip-remaining');
        }
      }

      // Override config (relaxed identity)
      await cdp.evaluate(`
        window.postMessage({
          channel: 'mcp-superassistant.stream.config',
          direction: 'isolated-to-main',
          seq: 999,
          config: { cutoffEnabled: true, requireStructuredIdentity: false }
        }, window.location.origin);
      `);
      await new Promise(res => setTimeout(res, 500));

      await installEventCapture(cdp);
      await sendNotionMessage(cdp, '请帮我读取workspace的README');

      const cutoffEvents = await waitForEvents(cdp, 3);
      const cutoffTypes = cutoffEvents.map(e => e.type);

      assert('stream_cutoff triggered (relaxed)', cutoffTypes.includes('stream_cutoff'),
        `events: ${cutoffTypes.join(',')}`);

      if (cutoffTypes.includes('stream_cutoff')) {
        const coEvent = cutoffEvents.find(e => e.type === 'stream_cutoff');
        assert('cutoff mode is drain-drop', coEvent.detail.mode === 'drain-drop',
          `mode=${coEvent.detail.mode}`);
        assert('trigger chunk forwarded', coEvent.detail.forwardedTriggerChunk === true);
        log('info', `  mode: ${coEvent.detail.mode}, elapsed: ${coEvent.detail.elapsedMs?.toFixed(0)}ms`);
      }

      if (cutoffTypes.includes('stream_drain_complete')) {
        log('info', '  Background drain completed');
      }

      // Test 5: stream_cutoff with requireStructuredIdentity=true (strict mode)
      // This verifies the full pipeline: scanner → identity → strict gate → cutoff
      log('info', 'Testing stream_cutoff (requireStructuredIdentity=true, strict)...');

      const url5 = await cdp.evaluate('window.location.href');
      if (!url5?.value?.includes('notion.so/chat')) {
        log('info', '  Re-navigating to Notion AI chat page...');
        await cdp.send('Page.navigate', { url: NOTION_CHAT_URL });
        let ready5 = false;
        for (let i = 0; i < 15; i++) {
          await new Promise(res => setTimeout(res, 1000));
          const check = await cdp.evaluate('!!document.querySelector("[aria-label=\\"\u63d0\u4ea4 AI \u6d88\u606f\\"]")') ;
          if (check?.value === true) { ready5 = true; break; }
        }
        if (!ready5) {
          log('warn', '  Chat page did not reload — skipping strict cutoff test');
          assert('stream_cutoff triggered (strict)', false, 'could not navigate back to Notion AI chat page');
          throw new Error('skip-remaining');
        }
      }

      // Set strict mode config
      await cdp.evaluate(`
        window.postMessage({
          channel: 'mcp-superassistant.stream.config',
          direction: 'isolated-to-main',
          seq: 1001,
          config: { cutoffEnabled: true, requireStructuredIdentity: true }
        }, window.location.origin);
      `);
      await new Promise(res => setTimeout(res, 500));

      await installEventCapture(cdp);
      await sendNotionMessage(cdp, '请帮我查看当前有哪些可用的工具');

      const strictEvents = await waitForEvents(cdp, 3);
      const strictTypes = strictEvents.map(e => e.type);

      const strictFc = strictEvents.find(e => e.type === 'function_call');
      const strictCutoff = strictEvents.find(e => e.type === 'stream_cutoff');

      assert('stream_cutoff triggered (strict)', strictTypes.includes('stream_cutoff'),
        `events: ${strictTypes.join(',')}`);

      if (strictFc) {
        assert('identity non-null in strict mode', strictFc.detail.identity !== null && strictFc.detail.identity !== undefined,
          `identity=${JSON.stringify(strictFc.detail.identity)}`);
        log('info', `  identity: ${JSON.stringify(strictFc.detail.identity)}`);
        log('info', `  rawLine (100): ${(strictFc.detail.rawLine || '').substring(0, 100)}`);
      }

      // Debug: show all events
      for (const e of strictEvents) {
        log('info', `  [${e.type}] identity=${JSON.stringify(e.detail?.identity)} rawLine=${(e.detail?.rawLine || '').substring(0, 80)}`);
      }

      if (strictCutoff) {
        log('info', `  strict cutoff mode: ${strictCutoff.detail.mode}, elapsed: ${strictCutoff.detail.elapsedMs?.toFixed(0)}ms`);
      }

      // Restore config
      await cdp.evaluate(`
        window.postMessage({
          channel: 'mcp-superassistant.stream.config',
          direction: 'isolated-to-main',
          seq: 1000,
          config: { cutoffEnabled: true, requireStructuredIdentity: true }
        }, window.location.origin);
      `);
    }
  } catch (e) {
    if (e.message !== 'skip-remaining' && e.message !== 'Cannot continue without interceptor') {
      log('fail', 'Unexpected error: ' + e.message);
    }
  } finally {
    await cleanupEventCapture(cdp);
    cdp.close();
  }

  // Summary
  console.log(`\n=== Results: ${results.passed} passed, ${results.failed} failed ===`);
  if (results.failed > 0) {
    console.log('\nFailed tests:');
    for (const t of results.tests.filter(t => t.status === 'fail')) {
      console.log(`  - ${t.name}${t.detail ? ': ' + t.detail : ''}`);
    }
    process.exit(1);
  }
  process.exit(0);
}

main().catch(e => {
  console.error('Fatal error:', e.message);
  process.exit(2);
});
