/**
 * Source-contract tests for adapter-sidebar coupling (UI-0 regression guard).
 *
 * These tests enforce the architectural contract established in UI-0:
 * - Adapters must not import from components/sidebar/
 * - Adapters must not reference activeSidebarManager
 *
 * If these tests fail, it means coupling has been re-introduced and must be fixed.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ADAPTERS_DIR = path.resolve(__dirname, '..');

function getAdapterFiles(): string[] {
  const files: string[] = [];
  function scan(dir: string) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory() && entry.name !== '__tests__') {
        scan(path.join(dir, entry.name));
      } else if (entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
        files.push(path.join(dir, entry.name));
      }
    }
  }
  scan(ADAPTERS_DIR);
  return files;
}

describe('Adapter Source Contracts (UI-0)', () => {
  const adapterFiles = getAdapterFiles();

  it('should have adapter files to check', () => {
    assert.ok(adapterFiles.length > 0, 'Expected adapter files to exist');
  });

  it('no adapter may import from components/sidebar/', () => {
    const violations: string[] = [];
    for (const file of adapterFiles) {
      const content = fs.readFileSync(file, 'utf-8');
      if (content.includes('components/sidebar/')) {
        violations.push(path.relative(ADAPTERS_DIR, file));
      }
    }
    assert.deepStrictEqual(violations, [], violations.length > 0 ?
      `UI-0 violation: the following adapter files import from components/sidebar/:\n` +
      violations.map((f: string) => `  - ${f}`).join('\n') +
      '\n\nFix: move the imported module out of components/sidebar/ (see plans/mcp-sa-browser-ui-refactor-execution-plan.md UI-0a)'
      : '');
  });

  it('no adapter may reference activeSidebarManager', () => {
    const violations: string[] = [];
    for (const file of adapterFiles) {
      const content = fs.readFileSync(file, 'utf-8');
      if (content.includes('activeSidebarManager')) {
        violations.push(path.relative(ADAPTERS_DIR, file));
      }
    }
    assert.deepStrictEqual(violations, [], violations.length > 0 ?
      `UI-0 violation: the following adapter files reference activeSidebarManager:\n` +
      violations.map((f: string) => `  - ${f}`).join('\n') +
      '\n\nFix: remove or replace activeSidebarManager calls (see plans/mcp-sa-browser-ui-refactor-execution-plan.md UI-0b)'
      : '');
  });
});
