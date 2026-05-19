/**
 * notion-tool-shape-adapter.ts — Shape adapter for McpClient tool descriptors.
 *
 * Slice J1: Normalize McpClient.getAvailableTools() snake_case output → mcp-runtime ToolDescriptor camelCase shape.
 *
 * Problem:
 *   McpClient.getAvailableTools() (mcp-client.ts:497-501) returns:
 *     { name, description, input_schema: Record<string, unknown>, schema: string | object }
 *   InMemoryToolRegistry.populate() expects ToolDescriptor:
 *     { name, description?, inputSchema?: Record<string, unknown> }
 *   Without this adapter, inputSchema is always undefined in the registry.
 *
 * Conversion rules:
 *   inputSchema = input_schema ?? (typeof schema === 'object' ? schema : undefined)
 *   JSON string schema is NOT parsed (drop → inputSchema undefined; fail-open accepted for J1).
 *   input_schema takes priority over schema object.
 *
 * Scope: J1 only. No logger, no side effects, pure function.
 */

import type { ToolDescriptor } from '../../../../../../../mcp-runtime/src/core/tool-call-loop.ts';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Real shape returned by McpClient.getAvailableTools() (mcp-client.ts:497-501).
 * Distinct from the mcp-runtime ToolDescriptor (camelCase) shape.
 */
export interface McpClientToolShape {
    name: string;
    description?: string;
    /** MCP protocol standard field (snake_case). Takes priority over schema. */
    input_schema?: Record<string, unknown>;
    /**
     * Legacy compatibility field. May be a JSON string (ignored) or an object (fallback).
     * JSON string is NOT parsed — drop to undefined. inputSchema = undefined is fail-open.
     * In real usage, mcp-client.ts always provides input_schema (object), so string-only
     * is only legacy edge case.
     */
    schema?: string | Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

/**
 * Normalize an array of McpClient tool shapes to mcp-runtime ToolDescriptor shapes.
 *
 * Pure function. No side effects, no logging. Preserves input order.
 */
export function normalizeToolDescriptors(tools: McpClientToolShape[]): ToolDescriptor[] {
    return tools.map(tool => {
        // Determine inputSchema:
        // 1. Prefer input_schema (snake_case) — MCP protocol standard
        // 2. Fallback to schema if it's an object (legacy cross-env compatibility)
        // 3. JSON string schema is NOT parsed (fail-open accepted for J1)
        let inputSchema: Record<string, unknown> | undefined;
        if (tool.input_schema !== undefined) {
            inputSchema = tool.input_schema;
        } else if (typeof tool.schema === 'object' && tool.schema !== null) {
            inputSchema = tool.schema as Record<string, unknown>;
        }
        // else: inputSchema remains undefined (fail-open for J1)

        return {
            name: tool.name,
            description: tool.description,
            inputSchema,
        };
    });
}
