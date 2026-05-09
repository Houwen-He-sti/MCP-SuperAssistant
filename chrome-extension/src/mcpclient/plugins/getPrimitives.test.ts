/**
 * Tests for transport plugin getPrimitives capability fallback behavior.
 *
 * Test matrix covers the capability gate logic added in PR #35:
 * - When server capabilities are empty/missing → "probing" mode:
 *   attempt all list ops with .catch() (Method not found is expected)
 * - When capabilities explicitly declare a type → normal mode:
 *   call the list method without .catch() (errors should propagate)
 * - When capabilities declare SOME types → only declared types use normal path,
 *   undeclared types are skipped (NOT probed)
 *
 * Run: node --test --experimental-strip-types getPrimitives.test.ts
 * (from chrome-extension/src/mcpclient/plugins/ directory)
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

// ──────────────────────────────────────────────
// Test helper: simulate the capability gate logic
// ──────────────────────────────────────────────

interface MockCapabilities {
  tools?: Record<string, unknown>;
  resources?: Record<string, unknown>;
  prompts?: Record<string, unknown>;
}

/**
 * Reproduces the capability gate logic from the plugin getPrimitives methods.
 * Returns { attempted, probing } — whether the list op is attempted,
 * and whether it's in probing mode (errors caught) vs normal (errors propagate).
 */
function getListBehavior(
  capabilities: MockCapabilities | undefined | null,
  type: 'tools' | 'resources' | 'prompts',
): { attempted: boolean; probing: boolean } {
  const isProbing = !capabilities || Object.keys(capabilities as object).length === 0;

  if (capabilities?.[type] || isProbing) {
    return { attempted: true, probing: isProbing };
  }
  return { attempted: false, probing: false };
}

// ──────────────────────────────────────────────
// Test Matrix
// ──────────────────────────────────────────────

