/**
 * T-DOM-02..T-DOM-05: DOM Trigger Integration Tests
 *
 * Tests for:
 *   T-DOM-02: scanDomMessage calls ackTracker.scanText(text)
 *   T-DOM-03: scanDomMessage with JSONL block → mcp-superassistant:dom-tool-invocation event
 *   T-DOM-04: window.mcpNotionDomScan available after initStreamToolBridge()
 *   T-DOM-05: Fenced ```jsonl block extraction — raw text outside block does NOT trigger
 *
 * P0-2: DOM Canonicalization — only fenced ```jsonl blocks are scanned for function_calls.
 * Raw textContent with function_call keywords outside code blocks must NOT trigger.
 *
 * Run: node --experimental-strip-types --import ./streamToolBridge.smoke.loader.mjs dom-trigger.test.ts
 * (from render_prescript/src/stream/ directory)
 */

// --- Browser globals mock ---
(globalThis as any).window = globalThis;
(globalThis as any).document = {
    querySelectorAll: () => [],
    addEventListener: () => { },
};
(globalThis as any).localStorage = {
    _store: {} as Record<string, string>,
    getItem(k: string) { return this._store[k] ?? null; },
    setItem(k: string, v: string) { this._store[k] = v; },
    removeItem(k: string) { delete this._store[k]; },
};
(globalThis as any).location = {
    href: 'https://www.notion.so/test-page',
    hostname: 'www.notion.so',
    origin: 'https://www.notion.so',
};
// Mock window.addEventListener / postMessage for MAIN world bridge install
(globalThis as any).addEventListener = () => { };
(globalThis as any).postMessage = () => { };

// --- Minimal mock for MCP client (needed for bridge init) ---
(globalThis as any).mcpClient = {
    isReady: () => false,
    callTool: async () => ({ content: [{ type: 'text', text: '' }] }),
};
(globalThis as any).mcpAdapter = {
    insertText: async () => true,
    submitForm: async () => true,
    getInputContent: () => '',
};

// --- Track CustomEvents ---
const domToolInvocationEvents: Array<{ name: string; callId: string | null; arguments: string | null }> = [];
const modelAckEvents: Array<{ type: string; nonce: string }> = [];

const _origDispatch = (globalThis as any).dispatchEvent?.bind(globalThis) ?? (() => { });
(globalThis as any).dispatchEvent = (event: Event) => {
    if ((event as CustomEvent).type === 'mcp-superassistant:dom-tool-invocation') {
        domToolInvocationEvents.push({ ...(event as CustomEvent).detail });
    }
    if ((event as CustomEvent).type === 'mcp-superassistant:model-ack') {
        modelAckEvents.push({
            type: (event as CustomEvent).detail.type,
            nonce: (event as CustomEvent).detail.nonce,
        });
    }
    return _origDispatch(event);
};

// --- Import bridge after globals set up ---
import assert from 'node:assert/strict';
import { describe, it, beforeEach } from 'node:test';
import {
    initStreamToolBridge,
    scanDomMessage,
    _getAckTrackerForTest,
} from './streamToolBridgeInit.ts';

// --- Helper: reset captured events ---
function resetEvents(): void {
    domToolInvocationEvents.length = 0;
    modelAckEvents.length = 0;
}

// --- Test fixtures ---
const JSONL_FUNCTION_CALL_BLOCK = `\`\`\`jsonl
{"type":"function_call_start","name":"search_web","call_id":"call_dom_1"}
{"type":"parameter","key":"query","value":"test query"}
{"type":"function_call_end","call_id":"call_dom_1"}
\`\`\``;

const TEXT_WITH_KEYWORDS_OUTSIDE_BLOCK =
    'I will use function_call with name=search_web to answer this. ' +
    'The function_call and name keywords appear here but not in a code block.';

const MIXED_TEXT = TEXT_WITH_KEYWORDS_OUTSIDE_BLOCK + '\n\n' + JSONL_FUNCTION_CALL_BLOCK;

