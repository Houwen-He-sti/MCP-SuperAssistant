/**
 * Gate 3B E2E Integration Test
 *
 * Exercises the parameter validation pipeline:
 *   stream_cutoff with valid params → execution
 *   stream_cutoff with invalid params → rejection (ARGS_NOT_OBJECT, ARGS_TOO_LARGE)
 *
 * Run: node --experimental-strip-types --import ./streamToolBridge.smoke.loader.mjs gate3b-e2e.test.ts
 * (from render_prescript/src/stream/ directory)
 */

// --- Browser globals mock (same as gate3a-e2e) ---
(globalThis as any).window = globalThis;
(globalThis as any).document = { querySelectorAll: () => [], addEventListener: () => { } };
(globalThis as any).localStorage = {
    _store: {} as Record<string, string>,
    getItem(k: string) { return this._store[k] ?? null; },
    setItem(k: string, v: string) { this._store[k] = v; },
    removeItem(k: string) { delete this._store[k]; },
};
(globalThis as any).location = { href: 'https://www.notion.so/test-page', hostname: 'www.notion.so', origin: 'https://www.notion.so' };

// Mock mcpClient — tracks calls
const toolCalls: Array<{ name: string; params: Record<string, unknown> }> = [];
(globalThis as any).mcpClient = {
    isReady: () => true,
    callTool: async (name: string, params: Record<string, unknown>) => {
        toolCalls.push({ name, params });
        return { content: [{ type: 'text', text: JSON.stringify({ echo: params }) }] };
    },
};

// Mock adapter (autoInsert=false, should NOT be used)
const insertedTexts: string[] = [];
(globalThis as any).mcpAdapter = {
    insertText: async (text: string) => { insertedTexts.push(text); },
    submitForm: async () => { },
    getInputContent: () => '',
};

// Mock postMessage
const postedMessages: unknown[] = [];
(globalThis as any).addEventListener = (type: string, handler: (e: any) => void) => {
    if (type === 'message') {
        (globalThis as any).__messageHandler = handler;
    }
};
(globalThis as any).postMessage = (data: unknown, origin?: string) => {
    postedMessages.push(data);
};

// --- Import real modules ---
import { executionGuardStore } from '../mcpexecute/executionGuard.ts';
import {
    configureStreamToolBridge,
    initStreamToolBridge,
} from './streamToolBridgeInit.ts';
import { MAX_ARGS_SIZE } from './streamToolBridge.ts';

// --- Test helpers ---
const assert = (cond: boolean, msg: string) => {
    if (!cond) throw new Error(`❌ FAIL: ${msg}`);
};
let passed = 0;
const total = 8;
let streamCounter = 0;

// Capture console.warn calls to verify error codes from bridge onEvent
const consoleWarnings: string[] = [];
const originalWarn = console.warn;
console.warn = (...args: unknown[]) => {
    consoleWarnings.push(args.join(' '));
    originalWarn.apply(console, args);
};

