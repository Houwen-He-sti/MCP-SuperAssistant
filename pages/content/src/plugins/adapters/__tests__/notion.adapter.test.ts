/**
 * Tests for NotionAdapter pure route functions.
 * Imports actual production code — not copied expressions.
 *
 * Run: node --test --experimental-transform-types src/plugins/adapters/__tests__/notion.adapter.test.ts
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
    isNativeAiRoute,
    isSupportedPath,
    shouldInjectBridgePrompt,
} from '../notion.routes.ts';

describe('NotionAdapter route functions', () => {
    

    describe('isNativeAiRoute()', () => {
        it('should return true for /chat path (native agent route)', () => {
            assert.equal(isNativeAiRoute('/chat'), true);
        });

        it('should return true for workspace page', () => {
            assert.equal(isNativeAiRoute('/workspace/test-page'), true);
        });

        

        

        
    });

    describe('isSupportedPath()', () => {
        

        it('should return true for /chat without native input', () => {
            assert.equal(isSupportedPath('/chat', false), true);
        });

        

        it('should return true for workspace page with native input', () => {
            assert.equal(isSupportedPath('/workspace/test', true), true);
        });

        it('should return false for workspace page without native input', () => {
            assert.equal(isSupportedPath('/workspace/test', false), false);
        });

        it('should return false for random path without native input', () => {
            assert.equal(isSupportedPath('/some-random-page', false), false);
        });

        it('should return true for random path with native input', () => {
            assert.equal(isSupportedPath('/some-random-page', true), true);
        });
    });

    describe('shouldInjectBridgePrompt()', () => {
        it('should inject on first conversation with empty input', () => {
            assert.equal(shouldInjectBridgePrompt(true, false, 0, ''), true);
        });

        it('should NOT inject when input has existing content', () => {
            assert.equal(shouldInjectBridgePrompt(true, false, 0, 'User draft'), false);
        });

        it('should NOT inject on second conversation', () => {
            assert.equal(shouldInjectBridgePrompt(true, false, 1, ''), false);
        });

        it('should NOT inject if already injected', () => {
            assert.equal(shouldInjectBridgePrompt(true, true, 0, ''), false);
        });

        

        it('should inject with whitespace-only input (treated as empty)', () => {
            assert.equal(shouldInjectBridgePrompt(true, false, 0, '   \n\t  '), true);
        });
    });
});
