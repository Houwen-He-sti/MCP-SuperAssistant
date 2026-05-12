import assert from 'node:assert/strict';
import test from 'node:test';

import { createNotionSubmitContext } from '../notion/submit-context.ts';
import { waitForSubmitButtonAndClick } from '../notion/submit-readiness.ts';

function createMockElement(options: {
  ariaDisabled: string | null;
  isConnected: boolean;
  width?: number;
  height?: number;
}) {
  let clickCount = 0;

  return {
    isConnected: options.isConnected,
    disabled: false,
    getAttribute: (name: string) =>
      name === 'aria-disabled' ? options.ariaDisabled : null,
    getBoundingClientRect: () => ({
      width: options.width ?? 10,
      height: options.height ?? 10,
    }),
    click: () => {
      clickCount++;
    },
    getClickCount: () => clickCount,
  } as any as HTMLElement & { getClickCount(): number };
}

test('adapter submit context re-queries and clicks replacement node only', async () => {
  const oldDetached = createMockElement({
    ariaDisabled: 'true',
    isConnected: false,
  });

  const newEnabled = createMockElement({
    ariaDisabled: null,
    isConnected: true,
  });

  let queryCount = 0;
  const getButton = () => {
    queryCount++;
    return queryCount === 1 ? oldDetached : newEnabled;
  };

  const context = createNotionSubmitContext(getButton, {
    getComputedStyle: () => ({ pointerEvents: 'auto' }) as any,
    sleep: (ms) => Promise.resolve(), // fast fail internally
  });

  const result = await waitForSubmitButtonAndClick(context, {
    maxAttempts: 3,
    intervalMs: 0,
  });

  assert.equal(result.ok, true);
  assert.equal(result.attempts, 2);
  assert.equal(queryCount, 2);
  assert.equal(oldDetached.getClickCount(), 0);
  assert.equal(newEnabled.getClickCount(), 1);
});

