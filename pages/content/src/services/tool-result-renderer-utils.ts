/**
 * Pure utility functions for ToolResultRenderer.
 *
 * Zero external dependencies — safe for direct Node.js test runner.
 * All DOM-related code stays in tool-result-renderer.ts.
 */

// ── Constants ──

export const MAX_PREVIEW_LENGTH = 500;
export const MAX_RAW_LENGTH = 10_000;

// ── Types ──

/** Input detail from mcp:tool-execution-complete event */
export interface ToolExecutionDetail {
    result?: unknown;
    isFileAttachment?: boolean;
    file?: unknown;
    fileName?: string;
    confirmationText?: string;
    skipAutoInsertCheck?: boolean;

    // Known identity aliases across the browser bridge / local MCP paths.
    callId?: string;
    toolCallId?: string;
    id?: string;
    functionName?: string;
    toolName?: string;
    name?: string;

    // Optional prompt-card path. Prompt cards use the same frame renderer.
    prompt?: string;
    title?: string;
    kind?: 'tool_result' | 'prompt';
}

/** Validated and extracted data ready for rendering */
export interface ToolResultRenderData {
    callId: string;
    functionName: string;
    status: 'success' | 'error';
    resultPreview: string;
    rawResult?: string;
    error?: string;
    timestamp: number;
    kind?: 'tool_result' | 'prompt';
    title?: string;
}

// ── Pure functions ──

/**
 * Safely stringify a tool result for display.
 * Handles string, object, null, undefined, BigInt, circular references.
 */
export function stringifyToolResult(result: unknown): string {
    if (result === null || result === undefined) return '';
    if (typeof result === 'string') return result;
    if (typeof result === 'bigint') return result.toString();
    try {
        return JSON.stringify(result, null, 2);
    } catch {
        // circular reference or other serialization error
        return String(result);
    }
}

/**
 * Truncate text to maxLength, appending '... (truncated)' if exceeded.
 */
export function truncatePreview(text: string, maxLength: number = MAX_PREVIEW_LENGTH): string {
    if (text.length <= maxLength) return text;
    return text.slice(0, maxLength) + '\n... (truncated)';
}

export function extractCallId(detail: ToolExecutionDetail): string {
    return detail.callId
        || detail.toolCallId
        || detail.id
        || `fallback-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export function extractFunctionName(detail: ToolExecutionDetail): string {
    return detail.functionName
        || detail.toolName
        || detail.name
        || 'unknown_tool';
}

/**
 * Extract and validate render data from a tool execution complete detail.
 * Returns null if the detail is invalid.
 */
export function extractRenderData(
    detail: ToolExecutionDetail | null | undefined,
    warnFn?: (msg: string, ctx?: unknown) => void,
): ToolResultRenderData | null {
    if (!detail) {
        warnFn?.('extractRenderData: detail is null/undefined');
        return null;
    }

    const kind = detail.kind || (detail.prompt ? 'prompt' : 'tool_result');
    const callId = extractCallId(detail);
    const functionName = kind === 'prompt'
        ? (detail.title || 'SuperAssistant Bridge prompt')
        : extractFunctionName(detail);

    const hasPrompt = detail.prompt !== undefined && detail.prompt !== null;
    const hasResult = detail.result !== undefined && detail.result !== null;
    const hasConfirmation = !!detail.confirmationText;

    const rawSource = hasPrompt
        ? detail.prompt
        : hasResult
            ? stringifyToolResult(detail.result)
            : undefined;

    const rawResult = rawSource !== undefined ? stringifyToolResult(rawSource) : undefined;
    const resultPreview = rawResult !== undefined
        ? truncatePreview(rawResult, MAX_PREVIEW_LENGTH)
        : (detail.confirmationText || '');

    // mcp:tool-execution-complete is already a completion event.
    // Only mark as error if there's no result, no prompt, and no confirmation.
    const isError = !hasResult && !hasPrompt && !hasConfirmation;

    return {
        callId,
        functionName,
        status: isError ? 'error' : 'success',
        resultPreview,
        rawResult: rawResult !== undefined ? truncatePreview(rawResult, MAX_RAW_LENGTH) : undefined,
        error: isError ? 'No result returned' : undefined,
        timestamp: Date.now(),
        kind,
        title: detail.title,
    };
}
