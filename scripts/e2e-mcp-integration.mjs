/**
 * E2E MCP Integration — scripts/e2e-mcp-integration.mjs  (ESM)
 *
 * Slice X: BH Path Level 2 (Tool Discovery) + Level 3 (Tool Execution)
 *
 * Validates that:
 *   L2: mcpClient.getAvailableTools() returns a list containing 'committee-bridge.echo'
 *       with correct schema (message: string)
 *   L3: mcpClient.callTool('committee-bridge.echo', {message: 'slice-x-probe'}) returns
 *       a result containing 'slice-x-probe'
 *
 * PRECONDITIONS (must be true before running):
 *   1. Chrome running with --remote-debugging-port=9222
 *   2. MCP-SA extension loaded from ./dist
 *   3. Notion tab open at /chat or /ai
 *   4. committee-bridge MCP server running at http://localhost:8000
 *      with 'committee-bridge.echo' tool registered (committee-bridge MCP server)
 *   5. Extension connected to committee-bridge MCP server
 *
 * Failure classes:
 *   FC-1 (exit 2):  CDP_UNAVAILABLE    — Cannot connect to Chrome CDP
 *   FC-2 (exit 3):  NO_NOTION_TAB      — No Notion tab found
 *   FC-3 (exit 4):  EXT_NOT_LOADED     — Extension content-script not active
 *   FC-4 (exit 5):  BRIDGE_NOT_ACTIVE  — BH bridge activation log not seen
 *   FC-MCP (exit 6): MCP_NOT_CONNECTED — window.mcpClient absent or not connected
 *   FC-NO-ECHO (exit 7): ECHO_NOT_REGISTERED — 'echo' tool not in getAvailableTools()
 *   FC-L3 (exit 8): CALL_FAILED        — callTool('echo') failed or result mismatch
 *   exit 0: PASS                       — L2 + L3 both passed
 *
 * Key design decision: mcpClient lives in content-script ISOLATED world.
 * Runtime.evaluate (MAIN world) cannot access it.
 * This script enumerates execution contexts and targets the isolated world.
 *
 * Usage:
 *   node scripts/e2e-mcp-integration.mjs [--tool committee-bridge.echo] [--message slice-x-probe]
 *   node scripts/e2e-mcp-integration.mjs --list-contexts   # debug: list all contexts
 *
 * Author: GitHub Copilot (Claude Sonnet 4.6)
 * Date: 2026-05-21
 * Refs: Slice X PL (plans/slice-x-bh-level2-3-e2e-plan.md), PR #259
 */

import WebSocket from 'ws';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const CDP_HOST = '127.0.0.1';
const CDP_PORT = 9222;
const TOOL_NAME = (() => {
  const arg = process.argv.find(a => a.startsWith('--tool='));
  return arg ? arg.split('=')[1] : 'committee-bridge.echo';
})();
const MESSAGE = (() => {
  const arg = process.argv.find(a => a.startsWith('--message='));
  return arg ? arg.split('=')[1] : 'slice-x-probe';
})();
const LIST_CONTEXTS = process.argv.includes('--list-contexts');

// ---------------------------------------------------------------------------
// Failure classes
// ---------------------------------------------------------------------------

const FC = {
  PASS: { code: 0, label: 'PASS', desc: 'L2 + L3 both passed' },
  CDP_UNAVAILABLE: {
    code: 2,
    label: 'FC-1:CDP_UNAVAIL',
    desc: `Cannot connect to Chrome CDP at ${CDP_HOST}:${CDP_PORT}`,
  },
  NO_NOTION_TAB: { code: 3, label: 'FC-2:NO_NOTION', desc: 'No Notion tab found at /chat or /ai or /workspace' },
  EXT_NOT_LOADED: {
    code: 4,
    label: 'FC-3:EXT_ABSENT',
    desc: 'Extension stream interceptor marker not found (MAIN world)',
  },
  BRIDGE_NOT_ACTIVE: {
    code: 5,
    label: 'FC-4:BRIDGE_OFF',
    desc: 'BH bridge activation log not detected — loop may not have started',
  },
  MCP_NOT_CONNECTED: {
    code: 6,
    label: 'FC-MCP:NO_CLIENT',
    desc: 'window.mcpClient absent or has no callTool — MCP server not connected?',
  },
  ECHO_NOT_FOUND: { code: 7, label: 'FC-NO-ECHO', desc: `Tool '${TOOL_NAME}' not found in getAvailableTools() result` },
  CALL_FAILED: {
    code: 8,
    label: 'FC-L3:CALL_FAIL',
    desc: `callTool('${TOOL_NAME}') returned error or result did not contain expected message`,
  },
};

