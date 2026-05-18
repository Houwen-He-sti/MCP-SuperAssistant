/**
 * Gate 5d E2E Integration Test — Cross-Turn ACK Scanning
 *
 * Verifies the full ACK lifecycle:
 *   Turn 1: stream_cutoff → tool exec → RESULT_SUBMITTED → nonce registered → bridge_handoff_ack
 *   Turn 2: stream_chunk_text arrives → scanRawText finds nonce → model_ack_confirmed → CustomEvent
 *
 * Also tests: same-stream skip, re-init cleanup, diagnostic state.
 *
 * Run: node --experimental-strip-types --import ./streamToolBridge.smoke.loader.mjs gate5d-e2e.test.ts
 * (from render_prescript/src/stream/ directory)
 */

// --- Browser globals mock ---
(globalThis as any).window = globalThis;
(globalThis as any).document = { querySelectorAll: () => [], addEventListener: () => { } };
(globalThis as any).localStorage = {
    _store: {} as Record<string, string>,
    getItem(k: string) { return this._store[k] ?? null; },
    setItem(k: string, v: string) { this._store[k] = v; },
    removeItem(k: string) { delete this._store[k]; },
};
(globalThis as any).location = { href: 'https://www.notion.so/test-page', hostname: 'www.notion.so', origin: 'https://www.notion.so' };

// --- Mock MCP client ---
const toolCalls: Array<{ name: string; params: Record<string, unknown> }> = [];
(globalThis as any).mcpClient = {
    isReady: () => true,
    callTool: async (name: string, params: Record<string, unknown>) => {
        toolCalls.push({ name, params });
        return { content: [{ type: 'text', text: JSON.stringify({ echo: params }) }] };
    },
};

// --- Mock adapter (autoInsert + autoSubmit path) ---
const insertedTexts: string[] = [];
let submitCount = 0;
let inputContent = '';
(globalThis as any).mcpAdapter = {
    insertText: async (text: string) => {
        insertedTexts.push(text);
        return true;
    },
    submitForm: async () => {
        submitCount++;
        return true;
    },
    getInputContent: () => inputContent,
};

// --- Track CustomEvents ---
const ackCustomEvents: Array<{ type: string; nonce: string; callId: string; functionName: string }> = [];
const originalDispatchEvent = (globalThis as any).dispatchEvent?.bind(globalThis) ?? (() => { });
(globalThis as any).dispatchEvent = (event: any) => {
    if (event.type === 'mcp-superassistant:model-ack') {
        ackCustomEvents.push({ ...event.detail });
    }
    return originalDispatchEvent(event);
};

// --- Mock postMessage ---
let messageHandlers: Array<(e: any) => void> = [];
(globalThis as any).addEventListener = (type: string, handler: (e: any) => void) => {
    if (type === 'message') {
        messageHandlers.push(handler);
    }
};
(globalThis as any).removeEventListener = () => { };
(globalThis as any).postMessage = () => { };

// --- Import real modules ---
import { executionGuardStore } from '../mcpexecute/executionGuard.ts';
import {
    configureStreamToolBridge,
    getStreamToolBridgeInfo,
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
    ackCustomEvents.length = 0;
    executionGuardStore.clear();
}

