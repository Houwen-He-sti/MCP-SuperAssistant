/**
 * Unit tests for stream/parser.ts
 * Tests function_call detection and identity extraction.
 *
 * Run: node parser.test.mjs
 * (from render_prescript/src/stream/ directory)
 */

// Inline the parser logic for testing (avoids TS build dependency)
// Source of truth is parser.ts; keep these in sync.
const FUNCTION_CALL_KEYWORDS = [
    'function_call',
    'tool_use',
    'tool_calls',
    'name',
];
const MIN_KEYWORD_MATCHES = 2;

function detectFunctionCall(line) {
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

function tryParseNDJSON(line) {
    try { return JSON.parse(line); } catch { return null; }
}

function extractFunctionCallIdentity(line) {
    const parsed = tryParseNDJSON(line);
    if (!parsed || typeof parsed !== 'object') return null;

    if (parsed.type === 'function_call') {
        return {
            name: typeof parsed.name === 'string' ? parsed.name : null,
            callId: typeof parsed.id === 'string' ? parsed.id : null,
            arguments: typeof parsed.arguments === 'string' ? parsed.arguments : null,
        };
    }

    if (parsed.function_call && typeof parsed.function_call === 'object') {
        const fc = parsed.function_call;
        return {
            name: typeof fc.name === 'string' ? fc.name : null,
            callId: typeof parsed.id === 'string' ? parsed.id : null,
            arguments: typeof fc.arguments === 'string' ? fc.arguments : null,
        };
    }

    if (Array.isArray(parsed.tool_calls) && parsed.tool_calls.length > 0) {
        const tc = parsed.tool_calls[0];
        const fn = tc.function;
        return {
            name: fn && typeof fn.name === 'string' ? fn.name : null,
            callId: typeof tc.id === 'string' ? tc.id : null,
            arguments: fn && typeof fn.arguments === 'string' ? fn.arguments : null,
        };
    }

    if (parsed.tool_use && typeof parsed.tool_use === 'object') {
        const tu = parsed.tool_use;
        return {
            name: typeof tu.name === 'string' ? tu.name : null,
            callId: typeof tu.id === 'string' ? tu.id : null,
            arguments: tu.input ? JSON.stringify(tu.input) : null,
        };
    }

    return { name: null, callId: null, arguments: null };
}

// --- Test harness ---

let passed = 0;
let failed = 0;

function assert(condition, msg) {
    if (condition) {
        passed++;
        console.log(`  ✅ ${msg}`);
    } else {
        failed++;
        console.error(`  ❌ FAIL: ${msg}`);
    }
}

function assertEq(actual, expected, msg) {
    const ok = JSON.stringify(actual) === JSON.stringify(expected);
    if (ok) {
        passed++;
        console.log(`  ✅ ${msg}`);
    } else {
        failed++;
        console.error(`  ❌ FAIL: ${msg}`);
        console.error(`    Expected: ${JSON.stringify(expected)}`);
        console.error(`    Actual:   ${JSON.stringify(actual)}`);
    }
}

// === detectFunctionCall tests ===

console.log('=== detectFunctionCall tests ===\n');
console.log('Positive cases (should detect):');

assert(
    detectFunctionCall('{"type":"function_call","name":"search","arguments":"{}"}'),
    'Standard function_call + name'
);

assert(
    detectFunctionCall('{"tool_use":{"name":"calculator","input":{}}}'),
    'tool_use + name'
);

assert(
    detectFunctionCall('{"tool_calls":[{"function":{"name":"get_weather"}}]}'),
    'tool_calls + name (OpenAI format)'
);

assert(
    detectFunctionCall('{"function_call":{"tool_use":"true"}}'),
    'function_call + tool_use combo'
);

assert(
    detectFunctionCall('{"type":"function_call","id":"call_abc123","name":"mcp__search","arguments":"{\\"query\\":\\"test\\"}"}'),
    'Real-world function_call chunk (Phase 0 evidence)'
);

console.log('\nNegative cases (should NOT detect):');

assert(!detectFunctionCall(''), 'Empty string');
assert(!detectFunctionCall('short'), 'Too short');

assert(
    !detectFunctionCall('{"type":"text","value":"Hello, how can I help you?"}'),
    'Normal text chunk'
);

assert(
    !detectFunctionCall('{"type":"text","value":"The function was called by name in the code."}'),
    'Text containing "name" alone (only 1 keyword = below threshold)'
);

assert(
    !detectFunctionCall('{"delta":{"content":"Here is the result of the calculation."}}'),
    'Regular streaming content'
);

assert(
    !detectFunctionCall('{"type":"done","status":"complete"}'),
    'Stream termination signal'
);

assert(
    !detectFunctionCall('{"name":"John","age":30,"city":"Tokyo"}'),
    'JSON with "name" field but no tool-related keywords'
);

console.log('\nEdge cases:');

assert(!detectFunctionCall(null), 'null input');
assert(!detectFunctionCall(undefined), 'undefined input');

assert(
    detectFunctionCall('function_call tool_use this is a long enough line with both keywords'),
    'Plain text with 2+ keywords (intentionally matches)'
);

// === extractFunctionCallIdentity tests ===

console.log('\n=== extractFunctionCallIdentity tests ===\n');
console.log('Format extraction:');

assertEq(
    extractFunctionCallIdentity('{"type":"function_call","name":"mcp__search","id":"call_123","arguments":"{\\"q\\":\\"test\\"}"}'),
    { name: 'mcp__search', callId: 'call_123', arguments: '{"q":"test"}' },
    'Format 1: type=function_call with all fields'
);

assertEq(
    extractFunctionCallIdentity('{"function_call":{"name":"get_weather","arguments":"{\\"city\\":\\"Tokyo\\"}"},"id":"fc_456"}'),
    { name: 'get_weather', callId: 'fc_456', arguments: '{"city":"Tokyo"}' },
    'Format 2: function_call object wrapper'
);

assertEq(
    extractFunctionCallIdentity('{"tool_calls":[{"id":"tc_789","function":{"name":"calculate","arguments":"{\\"x\\":1}"}}]}'),
    { name: 'calculate', callId: 'tc_789', arguments: '{"x":1}' },
    'Format 3: tool_calls array (OpenAI)'
);

assertEq(
    extractFunctionCallIdentity('{"tool_use":{"name":"browser","id":"tu_001","input":{"url":"https://example.com"}}}'),
    { name: 'browser', callId: 'tu_001', arguments: '{"url":"https://example.com"}' },
    'Format 4: tool_use (Anthropic-style)'
);

console.log('\nPartial / fallback:');

assertEq(
    extractFunctionCallIdentity('{"type":"function_call"}'),
    { name: null, callId: null, arguments: null },
    'function_call type with no name/args'
);

assertEq(
    extractFunctionCallIdentity('not valid json at all'),
    null,
    'Invalid JSON — returns null'
);

assertEq(
    extractFunctionCallIdentity('{"foo":"bar"}'),
    { name: null, callId: null, arguments: null },
    'Valid JSON but no known format — returns fallback'
);

// === Summary ===

console.log(`\nResults: ${passed} passed, ${failed} failed, ${passed + failed} total`);

if (failed > 0) {
    process.exit(1);
}
