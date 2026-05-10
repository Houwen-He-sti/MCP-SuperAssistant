/**
 * Unit tests for tab-label-detector.ts — pure detection logic.
 *
 * Tests detectFromValues() which is the pure-function core of detectTabLabel().
 * No browser globals needed — takes windowName and documentTitle as params.
 *
 * Run: node --test --experimental-strip-types tab-label-detector.test.ts
 * (from pages/content/src/core/ directory)
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { detectFromValues, type DetectedLabel } from './tab-label-detector.ts';

// --- detectFromValues: window.name detection ---

describe('detectFromValues — window.name (__AIWEB__ prefix)', () => {
  test('detects label from __AIWEB__<label>', () => {
    const result = detectFromValues('__AIWEB__gpt-tab-6', '');
    assert.deepStrictEqual(result, { label: 'gpt-tab-6', source: 'window-name' });
  });

  test('returns null for bare __AIWEB__ prefix with no label', () => {
    const result = detectFromValues('__AIWEB__', '');
    assert.equal(result, null);
  });

  test('detects label with special characters', () => {
    const result = detectFromValues('__AIWEB__notion-tab-0', '');
    assert.deepStrictEqual(result, { label: 'notion-tab-0', source: 'window-name' });
  });

  test('ignores window.name without __AIWEB__ prefix', () => {
    const result = detectFromValues('some-random-name', '');
    assert.equal(result, null);
  });

  test('ignores empty window.name', () => {
    const result = detectFromValues('', '');
    assert.equal(result, null);
  });
});

// --- detectFromValues: title prefix detection ---

describe('detectFromValues — document.title prefix ([label])', () => {
  test('detects label from [label] prefix', () => {
    const result = detectFromValues('', '[gpt-tab-6] ChatGPT');
    assert.deepStrictEqual(result, { label: 'gpt-tab-6', source: 'title-prefix' });
  });

  test('detects label with spaces in title after prefix', () => {
    const result = detectFromValues('', '[perplexity-tab-0] Some Search Query');
    assert.deepStrictEqual(result, { label: 'perplexity-tab-0', source: 'title-prefix' });
  });

  test('returns null for title without [label] prefix', () => {
    const result = detectFromValues('', 'ChatGPT — Plain title');
    assert.equal(result, null);
  });

  test('returns null for empty title', () => {
    const result = detectFromValues('', '');
    assert.equal(result, null);
  });

  test('handles [label] only (no text after)', () => {
    const result = detectFromValues('', '[my-tab]');
    assert.deepStrictEqual(result, { label: 'my-tab', source: 'title-prefix' });
  });

  test('ignores nested brackets — only first match', () => {
    const result = detectFromValues('', '[outer] some [inner] text');
    assert.deepStrictEqual(result, { label: 'outer', source: 'title-prefix' });
  });

  test('returns null for empty brackets []', () => {
    const result = detectFromValues('', '[] empty label');
    assert.equal(result, null);
  });
});

// --- detectFromValues: priority ---

describe('detectFromValues — priority (window.name wins)', () => {
  test('window.name takes priority over title prefix', () => {
    const result = detectFromValues('__AIWEB__from-name', '[from-title] Page');
    assert.deepStrictEqual(result, { label: 'from-name', source: 'window-name' });
  });

  test('falls back to title when window.name has no label', () => {
    const result = detectFromValues('__AIWEB__', '[fallback] Page');
    assert.deepStrictEqual(result, { label: 'fallback', source: 'title-prefix' });
  });

  test('returns null when neither source has a label', () => {
    const result = detectFromValues('random', 'Normal Page Title');
    assert.equal(result, null);
  });
});
