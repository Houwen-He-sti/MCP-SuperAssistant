/**
 * Tests for transport plugin getPrimitives capability fallback behavior.
 *
 * Test matrix covers the capability gate logic added in PR #35:
 * When server capabilities are empty ({}) or missing, plugins should
 * still attempt listTools/listResources/listPrompts with error catching.
 *
 * Run: node --test --experimental-strip-types getPrimitives.test.ts
 * (from chrome-extension/src/mcpclient/plugins/ directory)
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

// ──────────────────────────────────────────────
// Test helper: simulate the capability fallback logic
// extracted from SSEPlugin/WebSocketPlugin/StreamableHttpPlugin
// ──────────────────────────────────────────────

interface MockCapabilities {
  tools?: Record<string, unknown>;
  resources?: Record<string, unknown>;
  prompts?: Record<string, unknown>;
}

/**
 * Reproduces the capability gate logic from the plugin getPrimitives methods.
 * Returns which list operations would be attempted.
 */
function shouldAttemptList(
  capabilities: MockCapabilities | undefined | null,
  type: 'tools' | 'resources' | 'prompts',
): boolean {
  // This mirrors the actual condition in the plugin code:
  // capabilities?.[type] !== undefined || !capabilities || Object.keys(capabilities).length === 0
  return (
    capabilities?.[type] !== undefined ||
    !capabilities ||
    Object.keys(capabilities as object).length === 0
  );
}

// ──────────────────────────────────────────────
// Test Matrix
// ──────────────────────────────────────────────

describe('getPrimitives capability fallback', () => {
  describe('empty capabilities {} (proxy bug scenario)', () => {
    const caps: MockCapabilities = {};

    test('should attempt listTools', () => {
      assert.equal(shouldAttemptList(caps, 'tools'), true);
    });

    test('should attempt listResources', () => {
      assert.equal(shouldAttemptList(caps, 'resources'), true);
    });

    test('should attempt listPrompts', () => {
      assert.equal(shouldAttemptList(caps, 'prompts'), true);
    });
  });

  describe('null capabilities', () => {
    const caps = null;

    test('should attempt listTools', () => {
      assert.equal(shouldAttemptList(caps, 'tools'), true);
    });

    test('should attempt listResources', () => {
      assert.equal(shouldAttemptList(caps, 'resources'), true);
    });

    test('should attempt listPrompts', () => {
      assert.equal(shouldAttemptList(caps, 'prompts'), true);
    });
  });

  describe('undefined capabilities', () => {
    const caps = undefined;

    test('should attempt listTools', () => {
      assert.equal(shouldAttemptList(caps, 'tools'), true);
    });

    test('should attempt listResources', () => {
      assert.equal(shouldAttemptList(caps, 'resources'), true);
    });

    test('should attempt listPrompts', () => {
      assert.equal(shouldAttemptList(caps, 'prompts'), true);
    });
  });

  describe('full capabilities { tools: {}, resources: {}, prompts: {} }', () => {
    const caps: MockCapabilities = { tools: {}, resources: {}, prompts: {} };

    test('should attempt listTools', () => {
      assert.equal(shouldAttemptList(caps, 'tools'), true);
    });

    test('should attempt listResources', () => {
      assert.equal(shouldAttemptList(caps, 'resources'), true);
    });

    test('should attempt listPrompts', () => {
      assert.equal(shouldAttemptList(caps, 'prompts'), true);
    });
  });

  describe('partial capabilities { tools: {} } only', () => {
    const caps: MockCapabilities = { tools: {} };

    test('should attempt listTools (declared)', () => {
      assert.equal(shouldAttemptList(caps, 'tools'), true);
    });

    test('should NOT attempt listResources (not declared, caps non-empty)', () => {
      assert.equal(shouldAttemptList(caps, 'resources'), false);
    });

    test('should NOT attempt listPrompts (not declared, caps non-empty)', () => {
      assert.equal(shouldAttemptList(caps, 'prompts'), false);
    });
  });

  describe('partial capabilities { resources: {}, prompts: {} } (no tools)', () => {
    const caps: MockCapabilities = { resources: {}, prompts: {} };

    test('should NOT attempt listTools (not declared, caps non-empty)', () => {
      assert.equal(shouldAttemptList(caps, 'tools'), false);
    });

    test('should attempt listResources (declared)', () => {
      assert.equal(shouldAttemptList(caps, 'resources'), true);
    });

    test('should attempt listPrompts (declared)', () => {
      assert.equal(shouldAttemptList(caps, 'prompts'), true);
    });
  });

  describe('capabilities with extra properties { tools: {}, logging: {} }', () => {
    const caps = { tools: {}, logging: {} } as MockCapabilities;

    test('should attempt listTools (declared)', () => {
      assert.equal(shouldAttemptList(caps, 'tools'), true);
    });

    test('should NOT attempt listResources (not declared, caps non-empty)', () => {
      assert.equal(shouldAttemptList(caps, 'resources'), false);
    });

    test('should NOT attempt listPrompts (not declared, caps non-empty)', () => {
      assert.equal(shouldAttemptList(caps, 'prompts'), false);
    });
  });
});

// ──────────────────────────────────────────────
// Edge cases
// ──────────────────────────────────────────────

describe('getPrimitives edge cases', () => {
  test('capabilities with tools explicitly set to undefined', () => {
    // { tools: undefined } — tools key exists but value is undefined
    // Object.keys({tools: undefined}).length === 1, so caps is non-empty
    // capabilities?.tools is undefined, so !== undefined is false
    // Therefore should NOT attempt — this is correct because the server
    // explicitly listed the key but gave it no value
    const caps = { tools: undefined } as unknown as MockCapabilities;
    // Object.keys has length 1, so not empty
    // caps?.tools is undefined, so !== undefined is false
    // !caps is false
    assert.equal(shouldAttemptList(caps, 'tools'), false);
  });

  test('capabilities with tools set to null', () => {
    // { tools: null } — tools key exists with null value
    // capabilities?.tools is null, which !== undefined is true
    const caps = { tools: null } as unknown as MockCapabilities;
    assert.equal(shouldAttemptList(caps, 'tools'), true);
  });

  test('capabilities with tools set to false', () => {
    // { tools: false } — non-standard but possible
    // capabilities?.tools is false, which !== undefined is true
    const caps = { tools: false } as unknown as MockCapabilities;
    assert.equal(shouldAttemptList(caps, 'tools'), true);
  });
});
