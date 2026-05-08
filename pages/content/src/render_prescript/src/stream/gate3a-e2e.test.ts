/**
 * Gate 3A E2E Integration Test
 *
 * Exercises the full pipeline in Node.js with mocked browser globals:
 *   getStreamToolBridgeInfo() → configureStreamToolBridge() → stream_cutoff event → execution
 *
 * This simulates the exact devtools activation path:
 * 1. Check preflight with getStreamToolBridgeInfo()
 * 2. Activate with configureStreamToolBridge({enabled, cutoffEnabled, autoInsert:false})
 * 3. Receive stream_cutoff event → tool execution
 *
 * Run: node --experimental-strip-types --import ./streamToolBridge.smoke.loader.mjs gate3a-e2e.test.ts
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

// Mock mcpClient — tracks calls
const toolCalls: Array<{ name: string; params: Record<string, unknown> }> = [];
(globalThis as any).mcpClient = {
  isReady: () => true,
  callTool: async (name: string, params: Record<string, unknown>) => {
    toolCalls.push({ name, params });
    return { content: [{ type: 'text', text: JSON.stringify({ status: 'ok', bridgeVersion: 1 }) }] };
  },
};

// Mock adapter (should NOT be used — autoInsert=false)
const insertedTexts: string[] = [];
(globalThis as any).mcpAdapter = {
  insertText: async (text: string) => { insertedTexts.push(text); },
  submitForm: async () => {},
  getInputContent: () => '',
};

// Mock postMessage for bridge install (Notion host triggers bridge)
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
  getStreamToolBridgeInfo,
  initStreamToolBridge,
} from './streamToolBridgeInit.ts';
import { onStreamEvent } from './interceptorBridge.ts';

// --- Test helpers ---
const assert = (cond: boolean, msg: string) => {
  if (!cond) throw new Error(`❌ FAIL: ${msg}`);
};
let passed = 0;
const total = 8;

console.log('\n🧪 Gate 3A E2E Integration Test\n');

// ═══════════════════════════════════════════════════════
// Test 1: initStreamToolBridge — default disabled
// ═══════════════════════════════════════════════════════
initStreamToolBridge();
passed++;
console.log('  ✅ 1. initStreamToolBridge() succeeds with Notion host detected');

// ═══════════════════════════════════════════════════════
// Test 2: getStreamToolBridgeInfo — preflight diagnostic
// ═══════════════════════════════════════════════════════
const info1 = getStreamToolBridgeInfo();
assert(info1.isNotionHost === true, 'Expected isNotionHost=true');
assert(info1.bridgeHandlerReady === true, 'Expected bridgeHandlerReady=true');
assert(info1.subscribed === true, 'Expected subscribed=true');
assert(info1.mcpClientAvailable === true, 'Expected mcpClientAvailable=true');
assert(info1.mcpClientReady === true, 'Expected mcpClientReady=true');
assert(info1.adapterAvailable === true, 'Expected adapterAvailable=true');
assert(info1.config.enabled === false, 'Expected config.enabled=false (default)');
assert(info1.config.cutoffEnabled === false, 'Expected config.cutoffEnabled=false (default)');
passed++;
console.log('  ✅ 2. getStreamToolBridgeInfo() returns correct preflight — all deps ready, disabled by default');

// ═══════════════════════════════════════════════════════
// Test 3: configureStreamToolBridge — Gate 3A activation
// ═══════════════════════════════════════════════════════
configureStreamToolBridge({ enabled: true, cutoffEnabled: true, autoInsert: false });
const info2 = getStreamToolBridgeInfo();
assert(info2.config.enabled === true, 'Expected config.enabled=true after configure');
assert(info2.config.cutoffEnabled === true, 'Expected config.cutoffEnabled=true after configure');
assert(info2.config.autoInsert === false, 'Expected config.autoInsert=false after configure');
passed++;
console.log('  ✅ 3. configureStreamToolBridge() activates with Gate 3A settings');

// ═══════════════════════════════════════════════════════
// Test 4: Config sent to MAIN world (cutoff enable)
// ═══════════════════════════════════════════════════════
const configMsgs = postedMessages.filter(
  (m: any) => m && typeof m === 'object' && (m as any).channel === 'mcp-superassistant.stream.config'
) as any[];
assert(configMsgs.length >= 2, `Expected at least 2 config messages (init + configure), got ${configMsgs.length}`);
const lastConfigMsg = configMsgs[configMsgs.length - 1];
assert(lastConfigMsg.config.cutoffEnabled === true, 'Expected cutoffEnabled=true in latest posted config');
passed++;
console.log('  ✅ 4. cutoffEnabled=true config sent to MAIN world via postMessage');

// ═══════════════════════════════════════════════════════
// Test 5: Simulate stream_cutoff from MAIN world → tool execution
// ═══════════════════════════════════════════════════════
executionGuardStore.clear();
toolCalls.length = 0;
insertedTexts.length = 0;

// Collect execution events from bridge listener
const executionEvents: unknown[] = [];
const unsub = onStreamEvent(async (event: unknown) => {
  executionEvents.push(event);
});

// Simulate MAIN world postMessage with stream_cutoff event
const messageHandler = (globalThis as any).__messageHandler;
assert(messageHandler !== undefined, 'Expected message handler to be installed by bridge');

// Simulate the postMessage envelope from MAIN world interceptor
const fakeStreamCutoffMessage = {
  data: {
    channel: 'mcp-superassistant.stream',
    direction: 'main-to-isolated',
    version: 1,
    source: 'notion-main-fetch-interceptor',
    event: {
      type: 'stream_cutoff',
      streamId: 'test-stream-gate3a-001',
      cutoffChunkIndex: 5,
      elapsedMs: 1200,
      identity: {
        name: 'get_bridge_info',
        callId: null,
        arguments: null,
      },
      reason: 'function_call_detected',
      forwardedTriggerChunk: true,
      mode: 'drain-drop',
    },
  },
  source: globalThis,
  origin: 'https://www.notion.so',
};

messageHandler(fakeStreamCutoffMessage);

// Wait for async execution to complete
await new Promise(resolve => setTimeout(resolve, 50));

assert(toolCalls.length === 1, `Expected 1 tool call, got ${toolCalls.length}`);
assert(toolCalls[0].name === 'get_bridge_info', `Expected tool name 'get_bridge_info', got '${toolCalls[0].name}'`);
assert(JSON.stringify(toolCalls[0].params) === '{}', `Expected empty params {}, got ${JSON.stringify(toolCalls[0].params)}`);
passed++;
console.log('  ✅ 5. stream_cutoff(get_bridge_info, args=null) → mcpClient.callTool("get_bridge_info", {})');

// ═══════════════════════════════════════════════════════
// Test 6: autoInsert=false — no DOM injection
// ═══════════════════════════════════════════════════════
assert(insertedTexts.length === 0, `Expected 0 insertText calls (autoInsert=false), got ${insertedTexts.length}`);
passed++;
console.log('  ✅ 6. autoInsert=false — adapter.insertText NOT called (Gate 3A safety)');

// ═══════════════════════════════════════════════════════
// Test 7: Duplicate stream_cutoff blocked by executionGuard
// ═══════════════════════════════════════════════════════
toolCalls.length = 0;
messageHandler(fakeStreamCutoffMessage);
await new Promise(resolve => setTimeout(resolve, 50));
assert(toolCalls.length === 0, `Expected 0 tool calls (duplicate blocked), got ${toolCalls.length}`);
passed++;
console.log('  ✅ 7. Duplicate stream_cutoff blocked — executionGuard dedup works');

// ═══════════════════════════════════════════════════════
// Test 8: Second different tool call succeeds
// ═══════════════════════════════════════════════════════
toolCalls.length = 0;
const secondMessage = {
  data: {
    channel: 'mcp-superassistant.stream',
    direction: 'main-to-isolated',
    version: 1,
    source: 'notion-main-fetch-interceptor',
    event: {
      type: 'stream_cutoff',
      streamId: 'test-stream-gate3a-002',
      cutoffChunkIndex: 3,
      elapsedMs: 800,
      identity: {
        name: 'get_bridge_info',
        callId: 'call_second_001',
        arguments: null,
      },
      reason: 'function_call_detected',
      forwardedTriggerChunk: true,
      mode: 'drain-drop',
    },
  },
  source: globalThis,
  origin: 'https://www.notion.so',
};

messageHandler(secondMessage);
await new Promise(resolve => setTimeout(resolve, 50));
assert(toolCalls.length === 1, `Expected 1 tool call (different callId), got ${toolCalls.length}`);
assert(toolCalls[0].name === 'get_bridge_info', 'Expected get_bridge_info');
passed++;
console.log('  ✅ 8. Second stream_cutoff with different callId → new execution succeeds');

// --- Cleanup ---
unsub();

// --- Summary ---
console.log(`\n✅ Gate 3A E2E: ${passed}/${total} passed`);
console.log('\nVerified Gate 3A acceptance criteria:');
console.log('  • getStreamToolBridgeInfo() reports all dependencies ready');
console.log('  • configureStreamToolBridge() activates with {enabled:true, cutoffEnabled:true, autoInsert:false}');
console.log('  • stream_cutoff(get_bridge_info, args=null) → callTool("get_bridge_info", {})');
console.log('  • autoInsert=false → no DOM injection');
console.log('  • Duplicate cutoff blocked by executionGuard');
console.log('  • Different callId → new execution allowed');
