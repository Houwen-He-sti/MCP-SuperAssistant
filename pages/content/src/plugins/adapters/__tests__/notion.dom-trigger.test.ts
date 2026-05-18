/**
 * T-DOM-01: DOM Trigger Selector Test
 *
 * Verifies that NOTION_CHAT_CONTENT_SELECTOR exports the correct
 * CSS selector for the Notion AI chat content area.
 *
 * Evidence: BH-1 CDP probe confirms .layout-content selector (2026-05-19)
 *
 * Run: node --experimental-strip-types src/plugins/adapters/__tests__/notion.dom-trigger.test.ts
 * (from pages/content directory)
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { NOTION_CHAT_CONTENT_SELECTOR } from '../notion.adapter.selectors.ts';

describe('T-DOM-01: NOTION_CHAT_CONTENT_SELECTOR', () => {
    it('includes .layout-content (confirmed by BH-1 CDP probe)', () => {
        assert.ok(
            NOTION_CHAT_CONTENT_SELECTOR.includes('.layout-content'),
            `Expected selector to include .layout-content, got: "${NOTION_CHAT_CONTENT_SELECTOR}"`,
        );
    });

    it('does NOT use stale .notion-ai-chat-content selector', () => {
        assert.ok(
            !NOTION_CHAT_CONTENT_SELECTOR.includes('.notion-ai-chat-content'),
            `Expected selector NOT to include .notion-ai-chat-content (stale), got: "${NOTION_CHAT_CONTENT_SELECTOR}"`,
        );
    });

    it('includes .layout-chat as fallback', () => {
        assert.ok(
            NOTION_CHAT_CONTENT_SELECTOR.includes('.layout-chat'),
            `Expected selector to include .layout-chat as fallback, got: "${NOTION_CHAT_CONTENT_SELECTOR}"`,
        );
    });
});
