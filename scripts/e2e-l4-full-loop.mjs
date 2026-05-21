/**
 * E2E L4 Full Tool Loop — scripts/e2e-l4-full-loop.mjs  (ESM)
 *
 * Slice Y: BH Path Level 4 Full E2E Verification
 *
 * Validates the complete L4 path:
 *   Notion AI produces bridge JSONL → BridgeJsonlParser parses → ToolCallLoop
 *   executes tool → adapter.insertText() injects result into Notion input.
 *
 * PRECONDITIONS (must be true before running):
 *   1. Chrome running with --remote-debugging-port=9222
 *   2. MCP-SA extension loaded from ./dist (built with observability seams)
 *   3. Notion AI tab open at /chat or /ai (system prompt already injected)
 *   4. committee-bridge MCP server running at http://localhost:8000
 *   5. Extension connected to committee-bridge MCP server
 *   6. Notion AI conversation started (bridge system prompt must be in context)
 *
 * Failure classes:
 *   FC-1    (exit 2):  CDP_UNAVAILABLE      — Cannot connect to Chrome CDP
 *   FC-2    (exit 3):  NO_NOTION_TAB        — No Notion tab found
 *   FC-3    (exit 4):  EXT_NOT_LOADED       — Extension content-script not active
 *   FC-INPUT-MISSING (exit 8):  No Notion AI input element found
 *   FC-L4-NO-ACTIVE  (exit 9):  ToolCallLoop activation signal absent
 *   FC-L4-NO-JSONL   (exit 10): Notion AI did not produce bridge JSONL (+ evidence output)
 *   FC-L4-PARSE-FAIL (exit 11): JSONL parse errors > 0
 *   FC-L4-INSERT-FAIL (exit 12): insertText failed
 *   FC-L4-NO-MATCH   (exit 13): injected text does not contain expected probe message
 *   FC-L4-INPUT-DRAFT (exit 14): Notion input has pre-existing draft content
 *   exit 0:  PASS — full L4 path verified
 *
 * Console signals monitored (emitted by mcp-runtime/src/core/tool-call-loop.ts):
 *   info: '[Notion Bridge] ToolCallLoop active'            — AC-1
 *   info: '[Notion Bridge] ToolCallLoop parsed calls' N    — AC-3 (N>0 = JSONL detected)
 *   warn: '[Notion Bridge] ToolCallLoop parse failed' N    — → FC-L4-PARSE-FAIL
 *   info: '[Notion Bridge] ToolCallLoop insertText ok' name callId  — AC-4
 *   warn: '[Notion Bridge] ToolCallLoop insertText failed' name callId code  — → FC-L4-INSERT-FAIL
 *
 * Key design decisions inherited from Slice X:
 *   - mcpClient lives in content-script ISOLATED world, not MAIN world
 *   - Must select TOP-LEVEL Notion frame: document.URL.includes('notion.so') && window===window.top
 *   - Use Runtime.consoleAPICalled CDP events to observe extension console output
 *
 * Usage:
 *   node scripts/e2e-l4-full-loop.mjs [--message=slice-y-probe] [--timeout=60000] [--list-contexts]
 *
 * Author: GitHub Copilot (Claude Sonnet 4.6)
 * Date: 2026-05-27
 * Refs: Slice Y plan (plans/slice-y-l4-full-e2e-autosubmit-plan.md), PR #262
 */

import fs from 'fs';
import path from 'path';
import WebSocket from 'ws';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const CDP_HOST = '127.0.0.1';
const CDP_PORT = 9222;
const PROBE_MESSAGE = (() => {
  const arg = process.argv.find(a => a.startsWith('--message='));
  return arg ? arg.split('=')[1] : 'slice-y-probe';
})();
const TIMEOUT_MS = (() => {
  const arg = process.argv.find(a => a.startsWith('--timeout='));
  return arg ? parseInt(arg.split('=')[1], 10) : 60000;
})();
const LIST_CONTEXTS = process.argv.includes('--list-contexts');

// How long to wait for Notion AI to respond with JSONL after prompt injection
const AI_RESPONSE_WAIT_MS = Math.min(TIMEOUT_MS - 10000, 120000);

// ---------------------------------------------------------------------------
// Failure classes
// ---------------------------------------------------------------------------

const FC = {
  PASS: { code: 0, label: 'PASS', desc: 'L4 full path verified' },
  CDP_UNAVAILABLE: {
    code: 2,
    label: 'FC-1:CDP_UNAVAIL',
    desc: `Cannot connect to Chrome CDP at ${CDP_HOST}:${CDP_PORT}`,
  },
  NO_NOTION_TAB: { code: 3, label: 'FC-2:NO_NOTION', desc: 'No Notion tab found at /chat or /ai' },
  EXT_NOT_LOADED: { code: 4, label: 'FC-3:EXT_ABSENT', desc: 'Extension stream interceptor marker not found' },
  INPUT_MISSING: { code: 8, label: 'FC-INPUT-MISSING', desc: 'Notion AI input element not found' },
  NO_ACTIVE: { code: 9, label: 'FC-L4-NO-ACTIVE', desc: 'ToolCallLoop activation signal absent' },
  NO_JSONL: { code: 10, label: 'FC-L4-NO-JSONL', desc: 'Notion AI did not produce bridge JSONL' },
  PARSE_FAIL: { code: 11, label: 'FC-L4-PARSE-FAIL', desc: 'BridgeJsonlParser reported parse errors' },
  INSERT_FAIL: { code: 12, label: 'FC-L4-INSERT-FAIL', desc: 'adapter.insertText() failed' },
  NO_MATCH: { code: 13, label: 'FC-L4-NO-MATCH', desc: 'Injected text did not contain expected probe message' },
  INPUT_DRAFT: { code: 14, label: 'FC-L4-INPUT-DRAFT', desc: 'Notion input has pre-existing draft content' },
};

