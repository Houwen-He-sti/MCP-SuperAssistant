import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { deriveStoredBridgeConfig } from './streamToolBridgeConfig.ts';

describe('deriveStoredBridgeConfig', () => {
  test('enables execution only when MCP and autoExecute are both true', () => {
    assert.deepStrictEqual(deriveStoredBridgeConfig({ mcpEnabled: true, preferences: { autoExecute: true } }), {
      enabled: true,
      cutoffEnabled: true,
    });
    assert.deepStrictEqual(deriveStoredBridgeConfig({ mcpEnabled: true, preferences: { autoExecute: false } }), {
      enabled: false,
      cutoffEnabled: true,
    });
    assert.deepStrictEqual(deriveStoredBridgeConfig({ mcpEnabled: false, preferences: { autoExecute: true } }), {
      enabled: false,
      cutoffEnabled: false,
    });
  });

  test('copies only boolean insert and submit preferences', () => {
    assert.deepStrictEqual(
      deriveStoredBridgeConfig({
        mcpEnabled: true,
        preferences: { autoExecute: true, autoInsert: false, autoSubmit: true },
      }),
      { enabled: true, cutoffEnabled: true, autoInsert: false, autoSubmit: true },
    );
    assert.deepStrictEqual(
      deriveStoredBridgeConfig({
        mcpEnabled: true,
        preferences: { autoExecute: true, autoInsert: 'false', autoSubmit: null },
      }),
      { enabled: true, cutoffEnabled: true },
    );
  });
});
