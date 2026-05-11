/**
 * Unit tests for functionResultParser.ts (Gate 6)
 *
 * Tests the function_result parsing logic for:
 *   - Legacy singular format
 *   - Canonical batch format (Gate 4)
 *   - Merged multi-block payloads (Phase 4)
 *   - CDATA extraction
 *   - Error results
 *   - Trailing text (ack instruction)
 *
 * Run: node --test --experimental-strip-types functionResultParser.test.ts
 * (from render_prescript/src/renderer/ directory)
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { containsFunctionResult, parseFunctionResults } from './functionResultParser.ts';

// --- Test fixtures ---

/** Legacy singular format (pre-Gate 4) */
const LEGACY_SINGLE = `<function_result call_id="call_001">{"message":"hello"}</function_result>`;

/** Canonical single result (Gate 4 format) */
const CANONICAL_SINGLE = `<function_results>
  <result call_id="call_abc123" name="echo" status="success">
    <content type="application/json"><![CDATA[
{"message":"hello"}
    ]]></content>
  </result>
</function_results>`;

/** Canonical error result */
const CANONICAL_ERROR = `<function_results>
  <result call_id="call_err001" name="file_read" status="error">
    <error type="ToolExecutionError"><![CDATA[
File not found: /nonexistent.txt
    ]]></error>
  </result>
</function_results>`;

/** Merged payload: two separate <function_results> blocks (Phase 4 batch merge) */
const MERGED_TWO_BLOCKS = `Tool execution results (2 calls):

<function_results>
  <result call_id="call_001" name="read_file" status="success">
    <content type="application/json"><![CDATA[
{"file":"test.txt","content":"Hello World"}
    ]]></content>
  </result>
</function_results>

<function_results>
  <result call_id="call_002" name="list_dir" status="success">
    <content type="application/json"><![CDATA[
{"entries":["a.ts","b.ts"]}
    ]]></content>
  </result>
</function_results>`;

/** Multiple results in a single <function_results> block (hypothetical future batch) */
const MULTI_RESULT_SINGLE_BLOCK = `<function_results>
  <result call_id="call_a" name="tool_a" status="success">
    <content type="application/json"><![CDATA[
{"a":1}
    ]]></content>
  </result>
  <result call_id="call_b" name="tool_b" status="error">
    <error type="ToolExecutionError"><![CDATA[
Something went wrong
    ]]></error>
  </result>
</function_results>`;

/** Canonical result with ACK instruction trailing */
const WITH_ACK_INSTRUCTION = `<function_results>
  <result call_id="call_ack001" name="echo" status="success">
    <content type="application/json"><![CDATA[
{"ok":true}
    ]]></content>
  </result>
</function_results>
<result_nonce>abc123</result_nonce>
<instruction>In your next response, include verbatim: <mcp_ack nonce="abc123" /></instruction>`;

/** Mixed success and error in merged payload */
const MIXED_STATUS_MERGED = `Tool execution results (2 calls):

<function_results>
  <result call_id="call_ok" name="echo" status="success">
    <content type="application/json"><![CDATA[
{"msg":"ok"}
    ]]></content>
  </result>
</function_results>

<function_results>
  <result call_id="call_fail" name="crash_tool" status="error">
    <error type="ToolExecutionError"><![CDATA[
Timeout after 30s
    ]]></error>
  </result>
</function_results>`;

/** Content with special characters in CDATA */
const CDATA_WITH_CODE = `<function_results>
  <result call_id="call_code" name="read_file" status="success">
    <content type="application/json"><![CDATA[
{"code":"function hello() { return '<div>' + x; }"}
    ]]></content>
  </result>
</function_results>`;

/** Plain text — no function results */
const NO_RESULTS = `This is just a regular user message with no function results.`;

/** P1-1: Mixed canonical + legacy in same message */
const MIXED_CANONICAL_LEGACY = `<function_results>
  <result call_id="call_new" name="echo" status="success">
    <content type="application/json"><![CDATA[
{"new":"format"}
    ]]></content>
  </result>
</function_results>

<function_result call_id="call_old">{"old":"format"}</function_result>`;

/** P1-2: Attribute order variation (status before name before call_id) */
const ATTR_ORDER_VARIATION = `<function_results>
  <result status="success" name="read_file" call_id="call_reorder">
    <content type="application/json"><![CDATA[
{"reordered":true}
    ]]></content>
  </result>
</function_results>`;

/** P1-3: Root tag with attributes */
const ROOT_WITH_ATTRS = `<function_results batch_id="b1">
  <result call_id="call_batch" name="tool_x" status="success">
    <content type="application/json"><![CDATA[
{"batch":true}
    ]]></content>
  </result>
</function_results>`;

/** P2-1: Content without CDATA */
const CONTENT_NO_CDATA = `<function_results>
  <result call_id="call_plain" name="echo" status="success">
    <content type="text/plain">hello world</content>
  </result>
</function_results>`;

/** P2-2: Content tag without type attribute */
const CONTENT_NO_TYPE = `<function_results>
  <result call_id="call_notype" name="echo" status="success">
    <content>plain content here</content>
  </result>
</function_results>`;

