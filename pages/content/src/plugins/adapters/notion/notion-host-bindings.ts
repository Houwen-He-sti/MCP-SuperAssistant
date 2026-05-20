/**
 * NotionHostBindings — Layer HostBindings for the 4-layer BH architecture.
 *
 * Implements `HostBindings` (mcp-runtime interface) by calling `mcpClient.callTool`
 * and formatting the result via an injected `formatFunctionResult` function.
 *
 * HostBindings success semantics (aligned with ToolCallLoop contract):
 *   success:true  = formattedResponse is safe to insert into Notion AI
 *                   (whether tool succeeded OR errored — Notion AI should see both)
 *   success:false = infrastructure failure — do NOT insert, do NOT attempt recovery
 *
 * See ToolCallLoop.handleToolCall():
 *   if (!result.success) return;  // formattedResponse not inserted when success:false
 *
 * BH-4 TDD: T-BH-15..T-BH-18b
 */

import type {
  ErrorPayload,
  HostBindings,
  ToolCallResult,
} from '../../../../../../../mcp-runtime/src/bridge/host-bindings.ts';
import type { ToolCallPayload } from '../../../../../../../mcp-runtime/src/core/tool-call-parser.ts';
import type { ConnectionStatePort } from '../../../../../../../mcp-runtime/src/core/connection-state-port.ts';
import type { McpClientToolShape } from './notion-tool-shape-adapter.ts';

// ---------------------------------------------------------------------------
// Interface
// ---------------------------------------------------------------------------

export interface NotionMcpClientLike {
  callTool(name: string, args: Record<string, unknown>): Promise<unknown>;
  /**
   * Optional — Slice I: returns available tool descriptors in McpClient native shape (snake_case).
   * Caller (notion-runtime-bridge.ts) must run normalizeToolDescriptors() before populate().
   * If absent, registry wiring is skipped (warn logged, loop started without toolRegistry).
   */
  getAvailableTools?: () => Promise<McpClientToolShape[]>;
}

export interface NotionHostBindingsDeps {
  mcpClient: NotionMcpClientLike;
  formatFunctionResult: (opts: {
    callId: string;
    name: string;
    status: 'success' | 'error';
    result: unknown;
  }) => string;
  logger?: Pick<Console, 'error' | 'warn'>;
  /**
   * Optional — Slice N/O migration seam.
   * When present, isConnected() is the authoritative transport gate.
   * When absent, no HostBindings-level connection guard is applied;
   * callTool() is invoked and may fail internally.
   */
  connectionState?: ConnectionStatePort;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createNotionHostBindings(deps: NotionHostBindingsDeps): HostBindings {
  return {
    async onToolCallDetect(payload: ToolCallPayload): Promise<ToolCallResult> {
      // D6 guard: connectionState present → authoritative transport gate (MCP_NOT_CONNECTED).
      // If absent, HostBindings does not perform a connection pre-check;
      // callTool() is invoked and any failure is returned as a tool execution error.
      //
      // Note: isConnected() is NOT an authorization check. It only gates on transport connectivity.
      // Tool allowlist / schema validation remain separate concerns (SchemaValidatorPort, ToolRegistry).
      if (deps.connectionState) {
        if (!deps.connectionState.isConnected()) {
          deps.logger?.warn?.('[NotionHostBindings] MCP not connected');
          return {
            callId: payload.callId,
            formattedResponse: '',
            success: false,
            error: 'MCP_NOT_CONNECTED',
          };
        }
      }

      try {
        const result = await deps.mcpClient.callTool(payload.name, payload.arguments ?? {});
        return {
          callId: payload.callId,
          formattedResponse: deps.formatFunctionResult({
            callId: payload.callId,
            name: payload.name,
            status: 'success',
            result,
          }),
          success: true,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        // Tool execution error: still insert error result into Notion AI
        // so it can see the failure and adjust reasoning.
        // success:true = "formattedResponse is safe to insert"
        return {
          callId: payload.callId,
          formattedResponse: deps.formatFunctionResult({
            callId: payload.callId,
            name: payload.name,
            status: 'error',
            result: message,
          }),
          success: true,
          error: message,
        };
      }
    },

    onAdapterError(error: ErrorPayload): void {
      // Log only — BH-4 does not attempt recovery from adapter errors
      deps.logger?.error?.('[NotionHostBindings] Adapter error:', error.code, error.message);
    },
  };
}
