/**
 * Unit tests for stream/parser.ts
 * Tests function_call detection logic in NDJSON lines.
 *
 * Run: node --experimental-vm-modules stream.parser.test.mjs
 * (from render_prescript/src/stream/ directory)
 */

// Inline the parser logic for testing (avoids TS build dependency)
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

// --- Test cases ---

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

console.log('=== stream/parser.ts — detectFunctionCall tests ===\n');

// Positive cases
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

// Real-world chunk from Phase 0 PoC (simplified)
assert(
  detectFunctionCall('{"type":"function_call","id":"call_abc123","name":"mcp__search","arguments":"{\\"query\\":\\"test\\"}"}'),
  'Real-world function_call chunk (Phase 0 evidence)'
);

console.log('');

// Negative cases
console.log('Negative cases (should NOT detect):');

assert(
  !detectFunctionCall(''),
  'Empty string'
);

assert(
  !detectFunctionCall('short'),
  'Too short'
);

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

// Edge case: "name" appears but no other keyword
assert(
  !detectFunctionCall('{"name":"John","age":30,"city":"Tokyo"}'),
  'JSON with "name" field but no tool-related keywords'
);

console.log('');

// Edge cases
console.log('Edge cases:');

assert(
  !detectFunctionCall(null),
  'null input'
);

assert(
  !detectFunctionCall(undefined),
  'undefined input'
);

assert(
  detectFunctionCall('function_call tool_use this is a long enough line with both keywords'),
  'Plain text with 2+ keywords (intentionally matches)'
);

console.log('');
console.log(`Results: ${passed} passed, ${failed} failed, ${passed + failed} total`);

if (failed > 0) {
  process.exit(1);
}
