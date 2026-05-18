/**
 * notion.bridge-prompt — pure utility functions for dynamic bridge prompt injection.
 *
 * Extracted from notion.adapter.ts for testability.
 * These functions have NO dependency on Vite ?raw imports and can be used in Node.js tests.
 *
 * Usage:
 *   1. Call getEnabledToolDefinitions(availableTools, enabledToolNames) on activate().
 *   2. If result is non-empty, pass to buildBridgePromptFromTools() for the dynamic prompt.
 *   3. If result is empty (proxy not connected), fall back to static BRIDGE_PROMPT.
 *   4. Call choosePromptForFirstConversation() in insertText() to decide which prompt to prepend.
 */

import type { Tool } from '../../types/stores';

/**
 * Internal ToolDefinition shape expected by assembleInstructions / formatToolList.
 */
export interface ToolDefinition {
    name: string;
    description: string;
    /** Serialized JSON string of the tool's input schema. */
    schema: string;
}

/**
 * Map the Zustand tool store state → ToolDefinition[] for promptTemplateLoader.
 *
 * Filters `availableTools` to only those in `enabledToolNames`, then maps
 * the `input_schema` (preferred) or legacy `schema` to a JSON string.
 *
 * Returns an empty array when no tools are available or none are enabled.
 *
 * @param availableTools  Full list of tools from useToolStore.getState().availableTools
 * @param enabledToolNames  Set of enabled tool names from useToolStore.getState().enabledTools
 */
export function getEnabledToolDefinitions(
    availableTools: Tool[],
    enabledToolNames: Set<string>,
): ToolDefinition[] {
    if (!availableTools || availableTools.length === 0) return [];

    return availableTools
        .filter(tool => enabledToolNames.has(tool.name))
        .map(tool => ({
            name: tool.name,
            description: tool.description,
            schema: JSON.stringify(tool.input_schema ?? tool.schema ?? {}),
        }));
}

/**
 * Decide which prompt to prepend for the first conversation in Notion AI.
 *
 * Returns the prompt string to prepend (either dynamic or static fallback),
 * or `null` if the bridge prompt should NOT be injected for this call.
 *
 * Injection conditions (all must be true):
 *  - isNativeAiAgent: we're on the native AI agent page
 *  - NOT alreadyInjected: haven't injected in this conversation already
 *  - messageCount === 0: this is the first message in the conversation
 *  - existingContent is empty or whitespace-only (no user draft)
 *
 * @param cachedBridgePrompt  Dynamic prompt from tool store cache, or null if unavailable
 * @param staticBridgePrompt  Static fallback (e.g. BRIDGE_PROMPT from module constant)
 * @param isNativeAiAgent     Whether we're on the native Notion AI agent page
 * @param alreadyInjected     Whether the bridge prompt has already been injected
 * @param messageCount        Number of messages sent in the current conversation
 * @param existingContent     Current text content of the input element
 */
export function choosePromptForFirstConversation(
    cachedBridgePrompt: string | null,
    staticBridgePrompt: string,
    isNativeAiAgent: boolean,
    alreadyInjected: boolean,
    messageCount: number,
    existingContent: string,
): string | null {
    if (!isNativeAiAgent) return null;
    if (alreadyInjected) return null;
    if (messageCount !== 0) return null;
    if (existingContent.trim() !== '') return null;

    // Use dynamic prompt if available, fall back to static
    return cachedBridgePrompt ?? staticBridgePrompt;
}

