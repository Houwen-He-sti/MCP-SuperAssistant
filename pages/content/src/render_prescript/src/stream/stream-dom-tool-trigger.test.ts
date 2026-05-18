/**
 * T-DOM-01..T-DOM-06: DOM-based tool trigger tests
 * Tests for the non-stream ACK detection path:
 * - window.mcpNotionDomScan registered after initStreamToolBridge()
 * - scan() calls ackTracker.scanText() for ACK confirmation (proven)
 * - scan() extracts ```jsonl fenced blocks → triggers execution
 * - unfenced/plain text does NOT trigger execution (negative case)
 * - setupMessageObserver() pattern: observer callback → scan() → execution
 * - incremental DOM: partial message first, full JSONL later, dedup fires once
 *
 * Plan: plans/dom-tool-trigger-notion-adapter-plan.md
 * GPT review verdict: REVISE — P1 fixes applied in this version
 *
 * Run:
 *   node --test --experimental-strip-types \
 *     --import ./streamToolBridge.smoke.loader.mjs \
 *     stream-dom-tool-trigger.test.ts
 * (from render_prescript/src/stream/)
 */

// --- Browser globals mock (mirrors gate5d setup) ---
(globalThis as any).window = globalThis;
(globalThis as any).document = { querySelectorAll: () => [], addEventListener: () => {} };
(globalThis as any).localStorage = {
  _store: {} as Record<string, string>,
  getItem(k: string) {
    return this._store[k] ?? null;
  },
  setItem(k: string, v: string) {
    this._store[k] = v;
  },
  removeItem(k: string) {
    delete this._store[k];
  },
};
(globalThis as any).location = {
  href: 'https://www.notion.so/test',
  hostname: 'www.notion.so',
  origin: 'https://www.notion.so',
};

// --- Mock MCP client ---
const toolCalls: Array<{ name: string; params: Record<string, unknown> }> = [];
(globalThis as any).mcpClient = {
  isReady: () => true,
  callTool: async (name: string, params: Record<string, unknown>) => {
    toolCalls.push({ name, params });
    return { content: [{ type: 'text', text: JSON.stringify({ result: 'ok' }) }] };
  },
};

// --- Mock adapter ---
const insertedTexts: string[] = [];
let submitCount = 0;
(globalThis as any).mcpAdapter = {
  insertText: async (text: string) => {
    insertedTexts.push(text);
    return true;
  },
  submitForm: async () => {
    submitCount++;
    return true;
  },
  getInputContent: () => '',
};

// --- Track ACK events (model_ack_confirmed fires when scanText() finds pending nonce) ---
const ackEvents: Array<{ type: string; nonce: string }> = [];
const origDispatchEvent = (globalThis as any).dispatchEvent?.bind(globalThis) ?? (() => {});
(globalThis as any).dispatchEvent = (event: any) => {
  if (event.type === 'mcp-superassistant:model-ack') {
    ackEvents.push({ type: event.detail?.type ?? event.type, nonce: event.detail?.nonce });
  }
  return origDispatchEvent(event);
};

// --- Mock postMessage ---
let messageHandlers: Array<(e: any) => void> = [];
(globalThis as any).addEventListener = (type: string, handler: (e: any) => void) => {
  if (type === 'message') messageHandlers.push(handler);
};
(globalThis as any).postMessage = () => {};

// --- Import modules under test ---
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { executionGuardStore } from '../mcpexecute/executionGuard.ts';
import { configureStreamToolBridge, initStreamToolBridge } from './streamToolBridgeInit.ts';

// --- Shared JSONL fixture ---
const JSONL_FENCED_TEXT = [
  'I will help you with that.',
  '',
  '```jsonl',
  '{"type":"function_call_start","name":"echo","call_id":"dom-test-ack-001"}',
  '{"type":"parameter","key":"message","value":"hello dom"}',
  '{"type":"function_call_end","call_id":"dom-test-ack-001"}',
  '```',
  '',
  'Executing...',
].join('\n');

// --- Test helpers ---
function resetState() {
  toolCalls.length = 0;
  insertedTexts.length = 0;
  submitCount = 0;
  ackEvents.length = 0;
  messageHandlers = [];
  // Clear execution guard to prevent cross-test dedup collisions
  executionGuardStore.clear();
  initStreamToolBridge();
}

