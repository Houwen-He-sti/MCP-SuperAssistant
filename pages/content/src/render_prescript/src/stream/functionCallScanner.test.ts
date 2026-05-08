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

    test('non-patch line during accumulation triggers best-effort extraction', () => {
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

        // Non-patch line interrupts — should extract what we have
        const r2 = scanner.processLine('{"type":"some_other_line","name":"irrelevant"}');
        assert.equal(r2.detected, true, 'should detect with partial data');
        assert.ok(r2.identity !== null);
        assert.equal(r2.identity!.name, 'my_tool');
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

        // Should abort accumulation — best-effort identity extraction from what we have
        assert.equal(r2.accumulating, false, 'should stop accumulating');
        // identity may or may not be extracted (partial data), but accumulation must stop
        assert.equal(r2.detected, true, 'should detect with partial data');
        assert.ok(r2.identity !== null, 'should extract partial identity');
        assert.equal(r2.identity!.name, 'big_tool');
    });

    test('MAX_PATCH_BUFFER_SIZE is 128KB', () => {
        assert.equal(MAX_PATCH_BUFFER_SIZE, 128 * 1024);
    });
});