function makeStreamCutoffMessage(toolName: string, callId: string, args: string, streamId?: string) {
    streamCounter++;
    const sid = streamId || `test-stream-5d-${String(streamCounter).padStart(3, '0')}`;
    return {
        data: {
            channel: 'mcp-superassistant.stream',
            direction: 'main-to-isolated',
            version: 1,
            source: 'notion-main-fetch-interceptor',
            event: {
                type: 'stream_cutoff',
                streamId: sid,
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

function makeChunkTextMessage(streamId: string, text: string, chunkIndex = 0) {
    return {
        data: {
            channel: 'mcp-superassistant.stream',
            direction: 'main-to-isolated',
            version: 1,
            source: 'notion-main-fetch-interceptor',
            event: {
                type: 'stream_chunk_text',
                streamId,
                text,
                chunkIndex,
                truncated: false,
            },
        },
        source: globalThis,
        origin: 'https://www.notion.so',
    };
}

function fireMessage(msg: ReturnType<typeof makeStreamCutoffMessage>) {
    for (const handler of messageHandlers) {
        handler(msg);
    }
}

console.log('\n🧪 Gate 5d E2E — Cross-Turn ACK Scanning\n');

// ═══════════════════════════════════════════════════════
// Setup: Initialize with autoInsert + autoSubmit (triggers nonce generation)
// ═══════════════════════════════════════════════════════
initStreamToolBridge();
configureStreamToolBridge({
    enabled: true,
    cutoffEnabled: true,
    autoInsert: true,
    autoSubmit: true,
});

// ═══════════════════════════════════════════════════════
// Test 1: Turn 1 — tool exec → nonce registered → bridge_handoff_ack
// ═══════════════════════════════════════════════════════
resetMocks();

const turn1StreamId = 'stream-turn1-001';
fireMessage(makeStreamCutoffMessage('echo', 'call_ack_001', '{"msg":"hi"}', turn1StreamId));
await new Promise(resolve => setTimeout(resolve, 150));

assert(toolCalls.length === 1, `Expected 1 tool call, got ${toolCalls.length}`);
assert(submitCount === 1, `Expected 1 submit (autoSubmit), got ${submitCount}`);

// Check ackTracker has a pending nonce
const info1 = getStreamToolBridgeInfo();
assert(info1.ackTrackerActive === true, 'Expected ackTracker to be active');
assert(info1.ackPendingCount === 1, `Expected 1 pending nonce, got ${info1.ackPendingCount}`);

passed++;
console.log('  ✅ 1. Turn 1: tool exec + autoSubmit → 1 pending nonce registered');

// ═══════════════════════════════════════════════════════
// Test 2: Turn 2 — chunk_text with nonce → model_ack_confirmed + CustomEvent
// ═══════════════════════════════════════════════════════

// Find the pending nonce from inserted text
// The inserted text contains an <mcp_ack_nonce> tag with the nonce
const nonceMatch = insertedTexts[0]?.match(/nonce="([^"]+)"/);
assert(nonceMatch !== null && nonceMatch !== undefined, 'Expected nonce in inserted text');
const nonce = nonceMatch![1];

// Simulate Turn 2 stream with text containing the nonce
const turn2StreamId = 'stream-turn2-001';
fireMessage(makeChunkTextMessage(turn2StreamId, `{"body":"The model says <mcp_ack nonce=\\"${nonce}\\"/> and continues"}`));
await new Promise(resolve => setTimeout(resolve, 100));

// Check ACK confirmed
assert(ackCustomEvents.length === 1, `Expected 1 ACK custom event, got ${ackCustomEvents.length}`);
assert(ackCustomEvents[0].type === 'model_ack_confirmed', `Expected model_ack_confirmed, got ${ackCustomEvents[0].type}`);
assert(ackCustomEvents[0].nonce === nonce, `Nonce mismatch: expected ${nonce}, got ${ackCustomEvents[0].nonce}`);

// Check diagnostic state
const info2 = getStreamToolBridgeInfo();
assert(info2.ackPendingCount === 0, `Expected 0 pending nonces after ACK, got ${info2.ackPendingCount}`);
assert(info2.lastModelAckEvent !== null, 'Expected lastModelAckEvent to be set');
assert(info2.lastModelAckEvent!.type === 'model_ack_confirmed', 'Expected lastModelAckEvent type to be model_ack_confirmed');
assert(info2.lastModelAckEvent!.nonce === nonce, 'Expected lastModelAckEvent nonce to match');

passed++;
console.log('  ✅ 2. Turn 2: chunk_text with nonce → model_ack_confirmed + CustomEvent + diagnostic');

// ═══════════════════════════════════════════════════════
// Test 3: Same-stream skip — chunk_text on handoff stream → NOT scanned
// ═══════════════════════════════════════════════════════
resetMocks();

const sameStreamId = 'stream-same-001';
fireMessage(makeStreamCutoffMessage('echo', 'call_same_001', '{"x":1}', sameStreamId));
await new Promise(resolve => setTimeout(resolve, 150));

assert(toolCalls.length === 1, 'Expected tool call');
const infoSame = getStreamToolBridgeInfo();
assert(infoSame.ackPendingCount === 1, 'Expected 1 pending nonce');

// Extract nonce
const nonceSame = insertedTexts[0]?.match(/nonce="([^"]+)"/)?.[1];
assert(nonceSame !== undefined, 'Expected nonce in text');

// Send chunk_text on the SAME stream (handoff stream) — should be SKIPPED
ackCustomEvents.length = 0;
fireMessage(makeChunkTextMessage(sameStreamId, `text with ${nonceSame} in it`));
await new Promise(resolve => setTimeout(resolve, 100));

// Should NOT have ACK'd (same-stream skip per GPT P1-4)
assert(ackCustomEvents.length === 0, `Expected 0 ACK events (same-stream skip), got ${ackCustomEvents.length}`);
const infoAfterSame = getStreamToolBridgeInfo();
assert(infoAfterSame.ackPendingCount === 1, 'Nonce should still be pending');

// Now send on a DIFFERENT stream — should ACK
const diffStreamId = 'stream-diff-001';
fireMessage(makeChunkTextMessage(diffStreamId, `model echoes ${nonceSame}`));
await new Promise(resolve => setTimeout(resolve, 100));

assert(ackCustomEvents.length === 1, `Expected 1 ACK event on different stream, got ${ackCustomEvents.length}`);
assert(ackCustomEvents[0].type === 'model_ack_confirmed', 'Expected model_ack_confirmed');

passed++;
console.log('  ✅ 3. Same-stream skip: chunk_text on handoff stream skipped, different stream ACK\'d');

// ═══════════════════════════════════════════════════════
// Test 4: No pending nonces → chunk_text scanning is no-op
// ═══════════════════════════════════════════════════════
resetMocks();

// Re-init to clear all pending
initStreamToolBridge();
configureStreamToolBridge({
    enabled: true,
    cutoffEnabled: true,
    autoInsert: true,
    autoSubmit: true,
});

const infoClean = getStreamToolBridgeInfo();
assert(infoClean.ackPendingCount === 0, 'Expected 0 pending nonces after re-init');

// Send chunk_text with random text — should be silently ignored
fireMessage(makeChunkTextMessage('stream-noop-001', 'some random text without any nonce'));
await new Promise(resolve => setTimeout(resolve, 50));

// No events should fire
assert(ackCustomEvents.length === 0, 'Expected 0 ACK events when no pending nonces');

passed++;
console.log('  ✅ 4. No pending nonces → chunk_text scanning is no-op');

// ═══════════════════════════════════════════════════════
// Test 5: Re-init clears lastModelAckEvent
// ═══════════════════════════════════════════════════════
resetMocks();

// First, create an ACK event
fireMessage(makeStreamCutoffMessage('echo', 'call_reinit_001', '{}', 'stream-reinit-001'));
await new Promise(resolve => setTimeout(resolve, 150));

const nonceReinit = insertedTexts[0]?.match(/nonce="([^"]+)"/)?.[1];
assert(nonceReinit !== undefined, 'Expected nonce');

fireMessage(makeChunkTextMessage('stream-reinit-002', `model ${nonceReinit} here`));
await new Promise(resolve => setTimeout(resolve, 100));

const infoBeforeReinit = getStreamToolBridgeInfo();
assert(infoBeforeReinit.lastModelAckEvent !== null, 'Expected lastModelAckEvent before re-init');

// Re-init should clear
initStreamToolBridge();
configureStreamToolBridge({
    enabled: true,
    cutoffEnabled: true,
    autoInsert: true,
    autoSubmit: true,
});

const infoAfterReinit = getStreamToolBridgeInfo();
assert(infoAfterReinit.lastModelAckEvent === null, 'Expected lastModelAckEvent null after re-init');
assert(infoAfterReinit.ackPendingCount === 0, 'Expected 0 pending after re-init');

passed++;
console.log('  ✅ 5. Re-init clears lastModelAckEvent and pending nonces');

// ═══════════════════════════════════════════════════════
// Test 6: Multiple nonces — partial ACK
// ═══════════════════════════════════════════════════════
resetMocks();

// Trigger two tool calls on different streams → two pending nonces
fireMessage(makeStreamCutoffMessage('echo', 'call_multi_001', '{"a":1}', 'stream-multi-001'));
await new Promise(resolve => setTimeout(resolve, 150));

const nonce1 = insertedTexts[0]?.match(/nonce="([^"]+)"/)?.[1];
assert(nonce1 !== undefined, 'Expected nonce1');

