/**
 * BH-4 TDD: NotionHostBindings
 *
 * T-BH-15..T-BH-16 + T-BH-17b + T-BH-18..T-BH-18b + T-N-06 + T-N-06b
 * (Slice N: ConnectionStatePort D6 guard)
 * (Slice O: T-BH-17 removed — legacy isReady? path deleted; T-N-06/T-N-06b cleaned up)
 *
 * Critical contract (from ToolCallLoop line 57):
 *   if (!result.success) return;  → formattedResponse is NOT inserted when success:false
 *
 * success:true  = formattedResponse is safe to insert (tool may have succeeded OR errored)
 * success:false = infra failure — do not insert, do not attempt recovery
 *
 * Run:
 *   node --test --experimental-strip-types \
 *     src/plugins/adapters/__tests__/notion.host-bindings.test.ts
 * (from MCP-SuperAssistant/pages/content/)
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createNotionHostBindings } from '../notion/notion-host-bindings.ts';
import type { ToolCallPayload } from '../../../../../../../mcp-runtime/src/core/tool-call-parser.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal formatFunctionResult mock that produces predictable XML. */
function makeFormatter() {
    return (opts: { callId: string; name: string; status: 'success' | 'error'; result: unknown }) =>
        `<function_result callId="${opts.callId}" name="${opts.name}" status="${opts.status}">${JSON.stringify(opts.result)}</function_result>`;
}

/** Build a minimal ToolCallPayload for testing. */
function makePayload(overrides?: Partial<ToolCallPayload>): ToolCallPayload {
    return {
        name: 'test_tool',
        callId: 'call-abc123',
        arguments: { key: 'value' },
        executable: true,
        ...overrides,
    };
}

// ---------------------------------------------------------------------------
// T-BH-15 — callTool success → success:true + success formattedResponse
// ---------------------------------------------------------------------------

describe('T-BH-15: callTool success', () => {
    it('returns success:true and success formattedResponse', async () => {
        const callToolResult = { ok: true, data: 'result data' };
        const mcpClient = {
            callTool: async (_name: string, _args: Record<string, unknown>) => callToolResult,
        };
        const hb = createNotionHostBindings({ mcpClient, formatFunctionResult: makeFormatter() });

        const result = await hb.onToolCallDetect(makePayload({ callId: 'call-001', name: 'my_tool' }));

        assert.equal(result.success, true, 'success must be true on callTool success');
        assert.equal(result.callId, 'call-001');
        assert.ok(result.formattedResponse.includes('status="success"'), `Expected success XML, got: ${result.formattedResponse}`);
        assert.ok(result.formattedResponse.includes('callId="call-001"'), `Expected callId in response`);
        assert.equal(result.error, undefined);
    });

    it('T-BH-15b: callTool result is embedded in formattedResponse', async () => {
        const callToolResult = { value: 42 };
        const mcpClient = { callTool: async () => callToolResult };
        const hb = createNotionHostBindings({ mcpClient, formatFunctionResult: makeFormatter() });

        const result = await hb.onToolCallDetect(makePayload());

        assert.ok(result.formattedResponse.includes(JSON.stringify(callToolResult)));
    });
});

// ---------------------------------------------------------------------------
// T-BH-16 — callTool throws → success:true + error formattedResponse
//
// KEY CONTRACT: tool execution errors are still inserted into Notion AI
// so the AI can see the error and adjust its reasoning.
// success:true means "formattedResponse is safe to insert" — NOT "tool succeeded"
// ---------------------------------------------------------------------------

describe('T-BH-16: callTool throws → success:true (still insert error result)', () => {
    it('returns success:true and error formattedResponse when callTool throws', async () => {
        const mcpClient = {
            callTool: async () => { throw new Error('connection refused'); },
        };
        const hb = createNotionHostBindings({ mcpClient, formatFunctionResult: makeFormatter() });

        const result = await hb.onToolCallDetect(makePayload({ callId: 'call-err-1' }));

        assert.equal(result.success, true, 'success must be TRUE even on tool error — error result should be inserted');
        assert.ok(result.formattedResponse.includes('status="error"'), `Expected error XML, got: ${result.formattedResponse}`);
        assert.ok(result.error === 'connection refused', `Expected error message, got: ${result.error}`);
    });

    it('T-BH-16b: non-Error thrown value is stringified', async () => {
        const mcpClient = {
            callTool: async () => { throw 'plain string error'; },
        };
        const hb = createNotionHostBindings({ mcpClient, formatFunctionResult: makeFormatter() });

        const result = await hb.onToolCallDetect(makePayload());

        assert.equal(result.success, true);
        assert.ok(result.error === 'plain string error');
    });
});

// ---------------------------------------------------------------------------
// T-BH-18 — onAdapterError does not throw outward
// ---------------------------------------------------------------------------

