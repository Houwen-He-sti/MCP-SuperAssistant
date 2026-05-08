/**
 * functionResultFormatter.ts — Format tool results for injection into AI input.
 *
 * Extracted from streamToolBridge.ts (P0-2, Gate 3C-prep).
 * Produces XML-formatted function_result blocks.
 *
 * Format determined by P0-1 format probe (default: bare XML).
 */

// --- Constants ---

/** Maximum body length before truncation (32KB). */
const MAX_BODY_LENGTH = 32_768;

// --- Interface ---

export interface FormatResultOptions {
  callId: string;
  name: string;
  status: 'ok' | 'error';
  result: unknown;
}

// --- Implementation ---

/**
 * Escape a string for use in XML attribute values.
 */
function escapeXmlAttr(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Escape content body to prevent premature tag closure.
 * Only escapes sequences that could break the XML structure.
 */
function escapeXmlBody(s: string): string {
  return s.replace(/<\/function_result>/g, '&lt;/function_result&gt;');
}

/**
 * Serialize result to string body.
 */
function serializeResult(result: unknown): string {
  if (typeof result === 'string') return result;
  return JSON.stringify(result);
}

/**
 * Format a function result for injection into AI provider input.
 */
export function formatFunctionResult(opts: FormatResultOptions): string {
  const { callId, name, status, result } = opts;

  let body = serializeResult(result);

  // Escape body to prevent XML injection
  body = escapeXmlBody(body);

  // Truncate if too large
  if (body.length > MAX_BODY_LENGTH) {
    body = body.slice(0, MAX_BODY_LENGTH) + '\n[truncated]';
  }

  return `<function_result call_id="${escapeXmlAttr(callId)}" name="${escapeXmlAttr(name)}" status="${status}">\n${body}\n</function_result>`;
}
