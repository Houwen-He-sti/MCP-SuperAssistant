import test from 'node:test';
import assert from 'node:assert/strict';

import { validateFunctionCallContent, validateFunctionCallElement } from './functionCallValidator.ts';

const knownTools = ['real_tool'];

const element = (tagName, textContent, parentTagName = null) => ({
  tagName,
  textContent,
  parentElement: parentTagName ? { tagName: parentTagName } : null,
});

const validXml = `<function_calls>
  <invoke name="real_tool" call_id="call_1">
    <parameter name="query">hello</parameter>
  </invoke>
</function_calls>`;

test('plain explanatory paragraph is not renderable or executable', () => {
  const result = validateFunctionCallElement(
    element('p', `Example only: <function_calls>...</function_calls>`),
    { toolNames: knownTools },
  );

  assert.equal(result.isValid, false);
  assert.equal(result.isExecutable, false);
});

test('inline code with function-call-like text is not renderable or executable', () => {
  const result = validateFunctionCallElement(element('code', validXml, 'p'), { toolNames: knownTools });

  assert.equal(result.isValid, false);
  assert.equal(result.isExecutable, false);
});

test('standalone code block without valid invoke is ignored', () => {
  const result = validateFunctionCallElement(
    element('pre', '<function_calls>...</function_calls>'),
    { toolNames: knownTools },
  );

  assert.equal(result.isValid, false);
  assert.equal(result.isExecutable, false);
});

test('unknown XML tool name is not renderable or executable', () => {
  const result = validateFunctionCallContent(
    `<function_calls>
      <invoke name="example_tool" call_id="call_1"></invoke>
    </function_calls>`,
    { toolNames: knownTools },
  );

  assert.equal(result.isValid, false);
  assert.equal(result.isExecutable, false);
});

test('valid XML with a registered tool is executable', () => {
  const result = validateFunctionCallElement(element('pre', validXml), { toolNames: knownTools });

  assert.equal(result.isValid, true);
  assert.equal(result.isComplete, true);
  assert.equal(result.isExecutable, true);
  assert.equal(result.call?.functionName, 'real_tool');
  assert.deepEqual(result.call?.parameters, { query: 'hello' });
});

test('JSONL requires start and end before executable state', () => {
  const partial = validateFunctionCallContent(
    '{"type":"function_call_start","name":"real_tool","call_id":"call_2"}\n{"type":"parameter","key":"query","value":"hello"}',
    { toolNames: knownTools },
  );

  assert.equal(partial.isValid, true);
  assert.equal(partial.isComplete, false);
  assert.equal(partial.isExecutable, false);

  const complete = validateFunctionCallElement(
    element(
      'pre',
      '{"type":"function_call_start","name":"real_tool","call_id":"call_2"}\n{"type":"parameter","key":"query","value":"hello"}\n{"type":"function_call_end"}',
    ),
    { toolNames: knownTools },
  );

  assert.equal(complete.isValid, true);
  assert.equal(complete.isComplete, true);
  assert.equal(complete.isExecutable, true);
  assert.deepEqual(complete.call?.parameters, { query: 'hello' });
});

test('unknown JSONL tool name is not renderable or executable', () => {
  const result = validateFunctionCallElement(
    element(
      'pre',
      '{"type":"function_call_start","name":"function_name","call_id":"call_3"}\n{"type":"function_call_end"}',
    ),
    { toolNames: knownTools },
  );

  assert.equal(result.isValid, false);
  assert.equal(result.isExecutable, false);
});

// === Parser Regression Tests (Issue #19) ===
// These test extractJSONObjects' brace-depth scanner against edge cases
// that caused failures when ChatGPT's DOM produced no-newline content.

test('no-newline concatenated JSONL is parsed correctly', () => {
  // ChatGPT textContent produces this: <br> elements are ignored
  const concatenated =
    '{"type":"function_call_start","name":"real_tool","call_id":"c1"}{"type":"parameter","key":"msg","value":"hello"}{"type":"function_call_end"}';

  const result = validateFunctionCallContent(concatenated, { toolNames: knownTools });

  assert.equal(result.isValid, true);
  assert.equal(result.isComplete, true);
  assert.equal(result.isExecutable, true);
  assert.equal(result.call?.functionName, 'real_tool');
  assert.deepEqual(result.call?.parameters, { msg: 'hello' });
});

