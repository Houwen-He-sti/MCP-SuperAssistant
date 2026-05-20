/**
 * Slice M TDD: NotionMcpToolCatalogSource — ToolCatalogSource implementation
 *
 * Tests: T-M-01..T-M-03
 *
 * Context:
 *   notion-bridge-lane-gate.ts currently inlines async glue:
 *     mcpClient.getAvailableTools().then(tools => toolRegistry.populate(normalizeToolDescriptors(tools)))
 *   Slice M extracts this into:
 *     NotionMcpToolCatalogSource (wraps getAvailableTools + normalizeToolDescriptors)
 *     Controller.start() coordinates source → registry (replaces inline glue)
 *
 * Interface (from mcp-runtime):
 *   ToolCatalogSource { getTools(): Promise<ToolDescriptor[]> }
 *
 * Design (Option Y+, GPT 4C verdict):
 *   - Implements ToolCatalogSource port
 *   - Wraps mcpClient.getAvailableTools() + normalizeToolDescriptors() internally
 *   - Returns normalized ToolDescriptor[] (camelCase inputSchema)
 *   - Controller never calls normalizeToolDescriptors directly
 *   - Rejects propagate to caller (Controller should .catch() and warn)
 *
 * Plan: plans/slice-m-tool-catalog-source-plan.md
 * Committee: Gemini OO ✅ + OPUS ReOO ✅ + GPT 4C ✅ (Option Y+)
 *
 * Run:
 *   node --test --experimental-strip-types \
 *     src/plugins/adapters/__tests__/notion-mcp-tool-catalog-source.test.ts
 * (from MCP-SuperAssistant/pages/content/)
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { NotionMcpToolCatalogSource } from '../notion/notion-mcp-tool-catalog-source.ts';
import type { McpClientToolShape } from '../notion/notion-tool-shape-adapter.ts';

// ---------------------------------------------------------------------------
// Test: T-M-01 — getTools() returns normalized ToolDescriptor[]
// ---------------------------------------------------------------------------

describe('NotionMcpToolCatalogSource — T-M-01..T-M-03', () => {

    /**
     * T-M-01: getTools() normalizes McpClientToolShape (snake_case) → ToolDescriptor (camelCase).
     * Verifies that normalizeToolDescriptors is applied inside getTools().
     */
    it('T-M-01: getTools() returns normalized ToolDescriptor[] (snake_case → camelCase)', async () => {
        const raw: McpClientToolShape[] = [
            {
                name: 'search',
                description: 'Search tool',
                input_schema: { type: 'object', properties: { query: { type: 'string' } } },
            },
            {
                name: 'echo',
                description: 'Echo tool',
                // No input_schema — should produce inputSchema: undefined
            },
        ];

        const source = new NotionMcpToolCatalogSource({
            getAvailableTools: async () => raw,
        });

        const tools = await source.getTools();

        assert.strictEqual(tools.length, 2);

        // First tool: snake_case input_schema → camelCase inputSchema
        assert.strictEqual(tools[0].name, 'search');
        assert.strictEqual(tools[0].description, 'Search tool');
        assert.deepStrictEqual(
            tools[0].inputSchema,
            { type: 'object', properties: { query: { type: 'string' } } },
            'input_schema (snake_case) must be converted to inputSchema (camelCase)'
        );

        // Second tool: no schema → inputSchema undefined
        assert.strictEqual(tools[1].name, 'echo');
        assert.strictEqual(tools[1].description, 'Echo tool');
        assert.strictEqual(tools[1].inputSchema, undefined);
    });

    /**
     * T-M-02: getTools() propagates rejection from mcpClient.getAvailableTools().
     * Verifies fail-closed behavior: if getAvailableTools throws, getTools() rejects.
     */
    it('T-M-02: getTools() propagates rejection from getAvailableTools()', async () => {
        const error = new Error('MCP client disconnected');

        const source = new NotionMcpToolCatalogSource({
            getAvailableTools: async () => {
                throw error;
            },
        });

        await assert.rejects(
            source.getTools(),
            (err) => {
                assert.strictEqual(err, error, 'Should propagate the exact same error');
                return true;
            }
        );
    });

    /**
     * T-M-03: getTools() returns empty array when getAvailableTools() returns [].
     */
    it('T-M-03: getTools() handles empty tool list → returns []', async () => {
        const source = new NotionMcpToolCatalogSource({
            getAvailableTools: async () => [],
        });

        const tools = await source.getTools();
        assert.deepStrictEqual(tools, []);
        assert.strictEqual(tools.length, 0);
    });

});
