/**
 * functionResultParser.ts — Parse function_result XML from submitted user messages.
 *
 * Gate 6: Extracted from renderFunctionResult() to support:
 *   - Legacy singular format: <function_result call_id="...">content</function_result>
 *   - Canonical batch format: <function_results><result call_id name status>...</result></function_results>
 *   - Merged payloads: multiple <function_results> blocks in one message
 *   - Mixed: both legacy and canonical in one message
 *   - CDATA content extraction
 *
 * Pure parsing — no DOM dependencies. Fully testable.
 *
 * NOTE: This parser serves render_prescript/renderer/functionResult.ts which
 * handles submitted user messages visible in provider chat.
 * It is intentionally separate from services/tool-result-renderer.ts (PR #30)
 * which handles mcp:tool-execution-complete events before/around submit.
 * Do not merge these paths without a separate lifecycle unification plan.
 */

// --- Interfaces ---

export interface ParsedResult {
  callId: string;
  name: string;
  status: string;
  contentType: string;
  content: string;
}

export interface ParsedFunctionResults {
  results: ParsedResult[];
  trailing: string; // any text after the last closing tag (e.g. ack instruction)
}

// --- Implementation ---

/**
 * Extract content from a CDATA section, or return raw text if no CDATA.
 */
function extractCdataContent(raw: string): string {
  const cdataMatch = raw.match(/<!\[CDATA\[([\s\S]*?)\]\]>/);
  if (cdataMatch) {
    return cdataMatch[1].trim();
  }
  return raw.trim();
}

/**
 * Parse a single <result ...>...</result> element.
 */
function parseResultElement(resultXml: string): ParsedResult {
  const callIdMatch = resultXml.match(/call_id="([^"]*)"/);
  const nameMatch = resultXml.match(/name="([^"]*)"/);
  const statusMatch = resultXml.match(/status="([^"]*)"/);

  // Try <content ...>...</content> first (success case)
  // Supports: <content type="application/json">, <content>, etc.
  const contentMatch = resultXml.match(/<content\b[^>]*>([\s\S]*?)<\/content>/);
  const contentTypeMatch = resultXml.match(/<content\s[^>]*type="([^"]*)"/);
  let contentType = '';
  let content = '';

  if (contentMatch) {
    contentType = contentTypeMatch ? contentTypeMatch[1] : '';
    content = extractCdataContent(contentMatch[1]);
  } else {
    // Try <error type="...">...</error> (error case)
    const errorMatch = resultXml.match(/<error\b[^>]*>([\s\S]*?)<\/error>/);
    const errorTypeMatch = resultXml.match(/<error\s[^>]*type="([^"]*)"/);
    if (errorMatch) {
      contentType = errorTypeMatch ? errorTypeMatch[1] : '';
      content = extractCdataContent(errorMatch[1]);
    }
  }

  return {
    callId: callIdMatch ? callIdMatch[1] : '',
    name: nameMatch ? nameMatch[1] : '',
    status: statusMatch ? statusMatch[1] : '',
    contentType,
    content,
  };
}

/**
 * Parse canonical format: <function_results><result ...>...</result></function_results>
 * Supports multiple <result> entries within one <function_results> block.
 * Root tag may have attributes: <function_results batch_id="...">
 */
function parseCanonicalBlock(blockXml: string): ParsedResult[] {
  const results: ParsedResult[] = [];
  const resultRegex = /<result\s[^>]*>[\s\S]*?<\/result>/g;
  let match: RegExpExecArray | null;

  while ((match = resultRegex.exec(blockXml)) !== null) {
    results.push(parseResultElement(match[0]));
  }

  return results;
}

/**
 * Parse legacy singular format: <function_result call_id="...">content</function_result>
 * Uses word boundary \b to prevent matching <function_results> (plural).
 */
function parseLegacyBlock(text: string): ParsedResult[] {
  const results: ParsedResult[] = [];
  // \b after 'function_result' ensures we don't match 'function_results' (plural)
  // Attribute section is optional to support bare <function_result>content</function_result>
  const legacyRegex = /<function_result\b([^>]*)>([\s\S]*?)<\/function_result\s*>/g;
  let match: RegExpExecArray | null;

  while ((match = legacyRegex.exec(text)) !== null) {
    const attrs = match[1];
    const body = match[2].trim();
    const callIdMatch = attrs.match(/call_id="([^"]*)"/);

    results.push({
      callId: callIdMatch ? callIdMatch[1] : '',
      name: '',
      status: 'success',
      contentType: '',
      content: body,
    });
  }

  return results;
}

/**
 * Replace consumed spans with spaces to prevent re-parsing.
 * Preserves string length so indices remain valid for other operations.
 */
function maskSpans(text: string, spans: Array<{ start: number; end: number }>): string {
  if (spans.length === 0) return text;
  const chars = text.split('');
  for (const span of spans) {
    for (let i = span.start; i < span.end && i < chars.length; i++) {
      chars[i] = ' ';
    }
  }
  return chars.join('');
}

/**
 * Parse function result text from a submitted user message.
 *
 * Handles:
 *   1. Canonical: <function_results><result ...>...</result></function_results>
 *   2. Legacy: <function_result call_id="...">content</function_result>
 *   3. Merged: multiple blocks separated by text
 *   4. Mixed: both formats in one message
 *
 * Known limitation: this regex-based parser assumes formatter-generated
 * payloads and does not support literal closing root tags (e.g. </function_results>)
 * inside CDATA content. Such payloads would cause incorrect early termination.
 * This is acceptable because our formatter (functionResultFormatter.ts) does not
 * generate such content, and escapeCdata() only handles ]]> sequences.
 *
 * @param text The textContent of the user message DOM element
 * @returns Parsed results batch, or null if no function results found
 */
export function parseFunctionResults(text: string): ParsedFunctionResults | null {
  if (!text) return null;

  const results: ParsedResult[] = [];

  // Track which spans are consumed by canonical blocks (to avoid legacy re-parsing)
  const consumedSpans: Array<{ start: number; end: number }> = [];

  // 1. Parse canonical format: <function_results ...>...</function_results>
  //    Supports root attributes (e.g. <function_results batch_id="...">)
  const canonicalRegex = /<function_results\b[^>]*>([\s\S]*?)<\/function_results>/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = canonicalRegex.exec(text)) !== null) {
    consumedSpans.push({ start: match.index, end: match.index + match[0].length });
    lastIndex = Math.max(lastIndex, match.index + match[0].length);
    const blockResults = parseCanonicalBlock(match[1]);
    results.push(...blockResults);
  }

  // 2. Parse legacy format in text NOT consumed by canonical blocks
  //    This supports mixed messages (canonical + legacy in same text)
  const remainingText = maskSpans(text, consumedSpans);
  const legacyResults = parseLegacyBlock(remainingText);
  if (legacyResults.length > 0) {
    results.push(...legacyResults);
    // Update lastIndex for trailing text calculation
    const lastLegacy = text.lastIndexOf('</function_result>');
    if (lastLegacy >= 0) {
      const legacyEnd = lastLegacy + '</function_result>'.length;
      lastIndex = Math.max(lastIndex, legacyEnd);
    }
  }

  if (results.length === 0) return null;

  // Extract trailing text (e.g. ack instruction, result_nonce)
  const trailing = text.slice(lastIndex).trim();

  return { results, trailing };
}

/**
 * Quick check: does this text contain function result markers?
 * Use this before calling parseFunctionResults() to avoid unnecessary parsing.
 */
export function containsFunctionResult(text: string): boolean {
  return text.includes('<function_result');
}