describe('T-DOM-04: window.mcpNotionDomScan available after initStreamToolBridge()', () => {
    it('window.mcpNotionDomScan is set after initStreamToolBridge()', () => {
        initStreamToolBridge({ enabled: false });
        const scanner = (globalThis as any).mcpNotionDomScan;
        assert.ok(scanner !== null && scanner !== undefined, 'mcpNotionDomScan should be set');
        assert.strictEqual(typeof scanner.scan, 'function', 'scan should be a function');
        assert.strictEqual(typeof scanner.teardown, 'function', 'teardown should be a function');
        assert.ok(typeof scanner.version === 'string' && scanner.version.length > 0, 'version should be non-empty string');
    });

    it('window.mcpNotionDomScan.scan is the same as scanDomMessage', () => {
        initStreamToolBridge({ enabled: false });
        const scanner = (globalThis as any).mcpNotionDomScan;
        // Both should be callable without error on the same input
        resetEvents();
        scanner.scan('plain text, no JSONL block');
        assert.strictEqual(domToolInvocationEvents.length, 0);
    });
});

describe('T-DOM-02: scanDomMessage calls ackTracker.scanText()', () => {
    it('ACK nonce in DOM text triggers model_ack_confirmed event', () => {
        initStreamToolBridge({ enabled: false });
        resetEvents();

        const tracker = _getAckTrackerForTest();
        assert.ok(tracker !== null, 'ackTracker should be initialized after initStreamToolBridge()');

        // Register a pending nonce
        const testNonce = 'ack_dom_test_1';
        tracker!.registerPending(testNonce, 'call_dom_1', 'search_web');

        // Call scanDomMessage with text containing the ACK nonce
        const textWithAck = `Here is my result.\n<mcp_ack nonce="${testNonce}" />\nDone.`;
        scanDomMessage(textWithAck);

        // The ackTracker should fire model_ack_confirmed → CustomEvent
        assert.strictEqual(modelAckEvents.length, 1, 'Expected 1 model_ack_confirmed event');
        assert.strictEqual(modelAckEvents[0].type, 'model_ack_confirmed');
        assert.strictEqual(modelAckEvents[0].nonce, testNonce);
    });

    it('text without ACK nonce does NOT fire model_ack_confirmed', () => {
        initStreamToolBridge({ enabled: false });
        resetEvents();

        const tracker = _getAckTrackerForTest();
        tracker!.registerPending('ack_another_1', 'call_x', 'some_tool');

        scanDomMessage('some text without any ACK nonce tag here');

        assert.strictEqual(modelAckEvents.length, 0, 'Expected no model_ack events');
    });
});

describe('T-DOM-03: scanDomMessage with JSONL block → dom-tool-invocation event', () => {
    it('fenced ```jsonl block with function_call dispatches dom-tool-invocation', () => {
        initStreamToolBridge({ enabled: false });
        resetEvents();

        scanDomMessage(JSONL_FUNCTION_CALL_BLOCK);

        assert.strictEqual(
            domToolInvocationEvents.length, 1,
            'Expected 1 dom-tool-invocation event',
        );
        assert.strictEqual(domToolInvocationEvents[0].name, 'search_web');
        assert.strictEqual(domToolInvocationEvents[0].callId, 'call_dom_1');
        const args = JSON.parse(domToolInvocationEvents[0].arguments ?? '{}');
        assert.strictEqual(args.query, 'test query');
    });

    it('plain text with no code block does NOT dispatch dom-tool-invocation', () => {
        initStreamToolBridge({ enabled: false });
        resetEvents();

        scanDomMessage('Some assistant response with no tool call');

        assert.strictEqual(domToolInvocationEvents.length, 0);
    });
});

describe('T-DOM-05: DOM Canonicalization — only fenced ```jsonl blocks are scanned', () => {
    it('keywords in raw text outside code block do NOT trigger tool invocation', () => {
        initStreamToolBridge({ enabled: false });
        resetEvents();

        // Text has function_call+name keywords but outside any code block
        scanDomMessage(TEXT_WITH_KEYWORDS_OUTSIDE_BLOCK);

        assert.strictEqual(
            domToolInvocationEvents.length, 0,
            'Raw text with function_call keywords should NOT trigger tool invocation',
        );
    });

    it('mixed text: only the code block triggers tool invocation (not the raw text)', () => {
        initStreamToolBridge({ enabled: false });
        resetEvents();

        scanDomMessage(MIXED_TEXT);

        // Exactly ONE event from the code block, NOT from the raw text mention
        assert.strictEqual(
            domToolInvocationEvents.length, 1,
            'Expected exactly 1 tool invocation event (from code block only)',
        );
        assert.strictEqual(domToolInvocationEvents[0].name, 'search_web');
    });

    it('multiple fenced blocks → one event per block with function_call', () => {
        initStreamToolBridge({ enabled: false });
        resetEvents();

        const twoBlocks = `\`\`\`jsonl
{"type":"function_call_start","name":"tool_a","call_id":"a1"}
{"type":"function_call_end","call_id":"a1"}
\`\`\`

Some text in between.

\`\`\`jsonl
{"type":"function_call_start","name":"tool_b","call_id":"b1"}
{"type":"function_call_end","call_id":"b1"}
\`\`\``;

        scanDomMessage(twoBlocks);

        assert.strictEqual(domToolInvocationEvents.length, 2, 'Expected 2 events, one per block');
        assert.strictEqual(domToolInvocationEvents[0].name, 'tool_a');
        assert.strictEqual(domToolInvocationEvents[1].name, 'tool_b');
    });

    it('empty fenced block does NOT dispatch event', () => {
        initStreamToolBridge({ enabled: false });
        resetEvents();

        scanDomMessage('```jsonl\n```');

        assert.strictEqual(domToolInvocationEvents.length, 0, 'Empty block should not trigger');
    });
});

