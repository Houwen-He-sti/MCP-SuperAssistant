/**
 * notion-rejection-handler.ts — Slice L
 *
 * Implements ToolCallRejectionHandler for the Notion BH path.
 * Converts pre-flight tool call rejections (tool_not_found, args_invalid) into
 * formatted error ToolResults so Notion AI (LLM) can self-correct instead of hanging.
 *
 * Design principles:
 *   - Pure: only depends on formatFunctionResult (no DOM, no insertText)
 *   - Fail-closed: formatter throw or empty output → success:false (no unhandled rejection)
 *   - Transparent: passes validationMessage + validationDetails for LLM self-correction
 *
 * Slice L scope: unit + integration wiring in notion-runtime-bridge.ts
 */

import type { ToolCallResult } from '../../../../../../../mcp-runtime/src/bridge/host-bindings.ts';
import type {
  ToolCallRejectionHandler,
  ToolCallRejectReason,
} from '../../../../../../../mcp-runtime/src/core/tool-call-loop.ts';
import type { ToolCallPayload } from '../../../../../../../mcp-runtime/src/core/tool-call-parser.ts';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Minimal formatFunctionResult contract (matches NotionRuntimeBridgeDeps). */
export type FormatFunctionResult = (opts: {
  callId: string;
  name: string;
  status: 'success' | 'error';
  result: unknown;
}) => string;

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * Formats pre-flight tool call rejections as error ToolResults for Notion AI.
 *
 * Used by ToolCallLoop when validateArgs() rejects a tool call before execution.
 * Without this handler, the LLM would hang waiting for a ToolResult it never receives.
 */
export class NotionRejectionHandler implements ToolCallRejectionHandler {
  private readonly formatFunctionResult: FormatFunctionResult;

  constructor(formatFunctionResult: FormatFunctionResult) {
    this.formatFunctionResult = formatFunctionResult;
  }

  async onToolCallReject(payload: ToolCallPayload, reason: ToolCallRejectReason): Promise<ToolCallResult> {
    try {
      // Build result payload that distinguishes reject reasons for LLM self-correction
      const resultPayload = this.buildResultPayload(reason);

      const formattedResponse = this.formatFunctionResult({
        callId: payload.callId,
        name: payload.name,
        status: 'error',
        result: resultPayload,
      });

      // Fail-closed: empty formattedResponse cannot guide LLM self-correction
      if (!formattedResponse) {
        return { callId: payload.callId, formattedResponse: '', success: false };
      }

      return { callId: payload.callId, formattedResponse, success: true };
    } catch (error) {
      // Formatter threw — fail-closed, do not propagate to window.onerror
      return {
        callId: payload.callId,
        formattedResponse: '',
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private buildResultPayload(reason: ToolCallRejectReason): unknown {
    if (reason.code === 'tool_not_found') {
      return {
        code: 'tool_not_found',
        toolName: reason.toolName,
        message: `Tool '${reason.toolName}' not found in registry`,
      };
    }

    // args_invalid — include validation details for LLM self-correction
    return {
      code: 'args_invalid',
      toolName: reason.toolName,
      validationCode: reason.validationCode,
      validationMessage: reason.validationMessage,
      validationDetails: reason.validationDetails,
    };
  }
}
