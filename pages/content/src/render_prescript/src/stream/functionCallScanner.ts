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

/** Extract text content from a Notion patch line.
 *  Handles two operation types:
 *  - o:"x" (extend) — appends text to an existing content path
 *  - o:"a" (append) — creates a new block; content is nested inside v.value[].content
 */
export function extractPatchTextContent(line: string): string | null {
    try {
        const obj = JSON.parse(line);
        if (obj?.type !== 'patch' || !Array.isArray(obj.v)) return null;

        let text = '';
        for (const op of obj.v) {
            // o:"x" — extend operation on a content path (existing behavior)
            if (op.o === 'x' && typeof op.v === 'string' && typeof op.p === 'string' && op.p.endsWith('/content')) {
                text += op.v;
            }
            // o:"a" — append operation; content can be the appended value itself
            // or nested in v.value[].content, depending on Notion's block shape.
            if (op.o === 'a' && op.v && typeof op.v === 'object' && Array.isArray(op.v.value)) {
                for (const entry of op.v.value) {
                    if (entry && typeof entry.content === 'string') {
                        text += entry.content;
                    }
                }
            }
            if (op.o === 'a' && op.v && typeof op.v === 'object' && typeof op.v.content === 'string') {
                text += op.v.content;
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
    let endCallId: string | null = null;
    let invalid = false;
    const args: Record<string, unknown> = {};

    for (const rawLine of lines) {
        const trimmed = rawLine.trim();
        if (!trimmed.startsWith('{')) continue;
        try {
            const obj = JSON.parse(trimmed);
            if (obj.type === 'function_call_start') {
                if (name !== null) invalid = true;
                name = typeof obj.name === 'string' ? obj.name : null;
                callId = typeof obj.call_id === 'string' ? obj.call_id : null;
            } else if (obj.type === 'parameter' && typeof obj.key === 'string') {
                if (!Object.prototype.hasOwnProperty.call(obj, 'value')) {
                    invalid = true;
                    continue;
                }
                args[obj.key] = obj.value;
            } else if (obj.type === 'function_call_end') {
                endCallId = typeof obj.call_id === 'string' ? obj.call_id : null;
            }
        } catch {
            continue;
        }
    }

    if (!name || invalid) return null;
    if (endCallId !== null && callId !== null && endCallId !== callId) return null;

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

    /** Check if a raw NDJSON line is a Notion patch (type: "patch") */
    function isNotionPatchLine(line: string): boolean {
        if (!line.includes('"patch"')) return false;
        try {
            const obj = JSON.parse(line);
            return obj?.type === 'patch';
        } catch {
            return false;
        }
    }

    function isNotionRecordMapLine(line: string): boolean {
        if (!line.includes('"record-map"')) return false;
        try {
            const obj = JSON.parse(line);
            return obj?.type === 'record-map';
        } catch {
            return false;
        }
    }

    function shouldStartPatchAccumulation(patchText: string): boolean {
        const trimmed = patchText.trimEnd();
        return patchText.includes('function_call_start')
            || (patchText.includes('```jsonl') && /"type"\s*:\s*"function_/.test(patchText))
            || (patchText.includes('```jsonl') && /\{\s*$/.test(trimmed))
            || (patchText.includes('```jsonl') && /"type"\s*:\s*"$/.test(trimmed));
    }

    function startPatchAccumulation(patchText: string, rawLine: string): ScanResult {
        patchContentBuffer = patchText;
        firstDetectionLine = rawLine;
        if (patchContentBuffer.length > MAX_PATCH_BUFFER_SIZE) {
            reset();
            return { detected: false, identity: null, rawLine: '', accumulating: false };
        }
        if (patchText.includes('function_call_end')) {
            const patchIdentity = extractIdentityFromJsonlBlock(patchContentBuffer);
            reset();
            if (patchIdentity === null) {
                return { detected: false, identity: null, rawLine: '', accumulating: false };
            }
            return { detected: true, identity: patchIdentity, rawLine, accumulating: false };
        }
        isAccumulating = true;
        return { detected: false, identity: null, rawLine: '', accumulating: true };
    }

    function processLine(trimmedLine: string): ScanResult {
        // If accumulating patch content for a cross-patch function_call
        if (isAccumulating) {
            const patchText = extractPatchTextContent(trimmedLine);
            if (patchText !== null) {
                patchContentBuffer += patchText;
                // Safety cap: abort if buffer grows too large
                if (patchContentBuffer.length > MAX_PATCH_BUFFER_SIZE) {
                    reset();
                    return { detected: false, identity: null, rawLine: '', accumulating: false };
                }
                if (patchContentBuffer.includes('function_call_end')) {
                    const identity = extractIdentityFromJsonlBlock(patchContentBuffer);
                    const rawLine = firstDetectionLine;
                    reset();
                    if (identity === null) {
                        return { detected: false, identity: null, rawLine: '', accumulating: false };
                    }
                    return { detected: true, identity, rawLine, accumulating: false };
                }
                // Still accumulating — need more patches
                return { detected: false, identity: null, rawLine: '', accumulating: true };
            }
            // Patch line with no extractable text content (metadata-only patch) —
            // don't abort accumulation, continue waiting for content patches
            if (isNotionPatchLine(trimmedLine)) {
                return { detected: false, identity: null, rawLine: '', accumulating: true };
            }
            // Heartbeats and other telemetry can interleave with Notion patch content.
            // Keep waiting for function_call_end instead of executing partial arguments.
            return { detected: false, identity: null, rawLine: '', accumulating: true };
        }

        const patchText = extractPatchTextContent(trimmedLine);
        if (patchText !== null && shouldStartPatchAccumulation(patchText)) {
            return startPatchAccumulation(patchText, trimmedLine);
        }

        if (isNotionRecordMapLine(trimmedLine)) {
            return { detected: false, identity: null, rawLine: '', accumulating: false };
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
        if (patchText !== null && patchText.includes('function_call_start')) {
            return startPatchAccumulation(patchText, trimmedLine);
        }

        // If this is a Notion patch line (type: "patch"), keyword matches are from
        // metadata fields (e.g., agent-inference block "name") — not an actual function call.
        // Don't trigger the unknown-format fallback which would produce identity: null.
        if (isNotionPatchLine(trimmedLine)) {
            return { detected: false, identity: null, rawLine: '', accumulating: false };
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
