/**
 * E2E BH Bridge Probe — scripts/e2e-bh-bridge-probe.mjs  (ESM)
 *
 * ESM rewrite of e2e-bh-bridge-smoke.cjs.
 * Requires Node 18+ (uses native fetch, top-level await, import).
 * Requires: npm add -D ws   (or: pnpm add -D ws)
 *
 * Failure classes (mutually exclusive):
 *   FC-1 (exit 2): CDP_UNAVAILABLE    — Cannot connect to Chrome DevTools (port 9222)
 *   FC-2 (exit 3): NO_NOTION_TAB      — No Notion /chat or /workspace tab found
 *   FC-3 (exit 4): EXT_NOT_LOADED     — Extension content script not detected
 *   FC-4 (exit 5): MCP_CLIENT_ABSENT  — window.mcpClient absent or no callTool()
 *   FC-5 (exit 6): ACTIVATION_TIMEOUT — BH bridge ToolCallLoop active log not seen
 *   exit 0: PASS — all checks passed
 *
 * Usage:
 *   node scripts/e2e-bh-bridge-probe.mjs [--activation-timeout-ms=8000] [--wait-only] [--idempotent]
 *
 * Flags:
 *   --wait-only            Skip Page.reload; wait for next organic activation log.
 *   --activation-timeout-ms=N   Override timeout (default 8000ms).
 *   --idempotent           Run probe twice and compare result classes.
 */

import WebSocket from 'ws';

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
const WAIT_ONLY   = args.includes('--wait-only');
const IDEMPOTENT  = args.includes('--idempotent');

// ---------------------------------------------------------------------------
// Failure class definitions
// ---------------------------------------------------------------------------

