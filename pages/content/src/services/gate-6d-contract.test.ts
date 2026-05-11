/**
 * Gate 6D Contract Test
 *
 * Verifies the Gate 6D architectural decision:
 * - ToolResultRenderer v1 is NOT auto-initialized
 * - ToolLoopCardRenderer v2 IS the sole default renderer
 * - ToolResultRenderer remains exported for manual rollback
 *
 * These are "contract tests" — they assert the structural guarantees
 * of the service initialization module, ensuring future changes don't
 * accidentally re-enable v1 or remove v2.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const indexSource = readFileSync(resolve(__dirname, 'index.ts'), 'utf8');

// Extract function bodies using balanced braces
function extractFunctionBody(source: string, funcName: string): string | null {
  const pattern = new RegExp(`(async\\s+)?function\\s+${funcName}\\s*\\(`);
  const match = source.match(pattern);
  if (!match || match.index === undefined) return null;

  let depth = 0;
  let start = -1;
  for (let i = match.index; i < source.length; i++) {
    if (source[i] === '{') {
      if (start === -1) start = i;
      depth++;
    } else if (source[i] === '}') {
      depth--;
      if (depth === 0) return source.substring(start, i + 1);
    }
  }
  return null;
}

describe('Gate 6D: v1 renderer not auto-initialized (contract)', () => {
  const initBody = extractFunctionBody(indexSource, 'initializeAllServices');
  const cleanupBody = extractFunctionBody(indexSource, 'cleanupAllServices');

  it('initializeAllServices exists', () => {
    assert.ok(initBody, 'initializeAllServices function must exist in services/index.ts');
  });

  it('initializeAllServices does NOT initialize ToolResultRenderer', () => {
    assert.ok(initBody, 'precondition: function exists');
    assert.ok(
      !initBody.includes('ToolResultRenderer.getInstance().initialize()'),
      'Gate 6D contract: v1 ToolResultRenderer must NOT be auto-initialized',
    );
  });

  it('cleanupAllServices does NOT cleanup ToolResultRenderer', () => {
    assert.ok(cleanupBody, 'precondition: cleanupAllServices exists');
    assert.ok(
      !cleanupBody.includes('ToolResultRenderer.getInstance().cleanup()'),
      'Gate 6D contract: v1 ToolResultRenderer must NOT be auto-cleaned-up',
    );
  });

  it('ToolLoopCardRenderer IS initialized in initializeAllServices', () => {
    assert.ok(initBody, 'precondition: function exists');
    assert.ok(
      initBody.includes('ToolLoopCardRenderer.getInstance().start()'),
      'Gate 6D contract: v2 ToolLoopCardRenderer must be the sole renderer',
    );
  });

  it('ToolLoopCardRenderer IS stopped in cleanupAllServices', () => {
    assert.ok(cleanupBody, 'precondition: cleanupAllServices exists');
    assert.ok(
      cleanupBody.includes('ToolLoopCardRenderer.getInstance().stop()'),
      'Gate 6D contract: v2 ToolLoopCardRenderer must be cleaned up',
    );
  });

  it('ToolResultRenderer is still exported for manual rollback', () => {
    assert.ok(
      indexSource.includes('ToolResultRenderer'),
      'Gate 6D contract: v1 must remain exported for rollback compatibility',
    );
    // Verify it's in an export statement, not just mentioned in comments
    const exportLine = indexSource.split('\n').find(
      line => line.includes('export') && line.includes('ToolResultRenderer') && !line.startsWith('//')
    );
    assert.ok(exportLine, 'ToolResultRenderer must be in an export statement');
  });
});