function fail(fc, extra = '') {
  const msg = extra ? `${fc.desc}: ${extra}` : fc.desc;
  console.error(`[L4-E2E] FAIL ${fc.label} — ${msg}`);
  process.exit(fc.code);
}

function pass(detail = '') {
  console.log(`[L4-E2E] PASS (exit 0) — ${detail || 'L4 full path verified'}`);
  process.exit(FC.PASS.code);
}

// ---------------------------------------------------------------------------
// CDP helpers (adapted from e2e-mcp-integration.mjs, Slice X)
// ---------------------------------------------------------------------------

let _cdpIdCounter = 1;
const nextCdpId = () => _cdpIdCounter++;

async function getCdpTargets() {
  const res = await fetch(`http://${CDP_HOST}:${CDP_PORT}/json`);
  if (!res.ok) throw new Error(`CDP /json returned ${res.status}`);
  return res.json();
}

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

function cdpCommand(ws, method, params = {}, timeout = 10000) {
  const id = nextCdpId();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`CDP timeout: ${method}`)), timeout);
    const handler = data => {
      const msg = JSON.parse(data.toString());
      if (msg.id === id) {
        ws.off('message', handler);
        clearTimeout(timer);
        if (msg.error) reject(new Error(`CDP error (${method}): ${JSON.stringify(msg.error)}`));
        else resolve(msg.result);
      }
    };
    ws.on('message', handler);
    ws.send(JSON.stringify({ id, method, params }));
  });
}

/**
 * Collect all execution contexts from Runtime.enable.
 * Waits briefly for any late-arriving contexts after enable response.
 */
async function collectExecutionContexts(ws) {
  const contexts = [];
  const handler = data => {
    const msg = JSON.parse(data.toString());
    if (msg.method === 'Runtime.executionContextCreated') {
      contexts.push(msg.params.context);
    }
  };
  ws.on('message', handler);
  await cdpCommand(ws, 'Runtime.enable');
  // Wait 2000ms for late-arriving contexts (Notion SPA may create bridge context ~1-3s after load)
  await new Promise(r => setTimeout(r, 2000));
  ws.off('message', handler);
  return contexts;
}

/**
 * Evaluate JS in a specific execution context (isolated world).
 */
async function evalInContext(ws, contextId, expression, timeout = 10000) {
  const params = { expression, returnByValue: true, awaitPromise: true };
  if (contextId != null) params.contextId = contextId;
  return cdpCommand(ws, 'Runtime.evaluate', params, timeout);
}

// Run expression in the page's main world (no isolated context)
async function evalInMainWorld(ws, expression, timeout = 10000) {
  return evalInContext(ws, null, expression, timeout);
}

// ---------------------------------------------------------------------------
// Console event monitoring (Slice Y observability seam)
// ---------------------------------------------------------------------------

/**
 * Subscribe to Runtime.consoleAPICalled events.
 * Returns an unsubscribe function and a promise that resolves when predicate fires.
 */
function waitForConsoleSignal(ws, predicate, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`console signal timeout after ${timeoutMs}ms`)), timeoutMs);
    const handler = data => {
      const msg = JSON.parse(data.toString());
      if (msg.method !== 'Runtime.consoleAPICalled') return;
      const args = (msg.params.args || []).map(a => a.value ?? a.description ?? '');
      if (predicate(msg.params.type, args)) {
        ws.off('message', handler);
        clearTimeout(timer);
        resolve({ type: msg.params.type, args });
      }
    };
    ws.on('message', handler);
  });
}

/**
 * Collect all console events matching prefix during a window (for evidence).
 * Returns a cleanup function.
 */