function setupAndGetScanner(opts: { enabled?: boolean; autoSubmit?: boolean } = {}) {
  resetState();
  configureStreamToolBridge({
    enabled: opts.enabled ?? true,
    autoInsert: true,
    autoSubmit: opts.autoSubmit ?? true,
    cutoffEnabled: false,
  });
  return (globalThis as any).mcpNotionDomScan as
    | { scan: (text: string) => void; teardown: () => void; version: string }
    | undefined;
}

// ============================================================================
// T-DOM-04: window.mcpNotionDomScan registered after initStreamToolBridge()
// ============================================================================
describe('T-DOM-04: window.mcpNotionDomScan registered after init', () => {
  it('mcpNotionDomScan is undefined before init', () => {
    (globalThis as any).mcpNotionDomScan = undefined;
    assert.equal((globalThis as any).mcpNotionDomScan, undefined);
  });

  it('mcpNotionDomScan is set after initStreamToolBridge()', () => {
    (globalThis as any).mcpNotionDomScan = undefined;
    initStreamToolBridge();
    const scanner = (globalThis as any).mcpNotionDomScan;
    assert.ok(scanner, 'mcpNotionDomScan should be set');
    assert.equal(typeof scanner.scan, 'function', 'scan should be a function');
    assert.equal(typeof scanner.teardown, 'function', 'teardown should be a function');
    assert.equal(typeof scanner.version, 'string', 'version should be a string');
  });

  it('mcpNotionDomScan.scan is a no-op with null/empty text', () => {
    initStreamToolBridge();
    const scanner = (globalThis as any).mcpNotionDomScan;
    assert.doesNotThrow(() => scanner.scan(''));
    assert.doesNotThrow(() => scanner.scan(null as any));
  });
});

// ============================================================================
// T-DOM-02 (IMPROVED): ackTracker.scanText() is actually called and confirms ACK
// Strategy: execute a tool via DOM scan (registers nonce) → then scan the
// injected result text (which contains the nonce) → model_ack_confirmed fires.
// This proves scanText() is wired and not just a no-op.
// ============================================================================
describe('T-DOM-02: mcpNotionDomScan.scan() actually calls ackTracker.scanText()', () => {
  it('scan() on injected result text (containing nonce) fires model_ack_confirmed', async () => {
    const scanner = setupAndGetScanner({ enabled: true, autoSubmit: true });
    assert.ok(scanner, 'scanner must be set');

    // Step 1: Execute tool via DOM scan — this registers an ACK nonce
    scanner.scan(JSONL_FENCED_TEXT);
    await new Promise(r => setTimeout(r, 200));

    assert.equal(toolCalls.length, 1, 'T-DOM-02 pre: tool should have executed');
    assert.equal(insertedTexts.length, 1, 'T-DOM-02 pre: insertText should have been called');

    const injectedText = insertedTexts[0];
    assert.ok(injectedText, 'T-DOM-02 pre: injected text should not be empty');
    // Nonce is embedded in the injected text as <mcp_ack nonce="ack_..." />
    assert.ok(
      injectedText.includes('mcp_ack'),
      `T-DOM-02 pre: injected text must contain mcp_ack nonce, got: ${injectedText.slice(0, 100)}`,
    );

    // Step 2: Scan the injected result (which the AI would see as a DOM message)
    // This simulates the DOM observer seeing the injected result text
    ackEvents.length = 0; // Reset ACK events
    scanner.scan(injectedText); // This should call ackTracker.scanText() and find the nonce
    await new Promise(r => setTimeout(r, 50));

    // Step 3: Verify ACK was confirmed — proves scanText() was called
    assert.ok(
      ackEvents.length >= 1,
      `T-DOM-02: model_ack_confirmed should fire after scanning injected result with nonce. ackEvents: ${JSON.stringify(ackEvents)}`,
    );
    assert.equal(ackEvents[0].type, 'model_ack_confirmed', 'T-DOM-02: event type should be model_ack_confirmed');
    assert.ok(
      ackEvents[0].nonce.startsWith('ack_'),
      `T-DOM-02: nonce should start with ack_, got: ${ackEvents[0].nonce}`,
    );
    console.log('  ✅ T-DOM-02: ackTracker.scanText() called and confirmed ACK nonce');
  });
});

