import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { describe, test } from 'node:test';

import { isCspEvalError } from './evalErrorGuard.ts';

describe('isCspEvalError — CSP guard for plugin getPrimitives', () => {
  test('EvalError instance → true', () => {
    assert.equal(isCspEvalError(new EvalError('csp')), true);
  });

  test("Error with 'unsafe-eval' in message → true", () => {
    const err = new Error("Refused to evaluate a string as JavaScript because 'unsafe-eval' is not allowed");
    assert.equal(isCspEvalError(err), true);
  });

  test('Generic Error without unsafe-eval → false', () => {
    assert.equal(isCspEvalError(new Error('Network error')), false);
  });

  test('TypeError without unsafe-eval → false', () => {
    assert.equal(isCspEvalError(new TypeError('foo')), false);
  });

  test('Non-error value → false', () => {
    assert.equal(isCspEvalError('string'), false);
    assert.equal(isCspEvalError(null), false);
    assert.equal(isCspEvalError(undefined), false);
    assert.equal(isCspEvalError(42), false);
  });

  test('Both plugins use shared isCspEvalError guard', async () => {
    const baseDir = path.dirname(new URL(import.meta.url).pathname);
    const ssePath = path.join(baseDir, 'sse', 'SSEPlugin.ts');
    const httpPath = path.join(baseDir, 'streamable-http', 'StreamableHttpPlugin.ts');

    const [sseSource, httpSource] = await Promise.all([
      fs.readFile(ssePath, 'utf-8'),
      fs.readFile(httpPath, 'utf-8'),
    ]);

    assert.match(sseSource, /import\s*\{\s*isCspEvalError\s*\}\s*from\s*['"].*evalErrorGuard\.js['"]/);
    assert.match(httpSource, /import\s*\{\s*isCspEvalError\s*\}\s*from\s*['"].*evalErrorGuard\.js['"]/);
    assert.match(sseSource, /isCspEvalError\(error\)/);
    assert.match(httpSource, /isCspEvalError\(error\)/);
  });
});
