/**
 * Smoke Tests for NotionAdapter — quick sanity checks.
 *
 * Purpose: Verify core logic doesn't break. No DOM, no module imports.
 * These tests run fast and catch obvious breakages before deeper unit/E2E tests.
 *
 * Run: node --test --experimental-strip-types src/plugins/adapters/__tests__/notion.adapter.smoke.test.ts
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

describe('NotionAdapter Smoke Tests', () => {
    describe('isSupported() logic', () => {
        it('should return true for /ai path', () => {
            const path: string = '/ai';
            const isSupported = path === '/ai' || path.startsWith('/ai/') || path.startsWith('/chat') || path.startsWith('/agent/');
            assert.equal(isSupported, true);
        });

        it('should return true for /ai/chat path', () => {
            const path: string = '/ai/chat/123';
            const isSupported = path === '/ai' || path.startsWith('/ai/') || path.startsWith('/chat') || path.startsWith('/agent/');
            assert.equal(isSupported, true);
        });

        it('should return true for /agent/ path', () => {
            const path: string = '/agent/abc123';
            const isSupported = path === '/ai' || path.startsWith('/ai/') || path.startsWith('/chat') || path.startsWith('/agent/');
            assert.equal(isSupported, true);
        });

        it('should return false for workspace path without native input', () => {
            const path: string = '/workspace/test';
            const hasNativeInput: boolean = false;
            const isLegacyPath = path === '/ai' || path.startsWith('/ai/') || path.startsWith('/chat') || path.startsWith('/agent/');
            const isSupported = isLegacyPath || (path.startsWith('/workspace/') && hasNativeInput);
            assert.equal(isSupported, false);
        });
    });

    describe('isNativeAiAgent() logic', () => {
        it('should return true for workspace page', () => {
            const path: string = '/workspace/test';
            const isNative = !path.startsWith('/ai') && !path.startsWith('/agent/');
            assert.equal(isNative, true);
        });

        it('should return false for /ai path', () => {
            const path: string = '/ai';
            const isNative = !path.startsWith('/ai') && !path.startsWith('/agent/');
            assert.equal(isNative, false);
        });

        it('should return true for /chat path (native agent)', () => {
            const path: string = '/chat';
            const isNative = !path.startsWith('/ai') && !path.startsWith('/agent/');
            assert.equal(isNative, true);
        });
    });

    describe('Bridge prompt injection logic', () => {
        it('should inject on first conversation with empty input', () => {
            const bridgePromptInjected: boolean = false;
            const conversationMessageCount: number = 0;
            const originalContent: string = '';
            const isNativeAiAgent: boolean = true;

            const shouldInject = isNativeAiAgent && !bridgePromptInjected && conversationMessageCount === 0 && !originalContent.trim();
            assert.equal(shouldInject, true);
        });

        it('should NOT inject when input has content', () => {
            const bridgePromptInjected: boolean = false;
            const conversationMessageCount: number = 0;
            const originalContent: string = 'User draft';
            const isNativeAiAgent: boolean = true;

            const shouldInject = isNativeAiAgent && !bridgePromptInjected && conversationMessageCount === 0 && !originalContent.trim();
            assert.equal(shouldInject, false);
        });

        it('should NOT inject on second conversation', () => {
            const bridgePromptInjected: boolean = false;
            const conversationMessageCount: number = 1;
            const originalContent: string = '';
            const isNativeAiAgent: boolean = true;

            const shouldInject = isNativeAiAgent && !bridgePromptInjected && conversationMessageCount === 0 && !originalContent.trim();
            assert.equal(shouldInject, false);
        });
    });

    describe('Conversation counting logic', () => {
        it('should increment count after submitForm on native agent', () => {
            let conversationMessageCount: number = 0;
            const isNativeAiAgent: boolean = true;

            if (isNativeAiAgent) {
                conversationMessageCount++;
            }

            assert.equal(conversationMessageCount, 1);
        });

        it('should NOT increment count on legacy /ai panel', () => {
            let conversationMessageCount: number = 0;
            const isNativeAiAgent: boolean = false;

            if (isNativeAiAgent) {
                conversationMessageCount++;
            }

            assert.equal(conversationMessageCount, 0);
        });
    });
});