describe('T-BH-18: onAdapterError no-crash', () => {
    it('calling onAdapterError with error payload does not throw', () => {
        const hb = createNotionHostBindings({
            mcpClient: { callTool: async () => {} },
            formatFunctionResult: makeFormatter(),
        });

        assert.doesNotThrow(() => {
            hb.onAdapterError({ code: 'INSERT_FAILED', message: 'something went wrong' });
        });
    });

    it('T-BH-18b: onAdapterError with details does not throw', () => {
        const hb = createNotionHostBindings({
            mcpClient: { callTool: async () => {} },
            formatFunctionResult: makeFormatter(),
        });

        assert.doesNotThrow(() => {
            hb.onAdapterError({ code: 'SOME_CODE', message: 'msg', details: { extra: 'data' } });
        });
    });
});

// ---------------------------------------------------------------------------
// T-BH-18b — connectionState absent → proceeds to callTool (no guard)
//
// When connectionState is not provided in deps, no connection check is performed.
// callTool is called unconditionally (it will throw internally if MCP is down).
// ---------------------------------------------------------------------------

describe('T-BH-18b: connectionState absent → proceeds to callTool', () => {
    it('calls callTool when connectionState is not provided in deps', async () => {
        let callToolCalled = false;
        const mcpClient = {
            callTool: async () => { callToolCalled = true; return { result: 'ok' }; },
        };
        const hb = createNotionHostBindings({ mcpClient, formatFunctionResult: makeFormatter() });

        const result = await hb.onToolCallDetect(makePayload());

        assert.equal(result.success, true);
        assert.equal(callToolCalled, true, 'callTool must be called when connectionState is absent');
    });
});

// ---------------------------------------------------------------------------
// T-BH-17b — connectionState.isConnected() = false → success:false + MCP_NOT_CONNECTED
//
// Slice N: D6 guard (new authoritative port).
// When connectionState is present and isConnected() returns false,
// block the call with MCP_NOT_CONNECTED (different error code from legacy).
// ---------------------------------------------------------------------------

describe('T-BH-17b: connectionState.isConnected() = false → success:false + MCP_NOT_CONNECTED', () => {
    it('returns success:false and MCP_NOT_CONNECTED when connectionState blocks', async () => {
        let callToolCalled = false;
        const mcpClient = {
            callTool: async () => { callToolCalled = true; return {}; },
        };
        const connectionState = {
            isConnected: () => false,
        };
        const hb = createNotionHostBindings({ mcpClient, formatFunctionResult: makeFormatter(), connectionState });

        const result = await hb.onToolCallDetect(makePayload({ callId: 'call-cs-1' }));

        assert.equal(result.success, false, 'success must be false when connectionState blocks');
        assert.equal(result.formattedResponse, '', 'formattedResponse must be empty when blocked');
        assert.equal(result.error, 'MCP_NOT_CONNECTED');
        assert.equal(callToolCalled, false, 'callTool must NOT be called when connectionState blocks');
    });
});

// ---------------------------------------------------------------------------
// T-N-06 — D6 precedence: connectionState false → MCP_NOT_CONNECTED
//
// connectionState is AUTHORITATIVE: if present and returning false,
// the call is blocked regardless of mcpClient state.
// ---------------------------------------------------------------------------

describe('T-N-06: connectionState false → MCP_NOT_CONNECTED (D6 precedence)', () => {
    it('blocks call with MCP_NOT_CONNECTED when connectionState returns false', async () => {
        let callToolCalled = false;
        const mcpClient = {
            callTool: async () => { callToolCalled = true; return {}; },
        };
        const connectionState = {
            isConnected: () => false,
        };
        const hb = createNotionHostBindings({ mcpClient, formatFunctionResult: makeFormatter(), connectionState });

        const result = await hb.onToolCallDetect(makePayload({ callId: 'call-d6-1' }));

        assert.equal(result.success, false, 'connectionState false must block the call');
        assert.equal(result.error, 'MCP_NOT_CONNECTED');
        assert.equal(callToolCalled, false);
    });
});

// ---------------------------------------------------------------------------
// T-N-06b — connectionState true → proceed to callTool
//
// connectionState true bypasses any other check.
// ---------------------------------------------------------------------------

describe('T-N-06b: connectionState true → proceed to callTool (connectionState wins)', () => {
    it('allows call when connectionState reports connected', async () => {
        let callToolCalled = false;
        const mcpClient = {
            callTool: async () => { callToolCalled = true; return { result: 'ok' }; },
        };
        const connectionState = {
            isConnected: () => true,
        };
        const hb = createNotionHostBindings({ mcpClient, formatFunctionResult: makeFormatter(), connectionState });

        const result = await hb.onToolCallDetect(makePayload({ callId: 'call-d6-2' }));

        assert.equal(result.success, true, 'connectionState true must allow call to proceed');
        assert.equal(callToolCalled, true, 'callTool must be called when connectionState is true');
    });
});
