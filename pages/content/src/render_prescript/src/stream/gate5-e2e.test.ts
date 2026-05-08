/**
 * Gate 5 E2E Integration Test
 *
 * Verifies the complete auto-submit loop + error injection + circuit breaker
 * using the real bridge initialization path (streamToolBridgeInit → streamToolBridge).
 *
 * Run: node --experimental-strip-types --import ./streamToolBridge.smoke.loader.mjs gate5-e2e.test.ts
 * (from render_prescript/src/stream/ directory)
 */

// --- Browser globals mock ---
(globalThis as any).window = globalThis;
(globalThis as any).document = { querySelectorAll: () => [], addEventListener: () => {} };
(globalThis as any).localStorage = {
  _store: {} as Record<string, string>,
  getItem(k: string) { return this._store[k] ?? null; },
  setItem(k: string, v: string) { this._store[k] = v; },
  removeItem(k: string) { delete this._store[k]; },
};
(globalThis as any).location = { href: 'https://www.notion.so/test-page', hostname: 'www.notion.so', origin: 'https://www.notion.so' };

// --- Mock MCP client ---
const toolCalls: Array<{ name: string; params: Record<string, unknown> }> = [];
let toolError: Error | null = null;
let toolDelay = 0;
(globalThis as any).mcpClient = {
  isReady: () => true,
  callTool: async (name: string, params: Record<string, unknown>) => {
    toolCalls.push({ name, params });
    if (toolDelay > 0) await new Promise(r => setTimeout(r, toolDelay));
    if (toolError) throw toolError;
    return { content: [{ type: 'text', text: JSON.stringify({ echo: params }) }] };
  },
};

// --- Mock adapter (autoInsert + autoSubmit path) ---
const insertedTexts: string[] = [];
let submitCount = 0;
let inputContent = '';
let insertShouldThrow = false;
(globalThis as any).mcpAdapter = {
  insertText: async (text: string) => {
    if (insertShouldThrow) throw new Error('DOM gone');
    insertedTexts.push(text);
    return true;
  },
  submitForm: async () => {
    submitCount++;
    return true;
  },
  getInputContent: () => inputContent,
};

// --- Mock postMessage ---
(globalThis as any).addEventListener = (type: string, handler: (e: any) => void) => {
  if (type === 'message') {
    (globalThis as any).__messageHandler = handler;
  }
};
(globalThis as any).postMessage = () => {};

// --- Import real modules ---
import { executionGuardStore } from '../mcpexecute/executionGuard.ts';
import {
  configureStreamToolBridge,
  initStreamToolBridge,
} from './streamToolBridgeInit.ts';

// --- Test helpers ---
const assert = (cond: boolean, msg: string) => {
  if (!cond) throw new Error(`❌ FAIL: ${msg}`);
};
let passed = 0;
const total = 7;
let streamCounter = 0;

function resetMocks() {
  toolCalls.length = 0;
  insertedTexts.length = 0;
  submitCount = 0;
  inputContent = '';
  toolError = null;
  toolDelay = 0;
  insertShouldThrow = false;
  executionGuardStore.clear();
}

function makeStreamCutoffMessage(toolName: string, callId: string, args: string, streamId?: string) {
  streamCounter++;
  return {
    data: {
      channel: 'mcp-superassistant.stream',
      direction: 'main-to-isolated',
      version: 1,
      source: 'notion-main-fetch-interceptor',
      event: {
        type: 'stream_cutoff',
        streamId: streamId || `test-stream-gate5-${String(streamCounter).padStart(3, '0')}`,
        cutoffChunkIndex: 5,
        elapsedMs: 1000,
        identity: {
          name: toolName,
          callId,
          arguments: args,
        },
        reason: 'function_call_detected',
        forwardedTriggerChunk: true,
        mode: 'drain-drop',
      },
    },
    source: globalThis,
    origin: 'https://www.notion.so',
  };
}

console.log('\n🧪 Gate 5 E2E Integration Test — AutoSubmit + Error Injection + Circuit Breaker\n');

// ═══════════════════════════════════════════════════════
// Setup: Initialize and activate bridge with autoInsert + autoSubmit
// ═══════════════════════════════════════════════════════
initStreamToolBridge();
configureStreamToolBridge({
  enabled: true,
  cutoffEnabled: true,
  autoInsert: true,
  autoSubmit: true,
});

const messageHandler = (globalThis as any).__messageHandler;
assert(messageHandler !== undefined, 'Expected message handler installed');

// ═══════════════════════════════════════════════════════
// Test 1: AutoSubmit — tool executes → result inserted → form submitted
// ═══════════════════════════════════════════════════════
resetMocks();

messageHandler(makeStreamCutoffMessage('echo', 'call_auto_001', '{"msg":"hi"}'));
await new Promise(resolve => setTimeout(resolve, 100));

assert(toolCalls.length === 1, `Expected 1 tool call, got ${toolCalls.length}`);
assert(toolCalls[0].name === 'echo', `Expected 'echo', got '${toolCalls[0].name}'`);
assert(insertedTexts.length === 1, `Expected 1 insert, got ${insertedTexts.length}`);
assert(insertedTexts[0].includes('function_results'), 'Expected function_results XML in inserted text');
assert(insertedTexts[0].includes('status="success"'), 'Expected status="success" in inserted text');
assert(submitCount === 1, `Expected 1 submit, got ${submitCount}`);
passed++;
console.log('  ✅ 1. AutoSubmit: echo({"msg":"hi"}) → insertText + submitForm called');

