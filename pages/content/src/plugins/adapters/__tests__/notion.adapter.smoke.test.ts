/**
 * Smoke Tests for NotionAdapter route functions.
 * Imports actual production code — quick sanity checks.
 *
 * Run: node --test --experimental-strip-types src/plugins/adapters/__tests__/notion.adapter.smoke.test.ts
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
    isNativeAiRoute,
    shouldInjectBridgePrompt
} from '../notion.routes.ts';

describe('NotionAdapter Smoke Tests', () => {
    

    describe('isNativeAiRoute()', () => {
        it('should return true for workspace page', () => {
            assert.equal(isNativeAiRoute('/workspace/test'), true);
        });

        

        it('should return true for /chat (native agent route)', () => {
            assert.equal(isNativeAiRoute('/chat'), true);
        });
    });

    describe('shouldInjectBridgePrompt()', () => {
        it('should inject on first conversation with empty input', () => {
            assert.equal(shouldInjectBridgePrompt(true, false, 0, ''), true);
        });

        it('should NOT inject when input has content', () => {
            assert.equal(shouldInjectBridgePrompt(true, false, 0, 'draft'), false);
        });

        it('should NOT inject on second conversation', () => {
            assert.equal(shouldInjectBridgePrompt(true, false, 1, ''), false);
        });
    });

    describe('Conversation counting', () => {
        it('should increment count after submit on native agent', () => {
            let count = 0;
            const isNative = isNativeAiRoute('/chat');
            if (isNative) count++;
            assert.equal(count, 1);
        });

        
    });
});