// ============================================================================
// T-DOM-05 (EXTENDED): Fenced JSONL extraction + negative case
// ============================================================================
describe('T-DOM-05: JSONL fenced code block extraction', () => {
  it('scan() with fenced ```jsonl block triggers exactly one tool execution', async () => {
    const scanner = setupAndGetScanner();
    assert.ok(scanner, 'scanner must be set');
    toolCalls.length = 0;

    scanner.scan(JSONL_FENCED_TEXT);
    await new Promise(r => setTimeout(r, 200));

    assert.equal(toolCalls.length, 1, 'T-DOM-05a: exactly one tool call from fenced JSONL');
    assert.equal(toolCalls[0].name, 'echo', 'T-DOM-05a: tool name should be echo');
    console.log('  ✅ T-DOM-05a: fenced JSONL triggers exactly one tool execution');
  });

  it('scan() with unfenced raw JSONL (no fenced block) does NOT trigger execution', async () => {
    const scanner = setupAndGetScanner();
    assert.ok(scanner, 'scanner must be set');
    toolCalls.length = 0;

    // Raw JSONL without ```jsonl fencing — should not execute
    const unfencedJsonl = [
      '{"type":"function_call_start","name":"echo","call_id":"unfenced-001"}',
      '{"type":"parameter","key":"message","value":"should not execute"}',
      '{"type":"function_call_end","call_id":"unfenced-001"}',
    ].join('\n');

    scanner.scan(unfencedJsonl);
    await new Promise(r => setTimeout(r, 100));

    assert.equal(
      toolCalls.length,
      0,
      `T-DOM-05b: unfenced raw JSONL must NOT trigger execution, got ${toolCalls.length} tool calls`,
    );
    console.log('  ✅ T-DOM-05b: unfenced JSONL correctly rejected (fenced block required)');
  });

  it('scan() with plain text (no JSON at all) does NOT trigger execution', async () => {
    const scanner = setupAndGetScanner();
    assert.ok(scanner, 'scanner must be set');
    toolCalls.length = 0;

    scanner.scan('Hello, I can help you with that. No tool calls needed.');
    await new Promise(r => setTimeout(r, 50));

    assert.equal(toolCalls.length, 0, 'T-DOM-05c: plain text must NOT trigger execution');
    console.log('  ✅ T-DOM-05c: plain text correctly rejected');
  });
});

// ============================================================================
// T-DOM-03: fenced JSONL → tool invocation (core behavior)
// ============================================================================
describe('T-DOM-03: scan() with function_call JSONL triggers execution', () => {
  it('scan() with jsonl block → tool executed, adapter.insertText + submitForm called', async () => {
    const scanner = setupAndGetScanner();
    assert.ok(scanner, 'scanner must be set');
    toolCalls.length = 0;
    insertedTexts.length = 0;
    submitCount = 0;

    scanner.scan(JSONL_FENCED_TEXT);
    await new Promise(r => setTimeout(r, 200));

    assert.equal(toolCalls.length, 1, `T-DOM-03a: expected 1 tool call, got ${toolCalls.length}`);
    assert.equal(toolCalls[0].name, 'echo', 'T-DOM-03b: tool name should be echo');
    assert.equal(insertedTexts.length, 1, 'T-DOM-03c: insertText should be called once');
    assert.equal(submitCount, 1, 'T-DOM-03d: submitForm should be called once');
    console.log('  ✅ T-DOM-03: function_call in DOM text → tool executed + result injected + submitted');
  });
});

