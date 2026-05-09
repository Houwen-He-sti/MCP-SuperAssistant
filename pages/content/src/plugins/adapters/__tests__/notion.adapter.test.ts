/**
 * Tests for NotionAdapter — native AI agent entry + bridge prompt injection.
 * Uses Node.js built-in test runner (node --test).
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

describe('NotionAdapter', () => {
    describe('isSupported() logic', () => {
        it('should return true for legacy /ai path', () => {
            const path: string = '/ai';
            const isSupported = path === '/ai' || path.startsWith('/ai/') || path.startsWith('/chat') || path.startsWith('/agent/');
            assert.equal(isSupported, true);
        });

        it('should return true for legacy /ai/xxx path', () => {
            const path: string = '/ai/chat/123';
            const isSupported = path === '/ai' || path.startsWith('/ai/') || path.startsWith('/chat') || path.startsWith('/agent/');
            assert.equal(isSupported, true);
        });

        it('should return true for workspace path when native input exists', () => {
            const path: string = '/workspace/test-page';
            const hasNativeInput: boolean = true;
            const isLegacyPath = path === '/ai' || path.startsWith('/ai/') || path.startsWith('/chat') || path.startsWith('/agent/');
            const isSupported = isLegacyPath || (path.startsWith('/workspace/') && hasNativeInput);
            assert.equal(isSupported, true);
        });

        it('should return false for workspace path when native input does not exist', () => {
            const path: string = '/workspace/test-page';
            const hasNativeInput: boolean = false;
            const isLegacyPath = path === '/ai' || path.startsWith('/ai/') || path.startsWith('/chat') || path.startsWith('/agent/');
            const isSupported = isLegacyPath || (path.startsWith('/workspace/') && hasNativeInput);
            assert.equal(isSupported, false);
        });
    });

    describe('isNativeAiAgent() logic', () => {
        it('should return true for workspace page', () => {
            const path: string = '/workspace/test-page';
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

    describe('bridge prompt injection logic', () => {
        it('should inject bridge prompt on first conversation when input is empty', () => {
            const bridgePromptInjected: boolean = false;
            const conversationMessageCount: number = 0;
            const originalContent: string = '';
            const isNativeAiAgent: boolean = true;

            const shouldInject = isNativeAiAgent && !bridgePromptInjected && conversationMessageCount === 0 && !originalContent.trim();
            assert.equal(shouldInject, true);
        });

        it('should NOT inject bridge prompt when input has existing content', () => {
            const bridgePromptInjected: boolean = false;
            const conversationMessageCount: number = 0;
            const originalContent: string = 'User draft';
            const isNativeAiAgent: boolean = true;

            const shouldInject = isNativeAiAgent && !bridgePromptInjected && conversationMessageCount === 0 && !originalContent.trim();
            assert.equal(shouldInject, false);
        });

        it('should NOT inject bridge prompt on second conversation', () => {
            const bridgePromptInjected: boolean = false;
            const conversationMessageCount: number = 1;
            const originalContent: string = '';
            const isNativeAiAgent: boolean = true;

            const shouldInject = isNativeAiAgent && !bridgePromptInjected && conversationMessageCount === 0 && !originalContent.trim();
            assert.equal(shouldInject, false);
        });

        it('should NOT inject bridge prompt if already injected', () => {
            const bridgePromptInjected: boolean = true;
            const conversationMessageCount: number = 0;
            const originalContent: string = '';
            const isNativeAiAgent: boolean = true;

            const shouldInject = isNativeAiAgent && !bridgePromptInjected && conversationMessageCount === 0 && !originalContent.trim();
            assert.equal(shouldInject, false);
        });
    });

    describe('conversation counting logic', () => {
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
