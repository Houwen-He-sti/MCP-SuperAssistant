/**
 * Unit tests for functionCallScanner.ts — Notion patch format parsing
 *
 * Tests the cross-patch accumulator scanner, patch text extraction,
 * and JSONL block identity extraction.
 *
 * These tests import production code directly (no shadow implementation).
 *
 * Run: node --test --experimental-strip-types functionCallScanner.test.ts
 * (from render_prescript/src/stream/ directory)
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
    createFunctionCallScanner,
    detectFunctionCall,
    extractFunctionCallIdentity,
    extractIdentityFromJsonlBlock,
    extractPatchTextContent,
    MAX_PATCH_BUFFER_SIZE,
} from './functionCallScanner.ts';

// ============================================================================
// Real Notion NDJSON fixture data (captured from live stream)
// ============================================================================

// These are actual NDJSON lines from a Notion AI stream captured via CDP
const NOTION_PATCH_LINE_12 = '{"type":"patch","v":[{"o":"x","p":"/s/11/value/0/content","v":" 文件。\\n\\n```jsonl\\n{\\"type\\":\\"function_call_start\\",\\"name\\":\\"read_workspace_file\\",\\"call_id\\":\\"1762"}]}';
const NOTION_PATCH_LINE_13 = '{"type":"patch","v":[{"o":"x","p":"/s/11/value/0/content","v":"560000-1\\"}\\n{\\"type\\":\\"description\\",\\"text\\":\\"读取工作区的 README 文件内"}]}';
const NOTION_PATCH_LINE_14 = '{"type":"patch","v":[{"o":"x","p":"/s/11/value/0/content","v":"容\\"}\\n{\\"type\\":\\"parameter\\",\\"key\\":\\"path\\",\\"value\\":\\"README.md\\"}\\n{\\"type\\":\\"function_call_end\\",\\"call_id\\":\\"1762560000-1\\"}\\n```\\n\\n已"}]}';

// Non-function-call patch lines
const NOTION_PATCH_TITLE = '{"type":"patch","v":[{"o":"a","p":"/s/-","v":{"id":"359cae42","type":"title","value":"查看README文件"}}]}';
const NOTION_PATCH_TOKENS = '{"type":"patch","v":[{"o":"a","p":"/s/11/finishedAt","v":1778166468534},{"o":"a","p":"/s/11/model","v":"apricot-sorbet-high"}]}';

// Standard format lines (non-Notion)
const STANDARD_FUNCTION_CALL = '{"type":"function_call","name":"get_tools","id":"call_123","arguments":"{}"}';
const STANDARD_TOOL_CALLS = '{"tool_calls":[{"id":"call_456","function":{"name":"search","arguments":"{\\"q\\":\\"test\\"}"}}]}';

// ============================================================================
// Tests
// ============================================================================

describe('extractPatchTextContent', () => {
    test('extracts text from o:x content patch', () => {
        const text = extractPatchTextContent(NOTION_PATCH_LINE_12);
        assert.ok(text !== null);
        assert.ok(text.includes('function_call_start'));
        assert.ok(text.includes('read_workspace_file'));
    });

    test('returns null for non-patch JSON', () => {
        assert.equal(extractPatchTextContent(STANDARD_FUNCTION_CALL), null);
    });

    test('returns null for o:a (append) operations', () => {
        assert.equal(extractPatchTextContent(NOTION_PATCH_TITLE), null);
    });

    test('returns null for non-content paths', () => {
        assert.equal(extractPatchTextContent(NOTION_PATCH_TOKENS), null);
    });

    test('returns null for invalid JSON', () => {
        assert.equal(extractPatchTextContent('not json at all'), null);
    });

    test('concatenates multiple o:x content ops in same patch', () => {
        const multiOp = JSON.stringify({
            type: 'patch',
            v: [
                { o: 'x', p: '/s/5/value/0/content', v: 'hello ' },
                { o: 'x', p: '/s/5/value/0/content', v: 'world' },
            ],
        });
        assert.equal(extractPatchTextContent(multiOp), 'hello world');
    });
});

describe('extractIdentityFromJsonlBlock', () => {
    test('extracts identity from complete JSONL block', () => {
        const block = [
            '{"type":"function_call_start","name":"read_workspace_file","call_id":"1762560000-1"}',
            '{"type":"description","text":"读取 README"}',
            '{"type":"parameter","key":"path","value":"README.md"}',
            '{"type":"function_call_end","call_id":"1762560000-1"}',
        ].join('\n');

        const identity = extractIdentityFromJsonlBlock(block);
        assert.ok(identity !== null);
        assert.equal(identity!.name, 'read_workspace_file');
        assert.equal(identity!.callId, '1762560000-1');
        assert.equal(identity!.arguments, JSON.stringify({ path: 'README.md' }));
    });

    test('extracts identity with multiple parameters', () => {
        const block = [
            '{"type":"function_call_start","name":"search","call_id":"abc"}',
            '{"type":"parameter","key":"query","value":"hello"}',
            '{"type":"parameter","key":"limit","value":"10"}',
            '{"type":"function_call_end","call_id":"abc"}',
        ].join('\n');

        const identity = extractIdentityFromJsonlBlock(block);
        assert.ok(identity !== null);
        assert.equal(identity!.name, 'search');
        assert.deepEqual(JSON.parse(identity!.arguments!), { query: 'hello', limit: '10' });
    });

    test('returns null when no function_call_start found', () => {
        const block = 'just some text\nno function calls here';
        assert.equal(extractIdentityFromJsonlBlock(block), null);
    });

    test('returns identity even without parameters', () => {
        const block = '{"type":"function_call_start","name":"list_tools","call_id":"x"}';
        const identity = extractIdentityFromJsonlBlock(block);
        assert.ok(identity !== null);
        assert.equal(identity!.name, 'list_tools');
        assert.equal(identity!.arguments, null);
    });

    test('handles surrounding markdown noise', () => {
        const block = '```jsonl\n{"type":"function_call_start","name":"test","call_id":"1"}\n{"type":"function_call_end","call_id":"1"}\n```\n\n已';
        const identity = extractIdentityFromJsonlBlock(block);
        assert.ok(identity !== null);
        assert.equal(identity!.name, 'test');
    });
});

describe('createFunctionCallScanner — standard formats', () => {
    test('detects standard function_call format', () => {
        const scanner = createFunctionCallScanner();
        const result = scanner.processLine(STANDARD_FUNCTION_CALL);
        assert.equal(result.detected, true);
        assert.equal(result.accumulating, false);
        assert.ok(result.identity !== null);
        assert.equal(result.identity!.name, 'get_tools');
        assert.equal(result.identity!.callId, 'call_123');
    });

    test('detects tool_calls format', () => {
        const scanner = createFunctionCallScanner();
        const result = scanner.processLine(STANDARD_TOOL_CALLS);
        assert.equal(result.detected, true);
        assert.ok(result.identity !== null);
        assert.equal(result.identity!.name, 'search');
        assert.equal(result.identity!.callId, 'call_456');
    });

    test('ignores non-function-call lines', () => {
        const scanner = createFunctionCallScanner();
        const result = scanner.processLine('{"type":"text","content":"hello world"}');
        assert.equal(result.detected, false);
        assert.equal(result.accumulating, false);
    });
});

describe('createFunctionCallScanner — Notion patch format (cross-patch)', () => {
    test('accumulates across 3 patch lines and extracts identity', () => {
        const scanner = createFunctionCallScanner();

        // Line 12: starts accumulation
        const r1 = scanner.processLine(NOTION_PATCH_LINE_12);
        assert.equal(r1.detected, false, 'should not detect yet (incomplete)');
        assert.equal(r1.accumulating, true, 'should be accumulating');

        // Line 13: continues accumulation
        const r2 = scanner.processLine(NOTION_PATCH_LINE_13);
        assert.equal(r2.detected, false, 'still accumulating');
        assert.equal(r2.accumulating, true);

        // Line 14: completes with function_call_end
        const r3 = scanner.processLine(NOTION_PATCH_LINE_14);
        assert.equal(r3.detected, true, 'should detect now');
        assert.equal(r3.accumulating, false);
        assert.ok(r3.identity !== null, 'identity should be extracted');
        assert.equal(r3.identity!.name, 'read_workspace_file');
        assert.equal(r3.identity!.callId, '1762560000-1');
        assert.ok(r3.identity!.arguments !== null, 'should have arguments');
        assert.deepEqual(JSON.parse(r3.identity!.arguments!), { path: 'README.md' });
    });

    test('rawLine references the first detection line', () => {
        const scanner = createFunctionCallScanner();
        scanner.processLine(NOTION_PATCH_LINE_12);
        scanner.processLine(NOTION_PATCH_LINE_13);
        const r3 = scanner.processLine(NOTION_PATCH_LINE_14);
        assert.equal(r3.rawLine, NOTION_PATCH_LINE_12);
    });

    test('handles single-line complete patch', () => {
        const completePatch = JSON.stringify({
            type: 'patch',
            v: [{
                o: 'x',
                p: '/s/5/value/0/content',
                v: '```jsonl\n{"type":"function_call_start","name":"quick_tool","call_id":"q1"}\n{"type":"function_call_end","call_id":"q1"}\n```',
            }],
        });

        const scanner = createFunctionCallScanner();
        const result = scanner.processLine(completePatch);
        assert.equal(result.detected, true);
        assert.equal(result.accumulating, false);
        assert.ok(result.identity !== null);
        assert.equal(result.identity!.name, 'quick_tool');
        assert.equal(result.identity!.callId, 'q1');
    });

    test('non-patch line during accumulation keeps waiting for end marker', () => {
        const scanner = createFunctionCallScanner();

        // Start accumulating with a patch that has function_call_start with full name
        const startPatch = JSON.stringify({
            type: 'patch',
            v: [{
                o: 'x',
                p: '/s/5/value/0/content',
                v: '{"type":"function_call_start","name":"my_tool","call_id":"c1"}\n',
            }],
        });
        const r1 = scanner.processLine(startPatch);
        assert.equal(r1.accumulating, true);

        // Non-patch line interrupts — should not execute partial data
        const r2 = scanner.processLine('{"type":"some_other_line","name":"irrelevant"}');
        assert.equal(r2.detected, false, 'should not detect without function_call_end');
        assert.equal(r2.accumulating, true, 'should keep waiting for content patches');
    });

    test('scanner resets after detection', () => {
        const scanner = createFunctionCallScanner();

        // First detection
        scanner.processLine(NOTION_PATCH_LINE_12);
        scanner.processLine(NOTION_PATCH_LINE_13);
        scanner.processLine(NOTION_PATCH_LINE_14);

        // Second detection should work independently
        const r = scanner.processLine(STANDARD_FUNCTION_CALL);
        assert.equal(r.detected, true);
        assert.equal(r.identity!.name, 'get_tools');
    });

    test('title/metadata patches do not trigger accumulation', () => {
        const scanner = createFunctionCallScanner();
        const r = scanner.processLine(NOTION_PATCH_TITLE);
        assert.equal(r.detected, false);
        assert.equal(r.accumulating, false);
    });

    test('token/metric patches do not trigger accumulation', () => {
        const scanner = createFunctionCallScanner();
        const r = scanner.processLine(NOTION_PATCH_TOKENS);
        assert.equal(r.detected, false);
        assert.equal(r.accumulating, false);
    });

    test('multi-turn: detects second standard function_call after first (same format)', () => {
        const scanner = createFunctionCallScanner();
        const callA = '{"type":"function_call","name":"echo","id":"call_A","arguments":"{\\"msg\\":\\"hello\\"}"}';
        const callB = '{"type":"function_call","name":"add","id":"call_B","arguments":"{\\"x\\":1,\\"y\\":2}"}';

        const rA = scanner.processLine(callA);
        assert.equal(rA.detected, true, 'should detect first function_call');
        assert.equal(rA.identity!.name, 'echo');
        assert.equal(rA.identity!.callId, 'call_A');

        // Simulate intermediate non-function_call lines (AI text response)
        const rText = scanner.processLine('{"type":"text","content":"Here is the result..."}');
        assert.equal(rText.detected, false);

        const rB = scanner.processLine(callB);
        assert.equal(rB.detected, true, 'should detect second function_call after reset');
        assert.equal(rB.identity!.name, 'add');
        assert.equal(rB.identity!.callId, 'call_B');
    });
});

describe('detectFunctionCall — Notion patch lines', () => {
    test('detects function_call in patch content', () => {
        assert.equal(detectFunctionCall(NOTION_PATCH_LINE_12), true);
    });

    test('does not detect non-function-call patches', () => {
        assert.equal(detectFunctionCall(NOTION_PATCH_TITLE), false);
    });

    test('does not detect token patches', () => {
        assert.equal(detectFunctionCall(NOTION_PATCH_TOKENS), false);
    });
});

describe('extractFunctionCallIdentity — legacy formats still work', () => {
    test('type: function_call', () => {
        const identity = extractFunctionCallIdentity('{"type":"function_call","name":"test","id":"1","arguments":"{}"}');
        assert.ok(identity !== null);
        assert.equal(identity!.name, 'test');
    });

    test('function_call object', () => {
        const identity = extractFunctionCallIdentity('{"function_call":{"name":"test","arguments":"{}"},"id":"1"}');
        assert.ok(identity !== null);
        assert.equal(identity!.name, 'test');
    });

    test('tool_calls array', () => {
        const identity = extractFunctionCallIdentity('{"tool_calls":[{"id":"1","function":{"name":"test","arguments":"{}"}}]}');
        assert.ok(identity !== null);
        assert.equal(identity!.name, 'test');
    });

    test('tool_use object', () => {
        const identity = extractFunctionCallIdentity('{"tool_use":{"name":"test","id":"1","input":{"key":"val"}}}');
        assert.ok(identity !== null);
        assert.equal(identity!.name, 'test');
        assert.equal(identity!.arguments, '{"key":"val"}');
    });

    test('returns null for patch format (handled by scanner)', () => {
        const identity = extractFunctionCallIdentity(NOTION_PATCH_LINE_12);
        assert.equal(identity, null);
    });
});

// ============================================================================
// o:'a' (append) regression tests — PR #21 scanner fix
//
// Root cause: extractPatchTextContent only handled o:'x' (extend) operations.
// Notion's agent-inference blocks emit function_call_start via o:'a' (append)
// where content is nested in v.value[].content.
// ============================================================================

// Realistic o:'a' fixture from Notion agent-inference stream
const NOTION_APPEND_FUNCTION_CALL = JSON.stringify({
    type: 'patch',
    v: [{
        o: 'a',
        p: '/s/11/value/-',
        v: {
            value: [
                { content: '```jsonl\n{"type":"function_call_start","name":"echo","call_id":"c1"}\n' },
            ],
        },
    }],
});

const NOTION_APPEND_PARAM_AND_END = JSON.stringify({
    type: 'patch',
    v: [{
        o: 'x',
        p: '/s/11/value/0/content',
        v: '{"type":"parameter","key":"message","value":"hello"}\n{"type":"function_call_end","call_id":"c1"}\n```',
    }],
});

describe('extractPatchTextContent — o:a (append) operations', () => {
    test('extracts content from o:a with v.value[].content', () => {
        const text = extractPatchTextContent(NOTION_APPEND_FUNCTION_CALL);
        assert.ok(text !== null, 'should extract text from o:a');
        assert.ok(text.includes('function_call_start'));
        assert.ok(text.includes('echo'));
    });

    test('returns null for o:a without v.value array (title/metadata)', () => {
        // NOTION_PATCH_TITLE has v = { id, type, value } where value is a string, not array
        assert.equal(extractPatchTextContent(NOTION_PATCH_TITLE), null);
    });

    test('returns null for o:a with v.value[] but no content field', () => {
        const noContent = JSON.stringify({
            type: 'patch',
            v: [{
                o: 'a',
                p: '/s/5/value/-',
                v: { value: [{ id: 'block1', type: 'text' }] },
            }],
        });
        assert.equal(extractPatchTextContent(noContent), null);
    });

    test('returns null for o:a with v.value[].content that is non-string', () => {
        const nonString = JSON.stringify({
            type: 'patch',
            v: [{
                o: 'a',
                p: '/s/5/value/-',
                v: { value: [{ content: 42 }] },
            }],
        });
        assert.equal(extractPatchTextContent(nonString), null);
    });

    test('concatenates content from multiple o:a entries', () => {
        const multi = JSON.stringify({
            type: 'patch',
            v: [{
                o: 'a',
                p: '/s/5/value/-',
                v: {
                    value: [
                        { content: 'part1\n' },
                        { content: 'part2\n' },
                    ],
                },
            }],
        });
        assert.equal(extractPatchTextContent(multi), 'part1\npart2\n');
    });

    test('extracts content when o:a appends a text block directly', () => {
        const directTextAppend = JSON.stringify({
            type: 'patch',
            v: [{
                o: 'a',
                p: '/s/1/value/-',
                v: { type: 'text', content: '```jsonl\n{"type":"function_call_start","name":"get_child_item","call_id":"c_' },
            }],
        });
        assert.equal(
            extractPatchTextContent(directTextAppend),
            '```jsonl\n{"type":"function_call_start","name":"get_child_item","call_id":"c_',
        );
    });
});

describe('createFunctionCallScanner — o:a then o:x cross-patch', () => {
    test('detects function_call starting with o:a and completed by o:x', () => {
        const scanner = createFunctionCallScanner();

        // o:a starts accumulation
        const r1 = scanner.processLine(NOTION_APPEND_FUNCTION_CALL);
        assert.equal(r1.accumulating, true, 'should start accumulating from o:a');
        assert.equal(r1.detected, false);

        // o:x completes with parameter + function_call_end
        const r2 = scanner.processLine(NOTION_APPEND_PARAM_AND_END);
        assert.equal(r2.detected, true, 'should detect after o:x completion');
        assert.equal(r2.accumulating, false);
        assert.ok(r2.identity !== null);
        assert.equal(r2.identity!.name, 'echo');
        assert.equal(r2.identity!.callId, 'c1');
        assert.deepEqual(JSON.parse(r2.identity!.arguments!), { message: 'hello' });
    });

    test('detects direct text append followed by split o:x parameters', () => {
        const scanner = createFunctionCallScanner();
        const start = JSON.stringify({
            type: 'patch',
            v: [{
                o: 'a',
                p: '/s/1/value/-',
                v: { type: 'text', content: '```jsonl\n{"type":"function_call_start","name":"get_child_item","call_id":"c_' },
            }],
        });
        const middle = JSON.stringify({
            type: 'patch',
            v: [{
                o: 'x',
                p: '/s/1/value/1/content',
                v: 'scripts_1"}\n{"type":"parameter","key":"Path","value":"MCP-SuperAssistant/scripts"}\n{"type":"parameter","key":"Dep',
            }],
        });
        const end = JSON.stringify({
            type: 'patch',
            v: [{
                o: 'x',
                p: '/s/1/value/1/content',
                v: 'th","value":1}\n{"type":"function_call_end","call_id":"c_scripts_1"}\n```',
            }],
        });

        const r1 = scanner.processLine(start);
        assert.equal(r1.detected, false);
        assert.equal(r1.accumulating, true);

        const r2 = scanner.processLine(middle);
        assert.equal(r2.detected, false);
        assert.equal(r2.accumulating, true);

        const r3 = scanner.processLine(end);
        assert.equal(r3.detected, true);
        assert.equal(r3.accumulating, false);
        assert.equal(r3.identity!.name, 'get_child_item');
        assert.equal(r3.identity!.callId, 'c_scripts_1');
        assert.deepEqual(JSON.parse(r3.identity!.arguments!), {
            Path: 'MCP-SuperAssistant/scripts',
            Depth: 1,
        });
    });

    test('preserves JSON parameter value types for MCP schema validation', () => {
        const block = [
            '{"type":"function_call_start","name":"get_child_item","call_id":"c_typed"}',
            '{"type":"parameter","key":"Path","value":"MCP-SuperAssistant/scripts"}',
            '{"type":"parameter","key":"Depth","value":1}',
            '{"type":"parameter","key":"includeHidden","value":false}',
            '{"type":"function_call_end","call_id":"c_typed"}',
        ].join('\n');

        const identity = extractIdentityFromJsonlBlock(block);

        assert.ok(identity);
        assert.deepEqual(JSON.parse(identity.arguments!), {
            Path: 'MCP-SuperAssistant/scripts',
            Depth: 1,
            includeHidden: false,
        });
    });

    test('ignores Notion record-map snapshots that contain prior function calls', () => {
        const scanner = createFunctionCallScanner();
        const recordMap = JSON.stringify({
            type: 'record-map',
            recordMap: {
                thread_message: {
                    one: {
                        value: {
                            value: [
                                { type: 'text', content: '{"type":"function_call_start","name":"get_child_item","call_id":"old"}' },
                            ],
                        },
                    },
                },
            },
        });

        const result = scanner.processLine(recordMap);
        assert.equal(result.detected, false);
        assert.equal(result.accumulating, false);
    });

    test('existing o:x behavior is not regressed', () => {
        // Original 3-line o:x cross-patch still works
        const scanner = createFunctionCallScanner();
        scanner.processLine(NOTION_PATCH_LINE_12);
        scanner.processLine(NOTION_PATCH_LINE_13);
        const r = scanner.processLine(NOTION_PATCH_LINE_14);
        assert.equal(r.detected, true);
        assert.equal(r.identity!.name, 'read_workspace_file');
        assert.deepEqual(JSON.parse(r.identity!.arguments!), { path: 'README.md' });
    });

    test('heartbeat between split start and parameters does not trigger partial identity', () => {
        const scanner = createFunctionCallScanner();

        const splitStart = JSON.stringify({
            type: 'patch',
            v: [{
                o: 'x',
                p: '/s/8/value/0/content',
                v: '```jsonl\n{"type":"function_call_start","name',
            }],
        });
        const splitNameAndDescription = JSON.stringify({
            type: 'patch',
            v: [{
                o: 'x',
                p: '/s/8/value/0/content',
                v: '":"read_workspace_file","call_id":"call_read_1"}\n{"type":"description","text":"read target"}',
            }],
        });
        const heartbeat = JSON.stringify({ type: 'heartbeat' });
        const paramsAndEnd = JSON.stringify({
            type: 'patch',
            v: [{
                o: 'x',
                p: '/s/8/value/0/content',
                v: '\n{"type":"parameter","key":"path","value":"ai-web-agent-mcp/tests/test_tool_card_allowlist.py"}\n{"type":"parameter","key":"max_bytes","value":"1200"}\n{"type":"function_call_end","call_id":"call_read_1"}\n```',
            }],
        });

        const r1 = scanner.processLine(splitStart);
        assert.equal(r1.detected, false);
        assert.equal(r1.accumulating, true);

        const r2 = scanner.processLine(splitNameAndDescription);
        assert.equal(r2.detected, false);
        assert.equal(r2.accumulating, true);

        const r3 = scanner.processLine(heartbeat);
        assert.equal(r3.detected, false, 'heartbeat must not execute a partial call');
        assert.equal(r3.accumulating, true, 'heartbeat should keep waiting for function_call_end');

        const r4 = scanner.processLine(paramsAndEnd);
        assert.equal(r4.detected, true);
        assert.equal(r4.accumulating, false);
        assert.equal(r4.identity!.name, 'read_workspace_file');
        assert.equal(r4.identity!.callId, 'call_read_1');
        assert.deepEqual(JSON.parse(r4.identity!.arguments!), {
            path: 'ai-web-agent-mcp/tests/test_tool_card_allowlist.py',
            max_bytes: '1200',
        });
    });

    test('starts accumulating when function_call_start token is split after function_ fragment', () => {
        const scanner = createFunctionCallScanner();

        const splitFunctionPrefix = JSON.stringify({
            type: 'patch',
            v: [{
                o: 'x',
                p: '/s/8/value/0/content',
                v: ' changed file before review\"}\n```\n\n```jsonl\n{"type":"function_',
            }],
        });
        const splitCallStart = JSON.stringify({
            type: 'patch',
            v: [{
                o: 'x',
                p: '/s/8/value/0/content',
                v: 'call_start","name":"read_workspace_file","call_id":"call_read_2"}\n{"type":"description","text":"read target"}',
            }],
        });
        const paramsAndEnd = JSON.stringify({
            type: 'patch',
            v: [{
                o: 'x',
                p: '/s/8/value/0/content',
                v: '\n{"type":"parameter","key":"path","value":"ai-web-agent-mcp/tests/test_tool_card_allowlist.py"}\n{"type":"parameter","key":"max_bytes","value":1200}\n{"type":"function_call_end","call_id":"call_read_2"}\n```',
            }],
        });

        const r1 = scanner.processLine(splitFunctionPrefix);
        assert.equal(r1.detected, false);
        assert.equal(r1.accumulating, true);

        const r2 = scanner.processLine(splitCallStart);
        assert.equal(r2.detected, false);
        assert.equal(r2.accumulating, true);

        const r3 = scanner.processLine(paramsAndEnd);
        assert.equal(r3.detected, true);
        assert.equal(r3.accumulating, false);
        assert.equal(r3.identity!.name, 'read_workspace_file');
        assert.equal(r3.identity!.callId, 'call_read_2');
        assert.deepEqual(JSON.parse(r3.identity!.arguments!), {
            path: 'ai-web-agent-mcp/tests/test_tool_card_allowlist.py',
            max_bytes: 1200,
        });
    });

    test('starts accumulating when JSONL type value is split before function_call_start', () => {
        const scanner = createFunctionCallScanner();

        const splitAfterTypeQuote = JSON.stringify({
            type: 'patch',
            v: [{
                o: 'a',
                p: '/s/-',
                v: {
                    id: 'turn-1',
                    type: 'agent-inference',
                    value: [{ content: '```json\n{"status":"continue"}\n```\n\n```jsonl\n{"type":"' }],
                },
            }],
        });
        const startAndDescription = JSON.stringify({
            type: 'patch',
            v: [{
                o: 'x',
                p: '/s/8/value/0/content',
                v: 'function_call_start","name":"list_command","call_id":"call_list_1"}\n{"type":"description","text":"discover commands"',
            }],
        });
        const closeDescriptionAndEnd = JSON.stringify({
            type: 'patch',
            v: [{
                o: 'x',
                p: '/s/8/value/0/content',
                v: '}\n{"type":"function_call_end","call_id":"call_list_1"}\n```',
            }],
        });

        const r1 = scanner.processLine(splitAfterTypeQuote);
        assert.equal(r1.detected, false);
        assert.equal(r1.accumulating, true);

        const r2 = scanner.processLine(startAndDescription);
        assert.equal(r2.detected, false);
        assert.equal(r2.accumulating, true);

        const r3 = scanner.processLine(closeDescriptionAndEnd);
        assert.equal(r3.detected, true);
        assert.equal(r3.accumulating, false);
        assert.equal(r3.identity!.name, 'list_command');
        assert.equal(r3.identity!.callId, 'call_list_1');
        assert.equal(r3.identity!.arguments, null);
    });

    test('starts accumulating when JSONL object is split before type key', () => {
        const scanner = createFunctionCallScanner();

        const splitAfterObjectOpen = JSON.stringify({
            type: 'patch',
            v: [{
                o: 'a',
                p: '/s/-',
                v: {
                    id: 'turn-1',
                    type: 'agent-inference',
                    value: [{ content: '```json\n{"status":"continue"}\n```\n\n```jsonl\n{' }],
                },
            }],
        });
        const startAndFirstParameter = JSON.stringify({
            type: 'patch',
            v: [{
                o: 'x',
                p: '/s/8/value/0/content',
                v: '"type":"function_call_start","name":"get_child_item","call_id":"call_tree_1"}\n{"type":"parameter","key":"Path","value":"MCP-Su',
            }],
        });
        const restAndEnd = JSON.stringify({
            type: 'patch',
            v: [{
                o: 'x',
                p: '/s/8/value/0/content',
                v: 'perAssistant/scripts/temp/tree-smoke-fixture"}\n{"type":"parameter","key":"Depth","value":2}\n{"type":"function_call_end","call_id":"call_tree_1"}\n```',
            }],
        });

        const r1 = scanner.processLine(splitAfterObjectOpen);
        assert.equal(r1.detected, false);
        assert.equal(r1.accumulating, true);

        const r2 = scanner.processLine(startAndFirstParameter);
        assert.equal(r2.detected, false);
        assert.equal(r2.accumulating, true);

        const r3 = scanner.processLine(restAndEnd);
        assert.equal(r3.detected, true);
        assert.equal(r3.accumulating, false);
        assert.equal(r3.identity!.name, 'get_child_item');
        assert.equal(r3.identity!.callId, 'call_tree_1');
        assert.deepEqual(JSON.parse(r3.identity!.arguments!), {
            Path: 'MCP-SuperAssistant/scripts/temp/tree-smoke-fixture',
            Depth: 2,
        });
    });

    test('o:a complete in single patch (start + end)', () => {
        const complete = JSON.stringify({
            type: 'patch',
            v: [{
                o: 'a',
                p: '/s/5/value/-',
                v: {
                    value: [
                        { content: '{"type":"function_call_start","name":"list_tools","call_id":"q1"}\n{"type":"function_call_end","call_id":"q1"}' },
                    ],
                },
            }],
        });
        const scanner = createFunctionCallScanner();
        const r = scanner.processLine(complete);
        assert.equal(r.detected, true);
        assert.equal(r.identity!.name, 'list_tools');
        assert.equal(r.identity!.callId, 'q1');
    });
});

describe('createFunctionCallScanner — buffer cap', () => {
    test('aborts accumulation when buffer exceeds MAX_PATCH_BUFFER_SIZE', () => {
        const scanner = createFunctionCallScanner();

        // Start accumulation with a function_call_start patch
        const startPatch = JSON.stringify({
            type: 'patch',
            v: [{
                o: 'x',
                p: '/s/5/value/0/content',
                v: '{"type":"function_call_start","name":"big_tool","call_id":"c1"}\n',
            }],
        });
        const r1 = scanner.processLine(startPatch);
        assert.equal(r1.accumulating, true);

        // Feed oversized patch that pushes buffer past limit
        const bigContent = 'x'.repeat(MAX_PATCH_BUFFER_SIZE + 1);
        const bigPatch = JSON.stringify({
            type: 'patch',
            v: [{ o: 'x', p: '/s/5/value/0/content', v: bigContent }],
        });
        const r2 = scanner.processLine(bigPatch);

        // Should abort accumulation without executing partial arguments
        assert.equal(r2.accumulating, false, 'should stop accumulating');
        assert.equal(r2.detected, false, 'should not detect with incomplete oversized data');
        assert.equal(r2.identity, null);
    });

    test('MAX_PATCH_BUFFER_SIZE is 128KB', () => {
        assert.equal(MAX_PATCH_BUFFER_SIZE, 128 * 1024);
    });
});

// ============================================================================
// Regression tests for Gate 5d bug fixes
// ============================================================================

describe('Gate 5d regression: metadata patch false-positive (Bug C)', () => {
    // These tests reproduce the exact false-positive scenario from Gate 5d:
    // Notion metadata patches (agent-inference block creation) contain
    // "function_call" and "name" keywords in their metadata fields, which
    // triggered detectFunctionCall() but produced identity: null.

    const METADATA_PATCH_BLOCK_TYPE = JSON.stringify({
        type: 'patch',
        v: [{
            o: 'a',
            p: '/s/-',
            v: {
                id: 'abc123',
                type: 'agent-inference',
                name: 'function_call response',
            },
        }],
    });

    const METADATA_PATCH_WITH_FC_KEYWORD = JSON.stringify({
        type: 'patch',
        v: [{
            o: 'a',
            p: '/s/11/properties',
            v: {
                description: 'This block contains a function_call result with name mapping',
            },
        }],
    });

    test('metadata patch with "function_call" and "name" in values → detected: false', () => {
        const scanner = createFunctionCallScanner();
        const result = scanner.processLine(METADATA_PATCH_BLOCK_TYPE);
        assert.equal(result.detected, false, 'metadata patch should NOT be detected as function call');
        assert.equal(result.identity, null);
        assert.equal(result.accumulating, false);
    });

    test('metadata patch with "function_call" keyword in description → detected: false', () => {
        const scanner = createFunctionCallScanner();
        const result = scanner.processLine(METADATA_PATCH_WITH_FC_KEYWORD);
        assert.equal(result.detected, false, 'metadata description should NOT trigger detection');
        assert.equal(result.identity, null);
    });

    test('metadata patch during accumulation does not abort accumulation', () => {
        const scanner = createFunctionCallScanner();

        // Start accumulating with a real function_call_start content patch
        const startPatch = JSON.stringify({
            type: 'patch',
            v: [{
                o: 'x',
                p: '/s/5/value/0/content',
                v: '{"type":"function_call_start","name":"echo","call_id":"gate5d-1"}\n',
            }],
        });
        const r1 = scanner.processLine(startPatch);
        assert.equal(r1.accumulating, true, 'should start accumulating');

        // Metadata patch arrives mid-accumulation — must NOT abort
        const r2 = scanner.processLine(METADATA_PATCH_BLOCK_TYPE);
        assert.equal(r2.accumulating, true, 'metadata patch should not interrupt accumulation');
        assert.equal(r2.detected, false);

        // Content patch completes the function call
        const endPatch = JSON.stringify({
            type: 'patch',
            v: [{
                o: 'x',
                p: '/s/5/value/0/content',
                v: '{"type":"function_call_end","call_id":"gate5d-1"}\n',
            }],
        });
        const r3 = scanner.processLine(endPatch);
        assert.equal(r3.detected, true, 'should detect after end patch');
        assert.ok(r3.identity !== null);
        assert.equal(r3.identity!.name, 'echo');
        assert.equal(r3.identity!.callId, 'gate5d-1');
    });

    test('unknown-format fallback only fires for non-patch lines', () => {
        // A non-patch line with function_call keywords but no parseable identity
        // should still produce detected: true with identity: null (legacy behavior)
        const scanner = createFunctionCallScanner();
        const weirdLine = '{"data":"contains function_call and name keywords but not a real call"}';
        const result = scanner.processLine(weirdLine);
        assert.equal(result.detected, true, 'non-patch unknown format should still detect');
        assert.equal(result.identity, null, 'but identity should be null');
    });
});
