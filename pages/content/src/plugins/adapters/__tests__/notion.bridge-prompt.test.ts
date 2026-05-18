/**
 * Tests for notion.bridge-prompt — getEnabledToolDefinitions() + choosePromptForFirstConversation()
 *
 * Slice 1 TDD: verify the Tool[] → ToolDefinition[] mapping and the first-conversation
 * prompt choice logic (dynamic vs fallback, guard conditions).
 *
 * Run:
 *   node --test --experimental-strip-types \
 *     src/plugins/adapters/__tests__/notion.bridge-prompt.test.ts
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { getEnabledToolDefinitions, choosePromptForFirstConversation } from '../notion.bridge-prompt.ts';

// Minimal Tool shape matching stores.ts
interface Tool {
    name: string;
    description: string;
    schema?: any;
    input_schema: any;
}

describe('getEnabledToolDefinitions()', () => {
    it('returns empty array when no tools available', () => {
        const result = getEnabledToolDefinitions([], new Set());
        assert.deepEqual(result, []);
    });

    it('returns empty array when tools exist but none enabled', () => {
        const tools: Tool[] = [
            { name: 'tool-a', description: 'Tool A', input_schema: { properties: {} } },
        ];
        const result = getEnabledToolDefinitions(tools, new Set());
        assert.deepEqual(result, []);
    });

    it('includes only tools present in the enabled set', () => {
        const tools: Tool[] = [
            { name: 'tool-a', description: 'Tool A', input_schema: { properties: {} } },
            { name: 'tool-b', description: 'Tool B', input_schema: { properties: {} } },
        ];
        const result = getEnabledToolDefinitions(tools, new Set(['tool-a']));
        assert.equal(result.length, 1);
        assert.equal(result[0].name, 'tool-a');
    });

    it('includes all tools when all are enabled', () => {
        const tools: Tool[] = [
            { name: 'echo', description: 'Echo tool', input_schema: {} },
            { name: 'get_info', description: 'Get info', input_schema: {} },
        ];
        const result = getEnabledToolDefinitions(tools, new Set(['echo', 'get_info']));
        assert.equal(result.length, 2);
    });

    it('maps input_schema to JSON string in schema field', () => {
        const schema = { type: 'object', properties: { msg: { type: 'string' } } };
        const tools: Tool[] = [
            { name: 'echo', description: 'Echo', input_schema: schema },
        ];
        const result = getEnabledToolDefinitions(tools, new Set(['echo']));
        assert.equal(result[0].schema, JSON.stringify(schema));
    });

    it('prefers input_schema over legacy schema field', () => {
        const tools: Tool[] = [
            {
                name: 'tool-a',
                description: 'A',
                schema: { old: true },
                input_schema: { new: true },
            },
        ];
        const result = getEnabledToolDefinitions(tools, new Set(['tool-a']));
        assert.equal(result[0].schema, JSON.stringify({ new: true }));
    });

    it('falls back to legacy schema when input_schema is missing/null', () => {
        const tools: Tool[] = [
            {
                name: 'tool-a',
                description: 'A',
                schema: { legacy: true },
                input_schema: null as any,
            },
        ];
        const result = getEnabledToolDefinitions(tools, new Set(['tool-a']));
        assert.equal(result[0].schema, JSON.stringify({ legacy: true }));
    });

    it('uses empty object schema when both schema fields are missing', () => {
        const tools: Tool[] = [
            {
                name: 'tool-a',
                description: 'A',
                input_schema: null as any,
            },
        ];
        const result = getEnabledToolDefinitions(tools, new Set(['tool-a']));
        assert.equal(result[0].schema, JSON.stringify({}));
    });

    it('preserves description in output', () => {
        const tools: Tool[] = [
            { name: 'echo', description: 'Echo a message', input_schema: {} },
        ];
        const result = getEnabledToolDefinitions(tools, new Set(['echo']));
        assert.equal(result[0].description, 'Echo a message');
    });
});

const STATIC_PROMPT = '<mcp-system-prompt>static</mcp-system-prompt>';
const DYNAMIC_PROMPT = '<mcp-system-prompt>dynamic-with-real-tools</mcp-system-prompt>';

describe('choosePromptForFirstConversation()', () => {
    // --- Guard: inject conditions ---
    it('returns null when not on native AI agent page', () => {
        const result = choosePromptForFirstConversation(DYNAMIC_PROMPT, STATIC_PROMPT, false, false, 0, '');
        assert.equal(result, null);
    });

    it('returns null when bridge prompt already injected', () => {
        const result = choosePromptForFirstConversation(DYNAMIC_PROMPT, STATIC_PROMPT, true, true, 0, '');
        assert.equal(result, null);
    });

    it('returns null when messageCount > 0 (not first conversation)', () => {
        const result = choosePromptForFirstConversation(DYNAMIC_PROMPT, STATIC_PROMPT, true, false, 1, '');
        assert.equal(result, null);
    });

    it('returns null when input has existing user draft content', () => {
        const result = choosePromptForFirstConversation(DYNAMIC_PROMPT, STATIC_PROMPT, true, false, 0, 'User typed something');
        assert.equal(result, null);
    });

    it('returns prompt when input is whitespace-only (treated as empty)', () => {
        const result = choosePromptForFirstConversation(DYNAMIC_PROMPT, STATIC_PROMPT, true, false, 0, '   \n\t  ');
        assert.ok(result !== null);
    });

    // --- Dynamic vs static fallback ---
    it('returns dynamic prompt when cache is non-null', () => {
        const result = choosePromptForFirstConversation(DYNAMIC_PROMPT, STATIC_PROMPT, true, false, 0, '');
        assert.equal(result, DYNAMIC_PROMPT);
    });

    it('returns static fallback when cache is null (proxy unavailable)', () => {
        const result = choosePromptForFirstConversation(null, STATIC_PROMPT, true, false, 0, '');
        assert.equal(result, STATIC_PROMPT);
    });
});
