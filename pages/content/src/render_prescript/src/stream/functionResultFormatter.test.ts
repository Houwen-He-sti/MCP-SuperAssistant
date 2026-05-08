/**
 * Unit tests for functionResultFormatter.ts (P0-2, Gate 4)
 *
 * Tests the function_result formatting logic.
 * Gate 4: Updated to protocol spec format with CDATA wrapper + status='success'.
 *
 * Run: node --test --experimental-strip-types functionResultFormatter.test.ts
 * (from render_prescript/src/stream/ directory)
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { formatFunctionResult } from './functionResultFormatter.ts';

describe('functionResultFormatter', () => {

  test('1. success with object result → protocol format with CDATA', () => {
    const output = formatFunctionResult({
      callId: 'call_abc123',
      name: 'echo',
      status: 'success',
      result: { message: 'hello' },
    });
    assert.ok(output.startsWith('<function_results>'));
    assert.ok(output.endsWith('</function_results>'));
    assert.ok(output.includes('call_id="call_abc123"'));
    assert.ok(output.includes('name="echo"'));
    assert.ok(output.includes('status="success"'));
    assert.ok(output.includes('<![CDATA['));
    assert.ok(output.includes('{"message":"hello"}'));
  });

  test('2. success with string result → CDATA with raw string', () => {
    const output = formatFunctionResult({
      callId: 'c1',
      name: 'web_search',
      status: 'success',
      result: 'Search results here',
    });
    assert.ok(output.includes('<content type="application/json"><![CDATA['));
    assert.ok(output.includes('Search results here'));
    assert.ok(output.includes(']]></content>'));
  });

  test('3. error status → error element with CDATA', () => {
    const output = formatFunctionResult({
      callId: 'c2',
      name: 'file_read',
      status: 'error',
      result: { error: 'File not found' },
    });
    assert.ok(output.includes('status="error"'));
    assert.ok(output.includes('<error type="ToolExecutionError"><![CDATA['));
    assert.ok(output.includes('{"error":"File not found"}'));
    assert.ok(output.includes(']]></error>'));
    // Should NOT have <content> for error
    assert.ok(!output.includes('<content'));
  });

  test('4. result is null → JSON "null" in CDATA', () => {
    const output = formatFunctionResult({
      callId: 'c3',
      name: 'void_tool',
      status: 'success',
      result: null,
    });
    assert.ok(output.includes('null'));
    assert.ok(output.includes('status="success"'));
  });

  test('5. result is number → JSON number in CDATA', () => {
    const output = formatFunctionResult({
      callId: 'c4',
      name: 'calc',
      status: 'success',
      result: 42,
    });
    assert.ok(output.includes('42'));
  });

  test('6. callId with special chars → attributes properly escaped', () => {
    const output = formatFunctionResult({
      callId: 'call"with<special>&chars',
      name: 'tool"name',
      status: 'success',
      result: 'ok',
    });
    assert.ok(output.includes('call_id="call&quot;with&lt;special&gt;&amp;chars"'));
    assert.ok(output.includes('name="tool&quot;name"'));
  });

  test('7. result string containing ]]> → CDATA properly escaped', () => {
    const output = formatFunctionResult({
      callId: 'c5',
      name: 'echo',
      status: 'success',
      result: 'payload]]>injected',
    });
    // The ]]> in content should be split for valid CDATA
    assert.ok(!output.includes('payload]]>injected'));
    // Verify overall structure is valid
    assert.ok(output.startsWith('<function_results>'));
    assert.ok(output.endsWith('</function_results>'));
  });

  test('8. large result → truncated with marker', () => {
    const largeResult = 'A'.repeat(100_000);
    const output = formatFunctionResult({
      callId: 'c6',
      name: 'big_tool',
      status: 'success',
      result: largeResult,
    });
    assert.ok(output.length < 100_000);
    assert.ok(output.includes('[truncated]'));
    assert.ok(output.startsWith('<function_results>'));
    assert.ok(output.endsWith('</function_results>'));
  });

  test('9. empty string result → CDATA with empty body', () => {
    const output = formatFunctionResult({
      callId: 'c7',
      name: 'empty',
      status: 'success',
      result: '',
    });
    assert.ok(output.includes('<![CDATA['));
    assert.ok(output.includes('status="success"'));
  });

  test('10. nested object result → properly serialized JSON in CDATA', () => {
    const output = formatFunctionResult({
      callId: 'c8',
      name: 'deep',
      status: 'success',
      result: { a: { b: { c: [1, 2, 3] } } },
    });
    assert.ok(output.includes('{"a":{"b":{"c":[1,2,3]}}}'));
    assert.ok(output.includes('<![CDATA['));
  });

});