test('parameter value containing curly braces does not break parsing', () => {
  const content =
    '{"type":"function_call_start","name":"real_tool","call_id":"c2"}\n' +
    '{"type":"parameter","key":"code","value":"if (x) { return {a: 1}; }"}\n' +
    '{"type":"function_call_end"}';

  const result = validateFunctionCallContent(content, { toolNames: knownTools });

  assert.equal(result.isValid, true);
  assert.equal(result.isComplete, true);
  assert.equal(result.isExecutable, true);
  assert.equal(result.call?.parameters?.code, 'if (x) { return {a: 1}; }');
});

test('parameter value with escaped quotes does not break parsing', () => {
  const content =
    '{"type":"function_call_start","name":"real_tool","call_id":"c3"}\n' +
    '{"type":"parameter","key":"text","value":"He said \\"hello\\" and \\"goodbye\\""}\n' +
    '{"type":"function_call_end"}';

  const result = validateFunctionCallContent(content, { toolNames: knownTools });

  assert.equal(result.isValid, true);
  assert.equal(result.isComplete, true);
  assert.equal(result.isExecutable, true);
  assert.equal(result.call?.parameters?.text, 'He said "hello" and "goodbye"');
});

test('nested object parameter value is parsed correctly', () => {
  const content =
    '{"type":"function_call_start","name":"real_tool","call_id":"c4"}\n' +
    '{"type":"parameter","key":"config","value":{"a":1,"b":{"c":2,"d":[3,4]}}}\n' +
    '{"type":"function_call_end"}';

  const result = validateFunctionCallContent(content, { toolNames: knownTools });

  assert.equal(result.isValid, true);
  assert.equal(result.isComplete, true);
  assert.equal(result.isExecutable, true);
  assert.deepEqual(result.call?.parameters?.config, { a: 1, b: { c: 2, d: [3, 4] } });
});

test('DOM textContent simulation: concatenated JSON from span+br structure', () => {
  // Simulates: <span>{start}</span><br><span>{param}</span><br><span>{end}</span>
  // textContent result (br ignored):
  const domTextContent =
    '{"type":"function_call_start","name":"real_tool","call_id":"dom1"}' +
    '{"type":"parameter","key":"query","value":"test"}' +
    '{"type":"function_call_end"}';

  const result = validateFunctionCallElement(
    element('pre', domTextContent),
    { toolNames: knownTools },
  );

  assert.equal(result.isValid, true);
  assert.equal(result.isComplete, true);
  assert.equal(result.isExecutable, true);
  assert.equal(result.call?.functionName, 'real_tool');
  assert.equal(result.call?.callId, 'dom1');
  assert.deepEqual(result.call?.parameters, { query: 'test' });
});

test('concatenated JSON with mixed whitespace between objects', () => {
  // Some environments might have spaces/tabs but no newlines
  const content =
    '{"type":"function_call_start","name":"real_tool","call_id":"ws1"}  \t  ' +
    '{"type":"parameter","key":"x","value":"y"}   ' +
    '{"type":"function_call_end"}';

  const result = validateFunctionCallContent(content, { toolNames: knownTools });

  assert.equal(result.isValid, true);
  assert.equal(result.isComplete, true);
  assert.equal(result.isExecutable, true);
});

test('empty tool registry rejects even valid JSONL', () => {
  const content =
    '{"type":"function_call_start","name":"real_tool","call_id":"c5"}\n{"type":"function_call_end"}';

  const result = validateFunctionCallContent(content, { toolNames: [] });

  assert.equal(result.isValid, false);
  assert.equal(result.isExecutable, false);
  assert.match(result.reason, /tool registry unavailable/);
});

test('incomplete JSONL (no function_call_end) is valid but not executable', () => {
  const content =
    '{"type":"function_call_start","name":"real_tool","call_id":"stream1"}' +
    '{"type":"parameter","key":"msg","value":"streaming..."}';

  const result = validateFunctionCallContent(content, { toolNames: knownTools });

  assert.equal(result.isValid, true);
  assert.equal(result.isComplete, false);
  assert.equal(result.isExecutable, false);
});
