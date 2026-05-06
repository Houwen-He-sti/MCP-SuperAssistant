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
