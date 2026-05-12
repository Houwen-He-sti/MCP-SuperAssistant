import assert from 'node:assert/strict';
import test from 'node:test';

import {
    isNotionSubmitButtonReady,
    waitForSubmitButtonAndClick,
    type NotionSubmitButtonLike,
    type SubmitContext
} from '../notion/submit-readiness.ts';

function createMockButton(attrs: Record<string, string | null>, isConnected: boolean = true) {
    let clickCount = 0;
    return {
        isConnected,
        getAttribute: (name: string) => attrs[name] ?? null,
        click: () => { clickCount++; },
        getClickCount: () => clickCount
    };
}

test('P0-1: disabled snapshot must NOT be clicked', async () => {
    const disabledButton = createMockButton({ 'aria-disabled': 'true' }, true);

    let clickTries = 0;

    const context: SubmitContext<NotionSubmitButtonLike> = {
        getSubmitButton: () => disabledButton,
        isSubmitButtonReady: isNotionSubmitButtonReady,
        clickSubmitButton: (b) => { clickTries++; (b as any).click(); },
        sleep: async () => { }, // instant
    };

    const result = await waitForSubmitButtonAndClick(context, {
        maxAttempts: 3,
        intervalMs: 10,
    });

    assert.equal(result.ok, false);
    assert.equal((result as any).reason, 'button_disabled');
    assert.equal(clickTries, 0);
    assert.equal(disabledButton.getClickCount(), 0);
});

test('P0-2: enabled snapshot MUST be clicked once', async () => {
    // observed E2E: aria-disabled is null/missing
    const enabledButton = createMockButton({ 'aria-disabled': null }, true);

    let clickTries = 0;

    const context: SubmitContext<NotionSubmitButtonLike> = {
        getSubmitButton: () => enabledButton,
        isSubmitButtonReady: isNotionSubmitButtonReady,
        clickSubmitButton: (b) => { clickTries++; (b as any).click(); },
        sleep: async () => { }, // instant
    };

    const result = await waitForSubmitButtonAndClick(context, {
        maxAttempts: 3,
        intervalMs: 10,
    });

    assert.equal(result.ok, true);
    assert.equal((result as any).attempts, 1);
    assert.equal(clickTries, 1);
    assert.equal(enabledButton.getClickCount(), 1);
});

test('P0-3: React node replacement - must click new node and not old node', async () => {
    const oldDetachedNode = createMockButton({ 'aria-disabled': 'true' }, false);
    const newEnabledNode = createMockButton({ 'aria-disabled': null }, true);

    let attempts = 0;

    const context: SubmitContext<NotionSubmitButtonLike> = {
        getSubmitButton: () => {
            attempts++;
            return attempts === 1 ? oldDetachedNode : newEnabledNode;
        },
        isSubmitButtonReady: isNotionSubmitButtonReady,
        clickSubmitButton: (b) => { (b as any).click(); },
        sleep: async () => { }, // instant
    };

    const result = await waitForSubmitButtonAndClick(context, {
        maxAttempts: 5,
        intervalMs: 10,
    });

    assert.equal(result.ok, true);
    assert.equal((result as any).attempts, 2);

    assert.equal(oldDetachedNode.getClickCount(), 0);
    assert.equal(newEnabledNode.getClickCount(), 1);
});

test('P1-1: detached node must NOT be clicked', async () => {
    // Even if it has no aria-disabled, if it's detached it shouldn't click
    const detachedEnabledButton = createMockButton({ 'aria-disabled': null }, false);

    const context: SubmitContext<NotionSubmitButtonLike> = {
        getSubmitButton: () => detachedEnabledButton,
        isSubmitButtonReady: isNotionSubmitButtonReady,
        clickSubmitButton: (b) => { (b as any).click(); },
        sleep: async () => { }, // instant
    };

    const result = await waitForSubmitButtonAndClick(context, {
        maxAttempts: 3,
        intervalMs: 10,
    });

    assert.equal(result.ok, false);
    // Might return button_disabled or similar based on logic, but shouldn't be clicked
    assert.equal(detachedEnabledButton.getClickCount(), 0);
});
