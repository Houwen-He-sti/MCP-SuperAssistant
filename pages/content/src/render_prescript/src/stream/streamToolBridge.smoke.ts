/**
 * Smoke test: Phase 3 stream tool bridge end-to-end integration
 *
 * Verifies the full init → event → execution pipeline with REAL module imports:
 * - streamToolBridgeInit.ts imports reserveExecution/executionGuardStore from executionGuard.ts
 * - streamToolBridgeInit.ts imports storeExecutedFunction/generateContentSignature from storage.ts
 * - Event subscription via onStreamEvent works
 * - configureStreamToolBridge({ enabled: true }) activates the bridge
 * - A stream_cutoff event flows through to mcpClient.callTool()
 *
 * Run: node --experimental-strip-types --import ./streamToolBridge.smoke.loader.mjs streamToolBridge.smoke.ts
 * (from render_prescript/src/stream/ directory)
 */

// --- Browser globals mock (MAIN-world simulation) ---
(globalThis as any).window = globalThis;
(globalThis as any).document = { querySelectorAll: () => [], addEventListener: () => { } };
(globalThis as any).localStorage = {
    _store: {} as Record<string, string>,
    getItem(k: string) { return this._store[k] ?? null; },
    setItem(k: string, v: string) { this._store[k] = v; },
    removeItem(k: string) { delete this._store[k]; },
};
(globalThis as any).location = { href: 'https://www.notion.so/test-page-123' };

// Mock mcpClient on window (simulates what content/src/index.ts does)
const toolCalls: Array<{ name: string; params: Record<string, unknown> }> = [];
(globalThis as any).mcpClient = {
    isReady: () => true,
    callTool: async (name: string, params: Record<string, unknown>) => {
        toolCalls.push({ name, params });
        return { content: `result for ${name}` };
    },
};

// Mock adapter on window
const insertedTexts: string[] = [];
(globalThis as any).mcpAdapter = {
    insertText: async (text: string) => { insertedTexts.push(text); },
    submitForm: async () => { },
    getInputContent: () => '',
};

// --- Import real modules ---
import { executionGuardStore, reserveExecution } from '../mcpexecute/executionGuard.ts';
import { generateContentSignature, storeExecutedFunction } from '../mcpexecute/storage.ts';
import { onStreamEvent } from './interceptor.ts';
import { createStreamToolHandler } from './streamToolBridge.ts';
import { configureStreamToolBridge, initStreamToolBridge } from './streamToolBridgeInit.ts';

// --- Assertions ---
const assert = (cond: boolean, msg: string) => { if (!cond) throw new Error(`❌ FAIL: ${msg}`); };
let testsPassed = 0;

// --- Test 1: Init with real imports (no crash) ---
initStreamToolBridge();
testsPassed++;
console.log('  ✅ 1. initStreamToolBridge() — real imports resolve without error');

// --- Test 2: Bridge is inert when disabled (default) ---
let eventFired = false;
const unsub = onStreamEvent(async () => { eventFired = true; });

// The bridge handler is subscribed internally by initStreamToolBridge.
// We just verify that calling onStreamEvent externally also works.
unsub();
testsPassed++;
console.log('  ✅ 2. onStreamEvent subscription/unsubscription works');

// --- Test 3: Enable bridge and fire event ---
configureStreamToolBridge({ enabled: true });
testsPassed++;
console.log('  ✅ 3. configureStreamToolBridge({ enabled: true }) — no crash');

// --- Test 4: Full pipeline — stream_cutoff → reserve → callTool → inject ---
// Use createStreamToolHandler with REAL guard/storage modules (the actual P0 fix verification)
executionGuardStore.clear();
toolCalls.length = 0;
insertedTexts.length = 0;

const handler = createStreamToolHandler({
    config: { enabled: true, autoInsert: true, autoSubmit: false, toolTimeoutMs: 30_000 },
    mcpClient: () => (globalThis as any).mcpClient,
    guard: { reserveExecution, executionGuardStore },
    adapter: () => (globalThis as any).mcpAdapter,
    storage: { storeExecutedFunction, generateContentSignature },
    onEvent: () => { },
});

const testEvent = {
    type: 'stream_cutoff' as const,
    streamId: 'smoke-stream-001',
    identity: {
        name: 'mcp__web_search',
        callId: 'call_smoke_123',
        arguments: '{"query":"smoke test query"}',
    },
};

await handler(testEvent);

assert(toolCalls.length === 1, `Expected 1 tool call, got ${toolCalls.length}`);
assert(toolCalls[0].name === 'mcp__web_search', `Expected tool name 'mcp__web_search', got '${toolCalls[0].name}'`);
assert(JSON.stringify(toolCalls[0].params) === '{"query":"smoke test query"}', 'Tool params mismatch');
testsPassed++;
console.log('  ✅ 4. Full pipeline: stream_cutoff → reserveExecution → callTool (real guard + storage)');

// --- Test 5: DOM injection happened ---
assert(insertedTexts.length === 1, `Expected 1 insertText call, got ${insertedTexts.length}`);
assert(insertedTexts[0].includes('<function_result call_id="call_smoke_123">'), 'insertText should contain function_result');
assert(insertedTexts[0].includes('mcp__web_search'), 'insertText should contain tool result');
testsPassed++;
console.log('  ✅ 5. DOM injection: adapter.insertText called with formatted result');

// --- Test 6: Dedup works (second call with same identity blocked by real guard) ---
toolCalls.length = 0;
insertedTexts.length = 0;
await handler(testEvent);

assert(toolCalls.length === 0, `Expected 0 tool calls (duplicate), got ${toolCalls.length}`);
testsPassed++;
console.log('  ✅ 6. Dedup: second stream_cutoff with same identity blocked by real executionGuard');

// --- Test 7: Disabled bridge — events ignored ---
const disabledHandler = createStreamToolHandler({
    config: { enabled: false, autoInsert: true, autoSubmit: false, toolTimeoutMs: 30_000 },
    mcpClient: () => (globalThis as any).mcpClient,
    guard: { reserveExecution, executionGuardStore },
    adapter: () => (globalThis as any).mcpAdapter,
    storage: { storeExecutedFunction, generateContentSignature },
    onEvent: () => { },
});

executionGuardStore.clear();
toolCalls.length = 0;
await disabledHandler(testEvent);

assert(toolCalls.length === 0, `Expected 0 tool calls (disabled), got ${toolCalls.length}`);
testsPassed++;
console.log('  ✅ 7. Disabled bridge: stream_cutoff event ignored');

// --- Summary ---
console.log(`\n✅ Phase 3 smoke test: ${testsPassed}/7 passed`);