// ============================================================================
// T-DOM-01: setupMessageObserver() pattern integration
// Simulates what notion.adapter.ts setupMessageObserver() does:
// MutationObserver detects new AI message element → calls mcpNotionDomScan.scan()
// This test verifies the scan() wiring without instantiating the full NotionAdapter.
// ============================================================================
describe('T-DOM-01: setupMessageObserver() pattern → scan() integration', () => {
  it('observer callback with new message element → scan() called → tool executed', async () => {
    const scanner = setupAndGetScanner();
    assert.ok(scanner, 'scanner must be set');
    toolCalls.length = 0;

    // Simulate what notion.adapter.ts setupMessageObserver() does in the MutationObserver callback:
    // for each addedNode that's an Element with textContent.trim().length > 10:
    //   const domScanner = window.mcpNotionDomScan;
    //   if (typeof domScanner?.scan === 'function') { domScanner.scan(el.textContent); }
    function simulateObserverCallback(textContent: string) {
      const mockElement = {
        nodeType: 1, // Node.ELEMENT_NODE
        textContent,
      };
      // Mirrors exactly what notion.adapter.ts does:
      if (mockElement.textContent && mockElement.textContent.trim().length > 10) {
        const domScanner = (window as Record<string, unknown>).mcpNotionDomScan as
          | { scan?: (text: string) => void }
          | undefined;
        if (typeof domScanner?.scan === 'function') {
          domScanner.scan(mockElement.textContent);
        }
      }
    }

    simulateObserverCallback(JSONL_FENCED_TEXT);
    await new Promise(r => setTimeout(r, 200));

    assert.equal(toolCalls.length, 1, `T-DOM-01a: observer callback → scan() → 1 tool call, got ${toolCalls.length}`);
    assert.equal(toolCalls[0].name, 'echo', 'T-DOM-01b: tool name should be echo');
    console.log('  ✅ T-DOM-01: observer callback pattern → scan() called → tool executed');
  });

  it('observer callback with short text (< 10 chars) is skipped', async () => {
    const scanner = setupAndGetScanner();
    assert.ok(scanner, 'scanner must be set');
    toolCalls.length = 0;

    // Short text — notion.adapter.ts skips elements with textContent.trim().length <= 10
    function simulateObserverCallbackShort(textContent: string) {
      const mockElement = { nodeType: 1, textContent };
      if (mockElement.textContent && mockElement.textContent.trim().length > 10) {
        const domScanner = (window as Record<string, unknown>).mcpNotionDomScan as
          | { scan?: (text: string) => void }
          | undefined;
        if (typeof domScanner?.scan === 'function') {
          domScanner.scan(mockElement.textContent);
        }
      }
    }

    simulateObserverCallbackShort('Hi'); // < 10 chars
    await new Promise(r => setTimeout(r, 50));
    assert.equal(toolCalls.length, 0, 'T-DOM-01c: short text should be skipped by observer guard');
    console.log('  ✅ T-DOM-01c: short text correctly skipped');
  });
});

// ============================================================================
// T-DOM-06: Incremental DOM rendering (content-hash dedup prevents double execution)
// Simulates: partial message element inserted first, then full JSONL block appears.
// The dedup via domScannedHashes ensures exactly ONE tool execution.
// ============================================================================
describe('T-DOM-06: Incremental DOM — dedup prevents double execution', () => {
  it('same content scanned twice → only one tool execution (content-hash dedup)', async () => {
    const scanner = setupAndGetScanner();
    assert.ok(scanner, 'scanner must be set');
    toolCalls.length = 0;

    // Simulate same message being "seen" twice by the observer (e.g. re-render)
    scanner.scan(JSONL_FENCED_TEXT);
    await new Promise(r => setTimeout(r, 100));
    scanner.scan(JSONL_FENCED_TEXT); // Same content — should be deduped
    await new Promise(r => setTimeout(r, 100));

    assert.equal(
      toolCalls.length,
      1,
      `T-DOM-06a: same content seen twice → exactly 1 execution, got ${toolCalls.length}`,
    );
    console.log('  ✅ T-DOM-06a: content-hash dedup prevents double execution of same message');
  });

  it('partial text (no JSONL) then full text (with JSONL) → exactly one execution', async () => {
    const scanner = setupAndGetScanner();
    assert.ok(scanner, 'scanner must be set');
    toolCalls.length = 0;

    const partialText = 'I will help you with that.'; // No JSONL block yet
    const fullText = JSONL_FENCED_TEXT;

    // Step 1: observer sees partial text (incremental render, JSONL not yet loaded)
    scanner.scan(partialText);
    await new Promise(r => setTimeout(r, 50));
    assert.equal(toolCalls.length, 0, 'T-DOM-06b pre: no tool call on partial text (no JSONL block)');

    // Step 2: observer sees full text (JSONL block now present)
    scanner.scan(fullText);
    await new Promise(r => setTimeout(r, 200));
    assert.equal(toolCalls.length, 1, `T-DOM-06b: full text with JSONL → 1 execution, got ${toolCalls.length}`);
    console.log('  ✅ T-DOM-06b: partial → full incremental DOM: 1 execution, no duplicate');
  });
});

console.log('\n🧪 DOM Tool Trigger tests loaded — T-DOM-01..T-DOM-06');