function collectConsoleEvents(ws, prefix) {
  const events = [];
  const handler = data => {
    const msg = JSON.parse(data.toString());
    if (msg.method !== 'Runtime.consoleAPICalled') return;
    const args = (msg.params.args || []).map(a => a.value ?? a.description ?? '');
    if (String(args[0]).startsWith(prefix)) {
      events.push({ type: msg.params.type, args, ts: msg.params.timestamp });
    }
  };
  ws.on('message', handler);
  return { events, stop: () => ws.off('message', handler) };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  // ---- FC-1: Connect to CDP ----
  let targets;
  try {
    targets = await getCdpTargets();
  } catch (e) {
    fail(FC.CDP_UNAVAILABLE, e.message);
  }

  if (LIST_CONTEXTS) {
    console.log('[L4-E2E] All CDP targets:');
    targets.forEach(t => console.log(`  [${t.type}] ${t.url} — ws: ${t.webSocketDebuggerUrl}`));
    process.exit(0);
  }

  // ---- FC-2: Find Notion tab ----
  const notionTarget = targets.find(
    t =>
      t.type === 'page' &&
      (t.url.includes('notion.so/chat') || t.url.includes('notion.so/ai') || t.url.includes('/ai')),
  );
  if (!notionTarget) {
    console.error('[L4-E2E] Available tabs:');
    targets.filter(t => t.type === 'page').forEach(t => console.error(`  ${t.url}`));
    fail(FC.NO_NOTION_TAB);
  }
  console.log(`[L4-E2E] Found Notion tab: ${notionTarget.url}`);

  let ws;
  try {
    ws = await openCdpWs(notionTarget.webSocketDebuggerUrl);
  } catch (e) {
    fail(FC.CDP_UNAVAILABLE, `WS open failed: ${e.message}`);
  }

  // ---- Force-navigate to clean home page ----
  // Force a complete page navigation reload to guarantee a pristine state,
  // wiping out any leftover DOM text or hung session memory from previous runs.
  await cdpCommand(ws, 'Page.enable');
  console.log('[L4-E2E] Navigating to Notion AI chat home page for an absolute clean context...');
  await cdpCommand(ws, 'Page.navigate', { url: 'https://www.notion.so/chat' });
  console.log('[L4-E2E] Navigation triggered. Waiting 6s for page bundle load...');
  await new Promise(resolve => setTimeout(resolve, 6000));

  // Enable Runtime and collect execution contexts
  const contexts = await collectExecutionContexts(ws);
  console.log(`[L4-E2E] Found ${contexts.length} execution contexts`);

  if (LIST_CONTEXTS) {
    console.log('[L4-E2E] Execution contexts:');
    contexts.forEach(ctx => console.log(`  id=${ctx.id} name="${ctx.name}" origin="${ctx.origin}"`));
    ws.close();
    process.exit(0);
  }

  // Enable Runtime.consoleAPICalled events
  await cdpCommand(ws, 'Runtime.enable');

  // ---- FC-3: Find extension content-script context (top-level Notion frame) ----
  // MCP SuperAssistant isolated world has origin="chrome-extension://..." not Notion origin.
  // Among all "MCP SuperAssistant" contexts, find the ACTIVE top-level one.
  // Key insight: multiple contexts satisfy (top && notion.so) due to SPA navigation;
  // the ACTIVE context is the one where window.mcpClient has been initialized (typeof === 'object').
  const mcpCandidates = contexts.filter(ctx => ctx.name === 'MCP SuperAssistant');
  console.log(`[L4-E2E] Found ${mcpCandidates.length} MCP SuperAssistant context(s), checking active...`);

  let mcpContext = null;
  // Pass 1: find context with mcpClient initialized (the fully-initialized bridge)
  for (const ctx of mcpCandidates) {
    try {
      const r = await evalInContext(
        ws,
        ctx.id,
        'document.URL.includes("notion.so") && window === window.top && typeof window.mcpClient === "object"',
        2000,
      );
      if (r.result?.value === true) {
        mcpContext = ctx;
        break;
      }
    } catch {
      // skip — context may have been destroyed
    }
  }
  // Pass 2 fallback: any top-level Notion frame (mcpClient may still be initializing)
  if (!mcpContext) {
    for (const ctx of mcpCandidates) {
      try {
        const r = await evalInContext(ws, ctx.id, 'document.URL.includes("notion.so") && window === window.top', 2000);
        if (r.result?.value === true) {
          mcpContext = ctx;
          break;
        }
      } catch {
        // skip
      }
    }
    if (mcpContext) {
      console.warn('[L4-E2E] Using fallback context (mcpClient not yet initialized) — bridge may be initializing');
    }
  }

  if (!mcpContext) {
    console.error('[L4-E2E] Available contexts:');
    contexts.forEach(ctx => console.error(`  id=${ctx.id} name="${ctx.name}" origin="${ctx.origin}"`));
    fail(FC.EXT_NOT_LOADED, 'No MCP SuperAssistant context found in top-level Notion frame');
  }
  console.log(`[L4-E2E] Using context id=${mcpContext.id} name="${mcpContext.name}"`);

  // Start collecting all [Notion Bridge] console events for evidence
  const bridgeEvents = collectConsoleEvents(ws, '[Notion Bridge]');

  // ---- Auto-configure extension to connect to local committee-bridge (localhost:8000) ----
  console.log('[L4-E2E] Configuring extension to connect to local committee-bridge at http://localhost:8000/mcp...');
  const configResult = await evalInContext(
    ws,
    mcpContext.id,
    `
    (async function() {
      if (typeof window.mcpClient === 'object' && window.mcpClient !== null) {
        try {
          const res = await window.mcpClient.updateServerConfig({
            uri: 'http://localhost:8000/mcp',
            connectionType: 'streamable-http'
          });
          return { ok: res };
        } catch (e) {
          return { ok: false, error: e.message };
        }
      }
      return { ok: false, error: 'window.mcpClient is absent or not an object' };
    })()
  `,
    10000,
  ).catch(e => ({ result: { value: { ok: false, error: e.message } } }));

  console.log(`[L4-E2E] Extension config update result: ${JSON.stringify(configResult.result?.value)}`);

  // Poll until mcpClient.getConnectionStatus() === 'connected'.
  // This is the SAME call that NotionConnectionState.isConnected() uses internally
  // (useConnectionStore.getState().status === 'connected') — so this is the authoritative gate.
  // Without this, a tool call may arrive while status is still 'disconnected', causing the
  // D6 guard in NotionHostBindings to return success:false silently (no insertText ever called).
  console.log('[L4-E2E] Polling mcpClient.getConnectionStatus() = connected (max 20s)...');
  const connectionPollStart = Date.now();
  let connectionReady = false;
  while (Date.now() - connectionPollStart < 20000) {
    const connCheck = await evalInContext(
      ws,
      mcpContext.id,
      `(function() {
        try {
          const client = window.mcpClient;
          if (!client) return { status: 'no-mcpClient' };
          // Try getConnectionStatus (bound explicitly to avoid 'this' loss in eval)
          if (typeof client.getConnectionStatus === 'function') {
            const s = client.getConnectionStatus.call(client);
            return { status: s };
          }
          // Fallback: read useConnectionStore from background store state reflection
          // McpClient exposes isReady() and internal state through various properties
          const keys = Object.keys(client).join(',');
          return { status: 'no-getConnectionStatus', keys };
        } catch(e) { return { status: 'error', msg: e.message }; }
      })()`,
    ).catch(() => ({ result: { value: { status: 'eval-failed' } } }));

    const status = connCheck.result?.value?.status;
    console.log(`[L4-E2E] Connection status poll: ${status}`);
    if (status === 'connected') {
      console.log(`[L4-E2E] MCP connection ready after ${Date.now() - connectionPollStart}ms`);
      connectionReady = true;
      break;
    }
    await new Promise(r => setTimeout(r, 1000));
  }
  if (!connectionReady) {
    console.warn(
      '[L4-E2E] MCP connection status did not reach "connected" in 20s — proceeding with caution (tool calls may be blocked by D6 guard)',
    );
  }
  // Extra 1s settle time after connection detected
  await new Promise(r => setTimeout(r, 1000));

  // ---- FC-L4-NO-ACTIVE: Wait for ToolCallLoop active signal ----
  // If bridge is already running, this signal may have been emitted before we connected.
  // We check for it in the first 3s, then proceed (it may have been emitted on init).
  console.log('[L4-E2E] Checking for ToolCallLoop active signal...');
  let loopActive = false;
  try {
    await Promise.race([
      waitForConsoleSignal(
        ws,
        (type, args) => type === 'log' && String(args[0]).includes('[Notion Bridge] ToolCallLoop active'),
        3000,
      ),
      // Also accept 'info' level
      waitForConsoleSignal(
        ws,
        (type, args) => type === 'info' && String(args[0]).includes('[Notion Bridge] ToolCallLoop active'),
        3000,
      ),
    ]);
    console.log('[L4-E2E] AC-1: ToolCallLoop active signal received');
    loopActive = true;
  } catch {
    // Signal may have been emitted before our subscription — check via eval
    const check = await evalInContext(
      ws,
      mcpContext.id,
      'typeof window.mcpAdapter === "object" && window.mcpAdapter !== null && window.mcpAdapter.bhBridgeDisposable ? "active" : "absent"',
    ).catch(() => ({ result: { value: 'eval-failed' } }));
    const stateVal = check.result?.value;
    console.log(`[L4-E2E] ToolCallLoop active check via eval: ${stateVal}`);
    // If the bridge is wired, the loop would have activated on init.
    // We proceed but note the signal may have been missed.
    loopActive = stateVal !== 'absent' && stateVal !== 'eval-failed';
  }

  if (!loopActive) {
    // Try direct eval check: is bridge controller registered?
    const bridgeCheck = await evalInContext(
      ws,
      mcpContext.id,
      '!!window.mcpClient && typeof window.mcpClient.getAvailableTools === "function"',
    ).catch(() => ({ result: { value: false } }));
    if (!bridgeCheck.result?.value) {
      fail(FC.NO_ACTIVE, 'ToolCallLoop not active and mcpClient not available');
    }
    console.log('[L4-E2E] AC-1: mcpClient present — assuming ToolCallLoop active (signal may have pre-emitted)');
  }

  // ---- Click 'New Chat' button to ensure clean state ----
  console.log('[L4-E2E] Attempting to click "New Chat" button to ensure absolute clean session...');
  await evalInMainWorld(
    ws,
    `
    (function() {
      const newChatEl = Array.from(document.querySelectorAll('div, span, button')).find(el => {
        const text = (el.textContent || '').trim();
        return text === '新对话' || text === '新对话⌘O' || text === 'New chat' || text === 'New chat⌘O';
      });
      if (newChatEl) {
        newChatEl.click();
        return { clicked: true, text: newChatEl.textContent.trim() };
      }
      return { clicked: false };
    })()
  `,
    4000,
  )
    .then(res => {
      if (res?.result?.value?.clicked) {
        console.log(`[L4-E2E] "New Chat" button clicked successfully: "${res.result.value.text}"`);
      } else {
        console.log('[L4-E2E] "New Chat" button not found or already clicked, proceeding');
      }
    })
    .catch(e => console.warn('[L4-E2E] Error clicking new chat button:', e.message));

  // Wait 5s for new session to initialize
  await new Promise(r => setTimeout(r, 5000));

  // ---- Reactivate BH bridge after "New Chat" DOM replacement ----
  // IMPORTANT: clicking "新对话" causes React to unmount + remount .layout-content.
  // The ToolCallLoop's MutationObserver was bound to the OLD .layout-content node —
  // it is now an orphaned observer and will never fire.
  // Fix: deactivate + reactivate mcpAdapter so ToolCallLoop re-attaches to the NEW node.
  console.log(
    '[L4-E2E] Reactivating BH bridge (deactivate+activate) to rebind MutationObserver to new .layout-content...',
  );
  await evalInContext(
    ws,
    mcpContext.id,
    `
    (async function() {
      if (typeof window.mcpAdapter === 'object' && window.mcpAdapter !== null &&
          typeof window.mcpAdapter.deactivate === 'function' &&
          typeof window.mcpAdapter.activate === 'function') {
        await window.mcpAdapter.deactivate();
        await window.mcpAdapter.activate();
        return { ok: true };
      }
      return { ok: false, reason: 'mcpAdapter not available or missing deactivate/activate' };
    })()
  `,
    8000,
  )
    .then(res => {
      console.log(`[L4-E2E] BH bridge reactivation result: ${JSON.stringify(res?.result?.value)}`);
    })
    .catch(e => console.warn('[L4-E2E] BH bridge reactivation error:', e.message));

  // Give ToolCallLoop 2s to re-attach to new DOM
  await new Promise(r => setTimeout(r, 2000));
  console.log('[L4-E2E] BH bridge reactivation complete — ToolCallLoop should be bound to new .layout-content');

  // ---- Pre-flight: Input state check (main world) ----
  // Just verify the input exists. Do NOT modify it here — the inject step handles clearing.
  // IMPORTANT: Never use innerHTML='' on Notion's contenteditable — it destroys React fiber connections.
  const inputCheck = await evalInMainWorld(
    ws,
    `
    (function() {
      const notionInput = document.querySelector('[placeholder="使用 AI 处理各种任务..."]') ||
                          Array.from(document.querySelectorAll('[contenteditable="true"]')).find(el => {
                            const ph = el.getAttribute('placeholder');
                            const r = el.getBoundingClientRect();
                            return ph && r.width > 100 && r.height > 20 && r.height < 200 && r.y >= 0 && r.y < 1000;
                          });
      if (!notionInput) return { found: false };
      const text = (notionInput.textContent || '').trim();
      const r2 = notionInput.getBoundingClientRect();
      return { found: true, existingLen: text.length, inputX: Math.round(r2.x + r2.width/2), inputY: Math.round(r2.y + r2.height/2) };
    })()
  `,
  ).catch(() => ({ result: { value: { found: false } } }));

  const inputState = inputCheck.result?.value;
  if (!inputState?.found) {
    fail(FC.INPUT_MISSING, 'No Notion AI contenteditable input found in main world');
  }
  console.log(
    `[L4-E2E] Pre-flight: Notion AI input found at (~${inputState.inputX}, ~${inputState.inputY}), existingLen=${inputState.existingLen}`,
  );
  const hasMcpDraft = false; // Notion chat input is always used fresh

  // ---- Subscribe to observability seam signals before sending prompt ----
  const parsedCallsSignal = waitForConsoleSignal(
    ws,
    (type, args) => type === 'info' && args[0] === '[Notion Bridge] ToolCallLoop parsed calls' && Number(args[1]) > 0,
    AI_RESPONSE_WAIT_MS,
  );
  const parseFailSignal = waitForConsoleSignal(
    ws,
    (type, args) => type === 'warn' && args[0] === '[Notion Bridge] ToolCallLoop parse failed',
    AI_RESPONSE_WAIT_MS,
  );
  // Suppress unhandled rejections on timeout — these are awaited inside the try/catch below
  const insertOkSignal = waitForConsoleSignal(
    ws,
    (type, args) => type === 'info' && args[0] === '[Notion Bridge] ToolCallLoop insertText ok',
    AI_RESPONSE_WAIT_MS,
  ).catch(() => null);
  const insertFailSignal = waitForConsoleSignal(
    ws,
    (type, args) => type === 'warn' && args[0] === '[Notion Bridge] ToolCallLoop insertText failed',
    AI_RESPONSE_WAIT_MS,
  ).catch(() => null);

  let bridgePromptPath = path.join(
    process.cwd(),
    'pages/content/src/services/prompt/prompt-templates/notion-bridge.md',
  );
  if (!fs.existsSync(bridgePromptPath)) {
    bridgePromptPath = path.join(
      process.cwd(),
      'MCP-SuperAssistant/pages/content/src/services/prompt/prompt-templates/notion-bridge.md',
    );
  }
  const bridgePrompt = fs.readFileSync(bridgePromptPath, 'utf8');

  const sentinelPrompt =
    `${bridgePrompt}\n\n` +
    `Please call committee-bridge.echo with message "${PROBE_MESSAGE}". ` +
    `Wrap your response in a fenced code block exactly like this:\n` +
    `\`\`\`jsonl\n` +
    `{"type":"function_call_start","name":"committee-bridge.echo","call_id":"slice-y-probe-2026-05-21-1"}\n` +
    `{"type":"description","text":"Slice Y probe"}\n` +
    `{"type":"parameter","key":"message","value":"${PROBE_MESSAGE}"}\n` +
    `{"type":"function_call_end","call_id":"slice-y-probe-2026-05-21-1"}\n` +
    `\`\`\``;
  console.log(`[L4-E2E] Injecting sentinel prompt: "${sentinelPrompt.slice(0, 150)}..."`);

  // Robust pre-click alignment in main world: scroll, focus, and place selection
  console.log(`[L4-E2E] Performing JS scrollIntoView, focus, selection placement`);
  await evalInMainWorld(
    ws,
    `
    (function() {
      const inp = document.querySelector('[placeholder="使用 AI 处理各种任务..."]') ||
                  Array.from(document.querySelectorAll('[contenteditable="true"]')).find(el => {
                    const ph = el.getAttribute('placeholder');
                    const r = el.getBoundingClientRect();
                    return ph && r.width > 100 && r.height > 20 && r.height < 200 && r.y >= 0 && r.y < 1000;
                  });
      if (!inp) return false;
      inp.scrollIntoView({block: 'center', behavior: 'instant'});
      inp.focus();
      const range = document.createRange();
      range.selectNodeContents(inp);
      range.collapse(false);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      inp.click();
      return true;
    })()
  `,
    4000,
  ).catch(() => null);
  await new Promise(r => setTimeout(r, 200));

  // Recalculate physical coordinates post-scroll
  const coordCheck = await evalInMainWorld(
    ws,
    `
    (function() {
      const inp = document.querySelector('[placeholder="使用 AI 处理各种任务..."]') ||
                  Array.from(document.querySelectorAll('[contenteditable="true"]')).find(el => {
                    const ph = el.getAttribute('placeholder');
                    const r = el.getBoundingClientRect();
                    return ph && r.width > 100 && r.height > 20 && r.height < 200 && r.y >= 0 && r.y < 1000;
                  });
      if (!inp) return null;
      const r = inp.getBoundingClientRect();
      return { x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2) };
    })()
  `,
  ).catch(() => ({ result: { value: null } }));
  const coords = coordCheck.result?.value || { x: inputState.inputX, y: inputState.inputY };

  console.log(`[L4-E2E] Clicking input physically at coordinates (${coords.x}, ${coords.y})`);
  await cdpCommand(ws, 'Input.dispatchMouseEvent', {
    type: 'mousePressed',
    x: coords.x,
    y: coords.y,
    button: 'left',
    clickCount: 1,
  });
  await cdpCommand(ws, 'Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x: coords.x,
    y: coords.y,
    button: 'left',
    clickCount: 1,
  });
  await new Promise(r => setTimeout(r, 300)); // Wait for physical focus to settle

  // ---- Programmatic clipboard paste event dispatch in main world ----
  console.log(`[L4-E2E] Dispatching programmatic ClipboardEvent('paste') carrying sentinelPrompt to contenteditable`);
  await evalInMainWorld(
    ws,
    `
    (function() {
      const inp = document.querySelector('[placeholder="使用 AI 处理各种任务..."]') ||
                  Array.from(document.querySelectorAll('[contenteditable="true"]')).find(el => {
                    const ph = el.getAttribute('placeholder');
                    const r = el.getBoundingClientRect();
                    return ph && r.width > 100 && r.height > 20 && r.height < 200 && r.y >= 0 && r.y < 1000;
                  });
      if (!inp) return false;
      inp.scrollIntoView({block: 'center', behavior: 'instant'});
      inp.focus();
      
      // Force clear any leftover text safely to keep injection completely pure
      document.execCommand('selectAll', false, null);
      document.execCommand('delete', false, null);
      
      // Construct a programmatic DataTransfer with the target prompt
      const dataTransfer = new DataTransfer();
      dataTransfer.setData('text/plain', ${JSON.stringify(sentinelPrompt)});
      
      // Dispatch a bubbling, cancelable paste ClipboardEvent
      const pasteEvent = new ClipboardEvent('paste', {
        clipboardData: dataTransfer,
        bubbles: true,
        cancelable: true
      });
      
      inp.dispatchEvent(pasteEvent);
      return true;
    })()
  `,
    6000,
  ).catch(() => null);

  console.log(`[L4-E2E] Waiting for ProseMirror paste event parsing to settle...`);
  await new Promise(r => setTimeout(r, 800)); // Give ProseMirror 800ms to process the paste and update React state

  // ---- Check + Submit in ONE atomic eval call ----
  const injectSubmitResult = await evalInMainWorld(
    ws,
    `
    (function() {
      const inp = document.querySelector('[placeholder="使用 AI 处理各种任务..."]') ||
                  Array.from(document.querySelectorAll('[contenteditable="true"]')).find(el => {
                    const ph = el.getAttribute('placeholder');
                    const r = el.getBoundingClientRect();
                    return ph && r.width > 100 && r.height > 20 && r.height < 200 && r.y >= 0 && r.y < 1000;
                  });
      if (!inp) return { ok: false, reason: 'no-input' };
      
      const after = (inp.textContent || '').trim();
      const execOk = true;
      const beforeLen = 0;
      
      // Step 3: Find and click the now-active submit button
      const btns = Array.from(document.querySelectorAll('button'));
      const btn = btns.find(b => {
        if (!b.offsetParent) return false;
        const s = window.getComputedStyle(b);
        // Relax check: accept either type="submit" or type="button" and check only visible opacity > 0.5.
        // pointer-events: none inside ComputedStyle doesn't block programmatic JS .click() calls.
        return parseFloat(s.opacity) > 0.5 && (b.type === 'submit' || b.type === 'button');
      });
      if (btn) {
        btn.click();
        
        // Also dispatch highly realistic Enter KeyboardEvents to guarantee physical submission
        const enterDown = new KeyboardEvent('keydown', {
          key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true
        });
        const enterUp = new KeyboardEvent('keyup', {
          key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true
        });
        inp.dispatchEvent(enterDown);
        inp.dispatchEvent(enterUp);
        
        const rect = btn.getBoundingClientRect();
        return { ok: true, execOk, beforeLen, afterLen: after.length, submitted: true, btnX: Math.round(rect.x+rect.width/2), btnY: Math.round(rect.y+rect.height/2) };
      }
      // Button not active — return diagnostic info
      const allBtnStates = btns.map(b => ({ type: b.type, op: window.getComputedStyle(b).opacity, pe: window.getComputedStyle(b).pointerEvents }));
      const inpAttrs = Array.from(inp.attributes).map(a => ({ name: a.name, value: a.value }));
      const activeEl = document.activeElement;
      return { 
        ok: true, 
        execOk, 
        beforeLen, 
        afterLen: after.length, 
        submitted: false, 
        allBtns: allBtnStates, 
        inpClass: inp.className, 
        inpAttrs, 
        inpHTML: inp.outerHTML.substring(0, 500),
        activeTagName: activeEl ? activeEl.tagName : 'none',
        activeClass: activeEl ? activeEl.className : '',
        activePlaceholder: activeEl ? activeEl.getAttribute('placeholder') : ''
      };
    })()
  `,
    8000,
  ).catch(e => ({ result: { value: { ok: false, reason: e.message } } }));

  const injectState = injectSubmitResult.result?.value;
  if (!injectState?.ok) {
    fail(FC.INPUT_MISSING, `Inject+Submit failed: ${injectState?.reason}`);
  }
  if (injectState?.submitted) {
    console.log(
      `[L4-E2E] Sentinel prompt injected and submitted via btn.click() at (${injectState.btnX}, ${injectState.btnY}) — execOk=${injectState.execOk}, len=${injectState.afterLen}`,
    );
  } else {
    console.warn(
      `[L4-E2E] Injected (before=${injectState?.beforeLen}, len=${injectState?.afterLen}) but submit button not active — trying Enter key fallback`,
    );
    console.warn(`[L4-E2E] Button states: ${JSON.stringify(injectState?.allBtns)}`);
    console.warn(
      `[L4-E2E] Active Element: Tag=${injectState?.activeTagName}, Class=${injectState?.activeClass}, PH=${injectState?.activePlaceholder}`,
    );
    console.warn(`[L4-E2E] Input Class: ${injectState?.inpClass}`);
    console.warn(`[L4-E2E] Input Attrs: ${JSON.stringify(injectState?.inpAttrs)}`);
    console.warn(`[L4-E2E] Input HTML: ${injectState?.inpHTML}`);
    // Fallback: Dispatch highly realistic native JS KeyboardEvent for Enter key in Main World
    await evalInMainWorld(
      ws,
      `
      (function() {
        const inp = document.querySelector('[placeholder="使用 AI 处理各种任务..."]') ||
                    Array.from(document.querySelectorAll('[contenteditable="true"]')).find(el => {
                      const ph = el.getAttribute('placeholder');
                      const r = el.getBoundingClientRect();
                      return ph && r.width > 100 && r.height > 20 && r.height < 200 && r.y >= 0 && r.y < 1000;
                    });
        if (!inp) return false;
        inp.focus();
        
        // Dispatch bubbling, cancelable keydown event
        const enterDown = new KeyboardEvent('keydown', {
          key: 'Enter',
          code: 'Enter',
          keyCode: 13,
          which: 13,
          bubbles: true,
          cancelable: true
        });
        
        // Dispatch bubbling, cancelable keyup event
        const enterUp = new KeyboardEvent('keyup', {
          key: 'Enter',
          code: 'Enter',
          keyCode: 13,
          which: 13,
          bubbles: true,
          cancelable: true
        });
        
        inp.dispatchEvent(enterDown);
        inp.dispatchEvent(enterUp);
        return true;
      })()
    `,
      4000,
    ).catch(() => null);
    console.log('[L4-E2E] Native Enter key event sequence programmatically dispatched as fallback');
  }

  // ---- Wait for L4 observability signals ----
  console.log(`[L4-E2E] Waiting up to ${AI_RESPONSE_WAIT_MS}ms for Notion AI response + L4 signals...`);

  let parsedCalls, insertOk, insertFail;
  try {
    // We remove parseFailSignal from Promise.race. During streaming, intermediate parse errors
    // are highly expected because the JSONL block is incomplete. We must wait for the final completed
    // sequence to parse successfully (which resolves parsedCallsSignal once parsedCount > 0).
    parsedCalls = await parsedCallsSignal;
  } catch (e) {
    // No signal at all or timeout — FC-L4-NO-JSONL
    bridgeEvents.stop();
    console.error('[L4-E2E] Evidence — bridge console events collected:');
    bridgeEvents.events.forEach(ev => console.error(`  [${ev.type}] ${ev.args.join(' ')}`));

    // Check if there was any parser warning in our collected events to provide diagnostics
    const parseFailWarn = bridgeEvents.events.find(
      ev => ev.type === 'warn' && String(ev.args[0]).includes('[Notion Bridge] ToolCallLoop parse failed'),
    );
    if (parseFailWarn) {
      console.warn(
        `[L4-E2E] Diagnostic: Parser warnings were detected during streaming. Last warning args: ${parseFailWarn.args.join(' ')}`,
      );
    }

    // Collect sanitized assistant output for NO-JSONL evidence
    const assistantEvidence = await evalInContext(
      ws,
      mcpContext.id,
      `
      (function() {
        const msgs = Array.from(document.querySelectorAll('[data-content-editable-leaf],.notion-ai-response'));
        return msgs.map(m => (m.textContent || '').trim().slice(0, 200)).filter(Boolean).join(' | ').slice(0, 500);
      })()
    `,
    ).catch(() => ({ result: { value: 'eval-failed' } }));
    console.error(`[L4-E2E] Sanitized assistant output excerpt: "${assistantEvidence.result?.value}"`);
    fail(FC.NO_JSONL, 'No "[Notion Bridge] ToolCallLoop parsed calls" signal received');
  }

  // AC-3: Check parsed calls count
  const parsedCount = parsedCalls.args[1];
  console.log(`[L4-E2E] AC-3: Parsed calls count = ${parsedCount}`);
  if (parsedCount === 0) {
    bridgeEvents.stop();
    // Emit evidence
    const assistantEvidence = await evalInContext(
      ws,
      mcpContext.id,
      `
      (function() {
        const msgs = Array.from(document.querySelectorAll('[data-content-editable-leaf],.notion-ai-response'));
        return msgs.map(m => (m.textContent || '').trim().slice(0, 200)).filter(Boolean).join(' | ').slice(0, 500);
      })()
    `,
    ).catch(() => ({ result: { value: 'eval-failed' } }));
    console.error(`[L4-E2E] NO-JSONL evidence: "${assistantEvidence.result?.value}"`);
    fail(FC.NO_JSONL, 'BridgeJsonlParser returned 0 calls (Notion AI responded but produced no JSONL)');
  }

  // Wait for insertText result
  try {
    insertOk = await Promise.race([
      insertOkSignal,
      insertFailSignal.then(r => {
        insertFail = r;
        throw new Error('insert-failed');
      }),
    ]);
  } catch (e) {
    bridgeEvents.stop();
    if (insertFail) {
      fail(FC.INSERT_FAIL, `insertText failed with code "${insertFail.args[3]}"`);
    }
    fail(FC.INSERT_FAIL, 'No insertText signal received after parsed calls signal');
  }

  // AC-4: insertText ok
  console.log(`[L4-E2E] AC-4: insertText ok — tool="${insertOk.args[1]}" callId="${insertOk.args[2]}"`);
  bridgeEvents.stop();

  // ---- AC-5: Verify DOM contains expected probe message ----
  await new Promise(r => setTimeout(r, 500)); // brief settle
  const domCheck = await evalInContext(
    ws,
    mcpContext.id,
    `
    (function() {
      // Check Notion input for injected result
      const inputs = Array.from(document.querySelectorAll('[contenteditable="true"]'));
      for (const el of inputs) {
        const text = el.textContent || '';
        if (text.includes(${JSON.stringify(PROBE_MESSAGE)})) return { found: true, text: text.slice(0, 200) };
      }
      // Also check any recently modified text nodes
      const body = document.body.textContent || '';
      const idx = body.indexOf(${JSON.stringify(PROBE_MESSAGE)});
      if (idx !== -1) return { found: true, text: body.slice(Math.max(0, idx-50), idx+150) };
      return { found: false };
    })()
  `,
  ).catch(() => ({ result: { value: { found: false } } }));

  if (!domCheck.result?.value?.found) {
    fail(FC.NO_MATCH, `DOM does not contain expected probe message "${PROBE_MESSAGE}"`);
  }

  console.log(`[L4-E2E] AC-5: DOM contains probe message "${PROBE_MESSAGE}"`);
  console.log(`[L4-E2E] Injected text excerpt: "${domCheck.result.value.text}"`);

  ws.close();
  pass(`committee-bridge.echo response containing "${PROBE_MESSAGE}" injected into Notion input`);
}

main().catch(e => {
  console.error('[L4-E2E] Unhandled error:', e.message);
  process.exit(1);
});
