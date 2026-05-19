/**
 * Tests for the extension-side MCP JSON schema validator seam.
 *
 * Run:
 *   node --test --experimental-strip-types chrome-extension/tests/mcpclient/jsonSchemaValidator.node-test.ts
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  createExtensionClientOptions,
  createExtensionJsonSchemaValidator,
} from '../../src/mcpclient/core/jsonSchemaValidator.ts';

describe('extension MCP JSON schema validator', () => {
  test('can compile outputSchema while Function constructor is blocked', () => {
    const originalFunction = globalThis.Function;
    const blockedFunction = function blockedFunction() {
      throw new EvalError('unsafe-eval blocked by extension CSP');
    } as unknown as FunctionConstructor;

    Object.defineProperty(globalThis, 'Function', {
      configurable: true,
      value: blockedFunction,
    });

    try {
      const provider = createExtensionJsonSchemaValidator();
      const validate = provider.getValidator({
        type: 'object',
        properties: {
          result: { type: 'string' },
        },
        required: ['result'],
      });

      assert.equal(validate({ result: 'ok' }).valid, true);
      assert.equal(validate({ result: 42 }).valid, false);
    } finally {
      Object.defineProperty(globalThis, 'Function', {
        configurable: true,
        value: originalFunction,
      });
    }
  });

  test('client options include a CSP-safe validator provider', () => {
    const options = createExtensionClientOptions();
    assert.deepEqual(options.capabilities, {});
    assert.equal(typeof options.jsonSchemaValidator?.getValidator, 'function');
  });

  test('McpClient constructs SDK Client through the extension options seam', () => {
    const thisDir = dirname(fileURLToPath(import.meta.url));
    const source = readFileSync(join(thisDir, '../../src/mcpclient/core/McpClient.ts'), 'utf8');

    assert.match(source, /createExtensionClientOptions/);
    assert.doesNotMatch(source, /new Client\([\s\S]*?\{\s*capabilities:\s*\{\}\s*\}\s*,?\s*\)/);
  });
});