/**
 * functionResultFormatter.ts — Format tool results for injection into AI input.
 *
 * Extracted from streamToolBridge.ts (P0-2, Gate 3C-prep).
 * Produces XML-formatted function_result blocks.
 *
 * Gate 4: Updated to protocol spec format (§2.1/§2.2) with CDATA wrapper.
 * Format verified by P0-1a format probe on live Notion AI.
 */

// --- Constants ---

/** Maximum body length before truncation (32KB). */
const MAX_BODY_LENGTH = 32_768;

// --- Interface ---

export interface FormatResultOptions {
  callId: string;
  name: string;
  status: 'success' | 'error';
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
 * Escape CDATA content: only ]]> needs to be split.
 * CDATA sections cannot contain the literal string ]]>.
 */
function escapeCdata(s: string): string {
  return s.replace(/\]\]>/g, ']]]]><![CDATA[>');
}

/**
 * Serialize result to string body.
 */
function serializeResult(result: unknown): string {
  if (typeof result === 'string') return result;
  return JSON.stringify(result);
}

/**
 * Format a successful function result per protocol §2.1.
 */
function formatSuccess(callId: string, name: string, body: string): string {
  return `<function_results>\n  <result call_id="${escapeXmlAttr(callId)}" name="${escapeXmlAttr(name)}" status="success">\n    <content type="application/json"><![CDATA[\n${body}\n    ]]></content>\n  </result>\n</function_results>`;
}

/**
 * Format an error function result per protocol §2.2.
 */
function formatError(callId: string, name: string, body: string): string {
  return `<function_results>\n  <result call_id="${escapeXmlAttr(callId)}" name="${escapeXmlAttr(name)}" status="error">\n    <error type="ToolExecutionError"><![CDATA[\n${body}\n    ]]></error>\n  </result>\n</function_results>`;
}

/**
 * Format a function result for injection into AI provider input.
 * Follows MCP-SuperAssistant Tool Protocol Specification §2.
 */
export function formatFunctionResult(opts: FormatResultOptions): string {
  const { callId, name, status, result } = opts;

  let body = serializeResult(result);

  // Escape CDATA-breaking sequences
  body = escapeCdata(body);

  // Truncate if too large
  if (body.length > MAX_BODY_LENGTH) {
    body = body.slice(0, MAX_BODY_LENGTH) + '\n[truncated]';
  }

  if (status === 'error') {
    return formatError(callId, name, body);
  }
  return formatSuccess(callId, name, body);
}