// Need to use a different callId to avoid execution guard dedup
resetMocks();
fireMessage(makeStreamCutoffMessage('echo', 'call_multi_002', '{"b":2}', 'stream-multi-002'));
await new Promise(resolve => setTimeout(resolve, 150));

const nonce2 = insertedTexts[0]?.match(/nonce="([^"]+)"/)?.[1];
assert(nonce2 !== undefined, 'Expected nonce2');

const infoMulti = getStreamToolBridgeInfo();
assert(infoMulti.ackPendingCount === 2, `Expected 2 pending nonces, got ${infoMulti.ackPendingCount}`);

// ACK only nonce1
ackCustomEvents.length = 0;
fireMessage(makeChunkTextMessage('stream-multi-003', `model says ${nonce1}`));
await new Promise(resolve => setTimeout(resolve, 100));

assert(ackCustomEvents.length === 1, `Expected 1 ACK event, got ${ackCustomEvents.length}`);
const infoPartial = getStreamToolBridgeInfo();
assert(infoPartial.ackPendingCount === 1, `Expected 1 remaining pending, got ${infoPartial.ackPendingCount}`);

// Now ACK nonce2
ackCustomEvents.length = 0;
fireMessage(makeChunkTextMessage('stream-multi-004', `and ${nonce2} too`));
await new Promise(resolve => setTimeout(resolve, 100));