describe('getPrimitives capability fallback', () => {
  describe('empty capabilities {} (proxy bug scenario) → probing mode', () => {
    const caps: MockCapabilities = {};

    test('should probe listTools (with catch)', () => {
      const b = getListBehavior(caps, 'tools');
      assert.equal(b.attempted, true);
      assert.equal(b.probing, true, 'should be probing mode (errors caught)');
    });

    test('should probe listResources (with catch)', () => {
      const b = getListBehavior(caps, 'resources');
      assert.equal(b.attempted, true);
      assert.equal(b.probing, true);
    });

    test('should probe listPrompts (with catch)', () => {
      const b = getListBehavior(caps, 'prompts');
      assert.equal(b.attempted, true);
      assert.equal(b.probing, true);
    });
  });

  describe('null capabilities → probing mode', () => {
    const caps = null;

    test('should probe listTools', () => {
      const b = getListBehavior(caps, 'tools');
      assert.equal(b.attempted, true);
      assert.equal(b.probing, true);
    });

    test('should probe listResources', () => {
      const b = getListBehavior(caps, 'resources');
      assert.equal(b.attempted, true);
      assert.equal(b.probing, true);
    });

    test('should probe listPrompts', () => {
      const b = getListBehavior(caps, 'prompts');
      assert.equal(b.attempted, true);
      assert.equal(b.probing, true);
    });
  });

  describe('undefined capabilities → probing mode', () => {
    const caps = undefined;

    test('should probe listTools', () => {
      const b = getListBehavior(caps, 'tools');
      assert.equal(b.attempted, true);
      assert.equal(b.probing, true);
    });

    test('should probe listResources', () => {
      const b = getListBehavior(caps, 'resources');
      assert.equal(b.attempted, true);
      assert.equal(b.probing, true);
    });

    test('should probe listPrompts', () => {
      const b = getListBehavior(caps, 'prompts');
      assert.equal(b.attempted, true);
      assert.equal(b.probing, true);
    });
  });

  describe('full capabilities { tools: {}, resources: {}, prompts: {} } → normal mode', () => {
    const caps: MockCapabilities = { tools: {}, resources: {}, prompts: {} };

    test('should call listTools (errors propagate)', () => {
      const b = getListBehavior(caps, 'tools');
      assert.equal(b.attempted, true);
      assert.equal(b.probing, false, 'errors should propagate in normal mode');
    });

    test('should call listResources (errors propagate)', () => {
      const b = getListBehavior(caps, 'resources');
      assert.equal(b.attempted, true);
      assert.equal(b.probing, false);
    });

    test('should call listPrompts (errors propagate)', () => {
      const b = getListBehavior(caps, 'prompts');
      assert.equal(b.attempted, true);
      assert.equal(b.probing, false);
    });
  });

  describe('partial capabilities { tools: {} } only → normal for tools, skip others', () => {
    const caps: MockCapabilities = { tools: {} };

    test('should call listTools (errors propagate)', () => {
      const b = getListBehavior(caps, 'tools');
      assert.equal(b.attempted, true);
      assert.equal(b.probing, false);
    });

    test('should skip listResources (not declared, caps non-empty)', () => {
      const b = getListBehavior(caps, 'resources');
      assert.equal(b.attempted, false);
    });

    test('should skip listPrompts (not declared, caps non-empty)', () => {
      const b = getListBehavior(caps, 'prompts');
      assert.equal(b.attempted, false);
    });
  });

  describe('partial capabilities { resources: {}, prompts: {} } (no tools)', () => {
    const caps: MockCapabilities = { resources: {}, prompts: {} };

    test('should skip listTools (not declared, caps non-empty)', () => {
      const b = getListBehavior(caps, 'tools');
      assert.equal(b.attempted, false);
    });

    test('should call listResources (errors propagate)', () => {
      const b = getListBehavior(caps, 'resources');
      assert.equal(b.attempted, true);
      assert.equal(b.probing, false);
    });

    test('should call listPrompts (errors propagate)', () => {
      const b = getListBehavior(caps, 'prompts');
      assert.equal(b.attempted, true);
      assert.equal(b.probing, false);
    });
  });

  describe('capabilities with extra properties { tools: {}, logging: {} }', () => {
    const caps = { tools: {}, logging: {} } as MockCapabilities;

    test('should call listTools (errors propagate)', () => {
      const b = getListBehavior(caps, 'tools');
      assert.equal(b.attempted, true);
      assert.equal(b.probing, false);
    });

    test('should skip listResources', () => {
      const b = getListBehavior(caps, 'resources');
      assert.equal(b.attempted, false);
    });

    test('should skip listPrompts', () => {
      const b = getListBehavior(caps, 'prompts');
      assert.equal(b.attempted, false);
    });
  });
});

// ──────────────────────────────────────────────
// Edge cases
// ──────────────────────────────────────────────

describe('getPrimitives edge cases', () => {
  test('capabilities with tools explicitly set to empty {} → truthy, normal mode', () => {
    const caps: MockCapabilities = { tools: {} };
    const b = getListBehavior(caps, 'tools');
    // {} is truthy in JS, so capabilities?.tools is truthy → attempted in normal mode
    // But wait: {} is truthy? Let me verify:
    // Boolean({}) === true. Yes.
    assert.equal(b.attempted, true);
    assert.equal(b.probing, false);
  });

  test('capabilities with tools set to null → falsy, skipped (caps non-empty)', () => {
    // { tools: null } — Object.keys has length 1, not empty → isProbing=false
    // capabilities?.tools is null → falsy → not attempted
    const caps = { tools: null } as unknown as MockCapabilities;
    const b = getListBehavior(caps, 'tools');
    assert.equal(b.attempted, false);
  });

  test('capabilities with tools set to false → falsy, skipped (caps non-empty)', () => {
    const caps = { tools: false } as unknown as MockCapabilities;
    const b = getListBehavior(caps, 'tools');
    assert.equal(b.attempted, false);
  });

  test('capabilities with tools set to undefined → falsy, skipped (caps non-empty)', () => {
    const caps = { tools: undefined } as unknown as MockCapabilities;
    const b = getListBehavior(caps, 'tools');
    assert.equal(b.attempted, false);
  });
});
