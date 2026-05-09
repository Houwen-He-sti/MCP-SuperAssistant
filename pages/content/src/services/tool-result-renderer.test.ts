/**
 * Tests for ToolResultRenderer pure utility functions.
 *
 * Zero external dependencies — runs directly with Node.js test runner.
 *
 * Tests cover:
 * - stringifyToolResult: string/object/circular/BigInt/null/undefined
 * - truncatePreview: within limit / exceeding limit
 * - extractRenderData: valid detail / missing fields / null detail / truncation
 *
 * Run: node --test --experimental-strip-types tool-result-renderer.test.ts
 * (from pages/content/src/services/ directory)
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
    extractCallId,
    extractFunctionName,
    extractRenderData,
    extractResult,
    stringifyToolResult,
    truncatePreview,
} from './tool-result-renderer-utils.ts';

// ────────────────────────────────────────────
// stringifyToolResult
// ────────────────────────────────────────────

describe('stringifyToolResult', () => {
    test('string → passthrough', () => {
        assert.equal(stringifyToolResult('hello world'), 'hello world');
    });

    test('empty string → empty string', () => {
        assert.equal(stringifyToolResult(''), '');
    });

    test('null → empty string', () => {
        assert.equal(stringifyToolResult(null), '');
    });

    test('undefined → empty string', () => {
        assert.equal(stringifyToolResult(undefined), '');
    });

    test('number → JSON string', () => {
        assert.equal(stringifyToolResult(42), '42');
    });

    test('boolean → JSON string', () => {
        assert.equal(stringifyToolResult(true), 'true');
    });

    test('object → pretty-printed JSON', () => {
        const obj = { key: 'value', nested: { a: 1 } };
        const result = stringifyToolResult(obj);
        assert.equal(result, JSON.stringify(obj, null, 2));
    });

    test('array → pretty-printed JSON', () => {
        const arr = [1, 2, 3];
        assert.equal(stringifyToolResult(arr), JSON.stringify(arr, null, 2));
    });

    test('BigInt → string representation', () => {
        assert.equal(stringifyToolResult(BigInt(9007199254740991)), '9007199254740991');
    });

    test('circular reference → String() fallback', () => {
        const obj: any = { a: 1 };
        obj.self = obj;
        const result = stringifyToolResult(obj);
        assert.equal(typeof result, 'string');
        assert.ok(result.length > 0, 'should produce non-empty string');
    });
});

// ────────────────────────────────────────────
// truncatePreview
// ────────────────────────────────────────────

describe('truncatePreview', () => {
    test('short text → no truncation', () => {
        assert.equal(truncatePreview('hello', 100), 'hello');
    });

    test('text at exact limit → no truncation', () => {
        const text = 'x'.repeat(100);
        assert.equal(truncatePreview(text, 100), text);
    });

    test('text exceeding limit → truncated with marker', () => {
        const text = 'x'.repeat(150);
        const result = truncatePreview(text, 100);
        assert.ok(result.startsWith('x'.repeat(100)));
        assert.ok(result.endsWith('... (truncated)'));
        assert.ok(result.length < text.length + 20);
    });

    test('default limit is 500', () => {
        const text = 'x'.repeat(600);
        const result = truncatePreview(text);
        assert.ok(result.startsWith('x'.repeat(500)));
        assert.ok(result.includes('(truncated)'));
    });

    test('empty string → empty string', () => {
        assert.equal(truncatePreview('', 100), '');
    });
});

// ────────────────────────────────────────────
// extractRenderData
// ────────────────────────────────────────────

describe('extractRenderData', () => {
    test('valid detail with result → success', () => {
        const data = extractRenderData({
            result: '{"key":"value"}',
            callId: 'test-call-1',
            functionName: 'read_file',
        });
        assert.ok(data);
        assert.equal(data.callId, 'test-call-1');
        assert.equal(data.functionName, 'read_file');
        assert.equal(data.status, 'success');
        assert.ok(data.resultPreview.includes('key'));
        assert.equal(data.error, undefined);
    });

    test('detail without result → error', () => {
        const data = extractRenderData({
            callId: 'test-call-2',
            functionName: 'write_file',
        });
        assert.ok(data);
        assert.equal(data.status, 'error');
        assert.equal(data.error, 'No result returned');
    });

    test('detail without callId → fallback id generated', () => {
        const data = extractRenderData({
            result: 'some result',
            functionName: 'test_tool',
        });
        assert.ok(data);
        assert.ok(data.callId.startsWith('fallback-'));
    });

    test('detail without functionName → "unknown_tool"', () => {
        const data = extractRenderData({
            result: 'some result',
            callId: 'call-3',
        });
        assert.ok(data);
        assert.equal(data.functionName, 'unknown_tool');
    });

    test('null detail → null', () => {
        const data = extractRenderData(null);
        assert.equal(data, null);
    });

    test('undefined detail → null', () => {
        const data = extractRenderData(undefined);
        assert.equal(data, null);
    });

    test('null detail calls warnFn', () => {
        let warned = false;
        extractRenderData(null, () => { warned = true; });
        assert.ok(warned, 'warnFn should have been called');
    });

    test('result is truncated in preview', () => {
        const longResult = 'x'.repeat(1000);
        const data = extractRenderData({
            result: longResult,
            callId: 'call-long',
            functionName: 'big_tool',
        });
        assert.ok(data);
        assert.ok(data.resultPreview.length < longResult.length);
        assert.ok(data.resultPreview.includes('(truncated)'));
    });

    test('confirmationText used as preview when no result → still success', () => {
        const data = extractRenderData({
            callId: 'call-confirm',
            functionName: 'file_tool',
            confirmationText: 'File attached successfully',
        });
        assert.ok(data);
        assert.equal(data.resultPreview, 'File attached successfully');
        assert.equal(data.status, 'success', 'confirmationText means success');
        assert.equal(data.error, undefined);
    });

    test('empty string result → success (not error)', () => {
        const data = extractRenderData({
            result: '',
            callId: 'call-empty',
            functionName: 'empty_tool',
        });
        assert.ok(data);
        // empty string is a valid result (not null/undefined)
        assert.equal(data.status, 'success');
        assert.equal(data.error, undefined);
    });

    test('rawResult also truncated at MAX_RAW_LENGTH', () => {
        const hugeResult = 'y'.repeat(20_000);
        const data = extractRenderData({
            result: hugeResult,
            callId: 'call-huge',
            functionName: 'huge_tool',
        });
        assert.ok(data);
        assert.ok(data.rawResult);
        assert.ok(data.rawResult!.length <= 10_000 + 20); // MAX_RAW_LENGTH + truncation marker
        assert.ok(data.rawResult!.includes('(truncated)'));
    });

    test('has timestamp', () => {
        const before = Date.now();
        const data = extractRenderData({
            result: 'test',
            callId: 'call-ts',
            functionName: 'ts_tool',
        });
        assert.ok(data);
        assert.ok(data.timestamp >= before);
        assert.ok(data.timestamp <= Date.now());
    });
});

// ────────────────────────────────────────────
// XSS safety (textContent contract)
// ────────────────────────────────────────────

describe('XSS safety in stringifyToolResult', () => {
    test('HTML tags are preserved as literal strings', () => {
        const result = stringifyToolResult('<script>alert("xss")</script>');
        assert.equal(result, '<script>alert("xss")</script>');
    });

    test('HTML in object values are preserved as JSON', () => {
        const result = stringifyToolResult({ html: '<img onerror="alert(1)">' });
        // JSON.stringify escapes inner quotes, but HTML structure is preserved
        assert.ok(result.includes('<img onerror='));
        assert.ok(result.includes('alert(1)'));
    });
});

// ────────────────────────────────────────────
// extractCallId — event field alias resolution
// ────────────────────────────────────────────

describe('extractCallId', () => {
    test('direct callId → used', () => {
        assert.equal(extractCallId({ callId: 'c1' }), 'c1');
    });

    test('toolCallId fallback', () => {
        assert.equal(extractCallId({ toolCallId: 'tc1' }), 'tc1');
    });

    test('execution.callId fallback', () => {
        assert.equal(extractCallId({ execution: { callId: 'ec1' } }), 'ec1');
    });

    test('execution.toolCallId fallback', () => {
        assert.equal(extractCallId({ execution: { toolCallId: 'etc1' } }), 'etc1');
    });

    test('execution.id fallback', () => {
        assert.equal(extractCallId({ execution: { id: 'eid1' } }), 'eid1');
    });

    test('toolCall.call_id fallback', () => {
        assert.equal(extractCallId({ toolCall: { call_id: 'tci1' } }), 'tci1');
    });

    test('toolCall.id fallback', () => {
        assert.equal(extractCallId({ toolCall: { id: 'tid1' } }), 'tid1');
    });

    test('no id anywhere → fallback generated', () => {
        const result = extractCallId({});
        assert.ok(result.startsWith('fallback-'));
    });

    test('priority: direct > execution > toolCall', () => {
        assert.equal(extractCallId({
            callId: 'direct',
            execution: { callId: 'exec' },
            toolCall: { callId: 'tc' },
        }), 'direct');
    });

    test('priority: execution > toolCall when no direct', () => {
        assert.equal(extractCallId({
            execution: { callId: 'exec' },
            toolCall: { callId: 'tc' },
        }), 'exec');
    });
});

// ────────────────────────────────────────────
// extractFunctionName — event field alias resolution
// ────────────────────────────────────────────

describe('extractFunctionName', () => {
    test('direct functionName → used', () => {
        assert.equal(extractFunctionName({ functionName: 'read_file' }), 'read_file');
    });

    test('toolName fallback', () => {
        assert.equal(extractFunctionName({ toolName: 'write_file' }), 'write_file');
    });

    test('name fallback', () => {
        assert.equal(extractFunctionName({ name: 'echo' }), 'echo');
    });

    test('execution.functionName fallback', () => {
        assert.equal(extractFunctionName({ execution: { functionName: 'git_diff' } }), 'git_diff');
    });

    test('execution.toolName fallback', () => {
        assert.equal(extractFunctionName({ execution: { toolName: 'git_log' } }), 'git_log');
    });

    test('toolCall.name fallback', () => {
        assert.equal(extractFunctionName({ toolCall: { name: 'git_show' } }), 'git_show');
    });

    test('no name anywhere → unknown_tool', () => {
        assert.equal(extractFunctionName({}), 'unknown_tool');
    });

    test('priority: direct > execution > toolCall', () => {
        assert.equal(extractFunctionName({
            functionName: 'direct_fn',
            execution: { functionName: 'exec_fn' },
            toolCall: { name: 'tc_fn' },
        }), 'direct_fn');
    });
});

// ────────────────────────────────────────────
// extractResult — result resolution
// ────────────────────────────────────────────

describe('extractResult', () => {
    test('direct result → used', () => {
        assert.equal(extractResult({ result: 'hello' }), 'hello');
    });

    test('execution.result fallback', () => {
        assert.equal(extractResult({ execution: { result: 'from exec' } }), 'from exec');
    });

    test('direct result takes priority over execution.result', () => {
        assert.equal(extractResult({
            result: 'direct',
            execution: { result: 'nested' },
        }), 'direct');
    });

    test('empty string result is valid (not null)', () => {
        assert.equal(extractResult({ result: '' }), '');
    });

    test('no result anywhere → undefined', () => {
        assert.equal(extractResult({}), undefined);
    });

    test('null result → falls through to execution', () => {
        assert.equal(extractResult({ result: null, execution: { result: 'fallback' } }), 'fallback');
    });
});

// ────────────────────────────────────────────
// extractRenderData with nested event payloads
// ────────────────────────────────────────────

describe('extractRenderData with event aliases', () => {
    test('toolName alias → functionName field populated', () => {
        const data = extractRenderData({
            result: 'ok',
            callId: 'c1',
            toolName: 'web_search',
        });
        assert.ok(data);
        assert.equal(data.functionName, 'web_search');
    });

    test('name alias → functionName field populated', () => {
        const data = extractRenderData({
            result: 'ok',
            callId: 'c1',
            name: 'echo',
        });
        assert.ok(data);
        assert.equal(data.functionName, 'echo');
    });

    test('nested execution.result used when direct result absent', () => {
        const data = extractRenderData({
            callId: 'c1',
            functionName: 'test',
            execution: { result: 'nested result' },
        });
        assert.ok(data);
        assert.equal(data.status, 'success');
        assert.ok(data.resultPreview.includes('nested result'));
    });

    test('nested execution identity used when direct absent', () => {
        const data = extractRenderData({
            result: 'ok',
            execution: { callId: 'ex-call', functionName: 'ex-fn' },
        });
        assert.ok(data);
        assert.equal(data.callId, 'ex-call');
        assert.equal(data.functionName, 'ex-fn');
    });

    test('toolCall identity used when direct and execution absent', () => {
        const data = extractRenderData({
            result: 'ok',
            toolCall: { call_id: 'tc-id', name: 'tc-fn' },
        });
        assert.ok(data);
        assert.equal(data.callId, 'tc-id');
        assert.equal(data.functionName, 'tc-fn');
    });

    test('object result is stringified', () => {
        const data = extractRenderData({
            result: { content: [{ type: 'text', text: 'hello' }] },
            callId: 'c1',
            functionName: 'test',
        });
        assert.ok(data);
        assert.equal(data.status, 'success');
        assert.ok(data.resultPreview.includes('hello'));
    });
});