assert(ackCustomEvents.length === 1, `Expected 1 more ACK, got ${ackCustomEvents.length}`);
const infoAllDone = getStreamToolBridgeInfo();
assert(infoAllDone.ackPendingCount === 0, `Expected 0 pending after all ACK'd, got ${infoAllDone.ackPendingCount}`);

passed++;
console.log('  ✅ 6. Multiple nonces: partial ACK → each confirmed independently');

// ═══════════════════════════════════════════════════════
// Test 7: Nonce NOT in chunk text → stays pending (no false ACK)
// ═══════════════════════════════════════════════════════
resetMocks();
// Re-init fresh
initStreamToolBridge();
configureStreamToolBridge({
    enabled: true,
    cutoffEnabled: true,
    autoInsert: true,
    autoSubmit: true,
});

fireMessage(makeStreamCutoffMessage('echo', 'call_noack_001', '{}', 'stream-noack-001'));
await new Promise(resolve => setTimeout(resolve, 150));

const nonceNoAck = insertedTexts[0]?.match(/nonce="([^"]+)"/)?.[1];
assert(nonceNoAck !== undefined, 'Expected nonce');

const infoBefore = getStreamToolBridgeInfo();
assert(infoBefore.ackPendingCount === 1, 'Expected 1 pending');

// Send chunk_text WITHOUT the nonce
ackCustomEvents.length = 0;
fireMessage(makeChunkTextMessage('stream-noack-002', 'the model talks about something else entirely'));
await new Promise(resolve => setTimeout(resolve, 100));

assert(ackCustomEvents.length === 0, 'Expected 0 ACK events (nonce not in text)');
const infoStillPending = getStreamToolBridgeInfo();
assert(infoStillPending.ackPendingCount === 1, 'Nonce should still be pending');

passed++;
console.log('  ✅ 7. Nonce NOT in text → stays pending (no false ACK)');

// ═══════════════════════════════════════════════════════
// Cleanup: re-init to dispose pending ACK timers so Node exits promptly
// ═══════════════════════════════════════════════════════
initStreamToolBridge();

// ═══════════════════════════════════════════════════════
// Summary
// ═══════════════════════════════════════════════════════
console.log(`\n🎯 Gate 5d E2E: ${passed}/${total} tests passed\n`);
if (passed < total) {
    process.exit(1);
}