const FC = {
  PASS:               { code: 0, label: 'PASS',               desc: 'BH bridge activated — ToolCallLoop active log detected' },
  CDP_UNAVAILABLE:    { code: 2, label: 'FC-1:CDP_UNAVAILABLE',  desc: `Cannot connect to Chrome DevTools at ${CDP_HOST}:${CDP_PORT}. Is Chrome running with --remote-debugging-port=${CDP_PORT}?` },
  NO_NOTION_TAB:      { code: 3, label: 'FC-2:NO_NOTION_TAB',   desc: 'No Notion /chat or /workspace page found. Open https://www.notion.so/chat first.' },
  EXT_NOT_LOADED:     { code: 4, label: 'FC-3:EXT_NOT_LOADED',  desc: 'MCP-SA content script not detected. Build + reload extension in chrome://extensions/.' },
  MCP_CLIENT_ABSENT:  { code: 5, label: 'FC-4:MCP_CLIENT_ABSENT', desc: 'window.mcpClient absent or no callTool(). Extension loaded but mcpClient not initialized.' },
  ACTIVATION_TIMEOUT: { code: 6, label: 'FC-5:ACTIVATION_TIMEOUT', desc: `BH bridge start() did not emit activation log within ${ACTIVATION_TIMEOUT_MS}ms.` },
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Fetch JSON from CDP HTTP endpoint (uses native fetch, Node 18+) */
async function cdpFetchJson(path) {
  const url = `http://${CDP_HOST}:${CDP_PORT}${path}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 4000);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    clearTimeout(timer);
    return await res.json();
  } catch (e) {
    clearTimeout(timer);
    throw new Error(`CDP HTTP ${path} failed: ${e.message}`);
  }
}

/** Execute a JS expression in the page via Runtime.evaluate, returns the result object. */
function cdpEval(wsUrl, expression, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const timer = setTimeout(() => { ws.close(); reject(new Error('cdpEval timeout')); }, timeoutMs);
    ws.on('open', () => {
      ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression, returnByValue: true } }));
    });
    ws.on('message', raw => {
      const msg = JSON.parse(raw);
      if (msg.id === 1) {
        clearTimeout(timer);
        ws.close();
        resolve(msg.result?.result ?? { type: 'error', value: JSON.stringify(msg) });
      }
    });
    ws.on('error', e => { clearTimeout(timer); reject(e); });
  });
}

/** Send a CDP command and wait for its response (e.g. Page.reload). */
function cdpCommand(wsUrl, method, params = {}, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const timer = setTimeout(() => { ws.close(); resolve({ timedOut: true }); }, timeoutMs);
    ws.on('open', () => ws.send(JSON.stringify({ id: 99, method, params })));
    ws.on('message', raw => {
      const msg = JSON.parse(raw);
      if (msg.id === 99) { clearTimeout(timer); ws.close(); resolve(msg); }
    });
    ws.on('error', e => { clearTimeout(timer); reject(e); });
  });
}

/**
 * Open a persistent WS connection and listen for Runtime.consoleAPICalled events.
 * Resolves when pattern is found in a console message, or timeout elapses.
 */
function waitForActivationLog(wsUrl, pattern, timeoutMs) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const timer = setTimeout(() => { ws.close(); resolve({ found: false, reason: 'timeout' }); }, timeoutMs);
    ws.on('open', () => ws.send(JSON.stringify({ id: 1, method: 'Runtime.enable' })));
    ws.on('message', raw => {
      const msg = JSON.parse(raw);
      if (msg.method === 'Runtime.consoleAPICalled') {
        const text = (msg.params?.args ?? []).map(a => a.value ?? a.description ?? '').join(' ');
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
// Probe logic
// ---------------------------------------------------------------------------

async function runProbe() {
  const result = { fc: FC.PASS, details: {} };

  // FC-1: CDP reachable?
  let tabs;
  try {
    tabs = await cdpFetchJson('/json');
  } catch (e) {
    result.fc = FC.CDP_UNAVAILABLE;
    result.details.error = e.message;
    return result;
  }

  // FC-2: Find a Notion chat/workspace tab with a debugger URL
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
  const wsUrl = notionTab.webSocketDebuggerUrl;

  // Listen window: extra time budget on reload-driven path (page load + ext inject)
  const listenTimeoutMs = WAIT_ONLY ? ACTIVATION_TIMEOUT_MS : ACTIVATION_TIMEOUT_MS + 6000;

  // Start listener FIRST so we don't miss the log even if page loads fast
  const activationPromise = waitForActivationLog(wsUrl, 'ToolCallLoop active', listenTimeoutMs);

  if (!WAIT_ONLY) {
    // Brief pause to let listener WS connect and send Runtime.enable before reload
    await new Promise(r => setTimeout(r, 200));
    try {
      await cdpCommand(wsUrl, 'Page.reload', { ignoreCache: true }, 5000);
      result.details.reloaded = true;
    } catch (e) {
      result.details.reloadError = e.message;
      // Non-fatal: listener still running
    }
  }

  const activationResult = await activationPromise;
  result.details.activationLog = activationResult;

  // Probe ext/mcp state (always; needed for failure classification)
  let probeData = {};
  try {
    const r = await cdpEval(wsUrl, `(function() {
      return JSON.stringify({
        extLoaded: !!(window.__MCP_SA_LOADED__ || window.__mcpSuperAssistantLoaded__ || document.querySelector('[data-mcp]')),
        mcpClientType: typeof window.mcpClient,
        mcpHasCallTool: !!(window.mcpClient && typeof window.mcpClient.callTool === 'function'),
        mcpHasGetTools: !!(window.mcpClient && typeof window.mcpClient.getAvailableTools === 'function'),
      });
    })()`);
    probeData = JSON.parse(r.value ?? '{}');
  } catch (e) {
    result.details.probeError = `CDP eval failed: ${e.message}`;
  }
  result.details.probeData = probeData;

  if (!activationResult.found) {
    if (!probeData.extLoaded)       result.fc = FC.EXT_NOT_LOADED;
    else if (!probeData.mcpHasCallTool) result.fc = FC.MCP_CLIENT_ABSENT;
    else                            result.fc = FC.ACTIVATION_TIMEOUT;
    return result;
  }

  // Activation confirmed — still check mcpClient (FC-4 edge case)
  if (!probeData.mcpHasCallTool) {
    result.fc = FC.MCP_CLIENT_ABSENT;
    result.details.mcpClientType = probeData.mcpClientType;
    return result;
  }

  return result;  // FC.PASS
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const mode = WAIT_ONLY ? 'wait-only' : 'reload-driven';
console.log('=== BH Bridge E2E Probe (ESM) ===');
console.log(`Config: activation-timeout=${ACTIVATION_TIMEOUT_MS}ms  mode=${mode}  idempotent=${IDEMPOTENT}\n`);

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
  console.error(`\n❌ ${run1.fc.label}: ${run1.fc.desc}`);
  process.exit(run1.fc.code);
}
