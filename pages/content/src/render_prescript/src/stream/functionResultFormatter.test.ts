/**
 * Unit tests for functionResultFormatter.ts (P0-2)
 *
 * Tests the function_result formatting logic extracted from streamToolBridge.ts.
 *
 * Run: node --test --experimental-strip-types functionResultFormatter.test.ts
 * (from render_prescript/src/stream/ directory)
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { formatFunctionResult } from './functionResultFormatter.ts';

describe('functionResultFormatter', () => {

  test('1. success with object result → XML with JSON body', () => {
    const output = formatFunctionResult({
      callId: 'call_abc123',
      name: 'echo',
      status: 'ok',
      result: { message: 'hello' },
    });
    assert.strictEqual(output,
      '<function_result call_id="call_abc123" name="echo" status="ok">\n{"message":"hello"}\n</function_result>'
    );
  });

  test('2. success with string result → XML with raw string body', () => {
    const output = formatFunctionResult({
      callId: 'c1',
      name: 'web_search',
      status: 'ok',
      result: 'Search results here',
    });
    assert.strictEqual(output,
      '<function_result call_id="c1" name="web_search" status="ok">\nSearch results here\n</function_result>'
    );
  });

  test('3. error status → XML with status="error"', () => {
    const output = formatFunctionResult({
      callId: 'c2',
      name: 'file_read',
      status: 'error',
      result: { error: 'File not found' },
    });
    assert.strictEqual(output,
      '<function_result call_id="c2" name="file_read" status="error">\n{"error":"File not found"}\n</function_result>'
    );
  });

  test('4. result is null → JSON "null" in body', () => {
    const output = formatFunctionResult({
      callId: 'c3',
      name: 'void_tool',
      status: 'ok',
      result: null,
    });
    assert.strictEqual(output,
      '<function_result call_id="c3" name="void_tool" status="ok">\nnull\n</function_result>'
    );
  });

  test('5. result is number → JSON number in body', () => {
    const output = formatFunctionResult({
      callId: 'c4',
      name: 'calc',
      status: 'ok',
      result: 42,
    });
    assert.strictEqual(output,
      '<function_result call_id="c4" name="calc" status="ok">\n42\n</function_result>'
    );
  });

  test('6. callId with special chars → attributes properly escaped', () => {
    const output = formatFunctionResult({
      callId: 'call"with<special>&chars',
      name: 'tool"name',
      status: 'ok',
      result: 'ok',
    });
    // Attributes should be XML-safe
    assert.ok(output.includes('call_id="call&quot;with&lt;special&gt;&amp;chars"'));
    assert.ok(output.includes('name="tool&quot;name"'));
  });

  test('7. result string containing </function_result> → escaped to prevent tag injection', () => {
    const output = formatFunctionResult({
      callId: 'c5',
      name: 'echo',
      status: 'ok',
      result: 'payload</function_result><injected>',
    });
    // The closing tag in content should not prematurely close the XML
    assert.ok(!output.includes('</function_result><injected>'));
    // Content should be escaped
    assert.ok(output.includes('&lt;/function_result&gt;'));
  });

  test('8. large result → truncated with marker', () => {
    const largeResult = 'A'.repeat(100_000);
    const output = formatFunctionResult({
      callId: 'c6',
      name: 'big_tool',
      status: 'ok',
      result: largeResult,
    });
    // Should be truncated
    assert.ok(output.length < 100_000);
    assert.ok(output.includes('[truncated]'));
    // Should still have proper XML structure
    assert.ok(output.startsWith('<function_result'));
    assert.ok(output.endsWith('</function_result>'));
  });

  test('9. empty string result → XML with empty body', () => {
    const output = formatFunctionResult({
      callId: 'c7',
      name: 'empty',
      status: 'ok',
      result: '',
    });
    assert.strictEqual(output,
      '<function_result call_id="c7" name="empty" status="ok">\n\n</function_result>'
    );
  });

  test('10. nested object result → properly serialized JSON', () => {
    const output = formatFunctionResult({
      callId: 'c8',
      name: 'deep',
      status: 'ok',
      result: { a: { b: { c: [1, 2, 3] } } },
    });
    assert.strictEqual(output,
      '<function_result call_id="c8" name="deep" status="ok">\n{"a":{"b":{"c":[1,2,3]}}}\n</function_result>'
    );
  });

});
