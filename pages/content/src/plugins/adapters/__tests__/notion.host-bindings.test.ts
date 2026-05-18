/**
 * BH-4 TDD: NotionHostBindings
 *
 * T-BH-15..T-BH-18b
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
// T-BH-17 — isReady() = false → success:false + empty formattedResponse
//
// Infrastructure not available: do NOT attempt insert, do NOT call callTool
// ---------------------------------------------------------------------------

describe('T-BH-17: mcpClient.isReady() = false → success:false', () => {
    it('returns success:false and empty formattedResponse when not ready', async () => {
        let callToolCalled = false;
        const mcpClient = {
            callTool: async () => { callToolCalled = true; return {}; },
            isReady: () => false,
        };
        const hb = createNotionHostBindings({ mcpClient, formatFunctionResult: makeFormatter() });

        const result = await hb.onToolCallDetect(makePayload({ callId: 'call-nr-1' }));

        assert.equal(result.success, false, 'success must be false when mcpClient not ready');
        assert.equal(result.formattedResponse, '', 'formattedResponse must be empty when not ready');
        assert.equal(result.error, 'MCP_CLIENT_NOT_READY');
        assert.equal(callToolCalled, false, 'callTool must NOT be called when not ready');
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
// T-BH-18b — isReady optional: absent → proceed to callTool
// ---------------------------------------------------------------------------

describe('T-BH-18b: isReady absent → proceeds to callTool', () => {
    it('calls callTool when isReady is not defined on mcpClient', async () => {
        let callToolCalled = false;
        const mcpClient = {
            // isReady NOT defined
            callTool: async () => { callToolCalled = true; return { result: 'ok' }; },
        };
        const hb = createNotionHostBindings({ mcpClient, formatFunctionResult: makeFormatter() });

        const result = await hb.onToolCallDetect(makePayload());

        assert.equal(result.success, true);
        assert.equal(callToolCalled, true, 'callTool must be called when isReady is absent');
    });
});
