/**
 * Function call detection and identity extraction — pure logic module.
 *
 * Handles both standard JSON formats (ChatGPT, Anthropic, etc.)
 * and Notion's proprietary JSONL-in-markdown-in-patch format.
 *
 * This module has zero runtime dependencies — no DOM, no chrome APIs, no node APIs.
 * Safe for MAIN world IIFE bundling and direct import in tests.
 */

// ============================================================================
// Types
// ============================================================================

export interface FunctionCallIdentity {
    name: string | null;
    callId: string | null;
    arguments: string | null;
}

export interface ScanResult {
    /** Whether a function_call was fully detected (identity resolved or unrecoverable) */
    detected: boolean;
    /** Extracted identity (null if format unrecognized) */
    identity: FunctionCallIdentity | null;
    /** The NDJSON line that first triggered detection */
    rawLine: string;
    /** Whether the scanner is still accumulating cross-patch data */
    accumulating: boolean;
}

// ============================================================================
// Constants
// ============================================================================

export const FUNCTION_CALL_KEYWORDS = ['function_call', 'tool_use', 'tool_calls', 'name'];
export const MIN_KEYWORD_MATCHES = 2;
export const MAX_RAW_LINE_LENGTH = 65536; // 64KB cap per line

// ============================================================================
// Standard format detection
// ============================================================================

/** Quick keyword-based check: does this NDJSON line likely contain a function_call? */
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

/** Extract function call identity from a single standard-format JSON line. */
export function extractFunctionCallIdentity(line: string): FunctionCallIdentity | null {
    try {
        const obj = JSON.parse(line);
        if (!obj || typeof obj !== 'object') return null;

        // Format: { type: "function_call", name: "...", id: "...", arguments: "..." }
        if (obj.type === 'function_call') {
            return {
                name: typeof obj.name === 'string' ? obj.name : null,
                callId: typeof obj.id === 'string' ? obj.id : null,
                arguments: typeof obj.arguments === 'string' ? obj.arguments : null,
            };
        }

        // Format: { function_call: { name: "...", arguments: "..." } }
        if (obj.function_call && typeof obj.function_call === 'object') {
            const fc = obj.function_call;
            return {
                name: typeof fc.name === 'string' ? fc.name : null,
                callId: typeof obj.id === 'string' ? obj.id : null,
                arguments: typeof fc.arguments === 'string' ? fc.arguments : null,
            };
        }

        // Format: { tool_calls: [{ id: "...", function: { name: "...", arguments: "..." } }] }
        if (Array.isArray(obj.tool_calls) && obj.tool_calls.length > 0) {
            const tc = obj.tool_calls[0];
            const fn = tc.function;
            return {
                name: fn && typeof fn.name === 'string' ? fn.name : null,
                callId: typeof tc.id === 'string' ? tc.id : null,
                arguments: fn && typeof fn.arguments === 'string' ? fn.arguments : null,
            };
        }

        // Format: { tool_use: { name: "...", input: {...} } }
        if (obj.tool_use && typeof obj.tool_use === 'object') {
            const tu = obj.tool_use;
            return {
                name: typeof tu.name === 'string' ? tu.name : null,
                callId: typeof tu.id === 'string' ? tu.id : null,
                arguments: tu.input ? JSON.stringify(tu.input) : null,
            };
        }

        return null;
    } catch {
        return null;
    }
}

// ============================================================================
// Notion Patch Format — cross-patch accumulator for JSONL function calls
//
// Notion streams function_call as proprietary JSONL embedded in text content
// patches (type:"patch", o:"x"), split across multiple NDJSON lines:
//   {"type":"function_call_start","name":"...","call_id":"..."}
//   {"type":"parameter","key":"...","value":"..."}
//   {"type":"function_call_end","call_id":"..."}
// ============================================================================

/** Extract text content from a Notion patch line (o:"x" extend operations on content paths) */
export function extractPatchTextContent(line: string): string | null {
    try {
        const obj = JSON.parse(line);
        if (obj?.type !== 'patch' || !Array.isArray(obj.v)) return null;

        let text = '';
        for (const op of obj.v) {
            if (op.o === 'x' && typeof op.v === 'string' && typeof op.p === 'string' && op.p.endsWith('/content')) {
                text += op.v;
            }
        }
        return text || null;
    } catch {
        return null;
    }
}