/** P1-extra: Legacy bare tag without attributes */
const LEGACY_BARE = `<function_result>bare content no attrs</function_result>`;

/** Regression: bare <result> in canonical block (no attributes) */
const CANONICAL_BARE_RESULT = `<function_results>
  <result>bare canonical content</result>
</function_results>`;

/** Negative: <resultXyz> should NOT be parsed as <result> */
const RESULT_PREFIX_COLLISION = `<function_results>
  <resultXyz>should not match</resultXyz>
</function_results>`;

/** Negative: <result-card> should NOT be parsed as <result> */
const RESULT_HYPHEN_COLLISION = `<function_results>
  <result-card>should not match</result-card>
</function_results>`;

// --- Tests ---

describe('containsFunctionResult', () => {
    test('detects canonical format', () => {
        assert.ok(containsFunctionResult(CANONICAL_SINGLE));
    });

    test('detects legacy format', () => {
        assert.ok(containsFunctionResult(LEGACY_SINGLE));
    });

    test('rejects plain text', () => {
        assert.ok(!containsFunctionResult(NO_RESULTS));
    });

    test('detects merged payload', () => {
        assert.ok(containsFunctionResult(MERGED_TWO_BLOCKS));
    });
});

describe('parseFunctionResults — canonical single', () => {
    test('parses one canonical result', () => {
        const parsed = parseFunctionResults(CANONICAL_SINGLE);
        assert.ok(parsed !== null);
        assert.equal(parsed.results.length, 1);
        const r = parsed.results[0];
        assert.equal(r.callId, 'call_abc123');
        assert.equal(r.name, 'echo');
        assert.equal(r.status, 'success');
        assert.equal(r.contentType, 'application/json');
        assert.ok(r.content.includes('"message":"hello"'));
    });
});

describe('parseFunctionResults — canonical error', () => {
    test('parses error result with error element', () => {
        const parsed = parseFunctionResults(CANONICAL_ERROR);
        assert.ok(parsed !== null);
        assert.equal(parsed.results.length, 1);
        const r = parsed.results[0];
        assert.equal(r.callId, 'call_err001');
        assert.equal(r.name, 'file_read');
        assert.equal(r.status, 'error');
        assert.equal(r.contentType, 'ToolExecutionError');
        assert.ok(r.content.includes('File not found'));
    });
});

describe('parseFunctionResults — merged two blocks', () => {
    test('parses both blocks from merged payload', () => {
        const parsed = parseFunctionResults(MERGED_TWO_BLOCKS);
        assert.ok(parsed !== null);
        assert.equal(parsed.results.length, 2, 'should find 2 results from 2 blocks');

        assert.equal(parsed.results[0].callId, 'call_001');
        assert.equal(parsed.results[0].name, 'read_file');
        assert.ok(parsed.results[0].content.includes('Hello World'));

        assert.equal(parsed.results[1].callId, 'call_002');
        assert.equal(parsed.results[1].name, 'list_dir');
        assert.ok(parsed.results[1].content.includes('entries'));
    });
});

describe('parseFunctionResults — multi-result single block', () => {
    test('parses multiple results within one block', () => {
        const parsed = parseFunctionResults(MULTI_RESULT_SINGLE_BLOCK);
        assert.ok(parsed !== null);
        assert.equal(parsed.results.length, 2);

        assert.equal(parsed.results[0].callId, 'call_a');
        assert.equal(parsed.results[0].status, 'success');

        assert.equal(parsed.results[1].callId, 'call_b');
        assert.equal(parsed.results[1].status, 'error');
        assert.ok(parsed.results[1].content.includes('Something went wrong'));
    });
});

describe('parseFunctionResults — legacy format', () => {
    test('parses legacy singular format', () => {
        const parsed = parseFunctionResults(LEGACY_SINGLE);
        assert.ok(parsed !== null);
        assert.equal(parsed.results.length, 1);
        assert.equal(parsed.results[0].callId, 'call_001');
        assert.ok(parsed.results[0].content.includes('"message":"hello"'));
    });
});

describe('parseFunctionResults — trailing ACK instruction', () => {
    test('extracts result and trailing text', () => {
        const parsed = parseFunctionResults(WITH_ACK_INSTRUCTION);
        assert.ok(parsed !== null);
        assert.equal(parsed.results.length, 1);
        assert.equal(parsed.results[0].callId, 'call_ack001');
        assert.ok(parsed.trailing.includes('result_nonce'));
        assert.ok(parsed.trailing.includes('abc123'));
    });
});

describe('parseFunctionResults — mixed success/error merged', () => {
    test('parses mixed status results', () => {
        const parsed = parseFunctionResults(MIXED_STATUS_MERGED);
        assert.ok(parsed !== null);
        assert.equal(parsed.results.length, 2);

        assert.equal(parsed.results[0].status, 'success');
        assert.equal(parsed.results[0].callId, 'call_ok');

        assert.equal(parsed.results[1].status, 'error');
        assert.equal(parsed.results[1].callId, 'call_fail');
        assert.ok(parsed.results[1].content.includes('Timeout'));
    });
});