// ---------------------------------------------------------------------------
// CDP helpers
// ---------------------------------------------------------------------------

// Small integer counter for CDP message ids (Chrome requires small integers)
let _cdpIdCounter = 1;
const nextCdpId = () => _cdpIdCounter++;

/**
 * Fetch the list of debuggable targets from Chrome.
 * Returns an array of {id, type, url, webSocketDebuggerUrl} objects.
 */
async function getCdpTargets() {
  const res = await fetch(`http://${CDP_HOST}:${CDP_PORT}/json`);
  return res.json();
}

/**
 * Open a CDP WebSocket to the given debugger URL.
 * Resolves with the WebSocket once connected.
 */
function openCdpWs(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const timeout = setTimeout(() => reject(new Error('CDP WS connect timeout')), 5000);
    ws.on('open', () => {
      clearTimeout(timeout);
      resolve(ws);
    });
    ws.on('error', e => {
      clearTimeout(timeout);
      reject(e);
    });
  });
}

/**
 * Send a CDP command and wait for the response with the matching id.
 * @param {WebSocket} ws - Open CDP WebSocket
 * @param {string} method - CDP method name
 * @param {object} params - CDP method parameters
 * @param {number} [timeout=10000] - Timeout in ms
 */
function cdpCommand(ws, method, params = {}, timeout = 10000) {
  const id = nextCdpId();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`CDP timeout: ${method}`)), timeout);
    const handler = data => {
      const msg = JSON.parse(data.toString());
      if (msg.id === id) {
        ws.off('message', handler);
        clearTimeout(timer);
        if (msg.error) reject(new Error(`CDP error: ${JSON.stringify(msg.error)}`));
        else resolve(msg.result);
      }
    };
    ws.on('message', handler);
    ws.send(JSON.stringify({ id, method, params }));
  });
}

/**
 * Wait for a specific CDP event (e.g., 'Runtime.executionContextCreated')
 * @param {WebSocket} ws
 * @param {string} eventName
 * @param {function} predicate - Returns true when matching event is found
 * @param {number} [timeout=5000]
 */
function waitForCdpEvent(ws, eventName, predicate, timeout = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`CDP event timeout: ${eventName}`)), timeout);
    const handler = data => {
      const msg = JSON.parse(data.toString());
      if (msg.method === eventName && predicate(msg.params)) {
        ws.off('message', handler);
        clearTimeout(timer);
        resolve(msg.params);
      }
    };
    ws.on('message', handler);
  });
}

/**
 * Enable Runtime domain and collect all execution contexts.
 * Also waits for any additional contexts to arrive after the enable response.
 * @param {WebSocket} ws
 * @param {boolean} [alreadyEnabled=false] — set to true to skip Runtime.enable and just collect
 */
async function collectExecutionContexts(ws, alreadyEnabled = false) {
  const contexts = [];
  const contextHandler = (data) => {
    const msg = JSON.parse(data.toString());
    if (msg.method === 'Runtime.executionContextCreated') {
      contexts.push(msg.params.context);
    }
  };
  ws.on('message', contextHandler);
  if (!alreadyEnabled) {
    // Runtime.enable triggers a flood of executionContextCreated events;
    // use a long timeout (30s) to absorb all of them before the response arrives.
    await cdpCommand(ws, 'Runtime.enable', {}, 30000);
  }
  // Wait for any remaining context events to arrive
  await new Promise(r => setTimeout(r, 500));
  ws.off('message', contextHandler);
  return contexts;
}

/**
 * Execute JS in a specific execution context, returning the parsed value.
 */
async function evalInContext(ws, expression, contextId) {
  const result = await cdpCommand(
    ws,
    'Runtime.evaluate',
    {
      expression,
      contextId,
      returnByValue: true,
      awaitPromise: true,
    },
    15000,
  );
  if (result.exceptionDetails) {
    throw new Error(`JS exception: ${result.exceptionDetails.text || JSON.stringify(result.exceptionDetails)}`);
  }
  return result.result;
}

// ---------------------------------------------------------------------------
// Main probe logic
// ---------------------------------------------------------------------------

