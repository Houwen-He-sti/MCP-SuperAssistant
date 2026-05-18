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