// ============================================================================
// T-DOM-06: Content-hash dedup prevents double event dispatch on same DOM text
// (GPT P0-1 — content hash dedup added to scanDomMessage)
// ============================================================================
describe('T-DOM-06: scanDomMessage content-hash dedup', () => {
    const callId06 = 'dom-dedup-t06-001';
    const JSONL_TEXT = [
        '```jsonl',
        `{"type":"function_call_start","name":"echo","call_id":"${callId06}"}`,
        `{"type":"function_call_end","call_id":"${callId06}"}`,
        '```',
    ].join('\n');

    it('same text scanned twice → only one dom-tool-invocation event', () => {
        initStreamToolBridge({ enabled: false });
        resetEvents();

        scanDomMessage(JSONL_TEXT);
        scanDomMessage(JSONL_TEXT); // Duplicate — should be deduped by content hash

        assert.strictEqual(
            domToolInvocationEvents.length,
            1,
            `Dedup: same content scanned twice should dispatch exactly 1 event, got ${domToolInvocationEvents.length}`,
        );
    });

    it('different content after same text → new event dispatched', () => {
        initStreamToolBridge({ enabled: false });
        resetEvents();

        const otherCallId = 'dom-dedup-t06-002';
        const OTHER_JSONL = [
            '```jsonl',
            `{"type":"function_call_start","name":"echo","call_id":"${otherCallId}"}`,
            `{"type":"function_call_end","call_id":"${otherCallId}"}`,
            '```',
        ].join('\n');

        scanDomMessage(JSONL_TEXT);
        scanDomMessage(OTHER_JSONL); // Different content — NOT deduped

        assert.strictEqual(
            domToolInvocationEvents.length,
            2,
            `Two different texts should each dispatch 1 event, got ${domToolInvocationEvents.length}`,
        );
    });

    it('partial text (no JSONL) then full text (with JSONL) → exactly one event', () => {
        initStreamToolBridge({ enabled: false });
        resetEvents();

        const partialText = 'I will help with that. Processing...'; // No JSONL block
        scanDomMessage(partialText); // No event expected (no fenced block)
        assert.strictEqual(domToolInvocationEvents.length, 0, 'Partial text: no event');

        scanDomMessage(JSONL_TEXT); // Full text with JSONL block → 1 event
        assert.strictEqual(
            domToolInvocationEvents.length,
            1,
            `Full text with JSONL: exactly 1 event, got ${domToolInvocationEvents.length}`,
        );

        // Re-scan full text — should be deduped
        scanDomMessage(JSONL_TEXT);
        assert.strictEqual(
            domToolInvocationEvents.length,
            1,
            `Re-scan of full text: still 1 event (deduped), got ${domToolInvocationEvents.length}`,
        );
    });

    it('re-init via initStreamToolBridge() clears dedup — same text can trigger again', () => {
        initStreamToolBridge({ enabled: false });
        resetEvents();

        scanDomMessage(JSONL_TEXT);
        assert.strictEqual(domToolInvocationEvents.length, 1, 'First scan: 1 event');

        // Re-initialize (simulates page navigation or re-mount)
        initStreamToolBridge({ enabled: false });
        resetEvents();

        scanDomMessage(JSONL_TEXT); // After re-init, dedup is cleared
        assert.strictEqual(
            domToolInvocationEvents.length,
            1,
            'After re-init, same text can trigger again (dedup cleared)',
        );
    });
});
