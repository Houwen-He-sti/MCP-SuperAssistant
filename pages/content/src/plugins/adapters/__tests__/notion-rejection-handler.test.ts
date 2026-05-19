/**
 * notion-rejection-handler.test.ts — TDD tests for NotionRejectionHandler (Slice L)
 *
 * T-L-01: tool_not_found → correct formatFunctionResult call + success:true
 * T-L-02: args_invalid → validationMessage + validationDetails in result
 * T-L-03: formatter throws → success:false, no unhandled rejection
 * T-L-04: formatter returns '' → success:false (fail-closed guard)
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ToolCallRejectReason } from '../../../../../../../mcp-runtime/src/core/tool-call-loop.ts';
import type { ToolCallPayload } from '../../../../../../../mcp-runtime/src/core/tool-call-parser.ts';
import { NotionRejectionHandler } from '../notion/notion-rejection-handler.ts';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makePayload(overrides?: Partial<ToolCallPayload>): ToolCallPayload {
  return {
    name: 'echo',
    callId: 'call-001',
    arguments: {},
    executable: true,
    ...overrides,
  };
}

function makeToolNotFoundReason(toolName = 'echo', callId = 'call-001'): ToolCallRejectReason {
  return { code: 'tool_not_found', toolName, callId };
}

function makeArgsInvalidReason(
  overrides?: Partial<Extract<ToolCallRejectReason, { code: 'args_invalid' }>>,
): ToolCallRejectReason {
  return {
    code: 'args_invalid',
    toolName: 'echo',
    callId: 'call-001',
    validationCode: 'arg_validation_failed',
    validationMessage: 'Missing required field: message',
    validationDetails: { path: '/message', type: 'string' },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('NotionRejectionHandler — T-L-*', () => {
  it('T-L-01: tool_not_found → formatFunctionResult called with correct opts, returns success:true', async () => {
    const calls: Array<Parameters<ConstructorParameters<typeof NotionRejectionHandler>[0]>[0]> = [];

    const fmt = (opts: { callId: string; name: string; status: 'success' | 'error'; result: unknown }) => {
      calls.push(opts);
      return '{"type":"tool_result","tool_use_id":"call-001","content":"Tool not found: echo"}';
    };

    const handler = new NotionRejectionHandler(fmt);
    const payload = makePayload({ callId: 'call-001', name: 'echo' });
    const reason = makeToolNotFoundReason('echo', 'call-001');

    const result = await handler.onToolCallReject(payload, reason);

    assert.equal(result.success, true, 'success must be true');
    assert.ok(result.formattedResponse.length > 0, 'formattedResponse must not be empty');

    // Verify formatFunctionResult received correct arguments
    assert.equal(calls.length, 1, 'formatFunctionResult called once');
    const opts = calls[0];
    assert.equal(opts.callId, 'call-001', 'callId must come from payload');
    assert.equal(opts.name, 'echo', 'name must come from payload');
    assert.equal(opts.status, 'error', 'status must be error');
    const r = opts.result as { code: string; toolName: string };
    assert.equal(r.code, 'tool_not_found', 'result.code must be tool_not_found');
    assert.equal(r.toolName, 'echo', 'result.toolName must be present');
  });

  it('T-L-02: args_invalid → validationMessage + validationDetails in result payload', async () => {
    const calls: Array<Parameters<ConstructorParameters<typeof NotionRejectionHandler>[0]>[0]> = [];

    const fmt = (opts: { callId: string; name: string; status: 'success' | 'error'; result: unknown }) => {
      calls.push(opts);
      return '{"type":"tool_result","content":"Invalid args"}';
    };

    const handler = new NotionRejectionHandler(fmt);
    const payload = makePayload({ callId: 'call-002', name: 'echo' });
    const reason = makeArgsInvalidReason({
      callId: 'call-002',
      validationMessage: 'Missing required field: message',
      validationDetails: { path: '/message', type: 'string' },
    });

    const result = await handler.onToolCallReject(payload, reason);

    assert.equal(result.success, true);
    assert.ok(result.formattedResponse.length > 0);

    const opts = calls[0];
    assert.equal(opts.status, 'error');
    const r = opts.result as { code: string; validationMessage: string; validationDetails: unknown };
    assert.equal(r.code, 'args_invalid');
    assert.ok(r.validationMessage.length > 0, 'validationMessage must be present in result');
    assert.deepEqual(r.validationDetails, { path: '/message', type: 'string' }, 'validationDetails must be preserved');
  });

  it('T-L-03: formatter throws → returns success:false, no thrown exception', async () => {
    const fmt = (_opts: unknown): string => {
      throw new Error('formatter exploded');
    };

    const handler = new NotionRejectionHandler(fmt);
    const payload = makePayload();
    const reason = makeToolNotFoundReason();

    let result: Awaited<ReturnType<typeof handler.onToolCallReject>>;
    await assert.doesNotReject(async () => {
      result = await handler.onToolCallReject(payload, reason);
    }, 'handler must not throw even if formatter throws');

    assert.equal(result!.success, false, 'success must be false when formatter throws');
  });

  it('T-L-04: formatter returns empty string → success:false (fail-closed guard)', async () => {
    const fmt = (_opts: unknown): string => '';

    const handler = new NotionRejectionHandler(fmt);
    const payload = makePayload();
    const reason = makeToolNotFoundReason();

    const result = await handler.onToolCallReject(payload, reason);

    assert.equal(result.success, false, 'empty formattedResponse must yield success:false');
  });
});