describe('parseFunctionResults — CDATA with code', () => {
    test('extracts content with angle brackets and special chars', () => {
        const parsed = parseFunctionResults(CDATA_WITH_CODE);
        assert.ok(parsed !== null);
        assert.equal(parsed.results.length, 1);
        assert.ok(parsed.results[0].content.includes("'<div>'"));
    });
});

describe('parseFunctionResults — no results', () => {
    test('returns null for plain text', () => {
        const parsed = parseFunctionResults(NO_RESULTS);
        assert.equal(parsed, null);
    });

    test('returns null for empty string', () => {
        const parsed = parseFunctionResults('');
        assert.equal(parsed, null);
    });
});

// --- P1 tests (GPT review feedback) ---

describe('parseFunctionResults — P1-1: mixed canonical + legacy', () => {
    test('parses both canonical and legacy results from same message', () => {
        const parsed = parseFunctionResults(MIXED_CANONICAL_LEGACY);
        assert.ok(parsed !== null);
        assert.equal(parsed.results.length, 2, 'should find 2 results (1 canonical + 1 legacy)');

        assert.equal(parsed.results[0].callId, 'call_new');
        assert.equal(parsed.results[0].name, 'echo');
        assert.ok(parsed.results[0].content.includes('"new":"format"'));

        assert.equal(parsed.results[1].callId, 'call_old');
        assert.ok(parsed.results[1].content.includes('"old":"format"'));
    });
});

describe('parseFunctionResults — P1-2: attribute order variation', () => {
    test('parses correctly regardless of attribute order', () => {
        const parsed = parseFunctionResults(ATTR_ORDER_VARIATION);
        assert.ok(parsed !== null);
        assert.equal(parsed.results.length, 1);
        assert.equal(parsed.results[0].callId, 'call_reorder');
        assert.equal(parsed.results[0].name, 'read_file');
        assert.equal(parsed.results[0].status, 'success');
        assert.ok(parsed.results[0].content.includes('"reordered":true'));
    });
});

describe('parseFunctionResults — P1-3: root with attributes', () => {
    test('parses when root tag has attributes', () => {
        const parsed = parseFunctionResults(ROOT_WITH_ATTRS);
        assert.ok(parsed !== null);
        assert.equal(parsed.results.length, 1);
        assert.equal(parsed.results[0].callId, 'call_batch');
        assert.equal(parsed.results[0].name, 'tool_x');
    });
});

// --- P2 tests ---

describe('parseFunctionResults — P2-1: content without CDATA', () => {
    test('parses plain content without CDATA wrapper', () => {
        const parsed = parseFunctionResults(CONTENT_NO_CDATA);
        assert.ok(parsed !== null);
        assert.equal(parsed.results.length, 1);
        assert.equal(parsed.results[0].content, 'hello world');
        assert.equal(parsed.results[0].contentType, 'text/plain');
    });
});

describe('parseFunctionResults — P2-2: content without type attribute', () => {
    test('parses content tag without type', () => {
        const parsed = parseFunctionResults(CONTENT_NO_TYPE);
        assert.ok(parsed !== null);
        assert.equal(parsed.results.length, 1);
        assert.equal(parsed.results[0].content, 'plain content here');
        assert.equal(parsed.results[0].contentType, '');
    });
});

describe('parseFunctionResults — legacy bare tag', () => {
    test('parses legacy tag without attributes', () => {
        const parsed = parseFunctionResults(LEGACY_BARE);
        assert.ok(parsed !== null);
        assert.equal(parsed.results.length, 1);
        assert.equal(parsed.results[0].content, 'bare content no attrs');
        assert.equal(parsed.results[0].callId, '');
    });
});

// --- Regression tests (GPT review: tag boundary strictness) ---

describe('parseFunctionResults — canonical bare <result> tag', () => {
    test('matches bare <result> but content requires <content> child', () => {
        const parsed = parseFunctionResults(CANONICAL_BARE_RESULT);
        assert.ok(parsed !== null, 'bare <result> should be matched by regex');
        assert.equal(parsed.results.length, 1);
        // parseResultElement requires <content> or <error> child to extract content.
        // Bare text inside <result> is not extracted — this is by design.
        assert.equal(parsed.results[0].content, '');
        assert.equal(parsed.results[0].callId, '');
    });
});

describe('parseFunctionResults — rejects <resultXyz> prefix collision', () => {
    test('does not parse <resultXyz> as <result>', () => {
        const parsed = parseFunctionResults(RESULT_PREFIX_COLLISION);
        assert.equal(parsed, null, '<resultXyz> should not match <result> regex');
    });
});

describe('parseFunctionResults — rejects <result-card> hyphen collision', () => {
    test('does not parse <result-card> as <result>', () => {
        const parsed = parseFunctionResults(RESULT_HYPHEN_COLLISION);
        assert.equal(parsed, null, '<result-card> should not match <result> regex');
    });
});
