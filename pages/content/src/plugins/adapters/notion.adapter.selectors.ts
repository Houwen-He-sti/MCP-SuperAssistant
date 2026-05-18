/**
 * CSS selectors for Notion AI adapter.
 *
 * Extracted as constants to allow testing without browser deps.
 * Evidence: BH-1 CDP probe 2026-05-19 confirms .layout-content is the correct selector.
 * .layout-chat is the fallback.
 */

/**
 * CSS selector for Notion AI chat content area.
 * BH-1 evidence: .notion-ai-chat-content → 0 results (stale)
 *                .layout-content → correct (confirmed by CDP probe)
 * Fallback: .layout-chat for chat-specific layout variants.
 */
export const NOTION_CHAT_CONTENT_SELECTOR = '.layout-content, .layout-chat';
