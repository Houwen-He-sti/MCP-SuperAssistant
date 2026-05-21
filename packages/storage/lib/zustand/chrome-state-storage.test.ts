/**
 * Tests for createChromeStorageStateStorage.
 *
 * Contract: Implements Zustand StateStorage interface backed by
 * chrome.storage.local (async). Supports optional conservative migration
 * from localStorage on first read (copy-on-first-access, no delete).
 *
 * Run: node --test --experimental-strip-types chrome-state-storage.test.ts
 * (from packages/storage/lib/zustand/ directory)
 */

import assert from 'node:assert/strict';
import { describe, test, beforeEach } from 'node:test';

// ─── Mock chrome.storage.local ────────────────────────────────────────────────

let mockChromeStore: Record<string, string> = {};
let mockLocalStore: Record<string, string> = {};

const mockChromeStorageLocal = {
  get: async (keys: string | string[]): Promise<Record<string, string>> => {
    const keyArr = typeof keys === 'string' ? [keys] : keys;
    const result: Record<string, string> = {};
    for (const key of keyArr) {
      if (key in mockChromeStore) result[key] = mockChromeStore[key];
    }
    return result;
  },
  set: async (items: Record<string, string>): Promise<void> => {
    Object.assign(mockChromeStore, items);
  },
  remove: async (keys: string | string[]): Promise<void> => {
    const keyArr = typeof keys === 'string' ? [keys] : keys;
    for (const key of keyArr) delete mockChromeStore[key];
  },
};

const mockLocalStorage = {
  getItem: (key: string): string | null => mockLocalStore[key] ?? null,
  setItem: (key: string, value: string): void => { mockLocalStore[key] = value; },
  removeItem: (key: string): void => { delete mockLocalStore[key]; },
  clear: (): void => { mockLocalStore = {}; },
};

// Install mocks before importing
(globalThis as Record<string, unknown>).chrome = {
  storage: {
    local: mockChromeStorageLocal,
    onChanged: {
      addListener: () => {},
      removeListener: () => {},
    },
  },
};
(globalThis as Record<string, unknown>).localStorage = mockLocalStorage;

// ─── Import after mocks are installed ─────────────────────────────────────────

import { createChromeStorageStateStorage } from './chrome-state-storage.ts';

// ─── Tests ────────────────────────────────────────────────────────────────────

beforeEach(() => {
  mockChromeStore = {};
  mockLocalStore = {};
});

describe('createChromeStorageStateStorage — basic CRUD', () => {
  test('getItem: returns null when key not found', async () => {
    const storage = createChromeStorageStateStorage();
    const result = await storage.getItem('missing-key');
    assert.equal(result, null);
  });

  test('setItem + getItem: round-trip stores and retrieves string value', async () => {
    const storage = createChromeStorageStateStorage();
    await storage.setItem('my-key', '{"value":42}');
    const result = await storage.getItem('my-key');
    assert.equal(result, '{"value":42}');
  });

  test('removeItem: deletes existing key', async () => {
    const storage = createChromeStorageStateStorage();
    await storage.setItem('my-key', 'hello');
    await storage.removeItem('my-key');
    const result = await storage.getItem('my-key');
    assert.equal(result, null);
  });

  test('removeItem: no-op when key does not exist', async () => {
    const storage = createChromeStorageStateStorage();
    // Should not throw
    await storage.removeItem('ghost-key');
  });

  test('multiple keys are independent', async () => {
    const storage = createChromeStorageStateStorage();
    await storage.setItem('key-a', 'alpha');
    await storage.setItem('key-b', 'beta');
    assert.equal(await storage.getItem('key-a'), 'alpha');
    assert.equal(await storage.getItem('key-b'), 'beta');
    await storage.removeItem('key-a');
    assert.equal(await storage.getItem('key-a'), null);
    assert.equal(await storage.getItem('key-b'), 'beta');
  });
});

describe('createChromeStorageStateStorage — migration from localStorage', () => {
  test('migration disabled by default: does not read localStorage', async () => {
    mockLocalStore['my-store'] = '{"from":"localStorage"}';
    const storage = createChromeStorageStateStorage(); // migrateFromLocalStorage not set
    const result = await storage.getItem('my-store');
    assert.equal(result, null, 'should not read localStorage when migration disabled');
  });

  test('migration: copies localStorage value to chrome.storage.local on first read', async () => {
    mockLocalStore['my-store'] = '{"migrated":true}';
    const storage = createChromeStorageStateStorage({ migrateFromLocalStorage: true });
    const result = await storage.getItem('my-store');
    assert.equal(result, '{"migrated":true}');
    // Verify it was actually written to chrome.storage.local
    assert.equal(mockChromeStore['my-store'], '{"migrated":true}');
  });

  test('migration: chrome.storage.local value takes priority over localStorage', async () => {
    mockChromeStore['my-store'] = '{"source":"chrome"}';
    mockLocalStore['my-store'] = '{"source":"local"}';
    const storage = createChromeStorageStateStorage({ migrateFromLocalStorage: true });
    const result = await storage.getItem('my-store');
    assert.equal(result, '{"source":"chrome"}', 'chrome.storage.local should take priority');
  });

  test('migration: does NOT delete localStorage value after migration', async () => {
    mockLocalStore['my-store'] = '{"migrated":true}';
    const storage = createChromeStorageStateStorage({ migrateFromLocalStorage: true });
    await storage.getItem('my-store');
    // localStorage must remain untouched (conservative migration)
    assert.equal(mockLocalStore['my-store'], '{"migrated":true}');
  });

  test('migration: returns null when both chrome.storage.local and localStorage are empty', async () => {
    const storage = createChromeStorageStateStorage({ migrateFromLocalStorage: true });
    const result = await storage.getItem('my-store');
    assert.equal(result, null);
  });

  test('migration: no-op when localStorage is not available (non-content-script context)', async () => {
    // Temporarily remove localStorage
    const saved = (globalThis as Record<string, unknown>).localStorage;
    delete (globalThis as Record<string, unknown>).localStorage;
    try {
      const storage = createChromeStorageStateStorage({ migrateFromLocalStorage: true });
      const result = await storage.getItem('my-store');
      assert.equal(result, null, 'should not crash without localStorage');
    } finally {
      (globalThis as Record<string, unknown>).localStorage = saved;
    }
  });
});