/** Parse a complete JSONL block to extract function call identity */
export function extractIdentityFromJsonlBlock(text: string): FunctionCallIdentity | null {
    const lines = text.split('\n');
    let name: string | null = null;
    let callId: string | null = null;
    const args: Record<string, string> = {};

    for (const rawLine of lines) {
        const trimmed = rawLine.trim();
        if (!trimmed.startsWith('{')) continue;
        try {
            const obj = JSON.parse(trimmed);
            if (obj.type === 'function_call_start') {
                name = typeof obj.name === 'string' ? obj.name : null;
                callId = typeof obj.call_id === 'string' ? obj.call_id : null;
            } else if (obj.type === 'parameter' && typeof obj.key === 'string') {
                args[obj.key] = typeof obj.value === 'string' ? obj.value : JSON.stringify(obj.value);
            }
        } catch {
            continue;
        }
    }

    if (!name) return null;

    return {
        name,
        callId,
        arguments: Object.keys(args).length > 0 ? JSON.stringify(args) : null,
    };
}

// ============================================================================
// Stateful Scanner
// ============================================================================

/**
 * Create a stateful function_call scanner that handles both standard JSON
 * formats and Notion's cross-patch JSONL format.
 *
 * Usage: call processLine() for each trimmed NDJSON line. Check result:
 * - accumulating=true: scanner needs more lines, don't emit yet
 * - detected=true: function_call fully resolved, emit event
 * - detected=false && !accumulating: line is not a function_call
 */
/** Maximum patch accumulation buffer size (128KB). Abort accumulation if exceeded. */
export const MAX_PATCH_BUFFER_SIZE = 128 * 1024;

export function createFunctionCallScanner() {
    let patchContentBuffer = '';
    let isAccumulating = false;
    let firstDetectionLine = '';

    function processLine(trimmedLine: string): ScanResult {
        // If accumulating patch content for a cross-patch function_call
        if (isAccumulating) {
            const patchText = extractPatchTextContent(trimmedLine);
            if (patchText !== null) {
                patchContentBuffer += patchText;
                // Safety cap: abort if buffer grows too large
                if (patchContentBuffer.length > MAX_PATCH_BUFFER_SIZE) {
                    const identity = extractIdentityFromJsonlBlock(patchContentBuffer);
                    const rawLine = firstDetectionLine;
                    reset();
                    if (identity !== null) {
                        return { detected: true, identity, rawLine, accumulating: false };
                    }
                    return { detected: false, identity: null, rawLine: '', accumulating: false };
                }
                if (patchContentBuffer.includes('function_call_end')) {
                    const identity = extractIdentityFromJsonlBlock(patchContentBuffer);
                    const rawLine = firstDetectionLine;
                    reset();
                    return { detected: true, identity, rawLine, accumulating: false };
                }
                // Still accumulating — need more patches
                return { detected: false, identity: null, rawLine: '', accumulating: true };
            }
            // Non-patch line while accumulating — abort accumulation, try best-effort
            const identity = extractIdentityFromJsonlBlock(patchContentBuffer);
            const rawLine = firstDetectionLine;
            reset();
            if (identity !== null) {
                return { detected: true, identity, rawLine, accumulating: false };
            }
            // Fall through to normal detection on current line
        }

        if (!detectFunctionCall(trimmedLine)) {
            return { detected: false, identity: null, rawLine: '', accumulating: false };
        }

        // Try standard extraction first (ChatGPT, etc.)
        const identity = extractFunctionCallIdentity(trimmedLine);
        if (identity !== null) {
            return { detected: true, identity, rawLine: trimmedLine, accumulating: false };
        }

        // Try Notion patch format
        const patchText = extractPatchTextContent(trimmedLine);
        if (patchText !== null && patchText.includes('function_call_start')) {
            patchContentBuffer = patchText;
            firstDetectionLine = trimmedLine;
            if (patchText.includes('function_call_end')) {
                // Complete in one line
                const patchIdentity = extractIdentityFromJsonlBlock(patchContentBuffer);
                reset();
                return { detected: true, identity: patchIdentity, rawLine: trimmedLine, accumulating: false };
            }
            // Need to accumulate more patches
            isAccumulating = true;
            return { detected: false, identity: null, rawLine: '', accumulating: true };
        }

        // Unknown format — emit with null identity (legacy behavior)
        return { detected: true, identity: null, rawLine: trimmedLine, accumulating: false };
    }

    function reset() {
        patchContentBuffer = '';
        isAccumulating = false;
        firstDetectionLine = '';
    }

    return { processLine };
}
