/**
 * T-BH-4: enableStreamBridgeOnWindow helper
 *
 * Verifies that when the Notion adapter detects it is running as a native AI
 * agent, it enables the stream bridge by calling
 * `window.configureStreamToolBridge({ enabled: true, autoInsert: true, autoSubmit: true })`.
 *
 * The production code exposes this as the standalone helper
 * `enableStreamBridgeOnWindow(win)` so it can be unit-tested without
 * instantiating the full adapter class.
 *
 * Run:
 *   node --test --experimental-strip-types \
 *     src/plugins/adapters/__tests__/notion.adapter-bh4.test.ts
 * (from MCP-SuperAssistant/pages/content/)
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { enableStreamBridgeOnWindow } from '../notion.bridge-enable.ts';

// ---------------------------------------------------------------------------
// T-BH-4-01: configureStreamToolBridge is called with expected config
// ---------------------------------------------------------------------------
describe('enableStreamBridgeOnWindow()', () => {
  it('T-BH-4-01: calls window.configureStreamToolBridge with enabled=true autoInsert=true autoSubmit=true', () => {
    let captured: object | undefined;
    const fakeWin = {
      configureStreamToolBridge: (cfg: object) => {
        captured = cfg;
      },
    } as unknown as typeof window;

    enableStreamBridgeOnWindow(fakeWin);

    assert.deepEqual(captured, { enabled: true, autoInsert: true, autoSubmit: true });
  });

  it('T-BH-4-02: does NOT throw when configureStreamToolBridge is absent (graceful no-op)', () => {
    const fakeWin = {} as unknown as typeof window;
    // Should not throw
    assert.doesNotThrow(() => enableStreamBridgeOnWindow(fakeWin));
  });
});
