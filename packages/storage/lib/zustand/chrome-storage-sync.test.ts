/**
 * Tests for subscribeChromeStorageRehydrate.
 *
 * Contract: subscribes to chrome.storage.onChanged for a specific key+area.
 * When a matching change event fires, calls store.persist.rehydrate().
 * Returns an unsubscribe function.
 *
 * Run: node --test --experimental-strip-types chrome-storage-sync.test.ts
 * (from packages/storage/lib/zustand/ directory)
 */

import assert from 'node:assert/strict';
import { describe, test, beforeEach } from 'node:test';

// ─── Mock chrome.storage.onChanged ───────────────────────────────────────────

type OnChangedListener = (
  changes: Record<string, { oldValue?: unknown; newValue?: unknown }>,
  areaName: string,
) => void;

let listeners: OnChangedListener[] = [];

const mockOnChanged = {
  addListener: (listener: OnChangedListener) => {
    listeners.push(listener);
  },
  removeListener: (listener: OnChangedListener) => {
    listeners = listeners.filter(l => l !== listener);
  },
};

function fireOnChanged(
  changes: Record<string, { oldValue?: unknown; newValue?: unknown }>,
  areaName: string,
): void {
  for (const l of listeners) l(changes, areaName);
}

(globalThis as Record<string, unknown>).chrome = {
  storage: {
    local: {},
    onChanged: mockOnChanged,
  },
};

// ─── Import after mocks are installed ─────────────────────────────────────────

import { subscribeChromeStorageRehydrate } from './chrome-storage-sync.ts';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeStore(key = 'test-store-key') {
  let rehydrateCalls = 0;
  const store = {
    persist: {
      rehydrate: async () => {
        rehydrateCalls++;
      },
    },
  };
  return { store, key, getRehydrateCalls: () => rehydrateCalls };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

beforeEach(() => {
  listeners = [];
});

describe('subscribeChromeStorageRehydrate — basic behavior', () => {
  test('calls rehydrate when matching key changes in matching area', async () => {
    const { store, key, getRehydrateCalls } = makeStore('ui-store');
    subscribeChromeStorageRehydrate({ key, store });

    fireOnChanged({ [key]: { oldValue: 'old', newValue: 'new' } }, 'local');
    // Allow async rehydrate to settle
    await new Promise(r => setTimeout(r, 10));

    assert.equal(getRehydrateCalls(), 1);
  });

  test('does NOT call rehydrate for a different key', async () => {
    const { store, getRehydrateCalls } = makeStore('ui-store');
    subscribeChromeStorageRehydrate({ key: 'ui-store', store });

    fireOnChanged({ 'config-store': { newValue: 'x' } }, 'local');
    await new Promise(r => setTimeout(r, 10));

    assert.equal(getRehydrateCalls(), 0);
  });

  test('does NOT call rehydrate for a different area (sync vs local)', async () => {
    const { store, key, getRehydrateCalls } = makeStore('ui-store');
    subscribeChromeStorageRehydrate({ key, store }); // default area = 'local'

    fireOnChanged({ [key]: { newValue: 'x' } }, 'sync');
    await new Promise(r => setTimeout(r, 10));

    assert.equal(getRehydrateCalls(), 0);
  });

  test('calls rehydrate once per matching change event', async () => {
    const { store, key, getRehydrateCalls } = makeStore('ui-store');
    subscribeChromeStorageRehydrate({ key, store });

    fireOnChanged({ [key]: { newValue: 'a' } }, 'local');
    fireOnChanged({ [key]: { newValue: 'b' } }, 'local');
    await new Promise(r => setTimeout(r, 20));

    assert.equal(getRehydrateCalls(), 2);
  });
});

describe('subscribeChromeStorageRehydrate — unsubscribe', () => {
  test('unsubscribe removes listener: no more rehydrate calls after unsubscribe', async () => {
    const { store, key, getRehydrateCalls } = makeStore('ui-store');
    const unsubscribe = subscribeChromeStorageRehydrate({ key, store });

    fireOnChanged({ [key]: { newValue: 'before-unsub' } }, 'local');
    await new Promise(r => setTimeout(r, 10));
    assert.equal(getRehydrateCalls(), 1);

    unsubscribe();

    fireOnChanged({ [key]: { newValue: 'after-unsub' } }, 'local');
    await new Promise(r => setTimeout(r, 10));
    assert.equal(getRehydrateCalls(), 1, 'should not rehydrate after unsubscribe');
  });

  test('returns an unsubscribe function', () => {
    const { store, key } = makeStore('ui-store');
    const unsubscribe = subscribeChromeStorageRehydrate({ key, store });
    assert.equal(typeof unsubscribe, 'function');
  });
});

describe('subscribeChromeStorageRehydrate — environment safety', () => {
  test('no-op (returns no-op unsubscribe) when chrome.storage.onChanged is not available', () => {
    const saved = (globalThis as Record<string, unknown>).chrome;
    delete (globalThis as Record<string, unknown>).chrome;
    try {
      const { store, key } = makeStore();
      // Should not throw
      const unsubscribe = subscribeChromeStorageRehydrate({ key, store });
      assert.equal(typeof unsubscribe, 'function');
      unsubscribe(); // Should not throw
    } finally {
      (globalThis as Record<string, unknown>).chrome = saved;
    }
  });

  test('multiple subscriptions to the same key are independent', async () => {
    const a = makeStore('shared-key');
    const b = makeStore('shared-key');
    const unsubA = subscribeChromeStorageRehydrate({ key: a.key, store: a.store });
    subscribeChromeStorageRehydrate({ key: b.key, store: b.store });

    fireOnChanged({ 'shared-key': { newValue: 'x' } }, 'local');
    await new Promise(r => setTimeout(r, 10));
    assert.equal(a.getRehydrateCalls(), 1);
    assert.equal(b.getRehydrateCalls(), 1);

    unsubA();
    fireOnChanged({ 'shared-key': { newValue: 'y' } }, 'local');
    await new Promise(r => setTimeout(r, 10));
    assert.equal(a.getRehydrateCalls(), 1, 'A should not rehydrate after its unsubscribe');
    assert.equal(b.getRehydrateCalls(), 2, 'B should still rehydrate');
  });
});
