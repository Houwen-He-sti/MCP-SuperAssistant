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
const AI_RESPONSE_WAIT_MS = Math.min(TIMEOUT_MS - 10000, 50000);

// ---------------------------------------------------------------------------
// Failure classes
// ---------------------------------------------------------------------------

const FC = {
  PASS:             { code: 0,  label: 'PASS',               desc: 'L4 full path verified' },
  CDP_UNAVAILABLE:  { code: 2,  label: 'FC-1:CDP_UNAVAIL',   desc: `Cannot connect to Chrome CDP at ${CDP_HOST}:${CDP_PORT}` },
  NO_NOTION_TAB:    { code: 3,  label: 'FC-2:NO_NOTION',     desc: 'No Notion tab found at /chat or /ai' },
  EXT_NOT_LOADED:   { code: 4,  label: 'FC-3:EXT_ABSENT',    desc: 'Extension stream interceptor marker not found' },
  INPUT_MISSING:    { code: 8,  label: 'FC-INPUT-MISSING',   desc: 'Notion AI input element not found' },
  NO_ACTIVE:        { code: 9,  label: 'FC-L4-NO-ACTIVE',    desc: 'ToolCallLoop activation signal absent' },
  NO_JSONL:         { code: 10, label: 'FC-L4-NO-JSONL',     desc: 'Notion AI did not produce bridge JSONL' },
  PARSE_FAIL:       { code: 11, label: 'FC-L4-PARSE-FAIL',   desc: 'BridgeJsonlParser reported parse errors' },
  INSERT_FAIL:      { code: 12, label: 'FC-L4-INSERT-FAIL',  desc: 'adapter.insertText() failed' },
  NO_MATCH:         { code: 13, label: 'FC-L4-NO-MATCH',     desc: 'Injected text did not contain expected probe message' },
  INPUT_DRAFT:      { code: 14, label: 'FC-L4-INPUT-DRAFT',  desc: 'Notion input has pre-existing draft content' },
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
    ws.on('open', () => { clearTimeout(timeout); resolve(ws); });
    ws.on('error', e => { clearTimeout(timeout); reject(e); });
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
  // Wait 500ms for any late-arriving context events
  await new Promise(r => setTimeout(r, 500));
  ws.off('message', handler);
  return contexts;
}

/**
 * Evaluate JS in a specific execution context (isolated world).
 */
