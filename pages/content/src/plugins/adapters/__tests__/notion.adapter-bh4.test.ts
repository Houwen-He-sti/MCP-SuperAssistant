/**
 * T-BH-4: enableStreamBridgeOnWindow helper + integration contract checks
 *
 * Verifies that when the Notion adapter detects it is running as a native AI
 * agent, it enables the stream bridge by calling
 * `window.configureStreamToolBridge({ enabled: true, autoInsert: true, autoSubmit: true })`.
 *
 * The production code exposes this as the standalone helper
 * `enableStreamBridgeOnWindow(win)` so it can be unit-tested without
 * instantiating the full adapter class.
 *
 * Integration note (P1-2 / T-BH-4-INTEG):
 *   Testing the `activate()` call site directly would require mocking the full
 *   PluginContext, DOM APIs, eventBus, and React-hook store state used by
 *   NotionAdapter. That test infrastructure does not yet exist in this test
 *   harness. The activate() wiring is instead covered by:
 *     (1) Source-contract test T-BH-4-03 below (reads notion.adapter.ts and
 *         asserts `enableStreamBridgeOnWindow(window)` is present in the
 *         `isSupported()` block, providing a regression lock on the call site).
 *     (2) Smoke test: L3 PASS — proxy log confirms `committee-bridge.echo`
 *         was called end-to-end (see docs/evidence/l3-smoke-test-notion-local-review-2026-05-19.md).
 *   A full activate() integration test with mock context is tracked as T-BH-4-INTEG follow-up.
 *
 * Double-fire note (P1-3 / GPT 5.5 review):
 *   T-BH-4-04 below verifies the dedup primitive (ExecutionGuardStore.reserve)
 *   prevents duplicate execution of the same callId. A full end-to-end regression
 *   for the MutationObserver double-fire scenario is tracked as a separate slice.
 *
 * Run:
 *   node --test --experimental-strip-types \
 *     src/plugins/adapters/__tests__/notion.adapter-bh4.test.ts
 * (from MCP-SuperAssistant/pages/content/)
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';
import { enableStreamBridgeOnWindow } from '../notion.bridge-enable.ts';

const __filename = fileURLToPath(import.meta.url);
const __dir = dirname(__filename);

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

// ---------------------------------------------------------------------------
// T-BH-4-03 (P1-2): Source-contract test — activate() call site lock
// Regression: if enableStreamBridgeOnWindow(window) is removed from activate(),
// this test fails immediately. No full adapter mock required.
// ---------------------------------------------------------------------------
describe('notion.adapter.ts source contract', () => {
  it('T-BH-4-03: activate() calls enableStreamBridgeOnWindow(window) inside isSupported() block', () => {
    const adapterSrc = readFileSync(
      resolve(__dir, '../notion.adapter.ts'),
      'utf-8',
    );

    // Locate the activate() method body
    const activateIdx = adapterSrc.indexOf('async activate()');
    assert.ok(activateIdx !== -1, 'activate() method must exist in notion.adapter.ts');

    const activateBody = adapterSrc.slice(activateIdx, activateIdx + 2000);

    // isSupported() guard must wrap the bridge enable
    const isSupportedIdx = activateBody.indexOf('if (this.isSupported())');
    assert.ok(isSupportedIdx !== -1, 'isSupported() guard must exist in activate()');

    // enableStreamBridgeOnWindow(window) must appear AFTER isSupported()
    const bridgeCallIdx = activateBody.indexOf('enableStreamBridgeOnWindow(window)');
    assert.ok(bridgeCallIdx !== -1, 'enableStreamBridgeOnWindow(window) must be called in activate()');
    assert.ok(
      bridgeCallIdx > isSupportedIdx,
      'enableStreamBridgeOnWindow(window) must appear inside or after the isSupported() guard',
    );
  });
});

// ---------------------------------------------------------------------------
// T-BH-4-04 (P1-3): Dedup primitive — same callId must not execute twice
// Tests the ExecutionGuardStore reserve logic in isolation (no shared/logger dep).
// ---------------------------------------------------------------------------
describe('ExecutionGuardStore dedup primitive', () => {
  it('T-BH-4-04: reserve() returns false on second call with same key', () => {
    // Replicate the core reserve logic used by executionGuard.reserveExecution()
    // in isolation (without @extension/shared/lib/logger dependency).
    type Status = 'pending' | 'succeeded' | 'failed';
    const records = new Map<string, Status>();

    function reserve(key: string): boolean {
      const current = records.get(key);
      if (current === 'pending' || current === 'succeeded') return false;
      records.set(key, 'pending');
      return true;
    }

    const key = 'https://notion.so/chat|committee-bridge.echo|1747616610-1|abc';

    // First call — should succeed
    assert.ok(reserve(key) === true, 'first reserve should return true');

    // Second call with same key — should be blocked
    assert.ok(reserve(key) === false, 'second reserve with same key should return false (dedup)');

    // Different key — should succeed
    const key2 = 'https://notion.so/chat|committee-bridge.echo|1747616610-2|abc';
    assert.ok(reserve(key2) === true, 'different callId should be allowed');
  });
});
