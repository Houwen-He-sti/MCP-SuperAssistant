/**
 * E2E BH Bridge Smoke Test — scripts/e2e-bh-bri​dge-smoke.cjs
 *
 * Slice T: E2E smoke verification for BH ToolCallLoop Bridge
 *
 * Failure classes (mutually exclusive, reported with distinct exit codes):
 *   FC-1 (exit 2): CDP_UNAVAILABLE    — Cannot connect to Chrome DevTools (port 9222)
 *   FC-2 (exit 3): NO_NOTION_TAB      — No Notion /chat or /workspace tab found
 *   FC-3 (exit 4): EXT_NOT_LOADED     — Extension content script not detected
 *   FC-4 (exit 5): MCP_CLIENT_ABSENT  — window.mcpClient absent or malformed (no callTool)
 *   FC-5 (exit 6): ACTIVATION_TIMEOUT — BH bridge start() not detected within timeout
 *   exit 0: PASS — all checks passed, ToolCallLoop active log detected
 *
 * Probe strategy (reload-driven, default):
 *   1. Connect to Notion tab → enable Runtime domain (start listening FIRST)
 *   2. Reload page (Page.reload) so bridge emits fresh activation log
 *   3. Wait for [Notion Bridge] ToolCallLoop active in consoleAPICalled
 *   4. After log received (or timeout), probe ext/mcp state to classify failure
 *
 * This avoids the race condition where bridge activated BEFORE the listener was attached.
 *
 * Usage:
 *   node scripts/e2e-bh-bridge-smoke.cjs [--activation-timeout-ms=8000] [--idempotent] [--wait-only]
 *
 * Flags:
 *   --wait-only          Skip Page.reload; just wait for the next native activation log.
 *                        Use this if you start the script BEFORE loading the Notion tab.
 *   --activation-timeout-ms=N  Override wait timeout (default 8000ms; reload path uses N+3000ms)
 *   --idempotent         Run probe twice and compare result class (non-destructive).
 *
 * Run:
 *   node scripts/e2e-bh-bridge-smoke.cjs
 */
'use strict';

const WebSocket = require('ws');
const http = require('http');

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const CDP_HOST = '127.0.0.1';
const CDP_PORT = 9222;

const args = process.argv.slice(2);
const ACTIVATION_TIMEOUT_MS = (() => {
  const arg = args.find(a => a.startsWith('--activation-timeout-ms='));
  return arg ? parseInt(arg.split('=')[1], 10) : 8000;
})();
const IDEMPOTENT = args.includes('--idempotent');
// --wait-only: skip Page.reload; just wait for next organic activation log.
// Use when you start the script BEFORE the page is loaded.
const WAIT_ONLY = args.includes('--wait-only');

// ---------------------------------------------------------------------------
// Failure class definitions
// ---------------------------------------------------------------------------

const FC = {
  PASS: { code: 0, label: 'PASS', description: 'BH bridge activated — ToolCallLoop active log detected' },
  CDP_UNAVAILABLE: { code: 2, label: 'FC-1:CDP_UNAVAILABLE', description: 'Cannot connect to Chrome DevTools remotely (port 9222). Is Chrome running with --remote-debugging-port=9222?' },
  NO_NOTION_TAB: { code: 3, label: 'FC-2:NO_NOTION_TAB', description: 'No Notion /chat or /workspace page found. Open https://www.notion.so/chat first.' },
  EXT_NOT_LOADED: { code: 4, label: 'FC-3:EXT_NOT_LOADED', description: 'MCP-SA content script not detected on Notion tab. Build and load the extension: pnpm build, then reload in chrome://extensions/.' },
  MCP_CLIENT_ABSENT: { code: 5, label: 'FC-4:MCP_CLIENT_ABSENT', description: 'window.mcpClient is absent or malformed (no callTool function). Extension loaded but mcpClient not initialized.' },
  ACTIVATION_TIMEOUT: { code: 6, label: 'FC-5:ACTIVATION_TIMEOUT', description: `BH bridge start() did not emit activation log within ${ACTIVATION_TIMEOUT_MS}ms. Bridge may have fail-closed or logger not connected.` },
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fetchJson(path) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: CDP_HOST, port: CDP_PORT, path }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error(`Failed to parse JSON from ${path}: ${e.message}`)); }
      });
    });
    req.on('error', reject);
    req.setTimeout(3000, () => { req.destroy(); reject(new Error('CDP connection timeout')); });
  });
}