// ═══════════════════════════════════════════════════════
// Test 2: AutoSubmit with draft text → skip insertion (user has draft)
// ═══════════════════════════════════════════════════════
resetMocks();
inputContent = 'user is typing something';

messageHandler(makeStreamCutoffMessage('echo', 'call_draft_001', '{"msg":"test"}'));
await new Promise(resolve => setTimeout(resolve, 100));

assert(toolCalls.length === 1, `Expected 1 tool call, got ${toolCalls.length}`);
assert(insertedTexts.length === 0, `Expected 0 inserts (draft detected), got ${insertedTexts.length}`);
assert(submitCount === 0, `Expected 0 submits (draft detected), got ${submitCount}`);
passed++;
console.log('  ✅ 2. Draft detection: user draft → skip insert + submit');

// ═══════════════════════════════════════════════════════
// Test 3: Error injection — tool throws → error result inserted + submitted
// ═══════════════════════════════════════════════════════
resetMocks();
toolError = new Error('API unavailable');

messageHandler(makeStreamCutoffMessage('failing_tool', 'call_err_001', '{"x":1}'));
await new Promise(resolve => setTimeout(resolve, 100));

assert(toolCalls.length === 1, `Expected 1 tool call, got ${toolCalls.length}`);
assert(insertedTexts.length === 1, `Expected 1 insert (error result), got ${insertedTexts.length}`);
assert(insertedTexts[0].includes('status="error"'), 'Expected status="error" in error result');
assert(insertedTexts[0].includes('API unavailable'), 'Expected error message in result');
assert(submitCount === 1, `Expected 1 submit (error auto-submit), got ${submitCount}`);
passed++;
console.log('  ✅ 3. Error injection: tool throws → error result injected + submitted');

// ═══════════════════════════════════════════════════════
// Test 4: Circuit breaker — blocks after max calls per stream
// ═══════════════════════════════════════════════════════
resetMocks();
// Reconfigure with max 3 calls per stream for testing
configureStreamToolBridge({
  enabled: true,
  cutoffEnabled: true,
  autoInsert: true,
  autoSubmit: true,
  circuitBreaker: { maxToolCallsPerStream: 3 },
});

const sharedStreamId = 'stream-circuit-breaker-test';
for (let i = 0; i < 5; i++) {
  messageHandler(makeStreamCutoffMessage('echo', `call_cb_${i}`, '{}', sharedStreamId));
  await new Promise(resolve => setTimeout(resolve, 50));
}

assert(toolCalls.length === 3, `Expected 3 tool calls (breaker at 3), got ${toolCalls.length}`);
passed++;
console.log('  ✅ 4. Circuit breaker: max 3 per stream → blocks calls 4 and 5');

// ═══════════════════════════════════════════════════════
// Test 5: Circuit breaker — different streams are independent
// ═══════════════════════════════════════════════════════
resetMocks();

// 3 calls on stream A
for (let i = 0; i < 3; i++) {
  messageHandler(makeStreamCutoffMessage('echo', `call_a_${i}`, '{}', 'stream-A'));
  await new Promise(resolve => setTimeout(resolve, 50));
}
// 3 calls on stream B
for (let i = 0; i < 3; i++) {
  messageHandler(makeStreamCutoffMessage('echo', `call_b_${i}`, '{}', 'stream-B'));
  await new Promise(resolve => setTimeout(resolve, 50));
}

assert(toolCalls.length === 6, `Expected 6 tool calls (3 per stream), got ${toolCalls.length}`);
passed++;
console.log('  ✅ 5. Circuit breaker: streams A and B independent — 3+3=6 calls');

// ═══════════════════════════════════════════════════════
// Test 6: autoInsert=false + autoSubmit=true → no insert, no submit
// ═══════════════════════════════════════════════════════
resetMocks();
configureStreamToolBridge({
  enabled: true,
  cutoffEnabled: true,
  autoInsert: false,
  autoSubmit: true,  // should be ignored when autoInsert is false
});

messageHandler(makeStreamCutoffMessage('echo', 'call_noi_001', '{"x":1}'));
await new Promise(resolve => setTimeout(resolve, 100));

assert(toolCalls.length === 1, `Expected 1 tool call, got ${toolCalls.length}`);
assert(insertedTexts.length === 0, `Expected 0 inserts (autoInsert=false), got ${insertedTexts.length}`);
assert(submitCount === 0, `Expected 0 submits (autoInsert=false), got ${submitCount}`);
passed++;
console.log('  ✅ 6. autoInsert=false → no insert, no submit even with autoSubmit=true');

// ═══════════════════════════════════════════════════════
// Test 7: insertText throws → error logged, no submit
// ═══════════════════════════════════════════════════════
resetMocks();
insertShouldThrow = true;
configureStreamToolBridge({
  enabled: true,
  cutoffEnabled: true,
  autoInsert: true,
  autoSubmit: true,
});

messageHandler(makeStreamCutoffMessage('echo', 'call_ins_err_001', '{"x":1}'));
await new Promise(resolve => setTimeout(resolve, 100));

assert(toolCalls.length === 1, `Expected 1 tool call, got ${toolCalls.length}`);
assert(submitCount === 0, `Expected 0 submits (insert failed), got ${submitCount}`);
passed++;
console.log('  ✅ 7. insertText throws → graceful failure, no submit');

// ═══════════════════════════════════════════════════════
// Summary
// ═══════════════════════════════════════════════════════
console.log(`\n🎯 Gate 5 E2E: ${passed}/${total} tests passed\n`);
if (passed < total) {
  process.exit(1);
}