function makeStreamCutoffMessage(toolName: string, callId: string | null, args: string | null) {
    streamCounter++;
    return {
        data: {
            channel: 'mcp-superassistant.stream',
            direction: 'main-to-isolated',
            version: 1,
            source: 'notion-main-fetch-interceptor',
            event: {
                type: 'stream_cutoff',
                streamId: `test-stream-gate3b-${String(streamCounter).padStart(3, '0')}`,
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

console.log('\n🧪 Gate 3B E2E Integration Test — Parameter Validation\n');

// ═══════════════════════════════════════════════════════
// Setup: Initialize and activate bridge
// ═══════════════════════════════════════════════════════
initStreamToolBridge();
configureStreamToolBridge({ enabled: true, cutoffEnabled: true, autoInsert: false });

const messageHandler = (globalThis as any).__messageHandler;
assert(messageHandler !== undefined, 'Expected message handler installed');

// ═══════════════════════════════════════════════════════
// Test 1: Valid params — echo({"message":"hello"})
// ═══════════════════════════════════════════════════════
executionGuardStore.clear();
toolCalls.length = 0;

messageHandler(makeStreamCutoffMessage('echo', 'call_echo_001', '{"message":"hello"}'));
await new Promise(resolve => setTimeout(resolve, 50));

assert(toolCalls.length === 1, `Expected 1 tool call, got ${toolCalls.length}`);
assert(toolCalls[0].name === 'echo', `Expected 'echo', got '${toolCalls[0].name}'`);
assert(toolCalls[0].params.message === 'hello', `Expected params.message='hello', got '${toolCalls[0].params.message}'`);
passed++;
console.log('  ✅ 1. echo({"message":"hello"}) → callTool receives correct params');

// ═══════════════════════════════════════════════════════
// Test 2: Valid params — empty object {}
// ═══════════════════════════════════════════════════════
executionGuardStore.clear();
toolCalls.length = 0;

messageHandler(makeStreamCutoffMessage('get_info', 'call_info_001', '{}'));
await new Promise(resolve => setTimeout(resolve, 50));

assert(toolCalls.length === 1, `Expected 1 tool call, got ${toolCalls.length}`);
assert(toolCalls[0].name === 'get_info', `Expected 'get_info', got '${toolCalls[0].name}'`);
assert(JSON.stringify(toolCalls[0].params) === '{}', `Expected empty params, got ${JSON.stringify(toolCalls[0].params)}`);
passed++;
console.log('  ✅ 2. get_info("{}") → callTool receives {}');

// ═══════════════════════════════════════════════════════
// Test 3: Valid params — complex nested object
// ═══════════════════════════════════════════════════════
executionGuardStore.clear();
toolCalls.length = 0;

const complexArgs = JSON.stringify({ query: 'test', options: { limit: 10, tags: ['a', 'b'] } });
messageHandler(makeStreamCutoffMessage('search', 'call_search_001', complexArgs));
await new Promise(resolve => setTimeout(resolve, 50));

assert(toolCalls.length === 1, `Expected 1 tool call, got ${toolCalls.length}`);
assert(toolCalls[0].params.query === 'test', 'Expected params.query="test"');
assert((toolCalls[0].params.options as any).limit === 10, 'Expected params.options.limit=10');
assert(JSON.stringify((toolCalls[0].params.options as any).tags) === '["a","b"]', 'Expected tags=["a","b"]');
passed++;
console.log('  ✅ 3. search({query, options:{limit, tags}}) → complex nested params preserved');

// ═══════════════════════════════════════════════════════
// Test 4: Invalid — arguments='[]' → ARGS_NOT_OBJECT
// ═══════════════════════════════════════════════════════
executionGuardStore.clear();
toolCalls.length = 0;
consoleWarnings.length = 0;

messageHandler(makeStreamCutoffMessage('echo', 'call_array_001', '[]'));
await new Promise(resolve => setTimeout(resolve, 50));

assert(toolCalls.length === 0, `Expected 0 tool calls (rejected), got ${toolCalls.length}`);
assert(consoleWarnings.some(w => w.includes('ARGS_NOT_OBJECT')), 'Expected ARGS_NOT_OBJECT in console warnings');
passed++;
console.log('  ✅ 4. arguments="[]" → ARGS_NOT_OBJECT, no execution');

// ═══════════════════════════════════════════════════════
// Test 5: Invalid — arguments='123' → ARGS_NOT_OBJECT
// ═══════════════════════════════════════════════════════
executionGuardStore.clear();
toolCalls.length = 0;
consoleWarnings.length = 0;

messageHandler(makeStreamCutoffMessage('echo', 'call_num_001', '123'));
await new Promise(resolve => setTimeout(resolve, 50));

assert(toolCalls.length === 0, `Expected 0 tool calls (rejected), got ${toolCalls.length}`);
assert(consoleWarnings.some(w => w.includes('ARGS_NOT_OBJECT')), 'Expected ARGS_NOT_OBJECT for number');
passed++;
console.log('  ✅ 5. arguments="123" → ARGS_NOT_OBJECT, no execution');

// ═══════════════════════════════════════════════════════
// Test 6: Invalid — arguments='"hello"' → ARGS_NOT_OBJECT
// ═══════════════════════════════════════════════════════
executionGuardStore.clear();
toolCalls.length = 0;
consoleWarnings.length = 0;

messageHandler(makeStreamCutoffMessage('echo', 'call_str_001', '"hello"'));
await new Promise(resolve => setTimeout(resolve, 50));

assert(toolCalls.length === 0, `Expected 0 tool calls (rejected), got ${toolCalls.length}`);
assert(consoleWarnings.some(w => w.includes('ARGS_NOT_OBJECT')), 'Expected ARGS_NOT_OBJECT for string');
passed++;
console.log('  ✅ 6. arguments=\'"hello"\' → ARGS_NOT_OBJECT, no execution');

// ═══════════════════════════════════════════════════════
// Test 7: Invalid — oversized args → ARGS_TOO_LARGE
// ═══════════════════════════════════════════════════════
executionGuardStore.clear();
toolCalls.length = 0;
consoleWarnings.length = 0;

const oversized = '{"x":"' + 'A'.repeat(MAX_ARGS_SIZE + 100) + '"}';
messageHandler(makeStreamCutoffMessage('echo', 'call_big_001', oversized));
await new Promise(resolve => setTimeout(resolve, 50));

assert(toolCalls.length === 0, `Expected 0 tool calls (oversized rejected), got ${toolCalls.length}`);
assert(consoleWarnings.some(w => w.includes('ARGS_TOO_LARGE')), 'Expected ARGS_TOO_LARGE in console warnings');
passed++;
console.log('  ✅ 7. oversized args (>64KB) → ARGS_TOO_LARGE, no execution');

// ═══════════════════════════════════════════════════════
// Test 8: Invalid — malformed JSON → PARSE_ERROR
// ═══════════════════════════════════════════════════════
executionGuardStore.clear();
toolCalls.length = 0;
consoleWarnings.length = 0;

messageHandler(makeStreamCutoffMessage('echo', 'call_bad_001', '{invalid json'));
await new Promise(resolve => setTimeout(resolve, 50));

assert(toolCalls.length === 0, `Expected 0 tool calls (malformed JSON), got ${toolCalls.length}`);
assert(consoleWarnings.some(w => w.includes('PARSE_ERROR')), 'Expected PARSE_ERROR in console warnings');
passed++;
console.log('  ✅ 8. malformed JSON → PARSE_ERROR, no execution');

// --- Cleanup ---
console.warn = originalWarn;

// --- Summary ---
console.log(`\n✅ Gate 3B E2E: ${passed}/${total} passed`);
console.log('\nVerified Gate 3B acceptance criteria:');
console.log('  • echo({"message":"hello"}) → callTool receives correct params');
console.log('  • Empty object args → callTool receives {}');
console.log('  • Complex nested params preserved through pipeline');
console.log('  • Array args rejected (ARGS_NOT_OBJECT)');
console.log('  • Number args rejected (ARGS_NOT_OBJECT)');
console.log('  • String args rejected (ARGS_NOT_OBJECT)');
console.log('  • Oversized args rejected before parse (ARGS_TOO_LARGE)');
console.log('  • Malformed JSON rejected (PARSE_ERROR)');
