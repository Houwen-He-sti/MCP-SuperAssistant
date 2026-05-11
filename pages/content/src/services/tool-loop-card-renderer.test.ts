/**
 * TDD: Failing tests for Gate 6C ToolLoopCardRenderer.
 *
 * Tests define the contracted behavior for:
 *   - Tone mapping (event type → card tone)
 *   - Title generation (event → card title text)
 *   - Status icon selection (tone → emoji)
 *   - Per-call state management (accumulate events, reject missing callId)
 *
 * Run: node --test --experimental-strip-types tool-loop-card-renderer.test.ts
 * (from pages/content/src/services/ directory)
 *
 * All tests should FAIL until implementation exists.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { ToolLoopUiEvent, ToolLoopUiEventType } from '../render_prescript/src/stream/toolLoopUiEvents.ts';
import {
    getCardStatusIcon,
    getCardTitle,
    isKnownToolLoopEventType,
    isToolLoopUiEvent,
    mapEventToTone,
    ToolLoopCardStateStore
} from './tool-loop-card-renderer-utils.ts';

// --- Helpers ---

function makeUiEvent(
    type: ToolLoopUiEventType,
    overrides: Partial<Omit<ToolLoopUiEvent, 'version' | 'type'>> = {},
): ToolLoopUiEvent {
    return {
        version: 1,
        type,
        timestamp: Date.now(),
        callId: 'call-1',
        toolName: 'test_tool',
        ...overrides,
    };
}

// ────────────────────────────────────────────
// mapEventToTone
// ────────────────────────────────────────────

describe('mapEventToTone', () => {
    test('tool_call_detected → neutral', () => {
        assert.equal(mapEventToTone('tool_call_detected'), 'neutral');
    });

    test('tool_execution_started → pending', () => {
        assert.equal(mapEventToTone('tool_execution_started'), 'pending');
    });

    test('tool_execution_succeeded → success', () => {
        assert.equal(mapEventToTone('tool_execution_succeeded'), 'success');
    });

    test('tool_execution_failed → error', () => {
        assert.equal(mapEventToTone('tool_execution_failed'), 'error');
    });

    test('tool_result_inserted → success', () => {
        assert.equal(mapEventToTone('tool_result_inserted'), 'success');
    });

    test('tool_result_submitted → success', () => {
        assert.equal(mapEventToTone('tool_result_submitted'), 'success');
    });

    test('tool_result_blocked → warning', () => {
        assert.equal(mapEventToTone('tool_result_blocked'), 'warning');
    });

    test('tool_result_failed → error', () => {
        assert.equal(mapEventToTone('tool_result_failed'), 'error');
    });

    test('execution_blocked → blocked', () => {
        assert.equal(mapEventToTone('execution_blocked'), 'blocked');
    });

    test('model_ack_confirmed → acknowledged', () => {
        assert.equal(mapEventToTone('model_ack_confirmed'), 'acknowledged');
    });

    test('model_ack_timeout → warning', () => {
        assert.equal(mapEventToTone('model_ack_timeout'), 'warning');
    });

    test('bridge_handoff_ack → pending', () => {
        assert.equal(mapEventToTone('bridge_handoff_ack'), 'pending');
    });

    test('unknown type falls back to warning', () => {
        assert.equal(mapEventToTone('nonexistent_type' as ToolLoopUiEventType), 'warning');
    });
});

// ────────────────────────────────────────────
// getCardTitle
// ────────────────────────────────────────────

describe('getCardTitle', () => {
    test('tool_call_detected → "Tool: {name}"', () => {
        const event = makeUiEvent('tool_call_detected', { toolName: 'get_weather' });
        assert.equal(getCardTitle(event), 'Tool: get_weather');
    });

    test('tool_execution_started → "Executing: {name}"', () => {
        const event = makeUiEvent('tool_execution_started', { toolName: 'get_weather' });
        assert.equal(getCardTitle(event), 'Executing: get_weather');
    });

    test('tool_execution_succeeded → "Tool: {name}"', () => {
        const event = makeUiEvent('tool_execution_succeeded', { toolName: 'get_weather' });
        assert.equal(getCardTitle(event), 'Tool: get_weather');
    });

    test('tool_execution_failed → "Tool error: {name}"', () => {
        const event = makeUiEvent('tool_execution_failed', { toolName: 'get_weather' });
        assert.equal(getCardTitle(event), 'Tool error: get_weather');
    });

    test('tool_result_inserted → "Result inserted: {name}"', () => {
        const event = makeUiEvent('tool_result_inserted', { toolName: 'get_weather' });
        assert.equal(getCardTitle(event), 'Result inserted: get_weather');
    });

    test('tool_result_submitted → "Result submitted: {name}"', () => {
        const event = makeUiEvent('tool_result_submitted', { toolName: 'get_weather' });
        assert.equal(getCardTitle(event), 'Result submitted: get_weather');
    });

    test('tool_result_blocked → "Result blocked: {name}"', () => {
        const event = makeUiEvent('tool_result_blocked', { toolName: 'get_weather' });
        assert.equal(getCardTitle(event), 'Result blocked: get_weather');
    });

    test('tool_result_failed → "Result failed: {name}"', () => {
        const event = makeUiEvent('tool_result_failed', { toolName: 'get_weather' });
        assert.equal(getCardTitle(event), 'Result failed: get_weather');
    });

    test('execution_blocked → "Blocked: {name}"', () => {
        const event = makeUiEvent('execution_blocked', { toolName: 'get_weather' });
        assert.equal(getCardTitle(event), 'Blocked: get_weather');
    });

    test('bridge_handoff_ack → "ACK pending: {name}"', () => {
        const event = makeUiEvent('bridge_handoff_ack', { toolName: 'get_weather' });
        assert.equal(getCardTitle(event), 'ACK pending: get_weather');
    });

    test('model_ack_confirmed → "ACK confirmed: {name}"', () => {
        const event = makeUiEvent('model_ack_confirmed', { toolName: 'get_weather' });
        assert.equal(getCardTitle(event), 'ACK confirmed: get_weather');
    });

    test('model_ack_timeout → "ACK timeout: {name}"', () => {
        const event = makeUiEvent('model_ack_timeout', { toolName: 'get_weather' });
        assert.equal(getCardTitle(event), 'ACK timeout: get_weather');
    });

    test('missing toolName → uses "unknown"', () => {
        const event = makeUiEvent('tool_call_detected', { toolName: undefined });
        assert.equal(getCardTitle(event), 'Tool: unknown');
    });
});

// ────────────────────────────────────────────
// getCardStatusIcon
// ────────────────────────────────────────────

describe('getCardStatusIcon', () => {
    test('neutral → 🔍', () => {
        assert.equal(getCardStatusIcon('neutral'), '🔍');
    });

    test('pending → ⏳', () => {
        assert.equal(getCardStatusIcon('pending'), '⏳');
    });

    test('success → ✅', () => {
        assert.equal(getCardStatusIcon('success'), '✅');
    });

    test('acknowledged → ✅', () => {
        assert.equal(getCardStatusIcon('acknowledged'), '✅');
    });

    test('warning → ⚠️', () => {
        assert.equal(getCardStatusIcon('warning'), '⚠️');
    });

    test('blocked → 🚫', () => {
        assert.equal(getCardStatusIcon('blocked'), '🚫');
    });

    test('error → ❌', () => {
        assert.equal(getCardStatusIcon('error'), '❌');
    });
});

// ────────────────────────────────────────────
// ToolLoopCardStateStore
// ────────────────────────────────────────────

describe('ToolLoopCardStateStore', () => {
    test('apply() returns state with current event as latest', () => {
        const store = new ToolLoopCardStateStore();
        const event = makeUiEvent('tool_call_detected');
        const state = store.apply(event);

        assert.equal(state.callId, 'call-1');
        assert.equal(state.toolName, 'test_tool');
        assert.equal(state.currentType, 'tool_call_detected');
        assert.equal(state.currentTone, 'neutral');
        assert.equal(state.timeline.length, 1);
    });

    test('apply() accumulates events for same callId', () => {
        const store = new ToolLoopCardStateStore();

        store.apply(makeUiEvent('tool_call_detected', { timestamp: 100 }));
        store.apply(makeUiEvent('tool_execution_started', { timestamp: 200 }));
        const state = store.apply(makeUiEvent('tool_execution_succeeded', { timestamp: 300 }));

        assert.equal(state.currentType, 'tool_execution_succeeded');
        assert.equal(state.currentTone, 'success');
        assert.equal(state.timeline.length, 3);
        // Timeline preserves order
        assert.equal(state.timeline[0].type, 'tool_call_detected');
        assert.equal(state.timeline[1].type, 'tool_execution_started');
        assert.equal(state.timeline[2].type, 'tool_execution_succeeded');
    });

    test('apply() rejects event without callId and returns null', () => {
        const store = new ToolLoopCardStateStore();
        const event = makeUiEvent('tool_call_detected', { callId: undefined });
        const state = store.apply(event);

        assert.equal(state, null);
    });

    test('apply() tracks different callIds independently', () => {
        const store = new ToolLoopCardStateStore();

        store.apply(makeUiEvent('tool_call_detected', { callId: 'call-A', toolName: 'tool_a' }));
        store.apply(makeUiEvent('tool_call_detected', { callId: 'call-B', toolName: 'tool_b' }));
        store.apply(makeUiEvent('tool_execution_succeeded', { callId: 'call-A', toolName: 'tool_a' }));

        const stateA = store.get('call-A');
        const stateB = store.get('call-B');

        assert.equal(stateA!.currentType, 'tool_execution_succeeded');
        assert.equal(stateA!.currentTone, 'success');
        assert.equal(stateA!.timeline.length, 2);

        assert.equal(stateB!.currentType, 'tool_call_detected');
        assert.equal(stateB!.currentTone, 'neutral');
        assert.equal(stateB!.timeline.length, 1);
    });

    test('get() returns null for unknown callId', () => {
        const store = new ToolLoopCardStateStore();
        assert.equal(store.get('nonexistent'), null);
    });

    test('timeline entry preserves event metadata', () => {
        const store = new ToolLoopCardStateStore();
        const event = makeUiEvent('tool_execution_failed', {
            timestamp: 999,
            errorCode: 'TIMEOUT',
            error: 'Connection timed out',
            phase: 'execution',
        });
        const state = store.apply(event);

        assert.equal(state!.timeline[0].type, 'tool_execution_failed');
        assert.equal(state!.timeline[0].timestamp, 999);
        assert.equal(state!.timeline[0].errorCode, 'TIMEOUT');
        assert.equal(state!.timeline[0].error, 'Connection timed out');
        assert.equal(state!.timeline[0].phase, 'execution');
    });

    test('state title reflects latest event', () => {
        const store = new ToolLoopCardStateStore();
        store.apply(makeUiEvent('tool_call_detected'));
        const state = store.apply(makeUiEvent('tool_result_submitted'));

        assert.equal(state!.title, 'Result submitted: test_tool');
    });

    test('state statusIcon reflects latest tone', () => {
        const store = new ToolLoopCardStateStore();
        store.apply(makeUiEvent('tool_call_detected'));
        const state = store.apply(makeUiEvent('tool_execution_failed'));

        assert.equal(state!.statusIcon, '❌');
    });
});

// ────────────────────────────────────────────
// isToolLoopUiEvent (shape guard)
// ────────────────────────────────────────────

describe('isToolLoopUiEvent', () => {
    test('valid event returns true', () => {
        assert.equal(isToolLoopUiEvent({
            version: 1,
            type: 'tool_call_detected',
            timestamp: Date.now(),
            callId: 'call-1',
            toolName: 'test_tool',
        }), true);
    });

    test('minimal valid event (only required fields) returns true', () => {
        assert.equal(isToolLoopUiEvent({
            version: 1,
            type: 'tool_call_detected',
            timestamp: 1000,
        }), true);
    });

    test('null returns false', () => {
        assert.equal(isToolLoopUiEvent(null), false);
    });

    test('undefined returns false', () => {
        assert.equal(isToolLoopUiEvent(undefined), false);
    });

    test('non-object returns false', () => {
        assert.equal(isToolLoopUiEvent('string'), false);
        assert.equal(isToolLoopUiEvent(42), false);
    });

    test('wrong version returns false', () => {
        assert.equal(isToolLoopUiEvent({
            version: 2,
            type: 'tool_call_detected',
            timestamp: 1000,
        }), false);
    });

    test('non-string type returns false', () => {
        assert.equal(isToolLoopUiEvent({
            version: 1,
            type: 123,
            timestamp: 1000,
        }), false);
    });

    test('non-number timestamp returns false', () => {
        assert.equal(isToolLoopUiEvent({
            version: 1,
            type: 'tool_call_detected',
            timestamp: '2024-01-01',
        }), false);
    });

    test('NaN timestamp returns false', () => {
        assert.equal(isToolLoopUiEvent({
            version: 1,
            type: 'tool_call_detected',
            timestamp: NaN,
        }), false);
    });

    test('Infinity timestamp returns false', () => {
        assert.equal(isToolLoopUiEvent({
            version: 1,
            type: 'tool_call_detected',
            timestamp: Infinity,
        }), false);
    });

    test('non-string callId returns false', () => {
        assert.equal(isToolLoopUiEvent({
            version: 1,
            type: 'tool_call_detected',
            timestamp: 1000,
            callId: 123,
        }), false);
    });

    test('non-string toolName returns false', () => {
        assert.equal(isToolLoopUiEvent({
            version: 1,
            type: 'tool_call_detected',
            timestamp: 1000,
            toolName: { name: 'x' },
        }), false);
    });

    test('non-string error returns false', () => {
        assert.equal(isToolLoopUiEvent({
            version: 1,
            type: 'tool_call_detected',
            timestamp: 1000,
            error: new Error('oops'),
        }), false);
    });

    test('non-string phase returns false', () => {
        assert.equal(isToolLoopUiEvent({
            version: 1,
            type: 'tool_call_detected',
            timestamp: 1000,
            phase: 42,
        }), false);
    });

    test('non-string injectOutcome returns false', () => {
        assert.equal(isToolLoopUiEvent({
            version: 1,
            type: 'tool_call_detected',
            timestamp: 1000,
            injectOutcome: true,
        }), false);
    });

    test('unknown event type still passes guard (guard is shape-only)', () => {
        assert.equal(isToolLoopUiEvent({
            version: 1,
            type: 'some_future_event_type',
            timestamp: 1000,
        }), true);
    });
});

// ────────────────────────────────────────────
// isKnownToolLoopEventType
// ────────────────────────────────────────────

describe('isKnownToolLoopEventType', () => {
    test('known type returns true', () => {
        assert.equal(isKnownToolLoopEventType('tool_call_detected'), true);
        assert.equal(isKnownToolLoopEventType('tool_execution_failed'), true);
        assert.equal(isKnownToolLoopEventType('model_ack_confirmed'), true);
    });

    test('unknown type returns false', () => {
        assert.equal(isKnownToolLoopEventType('some_future_type'), false);
        assert.equal(isKnownToolLoopEventType(''), false);
    });
});

// ────────────────────────────────────────────
// mapEventToTone — unknown type fallback
// ────────────────────────────────────────────

describe('mapEventToTone — unknown type handling', () => {
    test('unknown type falls back to warning', () => {
        assert.equal(mapEventToTone('nonexistent_type' as any), 'warning');
    });

    test('empty string type falls back to warning', () => {
        assert.equal(mapEventToTone('' as any), 'warning');
    });
});

// ────────────────────────────────────────────
// Gate 6E: ACK latencyMs support
// ────────────────────────────────────────────

describe('isToolLoopUiEvent — Gate 6E: latencyMs validation', () => {
    test('accepts finite non-negative latencyMs', () => {
        assert.equal(isToolLoopUiEvent({
            version: 1,
            type: 'model_ack_confirmed',
            timestamp: 1000,
            latencyMs: 450,
        }), true);
    });

    test('accepts zero latencyMs', () => {
        assert.equal(isToolLoopUiEvent({
            version: 1,
            type: 'model_ack_confirmed',
            timestamp: 1000,
            latencyMs: 0,
        }), true);
    });

    test('accepts undefined latencyMs (optional)', () => {
        assert.equal(isToolLoopUiEvent({
            version: 1,
            type: 'model_ack_confirmed',
            timestamp: 1000,
        }), true);
    });

    test('rejects string latencyMs', () => {
        assert.equal(isToolLoopUiEvent({
            version: 1,
            type: 'model_ack_confirmed',
            timestamp: 1000,
            latencyMs: '450',
        }), false);
    });

    test('rejects NaN latencyMs', () => {
        assert.equal(isToolLoopUiEvent({
            version: 1,
            type: 'model_ack_confirmed',
            timestamp: 1000,
            latencyMs: NaN,
        }), false);
    });

    test('rejects Infinity latencyMs', () => {
        assert.equal(isToolLoopUiEvent({
            version: 1,
            type: 'model_ack_confirmed',
            timestamp: 1000,
            latencyMs: Infinity,
        }), false);
    });

    test('rejects negative latencyMs', () => {
        assert.equal(isToolLoopUiEvent({
            version: 1,
            type: 'model_ack_confirmed',
            timestamp: 1000,
            latencyMs: -100,
        }), false);
    });
});

describe('ToolLoopCardStateStore — Gate 6E: latencyMs in timeline', () => {
    test('apply() preserves latencyMs in timeline entry', () => {
        const store = new ToolLoopCardStateStore();
        const event = makeUiEvent('model_ack_confirmed', {
            timestamp: 5000,
            latencyMs: 450,
        });
        const state = store.apply(event);

        assert.ok(state);
        assert.equal(state.timeline[0].latencyMs, 450);
    });

    test('apply() handles event without latencyMs (undefined)', () => {
        const store = new ToolLoopCardStateStore();
        const event = makeUiEvent('tool_call_detected');
        const state = store.apply(event);

        assert.ok(state);
        assert.equal(state.timeline[0].latencyMs, undefined);
    });
});
