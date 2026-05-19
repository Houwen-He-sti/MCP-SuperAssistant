/**
 * Slice J1 TDD: notion-tool-shape-adapter.ts — normalizeToolDescriptors
 *
 * Tests: T-J1-01..T-J1-06
 *
 * Context:
 *   McpClient.getAvailableTools() returns snake_case shape:
 *     { name, description?, input_schema?: object, schema?: string | object }
 *   InMemoryToolRegistry.populate() expects ToolDescriptor camelCase shape:
 *     { name, description?, inputSchema?: Record<string, unknown> }
 *
 *   Gap: populate(tools) without normalization → inputSchema is always undefined
 *   Fix: normalizeToolDescriptors() adapter before populate()
 *
 * Conversion rules:
 *   inputSchema = input_schema ?? (typeof schema === 'object' ? schema : undefined)
 *   JSON string schema is NOT parsed (drop → undefined, fail-open accepted for J1)
 *   input_schema takes priority over schema
 *
 * Run:
 *   node --test --experimental-strip-types \
 *     src/plugins/adapters/__tests__/notion-tool-shape-adapter.test.ts
 * (from MCP-SuperAssistant/pages/content/)
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { normalizeToolDescriptors } from '../notion/notion-tool-shape-adapter.ts';
import type { McpClientToolShape } from '../notion/notion-tool-shape-adapter.ts';

describe('normalizeToolDescriptors — T-J1-*', () => {

    it('T-J1-01: snake_case input_schema → camelCase inputSchema', () => {
        const tools: McpClientToolShape[] = [
            {
                name: 'echo',
                description: 'echo tool',
                input_schema: { type: 'object', properties: { message: { type: 'string' } } },
            },
        ];
        const result = normalizeToolDescriptors(tools);
        assert.equal(result.length, 1, 'Should return one descriptor');
        assert.equal(result[0].name, 'echo');
        assert.equal(result[0].description, 'echo tool');
        assert.deepEqual(
            result[0].inputSchema,
            { type: 'object', properties: { message: { type: 'string' } } },
            'input_schema (snake_case) must be mapped to inputSchema (camelCase)'
        );
    });

    it('T-J1-02: schema (object) fallback when input_schema missing', () => {
        const tools: McpClientToolShape[] = [
            {
                name: 'search',
                schema: { type: 'object', properties: { query: { type: 'string' } } },
            },
        ];
        const result = normalizeToolDescriptors(tools);
        assert.equal(result.length, 1);
        assert.deepEqual(
            result[0].inputSchema,
            { type: 'object', properties: { query: { type: 'string' } } },
            'schema (object) must be used as fallback when input_schema absent'
        );
    });

    it('T-J1-03: schema (JSON string only) → inputSchema === undefined (fail-open accepted for J1)', () => {
        // NOTE: inputSchema === undefined means registry accept without schema check (fail-open).
        // This is ACCEPTED behavior for J1. mcp-client.ts:497-501 always provides input_schema (object)
        // in real usage, so this case is legacy string-only schema not expected in production.
        const tools: McpClientToolShape[] = [
            {
                name: 'legacy',
                schema: '{"type":"object","properties":{}}', // JSON string — should NOT be parsed
            },
        ];
        const result = normalizeToolDescriptors(tools);
        assert.equal(result.length, 1);
        assert.equal(
            result[0].inputSchema,
            undefined,
            'JSON string schema must NOT be parsed — inputSchema remains undefined (fail-open for J1)'
        );
    });

    it('T-J1-04: both input_schema and schema absent → inputSchema === undefined', () => {
        const tools: McpClientToolShape[] = [
            { name: 'noop' },
        ];
        const result = normalizeToolDescriptors(tools);
        assert.equal(result.length, 1);
        assert.equal(result[0].inputSchema, undefined, 'No schema fields → inputSchema undefined');
    });

    it('T-J1-05: input_schema takes priority over schema when both present', () => {
        const tools: McpClientToolShape[] = [
            {
                name: 'echo',
                input_schema: { type: 'object', properties: { x: { type: 'number' } } },
                schema: { type: 'object', properties: { y: { type: 'string' } } }, // different schema
            },
        ];
        const result = normalizeToolDescriptors(tools);
        assert.deepEqual(
            result[0].inputSchema,
            { type: 'object', properties: { x: { type: 'number' } } },
            'input_schema must take priority over schema when both are present'
        );
    });

    it('T-J1-06: name and description are transparently passed through', () => {
        const tools: McpClientToolShape[] = [
            { name: 'tool-a', description: 'description A' },
            { name: 'tool-b' },
        ];
        const result = normalizeToolDescriptors(tools);
        assert.equal(result[0].name, 'tool-a');
        assert.equal(result[0].description, 'description A');
        assert.equal(result[1].name, 'tool-b');
        assert.equal(result[1].description, undefined);
    });

});
