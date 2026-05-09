/**
 * Unit tests for ackTracker.ts — Cross-turn ACK nonce registry.
 *
 * Run: node --test --experimental-strip-types ackTracker.test.ts
 * (from render_prescript/src/stream/ directory)
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
    createAckTracker,
    generateNonce,
    type AckTrackerConfig,
    type ModelAckEvent,
} from './ackTracker.ts';

// --- generateNonce ---

describe('generateNonce', () => {
    test('includes callId prefix', () => {
        const nonce = generateNonce('call_123');
        assert.ok(nonce.startsWith('ack_call_123_'), `Expected "ack_call_123_" prefix, got: ${nonce}`);
    });

    test('length < 50 characters', () => {
        const nonce = generateNonce('very_long_call_id_that_is_still_reasonable');
        assert.ok(nonce.length < 50, `Nonce too long: ${nonce.length}`);
    });

    test('unique across calls', () => {
        const nonces = new Set<string>();
        for (let i = 0; i < 100; i++) {
            nonces.add(generateNonce(`call_${i}`));
        }
        assert.equal(nonces.size, 100, 'Expected all unique nonces');
    });

    test('strips XML-unsafe characters from callId', () => {
        const nonce = generateNonce('call<"id>&with spaces\nnewline');
        // Only alphanumeric, underscore, hyphen should remain
        assert.ok(/^ack_[A-Za-z0-9_-]+_[a-z0-9]+$/.test(nonce),
            `Nonce contains unsafe chars: ${nonce}`);
        assert.ok(!nonce.includes('<'), 'Should not contain <');
        assert.ok(!nonce.includes('"'), 'Should not contain "');
        assert.ok(!nonce.includes('>'), 'Should not contain >');
        assert.ok(!nonce.includes('&'), 'Should not contain &');
        assert.ok(!nonce.includes(' '), 'Should not contain space');
        assert.ok(!nonce.includes('\n'), 'Should not contain newline');
    });

    test('handles empty callId gracefully', () => {
        const nonce = generateNonce('');
        assert.ok(nonce.startsWith('ack__'), `Expected "ack__" prefix for empty callId, got: ${nonce}`);
        assert.ok(/^ack__[a-z0-9]+$/.test(nonce), `Bad format: ${nonce}`);
    });

    test('handles callId with only unsafe chars', () => {
        const nonce = generateNonce('<<<>>>"""&&&   ');
        // All chars stripped, should still produce valid nonce
        assert.ok(nonce.startsWith('ack__'), `Expected "ack__" prefix, got: ${nonce}`);
        assert.ok(/^ack__[a-z0-9]+$/.test(nonce), `Bad format: ${nonce}`);
    });
});

describe('createAckTracker', () => {
    function makeConfig(overrides: Partial<AckTrackerConfig> = {}): AckTrackerConfig {
        return {
            timeoutMs: 100, // short timeout for tests
            onEvent: () => { },
            ...overrides,
        };
    }

    test('registerPending stores nonce and returns it', () => {
        const tracker = createAckTracker(makeConfig());
        const nonce = 'ack_test_abc';
        tracker.registerPending(nonce, 'call_1', 'get_weather');
        assert.ok(tracker.hasPending(nonce));
    });

    test('confirmAck emits model_ack_confirmed', () => {
        const events: ModelAckEvent[] = [];
        const tracker = createAckTracker(makeConfig({
            onEvent: (e) => events.push(e),
        }));

        tracker.registerPending('ack_x', 'call_1', 'get_weather');
        tracker.confirmAck('ack_x');

        assert.equal(events.length, 1);
        assert.equal(events[0].type, 'model_ack_confirmed');
        assert.equal(events[0].nonce, 'ack_x');
        assert.equal(events[0].callId, 'call_1');
        assert.equal(events[0].functionName, 'get_weather');
        assert.ok(events[0].latencyMs >= 0);
    });

    test('confirmAck removes from pending', () => {
        const tracker = createAckTracker(makeConfig({ onEvent: () => { } }));
        tracker.registerPending('ack_y', 'call_2', 'search');
        tracker.confirmAck('ack_y');
        assert.ok(!tracker.hasPending('ack_y'));
    });

    test('confirmAck for unknown nonce is no-op', () => {
        const events: ModelAckEvent[] = [];
        const tracker = createAckTracker(makeConfig({ onEvent: (e) => events.push(e) }));
        tracker.confirmAck('ack_unknown');
        assert.equal(events.length, 0);
    });

    test('timeout emits model_ack_timeout', async () => {
        const events: ModelAckEvent[] = [];
        const tracker = createAckTracker(makeConfig({
            timeoutMs: 50,
            onEvent: (e) => events.push(e),
        }));

        tracker.registerPending('ack_timeout', 'call_3', 'fetch_data');

        // Wait for timeout
        await new Promise(resolve => setTimeout(resolve, 80));

        assert.equal(events.length, 1);
        assert.equal(events[0].type, 'model_ack_timeout');
        assert.equal(events[0].nonce, 'ack_timeout');
        assert.equal(events[0].callId, 'call_3');
        assert.equal(events[0].functionName, 'fetch_data');
        assert.ok(events[0].latencyMs >= 50);
        assert.ok(!tracker.hasPending('ack_timeout'));
    });

    test('confirmAck before timeout cancels timeout', async () => {
        const events: ModelAckEvent[] = [];
        const tracker = createAckTracker(makeConfig({
            timeoutMs: 50,
            onEvent: (e) => events.push(e),
        }));

        tracker.registerPending('ack_fast', 'call_4', 'tool_a');
        tracker.confirmAck('ack_fast');

        // Wait past timeout window
        await new Promise(resolve => setTimeout(resolve, 80));

        // Should only have the confirmed event, not a timeout
        assert.equal(events.length, 1);
        assert.equal(events[0].type, 'model_ack_confirmed');
    });

    test('scanText detects nonce in model output', () => {
        const events: ModelAckEvent[] = [];
        const tracker = createAckTracker(makeConfig({ onEvent: (e) => events.push(e) }));

        tracker.registerPending('ack_scan_1', 'call_5', 'read_file');

        const modelOutput = 'Here is the result based on the tool output. <mcp_ack nonce="ack_scan_1" /> Let me continue...';
        tracker.scanText(modelOutput);

        assert.equal(events.length, 1);
        assert.equal(events[0].type, 'model_ack_confirmed');
        assert.equal(events[0].nonce, 'ack_scan_1');
    });

    test('scanText detects multiple nonces', () => {
        const events: ModelAckEvent[] = [];
        const tracker = createAckTracker(makeConfig({ onEvent: (e) => events.push(e) }));

        tracker.registerPending('ack_m1', 'call_6', 'tool_x');
        tracker.registerPending('ack_m2', 'call_7', 'tool_y');

        const modelOutput = '<mcp_ack nonce="ack_m1" /><mcp_ack nonce="ack_m2" />';
        tracker.scanText(modelOutput);

        assert.equal(events.length, 2);
    });

    test('scanText ignores non-pending nonces', () => {
        const events: ModelAckEvent[] = [];
        const tracker = createAckTracker(makeConfig({ onEvent: (e) => events.push(e) }));

        const modelOutput = '<mcp_ack nonce="ack_not_registered" />';
        tracker.scanText(modelOutput);

        assert.equal(events.length, 0);
    });

    test('dispose cancels all pending timeouts', async () => {
        const events: ModelAckEvent[] = [];
        const tracker = createAckTracker(makeConfig({
            timeoutMs: 50,
            onEvent: (e) => events.push(e),
        }));

        tracker.registerPending('ack_dispose_1', 'call_8', 'tool_d');
        tracker.registerPending('ack_dispose_2', 'call_9', 'tool_e');
        tracker.dispose();

        await new Promise(resolve => setTimeout(resolve, 80));

        // No timeout events should fire after dispose
        assert.equal(events.length, 0);
    });

    test('getPendingCount returns correct count', () => {
        const tracker = createAckTracker(makeConfig());
        assert.equal(tracker.getPendingCount(), 0);
        tracker.registerPending('ack_a', 'c1', 'f1');
        assert.equal(tracker.getPendingCount(), 1);
        tracker.registerPending('ack_b', 'c2', 'f2');
        assert.equal(tracker.getPendingCount(), 2);
        tracker.confirmAck('ack_a');
        assert.equal(tracker.getPendingCount(), 1);
    });

    // --- scanRawText tests (Gate 5d) ---

    test('scanRawText confirms pending nonce found in raw NDJSON text', () => {
        const events: ModelAckEvent[] = [];
        const tracker = createAckTracker(makeConfig({ onEvent: (e) => events.push(e) }));

        tracker.registerPending('ack_call123_1a', 'call_123', 'get_weather');

        // Simulate raw NDJSON line with JSON-escaped quotes
        const rawLine = '{"type":"text","value":"<mcp_ack nonce=\\"ack_call123_1a\\" />"}';
        tracker.scanRawText(rawLine);

        assert.equal(events.length, 1);
        assert.equal(events[0].type, 'model_ack_confirmed');
        assert.equal(events[0].nonce, 'ack_call123_1a');
    });

    test('scanRawText confirms nonce in unescaped text', () => {
        const events: ModelAckEvent[] = [];
        const tracker = createAckTracker(makeConfig({ onEvent: (e) => events.push(e) }));

        tracker.registerPending('ack_testcall_5', 'test_call', 'search');

        const plainText = 'The model output contains ack_testcall_5 in its response.';
        tracker.scanRawText(plainText);

        assert.equal(events.length, 1);
        assert.equal(events[0].type, 'model_ack_confirmed');
        assert.equal(events[0].nonce, 'ack_testcall_5');
    });

    test('scanRawText no-op when no pending nonces', () => {
        const events: ModelAckEvent[] = [];
        const tracker = createAckTracker(makeConfig({ onEvent: (e) => events.push(e) }));

        // No registerPending — getPendingCount() === 0
        tracker.scanRawText('some text with ack_whatever_1');

        assert.equal(events.length, 0);
    });

    test('scanRawText no-op when text has no matching nonce', () => {
        const events: ModelAckEvent[] = [];
        const tracker = createAckTracker(makeConfig({ onEvent: (e) => events.push(e) }));

        tracker.registerPending('ack_abc_1', 'call_abc', 'tool_x');

        tracker.scanRawText('This text has no nonce in it at all.');

        assert.equal(events.length, 0);
        assert.ok(tracker.hasPending('ack_abc_1'));
    });

    test('scanRawText confirms multiple pending nonces in one text', () => {
        const events: ModelAckEvent[] = [];
        const tracker = createAckTracker(makeConfig({ onEvent: (e) => events.push(e) }));

        tracker.registerPending('ack_first_0', 'call_1', 'tool_a');
        tracker.registerPending('ack_second_1', 'call_2', 'tool_b');

        const text = 'Found ack_first_0 and also ack_second_1 here.';
        tracker.scanRawText(text);

        assert.equal(events.length, 2);
        const nonces = events.map(e => e.nonce).sort();
        assert.deepEqual(nonces, ['ack_first_0', 'ack_second_1']);
    });

    test('scanRawText ignores non-pending ack-like strings', () => {
        const events: ModelAckEvent[] = [];
        const tracker = createAckTracker(makeConfig({ onEvent: (e) => events.push(e) }));

        tracker.registerPending('ack_real_1', 'call_r', 'tool_r');

        // Text contains a different ack_ string that is not pending
        const text = 'Text has ack_fake_999 but not the real one.';
        tracker.scanRawText(text);

        assert.equal(events.length, 0);
        assert.ok(tracker.hasPending('ack_real_1'));
    });
});