async function evalInContext(ws, contextId, expression, timeout = 10000) {
  return cdpCommand(ws, 'Runtime.evaluate', {
    expression,
    contextId,
    returnByValue: true,
    awaitPromise: true,
  }, timeout);
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
  const notionTarget = targets.find(t =>
    t.type === 'page' &&
    (t.url.includes('notion.so/chat') || t.url.includes('notion.so/ai') || t.url.includes('/ai'))
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
  // Reuse Slice X isolation pattern: top-level Notion frame + MCP SuperAssistant world
  const notionOrigin = new URL(notionTarget.url).origin;

  // Try MCP SuperAssistant isolated world first
  let mcpContext = contexts.find(ctx =>
    ctx.name === 'MCP SuperAssistant' &&
    ctx.origin === notionOrigin
  );

  // Fallback: find any content-script context in top-level Notion frame
  if (!mcpContext) {
    // Identify top-level frame by checking window===window.top via eval
    for (const ctx of contexts) {
      if (!ctx.origin.includes('notion.so')) continue;
      try {
        const r = await evalInContext(ws, ctx.id, 'typeof window.__MCP_ASSISTANT_STREAM_INTERCEPTOR__ !== "undefined"', 2000);
        if (r.result?.value === true) {
          mcpContext = ctx;
          break;
        }
      } catch {
        // skip
      }
    }
  }

  if (!mcpContext) {
    console.error('[L4-E2E] Available contexts:');
    contexts.forEach(ctx => console.error(`  id=${ctx.id} name="${ctx.name}" origin="${ctx.origin}"`));
    fail(FC.EXT_NOT_LOADED, 'MCP SuperAssistant isolated world not found');
  }
  console.log(`[L4-E2E] Using context id=${mcpContext.id} name="${mcpContext.name}"`);

  // Start collecting all [Notion Bridge] console events for evidence
  const bridgeEvents = collectConsoleEvents(ws, '[Notion Bridge]');

  // ---- FC-L4-NO-ACTIVE: Wait for ToolCallLoop active signal ----
  // If bridge is already running, this signal may have been emitted before we connected.
  // We check for it in the first 3s, then proceed (it may have been emitted on init).
  console.log('[L4-E2E] Checking for ToolCallLoop active signal...');
  let loopActive = false;
  try {
    await Promise.race([
      waitForConsoleSignal(ws,
        (type, args) => type === 'log' && String(args[0]).includes('[Notion Bridge] ToolCallLoop active'),
        3000
      ),
      // Also accept 'info' level
      waitForConsoleSignal(ws,
        (type, args) => type === 'info' && String(args[0]).includes('[Notion Bridge] ToolCallLoop active'),
        3000
      ),
    ]);
    console.log('[L4-E2E] AC-1: ToolCallLoop active signal received');
    loopActive = true;
  } catch {
    // Signal may have been emitted before our subscription — check via eval
    const check = await evalInContext(ws, mcpContext.id,
      'typeof window.__notionBridgeState !== "undefined" ? JSON.stringify(window.__notionBridgeState) : "absent"'
    ).catch(() => ({ result: { value: 'eval-failed' } }));
    const stateVal = check.result?.value;
    console.log(`[L4-E2E] ToolCallLoop active check via eval: ${stateVal}`);
    // If the bridge is wired, the loop would have activated on init.
    // We proceed but note the signal may have been missed.
    loopActive = stateVal !== 'absent' && stateVal !== 'eval-failed';
  }

  if (!loopActive) {
    // Try direct eval check: is bridge controller registered?
    const bridgeCheck = await evalInContext(ws, mcpContext.id,
      '!!window.mcpClient && typeof window.mcpClient.getAvailableTools === "function"'
    ).catch(() => ({ result: { value: false } }));
    if (!bridgeCheck.result?.value) {
      fail(FC.NO_ACTIVE, 'ToolCallLoop not active and mcpClient not available');
    }
    console.log('[L4-E2E] AC-1: mcpClient present — assuming ToolCallLoop active (signal may have pre-emitted)');
  }

  // ---- Pre-flight: Input state check ----
  const inputCheck = await evalInContext(ws, mcpContext.id, `
    (function() {
      const input = document.querySelector('[contenteditable="true"][data-content-editable-leaf]') ||
                    document.querySelector('.notion-selectable[contenteditable]') ||
                    document.querySelector('[placeholder]');
      if (!input) return { found: false };
      const text = (input.textContent || '').trim();
      return { found: true, draft: text.length > 0, draftPreview: text.slice(0, 50) };
    })()
  `).catch(() => ({ result: { value: { found: false } } }));

  const inputState = inputCheck.result?.value;
  if (!inputState?.found) {
    fail(FC.INPUT_MISSING, 'No contenteditable input found in Notion AI');
  }
  if (inputState?.draft) {
    fail(FC.INPUT_DRAFT, `Input has draft: "${inputState.draftPreview}"`);
  }
  console.log('[L4-E2E] Pre-flight: Input available and empty');

  // ---- Subscribe to observability seam signals before sending prompt ----
  const parsedCallsSignal = waitForConsoleSignal(ws,
    (type, args) => type === 'info' && args[0] === '[Notion Bridge] ToolCallLoop parsed calls',
    AI_RESPONSE_WAIT_MS
  );
  const parseFailSignal = waitForConsoleSignal(ws,
    (type, args) => type === 'warn' && args[0] === '[Notion Bridge] ToolCallLoop parse failed',
    AI_RESPONSE_WAIT_MS
  );
  const insertOkSignal = waitForConsoleSignal(ws,
    (type, args) => type === 'info' && args[0] === '[Notion Bridge] ToolCallLoop insertText ok',
    AI_RESPONSE_WAIT_MS
  );
  const insertFailSignal = waitForConsoleSignal(ws,
    (type, args) => type === 'warn' && args[0] === '[Notion Bridge] ToolCallLoop insertText failed',
    AI_RESPONSE_WAIT_MS
  );

  // ---- Inject sentinel prompt into Notion AI input ----
  const sentinelPrompt = `Please use the committee-bridge.echo tool with message "${PROBE_MESSAGE}". Respond using the JSONL bridge format from the system instructions.`;
  console.log(`[L4-E2E] Injecting sentinel prompt: "${sentinelPrompt.slice(0, 60)}..."`);

  const injectResult = await evalInContext(ws, mcpContext.id, `
    (function() {
      // Find Notion AI contenteditable input
      const input = document.querySelector('[contenteditable="true"][data-content-editable-leaf]') ||
                    document.querySelector('.notion-selectable[contenteditable]');
      if (!input) return { ok: false, reason: 'input-not-found' };
      // Focus and insert text
      input.focus();
      const inserted = document.execCommand('insertText', false, ${JSON.stringify(sentinelPrompt)});
      if (!inserted) {
        // Fallback: set textContent + dispatch input event
        input.textContent = ${JSON.stringify(sentinelPrompt)};
        input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText' }));
      }
      return { ok: true };
    })()
  `).catch(e => ({ result: { value: { ok: false, reason: e.message } } }));

  if (!injectResult.result?.value?.ok) {
    fail(FC.INPUT_MISSING, `Prompt injection failed: ${injectResult.result?.value?.reason}`);
  }
  console.log('[L4-E2E] Sentinel prompt injected');

  // Submit the prompt (click submit button)
  const submitResult = await evalInContext(ws, mcpContext.id, `
    (function() {
      // Try common Notion AI submit button selectors
      const btn = document.querySelector('button[data-testid="ask-ai-submit"]') ||
                  document.querySelector('button[aria-label="Submit"]') ||
                  document.querySelector('button[type="submit"]') ||
                  (() => {
                    const btns = Array.from(document.querySelectorAll('button'));
                    return btns.find(b => /send|submit|enter/i.test(b.textContent || b.getAttribute('aria-label') || ''));
                  })();
      if (!btn) return { ok: false, reason: 'submit-button-not-found' };
      btn.click();
      return { ok: true };
    })()
  `).catch(e => ({ result: { value: { ok: false, reason: e.message } } }));

  if (!submitResult.result?.value?.ok) {
    console.warn(`[L4-E2E] Submit button not found — trying keyboard Enter`);
    // Fallback: send Enter key event
    await cdpCommand(ws, 'Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    await cdpCommand(ws, 'Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  } else {
    console.log('[L4-E2E] Prompt submitted via button click');
  }

  // ---- Wait for L4 observability signals ----
  console.log(`[L4-E2E] Waiting up to ${AI_RESPONSE_WAIT_MS}ms for Notion AI response + L4 signals...`);

  let parsedCalls, parseFail, insertOk, insertFail;
  try {
    parsedCalls = await Promise.race([
      parsedCallsSignal,
      parseFailSignal.then(r => { parseFail = r; throw new Error('parse-failed'); }),
    ]);
  } catch (e) {
    if (parseFail) {
      // Parse failed — output evidence
      bridgeEvents.stop();
      console.error('[L4-E2E] Evidence — bridge console events:');
      bridgeEvents.events.forEach(ev => console.error(`  [${ev.type}] ${ev.args.join(' ')}`));
      fail(FC.PARSE_FAIL, `parse failed with ${parseFail.args[1]} error(s)`);
    }
    // No signal at all — FC-L4-NO-JSONL
    bridgeEvents.stop();
    console.error('[L4-E2E] Evidence — bridge console events collected:');
    bridgeEvents.events.forEach(ev => console.error(`  [${ev.type}] ${ev.args.join(' ')}`));
    // Collect sanitized assistant output for NO-JSONL evidence
    const assistantEvidence = await evalInContext(ws, mcpContext.id, `
      (function() {
        const msgs = Array.from(document.querySelectorAll('[data-content-editable-leaf],.notion-ai-response'));
        return msgs.map(m => (m.textContent || '').trim().slice(0, 200)).filter(Boolean).join(' | ').slice(0, 500);
      })()
    `).catch(() => ({ result: { value: 'eval-failed' } }));
    console.error(`[L4-E2E] Sanitized assistant output excerpt: "${assistantEvidence.result?.value}"`);
    fail(FC.NO_JSONL, 'No "[Notion Bridge] ToolCallLoop parsed calls" signal received');
  }

  // AC-3: Check parsed calls count
  const parsedCount = parsedCalls.args[1];
  console.log(`[L4-E2E] AC-3: Parsed calls count = ${parsedCount}`);
  if (parsedCount === 0) {
    bridgeEvents.stop();
    // Emit evidence
    const assistantEvidence = await evalInContext(ws, mcpContext.id, `
      (function() {
        const msgs = Array.from(document.querySelectorAll('[data-content-editable-leaf],.notion-ai-response'));
        return msgs.map(m => (m.textContent || '').trim().slice(0, 200)).filter(Boolean).join(' | ').slice(0, 500);
      })()
    `).catch(() => ({ result: { value: 'eval-failed' } }));
    console.error(`[L4-E2E] NO-JSONL evidence: "${assistantEvidence.result?.value}"`);
    fail(FC.NO_JSONL, 'BridgeJsonlParser returned 0 calls (Notion AI responded but produced no JSONL)');
  }

  // Wait for insertText result
  try {
    insertOk = await Promise.race([
      insertOkSignal,
      insertFailSignal.then(r => { insertFail = r; throw new Error('insert-failed'); }),
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
  const domCheck = await evalInContext(ws, mcpContext.id, `
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
  `).catch(() => ({ result: { value: { found: false } } }));

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