function cdpEval(wsUrl, expression, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error('cdpEval timeout'));
    }, timeoutMs);
    ws.on('open', () => {
      ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression, returnByValue: true } }));
    });
    ws.on('message', d => {
      const msg = JSON.parse(d);
      if (msg.id === 1) {
        clearTimeout(timer);
        ws.close();
        resolve(msg.result?.result ?? { type: 'error', value: JSON.stringify(msg) });
      }
    });
    ws.on('error', e => { clearTimeout(timer); reject(e); });
  });
}

/**
 * Send a CDP command and wait for its result (fire-and-forget variant with short timeout).
 * Opens and closes its own WS connection.
 */
function cdpCommand(wsUrl, method, params = {}, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const timer = setTimeout(() => { ws.close(); resolve({ timedOut: true }); }, timeoutMs);
    ws.on('open', () => {
      ws.send(JSON.stringify({ id: 99, method, params }));
    });
    ws.on('message', d => {
      const msg = JSON.parse(d);
      if (msg.id === 99) { clearTimeout(timer); ws.close(); resolve(msg); }
    });
    ws.on('error', e => { clearTimeout(timer); reject(e); });
  });
}

/**
 * Listen for Runtime.consoleAPICalled events containing the activation message.
 * Returns when the message is found or timeout is reached.
 */
function waitForActivationLog(wsUrl, pattern, timeoutMs) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let enableId = 1;
    
    const timer = setTimeout(() => {
      ws.close();
      resolve({ found: false, reason: 'timeout' });
    }, timeoutMs);

    ws.on('open', () => {
      // Enable Runtime domain to receive consoleAPICalled events
      ws.send(JSON.stringify({ id: enableId, method: 'Runtime.enable' }));
    });

    ws.on('message', d => {
      const msg = JSON.parse(d);
      if (msg.method === 'Runtime.consoleAPICalled') {
        const text = (msg.params?.args ?? [])
          .map(a => a.value ?? a.description ?? '')
          .join(' ');
        if (text.includes(pattern)) {
          clearTimeout(timer);
          ws.close();
          resolve({ found: true, message: text });
        }
      }
    });

    ws.on('error', e => { clearTimeout(timer); reject(e); });
  });
}

// ---------------------------------------------------------------------------
// Probe function (single run) — reload-driven by default
// ---------------------------------------------------------------------------

