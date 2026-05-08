/**
 * Unit tests for interceptorMain.ts Notion patch format parsing
 *
 * Tests the cross-patch accumulator scanner, patch text extraction,
 * and JSONL block identity extraction.
 *
 * Run: node --test --experimental-strip-types interceptorMain.test.ts
 * (from render_prescript/src/stream/ directory)
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

// ============================================================================
// Re-implement the testable functions from interceptorMain.ts
// (The IIFE doesn't export; we duplicate the logic for testing)
// ============================================================================

interface FunctionCallIdentity {
    name: string | null;
    callId: string | null;
    arguments: string | null;
}

const FUNCTION_CALL_KEYWORDS = ['function_call', 'tool_use', 'tool_calls', 'name'];
const MIN_KEYWORD_MATCHES = 2;

function detectFunctionCall(line: string): boolean {
    if (!line || line.length < 10) return false;
    let matches = 0;
    for (const keyword of FUNCTION_CALL_KEYWORDS) {
        if (line.includes(keyword)) {
            matches++;
            if (matches >= MIN_KEYWORD_MATCHES) return true;
        }
    }
    return false;
}

function extractFunctionCallIdentity(line: string): FunctionCallIdentity | null {
    try {
        const obj = JSON.parse(line);
        if (!obj || typeof obj !== 'object') return null;

        if (obj.type === 'function_call') {
            return {
                name: typeof obj.name === 'string' ? obj.name : null,
                callId: typeof obj.id === 'string' ? obj.id : null,
                arguments: typeof obj.arguments === 'string' ? obj.arguments : null,
            };
        }

        if (obj.function_call && typeof obj.function_call === 'object') {
            const fc = obj.function_call;
            return {
                name: typeof fc.name === 'string' ? fc.name : null,
                callId: typeof obj.id === 'string' ? obj.id : null,
                arguments: typeof fc.arguments === 'string' ? fc.arguments : null,
            };
        }

        if (Array.isArray(obj.tool_calls) && obj.tool_calls.length > 0) {
            const tc = obj.tool_calls[0];
            const fn = tc.function;
            return {
                name: fn && typeof fn.name === 'string' ? fn.name : null,
                callId: typeof tc.id === 'string' ? tc.id : null,
                arguments: fn && typeof fn.arguments === 'string' ? fn.arguments : null,
            };
        }

        if (obj.tool_use && typeof obj.tool_use === 'object') {
            const tu = obj.tool_use;
            return {
                name: typeof tu.name === 'string' ? tu.name : null,
                callId: typeof tu.id === 'string' ? tu.id : null,
                arguments: tu.input ? JSON.stringify(tu.input) : null,
            };
        }

        return null;
    } catch {
        return null;
    }
}

function extractPatchTextContent(line: string): string | null {
    try {
        const obj = JSON.parse(line);
        if (obj?.type !== 'patch' || !Array.isArray(obj.v)) return null;

        let text = '';
        for (const op of obj.v) {
            if (op.o === 'x' && typeof op.v === 'string' && typeof op.p === 'string' && op.p.endsWith('/content')) {
                text += op.v;
            }
        }
        return text || null;
    } catch {
        return null;
    }
}

function extractIdentityFromJsonlBlock(text: string): FunctionCallIdentity | null {
    const lines = text.split('\n');
    let name: string | null = null;
    let callId: string | null = null;
    const args: Record<string, string> = {};

    for (const rawLine of lines) {
        const trimmed = rawLine.trim();
        if (!trimmed.startsWith('{')) continue;
        try {
            const obj = JSON.parse(trimmed);
            if (obj.type === 'function_call_start') {
                name = typeof obj.name === 'string' ? obj.name : null;
                callId = typeof obj.call_id === 'string' ? obj.call_id : null;
            } else if (obj.type === 'parameter' && typeof obj.key === 'string') {
                args[obj.key] = typeof obj.value === 'string' ? obj.value : JSON.stringify(obj.value);
            }
        } catch {
            continue;
        }
    }

    if (!name) return null;
    return {
        name,
        callId,
        arguments: Object.keys(args).length > 0 ? JSON.stringify(args) : null,
    };
}

interface ScanResult {
    detected: boolean;
    identity: FunctionCallIdentity | null;
    rawLine: string;
    accumulating: boolean;
}

function createFunctionCallScanner() {
    let patchContentBuffer = '';
    let isAccumulating = false;
    let firstDetectionLine = '';

    function processLine(trimmedLine: string): ScanResult {
        if (isAccumulating) {
            const patchText = extractPatchTextContent(trimmedLine);
            if (patchText !== null) {
                patchContentBuffer += patchText;
                if (patchContentBuffer.includes('function_call_end')) {
                    const identity = extractIdentityFromJsonlBlock(patchContentBuffer);
                    const rawLine = firstDetectionLine;
                    reset();
                    return { detected: true, identity, rawLine, accumulating: false };
                }
                return { detected: false, identity: null, rawLine: '', accumulating: true };
            }
            const identity = extractIdentityFromJsonlBlock(patchContentBuffer);
            const rawLine = firstDetectionLine;
            reset();
            if (identity !== null) {
                return { detected: true, identity, rawLine, accumulating: false };
            }
        }

        if (!detectFunctionCall(trimmedLine)) {
            return { detected: false, identity: null, rawLine: '', accumulating: false };
        }

        const identity = extractFunctionCallIdentity(trimmedLine);
        if (identity !== null) {
            return { detected: true, identity, rawLine: trimmedLine, accumulating: false };
        }

        const patchText = extractPatchTextContent(trimmedLine);
        if (patchText !== null && patchText.includes('function_call_start')) {
            patchContentBuffer = patchText;
            firstDetectionLine = trimmedLine;
            if (patchText.includes('function_call_end')) {
                const patchIdentity = extractIdentityFromJsonlBlock(patchContentBuffer);
                reset();
                return { detected: true, identity: patchIdentity, rawLine: trimmedLine, accumulating: false };
            }
            isAccumulating = true;
            return { detected: false, identity: null, rawLine: '', accumulating: true };
        }

        return { detected: true, identity: null, rawLine: trimmedLine, accumulating: false };
    }

    function reset() {
        patchContentBuffer = '';
        isAccumulating = false;
        firstDetectionLine = '';
    }

    return { processLine };
}

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
