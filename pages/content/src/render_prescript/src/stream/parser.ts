/**
 * NDJSON parser for Notion AI stream.
 * Detects function_call signals in chunked text.
 *
 * Phase 1: passive detection only (no cutoff).
 */

import { createLogger } from '@extension/shared/lib/logger';

const logger = createLogger('NDJSONParser');

/**
 * Keywords that indicate a function_call in Notion AI NDJSON output.
 * Based on Phase 0 PoC empirical evidence: function_call appeared as
 * a JSON object with these identifiers in chunk #9.
 */
const FUNCTION_CALL_KEYWORDS = [
    'function_call',
    'tool_use',
    'tool_calls',
    'name',
] as const;

/**
 * Minimum number of keywords that must appear in a single line
 * to classify it as a function_call signal.
 * Using 2 to reduce false positives (e.g., "name" alone is too common).
 */
const MIN_KEYWORD_MATCHES = 2;

/**
 * Check if a single NDJSON line contains a function_call signal.
 * Uses keyword scan (fast, resilient to format changes).
 */
export function detectFunctionCall(line: string): boolean {
    if (!line || line.length < 10) return false;

    let matches = 0;
    for (const keyword of FUNCTION_CALL_KEYWORDS) {
        if (line.includes(keyword)) {
            matches++;
            if (matches >= MIN_KEYWORD_MATCHES) return true;
        }
    }
    return false;
}

/**
 * Try to parse a single NDJSON line as JSON.
 * Returns null on failure (lenient — partial lines are expected during streaming).
 */
export function tryParseNDJSON(line: string): unknown | null {
    try {
        return JSON.parse(line);
    } catch {
        return null;
    }
}

/**
 * Extract text content from a parsed NDJSON chunk (best-effort).
 * Notion uses varying structures; this handles common patterns.
 */
export function extractTextFromChunk(parsed: unknown): string | null {
    if (!parsed || typeof parsed !== 'object') return null;

    const obj = parsed as Record<string, unknown>;

    // Pattern: { type: "text", value: "..." }
    if (typeof obj.value === 'string') return obj.value;

    // Pattern: { text: "..." }
    if (typeof obj.text === 'string') return obj.text;

    // Pattern: { content: "..." }
    if (typeof obj.content === 'string') return obj.content;

    // Pattern: { choices: [{ delta: { content: "..." } }] } (OpenAI-like)
    if (Array.isArray(obj.choices)) {
        const delta = (obj.choices[0] as Record<string, unknown>)?.delta;
        if (delta && typeof delta === 'object') {
            const content = (delta as Record<string, unknown>).content;
            if (typeof content === 'string') return content;
        }
    }

    return null;
}

/**
 * Extracted function call identity from an NDJSON line.
 * Used by Phase 2+ to pass structured info to executionGuard.
 */
export interface FunctionCallIdentity {
    /** Function/tool name (e.g., "mcp__search") */
    name: string | null;
    /** Call ID if present (e.g., "call_abc123") */
    callId: string | null;
    /** Raw arguments string (may be partial JSON) */
    arguments: string | null;
}

/**
 * Attempt to extract a structured function call identity from an NDJSON line.
 * Falls back gracefully — returns partial info if full parse fails.
 *
 * Handles multiple formats:
 * - { "type": "function_call", "name": "...", "arguments": "..." }
 * - { "function_call": { "name": "...", "arguments": "..." } }
 * - { "tool_calls": [{ "id": "...", "function": { "name": "...", "arguments": "..." } }] }
 * - { "tool_use": { "name": "...", "input": {...} } }
 */
export function extractFunctionCallIdentity(line: string): FunctionCallIdentity | null {
    const parsed = tryParseNDJSON(line);
    if (!parsed || typeof parsed !== 'object') return null;

    const obj = parsed as Record<string, unknown>;

    // Format 1: { type: "function_call", name: "...", id: "...", arguments: "..." }
    if (obj.type === 'function_call') {
        return {
            name: typeof obj.name === 'string' ? obj.name : null,
            callId: typeof obj.id === 'string' ? obj.id : null,
            arguments: typeof obj.arguments === 'string' ? obj.arguments : null,
        };
    }

    // Format 2: { function_call: { name: "...", arguments: "..." } }
    if (obj.function_call && typeof obj.function_call === 'object') {
        const fc = obj.function_call as Record<string, unknown>;
        return {
            name: typeof fc.name === 'string' ? fc.name : null,
            callId: typeof obj.id === 'string' ? obj.id : null,
            arguments: typeof fc.arguments === 'string' ? fc.arguments : null,
        };
    }

    // Format 3: { tool_calls: [{ id: "...", function: { name: "...", arguments: "..." } }] }
    if (Array.isArray(obj.tool_calls) && obj.tool_calls.length > 0) {
        const tc = obj.tool_calls[0] as Record<string, unknown>;
        const fn = tc.function as Record<string, unknown> | undefined;
        return {
            name: fn && typeof fn.name === 'string' ? fn.name : null,
            callId: typeof tc.id === 'string' ? tc.id : null,
            arguments: fn && typeof fn.arguments === 'string' ? fn.arguments : null,
        };
    }

    // Format 4: { tool_use: { name: "...", input: {...} } }
    if (obj.tool_use && typeof obj.tool_use === 'object') {
        const tu = obj.tool_use as Record<string, unknown>;
        return {
            name: typeof tu.name === 'string' ? tu.name : null,
            callId: typeof tu.id === 'string' ? tu.id : null,
            arguments: tu.input ? JSON.stringify(tu.input) : null,
        };
    }

    // Keyword match detected but can't extract structured identity
    return { name: null, callId: null, arguments: null };
}