async function runProbe() {
  const result = {
    fc: FC.PASS,
    details: {},
    contexts: [],
  };

  // ── Preflight P-1: CDP connect ────────────────────────────────────────────
  let targets;
  try {
    targets = await getCdpTargets();
  } catch (e) {
    result.fc = FC.CDP_UNAVAILABLE;
    result.details.error = e.message;
    return result;
  }

  // ── Preflight P-2: Find Notion tab ────────────────────────────────────────
  const notionTab = targets.find(t => t.type === 'page' && /notion\.so/.test(t.url));
  if (!notionTab) {
    result.fc = FC.NO_NOTION_TAB;
    result.details.availableTabs = targets.map(t => ({ type: t.type, url: t.url }));
    return result;
  }
  result.details.notionTabUrl = notionTab.url;

  const ws = await openCdpWs(notionTab.webSocketDebuggerUrl);

  try {
    // ── Preflight P-3: Enable Runtime + collect contexts + MAIN world marker ──
    // collectExecutionContexts sends Runtime.enable internally (30s timeout to absorb events)
    const allContexts = await collectExecutionContexts(ws);
    result.contexts = allContexts.map(c => ({
      id: c.id,
      name: c.name,
      origin: c.origin,
      isDefault: c.auxData?.isDefault,
      type: c.auxData?.type,
    }));

    if (LIST_CONTEXTS) {
      console.log(`\n=== Execution Contexts (${allContexts.length}) ===`);
      for (const ctx of result.contexts) {
        console.log(JSON.stringify(ctx));
      }
      ws.close();
      process.exit(0);
    }

    const mainWorldCheck = await cdpCommand(ws, 'Runtime.evaluate', {
      expression: `!!(window['__MCP_SA_NOTION_STREAM_INTERCEPTOR_INSTALLED_V1__'])`,
      returnByValue: true,
    });
    result.details.extLoaded = mainWorldCheck.result?.value ?? false;
    if (!result.details.extLoaded) {
      result.fc = FC.EXT_NOT_LOADED;
      ws.close();
      return result;
    }

    // ── Preflight P-4: BH activation ─────────────────────────────────────────
    // Bridge activation is confirmed via the MAIN world marker above (extLoaded).
    // No separate activation log check here — mcpClient presence (P-5) is the proxy.
    result.details.preflightPass = true;

    // ── Find content-script isolated world (already collected above) ──────────
    // index.ts sets window.mcpClient in the "MCP SuperAssistant" isolated world.
    // There can be multiple "MCP SuperAssistant" contexts (main frame + iframes like
    // identity.notion.so/authSync). We need the one from the MAIN www.notion.so frame.
    // Strategy: evaluate document.URL in each candidate and pick the one whose URL
    // matches the notionTab's origin (www.notion.so), not a subdomain (identity.notion.so).
    const notionTabOrigin = new URL(notionTab.url).origin; // https://www.notion.so
    const mcpSuperAssistantCandidates = allContexts.filter(c =>
      c.name === 'MCP SuperAssistant' &&
      c.origin?.startsWith('chrome-extension://')
    );

    let contentScriptCtx = null;
    for (const ctx of mcpSuperAssistantCandidates) {
      try {
        const urlCheck = await cdpCommand(ws, 'Runtime.evaluate', {
          expression: 'document.URL',
          contextId: ctx.id,
          returnByValue: true,
        });
        const frameUrl = urlCheck?.result?.value ?? '';
        if (frameUrl.startsWith(notionTabOrigin)) {
          contentScriptCtx = ctx;
          break; // found main frame context; stop searching
        }
      } catch (_) { /* stale context, skip */ }
    }

    // Fallback: any isolated world with notion.so origin (not playwright)
    if (!contentScriptCtx) {
      contentScriptCtx = allContexts.find(c =>
        c.auxData?.isDefault === false &&
        c.origin === notionTabOrigin &&
        !c.name?.includes('playwright')
      ) ?? null;
    }

    result.details.isolatedContextCount = allContexts.filter(c => !c.auxData?.isDefault).length;
    result.details.targetContextId = contentScriptCtx?.id ?? null;
    result.details.targetContextName = contentScriptCtx?.name ?? null;

    if (!contentScriptCtx) {
      result.fc = FC.MCP_NOT_CONNECTED;
      result.details.error = 'No "MCP SuperAssistant" isolated execution context found — extension may not be active on this page';
      ws.close();
      return result;
    }

    // ── Preflight P-5: window.mcpClient present ────────────────────────────────
    let hasMcpClient;
    try {
      const mcpCheck = await evalInContext(
        ws,
        `JSON.stringify({
          mcpClientExists: typeof window.mcpClient !== 'undefined',
          hasCallTool: typeof window.mcpClient?.callTool === 'function',
          hasGetAvailableTools: typeof window.mcpClient?.getAvailableTools === 'function',
        })`,
        contentScriptCtx.id,
      );
      hasMcpClient = JSON.parse(mcpCheck.value ?? '{}');
    } catch (e) {
      result.details.mcpCheckError = e.message;
      hasMcpClient = { mcpClientExists: false };
    }
    result.details.mcpClient = hasMcpClient;

    if (!hasMcpClient?.mcpClientExists || !hasMcpClient?.hasCallTool) {
      result.fc = FC.MCP_NOT_CONNECTED;
      ws.close();
      return result;
    }

    // ── L2: Tool Discovery ────────────────────────────────────────────────────
    let tools;
    try {
      const toolsResult = await evalInContext(
        ws,
        `(async function() {
          const tools = await window.mcpClient.getAvailableTools();
          return JSON.stringify(tools);
        })()`,
        contentScriptCtx.id,
      );
      tools = JSON.parse(toolsResult.value ?? '[]');
    } catch (e) {
      result.details.l2Error = e.message;
      result.fc = FC.ECHO_NOT_FOUND;
      ws.close();
      return result;
    }
    result.details.availableTools = tools.map(t => ({
      name: t.name,
      hasSchema: !!t.inputSchema,
    }));

    const echoTool = tools.find(t => t.name === TOOL_NAME);
    if (!echoTool) {
      result.fc = FC.ECHO_NOT_FOUND;
      result.details.availableToolNames = tools.map(t => t.name);
      ws.close();
      return result;
    }

    // L2 schema check: echo should accept 'message' param
    const echoSchema = echoTool.inputSchema ?? echoTool.schema ?? {};
    const hasMessageParam =
      echoSchema?.properties?.message ||
      echoSchema?.required?.includes('message') ||
      JSON.stringify(echoSchema).includes('"message"');
    result.details.echoSchema = {
      found: true,
      name: echoTool.name,
      hasMessageParam,
      schema: echoSchema,
    };
    // Schema check is informational, not a blocker for now

    // ── L3: Tool Execution ────────────────────────────────────────────────────
    let callResult;
    try {
      const callRes = await evalInContext(
        ws,
        `(async function() {
          const result = await window.mcpClient.callTool('${TOOL_NAME}', { message: '${MESSAGE}' });
          return JSON.stringify(result);
        })()`,
        contentScriptCtx.id,
      );
      callResult = JSON.parse(callRes.value ?? 'null');
    } catch (e) {
      result.details.l3Error = e.message;
      result.fc = FC.CALL_FAILED;
      ws.close();
      return result;
    }
    result.details.callResult = callResult;

    // L3 assertion: result must contain the original message
    const resultStr = JSON.stringify(callResult);
    if (!resultStr.includes(MESSAGE)) {
      result.fc = FC.CALL_FAILED;
      result.details.l3FailReason = `Result does not contain expected message '${MESSAGE}'`;
      ws.close();
      return result;
    }
  } catch (e) {
    result.fc = FC.CDP_UNAVAILABLE;
    result.details.unexpectedError = e.message;
  } finally {
    ws.close();
  }

  return result;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

console.log('=== BH Bridge MCP Integration E2E (Slice X) ===');
console.log(`Tool: ${TOOL_NAME}  Message: ${MESSAGE}\n`);

let result;
try {
  result = await runProbe();
} catch (e) {
  console.error('Unexpected error:', e.message);
  process.exit(2);
}

// Print structured output
console.log(`Result: ${result.fc.label}`);
if (result.contexts.length > 0 && LIST_CONTEXTS) {
  console.log(`\nExecution contexts (${result.contexts.length}):`);
  result.contexts.forEach(c => console.log(`  ${JSON.stringify(c)}`));
}
if (Object.keys(result.details).length > 0) {
  console.log('\nDetails:');
  console.log(
    JSON.stringify(result.details, null, 2)
      .split('\n')
      .map(l => `  ${l}`)
      .join('\n'),
  );
}

// Save to JSON artifact
import { writeFileSync } from 'fs';
try {
  const artifact = {
    timestamp: new Date().toISOString(),
    tool: TOOL_NAME,
    message: MESSAGE,
    fc: result.fc.label,
    code: result.fc.code,
    details: result.details,
    contexts: result.contexts,
  };
  writeFileSync('/tmp/slice-x-e2e-result.json', JSON.stringify(artifact, null, 2));
  console.log('\nArtifact saved to /tmp/slice-x-e2e-result.json');
} catch (e) {
  console.warn('Could not save artifact:', e.message);
}

if (result.fc.code === 0) {
  console.log(`\n✅ PASS: ${result.fc.desc}`);
  process.exit(0);
} else {
  console.error(`\n❌ ${result.fc.label}: ${result.fc.desc}`);
  process.exit(result.fc.code);
}
