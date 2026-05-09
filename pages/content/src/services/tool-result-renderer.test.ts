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
    extractRenderData,
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

    test('confirmationText used as preview when no result', () => {
        const data = extractRenderData({
            callId: 'call-confirm',
            functionName: 'file_tool',
            confirmationText: 'File attached successfully',
        });
        assert.ok(data);
        assert.equal(data.resultPreview, 'File attached successfully');
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