async function runProbe() {
  const result = { fc: FC.PASS, details: {} };

  // FC-1: CDP availability
  let tabs;
  try {
    tabs = await fetchJson('/json');
  } catch (e) {
    result.fc = FC.CDP_UNAVAILABLE;
    result.details.error = e.message;
    return result;
  }

  // FC-2: Find Notion tab
  const notionTab = tabs.find(t =>
    t.url &&
    (t.url.includes('notion.so/chat') || t.url.match(/notion\.so\/[a-f0-9-]{8,}/)) &&
    !t.url.includes('_assets') &&
    t.webSocketDebuggerUrl
  );
  if (!notionTab) {
    result.fc = FC.NO_NOTION_TAB;
    result.details.availableTabs = tabs.slice(0, 5).map(t => t.url?.slice(0, 60) ?? 'unknown');
    return result;
  }
  result.details.notionTabUrl = notionTab.url.slice(0, 80);
  result.details.wsUrl = notionTab.webSocketDebuggerUrl;

  const wsUrl = notionTab.webSocketDebuggerUrl;

  // Reload-driven strategy:
  //   1. Start listening for runtime console events FIRST (before any reload)
  //   2. Optionally reload the page to trigger a fresh bridge activation
  //   3. Wait for the activation log
  //   4. After result, probe ext/mcp state to classify failure if needed
  //
  // This prevents the race condition where bridge already activated before listener attached.

  // Reload path uses extra time budget to account for page load + extension inject.
  const listenTimeoutMs = WAIT_ONLY ? ACTIVATION_TIMEOUT_MS : ACTIVATION_TIMEOUT_MS + 6000;

  // Start listener (opens its own WS connection, begins Runtime.enable immediately)
  const activationPromise = waitForActivationLog(wsUrl, 'ToolCallLoop active', listenTimeoutMs);

  if (!WAIT_ONLY) {
    // Give the listener WS a brief moment to connect and send Runtime.enable
    await new Promise(r => setTimeout(r, 200));
    try {
      await cdpCommand(wsUrl, 'Page.reload', { ignoreCache: true }, 5000);
      result.details.reloaded = true;
    } catch (e) {
      result.details.reloadError = e.message;
      // Non-fatal: listener is still running, fall through to wait
    }
  }

  // Wait for activation log (or timeout)
  const activationResult = await activationPromise;
  result.details.activationLog = activationResult;

  // Probe ext/mcp state (needed for failure classification and FC-4 check)
  let probeData = {};
  try {
    const probeResult = await cdpEval(wsUrl, `(function() {
      return JSON.stringify({
        extLoaded: !!(window.__MCP_SA_LOADED__ || window.__mcpSuperAssistantLoaded__ || document.querySelector('[data-mcp]')),
        mcpClientType: typeof window.mcpClient,
        mcpHasCallTool: !!(window.mcpClient && typeof window.mcpClient.callTool === 'function'),
        mcpHasGetTools: !!(window.mcpClient && typeof window.mcpClient.getAvailableTools === 'function'),
      });
    })()`);
    probeData = JSON.parse(probeResult.value ?? '{}');
  } catch (e) {
    result.details.probeError = `CDP eval failed: ${e.message}`;
  }
  result.details.probeData = probeData;

  if (!activationResult.found) {
    // Classify failure based on ext/mcp state
    if (!probeData.extLoaded) {
      result.fc = FC.EXT_NOT_LOADED;
    } else if (!probeData.mcpHasCallTool) {
      result.fc = FC.MCP_CLIENT_ABSENT;
    } else {
      result.fc = FC.ACTIVATION_TIMEOUT;
    }
    return result;
  }

  // Activation log found; check mcpClient health to catch FC-4 edge case
  // (extLoaded:true but mcpClient absent/malformed is an explicit P1 failure)
  if (!probeData.mcpHasCallTool) {
    result.fc = FC.MCP_CLIENT_ABSENT;
    result.details.mcpClientType = probeData.mcpClientType;
    return result;
  }

  // All checks passed
  return result;
}


// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const mode = WAIT_ONLY ? 'wait-only' : 'reload-driven';
  console.log('=== BH Bridge E2E Smoke Test ===');
  console.log(`Config: activation-timeout=${ACTIVATION_TIMEOUT_MS}ms, mode=${mode}, idempotent=${IDEMPOTENT}\n`);

  const run1 = await runProbe();
  console.log(`Run 1: ${run1.fc.label}`);
  if (Object.keys(run1.details).length > 0) {
    console.log('  Details:', JSON.stringify(run1.details, null, 2).replace(/\n/g, '\n  '));
  }

  if (IDEMPOTENT) {
    console.log('\nRunning idempotency check (2nd probe)...');
    const run2 = await runProbe();
    console.log(`Run 2: ${run2.fc.label}`);
    if (run1.fc.code !== run2.fc.code) {
      console.error(`\n❌ Idempotency FAILED: Run 1 = ${run1.fc.label}, Run 2 = ${run2.fc.label}`);
      process.exit(7);
    }
  }

  if (run1.fc.code === 0) {
    console.log('\n✅ PASS: BH bridge is active and observable via CDP.');
    process.exit(0);
  } else {
    console.error(`\n❌ ${run1.fc.label}: ${run1.fc.description}`);
    process.exit(run1.fc.code);
  }
}

main().catch(e => {
  console.error('Unexpected error:', e.message);
  process.exit(1);
});
